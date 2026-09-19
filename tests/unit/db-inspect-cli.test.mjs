import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import { createClient } from '@libsql/client';
import {fileURLToPath} from 'node:url';
import { INDEXES, TABLES } from '../../db/schema-manifest.js';
import { databaseConfig, main, parseMode, publicCliError } from '../../scripts/db-inspect.mjs';

const REPOSITORY_ROOT=fileURLToPath(new URL('../..',import.meta.url));

function outputBuffer(){
  let value='';
  return {stream:{write(chunk){ value+=chunk; }},read(){ return value; }};
}

test('CLI validates command and database configuration',()=>{
  assert.equal(parseMode(['status']),'status');
  assert.equal(parseMode(['plan']),'plan');
  assert.throws(()=>parseMode([]),/Usage/);
  assert.throws(()=>parseMode(['apply']),/Usage/);
  assert.throws(()=>databaseConfig({}),/TURSO_DATABASE_URL/);
  assert.deepEqual(databaseConfig({TURSO_DATABASE_URL:' file:test.db ',TURSO_AUTH_TOKEN:' token '}),{url:'file:test.db',authToken:'token'});
  assert.deepEqual(publicCliError(new Error('request to libsql://secret failed with token-value')),{
    ok:false,error:'DB_INSPECT_FAILED',message:'database inspection failed',
  });
});

test('db:status emits JSON and uses read-only statements',async()=>{
  const delegate=createClient({url:'file::memory:'});
  for(const definition of TABLES) await delegate.execute(definition.sql);
  for(const definition of INDEXES) await delegate.execute(definition.sql);
  const statements=[];
  let closed=false;
  const stdout=outputBuffer();
  const execution=await main({
    argv:['status'],
    env:{TURSO_DATABASE_URL:'file:ignored'},
    stdout:stdout.stream,
    createDatabaseClient:()=>({
      execute(statement){ statements.push(typeof statement==='string'?statement:statement.sql); return delegate.execute(statement); },
      close(){ closed=true; delegate.close(); },
    }),
  });
  assert.equal(execution.exitCode,0);
  assert.equal(closed,true);
  assert.equal(JSON.parse(stdout.read()).command,'db:status');
  assert.ok(statements.every(sql=>/^(?:SELECT|PRAGMA)\b/i.test(sql.trim())));
});

test('db:status fails closed on drift while db:plan remains inspectable',async()=>{
  for(const mode of ['status','plan']){
    const db=createClient({url:'file::memory:'});
    const stdout=outputBuffer();
    const execution=await main({
      argv:[mode],env:{TURSO_DATABASE_URL:'file:ignored'},stdout:stdout.stream,createDatabaseClient:()=>db,
    });
    const payload=JSON.parse(stdout.read());
    assert.equal(execution.exitCode,mode==='status'?2:0);
    assert.equal(payload.readOnly,true);
    if(mode==='plan'){
      assert.equal(payload.executable,false);
      assert.equal(payload.summary.actions,60);
    }
  }
});

test('documented silent npm commands emit exactly one JSON document',()=>{
  const npmCommand=process.platform==='win32'?'npm.cmd':'npm';
  for(const mode of ['status','plan']){
    const execution=spawnSync(npmCommand,['run','--silent',`db:${mode}`],{
      cwd:REPOSITORY_ROOT,
      encoding:'utf8',
      env:{...process.env,TURSO_DATABASE_URL:'file::memory:',TURSO_AUTH_TOKEN:''},
    });
    assert.equal(execution.status,mode==='status'?2:0,execution.stderr);
    assert.equal(execution.stderr,'');
    const payload=JSON.parse(execution.stdout);
    assert.equal(payload.command,`db:${mode}`);
    assert.equal(execution.stdout.trim(),JSON.stringify(payload));
  }
});
