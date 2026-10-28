// Readiness tolerance for zero-downtime additive releases (ID-87, #371), with
// the checked-in contracts, where migration 22 is the first 'additive' one
// (#353) and migrations 1-21 stay 'breaking'.
//
// - A breaking latest migration keeps every readiness surface strict one
//   version behind (unchanged behaviour).
// - Code one version behind the database stays not ready (unchanged).
// - The tolerance never reaches two versions behind.
// - Mutation tests: copies of db/migration-compatibility.js with the
//   tolerance widened (to N-2, to breaking migrations, to an older additive
//   migration, or with the schema check dropped) all fail the policy.
// The positive case, code at N with N additive on a real N-1 database, is in
// migration-additive-release.test.mjs.
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { afterEach, test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { createClient } from '@libsql/client';

import { readAdminDiagnostics, readMigrationLedgerSummary } from '../../api/_admin-diagnostics.js';
import { ensureCirclePairingReadiness } from '../../api/_circle-pairing.js';
import { inspectDatabaseReadiness } from '../../api/_health.js';
import { pairingSchemaV6Ready } from '../../api/_pairing-readiness.js';
import { schemaCapabilityAvailable } from '../../api/_schema-capability.js';
import { ensureSecondaryScheduleReadiness } from '../../api/_secondary-schedule.js';
import { EXECUTABLE_MIGRATIONS } from '../../db/executable-migrations.js';
import * as compatibility from '../../db/migration-compatibility.js';
import { MIGRATION_CONTRACTS, validateMigrationContracts } from '../../db/migration-contract.js';
import { MIGRATION_PLANS } from '../../db/migration-plan.js';
import { applyMigrations, inspectMigrationState, prepareMigrationConnection } from '../../db/migration-runner.js';
import { compileSchemaReadinessManifest } from '../../db/schema-inspector.js';
import {
  SCHEMA_OPERATION_SETS,
  TOLERATED_LEGACY_TABLES,
  resolveCurrentArtifacts,
} from '../../db/schema-manifest.js';
import { READINESS_SCHEMA_MANIFEST } from '../../db/schema-readiness-manifest.js';
import { copyMigratedDatabase } from '../support/migrated-db.mjs';

const ROOT=resolve(dirname(fileURLToPath(import.meta.url)),'..','..');
const NO_RETRY=Object.freeze({maxAttempts:1,baseDelayMs:0,maxDelayMs:0});
const HEX='a'.repeat(64);
const resources=[];

afterEach(async()=>{
  while(resources.length){ try{ await resources.pop()(); }catch{} }
});

function introducedBy(version){
  const plan=MIGRATION_PLANS[version-1];
  return Object.freeze({tables:[...plan.tables],indexes:[...plan.indexes],triggers:[...plan.triggers]});
}

// The checked-in contracts with the listed versions declared additive. Only
// readiness reads these; it does not re-run the migration check.
function declaredAdditive(...versions){
  const contracts=Object.freeze(MIGRATION_CONTRACTS.map(contract=>versions.includes(contract.version)
    ?Object.freeze({...contract,compatibility:'additive',introduces:introducedBy(contract.version)})
    :contract));
  validateMigrationContracts(contracts);
  return contracts;
}

// The structural manifest of code that knows migrations 1..version.
function manifestAt(version){
  const sets=SCHEMA_OPERATION_SETS.slice(0,version);
  return compileSchemaReadinessManifest({
    version:1,
    checksum:HEX,
    tables:resolveCurrentArtifacts(sets,'ensure-table'),
    indexes:resolveCurrentArtifacts(sets,'ensure-index'),
    triggers:resolveCurrentArtifacts(sets,'ensure-trigger'),
    toleratedLegacyTables:[...TOLERATED_LEGACY_TABLES],
  });
}

async function databaseAt(version){
  const directory=mkdtempSync(join(tmpdir(),'randori-release-policy-'));
  resources.push(()=>rmSync(directory,{recursive:true,force:true}));
  const path=join(directory,'database.sqlite');
  if(version===EXECUTABLE_MIGRATIONS.length) await copyMigratedDatabase(path);
  const db=createClient({url:`file:${path}`});
  resources.push(()=>db.close());
  await prepareMigrationConnection(db);
  if(version===EXECUTABLE_MIGRATIONS.length) return db;
  const migrations=EXECUTABLE_MIGRATIONS.slice(0,version);
  const initial=await inspectMigrationState(db,{migrations});
  await applyMigrations(db,{migrations,expectedStateFingerprint:initial.stateFingerprint,retry:NO_RETRY});
  return db;
}

const ready=async()=>({ready:true,reason:null});
const N=MIGRATION_CONTRACTS.length;

test('migrations 1-21 stay breaking, and v22/v23 are additive migrations',()=>{
  assert.ok(MIGRATION_CONTRACTS.slice(0,21).every(contract=>contract.compatibility==='breaking'));
  assert.equal(MIGRATION_CONTRACTS[21].compatibility,'additive');
  assert.equal(MIGRATION_CONTRACTS.at(-1).compatibility,'additive');
  assert.equal(MIGRATION_CONTRACTS.at(-1).version,23);
  assert.equal(compatibility.pendingAdditiveContract()?.version,23);
  assert.equal(compatibility.ADDITIVE_READINESS_LAG,1);
});

test('code at M with a breaking M is not ready on a real M-1 database; declaring M additive is the only difference',async()=>{
  // M=21 pins the last breaking migration: code at 22 is already ready on
  // a 21 database (v22 is additive), so the breaking case is modelled one
  // version down. The database at 20 is two behind the checked-in code,
  // so the diagnostics card still reports it as behind.
  const M=21;
  const breakingContracts=MIGRATION_CONTRACTS.slice(0,M);
  const db=await databaseAt(M-1);
  assert.equal(await inspectDatabaseReadiness(db,{contracts:breakingContracts,manifest:manifestAt(M)}),false);
  await assert.rejects(ensureCirclePairingReadiness(db,{contracts:breakingContracts}),{code:'CIRCLE_PAIRING_SCHEMA_UNAVAILABLE'});
  await assert.rejects(ensureSecondaryScheduleReadiness(db,{contracts:breakingContracts}),{code:'SECONDARY_SCHEDULE_SCHEMA_UNAVAILABLE'});
  const card=(await readAdminDiagnostics(db,{env:{},checkReadiness:ready})).cards.readiness;
  assert.deepEqual([card.status,card.category,card.ledger.state,card.ledger.pendingVersion],
    ['failed','ledger_behind','behind',null]);
  assert.equal(await schemaCapabilityAvailable(db,{version:M,env:{}}),false);
  // Pairing publication checks only the v6 core contract and has always
  // accepted any later ledger prefix; no migration since v6 changes its
  // fingerprint, and an additive one cannot (no unique index or trigger on an
  // existing table).
  assert.equal(await pairingSchemaV6Ready(db),true);

  // The same database and code, with M declared additive, is ready.
  // The manifest must match the modelled code (1..M): the checked-in
  // readiness manifest is at v23, which this database does not have.
  const additive=declaredAdditive(M).slice(0,M);
  assert.equal(await inspectDatabaseReadiness(db,{contracts:additive,manifest:manifestAt(M)}),true);
  assert.equal(await ensureCirclePairingReadiness(db,{contracts:additive}),true);
  const summary=await readMigrationLedgerSummary(db,{contracts:additive});
  assert.deepEqual([summary.state,summary.currentVersion,summary.expectedVersion,summary.pendingVersion],
    ['pending_additive',M-1,M,M]);
});

test('code at N is ready on a database at N either way',async()=>{
  const db=await databaseAt(N);
  assert.equal(await inspectDatabaseReadiness(db),true);
  assert.equal(await inspectDatabaseReadiness(db,{contracts:declaredAdditive(N)}),true);
  assert.equal(await ensureCirclePairingReadiness(db),true);
  assert.equal(await ensureSecondaryScheduleReadiness(db),true);
  assert.equal((await readMigrationLedgerSummary(db)).state,'current');
  assert.equal(await schemaCapabilityAvailable(db,{version:N,env:{}}),true);
});

test('code at N-1 stays not ready on a database at N, whatever N is',async()=>{
  const previousCode={contracts:MIGRATION_CONTRACTS.slice(0,N-1),manifest:manifestAt(N-1)};
  // Sanity: that code is ready on its own version.
  assert.equal(await inspectDatabaseReadiness(await databaseAt(N-1),previousCode),true);

  const db=await databaseAt(N);
  await assert.rejects(inspectDatabaseReadiness(db,previousCode),{name:'MigrationLedgerError'});
  await assert.rejects(ensureCirclePairingReadiness(db,{contracts:previousCode.contracts}),
    {code:'CIRCLE_PAIRING_SCHEMA_UNAVAILABLE'});
  const additivePrevious={...previousCode,contracts:declaredAdditive(N-1).slice(0,N-1)};
  await assert.rejects(inspectDatabaseReadiness(db,additivePrevious),{name:'MigrationLedgerError'});
  assert.equal((await readMigrationLedgerSummary(db,{contracts:previousCode.contracts})).state,'ahead');
});

test('the tolerance never reaches two versions behind, even when both pending migrations are additive',async()=>{
  const both=declaredAdditive(N-1,N);
  const db=await databaseAt(N-2);
  assert.equal(await inspectDatabaseReadiness(db,{contracts:both}),false);
  await assert.rejects(ensureCirclePairingReadiness(db,{contracts:both}),{code:'CIRCLE_PAIRING_SCHEMA_UNAVAILABLE'});
  assert.equal((await readMigrationLedgerSummary(db,{contracts:both})).state,'behind');
  // An additive N-1 under a breaking N tolerates nothing either.
  const olderOnly=Object.freeze(MIGRATION_CONTRACTS.map(contract=>{
    if(contract.version===N) return Object.freeze({version:contract.version,name:contract.name,
      checksum:contract.checksum,compatibility:'breaking'});
    if(contract.version===N-1) return Object.freeze({...contract,compatibility:'additive',
      introduces:introducedBy(N-1)});
    return contract;
  }));
  validateMigrationContracts(olderOnly);
  assert.equal(await inspectDatabaseReadiness(db,{contracts:olderOnly}),false);
  assert.equal(await inspectDatabaseReadiness(await databaseAt(N-1),{contracts:olderOnly}),false);
});

// ---------------------------------------------------------------------------
// Pure policy, shared by the real module and its mutants.
// ---------------------------------------------------------------------------

function contractsOf(...kinds){
  return Object.freeze(kinds.map((kind,index)=>Object.freeze({
    version:index+1,name:`m${index+1}`,checksum:HEX,compatibility:kind,
    ...(kind==='additive'?{introduces:Object.freeze({tables:[`t${index+1}`],indexes:[],triggers:[]})}:{}),
  })));
}

function ledgerAt(version){
  return {currentVersion:version,rows:Array.from({length:version},(_value,index)=>({version:index+1}))};
}

// [contracts, ledger version, expected ready]
const POLICY=Object.freeze([
  [contractsOf('breaking','breaking','additive'),3,true],
  [contractsOf('breaking','breaking','additive'),2,true],
  [contractsOf('breaking','breaking','additive'),1,false],
  [contractsOf('breaking','breaking','breaking'),3,true],
  [contractsOf('breaking','breaking','breaking'),2,false],
  [contractsOf('breaking','additive','additive'),1,false],
  [contractsOf('breaking','additive','breaking'),2,false],
  [contractsOf('breaking','additive','breaking'),1,false],
  [contractsOf('breaking'),0,false],
]);

function policyFailures(module){
  const failures=[];
  for(const [contracts,version,expected] of POLICY){
    const actual=module.ledgerReadiness(ledgerAt(version),{contracts}).ready;
    if(actual!==expected) failures.push(`${contracts.map(item=>item.compatibility[0]).join('')}@${version}`);
  }
  const additive=declaredAdditive(N);
  const pending=module.ledgerReadiness(ledgerAt(N-1),{contracts:additive});
  try{
    const manifest=module.readinessManifestForLedger(READINESS_SCHEMA_MANIFEST,pending,{contracts:additive});
    const introduced=introducedBy(N);
    for(const kind of ['tables','indexes','triggers']){
      const expected=(READINESS_SCHEMA_MANIFEST[kind]||[]).map(item=>item.name)
        .filter(name=>!introduced[kind].includes(name));
      if(JSON.stringify((manifest[kind]||[]).map(item=>item.name))!==JSON.stringify(expected)) failures.push(`manifest:${kind}`);
    }
  }catch(error){
    failures.push(`manifest:${error.message}`);
  }
  return failures;
}

test('the real tolerance satisfies the release policy',()=>{
  assert.deepEqual(policyFailures(compatibility),[]);
});

const SOURCE_PATH=join(ROOT,'db','migration-compatibility.js');
const MUTANTS=Object.freeze([
  ['tolerate two versions behind',
    'export const ADDITIVE_READINESS_LAG=1;','export const ADDITIVE_READINESS_LAG=2;'],
  ['tolerate anything within the lag',
    'currentVersion===pending.version-ADDITIVE_READINESS_LAG',
    'currentVersion>=pending.version-ADDITIVE_READINESS_LAG-1'],
  ['ignore the compatibility label',
    'latest?.compatibility===MIGRATION_COMPATIBILITY.ADDITIVE','latest?.compatibility!==undefined'],
  ['tolerate an older additive migration under a breaking latest one',
    'const latest=contracts.at(-1);',
    'const latest=contracts.findLast(item=>item.compatibility===MIGRATION_COMPATIBILITY.ADDITIVE);'],
  ['skip table checks while a migration is pending',
    'tables:manifest.tables.filter(item=>!introduced.tables.has(item.name)),','tables:[],'],
  ['skip index checks while a migration is pending',
    'indexes:manifest.indexes.filter(item=>!introduced.indexes.has(item.name)),','indexes:[],'],
  ['skip trigger checks while a migration is pending',
    'previous.triggers=manifest.triggers.filter(item=>!introduced.triggers.has(item.name));','previous.triggers=[];'],
]);

async function loadVariant(t,source,label){
  const directory=mkdtempSync(join(tmpdir(),'randori-tolerance-mutant-'));
  t.after(()=>rmSync(directory,{recursive:true,force:true}));
  const dbUrl=pathToFileURL(join(ROOT,'db')).href;
  const path=join(directory,`${label}.mjs`);
  writeFileSync(path,source.replaceAll("from './","from '"+dbUrl+'/'));
  return import(pathToFileURL(path).href);
}

test('mutation tests: widening the tolerance by accident fails the policy',async t=>{
  const source=readFileSync(SOURCE_PATH,'utf8');
  // An unmodified copy loaded the same way passes, so failures below come
  // from the mutation and not from the harness.
  assert.deepEqual(policyFailures(await loadVariant(t,source,'unmodified')),[]);
  for(const [index,[label,from,to]] of MUTANTS.entries()){
    assert.equal(source.split(from).length,2,`mutation "${label}" must match the source exactly once`);
    const mutant=await loadVariant(t,source.replace(from,to),`mutant-${index}`);
    assert.notDeepEqual(policyFailures(mutant),[],`mutation "${label}" survived`);
  }
});

// ---------------------------------------------------------------------------
// Edge cases of the pure helpers.
// ---------------------------------------------------------------------------

test('ledger readiness fails closed for malformed ledgers and needs a matching manifest request',async()=>{
  const additive=contractsOf('breaking','additive');
  for(const ledger of [null,{},{currentVersion:2},{currentVersion:2,rows:[{}]},{currentVersion:-1,rows:[]},
    {currentVersion:1.5,rows:[{}]}]){
    assert.equal(compatibility.ledgerReadiness(ledger,{contracts:additive}).ready,false);
  }
  assert.deepEqual({...compatibility.ledgerReadiness(ledgerAt(1),{contracts:additive})},
    {currentVersion:1,expectedVersion:2,ready:true,state:'pending_additive',pendingVersion:2});
  assert.equal(compatibility.ledgerReadiness(ledgerAt(2)).ready,false,'defaults are the checked-in contracts');
  assert.equal(compatibility.pendingAdditiveContract(contractsOf('additive')),null,'a lone baseline is never pending');
  assert.deepEqual({...compatibility.ledgerReadiness(ledgerAt(0),{contracts:[]})},
    {currentVersion:0,expectedVersion:0,ready:false,state:'behind',pendingVersion:null},'no contracts, nothing is ready');

  const manifest={tables:[{name:'t1'},{name:'t2'}],indexes:[],version:1,checksum:HEX};
  assert.throws(()=>compatibility.readinessManifestForLedger(null,{ready:true}),/schema manifest is required/);
  assert.throws(()=>compatibility.readinessManifestForLedger(manifest,{ready:false}),/ready ledger is required/);
  assert.throws(()=>compatibility.readinessManifestForLedger(manifest,
    {ready:true,state:'pending_additive',pendingVersion:3},{contracts:additive}),/does not match/);
  assert.throws(()=>compatibility.readinessManifestForLedger(manifest,
    {ready:true,state:'pending_additive',pendingVersion:2},{contracts:contractsOf('breaking','breaking')}),/does not match/);
  assert.equal(compatibility.readinessManifestForLedger(manifest,{ready:true,state:'current'}),manifest);
  const previous=compatibility.readinessManifestForLedger(manifest,
    compatibility.ledgerReadiness(ledgerAt(1),{contracts:additive}),{contracts:additive});
  assert.deepEqual(previous.tables,[{name:'t1'}]);
  assert.equal('triggers' in previous,false,'a manifest without triggers stays without triggers');
  assert.ok(Object.isFrozen(previous));

  const missing=await compatibility.inspectLedgerReadiness({execute:async()=>({rows:[]})},{contracts:additive});
  assert.deepEqual({...missing},{currentVersion:0,expectedVersion:2,ready:false,state:'missing',pendingVersion:null});
});
