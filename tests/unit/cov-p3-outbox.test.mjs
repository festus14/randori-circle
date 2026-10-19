// P3 coverage: outbox lease, retry, deadline, and validation edges that the
// broader outbox.test.mjs scenarios do not reach. Real SQLite is used wherever
// the behaviour depends on the guarded UPDATE predicates; a scripted client is
// used only to force storage failures at an exact statement.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, test } from 'node:test';

import { createClient } from '@libsql/client';

import {
  claimOutboxEvent,
  createOutboxEventStatement,
  deliverOutboxEventsNow,
  enqueueOutboxEvent,
  heartbeatOutboxLease,
  OutboxDeliveryError,
  readOutboxMetrics,
  replayDeadLetter,
  runOutboxInvocation,
  runOutboxWorker,
  settleBeforeDeadline,
} from '../../api/_outbox.js';
import {
  applyMigrations,
  inspectMigrationState,
  prepareMigrationConnection,
} from '../../db/migration-runner.js';

const cleanup=[];
const START='2020-09-20T08:00:00.000Z';
const TYPE='test.notification';
const OTHER='other.notification';

afterEach(async()=>{
  while(cleanup.length){
    try{ await cleanup.pop()(); }catch{}
  }
});

async function fixture(){
  const directory=mkdtempSync(join(tmpdir(),'randori-cov-outbox-'));
  const db=createClient({url:`file:${join(directory,'outbox.sqlite')}`});
  await prepareMigrationConnection(db);
  const initial=await inspectMigrationState(db);
  await applyMigrations(db,{
    expectedStateFingerprint:initial.stateFingerprint,
    retry:{maxAttempts:1,baseDelayMs:0,maxDelayMs:0},
  });
  cleanup.push(async()=>{ db.close(); rmSync(directory,{recursive:true,force:true}); });
  return db;
}

function event(sequence=1,overrides={}){
  return {
    eventType:TYPE,eventVersion:1,idempotencyKey:`test/v1/${sequence}`,
    payload:{sequence},notBefore:START,maxAttempts:5,deliveryTimeoutMs:30_000,...overrides,
  };
}

async function row(db,key){
  return (await db.execute({sql:'SELECT * FROM outbox_events WHERE idempotency_key=?',args:[key]})).rows[0];
}

function deferred(){
  let resolve;
  let reject;
  const promise=new Promise((yes,no)=>{ resolve=yes; reject=no; });
  return {promise,resolve,reject};
}

function controlledClock(startMs=0){
  let nowMs=startMs;
  let nextId=1;
  const timers=new Map();
  const clock=Object.freeze({
    now:()=>nowMs,
    setTimeout(callback,delayMs){
      const handle={id:nextId,unref(){}};
      nextId+=1;
      timers.set(handle,{handle,callback,at:nowMs+Math.max(0,Number(delayMs)||0)});
      return handle;
    },
    clearTimeout(handle){ timers.delete(handle); },
  });
  return {
    clock,
    set(value){ nowMs=value; },
    runNext(){
      const next=[...timers.values()].sort((left,right)=>left.at-right.at||left.handle.id-right.handle.id)[0];
      if(!next) throw new Error('controlled clock has no pending timer');
      nowMs=next.at;
      timers.delete(next.handle);
      next.callback();
    },
  };
}

function sqlText(statement){
  return typeof statement==='string'?statement:String(statement?.sql||'');
}

// Real-database client with per-statement hooks and an idle barrier, so a test
// can stall or fail one exact operation and then wait for detached work.
function hooked(db){
  const hooks={batch:null,execute:null,transaction:null};
  const inflight=new Set();
  const track=promise=>{
    inflight.add(promise);
    promise.then(()=>inflight.delete(promise),()=>inflight.delete(promise));
    return promise;
  };
  return {
    hooks,
    async idle(){
      while(inflight.size) await Promise.allSettled([...inflight]);
    },
    client:{
      execute:statement=>track((async()=>{
        if(hooks.execute) await hooks.execute(statement);
        return db.execute(statement);
      })()),
      batch:(statements,mode)=>track((async()=>{
        if(hooks.batch) await hooks.batch(statements);
        return db.batch(statements,mode);
      })()),
      transaction:mode=>track((async()=>{
        if(hooks.transaction) await hooks.transaction();
        return db.transaction(mode);
      })()),
    },
  };
}

function busy(code='SQLITE_BUSY'){
  return Object.assign(new Error('storage conflict'),{code});
}

const NOW_ROW={rows:[{now_utc:'2020-09-20T09:00:00.000Z'}]};

function scriptedDb({execute,batch,transaction}={}){
  return {
    execute:execute||(async statement=>sqlText(statement).includes('now_utc')?NOW_ROW:{rows:[],rowsAffected:0}),
    batch:batch||(async()=>[{rowsAffected:0},{rowsAffected:0}]),
    transaction:transaction||(async()=>{ throw new Error('unexpected transaction'); }),
  };
}

function claimedRow(overrides={}){
  return {
    id:7,event_type:TYPE,event_version:1,idempotency_key:'test/v1/7',payload_json:'{"a":1}',
    attempt_count:1,max_attempts:5,delivery_timeout_ms:1000,lease_token:'lease-7',
    leased_until:'2020-09-20T09:00:30.000Z',...overrides,
  };
}

const VALID_HANDLERS={[TYPE]:async()=>({providerMessageId:'m'})};

test('event contracts reject every malformed field before any SQL is built',()=>{
  const statement=createOutboxEventStatement(event(1,{notBefore:new Date(START)}));
  assert.equal(statement.args[4],START,'Date not-before values are canonicalized');
  const statementWithoutSchedule=createOutboxEventStatement(event(2,{notBefore:null}));
  assert.equal(statementWithoutSchedule.args[4],null,'a null not-before defers to database time');
  const cases=[
    [{eventType:undefined},/event type/],
    [{eventType:`a.${'b'.repeat(100)}`},/event type/],
    [{idempotencyKey:'short'},/idempotency key/],
    [{idempotencyKey:'k'.repeat(256)},/idempotency key/],
    [{idempotencyKey:'test/v1/\u0007bell'},/idempotency key/],
    [{idempotencyKey:undefined},/idempotency key/],
    [{payload:null},/payload/],
    [{payload:[1,2]},/payload/],
    [{payload:{blob:'x'.repeat(70_000)}},/too large/],
    [{notBefore:'not a date'},/not-before time/],
    [{eventVersion:0},/delivery policy/],
    [{maxAttempts:101},/delivery policy/],
    [{deliveryTimeoutMs:99},/delivery policy/],
    [{deliveryTimeoutMs:1.5},/delivery policy/],
  ];
  for(const [overrides,pattern] of cases){
    assert.throws(()=>createOutboxEventStatement(event(3,overrides)),pattern,JSON.stringify(overrides).slice(0,80));
  }
  assert.throws(()=>createOutboxEventStatement(),/event type/);
});

test('delivery errors normalize their code and bound provider retry hints',()=>{
  const lower=new OutboxDeliveryError('provider_busy',{retryAfterMs:1500});
  assert.equal(lower.code,'PROVIDER_BUSY');
  assert.equal(lower.retryable,true);
  assert.equal(lower.retryAfterMs,1500);
  const invalid=new OutboxDeliveryError('has spaces!',{retryable:'yes',retryAfterMs:-1});
  assert.equal(invalid.code,'DELIVERY_FAILED');
  assert.equal(invalid.retryable,false,'only a literal true is retryable');
  assert.equal(invalid.retryAfterMs,null);
  assert.equal(new OutboxDeliveryError(null).code,'DELIVERY_FAILED');
  assert.equal(new OutboxDeliveryError('X',{retryAfterMs:7*60*60*1000}).retryAfterMs,null,
    'a hint above the six hour ceiling is ignored');
  const cause=new Error('root');
  assert.equal(new OutboxDeliveryError('X',{cause}).cause,cause);
  assert.equal('cause' in new OutboxDeliveryError('X'),false);
});

test('every public entry point rejects invalid clients, workers, and policies without touching storage',async()=>{
  for(const bad of [null,{execute(){}},{execute(){},transaction(){}}]){
    await assert.rejects(enqueueOutboxEvent(bad,event()),/transactional database client required/);
  }
  const db=scriptedDb({execute:async()=>{ throw new Error('storage must not be touched'); },
    batch:async()=>{ throw new Error('storage must not be touched'); }});
  for(const workerId of ['',' ','w'.repeat(101),'worker\nid',undefined]){
    await assert.rejects(claimOutboxEvent(db,{workerId}),/worker id/);
  }
  await assert.rejects(claimOutboxEvent(db,{workerId:'w',leaseDurationMs:999}),/lease duration/);
  await assert.rejects(claimOutboxEvent(db,{workerId:'w',eventType:'Bad'}),/event type/);
  await assert.rejects(claimOutboxEvent(db,{workerId:'w',idempotencyKey:'tiny'}),/idempotency key/);
  await assert.rejects(claimOutboxEvent(db),/worker id/);

  await assert.rejects(heartbeatOutboxLease(db,{eventId:0,leaseToken:'t',workerId:'w'}),/invalid outbox lease/);
  await assert.rejects(heartbeatOutboxLease(db,{eventId:1,leaseToken:'',workerId:'w'}),/invalid outbox lease/);
  await assert.rejects(heartbeatOutboxLease(db,{eventId:1,leaseToken:'t',workerId:'w',leaseDurationMs:300_001}),
    /invalid outbox lease/);
  await assert.rejects(heartbeatOutboxLease(db),/worker id/);

  await assert.rejects(runOutboxWorker({db,handlers:null}),/handlers are required/);
  await assert.rejects(runOutboxWorker({db,handlers:[]}),/handlers are required/);
  await assert.rejects(runOutboxWorker({db,handlers:VALID_HANDLERS,batchSize:0}),/worker policy/);
  await assert.rejects(runOutboxWorker({db,handlers:VALID_HANDLERS,leaseDurationMs:2000,heartbeatIntervalMs:2000}),
    /worker policy/,'a heartbeat must be shorter than its lease');
  await assert.rejects(runOutboxWorker({db,handlers:VALID_HANDLERS,baseBackoffMs:0}),/worker policy/);
  await assert.rejects(runOutboxWorker({db,handlers:VALID_HANDLERS,baseBackoffMs:5000,maxBackoffMs:4000}),
    /worker policy/);
  await assert.rejects(runOutboxWorker({db,handlers:new Map(),eventType:'BAD'}),/event type/);
  await assert.rejects(runOutboxWorker(),/transactional database client required/);

  const {clock}=controlledClock();
  const invocation=overrides=>runOutboxInvocation({db,handlers:VALID_HANDLERS,eventTypes:[TYPE],clock,...overrides});
  await assert.rejects(invocation({handlers:'nope'}),/handlers are required/);
  await assert.rejects(invocation({eventTypes:[]}),/event types are required/);
  await assert.rejects(invocation({eventTypes:'test.notification'}),/event types are required/);
  await assert.rejects(invocation({eventTypes:[TYPE,TYPE]}),/requires one handler/);
  await assert.rejects(invocation({eventTypes:[TYPE,OTHER]}),/requires one handler/);
  await assert.rejects(invocation({handlers:new Map([[TYPE,'not a function']])}),/requires one handler/);
  await assert.rejects(invocation({maxClaims:0}),/invocation policy/);
  await assert.rejects(invocation({deadlineAtMs:Number.NaN}),/invocation policy/);
  await assert.rejects(invocation({finalizationReserveMs:99}),/invocation policy/);
  await assert.rejects(invocation({minimumDispatchWindowMs:10_001}),/invocation policy/);
  await assert.rejects(invocation({heartbeatIntervalMs:-1}),/invocation policy/);
  await assert.rejects(invocation({clock:{now:()=>0}}),/monotonic clock/);
  await assert.rejects(invocation({clock:{now:()=>Number.NaN,setTimeout(){},clearTimeout(){}}}),/monotonic clock/);
  await assert.rejects(invocation({clock:{now:()=>'0',setTimeout(){},clearTimeout(){}}}),/monotonic clock/);
  await assert.rejects(runOutboxInvocation(),/transactional database client required/);

  const immediate=overrides=>deliverOutboxEventsNow({db,handlers:VALID_HANDLERS,clock,deadlineAtMs:10_000,
    events:[{eventType:TYPE,idempotencyKey:'test/v1/1'}],...overrides});
  await assert.rejects(immediate({handlers:undefined}),/handlers are required/);
  await assert.rejects(immediate({events:null}),/outbox events are required/);
  await assert.rejects(immediate({events:Array.from({length:101},(_,index)=>({eventType:TYPE,
    idempotencyKey:`test/v1/${index}`}))}),/outbox events are required/);
  await assert.rejects(immediate({events:[null]}),/event type/);
  await assert.rejects(immediate({events:[{eventType:TYPE}]}),/idempotency key/);
  await assert.rejects(immediate({deadlineAtMs:undefined}),/immediate delivery policy/);
  await assert.rejects(immediate({leaseDurationMs:1}),/immediate delivery policy/);
  await assert.rejects(immediate({maxBackoffMs:0}),/immediate delivery policy/);
  await assert.rejects(deliverOutboxEventsNow(),/transactional database client required/);

  for(const request of [{eventId:0,operatorUserId:1,reasonCode:'OPERATOR_RETRY'},
    {eventId:1,operatorUserId:'x',reasonCode:'OPERATOR_RETRY'},
    {eventId:1,operatorUserId:1,reasonCode:'BECAUSE'},
    {eventId:1,operatorUserId:1}]){
    await assert.rejects(replayDeadLetter(db,request),/invalid outbox replay request/);
  }
  await assert.rejects(replayDeadLetter(db),/invalid outbox replay request/);
  await assert.rejects(readOutboxMetrics(null),/database client required/);
  await assert.rejects(readOutboxMetrics({query(){}}),/database client required/);
  await assert.rejects(readOutboxMetrics(db,{eventType:'nope'}),/event type/);
});

test('settleBeforeDeadline returns without waiting past the deadline and rethrows completed failures',async()=>{
  const {clock}=controlledClock(1000);
  await assert.rejects(settleBeforeDeadline(null,2000,{clock}),/deadline work is required/);
  let ran=false;
  assert.deepEqual(await settleBeforeDeadline(()=>{ ran=true; },1000,{clock}),{completed:false,value:null});
  assert.deepEqual(await settleBeforeDeadline(()=>{ ran=true; },Number.NaN,{clock}),{completed:false,value:null});
  assert.equal(ran,false,'expired or undefined deadlines never start the work');
  assert.deepEqual(await settleBeforeDeadline(()=>42,5000,{clock}),{completed:true,value:42});
  await assert.rejects(settleBeforeDeadline(async()=>{ throw new Error('late storage failure'); },5000,{clock}),
    /late storage failure/);
  await assert.rejects(settleBeforeDeadline(()=>1,5000,{clock:{now:()=>0,setTimeout(){}}}),/monotonic clock/);
  const timeoutClock=controlledClock(0);
  const pending=settleBeforeDeadline(()=>new Promise(()=>{}),100,{clock:timeoutClock.clock});
  timeoutClock.runNext();
  assert.deepEqual(await pending,{completed:false,value:null});
  assert.deepEqual(await settleBeforeDeadline(()=>7,performance.now()+5_000),{completed:true,value:7},
    'the default system clock is used when none is supplied');
});

test('claims retry vetted lock conflicts, stop on other failures, and reject unaudited or unreadable leases',async()=>{
  let calls=0;
  const recovering=scriptedDb({
    batch:async()=>{
      calls+=1;
      if(calls===1) throw busy('SQLITE_BUSY');
      if(calls===2) throw new Error('wrapped',{cause:new Error('SQLITE_LOCKED: database table is locked')});
      if(calls===3) throw Object.assign(new Error('x'),{rawCode:'libsql_transaction_busy'});
      return [{rowsAffected:1},{rowsAffected:1}];
    },
    execute:async()=>({rows:[claimedRow()]}),
  });
  const claimed=await claimOutboxEvent(recovering,{workerId:'w',eventType:TYPE,idempotencyKey:'test/v1/7'});
  assert.equal(calls,4);
  assert.equal(claimed.id,7);
  assert.deepEqual(claimed.payload,{a:1});
  assert.equal('payloadJson' in claimed,false);
  assert.ok(Object.isFrozen(claimed));

  let exhausted=0;
  await assert.rejects(claimOutboxEvent(scriptedDb({batch:async()=>{ exhausted+=1; throw busy('SQLITE_BUSY_SNAPSHOT'); }}),
    {workerId:'w'}),error=>error.code==='SQLITE_BUSY_SNAPSHOT');
  assert.equal(exhausted,4,'lock conflicts are retried a bounded number of times');

  let constraint=0;
  await assert.rejects(claimOutboxEvent(scriptedDb({batch:async()=>{ constraint+=1; throw busy('SQLITE_CONSTRAINT'); }}),
    {workerId:'w'}),error=>error.code==='SQLITE_CONSTRAINT');
  assert.equal(constraint,1,'non-conflict failures are never retried');

  let deep=0;
  const tooDeep=new Error('l0',{cause:new Error('l1',{cause:new Error('l2',{cause:new Error('l3',{cause:new Error('l4',
    {cause:new Error('l5',{cause:busy('SQLITE_BUSY')})})})})})});
  await assert.rejects(claimOutboxEvent(scriptedDb({batch:async()=>{ deep+=1; throw tooDeep; }}),{workerId:'w'}),/l0/);
  assert.equal(deep,1,'the cause chain is inspected to a bounded depth only');

  assert.equal(await claimOutboxEvent(scriptedDb({batch:async()=>[]}),{workerId:'w'}),null,
    'no due event yields null');
  await assert.rejects(claimOutboxEvent(scriptedDb({batch:async()=>[{rowsAffected:1},{rowsAffected:0}]}),{workerId:'w'}),
    /audit was not committed/);
  await assert.rejects(claimOutboxEvent(scriptedDb({batch:async()=>[{rowsAffected:1},{rowsAffected:1}],
    execute:async()=>({})}),{workerId:'w'}),/could not be read/);
});

test('claimed rows that are corrupt or carry a non-object payload are permanent failures',async()=>{
  const claimWith=overrides=>claimOutboxEvent(scriptedDb({
    batch:async()=>[{rowsAffected:1},{rowsAffected:1}],
    execute:async()=>({rows:[claimedRow(overrides)]}),
  }),{workerId:'w'});
  for(const overrides of [{id:0},{event_type:null},{event_version:0},{idempotency_key:null},{attempt_count:0},
    {max_attempts:0},{lease_token:null},{delivery_timeout_ms:99},{payload_json:null,event_type:'Bad.Type'}]){
    await assert.rejects(claimWith(overrides),error=>error instanceof OutboxDeliveryError
      &&error.code==='EVENT_CORRUPT'&&error.retryable===false,JSON.stringify(overrides));
  }
  for(const payload of ['[1]','null','{broken',null]){
    await assert.rejects(claimWith({payload_json:payload}),error=>error.code==='PAYLOAD_INVALID'&&!error.retryable,
      String(payload));
  }
});

test('round claims reject audit or read mismatches and retry a conflicted round',async()=>{
  const {clock}=controlledClock();
  const invoke=db=>runOutboxInvocation({db,workerId:'round',handlers:VALID_HANDLERS,eventTypes:[TYPE],
    maxClaims:1,deadlineAtMs:60_000,finalizationReserveMs:100,heartbeatIntervalMs:0,clock});
  await assert.rejects(invoke(scriptedDb({batch:async()=>[{rowsAffected:2},{rowsAffected:1}]})),
    /audits were not committed/);
  await assert.rejects(invoke(scriptedDb({batch:async()=>[{rowsAffected:1},{rowsAffected:1}],
    execute:async()=>({})})),/could not be read/);
  let calls=0;
  const result=await invoke(scriptedDb({batch:async()=>{
    calls+=1;
    if(calls===1) throw busy('SQLITE_LOCKED');
    return [];
  },execute:async statement=>sqlText(statement).includes('now_utc')?NOW_ROW:{}}));
  assert.equal(calls,2);
  assert.equal(result.claimed,0);
  assert.equal(result.deadLettered,0,'an empty sweep result is tolerated');
  assert.equal(result.deadlineReached,false);
  let failing=0;
  await assert.rejects(invoke(scriptedDb({batch:async()=>{ failing+=1; throw busy('SQLITE_IOERR'); }})),
    error=>error.code==='SQLITE_IOERR');
  assert.equal(failing,1);
});

function transactionScript(steps){
  const log=[];
  let index=0;
  return {
    log,
    async transaction(){
      const step=steps[Math.min(index,steps.length-1)];
      index+=1;
      return {
        async execute(statement){
          log.push(sqlText(statement).trim().startsWith('UPDATE')?'update':'audit');
          if(sqlText(statement).trim().startsWith('UPDATE')){
            if(step.update instanceof Error) throw step.update;
            return {rowsAffected:step.update??1};
          }
          step.audits?.push(statement.args);
          return {rowsAffected:1};
        },
        async commit(){ log.push('commit'); if(step.commit instanceof Error) throw step.commit; },
        async rollback(){ log.push('rollback'); if(step.rollback) throw step.rollback; },
        close:step.noClose?undefined:()=>{ log.push('close'); if(step.close) throw step.close; },
      };
    },
  };
}

test('guarded transitions retry pre-commit conflicts, tolerate cleanup failures, and never retry a started commit',async()=>{
  const audits=[];
  const recovering=transactionScript([
    {update:busy('SQLITE_BUSY'),rollback:new Error('rollback failed'),close:new Error('close failed')},
    {update:1,audits},
  ]);
  const replayed=await replayDeadLetter(scriptedDb({transaction:recovering.transaction}),{
    eventId:9,operatorUserId:3,reasonCode:' provider_recovered ',notBefore:new Date('2020-09-21T00:00:00Z'),
  });
  assert.equal(replayed,true);
  assert.deepEqual(recovering.log,['update','rollback','close','update','audit','commit','close']);
  assert.deepEqual(audits[0],[9,'replayed','operator','user:3','dead_letter','pending','PROVIDER_RECOVERED',0]);

  const notDead=transactionScript([{update:0}]);
  assert.equal(await replayDeadLetter(scriptedDb({transaction:notDead.transaction}),
    {eventId:9,operatorUserId:3,reasonCode:'OPERATOR_RETRY'}),false,'only a dead-lettered row can be replayed');
  assert.deepEqual(notDead.log,['update','rollback','close']);

  const ambiguous=transactionScript([{update:1,commit:busy('SQLITE_BUSY'),noClose:true}]);
  await assert.rejects(replayDeadLetter(scriptedDb({transaction:ambiguous.transaction}),
    {eventId:9,operatorUserId:3,reasonCode:'CONFIGURATION_FIXED'}),error=>error.code==='SQLITE_BUSY');
  assert.deepEqual(ambiguous.log,['update','audit','commit'],'an ambiguous commit is neither rolled back nor retried');

  const alwaysBusy=transactionScript([{update:busy('SQLITE_BUSY')}]);
  await assert.rejects(replayDeadLetter(scriptedDb({transaction:alwaysBusy.transaction}),
    {eventId:9,operatorUserId:3,reasonCode:'OPERATOR_RETRY'}),error=>error.code==='SQLITE_BUSY');
  assert.equal(alwaysBusy.log.filter(entry=>entry==='update').length,4);

  let opened=0;
  await assert.rejects(replayDeadLetter(scriptedDb({transaction:async()=>{ opened+=1; throw new Error('cannot open'); }}),
    {eventId:9,operatorUserId:3,reasonCode:'OPERATOR_RETRY'}),/cannot open/);
  assert.equal(opened,1);
  await assert.rejects(replayDeadLetter(scriptedDb({execute:async()=>({rows:[{now_utc:'garbage'}]})}),
    {eventId:9,operatorUserId:3,reasonCode:'OPERATOR_RETRY'}),/invalid outbox database time/);
});

test('metrics are read per type with stable shapes even when storage omits optional columns',async()=>{
  const statements=[];
  const db={execute:async statement=>{
    statements.push(statement);
    return typeof statement==='string'?{}:{rows:[{event_type:TYPE,event_version:'2',status:'retry',count:'3'}]};
  }};
  assert.deepEqual(await readOutboxMetrics(db),[]);
  const typed=await readOutboxMetrics(db,{eventType:TYPE});
  assert.deepEqual(typed,[{eventType:TYPE,eventVersion:2,status:'retry',count:3,oldestCreatedAt:''}]);
  assert.ok(Object.isFrozen(typed)&&Object.isFrozen(typed[0]));
  assert.deepEqual(statements[1].args,[TYPE]);
});

test('unknown handler failures retry with the generic code and dead-letter once attempts are exhausted',async()=>{
  const db=await fixture();
  await enqueueOutboxEvent(db,event(1,{maxAttempts:2}));
  await enqueueOutboxEvent(db,event(2));
  const run=handlers=>runOutboxWorker({db,workerId:'generic',handlers,leaseDurationMs:1000,heartbeatIntervalMs:0,
    baseBackoffMs:60_000,maxBackoffMs:60_000});
  const first=await run({[TYPE]:async current=>{
    if(current.payload.sequence===2) return 'accepted';
    throw new Error('provider exploded with private detail');
  }});
  assert.deepEqual({...first},{claimed:2,delivered:1,suppressed:0,retried:1,deadLettered:0,leaseLost:0});
  const retried=await row(db,'test/v1/1');
  assert.equal(retried.status,'retry');
  assert.equal(retried.last_error_code,'DELIVERY_FAILED','raw provider text never reaches storage');
  const delivered=await row(db,'test/v1/2');
  assert.equal(delivered.status,'delivered');
  assert.equal(delivered.provider_name,null,'a non-object success records no provider identity');
  assert.equal(delivered.provider_message_id,null);

  await db.execute(`UPDATE outbox_events SET next_attempt_at='2020-01-01T00:00:00.000Z' WHERE idempotency_key='test/v1/1'`);
  const second=await run(new Map([[TYPE,async()=>{ throw new Error('still failing'); }]]));
  assert.equal(second.deadLettered,1);
  const dead=await row(db,'test/v1/1');
  assert.equal(dead.status,'dead_letter');
  assert.equal(dead.last_error_code,'DELIVERY_FAILED');
  assert.equal(Number(dead.attempt_count),2);
});

test('a handler that finishes after its heartbeat lost the lease is never recorded as delivered',async()=>{
  const db=await fixture();
  await enqueueOutboxEvent(db,event(1));
  const started=deferred();
  const release=deferred();
  let aborted=null;
  const handlers={[TYPE]:async(current,{signal})=>{
    signal.addEventListener('abort',()=>{ aborted=signal.reason; },{once:true});
    started.resolve();
    await release.promise;
    return {providerName:'resend',providerMessageId:'late-message'};
  }};
  const control=controlledClock();
  const running=runOutboxInvocation({db,workerId:'hb-worker',handlers,eventTypes:[TYPE],maxClaims:1,
    deadlineAtMs:60_000,finalizationReserveMs:100,leaseDurationMs:5_000,heartbeatIntervalMs:1_000,
    clock:control.clock});
  await started.promise;
  await db.execute(`UPDATE outbox_events SET lease_token='stolen-by-recovery' WHERE idempotency_key='test/v1/1'`);
  control.runNext();
  while(!aborted) await new Promise(resolve=>setImmediate(resolve));
  assert.equal(aborted.name,'OutboxLeaseLostError');
  assert.equal(aborted.code,'OUTBOX_LEASE_LOST');
  release.resolve();
  const result=await running;
  assert.equal(result.claimed,1);
  assert.equal(result.leaseLost,1);
  assert.equal(result.delivered,0);
  const stored=await row(db,'test/v1/1');
  assert.equal(stored.status,'processing','the new lease holder still owns the row');
  assert.equal(stored.lease_token,'stolen-by-recovery');
  assert.equal(stored.provider_message_id,null);
});

test('a heartbeat storage failure aborts an inline delivery as lease lost and leaves the row for recovery',async()=>{
  const db=await fixture();
  await enqueueOutboxEvent(db,event(1));
  const harness=hooked(db);
  harness.hooks.execute=statement=>{
    if(sqlText(statement).includes('leased_until=MAX')) throw new Error('heartbeat write failed');
  };
  const started=deferred();
  const handlers={[TYPE]:(current,{signal})=>new Promise((_,reject)=>{
    signal.addEventListener('abort',()=>reject(signal.reason),{once:true});
    started.resolve();
  })};
  const control=controlledClock();
  const running=deliverOutboxEventsNow({db:harness.client,workerId:'inline-hb',handlers,
    events:[{eventType:TYPE,idempotencyKey:'test/v1/1'}],deadlineAtMs:60_000,finalizationReserveMs:100,
    leaseDurationMs:5_000,heartbeatIntervalMs:1_000,clock:control.clock});
  await started.promise;
  control.runNext();
  const result=await running;
  assert.deepEqual({...result},{claimed:1,delivered:0,suppressed:0,retried:0,deadLettered:0,leaseLost:1,
    deadlineReached:false});
  const stored=await row(db,'test/v1/1');
  assert.equal(stored.status,'processing');
  assert.equal(stored.lease_owner,'inline-hb','the lease expires naturally for the scheduled worker');
});

test('inline delivery skips targets without a handler and delivers the rest with its idempotency key',async()=>{
  const db=await fixture();
  await enqueueOutboxEvent(db,event(1,{eventType:OTHER}));
  await enqueueOutboxEvent(db,event(2));
  const seen=[];
  const result=await deliverOutboxEventsNow({db,workerId:'inline-skip',
    handlers:new Map([[TYPE,async current=>{ seen.push(current.idempotencyKey); return {providerMessageId:'p2'}; }]]),
    events:[{eventType:OTHER,idempotencyKey:'test/v1/1'},{eventType:TYPE,idempotencyKey:'test/v1/2'}],
    deadlineAtMs:performance.now()+30_000,heartbeatIntervalMs:0});
  assert.equal(result.claimed,1);
  assert.equal(result.delivered,1);
  assert.deepEqual(seen,['test/v1/2']);
  const skipped=await row(db,'test/v1/1');
  assert.equal(skipped.status,'pending');
  assert.equal(Number(skipped.attempt_count),0,'an unhandled type is not claimed or charged an attempt');
  assert.equal((await row(db,'test/v1/2')).provider_message_id,'p2');
});

test('inline delivery converts an exhausted dispatch window into a deadline retry without calling the provider',async()=>{
  const db=await fixture();
  await enqueueOutboxEvent(db,event(1));
  await enqueueOutboxEvent(db,event(2));
  const harness=hooked(db);
  const control=controlledClock();
  harness.hooks.batch=async()=>{ await null; control.set(9_850); };
  let providerCalls=0;
  const result=await deliverOutboxEventsNow({db:harness.client,workerId:'inline-window',
    handlers:{[TYPE]:async()=>{ providerCalls+=1; return {}; }},
    events:[{eventType:TYPE,idempotencyKey:'test/v1/1'},{eventType:TYPE,idempotencyKey:'test/v1/2'}],
    deadlineAtMs:10_000,finalizationReserveMs:100,minimumDispatchWindowMs:100,heartbeatIntervalMs:0,
    baseBackoffMs:60_000,maxBackoffMs:60_000,clock:control.clock});
  assert.equal(providerCalls,0);
  assert.equal(result.claimed,1);
  assert.equal(result.retried,1);
  assert.equal(result.deadlineReached,true,'the second target is left for the scheduled worker');
  const first=await row(db,'test/v1/1');
  assert.equal(first.status,'retry');
  assert.equal(first.last_error_code,'INVOCATION_DEADLINE');
  assert.equal((await row(db,'test/v1/2')).status,'pending');
});

test('an inline claim that commits after the deadline is resolved to a deadline retry without a provider call',async()=>{
  const db=await fixture();
  await enqueueOutboxEvent(db,event(1));
  const harness=hooked(db);
  const gate=deferred();
  const batchStarted=deferred();
  harness.hooks.batch=async()=>{ batchStarted.resolve(); await gate.promise; };
  let providerCalls=0;
  const control=controlledClock();
  const running=deliverOutboxEventsNow({db:harness.client,workerId:'inline-late',
    handlers:{[TYPE]:async()=>{ providerCalls+=1; return {}; }},
    events:[{eventType:TYPE,idempotencyKey:'test/v1/1'}],deadlineAtMs:10_000,finalizationReserveMs:100,
    heartbeatIntervalMs:0,baseBackoffMs:60_000,maxBackoffMs:60_000,clock:control.clock});
  await batchStarted.promise;
  control.runNext();
  const result=await running;
  assert.equal(result.claimed,0);
  assert.equal(result.deadlineReached,true);
  harness.hooks.batch=null;
  gate.resolve();
  await harness.idle();
  const stored=await row(db,'test/v1/1');
  assert.equal(stored.status,'retry');
  assert.equal(stored.last_error_code,'INVOCATION_DEADLINE');
  assert.equal(stored.lease_owner,null);
  assert.equal(providerCalls,0);
});

test('inline finalization that outlives the deadline is reported as lease lost but still commits exactly once',async()=>{
  const db=await fixture();
  await enqueueOutboxEvent(db,event(1));
  const harness=hooked(db);
  const gate=deferred();
  const transactionStarted=deferred();
  harness.hooks.transaction=async()=>{ transactionStarted.resolve(); await gate.promise; };
  const control=controlledClock();
  const running=deliverOutboxEventsNow({db:harness.client,workerId:'inline-final',
    handlers:{[TYPE]:async()=>({providerName:'resend',providerMessageId:'final-1'})},
    events:[{eventType:TYPE,idempotencyKey:'test/v1/1'}],deadlineAtMs:10_000,finalizationReserveMs:100,
    heartbeatIntervalMs:0,clock:control.clock});
  await transactionStarted.promise;
  control.runNext();
  const result=await running;
  assert.equal(result.claimed,1);
  assert.equal(result.leaseLost,1);
  assert.equal(result.delivered,0);
  assert.equal(result.deadlineReached,true);
  harness.hooks.transaction=null;
  gate.resolve();
  await harness.idle();
  const stored=await row(db,'test/v1/1');
  assert.equal(stored.status,'delivered');
  assert.equal(stored.provider_message_id,'final-1');
  const audits=(await db.execute(`SELECT action FROM outbox_audit_events ORDER BY id`)).rows.map(entry=>entry.action);
  assert.deepEqual(audits,['claimed','delivered']);
});

test('an inline finalization storage failure is contained and the lease protects the row',async()=>{
  const db=await fixture();
  await enqueueOutboxEvent(db,event(1));
  const harness=hooked(db);
  harness.hooks.transaction=()=>{ throw new Error('disk I/O error'); };
  const result=await deliverOutboxEventsNow({db:harness.client,workerId:'inline-fail',
    handlers:{[TYPE]:async()=>({providerMessageId:'sent-but-unrecorded'})},
    events:[{eventType:TYPE,idempotencyKey:'test/v1/1'}],deadlineAtMs:performance.now()+30_000,
    heartbeatIntervalMs:0});
  assert.equal(result.claimed,1);
  assert.equal(result.leaseLost,1);
  assert.equal(result.deadlineReached,false);
  const stored=await row(db,'test/v1/1');
  assert.equal(stored.status,'processing');
  assert.equal(stored.lease_owner,'inline-fail');
});

test('a fair round claimed too close to the deadline resolves every lease to a deadline retry',async()=>{
  const db=await fixture();
  await enqueueOutboxEvent(db,event(1));
  await enqueueOutboxEvent(db,event(2,{eventType:OTHER}));
  const harness=hooked(db);
  const control=controlledClock();
  harness.hooks.batch=async()=>{ await null; control.set(9_850); };
  let providerCalls=0;
  const handler=async()=>{ providerCalls+=1; return {}; };
  const result=await runOutboxInvocation({db:harness.client,workerId:'round-window',
    handlers:{[TYPE]:handler,[OTHER]:handler},eventTypes:[TYPE,OTHER],maxClaims:4,deadlineAtMs:10_000,
    finalizationReserveMs:100,minimumDispatchWindowMs:100,heartbeatIntervalMs:0,baseBackoffMs:60_000,
    maxBackoffMs:60_000,clock:control.clock});
  assert.equal(providerCalls,0);
  assert.equal(result.claimed,2);
  assert.equal(result.retried,2);
  assert.equal(result.deadlineReached,true);
  assert.equal(result.perType[TYPE].retried,1);
  assert.equal(result.perType[OTHER].retried,1);
  for(const key of ['test/v1/1','test/v1/2']){
    const stored=await row(db,key);
    assert.equal(stored.status,'retry');
    assert.equal(stored.last_error_code,'INVOCATION_DEADLINE');
  }
});

test('a late round whose deadline finalization fails stays leased for expiry recovery',async()=>{
  const db=await fixture();
  await enqueueOutboxEvent(db,event(1));
  const harness=hooked(db);
  const gate=deferred();
  const batchStarted=deferred();
  const finalizeAttempted=deferred();
  harness.hooks.batch=async()=>{ batchStarted.resolve(); await gate.promise; };
  const control=controlledClock();
  const result=await (async()=>{
    const running=runOutboxInvocation({db:harness.client,workerId:'late-round',handlers:VALID_HANDLERS,
      eventTypes:[TYPE],maxClaims:1,deadlineAtMs:10_000,finalizationReserveMs:100,heartbeatIntervalMs:0,
      clock:control.clock});
    await batchStarted.promise;
    control.runNext();
    return running;
  })();
  assert.equal(result.claimed,0);
  assert.equal(result.deadlineReached,true);
  harness.hooks.batch=null;
  harness.hooks.execute=statement=>{
    if(sqlText(statement).includes('now_utc')){
      finalizeAttempted.resolve();
      throw new Error('database time unavailable');
    }
  };
  gate.resolve();
  await finalizeAttempted.promise;
  await harness.idle();
  const stored=await row(db,'test/v1/1');
  assert.equal(stored.status,'processing');
  assert.equal(stored.lease_owner,'late-round');
});

test('exhausted-lease cleanup never holds the invocation past its deadline',async()=>{
  const db=await fixture();
  await enqueueOutboxEvent(db,event(1,{maxAttempts:1}));
  await db.execute(`UPDATE outbox_events SET attempt_count=1 WHERE idempotency_key='test/v1/1'`);
  const harness=hooked(db);
  const gate=deferred();
  const sweepStarted=deferred();
  harness.hooks.execute=async statement=>{
    if(sqlText(statement).includes('now_utc')){ sweepStarted.resolve(); await gate.promise; }
  };
  const control=controlledClock();
  const running=runOutboxInvocation({db:harness.client,workerId:'sweeper',handlers:VALID_HANDLERS,
    eventTypes:[TYPE],maxClaims:1,deadlineAtMs:10_000,finalizationReserveMs:100,heartbeatIntervalMs:0,
    clock:control.clock});
  await sweepStarted.promise;
  control.runNext();
  const result=await running;
  assert.equal(result.claimed,0);
  assert.equal(result.deadLettered,0);
  assert.equal(result.deadlineReached,true);
  harness.hooks.execute=null;
  gate.resolve();
  await harness.idle();
  assert.equal((await row(db,'test/v1/1')).status,'pending',
    'a sweep resumed after the deadline stops before any transition');
});
