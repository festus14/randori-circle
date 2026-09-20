import assert from 'node:assert/strict';
import test from 'node:test';
import { createClient } from '@libsql/client';
import {
  ensureAdminPromotionReadiness,
  ensureDemoResetReadiness,
  ensureDemoSeedReadiness,
  ensureDemoShuffleReadiness,
  ensureNotificationPreferencesReadiness,
} from '../../api/_ops-readiness.js';

const EXPECTED_PROBE='SELECT user_id,email_enabled,sms_enabled,phone,email,updated_at FROM user_notification_prefs LIMIT 0';

function deferred(){
  let resolve,reject;
  const promise=new Promise((onResolve,onReject)=>{
    resolve=onResolve;
    reject=onReject;
  });
  return {promise,resolve,reject};
}

test('notification-preference readiness executes one exact read-only six-column projection',async()=>{
  const statements=[];
  const db={execute:async statement=>{
    statements.push(statement);
    return {rows:[]};
  }};

  assert.equal(await ensureNotificationPreferencesReadiness(db),true);
  assert.deepEqual(statements,[EXPECTED_PROBE]);
  assert.doesNotMatch(statements[0],/\b(?:CREATE|ALTER|DROP|INSERT|UPDATE|DELETE|REPLACE)\b/iu);
});

test('notification-preference readiness coalesces concurrent probes and caches only success per client',async()=>{
  const gate=deferred();
  let firstCalls=0;
  const first={execute:async statement=>{
    firstCalls+=1;
    assert.equal(statement,EXPECTED_PROBE);
    await gate.promise;
    return {rows:[]};
  }};
  let secondCalls=0;
  const second={execute:async statement=>{
    secondCalls+=1;
    assert.equal(statement,EXPECTED_PROBE);
    return {rows:[]};
  }};

  const one=ensureNotificationPreferencesReadiness(first);
  const two=ensureNotificationPreferencesReadiness(first);
  await Promise.resolve();
  assert.equal(firstCalls,1);
  gate.resolve();
  assert.deepEqual(await Promise.all([one,two]),[true,true]);
  assert.equal(await ensureNotificationPreferencesReadiness(first),true);
  assert.equal(firstCalls,1,'a successful probe is cached for the concrete client');

  assert.equal(await ensureNotificationPreferencesReadiness(second),true);
  assert.equal(secondCalls,1,'another client has an independent readiness cache');
});

test('notification-preference readiness evicts a rejected probe so a transient failure can retry',async()=>{
  let calls=0;
  const transient=new Error('temporary database failure');
  const db={execute:async statement=>{
    calls+=1;
    assert.equal(statement,EXPECTED_PROBE);
    if(calls===1) throw transient;
    return {rows:[]};
  }};

  await assert.rejects(ensureNotificationPreferencesReadiness(db),error=>error===transient);
  assert.equal(await ensureNotificationPreferencesReadiness(db),true);
  assert.equal(calls,2);
});

test('notification-preference readiness rejects invalid clients before probing',async()=>{
  await assert.rejects(ensureNotificationPreferencesReadiness(null),/database client is required/);
  await assert.rejects(ensureNotificationPreferencesReadiness({}),/database client is required/);
});

function sqlText(statement){
  return typeof statement==='string'?statement:String(statement?.sql||'');
}

function compact(statement){
  return sqlText(statement).replace(/\s+/g,' ').trim();
}

function operationsMetadata(statement){
  const sql=compact(statement);
  if(sql.includes("pragma_table_info('auth_accounts')")) return {rows:[{name:'id',pk:1}]};
  if(sql.includes("pragma_index_list('auth_accounts')")) return {rows:[{
    index_name:'sqlite_autoindex_auth_accounts_1',is_unique:1,partial:0,seqno:0,column_name:'email',
  }]};
  if(sql.includes("pragma_table_info('pairing_week_runs')")) return {rows:[{name:'week_label',pk:1}]};
  if(sql.includes("pragma_table_info('pairing_participants')")) return {rows:[
    {name:'week_id',pk:1},{name:'user_id',pk:2},
  ]};
  if(sql.includes("pragma_index_list('pairing_weeks')")) return {rows:[{
    index_name:'idx_pairing_weeks_week_label',is_unique:1,partial:0,seqno:0,column_name:'week_label',
  }]};
  return {rows:[]};
}

test('admin operation readiness is exact, read-only, and route scoped',async()=>{
  const statements=[];
  const db={execute:async statement=>{
    statements.push(compact(statement));
    return operationsMetadata(statement);
  }};

  assert.equal(await ensureAdminPromotionReadiness(db),true);
  assert.deepEqual(statements,[
    'SELECT id,email,is_admin FROM auth_accounts LIMIT 0',
  ]);

  statements.length=0;
  assert.equal(await ensureDemoSeedReadiness(db),true);
  assert.deepEqual(statements,[
    'SELECT id,email,password_hash,display_name,color,is_available,is_admin,is_demo FROM auth_accounts LIMIT 0',
    "SELECT name,pk FROM pragma_table_info('auth_accounts') WHERE pk>0 ORDER BY pk",
    `SELECT list.name AS index_name,list."unique" AS is_unique, list.partial,info.seqno,info.name AS column_name FROM pragma_index_list('auth_accounts') AS list JOIN pragma_index_info(list.name) AS info WHERE list."unique"=1 AND list.partial=0 ORDER BY list.seq,info.seqno`,
  ]);

  statements.length=0;
  assert.equal(await ensureDemoResetReadiness(db),true);
  assert.deepEqual(statements,[
    'SELECT id,is_demo FROM auth_accounts LIMIT 0',
    'SELECT id,is_demo FROM pairing_weeks LIMIT 0',
    'SELECT week_id FROM pairing_groups LIMIT 0',
    'SELECT week_id FROM pairing_week_runs LIMIT 0',
    'SELECT week_id FROM pairing_participants LIMIT 0',
  ]);

  statements.length=0;
  assert.equal(await ensureDemoShuffleReadiness(db),true);
  assert.equal(statements.length,10);
  assert.ok(statements.some(statement=>statement.includes('FROM pairing_groups LIMIT 0')));
  assert.ok(statements.some(statement=>statement.includes("pragma_table_info('pairing_week_runs')")));
  assert.ok(statements.some(statement=>statement.includes("name='idx_pairing_weeks_week_label'")));
  for(const statement of statements){
    assert.doesNotMatch(statement,/\b(?:CREATE|ALTER|DROP|INSERT|UPDATE|DELETE|REPLACE)\b/iu);
  }
});

test('admin operation readiness isolates caches by route and client',async()=>{
  let firstCalls=0;
  const first={execute:async statement=>{
    firstCalls+=1;
    return operationsMetadata(statement);
  }};
  let secondCalls=0;
  const second={execute:async statement=>{
    secondCalls+=1;
    return operationsMetadata(statement);
  }};

  await ensureAdminPromotionReadiness(first);
  await ensureAdminPromotionReadiness(first);
  assert.equal(firstCalls,1);
  await ensureDemoResetReadiness(first);
  assert.equal(firstCalls,6,'a different route has an independent contract');
  await ensureAdminPromotionReadiness(second);
  assert.equal(secondCalls,1,'a different client has an independent cache');
});

test('admin operation readiness coalesces work and retries failed contracts',async()=>{
  const gate=deferred();
  let calls=0;
  const concurrent={execute:async()=>{
    calls+=1;
    await gate.promise;
    return {rows:[]};
  }};
  const one=ensureAdminPromotionReadiness(concurrent);
  const two=ensureAdminPromotionReadiness(concurrent);
  await Promise.resolve();
  assert.equal(calls,1);
  gate.resolve();
  assert.deepEqual(await Promise.all([one,two]),[true,true]);

  let attempts=0;
  const retry={execute:async statement=>{
    attempts+=1;
    if(attempts===1) throw new Error('temporary database failure');
    return operationsMetadata(statement);
  }};
  await assert.rejects(ensureDemoResetReadiness(retry),/temporary database failure/);
  assert.equal(await ensureDemoResetReadiness(retry),true);
  assert.equal(attempts,6,'a failed route probe is evicted before retry');
});

test('demo write readiness rejects missing primary and unique conflict targets',async()=>{
  const missingEmailUnique={execute:async statement=>{
    const result=operationsMetadata(statement);
    return compact(statement).includes("pragma_index_list('auth_accounts')")?{rows:[]}:result;
  }};
  await assert.rejects(ensureDemoSeedReadiness(missingEmailUnique),/constraint unavailable/);

  const wrongRunPrimaryKey={execute:async statement=>{
    const result=operationsMetadata(statement);
    return compact(statement).includes("pragma_table_info('pairing_week_runs')")
      ?{rows:[{name:'week_id',pk:1}]}:result;
  }};
  await assert.rejects(ensureDemoShuffleReadiness(wrongRunPrimaryKey),/constraint unavailable/);

  const missingWeekIndex={execute:async statement=>{
    const result=operationsMetadata(statement);
    return compact(statement).includes("pragma_index_list('pairing_weeks')")?{rows:[]}:result;
  }};
  await assert.rejects(ensureDemoShuffleReadiness(missingWeekIndex),/constraint unavailable/);
});

test('all operation readiness contracts accept their canonical SQLite structures',async()=>{
  const db=createClient({url:'file::memory:'});
  try{
    await db.batch([
      `CREATE TABLE auth_accounts (id INTEGER PRIMARY KEY AUTOINCREMENT,email TEXT UNIQUE NOT NULL,password_hash TEXT NOT NULL,display_name TEXT NOT NULL,color TEXT NOT NULL,is_available INTEGER DEFAULT 1,is_admin INTEGER DEFAULT 0,is_demo INTEGER DEFAULT 0)`,
      `CREATE TABLE user_notification_prefs (user_id INTEGER PRIMARY KEY,email_enabled INTEGER DEFAULT 1,sms_enabled INTEGER DEFAULT 0,phone TEXT,email TEXT,updated_at TEXT DEFAULT (datetime('now')))`,
      `CREATE TABLE pairing_weeks (id INTEGER PRIMARY KEY AUTOINCREMENT,week_label TEXT NOT NULL,week_start TEXT NOT NULL,focus TEXT NOT NULL DEFAULT 'both',created_at TEXT DEFAULT (datetime('now')),is_demo INTEGER DEFAULT 0)`,
      `CREATE TABLE pairing_groups (id INTEGER PRIMARY KEY AUTOINCREMENT,week_id INTEGER NOT NULL,user_a_id INTEGER NOT NULL,user_b_id INTEGER NOT NULL,user_c_id INTEGER,is_ai_pair INTEGER DEFAULT 0,topic TEXT,topic_kind TEXT,created_at TEXT DEFAULT (datetime('now')))`,
      `CREATE TABLE pairing_week_runs (week_label TEXT PRIMARY KEY,week_id INTEGER,generation_token TEXT NOT NULL,generation INTEGER NOT NULL DEFAULT 1,algorithm_version TEXT NOT NULL,algorithm_seed TEXT NOT NULL,participant_count INTEGER NOT NULL,participants_json TEXT NOT NULL,created_at TEXT DEFAULT (datetime('now')),updated_at TEXT DEFAULT (datetime('now')))`,
      `CREATE TABLE pairing_participants (week_id INTEGER NOT NULL,user_id INTEGER NOT NULL,position INTEGER NOT NULL,source TEXT NOT NULL DEFAULT 'auth',created_at TEXT DEFAULT (datetime('now')),PRIMARY KEY(week_id,user_id))`,
      `CREATE UNIQUE INDEX idx_pairing_weeks_week_label ON pairing_weeks(week_label)`,
    ],'write');

    assert.equal(await ensureNotificationPreferencesReadiness(db),true);
    assert.equal(await ensureAdminPromotionReadiness(db),true);
    assert.equal(await ensureDemoSeedReadiness(db),true);
    assert.equal(await ensureDemoShuffleReadiness(db),true);
    assert.equal(await ensureDemoResetReadiness(db),true);
  }finally{
    db.close();
  }
});
