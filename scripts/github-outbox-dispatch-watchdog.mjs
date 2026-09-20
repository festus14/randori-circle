#!/usr/bin/env node
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

export const OUTBOX_WATCHDOG_FORMAT='randori.outbox-dispatch-watchdog.v1';

const SOURCE_WORKFLOW='outbox-dispatch.yml';
const CADENCE_MS=5*60*1000;
const MAX_PUBLIC_AGE_MS=30*24*60*60*1000;
const MAX_RESPONSE_BYTES=2*1024*1024;
const ACTIVE_STATUSES=new Set(['queued','pending','requested','waiting','in_progress']);
const KNOWN_STATUSES=new Set([...ACTIVE_STATUSES,'completed']);
const KNOWN_CONCLUSIONS=new Set([
  'success','failure','cancelled','skipped','timed_out','action_required','startup_failure','neutral','stale',
]);
const ALERT_CATEGORIES=new Set([
  'run_missing','run_stale','run_failed','run_cancelled','run_skipped','run_stuck',
  'malformed_response','api_failure',
]);

class MalformedResponseError extends Error{}

function freeze(value){
  if(Array.isArray(value)) return Object.freeze(value.map(freeze));
  if(value&&typeof value==='object'){
    return Object.freeze(Object.fromEntries(Object.entries(value).map(([key,item])=>[key,freeze(item)])));
  }
  return value;
}

function record(value){
  return value&&typeof value==='object'&&!Array.isArray(value)?value:null;
}

function positiveInteger(value,label,{maximum=Number.MAX_SAFE_INTEGER}={}){
  const parsed=typeof value==='string'&&/^[1-9][0-9]*$/.test(value)?Number(value):value;
  if(!Number.isSafeInteger(parsed)||parsed<1||parsed>maximum) throw new TypeError(`${label} is invalid`);
  return parsed;
}

function canonicalNow(clock){
  const value=typeof clock==='function'?clock():Date.now();
  const milliseconds=value instanceof Date?value.getTime():Number(value);
  if(!Number.isSafeInteger(milliseconds)||milliseconds<0) throw new TypeError('watchdog clock is invalid');
  return {milliseconds,timestamp:new Date(milliseconds).toISOString()};
}

function timestamp(value){
  if(typeof value!=='string'
    ||!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(value)) return null;
  const milliseconds=Date.parse(value);
  return Number.isFinite(milliseconds)
    ?{milliseconds,value:new Date(milliseconds).toISOString()}:null;
}

function scanMetadata(scan={}){
  const pagesScanned=Number(scan.pagesScanned);
  const runsScanned=Number(scan.runsScanned);
  return {
    pagesScanned:Number.isSafeInteger(pagesScanned)&&pagesScanned>=0?pagesScanned:0,
    runsScanned:Number.isSafeInteger(runsScanned)&&runsScanned>=0?runsScanned:0,
    truncated:scan.truncated===true,
  };
}

function scheduleWindow(nowMilliseconds,scheduleGraceMs){
  const currentSlot=Math.floor(nowMilliseconds/CADENCE_MS)*CADENCE_MS;
  const freshnessFloor=Math.floor((nowMilliseconds-scheduleGraceMs)/CADENCE_MS)*CADENCE_MS;
  return {currentSlot,currentSlotAt:new Date(currentSlot).toISOString(),
    freshnessFloor,freshnessFloorAt:new Date(freshnessFloor).toISOString()};
}

function baseResult({ok,status,category,checkedAt,scheduleGraceMs,workerDeadlineMs,scan,matchingRuns,
  currentSlotAt,freshnessFloorAt}){
  return {
    ok,kind:'outbox-dispatch-watchdog',format:OUTBOX_WATCHDOG_FORMAT,status,
    alert:!ok,category,checkedAt,sourceWorkflow:SOURCE_WORKFLOW,
    cadenceMs:CADENCE_MS,scheduleGraceMs,workerDeadlineMs,currentSlotAt,freshnessFloorAt,
    ...scanMetadata(scan),matchingRuns,
  };
}

function publicAge(now,then){
  return Math.min(MAX_PUBLIC_AGE_MS,Math.max(0,now-then));
}

function publicRun(run,now){
  return {
    runId:run.runId,runAttempt:run.runAttempt,runStatus:run.status,
    ...(run.conclusion?{runConclusion:run.conclusion}:{}),
    runCreatedAt:run.createdAt,
    ...(run.startedAt?{runStartedAt:run.startedAt}:{}),
    runAgeMs:publicAge(now,run.createdMilliseconds),
  };
}

function alertResult(category,context){
  return freeze({...baseResult({...context,ok:false,status:'alert',
    category:ALERT_CATEGORIES.has(category)?category:'api_failure'}),
    ...(context.run?publicRun(context.run,context.nowMilliseconds):{}),
  });
}

function inspectRun(value,defaultBranch,nowMilliseconds){
  const run=record(value);
  if(!run) return {kind:'malformed'};
  if(run.event!==undefined&&run.event!=='schedule') return {kind:'ignored'};
  if(run.head_branch!==undefined&&run.head_branch!==defaultBranch) return {kind:'ignored'};
  if(run.event!=='schedule'||run.head_branch!==defaultBranch) return {kind:'malformed'};
  const runId=Number(run.id);
  const runAttempt=Number(run.run_attempt);
  const created=timestamp(run.created_at);
  const updated=timestamp(run.updated_at);
  const started=run.run_started_at===null||run.run_started_at===undefined
    ?null:timestamp(run.run_started_at);
  if(!Number.isSafeInteger(runId)||runId<1||!Number.isSafeInteger(runAttempt)||runAttempt<1){
    return {kind:'malformed'};
  }
  // A human-triggered rerun retains event=schedule. It can aid recovery but
  // cannot replace evidence from the next genuine scheduled attempt.
  if(runAttempt!==1) return {kind:'ignored'};
  if(!created||!updated||created.milliseconds>nowMilliseconds||updated.milliseconds<created.milliseconds
    ||updated.milliseconds>nowMilliseconds||!KNOWN_STATUSES.has(run.status)
    ||(run.conclusion!==null&&!KNOWN_CONCLUSIONS.has(run.conclusion))
    ||(run.status==='completed'&&run.conclusion===null)
    ||(run.status!=='completed'&&run.conclusion!==null)
    ||(run.status==='in_progress'&&!started)
    ||(started&&(started.milliseconds<created.milliseconds||started.milliseconds>nowMilliseconds
      ||updated.milliseconds<started.milliseconds))){
    return {kind:'malformed'};
  }
  return {kind:'valid',run:{runId,runAttempt,status:run.status,conclusion:run.conclusion,
    createdAt:created.value,createdMilliseconds:created.milliseconds,
    updatedAt:updated.value,updatedMilliseconds:updated.milliseconds,
    startedAt:started?.value||null,startedMilliseconds:started?.milliseconds||null}};
}

export function assessOutboxDispatchRuns(runs,{defaultBranch,scheduleGraceMs,workerDeadlineMs,
  clock=Date.now,scan={}}={}){
  const now=canonicalNow(clock);
  const grace=positiveInteger(scheduleGraceMs,'schedule grace',{maximum:60*60*1000});
  const deadline=positiveInteger(workerDeadlineMs,'worker deadline',{maximum:10*60*1000});
  const window=scheduleWindow(now.milliseconds,grace);
  const metadata={checkedAt:now.timestamp,nowMilliseconds:now.milliseconds,
    scheduleGraceMs:grace,workerDeadlineMs:deadline,scan,matchingRuns:0,...window};
  if(typeof defaultBranch!=='string'||!/^[A-Za-z0-9._/-]{1,255}$/.test(defaultBranch)){
    return alertResult('api_failure',metadata);
  }
  if(!Array.isArray(runs)) return alertResult('malformed_response',metadata);
  const inspected=runs.map(value=>inspectRun(value,defaultBranch,now.milliseconds));
  const valid=inspected.filter(item=>item.kind==='valid').map(item=>item.run)
    .sort((left,right)=>right.createdMilliseconds-left.createdMilliseconds||right.runId-left.runId);
  metadata.matchingRuns=valid.length;
  if(inspected.some(item=>item.kind==='malformed')) return alertResult('malformed_response',metadata);
  if(valid.length===0) return alertResult('run_missing',metadata);
  const latest=valid[0];
  metadata.run=latest;
  if(latest.status==='in_progress'){
    if(now.milliseconds-latest.startedMilliseconds>=deadline) return alertResult('run_stuck',metadata);
    return freeze({...baseResult({...metadata,ok:true,status:'observing',
      category:latest.createdMilliseconds<window.currentSlot?'schedule_grace':null}),
      ...publicRun(latest,now.milliseconds)});
  }
  if(ACTIVE_STATUSES.has(latest.status)){
    if(latest.createdMilliseconds<window.freshnessFloor) return alertResult('run_stale',metadata);
    return freeze({...baseResult({...metadata,ok:true,status:'observing',
      category:latest.createdMilliseconds<window.currentSlot?'schedule_grace':null}),
      ...publicRun(latest,now.milliseconds)});
  }
  if(latest.conclusion==='cancelled') return alertResult('run_cancelled',metadata);
  if(latest.conclusion==='skipped') return alertResult('run_skipped',metadata);
  if(latest.conclusion!=='success') return alertResult('run_failed',metadata);
  if(latest.createdMilliseconds<window.freshnessFloor) return alertResult('run_stale',metadata);
  if(latest.createdMilliseconds<window.currentSlot){
    return freeze({...baseResult({...metadata,ok:true,status:'grace',category:'schedule_grace'}),
      ...publicRun(latest,now.milliseconds)});
  }
  return freeze({...baseResult({...metadata,ok:true,status:'healthy',category:null}),
    ...publicRun(latest,now.milliseconds)});
}

function parseJsonBody(body){
  if(typeof body!=='string'||Buffer.byteLength(body,'utf8')>MAX_RESPONSE_BYTES){
    throw new MalformedResponseError('GitHub response is malformed');
  }
  try{ return JSON.parse(body); }catch{ throw new MalformedResponseError('GitHub response is malformed'); }
}

async function readBoundedBody(response){
  const rawLength=response.headers?.get?.('content-length');
  if(rawLength!==null&&rawLength!==undefined){
    if(!/^[0-9]+$/.test(rawLength)||Number(rawLength)>MAX_RESPONSE_BYTES){
      throw new MalformedResponseError('GitHub response is malformed');
    }
  }
  const reader=response.body?.getReader?.();
  if(!reader) return response.text();
  const chunks=[];
  let total=0;
  try{
    while(true){
      const {done,value}=await reader.read();
      if(done) break;
      if(!(value instanceof Uint8Array)) throw new MalformedResponseError('GitHub response is malformed');
      total+=value.byteLength;
      if(total>MAX_RESPONSE_BYTES){
        try{ await reader.cancel(); }catch{}
        throw new MalformedResponseError('GitHub response is malformed');
      }
      chunks.push(value);
    }
  }finally{
    try{ reader.releaseLock(); }catch{}
  }
  return Buffer.concat(chunks.map(value=>Buffer.from(value)),total).toString('utf8');
}

async function fetchJson(fetchImpl,url,token,timeoutMs,{setTimer=setTimeout,clearTimer=clearTimeout}={}){
  const controller=new AbortController();
  const timer=setTimer(()=>controller.abort(),timeoutMs);
  try{
    const response=await fetchImpl(url,{signal:controller.signal,headers:{
      accept:'application/vnd.github+json',authorization:`Bearer ${token}`,
      'x-github-api-version':'2022-11-28',
    }});
    if(!response||typeof response.ok!=='boolean'||typeof response.text!=='function'){
      throw new MalformedResponseError('GitHub response is malformed');
    }
    if(!response?.ok) throw new Error('GitHub API request failed');
    return parseJsonBody(await readBoundedBody(response));
  }finally{
    clearTimer(timer);
  }
}

function discoveryAlert(category,{clock,scheduleGraceMs,workerDeadlineMs,scan}){
  const now=canonicalNow(clock);
  const window=scheduleWindow(now.milliseconds,scheduleGraceMs);
  return alertResult(category,{checkedAt:now.timestamp,nowMilliseconds:now.milliseconds,
    scheduleGraceMs,workerDeadlineMs,scan,matchingRuns:0,...window});
}

export async function discoverOutboxDispatchStatus(environment,{fetchImpl=fetch,clock=Date.now,
  setTimer=setTimeout,clearTimer=clearTimeout,monotonicClock=Date.now}={}){
  const repository=String(environment.GITHUB_REPOSITORY||'');
  const defaultBranch=String(environment.WATCHDOG_DEFAULT_BRANCH||'');
  const apiUrl=String(environment.GITHUB_API_URL||'');
  const token=String(environment.GITHUB_TOKEN||'');
  const scheduleGraceMs=positiveInteger(environment.WATCHDOG_SCHEDULE_GRACE_MS,'schedule grace',
    {maximum:60*60*1000});
  const workerDeadlineMs=positiveInteger(environment.WATCHDOG_WORKER_DEADLINE_MS,'worker deadline',
    {maximum:10*60*1000});
  const apiTimeoutMs=positiveInteger(environment.WATCHDOG_API_TIMEOUT_MS,'API timeout',
    {maximum:30*1000});
  const maxPages=positiveInteger(environment.WATCHDOG_MAX_PAGES,'maximum pages',{maximum:5});
  const perPage=positiveInteger(environment.WATCHDOG_PER_PAGE,'page size',{maximum:100});
  const scan={pagesScanned:0,runsScanned:0,truncated:false};
  if(!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)||!token
    ||!/^https:\/\/[^/?#]+(?:\/[A-Za-z0-9._/-]*)?$/.test(apiUrl)
    ||typeof defaultBranch!=='string'||!/^[A-Za-z0-9._/-]{1,255}$/.test(defaultBranch)){
    return discoveryAlert('api_failure',{clock,scheduleGraceMs,workerDeadlineMs,scan});
  }
  const runs=[];
  let totalCount=null;
  const requestStarted=monotonicClock();
  try{
    const root=apiUrl.replace(/\/$/u,'');
    for(let page=1;page<=maxPages;page+=1){
      const remaining=apiTimeoutMs-(monotonicClock()-requestStarted);
      if(!Number.isFinite(remaining)||remaining<=0) throw new Error('GitHub API request failed');
      const query=new URLSearchParams({branch:defaultBranch,event:'schedule',per_page:String(perPage),page:String(page)});
      const body=await fetchJson(fetchImpl,
        `${root}/repos/${repository}/actions/workflows/${SOURCE_WORKFLOW}/runs?${query}`,
        token,remaining,{setTimer,clearTimer});
      if(monotonicClock()-requestStarted>=apiTimeoutMs) throw new Error('GitHub API request failed');
      if(!record(body)||!Array.isArray(body.workflow_runs)
        ||!Number.isSafeInteger(body.total_count)||body.total_count<0
        ||body.total_count<body.workflow_runs.length
        ||body.workflow_runs.length>perPage){
        throw new MalformedResponseError('GitHub response is malformed');
      }
      scan.pagesScanned+=1;
      totalCount=body.total_count;
      runs.push(...body.workflow_runs);
      scan.runsScanned=runs.length;
      if(body.workflow_runs.length<perPage||runs.length>=totalCount) break;
      if(page===maxPages) scan.truncated=true;
    }
  }catch(error){
    return discoveryAlert(error instanceof MalformedResponseError?'malformed_response':'api_failure',
      {clock,scheduleGraceMs,workerDeadlineMs,scan});
  }
  if(totalCount!==null&&runs.length<totalCount&&scan.pagesScanned===maxPages) scan.truncated=true;
  return assessOutboxDispatchRuns(runs,{defaultBranch,scheduleGraceMs,workerDeadlineMs,clock,scan});
}

export async function main({argv=process.argv.slice(2),environment=process.env,stdout=process.stdout,
  fetchImpl=fetch,clock=Date.now,setTimer=setTimeout,clearTimer=clearTimeout,
  monotonicClock=Date.now}={}){
  let result;
  try{
    if(argv.length!==0) throw new TypeError('watchdog usage is invalid');
    result=await discoverOutboxDispatchStatus(environment,{fetchImpl,clock,setTimer,clearTimer,
      monotonicClock});
  }catch{
    const now=canonicalNow(clock);
    const window=scheduleWindow(now.milliseconds,15*60*1000);
    result=alertResult('api_failure',{checkedAt:now.timestamp,nowMilliseconds:now.milliseconds,
      scheduleGraceMs:15*60*1000,workerDeadlineMs:2*60*1000,
      scan:{pagesScanned:0,runsScanned:0,truncated:false},matchingRuns:0,...window});
  }
  stdout.write(`${JSON.stringify(result)}\n`);
  return {exitCode:result.alert?1:0,result};
}

const isEntryPoint=process.argv[1]&&fileURLToPath(import.meta.url)===resolve(process.argv[1]);
if(isEntryPoint){
  const execution=await main();
  process.exitCode=execution.exitCode;
}
