import assert from 'node:assert/strict';
import { createHash, createHmac } from 'node:crypto';
import { afterEach, beforeEach, mock, test } from 'node:test';
import { createClient } from '@libsql/client';
import {
  ensurePairRecapReadiness,
  MAX_RECAP_ACTIVITY,
  MAX_RECAP_RUN_SCAN,
  newestRecapActivity,
  PairRecapDataError,
  PairRecapInputError,
  parsePairRecapQuery,
  projectRecapPair,
  projectRecapRun,
  projectRecapSchedule,
  projectRecapWorkspace,
} from '../../api/_pair-recap.js';
import { canonicalCompletionPair, projectSessionCompletion } from '../../api/_session-completion.js';

const TEST_SECRET='pair-recap-test-secret-at-least-thirty-two-characters';
let currentDb=null;

function authPayload(req){
  const identity=req?.headers?.['x-test-auth'];
  if(identity==='member') return {id:2,email:'member@example.test',name:'Member'};
  if(identity==='partner') return {id:4,email:'partner@example.test',name:'Partner'};
  if(identity==='third') return {id:6,email:'third@example.test',name:'Third'};
  if(identity==='outsider') return {id:9,email:'outsider@example.test',name:'Outsider'};
  return null;
}

mock.module('../../api/_db.js',{
  exports:{
    captureSentryException:()=>null,
    captureSentryMessage:()=>null,
    getAdminEmails:()=>new Set(),
    getClient:()=>currentDb,
    getJwtSecret:()=>TEST_SECRET,
    initSentry:()=>{},
    isSentryConfigured:()=>false,
    verifyMutationOrigin:()=>true,
    verifyRequestAuth:authPayload,
    verifySignedRequestAuth:authPayload,
  },
});

const {default:dataHandler}=await import('../../api/data.js');

function sqlText(statement){
  return typeof statement==='string'?statement:String(statement?.sql||'');
}

function invoke({method='GET',url='/api/pair-recap',query={endpoint:'pair-recap',room_id:'week_10_pair_20'},headers={'x-test-auth':'member'},body={}}={}){
  return new Promise((resolve,reject)=>{
    let statusCode=200;
    let settled=false;
    const responseHeaders={};
    const finish=payload=>{
      if(settled) return;
      settled=true;
      resolve({status:statusCode,headers:responseHeaders,body:payload});
    };
    const res={
      status(code){ statusCode=code; return this; },
      json(payload){ finish(payload); return this; },
      setHeader(name,value){ responseHeaders[String(name).toLowerCase()]=value; },
      end(payload){ finish(payload); },
    };
    const req={method,url,query,headers,body,socket:{remoteAddress:'127.0.0.1'}};
    Promise.resolve(dataHandler(req,res)).then(()=>finish(undefined)).catch(reject);
  });
}

function runKeyId(secret=TEST_SECRET){
  return createHash('sha256').update(`randori-run-key\0${secret}`,'utf8').digest('hex').slice(0,16);
}

function signedRunSnapshot({userId=2,questionSlug='balanced-template-markers',questionVersion=1,language='javascript',passedCount=3,totalCount=3,resultsJson='[]'}={}){
  const digest=createHash('sha256').update(resultsJson,'utf8').digest('hex');
  const payload=JSON.stringify([2,userId,questionSlug,questionVersion,language,passedCount,totalCount,digest]);
  const attestation=createHmac('sha256',TEST_SECRET)
    .update(`randori-run-attestation-v2\0${payload}`,'utf8')
    .digest('hex');
  return JSON.stringify({
    source:'original-catalog',version:questionVersion,total_count:totalCount,
    attestation_version:2,attestation_key_id:runKeyId(),attestation,
  });
}

async function readyDatabase(){
  const db=createClient({url:'file::memory:'});
  await db.batch([
    `CREATE TABLE auth_accounts (id INTEGER PRIMARY KEY,display_name TEXT NOT NULL)`,
    `CREATE TABLE users (id INTEGER PRIMARY KEY,name TEXT NOT NULL)`,
    `CREATE TABLE pairing_participants (
      week_id INTEGER NOT NULL,user_id INTEGER NOT NULL,source TEXT NOT NULL,
      PRIMARY KEY (week_id,user_id)
    )`,
    `CREATE TABLE pairing_weeks (id INTEGER PRIMARY KEY,week_label TEXT NOT NULL,week_start TEXT NOT NULL)`,
    `CREATE TABLE pairing_groups (
      id INTEGER PRIMARY KEY,week_id INTEGER NOT NULL,user_a_id INTEGER NOT NULL,
      user_b_id INTEGER NOT NULL,user_c_id INTEGER,is_ai_pair INTEGER NOT NULL,
      topic TEXT,topic_kind TEXT
    )`,
    `CREATE TABLE pair_schedules (
      week_id INTEGER NOT NULL,pair_group_id INTEGER NOT NULL,agreed_time TEXT,updated_at TEXT
    )`,
    `CREATE TABLE pair_messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,week_id INTEGER NOT NULL,pair_group_id INTEGER NOT NULL,
      sender_id INTEGER NOT NULL,message TEXT NOT NULL,created_at TEXT NOT NULL
    )`,
    `CREATE TABLE session_runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,user_id INTEGER NOT NULL,week_id INTEGER,pair_group_id INTEGER,
      question_slug TEXT,language TEXT,test_cases_snapshot TEXT,results_json TEXT,
      passed_count INTEGER,total_count INTEGER,duration_ms INTEGER,created_at TEXT
    )`,
    `CREATE TABLE pair_room_snapshots (
      room_id TEXT PRIMARY KEY,week_id INTEGER NOT NULL,pair_group_id INTEGER NOT NULL,
      revision INTEGER NOT NULL,schema_version INTEGER NOT NULL,language TEXT NOT NULL,
      question_id TEXT NOT NULL,updated_at TEXT NOT NULL,code TEXT,board TEXT,
      client_id TEXT,client_seq INTEGER,updated_by INTEGER
    )`,
    `CREATE TABLE session_completion_receipts (
      week_id INTEGER NOT NULL,pair_group_id INTEGER NOT NULL,user_id INTEGER NOT NULL,
      participant_source TEXT NOT NULL,pair_user_a_id INTEGER NOT NULL,
      pair_user_b_id INTEGER NOT NULL,pair_user_c_id INTEGER,confirmed_at TEXT NOT NULL,
      PRIMARY KEY(week_id,pair_group_id,user_id)
    )`,
    `INSERT INTO auth_accounts (id,display_name) VALUES
      (2,'Member'),(4,'Partner'),(6,'Third'),(9,'Outsider')`,
    `INSERT INTO users (id,name) VALUES (2,'Legacy Collision'),(12,'Legacy Partner')`,
    `INSERT INTO pairing_participants (week_id,user_id,source) VALUES
      (10,2,'auth'),(10,4,'auth'),(10,6,'auth'),(10,9,'auth'),(10,12,'users'),
      (11,2,'auth'),(12,2,'users'),(12,12,'users')`,
    `INSERT INTO pairing_weeks (id,week_label,week_start) VALUES
      (10,'2026-W38','2026-09-14T07:00:00.000Z'),
      (11,'2026-W39','2026-09-21T07:00:00.000Z'),
      (12,'2025-W01','2024-12-30T08:00:00.000Z')`,
    `INSERT INTO pairing_groups
      (id,week_id,user_a_id,user_b_id,user_c_id,is_ai_pair,topic,topic_kind) VALUES
      (20,10,2,4,6,0,'Pick together','both'),
      (21,10,4,9,NULL,0,'System design','system-design'),
      (22,11,2,2,NULL,1,'Algorithms','dsa'),
      (23,10,2,12,NULL,0,NULL,NULL),
      (24,12,2,12,NULL,0,'Legacy only','dsa')`,
  ],'write');
  return db;
}

function tracedClient(delegate,calls){
  return {
    async execute(statement){
      calls.push({kind:'execute',sql:sqlText(statement),args:statement?.args||[]});
      return delegate.execute(statement);
    },
    async batch(statements,mode){
      calls.push({kind:'batch',mode,statements:statements.map(statement=>({sql:sqlText(statement),args:statement?.args||[]}))});
      return delegate.batch(statements,mode);
    },
    close(){ return delegate.close(); },
  };
}

beforeEach(()=>{
  currentDb=null;
  delete process.env.TURSO_DATABASE_URL;
  delete process.env.RUN_ATTESTATION_SECRET;
  delete process.env.RUN_ATTESTATION_PREVIOUS_SECRETS;
});

afterEach(()=>{
  try{ currentDb?.close?.(); }catch{}
  currentDb=null;
});

test('pair recap query accepts one exact canonical room and rejects every ambiguous form',()=>{
  assert.deepEqual(parsePairRecapQuery({
    url:'/api/pair-recap',query:{endpoint:'pair-recap',room_id:'week_10_pair_20'},
  }),{roomId:'week_10_pair_20',weekId:10,pairGroupId:20});

  for(const req of [
    {url:'/api/pair-recap',query:{}},
    {url:'/api/pair-recap',query:{endpoint:'pair-recap',room_id:'week_01_pair_20'}},
    {url:'/api/pair-recap',query:{endpoint:'pair-recap',room_id:'week_10_pair_20',week_id:'10'}},
    {url:'/api/pair-recap',query:{endpoint:'pair-recap',room_id:['week_10_pair_20','week_11_pair_22']}},
    {url:'/api/pair-recap?room_id=week_10_pair_20&room_id=week_11_pair_22',query:{endpoint:'pair-recap'}},
    {url:'/api/data?endpoint=pair-recap&endpoint=pair-recap&room_id=week_10_pair_20',query:{}},
    {url:'/api/pair-recap',query:{endpoint:'messages',room_id:'week_10_pair_20'}},
  ]) assert.throws(()=>parsePairRecapQuery(req),PairRecapInputError);
});

test('pair recap projection validates pair, schedule, run, and workspace storage',()=>{
  const pair=projectRecapPair({
    pair_id:20,week_id:10,week_label:'2026-W38',week_start:'2026-09-14 07:00:00',
    topic:'Pick together',topic_kind:'both',is_ai_pair:0,
    user_a_id:2,user_a_name:' Member ',user_b_id:4,user_b_name:'Partner',user_c_id:null,user_c_name:null,
  },2);
  assert.equal(pair.week_start,'2026-09-14T07:00:00.000Z');
  assert.deepEqual(pair.members,[
    {id:2,display_name:'Member',is_me:true,is_ai:false},
    {id:4,display_name:'Partner',is_me:false,is_ai:false},
  ]);
  assert.deepEqual(projectRecapSchedule({
    agreed_time:'Sunday afternoon',updated_at:'2026-09-18 06:07:08',
  }),{
    agreed_time:null,legacy_agreed_time:'Sunday afternoon',updated_at:'2026-09-18T06:07:08.000Z',
  });
  assert.deepEqual(projectRecapSchedule({agreed_time:null,updated_at:null}),{
    agreed_time:null,legacy_agreed_time:null,updated_at:null,
  });
  assert.deepEqual(projectRecapWorkspace(null),{artifact_available:false});
  assert.deepEqual(projectRecapWorkspace({
    revision:7,schema_version:3,language:'python',question_id:'shortest-handoff-path@2',updated_at:'2026-09-18 06:07:08',
  }),{
    artifact_available:true,revision:7,schema_version:3,question_slug:'shortest-handoff-path',
    question_version:2,language:'python',updated_at:'2026-09-18T06:07:08.000Z',
  });

  assert.throws(()=>projectRecapPair({pair_id:20},2),PairRecapDataError);
  assert.throws(()=>projectRecapPair({
    pair_id:20,week_id:10,week_label:'2026-W38',week_start:'2026-09-14 07:00:00',
    topic:'Pick together',topic_kind:'both',is_ai_pair:null,
    user_a_id:2,user_a_name:'Member',user_b_id:4,user_b_name:'Partner',user_c_id:null,user_c_name:null,
  },2),PairRecapDataError);
  assert.throws(()=>projectRecapPair({
    pair_id:20,week_id:10,week_label:'2026-W38',week_start:'2026-09-14 07:00:00',
    topic:'Pick together',topic_kind:'both',is_ai_pair:1,
    user_a_id:2,user_a_name:'Member',user_b_id:4,user_b_name:'Partner',user_c_id:null,user_c_name:null,
  },2),PairRecapDataError);
  assert.throws(()=>projectRecapSchedule({agreed_time:null,updated_at:'not-a-date'}),PairRecapDataError);
  assert.throws(()=>projectRecapWorkspace({revision:1,schema_version:3,language:'javascript',question_id:'Bad Slug',updated_at:'2026-09-18 06:07:08'}),PairRecapDataError);
  assert.equal(projectRecapRun({
    id:1,user_id:2,runner_display_name:'Member',question_slug:'balanced-template-markers',language:'javascript',
    passed_count:3,total_count:3,duration_ms:10,created_at:'2026-09-18 06:07:08',
    test_cases_snapshot:'{invalid',results_json:'[]',
  },()=>true),null,'an invalid attestation envelope is omitted rather than trusted');
  assert.equal(projectRecapRun({test_cases_snapshot:null},()=>true),null,
    'legacy runs without an attestation envelope are omitted before unrelated fields are parsed');

  const tied=newestRecapActivity([
    {kind:'message',event_id:'message:9',created_at:'2026-09-18T06:00:00.000Z'},
    {kind:'message',event_id:'message:2',created_at:'2026-09-18T06:00:00.000Z'},
  ],[
    {kind:'run',event_id:'run:1',created_at:'2026-09-18T06:00:00.000Z'},
  ]);
  assert.deepEqual(tied.map(event=>event.event_id),['message:2','message:9','run:1']);
});

test('pair recap returns one exact redacted historical-room response',async()=>{
  const database=await readyDatabase();
  const resultsJson=JSON.stringify([{pass:true,stdout:'PRIVATE_PROVIDER_OUTPUT'}]);
  const invalidSnapshot=JSON.stringify({
    source:'original-catalog',version:1,total_count:2,attestation_version:2,
    attestation_key_id:'0000000000000000',attestation:'0'.repeat(64),
  });
  await database.batch([
    {sql:`INSERT INTO pair_schedules (week_id,pair_group_id,agreed_time,updated_at) VALUES (?,?,?,?)`,args:[10,20,'2026-09-20T10:00:00.000Z','2026-09-18 06:00:00']},
    {sql:`INSERT INTO pair_messages (id,week_id,pair_group_id,sender_id,message,created_at) VALUES (?,?,?,?,?,?)`,args:[11,10,20,4,'Ready to practise','2026-09-18 06:01:00']},
    {sql:`INSERT INTO session_runs (id,user_id,week_id,pair_group_id,question_slug,language,test_cases_snapshot,results_json,passed_count,total_count,duration_ms,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,args:[12,2,10,20,'balanced-template-markers','javascript',signedRunSnapshot({resultsJson}),resultsJson,3,3,18,'2026-09-18 06:01:00']},
    {sql:`INSERT INTO session_runs (id,user_id,week_id,pair_group_id,question_slug,language,test_cases_snapshot,results_json,passed_count,total_count,duration_ms,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,args:[13,4,10,20,'capacity-upgrade-index','python',invalidSnapshot,'[]',2,2,9,'2026-09-18 06:02:00']},
    {sql:`INSERT INTO pair_room_snapshots (room_id,week_id,pair_group_id,revision,schema_version,language,question_id,updated_at,code,board,client_id,client_seq,updated_by) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,args:['week_10_pair_20',10,20,7,3,'javascript','balanced-template-markers@1','2026-09-18 06:03:00','PRIVATE_SOURCE','PRIVATE_BOARD','PRIVATE_CLIENT',8,2]},
  ],'write');
  const calls=[];
  currentDb=tracedClient(database,calls);

  const response=await invoke();
  assert.equal(response.status,200,JSON.stringify(response.body));
  assert.equal(response.headers['cache-control'],'private, no-store');
  const completion=projectSessionCompletion(canonicalCompletionPair({
    pair_group_id:20,week_id:10,user_a_id:2,user_b_id:4,user_c_id:6,is_ai_pair:0,
    user_a_source:'auth',user_b_source:'auth',user_c_source:'auth',
  },2),[],TEST_SECRET);
  assert.deepEqual(response.body,{
    ok:true,
    room_id:'week_10_pair_20',
    recap:{
      pair:{
        id:20,week_id:10,week_label:'2026-W38',week_start:'2026-09-14T07:00:00.000Z',
        topic:'Pick together',topic_kind:'both',is_ai:false,
        members:[
          {id:2,display_name:'Member',is_me:true,is_ai:false},
          {id:4,display_name:'Partner',is_me:false,is_ai:false},
          {id:6,display_name:'Third',is_me:false,is_ai:false},
        ],
      },
      schedule:{agreed_time:'2026-09-20T10:00:00.000Z',legacy_agreed_time:null,updated_at:'2026-09-18T06:00:00.000Z'},
      activity:[
        {kind:'message',event_id:'message:11',created_at:'2026-09-18T06:01:00.000Z',actor:{id:4,display_name:'Partner'},message:'Ready to practise'},
        {kind:'run',event_id:'run:12',created_at:'2026-09-18T06:01:00.000Z',actor:{id:2,display_name:'Member'},question_slug:'balanced-template-markers',question_version:1,language:'javascript',passed_count:3,total_count:3,duration_ms:18,authoritative:true},
      ],
      workspace:{artifact_available:true,revision:7,schema_version:3,question_slug:'balanced-template-markers',question_version:1,language:'javascript',updated_at:'2026-09-18T06:03:00.000Z'},
      completion,
    },
  });
  const serialized=JSON.stringify(response.body);
  for(const secret of ['PRIVATE_PROVIDER_OUTPUT','PRIVATE_SOURCE','PRIVATE_BOARD','PRIVATE_CLIENT','test_cases_snapshot','results_json','proposed_times','attestation']){
    assert.doesNotMatch(serialized,new RegExp(secret));
  }
  const readBatch=calls.find(call=>call.kind==='batch');
  assert.equal(readBatch.mode,'read');
  assert.equal(readBatch.statements.length,6);
  for(const statement of readBatch.statements){
    assert.match(statement.sql,/pairing_groups/);
    assert.match(statement.sql,/pg\.user_a_id=\? OR pg\.user_b_id=\? OR pg\.user_c_id=\?/);
  }
  const workspaceSql=readBatch.statements[4].sql;
  assert.doesNotMatch(workspaceSql,/\b(?:code|board|client_id|client_seq|updated_by)\b/);
});

test('pair recap authenticates before storage and hides absent versus unauthorized rooms',async()=>{
  const calls=[];
  currentDb={async execute(statement){ calls.push(sqlText(statement)); throw new Error('must not query'); }};
  const anonymous=await invoke({headers:{}});
  assert.equal(anonymous.status,401);
  assert.equal(anonymous.headers['cache-control'],'private, no-store');
  const anonymousPost=await invoke({method:'POST',headers:{}});
  assert.equal(anonymousPost.status,401,'authentication precedes method disclosure');
  assert.equal(calls.length,0);

  const wrongMethod=await invoke({method:'POST'});
  assert.equal(wrongMethod.status,405);
  assert.equal(wrongMethod.headers.allow,'GET');
  const malformed=await invoke({query:{endpoint:'pair-recap',room_id:'week_01_pair_20'}});
  assert.equal(malformed.status,400);
  const extra=await invoke({query:{endpoint:'pair-recap',room_id:'week_10_pair_20',week_id:'10'}});
  assert.equal(extra.status,400);
  assert.equal(calls.length,0,'method and query validation happen before database access');

  const database=await readyDatabase();
  const storageCalls=[];
  currentDb=tracedClient(database,storageCalls);
  const unauthorized=await invoke({headers:{'x-test-auth':'outsider'}});
  const absent=await invoke({query:{endpoint:'pair-recap',room_id:'week_10_pair_999'}});
  const legacyCollision=await invoke({query:{endpoint:'pair-recap',room_id:'week_12_pair_24'}});
  assert.equal(unauthorized.status,404);
  assert.deepEqual(unauthorized.body,{error:'pair not found'});
  assert.equal(absent.status,404);
  assert.deepEqual(absent.body,unauthorized.body);
  assert.equal(legacyCollision.status,404);
  assert.deepEqual(legacyCollision.body,unauthorized.body,
    'an auth account cannot inherit a colliding legacy-users pairing id');
  assert.equal(storageCalls.some(call=>/pair_(?:schedules|messages|room_snapshots)|session_runs/.test(call.sql)),false,
    'inaccessible rooms never reach recap storage');
});

test('pair recap keeps valid legacy members and nullable metadata available',async()=>{
  currentDb=await readyDatabase();
  const response=await invoke({query:{endpoint:'pair-recap',room_id:'week_10_pair_23'}});
  assert.equal(response.status,200,JSON.stringify(response.body));
  assert.deepEqual(response.body.recap.pair.members,[
    {id:2,display_name:'Member',is_me:true,is_ai:false},
    {id:12,display_name:'Legacy Partner',is_me:false,is_ai:false},
  ]);
  assert.equal(response.body.recap.pair.topic,null);
  assert.equal(response.body.recap.pair.topic_kind,null);
});

test('history excludes a colliding legacy identity while retaining source-tagged memberships',async()=>{
  currentDb=await readyDatabase();
  const response=await invoke({url:'/api/history',query:{endpoint:'history'}});
  assert.equal(response.status,200,JSON.stringify(response.body));
  assert.equal(response.headers['cache-control'],'private, no-store');
  assert.deepEqual(response.body.history.map(item=>item.pg_id),[22,23,20]);
  assert.equal(response.body.history.some(item=>item.pg_id===24),false);
  assert.equal(response.body.history.find(item=>item.pg_id===23).partner_name,'Legacy Partner');
});

test('history reports source-snapshot storage failures without exposing database details',async()=>{
  const delegate=await readyDatabase();
  currentDb={
    async execute(statement){
      const sql=sqlText(statement);
      if(sql.includes('JOIN pairing_participants viewer')){
        throw new Error('private database diagnostic: no such table pairing_participants');
      }
      return delegate.execute(statement);
    },
    batch:(statements,mode)=>{
      if(statements.some(statement=>sqlText(statement).includes('JOIN pairing_participants viewer'))){
        throw new Error('private database diagnostic: no such table pairing_participants');
      }
      return delegate.batch(statements,mode);
    },
    close:()=>delegate.close(),
  };
  const response=await invoke({url:'/api/history',query:{endpoint:'history'}});
  assert.equal(response.status,503);
  assert.deepEqual(response.body,{error:'history unavailable'});
  assert.equal('detail' in response.body,false);
});

test('pair recap readiness coalesces probes, performs no DDL, and retries failures',async()=>{
  let release;
  const gate=new Promise(resolve=>{ release=resolve; });
  const calls=[];
  const coalesced={
    async execute(statement){
      calls.push(sqlText(statement));
      if(calls.length===1) await gate;
      return {rows:[]};
    },
  };
  const first=ensurePairRecapReadiness(coalesced);
  const second=ensurePairRecapReadiness(coalesced);
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(calls.length,1);
  release();
  await Promise.all([first,second]);
  assert.equal(calls.length,10);
  await ensurePairRecapReadiness(coalesced);
  assert.equal(calls.length,10,'successful readiness remains cached');
  assert.equal(calls.some(sql=>/\b(?:CREATE|ALTER|DROP)\b/i.test(sql)),false);

  let attempts=0;
  const retryable={
    async execute(){
      attempts+=1;
      if(attempts===1) throw new Error('missing table');
      return {rows:[]};
    },
  };
  await assert.rejects(()=>ensurePairRecapReadiness(retryable),/missing table/);
  await ensurePairRecapReadiness(retryable);
  assert.equal(attempts,11,'a failed readiness promise is evicted before the ten probes retry');
});

test('pair recap returns the newest combined 50 events in stable ascending order',async()=>{
  const database=await readyDatabase();
  const statements=[];
  for(let index=0;index<30;index+=1){
    const minute=String(index).padStart(2,'0');
    const createdAt=`2026-09-18 07:${minute}:00`;
    statements.push({
      sql:`INSERT INTO pair_messages (id,week_id,pair_group_id,sender_id,message,created_at) VALUES (?,?,?,?,?,?)`,
      args:[100+index,10,20,4,`message ${index}`,createdAt],
    });
    const resultsJson=JSON.stringify([{index,pass:true}]);
    statements.push({
      sql:`INSERT INTO session_runs (id,user_id,week_id,pair_group_id,question_slug,language,test_cases_snapshot,results_json,passed_count,total_count,duration_ms,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
      args:[200+index,2,10,20,'balanced-template-markers','javascript',signedRunSnapshot({resultsJson}),resultsJson,3,3,index,createdAt],
    });
  }
  await database.batch(statements,'write');
  currentDb=database;

  const response=await invoke();
  assert.equal(response.status,200,JSON.stringify(response.body));
  assert.equal(response.body.recap.activity.length,MAX_RECAP_ACTIVITY);
  assert.deepEqual(response.body.recap.activity.slice(0,2).map(event=>event.event_id),['message:105','run:205']);
  assert.deepEqual(response.body.recap.activity.slice(-2).map(event=>event.event_id),['message:129','run:229']);
  for(let index=1;index<response.body.recap.activity.length;index+=1){
    const previous=response.body.recap.activity[index-1];
    const current=response.body.recap.activity[index];
    assert.ok(previous.created_at<=current.created_at);
    if(previous.created_at===current.created_at) assert.ok(previous.kind<=current.kind);
  }
});

test('run scan overflow fails closed unless 50 verified runs establish the activity boundary',async()=>{
  const database=await readyDatabase();
  const invalidSnapshot=JSON.stringify({
    source:'original-catalog',version:1,total_count:1,attestation_version:2,
    attestation_key_id:'0000000000000000',attestation:'0'.repeat(64),
  });
  const statements=[];
  for(let index=0;index<50;index+=1){
    statements.push({
      sql:`INSERT INTO pair_messages (week_id,pair_group_id,sender_id,message,created_at) VALUES (?,?,?,?,?)`,
      args:[10,20,4,`older message ${index}`,`2026-09-17 06:${String(index).padStart(2,'0')}:00`],
    });
  }
  for(let index=0;index<=MAX_RECAP_RUN_SCAN;index+=1){
    statements.push({
      sql:`INSERT INTO session_runs (user_id,week_id,pair_group_id,question_slug,language,test_cases_snapshot,results_json,passed_count,total_count,duration_ms,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      args:[2,10,20,'balanced-template-markers','javascript',invalidSnapshot,'[]',1,1,1,
        `2026-09-18 ${String(Math.floor(index/60)).padStart(2,'0')}:${String(index%60).padStart(2,'0')}:00`],
    });
  }
  await database.batch(statements,'write');
  currentDb=database;
  const response=await invoke();
  assert.equal(response.status,503);
  assert.deepEqual(response.body,{error:'pair recap unavailable'});

  const verified=[];
  for(let index=0;index<MAX_RECAP_ACTIVITY;index+=1){
    const resultsJson=JSON.stringify([{index,pass:true}]);
    verified.push({
      sql:`INSERT INTO session_runs (user_id,week_id,pair_group_id,question_slug,language,test_cases_snapshot,results_json,passed_count,total_count,duration_ms,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      args:[2,10,20,'balanced-template-markers','javascript',signedRunSnapshot({resultsJson}),resultsJson,3,3,index,
        `2026-09-19 06:${String(index).padStart(2,'0')}:00`],
    });
  }
  await database.batch(verified,'write');
  const bounded=await invoke();
  assert.equal(bounded.status,200,JSON.stringify(bounded.body));
  assert.equal(bounded.body.recap.activity.length,MAX_RECAP_ACTIVITY);
  assert.ok(bounded.body.recap.activity.every(event=>event.kind==='run'&&event.authoritative===true));
});

test('invalid run attestations are omitted and malformed selected storage fails closed',async()=>{
  const database=await readyDatabase();
  const invalidSnapshot=JSON.stringify({
    source:'original-catalog',version:1,total_count:1,attestation_version:2,
    attestation_key_id:'0000000000000000',attestation:'0'.repeat(64),
  });
  await database.batch([
    {sql:`INSERT INTO session_runs (id,user_id,week_id,pair_group_id,question_slug,language,test_cases_snapshot,results_json,passed_count,total_count,duration_ms,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,args:[1,2,10,20,'balanced-template-markers','javascript',invalidSnapshot,'[]',1,1,2,'2026-09-18 06:00:00']},
    {sql:`INSERT INTO pair_messages (id,week_id,pair_group_id,sender_id,message,created_at) VALUES (?,?,?,?,?,?)`,args:[2,10,20,4,'still visible','2026-09-18 06:01:00']},
  ],'write');
  currentDb=database;
  const safe=await invoke();
  assert.equal(safe.status,200);
  assert.deepEqual(safe.body.recap.activity.map(event=>event.kind),['message']);

  await database.execute(`UPDATE pair_messages SET created_at='malformed' WHERE id=2`);
  const malformed=await invoke();
  assert.equal(malformed.status,503);
  assert.deepEqual(malformed.body,{error:'pair recap unavailable'});
});

test('activity attributed to a non-member fails closed',async()=>{
  const database=await readyDatabase();
  await database.execute({
    sql:`INSERT INTO pair_messages (id,week_id,pair_group_id,sender_id,message,created_at) VALUES (?,?,?,?,?,?)`,
    args:[8,10,20,9,'not a pair member','2026-09-18 06:01:00'],
  });
  currentDb=database;
  const response=await invoke();
  assert.equal(response.status,503);
  assert.deepEqual(response.body,{error:'pair recap unavailable'});
});

test('room deletion between authorization and the read snapshot returns the generic 404',async()=>{
  const database=await readyDatabase();
  let deleted=false;
  currentDb={
    execute:statement=>database.execute(statement),
    async batch(statements,mode){
      assert.equal(mode,'read');
      if(!deleted){
        deleted=true;
        await database.execute(`DELETE FROM pairing_groups WHERE id=20 AND week_id=10`);
      }
      return database.batch(statements,mode);
    },
    close:()=>database.close(),
  };

  const response=await invoke();
  assert.equal(deleted,true);
  assert.equal(response.status,404);
  assert.deepEqual(response.body,{error:'pair not found'});
});

test('pair recap schema failure returns a generic 503 and retries after repair',async()=>{
  const database=await readyDatabase();
  await database.execute(`DROP TABLE pair_room_snapshots`);
  const calls=[];
  currentDb=tracedClient(database,calls);
  const first=await invoke();
  assert.equal(first.status,503);
  assert.deepEqual(first.body,{error:'pair recap unavailable'});
  assert.equal(calls.some(call=>/\b(?:CREATE|ALTER|DROP)\b/i.test(call.sql)),false);

  await database.execute(`CREATE TABLE pair_room_snapshots (
    room_id TEXT PRIMARY KEY,week_id INTEGER NOT NULL,pair_group_id INTEGER NOT NULL,
    revision INTEGER NOT NULL,schema_version INTEGER NOT NULL,language TEXT NOT NULL,
    question_id TEXT NOT NULL,updated_at TEXT NOT NULL
  )`);
  const recovered=await invoke();
  assert.equal(recovered.status,200,'failed readiness is evicted so the next request probes again');
  assert.deepEqual(recovered.body.recap.workspace,{artifact_available:false});
});
