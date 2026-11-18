import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createClient } from '@libsql/client';
import { createMigratedDatabase } from '../support/migrated-db.mjs';
import { admitExecution, finishExecution, readExecutionQueueHealth, ExecutionBusyError, EXECUTION_OFFER_SECONDS } from '../../api/_execution-queue.js';
const ENV={EXECUTION_QUEUE_ENABLED:'true',JWT_SECRET:'execution-load-fixture-only-secret'.repeat(2),
  EXECUTION_GLOBAL_PER_MINUTE:'240',EXECUTION_GLOBAL_PER_DAY:'10000',EXECUTION_CIRCLE_PER_MINUTE:'120'};
const request=(userId,circleId=1,interview=false)=>({userId,circleId,interview,operation:`run:${userId}`});
function timed(raw,clock,network=null){
  const rewrite=statement=>{const transform=sql=>sql.replaceAll("CAST(strftime('%s','now') AS INTEGER)",String(clock.seconds))
    .replaceAll("CAST(ROUND((julianday('now')-2440587.5)*86400000) AS INTEGER)",String(clock.seconds*1000));
    return typeof statement==='string'?transform(statement):{...statement,sql:transform(statement.sql)};};
  const guard=(promise,stage)=>Promise.resolve(promise).catch(error=>{if(network?.errors)network.errors.push([stage,error.code]);throw error;});
  const wrap=target=>({execute:s=>{if(network)network.calls++;return guard(target.execute(rewrite(s)),'execute');},batch:list=>{if(network)network.calls++;return guard(target.batch(list.map(rewrite)),'batch');},
    commit:()=>{if(network)network.calls++;return guard(target.commit(),'commit');},rollback:()=>target.rollback(),close:()=>target.close(),get closed(){return target.closed;}});
  return{protocol:raw.protocol,execute:s=>guard(raw.execute(rewrite(s)),'outside'),transaction:async mode=>{if(network)network.calls++;return wrap(await guard(raw.transaction(mode),'begin'));}};
}
async function fixture(t){const file=await createMigratedDatabase({prefix:'randori-468-r2-load-'}),raw=createClient({url:file.url});
  t.after(()=>{raw.close();file.cleanup();});
  // WAL is the load model: independent committed reader connections must not
  // block writers. Rollback-journal COMMIT conflicts remain fail-closed; no
  // runtime code changes a deployment's journal mode.
  await raw.execute('PRAGMA journal_mode=WAL');
  await raw.execute("INSERT INTO circles(id,public_id,slug,name,is_primary) VALUES(1,'load','load','Load',1)");
  const clock={seconds:Math.floor(Date.now()/86400000)*86400+3600},db=timed(raw,clock);return{raw,db,clock,file};}
async function call(db,ctx,env=ENV){let jitter=0;try{return{lease:await admitExecution(db,ctx,{env,random:()=>((ctx.userId*17+jitter++*7)%20)/20})};}catch(error){assert.ok(error instanceof ExecutionBusyError);return{error};}}
async function holdAll(db){const held=[];for(let n=1;n<=4;n++)held.push(await admitExecution(db,request(n,Math.ceil(n/2)),{env:ENV}));return held;}
async function free(db,held){for(const lease of held)await finishExecution(db,lease,{safeToRelease:true});}

test('8 abandoned FIFO heads cannot stall an idle provider beyond one short offer window',async t=>{
  const {db,raw,clock}=await fixture(t),held=await holdAll(db);clock.seconds++;
  for(let n=10;n<18;n++)assert.equal((await call(db,request(n,1))).error.reason,'queued');
  await free(db,held);clock.seconds++;
  const pending=Array.from({length:4},(_,n)=>request(100+n,2)),served=[];let idle=0;
  for(let tick=0;tick<=EXECUTION_OFFER_SECONDS+1&&pending.length;tick++,clock.seconds++){
    const active=[];
    for(const ctx of [...pending]){const result=await call(db,ctx);if(result.lease){active.push(result.lease);served.push(ctx);pending.splice(pending.indexOf(ctx),1);}}
    if(!active.length&&pending.length)idle++;
    await free(db,active);
  }
  assert.equal(served.length,4);assert.equal(pending.length,0);assert.ok(idle<=EXECUTION_OFFER_SECONDS);
  const health=await readExecutionQueueHealth(raw,{env:ENV});assert.equal(health.recent.store,0);
  t.diagnostic(JSON.stringify({scenario:'abandoned-heads',liveServed:served.length,liveTotal:4,idleTicks:idle,bound:EXECUTION_OFFER_SECONDS}));
});

test('6 unattended interview heads advance selection turns; practice is served in 30/30 attempts',async t=>{
  const {db,raw,clock}=await fixture(t),held=await holdAll(db);clock.seconds++;
  for(let n=10;n<16;n++)assert.equal((await call(db,request(n,1,true))).error.reason,'queued');
  await free(db,held);let served=0;
  for(let tick=0;tick<30;tick++,clock.seconds++){
    const result=await call(db,request(100+tick,2,false));
    if(result.lease){served++;await free(db,[result.lease]);}
  }
  const sequence=Number((await raw.execute("SELECT attempts FROM auth_rate_limits WHERE key='eq1:s'")).rows[0].attempts);
  assert.equal(served,30);assert.ok(sequence>34,'abandoned selections advanced the rotation in addition to claims');
  t.diagnostic(JSON.stringify({scenario:'interview-abandonment',practiceServed:served,attempts:30,selectionSequence:sequence}));
});

test('8 arrivals/s congestion fills the provider near capacity with no idle-with-waiters ticks',async t=>{
  const {db,clock}=await fixture(t);let serial=100,served=0,shed=0,idle=0,peak=0;const waiting=[],running=[];
  for(let tick=0;tick<60;tick++,clock.seconds++){
    for(const active of [...running])if(active.until<=clock.seconds){await free(db,[active.lease]);running.splice(running.indexOf(active),1);}
    for(let n=0;n<8;n++){const id=serial++;waiting.push(request(id,id%8+1,id%3!==2));}
    for(const ctx of [...waiting]){
      const result=await call(db,ctx);
      if(result.lease){served++;running.push({lease:result.lease,until:clock.seconds+3});waiting.splice(waiting.indexOf(ctx),1);}
      else if(result.error.reason!=='queued'){assert.ok(['queue_full','queue_expired'].includes(result.error.reason),result.error.reason);shed++;waiting.splice(waiting.indexOf(ctx),1);}
    }
    peak=Math.max(peak,running.length);assert.ok(running.length<=4);
    if(waiting.length&&!running.length)idle++;
  }
  await free(db,running.map(item=>item.lease));
  const capacity=4*Math.ceil(60/3);assert.ok(served>=capacity*0.95,`${served}/${capacity}`);assert.equal(idle,0);assert.equal(peak,4);
  t.diagnostic(JSON.stringify({scenario:'congestion',arrivals:480,served,shed,capacity,capacityFraction:served/capacity,idleWithWaitersTicks:idle,peak}));
});

for(const concurrency of [2,16])test(`${concurrency} real concurrent SQLite callers retry lock contention instead of rejecting store`,async t=>{
  const {raw,clock,file}=await fixture(t),clients=Array.from({length:concurrency},()=>createClient({url:file.url}));t.after(()=>clients.forEach(c=>c.close()));
  const env={...ENV,EXECUTION_GLOBAL_CONCURRENCY:'16',EXECUTION_CIRCLE_CONCURRENCY:'8',EXECUTION_INTERVIEW_SHARE:'8'};
  let served=0,store=0;const network={calls:0,errors:[]};
  for(let wave=0;wave<20;wave++,clock.seconds+=60){
    const jobs=clients.map((client,n)=>({db:timed(client,clock,network),ctx:request(100+n,n%2+1)}));
    for(let round=0;round<4&&jobs.length;round++){
      const results=await Promise.all(jobs.map(async job=>({...job,result:await call(job.db,job.ctx,env)})));
      for(const job of results){if(job.result.lease){served++;await free(job.db,[job.result.lease]);jobs.splice(jobs.findIndex(item=>item.ctx===job.ctx),1);}
        else{jobs.find(item=>item.ctx===job.ctx).last=job.result.error.reason;if(job.result.error.reason==='store')store++;assert.ok(['queued','store'].includes(job.result.error.reason));}}
    }
    assert.equal(jobs.length,0,JSON.stringify({wave,errors:network.errors,remaining:jobs.map(item=>({actor:item.ctx.userId,reason:item.last})),health:await readExecutionQueueHealth(timed(raw,clock),{env})}));
  }
  assert.equal(store,0);assert.equal(served,concurrency*20);
  t.diagnostic(JSON.stringify({scenario:'sqlite-contention',concurrency,served,total:concurrency*20,storeRefusals:store}));
});

test('one admission uses <=5 interactive write-lock RTTs with native libSQL batches, never a metric insert',async t=>{
  const {raw,clock}=await fixture(t),network={calls:0};const db=timed(raw,clock,network);
  const lease=await admitExecution(db,request(100),{env:ENV});assert.ok(lease);assert.ok(network.calls<=5,`lock RTTs=${network.calls}`);
  await free(db,[lease]);t.diagnostic(JSON.stringify({scenario:'write-lock-round-trips',roundTrips:network.calls-0}));
});
