import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createClient } from '@libsql/client';

import { EXECUTABLE_MIGRATIONS } from '../../db/executable-migrations.js';
import { inspectSchema } from '../../db/schema-inspector.js';
import { SCHEMA_MANIFEST } from '../../db/schema-manifest.js';
import {
  MigrationError,
  adoptMigrations,
  applyMigrations,
  inspectMigrationState,
  isRetryableMigrationConflict,
  prepareMigrationConnection,
  publicMigrationError,
  withMigrationRetry,
} from '../../db/migration-runner.js';

const fastRetry=Object.freeze({maxAttempts:4,baseDelayMs:0,maxDelayMs:0});

function temporaryDatabase(clientCount=1){
  const directory=mkdtempSync(join(tmpdir(),'randori-runner-'));
  const url=`file:${join(directory,'test.sqlite')}`;
  const clients=Array.from({length:clientCount},()=>createClient({url}));
  return {
    db:clients[0],clients,
    close(){ clients.forEach(client=>client.close()); rmSync(directory,{recursive:true,force:true}); },
  };
}

async function state(db,options){
  await prepareMigrationConnection(db);
  return inspectMigrationState(db,options);
}

async function installUnmanagedCurrentSchema(db,{seedRollout=true}={}){
  await prepareMigrationConnection(db);
  for(const migration of EXECUTABLE_MIGRATIONS){
    for(const operation of migration.operations){
      if(operation.operation==='ensure-row'&&!seedRollout) continue;
      await db.execute(operation.sql);
    }
  }
}

test('fresh apply is transactional, seeds an open rollout, and repeats as a no-op',async()=>{
  const fixture=temporaryDatabase();
  try{
    const before=await state(fixture.db);
    assert.equal(before.classification,'fresh');
    assert.equal(before.schemaExact,true);
    const result=await applyMigrations(fixture.db,{
      expectedStateFingerprint:before.stateFingerprint,
      retry:fastRetry,
    });
    assert.equal(result.fromVersion,0);
    assert.equal(result.toVersion,5);
    assert.deepEqual(result.applied.map(item=>item.version),[1,2,3,4,5]);
    const rollout=await fixture.db.execute('SELECT id,registrations_closed FROM circle_membership_rollout');
    assert.deepEqual(rollout.rows.map(row=>[Number(row.id),Number(row.registrations_closed)]),[[1,0]]);
    const ledger=await fixture.db.execute('SELECT version,disposition FROM schema_migrations ORDER BY version');
    assert.deepEqual(ledger.rows.map(row=>[Number(row.version),row.disposition]),[[1,'applied'],[2,'applied'],[3,'applied'],[4,'applied'],[5,'applied']]);
    const generalInspection=await inspectSchema(fixture.db,{manifest:SCHEMA_MANIFEST});
    assert.equal(generalInspection.warnings.length,0);
    assert.deepEqual(generalInspection.tolerated.legacyTables,['schema_migrations']);

    const repeatState=await state(fixture.db);
    const repeat=await applyMigrations(fixture.db,{
      expectedStateFingerprint:repeatState.stateFingerprint,
      retry:fastRetry,
    });
    assert.deepEqual(repeat.applied,[]);
    assert.equal(repeat.fromVersion,5);
    assert.equal(repeat.toVersion,5);
  }finally{ fixture.close(); }
});

test('a valid managed v1 database resumes through only the pending migrations',async()=>{
  const fixture=temporaryDatabase();
  const firstMigration=EXECUTABLE_MIGRATIONS.slice(0,1);
  try{
    const fresh=await state(fixture.db,{migrations:firstMigration});
    const baseline=await applyMigrations(fixture.db,{
      expectedStateFingerprint:fresh.stateFingerprint,
      migrations:firstMigration,
      retry:fastRetry,
    });
    assert.deepEqual(baseline.applied.map(item=>item.version),[1]);

    const resumable=await state(fixture.db);
    assert.equal(resumable.classification,'managed');
    assert.equal(resumable.currentVersion,1);
    assert.equal(resumable.ready,true);
    const resumed=await applyMigrations(fixture.db,{
      expectedStateFingerprint:resumable.stateFingerprint,
      retry:fastRetry,
    });
    assert.equal(resumed.fromVersion,1);
    assert.equal(resumed.toVersion,5);
    assert.deepEqual(resumed.applied.map(item=>item.version),[2,3,4,5]);
    const ledger=await fixture.db.execute('SELECT version FROM schema_migrations ORDER BY version');
    assert.deepEqual(ledger.rows.map(row=>Number(row.version)),[1,2,3,4,5]);
  }finally{ fixture.close(); }
});

test('a state fingerprint authorizes only the exact inspected migration set',async()=>{
  const fixture=temporaryDatabase();
  try{
    const prefix=await state(fixture.db,{migrations:EXECUTABLE_MIGRATIONS.slice(0,1)});
    const current=await state(fixture.db);
    assert.notEqual(prefix.stateFingerprint,current.stateFingerprint);
    await assert.rejects(
      applyMigrations(fixture.db,{
        expectedStateFingerprint:prefix.stateFingerprint,
        retry:fastRetry,
      }),
      error=>error instanceof MigrationError&&error.code==='MIGRATION_STATE_CHANGED',
    );
    const objects=await fixture.db.execute(`SELECT name FROM sqlite_schema
      WHERE name NOT LIKE 'sqlite_%' ORDER BY name`);
    assert.deepEqual(objects.rows,[]);
  }finally{ fixture.close(); }
});

test('apply refuses unmanaged and stale planned state without creating a ledger',async()=>{
  const fixture=temporaryDatabase();
  try{
    const fresh=await state(fixture.db);
    await fixture.db.execute('CREATE TABLE unmanaged_records (id INTEGER PRIMARY KEY)');
    await assert.rejects(
      applyMigrations(fixture.db,{expectedStateFingerprint:fresh.stateFingerprint,retry:fastRetry}),
      error=>error instanceof MigrationError&&error.code==='MIGRATION_STATE_CHANGED',
    );
    const unmanaged=await state(fixture.db);
    assert.equal(unmanaged.classification,'unmanaged');
    await assert.rejects(
      applyMigrations(fixture.db,{expectedStateFingerprint:unmanaged.stateFingerprint,retry:fastRetry}),
      error=>error instanceof MigrationError&&error.code==='MIGRATION_UNMANAGED',
    );
    const ledger=await fixture.db.execute("SELECT name FROM sqlite_schema WHERE type='table' AND name='schema_migrations'");
    assert.equal(ledger.rows.length,0);
  }finally{ fixture.close(); }
});

test('exact open schema can be explicitly adopted and adoption is auditable',async()=>{
  const fixture=temporaryDatabase();
  try{
    await installUnmanagedCurrentSchema(fixture.db);
    const before=await state(fixture.db);
    assert.equal(before.classification,'unmanaged');
    assert.equal(before.schemaExact,true);
    assert.equal(before.adoption.eligible,true);
    assert.equal(before.adoption.membership.registrationState,'open');
    const adopted=await adoptMigrations(fixture.db,{
      expectedStateFingerprint:before.stateFingerprint,
      retry:fastRetry,
    });
    assert.equal(adopted.toVersion,5);
    const rows=await fixture.db.execute('SELECT version,execution_ms,disposition FROM schema_migrations ORDER BY version');
    assert.deepEqual(rows.rows.map(row=>[Number(row.version),Number(row.execution_ms),row.disposition]),[
      [1,0,'adopted'],[2,0,'adopted'],[3,0,'adopted'],[4,0,'adopted'],[5,0,'adopted'],
    ]);
    const after=await state(fixture.db);
    assert.equal(after.classification,'managed');
    assert.equal(after.schemaExact,true);
  }finally{ fixture.close(); }
});

test('a v1 migration prefix can inspect and adopt without membership tables',async()=>{
  const fixture=temporaryDatabase();
  const migrations=EXECUTABLE_MIGRATIONS.slice(0,1);
  try{
    await prepareMigrationConnection(fixture.db);
    for(const operation of migrations[0].operations) await fixture.db.execute(operation.sql);
    const before=await inspectMigrationState(fixture.db,{migrations});
    assert.equal(before.classification,'unmanaged');
    assert.equal(before.schemaExact,true);
    assert.equal(before.adoption.membership,null);
    assert.equal(before.adoption.eligible,true);
    const adopted=await adoptMigrations(fixture.db,{
      expectedStateFingerprint:before.stateFingerprint,
      migrations,
      retry:fastRetry,
    });
    assert.equal(adopted.toVersion,1);
    assert.equal((await state(fixture.db,{migrations})).ready,true);
  }finally{ fixture.close(); }
});

test('closed rollout adoption preserves the latch and requires complete membership evidence',async()=>{
  const fixture=temporaryDatabase();
  try{
    await installUnmanagedCurrentSchema(fixture.db);
    await fixture.db.execute(`INSERT INTO auth_accounts
      (id,email,password_hash,display_name,color,is_admin,is_demo)
      VALUES (7,'owner@example.test','hash','Owner','#123456',1,0)`);
    await fixture.db.execute(`INSERT INTO circles
      (id,public_id,slug,name,is_primary,created_by) VALUES (4,'circle-public','primary','Circle',1,7)`);
    await fixture.db.execute(`INSERT INTO circle_memberships
      (circle_id,user_id,role,status) VALUES (4,7,'owner','active')`);
    await fixture.db.execute(`INSERT INTO circle_audit_events
      (circle_id,event_type,actor_user_id,subject_user_id,dedupe_key)
      VALUES
        (4,'membership.backfilled',7,7,'membership-backfilled:4:7'),
        (4,'membership.backfill.completed',7,NULL,'primary-membership-backfill:4:v1')`);
    await fixture.db.execute('UPDATE circle_membership_rollout SET registrations_closed=1 WHERE id=1');
    await fixture.db.execute("DELETE FROM circle_audit_events WHERE event_type='membership.backfilled'");
    const incomplete=await state(fixture.db);
    assert.equal(incomplete.adoption.eligible,false);
    assert.ok(incomplete.adoption.blockers.includes('closed_rollout_account_audit_invalid'));
    await fixture.db.execute(`INSERT INTO circle_audit_events
      (circle_id,event_type,actor_user_id,subject_user_id,dedupe_key)
      VALUES (4,'membership.backfilled',7,7,'membership-backfilled:4:7')`);
    const before=await state(fixture.db);
    assert.equal(before.adoption.eligible,true);
    assert.equal(before.adoption.membership.registrationState,'closed');
    await adoptMigrations(fixture.db,{expectedStateFingerprint:before.stateFingerprint,retry:fastRetry});
    const rollout=await fixture.db.execute('SELECT registrations_closed FROM circle_membership_rollout WHERE id=1');
    assert.equal(Number(rollout.rows[0].registrations_closed),1);
  }finally{ fixture.close(); }
});

test('missing or partial rollout evidence blocks adoption without writing a ledger',async()=>{
  const fixture=temporaryDatabase();
  try{
    await installUnmanagedCurrentSchema(fixture.db,{seedRollout:false});
    const before=await state(fixture.db);
    assert.equal(before.adoption.eligible,false);
    assert.ok(before.adoption.blockers.includes('rollout_singleton_invalid'));
    await assert.rejects(
      adoptMigrations(fixture.db,{expectedStateFingerprint:before.stateFingerprint,retry:fastRetry}),
      error=>error instanceof MigrationError&&error.code==='MIGRATION_ADOPTION_BLOCKED',
    );
    assert.equal((await fixture.db.execute("SELECT name FROM sqlite_schema WHERE name='schema_migrations'")).rows.length,0);
  }finally{ fixture.close(); }
});

test('managed v2 databases fail closed when the rollout singleton is missing',async()=>{
  const fixture=temporaryDatabase();
  try{
    const before=await state(fixture.db);
    await applyMigrations(fixture.db,{expectedStateFingerprint:before.stateFingerprint,retry:fastRetry});
    await fixture.db.execute('DELETE FROM circle_membership_rollout WHERE id=1');
    const corrupted=await state(fixture.db);
    assert.equal(corrupted.classification,'managed');
    assert.equal(corrupted.schemaExact,true);
    assert.equal(corrupted.ready,false);
    assert.ok(corrupted.adoption.membership.blockers.includes('rollout_singleton_invalid'));
    await assert.rejects(
      applyMigrations(fixture.db,{expectedStateFingerprint:corrupted.stateFingerprint,retry:fastRetry}),
      error=>error instanceof MigrationError&&error.code==='MIGRATION_SCHEMA_INVALID',
    );
  }finally{ fixture.close(); }
});

test('state fingerprints bind mutable ledger metadata',async()=>{
  const fixture=temporaryDatabase();
  try{
    const before=await state(fixture.db);
    await applyMigrations(fixture.db,{expectedStateFingerprint:before.stateFingerprint,retry:fastRetry});
    const original=await state(fixture.db);
    await fixture.db.execute('UPDATE schema_migrations SET execution_ms=execution_ms+1 WHERE version=1');
    const durationChanged=await state(fixture.db);
    assert.notEqual(durationChanged.stateFingerprint,original.stateFingerprint);
    await fixture.db.execute("UPDATE schema_migrations SET applied_at='2026-09-18 12:34:56' WHERE version=1");
    const timestampChanged=await state(fixture.db);
    assert.notEqual(timestampChanged.stateFingerprint,durationChanged.stateFingerprint);
  }finally{ fixture.close(); }
});

test('a failing next version rolls its schema and ledger row back',async()=>{
  const fixture=temporaryDatabase();
  try{
    const firstState=await state(fixture.db,{migrations:EXECUTABLE_MIGRATIONS.slice(0,1)});
    await applyMigrations(fixture.db,{
      expectedStateFingerprint:firstState.stateFingerprint,
      migrations:EXECUTABLE_MIGRATIONS.slice(0,1),
      retry:fastRetry,
    });
    await fixture.db.execute(`INSERT INTO auth_accounts
      (email,password_hash,display_name,color,google_sub) VALUES
      ('one@example.test','hash','One','#111111','duplicate-subject'),
      ('two@example.test','hash','Two','#222222','duplicate-subject')`);
    const beforeSecond=await state(fixture.db);
    await assert.rejects(
      applyMigrations(fixture.db,{expectedStateFingerprint:beforeSecond.stateFingerprint,retry:fastRetry}),
      error=>error instanceof MigrationError&&error.code==='MIGRATION_FAILED',
    );
    const versions=await fixture.db.execute('SELECT version FROM schema_migrations ORDER BY version');
    assert.deepEqual(versions.rows.map(row=>Number(row.version)),[1]);
    const circles=await fixture.db.execute("SELECT name FROM sqlite_schema WHERE type='table' AND name='circles'");
    assert.equal(circles.rows.length,0);
  }finally{ fixture.close(); }
});

test('retry policy is bounded to trusted database conflict signals',async()=>{
  let attempts=0;
  const result=await withMigrationRetry(async()=>{
    attempts+=1;
    if(attempts<3) throw Object.assign(new Error('opaque provider failure'),{code:'SQLITE_BUSY'});
    return 'ready';
  },{...fastRetry,sleep:async()=>{}});
  assert.equal(result,'ready');
  assert.equal(attempts,3);
  assert.equal(isRetryableMigrationConflict(new Error('write conflict while validating user input')),false);
  assert.equal(isRetryableMigrationConflict(new Error('database is locked')),true);
});

test('an ambiguous commit error is never retried',async()=>{
  const fixture=temporaryDatabase();
  try{
    const planned=await state(fixture.db);
    let transactionCount=0;
    const wrapped={
      execute:statement=>fixture.db.execute(statement),
      transaction:async mode=>{
        transactionCount+=1;
        const transaction=await fixture.db.transaction(mode);
        return {
          execute:statement=>transaction.execute(statement),
          rollback:()=>transaction.rollback(),
          close:()=>transaction.close(),
          commit:async()=>{
            await transaction.commit();
            throw Object.assign(new Error('database is locked'),{code:'SQLITE_BUSY'});
          },
        };
      },
    };
    await assert.rejects(
      applyMigrations(wrapped,{
        expectedStateFingerprint:planned.stateFingerprint,
        retry:{maxAttempts:4,baseDelayMs:0,maxDelayMs:0,sleep:async()=>assert.fail('must not retry commit')},
      }),
      error=>error instanceof MigrationError&&error.code==='MIGRATION_FAILED',
    );
    assert.equal(transactionCount,1);
    const ledger=await fixture.db.execute('SELECT version FROM schema_migrations ORDER BY version');
    assert.deepEqual(ledger.rows.map(row=>Number(row.version)),[1]);
  }finally{ fixture.close(); }
});

test('concurrent callers cannot silently apply from the same stale fingerprint',async()=>{
  const fixture=temporaryDatabase(2);
  try{
    const [first,second]=fixture.clients;
    await prepareMigrationConnection(first);
    await prepareMigrationConnection(second);
    await first.execute('PRAGMA busy_timeout=1000');
    await second.execute('PRAGMA busy_timeout=1000');
    const planned=await inspectMigrationState(first);
    let arrivals=0;
    let release;
    const gate=new Promise(resolve=>{ release=resolve; });
    const wrapped=client=>({
      execute:statement=>client.execute(statement),
      transaction:async mode=>{
        arrivals+=1;
        if(arrivals===2) release();
        await gate;
        return client.transaction(mode);
      },
    });
    const results=await Promise.allSettled([
      applyMigrations(wrapped(first),{
        expectedStateFingerprint:planned.stateFingerprint,
        retry:{maxAttempts:6,baseDelayMs:1,maxDelayMs:5},
      }),
      applyMigrations(wrapped(second),{
        expectedStateFingerprint:planned.stateFingerprint,
        retry:{maxAttempts:6,baseDelayMs:1,maxDelayMs:5},
      }),
    ]);
    assert.equal(results.filter(result=>result.status==='fulfilled').length,1);
    const rejected=results.find(result=>result.status==='rejected');
    assert.equal(rejected.reason.code,'MIGRATION_STATE_CHANGED');
    const final=await state(first);
    assert.equal(final.currentVersion,5);
    assert.equal(final.ready,true);
  }finally{ fixture.close(); }
});

test('public migration errors redact causes and database messages',()=>{
  const error=new MigrationError('MIGRATION_SCHEMA_INVALID','secret database detail',{
    cause:new Error('token=secret'),
    details:{version:2,unsafe:'do not expose'},
  });
  assert.deepEqual(publicMigrationError(error),{
    ok:false,
    error:'MIGRATION_SCHEMA_INVALID',
    message:'Database schema does not match its recorded migration version.',
    details:{version:2},
  });
  assert.deepEqual(publicMigrationError(new Error('private SQL failed')),{
    ok:false,
    error:'MIGRATION_FAILED',
    message:'Database migration failed.',
  });
});
