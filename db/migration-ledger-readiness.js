import { inspectSchema } from './schema-inspector.js';

export const MIGRATION_LEDGER_TABLE='schema_migrations';

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

// Generated from MIGRATION_LEDGER_SQL. This request-safe projection contains
// no executable schema statement; its parity is enforced in unit tests.
export const MIGRATION_LEDGER_READINESS_MANIFEST=Object.freeze({"version":1,"checksum":"a3f3c8a9ec8ffb12d2f9b8ddf0f837cf9e46a4f1e623150829e33d485c13d876","tables":[{"name":"schema_migrations","columns":[{"name":"version","type":"INTEGER","notNull":false,"primaryKeyPosition":1,"defaultValue":null,"hidden":0},{"name":"name","type":"TEXT","notNull":true,"primaryKeyPosition":0,"defaultValue":null,"hidden":0},{"name":"checksum","type":"TEXT","notNull":true,"primaryKeyPosition":0,"defaultValue":null,"hidden":0},{"name":"applied_at","type":"TEXT","notNull":true,"primaryKeyPosition":0,"defaultValue":"datetime('now')","hidden":0},{"name":"execution_ms","type":"INTEGER","notNull":true,"primaryKeyPosition":0,"defaultValue":null,"hidden":0},{"name":"disposition","type":"TEXT","notNull":true,"primaryKeyPosition":0,"defaultValue":null,"hidden":0}],"constraints":{"checks":["disposition in('applied','adopted')","execution_ms>=0","length(checksum)=64 and checksum not glob '*[^0-9a-f]*'","version>0"],"autoincrementColumns":[],"collations":[],"conflictPolicies":[{"constraint":"NOT NULL","target":["applied_at"],"policy":"ABORT"},{"constraint":"NOT NULL","target":["checksum"],"policy":"ABORT"},{"constraint":"NOT NULL","target":["disposition"],"policy":"ABORT"},{"constraint":"NOT NULL","target":["execution_ms"],"policy":"ABORT"},{"constraint":"NOT NULL","target":["name"],"policy":"ABORT"},{"constraint":"PRIMARY KEY","target":[{"expression":"version","collation":"BINARY","descending":false}],"policy":"ABORT"},{"constraint":"UNIQUE","target":[{"expression":"name","collation":"BINARY","descending":false}],"policy":"ABORT"}],"primaryKeyTerms":[{"expression":"version","collation":"BINARY","descending":false}],"tableOptions":[],"foreignKeys":[],"foreignKeyTimings":[],"unique":[[{"expression":"name","collation":"BINARY","descending":false}]]}}],"indexes":[],"toleratedLegacyTables":[]});

export async function migrationLedgerExists(db){
  const result=await db.execute({
    sql:`SELECT 1 AS present FROM sqlite_schema WHERE type='table' AND name=? LIMIT 1`,
    args:[MIGRATION_LEDGER_TABLE],
  });
  return !!result.rows?.length;
}

export async function assertMigrationLedgerContract(db){
  const status=await inspectSchema(db,{manifest:MIGRATION_LEDGER_READINESS_MANIFEST});
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

export async function readMigrationLedger(db,{limit}={}){
  if(limit!==undefined&&(!Number.isSafeInteger(limit)||limit<1||limit>1_000)){
    throw new TypeError('migration ledger limit must be a positive safe integer no greater than 1000');
  }
  const statement=`SELECT version,name,checksum,applied_at,execution_ms,disposition
    FROM schema_migrations ORDER BY version`;
  const result=limit===undefined
    ?await db.execute(statement)
    :await db.execute({sql:`${statement} LIMIT ?`,args:[limit]});
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
