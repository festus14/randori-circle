// Issue #249: the execution-smoke workflow assessor and workflow contract.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { parseDocument } from 'yaml';

import {
  assessExecutionSmoke,
  EXECUTION_SMOKE_FORMAT,
  EXECUTION_SMOKE_PATH,
  fetchExecutionSmoke,
  main,
} from '../../scripts/github-execution-smoke.mjs';

const SECRET='private-cron-secret-value';
const ENV={APP_URL:'https://randori.example.test',CRON_SECRET:SECRET,EXECUTION_SMOKE_TIMEOUT_MS:'100000',
  EXECUTION_SMOKE_TRIGGER:'deploy'};
const fresh=(javascript='ok',python='ok')=>({
  ok:javascript==='ok'&&python==='ok',checkedAt:'2026-10-20T08:00:00.000Z',
  languages:{javascript:{status:javascript,durationMs:812},python:{status:python,durationMs:905}},
});
const throttled=(javascript='ok',python='ok',{ageSeconds=312,checkedAt='2026-10-20T07:55:00Z'}={})=>({
  ok:[javascript,python].every(last=>last===null||last==='ok'),checkedAt,ageSeconds,
  languages:{javascript:{status:'throttled',durationMs:javascript?812:null,lastStatus:javascript},
    python:{status:'throttled',durationMs:python?905:null,lastStatus:python}},
});

function jsonResponse(body,{status=200,headers={}}={}){
  return new Response(typeof body==='string'?body:JSON.stringify(body),
    {status,headers:{'content-type':'application/json',...headers}});
}

function capture(){
  let text='';
  return {stream:{write(chunk){ text+=chunk; }},get text(){ return text; }};
}

test('fresh and throttled bodies pass only when every language is ok or throttled after an ok run',()=>{
  assert.deepEqual(assessExecutionSmoke(fresh()),{ok:true,category:null,checkedAt:'2026-10-20T08:00:00.000Z',
    ageSeconds:null,languages:{javascript:{status:'ok',durationMs:812},python:{status:'ok',durationMs:905}}});
  for(const status of ['provider_error','timeout','misconfigured']){
    const outcome=assessExecutionSmoke(fresh('ok',status));
    assert.equal(outcome.ok,false,status);
    assert.equal(outcome.category,'execution_failed');
    assert.equal(outcome.languages.python.status,status);
  }
  const cached=assessExecutionSmoke(throttled());
  assert.equal(cached.ok,true);
  assert.equal(cached.ageSeconds,312);
  assert.equal(cached.languages.python.lastStatus,'ok');
  const unknown=assessExecutionSmoke(throttled(null,null,{ageSeconds:null,checkedAt:null}));
  assert.equal(unknown.ok,true,'an in-flight or unrecorded run is not an alert');
  const cachedFailure=assessExecutionSmoke(throttled('timeout','ok'));
  assert.deepEqual([cachedFailure.ok,cachedFailure.category],[false,'execution_failed'],
    'a throttled response cannot hide the last failure');
  const lost=assessExecutionSmoke(throttled('result_missing','result_missing',{checkedAt:null}));
  assert.deepEqual([lost.ok,lost.category,lost.languages.javascript.lastStatus],
    [false,'execution_failed','result_missing'],'a result that was never saved is a failure');
});

test('malformed or inconsistent bodies fail closed',()=>{
  const malformed=[
    null,[],'ok',{},{...fresh(),languages:[]},
    {...fresh(),languages:{javascript:fresh().languages.javascript}},
    {...fresh(),languages:{...fresh().languages,python:{status:'unknown',durationMs:1}}},
    {...fresh(),languages:{...fresh().languages,python:{status:'ok',durationMs:-1}}},
    {...fresh(),languages:{...fresh().languages,python:{status:'ok',durationMs:10*60*1000+1}}},
    {...fresh(),languages:{...fresh().languages,python:{status:'ok',durationMs:'5'}}},
    {...fresh(),languages:{...fresh().languages,python:{status:'ok',durationMs:5,lastStatus:'ok'}}},
    {...throttled(),languages:{...throttled().languages,python:{status:'throttled',durationMs:1,lastStatus:'throttled'}}},
    {...throttled(),languages:{...throttled().languages,python:{status:'throttled',durationMs:1}}},
    {...fresh(),ok:false},{...fresh('timeout'),ok:true},{...fresh(),ok:'true'},
    {...fresh(),checkedAt:null},{...fresh(),checkedAt:'yesterday'},{...fresh(),checkedAt:'2026-13-45T99:99:99Z'},
    {...throttled(),ageSeconds:-1},{...throttled(),ageSeconds:undefined},{...throttled(),ageSeconds:2*24*60*60+1},
  ];
  for(const body of malformed){
    assert.deepEqual(assessExecutionSmoke(body),{ok:false,category:'malformed_response',languages:null,
      checkedAt:null,ageSeconds:null},JSON.stringify(body));
  }
});

test('the request is one authenticated POST to the smoke route with a bounded timeout',async()=>{
  const requests=[];
  const timers=[];
  const cleared=[];
  const outcome=await fetchExecutionSmoke({...ENV,APP_URL:'https://randori.example.test/'},{
    fetchImpl:async(url,init)=>{ requests.push({url,init}); return jsonResponse(fresh()); },
    setTimer:(callback,ms)=>{ timers.push({callback,ms}); return 7; },
    clearTimer:id=>cleared.push(id),
  });
  assert.deepEqual(outcome,{body:fresh()});
  assert.equal(EXECUTION_SMOKE_PATH,'/api/cron/execution-smoke');
  assert.equal(requests.length,1);
  assert.equal(requests[0].url,'https://randori.example.test/api/cron/execution-smoke');
  assert.equal(requests[0].init.method,'POST');
  assert.equal(requests[0].init.redirect,'error');
  assert.deepEqual(requests[0].init.headers,{accept:'application/json','content-type':'application/json',
    authorization:`Bearer ${SECRET}`});
  assert.equal(requests[0].init.body,'{"trigger":"deploy"}');
  const scheduled=[];
  await fetchExecutionSmoke({...ENV,EXECUTION_SMOKE_TRIGGER:'schedule'},{
    fetchImpl:async(url,init)=>{ scheduled.push(init.body); return jsonResponse(fresh()); }});
  assert.deepEqual(scheduled,['{"trigger":"schedule"}']);
  assert.deepEqual(timers.map(item=>item.ms),[100000]);
  assert.deepEqual(cleared,[7]);
  timers[0].callback();
  assert.equal(requests[0].init.signal.aborted,true);
});

test('configuration, HTTP and transport failures map to bounded categories',async()=>{
  for(const environment of [{...ENV,APP_URL:''},{...ENV,APP_URL:'http://randori.example.test'},
    {...ENV,APP_URL:'https://randori.example.test/path'},{...ENV,APP_URL:'https://a b'},{...ENV,CRON_SECRET:''},
    {EXECUTION_SMOKE_TIMEOUT_MS:'1000',EXECUTION_SMOKE_TRIGGER:'schedule'}]){
    let called=false;
    assert.deepEqual(await fetchExecutionSmoke(environment,{fetchImpl:async()=>{ called=true; }}),
      {category:'config_missing'});
    assert.equal(called,false);
  }
  for(const timeout of [undefined,'0','abc','110001',100000]){
    await assert.rejects(fetchExecutionSmoke({...ENV,EXECUTION_SMOKE_TIMEOUT_MS:timeout}),TypeError);
  }
  for(const trigger of [undefined,'','dispatch','Deploy',['deploy']]){
    await assert.rejects(fetchExecutionSmoke({...ENV,EXECUTION_SMOKE_TRIGGER:trigger}),TypeError);
  }
  const cases=[
    [async()=>jsonResponse({error:'unauthorized cron'},{status:401}),'unauthorized'],
    [async()=>jsonResponse({},{status:403}),'unauthorized'],
    [async()=>jsonResponse({ok:false,error:'execution smoke unavailable'},{status:503}),'unavailable'],
    [async()=>jsonResponse({},{status:405}),'unavailable'],
    [async()=>{ throw new TypeError('fetch failed'); },'unavailable'],
    [async()=>null,'malformed_response'],
    [async()=>({ok:true,status:200}),'malformed_response'],
    [async()=>jsonResponse('not json'),'malformed_response'],
    [async()=>jsonResponse(fresh(),{headers:{'content-length':String(64*1024+1)}}),'malformed_response'],
    [async()=>jsonResponse(fresh(),{headers:{'content-length':'12x'}}),'malformed_response'],
    [async()=>new Response('x'.repeat(64*1024+1)),'malformed_response'],
  ];
  for(const [fetchImpl,category] of cases){
    assert.deepEqual(await fetchExecutionSmoke(ENV,{fetchImpl}),{category},String(fetchImpl));
  }
});

test('response bodies are read with a hard size cap whichever reader is available',async()=>{
  const textOnly=(text)=>async()=>({ok:true,status:200,headers:new Headers(),text:async()=>text});
  assert.deepEqual(await fetchExecutionSmoke(ENV,{fetchImpl:textOnly(JSON.stringify(fresh()))}),{body:fresh()});
  assert.deepEqual(await fetchExecutionSmoke(ENV,{fetchImpl:textOnly('x'.repeat(64*1024+1))}),
    {category:'malformed_response'});
  assert.deepEqual(await fetchExecutionSmoke(ENV,{fetchImpl:textOnly(42)}),{category:'malformed_response'});

  let cancelled=false;
  const streamed=chunks=>async()=>({ok:true,status:200,headers:{get:()=>null},text:async()=>'',
    body:{getReader:()=>({
      read:async()=>chunks.length?{done:false,value:chunks.shift()}:{done:true},
      cancel:async()=>{ cancelled=true; throw new Error('cancel failed'); },
      releaseLock:()=>{ throw new Error('already released'); },
    })}});
  const encoded=new TextEncoder().encode(JSON.stringify(fresh()));
  assert.deepEqual(await fetchExecutionSmoke(ENV,{fetchImpl:streamed([encoded.slice(0,10),encoded.slice(10)])}),
    {body:fresh()});
  assert.deepEqual(await fetchExecutionSmoke(ENV,{fetchImpl:streamed(['text chunk'])}),{category:'malformed_response'});
  assert.deepEqual(await fetchExecutionSmoke(ENV,{fetchImpl:streamed([new Uint8Array(64*1024),new Uint8Array(1)])}),
    {category:'malformed_response'});
  assert.equal(cancelled,true);
});

test('main prints one bounded JSON line, annotates alerts, and sets the exit code',async()=>{
  const healthy=capture();
  const ok=await main({argv:[],environment:ENV,stdout:healthy.stream,fetchImpl:async()=>jsonResponse(fresh())});
  assert.equal(ok.exitCode,0);
  const line=JSON.parse(healthy.text);
  assert.deepEqual(line,{ok:true,kind:'execution-smoke',format:EXECUTION_SMOKE_FORMAT,status:'healthy',
    alert:false,category:null,checkedAt:'2026-10-20T08:00:00.000Z',ageSeconds:null,
    languages:fresh().languages});
  assert.equal(healthy.text.split('\n').filter(Boolean).length,1);

  const failing=capture();
  const failed=await main({argv:[],environment:ENV,stdout:failing.stream,
    fetchImpl:async()=>jsonResponse(throttled('provider_error',null))});
  assert.equal(failed.exitCode,1);
  assert.equal(failed.result.category,'execution_failed');
  assert.match(failing.text,
    /::error title=Execution smoke failed::Category execution_failed; javascript=throttled\(last provider_error\) python=throttled\(last none\)\./);

  const fresher=capture();
  await main({argv:[],environment:ENV,stdout:fresher.stream,fetchImpl:async()=>jsonResponse(fresh('timeout'))});
  assert.match(fresher.text,/Category execution_failed; javascript=timeout python=ok\./);

  const unauthorized=capture();
  const denied=await main({argv:[],environment:ENV,stdout:unauthorized.stream,
    fetchImpl:async()=>jsonResponse({error:'unauthorized cron',echo:SECRET},{status:401})});
  assert.equal(denied.exitCode,1);
  assert.match(unauthorized.text,/Category unauthorized; no language result\./);

  // A pass on a cached result says so, because it did not test this deployment.
  const cached=capture();
  const cachedRun=await main({argv:[],environment:ENV,stdout:cached.stream,
    fetchImpl:async()=>jsonResponse(throttled())});
  assert.equal(cachedRun.exitCode,0);
  const [cachedLine,notice]=cached.text.trim().split('\n');
  assert.equal(JSON.parse(cachedLine).status,'healthy');
  assert.equal(notice,'::notice title=Execution smoke passed on a cached result::Throttled, so nothing ran. '
    +'The latest real run started 312 seconds ago; this run did not test the current deployment.');
  const inFlight=capture();
  await main({argv:[],environment:ENV,stdout:inFlight.stream,
    fetchImpl:async()=>jsonResponse(throttled(null,null,{ageSeconds:null,checkedAt:null}))});
  assert.match(inFlight.text,/::notice .*The latest real run started at an unknown time;/);

  const missing=capture();
  const lost=await main({argv:[],environment:ENV,stdout:missing.stream,
    fetchImpl:async()=>jsonResponse(throttled('result_missing','result_missing',{checkedAt:null}))});
  assert.equal(lost.exitCode,1);
  assert.match(missing.text,/javascript=throttled\(last result_missing\) python=throttled\(last result_missing\)/);
  assert.doesNotMatch(missing.text,/::notice/);

  for(const [argv,environment] of [[['--force'],ENV],[[],{...ENV,EXECUTION_SMOKE_TIMEOUT_MS:'nope'}],
    [[],{...ENV,EXECUTION_SMOKE_TRIGGER:'dispatch'}]]){
    const broken=capture();
    const result=await main({argv,environment,stdout:broken.stream,fetchImpl:async()=>jsonResponse(fresh())});
    assert.equal(result.exitCode,1);
    assert.equal(result.result.category,'smoke_failure');
  }

  const leaked=capture();
  await main({argv:[],environment:ENV,stdout:leaked.stream,
    fetchImpl:async()=>jsonResponse({...fresh('provider_error'),detail:`${SECRET} https://provider.example`})});
  for(const output of [healthy.text,failing.text,unauthorized.text,leaked.text]){
    assert.doesNotMatch(output,/private-cron-secret|randori\.example\.test|provider\.example/);
  }
});

test('the CLI exits 1 with a bounded alert line when configuration is missing',()=>{
  const child=spawnSync(process.execPath,['scripts/github-execution-smoke.mjs'],{encoding:'utf8',timeout:30000,
    env:{PATH:process.env.PATH,EXECUTION_SMOKE_TIMEOUT_MS:'1000',EXECUTION_SMOKE_TRIGGER:'schedule',
      CRON_SECRET:SECRET}});
  assert.equal(child.status,1,child.stderr);
  const [line,annotation]=child.stdout.trim().split('\n');
  assert.equal(JSON.parse(line).category,'config_missing');
  assert.match(annotation,/^::error title=Execution smoke failed::Category config_missing; no language result\./);
  assert.doesNotMatch(child.stdout,/private-cron-secret/);
});

test('the workflow is least-privilege, never runs for pull requests, and ignores its own deployments',()=>{
  const source=readFileSync('.github/workflows/execution-smoke.yml','utf8');
  const document=parseDocument(source,{prettyErrors:false,uniqueKeys:true});
  assert.equal(document.errors.length,0);
  const workflow=document.toJS();
  assert.deepEqual(Object.keys(workflow.on).sort(),['deployment_status','schedule','workflow_dispatch']);
  assert.deepEqual(workflow.on.schedule,[{cron:'29 7 * * *'}]);
  assert.deepEqual(workflow.permissions,{contents:'read'});
  assert.deepEqual(Object.keys(workflow.jobs),['execution-smoke']);
  const job=workflow.jobs['execution-smoke'];
  assert.equal(job.environment,'production');
  assert.equal(job['runs-on'],'ubuntu-24.04');
  assert.equal(job['timeout-minutes'],5);
  assert.deepEqual(job.concurrency,{group:'execution-smoke','cancel-in-progress':false});
  assert.match(job.if,/github\.event\.deployment_status\.state == 'success'/);
  assert.match(job.if,/github\.event\.deployment\.environment == 'Production'/);
  assert.match(job.if,/github\.event\.deployment\.creator\.login == 'vercel\[bot\]'/);
  assert.match(job.if,/github\.event_name != 'deployment_status' &&\s+github\.ref == format/);
  assert.ok(job.steps.every(step=>Number.isInteger(step['timeout-minutes'])&&step['timeout-minutes']<=2));
  const run=job.steps.at(-1);
  assert.equal(run.run,'node scripts/github-execution-smoke.mjs');
  assert.deepEqual(run.env,{APP_URL:'${{ vars.APP_URL }}',CRON_SECRET:'${{ secrets.CRON_SECRET }}',
    EXECUTION_SMOKE_TIMEOUT_MS:'100000',
    EXECUTION_SMOKE_TRIGGER:"${{ github.event_name == 'deployment_status' && 'deploy' || 'schedule' }}"});
  assert.deepEqual(source.match(/(?:secrets|vars)\.[A-Z_]+/g),['vars.APP_URL','secrets.CRON_SECRET']);
  assert.doesNotMatch(source,/pull_request|write|curl|continue-on-error|TURSO_|RESEND_|VERCEL_/);
  assert.equal(job.steps[0].with['persist-credentials'],false);
});
