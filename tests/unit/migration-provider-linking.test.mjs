import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {test} from 'node:test';
import {createClient} from '@libsql/client';

import {EXECUTABLE_MIGRATIONS} from '../../db/executable-migrations.js';
import {applyMigrations,inspectMigrationState,MigrationError,prepareMigrationConnection} from '../../db/migration-runner.js';

const NO_RETRY=Object.freeze({maxAttempts:1,baseDelayMs:0,maxDelayMs:0});

function fixture(){
  const directory=mkdtempSync(join(tmpdir(),'randori-provider-linking-migration-'));
  const db=createClient({url:`file:${join(directory,'database.sqlite')}`});
  return {db,close(){ db.close(); rmSync(directory,{recursive:true,force:true}); }};
}

async function apply(db,migrations){
  await prepareMigrationConnection(db);
  const state=await inspectMigrationState(db,{migrations});
  return applyMigrations(db,{expectedStateFingerprint:state.stateFingerprint,migrations,retry:NO_RETRY});
}

test('v9 installs hashed provider-email state and redacted identity audit without changing v8 artifacts',async()=>{
  const {db,close}=fixture();
  try{
    await apply(db,EXECUTABLE_MIGRATIONS.slice(0,8));
    const before=(await db.execute(`SELECT type,name,sql FROM sqlite_schema
      WHERE name IN ('auth_password_resets','auth_recent_proofs') ORDER BY type,name`)).rows;
    const throughV9=EXECUTABLE_MIGRATIONS.slice(0,9);
    const beforeState=await inspectMigrationState(db,{migrations:throughV9});
    const result=await applyMigrations(db,{
      expectedStateFingerprint:beforeState.stateFingerprint,
      migrations:throughV9,
      retry:NO_RETRY,
    });
    assert.deepEqual(result.applied.map(item=>item.version),[9]);
    assert.deepEqual((await db.execute(`PRAGMA table_info('auth_provider_email_state')`)).rows.map(row=>row.name),[
      'issuer','subject','email_hash','hash_key_version','hash_key_fingerprint','observed_at','changed_at',
    ]);
    assert.deepEqual((await db.execute(`PRAGMA table_info('auth_identity_audit_events')`)).rows.map(row=>row.name),[
      'id','user_id','actor_user_id','event_type','provider','outcome','reason_code','created_at',
    ]);
    const indexes=(await db.execute(`SELECT name FROM sqlite_schema WHERE type='index'
      AND name LIKE 'idx_auth_identity_audit_%' ORDER BY name`)).rows.map(row=>row.name);
    assert.deepEqual(indexes,['idx_auth_identity_audit_actor','idx_auth_identity_audit_user']);
    await db.execute(`INSERT INTO auth_accounts
      (id,email,password_hash,display_name,color,google_sub)
      VALUES (1,'member@example.test','!oauth:test','Member','#123456','stable-subject')`);
    await db.execute(`INSERT INTO auth_provider_identities (issuer,subject,user_id)
      VALUES ('https://accounts.google.com','stable-subject',1)`);
    await assert.rejects(db.execute(`INSERT INTO auth_provider_email_state
      (issuer,subject,email_hash,hash_key_version,hash_key_fingerprint,observed_at)
      VALUES ('https://accounts.google.com','stable-subject','${'a'.repeat(64)}',0,'${'b'.repeat(64)}',1800000000)`));
    assert.deepEqual((await db.execute(`SELECT type,name,sql FROM sqlite_schema
      WHERE name IN ('auth_password_resets','auth_recent_proofs') ORDER BY type,name`)).rows,before);
  }finally{ close(); }
});

test('a failed v9 schema change rolls back its tables, indexes, and ledger row',async()=>{
  const {db,close}=fixture();
  try{
    await apply(db,EXECUTABLE_MIGRATIONS.slice(0,8));
    const before=await inspectMigrationState(db);
    const wrapped={
      execute:statement=>db.execute(statement),
      async transaction(mode){
        const transaction=await db.transaction(mode);
        return {
          execute:async statement=>{
            const result=await transaction.execute(statement);
            if(String(statement?.sql||statement).startsWith('CREATE INDEX IF NOT EXISTS idx_auth_identity_audit_actor')){
              throw new Error('forced identity audit schema failure');
            }
            return result;
          },
          commit:()=>transaction.commit(),rollback:()=>transaction.rollback(),close:()=>transaction.close(),
        };
      },
    };
    await assert.rejects(applyMigrations(wrapped,{expectedStateFingerprint:before.stateFingerprint,retry:NO_RETRY}),
      error=>error instanceof MigrationError&&error.code==='MIGRATION_FAILED');
    const objects=await db.execute(`SELECT name FROM sqlite_schema WHERE name IN
      ('auth_provider_email_state','auth_identity_audit_events','idx_auth_identity_audit_user',
       'idx_auth_identity_audit_actor')`);
    assert.deepEqual(objects.rows,[]);
    assert.deepEqual((await db.execute('SELECT version FROM schema_migrations ORDER BY version')).rows
      .map(row=>Number(row.version)),[1,2,3,4,5,6,7,8]);
  }finally{ close(); }
});
