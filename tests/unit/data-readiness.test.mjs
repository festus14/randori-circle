import assert from 'node:assert/strict';
import test from 'node:test';

import {
  ensureDataAdminReadiness,
  ensureDataCircleReadiness,
  ensureDataHistoryReadiness,
  ensureDataLogReadiness,
  ensureDataProfileReadiness,
  ensureDataRunsReadiness,
  ensureDataStatsReadiness,
  ensureDataWeeksReadiness,
  ensureMyPairDataReadiness,
} from '../../api/_data-readiness.js';

const DDL=/^\s*(?:CREATE|ALTER|DROP|VACUUM|REINDEX|PRAGMA\s+writable_schema\b)/iu;
const DML=/^\s*(?:INSERT|UPDATE|DELETE|REPLACE)\b/iu;

function database(execute){ return {execute}; }

async function capturedStatements(guard){
  const statements=[];
  const db=database(async statement=>{
    statements.push(String(statement).replace(/\s+/gu,' ').trim());
    return {rows:[],rowsAffected:0};
  });
  assert.equal(await guard(db),true);
  return statements;
}

test('data readiness profiles use bounded read-only projections',async()=>{
  const statements=[];
  const db=database(async statement=>{
    statements.push(String(statement));
    return {rows:[],rowsAffected:0};
  });

  assert.equal(await ensureDataAdminReadiness(db),true);
  assert.equal(await ensureDataProfileReadiness(db),true);
  assert.equal(await ensureDataCircleReadiness(db),true);
  assert.equal(await ensureDataWeeksReadiness(db),true);
  assert.equal(await ensureDataHistoryReadiness(db),true);
  assert.equal(await ensureDataStatsReadiness(db),true);
  assert.equal(await ensureMyPairDataReadiness(db),true);
  assert.equal(await ensureDataRunsReadiness(db),true);
  assert.equal(await ensureDataLogReadiness(db),true);

  assert.equal(statements.some(sql=>DDL.test(sql)||DML.test(sql)),false);
  assert.deepEqual(new Set(statements.map(sql=>sql.match(/FROM\s+(\w+)\s+LIMIT\s+0/iu)?.[1])),new Set([
    'auth_accounts','users','pairing_weeks','pairing_groups','pairing_participants',
    'pairing_week_runs','pairing_email_outbox','pair_schedules','session_runs','app_logs',
  ]));
  const normalized=statements.map(sql=>sql.replace(/\s+/gu,' ').trim());
  assert.ok(normalized.includes(
    'SELECT week_label,week_id,generation_token,generation,algorithm_version, algorithm_seed,participant_count,participants_json,created_at FROM pairing_week_runs LIMIT 0'
  ));
  assert.ok(normalized.includes(
    'SELECT id,week_id,pair_group_id,proposed_times,agreed_time,updated_at FROM pair_schedules LIMIT 0'
  ));
});

test('weeks and my-pair readiness pin their exact publication and schedule projections',async()=>{
  const publication='SELECT week_label,week_id,generation_token,generation,algorithm_version, algorithm_seed,participant_count,participants_json,created_at FROM pairing_week_runs LIMIT 0';
  const participants='SELECT week_id,user_id,position,source FROM pairing_participants LIMIT 0';
  const schedule='SELECT id,week_id,pair_group_id,proposed_times,agreed_time,updated_at FROM pair_schedules LIMIT 0';

  const weeks=await capturedStatements(ensureDataWeeksReadiness);
  assert.equal(weeks.includes(publication),true);
  assert.equal(weeks.includes(participants),true);
  assert.equal(weeks.includes(schedule),false);
  assert.equal(weeks.some(sql=>sql==='SELECT id,week_label,week_start,focus,is_demo FROM pairing_weeks LIMIT 0'),true);

  const myPair=await capturedStatements(ensureMyPairDataReadiness);
  assert.equal(myPair.includes(publication),true);
  assert.equal(myPair.includes(participants),true);
  assert.equal(myPair.includes(schedule),true);
  assert.equal(myPair.some(sql=>sql==='SELECT id,week_label,week_start,focus,is_demo FROM pairing_weeks LIMIT 0'),true);
});

test('stats readiness includes columns used only by authenticated summaries',async()=>{
  const statements=await capturedStatements(ensureDataStatsReadiness);
  assert.deepEqual(statements,[
    'SELECT id,is_demo FROM auth_accounts LIMIT 0',
    'SELECT id,week_label,week_start,is_demo FROM pairing_weeks LIMIT 0',
    'SELECT id,week_id,user_a_id,user_b_id,user_c_id,is_ai_pair FROM pairing_groups LIMIT 0',
    'SELECT week_id,user_id,source FROM pairing_participants LIMIT 0',
  ]);
});

test('data readiness coalesces by client and contract',async()=>{
  const statements=[];
  let release;
  const gate=new Promise(resolve=>{ release=resolve; });
  const db=database(async statement=>{
    statements.push(String(statement));
    if(statements.length===1) await gate;
    return {rows:[],rowsAffected:0};
  });

  const first=ensureDataWeeksReadiness(db);
  const second=ensureDataWeeksReadiness(db);
  await Promise.resolve();
  assert.equal(statements.length,1);
  release();
  assert.deepEqual(await Promise.all([first,second]),[true,true]);
  assert.equal(statements.length,6);
  assert.equal(await ensureDataWeeksReadiness(db),true);
  assert.equal(statements.length,6,'a successful contract is cached for this client');
});

test('data readiness rejects invalid clients and retries failed probes without writes',async()=>{
  await assert.rejects(ensureDataProfileReadiness(null),/database client is required/);
  await assert.rejects(ensureDataProfileReadiness({}),/database client is required/);

  const statements=[];
  let failures=1;
  const db=database(async statement=>{
    const sql=String(statement);
    statements.push(sql);
    if(failures-->0) throw new Error('profile schema unavailable');
    return {rows:[],rowsAffected:0};
  });
  await assert.rejects(ensureDataProfileReadiness(db),/profile schema unavailable/);
  assert.equal(await ensureDataProfileReadiness(db),true);
  assert.equal(statements.length,2,'a rejected readiness promise is evicted');
  assert.equal(statements.some(sql=>DDL.test(sql)||DML.test(sql)),false);
});
