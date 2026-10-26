// Secondary-schedule readiness must not retain a pending-additive success (#395).
//
// #379 added the pending-artifact check to the probe, but the probe's cache
// kept a clean success indefinitely per DB/client, so a warm process that
// cached a clean N-1 verdict kept returning ready after a half-created
// introduced artifact appeared later in the same process/client, while
// circle-pairing (no cache) and health (no retained results) rejected.
//
// Fix: a success is retained only when the ledger was CURRENT when probed.
// A `pending_additive` success is coalesced while in flight, then evicted
// on settle, so the next call re-probes. A TTL was rejected: it would still
// mask the artifact for the whole TTL, and there is no schema-change signal
// to subscribe to (migrations run out of process). The cache keeps its
// existing URL scoping (per TURSO_DATABASE_URL, else per client).
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, test } from 'node:test';

import { createClient } from '@libsql/client';

import { ensureSecondaryScheduleReadiness } from '../../api/_secondary-schedule.js';
import { MIGRATION_CONTRACTS } from '../../db/migration-contract.js';
import { MIGRATION_PLANS } from '../../db/migration-plan.js';
import { EXECUTABLE_MIGRATIONS } from '../../db/executable-migrations.js';
import {
  applyMigrations,
  inspectMigrationState,
  prepareMigrationConnection,
} from '../../db/migration-runner.js';

delete process.env.TURSO_DATABASE_URL;

const NO_RETRY=Object.freeze({maxAttempts:1,baseDelayMs:0,maxDelayMs:0});
const N=MIGRATION_CONTRACTS.length;
const V22_PLAN=MIGRATION_PLANS[N-1];
const resources=[];

afterEach(async()=>{
  delete process.env.TURSO_DATABASE_URL;
  while(resources.length){ try{ await resources.pop()(); }catch{} }
});

async function databaseAt(version){
  const directory=mkdtempSync(join(tmpdir(),'randori-secondary-stale-cache-'));
  resources.push(()=>rmSync(directory,{recursive:true,force:true}));
  const db=createClient({url:`file:${join(directory,'database.sqlite')}`});
  resources.push(()=>db.close());
  await prepareMigrationConnection(db);
  const migrations=EXECUTABLE_MIGRATIONS.slice(0,version);
  const state=await inspectMigrationState(db,{migrations});
  await applyMigrations(db,{migrations,expectedStateFingerprint:state.stateFingerprint,retry:NO_RETRY});
  return db;
}

function traced(db){
  let reads=0;
  const client={execute:async statement=>{ reads+=1; return db.execute(statement); }};
  return {client,reads:()=>reads};
}

test('a clean pending-additive success is not retained: the next call re-probes',async()=>{
  const db=await databaseAt(N-1);
  const {client,reads}=traced(db);
  assert.equal(await ensureSecondaryScheduleReadiness(client),true);
  assert.ok(reads()>0);
  const afterFirst=reads();
  assert.equal(await ensureSecondaryScheduleReadiness(client),true);
  assert.ok(reads()>afterFirst,'pending_additive success must be evicted, not cached');
});

test('concurrent pending-additive probes coalesce, then the next sequential call re-probes',async()=>{
  const db=await databaseAt(N-1);
  const {client,reads}=traced(db);
  const results=await Promise.all([
    ensureSecondaryScheduleReadiness(client),
    ensureSecondaryScheduleReadiness(client),
    ensureSecondaryScheduleReadiness(client),
  ]);
  assert.deepEqual(results,[true,true,true]);
  const afterConcurrent=reads();
  assert.ok(afterConcurrent>0);
  // One probe's worth of reads for all three concurrent calls: without
  // coalescing this would be ~3x a single probe. A following sequential
  // call must re-probe exactly once: without eviction it would read 0 more.
  assert.equal(await ensureSecondaryScheduleReadiness(client),true);
  assert.equal(reads(),afterConcurrent*2,'concurrent calls must coalesce and the next call must re-probe');
});

test('half-created artifact after a cached clean success rejects on the same client',async()=>{
  const db=await databaseAt(N-1);
  assert.equal(await ensureSecondaryScheduleReadiness(db),true);
  // Only the first v22 operation: the feedback_items table, none of its
  // indexes. The ledger is still at N-1, so this is a half-created table.
  const create=V22_PLAN.operations.find(operation=>operation.operation==='ensure-table').sql;
  await db.execute(create);
  await assert.rejects(
    ensureSecondaryScheduleReadiness(db),
    {code:'SECONDARY_SCHEDULE_SCHEMA_UNAVAILABLE'},
  );
  // A rejected probe is not retained either: removing the artifact makes
  // the same client ready again.
  await db.execute('DROP TABLE feedback_items');
  assert.equal(await ensureSecondaryScheduleReadiness(db),true);
});

test('a current-ledger success is still cached, with the same URL scoping',async()=>{
  const db=await databaseAt(N);
  const {client,reads}=traced(db);
  assert.equal(await ensureSecondaryScheduleReadiness(client),true);
  const afterFirst=reads();
  assert.ok(afterFirst>0);
  assert.equal(await ensureSecondaryScheduleReadiness(client),true);
  assert.equal(reads(),afterFirst,'current success must stay cached per client');

  // With a database URL set, the same retained verdict is shared per URL
  // across client objects, as before.
  process.env.TURSO_DATABASE_URL=`libsql://stale-cache-395-${process.pid}-${Date.now()}.example`;
  assert.equal(await ensureSecondaryScheduleReadiness(client),true);
  let unexpected=0;
  const other={execute:async()=>{ unexpected+=1; throw new Error('should not be probed'); }};
  assert.equal(await ensureSecondaryScheduleReadiness(other),true);
  assert.equal(unexpected,0);
});

test('ledger advancing N-1 to N re-probes, then the current success is cached',async()=>{
  const db=await databaseAt(N-1);
  const {client,reads}=traced(db);
  assert.equal(await ensureSecondaryScheduleReadiness(client),true);
  const afterPending=reads();
  // The protected cutover applies N through the same runner.
  const state=await inspectMigrationState(db);
  const applied=await applyMigrations(db,{expectedStateFingerprint:state.stateFingerprint,retry:NO_RETRY});
  assert.deepEqual(applied.applied.map(item=>item.version),[N]);
  // The N-1 verdict was not retained, so this call re-probes the N schema
  // instead of returning the stale pending_additive success.
  assert.equal(await ensureSecondaryScheduleReadiness(client),true);
  assert.ok(reads()>afterPending,'cutover must re-probe, not reuse the N-1 verdict');
  const afterCurrent=reads();
  assert.equal(await ensureSecondaryScheduleReadiness(client),true);
  assert.equal(reads(),afterCurrent,'current success after cutover must stay cached');
});
