import assert from 'node:assert/strict';
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { spawn } from 'node:child_process';
import { createHmac } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createClient } from '@libsql/client';

import { EXECUTABLE_MIGRATIONS, LATEST_MIGRATION_VERSION } from '../../db/executable-migrations.js';
import { applyMigrations, inspectMigrationState } from '../../db/migration-runner.js';
import { TursoPlatformError } from '../../db/turso-platform.js';
import { stableJson } from '../../db/schema-manifest.js';
import {
  RehearsalError,
  REHEARSAL_ATTESTATION_FORMAT,
  REHEARSAL_JOURNAL_FORMAT,
  createPrivateStateJournal,
  main,
  publicRehearsalError,
  readonlySourceClient,
  runBackupRestoreRehearsal,
  runInterruptedCleanup,
  verifyRehearsalAttestation,
  verifyPostMigrationPreservation,
} from '../../scripts/turso-backup-restore-rehearsal.mjs';

const SOURCE_ID='11111111-1111-4111-8111-111111111111';
const RESTORE_ID='22222222-2222-4222-8222-222222222222';
const COMMIT='0123456789abcdef0123456789abcdef01234567';
const HMAC_KEY=Buffer.from('rehearsal-evidence-key-32-bytes!!','utf8');
const NOW=Date.parse('2026-09-18T12:00:00.000Z');
const FAST_RETRY=Object.freeze({maxAttempts:1,baseDelayMs:0,maxDelayMs:0});
const ATTESTATION_CONTEXT=Object.freeze({
  repository:'festus14/randori-circle',repositoryId:123456,
  workflowPath:'.github/workflows/turso-backup-restore-rehearsal.yml',
  workflowRef:'festus14/randori-circle/.github/workflows/turso-backup-restore-rehearsal.yml@refs/heads/main',
  workflowSha:COMMIT,runId:100,runAttempt:1,environment:'turso-migration-rehearsal',
  repoCommit:COMMIT,
});

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
    blockWrites:false,parent:{
      id:SOURCE_ID,name:'production',branchedAt:'2026-09-18T12:00:00.000Z',
    },
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
      if(overrides.getConfiguration) return overrides.getConfiguration(name,state);
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
    attestationContext:ATTESTATION_CONTEXT,
    hmacKey:HMAC_KEY,
    confirmation:'RESTORE_DISPOSABLE_ONLY',
    maxSnapshotAgeMs:30*60*1000,
    maxEvidenceAgeMs:30*60*1000,
    rpoTargetMs:30*60*1000,
    rtoTargetMs:15*60*1000,
    clock:()=>NOW,
    poll:{maxAttempts:3,intervalMs:1},
    databaseOperationTimeoutMs:1000,
    evidenceMaxDurationMs:1000,
    expectedSourceBlockWrites:false,
    recoveryWriter:value=>{ recovery.push(value); },
    journalWriter:async()=>{},
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

function resignAttestation(value,mutate){
  const attestation=structuredClone(value);
  mutate(attestation);
  const signingKey=createHmac('sha256',HMAC_KEY)
      .update('randori:turso-rehearsal-attestation:v2:key','utf8').digest();
  try{
    attestation.signature=createHmac('sha256',signingKey)
      .update('randori:turso-rehearsal-attestation:v2:payload','utf8').update('\0','utf8')
      .update(stableJson({format:REHEARSAL_ATTESTATION_FORMAT,payload:attestation.payload}),'utf8')
      .digest('hex');
  }finally{ signingKey.fill(0); }
  return attestation;
}

if(process.env.RANDORI_REHEARSAL_SIGNAL_FIXTURE==='1'){
  const [resultPath,blockedPath]=process.argv.slice(2);
  const events=[];
  const platform=platformMock({sourcePath:'',restorePath:''},{
    setBlock(_name,value,state){
      events.push(['block',value]);
      state.blockWrites=value;
      if(value) writeFileSync(blockedPath,'blocked');
      return {blockWrites:value};
    },
  });
  const originalGet=platform.getDatabase.bind(platform);
  platform.getDatabase=async(...args)=>{
    events.push(['get',args[0]]);
    return originalGet(...args);
  };
  const controller=new AbortController();
  let interrupted=false;
  const interrupt=()=>{ interrupted=true; controller.abort(); };
  process.once('SIGINT',interrupt);
  process.once('SIGTERM',interrupt);
  let errorCode=null;
  try{
    await runBackupRestoreRehearsal(options(platform,[],{
      signal:controller.signal,databaseOperationTimeoutMs:10_000,evidenceMaxDurationMs:10_000,
    }),{
      sleep:duration=>new Promise(resolve=>setTimeout(resolve,duration)),
      connectDatabase:async()=>({
        execute(){ return new Promise(()=>{}); },
        transaction(){ return new Promise(()=>{}); },
        close(){ events.push(['close']); },
      }),
    });
  }catch(error){ errorCode=error?.code||'unknown'; }
  writeFileSync(resultPath,JSON.stringify({
    interrupted,blockWrites:platform.state.blockWrites,errorCode,events,
  }));
  process.removeListener('SIGINT',interrupt);
  process.removeListener('SIGTERM',interrupt);
  process.exit(interrupted?130:errorCode?1:0);
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
    const journals=[];
    const result=await runBackupRestoreRehearsal(
      options(platform,recovery,{journalWriter:async value=>{
        journals.push(value);
        platform.state.calls.push(['journal',value.phase]);
      }}),dependencies(item,connections),
    );

    assert.equal(result.ok,true);
    assert.deepEqual(result.payload.migration,{
      sourceClassification:'managed',sourceVersion:2,
      sourceStateFingerprint:result.payload.migration.sourceStateFingerprint,
      adoptedOnRestore:false,
      appliedVersions:EXECUTABLE_MIGRATIONS.slice(2).map(migration=>migration.version),
      finalVersion:LATEST_MIGRATION_VERSION,
    });
    assert.match(result.payload.migration.sourceStateFingerprint,/^[a-f0-9]{64}$/);
    assert.equal(
      result.payload.migration.sourceStateFingerprint,
      (await databaseState(item.sourcePath,EXECUTABLE_MIGRATIONS.slice(0,2))).stateFingerprint,
    );
    assert.equal(result.payload.verification.preMigrationMatch,true);
    assert.equal(result.payload.verification.postMigrationPreserved,true);
    assert.ok(Number.isSafeInteger(result.payload.verification.tableCount));
    assert.ok(result.payload.verification.tableCount>0);
    assert.ok(Number.isSafeInteger(result.payload.verification.totalRows));
    assert.ok(Number.isSafeInteger(result.payload.verification.sequenceRows));
    assert.equal(result.format,REHEARSAL_ATTESTATION_FORMAT);
    assert.deepEqual(Object.keys(result).sort(),['format','kind','ok','payload','signature']);
    const verified=verifyRehearsalAttestation(result,{
      hmacKey:HMAC_KEY,repoCommit:COMMIT,context:ATTESTATION_CONTEXT,
      sourceIdentity:SOURCE_ID,
      backupRef:`turso-pitr:${SOURCE_ID}:production:default`,
      rpoTargetMs:30*60*1000,rtoTargetMs:15*60*1000,
      runConclusion:'success',maxAgeMs:30*60*1000,clock:()=>NOW,
    });
    assert.equal(verified.context.runId,100);
    assert.equal(verified.migration.finalVersion,LATEST_MIGRATION_VERSION);
    assert.equal(verified.safety.sourceWriteStateRestored,true);
    assert.equal(verified.safety.restoreDeleted,true);
    assert.deepEqual(result.payload.safety,{
      sourceIdentityVerified:true,writesBlockedBeforePitr:true,
      sourceWriteStateRestored:true,restoreIdentityVerified:true,restoreDeleted:true,
      sourceMigrated:false,sourceDeleted:false,credentialsInvalidated:false,
    });
    assert.deepEqual(recovery,[]);
    assert.equal(journals[0].source.originalBlockWrites,false);
    assert.equal(journals[0].restore.attempted,false);
    assert.equal(journals.at(-1).status,'complete');
    assert.equal(platform.state.calls.findIndex(call=>call[0]==='journal')
      <platform.state.calls.findIndex(call=>call[0]==='block'),true);
    assert.equal(platform.state.blockWrites,false);
    assert.equal(platform.state.restoreDeleted,true);
    assert.deepEqual(platform.state.calls.filter(call=>call[0]==='block').map(call=>call[2]),[true,false]);
    assert.deepEqual(platform.state.calls.filter(call=>call[0]==='token').map(call=>call.slice(1)),[
      ['production',{expiration:'30m',authorization:'read-only'}],
      ['restore-100-1',{expiration:'30m',authorization:'full-access'}],
    ]);
    assert.deepEqual(platform.state.calls.filter(call=>call[0]==='delete'),[['delete','restore-100-1']]);
    assert.equal(
      platform.state.calls.findIndex(call=>call[0]==='create')
        <platform.state.calls.findLastIndex(call=>call[0]==='block'&&call[2]===false),
      true,
    );
    assert.equal(
      platform.state.calls.findLastIndex(call=>call[0]==='block'&&call[2]===false)
        <platform.state.calls.findIndex(call=>call[0]==='get'&&call[1]==='restore-100-1'),
      true,
    );
    assert.deepEqual(connections.map(connection=>[connection.role,connection.intMode]),[
      ['source','bigint'],['restore','bigint'],
    ]);
    assert.equal((await databaseState(item.sourcePath,EXECUTABLE_MIGRATIONS.slice(0,2))).currentVersion,2);
    assert.equal((await databaseState(item.restorePath)).currentVersion,18);

    const serialized=JSON.stringify(result);
    for(const secret of [
      SOURCE_ID,RESTORE_ID,'production','restore-100-1','turso.io',
      'secret-source-database-token','secret-restore-database-token','preserved-value','SELECT',
    ]) assert.equal(serialized.includes(secret),false,`public result leaked ${secret}`);
  }finally{ item.close(); }
});

test('attestation verifier rejects tampering, replay, expiry, schema drift, and unsafe outcomes',async()=>{
  const item=fixture();
  try{
    await installManaged(item.sourcePath,2);
    const result=await runBackupRestoreRehearsal(
      options(platformMock(item),[]),dependencies(item),
    );
    const verification={
      hmacKey:HMAC_KEY,repoCommit:COMMIT,context:ATTESTATION_CONTEXT,
      sourceIdentity:SOURCE_ID,
      backupRef:`turso-pitr:${SOURCE_ID}:production:default`,
      rpoTargetMs:30*60*1000,rtoTargetMs:15*60*1000,
      runConclusion:'success',maxAgeMs:30*60*1000,clock:()=>NOW,
    };
    const invalid=[];
    const alteredSignature=structuredClone(result);
    alteredSignature.signature='0'.repeat(64);
    invalid.push(alteredSignature);
    invalid.push(resignAttestation(result,value=>{ value.extra=true; }));
    invalid.push(resignAttestation(result,value=>{ value.payload.context.runId=101; }));
    invalid.push(resignAttestation(result,value=>{
      value.payload.context.runAttempt='1';
    }));
    invalid.push(resignAttestation(result,value=>{
      value.payload.schema.manifestChecksum='0'.repeat(64);
    }));
    invalid.push(resignAttestation(result,value=>{
      value.payload.schema.finalExecutableMigrationsChecksum='0'.repeat(64);
    }));
    invalid.push(resignAttestation(result,value=>{
      value.payload.migration.finalVersion=LATEST_MIGRATION_VERSION-1;
    }));
    invalid.push(resignAttestation(result,value=>{
      value.payload.migration.sourceStateFingerprint='0'.repeat(63);
    }));
    invalid.push(resignAttestation(result,value=>{
      value.payload.identities.restoreIdentityDigest=value.payload.identities.sourceIdentityDigest;
    }));
    invalid.push(resignAttestation(result,value=>{
      value.payload.pitr.authoritativeAt='2026-09-18T11:59:59.000Z';
    }));
    const alteredEvidence=structuredClone(result);
    alteredEvidence.payload.evidence.comparisonDigest='0'.repeat(64);
    invalid.push(alteredEvidence);
    invalid.push(resignAttestation(result,value=>{
      value.payload.verification.rpoMet=false;
    }));
    invalid.push(resignAttestation(result,value=>{
      value.payload.verification.totalRows=-1;
    }));
    invalid.push(resignAttestation(result,value=>{
      value.payload.safety.restoreDeleted=false;
    }));
    invalid.push(resignAttestation(result,value=>{
      value.payload.schema.unexpected=true;
    }));
    invalid.push(resignAttestation(result,value=>{
      delete value.payload.evidence.sourceEvidenceDigest;
    }));
    invalid.push(resignAttestation(result,value=>{
      value.payload.issuedAt='2026-09-18T12:00:00Z';
    }));
    for(const value of invalid){
      assert.throws(
        ()=>verifyRehearsalAttestation(value,verification),
        error=>error.code==='REHEARSAL_ATTESTATION_INVALID',
      );
    }
    assert.throws(
      ()=>verifyRehearsalAttestation(result,{...verification,hmacKey:'b'.repeat(32)}),
      error=>error.code==='REHEARSAL_ATTESTATION_INVALID',
    );
    assert.throws(
      ()=>verifyRehearsalAttestation(result,{
        ...verification,context:{...ATTESTATION_CONTEXT,runId:101},
      }),
      error=>error.code==='REHEARSAL_ATTESTATION_INVALID',
    );
    const otherCommit='abcdef0123456789abcdef0123456789abcdef01';
    const wrongExpectations=[
      {...verification,sourceIdentity:'33333333-3333-4333-8333-333333333333'},
      {...verification,backupRef:'turso-pitr:wrong'},
      {...verification,rpoTargetMs:1},
      {...verification,rtoTargetMs:1},
      {...verification,runConclusion:'failure'},
      {...verification,context:{...ATTESTATION_CONTEXT,runAttempt:2}},
      {...verification,context:{
        ...ATTESTATION_CONTEXT,repository:'other/randori-circle',
        workflowRef:'other/randori-circle/.github/workflows/turso-backup-restore-rehearsal.yml@refs/heads/main',
      }},
      {...verification,repoCommit:otherCommit,context:{
        ...ATTESTATION_CONTEXT,repoCommit:otherCommit,workflowSha:otherCommit,
      }},
      {...verification,context:{
        ...ATTESTATION_CONTEXT,
        workflowRef:'festus14/randori-circle/.github/workflows/turso-backup-restore-rehearsal.yml@refs/heads/other',
      }},
    ];
    for(const expected of wrongExpectations){
      assert.throws(
        ()=>verifyRehearsalAttestation(result,expected),
        error=>error.code==='REHEARSAL_ATTESTATION_INVALID',
      );
    }
    assert.throws(
      ()=>verifyRehearsalAttestation(result,{
        ...verification,clock:()=>Date.parse(result.payload.validUntil)+1,
      }),
      error=>error.code==='REHEARSAL_ATTESTATION_INVALID',
    );
    assert.throws(
      ()=>verifyRehearsalAttestation(result,{
        ...verification,clock:()=>Date.parse(result.payload.validUntil),
      }),
      error=>error.code==='REHEARSAL_ATTESTATION_INVALID',
    );
    assert.throws(
      ()=>verifyRehearsalAttestation(result,{...verification,clock:()=>NOW-1}),
      error=>error.code==='REHEARSAL_ATTESTATION_INVALID',
    );
    assert.throws(
      ()=>verifyRehearsalAttestation(result,{...verification,maxAgeMs:1}),
      error=>error.code==='REHEARSAL_ATTESTATION_INVALID',
    );
  }finally{ item.close(); }
});

test('rehearsal signer fixes recovery objectives and caps the evidence lifetime',async()=>{
  const item=fixture();
  try{
    for(const override of [
      {maxEvidenceAgeMs:30*60*1000+1},
      {rpoTargetMs:30*60*1000+1},
      {rtoTargetMs:15*60*1000+1},
      {rpoTargetMs:30*60*1000-1},
      {rtoTargetMs:15*60*1000-1},
    ]){
      await assert.rejects(
        runBackupRestoreRehearsal(options(platformMock(item),[],override),dependencies(item)),
        error=>error.code==='REHEARSAL_INVALID'&&error.phase==='configuration',
      );
    }
  }finally{ item.close(); }
});

function recoveryJournal(overrides={}){
  const value={
    kind:'turso-backup-restore-journal',format:REHEARSAL_JOURNAL_FORMAT,
    repoCommit:COMMIT,status:'active',phase:'restore_create',
    updatedAt:'2026-09-18T12:00:00.000Z',
    source:{
      id:SOURCE_ID,name:'production',group:'default',
      originalBlockWrites:false,writeStateRestored:false,
    },
    restore:{
      attempted:false,id:null,name:'restore-100-1',group:'default',pitrAt:null,
      sourceId:SOURCE_ID,sourceName:'production',identityVerified:false,deleted:false,
    },
  };
  return {
    ...value,...overrides,
    source:{...value.source,...overrides.source},
    restore:{...value.restore,...overrides.restore},
  };
}

function cleanupOptions(platform,state,writes){
  return {
    platform,sourceDatabaseId:SOURCE_ID,sourceDatabaseName:'production',sourceGroup:'default',
    restoreDatabaseName:'restore-100-1',repoCommit:COMMIT,expectedSourceBlockWrites:false,
    clock:()=>NOW,poll:{maxAttempts:3,intervalMs:1,maxDurationMs:1000},
    journalReader:async()=>structuredClone(state.current),
    journalWriter:async value=>{ state.current=structuredClone(value); writes.push(value); },
  };
}

test('interrupted cleanup restores source writes before marking an uncreated restore complete',async()=>{
  const item=fixture();
  const writes=[];
  try{
    const platform=platformMock(item,{state:{blockWrites:true}});
    const state={current:recoveryJournal()};
    const result=await runInterruptedCleanup(cleanupOptions(platform,state,writes),{sleep:async()=>{}});
    assert.equal(result.ok,true);
    assert.equal(platform.state.blockWrites,false);
    assert.equal(platform.state.calls.some(call=>call[0]==='delete'),false);
    assert.equal(state.current.status,'complete');
    assert.equal(state.current.source.writeStateRestored,true);
    assert.equal(state.current.restore.deleted,true);

    const callsBefore=platform.state.calls.length;
    const repeated=await runInterruptedCleanup(cleanupOptions(platform,state,writes),{sleep:async()=>{}});
    assert.equal(repeated.ok,true);
    assert.equal(platform.state.calls.length,callsBefore);
  }finally{ item.close(); }
});

test('interrupted cleanup exact-checks and deletes a known disposable restore',async()=>{
  const item=fixture();
  const writes=[];
  try{
    const platform=platformMock(item,{state:{blockWrites:true,restoreCreated:true}});
    const state={current:recoveryJournal({
      restore:{
        attempted:true,id:RESTORE_ID,pitrAt:'2026-09-18T12:00:00.000Z',
        identityVerified:true,
      },
    })};
    const result=await runInterruptedCleanup(cleanupOptions(platform,state,writes),{sleep:async()=>{}});
    assert.equal(result.ok,true);
    assert.equal(platform.state.blockWrites,false);
    assert.equal(platform.state.restoreDeleted,true);
    assert.deepEqual(platform.state.calls.filter(call=>call[0]==='delete'),[['delete','restore-100-1']]);
    assert.equal(state.current.status,'complete');
  }finally{ item.close(); }
});

test('interrupted cleanup reports source recovery and skips restore deletion when restoration fails',async()=>{
  const item=fixture();
  const writes=[];
  try{
    const platform=platformMock(item,{
      state:{blockWrites:true,restoreCreated:true},
      setBlock(){
        throw new TursoPlatformError('TURSO_PLATFORM_UNAVAILABLE','secret',{retryable:true});
      },
    });
    const state={current:recoveryJournal({
      restore:{
        attempted:true,id:RESTORE_ID,pitrAt:'2026-09-18T12:00:00.000Z',
        identityVerified:true,
      },
    })};
    let observed;
    await assert.rejects(
      runInterruptedCleanup(cleanupOptions(platform,state,writes),{sleep:async()=>{}}),
      error=>{
        observed=error;
        return error.code==='REHEARSAL_SOURCE_WRITE_STATE_RECOVERY_REQUIRED'
          &&error.phase==='write_state_restore';
      },
    );
    assert.equal(platform.state.blockWrites,true);
    assert.equal(platform.state.calls.some(call=>call[0]==='delete'),false);
    assert.equal(observed.safety.sourceIdentityVerified,true);
    assert.equal(observed.safety.sourceWriteStateRestored,false);
    assert.equal(observed.safety.restoreDeleted,false);
  }finally{ item.close(); }
});

test('interrupted cleanup never name-deletes an unresolved restore identity',async()=>{
  const item=fixture();
  const writes=[];
  try{
    const platform=platformMock(item,{state:{blockWrites:true,restoreCreated:true}});
    const state={current:recoveryJournal({
      restore:{attempted:true,pitrAt:'2026-09-18T12:00:00.000Z'},
    })};
    await assert.rejects(
      runInterruptedCleanup(cleanupOptions(platform,state,writes),{sleep:async()=>{}}),
      error=>error.code==='REHEARSAL_RESTORE_CLEANUP_REQUIRED',
    );
    assert.equal(platform.state.blockWrites,false);
    assert.equal(platform.state.calls.some(call=>call[0]==='delete'),false);
    assert.equal(state.current.status,'recovery_required');
  }finally{ item.close(); }
});

test('no-state cleanup verifies but never mutates an unowned source or restore',async()=>{
  const item=fixture();
  const writes=[];
  try{
    const platform=platformMock(item,{state:{blockWrites:true}});
    const absentState={current:null};
    await assert.rejects(
      runInterruptedCleanup(cleanupOptions(platform,absentState,writes),{sleep:async()=>{}}),
      error=>error.code==='REHEARSAL_SOURCE_WRITE_STATE_RECOVERY_REQUIRED',
    );
    assert.equal(platform.state.blockWrites,true);
    assert.equal(platform.state.calls.some(call=>call[0]==='block'),false);

    platform.state.blockWrites=false;
    platform.state.restoreCreated=true;
    await assert.rejects(
      runInterruptedCleanup(cleanupOptions(platform,absentState,writes),{sleep:async()=>{}}),
      error=>error.code==='REHEARSAL_RESTORE_CLEANUP_REQUIRED',
    );
    assert.equal(platform.state.calls.some(call=>call[0]==='delete'),false);
  }finally{ item.close(); }
});

test('write-state retries share one total poll deadline',async()=>{
  const item=fixture();
  const recovery=[];
  let configurationReads=0;
  try{
    await installManaged(item.sourcePath,2);
    const platform=platformMock(item,{
      getConfiguration(_name,state){
        configurationReads+=1;
        if(configurationReads===1) return {blockWrites:state.blockWrites};
        return new Promise((_resolve,reject)=>setTimeout(()=>reject(
          new TursoPlatformError('TURSO_PLATFORM_UNAVAILABLE','secret',{retryable:true}),
        ),10));
      },
    });
    await assert.rejects(
      runBackupRestoreRehearsal(options(platform,recovery,{
        poll:{maxAttempts:20,intervalMs:1,maxDurationMs:25},
        cleanupPoll:{maxAttempts:2,intervalMs:1,maxDurationMs:25},
      }),dependencies(item)),
    );
    const recoveryStart=platform.state.calls.findIndex(
      call=>call[0]==='block'&&call[2]===false,
    );
    const primaryConfigurationReads=platform.state.calls.slice(0,recoveryStart)
      .filter(call=>call[0]==='config').length;
    assert.ok(primaryConfigurationReads>=2&&primaryConfigurationReads<=4,
      `shared deadline performed ${primaryConfigurationReads} primary configuration reads`);
    assert.equal(platform.state.calls.filter(call=>call[0]==='block'&&call[2]===true).length,1);
  }finally{ item.close(); }
});

test('private state journal uses atomic mode-0600 files and refuses symlink reads',async()=>{
  const directory=mkdtempSync(join(tmpdir(),'randori-journal-'));
  const statePath=join(directory,'state.json');
  const victimPath=join(directory,'victim.json');
  try{
    writeFileSync(victimPath,'do-not-replace');
    symlinkSync(victimPath,statePath);
    const journal=createPrivateStateJournal(statePath);
    await assert.rejects(journal.read(),error=>error.code==='REHEARSAL_RECOVERY_STATE_FAILED');
    await journal.write({sequence:1});
    assert.equal(readFileSync(victimPath,'utf8'),'do-not-replace');
    assert.deepEqual(await journal.read(),{sequence:1});
    await journal.write({sequence:2});
    assert.deepEqual(await journal.read(),{sequence:2});
    assert.equal(lstatSync(statePath).mode&0o777,0o600);
  }finally{ rmSync(directory,{recursive:true,force:true}); }
});

test('exact unmanaged prefix is adopted and advanced only on the disposable restore',async()=>{
  const item=fixture();
  const recovery=[];
  try{
    await installUnmanaged(item.sourcePath,2);
    const platform=platformMock(item);
    const result=await runBackupRestoreRehearsal(options(platform,recovery),dependencies(item));
    assert.equal(result.ok,true);
    assert.equal(result.payload.migration.sourceClassification,'unmanaged');
    assert.equal(result.payload.migration.adoptedOnRestore,true);
    assert.deepEqual(result.payload.migration.appliedVersions,[3,4,5,6,7,8,9,10,11,12,13,14,15,16,17,18]);
    const source=await databaseState(item.sourcePath,EXECUTABLE_MIGRATIONS.slice(0,2));
    assert.equal(source.classification,'unmanaged');
    assert.equal(source.ledgerPresent,false);
    const restored=await databaseState(item.restorePath);
    assert.equal(restored.classification,'managed');
    assert.equal(restored.currentVersion,LATEST_MIGRATION_VERSION);
  }finally{ item.close(); }
});

for(const classification of ['managed','unmanaged']){
  test(`${classification} v1 rehearsal accepts the canonical v2 singleton seed`,async()=>{
    const item=fixture();
    const recovery=[];
    try{
      if(classification==='managed') await installManaged(item.sourcePath,1);
      else await installUnmanaged(item.sourcePath,1);
      const platform=platformMock(item);
      const result=await runBackupRestoreRehearsal(options(platform,recovery),dependencies(item));
      assert.equal(result.ok,true);
      assert.equal(result.payload.migration.sourceVersion,1);
      assert.equal(result.payload.migration.sourceClassification,classification);
      assert.equal(result.payload.migration.adoptedOnRestore,classification==='unmanaged');
      assert.deepEqual(result.payload.migration.appliedVersions,[2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,17,18]);
      const restored=createClient({url:`file:${item.restorePath}`,intMode:'bigint'});
      try{
        const singleton=await restored.execute('SELECT id,registrations_closed FROM circle_membership_rollout');
        assert.deepEqual(singleton.rows,[{id:1n,registrations_closed:0n}]);
      }finally{ restored.close(); }
    }finally{ item.close(); }
  });
}

test('an already-blocked source remains blocked after a successful rehearsal',async()=>{
  const item=fixture();
  const recovery=[];
  try{
    await installManaged(item.sourcePath,2);
    const platform=platformMock(item,{state:{blockWrites:true}});
    const result=await runBackupRestoreRehearsal(options(platform,recovery,{
      expectedSourceBlockWrites:true,
    }),dependencies(item));
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

test('SIGTERM interrupts forward database work but confirms source restoration before exit',async()=>{
  const directory=mkdtempSync(join(tmpdir(),'randori-rehearsal-signal-'));
  const resultPath=join(directory,'result.json');
  const blockedPath=join(directory,'blocked');
  const child=spawn(process.execPath,[
    'tests/unit/turso-backup-restore-rehearsal.test.mjs',resultPath,blockedPath,
  ],{
    cwd:process.cwd(),stdio:['ignore','pipe','pipe'],
    env:{...process.env,RANDORI_REHEARSAL_SIGNAL_FIXTURE:'1'},
  });
  let stderr='';
  child.stderr.on('data',chunk=>{ stderr+=chunk; });
  try{
    for(let attempt=0;attempt<100&&!existsSync(blockedPath);attempt+=1){
      await new Promise(resolve=>setTimeout(resolve,10));
    }
    assert.equal(existsSync(blockedPath),true,stderr);
    child.kill('SIGTERM');
    const outcome=await new Promise(resolve=>child.once('close',(code,signal)=>resolve({code,signal})));
    assert.deepEqual(outcome,{code:130,signal:null},stderr);
    const result=JSON.parse(readFileSync(resultPath,'utf8'));
    assert.equal(result.interrupted,true);
    assert.equal(result.blockWrites,false);
    assert.equal(result.errorCode,'REHEARSAL_FAILED');
    assert.deepEqual(result.events.filter(event=>event[0]==='block').map(event=>event[1]),[true,false]);
    assert.equal(result.events.findIndex(event=>event[0]==='block'&&event[1]===false)
      <result.events.findIndex(event=>event[0]==='close'),true);
  }finally{
    if(child.exitCode===null) child.kill('SIGKILL');
    rmSync(directory,{recursive:true,force:true});
  }
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
      restoreValue(value){
        return {...value,parent:{
          id:'wrong-parent-id',name:'production',branchedAt:'2026-09-18T12:00:00.000Z',
        }};
      },
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

test('failed immediate source restoration is retried by finally before restore polling',async()=>{
  const item=fixture();
  const recovery=[];
  let unblockAttempts=0;
  try{
    await installManaged(item.sourcePath,2);
    const platform=platformMock(item,{
      setBlock(_name,value,state){
        if(value===false&&++unblockAttempts<=3){
          throw new TursoPlatformError('TURSO_PLATFORM_UNAVAILABLE','secret',{retryable:true});
        }
        state.blockWrites=value;
        return {blockWrites:value};
      },
    });
    let observed;
    await assert.rejects(runBackupRestoreRehearsal(options(platform,recovery),dependencies(item)),error=>{
      observed=error;
      return error.code==='REHEARSAL_PLATFORM_FAILED';
    });
    assert.equal(unblockAttempts,4);
    assert.equal(platform.state.blockWrites,false);
    assert.equal(platform.state.restoreDeleted,true);
    assert.equal(platform.state.calls.filter(call=>call[0]==='get'&&call[1]==='restore-100-1').length,2);
    assert.equal(publicRehearsalError(observed).safety.sourceWriteStateRestored,true);
  }finally{ item.close(); }
});

test('post-migration preservation rejects missing or modified prior tables, seeded additions, and sequences',()=>{
  const before={
    tables:[{name:'auth_accounts',count:1,digest:'a'.repeat(64)}],
    storage:{sequenceRows:1,sequenceDigest:'b'.repeat(64)},
    migration:{selectedVersion:2},
  };
  const baseAfter={
    migration:{classification:'managed',currentVersion:LATEST_MIGRATION_VERSION,selectedVersion:LATEST_MIGRATION_VERSION},
    tables:[
      ...before.tables,
      {name:'pairing_cycle_availability',count:0,digest:'c'.repeat(64)},
      {name:'pairing_cycles',count:0,digest:'d'.repeat(64)},
      {name:'auth_provider_identities',count:0,digest:'e'.repeat(64)},
      {name:'auth_sessions',count:0,digest:'f'.repeat(64)},
      {name:'outbox_audit_events',count:0,digest:'1'.repeat(64)},
      {name:'outbox_events',count:0,digest:'2'.repeat(64)},
      {name:'auth_email_activations',count:0,digest:'3'.repeat(64)},
      {name:'auth_password_resets',count:0,digest:'4'.repeat(64)},
      {name:'auth_recent_proofs',count:0,digest:'5'.repeat(64)},
      {name:'auth_provider_email_state',count:0,digest:'6'.repeat(64)},
      {name:'auth_identity_audit_events',count:0,digest:'7'.repeat(64)},
      {name:'chat_retention_control',count:0,digest:'8'.repeat(64)},
      {name:'chat_retention_scopes',count:0,digest:'9'.repeat(64)},
      {name:'chat_retention_runs',count:0,digest:'a'.repeat(64)},
      {name:'chat_retention_legal_holds',count:0,digest:'b'.repeat(64)},
      {name:'chat_retention_audit_events',count:0,digest:'c'.repeat(64)},
      {name:'auth_session_circle_contexts',count:0,digest:'d'.repeat(64)},
      {name:'circle_pairing_publications',count:0,digest:'e'.repeat(64)},
      {name:'circle_pairing_eligibility',count:0,digest:'f'.repeat(64)},
      {name:'circle_pairing_groups',count:0,digest:'0'.repeat(64)},
      {name:'circle_creation_requests',count:0,digest:'1'.repeat(64)},
      {name:'credential_key_controls',count:4,digest:'2'.repeat(64)},
      {name:'circle_pair_schedules',count:0,digest:'3'.repeat(64)},
      {name:'circle_pair_schedule_proposals',count:0,digest:'4'.repeat(64)},
      {name:'session_completion_receipts',count:0,digest:'5'.repeat(64)},
      {name:'pair_meeting_links',count:0,digest:'6'.repeat(64)},
    ],
    storage:{...before.storage},
  };
  assert.equal(verifyPostMigrationPreservation(before,baseAfter),true);
  assert.throws(
    ()=>verifyPostMigrationPreservation(before,{...baseAfter,tables:[]}),
    error=>error.code==='REHEARSAL_PRESERVATION_FAILED',
  );
  assert.throws(
    ()=>verifyPostMigrationPreservation(before,{
      ...baseAfter,
      tables:baseAfter.tables.map(table=>table.name==='pairing_cycles'?{...table,count:1}:table),
    }),
    error=>error.code==='REHEARSAL_PRESERVATION_FAILED',
  );
  assert.throws(
    ()=>verifyPostMigrationPreservation(before,{
      ...baseAfter,
      tables:[...baseAfter.tables,{name:'ai_monthly_usage',count:0,digest:'1'.repeat(64)}],
    }),
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
    ok:true,kind:'turso-rehearsal-attestation',format:REHEARSAL_ATTESTATION_FORMAT,
    payload:{context:ATTESTATION_CONTEXT,safety:{sourceDeleted:false}},signature:'0'.repeat(64),
  };
  try{
    const execution=await main({
      argv:[
        '--mode','run','--artifact-dir',join(directory,'public-artifacts'),
        '--state-file',join(directory,'private-recovery','state.json'),
      ],
      environment:{
        RUNNER_TEMP:directory,GITHUB_RUN_ID:'100',GITHUB_RUN_ATTEMPT:'1',
        GITHUB_REPOSITORY:'festus14/randori-circle',GITHUB_REPOSITORY_ID:'123456',
        GITHUB_WORKFLOW_REF:ATTESTATION_CONTEXT.workflowRef,GITHUB_WORKFLOW_SHA:COMMIT,
        REHEARSAL_WORKFLOW_PATH:ATTESTATION_CONTEXT.workflowPath,
        REHEARSAL_GITHUB_ENVIRONMENT:ATTESTATION_CONTEXT.environment,
        TURSO_ORGANIZATION:'randori-org',TURSO_PRODUCTION_PLATFORM_TOKEN:'platform-token-secret-value',
        TURSO_PLATFORM_TIMEOUT_MS:'1000',TURSO_PRODUCTION_DATABASE_ID:SOURCE_ID,
        TURSO_DATABASE_TIMEOUT_MS:'1000',
        TURSO_PRODUCTION_DATABASE_NAME:'production',TURSO_GROUP:'default',
        TURSO_PRODUCTION_EXPECTED_BLOCK_WRITES:'false',
        TURSO_RESTORE_DATABASE_PREFIX:'randori-rehearsal',REHEARSAL_REPO_COMMIT:COMMIT,
        MIGRATION_DIGEST_HMAC_KEY:'a'.repeat(32),RESTORE_REHEARSAL_CONFIRM:'RESTORE_DISPOSABLE_ONLY',
        REHEARSAL_MAX_SNAPSHOT_AGE_MS:'1800000',REHEARSAL_MAX_EVIDENCE_AGE_MS:'1800000',
        REHEARSAL_RPO_TARGET_MS:'1800000',REHEARSAL_RTO_TARGET_MS:'900000',
        REHEARSAL_POLL_ATTEMPTS:'2',REHEARSAL_POLL_INTERVAL_MS:'1',REHEARSAL_POLL_DURATION_MS:'1000',
        REHEARSAL_CLEANUP_POLL_ATTEMPTS:'2',REHEARSAL_CLEANUP_POLL_INTERVAL_MS:'1',
        REHEARSAL_CLEANUP_POLL_DURATION_MS:'1000',REHEARSAL_EVIDENCE_DURATION_MS:'1000',
      },
      stdout:{write(chunk){ output+=chunk; }},
      createPlatform:()=>({}),
      run:async received=>{
        assert.equal(received.restoreDatabaseName,'randori-rehearsal-100-1');
        assert.deepEqual(received.attestationContext,{
          ...ATTESTATION_CONTEXT,repositoryId:'123456',runId:'100',runAttempt:'1',
        });
        assert.equal(typeof received.recoveryWriter,'function');
        assert.equal(typeof received.journalWriter,'function');
        return successful;
      },
    });
    assert.equal(execution.exitCode,0,output);
    assert.deepEqual(JSON.parse(output),successful);
    const artifact=readFileSync(join(directory,'public-artifacts','rehearsal-summary.json'),'utf8');
    assert.deepEqual(JSON.parse(artifact),successful);
    assert.equal(JSON.parse(artifact).format,REHEARSAL_ATTESTATION_FORMAT);
    assert.match(JSON.parse(artifact).signature,/^[a-f0-9]{64}$/);
    for(const forbidden of [SOURCE_ID,'production','platform-token-secret-value','turso.io','SELECT']){
      assert.equal(artifact.includes(forbidden),false);
    }
    assert.throws(
      ()=>readFileSync(join(directory,'private-recovery','rehearsal-summary.json')),
      error=>error.code==='ENOENT',
    );
    const workflow=readFileSync('.github/workflows/turso-backup-restore-rehearsal.yml','utf8');
    assert.match(workflow,/\$\{\{ runner\.temp \}\}\/public-artifacts\/rehearsal-summary\.json/);
    assert.match(workflow,/\$\{\{ runner\.temp \}\}\/public-artifacts\/cleanup-summary\.json/);
    assert.doesNotMatch(workflow,/path:[^\n]*(?:private-recovery|RUNNER_TEMP)/);
    assert.doesNotMatch(workflow,/uses: actions\/(?:checkout|setup-node|upload-artifact)@v[0-9]/);
    assert.match(workflow,/concurrency:\n\s+group: turso-production-database-operations\n\s+cancel-in-progress: false/);
    assert.match(workflow,/Restore source state and clean disposable restore\n\s+id: cleanup\n\s+if: always\(\)/);
    assert.match(workflow,/steps\.cleanup\.outcome == 'success'/);
    assert.match(workflow,/steps\.cleanup_upload\.outcome == 'success'/);
    assert.equal(
      workflow.indexOf('Upload sanitized cleanup summary')
        <workflow.indexOf('Upload signed rehearsal attestation'),
      true,
    );
    assert.equal((workflow.match(/secrets\.MIGRATION_DIGEST_HMAC_KEY/g)||[]).length,2);
    assert.equal((workflow.match(/secrets\.TURSO_PRODUCTION_PLATFORM_TOKEN/g)||[]).length,2);
    assert.equal((workflow.match(/REHEARSAL_RPO_TARGET_MS: '1800000'/g)||[]).length,2);
    assert.equal((workflow.match(/REHEARSAL_RTO_TARGET_MS: '900000'/g)||[]).length,2);
  }finally{ rmSync(directory,{recursive:true,force:true}); }
});

test('CLI failure artifact redacts raw provider errors and configured identities',async()=>{
  const directory=mkdtempSync(join(tmpdir(),'randori-rehearsal-cli-failure-'));
  let output='';
  try{
    const execution=await main({
      argv:[
        '--mode','run','--artifact-dir',join(directory,'public-artifacts'),
        '--state-file',join(directory,'private-recovery','state.json'),
      ],
      environment:{
        RUNNER_TEMP:directory,GITHUB_RUN_ID:'100',GITHUB_RUN_ATTEMPT:'1',
        GITHUB_REPOSITORY:'festus14/randori-circle',GITHUB_REPOSITORY_ID:'123456',
        GITHUB_WORKFLOW_REF:ATTESTATION_CONTEXT.workflowRef,GITHUB_WORKFLOW_SHA:COMMIT,
        REHEARSAL_WORKFLOW_PATH:ATTESTATION_CONTEXT.workflowPath,
        REHEARSAL_GITHUB_ENVIRONMENT:ATTESTATION_CONTEXT.environment,
        TURSO_ORGANIZATION:'randori-org',TURSO_PRODUCTION_PLATFORM_TOKEN:'platform-token-secret-value',
        TURSO_PLATFORM_TIMEOUT_MS:'1000',TURSO_PRODUCTION_DATABASE_ID:SOURCE_ID,
        TURSO_DATABASE_TIMEOUT_MS:'1000',
        TURSO_PRODUCTION_DATABASE_NAME:'production',TURSO_GROUP:'default',
        TURSO_PRODUCTION_EXPECTED_BLOCK_WRITES:'false',
        TURSO_RESTORE_DATABASE_PREFIX:'randori-rehearsal',REHEARSAL_REPO_COMMIT:COMMIT,
        MIGRATION_DIGEST_HMAC_KEY:'a'.repeat(32),RESTORE_REHEARSAL_CONFIRM:'RESTORE_DISPOSABLE_ONLY',
        REHEARSAL_MAX_SNAPSHOT_AGE_MS:'1800000',REHEARSAL_MAX_EVIDENCE_AGE_MS:'1800000',
        REHEARSAL_RPO_TARGET_MS:'1800000',REHEARSAL_RTO_TARGET_MS:'900000',
        REHEARSAL_POLL_ATTEMPTS:'2',REHEARSAL_POLL_INTERVAL_MS:'1',REHEARSAL_POLL_DURATION_MS:'1000',
        REHEARSAL_CLEANUP_POLL_ATTEMPTS:'2',REHEARSAL_CLEANUP_POLL_INTERVAL_MS:'1',
        REHEARSAL_CLEANUP_POLL_DURATION_MS:'1000',REHEARSAL_EVIDENCE_DURATION_MS:'1000',
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

test('cleanup CLI is idempotent with no journal and emits its separate sanitized artifact',async()=>{
  const directory=mkdtempSync(join(tmpdir(),'randori-rehearsal-cleanup-cli-'));
  const item=fixture();
  let output='';
  let cleanupError=null;
  try{
    const platform=platformMock(item);
    const execution=await main({
      argv:[
        '--mode','cleanup','--artifact-dir',join(directory,'public-artifacts'),
        '--state-file',join(directory,'private-recovery','state.json'),
      ],
      environment:{
        RUNNER_TEMP:directory,GITHUB_RUN_ID:'100',GITHUB_RUN_ATTEMPT:'1',
        TURSO_ORGANIZATION:'randori-org',TURSO_PRODUCTION_PLATFORM_TOKEN:'platform-token-secret-value',
        TURSO_PLATFORM_TIMEOUT_MS:'1000',TURSO_PRODUCTION_DATABASE_ID:SOURCE_ID,
        TURSO_PRODUCTION_DATABASE_NAME:'production',TURSO_GROUP:'default',
        TURSO_PRODUCTION_EXPECTED_BLOCK_WRITES:'false',
        TURSO_RESTORE_DATABASE_PREFIX:'restore',REHEARSAL_REPO_COMMIT:COMMIT,
        REHEARSAL_CLEANUP_POLL_ATTEMPTS:'2',REHEARSAL_CLEANUP_POLL_INTERVAL_MS:'1',
        REHEARSAL_CLEANUP_POLL_DURATION_MS:'1000',
      },
      stdout:{write(chunk){ output+=chunk; }},
      createPlatform:()=>platform,
      cleanup:async received=>{
        try{ return await runInterruptedCleanup(received,{sleep:async()=>{}}); }
        catch(error){ cleanupError=error; throw error; }
      },
    });
    assert.equal(execution.exitCode,0,cleanupError?.stack||output);
    const artifact=readFileSync(join(directory,'public-artifacts','cleanup-summary.json'),'utf8');
    assert.deepEqual(JSON.parse(output),JSON.parse(artifact));
    assert.equal(JSON.parse(artifact).noState,true);
    for(const forbidden of [SOURCE_ID,'production','platform-token-secret-value','turso.io']){
      assert.equal(artifact.includes(forbidden),false);
    }
  }finally{
    item.close();
    rmSync(directory,{recursive:true,force:true});
  }
});
