import assert from 'node:assert/strict';
import { copyFileSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createClient } from '@libsql/client';

import { EXECUTABLE_MIGRATIONS, LATEST_MIGRATION_VERSION } from '../../db/executable-migrations.js';
import { applyMigrations, inspectMigrationState } from '../../db/migration-runner.js';
import { TursoPlatformError } from '../../db/turso-platform.js';
import {
  RehearsalError,
  main,
  publicRehearsalError,
  readonlySourceClient,
  runBackupRestoreRehearsal,
  verifyPostMigrationPreservation,
} from '../../scripts/turso-backup-restore-rehearsal.mjs';

const SOURCE_ID='11111111-1111-4111-8111-111111111111';
const RESTORE_ID='22222222-2222-4222-8222-222222222222';
const COMMIT='0123456789abcdef0123456789abcdef01234567';
const HMAC_KEY=Buffer.from('rehearsal-evidence-key-32-bytes!!','utf8');
const NOW=Date.parse('2026-09-18T12:00:00.000Z');
const FAST_RETRY=Object.freeze({maxAttempts:1,baseDelayMs:0,maxDelayMs:0});

function fixture(){
  const directory=mkdtempSync(join(tmpdir(),'randori-rehearsal-'));
  const sourcePath=join(directory,'source.db');
  const restorePath=join(directory,'restore.db');
  return {
    directory,sourcePath,restorePath,
    close(){ rmSync(directory,{recursive:true,force:true}); },
  };
}

async function installManaged(path,version=2){
  const db=createClient({url:`file:${path}`,intMode:'bigint'});
  const migrations=EXECUTABLE_MIGRATIONS.slice(0,version);
  try{
    const state=await inspectMigrationState(db,{migrations});
    await applyMigrations(db,{
      expectedStateFingerprint:state.stateFingerprint,migrations,retry:FAST_RETRY,
    });
    await db.execute({
      sql:'INSERT INTO auth_rate_limits (key,attempts,expires_at) VALUES (?,?,?)',
      args:['preserved-value',2n,123456789n],
    });
  }finally{ db.close(); }
}

async function installUnmanaged(path,version=2){
  const db=createClient({url:`file:${path}`,intMode:'bigint'});
  try{
    for(const migration of EXECUTABLE_MIGRATIONS.slice(0,version)){
      for(const operation of migration.operations) await db.execute(operation.sql);
    }
    await db.execute({
      sql:'INSERT INTO auth_rate_limits (key,attempts,expires_at) VALUES (?,?,?)',
      args:['preserved-unmanaged-value',3n,987654321n],
    });
  }finally{ db.close(); }
}

function platformMock(item,overrides={}){
  const state={
    blockWrites:false,
    restoreCreated:false,
    restoreDeleted:false,
    calls:[],
    restoreGetCount:0,
    ...overrides.state,
  };
  const source={
    id:SOURCE_ID,name:'production',hostname:'production.test.turso.io',group:'default',parent:null,
  };
  const restore=()=>({
    id:RESTORE_ID,name:'restore-100-1',hostname:'restore-100-1.test.turso.io',group:'default',
    blockWrites:false,parent:{id:SOURCE_ID,name:'production'},
  });
  const platform={
    state,
    async getDatabase(name,{allowNotFound=false}={}){
      state.calls.push(['get',name,allowNotFound]);
      if(name==='production') return {...source,blockWrites:state.blockWrites};
      if(name==='restore-100-1'){
        state.restoreGetCount+=1;
        if(!state.restoreCreated||state.restoreDeleted) return allowNotFound?null:
          Promise.reject(new TursoPlatformError('TURSO_PLATFORM_NOT_FOUND','missing',{status:404}));
        const value=restore();
        return overrides.restoreValue?.(value,state)??value;
      }
      throw new Error('unexpected database name');
    },
    async getDatabaseConfiguration(name){
      state.calls.push(['config',name]);
      assert.equal(name,'production');
      return {blockWrites:state.blockWrites};
    },
    async setDatabaseBlockWrites(name,value){
      state.calls.push(['block',name,value]);
      if(overrides.setBlock) return overrides.setBlock(name,value,state);
      assert.equal(name,'production');
      state.blockWrites=value;
      return {blockWrites:value};
    },
    async createPitrDatabase(value){
      state.calls.push(['create',value]);
      state.restoreCreated=true;
      copyFileSync(item.sourcePath,item.restorePath);
      if(overrides.create) return overrides.create(value,state);
      return {id:RESTORE_ID,name:'restore-100-1',hostname:'restore-100-1.test.turso.io'};
    },
    async createDatabaseToken(name,value){
      state.calls.push(['token',name,value]);
      return name==='production'?'secret-source-database-token':'secret-restore-database-token';
    },
    async deleteDatabase(name){
      state.calls.push(['delete',name]);
      if(overrides.delete) return overrides.delete(name,state);
      assert.equal(name,'restore-100-1');
      state.restoreDeleted=true;
      return {deleted:true};
    },
  };
  return platform;
}

function options(platform,recovery,overrides={}){
  return {
    platform,
    sourceDatabaseId:SOURCE_ID,
    sourceDatabaseName:'production',
    sourceGroup:'default',
    restoreDatabaseName:'restore-100-1',
    repoCommit:COMMIT,
    hmacKey:HMAC_KEY,
    confirmation:'RESTORE_DISPOSABLE_ONLY',
    maxSnapshotAgeMs:30*60*1000,
    maxEvidenceAgeMs:30*60*1000,
    rpoTargetMs:30*60*1000,
    rtoTargetMs:15*60*1000,
    clock:()=>NOW,
    poll:{maxAttempts:3,intervalMs:1},
    databaseOperationTimeoutMs:1000,
    recoveryWriter:value=>{ recovery.push(value); },
    ...overrides,
  };
}

function dependencies(item,connections=[]){
  return {
    sleep:async()=>{},
    connectDatabase(configuration){
      connections.push({...configuration,authToken:'[redacted]'});
      return createClient({
        url:`file:${configuration.role==='source'?item.sourcePath:item.restorePath}`,
        intMode:'bigint',
      });
    },
  };
}

async function databaseState(path,migrations=EXECUTABLE_MIGRATIONS){
  const db=createClient({url:`file:${path}`,intMode:'bigint'});
  try{ return await inspectMigrationState(db,{migrations}); }
  finally{ db.close(); }
}

test('managed prefix rehearsal blocks writes, verifies PITR, migrates only the restore, and cleans up',async()=>{
  const item=fixture();
  const recovery=[];
  const connections=[];
  try{
    await installManaged(item.sourcePath,2);
    const platform=platformMock(item);
    const result=await runBackupRestoreRehearsal(
      options(platform,recovery),dependencies(item,connections),
    );

    assert.equal(result.ok,true);
    assert.deepEqual(result.migration,{
      sourceClassification:'managed',sourceVersion:2,adoptedOnRestore:false,
      appliedVersions:[3],finalVersion:3,
    });
    assert.equal(result.verification.preMigrationMatch,true);
    assert.equal(result.verification.postMigrationPreserved,true);
    assert.deepEqual(result.safety,{
      sourceIdentityVerified:true,writesBlockedBeforePitr:true,
      sourceWriteStateRestored:true,restoreIdentityVerified:true,restoreDeleted:true,
      sourceMigrated:false,sourceDeleted:false,credentialsInvalidated:false,
    });
    assert.deepEqual(recovery,[]);
    assert.equal(platform.state.blockWrites,false);
    assert.equal(platform.state.restoreDeleted,true);
    assert.deepEqual(platform.state.calls.filter(call=>call[0]==='block').map(call=>call[2]),[true,false]);
    assert.deepEqual(platform.state.calls.filter(call=>call[0]==='token').map(call=>call.slice(1)),[
      ['production',{expiration:'30m',authorization:'read-only'}],
      ['restore-100-1',{expiration:'30m',authorization:'full-access'}],
    ]);
    assert.deepEqual(platform.state.calls.filter(call=>call[0]==='delete'),[['delete','restore-100-1']]);
    assert.equal(
      platform.state.calls.findLastIndex(call=>call[0]==='block'&&call[2]===false)
        <platform.state.calls.findIndex(call=>call[0]==='delete'),
      true,
    );
    assert.deepEqual(connections.map(connection=>[connection.role,connection.intMode]),[
      ['source','bigint'],['restore','bigint'],
    ]);
    assert.equal((await databaseState(item.sourcePath,EXECUTABLE_MIGRATIONS.slice(0,2))).currentVersion,2);
    assert.equal((await databaseState(item.restorePath)).currentVersion,3);

    const serialized=JSON.stringify(result);
    for(const secret of [
      SOURCE_ID,RESTORE_ID,'production','restore-100-1','turso.io',
      'secret-source-database-token','secret-restore-database-token','preserved-value','SELECT',
    ]) assert.equal(serialized.includes(secret),false,`public result leaked ${secret}`);
  }finally{ item.close(); }
});

test('exact unmanaged prefix is adopted and advanced only on the disposable restore',async()=>{
  const item=fixture();
  const recovery=[];
  try{
    await installUnmanaged(item.sourcePath,2);
    const platform=platformMock(item);
    const result=await runBackupRestoreRehearsal(options(platform,recovery),dependencies(item));
    assert.equal(result.ok,true);
    assert.equal(result.migration.sourceClassification,'unmanaged');
    assert.equal(result.migration.adoptedOnRestore,true);
    assert.deepEqual(result.migration.appliedVersions,[3]);
    const source=await databaseState(item.sourcePath,EXECUTABLE_MIGRATIONS.slice(0,2));
    assert.equal(source.classification,'unmanaged');
    assert.equal(source.ledgerPresent,false);
    const restored=await databaseState(item.restorePath);
    assert.equal(restored.classification,'managed');
    assert.equal(restored.currentVersion,LATEST_MIGRATION_VERSION);
  }finally{ item.close(); }
});

test('an already-blocked source remains blocked after a successful rehearsal',async()=>{
  const item=fixture();
  const recovery=[];
  try{
    await installManaged(item.sourcePath,2);
    const platform=platformMock(item,{state:{blockWrites:true}});
    const result=await runBackupRestoreRehearsal(options(platform,recovery),dependencies(item));
    assert.equal(result.ok,true);
    assert.equal(platform.state.blockWrites,true);
    assert.deepEqual(platform.state.calls.filter(call=>call[0]==='block').map(call=>call[2]),[true,true]);
    const createCall=platform.state.calls.find(call=>call[0]==='create');
    assert.equal(createCall[1].pitrAt,'2026-09-18T12:00:00.000Z');
    assert.equal(platform.state.calls.indexOf(createCall)>
      platform.state.calls.findIndex(call=>call[0]==='block'&&call[2]===true),true);
  }finally{ item.close(); }
});

test('source client rejects writes and write transactions before they reach libSQL',async()=>{
  const calls=[];
  const client=readonlySourceClient({
    execute(statement){ calls.push(statement); return {rows:[]}; },
    transaction(mode){ calls.push(mode); return {execute(){},rollback(){}}; },
  });
  await client.execute('SELECT 1');
  await client.execute('PRAGMA integrity_check(1)');
  assert.throws(()=>client.execute('UPDATE auth_accounts SET is_admin=1'),/source write/);
  await assert.rejects(client.transaction('write'),/source write transaction/);
  assert.deepEqual(calls,['SELECT 1','PRAGMA integrity_check(1)']);
});

test('a failed write-block request still restores the original source state',async()=>{
  const item=fixture();
  const recovery=[];
  try{
    await installManaged(item.sourcePath,2);
    const platform=platformMock(item,{
      setBlock(_name,value,state){
        if(value===true) throw new TursoPlatformError('TURSO_PLATFORM_TIMEOUT','secret',{retryable:true});
        state.blockWrites=value;
        return {blockWrites:value};
      },
    });
    await assert.rejects(
      runBackupRestoreRehearsal(options(platform,recovery),dependencies(item)),
      error=>error instanceof RehearsalError&&error.code==='REHEARSAL_PLATFORM_FAILED',
    );
    assert.equal(platform.state.blockWrites,false);
    assert.ok(platform.state.calls.some(call=>call[0]==='block'&&call[2]===false));
    assert.equal(platform.state.calls.some(call=>call[0]==='create'),false);
    assert.deepEqual(recovery,[]);
  }finally{ item.close(); }
});

test('database operations have a bounded timeout and still restore source writes',async()=>{
  const item=fixture();
  const recovery=[];
  let closed=false;
  try{
    await installManaged(item.sourcePath,2);
    const platform=platformMock(item);
    await assert.rejects(
      runBackupRestoreRehearsal(options(platform,recovery,{
        databaseOperationTimeoutMs:5,
      }),{
        sleep:async()=>{},
        connectDatabase(){
          return {
            execute(){ return new Promise(()=>{}); },
            transaction(){ return new Promise(()=>{}); },
            close(){ closed=true; },
          };
        },
      }),
      error=>error.code==='REHEARSAL_DATABASE_TIMEOUT'&&error.phase==='source_evidence',
    );
    assert.equal(closed,true);
    assert.equal(platform.state.blockWrites,false);
    assert.equal(platform.state.calls.some(call=>call[0]==='create'),false);
    assert.deepEqual(recovery,[]);
  }finally{ item.close(); }
});

test('an ambiguous PITR create is never cleaned up by name without an exact returned ID',async()=>{
  const item=fixture();
  const recovery=[];
  try{
    await installManaged(item.sourcePath,2);
    const platform=platformMock(item,{
      create(){ throw new TursoPlatformError('TURSO_PLATFORM_TIMEOUT','provider detail',{retryable:true}); },
    });
    await assert.rejects(
      runBackupRestoreRehearsal(options(platform,recovery),dependencies(item)),
      error=>error.code==='REHEARSAL_RESTORE_CLEANUP_REQUIRED'&&error.phase==='restore_cleanup',
    );
    assert.equal(platform.state.calls.some(call=>call[0]==='delete'),false);
    assert.equal(platform.state.blockWrites,false);
    assert.equal(recovery.length,1);
    assert.equal(recovery[0].items[0].reason,'restore_identity_unconfirmed');
    assert.equal(recovery[0].items[0].restore.id,null);
  }finally{ item.close(); }
});

test('a parent or exact-ID mismatch prevents deletion and records private cleanup state',async()=>{
  const item=fixture();
  const recovery=[];
  try{
    await installManaged(item.sourcePath,2);
    const platform=platformMock(item,{
      restoreValue(value){ return {...value,parent:{id:'wrong-parent-id',name:'production'}}; },
    });
    await assert.rejects(
      runBackupRestoreRehearsal(options(platform,recovery),dependencies(item)),
      error=>error.code==='REHEARSAL_RESTORE_CLEANUP_REQUIRED',
    );
    assert.equal(platform.state.calls.some(call=>call[0]==='delete'),false);
    assert.equal(platform.state.blockWrites,false);
    assert.equal(recovery[0].items[0].reason,'restore_identity_mismatch');
    const publicValue=publicRehearsalError(new RehearsalError(
      'REHEARSAL_RESTORE_CLEANUP_REQUIRED','private provider detail',{phase:'restore_cleanup'},
    ),{repoCommit:COMMIT});
    const serialized=JSON.stringify(publicValue);
    assert.equal(serialized.includes('wrong-parent-id'),false);
    assert.equal(serialized.includes('private provider detail'),false);
  }finally{ item.close(); }
});

test('evidence mismatch cleans the exact restore and restores source writes',async()=>{
  const item=fixture();
  const recovery=[];
  try{
    await installManaged(item.sourcePath,2);
    const platform=platformMock(item,{
      async create(_value,state){
        const db=createClient({url:`file:${item.restorePath}`,intMode:'bigint'});
        try{ await db.execute("UPDATE auth_rate_limits SET attempts=99 WHERE key='preserved-value'"); }
        finally{ db.close(); }
        return {id:RESTORE_ID,name:'restore-100-1',hostname:'restore-100-1.test.turso.io'};
      },
    });
    let observed;
    await assert.rejects(runBackupRestoreRehearsal(options(platform,recovery),dependencies(item)),error=>{
      observed=error;
      return error.code==='REHEARSAL_EVIDENCE_FAILED';
    });
    assert.equal(platform.state.restoreDeleted,true);
    assert.equal(platform.state.blockWrites,false);
    assert.deepEqual(recovery,[]);
    assert.deepEqual(publicRehearsalError(observed,{repoCommit:COMMIT}).safety,{
      sourceIdentityVerified:true,writesBlockedBeforePitr:true,
      sourceWriteStateRestored:true,restoreIdentityVerified:true,restoreDeleted:true,
      sourceMigrated:false,sourceDeleted:false,credentialsInvalidated:false,
    });
  }finally{ item.close(); }
});

test('source write-state restoration failure overrides success and records recovery data',async()=>{
  const item=fixture();
  const recovery=[];
  try{
    await installManaged(item.sourcePath,2);
    const platform=platformMock(item,{
      setBlock(_name,value,state){
        if(value===false) throw new TursoPlatformError('TURSO_PLATFORM_UNAVAILABLE','secret',{retryable:true});
        state.blockWrites=true;
        return {blockWrites:true};
      },
    });
    await assert.rejects(
      runBackupRestoreRehearsal(options(platform,recovery),dependencies(item)),
      error=>error.code==='REHEARSAL_SOURCE_WRITE_STATE_RECOVERY_REQUIRED'
        &&error.phase==='write_state_restore',
    );
    assert.equal(platform.state.restoreDeleted,true);
    assert.equal(recovery.length,1);
    assert.equal(recovery[0].items[0].reason,'source_write_state_unconfirmed');
    assert.equal(recovery[0].items[0].source.expectedBlockWrites,false);
  }finally{ item.close(); }
});

test('post-migration preservation rejects missing or modified prior tables and sequences',()=>{
  const before={
    tables:[{name:'auth_accounts',count:1,digest:'a'.repeat(64)}],
    storage:{sequenceRows:1,sequenceDigest:'b'.repeat(64)},
  };
  const baseAfter={
    migration:{classification:'managed',currentVersion:LATEST_MIGRATION_VERSION,selectedVersion:LATEST_MIGRATION_VERSION},
    tables:[...before.tables,{name:'pairing_cycles',count:0,digest:'c'.repeat(64)}],
    storage:{...before.storage},
  };
  assert.equal(verifyPostMigrationPreservation(before,baseAfter),true);
  assert.throws(
    ()=>verifyPostMigrationPreservation(before,{...baseAfter,tables:[]}),
    error=>error.code==='REHEARSAL_PRESERVATION_FAILED',
  );
  assert.throws(
    ()=>verifyPostMigrationPreservation(before,{
      ...baseAfter,storage:{sequenceRows:2,sequenceDigest:'d'.repeat(64)},
    }),
    error=>error.code==='REHEARSAL_PRESERVATION_FAILED',
  );
});

test('CLI writes only an allowlisted public artifact beneath RUNNER_TEMP',async()=>{
  const directory=mkdtempSync(join(tmpdir(),'randori-rehearsal-cli-'));
  let output='';
  const successful={
    ok:true,kind:'turso-backup-restore-rehearsal',format:'randori.turso-backup-restore-rehearsal.v1',
    repoCommit:COMMIT,safety:{sourceDeleted:false},
  };
  try{
    const execution=await main({
      argv:['--artifact-dir',join(directory,'public-artifacts')],
      environment:{
        RUNNER_TEMP:directory,GITHUB_RUN_ID:'100',GITHUB_RUN_ATTEMPT:'1',
        TURSO_ORGANIZATION:'randori-org',TURSO_PRODUCTION_PLATFORM_TOKEN:'platform-token-secret-value',
        TURSO_PLATFORM_TIMEOUT_MS:'1000',TURSO_PRODUCTION_DATABASE_ID:SOURCE_ID,
        TURSO_DATABASE_TIMEOUT_MS:'1000',
        TURSO_PRODUCTION_DATABASE_NAME:'production',TURSO_GROUP:'default',
        TURSO_RESTORE_DATABASE_PREFIX:'randori-rehearsal',REHEARSAL_REPO_COMMIT:COMMIT,
        MIGRATION_DIGEST_HMAC_KEY:'a'.repeat(32),RESTORE_REHEARSAL_CONFIRM:'RESTORE_DISPOSABLE_ONLY',
        REHEARSAL_MAX_SNAPSHOT_AGE_MS:'1800000',REHEARSAL_MAX_EVIDENCE_AGE_MS:'1800000',
        REHEARSAL_RPO_TARGET_MS:'1800000',REHEARSAL_RTO_TARGET_MS:'900000',
        REHEARSAL_POLL_ATTEMPTS:'2',REHEARSAL_POLL_INTERVAL_MS:'1',
      },
      stdout:{write(chunk){ output+=chunk; }},
      createPlatform:()=>({}),
      run:async received=>{
        assert.equal(received.restoreDatabaseName,'randori-rehearsal-100-1');
        assert.equal(typeof received.recoveryWriter,'function');
        return successful;
      },
    });
    assert.equal(execution.exitCode,0,output);
    assert.deepEqual(JSON.parse(output),successful);
    const artifact=readFileSync(join(directory,'public-artifacts','rehearsal-summary.json'),'utf8');
    assert.deepEqual(JSON.parse(artifact),successful);
    for(const forbidden of [SOURCE_ID,'production','platform-token-secret-value','turso.io','SELECT']){
      assert.equal(artifact.includes(forbidden),false);
    }
    assert.throws(
      ()=>readFileSync(join(directory,'private-recovery','rehearsal-summary.json')),
      error=>error.code==='ENOENT',
    );
    const workflow=readFileSync('.github/workflows/turso-backup-restore-rehearsal.yml','utf8');
    assert.match(workflow,/path: \$\{\{ runner\.temp \}\}\/public-artifacts\/rehearsal-summary\.json/);
    assert.doesNotMatch(workflow,/path:[^\n]*(?:private-recovery|RUNNER_TEMP)/);
  }finally{ rmSync(directory,{recursive:true,force:true}); }
});

test('CLI failure artifact redacts raw provider errors and configured identities',async()=>{
  const directory=mkdtempSync(join(tmpdir(),'randori-rehearsal-cli-failure-'));
  let output='';
  try{
    const execution=await main({
      argv:['--artifact-dir',join(directory,'public-artifacts')],
      environment:{
        RUNNER_TEMP:directory,GITHUB_RUN_ID:'100',GITHUB_RUN_ATTEMPT:'1',
        TURSO_ORGANIZATION:'randori-org',TURSO_PRODUCTION_PLATFORM_TOKEN:'platform-token-secret-value',
        TURSO_PLATFORM_TIMEOUT_MS:'1000',TURSO_PRODUCTION_DATABASE_ID:SOURCE_ID,
        TURSO_DATABASE_TIMEOUT_MS:'1000',
        TURSO_PRODUCTION_DATABASE_NAME:'production',TURSO_GROUP:'default',
        TURSO_RESTORE_DATABASE_PREFIX:'randori-rehearsal',REHEARSAL_REPO_COMMIT:COMMIT,
        MIGRATION_DIGEST_HMAC_KEY:'a'.repeat(32),RESTORE_REHEARSAL_CONFIRM:'RESTORE_DISPOSABLE_ONLY',
        REHEARSAL_MAX_SNAPSHOT_AGE_MS:'1800000',REHEARSAL_MAX_EVIDENCE_AGE_MS:'1800000',
        REHEARSAL_RPO_TARGET_MS:'1800000',REHEARSAL_RTO_TARGET_MS:'900000',
        REHEARSAL_POLL_ATTEMPTS:'2',REHEARSAL_POLL_INTERVAL_MS:'1',
      },
      stdout:{write(chunk){ output+=chunk; }},
      createPlatform:()=>({}),
      run:async()=>{
        throw new RehearsalError('REHEARSAL_PLATFORM_FAILED',
          `raw ${SOURCE_ID} production libsql://secret.turso.io platform-token-secret-value SELECT *`,
          {phase:'restore_create'});
      },
    });
    assert.equal(execution.exitCode,1);
    const artifact=readFileSync(join(directory,'public-artifacts','rehearsal-summary.json'),'utf8');
    assert.deepEqual(JSON.parse(output),JSON.parse(artifact));
    assert.equal(JSON.parse(artifact).error,'REHEARSAL_PLATFORM_FAILED');
    for(const forbidden of [SOURCE_ID,'production','libsql://','platform-token-secret-value','SELECT *']){
      assert.equal(artifact.includes(forbidden),false);
    }
  }finally{ rmSync(directory,{recursive:true,force:true}); }
});
