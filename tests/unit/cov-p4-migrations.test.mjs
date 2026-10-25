import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createClient } from '@libsql/client';

import { readCheckConstraintsEnforced } from '../../db/check-constraint-state.js';

import {
  EXECUTABLE_MIGRATIONS,
  ROLLOUT_SINGLETON_OPERATION,
  checksumExecutableMigration,
  validateExecutableMigrations,
} from '../../db/executable-migrations.js';
import {
  LATEST_MIGRATION_VERSION,
  MIGRATION_CONTRACTS,
  validateMigrationContracts,
} from '../../db/migration-contract.js';
import {
  MigrationLedgerError,
  assertMigrationLedgerContract,
  createMigrationLedger,
  insertMigrationLedgerRow,
  migrationLedgerExists,
  readMigrationLedger,
  validateMigrationLedger,
} from '../../db/migration-ledger.js';
import { adoptMigrations, applyMigrations, withMigrationRetry } from '../../db/migration-runner.js';
import { MIGRATION_PLANS } from '../../db/migration-plan.js';

const HEX = 'a'.repeat(64);

function recordingDb(){
  const calls=[];
  return {calls,async execute(statement){ calls.push(statement); return {rows:[]}; }};
}

// Clone so tests can tamper without touching the frozen canonical list.
function cloneMigrations(){
  return structuredClone(EXECUTABLE_MIGRATIONS);
}

// Recompute the self-checksum so a tampered migration only fails the check under test.
function reseal(migration){
  migration.checksum=checksumExecutableMigration(migration);
  return migration;
}

test('migration contracts reject empty, gapped, unnamed and badly fingerprinted lists', ()=>{
  assert.equal(validateMigrationContracts(), true);
  assert.equal(LATEST_MIGRATION_VERSION, MIGRATION_CONTRACTS.at(-1).version);
  assert.equal(LATEST_MIGRATION_VERSION, MIGRATION_CONTRACTS.length);

  assert.throws(()=>validateMigrationContracts([]), {name:'TypeError', message:/must not be empty/});
  assert.throws(()=>validateMigrationContracts('v1'), {name:'TypeError', message:/must not be empty/});
  assert.throws(()=>validateMigrationContracts([null]), /contract gap at version 1/);
  assert.throws(()=>validateMigrationContracts([{version:2, name:'x', checksum:HEX}]), /contract gap at version 1/);
  assert.throws(
    ()=>validateMigrationContracts([{version:1, name:'one', checksum:HEX}, {version:3, name:'three', checksum:HEX}]),
    /contract gap at version 2/,
  );
  assert.throws(()=>validateMigrationContracts([{version:1, name:'', checksum:HEX}]), /1 has no name/);
  assert.throws(()=>validateMigrationContracts([{version:1, name:7, checksum:HEX}]), /1 has no name/);
  assert.throws(()=>validateMigrationContracts([{version:1, name:'one'}]), /1 has an invalid checksum/);
  assert.throws(()=>validateMigrationContracts([{version:1, name:'one', checksum:'A'.repeat(64)}]), /invalid checksum/);
  assert.throws(()=>validateMigrationContracts([{version:1, name:'one', checksum:'a'.repeat(63)}]), /invalid checksum/);
  assert.equal(validateMigrationContracts([{version:1, name:'one', checksum:HEX, compatibility:'breaking'}]), true);
});

test('ledger rows require a non-negative integer duration and a known disposition before any write', async ()=>{
  const db=recordingDb();
  const migration={version:4, name:'four', checksum:HEX};
  for(const executionMs of [-1, 1.5, '3', Number.NaN, Number.MAX_SAFE_INTEGER+1, undefined]){
    await assert.rejects(
      insertMigrationLedgerRow(db, migration, {executionMs, disposition:'applied'}),
      {name:'TypeError', message:/executionMs/},
    );
  }
  for(const disposition of ['skipped', '', undefined, 'APPLIED']){
    await assert.rejects(
      insertMigrationLedgerRow(db, migration, {executionMs:0, disposition}),
      {name:'TypeError', message:/disposition/},
    );
  }
  assert.equal(db.calls.length, 0);

  await insertMigrationLedgerRow(db, migration, {executionMs:0, disposition:'adopted'});
  await insertMigrationLedgerRow(db, migration, {executionMs:12, disposition:'applied'});
  assert.equal(db.calls.length, 2);
  assert.match(db.calls[0].sql, /INSERT INTO schema_migrations/);
  assert.deepEqual(db.calls[0].args, [4, 'four', HEX, 0, 'adopted']);
  assert.deepEqual(db.calls[1].args, [4, 'four', HEX, 12, 'applied']);
});

test('executable migrations must be a non-empty prefix of the immutable plans', ()=>{
  assert.throws(()=>validateExecutableMigrations([]), {name:'TypeError', message:/non-empty migration-plan prefix/});
  assert.throws(()=>validateExecutableMigrations('all'), {name:'TypeError'});
  const tooMany=[...cloneMigrations(), cloneMigrations()[0]];
  assert.throws(()=>validateExecutableMigrations(tooMany), {name:'TypeError'});
  // A strict prefix is accepted (a database can lag the codebase).
  assert.equal(validateExecutableMigrations(cloneMigrations().slice(0, 3)), true);
  assert.equal(validateExecutableMigrations(cloneMigrations(), MIGRATION_PLANS), true);
});

test('executable migrations detect gaps, renamed plans and checksum drift', ()=>{
  const missing=cloneMigrations();
  missing[1]=null;
  assert.throws(()=>validateExecutableMigrations(missing), /gap at version 2/);

  const renumbered=cloneMigrations();
  renumbered[2].version=4;
  assert.throws(()=>validateExecutableMigrations(renumbered), /gap at version 3/);

  const renamed=cloneMigrations();
  renamed[0].name='something-else';
  assert.throws(()=>validateExecutableMigrations(renamed), /1 does not match its immutable plan/);

  const replanned=cloneMigrations();
  replanned[0].planChecksum=HEX;
  assert.throws(()=>validateExecutableMigrations(replanned), /1 does not match its immutable plan/);

  const repinned=cloneMigrations();
  repinned[0].checksum=HEX;
  assert.throws(()=>validateExecutableMigrations(repinned), /1 checksum is not the pinned execution checksum/);
});

test('executable migrations reject missing, unsupported and multi-statement operations', ()=>{
  const noOperations=cloneMigrations();
  noOperations[0].operations=null;
  assert.throws(()=>validateExecutableMigrations(noOperations), /1 has no operations/);

  const truncated=cloneMigrations();
  truncated[0].operations=truncated[0].operations.slice(0, -1);
  assert.throws(()=>validateExecutableMigrations(truncated), /1 has no operations/);

  const unsupported=cloneMigrations();
  unsupported[0].operations[0]={...unsupported[0].operations[0], operation:'drop-table'};
  assert.throws(()=>validateExecutableMigrations(unsupported), /unsupported operation/);

  const nullOperation=cloneMigrations();
  nullOperation[0].operations[0]=null;
  assert.throws(()=>validateExecutableMigrations(nullOperation), /unsupported operation/);

  const blank=cloneMigrations();
  blank[0].operations[0].sql='   ';
  assert.throws(()=>validateExecutableMigrations(blank), /invalid SQL/);

  const notText=cloneMigrations();
  notText[0].operations[0].sql=42;
  assert.throws(()=>validateExecutableMigrations(notText), /invalid SQL/);

  const smuggled=cloneMigrations();
  const table=smuggled[0].operations.findIndex(operation=>operation.operation==='ensure-table');
  smuggled[0].operations[table].sql+='; DROP TABLE auth_accounts';
  assert.throws(()=>validateExecutableMigrations(smuggled), /invalid SQL/);
});

test('trigger bodies may contain semicolons while other operations may not', ()=>{
  const migrations=cloneMigrations();
  const withTrigger=migrations.findIndex(migration=>migration.operations.some(operation=>operation.operation==='ensure-trigger'));
  assert.ok(withTrigger>=0, 'expected at least one trigger migration');
  const trigger=migrations[withTrigger].operations.find(operation=>operation.operation==='ensure-trigger');
  assert.ok(trigger.sql.includes(';'));
  assert.equal(validateExecutableMigrations(migrations.slice(0, withTrigger+1)), true);
});

test('state rows are restricted to the allow-listed seed for their own version', ()=>{
  const unknown=cloneMigrations();
  unknown[1].operations.push({operation:'ensure-row', name:'auth_accounts:1', table:'auth_accounts', sql:'INSERT INTO auth_accounts DEFAULT VALUES'});
  assert.throws(()=>validateExecutableMigrations(unknown), /2 contains an unsupported state operation/);

  const wrongTable=cloneMigrations();
  const seed=wrongTable[1].operations.at(-1);
  assert.equal(seed.name, ROLLOUT_SINGLETON_OPERATION.name);
  seed.table='circles';
  assert.throws(()=>validateExecutableMigrations(wrongTable), /unsupported state operation/);

  const wrongSql=cloneMigrations();
  wrongSql[1].operations.at(-1).sql=`INSERT INTO circle_membership_rollout (id,registrations_closed,updated_at)
    VALUES (1,1,datetime('now')) ON CONFLICT(id) DO NOTHING`;
  assert.throws(()=>validateExecutableMigrations(wrongSql), /unsupported state operation/);

  // The rollout seed is legitimate only in version 2, not in version 1.
  const wrongVersion=cloneMigrations();
  wrongVersion[0].operations.push({...ROLLOUT_SINGLETON_OPERATION});
  assert.throws(()=>validateExecutableMigrations(wrongVersion), /1 contains an unsupported state operation/);
});

test('plan operations and the execution self-checksum are both pinned', ()=>{
  // Swap two plan operations: still valid individually, but the canonical plan fingerprint changes.
  const reordered=cloneMigrations();
  const operations=reordered[0].operations;
  assert.ok(operations.length>=2);
  [operations[0], operations[1]]=[operations[1], operations[0]];
  reseal(reordered[0]);
  reordered[0].checksum=EXECUTABLE_MIGRATIONS[0].checksum;
  assert.throws(()=>validateExecutableMigrations(reordered), /1 changed its canonical plan operations/);

  // Duplicate the allowed version 2 seed: plan operations are intact, but the recorded
  // checksum no longer matches the executable payload.
  const duplicated=cloneMigrations();
  duplicated[1].operations.push({...ROLLOUT_SINGLETON_OPERATION});
  assert.throws(()=>validateExecutableMigrations(duplicated), /2 checksum does not match/);
});

function temporaryDatabase(){
  const directory=mkdtempSync(join(tmpdir(),'randori-cov-ledger-'));
  const db=createClient({url:`file:${join(directory,'ledger.sqlite')}`});
  return {db,close(){ db.close(); rmSync(directory,{recursive:true,force:true}); }};
}

function ledgerRow(migration,overrides={}){
  return {
    version:migration.version, name:migration.name, checksum:migration.checksum,
    applied_at:'2026-09-18 12:00:00', execution_ms:5, disposition:'applied', ...overrides,
  };
}

test('ledger validation detects gaps, schema-ahead databases and manifest drift', ()=>{
  const migrations=EXECUTABLE_MIGRATIONS.slice(0, 3);
  assert.throws(()=>validateMigrationLedger('rows', migrations), MigrationLedgerError);
  assert.deepEqual(validateMigrationLedger([], migrations), {currentVersion:0, rows:[]});

  const gap=validateLedgerError([ledgerRow(migrations[0]), ledgerRow(migrations[2])], migrations);
  assert.match(gap.message, /gap at version 2/);
  assert.deepEqual(gap.details, {expectedVersion:2});
  assert.match(validateLedgerError([{...ledgerRow(migrations[0]), version:'one'}], migrations).message, /gap at version 1/);

  // A database migrated by a newer release must not be "repaired" by an older one.
  const ahead=validateLedgerError(EXECUTABLE_MIGRATIONS.slice(0, 4).map(migration=>ledgerRow(migration)), migrations);
  assert.equal(ahead.message, 'Database schema is newer than this application');
  assert.deepEqual(ahead.details, {databaseVersion:4, applicationVersion:3});
  assert.equal(validateLedgerError([ledgerRow(migrations[0])], []).details.applicationVersion, 0);

  assert.match(validateLedgerError([ledgerRow(migrations[0], {name:'renamed'})], migrations).message, /does not match the immutable manifest/);
  assert.match(validateLedgerError([ledgerRow(migrations[0], {checksum:HEX})], migrations).message, /does not match the immutable manifest/);
});

function validateLedgerError(rows, migrations){
  try{ validateMigrationLedger(rows, migrations); }
  catch(error){
    assert.ok(error instanceof MigrationLedgerError);
    assert.equal(error.code, 'MIGRATION_LEDGER_INVALID');
    return error;
  }
  assert.fail('ledger unexpectedly valid');
}

test('ledger metadata requires real timestamps, durations and an adopted-then-applied order', ()=>{
  const [first, second]=EXECUTABLE_MIGRATIONS;
  const migrations=[first, second];
  for(const applied_at of ['2025-02-29 00:00:00', '2100-02-29 00:00:00', '2026-13-01 00:00:00', '2026-04-31 00:00:00',
    '2026-01-01 24:00:00', '2026-01-01 00:60:00', '2026-01-01 00:00:60', '2026-01-01T00:00:00Z', null]){
    assert.match(validateLedgerError([ledgerRow(first, {applied_at})], migrations).message, /invalid ledger metadata/, String(applied_at));
  }
  for(const applied_at of ['2024-02-29 23:59:59', '2000-02-29 00:00:00', '2026-12-31 12:30:45.123']){
    assert.equal(validateMigrationLedger([ledgerRow(first, {applied_at})], migrations).currentVersion, 1, applied_at);
  }
  for(const overrides of [{execution_ms:-1}, {execution_ms:'slow'}, {disposition:null}, {disposition:'skipped'},
    {disposition:'adopted', execution_ms:3}]){
    assert.throws(()=>validateMigrationLedger([ledgerRow(first, overrides)], migrations), /invalid ledger metadata/, JSON.stringify(overrides));
  }
  // Adoption may only precede applied rows, never follow them.
  assert.throws(
    ()=>validateMigrationLedger([ledgerRow(first), ledgerRow(second, {disposition:'adopted', execution_ms:0})], migrations),
    /Migration 2 has invalid ledger metadata/,
  );
  const mixed=validateMigrationLedger([ledgerRow(first, {disposition:'adopted', execution_ms:0}), ledgerRow(second)], migrations);
  assert.equal(mixed.currentVersion, 2);
  assert.ok(Object.isFrozen(mixed.rows[0]));
  assert.deepEqual(mixed.rows.map(row=>row.disposition), ['adopted', 'applied']);
});

test('ledger reads are bounded and the ledger contract rejects drift and extra objects', async ()=>{
  const fixture=temporaryDatabase();
  try{
    const {db}=fixture;
    assert.equal(await migrationLedgerExists(db), false);
    for(const limit of [0, 1001, 1.5, '10']){
      await assert.rejects(readMigrationLedger(db, {limit}), {name:'TypeError'});
    }
    await createMigrationLedger(db);
    assert.equal(await migrationLedgerExists(db), true);
    await insertMigrationLedgerRow(db, EXECUTABLE_MIGRATIONS[0], {executionMs:1, disposition:'applied'});
    await insertMigrationLedgerRow(db, EXECUTABLE_MIGRATIONS[1], {executionMs:1, disposition:'applied'});
    assert.equal((await readMigrationLedger(db)).length, 2);
    assert.equal((await readMigrationLedger(db, {limit:1})).length, 1);
    assert.deepEqual(await readMigrationLedger({execute:async()=>({})}), []);

    await db.execute('CREATE INDEX schema_migrations_by_name ON schema_migrations(name)');
    await assert.rejects(assertMigrationLedgerContract(db), error=>{
      assert.ok(error instanceof MigrationLedgerError);
      assert.deepEqual(error.details.unexpectedObjects, [{type:'index', name:'schema_migrations_by_name'}]);
      return true;
    });
    await db.execute('DROP INDEX schema_migrations_by_name');
    assert.equal(await assertMigrationLedgerContract(db), true);

    await db.execute('DROP TABLE schema_migrations');
    await db.execute('CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, name TEXT)');
    await assert.rejects(assertMigrationLedgerContract(db), error=>{
      assert.equal(error.message, 'Migration ledger has an incompatible schema');
      assert.ok(error.details.blockers.length>0);
      return true;
    });
  }finally{ fixture.close(); }
});

test('migration retry options are bounded and apply/adopt require a transactional client', async ()=>{
  for(const options of [{maxAttempts:0}, {maxAttempts:11}, {maxAttempts:1.5}, {baseDelayMs:-1}, {baseDelayMs:5001},
    {baseDelayMs:10, maxDelayMs:5}, {maxDelayMs:10_001}, {baseDelayMs:Number.NaN}]){
    await assert.rejects(withMigrationRetry(async()=>'never', options), {name:'TypeError'}, JSON.stringify(options));
  }
  // Retryable conflicts are retried up to the limit, then the last error surfaces.
  const waits=[];
  let attempts=0;
  const busy=Object.assign(new Error('wrapped'), {cause:{message:'database is locked'}});
  await assert.rejects(
    withMigrationRetry(async()=>{ attempts+=1; throw busy; }, {maxAttempts:3, baseDelayMs:2, maxDelayMs:3, sleep:async ms=>{ waits.push(ms); }}),
    error=>error===busy,
  );
  assert.equal(attempts, 3);
  assert.deepEqual(waits, [2, 3]);

  for(const migrate of [applyMigrations, adoptMigrations]){
    await assert.rejects(migrate(null), {name:'TypeError'});
    await assert.rejects(migrate({execute(){}}), {name:'TypeError'});
  }
});

test('CHECK-constraint state accepts integer-like strings and rejects anything else', async ()=>{
  const reader=value=>({execute:async()=>({rows:[{ignore_check_constraints:value}]})});
  assert.equal(await readCheckConstraintsEnforced(reader(' 0 ')), true);
  assert.equal(await readCheckConstraintsEnforced(reader('1')), false);
  assert.equal(await readCheckConstraintsEnforced(reader('off')), false);
  assert.equal(await readCheckConstraintsEnforced(reader(null)), false);
});
