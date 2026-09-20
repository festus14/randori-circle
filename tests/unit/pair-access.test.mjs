import assert from 'node:assert/strict';
import {afterEach,mock,test} from 'node:test';
import {createClient} from '@libsql/client';

let currentDb=null;
let providerCalls=0;
const originalMembershipFlag=process.env.CIRCLE_MEMBERSHIP_ENABLED;

function authPayload(req){
  if(req?.headers?.['x-test-auth']==='member'){
    return {id:2,email:'member@example.test',name:'Member'};
  }
  return null;
}

mock.module('../../api/_db.js',{
  exports:{
    captureSentryException:()=>null,
    captureSentryMessage:()=>null,
    getAdminEmails:()=>new Set(),
    getClient:()=>currentDb,
    getJwtSecret:()=>'pair-access-test-secret-at-least-thirty-two-characters',
    initSentry:()=>{},
    isSentryConfigured:()=>false,
    verifyMutationOrigin:()=>true,
    verifyRequestAuth:authPayload,
    verifySignedRequestAuth:authPayload,
  },
});

const [
  {default:dataHandler},
  {AUTH_PAIR_ACCESS_SQL,authPairAccessArgs,authPairAccessSql,getAuthenticatedPairAccess},
  {listPublicExercises},
  {resolvePairingCycle},
]=await Promise.all([
  import('../../api/data.js'),
  import('../../api/_pair-access.js'),
  import('../../api/_catalog.js'),
  import('../../api/_pairing-cycle.js'),
]);

function sqlText(statement){
  return typeof statement==='string'?statement:String(statement?.sql||'');
}

function invoke({method='GET',url='/',query={},headers={'x-test-auth':'member'},body={}}={}){
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

async function seededDatabase({source='auth'}={}){
  const db=createClient({url:'file::memory:'});
  const cycle=resolvePairingCycle();
  const cycleId=cycle.cycleId;
  await db.batch([
    `CREATE TABLE users (id INTEGER PRIMARY KEY,name TEXT,color TEXT,created_at TEXT)`,
    `CREATE TABLE auth_accounts (
      id INTEGER PRIMARY KEY,email TEXT,password_hash TEXT,display_name TEXT,color TEXT,
      created_at TEXT,last_login TEXT,is_available INTEGER,availability_updated_at TEXT,
      is_admin INTEGER,is_demo INTEGER,bio TEXT,tz TEXT,interview_focus TEXT,leetcode_handle TEXT
    )`,
    `CREATE TABLE pairing_weeks (
      id INTEGER PRIMARY KEY,week_label TEXT,week_start TEXT,focus TEXT,created_at TEXT,is_demo INTEGER
    )`,
    `CREATE TABLE pairing_groups (
      id INTEGER PRIMARY KEY,week_id INTEGER NOT NULL,user_a_id INTEGER NOT NULL,
      user_b_id INTEGER NOT NULL,user_c_id INTEGER,is_ai_pair INTEGER,topic TEXT,topic_kind TEXT,created_at TEXT
    )`,
    `CREATE TABLE pairing_participants (
      week_id INTEGER NOT NULL,user_id INTEGER NOT NULL,position INTEGER NOT NULL,
      source TEXT NOT NULL,created_at TEXT,PRIMARY KEY(week_id,user_id)
    )`,
    `CREATE TABLE pairing_week_runs (
      week_label TEXT PRIMARY KEY,week_id INTEGER,generation_token TEXT,generation INTEGER,
      algorithm_version TEXT,algorithm_seed TEXT,participant_count INTEGER,participants_json TEXT,
      created_at TEXT,updated_at TEXT
    )`,
    `CREATE TABLE circles (
      id INTEGER PRIMARY KEY,public_id TEXT NOT NULL UNIQUE,slug TEXT NOT NULL UNIQUE,name TEXT NOT NULL,
      is_primary INTEGER NOT NULL,created_by INTEGER,created_at TEXT,archived_at TEXT
    )`,
    `CREATE TABLE circle_memberships (
      circle_id INTEGER NOT NULL,user_id INTEGER NOT NULL,role TEXT NOT NULL,status TEXT NOT NULL,
      invited_by INTEGER,joined_at TEXT,updated_at TEXT,PRIMARY KEY(circle_id,user_id)
    )`,
    `CREATE TABLE session_runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,user_id INTEGER,week_id INTEGER,pair_group_id INTEGER,
      question_id INTEGER,question_slug TEXT,language TEXT,code TEXT NOT NULL,test_cases_snapshot TEXT,
      results_json TEXT,passed_count INTEGER,total_count INTEGER,duration_ms INTEGER,created_at TEXT
    )`,
    `CREATE TABLE app_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,level TEXT,source TEXT,event TEXT,message TEXT,
      meta_json TEXT,user_id INTEGER,route TEXT,ua TEXT,ip TEXT,created_at TEXT
    )`,
    {sql:`INSERT INTO users (id,name,color) VALUES (2,'Legacy member','#111111')`},
    {sql:`INSERT INTO auth_accounts
      (id,email,password_hash,display_name,color,is_available,is_admin,is_demo,tz,interview_focus)
      VALUES (2,'member@example.test','x','Member','#123456',1,0,0,'UTC','both'),
             (4,'partner@example.test','x','Partner','#654321',1,0,0,'UTC','both')`},
    {sql:`INSERT INTO circles (id,public_id,slug,name,is_primary,created_by,created_at)
      VALUES (1,'circle_test','randori-circle','Test Circle',1,2,datetime('now'))`},
    {sql:`INSERT INTO circle_memberships (circle_id,user_id,role,status,joined_at,updated_at)
      VALUES (1,2,'member','active',datetime('now'),datetime('now')),
             (1,4,'member','active',datetime('now'),datetime('now'))`},
    {sql:`INSERT INTO pairing_weeks (id,week_label,week_start,focus,is_demo)
      VALUES (10,?,?,'both',0)`,args:[cycleId,cycle.startsAt]},
    {sql:`INSERT INTO pairing_week_runs
      (week_label,week_id,generation_token,generation,algorithm_version,algorithm_seed,participant_count,participants_json)
      VALUES (?,10,'published-token',1,'fair-v2',?,2,?)`,args:[cycleId,`${cycleId}:weekly`,JSON.stringify([{user_id:2,source},{user_id:4,source:'auth'}])]},
    {sql:`INSERT INTO pairing_groups
      (id,week_id,user_a_id,user_b_id,user_c_id,is_ai_pair,topic,topic_kind)
      VALUES (20,10,2,4,NULL,0,'Arrays','dsa')`},
    {sql:`INSERT INTO pairing_participants (week_id,user_id,position,source)
      VALUES (10,2,0,?),(10,4,1,'auth')`,args:[source]},
  ],'write');
  return db;
}

function tracedClient(delegate,onExecute=()=>{}){
  return {
    async execute(statement){
      await onExecute(sqlText(statement),statement?.args||[]);
      return delegate.execute(statement);
    },
    batch(statements,mode){ return delegate.batch(statements,mode); },
    close(){ return delegate.close(); },
  };
}

afterEach(()=>{
  try{ currentDb?.close?.(); }catch{}
  currentDb=null;
  providerCalls=0;
  if(originalMembershipFlag===undefined) delete process.env.CIRCLE_MEMBERSHIP_ENABLED;
  else process.env.CIRCLE_MEMBERSHIP_ENABLED=originalMembershipFlag;
});

test('shared pair access requires exact positive identifiers and an auth-source snapshot',async()=>{
  assert.match(AUTH_PAIR_ACCESS_SQL,/pg\.id AS pair_group_id/);
  assert.match(AUTH_PAIR_ACCESS_SQL,/viewer\.source='auth'/);
  assert.doesNotMatch(AUTH_PAIR_ACCESS_SQL,/viewer_membership/);
  const membershipAccessSql=authPairAccessSql({requireActiveMembership:true});
  assert.match(membershipAccessSql,/viewer_membership\.status='active'/);
  assert.match(membershipAccessSql,/viewer_circle\.is_primary=1/);
  assert.deepEqual(authPairAccessArgs({userId:2,weekId:10,pairGroupId:20}),[2,20,10,2,2,2]);
  for(const input of [
    {userId:0,weekId:10,pairGroupId:20},
    {userId:true,weekId:10,pairGroupId:20},
    {userId:[2],weekId:10,pairGroupId:20},
    {userId:{valueOf:()=>2},weekId:10,pairGroupId:20},
    {userId:'2',weekId:10,pairGroupId:20},
    {userId:' 2 ',weekId:10,pairGroupId:20},
    {userId:2,weekId:'10',pairGroupId:20},
    {userId:2,weekId:'10x',pairGroupId:20},
    {userId:2,weekId:10,pairGroupId:'20'},
    {userId:2,weekId:10,pairGroupId:Number.MAX_SAFE_INTEGER+1},
  ]) assert.throws(()=>authPairAccessArgs(input),TypeError);

  process.env.CIRCLE_MEMBERSHIP_ENABLED='true';
  currentDb=await seededDatabase({source:'users'});
  assert.equal(await getAuthenticatedPairAccess(currentDb,{userId:2,weekId:10,pairGroupId:20}),null);
  await currentDb.execute(`UPDATE pairing_participants SET source='auth' WHERE week_id=10 AND user_id=2`);
  const access=await getAuthenticatedPairAccess(currentDb,{userId:2,weekId:10,pairGroupId:20});
  assert.equal(Number(access.pair_group_id),20);
  await currentDb.execute(`UPDATE circle_memberships SET status='inactive' WHERE user_id=2`);
  assert.equal(await getAuthenticatedPairAccess(currentDb,{userId:2,weekId:10,pairGroupId:20}),null,
    'an immutable participant snapshot cannot outlive active circle membership');
});

test('all data room entry points reject a colliding legacy participant without work or leakage',async()=>{
  currentDb=await seededDatabase({source:'users'});
  const question=listPublicExercises()[0];
  const entrypoint=question.languages.javascript.entrypoint;
  const requests=[
    {url:'/api/schedule?room_id=week_10_pair_20',query:{endpoint:'schedule',room_id:'week_10_pair_20'}},
    {url:'/api/messages?room_id=week_10_pair_20',query:{endpoint:'messages',room_id:'week_10_pair_20'}},
    {url:'/api/runs?room_id=week_10_pair_20&after_id=0&limit=20',query:{endpoint:'runs',room_id:'week_10_pair_20',after_id:'0',limit:'20'}},
    {method:'POST',url:'/api/execute',query:{endpoint:'execute'},body:{
      room_id:'week_10_pair_20',language:'javascript',question_slug:question.slug,
      question_version:question.version,code:`function ${entrypoint}(){ return null; }`,
    }},
  ];
  globalThis.fetch=async()=>{ providerCalls+=1; throw new Error('denied execution reached provider'); };
  for(const request of requests){
    const response=await invoke(request);
    assert.equal(response.status,404,request.url);
    assert.deepEqual(response.body,{error:'pair not found'});
  }
  assert.equal(providerCalls,0);

  const pair=await invoke({url:'/api/my-pair',query:{endpoint:'my-pair'}});
  assert.equal(pair.status,503);
  assert.deepEqual(pair.body,{error:'pairing unavailable'});
  const stats=await invoke({url:'/api/stats',query:{endpoint:'stats'}});
  assert.equal(stats.body.your_sessions,0);
  assert.equal(stats.body.your_weeks,0);
  assert.equal('your_last' in stats.body,false);
});

test('guarded schedule, run feed, and execute persistence close membership-change races',async()=>{
  const database=await seededDatabase();
  await database.execute(`CREATE TABLE pair_schedules (
    id INTEGER PRIMARY KEY AUTOINCREMENT,week_id INTEGER,pair_group_id INTEGER,
    proposed_times TEXT,agreed_time TEXT,created_at TEXT,updated_at TEXT,
    UNIQUE(week_id,pair_group_id)
  )`);

  let revokeWhen='schedule';
  let revoked=false;
  currentDb=tracedClient(database,async sql=>{
    const shouldRevoke=(revokeWhen==='schedule'&&sql.includes('FROM pair_schedules')&&sql.includes('WITH pair_access'))
      ||(revokeWhen==='runs'&&sql.includes('FROM session_runs sr')&&sql.includes('WITH pair_access'))
      ||(revokeWhen==='execute'&&sql.includes('INSERT INTO session_runs')&&sql.includes('WITH pair_access'));
    if(shouldRevoke&&!revoked){
      revoked=true;
      await database.execute(`DELETE FROM pairing_participants WHERE week_id=10 AND user_id=2`);
    }
  });

  const schedule=await invoke({url:'/api/schedule?room_id=week_10_pair_20',query:{endpoint:'schedule',room_id:'week_10_pair_20'}});
  assert.equal(schedule.status,404);

  await database.execute(`INSERT INTO pairing_participants (week_id,user_id,position,source) VALUES (10,2,0,'auth')`);
  revokeWhen='runs'; revoked=false;
  const runs=await invoke({
    url:'/api/runs?room_id=week_10_pair_20&after_id=0&limit=20',
    query:{endpoint:'runs',room_id:'week_10_pair_20',after_id:'0',limit:'20'},
  });
  assert.equal(runs.status,404);

  await database.execute(`INSERT INTO pairing_participants (week_id,user_id,position,source) VALUES (10,2,0,'auth')`);
  revokeWhen='execute'; revoked=false;
  globalThis.fetch=async()=>{
    providerCalls+=1;
    return new Response(JSON.stringify({run:{code:0,stdout:'',stderr:''}}),{status:200});
  };
  const question=listPublicExercises()[0];
  const entrypoint=question.languages.javascript.entrypoint;
  const execution=await invoke({
    method:'POST',url:'/api/execute',query:{endpoint:'execute'},body:{
      room_id:'week_10_pair_20',language:'javascript',question_slug:question.slug,
      question_version:question.version,code:`function ${entrypoint}(){ return null; }`,
    },
  });
  assert.equal(execution.status,404);
  assert.equal(providerCalls,1,'membership was valid at preflight, so execution may finish before persistence is denied');
  const stored=await database.execute(`SELECT COUNT(*) AS count FROM session_runs`);
  assert.equal(Number(stored.rows[0].count),0);
});
