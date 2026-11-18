import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, mock, test } from 'node:test';
import { createClient } from '@libsql/client';
import { copyMigratedDatabase } from '../support/migrated-db.mjs';
import { prepareMigrationConnection } from '../../db/migration-runner.js';
import { relayKeyFixture, RELAY_BODY, RELAY_ENV_KEYS, RELAY_IDENTITY } from '../support/realtime-relay.mjs';

// #462 presence after ID-99: room-scoped "online" is allowed for a lobby or
// locked candidate (who holds no relay token and cannot edit), so the
// interviewer can see the candidate waiting; it still stops when the
// interview ends. Nothing here can carry a cursor or code.
const realDb=await import('../../api/_db.js');
const originalJwt=process.env.JWT_SECRET;
let db=null,directory=null;
mock.module('../../api/_db.js',{exports:{...realDb,getClient:()=>db,
  verifyRequestAuth:async req=>{
    const id=Number(req.headers?.['x-test-user']);
    return Number.isSafeInteger(id)&&id>0?{id,sessionHash:'a'.repeat(64),exp:Math.floor(Date.now()/1000)+3600}:null;
  },
}});
const {default:handler}=await import('../../api/code-document.js');
const {getAuthorizedCodeDocument}=await import('../../api/_code-document.js');
const presence=await import('../../api/_presence.js');
const key=relayKeyFixture();
const CANDIDATE=1,INTERVIEWER=2;
const originHeaders={origin:'https://randori.test',host:'randori.test','x-forwarded-proto':'https','sec-fetch-site':'same-origin'};
const NOW="strftime('%Y-%m-%dT%H:%M:%fZ','now')";
const ENV=[...RELAY_ENV_KEYS,'PRESENCE_ENABLED','INTERVIEW_SESSION_ENABLED','CIRCLE_MEMBERSHIP_ENABLED','MULTI_CIRCLE_CONTROL_PLANE_ENABLED'];

async function invoke({body,user,url='/api/code-document/presence'}){
  const result={status:200,headers:{},body:null};
  const res={status(code){ result.status=code; return this; },setHeader(name,value){ result.headers[name.toLowerCase()]=value; },
    json(value){ result.body=value; return this; }};
  await handler({method:'POST',url,query:{},body,headers:{...originHeaders,'x-test-user':String(user)}},res);
  return result;
}
const beat=(user,state='online')=>invoke({user,body:{room_id:'week_10_pair_20',state}});
const token=user=>invoke({user,body:RELAY_BODY,url:'/api/code-document/relay-token'});

async function seed({document=true}={}){
  directory=mkdtempSync(join(tmpdir(),'randori-presence-interview-'));
  await copyMigratedDatabase(join(directory,'test.sqlite'));
  db=createClient({url:`file:${join(directory,'test.sqlite')}`});
  await prepareMigrationConnection(db);
  await db.execute(`INSERT INTO auth_accounts (id,email,password_hash,display_name,color) VALUES
    (1,'one@example.test','hash','One','#111111'),(2,'two@example.test','hash','Two','#222222'),(9,'nine@example.test','hash','Nine','#999999')`);
  await db.execute(`INSERT INTO pairing_weeks (id,week_label,week_start) VALUES (10,'2026-W38','2026-09-14')`);
  await db.execute(`INSERT INTO pairing_groups (id,week_id,user_a_id,user_b_id,user_c_id,is_ai_pair) VALUES (20,10,1,2,NULL,0)`);
  await db.execute(`INSERT INTO pairing_participants (week_id,user_id,position,source) VALUES (10,1,0,'auth'),(10,2,1,'auth'),(10,9,2,'auth')`);
  await db.execute({sql:`INSERT INTO pair_room_snapshots (room_id,week_id,pair_group_id,revision,schema_version,client_id,client_seq,language,question_id,code,updated_by)
    VALUES ('week_10_pair_20',10,20,1,3,'interviewer-client',1,'javascript','focus-block-rollup@1',?,2)`,args:[JSON.stringify({code:'',board:{shapes:[]}})]});
  if(document) await getAuthorizedCodeDocument(db,{viewerId:INTERVIEWER,...RELAY_IDENTITY});
}
async function interview({admitted=false,locked=false}={}){
  await db.execute('DELETE FROM pair_interview_sessions');
  if(!admitted&&!locked) return;
  await db.execute({sql:`INSERT INTO pair_interview_sessions (week_id,pair_group_id,pair_user_a_id,pair_user_b_id,admission,admitted_at,
    editing_locked,revision,updated_by,created_at,updated_at) VALUES (10,20,1,2,?,${admitted?NOW:'NULL'},?,1,2,${NOW},${NOW})`,
  args:[admitted?'interviewer':null,locked?1:0]});
}

beforeEach(()=>{
  for(const name of ENV) delete process.env[name];
  Object.assign(process.env,key.env);
  process.env.INTERVIEW_SESSION_ENABLED='true'; process.env.PRESENCE_ENABLED='true';
});
afterEach(()=>{
  db?.close(); db=null;
  if(directory) rmSync(directory,{recursive:true,force:true}); directory=null;
  for(const name of ENV) delete process.env[name];
  if(originalJwt===undefined) delete process.env.JWT_SECRET; else process.env.JWT_SECRET=originalJwt;
});

test('a lobby candidate is visible to the interviewer as online while holding no relay token',async()=>{
  await seed({document:false});
  await interview();
  assert.equal((await token(CANDIDATE)).status,404,'ID-99: no relay credential in the lobby');
  const candidate=await beat(CANDIDATE,'join');
  assert.equal(candidate.status,200); assert.equal(candidate.body.seat,'a');
  assert.deepEqual(candidate.body.partner,{display_name:'Two',color:'#222222'});
  const interviewer=await beat(INTERVIEWER);
  assert.equal(interviewer.status,200); assert.equal(interviewer.body.partner_online,true,'candidate waiting is visible');
  assert.deepEqual(Object.keys(interviewer.body).sort(),['interval_seconds','ok','partner_online','seat','ttl_seconds']);
  assert.equal((await beat(9)).status,404,'outsiders are still denied');
  assert.equal((await db.execute('SELECT count(*) AS n FROM pair_code_documents')).rows[0].n,0,'presence never needs or creates a document');
});

test('a locked candidate stays present; admission and unlock do not change presence authority',async()=>{
  await seed();
  for(const state of [{locked:true},{admitted:true,locked:true},{admitted:true}]){
    await interview(state);
    assert.equal((await beat(CANDIDATE)).status,200,JSON.stringify(state));
    assert.equal((await beat(INTERVIEWER)).body.partner_online,true,JSON.stringify(state));
  }
  await interview({admitted:true,locked:true});
  assert.equal((await token(CANDIDATE)).status,404,'the lock still withholds the relay token');
  const auth=await presence.readPresenceAuthorization(db,{viewerId:CANDIDATE,weekId:10,pairGroupId:20});
  assert.deepEqual({...auth},{userAId:1,userBId:2,candidateUserId:1,live:true,locked:true});
});

test('the interview end stops presence for both participants, but leave still deletes the row',async()=>{
  await seed();
  await interview({admitted:true});
  assert.equal((await beat(CANDIDATE)).status,200);
  await db.execute(`INSERT INTO pair_session_controls (week_id,pair_group_id,pair_user_a_id,pair_user_a_source,pair_user_b_id,pair_user_b_source,
    pair_user_c_id,candidate_user_id,candidate_source,timer_state,remaining_ms,anchor_at,revision,updated_by,updated_by_source,created_at,updated_at)
    VALUES (10,20,1,'auth',2,'auth',NULL,1,'auth','paused',0,NULL,1,2,'auth',${NOW},${NOW})`);
  for(const user of [CANDIDATE,INTERVIEWER]){
    const denied=await beat(user); assert.equal(denied.status,404); assert.deepEqual(denied.body,{error:'pair not found'});
  }
  assert.deepEqual((await beat(CANDIDATE,'leave')).body,{ok:true});
  const config=presence.presenceConfiguration();
  const row=await db.execute({sql:'SELECT 1 FROM auth_rate_limits WHERE key=?',args:[presence.presenceKey(config,'week_10_pair_20',CANDIDATE)]});
  assert.equal(row.rows.length,0);
});

test('peer mode (flag off) keeps the room-level presence authority',async()=>{
  await seed();
  delete process.env.INTERVIEW_SESSION_ENABLED;
  await interview({locked:true});
  assert.equal((await beat(CANDIDATE)).status,200);
  assert.equal((await beat(INTERVIEWER)).body.partner_online,true);
  const auth=await presence.readPresenceAuthorization(db,{viewerId:CANDIDATE,weekId:10,pairGroupId:20});
  assert.deepEqual({...auth},{userAId:1,userBId:2},'no interview gate fields without the flag');
});
