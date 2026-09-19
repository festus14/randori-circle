import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createClient } from '@libsql/client';

import { EXECUTABLE_MIGRATIONS } from '../../db/executable-migrations.js';
import { applyMigrations, inspectMigrationState, prepareMigrationConnection } from '../../db/migration-runner.js';

const NO_RETRY=Object.freeze({maxAttempts:1,baseDelayMs:0,maxDelayMs:0});
const THROUGH_V13=EXECUTABLE_MIGRATIONS.slice(0,13);
const THROUGH_V14=EXECUTABLE_MIGRATIONS.slice(0,14);
const V14=EXECUTABLE_MIGRATIONS[13];

function fixture(){
  const directory=mkdtempSync(join(tmpdir(),'randori-circle-create-migration-'));
  const db=createClient({url:`file:${join(directory,'test.sqlite')}`});
  return {db,close(){ db.close(); rmSync(directory,{recursive:true,force:true}); }};
}

async function apply(db,migrations=EXECUTABLE_MIGRATIONS){
  await prepareMigrationConnection(db);
  const before=await inspectMigrationState(db,{migrations});
  return applyMigrations(db,{expectedStateFingerprint:before.stateFingerprint,migrations,retry:NO_RETRY});
}

test('v14 adds only the durable circle creation receipt and lookup index',async()=>{
  const item=fixture();
  try{
    const result=await apply(item.db,THROUGH_V14);
    assert.equal(result.toVersion,14);
    assert.deepEqual(V14.operations.map(operation=>operation.name),[
      'uq_circle_audit_events_id_circle','circle_creation_requests','idx_circle_creation_requests_circle',
    ]);
    const columns=await item.db.execute(`PRAGMA table_info('circle_creation_requests')`);
    assert.deepEqual(columns.rows.map(row=>String(row.name)),[
      'actor_user_id','request_hash','request_fingerprint','initiating_session_hash',
      'circle_id','audit_event_id','context_version','created_at',
    ]);
    const foreignKeys=await item.db.execute(`PRAGMA foreign_key_list('circle_creation_requests')`);
    assert.deepEqual(new Set(foreignKeys.rows.map(row=>String(row.table))),
      new Set(['auth_accounts','circles','circle_memberships','circle_audit_events']));
  }finally{ item.close(); }
});

test('managed v13 upgrades once and preserves a complete receipt',async()=>{
  const item=fixture();
  try{
    await apply(item.db,THROUGH_V13);
    const before=await inspectMigrationState(item.db,{migrations:THROUGH_V14});
    assert.equal(before.currentVersion,13);
    const upgraded=await applyMigrations(item.db,{
      expectedStateFingerprint:before.stateFingerprint,migrations:THROUGH_V14,retry:NO_RETRY,
    });
    assert.deepEqual(upgraded.applied.map(entry=>entry.version),[14]);
    assert.equal((await inspectMigrationState(item.db,{migrations:THROUGH_V14})).schemaExact,true);
  }finally{ item.close(); }
});

test('v14 receipt keys isolate actors and enforce one result chain',async()=>{
  const item=fixture();
  try{
    await apply(item.db,THROUGH_V14);
    await item.db.execute(`INSERT INTO auth_accounts
      (id,email,password_hash,display_name,color) VALUES
      (1,'one@example.test','hash','One','#111111'),(2,'two@example.test','hash','Two','#222222')`);
    await item.db.execute(`INSERT INTO circles
      (id,public_id,slug,name,is_primary,created_by) VALUES
      (10,'circle-ten','ten','Ten',0,1),(20,'circle-twenty','twenty','Twenty',0,2)`);
    await item.db.execute(`INSERT INTO circle_memberships (circle_id,user_id,role,status) VALUES
      (10,1,'owner','active'),(20,2,'owner','active')`);
    await item.db.execute(`INSERT INTO circle_audit_events
      (id,circle_id,event_type,actor_user_id,subject_user_id,dedupe_key) VALUES
      (100,10,'circle.created',1,1,'dedupe-one'),(200,20,'circle.created',2,2,'dedupe-two')`);
    const requestHash='a'.repeat(64), fingerprint='b'.repeat(64);
    await item.db.execute({sql:`INSERT INTO circle_creation_requests
      (actor_user_id,request_hash,request_fingerprint,initiating_session_hash,
       circle_id,audit_event_id,context_version) VALUES (?,?,?,?,?,?,?)`,
    args:[1,requestHash,fingerprint,'c'.repeat(64),10,100,1]});
    await item.db.execute({sql:`INSERT INTO circle_creation_requests
      (actor_user_id,request_hash,request_fingerprint,initiating_session_hash,
       circle_id,audit_event_id,context_version) VALUES (?,?,?,?,?,?,?)`,
    args:[2,requestHash,fingerprint,'d'.repeat(64),20,200,1]});
    await assert.rejects(()=>item.db.execute({sql:`INSERT INTO circle_creation_requests
      (actor_user_id,request_hash,request_fingerprint,initiating_session_hash,
       circle_id,audit_event_id,context_version) VALUES (?,?,?,?,?,?,?)`,
    args:[1,'e'.repeat(64),fingerprint,'c'.repeat(64),10,200,2]}),/constraint/i);
  }finally{ item.close(); }
});
