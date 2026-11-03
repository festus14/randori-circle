import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createClient} from '@libsql/client';
import {EXECUTABLE_MIGRATIONS} from '../../db/executable-migrations.js';
import {MIGRATION_PLANS} from '../../db/migration-plan.js';
import {applyMigrations,inspectMigrationState,prepareMigrationConnection} from '../../db/migration-runner.js';
import {inspectDatabaseReadiness} from '../../api/_health.js';
import {ensureSecondaryWorkspaceReadiness} from '../../api/_workspace-readiness.js';
import {pairingSchemaV6Ready} from '../../api/_pairing-readiness.js';

test('main v24 applies unchanged, then breaking workspace v25 preserves it and passes readiness',async()=>{
  const directory=mkdtempSync(join(tmpdir(),'randori-workspace-v25-'));
  const db=createClient({url:`file:${join(directory,'local.sqlite')}`});
  try{
    await prepareMigrationConnection(db);
    const migrate=async version=>{
      const migrations=EXECUTABLE_MIGRATIONS.slice(0,version);
      const state=await inspectMigrationState(db,{migrations});
      return applyMigrations(db,{migrations,expectedStateFingerprint:state.stateFingerprint,
        retry:{maxAttempts:1,baseDelayMs:0,maxDelayMs:0}});
    };
    assert.equal(MIGRATION_PLANS[23].operationsChecksum,'c9a0d70df41d5a3d5caa846894a27771f066aa29be3f6c758e9ff22f5485cfb9');
    assert.equal(MIGRATION_PLANS[23].checksum,'b94e7c23b91e0fbcc7b7e79ee7d0783865a4c624afe3ecd58772b93391466177');
    assert.equal(EXECUTABLE_MIGRATIONS[23].checksum,'bd19855cc6e4bcdd9fd942c7fc0adee23fb482331ccd1b9668096fe8f52cabdd');
    await migrate(23);
    assert.deepEqual((await migrate(24)).applied.map(item=>item.version),[24]);
    const ledger=(await db.execute('SELECT * FROM schema_migrations WHERE version=24')).rows;
    const schema=(await db.execute("SELECT type,name,sql FROM sqlite_schema WHERE tbl_name='account_deletion_tokens' ORDER BY type,name")).rows;
    assert.equal(await inspectDatabaseReadiness(db),false);
    await assert.rejects(ensureSecondaryWorkspaceReadiness(db),/workspace schema unavailable/);
    assert.deepEqual((await migrate(25)).applied.map(item=>item.version),[25]);
    assert.deepEqual((await db.execute('SELECT * FROM schema_migrations WHERE version=24')).rows,ledger);
    assert.deepEqual((await db.execute("SELECT type,name,sql FROM sqlite_schema WHERE tbl_name='account_deletion_tokens' ORDER BY type,name")).rows,schema);
    assert.equal(await inspectDatabaseReadiness(db),true);
    assert.equal(await pairingSchemaV6Ready(db),true);
    assert.equal(await ensureSecondaryWorkspaceReadiness(db),true);
    assert.deepEqual((await db.execute('PRAGMA foreign_key_check')).rows,[]);
    assert.deepEqual((await migrate(25)).applied,[]);
  }finally{db.close();rmSync(directory,{recursive:true,force:true});}
});
