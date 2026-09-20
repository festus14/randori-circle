import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createClient } from '@libsql/client';
import { EXECUTABLE_MIGRATIONS, LATEST_MIGRATION_VERSION } from '../../db/executable-migrations.js';
import { MigrationError } from '../../db/migration-runner.js';
import {
  localDatabaseTarget,
  main,
  migrationStatusResult,
  parseArguments,
  publicCliError,
  runCli,
} from '../../scripts/db-migrate.mjs';

const REPOSITORY_ROOT=fileURLToPath(new URL('../..',import.meta.url));
const FINGERPRINT='a'.repeat(64);

function outputBuffer(){
  let value='';
  return {stream:{write(chunk){ value+=chunk; }},read(){ return value; }};
}

function migrationState(overrides={}){
  return {
    classification:'fresh',
    stateFingerprint:FINGERPRINT,
    latestVersion:LATEST_MIGRATION_VERSION,
    currentVersion:0,
    ledgerPresent:false,
    schemaExact:true,
    ready:true,
    schemaStatus:{blockers:[],warnings:[]},
    adoption:{eligible:false,blockers:['schema_not_exact'],membership:null},
    ...overrides,
  };
}

async function installUnmanagedPrefix(database,migrations){
  const client=createClient({url:database});
  try{
    await client.execute('PRAGMA foreign_keys=ON');
    for(const migration of migrations){
      for(const operation of migration.operations) await client.execute(operation.sql);
    }
  }finally{ client.close(); }
}

test('migration CLI accepts only its exact modes and fingerprint contract',()=>{
  assert.deepEqual(parseArguments(['status','--database','file:///tmp/randori.db']),{
    mode:'status',database:'file:///tmp/randori.db',expectedStateFingerprint:null,
    throughVersion:LATEST_MIGRATION_VERSION,
  });
  assert.deepEqual(parseArguments(['apply','--expected-state',FINGERPRINT,'--database','file:///tmp/randori.db']),{
    mode:'apply',database:'file:///tmp/randori.db',expectedStateFingerprint:FINGERPRINT,
    throughVersion:LATEST_MIGRATION_VERSION,
  });
  assert.deepEqual(parseArguments([
    'status','--through-version','2','--database','file:///tmp/randori.db',
  ]),{
    mode:'status',database:'file:///tmp/randori.db',expectedStateFingerprint:null,throughVersion:2,
  });
  assert.deepEqual(parseArguments([
    'adopt','--database','file:///tmp/randori.db','--expected-state',FINGERPRINT,
    '--through-version','2',
  ]),{
    mode:'adopt',database:'file:///tmp/randori.db',expectedStateFingerprint:FINGERPRINT,throughVersion:2,
  });
  assert.throws(()=>parseArguments([]),/Usage/);
  assert.throws(()=>parseArguments(['plan','--database','file:///tmp/randori.db']),/Usage/);
  assert.throws(()=>parseArguments(['status','--database','file:///tmp/a','--database','file:///tmp/b']),/Usage/);
  assert.throws(()=>parseArguments([
    'status','--database','file:///tmp/a','--through-version','2','--through-version','2',
  ]),/Usage/);
  assert.throws(()=>parseArguments(['status','--database','file:///tmp/a','--expected-state',FINGERPRINT]),/Usage/);
  assert.throws(()=>parseArguments(['apply','--database','file:///tmp/a']),/expected-state/);
  assert.throws(()=>parseArguments(['adopt','--database','file:///tmp/a','--expected-state','A'.repeat(64)]),/expected-state/);
  for(const version of [
    '0','-1','1.5','01',String(LATEST_MIGRATION_VERSION+1),'9007199254740992','nope',
  ]){
    assert.throws(
      ()=>parseArguments(['status','--database','file:///tmp/a','--through-version',version]),
      error=>error?.code==='DB_MIGRATE_VERSION',
    );
  }
  assert.throws(
    ()=>parseArguments([
      'apply','--database','file:///tmp/a','--expected-state',FINGERPRINT,'--through-version','2',
    ]),
    error=>error?.code==='DB_MIGRATE_USAGE',
  );
});

test('migration targets are persistent absolute local files only',()=>{
  const directory=mkdtempSync(join(tmpdir(),'randori-migrate-target-'));
  const missing=join(directory,'missing.db');
  const existing=join(directory,'existing.db');
  const link=join(directory,'linked.db');
  const danglingLink=join(directory,'dangling.db');
  writeFileSync(existing,'');
  symlinkSync(existing,link);
  symlinkSync(join(directory,'absent.db'),danglingLink);
  const canonicalMissing=join(realpathSync(directory),'missing.db');
  assert.deepEqual(localDatabaseTarget(pathToFileURL(missing).href),{
    url:pathToFileURL(canonicalMissing).href,path:canonicalMissing,exists:false,
  });
  assert.equal(localDatabaseTarget(pathToFileURL(existing).href).exists,true);
  for(const target of [
    'file::memory:','file:relative.db','libsql://database.example','https://database.example',
    `${pathToFileURL(missing).href}?mode=rw`,pathToFileURL(directory).href,
    pathToFileURL(link).href,pathToFileURL(danglingLink).href,
  ]){
    assert.throws(()=>localDatabaseTarget(target),error=>error.code==='DB_MIGRATE_TARGET');
  }
});

test('status projection exposes the mutation fingerprint without paths or schema details',()=>{
  const result=migrationStatusResult(migrationState(),{exists:false,path:'/secret/path.db'});
  assert.deepEqual(result,{
    ok:true,
    command:'db:migrate:status',
    readOnly:true,
    target:{kind:'local-file',exists:false},
    state:'fresh',
    stateFingerprint:FINGERPRINT,
    throughVersion:LATEST_MIGRATION_VERSION,
    latestVersion:LATEST_MIGRATION_VERSION,
    ledger:{present:false,currentVersion:0,latestVersion:LATEST_MIGRATION_VERSION},
    pendingVersions:Array.from({length:LATEST_MIGRATION_VERSION},(_value,index)=>index+1),
    capabilities:{apply:true,adopt:false},
    blockers:[],
  });
  assert.doesNotMatch(JSON.stringify(result),/secret/);

  const blocked=migrationStatusResult(migrationState({
    classification:'managed',ledgerPresent:true,currentVersion:1,schemaExact:false,ready:false,
    schemaStatus:{blockers:[{code:'missing_table'},{code:'missing_table'},{code:'index_drift'}]},
  }),{exists:true});
  assert.equal(blocked.ok,false);
  assert.deepEqual(blocked.pendingVersions,[2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,17,18]);
  assert.deepEqual(blocked.capabilities,{apply:false,adopt:false});
  assert.deepEqual(blocked.blockers,['index_drift','missing_table']);

  const invalidRollout=migrationStatusResult(migrationState({
    classification:'managed',ledgerPresent:true,currentVersion:2,ready:false,
    adoption:{eligible:false,blockers:['ledger_already_present','rollout_singleton_invalid'],membership:{
      ok:false,blockers:['rollout_singleton_invalid'],
    }},
  }),{exists:true});
  assert.equal(invalidRollout.ok,false);
  assert.equal(invalidRollout.capabilities.apply,false);
  assert.deepEqual(invalidRollout.blockers,['rollout_singleton_invalid']);

  const invalidKeyControl=migrationStatusResult(migrationState({
    classification:'managed',ledgerPresent:true,currentVersion:15,ready:false,
    adoption:{eligible:false,blockers:['ledger_already_present','credential_key_controls_invalid'],
      membership:{ok:true,blockers:[]},
      keyControl:{ok:false,blockers:['credential_key_controls_invalid']}},
  }),{exists:true});
  assert.equal(invalidKeyControl.ok,false);
  assert.equal(invalidKeyControl.capabilities.apply,false);
  assert.deepEqual(invalidKeyControl.blockers,['credential_key_controls_invalid']);
});

test('status opens no missing target and emits one JSON document',async()=>{
  const directory=mkdtempSync(join(tmpdir(),'randori-migrate-status-'));
  const path=join(directory,'fresh.db');
  const stdout=outputBuffer();
  const configs=[];
  let prepared=0;
  let closed=0;
  const execution=await main({
    argv:['status','--database',pathToFileURL(path).href],
    stdout:stdout.stream,
    createDatabaseClient:config=>{ configs.push(config); return {close(){ closed+=1; }}; },
    prepare:async()=>{ prepared+=1; },
    inspect:async()=>migrationState(),
  });
  assert.equal(execution.exitCode,0);
  assert.deepEqual(configs,[{url:'file::memory:'}]);
  assert.equal(prepared,1);
  assert.equal(closed,1);
  assert.equal(execution.result.stateFingerprint,FINGERPRINT);
  assert.equal(stdout.read().trim(),JSON.stringify(execution.result));
  assert.equal(localDatabaseTarget(pathToFileURL(path).href).exists,false);
});

test('apply forwards the full migration set and reports only migration versions',async()=>{
  const directory=mkdtempSync(join(tmpdir(),'randori-migrate-apply-'));
  const path=join(directory,'database.db');
  writeFileSync(path,'');
  const stdout=outputBuffer();
  const calls=[];
  const execution=await main({
    argv:['apply','--database',pathToFileURL(path).href,'--expected-state',FINGERPRINT],
    stdout:stdout.stream,
    createDatabaseClient:()=>({close(){ calls.push('close'); }}),
    prepare:async()=>calls.push('prepare'),
    inspect:async()=>migrationState({classification:'managed',ledgerPresent:true,currentVersion:1}),
    apply:async(_client,options)=>{
      calls.push({
        expectedStateFingerprint:options.expectedStateFingerprint,
        migrationVersions:options.migrations.map(item=>item.version),
      });
      return {
        ok:true,mode:'apply',fromVersion:1,toVersion:18,latestVersion:18,
        applied:[{version:17,name:'private-name',checksum:'secret-checksum',executionMs:4}],
        stateFingerprint:'b'.repeat(64),
      };
    },
  });
  assert.equal(execution.exitCode,0);
  assert.deepEqual(calls,[
    'prepare',
    {expectedStateFingerprint:FINGERPRINT,migrationVersions:[1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,17,18]},
    'close',
  ]);
  assert.equal(execution.result.result,'applied');
  assert.equal(execution.result.throughVersion,18);
  assert.equal(execution.result.latestVersion,18);
  assert.deepEqual(execution.result.target,{kind:'local-file',existedBefore:true});
  assert.deepEqual(execution.result.appliedVersions,[17]);
  assert.doesNotMatch(JSON.stringify(execution.result),/private-name|secret-checksum/);
  assert.equal(stdout.read().trim(),JSON.stringify(execution.result));
});

test('recognized migration refusals exit two and unexpected failures are redacted',async()=>{
  const directory=mkdtempSync(join(tmpdir(),'randori-migrate-errors-'));
  const path=join(directory,'database.db');
  writeFileSync(path,'');
  const stdout=outputBuffer();
  let closes=0;
  const refusal=await main({
    argv:['adopt','--database',pathToFileURL(path).href,'--expected-state',FINGERPRINT],
    stdout:stdout.stream,
    createDatabaseClient:()=>({close(){ closes+=1; }}),
    prepare:async()=>{},
    inspect:async()=>migrationState({classification:'unmanaged'}),
    adopt:async()=>{ throw new MigrationError('MIGRATION_STATE_CHANGED','raw state detail'); },
  });
  assert.equal(refusal.exitCode,2);
  assert.equal(refusal.result.error,'MIGRATION_STATE_CHANGED');
  assert.doesNotMatch(stdout.read(),/raw state detail|database\.db/);
  assert.equal(closes,1);

  const stderr=outputBuffer();
  const failed=await runCli({
    argv:['status','--database',pathToFileURL(path).href],stderr:stderr.stream,stdout:{write(){ assert.fail('stdout must stay empty'); }},
    createDatabaseClient:()=>({close(){ closes+=1; }}),
    prepare:async()=>{},
    inspect:async()=>{ throw new Error(`provider failed for ${path} with token secret-token`); },
  });
  assert.equal(failed.exitCode,1);
  assert.deepEqual(JSON.parse(stderr.read()),{
    ok:false,command:'db:migrate',error:'MIGRATION_FAILED',message:'Database migration failed.',
  });
  assert.doesNotMatch(stderr.read(),/secret-token|database\.db/);
  assert.equal(closes,2);

  const unknownError=await runCli({
    argv:['status','--database',pathToFileURL(path).href],stderr:outputBuffer().stream,stdout:outputBuffer().stream,
    createDatabaseClient:()=>({close(){}}),prepare:async()=>{},
    inspect:async()=>{ throw new MigrationError('MIGRATION_UNKNOWN','private detail'); },
  });
  assert.equal(unknownError.exitCode,1);
  assert.equal(unknownError.result.error,'MIGRATION_FAILED');
});

test('a stale fresh-state fingerprint does not create the requested database file',async()=>{
  const directory=mkdtempSync(join(tmpdir(),'randori-migrate-stale-fresh-'));
  const path=join(directory,'must-not-exist.db');
  const stdout=outputBuffer();
  const execution=await main({
    argv:['apply','--database',pathToFileURL(path).href,'--expected-state','f'.repeat(64)],
    stdout:stdout.stream,
  });
  assert.equal(execution.exitCode,2);
  assert.equal(execution.result.error,'MIGRATION_STATE_CHANGED');
  assert.equal(localDatabaseTarget(pathToFileURL(path).href).exists,false);
  assert.doesNotMatch(stdout.read(),/must-not-exist/);
});

test('adopt refuses a missing target without creating it',async()=>{
  const directory=mkdtempSync(join(tmpdir(),'randori-migrate-missing-adopt-'));
  const path=join(directory,'must-not-exist.db');
  const database=pathToFileURL(path).href;
  const status=await main({argv:['status','--database',database],stdout:outputBuffer().stream});
  const stdout=outputBuffer();
  const adoption=await main({
    argv:['adopt','--database',database,'--expected-state',status.result.stateFingerprint],
    stdout:stdout.stream,
  });
  assert.equal(adoption.exitCode,2);
  assert.equal(adoption.result.error,'MIGRATION_ADOPTION_BLOCKED');
  assert.equal(stdout.read().trim(),JSON.stringify(adoption.result));
  assert.equal(localDatabaseTarget(database).exists,false);
});

test('an exact unmanaged v2 rehearsal can adopt its prefix and then apply pending migrations',async()=>{
  const directory=mkdtempSync(join(tmpdir(),'randori-migrate-prefix-'));
  const path=join(directory,'production-copy.db');
  const database=pathToFileURL(path).href;
  try{
    await installUnmanagedPrefix(database,EXECUTABLE_MIGRATIONS.slice(0,2));

    const latestInspection=await main({
      argv:['status','--database',database],stdout:outputBuffer().stream,
    });
    assert.equal(latestInspection.exitCode,2);
    assert.equal(latestInspection.result.state,'unmanaged');
    assert.equal(latestInspection.result.throughVersion,18);
    assert.equal(latestInspection.result.latestVersion,18);
    assert.equal(latestInspection.result.capabilities.adopt,false);

    const prefixInspection=await main({
      argv:['status','--database',database,'--through-version','2'],
      stdout:outputBuffer().stream,
    });
    assert.equal(prefixInspection.exitCode,0);
    assert.equal(prefixInspection.result.state,'unmanaged');
    assert.equal(prefixInspection.result.throughVersion,2);
    assert.equal(prefixInspection.result.latestVersion,18);
    assert.deepEqual(prefixInspection.result.ledger,{present:false,currentVersion:0,latestVersion:2});
    assert.deepEqual(prefixInspection.result.pendingVersions,[]);
    assert.deepEqual(prefixInspection.result.capabilities,{apply:false,adopt:true});

    const adoption=await main({
      argv:[
        'adopt','--database',database,
        '--expected-state',prefixInspection.result.stateFingerprint,
        '--through-version','2',
      ],
      stdout:outputBuffer().stream,
    });
    assert.equal(adoption.exitCode,0);
    assert.equal(adoption.result.result,'adopted');
    assert.equal(adoption.result.throughVersion,2);
    assert.equal(adoption.result.latestVersion,18);
    assert.equal(adoption.result.toVersion,2);
    assert.deepEqual(adoption.result.adoptedVersions,[1,2]);

    const managedV2=await main({
      argv:['status','--database',database],stdout:outputBuffer().stream,
    });
    assert.equal(managedV2.exitCode,0);
    assert.equal(managedV2.result.state,'managed');
    assert.deepEqual(managedV2.result.ledger,{present:true,currentVersion:2,latestVersion:18});
    assert.deepEqual(managedV2.result.pendingVersions,[3,4,5,6,7,8,9,10,11,12,13,14,15,16,17,18]);
    assert.deepEqual(managedV2.result.capabilities,{apply:true,adopt:false});

    const upgraded=await main({
      argv:[
        'apply','--database',database,
        '--expected-state',managedV2.result.stateFingerprint,
      ],
      stdout:outputBuffer().stream,
    });
    assert.equal(upgraded.exitCode,0);
    assert.equal(upgraded.result.result,'applied');
    assert.deepEqual(upgraded.result.appliedVersions,[3,4,5,6,7,8,9,10,11,12,13,14,15,16,17,18]);
    assert.equal(upgraded.result.toVersion,18);

    const latest=await main({
      argv:['status','--database',database],stdout:outputBuffer().stream,
    });
    const noop=await main({
      argv:['apply','--database',database,'--expected-state',latest.result.stateFingerprint],
      stdout:outputBuffer().stream,
    });
    assert.equal(noop.exitCode,0);
    assert.equal(noop.result.result,'noop');
    assert.deepEqual(noop.result.appliedVersions,[]);
    assert.equal(noop.result.fromVersion,18);
    assert.equal(noop.result.toVersion,18);
    assert.equal(noop.result.throughVersion,18);
    assert.equal(noop.result.latestVersion,18);
  }finally{ rmSync(directory,{recursive:true,force:true}); }
});

test('prefix adoption refuses mismatched fingerprints and drift without writing a ledger',async()=>{
  const directory=mkdtempSync(join(tmpdir(),'randori-migrate-prefix-refusal-'));
  const path=join(directory,'production-copy.db');
  const database=pathToFileURL(path).href;
  try{
    await installUnmanagedPrefix(database,EXECUTABLE_MIGRATIONS.slice(0,2));
    const prefixInspection=await main({
      argv:['status','--database',database,'--through-version','2'],
      stdout:outputBuffer().stream,
    });
    const latestInspection=await main({
      argv:['status','--database',database],stdout:outputBuffer().stream,
    });
    assert.notEqual(prefixInspection.result.stateFingerprint,latestInspection.result.stateFingerprint);

    const stale=await main({
      argv:[
        'adopt','--database',database,
        '--expected-state',latestInspection.result.stateFingerprint,
        '--through-version','2',
      ],
      stdout:outputBuffer().stream,
    });
    assert.equal(stale.exitCode,2);
    assert.equal(stale.result.error,'MIGRATION_STATE_CHANGED');
    assert.equal(stale.result.throughVersion,2);
    assert.equal(stale.result.latestVersion,18);

    const driftClient=createClient({url:database});
    try{ await driftClient.execute('DROP INDEX idx_circle_invitations_email'); }
    finally{ driftClient.close(); }
    const drifted=await main({
      argv:['status','--database',database,'--through-version','2'],
      stdout:outputBuffer().stream,
    });
    assert.equal(drifted.exitCode,2);
    assert.equal(drifted.result.capabilities.adopt,false);
    assert.ok(drifted.result.blockers.includes('schema_not_exact'));

    const refused=await main({
      argv:[
        'adopt','--database',database,
        '--expected-state',drifted.result.stateFingerprint,
        '--through-version','2',
      ],
      stdout:outputBuffer().stream,
    });
    assert.equal(refused.exitCode,2);
    assert.equal(refused.result.error,'MIGRATION_ADOPTION_BLOCKED');
    const verify=createClient({url:database});
    try{
      const ledger=await verify.execute("SELECT name FROM sqlite_schema WHERE type='table' AND name='schema_migrations'");
      assert.deepEqual(ledger.rows,[]);
    }finally{ verify.close(); }
  }finally{ rmSync(directory,{recursive:true,force:true}); }
});

test('CLI status fingerprint authorizes a real fresh-file apply',async()=>{
  const directory=mkdtempSync(join(tmpdir(),'randori-migrate-real-'));
  const path=join(directory,'fresh.db');
  const database=pathToFileURL(path).href;
  const status=await main({
    argv:['status','--database',database],stdout:outputBuffer().stream,
  });
  const apply=await main({
    argv:['apply','--database',database,'--expected-state',status.result.stateFingerprint],
    stdout:outputBuffer().stream,
  });
  assert.equal(apply.exitCode,0);
  assert.equal(apply.result.result,'applied');
  assert.deepEqual(apply.result.target,{kind:'local-file',existedBefore:false});
  assert.deepEqual(apply.result.appliedVersions,[1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,17,18]);
  assert.equal(localDatabaseTarget(database).exists,true);
  const after=await main({
    argv:['status','--database',database],stdout:outputBuffer().stream,
  });
  assert.equal(after.result.state,'managed');
  assert.equal(after.result.ledger.currentVersion,18);
  assert.equal(after.result.stateFingerprint,apply.result.stateFingerprint);
});

test('public CLI errors expose stable codes without rejected target values',()=>{
  const error=Object.assign(new Error('libsql://secret.example?authToken=value'),{code:'DB_MIGRATE_TARGET'});
  assert.deepEqual(publicCliError(error),{
    ok:false,command:'db:migrate',error:'DB_MIGRATE_TARGET',message:'A valid persistent local database target is required.',
  });
});

test('invalid through-version CLI errors are bounded and redact the rejected invocation',async()=>{
  const stderr=outputBuffer();
  const invalid=await runCli({
    argv:[
      'status','--database','file:///private/production-copy.db',
      '--through-version',String(LATEST_MIGRATION_VERSION+1),
    ],
    stderr:stderr.stream,
  });
  assert.equal(invalid.exitCode,1);
  assert.deepEqual(invalid.result,{
    ok:false,
    command:'db:migrate',
    error:'DB_MIGRATE_VERSION',
    message:`through-version must be an integer from 1 to ${LATEST_MIGRATION_VERSION}.`,
  });
  assert.equal(stderr.read().trim(),JSON.stringify(invalid.result));
  assert.doesNotMatch(stderr.read(),/production-copy|private/);
});

test('packaged status command emits one JSON document without creating a missing database',()=>{
  const directory=mkdtempSync(join(tmpdir(),'randori-migrate-spawn-'));
  const path=join(directory,'fresh.db');
  const npmCommand=process.platform==='win32'?'npm.cmd':'npm';
  const execution=spawnSync(npmCommand,[
    'run','--silent','db:migrate','--','status','--database',pathToFileURL(path).href,
  ],{cwd:REPOSITORY_ROOT,encoding:'utf8'});
  assert.equal(execution.status,0,execution.stderr);
  assert.equal(execution.stderr,'');
  const payload=JSON.parse(execution.stdout);
  assert.equal(payload.command,'db:migrate:status');
  assert.equal(payload.state,'fresh');
  assert.match(payload.stateFingerprint,/^[a-f0-9]{64}$/);
  assert.equal(execution.stdout.trim(),JSON.stringify(payload));
  assert.equal(localDatabaseTarget(pathToFileURL(path).href).exists,false);
});
