// Issue #249: the execution smoke module against a real, fully migrated SQLite
// database (database-clock throttle) and the real api/_execution.js boundary.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, beforeEach, test } from 'node:test';
import { createClient } from '@libsql/client';

import { applyMigrations, inspectMigrationState, prepareMigrationConnection } from '../../db/migration-runner.js';
import { ExecutionFailedError, ExecutionUnavailableError, executeProgram } from '../../api/_execution.js';
import {
  claimExecutionSmoke,
  classifyExecutionError,
  classifyExecutionResult,
  EXECUTION_SMOKE_DAILY_LIMIT,
  EXECUTION_SMOKE_EXPECTED_OUTPUT,
  EXECUTION_SMOKE_LANGUAGE_DEADLINE_MS,
  EXECUTION_SMOKE_LANGUAGES,
  EXECUTION_SMOKE_PROGRAMS,
  EXECUTION_SMOKE_STATUSES,
  executionSmokeLanguagePasses,
  readLastExecutionSmoke,
  recordExecutionSmoke,
  runExecutionSmoke,
} from '../../api/_execution-smoke.js';

const directory=mkdtempSync(join(tmpdir(),'randori-execution-smoke-'));
const db=createClient({url:`file:${join(directory,'smoke.sqlite')}`});
const SANDBOX={EXECUTION_PROVIDER:'vercel-sandbox'};
const PISTON={EXECUTION_PROVIDER:'piston',EXECUTION_API_URL:'https://piston.example.test/api/v2/execute',
  EXECUTION_API_TOKEN:'piston-token-private-value'};
const okRun=()=>({provider:'vercel-sandbox',stdout:`${EXECUTION_SMOKE_EXPECTED_OUTPUT}\n`,stderr:'',code:0,timedOut:false});

function abortError(){
  const error=new Error('This operation was aborted');
  error.name='AbortError';
  return error;
}

async function rows(event){
  return (await db.execute({sql:`SELECT level,source,event,message,meta_json,user_id,route,ua,ip
    FROM app_logs WHERE event=? ORDER BY id`,args:[event]})).rows;
}

async function insertLog({source='runner',event='execution_smoke_claim',age='-1 minutes',userId=null,meta=null}){
  await db.execute({sql:`INSERT INTO app_logs (level,source,event,message,meta_json,user_id,created_at)
    VALUES ('info',?,?,'seeded',?,?,datetime('now',?))`,args:[source,event,meta,userId,age]});
}

function smoke(options={}){
  const calls=[];
  const execute=options.execute||(async request=>{ calls.push(request); return okRun(); });
  return {calls,run:()=>runExecutionSmoke({getDb:()=>db,env:SANDBOX,...options,execute})};
}

before(async()=>{
  await prepareMigrationConnection(db);
  const state=await inspectMigrationState(db);
  await applyMigrations(db,{expectedStateFingerprint:state.stateFingerprint,
    retry:{maxAttempts:1,baseDelayMs:0,maxDelayMs:0}});
});

beforeEach(async()=>{ await db.execute('DELETE FROM app_logs'); });

after(()=>{
  db.close();
  rmSync(directory,{recursive:true,force:true});
});

test('the fixed programs are trivial and really print the expected marker',()=>{
  assert.deepEqual(EXECUTION_SMOKE_LANGUAGES,['javascript','python']);
  assert.deepEqual(EXECUTION_SMOKE_STATUSES,['ok','provider_error','timeout','misconfigured','throttled']);
  assert.equal(EXECUTION_SMOKE_DAILY_LIMIT,2);
  const node=spawnSync(process.execPath,['-e',EXECUTION_SMOKE_PROGRAMS.javascript],{encoding:'utf8'});
  assert.equal(node.stdout,`${EXECUTION_SMOKE_EXPECTED_OUTPUT}\n`);
  const python=spawnSync('python3',['-c',EXECUTION_SMOKE_PROGRAMS.python],{encoding:'utf8'});
  if(python.error?.code!=='ENOENT') assert.equal(python.stdout,`${EXECUTION_SMOKE_EXPECTED_OUTPUT}\n`);
  for(const program of Object.values(EXECUTION_SMOKE_PROGRAMS)){
    assert.ok(program.length<80);
    assert.doesNotMatch(program,/import|require|fetch|open|process|os\./);
  }
});

test('provider results and errors map to bounded categories',()=>{
  assert.equal(classifyExecutionResult(okRun()),'ok');
  assert.equal(classifyExecutionResult({...okRun(),stdout:`  ${EXECUTION_SMOKE_EXPECTED_OUTPUT}  `}),'ok');
  assert.equal(classifyExecutionResult({...okRun(),timedOut:true}),'timeout');
  assert.equal(classifyExecutionResult({...okRun(),code:1}),'provider_error');
  assert.equal(classifyExecutionResult({...okRun(),code:null}),'provider_error');
  assert.equal(classifyExecutionResult({...okRun(),stdout:'randori-smoke-41'}),'provider_error');
  assert.equal(classifyExecutionResult({code:0}),'provider_error');
  for(const value of [null,undefined,'ok',[okRun()]]) assert.equal(classifyExecutionResult(value),'provider_error');

  assert.equal(classifyExecutionError(abortError()),'timeout');
  const timeout=new Error('slow');
  timeout.name='TimeoutError';
  assert.equal(classifyExecutionError(timeout),'timeout');
  assert.equal(classifyExecutionError(new ExecutionUnavailableError('could not be created',{cause:abortError()})),'timeout');
  assert.equal(classifyExecutionError(new ExecutionUnavailableError('quota exhausted',{cause:new Error('402')})),
    'provider_error');
  assert.equal(classifyExecutionError(new ExecutionFailedError('not JSON')),'provider_error');
  let deep=abortError();
  for(let index=0;index<5;index+=1) deep=new Error(`wrap ${index}`,{cause:deep});
  assert.equal(classifyExecutionError(deep),'provider_error','only five levels are inspected');
  for(const value of [null,undefined,'boom']) assert.equal(classifyExecutionError(value),'provider_error');

  assert.equal(executionSmokeLanguagePasses({status:'ok'}),true);
  assert.equal(executionSmokeLanguagePasses({status:'throttled',lastStatus:null}),true);
  assert.equal(executionSmokeLanguagePasses({status:'throttled',lastStatus:'ok'}),true);
  assert.equal(executionSmokeLanguagePasses({status:'throttled',lastStatus:'timeout'}),false);
  for(const status of ['provider_error','timeout','misconfigured']){
    assert.equal(executionSmokeLanguagePasses({status}),false);
  }
  assert.equal(executionSmokeLanguagePasses(null),false);
});

test('an unconfigured provider reports misconfigured with no claim, quota or database use',async()=>{
  for(const env of [{},{EXECUTION_PROVIDER:'emkc'},{EXECUTION_PROVIDER:'piston'},
    {EXECUTION_PROVIDER:'piston',EXECUTION_API_URL:'https://emkc.org/api/v2/piston/execute'}]){
    let touched=false;
    const outcome=await runExecutionSmoke({env,getDb:()=>{ touched=true; return db; },
      execute:async()=>{ touched=true; return okRun(); },clock:()=>Date.parse('2026-10-20T08:00:00.000Z')});
    assert.equal(touched,false,JSON.stringify(env));
    assert.deepEqual(outcome,{status:200,body:{ok:false,checkedAt:'2026-10-20T08:00:00.000Z',languages:{
      javascript:{status:'misconfigured',durationMs:null},python:{status:'misconfigured',durationMs:null}}}});
  }
  assert.equal((await rows('execution_smoke_claim')).length,0);
  const broken=await runExecutionSmoke({env:{},getDb:()=>db,clock:()=>{ throw new Error('clock'); }});
  assert.equal(broken.body.checkedAt,null);
  assert.equal((await runExecutionSmoke({env:{},getDb:()=>db,clock:()=>Number.NaN})).body.checkedAt,null);
});

test('a real run executes both fixed programs once, records only statuses, and then throttles',async()=>{
  let tick=0;
  const {calls,run}=smoke({monotonic:()=>(tick+=250),clock:()=>Date.parse('2026-10-20T08:00:00.000Z')});
  const first=await run();
  assert.equal(first.status,200);
  assert.deepEqual(Object.keys(first.body).sort(),['checkedAt','languages','ok']);
  assert.equal(first.body.ok,true);
  assert.equal(first.body.checkedAt,'2026-10-20T08:00:00.000Z');
  assert.deepEqual(Object.keys(first.body.languages),['javascript','python']);
  for(const language of EXECUTION_SMOKE_LANGUAGES){
    assert.equal(first.body.languages[language].status,'ok');
    assert.ok(Number.isSafeInteger(first.body.languages[language].durationMs));
  }
  assert.deepEqual(calls.map(call=>call.language).sort(),['javascript','python']);
  for(const call of calls) assert.equal(call.source,EXECUTION_SMOKE_PROGRAMS[call.language]);

  const [claim]=await rows('execution_smoke_claim');
  assert.deepEqual({...claim},{level:'info',source:'runner',event:'execution_smoke_claim',
    message:'execution smoke claimed',meta_json:null,user_id:null,route:null,ua:null,ip:null});
  const [recorded]=await rows('execution_smoke_result');
  assert.equal(recorded.source,'runner');
  assert.equal(recorded.level,'info');
  assert.equal(recorded.user_id,null);
  assert.deepEqual(JSON.parse(recorded.meta_json),first.body.languages);

  const second=await run();
  assert.equal(calls.length,2,'no sandbox is created inside the window');
  assert.equal(second.status,200);
  assert.equal(second.body.ok,true);
  assert.match(second.body.checkedAt,/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
  assert.ok(second.body.ageSeconds>=0&&second.body.ageSeconds<60);
  for(const language of EXECUTION_SMOKE_LANGUAGES){
    assert.deepEqual(second.body.languages[language],{status:'throttled',
      durationMs:first.body.languages[language].durationMs,lastStatus:'ok'});
  }
  assert.equal((await rows('execution_smoke_claim')).length,1);
});

test('the throttle uses the database clock: 30-minute spacing and two real runs per rolling day',async()=>{
  const cases=[
    {seed:[{age:'-29 minutes'}],claimed:false},
    {seed:[{age:'-31 minutes'}],claimed:true},
    {seed:[{age:'-3 hours'},{age:'-5 hours'}],claimed:false},
    {seed:[{age:'-25 hours'},{age:'-2 hours'}],claimed:true},
    {seed:[{age:'-25 hours'},{age:'-26 hours'},{age:'-40 hours'}],claimed:true},
    // Rows that are not server-side smoke claims never count.
    {seed:[{source:'client',age:'-1 minutes'},{userId:7,age:'-1 minutes'},
      {event:'execute_lease_start',age:'-1 minutes'}],claimed:true},
  ];
  for(const {seed,claimed} of cases){
    await db.execute('DELETE FROM app_logs');
    for(const row of seed) await insertLog(row);
    const id=await claimExecutionSmoke(db);
    assert.equal(id!==null,claimed,JSON.stringify(seed));
    if(claimed) assert.ok(Number.isSafeInteger(id)&&id>0);
  }
});

test('concurrent callers produce exactly one real execution',async()=>{
  const claims=await Promise.all(Array.from({length:4},()=>claimExecutionSmoke(db)));
  assert.equal(claims.filter(Boolean).length,1);
  assert.equal((await rows('execution_smoke_claim')).length,1);
});

test('throttled responses report the latest result of the last day, never forged or stale rows',async()=>{
  const meta=JSON.stringify({javascript:{status:'timeout',durationMs:45000},python:{status:'ok',durationMs:900}});
  await insertLog({event:'execution_smoke_result',age:'-10 minutes',meta});
  await insertLog({event:'execution_smoke_result',age:'-2 days',
    meta:JSON.stringify({javascript:{status:'ok',durationMs:1},python:{status:'ok',durationMs:1}})});
  // Browser telemetry cannot write source=runner, and member rows carry a user id.
  const forged=JSON.stringify({javascript:{status:'ok',durationMs:1},python:{status:'ok',durationMs:1}});
  await insertLog({source:'client',event:'execution_smoke_result',age:'-1 minutes',meta:forged});
  await insertLog({event:'execution_smoke_result',age:'-1 minutes',userId:3,meta:forged});
  await insertLog({age:'-5 minutes'});

  const {calls,run}=smoke();
  const throttled=await run();
  assert.equal(calls.length,0);
  assert.equal(throttled.body.ok,false);
  assert.ok(throttled.body.ageSeconds>=600&&throttled.body.ageSeconds<660,String(throttled.body.ageSeconds));
  assert.deepEqual(throttled.body.languages,{
    javascript:{status:'throttled',durationMs:45000,lastStatus:'timeout'},
    python:{status:'throttled',durationMs:900,lastStatus:'ok'},
  });

  await db.execute(`DELETE FROM app_logs WHERE event='execution_smoke_result'`);
  const unknown=await run();
  assert.deepEqual(unknown.body,{ok:true,checkedAt:null,ageSeconds:null,languages:{
    javascript:{status:'throttled',durationMs:null,lastStatus:null},
    python:{status:'throttled',durationMs:null,lastStatus:null}}});
});

test('stored results are re-validated before they are reported',async()=>{
  const read=async(rows)=>readLastExecutionSmoke({execute:async()=>({rows})});
  assert.equal(await read([]),null);
  assert.equal(await read([{meta_json:'not json'}]),null);
  assert.equal(await read([{meta_json:'[1]'}]),null);
  assert.equal(await read([{meta_json:null}]),null);
  assert.deepEqual(await read([{meta_json:JSON.stringify({javascript:{status:'throttled',durationMs:5},
    python:{status:'ok',durationMs:-1}}),checked_at:'yesterday',age_seconds:-4}]),
  {checkedAt:null,ageSeconds:null,languages:{javascript:null,python:{status:'ok',durationMs:null}}});
  assert.deepEqual(await read([{meta_json:JSON.stringify({javascript:{status:'ok',durationMs:10*60*1000+1},
    python:'ok'}),checked_at:'2026-10-20T07:00:00Z',age_seconds:'12'}]),
  {checkedAt:'2026-10-20T07:00:00Z',ageSeconds:12,
    languages:{javascript:{status:'ok',durationMs:null},python:null}});
  assert.equal(await readLastExecutionSmoke({execute:async()=>{ throw new Error('SQL'); }}),null);
  assert.equal(await readLastExecutionSmoke(null),null);

  const partial=await runExecutionSmoke({env:SANDBOX,execute:async()=>okRun(),getDb:()=>({
    execute:async({sql})=>sql.startsWith('INSERT')?{rows:[]}
      :{rows:[{meta_json:JSON.stringify({python:{status:'provider_error',durationMs:3}}),
        checked_at:'2026-10-20T07:00:00Z',age_seconds:5}]},
  })});
  assert.deepEqual(partial.body,{ok:false,checkedAt:'2026-10-20T07:00:00Z',ageSeconds:5,languages:{
    javascript:{status:'throttled',durationMs:null,lastStatus:null},
    python:{status:'throttled',durationMs:3,lastStatus:'provider_error'}}});
});

test('each language failure maps to its own status and the result is recorded as a warning',async()=>{
  const execute=async({language})=>{
    if(language==='javascript') throw new ExecutionUnavailableError('Vercel Sandbox could not be created',
      {cause:new Error('https://api.vercel.com/v1/sandboxes?token=private-provider-token 402')});
    return {...okRun(),stdout:'Traceback: https://piston.example.test secret-output'};
  };
  const outcome=await runExecutionSmoke({getDb:()=>db,env:SANDBOX,execute});
  assert.equal(outcome.body.ok,false);
  assert.equal(outcome.body.languages.javascript.status,'provider_error');
  assert.equal(outcome.body.languages.python.status,'provider_error');
  const serialized=JSON.stringify(outcome.body)+JSON.stringify(await rows('execution_smoke_result'));
  assert.doesNotMatch(serialized,/vercel\.com|piston|token|secret|Traceback|Sandbox|402/i);
  assert.equal((await rows('execution_smoke_result'))[0].level,'warn');

  await db.execute('DELETE FROM app_logs');
  const timed=await runExecutionSmoke({getDb:()=>db,env:SANDBOX,execute:async({language})=>language==='python'
    ?{...okRun(),timedOut:true,code:null}:Promise.reject(abortError())});
  assert.deepEqual([timed.body.languages.javascript.status,timed.body.languages.python.status],['timeout','timeout']);

  await db.execute('DELETE FROM app_logs');
  const thrown=await runExecutionSmoke({getDb:()=>db,env:SANDBOX,execute:()=>{ throw new TypeError('sync'); }});
  assert.equal(thrown.body.languages.javascript.status,'provider_error');
});

test('a hung provider call is cut off at the deadline and reported as timeout',async()=>{
  assert.equal(EXECUTION_SMOKE_LANGUAGE_DEADLINE_MS,45_000);
  const timers=[];
  const cleared=[];
  const outcome=await runExecutionSmoke({getDb:()=>db,env:SANDBOX,deadlineMs:1234,
    execute:()=>new Promise(()=>{}),
    setTimer:(callback,ms)=>{ timers.push(ms); queueMicrotask(callback); return timers.length; },
    clearTimer:id=>cleared.push(id)});
  assert.deepEqual(outcome.body.languages,{javascript:{status:'timeout',durationMs:outcome.body.languages.javascript.durationMs},
    python:{status:'timeout',durationMs:outcome.body.languages.python.durationMs}});
  assert.deepEqual(timers,[1234,1234]);
  assert.deepEqual(cleared.sort(),[1,2]);

  await db.execute('DELETE FROM app_logs');
  const brokenTimer=await runExecutionSmoke({getDb:()=>db,env:SANDBOX,execute:async()=>okRun(),
    setTimer:()=>{ throw new Error('no timers'); },clearTimer:()=>{ throw new Error('no timers'); }});
  assert.equal(brokenTimer.body.languages.javascript.status,'provider_error');
  assert.equal(brokenTimer.status,200);

  await db.execute('DELETE FROM app_logs');
  const odd=await runExecutionSmoke({getDb:()=>db,env:SANDBOX,execute:async()=>okRun(),monotonic:()=>Number.NaN});
  assert.equal(odd.body.languages.javascript.durationMs,null);
  await db.execute('DELETE FROM app_logs');
  let clock=0;
  const huge=await runExecutionSmoke({getDb:()=>db,env:SANDBOX,execute:async()=>okRun(),
    monotonic:()=>(clock+=20*60*1000)});
  assert.equal(huge.body.languages.javascript.durationMs,10*60*1000);
});

test('the check fails closed and never throws when the throttle store is unavailable',async()=>{
  const unavailable={status:503,body:{ok:false,error:'execution smoke unavailable'}};
  let executed=0;
  const execute=async()=>{ executed+=1; return okRun(); };
  assert.deepEqual(await runExecutionSmoke({env:SANDBOX,execute,getDb:()=>{ throw new Error('no TURSO url'); }}),
    unavailable);
  assert.deepEqual(await runExecutionSmoke({env:SANDBOX,execute,
    getDb:()=>({execute:async()=>{ throw new Error('no such table: app_logs'); }})}),unavailable);
  assert.deepEqual(await runExecutionSmoke({env:SANDBOX,execute}),unavailable);
  assert.equal(executed,0);

  // A recording failure after a real run still returns the fresh result.
  let inserts=0;
  const flaky={execute:async({sql,args})=>{
    if(sql.includes('execution smoke completed')) throw new Error('write failed');
    inserts+=1;
    return db.execute({sql,args});
  }};
  const fresh=await runExecutionSmoke({env:SANDBOX,execute,getDb:()=>flaky});
  assert.equal(fresh.body.ok,true);
  assert.equal(inserts,1);
  assert.equal(await recordExecutionSmoke(flaky,{}),false);
  assert.equal(await recordExecutionSmoke(db,{javascript:{status:'ok',durationMs:1},
    python:{status:'ok',durationMs:1}}),true);

  // Anything unexpected after the claim is still a bounded 503.
  await db.execute('DELETE FROM app_logs');
  assert.deepEqual(await runExecutionSmoke({env:SANDBOX,execute,getDb:()=>db,
    monotonic:()=>{ throw new Error('clock'); }}),unavailable);
  assert.deepEqual(await runExecutionSmoke({env:null,getDb:()=>db}),unavailable);
});

test('the real execution boundary is used for Piston and Vercel Sandbox configuration',async()=>{
  const requests=[];
  const fetchImpl=async(url,init)=>{
    const body=JSON.parse(init.body);
    requests.push({url,authorization:init.headers.Authorization,body});
    const node=body.language==='javascript'
      ?spawnSync(process.execPath,['-e',body.files[0].content],{encoding:'utf8'}).stdout
      :`${EXECUTION_SMOKE_EXPECTED_OUTPUT}\n`;
    return new Response(JSON.stringify({run:{stdout:node,stderr:'private stderr',code:0}}),
      {status:200,headers:{'content-type':'application/json'}});
  };
  const piston=await runExecutionSmoke({getDb:()=>db,env:PISTON,
    execute:(request,options)=>executeProgram(request,{...options,fetchImpl})});
  assert.equal(piston.body.ok,true,JSON.stringify(piston.body));
  assert.deepEqual(requests.map(item=>item.body.language).sort(),['javascript','python']);
  assert.ok(requests.every(item=>item.url===PISTON.EXECUTION_API_URL));
  assert.ok(requests.every(item=>item.authorization==='Bearer piston-token-private-value'));
  assert.doesNotMatch(JSON.stringify(piston.body),/piston|token|stderr/i);

  await db.execute('DELETE FROM app_logs');
  const created=[];
  const loadSandboxSdk=async()=>({Sandbox:{create:async options=>{
    created.push(options);
    if(options.image.includes('python')) throw abortError();
    return {
      writeFiles:async()=>{},
      runCommand:async({stdout})=>{ stdout.write(`${EXECUTION_SMOKE_EXPECTED_OUTPUT}\n`); return {exitCode:0}; },
      delete:async()=>{},
    };
  }}});
  const sandbox=await runExecutionSmoke({getDb:()=>db,env:SANDBOX,
    execute:(request,options)=>executeProgram(request,{...options,loadSandboxSdk})});
  assert.deepEqual(sandbox.body.languages.javascript.status,'ok');
  assert.deepEqual(sandbox.body.languages.python.status,'timeout');
  assert.ok(created.every(options=>options.networkPolicy==='deny-all'&&options.persistent===false));
});
