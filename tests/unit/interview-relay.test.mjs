import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, mock, test } from 'node:test';
import { createClient } from '@libsql/client';
import { copyMigratedDatabase } from '../support/migrated-db.mjs';
import { prepareMigrationConnection } from '../../db/migration-runner.js';
import { relayKeyFixture, RELAY_BODY, RELAY_ENV_KEYS, RELAY_IDENTITY } from '../support/realtime-relay.mjs';

// The realtime relay (ID-96) must not bypass the interview lobby or the
// candidate edit lock (#464, ID-99): no relay credential for a lobby or locked
// candidate, a short candidate TTL re-checked on renewal, and a one-way
// direction the browsers enforce.
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
const {RELAY_CANDIDATE_TOKEN_TTL_SECONDS,RELAY_TOKEN_TTL_SECONDS}=await import('../../api/_realtime-relay.js');
const key=relayKeyFixture();
const CANDIDATE=1,INTERVIEWER=2;
const originHeaders={origin:'https://randori.test',host:'randori.test','x-forwarded-proto':'https','sec-fetch-site':'same-origin'};
const NOW="strftime('%Y-%m-%dT%H:%M:%fZ','now')";

async function invoke({method='POST',body=RELAY_BODY,user=CANDIDATE,url='/api/code-document/relay-token',query={}}={}){
  const result={status:200,headers:{},body:null};
  const res={status(code){ result.status=code; return this; },setHeader(name,value){ result.headers[name.toLowerCase()]=value; },
    json(value){ result.body=value; return this; }};
  await handler({method,url,query,body,headers:{...originHeaders,'x-test-user':String(user)}},res);
  return result;
}
const token=user=>invoke({user});
const documentGet=user=>invoke({method:'GET',user,url:'/api/code-document?room_id=week_10_pair_20&question_slug=focus-block-rollup&question_version=1&language=javascript',
  query:{room_id:'week_10_pair_20',question_slug:'focus-block-rollup',question_version:'1',language:'javascript'},body:undefined});
const quota=async()=>Number((await db.execute('SELECT count(*) AS n FROM auth_rate_limits')).rows[0].n);

async function seed(){
  directory=mkdtempSync(join(tmpdir(),'randori-interview-relay-'));
  await copyMigratedDatabase(join(directory,'test.sqlite'));
  db=createClient({url:`file:${join(directory,'test.sqlite')}`});
  await prepareMigrationConnection(db);
  await db.execute(`INSERT INTO auth_accounts (id,email,password_hash,display_name,color) VALUES
    (1,'one@example.test','hash','One','#111111'),(2,'two@example.test','hash','Two','#222222')`);
  await db.execute(`INSERT INTO pairing_weeks (id,week_label,week_start) VALUES (10,'2026-W38','2026-09-14')`);
  await db.execute(`INSERT INTO pairing_groups (id,week_id,user_a_id,user_b_id,user_c_id,is_ai_pair) VALUES (20,10,1,2,NULL,0)`);
  await db.execute(`INSERT INTO pairing_participants (week_id,user_id,position,source) VALUES (10,1,0,'auth'),(10,2,1,'auth')`);
  await db.execute({sql:`INSERT INTO pair_room_snapshots (room_id,week_id,pair_group_id,revision,schema_version,client_id,client_seq,language,question_id,code,updated_by)
    VALUES ('week_10_pair_20',10,20,1,3,'interviewer-client',1,'javascript','focus-block-rollup@1',?,2)`,args:[JSON.stringify({code:'',board:{shapes:[]}})]});
  // The interviewer opens the room first, so the document exists.
  await getAuthorizedCodeDocument(db,{viewerId:INTERVIEWER,...RELAY_IDENTITY});
}
async function interview({admitted=false,locked=false}={}){
  await db.execute('DELETE FROM pair_interview_sessions');
  if(!admitted&&!locked) return;
  await db.execute({sql:`INSERT INTO pair_interview_sessions (week_id,pair_group_id,pair_user_a_id,pair_user_b_id,admission,admitted_at,
    editing_locked,revision,updated_by,created_at,updated_at) VALUES (10,20,1,2,?,${admitted?NOW:'NULL'},?,1,2,${NOW},${NOW})`,
  args:[admitted?'interviewer':null,locked?1:0]});
}

beforeEach(()=>{
  for(const name of [...RELAY_ENV_KEYS,'CIRCLE_MEMBERSHIP_ENABLED','MULTI_CIRCLE_CONTROL_PLANE_ENABLED','SECONDARY_CIRCLE_WORKSPACE_ENABLED','INTERVIEW_SESSION_ENABLED']) delete process.env[name];
  Object.assign(process.env,key.env);
  process.env.INTERVIEW_SESSION_ENABLED='true';
});
afterEach(()=>{
  db?.close(); db=null;
  if(directory) rmSync(directory,{recursive:true,force:true}); directory=null;
  for(const name of [...RELAY_ENV_KEYS,'INTERVIEW_SESSION_ENABLED']) delete process.env[name];
  if(originalJwt===undefined) delete process.env.JWT_SECRET; else process.env.JWT_SECRET=originalJwt;
});

test('a lobby or locked candidate gets the uniform 404 before any quota; the interviewer keeps a normal token',async()=>{
  await seed();
  for(const state of [{},{locked:true},{admitted:true,locked:true}]){
    await interview(state);
    const before=await quota();
    const denied=await token(CANDIDATE);
    assert.equal(denied.status,404,JSON.stringify(state)); assert.deepEqual(denied.body,{error:'pair not found'});
    assert.equal(denied.headers['cache-control'],'private, no-store');
    assert.equal(await quota(),before,'a denied candidate spends no token quota');
    const interviewer=await token(INTERVIEWER);
    assert.equal(interviewer.status,200);
    assert.ok(interviewer.body.expires_at-Math.floor(Date.now()/1000)>RELAY_CANDIDATE_TOKEN_TTL_SECONDS);
  }
});

test('a live unlocked candidate gets a short token that stops renewing once editing is locked',async()=>{
  await seed();
  await interview({admitted:true});
  const live=await token(CANDIDATE);
  assert.equal(live.status,200);
  const ttl=live.body.expires_at-Math.floor(Date.now()/1000);
  assert.ok(ttl<=RELAY_CANDIDATE_TOKEN_TTL_SECONDS&&ttl>RELAY_CANDIDATE_TOKEN_TTL_SECONDS-5,`candidate TTL ${ttl}`);
  const claims=JSON.parse(Buffer.from(live.body.token.split('.')[1],'base64url'));
  assert.equal(claims.exp,live.body.expires_at);
  await interview({admitted:true,locked:true});
  assert.equal((await token(CANDIDATE)).status,404,'renewal after the lock is refused');
  await interview({admitted:true});
  assert.equal((await token(CANDIDATE)).status,200,'unlock restores the relay');
  await db.execute(`UPDATE pair_session_controls SET remaining_ms=0 WHERE week_id=10`);
  await db.execute(`INSERT INTO pair_session_controls (week_id,pair_group_id,pair_user_a_id,pair_user_a_source,pair_user_b_id,pair_user_b_source,
    pair_user_c_id,candidate_user_id,candidate_source,timer_state,remaining_ms,anchor_at,revision,updated_by,updated_by_source,created_at,updated_at)
    VALUES (10,20,1,'auth',2,'auth',NULL,1,'auth','paused',0,NULL,1,2,'auth',${NOW},${NOW})`);
  for(const user of [CANDIDATE,INTERVIEWER]) assert.equal((await token(user)).status,404,'no relay after the interview ends');
});

test('a schedule-started room admits the candidate to the relay; a pending agreement does not',async()=>{
  await seed();
  const agree=offset=>db.execute({sql:`INSERT INTO pair_schedules (week_id,pair_group_id,proposed_times,agreed_time,created_at,updated_at)
    VALUES (10,20,'[]',strftime('%Y-%m-%dT%H:%M:%fZ','now',?),'x','x')
    ON CONFLICT(week_id,pair_group_id) DO UPDATE SET agreed_time=excluded.agreed_time`,args:[offset]});
  await agree('+60 seconds');
  assert.equal((await token(CANDIDATE)).status,404);
  await agree('-60 seconds');
  assert.equal((await token(CANDIDATE)).status,200);
});

test('document reads tell each browser its one-way relay direction in lobby mode only',async()=>{
  await seed();
  await interview({admitted:true});
  const interviewer=await documentGet(INTERVIEWER),candidate=await documentGet(CANDIDATE);
  assert.equal(interviewer.status,200); assert.equal(interviewer.body.realtime_relay,true);
  assert.equal(interviewer.body.realtime_relay_direction,'send');
  assert.equal(candidate.body.realtime_relay_direction,'receive');
  delete process.env.INTERVIEW_SESSION_ENABLED;
  const peer=await documentGet(CANDIDATE);
  assert.equal(peer.body.realtime_relay,true); assert.equal('realtime_relay_direction' in peer.body,false);
  const peerToken=await token(CANDIDATE);
  assert.equal(peerToken.status,200,'flag off: the locked row is ignored and peers keep the relay');
  assert.ok(peerToken.body.expires_at-Math.floor(Date.now()/1000)>RELAY_TOKEN_TTL_SECONDS-5);
});
