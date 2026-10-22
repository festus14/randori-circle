// Admin diagnostics (issue #310): global-admin authorization, the aggregate
// snapshot built from a real, fully migrated SQLite database, each card's
// stale-data state, data minimisation and the request handler contract.
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, beforeEach, test } from 'node:test';
import { createClient } from '@libsql/client';
import { parse as parseYaml } from 'yaml';

import { applyMigrations, inspectMigrationState, prepareMigrationConnection } from '../../db/migration-runner.js';
import { LATEST_MIGRATION_VERSION, MIGRATION_CONTRACTS } from '../../db/migration-contract.js';
import { replayDeadLetter } from '../../api/_outbox.js';
import {
  ADMIN_DIAGNOSTICS_FORMAT,
  BACKUP_WATCHDOG_CADENCE_MS,
  DEAD_LETTER_LIST_LIMIT,
  DIAGNOSTICS_SNAPSHOT_MAX_AGE_MS,
  ERROR_CATEGORY_LIMIT,
  EXECUTION_EVIDENCE_MAX_AGE_MS,
  EXECUTION_SMOKE_MAX_AGE_MS,
  EXECUTION_SMOKE_REPORT_LOOKBACK,
  LOG_EVIDENCE_MAX_AGE_MS,
  OUTBOX_DELIVERY_MAX_AGE_MS,
  OUTBOX_DISPATCH_EVIDENCE_MAX_AGE_MS,
  OUTBOX_REPLAY_REASON_CODES,
  OUTBOX_WATCHDOG_CADENCE_MS,
  WATCHDOG_CARDS,
  adminDiagnosticsEnabled,
  authorizeGlobalAdmin,
  evidence,
  executionCardWithSmoke,
  executionConfiguration,
  executionSmokeSummary,
  handleAdminDiagnosticsRequest,
  outboxCardStatus,
  parseDiagnosticsInstant,
  readAdminDiagnostics,
  readMigrationLedgerSummary,
  safeEventName,
  safeLogSource,
  summarizeErrorRows,
} from '../../api/_admin-diagnostics.js';
import { APP_LOG_RETENTION_DAYS } from '../../api/_app-log-retention.js';
import { EXECUTION_SMOKE_RESULT_GRACE_SECONDS } from '../../api/_execution-smoke.js';

const ROOT = new URL('../../', import.meta.url);
const directory = realpathSync(mkdtempSync(join(tmpdir(), 'randori-admin-diagnostics-')));
const db = createClient({ url: `file:${join(directory, 'diagnostics.sqlite')}` });
const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const MEMBERSHIP_ENV = Object.freeze({ CIRCLE_MEMBERSHIP_ENABLED: 'true' });
const ready = async () => ({ ready: true, reason: null });

const ids = {};
let sequence = 0;

before(async () => {
  await prepareMigrationConnection(db);
  const state = await inspectMigrationState(db);
  await applyMigrations(db, { expectedStateFingerprint: state.stateFingerprint,
    retry: { maxAttempts: 1, baseDelayMs: 0, maxDelayMs: 0 } });
  const account = async (email, { admin = 0, demo = 0 } = {}) => Number((await db.execute({
    sql: `INSERT INTO auth_accounts (email,password_hash,display_name,color,is_admin,is_demo)
      VALUES (?,?,?,?,?,?)`,
    args: [email, 'x'.repeat(60), email.split('@')[0], '#123456', admin, demo],
  })).lastInsertRowid);
  ids.admin = await account('global.admin@example.test', { admin: 1 });
  ids.owner = await account('plain.owner@example.test');
  ids.demoAdmin = await account('demo.admin@example.test', { admin: 1, demo: 1 });
  ids.inactiveAdmin = await account('inactive.admin@example.test', { admin: 1 });
  ids.archivedAdmin = await account('archived.admin@example.test', { admin: 1 });
  const primary = Number((await db.execute(`INSERT INTO circles (public_id,slug,name,is_primary)
    VALUES ('circle-primary-public','primary','Primary',1)`)).lastInsertRowid);
  const archived = Number((await db.execute(`INSERT INTO circles (public_id,slug,name,is_primary,archived_at)
    VALUES ('circle-archived-public','archived','Archived',0,datetime('now'))`)).lastInsertRowid);
  const member = (circle, user, role, status = 'active') => db.execute({
    sql: `INSERT INTO circle_memberships (circle_id,user_id,role,status) VALUES (?,?,?,?)`,
    args: [circle, user, role, status],
  });
  await member(primary, ids.admin, 'owner');
  await member(primary, ids.owner, 'owner');
  await member(primary, ids.demoAdmin, 'member');
  await member(primary, ids.inactiveAdmin, 'member', 'inactive');
  await member(archived, ids.archivedAdmin, 'owner');
});

after(() => {
  db.close();
  rmSync(directory, { recursive: true, force: true });
});

beforeEach(async () => {
  await db.execute('DELETE FROM outbox_audit_events');
  await db.execute('DELETE FROM outbox_events');
  await db.execute('DELETE FROM app_logs');
});

const iso = offsetMs => new Date(Date.now() + offsetMs).toISOString();
const sqliteTime = offsetMs => new Date(Date.now() + offsetMs).toISOString().slice(0, 19).replace('T', ' ');

async function insertEvent({ type = 'pairing.email.requested', status = 'pending', notBefore = iso(-1000),
  nextAttemptAt = notBefore, leasedUntil = null, deliveredAt = null, deadLetteredAt = null,
  lastErrorCode = null, attempts = 0 } = {}) {
  sequence += 1;
  const leased = status === 'processing';
  return Number((await db.execute({
    sql: `INSERT INTO outbox_events (event_type,event_version,idempotency_key,payload_json,status,
      not_before,next_attempt_at,lease_owner,lease_token,leased_until,delivered_at,dead_lettered_at,
      last_error_code,attempt_count)
      VALUES (?,1,?,?,?,?,?,?,?,?,?,?,?,?)`,
    args: [type, `secret-idempotency-key-${sequence}`, JSON.stringify({ email: `person${sequence}@example.test`, token: 'tok_private' }),
      status, notBefore, nextAttemptAt, leased ? 'worker' : null, leased ? `lease-token-${sequence}` : null,
      leased ? leasedUntil : null, deliveredAt, deadLetteredAt, lastErrorCode, attempts],
  })).lastInsertRowid);
}

async function deadLetter(reasonCode, { type = 'invitation.email.requested', at = iso(-HOUR), code = 'PROVIDER_REJECTED' } = {}) {
  const id = await insertEvent({ type, status: 'dead_letter', deadLetteredAt: at, lastErrorCode: code, attempts: 5 });
  await db.execute({
    sql: `INSERT INTO outbox_audit_events (outbox_event_id,action,actor_type,actor_ref,from_status,to_status,reason_code,attempt_number)
      VALUES (?,'dead_lettered','worker','worker-1','processing','dead_letter',?,5)`,
    args: [id, reasonCode],
  });
  return id;
}

async function log({ level = 'info', source = 'server', event = null, message = 'person@example.test secret', userId = null, at = sqliteTime(0) } = {}) {
  await db.execute({
    sql: `INSERT INTO app_logs (level,source,event,message,meta_json,user_id,route,ua,ip,created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?)`,
    args: [level, source, event, message, JSON.stringify({ email: 'person@example.test' }), userId, '/api/x?token=abc', 'ua', '203.0.113.5', at],
  });
}

const SMOKE_OK_META = JSON.stringify({ javascript: { status: 'ok', durationMs: 700 }, python: { status: 'ok', durationMs: 800 } });

async function smokeRow({ event, message, meta = null, at, source = 'runner', userId = null }) {
  return Number((await db.execute({
    sql: `INSERT INTO app_logs (level,source,event,message,meta_json,user_id,created_at) VALUES ('info',?,?,?,?,?,?)`,
    args: [source, event, message, meta, userId, at],
  })).lastInsertRowid);
}

// A smoke claim plus, optionally, the result saved for that exact claim, the
// way api/_execution-smoke.js writes them.
async function smokeRun({ ageMs, saved = true, meta = SMOKE_OK_META }) {
  const claimId = await smokeRow({ event: 'execution_smoke_claim', message: 'schedule', at: sqliteTime(-ageMs) });
  if (saved) await smokeRow({ event: 'execution_smoke_result', message: String(claimId), meta, at: sqliteTime(-ageMs) });
  return claimId;
}

const smokeOf = async (env = {}) => (await readAdminDiagnostics(db, { env, checkReadiness: ready })).cards.execution.smoke;

function assertNoPrivateData(value) {
  const text = JSON.stringify(value);
  assert.doesNotMatch(text, /@/, 'no email addresses');
  assert.doesNotMatch(text, /secret|tok_private|lease-token|idempotency|payload|203\.0\.113/i, 'no payloads, keys, tokens or addresses');
}

// ------------------------------------------------------------------ helpers

test('the feature flag is on only for the exact string "true"', () => {
  assert.equal(adminDiagnosticsEnabled({}), false);
  assert.equal(adminDiagnosticsEnabled({ ADMIN_DIAGNOSTICS_ENABLED: '1' }), false);
  assert.equal(adminDiagnosticsEnabled({ ADMIN_DIAGNOSTICS_ENABLED: 'TRUE' }), false);
  assert.equal(adminDiagnosticsEnabled({ ADMIN_DIAGNOSTICS_ENABLED: 'true' }), true);
  assert.equal(adminDiagnosticsEnabled(null), false);
  const saved = process.env.ADMIN_DIAGNOSTICS_ENABLED;
  delete process.env.ADMIN_DIAGNOSTICS_ENABLED;
  try { assert.equal(adminDiagnosticsEnabled(), false); }
  finally { if (saved !== undefined) process.env.ADMIN_DIAGNOSTICS_ENABLED = saved; }
});

test('instants parse ISO and SQLite UTC timestamps and reject anything else', () => {
  assert.equal(parseDiagnosticsInstant('2026-10-20 10:00:00'), Date.parse('2026-10-20T10:00:00Z'));
  assert.equal(parseDiagnosticsInstant('2026-10-20 10:00:00.250'), Date.parse('2026-10-20T10:00:00.250Z'));
  assert.equal(parseDiagnosticsInstant('2026-10-20T10:00:00.000Z'), Date.parse('2026-10-20T10:00:00Z'));
  for (const value of [null, undefined, '', 'not a time']) assert.equal(parseDiagnosticsInstant(value), null);
});

test('evidence is stale when missing or older than its cadence, and fresh at the boundary', () => {
  const now = Date.parse('2026-10-20T12:00:00Z');
  assert.deepEqual(evidence(now, null, MINUTE), { at: null, ageMs: null, maxAgeMs: MINUTE, stale: true });
  assert.equal(evidence(now, now - MINUTE, MINUTE).stale, false);
  assert.equal(evidence(now, now - MINUTE - 1, MINUTE).stale, true);
  assert.equal(evidence(now, now + 5000, MINUTE).ageMs, 0, 'clock skew never produces a negative age');
  assert.equal(evidence(now, now - 1000, MINUTE).at, new Date(now - 1000).toISOString());
});

test('log categories keep identifier-like names and bucket anything that could carry data', () => {
  assert.equal(safeEventName('api_fail'), 'api_fail');
  assert.equal(safeEventName('Outbox.Invocation'), 'outbox.invocation');
  for (const value of ['person@example.test', 'a b', '', null, 'x'.repeat(49), 'user_1234567', 'abcdefghijklmnopqrstuvwxyz_fail', '_leading', 'trailing_']) {
    assert.equal(safeEventName(value), 'other', String(value));
  }
  assert.equal(safeLogSource('Server'), 'server');
  assert.equal(safeLogSource('client'), 'client');
  assert.equal(safeLogSource('runner'), 'runner');
  assert.equal(safeLogSource('custom-source'), 'other');
  assert.equal(safeLogSource(undefined), 'other');
});

test('the outbox verdict mirrors the watchdog thresholds', () => {
  const base = { oldestDueAgeMs: null, oldestStaleLeaseAgeMs: null, deadLetterCount: 0, dueCount: 0, processingStaleCount: 0 };
  assert.deepEqual(outboxCardStatus(base), { status: 'healthy', category: null });
  assert.deepEqual(outboxCardStatus({ ...base, dueCount: 1, oldestDueAgeMs: OUTBOX_DELIVERY_MAX_AGE_MS }), { status: 'degraded', category: 'delivery_backlog' });
  assert.deepEqual(outboxCardStatus({ ...base, processingStaleCount: 1, oldestStaleLeaseAgeMs: 1 }), { status: 'degraded', category: 'delivery_backlog' });
  assert.deepEqual(outboxCardStatus({ ...base, deadLetterCount: 2 }), { status: 'degraded', category: 'dead_letters_recent' });
  assert.deepEqual(outboxCardStatus({ ...base, dueCount: 1, oldestDueAgeMs: OUTBOX_DELIVERY_MAX_AGE_MS + 1 }), { status: 'failed', category: 'delivery_stale' });
  assert.deepEqual(outboxCardStatus({ ...base, oldestStaleLeaseAgeMs: OUTBOX_DELIVERY_MAX_AGE_MS + 1 }), { status: 'failed', category: 'lease_stale' });
});

test('execution configuration reports bounded reasons and never the endpoint URL', () => {
  assert.deepEqual(executionConfiguration({}), { provider: null, configured: false, reason: 'not_set' });
  assert.deepEqual(executionConfiguration({ EXECUTION_PROVIDER: 'emkc' }), { provider: null, configured: false, reason: 'unsupported' });
  assert.deepEqual(executionConfiguration({ EXECUTION_PROVIDER: 'piston', EXECUTION_API_URL: 'http://insecure.example/x' }),
    { provider: 'piston', configured: false, reason: 'misconfigured' });
  const piston = executionConfiguration({ EXECUTION_PROVIDER: 'piston', EXECUTION_API_URL: 'https://runner.example/api/v2/execute' });
  assert.deepEqual(piston, { provider: 'piston', configured: true, reason: null });
  assert.doesNotMatch(JSON.stringify(piston), /runner\.example/);
  assert.deepEqual(executionConfiguration({ EXECUTION_PROVIDER: 'vercel-sandbox' }), { provider: 'vercel-sandbox', configured: true, reason: null });
});

test('error rows are summarised by source, category and level with a bounded list', () => {
  const rows = [
    { source: 'server', event: 'api_unhandled', level: 'error', count: 3, last_at: '2026-10-20 10:00:00' },
    { source: 'server', event: 'api_unhandled', level: 'error', count: 1, last_at: '2026-10-20 11:00:00' },
    { source: 'client', event: 'person@example.test', level: 'warn', count: 2, last_at: null },
    { source: 'mystery', event: 'api_fail', level: 'warn', count: 1, last_at: '2026-10-20 09:00:00' },
    { source: 'runner', event: 'execute_fail', level: 'error', count: 0 },
    { source: 'server', event: 'noise', level: 'info', count: 9 },
  ];
  const summary = summarizeErrorRows(rows);
  assert.deepEqual(summary.totals, { error: 4, warn: 3 });
  assert.deepEqual(summary.bySource.server, { error: 4, warn: 0 });
  assert.deepEqual(summary.bySource.client, { error: 0, warn: 2 });
  assert.deepEqual(summary.bySource.other, { error: 0, warn: 1 });
  assert.deepEqual(summary.categories[0], { source: 'server', event: 'api_unhandled', level: 'error', count: 4, lastAt: '2026-10-20T11:00:00.000Z' });
  assert.deepEqual(summary.categories[1], { source: 'client', event: 'other', level: 'warn', count: 2, lastAt: null });
  assert.equal(summary.otherCount, 0);
  const many = Array.from({ length: ERROR_CATEGORY_LIMIT + 3 }, (_, index) => ({ source: 'server', event: `event_${String.fromCharCode(97 + index)}`, level: 'warn', count: 1 }));
  const bounded = summarizeErrorRows(many);
  assert.equal(bounded.categories.length, ERROR_CATEGORY_LIMIT);
  assert.equal(bounded.otherCount, 3);
  assert.deepEqual(summarizeErrorRows(undefined).totals, { error: 0, warn: 0 });
});

test('threshold constants match the reviewed watchdog workflows', () => {
  const outbox = parseYaml(readFileSync(new URL('.github/workflows/outbox-dispatch-watchdog.yml', ROOT), 'utf8'));
  const backup = readFileSync(new URL('.github/workflows/turso-backup-restore-watchdog.yml', ROOT), 'utf8');
  const outboxEnv = JSON.stringify(outbox);
  assert.match(outboxEnv, new RegExp(`"WATCHDOG_DELIVERY_MAX_AGE_MS":"${OUTBOX_DELIVERY_MAX_AGE_MS}"`));
  assert.match(backup, new RegExp(`WATCHDOG_MAX_RUN_AGE_MS: '${BACKUP_WATCHDOG_CADENCE_MS}'`));
  assert.match(outboxEnv, /"cron":"37 \* \* \* \*"/, 'the outbox watchdog runs hourly');
  assert.equal(OUTBOX_WATCHDOG_CADENCE_MS, HOUR);
  // Three missed five-minute scheduler runs, the watchdog's delivery threshold.
  assert.equal(OUTBOX_DISPATCH_EVIDENCE_MAX_AGE_MS, 15 * MINUTE);
});

test('the advertised replay reason codes are exactly the ones the audited replay accepts', async () => {
  for (const reasonCode of OUTBOX_REPLAY_REASON_CODES) {
    const id = await deadLetter('403:validation_error:domain_not_verified');
    assert.equal(await replayDeadLetter(db, { eventId: id, operatorUserId: ids.admin, reasonCode }), true, reasonCode);
  }
  const id = await deadLetter('403:validation_error:domain_not_verified');
  await assert.rejects(replayDeadLetter(db, { eventId: id, operatorUserId: ids.admin, reasonCode: 'ANYTHING_ELSE' }), TypeError);
});

// ------------------------------------------------------------ authorization

test('only an active, non-demo account with is_admin=1 is a global admin', async () => {
  assert.deepEqual(await authorizeGlobalAdmin(db, { id: ids.admin }, { env: MEMBERSHIP_ENV }), { ok: true, userId: ids.admin });
  assert.deepEqual(await authorizeGlobalAdmin(db, { uid: ids.admin }, { env: {} }), { ok: true, userId: ids.admin });
  // An ordinary circle owner is refused.
  assert.deepEqual(await authorizeGlobalAdmin(db, { id: ids.owner }, { env: MEMBERSHIP_ENV }), { ok: false, status: 403 });
  // A demo account is refused even with is_admin=1.
  assert.deepEqual(await authorizeGlobalAdmin(db, { id: ids.demoAdmin }, { env: MEMBERSHIP_ENV }), { ok: false, status: 403 });
  // Inactive membership, or membership only in an archived circle, is not an active account.
  assert.deepEqual(await authorizeGlobalAdmin(db, { id: ids.inactiveAdmin }, { env: MEMBERSHIP_ENV }), { ok: false, status: 403 });
  assert.deepEqual(await authorizeGlobalAdmin(db, { id: ids.archivedAdmin }, { env: MEMBERSHIP_ENV }), { ok: false, status: 403 });
  // Without enforced membership the live session (checked by the caller) is the activity proof.
  assert.deepEqual(await authorizeGlobalAdmin(db, { id: ids.inactiveAdmin }, { env: {} }), { ok: true, userId: ids.inactiveAdmin });
  // Unknown accounts and malformed identities.
  assert.deepEqual(await authorizeGlobalAdmin(db, { id: 999999 }, { env: MEMBERSHIP_ENV }), { ok: false, status: 403 });
  for (const payload of [null, {}, { id: 0 }, { id: 'abc' }, { id: 1.5 }]) {
    assert.deepEqual(await authorizeGlobalAdmin(db, payload, { env: MEMBERSHIP_ENV }), { ok: false, status: 401 });
  }
  // Duplicate or mismatched rows fail closed.
  const fake = rows => ({ execute: async () => ({ rows }) });
  const row = { id: ids.admin, is_admin: 1, is_demo: 0, active_account: 1 };
  assert.equal((await authorizeGlobalAdmin(fake([row, row]), { id: ids.admin })).ok, false);
  assert.equal((await authorizeGlobalAdmin(fake([{ ...row, id: ids.admin + 1 }]), { id: ids.admin })).ok, false);
  assert.equal((await authorizeGlobalAdmin(fake([{ ...row, is_demo: null }]), { id: ids.admin }, { env: {} })).ok, true);
  assert.equal((await authorizeGlobalAdmin({ execute: async () => ({}) }, { id: ids.admin })).ok, false);
});

// --------------------------------------------------------------- snapshot

test('the snapshot aggregates outbox health by event type without private data', async () => {
  await insertEvent({ type: 'pairing.email.requested', notBefore: iso(-20 * MINUTE) });
  await insertEvent({ type: 'pairing.email.requested', status: 'retry', notBefore: iso(-2 * MINUTE) });
  await insertEvent({ type: 'pairing.email.requested', notBefore: iso(HOUR) });
  await insertEvent({ type: 'pairing.email.requested', status: 'processing', leasedUntil: iso(-MINUTE) });
  await insertEvent({ type: 'schedule.email.requested', status: 'delivered', deliveredAt: iso(-5 * MINUTE) });
  await insertEvent({ type: 'schedule.email.requested', status: 'suppressed' });
  await deadLetter('403:validation_error:domain_not_verified');
  await deadLetter('not-a-provider-reason', { at: iso(-3 * DAY), code: 'lowercase bad code' });
  await log({ event: 'outbox_invocation', at: sqliteTime(-2 * MINUTE) });
  const snapshot = await readAdminDiagnostics(db, { env: MEMBERSHIP_ENV, checkReadiness: ready });
  assert.equal(snapshot.ok, true);
  assert.equal(snapshot.format, ADMIN_DIAGNOSTICS_FORMAT);
  assert.equal(snapshot.refreshAfterMs, DIAGNOSTICS_SNAPSHOT_MAX_AGE_MS);
  assert.ok(Math.abs(Date.parse(snapshot.checkedAt) - Date.now()) < 60_000);
  const { outbox } = snapshot.cards;
  assert.equal(outbox.status, 'failed');
  assert.equal(outbox.category, 'delivery_stale');
  assert.equal(outbox.evidence.stale, false);
  assert.equal(outbox.evidence.maxAgeMs, OUTBOX_DISPATCH_EVIDENCE_MAX_AGE_MS);
  assert.equal(outbox.totals.due, 2);
  assert.equal(outbox.totals.queued, 3);
  assert.equal(outbox.totals.leased, 1);
  assert.equal(outbox.totals.staleLeases, 1);
  assert.equal(outbox.totals.deadLetter, 2);
  assert.equal(outbox.totals.deadLetter24h, 1);
  assert.ok(outbox.totals.oldestDueAgeMs >= 20 * MINUTE - 5000);
  assert.ok(outbox.totals.lastDeliveredAt);
  assert.deepEqual(outbox.recentRejectReasons, { domain_not_verified: 1 });
  const pairing = outbox.byType.find(item => item.eventType === 'pairing.email.requested');
  assert.deepEqual({ ...pairing, oldestDueAgeMs: pairing.oldestDueAgeMs > 19 * MINUTE }, {
    eventType: 'pairing.email.requested', queued: 3, due: 2, leased: 1, staleLeases: 1, retrying: 1,
    delivered: 0, suppressed: 0, deadLetter: 0, deadLetter24h: 0, oldestDueAgeMs: true,
  });
  const schedule = outbox.byType.find(item => item.eventType === 'schedule.email.requested');
  assert.equal(schedule.delivered, 1);
  assert.equal(schedule.suppressed, 1);
  assert.equal(schedule.oldestDueAgeMs, null);
  const invitation = outbox.byType.find(item => item.eventType === 'invitation.email.requested');
  assert.equal(invitation.deadLetter, 2);
  assert.equal(invitation.deadLetter24h, 1);
  assert.deepEqual(outbox.byType.map(item => item.eventType), [...outbox.byType.map(item => item.eventType)].sort());

  const { deadLetters } = snapshot.cards;
  assert.equal(deadLetters.status, 'degraded');
  assert.equal(deadLetters.total, 2);
  assert.equal(deadLetters.limit, DEAD_LETTER_LIST_LIMIT);
  assert.deepEqual(deadLetters.replayReasonCodes, OUTBOX_REPLAY_REASON_CODES);
  assert.equal(deadLetters.items.length, 2);
  assert.deepEqual(Object.keys(deadLetters.items[0]).sort(),
    ['ageMs', 'attempts', 'deadLetteredAt', 'errorCode', 'eventType', 'eventVersion', 'id', 'providerReason', 'redacted',
      'replays']);
  assert.equal(deadLetters.items[0].redacted, false);
  assert.equal(deadLetters.items[0].providerReason, 'domain_not_verified');
  assert.equal(deadLetters.items[0].errorCode, 'PROVIDER_REJECTED');
  assert.equal(deadLetters.items[0].attempts, 5);
  assert.equal(deadLetters.items[1].providerReason, null);
  assert.equal(deadLetters.items[1].errorCode, 'OTHER');
  assertNoPrivateData(snapshot);
});

test('the dead-letter list is bounded and newest first', async () => {
  for (let index = 0; index < DEAD_LETTER_LIST_LIMIT + 2; index += 1) {
    await deadLetter('429:rate_limit_exceeded:rate_limited', { at: iso(-(index + 1) * MINUTE) });
  }
  const { deadLetters } = (await readAdminDiagnostics(db, { env: {}, checkReadiness: ready })).cards;
  assert.equal(deadLetters.total, DEAD_LETTER_LIST_LIMIT + 2);
  assert.equal(deadLetters.items.length, DEAD_LETTER_LIST_LIMIT);
  assert.ok(deadLetters.items[0].ageMs < deadLetters.items[1].ageMs);
});

test('an empty system is healthy where it can be and stale where evidence is missing', async () => {
  const snapshot = await readAdminDiagnostics(db, { env: {}, checkReadiness: ready });
  const { outbox, deadLetters, execution, readiness, errors, outboxWatchdog, backupWatchdog } = snapshot.cards;
  assert.equal(outbox.status, 'healthy');
  assert.deepEqual(outbox.byType, []);
  assert.equal(outbox.evidence.at, null);
  assert.equal(outbox.evidence.stale, true, 'no dispatcher run recorded');
  assert.deepEqual({ status: deadLetters.status, total: deadLetters.total, items: deadLetters.items }, { status: 'healthy', total: 0, items: [] });
  assert.equal(deadLetters.evidence.stale, false);
  assert.equal(execution.status, 'failed');
  assert.equal(execution.category, 'not_set');
  assert.equal(execution.evidence.stale, true);
  assert.deepEqual(execution.smoke, { status: 'none', category: null, checkedAt: null, languages: null,
    evidence: { at: null, ageMs: null, maxAgeMs: EXECUTION_SMOKE_MAX_AGE_MS, stale: true } });
  assert.equal(readiness.status, 'healthy');
  assert.equal(readiness.evidence.stale, false);
  assert.equal(readiness.evidence.maxAgeMs, DIAGNOSTICS_SNAPSHOT_MAX_AGE_MS);
  assert.equal(errors.status, 'healthy');
  assert.equal(errors.evidence.stale, true, 'no log rows at all');
  assert.equal(outboxWatchdog, WATCHDOG_CARDS.outboxWatchdog);
  assert.equal(backupWatchdog, WATCHDOG_CARDS.backupWatchdog);
  assert.deepEqual({ ...outboxWatchdog }, { status: 'deferred', category: 'github_actions_artifact_only',
    cadenceMs: OUTBOX_WATCHDOG_CADENCE_MS, liveEquivalent: 'outbox', evidence: null });
  assert.equal(backupWatchdog.cadenceMs, BACKUP_WATCHDOG_CADENCE_MS);
});

test('outbox evidence goes stale after 15 minutes and ignores browser-posted rows', async () => {
  await log({ event: 'outbox_invocation', at: sqliteTime(-(OUTBOX_DISPATCH_EVIDENCE_MAX_AGE_MS + MINUTE)) });
  // A member can post log rows with any source, but always with their user id.
  await log({ event: 'outbox_invocation', source: 'server', userId: ids.owner, at: sqliteTime(0) });
  await log({ event: 'outbox_invocation', source: 'client', at: sqliteTime(0) });
  const stale = (await readAdminDiagnostics(db, { env: {}, checkReadiness: ready })).cards.outbox;
  assert.equal(stale.evidence.stale, true);
  assert.ok(stale.evidence.ageMs > OUTBOX_DISPATCH_EVIDENCE_MAX_AGE_MS);
  await log({ event: 'outbox_invocation', at: sqliteTime(-MINUTE) });
  const fresh = (await readAdminDiagnostics(db, { env: {}, checkReadiness: ready })).cards.outbox;
  assert.equal(fresh.evidence.stale, false);
});

test('execution reports recent runner outcomes and goes stale after 26 hours', async () => {
  const env = { EXECUTION_PROVIDER: 'vercel-sandbox' };
  await log({ source: 'runner', event: 'execute_success', level: 'success', userId: ids.owner, at: sqliteTime(-2 * HOUR) });
  await log({ source: 'runner', event: 'execute_success', level: 'success', userId: ids.owner, at: sqliteTime(-HOUR) });
  await log({ source: 'runner', event: 'execute_fail', level: 'error', userId: ids.owner, at: sqliteTime(-2 * DAY) });
  // A browser cannot write the runner namespace; client rows never count.
  await log({ source: 'client', event: 'execute_fail', level: 'error', userId: ids.owner, at: sqliteTime(0) });
  let card = (await readAdminDiagnostics(db, { env, checkReadiness: ready })).cards.execution;
  assert.equal(card.status, 'healthy');
  assert.equal(card.provider, 'vercel-sandbox');
  assert.deepEqual(card.recent24h, { success: 2, failed: 0, unavailable: 0 });
  assert.equal(card.lastOutcome, 'success');
  assert.equal(card.evidence.stale, false);
  assert.equal(card.evidence.maxAgeMs, EXECUTION_EVIDENCE_MAX_AGE_MS);

  await log({ source: 'runner', event: 'execute_unavailable', level: 'error', userId: ids.owner, at: sqliteTime(-MINUTE) });
  card = (await readAdminDiagnostics(db, { env, checkReadiness: ready })).cards.execution;
  assert.equal(card.status, 'degraded');
  assert.equal(card.category, 'last_run_unavailable');
  assert.deepEqual(card.recent24h, { success: 2, failed: 0, unavailable: 1 });

  await db.execute('DELETE FROM app_logs');
  await log({ source: 'runner', event: 'execute_fail', level: 'error', userId: ids.owner, at: sqliteTime(-(EXECUTION_EVIDENCE_MAX_AGE_MS + HOUR)) });
  card = (await readAdminDiagnostics(db, { env, checkReadiness: ready })).cards.execution;
  assert.equal(card.status, 'degraded');
  assert.equal(card.category, 'last_run_failed');
  assert.equal(card.evidence.stale, true);
  assert.deepEqual(card.recent24h, { success: 0, failed: 0, unavailable: 0 });

  await db.execute('DELETE FROM app_logs');
  card = (await readAdminDiagnostics(db, { env, checkReadiness: ready })).cards.execution;
  assert.equal(card.status, 'unknown');
  assert.equal(card.category, 'no_runs');
  assert.equal(card.lastOutcome, null);
});

test('the smoke threshold and lookback follow the daily schedule and log retention', () => {
  const workflow = readFileSync(new URL('.github/workflows/execution-smoke.yml', ROOT), 'utf8');
  assert.match(workflow, /^    - cron: '29 7 \* \* \*'$/m, 'the execution smoke runs daily');
  assert.equal(EXECUTION_SMOKE_MAX_AGE_MS, 26 * HOUR, 'one day plus a two-hour grace');
  assert.equal(EXECUTION_SMOKE_REPORT_LOOKBACK, `-${APP_LOG_RETENTION_DAYS} days`);
});

test('execution shows the latest smoke result per language with its age, under the smoke route rules', async () => {
  const env = { EXECUTION_PROVIDER: 'vercel-sandbox' };
  await smokeRun({ ageMs: 3 * HOUR });
  let smoke = await smokeOf(env);
  assert.equal(smoke.status, 'passed');
  assert.deepEqual(smoke.languages, { javascript: { status: 'ok', durationMs: 700 }, python: { status: 'ok', durationMs: 800 } });
  assert.match(smoke.checkedAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.000Z$/);
  assert.equal(smoke.evidence.at, smoke.checkedAt);
  assert.ok(Math.abs(smoke.evidence.ageMs - 3 * HOUR) < MINUTE, String(smoke.evidence.ageMs));
  assert.deepEqual([smoke.evidence.maxAgeMs, smoke.evidence.stale], [EXECUTION_SMOKE_MAX_AGE_MS, false]);
  // With no member runs, a fresh passing smoke makes the card healthy and fresh.
  const lifted = (await readAdminDiagnostics(db, { env, checkReadiness: ready })).cards.execution;
  assert.deepEqual([lifted.status, lifted.category, lifted.lastOutcome, lifted.evidence.stale], ['healthy', null, null, false]);
  assert.equal(lifted.evidence.at, smoke.evidence.at);

  // A newer run with a failing language.
  await smokeRun({ ageMs: HOUR, meta: JSON.stringify({ javascript: { status: 'ok', durationMs: 600 }, python: { status: 'timeout', durationMs: 45000 } }) });
  smoke = await smokeOf(env);
  assert.equal(smoke.status, 'failed');
  assert.deepEqual(smoke.languages.python, { status: 'timeout', durationMs: 45000 });

  // Forged rows never count: a browser claim, member rows, and a member result
  // naming the real latest claim.
  const latestClaim = Number((await db.execute(`SELECT MAX(id) AS id FROM app_logs WHERE event='execution_smoke_claim'`)).rows[0].id);
  await smokeRow({ event: 'execution_smoke_result', message: String(latestClaim), meta: SMOKE_OK_META, at: sqliteTime(0), userId: ids.owner });
  await smokeRow({ event: 'execution_smoke_result', message: String(latestClaim), meta: SMOKE_OK_META, at: sqliteTime(0), source: 'client' });
  await smokeRow({ event: 'execution_smoke_claim', message: 'schedule', at: sqliteTime(0), source: 'client' });
  await smokeRow({ event: 'execution_smoke_claim', message: 'schedule', at: sqliteTime(0), userId: ids.owner });
  smoke = await smokeOf(env);
  assert.equal(smoke.status, 'failed');
  assert.equal(smoke.languages.python.status, 'timeout');

  // The latest claim without a result is in flight inside the grace, then
  // result_missing; an older passing result never stands in for it.
  await smokeRun({ ageMs: 30 * 1000, saved: false });
  smoke = await smokeOf(env);
  assert.equal(smoke.status, 'pending');
  assert.deepEqual(smoke.languages, { javascript: { status: 'pending', durationMs: null }, python: { status: 'pending', durationMs: null } });
  assert.equal(smoke.checkedAt, null);
  assert.ok(smoke.evidence.ageMs < 2 * MINUTE, 'evidence dates from the claim when no result was saved');
  await db.execute(`UPDATE app_logs SET created_at=datetime(created_at,'-${EXECUTION_SMOKE_RESULT_GRACE_SECONDS} seconds')
    WHERE id=(SELECT MAX(id) FROM app_logs WHERE event='execution_smoke_claim' AND source='runner' AND user_id IS NULL)`);
  smoke = await smokeOf(env);
  assert.equal(smoke.status, 'failed');
  assert.deepEqual(Object.values(smoke.languages).map(entry => entry.status), ['result_missing', 'result_missing']);
  assert.equal(smoke.evidence.stale, false);
  assertNoPrivateData(smoke);
  assert.doesNotMatch(JSON.stringify(smoke), /https?:|randori-smoke|stdout|stderr/);
});

test('the smoke result goes stale after 26 hours and is found over the whole log retention', async () => {
  await smokeRun({ ageMs: EXECUTION_SMOKE_MAX_AGE_MS + HOUR });
  let smoke = await smokeOf();
  assert.equal(smoke.status, 'passed', 'older than the smoke route lookback, still reported');
  assert.equal(smoke.evidence.stale, true);
  assert.ok(smoke.evidence.ageMs > EXECUTION_SMOKE_MAX_AGE_MS);
  await db.execute('DELETE FROM app_logs');
  await smokeRun({ ageMs: (APP_LOG_RETENTION_DAYS + 1) * DAY });
  smoke = await smokeOf();
  assert.deepEqual([smoke.status, smoke.languages, smoke.evidence.at, smoke.evidence.stale], ['none', null, null, true]);
});

test('a fresh smoke failure newer than the latest member run degrades the execution card', async () => {
  const env = { EXECUTION_PROVIDER: 'vercel-sandbox' };
  await log({ source: 'runner', event: 'execute_success', level: 'success', userId: ids.owner, at: sqliteTime(-2 * HOUR) });
  await smokeRun({ ageMs: HOUR, meta: JSON.stringify({ javascript: { status: 'ok', durationMs: 600 }, python: { status: 'provider_error', durationMs: 900 } }) });
  let card = (await readAdminDiagnostics(db, { env, checkReadiness: ready })).cards.execution;
  assert.deepEqual([card.status, card.category, card.lastOutcome], ['degraded', 'smoke_failed', 'success']);
  assert.equal(card.evidence.at, card.smoke.evidence.at, 'freshness dates from the newer smoke');
  // A member success newer than the smoke failure keeps the card healthy.
  await log({ source: 'runner', event: 'execute_success', level: 'success', userId: ids.owner, at: sqliteTime(-MINUTE) });
  card = (await readAdminDiagnostics(db, { env, checkReadiness: ready })).cards.execution;
  assert.deepEqual([card.status, card.category], ['healthy', null]);
  assert.ok(card.evidence.ageMs < 2 * MINUTE);
  // An unconfigured provider stays failed whatever the smoke says.
  const unconfigured = (await readAdminDiagnostics(db, { env: {}, checkReadiness: ready })).cards.execution;
  assert.deepEqual([unconfigured.status, unconfigured.category], ['failed', 'not_set']);
  assertNoPrivateData(card);
});

test('the execution verdict follows each smoke rule', () => {
  const NOW = Date.parse('2026-10-22T12:00:00.000Z');
  const card = ({ status = 'healthy', category = null, lastOutcome = 'success', memberAgeMs = 2 * HOUR } = {}) => Object.freeze({
    status, category, provider: 'vercel-sandbox', configured: status !== 'failed', reason: status === 'failed' ? 'not_set' : null,
    recent24h: { success: 1, failed: 0, unavailable: 0 }, lastOutcome,
    evidence: evidence(NOW, memberAgeMs === null ? null : NOW - memberAgeMs, EXECUTION_EVIDENCE_MAX_AGE_MS),
  });
  const smoke = (status, ageMs, languages = null) => Object.freeze({
    status, category: null, checkedAt: null, languages,
    evidence: evidence(NOW, ageMs === null ? null : NOW - ageMs, EXECUTION_SMOKE_MAX_AGE_MS),
  });
  const timeout = { javascript: { status: 'ok', durationMs: 5 }, python: { status: 'timeout', durationMs: 45000 } };
  const missing = { javascript: { status: 'result_missing', durationMs: null }, python: { status: 'result_missing', durationMs: null } };
  const ok = { javascript: { status: 'ok', durationMs: 5 }, python: { status: 'ok', durationMs: 6 } };
  const verdict = (base, latest) => {
    const result = executionCardWithSmoke(base, latest, NOW);
    return [result.status, result.category];
  };
  const unknown = card({ status: 'unknown', category: 'no_runs', lastOutcome: null, memberAgeMs: null });

  // Fresh failures newer than the latest member run (or with none) degrade the card.
  assert.deepEqual(verdict(card(), smoke('failed', HOUR, timeout)), ['degraded', 'smoke_failed']);
  assert.deepEqual(verdict(card(), smoke('failed', HOUR, missing)), ['degraded', 'smoke_result_missing']);
  assert.deepEqual(verdict(card(), smoke('failed', HOUR, { ...ok, python: missing.python })), ['degraded', 'smoke_result_missing']);
  assert.deepEqual(verdict(card(), smoke('failed', HOUR, null)), ['degraded', 'smoke_result_missing']);
  assert.deepEqual(verdict(unknown, smoke('failed', HOUR, timeout)), ['degraded', 'smoke_failed']);
  assert.deepEqual(verdict(card({ status: 'degraded', category: 'last_run_failed', lastOutcome: 'failed' }), smoke('failed', HOUR, timeout)),
    ['degraded', 'smoke_failed']);
  // A failed card stays failed; a newer (or same-time) member run keeps its verdict.
  assert.deepEqual(verdict(card({ status: 'failed', category: 'not_set' }), smoke('failed', HOUR, timeout)), ['failed', 'not_set']);
  assert.deepEqual(verdict(card({ memberAgeMs: 30 * MINUTE }), smoke('failed', HOUR, timeout)), ['healthy', null]);
  assert.deepEqual(verdict(card({ memberAgeMs: HOUR }), smoke('failed', HOUR, timeout)), ['healthy', null]);
  // Pending, absent, unreadable or stale smoke changes nothing.
  const unavailableSmoke = Object.freeze({ status: 'unavailable', category: 'read_failed', checkedAt: null, languages: null,
    evidence: { at: null, ageMs: null, maxAgeMs: EXECUTION_SMOKE_MAX_AGE_MS, stale: true } });
  for (const latest of [smoke('pending', MINUTE), smoke('none', null), unavailableSmoke,
    smoke('failed', EXECUTION_SMOKE_MAX_AGE_MS + MINUTE, timeout), smoke('passed', EXECUTION_SMOKE_MAX_AGE_MS + MINUTE, ok)]) {
    assert.deepEqual(verdict(card(), latest), ['healthy', null], latest.status);
    assert.deepEqual(verdict(unknown, latest), ['unknown', 'no_runs'], latest.status);
  }
  // A fresh pass lifts only a card with no member runs.
  assert.deepEqual(verdict(unknown, smoke('passed', HOUR, ok)), ['healthy', null]);
  assert.deepEqual(verdict(card({ status: 'degraded', category: 'last_run_failed', lastOutcome: 'failed' }), smoke('passed', MINUTE, ok)),
    ['degraded', 'last_run_failed']);
  assert.deepEqual(verdict(card({ status: 'failed', category: 'not_set', lastOutcome: null, memberAgeMs: null }), smoke('passed', HOUR, ok)),
    ['failed', 'not_set']);

  // Freshness is the newer of the two times; a missing smoke time leaves the member's.
  const fresher = executionCardWithSmoke(card({ memberAgeMs: 30 * HOUR }), smoke('passed', HOUR, ok), NOW);
  assert.deepEqual([fresher.evidence.ageMs, fresher.evidence.stale, fresher.evidence.maxAgeMs], [HOUR, false, EXECUTION_EVIDENCE_MAX_AGE_MS]);
  assert.equal(executionCardWithSmoke(card({ memberAgeMs: HOUR }), smoke('passed', 3 * HOUR, ok), NOW).evidence.ageMs, HOUR);
  assert.equal(executionCardWithSmoke(card({ memberAgeMs: HOUR }), unavailableSmoke, NOW).evidence.ageMs, HOUR);
  const nothing = executionCardWithSmoke(unknown, smoke('none', null), NOW);
  assert.deepEqual([nothing.evidence.at, nothing.evidence.stale], [null, true]);
  const pendingOnly = executionCardWithSmoke(unknown, smoke('pending', MINUTE), NOW);
  assert.deepEqual([pendingOnly.status, pendingOnly.evidence.ageMs], ['unknown', MINUTE]);
  // Everything else on the card is kept, and the smoke rides along.
  const merged = executionCardWithSmoke(card(), smoke('failed', HOUR, timeout), NOW);
  assert.ok(Object.isFrozen(merged));
  assert.deepEqual([merged.provider, merged.lastOutcome, merged.recent24h.success, merged.smoke.status], ['vercel-sandbox', 'success', 1, 'failed']);
});

test('the smoke summary maps every latest-run shape to a bounded status', () => {
  const nowMs = Date.parse('2026-10-22T12:00:00.000Z');
  const ok = { status: 'ok', durationMs: 5 };
  const summary = latest => executionSmokeSummary(latest, nowMs);
  // A saved result with an unreadable time falls back to the claim's age.
  const noTime = summary({ claimAgeSeconds: 60, saved: true, checkedAt: null, languages: { javascript: ok, python: ok } });
  assert.deepEqual([noTime.status, noTime.checkedAt, noTime.evidence.ageMs], ['passed', null, MINUTE]);
  // No readable claim age and no result: no evidence at all.
  const unknownAge = summary({ claimAgeSeconds: null, saved: false, checkedAt: null, languages: null });
  assert.deepEqual([unknownAge.status, unknownAge.evidence.at, unknownAge.evidence.stale], ['failed', null, true]);
  // One unreadable language fails the run.
  const partial = summary({ claimAgeSeconds: 60, saved: true, checkedAt: '2026-10-22T11:00:00Z', languages: { javascript: ok, python: null } });
  assert.deepEqual([partial.status, partial.languages.python.status, partial.checkedAt, partial.evidence.ageMs],
    ['failed', 'result_missing', '2026-10-22T11:00:00.000Z', HOUR]);
  assert.ok(Object.isFrozen(partial) && Object.isFrozen(partial.languages) && Object.isFrozen(partial.languages.javascript));
  assert.equal(summary(null).status, 'none');
});

test('recent errors count categories only and go stale when logging stops for an hour', async () => {
  await log({ level: 'error', source: 'server', event: 'api_unhandled', at: sqliteTime(-HOUR) });
  await log({ level: 'error', source: 'client', event: 'js_exception', userId: ids.owner, at: sqliteTime(-2 * HOUR) });
  await log({ level: 'warn', source: 'client', event: 'contact person@example.test', userId: ids.owner, at: sqliteTime(-3 * HOUR) });
  await log({ level: 'warn', source: 'server', event: null, at: sqliteTime(-4 * HOUR) });
  await log({ level: 'error', source: 'server', event: 'too_old', at: sqliteTime(-2 * DAY) });
  await log({ level: 'info', source: 'server', event: 'outbox_invocation', at: sqliteTime(-MINUTE) });
  let card = (await readAdminDiagnostics(db, { env: {}, checkReadiness: ready })).cards.errors;
  assert.equal(card.status, 'degraded');
  assert.equal(card.category, 'errors_recent');
  assert.equal(card.windowMs, DAY);
  assert.deepEqual(card.totals, { error: 2, warn: 2 });
  assert.deepEqual(card.bySource.client, { error: 1, warn: 1 });
  assert.deepEqual(card.categories.map(item => item.event).sort(), ['api_unhandled', 'js_exception', 'other', 'other']);
  assert.equal(card.evidence.stale, false);
  assert.equal(card.evidence.maxAgeMs, LOG_EVIDENCE_MAX_AGE_MS);
  assertNoPrivateData(card);

  await db.execute('DELETE FROM app_logs');
  await log({ level: 'info', event: 'outbox_invocation', at: sqliteTime(-(LOG_EVIDENCE_MAX_AGE_MS + MINUTE)) });
  // A fresh member-posted row does not make server logging look alive.
  await log({ level: 'info', source: 'client', event: 'probe', userId: ids.owner, at: sqliteTime(-MINUTE) });
  card = (await readAdminDiagnostics(db, { env: {}, checkReadiness: ready })).cards.errors;
  assert.equal(card.status, 'healthy');
  assert.equal(card.evidence.stale, true);
});

test('readiness combines the readiness check with the migration ledger', async () => {
  let card = (await readAdminDiagnostics(db, { env: {}, checkReadiness: ready })).cards.readiness;
  assert.equal(card.status, 'healthy');
  assert.equal(card.ready, true);
  assert.equal(card.ledger.state, 'current');
  assert.equal(card.ledger.currentVersion, LATEST_MIGRATION_VERSION);
  assert.equal(card.ledger.expectedVersion, LATEST_MIGRATION_VERSION);
  assert.equal(card.ledger.appliedCount, MIGRATION_CONTRACTS.length);
  assert.equal(card.ledger.latest.version, LATEST_MIGRATION_VERSION);
  assert.equal(card.ledger.latest.name, MIGRATION_CONTRACTS.at(-1).name);
  assert.match(card.ledger.latest.appliedAt, /Z$/);
  assert.equal(card.ledger.recent.length, Math.min(5, MIGRATION_CONTRACTS.length));
  assert.doesNotMatch(JSON.stringify(card), new RegExp(MIGRATION_CONTRACTS.at(-1).checksum), 'no checksums');

  card = (await readAdminDiagnostics(db, { env: {}, checkReadiness: async () => ({ ready: false, reason: 'not_ready' }) })).cards.readiness;
  assert.deepEqual([card.status, card.category, card.ready], ['failed', 'not_ready', false]);
  card = (await readAdminDiagnostics(db, { env: {}, checkReadiness: async () => ({ ready: false }) })).cards.readiness;
  assert.equal(card.category, 'not_ready');

  // The default check reuses /api/health/ready semantics: an unconfigured
  // database URL is not ready.
  card = (await readAdminDiagnostics(db, { env: {} })).cards.readiness;
  assert.deepEqual([card.status, card.category], ['failed', 'unconfigured']);
});

test('the default readiness check runs the shared readiness probe for a configured database', async () => {
  const path = join(directory, 'diagnostics.sqlite');
  const env = { TURSO_DATABASE_URL: `file://${path}`, RANDORI_LOCAL_RUNTIME: 'true', RANDORI_LOCAL_DATABASE_PATH: path,
    NODE_ENV: 'development', CIRCLE_MEMBERSHIP_ENABLED: 'true' };
  const card = (await readAdminDiagnostics(db, { env })).cards.readiness;
  assert.equal(typeof card.ready, 'boolean');
  assert.notEqual(card.category, 'unconfigured', 'the configured database is probed');
  assert.ok(card.ready ? card.status === 'healthy' : ['not_ready', 'check_failed'].includes(card.category), JSON.stringify(card));
  const broken = {
    execute: async statement => {
      const sql = typeof statement === 'string' ? statement : statement.sql;
      if (/sqlite_schema|sqlite_master|PRAGMA/i.test(sql)) throw new Error('schema read failed');
      return db.execute(statement);
    },
  };
  const failed = (await readAdminDiagnostics(broken, { env })).cards.readiness;
  assert.equal(failed.status, 'unavailable', 'a ledger read failure isolates the card');
});

function ledgerDb(rows, { exists = true } = {}) {
  return {
    execute: async statement => {
      const sql = typeof statement === 'string' ? statement : statement.sql;
      if (sql.includes('sqlite_schema')) return { rows: exists ? [{ present: 1 }] : [] };
      return { rows };
    },
  };
}
const ledgerRow = (contract, extra = {}) => ({ version: contract.version, name: contract.name, checksum: contract.checksum,
  applied_at: '2026-10-01 10:00:00', execution_ms: 5, disposition: 'applied', ...extra });

test('the migration ledger summary reports missing, behind, ahead and invalid ledgers', async () => {
  assert.equal((await readMigrationLedgerSummary(ledgerDb([], { exists: false }))).state, 'missing');
  const all = MIGRATION_CONTRACTS.map(contract => ledgerRow(contract));
  const current = await readMigrationLedgerSummary(ledgerDb(all));
  assert.equal(current.state, 'current');
  assert.equal(current.latest.appliedAt, '2026-10-01T10:00:00.000Z');
  const behind = await readMigrationLedgerSummary(ledgerDb(all.slice(0, -1)));
  assert.deepEqual([behind.state, behind.currentVersion], ['behind', LATEST_MIGRATION_VERSION - 1]);
  const ahead = await readMigrationLedgerSummary(ledgerDb([...all, { ...all.at(-1), version: LATEST_MIGRATION_VERSION + 1, name: 'future' }]));
  assert.deepEqual([ahead.state, ahead.currentVersion, ahead.latest], ['ahead', LATEST_MIGRATION_VERSION + 1, null]);
  const tampered = await readMigrationLedgerSummary(ledgerDb([{ ...all[0], checksum: 'f'.repeat(64) }, ...all.slice(1)]));
  assert.deepEqual([tampered.state, tampered.currentVersion, tampered.recent], ['invalid', LATEST_MIGRATION_VERSION, []]);
  const garbage = await readMigrationLedgerSummary(ledgerDb([{ version: 'x', name: 'x' }]));
  assert.deepEqual([garbage.state, garbage.currentVersion], ['invalid', 0]);

  for (const [state, category] of [['missing', 'ledger_missing'], ['behind', 'ledger_behind']]) {
    const rows = state === 'missing' ? [] : all.slice(0, -1);
    const fake = {
      execute: async statement => {
        const sql = typeof statement === 'string' ? statement : statement.sql;
        if (sql.includes('sqlite_schema')) return { rows: state === 'missing' ? [] : [{ present: 1 }] };
        if (sql.includes('schema_migrations')) return { rows };
        return db.execute(statement);
      },
    };
    const card = (await readAdminDiagnostics(fake, { env: {}, checkReadiness: ready })).cards.readiness;
    assert.deepEqual([card.status, card.category], ['failed', category]);
  }
});

test('one failing source makes only its card unavailable; a clock failure is fatal', async () => {
  const failing = pattern => ({
    execute: async statement => {
      const sql = typeof statement === 'string' ? statement : statement.sql;
      if (pattern.test(sql)) throw new Error('read failed');
      return db.execute(statement);
    },
  });
  const snapshot = await readAdminDiagnostics(failing(/FROM app_logs/), { env: {}, checkReadiness: ready });
  for (const id of ['outbox', 'execution', 'errors']) {
    assert.equal(snapshot.cards[id].status, 'unavailable', id);
    assert.equal(snapshot.cards[id].evidence.stale, true, id);
  }
  assert.equal(snapshot.cards.execution.smoke.status, 'unavailable');
  assert.equal(snapshot.cards.deadLetters.status, 'healthy');
  assert.equal(snapshot.cards.readiness.status, 'healthy');
  const dead = await readAdminDiagnostics(failing(/outbox_audit_events audit/), { env: {}, checkReadiness: ready });
  assert.equal(dead.cards.deadLetters.status, 'unavailable');
  const readinessDown = await readAdminDiagnostics(db, { env: {}, checkReadiness: async () => { throw new Error('boom'); } });
  assert.equal(readinessDown.cards.readiness.status, 'unavailable');
  // The smoke read fails alone: only execution.smoke is unavailable.
  await smokeRun({ ageMs: HOUR });
  const smokeDown = (await readAdminDiagnostics(failing(/WITH latest AS/), { env: {}, checkReadiness: ready })).cards;
  assert.deepEqual([smokeDown.execution.status, smokeDown.execution.category], ['failed', 'not_set']);
  assert.deepEqual(smokeDown.execution.smoke, { status: 'unavailable', category: 'read_failed', checkedAt: null, languages: null,
    evidence: { at: null, ageMs: null, maxAgeMs: EXECUTION_SMOKE_MAX_AGE_MS, stale: true } });
  assert.equal(smokeDown.errors.status, 'healthy');
  // The execution reads fail alone: the card is unavailable but keeps the smoke result.
  const executionDown = (await readAdminDiagnostics(failing(/event IN \(/), { env: {}, checkReadiness: ready })).cards.execution;
  assert.deepEqual([executionDown.status, executionDown.category], ['unavailable', 'read_failed']);
  assert.equal(executionDown.smoke.status, 'passed');
  assert.ok(Object.isFrozen(executionDown));
  await assert.rejects(readAdminDiagnostics(failing(/now_utc/), { env: {} }), /read failed/);
  await assert.rejects(readAdminDiagnostics({ execute: async () => ({ rows: [{ now_utc: 'garbage' }] }) }), /clock/);
  await assert.rejects(readAdminDiagnostics(null), TypeError);
});

test('unexpected stored values are bounded before they leave the server', async () => {
  const fake = {
    execute: async statement => {
      const sql = typeof statement === 'string' ? statement : statement.sql;
      if (sql.includes('AS now_utc') && !sql.includes('WITH clock')) return { rows: [{ now_utc: new Date().toISOString() }] };
      if (sql.includes('event.reason_code') || sql.includes('AS reason_code')) {
        return { rows: [
          { id: 'x', event_type: 'pairing.email.requested' },
          { id: 7, event_type: 'Bad Type!', event_version: -3, last_error_code: null, attempt_count: 'many', replay_count: 2, dead_lettered_at: null, reason_code: null },
        ] };
      }
      if (sql.includes('COUNT(*) AS total')) return { rows: [{ total: -4 }] };
      return db.execute(statement);
    },
  };
  const { deadLetters } = (await readAdminDiagnostics(fake, { env: {}, checkReadiness: ready })).cards;
  assert.equal(deadLetters.total, 0);
  assert.deepEqual(deadLetters.items, [{ id: 7, eventType: 'other', eventVersion: 0, errorCode: null, providerReason: null,
    attempts: 0, replays: 2, deadLetteredAt: null, ageMs: null, redacted: false }]);
});

// ---------------------------------------------------------------- handler

function invoke(options, { method = 'GET', env = { ADMIN_DIAGNOSTICS_ENABLED: 'true' } } = {}) {
  const calls = { verify: 0, client: 0 };
  const headers = {};
  let statusCode = 200;
  let body;
  const res = {
    setHeader(name, value) { headers[String(name).toLowerCase()] = value; },
    status(code) { statusCode = code; return this; },
    json(payload) { body = payload; return this; },
  };
  const deps = {
    verifyRequestAuth: async () => { calls.verify += 1; return options.payload === undefined ? { id: ids.admin } : options.payload; },
    getClient: () => { calls.client += 1; if (options.clientError) throw new Error('no db'); return options.db || db; },
    env: { ...env, ...options.env },
    ...(options.read ? { read: options.read } : {}),
    ...(options.verifyRequestAuth ? { verifyRequestAuth: options.verifyRequestAuth } : {}),
    ...(options.notFound ? { notFound: options.notFound } : {}),
  };
  return handleAdminDiagnosticsRequest({ method, headers: {} }, res, deps).then(() => ({ status: statusCode, body, headers, calls }));
}

test('the route is a 404 with no session, database access or headers of its own while the flag is off', async () => {
  for (const env of [{}, { ADMIN_DIAGNOSTICS_ENABLED: 'false' }]) {
    const result = await invoke({}, { env });
    assert.equal(result.status, 404);
    assert.deepEqual(result.body, { ok: false, error: 'not found' });
    assert.deepEqual(result.calls, { verify: 0, client: 0 });
    assert.deepEqual(result.headers, {});
  }
  // The caller's unknown-route response is used verbatim.
  let used = 0;
  const custom = await invoke({ notFound: () => { used += 1; } }, { env: {} });
  assert.deepEqual([used, custom.status, custom.body, custom.calls], [1, 200, undefined, { verify: 0, client: 0 }]);
});

test('the route refuses other methods, anonymous callers and non-admins', async () => {
  const post = await invoke({}, { method: 'POST' });
  assert.deepEqual([post.status, post.headers.allow, post.calls.verify], [405, 'GET', 0]);
  const anonymous = await invoke({ payload: null });
  assert.deepEqual([anonymous.status, anonymous.body.error, anonymous.calls.client], [401, 'authentication required', 0]);
  const malformed = await invoke({ payload: { id: 'nope' } });
  assert.deepEqual([malformed.status, malformed.body.error], [401, 'authentication required']);
  for (const id of [ids.owner, ids.demoAdmin, ids.inactiveAdmin]) {
    const denied = await invoke({ payload: { id }, env: MEMBERSHIP_ENV });
    assert.deepEqual([denied.status, denied.body], [403, { ok: false, error: 'global admin required' }], String(id));
  }
});

test('the route fails closed with 503 on session, client, authorization or read errors', async () => {
  const verifyError = await invoke({ verifyRequestAuth: async () => { throw new Error('session store down'); } });
  assert.equal(verifyError.status, 503);
  assert.equal((await invoke({ clientError: true })).status, 503);
  assert.equal((await invoke({ db: { execute: async () => { throw new Error('down'); } } })).status, 503);
  assert.equal((await invoke({ read: async () => { throw new Error('down'); } })).status, 503);
});

test('a global admin receives the aggregate snapshot with no-store caching', async () => {
  await deadLetter('403:validation_error:testing_recipient_restricted');
  const result = await invoke({ env: MEMBERSHIP_ENV });
  assert.equal(result.status, 200);
  assert.equal(result.headers['cache-control'], 'no-store');
  assert.equal(result.body.format, ADMIN_DIAGNOSTICS_FORMAT);
  assert.deepEqual(Object.keys(result.body.cards), ['outbox', 'deadLetters', 'outboxWatchdog', 'backupWatchdog', 'execution', 'readiness', 'errors']);
  assert.equal(result.body.cards.deadLetters.items[0].providerReason, 'testing_recipient_restricted');
  assertNoPrivateData(result.body);
});
