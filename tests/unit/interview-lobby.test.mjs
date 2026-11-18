import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, mock, test } from 'node:test';
import { createClient } from '@libsql/client';
import * as Y from 'yjs';

import { prepareMigrationConnection } from '../../db/migration-runner.js';
import { copyMigratedDatabaseSync, migratedTemplatePath } from '../support/migrated-db.mjs';
import { getAuthorizedCodeDocument, mergeAuthorizedCodeDocument, readCanonicalCodeForExecution } from '../../api/_code-document.js';
import {
  candidateCodeFence,
  candidateWorkspaceFence,
  interviewOpenFence,
  interviewStateSql,
  resolveInterviewMode,
} from '../../api/_interview-session.js';
import { parseSessionControlsMutation, SESSION_TIMER_DURATION_MS, SessionControlsInputError } from '../../api/_session-controls.js';

// Interview lobby, schedule auto-start, interviewer-owned question selection
// and candidate edit lock (#464, ID-99) against a real migrated SQLite file.
// Account 1 is pair slot A (default candidate); account 2 is the interviewer.
const VERSION_KEY='interview-lobby-test-secret-at-least-thirty-two-characters';
const ROOM='week_10_pair_20';
const IDENTITY={roomId:ROOM,weekId:10,pairGroupId:20,questionSlug:'focus-block-rollup',questionVersion:1,language:'javascript'};
const CANDIDATE=1,INTERVIEWER=2,OUTSIDER=9;
let currentDb=null,currentDirectory=null;

function authPayload(req){
  const value=Number(req?.headers?.['x-test-user']);
  return Number.isSafeInteger(value)&&value>0?{id:value,email:`user${value}@example.test`}:null;
}

mock.module('../../api/_db.js',{exports:{
  captureSentryException:()=>{},captureSentryMessage:()=>{},getAdminEmails:()=>new Set(),
  getClient:()=>currentDb,getJwtSecret:()=>VERSION_KEY,initSentry:()=>{},isSentryConfigured:()=>false,
  verifyMutationOrigin:()=>true,verifyRequestAuth:authPayload,verifySignedRequestAuth:authPayload,
}});

const {default:dataHandler}=await import('../../api/data.js');
const {default:videoHandler}=await import('../../api/video.js');
const {default:codeDocumentHandler}=await import('../../api/code-document.js');
await migratedTemplatePath();

function call(handler,{method='GET',url='/api/session-controls',query={},user=CANDIDATE,body={}}={}){
  return new Promise((resolve,reject)=>{
    let statusCode=200,settled=false;
    const headers={};
    const finish=value=>{ if(!settled){ settled=true; resolve({status:statusCode,headers,body:value}); } };
    const res={
      status(code){ statusCode=code; return this; },
      setHeader(name,value){ headers[String(name).toLowerCase()]=value; },
      json(value){ finish(value); return this; },end(value){ finish(value); return this; },
    };
    const req={method,url,query,headers:{'x-test-user':String(user)},body,socket:{remoteAddress:'127.0.0.1'}};
    Promise.resolve(handler(req,res)).then(()=>finish(undefined)).catch(reject);
  });
}

const controls=(user=CANDIDATE,room=ROOM)=>call(dataHandler,{user,query:{endpoint:'session-controls',room_id:room}});
const command=(user,action,version,extra={})=>call(dataHandler,{method:'POST',user,query:{endpoint:'session-controls'},
  body:{room_id:ROOM,action,base_version:version,...extra}});
async function state(user=CANDIDATE){ return (await controls(user)).body.session_controls; }
async function run(user,action,extra={}){
  const response=await command(user,action,(await state(user)).version,extra);
  return response;
}

async function seed(db,{workspace=true}={}){
  await db.execute(`INSERT INTO auth_accounts (id,email,password_hash,display_name,color,is_demo) VALUES
    (1,'one@example.test','hash','One','#111111',0),(2,'two@example.test','hash','Two','#222222',0),
    (9,'outside@example.test','hash','Outside','#999999',0)`);
  await db.execute(`INSERT INTO pairing_weeks (id,week_label,week_start,is_demo) VALUES (10,'2026-W38','2026-09-14T07:00:00.000Z',0)`);
  await db.execute(`INSERT INTO pairing_groups (id,week_id,user_a_id,user_b_id,user_c_id,is_ai_pair) VALUES (20,10,1,2,NULL,0)`);
  await db.execute(`INSERT INTO pairing_participants (week_id,user_id,position,source) VALUES (10,1,0,'auth'),(10,2,1,'auth')`);
  if(workspace){
    await db.execute({sql:`INSERT INTO pair_room_snapshots
      (room_id,week_id,pair_group_id,revision,schema_version,client_id,client_seq,language,question_id,code,updated_by)
      VALUES (?,10,20,4,3,'interviewer-client',4,'javascript','focus-block-rollup@1',?,2)`,
    args:[ROOM,JSON.stringify({code:'return base;',board:{shapes:[]}})]});
  }
}

async function freshDatabase(options){
  currentDirectory=mkdtempSync(join(tmpdir(),'randori-interview-lobby-'));
  const path=join(currentDirectory,'test.sqlite');
  copyMigratedDatabaseSync(path);
  currentDb=createClient({url:`file:${path}`});
  await prepareMigrationConnection(currentDb);
  await seed(currentDb,options);
  return currentDb;
}

// Agreed start relative to the SQLite clock, as the strict canonical instant
// the schedule API stores.
async function agreeAt(db,offsetMs){
  const now=String((await db.execute("SELECT strftime('%Y-%m-%dT%H:%M:%fZ','now') AS now")).rows[0].now);
  const instant=new Date(Date.parse(now)+offsetMs).toISOString();
  await db.execute({sql:`INSERT INTO pair_schedules (week_id,pair_group_id,proposed_times,agreed_time,created_at,updated_at)
    VALUES (10,20,'[]',?,?,?) ON CONFLICT(week_id,pair_group_id) DO UPDATE SET agreed_time=excluded.agreed_time`,
  args:[instant,now,now]});
  return instant;
}

const rows=async(table)=>(await currentDb.execute(`SELECT * FROM ${table} ORDER BY 1,2`)).rows.map(row=>({...row}));

function updateFrom(state,edit){
  const base=new Y.Doc(); Y.applyUpdate(base,Buffer.from(state,'base64'));
  const doc=new Y.Doc(); Y.applyUpdate(doc,Buffer.from(state,'base64'));
  const before=Y.encodeStateVector(base); edit(doc.getText('code'));
  return Buffer.from(Y.encodeStateAsUpdate(doc,before));
}

function merge(viewerId,update,{db=currentDb,clientSeq=1,identity=IDENTITY}={}){
  return mergeAuthorizedCodeDocument(db,{...identity,viewerId,update,clientId:`client_${viewerId}xyz`,clientSeq});
}

// Run `change` inside the caller's own transaction immediately before its
// first statement matching `pattern`: an earlier read cannot authorize the
// later storage statement.
function interleave(db,pattern,change){
  const seen=[];
  const wrap=target=>{
    const execute=target.execute.bind(target);
    target.execute=async statement=>{
      const sql=typeof statement==='string'?statement:statement.sql;
      if(!seen.length&&pattern.test(sql)){ seen.push({sql}); await change(execute); }
      const result=await execute(statement);
      if(seen.length===1&&!('rowsAffected' in seen[0])) seen[0].rowsAffected=Number(result.rowsAffected);
      return result;
    };
    return target;
  };
  const client={execute:db.execute.bind(db),async transaction(mode){ return wrap(await db.transaction(mode)); }};
  return {client,wrapped:wrap({execute:db.execute.bind(db),transaction:client.transaction}),seen};
}

function workspacePayload(overrides={}){
  return {schema_version:3,base_revision:4,client_id:'candidate-client',client_seq:1,language:'javascript',
    question_id:'focus-block-rollup',question_version:1,code:'return base;',board:{shapes:[]},...overrides};
}
const saveWorkspace=(user,payload)=>call(videoHandler,{method:'POST',url:'/api/video/signal',user,
  body:{room_id:ROOM,type:'code-sync',payload}});

beforeEach(()=>{ process.env.INTERVIEW_SESSION_ENABLED='true'; });
afterEach(()=>{
  delete process.env.INTERVIEW_SESSION_ENABLED;
  try{ currentDb?.close?.(); }catch{} currentDb=null;
  if(currentDirectory){ rmSync(currentDirectory,{recursive:true,force:true}); currentDirectory=null; }
});

test('lobby commands parse only in interview mode with exact fields',()=>{
  const base={room_id:ROOM,base_version:'a'.repeat(64)};
  for(const action of ['admit','lock_editing','unlock_editing']){
    assert.equal(parseSessionControlsMutation({...base,action},{interview:true}).action,action);
    assert.throws(()=>parseSessionControlsMutation({...base,action},{interview:false}),SessionControlsInputError);
    assert.throws(()=>parseSessionControlsMutation({...base,action,candidate_user_id:1},{interview:true}),SessionControlsInputError);
    assert.throws(()=>parseSessionControlsMutation({...base,action,question_id:'x'},{interview:true}),SessionControlsInputError);
  }
});

test('a room starts in the lobby: both participants see it and only the interviewer may edit',async()=>{
  await freshDatabase();
  const candidate=await state(CANDIDATE),interviewer=await state(INTERVIEWER);
  for(const view of [candidate,interviewer]){
    assert.equal(view.lobby_mode,true); assert.equal(view.phase,'lobby'); assert.equal(view.admission,null);
    assert.equal(view.editing_locked,false); assert.equal(view.scheduled_start_at,null);
    assert.equal(view.timer_state,'paused'); assert.equal(view.terminal,false);
  }
  assert.equal(candidate.viewer_role,'candidate'); assert.equal(candidate.can_edit,false); assert.equal(candidate.can_control,false);
  assert.equal(interviewer.viewer_role,'interviewer'); assert.equal(interviewer.can_edit,true); assert.equal(interviewer.can_control,true);
  assert.equal(candidate.version,interviewer.version);
  assert.deepEqual(await rows('pair_interview_sessions'),[],'reading never writes interview state');
  const start=await run(INTERVIEWER,'start');
  assert.equal(start.status,409); assert.equal(start.body.code,'interview_lobby');
  assert.equal(start.body.session_controls.phase,'lobby');
  const handoff=await run(INTERVIEWER,'set_candidate',{candidate_user_id:CANDIDATE});
  assert.equal(handoff.status,200,'roles may still be arranged in the lobby');
  assert.deepEqual(await rows('pair_interview_sessions'),[]);
});

test('a candidate, an outsider and a wrong room cannot admit, lock or unlock, even as no-ops',async()=>{
  await freshDatabase();
  const candidate=await state(CANDIDATE);
  const before={controls:await rows('pair_session_controls'),interview:await rows('pair_interview_sessions')};
  for(const action of ['admit','lock_editing','unlock_editing']){
    for(const version of [candidate.version,'b'.repeat(64)]){
      for(const user of [CANDIDATE,OUTSIDER]){
        const denied=await command(user,action,version);
        assert.equal(denied.status,404,`${user} ${action}`); assert.deepEqual(denied.body,{error:'pair not found'});
        assert.equal(denied.headers['cache-control'],'private, no-store');
      }
    }
    const wrongRoom=await call(dataHandler,{method:'POST',user:INTERVIEWER,query:{endpoint:'session-controls'},
      body:{room_id:'week_10_pair_999',action,base_version:candidate.version}});
    assert.equal(wrongRoom.status,404); assert.deepEqual(wrongRoom.body,{error:'pair not found'});
    const forged=await call(dataHandler,{method:'POST',user:CANDIDATE,query:{endpoint:'session-controls'},
      body:{room_id:ROOM,action,base_version:candidate.version,viewer_role:'interviewer'}});
    assert.equal(forged.status,400);
  }
  // The candidate cannot reach the lock through a later admission either.
  assert.equal((await run(INTERVIEWER,'admit')).status,200);
  const locked=await run(INTERVIEWER,'lock_editing');
  assert.equal(locked.status,200);
  const unlock=await command(CANDIDATE,'unlock_editing',locked.body.session_controls.version);
  assert.equal(unlock.status,404);
  assert.equal((await state(CANDIDATE)).editing_locked,true);
  assert.deepEqual(before.controls,await rows('pair_session_controls'));
});

test('the interviewer admits from the lobby; admit is idempotent and stale lock versions conflict',async()=>{
  await freshDatabase();
  const lobby=await state(INTERVIEWER);
  const admitted=await command(INTERVIEWER,'admit',lobby.version);
  assert.equal(admitted.status,200);
  const live=admitted.body.session_controls;
  assert.equal(live.phase,'live'); assert.equal(live.admission,'interviewer'); assert.equal(live.timer_state,'paused');
  const repeat=await command(INTERVIEWER,'admit',lobby.version);
  assert.equal(repeat.status,200); assert.equal(repeat.body.session_controls.version,live.version,'a repeated admit writes nothing');
  const stale=await command(INTERVIEWER,'lock_editing',lobby.version);
  assert.equal(stale.status,409); assert.equal(stale.body.code,'session_controls_changed');
  const candidate=await state(CANDIDATE);
  assert.equal(candidate.phase,'live'); assert.equal(candidate.can_edit,true);
  const stored=await rows('pair_interview_sessions');
  assert.equal(stored.length,1); assert.equal(stored[0].admission,'interviewer'); assert.equal(stored[0].updated_by,INTERVIEWER);
  assert.equal((await run(INTERVIEWER,'start')).status,200,'the timer is usable once admitted');
});

test('lock and unlock are interviewer-owned durable state and end the same way as every control',async()=>{
  await freshDatabase();
  await run(INTERVIEWER,'admit');
  const locked=(await run(INTERVIEWER,'lock_editing')).body.session_controls;
  assert.equal(locked.editing_locked,true); assert.equal(locked.can_edit,true,'the interviewer can still edit');
  const candidateLocked=await state(CANDIDATE);
  assert.equal(candidateLocked.editing_locked,true); assert.equal(candidateLocked.can_edit,false);
  const again=await command(INTERVIEWER,'lock_editing',locked.version);
  assert.equal(again.status,200); assert.equal(again.body.session_controls.version,locked.version);
  const unlocked=(await run(INTERVIEWER,'unlock_editing')).body.session_controls;
  assert.equal(unlocked.editing_locked,false); assert.equal((await state(CANDIDATE)).can_edit,true);
  // The lock can be pre-set in the lobby of another room shape too: it survives admission.
  const ended=await run(INTERVIEWER,'end');
  assert.equal(ended.status,200); assert.equal(ended.body.session_controls.phase,'ended');
  const after=await state(CANDIDATE);
  assert.equal(after.terminal,true); assert.equal(after.can_edit,false); assert.equal(after.end_reason,'interviewer_ended');
  const stored=await rows('pair_interview_sessions');
  for(const action of ['admit','lock_editing','unlock_editing','start','end']){
    const rejected=await command(INTERVIEWER,action,after.version);
    assert.equal(rejected.status,409,action); assert.equal(rejected.body.code,'interview_session_ended');
  }
  assert.deepEqual(await rows('pair_interview_sessions'),stored);
});

test('a lock set in the lobby holds after admission, and ending from the lobby closes it',async()=>{
  await freshDatabase();
  assert.equal((await run(INTERVIEWER,'lock_editing')).status,200);
  assert.equal((await state(CANDIDATE)).phase,'lobby');
  const admitted=(await run(INTERVIEWER,'admit')).body.session_controls;
  assert.equal(admitted.phase,'live'); assert.equal(admitted.editing_locked,true);
  assert.equal((await state(CANDIDATE)).can_edit,false);
  await currentDb.execute('DELETE FROM pair_interview_sessions');
  const lobby=await state(INTERVIEWER);
  assert.equal(lobby.phase,'lobby');
  const ended=await command(INTERVIEWER,'end',lobby.version);
  assert.equal(ended.status,200); assert.equal(ended.body.session_controls.phase,'ended');
  assert.equal((await state(CANDIDATE)).phase,'ended','a no-show candidate joining late sees the ended room');
});

test('the agreed schedule starts the interview automatically with late join, using database time and no writes',async()=>{
  await freshDatabase();
  const future=await agreeAt(currentDb,10*60*1000);
  const waiting=await state(CANDIDATE);
  assert.equal(waiting.phase,'lobby'); assert.equal(waiting.scheduled_start_at,future);
  const started=await agreeAt(currentDb,-10*60*1000);
  for(const user of [CANDIDATE,INTERVIEWER]){
    const view=await state(user);
    assert.equal(view.phase,'live'); assert.equal(view.admission,'schedule'); assert.equal(view.scheduled_start_at,started);
    assert.equal(view.timer_state,'running');
    assert.ok(view.remaining_ms<=15*60*1000&&view.remaining_ms>14*60*1000,`late join sees the schedule's remaining time: ${view.remaining_ms}`);
  }
  assert.equal((await state(CANDIDATE)).can_edit,true);
  assert.deepEqual(await rows('pair_session_controls'),[],'auto-start derives state; it needs no cron or per-poll write');
  assert.deepEqual(await rows('pair_interview_sessions'),[]);
  const elapsed=await agreeAt(currentDb,-(SESSION_TIMER_DURATION_MS+1000));
  for(const user of [CANDIDATE,INTERVIEWER]){
    const view=await state(user);
    assert.equal(view.phase,'ended'); assert.equal(view.terminal,true); assert.equal(view.end_reason,'timer_expired');
    assert.equal(view.remaining_ms,0); assert.equal(view.scheduled_start_at,elapsed);
  }
  const reopen=await run(INTERVIEWER,'reset');
  assert.equal(reopen.status,409); assert.equal(reopen.body.code,'interview_session_ended');
  assert.deepEqual(await rows('pair_session_controls'),[]);
});

test('the scheduled start crosses the lobby boundary on the SQLite clock for reads and storage fences',async()=>{
  await freshDatabase();
  const initial=(await getAuthorizedCodeDocument(currentDb,{viewerId:INTERVIEWER,...IDENTITY})).document;
  const update=updateFrom(initial.state,text=>text.insert(0,'candidate;'));
  await agreeAt(currentDb,500);
  assert.equal((await state(CANDIDATE)).phase,'lobby');
  assert.equal((await merge(CANDIDATE,update)).editingClosed,true,'just before the agreed start the candidate is still in the lobby');
  await new Promise(resolve=>setTimeout(resolve,700));
  assert.equal((await state(CANDIDATE)).phase,'live');
  const merged=await merge(CANDIDATE,update,{clientSeq:2});
  assert.equal(merged.idempotent,false); assert.match(merged.document.code,/^candidate;/);
});

test('the first command after a scheduled start freezes it, so a later schedule edit cannot rewind the room',async()=>{
  await freshDatabase();
  const start=await agreeAt(currentDb,-60*1000);
  const derived=await state(INTERVIEWER);
  assert.equal(derived.phase,'live');
  const locked=await command(INTERVIEWER,'lock_editing',derived.version);
  assert.equal(locked.status,200);
  const view=locked.body.session_controls;
  assert.equal(view.phase,'live'); assert.equal(view.admission,'schedule'); assert.equal(view.editing_locked,true);
  assert.ok(view.remaining_ms<SESSION_TIMER_DURATION_MS);
  const [timer]=await rows('pair_session_controls');
  assert.equal(timer.timer_state,'running'); assert.equal(timer.anchor_at,start); assert.equal(timer.remaining_ms,SESSION_TIMER_DURATION_MS);
  const [admission]=await rows('pair_interview_sessions');
  assert.equal(admission.admission,'schedule'); assert.equal(admission.admitted_at,start); assert.equal(admission.editing_locked,1);
  await currentDb.execute('DELETE FROM pair_schedules');
  const after=await state(CANDIDATE);
  assert.equal(after.phase,'live'); assert.equal(after.admission,'schedule'); assert.equal(after.scheduled_start_at,null);
});

test('clearing or replacing an arrived agreement through the schedule API freezes the start first',async()=>{
  for(const ended of [false,true]){
    await freshDatabase();
    await agreeAt(currentDb,ended?-(SESSION_TIMER_DURATION_MS+5000):-60*1000);
    const schedule=(await call(dataHandler,{url:'/api/schedule',user:CANDIDATE,query:{endpoint:'schedule',room_id:ROOM}})).body.schedule;
    const cleared=await call(dataHandler,{method:'POST',url:'/api/schedule',user:CANDIDATE,query:{endpoint:'schedule'},
      body:{room_id:ROOM,action:'clear',base_version:schedule.version}});
    assert.equal(cleared.status,200,JSON.stringify(cleared.body)); assert.equal(cleared.body.schedule.agreed_time,null);
    const view=await state(INTERVIEWER);
    assert.equal(view.phase,ended?'ended':'live',`clearing must not return the room to the lobby (ended=${ended})`);
    assert.equal(view.admission,'schedule');
    if(ended) assert.equal(view.end_reason,'timer_expired');
    const frozen=await rows('pair_interview_sessions'),[timer]=await rows('pair_session_controls');
    assert.equal(frozen.length,1);
    assert.equal(frozen[0].updated_by,INTERVIEWER,'the candidate edited the schedule, but the freeze is attributed to the interviewer');
    assert.equal(timer.updated_by,INTERVIEWER);
    currentDb.close(); rmSync(currentDirectory,{recursive:true,force:true}); currentDb=null; currentDirectory=null;
  }
});

test('an admit racing the agreed start leaves the scheduled timer in charge',async()=>{
  await freshDatabase();
  await agreeAt(currentDb,-1000);
  const live=await state(INTERVIEWER);
  const admit=await command(INTERVIEWER,'admit',live.version);
  assert.equal(admit.status,200); assert.equal(admit.body.session_controls.admission,'schedule');
  assert.deepEqual(await rows('pair_interview_sessions'),[],'admitting a live room is a no-op');
  // A lobby read just before the start, then an admit statement after it:
  // the storage guard re-evaluates the lobby and refuses the late admission.
  await currentDb.execute('DELETE FROM pair_schedules');
  const lobby=await state(INTERVIEWER);
  const raced=interleave(currentDb,/INSERT INTO pair_interview_sessions/,async execute=>{
    await execute({sql:`INSERT INTO pair_schedules (week_id,pair_group_id,proposed_times,agreed_time,created_at,updated_at)
      VALUES (10,20,'[]',strftime('%Y-%m-%dT%H:%M:%fZ','now','-1 seconds'),'x','x')`});
  });
  const {mutateAuthorizedSessionControls}=await import('../../api/_session-controls.js');
  await assert.rejects(mutateAuthorizedSessionControls(raced.client,{viewerId:INTERVIEWER,versionKey:VERSION_KEY,
    mutation:{roomId:ROOM,weekId:10,pairGroupId:20,action:'admit',baseVersion:lobby.version,candidateUserId:null}}),
  error=>error.code==='session_controls_changed'&&error.state.phase==='live'&&error.state.admission==='schedule');
  assert.equal(raced.seen[0].rowsAffected,0);
  assert.deepEqual(await rows('pair_interview_sessions'),[]);
});

test('candidate CRDT bootstrap, merges and projections are fenced by the lobby and the lock; the interviewer is not',async()=>{
  await freshDatabase();
  const fresh=new Y.Doc(); fresh.getText('code').insert(0,'lobby;');
  const created=Buffer.from(Y.encodeStateAsUpdate(fresh));
  assert.deepEqual(await getAuthorizedCodeDocument(currentDb,{viewerId:CANDIDATE,...IDENTITY}),{lobby:true},
    'no candidate bootstrap (or read) in the lobby');
  assert.deepEqual(await merge(CANDIDATE,created),{editingClosed:true});
  assert.deepEqual(await rows('pair_code_documents'),[]);
  const initial=(await getAuthorizedCodeDocument(currentDb,{viewerId:INTERVIEWER,...IDENTITY})).document;
  await run(INTERVIEWER,'admit');
  const candidateRead=await getAuthorizedCodeDocument(currentDb,{viewerId:CANDIDATE,...IDENTITY});
  assert.equal(candidateRead.document.revision,initial.revision);
  await run(INTERVIEWER,'lock_editing');
  const held=updateFrom(initial.state,text=>text.insert(0,'held;'));
  const documents=await rows('pair_code_documents'),workspace=await rows('pair_room_snapshots');
  assert.deepEqual(await merge(CANDIDATE,held),{editingClosed:true},'locked candidate edits are held, not merged');
  assert.deepEqual(await rows('pair_code_documents'),documents);
  assert.deepEqual(await rows('pair_room_snapshots'),workspace);
  const reading=await getAuthorizedCodeDocument(currentDb,{viewerId:CANDIDATE,...IDENTITY,afterRevision:initial.revision});
  assert.equal(reading.document.revision,initial.revision,'a locked candidate can still read');
  const interviewer=await merge(INTERVIEWER,updateFrom(initial.state,text=>text.insert(0,'interviewer;')));
  assert.equal(interviewer.idempotent,false,'the interviewer edits while the candidate is locked');
  await run(INTERVIEWER,'unlock_editing');
  const replayed=await merge(CANDIDATE,held,{clientSeq:2});
  assert.equal(replayed.idempotent,false);
  assert.match(replayed.document.code,/held;/); assert.match(replayed.document.code,/interviewer;/,'the held edit merges with the interviewer edit');
  const snapshot=JSON.parse(String((await rows('pair_room_snapshots'))[0].code));
  assert.equal(snapshot.code,replayed.document.code,'the replayed edit reaches the workspace projection');
});

test('a candidate cannot edit or bootstrap a question the interviewer has not selected',async()=>{
  await freshDatabase();
  await run(INTERVIEWER,'admit');
  const other={...IDENTITY,language:'python'};
  assert.deepEqual(await getAuthorizedCodeDocument(currentDb,{viewerId:CANDIDATE,...other}),{editingClosed:true});
  const doc=new Y.Doc(); doc.getText('code').insert(0,'x=1');
  assert.deepEqual(await merge(CANDIDATE,Buffer.from(Y.encodeStateAsUpdate(doc)),{identity:other}),{editingClosed:true});
  assert.equal((await getAuthorizedCodeDocument(currentDb,{viewerId:INTERVIEWER,...other})).created,true);
  assert.deepEqual(await merge(CANDIDATE,Buffer.from(Y.encodeStateAsUpdate(doc)),{identity:other}),{editingClosed:true},
    'an existing document of another question is still not the room selection');
});

test('a lock that lands inside the candidate transaction is enforced by the storage statements themselves',async()=>{
  for(const pattern of [/UPDATE pair_code_documents/,/UPDATE pair_room_snapshots/,/INSERT INTO pair_code_documents/]){
    await freshDatabase();
    await run(INTERVIEWER,'admit');
    let update;
    if(pattern.source.startsWith('INSERT')){
      const doc=new Y.Doc(); doc.getText('code').insert(0,'race;'); update=Buffer.from(Y.encodeStateAsUpdate(doc));
    }else{
      const initial=(await getAuthorizedCodeDocument(currentDb,{viewerId:INTERVIEWER,...IDENTITY})).document;
      update=updateFrom(initial.state,text=>text.insert(0,'race;'));
    }
    const documents=await rows('pair_code_documents'),workspace=await rows('pair_room_snapshots');
    const raced=interleave(currentDb,pattern,execute=>execute(`UPDATE pair_interview_sessions SET editing_locked=1,
      revision=revision+1,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')`));
    assert.deepEqual(await merge(CANDIDATE,update,{db:raced.client}),{editingClosed:true},pattern.source);
    assert.equal(raced.seen.length,1); assert.equal(raced.seen[0].rowsAffected,0,`${pattern.source} is rejected in SQL`);
    assert.deepEqual(await rows('pair_code_documents'),documents,'the whole candidate write rolls back');
    assert.deepEqual(await rows('pair_room_snapshots'),workspace);
    assert.equal((await rows('pair_interview_sessions'))[0].editing_locked,0,'the racing lock rolled back with it');
    currentDb.close(); rmSync(currentDirectory,{recursive:true,force:true}); currentDb=null; currentDirectory=null;
  }
});

test('the code-document API reports held candidate edits with a stable private 409',async()=>{
  await freshDatabase();
  const read=()=>call(codeDocumentHandler,{url:`/api/code-document?room_id=${ROOM}&question_slug=focus-block-rollup&question_version=1&language=javascript`,
    query:{room_id:ROOM,question_slug:'focus-block-rollup',question_version:'1',language:'javascript'},user:CANDIDATE});
  const lobby=await read();
  assert.equal(lobby.status,409); assert.equal(lobby.body.code,'interview_lobby');
  assert.equal(lobby.headers['cache-control'],'private, no-store');
  await run(INTERVIEWER,'admit'); await run(INTERVIEWER,'lock_editing');
  const locked=await read();
  assert.equal(locked.status,409); assert.equal(locked.body.code,'interview_editing_locked','a locked candidate cannot bootstrap a document');
  assert.equal(locked.headers['cache-control'],'private, no-store');
  const doc=new Y.Doc(); doc.getText('code').insert(0,'held');
  const post=await call(codeDocumentHandler,{method:'POST',url:'/api/code-document',user:CANDIDATE,body:{room_id:ROOM,
    question_slug:'focus-block-rollup',question_version:1,language:'javascript',update:Buffer.from(Y.encodeStateAsUpdate(doc)).toString('base64'),
    client_id:'candidate_client',client_seq:1}});
  assert.equal(post.status,409); assert.equal(post.body.code,'interview_editing_locked');
});

test('only the interviewer chooses the room question and language; candidate checkpoints follow the lobby and lock',async()=>{
  await freshDatabase();
  const lobby=await saveWorkspace(CANDIDATE,workspacePayload({board:{shapes:[{id:'t1',type:'text',x:1,y:1,text:'hi',color:'#ffffff',size:16}]}}));
  assert.equal(lobby.status,409); assert.equal(lobby.body.code,'interview_lobby');
  await run(INTERVIEWER,'admit');
  for(const change of [{language:'python'},{question_id:'two-sum',question_version:1}]){
    const denied=await saveWorkspace(CANDIDATE,workspacePayload(change));
    assert.equal(denied.status,409); assert.equal(denied.body.code,'interview_selection_owned');
    assert.equal(denied.body.current.language,'javascript');
  }
  const board=await saveWorkspace(CANDIDATE,workspacePayload({board:{shapes:[{id:'t1',type:'text',x:1,y:1,text:'hi',color:'#ffffff',size:16}]}}));
  assert.equal(board.status,200,'the candidate keeps the shared board on the selected question');
  await run(INTERVIEWER,'lock_editing');
  const code=await saveWorkspace(CANDIDATE,workspacePayload({base_revision:5,client_seq:2,code:'return changed;'}));
  assert.equal(code.status,409); assert.equal(code.body.code,'interview_editing_locked');
  const switched=await saveWorkspace(INTERVIEWER,workspacePayload({base_revision:5,client_id:'interviewer-client',client_seq:9,language:'python',code:''}));
  assert.equal(switched.status,200,'the interviewer changes the selection, locked or not');
  assert.equal(switched.body.snapshot.language,'python');
});

test('a candidate never creates the room checkpoint and a racing lock is enforced in the workspace write',async()=>{
  await freshDatabase({workspace:false});
  await run(INTERVIEWER,'admit');
  const first=await saveWorkspace(CANDIDATE,workspacePayload({base_revision:0}));
  assert.equal(first.status,409); assert.equal(first.body.code,'interview_selection_owned');
  assert.equal((await saveWorkspace(INTERVIEWER,workspacePayload({base_revision:0,client_id:'interviewer-client'}))).status,200);
  const raced=interleave(currentDb,/UPDATE pair_room_snapshots/,execute=>execute(`UPDATE pair_interview_sessions SET editing_locked=1,
    revision=revision+1,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')`));
  const original=currentDb; currentDb=raced.wrapped;
  try{
    const denied=await saveWorkspace(CANDIDATE,workspacePayload({base_revision:1,client_seq:3,code:'return raced;'}));
    assert.equal(denied.status,409); assert.equal(denied.body.code,'interview_editing_locked');
    assert.equal(raced.seen[0].rowsAffected,0);
  }finally{ currentDb=original; }
  assert.equal(JSON.parse(String((await rows('pair_room_snapshots'))[0].code)).code,'return base;');
});

test('flag off and a not-yet-applied migration 26 keep the earlier behaviour exactly',async()=>{
  await freshDatabase();
  delete process.env.INTERVIEW_SESSION_ENABLED;
  const peer=await state(CANDIDATE);
  for(const key of ['interview_mode','lobby_mode','phase','editing_locked','can_edit']) assert.equal(key in peer,false);
  assert.equal((await command(CANDIDATE,'admit',peer.version)).status,400);
  assert.equal((await saveWorkspace(CANDIDATE,workspacePayload({language:'python'}))).status,200,'flag off: peers share the selection');
  const doc=new Y.Doc(); doc.getText('code').insert(0,'x=1');
  assert.equal((await merge(CANDIDATE,Buffer.from(Y.encodeStateAsUpdate(doc)),{identity:{...IDENTITY,language:'python'}})).idempotent,false);
  assert.deepEqual(await resolveInterviewMode(currentDb),{interview:false,lobby:false});
  assert.deepEqual(interviewOpenFence({interview:false},IDENTITY),{sql:'1',args:[]});
  assert.deepEqual(candidateCodeFence({interview:true,lobby:false},{...IDENTITY,actorId:1}),{sql:'1',args:[]});
  assert.deepEqual(candidateWorkspaceFence({interview:true,lobby:false},{...IDENTITY,actorId:1}),{sql:'1',args:[]});

  process.env.INTERVIEW_SESSION_ENABLED='true';
  // Code at v26 on a v25 database (ID-87): the flag gives ID-95 behaviour only.
  const path=join(currentDirectory,'v25.sqlite');
  copyMigratedDatabaseSync(path);
  const v25=createClient({url:`file:${path}`});
  try{
    await prepareMigrationConnection(v25);
    await v25.batch(['DROP TRIGGER trg_pair_interview_sessions_insert_guard','DROP TRIGGER trg_pair_interview_sessions_update_guard',
      'DROP INDEX idx_pair_interview_sessions_updated_by','DROP TABLE pair_interview_sessions',
      'DELETE FROM schema_migrations WHERE version=26'],'write');
    await seed(v25);
    assert.deepEqual(await resolveInterviewMode(v25),{interview:true,lobby:false});
    const original=currentDb; currentDb=v25;
    try{
      const view=await state(CANDIDATE);
      assert.equal(view.interview_mode,true); assert.equal('lobby_mode' in view,false);
      assert.equal((await command(INTERVIEWER,'admit',view.version)).status,400);
      assert.equal((await run(INTERVIEWER,'start')).status,200,'ID-95 manual start, no lobby');
      assert.equal((await saveWorkspace(CANDIDATE,workspacePayload({language:'python'}))).status,200);
    }finally{ currentDb=original; }
  }finally{ v25.close(); }
});

test('the SQL state projection and the JS projection agree on lobby, live and ended',async()=>{
  await freshDatabase();
  const sqlState=async()=>({...(await currentDb.execute({sql:interviewStateSql(),args:[10,20]})).rows[0]});
  const cases=[
    [async()=>{},'lobby'],
    [async()=>{ await agreeAt(currentDb,60*1000); },'lobby'],
    [async()=>{ await agreeAt(currentDb,-60*1000); },'live'],
    [async()=>{ await agreeAt(currentDb,-(SESSION_TIMER_DURATION_MS+1)); },'ended'],
  ];
  for(const [arrange,expected] of cases){
    await arrange();
    const sql=await sqlState(),view=await state(CANDIDATE);
    assert.equal(view.phase,expected);
    assert.equal(Number(sql.ended)===1,expected==='ended');
    assert.equal(Number(sql.live)===1,expected!=='lobby');
  }
});

test('the lobby closes new candidate execution lookups; the lock does not stop runs of the shared code',async()=>{
  await freshDatabase();
  const document=(await getAuthorizedCodeDocument(currentDb,{viewerId:INTERVIEWER,...IDENTITY})).document;
  const lookup=viewerId=>readCanonicalCodeForExecution(currentDb,{viewerId,room:IDENTITY,questionSlug:IDENTITY.questionSlug,
    questionVersion:1,language:'javascript',documentVersion:document.version});
  assert.equal((await lookup(CANDIDATE)).lobby,true);
  assert.equal((await lookup(INTERVIEWER)).stale,false);
  await run(INTERVIEWER,'admit'); await run(INTERVIEWER,'lock_editing');
  const candidate=await lookup(CANDIDATE);
  assert.equal(candidate.lobby,undefined); assert.equal(candidate.stale,false);
});

test('a candidate in the lobby sees the selection but not the interviewer\'s prepared code or board',async()=>{
  await freshDatabase();
  await currentDb.execute({sql:'UPDATE pair_room_snapshots SET code=? WHERE room_id=?',
    args:[JSON.stringify({code:'// prepared hint',board:{shapes:[{id:'t1',type:'text',x:1,y:1,text:'secret',color:'#ffffff',size:16}]}}),ROOM]});
  const prepared=(await getAuthorizedCodeDocument(currentDb,{viewerId:INTERVIEWER,...IDENTITY})).document;
  assert.match(prepared.code,/prepared hint/);
  const read=(user,after=0)=>call(videoHandler,{url:`/api/video/signal?room_id=${ROOM}&channel=workspace&after_revision=${after}`,
    query:{room_id:ROOM,channel:'workspace',after_revision:String(after)},user});
  const lobby=(await read(CANDIDATE)).body;
  assert.equal(lobby.lobby,true); assert.equal(lobby.revision,0);
  assert.equal(lobby.snapshot.question_id,'focus-block-rollup'); assert.equal(lobby.snapshot.language,'javascript');
  assert.equal(lobby.snapshot.code,''); assert.deepEqual(lobby.snapshot.board,{shapes:[]});
  assert.equal((await read(CANDIDATE,5)).body.snapshot,null);
  assert.match((await read(INTERVIEWER)).body.snapshot.code,/prepared hint/,'the interviewer reads normally');
  for(const afterRevision of [0,prepared.revision]){
    assert.deepEqual(await getAuthorizedCodeDocument(currentDb,{viewerId:CANDIDATE,...IDENTITY,afterRevision}),{lobby:true});
  }
  const api=await call(codeDocumentHandler,{url:`/api/code-document?room_id=${ROOM}&question_slug=focus-block-rollup&question_version=1&language=javascript&after_revision=0`,
    query:{room_id:ROOM,question_slug:'focus-block-rollup',question_version:'1',language:'javascript',after_revision:'0'},user:CANDIDATE});
  assert.equal(api.status,409); assert.deepEqual(api.body,{ok:false,code:'interview_lobby',error:'Waiting for the interviewer to admit you.'});
  await run(INTERVIEWER,'admit');
  const admitted=(await read(CANDIDATE)).body;
  assert.equal(admitted.lobby,undefined); assert.ok(admitted.revision>0);
  assert.match(admitted.snapshot.code,/prepared hint/); assert.equal(admitted.snapshot.board.shapes.length,1);
  assert.match((await getAuthorizedCodeDocument(currentDb,{viewerId:CANDIDATE,...IDENTITY})).document.code,/prepared hint/);
});

test('a scheduled start that changes under the freeze answers 409, never 503',async()=>{
  await freshDatabase();
  await agreeAt(currentDb,-60*1000);
  const sneak=execute=>execute(`INSERT INTO pair_interview_sessions (week_id,pair_group_id,pair_user_a_id,pair_user_b_id,
    admission,admitted_at,editing_locked,revision,updated_by,created_at,updated_at)
    VALUES (10,20,1,2,'interviewer',strftime('%Y-%m-%dT%H:%M:%fZ','now'),0,1,2,strftime('%Y-%m-%dT%H:%M:%fZ','now'),strftime('%Y-%m-%dT%H:%M:%fZ','now'))`);
  const schedule=(await call(dataHandler,{url:'/api/schedule',user:CANDIDATE,query:{endpoint:'schedule',room_id:ROOM}})).body.schedule;
  const raced=interleave(currentDb,/INSERT INTO pair_session_controls/,sneak);
  const original=currentDb; currentDb=raced.wrapped;
  let response;
  try{
    response=await call(dataHandler,{method:'POST',url:'/api/schedule',user:CANDIDATE,query:{endpoint:'schedule'},
      body:{room_id:ROOM,action:'clear',base_version:schedule.version}});
  }finally{ currentDb=original; }
  assert.equal(raced.seen[0].rowsAffected,0);
  assert.equal(response.status,409); assert.equal(response.body.error,'schedule changed');
  assert.ok(response.body.schedule.agreed_time,'the agreement was not cleared');
  assert.deepEqual(await rows('pair_interview_sessions'),[]);
  const live=await state(INTERVIEWER);
  const racedControls=interleave(currentDb,/INSERT INTO pair_session_controls/,sneak);
  const {mutateAuthorizedSessionControls}=await import('../../api/_session-controls.js');
  await assert.rejects(mutateAuthorizedSessionControls(racedControls.client,{viewerId:INTERVIEWER,versionKey:VERSION_KEY,
    mutation:{roomId:ROOM,weekId:10,pairGroupId:20,action:'lock_editing',baseVersion:live.version,candidateUserId:null}}),
  error=>error.code==='session_controls_changed');
  assert.deepEqual(await rows('pair_session_controls'),[]);
});
