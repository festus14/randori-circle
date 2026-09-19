import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, test } from 'node:test';

import { createClient } from '@libsql/client';

import {
  applyCycleAvailability,
  AvailabilityError,
  availabilityCycleKey,
  availabilityFailure,
  availabilityResponse,
  ensureAvailabilityReadiness,
  getAvailabilityState,
  materializeAvailabilityCycle,
  parseAvailabilityMutation,
  resolveAvailabilityPublicationScope,
  resolveAvailabilityScope,
  resolveEditableAvailabilityCycle,
  updateAvailability,
} from '../../api/_availability.js';
import { resolvePairingCycle } from '../../api/_pairing-cycle.js';
import { INDEXES, TABLES } from '../../db/schema-manifest.js';

const FRIDAY='2026-09-18T12:00:00.000Z';
const SUNDAY_BOUNDARY='2026-09-20T07:00:00.000Z';
const cleanup=[];

afterEach(async()=>{
  while(cleanup.length){
    const item=cleanup.pop();
    try{ await item(); }catch{}
  }
});

async function createDatabase({availabilitySchema=true}={}){
  const directory=mkdtempSync(join(tmpdir(),'randori-availability-'));
  const url=pathToFileURL(join(directory,'availability.sqlite')).href;
  const db=createClient({url});
  const statements=[
    `PRAGMA foreign_keys=ON`,
    `CREATE TABLE auth_accounts (id INTEGER PRIMARY KEY,email TEXT NOT NULL,display_name TEXT NOT NULL,color TEXT NOT NULL,is_available INTEGER,availability_updated_at TEXT,is_demo INTEGER NOT NULL DEFAULT 0)`,
    `CREATE TABLE circles (id INTEGER PRIMARY KEY,public_id TEXT NOT NULL,name TEXT NOT NULL,is_primary INTEGER NOT NULL,archived_at TEXT)`,
    `CREATE TABLE circle_memberships (circle_id INTEGER NOT NULL,user_id INTEGER NOT NULL,role TEXT NOT NULL,status TEXT NOT NULL,PRIMARY KEY(circle_id,user_id))`,
  ];
  if(availabilitySchema){
    statements.push(
      TABLES.find(table=>table.name==='pairing_cycles').sql,
      TABLES.find(table=>table.name==='pairing_cycle_availability').sql,
      INDEXES.find(index=>index.name==='idx_pairing_cycle_availability_candidates').sql,
    );
  }
  await db.batch(statements,'write');
  await db.batch([
    `INSERT INTO auth_accounts (id,email,display_name,color,is_available,is_demo) VALUES (1,'one@example.test','One','#111',0,0),(2,'two@example.test','Two','#222',1,0),(3,'demo@example.test','Demo','#333',1,1)`,
    `INSERT INTO circles (id,public_id,name,is_primary) VALUES (10,'circle_primary','Primary',1),(20,'circle_secondary','Secondary',0)`,
    `INSERT INTO circle_memberships (circle_id,user_id,role,status) VALUES (10,1,'member','active'),(20,2,'member','active'),(10,3,'member','active')`,
  ],'write');
  let closed=false;
  const close=async()=>{ if(!closed){ closed=true; await db.close(); } };
  cleanup.push(async()=>{
    await close();
    rmSync(directory,{recursive:true,force:true});
  });
  return {db,url,close};
}

function expectCode(code){
  return error=>error instanceof AvailabilityError&&error.code===code;
}

test('the mutation parser accepts only exact JSON booleans and a strict CAS contract',()=>{
  const key='a'.repeat(64);
  assert.deepEqual(parseAvailabilityMutation({cycle_key:key,expected_version:0,is_available:false}),{
    cycleKey:key,expectedVersion:0,isAvailable:false,
  });
  assert.equal(parseAvailabilityMutation({cycle_key:key,expected_version:2,is_available:true}).isAvailable,true);
  for(const body of [
    null,[],{},
    {cycle_key:key,expected_version:0,is_available:'false'},
    {cycle_key:key,expected_version:0,is_available:0},
    {cycle_key:key,expected_version:'0',is_available:false},
    {cycle_key:key,expected_version:-1,is_available:false},
    {cycle_key:'A'.repeat(64),expected_version:0,is_available:false},
    {cycle_key:key,expected_version:0,is_available:false,user_id:1},
    {cycle_key:key,expected_version:0,isAvailable:false},
  ]) assert.throws(()=>parseAvailabilityMutation(body),expectCode('AVAILABILITY_INPUT_INVALID'));
});

test('cycle keys bind the complete descriptor and scope but survive upcoming becoming current',()=>{
  const scope={kind:'circle',circleId:10};
  const upcoming=resolveEditableAvailabilityCycle({now:FRIDAY});
  const current=resolvePairingCycle({now:SUNDAY_BOUNDARY,state:'current'});
  assert.equal(upcoming.cycleId,current.cycleId);
  assert.equal(availabilityCycleKey(scope,upcoming),availabilityCycleKey(scope,current));
  assert.notEqual(availabilityCycleKey(scope,upcoming),availabilityCycleKey({kind:'circle',circleId:20},upcoming));
  const utc=resolveEditableAvailabilityCycle({now:FRIDAY,timeZone:'UTC'});
  assert.notEqual(availabilityCycleKey(scope,upcoming),availabilityCycleKey(scope,utc));
  const yearBoundary=resolveEditableAvailabilityCycle({now:'2026-12-31T12:00:00.000Z'});
  assert.match(yearBoundary.cycleId,/^2027-W0[1-9]$/);

  for(const [before,atBoundary] of [
    ['2026-03-29T06:59:59.999Z','2026-03-29T07:00:00.000Z'],
    ['2026-10-25T07:59:59.999Z','2026-10-25T08:00:00.000Z'],
  ]){
    const target=resolveEditableAvailabilityCycle({now:before});
    const published=resolvePairingCycle({now:atBoundary,state:'current'});
    assert.equal(target.startsAt,atBoundary);
    assert.equal(availabilityCycleKey(scope,target),availabilityCycleKey(scope,published));
  }
});

test('readiness is read-only, cached after success, and fails closed for missing schema',async()=>{
  const {db}=await createDatabase();
  const statements=[];
  const proxy={
    execute(value){ statements.push(typeof value==='string'?value:value.sql); return db.execute(value); },
    batch:(values,mode)=>db.batch(values,mode),
  };
  await ensureAvailabilityReadiness(proxy);
  const checkedStatements=statements.length;
  await ensureAvailabilityReadiness(proxy);
  assert.equal(statements.length,checkedStatements,'successful readiness must be cached');
  assert.equal(statements.some(sql=>/^\s*(?:CREATE|ALTER|DROP)\b/i.test(sql)),false);

  const missing=await createDatabase({availabilitySchema:false});
  await assert.rejects(ensureAvailabilityReadiness(missing.db),expectCode('AVAILABILITY_SCHEMA_UNAVAILABLE'));
  await assert.rejects(applyCycleAvailability(missing.db,{
    scope:{kind:'local'},cycle:resolvePairingCycle({now:SUNDAY_BOUNDARY}),accounts:[],
  }),expectCode('AVAILABILITY_SCHEMA_UNAVAILABLE'));

  const drifted=await createDatabase();
  await drifted.db.execute(`DROP INDEX idx_pairing_cycle_availability_candidates`);
  await drifted.db.execute(`CREATE INDEX idx_pairing_cycle_availability_candidates ON pairing_cycle_availability(cycle_key,scope_key,user_id,is_available)`);
  await assert.rejects(ensureAvailabilityReadiness(drifted.db),expectCode('AVAILABILITY_SCHEMA_UNAVAILABLE'));
});

test('scope resolution requires one active non-demo primary membership with a strict local exception',async()=>{
  const {db}=await createDatabase();
  const production=await resolveAvailabilityScope(db,{userId:1});
  assert.deepEqual({...production},{
    kind:'circle',scopeKey:'circle:10',circleId:10,publicId:'circle_primary',name:'Primary',
    userId:1,legacyIsAvailable:false,bridgeLegacyAvailability:true,
  });
  await assert.rejects(resolveAvailabilityScope(db,{userId:2}),expectCode('AVAILABILITY_FORBIDDEN'));
  await assert.rejects(resolveAvailabilityScope(db,{userId:3}),expectCode('AVAILABILITY_FORBIDDEN'));
  const local=await resolveAvailabilityScope(db,{userId:2,localRuntime:true});
  assert.equal(local.scopeKey,'local');
  await assert.rejects(resolveAvailabilityScope(db,{userId:3,localRuntime:true}),expectCode('AVAILABILITY_FORBIDDEN'));
  assert.equal((await resolveAvailabilityPublicationScope(db)).scopeKey,'circle:10');
  assert.equal((await resolveAvailabilityPublicationScope(db,{localRuntime:true})).scopeKey,'local');
});

test('the first scope cycle bridges legacy once; later cycles use the cycle default',async()=>{
  const {db}=await createDatabase();
  const first=await getAvailabilityState(db,{userId:1,now:FRIDAY});
  assert.equal(first.isAvailable,false);
  assert.equal(first.version,0);
  assert.equal(first.source,'legacy_bridge');
  assert.equal(first.editable,true);

  await db.execute(`UPDATE auth_accounts SET is_available=0 WHERE id=1`);
  const later=await getAvailabilityState(db,{userId:1,now:'2026-09-21T12:00:00.000Z'});
  assert.equal(later.isAvailable,true,'cycle_default must not consult the legacy account flag');
  assert.equal(later.version,0);
  assert.equal(later.source,'cycle_default');
  assert.notEqual(later.cycleKey,first.cycleKey);
});

test('a secondary circle always starts from cycle_default and rejects a pre-existing legacy bridge',async()=>{
  const {db}=await createDatabase();
  await db.execute(`INSERT INTO circle_memberships (circle_id,user_id,role,status) VALUES (20,1,'member','active')`);
  const context={
    payload:{id:1,sessionHash:'a'.repeat(64)},circleId:20,contextVersion:1,implicit:false,
  };
  await db.batch([
    `CREATE TABLE auth_sessions (session_hash TEXT PRIMARY KEY,user_id INTEGER NOT NULL,created_at INTEGER NOT NULL,expires_at INTEGER NOT NULL,revoked_at INTEGER,UNIQUE(session_hash,user_id))`,
    `CREATE TABLE auth_session_circle_contexts (session_hash TEXT PRIMARY KEY,user_id INTEGER NOT NULL,circle_id INTEGER NOT NULL,context_version INTEGER NOT NULL,updated_at INTEGER NOT NULL,FOREIGN KEY(session_hash,user_id) REFERENCES auth_sessions(session_hash,user_id))`,
    {sql:`INSERT INTO auth_sessions (session_hash,user_id,created_at,expires_at) VALUES (?,?,?,?)`,
      args:[context.payload.sessionHash,1,1,Math.floor(Date.now()/1000)+3600]},
    {sql:`INSERT INTO auth_session_circle_contexts (session_hash,user_id,circle_id,context_version,updated_at) VALUES (?,?,?,?,?)`,
      args:[context.payload.sessionHash,1,20,1,1]},
  ],'write');
  const secondary=await getAvailabilityState(db,{userId:1,now:FRIDAY,circleContext:context});
  assert.equal(secondary.source,'cycle_default');
  assert.equal(secondary.isAvailable,true,'account-global legacy false must not enter a secondary circle');

  await db.execute(`UPDATE pairing_cycles SET default_source='legacy_bridge' WHERE scope_key='circle:20'`);
  await assert.rejects(getAvailabilityState(db,{
    userId:1,now:FRIDAY,circleContext:context,
  }),expectCode('AVAILABILITY_INTEGRITY'));
});

test('an out-of-order adjacent bridge stays stable and later cycles use defaults',async()=>{
  const {db}=await createDatabase();
  const scope={kind:'circle',circleId:10};
  const upcoming=resolvePairingCycle({now:FRIDAY,state:'upcoming'});
  const current=resolvePairingCycle({now:FRIDAY,state:'current'});

  const touchedFirst=await materializeAvailabilityCycle(db,{scope,cycle:upcoming});
  assert.equal(touchedFirst.defaultSource,'legacy_bridge');
  const before=await applyCycleAvailability(db,{
    scope,cycle:upcoming,accounts:[{id:1,is_available:0}],
  });
  assert.equal(before[0].isAvailable,false);
  const earlier=await materializeAvailabilityCycle(db,{scope,cycle:current});
  assert.equal(earlier.defaultSource,'legacy_bridge');
  const touchedAgain=await materializeAvailabilityCycle(db,{scope,cycle:upcoming});
  assert.equal(touchedAgain.defaultSource,'legacy_bridge');
  const after=await applyCycleAvailability(db,{
    scope,cycle:upcoming,accounts:[{id:1,is_available:0}],
  });
  assert.equal(after[0].isAvailable,false);
  assert.equal(after[0].availabilityVersion,before[0].availabilityVersion);

  const later=resolvePairingCycle({now:'2026-09-21T12:00:00.000Z',state:'upcoming'});
  const afterBridge=await materializeAvailabilityCycle(db,{scope,cycle:later});
  assert.equal(afterBridge.defaultSource,'cycle_default');

  const bridgeRows=await db.execute({
    sql:`SELECT cycle_key FROM pairing_cycles
      WHERE scope_key=? AND default_source='legacy_bridge' ORDER BY starts_at`,
    args:['circle:10'],
  });
  assert.deepEqual([...bridgeRows.rows].map(row=>String(row.cycle_key)),[
    earlier.cycleKey,touchedFirst.cycleKey,
  ]);
});

test('CAS updates persist across clients and stale versions fail with the winning state',async()=>{
  const fixture=await createDatabase();
  const initial=await getAvailabilityState(fixture.db,{userId:1,now:FRIDAY});
  const body={cycle_key:initial.cycleKey,expected_version:0,is_available:true};
  const updated=await updateAvailability(fixture.db,{userId:1,body,now:FRIDAY});
  assert.equal(updated.isAvailable,true);
  assert.equal(updated.version,1);
  assert.equal(updated.source,'user');
  assert.equal((await fixture.db.execute(`SELECT is_available FROM auth_accounts WHERE id=1`)).rows[0].is_available,0,
    'the timeless legacy bridge input must remain frozen');

  await fixture.close();
  const reopened=createClient({url:fixture.url});
  cleanup.push(()=>reopened.close());
  const persisted=await getAvailabilityState(reopened,{userId:1,now:FRIDAY});
  assert.equal(persisted.isAvailable,true);
  assert.equal(persisted.version,1);
  await assert.rejects(
    updateAvailability(reopened,{userId:1,body:{...body,is_available:false},now:FRIDAY}),
    error=>expectCode('AVAILABILITY_STALE')(error)&&error.details.state.version===1,
  );
});

test('concurrent file clients allow one CAS winner and reject the stale writer',async()=>{
  const fixture=await createDatabase();
  const initial=await getAvailabilityState(fixture.db,{userId:1,now:FRIDAY});
  await fixture.close();
  const first=createClient({url:fixture.url});
  const second=createClient({url:fixture.url});
  cleanup.push(()=>first.close(),()=>second.close());
  const results=await Promise.allSettled([
    updateAvailability(first,{userId:1,body:{cycle_key:initial.cycleKey,expected_version:0,is_available:true},now:FRIDAY}),
    updateAvailability(second,{userId:1,body:{cycle_key:initial.cycleKey,expected_version:0,is_available:false},now:FRIDAY}),
  ]);
  assert.equal(results.filter(result=>result.status==='fulfilled').length,1);
  const rejected=results.find(result=>result.status==='rejected');
  assert.equal(rejected.reason.code,'AVAILABILITY_STALE');
  const stored=await first.execute(`SELECT version,is_available FROM pairing_cycle_availability`);
  assert.equal(Number(stored.rows[0].version),1);
  assert.equal(Number(stored.rows[0].is_available)===1,results.find(result=>result.status==='fulfilled').value.isAvailable);
});

test('editing a later cycle cannot retroactively alter the legacy bridge cycle',async()=>{
  const {db}=await createDatabase();
  await db.execute(`UPDATE auth_accounts SET is_available=1 WHERE id=1`);
  const bridge=await getAvailabilityState(db,{userId:1,now:FRIDAY});
  assert.equal(bridge.source,'legacy_bridge');
  assert.equal(bridge.isAvailable,true);

  const later=await getAvailabilityState(db,{userId:1,now:'2026-09-21T12:00:00.000Z'});
  assert.equal(later.source,'cycle_default');
  await updateAvailability(db,{
    userId:1,now:'2026-09-21T12:00:00.000Z',
    body:{cycle_key:later.cycleKey,expected_version:0,is_available:false},
  });

  const reread=await getAvailabilityState(db,{userId:1,now:FRIDAY});
  assert.equal(reread.cycleKey,bridge.cycleKey);
  assert.equal(reread.isAvailable,true);
  assert.equal(reread.source,'legacy_bridge');
  assert.equal((await db.execute(`SELECT is_available FROM auth_accounts WHERE id=1`)).rows[0].is_available,1);
});

test('old-cycle writes fail closed at the exact cutoff and unrelated keys report cycle change',async()=>{
  const {db}=await createDatabase();
  const before=await getAvailabilityState(db,{userId:1,now:'2026-09-20T06:59:59.999Z'});
  let cutoffError;
  try{
    await updateAvailability(db,{
      userId:1,now:SUNDAY_BOUNDARY,
      body:{cycle_key:before.cycleKey,expected_version:before.version,is_available:true},
    });
  }catch(error){ cutoffError=error; }
  assert.equal(cutoffError?.code,'AVAILABILITY_CUTOFF_CLOSED');
  const cutoffResponse=availabilityFailure(cutoffError);
  assert.equal(cutoffResponse.status,409);
  assert.equal(cutoffResponse.body.availability.cycle.state,'upcoming');
  assert.equal(typeof cutoffResponse.body.availability.isAvailable,'boolean');
  assert.equal(Number.isSafeInteger(cutoffResponse.body.availability.version),true);

  let changedError;
  try{
    await updateAvailability(db,{
      userId:1,now:SUNDAY_BOUNDARY,
      body:{cycle_key:'f'.repeat(64),expected_version:0,is_available:true},
    });
  }catch(error){ changedError=error; }
  assert.equal(changedError?.code,'AVAILABILITY_CYCLE_CHANGED');
  assert.equal(availabilityFailure(changedError).body.availability.cycle.state,'upcoming');
});

test('the CAS statement consults database time and reclassifies a request that spans cutoff',async()=>{
  const {db}=await createDatabase();
  const beforeInstant='2026-09-20T06:59:59.999Z';
  const afterInstant='2026-09-20T07:00:00.000Z';
  const initial=await getAvailabilityState(db,{userId:1,now:beforeInstant});
  let guardedSql='';
  const wrapper={
    execute:value=>db.execute(value),
    batch:(values,mode)=>db.batch(values,mode),
    async transaction(mode){
      const transaction=await db.transaction(mode);
      return {
        async execute(value){
          const sql=typeof value==='string'?value:String(value?.sql||'');
          if(sql.includes('INSERT INTO pairing_cycle_availability')){
            guardedSql=sql;
            return {rows:[],rowsAffected:0};
          }
          if(sql.includes("strftime('%Y-%m-%dT%H:%M:%fZ','now')")){
            return {rows:[{now_utc:afterInstant}],rowsAffected:0};
          }
          return transaction.execute(value);
        },
        batch:(values,batchMode)=>transaction.batch(values,batchMode),
        commit:()=>transaction.commit(),
        rollback:()=>transaction.rollback(),
        close:()=>transaction.close?.(),
      };
    },
  };
  let error;
  try{
    await updateAvailability(wrapper,{
      userId:1,now:beforeInstant,
      body:{cycle_key:initial.cycleKey,expected_version:0,is_available:true},
    });
  }catch(value){ error=value; }
  assert.equal(error?.code,'AVAILABILITY_CUTOFF_CLOSED');
  assert.match(guardedSql,/strftime\('%s','now'\)/);
  const response=availabilityFailure(error);
  assert.equal(response.body.availability.cycle.state,'upcoming');
  assert.notEqual(response.body.availability.cycleKey,initial.cycleKey);
  assert.equal((await db.execute(`SELECT COUNT(*) AS count FROM pairing_cycle_availability`)).rows[0].count,0);
});

test('pairing availability is cycle- and scope-isolated and consults legacy only for the bridge cycle',async()=>{
  const {db}=await createDatabase();
  const circleScope={kind:'circle',circleId:10};
  const localScope={kind:'local'};
  const firstCycle=resolvePairingCycle({now:SUNDAY_BOUNDARY,state:'current'});
  const bridge=await applyCycleAvailability(db,{
    scope:circleScope,cycle:firstCycle,
    accounts:[{id:1,is_available:0,name:'One'},{id:2,is_available:1,name:'Two'}],
  });
  assert.deepEqual(bridge.map(item=>[item.id,item.isAvailable,item.availabilitySource]),[
    [1,false,'legacy_bridge'],[2,true,'legacy_bridge'],
  ]);

  const localCycle=await materializeAvailabilityCycle(db,{scope:localScope,cycle:firstCycle});
  await updateAvailability(db,{
    userId:1,localRuntime:true,now:FRIDAY,
    body:{cycle_key:localCycle.cycleKey,expected_version:0,is_available:true},
  });
  const nextCycle=resolvePairingCycle({now:'2026-09-27T07:00:00.000Z',state:'current'});
  const defaults=await applyCycleAvailability(db,{
    scope:circleScope,cycle:nextCycle,
    accounts:[{id:1,is_available:0},{id:2,is_available:0}],
  });
  assert.deepEqual(defaults.map(item=>[item.isAvailable,item.availabilitySource]),[
    [true,'cycle_default'],[true,'cycle_default'],
  ]);
  const local=await applyCycleAvailability(db,{
    scope:localScope,cycle:firstCycle,accounts:[{id:1,is_available:0}],
  });
  assert.equal(local[0].availabilitySource,'user');
  assert.equal(local[0].isAvailable,true);
  assert.equal(bridge[0].isAvailable,false,'the local decision must not leak into the circle scope');
});

test('conflicting decisions for the same cycle remain isolated between circles',async()=>{
  const {db}=await createDatabase();
  const cycle=resolveEditableAvailabilityCycle({now:FRIDAY});
  const first=await materializeAvailabilityCycle(db,{scope:{kind:'circle',circleId:10},cycle});
  const second=await materializeAvailabilityCycle(db,{scope:{kind:'circle',circleId:20},cycle});
  assert.notEqual(first.cycleKey,second.cycleKey);
  await db.batch([{
    sql:`INSERT INTO pairing_cycle_availability
      (scope_key,cycle_key,user_id,is_available,version,decision_source)
      VALUES (?,?,?,?,1,'user')`,
    args:['circle:10',first.cycleKey,1,0],
  },{
    sql:`INSERT INTO pairing_cycle_availability
      (scope_key,cycle_key,user_id,is_available,version,decision_source)
      VALUES (?,?,?,?,1,'user')`,
    args:['circle:20',second.cycleKey,1,1],
  }],'write');

  const firstCandidates=await applyCycleAvailability(db,{
    scope:{kind:'circle',circleId:10},cycle,accounts:[{id:1,is_available:1}],
  });
  const secondCandidates=await applyCycleAvailability(db,{
    scope:{kind:'circle',circleId:20},cycle,accounts:[{id:1,is_available:0}],
  });
  assert.equal(firstCandidates[0].isAvailable,false);
  assert.equal(secondCandidates[0].isAvailable,true);
  assert.equal(firstCandidates[0].availabilitySource,'user');
  assert.equal(secondCandidates[0].availabilitySource,'user');
});

test('vetted pre-commit lock conflicts retry while unrelated failures do not',async()=>{
  const {db}=await createDatabase();
  const initial=await getAvailabilityState(db,{userId:1,now:FRIDAY});
  let attempts=0;
  const retrying={
    execute:value=>db.execute(value),
    batch:(values,mode)=>db.batch(values,mode),
    async transaction(mode){
      attempts+=1;
      if(attempts<3){
        const cause=Object.assign(new Error('database is locked'),{code:'SQLITE_BUSY'});
        throw new AvailabilityError('AVAILABILITY_UNAVAILABLE','busy',{cause});
      }
      return db.transaction(mode);
    },
  };
  const updated=await updateAvailability(retrying,{
    userId:1,now:FRIDAY,
    body:{cycle_key:initial.cycleKey,expected_version:0,is_available:true},
  });
  assert.equal(updated.version,1);
  assert.equal(attempts,3);

  attempts=0;
  const failing={...retrying,async transaction(){ attempts+=1; throw new Error('network failed'); }};
  await assert.rejects(updateAvailability(failing,{
    userId:1,now:FRIDAY,
    body:{cycle_key:initial.cycleKey,expected_version:1,is_available:false},
  }),expectCode('AVAILABILITY_UNAVAILABLE'));
  assert.equal(attempts,1);
});

test('ambiguous commit failures are not retried and public projections disclose no account data',async()=>{
  const {db}=await createDatabase();
  let attempts=0;
  const wrapper={
    execute:value=>db.execute(value),
    batch:(values,mode)=>db.batch(values,mode),
    async transaction(mode){
      attempts+=1;
      const transaction=await db.transaction(mode);
      return {
        execute:value=>transaction.execute(value),
        batch:(values,batchMode)=>transaction.batch(values,batchMode),
        rollback:()=>transaction.rollback(),
        close:()=>transaction.close?.(),
        async commit(){
          await transaction.commit();
          throw Object.assign(new Error('database is busy'),{code:'SQLITE_BUSY'});
        },
      };
    },
  };
  const initial=await getAvailabilityState(db,{userId:1,now:FRIDAY});
  await assert.rejects(updateAvailability(wrapper,{
    userId:1,now:FRIDAY,
    body:{cycle_key:initial.cycleKey,expected_version:0,is_available:true},
  }),expectCode('AVAILABILITY_UNAVAILABLE'));
  assert.equal(attempts,1);
  const stored=await db.execute(`SELECT version,is_available FROM pairing_cycle_availability`);
  assert.deepEqual([...stored.rows].map(row=>[Number(row.version),Number(row.is_available)]),[[1,1]]);

  const publicValue=availabilityResponse(await getAvailabilityState(db,{userId:1,now:FRIDAY}));
  assert.doesNotMatch(JSON.stringify(publicValue),/@example\.test|userId|circleId/);
  assert.deepEqual(availabilityFailure(new AvailabilityError('AVAILABILITY_INPUT_INVALID','bad')),{status:400,body:{ok:false,error:'availability_input_invalid'}});
});
