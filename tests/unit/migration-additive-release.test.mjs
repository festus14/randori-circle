// Zero-downtime additive release, end to end on real migrated SQLite (ID-87,
// #371), using the latest real additive migration: v23, the account deletion
// grace table (#372). Everything is the production code: health, circle pairing,
// schedule and pairing readiness, admin diagnostics, the schema capability
// check and the migration runner.
//
// Release order: merge (code at N, database at N-1, app ready) -> protected
// cutover applies N (app ready throughout) -> the feature flag goes on, and
// the feature sees its schema through the capability check.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, test } from 'node:test';

import { createClient } from '@libsql/client';

import { MIGRATION_PLANS } from '../../db/migration-plan.js';

const { MIGRATION_CONTRACTS, validateMigrationContracts }=await import('../../db/migration-contract.js');
const V23=MIGRATION_PLANS[22];

const { readAdminDiagnostics }=await import('../../api/_admin-diagnostics.js');
const { ensureCirclePairingReadiness }=await import('../../api/_circle-pairing.js');
const { inspectDatabaseReadiness }=await import('../../api/_health.js');
const { pairingSchemaV6Fingerprint, pairingSchemaV6Ready }=await import('../../api/_pairing-readiness.js');
const {
  SCHEMA_CAPABILITY_PENDING_TTL_MS,
  schemaCapabilityAvailable,
  schemaFeatureAvailable,
}=await import('../../api/_schema-capability.js');
const { ensureSecondaryScheduleReadiness }=await import('../../api/_secondary-schedule.js');
const { EXECUTABLE_MIGRATIONS }=await import('../../db/executable-migrations.js');
const { pendingAdditiveContract }=await import('../../db/migration-compatibility.js');
const { inspectMigrationCompatibility }=await import('../../db/migration-compatibility-check.js');
const {
  applyMigrations,
  inspectMigrationState,
  prepareMigrationConnection,
}=await import('../../db/migration-runner.js');

const NO_RETRY=Object.freeze({maxAttempts:1,baseDelayMs:0,maxDelayMs:0});
const N=23;
const resources=[];

afterEach(async()=>{
  while(resources.length){ try{ await resources.pop()(); }catch{} }
});

async function openDatabase(){
  const directory=mkdtempSync(join(tmpdir(),'randori-additive-release-'));
  resources.push(()=>rmSync(directory,{recursive:true,force:true}));
  const db=createClient({url:`file:${join(directory,'database.sqlite')}`});
  resources.push(()=>db.close());
  await prepareMigrationConnection(db);
  return db;
}

async function migrate(db,version){
  const migrations=EXECUTABLE_MIGRATIONS.slice(0,version);
  const state=await inspectMigrationState(db,{migrations});
  return applyMigrations(db,{migrations,expectedStateFingerprint:state.stateFingerprint,retry:NO_RETRY});
}

async function databaseAt(version){
  const db=await openDatabase();
  await migrate(db,version);
  return db;
}

const ready=async()=>({ready:true,reason:null});

async function readinessCard(db){
  return (await readAdminDiagnostics(db,{env:{},checkReadiness:ready})).cards.readiness;
}

test('the additive declaration used here passes the real migration check',()=>{
  assert.equal(validateMigrationContracts(MIGRATION_CONTRACTS),true);
  assert.deepEqual(inspectMigrationCompatibility({migrations:EXECUTABLE_MIGRATIONS,contracts:MIGRATION_CONTRACTS}),[]);
  assert.equal(pendingAdditiveContract()?.version,N,'production modules see the declaration');
  assert.deepEqual(MIGRATION_CONTRACTS[N-1].introduces,
    {tables:['account_deletion_requests'],indexes:[...V23.indexes],triggers:[]});
});

test('code at N stays ready on every surface while the database moves from N-1 to N',async()=>{
  const db=await databaseAt(N-1);
  const env={};

  // 1. Merged: code at N, database at N-1.
  assert.equal(await inspectDatabaseReadiness(db),true);
  assert.equal(await ensureCirclePairingReadiness(db),true);
  assert.equal(await ensureSecondaryScheduleReadiness(db),true);
  assert.equal(await pairingSchemaV6Ready(db),true);
  const fingerprintBefore=await pairingSchemaV6Fingerprint(db);
  let card=await readinessCard(db);
  assert.deepEqual(
    [card.status,card.category,card.ready,card.ledger.state,card.ledger.currentVersion,card.ledger.expectedVersion,card.ledger.pendingVersion],
    ['degraded','ledger_pending_additive',true,'pending_additive',N-1,N,N],
  );
  // The feature is off until its schema exists, even with its flag on.
  assert.equal(await schemaCapabilityAvailable(db,{version:N,env}),false);
  assert.equal(await schemaFeatureAvailable(db,{enabled:true,version:N,env}),false);
  assert.equal(await schemaCapabilityAvailable(db,{version:N-1,env}),true);

  // 2. The protected cutover applies N through the same runner.
  const state=await inspectMigrationState(db);
  assert.deepEqual([state.classification,state.currentVersion,state.ready],['managed',N-1,true]);
  const applied=await applyMigrations(db,{expectedStateFingerprint:state.stateFingerprint,retry:NO_RETRY});
  assert.deepEqual(applied.applied.map(item=>item.version),[N]);

  // 3. Still ready, now current; nothing pairing depends on moved.
  assert.equal(await inspectDatabaseReadiness(db),true);
  assert.equal(await ensureCirclePairingReadiness(db),true);
  assert.equal(await pairingSchemaV6Ready(db),true);
  assert.equal(await pairingSchemaV6Fingerprint(db),fingerprintBefore);
  card=await readinessCard(db);
  assert.deepEqual([card.status,card.category,card.ledger.state,card.ledger.pendingVersion],
    ['healthy',null,'current',null]);

  // 4. The capability appears once the short pending cache expires.
  assert.equal(await schemaCapabilityAvailable(db,{version:N,env}),false,'still cached as pending');
  const later=()=>Date.now()+SCHEMA_CAPABILITY_PENDING_TTL_MS+1;
  assert.equal(await schemaCapabilityAvailable(db,{version:N,env,now:later}),true);
  assert.equal(await schemaFeatureAvailable(db,{enabled:true,version:N,env,now:later}),true);
  assert.equal(await schemaFeatureAvailable(db,{enabled:false,version:N,env,now:later}),false);
});

test('one additive migration behind is still judged exactly',async()=>{
  const db=await databaseAt(N-1);
  assert.equal(await inspectDatabaseReadiness(db),true);

  // A half-created introduced table is drift, and grants no capability.
  const create=V23.operations.find(operation=>operation.operation==='ensure-table').sql;
  await db.execute(create);
  assert.equal(await inspectDatabaseReadiness(db),false);
  assert.equal(await schemaCapabilityAvailable(db,{version:N,env:{}}),false);
  await db.execute('DROP TABLE account_deletion_requests');
  assert.equal(await inspectDatabaseReadiness(db),true);

  // Drift in the existing schema still blocks.
  await db.execute('DROP INDEX idx_pair_sched_pair');
  assert.equal(await inspectDatabaseReadiness(db),false);
  await db.execute('CREATE INDEX IF NOT EXISTS idx_pair_sched_pair ON pair_schedules(pair_group_id)');
  assert.equal(await inspectDatabaseReadiness(db),true);

  // Every applied row is still checked against its immutable contract.
  await db.execute(`UPDATE schema_migrations SET checksum='${'f'.repeat(64)}' WHERE version=3`);
  await assert.rejects(inspectDatabaseReadiness(db),{name:'MigrationLedgerError'});
  await assert.rejects(ensureCirclePairingReadiness(db),{code:'CIRCLE_PAIRING_SCHEMA_UNAVAILABLE'});
  assert.equal((await readinessCard(db)).ledger.state,'invalid');
});

test('two versions behind is not ready even with an additive latest migration',async()=>{
  const db=await databaseAt(N-2);
  assert.equal(await inspectDatabaseReadiness(db),false);
  await assert.rejects(ensureCirclePairingReadiness(db),{code:'CIRCLE_PAIRING_SCHEMA_UNAVAILABLE'});
  await assert.rejects(ensureSecondaryScheduleReadiness(db),{code:'SECONDARY_SCHEDULE_SCHEMA_UNAVAILABLE'});
  const card=await readinessCard(db);
  assert.deepEqual([card.status,card.category,card.ledger.state],['failed','ledger_behind','behind']);
});
