import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {afterEach,test} from 'node:test';
import {createClient} from '@libsql/client';

import {
  AdminInitializationError,
  initializePrimaryCircleData,
} from '../../api/_admin-init.js';
import {EXECUTABLE_MIGRATIONS} from '../../db/executable-migrations.js';
import {
  applyMigrations,
  inspectMigrationState,
  prepareMigrationConnection,
} from '../../db/migration-runner.js';

const NO_RETRY=Object.freeze({maxAttempts:1,baseDelayMs:0,maxDelayMs:0});
const NOW_SECONDS=1_800_000_000;
const SESSION_HASH='a'.repeat(64);
const resources=[];

afterEach(async()=>{
  while(resources.length) await resources.pop()();
});

function sqlText(statement){
  return String(typeof statement==='string'?statement:statement?.sql||'').trim();
}

async function databaseFixture({migrations=EXECUTABLE_MIGRATIONS}={}){
  const directory=mkdtempSync(join(tmpdir(),'randori-admin-init-'));
  resources.push(()=>rmSync(directory,{recursive:true,force:true}));
  const db=createClient({url:`file:${join(directory,'database.sqlite')}`});
  resources.push(()=>db.close());
  await prepareMigrationConnection(db);
  const initial=await inspectMigrationState(db,{migrations});
  await applyMigrations(db,{
    migrations,expectedStateFingerprint:initial.stateFingerprint,retry:NO_RETRY,
  });
  return db;
}

async function seedAccounts(db,{actorAdmin=true,actorDemo=false}={}){
  await db.execute({
    sql:`INSERT INTO auth_accounts
      (id,email,password_hash,display_name,color,is_admin,is_demo)
      VALUES
        (1,'admin@example.test','x','Admin','#111111',?,?),
        (2,'member@example.test','x','Member','#222222',0,0),
        (3,'configured@example.test','x','Configured','#333333',0,0),
        (4,'demo@example.test','x','Demo','#444444',1,1)`,
    args:[actorAdmin?1:0,actorDemo?1:0],
  });
  await db.execute({
    sql:`INSERT INTO auth_sessions (session_hash,user_id,created_at,expires_at)
      VALUES (?,1,?,?)`,
    args:[SESSION_HASH,NOW_SECONDS-60,NOW_SECONDS+3600],
  });
}

async function schemaSnapshot(db){
  const result=await db.execute(`SELECT type,name,tbl_name,sql FROM sqlite_schema
    WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name`);
  return result.rows.map(row=>Object.fromEntries(Object.entries(row)
    .map(([key,value])=>[key,value===null?null:String(value)])));
}

async function initializationSnapshot(db){
  const statements=[
    `SELECT id,public_id,slug,name,is_primary,created_by,created_at,archived_at
      FROM circles ORDER BY id`,
    `SELECT circle_id,user_id,role,status,invited_by,joined_at,updated_at
      FROM circle_memberships ORDER BY circle_id,user_id`,
    `SELECT circle_id,event_type,actor_user_id,subject_user_id,invitation_id,dedupe_key,created_at
      FROM circle_audit_events ORDER BY id`,
    `SELECT id,registrations_closed,updated_at FROM circle_membership_rollout ORDER BY id`,
  ];
  const results=[];
  for(const statement of statements){
    const query=await db.execute(statement);
    results.push(query.rows.map(row=>Object.fromEntries(Object.entries(row)
      .map(([key,value])=>[key,value===null?null:String(value)]))));
  }
  return results;
}

function recordingDatabase(db,{failWhen=()=>false}={}){
  const statements=[];
  return {
    statements,
    async transaction(mode){
      const transaction=await db.transaction(mode);
      return {
        async execute(statement){
          const sql=sqlText(statement);
          statements.push(sql);
          if(failWhen(sql)) throw new Error('injected initialization failure');
          return transaction.execute(statement);
        },
        commit:transaction.commit.bind(transaction),
        rollback:transaction.rollback.bind(transaction),
        close:transaction.close?.bind(transaction),
      };
    },
  };
}

function initializationOptions(overrides={}){
  return {
    actor:{userId:1,sessionHash:SESSION_HASH},
    adminEmails:['configured@example.test'],
    nowSeconds:NOW_SECONDS,
    randomUuid:()=> '11111111-1111-4111-8111-111111111111',
    ...overrides,
  };
}

test('current schema receives one atomic audited data cutover and no runtime DDL',async()=>{
  const db=await databaseFixture();
  await seedAccounts(db);
  const schemaBefore=await schemaSnapshot(db);
  const recorded=recordingDatabase(db);

  const initialized=await initializePrimaryCircleData(recorded,initializationOptions());
  assert.deepEqual(initialized,{ok:true,circleId:1,changed:true});
  assert.equal(recorded.statements.some(sql=>
    /^\s*(?:CREATE|ALTER|DROP|REINDEX|VACUUM)\b/iu.test(sql)),false);
  assert.deepEqual(await schemaSnapshot(db),schemaBefore);

  const memberships=await db.execute(`SELECT user_id,role,status
    FROM circle_memberships ORDER BY user_id`);
  assert.deepEqual(memberships.rows.map(row=>[
    Number(row.user_id),String(row.role),String(row.status),
  ]),[
    [1,'owner','active'],[2,'member','active'],[3,'owner','active'],
  ]);
  const audits=await db.execute(`SELECT event_type,actor_user_id,subject_user_id,dedupe_key
    FROM circle_audit_events ORDER BY id`);
  assert.deepEqual(audits.rows.map(row=>[
    String(row.event_type),Number(row.actor_user_id),
    row.subject_user_id===null?null:Number(row.subject_user_id),String(row.dedupe_key),
  ]),[
    ['membership.backfilled',1,1,'membership-backfilled:1:1'],
    ['membership.backfilled',1,2,'membership-backfilled:1:2'],
    ['membership.backfilled',1,3,'membership-backfilled:1:3'],
    ['membership.backfill.completed',1,null,'primary-membership-backfill:1:v1'],
  ]);
  const rollout=await db.execute(`SELECT registrations_closed FROM circle_membership_rollout WHERE id=1`);
  assert.equal(Number(rollout.rows[0].registrations_closed),1);

  await db.execute(`UPDATE circle_memberships SET status='inactive'
    WHERE circle_id=1 AND user_id=2`);
  const stateBeforeRepeat=await initializationSnapshot(db);
  recorded.statements.length=0;
  const repeated=await initializePrimaryCircleData(recorded,initializationOptions());
  assert.deepEqual(repeated,{ok:true,circleId:1,changed:false});
  assert.deepEqual(await initializationSnapshot(db),stateBeforeRepeat);
  assert.equal(recorded.statements.some(sql=>
    /^\s*(?:INSERT|UPDATE|DELETE|REPLACE|CREATE|ALTER|DROP)\b/iu.test(sql)),false);
});

test('live non-demo administration is rechecked before initialization',async t=>{
  await t.test('non-admin',async()=>{
    const db=await databaseFixture();
    await seedAccounts(db,{actorAdmin:false});
    const result=await initializePrimaryCircleData(db,initializationOptions({adminEmails:[]}));
    assert.deepEqual(result,{ok:false,reason:'admin_required',email:'admin@example.test'});
    assert.equal(Number((await db.execute(`SELECT COUNT(*) AS count FROM circles`)).rows[0].count),0);
  });
  await t.test('demo admin',async()=>{
    const db=await databaseFixture();
    await seedAccounts(db,{actorDemo:true});
    const result=await initializePrimaryCircleData(db,initializationOptions());
    assert.deepEqual(result,{ok:false,reason:'admin_required',email:'admin@example.test'});
    assert.equal(Number((await db.execute(`SELECT COUNT(*) AS count FROM circles`)).rows[0].count),0);
  });
  await t.test('revoked session',async()=>{
    const db=await databaseFixture();
    await seedAccounts(db);
    await db.execute(`UPDATE auth_sessions SET revoked_at=${NOW_SECONDS},revocation_reason='current_logout'`);
    const result=await initializePrimaryCircleData(db,initializationOptions());
    assert.deepEqual(result,{ok:false,reason:'authentication_required'});
    assert.equal(Number((await db.execute(`SELECT COUNT(*) AS count FROM circles`)).rows[0].count),0);
  });
});

test('missing and stale schemas fail closed before any data mutation',async t=>{
  await t.test('missing',async()=>{
    const directory=mkdtempSync(join(tmpdir(),'randori-admin-init-missing-'));
    resources.push(()=>rmSync(directory,{recursive:true,force:true}));
    const db=createClient({url:`file:${join(directory,'missing.sqlite')}`});
    resources.push(()=>db.close());
    const recorded=recordingDatabase(db);
    await assert.rejects(
      initializePrimaryCircleData(recorded,initializationOptions()),
      error=>error instanceof AdminInitializationError&&error.code==='ADMIN_INITIALIZATION_UNAVAILABLE',
    );
    assert.equal(recorded.statements.some(sql=>
      /^\s*(?:INSERT|UPDATE|DELETE|REPLACE|CREATE|ALTER|DROP)\b/iu.test(sql)),false);
  });
  await t.test('stale',async()=>{
    const db=await databaseFixture({migrations:EXECUTABLE_MIGRATIONS.slice(0,15)});
    await seedAccounts(db);
    const recorded=recordingDatabase(db);
    await assert.rejects(
      initializePrimaryCircleData(recorded,initializationOptions()),
      error=>error instanceof AdminInitializationError&&error.code==='ADMIN_INITIALIZATION_UNAVAILABLE',
    );
    assert.equal(recorded.statements.some(sql=>
      /^\s*(?:INSERT|UPDATE|DELETE|REPLACE|CREATE|ALTER|DROP)\b/iu.test(sql)),false);
    assert.equal(Number((await db.execute(`SELECT COUNT(*) AS count FROM circles`)).rows[0].count),0);
  });
  await t.test('drifted',async()=>{
    const db=await databaseFixture();
    await seedAccounts(db);
    await db.execute(`DROP INDEX idx_pair_sched_pair`);
    const recorded=recordingDatabase(db);
    await assert.rejects(
      initializePrimaryCircleData(recorded,initializationOptions()),
      error=>error instanceof AdminInitializationError&&error.code==='ADMIN_INITIALIZATION_UNAVAILABLE',
    );
    assert.equal(recorded.statements.some(sql=>
      /^\s*(?:INSERT|UPDATE|DELETE|REPLACE|CREATE|ALTER|DROP)\b/iu.test(sql)),false);
    assert.equal(Number((await db.execute(`SELECT COUNT(*) AS count FROM circles`)).rows[0].count),0);
  });
});

test('a mid-cutover failure rolls back circle, membership, audit, and latch writes',async()=>{
  const db=await databaseFixture();
  await seedAccounts(db);
  const before=await initializationSnapshot(db);
  const recorded=recordingDatabase(db,{
    failWhen:sql=>sql.includes("'membership.backfill.completed'"),
  });
  await assert.rejects(
    initializePrimaryCircleData(recorded,initializationOptions()),
    error=>error instanceof AdminInitializationError
      &&error.code==='ADMIN_INITIALIZATION_UNAVAILABLE'&&!error.commitStarted,
  );
  assert.deepEqual(await initializationSnapshot(db),before);
});
