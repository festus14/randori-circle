import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { createClient } from '@libsql/client';

import { migrateLegacyPairingEmails } from '../../api/_pairing-email.js';
import { EXECUTABLE_MIGRATIONS } from '../../db/executable-migrations.js';
import {
  applyMigrations,
  inspectMigrationState,
  MigrationError,
  prepareMigrationConnection,
} from '../../db/migration-runner.js';

const NO_RETRY=Object.freeze({maxAttempts:1,baseDelayMs:0,maxDelayMs:0});

function fixture(){
  const directory=mkdtempSync(join(tmpdir(),'randori-outbox-migration-'));
  const db=createClient({url:`file:${join(directory,'database.sqlite')}`});
  return {db,close(){ db.close(); rmSync(directory,{recursive:true,force:true}); }};
}

async function apply(db,migrations){
  await prepareMigrationConnection(db);
  const state=await inspectMigrationState(db,{migrations});
  return applyMigrations(db,{expectedStateFingerprint:state.stateFingerprint,migrations,retry:NO_RETRY});
}

test('v6 installs the generic schema and the compatibility bridge preserves legacy provider keys',async()=>{
  const {db,close}=fixture();
  try{
    await apply(db,EXECUTABLE_MIGRATIONS.slice(0,5));
    await db.batch([
      `INSERT INTO pairing_email_outbox
        (id,week_id,user_id,kind,recipient_email,status,attempt_count,created_at,updated_at)
        VALUES (1,10,7,'paired','seven@example.test','pending',0,'2026-09-20 08:00:00','2026-09-20 08:00:00')`,
      `INSERT INTO pairing_email_outbox
        (id,week_id,user_id,kind,recipient_email,status,attempt_count,claimed_at,created_at,updated_at)
        VALUES (2,10,8,'unavailable','eight@example.test','sending',2,'2026-09-20 08:01:00','2026-09-20 08:00:00','2026-09-20 08:01:00')`,
      `INSERT INTO pairing_email_outbox
        (id,week_id,user_id,kind,recipient_email,status,attempt_count,created_at,updated_at)
        VALUES (3,10,9,'paired','nine@example.test','exhausted',5,'2026-09-20 08:00:00','2026-09-20 08:02:00')`,
      `INSERT INTO pairing_email_outbox
        (id,week_id,user_id,kind,recipient_email,status,attempt_count,sent_at,created_at,updated_at)
        VALUES (4,10,10,'paired','sent@example.test','sent',1,'2026-09-20 08:01:00','2026-09-20 08:00:00','2026-09-20 08:01:00')`,
      `INSERT INTO pairing_email_outbox
        (id,week_id,user_id,kind,recipient_email,status,attempt_count,created_at,updated_at)
        VALUES (5,10,11,'paired','off@example.test','suppressed',1,'2026-09-20 08:00:00','2026-09-20 08:01:00')`,
    ],'write');
    const before=await inspectMigrationState(db);
    assert.equal(before.currentVersion,5);
    const upgraded=await applyMigrations(db,{
      expectedStateFingerprint:before.stateFingerprint,retry:NO_RETRY,
    });
    assert.deepEqual(upgraded.applied.map(item=>item.version),[6]);
    assert.equal(await migrateLegacyPairingEmails(db),3);
    assert.equal(await migrateLegacyPairingEmails(db),0,'the bridge is idempotent');
    const rows=(await db.execute(`SELECT idempotency_key,payload_json,status,attempt_count,last_error_code
      FROM outbox_events ORDER BY id`)).rows;
    assert.deepEqual(rows.map(row=>({
      key:String(row.idempotency_key),payload:JSON.parse(String(row.payload_json)),
      status:String(row.status),attempts:Number(row.attempt_count),error:row.last_error_code,
    })),[
      {key:'randori/10/paired/7',payload:{week_id:10,user_id:7,kind:'paired',recipient_email:'seven@example.test'},status:'pending',attempts:0,error:null},
      {key:'randori/10/unavailable/8',payload:{week_id:10,user_id:8,kind:'unavailable',recipient_email:'eight@example.test'},status:'pending',attempts:2,error:null},
      {key:'randori/10/paired/9',payload:{week_id:10,user_id:9,kind:'paired',recipient_email:'nine@example.test'},status:'dead_letter',attempts:5,error:'LEGACY_ATTEMPTS_EXHAUSTED'},
    ]);
    assert.equal(rows.some(row=>String(row.payload_json).includes('sent@example.test')),false);
    assert.equal(rows.some(row=>String(row.payload_json).includes('off@example.test')),false);
  }finally{ close(); }
});

test('a failed v6 schema change rolls back its tables, indexes, and ledger row',async()=>{
  const {db,close}=fixture();
  try{
    await apply(db,EXECUTABLE_MIGRATIONS.slice(0,5));
    await db.execute(`INSERT INTO pairing_email_outbox
      (week_id,user_id,kind,recipient_email,status,attempt_count)
      VALUES (10,7,'paired','seven@example.test','pending',0)`);
    const before=await inspectMigrationState(db);
    const wrapped={
      execute:statement=>db.execute(statement),
      async transaction(mode){
        const transaction=await db.transaction(mode);
        return {
          execute:async statement=>{
            const result=await transaction.execute(statement);
            const sql=typeof statement==='string'?statement:String(statement.sql||'');
            if(/^CREATE TABLE IF NOT EXISTS outbox_audit_events\b/i.test(sql)){
              throw new Error('forced outbox schema failure');
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
    const objects=await db.execute(`SELECT name FROM sqlite_schema
      WHERE name IN ('outbox_events','outbox_audit_events','idx_outbox_events_dispatch',
        'idx_outbox_events_lease','idx_outbox_audit_event') ORDER BY name`);
    assert.deepEqual(objects.rows,[]);
    const ledger=await db.execute('SELECT version FROM schema_migrations ORDER BY version');
    assert.deepEqual(ledger.rows.map(row=>Number(row.version)),[1,2,3,4,5]);
    assert.equal(Number((await db.execute('SELECT COUNT(*) AS count FROM pairing_email_outbox')).rows[0].count),1);
  }finally{ close(); }
});
