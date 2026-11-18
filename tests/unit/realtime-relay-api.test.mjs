import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, mock, test } from 'node:test';
import { createClient } from '@libsql/client';
import { copyMigratedDatabase } from '../support/migrated-db.mjs';
import { prepareMigrationConnection } from '../../db/migration-runner.js';
import { relayKeyFixture, RELAY_BODY, RELAY_ENV_KEYS, RELAY_IDENTITY } from '../support/realtime-relay.mjs';

const realDb=await import('../../api/_db.js');
const originalJwt=process.env.JWT_SECRET;
let db=null,directory=null,authFailure=false,useRealAuth=false;
mock.module('../../api/_db.js',{exports:{...realDb,getClient:()=>db,
  verifyRequestAuth:async req=>{
    if(authFailure) throw new Error('private auth failure');
    if(useRealAuth) return realDb.verifyRequestAuth(req,db);
    const id=Number(req.headers?.['x-test-user']);
    return Number.isSafeInteger(id)&&id>0?{id,sessionHash:'a'.repeat(64),exp:Math.floor(Date.now()/1000)+3600}:null;
  },
}});
const {default:handler}=await import('../../api/code-document.js');
const {default:authHandler}=await import('../../api/auth.js');
const {getAuthorizedCodeDocument}=await import('../../api/_code-document.js');
const key=relayKeyFixture();
const originHeaders={origin:'https://randori.test',host:'randori.test','x-forwarded-proto':'https','sec-fetch-site':'same-origin'};

async function invoke({method='POST',body=RELAY_BODY,user=1,headers={},url='/api/code-document/relay-token',query={}}={},fn=handler){
  const result={status:200,headers:{},body:null};
  const res={status(code){ result.status=code; return this; },setHeader(name,value){ result.headers[name.toLowerCase()]=value; },
    json(value){ result.body=value; return this; }};
  await fn({method,url,query,body,headers:{...originHeaders,'x-test-user':String(user||''),...headers}},res);
  return result;
}

async function seed(){
  directory=mkdtempSync(join(tmpdir(),'randori-relay-api-461-'));
  await copyMigratedDatabase(join(directory,'test.sqlite'));
  db=createClient({url:`file:${join(directory,'test.sqlite')}`});
  await prepareMigrationConnection(db);
  await db.execute(`INSERT INTO auth_accounts (id,email,password_hash,display_name,color) VALUES
    (1,'one@example.test','hash','One','#111111'),(2,'two@example.test','hash','Two','#222222'),
    (3,'three@example.test','hash','Three','#333333'),(9,'outside@example.test','hash','Outside','#999999')`);
  await db.execute(`INSERT INTO users (id,name,color) VALUES (2,'Legacy Two','#222222')`);
  await db.execute(`INSERT INTO pairing_weeks (id,week_label,week_start) VALUES (10,'2026-W38','2026-09-14'),(11,'2026-W39','2026-09-21')`);
  await db.execute(`INSERT INTO pairing_groups (id,week_id,user_a_id,user_b_id,user_c_id,is_ai_pair) VALUES (20,10,1,2,NULL,0)`);
  await db.execute(`INSERT INTO pairing_participants (week_id,user_id,position,source) VALUES
    (10,1,0,'auth'),(10,2,1,'auth'),(10,3,2,'auth'),(10,9,3,'auth')`);
  await getAuthorizedCodeDocument(db,{viewerId:1,...RELAY_IDENTITY});
}

beforeEach(()=>{
  authFailure=false; useRealAuth=false;
  for(const name of [...RELAY_ENV_KEYS,'CIRCLE_MEMBERSHIP_ENABLED','MULTI_CIRCLE_CONTROL_PLANE_ENABLED',
    'SECONDARY_CIRCLE_WORKSPACE_ENABLED','EMAIL_PASSWORD_ACTIVATION_ENABLED','PASSWORD_RESET_ENABLED',
    'IDENTITY_MANAGEMENT_ENABLED','INVITE_REQUESTS_ENABLED','ACCOUNT_DELETION_GRACE_ENABLED']) delete process.env[name];
  Object.assign(process.env,key.env);
});
afterEach(()=>{
  db?.close(); db=null;
  if(directory) rmSync(directory,{recursive:true,force:true}); directory=null;
  for(const name of [...RELAY_ENV_KEYS,'CIRCLE_MEMBERSHIP_ENABLED','MULTI_CIRCLE_CONTROL_PLANE_ENABLED']) delete process.env[name];
  if(originalJwt===undefined) delete process.env.JWT_SECRET; else process.env.JWT_SECRET=originalJwt;
});

test('authenticated primary participants receive private short-lived tokens through the grouped endpoint',async()=>{
  await seed();
  const first=await invoke(),second=await invoke({user:2});
  assert.equal(first.status,200); assert.equal(second.status,200); assert.equal(first.body.topic,second.body.topic);
  assert.equal(first.headers['cache-control'],'private, no-store'); assert.equal(first.headers['x-content-type-options'],'nosniff');
  assert.ok(first.body.token); assert.equal(first.body.ok,true);
  for(const field of ['privateKey','subjectKey','SUPABASE_REALTIME_SIGNING_JWK','email']) assert.equal(Object.hasOwn(first.body,field),false);
  const rewritten=await invoke({url:'/api/code-document?endpoint=relay-token',query:{endpoint:'relay-token'}});
  assert.equal(rewritten.status,200);
  assert.equal((await db.execute('SELECT count(*) AS n FROM pair_code_documents')).rows[0].n,1);
  assert.equal((await db.execute('SELECT count(*) AS n FROM pair_room_snapshots')).rows[0].n,0,'token does not hydrate workspace');
  const routes=JSON.parse(readFileSync(new URL('../../vercel.json',import.meta.url))).rewrites;
  assert.ok(routes.some(route=>route.source==='/api/code-document/relay-token'&&route.destination==='/api/code-document?endpoint=relay-token'));
});

test('real cookie sessions authorize tokens, and revoked/expired/foreign sessions fail closed',async()=>{
  await seed(); useRealAuth=true;
  process.env.JWT_SECRET='relay-test-session-secret-at-least-thirty-two-bytes';
  const token=await realDb.issueSession(db,{id:1,email:'one@example.test'});
  const request={headers:{cookie:`randori_session=${encodeURIComponent(token)}`}};
  assert.equal((await invoke(request)).status,200);
  await realDb.revokeAccountSessions(db,1,'logout_all');
  assert.equal((await invoke(request)).status,401);
  const outside=await realDb.issueSession(db,{id:9,email:'outside@example.test'});
  const foreign=await invoke({headers:{cookie:`randori_session=${encodeURIComponent(outside)}`}});
  assert.equal(foreign.status,404); assert.deepEqual(foreign.body,{error:'pair not found'});
  const expired=await realDb.issueSession(db,{id:1,email:'one@example.test'},{nowSeconds:Math.floor(Date.now()/1000)-13*3600});
  assert.equal((await invoke({headers:{cookie:`randori_session=${encodeURIComponent(expired)}`}})).status,401);
});

test('anonymous, foreign, wrong-week, malformed, unavailable and missing-document rooms fail closed',async()=>{
  await seed();
  assert.equal((await invoke({user:null})).status,401);
  const denied=await invoke({user:9}); assert.equal(denied.status,404); assert.deepEqual(denied.body,{error:'pair not found'});
  for(const body of [{...RELAY_BODY,room_id:'week_11_pair_20'}, {...RELAY_BODY,room_id:'week_10_pair_999'},
    {...RELAY_BODY,room_id:'circle_1_publication_1_group_1'},{...RELAY_BODY,room_id:'week_10_pair_020'},
    {...RELAY_BODY,question_slug:'unavailable'},{...RELAY_BODY,question_version:2},{...RELAY_BODY,extra:true},[]]){
    const result=await invoke({body}); assert.equal(result.status,404); assert.deepEqual(result.body,denied.body);
  }
  await db.execute('DELETE FROM pair_code_documents');
  assert.deepEqual((await invoke()).body,denied.body);
  assert.equal((await db.execute('SELECT count(*) AS n FROM auth_rate_limits')).rows[0].n,0,'denials do not spend quota');
});

test('mixed-source, changed pairing snapshot, AI and triad rooms share one denial projection',async()=>{
  for(const mutation of [
    "UPDATE pairing_participants SET source='users' WHERE user_id=2 AND week_id=10",
    'UPDATE pairing_groups SET user_b_id=3 WHERE id=20',
    'UPDATE pairing_groups SET is_ai_pair=1 WHERE id=20',
    'UPDATE pairing_groups SET user_c_id=3 WHERE id=20',
  ]){
    await seed(); await db.execute(mutation);
    const result=await invoke(); assert.equal(result.status,404); assert.deepEqual(result.body,{error:'pair not found'});
    db.close(); db=null; rmSync(directory,{recursive:true,force:true}); directory=null;
  }
});

test('expired stored snapshot and unanimous completion deny new relay tokens',async()=>{
  await seed();
  // The migration's document guard blocks arbitrary in-place metadata edits;
  // use the same delete/reinsert historical fixture pattern as code-document tests.
  const row=(await db.execute('SELECT * FROM pair_code_documents')).rows[0];
  await db.execute('DELETE FROM pair_code_documents');
  const fields=Object.keys(row),args=fields.map(field=>field==='updated_at'||field==='created_at'?'2020-01-01T00:00:00.000Z':row[field]);
  await db.execute({sql:`INSERT INTO pair_code_documents (${fields.join(',')}) VALUES (${fields.map(()=>'?').join(',')})`,args});
  assert.equal((await invoke()).status,404);
  await getAuthorizedCodeDocument(db,{viewerId:1,...RELAY_IDENTITY});
  for(const userId of [1,2]){
    await db.execute({sql:`INSERT INTO session_completion_receipts
      (week_id,pair_group_id,user_id,participant_source,pair_user_a_id,pair_user_b_id,pair_user_c_id,confirmed_at)
      VALUES (10,20,?,'auth',1,2,NULL,'2026-09-20T10:00:00.000Z')`,args:[userId]});
    assert.equal((await invoke()).status,userId===1?200:404);
  }
});

test('flag off and missing/misconfigured signing material never emit a token or capability',async()=>{
  await seed();
  for(const patch of [{REALTIME_RELAY_ENABLED:'false'},{REALTIME_RELAY_ENABLED:'TRUE'},
    {SUPABASE_REALTIME_SIGNING_JWK:''},{SUPABASE_REALTIME_SIGNING_KID:''},
    {SUPABASE_URL:'https://attacker.test'},{SUPABASE_PUBLISHABLE_KEY:'sb_secret_no'},
    {RANDORI_LOCAL_RUNTIME:'true'}]){
    Object.assign(process.env,key.env); delete process.env.RANDORI_LOCAL_RUNTIME; Object.assign(process.env,patch);
    const result=await invoke(); assert.equal(result.status,404); assert.deepEqual(result.body,{error:'pair not found'});
    const discovery=await invoke({method:'GET',url:'/api/auth/capabilities'},authHandler);
    assert.equal(discovery.body.capabilities.realtimeRelay,undefined);
    const durable=await invoke({method:'GET',url:'/api/code-document',query:{...RELAY_BODY,question_version:'1'}});
    assert.equal(durable.status,200); assert.equal(durable.body.realtime_relay,undefined);
  }
  Object.assign(process.env,key.env); delete process.env.RANDORI_LOCAL_RUNTIME;
  assert.equal((await invoke({method:'GET',url:'/api/auth/capabilities'},authHandler)).body.capabilities.realtimeRelay,true);
  assert.equal((await invoke({method:'GET',url:'/api/code-document',query:{...RELAY_BODY,question_version:'1'}})).body.realtime_relay,true);
});

test('token issuance is strictly same-origin for cookies, bearer credentials and cookieless callers',async()=>{
  await seed();
  for(const headers of [{origin:'https://attacker.test'}, {origin:'http://randori.test'}, {origin:''},
    {origin:'https://randori.test/path'}, {'sec-fetch-site':'same-site'},
    {origin:'https://attacker.test',authorization:'Bearer token'},
    {origin:'https://attacker.test',Authorization:'Bearer token',Cookie:'randori_session=test'}]){
    assert.equal((await invoke({headers})).status,403);
  }
  const method=await invoke({method:'GET'}); assert.equal(method.status,405); assert.equal(method.headers.allow,'POST');
  assert.equal((await db.execute('SELECT count(*) AS n FROM auth_rate_limits')).rows[0].n,0);
});

test('per-account token rate limit is durable, shared across rooms and returns Retry-After',async()=>{
  await seed();
  for(let index=0;index<12;index+=1) assert.equal((await invoke()).status,200);
  const limited=await invoke(); assert.equal(limited.status,429); assert.ok(Number(limited.headers['retry-after'])>0);
  assert.equal((await invoke({user:2})).status,200,'partner has a separate budget');
  const path=join(directory,'test.sqlite'); db.close(); db=createClient({url:`file:${path}`});
  assert.equal((await invoke()).status,429,'restart is not a quota reset');
  await db.execute('UPDATE auth_rate_limits SET expires_at=0');
  assert.equal((await invoke()).status,200);
});

test('schema, session, authorization, budget and transaction failures return generic non-cacheable 503',async()=>{
  await seed(); authFailure=true;
  assert.deepEqual((await invoke()).body,{error:'realtime relay unavailable'}); authFailure=false;
  const original=db;
  for(const fake of [null,{transaction:async()=>{ throw new Error('private transaction'); }},
    {transaction:async()=>({execute:async()=>{ throw new Error('private query'); },rollback:async()=>{ throw Error(); },close:async()=>{ throw Error(); }})},
    {transaction:async()=>({execute:async()=>({rows:[{week_id:10,pair_group_id:20,user_a_id:1,user_b_id:2}]}),commit:async()=>{ throw Error('private commit'); },rollback:async()=>{},close:async()=>{}})},
    {transaction:()=>original.transaction('read'),execute:async()=>({rows:[]})}]){
    db=fake; const result=await invoke(); assert.equal(result.status,503); assert.deepEqual(result.body,{error:'realtime relay unavailable'});
    assert.equal(result.headers['cache-control'],'private, no-store');
  }
  db=original;
});

test('active primary membership and live session-circle context fence token issuance',async()=>{
  await seed();
  await db.execute(`INSERT INTO circles (id,public_id,slug,name,is_primary,created_by) VALUES (1,'primary-test','primary-test','Primary',1,1),(2,'secondary-test','secondary-test','Secondary',0,1)`);
  await db.execute(`INSERT INTO circle_memberships (circle_id,user_id,role,status,invited_by) VALUES
    (1,1,'owner','active',1),(1,2,'member','active',1),(2,1,'owner','active',1)`);
  process.env.CIRCLE_MEMBERSHIP_ENABLED='true';
  assert.equal((await invoke()).status,200);
  await db.execute("UPDATE circle_memberships SET status='inactive' WHERE circle_id=1 AND user_id=1");
  assert.equal((await invoke()).status,404);
  await db.execute("UPDATE circle_memberships SET status='active' WHERE circle_id=1 AND user_id=1");
  process.env.MULTI_CIRCLE_CONTROL_PLANE_ENABLED='true';
  const hash='a'.repeat(64),now=Math.floor(Date.now()/1000);
  await db.execute({sql:'INSERT INTO auth_sessions (session_hash,user_id,created_at,expires_at) VALUES (?,1,?,?)',args:[hash,now,now+3600]});
  assert.equal((await invoke({headers:{'x-randori-circle-context-version':'0'}})).status,404,'selection required');
  await db.execute({sql:'INSERT INTO auth_session_circle_contexts (session_hash,user_id,circle_id,context_version,updated_at) VALUES (?,1,1,1,?)',args:[hash,now]});
  assert.equal((await invoke({headers:{'x-randori-circle-context-version':'0'}})).status,404,'stale context');
  const valid=await invoke({headers:{'x-randori-circle-context-version':'1'}});
  assert.equal(valid.status,200); assert.equal(valid.body.circle_context_version,1); assert.equal(valid.body.circle_public_id,'primary-test');
  await db.execute({sql:'UPDATE auth_session_circle_contexts SET circle_id=2,context_version=2 WHERE session_hash=?',args:[hash]});
  assert.equal((await invoke({headers:{'x-randori-circle-context-version':'2'}})).status,404,'secondary never gets primary relay');
});
