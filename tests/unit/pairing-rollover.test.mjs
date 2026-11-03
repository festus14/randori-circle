import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, test } from 'node:test';

import { createClient } from '@libsql/client';
import jwt from 'jsonwebtoken';

import { availabilityCycleKey } from '../../api/_availability.js';
import {
  publishCirclePairing,
  readCirclePairing,
} from '../../api/_circle-pairing.js';
import {
  getPairingPublication,
  publishPairingCycle,
} from '../../api/_pairing-publication.js';
import { resolvePairingCycle } from '../../api/_pairing-cycle.js';
import dataHandler from '../../api/data.js';
import { prepareMigrationConnection } from '../../db/migration-runner.js';
import { copyMigratedDatabase } from '../support/migrated-db.mjs';

// Rollover contract (bug: "still seeing my last week pair"):
//  - A cycle with no publication yet reads as `unpublished` — the pairing
//    endpoints never fall back to the previous cycle's publication.
//  - Every cycle's publication carries a fresh generation token.
//  - The client revokes the previous cycle's pair state at rollover in
//    every view (covered by tests/e2e/pairing-cycle-ui.spec.ts, which fails
//    on the old dashboard-gated revocation).

const W44 = '2026-10-25T08:00:00.000Z';
const W45_CRON = '2026-11-01T08:00:00.000Z';
const W45_TUE = '2026-11-03T12:00:00.000Z';
const APP_URL = 'https://randori.example.test';
const SCOPE = Object.freeze({ kind: 'circle', scopeKey: 'circle:1', circleId: 1 });
const SESSION_HASH = 'a'.repeat(64);
const cleanup = [];

afterEach(async () => {
  while (cleanup.length) {
    const item = cleanup.pop();
    try { await item(); } catch {}
  }
});

async function createDatabase() {
  const directory = mkdtempSync(join(tmpdir(), 'randori-pairing-rollover-'));
  const path = join(directory, 'pairing.sqlite');
  await copyMigratedDatabase(path);
  const url = `file:${path}`;
  const db = createClient({ url });
  await prepareMigrationConnection(db);
  let closed = false;
  cleanup.push(async () => {
    if (!closed) { closed = true; await db.close(); }
    rmSync(directory, { recursive: true, force: true });
  });
  return { db, url, path };
}

async function seedPrimary(db) {
  await db.execute({ sql: `INSERT INTO circles (id,public_id,slug,name,is_primary,created_by)
    VALUES (1,'circle_test','test-circle','Test Circle',1,1)` });
  for (const [id, role] of [[1, 'owner'], [2, 'member'], [3, 'member'], [4, 'member']]) {
    await db.execute({ sql: `INSERT INTO auth_accounts
        (id,email,password_hash,display_name,color,is_available,is_admin,is_demo)
      VALUES (?,?,?,?,?,?,?,?)`, args: [id, `person-${id}@private.example`, 'unused-password-hash',
      `Person ${id}`, '#123456', 1, role === 'owner' ? 1 : 0, 0] });
    await db.execute({ sql: `INSERT INTO circle_memberships
        (circle_id,user_id,role,status,invited_by) VALUES (1,?,?,?,1)`, args: [id, role, 'active'] });
  }
  await db.execute(`UPDATE circle_membership_rollout SET registrations_closed=1 WHERE id=1`);
  for (const id of [1, 2, 3, 4]) {
    await db.execute({ sql: `INSERT INTO circle_audit_events
        (circle_id,event_type,actor_user_id,subject_user_id,dedupe_key)
      VALUES (1,'membership.backfilled',?,?,?)`, args: [1, id, `membership-backfilled:1:${id}`] });
  }
  await db.execute(`INSERT INTO circle_audit_events
      (circle_id,event_type,actor_user_id,subject_user_id,dedupe_key)
    VALUES (1,'membership.backfill.completed',1,NULL,'primary-membership-backfill:1:v1')`);
}

async function seedSecondary(db, { circleId = 20, userIds = [1, 2, 3], ownerId = 1, contextVersion = 7 } = {}) {
  for (const userId of userIds) {
    await db.execute({ sql: `INSERT INTO auth_accounts (id,email,password_hash,display_name,color,is_demo,is_available)
      VALUES (?,?,?,?,?,?,0)`, args: [userId, `member-${userId}@example.test`, 'hash', `Member ${userId}`,
      userId % 2 ? '#123456' : '#654321', 0] });
  }
  await db.execute({ sql: `INSERT INTO circles (id,public_id,slug,name,is_primary,created_by)
    VALUES (?,?,?,?,0,?)`, args: [circleId, `circle-${circleId}`, `circle-${circleId}`, `Circle ${circleId}`, ownerId] });
  for (const userId of userIds) {
    await db.execute({ sql: `INSERT INTO circle_memberships (circle_id,user_id,role,status)
      VALUES (?,?,?,'active')`, args: [circleId, userId, userId === ownerId ? 'owner' : 'member'] });
  }
  await db.execute({ sql: `INSERT INTO auth_sessions (session_hash,user_id,created_at,expires_at)
    VALUES (?,?,1,4000000000)`, args: [SESSION_HASH, ownerId] });
  await db.execute({ sql: `INSERT INTO auth_session_circle_contexts
      (session_hash,user_id,circle_id,context_version,updated_at) VALUES (?,?,?,?,1)`,
  args: [SESSION_HASH, ownerId, circleId, contextVersion] });
  return { kind: 'session', payload: { id: ownerId, sessionHash: SESSION_HASH }, userId: ownerId,
    circleId, contextVersion, implicit: false, requireOwner: true };
}

function publicationOptions(overrides = {}) {
  return { now: W44, appUrl: APP_URL, localRuntime: false, callerId: 1, authorizedScope: SCOPE, ...overrides };
}

async function generationTokens(db, table, column = 'generation_token') {
  // pairing_week_runs is keyed by week_label, not by an id column.
  const result = await db.execute(`SELECT ${column} FROM ${table} ORDER BY week_label`);
  return (result.rows || []).map((row) => String(row[column]));
}

function invoke(handler, { method = 'GET', url = '/', query = {}, headers = {}, body = {} } = {}) {
  return new Promise((resolve, reject) => {
    let statusCode = 200;
    let settled = false;
    const finish = (payload) => {
      if (settled) return;
      settled = true;
      resolve({ status: statusCode, body: payload });
    };
    const response = {
      status(code) { statusCode = code; return this; },
      json(payload) { finish(payload); return this; },
      setHeader() {},
      getHeader() { return undefined; },
      end(payload) { finish(payload); },
    };
    const request = { method, url, query, headers, body, socket: { remoteAddress: '127.0.0.1' } };
    Promise.resolve(handler(request, response)).then(() => finish(undefined)).catch(reject);
  });
}

test('primary: a new cycle with no publication reads as unpublished, never the previous pair', async () => {
  const { db } = await createDatabase();
  await seedPrimary(db);
  const lastWeek = await publishPairingCycle(db, publicationOptions());
  assert.equal(lastWeek.created, true);
  assert.equal(lastWeek.publication.cycle.cycleId, '2026-W44');

  // The new cycle has no publication yet: the read is empty, not last week's pair.
  assert.equal(await getPairingPublication(db, { now: W45_TUE }), null);

  // The cron run for the new cycle creates a distinct publication with a rotated token.
  const current = await publishPairingCycle(db, publicationOptions({ now: W45_CRON, callerId: null, authorizedScope: null }));
  assert.equal(current.created, true);
  assert.equal(current.publication.cycle.cycleId, '2026-W45');
  assert.notEqual(current.publication.weekId, lastWeek.publication.weekId);
  const tokens = await generationTokens(db, 'pairing_week_runs');
  assert.equal(tokens.length, 2);
  assert.notEqual(tokens[0], tokens[1]);
  assert.ok(tokens.every((token) => /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(token)));

  // The previous cycle's publication is still readable as itself, unchanged.
  assert.deepEqual(await getPairingPublication(db, { now: W44 }), lastWeek.publication);
});

test('primary: the my-pair and weeks endpoints answer unpublished, never a stale pair', async () => {
  const { db, url } = await createDatabase();
  await seedPrimary(db);
  await publishPairingCycle(db, publicationOptions());
  const previousEnv = new Map(['TURSO_DATABASE_URL', 'TURSO_AUTH_TOKEN', 'JWT_SECRET', 'APP_URL',
    'CIRCLE_MEMBERSHIP_ENABLED', 'MULTI_CIRCLE_CONTROL_PLANE_ENABLED'].map((key) => [key, process.env[key]]));
  const sessionId = 'B'.repeat(43);
  const sessionHash = createHash('sha256').update(`randori-session-v1\0${sessionId}`, 'utf8').digest('hex');
  try {
    process.env.TURSO_DATABASE_URL = url;
    process.env.TURSO_AUTH_TOKEN = '';
    process.env.JWT_SECRET = 'test-secret-1234567890abcdef-test-secret-1234567890abcdef';
    process.env.APP_URL = APP_URL;
    delete process.env.CIRCLE_MEMBERSHIP_ENABLED;
    delete process.env.MULTI_CIRCLE_CONTROL_PLANE_ENABLED;
    const nowSeconds = Math.floor(Date.now() / 1000);
    await db.execute({ sql: `INSERT INTO auth_sessions (session_hash,user_id,created_at,expires_at)
      VALUES (?,?,?,?)`, args: [sessionHash, 1, nowSeconds, nowSeconds + 3600] });
    const token = jwt.sign({ id: 1, jti: sessionId }, process.env.JWT_SECRET,
      { algorithm: 'HS256', issuer: 'randori-circle', audience: 'randori-web', expiresIn: '1h' });
    const headers = { authorization: `Bearer ${token}`, origin: APP_URL };
    const myPair = await invoke(dataHandler, { url: '/api/data?endpoint=my-pair', query: { endpoint: 'my-pair' }, headers });
    assert.equal(myPair.status, 200);
    assert.equal(myPair.body.paired, false);
    assert.equal(myPair.body.pairing_status, 'unpublished');
    assert.equal(myPair.body.cycle.cycleId, '2026-W45');
    assert.equal(myPair.body.partner, undefined);
    const weeks = await invoke(dataHandler, { url: '/api/data?endpoint=weeks', query: { endpoint: 'weeks' }, headers });
    assert.equal(weeks.status, 200);
    assert.deepEqual(weeks.body.weeks, []);
    assert.equal(weeks.body.current_cycle.cycleId, '2026-W45');
    assert.equal(weeks.body.current_week_id, null);
  } finally {
    for (const [key, value] of previousEnv) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await db.close();
  }
});

test('secondary: a new cycle with no publication reads as unpublished, and the token rotates', async () => {
  const { db } = await createDatabase();
  const authority = await seedSecondary(db);
  const scope = { kind: 'circle', scopeKey: 'circle:20', circleId: 20 };
  const lastWeek = await publishCirclePairing(db, { authority, now: new Date(W44) });
  assert.equal(lastWeek.created, true);
  assert.equal(lastWeek.publication.cycle.cycleId, '2026-W44');

  // No W45 publication exists: the read for the new cycle is empty.
  const read = await readCirclePairing(db, { authority: { ...authority, requireOwner: false }, now: new Date(W45_TUE) });
  assert.equal(read.publication, null);
  assert.equal(read.cycle.cycleId, '2026-W45');

  const current = await publishCirclePairing(db, { authority: { kind: 'system', circleId: 20 }, now: new Date(W45_CRON) });
  assert.equal(current.created, true);
  assert.equal(current.publication.cycle.cycleId, '2026-W45');
  assert.notEqual(current.publication.id, lastWeek.publication.id);
  assert.notEqual(current.publication.generationToken, lastWeek.publication.generationToken);
  assert.notEqual(
    availabilityCycleKey(scope, resolvePairingCycle({ now: W45_CRON, state: 'current' })),
    availabilityCycleKey(scope, resolvePairingCycle({ now: W44, state: 'current' })),
  );
});
