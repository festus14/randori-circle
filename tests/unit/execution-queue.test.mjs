import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createClient } from '@libsql/client';
import { createMigratedDatabase } from '../support/migrated-db.mjs';
import { EXECUTABLE_MIGRATIONS } from '../../db/executable-migrations.js';
import { admitExecution, checkExecutionLease, executionQueueConfiguration, executionQueueEnabled,
  ExecutionBusyError, finishExecution, readExecutionQueueHealth, selectExecutionTicket, sendExecutionBusy } from '../../api/_execution-queue.js';
import { executePracticePrograms, executeProgram } from '../../api/_execution.js';

const ENV = { EXECUTION_QUEUE_ENABLED: 'true', JWT_SECRET: 'test-execution-secret-not-production'.repeat(2), EXECUTION_PROVIDER: 'vercel-sandbox' };
const context = (userId, circleId=1, interview=false, operation='same') => ({userId,circleId,interview,operation});
async function fixture(t) {
  const file=await createMigratedDatabase({prefix:'randori-exec-quotas-'});
  const db=createClient({url:file.url});
  t.after(()=>{db.close();file.cleanup();});
  const ledger=await db.execute('SELECT MAX(version) AS version FROM schema_migrations');
  // The queue adds no migration of its own (ID-103): it must run on the repository's
  // unmodified latest schema, whatever that version is.
  assert.equal(Number(ledger.rows[0].version),EXECUTABLE_MIGRATIONS.at(-1).version,'runs on the unmodified latest schema');
  return {db,file};
}
const rejectsBusy=(promise,reason)=>assert.rejects(promise,e=>e instanceof ExecutionBusyError&&(!reason||e.reason===reason));

// Tests adjust only their isolated TTL rows, not wall-clock timers or production.
async function expire(db,kind) {await db.execute(`UPDATE auth_rate_limits SET expires_at=0 WHERE key GLOB 'eq1:${kind}:*'`);}

for(const flag of [undefined,false,true,'false','TRUE','1',' true ']) {
  test(`queue flag ${String(flag)} preserves no-I/O legacy path`,async()=>{
    const env={EXECUTION_QUEUE_ENABLED:flag,EXECUTION_GLOBAL_CONCURRENCY:'bad'};
    const db=new Proxy({}, {get(){throw new Error('must not touch DB');}});
    assert.equal(executionQueueEnabled(env),false);
    assert.equal(await admitExecution(db,null,{env}),null);
    assert.deepEqual(await readExecutionQueueHealth(db,{env}),{enabled:false});
  });
}

test('safe defaults and strict integral/cross-field configuration fail closed',()=>{
  const config=executionQueueConfiguration(ENV);
  assert.equal(config.GLOBAL_CONCURRENCY,4);assert.equal(config.CIRCLE_CONCURRENCY,2);assert.equal(config.GLOBAL_PER_DAY,150);
  for(const [key,value] of [
    ['JWT_SECRET','short'],['EXECUTION_GLOBAL_CONCURRENCY','0'],['EXECUTION_GLOBAL_CONCURRENCY','17'],
    ['EXECUTION_CIRCLE_CONCURRENCY','5'],['EXECUTION_INTERVIEW_SHARE','4'],['EXECUTION_QUEUE_LIMIT','129'],
    ['EXECUTION_MAX_WAIT_SECONDS','21'],['EXECUTION_ACCOUNT_PER_MINUTE','1.0'],
    ['EXECUTION_GLOBAL_PER_DAY',' 150'],['EXECUTION_GLOBAL_PER_MINUTE',2],
  ]) assert.throws(()=>executionQueueConfiguration({...ENV,[key]:value}),ExecutionBusyError,`${key}=${value}`);
});

test('pure scheduler is round-robin by circle, FIFO within a class and I,I,P bounded priority',()=>{
  const cfg=executionQueueConfiguration(ENV), tickets=[],turns={};
  for(const [circle,priority,count] of [['A','i',6],['B','i',6],['C','p',6],['D','p',6]])
    for(let n=0;n<count;n++)tickets.push({key:`${circle}${n}`,circle,account:`${circle}${n}`,priority,units:1,arrival:n+1});
  const order=[];
  for(let seq=0;seq<12;seq++){
    const winner=selectExecutionTicket(tickets,[],turns,seq,cfg);
    order.push(winner.key);turns[winner.circle]=seq+1;tickets.splice(tickets.indexOf(winner),1);
  }
  assert.deepEqual(order,['A0','B0','C0','A1','B1','D0','A2','B2','C1','A3','B3','D1']);
});

test('interviews reserve their share; practice has non-starving capacity, shares borrow only when idle',()=>{
  const cfg=executionQueueConfiguration(ENV);
  const p={key:'p',account:'p',circle:'P',priority:'p',units:1,arrival:1};
  const i={key:'i',account:'i',circle:'I',priority:'i',units:1,arrival:2};
  const leases=Array.from({length:3},(_,n)=>({circle:String(n),account:String(n),priority:'i',units:1}));
  assert.equal(selectExecutionTicket([p,i],leases,{},0,cfg).key,'p');
  const practiceLeases=leases.slice(0,2).map(l=>({...l,priority:'p'}));
  assert.equal(selectExecutionTicket([p,i],practiceLeases,{},2,cfg).key,'i');
  assert.equal(selectExecutionTicket([p],practiceLeases,{},0,cfg).key,'p');
  const privatePractice={...p,units:2};
  assert.equal(selectExecutionTicket([privatePractice,i],leases,{},0,cfg),null,'drain interview usage to leave two private units');
  assert.equal(selectExecutionTicket([privatePractice,i],leases.slice(0,2),{},2,cfg).key,'p');
  assert.equal(selectExecutionTicket([p],Array.from({length:4},(_,n)=>({...p,account:String(n),circle:String(n)})),{},0,cfg),null);
});

test('real SQLite atomically enforces circle/global ceilings and one active account across circles',async t=>{
  const {db}=await fixture(t);
  const a=await admitExecution(db,context(1),{env:ENV});
  const b=await admitExecution(db,context(2),{env:ENV});
  await rejectsBusy(admitExecution(db,context(3),{env:ENV}),'queued');
  await rejectsBusy(admitExecution(db,context(1,2),{env:ENV}),'already_running');
  const c=await admitExecution(db,context(4,2),{env:ENV});
  const d=await admitExecution(db,context(5,3),{env:ENV});
  await rejectsBusy(admitExecution(db,context(6,4),{env:ENV}),'queued');
  const health=await readExecutionQueueHealth(db,{env:ENV});
  assert.equal(health.activeUnits,4);assert.equal(health.queueDepth,2);assert.equal(health.recent.admitted,4);
  assert.equal(health.spend.usedMinuteUnits,4);assert.equal(health.spend.usedDayUnits,4);
  await finishExecution(db,a,{safeToRelease:true,providerMs:12});
  await finishExecution(db,b,{safeToRelease:true});
  // Both eligible callers are in the ordered fill set: the first retry must
  // not sit idle behind the other caller's reserved three-second offer.
  const e=await admitExecution(db,context(3),{env:ENV});
  const f=await admitExecution(db,context(6,4),{env:ENV});
  for(const lease of [c,d,e,f])await finishExecution(db,lease,{safeToRelease:true});
  assert.equal((await readExecutionQueueHealth(db,{env:ENV})).activeUnits,0);
});

test('bounded queue deduplicates retries, fences changed operations/tabs, sheds full and expired tickets',async t=>{
  const {db}=await fixture(t),env={...ENV,EXECUTION_QUEUE_LIMIT:'1'};
  await admitExecution(db,context(1),{env});await admitExecution(db,context(2),{env});
  for(let n=0;n<3;n++)await rejectsBusy(admitExecution(db,context(3),{env}),'queued');
  assert.equal((await readExecutionQueueHealth(db,{env})).queueDepth,1);
  await rejectsBusy(admitExecution(db,context(3,1,false,'changed'),{env}),'pending_run');
  await rejectsBusy(admitExecution(db,context(4),{env}),'queue_full');
  await expire(db,'q');
  await rejectsBusy(admitExecution(db,context(3),{env}),'queue_expired');
  const health=await readExecutionQueueHealth(db,{env});
  assert.equal(health.queueDepth,0);assert.equal(health.recent.shed,2);
});

test('crash, uncertain cleanup and expiry cannot release another generation or overspend',async t=>{
  const {db}=await fixture(t), a=await admitExecution(db,context(1),{env:ENV});
  await checkExecutionLease(db,a);
  await finishExecution(db,a,{safeToRelease:false});
  await rejectsBusy(admitExecution(db,context(1),{env:ENV}),'already_running');
  await expire(db,'l');
  await rejectsBusy(checkExecutionLease(db,a),'lease_expired');
  const b=await admitExecution(db,context(1),{env:ENV});
  assert.notEqual(a.key,b.key);
  await finishExecution(db,a,{safeToRelease:true});
  assert.equal((await readExecutionQueueHealth(db,{env:ENV})).activeUnits,1);
});

for(const [knob,label] of [['EXECUTION_ACCOUNT_PER_MINUTE','account'],['EXECUTION_CIRCLE_PER_MINUTE','circle'],['EXECUTION_GLOBAL_PER_MINUTE','global-minute'],['EXECUTION_GLOBAL_PER_DAY','global-day']]){
  test(`${label} quota is atomic, provider-unit counted, has bounded retry, and resets at expiry`,async t=>{
    const {db}=await fixture(t),env={...ENV,[knob]:'1'};
    const a=await admitExecution(db,context(1),{env});await finishExecution(db,a,{safeToRelease:true});
    const next=label==='account'?context(1):label==='circle'?context(2):context(2,2);
    await assert.rejects(admitExecution(db,next,{env}),e=>e.code==='execution_busy'&&e.reason==='quota'&&e.status===429&&e.retryAfter>=1);
    assert.equal((await readExecutionQueueHealth(db,{env})).recent.quota,1);
  });
}

test('configuration mismatch cannot switch limits or keyed identity under active work',async t=>{
  const {db}=await fixture(t), a=await admitExecution(db,context(1),{env:ENV});
  for(const env of [{...ENV,EXECUTION_GLOBAL_CONCURRENCY:'5'},{...ENV,JWT_SECRET:'changed-secret'.repeat(4)}])
    await rejectsBusy(admitExecution(db,context(2,2),{env}),'configuration_changed');
  await finishExecution(db,a,{safeToRelease:true});
  await admitExecution(db,context(2,2),{env:{...ENV,EXECUTION_GLOBAL_CONCURRENCY:'5'}});
});

function clockedDatabase(raw, clock) {
  const rewrite = statement => {
    const transform = sql => sql.replaceAll("CAST(strftime('%s','now') AS INTEGER)", String(clock.seconds))
      .replaceAll("CAST(ROUND((julianday('now')-2440587.5)*86400000) AS INTEGER)", String(clock.seconds * 1000));
    return typeof statement === 'string' ? transform(statement) : { ...statement, sql: transform(statement.sql) };
  };
  const wrap = target => ({ execute: statement => target.execute(rewrite(statement)),
    commit: () => target.commit(), rollback: () => target.rollback(), close: () => target.close?.() });
  return { execute: statement => raw.execute(rewrite(statement)), transaction: async mode => wrap(await raw.transaction(mode)) };
}

test('UTC minute/day quota windows reset in real SQLite on the database clock without sleeping', async t => {
  const {db:raw}=await fixture(t);
  const now=Number((await raw.execute("SELECT CAST(strftime('%s','now') AS INTEGER) AS now")).rows[0].now);
  const clock={seconds:Math.floor(now/86400)*86400+1},db=clockedDatabase(raw,clock);
  const env={...ENV,EXECUTION_ACCOUNT_PER_MINUTE:'1',EXECUTION_GLOBAL_PER_DAY:'2'};
  const first=await admitExecution(db,context(1),{env});await finishExecution(db,first,{safeToRelease:true});
  await rejectsBusy(admitExecution(db,context(1),{env}),'quota');
  clock.seconds+=60;
  const second=await admitExecution(db,context(1),{env});await finishExecution(db,second,{safeToRelease:true});
  await rejectsBusy(admitExecution(db,context(2,2),{env}),'quota');
  clock.seconds+=86400;
  const third=await admitExecution(db,context(1),{env});assert.ok(third.key);
});

test('finite interview/practice burst makes round-robin progress across circles with bounded waits', async t => {
  const {db:raw}=await fixture(t),now=Number((await raw.execute("SELECT CAST(strftime('%s','now') AS INTEGER) AS now")).rows[0].now);
  const clock={seconds:now},db=clockedDatabase(raw,clock),initial=[];
  for(let user=1;user<=4;user++)initial.push(await admitExecution(db,context(user,Math.ceil(user/2)),{env:ENV}));
  const pending=Array.from({length:12},(_,n)=>context(n+10,n%4+3,n%3!==2));
  for(const request of pending)await rejectsBusy(admitExecution(db,request,{env:ENV}),'queued');
  for(const lease of initial)await finishExecution(db,lease,{safeToRelease:true});
  const order=[];
  for(let round=0;round<12&&pending.length;round++){
    for(const request of [...pending]){
      try{
        const lease=await admitExecution(db,request,{env:ENV});order.push(request);pending.splice(pending.indexOf(request),1);
        await finishExecution(db,lease,{safeToRelease:true});
      }catch(error){assert.equal(error.reason,'queued');}
    }
    clock.seconds++;
  }
  assert.equal(pending.length,0);assert.ok(clock.seconds-now<15);
  assert.ok(order.some(item=>item.interview===false));assert.equal(new Set(order.map(item=>item.circleId)).size,4);
  const health=await readExecutionQueueHealth(raw,{env:ENV});assert.equal(health.recent.shed,0);assert.equal(health.recent.admitted,16);
});

test('store and ambiguous commit fail closed, never replay an admission or provider request',async t=>{
  const {db}=await fixture(t);let calls=0;
  const failing={transaction:async()=>{const tx=await db.transaction('write');return{execute:s=>tx.execute(s),rollback:()=>tx.rollback(),close:()=>tx.close(),commit:async()=>{await tx.commit();throw new Error('lost acknowledgement');}};}};
  await rejectsBusy(executeProgram({language:'javascript',source:'SECRET_SOURCE'}, {env:ENV,db:failing,executionContext:context(1),loadSandboxSdk:async()=>{calls++;return{};}}),'store');
  assert.equal(calls,0);assert.equal((await readExecutionQueueHealth(db,{env:ENV})).activeUnits,1);
  await rejectsBusy(admitExecution({transaction:async()=>{throw new Error('down');}},context(2),{env:ENV}));
});

test('real concurrent SQLite clients simulate bursts without exceeding spend/account/circle ceilings',async t=>{
  const {db,file}=await fixture(t);const clients=Array.from({length:4},()=>createClient({url:file.url}));
  t.after(()=>clients.forEach(client=>client.close()));
  const outcomes=await Promise.all(clients.map(async(client,index)=>{
    const list=[];
    for(let n=0;n<8;n++){
      try{list.push(await admitExecution(client,context(index*8+n+1,index+1,n%3!==0),{env:ENV}));}
      catch(e){assert.ok(e instanceof ExecutionBusyError);list.push(e);}
    }
    return list;
  }));
  const admitted=outcomes.flat().filter(value=>!(value instanceof Error));
  assert.ok(admitted.length>0&&admitted.length<=4);
  const health=await readExecutionQueueHealth(db,{env:ENV});
  assert.equal(health.activeUnits,admitted.length);assert.ok(health.queueDepth<=32);
  const leases=(await db.execute("SELECT key FROM auth_rate_limits WHERE key GLOB 'eq1:l:*'")).rows;
  const circles=new Map();
  for(const row of leases){const circle=row.key.split(':')[2];circles.set(circle,(circles.get(circle)||0)+1);}
  assert.ok([...circles.values()].every(n=>n<=2));
});

test('combined stdin reserves two actual provider units and waits for both cleanups',async t=>{
  const {db}=await fixture(t);let stop,started=0;
  const gate=new Promise(resolve=>{stop=resolve;});
  const env={...ENV,EXECUTION_STDIN_ENABLED:'true'};
  const loadSandboxSdk=async()=>({Sandbox:{create:async()=>({writeFiles:async()=>{},runCommand:async p=>{started++;p.stdout.write('ok');return{exitCode:0};},delete:async()=>gate})}});
  const pending=executePracticePrograms({language:'javascript',harness:'VERIFIED',code:'SOURCE',stdin:'PRIVATE'}, {env,db,executionContext:context(1),loadSandboxSdk});
  // Provider-free synchronization, no sleeps or provider polling.
  while(started<2)await new Promise(resolve=>setImmediate(resolve));
  const health=await readExecutionQueueHealth(db,{env});assert.equal(health.activeUnits,2);
  await rejectsBusy(executeProgram({language:'javascript',source:'OTHER'}, {env,db,executionContext:context(2),loadSandboxSdk}),'queued');
  stop();const result=await pending;assert.equal(result.custom.stdout,'ok');
  assert.equal((await readExecutionQueueHealth(db,{env})).activeUnits,0);
  const logs=(await db.execute("SELECT * FROM app_logs WHERE event='execution_queue_metric'")).rows;
  assert.doesNotMatch(JSON.stringify(logs),/PRIVATE|SOURCE|VERIFIED/);
  assert.ok(logs.every(row=>row.user_id===null&&row.route===null&&row.ua===null&&row.ip===null));
});

test('queue-enabled Piston has server kill deadlines, reports timeouts and only releases a terminal receipt',async t=>{
  const {db}=await fixture(t),env={...ENV,EXECUTION_PROVIDER:'piston',EXECUTION_API_URL:'https://provider.invalid/execute'};
  const result=await executeProgram({language:'python',source:'while True: pass'},{env,db,executionContext:context(1),
    fetchImpl:async(_url,options)=>{const body=JSON.parse(options.body);assert.equal(body.compile_timeout,1000);assert.equal(body.run_timeout,10000);
      return new Response(JSON.stringify({run:{code:null,signal:'SIGKILL',status:'TO',stdout:''}}));}});
  assert.equal(result.timedOut,true);assert.equal((await readExecutionQueueHealth(db,{env})).activeUnits,0);
});

test('busy responses and health are allowlisted, no-store, PII/code-free and never wrong-answer results',async t=>{
  const {db}=await fixture(t);await admitExecution(db,context(987654321,123456789,false,'PRIVATE_CODE_STDIN'),{env:ENV});
  const headers={},res={setHeader:(k,v)=>{headers[k]=v;},status(status){this.statusCode=status;return this;},json(body){this.body=body;return this;}};
  sendExecutionBusy(res,new ExecutionBusyError('queue_full',2));
  assert.equal(res.statusCode,503);assert.equal(headers['Retry-After'],'2');assert.equal(headers['Cache-Control'],'no-store');
  assert.equal(res.body.retry_after,2);assert.equal(Object.hasOwn(res.body,'results'),false);
  const health=await readExecutionQueueHealth(db,{env:ENV});
  assert.equal(health.waitMs.samples,1);assert.ok(health.waitMs.p50>=0);
  assert.equal(health.providerMs.p95,null);assert.equal(health.spend.globalPerDay,150);
  const keys=(await db.execute("SELECT key FROM auth_rate_limits WHERE key GLOB 'eq1:*'")).rows;
  assert.doesNotMatch(JSON.stringify({keys,health}),/PRIVATE|987654321|123456789|JWT_SECRET|secret|email|stdin/);
});
