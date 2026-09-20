import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createClient } from '@libsql/client';

import { EXECUTABLE_MIGRATIONS } from '../../db/executable-migrations.js';
import { applyMigrations, inspectMigrationState, prepareMigrationConnection } from '../../db/migration-runner.js';

const NO_RETRY=Object.freeze({maxAttempts:1,baseDelayMs:0,maxDelayMs:0});
const THROUGH_V16=EXECUTABLE_MIGRATIONS.slice(0,16);
const THROUGH_V17=EXECUTABLE_MIGRATIONS.slice(0,17);
const V17=EXECUTABLE_MIGRATIONS[16];

function fixture(){
  const directory=mkdtempSync(join(tmpdir(),'randori-completion-migration-'));
  const db=createClient({url:`file:${join(directory,'test.sqlite')}`});
  return {db,close(){ db.close(); rmSync(directory,{recursive:true,force:true}); }};
}

async function apply(db,migrations=EXECUTABLE_MIGRATIONS){
  await prepareMigrationConnection(db);
  const before=await inspectMigrationState(db,{migrations});
  return applyMigrations(db,{expectedStateFingerprint:before.stateFingerprint,migrations,retry:NO_RETRY});
}

async function seedPair(db){
  await db.execute(`INSERT INTO auth_accounts (id,email,password_hash,display_name,color,is_demo) VALUES
    (1,'one@example.test','hash','One','#111111',0),
    (2,'two@example.test','hash','Two','#222222',0),
    (3,'three@example.test','hash','Three','#333333',0),
    (9,'outside@example.test','hash','Outside','#999999',0)`);
  await db.execute(`INSERT INTO pairing_weeks (id,week_label,week_start,is_demo)
    VALUES (10,'2026-W38','2026-09-14T07:00:00.000Z',0)`);
  await db.execute(`INSERT INTO pairing_groups
    (id,week_id,user_a_id,user_b_id,user_c_id,is_ai_pair) VALUES (20,10,1,2,3,0)`);
  await db.execute(`INSERT INTO pairing_participants (week_id,user_id,position,source) VALUES
    (10,1,0,'auth'),(10,2,1,'auth'),(10,3,2,'auth'),(10,9,3,'auth')`);
}

test('v17 installs only source-bound participant completion receipts and lookup ownership',async()=>{
  const item=fixture();
  try{
    const result=await apply(item.db,THROUGH_V17);
    assert.equal(result.toVersion,17);
    assert.deepEqual(V17.operations.map(operation=>operation.name),[
      'uq_pairing_groups_completion_pair','uq_pairing_groups_completion_third',
      'uq_pairing_participants_completion_owner',
      'session_completion_receipts','idx_session_completion_receipts_user',
      'trg_session_completion_receipts_insert_guard',
      'trg_session_completion_receipts_update_guard',
      'trg_pairing_groups_completion_membership_guard',
      'trg_pairing_participants_completion_update_guard',
      'trg_pairing_participants_completion_delete_guard',
      'trg_pairing_participants_completion_insert_guard',
    ]);
    const foreignKeys=await item.db.execute(`PRAGMA foreign_key_list('session_completion_receipts')`);
    assert.deepEqual(new Set(foreignKeys.rows.map(row=>String(row.table))),
      new Set(['pairing_groups','pairing_participants','auth_accounts']));
    const table=V17.operations.find(operation=>operation.name==='session_completion_receipts');
    assert.match(table.sql,/PRIMARY KEY\(week_id,pair_group_id,user_id\)/);
    assert.match(table.sql,/participant_source='auth'/);
    assert.match(table.sql,/user_id=pair_user_a_id OR user_id=pair_user_b_id/);
    assert.match(table.sql,/REFERENCES pairing_groups\(id,week_id,user_a_id,user_b_id\)/);
    assert.match(table.sql,/REFERENCES pairing_groups\(id,week_id,user_c_id\)/);
    assert.match(table.sql,/strftime\('%Y-%m-%dT%H:%M:%fZ',confirmed_at\)=confirmed_at/);
  }finally{ item.close(); }
});

test('managed v16 upgrades exactly once to v17 without synthesizing historical completion',async()=>{
  const item=fixture();
  try{
    await apply(item.db,THROUGH_V16);
    await seedPair(item.db);
    const before=await inspectMigrationState(item.db,{migrations:THROUGH_V17});
    assert.equal(before.currentVersion,16);
    const upgraded=await applyMigrations(item.db,{
      expectedStateFingerprint:before.stateFingerprint,migrations:THROUGH_V17,retry:NO_RETRY,
    });
    assert.deepEqual(upgraded.applied.map(entry=>entry.version),[17]);
    assert.equal((await item.db.execute(`SELECT COUNT(*) AS c FROM session_completion_receipts`)).rows[0].c,0);
    assert.equal((await inspectMigrationState(item.db)).schemaExact,true);
  }finally{ item.close(); }
});

test('v17 accepts exact auth participants and rejects forged scope, source, identity, or time',async()=>{
  const item=fixture();
  try{
    await apply(item.db);
    await seedPair(item.db);
    await item.db.execute({sql:`INSERT INTO session_completion_receipts
      (week_id,pair_group_id,user_id,participant_source,
        pair_user_a_id,pair_user_b_id,pair_user_c_id,confirmed_at) VALUES (?,?,?,?,?,?,?,?)`,
      args:[10,20,1,'auth',1,2,3,'2026-09-20T10:00:00.000Z']});
    for(const args of [
      [11,20,2,'auth',1,2,3,'2026-09-20T10:00:00.000Z'],
      [10,999,2,'auth',1,2,3,'2026-09-20T10:00:00.000Z'],
      [10,20,2,'users',1,2,3,'2026-09-20T10:00:00.000Z'],
      [10,20,99,'auth',1,2,3,'2026-09-20T10:00:00.000Z'],
      [10,20,9,'auth',1,2,3,'2026-09-20T10:00:00.000Z'],
      [10,20,2,'auth',1,2,null,'2026-09-20T10:00:00.000Z'],
      [10,20,2,'auth',1,2,9,'2026-09-20T10:00:00.000Z'],
      [10,20,2,'auth',1,2,3,'2026-09-20 10:00:00'],
    ]) await assert.rejects(()=>item.db.execute({sql:`INSERT INTO session_completion_receipts
      (week_id,pair_group_id,user_id,participant_source,
        pair_user_a_id,pair_user_b_id,pair_user_c_id,confirmed_at) VALUES (?,?,?,?,?,?,?,?)`,args}),/constraint/i);
    await assert.rejects(()=>item.db.execute({sql:`INSERT INTO session_completion_receipts
      (week_id,pair_group_id,user_id,participant_source,
        pair_user_a_id,pair_user_b_id,pair_user_c_id,confirmed_at) VALUES (?,?,?,?,?,?,?,?)`,
      args:[10,20,1,'auth',1,2,3,'2026-09-20T10:01:00.000Z']}),/constraint/i);
    await assert.rejects(()=>item.db.execute(`DELETE FROM pairing_participants WHERE week_id=10 AND user_id=1`),/constraint/i);
    await assert.rejects(()=>item.db.execute(`UPDATE session_completion_receipts SET pair_user_c_id=NULL
      WHERE week_id=10 AND pair_group_id=20 AND user_id=1`),/immutable/i);
    await assert.rejects(()=>item.db.execute(`UPDATE pairing_groups SET user_c_id=NULL WHERE id=20`),/immutable/i);
    await assert.rejects(()=>item.db.execute(`UPDATE pairing_groups SET is_ai_pair=1 WHERE id=20`),/immutable/i);
    await assert.rejects(()=>item.db.execute(`UPDATE pairing_participants SET source='users'
      WHERE week_id=10 AND user_id=3`),/immutable/i);
    await assert.rejects(()=>item.db.execute(`DELETE FROM pairing_participants
      WHERE week_id=10 AND user_id=3`),/immutable/i);
    await item.db.execute(`DELETE FROM pairing_groups WHERE id=20`);
    assert.equal((await item.db.execute(`SELECT COUNT(*) AS c FROM session_completion_receipts`)).rows[0].c,0,
      'receipts follow explicit pair deletion while participant deletion is retained');
    await item.db.execute(`DELETE FROM pairing_participants WHERE week_id=10 AND user_id=3`);
    await item.db.execute(`INSERT INTO pairing_groups
      (id,week_id,user_a_id,user_b_id,user_c_id,is_ai_pair) VALUES (21,10,1,2,3,0)`);
    await item.db.execute(`INSERT INTO session_completion_receipts
      (week_id,pair_group_id,user_id,participant_source,
        pair_user_a_id,pair_user_b_id,pair_user_c_id,confirmed_at)
      VALUES (10,21,1,'auth',1,2,3,'2026-09-20T10:02:00.000Z')`);
    await assert.rejects(()=>item.db.execute(`INSERT INTO pairing_participants
      (week_id,user_id,position,source) VALUES (10,3,2,'auth')`),/immutable/i);
  }finally{ item.close(); }
});

test('v17 pins pair shape when the third member is absent and permits explicit demo cleanup',async()=>{
  const item=fixture();
  try{
    await apply(item.db);
    await item.db.execute(`INSERT INTO auth_accounts (id,email,password_hash,display_name,color,is_demo) VALUES
      (1,'one@example.test','hash','One','#111111',1),
      (2,'two@example.test','hash','Two','#222222',1),
      (3,'late@example.test','hash','Late','#333333',1)`);
    await item.db.execute(`INSERT INTO pairing_weeks (id,week_label,week_start,is_demo)
      VALUES (10,'2026-W38-demo','2026-09-14T07:00:00.000Z',1)`);
    await item.db.execute(`INSERT INTO pairing_groups
      (id,week_id,user_a_id,user_b_id,user_c_id,is_ai_pair) VALUES (20,10,1,2,NULL,0)`);
    await item.db.execute(`INSERT INTO pairing_participants (week_id,user_id,position,source) VALUES
      (10,1,0,'auth'),(10,2,1,'auth'),(10,3,2,'auth')`);
    await item.db.execute(`INSERT INTO session_completion_receipts
      (week_id,pair_group_id,user_id,participant_source,
        pair_user_a_id,pair_user_b_id,pair_user_c_id,confirmed_at)
      VALUES (10,20,1,'auth',1,2,NULL,'2026-09-20T10:00:00.000Z')`);
    await assert.rejects(()=>item.db.execute(`UPDATE pairing_groups SET user_c_id=3 WHERE id=20`),/immutable/i);
    await item.db.batch([
      `DELETE FROM session_completion_receipts WHERE week_id IN (SELECT id FROM pairing_weeks WHERE is_demo=1)`,
      `DELETE FROM pairing_participants WHERE week_id IN (SELECT id FROM pairing_weeks WHERE is_demo=1)`,
      `DELETE FROM pairing_groups WHERE week_id IN (SELECT id FROM pairing_weeks WHERE is_demo=1)`,
      `DELETE FROM pairing_weeks WHERE is_demo=1`,
      `DELETE FROM auth_accounts WHERE is_demo=1`,
    ],'write');
    assert.equal((await item.db.execute(`SELECT COUNT(*) AS c FROM session_completion_receipts`)).rows[0].c,0);
    assert.equal((await item.db.execute(`SELECT COUNT(*) AS c FROM auth_accounts`)).rows[0].c,0);
  }finally{ item.close(); }
});
