import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createClient } from '@libsql/client';

import { EXECUTABLE_MIGRATIONS } from '../../db/executable-migrations.js';
import {
  MigrationError,
  adoptMigrations,
  applyMigrations,
  inspectMigrationState,
  prepareMigrationConnection,
} from '../../db/migration-runner.js';

const NO_RETRY=Object.freeze({maxAttempts:1,baseDelayMs:0,maxDelayMs:0});
const RETENTION_MIGRATION=EXECUTABLE_MIGRATIONS[10];

function temporaryDatabase(){
  const directory=mkdtempSync(join(tmpdir(),'randori-retention-migration-'));
  const db=createClient({url:`file:${join(directory,'test.sqlite')}`});
  return {db,close(){ db.close(); rmSync(directory,{recursive:true,force:true}); }};
}

async function apply(db,migrations=EXECUTABLE_MIGRATIONS){
  await prepareMigrationConnection(db);
  const before=await inspectMigrationState(db,{migrations});
  return applyMigrations(db,{expectedStateFingerprint:before.stateFingerprint,migrations,retry:NO_RETRY});
}

async function installUnmanagedSchema(db){
  await prepareMigrationConnection(db);
  for(const migration of EXECUTABLE_MIGRATIONS){
    for(const operation of migration.operations) await db.execute(operation.sql);
  }
}

test('v11 installs only the checksummed retention state, scope, hold, audit, and planner artifacts',async()=>{
  const item=temporaryDatabase();
  try{
    const result=await apply(item.db);
    assert.equal(result.toVersion,11);
    assert.deepEqual(RETENTION_MIGRATION.operations.map(operation=>operation.name),[
      'chat_retention_control','chat_retention_scopes','chat_retention_runs',
      'chat_retention_legal_holds','chat_retention_audit_events',
      'idx_chat_retention_runs_dispatch','idx_chat_retention_scopes_tenant',
      'idx_chat_retention_runs_scope','idx_chat_retention_audit_run','idx_pair_messages_retention',
    ]);
    const index=await item.db.execute(`PRAGMA index_info("idx_pair_messages_retention")`);
    assert.deepEqual(index.rows.map(row=>row.name),[null,'id','week_id','pair_group_id']);
    const control=await item.db.execute(`SELECT COUNT(*) AS count FROM chat_retention_control`);
    assert.equal(Number(control.rows[0].count),0,'migration never enables destructive retention');
  }finally{ item.close(); }
});

test('managed v10 upgrades once and repeated v11 apply is a no-op',async()=>{
  const item=temporaryDatabase();
  try{
    await apply(item.db,EXECUTABLE_MIGRATIONS.slice(0,10));
    const before=await inspectMigrationState(item.db);
    assert.equal(before.currentVersion,10);
    const upgraded=await applyMigrations(item.db,{
      expectedStateFingerprint:before.stateFingerprint,retry:NO_RETRY,
    });
    assert.deepEqual(upgraded.applied.map(entry=>entry.version),[11]);
    const current=await inspectMigrationState(item.db);
    const repeated=await applyMigrations(item.db,{
      expectedStateFingerprint:current.stateFingerprint,retry:NO_RETRY,
    });
    assert.deepEqual(repeated.applied,[]);
    assert.equal(repeated.toVersion,11);
  }finally{ item.close(); }
});

test('v11 drift fails closed and a failed migration rolls back all retention artifacts',async()=>{
  const drift=temporaryDatabase();
  const failure=temporaryDatabase();
  try{
    await apply(drift.db);
    await drift.db.execute(`DROP TABLE chat_retention_audit_events`);
    const state=await inspectMigrationState(drift.db);
    assert.equal(state.ready,false);
    assert.ok(state.schemaStatus.blockers.some(blocker=>
      blocker.code==='missing_table'&&blocker.artifact?.name==='chat_retention_audit_events'));
    await assert.rejects(
      applyMigrations(drift.db,{expectedStateFingerprint:state.stateFingerprint,retry:NO_RETRY}),
      error=>error instanceof MigrationError&&error.code==='MIGRATION_SCHEMA_INVALID',
    );

    await apply(failure.db,EXECUTABLE_MIGRATIONS.slice(0,10));
    const before=await inspectMigrationState(failure.db);
    const wrapped={
      execute:statement=>failure.db.execute(statement),
      async transaction(mode){
        const transaction=await failure.db.transaction(mode);
        return {
          async execute(statement){
            const result=await transaction.execute(statement);
            if(String(statement?.sql||statement).includes('chat_retention_runs')){
              throw new Error('forced v11 failure');
            }
            return result;
          },
          commit:()=>transaction.commit(),rollback:()=>transaction.rollback(),close:()=>transaction.close(),
        };
      },
    };
    await assert.rejects(
      applyMigrations(wrapped,{expectedStateFingerprint:before.stateFingerprint,retry:NO_RETRY}),
      error=>error instanceof MigrationError&&error.code==='MIGRATION_FAILED',
    );
    const artifacts=await failure.db.execute(`SELECT name FROM sqlite_schema
      WHERE name LIKE 'chat_retention_%' OR name='idx_pair_messages_retention'`);
    assert.deepEqual(artifacts.rows,[]);
    const ledger=await failure.db.execute(`SELECT MAX(version) AS version FROM schema_migrations`);
    assert.equal(Number(ledger.rows[0].version),10);
  }finally{ drift.close(); failure.close(); }
});

test('exact unmanaged v11 can be adopted and managed rows survive repeat inspection',async()=>{
  const item=temporaryDatabase();
  try{
    await installUnmanagedSchema(item.db);
    await item.db.execute(`INSERT INTO pair_messages
      (id,week_id,pair_group_id,sender_id,message,created_at)
      VALUES (1,10,20,2,'preserved','2026-01-01T00:00:00.000Z')`);
    const before=await inspectMigrationState(item.db);
    assert.equal(before.classification,'unmanaged');
    assert.equal(before.adoption.eligible,true);
    const result=await adoptMigrations(item.db,{
      expectedStateFingerprint:before.stateFingerprint,retry:NO_RETRY,
    });
    assert.equal(result.toVersion,11);
    assert.deepEqual((await item.db.execute(`SELECT id,message FROM pair_messages`)).rows,
      [{id:1,message:'preserved'}]);
    const current=await inspectMigrationState(item.db);
    assert.equal(current.ready,true);
    assert.equal(current.currentVersion,11);
  }finally{ item.close(); }
});

test('retention planner uses the managed expiry index and avoids a message-table scan',async()=>{
  const item=temporaryDatabase();
  try{
    await apply(item.db);
    const plan=await item.db.execute({sql:`EXPLAIN QUERY PLAN
      SELECT scope.scope_key,scope.circle_id,messages.week_id,messages.pair_group_id
      FROM pair_messages messages
      JOIN chat_retention_scopes scope
        ON scope.week_id=messages.week_id AND scope.pair_group_id=messages.pair_group_id
      WHERE julianday(messages.created_at)<julianday(?)
      ORDER BY julianday(messages.created_at),messages.id LIMIT 1`,args:['2026-01-01T00:00:00.000Z']});
    const details=plan.rows.map(row=>String(row.detail));
    assert.ok(details.some(detail=>detail.includes('idx_pair_messages_retention')),details.join('\n'));
    assert.equal(details.some(detail=>/^SCAN (?:pair_messages|messages)(?:\s|$)/.test(detail)),false,details.join('\n'));
  }finally{ item.close(); }
});
