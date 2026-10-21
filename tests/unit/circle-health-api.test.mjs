// Issue #292 route wiring: GET /api/circle/health through the grouped ops
// handler, against a real migrated database with the real active-circle and
// membership modules. Only api/_db.js (client and identity) is replaced.
import assert from 'node:assert/strict';
import { after, before, beforeEach, mock, test } from 'node:test';
import { createClient } from '@libsql/client';

import { prepareMigrationConnection } from '../../db/migration-runner.js';
import { insertPrimaryWeek, insertSecondaryPublication } from '../support/circle-health-fixture.mjs';
import { createMigratedDatabase } from '../support/migrated-db.mjs';

const { url, cleanup }=await createMigratedDatabase({ prefix:'randori-circle-health-api-', filename:'api.sqlite' });
const realDb=createClient({ url });
let clientOverride=null;

const SESSIONS={ 1:'a'.repeat(64),2:'b'.repeat(64),3:'c'.repeat(64),4:'d'.repeat(64),6:'e'.repeat(64) };
function authFor(req){
  const id=Number(req?.headers?.['x-test-user']);
  return SESSIONS[id]?{ id,email:`user${id}@example.test`,sessionHash:SESSIONS[id] }:null;
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
    getCronSecret:()=>process.env.CRON_SECRET,
    getAdminEmails:()=>new Set(),
    deterministicColor:()=>'#123456',
    issueSession:async()=>'session',
    issueSessionInTransaction:async()=>'session',
    revokeAccountSessions:async()=>0,
    revokeRequestSession:async()=>({ authenticated:false,revoked:false,userId:null }),
    isoWeekLabel:()=>'2026-W43',
    shuffleArray:values=>[...values],
    verifyRequestAuth:authFor,
    verifySignedRequestAuth:authFor,
    verifyMutationOrigin:()=>true,
    initSentry:()=>{},
    isSentryConfigured:()=>false,
    getSentry:()=>({ Sentry:null,ready:false }),
    captureSentryMessage:()=>null,
    captureSentryException:()=>null,
  },
});

const { default:opsHandler }=await import('../../api/ops.js');

function invoke({ method='GET',user,contextVersion,url:path='/api/circle/health',query={ endpoint:'circle-health' } }={}){
  const headers={};
  if(user!==undefined) headers['x-test-user']=String(user);
  if(contextVersion!==undefined) headers['x-randori-circle-context-version']=String(contextVersion);
  return new Promise((resolve,reject)=>{
    let statusCode=200;
    const responseHeaders={};
    const response={
      status(code){ statusCode=code; return this; },
      json(payload){ resolve({ status:statusCode,body:payload,headers:responseHeaders }); return this; },
      setHeader(name,value){ responseHeaders[String(name).toLowerCase()]=value; },
      end(payload){ resolve({ status:statusCode,body:payload,headers:responseHeaders }); },
    };
    Promise.resolve(opsHandler({ method,url:path,query,headers,socket:{ remoteAddress:'203.0.113.9' } },response))
      .catch(reject);
  });
}

const ENV_KEYS=['CIRCLE_HEALTH_ENABLED','CIRCLE_MEMBERSHIP_ENABLED','MULTI_CIRCLE_CONTROL_PLANE_ENABLED',
  'MULTI_CIRCLE_AVAILABILITY_ENABLED','SECONDARY_CIRCLE_COORDINATION_ENABLED','PAIRING_TIME_ZONE'];
const previous=Object.fromEntries(ENV_KEYS.map(key=>[key,process.env[key]]));

function week(offset){
  const start=Date.now()-(offset+1)*7*86400000;
  const date=new Date(start);
  return { weekStart:date.toISOString(),publishedAt:new Date(start+1000).toISOString(),
    label:`2025-W${String(40-offset).padStart(2,'0')}` };
}

before(async()=>{
  await prepareMigrationConnection(realDb);
  const accounts=[1,2,3,4,5,6,...Array.from({ length:8 },(_,index)=>101+index)];
  const nowSeconds=Math.floor(Date.now()/1000);
  await realDb.batch([
    `INSERT INTO auth_accounts (id,email,password_hash,display_name,color) VALUES ${accounts
      .map(id=>`(${id},'user${id}@example.test','x','User ${id}','#123456')`).join(',')}`,
    `INSERT INTO circles (id,public_id,slug,name,is_primary,created_by,archived_at) VALUES
      (10,'circle-primary','primary','Primary',1,1,NULL),
      (20,'circle-second','second','Second',0,6,NULL),
      (30,'circle-archived','archived','Archived',0,1,'2026-10-01T00:00:00.000Z')`,
    `INSERT INTO circle_memberships (circle_id,user_id,role,status) VALUES
      (10,1,'owner','active'),(10,2,'member','active'),(10,3,'owner','active'),(10,4,'member','active'),
      (10,5,'owner','inactive'),(20,6,'owner','active'),(20,1,'member','active'),(30,1,'owner','active')`,
    ...Object.entries(SESSIONS).map(([userId,hash])=>({
      sql:`INSERT INTO auth_sessions (session_hash,user_id,created_at,expires_at) VALUES (?,?,?,?)`,
      args:[hash,Number(userId),nowSeconds-60,nowSeconds+3600],
    })),
  ],'write');
  await insertPrimaryWeek(realDb,{ ...week(0),participants:[101,102,103,104],groups:[
    { members:[101,102],agreed:new Date(Date.now()-6*86400000).toISOString(),receipts:[101,102] },
    { members:[103,104],agreed:new Date(Date.now()-5*86400000).toISOString(),receipts:[103,104] },
  ] });
  await insertPrimaryWeek(realDb,{ ...week(1),participants:[101,102],groups:[{ members:[101,102] }] });
  await insertSecondaryPublication(realDb,{ circleId:20,cycleId:'2025-W40',startsAt:'2025-09-28T07:00:00.000Z',
    publishedAt:'2025-09-28T07:00:01.000Z',groups:[{ members:[105,106] },{ members:[107,108] }] });
});

after(()=>{
  realDb.close();
  cleanup();
  for(const [key,value] of Object.entries(previous)){
    if(value===undefined) delete process.env[key]; else process.env[key]=value;
  }
});

beforeEach(async()=>{
  clientOverride=null;
  for(const key of ENV_KEYS) delete process.env[key];
  Object.assign(process.env,{ CIRCLE_HEALTH_ENABLED:'true',CIRCLE_MEMBERSHIP_ENABLED:'true' });
  await realDb.execute('DELETE FROM auth_session_circle_contexts');
});

function multiCircle(){
  Object.assign(process.env,{ MULTI_CIRCLE_CONTROL_PLANE_ENABLED:'true' });
}

async function selectCircle(userId,circleId,version){
  await realDb.execute({
    sql:`INSERT INTO auth_session_circle_contexts (session_hash,user_id,circle_id,context_version,updated_at)
      VALUES (?,?,?,?,?)`,
    args:[SESSIONS[userId],userId,circleId,version,Math.floor(Date.now()/1000)],
  });
}

test('the route does not exist while the flag or circle membership is off, and touches no storage',async()=>{
  clientOverride=new Error('storage must not be touched');
  delete process.env.CIRCLE_HEALTH_ENABLED;
  const off=await invoke({ user:1 });
  assert.equal(off.status,404);
  assert.deepEqual(off.body,{ error:'not found' });
  assert.equal(off.headers['cache-control'],'private, no-store');
  process.env.CIRCLE_HEALTH_ENABLED='true';
  delete process.env.CIRCLE_MEMBERSHIP_ENABLED;
  assert.equal((await invoke({ user:1 })).status,404);
});

test('only GET without extra query parameters is accepted',async()=>{
  const post=await invoke({ method:'POST',user:1 });
  assert.equal(post.status,405);
  assert.equal(post.headers.allow,'GET');
  const smuggled=await invoke({ user:1,query:{ endpoint:'circle-health',circle_id:'20' } });
  assert.equal(smuggled.status,400);
  const inUrl=await invoke({ user:1,url:'/api/circle/health?circle_id=20' });
  assert.equal(inUrl.status,400);
});

test('an unauthenticated caller gets 401 and a storage failure gets 503',async()=>{
  assert.deepEqual((await invoke({})).body,{ error:'authentication required' });
  assert.equal((await invoke({})).status,401);
  clientOverride=new Error('database offline');
  const offline=await invoke({ user:1 });
  assert.equal(offline.status,503);
  assert.deepEqual(offline.body,{ error:'circle health unavailable' });
});

test('an active owner and a co-owner read the primary health in single-circle mode',async()=>{
  for(const user of [1,3]){
    const result=await invoke({ user });
    assert.equal(result.status,200,`owner ${user}`);
    assert.equal(result.body.ok,true);
    assert.equal(result.body.health.scope,'primary');
    assert.equal('circle_context_version' in result.body,false);
    const [newest,older]=result.body.health.cycles;
    assert.equal(newest.cycle_id,'2025-W40');
    assert.deepEqual(newest.metrics.completed,{ status:'ok',value:4 });
    assert.deepEqual(newest.metrics.scheduled,{ status:'ok',value:4 });
    assert.equal(older.suppressed,true);
    assert.doesNotMatch(JSON.stringify(result.body),/@|User \d/);
  }
});

test('members, demoted owners and inactive owners are denied in single-circle mode',async()=>{
  for(const user of [2,4]){
    const result=await invoke({ user });
    assert.equal(result.status,403,`user ${user}`);
    assert.deepEqual(result.body,{ error:'circle owner required' });
  }
  SESSIONS[5]='f'.repeat(64);
  try{
    // An owner whose membership is inactive has no primary circle at all.
    assert.equal((await invoke({ user:5 })).status,403);
  }finally{ delete SESSIONS[5]; }
});

test('an archived primary circle is denied',async()=>{
  await realDb.execute(`UPDATE circles SET archived_at='2026-10-01T00:00:00.000Z' WHERE id=10`);
  try{
    assert.equal((await invoke({ user:1 })).status,403);
  }finally{
    await realDb.execute(`UPDATE circles SET archived_at=NULL WHERE id=10`);
  }
});

test('multi-circle: the selected circle decides, and the context generation is echoed',async()=>{
  multiCircle();
  await selectCircle(1,10,2);
  const result=await invoke({ user:1,contextVersion:2 });
  assert.equal(result.status,200);
  assert.equal(result.body.circle_context_version,2);
  assert.equal(result.body.health.scope,'primary');
  const stale=await invoke({ user:1,contextVersion:1 });
  assert.equal(stale.status,409);
  assert.equal(stale.body.code,'circle_context_changed');
  assert.equal((await invoke({ user:1 })).body.code,'circle_context_changed');
});

test('multi-circle: owners of one circle cannot read another circle they only belong to',async()=>{
  multiCircle();
  await selectCircle(1,20,3);
  const crossCircle=await invoke({ user:1,contextVersion:3 });
  assert.equal(crossCircle.status,403);
  assert.deepEqual(crossCircle.body,{ error:'circle owner required' });
});

test('multi-circle: a secondary owner with one circle reads it without a header',async()=>{
  multiCircle();
  const result=await invoke({ user:6 });
  assert.equal(result.status,200);
  assert.equal(result.body.circle_context_version,0);
  assert.equal(result.body.health.scope,'secondary');
  assert.deepEqual(result.body.health.cycles.map(cycle=>cycle.cycle_id),['2025-W40']);
  assert.deepEqual(result.body.health.cycles[0].metrics.completed,{ status:'not_tracked',value:null });
});

test('multi-circle: no selection, or a selected archived circle, is refused',async()=>{
  multiCircle();
  const unselected=await invoke({ user:1 });
  assert.equal(unselected.status,409);
  assert.equal(unselected.body.code,'active_circle_required');
  await selectCircle(1,30,4);
  const archived=await invoke({ user:1,contextVersion:4 });
  assert.equal(archived.status,409);
  assert.equal(archived.body.code,'active_circle_required');
  // A member with no active circle membership at all is refused outright.
  await realDb.execute(`UPDATE circle_memberships SET status='inactive' WHERE user_id=2`);
  try{
    assert.equal((await invoke({ user:2 })).status,403);
  }finally{
    await realDb.execute(`UPDATE circle_memberships SET status='active' WHERE user_id=2`);
  }
});

test('a read failure returns a generic 503 and logs only an error code',async()=>{
  clientOverride={
    execute:statement=>realDb.execute(statement),
    batch:async()=>{ const error=new Error('read failed for user1@example.test'); error.code='SQLITE_IOERR'; throw error; },
    transaction:(...args)=>realDb.transaction(...args),
  };
  const failed=await invoke({ user:1 });
  assert.equal(failed.status,503);
  assert.deepEqual(failed.body,{ error:'circle health unavailable' });
  const logged=await realDb.execute(`SELECT message,meta_json,route,ip FROM app_logs WHERE event='circle_health_fail'`);
  assert.equal(logged.rows.length,1);
  assert.deepEqual(JSON.parse(String(logged.rows[0].meta_json)),{ code:'SQLITE_IOERR' });
  assert.equal(logged.rows[0].route,null);
  assert.equal(logged.rows[0].ip,null);
  assert.doesNotMatch(JSON.stringify(logged.rows[0]),/@/);
});
