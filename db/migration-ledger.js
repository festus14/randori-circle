import { inspectSchema } from './schema-inspector.js';
import { checksum } from './schema-manifest.js';

export const MIGRATION_LEDGER_TABLE='schema_migrations';
export const MIGRATION_LEDGER_SQL=`CREATE TABLE IF NOT EXISTS schema_migrations (
  version INTEGER PRIMARY KEY CHECK(version>0),
  name TEXT NOT NULL UNIQUE,
  checksum TEXT NOT NULL CHECK(length(checksum)=64 AND checksum NOT GLOB '*[^0-9a-f]*'),
  applied_at TEXT NOT NULL DEFAULT (datetime('now')),
  execution_ms INTEGER NOT NULL CHECK(execution_ms>=0),
  disposition TEXT NOT NULL CHECK(disposition IN ('applied','adopted'))
)`;
export const MIGRATION_LEDGER_CHECKSUM=checksum(MIGRATION_LEDGER_SQL);
export const PINNED_MIGRATION_LEDGER_CHECKSUM='a3f3c8a9ec8ffb12d2f9b8ddf0f837cf9e46a4f1e623150829e33d485c13d876';

if(MIGRATION_LEDGER_CHECKSUM!==PINNED_MIGRATION_LEDGER_CHECKSUM){
  throw new Error(`Migration ledger contract changed: ${MIGRATION_LEDGER_CHECKSUM}`);
}

export class MigrationError extends Error{
  constructor(code,message,{cause,details}={}){
    super(message,cause?{cause}:undefined);
    this.name='MigrationError';
    this.code=code;
    if(details!==undefined) this.details=details;
  }
}

export class MigrationLedgerError extends MigrationError{
  constructor(message,details){
    super('MIGRATION_LEDGER_INVALID',message,{details});
    this.name='MigrationLedgerError';
  }
}

const LEDGER_MANIFEST=Object.freeze({
  version:1,
  checksum:MIGRATION_LEDGER_CHECKSUM,
  tables:Object.freeze([Object.freeze({name:MIGRATION_LEDGER_TABLE,sql:MIGRATION_LEDGER_SQL})]),
  indexes:Object.freeze([]),
  toleratedLegacyTables:Object.freeze([]),
});

export async function migrationLedgerExists(db){
  const result=await db.execute({
    sql:`SELECT 1 AS present FROM sqlite_schema WHERE type='table' AND name=? LIMIT 1`,
    args:[MIGRATION_LEDGER_TABLE],
  });
  return !!result.rows?.length;
}

export async function assertMigrationLedgerContract(db){
  const status=await inspectSchema(db,{manifest:LEDGER_MANIFEST});
  const ledgerBlockers=status.blockers.filter(blocker=>
    blocker.artifact?.name===MIGRATION_LEDGER_TABLE
      ||String(blocker.artifact?.name||'').startsWith(`${MIGRATION_LEDGER_TABLE}.`),
  );
  if(ledgerBlockers.length){
    throw new MigrationLedgerError('Migration ledger has an incompatible schema',{
      blockers:ledgerBlockers.map(blocker=>blocker.code),
    });
  }
  const ownedObjects=await db.execute({
    sql:`SELECT type,name FROM sqlite_schema
      WHERE tbl_name=? AND type IN ('index','trigger') ORDER BY type,name`,
    args:[MIGRATION_LEDGER_TABLE],
  });
  const unexpectedOwnedObjects=(ownedObjects.rows||[])
    .filter(row=>!String(row.name).startsWith('sqlite_autoindex_'))
    .map(row=>({type:String(row.type),name:String(row.name)}));
  if(unexpectedOwnedObjects.length){
    throw new MigrationLedgerError('Migration ledger has unexpected schema objects',{
      unexpectedObjects:unexpectedOwnedObjects,
    });
  }
  return true;
}

export async function createMigrationLedger(db){
  await db.execute(MIGRATION_LEDGER_SQL);
  await assertMigrationLedgerContract(db);
}

export async function readMigrationLedger(db){
  const result=await db.execute(`SELECT version,name,checksum,applied_at,execution_ms,disposition
    FROM schema_migrations ORDER BY version`);
  return result.rows||[];
}

function validLedgerTimestamp(value){
  const match=/^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})(?:\.\d+)?$/.exec(String(value||''));
  if(!match) return false;
  const [year,month,day,hour,minute,second]=match.slice(1,7).map(Number);
  const leapYear=year%4===0&&(year%100!==0||year%400===0);
  const daysInMonth=[31,leapYear?29:28,31,30,31,30,31,31,30,31,30,31];
  return month>=1&&month<=12&&day>=1&&day<=daysInMonth[month-1]
    &&hour<=23&&minute<=59&&second<=59;
}

export function validateMigrationLedger(rows,migrations){
  if(!Array.isArray(rows)) throw new MigrationLedgerError('Migration ledger rows must be an array');
  const normalized=[];
  let appliedDispositionSeen=false;
  rows.forEach((row,index)=>{
    const version=Number(row.version);
    const expectedVersion=index+1;
    if(!Number.isSafeInteger(version)||version!==expectedVersion){
      throw new MigrationLedgerError(`Migration ledger has a gap at version ${expectedVersion}`,{
        expectedVersion,
      });
    }
    const expected=migrations[index];
    if(!expected){
      throw new MigrationLedgerError('Database schema is newer than this application',{
        databaseVersion:version,
        applicationVersion:migrations.at(-1)?.version||0,
      });
    }
    if(String(row.name)!==expected.name||String(row.checksum)!==expected.checksum){
      throw new MigrationLedgerError(`Migration ${version} does not match the immutable manifest`,{
        version,
      });
    }
    const executionMs=Number(row.execution_ms);
    const disposition=String(row.disposition||'');
    if(!validLedgerTimestamp(row.applied_at)
      ||!Number.isSafeInteger(executionMs)||executionMs<0
      ||!['applied','adopted'].includes(disposition)
      ||(disposition==='adopted'&&(executionMs!==0||appliedDispositionSeen))){
      throw new MigrationLedgerError(`Migration ${version} has invalid ledger metadata`,{version});
    }
    if(disposition==='applied') appliedDispositionSeen=true;
    normalized.push(Object.freeze({
      version,
      name:String(row.name),
      checksum:String(row.checksum),
      appliedAt:String(row.applied_at),
      executionMs,
      disposition,
    }));
  });
  return Object.freeze({
    currentVersion:normalized.at(-1)?.version||0,
    rows:Object.freeze(normalized),
  });
}

export async function insertMigrationLedgerRow(db,migration,{executionMs,disposition}){
  if(!Number.isSafeInteger(executionMs)||executionMs<0) throw new TypeError('executionMs must be a non-negative safe integer');
  if(!['applied','adopted'].includes(disposition)) throw new TypeError('invalid migration disposition');
  await db.execute({
    sql:`INSERT INTO schema_migrations (version,name,checksum,execution_ms,disposition)
      VALUES (?,?,?,?,?)`,
    args:[migration.version,migration.name,migration.checksum,executionMs,disposition],
  });
}
