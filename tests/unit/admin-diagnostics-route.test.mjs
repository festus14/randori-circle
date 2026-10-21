// GET /api/admin/diagnostics wiring (issue #310): the Vercel rewrite and the
// api/ops.js route reach the admin diagnostics handler with the shared session
// check and database client, and stay a plain 404 while the flag is off.
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, beforeEach, mock, test } from 'node:test';
import { createClient } from '@libsql/client';

import { applyMigrations, inspectMigrationState, prepareMigrationConnection } from '../../db/migration-runner.js';

const directory = mkdtempSync(join(tmpdir(), 'randori-admin-diagnostics-route-'));
const realDb = createClient({ url: `file:${join(directory, 'route.sqlite')}` });
let sessionPayload = null;
let verifyCalls = 0;

mock.module('../../api/_db.js', {
  exports: {
    JWT_AUDIENCE: 'randori-web',
    JWT_ISSUER: 'randori-circle',
    getClient: () => realDb,
    getJwtSecret: () => 'unit-test-secret-at-least-thirty-two-characters',
    getCronSecret: () => 'cron-secret-for-admin-diagnostics-route',
    getAdminEmails: () => new Set(['plain.owner@example.test']),
    deterministicColor: () => '#123456',
    issueSession: async () => 'session',
    issueSessionInTransaction: async () => 'session',
    revokeAccountSessions: async () => 0,
    revokeRequestSession: async () => ({ authenticated: false, revoked: false, userId: null }),
    isoWeekLabel: () => '2026-W43',
    shuffleArray: values => [...values],
    verifyRequestAuth: async () => { verifyCalls += 1; return sessionPayload; },
    verifySignedRequestAuth: () => null,
    verifyMutationOrigin: () => true,
    initSentry: () => {},
    isSentryConfigured: () => false,
    getSentry: () => ({ Sentry: null, ready: false }),
    captureSentryMessage: () => null,
    captureSentryException: () => null,
  },
});

const { default: opsHandler } = await import('../../api/ops.js');

const ENV_KEYS = ['ADMIN_DIAGNOSTICS_ENABLED', 'CIRCLE_MEMBERSHIP_ENABLED', 'MULTI_CIRCLE_CONTROL_PLANE_ENABLED'];
const savedEnv = Object.fromEntries(ENV_KEYS.map(key => [key, process.env[key]]));
const ids = {};

function invoke({ url = '/api/ops?endpoint=admin-diagnostics', query = { endpoint: 'admin-diagnostics' }, method = 'GET' } = {}) {
  return new Promise((resolve, reject) => {
    let statusCode = 200;
    const headers = {};
    const res = {
      status(code) { statusCode = code; return this; },
      json(body) { resolve({ status: statusCode, headers, body }); return this; },
      setHeader(name, value) { headers[String(name).toLowerCase()] = value; },
      getHeader(name) { return headers[String(name).toLowerCase()]; },
      end(body) { resolve({ status: statusCode, headers, body }); },
    };
    Promise.resolve(opsHandler({ method, url, query, headers: {}, body: undefined, socket: { remoteAddress: '203.0.113.9' } }, res)).catch(reject);
  });
}

before(async () => {
  await prepareMigrationConnection(realDb);
  const state = await inspectMigrationState(realDb);
  await applyMigrations(realDb, { expectedStateFingerprint: state.stateFingerprint,
    retry: { maxAttempts: 1, baseDelayMs: 0, maxDelayMs: 0 } });
  const insert = async (email, admin, demo) => Number((await realDb.execute({
    sql: `INSERT INTO auth_accounts (email,password_hash,display_name,color,is_admin,is_demo) VALUES (?,?,?,?,?,?)`,
    args: [email, 'x'.repeat(60), 'Name', '#123456', admin, demo],
  })).lastInsertRowid);
  ids.admin = await insert('global.admin@example.test', 1, 0);
  // Listed in ADMIN_EMAILS but is_admin=0: the legacy env admin is not a global admin here.
  ids.owner = await insert('plain.owner@example.test', 0, 0);
  ids.demo = await insert('demo.admin@example.test', 1, 1);
});

after(() => {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  realDb.close();
  rmSync(directory, { recursive: true, force: true });
});

beforeEach(() => {
  for (const key of ENV_KEYS) delete process.env[key];
  sessionPayload = null;
  verifyCalls = 0;
});

test('vercel.json rewrites the public path to the grouped ops handler', () => {
  const config = JSON.parse(readFileSync(new URL('../../vercel.json', import.meta.url), 'utf8'));
  const rewrite = config.rewrites.find(item => item.source === '/api/admin/diagnostics');
  assert.deepEqual(rewrite, { source: '/api/admin/diagnostics', destination: '/api/ops?endpoint=admin-diagnostics' });
});

test('with the flag off the route is a plain 404 and never checks the session', async () => {
  sessionPayload = { id: ids.admin };
  for (const request of [{}, { url: '/api/admin/diagnostics', query: {} }]) {
    const result = await invoke(request);
    assert.equal(result.status, 404);
    assert.deepEqual(result.body, { ok: false, error: 'not found' });
  }
  assert.equal(verifyCalls, 0);
});

test('with the flag on only a global admin gets the snapshot', async () => {
  process.env.ADMIN_DIAGNOSTICS_ENABLED = 'true';
  assert.equal((await invoke()).status, 401);
  sessionPayload = { id: ids.owner };
  assert.deepEqual((await invoke()).body, { ok: false, error: 'global admin required' });
  sessionPayload = { id: ids.demo };
  assert.equal((await invoke()).status, 403);
  sessionPayload = { id: ids.admin };
  const ok = await invoke({ url: '/api/admin/diagnostics', query: {} });
  assert.equal(ok.status, 200);
  assert.equal(ok.headers['cache-control'], 'no-store');
  assert.equal(ok.body.format, 'randori.admin-diagnostics.v1');
  assert.equal((await invoke({ method: 'DELETE' })).status, 405);
});
