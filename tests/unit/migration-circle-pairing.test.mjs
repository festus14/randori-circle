import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createClient } from '@libsql/client';

import { EXECUTABLE_MIGRATIONS } from '../../db/executable-migrations.js';
import {
  MigrationError,
  applyMigrations,
  inspectMigrationState,
  prepareMigrationConnection,
} from '../../db/migration-runner.js';

const NO_RETRY=Object.freeze({maxAttempts:1,baseDelayMs:0,maxDelayMs:0});
const THROUGH_V12=EXECUTABLE_MIGRATIONS.slice(0,12);
const V13=EXECUTABLE_MIGRATIONS[12];
const CYCLE_KEY='a'.repeat(64);

function fixture(){
  const directory=mkdtempSync(join(tmpdir(),'randori-circle-pairing-migration-'));
  const url=`file:${join(directory,'test.sqlite')}`;
  let db=createClient({url});
  return {
    get db(){ return db; },
    reopen(){ db.close(); db=createClient({url}); return db; },
    close(){ db.close(); rmSync(directory,{recursive:true,force:true}); },
  };
}

async function apply(db,migrations=EXECUTABLE_MIGRATIONS){
  await prepareMigrationConnection(db);
  const before=await inspectMigrationState(db,{migrations});
  return applyMigrations(db,{expectedStateFingerprint:before.stateFingerprint,migrations,retry:NO_RETRY});
}

async function seedParents(db){
  await db.execute(`INSERT INTO auth_accounts
    (id,email,password_hash,display_name,color,is_demo)
    VALUES (1,'owner@example.test','hash','Owner','#123456',0),
           (2,'member@example.test','hash','Member','#654321',0)`);
  await db.execute(`INSERT INTO circles
    (id,public_id,slug,name,is_primary,created_by) VALUES (20,'circle-secondary','secondary','Secondary',0,1)`);
  await db.execute(`INSERT INTO pairing_cycles
    (scope_key,circle_id,cycle_key,cycle_id,starts_at,ends_at,cutoff_at,time_zone,default_source)
    VALUES ('circle:20',20,'${CYCLE_KEY}','2026-W39','2026-09-20T07:00:00.000Z',
      '2026-09-27T07:00:00.000Z','2026-09-20T07:00:00.000Z','Europe/London','cycle_default')`);
}

async function seedPublication(db){
  const inserted=await db.execute({
    sql:`INSERT INTO circle_pairing_publications
      (scope_key,circle_id,cycle_key,cycle_id,starts_at,ends_at,cutoff_at,time_zone,
       generation_token,algorithm_version,algorithm_seed,participant_count)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?) RETURNING id`,
    args:['circle:20',20,CYCLE_KEY,'2026-W39','2026-09-20T07:00:00.000Z',
      '2026-09-27T07:00:00.000Z','2026-09-20T07:00:00.000Z','Europe/London',
      '11111111-1111-4111-8111-111111111111','fair-seeded-v1',`circle:20:${CYCLE_KEY}:weekly`,2],
  });
  return Number(inserted.rows[0].id);
}

test('v13 installs only canonical circle pairing tables and read indexes',async()=>{
  const item=fixture();
  try{
    const result=await apply(item.db);
    assert.equal(result.toVersion,13);
    assert.deepEqual(V13.operations.map(operation=>operation.name),[
      'circle_pairing_publications','circle_pairing_eligibility','circle_pairing_groups',
      'idx_circle_pairing_publications_circle_cycle','idx_circle_pairing_eligibility_scope_user',
      'idx_circle_pairing_groups_user_a','idx_circle_pairing_groups_user_b',
    ]);
    const objects=await item.db.execute(`SELECT name FROM sqlite_schema
      WHERE name LIKE 'circle_pairing_%' OR name LIKE 'idx_circle_pairing_%' ORDER BY name`);
    assert.deepEqual(objects.rows.map(row=>String(row.name)),[
      'circle_pairing_eligibility','circle_pairing_groups','circle_pairing_publications',
      'idx_circle_pairing_eligibility_scope_user','idx_circle_pairing_groups_user_a',
      'idx_circle_pairing_groups_user_b','idx_circle_pairing_publications_circle_cycle',
    ]);
  }finally{ item.close(); }
});

test('managed v12 upgrades once to v13 and canonical rows survive restart',async()=>{
  const item=fixture();
  try{
    await apply(item.db,THROUGH_V12);
    const before=await inspectMigrationState(item.db);
    assert.equal(before.currentVersion,12);
    const upgraded=await applyMigrations(item.db,{expectedStateFingerprint:before.stateFingerprint,retry:NO_RETRY});
    assert.deepEqual(upgraded.applied.map(entry=>entry.version),[13]);
    await seedParents(item.db);
    const publicationId=await seedPublication(item.db);
    await item.db.execute({
      sql:`INSERT INTO circle_pairing_eligibility
        (publication_id,scope_key,circle_id,cycle_key,user_id,is_available,availability_version,availability_source,position)
        VALUES (?,?,?,?,?,1,0,'cycle_default',0),(?,?,?,?,?,1,2,'user',1)`,
      args:[publicationId,'circle:20',20,CYCLE_KEY,1,publicationId,'circle:20',20,CYCLE_KEY,2],
    });
    await item.db.execute({
      sql:`INSERT INTO circle_pairing_groups
        (publication_id,scope_key,circle_id,cycle_key,position,user_a_id,user_b_id,is_solo)
        VALUES (?,?,?,?,0,1,2,0)`,args:[publicationId,'circle:20',20,CYCLE_KEY],
    });
    const reopened=item.reopen();
    await prepareMigrationConnection(reopened);
    const state=await inspectMigrationState(reopened);
    assert.equal(state.currentVersion,13);
    assert.equal(state.schemaExact,true);
    assert.equal(Number((await reopened.execute(`SELECT COUNT(*) AS count FROM circle_pairing_groups`)).rows[0].count),1);
  }finally{ item.close(); }
});

test('v13 rejects cross-scope children, unproven members, invalid solo rows, and deletion',async()=>{
  const item=fixture();
  try{
    await apply(item.db);
    await seedParents(item.db);
    const publicationId=await seedPublication(item.db);
    await item.db.execute({
      sql:`INSERT INTO circle_pairing_eligibility
        (publication_id,scope_key,circle_id,cycle_key,user_id,is_available,availability_version,availability_source,position)
        VALUES (?,?,?,?,?,1,0,'cycle_default',0)`,args:[publicationId,'circle:20',20,CYCLE_KEY,1],
    });
    for(const operation of [
      ()=>item.db.execute({sql:`INSERT INTO circle_pairing_eligibility
        (publication_id,scope_key,circle_id,cycle_key,user_id,is_available,availability_version,availability_source,position)
        VALUES (?,?,?,?,?,1,0,'cycle_default',1)`,args:[publicationId,'circle:21',21,CYCLE_KEY,2]}),
      ()=>item.db.execute({sql:`INSERT INTO circle_pairing_groups
        (publication_id,scope_key,circle_id,cycle_key,position,user_a_id,user_b_id,is_solo)
        VALUES (?,?,?,?,0,1,2,0)`,args:[publicationId,'circle:20',20,CYCLE_KEY]}),
      ()=>item.db.execute({sql:`INSERT INTO circle_pairing_groups
        (publication_id,scope_key,circle_id,cycle_key,position,user_a_id,user_b_id,is_solo)
        VALUES (?,?,?,?,0,1,1,1)`,args:[publicationId,'circle:20',20,CYCLE_KEY]}),
      ()=>item.db.execute({sql:`DELETE FROM circle_pairing_publications WHERE id=?`,args:[publicationId]}),
      ()=>item.db.execute(`DELETE FROM circles WHERE id=20`),
    ]) await assert.rejects(operation,error=>String(error?.code||'').startsWith('SQLITE_CONSTRAINT'));
  }finally{ item.close(); }
});

test('a failed v13 operation rolls back all new objects and its ledger row',async()=>{
  const item=fixture();
  try{
    await apply(item.db,THROUGH_V12);
    const before=await inspectMigrationState(item.db);
    const wrapped={
      execute:statement=>item.db.execute(statement),
      async transaction(mode){
        const transaction=await item.db.transaction(mode);
        return {
          async execute(statement){
            const result=await transaction.execute(statement);
            if(String(statement?.sql||statement).includes('idx_circle_pairing_groups_user_b')){
              throw new Error('forced v13 failure');
            }
            return result;
          },
          commit:()=>transaction.commit(),rollback:()=>transaction.rollback(),close:()=>transaction.close(),
        };
      },
    };
    await assert.rejects(
      applyMigrations(wrapped,{expectedStateFingerprint:before.stateFingerprint,retry:NO_RETRY}),
      error=>error instanceof MigrationError&&error.code==='MIGRATION_FAILED',
    );
    const objects=await item.db.execute(`SELECT name FROM sqlite_schema
      WHERE name LIKE 'circle_pairing_%' OR name LIKE 'idx_circle_pairing_%'`);
    assert.deepEqual(objects.rows,[]);
    assert.equal(Number((await item.db.execute(`SELECT MAX(version) AS version FROM schema_migrations`)).rows[0].version),12);
  }finally{ item.close(); }
});
