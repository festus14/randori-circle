import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createClient } from '@libsql/client';

import { EXECUTABLE_MIGRATIONS } from '../../db/executable-migrations.js';
import { applyMigrations, inspectMigrationState, prepareMigrationConnection } from '../../db/migration-runner.js';

const V20=EXECUTABLE_MIGRATIONS[19];
const NO_RETRY=Object.freeze({maxAttempts:1,baseDelayMs:0,maxDelayMs:0});

function fixture(){
  const directory=mkdtempSync(join(tmpdir(),'randori-code-document-migration-'));
  const db=createClient({url:`file:${join(directory,'test.sqlite')}`});
  return {db,close(){ db.close(); rmSync(directory,{recursive:true,force:true}); }};
}

async function apply(db,migrations=EXECUTABLE_MIGRATIONS){
  await prepareMigrationConnection(db); const before=await inspectMigrationState(db,{migrations});
  return applyMigrations(db,{expectedStateFingerprint:before.stateFingerprint,migrations,retry:NO_RETRY});
}

async function seedPair(db){
  await db.execute(`INSERT INTO auth_accounts (id,email,password_hash,display_name,color) VALUES
    (1,'one@example.test','hash','One','#111111'),(2,'two@example.test','hash','Two','#222222'),
    (3,'three@example.test','hash','Three','#333333')`);
  await db.execute(`INSERT INTO pairing_weeks (id,week_label,week_start) VALUES (10,'2026-W38','2026-09-14')`);
  await db.execute(`INSERT INTO pairing_groups (id,week_id,user_a_id,user_b_id,user_c_id,is_ai_pair)
    VALUES (20,10,1,2,NULL,0)`);
  await db.execute(`INSERT INTO pairing_participants (week_id,user_id,position,source) VALUES
    (10,1,0,'auth'),(10,2,1,'auth')`);
}

const insert=`INSERT INTO pair_code_documents
  (week_id,pair_group_id,question_slug,question_version,language,y_state_base64,state_hash,code_hash,
    revision,pair_user_a_id,pair_user_a_source,pair_user_b_id,pair_user_b_source,pair_user_c_id,
    last_actor_id,last_actor_source,last_client_id,last_client_seq,created_at,updated_at)
  VALUES (10,20,'focus-block-rollup',1,'javascript','AAA=','${'a'.repeat(64)}','${'b'.repeat(64)}',
    1,1,'auth',2,'auth',NULL,1,'auth','client_123',1,'2026-09-20T10:00:00.000Z','2026-09-20T10:00:00.000Z')`;

test('v20 is additive, empty, indexed, guarded, and exact after v19',async()=>{
  const item=fixture();
  try{
    await apply(item.db,EXECUTABLE_MIGRATIONS.slice(0,19)); await seedPair(item.db);
    const before=await inspectMigrationState(item.db); assert.equal(before.currentVersion,19);
    const result=await applyMigrations(item.db,{expectedStateFingerprint:before.stateFingerprint,retry:NO_RETRY});
    assert.deepEqual(result.applied.map(entry=>entry.version),[20]);
    assert.deepEqual(V20.operations.map(operation=>operation.name),[
      'pair_code_documents','idx_pair_code_documents_retention','idx_pair_code_documents_actor',
      'trg_pair_code_documents_insert_guard','trg_pair_code_documents_update_guard',
      'trg_pairing_groups_code_documents_invalidate',
      'trg_pairing_participants_code_documents_update_invalidate',
      'trg_pairing_participants_code_documents_delete_invalidate',
    ]);
    assert.equal((await item.db.execute(`SELECT COUNT(*) AS c FROM pair_code_documents`)).rows[0].c,0);
    assert.equal((await inspectMigrationState(item.db)).schemaExact,true);
  }finally{ item.close(); }
});

test('v20 storage guards exact pair provenance, revisions, and rollback invalidation',async()=>{
  const item=fixture();
  try{
    await apply(item.db); await seedPair(item.db); await item.db.execute(insert);
    await assert.rejects(()=>item.db.execute(`UPDATE pair_code_documents SET revision=3 WHERE week_id=10`),/invalid code-document update/i);
    await item.db.execute(`UPDATE pair_code_documents SET revision=2,last_actor_id=2,last_client_seq=2,
      updated_at='2026-09-20T10:01:00.000Z' WHERE week_id=10 AND pair_group_id=20`);
    await item.db.execute(`UPDATE pairing_groups SET user_b_id=3 WHERE id=20`);
    assert.equal((await item.db.execute(`SELECT COUNT(*) AS c FROM pair_code_documents`)).rows[0].c,0);
    await item.db.execute(`UPDATE pairing_groups SET user_b_id=2 WHERE id=20`); await item.db.execute(insert);
    await item.db.execute(`DELETE FROM pairing_participants WHERE week_id=10 AND user_id=2`);
    assert.equal((await item.db.execute(`SELECT COUNT(*) AS c FROM pair_code_documents`)).rows[0].c,0);
  }finally{ item.close(); }
});

test('v20 insert guard refuses AI, triad, mixed-source, and colliding identities',async()=>{
  for(const mutation of [
    `UPDATE pairing_groups SET is_ai_pair=1,user_b_id=1 WHERE id=20`,
    `UPDATE pairing_groups SET user_c_id=3 WHERE id=20`,
    `UPDATE pairing_participants SET source='users' WHERE week_id=10 AND user_id=2`,
    `UPDATE pairing_groups SET user_b_id=1 WHERE id=20`,
  ]){
    const item=fixture();
    try{
      await apply(item.db); await seedPair(item.db); await item.db.execute(mutation);
      await assert.rejects(()=>item.db.execute(insert),/constraint|invalid code-document pair snapshot/i);
    }finally{ item.close(); }
  }
});
