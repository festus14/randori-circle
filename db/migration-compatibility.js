// Request-safe release compatibility for the managed ledger (ID-87, #371).
//
// Code that knows migrations 1..N is ready when the database ledger is at N,
// or at N-1 when migration N is declared 'additive' in migration-contract.js.
// Nothing else is tolerated: a ledger two versions behind, a breaking
// migration still to apply, or a ledger newer than the code (which
// validateMigrationLedger already rejects) all stay not ready. Every other
// readiness rule (checksums and metadata of every applied row, exact schema
// for the version actually applied, key control, membership) is unchanged.
//
// This module contains no executable DDL. The proof that a migration marked
// additive really is additive lives in the migration-only
// db/migration-compatibility-check.js. The one query here is a read-only
// SELECT against sqlite_schema, used by the owned-scope probes below.
import {
  INTRODUCED_ARTIFACT_KINDS,
  MIGRATION_COMPATIBILITY,
  MIGRATION_CONTRACTS,
} from './migration-contract.js';
import {
  assertMigrationLedgerContract,
  migrationLedgerExists,
  readMigrationLedger,
  validateMigrationLedger,
} from './migration-ledger-readiness.js';

export const LEDGER_READINESS_STATES=Object.freeze({
  CURRENT:'current',
  PENDING_ADDITIVE:'pending_additive',
  BEHIND:'behind',
  MISSING:'missing',
});

// The only lag readiness tolerates. Widening it, to N-2 or to breaking
// migrations, is a release-policy change that needs a new decision; the
// mutation tests in tests/unit/migration-additive-release.test.mjs fail if
// it changes.
export const ADDITIVE_READINESS_LAG=1;

function latestVersion(contracts){
  return contracts.at(-1)?.version||0;
}

/** The latest contract when it may still be pending, otherwise null. */
export function pendingAdditiveContract(contracts=MIGRATION_CONTRACTS){
  const latest=contracts.at(-1);
  return contracts.length>1&&latest?.compatibility===MIGRATION_COMPATIBILITY.ADDITIVE?latest:null;
}

/**
 * Judge a ledger that validateMigrationLedger has already checked against the
 * same contracts (so its rows are a contiguous prefix with exact names and
 * checksums, and never newer than the code).
 */
export function ledgerReadiness(ledger,{contracts=MIGRATION_CONTRACTS}={}){
  const expectedVersion=latestVersion(contracts);
  const currentVersion=ledger?.currentVersion;
  const rowCount=Array.isArray(ledger?.rows)?ledger.rows.length:-1;
  const known=Number.isSafeInteger(currentVersion)&&currentVersion>=0&&rowCount===currentVersion;
  const base={currentVersion:known?currentVersion:0,expectedVersion};
  if(known&&expectedVersion>0&&currentVersion===expectedVersion){
    return Object.freeze({...base,ready:true,state:LEDGER_READINESS_STATES.CURRENT,pendingVersion:null});
  }
  const pending=pendingAdditiveContract(contracts);
  if(known&&pending&&currentVersion>=1&&currentVersion===pending.version-ADDITIVE_READINESS_LAG){
    return Object.freeze({
      ...base,
      ready:true,
      state:LEDGER_READINESS_STATES.PENDING_ADDITIVE,
      pendingVersion:pending.version,
    });
  }
  return Object.freeze({...base,ready:false,state:LEDGER_READINESS_STATES.BEHIND,pendingVersion:null});
}

/**
 * The structural manifest readiness requires for a ready ledger. At the
 * current version that is the code's manifest. One additive migration behind,
 * it is the same manifest without the artifacts that migration introduces
 * (an additive migration changes nothing else), so the database must match
 * version N-1 exactly: a half-created new table is still drift.
 */
export function readinessManifestForLedger(manifest,readiness,{contracts=MIGRATION_CONTRACTS}={}){
  if(!manifest||!Array.isArray(manifest.tables)||!Array.isArray(manifest.indexes)){
    throw new TypeError('a schema manifest is required');
  }
  if(readiness?.ready!==true) throw new TypeError('a ready ledger is required');
  if(readiness.state===LEDGER_READINESS_STATES.CURRENT) return manifest;
  const pending=pendingAdditiveContract(contracts);
  if(readiness.state!==LEDGER_READINESS_STATES.PENDING_ADDITIVE||pending?.version!==readiness.pendingVersion){
    throw new TypeError('ledger readiness does not match the migration contracts');
  }
  const introduced=Object.fromEntries(INTRODUCED_ARTIFACT_KINDS.map(kind=>[kind,new Set(pending.introduces[kind])]));
  const previous={
    ...manifest,
    tables:manifest.tables.filter(item=>!introduced.tables.has(item.name)),
    indexes:manifest.indexes.filter(item=>!introduced.indexes.has(item.name)),
  };
  if(Array.isArray(manifest.triggers)){
    previous.triggers=manifest.triggers.filter(item=>!introduced.triggers.has(item.name));
  }
  return Object.freeze(previous);
}

/**
 * The artifacts the pending additive migration introduces that already exist
 * in sqlite_schema. Owned-scope probes need this explicitly (#379): their
 * inspector manifest is scoped to owned tables, so it reports no warning for
 * a half-created introduced table, or for an introduced index or trigger on
 * a table outside the owned scope, while the full-manifest health probe
 * catches those as unexpected artifacts. A pending artifact present means
 * the migration started but did not finish (or ran outside the runner's
 * single transaction), so the database is not the clean N-1 schema readiness
 * at N-1 requires, and the caller must treat it as not ready.
 *
 * Returns [] when nothing is pending. `db` must be a read-only client (see
 * readOnlyDatabase in db/schema-inspector.js). A pending ledger that does
 * not match the contracts throws, so callers fail closed instead of
 * treating an inconsistent ledger as clean.
 */
export async function findPendingIntroducedArtifacts(db,readiness,{contracts=MIGRATION_CONTRACTS}={}){
  if(readiness?.state!==LEDGER_READINESS_STATES.PENDING_ADDITIVE) return Object.freeze([]);
  const pending=pendingAdditiveContract(contracts);
  if(pending?.version!==readiness.pendingVersion){
    throw new TypeError('ledger readiness does not match the migration contracts');
  }
  if(!pending.introduces||typeof pending.introduces!=='object'||Array.isArray(pending.introduces)
    ||!INTRODUCED_ARTIFACT_KINDS.every(kind=>Array.isArray(pending.introduces[kind]))){
    throw new TypeError('pending additive migration contract must list introduced artifacts');
  }
  const clauses=[];
  const args=[];
  for(const [kind,type] of [['tables','table'],['indexes','index'],['triggers','trigger']]){
    const names=pending.introduces[kind];
    if(names.length===0) continue;
    clauses.push(`(type='${type}' AND name IN (${names.map(()=>'?').join(',')}))`);
    args.push(...names);
  }
  if(clauses.length===0) return Object.freeze([]);
  if(!db||typeof db.execute!=='function') throw new TypeError('a database client is required');
  const result=await db.execute({
    sql:`SELECT type,name FROM sqlite_schema WHERE ${clauses.join(' OR ')} ORDER BY type,name`,
    args,
  });
  return Object.freeze((result.rows||[]).map(row=>Object.freeze({
    type:String(row.type),
    name:String(row.name),
  })));
}

/**
 * Read-only ledger readiness for request paths. A missing ledger is reported
 * as not ready; an invalid or newer-than-code ledger throws exactly as
 * validateMigrationLedger does, so callers keep failing closed.
 */
export async function inspectLedgerReadiness(db,{contracts=MIGRATION_CONTRACTS}={}){
  if(!await migrationLedgerExists(db)){
    return Object.freeze({
      currentVersion:0,
      expectedVersion:latestVersion(contracts),
      ready:false,
      state:LEDGER_READINESS_STATES.MISSING,
      pendingVersion:null,
    });
  }
  await assertMigrationLedgerContract(db);
  const ledger=validateMigrationLedger(await readMigrationLedger(db,{limit:contracts.length+1}),contracts);
  return ledgerReadiness(ledger,{contracts});
}
