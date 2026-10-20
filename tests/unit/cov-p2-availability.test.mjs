// Edge, negative, and fail-closed branches of api/_availability.js that the
// main availability suite does not reach: strict input contracts, active
// circle context scoping, schema readiness failures, stored-row integrity,
// retry classification, and post-write CAS failure classification.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, mock, test } from 'node:test';

import { createClient } from '@libsql/client';

const contextValidator={impl:async()=>true,calls:[]};
mock.module('../../api/_active-circle.js',{namedExports:{
  validateActiveCircleMutationContext:async(...args)=>{
    contextValidator.calls.push(args);
    return contextValidator.impl(...args);
  },
}});

const {
  applyCycleAvailability,
  AvailabilityError,
  availabilityCycleKey,
  availabilityFailure,
  availabilityResponse,
  ensureAvailabilityReadiness,
  getAvailabilityState,
  materializeAvailabilityCycle,
  resolveAvailabilityPublicationScope,
  resolveAvailabilityScope,
  resolveEditableAvailabilityCycle,
  updateAvailability,
}=await import('../../api/_availability.js');
const { resolvePairingCycle }=await import('../../api/_pairing-cycle.js');
const { INDEXES, TABLES }=await import('../../db/schema-manifest.js');

const SAFE='2099-09-18T12:00:00.000Z';
const SESSION_HASH='a'.repeat(64);
const cleanup=[];

afterEach(async()=>{
  contextValidator.impl=async()=>true;
  contextValidator.calls.length=0;
  while(cleanup.length){
    try{ await cleanup.pop()(); }catch{}
  }
});

async function createDatabase(){
  const directory=mkdtempSync(join(tmpdir(),'randori-cov-availability-'));
  const db=createClient({url:pathToFileURL(join(directory,'a.sqlite')).href});
  await db.batch([
    `CREATE TABLE auth_accounts (id INTEGER PRIMARY KEY,email TEXT NOT NULL,is_available INTEGER,is_demo INTEGER NOT NULL DEFAULT 0)`,
    `CREATE TABLE circles (id INTEGER PRIMARY KEY,public_id TEXT NOT NULL,name TEXT NOT NULL,is_primary INTEGER NOT NULL,archived_at TEXT)`,
    `CREATE TABLE circle_memberships (circle_id INTEGER NOT NULL,user_id INTEGER NOT NULL,role TEXT NOT NULL,status TEXT NOT NULL,PRIMARY KEY(circle_id,user_id))`,
    `CREATE TABLE auth_sessions (session_hash TEXT PRIMARY KEY,user_id INTEGER NOT NULL,expires_at INTEGER NOT NULL,revoked_at INTEGER)`,
    `CREATE TABLE auth_session_circle_contexts (session_hash TEXT PRIMARY KEY,user_id INTEGER NOT NULL,circle_id INTEGER NOT NULL,context_version INTEGER NOT NULL)`,
    TABLES.find(table=>table.name==='pairing_cycles').sql,
    TABLES.find(table=>table.name==='pairing_cycle_availability').sql,
    INDEXES.find(index=>index.name==='idx_pairing_cycle_availability_candidates').sql,
    `INSERT INTO auth_accounts (id,email,is_available,is_demo) VALUES (1,'one@example.test',0,0),(2,'two@example.test',1,0)`,
    `INSERT INTO circles (id,public_id,name,is_primary) VALUES (10,'circle_primary','Primary',1),(20,'circle_secondary','Secondary',0)`,
    `INSERT INTO circle_memberships (circle_id,user_id,role,status) VALUES (10,1,'member','active'),(20,2,'member','active')`,
  ],'write');
  cleanup.push(async()=>{ db.close(); rmSync(directory,{recursive:true,force:true}); });
  return db;
}

// Routes the SQLite clock used by CAS predicates to a fixed instant and lets a
// test intercept individual statements inside the write transaction.
function wrapDatabase(db,{instant=SAFE,intercept}={}){
  const now=new Date(instant).toISOString();
  const seconds=Math.floor(Date.parse(now)/1000);
  const wrap=transaction=>{
    const tx={
      async execute(value){
        const sql=typeof value==='string'?value:String(value?.sql||'');
        if(intercept){
          const replaced=await intercept(sql,value,transaction);
          if(replaced!==undefined) return replaced;
        }
        if(sql.includes("strftime('%Y-%m-%dT%H:%M:%fZ','now')")) return {rows:[{now_utc:now}]};
        if(value&&typeof value==='object'&&sql.includes("CAST(strftime('%s','now') AS INTEGER)")){
          return transaction.execute({...value,sql:sql.replaceAll("CAST(strftime('%s','now') AS INTEGER)",String(seconds))});
        }
        return transaction.execute(value);
      },
      batch:(values,mode)=>transaction.batch(values,mode),
      commit:()=>transaction.commit(),
      rollback:()=>transaction.rollback(),
      close:()=>transaction.close?.(),
    };
    return tx;
  };
  return {
    execute:value=>db.execute(value),
    batch:(values,mode)=>db.batch(values,mode),
    async transaction(mode){ return wrap(await db.transaction(mode)); },
  };
}

function expectCode(code){
  return error=>error instanceof AvailabilityError&&error.code===code;
}

function cycleAt(instant=SAFE,state='upcoming'){
  return resolvePairingCycle({now:instant,timeZone:'Europe/London',state});
}

function context({circleId=20,userId=2,implicit=false,contextVersion=3,sessionHash=SESSION_HASH,useUid=false}={}){
  return {
    payload:useUid?{uid:String(userId),sessionHash}:{id:userId,sessionHash},
    circleId,contextVersion,implicit,
  };
}

test('failure projection maps every domain code to a non-leaky HTTP contract',()=>{
  const state={cycle:{cycleId:'2099-W38'},cycleKey:'k',isAvailable:true,version:2,source:'user',editable:true,updatedAt:null};
  const ctx={circleContextVersion:7};
  assert.deepEqual(availabilityFailure(new AvailabilityError('AVAILABILITY_FORBIDDEN','x'),ctx),
    {status:403,body:{ok:false,error:'active circle membership required',circle_context_version:7}});
  assert.deepEqual(availabilityFailure(new AvailabilityError('AVAILABILITY_CONTEXT_CHANGED','x'),ctx),
    {status:409,body:{ok:false,error:'circle context changed',code:'circle_context_changed'}});
  for(const [code,error] of [['AVAILABILITY_STALE','availability_stale'],
    ['AVAILABILITY_CUTOFF_CLOSED','availability_cutoff_closed'],['AVAILABILITY_CYCLE_CHANGED','availability_cycle_changed']]){
    const {status,body}=availabilityFailure(new AvailabilityError(code,'x',{details:{state}}),ctx);
    assert.equal(status,409);
    assert.equal(body.error,error);
    assert.equal(body.circle_context_version,7);
    // Missing cycle fields project to empty strings rather than undefined.
    assert.deepEqual(body.availability.cycle,{cycleId:'2099-W38',startsAt:'',endsAt:'',cutoffAt:'',timeZone:'',state:''});
  }
  const unknown=availabilityFailure(new Error('SQLITE secret path /var/db'));
  assert.deepEqual(unknown,{status:503,body:{ok:false,error:'availability unavailable'}});
  assert.deepEqual(availabilityFailure(new AvailabilityError('AVAILABILITY_INTEGRITY','x'),ctx).status,503);
  const response=availabilityResponse({...state,cycle:undefined},{circleContextVersion:0});
  assert.equal(response.circle_context_version,0);
  assert.equal(response.availability.cycle.cycleId,'');
});

test('cycle keys reject malformed scopes and non-canonical cycle descriptors',()=>{
  const cycle=cycleAt();
  for(const scope of [null,[],'circle',{kind:'local',scopeKey:'circle:1'},{kind:'global'},
    {kind:'circle',circleId:0},{kind:'circle',circleId:1.5},{kind:'circle',circleId:10,scopeKey:'circle:11'}]){
    assert.throws(()=>availabilityCycleKey(scope,cycle),expectCode('AVAILABILITY_INPUT_INVALID'));
  }
  // Display-only metadata never changes identity.
  const plain=availabilityCycleKey({kind:'circle',circleId:10},cycle);
  assert.equal(availabilityCycleKey({kind:'circle',circleId:10,scopeKey:'circle:10',publicId:'x'.repeat(500),name:'n'},cycle),plain);
  assert.equal(availabilityCycleKey({kind:'local',scopeKey:'local'},cycle),availabilityCycleKey({kind:'local'},cycle));
  assert.notEqual(availabilityCycleKey({kind:'local'},cycle),plain);
  const variants=[null,[],{},{...cycle,cycleId:'2099-W54'},{...cycle,startsAt:'nope'},
    {...cycle,cutoffAt:cycle.endsAt},{...cycle,endsAt:cycle.startsAt},
    {...cycle,startsAt:cycle.startsAt.replace('.000Z','Z')},
    {...cycle,endsAt:cycle.endsAt.replace('.000Z','Z')},
    {...cycle,cutoffAt:new Date(Date.parse(cycle.cutoffAt)-1000).toISOString().replace('.000Z','Z')},
    {...cycle,timeZone:' Europe/London'},{...cycle,timeZone:'   '},{...cycle,timeZone:'Z'.repeat(101)},
    {...cycle,state:'past'}];
  for(const value of variants){
    assert.throws(()=>availabilityCycleKey({kind:'local'},value),expectCode('AVAILABILITY_INPUT_INVALID'));
  }
  // An earlier cutoff is a valid descriptor and is part of identity.
  const earlier={...cycle,cutoffAt:new Date(Date.parse(cycle.cutoffAt)-3600_000).toISOString()};
  assert.notEqual(availabilityCycleKey({kind:'local'},earlier),availabilityCycleKey({kind:'local'},cycle));
});

test('editable cycle resolution wraps invalid options as input errors',()=>{
  assert.throws(()=>resolveEditableAvailabilityCycle({now:SAFE,timeZone:'Not/AZone'}),error=>
    expectCode('AVAILABILITY_INPUT_INVALID')(error)&&error.cause instanceof Error);
  assert.throws(()=>resolveEditableAvailabilityCycle({now:'garbage',timeZone:'Europe/London'}),
    expectCode('AVAILABILITY_INPUT_INVALID'));
  const cycle=resolveEditableAvailabilityCycle({now:SAFE,timeZone:'Europe/London'});
  assert.equal(cycle.state,'upcoming');
  assert.ok(Date.parse(cycle.cutoffAt)>Date.parse(SAFE));
});

test('readiness fails closed for incompatible clients, drift, and driver errors, then retries',async()=>{
  await assert.rejects(ensureAvailabilityReadiness(null),expectCode('AVAILABILITY_INPUT_INVALID'));
  await assert.rejects(ensureAvailabilityReadiness({execute(){}}),expectCode('AVAILABILITY_INPUT_INVALID'));

  const real=await createDatabase();
  const pragmaRows=async sql=>(await real.execute(sql)).rows;
  const scripted=(override)=>{
    let calls=0;
    return {
      get calls(){ return calls; },
      batch(){},
      async execute(sql){
        calls+=1;
        const replaced=await override(String(sql));
        return replaced===undefined?{rows:await pragmaRows(sql)}:replaced;
      },
    };
  };
  // Missing rows arrays are treated as missing schema.
  await assert.rejects(ensureAvailabilityReadiness(scripted(async()=>({}))),expectCode('AVAILABILITY_SCHEMA_UNAVAILABLE'));
  // A unique or partial candidate index is drift.
  const uniqueIndex=scripted(async sql=>sql.startsWith('PRAGMA index_list')?{rows:[{name:'idx_pairing_cycle_availability_candidates',unique:1,partial:0}]}:undefined);
  await assert.rejects(ensureAvailabilityReadiness(uniqueIndex),expectCode('AVAILABILITY_SCHEMA_UNAVAILABLE'));
  const partialIndex=scripted(async sql=>sql.startsWith('PRAGMA index_list')?{rows:[{name:'idx_pairing_cycle_availability_candidates',unique:0,partial:1}]}:undefined);
  await assert.rejects(ensureAvailabilityReadiness(partialIndex),expectCode('AVAILABILITY_SCHEMA_UNAVAILABLE'));
  const wrongColumns=scripted(async sql=>sql.startsWith("PRAGMA index_info")?{rows:[{seqno:0,name:'user_id'}]}:undefined);
  await assert.rejects(ensureAvailabilityReadiness(wrongColumns),expectCode('AVAILABILITY_SCHEMA_UNAVAILABLE'));
  const wrongType=scripted(async sql=>{
    if(!sql.startsWith("PRAGMA table_info('pairing_cycles')")) return undefined;
    const rows=(await real.execute(sql)).rows.map(row=>({...row}));
    rows[0].type='BLOB';
    return {rows};
  });
  await assert.rejects(ensureAvailabilityReadiness(wrongType),expectCode('AVAILABILITY_SCHEMA_UNAVAILABLE'));
  // Missing PRAGMA rows for index info is tolerated only if the index matches; here it does not.
  const noIndexInfo=scripted(async sql=>sql.startsWith('PRAGMA index_info')?{}:undefined);
  await assert.rejects(ensureAvailabilityReadiness(noIndexInfo),expectCode('AVAILABILITY_SCHEMA_UNAVAILABLE'));

  // A raw driver failure is wrapped, the cache is cleared, and a later call recovers.
  let broken=true;
  const flaky=scripted(async()=>{ if(broken) throw new Error('network down'); return undefined; });
  await assert.rejects(ensureAvailabilityReadiness(flaky),error=>
    expectCode('AVAILABILITY_SCHEMA_UNAVAILABLE')(error)&&error.cause?.message==='network down');
  broken=false;
  const [first,second]=await Promise.all([ensureAvailabilityReadiness(flaky),ensureAvailabilityReadiness(flaky)]);
  assert.equal(first,true);
  assert.equal(second,true);
  const callsAfter=flaky.calls;
  assert.equal(await ensureAvailabilityReadiness(flaky),true);
  assert.equal(flaky.calls,callsAfter,'success is cached per client');
});

test('scope resolution validates inputs, circle contexts, and stored legacy values',async()=>{
  const db=await createDatabase();
  await assert.rejects(resolveAvailabilityScope(db,{userId:0}),expectCode('AVAILABILITY_INPUT_INVALID'));
  await assert.rejects(resolveAvailabilityScope(db,{userId:1,localRuntime:'yes'}),expectCode('AVAILABILITY_INPUT_INVALID'));
  await assert.rejects(resolveAvailabilityScope(db,{userId:2,localRuntime:true,circleContext:context()}),
    expectCode('AVAILABILITY_INPUT_INVALID'));
  for(const bad of [[],'ctx',{payload:null,implicit:false,circleId:20,contextVersion:1},
    {payload:[],implicit:false,circleId:20,contextVersion:1},
    {payload:{id:2,sessionHash:SESSION_HASH},implicit:'no',circleId:20,contextVersion:1},
    {...context(),circleId:'20'},{...context(),contextVersion:-1},{...context(),contextVersion:1.5},
    context({userId:1}),context({sessionHash:'A'.repeat(64)}),{...context(),payload:{id:2}}]){
    await assert.rejects(resolveAvailabilityScope(db,{userId:2,circleContext:bad}),expectCode('AVAILABILITY_INPUT_INVALID'));
  }
  // An explicit context scopes to the selected secondary circle; uid claims are accepted.
  const scoped=await resolveAvailabilityScope(db,{userId:2,circleContext:context({useUid:true})});
  assert.equal(scoped.scopeKey,'circle:20');
  assert.equal(scoped.publicId,'circle_secondary');
  assert.equal(scoped.bridgeLegacyAvailability,false);
  // A context naming a circle the user does not belong to is forbidden.
  await assert.rejects(resolveAvailabilityScope(db,{userId:2,circleContext:context({circleId:10})}),
    expectCode('AVAILABILITY_FORBIDDEN'));
  // The default (no context) path reads only the primary circle.
  await assert.rejects(resolveAvailabilityScope(db,{userId:2}),expectCode('AVAILABILITY_FORBIDDEN'));

  const legacy=async value=>resolveAvailabilityScope({batch(){},async execute(){
    return {rows:[{id:1,is_available:value,circle_id:10,circle_public_id:'p',circle_name:'n',is_primary:1}]};
  }},{userId:1});
  assert.equal((await legacy(null)).legacyIsAvailable,true);
  assert.equal((await legacy(1n)).legacyIsAvailable,true);
  assert.equal((await legacy(true)).legacyIsAvailable,true);
  assert.equal((await legacy(0n)).legacyIsAvailable,false);
  assert.equal((await legacy(false)).legacyIsAvailable,false);
  await assert.rejects(legacy('1'),expectCode('AVAILABILITY_INTEGRITY'));
  await assert.rejects(legacy(2),expectCode('AVAILABILITY_INTEGRITY'));

  await assert.rejects(resolveAvailabilityScope({batch(){},async execute(){ throw new Error('boom'); }},{userId:1}),
    error=>expectCode('AVAILABILITY_UNAVAILABLE')(error)&&error.cause.message==='boom');
  await assert.rejects(resolveAvailabilityScope({batch(){},async execute(){ return {}; }},{userId:1}),
    expectCode('AVAILABILITY_FORBIDDEN'));
});

test('publication scope requires exactly one primary circle and a boolean runtime flag',async()=>{
  const db=await createDatabase();
  await assert.rejects(resolveAvailabilityPublicationScope(db,{localRuntime:1}),expectCode('AVAILABILITY_INPUT_INVALID'));
  assert.deepEqual({...await resolveAvailabilityPublicationScope(db,{localRuntime:true})},{kind:'local',scopeKey:'local',circleId:null});
  assert.equal((await resolveAvailabilityPublicationScope(db)).scopeKey,'circle:10');
  await db.execute(`UPDATE circles SET is_primary=1 WHERE id=20`);
  await assert.rejects(resolveAvailabilityPublicationScope(db),expectCode('AVAILABILITY_INTEGRITY'));
  await assert.rejects(resolveAvailabilityPublicationScope({batch(){},async execute(){ return {}; }}),expectCode('AVAILABILITY_INTEGRITY'));
  await assert.rejects(resolveAvailabilityPublicationScope({batch(){},async execute(){ throw new Error('x'); }}),expectCode('AVAILABILITY_UNAVAILABLE'));
});

test('materialization rejects stored-row drift, ambiguous rows, and failed inserts',async()=>{
  const cycle=cycleAt();
  const scope={kind:'circle',circleId:10};
  const key=availabilityCycleKey(scope,cycle);
  const row={scope_key:'circle:10',circle_id:10,cycle_key:key,cycle_id:cycle.cycleId,starts_at:cycle.startsAt,
    ends_at:cycle.endsAt,cutoff_at:cycle.cutoffAt,time_zone:cycle.timeZone,default_source:'cycle_default'};
  const fake=(...responses)=>({batch(){},async execute(){
    const next=responses.shift();
    if(next instanceof Error) throw next;
    return next;
  }});
  await assert.rejects(materializeAvailabilityCycle(fake(),{scope,cycle,bridgeLegacyAvailability:'no'}),
    expectCode('AVAILABILITY_INPUT_INVALID'));
  await assert.rejects(materializeAvailabilityCycle(fake(new Error('down')),{scope,cycle}),expectCode('AVAILABILITY_UNAVAILABLE'));
  await assert.rejects(materializeAvailabilityCycle(fake({rows:[row,row]}),{scope,cycle}),expectCode('AVAILABILITY_INTEGRITY'));
  for(const drift of [{scope_key:'circle:11'},{cycle_key:'0'.repeat(64)},{cycle_id:'2099-W01'},{starts_at:'x'},
    {ends_at:'x'},{cutoff_at:'x'},{time_zone:'UTC'},{default_source:'user'},{circle_id:11}]){
    await assert.rejects(materializeAvailabilityCycle(fake({rows:[{...row,...drift}]}),{scope,cycle}),
      expectCode('AVAILABILITY_INTEGRITY'));
  }
  // Local scope requires a NULL circle id.
  const localKey=availabilityCycleKey({kind:'local'},cycle);
  await assert.rejects(materializeAvailabilityCycle(fake({rows:[{...row,scope_key:'local',cycle_key:localKey,circle_id:0}]}),
    {scope:{kind:'local'},cycle}),expectCode('AVAILABILITY_INTEGRITY'));
  const local=await materializeAvailabilityCycle(fake({rows:[{...row,scope_key:'local',cycle_key:localKey,circle_id:null}]}),
    {scope:{kind:'local'},cycle});
  assert.equal(local.circleId,null);
  assert.equal(local.defaultSource,'cycle_default');

  // Insert path: driver failure, a missing row after insert, and a raced legacy default for a secondary circle.
  await assert.rejects(materializeAvailabilityCycle(fake({rows:[]},new Error('insert failed')),{scope,cycle}),
    expectCode('AVAILABILITY_UNAVAILABLE'));
  await assert.rejects(materializeAvailabilityCycle(fake({},{},{}),{scope,cycle}),expectCode('AVAILABILITY_INTEGRITY'));
  await assert.rejects(materializeAvailabilityCycle(fake({rows:[]},{},{rows:[{...row,default_source:'legacy_bridge'}]}),
    {scope,cycle,bridgeLegacyAvailability:false}),expectCode('AVAILABILITY_INTEGRITY'));
  const inserted=await materializeAvailabilityCycle(fake({rows:[]},{},{rows:[row]}),{scope,cycle,bridgeLegacyAvailability:false});
  assert.equal(inserted.cycleKey,key);
});

test('clock sources are validated: injected functions, invalid instants, and database clock failures',async()=>{
  const db=await createDatabase();
  const viaFunction=await getAvailabilityState(db,{userId:1,now:async client=>{
    assert.equal(typeof client.execute,'function');
    return new Date(SAFE);
  }});
  assert.equal(viaFunction.editable,true);
  assert.equal(viaFunction.isAvailable,false,'legacy bridge inherits the stored legacy value');
  await assert.rejects(getAvailabilityState(db,{userId:1,now:'not a time'}),expectCode('AVAILABILITY_INPUT_INVALID'));
  await assert.rejects(getAvailabilityState(db,{userId:1,now:()=>{ throw new Error('clock'); }}),
    error=>expectCode('AVAILABILITY_INPUT_INVALID')(error)&&error.cause.message==='clock');
  await assert.rejects(getAvailabilityState(db,{userId:1,now:()=>{
    throw new AvailabilityError('AVAILABILITY_FORBIDDEN','nested');
  }}),expectCode('AVAILABILITY_FORBIDDEN'));
  await assert.rejects(getAvailabilityState(db,{userId:'1',now:SAFE}),expectCode('AVAILABILITY_INPUT_INVALID'));

  const garbageClock=wrapDatabase(db,{intercept:async sql=>sql.includes("'%Y-%m-%dT%H:%M:%fZ'")?{rows:[{now_utc:'never'}]}:undefined});
  await assert.rejects(getAvailabilityState(garbageClock,{userId:1}),expectCode('AVAILABILITY_UNAVAILABLE'));
  const emptyClock=wrapDatabase(db,{intercept:async sql=>sql.includes("'%Y-%m-%dT%H:%M:%fZ'")?{}:undefined});
  await assert.rejects(getAvailabilityState(emptyClock,{userId:1}),expectCode('AVAILABILITY_UNAVAILABLE'));
  const brokenClock=wrapDatabase(db,{intercept:async sql=>{
    if(sql.includes("'%Y-%m-%dT%H:%M:%fZ'")) throw new Error('clock read failed');
    return undefined;
  }});
  await assert.rejects(getAvailabilityState(brokenClock,{userId:1}),error=>
    expectCode('AVAILABILITY_UNAVAILABLE')(error)&&error.cause.message==='clock read failed');
  // The database clock is used when no clock is injected.
  const dbClock=await getAvailabilityState(wrapDatabase(db),{userId:1});
  assert.equal(dbClock.cycle.cycleId,cycleAt().cycleId);
});

test('stored decisions are validated and read failures fail closed',async()=>{
  const db=await createDatabase();
  const initial=await getAvailabilityState(db,{userId:1,now:SAFE});
  const decisionRead=sql=>sql.includes('FROM pairing_cycle_availability')&&sql.includes('user_id=?');
  const base={user_id:1,is_available:1,version:1,decision_source:'user',created_at:'c',updated_at:'u'};
  for(const row of [{...base,version:0},{...base,version:1.5},{...base,is_available:2},{...base,decision_source:'admin'},
    {...base,decision_source:null},{...base,created_at:''},{...base,updated_at:null},{...base,user_id:2}]){
    const client=wrapDatabase(db,{intercept:async sql=>decisionRead(sql)?{rows:[row]}:undefined});
    await assert.rejects(getAvailabilityState(client,{userId:1,now:SAFE}),expectCode('AVAILABILITY_INTEGRITY'));
  }
  // A non-positive stored user id is rejected by the shared id guard before integrity checks.
  const negative=wrapDatabase(db,{intercept:async sql=>decisionRead(sql)?{rows:[{...base,user_id:-1}]}:undefined});
  await assert.rejects(getAvailabilityState(negative,{userId:1,now:SAFE}),expectCode('AVAILABILITY_INPUT_INVALID'));
  const duplicate=wrapDatabase(db,{intercept:async sql=>decisionRead(sql)?{rows:[base,base]}:undefined});
  await assert.rejects(getAvailabilityState(duplicate,{userId:1,now:SAFE}),expectCode('AVAILABILITY_INTEGRITY'));
  const failing=wrapDatabase(db,{intercept:async sql=>{ if(decisionRead(sql)) throw new Error('read'); return undefined; }});
  await assert.rejects(getAvailabilityState(failing,{userId:1,now:SAFE}),expectCode('AVAILABILITY_UNAVAILABLE'));
  const valid=wrapDatabase(db,{intercept:async sql=>decisionRead(sql)?{rows:[{...base,is_available:0n,version:4n}]}:undefined});
  const state=await getAvailabilityState(valid,{userId:1,now:SAFE});
  assert.deepEqual([state.isAvailable,state.version,state.source,state.updatedAt],[false,4,'user','u']);
  assert.equal(state.cycleKey,initial.cycleKey);
});

test('transaction retries recognise only vetted lock conflicts and tolerate rollback/close failures',async()=>{
  const db=await createDatabase();
  const retryable=[
    Object.assign(new Error('x'),{rawCode:'sqlite_locked_sharedcache'}),
    Object.assign(new Error('x'),{code:'TRANSACTION_CONFLICT'}),
    new Error('SQLITE_BUSY: database is locked'),
    new Error('SQLITE_LOCKED - database table is locked'),
    new Error('  Database is busy '),
    new Error('wrapper',{cause:new Error('outer',{cause:Object.assign(new Error('inner'),{code:'LIBSQL_TRANSACTION_BUSY'})})}),
  ];
  for(const error of retryable){
    let attempts=0;
    const client={
      execute:value=>db.execute(value),batch:(v,m)=>db.batch(v,m),
      async transaction(mode){ attempts+=1; if(attempts===1) throw error; return db.transaction(mode); },
    };
    const state=await getAvailabilityState(client,{userId:1,now:SAFE});
    assert.equal(state.version,0);
    assert.equal(attempts,2,`retries ${error.message}`);
  }
  // Deeply nested causes beyond the bounded walk, and look-alike messages, are not retried.
  let deep=Object.assign(new Error('bottom'),{code:'SQLITE_BUSY'});
  for(let index=0;index<5;index+=1) deep=new Error(`level ${index}`,{cause:deep});
  for(const error of [deep,new Error('the database is locked by admin'),new Error('database is busy now')]){
    let attempts=0;
    const client={execute:v=>db.execute(v),batch:(v,m)=>db.batch(v,m),async transaction(){ attempts+=1; throw error; }};
    await assert.rejects(getAvailabilityState(client,{userId:1,now:SAFE}),expectCode('AVAILABILITY_UNAVAILABLE'));
    assert.equal(attempts,1);
  }
  // Exhausting every attempt surfaces the final conflict as unavailable.
  let attempts=0;
  const alwaysBusy={execute:v=>db.execute(v),batch:(v,m)=>db.batch(v,m),async transaction(){
    attempts+=1; throw Object.assign(new Error('busy'),{code:'SQLITE_BUSY'});
  }};
  await assert.rejects(getAvailabilityState(alwaysBusy,{userId:1,now:SAFE}),expectCode('AVAILABILITY_UNAVAILABLE'));
  assert.equal(attempts,4);

  // Rollback and close errors never mask the original failure.
  const noisy={execute:v=>db.execute(v),batch:(v,m)=>db.batch(v,m),async transaction(mode){
    const tx=await db.transaction(mode);
    return {execute:v=>tx.execute(v),batch:(v,m)=>tx.batch(v,m),commit:()=>tx.commit(),
      async rollback(){ await tx.rollback(); throw new Error('rollback failed'); },
      close(){ throw new Error('close failed'); }};
  }};
  await assert.rejects(getAvailabilityState(noisy,{userId:9,now:SAFE}),expectCode('AVAILABILITY_FORBIDDEN'));
  // A ready schema is not enough: writes need a transactional client.
  await assert.rejects(getAvailabilityState({execute:v=>db.execute(v),batch:(v,m)=>db.batch(v,m)},{userId:1,now:SAFE}),
    expectCode('AVAILABILITY_INPUT_INVALID'));
});

test('active circle contexts are revalidated inside the write transaction',async()=>{
  const db=await createDatabase();
  contextValidator.impl=async()=>false;
  await assert.rejects(getAvailabilityState(db,{userId:2,now:SAFE,circleContext:context()}),expectCode('AVAILABILITY_CONTEXT_CHANGED'));
  assert.equal(contextValidator.calls.length,1);
  assert.equal(contextValidator.calls[0][1].sessionHash,SESSION_HASH);
  contextValidator.impl=async()=>{ throw new Error('db gone'); };
  await assert.rejects(getAvailabilityState(db,{userId:2,now:SAFE,circleContext:context()}),expectCode('AVAILABILITY_UNAVAILABLE'));
  contextValidator.impl=async()=>{ throw new AvailabilityError('AVAILABILITY_FORBIDDEN','nope'); };
  await assert.rejects(getAvailabilityState(db,{userId:2,now:SAFE,circleContext:context()}),expectCode('AVAILABILITY_FORBIDDEN'));
  contextValidator.impl=async()=>true;
  const state=await getAvailabilityState(db,{userId:2,now:SAFE,circleContext:context()});
  assert.equal(state.source,'cycle_default','secondary circles never bridge legacy availability');
  assert.equal(state.isAvailable,true);
});

test('explicit and implicit circle contexts authorize the CAS write against the live session',async()=>{
  const db=await createDatabase();
  const futureSeconds=Math.floor(Date.parse('2100-01-01T00:00:00Z')/1000);
  await db.execute({sql:`INSERT INTO auth_sessions (session_hash,user_id,expires_at,revoked_at) VALUES (?,2,?,NULL)`,args:[SESSION_HASH,futureSeconds]});
  await db.execute({sql:`INSERT INTO auth_session_circle_contexts (session_hash,user_id,circle_id,context_version) VALUES (?,2,20,3)`,args:[SESSION_HASH]});
  const client=wrapDatabase(db);
  const initial=await getAvailabilityState(client,{userId:2,now:SAFE,circleContext:context()});
  const first=await updateAvailability(client,{userId:2,now:SAFE,circleContext:context(),
    body:{cycle_key:initial.cycleKey,expected_version:0,is_available:false}});
  assert.deepEqual([first.version,first.isAvailable,first.source],[1,false,'user']);

  // A stale context version makes the authorization predicate refuse the write; the
  // classifier then reports an integrity failure rather than pretending success.
  await assert.rejects(updateAvailability(client,{userId:2,now:SAFE,circleContext:context({contextVersion:4}),
    body:{cycle_key:initial.cycleKey,expected_version:1,is_available:true}}),expectCode('AVAILABILITY_INTEGRITY'));
  const unchanged=await db.execute(`SELECT version,is_available FROM pairing_cycle_availability`);
  assert.deepEqual([Number(unchanged.rows[0].version),Number(unchanged.rows[0].is_available)],[1,0]);

  // Implicit contexts are valid only while no explicit selection exists.
  await assert.rejects(updateAvailability(client,{userId:2,now:SAFE,circleContext:context({implicit:true}),
    body:{cycle_key:initial.cycleKey,expected_version:1,is_available:true}}),expectCode('AVAILABILITY_INTEGRITY'));
  await db.execute(`DELETE FROM auth_session_circle_contexts`);
  const implicit=await updateAvailability(client,{userId:2,now:SAFE,circleContext:context({implicit:true}),
    body:{cycle_key:initial.cycleKey,expected_version:1,is_available:true}});
  assert.deepEqual([implicit.version,implicit.isAvailable],[2,true]);

  // A revoked session can no longer write.
  await db.execute(`UPDATE auth_sessions SET revoked_at=1`);
  await assert.rejects(updateAvailability(client,{userId:2,now:SAFE,circleContext:context({implicit:true}),
    body:{cycle_key:initial.cycleKey,expected_version:2,is_available:false}}),expectCode('AVAILABILITY_INTEGRITY'));
});

test('local runtime writes are authorized against the non-demo account only',async()=>{
  const db=await createDatabase();
  const client=wrapDatabase(db);
  const initial=await getAvailabilityState(client,{userId:1,localRuntime:true,now:SAFE});
  assert.equal(initial.source,'legacy_bridge');
  const updated=await updateAvailability(client,{userId:1,localRuntime:true,now:SAFE,
    body:{cycle_key:initial.cycleKey,expected_version:0,is_available:true}});
  assert.equal(updated.version,1);
  const rows=await db.execute(`SELECT scope_key FROM pairing_cycle_availability`);
  assert.equal(rows.rows[0].scope_key,'local');
});

test('a write that loses its CAS race is classified as stale with the winning state',async()=>{
  const db=await createDatabase();
  const plain=wrapDatabase(db);
  const initial=await getAvailabilityState(plain,{userId:1,now:SAFE});
  let raced=false;
  const racing=wrapDatabase(db,{intercept:async(sql,value,transaction)=>{
    if(!raced&&sql.startsWith('INSERT INTO pairing_cycle_availability')){
      raced=true;
      // Simulate a concurrent winner committing between the read and the write.
      await transaction.execute({sql:`INSERT INTO pairing_cycle_availability
        (scope_key,cycle_key,user_id,is_available,version,decision_source,created_at,updated_at)
        VALUES (?,?,1,0,1,'user','w','w')`,args:['circle:10',initial.cycleKey]});
      return {rows:[]};
    }
    return undefined;
  }});
  await assert.rejects(updateAvailability(racing,{userId:1,now:SAFE,
    body:{cycle_key:initial.cycleKey,expected_version:0,is_available:true}}),error=>{
    assert.ok(expectCode('AVAILABILITY_STALE')(error));
    assert.equal(error.details.state.version,1);
    assert.equal(error.details.state.isAvailable,false);
    return true;
  });
  // The race happened in a rolled-back transaction; nothing leaked.
  const rows=await db.execute(`SELECT COUNT(*) AS n FROM pairing_cycle_availability`);
  assert.equal(Number(rows.rows[0].n),0);

  // An update returning no rows without any concurrent change is an integrity failure.
  const seeded=await updateAvailability(plain,{userId:1,now:SAFE,body:{cycle_key:initial.cycleKey,expected_version:0,is_available:true}});
  const silent=wrapDatabase(db,{intercept:async sql=>sql.startsWith('UPDATE pairing_cycle_availability')?{}:undefined});
  await assert.rejects(updateAvailability(silent,{userId:1,now:SAFE,
    body:{cycle_key:initial.cycleKey,expected_version:seeded.version,is_available:false}}),expectCode('AVAILABILITY_INTEGRITY'));
});

test('a primary-circle move during the write is reported as a cycle change, not a success',async()=>{
  const db=await createDatabase();
  const plain=wrapDatabase(db);
  const initial=await getAvailabilityState(plain,{userId:1,now:SAFE});
  const moving=wrapDatabase(db,{intercept:async(sql,value,transaction)=>{
    if(sql.startsWith('INSERT INTO pairing_cycle_availability')){
      await transaction.execute(`UPDATE circles SET is_primary=CASE id WHEN 20 THEN 1 ELSE 0 END`);
      await transaction.execute(`INSERT INTO circle_memberships (circle_id,user_id,role,status) VALUES (20,1,'member','active')`);
      return {rows:[]};
    }
    return undefined;
  }});
  await assert.rejects(updateAvailability(moving,{userId:1,now:SAFE,
    body:{cycle_key:initial.cycleKey,expected_version:0,is_available:true}}),error=>{
    assert.ok(expectCode('AVAILABILITY_CYCLE_CHANGED')(error));
    assert.notEqual(error.details.state.cycleKey,initial.cycleKey);
    return true;
  });
  const primary=await db.execute(`SELECT id FROM circles WHERE is_primary=1`);
  assert.equal(Number(primary.rows[0].id),10,'the transaction rolled back');
});

test('a database clock past cutoff during classification closes the cycle',async()=>{
  const db=await createDatabase();
  const plain=wrapDatabase(db);
  const initial=await getAvailabilityState(plain,{userId:1,now:SAFE});
  const cutoff=initial.cycle.cutoffAt;
  let clockReads=0;
  const late=wrapDatabase(db,{intercept:async sql=>{
    if(sql.startsWith('INSERT INTO pairing_cycle_availability')) return {rows:[]};
    if(sql.includes("'%Y-%m-%dT%H:%M:%fZ'")){ clockReads+=1; return {rows:[{now_utc:cutoff}]}; }
    return undefined;
  }});
  await assert.rejects(updateAvailability(late,{userId:1,now:SAFE,
    body:{cycle_key:initial.cycleKey,expected_version:0,is_available:true}}),error=>{
    assert.ok(expectCode('AVAILABILITY_CUTOFF_CLOSED')(error));
    assert.equal(error.details.state.editable,true,'state is for the newly editable cycle');
    assert.notEqual(error.details.state.cycleKey,initial.cycleKey);
    return true;
  });
  assert.equal(clockReads,1);
});

test('mutations against the current cycle report cutoff; unrelated keys report a changed cycle',async()=>{
  const db=await createDatabase();
  const client=wrapDatabase(db);
  const current=cycleAt(SAFE,'current');
  const currentKey=availabilityCycleKey({kind:'circle',circleId:10},current);
  await assert.rejects(updateAvailability(client,{userId:1,now:SAFE,
    body:{cycle_key:currentKey,expected_version:0,is_available:true}}),error=>
    expectCode('AVAILABILITY_CUTOFF_CLOSED')(error)&&error.details.state.version===0);
  await assert.rejects(updateAvailability(client,{userId:1,now:SAFE,
    body:{cycle_key:'f'.repeat(64),expected_version:0,is_available:true}}),expectCode('AVAILABILITY_CYCLE_CHANGED'));
  await assert.rejects(updateAvailability({execute:v=>db.execute(v),batch:(v,m)=>db.batch(v,m),
    transaction:async()=>{ throw new TypeError('bad'); }},{
    userId:1,now:SAFE,body:{cycle_key:'f'.repeat(64),expected_version:0,is_available:true},
  }),error=>expectCode('AVAILABILITY_UNAVAILABLE')(error)&&error.cause instanceof TypeError);
  const notReady={execute:async()=>{ throw new TypeError('no table'); },batch(){},transaction(){}};
  await assert.rejects(updateAvailability(notReady,{userId:1,now:SAFE,
    body:{cycle_key:'f'.repeat(64),expected_version:0,is_available:true}}),expectCode('AVAILABILITY_SCHEMA_UNAVAILABLE'));
});

test('raw driver failures during reads and writes are wrapped as unavailable',async()=>{
  const db=await createDatabase();
  await ensureAvailabilityReadiness(db);
  const broken={execute:v=>db.execute(v),batch:(v,m)=>db.batch(v,m),async transaction(mode){
    const tx=await db.transaction(mode);
    return {execute:async v=>{
      const sql=typeof v==='string'?v:v.sql;
      if(sql.startsWith('INSERT INTO pairing_cycle_availability')) throw new TypeError('driver crashed');
      return tx.execute(v);
    },batch:(v,m)=>tx.batch(v,m),commit:()=>tx.commit(),rollback:()=>tx.rollback(),close:()=>tx.close()};
  }};
  const initial=await getAvailabilityState(db,{userId:1,now:SAFE});
  await assert.rejects(updateAvailability(broken,{userId:1,now:SAFE,
    body:{cycle_key:initial.cycleKey,expected_version:0,is_available:true}}),error=>
    expectCode('AVAILABILITY_UNAVAILABLE')(error)&&error.cause instanceof TypeError);
});

test('applying cycle availability validates the account set and stored decisions',async()=>{
  const db=await createDatabase();
  const cycle=cycleAt();
  const scope={kind:'circle',circleId:10};
  await assert.rejects(applyCycleAvailability(db,{scope,cycle,accounts:'all'}),expectCode('AVAILABILITY_INPUT_INVALID'));
  await assert.rejects(applyCycleAvailability(db,{scope,cycle,accounts:[null]}),expectCode('AVAILABILITY_INPUT_INVALID'));
  await assert.rejects(applyCycleAvailability(db,{scope,cycle,accounts:[[1]]}),expectCode('AVAILABILITY_INPUT_INVALID'));
  await assert.rejects(applyCycleAvailability(db,{scope,cycle,accounts:[{id:1},{id:1}]}),expectCode('AVAILABILITY_INPUT_INVALID'));
  await assert.rejects(applyCycleAvailability(db,{scope,cycle,accounts:[{id:'1'}]}),expectCode('AVAILABILITY_INPUT_INVALID'));
  await assert.rejects(applyCycleAvailability(db,{scope,cycle,accounts:[],bridgeLegacyAvailability:null}),
    expectCode('AVAILABILITY_INPUT_INVALID'));
  assert.deepEqual(await applyCycleAvailability(db,{scope,cycle,accounts:[]}),[]);

  const record=await materializeAvailabilityCycle(db,{scope,cycle});
  assert.equal(record.defaultSource,'legacy_bridge');
  const applied=await applyCycleAvailability(db,{scope,cycle,accounts:[{id:1,is_available:0},{id:2,is_available:null}]});
  assert.deepEqual(applied.map(item=>[item.id,item.isAvailable,item.availabilitySource,item.availabilityVersion]),
    [[1,false,'legacy_bridge',0],[2,true,'legacy_bridge',0]]);

  await db.execute({sql:`INSERT INTO pairing_cycle_availability
    (scope_key,cycle_key,user_id,is_available,version,decision_source,created_at,updated_at)
    VALUES ('circle:10',?,1,1,3,'user','c','u'),('circle:10',?,2,0,1,'user','c','u')`,args:[record.cycleKey,record.cycleKey]});
  const decided=await applyCycleAvailability(db,{scope,cycle,accounts:[{id:1,is_available:0}]});
  assert.deepEqual([decided[0].isAvailable,decided[0].availabilityVersion,decided[0].availabilitySource],[true,3,'user']);

  // A row for an account outside the requested set is a tenant-isolation breach.
  const leaky={execute:async v=>{
    const sql=typeof v==='string'?v:v.sql;
    if(sql.includes('user_id IN')) return {rows:[{user_id:7,is_available:1,version:1,decision_source:'user',created_at:'c',updated_at:'u'}]};
    return db.execute(v);
  },batch:(v,m)=>db.batch(v,m)};
  await assert.rejects(applyCycleAvailability(leaky,{scope,cycle,accounts:[{id:1}]}),expectCode('AVAILABILITY_INTEGRITY'));
  const duplicated={...leaky,execute:async v=>{
    const sql=typeof v==='string'?v:v.sql;
    const row={user_id:1,is_available:1,version:1,decision_source:'user',created_at:'c',updated_at:'u'};
    if(sql.includes('user_id IN')) return {rows:[row,row]};
    return db.execute(v);
  }};
  await assert.rejects(applyCycleAvailability(duplicated,{scope,cycle,accounts:[{id:1}]}),expectCode('AVAILABILITY_INTEGRITY'));
  const failing={...leaky,execute:async v=>{
    const sql=typeof v==='string'?v:v.sql;
    if(sql.includes('user_id IN')) throw new Error('read failed');
    return db.execute(v);
  }};
  await assert.rejects(applyCycleAvailability(failing,{scope,cycle,accounts:[{id:1}]}),expectCode('AVAILABILITY_UNAVAILABLE'));
  const empty={...leaky,execute:async v=>{
    const sql=typeof v==='string'?v:v.sql;
    if(sql.includes('user_id IN')) return {};
    return db.execute(v);
  }};
  const none=await applyCycleAvailability(empty,{scope,cycle,accounts:[{id:1,is_available:1}]});
  assert.equal(none[0].isAvailable,true);
});
