import assert from 'node:assert/strict';
import { readdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, test } from 'node:test';
import { createClient } from '@libsql/client';

import {
  coalescedDatabaseReadiness,
  databaseReadinessConfiguration,
  inspectDatabaseReadiness,
  readinessTargetExists,
  resolveHealthProbe,
} from '../../api/_health.js';
import { EXECUTABLE_MIGRATIONS } from '../../db/executable-migrations.js';
import { MIGRATION_CONTRACTS } from '../../db/migration-contract.js';
import {
  MIGRATION_LEDGER_CHECKSUM,
  MIGRATION_LEDGER_SQL,
  MIGRATION_LEDGER_TABLE,
} from '../../db/migration-ledger.js';
import { MIGRATION_LEDGER_READINESS_MANIFEST } from '../../db/migration-ledger-readiness.js';
import {
  inspectCompletedMembershipRollout,
  inspectMembershipAdoptionReadiness,
} from '../../db/membership-readiness.js';
import { applyMigrations, inspectMigrationState, prepareMigrationConnection } from '../../db/migration-runner.js';
import { assertReadOnlyStatement, compileSchemaReadinessManifest } from '../../db/schema-inspector.js';
import { SCHEMA_MANIFEST } from '../../db/schema-manifest.js';
import { READINESS_SCHEMA_MANIFEST } from '../../db/schema-readiness-manifest.js';

const NO_RETRY=Object.freeze({maxAttempts:1,baseDelayMs:0,maxDelayMs:0});
const resources=[];

afterEach(async()=>{
  while(resources.length) await resources.pop()();
});

async function databaseFixture({migrations=EXECUTABLE_MIGRATIONS,file=true}={}){
  let directory=null;
  if(file){
    directory=mkdtempSync(join(tmpdir(),'randori-health-'));
    resources.push(()=>rmSync(directory,{recursive:true,force:true}));
  }
  const db=createClient({url:file?`file:${join(directory,'database.sqlite')}`:'file::memory:'});
  resources.push(()=>db.close());
  await prepareMigrationConnection(db);
  const initial=await inspectMigrationState(db,{migrations});
  await applyMigrations(db,{
    migrations,
    expectedStateFingerprint:initial.stateFingerprint,
    retry:NO_RETRY,
  });
  return {db,directory};
}

function sqlText(statement){
  return String(typeof statement==='string'?statement:statement?.sql||'').trim();
}

async function schemaSnapshot(db){
  const result=await db.execute(`SELECT type,name,tbl_name,sql FROM sqlite_schema
    WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name`);
  return (result.rows||[]).map(row=>Object.fromEntries(Object.entries(row).map(([key,value])=>[
    key,typeof value==='bigint'?value.toString():value,
  ])));
}

test('runtime migration contracts remain identical to executable migrations',()=>{
  assert.deepEqual(
    MIGRATION_CONTRACTS,
    EXECUTABLE_MIGRATIONS.map(({version,name,checksum})=>({version,name,checksum})),
  );
  assert.deepEqual(READINESS_SCHEMA_MANIFEST,compileSchemaReadinessManifest(SCHEMA_MANIFEST));
  assert.deepEqual(MIGRATION_LEDGER_READINESS_MANIFEST,compileSchemaReadinessManifest({
    version:1,
    checksum:MIGRATION_LEDGER_CHECKSUM,
    tables:[{name:MIGRATION_LEDGER_TABLE,sql:MIGRATION_LEDGER_SQL}],
    indexes:[],
    toleratedLegacyTables:[],
  }));
});

test('ready inspection is exact, read-only, and creates no schema objects or files',async()=>{
  const {db,directory}=await databaseFixture({file:true});
  const beforeSchema=await schemaSnapshot(db);
  const beforeFiles=readdirSync(directory).sort();
  const statements=[];
  const spy={
    execute(statement){
      const sql=sqlText(statement);
      statements.push({sql,args:statement?.args||[]});
      assertReadOnlyStatement(statement);
      return db.execute(statement);
    },
  };
  assert.equal(await inspectDatabaseReadiness(spy),true);
  assert.equal(await inspectDatabaseReadiness(spy,{membershipRequired:true}),false);
  assert.ok(statements.length>50);
  assert.ok(statements.every(({sql})=>/^(?:SELECT|PRAGMA)\b/i.test(sql)));
  assert.deepEqual(
    statements.find(({sql})=>sql.includes('FROM sqlite_schema')&&sql.includes('type IN'))?.args,
    [161],
  );
  assert.deepEqual(
    statements.find(({sql})=>sql.includes('FROM schema_migrations ORDER BY version'))?.args,
    [13],
  );
  assert.deepEqual(await schemaSnapshot(db),beforeSchema);
  assert.deepEqual(readdirSync(directory).sort(),beforeFiles);
});

test('readiness fails closed for fresh, unmanaged, stale, future, and gapped ledgers',async t=>{
  await t.test('fresh',async()=>{
    const db=createClient({url:'file::memory:'});
    try{
      await prepareMigrationConnection(db);
      assert.equal(await inspectDatabaseReadiness(db),false);
    }finally{ db.close(); }
  });
  await t.test('unmanaged',async()=>{
    const db=createClient({url:'file::memory:'});
    try{
      await prepareMigrationConnection(db);
      for(const migration of EXECUTABLE_MIGRATIONS){
        for(const operation of migration.operations) await db.execute(operation.sql);
      }
      assert.equal(await inspectDatabaseReadiness(db),false);
    }finally{ db.close(); }
  });
  await t.test('stale',async()=>{
    const {db}=await databaseFixture({migrations:EXECUTABLE_MIGRATIONS.slice(0,2)});
    assert.equal(await inspectDatabaseReadiness(db),false);
  });
  await t.test('future',async()=>{
    const {db}=await databaseFixture();
    await db.execute({
      sql:`INSERT INTO schema_migrations
        (version,name,checksum,execution_ms,disposition) VALUES (?,?,?,?,?)`,
      args:[13,'future-schema','f'.repeat(64),0,'applied'],
    });
    await assert.rejects(inspectDatabaseReadiness(db));
  });
  await t.test('gapped',async()=>{
    const {db}=await databaseFixture();
    await db.execute('DELETE FROM schema_migrations WHERE version=2');
    await assert.rejects(inspectDatabaseReadiness(db));
  });
});

test('readiness fails closed for connection settings, schema drift, and rollout drift',async t=>{
  await t.test('database unavailable',async()=>{
    await assert.rejects(
      inspectDatabaseReadiness({execute(){ throw new Error('libsql://private.example/token=secret'); }}),
      /private/,
    );
  });
  await t.test('foreign keys disabled',async()=>{
    const {db}=await databaseFixture();
    await db.execute('PRAGMA foreign_keys=OFF');
    assert.equal(await inspectDatabaseReadiness(db),false);
  });
  await t.test('schema drift',async()=>{
    const {db}=await databaseFixture();
    await db.execute('DROP INDEX idx_pair_sched_pair');
    assert.equal(await inspectDatabaseReadiness(db),false);
  });
  await t.test('membership rollout drift',async()=>{
    const {db}=await databaseFixture();
    await db.execute(`INSERT INTO circles (public_id,slug,name,is_primary)
      VALUES ('unexpected','unexpected','Unexpected',1)`);
    assert.equal(await inspectDatabaseReadiness(db),false);
  });
});

test('completed rollout readiness permits inactive members and historical actors without weakening provenance',async()=>{
  const {db}=await databaseFixture();
  assert.equal((await inspectCompletedMembershipRollout(db)).ok,false);
  await db.execute(`INSERT INTO auth_accounts
    (id,email,password_hash,display_name,color,is_admin,is_demo)
    VALUES
      (1,'creator@example.test','!oauth:test','Creator','#123456',1,0),
      (2,'inactive@example.test','!oauth:test','Inactive','#654321',0,0),
      (3,'owner@example.test','!oauth:test','Owner','#abcdef',1,0)`);
  await db.execute(`INSERT INTO circles
    (id,public_id,slug,name,is_primary,created_by)
    VALUES (1,'primary-public-id','randori-circle','Randori Circle',1,1)`);
  await db.execute(`INSERT INTO circle_memberships
    (circle_id,user_id,role,status,joined_at,updated_at)
    VALUES
      (1,1,'owner','inactive',datetime('now'),datetime('now')),
      (1,3,'owner','active',datetime('now'),datetime('now'))`);
  await db.execute(`INSERT INTO circle_audit_events
    (circle_id,event_type,actor_user_id,subject_user_id,dedupe_key)
    VALUES
      (1,'membership.backfilled',1,1,'membership-backfilled:1:1'),
      (1,'membership.backfilled',1,2,'membership-backfilled:1:2'),
      (1,'membership.backfilled',1,3,'membership-backfilled:1:3'),
      (1,'membership.backfill.completed',1,NULL,'primary-membership-backfill:1:v1')`);
  await db.execute(`UPDATE circle_membership_rollout
    SET registrations_closed=1,updated_at=datetime('now') WHERE id=1`);

  const adoption=await inspectMembershipAdoptionReadiness(db);
  assert.equal(adoption.ok,false,'one-time adoption still requires every existing account to be covered');
  assert.ok(adoption.blockers.includes('closed_rollout_has_uncovered_accounts'));
  assert.equal((await inspectCompletedMembershipRollout(db)).ok,true);
  assert.equal(await inspectDatabaseReadiness(db),true);
  assert.equal(await inspectDatabaseReadiness(db,{membershipRequired:true}),true);

  await db.execute(`DELETE FROM circle_audit_events
    WHERE event_type='membership.backfilled' AND subject_user_id=2`);
  const missingProvenance=await inspectCompletedMembershipRollout(db);
  assert.equal(missingProvenance.ok,false);
  assert.ok(missingProvenance.blockers.includes('closed_rollout_account_audit_invalid'));
  await db.execute(`INSERT INTO circle_audit_events
    (circle_id,event_type,actor_user_id,subject_user_id,dedupe_key)
    VALUES (1,'membership.backfilled',1,2,'membership-backfilled:1:2')`);

  await db.execute(`UPDATE circle_audit_events SET actor_user_id=999
    WHERE event_type='membership.backfilled' AND subject_user_id=2`);
  const wrongActor=await inspectCompletedMembershipRollout(db);
  assert.equal(wrongActor.ok,false);
  assert.ok(wrongActor.blockers.includes('closed_rollout_account_audit_invalid'));
  await db.execute(`UPDATE circle_audit_events SET actor_user_id=1
    WHERE event_type='membership.backfilled' AND subject_user_id=2`);

  await db.execute(`UPDATE circle_audit_events SET dedupe_key='tampered'
    WHERE event_type='membership.backfill.completed'`);
  const tampered=await inspectCompletedMembershipRollout(db);
  assert.equal(tampered.ok,false);
  assert.ok(tampered.blockers.includes('closed_rollout_backfill_audit_invalid'));
  assert.equal(await inspectDatabaseReadiness(db),false);
});

test('configuration and probe routing distinguish liveness from readiness without disclosure',()=>{
  assert.equal(databaseReadinessConfiguration({}),null);
  assert.equal(databaseReadinessConfiguration({TURSO_DATABASE_URL:'not a url',TURSO_AUTH_TOKEN:'secret'}),null);
  assert.equal(databaseReadinessConfiguration({
    NODE_ENV:'production',RANDORI_LOCAL_RUNTIME:'true',TURSO_DATABASE_URL:'file:///tmp/private.sqlite',
  }),null);
  assert.equal(databaseReadinessConfiguration({
    TURSO_DATABASE_URL:'libsql://database.example.test',
  }),null);
  assert.equal(databaseReadinessConfiguration({
    NODE_ENV:'production',TURSO_DATABASE_URL:'http://database.example.test',TURSO_AUTH_TOKEN:'secret',
  }),null);
  assert.equal(databaseReadinessConfiguration({
    NODE_ENV:'production',TURSO_DATABASE_URL:'libsql://database.example.test?token=secret',TURSO_AUTH_TOKEN:'secret',
  }),null);
  const remote=databaseReadinessConfiguration({
    TURSO_DATABASE_URL:'libsql://database.example.test',TURSO_AUTH_TOKEN:'private-token',
  });
  assert.match(remote.cacheKey,/^[a-f0-9]{64}$/);
  assert.equal(remote.membershipRequired,false);
  assert.doesNotMatch(JSON.stringify(remote),/private-token|database\.example/);
  assert.ok(databaseReadinessConfiguration({
    NODE_ENV:'development',RANDORI_LOCAL_RUNTIME:'true',
    TURSO_DATABASE_URL:'file:///tmp/local.sqlite',RANDORI_LOCAL_DATABASE_PATH:'/tmp/local.sqlite',
  }));
  assert.equal(databaseReadinessConfiguration({
    NODE_ENV:'development',RANDORI_LOCAL_RUNTIME:'true',
    TURSO_DATABASE_URL:'file:///tmp/local.sqlite',RANDORI_LOCAL_DATABASE_PATH:'/tmp/other.sqlite',
  }),null);
  const membership=databaseReadinessConfiguration({
    TURSO_DATABASE_URL:'libsql://database.example.test',TURSO_AUTH_TOKEN:'private-token',
    CIRCLE_MEMBERSHIP_ENABLED:'true',
  });
  assert.equal(membership.membershipRequired,true);
  assert.notEqual(membership.cacheKey,remote.cacheKey);
  assert.equal(resolveHealthProbe({url:'/api/health'}),'ready');
  assert.equal(resolveHealthProbe({url:'/api/health/live'}),'live');
  assert.equal(resolveHealthProbe({url:'/api/healthz'}),'live');
  assert.equal(resolveHealthProbe({url:'/api/readyz'}),'ready');
  assert.equal(resolveHealthProbe({url:'/api/health',query:{probe:'liveness'}}),'live');
  assert.equal(resolveHealthProbe({url:'/api/health',query:{probe:'unknown'}}),'invalid');
});

test('local readiness target preflight rejects missing, linked, and non-regular paths',()=>{
  const directory=realpathSync(mkdtempSync(join(tmpdir(),'randori-health-target-')));
  resources.push(()=>rmSync(directory,{recursive:true,force:true}));
  const databasePath=join(directory,'database.sqlite');
  const configuration={local:true,localDatabasePath:databasePath};
  assert.equal(readinessTargetExists(configuration),false);
  writeFileSync(databasePath,'not opened by readiness');
  assert.equal(readinessTargetExists(configuration),true);
  const linkedPath=join(directory,'linked.sqlite');
  symlinkSync(databasePath,linkedPath);
  assert.equal(readinessTargetExists({local:true,localDatabasePath:linkedPath}),false);
  assert.equal(readinessTargetExists({local:false,localDatabasePath:null}),true);
});

test('concurrent readiness is coalesced without retaining a stale result',async()=>{
  const key='a'.repeat(64);
  let calls=0;
  const {db}=await databaseFixture();
  const delayed={
    async execute(statement){
      calls+=1;
      await new Promise(resolve=>setImmediate(resolve));
      return db.execute(statement);
    },
  };
  const [first,second]=await Promise.all([
    coalescedDatabaseReadiness(key,delayed),
    coalescedDatabaseReadiness(key,delayed),
  ]);
  assert.equal(first,true);
  assert.equal(second,true);
  const firstProbeCalls=calls;
  assert.ok(firstProbeCalls>50);
  assert.equal(await coalescedDatabaseReadiness(key,delayed),true);
  assert.ok(calls>firstProbeCalls,'a settled success must not be cached');
});

test('readiness deadlines are bounded while the in-flight query remains coalesced',async()=>{
  const key='b'.repeat(64);
  let release;
  let calls=0;
  const gate=new Promise(resolve=>{ release=resolve; });
  const database={async execute(){ calls+=1; await gate; return {rows:[]}; }};
  await assert.rejects(
    coalescedDatabaseReadiness(key,database,{timeoutMs:10}),
    /deadline exceeded/,
  );
  assert.equal(calls,1);
  release();
  await new Promise(resolve=>setImmediate(resolve));
  assert.throws(
    ()=>coalescedDatabaseReadiness(key,database,{timeoutMs:0}),
    /readiness timeout/,
  );
});
