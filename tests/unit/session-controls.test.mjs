import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, mock, test } from 'node:test';
import { createClient } from '@libsql/client';

import {
  mutateAuthorizedSessionControls,
  parseSessionControlsMutation,
  parseSessionControlsQuery,
  projectSessionControls,
  readAuthorizedSessionControls,
  SESSION_TIMER_DURATION_MS,
  SessionControlsConflictError,
  SessionControlsInputError,
} from '../../api/_session-controls.js';

let currentDb=null;
let currentDirectory=null;
const VERSION_KEY='session-controls-test-secret-at-least-thirty-two-characters';

function authPayload(req){
  const identity=req?.headers?.['x-test-auth'];
  if(identity==='member') return {id:2,email:'member@example.test'};
  if(identity==='partner') return {id:4,email:'partner@example.test'};
  if(identity==='third') return {id:6,email:'third@example.test'};
  if(identity==='outsider') return {id:9,email:'outsider@example.test'};
  return null;
}

mock.module('../../api/_db.js',{exports:{
  captureSentryException:()=>{},captureSentryMessage:()=>{},getAdminEmails:()=>new Set(),
  getClient:()=>currentDb,getJwtSecret:()=>VERSION_KEY,initSentry:()=>{},isSentryConfigured:()=>false,
  verifyMutationOrigin:()=>true,verifyRequestAuth:authPayload,verifySignedRequestAuth:authPayload,
}});

const {default:dataHandler}=await import('../../api/data.js');

function invoke({method='GET',url='/api/session-controls',query={endpoint:'session-controls',room_id:'week_10_pair_20'},headers={'x-test-auth':'member'},body={}}={}){
  return new Promise((resolve,reject)=>{
    let statusCode=200,settled=false;
    const responseHeaders={};
    const finish=value=>{ if(!settled){ settled=true; resolve({status:statusCode,headers:responseHeaders,body:value}); } };
    const res={
      status(code){ statusCode=code; return this; },
      setHeader(name,value){ responseHeaders[String(name).toLowerCase()]=value; },
      json(value){ finish(value); return this; },end(value){ finish(value); return this; },
    };
    const req={method,url,query,headers,body,socket:{remoteAddress:'127.0.0.1'}};
    Promise.resolve(dataHandler(req,res)).then(()=>finish(undefined)).catch(reject);
  });
}

async function readyDatabase(){
  currentDirectory=mkdtempSync(join(tmpdir(),'randori-session-controls-'));
  const db=createClient({url:`file:${join(currentDirectory,'test.sqlite')}`});
  await db.batch([
    `CREATE TABLE auth_accounts (id INTEGER PRIMARY KEY,display_name TEXT NOT NULL,is_demo INTEGER NOT NULL DEFAULT 0)`,
    `CREATE TABLE users (id INTEGER PRIMARY KEY,name TEXT NOT NULL)`,
    `CREATE TABLE pairing_groups (id INTEGER PRIMARY KEY,week_id INTEGER NOT NULL,user_a_id INTEGER NOT NULL,user_b_id INTEGER NOT NULL,user_c_id INTEGER,is_ai_pair INTEGER)`,
    `CREATE TABLE pairing_participants (week_id INTEGER NOT NULL,user_id INTEGER NOT NULL,source TEXT NOT NULL,PRIMARY KEY(week_id,user_id))`,
    `CREATE TABLE session_completion_receipts (week_id INTEGER NOT NULL,pair_group_id INTEGER NOT NULL,user_id INTEGER NOT NULL,participant_source TEXT NOT NULL,pair_user_a_id INTEGER NOT NULL,pair_user_b_id INTEGER NOT NULL,pair_user_c_id INTEGER,confirmed_at TEXT NOT NULL,PRIMARY KEY(week_id,pair_group_id,user_id))`,
    `CREATE TABLE pair_session_controls (week_id INTEGER NOT NULL,pair_group_id INTEGER NOT NULL,pair_user_a_id INTEGER NOT NULL,pair_user_a_source TEXT NOT NULL,pair_user_b_id INTEGER NOT NULL,pair_user_b_source TEXT NOT NULL,pair_user_c_id INTEGER,candidate_user_id INTEGER NOT NULL,candidate_source TEXT NOT NULL,timer_state TEXT NOT NULL,remaining_ms INTEGER NOT NULL,anchor_at TEXT,revision INTEGER NOT NULL,updated_by INTEGER NOT NULL,updated_by_source TEXT NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,PRIMARY KEY(week_id,pair_group_id))`,
    `INSERT INTO auth_accounts (id,display_name) VALUES (2,'Member'),(4,'Partner'),(6,'Third'),(9,'Outsider')`,
    `INSERT INTO users (id,name) VALUES (6,'Legacy Six')`,
    `INSERT INTO pairing_groups (id,week_id,user_a_id,user_b_id,user_c_id,is_ai_pair) VALUES
      (20,10,2,4,NULL,0),(21,10,2,4,6,0),(22,10,2,2,NULL,1),(23,10,2,6,NULL,0),
      (24,10,2,2,NULL,0)`,
    `INSERT INTO pairing_participants (week_id,user_id,source) VALUES
      (10,2,'auth'),(10,4,'auth'),(10,6,'users'),(10,9,'auth')`,
  ],'write');
  return db;
}

beforeEach(()=>{
  currentDb=null;
  for(const key of ['CIRCLE_MEMBERSHIP_ENABLED','MULTI_CIRCLE_CONTROL_PLANE_ENABLED',
    'MULTI_CIRCLE_AVAILABILITY_ENABLED','SECONDARY_CIRCLE_COORDINATION_ENABLED']) delete process.env[key];
});
afterEach(()=>{
  try{ currentDb?.close?.(); }catch{} currentDb=null;
  if(currentDirectory){ rmSync(currentDirectory,{recursive:true,force:true}); currentDirectory=null; }
  for(const key of ['CIRCLE_MEMBERSHIP_ENABLED','MULTI_CIRCLE_CONTROL_PLANE_ENABLED',
    'MULTI_CIRCLE_AVAILABILITY_ENABLED','SECONDARY_CIRCLE_COORDINATION_ENABLED']) delete process.env[key];
});

test('session-controls request contract accepts only exact canonical actions',()=>{
  assert.deepEqual(parseSessionControlsQuery({
    url:'/api/session-controls',query:{endpoint:'session-controls',room_id:'week_10_pair_20'},
  }),{roomId:'week_10_pair_20',weekId:10,pairGroupId:20});
  assert.deepEqual(parseSessionControlsMutation({
    room_id:'week_10_pair_20',action:'set_candidate',base_version:'a'.repeat(64),candidate_user_id:4,
  }),{roomId:'week_10_pair_20',weekId:10,pairGroupId:20,action:'set_candidate',baseVersion:'a'.repeat(64),candidateUserId:4});
  for(const body of [
    {room_id:'week_10_pair_20',action:'start',base_version:'bad'},
    {room_id:'week_10_pair_20',action:'pause',base_version:'a'.repeat(64),candidate_user_id:2},
    {room_id:'week_10_pair_20',action:'set_candidate',base_version:'a'.repeat(64)},
    {room_id:'week_10_pair_20',action:'set_candidate',base_version:'a'.repeat(64),candidate_user_id:'4'},
    {room_id:'week_10_pair_20',action:'set_candidate',base_version:'a'.repeat(64),candidate_user_id:true},
    {room_id:'week_10_pair_20',action:'set_candidate',base_version:'a'.repeat(64),candidate_user_id:[4]},
    {room_id:'week_10_pair_20',action:'tick',base_version:'a'.repeat(64)},
  ]) assert.throws(()=>parseSessionControlsMutation(body),SessionControlsInputError);
});

test('projection uses the database clock, caps a running timer at completion, and excludes display time from CAS',()=>{
  const pair={weekId:10,pairGroupId:20,viewerId:2,userAId:2,userBId:4};
  const row={
    week_id:10,pair_group_id:20,pair_user_a_id:2,pair_user_a_source:'auth',
    pair_user_b_id:4,pair_user_b_source:'auth',pair_user_c_id:null,
    candidate_user_id:4,candidate_source:'auth',timer_state:'running',remaining_ms:60_000,
    anchor_at:'2026-09-20T10:00:00.000Z',revision:3,updated_by:2,updated_by_source:'auth',
    created_at:'2026-09-20T09:59:00.000Z',updated_at:'2026-09-20T10:00:00.000Z',
  };
  const completion={state:'completed',version:'c'.repeat(64),completed_at:'2026-09-20T10:00:10.000Z'};
  const first=projectSessionControls(pair,row,{databaseNow:'2026-09-20T10:01:00.000Z',completion,versionKey:VERSION_KEY});
  const later=projectSessionControls(pair,row,{databaseNow:'2026-09-20T12:00:00.000Z',completion,versionKey:VERSION_KEY});
  assert.equal(first.remaining_ms,50_000);
  assert.equal(first.terminal,true);
  assert.equal(first.viewer_role,'interviewer');
  assert.equal(first.partner_role,'candidate');
  assert.equal(first.version,later.version,'dynamic display time is not part of the CAS token');
  assert.throws(()=>projectSessionControls(pair,row,{
    databaseNow:'2026-09-20T09:59:59.999Z',completion:{state:'not_recorded',version:'d'.repeat(64),completed_at:null},
    versionKey:VERSION_KEY,
  }),/clock is invalid/);
  for(const completedAt of ['2026-09-20T09:59:59.999Z','2026-09-20T12:00:00.001Z']){
    assert.throws(()=>projectSessionControls(pair,row,{
      databaseNow:'2026-09-20T12:00:00.000Z',
      completion:{state:'completed',version:'d'.repeat(64),completed_at:completedAt},
      versionKey:VERSION_KEY,
    }),/completion clock is invalid/);
  }
});

test('participants share durable role and timer transitions without per-tick writes',async()=>{
  currentDb=await readyDatabase();
  const initial=await invoke();
  assert.equal(initial.status,200,JSON.stringify(initial.body));
  assert.equal(initial.headers['cache-control'],'private, no-store');
  assert.doesNotMatch(JSON.stringify(initial.body),/revision|anchor_at|updated_by/);
  assert.deepEqual(initial.body.session_controls,{...initial.body.session_controls,
    timer_state:'paused',remaining_ms:SESSION_TIMER_DURATION_MS,duration_ms:SESSION_TIMER_DURATION_MS,
    candidate_user_id:2,partner_user_id:4,viewer_role:'candidate',partner_role:'interviewer',
    terminal:false,completion_version:initial.body.session_controls.completion_version,
    observed_at:initial.body.session_controls.observed_at,updated_at:null,version:initial.body.session_controls.version,
  });
  const started=await invoke({method:'POST',query:{endpoint:'session-controls'},body:{
    room_id:'week_10_pair_20',action:'start',base_version:initial.body.session_controls.version,
  }});
  assert.equal(started.status,200,JSON.stringify(started.body));
  assert.equal(started.body.session_controls.timer_state,'running');
  const before=(await currentDb.execute(`SELECT revision,remaining_ms,anchor_at FROM pair_session_controls WHERE week_id=10 AND pair_group_id=20`)).rows[0];
  await new Promise(resolve=>setTimeout(resolve,15));
  const partner=await invoke({headers:{'x-test-auth':'partner'}});
  const after=(await currentDb.execute(`SELECT revision,remaining_ms,anchor_at FROM pair_session_controls WHERE week_id=10 AND pair_group_id=20`)).rows[0];
  assert.deepEqual(after,before,'reads and countdown ticks do not write timer state');
  assert.equal(partner.body.session_controls.viewer_role,'interviewer');
  assert.equal(partner.body.session_controls.candidate_user_id,2);
  assert.ok(partner.body.session_controls.remaining_ms<=started.body.session_controls.remaining_ms);

  const role=await invoke({method:'POST',query:{endpoint:'session-controls'},headers:{'x-test-auth':'partner'},body:{
    room_id:'week_10_pair_20',action:'set_candidate',base_version:partner.body.session_controls.version,candidate_user_id:4,
  }});
  assert.equal(role.status,200,JSON.stringify(role.body));
  assert.equal(role.body.session_controls.viewer_role,'candidate');
  currentDb.close(); currentDb=createClient({url:`file:${join(currentDirectory,'test.sqlite')}`});
  const restarted=await invoke();
  assert.equal(restarted.body.session_controls.candidate_user_id,4);
  assert.equal(restarted.body.session_controls.timer_state,'running');
  const paused=await invoke({method:'POST',query:{endpoint:'session-controls'},body:{
    room_id:'week_10_pair_20',action:'pause',base_version:restarted.body.session_controls.version,
  }});
  assert.equal(paused.status,200,JSON.stringify(paused.body));
  assert.equal(paused.body.session_controls.timer_state,'paused');
  const reset=await invoke({method:'POST',query:{endpoint:'session-controls'},body:{
    room_id:'week_10_pair_20',action:'reset',base_version:paused.body.session_controls.version,
  }});
  assert.equal(reset.body.session_controls.remaining_ms,SESSION_TIMER_DURATION_MS);
});

test('idempotent repeats succeed while competing stale commands return authoritative 409 state',async()=>{
  currentDb=await readyDatabase();
  const initial=(await invoke()).body.session_controls;
  const started=await invoke({method:'POST',query:{endpoint:'session-controls'},body:{
    room_id:'week_10_pair_20',action:'start',base_version:initial.version,
  }});
  const repeated=await invoke({method:'POST',query:{endpoint:'session-controls'},headers:{'x-test-auth':'partner'},body:{
    room_id:'week_10_pair_20',action:'start',base_version:initial.version,
  }});
  assert.equal(repeated.status,200);
  assert.equal(repeated.body.session_controls.version,started.body.session_controls.version);
  const stale=await invoke({method:'POST',query:{endpoint:'session-controls'},body:{
    room_id:'week_10_pair_20',action:'set_candidate',base_version:initial.version,candidate_user_id:4,
  }});
  assert.equal(stale.status,409);
  assert.equal(stale.body.code,'session_controls_changed');
  assert.equal(stale.body.session_controls.timer_state,'running');
});

test('an expired timer requires an explicit reset and candidate assignment stays pair-bound',async()=>{
  currentDb=await readyDatabase();
  const now=(await currentDb.execute("SELECT strftime('%Y-%m-%dT%H:%M:%fZ','now') AS now_utc")).rows[0].now_utc;
  await currentDb.execute({sql:`INSERT INTO pair_session_controls
    (week_id,pair_group_id,pair_user_a_id,pair_user_a_source,pair_user_b_id,pair_user_b_source,
      pair_user_c_id,candidate_user_id,candidate_source,timer_state,remaining_ms,anchor_at,
      revision,updated_by,updated_by_source,created_at,updated_at)
    VALUES (10,20,2,'auth',4,'auth',NULL,2,'auth','paused',0,NULL,1,2,'auth',?,?)`,args:[now,now]});
  const expired=(await invoke()).body.session_controls;
  assert.equal(expired.timer_state,'expired');
  const start=await invoke({method:'POST',query:{endpoint:'session-controls'},body:{
    room_id:'week_10_pair_20',action:'start',base_version:expired.version,
  }});
  assert.equal(start.status,409);
  assert.equal(start.body.code,'session_controls_reset_required');
  const forged=await invoke({method:'POST',query:{endpoint:'session-controls'},body:{
    room_id:'week_10_pair_20',action:'set_candidate',base_version:expired.version,candidate_user_id:9,
  }});
  assert.equal(forged.status,400);
  assert.deepEqual(forged.body,{error:'candidate must be a participant in this pair'});
});

test('simultaneous different actions serialize to one winner and a refreshable conflict',async()=>{
  currentDb=await readyDatabase();
  const second=createClient({url:`file:${join(currentDirectory,'test.sqlite')}`});
  try{
    const initial=await readAuthorizedSessionControls(currentDb,{viewerId:2,weekId:10,pairGroupId:20,versionKey:VERSION_KEY});
    const mutation=action=>({roomId:'week_10_pair_20',weekId:10,pairGroupId:20,action,
      baseVersion:initial.state.version,candidateUserId:action==='set_candidate'?4:null});
    const results=await Promise.allSettled([
      mutateAuthorizedSessionControls(currentDb,{viewerId:2,mutation:mutation('start'),versionKey:VERSION_KEY}),
      mutateAuthorizedSessionControls(second,{viewerId:4,mutation:mutation('set_candidate'),versionKey:VERSION_KEY}),
    ]);
    assert.equal(results.filter(result=>result.status==='fulfilled').length,1);
    const rejected=results.find(result=>result.status==='rejected');
    assert.ok(rejected?.reason instanceof SessionControlsConflictError);
    assert.equal(rejected.reason.code,'session_controls_changed');
  }finally{ second.close(); }
});

test('unauthorized, absent, triad, AI, mixed-source, and source-collision rooms are indistinguishable',async()=>{
  currentDb=await readyDatabase();
  const requests=[
    invoke({headers:{'x-test-auth':'outsider'}}),
    invoke({query:{endpoint:'session-controls',room_id:'week_10_pair_999'}}),
    invoke({query:{endpoint:'session-controls',room_id:'week_10_pair_21'}}),
    invoke({query:{endpoint:'session-controls',room_id:'week_10_pair_22'}}),
    invoke({query:{endpoint:'session-controls',room_id:'week_10_pair_23'}}),
    invoke({query:{endpoint:'session-controls',room_id:'week_10_pair_24'}}),
  ];
  const results=await Promise.all(requests);
  for(const result of results){
    assert.equal(result.status,404,JSON.stringify(result.body));
    assert.deepEqual(result.body,{error:'pair not found'});
  }
});

test('a nullable pair-shape flag fails closed as the generic missing pair',async()=>{
  currentDb=await readyDatabase();
  await currentDb.execute(`UPDATE pairing_groups SET is_ai_pair=NULL WHERE id=20`);
  const response=await invoke();
  assert.equal(response.status,404);
  assert.deepEqual(response.body,{error:'pair not found'});
});

test('unanimous completion freezes the effective timer and rejects every command',async()=>{
  currentDb=await readyDatabase();
  const initial=(await invoke()).body.session_controls;
  const started=await invoke({method:'POST',query:{endpoint:'session-controls'},body:{
    room_id:'week_10_pair_20',action:'start',base_version:initial.version,
  }});
  await currentDb.batch([
    `INSERT INTO session_completion_receipts VALUES (10,20,2,'auth',2,4,NULL,strftime('%Y-%m-%dT%H:%M:%fZ','now'))`,
    `INSERT INTO session_completion_receipts VALUES (10,20,4,'auth',2,4,NULL,strftime('%Y-%m-%dT%H:%M:%fZ','now'))`,
  ],'write');
  const terminal=await invoke();
  assert.equal(terminal.body.session_controls.terminal,true);
  const frozen=terminal.body.session_controls.remaining_ms;
  await new Promise(resolve=>setTimeout(resolve,15));
  assert.equal((await invoke()).body.session_controls.remaining_ms,frozen);
  for(const action of ['start','pause','reset']){
    const response=await invoke({method:'POST',query:{endpoint:'session-controls'},body:{
      room_id:'week_10_pair_20',action,base_version:started.body.session_controls.version,
    }});
    assert.equal(response.status,409);
    assert.equal(response.body.code,'session_controls_completed');
    assert.equal(response.body.session_controls.terminal,true);
  }
});

test('missing session-controls schema fails closed without runtime DDL',async()=>{
  currentDirectory=mkdtempSync(join(tmpdir(),'randori-session-controls-missing-'));
  currentDb=createClient({url:`file:${join(currentDirectory,'test.sqlite')}`});
  await currentDb.batch([
    `CREATE TABLE pairing_groups (id INTEGER PRIMARY KEY,week_id INTEGER,user_a_id INTEGER,user_b_id INTEGER,user_c_id INTEGER,is_ai_pair INTEGER)`,
    `CREATE TABLE pairing_participants (week_id INTEGER,user_id INTEGER,source TEXT)`,
    `CREATE TABLE session_completion_receipts (week_id INTEGER,pair_group_id INTEGER,user_id INTEGER,participant_source TEXT,pair_user_a_id INTEGER,pair_user_b_id INTEGER,pair_user_c_id INTEGER,confirmed_at TEXT)`,
  ],'write');
  const response=await invoke();
  assert.equal(response.status,503);
  assert.deepEqual(response.body,{error:'session controls unavailable'});
  const tables=await currentDb.execute(`SELECT name FROM sqlite_master WHERE type='table'`);
  assert.equal(tables.rows.some(row=>row.name==='pair_session_controls'),false);
});
