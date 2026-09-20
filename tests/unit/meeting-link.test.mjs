import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, mock, test } from 'node:test';
import { createClient } from '@libsql/client';
import { EXECUTABLE_MIGRATIONS } from '../../db/executable-migrations.js';
import { applyMigrations, inspectMigrationState, prepareMigrationConnection } from '../../db/migration-runner.js';

import {
  MAX_MEETING_URL_BYTES,
  MeetingLinkConflictError,
  MeetingLinkInputError,
  mutateAuthorizedMeetingLink,
  normalizeMeetingUrl,
  parseMeetingLinkMutation,
  parseMeetingLinkQuery,
  readAuthorizedMeetingLink,
} from '../../api/_meeting-link.js';

let currentDb=null;
let currentDirectory=null;
let capturedErrors=0;
const VERSION_KEY='meeting-link-test-secret-at-least-thirty-two-characters';

function authPayload(req){
  const identity=req?.headers?.['x-test-auth'];
  if(identity==='member') return {id:2,email:'member@example.test'};
  if(identity==='partner') return {id:4,email:'partner@example.test'};
  if(identity==='outsider') return {id:9,email:'outsider@example.test'};
  return null;
}

mock.module('../../api/_db.js',{exports:{
  captureSentryException:()=>{ capturedErrors+=1; },captureSentryMessage:()=>{ capturedErrors+=1; },getAdminEmails:()=>new Set(),
  getClient:()=>currentDb,getJwtSecret:()=>VERSION_KEY,initSentry:()=>{},isSentryConfigured:()=>false,
  verifyMutationOrigin:()=>true,verifyRequestAuth:authPayload,verifySignedRequestAuth:authPayload,
}});

const {default:dataHandler}=await import('../../api/data.js');

function invoke({method='GET',url='/api/meeting-link',query={endpoint:'meeting-link',room_id:'week_10_pair_20'},headers={'x-test-auth':'member'},body={}}={}){
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
  currentDirectory=mkdtempSync(join(tmpdir(),'randori-meeting-link-'));
  const db=createClient({url:`file:${join(currentDirectory,'test.sqlite')}`});
  await db.batch([
    `CREATE TABLE auth_accounts (id INTEGER PRIMARY KEY,display_name TEXT NOT NULL,is_demo INTEGER NOT NULL DEFAULT 0)`,
    `CREATE TABLE users (id INTEGER PRIMARY KEY,name TEXT NOT NULL)`,
    `CREATE TABLE pairing_groups (id INTEGER PRIMARY KEY,week_id INTEGER NOT NULL,user_a_id INTEGER NOT NULL,user_b_id INTEGER NOT NULL,user_c_id INTEGER,is_ai_pair INTEGER NOT NULL)`,
    `CREATE TABLE pairing_participants (week_id INTEGER NOT NULL,user_id INTEGER NOT NULL,source TEXT NOT NULL,PRIMARY KEY(week_id,user_id))`,
    `CREATE TABLE pair_schedules (id INTEGER PRIMARY KEY,week_id INTEGER NOT NULL,pair_group_id INTEGER NOT NULL,proposed_times TEXT,agreed_time TEXT,created_at TEXT,updated_at TEXT,UNIQUE(week_id,pair_group_id))`,
    `CREATE TABLE session_completion_receipts (week_id INTEGER NOT NULL,pair_group_id INTEGER NOT NULL,user_id INTEGER NOT NULL,participant_source TEXT NOT NULL,pair_user_a_id INTEGER NOT NULL,pair_user_b_id INTEGER NOT NULL,pair_user_c_id INTEGER,confirmed_at TEXT NOT NULL,PRIMARY KEY(week_id,pair_group_id,user_id))`,
    `CREATE TABLE pair_meeting_links (week_id INTEGER NOT NULL,pair_group_id INTEGER NOT NULL,accepted_schedule_at TEXT NOT NULL,meeting_url TEXT,revision INTEGER NOT NULL,updated_by INTEGER NOT NULL,updated_by_source TEXT NOT NULL,pair_user_a_id INTEGER NOT NULL,pair_user_b_id INTEGER NOT NULL,pair_user_c_id INTEGER,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,PRIMARY KEY(week_id,pair_group_id))`,
    `INSERT INTO auth_accounts (id,display_name) VALUES (2,'Member'),(4,'Partner'),(9,'Outsider')`,
    `INSERT INTO pairing_groups (id,week_id,user_a_id,user_b_id,user_c_id,is_ai_pair) VALUES (20,10,2,4,NULL,0),(21,10,4,9,NULL,0)`,
    `INSERT INTO pairing_participants (week_id,user_id,source) VALUES (10,2,'auth'),(10,4,'auth'),(10,9,'auth')`,
    `INSERT INTO pair_schedules (id,week_id,pair_group_id,proposed_times,agreed_time,created_at,updated_at) VALUES
      (1,10,20,'[]','2026-09-25T18:00:00.000Z','2026-09-20T10:00:00.000Z','2026-09-20T10:00:00.000Z'),
      (2,10,21,'[]',NULL,'2026-09-20T10:00:00.000Z','2026-09-20T10:00:00.000Z')`,
  ],'write');
  return db;
}

async function migratedDatabase(){
  currentDirectory=mkdtempSync(join(tmpdir(),'randori-meeting-history-'));
  const db=createClient({url:`file:${join(currentDirectory,'test.sqlite')}`});
  await prepareMigrationConnection(db);
  const before=await inspectMigrationState(db);
  await applyMigrations(db,{expectedStateFingerprint:before.stateFingerprint,migrations:EXECUTABLE_MIGRATIONS,
    retry:{maxAttempts:1,baseDelayMs:0,maxDelayMs:0}});
  await db.batch([
    `INSERT INTO auth_accounts (id,email,password_hash,display_name,color,is_demo) VALUES
      (2,'member@example.test','hash','Member','#111111',0),(4,'partner@example.test','hash','Partner','#222222',0)`,
    `INSERT INTO pairing_weeks (id,week_label,week_start,is_demo) VALUES
      (10,'2026-W38','2026-09-14T07:00:00.000Z',0)`,
    `INSERT INTO pairing_groups (id,week_id,user_a_id,user_b_id,user_c_id,is_ai_pair,topic,topic_kind)
      VALUES (20,10,2,4,NULL,0,'Private practice','both')`,
    `INSERT INTO pairing_participants (week_id,user_id,position,source) VALUES
      (10,2,0,'auth'),(10,4,1,'auth')`,
    `INSERT INTO pair_schedules (week_id,pair_group_id,proposed_times,agreed_time,created_at,updated_at)
      VALUES (10,20,'[]','2026-09-25T18:00:00.000Z','2026-09-20T10:00:00.000Z','2026-09-20T10:00:00.000Z')`,
    `INSERT INTO pair_meeting_links
      (week_id,pair_group_id,accepted_schedule_at,meeting_url,revision,updated_by,updated_by_source,
        pair_user_a_id,pair_user_b_id,pair_user_c_id,created_at,updated_at)
      VALUES (10,20,'2026-09-25T18:00:00.000Z','https://private.example.test/secret',1,2,'auth',
        2,4,NULL,'2026-09-20T10:01:00.000Z','2026-09-20T10:01:00.000Z')`,
  ],'write');
  return db;
}

beforeEach(()=>{
  currentDb=null; capturedErrors=0;
  for(const key of ['CIRCLE_MEMBERSHIP_ENABLED','MULTI_CIRCLE_CONTROL_PLANE_ENABLED',
    'MULTI_CIRCLE_AVAILABILITY_ENABLED','SECONDARY_CIRCLE_COORDINATION_ENABLED']) delete process.env[key];
});
afterEach(()=>{
  try{ currentDb?.close?.(); }catch{} currentDb=null;
  if(currentDirectory){ rmSync(currentDirectory,{recursive:true,force:true}); currentDirectory=null; }
  for(const key of ['CIRCLE_MEMBERSHIP_ENABLED','MULTI_CIRCLE_CONTROL_PLANE_ENABLED',
    'MULTI_CIRCLE_AVAILABILITY_ENABLED','SECONDARY_CIRCLE_COORDINATION_ENABLED']) delete process.env[key];
});

test('request and URL contracts accept exact bounded credential-free HTTPS values only',()=>{
  assert.deepEqual(parseMeetingLinkQuery({
    url:'/api/meeting-link',query:{endpoint:'meeting-link',room_id:'week_10_pair_20'},
  }),{roomId:'week_10_pair_20',weekId:10,pairGroupId:20});
  const parsed=parseMeetingLinkMutation({
    room_id:'week_10_pair_20',action:'set',base_version:'a'.repeat(64),
    schedule_version:'b'.repeat(64),completion_version:'c'.repeat(64),
    url:'https://meet.example.test/private-room?token=opaque',
  });
  assert.equal(parsed.normalizedUrl.hostname,'meet.example.test');
  assert.equal(normalizeMeetingUrl('https://例え.テスト/path').hostname,'xn--r8jz45g.xn--zckzah');
  for(const value of [
    'http://meet.example.test/x','https://user:password@meet.example.test/x',
    ' https://meet.example.test/x','https://meet.example.test/x\n',
    `https://meet.example.test/${'a'.repeat(MAX_MEETING_URL_BYTES)}`,
  ]) assert.throws(()=>normalizeMeetingUrl(value),MeetingLinkInputError);
  for(const body of [
    {room_id:'week_10_pair_20',action:'set',base_version:'a'.repeat(64),schedule_version:'b'.repeat(64),completion_version:'c'.repeat(64)},
    {room_id:'week_10_pair_20',action:'clear',base_version:'a'.repeat(64),schedule_version:'b'.repeat(64),completion_version:'c'.repeat(64),url:'https://meet.example.test/x'},
    {room_id:'week_10_pair_20',action:'set',base_version:'bad',schedule_version:'b'.repeat(64),completion_version:'c'.repeat(64),url:'https://meet.example.test/x'},
  ]) assert.throws(()=>parseMeetingLinkMutation(body),MeetingLinkInputError);
});

test('authorized participants share a durable private link with opaque CAS and clear tombstone',async()=>{
  currentDb=await readyDatabase();
  const initial=await invoke();
  assert.equal(initial.status,200,JSON.stringify(initial.body));
  assert.equal(initial.body.meeting_link.lifecycle,'active');
  assert.equal(initial.body.meeting_link.url,null);
  assert.match(initial.body.meeting_link.version,/^[a-f0-9]{64}$/);
  const set=await invoke({method:'POST',query:{endpoint:'meeting-link'},body:{
    room_id:'week_10_pair_20',action:'set',base_version:initial.body.meeting_link.version,
    schedule_version:initial.body.meeting_link.schedule_version,
    completion_version:initial.body.meeting_link.completion_version,
    url:'https://meet.example.test/private-room?token=opaque',
  }});
  assert.equal(set.status,200,JSON.stringify(set.body));
  assert.equal(set.body.meeting_link.hostname,'meet.example.test');
  assert.notEqual(set.body.meeting_link.version,initial.body.meeting_link.version);
  const partner=await invoke({headers:{'x-test-auth':'partner'}});
  assert.equal(partner.body.meeting_link.url,'https://meet.example.test/private-room?token=opaque');
  assert.deepEqual(partner.body.meeting_link,set.body.meeting_link);
  currentDb.close(); currentDb=createClient({url:`file:${join(currentDirectory,'test.sqlite')}`});
  assert.deepEqual((await invoke()).body.meeting_link,set.body.meeting_link,'link survives a database client restart');
  const clear=await invoke({method:'POST',query:{endpoint:'meeting-link'},headers:{'x-test-auth':'partner'},body:{
    room_id:'week_10_pair_20',action:'clear',base_version:set.body.meeting_link.version,
    schedule_version:set.body.meeting_link.schedule_version,
    completion_version:set.body.meeting_link.completion_version,
  }});
  assert.equal(clear.status,200,JSON.stringify(clear.body));
  assert.equal(clear.body.meeting_link.url,null);
  assert.notEqual(clear.body.meeting_link.version,set.body.meeting_link.version);
  const stale=await invoke({method:'POST',query:{endpoint:'meeting-link'},body:{
    room_id:'week_10_pair_20',action:'set',base_version:set.body.meeting_link.version,
    schedule_version:set.body.meeting_link.schedule_version,
    completion_version:set.body.meeting_link.completion_version,url:'https://other.example.test/call',
  }});
  assert.equal(stale.status,409);
  assert.equal(stale.body.code,'meeting_link_changed');
  assert.equal(stale.body.meeting_link.url,null);
});

test('meeting-link reads and writes never fetch or report the private URL',async t=>{
  let fetchCalls=0;
  t.mock.method(globalThis,'fetch',async()=>{ fetchCalls+=1; throw new Error('network must not be used'); });
  currentDb=await readyDatabase();
  const initial=(await invoke()).body.meeting_link;
  const set=await invoke({method:'POST',query:{endpoint:'meeting-link'},body:{
    room_id:'week_10_pair_20',action:'set',base_version:initial.version,
    schedule_version:initial.schedule_version,completion_version:initial.completion_version,
    url:'https://private.example.test/never-send',
  }});
  assert.equal(set.status,200,JSON.stringify(set.body));
  assert.equal((await invoke()).status,200);
  assert.equal(fetchCalls,0);
  assert.equal(capturedErrors,0);
});

test('unauthorized and nonexistent rooms are indistinguishable and never reveal the URL',async()=>{
  currentDb=await readyDatabase();
  const initial=await invoke();
  const set=await invoke({method:'POST',query:{endpoint:'meeting-link'},body:{
    room_id:'week_10_pair_20',action:'set',base_version:initial.body.meeting_link.version,
    schedule_version:initial.body.meeting_link.schedule_version,
    completion_version:initial.body.meeting_link.completion_version,url:'https://secret.example.test/opaque',
  }});
  assert.equal(set.status,200);
  const outsider=await invoke({headers:{'x-test-auth':'outsider'}});
  const missing=await invoke({query:{endpoint:'meeting-link',room_id:'week_10_pair_999'}});
  assert.deepEqual(outsider,{...missing,headers:outsider.headers});
  assert.equal(outsider.status,404);
  assert.equal(JSON.stringify(outsider.body).includes('secret.example.test'),false);
  assert.equal((await invoke({headers:{}})).status,401);
});

test('staged multi-circle rollout keeps the primary room available and obscures scope denials',async()=>{
  currentDb=await readyDatabase();
  await currentDb.batch([
    `CREATE TABLE circles (id INTEGER PRIMARY KEY,is_primary INTEGER NOT NULL,archived_at TEXT)`,
    `CREATE TABLE circle_memberships (circle_id INTEGER NOT NULL,user_id INTEGER NOT NULL,role TEXT NOT NULL,status TEXT NOT NULL)`,
    `INSERT INTO circles VALUES (1,1,NULL)`,
    `INSERT INTO circle_memberships VALUES (1,2,'member','active'),(1,4,'member','active')`,
  ],'write');
  process.env.CIRCLE_MEMBERSHIP_ENABLED='true';
  process.env.MULTI_CIRCLE_CONTROL_PLANE_ENABLED='true';
  const member=await invoke();
  assert.equal(member.status,200,JSON.stringify(member.body));
  const denied=await invoke({headers:{'x-test-auth':'outsider'}});
  const missing=await invoke({query:{endpoint:'meeting-link',room_id:'week_10_pair_999'}});
  assert.equal(denied.status,404);
  assert.deepEqual(denied.body,missing.body);
});

test('schedule and completion fences reject stale mutations and completed reads hide stored links',async()=>{
  currentDb=await readyDatabase();
  const initial=(await invoke()).body.meeting_link;
  const invalidSchedule=await invoke({method:'POST',query:{endpoint:'meeting-link'},body:{
    room_id:'week_10_pair_20',action:'set',base_version:initial.version,
    schedule_version:'f'.repeat(64),completion_version:initial.completion_version,
    url:'https://meet.example.test/call',
  }});
  assert.equal(invalidSchedule.status,409);
  assert.equal(invalidSchedule.body.code,'meeting_link_schedule_changed');
  const set=await invoke({method:'POST',query:{endpoint:'meeting-link'},body:{
    room_id:'week_10_pair_20',action:'set',base_version:initial.version,
    schedule_version:initial.schedule_version,completion_version:initial.completion_version,
    url:'https://meet.example.test/call',
  }});
  await currentDb.batch([
    `INSERT INTO session_completion_receipts VALUES (10,20,2,'auth',2,4,NULL,'2026-09-20T10:02:00.000Z')`,
    `INSERT INTO session_completion_receipts VALUES (10,20,4,'auth',2,4,NULL,'2026-09-20T10:03:00.000Z')`,
  ],'write');
  const hidden=await invoke();
  assert.equal(hidden.status,200);
  assert.deepEqual(hidden.body.meeting_link.url,null);
  assert.equal(hidden.body.meeting_link.hostname,null);
  assert.equal(hidden.body.meeting_link.lifecycle,'completed');
  assert.equal(JSON.stringify(hidden.body).includes('meet.example.test'),false);
  const terminal=await invoke({method:'POST',query:{endpoint:'meeting-link'},body:{
    room_id:'week_10_pair_20',action:'clear',base_version:set.body.meeting_link.version,
    schedule_version:set.body.meeting_link.schedule_version,
    completion_version:set.body.meeting_link.completion_version,
  }});
  assert.equal(terminal.status,409);
  assert.equal(terminal.body.code,'meeting_link_session_completed');
  assert.equal(JSON.stringify(terminal.body).includes('meet.example.test'),false);
});

test('concurrent participant edits serialize to one winner and one refreshable conflict',async()=>{
  currentDb=await readyDatabase();
  const second=createClient({url:`file:${join(currentDirectory,'test.sqlite')}`});
  try{
    const initial=await readAuthorizedMeetingLink(currentDb,{viewerId:2,weekId:10,pairGroupId:20,versionKey:VERSION_KEY});
    const mutation=url=>({
      roomId:'week_10_pair_20',weekId:10,pairGroupId:20,action:'set',baseVersion:initial.state.version,
      scheduleVersion:initial.state.schedule_version,completionVersion:initial.state.completion_version,
      normalizedUrl:normalizeMeetingUrl(url),
    });
    const results=await Promise.allSettled([
      mutateAuthorizedMeetingLink(currentDb,{viewerId:2,mutation:mutation('https://one.example.test/call'),versionKey:VERSION_KEY}),
      mutateAuthorizedMeetingLink(second,{viewerId:4,mutation:mutation('https://two.example.test/call'),versionKey:VERSION_KEY}),
    ]);
    assert.equal(results.filter(result=>result.status==='fulfilled').length,1);
    const rejected=results.find(result=>result.status==='rejected');
    assert.ok(rejected?.reason instanceof MeetingLinkConflictError);
    assert.equal(rejected.reason.code,'meeting_link_changed');
    const durable=await readAuthorizedMeetingLink(currentDb,{viewerId:2,weekId:10,pairGroupId:20,versionKey:VERSION_KEY});
    assert.ok(['one.example.test','two.example.test'].includes(durable.state.hostname));
  }finally{ second.close(); }
});

test('an incomplete schedule cannot create a link',async()=>{
  currentDb=await readyDatabase();
  const read=await readAuthorizedMeetingLink(currentDb,{viewerId:4,weekId:10,pairGroupId:21,versionKey:VERSION_KEY});
  assert.equal(read.state.lifecycle,'unscheduled');
  assert.equal(read.state.url,null);
  await assert.rejects(()=>mutateAuthorizedMeetingLink(currentDb,{viewerId:4,versionKey:VERSION_KEY,mutation:{
    roomId:'week_10_pair_21',weekId:10,pairGroupId:21,action:'clear',
    baseVersion:'a'.repeat(64),scheduleVersion:read.state.schedule_version,
    completionVersion:read.state.completion_version,normalizedUrl:null,
  }}),error=>error instanceof MeetingLinkConflictError&&error.code==='meeting_link_schedule_required');
});

test('private meeting URLs are absent from history and pair recap projections',async()=>{
  currentDb=await migratedDatabase();
  const history=await invoke({url:'/api/history',query:{endpoint:'history'}});
  assert.equal(history.status,200,JSON.stringify(history.body));
  assert.equal(JSON.stringify(history.body).includes('private.example.test'),false);
  const recap=await invoke({url:'/api/pair-recap',query:{endpoint:'pair-recap',room_id:'week_10_pair_20'}});
  assert.equal(recap.status,200,JSON.stringify(recap.body));
  assert.equal(JSON.stringify(recap.body).includes('private.example.test'),false);
  assert.equal(Object.hasOwn(recap.body.recap,'meeting_link'),false);
});
