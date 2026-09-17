import { MigrationError, MigrationLedgerError } from './errors.js';
import { LATEST_SCHEMA_VERSION, MIGRATIONS } from './migrations/index.js';
import { INDEX_DEFINITIONS, assertCompatibleExistingIndex } from './schema.js';

export { LATEST_SCHEMA_VERSION, MIGRATIONS } from './migrations/index.js';
export { MigrationError, MigrationLedgerError, MigrationPreflightError } from './errors.js';

export const MIGRATION_LEDGER_TABLE='schema_migrations';
export const MIGRATION_LEDGER_SQL=`CREATE TABLE IF NOT EXISTS schema_migrations (
  version INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  checksum TEXT NOT NULL,
  applied_at TEXT NOT NULL DEFAULT (datetime('now')),
  execution_ms INTEGER NOT NULL
)`;

const LEDGER_COLUMNS=Object.freeze(['version','name','checksum','applied_at','execution_ms']);
export const MIGRATION_LEDGER_CONTRACT=Object.freeze({
  version:Object.freeze({type:'INTEGER',notNull:false,primaryKeyPosition:1,defaultValue:null}),
  name:Object.freeze({type:'TEXT',notNull:true,primaryKeyPosition:0,defaultValue:null}),
  checksum:Object.freeze({type:'TEXT',notNull:true,primaryKeyPosition:0,defaultValue:null}),
  applied_at:Object.freeze({type:'TEXT',notNull:true,primaryKeyPosition:0,defaultValue:"datetime('now')"}),
  execution_ms:Object.freeze({type:'INTEGER',notNull:true,primaryKeyPosition:0,defaultValue:null}),
});
const DEFAULT_RETRY_OPTIONS=Object.freeze({maxAttempts:4,baseDelayMs:50,maxDelayMs:500});

function sleep(ms) {
  return new Promise(resolve=>setTimeout(resolve,ms));
}

export function isRetryableDatabaseError(error) {
  const values=[];
  let current=error;
  for(let depth=0;current && depth<4;depth+=1){
    values.push(current.code,current.rawCode,current.message);
    current=current.cause;
  }
  return /SQLITE_BUSY|SQLITE_LOCKED|database (?:table )?is locked|write conflict|transaction conflict/i
    .test(values.filter(Boolean).join(' '));
}

function retryOptions(options={}) {
  const maxAttempts=Number(options.maxAttempts??DEFAULT_RETRY_OPTIONS.maxAttempts);
  const baseDelayMs=Number(options.baseDelayMs??DEFAULT_RETRY_OPTIONS.baseDelayMs);
  const maxDelayMs=Number(options.maxDelayMs??DEFAULT_RETRY_OPTIONS.maxDelayMs);
  if(!Number.isInteger(maxAttempts)||maxAttempts<1||maxAttempts>10){
    throw new TypeError('maxAttempts must be an integer between 1 and 10');
  }
  if(!Number.isFinite(baseDelayMs)||baseDelayMs<0||baseDelayMs>5000){
    throw new TypeError('baseDelayMs must be between 0 and 5000');
  }
  if(!Number.isFinite(maxDelayMs)||maxDelayMs<baseDelayMs||maxDelayMs>10000){
    throw new TypeError('maxDelayMs must be between baseDelayMs and 10000');
  }
  return {maxAttempts,baseDelayMs,maxDelayMs,sleep:options.sleep||sleep};
}

export async function withDatabaseRetry(operation, options={}) {
  const {maxAttempts,baseDelayMs,maxDelayMs,sleep:wait}=retryOptions(options);
  let lastError;
  for(let attempt=1;attempt<=maxAttempts;attempt+=1){
    try{ return await operation(attempt); }
    catch(error){
      lastError=error;
      if(attempt===maxAttempts || !isRetryableDatabaseError(error)) throw error;
      const delay=Math.min(maxDelayMs,baseDelayMs*(2**(attempt-1)));
      await wait(delay);
    }
  }
  throw lastError;
}

export function validateMigrationManifest(migrations=MIGRATIONS) {
  if(!Array.isArray(migrations)||migrations.length===0){
    throw new MigrationLedgerError('Migration manifest must not be empty');
  }
  migrations.forEach((migration,index)=>{
    const expected=index+1;
    if(migration.version!==expected){
      throw new MigrationLedgerError(`Migration manifest has a gap at version ${expected}`);
    }
    if(typeof migration.name!=='string'||!migration.name){
      throw new MigrationLedgerError(`Migration ${expected} has no name`);
    }
    if(!/^[a-f0-9]{64}$/.test(migration.checksum||'')){
      throw new MigrationLedgerError(`Migration ${expected} has an invalid checksum`);
    }
    if(typeof migration.up!=='function'){
      throw new MigrationLedgerError(`Migration ${expected} has no up function`);
    }
  });
  return true;
}

export function validateMigrationLedger(rows, migrations=MIGRATIONS) {
  validateMigrationManifest(migrations);
  if(!Array.isArray(rows)) throw new MigrationLedgerError('Migration ledger rows must be an array');
  const ordered=[...rows].sort((a,b)=>Number(a.version)-Number(b.version));
  const seen=new Set();
  for(let index=0;index<ordered.length;index+=1){
    const row=ordered[index];
    const version=Number(row.version);
    if(!Number.isSafeInteger(version)||version<=0||seen.has(version)){
      throw new MigrationLedgerError('Migration ledger contains an invalid or duplicate version',{version:row.version});
    }
    seen.add(version);
    if(version!==index+1){
      throw new MigrationLedgerError(`Migration ledger has a gap before version ${version}`,{expected:index+1,actual:version});
    }
    const expected=migrations[version-1];
    if(!expected){
      throw new MigrationLedgerError(`Database schema version ${version} is newer than this application`,{
        databaseVersion:version,
        applicationVersion:migrations.at(-1)?.version||0,
      });
    }
    if(String(row.name)!==expected.name){
      throw new MigrationLedgerError(`Migration ${version} name does not match the immutable manifest`,{
        expected:expected.name,
        actual:String(row.name),
      });
    }
    if(String(row.checksum)!==expected.checksum){
      throw new MigrationLedgerError(`Migration ${version} checksum does not match the immutable manifest`,{
        expected:expected.checksum,
        actual:String(row.checksum),
      });
    }
  }
  return {currentVersion:ordered.length?Number(ordered.at(-1).version):0,rows:ordered};
}

async function verifyLedgerShape(db) {
  const result=await db.execute(`PRAGMA table_info("${MIGRATION_LEDGER_TABLE}")`);
  const rows=result.rows||[];
  const present=new Set(rows.map(row=>String(row.name)));
  const missing=LEDGER_COLUMNS.filter(column=>!present.has(column));
  const drift=[];
  for(const row of rows){
    const name=String(row.name);
    const expected=MIGRATION_LEDGER_CONTRACT[name];
    if(!expected) continue;
    const actual={
      type:String(row.type||'').trim().toUpperCase(),
      notNull:Number(row.notnull)===1,
      primaryKeyPosition:Number(row.pk)||0,
      defaultValue:row.dflt_value===null||row.dflt_value===undefined
        ? null
        : String(row.dflt_value).replace(/^\((.*)\)$/,'$1').trim(),
    };
    const mismatches=Object.entries(expected)
      .filter(([property,value])=>actual[property]!==value)
      .map(([property,value])=>({property,expected:value,actual:actual[property]}));
    if(mismatches.length) drift.push({column:name,mismatches});
  }
  if(missing.length||drift.length){
    throw new MigrationLedgerError('Migration ledger has an incompatible schema',{
      missingColumns:missing,
      columnDrift:drift,
    });
  }
}

export async function readMigrationLedger(db) {
  const result=await db.execute(`SELECT version,name,checksum,applied_at,execution_ms
    FROM ${MIGRATION_LEDGER_TABLE} ORDER BY version`);
  return result.rows||[];
}

export async function ensureMigrationLedger(db, options={}) {
  await withDatabaseRetry(async()=>{
    await db.execute(MIGRATION_LEDGER_SQL);
    await verifyLedgerShape(db);
  },options);
}

async function preflightExistingIndexes(db, options={}) {
  await withDatabaseRetry(async()=>{
    for(const definition of INDEX_DEFINITIONS){
      await assertCompatibleExistingIndex(db,definition);
    }
  },options);
}

async function applyMigrationTransaction(db,migration) {
  const transaction=await db.transaction('write');
  const startedAt=Date.now();
  try{
    const existing=await transaction.execute({
      sql:`SELECT version,name,checksum,applied_at,execution_ms FROM ${MIGRATION_LEDGER_TABLE} WHERE version=?`,
      args:[migration.version],
    });
    if(existing.rows?.length){
      const row=existing.rows[0];
      if(String(row.name)!==migration.name||String(row.checksum)!==migration.checksum){
        throw new MigrationLedgerError(
          `Migration ${migration.version} does not match the immutable manifest`,
          {version:migration.version},
        );
      }
      // Another deploy may have committed this version while we were waiting
      // for the write lock. This transaction has no changes, so rollback avoids
      // an unnecessary COMMIT lock escalation on local libSQL/SQLite clients.
      await transaction.rollback();
      return {applied:false};
    }

    await migration.up(transaction);
    const durationMs=Math.max(0,Date.now()-startedAt);
    await transaction.execute({
      sql:`INSERT INTO ${MIGRATION_LEDGER_TABLE} (version,name,checksum,execution_ms) VALUES (?,?,?,?)`,
      args:[migration.version,migration.name,migration.checksum,durationMs],
    });
    await transaction.commit();
    return {
      applied:true,
      record:{
        version:migration.version,
        name:migration.name,
        checksum:migration.checksum,
        durationMs,
      },
    };
  }catch(error){
    try{ if(!transaction.closed) await transaction.rollback(); }catch{}
    throw error;
  }finally{
    transaction.close();
  }
}

export async function runMigrations(db, options={}) {
  if(!db||typeof db.execute!=='function'||typeof db.transaction!=='function'){
    throw new TypeError('A libSQL-compatible client is required');
  }
  const migrations=options.migrations||MIGRATIONS;
  validateMigrationManifest(migrations);
  try{
    await preflightExistingIndexes(db,options);
  }catch(error){
    if(error instanceof MigrationError) throw error;
    throw new MigrationError('Migration index preflight failed',{cause:error});
  }
  try{
    await ensureMigrationLedger(db,options);
  }catch(error){
    if(error instanceof MigrationError) throw error;
    throw new MigrationError('Migration ledger initialization failed',{cause:error});
  }

  let initialRows;
  try{ initialRows=await withDatabaseRetry(()=>readMigrationLedger(db),options); }
  catch(error){
    if(error instanceof MigrationError) throw error;
    throw new MigrationError('Migration ledger could not be read',{cause:error});
  }
  const initial=validateMigrationLedger(initialRows,migrations);
  const applied=[];

  for(const migration of migrations.slice(initial.currentVersion)){
    let result;
    try{
      result=await withDatabaseRetry(()=>applyMigrationTransaction(db,migration),options);
    }catch(error){
      if(error instanceof MigrationError) throw error;
      throw new MigrationError(`Migration ${migration.version} (${migration.name}) failed`,{
        cause:error,
        details:{version:migration.version,name:migration.name},
      });
    }
    if(result.applied) applied.push(result.record);
  }

  let finalRows;
  try{ finalRows=await withDatabaseRetry(()=>readMigrationLedger(db),options); }
  catch(error){
    if(error instanceof MigrationError) throw error;
    throw new MigrationError('Migration ledger verification failed',{cause:error});
  }
  const finalState=validateMigrationLedger(finalRows,migrations);
  return {
    ok:true,
    fromVersion:initial.currentVersion,
    toVersion:finalState.currentVersion,
    latestVersion:migrations.at(-1)?.version||LATEST_SCHEMA_VERSION,
    applied,
  };
}
