// ID-83 (issue #341): outbox personal-data retention against a real migrated
// SQLite database. Delivered and suppressed rows lose their recipient and
// credential fields after 7 days, dead letters after 30, legacy pre-v6 rows
// after 30 once bridged; pending, retry and leased rows are never touched;
// runs are bounded, hourly, idempotent and safe in parallel; replay of a
// redacted dead letter fails cleanly; health, diagnostics, rotation metrics,
// dedupe and the cron response keep working; and the flag off issues no SQL.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { rmSync } from 'node:fs';
import { after, afterEach, beforeEach, mock, test } from 'node:test';
import { createClient } from '@libsql/client';

import { prepareMigrationConnection } from '../../db/migration-runner.js';
import { createMigratedDatabase } from '../support/migrated-db.mjs';

const { directory, url } = await createMigratedDatabase({ prefix: 'randori-outbox-retention-', filename: 'outbox.sqlite' });
const db = createClient({ url });
const peer = createClient({ url });
for (const client of [db, peer]) {
  await prepareMigrationConnection(client);
  await client.execute('PRAGMA busy_timeout=5000');
}

const CRON_SECRET = 'cron-secret-for-outbox-retention';
let activeClient = db;
let sessionPayload = null;

mock.module('../../api/_db.js', {
  exports: {
    JWT_AUDIENCE: 'randori-web',
    JWT_ISSUER: 'randori-circle',
    getClient: () => activeClient,
    getJwtSecret: () => 'unit-test-secret-at-least-thirty-two-characters',
    getCronSecret: () => CRON_SECRET,
    getAdminEmails: () => new Set(),
    deterministicColor: () => '#123456',
    issueSession: async () => 'session',
    issueSessionInTransaction: async () => 'session',
    revokeAccountSessions: async () => 0,
    revokeRequestSession: async () => ({ authenticated: false, revoked: false, userId: null }),
    isoWeekLabel: () => '2026-W43',
    shuffleArray: values => [...values],
    verifyRequestAuth: async () => sessionPayload,
    verifySignedRequestAuth: () => null,
    verifyMutationOrigin: () => true,
    initSentry: () => {},
    isSentryConfigured: () => false,
    getSentry: () => ({ Sentry: null, ready: false }),
    captureSentryMessage: () => null,
    captureSentryException: () => null,
  },
});

const retention = await import('../../api/_outbox-retention.js');
const {
  OUTBOX_LEGACY_REDACTED_EMAIL,
  OUTBOX_PII_EVENT_TYPES,
  OUTBOX_PII_FIELDS,
  OUTBOX_PII_FREE_EVENT_TYPES,
  OUTBOX_PII_RETENTION_BATCH_LIMIT,
  OUTBOX_PII_RETENTION_DEAD_LETTER_DAYS,
  OUTBOX_PII_RETENTION_DELIVERED_DAYS,
  OUTBOX_PII_RETENTION_EVENT,
  OUTBOX_PII_RETENTION_FLAG,
  OUTBOX_PII_RETENTION_INTERVAL_MINUTES,
  OUTBOX_PII_RETENTION_LEGACY_DAYS,
  OUTBOX_PII_RETENTION_MAX_BATCH_LIMIT,
  OutboxEventRedactedError,
  legacyPairingRedactionStatement,
  outboxNotRedactedSql,
  outboxPiiRetentionEnabled,
  outboxRedactedSql,
  outboxRedactionStatement,
  runOutboxPiiRetention,
} = retention;
const { claimOutboxEvent, enqueueOutboxEvent, OutboxDeliveryError, readOutboxMetrics, replayDeadLetter, runOutboxWorker } =
  await import('../../api/_outbox.js');
const { readOutboxDeliveryHealth } = await import('../../api/_outbox-health.js');
const { readAdminDiagnostics } = await import('../../api/_admin-diagnostics.js');
const { parseKeyRing, readCredentialRotationMetrics, sealCredentialEnvelope } = await import('../../api/_key-rotation.js');
const { INVITATION_EMAIL_EVENT_TYPE, invitationEmailEnvelopeRotationMetrics } = await import('../../api/_invitation-email.js');
const { EMAIL_ACTIVATION_EVENT_TYPE } = await import('../../api/_email-activation.js');
const { PASSWORD_RESET_EVENT_TYPE } = await import('../../api/_password-reset.js');
const { PAIRING_EMAIL_EVENT_TYPE, migrateLegacyPairingEmails } = await import('../../api/_pairing-email.js');
const { hasPrimaryUnavailableEvidence } = await import('../../api/_pairing-evidence.js');
const { default: opsHandler, deliverPendingOutbox, OUTBOX_PII_RETENTION_BUDGET_MS } = await import('../../api/ops.js');

const NOW = '2026-10-21T12:00:00.000Z';
const DAY = 24 * 60 * 60 * 1000;
const MS = 1;
const ago = ms => new Date(Date.parse(NOW) - ms).toISOString();
const DELIVERED_CUTOFF = Date.parse(NOW) - 7 * DAY;
const DEAD_LETTER_CUTOFF = Date.parse(NOW) - 30 * DAY;
const at = ms => new Date(ms).toISOString();
const ENV_KEYS = [OUTBOX_PII_RETENTION_FLAG, 'APP_URL', 'RESEND_API_KEY', 'RESEND_FROM', 'REMINDERS_ENABLED'];
const savedEnv = Object.fromEntries(ENV_KEYS.map(key => [key, process.env[key]]));

const KEY = Buffer.alloc(32, 41).toString('base64url');
const RING = parseKeyRing({ env: { ACTIVE: KEY, VERSION: '1', WRITE: '2' }, purpose: 'test-credential',
  keyEnv: 'ACTIVE', versionEnv: 'VERSION', previousKeysEnv: 'PREVIOUS', writeVersionEnv: 'WRITE' });
const seal = (plaintext, idempotencyKey) => sealCredentialEnvelope({ plaintext, idempotencyKey, ring: RING,
  legacyAad: () => Buffer.from('legacy-aad') });
const HEX = 'a'.repeat(64);

after(() => {
  for (const client of [db, peer]) { try { client.close(); } catch {} }
  rmSync(directory, { recursive: true, force: true });
});

beforeEach(async () => {
  activeClient = db;
  sessionPayload = null;
  for (const key of ENV_KEYS) delete process.env[key];
  for (const sql of ['DELETE FROM outbox_audit_events', 'DELETE FROM outbox_events', 'DELETE FROM app_logs',
    'DELETE FROM pairing_email_outbox', 'DELETE FROM circle_invitations']) await db.execute(sql);
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
});

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

let sequence = 0;

/** Realistic payloads for every producer, keyed by a short name. */
function payloadFor(kind, overrides = {}) {
  sequence += 1;
  const id = randomUUID();
  const shapes = {
    pairing: () => ({ type: PAIRING_EMAIL_EVENT_TYPE, version: 1, key: `randori/${sequence}/paired/2`,
      payload: { week_id: sequence, user_id: 2, kind: 'paired', recipient_email: `member${sequence}@example.test` } }),
    pairingUnavailable: () => ({ type: PAIRING_EMAIL_EVENT_TYPE, version: 1, key: `randori/${sequence}/unavailable/3`,
      payload: { week_id: sequence, user_id: 3, kind: 'unavailable', recipient_email: `away${sequence}@example.test` } }),
    secondaryPairing: () => ({ type: PAIRING_EMAIL_EVENT_TYPE, version: 2,
      key: `randori/circle/4/publication/${sequence}/paired/2`,
      payload: { publication_id: sequence, circle_id: 4, user_id: 2, kind: 'paired' } }),
    invitation: () => ({ type: INVITATION_EMAIL_EVENT_TYPE, version: 1, key: `invitation-email/v1/${id}/1`,
      payload: { invitation_id: id, circle_id: 4, actor_user_id: 1, token_hash: HEX, email_hash: 'b'.repeat(64),
        send_sequence: 1, template_version: 1,
        credential_envelope: seal(JSON.stringify({ v: 1, email: `invitee${sequence}@example.test`, token: 't' }),
          `invitation-email/v1/${id}/1`) } }),
    activation: () => ({ type: EMAIL_ACTIVATION_EVENT_TYPE, version: 1, key: `auth-activation/v1/${id}/1`,
      payload: { activation_id: id, recipient_email: `new${sequence}@example.test`,
        token_envelope: seal('activation-token', `auth-activation/v1/${id}/1`) } }),
    reset: () => ({ type: PASSWORD_RESET_EVENT_TYPE, version: 1, key: `password-reset/v1/${id}/1`,
      payload: { reset_id: id, recipient_email: `reset${sequence}@example.test`,
        token_envelope: seal('reset-token', `password-reset/v1/${id}/1`) } }),
    schedule: () => ({ type: 'schedule.email.requested', version: 1, key: `schedule-email/v1/1/${sequence}/accepted/${HEX}/2`,
      payload: { kind: 'accepted', week_id: 1, pair_group_id: sequence, actor_user_id: 1, recipient_user_id: 2,
        schedule_version: HEX, template_version: 1, instant: '2026-10-01T10:00:00.000Z', previous_instant: null } }),
    secondarySchedule: () => ({ type: 'schedule.email.requested', version: 2,
      key: `secondary-schedule-email/v1/${HEX}/${sequence}/cleared/2`,
      payload: { schedule_id: HEX, proposal_id: null, schedule_revision: sequence, actor_user_id: 1,
        recipient_user_id: 2, kind: 'cleared', instant_fingerprint: null, template_version: 1 } }),
    reminder: () => ({ type: 'reminder.email.requested', version: 1,
      key: `reminder-email/v1/agree-time/primary/1/${sequence}/2`,
      payload: { kind: 'agree_time', scope: 'primary', week_id: 1, pair_group_id: sequence, recipient_user_id: 2,
        template_version: 1 } }),
    inviteRequest: () => ({ type: 'inviterequest.email.requested', version: 1,
      key: `invite-request-digest/v1/4/1/${sequence}`,
      payload: { circle_id: 4, owner_user_id: 1, digest_hour: sequence, template_version: 1 } }),
  };
  return { ...shapes[kind](), ...overrides };
}

/**
 * Insert one outbox row the way the worker leaves it. Terminal rows carry
 * their finalization instant in next_attempt_at, as finalizeOutcome writes it.
 */
async function insertEvent(kind, { status, anchor, nextAttemptAt = anchor, client = db, ...overrides } = {}) {
  const event = payloadFor(kind, overrides);
  const leased = status === 'processing';
  const result = await client.execute({
    sql: `INSERT INTO outbox_events
      (event_type,event_version,idempotency_key,payload_json,status,not_before,next_attempt_at,attempt_count,
       max_attempts,delivery_timeout_ms,lease_owner,lease_token,leased_until,provider_name,provider_message_id,
       last_error_code,delivered_at,dead_lettered_at,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,5,10000,?,?,?,?,?,?,?,?,?,?) RETURNING id`,
    args: [event.type, event.version, event.key, JSON.stringify(event.payload), status, ago(90 * DAY), nextAttemptAt,
      status === 'dead_letter' ? 5 : status === 'pending' ? 0 : 1,
      leased ? 'old-worker' : null, leased ? 'old-lease' : null, leased ? ago(80 * DAY) : null,
      ['delivered', 'suppressed'].includes(status) ? 'resend' : null,
      status === 'delivered' ? `provider-${sequence}` : null,
      status === 'dead_letter' ? 'PROVIDER_REJECTED' : status === 'suppressed' ? 'RECIPIENT_CHANGED' : null,
      status === 'delivered' ? anchor : null, status === 'dead_letter' ? anchor : null, ago(90 * DAY), anchor],
  });
  return { id: Number(result.rows[0].id), ...event };
}

async function stored(id) {
  const row = (await db.execute({ sql: 'SELECT * FROM outbox_events WHERE id=?', args: [id] })).rows[0];
  return { ...row, payload: JSON.parse(String(row.payload_json)) };
}

async function payloadOf(id) {
  return (await stored(id)).payload;
}

/** Moves the last run marker back so the next call is due. */
async function anHourPasses() {
  await db.execute({ sql: `UPDATE app_logs SET created_at=datetime(created_at,'-61 minutes') WHERE event=?`,
    args: [OUTBOX_PII_RETENTION_EVENT] });
}

async function run(options = {}) {
  return runOutboxPiiRetention(db, { now: NOW, ...options });
}

function counts(overrides = {}) {
  return { delivered: 0, suppressed: 0, dead_letter: 0, legacy_pairing: 0, ...overrides };
}

function plain(value) {
  return JSON.parse(JSON.stringify(value));
}

// ---------------------------------------------------------------------------
// Policy and validation
// ---------------------------------------------------------------------------

test('the policy is 7 days for delivered and suppressed mail, 30 for dead letters and legacy rows', () => {
  assert.equal(OUTBOX_PII_RETENTION_DELIVERED_DAYS, 7);
  assert.equal(OUTBOX_PII_RETENTION_DEAD_LETTER_DAYS, 30);
  assert.equal(OUTBOX_PII_RETENTION_LEGACY_DAYS, 30);
  assert.equal(OUTBOX_PII_RETENTION_BATCH_LIMIT, 100);
  assert.equal(OUTBOX_PII_RETENTION_MAX_BATCH_LIMIT, 500);
  assert.equal(OUTBOX_PII_RETENTION_INTERVAL_MINUTES, 60);
  assert.equal(OUTBOX_PII_RETENTION_BUDGET_MS, 2_000);
  assert.equal(OUTBOX_PII_RETENTION_FLAG, 'OUTBOX_PII_RETENTION_ENABLED');
  // The literals stay in step with the producers.
  assert.deepEqual(OUTBOX_PII_EVENT_TYPES, [PAIRING_EMAIL_EVENT_TYPE, INVITATION_EMAIL_EVENT_TYPE,
    EMAIL_ACTIVATION_EVENT_TYPE, PASSWORD_RESET_EVENT_TYPE]);
  assert.deepEqual(OUTBOX_PII_FIELDS, ['recipient_email', 'credential_envelope', 'token_envelope', 'email_hash', 'token_hash']);
  assert.equal(outboxRedactedSql(), "json_type(payload_json,'$.retention_redacted') IS NOT NULL");
  assert.equal(outboxNotRedactedSql('event.payload_json'), "json_type(event.payload_json,'$.retention_redacted') IS NULL");
});

test('the flag is on only when OUTBOX_PII_RETENTION_ENABLED is exactly true', () => {
  for (const value of [undefined, '', '1', 'TRUE', 'yes', 'false']) {
    assert.equal(outboxPiiRetentionEnabled({ OUTBOX_PII_RETENTION_ENABLED: value }), false, String(value));
  }
  assert.equal(outboxPiiRetentionEnabled({ OUTBOX_PII_RETENTION_ENABLED: 'true' }), true);
  assert.equal(outboxPiiRetentionEnabled(null), false);
  assert.equal(outboxPiiRetentionEnabled(), false, 'the process environment is unset in tests');
  process.env.OUTBOX_PII_RETENTION_ENABLED = 'true';
  assert.equal(outboxPiiRetentionEnabled(), true);
});

test('invalid input is rejected before anything is claimed', async () => {
  await assert.rejects(runOutboxPiiRetention(null), /database client is required/);
  for (const limit of [0, 501, 1.5, '5']) {
    await assert.rejects(runOutboxPiiRetention(db, { limit }), /outbox retention limit must be 1-500/);
  }
  await assert.rejects(runOutboxPiiRetention(db, { shouldContinue: 'yes' }), /shouldContinue must be a function/);
  await assert.rejects(runOutboxPiiRetention(db, { now: 'not a time' }), /valid outbox retention time/);
  for (const progress of ['yes', [], 5]) {
    await assert.rejects(runOutboxPiiRetention(db, { progress }), /progress must be an object/);
  }
  // The test-only clock may not run ahead of the database clock: that would
  // widen every window.
  await assert.rejects(runOutboxPiiRetention(db, { now: new Date(Date.now() + DAY) }),
    /cannot be later than the database clock/);
  assert.equal(Number((await db.execute('SELECT COUNT(*) AS c FROM app_logs')).rows[0].c), 0);
  const error = new OutboxEventRedactedError();
  assert.equal(error.code, 'OUTBOX_EVENT_REDACTED');
  assert.equal(error.name, 'OutboxEventRedactedError');
  assert.doesNotMatch(error.message, /@/);
});

// ---------------------------------------------------------------------------
// What is redacted
// ---------------------------------------------------------------------------

test('every event type: contact and credential fields go, ids, status, keys, counts and timestamps stay', async () => {
  const kinds = ['pairing', 'secondaryPairing', 'invitation', 'activation', 'reset', 'schedule', 'secondarySchedule',
    'reminder', 'inviteRequest'];
  const rows = {};
  for (const kind of kinds) rows[kind] = await insertEvent(kind, { status: 'delivered', anchor: ago(8 * DAY) });
  const before = Object.fromEntries(await Promise.all(kinds.map(async kind => [kind, await stored(rows[kind].id)])));

  assert.deepEqual(plain(await run()), { ran: true, redacted: counts({ delivered: 4 }), more: false });

  const after = Object.fromEntries(await Promise.all(kinds.map(async kind => [kind, await stored(rows[kind].id)])));
  assert.deepEqual(after.pairing.payload, { week_id: rows.pairing.payload.week_id, user_id: 2, kind: 'paired', retention_redacted: 1 });
  assert.deepEqual(after.invitation.payload, { invitation_id: rows.invitation.payload.invitation_id, circle_id: 4,
    actor_user_id: 1, send_sequence: 1, template_version: 1, retention_redacted: 1 });
  assert.deepEqual(after.activation.payload, { activation_id: rows.activation.payload.activation_id, retention_redacted: 1 });
  assert.deepEqual(after.reset.payload, { reset_id: rows.reset.payload.reset_id, retention_redacted: 1 });
  for (const kind of ['pairing', 'invitation', 'activation', 'reset']) {
    assert.equal(after[kind].provider_message_id, null, `${kind} provider message id cleared`);
    for (const column of ['event_type', 'event_version', 'idempotency_key', 'status', 'not_before', 'next_attempt_at',
      'attempt_count', 'max_attempts', 'replay_count', 'provider_name', 'last_error_code', 'delivered_at',
      'dead_lettered_at', 'created_at', 'updated_at']) {
      assert.deepEqual(after[kind][column], before[kind][column], `${kind}.${column} is unchanged`);
    }
    assert.doesNotMatch(String(after[kind].payload_json), /@|envelope|_hash/);
  }
  // Producers that never carried contact data are untouched.
  for (const kind of ['secondaryPairing', 'schedule', 'secondarySchedule', 'reminder', 'inviteRequest']) {
    assert.deepEqual(after[kind], before[kind], `${kind} is untouched`);
  }
  // The payload still satisfies the table CHECK (valid JSON object).
  const invalid = await db.execute(`SELECT COUNT(*) AS c FROM outbox_events
    WHERE json_valid(payload_json)=0 OR json_type(payload_json)<>'object'`);
  assert.equal(Number(invalid.rows[0].c), 0);
});

test('windows count from delivered_at, the suppression and dead_lettered_at, each exclusive at ±1 ms', async () => {
  const cases = [
    ['delivered', DELIVERED_CUTOFF - MS, true], ['delivered', DELIVERED_CUTOFF, false], ['delivered', DELIVERED_CUTOFF + MS, false],
    ['suppressed', DELIVERED_CUTOFF - MS, true], ['suppressed', DELIVERED_CUTOFF, false], ['suppressed', DELIVERED_CUTOFF + MS, false],
    ['dead_letter', DEAD_LETTER_CUTOFF - MS, true], ['dead_letter', DEAD_LETTER_CUTOFF, false],
    ['dead_letter', DEAD_LETTER_CUTOFF + MS, false], ['dead_letter', Date.parse(NOW) - 8 * DAY, false],
  ];
  const rows = [];
  for (const [status, anchor, expected] of cases) {
    rows.push({ status, anchor, expected, row: await insertEvent('activation', { status, anchor: at(anchor) }) });
  }
  // Rows whose next_attempt_at is far older than the anchor (a dead letter
  // swept long after its last claim): the window counts from the anchor, and
  // a row exactly on the cutoff stays (`<`, not `<=`).
  for (const [status, cutoffAt] of [['delivered', DELIVERED_CUTOFF], ['suppressed', DELIVERED_CUTOFF],
    ['dead_letter', DEAD_LETTER_CUTOFF]]) {
    for (const [anchor, expected] of [[cutoffAt, false], [cutoffAt - MS, true]]) {
      rows.push({ status, anchor, expected, row: await insertEvent('activation',
        { status, anchor: at(anchor), nextAttemptAt: at(cutoffAt - 20 * DAY) }) });
    }
  }
  const swept = await insertEvent('reset', { status: 'dead_letter', anchor: ago(29 * DAY), nextAttemptAt: ago(45 * DAY) });

  assert.deepEqual(plain(await run({ now: new Date(NOW) })),
    { ran: true, redacted: counts({ delivered: 2, suppressed: 2, dead_letter: 2 }), more: false });
  for (const { status, anchor, expected, row } of rows) {
    const payload = await payloadOf(row.id);
    assert.equal(payload.retention_redacted === 1, expected, `${status} at ${at(anchor)}`);
    assert.equal('recipient_email' in payload, !expected);
  }
  assert.equal((await payloadOf(swept.id)).recipient_email, swept.payload.recipient_email);
});

test('pending, retry and leased rows are never touched, however old', async () => {
  const untouched = [];
  for (const kind of ['pairing', 'invitation', 'activation', 'reset']) {
    for (const status of ['pending', 'retry', 'processing']) {
      untouched.push(await insertEvent(kind, { status, anchor: ago(200 * DAY) }));
    }
  }
  const before = await Promise.all(untouched.map(row => stored(row.id)));
  assert.deepEqual(plain(await run()), { ran: true, redacted: counts(), more: false });
  assert.deepEqual(await Promise.all(untouched.map(row => stored(row.id))), before);
});

test('each class is bounded per run, oldest first, and a rerun is idempotent', async () => {
  const rows = [];
  for (const days of [20, 19, 18, 17, 16]) rows.push(await insertEvent('pairing', { status: 'delivered', anchor: ago(days * DAY) }));
  const redacted = async () => {
    const result = [];
    for (const row of rows) result.push((await payloadOf(row.id)).retention_redacted === 1);
    return result;
  };
  assert.deepEqual(plain(await run({ limit: 2 })), { ran: true, redacted: counts({ delivered: 2 }), more: true });
  assert.deepEqual(await redacted(), [true, true, false, false, false]);
  await anHourPasses();
  assert.deepEqual(plain(await run({ limit: 2 })), { ran: true, redacted: counts({ delivered: 2 }), more: true });
  await anHourPasses();
  assert.deepEqual(plain(await run({ limit: 2 })), { ran: true, redacted: counts({ delivered: 1 }), more: false });
  assert.deepEqual(await redacted(), [true, true, true, true, true]);
  const snapshot = await Promise.all(rows.map(row => stored(row.id)));
  await anHourPasses();
  assert.deepEqual(plain(await run()), { ran: true, redacted: counts(), more: false }, 'rerunning finds nothing');
  assert.deepEqual(await Promise.all(rows.map(row => stored(row.id))), snapshot);
});

test('a caller budget stops new statements between classes', async () => {
  await insertEvent('pairing', { status: 'dead_letter', anchor: ago(40 * DAY) });
  const delivered = await insertEvent('pairing', { status: 'delivered', anchor: ago(10 * DAY) });
  let checks = 0;
  const result = await run({ shouldContinue: () => { checks += 1; return checks <= 1; } });
  assert.deepEqual(plain(result), { ran: true, partial: true, stopped: true, redacted: counts({ dead_letter: 1 }), more: true });
  assert.equal('recipient_email' in await payloadOf(delivered.id), true, 'the delivered class did not start');
});

// ---------------------------------------------------------------------------
// Throttle and concurrency
// ---------------------------------------------------------------------------

test('the hourly claim: a run inside the hour does nothing, a member-written row cannot suppress it', async () => {
  const first = await insertEvent('pairing', { status: 'delivered', anchor: ago(9 * DAY) });
  // Rows a member could cause (client source, or any row with a user id) do
  // not count as a run; each predicate (source and user) is needed on its own.
  await db.execute({ sql: `INSERT INTO app_logs (level,source,event,message,user_id,created_at)
    VALUES ('info','client',?,'forged',7,datetime('now')),('info','server',?,'forged',7,datetime('now')),
      ('info','client',?,'forged',NULL,datetime('now'))`,
  args: [OUTBOX_PII_RETENTION_EVENT, OUTBOX_PII_RETENTION_EVENT, OUTBOX_PII_RETENTION_EVENT] });
  assert.deepEqual(plain(await run()), { ran: true, redacted: counts({ delivered: 1 }), more: false });
  assert.equal((await payloadOf(first.id)).retention_redacted, 1);
  const marker = (await db.execute({ sql: `SELECT level,source,message,user_id FROM app_logs
    WHERE event=? AND source='server' AND user_id IS NULL`, args: [OUTBOX_PII_RETENTION_EVENT] })).rows;
  assert.deepEqual(marker.map(row => [row.level, row.source, row.message, row.user_id]),
    [['info', 'server', 'outbox personal data retention ran', null]]);

  const second = await insertEvent('pairing', { status: 'delivered', anchor: ago(9 * DAY) });
  assert.deepEqual(plain(await run()), { ran: false, redacted: counts(), more: false });
  await db.execute({ sql: `UPDATE app_logs SET created_at=datetime('now','-59 minutes') WHERE event=? AND source='server' AND user_id IS NULL`,
    args: [OUTBOX_PII_RETENTION_EVENT] });
  assert.equal((await run()).ran, false);
  assert.equal('recipient_email' in await payloadOf(second.id), true);
  await db.execute({ sql: `UPDATE app_logs SET created_at=datetime('now','-60 minutes') WHERE event=? AND source='server' AND user_id IS NULL`,
    args: [OUTBOX_PII_RETENTION_EVENT] });
  assert.deepEqual(plain(await run()), { ran: true, redacted: counts({ delivered: 1 }), more: false });
});

test('two concurrent runs on separate connections: one claims, every row is redacted exactly once', async () => {
  const rows = [];
  for (let index = 0; index < 12; index += 1) {
    rows.push(await insertEvent(index % 2 ? 'activation' : 'pairing', { status: 'delivered', anchor: ago((10 + index) * DAY) }));
  }
  const results = await Promise.all([runOutboxPiiRetention(db, { now: NOW }), runOutboxPiiRetention(peer, { now: NOW })]);
  assert.deepEqual(results.map(result => result.ran).sort(), [false, true]);
  assert.equal(results.reduce((sum, result) => sum + result.redacted.delivered, 0), 12);

  // Without the claim, the statements themselves never double-process a row:
  // each candidate subquery runs inside its own write.
  for (let index = 0; index < 12; index += 1) {
    rows.push(await insertEvent('reset', { status: 'delivered', anchor: ago((10 + index) * DAY) }));
  }
  const statement = outboxRedactionStatement({ status: 'delivered', anchor: 'COALESCE(event.delivered_at,event.updated_at)',
    cutoffAt: at(DELIVERED_CUTOFF), now: NOW, limit: 8 });
  const parallel = await Promise.all([db.execute(statement), peer.execute(statement)]);
  assert.equal(parallel.reduce((sum, result) => sum + Number(result.rowsAffected), 0), 12);
  for (const row of rows) assert.deepEqual(Object.keys(await payloadOf(row.id)).includes('recipient_email'), false);
});

// ---------------------------------------------------------------------------
// Invitation resend and the legacy bridge
// ---------------------------------------------------------------------------

async function insertInvitation(id, { expiresAt, usedAt = null, revokedAt = null, ownerId = null }) {
  const circle = (await db.execute({ sql: `INSERT INTO circles (public_id,slug,name,is_primary,created_at)
    VALUES (?,?,?,0,datetime('now')) RETURNING id`, args: [randomUUID(), `retention-${randomUUID()}`, 'Retention'] })).rows[0];
  if (ownerId !== null) {
    await db.execute({ sql: `INSERT INTO circle_memberships (circle_id,user_id,role,status) VALUES (?,?,'owner','active')`,
      args: [Number(circle.id), ownerId] });
  }
  await db.execute({ sql: `INSERT INTO circle_invitations
      (id,circle_id,token_hash,email_hash,created_by,created_at,expires_at,used_at,used_by,revoked_at)
      VALUES (?,?,?,?,1,?,?,?,?,?)`,
  args: [id, Number(circle.id), randomUUID().replaceAll('-', '').padEnd(64, '0'), 'c'.repeat(64), ago(9 * DAY), expiresAt,
    usedAt, usedAt ? 1 : null, revokedAt] });
}

test('an invitation email is kept while its invitation can still be resent', async () => {
  const live = await insertEvent('invitation', { status: 'delivered', anchor: ago(8 * DAY) });
  const expired = await insertEvent('invitation', { status: 'delivered', anchor: ago(8 * DAY) });
  const used = await insertEvent('invitation', { status: 'suppressed', anchor: ago(8 * DAY) });
  const revoked = await insertEvent('invitation', { status: 'dead_letter', anchor: ago(31 * DAY) });
  const missing = await insertEvent('invitation', { status: 'delivered', anchor: ago(8 * DAY) });
  await insertInvitation(live.payload.invitation_id, { expiresAt: ago(-1000) });
  await insertInvitation(expired.payload.invitation_id, { expiresAt: ago(1000) });
  await insertInvitation(used.payload.invitation_id, { expiresAt: ago(-DAY), usedAt: ago(DAY) });
  await insertInvitation(revoked.payload.invitation_id, { expiresAt: ago(-DAY), revokedAt: ago(DAY) });

  assert.deepEqual(plain(await run()), { ran: true, redacted: counts({ delivered: 2, suppressed: 1, dead_letter: 1 }), more: false });
  assert.equal(typeof (await payloadOf(live.id)).credential_envelope, 'string', 'the live invitation keeps its envelope');
  for (const row of [expired, used, revoked, missing]) assert.equal((await payloadOf(row.id)).retention_redacted, 1);

  // Once the invitation can no longer be used, the next run redacts it.
  await db.execute({ sql: 'UPDATE circle_invitations SET revoked_at=? WHERE id=?', args: [NOW, live.payload.invitation_id] });
  await anHourPasses();
  assert.deepEqual(plain(await run()), { ran: true, redacted: counts({ delivered: 1 }), more: false });
  assert.equal((await payloadOf(live.id)).retention_redacted, 1);
});

async function insertLegacy({ status, kind = 'paired', weekId, userId = 2, age, email = `legacy${weekId}@example.test` }) {
  const result = await db.execute({
    sql: `INSERT INTO pairing_email_outbox
      (week_id,user_id,kind,recipient_email,status,attempt_count,sent_at,provider_message_id,last_error,created_at,updated_at)
      VALUES (?,?,?,?,?,1,?,?,?,datetime(?,?),datetime(?,?)) RETURNING id`,
    args: [weekId, userId, kind, email, status, status === 'sent' ? null : null, 'legacy-provider-id',
      status === 'failed' ? `Invalid to field: ${email}` : null, NOW, `-${age} days`, NOW, `-${age} days`],
  });
  return Number(result.rows[0].id);
}

async function legacyRow(id) {
  return (await db.execute({ sql: 'SELECT recipient_email,provider_message_id,last_error,status FROM pairing_email_outbox WHERE id=?', args: [id] })).rows[0];
}

test('legacy pairing rows lose the address once sent or bridged and older than 30 days', async () => {
  const sent = await insertLegacy({ status: 'sent', weekId: 101, age: 120 });
  const bridged = await insertLegacy({ status: 'failed', weekId: 102, age: 120 });
  const unbridged = await insertLegacy({ status: 'pending', weekId: 103, age: 120 });
  const recent = await insertLegacy({ status: 'sent', weekId: 104, age: 29 });
  await enqueueOutboxEvent(db, { eventType: PAIRING_EMAIL_EVENT_TYPE, eventVersion: 1, idempotencyKey: 'randori/102/paired/2',
    payload: { week_id: 102, user_id: 2, kind: 'paired', recipient_email: 'legacy102@example.test' } });

  assert.deepEqual(plain(await run()), { ran: true, redacted: counts({ legacy_pairing: 2 }), more: false });
  for (const id of [sent, bridged]) {
    assert.deepEqual({ ...await legacyRow(id) }, { recipient_email: OUTBOX_LEGACY_REDACTED_EMAIL, provider_message_id: null,
      last_error: null, status: id === sent ? 'sent' : 'failed' });
  }
  assert.equal((await legacyRow(unbridged)).recipient_email, 'legacy103@example.test', 'the bridge still needs it');
  assert.equal((await legacyRow(recent)).recipient_email, 'legacy104@example.test');

  // The bridge neither re-imports a redacted row nor loses the unbridged one.
  assert.equal(await migrateLegacyPairingEmails(db), 1);
  const keys = (await db.execute(`SELECT idempotency_key FROM outbox_events ORDER BY id`)).rows.map(row => row.idempotency_key);
  assert.deepEqual(keys, ['randori/102/paired/2', 'randori/103/paired/2']);
  await anHourPasses();
  assert.deepEqual(plain(await run()), { ran: true, redacted: counts({ legacy_pairing: 1 }), more: false });
  await anHourPasses();
  assert.deepEqual(plain(await run()), { ran: true, redacted: counts(), more: false }, 'rerunning finds nothing');
  const statement = legacyPairingRedactionStatement({ now: NOW, limit: 5 });
  assert.equal(statement.args[0], OUTBOX_LEGACY_REDACTED_EMAIL);
  assert.match(OUTBOX_LEGACY_REDACTED_EMAIL, /\.invalid$/);
});

// ---------------------------------------------------------------------------
// Replay, dedupe, evidence
// ---------------------------------------------------------------------------

test('replaying a redacted dead letter fails cleanly and changes nothing; a recent one still replays', async () => {
  const old = await insertEvent('activation', { status: 'dead_letter', anchor: ago(31 * DAY) });
  const recent = await insertEvent('activation', { status: 'dead_letter', anchor: ago(29 * DAY) });
  await run();
  const before = await stored(old.id);
  assert.equal(before.payload.retention_redacted, 1);
  await assert.rejects(replayDeadLetter(db, { eventId: old.id, operatorUserId: 9, reasonCode: 'OPERATOR_RETRY' }),
    error => error instanceof OutboxEventRedactedError && error.code === 'OUTBOX_EVENT_REDACTED');
  assert.deepEqual(await stored(old.id), before);
  assert.equal(Number((await db.execute({ sql: `SELECT COUNT(*) AS c FROM outbox_audit_events WHERE outbox_event_id=?`,
    args: [old.id] })).rows[0].c), 0, 'no replay audit is written');
  // The guard does not depend on the flag: it still holds after it is turned off.
  process.env.OUTBOX_PII_RETENTION_ENABLED = 'false';
  await assert.rejects(replayDeadLetter(db, { eventId: old.id, operatorUserId: 9, reasonCode: 'OPERATOR_RETRY' }),
    OutboxEventRedactedError);
  assert.equal(await replayDeadLetter(db, { eventId: recent.id, operatorUserId: 9, reasonCode: 'OPERATOR_RETRY' }), true);
  assert.equal((await stored(recent.id)).status, 'pending');
  assert.equal(await replayDeadLetter(db, { eventId: recent.id, operatorUserId: 9, reasonCode: 'OPERATOR_RETRY' }), false,
    'a row that is not dead-lettered is still a plain conflict');
});

function invoke(request) {
  return new Promise((resolve, reject) => {
    let statusCode = 200;
    const headers = {};
    const res = {
      status(code) { statusCode = code; return this; },
      json(body) { resolve({ status: statusCode, headers, body }); return this; },
      setHeader(name, value) { headers[String(name).toLowerCase()] = value; },
      end() { resolve({ status: statusCode, headers, body: null }); return this; },
    };
    Promise.resolve(opsHandler({ headers: {}, query: {}, ...request }, res)).catch(reject);
  });
}

async function insertAdmin() {
  const email = `admin-${randomUUID()}@example.test`;
  const result = await db.execute({ sql: `INSERT INTO auth_accounts (email,password_hash,display_name,color,is_admin,is_demo)
    VALUES (?,'$2b$10$retention','Admin','#123456',1,0) RETURNING id`, args: [email] });
  return Number(result.rows[0].id);
}

test('the admin replay endpoint answers a redacted dead letter with a clear 409 code', async () => {
  const adminId = await insertAdmin();
  sessionPayload = { id: adminId };
  const old = await insertEvent('reset', { status: 'dead_letter', anchor: ago(31 * DAY) });
  const recent = await insertEvent('reset', { status: 'dead_letter', anchor: ago(2 * DAY) });
  await run();
  const replay = eventId => invoke({ method: 'POST', url: '/api/admin/outbox/replay', query: { endpoint: 'outbox-replay' },
    body: { event_id: eventId, reason_code: 'OPERATOR_RETRY' } });
  const refused = await replay(old.id);
  assert.equal(refused.status, 409);
  assert.deepEqual(refused.body, { error: 'event is not replayable: retention removed its recipient details',
    code: 'outbox_event_redacted' });
  assert.doesNotMatch(JSON.stringify(refused.body), /@|reset_id/);
  assert.deepEqual((await replay(recent.id)).body, { ok: true, replayed: true });
  assert.deepEqual((await replay(recent.id)), { status: 409, headers: {}, body: { error: 'event is not replayable' } });
});

test('re-enqueueing a redacted event is still deduplicated and nothing is sent again', async () => {
  const rows = {};
  for (const kind of ['pairing', 'invitation', 'activation', 'reset']) {
    rows[kind] = await insertEvent(kind, { status: 'delivered', anchor: ago(10 * DAY) });
  }
  await run();
  for (const row of Object.values(rows)) {
    const result = await enqueueOutboxEvent(db, { eventType: row.type, eventVersion: row.version,
      idempotencyKey: row.key, payload: row.payload });
    assert.equal(result.created, false, `${row.type} is absorbed by its idempotency key`);
    assert.equal((await stored(row.id)).payload.retention_redacted, 1, 'the redacted payload is not overwritten');
  }
  assert.equal(Number((await db.execute('SELECT COUNT(*) AS c FROM outbox_events')).rows[0].c), 4);
  const sends = [];
  const handler = event => { sends.push(event.id); return { providerMessageId: 'again' }; };
  const worker = await runOutboxWorker({ db, workerId: 'retention-test', heartbeatIntervalMs: 0, leaseDurationMs: 1000,
    handlers: Object.fromEntries(OUTBOX_PII_EVENT_TYPES.map(type => [type, handler])) });
  assert.equal(worker.claimed, 0);
  assert.deepEqual(sends, []);
});

test('primary unavailable evidence survives redaction', async () => {
  const unavailable = await insertEvent('pairingUnavailable', { status: 'delivered', anchor: ago(10 * DAY) });
  await run();
  assert.equal((await payloadOf(unavailable.id)).retention_redacted, 1);
  assert.equal(await hasPrimaryUnavailableEvidence(db, { weekId: unavailable.payload.week_id, userId: 3 }), true);
});

test('health, recent reject reasons, metrics and the admin dead-letter list read the same after redaction', async () => {
  const dead = [
    await insertEvent('activation', { status: 'dead_letter', anchor: ago(40 * DAY) }),
    await insertEvent('invitation', { status: 'dead_letter', anchor: ago(35 * DAY) }),
    await insertEvent('pairing', { status: 'dead_letter', anchor: ago(2 * 60 * 60 * 1000) }),
  ];
  for (const [row, reason] of [[dead[0], '403:validation_error:domain_not_verified'], [dead[1], '422:validation_error:other'],
    [dead[2], '403:validation_error:testing_recipient_restricted']]) {
    await db.execute({ sql: `INSERT INTO outbox_audit_events
      (outbox_event_id,action,actor_type,actor_ref,from_status,to_status,reason_code,attempt_number)
      VALUES (?,'dead_lettered','worker','retention-worker','processing','dead_letter',?,5)`, args: [row.id, reason] });
  }
  // The recent dead letter is inside the health window.
  await db.execute({ sql: `UPDATE outbox_events SET dead_lettered_at=strftime('%Y-%m-%dT%H:%M:%fZ','now','-1 hour') WHERE id=?`,
    args: [dead[2].id] });
  await insertEvent('reset', { status: 'delivered', anchor: ago(9 * DAY) });
  await insertEvent('pairing', { status: 'suppressed', anchor: ago(9 * DAY) });
  await insertEvent('activation', { status: 'pending', anchor: ago(1000) });

  const read = async () => {
    const health = await readOutboxDeliveryHealth(db);
    const diagnostics = await readAdminDiagnostics(db, { env: {}, checkReadiness: async () => ({ ready: true, reason: null }) });
    return {
      health: { ...health, checkedAt: null, oldestDueAgeMs: null },
      metrics: plain(await readOutboxMetrics(db)),
      deadLetters: diagnostics.cards.deadLetters.items.map(item => ({ ...item, ageMs: null, redacted: null })),
      redactedFlags: Object.fromEntries(diagnostics.cards.deadLetters.items.map(item => [item.id, item.redacted])),
      deadLetterTotal: diagnostics.cards.deadLetters.total,
      byType: diagnostics.cards.outbox.byType.map(item => ({ ...item, oldestDueAgeMs: null })),
      rejectReasons: diagnostics.cards.outbox.recentRejectReasons,
    };
  };
  const before = await read();
  assert.deepEqual(before.redactedFlags, { [dead[0].id]: false, [dead[1].id]: false, [dead[2].id]: false });
  assert.deepEqual(plain(await run()), { ran: true, redacted: counts({ delivered: 1, suppressed: 1, dead_letter: 2 }), more: false });
  const afterRedaction = await read();
  // Only the list's `redacted` flag changes, so Replay can be disabled there.
  assert.deepEqual(afterRedaction.redactedFlags, { [dead[0].id]: true, [dead[1].id]: true, [dead[2].id]: false });
  assert.deepEqual({ ...afterRedaction, redactedFlags: null }, { ...before, redactedFlags: null });
  assert.deepEqual(plain(afterRedaction.health.recentRejectReasons), { testing_recipient_restricted: 1 });
  assert.equal(afterRedaction.deadLetters.length, 3);
  assert.deepEqual(afterRedaction.deadLetters.map(item => item.providerReason).sort(),
    ['domain_not_verified', 'other', 'testing_recipient_restricted']);
});

test('redacted dead letters no longer count as actionable envelopes for key rotation', async () => {
  const pending = await insertEvent('reset', { status: 'pending', anchor: ago(1000) });
  const dead = await insertEvent('reset', { status: 'dead_letter', anchor: ago(31 * DAY) });
  await db.execute({ sql: `UPDATE outbox_events SET payload_json=json_set(payload_json,'$.token_envelope','malformed') WHERE id=?`,
    args: [dead.id] });
  const metric = () => readCredentialRotationMetrics(db, { eventType: PASSWORD_RESET_EVENT_TYPE, envelopeField: 'token_envelope', ring: RING });
  const before = await metric();
  assert.equal(before.actionable, 2);
  assert.equal(before.malformed, 1);
  assert.equal(before.ready, false);
  await run();
  const afterRedaction = await metric();
  assert.equal(afterRedaction.actionable, 1);
  assert.equal(afterRedaction.malformed, 0);
  assert.equal(afterRedaction.ready, true);
  assert.equal((await payloadOf(pending.id)).recipient_email, pending.payload.recipient_email);

  // Invitation metrics, actionable branch: a redacted dead letter drops out.
  const invitationDead = await insertEvent('invitation', { status: 'dead_letter', anchor: ago(31 * DAY) });
  await db.execute({ sql: `UPDATE outbox_events SET payload_json=json_set(payload_json,'$.credential_envelope','malformed') WHERE id=?`,
    args: [invitationDead.id] });
  const invitationMetric = () => invitationEmailEnvelopeRotationMetrics(db, { ring: RING });
  assert.equal((await invitationMetric()).malformed, 1);
  await anHourPasses();
  await run();
  const invitationAfter = await invitationMetric();
  assert.equal(invitationAfter.malformed, 0);
  assert.equal(invitationAfter.actionable, 0);

  // Retained branch: the latest delivered email of a live invitation with an
  // active owner counts until it is redacted, and never after.
  const ownerId = await insertAdmin();
  const latest = await insertEvent('invitation', { status: 'delivered', anchor: ago(8 * DAY) });
  const invitationId = latest.payload.invitation_id;
  const liveUntil = new Date(Date.now() + DAY).toISOString(); // live by the database clock and by NOW
  await insertInvitation(invitationId, { expiresAt: liveUntil, ownerId });
  assert.deepEqual([(await invitationMetric()).retained, (await invitationMetric()).malformed], [1, 0]);
  await anHourPasses();
  await run();
  assert.equal(typeof (await payloadOf(latest.id)).credential_envelope, 'string', 'a live invitation is not redacted');
  assert.equal((await invitationMetric()).retained, 1);
  // Once it has expired the next run redacts it ...
  await db.execute({ sql: 'UPDATE circle_invitations SET expires_at=? WHERE id=?', args: [ago(1000), invitationId] });
  await anHourPasses();
  assert.equal((await run()).redacted.delivered, 1);
  assert.equal((await payloadOf(latest.id)).retention_redacted, 1);
  // ... and even if the invitation were live again (clock skew), the redacted
  // row is neither retained nor counted as a malformed envelope.
  await db.execute({ sql: 'UPDATE circle_invitations SET expires_at=? WHERE id=?', args: [liveUntil, invitationId] });
  const skewed = await invitationMetric();
  assert.deepEqual([skewed.retained, skewed.malformed], [0, 0]);
});

// ---------------------------------------------------------------------------
// Scans use existing indexes
// ---------------------------------------------------------------------------

test('the scans use existing indexes, so no DDL is needed', async () => {
  // EXPLAIN runs on its own connection, closed afterwards: libsql can leave an
  // EXPLAIN statement active, which would hold a lock for later tests.
  const explain = createClient({ url });
  try {
    await explainPlans(explain);
  } finally {
    explain.close();
  }
});

async function explainPlans(db) {
  const plan = async statement => (await db.execute({ sql: `EXPLAIN QUERY PLAN ${statement.sql}`, args: statement.args }))
    .rows.map(row => String(row.detail)).join('\n');
  for (const [status, anchor] of [['delivered', 'COALESCE(event.delivered_at,event.updated_at)'], ['suppressed', 'event.updated_at'],
    ['dead_letter', 'COALESCE(event.dead_lettered_at,event.updated_at)']]) {
    const detail = await plan(outboxRedactionStatement({ status, anchor, cutoffAt: at(DELIVERED_CUTOFF), now: NOW, limit: 100 }));
    assert.match(detail, /SEARCH outbox_events USING INTEGER PRIMARY KEY \(rowid=\?\)/, detail);
    assert.match(detail, /SEARCH event USING INDEX idx_outbox_events_dispatch \(status=\? AND next_attempt_at<\?\)/, detail);
    assert.doesNotMatch(detail, /SCAN event\b|TEMP B-TREE/, detail);
    assert.match(detail, /SEARCH invitation USING INDEX sqlite_autoindex_circle_invitations_1 \(id=\?\)/, detail);
  }
  const claim = (await db.execute(`EXPLAIN QUERY PLAN SELECT 1 FROM app_logs WHERE event='${OUTBOX_PII_RETENTION_EVENT}'
    AND source='server' AND user_id IS NULL AND created_at>datetime('now','-60 minutes')`)).rows.map(row => String(row.detail)).join('\n');
  assert.match(claim, /idx_logs_(event|source)_created/);
  // The legacy table no longer grows; its scan is bounded by its size and the
  // bridge check is a unique-key lookup.
  const legacy = await plan(legacyPairingRedactionStatement({ now: NOW, limit: 100 }));
  assert.match(legacy, /SEARCH pairing_email_outbox USING INTEGER PRIMARY KEY \(rowid=\?\)/, legacy);
  assert.match(legacy, /sqlite_autoindex_outbox_events_1 \(idempotency_key=\?\)/, legacy);
}

// ---------------------------------------------------------------------------
// The outbox cron
// ---------------------------------------------------------------------------

function spyingClient(log) {
  const record = statement => log.push(typeof statement === 'string' ? statement : statement.sql);
  return {
    execute(statement) { record(statement); return db.execute(statement); },
    batch(statements, mode) { statements.forEach(record); return db.batch(statements, mode); },
    async transaction(mode) {
      const transaction = await db.transaction(mode);
      return {
        execute(statement) { record(statement); return transaction.execute(statement); },
        commit: () => transaction.commit(), rollback: () => transaction.rollback(), close: () => transaction.close?.(),
      };
    },
  };
}

const FLAG_OFF_METRIC_KEYS = ['app_logs_retention', 'budget_ms', 'claimed', 'deadline_reached', 'key_rotation',
  'legacy_reconciliation_complete', 'logging_complete', 'max_claims', 'metrics_complete', 'types'];

async function cron() {
  return invoke({ method: 'POST', url: '/api/cron/outbox', query: { endpoint: 'outbox' },
    headers: { 'x-cron-secret': CRON_SECRET } });
}

test('flag off: the cron issues no retention SQL and its response shape is unchanged', async () => {
  process.env.APP_URL = 'https://randori.example.test';
  const delivered = await insertEvent('pairing', { status: 'delivered', anchor: ago(40 * DAY) });
  const dead = await insertEvent('activation', { status: 'dead_letter', anchor: ago(40 * DAY) });
  const legacy = await insertLegacy({ status: 'sent', weekId: 301, age: 120 });
  const before = [await stored(delivered.id), await stored(dead.id)];
  for (const flag of [undefined, 'false', '1']) {
    if (flag === undefined) delete process.env.OUTBOX_PII_RETENTION_ENABLED;
    else process.env.OUTBOX_PII_RETENTION_ENABLED = flag;
    const log = [];
    activeClient = spyingClient(log);
    const response = await cron();
    assert.equal(response.status, 200);
    assert.deepEqual(Object.keys(response.body.outbox).sort(), FLAG_OFF_METRIC_KEYS, `flag ${flag}`);
    assert.ok(log.length > 0, 'the spy saw the cron statements');
    for (const sql of log) {
      assert.doesNotMatch(sql, /outbox_pii_retention|outbox personal data retention|json_remove|UPDATE pairing_email_outbox|retention_redacted',1/,
        `flag ${flag}: ${sql.slice(0, 120)}`);
    }
    const logged = JSON.parse((await db.execute(`SELECT meta_json FROM app_logs WHERE event='outbox_invocation'
      ORDER BY id DESC LIMIT 1`)).rows[0].meta_json);
    assert.equal('outbox_pii_retention' in logged, false);
  }
  assert.deepEqual([await stored(delivered.id), await stored(dead.id)], before);
  assert.equal((await legacyRow(legacy)).recipient_email, 'legacy301@example.test');
  assert.equal(Number((await db.execute({ sql: 'SELECT COUNT(*) AS c FROM app_logs WHERE event=?',
    args: [OUTBOX_PII_RETENTION_EVENT] })).rows[0].c), 0);
});

test('flag on: the cron redacts after delivery and reports counts in the response and the invocation row', async () => {
  process.env.APP_URL = 'https://randori.example.test';
  process.env.OUTBOX_PII_RETENTION_ENABLED = 'true';
  const delivered = await insertEvent('pairing', { status: 'delivered', anchor: ago(8 * DAY) });
  const dead = await insertEvent('activation', { status: 'dead_letter', anchor: ago(31 * DAY) });
  await insertLegacy({ status: 'sent', weekId: 302, age: 120 });
  const first = await cron();
  assert.equal(first.status, 200);
  const expected = { ran: true, redacted: counts({ delivered: 1, dead_letter: 1, legacy_pairing: 1 }), more: false };
  assert.deepEqual(first.body.outbox.outbox_pii_retention, expected);
  assert.deepEqual(Object.keys(first.body.outbox).sort(), [...FLAG_OFF_METRIC_KEYS, 'outbox_pii_retention'].sort());
  assert.equal(first.body.outbox.deadline_reached, false);
  const logged = JSON.parse((await db.execute(`SELECT meta_json FROM app_logs WHERE event='outbox_invocation'
    ORDER BY id DESC LIMIT 1`)).rows[0].meta_json);
  assert.deepEqual(logged.outbox_pii_retention, expected);
  assert.equal(await lastInvocationLevel(), 'success', 'a complete retention run keeps the invocation a success');
  assert.doesNotMatch(JSON.stringify(first.body), /@example\.test/);
  for (const id of [delivered.id, dead.id]) assert.equal((await payloadOf(id)).retention_redacted, 1);

  const second = await cron();
  assert.deepEqual(second.body.outbox.outbox_pii_retention, { ran: false, redacted: counts(), more: false }, 'throttled for the hour');
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

test('flag on: skipped when the budget does not fit; a slow or failed run never blocks the cron', async () => {
  process.env.OUTBOX_PII_RETENTION_ENABLED = 'true';
  const req = { headers: {} };
  const tight = await deliverPendingOutbox(db, 'https://randori.example.test', req, performance.now() + 10_000,
    { outboxPiiRetentionBudgetMs: 60_000 });
  assert.equal(tight.metrics.outbox_pii_retention, null);
  assert.equal(Number((await db.execute({ sql: 'SELECT COUNT(*) AS c FROM app_logs WHERE event=?',
    args: [OUTBOX_PII_RETENTION_EVENT] })).rows[0].c), 0);

  let release;
  const stalled = new Promise(resolve => { release = resolve; });
  const slow = await deliverPendingOutbox(wrappedDb(sql => (sql.includes('outbox personal data retention ran')
    ? stalled.then(() => ({ rows: [] })) : null)), 'https://randori.example.test', req, performance.now() + 10_000,
  { outboxPiiRetentionBudgetMs: 50 });
  release();
  assert.deepEqual(slow.metrics.outbox_pii_retention, { ran: false, timed_out: true });
  assert.equal(slow.metrics.deadline_reached, false);
  assert.equal(slow.metrics.metrics_complete, true);
  assert.equal(await lastInvocationLevel(), 'warn', 'a timed-out retention run is a warning');

  const failed = await deliverPendingOutbox(wrappedDb(sql => (sql.includes('outbox personal data retention ran')
    ? Promise.reject(new Error('simulated')) : null)), 'https://randori.example.test', req, performance.now() + 10_000);
  assert.deepEqual(failed.metrics.outbox_pii_retention, { ran: false, failed: true });
  assert.equal(failed.metrics.metrics_complete, true);
  assert.equal(failed.metrics.logging_complete, true);
  assert.equal(await lastInvocationLevel(), 'warn', 'a failed retention run is a warning');

  // A pass still running when its budget ends issues no further statements.
  // The claim answers at once and the first redaction stalls past the budget.
  const redactions = [];
  let releaseUpdate;
  const updateStalled = new Promise(resolve => { releaseUpdate = resolve; });
  const stopping = wrappedDb(sql => {
    if (sql.includes('outbox personal data retention ran')) return Promise.resolve({ rows: [{ id: 1, now_utc: NOW }] });
    if (!sql.includes('UPDATE pairing_email_outbox') && !sql.includes('json_remove')) return null;
    redactions.push(sql);
    return updateStalled.then(() => ({ rows: [], rowsAffected: 1 }));
  });
  const partial = await deliverPendingOutbox(stopping, 'https://randori.example.test', req, performance.now() + 10_000,
    { outboxPiiRetentionBudgetMs: 1_000 });
  assert.deepEqual(partial.metrics.outbox_pii_retention,
    { ran: true, partial: true, timed_out: true, redacted: counts(), more: true });
  releaseUpdate();
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(redactions.length, 1, 'the dead-letter class ran; no class started after the budget');
});


async function lastInvocationLevel() {
  return String((await db.execute(`SELECT level FROM app_logs WHERE event='outbox_invocation'
    ORDER BY id DESC LIMIT 1`)).rows[0]?.level);
}

test('a run that redacts one class and then fails or runs out of budget reports what it committed', async () => {
  process.env.OUTBOX_PII_RETENTION_ENABLED = 'true';
  const req = { headers: {} };
  const dead = await insertEvent('pairing', { status: 'dead_letter', anchor: ago(40 * DAY) });
  const delivered = await insertEvent('pairing', { status: 'delivered', anchor: ago(10 * DAY) });
  // The delivered class (its anchor is delivered_at) fails after the
  // dead-letter class committed.
  const failing = wrappedDb(sql => (sql.includes('json_remove') && sql.includes('event.delivered_at')
    ? Promise.reject(Object.assign(new Error('simulated'), { code: 'SQLITE_BUSY' })) : null));
  const failed = await runOutboxPiiRetention(failing, { now: NOW });
  assert.deepEqual(plain(failed), { ran: true, partial: true, failed: true, failed_class: 'delivered',
    redacted: counts({ dead_letter: 1 }), more: true });
  assert.equal((await payloadOf(dead.id)).retention_redacted, 1);
  assert.equal('recipient_email' in await payloadOf(delivered.id), true);

  // Through the cron: the same report, and the invocation is a warning.
  await anHourPasses();
  const second = await insertEvent('pairing', { status: 'dead_letter', anchor: ago(40 * DAY) });
  const viaCron = await deliverPendingOutbox(failing, 'https://randori.example.test', req, performance.now() + 10_000);
  assert.deepEqual(viaCron.metrics.outbox_pii_retention, { ran: true, partial: true, failed: true,
    failed_class: 'delivered', redacted: counts({ dead_letter: 1 }), more: true });
  assert.equal(await lastInvocationLevel(), 'warn');
  assert.equal((await payloadOf(second.id)).retention_redacted, 1);

  // Budget ends while the delivered class is in flight: the committed
  // dead-letter count is still reported.
  await anHourPasses();
  const third = await insertEvent('pairing', { status: 'dead_letter', anchor: ago(40 * DAY) });
  let releaseDelivered;
  const deliveredStalled = new Promise(resolve => { releaseDelivered = resolve; });
  const stalling = wrappedDb(sql => (sql.includes('json_remove') && sql.includes('event.delivered_at')
    ? deliveredStalled.then(() => ({ rows: [], rowsAffected: 0 })) : null));
  const timedOut = await deliverPendingOutbox(stalling, 'https://randori.example.test', req, performance.now() + 10_000,
    { outboxPiiRetentionBudgetMs: 1_000 });
  releaseDelivered();
  assert.deepEqual(timedOut.metrics.outbox_pii_retention, { ran: true, partial: true, timed_out: true,
    redacted: counts({ dead_letter: 1 }), more: true });
  assert.equal(await lastInvocationLevel(), 'warn');
  assert.equal((await payloadOf(third.id)).retention_redacted, 1);
});

test('every delivery type is either redacted or declared free of personal data', async () => {
  const { OUTBOX_DELIVERY_TYPES } = await import('../../api/_outbox-delivery.js');
  const delivered = OUTBOX_DELIVERY_TYPES.map(({ type }) => type).sort();
  const declared = [...OUTBOX_PII_EVENT_TYPES, ...OUTBOX_PII_FREE_EVENT_TYPES];
  assert.equal(new Set(declared).size, declared.length, 'no type is in both lists');
  assert.deepEqual([...declared].sort(), delivered,
    'a new delivery type must be added to OUTBOX_PII_EVENT_TYPES or OUTBOX_PII_FREE_EVENT_TYPES');
  // A declared-free type really carries no contact field in any payload shape.
  for (const kind of ['secondaryPairing', 'schedule', 'secondarySchedule', 'reminder', 'inviteRequest']) {
    const { payload } = payloadFor(kind);
    for (const field of OUTBOX_PII_FIELDS) assert.equal(field in payload, false, `${kind}.${field}`);
  }
});

test('a terminal row never has next_attempt_at later than its anchor, on every terminal path', async () => {
  const TYPE = 'retention.invariant';
  const enqueue = async (sequenceNumber, maxAttempts = 5) => enqueueOutboxEvent(db, { eventType: TYPE,
    idempotencyKey: `retention-invariant/${sequenceNumber}`, payload: { sequence: sequenceNumber }, maxAttempts });
  const options = { db, workerId: 'invariant-worker', heartbeatIntervalMs: 0, leaseDurationMs: 1000 };
  // delivered, suppressed and a non-retryable dead letter through finalizeOutcome
  for (const sequenceNumber of [1, 2, 3]) await enqueue(sequenceNumber);
  const outcomes = { 1: () => ({ providerMessageId: 'sent' }), 2: () => ({ status: 'suppressed', reasonCode: 'NOT_NEEDED' }),
    3: () => { throw new OutboxDeliveryError('PROVIDER_REJECTED', { retryable: false }); } };
  await runOutboxWorker({ ...options, handlers: { [TYPE]: event => outcomes[event.payload.sequence]() } });
  // an exhausted lease swept to dead_letter after it expires
  await enqueue(4, 1);
  const claimed = await claimOutboxEvent(db, { workerId: 'crashed-worker', leaseDurationMs: 1000, eventType: TYPE });
  assert.equal(claimed.payload.sequence, 4);
  await db.execute({ sql: `UPDATE outbox_events SET leased_until=strftime('%Y-%m-%dT%H:%M:%fZ','now','-1 second') WHERE id=?`,
    args: [claimed.id] });
  await runOutboxWorker({ ...options, handlers: { [TYPE]: () => ({ providerMessageId: 'unused' }) } });
  // a replayed dead letter delivered again
  const rejected = (await db.execute(`SELECT id FROM outbox_events WHERE idempotency_key='retention-invariant/3'`)).rows[0];
  assert.equal(await replayDeadLetter(db, { eventId: Number(rejected.id), operatorUserId: 9, reasonCode: 'OPERATOR_RETRY' }), true);
  await runOutboxWorker({ ...options, handlers: { [TYPE]: () => ({ providerMessageId: 'resent' }) } });
  // a legacy row bridged straight to dead_letter
  await insertLegacy({ status: 'exhausted', weekId: 501, age: 90 });
  assert.equal(await migrateLegacyPairingEmails(db), 1);

  const rows = (await db.execute(`SELECT idempotency_key,status,next_attempt_at,
      CASE status WHEN 'delivered' THEN delivered_at WHEN 'dead_letter' THEN dead_lettered_at ELSE updated_at END AS anchor
    FROM outbox_events ORDER BY id`)).rows;
  assert.deepEqual(rows.map(row => [row.idempotency_key, row.status]), [
    ['retention-invariant/1', 'delivered'], ['retention-invariant/2', 'suppressed'], ['retention-invariant/3', 'delivered'],
    ['retention-invariant/4', 'dead_letter'], ['randori/501/paired/2', 'dead_letter']]);
  for (const row of rows) {
    assert.ok(String(row.anchor).length > 0, `${row.idempotency_key} has an anchor`);
    assert.ok(Date.parse(String(row.next_attempt_at)) <= Date.parse(String(row.anchor).replace(' ', 'T')),
      `${row.idempotency_key}: next_attempt_at ${row.next_attempt_at} <= ${row.anchor}`);
  }
});
