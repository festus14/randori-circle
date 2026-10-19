import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {after,before,mock,test} from 'node:test';

import * as libsql from '@libsql/client';

import {EXECUTABLE_MIGRATIONS} from '../../db/executable-migrations.js';
import {
  applyMigrations,
  inspectMigrationState,
  prepareMigrationConnection,
} from '../../db/migration-runner.js';

const SCRIPT=fileURLToPath(new URL('../../scripts/credential-key-control.mjs',import.meta.url));
const directory=mkdtempSync(join(tmpdir(),'randori-cov-key-control-cli-'));
const localUrl=`file:${join(directory,'database.sqlite')}`;
const connections=[];
let main;

const RUNTIME=Object.freeze({GITHUB_EVENT_NAME:'workflow_dispatch',GITHUB_REF:'refs/heads/main',
  GITHUB_REPOSITORY:'festus14/randori-circle',
  GITHUB_WORKFLOW_REF:'festus14/randori-circle/.github/workflows/credential-key-control.yml@refs/heads/main',
  GITHUB_SHA:'a'.repeat(40),KEY_CONTROL_REPO_COMMIT:'a'.repeat(40),
  KEY_CONTROL_GITHUB_ENVIRONMENT:'credential-key-control',
  TURSO_DATABASE_URL:'libsql://randori.example.turso.io',
  TURSO_PRODUCTION_DATABASE_HOST:'randori.example.turso.io',
  TURSO_AUTH_TOKEN:'secret-turso-token-value'});

before(async()=>{
  const setup=libsql.createClient({url:localUrl});
  await prepareMigrationConnection(setup);
  const initial=await inspectMigrationState(setup,{migrations:EXECUTABLE_MIGRATIONS});
  await applyMigrations(setup,{migrations:EXECUTABLE_MIGRATIONS,
    expectedStateFingerprint:initial.stateFingerprint,
    retry:{maxAttempts:1,baseDelayMs:0,maxDelayMs:0}});
  await setup.close();
  // The CLI only ever connects to the validated remote URL; redirect that client
  // to the local migrated database and record what it was asked to connect to.
  mock.module('@libsql/client',{namedExports:{...libsql,createClient:config=>{
    const client=libsql.createClient({url:localUrl});
    const record={config,closed:false};
    connections.push(record);
    const close=client.close.bind(client);
    client.close=()=>{ record.closed=true; return close(); };
    return client;
  }}});
  process.env.JWT_SECRET='credential-control-test-secret-at-least-32-bytes';
  ({main}=await import('../../scripts/credential-key-control.mjs'));
});

after(()=>{
  delete process.env.JWT_SECRET;
  mock.restoreAll();
  rmSync(directory,{recursive:true,force:true});
});

function sink(){
  const chunks=[];
  return {write:chunk=>{ chunks.push(chunk); return true; },get text(){ return chunks.join(''); }};
}

test('main adopts, reports status, and advances through the validated connection only',async()=>{
  const env={...RUNTIME,KEY_CONTROL_CONFIRM:'CHANGE_CREDENTIAL_KEY_CONTROL',
    CREDENTIAL_KEY_CONTROL_MUTATIONS_ENABLED:'true'};
  const adoptOut=sink();
  const adopted=await main({argv:['--operation','adopt','--purpose','password-reset'],env,
    stdout:adoptOut});
  assert.equal(adopted.changed,true);
  assert.deepEqual(JSON.parse(adoptOut.text),{ok:true,purpose:'password-reset',version:1,
    generation:1,changed:true,reconciled:false,operation:'adopt'});
  assert.deepEqual(connections.at(-1),{config:{url:RUNTIME.TURSO_DATABASE_URL,
    authToken:RUNTIME.TURSO_AUTH_TOKEN},closed:true});

  const statusOut=sink();
  await main({argv:['--purpose','password-reset','--operation','status'],
    env:{...RUNTIME,KEY_CONTROL_CONFIRM:'INSPECT_CREDENTIAL_KEY_CONTROL'},stdout:statusOut});
  const status=JSON.parse(statusOut.text);
  assert.deepEqual(status.control,{ready:true,state:'accepted',reason:null,configured_version:1,
    accepted_version:1,generation:1});
  assert.equal(status.material.ready,true);
  assert.doesNotMatch(statusOut.text,/secret-turso-token-value|[a-f0-9]{64}/);

  // Re-running advance with the already accepted pair is an idempotent no-op.
  const replay=await main({argv:['--operation','advance','--purpose','password-reset',
    '--expected-version','1','--expected-generation','1'],env,stdout:sink()});
  assert.deepEqual({...replay},{ok:true,purpose:'password-reset',version:1,generation:1,
    changed:false,reconciled:false,operation:'advance'});

  // A stale compare-and-swap expectation fails and still closes the connection.
  await assert.rejects(main({argv:['--operation','advance','--purpose','email-activation',
    '--expected-version','1','--expected-generation','1'],env,stdout:sink()}),
  error=>error.code==='KEY_CONTROL_UNINITIALIZED');
  assert.equal(connections.at(-1).closed,true,'the connection is closed even on failure');
});

test('main rejects malformed argv before any database connection is created',async()=>{
  const before=connections.length;
  const bad=[
    ['--operation'],
    ['operation','status'],
    ['--operation','status','--operation','adopt'],
    ['--operation','status','--purpose','password-reset','--database','x'],
    [undefined,'status'],
  ];
  for(const argv of bad){
    await assert.rejects(main({argv,env:RUNTIME,stdout:sink()}),
      error=>error.code==='KEY_CONTROL_INPUT_INVALID',JSON.stringify(argv));
  }
  await assert.rejects(main({argv:['--operation','status','--purpose','password-reset'],
    env:{...RUNTIME,GITHUB_REF:'refs/heads/feature'},stdout:sink()}),
  error=>error.code==='KEY_CONTROL_RUNTIME_INVALID');
  assert.equal(connections.length,before);
});

function runCli(argv,env){
  const child=spawnSync(process.execPath,[SCRIPT,...argv],{encoding:'utf8',timeout:60000,
    env:{PATH:process.env.PATH,
      ...(process.env.NODE_V8_COVERAGE?{NODE_V8_COVERAGE:process.env.NODE_V8_COVERAGE}:{}),...env}});
  return {status:child.status,stdout:child.stdout,stderr:child.stderr};
}

test('the CLI entrypoint emits only an allowlisted error code and exits non-zero',()=>{
  const usage=runCli(['--operation'],{});
  assert.equal(usage.status,1);
  assert.equal(usage.stdout,'');
  assert.deepEqual(JSON.parse(usage.stderr),{ok:false,error:'KEY_CONTROL_INPUT_INVALID'});

  // A connection-level failure (closed local port) is collapsed to a generic code
  // and never echoes the token or the underlying provider error.
  const transport=runCli(['--operation','status','--purpose','password-reset'],{...RUNTIME,
    TURSO_DATABASE_URL:'https://127.0.0.1',TURSO_PRODUCTION_DATABASE_HOST:'127.0.0.1',
    KEY_CONTROL_CONFIRM:'INSPECT_CREDENTIAL_KEY_CONTROL',
    JWT_SECRET:'credential-control-test-secret-at-least-32-bytes'});
  assert.equal(transport.status,1);
  assert.deepEqual(JSON.parse(transport.stderr),{ok:false,error:'KEY_CONTROL_FAILED'});
  assert.doesNotMatch(transport.stderr+transport.stdout,/secret-turso-token-value|ECONNREFUSED/);
});
