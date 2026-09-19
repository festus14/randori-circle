import assert from 'node:assert/strict';
import {
  copyFileSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, test } from 'node:test';
import { createClient } from '@libsql/client';

import { EXECUTABLE_MIGRATIONS } from '../../db/executable-migrations.js';
import { applyMigrations, inspectMigrationState } from '../../db/migration-runner.js';

import {
  assessBackupRestoreRun,
  BACKUP_MONITOR_FORMAT,
  main,
} from '../../scripts/turso-backup-restore-monitor.mjs';
import {
  REHEARSAL_FORMAT,
  runBackupRestoreRehearsal,
} from '../../scripts/turso-backup-restore-rehearsal.mjs';

const NOW=Date.parse('2026-09-21T03:30:00.000Z');
const COMMIT='a'.repeat(40);
const DIGEST='b'.repeat(64);
const SOURCE_ID='11111111-1111-4111-8111-111111111111';
const RESTORE_ID='22222222-2222-4222-8222-222222222222';
const HMAC_KEY='rehearsal-evidence-key-32-bytes!!';
const cleanup=Object.freeze({
  ok:true,kind:'turso-backup-restore-cleanup',format:REHEARSAL_FORMAT,repoCommit:COMMIT,
  noState:false,recoveryRequired:false,
  safety:{
    sourceIdentityVerified:false,writesBlockedBeforePitr:true,sourceWriteStateRestored:true,
    restoreIdentityVerified:true,restoreDeleted:true,sourceMigrated:false,sourceDeleted:false,
    credentialsInvalidated:false,
  },
});

function payload(issuedAt='2026-09-21T03:29:00.000Z'){
  return {
    context:{repoCommit:COMMIT},issuedAt,
    schema:{
      manifestChecksum:DIGEST,sourceExecutableMigrationsChecksum:DIGEST,
      finalExecutableMigrationsChecksum:DIGEST,
    },
    migration:{appliedVersions:[3,4]},
    evidence:{comparisonDigest:DIGEST},
    verification:{
      rpoMet:true,rtoMet:true,rpoTargetMs:1_800_000,rtoTargetMs:900_000,
      sourceSnapshotAgeMs:1_000,restoredSnapshotAgeMs:5_000,restoreDurationMs:4_000,
      tableCount:37,totalRows:84,sequenceRows:8,
    },
  };
}

function rehearsal(issuedAt){
  return {ok:true,payload:payload(issuedAt)};
}

function options(overrides={}){
  return {
    runId:100,runAttempt:1,repoCommit:COMMIT,maxSuccessAgeMs:1_800_000,
    rpoTargetMs:1_800_000,rtoTargetMs:900_000,
    clock:()=>NOW,verify:value=>value.payload,...overrides,
  };
}

const cleanupDirectories=[];
afterEach(()=>{
  while(cleanupDirectories.length) rmSync(cleanupDirectories.pop(),{recursive:true,force:true});
});

async function productionAttestation(directory){
  const sourcePath=join(directory,'source.db');
  const restorePath=join(directory,'restore.db');
  const sourceDb=createClient({url:`file:${sourcePath}`,intMode:'bigint'});
  const migrations=EXECUTABLE_MIGRATIONS.slice(0,2);
  try{
    const state=await inspectMigrationState(sourceDb,{migrations});
    await applyMigrations(sourceDb,{
      expectedStateFingerprint:state.stateFingerprint,migrations,
      retry:{maxAttempts:1,baseDelayMs:0,maxDelayMs:0},
    });
  }finally{ sourceDb.close(); }

  const state={blockWrites:false,created:false,deleted:false,pitrAt:null};
  const platform={
    async getDatabase(name,{allowNotFound=false}={}){
      if(name==='production'){
        return {id:SOURCE_ID,name,hostname:'production.test.turso.io',group:'default',
          parent:null,blockWrites:state.blockWrites};
      }
      if(name==='restore-100-1'&&state.created&&!state.deleted){
        return {id:RESTORE_ID,name,hostname:'restore.test.turso.io',group:'default',
          blockWrites:false,parent:{id:SOURCE_ID,name:'production',branchedAt:state.pitrAt}};
      }
      if(allowNotFound) return null;
      throw new Error('unexpected database');
    },
    async getDatabaseConfiguration(){ return {blockWrites:state.blockWrites}; },
    async setDatabaseBlockWrites(_name,value){ state.blockWrites=value; return {blockWrites:value}; },
    async createPitrDatabase(value){
      copyFileSync(sourcePath,restorePath);
      state.created=true;
      state.pitrAt=value.pitrAt;
      return {id:RESTORE_ID,name:value.name,hostname:'restore.test.turso.io'};
    },
    async createDatabaseToken(name){ return `token-for-${name}`; },
    async deleteDatabase(){ state.deleted=true; return {deleted:true}; },
  };
  const context={
    repository:'festus14/randori-circle',repositoryId:123456,
    workflowPath:'.github/workflows/turso-backup-restore-rehearsal.yml',
    workflowRef:'festus14/randori-circle/.github/workflows/turso-backup-restore-rehearsal.yml@refs/heads/main',
    workflowSha:COMMIT,runId:100,runAttempt:1,environment:'turso-migration-rehearsal',
    repoCommit:COMMIT,
  };
  const value=await runBackupRestoreRehearsal({
    platform,sourceDatabaseId:SOURCE_ID,sourceDatabaseName:'production',sourceGroup:'default',
    restoreDatabaseName:'restore-100-1',repoCommit:COMMIT,attestationContext:context,
    hmacKey:HMAC_KEY,confirmation:'RESTORE_DISPOSABLE_ONLY',maxSnapshotAgeMs:1_800_000,
    maxEvidenceAgeMs:1_800_000,rpoTargetMs:1_800_000,rtoTargetMs:900_000,
    clock:()=>NOW,poll:{maxAttempts:3,intervalMs:1},databaseOperationTimeoutMs:1_000,
    evidenceMaxDurationMs:1_000,expectedSourceBlockWrites:false,recoveryWriter:async()=>{},
    journalWriter:async()=>{},
  },{
    sleep:async()=>{},
    connectDatabase:async configuration=>createClient({
      url:`file:${configuration.role==='source'?sourcePath:restorePath}`,intMode:'bigint',
    }),
  });
  return {value,context};
}

function monitorEnvironment(directory,context){
  return {
    RUNNER_TEMP:directory,GITHUB_RUN_ID:'100',GITHUB_RUN_ATTEMPT:'1',
    GITHUB_REPOSITORY:context.repository,GITHUB_REPOSITORY_ID:String(context.repositoryId),
    GITHUB_WORKFLOW_REF:context.workflowRef,GITHUB_WORKFLOW_SHA:context.workflowSha,
    REHEARSAL_REPO_COMMIT:COMMIT,
    REHEARSAL_WORKFLOW_PATH:context.workflowPath,
    REHEARSAL_GITHUB_ENVIRONMENT:context.environment,
    TURSO_PRODUCTION_DATABASE_ID:SOURCE_ID,TURSO_PRODUCTION_DATABASE_NAME:'production',
    TURSO_GROUP:'default',MIGRATION_DIGEST_HMAC_KEY:HMAC_KEY,
    REHEARSAL_MAX_EVIDENCE_AGE_MS:'1800000',REHEARSAL_RPO_TARGET_MS:'1800000',
    REHEARSAL_RTO_TARGET_MS:'900000',BACKUP_MONITOR_MAX_SUCCESS_AGE_MS:'1800000',
  };
}

test('healthy signed evidence projects only RPO, RTO, checksums, and aggregate counts',()=>{
  const result=assessBackupRestoreRun({rehearsal:rehearsal(),cleanup},options());
  assert.deepEqual(result,{
    ok:true,kind:'turso-backup-monitor',format:BACKUP_MONITOR_FORMAT,status:'healthy',alert:false,
    category:null,checkedAt:'2026-09-21T03:30:00.000Z',owner:'repository-operations',
    cadence:'weekly',runId:100,runAttempt:1,repoCommit:COMMIT,
    objectives:{
      rpoTargetMs:1_800_000,rtoTargetMs:900_000,sourceSnapshotAgeMs:1_000,
      restoredSnapshotAgeMs:5_000,restoreDurationMs:4_000,
    },
    counts:{tableCount:37,totalRows:84,sequenceRows:8,appliedMigrationCount:2},
    checksums:{
      schemaManifest:DIGEST,sourceMigrations:DIGEST,finalMigrations:DIGEST,
      restoreComparison:DIGEST,
    },
    cleanup:{sourceWriteStateRestored:true,restoreDeleted:true},
  });
});

test('missing and stale rehearsal evidence raise distinct alerts without verification',()=>{
  let verified=false;
  assert.equal(assessBackupRestoreRun({rehearsal:null,cleanup},options()).category,'evidence_missing');
  const stale=assessBackupRestoreRun({
    rehearsal:rehearsal('2026-09-21T02:00:00.000Z'),cleanup,
  },options({verify:()=>{ verified=true; }}));
  assert.equal(stale.category,'evidence_stale');
  assert.equal(stale.alert,true);
  assert.equal(verified,false);
});

test('invalid signature or report shape raises a corrupt-evidence alert',()=>{
  const invalidSignature=assessBackupRestoreRun({rehearsal:rehearsal(),cleanup},options({
    verify:()=>{ throw new Error('signature contains secret-token@example.test'); },
  }));
  assert.equal(invalidSignature.category,'evidence_corrupt');
  const invalidCounts=assessBackupRestoreRun({rehearsal:rehearsal(),cleanup},options({
    verify:()=>({...payload(),verification:{...payload().verification,totalRows:-1}}),
  }));
  assert.equal(invalidCounts.category,'evidence_corrupt');
  assert.doesNotMatch(JSON.stringify({invalidSignature,invalidCounts}),/secret-token|@example\.test/);
});

test('monitor refuses recovery objectives weaker or stronger than the committed policy',()=>{
  for(const altered of [
    options({rpoTargetMs:3_600_000}),
    options({rtoTargetMs:1_800_000}),
    options({rpoTargetMs:900_000}),
    options({rtoTargetMs:450_000}),
  ]){
    const result=assessBackupRestoreRun({rehearsal:rehearsal(),cleanup},altered);
    assert.equal(result.category,'evidence_corrupt');
  }
});

test('cleanup failure overrides a nominal rehearsal and never calls the verifier',()=>{
  let verified=false;
  const result=assessBackupRestoreRun({
    rehearsal:rehearsal(),cleanup:{...cleanup,recoveryRequired:true,
      safety:{...cleanup.safety,restoreDeleted:false},private:'database-name-and-token'},
  },options({verify:()=>{ verified=true; }}));
  assert.equal(result.category,'cleanup_failure');
  assert.equal(result.alert,true);
  assert.equal(verified,false);
  assert.doesNotMatch(JSON.stringify(result),/database-name-and-token/);
});

test('cleanup evidence must bind the exact commit and complete safety shape',()=>{
  for(const unsafe of [
    {...cleanup,repoCommit:'f'.repeat(40)},
    {...cleanup,noState:true},
    {...cleanup,safety:{...cleanup.safety,restoreIdentityVerified:false}},
    {...cleanup,unexpected:'private-value'},
  ]){
    const result=assessBackupRestoreRun({rehearsal:rehearsal(),cleanup:unsafe},options());
    assert.equal(result.category,'cleanup_failure');
    assert.doesNotMatch(JSON.stringify(result),/private-value/);
  }
});

test('a sanitized failed rehearsal becomes an alert without echoing provider details',()=>{
  const result=assessBackupRestoreRun({
    rehearsal:{ok:false,error:'REHEARSAL_PLATFORM_FAILED',message:'token and row value',
      phase:'restore_create',private:'person@example.test'},cleanup,
  },options());
  assert.equal(result.category,'rehearsal_failure');
  assert.doesNotMatch(JSON.stringify(result),/token and row value|person@example\.test/);
});

test('CLI emits a missing-evidence artifact and bounded GitHub outputs without credentials',async()=>{
  const directory=mkdtempSync(join(tmpdir(),'randori-backup-monitor-'));
  cleanupDirectories.push(directory);
  mkdirSync(join(directory,'public-artifacts'),{mode:0o700});
  const githubOutput=join(directory,'github-output');
  writeFileSync(githubOutput,'',{mode:0o600});
  let stdout='';
  const execution=await main({
    argv:[
      '--rehearsal-summary',join(directory,'public-artifacts','rehearsal-summary.json'),
      '--cleanup-summary',join(directory,'public-artifacts','cleanup-summary.json'),
      '--output',join(directory,'public-artifacts','backup-monitor-summary.json'),
    ],
    environment:{
      RUNNER_TEMP:directory,GITHUB_OUTPUT:githubOutput,GITHUB_RUN_ID:'100',GITHUB_RUN_ATTEMPT:'1',
      REHEARSAL_REPO_COMMIT:COMMIT,
      TURSO_PRODUCTION_DATABASE_ID:'private-source-id',TURSO_PRODUCTION_DATABASE_NAME:'private-name',
      TURSO_GROUP:'private-group',MIGRATION_DIGEST_HMAC_KEY:'private-signing-key-value',
    },
    stdout:{write(value){ stdout+=value; }},clock:()=>NOW,
  });
  assert.equal(execution.exitCode,0);
  assert.equal(execution.result.category,'evidence_missing');
  assert.deepEqual(JSON.parse(stdout),execution.result);
  const artifact=readFileSync(join(directory,'public-artifacts','backup-monitor-summary.json'),'utf8');
  assert.deepEqual(JSON.parse(artifact),execution.result);
  assert.equal(readFileSync(githubOutput,'utf8'),'alert=true\ncategory=evidence_missing\n');
  assert.doesNotMatch(artifact,/private-source-id|private-name|private-group|private-signing-key-value/);
});

test('CLI verifies a production-generated attestation and rejects unsigned tampering',async()=>{
  const directory=mkdtempSync(join(tmpdir(),'randori-backup-monitor-integration-'));
  cleanupDirectories.push(directory);
  mkdirSync(join(directory,'public-artifacts'),{mode:0o700});
  const generated=await productionAttestation(directory);
  const rehearsalPath=join(directory,'public-artifacts','rehearsal-summary.json');
  const cleanupPath=join(directory,'public-artifacts','cleanup-summary.json');
  writeFileSync(rehearsalPath,JSON.stringify(generated.value),{mode:0o600});
  writeFileSync(cleanupPath,JSON.stringify(cleanup),{mode:0o600});

  const first=await main({
    argv:[
      '--rehearsal-summary',rehearsalPath,'--cleanup-summary',cleanupPath,
      '--output',join(directory,'public-artifacts','backup-monitor-summary.json'),
    ],
    environment:monitorEnvironment(directory,generated.context),
    stdout:{write(){}},clock:()=>NOW,
  });
  assert.equal(first.result.status,'healthy');

  const tampered=structuredClone(generated.value);
  tampered.payload.verification.totalRows+=1;
  const secondDirectory=join(directory,'tampered');
  mkdirSync(secondDirectory,{mode:0o700});
  mkdirSync(join(secondDirectory,'public-artifacts'),{mode:0o700});
  const tamperedRehearsal=join(secondDirectory,'public-artifacts','rehearsal-summary.json');
  const tamperedCleanup=join(secondDirectory,'public-artifacts','cleanup-summary.json');
  writeFileSync(tamperedRehearsal,JSON.stringify(tampered),{mode:0o600});
  writeFileSync(tamperedCleanup,JSON.stringify(cleanup),{mode:0o600});
  const second=await main({
    argv:[
      '--rehearsal-summary',tamperedRehearsal,'--cleanup-summary',tamperedCleanup,
      '--output',join(secondDirectory,'public-artifacts','backup-monitor-summary.json'),
    ],
    environment:monitorEnvironment(secondDirectory,generated.context),
    stdout:{write(){}},clock:()=>NOW,
  });
  assert.equal(second.result.category,'evidence_corrupt');
});

test('scheduled workflow runs the protected drill and emits a terminal sanitized alert',()=>{
  const workflow=readFileSync('.github/workflows/turso-backup-restore-rehearsal.yml','utf8');
  assert.match(workflow,/schedule:\n\s+- cron: '17 3 \* \* 1'/);
  assert.match(workflow,/github\.event_name == 'schedule'/);
  assert.match(workflow,/scripts\/turso-backup-restore-monitor\.mjs/);
  assert.match(workflow,/Alert on missing, stale, corrupt, failed, or unclean evidence/);
  assert.match(workflow,/steps\.monitor\.outputs\.alert != 'false'/);
  assert.match(workflow,/steps\.monitor\.outcome == 'success'/);
  assert.match(workflow,/retention-days: 30/);
  assert.doesNotMatch(workflow,/path:[^\n]*(?:private-recovery|state\.json)/);
});
