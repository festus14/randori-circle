import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createClient } from '@libsql/client';

import { EXECUTABLE_MIGRATIONS } from '../../db/executable-migrations.js';
import { MIGRATION_CONTRACTS } from '../../db/migration-contract.js';
import { inspectMigrationCompatibility } from '../../db/migration-compatibility-check.js';
import { applyMigrations, inspectMigrationState, prepareMigrationConnection } from '../../db/migration-runner.js';
import { inspectDatabaseReadiness } from '../../api/_health.js';
import { schemaCapabilityAvailable } from '../../api/_schema-capability.js';

const NO_RETRY=Object.freeze({maxAttempts:1,baseDelayMs:0,maxDelayMs:0});
const THROUGH_V25=EXECUTABLE_MIGRATIONS.slice(0,25);
const V26=EXECUTABLE_MIGRATIONS[25];
const AT='2026-09-20T10:00:00.000Z';
const LATER='2026-09-20T10:05:00.000Z';

function fixture(){
  const directory=mkdtempSync(join(tmpdir(),'randori-interview-session-migration-'));
  const db=createClient({url:`file:${join(directory,'test.sqlite')}`});
  return {db,close(){ db.close(); rmSync(directory,{recursive:true,force:true}); }};
}

async function apply(db,migrations=EXECUTABLE_MIGRATIONS){
  await prepareMigrationConnection(db);
  const before=await inspectMigrationState(db,{migrations});
  return applyMigrations(db,{expectedStateFingerprint:before.stateFingerprint,migrations,retry:NO_RETRY});
}

async function seedPair(db,{ai=false,mixed=false}={}){
  await db.execute(`INSERT INTO auth_accounts (id,email,password_hash,display_name,color,is_demo) VALUES
    (1,'one@example.test','hash','One','#111111',0),(2,'two@example.test','hash','Two','#222222',0),
    (9,'outside@example.test','hash','Outside','#999999',0)`);
  await db.execute(`INSERT INTO pairing_weeks (id,week_label,week_start,is_demo)
    VALUES (10,'2026-W38','2026-09-14T07:00:00.000Z',0)`);
  await db.execute({sql:`INSERT INTO pairing_groups (id,week_id,user_a_id,user_b_id,user_c_id,is_ai_pair)
    VALUES (20,10,1,?,NULL,?)`,args:[ai?1:2,ai?1:0]});
  await db.execute(`INSERT INTO pairing_participants (week_id,user_id,position,source) VALUES (10,1,0,'auth')`);
  if(!ai) await db.execute({sql:`INSERT INTO pairing_participants (week_id,user_id,position,source) VALUES (10,2,1,?)`,args:[mixed?'users':'auth']});
}

const insertSql=`INSERT INTO pair_interview_sessions
  (week_id,pair_group_id,pair_user_a_id,pair_user_b_id,admission,admitted_at,editing_locked,
    revision,updated_by,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)`;
const valid=[10,20,1,2,null,null,0,1,2,AT,AT];

test('v26 is declared additive and introduces exactly one table, its index and its own guards',()=>{
  const contract=MIGRATION_CONTRACTS[25];
  assert.equal(contract.version,26);
  assert.equal(contract.compatibility,'additive');
  assert.deepEqual(V26.operations.map(operation=>operation.name),[
    'pair_interview_sessions','idx_pair_interview_sessions_updated_by',
    'trg_pair_interview_sessions_insert_guard','trg_pair_interview_sessions_update_guard',
  ]);
  assert.deepEqual([...contract.introduces.tables,...contract.introduces.indexes,...contract.introduces.triggers],
    V26.operations.map(operation=>operation.name));
  // Every trigger sits on the new table: no existing table changes behaviour.
  assert.ok(V26.operations.filter(operation=>operation.operation==='ensure-trigger')
    .every(operation=>operation.table==='pair_interview_sessions'));
  assert.deepEqual(inspectMigrationCompatibility({migrations:EXECUTABLE_MIGRATIONS}),[]);
});

test('a managed v25 database upgrades by v26 alone and stays ready one additive migration behind',async()=>{
  const item=fixture();
  try{
    await apply(item.db,THROUGH_V25); await seedPair(item.db);
    assert.equal(await inspectDatabaseReadiness(item.db),true,'code at v26 is ready on a v25 database');
    assert.equal(await schemaCapabilityAvailable(item.db,{version:26,env:{}}),false);
    const before=await inspectMigrationState(item.db);
    assert.equal(before.currentVersion,25);
    const upgraded=await applyMigrations(item.db,{expectedStateFingerprint:before.stateFingerprint,
      migrations:EXECUTABLE_MIGRATIONS,retry:NO_RETRY});
    assert.deepEqual(upgraded.applied.map(entry=>entry.version),[26]);
    assert.equal((await item.db.execute('SELECT COUNT(*) AS c FROM pair_interview_sessions')).rows[0].c,0,
      'no admission or lock state is synthesized for existing rooms');
    assert.equal((await inspectMigrationState(item.db)).schemaExact,true);
    assert.equal(await inspectDatabaseReadiness(item.db),true);
    const foreignKeys=await item.db.execute(`PRAGMA foreign_key_list('pair_interview_sessions')`);
    assert.deepEqual(foreignKeys.rows.map(row=>[String(row.table),String(row.on_delete)]),[['pairing_groups','CASCADE']]);
  }finally{ item.close(); }
});

test('v26 binds rows to the live human auth pair and keeps admission write-once',async()=>{
  const item=fixture();
  try{
    await apply(item.db); await seedPair(item.db);
    await assert.rejects(()=>item.db.execute({sql:insertSql,args:[10,20,1,9,null,null,0,1,1,AT,AT]}),/invalid interview-session pair snapshot/i);
    await assert.rejects(()=>item.db.execute({sql:insertSql,args:[10,20,1,2,null,null,0,2,1,AT,AT]}),/invalid interview-session pair snapshot/i);
    await assert.rejects(()=>item.db.execute({sql:insertSql,args:[10,20,1,2,null,null,0,1,9,AT,AT]}),/constraint/i);
    await assert.rejects(()=>item.db.execute({sql:insertSql,args:[10,20,1,2,'interviewer',null,0,1,1,AT,AT]}),/constraint/i);
    await assert.rejects(()=>item.db.execute({sql:insertSql,args:[10,20,1,2,'candidate',AT,0,1,1,AT,AT]}),/constraint/i);
    await assert.rejects(()=>item.db.execute({sql:insertSql,args:[10,20,1,2,null,null,2,1,1,AT,AT]}),/constraint/i);
    await assert.rejects(()=>item.db.execute({sql:insertSql,args:[10,20,1,2,'schedule','2026-09-20 10:00:00',0,1,1,AT,AT]}),/constraint/i);
    await item.db.execute({sql:insertSql,args:valid});
    await assert.rejects(()=>item.db.execute(`UPDATE pair_interview_sessions SET revision=3,updated_at='${LATER}'`),/invalid interview-session update/i);
    await item.db.execute(`UPDATE pair_interview_sessions SET revision=2,admission='interviewer',admitted_at='${LATER}',updated_by=2,updated_at='${LATER}'`);
    await assert.rejects(()=>item.db.execute(`UPDATE pair_interview_sessions SET revision=3,admission=NULL,admitted_at=NULL,updated_at='${LATER}'`),/invalid interview-session update/i);
    await assert.rejects(()=>item.db.execute(`UPDATE pair_interview_sessions SET revision=3,admission='schedule',updated_at='${LATER}'`),/invalid interview-session update/i);
    await item.db.execute(`UPDATE pair_interview_sessions SET revision=3,editing_locked=1,updated_by=2,updated_at='${LATER}'`);
    assert.deepEqual({...(await item.db.execute('SELECT admission,editing_locked,revision FROM pair_interview_sessions')).rows[0]},
      {admission:'interviewer',editing_locked:1,revision:3});
  }finally{ item.close(); }
});

test('a changed pair leaves only an inert stale snapshot, and deleting the group cascades',async()=>{
  const item=fixture();
  try{
    await apply(item.db); await seedPair(item.db);
    await item.db.execute({sql:insertSql,args:valid});
    // No trigger is added to existing tables, so pair rewrites and participant
    // deletion behave exactly as before v26.
    await item.db.execute('UPDATE pairing_groups SET user_b_id=9 WHERE id=20');
    await assert.rejects(()=>item.db.execute(`UPDATE pair_interview_sessions SET revision=2,editing_locked=1,updated_at='${LATER}'`),
      /invalid interview-session update/i,'a stale snapshot cannot be advanced');
    await item.db.execute('DELETE FROM pairing_participants WHERE week_id=10 AND user_id=2');
    assert.equal((await item.db.execute('SELECT COUNT(*) AS c FROM pair_interview_sessions')).rows[0].c,1);
    await item.db.execute('DELETE FROM pairing_groups WHERE id=20');
    assert.equal((await item.db.execute('SELECT COUNT(*) AS c FROM pair_interview_sessions')).rows[0].c,0);
  }finally{ item.close(); }
});

test('v26 refuses AI and mixed-source pairs at the storage boundary',async()=>{
  for(const shape of [{ai:true},{mixed:true}]){
    const item=fixture();
    try{
      await apply(item.db); await seedPair(item.db,shape);
      const args=shape.ai?[10,20,1,1,null,null,0,1,1,AT,AT]:valid;
      await assert.rejects(()=>item.db.execute({sql:insertSql,args}),/constraint|invalid interview-session pair snapshot/i);
    }finally{ item.close(); }
  }
});
