import assert from 'node:assert/strict';
import { copyFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createClient } from '@libsql/client';

import {
  BACKUP_EVIDENCE_LIMITS,
  BackupEvidenceError,
  collectDatabaseEvidence,
  compareBackupRestoreEvidence,
  publicBackupEvidenceError,
  publicBackupEvidenceResult,
} from '../../db/backup-evidence.js';
import {
  applyMigrations,
  inspectMigrationState,
  prepareMigrationConnection,
} from '../../db/migration-runner.js';
import { EXECUTABLE_MIGRATIONS } from '../../db/executable-migrations.js';
import { SCHEMA_MANIFEST } from '../../db/schema-manifest.js';

const KEY_A=Buffer.from('evidence-key-alpha-32-bytes-value!','utf8');
const KEY_B=Buffer.from('evidence-key-bravo-32-bytes-value!','utf8');
const REPO_COMMIT='0123456789abcdef0123456789abcdef01234567';
const SOURCE_ID='provider-production-database-001';
const RESTORE_ID='provider-disposable-restore-001';
const BACKUP_REF='provider-backup-opaque-001';
const NOW=Date.parse('2026-09-18T12:00:00.000Z');
const PITR='2026-09-18T10:00:00.000Z';
const FAST_RETRY=Object.freeze({maxAttempts:1,baseDelayMs:0,maxDelayMs:0});

function fixture(){
  const directory=mkdtempSync(join(tmpdir(),'randori-evidence-'));
  const path=join(directory,'database.sqlite');
  const open=()=>createClient({url:`file:${path}`,intMode:'bigint'});
  const db=open();
  return {
    directory,path,db,open,
    close(){
      try{ db.close(); }catch{}
      rmSync(directory,{recursive:true,force:true});
    },
  };
}

async function migrate(db,migrations=EXECUTABLE_MIGRATIONS){
  await prepareMigrationConnection(db);
  const before=await inspectMigrationState(db,{migrations});
  await applyMigrations(db,{
    expectedStateFingerprint:before.stateFingerprint,
    migrations,
    retry:FAST_RETRY,
  });
}

async function installUnmanaged(db,migrations){
  await prepareMigrationConnection(db);
  for(const migration of migrations){
    for(const operation of migration.operations) await db.execute(operation.sql);
  }
}

function evidenceOptions(overrides={}){
  return {
    role:'source',
    identity:SOURCE_ID,
    hmacKey:KEY_A,
    backupRef:BACKUP_REF,
    repoCommit:REPO_COMMIT,
    pitrAt:PITR,
    maxSnapshotAgeMs:3*60*60*1000,
    maxEvidenceAgeMs:3*60*60*1000,
    rpoTargetMs:3*60*60*1000,
    rtoTargetMs:15*60*1000,
    clock:()=>Date.parse('2026-09-18T11:45:00.000Z'),
    ...overrides,
  };
}

function restoreOptions(overrides={}){
  return evidenceOptions({
    role:'restore',
    identity:RESTORE_ID,
    clock:()=>NOW,
    restoreStartedAt:'2026-09-18T11:50:00.000Z',
    restoreCompletedAt:'2026-09-18T11:58:00.000Z',
    ...overrides,
  });
}

function comparisonOptions(sourceEvidence,restoredEvidence,overrides={}){
  return {
    sourceEvidence,
    restoredEvidence,
    hmacKey:KEY_A,
    sourceIdentity:SOURCE_ID,
    restoreIdentity:RESTORE_ID,
    backupRef:BACKUP_REF,
    repoCommit:REPO_COMMIT,
    pitrAt:PITR,
    maxSnapshotAgeMs:3*60*60*1000,
    maxEvidenceAgeMs:3*60*60*1000,
    rpoTargetMs:3*60*60*1000,
    rtoTargetMs:15*60*1000,
    clock:()=>NOW,
    ...overrides,
  };
}

function table(evidence,name){
  return evidence.tables.find(item=>item.name===name);
}

async function rejectCode(operation,code){
  await assert.rejects(operation,error=>error instanceof BackupEvidenceError&&error.code===code);
}

function databaseProxy(db,onExecute){
  return {
    async transaction(mode){
      const transaction=await db.transaction(mode);
      return new Proxy(transaction,{
        get(target,property){
          if(property==='execute') return statement=>onExecute(statement,target);
          const value=target[property];
          return typeof value==='function'?value.bind(target):value;
        },
      });
    },
  };
}

test('matching source and isolated restore evidence verifies without exposing identities',async()=>{
  const sourceItem=fixture();
  const restoreItem=fixture();
  let restoredDb;
  try{
    await migrate(sourceItem.db);
    await sourceItem.db.execute({
      sql:`INSERT INTO auth_accounts
        (id,email,password_hash,display_name,color,is_available,is_admin,is_demo)
        VALUES (?,?,?,?,?,?,?,?)`,
      args:[1n,'member@example.test','hash-value','Member','violet',1n,0n,0n],
    });
    const source=await collectDatabaseEvidence(sourceItem.db,evidenceOptions());
    sourceItem.db.close();
    restoreItem.db.close();
    copyFileSync(sourceItem.path,restoreItem.path);
    restoredDb=restoreItem.open();
    const restored=await collectDatabaseEvidence(restoredDb,restoreOptions());
    const result=compareBackupRestoreEvidence(comparisonOptions(source,restored));

    assert.equal(result.ok,true);
    assert.equal(result.kind,'restore-verification');
    assert.equal(result.tableCount,SCHEMA_MANIFEST.tables.length);
    assert.equal(result.totalRows,source.totals.rowCount);
    assert.equal(result.restoreDurationMs,8*60*1000);
    assert.equal(result.rpoMet,true);
    assert.equal(result.rtoMet,true);
    assert.match(result.comparisonDigest,/^[a-f0-9]{64}$/);
    const serialized=JSON.stringify({source,restored,result});
    for(const secret of [SOURCE_ID,RESTORE_ID,BACKUP_REF,KEY_A.toString('utf8'),'member@example.test','hash-value']){
      assert.equal(serialized.includes(secret),false);
    }
  }finally{
    try{ restoredDb?.close(); }catch{}
    sourceItem.close();
    restoreItem.close();
  }
});

test('a migration prefix can be verified before the isolated restore advances to current',async()=>{
  const sourceItem=fixture();
  const restoreItem=fixture();
  let restoredDb;
  try{
    const prefix=EXECUTABLE_MIGRATIONS.slice(0,2);
    await migrate(sourceItem.db,prefix);
    await sourceItem.db.execute({
      sql:'INSERT INTO auth_rate_limits (key,attempts,expires_at) VALUES (?,?,?)',
      args:['pre-migration-data',2n,9007199254740993n],
    });
    const source=await collectDatabaseEvidence(sourceItem.db,evidenceOptions({migrations:prefix}));
    sourceItem.db.close();
    restoreItem.db.close();
    copyFileSync(sourceItem.path,restoreItem.path);
    restoredDb=restoreItem.open();
    const restoredBefore=await collectDatabaseEvidence(restoredDb,restoreOptions({migrations:prefix}));
    const preflight=compareBackupRestoreEvidence(comparisonOptions(source,restoredBefore));
    assert.equal(preflight.ok,true);
    assert.equal(source.migration.currentVersion,2);
    assert.equal(source.migration.applicationLatestVersion,5);

    const pending=await inspectMigrationState(restoredDb);
    await applyMigrations(restoredDb,{
      expectedStateFingerprint:pending.stateFingerprint,
      retry:FAST_RETRY,
    });
    const restoredAfter=await collectDatabaseEvidence(restoredDb,restoreOptions());
    assert.equal(restoredAfter.migration.currentVersion,5);
    assert.equal(restoredAfter.schema.manifestChecksum,SCHEMA_MANIFEST.checksum);
    for(const beforeTable of restoredBefore.tables){
      const afterTable=table(restoredAfter,beforeTable.name);
      assert.equal(afterTable.count,beforeTable.count);
      assert.equal(afterTable.digest,beforeTable.digest);
    }
  }finally{
    try{ restoredDb?.close(); }catch{}
    sourceItem.close();
    restoreItem.close();
  }
});

test('an explicitly selected exact unmanaged prefix authenticates ledger absence',async()=>{
  const sourceItem=fixture();
  const restoreItem=fixture();
  let restoredDb;
  try{
    const prefix=EXECUTABLE_MIGRATIONS.slice(0,2);
    await installUnmanaged(sourceItem.db,prefix);
    const ledger=await sourceItem.db.execute(`SELECT name FROM sqlite_schema
      WHERE type='table' AND name='schema_migrations'`);
    assert.equal(ledger.rows.length,0);
    const source=await collectDatabaseEvidence(sourceItem.db,evidenceOptions({
      migrations:prefix,
      expectedLedger:'absent',
    }));
    assert.equal(source.migration.classification,'unmanaged');
    assert.equal(source.migration.selectedVersion,2);
    assert.equal(source.migration.currentVersion,0);
    assert.equal(source.migration.ledgerPresent,false);
    assert.equal(source.migration.ledgerRows,0);
    assert.match(source.migration.ledgerDigest,/^[a-f0-9]{64}$/);

    sourceItem.db.close();
    restoreItem.db.close();
    copyFileSync(sourceItem.path,restoreItem.path);
    restoredDb=restoreItem.open();
    const restored=await collectDatabaseEvidence(restoredDb,restoreOptions({
      migrations:prefix,
      expectedLedger:'absent',
    }));
    const result=compareBackupRestoreEvidence(comparisonOptions(source,restored));
    assert.equal(result.ok,true);
    assert.equal(result.tableCount,source.tables.length);
    await restoredDb.execute('CREATE TABLE unmanaged_drift (id INTEGER PRIMARY KEY)');
    await rejectCode(
      collectDatabaseEvidence(restoredDb,restoreOptions({
        migrations:prefix,expectedLedger:'absent',
      })),
      'BACKUP_EVIDENCE_MIGRATION_INVALID',
    );
    await restoredDb.execute('DROP TABLE unmanaged_drift');
    await restoredDb.execute('UPDATE circle_membership_rollout SET registrations_closed=1 WHERE id=1');
    await rejectCode(
      collectDatabaseEvidence(restoredDb,restoreOptions({
        migrations:prefix,expectedLedger:'absent',
      })),
      'BACKUP_EVIDENCE_MIGRATION_INVALID',
    );
  }finally{
    try{ restoredDb?.close(); }catch{}
    sourceItem.close();
    restoreItem.close();
  }
});

test('row count and equal-count row-content mismatches fail closed',async()=>{
  const item=fixture();
  try{
    await migrate(item.db);
    const sourceEmpty=await collectDatabaseEvidence(item.db,evidenceOptions());
    await item.db.execute({
      sql:'INSERT INTO auth_rate_limits (key,attempts,expires_at) VALUES (?,?,?)',
      args:['account:a',1n,2n],
    });
    const restoredWithRow=await collectDatabaseEvidence(item.db,restoreOptions());
    assert.throws(
      ()=>compareBackupRestoreEvidence(comparisonOptions(sourceEmpty,restoredWithRow)),
      error=>error instanceof BackupEvidenceError
        &&error.code==='BACKUP_EVIDENCE_MISMATCH'&&error.details.reason==='row_count',
    );

    const source=await collectDatabaseEvidence(item.db,evidenceOptions());
    await item.db.execute({
      sql:'UPDATE auth_rate_limits SET attempts=? WHERE key=?',
      args:[2n,'account:a'],
    });
    const restored=await collectDatabaseEvidence(item.db,restoreOptions());
    assert.equal(table(source,'auth_rate_limits').count,table(restored,'auth_rate_limits').count);
    assert.throws(
      ()=>compareBackupRestoreEvidence(comparisonOptions(source,restored)),
      error=>error instanceof BackupEvidenceError
        &&error.code==='BACKUP_EVIDENCE_MISMATCH'&&error.details.reason==='table_digest',
    );
  }finally{ item.close(); }
});

test('schema drift and incomplete migration state are rejected before evidence is emitted',async()=>{
  const item=fixture();
  try{
    await migrate(item.db);
    await item.db.execute('CREATE TABLE unexpected_restore_data (id INTEGER PRIMARY KEY)');
    await rejectCode(
      collectDatabaseEvidence(item.db,evidenceOptions()),
      'BACKUP_EVIDENCE_MIGRATION_INVALID',
    );
    await item.db.execute('DROP TABLE auth_rate_limits');
    await rejectCode(
      collectDatabaseEvidence(item.db,evidenceOptions()),
      'BACKUP_EVIDENCE_MIGRATION_INVALID',
    );
  }finally{ item.close(); }
});

test('present tolerated legacy tables are digested and cannot be lost silently',async()=>{
  const item=fixture();
  try{
    await migrate(item.db);
    await item.db.execute('CREATE TABLE ai_monthly_usage (month TEXT PRIMARY KEY, calls INTEGER)');
    await item.db.execute({
      sql:'INSERT INTO ai_monthly_usage (month,calls) VALUES (?,?)',
      args:['2026-09',7n],
    });
    const source=await collectDatabaseEvidence(item.db,evidenceOptions());
    assert.equal(source.totals.legacyTableCount,1);
    assert.equal(table(source,'ai_monthly_usage').count,1);
    await item.db.execute('DELETE FROM ai_monthly_usage');
    const restoredChanged=await collectDatabaseEvidence(item.db,restoreOptions());
    assert.throws(
      ()=>compareBackupRestoreEvidence(comparisonOptions(source,restoredChanged)),
      error=>error instanceof BackupEvidenceError
        &&error.code==='BACKUP_EVIDENCE_MISMATCH'&&error.details.reason==='row_count',
    );
    await item.db.execute('DROP TABLE ai_monthly_usage');
    const restoredMissing=await collectDatabaseEvidence(item.db,restoreOptions());
    assert.throws(
      ()=>compareBackupRestoreEvidence(comparisonOptions(source,restoredMissing)),
      error=>error instanceof BackupEvidenceError
        &&error.code==='BACKUP_EVIDENCE_MISMATCH'&&error.details.reason==='schema',
    );
  }finally{ item.close(); }
});

test('AUTOINCREMENT allocator state is keyed and compared even when application rows match',async()=>{
  const item=fixture();
  try{
    await migrate(item.db);
    await item.db.execute({
      sql:'INSERT INTO users (name,color) VALUES (?,?)',
      args:['temporary-user','blue'],
    });
    await item.db.execute('DELETE FROM users');
    const source=await collectDatabaseEvidence(item.db,evidenceOptions());
    await item.db.execute({
      sql:'UPDATE sqlite_sequence SET seq=? WHERE name=?',
      args:[500n,'users'],
    });
    const restored=await collectDatabaseEvidence(item.db,restoreOptions());
    assert.equal(table(source,'users').count,0);
    assert.equal(table(restored,'users').count,0);
    assert.notEqual(source.storage.sequenceDigest,restored.storage.sequenceDigest);
    assert.throws(
      ()=>compareBackupRestoreEvidence(comparisonOptions(source,restored)),
      error=>error instanceof BackupEvidenceError
        &&error.code==='BACKUP_EVIDENCE_MISMATCH'&&error.details.reason==='sequence',
    );
  }finally{ item.close(); }
});

test('foreign-key violations and integrity-check failures are both fail closed',async()=>{
  const foreignKeyItem=fixture();
  try{
    await migrate(foreignKeyItem.db);
    await foreignKeyItem.db.execute('PRAGMA foreign_keys=OFF');
    await foreignKeyItem.db.execute({
      sql:`INSERT INTO pairing_groups
        (id,week_id,user_a_id,user_b_id,is_ai_pair,topic,topic_kind)
        VALUES (?,?,?,?,?,?,?)`,
      args:[1n,999n,1n,2n,0n,'topic','both'],
    });
    await rejectCode(
      collectDatabaseEvidence(foreignKeyItem.db,evidenceOptions()),
      'BACKUP_EVIDENCE_FOREIGN_KEY_FAILED',
    );
  }finally{ foreignKeyItem.close(); }

  const integrityItem=fixture();
  try{
    await migrate(integrityItem.db);
    const proxy={
      async transaction(mode){
        const transaction=await integrityItem.db.transaction(mode);
        return new Proxy(transaction,{
          get(target,property){
            if(property==='execute') return async statement=>{
              const sql=typeof statement==='string'?statement:statement.sql;
              if(sql.startsWith('PRAGMA integrity_check')){
                return {rows:[{integrity_check:'secret raw corruption detail'}]};
              }
              return target.execute(statement);
            };
            const value=target[property];
            return typeof value==='function'?value.bind(target):value;
          },
        });
      },
    };
    let failure;
    try{ await collectDatabaseEvidence(proxy,evidenceOptions()); }catch(error){ failure=error; }
    assert.equal(failure.code,'BACKUP_EVIDENCE_INTEGRITY_FAILED');
    assert.equal(JSON.stringify(publicBackupEvidenceError(failure)).includes('secret raw'),false);
  }finally{ integrityItem.close(); }
});

test('wrong, reused, and improperly sized identity credentials are rejected',async()=>{
  const item=fixture();
  try{
    await migrate(item.db);
    const source=await collectDatabaseEvidence(item.db,evidenceOptions());
    const restored=await collectDatabaseEvidence(item.db,restoreOptions());
    assert.throws(
      ()=>compareBackupRestoreEvidence(comparisonOptions(source,restored,{
        sourceIdentity:'wrong-production-database',
      })),
      error=>error instanceof BackupEvidenceError
        &&error.code==='BACKUP_EVIDENCE_MISMATCH'&&error.details.reason==='identity',
    );
    assert.throws(
      ()=>compareBackupRestoreEvidence(comparisonOptions(source,restored,{
        restoreIdentity:SOURCE_ID,
      })),
      error=>error instanceof BackupEvidenceError
        &&error.code==='BACKUP_EVIDENCE_IDENTITY_INVALID',
    );
    await rejectCode(
      collectDatabaseEvidence(item.db,evidenceOptions({hmacKey:'too-short'})),
      'BACKUP_EVIDENCE_INVALID',
    );
  }finally{ item.close(); }
});

test('wrong backup references and tampered evidence bindings are rejected',async()=>{
  const item=fixture();
  try{
    await migrate(item.db);
    const source=await collectDatabaseEvidence(item.db,evidenceOptions());
    const restored=await collectDatabaseEvidence(item.db,restoreOptions());
    assert.throws(
      ()=>compareBackupRestoreEvidence(comparisonOptions(source,restored,{
        backupRef:'different-opaque-backup-ref',
      })),
      error=>error instanceof BackupEvidenceError
        &&error.code==='BACKUP_EVIDENCE_MISMATCH'&&error.details.reason==='backup_ref',
    );
    const tampered={
      ...restored,
      tables:restored.tables.map((entry,index)=>index===0?{...entry,count:entry.count+1}:entry),
    };
    assert.throws(
      ()=>compareBackupRestoreEvidence(comparisonOptions(source,tampered)),
      error=>error instanceof BackupEvidenceError
        &&error.code==='BACKUP_EVIDENCE_AUTHENTICATION_FAILED',
    );
  }finally{ item.close(); }
});

test('stale snapshots and stale signed evidence are rejected at their boundaries',async()=>{
  const item=fixture();
  try{
    await migrate(item.db);
    await rejectCode(
      collectDatabaseEvidence(item.db,evidenceOptions({maxSnapshotAgeMs:105*60*1000-1})),
      'BACKUP_EVIDENCE_STALE_SNAPSHOT',
    );
    const evidenceMaxAge=3*60*60*1000;
    const source=await collectDatabaseEvidence(item.db,evidenceOptions());
    const restored=await collectDatabaseEvidence(item.db,restoreOptions());
    assert.throws(
      ()=>compareBackupRestoreEvidence(comparisonOptions(source,restored,{
        clock:()=>NOW+evidenceMaxAge+1,
      })),
      error=>error instanceof BackupEvidenceError&&error.code==='BACKUP_EVIDENCE_STALE',
    );
    const atBoundary=compareBackupRestoreEvidence(comparisonOptions(source,restored,{
      clock:()=>NOW+evidenceMaxAge-15*60*1000,
    }));
    assert.equal(atBoundary.ok,true);
  }finally{ item.close(); }
});

test('a comparison cannot succeed when documented RPO or RTO targets are missed',async()=>{
  const item=fixture();
  try{
    await migrate(item.db);
    const sourceRpo=await collectDatabaseEvidence(item.db,evidenceOptions({rpoTargetMs:60*60*1000}));
    const restoreRpo=await collectDatabaseEvidence(item.db,restoreOptions({rpoTargetMs:60*60*1000}));
    assert.throws(
      ()=>compareBackupRestoreEvidence(comparisonOptions(sourceRpo,restoreRpo,{
        rpoTargetMs:60*60*1000,
      })),
      error=>error instanceof BackupEvidenceError
        &&error.code==='BACKUP_EVIDENCE_MISMATCH'&&error.details.reason==='rpo',
    );

    const sourceRto=await collectDatabaseEvidence(item.db,evidenceOptions({rtoTargetMs:60*1000}));
    const restoreRto=await collectDatabaseEvidence(item.db,restoreOptions({rtoTargetMs:60*1000}));
    assert.throws(
      ()=>compareBackupRestoreEvidence(comparisonOptions(sourceRto,restoreRto,{
        rtoTargetMs:60*1000,
      })),
      error=>error instanceof BackupEvidenceError
        &&error.code==='BACKUP_EVIDENCE_MISMATCH'&&error.details.reason==='rto',
    );
  }finally{ item.close(); }
});

test('operator policy pins override matching but lax signed evidence policies',async()=>{
  const item=fixture();
  try{
    await migrate(item.db);
    const lax={
      maxSnapshotAgeMs:6*60*60*1000,
      maxEvidenceAgeMs:6*60*60*1000,
      rpoTargetMs:6*60*60*1000,
      rtoTargetMs:60*60*1000,
    };
    const source=await collectDatabaseEvidence(item.db,evidenceOptions(lax));
    const restored=await collectDatabaseEvidence(item.db,restoreOptions(lax));
    assert.throws(
      ()=>compareBackupRestoreEvidence(comparisonOptions(source,restored)),
      error=>error instanceof BackupEvidenceError
        &&error.code==='BACKUP_EVIDENCE_MISMATCH'&&error.details.reason==='policy',
    );
    const accepted=compareBackupRestoreEvidence(comparisonOptions(source,restored,lax));
    assert.equal(accepted.ok,true);
  }finally{ item.close(); }
});

test('HMAC key separation changes table, schema, identity, and envelope digests',async()=>{
  const item=fixture();
  try{
    await migrate(item.db);
    const first=await collectDatabaseEvidence(item.db,evidenceOptions({hmacKey:KEY_A}));
    const second=await collectDatabaseEvidence(item.db,evidenceOptions({hmacKey:KEY_B}));
    assert.notEqual(first.bindingDigest,second.bindingDigest);
    assert.notEqual(first.bindings.identityDigest,second.bindings.identityDigest);
    assert.notEqual(first.schema.schemaDigest,second.schema.schemaDigest);
    assert.notEqual(first.tables[0].digest,second.tables[0].digest);
  }finally{ item.close(); }
});

test('canonical encoding distinguishes null, text, blob, cell boundaries, and large integers',async()=>{
  const item=fixture();
  try{
    await migrate(item.db);
    await item.db.execute({
      sql:`INSERT INTO app_logs (id,level,source,message,meta_json)
        VALUES (?,?,?,?,?)`,
      args:[41n,'info','ab','c',null],
    });
    await item.db.execute({
      sql:'INSERT INTO auth_rate_limits (key,attempts,expires_at) VALUES (?,?,?)',
      args:['large-integer',1n,9007199254740993n],
    });
    const nullValue=await collectDatabaseEvidence(item.db,evidenceOptions());

    await item.db.execute({
      sql:'UPDATE app_logs SET source=?,message=? WHERE id=?',
      args:['a','bc',41n],
    });
    const differentCellBoundaries=await collectDatabaseEvidence(item.db,evidenceOptions());
    assert.notEqual(
      table(nullValue,'app_logs').digest,
      table(differentCellBoundaries,'app_logs').digest,
    );
    await item.db.execute({
      sql:'UPDATE app_logs SET meta_json=? WHERE id=?',
      args:['null',41n],
    });
    const textValue=await collectDatabaseEvidence(item.db,evidenceOptions());
    await item.db.execute({
      sql:'UPDATE app_logs SET meta_json=? WHERE id=?',
      args:[Buffer.from('null','utf8'),41n],
    });
    const blobValue=await collectDatabaseEvidence(item.db,evidenceOptions());

    await item.db.execute({
      sql:'UPDATE auth_rate_limits SET expires_at=? WHERE key=?',
      args:[9007199254740992n,'large-integer'],
    });
    const adjacentLargeInteger=await collectDatabaseEvidence(item.db,evidenceOptions());

    const digests=[nullValue,textValue,blobValue].map(value=>table(value,'app_logs').digest);
    assert.equal(new Set(digests).size,3);
    assert.equal(table(blobValue,'auth_rate_limits').count,1);
    assert.notEqual(
      table(blobValue,'auth_rate_limits').digest,
      table(adjacentLargeInteger,'auth_rate_limits').digest,
    );
  }finally{ item.close(); }
});

test('evidence is deterministic after closing and reopening the local libSQL database',async()=>{
  const item=fixture();
  let reopened;
  try{
    await migrate(item.db);
    await item.db.execute({
      sql:'INSERT INTO auth_rate_limits (key,attempts,expires_at) VALUES (?,?,?)',
      args:['restart-check',3n,1000n],
    });
    const before=await collectDatabaseEvidence(item.db,evidenceOptions());
    item.db.close();
    reopened=item.open();
    const after=await collectDatabaseEvidence(reopened,evidenceOptions());
    assert.deepEqual(after,before);
  }finally{
    try{ reopened?.close(); }catch{}
    rmSync(item.directory,{recursive:true,force:true});
  }
});

test('public result and error helpers whitelist output and redact raw failures',async()=>{
  const item=fixture();
  try{
    await migrate(item.db);
    const evidence=await collectDatabaseEvidence(item.db,evidenceOptions());
    const publicResult=publicBackupEvidenceResult({
      ...evidence,
      bindings:{...evidence.bindings,token:'nested-secret-token'},
      storage:{...evidence.storage,rawSequence:'nested-sequence-secret'},
      timings:{...evidence.timings,rawError:'nested-raw-error'},
      tables:evidence.tables.map((entry,index)=>index===0
        ?{...entry,rowValue:'nested-row-secret'}:entry),
      databaseUrl:'libsql://sensitive.example',
      token:'super-secret-token',
      identity:SOURCE_ID,
      rows:[{email:'person@example.test'}],
      sql:'SELECT * FROM auth_accounts',
    });
    const serialized=JSON.stringify(publicResult);
    for(const secret of [
      'libsql://sensitive.example','super-secret-token',SOURCE_ID,
      'person@example.test','SELECT * FROM auth_accounts','nested-secret-token',
      'nested-raw-error','nested-row-secret',
      'nested-sequence-secret',
    ]) assert.equal(serialized.includes(secret),false);

    const rawFailure=new Error('libsql://sensitive.example?authToken=super-secret-token');
    const publicFailure=publicBackupEvidenceError(rawFailure);
    assert.deepEqual(publicFailure,{
      ok:false,
      error:'BACKUP_EVIDENCE_FAILED',
      message:'Backup evidence verification failed.',
    });
  }finally{ item.close(); }
});

test('configured row, cell, and duration bounds stop collection safely',async()=>{
  const item=fixture();
  try{
    await migrate(item.db);
    await item.db.execute({
      sql:'INSERT INTO auth_rate_limits (key,attempts,expires_at) VALUES (?,?,?)',
      args:['bounded-row',1n,2n],
    });
    await rejectCode(
      collectDatabaseEvidence(item.db,evidenceOptions({
        limits:{maxRowsPerTable:1,maxTotalRows:1},
      })),
      'BACKUP_EVIDENCE_RESOURCE_LIMIT',
    );
    await rejectCode(
      collectDatabaseEvidence(item.db,evidenceOptions({
        limits:{maxCellBytes:1},
      })),
      'BACKUP_EVIDENCE_RESOURCE_LIMIT',
    );
    let tick=NOW;
    await rejectCode(
      collectDatabaseEvidence(item.db,evidenceOptions({
        clock:()=>{ tick+=2; return tick; },
        limits:{maxDurationMs:1},
      })),
      'BACKUP_EVIDENCE_RESOURCE_LIMIT',
    );
    assert.equal(BACKUP_EVIDENCE_LIMITS.pageSize<=1000,true);
  }finally{ item.close(); }
});

test('oversized cells are rejected by length preflight before their values are fetched',async()=>{
  const item=fixture();
  try{
    await migrate(item.db);
    await item.db.execute({
      sql:'INSERT INTO app_logs (level,source,message) VALUES (?,?,?)',
      args:['info','memory-test','x'.repeat(64)],
    });
    let appLogValuesFetched=false;
    const proxy=databaseProxy(item.db,(statement,transaction)=>{
      const sql=typeof statement==='string'?statement:statement.sql;
      if(sql.includes('FROM "app_logs"')&&sql.includes('__evidence_value_')){
        appLogValuesFetched=true;
      }
      return transaction.execute(statement);
    });
    await rejectCode(
      collectDatabaseEvidence(proxy,evidenceOptions({
        limits:{maxCellBytes:32,maxPageValueBytes:128},
      })),
      'BACKUP_EVIDENCE_RESOURCE_LIMIT',
    );
    assert.equal(appLogValuesFetched,false);
  }finally{ item.close(); }
});

test('value fetch pages are reduced so many near-limit cells stay under the hard page bound',async()=>{
  const item=fixture();
  try{
    await migrate(item.db);
    for(let index=0;index<20;index+=1){
      await item.db.execute({
        sql:'INSERT INTO app_logs (level,source,message) VALUES (?,?,?)',
        args:['info','page-test',String(index).padEnd(64,'x')],
      });
    }
    const valuePageSizes=[];
    const proxy=databaseProxy(item.db,(statement,transaction)=>{
      const sql=typeof statement==='string'?statement:statement.sql;
      if(sql.includes('FROM "app_logs"')&&sql.includes('__evidence_value_')){
        valuePageSizes.push(Number(statement.args[0]));
      }
      return transaction.execute(statement);
    });
    const evidence=await collectDatabaseEvidence(proxy,evidenceOptions({
      limits:{maxCellBytes:64,maxPageValueBytes:128,pageSize:500},
    }));
    assert.equal(table(evidence,'app_logs').count,20);
    assert.equal(valuePageSizes.length>1,true);
    assert.equal(valuePageSizes.every(size=>size===1),true);
  }finally{ item.close(); }
});

test('malformed and numerically oversized preflight lengths fail without fetching values',async()=>{
  const item=fixture();
  try{
    await migrate(item.db);
    await item.db.execute({sql:'INSERT INTO users (name,color) VALUES (?,?)',args:['one','blue']});
    for(const malformed of ['not-a-length',9007199254740993n]){
      let userValuesFetched=false;
      const proxy=databaseProxy(item.db,(statement,transaction)=>{
        const sql=typeof statement==='string'?statement:statement.sql;
        if(sql.includes('FROM "users"')&&sql.includes('__evidence_length_')){
          return {rows:[{__evidence_length_0:malformed}]};
        }
        if(sql.includes('FROM "users"')&&sql.includes('__evidence_value_')){
          userValuesFetched=true;
        }
        return transaction.execute(statement);
      });
      await rejectCode(
        collectDatabaseEvidence(proxy,evidenceOptions()),
        malformed==='not-a-length'
          ?'BACKUP_EVIDENCE_FAILED':'BACKUP_EVIDENCE_RESOURCE_LIMIT',
      );
      assert.equal(userValuesFetched,false);
    }
  }finally{ item.close(); }
});
