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
    'pairing_email_outbox','session_runs','app_logs',
  ]));
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
  assert.equal(statements.length,5);
  assert.equal(await ensureDataWeeksReadiness(db),true);
  assert.equal(statements.length,5,'a successful contract is cached for this client');
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
