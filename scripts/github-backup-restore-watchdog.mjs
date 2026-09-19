#!/usr/bin/env node
import { constants } from 'node:fs';
import { appendFile, lstat, mkdir, open, realpath, rename } from 'node:fs/promises';
import { basename, dirname, isAbsolute, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const BACKUP_WATCHDOG_FORMAT='randori.backup-restore-watchdog.v1';

const SOURCE_WORKFLOW='turso-backup-restore-rehearsal.yml';
const MONITOR_FORMAT='randori.turso-backup-monitor.v1';
const OWNER='@festus14';
const CADENCE='hourly';
const WEEK_MS=7*24*60*60*1000;
const EXPECTED_WEEKDAY_UTC=1;
const EXPECTED_HOUR_UTC=3;
const EXPECTED_MINUTE_UTC=17;
const RPO_TARGET_MS=30*60*1000;
const RTO_TARGET_MS=15*60*1000;
const MAX_FILE_BYTES=128*1024;
const DIGEST=/^[a-f0-9]{64}$/;
const COMMIT=/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/;
const ACTIVE_STATUSES=new Set(['queued','in_progress','pending','requested','waiting']);
const ALERT_CATEGORIES=new Set([
  'run_missing','run_stuck','run_failed','run_stale','artifact_missing','artifact_expired',
  'artifact_stale','artifact_corrupt','api_failure',
]);

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

function safeRun(value,defaultBranch){
  const run=record(value);
  const created=timestamp(run?.created_at);
  const updated=timestamp(run?.updated_at);
  const repoCommit=run?.head_sha;
  const runId=Number(run?.id);
  const runAttempt=Number(run?.run_attempt);
  if(!Number.isSafeInteger(runId)||runId<1||!Number.isSafeInteger(runAttempt)||runAttempt<1
    ||run?.event!=='schedule'||run?.head_branch!==defaultBranch||!COMMIT.test(repoCommit)
    ||!created||!updated
    ||updated.milliseconds<created.milliseconds||typeof run?.status!=='string'
    ||(run.conclusion!==null&&typeof run.conclusion!=='string')) return null;
  return {runId,runAttempt,repoCommit,status:run.status,conclusion:run.conclusion,
    createdAt:created.value,updatedAt:updated.value};
}

function mostRecentWeeklySlot(nowMilliseconds){
  const now=new Date(nowMilliseconds);
  const daysSinceMonday=(now.getUTCDay()-EXPECTED_WEEKDAY_UTC+7)%7;
  let slot=Date.UTC(now.getUTCFullYear(),now.getUTCMonth(),now.getUTCDate()-daysSinceMonday,
    EXPECTED_HOUR_UTC,EXPECTED_MINUTE_UTC);
  if(nowMilliseconds<slot) slot-=WEEK_MS;
  return slot;
}

function expectedWeeklySlot(nowMilliseconds,graceMs){
  let slot=mostRecentWeeklySlot(nowMilliseconds);
  if(nowMilliseconds<slot+graceMs) slot-=WEEK_MS;
  return slot;
}

function publicAlert(category,checkedAt,run={}){
  const expectedAt=timestamp(run.expectedAt);
  return freeze({
    ok:false,kind:'backup-restore-watchdog',format:BACKUP_WATCHDOG_FORMAT,status:'alert',alert:true,
    category:ALERT_CATEGORIES.has(category)?category:'api_failure',checkedAt,owner:OWNER,cadence:CADENCE,
    ...(expectedAt?{expectedAt:expectedAt.value}:{}),
    ...(Number.isSafeInteger(run.runId)&&run.runId>0?{runId:run.runId}:{}),
    ...(Number.isSafeInteger(run.runAttempt)&&run.runAttempt>0?{runAttempt:run.runAttempt}:{}),
  });
}

function pendingResult(checkedAt,run){
  return freeze({ok:true,kind:'backup-restore-watchdog',format:BACKUP_WATCHDOG_FORMAT,
    status:'observing',alert:false,category:null,checkedAt,owner:OWNER,cadence:CADENCE,
    expectedAt:run.expectedAt,runId:run.runId,runAttempt:run.runAttempt,runStatus:run.status});
}

function candidateResult(checkedAt,run,artifact){
  return freeze({ok:true,kind:'backup-restore-watchdog',format:BACKUP_WATCHDOG_FORMAT,
    status:'candidate',alert:false,category:null,checkedAt,owner:OWNER,cadence:CADENCE,
    expectedAt:run.expectedAt,runId:run.runId,runAttempt:run.runAttempt,repoCommit:run.repoCommit,
    runCreatedAt:run.createdAt,
    artifactId:artifact.artifactId,artifactName:artifact.artifactName,
    artifactCreatedAt:artifact.artifactCreatedAt});
}

export function assessScheduledRuns(runs,{defaultBranch,maxRunAgeMs,stuckAfterMs,slotGraceMs,
  slotDeadlineMs,clock=Date.now}={}){
  const now=canonicalNow(clock);
  const maximumAge=positiveInteger(maxRunAgeMs,'maximum run age',{maximum:90*24*60*60*1000});
  const stuckAge=positiveInteger(stuckAfterMs,'stuck-run age',{maximum:24*60*60*1000});
  const grace=positiveInteger(slotGraceMs,'schedule grace',{maximum:24*60*60*1000});
  const slotDeadline=positiveInteger(slotDeadlineMs,'schedule deadline',
    {maximum:4*60*60*1000});
  if(slotDeadline<=grace) throw new TypeError('schedule deadline is invalid');
  if(typeof defaultBranch!=='string'||!/^[A-Za-z0-9._/-]{1,255}$/.test(defaultBranch)){
    return publicAlert('api_failure',now.timestamp);
  }
  const safeRuns=(Array.isArray(runs)?runs:[]).map(value=>safeRun(value,defaultBranch)).filter(Boolean)
    .sort((left,right)=>Date.parse(right.createdAt)-Date.parse(left.createdAt));
  const expectedAt=expectedWeeklySlot(now.milliseconds,grace);
  const scheduledAt=mostRecentWeeklySlot(now.milliseconds);
  const currentRuns=safeRuns.filter(run=>Date.parse(run.createdAt)>=expectedAt);
  if(currentRuns.length===0){
    return publicAlert('run_missing',now.timestamp,{expectedAt:new Date(expectedAt).toISOString()});
  }
  const latest={...currentRuns[0],expectedAt:new Date(expectedAt).toISOString()};
  if(ACTIVE_STATUSES.has(latest.status)){
    if(now.milliseconds-scheduledAt>=slotDeadline
      ||now.milliseconds-Date.parse(latest.createdAt)>stuckAge){
      return publicAlert('run_stuck',now.timestamp,latest);
    }
    const previousSuccess=currentRuns.find(run=>run.status==='completed'&&run.conclusion==='success');
    if(!previousSuccess) return pendingResult(now.timestamp,latest);
    if(now.milliseconds-Date.parse(previousSuccess.createdAt)>maximumAge){
      return publicAlert('run_stale',now.timestamp,{...previousSuccess,expectedAt:latest.expectedAt});
    }
    return freeze({...previousSuccess,expectedAt:latest.expectedAt,checkedAt:now.timestamp,candidate:true});
  }
  if(latest.status!=='completed'||latest.conclusion!=='success'){
    return publicAlert('run_failed',now.timestamp,latest);
  }
  if(now.milliseconds-Date.parse(latest.createdAt)>maximumAge){
    return publicAlert('run_stale',now.timestamp,latest);
  }
  return freeze({...latest,checkedAt:now.timestamp,candidate:true});
}

export function assessMonitorArtifacts(artifacts,run,{maxRunAgeMs,clock=Date.now}={}){
  const now=canonicalNow(clock);
  const maximumAge=positiveInteger(maxRunAgeMs,'maximum artifact age',{maximum:90*24*60*60*1000});
  if(!run?.candidate) return run;
  const expectedName=`turso-backup-monitor-${run.runId}-${run.runAttempt}`;
  const matches=(Array.isArray(artifacts)?artifacts:[]).filter(item=>record(item)?.name===expectedName);
  if(matches.length!==1) return publicAlert('artifact_missing',now.timestamp,run);
  const item=matches[0];
  const artifactId=Number(item.id);
  const created=timestamp(item.created_at);
  if(!Number.isSafeInteger(artifactId)||artifactId<1||!created){
    return publicAlert('artifact_corrupt',now.timestamp,run);
  }
  if(item.expired===true) return publicAlert('artifact_expired',now.timestamp,run);
  if(now.milliseconds-created.milliseconds>maximumAge){
    return publicAlert('artifact_stale',now.timestamp,run);
  }
  return candidateResult(now.timestamp,run,{artifactId,artifactName:expectedName,
    artifactCreatedAt:created.value});
}

function exactKeys(value,keys){
  return record(value)!==null
    &&JSON.stringify(Object.keys(value).sort())===JSON.stringify([...keys].sort());
}

function nonnegativeInteger(value){
  return Number.isSafeInteger(value)&&value>=0;
}

export function verifyDownloadedMonitor(summary,discovery,{maxRunAgeMs,clock=Date.now}={}){
  const now=canonicalNow(clock);
  const maximumAge=positiveInteger(maxRunAgeMs,'maximum monitor age',{maximum:90*24*60*60*1000});
  const checkedAt=timestamp(summary?.checkedAt);
  const objectives=summary?.objectives;
  const counts=summary?.counts;
  const checksums=summary?.checksums;
  const cleanup=summary?.cleanup;
  const healthy=discovery?.status==='candidate'&&discovery?.alert===false
    &&exactKeys(summary,[
      'ok','kind','format','status','alert','category','checkedAt','owner','cadence','runId',
      'runAttempt','repoCommit','objectives','counts','checksums','cleanup',
    ])&&summary.ok===true&&summary.kind==='turso-backup-monitor'&&summary.format===MONITOR_FORMAT
    &&summary.status==='healthy'&&summary.alert===false&&summary.category===null
    &&summary.owner==='repository-operations'&&summary.cadence==='weekly'
    &&summary.runId===discovery.runId&&summary.runAttempt===discovery.runAttempt
    &&summary.repoCommit===discovery.repoCommit
    &&typeof summary.repoCommit==='string'&&COMMIT.test(summary.repoCommit)&&checkedAt
    &&checkedAt.milliseconds<=now.milliseconds
    &&now.milliseconds-checkedAt.milliseconds<=maximumAge
    &&exactKeys(objectives,[
      'rpoTargetMs','rtoTargetMs','sourceSnapshotAgeMs','restoredSnapshotAgeMs','restoreDurationMs',
    ])&&objectives?.rpoTargetMs===RPO_TARGET_MS&&objectives?.rtoTargetMs===RTO_TARGET_MS
    &&nonnegativeInteger(objectives?.sourceSnapshotAgeMs)
    &&nonnegativeInteger(objectives?.restoredSnapshotAgeMs)
    &&nonnegativeInteger(objectives?.restoreDurationMs)
    &&objectives.sourceSnapshotAgeMs<=objectives.rpoTargetMs
    &&objectives.restoredSnapshotAgeMs<=objectives.rpoTargetMs
    &&objectives.restoreDurationMs<=objectives.rtoTargetMs
    &&exactKeys(counts,['tableCount','totalRows','sequenceRows','appliedMigrationCount'])
    &&Number.isSafeInteger(counts?.tableCount)&&counts.tableCount>0
    &&nonnegativeInteger(counts?.totalRows)&&nonnegativeInteger(counts?.sequenceRows)
    &&nonnegativeInteger(counts?.appliedMigrationCount)
    &&exactKeys(checksums,[
      'schemaManifest','sourceMigrations','finalMigrations','restoreComparison',
    ])&&Object.values(checksums||{}).every(value=>DIGEST.test(value))
    &&exactKeys(cleanup,['sourceWriteStateRestored','restoreDeleted'])
    &&cleanup?.sourceWriteStateRestored===true&&cleanup?.restoreDeleted===true;
  if(!healthy) return publicAlert('artifact_corrupt',now.timestamp,discovery||{});
  return freeze({
    ok:true,kind:'backup-restore-watchdog',format:BACKUP_WATCHDOG_FORMAT,status:'healthy',
    alert:false,category:null,checkedAt:now.timestamp,owner:OWNER,cadence:CADENCE,
    expectedAt:discovery.expectedAt,runId:discovery.runId,runAttempt:discovery.runAttempt,
    runCreatedAt:discovery.runCreatedAt,artifactCreatedAt:discovery.artifactCreatedAt,
    monitorCheckedAt:checkedAt.value,repoCommit:summary.repoCommit,
    objectives:{...objectives},counts:{...counts},checksums:{...checksums},cleanup:{...cleanup},
  });
}

async function fetchJson(fetchImpl,url,token){
  const response=await fetchImpl(url,{headers:{accept:'application/vnd.github+json',
    authorization:`Bearer ${token}`,'x-github-api-version':'2022-11-28'}});
  if(!response?.ok) throw new Error('GitHub API request failed');
  return response.json();
}

export async function discoverAuthoritativeEvidence(environment,{fetchImpl=fetch,clock=Date.now}={}){
  const repository=String(environment.GITHUB_REPOSITORY||'');
  const defaultBranch=String(environment.WATCHDOG_DEFAULT_BRANCH||'');
  const apiUrl=String(environment.GITHUB_API_URL||'');
  const token=String(environment.GITHUB_TOKEN||'');
  if(!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)||!token
    ||!/^https:\/\/[^/?#]+(?:\/[A-Za-z0-9._/-]*)?$/.test(apiUrl)) throw new TypeError('watchdog API configuration is invalid');
  const maximumAge=positiveInteger(environment.WATCHDOG_MAX_RUN_AGE_MS,'maximum run age');
  const stuckAfter=positiveInteger(environment.WATCHDOG_STUCK_AFTER_MS,'stuck-run age');
  const slotGrace=positiveInteger(environment.WATCHDOG_SLOT_GRACE_MS,'schedule grace');
  const slotDeadline=positiveInteger(environment.WATCHDOG_SLOT_DEADLINE_MS,'schedule deadline');
  const root=apiUrl.replace(/\/$/u,'');
  const query=new URLSearchParams({branch:defaultBranch,event:'schedule',per_page:'10'});
  const runResponse=await fetchJson(fetchImpl,
    `${root}/repos/${repository}/actions/workflows/${SOURCE_WORKFLOW}/runs?${query}`,token);
  const run=assessScheduledRuns(runResponse?.workflow_runs,{defaultBranch,
    maxRunAgeMs:maximumAge,stuckAfterMs:stuckAfter,slotGraceMs:slotGrace,
    slotDeadlineMs:slotDeadline,clock});
  if(run.alert||!run.candidate) return run;
  const artifactResponse=await fetchJson(fetchImpl,
    `${root}/repos/${repository}/actions/runs/${run.runId}/artifacts?per_page=100`,token);
  return assessMonitorArtifacts(artifactResponse?.artifacts,run,{maxRunAgeMs:maximumAge,clock});
}

function parseArguments(argv){
  const flags=new Map();
  for(let index=0;index<argv.length;index+=2){
    if(!['--mode','--output','--discovery','--monitor-summary'].includes(argv[index])
      ||flags.has(argv[index])||!argv[index+1]) throw new TypeError('watchdog usage is invalid');
    flags.set(argv[index],argv[index+1]);
  }
  const value=Object.fromEntries(flags);
  if(!['discover','verify'].includes(value['--mode'])||!value['--output']){
    throw new TypeError('watchdog usage is invalid');
  }
  if(value['--mode']==='verify'&&(!value['--discovery']||!value['--monitor-summary'])){
    throw new TypeError('watchdog usage is invalid');
  }
  return value;
}

async function safeRunnerPath(path,runnerTemp,expectedName,{mustExist=true}={}){
  if(!isAbsolute(path)||!isAbsolute(runnerTemp)||basename(path)!==expectedName){
    throw new TypeError('watchdog path is invalid');
  }
  const lexicalRoot=resolve(runnerTemp);
  const root=await realpath(runnerTemp);
  const lexicalChild=relative(lexicalRoot,resolve(dirname(path)));
  if(lexicalChild.startsWith('..')||isAbsolute(lexicalChild)) throw new TypeError('watchdog path escaped runner temp');
  const requestedParent=resolve(root,lexicalChild);
  if(!mustExist) await mkdir(requestedParent,{recursive:true,mode:0o700});
  const parent=await realpath(requestedParent);
  const child=relative(root,parent);
  if(child.startsWith('..')||isAbsolute(child)) throw new TypeError('watchdog path escaped runner temp');
  const safe=resolve(parent,expectedName);
  if(mustExist){
    const metadata=await lstat(safe,{bigint:true});
    if(metadata.isSymbolicLink()||!metadata.isFile()||metadata.size>BigInt(MAX_FILE_BYTES)){
      throw new TypeError('watchdog file is unsafe');
    }
  }
  return safe;
}

async function readJson(path,runnerTemp,expectedName){
  const safe=await safeRunnerPath(path,runnerTemp,expectedName);
  const handle=await open(safe,constants.O_RDONLY|(constants.O_NOFOLLOW||0));
  try{ return JSON.parse(await handle.readFile({encoding:'utf8'})); }
  finally{ await handle.close(); }
}

async function writeJson(path,value,runnerTemp){
  const safe=await safeRunnerPath(path,runnerTemp,'backup-watchdog-summary.json',{mustExist:false});
  const temporary=`${safe}.tmp-${process.pid}`;
  const handle=await open(temporary,'wx',0o600);
  try{ await handle.writeFile(`${JSON.stringify(value)}\n`,{encoding:'utf8'}); }
  finally{ await handle.close(); }
  await rename(temporary,safe);
}

async function writeOutputs(path,result){
  if(!path) return;
  const values=[`alert=${result.alert?'true':'false'}`,`category=${result.category||result.status}`,
    `candidate=${result.status==='candidate'?'true':'false'}`];
  if(result.status==='candidate'){
    values.push(`run_id=${result.runId}`,`run_attempt=${result.runAttempt}`,
      `artifact_name=${result.artifactName}`);
  }
  await appendFile(path,`${values.join('\n')}\n`,{encoding:'utf8'});
}

export async function main({argv=process.argv.slice(2),environment=process.env,stdout=process.stdout,
  fetchImpl=fetch,clock=Date.now}={}){
  let result;
  let outputPath=null;
  let writeFailed=false;
  try{
    const flags=parseArguments(argv);
    outputPath=flags['--output'];
    if(flags['--mode']==='discover'){
      result=await discoverAuthoritativeEvidence(environment,{fetchImpl,clock});
    }else{
      const discovery=await readJson(flags['--discovery'],environment.RUNNER_TEMP,
        'backup-watchdog-summary.json');
      const summary=await readJson(flags['--monitor-summary'],environment.RUNNER_TEMP,
        'backup-monitor-summary.json');
      result=verifyDownloadedMonitor(summary,discovery,{
        maxRunAgeMs:environment.WATCHDOG_MAX_RUN_AGE_MS,clock,
      });
    }
  }catch{
    const checked=canonicalNow(clock).timestamp;
    result=publicAlert(argv.includes('verify')?'artifact_corrupt':'api_failure',checked);
  }
  try{
    await writeJson(outputPath,result,environment.RUNNER_TEMP);
    await writeOutputs(environment.GITHUB_OUTPUT,result);
  }catch{ writeFailed=true; }
  stdout.write(`${JSON.stringify(result)}\n`);
  return {exitCode:writeFailed?1:0,result};
}

const isEntryPoint=process.argv[1]&&fileURLToPath(import.meta.url)===resolve(process.argv[1]);
if(isEntryPoint){
  const execution=await main();
  process.exitCode=execution.exitCode;
}
