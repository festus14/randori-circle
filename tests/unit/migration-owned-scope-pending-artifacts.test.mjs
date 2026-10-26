// Owned-scope readiness must reject half-created introduced artifacts (#379).
//
// The #377 review proved the gap empirically on the then-pending migration:
// DB at v20 with v21 declared additive and invite_requests half-created
// (ledger still v20) — health returned false, but circle-pairing readiness
// returned true. The owned-scope inspector manifest is scoped to owned
// tables, so it reports no warning for a half-created introduced table, nor
// for an introduced index or trigger on a table outside the owned scope,
// while the full-manifest health probe catches those as unexpected
// artifacts. The fix is an explicit pending-artifact absence check in the
// two owned-scope probes (findPendingIntroducedArtifacts).
//
// On current main the pending additive migration is v22 (feedback_*), so
// the table case uses that; the issue's v21/invite_requests scenario is the
// same shape one version down. The index/trigger cases use synthetic
// contracts (real contracts 1..21 plus a v22 that introduces one
// non-unique index / one trigger on the non-owned `circles` table). The
// non-unique index is allowed on an existing table by the additive check;
// the trigger case is hypothetical / defence-in-depth, since that check
// refuses triggers on existing tables, and the owned-scope inspector is
// blind to both by construction.
//
// Each scenario uses a fresh database client: ensureSecondaryScheduleReadiness
// caches a success per client, so re-probing the same client after
// mutating its schema would return the stale cached verdict.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, test } from 'node:test';

import { createClient } from '@libsql/client';

import { ensureCirclePairingReadiness } from '../../api/_circle-pairing.js';
import { inspectDatabaseReadiness } from '../../api/_health.js';
import { ensureSecondaryScheduleReadiness } from '../../api/_secondary-schedule.js';
import {
  findPendingIntroducedArtifacts,
  inspectLedgerReadiness,
} from '../../db/migration-compatibility.js';
import { MIGRATION_CONTRACTS, validateMigrationContracts } from '../../db/migration-contract.js';
import { MIGRATION_PLANS } from '../../db/migration-plan.js';
import { EXECUTABLE_MIGRATIONS } from '../../db/executable-migrations.js';
import {
  applyMigrations,
  inspectMigrationState,
  prepareMigrationConnection,
} from '../../db/migration-runner.js';
import { readOnlyDatabase } from '../../db/schema-inspector.js';

// The secondary-schedule readiness cache is keyed by TURSO_DATABASE_URL
// when it is set, so clear it here: every scenario below opens its own
// database and must be probed on its own schema.
delete process.env.TURSO_DATABASE_URL;

const NO_RETRY=Object.freeze({maxAttempts:1,baseDelayMs:0,maxDelayMs:0});
const N=MIGRATION_CONTRACTS.length;
const V22_PLAN=MIGRATION_PLANS[N-1];
const resources=[];

afterEach(async()=>{
  while(resources.length){ try{ await resources.pop()(); }catch{} }
});

async function databaseAt(version){
  const directory=mkdtempSync(join(tmpdir(),'randori-owned-scope-pending-'));
  resources.push(()=>rmSync(directory,{recursive:true,force:true}));
  const db=createClient({url:`file:${join(directory,'database.sqlite')}`});
  resources.push(()=>db.close());
  await prepareMigrationConnection(db);
  const migrations=EXECUTABLE_MIGRATIONS.slice(0,version);
  const state=await inspectMigrationState(db,{migrations});
  await applyMigrations(db,{migrations,expectedStateFingerprint:state.stateFingerprint,retry:NO_RETRY});
  return db;
}

// The checked-in contracts with the pending migration's introduces replaced
// by the given set. Readiness only reads these; the migration check is not
// re-run here.
function contractsIntroducing(introduces){
  const contracts=Object.freeze(MIGRATION_CONTRACTS.map(contract=>contract.version===N
    ?Object.freeze({...contract,compatibility:'additive',introduces:Object.freeze({
      tables:Object.freeze([...introduces.tables]),
      indexes:Object.freeze([...introduces.indexes]),
      triggers:Object.freeze([...introduces.triggers]),
    })})
    :contract));
  validateMigrationContracts(contracts);
  return contracts;
}

async function assertOwnedScopeNotReady(db,{contracts}={}){
  await assert.rejects(
    ensureCirclePairingReadiness(db,contracts?{contracts}:undefined),
    {code:'CIRCLE_PAIRING_SCHEMA_UNAVAILABLE'},
  );
  await assert.rejects(
    ensureSecondaryScheduleReadiness(db,contracts?{contracts}:undefined),
    {code:'SECONDARY_SCHEDULE_SCHEMA_UNAVAILABLE'},
  );
}

test('clean DB at N-1 with an additive N pending is ready on both owned-scope probes',async()=>{
  const db=await databaseAt(N-1);
  assert.equal(await inspectDatabaseReadiness(db),true);
  assert.equal(await ensureCirclePairingReadiness(db),true);
  assert.equal(await ensureSecondaryScheduleReadiness(db),true);
  const ledger=await inspectLedgerReadiness(readOnlyDatabase(db));
  assert.equal(ledger.state,'pending_additive');
  assert.deepEqual(await findPendingIntroducedArtifacts(readOnlyDatabase(db),ledger),[]);
});

test('half-created introduced table is not ready on either owned-scope probe',async()=>{
  const db=await databaseAt(N-1);
  // Only the first v22 operation: the feedback_items table, none of its
  // indexes. The ledger is still at N-1, so this is a half-created table.
  const create=V22_PLAN.operations.find(operation=>operation.operation==='ensure-table').sql;
  await db.execute(create);
  assert.equal(await inspectDatabaseReadiness(db),false);
  const ledger=await inspectLedgerReadiness(readOnlyDatabase(db));
  assert.deepEqual(
    await findPendingIntroducedArtifacts(readOnlyDatabase(db),ledger),
    [{type:'table',name:'feedback_items'}],
  );
  await assertOwnedScopeNotReady(db);
});

test('half-created introduced index on a non-owned table is not ready on either owned-scope probe',async()=>{
  const contracts=contractsIntroducing({tables:[],indexes:['idx_pending_probe_on_circles'],triggers:[]});
  const db=await databaseAt(N-1);
  await db.execute('CREATE INDEX idx_pending_probe_on_circles ON circles(id)');
  const ledger=await inspectLedgerReadiness(readOnlyDatabase(db),{contracts});
  assert.deepEqual(
    await findPendingIntroducedArtifacts(readOnlyDatabase(db),ledger,{contracts}),
    [{type:'index',name:'idx_pending_probe_on_circles'}],
  );
  await assertOwnedScopeNotReady(db,{contracts});
});

test('half-created introduced trigger on a non-owned table is not ready on either owned-scope probe',async()=>{
  const contracts=contractsIntroducing({tables:[],indexes:[],triggers:['trg_pending_probe']});
  const db=await databaseAt(N-1);
  await db.execute('CREATE TRIGGER trg_pending_probe AFTER INSERT ON circles BEGIN SELECT 1; END');
  const ledger=await inspectLedgerReadiness(readOnlyDatabase(db),{contracts});
  assert.deepEqual(
    await findPendingIntroducedArtifacts(readOnlyDatabase(db),ledger,{contracts}),
    [{type:'trigger',name:'trg_pending_probe'}],
  );
  await assertOwnedScopeNotReady(db,{contracts});
});

test('introduced artifacts present at the current version are not pending artifacts',async()=>{
  const db=await databaseAt(N);
  assert.equal(await ensureCirclePairingReadiness(db),true);
  assert.equal(await ensureSecondaryScheduleReadiness(db),true);
  const ledger=await inspectLedgerReadiness(readOnlyDatabase(db));
  assert.equal(ledger.state,'current');
  // feedback_items legitimately exists now; with no pending migration the
  // absence check must stay silent instead of rejecting the live schema.
  assert.deepEqual(await findPendingIntroducedArtifacts(readOnlyDatabase(db),ledger),[]);
});

test('findPendingIntroducedArtifacts fails closed on inconsistent input',async()=>{
  const db=await databaseAt(N-1);
  const readOnly=readOnlyDatabase(db);
  await assert.rejects(
    findPendingIntroducedArtifacts(readOnly,{state:'pending_additive',ready:true,pendingVersion:999}),
    {name:'TypeError'},
  );
  const noIntroduces=Object.freeze(MIGRATION_CONTRACTS.map(contract=>contract.version===N
    ?Object.freeze({...contract,compatibility:'additive',introduces:undefined})
    :contract));
  await assert.rejects(
    findPendingIntroducedArtifacts(readOnly,{state:'pending_additive',ready:true,pendingVersion:N},{contracts:noIntroduces}),
    {name:'TypeError'},
  );
  const emptyIntroduces=Object.freeze(MIGRATION_CONTRACTS.map(contract=>contract.version===N
    ?Object.freeze({...contract,compatibility:'additive',introduces:Object.freeze({tables:[],indexes:[],triggers:[]})})
    :contract));
  // No validateMigrationContracts here: the real contract validator
  // requires a non-empty introduces list, but the helper itself must still
  // answer [] for a pending migration that introduces nothing.
  const ledger=await inspectLedgerReadiness(readOnly,{contracts:emptyIntroduces});
  assert.deepEqual(await findPendingIntroducedArtifacts(readOnly,ledger,{contracts:emptyIntroduces}),[]);
});
