// Cron credential scoping and the aggregate-only outbox delivery-health route,
// exercised through api/ops.js against a real, fully migrated SQLite database.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, afterEach, before, beforeEach, mock, test } from 'node:test';
import { createClient } from '@libsql/client';

import { applyMigrations, inspectMigrationState, prepareMigrationConnection } from '../../db/migration-runner.js';

const directory=mkdtempSync(join(tmpdir(),'randori-outbox-health-'));
const realDb=createClient({url:`file:${join(directory,'health.sqlite')}`});
let clientOverride=null;

mock.module('../../api/_db.js',{
  exports:{
    JWT_AUDIENCE:'randori-web',
    JWT_ISSUER:'randori-circle',
    getClient:()=>{
      if(clientOverride instanceof Error) throw clientOverride;
      return clientOverride||realDb;
    },
    getJwtSecret:()=>'unit-test-secret-at-least-thirty-two-characters',
    getCronSecret:()=>{
      if(!process.env.CRON_SECRET) throw new Error('Missing CRON_SECRET');
      return process.env.CRON_SECRET;
    },
    getAdminEmails:()=>new Set(),
    deterministicColor:()=>'#123456',
    issueSession:async()=>'session',
    issueSessionInTransaction:async()=>'session',
    revokeAccountSessions:async()=>0,
    revokeRequestSession:async()=>({authenticated:false,revoked:false,userId:null}),
    isoWeekLabel:()=>'2026-W38',
    shuffleArray:values=>[...values],
    verifyRequestAuth:()=>null,
    verifySignedRequestAuth:()=>null,
    verifyMutationOrigin:()=>true,
    initSentry:()=>{},
    isSentryConfigured:()=>false,
    getSentry:()=>({Sentry:null,ready:false}),
    captureSentryMessage:()=>null,
    captureSentryException:()=>null,
  },
});

const [{default:opsHandler,createOpsHandler,outboxDispatchSecret,OUTBOX_DISPATCH_SECRET_MIN_LENGTH},
  {readOutboxDeliveryHealth,OUTBOX_HEALTH_DEAD_LETTER_WINDOW_MS}]=await Promise.all([
  import('../../api/ops.js'),
  import('../../api/_outbox-health.js'),
]);

const CRON='cron-secret-value-for-health-tests-0001';
const OUTBOX='outbox-dispatch-secret-value-for-tests-0002';
const ENV_KEYS=['CRON_SECRET','OUTBOX_DISPATCH_SECRET','APP_URL','TURSO_DATABASE_URL'];
const savedEnv=Object.fromEntries(ENV_KEYS.map(key=>[key,process.env[key]]));

function invoke(handler,{method='GET',url='/',query={},headers={}}={}){
  return new Promise((resolve,reject)=>{
    let statusCode=200;
    let settled=false;
    const responseHeaders={};
    const finish=payload=>{
      if(settled) return;
      settled=true;
      resolve({status:statusCode,headers:responseHeaders,body:payload});
    };
    const response={
      status(code){ statusCode=code; return this; },
      json(payload){ finish(payload); return this; },
      setHeader(name,value){ responseHeaders[String(name).toLowerCase()]=value; },
      getHeader(name){ return responseHeaders[String(name).toLowerCase()]; },
      end(payload){ finish(payload); },
    };
    const request={method,url,query,headers,body:undefined,socket:{remoteAddress:'203.0.113.9'}};
    Promise.resolve(handler(request,response)).then(()=>finish(undefined)).catch(reject);
  });
}

const iso=offsetMs=>new Date(Date.now()+offsetMs).toISOString();
let sequence=0;
async function insertEvent({status='pending',notBefore=iso(-1000),nextAttemptAt=notBefore,
  leasedUntil=null,deliveredAt=null,deadLetteredAt=null}={}){
  sequence+=1;
  const leased=status==='processing';
  const inserted=await realDb.execute({
    sql:`INSERT INTO outbox_events (event_type,event_version,idempotency_key,payload_json,status,
      not_before,next_attempt_at,lease_owner,lease_token,leased_until,delivered_at,dead_lettered_at)
      VALUES ('health.test',1,?,?,?,?,?,?,?,?,?,?)`,
    args:[`health-key-${sequence}-private`,JSON.stringify({email:`person${sequence}@example.test`}),status,
      notBefore,nextAttemptAt,leased?'worker':null,leased?`token-${sequence}`:null,leased?leasedUntil:null,
      deliveredAt,deadLetteredAt],
  });
  return Number(inserted.lastInsertRowid);
}

async function insertAudit(eventId,{action='dead_lettered',reasonCode,toStatus='dead_letter'}){
  await realDb.execute({
    sql:`INSERT INTO outbox_audit_events
      (outbox_event_id,action,actor_type,actor_ref,from_status,to_status,reason_code,attempt_number)
      VALUES (?,?,'worker','worker-1','processing',?,?,1)`,
    args:[eventId,action,toStatus,reasonCode],
  });
}

before(async()=>{
  await prepareMigrationConnection(realDb);
  const state=await inspectMigrationState(realDb);
  await applyMigrations(realDb,{expectedStateFingerprint:state.stateFingerprint,
    retry:{maxAttempts:1,baseDelayMs:0,maxDelayMs:0}});
});

beforeEach(async()=>{
  clientOverride=null;
  for(const key of ENV_KEYS) delete process.env[key];
  process.env.CRON_SECRET=CRON;
  process.env.OUTBOX_DISPATCH_SECRET=OUTBOX;
  await realDb.execute('DELETE FROM outbox_audit_events');
  await realDb.execute('DELETE FROM outbox_events');
});

afterEach(()=>{
  for(const [key,value] of Object.entries(savedEnv)){
    if(value===undefined) delete process.env[key]; else process.env[key]=value;
  }
});

after(()=>{
  realDb.close();
  rmSync(directory,{recursive:true,force:true});
});

test('the outbox dispatch secret is ignored unless long enough and distinct from CRON_SECRET',()=>{
  assert.equal(OUTBOX_DISPATCH_SECRET_MIN_LENGTH,32);
  assert.equal(outboxDispatchSecret(CRON),OUTBOX);
  process.env.OUTBOX_DISPATCH_SECRET='x'.repeat(31);
  assert.equal(outboxDispatchSecret(CRON),null);
  process.env.OUTBOX_DISPATCH_SECRET=CRON;
  assert.equal(outboxDispatchSecret(CRON),null);
  delete process.env.OUTBOX_DISPATCH_SECRET;
  assert.equal(outboxDispatchSecret(CRON),null);
  process.env.OUTBOX_DISPATCH_SECRET=OUTBOX;
  assert.equal(outboxDispatchSecret(null),OUTBOX);
});

test('/api/cron/outbox accepts either secret in both header forms',async()=>{
  // Without APP_URL the worker answers 503 only after authentication succeeds.
  for(const headers of [
    {'x-cron-secret':CRON},{authorization:`Bearer ${CRON}`},
    {'x-cron-secret':OUTBOX},{authorization:`Bearer ${OUTBOX}`},
  ]){
    const result=await invoke(opsHandler,{method:'POST',url:'/api/cron/outbox',headers});
    assert.equal(result.status,503,JSON.stringify(headers));
    assert.deepEqual(result.body,{error:'outbox unavailable'});
  }
  assert.equal((await invoke(opsHandler,{method:'POST',url:'/api/cron/outbox',
    headers:{authorization:`Bearer ${OUTBOX}x`}})).status,401);
  process.env.APP_URL='https://randori.example.test';
  const drained=await invoke(opsHandler,{method:'POST',url:'/api/cron/outbox',
    headers:{authorization:`Bearer ${OUTBOX}`}});
  assert.equal(drained.status,200,JSON.stringify(drained.body));
  assert.equal(drained.body.ok,true);
});

test('a short or CRON-equal outbox secret is ignored while CRON_SECRET keeps working',async()=>{
  for(const ignored of ['short-outbox-secret',CRON]){
    process.env.OUTBOX_DISPATCH_SECRET=ignored;
    if(ignored!==CRON){
      assert.equal((await invoke(opsHandler,{method:'POST',url:'/api/cron/outbox',
        headers:{authorization:`Bearer ${ignored}`}})).status,401);
      assert.equal((await invoke(opsHandler,{url:'/api/cron/outbox-health',
        headers:{'x-cron-secret':ignored}})).status,401);
    }
    assert.equal((await invoke(opsHandler,{method:'POST',url:'/api/cron/outbox',
      headers:{'x-cron-secret':CRON}})).status,503);
  }
  // The outbox secret alone still authorizes outbox routes if CRON_SECRET is unset.
  delete process.env.CRON_SECRET;
  process.env.OUTBOX_DISPATCH_SECRET=OUTBOX;
  assert.equal((await invoke(opsHandler,{url:'/api/cron/outbox-health',
    headers:{'x-cron-secret':OUTBOX}})).status,200);
  assert.equal((await invoke(opsHandler,{url:'/api/cron/outbox-health',
    headers:{'x-cron-secret':CRON}})).status,401);
});

test('weekly and other cron routes reject the outbox secret',async()=>{
  const weekly=createOpsHandler({isWeeklyDue:()=>false});
  for(const [url,query] of [
    ['/api/cron/weekly',{endpoint:'weekly'}],['/api/cron/weekly',{}],['/api/cron/other',{}],
  ]){
    for(const headers of [{'x-cron-secret':OUTBOX},{authorization:`Bearer ${OUTBOX}`}]){
      const denied=await invoke(weekly,{url,query,headers});
      assert.equal(denied.status,401,`${url} ${JSON.stringify(headers)}`);
    }
    const allowed=await invoke(weekly,{url,query,headers:{'x-cron-secret':CRON}});
    assert.equal(allowed.status,200,url);
    assert.equal(allowed.body.skipped,true);
  }
});

test('/api/cron/outbox-health is GET-only, authenticated, uncached and aggregate-only',async()=>{
  const wrongMethod=await invoke(opsHandler,{method:'POST',url:'/api/cron/outbox-health',
    headers:{'x-cron-secret':CRON}});
  assert.equal(wrongMethod.status,405);
  assert.equal(wrongMethod.headers['cache-control'],'no-store');
  assert.equal((await invoke(opsHandler,{url:'/api/cron/outbox-health'})).status,401);
  assert.equal((await invoke(opsHandler,{url:'/api/cron/outbox-health',
    headers:{authorization:'Bearer nope'}})).status,401);

  const empty=await invoke(opsHandler,{url:'/api/cron/outbox-health',headers:{authorization:`Bearer ${CRON}`}});
  assert.equal(empty.status,200);
  assert.deepEqual({...empty.body,checkedAt:'x'},{
    ok:true,checkedAt:'x',oldestDueAgeMs:null,dueCount:0,processingStaleCount:0,
    oldestStaleLeaseAgeMs:null,deadLetterCount:0,deadLetterWindowMs:OUTBOX_HEALTH_DEAD_LETTER_WINDOW_MS,
    lastDeliveredAt:null,recentRejectReasons:{},
  });
  assert.ok(Math.abs(Date.parse(empty.body.checkedAt)-Date.now())<60_000);

  await insertEvent({notBefore:iso(-20*60_000)});
  await insertEvent({status:'retry',notBefore:iso(-60*60_000),nextAttemptAt:iso(-5*60_000)});
  await insertEvent({notBefore:iso(60*60_000)});
  await insertEvent({status:'retry',notBefore:iso(-60*60_000),nextAttemptAt:iso(60*60_000)});
  await insertEvent({status:'processing',leasedUntil:iso(-30*60_000)});
  await insertEvent({status:'processing',leasedUntil:iso(60_000)});
  await insertEvent({status:'dead_letter',deadLetteredAt:iso(-60*60_000)});
  await insertEvent({status:'dead_letter',deadLetteredAt:iso(-48*60*60_000)});
  const deliveredAt=iso(-2*60_000);
  await insertEvent({status:'delivered',deliveredAt:iso(-90*60_000)});
  await insertEvent({status:'delivered',deliveredAt});

  const health=await invoke(opsHandler,{url:'/api/ops',query:{endpoint:'outbox-health'},
    headers:{'x-cron-secret':OUTBOX}});
  assert.equal(health.status,200);
  assert.equal(health.body.dueCount,2);
  assert.ok(health.body.oldestDueAgeMs>=20*60_000&&health.body.oldestDueAgeMs<25*60_000,
    String(health.body.oldestDueAgeMs));
  assert.equal(health.body.processingStaleCount,1);
  assert.ok(health.body.oldestStaleLeaseAgeMs>=30*60_000&&health.body.oldestStaleLeaseAgeMs<35*60_000);
  assert.equal(health.body.deadLetterCount,1);
  assert.equal(health.body.lastDeliveredAt,deliveredAt);
  assert.deepEqual(Object.keys(health.body).sort(),['checkedAt','deadLetterCount','deadLetterWindowMs',
    'dueCount','lastDeliveredAt','ok','oldestDueAgeMs','oldestStaleLeaseAgeMs','processingStaleCount',
    'recentRejectReasons']);
  assert.doesNotMatch(JSON.stringify(health.body),/health-key|example\.test|token-|worker/);
});

test('outbox health aggregates recent dead-letter provider reject reasons without row details',async()=>{
  const recent=iso(-60*60_000);
  // The 2026-10-20 incident shape: invitation emails rejected on attempt 1.
  for(let index=0;index<9;index+=1){
    const id=await insertEvent({status:'dead_letter',deadLetteredAt:recent});
    await insertAudit(id,{reasonCode:'403:validation_error:domain_not_verified'});
  }
  const testing=await insertEvent({status:'dead_letter',deadLetteredAt:recent});
  await insertAudit(testing,{reasonCode:'403:validation_error:testing_recipient_restricted'});
  // Only the latest dead_lettered audit row of a replayed event counts.
  const replayed=await insertEvent({status:'dead_letter',deadLetteredAt:recent});
  await insertAudit(replayed,{reasonCode:'422:missing_required_field:missing_required_field'});
  await insertAudit(replayed,{action:'replayed',reasonCode:'OPERATOR_FIXED',toStatus:'pending'});
  await insertAudit(replayed,{reasonCode:'403:validation_error:testing_recipient_restricted'});
  // Unknown reasons, legacy error codes, old and non-dead-letter rows are ignored.
  const unknown=await insertEvent({status:'dead_letter',deadLetteredAt:recent});
  await insertAudit(unknown,{reasonCode:'403:validation_error:not_a_reason'});
  const legacy=await insertEvent({status:'dead_letter',deadLetteredAt:recent});
  await insertAudit(legacy,{reasonCode:'PROVIDER_REJECTED'});
  const old=await insertEvent({status:'dead_letter',deadLetteredAt:iso(-48*60*60_000)});
  await insertAudit(old,{reasonCode:'403:validation_error:domain_not_verified'});
  const retrying=await insertEvent({status:'retry',notBefore:iso(-60_000),nextAttemptAt:iso(60*60_000)});
  await insertAudit(retrying,{action:'retry_scheduled',toStatus:'retry',
    reasonCode:'429:rate_limit_exceeded:rate_limited'});
  const other=await insertEvent({status:'dead_letter',deadLetteredAt:recent});
  await insertAudit(other,{reasonCode:'401:other:other'});

  const health=await invoke(opsHandler,{url:'/api/cron/outbox-health',headers:{'x-cron-secret':CRON}});
  assert.equal(health.status,200,JSON.stringify(health.body));
  assert.equal(health.body.deadLetterCount,14);
  assert.deepEqual(health.body.recentRejectReasons,{
    testing_recipient_restricted:2,domain_not_verified:9,other:1,
  });
  assert.deepEqual(Object.keys(health.body.recentRejectReasons),
    ['testing_recipient_restricted','domain_not_verified','other']);
  assert.doesNotMatch(JSON.stringify(health.body),/example\.test|health-key|validation_error|403/);
});

test('outbox health fails closed when the database is unavailable or returns nonsense',async()=>{
  const headers={'x-cron-secret':CRON};
  clientOverride=new Error('no database');
  const noClient=await invoke(opsHandler,{url:'/api/cron/outbox-health',headers});
  assert.equal(noClient.status,503);
  assert.deepEqual(noClient.body,{ok:false,error:'outbox health unavailable'});
  for(const rows of [[],[{now_utc:'not a time'}],[{now_utc:'2026-10-19T00:00:00.000Z',due_count:-1}],
    [{now_utc:'2026-10-19T00:00:00.000Z',due_count:0,last_delivered_at:'garbage'}],
    [{now_utc:'2026-10-19T00:00:00.000Z',due_count:0,reject_reasons_json:'not json'}],
    [{now_utc:'2026-10-19T00:00:00.000Z',due_count:0,reject_reasons_json:'[1]'}],
    [{now_utc:'2026-10-19T00:00:00.000Z',due_count:0,reject_reasons_json:'{"403:other:other":-1}'}]]){
    clientOverride={execute:async()=>({rows})};
    assert.equal((await invoke(opsHandler,{url:'/api/cron/outbox-health',headers})).status,503,JSON.stringify(rows));
  }
  clientOverride={execute:async()=>{ throw new Error('SQL failure'); }};
  assert.equal((await invoke(opsHandler,{url:'/api/cron/outbox-health',headers})).status,503);
  await assert.rejects(readOutboxDeliveryHealth(null),TypeError);
  const future=await readOutboxDeliveryHealth({execute:async()=>({rows:[{now_utc:'2026-10-19T00:00:00.000Z',
    due_count:1,oldest_due_at:'2026-10-19T00:00:05.000Z',processing_stale_count:null,dead_letter_count:0}]})});
  assert.equal(future.oldestDueAgeMs,0);
  assert.equal(future.processingStaleCount,0);
});
