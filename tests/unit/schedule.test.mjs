import assert from 'node:assert/strict';
import { afterEach, beforeEach, mock, test } from 'node:test';
import { createClient } from '@libsql/client';
import {
  applyScheduleMutation,
  MAX_SCHEDULE_PROPOSALS,
  nextScheduleUpdatedAt,
  normalizeScheduleInstant,
  parseScheduleMutation,
  projectSchedule,
  readScheduleState,
  ScheduleDataError,
  ScheduleInputError,
  scheduleVersion,
} from '../../api/_schedule.js';

let currentDb=null;

function authPayload(req){
  if(req?.headers?.['x-test-auth']==='member') return {id:2,email:'member@example.test'};
  if(req?.headers?.['x-test-auth']==='outsider') return {id:9,email:'outsider@example.test'};
  return null;
}

mock.module('../../api/_db.js',{
  exports:{
    captureSentryException:()=>null,
    captureSentryMessage:()=>null,
    getAdminEmails:()=>new Set(),
    getClient:()=>currentDb,
    getJwtSecret:()=>'schedule-test-secret-at-least-thirty-two-characters',
    initSentry:()=>{},
    isSentryConfigured:()=>false,
    verifyMutationOrigin:()=>true,
    verifyRequestAuth:authPayload,
  },
});

const {default:dataHandler}=await import('../../api/data.js');

function sqlText(statement){
  return typeof statement==='string'?statement:String(statement?.sql||'');
}

function invoke({method='GET',url='/api/schedule',query={endpoint:'schedule'},headers={'x-test-auth':'member'},body={}}={}){
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

async function readyDatabase({withUnique=true}={}){
  const db=createClient({url:'file::memory:'});
  await db.execute(`CREATE TABLE pairing_groups (
    id INTEGER PRIMARY KEY, week_id INTEGER NOT NULL, user_a_id INTEGER NOT NULL,
    user_b_id INTEGER NOT NULL, user_c_id INTEGER
  )`);
  await db.execute(`INSERT INTO pairing_groups (id,week_id,user_a_id,user_b_id,user_c_id)
    VALUES (20,10,2,4,NULL),(21,10,4,5,NULL)`);
  await db.execute(`CREATE TABLE pairing_participants (
    week_id INTEGER NOT NULL,user_id INTEGER NOT NULL,position INTEGER NOT NULL,source TEXT NOT NULL,
    PRIMARY KEY(week_id,user_id)
  )`);
  await db.execute(`INSERT INTO pairing_participants (week_id,user_id,position,source) VALUES
    (10,2,0,'auth'),(10,4,1,'auth'),(10,5,2,'auth')`);
  await db.execute(`CREATE TABLE pair_schedules (
    id INTEGER PRIMARY KEY AUTOINCREMENT, week_id INTEGER NOT NULL, pair_group_id INTEGER NOT NULL,
    proposed_times TEXT, agreed_time TEXT, created_at TEXT, updated_at TEXT
    ${withUnique?', UNIQUE(week_id,pair_group_id)':''}
  )`);
  return db;
}

function tracedClient(delegate,calls){
  return {
    async execute(statement){
      calls.push({sql:sqlText(statement),args:statement?.args||[]});
      return delegate.execute(statement);
    },
    async batch(statements,mode){
      for(const statement of statements) calls.push({sql:sqlText(statement),args:statement?.args||[]});
      return delegate.batch(statements,mode);
    },
  };
}

beforeEach(()=>{
  currentDb=null;
  delete process.env.TURSO_DATABASE_URL;
});

afterEach(()=>{
  try{ currentDb?.close?.(); }catch{}
  currentDb=null;
});

test('strict RFC3339 instants normalize offsets and reject ambiguous or impossible values',()=>{
  assert.equal(normalizeScheduleInstant('2026-09-20T08:00:00Z'),'2026-09-20T08:00:00.000Z');
  assert.equal(normalizeScheduleInstant('2026-09-20T08:00:00+01:00'),'2026-09-20T07:00:00.000Z');
  assert.equal(normalizeScheduleInstant('2024-02-29T23:59:59.123456789-02:30'),'2024-03-01T02:29:59.123Z');
  for(const invalid of [
    '2026-09-20T08:00:00',' 2026-09-20T08:00:00Z','2026-02-29T08:00:00Z',
    '2026-04-31T08:00:00Z','2026-09-20T24:00:00Z','2026-09-20T08:00:60Z',
    '2026-09-20T08:00:00+24:00','2026-09-20 08:00:00Z','x'.repeat(81),42,null,
    '0000-01-01T00:00:00+23:59','9999-12-31T23:59:59-23:59',
  ]) assert.equal(normalizeScheduleInstant(invalid),null,String(invalid));
});

test('projection preserves legacy values, hides raw storage, and derives stable opaque identifiers',()=>{
  const rawProposals=JSON.stringify([
    'Sunday morning',
    '2026-09-20T08:00:00Z',
    'Sunday morning',
    {instant:'2026-09-20T09:00:00.000Z',proposed_by:4},
  ]);
  const state=readScheduleState({
    proposed_times:rawProposals,
    agreed_time:'Sunday morning',
    updated_at:'2026-09-18 10:00:00',
  });
  const first=projectSchedule(state);
  const second=projectSchedule(readScheduleState({
    proposed_times:rawProposals,
    agreed_time:'Sunday morning',
    updated_at:'2026-09-18 10:00:00',
  }));
  assert.match(first.version,/^[a-f0-9]{64}$/);
  assert.deepEqual(first,second);
  assert.deepEqual(first.proposals.map(item=>item.value),[
    'Sunday morning','2026-09-20T08:00:00Z','Sunday morning','2026-09-20T09:00:00.000Z',
  ]);
  assert.equal(new Set(first.proposals.map(item=>item.proposal_id)).size,4);
  assert.equal(first.proposals[0].instant,null);
  assert.equal(first.proposals[1].instant,'2026-09-20T08:00:00.000Z');
  assert.equal(first.proposals[2].legacy,true);
  assert.deepEqual(first.proposals[3],{
    proposal_id:first.proposals[3].proposal_id,
    value:'2026-09-20T09:00:00.000Z',
    instant:'2026-09-20T09:00:00.000Z',
    proposed_by:4,
    legacy:false,
  });
  assert.equal(first.agreed_time,null);
  assert.equal(first.legacy_agreed_time,'Sunday morning');
  assert.equal('rawProposedTimes' in first,false);

  const normalized=projectSchedule(readScheduleState({
    proposed_times:'[]',agreed_time:'2026-09-20T09:00:00.000Z',updated_at:null,
  }));
  assert.equal(normalized.agreed_time,'2026-09-20T09:00:00.000Z');
  assert.equal(normalized.legacy_agreed_time,null);

  const empty=readScheduleState(null);
  assert.deepEqual(projectSchedule(empty),{
    version:empty.version,proposals:[],agreed_time:null,legacy_agreed_time:null,updated_at:null,
  });
  assert.notEqual(empty.version,readScheduleState({proposed_times:null,agreed_time:null,updated_at:null}).version);
  assert.notEqual(
    scheduleVersion({...state,rawUpdatedAt:'first'}),
    scheduleVersion({...state,rawUpdatedAt:'second'}),
  );
});

test('stored schedule parsing rejects malformed, duplicate, and resource-exhausting values',()=>{
  const modern={instant:'2026-09-20T09:00:00.000Z',proposed_by:2};
  const thirteenModern=Array.from({length:13},(_,index)=>({
    instant:`2026-09-${String(index+1).padStart(2,'0')}T09:00:00.000Z`,proposed_by:2,
  }));
  const invalidRows=[
    {proposed_times:'{}',agreed_time:null,updated_at:null},
    {proposed_times:'not json',agreed_time:null,updated_at:null},
    {proposed_times:JSON.stringify(Array(21).fill('legacy')),agreed_time:null,updated_at:null},
    {proposed_times:JSON.stringify([{...modern,extra:true}]),agreed_time:null,updated_at:null},
    {proposed_times:JSON.stringify([{...modern,proposed_by:'2'}]),agreed_time:null,updated_at:null},
    {proposed_times:JSON.stringify([{instant:'2026-09-20T09:00:00Z',proposed_by:2}]),agreed_time:null,updated_at:null},
    {proposed_times:JSON.stringify([modern,{...modern,proposed_by:4}]),agreed_time:null,updated_at:null},
    {proposed_times:JSON.stringify(thirteenModern),agreed_time:null,updated_at:null},
    {proposed_times:JSON.stringify([...Array(12).fill('legacy'),modern]),agreed_time:null,updated_at:null},
    {proposed_times:JSON.stringify(['x'.repeat(4097)]),agreed_time:null,updated_at:null},
    {proposed_times:'[]',agreed_time:'x'.repeat(4097),updated_at:null},
    {proposed_times:'[]',agreed_time:null,updated_at:'x'.repeat(129)},
    {proposed_times:[],agreed_time:null,updated_at:null},
  ];
  for(const row of invalidRows){
    assert.throws(()=>readScheduleState(row),ScheduleDataError);
  }
  assert.equal(readScheduleState({
    proposed_times:JSON.stringify(Array.from({length:20},(_,index)=>`legacy-${index}`)),
    agreed_time:null,updated_at:null,
  }).entries.length,20,'the legacy 20-entry envelope remains readable and removable');
});

test('mutation parsing enforces exact action fields, opaque versions, and identifiers',()=>{
  const version='a'.repeat(64);
  assert.deepEqual(parseScheduleMutation({
    room_id:'week_10_pair_20',action:'propose',base_version:version,instant:'2026-09-20T08:00:00+01:00',
  }),{
    roomId:'week_10_pair_20',action:'propose',baseVersion:version,instant:'2026-09-20T07:00:00.000Z',
  });
  assert.deepEqual(parseScheduleMutation({
    room_id:'week_10_pair_20',action:'clear',base_version:version,
  }),{roomId:'week_10_pair_20',action:'clear',baseVersion:version});
  for(const body of [
    null,[],{},
    {room_id:'week_10_pair_20',action:'unknown',base_version:version},
    {room_id:'week_10_pair_20',action:'clear',base_version:version,extra:true},
    {room_id:'week_10_pair_20',action:'clear',base_version:'A'.repeat(64)},
    {room_id:'week_10_pair_20',action:'propose',base_version:version,instant:'tomorrow'},
    {room_id:'week_10_pair_20',action:'remove',base_version:version,proposal_id:'short'},
    {room_id:'week_10_pair_20',action:'accept',base_version:version},
  ]) assert.throws(()=>parseScheduleMutation(body),ScheduleInputError);
});

test('mutations preserve legacy entries, enforce limits, and accept only modern proposals',()=>{
  const state=readScheduleState({
    proposed_times:JSON.stringify(['legacy',{instant:'2026-09-20T09:00:00.000Z',proposed_by:4}]),
    agreed_time:'old agreement',updated_at:'old',
  });
  const projected=projectSchedule(state);
  const removed=applyScheduleMutation(state,{
    action:'remove',proposalId:projected.proposals[0].proposal_id,
  },2);
  assert.deepEqual(JSON.parse(removed.proposedTimes),[{instant:'2026-09-20T09:00:00.000Z',proposed_by:4}]);
  assert.equal(removed.agreedTime,'old agreement');

  const accepted=applyScheduleMutation(state,{
    action:'accept',proposalId:projected.proposals[1].proposal_id,
  },2);
  assert.equal(accepted.proposedTimes,state.rawProposedTimes);
  assert.equal(accepted.agreedTime,'2026-09-20T09:00:00.000Z');
  assert.throws(()=>applyScheduleMutation(state,{
    action:'accept',proposalId:projected.proposals[0].proposal_id,
  },2),ScheduleInputError);
  assert.throws(()=>applyScheduleMutation(state,{action:'remove',proposalId:'f'.repeat(64)},2),ScheduleInputError);

  const cleared=applyScheduleMutation(state,{action:'clear'},2);
  assert.equal(cleared.agreedTime,null);
  assert.equal(cleared.proposedTimes,state.rawProposedTimes);

  const proposed=applyScheduleMutation(state,{
    action:'propose',instant:'2026-09-20T10:00:00.000Z',
  },2);
  assert.deepEqual(JSON.parse(proposed.proposedTimes).at(-1),{
    instant:'2026-09-20T10:00:00.000Z',proposed_by:2,
  });
  assert.throws(()=>applyScheduleMutation(state,{
    action:'propose',instant:'2026-09-20T09:00:00.000Z',
  },2),ScheduleInputError);
  const parseableLegacy=readScheduleState({
    proposed_times:JSON.stringify(['2026-09-20T10:00:00Z']),agreed_time:null,updated_at:null,
  });
  assert.throws(()=>applyScheduleMutation(parseableLegacy,{
    action:'propose',instant:'2026-09-20T10:00:00.000Z',
  },2),ScheduleInputError);

  const full=readScheduleState({
    proposed_times:JSON.stringify(Array.from({length:MAX_SCHEDULE_PROPOSALS},(_,index)=>`legacy-${index}`)),
    agreed_time:null,updated_at:null,
  });
  assert.throws(()=>applyScheduleMutation(full,{
    action:'propose',instant:'2026-09-20T10:00:00.000Z',
  },2),ScheduleInputError);
  assert.throws(()=>applyScheduleMutation(state,{action:'clear'},0),ScheduleInputError);
  assert.throws(()=>applyScheduleMutation(state,{action:'other'},2),ScheduleInputError);
  assert.equal(nextScheduleUpdatedAt('2026-09-18T10:00:00.000Z',Date.parse('2026-09-18T10:00:00.000Z')),
    '2026-09-18T10:00:00.001Z');
  assert.equal(nextScheduleUpdatedAt('2026-09-18T10:00:00.001Z',Date.parse('2026-09-18T10:00:00.000Z')),
    '2026-09-18T10:00:00.002Z','a stalled or backward clock must not recreate an older version');
});

test('schedule GET projects safe room data, caches schema readiness, and performs no DDL',async()=>{
  const delegate=await readyDatabase();
  await delegate.execute({
    sql:`INSERT INTO pair_schedules (week_id,pair_group_id,proposed_times,agreed_time,created_at,updated_at) VALUES (?,?,?,?,?,?)`,
    args:[10,20,JSON.stringify(['legacy',{instant:'2026-09-20T09:00:00.000Z',proposed_by:4}]),'legacy agreement','created','updated'],
  });
  const calls=[];
  currentDb=tracedClient(delegate,calls);
  const request={
    url:'/api/schedule?room_id=week_10_pair_20',query:{endpoint:'schedule',room_id:'week_10_pair_20'},
  };
  const first=await invoke(request);
  const second=await invoke(request);
  assert.equal(first.status,200);
  assert.equal(first.headers['cache-control'],'private, no-store');
  assert.equal(first.body.room_id,'week_10_pair_20');
  assert.equal(first.body.schedule.proposals.length,2);
  assert.equal(first.body.schedule.legacy_agreed_time,'legacy agreement');
  assert.equal('proposed_times' in first.body.schedule,false);
  assert.deepEqual(second.body.schedule,first.body.schedule);
  assert.equal(calls.filter(call=>call.sql.startsWith('PRAGMA table_info')).length,1);
  assert.equal(calls.filter(call=>call.sql.startsWith('PRAGMA index_list')).length,1);
  assert.equal(calls.some(call=>/CREATE|ALTER|DELETE/i.test(call.sql)),false);
  currentDb.close=()=>delegate.close();
});

test('schedule endpoints require canonical rooms and exact membership before storage access',async()=>{
  const delegate=await readyDatabase();
  const calls=[];
  currentDb=tracedClient(delegate,calls);
  const invalidRequests=[
    {},
    {url:'/api/schedule',query:{endpoint:'schedule',week_id:'10',pair_id:'20'}},
    {url:'/api/schedule?room_id=week_01_pair_20',query:{endpoint:'schedule',room_id:'week_01_pair_20'}},
    {method:'POST',body:{room_id:'week_10_pair_20',action:'clear',base_version:'a'.repeat(64),week_id:10}},
  ];
  for(const request of invalidRequests){
    const response=await invoke(request);
    assert.equal(response.status,400);
  }
  const missing=await invoke({
    url:'/api/schedule?room_id=week_10_pair_99',query:{endpoint:'schedule',room_id:'week_10_pair_99'},
  });
  assert.equal(missing.status,404);
  const forbidden=await invoke({
    url:'/api/schedule?room_id=week_10_pair_21',query:{endpoint:'schedule',room_id:'week_10_pair_21'},
  });
  assert.equal(forbidden.status,404);
  const anonymous=await invoke({
    url:'/api/schedule?room_id=week_10_pair_20',query:{endpoint:'schedule',room_id:'week_10_pair_20'},headers:{},
  });
  assert.equal(anonymous.status,401);
  assert.equal(calls.some(call=>call.sql.startsWith('PRAGMA')),false,'denied requests must not probe schedule storage');
  currentDb.close=()=>delegate.close();
});

test('missing-row CAS permits one concurrent insert and returns the winning schedule on 409',async()=>{
  const delegate=await readyDatabase();
  let gateReads=false;
  let stateReads=0;
  let releaseBothReads;
  const bothReads=new Promise(resolve=>{ releaseBothReads=resolve; });
  let writeAttempts=0;
  let returningWinners=0;
  currentDb={
    async execute(statement){
      const sql=sqlText(statement);
      if(sql.includes('SELECT proposed_times,agreed_time,updated_at FROM pair_schedules')){
        const result=await delegate.execute(statement);
        if(gateReads){
          stateReads+=1;
          if(stateReads===2) releaseBothReads();
          await bothReads;
        }
        return result;
      }
      const result=await delegate.execute(statement);
      if(sql.startsWith('INSERT INTO pair_schedules')){
        writeAttempts+=1;
        if(result.rows.length) returningWinners+=1;
      }
      return result;
    },
    close(){ delegate.close(); },
  };
  const initial=await invoke({
    url:'/api/schedule?room_id=week_10_pair_20',query:{endpoint:'schedule',room_id:'week_10_pair_20'},
  });
  assert.equal(initial.status,200);
  assert.deepEqual(initial.body.schedule.proposals,[]);
  const base=initial.body.schedule.version;
  gateReads=true;
  const requests=['2026-09-20T08:00:00Z','2026-09-20T09:00:00Z'].map(instant=>invoke({
    method:'POST',body:{room_id:'week_10_pair_20',action:'propose',base_version:base,instant},
  }));
  const responses=await Promise.all(requests);
  assert.deepEqual(responses.map(response=>response.status).sort(),[200,409]);
  assert.equal(stateReads>=2,true);
  assert.equal(writeAttempts,2,'both missing-row writers must attempt the unique insert');
  assert.equal(returningWinners,1,'the unique constraint must return exactly one insert winner');
  const winner=responses.find(response=>response.status===200);
  const loser=responses.find(response=>response.status===409);
  assert.equal(loser.body.error,'schedule changed');
  assert.equal(loser.body.room_id,'week_10_pair_20');
  assert.deepEqual(loser.body.schedule,winner.body.schedule);
  assert.equal(winner.body.schedule.proposals.length,1);

  const stale=await invoke({
    method:'POST',body:{room_id:'week_10_pair_20',action:'clear',base_version:base},
  });
  assert.equal(stale.status,409);
  assert.equal(stale.body.room_id,'week_10_pair_20');

  const accepted=await invoke({
    method:'POST',body:{
      room_id:'week_10_pair_20',action:'accept',base_version:winner.body.schedule.version,
      proposal_id:winner.body.schedule.proposals[0].proposal_id,
    },
  });
  assert.equal(accepted.status,200);
  assert.equal(accepted.body.schedule.agreed_time,winner.body.schedule.proposals[0].instant);
});

test('existing-row raw CAS rejects a concurrent stale writer without losing legacy proposals',async()=>{
  const delegate=await readyDatabase();
  await delegate.execute({
    sql:`INSERT INTO pair_schedules (week_id,pair_group_id,proposed_times,agreed_time,created_at,updated_at) VALUES (?,?,?,?,?,?)`,
    args:[10,20,JSON.stringify(['legacy']),null,'created','old'],
  });
  let gateReads=false;
  let stateReads=0;
  let releaseBothReads;
  const bothReads=new Promise(resolve=>{ releaseBothReads=resolve; });
  let writeAttempts=0;
  let returningWinners=0;
  currentDb={
    async execute(statement){
      const sql=sqlText(statement);
      if(sql.includes('SELECT proposed_times,agreed_time,updated_at FROM pair_schedules')){
        const result=await delegate.execute(statement);
        if(gateReads){
          stateReads+=1;
          if(stateReads===2) releaseBothReads();
          await bothReads;
        }
        return result;
      }
      const result=await delegate.execute(statement);
      if(sql.startsWith('UPDATE pair_schedules')){
        writeAttempts+=1;
        if(result.rows.length) returningWinners+=1;
      }
      return result;
    },
    close(){ delegate.close(); },
  };
  const initial=await invoke({
    url:'/api/schedule?room_id=week_10_pair_20',query:{endpoint:'schedule',room_id:'week_10_pair_20'},
  });
  const legacyId=initial.body.schedule.proposals[0].proposal_id;
  gateReads=true;
  const [first,second]=await Promise.all([
    invoke({method:'POST',body:{
      room_id:'week_10_pair_20',action:'propose',base_version:initial.body.schedule.version,
      instant:'2026-09-20T08:00:00Z',
    }}),
    invoke({method:'POST',body:{
      room_id:'week_10_pair_20',action:'remove',base_version:initial.body.schedule.version,proposal_id:legacyId,
    }}),
  ]);
  assert.deepEqual([first.status,second.status].sort(),[200,409]);
  assert.equal(stateReads>=2,true);
  assert.equal(writeAttempts,2,'both existing-row writers must attempt the raw-value CAS update');
  assert.equal(returningWinners,1,'the raw predicates must return exactly one update winner');
  const final=await invoke({
    url:'/api/schedule?room_id=week_10_pair_20',query:{endpoint:'schedule',room_id:'week_10_pair_20'},
  });
  assert.deepEqual(final.body.schedule,[first,second].find(response=>response.status===200).body.schedule);
});

test('schema readiness coalesces probes and retries after missing table or unique constraint',async()=>{
  const delegate=createClient({url:'file::memory:'});
  await delegate.execute(`CREATE TABLE pairing_groups (
    id INTEGER PRIMARY KEY,week_id INTEGER,user_a_id INTEGER,user_b_id INTEGER,user_c_id INTEGER
  )`);
  await delegate.execute(`INSERT INTO pairing_groups VALUES (20,10,2,4,NULL)`);
  await delegate.execute(`CREATE TABLE pairing_participants (
    week_id INTEGER,user_id INTEGER,position INTEGER,source TEXT,PRIMARY KEY(week_id,user_id)
  )`);
  await delegate.execute(`INSERT INTO pairing_participants VALUES (10,2,0,'auth')`);
  const calls=[];
  currentDb=tracedClient(delegate,calls);
  const request={url:'/api/schedule?room_id=week_10_pair_20',query:{endpoint:'schedule',room_id:'week_10_pair_20'}};

  const absent=await invoke(request);
  assert.equal(absent.status,503);
  await delegate.execute(`CREATE TABLE pair_schedules (
    id INTEGER PRIMARY KEY,week_id INTEGER,pair_group_id INTEGER,proposed_times TEXT,
    agreed_time TEXT,created_at TEXT,updated_at TEXT
  )`);
  const noConstraint=await invoke(request);
  assert.equal(noConstraint.status,503);
  await delegate.execute(`CREATE UNIQUE INDEX uq_schedule_partial ON pair_schedules(week_id,pair_group_id) WHERE week_id>0`);
  const partialConstraint=await invoke(request);
  assert.equal(partialConstraint.status,503,'a partial index cannot back the unqualified insert conflict target');
  await delegate.execute(`DROP INDEX uq_schedule_partial`);
  await delegate.execute(`CREATE UNIQUE INDEX uq_schedule_pair ON pair_schedules(week_id,pair_group_id)`);
  const ready=await invoke(request);
  assert.equal(ready.status,200);
  const probesAfterReady=calls.filter(call=>call.sql.startsWith('PRAGMA table_info')).length;
  const cached=await invoke(request);
  assert.equal(cached.status,200);
  assert.equal(calls.filter(call=>call.sql.startsWith('PRAGMA table_info')).length,probesAfterReady);
  assert.ok(probesAfterReady>=4,'each failed readiness attempt must be evicted and retried');
  currentDb.close=()=>delegate.close();
});

test('concurrent schedule reads share one in-flight schema probe',async()=>{
  let releaseProbe;
  let markProbeStarted;
  const probeGate=new Promise(resolve=>{ releaseProbe=resolve; });
  const probeStarted=new Promise(resolve=>{ markProbeStarted=resolve; });
  let tableProbes=0;
  let accessChecks=0;
  currentDb={
    async execute(statement){
      const sql=sqlText(statement);
      if(sql.includes('FROM pairing_groups AS pg')&&sql.includes("viewer.source='auth'")){
        accessChecks+=1;
        return {rows:[{pair_group_id:20,week_id:10,user_a_id:2,user_b_id:4,user_c_id:null}]};
      }
      if(sql.startsWith("PRAGMA table_info('pair_schedules')")){
        tableProbes+=1;
        markProbeStarted();
        await probeGate;
        return {rows:['week_id','pair_group_id','proposed_times','agreed_time','created_at','updated_at'].map(name=>({name}))};
      }
      if(sql.startsWith("PRAGMA index_list('pair_schedules')")) return {rows:[{name:'unique_pair',unique:1}]};
      if(sql.startsWith('PRAGMA index_info')) return {rows:[{seqno:0,name:'week_id'},{seqno:1,name:'pair_group_id'}]};
      if(sql.includes('FROM pair_schedules WHERE week_id=')) return {rows:[]};
      return {rows:[]};
    },
  };
  const request={url:'/api/schedule?room_id=week_10_pair_20',query:{endpoint:'schedule',room_id:'week_10_pair_20'}};
  const first=invoke(request);
  await probeStarted;
  const second=invoke(request);
  await Promise.resolve();
  assert.equal(tableProbes,1);
  assert.equal(accessChecks,2,'membership remains per request even while readiness is shared');
  releaseProbe();
  const responses=await Promise.all([first,second]);
  assert.deepEqual(responses.map(response=>response.status),[200,200]);
  assert.equal(tableProbes,1);
});
