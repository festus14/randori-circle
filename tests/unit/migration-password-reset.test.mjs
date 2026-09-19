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
  const directory=mkdtempSync(join(tmpdir(),'randori-password-reset-migration-'));
  const db=createClient({url:`file:${join(directory,'database.sqlite')}`});
  return {db,close(){ db.close(); rmSync(directory,{recursive:true,force:true}); }};
}

async function apply(db,migrations){
  await prepareMigrationConnection(db);
  const state=await inspectMigrationState(db,{migrations});
  return applyMigrations(db,{expectedStateFingerprint:state.stateFingerprint,migrations,retry:NO_RETRY});
}

test('v8 installs password reset and recent-auth state without changing v7 artifacts',async()=>{
  const {db,close}=fixture();
  try{
    await apply(db,EXECUTABLE_MIGRATIONS.slice(0,7));
    const before=(await db.execute(`SELECT type,name,sql FROM sqlite_schema
      WHERE name='auth_email_activations' ORDER BY type,name`)).rows;
    const migrations=EXECUTABLE_MIGRATIONS.slice(0,8);
    const beforeState=await inspectMigrationState(db,{migrations});
    const result=await applyMigrations(db,{expectedStateFingerprint:beforeState.stateFingerprint,
      migrations,retry:NO_RETRY});
    assert.deepEqual(result.applied.map(item=>item.version),[8]);
    assert.deepEqual((await db.execute(`PRAGMA table_info('auth_password_resets')`)).rows.map(row=>row.name),[
      'id','user_id','email_hash','token_hash','created_at','expires_at','last_sent_at','send_count','used_at','revoked_at',
    ]);
    assert.deepEqual((await db.execute(`PRAGMA table_info('auth_recent_proofs')`)).rows.map(row=>row.name),[
      'session_hash','user_id','authenticated_at','method',
    ]);
    const indexes=(await db.execute(`SELECT name FROM sqlite_schema WHERE type='index'
      AND name LIKE 'idx_auth_%' ORDER BY name`)).rows.map(row=>row.name);
    assert.ok(indexes.includes('idx_auth_password_resets_token'));
    assert.ok(indexes.includes('idx_auth_password_resets_email'));
    assert.ok(indexes.includes('idx_auth_recent_proofs_user'));
    assert.deepEqual((await db.execute(`SELECT type,name,sql FROM sqlite_schema
      WHERE name='auth_email_activations' ORDER BY type,name`)).rows,before);
  }finally{ close(); }
});

test('a failed v8 schema change rolls back all artifacts and its ledger row',async()=>{
  const {db,close}=fixture();
  try{
    await apply(db,EXECUTABLE_MIGRATIONS.slice(0,7));
    const before=await inspectMigrationState(db);
    const wrapped={
      execute:statement=>db.execute(statement),
      async transaction(mode){
        const transaction=await db.transaction(mode);
        return {
          execute:async statement=>{
            const result=await transaction.execute(statement);
            if(String(statement?.sql||statement).startsWith('CREATE INDEX IF NOT EXISTS idx_auth_password_resets_email')){
              throw new Error('forced password reset schema failure');
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
      ('auth_password_resets','auth_recent_proofs','idx_auth_password_resets_token',
       'idx_auth_password_resets_email','idx_auth_recent_proofs_user')`);
    assert.deepEqual(objects.rows,[]);
    assert.deepEqual((await db.execute('SELECT version FROM schema_migrations ORDER BY version')).rows
      .map(row=>Number(row.version)),[1,2,3,4,5,6,7]);
  }finally{ close(); }
});
