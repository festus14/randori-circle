import { createHmac, timingSafeEqual } from 'node:crypto';

import { EXECUTABLE_MIGRATIONS, validateExecutableMigrations } from './executable-migrations.js';
import { MIGRATION_PLANS } from './migration-plan.js';
import { inspectMigrationState } from './migration-runner.js';
import { SCHEMA_MANIFEST, checksum, stableJson } from './schema-manifest.js';

export const BACKUP_EVIDENCE_FORMAT='randori.backup-restore-evidence.v1';

export const BACKUP_EVIDENCE_LIMITS=Object.freeze({
  minHmacKeyBytes:32,
  maxHmacKeyBytes:4096,
  maxIdentityBytes:512,
  maxBackupRefBytes:1024,
  maxColumnsPerTable:256,
  maxRowsPerTable:5_000_000,
  maxTotalRows:25_000_000,
  maxCellBytes:16*1024*1024,
  maxPageValueBytes:32*1024*1024,
  maxTotalValueBytes:2*1024*1024*1024,
  maxPreflightCellsPerPage:32_768,
  pageSize:500,
  maxDurationMs:60*60*1000,
  maxPolicyMs:90*24*60*60*1000,
});

const PUBLIC_MESSAGES=Object.freeze({
  BACKUP_EVIDENCE_INVALID:'Backup evidence input is invalid.',
  BACKUP_EVIDENCE_IDENTITY_INVALID:'Backup source and restore identities are invalid.',
  BACKUP_EVIDENCE_INTEGRITY_FAILED:'Database integrity verification failed.',
  BACKUP_EVIDENCE_FOREIGN_KEY_FAILED:'Database foreign-key verification failed.',
  BACKUP_EVIDENCE_MIGRATION_INVALID:'Database migration or schema state is invalid.',
  BACKUP_EVIDENCE_RESOURCE_LIMIT:'Database evidence exceeded a configured resource limit.',
  BACKUP_EVIDENCE_STALE_SNAPSHOT:'The backup snapshot is outside the allowed age.',
  BACKUP_EVIDENCE_STALE:'Backup evidence is outside the allowed age.',
  BACKUP_EVIDENCE_AUTHENTICATION_FAILED:'Backup evidence authentication failed.',
  BACKUP_EVIDENCE_MISMATCH:'The restored database does not match its source evidence.',
  BACKUP_EVIDENCE_FAILED:'Backup evidence verification failed.',
});

const SAFE_REASONS=new Set([
  'binding','identity','identity_reused','backup_ref','repo_commit','pitr','policy',
  'schema','migration','ledger','table_set','row_count','table_digest','ordering',
  'integrity','foreign_keys','timestamp','snapshot_age','evidence_age','resource_limit','rpo','rto',
  'sequence',
]);

export class BackupEvidenceError extends Error{
  constructor(code,message,{cause,details}={}){
    super(message,cause?{cause}:undefined);
    this.name='BackupEvidenceError';
    this.code=code;
    if(details!==undefined) this.details=details;
  }
}

function fail(code,message,details){
  throw new BackupEvidenceError(code,message,{details});
}

function byteLength(value){ return Buffer.byteLength(value,'utf8'); }

function opaque(value,name,maxBytes){
  if(typeof value!=='string'||value.length===0||value!==value.trim()
    ||byteLength(value)>maxBytes||/[\u0000-\u001f\u007f]/u.test(value)){
    fail('BACKUP_EVIDENCE_INVALID',`${name} is invalid`);
  }
  return value;
}

function hmacKey(value){
  let key;
  if(typeof value==='string') key=Buffer.from(value,'utf8');
  else if(value instanceof Uint8Array) key=Buffer.from(value);
  else fail('BACKUP_EVIDENCE_INVALID','HMAC key is invalid');
  if(key.byteLength<BACKUP_EVIDENCE_LIMITS.minHmacKeyBytes
    ||key.byteLength>BACKUP_EVIDENCE_LIMITS.maxHmacKeyBytes){
    key.fill(0);
    fail('BACKUP_EVIDENCE_INVALID','HMAC key length is invalid');
  }
  return key;
}

function integer(value,name,{minimum=0,maximum=Number.MAX_SAFE_INTEGER}={}){
  if(!Number.isSafeInteger(value)||value<minimum||value>maximum){
    fail('BACKUP_EVIDENCE_INVALID',`${name} is invalid`);
  }
  return value;
}

function canonicalTimestamp(value,name){
  if(typeof value!=='string') fail('BACKUP_EVIDENCE_INVALID',`${name} is invalid`);
  const milliseconds=Date.parse(value);
  if(!Number.isFinite(milliseconds)||new Date(milliseconds).toISOString()!==value){
    fail('BACKUP_EVIDENCE_INVALID',`${name} is invalid`);
  }
  return {value,milliseconds};
}

function clockMilliseconds(clock){
  let value;
  try{ value=clock(); }catch(error){
    throw new BackupEvidenceError('BACKUP_EVIDENCE_FAILED','Evidence clock failed',{cause:error});
  }
  const milliseconds=value instanceof Date?value.getTime():Number(value);
  if(!Number.isSafeInteger(milliseconds)||milliseconds<0){
    fail('BACKUP_EVIDENCE_INVALID','clock returned an invalid timestamp');
  }
  return milliseconds;
}

function repositoryCommit(value){
  if(typeof value!=='string'||!/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(value)){
    fail('BACKUP_EVIDENCE_INVALID','repository commit is invalid');
  }
  return value;
}

function normalizedLimits(value={}){
  if(!value||typeof value!=='object'||Array.isArray(value)){
    fail('BACKUP_EVIDENCE_INVALID','resource limits are invalid');
  }
  const result={};
  for(const name of [
    'maxRowsPerTable','maxTotalRows','maxCellBytes','maxPageValueBytes',
    'maxTotalValueBytes','pageSize','maxDurationMs',
  ]){
    const configured=value[name]??BACKUP_EVIDENCE_LIMITS[name];
    result[name]=integer(configured,name,{minimum:1,maximum:BACKUP_EVIDENCE_LIMITS[name]});
  }
  return Object.freeze(result);
}

function policy(options){
  const result={};
  for(const name of ['maxSnapshotAgeMs','maxEvidenceAgeMs','rpoTargetMs','rtoTargetMs']){
    result[name]=integer(options[name],name,{minimum:1,maximum:BACKUP_EVIDENCE_LIMITS.maxPolicyMs});
  }
  return Object.freeze(result);
}

function derivedKey(key,label){
  return createHmac('sha256',key).update(`randori-backup-evidence-key:v1:${label}`,'utf8').digest();
}

function keyedDigest(key,label,value){
  const derived=derivedKey(key,label);
  try{ return createHmac('sha256',derived).update(value).digest('hex'); }
  finally{ derived.fill(0); }
}

function keyedJsonDigest(key,label,value){
  return keyedDigest(key,label,stableJson(value));
}

function frame(hmac,tag,payload){
  const bytes=Buffer.isBuffer(payload)?payload:Buffer.from(payload);
  const header=Buffer.allocUnsafe(10);
  header.writeUInt8(tag,0);
  header.writeBigUInt64BE(BigInt(bytes.byteLength),1);
  header.writeUInt8(0xff,9);
  hmac.update(header);
  hmac.update(bytes);
}

function sqliteValue(value,storageClass){
  switch(storageClass){
    case 'null':
      if(value!==null) fail('BACKUP_EVIDENCE_FAILED','Database returned an invalid null value');
      return {tag:0,bytes:Buffer.alloc(0)};
    case 'integer':{
      let text;
      if(typeof value==='bigint') text=value.toString(10);
      else if(typeof value==='number'&&Number.isSafeInteger(value)) text=String(value);
      else if(typeof value==='string'&&/^-?(?:0|[1-9][0-9]*)$/.test(value)) text=value;
      else fail('BACKUP_EVIDENCE_FAILED','Database returned an unsafe integer value');
      return {tag:1,bytes:Buffer.from(text,'ascii')};
    }
    case 'real':{
      if(typeof value!=='number') fail('BACKUP_EVIDENCE_FAILED','Database returned an invalid real value');
      const bytes=Buffer.allocUnsafe(8);
      bytes.writeDoubleBE(value,0);
      return {tag:2,bytes};
    }
    case 'text':
      if(typeof value!=='string') fail('BACKUP_EVIDENCE_FAILED','Database returned an invalid text value');
      return {tag:3,bytes:Buffer.from(value,'utf8')};
    case 'blob':
      if(!(value instanceof ArrayBuffer)&&!ArrayBuffer.isView(value)){
        fail('BACKUP_EVIDENCE_FAILED','Database returned an invalid blob value');
      }
      return {tag:4,bytes:Buffer.from(
        value instanceof ArrayBuffer?value:value.buffer,
        value instanceof ArrayBuffer?0:value.byteOffset,
        value instanceof ArrayBuffer?value.byteLength:value.byteLength,
      )};
    default:
      fail('BACKUP_EVIDENCE_FAILED','Database returned an unknown storage class');
  }
}

function identifier(value){
  if(typeof value!=='string'||!/^[A-Za-z_][A-Za-z0-9_]*$/.test(value)){
    fail('BACKUP_EVIDENCE_MIGRATION_INVALID','Database schema contains an invalid identifier');
  }
  return `"${value}"`;
}

function safeCount(value){
  const number=typeof value==='bigint'?Number(value):value;
  if(!Number.isSafeInteger(number)||number<0){
    fail('BACKUP_EVIDENCE_RESOURCE_LIMIT','Database count is outside the supported range',{
      reason:'resource_limit',
    });
  }
  return number;
}

function canonicalColumn(row){
  const cid=safeCount(row.cid);
  const primaryKeyPosition=safeCount(row.pk);
  const hidden=safeCount(row.hidden??0);
  const notNull=safeCount(row.notnull);
  if(![0,1].includes(notNull)||hidden>3){
    fail('BACKUP_EVIDENCE_MIGRATION_INVALID','Database column metadata is invalid');
  }
  const name=String(row.name??'');
  identifier(name);
  return Object.freeze({
    cid,
    name,
    type:String(row.type??'').trim().toUpperCase(),
    notNull,
    defaultValue:row.dflt_value===null||row.dflt_value===undefined?null:String(row.dflt_value),
    primaryKeyPosition,
    hidden,
  });
}

async function tableColumns(db,tableName){
  const result=await db.execute(`PRAGMA table_xinfo(${identifier(tableName)})`);
  const columns=(result.rows||[]).map(canonicalColumn).sort((left,right)=>left.cid-right.cid);
  if(columns.length===0||columns.length>BACKUP_EVIDENCE_LIMITS.maxColumnsPerTable
    ||columns.some((column,index)=>column.cid!==index)){
    fail('BACKUP_EVIDENCE_MIGRATION_INVALID','Database table metadata is invalid');
  }
  return Object.freeze(columns);
}

function selectForTable(tableName,columns,orderColumns){
  const selections=columns.flatMap((column,index)=>[
    `${identifier(column.name)} AS "__evidence_value_${index}"`,
    `typeof(${identifier(column.name)}) AS "__evidence_type_${index}"`,
  ]).join(',');
  const order=orderColumns.map(column=>`${identifier(column.name)} COLLATE BINARY`).join(',');
  return `SELECT ${selections} FROM ${identifier(tableName)} ORDER BY ${order} LIMIT ? OFFSET ?`;
}

function lengthSelectForTable(tableName,columns,orderColumns){
  const selections=columns.map((column,index)=>{
    const name=identifier(column.name);
    return `CASE typeof(${name}) WHEN 'null' THEN 0 WHEN 'real' THEN 8 ELSE length(CAST(${name} AS BLOB)) END AS "__evidence_length_${index}"`;
  }).join(',');
  const order=orderColumns.map(column=>`${identifier(column.name)} COLLATE BINARY`).join(',');
  return `SELECT ${selections} FROM ${identifier(tableName)} ORDER BY ${order} LIMIT ? OFFSET ?`;
}

function databaseLength(value){
  let result;
  if(typeof value==='bigint') result=value;
  else if(typeof value==='number'&&Number.isSafeInteger(value)) result=BigInt(value);
  else fail('BACKUP_EVIDENCE_FAILED','Database returned invalid length metadata');
  if(result<0n) fail('BACKUP_EVIDENCE_FAILED','Database returned invalid length metadata');
  return result;
}

function metadataValue(columns){
  return columns.map(column=>({
    cid:column.cid,
    name:column.name,
    type:column.type,
    notNull:column.notNull,
    defaultValue:column.defaultValue,
    primaryKeyPosition:column.primaryKeyPosition,
    hidden:column.hidden,
  }));
}

function deadlineGuard(context){
  if(clockMilliseconds(context.clock)-context.startedAt>context.limits.maxDurationMs){
    fail('BACKUP_EVIDENCE_RESOURCE_LIMIT','Database evidence collection exceeded its time limit',{
      reason:'resource_limit',
    });
  }
}

async function preflightTableValues(db,tableName,columns,orderColumns,count,context){
  if(count===0) return Object.freeze({totalBytes:0n,rowsPerValuePage:context.limits.pageSize});
  const sql=lengthSelectForTable(tableName,columns,orderColumns);
  const preflightPageSize=Math.max(1,Math.min(
    context.limits.pageSize,
    Math.floor(BACKUP_EVIDENCE_LIMITS.maxPreflightCellsPerPage/columns.length),
  ));
  const maxCell=BigInt(context.limits.maxCellBytes);
  const maxPage=BigInt(Math.min(
    context.limits.maxPageValueBytes,context.limits.maxTotalValueBytes,
  ));
  const maxTotal=BigInt(context.limits.maxTotalValueBytes);
  let observed=0;
  let totalBytes=0n;
  let maxRowBytes=0n;
  while(observed<count){
    deadlineGuard(context);
    const result=await db.execute({sql,args:[preflightPageSize,observed]});
    const rows=result.rows||[];
    if(rows.length===0||rows.length>preflightPageSize){
      fail('BACKUP_EVIDENCE_FAILED','Database changed during evidence preflight');
    }
    for(const row of rows){
      let rowBytes=0n;
      for(let index=0;index<columns.length;index+=1){
        const length=databaseLength(row[`__evidence_length_${index}`]);
        if(length>maxCell){
          fail('BACKUP_EVIDENCE_RESOURCE_LIMIT','Database evidence value limit exceeded',{
            reason:'resource_limit',table:tableName,
          });
        }
        rowBytes+=length;
        if(rowBytes>maxPage){
          fail('BACKUP_EVIDENCE_RESOURCE_LIMIT','Database evidence page limit exceeded',{
            reason:'resource_limit',table:tableName,
          });
        }
      }
      totalBytes+=rowBytes;
      if(totalBytes>maxTotal||context.totalValueBytes+totalBytes>maxTotal){
        fail('BACKUP_EVIDENCE_RESOURCE_LIMIT','Database evidence total value limit exceeded',{
          reason:'resource_limit',table:tableName,
        });
      }
      if(rowBytes>maxRowBytes) maxRowBytes=rowBytes;
      observed+=1;
      if(observed>count) fail('BACKUP_EVIDENCE_FAILED','Database changed during evidence preflight');
    }
  }
  const divisor=maxRowBytes>0n?maxRowBytes:1n;
  const safeRows=Number(maxPage/divisor);
  return Object.freeze({
    totalBytes,
    rowsPerValuePage:Math.max(1,Math.min(context.limits.pageSize,safeRows)),
  });
}

async function digestTable(db,tableName,key,context){
  deadlineGuard(context);
  const columns=await tableColumns(db,tableName);
  const countResult=await db.execute(`SELECT COUNT(*) AS "__evidence_count" FROM ${identifier(tableName)}`);
  const count=safeCount(countResult.rows?.[0]?.__evidence_count);
  if(count>context.limits.maxRowsPerTable||context.totalRows+count>context.limits.maxTotalRows){
    fail('BACKUP_EVIDENCE_RESOURCE_LIMIT','Database evidence row limit exceeded',{
      reason:'resource_limit',table:tableName,
    });
  }
  context.totalRows+=count;
  const metadata=metadataValue(columns);
  const metadataDigest=keyedJsonDigest(key,`table-metadata:${tableName}`,metadata);
  const tableKey=derivedKey(key,`table:${tableName}`);
  const hmac=createHmac('sha256',tableKey);
  tableKey.fill(0);
  frame(hmac,10,Buffer.from(BACKUP_EVIDENCE_FORMAT));
  frame(hmac,11,Buffer.from(tableName));
  frame(hmac,12,Buffer.from(stableJson(metadata)));
  const primaryKey=columns.filter(column=>column.primaryKeyPosition>0)
    .sort((left,right)=>left.primaryKeyPosition-right.primaryKeyPosition);
  const primaryNames=new Set(primaryKey.map(column=>column.name));
  const orderColumns=primaryKey.length
    ?[...primaryKey,...columns.filter(column=>!primaryNames.has(column.name))]
    :columns;
  const preflight=await preflightTableValues(
    db,tableName,columns,orderColumns,count,context,
  );
  context.totalValueBytes+=preflight.totalBytes;
  const sql=selectForTable(tableName,columns,orderColumns);
  let observed=0;
  let observedValueBytes=0n;
  while(observed<count){
    deadlineGuard(context);
    const result=await db.execute({sql,args:[preflight.rowsPerValuePage,observed]});
    const rows=result.rows||[];
    if(rows.length===0||rows.length>preflight.rowsPerValuePage){
      fail('BACKUP_EVIDENCE_FAILED','Database changed during evidence collection');
    }
    let pageValueBytes=0n;
    for(const row of rows){
      frame(hmac,20,Buffer.alloc(0));
      for(let index=0;index<columns.length;index+=1){
        const storageClass=row[`__evidence_type_${index}`];
        if(typeof storageClass!=='string') fail('BACKUP_EVIDENCE_FAILED','Database returned invalid row metadata');
        const encoded=sqliteValue(row[`__evidence_value_${index}`],storageClass);
        if(encoded.bytes.byteLength>context.limits.maxCellBytes){
          fail('BACKUP_EVIDENCE_RESOURCE_LIMIT','Database evidence value limit exceeded',{
            reason:'resource_limit',table:tableName,
          });
        }
        const length=BigInt(encoded.bytes.byteLength);
        pageValueBytes+=length;
        observedValueBytes+=length;
        if(pageValueBytes>BigInt(context.limits.maxPageValueBytes)
          ||observedValueBytes>preflight.totalBytes){
          fail('BACKUP_EVIDENCE_RESOURCE_LIMIT','Database evidence page limit exceeded',{
            reason:'resource_limit',table:tableName,
          });
        }
        frame(hmac,encoded.tag,encoded.bytes);
      }
      observed+=1;
      if(observed>count) fail('BACKUP_EVIDENCE_FAILED','Database changed during evidence collection');
    }
  }
  if(observed!==count||observedValueBytes!==preflight.totalBytes){
    fail('BACKUP_EVIDENCE_FAILED','Database changed during evidence collection');
  }
  frame(hmac,21,Buffer.from(String(count),'ascii'));
  return Object.freeze({name:tableName,count,digest:hmac.digest('hex'),metadataDigest});
}

async function integrityChecks(db){
  const integrity=await db.execute('PRAGMA integrity_check(1)');
  const rows=integrity.rows||[];
  const value=rows.length===1?Object.values(rows[0]||{})[0]:null;
  if(value!=='ok'){
    fail('BACKUP_EVIDENCE_INTEGRITY_FAILED','Database integrity check did not pass',{
      reason:'integrity',
    });
  }
  const foreignKeys=await db.execute('SELECT 1 AS violation FROM pragma_foreign_key_check LIMIT 1');
  if((foreignKeys.rows||[]).length){
    fail('BACKUP_EVIDENCE_FOREIGN_KEY_FAILED','Database foreign-key check did not pass',{
      reason:'foreign_keys',
    });
  }
  return Object.freeze({integrity:true,foreignKeys:true});
}

function executableChecksum(migrations=EXECUTABLE_MIGRATIONS){
  return checksum(migrations.map(migration=>({
    version:migration.version,
    checksum:migration.checksum,
  })));
}

function migrationSelection(value){
  const migrations=value??EXECUTABLE_MIGRATIONS;
  try{ validateExecutableMigrations(migrations); }
  catch(error){
    throw new BackupEvidenceError('BACKUP_EVIDENCE_INVALID','Migration selection is invalid',{cause:error});
  }
  return migrations;
}

function schemaContractAtVersion(version){
  const tables=new Map();
  const indexes=new Map();
  MIGRATION_PLANS.filter(plan=>plan.version<=version).forEach(plan=>plan.operations.forEach(operation=>{
    if(operation.operation==='ensure-table'){
      const {operation:_operation,...definition}=operation;
      tables.set(operation.name,Object.freeze(definition));
    }
    if(operation.operation==='ensure-index'){
      const {operation:_operation,...definition}=operation;
      indexes.set(operation.name,Object.freeze(definition));
    }
  }));
  const value=Object.freeze({
    version,
    tables:Object.freeze([...tables.values()]),
    indexes:Object.freeze([...indexes.values()]),
    toleratedLegacyTables:Object.freeze([...SCHEMA_MANIFEST.toleratedLegacyTables]),
  });
  return Object.freeze({...value,checksum:checksum(value)});
}

async function observedLegacyTables(db){
  const names=SCHEMA_MANIFEST.toleratedLegacyTables
    .filter(name=>name!=='schema_migrations').sort();
  if(names.length===0) return [];
  const placeholders=names.map(()=>'?').join(',');
  const result=await db.execute({
    sql:`SELECT name FROM sqlite_schema WHERE type='table' AND name IN (${placeholders}) ORDER BY name`,
    args:names,
  });
  return (result.rows||[]).map(row=>String(row.name));
}

function evidencePayload(value){
  return {
    ok:true,
    kind:'database-evidence',
    format:BACKUP_EVIDENCE_FORMAT,
    role:value.role,
    collectedAt:value.collectedAt,
    expiresAt:value.expiresAt,
    pitrAt:value.pitrAt,
    policy:{
      maxSnapshotAgeMs:value.policy?.maxSnapshotAgeMs,
      maxEvidenceAgeMs:value.policy?.maxEvidenceAgeMs,
      rpoTargetMs:value.policy?.rpoTargetMs,
      rtoTargetMs:value.policy?.rtoTargetMs,
    },
    timings:{
      snapshotAgeMs:value.timings?.snapshotAgeMs,
      restoreStartedAt:value.timings?.restoreStartedAt,
      restoreCompletedAt:value.timings?.restoreCompletedAt,
      restoreDurationMs:value.timings?.restoreDurationMs,
      rpoMet:value.timings?.rpoMet,
      rtoMet:value.timings?.rtoMet,
    },
    bindings:{
      repoCommit:value.bindings?.repoCommit,
      identityDigest:value.bindings?.identityDigest,
      backupRefDigest:value.bindings?.backupRefDigest,
    },
    checks:{
      integrity:value.checks?.integrity,
      foreignKeys:value.checks?.foreignKeys,
    },
    migration:{
      classification:value.migration?.classification,
      selectedVersion:value.migration?.selectedVersion,
      currentVersion:value.migration?.currentVersion,
      latestVersion:value.migration?.latestVersion,
      applicationLatestVersion:value.migration?.applicationLatestVersion,
      ledgerPresent:value.migration?.ledgerPresent,
      stateDigest:value.migration?.stateDigest,
      ledgerRows:value.migration?.ledgerRows,
      ledgerDigest:value.migration?.ledgerDigest,
    },
    schema:{
      manifestVersion:value.schema?.manifestVersion,
      manifestChecksum:value.schema?.manifestChecksum,
      expectedSchemaChecksum:value.schema?.expectedSchemaChecksum,
      executableMigrationsChecksum:value.schema?.executableMigrationsChecksum,
      schemaDigest:value.schema?.schemaDigest,
    },
    storage:{
      sequenceRows:value.storage?.sequenceRows,
      sequenceDigest:value.storage?.sequenceDigest,
    },
    totals:{
      tableCount:value.totals?.tableCount,
      legacyTableCount:value.totals?.legacyTableCount,
      rowCount:value.totals?.rowCount,
      valueBytes:value.totals?.valueBytes,
    },
    tables:value.tables.map(table=>({name:table?.name,count:table?.count,digest:table?.digest})),
  };
}

function comparisonPayload(value){
  return {
    ok:true,
    kind:'restore-verification',
    format:BACKUP_EVIDENCE_FORMAT,
    verifiedAt:value.verifiedAt,
    sourceEvidenceDigest:value.sourceEvidenceDigest,
    restoredEvidenceDigest:value.restoredEvidenceDigest,
    tableCount:value.tableCount,
    totalRows:value.totalRows,
    sequenceRows:value.sequenceRows,
    sourceSnapshotAgeMs:value.sourceSnapshotAgeMs,
    restoredSnapshotAgeMs:value.restoredSnapshotAgeMs,
    sourceCollectedAt:value.sourceCollectedAt,
    restoredCollectedAt:value.restoredCollectedAt,
    restoreStartedAt:value.restoreStartedAt,
    restoreCompletedAt:value.restoreCompletedAt,
    restoreDurationMs:value.restoreDurationMs,
    rpoTargetMs:value.rpoTargetMs,
    rtoTargetMs:value.rtoTargetMs,
    rpoMet:value.rpoMet,
    rtoMet:value.rtoMet,
  };
}

function freezePublic(value){
  if(Array.isArray(value)) return Object.freeze(value.map(freezePublic));
  if(value&&typeof value==='object'){
    return Object.freeze(Object.fromEntries(Object.entries(value).map(([key,item])=>[key,freezePublic(item)])));
  }
  return value;
}

export function publicBackupEvidenceResult(value){
  if(value?.kind==='database-evidence'&&typeof value.bindingDigest==='string'){
    return freezePublic({...evidencePayload(value),bindingDigest:value.bindingDigest});
  }
  if(value?.kind==='restore-verification'&&typeof value.comparisonDigest==='string'){
    return freezePublic({...comparisonPayload(value),comparisonDigest:value.comparisonDigest});
  }
  fail('BACKUP_EVIDENCE_INVALID','Backup evidence result is invalid');
}

export function publicBackupEvidenceError(error){
  const code=error instanceof BackupEvidenceError&&PUBLIC_MESSAGES[error.code]
    ?error.code:'BACKUP_EVIDENCE_FAILED';
  const result={ok:false,error:code,message:PUBLIC_MESSAGES[code]};
  const reason=error instanceof BackupEvidenceError?error.details?.reason:null;
  const table=error instanceof BackupEvidenceError?error.details?.table:null;
  if(SAFE_REASONS.has(reason)) result.reason=reason;
  if(typeof table==='string'&&SCHEMA_MANIFEST.tables.some(item=>item.name===table)) result.table=table;
  return Object.freeze(result);
}

async function closeReadTransaction(transaction){
  try{ await transaction.rollback(); }catch{}
  try{ transaction.close?.(); }catch{}
}

export async function collectDatabaseEvidence(db,options={}){
  if(!db||typeof db.transaction!=='function') fail('BACKUP_EVIDENCE_INVALID','A transactional database client is required');
  const key=hmacKey(options.hmacKey);
  let transaction;
  try{
    const role=options.role;
    if(!['source','restore'].includes(role)) fail('BACKUP_EVIDENCE_INVALID','Evidence role is invalid');
    const identity=opaque(options.identity,'database identity',BACKUP_EVIDENCE_LIMITS.maxIdentityBytes);
    const backupRef=opaque(options.backupRef,'backup reference',BACKUP_EVIDENCE_LIMITS.maxBackupRefBytes);
    const repoCommit=repositoryCommit(options.repoCommit);
    const configuredPolicy=policy(options);
    const migrations=migrationSelection(options.migrations);
    const migrationVersion=migrations.at(-1).version;
    const expectedLedger=options.expectedLedger??'present';
    if(!['present','absent'].includes(expectedLedger)
      ||(expectedLedger==='absent'&&!Object.hasOwn(options,'migrations'))){
      fail('BACKUP_EVIDENCE_INVALID','Expected migration ledger state is invalid');
    }
    const schemaContract=schemaContractAtVersion(migrationVersion);
    const limits=normalizedLimits(options.limits);
    const clock=typeof options.clock==='function'?options.clock:Date.now;
    const collectedMs=clockMilliseconds(clock);
    const collectedAt=new Date(collectedMs).toISOString();
    const pitr=canonicalTimestamp(options.pitrAt,'PITR timestamp');
    const snapshotAgeMs=collectedMs-pitr.milliseconds;
    if(snapshotAgeMs<0||snapshotAgeMs>configuredPolicy.maxSnapshotAgeMs){
      fail('BACKUP_EVIDENCE_STALE_SNAPSHOT','Snapshot age is invalid',{
        reason:'snapshot_age',
      });
    }
    let restoreDurationMs=null;
    let restoreStartedAt=null;
    let restoreCompletedAt=null;
    if(role==='restore'){
      const started=canonicalTimestamp(options.restoreStartedAt,'restore start timestamp');
      const completed=canonicalTimestamp(options.restoreCompletedAt,'restore completion timestamp');
      restoreDurationMs=completed.milliseconds-started.milliseconds;
      if(restoreDurationMs<0||started.milliseconds<pitr.milliseconds
        ||completed.milliseconds>collectedMs){
        fail('BACKUP_EVIDENCE_INVALID','Restore timing is invalid');
      }
      restoreStartedAt=started.value;
      restoreCompletedAt=completed.value;
    }else if(options.restoreStartedAt!==undefined||options.restoreCompletedAt!==undefined){
      fail('BACKUP_EVIDENCE_INVALID','Source evidence cannot include restore timing');
    }

    transaction=await db.transaction('read');
    const context={
      clock,startedAt:collectedMs,limits,totalRows:0,totalValueBytes:0n,
    };
    const checks=await integrityChecks(transaction);
    deadlineGuard(context);
    const migrationState=await inspectMigrationState(transaction,{migrations});
    const managedReady=expectedLedger==='present'
      &&migrationState.classification==='managed'&&migrationState.ledgerPresent
      &&migrationState.currentVersion===migrationVersion&&migrationState.ready;
    const unmanagedReady=expectedLedger==='absent'
      &&migrationState.classification==='unmanaged'&&!migrationState.ledgerPresent
      &&migrationState.currentVersion===0&&migrationState.adoption?.eligible===true;
    if(!migrationState.schemaExact||(!managedReady&&!unmanagedReady)){
      fail('BACKUP_EVIDENCE_MIGRATION_INVALID','Database is not at the current exact migration state',{
        reason:'migration',
      });
    }
    const tables=[];
    const metadata=[];
    for(const tableDefinition of schemaContract.tables){
      const result=await digestTable(transaction,tableDefinition.name,key,context);
      metadata.push({name:result.name,digest:result.metadataDigest});
      tables.push(Object.freeze({name:result.name,count:result.count,digest:result.digest}));
    }
    const legacyTables=await observedLegacyTables(transaction);
    for(const tableName of legacyTables){
      const result=await digestTable(transaction,tableName,key,context);
      metadata.push({name:result.name,digest:result.metadataDigest});
      tables.push(Object.freeze({name:result.name,count:result.count,digest:result.digest}));
    }
    const ledger=expectedLedger==='present'
      ?await digestTable(transaction,'schema_migrations',key,context)
      :Object.freeze({
        count:0,
        digest:keyedJsonDigest(key,'migration-ledger-absence',{
          present:false,selectedVersion:migrationVersion,
        }),
      });
    const sequences=await digestTable(transaction,'sqlite_sequence',key,context);
    const schemaDigest=keyedJsonDigest(key,'schema',{
      manifestChecksum:SCHEMA_MANIFEST.checksum,
      expectedSchemaChecksum:schemaContract.checksum,
      executableMigrationsChecksum:executableChecksum(migrations),
      tables:metadata,
    });
    const value={
      role,
      collectedAt,
      expiresAt:new Date(collectedMs+configuredPolicy.maxEvidenceAgeMs).toISOString(),
      pitrAt:pitr.value,
      policy:configuredPolicy,
      timings:{
        snapshotAgeMs,
        restoreStartedAt,
        restoreCompletedAt,
        restoreDurationMs,
        rpoMet:snapshotAgeMs<=configuredPolicy.rpoTargetMs,
        rtoMet:restoreDurationMs===null?null:restoreDurationMs<=configuredPolicy.rtoTargetMs,
      },
      bindings:{
        repoCommit,
        identityDigest:keyedDigest(key,'database-identity',identity),
        backupRefDigest:keyedDigest(key,'backup-reference',backupRef),
      },
      checks,
      migration:{
        classification:migrationState.classification,
        selectedVersion:migrationVersion,
        currentVersion:migrationState.currentVersion,
        latestVersion:migrationState.latestVersion,
        applicationLatestVersion:EXECUTABLE_MIGRATIONS.at(-1)?.version||0,
        ledgerPresent:migrationState.ledgerPresent,
        stateDigest:keyedJsonDigest(key,'migration-state',{
          classification:migrationState.classification,
          currentVersion:migrationState.currentVersion,
          latestVersion:migrationState.latestVersion,
          schemaExact:migrationState.schemaExact,
          ready:migrationState.ready,
        }),
        ledgerRows:ledger.count,
        ledgerDigest:ledger.digest,
      },
      schema:{
        manifestVersion:SCHEMA_MANIFEST.version,
        manifestChecksum:SCHEMA_MANIFEST.checksum,
        expectedSchemaChecksum:schemaContract.checksum,
        executableMigrationsChecksum:executableChecksum(migrations),
        schemaDigest,
      },
      storage:{
        sequenceRows:sequences.count,
        sequenceDigest:sequences.digest,
      },
      totals:{
        tableCount:tables.length,
        legacyTableCount:legacyTables.length,
        rowCount:tables.reduce((total,table)=>total+table.count,0),
        valueBytes:Number(context.totalValueBytes),
      },
      tables,
    };
    const payload=evidencePayload(value);
    const result={...payload,bindingDigest:keyedJsonDigest(key,'evidence-binding',payload)};
    return publicBackupEvidenceResult(result);
  }catch(error){
    if(error instanceof BackupEvidenceError) throw error;
    throw new BackupEvidenceError('BACKUP_EVIDENCE_FAILED','Backup evidence collection failed',{cause:error});
  }finally{
    if(transaction) await closeReadTransaction(transaction);
    key.fill(0);
  }
}

function hexDigest(value){ return typeof value==='string'&&/^[a-f0-9]{64}$/.test(value); }

function sameDigest(left,right){
  if(!hexDigest(left)||!hexDigest(right)) return false;
  return timingSafeEqual(Buffer.from(left,'hex'),Buffer.from(right,'hex'));
}

function authenticateEvidence(value,key,role,now,maxEvidenceAgeMs){
  if(!value||value.kind!=='database-evidence'||value.format!==BACKUP_EVIDENCE_FORMAT
    ||value.role!==role||!hexDigest(value.bindingDigest)){
    fail('BACKUP_EVIDENCE_AUTHENTICATION_FAILED','Evidence envelope is invalid',{
      reason:'binding',
    });
  }
  let payload;
  try{ payload=evidencePayload(value); }catch{
    fail('BACKUP_EVIDENCE_AUTHENTICATION_FAILED','Evidence envelope is invalid',{
      reason:'binding',
    });
  }
  const expected=keyedJsonDigest(key,'evidence-binding',payload);
  if(!sameDigest(value.bindingDigest,expected)){
    fail('BACKUP_EVIDENCE_AUTHENTICATION_FAILED','Evidence binding is invalid',{
      reason:'binding',
    });
  }
  const collected=canonicalTimestamp(value.collectedAt,'evidence timestamp');
  const expires=canonicalTimestamp(value.expiresAt,'evidence expiration');
  const age=now-collected.milliseconds;
  if(age<0||age>maxEvidenceAgeMs||now>expires.milliseconds
    ||expires.milliseconds-collected.milliseconds!==value.policy?.maxEvidenceAgeMs){
    fail('BACKUP_EVIDENCE_STALE','Evidence age is invalid',{reason:'evidence_age'});
  }
  return payload;
}

function mismatch(reason){
  fail('BACKUP_EVIDENCE_MISMATCH','Backup and restore evidence differ',{reason});
}

function exactJson(left,right){ return stableJson(left)===stableJson(right); }

function validateEvidenceShape(value){
  if(value.checks?.integrity!==true||value.checks?.foreignKeys!==true) mismatch('integrity');
  const selectedVersion=value.migration?.selectedVersion;
  if(!Number.isSafeInteger(selectedVersion)||selectedVersion<1
    ||selectedVersion>EXECUTABLE_MIGRATIONS.length) mismatch('migration');
  const migrations=EXECUTABLE_MIGRATIONS.slice(0,selectedVersion);
  const contract=schemaContractAtVersion(selectedVersion);
  if(value.schema?.manifestVersion!==SCHEMA_MANIFEST.version
    ||value.schema?.manifestChecksum!==SCHEMA_MANIFEST.checksum
    ||value.schema?.expectedSchemaChecksum!==contract.checksum
    ||value.schema?.executableMigrationsChecksum!==executableChecksum(migrations)
    ||!hexDigest(value.schema?.schemaDigest)) mismatch('schema');
  if(!Number.isSafeInteger(value.storage?.sequenceRows)||value.storage.sequenceRows<0
    ||!hexDigest(value.storage?.sequenceDigest)) mismatch('sequence');
  const managed=value.migration.classification==='managed'
    &&value.migration.ledgerPresent===true
    &&value.migration.currentVersion===selectedVersion
    &&value.migration.ledgerRows===selectedVersion;
  const unmanaged=value.migration.classification==='unmanaged'
    &&value.migration.ledgerPresent===false
    &&value.migration.currentVersion===0
    &&value.migration.ledgerRows===0;
  if((!managed&&!unmanaged)||value.migration.latestVersion!==selectedVersion
    ||value.migration.applicationLatestVersion!==(EXECUTABLE_MIGRATIONS.at(-1)?.version||0)
    ||!hexDigest(value.migration.stateDigest)||!hexDigest(value.migration.ledgerDigest)){
    mismatch('migration');
  }
  const managedNames=contract.tables.map(table=>table.name);
  const toleratedNames=new Set(SCHEMA_MANIFEST.toleratedLegacyTables
    .filter(name=>name!=='schema_migrations'));
  if(!Array.isArray(value.tables)||value.tables.length<managedNames.length
    ||value.tables.some((table,index)=>(index<managedNames.length
      ?table?.name!==managedNames[index]
      :!toleratedNames.has(table?.name))
      ||!Number.isSafeInteger(table.count)||table.count<0||!hexDigest(table.digest))){
    mismatch('table_set');
  }
  const legacyNames=value.tables.slice(managedNames.length).map(table=>table.name);
  if(new Set(legacyNames).size!==legacyNames.length
    ||!exactJson(legacyNames,[...legacyNames].sort())) mismatch('table_set');
  const rowCount=value.tables.reduce((total,table)=>total+table.count,0);
  if(value.totals?.tableCount!==value.tables.length
    ||value.totals?.legacyTableCount!==legacyNames.length
    ||value.totals?.rowCount!==rowCount
    ||!Number.isSafeInteger(value.totals?.valueBytes)||value.totals.valueBytes<0){
    mismatch('row_count');
  }
  for(const name of ['maxSnapshotAgeMs','maxEvidenceAgeMs','rpoTargetMs','rtoTargetMs']){
    const duration=value.policy?.[name];
    if(!Number.isSafeInteger(duration)||duration<1||duration>BACKUP_EVIDENCE_LIMITS.maxPolicyMs){
      mismatch('policy');
    }
  }
  if(!hexDigest(value.bindings?.identityDigest)||!hexDigest(value.bindings?.backupRefDigest)
    ||typeof value.bindings?.repoCommit!=='string'
    ||!/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(value.bindings.repoCommit)) mismatch('binding');
  const collected=canonicalTimestamp(value.collectedAt,'evidence timestamp');
  const pitr=canonicalTimestamp(value.pitrAt,'PITR timestamp');
  if(value.timings?.snapshotAgeMs!==collected.milliseconds-pitr.milliseconds
    ||value.timings.snapshotAgeMs<0
    ||value.timings.snapshotAgeMs>value.policy?.maxSnapshotAgeMs
    ||value.timings.rpoMet!==(value.timings.snapshotAgeMs<=value.policy?.rpoTargetMs)){
    mismatch('timestamp');
  }
  if(value.role==='source'){
    if(value.timings.restoreStartedAt!==null||value.timings.restoreCompletedAt!==null
      ||value.timings.restoreDurationMs!==null||value.timings.rtoMet!==null) mismatch('timestamp');
  }else{
    const started=canonicalTimestamp(value.timings?.restoreStartedAt,'restore start timestamp');
    const completed=canonicalTimestamp(value.timings?.restoreCompletedAt,'restore completion timestamp');
    const duration=completed.milliseconds-started.milliseconds;
    if(started.milliseconds<pitr.milliseconds||completed.milliseconds>collected.milliseconds
      ||value.timings.restoreDurationMs!==duration
      ||value.timings.rtoMet!==(duration<=value.policy?.rtoTargetMs)) mismatch('timestamp');
  }
}

function validateAbsentLedgerSentinel(value,key){
  if(value.migration.ledgerPresent) return;
  const expected=keyedJsonDigest(key,'migration-ledger-absence',{
    present:false,selectedVersion:value.migration.selectedVersion,
  });
  if(!sameDigest(value.migration.ledgerDigest,expected)) mismatch('ledger');
}

export function compareBackupRestoreEvidence(options={}){
  const key=hmacKey(options.hmacKey);
  try{
    const sourceIdentity=opaque(options.sourceIdentity,'source identity',BACKUP_EVIDENCE_LIMITS.maxIdentityBytes);
    const restoreIdentity=opaque(options.restoreIdentity,'restore identity',BACKUP_EVIDENCE_LIMITS.maxIdentityBytes);
    if(sourceIdentity===restoreIdentity){
      fail('BACKUP_EVIDENCE_IDENTITY_INVALID','Source and restore identities must differ',{
        reason:'identity_reused',
      });
    }
    const backupRef=opaque(options.backupRef,'backup reference',BACKUP_EVIDENCE_LIMITS.maxBackupRefBytes);
    const repoCommit=repositoryCommit(options.repoCommit);
    const pitrAt=canonicalTimestamp(options.pitrAt,'PITR timestamp').value;
    const expectedPolicy=policy(options);
    const clock=typeof options.clock==='function'?options.clock:Date.now;
    const now=clockMilliseconds(clock);
    const source=authenticateEvidence(
      options.sourceEvidence,key,'source',now,expectedPolicy.maxEvidenceAgeMs,
    );
    const restored=authenticateEvidence(
      options.restoredEvidence,key,'restore',now,expectedPolicy.maxEvidenceAgeMs,
    );
    validateEvidenceShape(source);
    validateEvidenceShape(restored);
    validateAbsentLedgerSentinel(source,key);
    validateAbsentLedgerSentinel(restored,key);

    const expectedSource=keyedDigest(key,'database-identity',sourceIdentity);
    const expectedRestore=keyedDigest(key,'database-identity',restoreIdentity);
    if(!sameDigest(source.bindings?.identityDigest,expectedSource)
      ||!sameDigest(restored.bindings?.identityDigest,expectedRestore)) mismatch('identity');
    if(sameDigest(source.bindings.identityDigest,restored.bindings.identityDigest)) mismatch('identity_reused');
    const expectedBackupRef=keyedDigest(key,'backup-reference',backupRef);
    if(!sameDigest(source.bindings?.backupRefDigest,expectedBackupRef)
      ||!sameDigest(restored.bindings?.backupRefDigest,expectedBackupRef)) mismatch('backup_ref');
    if(source.bindings?.repoCommit!==repoCommit||restored.bindings?.repoCommit!==repoCommit) mismatch('repo_commit');
    if(source.pitrAt!==pitrAt||restored.pitrAt!==pitrAt) mismatch('pitr');
    if(!exactJson(source.policy,restored.policy)||!exactJson(source.policy,expectedPolicy)) mismatch('policy');
    const sourceCollected=canonicalTimestamp(source.collectedAt,'source evidence timestamp');
    const restoredCollected=canonicalTimestamp(restored.collectedAt,'restore evidence timestamp');
    const restoreStarted=canonicalTimestamp(restored.timings.restoreStartedAt,'restore start timestamp');
    if(sourceCollected.milliseconds>restoreStarted.milliseconds
      ||restoreStarted.milliseconds>restoredCollected.milliseconds) mismatch('ordering');
    if(source.timings.rpoMet!==true||restored.timings.rpoMet!==true) mismatch('rpo');
    if(restored.timings.rtoMet!==true) mismatch('rto');
    if(!exactJson(source.schema,restored.schema)) mismatch('schema');
    if(!exactJson(source.migration,restored.migration)) mismatch('migration');
    if(!exactJson(source.storage,restored.storage)) mismatch('sequence');
    if(source.tables.length!==restored.tables.length) mismatch('table_set');
    for(let index=0;index<source.tables.length;index+=1){
      const left=source.tables[index];
      const right=restored.tables[index];
      if(left.name!==right.name) mismatch('table_set');
      if(left.count!==right.count) mismatch('row_count');
      if(!sameDigest(left.digest,right.digest)) mismatch('table_digest');
    }
    const value={
      verifiedAt:new Date(now).toISOString(),
      sourceEvidenceDigest:options.sourceEvidence.bindingDigest,
      restoredEvidenceDigest:options.restoredEvidence.bindingDigest,
      tableCount:source.totals.tableCount,
      totalRows:source.totals.rowCount,
      sequenceRows:source.storage.sequenceRows,
      sourceSnapshotAgeMs:source.timings.snapshotAgeMs,
      restoredSnapshotAgeMs:restored.timings.snapshotAgeMs,
      sourceCollectedAt:source.collectedAt,
      restoredCollectedAt:restored.collectedAt,
      restoreStartedAt:restored.timings.restoreStartedAt,
      restoreCompletedAt:restored.timings.restoreCompletedAt,
      restoreDurationMs:restored.timings.restoreDurationMs,
      rpoTargetMs:source.policy.rpoTargetMs,
      rtoTargetMs:source.policy.rtoTargetMs,
      rpoMet:source.timings.rpoMet&&restored.timings.rpoMet,
      rtoMet:restored.timings.rtoMet,
    };
    const payload=comparisonPayload(value);
    return publicBackupEvidenceResult({
      ...payload,
      comparisonDigest:keyedJsonDigest(key,'restore-comparison',payload),
    });
  }catch(error){
    if(error instanceof BackupEvidenceError) throw error;
    throw new BackupEvidenceError('BACKUP_EVIDENCE_FAILED','Backup evidence comparison failed',{cause:error});
  }finally{
    key.fill(0);
  }
}
