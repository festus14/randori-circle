#!/usr/bin/env node
import { mkdir, open, realpath } from 'node:fs/promises';
import { isAbsolute, relative, resolve } from 'node:path';
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
import {
  TursoPlatformError,
  createTursoPlatformClient,
} from '../db/turso-platform.js';

export const REHEARSAL_FORMAT='randori.turso-backup-restore-rehearsal.v1';

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
    ||database?.parent?.id!==expected.sourceId||database?.parent?.name!==expected.sourceName){
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

async function withDatabaseTimeout(operation,timeoutMs,phase){
  let timer;
  try{
    return await Promise.race([
      Promise.resolve().then(operation),
      new Promise((_resolve,reject)=>{
        timer=setTimeout(()=>reject(new RehearsalError(
          'REHEARSAL_DATABASE_TIMEOUT','database operation timed out',{phase},
        )),timeoutMs);
      }),
    ]);
  }finally{ clearTimeout(timer); }
}

function timedTransaction(transaction,timeoutMs,phase){
  return new Proxy(transaction,{
    get(target,property){
      if(['execute','batch','commit','rollback'].includes(property)&&typeof target[property]==='function'){
        return (...args)=>withDatabaseTimeout(()=>target[property](...args),timeoutMs,phase);
      }
      const value=target[property];
      return typeof value==='function'?value.bind(target):value;
    },
  });
}

function timedDatabaseClient(client,timeoutMs,phase){
  return Object.freeze({
    execute:(...args)=>withDatabaseTimeout(()=>client.execute(...args),timeoutMs,phase),
    batch:(...args)=>withDatabaseTimeout(()=>client.batch(...args),timeoutMs,phase),
    async transaction(...args){
      const transaction=await withDatabaseTimeout(()=>client.transaction(...args),timeoutMs,phase);
      return timedTransaction(transaction,timeoutMs,phase);
    },
    close(){
      return typeof client.close==='function'
        ?withDatabaseTimeout(()=>client.close(),timeoutMs,phase):undefined;
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
  });
}

async function boundedPoll(operation,{maxAttempts,intervalMs},sleep){
  let lastError=null;
  for(let attempt=1;attempt<=maxAttempts;attempt+=1){
    try{
      const value=await operation(attempt);
      if(value?.done) return value.value;
      lastError=null;
    }catch(error){
      if(!(error instanceof TursoPlatformError)||!error.retryable) throw error;
      lastError=error;
    }
    if(attempt<maxAttempts) await sleep(intervalMs);
  }
  if(lastError) throw lastError;
  return null;
}

async function setAndConfirmWriteState(platform,source,blockWrites,poll,sleep){
  let lastError=null;
  for(let attempt=1;attempt<=Math.min(3,poll.maxAttempts);attempt+=1){
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
      },poll,sleep);
      if(confirmed===true) return;
      fail('REHEARSAL_SOURCE_WRITE_BLOCK_FAILED','source write state was not confirmed','write_block');
    }catch(error){
      lastError=error;
      if(attempt>=Math.min(3,poll.maxAttempts)
        ||(!(error instanceof TursoPlatformError)||!error.retryable)) throw error;
      await sleep(poll.intervalMs);
    }
  }
  throw lastError;
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
  const policy=Object.freeze({
    maxSnapshotAgeMs:integer(value.maxSnapshotAgeMs,'maximum snapshot age',{maximum:90*24*60*60*1000}),
    maxEvidenceAgeMs:integer(value.maxEvidenceAgeMs,'maximum evidence age',{maximum:90*24*60*60*1000}),
    rpoTargetMs:integer(value.rpoTargetMs,'RPO target',{maximum:90*24*60*60*1000}),
    rtoTargetMs:integer(value.rtoTargetMs,'RTO target',{maximum:90*24*60*60*1000}),
  });
  const key=hmacKey(value.hmacKey);
  return Object.freeze({
    platform:value.platform,
    source,
    restoreName,
    repoCommit:commit(value.repoCommit),
    hmacKey:key,
    clock,
    policy,
    poll:waitConfiguration(value.poll),
    databaseOperationTimeoutMs:integer(
      value.databaseOperationTimeoutMs??30_000,'database operation timeout',{maximum:120_000},
    ),
    backupRef:`turso-pitr:${source.id}`,
    tokenExpiration:'30m',
    recoveryWriter:value.recoveryWriter,
  });
}

function publicResult(candidate,safety){
  return Object.freeze({
    ok:true,
    kind:'turso-backup-restore-rehearsal',
    format:REHEARSAL_FORMAT,
    repoCommit:candidate.repoCommit,
    completedAt:candidate.completedAt,
    migration:Object.freeze({
      sourceClassification:candidate.contract.classification,
      sourceVersion:candidate.contract.version,
      adoptedOnRestore:candidate.migration.adopted,
      appliedVersions:Object.freeze([...candidate.migration.appliedVersions]),
      finalVersion:candidate.migration.toVersion,
    }),
    verification:Object.freeze({
      preMigrationMatch:true,
      postMigrationPreserved:true,
      comparisonDigest:candidate.comparison.comparisonDigest,
      sourceEvidenceDigest:candidate.comparison.sourceEvidenceDigest,
      restoredEvidenceDigest:candidate.comparison.restoredEvidenceDigest,
      postMigrationEvidenceDigest:candidate.postEvidence.bindingDigest,
      rpoMet:candidate.comparison.rpoMet,
      rtoMet:candidate.comparison.rtoMet,
      restoreDurationMs:candidate.comparison.restoreDurationMs,
    }),
    safety:publicSafety(safety),
  });
}

export async function runBackupRestoreRehearsal(rawOptions={},dependencies={}){
  const options=normalizedOptions(rawOptions);
  const platform=options.platform;
  if(!platform||[
    'getDatabase','getDatabaseConfiguration','setDatabaseBlockWrites','createPitrDatabase',
    'createDatabaseToken','deleteDatabase',
  ].some(method=>typeof platform[method]!=='function')){
    options.hmacKey.fill(0);
    fail('REHEARSAL_INVALID','platform client is invalid','configuration');
  }
  const connectDatabase=dependencies.connectDatabase??(({role:_role,...configuration})=>createClient(configuration));
  const sleep=dependencies.sleep??(duration=>new Promise(resolve=>setTimeout(resolve,duration)));
  const recoveryWriter=dependencies.writeRecoveryState??options.recoveryWriter;
  if(typeof connectDatabase!=='function'||typeof sleep!=='function'||typeof recoveryWriter!=='function'){
    options.hmacKey.fill(0);
    fail('REHEARSAL_INVALID','rehearsal dependencies are invalid','configuration');
  }

  const safety={};
  const restoreState={
    attempted:false,id:null,name:options.restoreName,group:options.source.group,
    sourceId:options.source.id,sourceName:options.source.name,
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
  try{
    const source=sourceIdentity(await platform.getDatabase(options.source.name),options.source);
    safety.sourceIdentityVerified=true;
    const configuration=await platform.getDatabaseConfiguration(options.source.name);
    if(configuration.blockWrites!==source.blockWrites){
      fail('REHEARSAL_SOURCE_IDENTITY_MISMATCH','source configuration is inconsistent','source_identity');
    }
    originalWriteState=configuration.blockWrites;

    phase='write_block';
    blockTouched=true;
    await setAndConfirmWriteState(platform,options.source,true,options.poll,sleep);
    safety.writesBlockedBeforePitr=true;
    const pitrAt=timestamp(options.clock);
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
    }),options.databaseOperationTimeoutMs,'source_evidence'));
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

    phase='restore_ready';
    const ready=await boundedPoll(async()=>{
      const current=await platform.getDatabase(options.restoreName,{allowNotFound:true});
      if(current===null||current.parent===null) return {done:false};
      return {done:true,value:restoreIdentity(current,restoreState)};
    },options.poll,sleep);
    if(!ready) fail('REHEARSAL_RESTORE_NOT_READY','restore did not become ready','restore_ready');
    safety.restoreIdentityVerified=true;
    const restoreCompletedAt=timestamp(options.clock);

    phase='restore_evidence';
    const restoreToken=await platform.createDatabaseToken(options.restoreName,{
      expiration:options.tokenExpiration,authorization:'full-access',
    });
    restoreDb=timedDatabaseClient(await connectDatabase({
      url:hostnameUrl(ready.hostname),authToken:restoreToken,intMode:'bigint',role:'restore',
    }),options.databaseOperationTimeoutMs,'restore_evidence');
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
      repoCommit:options.repoCommit,contract,migration,comparison,postEvidence,
      completedAt:timestamp(options.clock),
    };
  }catch(error){
    primaryError=normalizeError(error,phase);
  }finally{
    await closeQuietly(restoreDb);
    await closeQuietly(sourceDb);
    if(blockTouched){
      phase='write_state_restore';
      try{
        await setAndConfirmWriteState(
          platform,options.source,originalWriteState,options.poll,sleep,
        );
        safety.sourceWriteStateRestored=true;
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
    phase='restore_cleanup';
    cleanup=await cleanupRestore(platform,restoreState,options.poll,sleep);
    safety.restoreDeleted=cleanup.deleted;
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
  options.hmacKey.fill(0);
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
  if(primaryError) throw withSafety(primaryError,safety);
  return publicResult(candidate,safety);
}

function parseArguments(argv){
  if(!Array.isArray(argv)||argv.length!==2||argv[0]!=='--artifact-dir'||!argv[1]){
    fail('REHEARSAL_INVALID','usage is invalid','configuration');
  }
  return {artifactDirectory:argv[1]};
}

function environmentOptions(environment,platform){
  const runId=opaque(environment.GITHUB_RUN_ID,'GitHub run ID',{maximum:32});
  const runAttempt=opaque(environment.GITHUB_RUN_ATTEMPT,'GitHub run attempt',{maximum:8});
  if(!/^[1-9][0-9]*$/.test(runId)||!/^[1-9][0-9]*$/.test(runAttempt)){
    fail('REHEARSAL_INVALID','GitHub run identity is invalid','configuration');
  }
  const prefix=name(environment.TURSO_RESTORE_DATABASE_PREFIX,'restore database prefix');
  const suffix=`-${runId}-${runAttempt}`;
  const restoreDatabaseName=`${prefix.slice(0,64-suffix.length).replace(/-+$/,'')}${suffix}`;
  return {
    platform,
    sourceDatabaseId:environment.TURSO_PRODUCTION_DATABASE_ID,
    sourceDatabaseName:environment.TURSO_PRODUCTION_DATABASE_NAME,
    sourceGroup:environment.TURSO_GROUP,
    restoreDatabaseName,
    repoCommit:environment.REHEARSAL_REPO_COMMIT,
    hmacKey:environment.MIGRATION_DIGEST_HMAC_KEY,
    confirmation:environment.RESTORE_REHEARSAL_CONFIRM,
    maxSnapshotAgeMs:environment.REHEARSAL_MAX_SNAPSHOT_AGE_MS,
    maxEvidenceAgeMs:environment.REHEARSAL_MAX_EVIDENCE_AGE_MS,
    rpoTargetMs:environment.REHEARSAL_RPO_TARGET_MS,
    rtoTargetMs:environment.REHEARSAL_RTO_TARGET_MS,
    poll:{
      maxAttempts:environment.REHEARSAL_POLL_ATTEMPTS,
      intervalMs:environment.REHEARSAL_POLL_INTERVAL_MS,
    },
    databaseOperationTimeoutMs:environment.TURSO_DATABASE_TIMEOUT_MS,
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

export async function main({
  argv=process.argv.slice(2),
  environment=process.env,
  stdout=process.stdout,
  createPlatform=createTursoPlatformClient,
  run=runBackupRestoreRehearsal,
}={}){
  let artifactDirectory=null;
  let repoCommit=null;
  let result;
  try{
    const parsed=parseArguments(argv);
    const runnerTemp=opaque(environment.RUNNER_TEMP,'RUNNER_TEMP',{maximum:4096});
    artifactDirectory=await directoryWithinRunnerTemp(parsed.artifactDirectory,runnerTemp);
    const recoveryDirectory=await directoryWithinRunnerTemp(
      resolve(runnerTemp,'private-recovery'),runnerTemp,
    );
    repoCommit=environment.REHEARSAL_REPO_COMMIT;
    const platform=createPlatform({
      organization:environment.TURSO_ORGANIZATION,
      token:environment.TURSO_PRODUCTION_PLATFORM_TOKEN,
      timeoutMs:integer(environment.TURSO_PLATFORM_TIMEOUT_MS,'platform timeout',{maximum:60_000}),
    });
    const recoveryPath=resolve(recoveryDirectory,'recovery.json');
    const options=environmentOptions(environment,platform);
    result=await run({
      ...options,
      recoveryWriter:value=>writeExclusiveJson(recoveryPath,value),
    });
  }catch(error){
    result=publicRehearsalError(error,{repoCommit});
  }
  if(artifactDirectory){
    try{ await writeExclusiveJson(resolve(artifactDirectory,'rehearsal-summary.json'),result); }
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
  const execution=await main();
  process.exitCode=execution.exitCode;
}
