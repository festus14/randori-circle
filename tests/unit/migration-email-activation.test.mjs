import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { createClient } from '@libsql/client';

import { EXECUTABLE_MIGRATIONS } from '../../db/executable-migrations.js';
import { applyMigrations, inspectMigrationState, MigrationError, prepareMigrationConnection } from '../../db/migration-runner.js';

const NO_RETRY=Object.freeze({maxAttempts:1,baseDelayMs:0,maxDelayMs:0});

function fixture(){
  const directory=mkdtempSync(join(tmpdir(),'randori-activation-migration-'));
  const db=createClient({url:`file:${join(directory,'database.sqlite')}`});
  return {db,close(){ db.close(); rmSync(directory,{recursive:true,force:true}); }};
}

async function apply(db,migrations){
  await prepareMigrationConnection(db);
  const state=await inspectMigrationState(db,{migrations});
  return applyMigrations(db,{expectedStateFingerprint:state.stateFingerprint,migrations,retry:NO_RETRY});
}

test('v7 installs constrained activation state and indexes without changing v6 artifacts',async()=>{
  const {db,close}=fixture();
  try{
    await apply(db,EXECUTABLE_MIGRATIONS.slice(0,6));
    const before=(await db.execute(`SELECT type,name,sql FROM sqlite_schema
      WHERE name IN ('outbox_events','outbox_audit_events') ORDER BY type,name`)).rows;
    const beforeState=await inspectMigrationState(db);
    const result=await applyMigrations(db,{expectedStateFingerprint:beforeState.stateFingerprint,retry:NO_RETRY});
    assert.deepEqual(result.applied.map(item=>item.version),[7]);
    const columns=(await db.execute(`PRAGMA table_info('auth_email_activations')`)).rows.map(row=>row.name);
    assert.deepEqual(columns,[
      'id','invitation_id','circle_id','email','email_hash','password_hash','display_name','color',
      'token_hash','created_at','expires_at','last_sent_at','send_count','used_at','revoked_at',
    ]);
    const indexes=(await db.execute(`PRAGMA index_list('auth_email_activations')`)).rows.map(row=>row.name);
    assert.ok(indexes.includes('idx_auth_email_activations_token'));
    assert.ok(indexes.includes('idx_auth_email_activations_email'));
    assert.deepEqual((await db.execute(`SELECT type,name,sql FROM sqlite_schema
      WHERE name IN ('outbox_events','outbox_audit_events') ORDER BY type,name`)).rows,before);
  }finally{ close(); }
});

test('a failed v7 schema change rolls back its table, indexes, and ledger row',async()=>{
  const {db,close}=fixture();
  try{
    await apply(db,EXECUTABLE_MIGRATIONS.slice(0,6));
    const before=await inspectMigrationState(db);
    const wrapped={
      execute:statement=>db.execute(statement),
      async transaction(mode){
        const transaction=await db.transaction(mode);
        return {
          execute:async statement=>{
            const result=await transaction.execute(statement);
            if(String(statement?.sql||statement).startsWith('CREATE INDEX IF NOT EXISTS idx_auth_email_activations_email')){
              throw new Error('forced activation schema failure');
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
    const objects=await db.execute(`SELECT name FROM sqlite_schema
      WHERE name IN ('auth_email_activations','idx_auth_email_activations_token','idx_auth_email_activations_email')`);
    assert.deepEqual(objects.rows,[]);
    assert.deepEqual((await db.execute('SELECT version FROM schema_migrations ORDER BY version')).rows.map(row=>Number(row.version)),[1,2,3,4,5,6]);
  }finally{ close(); }
});
