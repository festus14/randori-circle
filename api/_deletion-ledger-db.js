// Durable deletion ledger in a SEPARATE Turso database (issue #383, ID-89
// follow-up). Owner decision 2026-10-27: the ledger lives in its own
// database so a restore from a destroyed source database can still
// re-apply post-restore-point deletions. A ledger table inside the app
// database would roll back with the restore it is meant to repair.
//
// This module is the ledger-DB client plus the read/write/purge/destroy
// statements for that database. It contains NO DDL: the ledger schema
// (`DELETION_LEDGER_DB_SCHEMA`, `scripts/deletion-ledger.mjs init`) is
// created by the operator CLI, never from an API request path, and the
// app database is untouched — there is no app-DB migration for the
// ledger. The ledger DB's own schema is versioned by
// DELETION_LEDGER_DB_SCHEMA_VERSION; a future schema change is a new
// version with its own operator step, not an app migration.
//
// One entry per tombstoned account, and nothing else — the same shape
// `scripts/deletion-ledger.mjs` consumes:
//   {account_id, deleted_at, created_at}
// `deleted_at` is the deletion instant (canonical ISO), or null when the
// deletion time is unknown; a null entry is always treated as due, so the
// fail-safe direction is to re-apply. `created_at` is the account's
// creation time (canonical ISO). No email, no name, no other column.
//
// The writer in `api/_account-deletion.js` calls this after the app-DB
// deletion transaction commits, never before: the two databases cannot
// share a transaction, and a ledger entry for an account whose deletion
// did not commit would re-apply a deletion that never happened. A
// ledger-write failure after the commit is surfaced to the caller (the
// deletion itself stands); a retry re-enters through the
// already-deleted path, which backfills the entry from the audit trail.
//
// Configuration is presence-based: with neither
// DELETION_LEDGER_DATABASE_URL nor DELETION_LEDGER_AUTH_TOKEN set the
// writer is a no-op. That is the state until the owner provisions the
// second production database and wires credentials (#440, owner-only);
// config-only prod wiring follows in #444. This PR provisions no prod
// database, touches no prod credential, and wires no prod env.
import { createClient } from '@libsql/client';

export const DELETION_LEDGER_DATABASE_URL_ENV='DELETION_LEDGER_DATABASE_URL';
export const DELETION_LEDGER_AUTH_TOKEN_ENV='DELETION_LEDGER_AUTH_TOKEN';
export const DELETION_LEDGER_DB_SCHEMA_VERSION=1;
export const DELETION_LEDGER_TABLE='deletion_ledger';

// The schema lives in scripts/deletion-ledger.mjs (operator CLI), not
// here, so no DDL literal exists in any api/ file (see check:runtime-ddl).

// Canonical millisecond ISO timestamps only: lexicographic comparison is
// then chronological, which the restore-point filter and the purge
// cutoff rely on. Mirrors the ledger timestamp rule in
// api/_account-deletion.js (kept separate: this module must not import
// that module, and that module imports this one).
const ISO_TIMESTAMP=/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

export function ledgerDbTimestamp(value,label){
  if(typeof value!=='string'||!ISO_TIMESTAMP.test(value)||Number.isNaN(Date.parse(value))){
    throw new TypeError(`valid ${label} is required`);
  }
  return value;
}

function positiveId(value){
  const number=Number(value);
  return Number.isSafeInteger(number)&&number>0?number:null;
}

/**
 * Ledger-DB config from env. Returns null when the ledger is not
 * configured (neither var set). A token without a URL is a
 * misconfiguration, not "unconfigured": fail loudly rather than
 * silently dropping ledger writes. A `file:` URL needs no token
 * (non-prod / test databases); a remote URL without a token is
 * returned as-is and the client fails at connect time.
 */
export function deletionLedgerDbConfig(env=process.env){
  const url=String(env?.[DELETION_LEDGER_DATABASE_URL_ENV]||'').trim();
  const authToken=String(env?.[DELETION_LEDGER_AUTH_TOKEN_ENV]||'').trim();
  if(!url&&!authToken) return null;
  if(!url) throw new TypeError('DELETION_LEDGER_DATABASE_URL is required when DELETION_LEDGER_AUTH_TOKEN is set');
  return Object.freeze({url,authToken:authToken||undefined});
}

export function deletionLedgerDbConfigured(env=process.env){
  return deletionLedgerDbConfig(env)!==null;
}

/**
 * Opens a client for the ledger database, or null when it is not
 * configured. The caller closes the returned client (`client.close?.()`)
 * when it created it; a client passed in by the caller stays the
 * caller's to close.
 */
export function openDeletionLedgerDb(env=process.env,createClientFn=createClient){
  const config=deletionLedgerDbConfig(env);
  if(!config) return null;
  if(typeof createClientFn!=='function') throw new TypeError('database client factory is required');
  return createClientFn(config);
}

/** Validates one ledger entry and returns a frozen copy. Exactly three keys, nothing else. */
export function validateDeletionLedgerEntry(entry){
  if(!entry||typeof entry!=='object'||Array.isArray(entry)){
    throw new TypeError('deletion ledger entry must be an object');
  }
  const keys=Object.keys(entry).sort();
  if(keys.length!==3||keys[0]!=='account_id'||keys[1]!=='created_at'||keys[2]!=='deleted_at'){
    throw new TypeError('deletion ledger entry must have exactly account_id, created_at and deleted_at');
  }
  const accountId=positiveId(entry.account_id);
  if(!accountId) throw new TypeError('deletion ledger account_id must be a positive integer');
  return Object.freeze({
    account_id:accountId,
    created_at:ledgerDbTimestamp(entry.created_at,'created_at'),
    deleted_at:entry.deleted_at===null?null:ledgerDbTimestamp(entry.deleted_at,'deleted_at'),
  });
}

/**
 * Idempotent upsert of one entry. First writer wins for a known
 * `deleted_at`: an existing non-null time is never overwritten (a
 * retry must not replace the true deletion time with a later one), and
 * an existing null time is upgraded to a known one. `created_at` is
 * kept from the first write; it cannot change for an account.
 */
export async function recordDeletionLedgerEntry(client,entry){
  const parsed=validateDeletionLedgerEntry(entry);
  if(!client||typeof client.execute!=='function') throw new TypeError('deletion ledger database client is required');
  await client.execute({
    sql:`INSERT INTO ${DELETION_LEDGER_TABLE} (account_id,deleted_at,created_at) VALUES (?,?,?)
      ON CONFLICT(account_id) DO UPDATE SET
        deleted_at=COALESCE(${DELETION_LEDGER_TABLE}.deleted_at,excluded.deleted_at),
        created_at=${DELETION_LEDGER_TABLE}.created_at`,
    args:[parsed.account_id,parsed.deleted_at,parsed.created_at],
  });
  return Object.freeze({ok:true,recorded:true});
}

/** Every ledger entry, validated and id-sorted. */
export async function readDeletionLedgerEntries(client){
  if(!client||typeof client.execute!=='function') throw new TypeError('deletion ledger database client is required');
  const result=await client.execute({
    sql:`SELECT account_id,deleted_at,created_at FROM ${DELETION_LEDGER_TABLE} ORDER BY account_id`,
    args:[],
  });
  const entries=(result.rows??[]).map(row=>validateDeletionLedgerEntry({
    account_id:Number(row.account_id),
    deleted_at:row.deleted_at??null,
    created_at:row.created_at,
  }));
  entries.sort((a,b)=>a.account_id-b.account_id);
  return Object.freeze(entries);
}

/**
 * Retention purge (issue #383): destroy entries whose deletion is
 * older than `before`. Safe because a restore point can only fall
 * inside the provider backup window: an entry deleted before
 * (now − backup window) can never be due for any restorable point, so
 * it is moot. Entries with an unknown deletion time (`deleted_at`
 * null) are NEVER purged by time — there is no bound proving them
 * moot; the operator resolves them (see `destroyDeletionLedger` and
 * the runbook). Returns the destroyed count.
 */
export async function purgeDeletionLedgerEntries(client,{before}={}){
  const cutoff=ledgerDbTimestamp(before,'purge cutoff');
  if(!client||typeof client.execute!=='function') throw new TypeError('deletion ledger database client is required');
  const result=await client.execute({
    sql:`DELETE FROM ${DELETION_LEDGER_TABLE} WHERE deleted_at IS NOT NULL AND deleted_at<?`,
    args:[cutoff],
  });
  return Object.freeze({ok:true,purged:Number(result?.rowsAffected||0)});
}

/**
 * Destroys the whole ledger: every entry, in the ledger database.
 * Use only once no restore can still need any entry (verified cutover
 * plus the backup window passed) or when retiring the ledger database
 * itself. This deletes rows, never the table: the schema stays for the
 * next ledger the writer creates. Returns the destroyed count.
 */
export async function destroyDeletionLedger(client){
  if(!client||typeof client.execute!=='function') throw new TypeError('deletion ledger database client is required');
  const result=await client.execute({sql:`DELETE FROM ${DELETION_LEDGER_TABLE}`,args:[]});
  return Object.freeze({ok:true,deleted:Number(result?.rowsAffected||0)});
}
