import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  assessOutboxDispatchRuns,
  discoverOutboxDispatchStatus,
  main,
  OUTBOX_WATCHDOG_FORMAT,
} from '../../scripts/github-outbox-dispatch-watchdog.mjs';

const NOW=Date.parse('2026-09-20T12:00:00.000Z');
const GRACE=15*60*1000;
const DEADLINE=2*60*1000;

function run(overrides={}){
  return {
    id:123,run_attempt:1,event:'schedule',head_branch:'rolling',status:'completed',
    conclusion:'success',created_at:'2026-09-20T12:00:00Z',
    run_started_at:'2026-09-20T12:00:00Z',updated_at:'2026-09-20T12:00:00Z',
    ...overrides,
  };
}

function options(overrides={}){
  return {defaultBranch:'rolling',scheduleGraceMs:GRACE,workerDeadlineMs:DEADLINE,
    clock:()=>NOW,scan:{pagesScanned:1,runsScanned:1,truncated:false},...overrides};
}

function environment(overrides={}){
  return {
    GITHUB_REPOSITORY:'festus14/randori-circle',WATCHDOG_DEFAULT_BRANCH:'rolling',
    GITHUB_API_URL:'https://api.github.test',GITHUB_TOKEN:'private-watchdog-token',
    WATCHDOG_SCHEDULE_GRACE_MS:String(GRACE),WATCHDOG_WORKER_DEADLINE_MS:String(DEADLINE),
    WATCHDOG_API_TIMEOUT_MS:'10000',WATCHDOG_MAX_PAGES:'2',WATCHDOG_PER_PAGE:'100',
    ...overrides,
  };
}

function response(body,{ok=true,status=200}={}){
  const text=typeof body==='string'?body:JSON.stringify(body);
  return {ok,status,headers:{get(name){ return name==='content-length'?String(Buffer.byteLength(text)):null; }},
    async text(){ return text; }};
}

test('a fresh successful scheduled default-branch run is healthy and manual runs never satisfy freshness',()=>{
  const result=assessOutboxDispatchRuns([
    run({id:999,event:'workflow_dispatch',created_at:'2026-09-20T11:59:00Z',
      updated_at:'2026-09-20T11:59:30Z'}),
    run({id:998,head_branch:'feature',created_at:'2026-09-20T11:58:00Z',
      updated_at:'2026-09-20T11:58:30Z'}),
    run(),
  ],options({scan:{pagesScanned:2,runsScanned:3,truncated:false}}));
  assert.deepEqual(result,{
    ok:true,kind:'outbox-dispatch-watchdog',format:OUTBOX_WATCHDOG_FORMAT,status:'healthy',
    alert:false,category:null,checkedAt:'2026-09-20T12:00:00.000Z',
    sourceWorkflow:'outbox-dispatch.yml',cadenceMs:300000,scheduleGraceMs:GRACE,
    workerDeadlineMs:DEADLINE,currentSlotAt:'2026-09-20T12:00:00.000Z',
    freshnessFloorAt:'2026-09-20T11:45:00.000Z',pagesScanned:2,runsScanned:3,
    truncated:false,matchingRuns:1,
    runId:123,runAttempt:1,runStatus:'completed',runConclusion:'success',
    runCreatedAt:'2026-09-20T12:00:00.000Z',runStartedAt:'2026-09-20T12:00:00.000Z',
    runAgeMs:0,
  });
  assert.equal(assessOutboxDispatchRuns([
    run({event:'workflow_dispatch'}),
  ],options()).category,'run_missing');
  assert.equal(assessOutboxDispatchRuns([
    run({run_attempt:2,updated_at:'2026-09-20T12:00:00Z'}),
  ],options()).category,'manual_rerun');
});

test('the documented grace permits boundary success and active recovery',()=>{
  const grace=assessOutboxDispatchRuns([run({
    created_at:'2026-09-20T11:45:00Z',run_started_at:'2026-09-20T11:45:02Z',
    updated_at:'2026-09-20T11:45:30Z',
  })],options());
  assert.equal(grace.status,'grace');
  assert.equal(grace.category,'schedule_grace');
  assert.equal(assessOutboxDispatchRuns([run({status:'queued',conclusion:null,
    run_started_at:null,created_at:'2026-09-20T11:50:00Z',updated_at:'2026-09-20T11:50:00Z',
  })],options()).status,'observing');
  assert.equal(assessOutboxDispatchRuns([run({status:'in_progress',conclusion:null,
    created_at:'2026-09-20T11:58:00Z',run_started_at:'2026-09-20T11:58:30Z',
    updated_at:'2026-09-20T11:59:00Z',
  })],options()).status,'observing');
});

test('absence, stale success, and malformed scheduled data fail with fixed categories',()=>{
  assert.equal(assessOutboxDispatchRuns([],options()).category,'run_missing');
  assert.equal(assessOutboxDispatchRuns([run({
    created_at:'2026-09-20T11:44:59Z',run_started_at:'2026-09-20T11:45:00Z',
    updated_at:'2026-09-20T12:00:00Z',
  })],options()).category,'run_stale');
  assert.equal(assessOutboxDispatchRuns(null,options()).category,'malformed_response');
  assert.equal(assessOutboxDispatchRuns([run({updated_at:'not-a-date'})],options()).category,
    'malformed_response');
  assert.equal(assessOutboxDispatchRuns([run({status:'completed',conclusion:null})],options()).category,
    'malformed_response');
  assert.equal(assessOutboxDispatchRuns([run({created_at:'2026-09-20T12:00:01Z',
    run_started_at:'2026-09-20T12:00:01Z',updated_at:'2026-09-20T12:00:01Z'})],options()).category,
  'malformed_response');
});

test('the newest scheduled run controls failure, cancellation, and skip outcomes',()=>{
  const older=run({id:122,created_at:'2026-09-20T11:48:00Z',
    run_started_at:'2026-09-20T11:48:05Z',updated_at:'2026-09-20T11:48:30Z'});
  for(const [conclusion,category] of [
    ['failure','run_failed'],['timed_out','run_failed'],['cancelled','run_cancelled'],
    ['skipped','run_skipped'],
  ]){
    const latest=run({id:124,conclusion,created_at:'2026-09-20T11:59:00Z',
      run_started_at:'2026-09-20T11:59:01Z',updated_at:'2026-09-20T11:59:30Z'});
    const result=assessOutboxDispatchRuns([older,latest],options());
    assert.equal(result.category,category);
    assert.equal(result.runId,124);
  }
});

test('a rerun of the newest schedule alerts instead of exposing an older success',()=>{
  const older=run({id:122,created_at:'2026-09-20T11:55:00Z',
    run_started_at:'2026-09-20T11:55:01Z',updated_at:'2026-09-20T11:55:30Z'});
  const rerun=run({id:124,run_attempt:2,created_at:'2026-09-20T12:00:00Z',
    run_started_at:'2026-09-20T12:00:00Z',updated_at:'2026-09-20T12:00:00Z'});
  const result=assessOutboxDispatchRuns([older,rerun],options());
  assert.equal(result.category,'manual_rerun');
  assert.equal(result.runId,124);
  assert.equal(result.alert,true);
});

test('in-progress execution becomes stuck only after the dispatcher two-minute deadline',()=>{
  const boundary=run({status:'in_progress',conclusion:null,created_at:'2026-09-20T11:57:00Z',
    run_started_at:'2026-09-20T11:58:00.001Z',updated_at:'2026-09-20T11:59:59Z'});
  assert.equal(assessOutboxDispatchRuns([boundary],options()).status,'observing');
  const stuck=run({...boundary,run_started_at:'2026-09-20T11:58:00Z'});
  const result=assessOutboxDispatchRuns([stuck],options());
  assert.equal(result.category,'run_stuck');
  assert.equal(result.workerDeadlineMs,120000);

  const staleButRecentlyStarted=run({status:'in_progress',conclusion:null,
    created_at:'2026-09-20T10:00:00Z',run_started_at:'2026-09-20T11:59:30Z',
    updated_at:'2026-09-20T11:59:45Z'});
  assert.equal(assessOutboxDispatchRuns([staleButRecentlyStarted],options()).category,'run_stale');
});

test('discovery filters in the API and paginates within hard bounds',async()=>{
  const requests=[];
  const fetchImpl=async(url,request)=>{
    requests.push({url,authorization:request.headers.authorization,signal:request.signal});
    const page=new URL(url).searchParams.get('page');
    return page==='1'
      ?response({total_count:3,workflow_runs:[run({id:900,event:'workflow_dispatch'}),
        run({id:901,head_branch:'feature'})]})
      :response({total_count:3,workflow_runs:[run()]});
  };
  const result=await discoverOutboxDispatchStatus(environment({WATCHDOG_PER_PAGE:'2'}),{
    fetchImpl,clock:()=>NOW,
  });
  assert.equal(result.status,'healthy');
  assert.equal(result.pagesScanned,2);
  assert.equal(result.runsScanned,3);
  assert.equal(result.matchingRuns,1);
  assert.equal(result.truncated,false);
  assert.match(requests[0].url,
    /actions\/workflows\/outbox-dispatch\.yml\/runs\?branch=rolling&event=schedule&per_page=2&page=1$/);
  assert.match(requests[1].url,/&page=2$/);
  assert.deepEqual(requests.map(item=>item.authorization),[
    'Bearer private-watchdog-token','Bearer private-watchdog-token',
  ]);
  assert.ok(requests.every(item=>item.signal instanceof AbortSignal));
  assert.doesNotMatch(JSON.stringify(result),/private-watchdog-token|https?:\/\//);
});

test('discovery stops at the configured page cap and reports bounded scan metadata',async()=>{
  let calls=0;
  const fetchImpl=async()=>{
    calls+=1;
    return response({total_count:999,workflow_runs:[run({id:200-calls}),run({id:100-calls})]});
  };
  const result=await discoverOutboxDispatchStatus(environment({
    WATCHDOG_MAX_PAGES:'2',WATCHDOG_PER_PAGE:'2',
  }),{fetchImpl,clock:()=>NOW});
  assert.equal(calls,2);
  assert.equal(result.pagesScanned,2);
  assert.equal(result.runsScanned,4);
  assert.equal(result.truncated,true);
  assert.equal(result.status,'healthy');
});

test('malformed GitHub responses are distinct from API failures and disclose no provider data',async()=>{
  const malformedJson=await discoverOutboxDispatchStatus(environment(),{
    fetchImpl:async()=>response('{not json'),clock:()=>NOW,
  });
  assert.equal(malformedJson.category,'malformed_response');

  const malformedShape=await discoverOutboxDispatchStatus(environment(),{
    fetchImpl:async()=>response({total_count:1,workflow_runs:{id:123}}),clock:()=>NOW,
  });
  assert.equal(malformedShape.category,'malformed_response');

  const invalidResponse=await discoverOutboxDispatchStatus(environment(),{
    fetchImpl:async()=>({ok:true}),clock:()=>NOW,
  });
  assert.equal(invalidResponse.category,'malformed_response');

  const inconsistentPage=await discoverOutboxDispatchStatus(environment(),{
    fetchImpl:async()=>response({total_count:0,workflow_runs:[run()]}),clock:()=>NOW,
  });
  assert.equal(inconsistentPage.category,'malformed_response');

  const oversized=await discoverOutboxDispatchStatus(environment(),{
    fetchImpl:async()=>({ok:true,headers:{get:()=>String(3*1024*1024)},
      async text(){ throw new Error('oversized body must not be read'); }}),clock:()=>NOW,
  });
  assert.equal(oversized.category,'malformed_response');

  let cancelled=false;
  const streamedOversize=await discoverOutboxDispatchStatus(environment(),{
    fetchImpl:async()=>({ok:true,headers:{get:()=>null},async text(){ return ''; },body:{
      getReader:()=>({async read(){ return {done:false,value:new Uint8Array(2*1024*1024+1)}; },
        async cancel(){ cancelled=true; },releaseLock(){}}),
    }}),clock:()=>NOW,
  });
  assert.equal(streamedOversize.category,'malformed_response');
  assert.equal(cancelled,true);

  const failed=await discoverOutboxDispatchStatus(environment(),{
    fetchImpl:async()=>{ throw new Error('private-watchdog-token person@example.test'); },
    clock:()=>NOW,
  });
  assert.equal(failed.category,'api_failure');
  assert.doesNotMatch(JSON.stringify(failed),/private-watchdog-token|person@example\.test/);

  for(const status of [401,403,429,500,503]){
    const httpFailure=await discoverOutboxDispatchStatus(environment(),{
      fetchImpl:async()=>response('private provider body',{ok:false,status}),clock:()=>NOW,
    });
    assert.equal(httpFailure.category,'api_failure');
    assert.doesNotMatch(JSON.stringify(httpFailure),/private provider body/);
  }
});

test('GitHub API requests abort at the configured deadline',async()=>{
  let observedAbort=false;
  const fetchImpl=async(_url,{signal})=>new Promise((resolve,reject)=>{
    signal.addEventListener('abort',()=>{
      observedAbort=true;
      reject(new Error('private timeout detail'));
    },{once:true});
  });
  const result=await discoverOutboxDispatchStatus(environment({WATCHDOG_API_TIMEOUT_MS:'5'}),{
    fetchImpl,clock:()=>NOW,
  });
  assert.equal(observedAbort,true);
  assert.equal(result.category,'api_failure');
  assert.equal(result.pagesScanned,0);
});

test('pagination shares one absolute API budget rather than resetting per page',async()=>{
  const ticks=[0,0,6000,6000,10000];
  const delays=[];
  let calls=0;
  const result=await discoverOutboxDispatchStatus(environment({
    WATCHDOG_API_TIMEOUT_MS:'10000',WATCHDOG_MAX_PAGES:'2',WATCHDOG_PER_PAGE:'1',
  }),{
    fetchImpl:async()=>{
      calls+=1;
      return response({total_count:3,workflow_runs:[run({id:100+calls})]});
    },
    clock:()=>NOW,
    monotonicClock:()=>ticks.shift()??10000,
    setTimer:(_callback,delay)=>{ delays.push(delay); return delay; },
    clearTimer:()=>{},
  });
  assert.equal(calls,2);
  assert.deepEqual(delays,[10000,4000]);
  assert.equal(result.category,'api_failure');
  assert.equal(result.pagesScanned,1);
});

test('a backward wall-clock adjustment cannot extend the monotonic API budget',async()=>{
  const wallTicks=[NOW,NOW-60*60*1000];
  const monotonicTicks=[100,100,6100,6100,10100];
  const delays=[];
  let calls=0;
  const result=await discoverOutboxDispatchStatus(environment({
    WATCHDOG_API_TIMEOUT_MS:'10000',WATCHDOG_MAX_PAGES:'2',WATCHDOG_PER_PAGE:'1',
  }),{
    fetchImpl:async()=>{
      calls+=1;
      return response({total_count:3,workflow_runs:[run({id:200+calls})]});
    },
    clock:()=>wallTicks.shift()??NOW-60*60*1000,
    monotonicClock:()=>monotonicTicks.shift()??10100,
    setTimer:(_callback,delay)=>{ delays.push(delay); return delay; },
    clearTimer:()=>{},
  });
  assert.equal(calls,2);
  assert.deepEqual(delays,[10000,4000]);
  assert.equal(result.category,'api_failure');
  assert.equal(result.pagesScanned,1);
});

test('the CLI path preserves its monotonic budget across a backward wall-clock adjustment',async()=>{
  const wallTicks=[NOW,NOW-60*60*1000];
  const monotonicTicks=[100,100,6100,6100,10100];
  const delays=[];
  let calls=0;
  let output='';
  const execution=await main({argv:[],environment:environment({
    WATCHDOG_API_TIMEOUT_MS:'10000',WATCHDOG_MAX_PAGES:'2',WATCHDOG_PER_PAGE:'1',
  }),
  fetchImpl:async()=>{
    calls+=1;
    return response({total_count:3,workflow_runs:[run({id:300+calls})]});
  },
  clock:()=>wallTicks.shift()??NOW-60*60*1000,
  monotonicClock:()=>monotonicTicks.shift()??10100,
  setTimer:(_callback,delay)=>{ delays.push(delay); return delay; },
  clearTimer:()=>{},stdout:{write(value){ output+=value; }}});
  assert.equal(calls,2);
  assert.deepEqual(delays,[10000,4000]);
  assert.equal(execution.exitCode,1);
  assert.equal(execution.result.category,'api_failure');
  assert.deepEqual(JSON.parse(output),execution.result);
});

test('CLI emits one bounded document and fails only alert outcomes',async()=>{
  let healthyOutput='';
  const healthy=await main({argv:[],environment:environment(),clock:()=>NOW,
    fetchImpl:async()=>response({total_count:1,workflow_runs:[run()]}),
    stdout:{write(value){ healthyOutput+=value; }}});
  assert.equal(healthy.exitCode,0);
  assert.deepEqual(JSON.parse(healthyOutput),healthy.result);

  let failedOutput='';
  const failed=await main({argv:[],environment:environment(),clock:()=>NOW,
    fetchImpl:async()=>response({}, {ok:false,status:503}),
    stdout:{write(value){ failedOutput+=value; }}});
  assert.equal(failed.exitCode,1);
  assert.equal(JSON.parse(failedOutput).category,'api_failure');
  assert.equal(failedOutput.trim().split('\n').length,1);
});

test('watchdog workflow is hourly, default-branch-only, read-only, and production-secret-free',async()=>{
  const {readFile}=await import('node:fs/promises');
  const workflow=await readFile('.github/workflows/outbox-dispatch-watchdog.yml','utf8');
  assert.match(workflow,/cron: '37 \* \* \* \*'/);
  assert.match(workflow,/workflow_dispatch:/);
  assert.match(workflow,/actions: read/);
  assert.match(workflow,/contents: read/);
  assert.match(workflow,/WATCHDOG_SCHEDULE_GRACE_MS: '900000'/);
  assert.match(workflow,/WATCHDOG_WORKER_DEADLINE_MS: '120000'/);
  assert.match(workflow,/WATCHDOG_MAX_PAGES: '2'/);
  assert.match(workflow,/node scripts\/github-outbox-dispatch-watchdog\.mjs/);
  assert.doesNotMatch(workflow,
    /environment:|secrets\.|vars\.|APP_URL|CRON_SECRET|TURSO_|RESEND_|\/api\/cron\/outbox|pull_request/);
});
