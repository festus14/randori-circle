import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, test } from 'node:test';

import { GitHubActionsError } from '../../db/github-actions-artifact.js';
import { MigrationError } from '../../db/migration-runner.js';
import { TursoPlatformError } from '../../db/turso-platform.js';
import { main, RemoteMigrationError, runRemoteMigration } from '../../scripts/turso-production-migrate.mjs';

const SOURCE_ID='11111111-1111-4111-8111-111111111111';
const COMMIT='0123456789abcdef0123456789abcdef01234567';
const REPOSITORY='festus14/randori-circle';
const SECRET='platform-token-that-must-never-leak';
const cleanup=[];

afterEach(()=>{ while(cleanup.length) cleanup.pop()(); });

function runnerTemp(){
  const directory=realpathSync(mkdtempSync(join(tmpdir(),'randori-cov-migrate-')));
  cleanup.push(()=>rmSync(directory,{recursive:true,force:true}));
  return directory;
}

function workflowEnvironment(temp,overrides={}){
  return {
    RUNNER_TEMP:temp,MIGRATION_REPO_COMMIT:COMMIT,
    GITHUB_ACTIONS:'true',GITHUB_EVENT_NAME:'workflow_dispatch',GITHUB_REF:'refs/heads/main',
    GITHUB_REPOSITORY:REPOSITORY,GITHUB_REPOSITORY_ID:'123456',
    GITHUB_WORKFLOW_REF:`${REPOSITORY}/.github/workflows/turso-production-migration.yml@refs/heads/main`,
    GITHUB_WORKFLOW_SHA:COMMIT,GITHUB_RUN_ID:'456',GITHUB_RUN_ATTEMPT:'1',
    MIGRATION_GITHUB_ENVIRONMENT:'turso-production-migration',
    PRODUCTION_MIGRATION_CONFIRM:'INSPECT_PRODUCTION_DATABASE',
    TURSO_PRODUCTION_MIGRATIONS_ENABLED:'false',
    TURSO_PRODUCTION_DATABASE_ID:SOURCE_ID,TURSO_PRODUCTION_DATABASE_NAME:'production',
    TURSO_GROUP:'default',TURSO_PRODUCTION_EXPECTED_BLOCK_WRITES:'false',
    MIGRATION_REHEARSAL_MAX_AGE_MS:String(30*60*1000),
    REHEARSAL_RPO_TARGET_MS:String(30*60*1000),REHEARSAL_RTO_TARGET_MS:String(15*60*1000),
    TURSO_DATABASE_TIMEOUT_MS:'1000',MIGRATION_DIGEST_HMAC_KEY:'k'.repeat(32),
    GITHUB_TOKEN:'github-token-that-must-never-leak',GITHUB_API_TIMEOUT_MS:'1500',
    TURSO_ORGANIZATION:'org',TURSO_PRODUCTION_PLATFORM_TOKEN:SECRET,TURSO_PLATFORM_TIMEOUT_MS:'2500',
    ...overrides,
  };
}

function statusArgv(temp,{operation='status',name='public-artifacts'}={}){
  return ['--operation',operation,'--rehearsal-run-id','987','--rehearsal-run-attempt','2',
    '--expected-state','','--target-version','','--artifact-dir',join(temp,name)];
}

async function invoke({argv,environment,run,createGitHub,createPlatform}){
  const output=[];
  const created={};
  const execution=await main({
    argv,environment,
    stdout:{write:value=>output.push(value)},
    createGitHub:createGitHub??(value=>{ created.github=value; return {github:true}; }),
    createPlatform:createPlatform??(value=>{ created.platform=value; return {platform:true}; }),
    run:run??(async()=>{ throw new Error('run must not be called'); }),
    connectDatabase:()=>{ throw new Error('must not connect'); },
  });
  return {...execution,output,created};
}

test('a valid workflow runtime maps protected environment values into the migration run',async()=>{
  const temp=runnerTemp();
  let received;
  const {result,exitCode,output,created}=await invoke({
    argv:statusArgv(temp),
    environment:workflowEnvironment(temp),
    run:async(options,adapters)=>{
      received={options,adapters};
      return {ok:true,kind:'turso-production-migration',operation:'status',readOnly:true};
    },
  });
  assert.equal(exitCode,0);
  assert.equal(result.ok,true);
  assert.deepEqual(created.github,{repository:REPOSITORY,token:'github-token-that-must-never-leak',timeoutMs:1500});
  assert.deepEqual(created.platform,{organization:'org',token:SECRET,timeoutMs:2500});
  assert.deepEqual(received.adapters.github,{github:true});
  assert.deepEqual(received.adapters.platform,{platform:true});
  assert.equal(typeof received.adapters.connectDatabase,'function');
  const options=received.options;
  assert.equal(options.operation,'status');
  assert.equal(options.runId,'987');
  assert.equal(options.runAttempt,'2');
  assert.equal(options.confirmation,'INSPECT_PRODUCTION_DATABASE');
  assert.equal(options.sourceDatabaseId,SOURCE_ID);
  assert.equal(options.sourceDatabaseName,'production');
  assert.equal(options.sourceGroup,'default');
  assert.equal(options.expectedSourceBlockWrites,'false');
  assert.equal(options.repositoryId,'123456');
  assert.equal(options.repoCommit,COMMIT);
  assert.equal(options.databaseTimeoutMs,'1000');
  assert.equal(options.hmacKey,'k'.repeat(32));

  const artifactPath=join(temp,'public-artifacts','migration-result.json');
  assert.deepEqual(JSON.parse(readFileSync(artifactPath,'utf8')),result);
  assert.equal(statSync(artifactPath).mode&0o777,0o600);
  assert.equal(output.length,1);
  assert.deepEqual(JSON.parse(output[0]),result);
});

test('refusals exit 2 while unexpected failures exit 1 with a constant redacted message',async()=>{
  const cases=[
    [new RemoteMigrationError('REMOTE_MIGRATION_TARGET_IDENTITY_MISMATCH','identity'),2,
      'REMOTE_MIGRATION_TARGET_IDENTITY_MISMATCH'],
    [new MigrationError('MIGRATION_STATE_CHANGED','fingerprint mismatch'),2,'MIGRATION_STATE_CHANGED'],
    [new TursoPlatformError('TURSO_PLATFORM_FAILED',`leaked ${SECRET}`),1,'REMOTE_MIGRATION_PLATFORM_FAILED'],
    [new GitHubActionsError('GITHUB_ARTIFACT_INVALID',`leaked ${SECRET}`),2,'REMOTE_MIGRATION_EVIDENCE_INVALID'],
    [new Error(`libsql://production.turso.io?authToken=${SECRET}`),1,'REMOTE_MIGRATION_FAILED'],
    [new RemoteMigrationError('NOT_A_PUBLIC_CODE',SECRET),1,'REMOTE_MIGRATION_FAILED'],
  ];
  for(const [error,expectedExit,expectedCode] of cases){
    const temp=runnerTemp();
    const {result,exitCode,output}=await invoke({
      argv:statusArgv(temp),environment:workflowEnvironment(temp),run:async()=>{ throw error; },
    });
    assert.equal(exitCode,expectedExit,expectedCode);
    assert.equal(result.error,expectedCode);
    assert.equal(result.operation,'status');
    assert.equal(result.repoCommit,COMMIT);
    assert.doesNotMatch(output[0],new RegExp(SECRET));
    assert.deepEqual(JSON.parse(readFileSync(join(temp,'public-artifacts','migration-result.json'),'utf8')),result);
  }
});

test('malformed usage fails before any artifact directory is created',async()=>{
  const temp=runnerTemp();
  const argv=statusArgv(temp);
  const variants=[
    [],
    argv.slice(0,10),
    ['--unknown',...argv.slice(1)],
    [...argv.slice(0,2),'--operation','status',...argv.slice(4)],
    ['--operation','',...argv.slice(2)],
    [...argv.slice(0,11),42],
    'not-an-array',
  ];
  for(const value of variants){
    const {result,exitCode}=await invoke({argv:value,environment:workflowEnvironment(temp)});
    assert.equal(exitCode,1,JSON.stringify(value));
    assert.equal(result.error,'REMOTE_MIGRATION_INVALID');
    assert.equal(result.repoCommit,undefined,'the commit is only echoed once usage parsed');
  }
  assert.equal(existsSync(join(temp,'public-artifacts')),false);
});

test('artifact directories must be a fresh public-artifacts child of an absolute RUNNER_TEMP',async()=>{
  const temp=runnerTemp();
  const outside=runnerTemp();
  const cases=[
    [statusArgv(temp),workflowEnvironment(temp,{RUNNER_TEMP:'relative/temp'}),'REMOTE_MIGRATION_INVALID'],
    [statusArgv(temp),workflowEnvironment(temp,{RUNNER_TEMP:undefined}),'REMOTE_MIGRATION_INVALID'],
    [statusArgv(outside),workflowEnvironment(temp),'REMOTE_MIGRATION_INVALID'],
    [statusArgv(temp,{name:'other-name'}),workflowEnvironment(temp),'REMOTE_MIGRATION_INVALID'],
    [statusArgv(temp,{name:'nested/public-artifacts'}),workflowEnvironment(temp),'REMOTE_MIGRATION_INVALID'],
    [['--operation','status','--rehearsal-run-id','1','--rehearsal-run-attempt','1','--expected-state','',
      '--target-version','','--artifact-dir','public-artifacts'],workflowEnvironment(temp),'REMOTE_MIGRATION_INVALID'],
  ];
  for(const [argv,environment,expected] of cases){
    const {result,exitCode}=await invoke({argv,environment});
    assert.equal(exitCode,1);
    assert.equal(result.error,expected);
  }
  assert.equal(existsSync(join(temp,'other-name')),false);

  mkdirSync(join(temp,'public-artifacts'));
  const existing=await invoke({argv:statusArgv(temp),environment:workflowEnvironment(temp)});
  assert.equal(existing.exitCode,1,'a pre-existing artifact directory is never reused');
  assert.equal(existing.result.error,'REMOTE_MIGRATION_FAILED');
});

test('mutations require the protected enable flag and workflow identity before adapters are built',async()=>{
  const temp=runnerTemp();
  const disabled=await invoke({
    argv:statusArgv(temp,{operation:'adopt'}),
    environment:workflowEnvironment(temp),
    createGitHub:()=>{ throw new Error('must not build adapters'); },
  });
  assert.equal(disabled.exitCode,2);
  assert.equal(disabled.result.error,'REMOTE_MIGRATION_DISABLED');
  assert.equal(disabled.result.operation,'adopt');

  const other=runnerTemp();
  const wrongRef=await invoke({
    argv:statusArgv(other),
    environment:workflowEnvironment(other,{GITHUB_REF:'refs/heads/feature'}),
    createGitHub:()=>{ throw new Error('must not build adapters'); },
  });
  assert.equal(wrongRef.exitCode,1);
  assert.equal(wrongRef.result.error,'REMOTE_MIGRATION_INVALID');

  const third=runnerTemp();
  const badTimeout=await invoke({
    argv:statusArgv(third),environment:workflowEnvironment(third,{GITHUB_API_TIMEOUT_MS:'60001'}),
  });
  assert.equal(badTimeout.result.error,'REMOTE_MIGRATION_INVALID');
  const fourth=runnerTemp();
  const badPlatformTimeout=await invoke({
    argv:statusArgv(fourth),environment:workflowEnvironment(fourth,{TURSO_PLATFORM_TIMEOUT_MS:'0'}),
  });
  assert.equal(badPlatformTimeout.result.error,'REMOTE_MIGRATION_INVALID');
});

// ------------------------------------------------------- runRemoteMigration ---

function options(overrides={}){
  return {
    operation:'status',confirmation:'INSPECT_PRODUCTION_DATABASE',mutationsEnabled:'true',
    expectedStateFingerprint:'',targetVersion:'',
    sourceDatabaseId:SOURCE_ID,sourceDatabaseName:'production',sourceGroup:'default',
    expectedSourceBlockWrites:'false',repository:REPOSITORY,repositoryId:'123456',repoCommit:COMMIT,
    runId:'987',runAttempt:'2',maxAttestationAgeMs:String(30*60*1000),
    rpoTargetMs:String(30*60*1000),rtoTargetMs:String(15*60*1000),databaseTimeoutMs:'1000',
    hmacKey:'k'.repeat(32),
    ...overrides,
  };
}

function adapters({hostname='production.test.turso.io',createToken,connectDatabase}={}){
  const calls=[];
  const database={id:SOURCE_ID,name:'production',group:'default',parent:null,blockWrites:false,hostname};
  return {
    calls,
    value:{
      github:{async downloadSuccessfulWorkflowArtifact(){
        calls.push('download');
        return {run:{conclusion:'success'},archive:new Uint8Array([1])};
      }},
      platform:{
        async getDatabase(){ calls.push('database'); return database; },
        async getDatabaseConfiguration(){ return {blockWrites:false}; },
        async createDatabaseToken(...args){
          calls.push('token');
          return createToken?createToken(...args):SECRET;
        },
      },
      extractArtifact:()=>({signed:'envelope'}),
      verifyAttestation:()=>({
        issuedAt:'2026-09-18T11:55:00.000Z',validUntil:'2026-09-18T12:25:00.000Z',
        migration:{sourceClassification:'managed',sourceVersion:3,sourceStateFingerprint:'a'.repeat(64)},
      }),
      connectDatabase:connectDatabase??(()=>{ throw new Error('must not connect'); }),
    },
  };
}

test('invalid adapters are refused before any evidence is fetched',async()=>{
  const base=adapters().value;
  const variants=[
    {},
    {...base,github:{}},
    {...base,platform:{getDatabase(){},getDatabaseConfiguration(){}}},
    {...base,connectDatabase:'libsql://x'},
    {...base,extractArtifact:'not-a-function'},
    {...base,verifyAttestation:42},
  ];
  for(const dependencies of variants){
    await assert.rejects(runRemoteMigration(options(),dependencies),
      error=>error instanceof RemoteMigrationError&&error.code==='REMOTE_MIGRATION_INVALID');
  }
  await assert.rejects(runRemoteMigration(null,base),error=>error.code==='REMOTE_MIGRATION_INVALID');
  await assert.rejects(runRemoteMigration(['status'],base),error=>error.code==='REMOTE_MIGRATION_INVALID');
});

test('a token mint failure is a redacted provider failure and no database is opened',async()=>{
  const fixture=adapters({createToken:()=>{
    throw new TursoPlatformError('TURSO_PLATFORM_FAILED',`denied ${SECRET}`);
  }});
  await assert.rejects(runRemoteMigration(options(),fixture.value),error=>{
    assert.equal(error.code,'REMOTE_MIGRATION_PLATFORM_FAILED');
    assert.doesNotMatch(error.message,new RegExp(SECRET));
    return true;
  });
  assert.deepEqual(fixture.calls,['download','database','token']);
});

test('a provider hostname that is not a lowercase DNS name is refused before connecting',async()=>{
  for(const hostname of ['Production.turso.io','localhost','production.turso.io.','bad_label.turso.io',42]){
    let connected=false;
    const fixture=adapters({hostname,connectDatabase:()=>{ connected=true; return {}; }});
    await assert.rejects(runRemoteMigration(options(),fixture.value),
      error=>error.code==='REMOTE_MIGRATION_TARGET_IDENTITY_MISMATCH',String(hostname));
    assert.equal(connected,false);
  }
});

test('a database operation that never settles times out and the client is still closed',async()=>{
  let closed=0;
  const fixture=adapters({connectDatabase:configuration=>{
    assert.equal(configuration.url,'libsql://production.test.turso.io');
    assert.equal(configuration.intMode,'bigint');
    return {
      execute:()=>new Promise(()=>{}),
      batch:()=>new Promise(()=>{}),
      transaction:()=>new Promise(()=>{}),
      close(){ closed+=1; },
    };
  }});
  await assert.rejects(runRemoteMigration(options({databaseTimeoutMs:'5'}),fixture.value),error=>{
    assert.equal(error.code,'REMOTE_MIGRATION_DATABASE_TIMEOUT');
    return true;
  });
  assert.equal(closed,1);
});
