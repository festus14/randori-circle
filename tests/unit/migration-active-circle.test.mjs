import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createClient } from '@libsql/client';

import { EXECUTABLE_MIGRATIONS } from '../../db/executable-migrations.js';
import {
  MigrationError,
  applyMigrations,
  inspectMigrationState,
  prepareMigrationConnection,
} from '../../db/migration-runner.js';

const NO_RETRY=Object.freeze({maxAttempts:1,baseDelayMs:0,maxDelayMs:0});
const ACTIVE_CIRCLE_MIGRATION=EXECUTABLE_MIGRATIONS[11];
const THROUGH_V11=EXECUTABLE_MIGRATIONS.slice(0,11);
const ACTIVE_CIRCLE_CONTEXT_TABLE_SQL=`CREATE TABLE IF NOT EXISTS auth_session_circle_contexts (session_hash TEXT PRIMARY KEY NOT NULL CHECK(length(session_hash)=64 AND session_hash NOT GLOB '*[^0-9a-f]*'), user_id INTEGER NOT NULL, circle_id INTEGER NOT NULL, context_version INTEGER NOT NULL CHECK(typeof(context_version)='integer' AND context_version>=1), updated_at INTEGER NOT NULL CHECK(typeof(updated_at)='integer' AND updated_at>0), FOREIGN KEY(session_hash,user_id) REFERENCES auth_sessions(session_hash,user_id) ON DELETE CASCADE, FOREIGN KEY(circle_id) REFERENCES circles(id) ON DELETE RESTRICT)`;
const ACTIVE_CIRCLE_CONTEXT_INDEX_SQL=`CREATE INDEX IF NOT EXISTS idx_auth_session_circle_contexts_user_circle ON auth_session_circle_contexts(user_id,circle_id)`;

function temporaryDatabase(){
  const directory=mkdtempSync(join(tmpdir(),'randori-active-circle-migration-'));
  const db=createClient({url:`file:${join(directory,'test.sqlite')}`});
  return {db,close(){ db.close(); rmSync(directory,{recursive:true,force:true}); }};
}

async function apply(db,migrations=EXECUTABLE_MIGRATIONS){
  await prepareMigrationConnection(db);
  const before=await inspectMigrationState(db,{migrations});
  return applyMigrations(db,{expectedStateFingerprint:before.stateFingerprint,migrations,retry:NO_RETRY});
}

async function seedMembership(db,{userId=1,circleId=1,sessionByte='a'}={}){
  await db.execute({
    sql:`INSERT INTO auth_accounts (id,email,password_hash,display_name,color)
      VALUES (?,?,?,?,?)`,
    args:[userId,`user-${userId}@example.test`,'hash','User','#123456'],
  });
  await db.execute({
    sql:`INSERT INTO circles (id,public_id,slug,name,is_primary,created_by)
      VALUES (?,?,?,?,?,?)`,
    args:[circleId,`circle-${circleId}`,`circle-${circleId}`,`Circle ${circleId}`,circleId===1?1:0,userId],
  });
  await db.execute({
    sql:`INSERT INTO circle_memberships (circle_id,user_id,role,status)
      VALUES (?,?,'owner','active')`,
    args:[circleId,userId],
  });
  const sessionHash=sessionByte.repeat(64);
  await db.execute({
    sql:`INSERT INTO auth_sessions (session_hash,user_id,created_at,expires_at)
      VALUES (?,?,100,1000)`,
    args:[sessionHash,userId],
  });
  return sessionHash;
}

test('v12 installs the checksummed session context table and lookup index',async()=>{
  const fixture=temporaryDatabase();
  try{
    const result=await apply(fixture.db,EXECUTABLE_MIGRATIONS.slice(0,12));
    assert.equal(result.toVersion,12);
    assert.deepEqual(ACTIVE_CIRCLE_MIGRATION.operations.map(operation=>operation.name),[
      'uq_auth_sessions_hash_user','auth_session_circle_contexts','idx_auth_session_circle_contexts_user_circle',
    ]);
    assert.equal(ACTIVE_CIRCLE_MIGRATION.operations[1].sql,ACTIVE_CIRCLE_CONTEXT_TABLE_SQL);
    assert.equal(ACTIVE_CIRCLE_MIGRATION.operations[2].sql,ACTIVE_CIRCLE_CONTEXT_INDEX_SQL);
    const sessionIndex=await fixture.db.execute(`PRAGMA index_info("uq_auth_sessions_hash_user")`);
    assert.deepEqual(sessionIndex.rows.map(row=>row.name),['session_hash','user_id']);
    const index=await fixture.db.execute(`PRAGMA index_info("idx_auth_session_circle_contexts_user_circle")`);
    assert.deepEqual(index.rows.map(row=>row.name),['user_id','circle_id']);
  }finally{ fixture.close(); }
});

test('managed v11 upgrades exactly once and repeated v12 apply is a no-op',async()=>{
  const fixture=temporaryDatabase();
  try{
    await apply(fixture.db,THROUGH_V11);
    const before=await inspectMigrationState(fixture.db,{migrations:EXECUTABLE_MIGRATIONS.slice(0,12)});
    assert.equal(before.currentVersion,11);
    const upgraded=await applyMigrations(fixture.db,{
      expectedStateFingerprint:before.stateFingerprint,retry:NO_RETRY,
      migrations:EXECUTABLE_MIGRATIONS.slice(0,12),
    });
    assert.deepEqual(upgraded.applied.map(entry=>entry.version),[12]);
    const current=await inspectMigrationState(fixture.db,{migrations:EXECUTABLE_MIGRATIONS.slice(0,12)});
    const repeated=await applyMigrations(fixture.db,{
      expectedStateFingerprint:current.stateFingerprint,retry:NO_RETRY,
      migrations:EXECUTABLE_MIGRATIONS.slice(0,12),
    });
    assert.deepEqual(repeated.applied,[]);
    assert.equal(repeated.toVersion,12);
  }finally{ fixture.close(); }
});

test('v12 binds session ownership, enforces versions, and preserves generation tombstones',async()=>{
  const fixture=temporaryDatabase();
  try{
    await apply(fixture.db);
    const firstSession=await seedMembership(fixture.db);
    await fixture.db.execute({
      sql:`INSERT INTO auth_session_circle_contexts
        (session_hash,user_id,circle_id,context_version,updated_at) VALUES (?,?,?,1,100)`,
      args:[firstSession,1,1],
    });
    await assert.rejects(
      fixture.db.execute({
        sql:`UPDATE auth_session_circle_contexts SET context_version=0 WHERE session_hash=?`,
        args:[firstSession],
      }),
      /constraint/i,
    );

    await seedMembership(fixture.db,{userId:2,circleId:2,sessionByte:'c'});
    await assert.rejects(
      fixture.db.execute({
        sql:`INSERT INTO auth_session_circle_contexts
          (session_hash,user_id,circle_id,context_version,updated_at) VALUES (?,?,?,1,100)`,
        args:['c'.repeat(64),1,1],
      }),
      /foreign key constraint/i,
    );

    await fixture.db.execute(`DELETE FROM circle_memberships WHERE circle_id=1 AND user_id=1`);
    assert.equal(Number((await fixture.db.execute(
      `SELECT COUNT(*) AS count FROM auth_session_circle_contexts WHERE session_hash='${firstSession}'`,
    )).rows[0].count),1,'membership deletion preserves the monotonic context tombstone');
    await fixture.db.execute(`UPDATE circles SET archived_at=datetime('now') WHERE id=1`);
    await assert.rejects(
      fixture.db.execute(`DELETE FROM circles WHERE id=1`),
      /foreign key constraint/i,
      'an archived circle cannot be physically deleted while its context generation is retained',
    );

    await fixture.db.execute({sql:`DELETE FROM auth_sessions WHERE session_hash=?`,args:[firstSession]});
    assert.equal(Number((await fixture.db.execute(
      `SELECT COUNT(*) AS count FROM auth_session_circle_contexts WHERE session_hash='${firstSession}'`,
    )).rows[0].count),0);
    await fixture.db.execute(`DELETE FROM circles WHERE id=1`);
  }finally{ fixture.close(); }
});

test('a failed v12 index build rolls back its table and ledger row',async()=>{
  const fixture=temporaryDatabase();
  try{
    await apply(fixture.db,THROUGH_V11);
    const before=await inspectMigrationState(fixture.db);
    const wrapped={
      execute:statement=>fixture.db.execute(statement),
      async transaction(mode){
        const transaction=await fixture.db.transaction(mode);
        return {
          async execute(statement){
            const result=await transaction.execute(statement);
            if(String(statement?.sql||statement).includes('idx_auth_session_circle_contexts_user_circle')){
              throw new Error('forced v12 failure');
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
    const artifacts=await fixture.db.execute(`SELECT name FROM sqlite_schema
      WHERE name IN ('auth_session_circle_contexts','idx_auth_session_circle_contexts_user_circle')`);
    assert.deepEqual(artifacts.rows,[]);
    const ledger=await fixture.db.execute(`SELECT MAX(version) AS version FROM schema_migrations`);
    assert.equal(Number(ledger.rows[0].version),11);
  }finally{ fixture.close(); }
});
