import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createClient } from '@libsql/client';

import { EXECUTABLE_MIGRATIONS } from '../../db/executable-migrations.js';
import { GitHubActionsError } from '../../db/github-actions-artifact.js';
import { applyMigrations, inspectMigrationState } from '../../db/migration-runner.js';
import { TursoPlatformError } from '../../db/turso-platform.js';
import { RehearsalError } from '../../scripts/turso-backup-restore-rehearsal.mjs';
import {
  RemoteMigrationError,
  main,
  publicRemoteMigrationError,
  runRemoteMigration,
  validateWorkflowRuntime,
} from '../../scripts/turso-production-migrate.mjs';

const SOURCE_ID='11111111-1111-4111-8111-111111111111';
const COMMIT='0123456789abcdef0123456789abcdef01234567';
const RUN_ID=987654321;
const ATTEMPT=2;
const REPOSITORY='festus14/randori-circle';
const NOW=Date.parse('2026-09-18T12:00:00.000Z');
const FAST_RETRY=Object.freeze({maxAttempts:1,baseDelayMs:0,maxDelayMs:0});

function fixture(){
  const directory=mkdtempSync(join(tmpdir(),'randori-remote-migrate-'));
  const path=join(directory,'production.db');
  return {directory,path,close(){ rmSync(directory,{recursive:true,force:true}); }};
}

async function installManaged(path,version){
  const db=createClient({url:`file:${path}`,intMode:'bigint'});
  const migrations=EXECUTABLE_MIGRATIONS.slice(0,version);
  try{
    const state=await inspectMigrationState(db,{migrations});
    await applyMigrations(db,{
      expectedStateFingerprint:state.stateFingerprint,migrations,retry:FAST_RETRY,
    });
  }finally{ db.close(); }
}

async function installUnmanaged(path,version){
  const db=createClient({url:`file:${path}`,intMode:'bigint'});
  try{
    for(const migration of EXECUTABLE_MIGRATIONS.slice(0,version)){
      for(const operation of migration.operations) await db.execute(operation.sql);
    }
  }finally{ db.close(); }
}

async function state(path,migrations=EXECUTABLE_MIGRATIONS){
  const db=createClient({url:`file:${path}`,intMode:'bigint'});
  try{ return await inspectMigrationState(db,{migrations}); }
  finally{ db.close(); }
}

function options(overrides={}){
  const operation=overrides.operation??'status';
  return {
    operation,
    confirmation:operation==='status'?'INSPECT_PRODUCTION_DATABASE':'MIGRATE_PRODUCTION_DATABASE',
    mutationsEnabled:'true',
    expectedStateFingerprint:operation==='status'?'':overrides.expectedStateFingerprint,
    sourceDatabaseId:SOURCE_ID,
    sourceDatabaseName:'production',
    sourceGroup:'default',
    expectedSourceBlockWrites:false,
    repository:REPOSITORY,
    repositoryId:123456,
    repoCommit:COMMIT,
    runId:RUN_ID,
    runAttempt:ATTEMPT,
    maxAttestationAgeMs:30*60*1000,
    rpoTargetMs:30*60*1000,
    rtoTargetMs:15*60*1000,
    databaseTimeoutMs:1000,
    hmacKey:'remote-migration-evidence-key-32-bytes',
    clock:()=>NOW,
    ...overrides,
  };
}

function attestation(classification='managed',sourceVersion=3){
  return Object.freeze({
    issuedAt:'2026-09-18T11:55:00.000Z',
    validUntil:'2026-09-18T12:25:00.000Z',
    migration:{sourceClassification:classification,sourceVersion,finalVersion:4},
    identities:{
      sourceIdentityDigest:'a'.repeat(64),restoreIdentityDigest:'b'.repeat(64),
    },
  });
}

function platformMock(overrides={}){
  const calls=[];
  const source={
    id:SOURCE_ID,name:'production',hostname:'production.test.turso.io',group:'default',
    blockWrites:false,parent:null,
  };
  return {
    calls,
    async getDatabase(name){
      calls.push(['database',name]);
      if(overrides.getDatabase) return overrides.getDatabase(source,calls);
      return source;
    },
    async getDatabaseConfiguration(name){
      calls.push(['configuration',name]);
      if(overrides.getConfiguration) return overrides.getConfiguration(calls);
      return {blockWrites:false};
    },
    async createDatabaseToken(name,configuration){
      calls.push(['token',name,configuration]);
      if(overrides.createToken) return overrides.createToken(calls);
      return 'database-token-that-must-never-leak';
    },
  };
}

function dependencies(path,{classification='managed',sourceVersion=3,platform,connectDatabase}={}){
  const calls=[];
  const github={
    async downloadSuccessfulWorkflowArtifact(value){
      calls.push(['github',value]);
      return {
        run:{conclusion:'success'},artifact:{name:value.artifactName},archive:new Uint8Array([1]),
      };
    },
  };
  const verifyCalls=[];
  return {
    calls,
    verifyCalls,
    value:{
      github,
      platform:platform??platformMock(),
      extractArtifact(_archive,value){
        calls.push(['extract',value]);
        return {signed:'envelope'};
      },
      verifyAttestation(envelope,value){
        verifyCalls.push({envelope,value});
        return attestation(classification,sourceVersion);
      },
      connectDatabase:connectDatabase??(configuration=>{
        calls.push(['connect',{...configuration,authToken:'[redacted]'}]);
        return createClient({url:`file:${path}`,intMode:'bigint'});
      }),
    },
  };
}

test('status uses a read-only token and returns one actionable pending migration',async()=>{
  const item=fixture();
  try{
    await installManaged(item.path,7);
    const platform=platformMock();
    const deps=dependencies(item.path,{platform});
    const result=await runRemoteMigration(options(),deps.value);
    assert.equal(result.ok,true);
    assert.equal(result.operation,'status');
    assert.equal(result.readOnly,true);
    assert.equal(result.state,'managed');
    assert.equal(result.currentVersion,7);
    assert.deepEqual(result.pendingVersions,[8]);
    assert.deepEqual(result.capabilities,{adopt:false,apply:true});
    assert.match(result.stateFingerprint,/^[a-f0-9]{64}$/);
    assert.deepEqual(platform.calls.filter(call=>call[0]==='token'),[
      ['token','production',{expiration:'10m',authorization:'read-only'}],
    ]);
    assert.equal(
      platform.calls.findIndex(call=>call[0]==='token')
        >platform.calls.findLastIndex((call,index)=>index<2&&call[0]!=='token'),
      true,
    );
    assert.deepEqual(deps.verifyCalls[0].value.context,{
      repository:REPOSITORY,repositoryId:123456,
      workflowPath:'.github/workflows/turso-backup-restore-rehearsal.yml',
      workflowRef:`${REPOSITORY}/.github/workflows/turso-backup-restore-rehearsal.yml@refs/heads/main`,
      workflowSha:COMMIT,runId:RUN_ID,runAttempt:ATTEMPT,
      environment:'turso-migration-rehearsal',repoCommit:COMMIT,
    });
    assert.equal(deps.verifyCalls[0].value.sourceIdentity,SOURCE_ID);
    assert.equal(
      deps.verifyCalls[0].value.backupRef,
      `turso-pitr:${SOURCE_ID}:production:default`,
    );
    const serialized=JSON.stringify(result);
    for(const secret of [
      SOURCE_ID,'production.test.turso.io','database-token-that-must-never-leak',
    ]) assert.equal(serialized.includes(secret),false,`result leaked ${secret}`);
  }finally{ item.close(); }
});

test('apply advances one managed version per run and a fully migrated run is an explicit no-op',async()=>{
  const item=fixture();
  try{
    await installManaged(item.path,7);
    const fingerprint=(await state(item.path)).stateFingerprint;
    const platform=platformMock();
    const first=await runRemoteMigration(options({
      operation:'apply',expectedStateFingerprint:fingerprint,
    }),dependencies(item.path,{platform}).value);
    assert.equal(first.result,'applied');
    assert.deepEqual(first.appliedVersions,[8]);
    assert.equal(first.fromVersion,7);
    assert.equal(first.toVersion,8);
    assert.equal((await state(item.path)).currentVersion,8);
    assert.deepEqual(platform.calls.filter(call=>call[0]==='token'),[
      ['token','production',{expiration:'10m',authorization:'full-access'}],
    ]);

    const second=await runRemoteMigration(options({
      operation:'apply',expectedStateFingerprint:first.stateFingerprint,
    }),dependencies(item.path).value);
    assert.equal(second.result,'noop');
    assert.deepEqual(second.appliedVersions,[]);
    assert.equal(second.fromVersion,8);
    assert.equal(second.toVersion,8);
  }finally{ item.close(); }
});

test('an exact rehearsed unmanaged prefix can be adopted without applying the next version',async()=>{
  const item=fixture();
  try{
    await installUnmanaged(item.path,2);
    const prefix=EXECUTABLE_MIGRATIONS.slice(0,2);
    const fingerprint=(await state(item.path,prefix)).stateFingerprint;
    const result=await runRemoteMigration(options({
      operation:'adopt',expectedStateFingerprint:fingerprint,
    }),dependencies(item.path,{classification:'unmanaged',sourceVersion:2}).value);
    assert.equal(result.result,'adopted');
    assert.deepEqual(result.adoptedVersions,[1,2]);
    assert.equal(result.toVersion,2);
    const after=await state(item.path);
    assert.equal(after.classification,'managed');
    assert.equal(after.currentVersion,2);
    assert.equal(after.ready,true);
  }finally{ item.close(); }
});

test('mutation disablement and invalid fingerprints fail before evidence or provider access',async()=>{
  const item=fixture();
  try{
    const platform=platformMock();
    const deps=dependencies(item.path,{platform});
    await assert.rejects(
      runRemoteMigration(options({
        operation:'apply',expectedStateFingerprint:'a'.repeat(64),mutationsEnabled:'false',
      }),deps.value),
      error=>error.code==='REMOTE_MIGRATION_DISABLED',
    );
    await assert.rejects(
      runRemoteMigration(options({operation:'adopt',expectedStateFingerprint:'bad'}),deps.value),
      error=>error.code==='REMOTE_MIGRATION_INVALID',
    );
    assert.deepEqual(deps.calls,[]);
    assert.deepEqual(platform.calls,[]);
  }finally{ item.close(); }
});

test('failed or replayed rehearsal evidence is refused before Turso is queried',async()=>{
  const item=fixture();
  try{
    const platform=platformMock();
    const deps=dependencies(item.path,{platform});
    deps.value.verifyAttestation=()=>{
      throw new RehearsalError(
        'REHEARSAL_ATTESTATION_INVALID',`invalid ${SOURCE_ID}`,{phase:'complete'},
      );
    };
    await assert.rejects(
      runRemoteMigration(options(),deps.value),
      error=>error.code==='REMOTE_MIGRATION_EVIDENCE_INVALID',
    );
    assert.deepEqual(platform.calls,[]);

    deps.value.github.downloadSuccessfulWorkflowArtifact=()=>{
      throw new GitHubActionsError('GITHUB_ACTIONS_ARTIFACT_INVALID','wrong run');
    };
    await assert.rejects(
      runRemoteMigration(options(),deps.value),
      error=>error.code==='REMOTE_MIGRATION_EVIDENCE_INVALID',
    );
    assert.deepEqual(platform.calls,[]);
  }finally{ item.close(); }
});

test('exact provider ID, name, group, parent, metadata, and configuration are checked before token mint',async()=>{
  const item=fixture();
  try{
    for(const overrides of [
      {getDatabase:source=>({...source,id:'wrong'})},
      {getDatabase:source=>({...source,name:'other'})},
      {getDatabase:source=>({...source,group:'other'})},
      {getDatabase:source=>({...source,parent:{id:'restore'}})},
      {getDatabase:source=>({...source,blockWrites:true})},
      {getConfiguration:()=>({blockWrites:true})},
    ]){
      const platform=platformMock(overrides);
      await assert.rejects(
        runRemoteMigration(options(),dependencies(item.path,{platform}).value),
        error=>error.code==='REMOTE_MIGRATION_TARGET_IDENTITY_MISMATCH',
      );
      assert.equal(platform.calls.some(call=>call[0]==='token'),false);
    }
  }finally{ item.close(); }
});

test('a provider identity change after token mint is refused before database connection',async()=>{
  const item=fixture();
  try{
    let reads=0;
    const platform=platformMock({
      getDatabase(source){
        reads+=1;
        return reads===1?source:{...source,id:'replacement-database-id'};
      },
    });
    let connected=false;
    await assert.rejects(
      runRemoteMigration(options(),dependencies(item.path,{
        platform,
        connectDatabase:()=>{ connected=true; throw new Error('must not connect'); },
      }).value),
      error=>error.code==='REMOTE_MIGRATION_TARGET_IDENTITY_MISMATCH',
    );
    assert.equal(platform.calls.filter(call=>call[0]==='token').length,1);
    assert.equal(connected,false);
  }finally{ item.close(); }
});

test('stale state, unadopted state, and more than one pending migration never write',async()=>{
  const stale=fixture();
  const unmanaged=fixture();
  const old=fixture();
  try{
    await installManaged(stale.path,3);
    await assert.rejects(
      runRemoteMigration(options({
        operation:'apply',expectedStateFingerprint:'f'.repeat(64),
      }),dependencies(stale.path).value),
      error=>error instanceof Error&&error.code==='MIGRATION_STATE_CHANGED',
    );
    assert.equal((await state(stale.path)).currentVersion,3);

    await installUnmanaged(unmanaged.path,2);
    const unmanagedFingerprint=(await state(
      unmanaged.path,EXECUTABLE_MIGRATIONS.slice(0,2),
    )).stateFingerprint;
    await assert.rejects(
      runRemoteMigration(options({
        operation:'apply',expectedStateFingerprint:unmanagedFingerprint,
      }),dependencies(unmanaged.path,{classification:'unmanaged',sourceVersion:2}).value),
      error=>error.code==='REMOTE_MIGRATION_TARGET_STATE_MISMATCH',
    );
    assert.equal((await state(
      unmanaged.path,EXECUTABLE_MIGRATIONS.slice(0,2),
    )).ledgerPresent,false);

    await installManaged(old.path,1);
    const oldFingerprint=(await state(old.path)).stateFingerprint;
    await assert.rejects(
      runRemoteMigration(options({
        operation:'apply',expectedStateFingerprint:oldFingerprint,
      }),dependencies(old.path,{sourceVersion:1}).value),
      error=>error.code==='REMOTE_MIGRATION_TOO_MANY_PENDING',
    );
    assert.equal((await state(old.path)).currentVersion,1);
  }finally{
    stale.close();
    unmanaged.close();
    old.close();
  }
});

test('an ambiguous commit failure is not retried and the transaction rolls back',async()=>{
  const item=fixture();
  try{
    await installManaged(item.path,7);
    const fingerprint=(await state(item.path)).stateFingerprint;
    let transactions=0;
    const connectDatabase=()=>{
      const client=createClient({url:`file:${item.path}`,intMode:'bigint'});
      return {
        execute:statement=>client.execute(statement),
        batch:(...args)=>client.batch(...args),
        async transaction(mode){
          transactions+=1;
          const transaction=await client.transaction(mode);
          return new Proxy(transaction,{
            get(target,property){
              if(property==='commit') return async()=>{
                throw Object.assign(new Error('secret ambiguous commit detail'),{code:'SQLITE_BUSY'});
              };
              const value=target[property];
              return typeof value==='function'?value.bind(target):value;
            },
          });
        },
        close:()=>client.close(),
      };
    };
    await assert.rejects(
      runRemoteMigration(options({
        operation:'apply',expectedStateFingerprint:fingerprint,
      }),dependencies(item.path,{connectDatabase}).value),
      error=>error.code==='MIGRATION_FAILED',
    );
    assert.equal(transactions,1);
    assert.equal((await state(item.path)).currentVersion,7);
  }finally{ item.close(); }
});

test('provider and unexpected failures produce constant redacted public results',()=>{
  const provider=new TursoPlatformError(
    'TURSO_PLATFORM_FAILED',`provider leaked ${SOURCE_ID} database-token-that-must-never-leak`,
  );
  const result=publicRemoteMigrationError(provider,{operation:'apply',repoCommit:COMMIT});
  assert.equal(result.error,'REMOTE_MIGRATION_PLATFORM_FAILED');
  assert.equal(JSON.stringify(result).includes(SOURCE_ID),false);
  assert.equal(JSON.stringify(result).includes('database-token-that-must-never-leak'),false);
  const unexpected=publicRemoteMigrationError(new Error(`SQL ${SOURCE_ID}`),{operation:'status'});
  assert.deepEqual(unexpected,{
    ok:false,kind:'turso-production-migration',format:'randori.turso-production-migration.v1',
    operation:'status',error:'REMOTE_MIGRATION_FAILED',
    message:'The protected remote migration failed.',
  });
});

test('CLI writes one sanitized artifact and mutations remain disabled by an absent flag',async()=>{
  const item=fixture();
  const output=[];
  try{
    const result=await main({
      argv:[
        '--operation','apply','--rehearsal-run-id',String(RUN_ID),
        '--rehearsal-run-attempt',String(ATTEMPT),'--expected-state','a'.repeat(64),
        '--artifact-dir',join(item.directory,'public-artifacts'),
      ],
      environment:{
        RUNNER_TEMP:item.directory,MIGRATION_REPO_COMMIT:COMMIT,
        PRODUCTION_MIGRATION_CONFIRM:'MIGRATE_PRODUCTION_DATABASE',
        TURSO_PRODUCTION_MIGRATIONS_ENABLED:'false',
        TURSO_PRODUCTION_DATABASE_ID:SOURCE_ID,TURSO_PRODUCTION_DATABASE_NAME:'production',
        TURSO_GROUP:'default',TURSO_PRODUCTION_EXPECTED_BLOCK_WRITES:'false',
        GITHUB_REPOSITORY:REPOSITORY,GITHUB_REPOSITORY_ID:'123456',
        MIGRATION_REHEARSAL_MAX_AGE_MS:String(30*60*1000),
        REHEARSAL_RPO_TARGET_MS:String(30*60*1000),
        REHEARSAL_RTO_TARGET_MS:String(15*60*1000),TURSO_DATABASE_TIMEOUT_MS:'1000',
        MIGRATION_DIGEST_HMAC_KEY:'x'.repeat(32),GITHUB_TOKEN:'x'.repeat(20),
        GITHUB_API_TIMEOUT_MS:'1000',TURSO_ORGANIZATION:'org',
        TURSO_PRODUCTION_PLATFORM_TOKEN:'x'.repeat(20),TURSO_PLATFORM_TIMEOUT_MS:'1000',
      },
      stdout:{write:value=>output.push(value)},
      createGitHub:()=>({downloadSuccessfulWorkflowArtifact(){
        throw new Error('must not query GitHub while disabled');
      }}),
      createPlatform:()=>({}),
      run:runRemoteMigration,
    });
    assert.equal(result.exitCode,2);
    assert.equal(result.result.error,'REMOTE_MIGRATION_DISABLED');
    const artifact=JSON.parse(readFileSync(
      join(item.directory,'public-artifacts','migration-result.json'),'utf8',
    ));
    assert.deepEqual(artifact,result.result);
    assert.equal(output.length,1);
  }finally{ item.close(); }
});

test('workflow is manual, protected, serialized, pinned, and keeps credentials step-scoped',()=>{
  const workflow=readFileSync('.github/workflows/turso-production-migration.yml','utf8');
  assert.match(workflow,/workflow_dispatch:/);
  assert.doesNotMatch(workflow,/\n\s+(?:push|pull_request|schedule):/);
  assert.match(workflow,/environment: turso-production-migration/);
  assert.match(workflow,/group: turso-production-database-operations/);
  assert.match(workflow,/actions: read/);
  assert.match(workflow,/TURSO_PRODUCTION_MIGRATIONS_ENABLED/);
  assert.match(workflow,/MIGRATE_PRODUCTION_DATABASE/);
  assert.match(workflow,/\^\[a-f0-9\]\{64\}\$/);
  assert.doesNotMatch(workflow,/uses: actions\/(?:checkout|setup-node|upload-artifact)@v\d/);
  const beforeMigration=workflow.slice(0,workflow.indexOf('- name: Run protected remote migration operation'));
  assert.equal(beforeMigration.includes('TURSO_PRODUCTION_PLATFORM_TOKEN:'),false);
  assert.equal(beforeMigration.includes('MIGRATION_DIGEST_HMAC_KEY:'),false);
  assert.equal(beforeMigration.includes('GITHUB_TOKEN:'),false);
  const rehearsal=readFileSync('.github/workflows/turso-backup-restore-rehearsal.yml','utf8');
  assert.match(rehearsal,/group: turso-production-database-operations/);
});

test('configuration validation rejects operation, confirmation, identity, and status fingerprints',async()=>{
  const item=fixture();
  try{
    const cases=[
      options({operation:'destroy',confirmation:'MIGRATE_PRODUCTION_DATABASE'}),
      options({confirmation:'wrong'}),
      options({expectedStateFingerprint:'a'.repeat(64)}),
      options({sourceDatabaseName:'Production'}),
      options({expectedSourceBlockWrites:'yes'}),
      options({repoCommit:'main'}),
    ];
    for(const value of cases){
      await assert.rejects(
        runRemoteMigration(value,dependencies(item.path).value),
        error=>error instanceof RemoteMigrationError
          &&error.code==='REMOTE_MIGRATION_INVALID',
      );
    }
  }finally{ item.close(); }
});

test('only the exact manually dispatched protected main workflow is a valid CLI runtime',()=>{
  const runtime={
    GITHUB_ACTIONS:'true',GITHUB_EVENT_NAME:'workflow_dispatch',
    GITHUB_REF:'refs/heads/main',GITHUB_REPOSITORY:REPOSITORY,
    GITHUB_WORKFLOW_REF:`${REPOSITORY}/.github/workflows/turso-production-migration.yml@refs/heads/main`,
    GITHUB_WORKFLOW_SHA:COMMIT,GITHUB_RUN_ID:'456',GITHUB_RUN_ATTEMPT:'1',
    MIGRATION_GITHUB_ENVIRONMENT:'turso-production-migration',
  };
  assert.equal(validateWorkflowRuntime(runtime,COMMIT),true);
  for(const patch of [
    {GITHUB_ACTIONS:'false'},
    {GITHUB_EVENT_NAME:'push'},
    {GITHUB_REF:'refs/heads/feature'},
    {GITHUB_WORKFLOW_REF:`${REPOSITORY}/.github/workflows/e2e.yml@refs/heads/main`},
    {GITHUB_WORKFLOW_SHA:'f'.repeat(40)},
    {GITHUB_RUN_ID:'0'},
    {MIGRATION_GITHUB_ENVIRONMENT:'preview'},
  ]){
    assert.throws(
      ()=>validateWorkflowRuntime({...runtime,...patch},COMMIT),
      error=>error.code==='REMOTE_MIGRATION_INVALID',
    );
  }
});
