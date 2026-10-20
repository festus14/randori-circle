import assert from 'node:assert/strict';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, test } from 'node:test';

import { BackupEvidenceError } from '../../db/backup-evidence.js';
import { MigrationError } from '../../db/migration-runner.js';
import { TursoPlatformError } from '../../db/turso-platform.js';
import {
  createPrivateStateJournal,
  main,
  publicRehearsalError,
  RehearsalError,
} from '../../scripts/turso-backup-restore-rehearsal.mjs';

const COMMIT='0123456789abcdef0123456789abcdef01234567';
const SOURCE_ID='11111111-1111-4111-8111-111111111111';
const SECRET='platform-token-secret-value';
const cleanup=[];

afterEach(()=>{ while(cleanup.length) cleanup.pop()(); });

function temporary(){
  const directory=realpathSync(mkdtempSync(join(tmpdir(),'randori-cov-rehearsal-')));
  cleanup.push(()=>rmSync(directory,{recursive:true,force:true}));
  return directory;
}

// ------------------------------------------------------------ public errors ---

test('public rehearsal errors map each internal failure family to a fixed code and phase',()=>{
  const cases=[
    [new BackupEvidenceError('EVIDENCE_DIGEST_MISMATCH',`digest ${SOURCE_ID}`),'REHEARSAL_EVIDENCE_FAILED'],
    [new MigrationError('MIGRATION_STATE_CHANGED',`fingerprint ${SOURCE_ID}`),'REHEARSAL_MIGRATION_FAILED'],
    [new TursoPlatformError('TURSO_PLATFORM_FAILED',`token ${SECRET}`),'REHEARSAL_PLATFORM_FAILED'],
    [new Error(`libsql://secret.turso.io ${SECRET}`),'REHEARSAL_FAILED'],
    [new RehearsalError('NOT_PUBLIC',SECRET,{phase:'restore_ready'}),'REHEARSAL_FAILED','restore_ready'],
  ];
  for(const [error,expected,phase='configuration'] of cases){
    const result=publicRehearsalError(error,{repoCommit:COMMIT});
    assert.equal(result.error,expected);
    assert.equal(result.repoCommit,COMMIT);
    assert.equal(result.phase,phase);
    assert.equal(JSON.stringify(result).includes(SECRET),false);
    assert.equal(JSON.stringify(result).includes(SOURCE_ID),false);
  }
  const phased=publicRehearsalError(Object.assign(new Error('x'),{phase:'restore_create'}));
  assert.equal(phased.phase,'restore_create','a known phase on a foreign error is preserved');
  const unknownPhase=new RehearsalError('REHEARSAL_INVALID','x',{phase:'not-a-phase'});
  assert.equal(publicRehearsalError(unknownPhase).phase,'configuration');
  assert.equal(publicRehearsalError(null).error,'REHEARSAL_FAILED');
});

test('public rehearsal errors only report positive safety facts and valid commits',()=>{
  const error=new RehearsalError('REHEARSAL_RESTORE_CLEANUP_REQUIRED','cleanup',{phase:'restore_cleanup'});
  Object.defineProperty(error,'safety',{value:{sourceIdentityVerified:true,restoreDeleted:'yes',sourceDeleted:true}});
  const result=publicRehearsalError(error,{repoCommit:'main'});
  assert.equal(result.repoCommit,undefined,'a non-hex commit is omitted');
  assert.deepEqual(result.safety,{
    sourceIdentityVerified:true,writesBlockedBeforePitr:false,sourceWriteStateRestored:false,
    restoreIdentityVerified:false,restoreDeleted:false,sourceMigrated:false,sourceDeleted:false,
    credentialsInvalidated:false,
  });
  const fallback=publicRehearsalError(new Error('x'),{safety:{writesBlockedBeforePitr:true}});
  assert.equal(fallback.safety.writesBlockedBeforePitr,true,'caller safety applies when the error has none');
});

// ---------------------------------------------------------------- journal ---

test('the private journal requires an absolute state.json path',()=>{
  for(const path of ['state.json','relative/state.json','/tmp/other.json']){
    assert.throws(()=>createPrivateStateJournal(path),
      error=>error instanceof RehearsalError&&error.code==='REHEARSAL_INVALID');
  }
});

test('the private journal round-trips values and leaves no temporary files',async()=>{
  const directory=temporary();
  const path=join(directory,'state.json');
  const journal=createPrivateStateJournal(path);
  assert.equal(await journal.read(),null,'a missing journal reads as no state');
  await journal.write({phase:'restore_create',restoreId:'r-1'});
  await journal.write({phase:'complete'});
  assert.deepEqual(await journal.read(),{phase:'complete'});
  assert.equal(statSync(path).mode&0o777,0o600);
  assert.deepEqual(readdirSync(directory),['state.json']);
});

test('the private journal refuses unsafe, oversized, or corrupt state',async()=>{
  const directory=temporary();
  const path=join(directory,'state.json');
  const journal=createPrivateStateJournal(path);

  writeFileSync(path,'{"phase":',{mode:0o600});
  await assert.rejects(journal.read(),
    error=>error.code==='REHEARSAL_RECOVERY_STATE_FAILED'&&/JSON is invalid/.test(error.message)
      &&error.phase==='restore_cleanup');

  writeFileSync(path,'x'.repeat(64*1024+1),{mode:0o600});
  await assert.rejects(journal.read(),
    error=>error.code==='REHEARSAL_RECOVERY_STATE_FAILED'&&/unsafe/.test(error.message));

  rmSync(path);
  mkdirSync(path);
  await assert.rejects(journal.read(),
    error=>error.code==='REHEARSAL_RECOVERY_STATE_FAILED'&&/unsafe/.test(error.message));

  const inaccessible=createPrivateStateJournal(join(directory,'missing-parent','state.json'));
  assert.equal(await inaccessible.read(),null);
  const notDirectory=join(directory,'file');
  writeFileSync(notDirectory,'x');
  await assert.rejects(createPrivateStateJournal(join(notDirectory,'state.json')).read(),
    error=>error.code==='ENOTDIR','unexpected filesystem errors propagate');
});

test('the private journal refuses unserializable or oversized values without writing',async()=>{
  const directory=temporary();
  const path=join(directory,'state.json');
  const journal=createPrivateStateJournal(path);
  await assert.rejects(journal.write({id:1n}),
    error=>error.code==='REHEARSAL_RECOVERY_STATE_FAILED'&&/value is invalid/.test(error.message));
  await assert.rejects(journal.write({blob:'x'.repeat(64*1024)}),
    error=>error.code==='REHEARSAL_RECOVERY_STATE_FAILED'&&/too large/.test(error.message));
  assert.deepEqual(readdirSync(directory),[]);
});

// ------------------------------------------------------------------- CLI ---

function cliEnvironment(directory,overrides={}){
  return {
    RUNNER_TEMP:directory,GITHUB_RUN_ID:'100',GITHUB_RUN_ATTEMPT:'1',
    TURSO_ORGANIZATION:'randori-org',TURSO_PRODUCTION_PLATFORM_TOKEN:SECRET,
    TURSO_PLATFORM_TIMEOUT_MS:'1000',TURSO_PRODUCTION_DATABASE_ID:SOURCE_ID,
    TURSO_PRODUCTION_DATABASE_NAME:'production',TURSO_GROUP:'default',
    TURSO_PRODUCTION_EXPECTED_BLOCK_WRITES:'false',
    TURSO_RESTORE_DATABASE_PREFIX:'restore',REHEARSAL_REPO_COMMIT:COMMIT,
    REHEARSAL_CLEANUP_POLL_ATTEMPTS:'2',REHEARSAL_CLEANUP_POLL_INTERVAL_MS:'1',
    REHEARSAL_CLEANUP_POLL_DURATION_MS:'1000',
    ...overrides,
  };
}

function argv(directory,{mode='cleanup',artifact='public-artifacts',state='private-recovery/state.json'}={}){
  return ['--mode',mode,'--artifact-dir',join(directory,artifact),'--state-file',join(directory,state)];
}

async function invoke(options){
  let output='';
  const execution=await main({
    stdout:{write(chunk){ output+=chunk; }},
    createPlatform:()=>({}),
    run:async()=>{ throw new Error('run must not be called'); },
    cleanup:async()=>{ throw new Error('cleanup must not be called'); },
    ...options,
  });
  return {...execution,output};
}

test('malformed CLI usage exits 1 without creating any directory',async()=>{
  const directory=temporary();
  const base=argv(directory);
  for(const value of [
    [],
    base.slice(0,4),
    ['--mode','cleanup','--mode','run',...base.slice(4)],
    ['--mode','',...base.slice(2)],
    ['--mode','restore',...base.slice(2)],
    ['--unknown','cleanup',...base.slice(2)],
    'not-an-array',
  ]){
    const {exitCode,result,output}=await invoke({argv:value,environment:cliEnvironment(directory)});
    assert.equal(exitCode,1,JSON.stringify(value));
    assert.equal(result.error,'REHEARSAL_INVALID');
    assert.equal(result.repoCommit,undefined);
    assert.deepEqual(JSON.parse(output),result);
  }
  assert.deepEqual(readdirSync(directory),[]);
});

test('CLI paths must be absolute and stay beneath RUNNER_TEMP',async()=>{
  const directory=temporary();
  const outside=temporary();
  for(const [value,environment] of [
    [argv(directory),cliEnvironment(directory,{RUNNER_TEMP:undefined})],
    [argv(directory),cliEnvironment(directory,{RUNNER_TEMP:'relative'})],
    [['--mode','cleanup','--artifact-dir','public-artifacts','--state-file',join(directory,'s','state.json')],
      cliEnvironment(directory)],
    [argv(outside),cliEnvironment(directory)],
    [['--mode','cleanup','--artifact-dir',directory,'--state-file',join(directory,'s','state.json')],
      cliEnvironment(directory)],
  ]){
    const {exitCode,result}=await invoke({argv:value,environment});
    assert.equal(exitCode,1);
    assert.equal(result.error,'REHEARSAL_INVALID');
  }
  assert.deepEqual(readdirSync(outside),[]);
});

test('a misnamed state file is refused but still produces a sanitized artifact',async()=>{
  const directory=temporary();
  const {exitCode,result}=await invoke({
    argv:argv(directory,{state:'private-recovery/journal.json'}),environment:cliEnvironment(directory),
  });
  assert.equal(exitCode,1);
  assert.equal(result.error,'REHEARSAL_INVALID');
  assert.equal(result.repoCommit,undefined,'the commit is read only after paths validate');
  const artifact=JSON.parse(readFileSync(join(directory,'public-artifacts','cleanup-summary.json'),'utf8'));
  assert.deepEqual(artifact,result);
});

test('invalid protected environment values are refused before cleanup runs',async()=>{
  for(const overrides of [
    {TURSO_PLATFORM_TIMEOUT_MS:'60001'},
    {GITHUB_RUN_ID:'abc'},
    {GITHUB_RUN_ATTEMPT:'0'},
    {TURSO_RESTORE_DATABASE_PREFIX:'Restore_Prefix'},
    {TURSO_PRODUCTION_EXPECTED_BLOCK_WRITES:'yes'},
  ]){
    const directory=temporary();
    const {exitCode,result,output}=await invoke({argv:argv(directory),environment:cliEnvironment(directory,overrides)});
    assert.equal(exitCode,1,JSON.stringify(overrides));
    assert.equal(result.error,'REHEARSAL_INVALID');
    assert.equal(output.includes(SECRET),false);
  }
});

test('cleanup mode reuses one platform and passes the private journal and poll settings',async()=>{
  const directory=temporary();
  const platforms=[];
  let received;
  const {exitCode,result}=await invoke({
    argv:argv(directory),
    environment:cliEnvironment(directory,{TURSO_RESTORE_DATABASE_PREFIX:`${'a'.repeat(57)}--b`}),
    signal:new AbortController().signal,
    createPlatform:configuration=>{ platforms.push(configuration); return {id:platforms.length}; },
    cleanup:async options=>{
      received=options;
      await options.journalWriter({phase:'restore_cleanup'});
      assert.deepEqual(await options.journalReader(),{phase:'restore_cleanup'});
      return {ok:true,kind:'turso-backup-restore-cleanup'};
    },
  });
  assert.equal(exitCode,0,JSON.stringify(result));
  assert.equal(result.ok,true);
  assert.deepEqual(platforms,[{organization:'randori-org',token:SECRET,timeoutMs:1000}],
    'cleanup mode never forwards the abort signal and builds a single platform client');
  assert.deepEqual(received.platform,{id:1});
  assert.equal(received.restoreDatabaseName.length<=64,true);
  assert.equal(received.restoreDatabaseName,`${'a'.repeat(57)}-100-1`,'trailing prefix hyphens are trimmed');
  assert.deepEqual(received.poll,{maxAttempts:'2',intervalMs:'1',maxDurationMs:'1000'});
  assert.equal(received.expectedSourceBlockWrites,false);
  assert.equal(existsSync(join(directory,'private-recovery','state.json')),true);
});

test('run mode separates the interruptible platform from recovery and writes recovery data once',async()=>{
  const directory=temporary();
  const platforms=[];
  const controller=new AbortController();
  const {exitCode}=await invoke({
    argv:argv(directory,{mode:'run'}),
    environment:cliEnvironment(directory,{TURSO_PRODUCTION_EXPECTED_BLOCK_WRITES:'true'}),
    signal:controller.signal,
    createPlatform:configuration=>{ platforms.push(configuration); return {id:platforms.length}; },
    run:async options=>{
      assert.deepEqual(options.platform,{id:1});
      assert.deepEqual(options.recoveryPlatform,{id:2});
      assert.equal(options.signal,controller.signal);
      assert.equal(options.expectedSourceBlockWrites,true);
      await options.recoveryWriter({sourceBlockWrites:true});
      await assert.rejects(options.recoveryWriter({again:true}),error=>error.code==='EEXIST',
        'recovery data is written exclusively');
      return {ok:true,kind:'turso-rehearsal-attestation'};
    },
  });
  assert.equal(exitCode,0);
  assert.equal(platforms[0].signal,controller.signal);
  assert.equal('signal' in platforms[1],false);
  const recoveryPath=join(directory,'private-recovery','recovery.json');
  assert.deepEqual(JSON.parse(readFileSync(recoveryPath,'utf8')),{sourceBlockWrites:true});
  assert.equal(statSync(recoveryPath).mode&0o777,0o600);
});

test('an existing summary artifact is never overwritten and turns success into a failure',async()=>{
  const directory=temporary();
  mkdirSync(join(directory,'public-artifacts'));
  writeFileSync(join(directory,'public-artifacts','cleanup-summary.json'),'stale');
  const {exitCode,result,output}=await invoke({
    argv:argv(directory),environment:cliEnvironment(directory),
    cleanup:async()=>({ok:true,kind:'turso-backup-restore-cleanup'}),
  });
  assert.equal(exitCode,1);
  assert.equal(result.error,'REHEARSAL_RECOVERY_STATE_FAILED');
  assert.equal(result.phase,'complete');
  assert.equal(result.repoCommit,COMMIT);
  assert.deepEqual(JSON.parse(output),result);
  assert.equal(readFileSync(join(directory,'public-artifacts','cleanup-summary.json'),'utf8'),'stale');
});
