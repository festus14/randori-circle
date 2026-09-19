#!/usr/bin/env node
import { constants } from 'node:fs';
import { appendFile, lstat, mkdir, open, realpath } from 'node:fs/promises';
import { basename, dirname, isAbsolute, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  REHEARSAL_FORMAT,
  REHEARSAL_RPO_TARGET_MS,
  REHEARSAL_RTO_TARGET_MS,
  verifyRehearsalAttestation,
} from './turso-backup-restore-rehearsal.mjs';

export const BACKUP_MONITOR_FORMAT='randori.turso-backup-monitor.v1';

const MAX_SUMMARY_BYTES=128*1024;
const DIGEST=/^[a-f0-9]{64}$/;
const COMMIT=/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/;
const OWNER='repository-operations';
const CADENCE='weekly';

function freeze(value){
  if(Array.isArray(value)) return Object.freeze(value.map(freeze));
  if(value&&typeof value==='object'){
    return Object.freeze(Object.fromEntries(Object.entries(value).map(([key,item])=>[key,freeze(item)])));
  }
  return value;
}

function positiveInteger(value,label,{maximum=Number.MAX_SAFE_INTEGER}={}){
  const parsed=typeof value==='string'&&/^[1-9][0-9]*$/.test(value)?Number(value):value;
  if(!Number.isSafeInteger(parsed)||parsed<1||parsed>maximum) throw new TypeError(`${label} is invalid`);
  return parsed;
}

function canonicalNow(clock){
  const value=typeof clock==='function'?clock():Date.now();
  const milliseconds=value instanceof Date?value.getTime():Number(value);
  if(!Number.isSafeInteger(milliseconds)||milliseconds<0) throw new TypeError('monitor clock is invalid');
  return {milliseconds,timestamp:new Date(milliseconds).toISOString()};
}

function publicAlert(category,checkedAt,{runId=null,runAttempt=null}={}){
  const allowed=new Set([
    'evidence_missing','evidence_stale','evidence_corrupt','rehearsal_failure','cleanup_failure',
  ]);
  return freeze({
    ok:false,kind:'turso-backup-monitor',format:BACKUP_MONITOR_FORMAT,status:'alert',alert:true,
    category:allowed.has(category)?category:'rehearsal_failure',checkedAt,owner:OWNER,cadence:CADENCE,
    ...(Number.isSafeInteger(runId)&&runId>0?{runId}:{}),
    ...(Number.isSafeInteger(runAttempt)&&runAttempt>0?{runAttempt}:{}),
  });
}

function safeRun(options){
  return {
    runId:positiveInteger(options.runId,'run ID'),
    runAttempt:positiveInteger(options.runAttempt,'run attempt',{maximum:1_000_000}),
  };
}

function exactKeys(value,keys){
  return value!==null&&typeof value==='object'&&!Array.isArray(value)
    &&JSON.stringify(Object.keys(value).sort())===JSON.stringify([...keys].sort());
}

function cleanupPassed(cleanup,repoCommit){
  const safety=cleanup?.safety;
  return exactKeys(cleanup,[
    'ok','kind','format','repoCommit','noState','recoveryRequired','safety',
  ])&&cleanup.ok===true&&cleanup.kind==='turso-backup-restore-cleanup'
    &&cleanup.format===REHEARSAL_FORMAT&&cleanup.repoCommit===repoCommit
    &&cleanup.noState===false&&cleanup.recoveryRequired===false
    &&exactKeys(safety,[
      'sourceIdentityVerified','writesBlockedBeforePitr','sourceWriteStateRestored',
      'restoreIdentityVerified','restoreDeleted','sourceMigrated','sourceDeleted',
      'credentialsInvalidated',
    ])&&typeof safety.sourceIdentityVerified==='boolean'&&safety.writesBlockedBeforePitr===true
    &&safety.sourceWriteStateRestored===true&&safety.restoreIdentityVerified===true
    &&safety.restoreDeleted===true&&safety.sourceMigrated===false&&safety.sourceDeleted===false
    &&safety.credentialsInvalidated===false;
}

export function assessBackupRestoreRun({rehearsal,cleanup}={},options={}){
  const now=canonicalNow(options.clock);
  let run;
  try{ run=safeRun(options); }
  catch{ return publicAlert('evidence_corrupt',now.timestamp); }
  if(typeof options.repoCommit!=='string'||!COMMIT.test(options.repoCommit)){
    return publicAlert('evidence_corrupt',now.timestamp,run);
  }
  if(rehearsal===null||rehearsal===undefined||cleanup===null||cleanup===undefined){
    return publicAlert('evidence_missing',now.timestamp,run);
  }
  if(!cleanupPassed(cleanup,options.repoCommit)){
    return publicAlert('cleanup_failure',now.timestamp,run);
  }
  if(rehearsal?.ok!==true){
    return publicAlert(
      rehearsal?.error==='REHEARSAL_RESTORE_CLEANUP_REQUIRED'?'cleanup_failure':'rehearsal_failure',
      now.timestamp,run,
    );
  }
  const issuedAt=Date.parse(rehearsal?.payload?.issuedAt);
  const maximumAge=(()=>{
    try{ return positiveInteger(options.maxSuccessAgeMs,'maximum success age',{maximum:90*24*60*60*1000}); }
    catch{ return null; }
  })();
  if(maximumAge===null||!Number.isFinite(issuedAt)||issuedAt>now.milliseconds){
    return publicAlert('evidence_corrupt',now.timestamp,run);
  }
  if(now.milliseconds-issuedAt>maximumAge){
    return publicAlert('evidence_stale',now.timestamp,run);
  }
  let rpoTargetMs;
  let rtoTargetMs;
  try{
    rpoTargetMs=positiveInteger(options.rpoTargetMs,'RPO target',{maximum:90*24*60*60*1000});
    rtoTargetMs=positiveInteger(options.rtoTargetMs,'RTO target',{maximum:90*24*60*60*1000});
  }catch{ return publicAlert('evidence_corrupt',now.timestamp,run); }
  if(rpoTargetMs!==REHEARSAL_RPO_TARGET_MS||rtoTargetMs!==REHEARSAL_RTO_TARGET_MS){
    return publicAlert('evidence_corrupt',now.timestamp,run);
  }
  let payload;
  try{
    const verifier=options.verify??verifyRehearsalAttestation;
    payload=verifier(rehearsal,{
      hmacKey:options.hmacKey,repoCommit:options.repoCommit,context:options.context,
      maxAgeMs:options.maxEvidenceAgeMs,rpoTargetMs,rtoTargetMs,runConclusion:'success',
      sourceIdentity:options.sourceIdentity,backupRef:options.backupRef,clock:options.clock,
    });
  }catch{ return publicAlert('evidence_corrupt',now.timestamp,run); }
  const verification=payload?.verification;
  const schema=payload?.schema;
  const evidence=payload?.evidence;
  if(!verification||verification.rpoMet!==true||verification.rtoMet!==true
    ||!Number.isSafeInteger(verification.tableCount)||verification.tableCount<1
    ||!Number.isSafeInteger(verification.totalRows)||verification.totalRows<0
    ||!Number.isSafeInteger(verification.sequenceRows)||verification.sequenceRows<0
    ||!Array.isArray(payload?.migration?.appliedVersions)
    ||![schema?.manifestChecksum,schema?.sourceExecutableMigrationsChecksum,
      schema?.finalExecutableMigrationsChecksum,evidence?.comparisonDigest].every(value=>DIGEST.test(value))){
    return publicAlert('evidence_corrupt',now.timestamp,run);
  }
  return freeze({
    ok:true,kind:'turso-backup-monitor',format:BACKUP_MONITOR_FORMAT,status:'healthy',alert:false,
    category:null,checkedAt:now.timestamp,owner:OWNER,cadence:CADENCE,...run,
    repoCommit:COMMIT.test(options.repoCommit)?options.repoCommit:payload.context.repoCommit,
    objectives:{
      rpoTargetMs:verification.rpoTargetMs,rtoTargetMs:verification.rtoTargetMs,
      sourceSnapshotAgeMs:verification.sourceSnapshotAgeMs,
      restoredSnapshotAgeMs:verification.restoredSnapshotAgeMs,
      restoreDurationMs:verification.restoreDurationMs,
    },
    counts:{
      tableCount:verification.tableCount,totalRows:verification.totalRows,
      sequenceRows:verification.sequenceRows,
      appliedMigrationCount:payload.migration.appliedVersions.length,
    },
    checksums:{
      schemaManifest:schema.manifestChecksum,
      sourceMigrations:schema.sourceExecutableMigrationsChecksum,
      finalMigrations:schema.finalExecutableMigrationsChecksum,
      restoreComparison:evidence.comparisonDigest,
    },
    cleanup:{sourceWriteStateRestored:true,restoreDeleted:true},
  });
}

function parseArguments(argv){
  if(!Array.isArray(argv)||argv.length!==6) throw new TypeError('usage is invalid');
  const flags=new Map();
  for(let index=0;index<argv.length;index+=2){
    if(!['--rehearsal-summary','--cleanup-summary','--output'].includes(argv[index])
      ||flags.has(argv[index])||!argv[index+1]) throw new TypeError('usage is invalid');
    flags.set(argv[index],argv[index+1]);
  }
  return Object.fromEntries(flags);
}

async function safeRunnerPath(path,runnerTemp,expectedName,{mustExist=true}={}){
  if(!isAbsolute(path)||!isAbsolute(runnerTemp)||basename(path)!==expectedName){
    throw new TypeError('monitor path is invalid');
  }
  const lexicalRoot=resolve(runnerTemp);
  const root=await realpath(runnerTemp);
  const lexicalChild=relative(lexicalRoot,resolve(dirname(path)));
  if(lexicalChild.startsWith('..')||isAbsolute(lexicalChild)){
    throw new TypeError('monitor path escaped runner temp');
  }
  const requestedParent=resolve(root,lexicalChild);
  if(!mustExist) await mkdir(requestedParent,{recursive:true,mode:0o700});
  const parent=await realpath(requestedParent);
  const child=relative(root,parent);
  if(child.startsWith('..')||isAbsolute(child)) throw new TypeError('monitor path escaped runner temp');
  if(mustExist){
    const metadata=await lstat(path,{bigint:true});
    if(metadata.isSymbolicLink()||!metadata.isFile()||metadata.size>BigInt(MAX_SUMMARY_BYTES)){
      throw new TypeError('monitor evidence file is unsafe');
    }
  }
  return resolve(parent,expectedName);
}

async function readSummary(path,runnerTemp,expectedName){
  try{
    const safe=await safeRunnerPath(path,runnerTemp,expectedName);
    const handle=await open(safe,constants.O_RDONLY|(constants.O_NOFOLLOW||0));
    try{ return JSON.parse(await handle.readFile({encoding:'utf8'})); }
    finally{ await handle.close(); }
  }catch(error){
    if(error?.code==='ENOENT') return null;
    return Symbol.for('corrupt-monitor-evidence');
  }
}

function environmentOptions(environment){
  const sourceId=environment.TURSO_PRODUCTION_DATABASE_ID;
  const sourceName=environment.TURSO_PRODUCTION_DATABASE_NAME;
  const sourceGroup=environment.TURSO_GROUP;
  return {
    runId:environment.GITHUB_RUN_ID,runAttempt:environment.GITHUB_RUN_ATTEMPT,
    repoCommit:environment.REHEARSAL_REPO_COMMIT,
    maxSuccessAgeMs:environment.BACKUP_MONITOR_MAX_SUCCESS_AGE_MS,
    maxEvidenceAgeMs:environment.REHEARSAL_MAX_EVIDENCE_AGE_MS,
    rpoTargetMs:environment.REHEARSAL_RPO_TARGET_MS,
    rtoTargetMs:environment.REHEARSAL_RTO_TARGET_MS,
    hmacKey:environment.MIGRATION_DIGEST_HMAC_KEY,
    sourceIdentity:sourceId,
    backupRef:`turso-pitr:${sourceId}:${sourceName}:${sourceGroup}`,
    context:{
      repository:environment.GITHUB_REPOSITORY,
      repositoryId:environment.GITHUB_REPOSITORY_ID,
      workflowPath:environment.REHEARSAL_WORKFLOW_PATH,
      workflowRef:environment.GITHUB_WORKFLOW_REF,
      workflowSha:environment.GITHUB_WORKFLOW_SHA,
      runId:environment.GITHUB_RUN_ID,
      runAttempt:environment.GITHUB_RUN_ATTEMPT,
      environment:environment.REHEARSAL_GITHUB_ENVIRONMENT,
      repoCommit:environment.REHEARSAL_REPO_COMMIT,
    },
  };
}

async function writeResult(path,value,runnerTemp){
  const safe=await safeRunnerPath(path,runnerTemp,'backup-monitor-summary.json',{mustExist:false});
  const handle=await open(safe,'wx',0o600);
  try{ await handle.writeFile(`${JSON.stringify(value)}\n`,{encoding:'utf8'}); }
  finally{ await handle.close(); }
}

export async function main({argv=process.argv.slice(2),environment=process.env,stdout=process.stdout,
  clock=Date.now}={}){
  const checked=canonicalNow(clock);
  let result=publicAlert('evidence_missing',checked.timestamp);
  try{
    const flags=parseArguments(argv);
    const runnerTemp=environment.RUNNER_TEMP;
    const rehearsal=await readSummary(flags['--rehearsal-summary'],runnerTemp,'rehearsal-summary.json');
    const cleanup=await readSummary(flags['--cleanup-summary'],runnerTemp,'cleanup-summary.json');
    result=rehearsal===Symbol.for('corrupt-monitor-evidence')
      ||cleanup===Symbol.for('corrupt-monitor-evidence')
      ?publicAlert('evidence_corrupt',checked.timestamp,safeRun(environmentOptions(environment)))
      :assessBackupRestoreRun({rehearsal,cleanup},{...environmentOptions(environment),clock});
    await writeResult(flags['--output'],result,runnerTemp);
    if(environment.GITHUB_OUTPUT){
      await appendFile(environment.GITHUB_OUTPUT,
        `alert=${result.alert?'true':'false'}\ncategory=${result.category||'healthy'}\n`,
        {encoding:'utf8'});
    }
  }catch{
    result=publicAlert('evidence_corrupt',checked.timestamp);
  }
  stdout.write(`${JSON.stringify(result)}\n`);
  return {exitCode:0,result};
}

const isEntryPoint=process.argv[1]&&fileURLToPath(import.meta.url)===resolve(process.argv[1]);
if(isEntryPoint){
  const execution=await main();
  process.exitCode=execution.exitCode;
}
