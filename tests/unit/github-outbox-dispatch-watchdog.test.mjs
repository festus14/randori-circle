import assert from 'node:assert/strict';
import { test } from 'node:test';
import { performance } from 'node:perf_hooks';

import {
  assessOutboxDeliveryHealth,
  assessOutboxDispatchRuns,
  discoverOutboxDispatchStatus,
  fetchOutboxDeliveryHealth,
  main,
  OUTBOX_SCHEDULE_FORMAT,
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
    APP_URL:'https://randori.example.test',CRON_SECRET:'private-cron-secret',
    WATCHDOG_DELIVERY_MAX_AGE_MS:String(GRACE),
    ...overrides,
  };
}

function health(overrides={}){
  return {ok:true,checkedAt:'2026-09-20T12:00:00.000Z',oldestDueAgeMs:null,dueCount:0,
    processingStaleCount:0,oldestStaleLeaseAgeMs:null,deadLetterCount:0,deadLetterWindowMs:86400000,
    lastDeliveredAt:'2026-09-20T11:58:00.000Z',...overrides};
}

const isHealthUrl=url=>String(url).endsWith('/api/cron/outbox-health');

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
    ok:true,kind:'outbox-dispatch-schedule',format:OUTBOX_SCHEDULE_FORMAT,status:'healthy',
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

test('the CLI default preserves its monotonic budget across a backward wall-clock adjustment',async()=>{
  const monotonicTicks=[100,100,6100,6100,10100];
  const wallTicks=[100000,100000,100001,0,1];
  const delays=[];
  let calls=0;
  let output='';
  const originalDateNow=Date.now;
  Object.defineProperty(performance,'now',{configurable:true,
    value:()=>monotonicTicks.shift()??10100});
  Date.now=()=>wallTicks.shift()??1;
  let execution;
  try{
    execution=await main({argv:[],environment:environment({
      WATCHDOG_API_TIMEOUT_MS:'10000',WATCHDOG_MAX_PAGES:'2',WATCHDOG_PER_PAGE:'1',
    }),
    fetchImpl:async url=>{
      if(isHealthUrl(url)) return response(health());
      calls+=1;
      return response({total_count:3,workflow_runs:[run({id:300+calls})]});
    },
    clock:()=>NOW,
    setTimer:(_callback,delay)=>{ delays.push(delay); return delay; },
    clearTimer:()=>{},stdout:{write(value){ output+=value; }}});
  }finally{
    Date.now=originalDateNow;
    delete performance.now;
  }
  assert.equal(calls,2);
  // The first timer bounds the health request; the next two share GitHub's budget.
  assert.deepEqual(delays,[10000,10000,4000]);
  assert.equal(execution.result.githubSchedule.category,'api_failure');
  assert.deepEqual(execution.result.warnings,['github_api_failure']);
  assert.equal(execution.exitCode,0,'a GitHub API failure is only a warning');
  assert.deepEqual(JSON.parse(output),execution.result);
});

test('fresh delivery health is healthy even when GitHub runs are hours late',async()=>{
  let output='';
  const requests=[];
  const execution=await main({argv:[],environment:environment(),clock:()=>NOW,
    fetchImpl:async(url,request)=>{
      requests.push({url:String(url),request});
      return isHealthUrl(url)
        ?response(health({dueCount:2,oldestDueAgeMs:60_000,deadLetterCount:1}))
        :response({total_count:1,workflow_runs:[run({created_at:'2026-09-20T09:00:00Z',
          run_started_at:'2026-09-20T09:00:01Z',updated_at:'2026-09-20T09:00:30Z'})]});
    },
    stdout:{write(value){ output+=value; }}});
  assert.equal(execution.exitCode,0);
  assert.deepEqual(JSON.parse(output),execution.result);
  const result=execution.result;
  assert.equal(result.ok,true);
  assert.equal(result.format,OUTBOX_WATCHDOG_FORMAT);
  assert.equal(result.status,'warning');
  assert.equal(result.category,null);
  assert.equal(result.deliveryMaxAgeMs,GRACE);
  assert.deepEqual(result.warnings,['dead_letters_recent','delivery_backlog','github_run_stale']);
  assert.deepEqual(result.delivery,{oldestDueAgeMs:60000,dueCount:2,processingStaleCount:0,
    oldestStaleLeaseAgeMs:null,deadLetterCount:1,deadLetterWindowMs:86400000,
    lastDeliveredAt:'2026-09-20T11:58:00.000Z',healthCheckedAt:'2026-09-20T12:00:00.000Z'});
  assert.equal(result.githubSchedule.category,'run_stale');
  assert.equal(result.githubSchedule.alert,true);
  const healthRequest=requests.find(item=>isHealthUrl(item.url));
  assert.equal(healthRequest.url,'https://randori.example.test/api/cron/outbox-health');
  assert.equal(healthRequest.request.method,'GET');
  assert.equal(healthRequest.request.headers.authorization,'Bearer private-cron-secret');
  assert.ok(healthRequest.request.signal instanceof AbortSignal);
  assert.doesNotMatch(output,/private-cron-secret|private-watchdog-token|https?:\/\//);
});

test('CLI emits one bounded document and fails only on delivery alerts',async()=>{
  let healthyOutput='';
  const healthy=await main({argv:[],environment:environment(),clock:()=>NOW,
    fetchImpl:async url=>isHealthUrl(url)?response(health()):response({total_count:1,workflow_runs:[run()]}),
    stdout:{write(value){ healthyOutput+=value; }}});
  assert.equal(healthy.exitCode,0);
  assert.equal(healthy.result.status,'healthy');
  assert.deepEqual(healthy.result.warnings,[]);
  assert.deepEqual(JSON.parse(healthyOutput),healthy.result);

  let failedOutput='';
  const failed=await main({argv:[],environment:environment(),clock:()=>NOW,
    fetchImpl:async url=>isHealthUrl(url)
      ?response({ok:false,error:'outbox health unavailable'},{ok:false,status:503})
      :response({total_count:1,workflow_runs:[run()]}),
    stdout:{write(value){ failedOutput+=value; }}});
  assert.equal(failed.exitCode,1);
  assert.equal(JSON.parse(failedOutput).category,'health_unavailable');
  assert.equal(failed.result.githubSchedule.status,'healthy');
  assert.equal(failedOutput.trim().split('\n').length,1);

  for(const [body,category] of [
    [health({dueCount:1,oldestDueAgeMs:GRACE+1}),'delivery_stale'],
    [health({processingStaleCount:1,oldestStaleLeaseAgeMs:GRACE+1}),'lease_stale'],
  ]){
    const stale=await main({argv:[],environment:environment(),clock:()=>NOW,
      fetchImpl:async url=>isHealthUrl(url)?response(body):response({total_count:1,workflow_runs:[run()]}),
      stdout:{write(){}}});
    assert.equal(stale.exitCode,1);
    assert.equal(stale.result.category,category);
    assert.equal(stale.result.status,'alert');
    assert.ok(stale.result.delivery);
  }

  const usage=await main({argv:['--force'],environment:environment(),clock:()=>NOW,
    fetchImpl:async()=>{ throw new Error('must not fetch'); },stdout:{write(){}}});
  assert.equal(usage.exitCode,1);
  assert.equal(usage.result.category,'watchdog_failure');
  assert.equal(usage.result.githubSchedule,null);

  const badThreshold=await main({argv:[],environment:environment({WATCHDOG_DELIVERY_MAX_AGE_MS:'0'}),
    clock:()=>'bad',fetchImpl:async()=>response(health()),stdout:{write(){}}});
  assert.equal(badThreshold.exitCode,1);
  assert.equal(badThreshold.result.checkedAt,'1970-01-01T00:00:00.000Z');
});

test('the GitHub schedule signal degrades to a warning when its own configuration is invalid',async()=>{
  const execution=await main({argv:[],environment:environment({WATCHDOG_MAX_PAGES:'99'}),clock:()=>NOW,
    fetchImpl:async url=>isHealthUrl(url)?response(health()):response({total_count:0,workflow_runs:[]}),
    stdout:{write(){}}});
  assert.equal(execution.exitCode,0);
  assert.deepEqual(execution.result.warnings,['github_api_failure']);
});

test('delivery health fetch maps configuration, auth, transport, and shape failures to fixed categories',async()=>{
  const ok=async()=>response(health());
  for(const overrides of [{APP_URL:''},{APP_URL:'http://randori.example.test'},
    {APP_URL:'https://randori.example.test/path'},{CRON_SECRET:''}]){
    assert.deepEqual(await fetchOutboxDeliveryHealth(environment(overrides),{fetchImpl:ok}),
      {category:'health_config_missing'});
  }
  for(const status of [401,403]){
    assert.deepEqual(await fetchOutboxDeliveryHealth(environment(),{
      fetchImpl:async()=>response('denied',{ok:false,status})}),{category:'health_unauthorized'});
  }
  assert.deepEqual(await fetchOutboxDeliveryHealth(environment(),{
    fetchImpl:async()=>response('missing',{ok:false,status:404})}),{category:'health_unavailable'});
  assert.deepEqual(await fetchOutboxDeliveryHealth(environment(),{
    fetchImpl:async()=>{ throw new Error('private-cron-secret'); }}),{category:'health_unavailable'});
  assert.deepEqual(await fetchOutboxDeliveryHealth(environment(),{
    fetchImpl:async()=>({ok:true})}),{category:'malformed_health'});
  assert.deepEqual(await fetchOutboxDeliveryHealth(environment(),{
    fetchImpl:async()=>response('{nope')}),{category:'malformed_health'});
  const fetched=await fetchOutboxDeliveryHealth(environment({APP_URL:'https://randori.example.test/'}),{
    fetchImpl:async url=>{
      assert.equal(url,'https://randori.example.test/api/cron/outbox-health');
      return response(health());
    }});
  assert.deepEqual(fetched,{health:health()});

  let aborted=false;
  const timedOut=await fetchOutboxDeliveryHealth(environment({WATCHDOG_API_TIMEOUT_MS:'5'}),{
    fetchImpl:async(_url,{signal})=>new Promise((_resolve,reject)=>{
      signal.addEventListener('abort',()=>{ aborted=true; reject(new Error('timeout')); },{once:true});
    })});
  assert.equal(aborted,true);
  assert.deepEqual(timedOut,{category:'health_unavailable'});
});

test('delivery health assessment rejects inconsistent documents and applies the age threshold',()=>{
  const options={deliveryMaxAgeMs:GRACE};
  assert.equal(assessOutboxDeliveryHealth(health(),options).ok,true);
  assert.equal(assessOutboxDeliveryHealth(health({oldestDueAgeMs:GRACE,dueCount:3}),options).ok,true);
  assert.equal(assessOutboxDeliveryHealth(health({processingStaleCount:1,oldestStaleLeaseAgeMs:GRACE}),options)
    .warnings.includes('delivery_backlog'),true);
  for(const bad of [null,[],health({ok:false}),health({checkedAt:'yesterday'}),health({dueCount:-1}),
    health({dueCount:1}),health({oldestDueAgeMs:5}),health({processingStaleCount:2}),
    health({oldestStaleLeaseAgeMs:1.5,processingStaleCount:1}),health({deadLetterCount:'1'}),
    health({deadLetterWindowMs:null}),health({lastDeliveredAt:'never'})]){
    assert.equal(assessOutboxDeliveryHealth(bad,options).category,'malformed_health',JSON.stringify(bad));
  }
  assert.equal(assessOutboxDeliveryHealth(health({lastDeliveredAt:null}),options).ok,true);
  assert.throws(()=>assessOutboxDeliveryHealth(health(),{deliveryMaxAgeMs:0}),TypeError);
});

test('watchdog workflow is hourly, default-branch-only, read-only, and holds only the health credential',async()=>{
  const {readFile}=await import('node:fs/promises');
  const workflow=await readFile('.github/workflows/outbox-dispatch-watchdog.yml','utf8');
  assert.match(workflow,/cron: '37 \* \* \* \*'/);
  assert.match(workflow,/workflow_dispatch:/);
  assert.match(workflow,/actions: read/);
  assert.match(workflow,/contents: read/);
  assert.match(workflow,/environment: production/);
  assert.match(workflow,/APP_URL: \$\{\{ vars\.APP_URL \}\}/);
  assert.match(workflow,/CRON_SECRET: \$\{\{ secrets\.CRON_SECRET \}\}/);
  assert.match(workflow,/WATCHDOG_DELIVERY_MAX_AGE_MS: '900000'/);
  assert.match(workflow,/WATCHDOG_SCHEDULE_GRACE_MS: '900000'/);
  assert.match(workflow,/WATCHDOG_WORKER_DEADLINE_MS: '120000'/);
  assert.match(workflow,/WATCHDOG_MAX_PAGES: '2'/);
  assert.match(workflow,/node scripts\/github-outbox-dispatch-watchdog\.mjs/);
  assert.equal(workflow.match(/secrets\./g).length,1);
  assert.equal(workflow.match(/vars\./g).length,1);
  assert.doesNotMatch(workflow,/TURSO_|RESEND_|OUTBOX_DISPATCH_SECRET|\/api\/cron\/outbox|pull_request|\bcurl\b/);
});
