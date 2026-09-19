import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, test } from 'node:test';

import { createClient } from '@libsql/client';

import {
  claimOutboxEvent,
  createOutboxEventStatement,
  enqueueOutboxEvent,
  heartbeatOutboxLease,
  OutboxDeliveryError,
  readOutboxMetrics,
  replayDeadLetter,
  runOutboxWorker,
} from '../../api/_outbox.js';
import {
  classifyPairingProviderError,
  createPairingEmailHandler,
  createResendEmailSender,
  PAIRING_EMAIL_EVENT_TYPE,
} from '../../api/_pairing-email.js';
import { EXECUTABLE_MIGRATIONS } from '../../db/executable-migrations.js';
import {
  applyMigrations,
  inspectMigrationState,
  prepareMigrationConnection,
} from '../../db/migration-runner.js';

const cleanup=[];
const START='2020-09-20T08:00:00.000Z';

afterEach(async()=>{
  while(cleanup.length){
    try{ await cleanup.pop()(); }catch{}
  }
});

async function fixture(clientCount=1){
  const directory=mkdtempSync(join(tmpdir(),'randori-outbox-'));
  const url=`file:${join(directory,'outbox.sqlite')}`;
  const clients=Array.from({length:clientCount},()=>createClient({url}));
  for(const client of clients) await prepareMigrationConnection(client);
  const initial=await inspectMigrationState(clients[0]);
  await applyMigrations(clients[0],{
    expectedStateFingerprint:initial.stateFingerprint,
    retry:{maxAttempts:1,baseDelayMs:0,maxDelayMs:0},
  });
  cleanup.push(async()=>{
    for(const client of clients) client.close();
    rmSync(directory,{recursive:true,force:true});
  });
  return {db:clients[0],clients};
}

function event(overrides={}){
  return {
    eventType:'test.notification',eventVersion:1,
    idempotencyKey:`test/v1/${overrides.sequence??1}`,
    payload:{sequence:overrides.sequence??1},notBefore:START,
    maxAttempts:overrides.maxAttempts??5,
    deliveryTimeoutMs:overrides.deliveryTimeoutMs??1000,
    ...overrides,
  };
}

function worker(db,handlers,overrides={}){
  return runOutboxWorker({
    db,workerId:overrides.workerId||'test-worker',handlers,
    batchSize:overrides.batchSize||100,
    leaseDurationMs:overrides.leaseDurationMs||1000,heartbeatIntervalMs:overrides.heartbeatIntervalMs??0,
    baseBackoffMs:overrides.baseBackoffMs||60_000,maxBackoffMs:overrides.maxBackoffMs||60_000,
  });
}

async function row(db,id=1){
  return (await db.execute({sql:'SELECT * FROM outbox_events WHERE id=?',args:[id]})).rows[0];
}

test('enqueue is idempotent, scheduled, versioned, and rejects invalid event contracts',async()=>{
  const {db}=await fixture();
  assert.deepEqual(await enqueueOutboxEvent(db,event()),{created:true});
  assert.deepEqual(await enqueueOutboxEvent(db,event({payload:{sequence:999}})),{created:false});
  const stored=await row(db);
  assert.equal(stored.event_type,'test.notification');
  assert.equal(Number(stored.event_version),1);
  assert.equal(stored.idempotency_key,'test/v1/1');
  assert.equal(stored.status,'pending');
  assert.equal(stored.not_before,START);
  assert.deepEqual(JSON.parse(stored.payload_json),{sequence:1});
  assert.throws(()=>createOutboxEventStatement(event({eventType:'Invalid'})),/event type/);
  assert.throws(()=>createOutboxEventStatement(event({payload:'private'})),/payload/);
});

test('crash-after-send retries with the same provider key and has one user-visible delivery',async()=>{
  const {db}=await fixture();
  await enqueueOutboxEvent(db,event());
  const accepted=new Map();
  let visibleDeliveries=0;
  let calls=0;
  const handler=async current=>{
    calls+=1;
    if(!accepted.has(current.idempotencyKey)){
      accepted.set(current.idempotencyKey,'provider-message-1');
      visibleDeliveries+=1;
    }
    if(calls===1) throw new OutboxDeliveryError('PROVIDER_RESPONSE_LOST',{retryable:true});
    return {providerName:'test-provider',providerMessageId:accepted.get(current.idempotencyKey)};
  };
  const first=await worker(db,{'test.notification':handler});
  assert.equal(first.retried,1);
  assert.equal((await row(db)).last_error_code,'PROVIDER_RESPONSE_LOST');
  await db.execute(`UPDATE outbox_events SET next_attempt_at=strftime('%Y-%m-%dT%H:%M:%fZ','now','-1 second')`);
  const second=await worker(db,{'test.notification':handler});
  assert.equal(second.delivered,1);
  assert.equal(visibleDeliveries,1);
  assert.equal(calls,2);
  assert.equal((await row(db)).provider_message_id,'provider-message-1');
});

test('the database clock alone controls lease expiry and exclusive ownership',async()=>{
  const {db}=await fixture();
  await enqueueOutboxEvent(db,event());
  const first=await claimOutboxEvent(db,{workerId:'worker-a',leaseDurationMs:1000});
  assert.equal(first.attemptCount,1);
  assert.equal(await claimOutboxEvent(db,{
    workerId:'worker-b',leaseDurationMs:1000,
  }),null);
  const beforeHeartbeat=(await row(db)).leased_until;
  assert.equal(await heartbeatOutboxLease(db,{
    eventId:first.id,leaseToken:first.leaseToken,workerId:'worker-a',
    leaseDurationMs:1000,
  }),true);
  assert.ok((await row(db)).leased_until>=beforeHeartbeat,'a skewed heartbeat never shortens the lease');
  await db.execute(`UPDATE outbox_events SET leased_until='2000-01-01T00:00:00.000Z' WHERE id=1`);
  const reclaimed=await claimOutboxEvent(db,{
    workerId:'worker-b',leaseDurationMs:1000,
  });
  assert.equal(reclaimed.attemptCount,2);
  assert.notEqual(reclaimed.leaseToken,first.leaseToken);
  assert.equal(await heartbeatOutboxLease(db,{
    eventId:first.id,leaseToken:first.leaseToken,workerId:'worker-a',
    leaseDurationMs:1000,
  }),false,'a stale worker cannot renew a replacement lease');
});

test('an expired lease cannot finalize before another worker reclaims it',async()=>{
  const {db}=await fixture();
  await enqueueOutboxEvent(db,event());
  const expiredWorker=await worker(db,{'test.notification':async()=>{
    await db.execute(`UPDATE outbox_events
      SET leased_until='2000-01-01T00:00:00.000Z' WHERE id=1`);
    return {providerName:'test-provider',providerMessageId:'stale-completion'};
  }},{workerId:'expired-worker',batchSize:1});
  assert.deepEqual(expiredWorker,{
    claimed:1,delivered:0,suppressed:0,retried:0,deadLettered:0,leaseLost:1,
  });
  const expired=await row(db);
  assert.equal(expired.status,'processing');
  assert.equal(expired.provider_message_id,null);
  assert.deepEqual((await db.execute(
    'SELECT action,actor_ref FROM outbox_audit_events ORDER BY id',
  )).rows,[{action:'claimed',actor_ref:'expired-worker'}]);

  const recovery=await worker(db,{'test.notification':()=>({
    providerName:'test-provider',providerMessageId:'recovered-completion',
  })},{workerId:'recovery-worker',batchSize:1});
  assert.equal(recovery.delivered,1);
  assert.equal((await row(db)).provider_message_id,'recovered-completion');
});

test('not-before scheduling and an exhausted crashed lease are enforced by database time comparisons',async()=>{
  const {db}=await fixture();
  await enqueueOutboxEvent(db,event({
    notBefore:'2099-09-20T08:10:00.000Z',maxAttempts:1,
  }));
  assert.equal(await claimOutboxEvent(db,{
    workerId:'early-worker',now:'2100-09-20T08:09:59.999Z',leaseDurationMs:1000,
  }),null);
  await db.execute(`UPDATE outbox_events SET not_before='2000-01-01T00:00:00.000Z',next_attempt_at='2000-01-01T00:00:00.000Z'`);
  const claimed=await claimOutboxEvent(db,{
    workerId:'crashing-worker',now:'1900-09-20T08:10:00.000Z',leaseDurationMs:1000,
  });
  assert.equal(claimed.attemptCount,1);
  await db.execute(`UPDATE outbox_events SET leased_until='2000-01-01T00:00:00.000Z' WHERE id=1`);
  const swept=await worker(db,{'test.notification':()=>assert.fail('exhausted work must not dispatch')},{workerId:'recovery-worker'});
  assert.equal(swept.deadLettered,1);
  assert.equal(swept.claimed,0);
  assert.equal((await row(db)).last_error_code,'ATTEMPTS_EXHAUSTED');
});

test('an event-scoped worker never sweeps other types and invalid scope cannot write',async()=>{
  const {db}=await fixture();
  await enqueueOutboxEvent(db,event({eventType:'alpha.notification'}));
  await enqueueOutboxEvent(db,event({eventType:'beta.notification',sequence:2}));
  await db.execute(`UPDATE outbox_events SET status='processing',attempt_count=max_attempts,
    lease_owner='crashed',lease_token='expired',leased_until='2000-01-01T00:00:00.000Z'`);
  const result=await runOutboxWorker({
    db,workerId:'alpha-worker',eventType:'alpha.notification',handlers:{},heartbeatIntervalMs:0,
  });
  assert.equal(result.deadLettered,1);
  assert.deepEqual((await db.execute('SELECT event_type,status FROM outbox_events ORDER BY id')).rows,[
    {event_type:'alpha.notification',status:'dead_letter'},
    {event_type:'beta.notification',status:'processing'},
  ]);
  await assert.rejects(()=>runOutboxWorker({
    db,workerId:'invalid-worker',eventType:'Invalid',handlers:{},heartbeatIntervalMs:0,
  }),/event type/);
  assert.equal((await db.execute("SELECT status FROM outbox_events WHERE event_type='beta.notification'")).rows[0].status,'processing');
});

test('a failed claim audit rolls back the lease and attempt atomically',async()=>{
  const {db}=await fixture();
  await enqueueOutboxEvent(db,event());
  const faultDb={
    execute:db.execute.bind(db),
    async batch(statements){
      if(statements.some(statement=>String(statement?.sql||statement).includes('INSERT INTO outbox_audit_events'))){
        throw new Error('forced audit failure');
      }
      return db.batch(statements,'write');
    },
    async transaction(mode){
      const transaction=await db.transaction(mode);
      return {
        execute:statement=>String(statement?.sql||statement).includes('INSERT INTO outbox_audit_events')
          ?Promise.reject(new Error('forced audit failure')):transaction.execute(statement),
        commit:()=>transaction.commit(),
        rollback:()=>transaction.rollback(),
        close:()=>transaction.close?.(),
      };
    },
  };
  await assert.rejects(()=>claimOutboxEvent(faultDb,{workerId:'fault-worker'}),/forced audit failure/);
  const stored=await row(db);
  assert.equal(stored.status,'pending');
  assert.equal(Number(stored.attempt_count),0);
  assert.equal((await db.execute('SELECT COUNT(*) AS count FROM outbox_audit_events')).rows[0].count,0);
});

test('timeout and poison events become bounded retry and dead-letter outcomes',async()=>{
  const {db}=await fixture();
  await enqueueOutboxEvent(db,event({deliveryTimeoutMs:100,maxAttempts:2}));
  await enqueueOutboxEvent(db,event({sequence:2,eventType:'unknown.event'}));
  const result=await worker(db,{
    'test.notification':()=>new Promise(()=>{}),
  });
  assert.equal(result.retried,1);
  assert.equal(result.deadLettered,1);
  const rows=(await db.execute('SELECT id,status,last_error_code FROM outbox_events ORDER BY id')).rows;
  assert.deepEqual(rows.map(item=>[item.status,item.last_error_code]),[
    ['retry','DELIVERY_TIMEOUT'],['dead_letter','EVENT_HANDLER_MISSING'],
  ]);
});

test('provider 429 and 5xx errors retry without persisting provider or recipient details',async()=>{
  const {db}=await fixture();
  await enqueueOutboxEvent(db,event());
  await enqueueOutboxEvent(db,event({sequence:2}));
  const privateMessage='recipient person@example.test provider body secret-token';
  let call=0;
  const result=await worker(db,{'test.notification':()=>{
    call+=1;
    const raw=Object.assign(new Error(privateMessage),{statusCode:call===1?429:503,retryAfterMs:500});
    throw classifyPairingProviderError(raw);
  }});
  assert.equal(result.retried,2);
  const rows=(await db.execute('SELECT status,last_error_code,next_attempt_at FROM outbox_events ORDER BY id')).rows;
  assert.deepEqual(rows.map(item=>item.last_error_code),['PROVIDER_RATE_LIMITED','PROVIDER_UNAVAILABLE']);
  assert.equal(JSON.stringify({result,rows}).includes('person@example.test'),false);
  assert.equal(JSON.stringify({result,rows}).includes('secret-token'),false);
});

test('a final failed attempt dead-letters and an audited replay preserves idempotency',async()=>{
  const {db}=await fixture();
  await enqueueOutboxEvent(db,event({maxAttempts:1}));
  const failed=await worker(db,{'test.notification':()=>{
    throw new OutboxDeliveryError('PERMANENT_REJECTION',{retryable:false});
  }});
  assert.equal(failed.deadLettered,1);
  const before=await row(db);
  assert.equal(before.status,'dead_letter');
  assert.equal(await replayDeadLetter(db,{
    eventId:before.id,operatorUserId:42,reasonCode:'PROVIDER_RECOVERED',
    notBefore:'2020-09-20T09:00:00.000Z',
  }),true);
  const replayed=await row(db);
  assert.equal(replayed.status,'pending');
  assert.equal(Number(replayed.attempt_count),0);
  assert.equal(Number(replayed.replay_count),1);
  assert.equal(replayed.idempotency_key,before.idempotency_key);
  const audit=(await db.execute({
    sql:`SELECT action,actor_type,actor_ref,reason_code FROM outbox_audit_events
      WHERE outbox_event_id=? ORDER BY id`,args:[before.id],
  })).rows;
  assert.deepEqual(audit.at(-1),{
    action:'replayed',actor_type:'operator',actor_ref:'user:42',reason_code:'PROVIDER_RECOVERED',
  });
  assert.equal(await replayDeadLetter(db,{
    eventId:before.id,operatorUserId:42,reasonCode:'PROVIDER_RECOVERED',
  }),false,'only a dead letter can be replayed');
});

test('an ambiguous transition commit is not retried and its transaction is always closed',async()=>{
  const {db}=await fixture();
  await enqueueOutboxEvent(db,event({maxAttempts:1}));
  await worker(db,{'test.notification':()=>{
    throw new OutboxDeliveryError('PERMANENT_REJECTION',{retryable:false});
  }});

  let transactionCount=0;
  let rollbackCalled=false;
  let closeCalled=false;
  const faultDb={
    execute:db.execute.bind(db),
    batch:db.batch.bind(db),
    async transaction(mode){
      transactionCount+=1;
      const transaction=await db.transaction(mode);
      return {
        execute:transaction.execute.bind(transaction),
        async commit(){
          throw Object.assign(new Error('forced ambiguous commit'),{code:'SQLITE_BUSY'});
        },
        async rollback(){
          rollbackCalled=true;
          await transaction.rollback();
        },
        async close(){
          closeCalled=true;
          await transaction.close?.();
        },
      };
    },
  };
  await assert.rejects(()=>replayDeadLetter(faultDb,{
    eventId:1,operatorUserId:42,reasonCode:'PROVIDER_RECOVERED',
  }),/forced ambiguous commit/);
  assert.equal(transactionCount,1,'an ambiguous commit is never retried');
  assert.equal(rollbackCalled,false,'an ambiguous commit is not explicitly rolled back');
  assert.equal(closeCalled,true,'the transaction is closed after an ambiguous commit');
  const stored=await row(db);
  assert.equal(stored.status,'dead_letter');
  assert.equal(Number(stored.replay_count),0);
  assert.equal((await db.execute(
    "SELECT COUNT(*) AS count FROM outbox_audit_events WHERE action='replayed'",
  )).rows[0].count,0);
});

test('disabled email preference suppresses before provider access',async()=>{
  const {db}=await fixture();
  await db.batch([
    `INSERT INTO auth_accounts
      (id,email,password_hash,display_name,color,is_demo) VALUES
      (1,'member@example.test','hash','Member','#123456',0)`,
    `INSERT INTO circles (id,public_id,slug,name,is_primary)
      VALUES (10,'circle_outbox','outbox','Outbox',1)`,
    `INSERT INTO circle_memberships (circle_id,user_id,role,status)
      VALUES (10,1,'member','active')`,
    `INSERT INTO user_notification_prefs (user_id,email_enabled) VALUES (1,0)`,
    `INSERT INTO pairing_weeks (id,week_label,week_start,focus,is_demo)
      VALUES (10,'2026-W38','2026-09-20T07:00:00.000Z','both',0)`,
  ],'write');
  await enqueueOutboxEvent(db,{
    eventType:PAIRING_EMAIL_EVENT_TYPE,eventVersion:1,idempotencyKey:'pairing-email/v1/10/paired/1',
    payload:{week_id:10,user_id:1,kind:'paired',recipient_email:'member@example.test'},
    notBefore:START,
  });
  let sends=0;
  const handler=createPairingEmailHandler({
    db,baseUrl:'https://randori.example.test',send:async()=>{ sends+=1; },
  });
  const result=await worker(db,{[PAIRING_EMAIL_EVENT_TYPE]:handler});
  assert.equal(result.suppressed,1);
  assert.equal(sends,0);
  assert.equal((await row(db)).last_error_code,'EMAIL_DISABLED');
});

test('pairing email adapter delivers a private room link with the stable outbox key',async()=>{
  const {db}=await fixture();
  await db.batch([
    `INSERT INTO auth_accounts
      (id,email,password_hash,display_name,color,is_demo) VALUES
      (1,'one@example.test','hash','One <unsafe>','#123456',0),
      (2,'two@example.test','hash','Two','#654321',0)`,
    `INSERT INTO circles (id,public_id,slug,name,is_primary)
      VALUES (30,'circle_delivery','delivery','Delivery',1)`,
    `INSERT INTO circle_memberships (circle_id,user_id,role,status)
      VALUES (30,1,'member','active'),(30,2,'member','active')`,
    `INSERT INTO pairing_weeks (id,week_label,week_start,focus,is_demo)
      VALUES (10,'2026-W38','2026-09-20T07:00:00.000Z','both',0)`,
    `INSERT INTO pairing_groups (id,week_id,user_a_id,user_b_id,is_ai_pair)
      VALUES (20,10,1,2,0)`,
  ],'write');
  const key='randori/10/paired/2';
  await enqueueOutboxEvent(db,{
    eventType:PAIRING_EMAIL_EVENT_TYPE,eventVersion:1,idempotencyKey:key,
    payload:{week_id:10,user_id:2,kind:'paired',recipient_email:'two@example.test'},
    notBefore:START,
  });
  const messages=[];
  const handler=createPairingEmailHandler({
    db,baseUrl:'https://randori.example.test',send:async message=>{
      messages.push(message);
      return {providerName:'test-provider',providerMessageId:'provider-message'};
    },
  });
  const result=await worker(db,{[PAIRING_EMAIL_EVENT_TYPE]:handler});
  assert.equal(result.delivered,1);
  assert.equal(messages[0].idempotencyKey,key);
  assert.match(messages[0].html,/https:\/\/randori\.example\.test\/join\/week_10_pair_20/);
  assert.doesNotMatch(messages[0].html,/<unsafe>/);
  assert.match(messages[0].html,/One &lt;unsafe&gt;/);
});

test('pairing delivery suppresses revoked memberships and changed recipient addresses',async()=>{
  const {db}=await fixture();
  await db.batch([
    `INSERT INTO auth_accounts
      (id,email,password_hash,display_name,color,is_demo) VALUES
      (1,'revoked@example.test','hash','Revoked','#123456',0),
      (2,'new@example.test','hash','Changed','#654321',0)`,
    `INSERT INTO circles (id,public_id,slug,name,is_primary)
      VALUES (40,'circle_revalidation','revalidation','Revalidation',1)`,
    `INSERT INTO circle_memberships (circle_id,user_id,role,status)
      VALUES (40,1,'member','inactive'),(40,2,'member','active')`,
  ],'write');
  await enqueueOutboxEvent(db,{
    eventType:PAIRING_EMAIL_EVENT_TYPE,idempotencyKey:'randori/10/paired/1',
    payload:{week_id:10,user_id:1,kind:'paired',recipient_email:'revoked@example.test'},notBefore:START,
  });
  await enqueueOutboxEvent(db,{
    eventType:PAIRING_EMAIL_EVENT_TYPE,idempotencyKey:'randori/10/paired/2',
    payload:{week_id:10,user_id:2,kind:'paired',recipient_email:'old@example.test'},notBefore:START,
  });
  let sends=0;
  const handler=createPairingEmailHandler({
    db,baseUrl:'https://randori.example.test',send:async()=>{ sends+=1; },
  });
  const result=await worker(db,{[PAIRING_EMAIL_EVENT_TYPE]:handler});
  assert.equal(result.suppressed,2);
  assert.equal(sends,0);
  assert.deepEqual((await db.execute('SELECT last_error_code FROM outbox_events ORDER BY id')).rows.map(item=>item.last_error_code),[
    'MEMBERSHIP_REVOKED','RECIPIENT_CHANGED',
  ]);
});

test('worker timeout aborts the live Resend request before a retry is scheduled',async()=>{
  const {db}=await fixture();
  await db.batch([
    `INSERT INTO auth_accounts
      (id,email,password_hash,display_name,color,is_demo) VALUES
      (1,'one@example.test','hash','One','#123456',0),(2,'two@example.test','hash','Two','#654321',0)`,
    `INSERT INTO circles (id,public_id,slug,name,is_primary)
      VALUES (50,'circle_timeout','timeout','Timeout',1)`,
    `INSERT INTO circle_memberships (circle_id,user_id,role,status)
      VALUES (50,1,'member','active'),(50,2,'member','active')`,
    `INSERT INTO pairing_weeks (id,week_label,week_start,focus,is_demo)
      VALUES (50,'2020-W38','2020-09-20T07:00:00.000Z','both',0)`,
    `INSERT INTO pairing_groups (id,week_id,user_a_id,user_b_id,is_ai_pair)
      VALUES (50,50,1,2,0)`,
  ],'write');
  await enqueueOutboxEvent(db,{
    eventType:PAIRING_EMAIL_EVENT_TYPE,idempotencyKey:'randori/50/paired/2',
    payload:{week_id:50,user_id:2,kind:'paired',recipient_email:'two@example.test'},
    notBefore:START,deliveryTimeoutMs:100,
  });
  let observedSignal=null;
  let completedLate=false;
  const send=createResendEmailSender({
    from:'verified@example.test',
    resend:{emails:{send:(_payload,options)=>new Promise((resolve,reject)=>{
      observedSignal=options.signal;
      const timer=setTimeout(()=>{ completedLate=true; resolve({data:{id:'late'}}); },250);
      options.signal.addEventListener('abort',()=>{
        clearTimeout(timer);
        reject(options.signal.reason);
      },{once:true});
    })}},
  });
  const handler=createPairingEmailHandler({db,baseUrl:'https://randori.example.test',send});
  const result=await worker(db,{[PAIRING_EMAIL_EVENT_TYPE]:handler});
  assert.equal(result.retried,1);
  assert.equal(observedSignal?.aborted,true);
  await new Promise(resolve=>setTimeout(resolve,170));
  assert.equal(completedLate,false);
});

test('multiple workers drain real SQLite concurrently with one visible delivery per key',async()=>{
  const {clients}=await fixture(3);
  for(let sequence=1;sequence<=20;sequence+=1){
    await enqueueOutboxEvent(clients[0],event({sequence}));
  }
  const accepted=new Set();
  let visible=0;
  const handler=async current=>{
    await new Promise(resolve=>setTimeout(resolve,current.id%3));
    if(!accepted.has(current.idempotencyKey)){
      accepted.add(current.idempotencyKey);
      visible+=1;
    }
    return {providerName:'test-provider',providerMessageId:`message-${current.id}`};
  };
  const results=await Promise.all(clients.map((db,index)=>worker(db,{'test.notification':handler},{
    workerId:`worker-${index}`,batchSize:20,
  })));
  assert.equal(results.reduce((sum,item)=>sum+item.delivered,0),20);
  assert.equal(visible,20);
  assert.equal((await clients[0].execute("SELECT COUNT(*) AS count FROM outbox_events WHERE status='delivered'")).rows[0].count,20);
  const audits=await clients[0].execute("SELECT COUNT(*) AS count FROM outbox_audit_events WHERE action='delivered'");
  assert.equal(Number(audits.rows[0].count),20);
});

test('metrics expose aggregate state only and never payload or idempotency data',async()=>{
  const {db}=await fixture();
  await enqueueOutboxEvent(db,event({payload:{email:'private@example.test',token:'secret-token'}}));
  const metrics=await readOutboxMetrics(db);
  assert.deepEqual(metrics,[{
    eventType:'test.notification',eventVersion:1,status:'pending',count:1,oldestCreatedAt:metrics[0].oldestCreatedAt,
  }]);
  const serialized=JSON.stringify(metrics);
  assert.doesNotMatch(serialized,/private@example\.test|secret-token|test\/v1\/1/);
});
