import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, mock, test } from 'node:test';
import { createClient } from '@libsql/client';

import {
  canonicalCompletionPair,
  mutateAuthorizedSessionCompletion,
  parseSessionCompletionMutation,
  parseSessionCompletionQuery,
  projectSessionCompletion,
  readAuthorizedSessionCompletion,
  readCompletionDatabaseNow,
  SessionCompletionConflictError,
  SessionCompletionDataError,
  SessionCompletionInputError,
} from '../../api/_session-completion.js';

let currentDb=null;
let currentDirectory=null;
const VERSION_KEY='completion-test-secret-at-least-thirty-two-characters';

function authPayload(req){
  const identity=req?.headers?.['x-test-auth'];
  if(identity==='member') return {id:2,email:'member@example.test'};
  if(identity==='partner') return {id:4,email:'partner@example.test'};
  if(identity==='third') return {id:6,email:'third@example.test'};
  if(identity==='outsider') return {id:9,email:'outsider@example.test'};
  return null;
}

mock.module('../../api/_db.js',{
  exports:{
    captureSentryException:()=>null,captureSentryMessage:()=>null,getAdminEmails:()=>new Set(),
    getClient:()=>currentDb,getJwtSecret:()=>'completion-test-secret-at-least-thirty-two-characters',
    initSentry:()=>{},isSentryConfigured:()=>false,verifyMutationOrigin:()=>true,
    verifyRequestAuth:authPayload,verifySignedRequestAuth:authPayload,
  },
});

const {default:dataHandler}=await import('../../api/data.js');

function invoke({method='GET',url='/api/session-completion',query={endpoint:'session-completion',room_id:'week_10_pair_20'},headers={'x-test-auth':'member'},body={}}={}){
  return new Promise((resolve,reject)=>{
    let statusCode=200,settled=false;
    const responseHeaders={};
    const finish=bodyValue=>{ if(!settled){ settled=true; resolve({status:statusCode,headers:responseHeaders,body:bodyValue}); } };
    const res={
      status(code){ statusCode=code; return this; },
      setHeader(name,value){ responseHeaders[String(name).toLowerCase()]=value; },
      json(value){ finish(value); return this; },
      end(value){ finish(value); return this; },
    };
    const req={method,url,query,headers,body,socket:{remoteAddress:'127.0.0.1'}};
    Promise.resolve(dataHandler(req,res)).then(()=>finish(undefined)).catch(reject);
  });
}

async function readyDatabase(){
  currentDirectory=mkdtempSync(join(tmpdir(),'randori-session-completion-'));
  const db=createClient({url:`file:${join(currentDirectory,'test.sqlite')}`});
  await db.batch([
    `CREATE TABLE auth_accounts (id INTEGER PRIMARY KEY,display_name TEXT NOT NULL,is_demo INTEGER NOT NULL DEFAULT 0)`,
    `CREATE TABLE users (id INTEGER PRIMARY KEY,name TEXT NOT NULL)`,
    `CREATE TABLE pairing_weeks (
      id INTEGER PRIMARY KEY,week_label TEXT NOT NULL,week_start TEXT NOT NULL,is_demo INTEGER NOT NULL DEFAULT 0
    )`,
    `CREATE TABLE pairing_groups (
      id INTEGER PRIMARY KEY,week_id INTEGER NOT NULL,user_a_id INTEGER NOT NULL,
      user_b_id INTEGER NOT NULL,user_c_id INTEGER,is_ai_pair INTEGER NOT NULL,topic TEXT,topic_kind TEXT
    )`,
    `CREATE TABLE pairing_participants (
      week_id INTEGER NOT NULL,user_id INTEGER NOT NULL,source TEXT NOT NULL,
      PRIMARY KEY(week_id,user_id)
    )`,
    `CREATE TABLE session_completion_receipts (
      week_id INTEGER NOT NULL,pair_group_id INTEGER NOT NULL,user_id INTEGER NOT NULL,
      participant_source TEXT NOT NULL,pair_user_a_id INTEGER NOT NULL,
      pair_user_b_id INTEGER NOT NULL,pair_user_c_id INTEGER,confirmed_at TEXT NOT NULL,
      PRIMARY KEY(week_id,pair_group_id,user_id)
    )`,
    `INSERT INTO auth_accounts (id,display_name) VALUES (2,'Member'),(4,'Partner'),(6,'Third'),(9,'Outsider')`,
    `INSERT INTO users (id,name) VALUES (12,'Legacy partner')`,
    `INSERT INTO pairing_weeks (id,week_label,week_start,is_demo) VALUES
      (10,'2026-W38','2026-09-14T07:00:00.000Z',0),
      (11,'2026-W39','2026-09-21T07:00:00.000Z',0),
      (12,'2026-W40','2026-09-28T07:00:00.000Z',0)`,
    `INSERT INTO pairing_groups (id,week_id,user_a_id,user_b_id,user_c_id,is_ai_pair,topic,topic_kind) VALUES
      (20,10,2,4,6,0,'Triad','dsa'),(21,11,2,2,NULL,1,'Solo','dsa'),
      (22,12,2,12,NULL,0,'Mixed','dsa'),(23,10,4,6,NULL,0,'Pair','dsa')`,
    `INSERT INTO pairing_participants (week_id,user_id,source) VALUES
      (10,2,'auth'),(10,4,'auth'),(10,6,'auth'),(10,9,'auth'),
      (11,2,'auth'),(12,2,'auth'),(12,12,'users')`,
  ],'write');
  return db;
}

beforeEach(()=>{ currentDb=null; delete process.env.CIRCLE_MEMBERSHIP_ENABLED; });
afterEach(()=>{
  try{ currentDb?.close?.(); }catch{} currentDb=null;
  if(currentDirectory){ rmSync(currentDirectory,{recursive:true,force:true}); currentDirectory=null; }
});

test('completion request contracts accept only a canonical room and exact mutation fields',()=>{
  assert.deepEqual(parseSessionCompletionQuery({
    url:'/api/session-completion',query:{endpoint:'session-completion',room_id:'week_10_pair_20'},
  }),{roomId:'week_10_pair_20',weekId:10,pairGroupId:20});
  assert.deepEqual(parseSessionCompletionMutation({
    room_id:'week_10_pair_20',action:'confirm',base_version:'a'.repeat(64),
  }),{roomId:'week_10_pair_20',weekId:10,pairGroupId:20,action:'confirm',baseVersion:'a'.repeat(64)});
  for(const request of [
    {url:'/api/session-completion',query:{}},
    {url:'/api/session-completion',query:{endpoint:'session-completion',room_id:'week_01_pair_20'}},
    {url:'/api/session-completion',query:{endpoint:'session-completion',room_id:['week_10_pair_20']}},
    {url:'/api/session-completion',query:{endpoint:'session-completion',room_id:'week_10_pair_20',user_id:'2'}},
  ]) assert.throws(()=>parseSessionCompletionQuery(request),SessionCompletionInputError);
  for(const body of [
    null,
    {room_id:'week_10_pair_20',action:'complete',base_version:'a'.repeat(64)},
    {room_id:'week_10_pair_20',action:'confirm',base_version:'bad'},
    {room_id:'week_10_pair_20',action:'confirm',base_version:'a'.repeat(64),user_id:2},
  ]) assert.throws(()=>parseSessionCompletionMutation(body),SessionCompletionInputError);
});

test('source-tagged projection derives human quorum and reveals aggregates only',()=>{
  const triad=canonicalCompletionPair({
    pair_group_id:20,week_id:10,user_a_id:2,user_b_id:4,user_c_id:6,is_ai_pair:0,
    user_a_source:'auth',user_b_source:'auth',user_c_source:'auth',
  },2);
  const empty=projectSessionCompletion(triad,[],VERSION_KEY);
  assert.deepEqual({...empty,version:'opaque'}, {
    state:'not_recorded',viewer_confirmed:false,confirmed_count:0,required_count:3,
    version:'opaque',completed_at:null,
  });
  const awaitingRows=[
    {user_id:2,confirmed_at:'2026-09-20T10:00:00.000Z'},
    {user_id:4,confirmed_at:'2026-09-20T10:01:00.000Z'},
  ];
  const awaiting=projectSessionCompletion(triad,awaitingRows,VERSION_KEY);
  assert.equal(awaiting.state,'awaiting_participants');
  assert.equal(awaiting.viewer_confirmed,true);
  assert.equal(awaiting.confirmed_count,2);
  assert.equal(awaiting.completed_at,null);
  assert.match(awaiting.version,/^[a-f0-9]{64}$/);
  const publicEvidenceDigest=createHash('sha256').update(
    `randori-session-completion-v1\0${JSON.stringify([
      triad.weekId,triad.pairGroupId,triad.requiredUserIds,
      [[2,'2026-09-20T10:00:00.000Z'],[4,'2026-09-20T10:01:00.000Z']],
    ])}`,'utf8').digest('hex');
  assert.notEqual(awaiting.version,publicEvidenceDigest,
    'public pair and timestamp evidence cannot reproduce the keyed version');
  assert.notEqual(awaiting.version,
    projectSessionCompletion(triad,awaitingRows,'different-completion-secret-at-least-32-characters').version,
    'the opaque version is keyed and cannot be recomputed from public pair and timing evidence');
  assert.deepEqual(Object.keys(awaiting).sort(),[
    'completed_at','confirmed_count','required_count','state','version','viewer_confirmed',
  ]);
  const completed=projectSessionCompletion(triad,[
    {user_id:6,confirmed_at:'2026-09-20T10:02:00.000Z'},
    {user_id:2,confirmed_at:'2026-09-20T10:00:00.000Z'},
    {user_id:4,confirmed_at:'2026-09-20T10:01:00.000Z'},
  ],VERSION_KEY);
  assert.equal(completed.state,'completed');
  assert.equal(completed.completed_at,'2026-09-20T10:02:00.000Z');

  const ai=canonicalCompletionPair({
    pair_group_id:21,week_id:11,user_a_id:2,user_b_id:2,user_c_id:null,is_ai_pair:1,
    user_a_source:'auth',user_b_source:'auth',user_c_source:null,
  },2);
  assert.equal(ai.requiredUserIds.length,1);
  const mixed=canonicalCompletionPair({
    pair_group_id:22,week_id:12,user_a_id:2,user_b_id:12,user_c_id:null,is_ai_pair:0,
    user_a_source:'auth',user_b_source:'users',user_c_source:null,
  },2);
  assert.deepEqual(mixed.requiredUserIds,[2]);
  assert.throws(()=>projectSessionCompletion(triad,[
    {user_id:9,confirmed_at:'2026-09-20T10:00:00.000Z'},
  ],VERSION_KEY),SessionCompletionDataError);
});

test('database time is strict and request authentication precedes method or storage details',async()=>{
  assert.equal(await readCompletionDatabaseNow({execute:async()=>({rows:[{now_utc:'2026-09-20T10:00:00.000Z'}]})}),'2026-09-20T10:00:00.000Z');
  await assert.rejects(()=>readCompletionDatabaseNow({execute:async()=>({rows:[{now_utc:'2026-09-20 10:00:00'}]})}),SessionCompletionDataError);
  let calls=0;
  currentDb={execute:async()=>{ calls+=1; throw new Error('must not query'); }};
  assert.equal((await invoke({headers:{}})).status,401);
  assert.equal((await invoke({method:'DELETE',headers:{}})).status,401);
  assert.equal(calls,0);
  const method=await invoke({method:'DELETE'});
  assert.equal(method.status,405);
  assert.equal(method.headers.allow,'GET, POST');
  assert.equal(calls,0);
});

test('triad confirmations use CAS, allow pre-terminal withdrawal, and become terminal unanimously',async()=>{
  currentDb=await readyDatabase();
  const initial=await invoke();
  assert.equal(initial.status,200,JSON.stringify(initial.body));
  assert.equal(initial.body.completion.state,'not_recorded');
  const first=await invoke({method:'POST',query:{endpoint:'session-completion'},body:{
    room_id:'week_10_pair_20',action:'confirm',base_version:initial.body.completion.version,
  }});
  assert.equal(first.status,200,JSON.stringify(first.body));
  assert.equal(first.body.completion.state,'awaiting_participants');
  assert.equal(first.body.completion.confirmed_count,1);

  const replay=await invoke({method:'POST',query:{endpoint:'session-completion'},body:{
    room_id:'week_10_pair_20',action:'confirm',base_version:initial.body.completion.version,
  }});
  assert.equal(replay.status,200,'same participant confirmation is idempotent even after its version advances');
  assert.deepEqual(replay.body.completion,first.body.completion);

  const stalePartner=await invoke({method:'POST',query:{endpoint:'session-completion'},headers:{'x-test-auth':'partner'},body:{
    room_id:'week_10_pair_20',action:'confirm',base_version:initial.body.completion.version,
  }});
  assert.equal(stalePartner.status,409);
  assert.equal(stalePartner.body.code,'session_completion_changed');
  const partner=await invoke({method:'POST',query:{endpoint:'session-completion'},headers:{'x-test-auth':'partner'},body:{
    room_id:'week_10_pair_20',action:'confirm',base_version:first.body.completion.version,
  }});
  assert.equal(partner.status,200);
  assert.equal(partner.body.completion.confirmed_count,2);
  const withdrawn=await invoke({method:'POST',query:{endpoint:'session-completion'},headers:{'x-test-auth':'partner'},body:{
    room_id:'week_10_pair_20',action:'withdraw',base_version:partner.body.completion.version,
  }});
  assert.equal(withdrawn.status,200);
  assert.equal(withdrawn.body.completion.confirmed_count,1);
  const partnerAgain=await invoke({method:'POST',query:{endpoint:'session-completion'},headers:{'x-test-auth':'partner'},body:{
    room_id:'week_10_pair_20',action:'confirm',base_version:withdrawn.body.completion.version,
  }});
  const third=await invoke({method:'POST',query:{endpoint:'session-completion'},headers:{'x-test-auth':'third'},body:{
    room_id:'week_10_pair_20',action:'confirm',base_version:partnerAgain.body.completion.version,
  }});
  assert.equal(third.status,200);
  assert.equal(third.body.completion.state,'completed');
  assert.equal(third.body.completion.confirmed_count,3);
  assert.match(third.body.completion.completed_at,/Z$/);
  currentDb.close();
  currentDb=createClient({url:`file:${join(currentDirectory,'test.sqlite')}`});
  const recovered=await invoke();
  assert.deepEqual(recovered.body.completion,third.body.completion,
    'unanimous completion survives a database client restart');
  const terminal=await invoke({method:'POST',query:{endpoint:'session-completion'},body:{
    room_id:'week_10_pair_20',action:'withdraw',base_version:recovered.body.completion.version,
  }});
  assert.equal(terminal.status,409);
  assert.equal(terminal.body.code,'session_completion_terminal');
  assert.deepEqual(terminal.body.completion,third.body.completion);
});

test('concurrent final confirmation and withdrawal serialize to one non-contradictory receipt set',async()=>{
  currentDb=await readyDatabase();
  const second=createClient({url:`file:${join(currentDirectory,'test.sqlite')}`});
  const room={roomId:'week_10_pair_23',weekId:10,pairGroupId:23};
  try{
    const initial=await readAuthorizedSessionCompletion(currentDb,{viewerId:4,...room,versionKey:VERSION_KEY});
    const awaiting=await mutateAuthorizedSessionCompletion(currentDb,{viewerId:4,mutation:{
      ...room,action:'confirm',baseVersion:initial.completion.version,
    },versionKey:VERSION_KEY});
    assert.equal(awaiting.completion.state,'awaiting_participants');
    const baseVersion=awaiting.completion.version;
    const raced=await Promise.allSettled([
      mutateAuthorizedSessionCompletion(currentDb,{viewerId:4,mutation:{
        ...room,action:'withdraw',baseVersion,
      },versionKey:VERSION_KEY}),
      mutateAuthorizedSessionCompletion(second,{viewerId:6,mutation:{
        ...room,action:'confirm',baseVersion,
      },versionKey:VERSION_KEY}),
    ]);
    assert.equal(raced.filter(result=>result.status==='fulfilled').length,1);
    const rejected=raced.find(result=>result.status==='rejected');
    assert.ok(rejected?.reason instanceof SessionCompletionConflictError);
    const settled=await readAuthorizedSessionCompletion(currentDb,{viewerId:4,...room,versionKey:VERSION_KEY});
    const receiptCount=Number((await currentDb.execute(`SELECT COUNT(*) AS c
      FROM session_completion_receipts WHERE week_id=10 AND pair_group_id=23`)).rows[0].c);
    if(settled.completion.state==='completed'){
      assert.equal(receiptCount,2);
      assert.equal(rejected.reason.code,'session_completion_terminal');
    }else{
      assert.equal(settled.completion.state,'not_recorded');
      assert.equal(receiptCount,0);
      assert.equal(rejected.reason.code,'session_completion_changed');
    }
  }finally{ second.close(); }
});

test('an ambiguous commit is never retried and a later read reconciles the durable receipt',async()=>{
  currentDb=await readyDatabase();
  const room={roomId:'week_11_pair_21',weekId:11,pairGroupId:21};
  const initial=await readAuthorizedSessionCompletion(currentDb,{viewerId:2,...room,versionKey:VERSION_KEY});
  let attempts=0;
  const ambiguousDb={
    async transaction(mode){
      attempts+=1;
      const transaction=await currentDb.transaction(mode);
      return {
        execute:(...args)=>transaction.execute(...args),
        rollback:()=>transaction.rollback(),
        close:()=>transaction.close(),
        async commit(){
          await transaction.commit();
          throw Object.assign(new Error('database is busy'),{code:'SQLITE_BUSY'});
        },
      };
    },
  };
  await assert.rejects(()=>mutateAuthorizedSessionCompletion(ambiguousDb,{viewerId:2,mutation:{
    ...room,action:'confirm',baseVersion:initial.completion.version,
  },versionKey:VERSION_KEY}),error=>error?.code==='SQLITE_BUSY');
  assert.equal(attempts,1);
  const recovered=await readAuthorizedSessionCompletion(currentDb,{viewerId:2,...room,versionKey:VERSION_KEY});
  assert.equal(recovered.completion.state,'completed');
  assert.equal(recovered.completion.confirmed_count,1);
});

test('AI and mixed-source pairs require only their authenticated human participant',async()=>{
  currentDb=await readyDatabase();
  for(const roomId of ['week_11_pair_21','week_12_pair_22']){
    const initial=await invoke({query:{endpoint:'session-completion',room_id:roomId}});
    assert.equal(initial.status,200,roomId);
    assert.equal(initial.body.completion.required_count,1);
    const completed=await invoke({method:'POST',query:{endpoint:'session-completion'},body:{
      room_id:roomId,action:'confirm',base_version:initial.body.completion.version,
    }});
    assert.equal(completed.status,200,roomId);
    assert.equal(completed.body.completion.state,'completed');
  }
});

test('history, recap aggregates, and stats distinguish pairings from unanimously completed sessions',async()=>{
  currentDb=await readyDatabase();
  const initialHistory=await invoke({url:'/api/history',query:{endpoint:'history'}});
  assert.equal(initialHistory.status,200,JSON.stringify(initialHistory.body));
  assert.equal(initialHistory.body.history.length,3);
  assert.ok(initialHistory.body.history.every(row=>row.completion.state==='not_recorded'));
  let version=(await invoke()).body.completion.version;
  for(const identity of ['member','partner','third']){
    const response=await invoke({method:'POST',query:{endpoint:'session-completion'},headers:{'x-test-auth':identity},body:{
      room_id:'week_10_pair_20',action:'confirm',base_version:version,
    }});
    assert.equal(response.status,200,identity);
    version=response.body.completion.version;
  }
  const history=await invoke({url:'/api/history',query:{endpoint:'history'}});
  const completed=history.body.history.find(row=>Number(row.pg_id)===20).completion;
  assert.deepEqual({...completed,version:'opaque',completed_at:'time'}, {
    state:'completed',viewer_confirmed:true,confirmed_count:3,required_count:3,
    version:'opaque',completed_at:'time',
  });
  assert.equal(JSON.stringify(history.body).includes('confirmed_at'),false);
  const stats=await invoke({url:'/api/stats',query:{endpoint:'stats'}});
  assert.equal(stats.status,200,JSON.stringify(stats.body));
  assert.equal(Number(stats.body.total_pairs),4);
  assert.equal(Number(stats.body.total_sessions),1);
  assert.equal(Number(stats.body.your_pairings),3);
  assert.equal(Number(stats.body.your_sessions),1);
});

test('absent, unauthorized, legacy-collision, and actor fields are rejected without disclosure',async()=>{
  currentDb=await readyDatabase();
  const unauthorized=await invoke({headers:{'x-test-auth':'outsider'}});
  const absent=await invoke({query:{endpoint:'session-completion',room_id:'week_10_pair_999'}});
  const legacy=await invoke({query:{endpoint:'session-completion',room_id:'week_12_pair_22'},headers:{'x-test-auth':'outsider'}});
  assert.equal(unauthorized.status,404);
  assert.deepEqual(absent.body,unauthorized.body);
  assert.deepEqual(legacy.body,unauthorized.body);
  const forged=await invoke({method:'POST',query:{endpoint:'session-completion'},body:{
    room_id:'week_10_pair_20',action:'confirm',base_version:'a'.repeat(64),user_id:2,
  }});
  assert.equal(forged.status,400);
});

test('completion readiness fails closed without runtime DDL',async()=>{
  currentDb=await readyDatabase();
  await currentDb.execute('DROP TABLE session_completion_receipts');
  const response=await invoke();
  assert.equal(response.status,503);
  assert.deepEqual(response.body,{error:'session completion unavailable'});
});
