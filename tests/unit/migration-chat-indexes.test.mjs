import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createClient } from '@libsql/client';

import {
  MAX_MESSAGES_PER_ROOM,
  messageInsertStatement,
  messageLimitStateStatement,
  messageReadStatement,
} from '../../api/_messages.js';
import { AUTH_PAIR_ACCESS_SQL, authPairAccessArgs } from '../../api/_pair-access.js';
import { EXECUTABLE_MIGRATIONS } from '../../db/executable-migrations.js';
import {
  MigrationError,
  adoptMigrations,
  applyMigrations,
  inspectMigrationState,
  prepareMigrationConnection,
} from '../../db/migration-runner.js';

const NO_RETRY=Object.freeze({maxAttempts:1,baseDelayMs:0,maxDelayMs:0});
const CHAT_MIGRATION=EXECUTABLE_MIGRATIONS[9];
const ROOM_CURSOR_INDEX='idx_pair_messages_room_cursor';
const SENDER_CREATED_INDEX='idx_pair_messages_sender_created';

function temporaryDatabase(){
  const directory=mkdtempSync(join(tmpdir(),'randori-chat-indexes-'));
  const db=createClient({url:`file:${join(directory,'test.sqlite')}`});
  return {db,close(){ db.close(); rmSync(directory,{recursive:true,force:true}); }};
}

async function apply(db,migrations=EXECUTABLE_MIGRATIONS){
  await prepareMigrationConnection(db);
  const before=await inspectMigrationState(db,{migrations});
  return applyMigrations(db,{
    expectedStateFingerprint:before.stateFingerprint,
    migrations,
    retry:NO_RETRY,
  });
}

async function installUnmanagedSchema(db){
  await prepareMigrationConnection(db);
  for(const migration of EXECUTABLE_MIGRATIONS){
    for(const operation of migration.operations) await db.execute(operation.sql);
  }
}

async function indexColumns(db,name){
  const result=await db.execute(`PRAGMA index_info(\"${name}\")`);
  return result.rows.map(row=>String(row.name));
}

async function explain(db,statement,args=[]){
  const sql=typeof statement==='string'?statement:statement.sql;
  const parameters=typeof statement==='string'?args:statement.args;
  const result=await db.execute({sql:`EXPLAIN QUERY PLAN ${sql}`,args:parameters});
  return result.rows.map(row=>String(row.detail));
}

function assertUsesIndex(details,name){
  assert.ok(details.some(detail=>detail.includes(name)),details.join('\n'));
  assert.equal(
    details.some(detail=>/^SCAN pair_messages(?:\s|$)/.test(detail)),
    false,
    details.join('\n'),
  );
}

test('v10 installs canonical chat indexes and representative reads select them',async()=>{
  const fixture=temporaryDatabase();
  const {db}=fixture;
  try{
    const result=await apply(db);
    assert.equal(MAX_MESSAGES_PER_ROOM,10_000);
    assert.equal(result.toVersion,10);
    assert.equal(result.applied.at(-1).version,10);
    assert.deepEqual(CHAT_MIGRATION.operations.map(operation=>operation.name),[
      ROOM_CURSOR_INDEX,SENDER_CREATED_INDEX,
    ]);
    assert.deepEqual(await indexColumns(db,ROOM_CURSOR_INDEX),['week_id','pair_group_id','id']);
    assert.deepEqual(await indexColumns(db,SENDER_CREATED_INDEX),['sender_id','created_at']);

    await db.execute(`WITH RECURSIVE seq(n) AS (
      SELECT 1 UNION ALL SELECT n+1 FROM seq WHERE n<500
    ) INSERT INTO pair_messages (week_id,pair_group_id,sender_id,message,created_at)
      SELECT CASE WHEN n<=400 THEN 10 ELSE 11 END,
        CASE WHEN n<=400 THEN 20 ELSE 21 END,
        (n%8)+1,'message-'||n,
        strftime('%Y-%m-%dT%H:%M:%fZ','now','-'||(n%120)||' seconds')
      FROM seq`);

    const accessArgs=authPairAccessArgs({userId:2,weekId:10,pairGroupId:20});
    const statementOptions={
      accessSql:AUTH_PAIR_ACCESS_SQL,accessArgs,weekId:10,pairGroupId:20,
    };
    const newest=await explain(db,messageReadStatement({
      ...statementOptions,afterId:0,limit:50,
    }));
    assertUsesIndex(newest,ROOM_CURSOR_INDEX);

    const afterId=await explain(db,messageReadStatement({
      ...statementOptions,afterId:200,limit:50,
    }));
    assertUsesIndex(afterId,ROOM_CURSOR_INDEX);

    const insertLimits=await explain(db,messageInsertStatement({
      ...statementOptions,userId:2,message:'new message',
    }));
    assertUsesIndex(insertLimits,ROOM_CURSOR_INDEX);
    assertUsesIndex(insertLimits,SENDER_CREATED_INDEX);
    assert.ok(insertLimits.filter(detail=>detail.includes('COVERING INDEX')).length>=2,
      insertLimits.join('\n'));

    const diagnosticLimits=await explain(db,messageLimitStateStatement({
      ...statementOptions,userId:2,
    }));
    assertUsesIndex(diagnosticLimits,ROOM_CURSOR_INDEX);
    assertUsesIndex(diagnosticLimits,SENDER_CREATED_INDEX);
  }finally{ fixture.close(); }
});

test('managed v9 upgrades once and repeated v10 apply is a no-op',async()=>{
  const fixture=temporaryDatabase();
  const {db}=fixture;
  const throughV9=EXECUTABLE_MIGRATIONS.slice(0,9);
  try{
    await apply(db,throughV9);
    const before=await inspectMigrationState(db);
    assert.equal(before.classification,'managed');
    assert.equal(before.currentVersion,9);
    assert.equal(before.ready,true);

    const upgraded=await applyMigrations(db,{
      expectedStateFingerprint:before.stateFingerprint,
      retry:NO_RETRY,
    });
    assert.deepEqual(upgraded.applied.map(item=>item.version),[10]);
    const current=await inspectMigrationState(db);
    const repeated=await applyMigrations(db,{
      expectedStateFingerprint:current.stateFingerprint,
      retry:NO_RETRY,
    });
    assert.deepEqual(repeated.applied,[]);
    assert.equal(repeated.fromVersion,10);
    assert.equal(repeated.toVersion,10);
  }finally{ fixture.close(); }
});

test('v10 drift fails closed and reports the missing managed index',async()=>{
  const fixture=temporaryDatabase();
  const {db}=fixture;
  try{
    await apply(db);
    await db.execute(`DROP INDEX ${ROOM_CURSOR_INDEX}`);
    const drifted=await inspectMigrationState(db);
    assert.equal(drifted.classification,'managed');
    assert.equal(drifted.currentVersion,10);
    assert.equal(drifted.schemaExact,false);
    assert.equal(drifted.ready,false);
    assert.ok(drifted.schemaStatus.blockers.some(blocker=>
      blocker.code==='missing_index'&&blocker.artifact?.name===ROOM_CURSOR_INDEX));
    await assert.rejects(
      applyMigrations(db,{expectedStateFingerprint:drifted.stateFingerprint,retry:NO_RETRY}),
      error=>error instanceof MigrationError&&error.code==='MIGRATION_SCHEMA_INVALID',
    );
  }finally{ fixture.close(); }
});

test('a failed v10 index build rolls back both indexes and its ledger row',async()=>{
  const fixture=temporaryDatabase();
  const {db}=fixture;
  try{
    await apply(db,EXECUTABLE_MIGRATIONS.slice(0,9));
    const before=await inspectMigrationState(db);
    const wrapped={
      execute:statement=>db.execute(statement),
      async transaction(mode){
        const transaction=await db.transaction(mode);
        return {
          execute:async statement=>{
            const result=await transaction.execute(statement);
            if(String(statement?.sql||statement).includes(SENDER_CREATED_INDEX)){
              throw new Error('forced chat index failure');
            }
            return result;
          },
          commit:()=>transaction.commit(),
          rollback:()=>transaction.rollback(),
          close:()=>transaction.close(),
        };
      },
    };
    await assert.rejects(
      applyMigrations(wrapped,{expectedStateFingerprint:before.stateFingerprint,retry:NO_RETRY}),
      error=>error instanceof MigrationError&&error.code==='MIGRATION_FAILED',
    );
    const indexes=await db.execute({
      sql:`SELECT name FROM sqlite_schema WHERE type='index' AND name IN (?,?) ORDER BY name`,
      args:[ROOM_CURSOR_INDEX,SENDER_CREATED_INDEX],
    });
    assert.deepEqual(indexes.rows,[]);
    const ledger=await db.execute('SELECT version FROM schema_migrations ORDER BY version');
    assert.deepEqual(ledger.rows.map(row=>Number(row.version)),[1,2,3,4,5,6,7,8,9]);
  }finally{ fixture.close(); }
});

test('exact unmanaged v10 schema can be adopted without rewriting application data',async()=>{
  const fixture=temporaryDatabase();
  const {db}=fixture;
  try{
    await installUnmanagedSchema(db);
    await db.execute(`INSERT INTO pair_messages
      (id,week_id,pair_group_id,sender_id,message,created_at)
      VALUES (1,10,20,2,'preserved','2026-09-19T03:17:00.000Z')`);
    const before=await inspectMigrationState(db);
    assert.equal(before.classification,'unmanaged');
    assert.equal(before.schemaExact,true);
    assert.equal(before.adoption.eligible,true);
    const adopted=await adoptMigrations(db,{
      expectedStateFingerprint:before.stateFingerprint,
      retry:NO_RETRY,
    });
    assert.equal(adopted.toVersion,10);
    const rows=await db.execute('SELECT id,message FROM pair_messages');
    assert.deepEqual(rows.rows.map(row=>[Number(row.id),row.message]),[[1,'preserved']]);
  }finally{ fixture.close(); }
});

test('index-only emergency removal preserves data and explicit recreation restores readiness',async()=>{
  const fixture=temporaryDatabase();
  const {db}=fixture;
  try{
    await apply(db);
    await db.execute(`INSERT INTO pair_messages
      (week_id,pair_group_id,sender_id,message,created_at)
      VALUES (10,20,2,'preserved','2026-09-19T03:17:00.000Z')`);
    await db.execute(`DROP INDEX ${ROOM_CURSOR_INDEX}`);
    await db.execute(`DROP INDEX ${SENDER_CREATED_INDEX}`);
    const count=await db.execute(`SELECT COUNT(*) AS count FROM pair_messages
      WHERE week_id=10 AND pair_group_id=20`);
    assert.equal(Number(count.rows[0].count),1);
    assert.equal((await inspectMigrationState(db)).ready,false);

    for(const operation of CHAT_MIGRATION.operations) await db.execute(operation.sql);
    const recovered=await inspectMigrationState(db);
    assert.equal(recovered.currentVersion,10);
    assert.equal(recovered.schemaExact,true);
    assert.equal(recovered.ready,true);
  }finally{ fixture.close(); }
});

test('ordinary API modules contain no pair-message index DDL',()=>{
  const source=readFileSync(new URL('../../api/data.js',import.meta.url),'utf8');
  assert.doesNotMatch(source,/CREATE\s+(?:UNIQUE\s+)?INDEX[^`'\"]*pair_messages/i);
});
