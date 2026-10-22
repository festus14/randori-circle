// Issue #249: POST /api/cron/execution-smoke through api/ops.js, the real
// execution boundary (a stubbed self-hosted Piston endpoint) and a real,
// fully migrated SQLite database.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, afterEach, before, beforeEach, mock, test } from 'node:test';
import { createClient } from '@libsql/client';

import { applyMigrations, inspectMigrationState, prepareMigrationConnection } from '../../db/migration-runner.js';

const directory=mkdtempSync(join(tmpdir(),'randori-execution-smoke-route-'));
const realDb=createClient({url:`file:${join(directory,'route.sqlite')}`});
let clientOverride=null;

mock.module('../../api/_db.js',{
  exports:{
    JWT_AUDIENCE:'randori-web',
    JWT_ISSUER:'randori-circle',
    getClient:()=>{
      if(clientOverride instanceof Error) throw clientOverride;
      return clientOverride||realDb;
    },
    getJwtSecret:()=>'unit-test-secret-at-least-thirty-two-characters',
    getCronSecret:()=>{
      if(!process.env.CRON_SECRET) throw new Error('Missing CRON_SECRET');
      return process.env.CRON_SECRET;
    },
    getAdminEmails:()=>new Set(),
    deterministicColor:()=>'#123456',
    issueSession:async()=>'session',
    issueSessionInTransaction:async()=>'session',
    revokeAccountSessions:async()=>0,
    revokeRequestSession:async()=>({authenticated:false,revoked:false,userId:null}),
    isoWeekLabel:()=>'2026-W43',
    shuffleArray:values=>[...values],
    verifyRequestAuth:()=>null,
    verifySignedRequestAuth:()=>null,
    verifyMutationOrigin:()=>true,
    initSentry:()=>{},
    isSentryConfigured:()=>false,
    getSentry:()=>({Sentry:null,ready:false}),
    captureSentryMessage:()=>null,
    captureSentryException:()=>null,
  },
});

const {default:opsHandler}=await import('../../api/ops.js');

const CRON='cron-secret-value-for-execution-smoke-01';
const OUTBOX='outbox-dispatch-secret-value-for-smoke-02';
const PISTON_URL='https://piston.example.test/api/v2/execute';
const PISTON_TOKEN='piston-token-private-value';
const ENV_KEYS=['CRON_SECRET','OUTBOX_DISPATCH_SECRET','EXECUTION_PROVIDER','EXECUTION_API_URL','EXECUTION_API_TOKEN'];
const savedEnv=Object.fromEntries(ENV_KEYS.map(key=>[key,process.env[key]]));
const realFetch=globalThis.fetch;
let providerCalls=[];
let provider=null;

function invoke(options={}){
  const {method='POST',url='/api/cron/execution-smoke',query={},headers={'x-cron-secret':CRON}}=options;
  const body=Object.hasOwn(options,'body')?options.body:{trigger:'deploy'};
  return new Promise((resolve,reject)=>{
    let statusCode=200;
    const responseHeaders={};
    const response={
      status(code){ statusCode=code; return this; },
      json(payload){ resolve({status:statusCode,headers:responseHeaders,body:payload}); return this; },
      setHeader(name,value){ responseHeaders[String(name).toLowerCase()]=value; },
    };
    Promise.resolve(opsHandler({method,url,query,headers,body,socket:{remoteAddress:'203.0.113.9'}},response))
      .catch(reject);
  });
}

function pistonReply({stdout='randori-smoke-42\n',status=200}={}){
  return new Response(JSON.stringify({run:{stdout,stderr:`stderr from ${PISTON_URL}`,code:0}}),
    {status,headers:{'content-type':'application/json'}});
}

before(async()=>{
  await prepareMigrationConnection(realDb);
  const state=await inspectMigrationState(realDb);
  await applyMigrations(realDb,{expectedStateFingerprint:state.stateFingerprint,
    retry:{maxAttempts:1,baseDelayMs:0,maxDelayMs:0}});
});

beforeEach(async()=>{
  clientOverride=null;
  for(const key of ENV_KEYS) delete process.env[key];
  Object.assign(process.env,{CRON_SECRET:CRON,OUTBOX_DISPATCH_SECRET:OUTBOX,EXECUTION_PROVIDER:'piston',
    EXECUTION_API_URL:PISTON_URL,EXECUTION_API_TOKEN:PISTON_TOKEN});
  providerCalls=[];
  provider=async()=>pistonReply();
  globalThis.fetch=async(url,init)=>{
    providerCalls.push({url:String(url),language:JSON.parse(init.body).language});
    return provider(url,init);
  };
  await realDb.execute('DELETE FROM app_logs');
});

afterEach(()=>{
  globalThis.fetch=realFetch;
  for(const [key,value] of Object.entries(savedEnv)){
    if(value===undefined) delete process.env[key]; else process.env[key]=value;
  }
});

after(()=>{
  realDb.close();
  rmSync(directory,{recursive:true,force:true});
});

test('the route is POST-only, uncached, and accepts CRON_SECRET only',async()=>{
  const wrongMethod=await invoke({method:'GET'});
  assert.equal(wrongMethod.status,405);
  assert.equal(wrongMethod.headers['cache-control'],'no-store');
  for(const headers of [{},{authorization:'Bearer nope'},{'x-cron-secret':`${CRON}x`},
    {'x-cron-secret':OUTBOX},{authorization:`Bearer ${OUTBOX}`}]){
    const denied=await invoke({headers});
    assert.equal(denied.status,401,JSON.stringify(headers));
    assert.deepEqual(denied.body,{error:'unauthorized cron'});
  }
  delete process.env.CRON_SECRET;
  assert.equal((await invoke()).status,401,'an unset CRON_SECRET fails closed');
  assert.equal(providerCalls.length,0);
  assert.equal((await realDb.execute('SELECT COUNT(*) AS n FROM app_logs')).rows[0].n,0);
});

test('the body must be exactly one known trigger, checked before any work',async()=>{
  for(const body of [undefined,null,'{"trigger":"deploy"}',{},{trigger:'dispatch'},{trigger:'deploy',force:true},
    [{trigger:'deploy'}]]){
    const invalid=await invoke({body});
    assert.equal(invalid.status,400,JSON.stringify(body));
    assert.deepEqual(invalid.body,{ok:false,error:'invalid smoke request'});
  }
  assert.equal((await invoke({headers:{},body:{trigger:'nope'}})).status,401,'authentication comes first');
  assert.equal(providerCalls.length,0);
  assert.equal((await realDb.execute('SELECT COUNT(*) AS n FROM app_logs')).rows[0].n,0);
});

test('an authorized call runs both programs once, then returns the cached result as throttled',async()=>{
  for(const headers of [{'x-cron-secret':CRON},{authorization:`Bearer ${CRON}`}]){
    await realDb.execute('DELETE FROM app_logs');
    providerCalls=[];
    const fresh=await invoke({headers});
    assert.equal(fresh.status,200,JSON.stringify(fresh.body));
    assert.equal(fresh.headers['cache-control'],'no-store');
    assert.deepEqual(Object.keys(fresh.body).sort(),['checkedAt','languages','ok']);
    assert.equal(fresh.body.ok,true);
    assert.equal(fresh.body.languages.javascript.status,'ok');
    assert.equal(fresh.body.languages.python.status,'ok');
    assert.deepEqual(providerCalls.map(call=>call.language).sort(),['javascript','python']);
  }
  const throttled=await invoke({url:'/api/ops',query:{endpoint:'execution-smoke'}});
  assert.equal(throttled.status,200);
  assert.equal(throttled.body.ok,true);
  assert.equal(throttled.body.languages.javascript.status,'throttled');
  assert.equal(throttled.body.languages.python.lastStatus,'ok');
  assert.equal(typeof throttled.body.ageSeconds,'number');
  assert.equal(providerCalls.length,2,'the throttled call creates no execution');
  assert.doesNotMatch(JSON.stringify(throttled.body),/piston|token|stderr|example\.test/i);
  // Inside the 30-minute spacing even the separate scheduled slot is throttled.
  assert.equal((await invoke({body:{trigger:'schedule'}})).body.languages.javascript.status,'throttled');
  assert.equal(providerCalls.length,2);
});

test('provider failures map to bounded statuses without leaking URLs, tokens or output',async()=>{
  provider=async(url,init)=>JSON.parse(init.body).language==='javascript'
    ?pistonReply({status:502})
    :pistonReply({stdout:`unexpected ${PISTON_TOKEN} ${PISTON_URL}`});
  const failed=await invoke();
  assert.equal(failed.status,200);
  assert.deepEqual({ok:failed.body.ok,javascript:failed.body.languages.javascript.status,
    python:failed.body.languages.python.status},{ok:false,javascript:'provider_error',python:'provider_error'});
  assert.doesNotMatch(JSON.stringify(failed.body),/piston|token|unexpected|502|example\.test/i);

  await realDb.execute('DELETE FROM app_logs');
  provider=async()=>{ const error=new Error('aborted'); error.name='AbortError'; throw error; };
  const timedOut=await invoke();
  assert.equal(timedOut.body.languages.javascript.status,'timeout');
  assert.equal(timedOut.body.languages.python.status,'timeout');
});

test('misconfiguration is reported without a claim, and a missing database fails closed',async()=>{
  process.env.EXECUTION_API_URL='https://emkc.org/api/v2/piston/execute';
  const misconfigured=await invoke();
  assert.equal(misconfigured.status,200);
  assert.deepEqual(misconfigured.body.languages,{javascript:{status:'misconfigured',durationMs:null},
    python:{status:'misconfigured',durationMs:null}});
  delete process.env.EXECUTION_PROVIDER;
  assert.equal((await invoke()).body.languages.python.status,'misconfigured');
  assert.equal(providerCalls.length,0);
  assert.equal((await realDb.execute('SELECT COUNT(*) AS n FROM app_logs')).rows[0].n,0);

  process.env.EXECUTION_PROVIDER='piston';
  process.env.EXECUTION_API_URL=PISTON_URL;
  clientOverride=new Error('Missing TURSO_DATABASE_URL');
  const unavailable=await invoke();
  assert.equal(unavailable.status,503);
  assert.deepEqual(unavailable.body,{ok:false,error:'execution smoke unavailable'});
  assert.equal(providerCalls.length,0);
});

test('unknown ops endpoints advertise the execution smoke route',async()=>{
  const unknown=await invoke({method:'GET',url:'/api/ops',query:{endpoint:'nope'}});
  assert.equal(unknown.status,404);
  assert.ok(unknown.body.available.includes('execution-smoke'));
});
