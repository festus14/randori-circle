#!/usr/bin/env node
import { constants } from 'node:fs';
import { lstat, mkdir, open, realpath, rename, unlink } from 'node:fs/promises';
import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { basename, dirname, isAbsolute, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createClient } from '@libsql/client';

import {
  BackupEvidenceError,
  collectDatabaseEvidence,
  compareBackupRestoreEvidence,
} from '../db/backup-evidence.js';
import { EXECUTABLE_MIGRATIONS, LATEST_MIGRATION_VERSION } from '../db/executable-migrations.js';
import {
  MigrationError,
  adoptMigrations,
  applyMigrations,
  inspectMigrationState,
} from '../db/migration-runner.js';
import { SCHEMA_MANIFEST, checksum, stableJson } from '../db/schema-manifest.js';
import {
  TursoPlatformError,
  createTursoPlatformClient,
} from '../db/turso-platform.js';

export const REHEARSAL_FORMAT='randori.turso-backup-restore-rehearsal.v1';
export const REHEARSAL_JOURNAL_FORMAT='randori.turso-backup-restore-journal.v1';
export const REHEARSAL_ATTESTATION_FORMAT='randori.turso-rehearsal-attestation.v1';

const REHEARSAL_WORKFLOW_PATH='.github/workflows/turso-backup-restore-rehearsal.yml';
const REHEARSAL_ENVIRONMENT='turso-migration-rehearsal';
const ATTESTATION_KEY_DOMAIN='randori:turso-rehearsal-attestation:v1:key';
const ATTESTATION_SIGNATURE_DOMAIN='randori:turso-rehearsal-attestation:v1:payload';
const MAX_ATTESTATION_AGE_MS=30*60*1000;

const PUBLIC_MESSAGES=Object.freeze({
  REHEARSAL_INVALID:'Backup/restore rehearsal configuration is invalid.',
  REHEARSAL_SOURCE_IDENTITY_MISMATCH:'The production source database identity did not match the protected configuration.',
  REHEARSAL_SOURCE_WRITE_BLOCK_FAILED:'The production source write block could not be confirmed.',
  REHEARSAL_SOURCE_WRITE_STATE_RECOVERY_REQUIRED:'The production source write state requires operator recovery.',
  REHEARSAL_RESTORE_IDENTITY_MISMATCH:'The disposable restore identity or parent binding did not match.',
  REHEARSAL_RESTORE_NOT_READY:'The disposable restore did not become ready in time.',
  REHEARSAL_RESTORE_CLEANUP_REQUIRED:'The disposable restore requires operator cleanup.',
  REHEARSAL_MIGRATION_STATE_INVALID:'The source migration state is not an exact supported version.',
  REHEARSAL_MIGRATION_FAILED:'The disposable restore migration failed.',
  REHEARSAL_EVIDENCE_FAILED:'Backup/restore evidence verification failed.',
  REHEARSAL_PRESERVATION_FAILED:'Post-migration data preservation verification failed.',
  REHEARSAL_DATABASE_TIMEOUT:'A database operation timed out.',
  REHEARSAL_PLATFORM_FAILED:'A Turso Platform API operation failed.',
  REHEARSAL_RECOVERY_STATE_FAILED:'Private recovery state could not be recorded.',
  REHEARSAL_ATTESTATION_INVALID:'The backup/restore rehearsal attestation is invalid.',
  REHEARSAL_FAILED:'The backup/restore rehearsal failed.',
});

const PHASES=new Set([
  'configuration','source_identity','write_block','source_evidence','restore_create',
  'restore_ready','restore_evidence','restore_migration','post_migration_evidence',
  'restore_cleanup','write_state_restore','complete',
]);
const NAME=/^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;
const COMMIT=/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/;
const CONFIRMATION='RESTORE_DISPOSABLE_ONLY';
const FAST_MIGRATION_RETRY=Object.freeze({maxAttempts:3,baseDelayMs:40,maxDelayMs:200});

export class RehearsalError extends Error{
  constructor(code,message,{cause,phase='configuration'}={}){
    super(message,cause?{cause}:undefined);
    this.name='RehearsalError';
    this.code=code;
    this.phase=PHASES.has(phase)?phase:'configuration';
  }
}

function fail(code,message,phase){ throw new RehearsalError(code,message,{phase}); }

function integer(value,name,{minimum=1,maximum=Number.MAX_SAFE_INTEGER}={}){
  const number=typeof value==='string'&&/^[1-9][0-9]*$/.test(value)?Number(value):value;
  if(!Number.isSafeInteger(number)||number<minimum||number>maximum){
    fail('REHEARSAL_INVALID',`${name} is invalid`,'configuration');
  }
  return number;
}

function name(value,label){
  if(typeof value!=='string'||value.length>64||!NAME.test(value)){
    fail('REHEARSAL_INVALID',`${label} is invalid`,'configuration');
  }
  return value;
}

function opaque(value,label,{maximum=512}={}){
  if(typeof value!=='string'||value.length===0||value!==value.trim()
    ||Buffer.byteLength(value,'utf8')>maximum||/[\u0000-\u001f\u007f]/u.test(value)){
    fail('REHEARSAL_INVALID',`${label} is invalid`,'configuration');
  }
  return value;
}

function commit(value){
  if(typeof value!=='string'||!COMMIT.test(value)){
    fail('REHEARSAL_INVALID','repository commit is invalid','configuration');
  }
  return value;
}

function hmacKey(value){
  const key=typeof value==='string'?Buffer.from(value,'utf8')
    :value instanceof Uint8Array?Buffer.from(value):null;
  if(!key||key.byteLength<32||key.byteLength>4096){
    key?.fill(0);
    fail('REHEARSAL_INVALID','evidence HMAC key is invalid','configuration');
  }
  return key;
}

function exactBoolean(value,name){
  if(typeof value!=='boolean') fail('REHEARSAL_INVALID',`${name} is invalid`,'configuration');
  return value;
}

function milliseconds(clock){
  let value;
  try{ value=clock(); }catch(error){
    throw new RehearsalError('REHEARSAL_FAILED','clock failed',{cause:error,phase:'configuration'});
  }
  const result=value instanceof Date?value.getTime():Number(value);
  if(!Number.isSafeInteger(result)||result<0){
    fail('REHEARSAL_INVALID','clock returned an invalid value','configuration');
  }
  return result;
}

function timestamp(clock){ return new Date(milliseconds(clock)).toISOString(); }
function pitrTimestamp(clock){
  return new Date(Math.floor(milliseconds(clock)/1000)*1000).toISOString();
}

function exactTimestamp(value,label){
  if(typeof value!=='string') fail('REHEARSAL_INVALID',`${label} is invalid`,'configuration');
  const parsed=Date.parse(value);
  if(!Number.isFinite(parsed)||new Date(parsed).toISOString()!==value){
    fail('REHEARSAL_INVALID',`${label} is invalid`,'configuration');
  }
  return value;
}

function hostnameUrl(hostname){
  if(typeof hostname!=='string'||hostname.length>253||hostname!==hostname.toLowerCase()
    ||hostname.endsWith('.')||!hostname.includes('.')
    ||hostname.split('.').some(label=>!NAME.test(label))){
    fail('REHEARSAL_RESTORE_IDENTITY_MISMATCH','database hostname is invalid','restore_ready');
  }
  return `libsql://${hostname}`;
}

function normalizeError(error,phase){
  if(error instanceof RehearsalError) return error;
  if(error instanceof BackupEvidenceError){
    return new RehearsalError('REHEARSAL_EVIDENCE_FAILED','evidence operation failed',{cause:error,phase});
  }
  if(error instanceof MigrationError){
    return new RehearsalError('REHEARSAL_MIGRATION_FAILED','migration operation failed',{cause:error,phase});
  }
  if(error instanceof TursoPlatformError){
    return new RehearsalError('REHEARSAL_PLATFORM_FAILED','platform operation failed',{cause:error,phase});
  }
  return new RehearsalError('REHEARSAL_FAILED','rehearsal operation failed',{cause:error,phase});
}

function publicSafety(state){
  return Object.freeze({
    sourceIdentityVerified:state.sourceIdentityVerified===true,
    writesBlockedBeforePitr:state.writesBlockedBeforePitr===true,
    sourceWriteStateRestored:state.sourceWriteStateRestored===true,
    restoreIdentityVerified:state.restoreIdentityVerified===true,
    restoreDeleted:state.restoreDeleted===true,
    sourceMigrated:false,
    sourceDeleted:false,
    credentialsInvalidated:false,
  });
}

export function publicRehearsalError(error,{repoCommit=null,safety={}}={}){
  const normalized=normalizeError(error,error?.phase||'configuration');
  const code=PUBLIC_MESSAGES[normalized.code]?normalized.code:'REHEARSAL_FAILED';
  const observedSafety=error?.safety??safety;
  return Object.freeze({
    ok:false,
    kind:'turso-backup-restore-rehearsal',
    format:REHEARSAL_FORMAT,
    error:code,
    message:PUBLIC_MESSAGES[code],
    phase:PHASES.has(normalized.phase)?normalized.phase:'configuration',
    ...(typeof repoCommit==='string'&&COMMIT.test(repoCommit)?{repoCommit}:{}),
    safety:publicSafety(observedSafety),
  });
}

function withSafety(error,safety){
  Object.defineProperty(error,'safety',{value:publicSafety(safety),enumerable:false});
  return error;
}

function attestationFailure(cause){
  throw new RehearsalError(
    'REHEARSAL_ATTESTATION_INVALID','rehearsal attestation is invalid',
    {cause,phase:'complete'},
  );
}

function exactObjectKeys(value,keys){
  return value!==null&&typeof value==='object'&&!Array.isArray(value)
    &&JSON.stringify(Object.keys(value).sort())===JSON.stringify([...keys].sort());
}

function digest(value){ return typeof value==='string'&&/^[a-f0-9]{64}$/.test(value); }

function equalDigest(left,right){
  return digest(left)&&digest(right)
    &&timingSafeEqual(Buffer.from(left,'hex'),Buffer.from(right,'hex'));
}

function canonicalAttestationTimestamp(value){
  if(typeof value!=='string') attestationFailure();
  const parsed=Date.parse(value);
  if(!Number.isFinite(parsed)||new Date(parsed).toISOString()!==value) attestationFailure();
  return parsed;
}

function executableMigrationsChecksum(migrations=EXECUTABLE_MIGRATIONS){
  return checksum(migrations.map(migration=>({
    version:migration.version,checksum:migration.checksum,
  })));
}

function normalizedAttestationContext(value,repoCommit){
  if(!value||typeof value!=='object'||Array.isArray(value)){
    fail('REHEARSAL_INVALID','GitHub attestation context is invalid','configuration');
  }
  const repository=opaque(value.repository,'GitHub repository',{maximum:200});
  if(!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)){
    fail('REHEARSAL_INVALID','GitHub repository is invalid','configuration');
  }
  const repositoryId=integer(value.repositoryId,'GitHub repository ID');
  const workflowPath=opaque(value.workflowPath,'GitHub workflow path',{maximum:256});
  if(workflowPath!==REHEARSAL_WORKFLOW_PATH){
    fail('REHEARSAL_INVALID','GitHub workflow path is invalid','configuration');
  }
  const workflowRef=opaque(value.workflowRef,'GitHub workflow ref',{maximum:512});
  if(workflowRef!==`${repository}/${workflowPath}@refs/heads/main`){
    fail('REHEARSAL_INVALID','GitHub workflow ref is invalid','configuration');
  }
  const workflowSha=commit(value.workflowSha);
  if(workflowSha!==repoCommit){
    fail('REHEARSAL_INVALID','GitHub workflow commit is invalid','configuration');
  }
  const runId=integer(value.runId,'GitHub run ID');
  const runAttempt=integer(value.runAttempt,'GitHub run attempt',{maximum:1_000_000});
  const environment=opaque(value.environment,'GitHub environment',{maximum:128});
  if(environment!==REHEARSAL_ENVIRONMENT){
    fail('REHEARSAL_INVALID','GitHub environment is invalid','configuration');
  }
  return Object.freeze({
    repository,repositoryId,workflowPath,workflowRef,workflowSha,runId,runAttempt,
    environment,repoCommit,
  });
}

function attestationSignature(payload,keyValue){
  const key=hmacKey(keyValue);
  let signingKey;
  try{
    signingKey=createHmac('sha256',key).update(ATTESTATION_KEY_DOMAIN,'utf8').digest();
    return createHmac('sha256',signingKey)
      .update(ATTESTATION_SIGNATURE_DOMAIN,'utf8').update('\0','utf8')
      .update(stableJson({format:REHEARSAL_ATTESTATION_FORMAT,payload}),'utf8')
      .digest('hex');
  }finally{
    key.fill(0);
    signingKey?.fill(0);
  }
}

function evidenceKeyedDigest(keyValue,label,value){
  const key=hmacKey(keyValue);
  let derived;
  try{
    derived=createHmac('sha256',key)
      .update(`randori-backup-evidence-key:v1:${label}`,'utf8').digest();
    return createHmac('sha256',derived).update(value,'utf8').digest('hex');
  }finally{
    key.fill(0);
    derived?.fill(0);
  }
}

function expectedAppliedVersions(sourceVersion){
  return EXECUTABLE_MIGRATIONS
    .filter(migration=>migration.version>sourceVersion)
    .map(migration=>migration.version);
}

function validateAttestationPayload(payload,expectedContext,now,maxAgeMs){
  if(!exactObjectKeys(payload,[
    'context','issuedAt','validUntil','schema','migration','identities','pitr','evidence',
    'verification','safety',
  ])||!exactObjectKeys(payload.context,[
    'repository','repositoryId','workflowPath','workflowRef','workflowSha','runId','runAttempt',
    'environment','repoCommit',
  ])||stableJson(payload.context)!==stableJson(expectedContext)) attestationFailure();

  const issuedAt=canonicalAttestationTimestamp(payload.issuedAt);
  const validUntil=canonicalAttestationTimestamp(payload.validUntil);
  if(issuedAt>now||validUntil<=now||validUntil<=issuedAt||validUntil-issuedAt>maxAgeMs){
    attestationFailure();
  }

  if(!exactObjectKeys(payload.schema,[
    'manifestVersion','manifestChecksum','sourceExecutableMigrationsChecksum',
    'finalExecutableMigrationsChecksum','latestMigrationVersion',
  ])||payload.schema.manifestVersion!==SCHEMA_MANIFEST.version
    ||payload.schema.manifestChecksum!==SCHEMA_MANIFEST.checksum
    ||payload.schema.latestMigrationVersion!==LATEST_MIGRATION_VERSION) attestationFailure();

  if(!exactObjectKeys(payload.migration,[
    'sourceClassification','sourceVersion','finalVersion','adoptedOnRestore','appliedVersions',
  ])||!['managed','unmanaged'].includes(payload.migration.sourceClassification)
    ||!Number.isSafeInteger(payload.migration.sourceVersion)
    ||payload.migration.sourceVersion<1
    ||payload.migration.sourceVersion>LATEST_MIGRATION_VERSION
    ||payload.migration.finalVersion!==LATEST_MIGRATION_VERSION
    ||payload.migration.adoptedOnRestore
      !==(payload.migration.sourceClassification==='unmanaged')
    ||!Array.isArray(payload.migration.appliedVersions)
    ||stableJson(payload.migration.appliedVersions)
      !==stableJson(expectedAppliedVersions(payload.migration.sourceVersion))) attestationFailure();
  const sourceExecutableChecksum=executableMigrationsChecksum(
    EXECUTABLE_MIGRATIONS.slice(0,payload.migration.sourceVersion),
  );
  if(payload.schema.sourceExecutableMigrationsChecksum!==sourceExecutableChecksum
    ||payload.schema.finalExecutableMigrationsChecksum
      !==executableMigrationsChecksum(EXECUTABLE_MIGRATIONS)) attestationFailure();

  if(!exactObjectKeys(payload.identities,[
    'sourceIdentityDigest','restoreIdentityDigest','backupRefDigest',
  ])||!digest(payload.identities.sourceIdentityDigest)
    ||!digest(payload.identities.restoreIdentityDigest)
    ||equalDigest(payload.identities.sourceIdentityDigest,payload.identities.restoreIdentityDigest)
    ||!digest(payload.identities.backupRefDigest)) attestationFailure();

  if(!exactObjectKeys(payload.pitr,['requestedAt','authoritativeAt'])) attestationFailure();
  canonicalAttestationTimestamp(payload.pitr.requestedAt);
  canonicalAttestationTimestamp(payload.pitr.authoritativeAt);
  if(payload.pitr.requestedAt!==payload.pitr.authoritativeAt) attestationFailure();

  if(!exactObjectKeys(payload.evidence,[
    'sourceEvidenceDigest','restoredEvidenceDigest','postMigrationEvidenceDigest',
    'comparisonDigest',
  ])||Object.values(payload.evidence).some(value=>!digest(value))) attestationFailure();

  const verification=payload.verification;
  if(!exactObjectKeys(verification,[
    'preMigrationMatch','postMigrationPreserved','rpoMet','rtoMet','rpoTargetMs',
    'rtoTargetMs','sourceSnapshotAgeMs','restoredSnapshotAgeMs','restoreDurationMs',
  ])||verification.preMigrationMatch!==true||verification.postMigrationPreserved!==true
    ||verification.rpoMet!==true||verification.rtoMet!==true
    ||!Number.isSafeInteger(verification.rpoTargetMs)||verification.rpoTargetMs<1
    ||!Number.isSafeInteger(verification.rtoTargetMs)||verification.rtoTargetMs<1
    ||!Number.isSafeInteger(verification.sourceSnapshotAgeMs)
    ||verification.sourceSnapshotAgeMs<0
    ||!Number.isSafeInteger(verification.restoredSnapshotAgeMs)
    ||verification.restoredSnapshotAgeMs<0
    ||!Number.isSafeInteger(verification.restoreDurationMs)||verification.restoreDurationMs<0
    ||verification.sourceSnapshotAgeMs>verification.rpoTargetMs
    ||verification.restoredSnapshotAgeMs>verification.rpoTargetMs
    ||verification.restoreDurationMs>verification.rtoTargetMs) attestationFailure();

  const safety=payload.safety;
  if(!exactObjectKeys(safety,[
    'sourceIdentityVerified','writesBlockedBeforePitr','sourceWriteStateRestored',
    'restoreIdentityVerified','restoreDeleted','sourceMigrated','sourceDeleted',
    'credentialsInvalidated',
  ])||safety.sourceIdentityVerified!==true||safety.writesBlockedBeforePitr!==true
    ||safety.sourceWriteStateRestored!==true||safety.restoreIdentityVerified!==true
    ||safety.restoreDeleted!==true||safety.sourceMigrated!==false||safety.sourceDeleted!==false
    ||safety.credentialsInvalidated!==false) attestationFailure();
  return true;
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

export function verifyRehearsalAttestation(value,options={}){
  try{
    if(!exactObjectKeys(value,['ok','kind','format','payload','signature'])||value.ok!==true
      ||value.kind!=='turso-rehearsal-attestation'
      ||value.format!==REHEARSAL_ATTESTATION_FORMAT||!digest(value.signature)){
      attestationFailure();
    }
    const repoCommit=commit(options.repoCommit);
    const expectedContext=normalizedAttestationContext(options.context,repoCommit);
    const maxAgeMs=integer(options.maxAgeMs,'attestation maximum age',{
      maximum:MAX_ATTESTATION_AGE_MS,
    });
    const expectedRpoTargetMs=integer(options.rpoTargetMs,'attestation RPO target',{
      maximum:90*24*60*60*1000,
    });
    const expectedRtoTargetMs=integer(options.rtoTargetMs,'attestation RTO target',{
      maximum:90*24*60*60*1000,
    });
    if(options.runConclusion!=='success') attestationFailure();
    const clock=typeof options.clock==='function'?options.clock:Date.now;
    validateAttestationPayload(value.payload,expectedContext,milliseconds(clock),maxAgeMs);
    if(value.payload.verification.rpoTargetMs!==expectedRpoTargetMs
      ||value.payload.verification.rtoTargetMs!==expectedRtoTargetMs) attestationFailure();
    const sourceIdentity=opaque(options.sourceIdentity,'expected source identity');
    const backupRef=opaque(options.backupRef,'expected backup reference',{maximum:1024});
    const boundBackupRef=`${backupRef}:${value.payload.pitr.requestedAt}`;
    if(!equalDigest(
        value.payload.identities.sourceIdentityDigest,
        evidenceKeyedDigest(options.hmacKey,'database-identity',sourceIdentity),
      )||!equalDigest(
        value.payload.identities.backupRefDigest,
        evidenceKeyedDigest(options.hmacKey,'backup-reference',boundBackupRef),
      )) attestationFailure();
    const expectedSignature=attestationSignature(value.payload,options.hmacKey);
    if(!equalDigest(value.signature,expectedSignature)) attestationFailure();
    return freeze(structuredClone(value.payload));
  }catch(error){
    if(error instanceof RehearsalError&&error.code==='REHEARSAL_ATTESTATION_INVALID') throw error;
    attestationFailure(error);
  }
}

function sourceIdentity(database,expected){
  if(database?.id!==expected.id||database?.name!==expected.name||database?.group!==expected.group
    ||database?.parent!==null){
    fail('REHEARSAL_SOURCE_IDENTITY_MISMATCH','source identity mismatch','source_identity');
  }
  return database;
}

function restoreIdentity(database,expected){
  if(database?.id!==expected.id||database?.name!==expected.name||database?.group!==expected.group
    ||database?.id===expected.sourceId||database?.name===expected.sourceName
    ||database?.parent?.id!==expected.sourceId||database?.parent?.name!==expected.sourceName
    ||database?.parent?.branchedAt!==expected.pitrAt){
    fail('REHEARSAL_RESTORE_IDENTITY_MISMATCH','restore identity mismatch','restore_ready');
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

function readonlyTransaction(transaction){
  return new Proxy(transaction,{
    get(target,property){
      if(property==='execute') return statement=>{
        if(!readonlySql(statement)) fail('REHEARSAL_INVALID','source write was attempted','source_evidence');
        return target.execute(statement);
      };
      const value=target[property];
      return typeof value==='function'?value.bind(target):value;
    },
  });
}

function interruptionError(phase){
  return new RehearsalError('REHEARSAL_FAILED','rehearsal interrupted',{phase});
}

function throwIfAborted(signal,phase){
  if(signal?.aborted) throw interruptionError(phase);
}

async function withDatabaseTimeout(operation,timeoutMs,phase,signal){
  throwIfAborted(signal,phase);
  let timer;
  let abortListener;
  try{
    return await Promise.race([
      Promise.resolve().then(operation),
      new Promise((_resolve,reject)=>{
        timer=setTimeout(()=>reject(new RehearsalError(
          'REHEARSAL_DATABASE_TIMEOUT','database operation timed out',{phase},
        )),timeoutMs);
      }),
      ...(signal?[new Promise((_resolve,reject)=>{
        abortListener=()=>reject(interruptionError(phase));
        signal.addEventListener('abort',abortListener,{once:true});
      })]:[]),
    ]);
  }finally{
    clearTimeout(timer);
    if(abortListener) signal.removeEventListener('abort',abortListener);
  }
}

function timedTransaction(transaction,timeoutMs,phase,signal){
  return new Proxy(transaction,{
    get(target,property){
      if(['execute','batch','commit','rollback'].includes(property)&&typeof target[property]==='function'){
        return (...args)=>withDatabaseTimeout(()=>target[property](...args),timeoutMs,phase,signal);
      }
      const value=target[property];
      return typeof value==='function'?value.bind(target):value;
    },
  });
}

function timedDatabaseClient(client,timeoutMs,phase,signal){
  return Object.freeze({
    execute:(...args)=>withDatabaseTimeout(()=>client.execute(...args),timeoutMs,phase,signal),
    batch:(...args)=>withDatabaseTimeout(()=>client.batch(...args),timeoutMs,phase,signal),
    async transaction(...args){
      const transaction=await withDatabaseTimeout(()=>client.transaction(...args),timeoutMs,phase,signal);
      return timedTransaction(transaction,timeoutMs,phase,signal);
    },
    close(){
      return typeof client.close==='function'
        ?withDatabaseTimeout(()=>client.close(),Math.min(timeoutMs,2_000),phase):undefined;
    },
  });
}

export function readonlySourceClient(client){
  return Object.freeze({
    execute(statement){
      if(!readonlySql(statement)) fail('REHEARSAL_INVALID','source write was attempted','source_evidence');
      return client.execute(statement);
    },
    async transaction(mode){
      if(mode!=='read') fail('REHEARSAL_INVALID','source write transaction was attempted','source_evidence');
      return readonlyTransaction(await client.transaction('read'));
    },
    close(){ return client.close?.(); },
  });
}

async function closeQuietly(client){
  if(!client) return;
  try{ await client.close?.(); }catch{}
}

function waitConfiguration(value={}){
  return Object.freeze({
    maxAttempts:integer(value.maxAttempts??60,'poll attempts',{maximum:120}),
    intervalMs:integer(value.intervalMs??5_000,'poll interval',{maximum:30_000}),
    maxDurationMs:integer(value.maxDurationMs??5*60_000,'poll duration',{maximum:10*60_000}),
  });
}

async function boundedPoll(
  operation,{maxAttempts,intervalMs,maxDurationMs},sleep,signal,
  deadline=Date.now()+maxDurationMs,
){
  let lastError=null;
  for(let attempt=1;attempt<=maxAttempts;attempt+=1){
    throwIfAborted(signal,'restore_ready');
    try{
      const value=await operation(attempt);
      if(value?.done) return value.value;
      lastError=null;
    }catch(error){
      if(!(error instanceof TursoPlatformError)||!error.retryable) throw error;
      lastError=error;
    }
    if(attempt<maxAttempts&&Date.now()<deadline){
      const waitMs=Math.min(intervalMs,Math.max(1,deadline-Date.now()));
      await withDatabaseTimeout(()=>sleep(waitMs),waitMs+1_000,'restore_ready',signal);
    }
    if(Date.now()>=deadline) break;
  }
  if(lastError) throw lastError;
  return null;
}

async function setAndConfirmWriteState(platform,source,blockWrites,poll,sleep,signal){
  let lastError=null;
  const deadline=Date.now()+poll.maxDurationMs;
  for(let attempt=1;attempt<=Math.min(3,poll.maxAttempts);attempt+=1){
    if(Date.now()>=deadline) break;
    throwIfAborted(signal,'write_block');
    try{
      sourceIdentity(await platform.getDatabase(source.name),source);
      await platform.setDatabaseBlockWrites(source.name,blockWrites);
      const confirmed=await boundedPoll(async()=>{
        const [configuration,database]=await Promise.all([
          platform.getDatabaseConfiguration(source.name),
          platform.getDatabase(source.name),
        ]);
        sourceIdentity(database,source);
        return configuration.blockWrites===blockWrites&&database.blockWrites===blockWrites
          ?{done:true,value:true}:{done:false};
      },poll,sleep,signal,deadline);
      if(confirmed===true) return;
      fail('REHEARSAL_SOURCE_WRITE_BLOCK_FAILED','source write state was not confirmed','write_block');
    }catch(error){
      lastError=error;
      if(attempt>=Math.min(3,poll.maxAttempts)
        ||(!(error instanceof TursoPlatformError)||!error.retryable)) throw error;
      if(Date.now()<deadline){
        const waitMs=Math.min(poll.intervalMs,Math.max(1,deadline-Date.now()));
        await withDatabaseTimeout(()=>sleep(waitMs),waitMs+1_000,'write_block',signal);
      }
    }
  }
  throw lastError??new RehearsalError(
    'REHEARSAL_SOURCE_WRITE_BLOCK_FAILED','source write-state deadline elapsed',
    {phase:'write_block'},
  );
}

export async function detectEvidenceMigration(db){
  for(let version=LATEST_MIGRATION_VERSION;version>=1;version-=1){
    const migrations=EXECUTABLE_MIGRATIONS.slice(0,version);
    const state=await inspectMigrationState(db,{migrations});
    const managed=state.classification==='managed'&&state.ledgerPresent
      &&state.currentVersion===version&&state.schemaExact&&state.ready;
    const unmanaged=state.classification==='unmanaged'&&!state.ledgerPresent
      &&state.currentVersion===0&&state.schemaExact&&state.adoption?.eligible===true;
    if(managed||unmanaged){
      return Object.freeze({
        version,
        classification:managed?'managed':'unmanaged',
        expectedLedger:managed?'present':'absent',
        migrations,
        stateFingerprint:state.stateFingerprint,
      });
    }
  }
  fail('REHEARSAL_MIGRATION_STATE_INVALID','source migration state is unsupported','source_evidence');
}

function evidenceOptions(options,{role,identity,pitrAt,contract,restoreStartedAt,restoreCompletedAt}){
  return {
    role,
    identity,
    hmacKey:options.hmacKey,
    backupRef:options.backupRef,
    repoCommit:options.repoCommit,
    pitrAt,
    maxSnapshotAgeMs:options.policy.maxSnapshotAgeMs,
    maxEvidenceAgeMs:options.policy.maxEvidenceAgeMs,
    rpoTargetMs:options.policy.rpoTargetMs,
    rtoTargetMs:options.policy.rtoTargetMs,
    clock:options.clock,
    migrations:contract.migrations,
    expectedLedger:contract.expectedLedger,
    limits:{maxDurationMs:options.evidenceMaxDurationMs},
    ...(role==='restore'?{restoreStartedAt,restoreCompletedAt}:{}),
  };
}

function comparisonOptions(options,sourceEvidence,restoreEvidence,{sourceId,restoreId,pitrAt}){
  return {
    sourceEvidence,
    restoredEvidence:restoreEvidence,
    hmacKey:options.hmacKey,
    sourceIdentity:sourceId,
    restoreIdentity:restoreId,
    backupRef:options.backupRef,
    repoCommit:options.repoCommit,
    pitrAt,
    ...options.policy,
    clock:options.clock,
  };
}

export function verifyPostMigrationPreservation(before,after){
  if(after?.migration?.classification!=='managed'
    ||after?.migration?.currentVersion!==LATEST_MIGRATION_VERSION
    ||after?.migration?.selectedVersion!==LATEST_MIGRATION_VERSION){
    fail('REHEARSAL_PRESERVATION_FAILED','restore did not reach the latest migration','post_migration_evidence');
  }
  const afterTables=new Map((after.tables||[]).map(table=>[table.name,table]));
  const beforeNames=new Set((before?.tables||[]).map(table=>table.name));
  for(const table of before?.tables||[]){
    const migrated=afterTables.get(table.name);
    if(!migrated||migrated.count!==table.count||migrated.digest!==table.digest){
      fail('REHEARSAL_PRESERVATION_FAILED','pre-migration data changed','post_migration_evidence');
    }
  }
  if(before?.storage?.sequenceRows!==after?.storage?.sequenceRows
    ||before?.storage?.sequenceDigest!==after?.storage?.sequenceDigest){
    fail('REHEARSAL_PRESERVATION_FAILED','sequence state changed','post_migration_evidence');
  }
  const sourceVersion=before?.migration?.selectedVersion;
  if(!Number.isSafeInteger(sourceVersion)||sourceVersion<1||sourceVersion>LATEST_MIGRATION_VERSION){
    fail('REHEARSAL_PRESERVATION_FAILED','source migration version is invalid','post_migration_evidence');
  }
  const laterOperations=EXECUTABLE_MIGRATIONS
    .filter(migration=>migration.version>sourceVersion)
    .flatMap(migration=>migration.operations);
  const expectedAdditions=[...new Set(laterOperations
    .filter(operation=>operation.operation==='ensure-table'&&!beforeNames.has(operation.name))
    .map(operation=>operation.name))].sort();
  const actualAdditions=[...afterTables.keys()].filter(tableName=>!beforeNames.has(tableName)).sort();
  if(JSON.stringify(actualAdditions)!==JSON.stringify(expectedAdditions)
    ||actualAdditions.some(tableName=>afterTables.get(tableName)?.count!==laterOperations
      .filter(operation=>operation.operation==='ensure-row'&&operation.table===tableName).length)){
    fail('REHEARSAL_PRESERVATION_FAILED','migration additions are not exact and empty','post_migration_evidence');
  }
  return true;
}

async function migrateDisposableRestore(db,contract){
  let adopted=false;
  if(contract.classification==='unmanaged'){
    const state=await inspectMigrationState(db,{migrations:contract.migrations});
    await adoptMigrations(db,{
      expectedStateFingerprint:state.stateFingerprint,
      migrations:contract.migrations,
      retry:FAST_MIGRATION_RETRY,
    });
    adopted=true;
  }
  const beforeApply=await inspectMigrationState(db);
  const result=await applyMigrations(db,{
    expectedStateFingerprint:beforeApply.stateFingerprint,
    migrations:EXECUTABLE_MIGRATIONS,
    retry:FAST_MIGRATION_RETRY,
  });
  return Object.freeze({
    adopted,
    fromVersion:contract.version,
    toVersion:result.toVersion,
    appliedVersions:result.applied.map(item=>item.version),
  });
}

async function cleanupRestore(platform,state,poll,sleep){
  if(!state.attempted) return {deleted:true,recovery:null};
  if(!state.id){
    return {deleted:false,recovery:{reason:'restore_identity_unconfirmed',restore:{name:state.name,id:null}}};
  }
  try{
    const database=await platform.getDatabase(state.name,{allowNotFound:true});
    if(database===null) return {deleted:true,recovery:null};
    restoreIdentity(database,state);
    await platform.deleteDatabase(state.name);
    const deleted=await boundedPoll(async()=>{
      const current=await platform.getDatabase(state.name,{allowNotFound:true});
      if(current===null) return {done:true,value:true};
      restoreIdentity(current,state);
      return {done:false};
    },poll,sleep);
    if(deleted===true) return {deleted:true,recovery:null};
  }catch(error){
    return {
      deleted:false,
      recovery:{
        reason:error instanceof RehearsalError?'restore_identity_mismatch':'restore_cleanup_failed',
        restore:{name:state.name,id:state.id},
      },
    };
  }
  return {deleted:false,recovery:{reason:'restore_cleanup_unconfirmed',restore:{name:state.name,id:state.id}}};
}

function normalizedOptions(value){
  if(!value||typeof value!=='object'||Array.isArray(value)){
    fail('REHEARSAL_INVALID','options are invalid','configuration');
  }
  if(value.confirmation!==CONFIRMATION){
    fail('REHEARSAL_INVALID','manual confirmation is invalid','configuration');
  }
  const source=Object.freeze({
    id:opaque(value.sourceDatabaseId,'source database ID'),
    name:name(value.sourceDatabaseName,'source database name'),
    group:name(value.sourceGroup,'source database group'),
  });
  const restoreName=name(value.restoreDatabaseName,'restore database name');
  if(restoreName===source.name) fail('REHEARSAL_INVALID','restore name must differ from source','configuration');
  const clock=typeof value.clock==='function'?value.clock:Date.now;
  const repoCommit=commit(value.repoCommit);
  const policy=Object.freeze({
    maxSnapshotAgeMs:integer(value.maxSnapshotAgeMs,'maximum snapshot age',{maximum:90*24*60*60*1000}),
    maxEvidenceAgeMs:integer(value.maxEvidenceAgeMs,'maximum evidence age',{maximum:90*24*60*60*1000}),
    rpoTargetMs:integer(value.rpoTargetMs,'RPO target',{maximum:90*24*60*60*1000}),
    rtoTargetMs:integer(value.rtoTargetMs,'RTO target',{maximum:90*24*60*60*1000}),
  });
  if(policy.maxEvidenceAgeMs>MAX_ATTESTATION_AGE_MS){
    fail('REHEARSAL_INVALID','evidence age exceeds the attestation TTL cap','configuration');
  }
  const attestationContext=normalizedAttestationContext(value.attestationContext,repoCommit);
  const key=hmacKey(value.hmacKey);
  return Object.freeze({
    platform:value.platform,
    recoveryPlatform:value.recoveryPlatform??value.platform,
    source,
    restoreName,
    repoCommit,
    attestationContext,
    hmacKey:key,
    clock,
    policy,
    poll:waitConfiguration(value.poll),
    cleanupPoll:waitConfiguration(value.cleanupPoll??{
      maxAttempts:12,intervalMs:2_000,maxDurationMs:2*60_000,
    }),
    databaseOperationTimeoutMs:integer(
      value.databaseOperationTimeoutMs??30_000,'database operation timeout',{maximum:120_000},
    ),
    evidenceMaxDurationMs:integer(
      value.evidenceMaxDurationMs??5*60_000,'evidence duration',{maximum:10*60_000},
    ),
    expectedSourceBlockWrites:exactBoolean(
      value.expectedSourceBlockWrites,'expected source block_writes',
    ),
    backupRef:`turso-pitr:${source.id}:${source.name}:${source.group}`,
    tokenExpiration:'30m',
    recoveryWriter:value.recoveryWriter,
    journalWriter:value.journalWriter,
    signal:value.signal,
  });
}

function journalSnapshot(options,originalWriteState){
  return {
    kind:'turso-backup-restore-journal',
    format:REHEARSAL_JOURNAL_FORMAT,
    repoCommit:options.repoCommit,
    status:'prepared',
    phase:'write_block',
    updatedAt:timestamp(options.clock),
    source:{
      id:options.source.id,name:options.source.name,group:options.source.group,
      originalBlockWrites:originalWriteState,writeStateRestored:false,
    },
    restore:{
      attempted:false,id:null,name:options.restoreName,group:options.source.group,pitrAt:null,
      sourceId:options.source.id,sourceName:options.source.name,
      identityVerified:false,deleted:false,
    },
  };
}

async function persistJournal(options,state,phase){
  state.phase=phase;
  state.updatedAt=timestamp(options.clock);
  try{ await options.journalWriter(structuredClone(state)); }
  catch(error){
    throw new RehearsalError('REHEARSAL_RECOVERY_STATE_FAILED','journal update failed',{
      cause:error,phase,
    });
  }
}

function createRehearsalAttestation(candidate,safety,key,issuedAt){
  const source=candidate.sourceEvidence;
  const restored=candidate.restoredEvidence;
  const post=candidate.postEvidence;
  const sourceExecutableChecksum=executableMigrationsChecksum(candidate.contract.migrations);
  const finalExecutableChecksum=executableMigrationsChecksum(EXECUTABLE_MIGRATIONS);
  if(source.schema?.manifestVersion!==SCHEMA_MANIFEST.version
    ||restored.schema?.manifestVersion!==SCHEMA_MANIFEST.version
    ||post.schema?.manifestVersion!==SCHEMA_MANIFEST.version
    ||source.schema?.manifestChecksum!==SCHEMA_MANIFEST.checksum
    ||restored.schema?.manifestChecksum!==SCHEMA_MANIFEST.checksum
    ||post.schema?.manifestChecksum!==SCHEMA_MANIFEST.checksum
    ||source.schema?.executableMigrationsChecksum!==sourceExecutableChecksum
    ||restored.schema?.executableMigrationsChecksum!==sourceExecutableChecksum
    ||post.schema?.executableMigrationsChecksum!==finalExecutableChecksum
    ||source.bindings?.repoCommit!==candidate.context.repoCommit
    ||restored.bindings?.repoCommit!==candidate.context.repoCommit
    ||post.bindings?.repoCommit!==candidate.context.repoCommit
    ||!equalDigest(source.bindings?.backupRefDigest,restored.bindings?.backupRefDigest)
    ||!equalDigest(source.bindings?.backupRefDigest,post.bindings?.backupRefDigest)
    ||!equalDigest(restored.bindings?.identityDigest,post.bindings?.identityDigest)
    ||candidate.comparison.sourceEvidenceDigest!==source.bindingDigest
    ||candidate.comparison.restoredEvidenceDigest!==restored.bindingDigest){
    attestationFailure();
  }
  const expiresAt=[source.expiresAt,restored.expiresAt,post.expiresAt]
    .map(canonicalAttestationTimestamp);
  const validUntil=new Date(Math.min(...expiresAt)).toISOString();
  const observedSafety=publicSafety(safety);
  const payload={
    context:{...candidate.context},
    issuedAt,
    validUntil,
    schema:{
      manifestVersion:SCHEMA_MANIFEST.version,
      manifestChecksum:SCHEMA_MANIFEST.checksum,
      sourceExecutableMigrationsChecksum:sourceExecutableChecksum,
      finalExecutableMigrationsChecksum:finalExecutableChecksum,
      latestMigrationVersion:LATEST_MIGRATION_VERSION,
    },
    migration:{
      sourceClassification:candidate.contract.classification,
      sourceVersion:candidate.contract.version,
      finalVersion:candidate.migration.toVersion,
      adoptedOnRestore:candidate.migration.adopted,
      appliedVersions:[...candidate.migration.appliedVersions],
    },
    identities:{
      sourceIdentityDigest:source.bindings.identityDigest,
      restoreIdentityDigest:restored.bindings.identityDigest,
      backupRefDigest:source.bindings.backupRefDigest,
    },
    pitr:{requestedAt:candidate.pitrAt,authoritativeAt:candidate.authoritativePitrAt},
    evidence:{
      sourceEvidenceDigest:source.bindingDigest,
      restoredEvidenceDigest:restored.bindingDigest,
      postMigrationEvidenceDigest:post.bindingDigest,
      comparisonDigest:candidate.comparison.comparisonDigest,
    },
    verification:{
      preMigrationMatch:true,
      postMigrationPreserved:true,
      rpoMet:candidate.comparison.rpoMet,
      rtoMet:candidate.comparison.rtoMet,
      rpoTargetMs:candidate.comparison.rpoTargetMs,
      rtoTargetMs:candidate.comparison.rtoTargetMs,
      sourceSnapshotAgeMs:candidate.comparison.sourceSnapshotAgeMs,
      restoredSnapshotAgeMs:candidate.comparison.restoredSnapshotAgeMs,
      restoreDurationMs:candidate.comparison.restoreDurationMs,
    },
    safety:{...observedSafety},
  };
  const issuedMilliseconds=canonicalAttestationTimestamp(issuedAt);
  validateAttestationPayload(
    payload,candidate.context,issuedMilliseconds,candidate.maxAttestationAgeMs,
  );
  return freeze({
    ok:true,kind:'turso-rehearsal-attestation',format:REHEARSAL_ATTESTATION_FORMAT,payload,
    signature:attestationSignature(payload,key),
  });
}

function publicResult(candidate,safety,key,issuedAt){
  return createRehearsalAttestation(candidate,safety,key,issuedAt);
}

function publicCleanupResult({repoCommit,safety,noState=false,recoveryRequired=false}){
  return Object.freeze({
    ok:!recoveryRequired,
    kind:'turso-backup-restore-cleanup',
    format:REHEARSAL_FORMAT,
    repoCommit,
    noState:noState===true,
    recoveryRequired:recoveryRequired===true,
    safety:publicSafety(safety),
  });
}

export async function runBackupRestoreRehearsal(rawOptions={},dependencies={}){
  const options=normalizedOptions(rawOptions);
  const platform=options.platform;
  const recoveryPlatform=options.recoveryPlatform;
  if(!platform||!recoveryPlatform||[
    'getDatabase','getDatabaseConfiguration','setDatabaseBlockWrites','createPitrDatabase',
    'createDatabaseToken','deleteDatabase',
  ].some(method=>typeof platform[method]!=='function'||typeof recoveryPlatform[method]!=='function')){
    options.hmacKey.fill(0);
    fail('REHEARSAL_INVALID','platform client is invalid','configuration');
  }
  const connectDatabase=dependencies.connectDatabase??(({role:_role,...configuration})=>createClient(configuration));
  const sleep=dependencies.sleep??(duration=>new Promise(resolve=>setTimeout(resolve,duration)));
  const recoveryWriter=dependencies.writeRecoveryState??options.recoveryWriter;
  if(typeof connectDatabase!=='function'||typeof sleep!=='function'||typeof recoveryWriter!=='function'
    ||typeof options.journalWriter!=='function'){
    options.hmacKey.fill(0);
    fail('REHEARSAL_INVALID','rehearsal dependencies are invalid','configuration');
  }

  const safety={};
  const restoreState={
    attempted:false,id:null,name:options.restoreName,group:options.source.group,
    sourceId:options.source.id,sourceName:options.source.name,pitrAt:null,
  };
  let phase='source_identity';
  let originalWriteState;
  let blockTouched=false;
  let sourceDb=null;
  let restoreDb=null;
  let candidate=null;
  let primaryError=null;
  let cleanup={deleted:true,recovery:null};
  let sourceRecovery=null;
  let journal=null;
  let journalError=null;
  try{
    const source=sourceIdentity(await platform.getDatabase(options.source.name),options.source);
    safety.sourceIdentityVerified=true;
    const configuration=await platform.getDatabaseConfiguration(options.source.name);
    if(configuration.blockWrites!==source.blockWrites){
      fail('REHEARSAL_SOURCE_IDENTITY_MISMATCH','source configuration is inconsistent','source_identity');
    }
    originalWriteState=configuration.blockWrites;
    if(originalWriteState!==options.expectedSourceBlockWrites){
      fail('REHEARSAL_SOURCE_IDENTITY_MISMATCH','source write state is not the protected expectation','source_identity');
    }
    journal=journalSnapshot(options,originalWriteState);
    await persistJournal(options,journal,'write_block');

    phase='write_block';
    throwIfAborted(options.signal,phase);
    blockTouched=true;
    await setAndConfirmWriteState(platform,options.source,true,options.poll,sleep,options.signal);
    safety.writesBlockedBeforePitr=true;
    const pitrAt=pitrTimestamp(options.clock);
    restoreState.pitrAt=pitrAt;
    const lockedSource=sourceIdentity(await platform.getDatabase(options.source.name),options.source);
    if(lockedSource.blockWrites!==true){
      fail('REHEARSAL_SOURCE_WRITE_BLOCK_FAILED','source write block was lost','write_block');
    }

    phase='source_evidence';
    const sourceToken=await platform.createDatabaseToken(options.source.name,{
      expiration:options.tokenExpiration,authorization:'read-only',
    });
    sourceDb=readonlySourceClient(timedDatabaseClient(await connectDatabase({
      url:hostnameUrl(lockedSource.hostname),authToken:sourceToken,intMode:'bigint',role:'source',
    }),options.databaseOperationTimeoutMs,'source_evidence',options.signal));
    const contract=await detectEvidenceMigration(sourceDb);
    const boundOptions={...options,backupRef:`${options.backupRef}:${pitrAt}`};
    const sourceEvidence=await collectDatabaseEvidence(sourceDb,evidenceOptions(boundOptions,{
      role:'source',identity:options.source.id,pitrAt,contract,
    }));
    await closeQuietly(sourceDb);
    sourceDb=null;

    phase='restore_create';
    const restoreStartedAt=timestamp(options.clock);
    restoreState.attempted=true;
    journal.status='active';
    journal.restore.attempted=true;
    journal.restore.pitrAt=pitrAt;
    await persistJournal(options,journal,'restore_create');
    const created=await platform.createPitrDatabase({
      name:options.restoreName,
      group:options.source.group,
      sourceName:options.source.name,
      pitrAt,
    });
    if(created.name!==options.restoreName||created.id===options.source.id){
      fail('REHEARSAL_RESTORE_IDENTITY_MISMATCH','created restore identity is invalid','restore_create');
    }
    restoreState.id=created.id;
    journal.restore.id=created.id;
    await persistJournal(options,journal,'write_state_restore');

    await setAndConfirmWriteState(
      platform,options.source,originalWriteState,options.poll,sleep,options.signal,
    );
    safety.sourceWriteStateRestored=true;
    blockTouched=false;
    journal.source.writeStateRestored=true;
    await persistJournal(options,journal,'restore_ready');

    phase='restore_ready';
    const ready=await boundedPoll(async()=>{
      const current=await platform.getDatabase(options.restoreName,{allowNotFound:true});
      if(current===null||current.parent===null) return {done:false};
      return {done:true,value:restoreIdentity(current,restoreState)};
    },options.poll,sleep,options.signal);
    if(!ready) fail('REHEARSAL_RESTORE_NOT_READY','restore did not become ready','restore_ready');
    safety.restoreIdentityVerified=true;
    journal.restore.identityVerified=true;
    await persistJournal(options,journal,'restore_evidence');
    const restoreCompletedAt=timestamp(options.clock);

    phase='restore_evidence';
    const restoreToken=await platform.createDatabaseToken(options.restoreName,{
      expiration:options.tokenExpiration,authorization:'full-access',
    });
    restoreDb=timedDatabaseClient(await connectDatabase({
      url:hostnameUrl(ready.hostname),authToken:restoreToken,intMode:'bigint',role:'restore',
    }),options.databaseOperationTimeoutMs,'restore_evidence',options.signal);
    const restoredBefore=await collectDatabaseEvidence(restoreDb,evidenceOptions(boundOptions,{
      role:'restore',identity:restoreState.id,pitrAt,contract,restoreStartedAt,restoreCompletedAt,
    }));
    const comparison=compareBackupRestoreEvidence(comparisonOptions(
      boundOptions,sourceEvidence,restoredBefore,
      {sourceId:options.source.id,restoreId:restoreState.id,pitrAt},
    ));

    phase='restore_migration';
    restoreIdentity(await platform.getDatabase(options.restoreName),restoreState);
    const migration=await migrateDisposableRestore(restoreDb,contract);

    phase='post_migration_evidence';
    const latestContract={
      migrations:EXECUTABLE_MIGRATIONS,
      expectedLedger:'present',
    };
    const postEvidence=await collectDatabaseEvidence(restoreDb,evidenceOptions(boundOptions,{
      role:'restore',identity:restoreState.id,pitrAt,contract:latestContract,
      restoreStartedAt,restoreCompletedAt,
    }));
    verifyPostMigrationPreservation(restoredBefore,postEvidence);
    candidate={
      repoCommit:options.repoCommit,context:options.attestationContext,
      contract,migration,sourceEvidence,restoredEvidence:restoredBefore,comparison,postEvidence,
      pitrAt,authoritativePitrAt:ready.parent.branchedAt,
      maxAttestationAgeMs:options.policy.maxEvidenceAgeMs,
    };
  }catch(error){
    primaryError=normalizeError(error,phase);
  }finally{
    if(blockTouched){
      phase='write_state_restore';
      try{
        await setAndConfirmWriteState(
          recoveryPlatform,options.source,originalWriteState,options.cleanupPoll,sleep,
        );
        safety.sourceWriteStateRestored=true;
        if(journal){
          journal.source.writeStateRestored=true;
          try{ await persistJournal(options,journal,'restore_cleanup'); }
          catch(error){ journalError=error; }
        }
      }catch{
        safety.sourceWriteStateRestored=false;
        sourceRecovery={
          reason:'source_write_state_unconfirmed',
          source:{
            name:options.source.name,id:options.source.id,group:options.source.group,
            expectedBlockWrites:originalWriteState,
          },
        };
      }
    }
    await closeQuietly(sourceDb);
    await closeQuietly(restoreDb);
    phase='restore_cleanup';
    cleanup=await cleanupRestore(recoveryPlatform,restoreState,options.cleanupPoll,sleep);
    safety.restoreDeleted=cleanup.deleted;
    if(journal){
      journal.restore.deleted=cleanup.deleted;
      journal.status=cleanup.deleted&&safety.sourceWriteStateRestored
        ?(primaryError?'failed_clean':'complete'):'recovery_required';
      try{ await persistJournal(options,journal,'complete'); }
      catch(error){ journalError=error; }
    }
  }

  const recoveryItems=[cleanup.recovery,sourceRecovery].filter(Boolean);
  if(recoveryItems.length){
    try{
      await recoveryWriter({
        kind:'turso-backup-restore-recovery',
        format:REHEARSAL_FORMAT,
        recordedAt:timestamp(options.clock),
        items:recoveryItems,
      });
    }catch(error){
      options.hmacKey.fill(0);
      throw withSafety(new RehearsalError('REHEARSAL_RECOVERY_STATE_FAILED','recovery state write failed',{
        cause:error,phase,
      }),safety);
    }
  }
  try{
    if(sourceRecovery){
      throw withSafety(new RehearsalError(
        'REHEARSAL_SOURCE_WRITE_STATE_RECOVERY_REQUIRED',
        'source write state recovery is required',
        {cause:primaryError,phase:'write_state_restore'},
      ),safety);
    }
    if(cleanup.recovery){
      throw withSafety(new RehearsalError(
        'REHEARSAL_RESTORE_CLEANUP_REQUIRED',
        'restore cleanup is required',
        {cause:primaryError,phase:'restore_cleanup'},
      ),safety);
    }
    if(journalError) throw withSafety(journalError,safety);
    if(primaryError) throw withSafety(primaryError,safety);
    return publicResult(candidate,safety,options.hmacKey,timestamp(options.clock));
  }finally{ options.hmacKey.fill(0); }
}

const JOURNAL_STATUSES=new Set(['prepared','active','failed_clean','recovery_required','complete']);

function validateJournal(value,expected){
  if(!value||typeof value!=='object'||Array.isArray(value)
    ||value.kind!=='turso-backup-restore-journal'||value.format!==REHEARSAL_JOURNAL_FORMAT
    ||value.repoCommit!==expected.repoCommit||!JOURNAL_STATUSES.has(value.status)
    ||!PHASES.has(value.phase)){
    fail('REHEARSAL_RECOVERY_STATE_FAILED','journal envelope is invalid','restore_cleanup');
  }
  exactTimestamp(value.updatedAt,'journal timestamp');
  const source=value.source;
  if(source?.id!==expected.source.id||source?.name!==expected.source.name
    ||source?.group!==expected.source.group
    ||source?.originalBlockWrites!==expected.expectedSourceBlockWrites
    ||typeof source?.writeStateRestored!=='boolean'){
    fail('REHEARSAL_RECOVERY_STATE_FAILED','journal source identity is invalid','restore_cleanup');
  }
  const restore=value.restore;
  if(restore?.name!==expected.restoreName||restore?.group!==expected.source.group
    ||restore?.sourceId!==expected.source.id||restore?.sourceName!==expected.source.name
    ||typeof restore?.attempted!=='boolean'||typeof restore?.identityVerified!=='boolean'
    ||typeof restore?.deleted!=='boolean'
    ||(restore.id!==null&&(typeof restore.id!=='string'||restore.id.length===0))
    ||(restore.pitrAt!==null&&exactTimestamp(restore.pitrAt,'journal PITR timestamp')!==restore.pitrAt)
    ||(!restore.attempted&&(restore.id!==null||restore.pitrAt!==null))
    ||(restore.id!==null&&restore.pitrAt===null)){
    fail('REHEARSAL_RECOVERY_STATE_FAILED','journal restore identity is invalid','restore_cleanup');
  }
  return structuredClone(value);
}

function normalizedCleanupOptions(value){
  if(!value||typeof value!=='object'||Array.isArray(value)){
    fail('REHEARSAL_INVALID','cleanup options are invalid','configuration');
  }
  const source=Object.freeze({
    id:opaque(value.sourceDatabaseId,'source database ID'),
    name:name(value.sourceDatabaseName,'source database name'),
    group:name(value.sourceGroup,'source database group'),
  });
  const restoreName=name(value.restoreDatabaseName,'restore database name');
  if(restoreName===source.name) fail('REHEARSAL_INVALID','restore name must differ from source','configuration');
  if(!value.platform||[
    'getDatabase','getDatabaseConfiguration','setDatabaseBlockWrites','deleteDatabase',
  ].some(method=>typeof value.platform[method]!=='function')){
    fail('REHEARSAL_INVALID','platform client is invalid','configuration');
  }
  if(typeof value.journalReader!=='function'||typeof value.journalWriter!=='function'){
    fail('REHEARSAL_INVALID','journal access is invalid','configuration');
  }
  return Object.freeze({
    platform:value.platform,source,restoreName,repoCommit:commit(value.repoCommit),
    expectedSourceBlockWrites:exactBoolean(
      value.expectedSourceBlockWrites,'expected source block_writes',
    ),
    journalReader:value.journalReader,journalWriter:value.journalWriter,
    clock:typeof value.clock==='function'?value.clock:Date.now,
    poll:waitConfiguration(value.poll??{
      maxAttempts:12,intervalMs:2_000,maxDurationMs:2*60_000,
    }),
  });
}

export async function runInterruptedCleanup(rawOptions={},dependencies={}){
  const options=normalizedCleanupOptions(rawOptions);
  const sleep=dependencies.sleep??(duration=>new Promise(resolve=>setTimeout(resolve,duration)));
  if(typeof sleep!=='function') fail('REHEARSAL_INVALID','cleanup sleep is invalid','configuration');
  const rawJournal=await options.journalReader();
  if(rawJournal===null){
    const source=sourceIdentity(await options.platform.getDatabase(options.source.name),options.source);
    const configuration=await options.platform.getDatabaseConfiguration(options.source.name);
    if(configuration.blockWrites!==source.blockWrites){
      fail('REHEARSAL_SOURCE_IDENTITY_MISMATCH','source configuration is inconsistent','write_state_restore');
    }
    if(configuration.blockWrites!==options.expectedSourceBlockWrites){
      throw withSafety(new RehearsalError(
        'REHEARSAL_SOURCE_WRITE_STATE_RECOVERY_REQUIRED',
        'source state differs without an owned journal',{phase:'write_state_restore'},
      ),{sourceIdentityVerified:true,sourceWriteStateRestored:false,restoreDeleted:false});
    }
    const possibleRestore=await options.platform.getDatabase(options.restoreName,{allowNotFound:true});
    if(possibleRestore!==null){
      throw withSafety(new RehearsalError(
        'REHEARSAL_RESTORE_CLEANUP_REQUIRED','unbound restore requires operator cleanup',
        {phase:'restore_cleanup'},
      ),{
        sourceIdentityVerified:true,sourceWriteStateRestored:true,restoreDeleted:false,
      });
    }
    return publicCleanupResult({
      repoCommit:options.repoCommit,noState:true,
      safety:{sourceIdentityVerified:true,sourceWriteStateRestored:true,restoreDeleted:true},
    });
  }
  const journal=validateJournal(rawJournal,options);
  const safety={
    sourceIdentityVerified:false,
    writesBlockedBeforePitr:journal.status!=='prepared',
    sourceWriteStateRestored:journal.source.writeStateRestored,
    restoreIdentityVerified:journal.restore.identityVerified,
    restoreDeleted:journal.restore.deleted,
  };
  if(journal.status==='complete'
    &&journal.source.writeStateRestored&&journal.restore.deleted){
    return publicCleanupResult({repoCommit:options.repoCommit,safety});
  }

  const source=sourceIdentity(await options.platform.getDatabase(options.source.name),options.source);
  safety.sourceIdentityVerified=true;
  const configuration=await options.platform.getDatabaseConfiguration(options.source.name);
  if(configuration.blockWrites!==source.blockWrites){
    fail('REHEARSAL_SOURCE_IDENTITY_MISMATCH','source configuration is inconsistent','write_state_restore');
  }
  if(configuration.blockWrites!==journal.source.originalBlockWrites){
    try{
      await setAndConfirmWriteState(
        options.platform,options.source,journal.source.originalBlockWrites,options.poll,sleep,
      );
    }catch(error){
      throw withSafety(new RehearsalError(
        'REHEARSAL_SOURCE_WRITE_STATE_RECOVERY_REQUIRED',
        'source write state restoration failed',
        {cause:error,phase:'write_state_restore'},
      ),safety);
    }
  }
  journal.source.writeStateRestored=true;
  safety.sourceWriteStateRestored=true;
  journal.status='active';
  await persistJournal(options,journal,'restore_cleanup');

  const restoreState={
    attempted:journal.restore.attempted,
    id:journal.restore.id,
    name:journal.restore.name,
    group:journal.restore.group,
    sourceId:journal.restore.sourceId,
    sourceName:journal.restore.sourceName,
    pitrAt:journal.restore.pitrAt,
  };
  const cleanup=await cleanupRestore(options.platform,restoreState,options.poll,sleep);
  journal.restore.deleted=cleanup.deleted;
  safety.restoreDeleted=cleanup.deleted;
  journal.status=cleanup.deleted?'complete':'recovery_required';
  await persistJournal(options,journal,cleanup.deleted?'complete':'restore_cleanup');
  if(cleanup.recovery){
    throw withSafety(new RehearsalError(
      'REHEARSAL_RESTORE_CLEANUP_REQUIRED','restore cleanup is required',
      {phase:'restore_cleanup'},
    ),safety);
  }
  return publicCleanupResult({repoCommit:options.repoCommit,safety});
}

function parseArguments(argv){
  if(!Array.isArray(argv)||argv.length!==6){
    fail('REHEARSAL_INVALID','usage is invalid','configuration');
  }
  const flags=new Map();
  for(let index=0;index<argv.length;index+=2){
    if(!['--mode','--artifact-dir','--state-file'].includes(argv[index])
      ||flags.has(argv[index])||!argv[index+1]){
      fail('REHEARSAL_INVALID','usage is invalid','configuration');
    }
    flags.set(argv[index],argv[index+1]);
  }
  const mode=flags.get('--mode');
  if(!['run','cleanup'].includes(mode)||!flags.has('--artifact-dir')||!flags.has('--state-file')){
    fail('REHEARSAL_INVALID','usage is invalid','configuration');
  }
  return {
    mode,artifactDirectory:flags.get('--artifact-dir'),stateFile:flags.get('--state-file'),
  };
}

function booleanEnvironment(value,label){
  if(value==='true') return true;
  if(value==='false') return false;
  fail('REHEARSAL_INVALID',`${label} is invalid`,'configuration');
}

function environmentIdentity(environment,platform){
  const runId=opaque(environment.GITHUB_RUN_ID,'GitHub run ID',{maximum:32});
  const runAttempt=opaque(environment.GITHUB_RUN_ATTEMPT,'GitHub run attempt',{maximum:8});
  if(!/^[1-9][0-9]*$/.test(runId)||!/^[1-9][0-9]*$/.test(runAttempt)){
    fail('REHEARSAL_INVALID','GitHub run identity is invalid','configuration');
  }
  const prefix=name(environment.TURSO_RESTORE_DATABASE_PREFIX,'restore database prefix');
  const suffix=`-${runId}-${runAttempt}`;
  const restoreDatabaseName=`${prefix.slice(0,64-suffix.length).replace(/-+$/,'')}${suffix}`;
  return Object.freeze({
    platform,
    sourceDatabaseId:environment.TURSO_PRODUCTION_DATABASE_ID,
    sourceDatabaseName:environment.TURSO_PRODUCTION_DATABASE_NAME,
    sourceGroup:environment.TURSO_GROUP,
    restoreDatabaseName,
    repoCommit:environment.REHEARSAL_REPO_COMMIT,
    expectedSourceBlockWrites:booleanEnvironment(
      environment.TURSO_PRODUCTION_EXPECTED_BLOCK_WRITES,
      'expected source block_writes',
    ),
  });
}

function environmentOptions(environment,platform,recoveryPlatform,signal){
  const repoCommit=environment.REHEARSAL_REPO_COMMIT;
  return {
    ...environmentIdentity(environment,platform),
    recoveryPlatform,
    attestationContext:{
      repository:environment.GITHUB_REPOSITORY,
      repositoryId:environment.GITHUB_REPOSITORY_ID,
      workflowPath:environment.REHEARSAL_WORKFLOW_PATH,
      workflowRef:environment.GITHUB_WORKFLOW_REF,
      workflowSha:environment.GITHUB_WORKFLOW_SHA,
      runId:environment.GITHUB_RUN_ID,
      runAttempt:environment.GITHUB_RUN_ATTEMPT,
      environment:environment.REHEARSAL_GITHUB_ENVIRONMENT,
      repoCommit,
    },
    hmacKey:environment.MIGRATION_DIGEST_HMAC_KEY,
    confirmation:environment.RESTORE_REHEARSAL_CONFIRM,
    maxSnapshotAgeMs:environment.REHEARSAL_MAX_SNAPSHOT_AGE_MS,
    maxEvidenceAgeMs:environment.REHEARSAL_MAX_EVIDENCE_AGE_MS,
    rpoTargetMs:environment.REHEARSAL_RPO_TARGET_MS,
    rtoTargetMs:environment.REHEARSAL_RTO_TARGET_MS,
    poll:{
      maxAttempts:environment.REHEARSAL_POLL_ATTEMPTS,
      intervalMs:environment.REHEARSAL_POLL_INTERVAL_MS,
      maxDurationMs:environment.REHEARSAL_POLL_DURATION_MS,
    },
    cleanupPoll:{
      maxAttempts:environment.REHEARSAL_CLEANUP_POLL_ATTEMPTS,
      intervalMs:environment.REHEARSAL_CLEANUP_POLL_INTERVAL_MS,
      maxDurationMs:environment.REHEARSAL_CLEANUP_POLL_DURATION_MS,
    },
    databaseOperationTimeoutMs:environment.TURSO_DATABASE_TIMEOUT_MS,
    evidenceMaxDurationMs:environment.REHEARSAL_EVIDENCE_DURATION_MS,
    signal,
  };
}

function environmentCleanupOptions(environment,platform){
  return {
    ...environmentIdentity(environment,platform),
    poll:{
      maxAttempts:environment.REHEARSAL_CLEANUP_POLL_ATTEMPTS,
      intervalMs:environment.REHEARSAL_CLEANUP_POLL_INTERVAL_MS,
      maxDurationMs:environment.REHEARSAL_CLEANUP_POLL_DURATION_MS,
    },
  };
}

async function directoryWithinRunnerTemp(path,runnerTemp){
  if(!isAbsolute(path)||!isAbsolute(runnerTemp)){
    fail('REHEARSAL_INVALID','runner paths must be absolute','configuration');
  }
  const lexicalRoot=resolve(runnerTemp);
  const root=await realpath(runnerTemp);
  const child=relative(lexicalRoot,resolve(path));
  if(!child||child.startsWith('..')||isAbsolute(child)){
    fail('REHEARSAL_INVALID','artifact directory must be inside RUNNER_TEMP','configuration');
  }
  const target=resolve(root,child);
  await mkdir(target,{recursive:true,mode:0o700});
  const actual=await realpath(target);
  const actualChild=relative(root,actual);
  if(!actualChild||actualChild.startsWith('..')||isAbsolute(actualChild)){
    fail('REHEARSAL_INVALID','artifact directory escaped RUNNER_TEMP','configuration');
  }
  return actual;
}

async function writeExclusiveJson(path,value){
  const handle=await open(path,'wx',0o600);
  try{ await handle.writeFile(`${JSON.stringify(value)}\n`,{encoding:'utf8'}); }
  finally{ await handle.close(); }
}

const MAX_JOURNAL_BYTES=64*1024;

export function createPrivateStateJournal(path){
  if(!isAbsolute(path)||basename(path)!=='state.json'){
    fail('REHEARSAL_INVALID','journal path is invalid','configuration');
  }
  async function read(){
    let metadata;
    try{ metadata=await lstat(path,{bigint:true}); }
    catch(error){
      if(error?.code==='ENOENT') return null;
      throw error;
    }
    if(metadata.isSymbolicLink()||!metadata.isFile()||metadata.size>BigInt(MAX_JOURNAL_BYTES)){
      fail('REHEARSAL_RECOVERY_STATE_FAILED','journal file is unsafe','restore_cleanup');
    }
    const descriptor=await open(path,constants.O_RDONLY|(constants.O_NOFOLLOW||0));
    try{
      const opened=await descriptor.stat({bigint:true});
      if(!opened.isFile()||opened.dev!==metadata.dev||opened.ino!==metadata.ino
        ||opened.size>BigInt(MAX_JOURNAL_BYTES)){
        fail('REHEARSAL_RECOVERY_STATE_FAILED','journal file changed','restore_cleanup');
      }
      const content=await descriptor.readFile({encoding:'utf8'});
      const current=await lstat(path,{bigint:true});
      if(current.isSymbolicLink()||current.dev!==opened.dev||current.ino!==opened.ino){
        fail('REHEARSAL_RECOVERY_STATE_FAILED','journal file changed','restore_cleanup');
      }
      try{ return JSON.parse(content); }
      catch(error){
        throw new RehearsalError('REHEARSAL_RECOVERY_STATE_FAILED','journal JSON is invalid',{
          cause:error,phase:'restore_cleanup',
        });
      }
    }finally{ await descriptor.close(); }
  }
  async function write(value){
    let serialized;
    try{ serialized=`${JSON.stringify(value)}\n`; }
    catch(error){
      throw new RehearsalError('REHEARSAL_RECOVERY_STATE_FAILED','journal value is invalid',{
        cause:error,phase:'restore_cleanup',
      });
    }
    if(Buffer.byteLength(serialized,'utf8')>MAX_JOURNAL_BYTES){
      fail('REHEARSAL_RECOVERY_STATE_FAILED','journal value is too large','restore_cleanup');
    }
    const temporary=resolve(dirname(path),`.state.${process.pid}.${randomUUID()}.tmp`);
    let descriptor;
    try{
      descriptor=await open(
        temporary,
        constants.O_CREAT|constants.O_EXCL|constants.O_WRONLY|(constants.O_NOFOLLOW||0),
        0o600,
      );
      await descriptor.writeFile(serialized,{encoding:'utf8'});
      await descriptor.sync();
      await descriptor.close();
      descriptor=null;
      await rename(temporary,path);
    }finally{
      try{ await descriptor?.close(); }catch{}
      try{ await unlink(temporary); }catch(error){ if(error?.code!=='ENOENT') throw error; }
    }
  }
  return Object.freeze({read,write});
}

export async function main({
  argv=process.argv.slice(2),
  environment=process.env,
  stdout=process.stdout,
  createPlatform=createTursoPlatformClient,
  run=runBackupRestoreRehearsal,
  cleanup=runInterruptedCleanup,
  signal,
}={}){
  let artifactDirectory=null;
  let repoCommit=null;
  let mode=null;
  let result;
  try{
    const parsed=parseArguments(argv);
    mode=parsed.mode;
    const runnerTemp=opaque(environment.RUNNER_TEMP,'RUNNER_TEMP',{maximum:4096});
    artifactDirectory=await directoryWithinRunnerTemp(parsed.artifactDirectory,runnerTemp);
    const recoveryDirectory=await directoryWithinRunnerTemp(
      dirname(parsed.stateFile),runnerTemp,
    );
    if(basename(parsed.stateFile)!=='state.json'){
      fail('REHEARSAL_INVALID','state file path is invalid','configuration');
    }
    repoCommit=environment.REHEARSAL_REPO_COMMIT;
    const platformConfiguration={
      organization:environment.TURSO_ORGANIZATION,
      token:environment.TURSO_PRODUCTION_PLATFORM_TOKEN,
      timeoutMs:integer(environment.TURSO_PLATFORM_TIMEOUT_MS,'platform timeout',{maximum:60_000}),
    };
    const platform=createPlatform({
      ...platformConfiguration,...(parsed.mode==='run'&&signal?{signal}:{}),
    });
    const recoveryPlatform=parsed.mode==='run'
      ?createPlatform(platformConfiguration):platform;
    const recoveryPath=resolve(recoveryDirectory,'recovery.json');
    const journal=createPrivateStateJournal(resolve(recoveryDirectory,'state.json'));
    if(parsed.mode==='run'){
      const options=environmentOptions(environment,platform,recoveryPlatform,signal);
      result=await run({
        ...options,
        recoveryWriter:value=>writeExclusiveJson(recoveryPath,value),
        journalWriter:journal.write,
      });
    }else{
      result=await cleanup({
        ...environmentCleanupOptions(environment,platform),
        journalReader:journal.read,
        journalWriter:journal.write,
      });
    }
  }catch(error){
    result=publicRehearsalError(error,{repoCommit});
  }
  if(artifactDirectory){
    const artifactName=mode==='run'
      ?'rehearsal-summary.json':'cleanup-summary.json';
    try{ await writeExclusiveJson(resolve(artifactDirectory,artifactName),result); }
    catch(error){
      result=publicRehearsalError(new RehearsalError(
        'REHEARSAL_RECOVERY_STATE_FAILED','artifact write failed',{cause:error,phase:'complete'},
      ),{repoCommit});
    }
  }
  stdout.write(`${JSON.stringify(result)}\n`);
  return {exitCode:result.ok?0:1,result};
}

const isEntryPoint=process.argv[1]
  &&fileURLToPath(import.meta.url)===resolve(process.argv[1]);
if(isEntryPoint){
  const controller=new AbortController();
  let interrupted=false;
  const interrupt=()=>{ interrupted=true; controller.abort(); };
  process.once('SIGINT',interrupt);
  process.once('SIGTERM',interrupt);
  const execution=await main({signal:controller.signal});
  process.removeListener('SIGINT',interrupt);
  process.removeListener('SIGTERM',interrupt);
  process.exitCode=interrupted?130:execution.exitCode;
}
