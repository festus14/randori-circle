// Issue #293 /api/progress through the real data handler and a real migrated
// SQLite database: the flag, authentication, "only your own progress", and
// consistency with /api/history, /api/stats and /api/pair-recap for the same
// member. Only api/_db.js (client and session identity) is replaced.
import assert from 'node:assert/strict';
import { createHash, createHmac } from 'node:crypto';
import { rmSync } from 'node:fs';
import { after, afterEach, before, beforeEach, mock, test } from 'node:test';

import { createClient } from '@libsql/client';

import { availabilityCycleKey } from '../../api/_availability.js';
import { resolvePairingCycle } from '../../api/_pairing-cycle.js';
import { prepareMigrationConnection } from '../../db/migration-runner.js';
import { createMigratedDatabase } from '../support/migrated-db.mjs';

const SECRET='progress-api-test-secret-at-least-32-characters';
const OWNER=1;
const MIA=2;
const PAT=3;
const DEMO=4;
const IDENTITIES={owner:OWNER,mia:MIA,pat:PAT};

const {directory,url}=await createMigratedDatabase({prefix:'randori-progress-api-',filename:'progress.sqlite'});
const realDb=createClient({url});
let clientOverride=null;

function authFor(req){
  const id=IDENTITIES[req?.headers?.['x-test-auth']];
  return id?{id,email:`${req.headers['x-test-auth']}@example.test`}:null;
}

mock.module('../../api/_db.js',{
  exports:{
    captureSentryException:()=>null,captureSentryMessage:()=>null,getAdminEmails:()=>new Set(['owner@example.test']),
    getClient:()=>{ if(clientOverride instanceof Error) throw clientOverride; return clientOverride||realDb; },
    getJwtSecret:()=>SECRET,initSentry:()=>{},isSentryConfigured:()=>false,verifyMutationOrigin:()=>true,
    verifyRequestAuth:authFor,verifySignedRequestAuth:authFor,
  },
});

const {default:dataHandler}=await import('../../api/data.js');

function invoke({method='GET',path='/api/progress',endpoint='progress',query={},as='mia'}={}){
  return new Promise((resolve,reject)=>{
    let statusCode=200;
    let settled=false;
    const headers={};
    const finish=body=>{ if(!settled){ settled=true; resolve({status:statusCode,headers,body}); } };
    const res={
      status(code){ statusCode=code; return this; },
      setHeader(name,value){ headers[String(name).toLowerCase()]=value; },
      json(body){ finish(body); return this; },
      end(body){ finish(body); return this; },
    };
    const search=new URLSearchParams(query).toString();
    const req={method,url:`${path}${search?`?${search}`:''}`,query:{endpoint,...query},
      headers:as?{'x-test-auth':as}:{},socket:{remoteAddress:'127.0.0.1'}};
    Promise.resolve(dataHandler(req,res)).then(()=>finish(undefined)).catch(reject);
  });
}

const ENV_KEYS=['PROGRESS_DASHBOARD_ENABLED','PAIRING_TIME_ZONE','RUN_ATTESTATION_SECRET','RUN_ATTESTATION_PREVIOUS_SECRETS',
  'CIRCLE_MEMBERSHIP_ENABLED','MULTI_CIRCLE_CONTROL_PLANE_ENABLED'];
const previous=Object.fromEntries(ENV_KEYS.map(key=>[key,process.env[key]]));
const cycles=[];
const rooms={};

function sqliteNow(offsetMs=0){
  return new Date(Date.now()+offsetMs).toISOString().replace('T',' ').slice(0,19);
}

function attestedSnapshot({userId,slug,passed,total,results='[]'}){
  const digest=createHash('sha256').update(results,'utf8').digest('hex');
  const payload=JSON.stringify([2,userId,slug,1,'javascript',passed,total,digest]);
  return JSON.stringify({
    source:'original-catalog',version:1,total_count:total,attestation_version:2,
    attestation_key_id:createHash('sha256').update(`randori-run-key\0${SECRET}`,'utf8').digest('hex').slice(0,16),
    attestation:createHmac('sha256',SECRET).update(`randori-run-attestation-v2\0${payload}`,'utf8').digest('hex'),
  });
}

async function seedWeek(db,{weekId,cycle,label=cycle.cycleId,demo=0,groups}){
  await db.execute({sql:`INSERT INTO pairing_weeks (id,week_label,week_start,focus,is_demo) VALUES (?,?,?,'both',?)`,
    args:[weekId,label,cycle.startsAt,demo]});
  const members=[...new Set(groups.flatMap(group=>group.members))];
  for(const [position,userId] of members.entries()){
    await db.execute({sql:`INSERT INTO pairing_participants (week_id,user_id,position,source) VALUES (?,?,?,'auth')`,
      args:[weekId,userId,position]});
  }
  for(const group of groups){
    const [a,b]=group.members;
    await db.execute({sql:`INSERT INTO pairing_groups (id,week_id,user_a_id,user_b_id,user_c_id,is_ai_pair) VALUES (?,?,?,?,NULL,?)`,
      args:[group.id,weekId,a,b??a,b?0:1]});
    if(group.candidate){
      const at=new Date(Date.parse(cycle.startsAt)+60_000).toISOString();
      await db.execute({sql:`INSERT INTO pair_session_controls (week_id,pair_group_id,pair_user_a_id,pair_user_a_source,
          pair_user_b_id,pair_user_b_source,pair_user_c_id,candidate_user_id,candidate_source,timer_state,remaining_ms,
          anchor_at,revision,updated_by,updated_by_source,created_at,updated_at)
        VALUES (?,?,?,'auth',?,'auth',NULL,?,'auth','paused',1500000,NULL,1,?,'auth',?,?)`,
      args:[weekId,group.id,a,b,group.candidate,a,at,at]});
    }
    for(const [index,userId] of (group.confirmed||[]).entries()){
      await db.execute({sql:`INSERT INTO session_completion_receipts (week_id,pair_group_id,user_id,participant_source,
          pair_user_a_id,pair_user_b_id,pair_user_c_id,confirmed_at) VALUES (?,?,?,'auth',?,?,NULL,?)`,
      args:[weekId,group.id,userId,a,b??a,new Date(Date.parse(cycle.startsAt)+(index+2)*3_600_000).toISOString()]});
    }
    rooms[group.name]=`week_${weekId}_pair_${group.id}`;
  }
}

before(async()=>{
  for(const key of ENV_KEYS) delete process.env[key];
  await prepareMigrationConnection(realDb);
  let cycle=resolvePairingCycle({state:'current'});
  for(let index=0;index<6;index+=1){
    cycles.push(cycle);
    cycle=resolvePairingCycle({now:new Date(Date.parse(cycle.startsAt)-1)});
  }
  await realDb.batch([
    `INSERT INTO auth_accounts (id,email,password_hash,display_name,color,is_demo,is_admin) VALUES
      (1,'owner@example.test','hash','Olive','#111',0,1),(2,'mia@example.test','hash','Mia','#222',0,0),
      (3,'pat@example.test','hash','Pat','#333',0,0),(4,'demo@example.test','hash','Dee','#444',1,0)`,
    `INSERT INTO circles (id,public_id,slug,name,is_primary,created_by) VALUES (1,'circle_public','randori','Randori',1,1)`,
    `INSERT INTO circle_memberships (circle_id,user_id,role,status) VALUES
      (1,1,'owner','active'),(1,2,'member','active'),(1,3,'member','active'),(1,4,'member','active')`,
  ],'write');
  // Oldest first. Mia: a confirmed solo week, a completed week with Pat, a week
  // she skipped (Olive and Pat paired), a completed week with Olive where she
  // was the candidate, and this week with Pat where only she has confirmed.
  // A demo week with a demo account is completed too.
  await seedWeek(realDb,{weekId:10,cycle:cycles[4],groups:[
    {id:100,name:'solo',members:[MIA],confirmed:[MIA]},
    {id:101,name:'w4-other',members:[OWNER,PAT],confirmed:[OWNER,PAT]},
  ]});
  await seedWeek(realDb,{weekId:11,cycle:cycles[3],groups:[{id:110,name:'withPat',members:[MIA,PAT],confirmed:[MIA,PAT]}]});
  await seedWeek(realDb,{weekId:12,cycle:cycles[2],groups:[{id:120,name:'skipped-week',members:[OWNER,PAT]}]});
  await seedWeek(realDb,{weekId:13,cycle:cycles[1],groups:[
    {id:130,name:'withOlive',members:[MIA,OWNER],candidate:MIA,confirmed:[MIA,OWNER]},
  ]});
  await seedWeek(realDb,{weekId:14,cycle:cycles[0],groups:[{id:140,name:'current',members:[MIA,PAT],confirmed:[MIA]}]});
  await seedWeek(realDb,{weekId:15,cycle:cycles[1],label:'demo-week',demo:1,groups:[
    {id:150,name:'demo',members:[MIA,DEMO],confirmed:[MIA,DEMO]},
  ]});
  const key=availabilityCycleKey({kind:'circle',circleId:1},cycles[2]);
  await realDb.batch([
    {sql:`INSERT INTO pairing_cycles (scope_key,circle_id,cycle_key,cycle_id,starts_at,ends_at,cutoff_at,time_zone,default_source)
      VALUES ('circle:1',1,?,?,?,?,?,?,'cycle_default')`,
    args:[key,cycles[2].cycleId,cycles[2].startsAt,cycles[2].endsAt,cycles[2].cutoffAt,cycles[2].timeZone]},
    {sql:`INSERT INTO pairing_cycle_availability (scope_key,cycle_key,user_id,is_available,version,decision_source)
      VALUES ('circle:1',?,2,0,1,'user'),('circle:1',?,3,1,1,'user')`,args:[key,key]},
  ],'write');
  const runInsert=`INSERT INTO session_runs (user_id,week_id,pair_group_id,question_slug,language,code,test_cases_snapshot,
      results_json,passed_count,total_count,duration_ms,created_at) VALUES (?,?,?,?,'javascript','// code',?,'[]',?,?,10,?)`;
  await realDb.batch([
    {sql:runInsert,args:[MIA,14,140,'focus-block-rollup',attestedSnapshot({userId:MIA,slug:'focus-block-rollup',passed:8,total:8}),8,8,sqliteNow(-60_000)]},
    {sql:runInsert,args:[MIA,null,null,'capacity-upgrade-index',attestedSnapshot({userId:MIA,slug:'capacity-upgrade-index',passed:3,total:8}),3,8,sqliteNow(-30_000)]},
    // Forged: the stored counts no longer match what was signed.
    {sql:runInsert,args:[MIA,null,null,'threshold-pair-count',attestedSnapshot({userId:MIA,slug:'threshold-pair-count',passed:1,total:8}),8,8,sqliteNow(-20_000)]},
    // Legacy, unattested.
    {sql:runInsert,args:[MIA,null,null,'shortest-handoff-path','[]',8,8,sqliteNow(-10_000)]},
    // Pat's run in the same room is not Mia's record.
    {sql:runInsert,args:[PAT,14,140,'shortest-handoff-path',attestedSnapshot({userId:PAT,slug:'shortest-handoff-path',passed:8,total:8}),8,8,sqliteNow(-5_000)]},
  ],'write');
});

after(()=>{
  try{ realDb.close(); }catch{}
  rmSync(directory,{recursive:true,force:true});
  for(const [key,value] of Object.entries(previous)){
    if(value===undefined) delete process.env[key]; else process.env[key]=value;
  }
});

beforeEach(()=>{
  clientOverride=null;
  process.env.PROGRESS_DASHBOARD_ENABLED='true';
});

afterEach(()=>{
  delete process.env.CIRCLE_MEMBERSHIP_ENABLED;
  delete process.env.MULTI_CIRCLE_CONTROL_PLANE_ENABLED;
});

test('with the flag off the route is unknown and History is unchanged',async()=>{
  delete process.env.PROGRESS_DASHBOARD_ENABLED;
  const progress=await invoke();
  assert.equal(progress.status,404);
  assert.equal(progress.body.error,"unknown data endpoint 'progress'");
  const viaData=await invoke({path:'/api/data'});
  assert.equal(viaData.status,404);
  const history=await invoke({path:'/api/history',endpoint:'history'});
  assert.equal(history.status,200);
  assert.equal(Object.hasOwn(history.body,'progress'),false);
  process.env.PROGRESS_DASHBOARD_ENABLED='true';
  const enabled=await invoke({path:'/api/history',endpoint:'history'});
  assert.deepEqual(enabled.body.progress,{enabled:true});
  assert.deepEqual({...enabled.body,progress:undefined},{...history.body,progress:undefined});
});

test('a member reads only their own progress; any other member is a 404',async()=>{
  const anonymous=await invoke({as:null});
  assert.equal(anonymous.status,401);
  const own=await invoke();
  assert.equal(own.status,200);
  assert.equal(own.headers['cache-control'],'private, no-store');
  assert.equal(own.body.user.id,MIA);
  const explicit=await invoke({query:{user_id:String(MIA)}});
  assert.equal(explicit.status,200);
  assert.deepEqual({...explicit.body,generated_at:null},{...own.body,generated_at:null});
  const denials=[
    ['mia',OWNER],['mia',PAT],['mia',DEMO],['mia',999],
    // Neither the circle owner nor an app admin can read a member's progress.
    ['owner',MIA],['pat',MIA],
  ];
  for(const [as,userId] of denials){
    const denied=await invoke({as,query:{user_id:String(userId)}});
    assert.equal(denied.status,404,`${as} -> ${userId}`);
    assert.deepEqual(denied.body,{error:'progress not found'});
    assert.equal(JSON.stringify(denied.body).includes('Mia'),false);
  }
  for(const query of [{user_id:'abc'},{member_id:String(PAT)},{user:'3'}]){
    const rejected=await invoke({query});
    assert.equal(rejected.status,400,JSON.stringify(query));
  }
  const post=await invoke({method:'POST'});
  assert.equal(post.status,405);
  assert.equal(post.headers.allow,'GET');
});

test('progress agrees with History, stats and recap for the same member',async()=>{
  const [progress,history,stats]=await Promise.all([
    invoke(),invoke({path:'/api/history',endpoint:'history'}),invoke({path:'/api/stats',endpoint:'stats'}),
  ]);
  assert.equal(progress.status,200);
  assert.equal(history.status,200);
  assert.equal(stats.status,200);
  const body=progress.body;
  // History lists every pairing, including the demo week; progress and stats
  // count only real (non-demo) pairings.
  const realRows=history.body.history.filter(row=>row.week_id!==15);
  assert.equal(history.body.history.length,realRows.length+1);
  const completedRows=realRows.filter(row=>row.completion.state==='completed');
  assert.equal(body.sessions.completed,completedRows.length);
  assert.equal(body.sessions.completed,stats.body.your_sessions);
  assert.equal(body.sessions.completed,3);
  assert.equal(body.sessions.solo_completed,realRows.filter(row=>row.is_ai&&row.completion.state==='completed').length);
  assert.equal(body.sessions.pairings,realRows.length);

  // Each week's status agrees with that room's recap completion.
  const byCycle=Object.fromEntries(body.weeks.map(week=>[week.cycle_id,week]));
  for(const [name,cycle,status] of [
    ['withOlive',cycles[1],'completed'],['withPat',cycles[3],'completed'],['current',cycles[0],'in_progress'],
  ]){
    const recap=await invoke({path:'/api/pair-recap',endpoint:'pair-recap',query:{room_id:rooms[name]}});
    assert.equal(recap.status,200,name);
    const row=history.body.history.find(item=>`week_${item.week_id}_pair_${item.pg_id}`===rooms[name]);
    assert.equal(recap.body.recap.completion.state,row.completion.state,name);
    assert.equal(byCycle[cycle.cycleId].status,status,name);
    if(status==='in_progress') assert.equal(byCycle[cycle.cycleId].completion,recap.body.recap.completion.state);
  }
  assert.equal(byCycle[cycles[2].cycleId].status,'not_available');
  assert.equal(byCycle[cycles[4].cycleId].status,'solo');
  assert.deepEqual(body.streak,{rules_version:1,current_weeks:2,longest_weeks:2,this_week:'in_progress'});
  assert.equal(body.weeks.at(-1).cycle_id,cycles[0].cycleId);

  // Only Mia's two attested runs count; both fall in the current cycle.
  assert.deepEqual(body.runs,{window_weeks:12,verified:2,passed:1,scan_limited:false});
  assert.deepEqual([byCycle[cycles[0].cycleId].verified_runs,byCycle[cycles[0].cycleId].passed_runs],[2,1]);
  assert.deepEqual({...body.coverage.exercises,total:undefined},{total:undefined,attempted:2,solved:1});
  const patterns=Object.fromEntries(body.coverage.patterns.map(group=>[group.key,group]));
  assert.deepEqual(patterns['array-processing'],{key:'array-processing',exercises:1,attempted:1,solved:1});
  assert.deepEqual(patterns['binary-search'],{key:'binary-search',exercises:1,attempted:1,solved:0});
  assert.equal(patterns['graph-traversal'].attempted,0);
  assert.equal(patterns['two-pointers'].attempted,0);
  assert.deepEqual(body.roles,{available:true,sessions:1,candidate:1,interviewer:0});
  assert.deepEqual(body.feedback,{available:false});

  // The same data seen by Olive: one completed session as the interviewer.
  const olive=await invoke({as:'owner'});
  assert.equal(olive.body.sessions.completed,(await invoke({as:'owner',path:'/api/stats',endpoint:'stats'})).body.your_sessions);
  assert.deepEqual(olive.body.roles,{available:true,sessions:1,candidate:0,interviewer:1});
  assert.equal(olive.body.runs.verified,0);
  assert.equal(olive.body.coverage.exercises.attempted,0);
});

test('a member with no records gets zeros and every pattern untouched',async()=>{
  await realDb.execute(`INSERT INTO auth_accounts (id,email,password_hash,display_name,color,is_demo) VALUES
    (5,'new@example.test','hash','Nia','#555',0)`);
  IDENTITIES.nia=5;
  try{
    const fresh=await invoke({as:'nia'});
    assert.equal(fresh.status,200);
    assert.deepEqual(fresh.body.sessions,{completed:0,solo_completed:0,pairings:0,window_limited:false});
    assert.deepEqual([fresh.body.streak.current_weeks,fresh.body.streak.longest_weeks],[0,0]);
    assert.equal(fresh.body.weeks.length,12);
    assert.ok(fresh.body.weeks.every(week=>week.status==='no_pairing'));
    assert.ok(fresh.body.coverage.patterns.length>=10);
    assert.ok(fresh.body.coverage.patterns.every(group=>group.attempted===0));
    assert.deepEqual(fresh.body.roles,{available:false});
  }finally{ delete IDENTITIES.nia; }
});

test('database or schema failures return a generic 503',async()=>{
  clientOverride=new Error('no database');
  assert.deepEqual((await invoke()).body,{error:'progress unavailable'});
  clientOverride={execute:async()=>{ throw new Error('no such table: pair_session_controls'); }};
  const broken=await invoke();
  assert.equal(broken.status,503);
  assert.deepEqual(broken.body,{error:'progress unavailable'});
});

test('progress follows the single-circle gate like History',async()=>{
  process.env.CIRCLE_MEMBERSHIP_ENABLED='true';
  process.env.MULTI_CIRCLE_CONTROL_PLANE_ENABLED='true';
  const gated=await invoke();
  assert.equal(gated.status,409);
  assert.equal(gated.body.code,'circle_feature_unavailable');
});
