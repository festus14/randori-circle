import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createClient } from '@libsql/client';

import { EXECUTABLE_MIGRATIONS } from '../../db/executable-migrations.js';
import { applyMigrations, inspectMigrationState, prepareMigrationConnection } from '../../db/migration-runner.js';

const NO_RETRY=Object.freeze({maxAttempts:1,baseDelayMs:0,maxDelayMs:0});
const THROUGH_V18=EXECUTABLE_MIGRATIONS.slice(0,18);
const V19=EXECUTABLE_MIGRATIONS[18];

function fixture(){
  const directory=mkdtempSync(join(tmpdir(),'randori-session-controls-migration-'));
  const db=createClient({url:`file:${join(directory,'test.sqlite')}`});
  return {db,close(){ db.close(); rmSync(directory,{recursive:true,force:true}); }};
}

async function apply(db,migrations=EXECUTABLE_MIGRATIONS){
  await prepareMigrationConnection(db);
  const before=await inspectMigrationState(db,{migrations});
  return applyMigrations(db,{expectedStateFingerprint:before.stateFingerprint,migrations,retry:NO_RETRY});
}

async function seedPair(db,{triad=false,ai=false,mixed=false}={}){
  await db.execute(`INSERT INTO auth_accounts (id,email,password_hash,display_name,color,is_demo) VALUES
    (1,'one@example.test','hash','One','#111111',0),(2,'two@example.test','hash','Two','#222222',0),
    (3,'three@example.test','hash','Three','#333333',0),(9,'outside@example.test','hash','Outside','#999999',0)`);
  await db.execute(`INSERT INTO users (id,name,color) VALUES (3,'Legacy Three','#333333')`);
  await db.execute(`INSERT INTO pairing_weeks (id,week_label,week_start,is_demo)
    VALUES (10,'2026-W38','2026-09-14T07:00:00.000Z',0)`);
  await db.execute({sql:`INSERT INTO pairing_groups
    (id,week_id,user_a_id,user_b_id,user_c_id,is_ai_pair) VALUES (20,10,1,?,?,?)`,
    args:[ai?1:2,triad?3:null,ai?1:0]});
  await db.execute(`INSERT INTO pairing_participants (week_id,user_id,position,source) VALUES (10,1,0,'auth')`);
  if(!ai) await db.execute({sql:`INSERT INTO pairing_participants (week_id,user_id,position,source) VALUES (10,2,1,?)`,args:[mixed?'users':'auth']});
  if(triad) await db.execute(`INSERT INTO pairing_participants (week_id,user_id,position,source) VALUES (10,3,2,'auth')`);
}

const insertSql=`INSERT INTO pair_session_controls
  (week_id,pair_group_id,pair_user_a_id,pair_user_a_source,pair_user_b_id,pair_user_b_source,
    pair_user_c_id,candidate_user_id,candidate_source,timer_state,remaining_ms,anchor_at,
    revision,updated_by,updated_by_source,created_at,updated_at)
  VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`;

test('v19 installs only the durable pair-session-control aggregate and migration-owned guards',async()=>{
  const item=fixture();
  try{
    const result=await apply(item.db);
    assert.equal(result.toVersion,19);
    assert.deepEqual(V19.operations.map(operation=>operation.name),[
      'pair_session_controls','idx_pair_session_controls_updated_by',
      'trg_pair_session_controls_insert_guard','trg_pair_session_controls_update_guard',
      'trg_pairing_groups_session_controls_invalidate',
      'trg_pairing_participants_session_controls_update_invalidate',
      'trg_pairing_participants_session_controls_delete_invalidate',
    ]);
    const foreignKeys=await item.db.execute(`PRAGMA foreign_key_list('pair_session_controls')`);
    assert.deepEqual(new Set(foreignKeys.rows.map(row=>String(row.table))),
      new Set(['pairing_groups','pairing_participants','auth_accounts']));
    const table=V19.operations.find(operation=>operation.name==='pair_session_controls');
    assert.match(table.sql,/PRIMARY KEY\(week_id,pair_group_id\)/);
    assert.match(table.sql,/pair_user_c_id IS NULL/);
    assert.match(table.sql,/timer_state IN \('paused','running'\)/);
    assert.match(table.sql,/remaining_ms<=1500000/);
    assert.match(table.sql,/updated_by_source='auth'/);
  }finally{ item.close(); }
});

test('managed v18 upgrades once without inventing browser-local timer or role state',async()=>{
  const item=fixture();
  try{
    await apply(item.db,THROUGH_V18); await seedPair(item.db);
    const before=await inspectMigrationState(item.db);
    assert.equal(before.currentVersion,18);
    const upgraded=await applyMigrations(item.db,{
      expectedStateFingerprint:before.stateFingerprint,migrations:EXECUTABLE_MIGRATIONS,retry:NO_RETRY,
    });
    assert.deepEqual(upgraded.applied.map(entry=>entry.version),[19]);
    assert.equal((await item.db.execute(`SELECT COUNT(*) AS c FROM pair_session_controls`)).rows[0].c,0);
    assert.equal((await inspectMigrationState(item.db)).schemaExact,true);
  }finally{ item.close(); }
});

test('v19 enforces the exact auth-source pair snapshot, timer bounds, and monotonic revisions',async()=>{
  const item=fixture();
  try{
    await apply(item.db); await seedPair(item.db);
    const valid=[10,20,1,'auth',2,'auth',null,1,'auth','paused',1500000,null,1,1,'auth',
      '2026-09-20T10:00:00.000Z','2026-09-20T10:00:00.000Z'];
    await item.db.execute({sql:insertSql,args:valid});
    await assert.rejects(()=>item.db.execute(`UPDATE pair_session_controls SET revision=3 WHERE week_id=10 AND pair_group_id=20`),/invalid session-control update/i);
    await assert.rejects(()=>item.db.execute(`UPDATE pair_session_controls SET revision=2,candidate_user_id=9,updated_by=1,updated_at='2026-09-20T10:01:00.000Z' WHERE week_id=10 AND pair_group_id=20`),/constraint/i);
    await assert.rejects(()=>item.db.execute(`UPDATE pair_session_controls SET revision=2,timer_state='running',anchor_at=NULL,updated_by=1,updated_at='2026-09-20T10:01:00.000Z' WHERE week_id=10 AND pair_group_id=20`),/constraint/i);
    await item.db.execute(`UPDATE pair_session_controls SET revision=2,candidate_user_id=2,timer_state='running',remaining_ms=1500000,anchor_at='2026-09-20T10:01:00.000Z',updated_by=2,updated_at='2026-09-20T10:01:00.000Z' WHERE week_id=10 AND pair_group_id=20`);
    assert.equal((await item.db.execute(`SELECT revision,timer_state,candidate_user_id FROM pair_session_controls`)).rows[0].revision,2);
    await item.db.execute(`UPDATE pairing_groups SET user_b_id=9 WHERE id=20`);
    assert.equal((await item.db.execute(`SELECT COUNT(*) AS c FROM pair_session_controls`)).rows[0].c,0,
      'a rolled-back v18 runtime can change the pair without retaining stale v19 controls');
    await item.db.execute(`UPDATE pairing_groups SET user_b_id=2 WHERE id=20`);
    await item.db.execute({sql:insertSql,args:valid});
    await item.db.execute(`DELETE FROM pairing_participants WHERE week_id=10 AND user_id=2`);
    assert.equal((await item.db.execute(`SELECT COUNT(*) AS c FROM pair_session_controls`)).rows[0].c,0,
      'a rolled-back v18 demo reset can delete participants without knowing the v19 table');
    await item.db.execute(`INSERT INTO pairing_participants (week_id,user_id,position,source)
      VALUES (10,2,1,'auth')`);
    await item.db.execute({sql:insertSql,args:valid});
    await item.db.execute(`UPDATE pairing_groups SET is_ai_pair=NULL WHERE id=20`);
    assert.equal((await item.db.execute(`SELECT COUNT(*) AS c FROM pair_session_controls`)).rows[0].c,0,
      'a nullable pair-shape change invalidates controls with NULL-safe comparison');
  }finally{ item.close(); }
});

test('v19 refuses triad, AI, and mixed-source records at the storage boundary',async()=>{
  for(const shape of [{triad:true},{ai:true},{mixed:true}]){
    const item=fixture();
    try{
      await apply(item.db); await seedPair(item.db,shape);
      const values=[10,20,1,'auth',shape.ai?1:2,'auth',shape.triad?3:null,1,'auth','paused',1500000,null,1,1,'auth',
        '2026-09-20T10:00:00.000Z','2026-09-20T10:00:00.000Z'];
      await assert.rejects(()=>item.db.execute({sql:insertSql,args:values}),/constraint|invalid session-control pair snapshot/i);
    }finally{ item.close(); }
  }
});
