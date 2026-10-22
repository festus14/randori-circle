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
    verifyRequestAuth: () => null,
    verifySignedRequestAuth: () => null,
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
