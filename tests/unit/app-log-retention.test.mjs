// ID-72: app_logs retention against a real migrated SQLite database — bounded,
// idempotent and throttled to once an hour by the database clock — and its
// place in the outbox cron: after delivery, inside its own budget.
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { after, beforeEach, mock, test } from 'node:test';
import { createClient } from '@libsql/client';

import { prepareMigrationConnection } from '../../db/migration-runner.js';
import { createMigratedDatabase } from '../support/migrated-db.mjs';

const { directory, url } = await createMigratedDatabase({ prefix: 'randori-app-log-retention-', filename: 'logs.sqlite' });
const db = createClient({ url });
await prepareMigrationConnection(db);

// `x-test-member: <id>` authenticates a member for POST /api/logs.
function memberFor(req) {
  const id = Number(req?.headers?.['x-test-member']);
  return id ? { id, email: `member${id}@example.test`, sessionHash: 'a'.repeat(64) } : null;
}

mock.module('../../api/_db.js', {
  exports: {
    JWT_AUDIENCE: 'randori-web',
    JWT_ISSUER: 'randori-circle',
    getClient: () => db,
    getJwtSecret: () => 'unit-test-secret-at-least-thirty-two-characters',
    getCronSecret: () => 'cron-secret',
    getAdminEmails: () => new Set(),
    deterministicColor: () => '#123456',
    issueSession: async () => 'session',
    issueSessionInTransaction: async () => 'session',
    revokeAccountSessions: async () => 0,
    revokeRequestSession: async () => ({ authenticated: false, revoked: false, userId: null }),
    isoWeekLabel: () => '2026-W38',
    shuffleArray: values => [...values],
    verifyRequestAuth: memberFor,
    verifySignedRequestAuth: memberFor,
    verifyMutationOrigin: () => true,
    initSentry: () => {},
    isSentryConfigured: () => false,
    getSentry: () => ({ Sentry: null, ready: false }),
    captureSentryMessage: () => null,
    captureSentryException: () => null,
  },
});

const {
  APP_LOG_RETENTION_BATCH_LIMIT,
  APP_LOG_RETENTION_DAYS,
  APP_LOG_RETENTION_EVENT,
  runAppLogRetention,
} = await import('../../api/_app-log-retention.js');
const { deliverPendingOutbox, OUTBOX_APP_LOG_RETENTION_BUDGET_MS } = await import('../../api/ops.js');
const { default: dataHandler } = await import('../../api/data.js');
const { CLIENT_LOG_RECENT_COUNT_SQL } = await import('../../api/_client-log-policy.js');

function postLogs(memberId, body, headers = {}) {
  return new Promise((resolve, reject) => {
    let status = 200;
    const res = {
      status(code) { status = code; return this; },
      json(payload) { resolve({ status, body: payload }); return this; },
      setHeader() {},
      end(payload) { resolve({ status, body: payload }); },
    };
    Promise.resolve(dataHandler({
      method: 'POST', url: '/api/logs', query: { endpoint: 'logs' },
      headers: { ...(memberId ? { 'x-test-member': String(memberId) } : {}), ...headers }, body,
    }, res)).catch(reject);
  });
}

after(() => {
  try { db.close(); } catch {}
  rmSync(directory, { recursive: true, force: true });
});

beforeEach(async () => {
  await db.execute('DELETE FROM app_logs');
});

// Inserts rows with created_at at the given offset from the database clock.
async function seed(rows) {
  for (const { offset, source = 'client', event = 'probe', message = 'row' } of rows) {
    await db.execute({
      sql: `INSERT INTO app_logs (level, source, event, message, created_at) VALUES ('error',?,?,?,datetime('now',?))`,
      args: [source, event, message, offset],
    });
  }
}

async function remaining() {
  return (await db.execute(`SELECT source, event, message FROM app_logs WHERE event<>? ORDER BY id`, [APP_LOG_RETENTION_EVENT]))
    .rows.map(row => `${row.source}:${row.event}:${row.message}`);
}

// Moves the last run marker back so the next call is due.
async function anHourPasses() {
  await db.execute({ sql: `UPDATE app_logs SET created_at=datetime(created_at,'-61 minutes') WHERE event=?`, args: [APP_LOG_RETENTION_EVENT] });
}

test('the policy is 30 days, at most 1000 rows a run', () => {
  assert.equal(APP_LOG_RETENTION_DAYS, 30);
  assert.equal(APP_LOG_RETENTION_BATCH_LIMIT, 1000);
});

test('retention rejects a missing client and limits outside 1-1000', async () => {
  await assert.rejects(runAppLogRetention(null), /database client is required/);
  for (const limit of [0, 1001, 1.5, '5']) {
    await assert.rejects(runAppLogRetention(db, { limit }), /retention limit must be 1-1000/);
  }
  assert.equal(Number((await db.execute('SELECT COUNT(*) AS c FROM app_logs')).rows[0].c), 0, 'nothing is claimed');
});

test('each run deletes at most `limit` rows older than 30 days, oldest first, and keeps everything newer', async () => {
  // 30 days = 43200 minutes; the boundary rows sit one minute either side.
  await seed([
    { offset: '-40 days', message: 'old-1' },
    { offset: '-35 days', message: 'old-2', source: 'runner', event: 'execute_attempt' },
    { offset: '-33 days', message: 'old-3', source: 'server', event: 'outbox_invocation' },
    { offset: '-31 days', message: 'old-4' },
    { offset: '-43201 minutes', message: 'old-5' },
    { offset: '-43199 minutes', message: 'recent-1' },
    { offset: '-29 days', message: 'recent-2' },
    { offset: '-1 day', message: 'recent-3', source: 'server', event: 'outbox_invocation' },
    { offset: '-30 seconds', message: 'lease', source: 'runner', event: 'execute_lease_start' },
    { offset: '+0 seconds', message: 'quota', source: 'runner', event: 'execute_attempt' },
  ]);

  assert.deepEqual({ ...await runAppLogRetention(db, { limit: 3 }) }, { ran: true, purged: 3, more: true });
  assert.deepEqual(await remaining(), [
    'client:probe:old-4', 'client:probe:old-5', 'client:probe:recent-1', 'client:probe:recent-2',
    'server:outbox_invocation:recent-3', 'runner:execute_lease_start:lease', 'runner:execute_attempt:quota',
  ]);

  await anHourPasses();
  assert.deepEqual({ ...await runAppLogRetention(db, { limit: 3 }) }, { ran: true, purged: 2, more: false });
  // recent-1 is a minute inside the window; the runner rows the lease (30 s)
  // and quota (1 min) checks read are untouched.
  assert.deepEqual(await remaining(), [
    'client:probe:recent-1', 'client:probe:recent-2', 'server:outbox_invocation:recent-3',
    'runner:execute_lease_start:lease', 'runner:execute_attempt:quota',
  ]);

  await anHourPasses();
  assert.deepEqual({ ...await runAppLogRetention(db) }, { ran: true, purged: 0, more: false }, 'rerunning is idempotent');
  assert.equal((await remaining()).length, 5);
});

test('a run within the hour, or a concurrent one, does nothing', async () => {
  await seed([{ offset: '-60 days' }, { offset: '-61 days' }]);
  const [first, second] = await Promise.all([runAppLogRetention(db, { limit: 1 }), runAppLogRetention(db, { limit: 1 })]);
  assert.deepEqual([first.ran, second.ran].sort(), [false, true]);
  assert.equal((await remaining()).length, 1);
  assert.deepEqual({ ...await runAppLogRetention(db) }, { ran: false, purged: 0, more: false });
  assert.equal((await remaining()).length, 1);
  const markers = (await db.execute({ sql: `SELECT level, source, message FROM app_logs WHERE event=?`, args: [APP_LOG_RETENTION_EVENT] })).rows;
  assert.deepEqual(markers.map(row => [row.level, row.source, row.message]), [['info', 'server', 'app_logs retention ran']]);
  // 59 minutes later it is still throttled; after 60 it runs.
  await db.execute({ sql: `UPDATE app_logs SET created_at=datetime('now','-59 minutes') WHERE event=?`, args: [APP_LOG_RETENTION_EVENT] });
  assert.equal((await runAppLogRetention(db)).ran, false);
  await db.execute({ sql: `UPDATE app_logs SET created_at=datetime('now','-60 minutes') WHERE event=?`, args: [APP_LOG_RETENTION_EVENT] });
  assert.deepEqual({ ...await runAppLogRetention(db) }, { ran: true, purged: 1, more: false });
});

test('the throttle and the purge use the existing app_logs indexes, so no DDL is needed', async () => {
  const plan = async sql => (await db.execute(`EXPLAIN QUERY PLAN ${sql}`)).rows.map(row => String(row.detail)).join('\n');
  assert.match(await plan(`SELECT id FROM app_logs WHERE created_at<datetime('now','-30 days') ORDER BY created_at LIMIT 1000`), /idx_logs_created/);
  assert.match(await plan(`SELECT 1 FROM app_logs WHERE event='${APP_LOG_RETENTION_EVENT}' AND source='server' AND created_at>datetime('now','-60 minutes')`), /idx_logs_(event|source)_created/);
});

function wrappedDb(intercept) {
  return {
    execute(statement) {
      const sql = typeof statement === 'string' ? statement : statement.sql;
      return intercept(sql) ?? db.execute(statement);
    },
    batch: (...args) => db.batch(...args),
    transaction: (...args) => db.transaction(...args),
  };
}

test('the outbox cron runs retention after delivery and logs the result with the invocation', async () => {
  await seed([{ offset: '-45 days', message: 'expired' }]);
  const first = await deliverPendingOutbox(db, 'https://randori.example.test', { headers: {} }, performance.now() + 10_000);
  assert.deepEqual({ ...first.metrics.app_logs_retention }, { ran: true, purged: 1, more: false });
  assert.equal(first.metrics.deadline_reached, false);
  const logged = (await db.execute(`SELECT meta_json FROM app_logs WHERE event='outbox_invocation'`)).rows;
  assert.deepEqual(JSON.parse(logged[0].meta_json).app_logs_retention, { ran: true, purged: 1, more: false });
  const second = await deliverPendingOutbox(db, 'https://randori.example.test', { headers: {} }, performance.now() + 10_000);
  assert.deepEqual({ ...second.metrics.app_logs_retention }, { ran: false, purged: 0, more: false }, 'throttled for the hour');
});

test('retention is skipped when its budget does not fit, and a slow or failed run never blocks the cron', async () => {
  assert.equal(OUTBOX_APP_LOG_RETENTION_BUDGET_MS, 2_000);
  const tight = await deliverPendingOutbox(db, 'https://randori.example.test', { headers: {} }, performance.now() + 10_000,
    { appLogRetentionBudgetMs: 60_000 });
  assert.equal(tight.metrics.app_logs_retention, null);
  assert.equal(Number((await db.execute({ sql: 'SELECT COUNT(*) AS c FROM app_logs WHERE event=?', args: [APP_LOG_RETENTION_EVENT] })).rows[0].c), 0);

  let release;
  const stalled = new Promise(resolve => { release = resolve; });
  const slow = await deliverPendingOutbox(wrappedDb(sql => (sql.includes('app_logs retention ran') ? stalled.then(() => ({ rows: [] })) : null)),
    'https://randori.example.test', { headers: {} }, performance.now() + 10_000, { appLogRetentionBudgetMs: 50 });
  release();
  assert.deepEqual(slow.metrics.app_logs_retention, { ran: false, timed_out: true });
  assert.equal(slow.metrics.deadline_reached, false);
  assert.equal(slow.metrics.metrics_complete, true);

  const failed = await deliverPendingOutbox(wrappedDb(sql => (sql.includes('app_logs retention ran') ? Promise.reject(new Error('simulated')) : null)),
    'https://randori.example.test', { headers: {} }, performance.now() + 10_000);
  assert.deepEqual(failed.metrics.app_logs_retention, { ran: false, failed: true });
  assert.equal(failed.metrics.metrics_complete, true);
  assert.equal(failed.metrics.logging_complete, true);
});

test('member-written rows can never claim or suppress retention (M1)', async () => {
  await seed([{ offset: '-45 days', message: 'expired' }]);
  // A member posts a forged server row; it is stored as a client row.
  const forged = await postLogs(2, { level: 'warn', source: 'server', event: APP_LOG_RETENTION_EVENT, message: 'forged claim' });
  assert.deepEqual(forged, { status: 200, body: { ok: true, inserted: 1 } });
  const stored = (await db.execute({ sql: 'SELECT source, user_id FROM app_logs WHERE message=?', args: ['forged claim'] })).rows[0];
  assert.deepEqual([stored.source, Number(stored.user_id)], ['client', 2]);
  // Rows a server-side bug or an older build might have written are ignored
  // too: the claim counts only server rows without a user.
  await db.execute({ sql: `INSERT INTO app_logs (level, source, event, message, user_id, created_at) VALUES ('warn','server',?,'legacy',2,datetime('now'))`, args: [APP_LOG_RETENTION_EVENT] });
  await db.execute({ sql: `INSERT INTO app_logs (level, source, event, message, created_at) VALUES ('warn','client',?,'legacy',datetime('now'))`, args: [APP_LOG_RETENTION_EVENT] });
  assert.deepEqual({ ...await runAppLogRetention(db) }, { ran: true, purged: 1, more: false });
  assert.equal((await runAppLogRetention(db)).ran, false, 'the real claim still throttles');
});

test('POST /api/logs refuses oversized bodies before parsing them (C1)', async () => {
  const body = { logs: [{ level: 'error', event: 'probe', message: 'x', meta: { big: 'eyJ-'.repeat(70_000) } }] };
  const declared = await postLogs(2, body, { 'content-length': String(300 * 1024) });
  assert.equal(declared.status, 413);
  assert.equal(declared.body.max_bytes, 256 * 1024);
  const anonymous = await postLogs(0, body, { 'content-length': String(300 * 1024) });
  assert.equal(anonymous.status, 413, 'the size check runs before authentication');
  const undeclared = await postLogs(2, body);
  assert.equal(undeclared.status, 413, 'without content-length the parsed body is measured');
  assert.equal(Number((await db.execute('SELECT COUNT(*) AS c FROM app_logs')).rows[0].c), 0);
});

test('a body just under the limit made of the C1 worst case is handled in milliseconds', async () => {
  // 27 strings of 8000 characters: the shape that took 13 s at 4.48 MB.
  const meta = Object.fromEntries(Array.from({ length: 15 }, (_, k) => [`k${k}`, ['eyJ-'.repeat(2000)]]));
  const body = { logs: Array.from({ length: 12 }, (_, index) => ({ level: 'error', event: 'probe', message: `${'eyJ-'.repeat(2000)} ${index}`, meta: index ? {} : meta })) };
  const size = Buffer.byteLength(JSON.stringify(body));
  assert.ok(size < 256 * 1024 && size > 200 * 1024, `fixture is ${size} bytes`);
  const started = performance.now();
  const result = await postLogs(2, body, { 'content-length': String(size) });
  const elapsed = performance.now() - started;
  assert.equal(result.status, 200);
  assert.equal(result.body.inserted, 12);
  assert.ok(elapsed < 1000, `took ${elapsed.toFixed(0)} ms`);
  const stored = (await db.execute(`SELECT max(length(meta_json)) AS meta, max(length(message)) AS message FROM app_logs`)).rows[0];
  assert.ok(Number(stored.meta) <= 8000 && Number(stored.message) <= 2000);
});

test('each member stores at most 200 client rows an hour, in one batch per request (M2)', async () => {
  await db.execute(`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i<195)
    INSERT INTO app_logs (level, source, event, message, user_id, created_at)
    SELECT 'warn','client','probe','seed '||i,3,datetime('now','-30 minutes') FROM n`);
  // Older rows and other members do not count.
  await seed([{ offset: '-61 minutes', message: 'an hour ago' }]);
  await db.execute(`UPDATE app_logs SET user_id=3 WHERE message='an hour ago'`);
  const batch = { logs: Array.from({ length: 20 }, (_, index) => ({ level: 'warn', event: 'probe', message: `batch ${index}` })) };
  assert.deepEqual(await postLogs(3, batch), { status: 200, body: { ok: true, inserted: 5 } });
  assert.deepEqual(await postLogs(3, batch), { status: 429, body: { error: 'rate limited — too many logs', retry_after: '3600s' } });
  assert.deepEqual(await postLogs(4, batch), { status: 200, body: { ok: true, inserted: 20 } });
  assert.deepEqual(await postLogs(4, { logs: [] }), { status: 200, body: { ok: true, inserted: 0 } });
  const plan = (await db.execute(`EXPLAIN QUERY PLAN ${CLIENT_LOG_RECENT_COUNT_SQL.replace('user_id=?', 'user_id=3').replace('LIMIT ?', 'LIMIT 200')}`))
    .rows.map(row => String(row.detail)).join('\n');
  assert.match(plan, /idx_logs_source_created/);
});

test('a failed batch write stores nothing and reports the log store unavailable', async () => {
  const realBatch = db.batch.bind(db);
  db.batch = async () => { throw new Error('simulated write failure'); };
  try {
    assert.deepEqual(await postLogs(5, { level: 'warn', event: 'probe', message: 'lost' }), { status: 503, body: { error: 'logging unavailable' } });
  } finally {
    db.batch = realBatch;
  }
  assert.equal(Number((await db.execute(`SELECT COUNT(*) AS c FROM app_logs WHERE message='lost'`)).rows[0].c), 0);
});
