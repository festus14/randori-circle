import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createClient } from '@libsql/client';

import { EXECUTABLE_MIGRATIONS } from '../../db/executable-migrations.js';
import { applyMigrations, inspectMigrationState, prepareMigrationConnection } from '../../db/migration-runner.js';

const NO_RETRY=Object.freeze({maxAttempts:1,baseDelayMs:0,maxDelayMs:0});
const THROUGH_V17=EXECUTABLE_MIGRATIONS.slice(0,17);
const V18=EXECUTABLE_MIGRATIONS[17];

function fixture(){
  const directory=mkdtempSync(join(tmpdir(),'randori-meeting-link-migration-'));
  const db=createClient({url:`file:${join(directory,'test.sqlite')}`});
  return {db,close(){ db.close(); rmSync(directory,{recursive:true,force:true}); }};
}

async function apply(db,migrations=EXECUTABLE_MIGRATIONS){
  await prepareMigrationConnection(db);
  const before=await inspectMigrationState(db,{migrations});
  return applyMigrations(db,{expectedStateFingerprint:before.stateFingerprint,migrations,retry:NO_RETRY});
}

async function seedAcceptedPair(db){
  await db.execute(`INSERT INTO auth_accounts (id,email,password_hash,display_name,color,is_demo) VALUES
    (1,'one@example.test','hash','One','#111111',0),(2,'two@example.test','hash','Two','#222222',0),
    (9,'outside@example.test','hash','Outside','#999999',0)`);
  await db.execute(`INSERT INTO pairing_weeks (id,week_label,week_start,is_demo)
    VALUES (10,'2026-W38','2026-09-14T07:00:00.000Z',0)`);
  await db.execute(`INSERT INTO pairing_groups
    (id,week_id,user_a_id,user_b_id,user_c_id,is_ai_pair) VALUES (20,10,1,2,NULL,0)`);
  await db.execute(`INSERT INTO pairing_participants (week_id,user_id,position,source) VALUES
    (10,1,0,'auth'),(10,2,1,'auth'),(10,9,2,'auth')`);
  await db.execute(`INSERT INTO pair_schedules
    (week_id,pair_group_id,proposed_times,agreed_time,created_at,updated_at)
    VALUES (10,20,'[]','2026-09-25T18:00:00.000Z','2026-09-20T10:00:00.000Z','2026-09-20T10:00:00.000Z')`);
}

test('v18 installs the schedule-bound private meeting-link record and guards',async()=>{
  const item=fixture();
  try{
    const result=await apply(item.db);
    assert.equal(result.toVersion,18);
    assert.deepEqual(V18.operations.map(operation=>operation.name),[
      'uq_pair_schedules_meeting_agreement','pair_meeting_links','idx_pair_meeting_links_updated_by',
      'trg_pair_schedules_meeting_link_invalidate',
      'trg_pair_meeting_links_insert_guard','trg_pair_meeting_links_update_guard',
      'trg_pairing_groups_meeting_link_guard','trg_pairing_participants_meeting_link_update_guard',
      'trg_pairing_participants_meeting_link_delete_guard',
    ]);
    const foreignKeys=await item.db.execute(`PRAGMA foreign_key_list('pair_meeting_links')`);
    assert.deepEqual(new Set(foreignKeys.rows.map(row=>String(row.table))),
      new Set(['pair_schedules','pairing_groups','pairing_participants','auth_accounts']));
    const table=V18.operations.find(operation=>operation.name==='pair_meeting_links');
    assert.match(table.sql,/PRIMARY KEY\(week_id,pair_group_id\)/);
    assert.match(table.sql,/accepted_schedule_at.*REFERENCES pair_schedules/s);
    assert.match(table.sql,/length\(CAST\(meeting_url AS BLOB\)\)<=2048/);
    assert.match(table.sql,/updated_by_source='auth'/);
  }finally{ item.close(); }
});

test('managed v17 upgrades once without synthesizing or copying private links',async()=>{
  const item=fixture();
  try{
    await apply(item.db,THROUGH_V17);
    await seedAcceptedPair(item.db);
    const before=await inspectMigrationState(item.db);
    assert.equal(before.currentVersion,17);
    const upgraded=await applyMigrations(item.db,{
      expectedStateFingerprint:before.stateFingerprint,migrations:EXECUTABLE_MIGRATIONS,retry:NO_RETRY,
    });
    assert.deepEqual(upgraded.applied.map(entry=>entry.version),[18]);
    assert.equal((await item.db.execute(`SELECT COUNT(*) AS c FROM pair_meeting_links`)).rows[0].c,0);
    assert.equal((await inspectMigrationState(item.db)).schemaExact,true);
  }finally{ item.close(); }
});

test('v18 binds URL rows to the accepted schedule and exact authenticated pair snapshot',async()=>{
  const item=fixture();
  try{
    await apply(item.db); await seedAcceptedPair(item.db);
    const valid=[10,20,'2026-09-25T18:00:00.000Z','https://meet.example.test/r/opaque',1,1,'auth',1,2,null,'2026-09-20T10:01:00.000Z','2026-09-20T10:01:00.000Z'];
    const sql=`INSERT INTO pair_meeting_links
      (week_id,pair_group_id,accepted_schedule_at,meeting_url,revision,updated_by,updated_by_source,
        pair_user_a_id,pair_user_b_id,pair_user_c_id,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`;
    await item.db.execute({sql,args:valid});
    for(const args of [
      [10,20,'2026-09-25T19:00:00.000Z','https://meet.example.test/x',1,1,'auth',1,2,null,'2026-09-20T10:02:00.000Z','2026-09-20T10:02:00.000Z'],
      [10,20,'2026-09-25T18:00:00.000Z','http://meet.example.test/x',1,1,'auth',1,2,null,'2026-09-20T10:02:00.000Z','2026-09-20T10:02:00.000Z'],
    ]) await assert.rejects(()=>item.db.execute({sql,args}),/constraint/i);
    await assert.rejects(()=>item.db.execute(`UPDATE pair_meeting_links SET revision=3 WHERE week_id=10 AND pair_group_id=20`),/invalid meeting-link update/i);
    await assert.rejects(()=>item.db.execute(`UPDATE pair_meeting_links SET revision=2,updated_by=9,updated_at='2026-09-20T10:02:00.000Z' WHERE week_id=10 AND pair_group_id=20`),/constraint/i);
    await assert.rejects(()=>item.db.execute(`UPDATE pairing_participants SET source='users' WHERE week_id=10 AND user_id=1`),/immutable/i);
    await item.db.execute(`UPDATE pair_schedules SET agreed_time='2026-09-25T19:00:00.000Z' WHERE week_id=10 AND pair_group_id=20`);
    assert.equal((await item.db.execute(`SELECT COUNT(*) AS c FROM pair_meeting_links`)).rows[0].c,0,
      'migration-owned invalidation keeps an older application reschedule compatible');
    await item.db.execute({sql,args:[10,20,'2026-09-25T19:00:00.000Z','https://meet.example.test/replacement',1,2,'auth',1,2,null,'2026-09-20T10:03:00.000Z','2026-09-20T10:03:00.000Z']});
    await item.db.execute(`UPDATE pair_schedules SET agreed_time=NULL WHERE week_id=10 AND pair_group_id=20`);
    assert.equal((await item.db.execute(`SELECT COUNT(*) AS c FROM pair_meeting_links`)).rows[0].c,0,
      'migration-owned invalidation also covers agreement clearing');
  }finally{ item.close(); }
});
