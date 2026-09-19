import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createClient } from '@libsql/client';

import { EXECUTABLE_MIGRATIONS } from '../../db/executable-migrations.js';
import {
  MigrationError,
  applyMigrations,
  inspectMigrationState,
  prepareMigrationConnection,
} from '../../db/migration-runner.js';

const NO_RETRY=Object.freeze({maxAttempts:1,baseDelayMs:0,maxDelayMs:0});
const CYCLE_KEY='a'.repeat(64);
const CYCLE=Object.freeze({
  scopeKey:'local',
  circleId:null,
  cycleKey:CYCLE_KEY,
  cycleId:'2026-W39',
  startsAt:'2026-09-20T07:00:00.000Z',
  endsAt:'2026-09-27T07:00:00.000Z',
  cutoffAt:'2026-09-20T07:00:00.000Z',
  timeZone:'Europe/London',
});

function fixture(){
  const directory=mkdtempSync(join(tmpdir(),'randori-availability-migration-'));
  const url=`file:${join(directory,'test.sqlite')}`;
  let db=createClient({url});
  return {
    get db(){ return db; },
    url,
    reopen(){ db.close(); db=createClient({url}); return db; },
    close(){ db.close(); rmSync(directory,{recursive:true,force:true}); },
  };
}

async function apply(db,migrations=EXECUTABLE_MIGRATIONS){
  await prepareMigrationConnection(db);
  const state=await inspectMigrationState(db,{migrations});
  return applyMigrations(db,{expectedStateFingerprint:state.stateFingerprint,migrations,retry:NO_RETRY});
}

async function insertCycle(db,{scopeKey=CYCLE.scopeKey,circleId=CYCLE.circleId,cycleKey=CYCLE.cycleKey,
  cycleId=CYCLE.cycleId,startsAt=CYCLE.startsAt,endsAt=CYCLE.endsAt,cutoffAt=CYCLE.cutoffAt,
  timeZone=CYCLE.timeZone,defaultSource='cycle_default'}={}){
  return db.execute({
    sql:`INSERT INTO pairing_cycles
      (scope_key,circle_id,cycle_key,cycle_id,starts_at,ends_at,cutoff_at,time_zone,default_source)
      VALUES (?,?,?,?,?,?,?,?,?)`,
    args:[scopeKey,circleId,cycleKey,cycleId,startsAt,endsAt,cutoffAt,timeZone,defaultSource],
  });
}

function isConstraint(error){
  return String(error?.code||'').startsWith('SQLITE_CONSTRAINT');
}

test('v3 enforces availability scope, digest, value, version, source, and foreign-key contracts',async()=>{
  const database=fixture();
  try{
    await apply(database.db);
    await database.db.execute(`INSERT INTO auth_accounts
      (id,email,password_hash,display_name,color,is_demo)
      VALUES (7,'member@example.test','hash','Member','#123456',0)`);
    await database.db.execute(`INSERT INTO circles
      (id,public_id,slug,name,is_primary) VALUES (4,'circle-public','primary','Circle',1)`);
    await database.db.execute(`INSERT INTO circle_memberships
      (circle_id,user_id,role,status) VALUES (4,7,'member','active')`);

    await insertCycle(database.db);
    await insertCycle(database.db,{scopeKey:'circle:4',circleId:4,cycleKey:'b'.repeat(64)});
    await database.db.execute({
      sql:`INSERT INTO pairing_cycle_availability
        (scope_key,cycle_key,user_id,is_available,version,decision_source)
        VALUES (?,?,?,?,?,?)`,
      args:['circle:4','b'.repeat(64),7,0,1,'user'],
    });

    for(const operation of [
      ()=>insertCycle(database.db,{scopeKey:'local',circleId:4,cycleKey:'c'.repeat(64)}),
      ()=>insertCycle(database.db,{scopeKey:'circle:4',circleId:null,cycleKey:'d'.repeat(64)}),
      ()=>insertCycle(database.db,{scopeKey:'circle:5',circleId:4,cycleKey:'e'.repeat(64)}),
      ()=>insertCycle(database.db,{cycleKey:'f'.repeat(63)}),
      ()=>insertCycle(database.db,{cycleKey:'A'.repeat(64)}),
      ()=>insertCycle(database.db,{cycleKey:'3'.repeat(64),cycleId:'2026-W00'}),
      ()=>insertCycle(database.db,{cycleKey:'4'.repeat(64),cycleId:'2026-W54'}),
      ()=>insertCycle(database.db,{cycleKey:'5'.repeat(64),startsAt:'not-an-instant'}),
      ()=>insertCycle(database.db,{cycleKey:'6'.repeat(64),endsAt:'2026-99-27T07:00:00.000Z'}),
      ()=>insertCycle(database.db,{cycleKey:'7'.repeat(64),cutoffAt:'2026-09-20T07:00:00Z'}),
      ()=>insertCycle(database.db,{cycleKey:'8'.repeat(64),startsAt:'2026-02-30T07:00:00.000Z'}),
      ()=>insertCycle(database.db,{cycleKey:'1'.repeat(64),defaultSource:'user'}),
      ()=>insertCycle(database.db,{cycleKey:'2'.repeat(64),endsAt:CYCLE.startsAt}),
      ()=>database.db.execute({
        sql:`INSERT INTO pairing_cycle_availability
          (scope_key,cycle_key,user_id,is_available,version,decision_source) VALUES (?,?,?,?,?,?)`,
        args:['local',CYCLE_KEY,7,2,1,'user'],
      }),
      ()=>database.db.execute({
        sql:`INSERT INTO pairing_cycle_availability
          (scope_key,cycle_key,user_id,is_available,version,decision_source) VALUES (?,?,?,?,?,?)`,
        args:['local',CYCLE_KEY,7,1,0,'user'],
      }),
      ()=>database.db.execute({
        sql:`INSERT INTO pairing_cycle_availability
          (scope_key,cycle_key,user_id,is_available,version,decision_source) VALUES (?,?,?,?,?,?)`,
        args:['local',CYCLE_KEY,7,1,1.5,'user'],
      }),
      ()=>database.db.execute({
        sql:`INSERT INTO pairing_cycle_availability
          (scope_key,cycle_key,user_id,is_available,version,decision_source) VALUES (?,?,?,?,?,?)`,
        args:['local',CYCLE_KEY,7,1,1,'operator'],
      }),
      ()=>database.db.execute({
        sql:`INSERT INTO pairing_cycle_availability
          (scope_key,cycle_key,user_id,is_available,version,decision_source) VALUES (?,?,?,?,?,?)`,
        args:['local','9'.repeat(64),7,1,1,'user'],
      }),
      ()=>database.db.execute({
        sql:`INSERT INTO pairing_cycle_availability
          (scope_key,cycle_key,user_id,is_available,version,decision_source) VALUES (?,?,?,?,?,?)`,
        args:['local',CYCLE_KEY,999,1,1,'user'],
      }),
    ]) await assert.rejects(operation,isConstraint);
  }finally{ database.close(); }
});

test('a managed v2 database upgrades through the current schema and persists availability rows',async()=>{
  const database=fixture();
  try{
    const prefix=EXECUTABLE_MIGRATIONS.slice(0,2);
    const baseline=await apply(database.db,prefix);
    assert.deepEqual(baseline.applied.map(item=>item.version),[1,2]);
    await database.db.execute(`INSERT INTO auth_accounts
      (id,email,password_hash,display_name,color,is_demo)
      VALUES (7,'member@example.test','hash','Member','#123456',0)`);
    const before=await inspectMigrationState(database.db);
    assert.equal(before.currentVersion,2);
    assert.equal(before.ready,true);
    const upgraded=await applyMigrations(database.db,{
      expectedStateFingerprint:before.stateFingerprint,
      retry:NO_RETRY,
    });
    assert.deepEqual(upgraded.applied.map(item=>item.version),[3,4,5,6,7,8,9]);
    assert.equal(upgraded.toVersion,9);
    await insertCycle(database.db);
    await database.db.execute({
      sql:`INSERT INTO pairing_cycle_availability
        (scope_key,cycle_key,user_id,is_available,version,decision_source)
        VALUES (?,?,?,?,?,?)`,
      args:['local',CYCLE_KEY,7,0,2,'legacy_bridge'],
    });

    const reopened=database.reopen();
    await prepareMigrationConnection(reopened);
    const state=await inspectMigrationState(reopened);
    assert.equal(state.currentVersion,9);
    assert.equal(state.ready,true);
    const rows=await reopened.execute(`SELECT scope_key,cycle_key,user_id,is_available,version,decision_source
      FROM pairing_cycle_availability`);
    assert.deepEqual(rows.rows.map(row=>({
      scope_key:String(row.scope_key),cycle_key:String(row.cycle_key),user_id:Number(row.user_id),
      is_available:Number(row.is_available),version:Number(row.version),decision_source:String(row.decision_source),
    })),[{
      scope_key:'local',cycle_key:CYCLE_KEY,user_id:7,is_available:0,version:2,
      decision_source:'legacy_bridge',
    }]);
  }finally{ database.close(); }
});

test('a failed v3 migration rolls back both new tables, its index, and its ledger row',async()=>{
  const database=fixture();
  try{
    await apply(database.db,EXECUTABLE_MIGRATIONS.slice(0,2));
    const before=await inspectMigrationState(database.db);
    const wrapped={
      execute:statement=>database.db.execute(statement),
      transaction:async mode=>{
        const transaction=await database.db.transaction(mode);
        return {
          execute:async statement=>{
            const result=await transaction.execute(statement);
            const sql=typeof statement==='string'?statement:statement.sql;
            if(/^CREATE TABLE IF NOT EXISTS pairing_cycle_availability\b/i.test(sql)){
              throw new Error('forced v3 failure after transactional DDL');
            }
            return result;
          },
          commit:()=>transaction.commit(),
          rollback:()=>transaction.rollback(),
          close:()=>transaction.close(),
        };
      },
    };
    await assert.rejects(
      applyMigrations(wrapped,{expectedStateFingerprint:before.stateFingerprint,retry:NO_RETRY}),
      error=>error instanceof MigrationError&&error.code==='MIGRATION_FAILED',
    );
    const objects=await database.db.execute(`SELECT name FROM sqlite_schema
      WHERE name IN ('pairing_cycles','pairing_cycle_availability','idx_pairing_cycle_availability_candidates')
      ORDER BY name`);
    assert.deepEqual(objects.rows,[]);
    const ledger=await database.db.execute('SELECT version FROM schema_migrations ORDER BY version');
    assert.deepEqual(ledger.rows.map(row=>Number(row.version)),[1,2]);
  }finally{ database.close(); }
});

test('v3 index drift makes a managed database non-ready and blocks migration no-op',async()=>{
  const database=fixture();
  try{
    await apply(database.db);
    await database.db.execute('DROP INDEX idx_pairing_cycle_availability_candidates');
    await database.db.execute(`CREATE INDEX idx_pairing_cycle_availability_candidates
      ON pairing_cycle_availability(user_id,is_available)`);
    const drifted=await inspectMigrationState(database.db);
    assert.equal(drifted.currentVersion,9);
    assert.equal(drifted.schemaExact,false);
    assert.equal(drifted.ready,false);
    await assert.rejects(
      applyMigrations(database.db,{expectedStateFingerprint:drifted.stateFingerprint,retry:NO_RETRY}),
      error=>error instanceof MigrationError&&error.code==='MIGRATION_SCHEMA_INVALID',
    );
  }finally{ database.close(); }
});
