import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterEach, test } from 'node:test';

import { main } from '../../scripts/local-reset.mjs';
import { prepareLocalDatabase, resolveLocalServerConfig } from '../../scripts/local-server.mjs';

const REPOSITORY_ROOT=fileURLToPath(new URL('../..',import.meta.url));
const cleanup=[];

afterEach(()=>{
  while(cleanup.length) cleanup.pop()();
});

function workspace(){
  const rootDir=realpathSync(mkdtempSync(join(tmpdir(),'randori-local-reset-')));
  mkdirSync(join(rootDir,'.local'),{mode:0o700});
  cleanup.push(()=>rmSync(rootDir,{recursive:true,force:true}));
  const databasePath=join(rootDir,'.local','randori.sqlite');
  const env={NODE_ENV:'development',RANDORI_LOCAL_PORT:'0',RANDORI_LOCAL_DATABASE_URL:pathToFileURL(databasePath).href};
  return {rootDir,databasePath,env};
}

function capture(){
  const chunks=[];
  return {write(chunk){ chunks.push(String(chunk)); return true; },get text(){ return chunks.join(''); }};
}

test('local reset refuses to run without exactly one --confirm argument',async()=>{
  const {rootDir,databasePath,env}=workspace();
  writeFileSync(databasePath,'not touched',{mode:0o600});
  for(const argv of [[],['--yes'],['--confirm','--confirm'],['--confirm','extra'],['confirm']]){
    const stdout=capture();
    await assert.rejects(main({argv,env,stdout,rootDir}),error=>error?.code==='LOCAL_RESET_CONFIRMATION_REQUIRED');
    assert.equal(stdout.text,'',`no output for ${JSON.stringify(argv)}`);
  }
  assert.equal(existsSync(databasePath),true,'an unconfirmed reset must not delete anything');
});

test('a confirmed reset removes a managed local database and reports one JSON line',async()=>{
  const {rootDir,databasePath,env}=workspace();
  const config=resolveLocalServerConfig({env,rootDir,argv:[]});
  await prepareLocalDatabase(config);
  writeFileSync(config.secretPath,'s'.repeat(64),{mode:0o600});
  const stdout=capture();
  const result=await main({argv:['--confirm'],env,stdout,rootDir});
  assert.equal(result.removed,true);
  assert.deepEqual(JSON.parse(stdout.text),{ok:true,event:'local-database-reset',removed:true});
  assert.equal(stdout.text.trim().split('\n').length,1);
  assert.equal(existsSync(databasePath),false);
  assert.equal(existsSync(config.secretPath),false);
  assert.equal(existsSync(config.lockPath),false,'the reset releases its runtime lock');
});

test('a confirmed reset of an empty local directory is a no-op',async()=>{
  const {rootDir,env}=workspace();
  const stdout=capture();
  const result=await main({argv:['--confirm'],env,stdout,rootDir});
  assert.equal(result.removed,false);
  assert.deepEqual(JSON.parse(stdout.text),{ok:true,event:'local-database-reset',removed:false});
});

test('reset configuration fails closed for production and remote credentials',async()=>{
  const {rootDir,env}=workspace();
  await assert.rejects(main({argv:['--confirm'],env:{...env,NODE_ENV:'production'},stdout:capture(),rootDir}),
    error=>error?.code==='LOCAL_PRODUCTION_REFUSED');
  await assert.rejects(main({argv:['--confirm'],env:{...env,TURSO_AUTH_TOKEN:'secret'},stdout:capture(),rootDir}),
    error=>error?.code==='LOCAL_TOKEN_REFUSED');
});

function runCli(args,envOverrides){
  const env={...process.env,NODE_ENV:'development',...envOverrides};
  for(const key of ['VERCEL','VERCEL_ENV','VERCEL_URL']) delete env[key];
  return spawnSync(process.execPath,['scripts/local-reset.mjs',...args],{
    cwd:REPOSITORY_ROOT,env,encoding:'utf8',timeout:10000,
  });
}

test('the executable exits 1 with only a fixed public error code',()=>{
  const missing=runCli([],{});
  assert.equal(missing.status,1);
  assert.equal(missing.stdout,'');
  assert.deepEqual(JSON.parse(missing.stderr),{
    ok:false,event:'local-database-reset',error:'LOCAL_RESET_CONFIRMATION_REQUIRED',
  });

  const token=runCli(['--confirm'],{
    TURSO_AUTH_TOKEN:'ultra-secret-reset-token',
    TURSO_DATABASE_URL:'libsql://private-reset.example.test',
  });
  assert.equal(token.status,1);
  assert.equal(token.stdout,'');
  assert.deepEqual(JSON.parse(token.stderr),{ok:false,event:'local-database-reset',error:'LOCAL_TOKEN_REFUSED'});
  assert.doesNotMatch(token.stderr,/ultra-secret|private-reset|libsql/);
});

test('the executable maps unexpected failures to LOCAL_INTERNAL_ERROR without echoing the message',()=>{
  // Preload a hook that makes configuration reading throw a plain TypeError
  // carrying a secret-looking message; it must never reach stderr.
  const hook='data:text/javascript,const real=process.env;process.env=new Proxy(real,{get(target,key){'
    +'if(key==="NODE_ENV")throw new TypeError("leaked /private/secret-path");return Reflect.get(target,key);}});';
  const env={...process.env};
  for(const key of ['VERCEL','VERCEL_ENV','VERCEL_URL','TURSO_AUTH_TOKEN']) delete env[key];
  const result=spawnSync(process.execPath,['--import',hook,'scripts/local-reset.mjs','--confirm'],{
    cwd:REPOSITORY_ROOT,env,encoding:'utf8',timeout:10000,
  });
  assert.equal(result.status,1);
  assert.equal(result.stdout,'');
  assert.deepEqual(JSON.parse(result.stderr),{ok:false,event:'local-database-reset',error:'LOCAL_INTERNAL_ERROR'});
  assert.doesNotMatch(result.stderr,/leaked|secret-path/);
});
