import assert from 'node:assert/strict';
import { createHash, createHmac } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, mock, test } from 'node:test';
import { createClient } from '@libsql/client';

import { copyMigratedDatabase } from '../support/migrated-db.mjs';

// Issue #296: GET /api/exercise-suggestions through the production data
// handler against a migrated database. Covers the flag, input validation,
// solo vs pair, cross-pair and cross-circle denial, and the privacy shape.

const SECRET='exercise-suggestions-test-secret-at-least-32-chars';
const USERS=Object.freeze({
  member:{id:2,email:'member@example.test'},
  partner:{id:4,email:'partner@example.test'},
  outsider:{id:6,email:'outsider@example.test'},
  otherCircle:{id:8,email:'other@example.test'},
  former:{id:10,email:'former@example.test'},
  colleague:{id:12,email:'colleague@example.test'},
  malformed:{id:'not-a-number',email:'malformed@example.test'},
});
let currentDb=null;
let currentDirectory=null;

function authPayload(req){
  return USERS[req?.headers?.['x-test-auth']]||null;
}

mock.module('../../api/_db.js',{exports:{
  captureSentryException:()=>null,captureSentryMessage:()=>null,getAdminEmails:()=>new Set(),
  getClient:()=>{ if(currentDb instanceof Error) throw currentDb; return currentDb; },
  getJwtSecret:()=>SECRET,initSentry:()=>{},isSentryConfigured:()=>false,
  verifyMutationOrigin:()=>true,verifyRequestAuth:authPayload,verifySignedRequestAuth:authPayload,
}});

const {default:dataHandler}=await import('../../api/data.js');

function invoke({method='GET',user='member',query={},url=null}={}){
  const search=new URLSearchParams(query).toString();
  return new Promise((resolve,reject)=>{
    let statusCode=200,settled=false;
    const headers={};
    const finish=body=>{ if(!settled){ settled=true; resolve({status:statusCode,headers,body}); } };
    const res={
      status(code){ statusCode=code; return this; },
      setHeader(name,value){ headers[String(name).toLowerCase()]=value; },
      json(body){ finish(body); return this; },end(body){ finish(body); return this; },
    };
    const req={
      method,url:url||`/api/exercise-suggestions${search?`?${search}`:''}`,
      query:url?{}:{endpoint:'exercise-suggestions'},headers:user?{'x-test-auth':user}:{},body:{},
      socket:{remoteAddress:'127.0.0.1'},
    };
    Promise.resolve(dataHandler(req,res)).then(()=>finish(undefined)).catch(reject);
  });
}

function keyId(){
  return createHash('sha256').update(`randori-run-key\0${SECRET}`,'utf8').digest('hex').slice(0,16);
}

function sign(version,payload){
  return createHmac('sha256',SECRET).update(`randori-run-attestation-v${version}\0${payload}`,'utf8').digest('hex');
}

function soloRun({userId,slug,createdAt,forged=false}){
  const results='[{"idx":0,"pass":true,"error":null}]';
  const digest=createHash('sha256').update(results,'utf8').digest('hex');
  const attestation=forged?'f'.repeat(64):sign(2,JSON.stringify([2,userId,slug,1,'javascript',1,1,digest]));
  return {
    sql:`INSERT INTO session_runs (user_id,week_id,pair_group_id,question_id,question_slug,language,code,
      test_cases_snapshot,results_json,passed_count,total_count,duration_ms,created_at)
      VALUES (?,NULL,NULL,NULL,?,'javascript','function solve(){}',?,?,1,1,5,?)`,
    args:[userId,slug,JSON.stringify({
      source:'original-catalog',version:1,total_count:1,attestation_version:2,attestation_key_id:keyId(),attestation,
    }),results,createdAt],
  };
}

function pairRun({userId,weekId,pairGroupId,slug,createdAt}){
  const code='function solve(){ return 42; }';
  const results='[{"idx":0,"pass":false,"error":null}]';
  const codeHash=createHash('sha256').update(code,'utf8').digest('hex');
  const stateHash='d'.repeat(64);
  const documentVersion='e'.repeat(64);
  const digest=createHash('sha256').update(results,'utf8').digest('hex');
  const attestation=sign(3,JSON.stringify([
    3,userId,weekId,pairGroupId,slug,1,'javascript',codeHash,5,stateHash,documentVersion,0,1,digest,
  ]));
  return {
    sql:`INSERT INTO session_runs (user_id,week_id,pair_group_id,question_id,question_slug,language,code,
      test_cases_snapshot,results_json,passed_count,total_count,duration_ms,created_at)
      VALUES (?,?,?,NULL,?,'javascript',?,?,?,0,1,5,?)`,
    args:[userId,weekId,pairGroupId,slug,code,JSON.stringify({
      source:'original-catalog',version:1,total_count:1,attestation_version:3,attestation_key_id:keyId(),attestation,
      week_id:weekId,pair_group_id:pairGroupId,code_hash:codeHash,document_revision:5,
      document_state_hash:stateHash,document_version:documentVersion,
    }),results,createdAt],
  };
}

function codeDocument({slug,revision}){
  return `INSERT INTO pair_code_documents (week_id,pair_group_id,question_slug,question_version,language,
    y_state_base64,state_hash,code_hash,revision,pair_user_a_id,pair_user_a_source,pair_user_b_id,
    pair_user_b_source,pair_user_c_id,last_actor_id,last_actor_source,last_client_id,last_client_seq,
    created_at,updated_at)
    VALUES (10,20,'${slug}',1,'javascript','AAAA','${'a'.repeat(64)}','${'b'.repeat(64)}',${revision},
      2,'auth',4,'auth',NULL,2,'auth','client-test',1,'2026-09-18T09:00:00.000Z','2026-09-18T09:30:00.000Z')`;
}

async function seededDatabase(){
  currentDirectory=mkdtempSync(join(tmpdir(),'randori-exercise-suggestions-'));
  const path=join(currentDirectory,'test.sqlite');
  await copyMigratedDatabase(path);
  const db=createClient({url:`file:${path}`});
  await db.batch([
    `INSERT INTO auth_accounts (id,email,password_hash,display_name,color) VALUES
      (2,'member@example.test','x','Member Name','#111111'),
      (4,'partner@example.test','x','Partner Name','#222222'),
      (6,'outsider@example.test','x','Outsider Name','#333333'),
      (8,'other@example.test','x','Other Circle Name','#444444'),
      (10,'former@example.test','x','Former Name','#555555'),
      (12,'colleague@example.test','x','Colleague Name','#666666')`,
    `INSERT INTO circles (id,public_id,slug,name,is_primary) VALUES
      (1,'pub-primary','primary','Primary',1),(2,'pub-other','other','Other',0)`,
    `INSERT INTO circle_memberships (circle_id,user_id,role,status) VALUES
      (1,2,'owner','active'),(1,4,'member','active'),(1,6,'member','active'),
      (1,10,'member','inactive'),(1,12,'member','active'),(2,8,'owner','active'),(2,2,'member','active')`,
    `INSERT INTO pairing_weeks (id,week_label,week_start) VALUES
      (10,'2026-W38','2026-09-14T07:00:00.000Z'),(11,'2026-W39','2026-09-21T07:00:00.000Z')`,
    `INSERT INTO pairing_groups (id,week_id,user_a_id,user_b_id,user_c_id,is_ai_pair) VALUES
      (20,10,2,4,NULL,0),(30,11,2,4,NULL,0),(31,11,6,8,NULL,0),(32,11,10,12,NULL,0)`,
    `INSERT INTO pairing_participants (week_id,user_id,position,source) VALUES
      (10,2,0,'auth'),(10,4,1,'auth'),
      (11,2,0,'auth'),(11,4,1,'auth'),(11,6,2,'auth'),(11,8,3,'auth'),(11,10,4,'auth'),(11,12,5,'auth')`,
    // Member: one verified solo run and one run whose attestation was forged.
    soloRun({userId:2,slug:'focus-block-rollup',createdAt:'2026-09-15 10:00:00'}),
    soloRun({userId:2,slug:'capacity-upgrade-index',createdAt:'2026-09-16 10:00:00',forged:true}),
    // Partner: one verified pair run in the current room (v3 attestation).
    pairRun({userId:4,weekId:11,pairGroupId:30,slug:'balanced-template-markers',createdAt:'2026-09-22 10:00:00'}),
    // Other members' history must never reach the member or the wrong pair.
    soloRun({userId:6,slug:'threshold-pair-count',createdAt:'2026-09-17 10:00:00'}),
    soloRun({userId:8,slug:'mentor-level-widths',createdAt:'2026-09-17 10:00:00'}),
    soloRun({userId:10,slug:'coverage-gap-finder',createdAt:'2026-09-17 10:00:00'}),
    soloRun({userId:12,slug:'release-feed-merge',createdAt:'2026-09-17 10:00:00'}),
    // Last week's session with the partner was completed by both.
    `INSERT INTO pair_room_snapshots (room_id,week_id,pair_group_id,revision,schema_version,client_id,client_seq,
      language,question_id,code,updated_by) VALUES
      ('week_10_pair_20',10,20,4,3,'client-test',4,'javascript','shortest-handoff-path@1','{}',2),
      ('week_11_pair_30',11,30,2,3,'client-test',2,'javascript','review-wave-planner@1','{}',2)`,
    codeDocument({slug:'command-prefix-census',revision:3}),
    codeDocument({slug:'message-frequency-leaders',revision:1}),
    `INSERT INTO session_completion_receipts VALUES (10,20,2,'auth',2,4,NULL,'2026-09-18T10:00:00.000Z')`,
    `INSERT INTO session_completion_receipts VALUES (10,20,4,'auth',2,4,NULL,'2026-09-18T10:05:00.000Z')`,
    // This week's session is confirmed by one partner only: not completed.
    `INSERT INTO session_completion_receipts VALUES (11,30,2,'auth',2,4,NULL,'2026-09-23T10:00:00.000Z')`,
  ],'write');
  return db;
}

function tracing(delegate,statements,batches=[]){
  return {
    async execute(statement){
      statements.push(typeof statement==='string'?statement:statement.sql);
      return delegate.execute(statement);
    },
    async batch(list,mode){
      batches.push({mode,count:list.length});
      for(const statement of list) statements.push(statement.sql);
      return delegate.batch(list,mode);
    },
    close(){ return delegate.close(); },
  };
}

beforeEach(async()=>{
  process.env.EXERCISE_SUGGESTIONS_ENABLED='true';
  process.env.CIRCLE_MEMBERSHIP_ENABLED='true';
  delete process.env.TURSO_DATABASE_URL;
  delete process.env.RUN_ATTESTATION_SECRET;
  delete process.env.RUN_ATTESTATION_PREVIOUS_SECRETS;
  delete process.env.MULTI_CIRCLE_CONTROL_PLANE_ENABLED;
  currentDb=await seededDatabase();
});

afterEach(()=>{
  try{ currentDb?.close?.(); }catch{}
  currentDb=null;
  if(currentDirectory) rmSync(currentDirectory,{recursive:true,force:true});
  currentDirectory=null;
  delete process.env.EXERCISE_SUGGESTIONS_ENABLED;
  delete process.env.CIRCLE_MEMBERSHIP_ENABLED;
});

test('with the flag off the endpoint does not exist and the catalogue response is unchanged',async()=>{
  delete process.env.EXERCISE_SUGGESTIONS_ENABLED;
  const disabled=await invoke();
  assert.equal(disabled.status,404);
  assert.deepEqual(disabled.body,{error:'exercise suggestions are not available',code:'feature_disabled'});
  assert.equal((await invoke({user:null})).status,404);
  const questions=await invoke({url:'/api/questions'});
  assert.equal(questions.status,200);
  assert.deepEqual(Object.keys(questions.body).sort(),['count','ok','questions']);
  const unknown=await invoke({url:'/api/data?endpoint=nope'});
  assert.ok(!unknown.body.available.includes('exercise-suggestions'));

  process.env.EXERCISE_SUGGESTIONS_ENABLED='true';
  const enabled=await invoke({url:'/api/questions'});
  assert.deepEqual(enabled.body.features,{exercise_suggestions:true});
  assert.equal(enabled.body.count,enabled.body.questions.length);
  assert.ok((await invoke({url:'/api/data?endpoint=nope'})).body.available.includes('exercise-suggestions'));
});

test('only signed-in GET requests with a valid query reach the database',async()=>{
  currentDb=new Error('database must not be opened');
  assert.equal((await invoke({user:null})).status,401);
  assert.equal((await invoke({user:'malformed'})).status,401);
  const post=await invoke({method:'POST'});
  assert.equal(post.status,405);
  assert.equal(post.headers.allow,'GET');
  for(const query of [
    {week_id:'11'},{room_id:'week_011_pair_30'},{hidden:'Not A Slug'},
    {hidden:Array.from({length:51},(_,index)=>`e-${index}`).join(',')},
  ]){
    const rejected=await invoke({query});
    assert.equal(rejected.status,400,JSON.stringify(query));
    assert.equal(typeof rejected.body.error,'string');
  }
  assert.equal((await invoke({url:'/api/exercise-suggestions?room_id=week_11_pair_30&room_id=week_11_pair_31'})).status,400);
  assert.equal((await invoke()).status,503);
  assert.equal((await invoke({user:'member'})).headers['cache-control'],'private, no-store');
});

test('solo suggestions use only the member\'s own verified runs and completed sessions',async()=>{
  const statements=[];
  const batches=[];
  const db=currentDb;
  currentDb=tracing(db,statements,batches);
  const response=await invoke();
  assert.equal(response.status,200,JSON.stringify(response.body));
  assert.equal(response.body.mode,'solo');
  assert.equal(response.body.room_id,null);
  assert.equal(response.body.partner_count,0);
  // focus-block-rollup: verified run. shortest-handoff-path and
  // command-prefix-census: last week's completed session (workspace exercise
  // and an edited code document). Not counted: the forged run, the unedited
  // code document, this week's half-confirmed session and everyone else's runs.
  assert.deepEqual(response.body.attempted,[
    {slug:'command-prefix-census',by_me:true,by_partner:false},
    {slug:'focus-block-rollup',by_me:true,by_partner:false},
    {slug:'shortest-handoff-path',by_me:true,by_partner:false},
  ]);
  assert.deepEqual(response.body.suggestions.map(item=>item.slug),[
    'coaching-route-sums','command-message-segmentation','resilient-network-budget',
  ]);
  assert.equal(response.body.suggestions[0].reason.text,
    'You haven’t practised trees yet. One step up from your recent Medium exercises.');
  assert.equal(response.body.empty_reason,null);
  // Read-only: no statement writes or changes schema.
  assert.ok(statements.length>0);
  assert.ok(statements.every(sql=>/^\s*(SELECT|WITH)\b/i.test(sql)),statements.join('\n---\n'));
  assert.ok(!statements.some(sql=>/\b(INSERT|UPDATE|DELETE|CREATE|ALTER|DROP)\b/i.test(sql)));
  // History is one read batch (runs + completed sessions for the member).
  assert.deepEqual(batches,[{mode:'read',count:2}]);
  currentDb=db;
});

test('a pair room adds only "attempted by your partner" and never the partner\'s details',async()=>{
  const response=await invoke({query:{room_id:'week_11_pair_30'}});
  assert.equal(response.status,200,JSON.stringify(response.body));
  assert.equal(response.body.mode,'pair');
  assert.equal(response.body.room_id,'week_11_pair_30');
  assert.equal(response.body.partner_count,1);
  assert.deepEqual(response.body.attempted,[
    {slug:'balanced-template-markers',by_me:false,by_partner:true},
    {slug:'command-prefix-census',by_me:true,by_partner:true},
    {slug:'focus-block-rollup',by_me:true,by_partner:false},
    {slug:'shortest-handoff-path',by_me:true,by_partner:true},
  ]);
  const suggested=response.body.suggestions.map(item=>item.slug);
  assert.deepEqual(suggested,['coaching-route-sums','command-message-segmentation','resilient-network-budget']);
  assert.ok(suggested.every(slug=>!response.body.attempted.some(marker=>marker.slug===slug)));
  assert.equal(response.body.suggestions[0].reason.text,
    'Neither of you has practised trees yet. One step up from your recent Medium exercises.');

  // Privacy shape: booleans only, no scores, code, dates, ids, names or emails.
  assert.deepEqual(Object.keys(response.body).sort(),
    ['attempted','empty_reason','hidden_count','mode','ok','partner_count','room_id','suggestions']);
  for(const marker of response.body.attempted) assert.deepEqual(Object.keys(marker).sort(),['by_me','by_partner','slug']);
  for(const suggestion of response.body.suggestions){
    assert.deepEqual(Object.keys(suggestion).sort(),['difficulty','reason','slug','title','topic','version']);
    assert.deepEqual(Object.keys(suggestion.reason).sort(),['code','difficulty_step','text']);
  }
  const serialized=JSON.stringify(response.body);
  assert.doesNotMatch(serialized,/2026-|passed|total_count|function solve|Partner Name|partner@|"user|_id":\d/);

  // The partner sees the mirror image from the same room.
  const mirror=await invoke({user:'partner',query:{room_id:'week_11_pair_30'}});
  assert.equal(mirror.status,200);
  assert.deepEqual(mirror.body.attempted.find(marker=>marker.slug==='focus-block-rollup'),
    {slug:'focus-block-rollup',by_me:false,by_partner:true});
});

test('hidden exercises are left out of suggestions but keep their markers',async()=>{
  const response=await invoke({query:{room_id:'week_11_pair_30',hidden:'coaching-route-sums,focus-block-rollup'}});
  assert.equal(response.status,200);
  const suggested=response.body.suggestions.map(item=>item.slug);
  assert.equal(suggested.length,3);
  assert.ok(!suggested.includes('coaching-route-sums'));
  assert.equal(suggested[0],'command-message-segmentation');
  assert.ok(response.body.attempted.some(marker=>marker.slug==='focus-block-rollup'));
  // Only the hidden exercise that could be suggested is counted.
  assert.equal(response.body.hidden_count,1);
  const repeated=await invoke({query:{hidden:'coaching-route-sums,coaching-route-sums'}});
  assert.equal(repeated.status,400);
  assert.deepEqual(repeated.body,{error:'hidden must not repeat an exercise'});
});

test('the partner\'s attempt times cannot change the response',async()=>{
  // The member's own recent work tops out at Medium. A partner's Hard run is
  // moved from before to after it; the response must stay byte-identical.
  await currentDb.execute(soloRun({userId:4,slug:'coaching-route-sums',createdAt:'2026-09-01 10:00:00'}));
  const before=await invoke({query:{room_id:'week_11_pair_30'}});
  await currentDb.execute(`UPDATE session_runs SET created_at='2026-09-30 10:00:00'
    WHERE user_id=4 AND question_slug='coaching-route-sums'`);
  const after=await invoke({query:{room_id:'week_11_pair_30'}});
  assert.equal(before.status,200);
  assert.equal(JSON.stringify(after.body),JSON.stringify(before.body));
  assert.ok(before.body.suggestions.every(item=>/recent Medium exercises\.$/.test(item.reason.text)));
  assert.ok(!before.body.suggestions.some(item=>item.slug==='coaching-route-sums'));
});

test('another member\'s newer runs on the same exercise never crowd out the member\'s own',async()=>{
  // The per-exercise lookup is limited to the member's rows in SQL. Without
  // that filter these three newer runs would fill the three-run window and the
  // member's older verified run would be missed.
  for(const day of [20,21,22]){
    await currentDb.execute(soloRun({userId:6,slug:'focus-block-rollup',createdAt:`2026-09-${day} 10:00:00`}));
  }
  const response=await invoke();
  assert.equal(response.status,200);
  assert.ok(response.body.attempted.some(marker=>marker.slug==='focus-block-rollup'&&marker.by_me));
});

test('a demo pairing week does not make the real current pair stale',async()=>{
  await currentDb.execute(`INSERT INTO pairing_weeks (id,week_label,week_start,is_demo)
    VALUES (12,'2026-W40-demo','2026-09-28T07:00:00.000Z',1)`);
  const response=await invoke({query:{room_id:'week_11_pair_30'}});
  assert.equal(response.status,200);
  assert.equal(response.body.mode,'pair');
  // A newer real week still retires the old pair.
  await currentDb.execute(`INSERT INTO pairing_weeks (id,week_label,week_start,is_demo)
    VALUES (13,'2026-W41','2026-10-05T07:00:00.000Z',0)`);
  assert.equal((await invoke({query:{room_id:'week_11_pair_30'}})).status,404);
});

test('cross-pair, stale-pair and cross-circle requests are refused with the same 404',async()=>{
  const denied=[
    // A member of the same circle asking for someone else's pair.
    ['outsider','week_11_pair_30'],
    // The member's previous pair is no longer the current pair.
    ['member','week_10_pair_20'],
    // Listed in this week's pairing data but only a member of another circle.
    ['otherCircle','week_11_pair_31'],
    ['otherCircle','week_11_pair_30'],
    // Removed from the circle: the old pair no longer authorizes anything.
    ['former','week_11_pair_32'],
    // A pair that does not exist.
    ['member','week_11_pair_99'],
  ];
  for(const [user,room] of denied){
    const response=await invoke({user,query:{room_id:room}});
    assert.equal(response.status,404,`${user} ${room}`);
    assert.deepEqual(response.body,{error:'pair not found'});
  }
});

test('a partner who is not an active member of the circle is never used',async()=>{
  // Outsider's partner (user 8) belongs only to another circle.
  const outsider=await invoke({user:'outsider',query:{room_id:'week_11_pair_31'}});
  assert.equal(outsider.status,200);
  assert.equal(outsider.body.mode,'solo');
  assert.equal(outsider.body.partner_count,0);
  assert.deepEqual(outsider.body.attempted,[{slug:'threshold-pair-count',by_me:true,by_partner:false}]);
  // Colleague's partner (user 10) was removed from the circle.
  const colleague=await invoke({user:'colleague',query:{room_id:'week_11_pair_32'}});
  assert.equal(colleague.status,200);
  assert.equal(colleague.body.partner_count,0);
  assert.deepEqual(colleague.body.attempted,[{slug:'release-feed-merge',by_me:true,by_partner:false}]);
  // Solo wording: nothing implies a partner's history was used.
  assert.ok(colleague.body.suggestions.every(item=>item.reason.text.startsWith('You ')));
});

test('before the membership rollout the pair is authorized by the pairing alone',async()=>{
  delete process.env.CIRCLE_MEMBERSHIP_ENABLED;
  // Without circle memberships, the shared pair check is the only authority,
  // so user 8's pairing with the outsider counts in both directions.
  const outsider=await invoke({user:'outsider',query:{room_id:'week_11_pair_31'}});
  assert.equal(outsider.status,200);
  assert.equal(outsider.body.mode,'pair');
  assert.deepEqual(outsider.body.attempted,[
    {slug:'mentor-level-widths',by_me:false,by_partner:true},
    {slug:'threshold-pair-count',by_me:true,by_partner:false},
  ]);
  // Cross-pair and stale-pair requests are still refused.
  assert.equal((await invoke({user:'outsider',query:{room_id:'week_11_pair_30'}})).status,404);
  assert.equal((await invoke({user:'member',query:{room_id:'week_10_pair_20'}})).status,404);
});

test('a schema that is not ready, or a failing read, answers 503 without details',async()=>{
  const empty=createClient({url:'file::memory:'});
  currentDb=empty;
  const notReady=await invoke();
  assert.equal(notReady.status,503);
  assert.deepEqual(notReady.body,{error:'exercise suggestions unavailable'});
  empty.close();

  const db=await seededDatabase();
  let reads=0;
  currentDb={
    async execute(statement){ reads+=1; return db.execute(statement); },
    async batch(){ reads+=1; throw new Error('disk I/O error at /secret/path'); },
  };
  const failed=await invoke();
  assert.equal(failed.status,503);
  assert.deepEqual(failed.body,{error:'exercise suggestions unavailable'});
  assert.ok(reads>0);
  db.close();
});
