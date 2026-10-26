// Route-level tests for POST /api/feedback and GET /api/feedback/mine
// through api/data.js, against a real migrated SQLite database. Only
// api/_db.js is replaced, to inject the client and a header-driven
// identity; flag, auth, circle, schema, rate-limit and handler code run
// for real.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, beforeEach, mock, test } from 'node:test';
import { createClient } from '@libsql/client';

import { applyMigrations, inspectMigrationState, prepareMigrationConnection } from '../../db/migration-runner.js';
import { EXECUTABLE_MIGRATIONS } from '../../db/executable-migrations.js';

const directory=mkdtempSync(join(tmpdir(),'randori-feedback-api-'));
const realDb=createClient({url:`file:${join(directory,'routes.sqlite')}`});
let clientOverride=null;

const IDENTITIES={
  admin:{id:1,email:'admin@example.test'},
  member:{id:2,email:'member@example.test'},
  other:{id:3,email:'other@example.test'},
  ghost:{id:99,email:'ghost@example.test'},
  anonymous:null,
};

function authFor(req){
  const identity=IDENTITIES[req?.headers?.['x-test-auth']];
  return identity?{...identity,sessionHash:'a'.repeat(64)}:null;
}

mock.module('../../api/_db.js',{
  exports:{
    JWT_AUDIENCE:'randori-web',
    JWT_ISSUER:'randori-circle',
    getClient:()=>{
      if(clientOverride instanceof Error) throw clientOverride;
      return clientOverride||realDb;
    },
    getJwtSecret:()=>'unit-test-secret-at-least-thirty-two-characters',
    getCronSecret:()=>'cron-secret',
    getAdminEmails:()=>new Set(String(process.env.ADMIN_EMAILS||'').split(',').map(value=>value.trim()).filter(Boolean)),
    deterministicColor:()=>'#123456',
    issueSession:async()=>'session',
    issueSessionInTransaction:async()=>'session',
    revokeAccountSessions:async()=>0,
    revokeRequestSession:async()=>({authenticated:false,revoked:false,userId:null}),
    isoWeekLabel:()=>'2026-W38',
    shuffleArray:values=>[...values],
    verifyRequestAuth:authFor,
    verifySignedRequestAuth:authFor,
    verifyMutationOrigin:req=>req?.headers?.['x-test-origin']!=='rejected',
    initSentry:()=>{},
    isSentryConfigured:()=>false,
    getSentry:()=>({Sentry:null,ready:false}),
    captureSentryMessage:()=>null,
    captureSentryException:()=>null,
  },
});

const [{default:dataHandler}]=await Promise.all([import('../../api/data.js')]);

function invoke(handler,{method='GET',url='/',query={},headers={},body,auth,remoteAddress='203.0.113.9'}={}){
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
    const request={method,url,query,headers:{...headers,...(auth?{'x-test-auth':auth}:{})},body,socket:{remoteAddress,encrypted:false}};
    Promise.resolve(handler(request,response)).then(()=>finish(undefined)).catch(reject);
  });
}

const ENV_KEYS=['ADMIN_EMAILS','APP_URL','CRON_SECRET','NODE_ENV','RANDORI_LOCAL_RUNTIME','SENTRY_DSN',
  'TURSO_DATABASE_URL','CIRCLE_MEMBERSHIP_ENABLED','FEEDBACK_ENABLED','RESEND_API_KEY','RESEND_FROM',
  'MULTI_CIRCLE_CONTROL_PLANE_ENABLED','MULTI_CIRCLE_AVAILABILITY_ENABLED','SECONDARY_CIRCLE_COORDINATION_ENABLED'];

function enableFeedback(){
  process.env.CIRCLE_MEMBERSHIP_ENABLED='true';
  process.env.FEEDBACK_ENABLED='true';
}

before(async()=>{
  await prepareMigrationConnection(realDb);
  const state=await inspectMigrationState(realDb);
  await applyMigrations(realDb,{expectedStateFingerprint:state.stateFingerprint,retry:{maxAttempts:1,baseDelayMs:0,maxDelayMs:0}});
  for(const [id,email,isAdmin] of [[1,'admin@example.test',1],[2,'member@example.test',0],[3,'other@example.test',0]]){
    await realDb.execute({
      sql:`INSERT INTO auth_accounts (id,email,password_hash,display_name,color,is_available,is_admin,is_demo)
        VALUES (?,?,?,?,?,1,?,0)`,
      args:[id,email,'hash',`User ${id}`,'#abcdef',isAdmin],
    });
  }
  await realDb.execute(`INSERT INTO circles (id,public_id,slug,name,is_primary,created_by,archived_at)
    VALUES (1,'circle-one','one','Circle One',1,1,NULL)`);
  await realDb.execute(`INSERT INTO circle_memberships (circle_id,user_id,role,status,invited_by)
    VALUES (1,1,'owner','active',NULL),(1,2,'member','active',1),(1,3,'member','active',1)`);
});

after(()=>{
  try{ realDb.close(); }catch{}
  rmSync(directory,{recursive:true,force:true});
});

beforeEach(()=>{
  clientOverride=null;
  for(const key of ENV_KEYS) delete process.env[key];
});

function feedbackBody(overrides={}){
  return {kind:'feedback',title:'A suggestion',body:'Please add dark mode.',
    diagnostics:null,idempotency_key:'route-key-12345678',...overrides};
}

test('flag off: both endpoints answer 404 before any authentication',async()=>{
  for(const call of [
    {method:'POST',url:'/api/feedback',body:feedbackBody()},
    {method:'GET',url:'/api/feedback/mine'},
    {method:'POST',url:'/api/feedback',body:feedbackBody(),auth:'member'},
    {method:'GET',url:'/api/feedback/mine',auth:'member'},
  ]){
    const result=await invoke(dataHandler,call);
    assert.equal(result.status,404,result.body);
    assert.deepEqual(result.body,{error:'not found'});
  }
});

test('submit: 201 stores the item, 200 replays it, and /mine lists only the caller\u2019s items',async()=>{
  enableFeedback();
  const created=await invoke(dataHandler,{method:'POST',url:'/api/feedback',auth:'member',
    body:feedbackBody({idempotency_key:'route-submit-1-12345678'})});
  assert.equal(created.status,201,JSON.stringify(created.body));
  assert.equal(created.body.ok,true);
  assert.equal(created.body.replayed,false);
  assert.equal(created.body.item.title,'A suggestion');
  assert.equal(created.body.item.status,'open');
  const replay=await invoke(dataHandler,{method:'POST',url:'/api/feedback',auth:'member',
    body:feedbackBody({idempotency_key:'route-submit-1-12345678'})});
  assert.equal(replay.status,200);
  assert.equal(replay.body.replayed,true);
  assert.equal(replay.body.item.id,created.body.item.id);
  const other=await invoke(dataHandler,{method:'POST',url:'/api/feedback',auth:'other',
    body:feedbackBody({idempotency_key:'route-submit-2-12345678',title:'Other item'})});
  assert.equal(other.status,201);
  const mine=await invoke(dataHandler,{method:'GET',url:'/api/feedback/mine',auth:'member'});
  assert.equal(mine.status,200,JSON.stringify(mine.body));
  assert.deepEqual(mine.body.items.map(item=>item.id),[created.body.item.id]);
  const otherMine=await invoke(dataHandler,{method:'GET',url:'/api/feedback/mine',auth:'other'});
  assert.deepEqual(otherMine.body.items.map(item=>item.id),[other.body.item.id]);
});

test('submit: idempotency conflict, validation, method and query errors',async()=>{
  enableFeedback();
  const first=await invoke(dataHandler,{method:'POST',url:'/api/feedback',auth:'member',
    body:feedbackBody({idempotency_key:'route-conflict-12345678'})});
  assert.equal(first.status,201);
  const conflict=await invoke(dataHandler,{method:'POST',url:'/api/feedback',auth:'member',
    body:feedbackBody({idempotency_key:'route-conflict-12345678',title:'Different'})});
  assert.equal(conflict.status,409);
  assert.equal(conflict.body.code,'feedback_idempotency_conflict');
  const invalid=await invoke(dataHandler,{method:'POST',url:'/api/feedback',auth:'member',
    body:feedbackBody({kind:'idea'})});
  assert.equal(invalid.status,400);
  assert.ok(invalid.body.fields.kind);
  const getBase=await invoke(dataHandler,{method:'GET',url:'/api/feedback',auth:'member'});
  assert.equal(getBase.status,405);
  const postMine=await invoke(dataHandler,{method:'POST',url:'/api/feedback/mine',auth:'member',body:{}});
  assert.equal(postMine.status,405);
  const badLimit=await invoke(dataHandler,{method:'GET',url:'/api/feedback/mine?limit=0',auth:'member'});
  assert.equal(badLimit.status,400);
  const badCursor=await invoke(dataHandler,{method:'GET',url:'/api/feedback/mine?cursor=nope!!',auth:'member'});
  assert.equal(badCursor.status,400);
  const badQuery=await invoke(dataHandler,{method:'GET',url:'/api/feedback/mine?surprise=1',auth:'member'});
  assert.equal(badQuery.status,400);
});

test('auth: anonymous is 401, a non-member is 403, and a member with no active circle is 403',async()=>{
  enableFeedback();
  assert.equal((await invoke(dataHandler,{method:'POST',url:'/api/feedback',body:feedbackBody()})).status,401);
  assert.equal((await invoke(dataHandler,{method:'GET',url:'/api/feedback/mine'})).status,401);
  assert.equal((await invoke(dataHandler,{method:'POST',url:'/api/feedback',auth:'ghost',body:feedbackBody()})).status,403);
  assert.equal((await invoke(dataHandler,{method:'GET',url:'/api/feedback/mine',auth:'ghost'})).status,403);
});

test('selection: a member of two circles with no selected circle gets 409',async()=>{
  enableFeedback();
  await realDb.execute(`INSERT INTO circles (id,public_id,slug,name,is_primary,created_by,archived_at)
    VALUES (2,'circle-two','two','Circle Two',0,1,NULL)`);
  await realDb.execute(`INSERT INTO circle_memberships (circle_id,user_id,role,status,invited_by)
    VALUES (2,2,'member','active',1)`);
  try{
    const result=await invoke(dataHandler,{method:'GET',url:'/api/feedback/mine',auth:'member'});
    assert.equal(result.status,409);
    assert.equal(result.body.code,'circle_selection_required');
  }finally{
    await realDb.execute(`DELETE FROM circle_memberships WHERE circle_id=2 AND user_id=2`);
    await realDb.execute(`DELETE FROM circles WHERE id=2`);
  }
});

test('rate limit: the 11th submission in an hour is 429 with Retry-After',async()=>{
  enableFeedback();
  // The member already submitted a few items in earlier tests on this
  // shared database, so use the fresh 'other' identity's budget: route
  // tests share one database, and the limiter counts real attempts.
  // Reset the counters for a deterministic window instead.
  await realDb.execute(`DELETE FROM auth_rate_limits`);
  for(let n=0;n<10;n+=1){
    const result=await invoke(dataHandler,{method:'POST',url:'/api/feedback',auth:'other',remoteAddress:'198.51.100.77',
      body:feedbackBody({idempotency_key:`route-rate-${n}-12345678`})});
    assert.equal(result.status,201,JSON.stringify(result.body));
  }
  const blocked=await invoke(dataHandler,{method:'POST',url:'/api/feedback',auth:'other',remoteAddress:'198.51.100.77',
    body:feedbackBody({idempotency_key:'route-rate-10-12345678'})});
  assert.equal(blocked.status,429);
  assert.equal(blocked.body.retry_after_seconds>0,true);
  assert.equal(blocked.headers['retry-after'],String(blocked.body.retry_after_seconds));
  await realDb.execute(`DELETE FROM auth_rate_limits`);
});

test('schema pending: a v21 database answers 404 while the code is at v22',async()=>{
  enableFeedback();
  const v21Directory=mkdtempSync(join(tmpdir(),'randori-feedback-v21-'));
  const v21Db=createClient({url:`file:${join(v21Directory,'v21.sqlite')}`});
  try{
    await prepareMigrationConnection(v21Db);
    const state=await inspectMigrationState(v21Db,{migrations:EXECUTABLE_MIGRATIONS.slice(0,21)});
    await applyMigrations(v21Db,{migrations:EXECUTABLE_MIGRATIONS.slice(0,21),
      expectedStateFingerprint:state.stateFingerprint,retry:{maxAttempts:1,baseDelayMs:0,maxDelayMs:0}});
    await v21Db.execute(`INSERT INTO auth_accounts (id,email,password_hash,display_name,color,is_available,is_admin,is_demo)
      VALUES (2,'member@example.test','hash','Member','#abcdef',1,0,0)`);
    await v21Db.execute(`INSERT INTO circles (id,public_id,slug,name,is_primary,created_by,archived_at)
      VALUES (1,'circle-one','one','Circle One',1,2,NULL)`);
    await v21Db.execute(`INSERT INTO circle_memberships (circle_id,user_id,role,status,invited_by)
      VALUES (1,2,'member','active',NULL)`);
    clientOverride=v21Db;
    const result=await invoke(dataHandler,{method:'GET',url:'/api/feedback/mine',auth:'member'});
    assert.equal(result.status,404,JSON.stringify(result.body));
    assert.deepEqual(result.body,{error:'not found'});
    const submit=await invoke(dataHandler,{method:'POST',url:'/api/feedback',auth:'member',body:feedbackBody()});
    assert.equal(submit.status,404);
  }finally{
    clientOverride=null;
    v21Db.close();
    rmSync(v21Directory,{recursive:true,force:true});
  }
});

test('rate limit: an exact replay never consumes budget — the 11th replay succeeds after 10 submissions',async()=>{
  enableFeedback();
  await realDb.execute(`DELETE FROM auth_rate_limits`);
  const key='route-replay-rate-12345678';
  try{
    const first=await invoke(dataHandler,{method:'POST',url:'/api/feedback',auth:'other',
      remoteAddress:'198.51.100.88',body:feedbackBody({idempotency_key:key})});
    assert.equal(first.status,201,JSON.stringify(first.body));
    for(let n=0;n<9;n+=1){
      const result=await invoke(dataHandler,{method:'POST',url:'/api/feedback',auth:'other',
        remoteAddress:'198.51.100.88',body:feedbackBody({idempotency_key:`route-replay-rate-${n}-12345678`})});
      assert.equal(result.status,201,JSON.stringify(result.body));
    }
    const blocked=await invoke(dataHandler,{method:'POST',url:'/api/feedback',auth:'other',
      remoteAddress:'198.51.100.88',body:feedbackBody({idempotency_key:'route-replay-blocked-12345678'})});
    assert.equal(blocked.status,429);
    // A same-key, different-content submission is a 409 even with the budget spent.
    const conflict=await invoke(dataHandler,{method:'POST',url:'/api/feedback',auth:'other',
      remoteAddress:'198.51.100.88',body:feedbackBody({idempotency_key:key,title:'Different'})});
    assert.equal(conflict.status,409);
    // And the 11th exact replay still succeeds: replays never burn budget.
    const replay=await invoke(dataHandler,{method:'POST',url:'/api/feedback',auth:'other',
      remoteAddress:'198.51.100.88',body:feedbackBody({idempotency_key:key})});
    assert.equal(replay.status,200,JSON.stringify(replay.body));
    assert.equal(replay.body.replayed,true);
    assert.equal(replay.body.item.id,first.body.item.id);
  }finally{
    await realDb.execute(`DELETE FROM auth_rate_limits`);
  }
});

test('/mine: returns only the active circle’s items',async()=>{
  enableFeedback();
  await realDb.execute(`INSERT INTO auth_sessions (session_hash,user_id,created_at,expires_at)
    VALUES (?,?,?,?)`,['a'.repeat(64),2,1,4102444800]);
  await realDb.execute(`INSERT INTO auth_session_circle_contexts (session_hash,user_id,circle_id,context_version,updated_at)
    VALUES (?,?,?,?,?)`,['a'.repeat(64),2,1,1,1]);
  await realDb.execute(`INSERT INTO circles (id,public_id,slug,name,is_primary,created_by,archived_at)
    VALUES (3,'circle-three','three','Circle Three',0,1,NULL)`);
  await realDb.execute(`INSERT INTO circle_memberships (circle_id,user_id,role,status,invited_by)
    VALUES (3,2,'member','active',1)`);
  const otherCircleId='33333333-3333-4333-8333-333333333333';
  const now=Math.floor(Date.now()/1000);
  await realDb.execute({sql:`INSERT INTO feedback_items
      (id,circle_id,author_user_id,kind,title,body,status,visibility,diagnostics_json,
       idempotency_key,created_at,updated_at,closed_at)
      VALUES (?,?,?,?,?,?,'open','private',NULL,?,?,?,NULL)`,
    args:[otherCircleId,3,2,'feedback','Other circle item','From the other circle.','other-circle-key-12345678',now,now]});
  try{
    const created=await invoke(dataHandler,{method:'POST',url:'/api/feedback',auth:'member',
      body:feedbackBody({idempotency_key:'route-mine-circle-12345678'})});
    assert.equal(created.status,201,JSON.stringify(created.body));
    assert.equal(created.body.item.circle_id,1);
    const mine=await invoke(dataHandler,{method:'GET',url:'/api/feedback/mine',auth:'member'});
    assert.equal(mine.status,200,JSON.stringify(mine.body));
    assert.ok(mine.body.items.some(item=>item.id===created.body.item.id));
    assert.ok(mine.body.items.every(item=>item.circle_id===1));
    assert.ok(!mine.body.items.some(item=>item.id===otherCircleId));
  }finally{
    await realDb.execute(`DELETE FROM feedback_items WHERE id=?`,[otherCircleId]);
    await realDb.execute(`DELETE FROM feedback_items WHERE idempotency_key='route-mine-circle-12345678'`);
    await realDb.execute(`DELETE FROM circle_memberships WHERE circle_id=3 AND user_id=2`);
    await realDb.execute(`DELETE FROM circles WHERE id=3`);
    await realDb.execute(`DELETE FROM auth_session_circle_contexts WHERE session_hash=?`,['a'.repeat(64)]);
    await realDb.execute(`DELETE FROM auth_sessions WHERE session_hash=?`,['a'.repeat(64)]);
  }
});

test('route: an unmatched feedback path is 404',async()=>{
  enableFeedback();
  for(const call of [
    {method:'GET',url:'/api/feedback/extra',auth:'member'},
    {method:'POST',url:'/api/feedback/extra',auth:'member',body:feedbackBody()},
  ]){
    const result=await invoke(dataHandler,call);
    assert.equal(result.status,404,JSON.stringify(result.body));
    assert.deepEqual(result.body,{error:'not found'});
  }
});

test('route: rate-limit storage failure is 503, not a silent pass',async()=>{
  enableFeedback();
  const failing={execute:async(statement,...rest)=>{
    const sql=typeof statement==='string'?statement:statement?.sql||'';
    if(sql.includes('INSERT INTO auth_rate_limits')) throw new Error('rate limit storage down');
    return realDb.execute(statement,...rest);
  },
  batch:(...args)=>realDb.batch(...args),
  transaction:(...args)=>realDb.transaction(...args)};
  clientOverride=failing;
  try{
    const result=await invoke(dataHandler,{method:'POST',url:'/api/feedback',auth:'member',
      body:feedbackBody({idempotency_key:'route-rate-fail-12345678'})});
    assert.equal(result.status,503,JSON.stringify(result.body));
  }finally{
    clientOverride=null;
    await realDb.execute(`DELETE FROM auth_rate_limits`);
  }
});

test('route: submit storage failure is 503',async()=>{
  enableFeedback();
  const failing={execute:(...args)=>realDb.execute(...args),
    batch:(...args)=>realDb.batch(...args),
    transaction:async(...args)=>{
      const transaction=await realDb.transaction(...args);
      const realExecute=transaction.execute.bind(transaction);
      transaction.execute=async(statement,...rest)=>{
        const sql=typeof statement==='string'?statement:statement?.sql||'';
        if(sql.includes('INSERT INTO feedback_items')) throw new Error('feedback storage down');
        return realExecute(statement,...rest);
      };
      return transaction;
    }};
  clientOverride=failing;
  try{
    const result=await invoke(dataHandler,{method:'POST',url:'/api/feedback',auth:'member',
      body:feedbackBody({idempotency_key:'route-submit-fail-12345678'})});
    assert.equal(result.status,503,JSON.stringify(result.body));
  }finally{
    clientOverride=null;
    await realDb.execute(`DELETE FROM auth_rate_limits`);
    await realDb.execute(`DELETE FROM feedback_items WHERE idempotency_key='route-submit-fail-12345678'`);
  }
});

test('route: /mine storage failure is 503',async()=>{
  enableFeedback();
  const failing={execute:async(statement,...rest)=>{
    const sql=typeof statement==='string'?statement:statement?.sql||'';
    if(sql.includes('FROM feedback_items item')) throw new Error('feedback list storage down');
    return realDb.execute(statement,...rest);
  },
  batch:(...args)=>realDb.batch(...args),
  transaction:(...args)=>realDb.transaction(...args)};
  clientOverride=failing;
  try{
    const result=await invoke(dataHandler,{method:'GET',url:'/api/feedback/mine',auth:'member'});
    assert.equal(result.status,503,JSON.stringify(result.body));
  }finally{
    clientOverride=null;
  }
});

test('route: a post-redaction oversize body is 400 from the replay lookup',async()=>{
  enableFeedback();
  const body='Bearer a '.repeat(500).slice(0,4000);
  assert.equal(body.length,4000);
  const result=await invoke(dataHandler,{method:'POST',url:'/api/feedback',auth:'member',
    body:feedbackBody({body,idempotency_key:'route-redact-400-12345678'})});
  assert.equal(result.status,400,JSON.stringify(result.body));
  await realDb.execute(`DELETE FROM auth_rate_limits`);
});

test('route: replay lookup storage failure is 503',async()=>{
  enableFeedback();
  const failing={execute:async(statement,...rest)=>{
    const sql=typeof statement==='string'?statement:statement?.sql||'';
    if(sql.includes('FROM feedback_items WHERE author_user_id=? AND idempotency_key=?')) throw new Error('replay lookup down');
    return realDb.execute(statement,...rest);
  },
  batch:(...args)=>realDb.batch(...args),
  transaction:(...args)=>realDb.transaction(...args)};
  clientOverride=failing;
  try{
    const result=await invoke(dataHandler,{method:'POST',url:'/api/feedback',auth:'member',
      body:feedbackBody({idempotency_key:'route-lookup-fail-12345678'})});
    assert.equal(result.status,503,JSON.stringify(result.body));
  }finally{
    clientOverride=null;
  }
});

test('route: feedback readiness failure is 503',async()=>{
  enableFeedback();
  const failing={execute:async(statement,...rest)=>{
    const sql=typeof statement==='string'?statement:statement?.sql||'';
    if(sql.includes('FROM feedback_items LIMIT 0')) throw new Error('readiness probe down');
    return realDb.execute(statement,...rest);
  },
  batch:(...args)=>realDb.batch(...args),
  transaction:(...args)=>realDb.transaction(...args)};
  clientOverride=failing;
  try{
    assert.equal((await invoke(dataHandler,{method:'GET',url:'/api/feedback/mine',auth:'member'})).status,503);
    assert.equal((await invoke(dataHandler,{method:'POST',url:'/api/feedback',auth:'member',
      body:feedbackBody()})).status,503);
  }finally{
    clientOverride=null;
  }
});
