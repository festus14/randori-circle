#!/usr/bin/env node
import { constants } from 'node:fs';
import { lstat, mkdir, open, realpath } from 'node:fs/promises';
import { basename, isAbsolute, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createClient } from '@libsql/client';
import { EXECUTABLE_MIGRATIONS, LATEST_MIGRATION_VERSION } from '../db/executable-migrations.js';
import {
  GitHubActionsError,
  createGitHubActionsClient,
  extractSingleJsonArtifact,
} from '../db/github-actions-artifact.js';
import {
  MigrationError,
  adoptMigrations,
  applyMigrations,
  inspectMigrationState,
  publicMigrationError,
} from '../db/migration-runner.js';
import { checksum } from '../db/schema-manifest.js';
import { TursoPlatformError, createTursoPlatformClient } from '../db/turso-platform.js';
import {
  RehearsalError,
  REHEARSAL_RPO_TARGET_MS,
  REHEARSAL_RTO_TARGET_MS,
  verifyRehearsalAttestation,
} from './turso-backup-restore-rehearsal.mjs';

export const REMOTE_MIGRATION_FORMAT='randori.turso-production-migration.v2';

const REHEARSAL_WORKFLOW_PATH='.github/workflows/turso-backup-restore-rehearsal.yml';
const REHEARSAL_ENVIRONMENT='turso-migration-rehearsal';
const MIGRATION_WORKFLOW_PATH='.github/workflows/turso-production-migration.yml';
const MIGRATION_ENVIRONMENT='turso-production-migration';
const DEFAULT_BRANCH='main';
const STATUS_CONFIRMATION='INSPECT_PRODUCTION_DATABASE';
const MUTATION_CONFIRMATION='MIGRATE_PRODUCTION_DATABASE';
const OPERATIONS=new Set(['status','adopt','apply']);
const NAME=/^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;
const COMMIT=/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/;
const FINGERPRINT=/^[a-f0-9]{64}$/;
const REPOSITORY=/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const PUBLIC_MESSAGES=Object.freeze({
  REMOTE_MIGRATION_INVALID:'Protected remote migration configuration is invalid.',
  REMOTE_MIGRATION_DISABLED:'Production migration is disabled by protected configuration.',
  REMOTE_MIGRATION_EVIDENCE_INVALID:'The protected rehearsal evidence is invalid.',
  REMOTE_MIGRATION_TARGET_IDENTITY_MISMATCH:'The production database identity or provider state did not match protected configuration.',
  REMOTE_MIGRATION_TARGET_STATE_MISMATCH:'The production migration state did not match the rehearsal contract.',
  REMOTE_MIGRATION_TARGET_VERSION_MISMATCH:'The requested migration is not the single next version.',
  REMOTE_MIGRATION_DATABASE_TIMEOUT:'A production database operation timed out.',
  REMOTE_MIGRATION_PLATFORM_FAILED:'A protected provider operation failed.',
  REMOTE_MIGRATION_FAILED:'The protected remote migration failed.',
});

export class RemoteMigrationError extends Error{
  constructor(code,message,{cause}={}){
    super(message,cause?{cause}:undefined);
    this.name='RemoteMigrationError';
    this.code=code;
  }
}

function fail(code,message,cause){ throw new RemoteMigrationError(code,message,{cause}); }

function integer(value,label,{minimum=1,maximum=Number.MAX_SAFE_INTEGER}={}){
  const number=typeof value==='string'&&/^[1-9][0-9]*$/.test(value)?Number(value):value;
  if(!Number.isSafeInteger(number)||number<minimum||number>maximum){
    fail('REMOTE_MIGRATION_INVALID',`${label} is invalid`);
  }
  return number;
}

function fixedObjective(value,label,expected){
  const parsed=integer(value,label,{maximum:90*24*60*60*1000});
  if(parsed!==expected) fail('REMOTE_MIGRATION_INVALID',`${label} must match the fixed recovery objective`);
  return parsed;
}

function opaque(value,label,{maximum=512,pattern}={}){
  if(typeof value!=='string'||value.length===0||value!==value.trim()
    ||Buffer.byteLength(value,'utf8')>maximum||/[\u0000-\u001f\u007f]/u.test(value)
    ||pattern&&!pattern.test(value)){
    fail('REMOTE_MIGRATION_INVALID',`${label} is invalid`);
  }
  return value;
}

function exactBoolean(value,label){
  if(value==='true'||value===true) return true;
  if(value==='false'||value===false) return false;
  fail('REMOTE_MIGRATION_INVALID',`${label} is invalid`);
}

function freeze(value){
  if(Array.isArray(value)) return Object.freeze(value.map(freeze));
  if(value&&typeof value==='object'){
    return Object.freeze(Object.fromEntries(
      Object.entries(value).map(([key,item])=>[key,freeze(item)]),
    ));
  }
  return value;
}

function normalizeOptions(value){
  if(!value||typeof value!=='object'||Array.isArray(value)){
    fail('REMOTE_MIGRATION_INVALID','options are invalid');
  }
  const operation=opaque(value.operation,'operation',{maximum:16,pattern:/^[a-z]+$/});
  if(!OPERATIONS.has(operation)) fail('REMOTE_MIGRATION_INVALID','operation is invalid');
  const expectedConfirmation=operation==='status'?STATUS_CONFIRMATION:MUTATION_CONFIRMATION;
  if(value.confirmation!==expectedConfirmation){
    fail('REMOTE_MIGRATION_INVALID','manual confirmation is invalid');
  }
  const expectedStateFingerprint=value.expectedStateFingerprint??'';
  const rawTargetVersion=value.targetVersion??'';
  let targetVersion=null;
  if(operation==='status'){
    if(expectedStateFingerprint!==''||rawTargetVersion!==''){
      fail('REMOTE_MIGRATION_INVALID','status must not include mutation inputs');
    }
  }else{
    if(!FINGERPRINT.test(expectedStateFingerprint)){
      fail('REMOTE_MIGRATION_INVALID','mutation state fingerprint is invalid');
    }
    if(value.mutationsEnabled!=='true'&&value.mutationsEnabled!==true){
      fail('REMOTE_MIGRATION_DISABLED','production mutation is disabled');
    }
    if(operation==='apply'){
      targetVersion=integer(rawTargetVersion,'target version',{maximum:LATEST_MIGRATION_VERSION});
    }else if(rawTargetVersion!==''){
      fail('REMOTE_MIGRATION_INVALID','adopt must not include a target version');
    }
  }
  const repository=opaque(value.repository,'repository',{
    maximum:200,pattern:REPOSITORY,
  });
  const repoCommit=opaque(value.repoCommit,'repository commit',{maximum:64,pattern:COMMIT});
  const source=Object.freeze({
    id:opaque(value.sourceDatabaseId,'source database ID'),
    name:opaque(value.sourceDatabaseName,'source database name',{maximum:64,pattern:NAME}),
    group:opaque(value.sourceGroup,'source database group',{maximum:64,pattern:NAME}),
    blockWrites:exactBoolean(value.expectedSourceBlockWrites,'expected block_writes'),
  });
  return Object.freeze({
    operation,
    expectedStateFingerprint,
    targetVersion,
    source,
    repository,
    repositoryId:integer(value.repositoryId,'repository ID'),
    repoCommit,
    runId:integer(value.runId,'rehearsal run ID'),
    runAttempt:integer(value.runAttempt,'rehearsal run attempt',{maximum:1_000_000}),
    maxAttestationAgeMs:integer(value.maxAttestationAgeMs,'attestation maximum age',{
      maximum:30*60*1000,
    }),
    rpoTargetMs:fixedObjective(value.rpoTargetMs,'RPO target',REHEARSAL_RPO_TARGET_MS),
    rtoTargetMs:fixedObjective(value.rtoTargetMs,'RTO target',REHEARSAL_RTO_TARGET_MS),
    databaseTimeoutMs:integer(value.databaseTimeoutMs??30_000,'database timeout',{
      maximum:120_000,
    }),
    hmacKey:value.hmacKey,
    clock:typeof value.clock==='function'?value.clock:Date.now,
  });
}

function normalizeError(error){
  if(error instanceof RemoteMigrationError) return error;
  if(error instanceof GitHubActionsError||error instanceof RehearsalError){
    return new RemoteMigrationError(
      'REMOTE_MIGRATION_EVIDENCE_INVALID','rehearsal evidence failed validation',{cause:error},
    );
  }
  if(error instanceof TursoPlatformError){
    return new RemoteMigrationError(
      'REMOTE_MIGRATION_PLATFORM_FAILED','provider operation failed',{cause:error},
    );
  }
  return error;
}

export function publicRemoteMigrationError(error,{operation='unknown',repoCommit=null}={}){
  if(error instanceof MigrationError){
    const migration=publicMigrationError(error);
    return freeze({
      ok:false,kind:'turso-production-migration',format:REMOTE_MIGRATION_FORMAT,
      operation,error:migration.error,message:migration.message,
      ...(migration.details?{details:migration.details}:{}),
      ...(typeof repoCommit==='string'&&COMMIT.test(repoCommit)?{repoCommit}:{}),
    });
  }
  const normalized=normalizeError(error);
  const code=normalized instanceof RemoteMigrationError&&PUBLIC_MESSAGES[normalized.code]
    ?normalized.code:'REMOTE_MIGRATION_FAILED';
  return freeze({
    ok:false,kind:'turso-production-migration',format:REMOTE_MIGRATION_FORMAT,
    operation,error:code,message:PUBLIC_MESSAGES[code],
    ...(typeof repoCommit==='string'&&COMMIT.test(repoCommit)?{repoCommit}:{}),
  });
}

function hostnameUrl(hostname){
  if(typeof hostname!=='string'||hostname.length>253||hostname!==hostname.toLowerCase()
    ||hostname.endsWith('.')||!hostname.includes('.')
    ||hostname.split('.').some(label=>!NAME.test(label))){
    fail('REMOTE_MIGRATION_TARGET_IDENTITY_MISMATCH','database hostname is invalid');
  }
  return `libsql://${hostname}`;
}

async function exactTarget(platform,source){
  let database;
  let configuration;
  try{
    [database,configuration]=await Promise.all([
      platform.getDatabase(source.name),
      platform.getDatabaseConfiguration(source.name),
    ]);
  }catch(error){ throw normalizeError(error); }
  if(database?.id!==source.id||database?.name!==source.name||database?.group!==source.group
    ||database?.parent!==null||database?.blockWrites!==source.blockWrites
    ||configuration?.blockWrites!==source.blockWrites){
    fail('REMOTE_MIGRATION_TARGET_IDENTITY_MISMATCH','target identity mismatch');
  }
  return database;
}

function readonlySql(statement){
  const sql=typeof statement==='string'?statement:statement?.sql;
  if(typeof sql!=='string') return false;
  const normalized=sql.trim().replace(/;\s*$/,'').trim();
  if(normalized.includes(';')) return false;
  if(/^SELECT\b/i.test(normalized)) return true;
  return /^PRAGMA\s+(?:integrity_check\(1\)|foreign_keys|ignore_check_constraints|(?:table_info|table_xinfo|foreign_key_list|index_list|index_info|index_xinfo)\(\s*"[A-Za-z_][A-Za-z0-9_]*"\s*\))$/i.test(normalized);
}

function readonlyClient(client){
  return Object.freeze({
    execute(statement){
      if(!readonlySql(statement)){
        fail('REMOTE_MIGRATION_FAILED','read-only status attempted a write');
      }
      return client.execute(statement);
    },
    close(){ return client.close?.(); },
  });
}

function timeoutError(){
  return new RemoteMigrationError(
    'REMOTE_MIGRATION_DATABASE_TIMEOUT','database operation timed out',
  );
}

async function withTimeout(operation,timeoutMs){
  let timer;
  try{
    return await Promise.race([
      Promise.resolve().then(operation),
      new Promise((_resolve,reject)=>{ timer=setTimeout(()=>reject(timeoutError()),timeoutMs); }),
    ]);
  }finally{ clearTimeout(timer); }
}

function timedTransaction(transaction,timeoutMs){
  return new Proxy(transaction,{
    get(target,property){
      if(['execute','batch','commit','rollback'].includes(property)
        &&typeof target[property]==='function'){
        return (...args)=>withTimeout(()=>target[property](...args),timeoutMs);
      }
      const item=target[property];
      return typeof item==='function'?item.bind(target):item;
    },
  });
}

function timedClient(client,timeoutMs){
  return Object.freeze({
    execute:(...args)=>withTimeout(()=>client.execute(...args),timeoutMs),
    batch:(...args)=>withTimeout(()=>client.batch(...args),timeoutMs),
    async transaction(...args){
      return timedTransaction(
        await withTimeout(()=>client.transaction(...args),timeoutMs),timeoutMs,
      );
    },
    close(){
      return typeof client.close==='function'
        ?withTimeout(()=>client.close(),Math.min(timeoutMs,2_000)):undefined;
    },
  });
}

async function closeQuietly(client){
  try{ await client?.close?.(); }catch{}
}

async function inspectBoundState(db,attestation){
  const sourceVersion=attestation.migration.sourceVersion;
  const sourceClassification=attestation.migration.sourceClassification;
  const sourceStateFingerprint=attestation.migration.sourceStateFingerprint;
  const sourceMigrations=EXECUTABLE_MIGRATIONS.slice(0,sourceVersion);
  const full=await inspectMigrationState(db,{migrations:EXECUTABLE_MIGRATIONS});
  if(full.classification==='managed'){
    if(sourceClassification!=='managed'||!full.ready||full.currentVersion!==sourceVersion){
      fail('REMOTE_MIGRATION_TARGET_STATE_MISMATCH','managed target state is invalid');
    }
    const sourceState=sourceVersion===LATEST_MIGRATION_VERSION
      ?full:await inspectMigrationState(db,{migrations:sourceMigrations});
    if(sourceState.classification!=='managed'||!sourceState.ready
      ||sourceState.currentVersion!==sourceVersion
      ||sourceState.stateFingerprint!==sourceStateFingerprint){
      fail('REMOTE_MIGRATION_TARGET_STATE_MISMATCH','managed target state does not match rehearsal');
    }
    return Object.freeze({
      classification:'managed',version:full.currentVersion,state:full,sourceState,
      migrations:EXECUTABLE_MIGRATIONS,
    });
  }
  if(full.classification!=='unmanaged'
    ||sourceClassification!=='unmanaged'){
    fail('REMOTE_MIGRATION_TARGET_STATE_MISMATCH','target classification is invalid');
  }
  const historical=await inspectMigrationState(db,{migrations:sourceMigrations});
  if(historical.classification!=='unmanaged'||historical.ledgerPresent
    ||!historical.schemaExact||historical.adoption?.eligible!==true
    ||historical.stateFingerprint!==sourceStateFingerprint){
    fail('REMOTE_MIGRATION_TARGET_STATE_MISMATCH','unmanaged target state is invalid');
  }
  return Object.freeze({
    classification:'unmanaged',version:sourceVersion,state:historical,sourceState:historical,
    migrations:sourceMigrations,
  });
}

async function statusResult(db,bound,options,attestation,attestationDigest){
  const pendingVersions=Array.from(
    {length:Math.max(0,LATEST_MIGRATION_VERSION-bound.version)},
    (_value,index)=>bound.version+index+1,
  );
  const nextVersion=bound.classification==='managed'?(pendingVersions[0]??null):null;
  const authorizationState=nextVersion===null?bound.sourceState:await inspectMigrationState(db,{
    migrations:EXECUTABLE_MIGRATIONS.slice(0,nextVersion),
  });
  if(bound.classification==='managed'
    &&(authorizationState.classification!=='managed'
      ||authorizationState.currentVersion!==bound.version||!authorizationState.ready)){
    fail('REMOTE_MIGRATION_TARGET_STATE_MISMATCH','next migration state is invalid');
  }
  return freeze({
    ok:true,
    kind:'turso-production-migration',
    format:REMOTE_MIGRATION_FORMAT,
    operation:'status',
    readOnly:true,
    repoCommit:options.repoCommit,
    target:{kind:'turso-base-database',identityVerified:true,writeStateVerified:true},
    evidence:{
      rehearsalRunId:options.runId,
      rehearsalRunAttempt:options.runAttempt,
      attestationDigest,
      issuedAt:attestation.issuedAt,
      validUntil:attestation.validUntil,
    },
    state:bound.classification,
    currentVersion:bound.version,
    latestVersion:LATEST_MIGRATION_VERSION,
    stateFingerprint:authorizationState.stateFingerprint,
    pendingVersions,
    nextVersion,
    capabilities:{
      adopt:bound.classification==='unmanaged',
      apply:nextVersion!==null,
    },
  });
}

function mutationResult(operation,before,result,options,attestation,attestationDigest){
  const versions=operation==='adopt'
    ?result.adopted.map(item=>item.version):result.applied.map(item=>item.version);
  return freeze({
    ok:true,
    kind:'turso-production-migration',
    format:REMOTE_MIGRATION_FORMAT,
    operation,
    readOnly:false,
    result:versions.length===0?'noop':operation==='adopt'?'adopted':'applied',
    repoCommit:options.repoCommit,
    target:{kind:'turso-base-database',identityVerified:true,writeStateVerified:true},
    evidence:{
      rehearsalRunId:options.runId,
      rehearsalRunAttempt:options.runAttempt,
      attestationDigest,
      issuedAt:attestation.issuedAt,
      validUntil:attestation.validUntil,
    },
    stateBefore:before.classification,
    state:'managed',
    fromVersion:before.version,
    toVersion:result.toVersion,
    latestVersion:LATEST_MIGRATION_VERSION,
    ...(operation==='apply'?{targetVersion:options.targetVersion}:{}),
    ...(operation==='adopt'?{adoptedVersions:versions}:{appliedVersions:versions}),
    stateFingerprint:result.stateFingerprint,
  });
}

export async function runRemoteMigration(rawOptions={},dependencies={}){
  const options=normalizeOptions(rawOptions);
  const github=dependencies.github;
  const platform=dependencies.platform;
  if(!github||typeof github.downloadSuccessfulWorkflowArtifact!=='function'
    ||!platform||typeof platform.getDatabase!=='function'
    ||typeof platform.getDatabaseConfiguration!=='function'
    ||typeof platform.createDatabaseToken!=='function'){
    fail('REMOTE_MIGRATION_INVALID','required adapters are invalid');
  }
  const connectDatabase=dependencies.connectDatabase??createClient;
  const extractArtifact=dependencies.extractArtifact??extractSingleJsonArtifact;
  const verifyAttestation=dependencies.verifyAttestation??verifyRehearsalAttestation;
  if(typeof connectDatabase!=='function'){
    fail('REMOTE_MIGRATION_INVALID','database connector is invalid');
  }
  if(typeof extractArtifact!=='function'||typeof verifyAttestation!=='function'){
    fail('REMOTE_MIGRATION_INVALID','evidence verifier is invalid');
  }
  const artifactName=`turso-backup-restore-rehearsal-${options.runId}-${options.runAttempt}`;
  let downloaded;
  try{
    downloaded=await github.downloadSuccessfulWorkflowArtifact({
      repositoryId:options.repositoryId,
      runId:options.runId,
      runAttempt:options.runAttempt,
      defaultBranch:DEFAULT_BRANCH,
      workflowPath:REHEARSAL_WORKFLOW_PATH,
      headSha:options.repoCommit,
      artifactName,
    });
  }catch(error){ throw normalizeError(error); }
  let envelope;
  let attestation;
  try{
    envelope=extractArtifact(downloaded.archive,{
      filename:'rehearsal-summary.json',
    });
    const backupRef=`turso-pitr:${options.source.id}:${options.source.name}:${options.source.group}`;
    attestation=verifyAttestation(envelope,{
      repoCommit:options.repoCommit,
      context:{
        repository:options.repository,
        repositoryId:options.repositoryId,
        workflowPath:REHEARSAL_WORKFLOW_PATH,
        workflowRef:`${options.repository}/${REHEARSAL_WORKFLOW_PATH}@refs/heads/${DEFAULT_BRANCH}`,
        workflowSha:options.repoCommit,
        runId:options.runId,
        runAttempt:options.runAttempt,
        environment:REHEARSAL_ENVIRONMENT,
        repoCommit:options.repoCommit,
      },
      runConclusion:downloaded.run.conclusion,
      maxAgeMs:options.maxAttestationAgeMs,
      rpoTargetMs:options.rpoTargetMs,
      rtoTargetMs:options.rtoTargetMs,
      sourceIdentity:options.source.id,
      backupRef,
      hmacKey:options.hmacKey,
      clock:options.clock,
    });
  }catch(error){ throw normalizeError(error); }
  const attestationDigest=checksum(envelope);

  if(options.operation==='apply'){
    if(attestation.migration.sourceClassification!=='managed'
      ||options.targetVersion!==attestation.migration.sourceVersion+1){
      fail('REMOTE_MIGRATION_TARGET_VERSION_MISMATCH','target is not next after rehearsal source');
    }
  }

  // The authoritative base-database identity and protected write-state value are
  // checked before any database-scoped credential is requested.
  await exactTarget(platform,options.source);
  let databaseToken;
  try{
    databaseToken=await platform.createDatabaseToken(options.source.name,{
      expiration:'10m',
      authorization:options.operation==='status'?'read-only':'full-access',
    });
  }catch(error){ throw normalizeError(error); }
  const confirmedTarget=await exactTarget(platform,options.source);

  let rawClient;
  let db;
  try{
    rawClient=await connectDatabase({
      url:hostnameUrl(confirmedTarget.hostname),authToken:databaseToken,intMode:'bigint',
    });
    const timed=timedClient(rawClient,options.databaseTimeoutMs);
    db=options.operation==='status'?readonlyClient(timed):timed;
    const before=await inspectBoundState(db,attestation);
    if(options.operation==='status'){
      return await statusResult(db,before,options,attestation,attestationDigest);
    }
    await exactTarget(platform,options.source);
    let result;
    if(options.operation==='adopt'){
      if(before.classification!=='unmanaged'){
        fail('REMOTE_MIGRATION_TARGET_STATE_MISMATCH','only unmanaged state can be adopted');
      }
      if(before.state.stateFingerprint!==options.expectedStateFingerprint){
        throw new MigrationError('MIGRATION_STATE_CHANGED','Migration state fingerprint mismatch');
      }
      result=await adoptMigrations(db,{
        expectedStateFingerprint:options.expectedStateFingerprint,
        migrations:before.migrations,
        retry:{maxAttempts:3,baseDelayMs:40,maxDelayMs:200},
      });
    }else{
      if(before.classification!=='managed'){
        fail('REMOTE_MIGRATION_TARGET_STATE_MISMATCH','unmanaged state must be adopted first');
      }
      if(options.targetVersion!==before.version+1){
        fail('REMOTE_MIGRATION_TARGET_VERSION_MISMATCH','target is not the next managed version');
      }
      const migrations=EXECUTABLE_MIGRATIONS.slice(0,options.targetVersion);
      const authorizationState=await inspectMigrationState(db,{migrations});
      if(authorizationState.classification!=='managed'
        ||authorizationState.currentVersion!==before.version||!authorizationState.ready
        ||authorizationState.stateFingerprint!==options.expectedStateFingerprint){
        throw new MigrationError('MIGRATION_STATE_CHANGED','Migration state fingerprint mismatch');
      }
      result=await applyMigrations(db,{
        expectedStateFingerprint:options.expectedStateFingerprint,
        migrations,
        retry:{maxAttempts:3,baseDelayMs:40,maxDelayMs:200},
      });
    }
    await exactTarget(platform,options.source);
    return mutationResult(
      options.operation,before,result,options,attestation,attestationDigest,
    );
  }catch(error){ throw normalizeError(error); }
  finally{ await closeQuietly(db??rawClient); }
}

function parseArguments(argv){
  if(!Array.isArray(argv)||argv.length!==12){
    fail('REMOTE_MIGRATION_INVALID','usage is invalid');
  }
  const flags=new Map();
  for(let index=0;index<argv.length;index+=2){
    const flag=argv[index];
    if(![
      '--operation','--rehearsal-run-id','--rehearsal-run-attempt',
      '--expected-state','--target-version','--artifact-dir',
    ].includes(flag)||flags.has(flag)||typeof argv[index+1]!=='string'){
      fail('REMOTE_MIGRATION_INVALID','usage is invalid');
    }
    flags.set(flag,argv[index+1]);
  }
  if(!flags.get('--operation')||!flags.get('--rehearsal-run-id')
    ||!flags.get('--rehearsal-run-attempt')||!flags.get('--artifact-dir')){
    fail('REMOTE_MIGRATION_INVALID','usage is invalid');
  }
  return Object.freeze({
    operation:flags.get('--operation'),
    runId:flags.get('--rehearsal-run-id'),
    runAttempt:flags.get('--rehearsal-run-attempt'),
    expectedStateFingerprint:flags.get('--expected-state'),
    targetVersion:flags.get('--target-version'),
    artifactDirectory:flags.get('--artifact-dir'),
  });
}

async function artifactDirectory(path,runnerTemp){
  if(!isAbsolute(path)||!isAbsolute(runnerTemp)){
    fail('REMOTE_MIGRATION_INVALID','runner paths must be absolute');
  }
  const lexicalRoot=resolve(runnerTemp);
  const root=await realpath(runnerTemp);
  const child=relative(lexicalRoot,resolve(path));
  if(!child||child.startsWith('..')||isAbsolute(child)){
    fail('REMOTE_MIGRATION_INVALID','artifact directory must be inside RUNNER_TEMP');
  }
  const target=resolve(root,child);
  if(resolve(target,'..')!==root||basename(target)!=='public-artifacts'){
    fail('REMOTE_MIGRATION_INVALID','artifact directory name is invalid');
  }
  await mkdir(target,{mode:0o700});
  const actual=await realpath(target);
  const actualChild=relative(root,actual);
  if(!actualChild||actualChild.startsWith('..')||isAbsolute(actualChild)){
    fail('REMOTE_MIGRATION_INVALID','artifact directory escaped RUNNER_TEMP');
  }
  return actual;
}

async function writeExclusiveResult(path,result){
  const filename=basename(path);
  if(filename!=='migration-result.json'){
    fail('REMOTE_MIGRATION_INVALID','artifact filename is invalid');
  }
  let handle;
  try{
    handle=await open(
      path,constants.O_CREAT|constants.O_EXCL|constants.O_WRONLY|(constants.O_NOFOLLOW||0),0o600,
    );
    await handle.writeFile(`${JSON.stringify(result)}\n`,{encoding:'utf8'});
  }finally{ await handle?.close(); }
  const metadata=await lstat(path);
  if(!metadata.isFile()||metadata.isSymbolicLink()||(metadata.mode&0o077)!==0){
    fail('REMOTE_MIGRATION_INVALID','artifact file is invalid');
  }
}

function environmentOptions(environment,parsed){
  return {
    ...parsed,
    confirmation:environment.PRODUCTION_MIGRATION_CONFIRM,
    mutationsEnabled:environment.TURSO_PRODUCTION_MIGRATIONS_ENABLED,
    sourceDatabaseId:environment.TURSO_PRODUCTION_DATABASE_ID,
    sourceDatabaseName:environment.TURSO_PRODUCTION_DATABASE_NAME,
    sourceGroup:environment.TURSO_GROUP,
    expectedSourceBlockWrites:environment.TURSO_PRODUCTION_EXPECTED_BLOCK_WRITES,
    repository:environment.GITHUB_REPOSITORY,
    repositoryId:environment.GITHUB_REPOSITORY_ID,
    repoCommit:environment.MIGRATION_REPO_COMMIT,
    maxAttestationAgeMs:environment.MIGRATION_REHEARSAL_MAX_AGE_MS,
    rpoTargetMs:environment.REHEARSAL_RPO_TARGET_MS,
    rtoTargetMs:environment.REHEARSAL_RTO_TARGET_MS,
    databaseTimeoutMs:environment.TURSO_DATABASE_TIMEOUT_MS,
    hmacKey:environment.MIGRATION_DIGEST_HMAC_KEY,
  };
}

export function validateWorkflowRuntime(environment,repoCommit){
  const repository=opaque(environment.GITHUB_REPOSITORY,'repository',{
    maximum:200,pattern:REPOSITORY,
  });
  if(environment.GITHUB_ACTIONS!=='true'||environment.GITHUB_EVENT_NAME!=='workflow_dispatch'
    ||environment.GITHUB_REF!==`refs/heads/${DEFAULT_BRANCH}`
    ||environment.GITHUB_WORKFLOW_REF
      !==`${repository}/${MIGRATION_WORKFLOW_PATH}@refs/heads/${DEFAULT_BRANCH}`
    ||environment.GITHUB_WORKFLOW_SHA!==repoCommit
    ||environment.MIGRATION_GITHUB_ENVIRONMENT!==MIGRATION_ENVIRONMENT){
    fail('REMOTE_MIGRATION_INVALID','workflow runtime identity is invalid');
  }
  integer(environment.GITHUB_RUN_ID,'migration workflow run ID');
  integer(environment.GITHUB_RUN_ATTEMPT,'migration workflow run attempt',{maximum:1_000_000});
  return true;
}

export async function main({
  argv=process.argv.slice(2),
  environment=process.env,
  stdout=process.stdout,
  createGitHub=createGitHubActionsClient,
  createPlatform=createTursoPlatformClient,
  run=runRemoteMigration,
  connectDatabase=createClient,
}={}){
  let result;
  let operation='unknown';
  let repoCommit=null;
  let outputDirectory=null;
  try{
    const parsed=parseArguments(argv);
    operation=parsed.operation;
    repoCommit=environment.MIGRATION_REPO_COMMIT;
    outputDirectory=await artifactDirectory(
      parsed.artifactDirectory,
      opaque(environment.RUNNER_TEMP,'RUNNER_TEMP',{maximum:4096}),
    );
    if(parsed.operation!=='status'
      &&environment.TURSO_PRODUCTION_MIGRATIONS_ENABLED!=='true'){
      fail('REMOTE_MIGRATION_DISABLED','production mutation is disabled');
    }
    validateWorkflowRuntime(environment,repoCommit);
    const options=environmentOptions(environment,parsed);
    const github=createGitHub({
      repository:environment.GITHUB_REPOSITORY,
      token:environment.GITHUB_TOKEN,
      timeoutMs:integer(environment.GITHUB_API_TIMEOUT_MS,'GitHub API timeout',{
        maximum:60_000,
      }),
    });
    const platform=createPlatform({
      organization:environment.TURSO_ORGANIZATION,
      token:environment.TURSO_PRODUCTION_PLATFORM_TOKEN,
      timeoutMs:integer(environment.TURSO_PLATFORM_TIMEOUT_MS,'platform timeout',{
        maximum:60_000,
      }),
    });
    result=await run(options,{github,platform,connectDatabase});
  }catch(error){ result=publicRemoteMigrationError(error,{operation,repoCommit}); }
  if(outputDirectory){
    try{ await writeExclusiveResult(resolve(outputDirectory,'migration-result.json'),result); }
    catch(error){ result=publicRemoteMigrationError(error,{operation,repoCommit}); }
  }
  stdout.write(`${JSON.stringify(result)}\n`);
  const refusal=result.ok!==true&&(
    result.error?.startsWith?.('MIGRATION_')
    ||[
      'REMOTE_MIGRATION_DISABLED','REMOTE_MIGRATION_EVIDENCE_INVALID',
      'REMOTE_MIGRATION_TARGET_IDENTITY_MISMATCH','REMOTE_MIGRATION_TARGET_STATE_MISMATCH',
      'REMOTE_MIGRATION_TARGET_VERSION_MISMATCH',
    ].includes(result.error)
  );
  return {result,exitCode:result.ok?0:refusal?2:1};
}

const isEntryPoint=process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url);
if(isEntryPoint){
  const execution=await main();
  process.exitCode=execution.exitCode;
}
