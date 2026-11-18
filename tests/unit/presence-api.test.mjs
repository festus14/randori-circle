import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, mock, test } from 'node:test';
import { createClient } from '@libsql/client';
import { copyMigratedDatabase } from '../support/migrated-db.mjs';
import { seedExpiringInterview } from '../support/interview-expiry.mjs';
import { prepareMigrationConnection } from '../../db/migration-runner.js';
import { RELAY_BODY, RELAY_ENV_KEYS, RELAY_IDENTITY } from '../support/realtime-relay.mjs';

const realDb=await import('../../api/_db.js');
const originalJwt=process.env.JWT_SECRET;
let db=null,directory=null,authFailure=false;
mock.module('../../api/_db.js',{exports:{...realDb,getClient:()=>db,
  verifyRequestAuth:async req=>{
    if(authFailure) throw new Error('private auth failure');
    const id=Number(req.headers?.['x-test-user']);
    return Number.isSafeInteger(id)&&id>0?{id,sessionHash:'a'.repeat(64),exp:Math.floor(Date.now()/1000)+3600}:null;
  },
}});
const {default:handler}=await import('../../api/code-document.js');
const {default:authHandler}=await import('../../api/auth.js');
const {getAuthorizedCodeDocument}=await import('../../api/_code-document.js');
const presence=await import('../../api/_presence.js');
const SECRET='presence-test-app-secret-at-least-thirty-two-bytes';
const BODY={...RELAY_BODY,state:'online'};
const originHeaders={origin:'https://randori.test',host:'randori.test','x-forwarded-proto':'https','sec-fetch-site':'same-origin'};
const ENV=[...RELAY_ENV_KEYS,'PRESENCE_ENABLED','INTERVIEW_SESSION_ENABLED','CIRCLE_MEMBERSHIP_ENABLED','MULTI_CIRCLE_CONTROL_PLANE_ENABLED'];

async function invoke({method='POST',body=BODY,user=1,headers={},url='/api/code-document/presence',query={}}={},fn=handler){
  const result={status:200,headers:{},body:null};
  const res={status(code){ result.status=code; return this; },setHeader(name,value){ result.headers[name.toLowerCase()]=value; },
    json(value){ result.body=value; return this; }};
  await fn({method,url,query,body,headers:{...originHeaders,'x-test-user':String(user||''),...headers}},res);
  return result;
}

async function seed(){
  directory=mkdtempSync(join(tmpdir(),'randori-presence-462-'));
  await copyMigratedDatabase(join(directory,'test.sqlite'));
  db=createClient({url:`file:${join(directory,'test.sqlite')}`});
  await prepareMigrationConnection(db);
  await db.execute(`INSERT INTO auth_accounts (id,email,password_hash,display_name,color) VALUES
    (1,'one@example.test','hash','One','#111111'),(2,'two@example.test','hash','Two','#222222'),
    (9,'outside@example.test','hash','Outside','#999999')`);
  await db.execute(`INSERT INTO pairing_weeks (id,week_label,week_start) VALUES (10,'2026-W38','2026-09-14')`);
  await db.execute(`INSERT INTO pairing_groups (id,week_id,user_a_id,user_b_id,user_c_id,is_ai_pair) VALUES (20,10,1,2,NULL,0)`);
  await db.execute(`INSERT INTO pairing_participants (week_id,user_id,position,source) VALUES (10,1,0,'auth'),(10,2,1,'auth'),(10,9,2,'auth')`);
  await getAuthorizedCodeDocument(db,{viewerId:1,...RELAY_IDENTITY});
}
const allRows=async()=>(await db.execute('SELECT key,attempts,expires_at FROM auth_rate_limits ORDER BY key')).rows;
// Presence rows only (the per-account budget rows share the table).
const rows=async()=>{
  const config=presence.presenceConfiguration();
  const keys=new Set([1,2,9].map(id=>presence.presenceKey(config,'week_10_pair_20',id)));
  return (await allRows()).filter(row=>keys.has(String(row.key)));
};

beforeEach(()=>{
  authFailure=false;
  for(const name of ENV) delete process.env[name];
  process.env.JWT_SECRET=SECRET; process.env.PRESENCE_ENABLED='true';
});
afterEach(()=>{
  db?.close(); db=null;
  if(directory) rmSync(directory,{recursive:true,force:true}); directory=null;
  for(const name of ENV) delete process.env[name];
  if(originalJwt===undefined) delete process.env.JWT_SECRET; else process.env.JWT_SECRET=originalJwt;
});

test('the flag is literal, needs a strong app secret and is advertised only when usable',async()=>{
  for(const flag of [undefined,'false','TRUE','1']) assert.equal(presence.presenceConfiguration({PRESENCE_ENABLED:flag,JWT_SECRET:SECRET}),null);
  assert.equal(presence.presenceConfiguration({PRESENCE_ENABLED:'true',JWT_SECRET:'short'}),null);
  assert.equal(presence.presenceConfiguration({PRESENCE_ENABLED:'true'}),null);
  const config=presence.presenceConfiguration({PRESENCE_ENABLED:'true',JWT_SECRET:SECRET});
  assert.ok(config); assert.equal(presence.presenceConfiguration({PRESENCE_ENABLED:'true',JWT_SECRET:SECRET}),config);
  assert.notEqual(presence.presenceKey(config,'week_10_pair_20',1),presence.presenceKey(config,'week_10_pair_20',2));
  assert.notEqual(presence.presenceKey(config,'week_10_pair_20',1),presence.presenceKey(config,'week_11_pair_20',1));
  await seed();
  assert.equal((await invoke({method:'GET',url:'/api/auth/capabilities'},authHandler)).body.capabilities.presence,true);
  assert.equal((await invoke({method:'GET',url:'/api/code-document',query:{...RELAY_BODY,question_version:'1'}})).body.presence,true);
  process.env.PRESENCE_ENABLED='false';
  assert.equal((await invoke({method:'GET',url:'/api/auth/capabilities'},authHandler)).body.capabilities.presence,undefined);
  const durable=await invoke({method:'GET',url:'/api/code-document',query:{...RELAY_BODY,question_version:'1'}});
  assert.equal(durable.status,200); assert.equal(durable.body.presence,undefined);
  const off=await invoke(); assert.equal(off.status,404); assert.deepEqual(off.body,{error:'pair not found'});
  assert.equal((await allRows()).length,0,'flag off writes nothing, not even budget');
  const routes=JSON.parse(readFileSync(new URL('../../vercel.json',import.meta.url))).rewrites;
  assert.ok(routes.some(route=>route.source==='/api/code-document/presence'&&route.destination==='/api/code-document?endpoint=presence'));
});

test('participants see each other within one heartbeat and keyed rows carry no identifiers or cursors',async()=>{
  await seed();
  const first=await invoke();
  assert.equal(first.status,200); assert.equal(first.headers['cache-control'],'private, no-store');
  assert.deepEqual(first.body,{ok:true,seat:'a',partner_online:false,ttl_seconds:20,interval_seconds:5});
  const second=await invoke({user:2,body:{...BODY,state:'online'},url:'/api/code-document?endpoint=presence',query:{endpoint:'presence'}});
  assert.deepEqual(second.body,{ok:true,seat:'b',partner_online:true,ttl_seconds:20,interval_seconds:5});
  assert.equal((await invoke()).body.partner_online,true);
  // A join also returns the partner's already-visible name/colour, never email.
  const join=await invoke({body:{...BODY,state:'join'}});
  assert.deepEqual(join.body.partner,{display_name:'Two',color:'#222222'});
  assert.doesNotMatch(JSON.stringify(join.body),/example\.test|password|hash/);
  await db.execute("UPDATE auth_accounts SET color='red' WHERE id=2");
  assert.deepEqual((await invoke({user:1,body:{...BODY,state:'join'}})).body.partner,{display_name:'Two',color:null});
  await db.execute("UPDATE auth_accounts SET display_name='   ' WHERE id=2");
  assert.equal(Object.hasOwn((await invoke({body:{...BODY,state:'join'}})).body,'partner'),false);
  const stored=await rows();
  assert.equal(stored.length,2,'one row per room participant');
  for(const row of stored){
    assert.match(String(row.key),/^[a-f0-9]{64}$/);
    for(const secret of ['week_10_pair_20','one@example','focus-block','"1"']) assert.equal(String(row.key).includes(secret),false);
  }
  assert.equal((await db.execute('SELECT count(*) AS n FROM pair_room_snapshots')).rows[0].n,0,'no workspace side effect');
  assert.equal((await db.execute('SELECT revision FROM pair_code_documents')).rows[0].revision,1,'no document write');
});

test('presence rows expire on the database clock without any cleanup job',async()=>{
  await seed();
  await invoke(); await invoke({user:2});
  // Age the partner's row past its TTL: it is ignored at once.
  const key=presence.presenceKey(presence.presenceConfiguration(),'week_10_pair_20',2);
  await db.execute({sql:"UPDATE auth_rate_limits SET expires_at=CAST(strftime('%s','now') AS INTEGER)-1 WHERE key=?",args:[key]});
  assert.equal((await invoke()).body.partner_online,false,'stale presence expired');
  // Renewal within four seconds is a no-op write (bounded write rate).
  const mine=presence.presenceKey(presence.presenceConfiguration(),'week_10_pair_20',1);
  const before=(await db.execute({sql:'SELECT expires_at FROM auth_rate_limits WHERE key=?',args:[mine]})).rows[0].expires_at;
  await db.execute({sql:'UPDATE auth_rate_limits SET attempts=7 WHERE key=?',args:[mine]});
  await invoke();
  const after=(await db.execute({sql:'SELECT attempts,expires_at FROM auth_rate_limits WHERE key=?',args:[mine]})).rows[0];
  assert.equal(Number(after.attempts),7); assert.equal(Number(after.expires_at),Number(before));
  await db.execute({sql:'UPDATE auth_rate_limits SET expires_at=expires_at-5 WHERE key=?',args:[mine]});
  await invoke();
  assert.equal(Number((await db.execute({sql:'SELECT attempts FROM auth_rate_limits WHERE key=?',args:[mine]})).rows[0].attempts),1);
  // Opportunistic cleanup removes only expired rows and tolerates failure.
  await presence.recordPresence(db,presence.presenceConfiguration(),{roomId:'week_10_pair_20',viewerId:1,partnerId:2,random:()=>0});
  assert.equal((await rows()).length,1,'expired partner row swept');
  const failing={execute:async statement=>{
    if(String(statement?.sql??statement).trimStart().startsWith('DELETE')) throw new Error('cleanup down');
    return db.execute(statement);
  }};
  assert.deepEqual(await presence.recordPresence(failing,presence.presenceConfiguration(),
    {roomId:'week_10_pair_20',viewerId:1,partnerId:2,random:()=>0}),{partnerOnline:false});
});

test('leave deletes only the caller row and is accepted after the room closes',async()=>{
  await seed();
  await invoke(); await invoke({user:2});
  const left=await invoke({body:{...BODY,state:'leave'}});
  assert.deepEqual(left.body,{ok:true});
  assert.equal((await invoke({user:2})).body.partner_online,false,'partner sees the leave on its next beat');
  assert.equal((await rows()).length,1);
  // Terminal room: heartbeats are denied, but leave still removes the row.
  process.env.INTERVIEW_SESSION_ENABLED='true'; await seedExpiringInterview(db);
  await new Promise(resolve=>setTimeout(resolve,700));
  const denied=await invoke({user:2}); assert.equal(denied.status,404); assert.deepEqual(denied.body,{error:'pair not found'});
  assert.equal((await invoke({user:2,body:{...BODY,state:'leave'}})).status,200);
  assert.equal((await rows()).length,0);
});

test('anonymous, foreign, malformed, cross-origin and completed rooms fail closed without writes',async()=>{
  await seed();
  assert.equal((await invoke({user:null})).status,401);
  const denied=await invoke({user:9}); assert.equal(denied.status,404); assert.deepEqual(denied.body,{error:'pair not found'});
  for(const body of [{...BODY,state:'here'},{...BODY,extra:true},RELAY_BODY,{...BODY,room_id:'week_10_pair_999'},
    {...BODY,room_id:'circle_1_publication_1_group_1'},{...BODY,question_slug:'missing'},[],null,{...BODY,cursor:{line:1}}]){
    const result=await invoke({body}); assert.equal(result.status,404,JSON.stringify(body)); assert.deepEqual(result.body,denied.body);
  }
  for(const headers of [{origin:'https://attacker.test'},{'sec-fetch-site':'same-site'},
    {origin:'https://attacker.test',authorization:'Bearer token'}]) assert.equal((await invoke({headers})).status,403);
  const method=await invoke({method:'GET'}); assert.equal(method.status,405); assert.equal(method.headers.allow,'POST');
  for(const userId of [1,2]){
    await db.execute({sql:`INSERT INTO session_completion_receipts
      (week_id,pair_group_id,user_id,participant_source,pair_user_a_id,pair_user_b_id,pair_user_c_id,confirmed_at)
      VALUES (10,20,?,'auth',1,2,NULL,'2026-09-20T10:00:00.000Z')`,args:[userId]});
  }
  assert.equal((await invoke()).status,404,'completed sessions stop presence');
  assert.equal((await rows()).length,0,'denials never write presence rows (only the caller budget)');
});

test('storage and authentication failures are generic and non-cacheable',async()=>{
  await seed(); authFailure=true;
  const auth=await invoke(); assert.equal(auth.status,503); assert.deepEqual(auth.body,{error:'presence unavailable'});
  authFailure=false;
  const original=db;
  for(const fake of [null,{transaction:async()=>{ throw new Error('private transaction'); }},
    {transaction:()=>original.transaction('read'),execute:async()=>{ throw new Error('private write'); }}]){
    db=fake; const result=await invoke(); assert.equal(result.status,503); assert.deepEqual(result.body,{error:'presence unavailable'});
    assert.equal(result.headers['cache-control'],'private, no-store');
  }
  db=original;
});

test('a per-account budget caps every state, leave included, with Retry-After and a one-minute reset',async()=>{
  await seed();
  assert.equal(presence.PRESENCE_BUDGET_LIMIT,30);
  for(let index=0;index<presence.PRESENCE_BUDGET_LIMIT-1;index+=1) assert.equal((await invoke()).status,200);
  assert.equal((await invoke({body:{...BODY,state:'leave'}})).status,200,'leave spends budget too');
  const limited=await invoke(); assert.equal(limited.status,429); assert.deepEqual(limited.body,{error:'presence rate limited'});
  assert.ok(Number(limited.headers['retry-after'])>=1&&Number(limited.headers['retry-after'])<=60);
  assert.equal((await invoke({body:{...BODY,state:'leave'}})).status,429);
  assert.equal((await invoke({user:2})).status,200,'the partner has its own budget');
  assert.equal((await invoke({user:9})).status,404,'foreign callers spend their own budget before the pair read');
  await db.execute("UPDATE auth_rate_limits SET expires_at=CAST(strftime('%s','now') AS INTEGER)-1");
  assert.equal((await invoke()).status,200,'window resets on the database clock');
  const broken={execute:async()=>({rows:[{attempts:'x'}]})};
  await assert.rejects(presence.consumePresenceBudget(broken,presence.presenceConfiguration(),1),/presence budget unavailable/);
});

test('leave requires a canonical primary room id and only deletes the caller row',async()=>{
  await seed();
  await invoke(); await invoke({user:2});
  for(const room_id of ['circle_1_publication_1_group_1','week_10_pair_020','week_0_pair_20','../week_10_pair_20']){
    const result=await invoke({body:{...BODY,room_id,state:'leave'}});
    assert.equal(result.status,404,room_id); assert.deepEqual(result.body,{error:'pair not found'});
  }
  assert.equal((await rows()).length,2,'non-canonical leaves deleted nothing');
  assert.equal(presence.parsePresenceRequest({...BODY,room_id:'circle_1_publication_1_group_1'}),null);
});

test('the opportunistic sweep is rare and bounded to a fixed number of expired rows',async()=>{
  await seed();
  const config=presence.presenceConfiguration();
  await db.execute(`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i<100)
    INSERT INTO auth_rate_limits (key,attempts,expires_at) SELECT printf('stale-%03d',i),1,1 FROM n`);
  await presence.recordPresence(db,config,{roomId:'week_10_pair_20',viewerId:1,partnerId:2,random:()=>0.5});
  assert.equal((await db.execute("SELECT count(*) AS n FROM auth_rate_limits WHERE key LIKE 'stale-%'")).rows[0].n,100,'no sweep at 50%');
  await presence.recordPresence(db,config,{roomId:'week_10_pair_20',viewerId:1,partnerId:2,random:()=>0});
  assert.equal((await db.execute("SELECT count(*) AS n FROM auth_rate_limits WHERE key LIKE 'stale-%'")).rows[0].n,
    100-presence.PRESENCE_SWEEP_LIMIT,'at most PRESENCE_SWEEP_LIMIT rows per sweep');
  assert.ok(presence.PRESENCE_CLEANUP_PROBABILITY<=0.005);
});
