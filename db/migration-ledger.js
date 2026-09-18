import { checksum } from './schema-manifest.js';
import {
  MIGRATION_LEDGER_TABLE,
  assertMigrationLedgerContract,
} from './migration-ledger-readiness.js';
export {
  MIGRATION_LEDGER_TABLE,
  MIGRATION_LEDGER_READINESS_MANIFEST,
  MigrationError,
  MigrationLedgerError,
  assertMigrationLedgerContract,
  migrationLedgerExists,
  readMigrationLedger,
  validateMigrationLedger,
} from './migration-ledger-readiness.js';

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

export async function createMigrationLedger(db){
  await db.execute(MIGRATION_LEDGER_SQL);
  await assertMigrationLedgerContract(db);
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
