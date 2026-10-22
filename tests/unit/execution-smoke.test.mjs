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
  EXECUTION_SMOKE_EXPECTED_OUTPUT,
  EXECUTION_SMOKE_LANGUAGE_DEADLINE_MS,
  EXECUTION_SMOKE_LANGUAGES,
  EXECUTION_SMOKE_LAST_STATUSES,
  EXECUTION_SMOKE_PROGRAMS,
  EXECUTION_SMOKE_RESULT_GRACE_SECONDS,
  EXECUTION_SMOKE_STATUSES,
  EXECUTION_SMOKE_TRIGGER_WINDOWS,
  executionSmokeLanguagePasses,
  parseExecutionSmokeRequest,
  readLatestExecutionSmoke,
  recordExecutionSmoke,
  runExecutionSmoke,
  throttledExecutionSmokeBody,
} from '../../api/_execution-smoke.js';

const directory=mkdtempSync(join(tmpdir(),'randori-execution-smoke-'));
const databaseUrl=`file:${join(directory,'smoke.sqlite')}`;
const db=createClient({url:databaseUrl});
const SANDBOX={EXECUTION_PROVIDER:'vercel-sandbox'};
const PISTON={EXECUTION_PROVIDER:'piston',EXECUTION_API_URL:'https://piston.example.test/api/v2/execute',
  EXECUTION_API_TOKEN:'piston-token-private-value'};
const okRun=()=>({provider:'vercel-sandbox',stdout:`${EXECUTION_SMOKE_EXPECTED_OUTPUT}\n`,stderr:'',code:0,timedOut:false});
const OK_META=JSON.stringify({javascript:{status:'ok',durationMs:700},python:{status:'ok',durationMs:800}});

function abortError(){
  const error=new Error('This operation was aborted');
  error.name='AbortError';
  return error;
}

async function rows(event){
  return (await db.execute({sql:`SELECT id,level,source,event,message,meta_json,user_id,route,ua,ip
    FROM app_logs WHERE event=? ORDER BY id`,args:[event]})).rows;
}

async function insertLog({source='runner',event='execution_smoke_claim',message='schedule',age='-1 minutes',
  userId=null,meta=null}){
  const inserted=await db.execute({sql:`INSERT INTO app_logs (level,source,event,message,meta_json,user_id,created_at)
    VALUES ('info',?,?,?,?,?,datetime('now',?))`,args:[source,event,message,meta,userId,age]});
  return Number(inserted.lastInsertRowid);
}

// A claim plus, optionally, the result saved for that exact claim.
async function insertRun({trigger='deploy',age,saved=true,meta=OK_META}){
  const claimId=await insertLog({message:trigger,age});
  if(saved) await insertLog({event:'execution_smoke_result',message:String(claimId),age,meta});
  return claimId;
}

function smoke(options={}){
  const calls=[];
  const execute=options.execute||(async request=>{ calls.push(request); return okRun(); });
  return {calls,run:()=>runExecutionSmoke({trigger:'schedule',getDb:()=>db,env:SANDBOX,...options,execute})};
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
  assert.deepEqual(EXECUTION_SMOKE_LAST_STATUSES,['ok','provider_error','timeout','misconfigured','result_missing']);
  assert.deepEqual(EXECUTION_SMOKE_TRIGGER_WINDOWS,{schedule:'-20 hours',deploy:'-1 day'});
  assert.equal(EXECUTION_SMOKE_RESULT_GRACE_SECONDS,165);
  const node=spawnSync(process.execPath,['-e',EXECUTION_SMOKE_PROGRAMS.javascript],{encoding:'utf8'});
  assert.equal(node.stdout,`${EXECUTION_SMOKE_EXPECTED_OUTPUT}\n`);
  const python=spawnSync('python3',['-c',EXECUTION_SMOKE_PROGRAMS.python],{encoding:'utf8'});
  if(python.error?.code!=='ENOENT') assert.equal(python.stdout,`${EXECUTION_SMOKE_EXPECTED_OUTPUT}\n`);
  for(const program of Object.values(EXECUTION_SMOKE_PROGRAMS)){
    assert.ok(program.length<80);
    assert.doesNotMatch(program,/import|require|fetch|open|process|os\./);
  }
});

test('requests must be exactly {"trigger":"schedule"|"deploy"}',async()=>{
  assert.equal(parseExecutionSmokeRequest({trigger:'schedule'}),'schedule');
  assert.equal(parseExecutionSmokeRequest({trigger:'deploy'}),'deploy');
  for(const body of [undefined,null,'',{},'{"trigger":"deploy"}',[{trigger:'deploy'}],{trigger:'Deploy'},
    {trigger:'dispatch'},{trigger:'toString'},{trigger:'__proto__'},{trigger:['deploy']},
    {trigger:'deploy',extra:1},{kind:'deploy'},Object.assign(Object.create(null),{trigger:'deploy'}),
    Object.assign(Object.create({inherited:true}),{trigger:'deploy'})]){
    assert.equal(parseExecutionSmokeRequest(body),null,JSON.stringify(body));
  }
  for(const trigger of [null,undefined,'dispatch','constructor']){
    let touched=false;
    const outcome=await runExecutionSmoke({trigger,env:{},getDb:()=>{ touched=true; return db; }});
    assert.deepEqual(outcome,{status:400,body:{ok:false,error:'invalid smoke request'}});
    assert.equal(touched,false);
  }
  await assert.rejects(claimExecutionSmoke(db,'dispatch'),TypeError);
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
  for(const lastStatus of ['timeout','result_missing','provider_error']){
    assert.equal(executionSmokeLanguagePasses({status:'throttled',lastStatus}),false);
  }
  for(const status of ['provider_error','timeout','misconfigured']){
    assert.equal(executionSmokeLanguagePasses({status}),false);
  }
  assert.equal(executionSmokeLanguagePasses(null),false);
});

test('an unconfigured provider reports misconfigured with no claim, quota or database use',async()=>{
  for(const env of [{},{EXECUTION_PROVIDER:'emkc'},{EXECUTION_PROVIDER:'piston'},
    {EXECUTION_PROVIDER:'piston',EXECUTION_API_URL:'https://emkc.org/api/v2/piston/execute'}]){
    let touched=false;
    const outcome=await runExecutionSmoke({trigger:'deploy',env,getDb:()=>{ touched=true; return db; },
      execute:async()=>{ touched=true; return okRun(); },clock:()=>Date.parse('2026-10-20T08:00:00.000Z')});
    assert.equal(touched,false,JSON.stringify(env));
    assert.deepEqual(outcome,{status:200,body:{ok:false,checkedAt:'2026-10-20T08:00:00.000Z',languages:{
      javascript:{status:'misconfigured',durationMs:null},python:{status:'misconfigured',durationMs:null}}}});
  }
  assert.equal((await rows('execution_smoke_claim')).length,0);
  const broken=await runExecutionSmoke({trigger:'deploy',env:{},getDb:()=>db,clock:()=>{ throw new Error('clock'); }});
  assert.equal(broken.body.checkedAt,null);
  assert.equal((await runExecutionSmoke({trigger:'deploy',env:{},getDb:()=>db,clock:()=>Number.NaN})).body.checkedAt,
    null);
});

test('a real run executes both fixed programs once, saves only statuses linked to its claim, then throttles',
  async()=>{
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
    assert.deepEqual({...claim,id:0},{id:0,level:'info',source:'runner',event:'execution_smoke_claim',
      message:'schedule',meta_json:null,user_id:null,route:null,ua:null,ip:null});
    const [saved]=await rows('execution_smoke_result');
    assert.equal(saved.source,'runner');
    assert.equal(saved.level,'info');
    assert.equal(saved.user_id,null);
    assert.equal(saved.message,String(claim.id));
    assert.deepEqual(JSON.parse(saved.meta_json),first.body.languages);

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

test('each trigger has its own database-clock slot and claims stay 30 minutes apart',async()=>{
  const cases=[
    // The schedule/dispatch slot is 20 hours.
    {trigger:'schedule',seed:[{message:'schedule',age:'-19 hours'}],claimed:false},
    {trigger:'schedule',seed:[{message:'schedule',age:'-21 hours'}],claimed:true},
    // The deploy slot is 24 hours: claims at -7 h and -20 h both still count.
    {trigger:'deploy',seed:[{message:'deploy',age:'-7 hours'}],claimed:false},
    {trigger:'deploy',seed:[{message:'deploy',age:'-20 hours'}],claimed:false},
    {trigger:'deploy',seed:[{message:'deploy',age:'-23 hours'}],claimed:false},
    {trigger:'deploy',seed:[{message:'deploy',age:'-25 hours'},{message:'deploy',age:'-40 hours'}],claimed:true},
    // Deploy runs never use up the scheduled slot, and the reverse.
    {trigger:'schedule',seed:[{message:'deploy',age:'-2 hours'},{message:'deploy',age:'-5 hours'}],claimed:true},
    {trigger:'deploy',seed:[{message:'schedule',age:'-2 hours'}],claimed:true},
    // Any two real runs stay at least 30 minutes apart.
    {trigger:'schedule',seed:[{message:'deploy',age:'-29 minutes'}],claimed:false},
    {trigger:'deploy',seed:[{message:'schedule',age:'-29 minutes'}],claimed:false},
    {trigger:'schedule',seed:[{message:'deploy',age:'-31 minutes'}],claimed:true},
    // Member rows (user_id set), browser rows and other runner events never count.
    {trigger:'deploy',seed:[{message:'deploy',age:'-3 hours',userId:7},{message:'deploy',age:'-5 hours',userId:8},
      {message:'deploy',age:'-10 minutes',userId:9}],claimed:true},
    {trigger:'deploy',seed:[{source:'client',message:'deploy',age:'-10 minutes'},
      {source:'client',message:'deploy',age:'-3 hours'}],claimed:true},
    {trigger:'schedule',seed:[{event:'execute_lease_start',age:'-10 minutes'},
      {event:'execution_smoke_result',message:'schedule',age:'-3 hours'}],claimed:true},
  ];
  for(const {trigger,seed,claimed} of cases){
    await db.execute('DELETE FROM app_logs');
    for(const row of seed) await insertLog(row);
    const id=await claimExecutionSmoke(db,trigger);
    assert.equal(id!==null,claimed,`${trigger} ${JSON.stringify(seed)}`);
    if(claimed) assert.ok(Number.isSafeInteger(id)&&id>0);
  }
});

test('separate database connections produce exactly one claim per round',async()=>{
  const clients=Array.from({length:6},()=>createClient({url:databaseUrl}));
  try{
    for(const client of clients) await client.execute('PRAGMA busy_timeout = 5000');
    for(let round=0;round<30;round+=1){
      await db.execute('DELETE FROM app_logs');
      const trigger=round%2?'deploy':'schedule';
      const claims=await Promise.all(clients.map(client=>claimExecutionSmoke(client,trigger)));
      assert.equal(claims.filter(Boolean).length,1,`round ${round}`);
      assert.equal((await rows('execution_smoke_claim')).length,1);
    }
  }finally{
    for(const client of clients) client.close();
  }
});

test('throttled responses report the result saved for the latest claim, never forged or unlinked rows',async()=>{
  await insertRun({trigger:'schedule',age:'-10 minutes',
    meta:JSON.stringify({javascript:{status:'timeout',durationMs:45000},python:{status:'ok',durationMs:900}})});
  // Browser telemetry cannot write source=runner, member rows carry a user id,
  // and a result only counts when it names the latest claim.
  const forged=OK_META;
  await insertLog({source:'client',event:'execution_smoke_result',message:'1',age:'-1 minutes',meta:forged});
  await insertLog({event:'execution_smoke_result',message:'1',age:'-1 minutes',userId:3,meta:forged});
  await insertLog({event:'execution_smoke_result',message:'seeded',age:'-1 minutes',meta:forged});
  await insertLog({source:'client',message:'schedule',age:'-1 minutes'});

  const {calls,run}=smoke();
  const throttled=await run();
  assert.equal(calls.length,0);
  assert.equal(throttled.body.ok,false);
  assert.match(throttled.body.checkedAt,/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
  assert.ok(throttled.body.ageSeconds>=600&&throttled.body.ageSeconds<660,String(throttled.body.ageSeconds));
  assert.deepEqual(throttled.body.languages,{
    javascript:{status:'throttled',durationMs:45000,lastStatus:'timeout'},
    python:{status:'throttled',durationMs:900,lastStatus:'ok'},
  });
});

test('a run whose result was never saved fails once the result grace has passed',async()=>{
  const lastStatuses=body=>EXECUTION_SMOKE_LANGUAGES.map(language=>body.languages[language].lastStatus);
  const {calls,run}=smoke({trigger:'deploy'});

  // The review repro: an ok run six hours ago, then a claim five minutes ago
  // that never saved a result. The older ok result must not be reported.
  await insertRun({trigger:'schedule',age:'-6 hours'});
  await insertRun({trigger:'deploy',age:'-5 minutes',saved:false});
  let body=(await run()).body;
  assert.deepEqual(lastStatuses(body),['result_missing','result_missing']);
  assert.equal(body.ok,false);
  assert.equal(body.checkedAt,null);
  assert.ok(body.ageSeconds>=300&&body.ageSeconds<360);
  assert.deepEqual(body.languages.javascript,{status:'throttled',durationMs:null,lastStatus:'result_missing'});

  // With no saved result at all.
  await db.execute('DELETE FROM app_logs');
  await insertRun({trigger:'deploy',age:'-10 minutes',saved:false});
  assert.deepEqual(lastStatuses((await run()).body),['result_missing','result_missing']);

  // Still inside the grace: in flight, not yet a failure.
  for(const [age,expected,ok] of [
    ['-1 minutes',null,true],
    [`-${EXECUTION_SMOKE_RESULT_GRACE_SECONDS-5} seconds`,null,true],
    [`-${EXECUTION_SMOKE_RESULT_GRACE_SECONDS+5} seconds`,'result_missing',false],
  ]){
    await db.execute('DELETE FROM app_logs');
    await insertRun({trigger:'schedule',age:'-6 hours'});
    await insertRun({trigger:'deploy',age,saved:false});
    body=(await run()).body;
    assert.deepEqual(lastStatuses(body),[expected,expected],age);
    assert.equal(body.ok,ok,age);
  }

  // A saved result with an unreadable entry reports that language as missing.
  await db.execute('DELETE FROM app_logs');
  await insertRun({trigger:'deploy',age:'-1 minutes',
    meta:JSON.stringify({javascript:{status:'throttled',durationMs:5},python:{status:'ok',durationMs:-1}})});
  body=(await run()).body;
  assert.deepEqual(body.languages,{javascript:{status:'throttled',durationMs:null,lastStatus:'result_missing'},
    python:{status:'throttled',durationMs:null,lastStatus:'ok'}});
  assert.equal(body.ok,false);
  for(const meta of ['not json','[1]',null]){
    await db.execute('DELETE FROM app_logs');
    await insertRun({trigger:'deploy',age:'-1 minutes',meta});
    assert.deepEqual(lastStatuses((await run()).body),['result_missing','result_missing'],String(meta));
  }
  assert.equal(calls.length,0);
});

test('a lost save after a real run shows as result_missing on the next throttled check',async()=>{
  const flaky={execute:async({sql,args})=>{
    if(args.includes('execution_smoke_result')&&sql.includes('VALUES')) throw new Error('write failed');
    return db.execute({sql,args});
  }};
  const fresh=await runExecutionSmoke({trigger:'deploy',env:SANDBOX,execute:async()=>okRun(),getDb:()=>flaky});
  assert.equal(fresh.body.ok,true,'the fresh response still reports what really ran');
  assert.equal((await rows('execution_smoke_result')).length,0);
  // Simulate the grace passing on the database clock.
  await db.execute(`UPDATE app_logs SET created_at=datetime('now','-10 minutes') WHERE event='execution_smoke_claim'`);
  const later=await runExecutionSmoke({trigger:'deploy',env:SANDBOX,execute:async()=>okRun(),getDb:()=>db});
  assert.equal(later.body.ok,false);
  assert.equal(later.body.languages.python.lastStatus,'result_missing');
});

test('the latest-run reader and throttled body fail closed on missing or odd rows',async()=>{
  const read=rows=>readLatestExecutionSmoke({execute:async()=>({rows})});
  assert.equal(await read([]),null);
  assert.equal(await read(undefined),null);
  assert.deepEqual(await read([{claim_age_seconds:-4,result_id:null,meta_json:null,checked_at:null}]),
    {claimAgeSeconds:null,saved:false,checkedAt:null,languages:null});
  assert.deepEqual(await read([{claim_age_seconds:'12',result_id:9,checked_at:'yesterday',
    meta_json:JSON.stringify({javascript:{status:'ok',durationMs:10*60*1000+1},python:'ok'})}]),
  {claimAgeSeconds:12,saved:true,checkedAt:null,
    languages:{javascript:{status:'ok',durationMs:null},python:null}});
  assert.deepEqual(await read([{claim_age_seconds:30,result_id:9,checked_at:'2026-10-20T07:00:00Z',meta_json:OK_META}]),
    {claimAgeSeconds:30,saved:true,checkedAt:'2026-10-20T07:00:00Z',
      languages:{javascript:{status:'ok',durationMs:700},python:{status:'ok',durationMs:800}}});
  await assert.rejects(readLatestExecutionSmoke({execute:async()=>{ throw new Error('SQL'); }}));

  const missing={status:'throttled',durationMs:null,lastStatus:'result_missing'};
  // No claim at all, or a claim whose age cannot be read, is never "in flight".
  assert.deepEqual(throttledExecutionSmokeBody(null),{ok:false,checkedAt:null,ageSeconds:null,
    languages:{javascript:missing,python:missing}});
  assert.deepEqual(throttledExecutionSmokeBody({claimAgeSeconds:null,saved:false,checkedAt:null,languages:null})
    .languages.javascript,missing);

  // Through the runner: a refused claim with no readable claim, or a failing read, fails closed.
  const throttledDb=readRows=>({execute:async({sql})=>sql.startsWith('INSERT')?{rows:[]}:readRows()});
  const none=await runExecutionSmoke({trigger:'deploy',env:SANDBOX,execute:async()=>okRun(),
    getDb:()=>throttledDb(()=>({rows:[]}))});
  assert.equal(none.body.ok,false);
  assert.equal(none.body.languages.javascript.lastStatus,'result_missing');
  const failingRead=await runExecutionSmoke({trigger:'deploy',env:SANDBOX,execute:async()=>okRun(),
    getDb:()=>throttledDb(()=>{ throw new Error('read failed'); })});
  assert.deepEqual(failingRead,{status:503,body:{ok:false,error:'execution smoke unavailable'}});
});

test('each language failure maps to its own status and the result is saved as a warning',async()=>{
  const execute=async({language})=>{
    if(language==='javascript') throw new ExecutionUnavailableError('Vercel Sandbox could not be created',
      {cause:new Error('https://api.vercel.com/v1/sandboxes?token=private-provider-token 402')});
    return {...okRun(),stdout:'Traceback: https://piston.example.test secret-output'};
  };
  const outcome=await runExecutionSmoke({trigger:'deploy',getDb:()=>db,env:SANDBOX,execute});
  assert.equal(outcome.body.ok,false);
  assert.equal(outcome.body.languages.javascript.status,'provider_error');
  assert.equal(outcome.body.languages.python.status,'provider_error');
  const serialized=JSON.stringify(outcome.body)+JSON.stringify(await rows('execution_smoke_result'));
  assert.doesNotMatch(serialized,/vercel\.com|piston|token|secret|Traceback|Sandbox|402/i);
  assert.equal((await rows('execution_smoke_result'))[0].level,'warn');

  await db.execute('DELETE FROM app_logs');
  const timed=await runExecutionSmoke({trigger:'deploy',getDb:()=>db,env:SANDBOX,
    execute:async({language})=>language==='python'?{...okRun(),timedOut:true,code:null}:Promise.reject(abortError())});
  assert.deepEqual([timed.body.languages.javascript.status,timed.body.languages.python.status],['timeout','timeout']);

  await db.execute('DELETE FROM app_logs');
  const thrown=await runExecutionSmoke({trigger:'deploy',getDb:()=>db,env:SANDBOX,
    execute:()=>{ throw new TypeError('sync'); }});
  assert.equal(thrown.body.languages.javascript.status,'provider_error');
});

test('a hung provider call is cut off at the deadline and reported as timeout',async()=>{
  assert.equal(EXECUTION_SMOKE_LANGUAGE_DEADLINE_MS,45_000);
  const timers=[];
  const cleared=[];
  const outcome=await runExecutionSmoke({trigger:'deploy',getDb:()=>db,env:SANDBOX,deadlineMs:1234,
    execute:()=>new Promise(()=>{}),
    setTimer:(callback,ms)=>{ timers.push(ms); queueMicrotask(callback); return timers.length; },
    clearTimer:id=>cleared.push(id)});
  assert.deepEqual(outcome.body.languages,{javascript:{status:'timeout',durationMs:outcome.body.languages.javascript.durationMs},
    python:{status:'timeout',durationMs:outcome.body.languages.python.durationMs}});
  assert.deepEqual(timers,[1234,1234]);
  assert.deepEqual(cleared.sort(),[1,2]);

  await db.execute('DELETE FROM app_logs');
  const brokenTimer=await runExecutionSmoke({trigger:'deploy',getDb:()=>db,env:SANDBOX,execute:async()=>okRun(),
    setTimer:()=>{ throw new Error('no timers'); },clearTimer:()=>{ throw new Error('no timers'); }});
  assert.equal(brokenTimer.body.languages.javascript.status,'provider_error');
  assert.equal(brokenTimer.status,200);

  await db.execute('DELETE FROM app_logs');
  const odd=await runExecutionSmoke({trigger:'deploy',getDb:()=>db,env:SANDBOX,execute:async()=>okRun(),
    monotonic:()=>Number.NaN});
  assert.equal(odd.body.languages.javascript.durationMs,null);
  await db.execute('DELETE FROM app_logs');
  let clock=0;
  const huge=await runExecutionSmoke({trigger:'deploy',getDb:()=>db,env:SANDBOX,execute:async()=>okRun(),
    monotonic:()=>(clock+=20*60*1000)});
  assert.equal(huge.body.languages.javascript.durationMs,10*60*1000);
});

test('the check fails closed and never throws when the throttle store is unavailable',async()=>{
  const unavailable={status:503,body:{ok:false,error:'execution smoke unavailable'}};
  let executed=0;
  const execute=async()=>{ executed+=1; return okRun(); };
  assert.deepEqual(await runExecutionSmoke({trigger:'deploy',env:SANDBOX,execute,
    getDb:()=>{ throw new Error('no TURSO url'); }}),unavailable);
  assert.deepEqual(await runExecutionSmoke({trigger:'deploy',env:SANDBOX,execute,
    getDb:()=>({execute:async()=>{ throw new Error('no such table: app_logs'); }})}),unavailable);
  assert.deepEqual(await runExecutionSmoke({trigger:'deploy',env:SANDBOX,execute}),unavailable);
  assert.equal(executed,0);

  assert.equal(await recordExecutionSmoke({execute:async()=>{ throw new Error('write failed'); }},1,{}),false);
  assert.equal(await recordExecutionSmoke(db,1,{javascript:{status:'ok',durationMs:1},
    python:{status:'ok',durationMs:1}}),true);

  // Anything unexpected after the claim is still a bounded 503.
  await db.execute('DELETE FROM app_logs');
  assert.deepEqual(await runExecutionSmoke({trigger:'deploy',env:SANDBOX,execute,getDb:()=>db,
    monotonic:()=>{ throw new Error('clock'); }}),unavailable);
  assert.deepEqual(await runExecutionSmoke({trigger:'deploy',env:null,getDb:()=>db}),unavailable);
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
  const piston=await runExecutionSmoke({trigger:'deploy',getDb:()=>db,env:PISTON,
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
  const sandbox=await runExecutionSmoke({trigger:'deploy',getDb:()=>db,env:SANDBOX,
    execute:(request,options)=>executeProgram(request,{...options,loadSandboxSdk})});
  assert.deepEqual(sandbox.body.languages.javascript.status,'ok');
  assert.deepEqual(sandbox.body.languages.python.status,'timeout');
  assert.ok(created.every(options=>options.networkPolicy==='deny-all'&&options.persistent===false));
});
