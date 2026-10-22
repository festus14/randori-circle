// Admin diagnostics view (issue #310): card view models, each card's
// stale-data state, snapshot validation and the DOM controller.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import diagnosticsUi, {
  CARD_ORDER,
  REPLAY_REASON_LABELS,
  SMOKE_STATUS_VIEW,
  SNAPSHOT_FORMAT,
  STATUS_VIEW,
  TICK_MS,
  cardView,
  deadLetterSummary,
  evidenceState,
  evidenceText,
  formatDuration,
  formatInstant,
  loadErrorMessage,
  mountAdminDiagnostics,
  normalizeSnapshot,
  replayErrorMessage,
  smokeView,
} from '../../assets/admin-diagnostics.js';

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const fresh = (maxAgeMs, ageMs = 0) => ({ at: '2026-10-20T11:59:00.000Z', ageMs, maxAgeMs, stale: ageMs > maxAgeMs });

const SMOKE_PASSED = Object.freeze({ status: 'passed', category: null, checkedAt: '2026-10-20T09:00:00.000Z',
  languages: { javascript: { status: 'ok', durationMs: 700 }, python: { status: 'ok', durationMs: 800 } }, evidence: fresh(26 * HOUR, 3 * HOUR) });

function snapshot(overrides = {}) {
  const cards = {
    outbox: {
      status: 'healthy', category: null, thresholdMs: 15 * MINUTE, evidence: fresh(15 * MINUTE, 2 * MINUTE),
      totals: { queued: 1, due: 0, leased: 0, staleLeases: 0, deadLetter: 1, deadLetter24h: 1, oldestDueAgeMs: null, oldestStaleLeaseAgeMs: null, lastDeliveredAt: '2026-10-20T11:00:00.000Z' },
      byType: [{ eventType: 'pairing.email.requested', queued: 1, due: 0, leased: 0, staleLeases: 0, retrying: 0, delivered: 4, suppressed: 0, deadLetter: 1, deadLetter24h: 1, oldestDueAgeMs: null },
        { eventType: 'schedule.email.requested', queued: 2, due: 2, leased: 0, deadLetter: 0, deadLetter24h: 0, oldestDueAgeMs: 3 * MINUTE }],
      recentRejectReasons: { domain_not_verified: 1 },
    },
    deadLetters: {
      status: 'degraded', total: 1, limit: 25, replayReasonCodes: Object.keys(REPLAY_REASON_LABELS), evidence: fresh(5 * MINUTE),
      items: [{ id: 41, eventType: 'invitation.email.requested', eventVersion: 1, errorCode: 'PROVIDER_REJECTED', providerReason: 'domain_not_verified', attempts: 5, replays: 0, deadLetteredAt: '2026-10-20T10:00:00.000Z', ageMs: 2 * HOUR }],
    },
    outboxWatchdog: { status: 'deferred', category: 'github_actions_artifact_only', cadenceMs: HOUR, liveEquivalent: 'outbox', evidence: null },
    backupWatchdog: { status: 'deferred', category: 'github_actions_artifact_only', cadenceMs: 8 * DAY, liveEquivalent: 'readiness', evidence: null },
    execution: { status: 'healthy', category: null, provider: 'vercel-sandbox', configured: true, reason: null, recent24h: { success: 3, failed: 0, unavailable: 0 }, lastOutcome: 'success', evidence: fresh(26 * HOUR, HOUR), smoke: SMOKE_PASSED },
    readiness: { status: 'healthy', category: null, ready: true, ledger: { state: 'current', currentVersion: 23, expectedVersion: 23, appliedCount: 23, latest: { version: 23, name: 'invite-requests', appliedAt: '2026-10-19T10:00:00.000Z', disposition: 'applied' }, recent: [] }, evidence: fresh(5 * MINUTE) },
    errors: { status: 'healthy', category: null, windowMs: DAY, totals: { error: 0, warn: 0 }, bySource: {}, categories: [], otherCount: 0, evidence: fresh(HOUR, MINUTE) },
    ...overrides,
  };
  return { ok: true, format: SNAPSHOT_FORMAT, checkedAt: '2026-10-20T12:00:00.000Z', refreshAfterMs: 5 * MINUTE, cards };
}

// ------------------------------------------------------------ minimal DOM

class FakeElement {
  constructor(tag, id = '') {
    this.tagName = tag.toUpperCase();
    this.id = id;
    this.children = [];
    this.dataset = {};
    this.attributes = {};
    this.listeners = {};
    this.hidden = false;
    this.disabled = false;
    this.open = false;
    this.value = '';
    this.className = '';
    this.type = '';
    this.focused = 0;
    this._text = '';
  }
  get textContent() { return this._text + this.children.map(child => child.textContent).join(''); }
  set textContent(value) { this._text = String(value); this.children = []; }
  append(...nodes) { this.children.push(...nodes); }
  appendChild(node) { this.children.push(node); return node; }
  replaceChildren(...nodes) { this.children = nodes; }
  setAttribute(name, value) { this.attributes[name] = String(value); }
  getAttribute(name) { return this.attributes[name] ?? null; }
  addEventListener(type, listener) { (this.listeners[type] ||= []).push(listener); }
  focus() { this.focused += 1; }
  async dispatch(type) {
    for (const listener of this.listeners[type] || []) listener({});
    await settle();
  }
  all(predicate, found = []) {
    for (const child of this.children) {
      if (predicate(child)) found.push(child);
      child.all?.(predicate, found);
    }
    return found;
  }
  byTestId(testid) { return this.all(node => node.dataset?.testid === testid); }
}

const settle = () => new Promise(resolve => setImmediate(resolve));

function fixture({ withReason = true, withLinks = true, withAge = true } = {}) {
  const elements = {
    adminDiagnostics: new FakeElement('details', 'adminDiagnostics'),
    adminDiagnosticsRefresh: new FakeElement('button', 'adminDiagnosticsRefresh'),
    adminDiagnosticsStatus: new FakeElement('span', 'adminDiagnosticsStatus'),
    adminDiagnosticsAge: new FakeElement('p', 'adminDiagnosticsAge'),
    adminDiagnosticsCards: new FakeElement('div', 'adminDiagnosticsCards'),
    adminDeadLetters: new FakeElement('ul', 'adminDeadLetters'),
    adminDeadLettersTitle: new FakeElement('h4', 'adminDeadLettersTitle'),
  };
  elements.adminDiagnostics.hidden = true;
  if (!withAge) delete elements.adminDiagnosticsAge;
  if (withReason) {
    elements.adminReplayReason = new FakeElement('select', 'adminReplayReason');
    elements.adminReplayReason.value = 'OPERATOR_RETRY';
  }
  if (withLinks) {
    elements.adminOpenLogs = new FakeElement('button', 'adminOpenLogs');
    elements.adminOpenDemo = new FakeElement('button', 'adminOpenDemo');
  }
  const doc = {
    getElementById: id => elements[id] || null,
    createElement: tag => new FakeElement(tag),
  };
  return { doc, elements };
}

function harness({ payloads = [snapshot()], enabled = true, confirm = true, replay = async () => ({ ok: true, replayed: true }), ...options } = {}) {
  const { doc, elements } = fixture(options);
  const state = { enabled, now: Date.parse('2026-10-20T12:00:00.000Z'), loads: 0, replays: [], confirms: [], logs: 0, demo: 0, intervals: [] };
  const queue = [...payloads];
  const host = {
    enabled: () => state.enabled,
    load: async () => {
      state.loads += 1;
      const next = queue.length > 1 ? queue.shift() : queue[0];
      if (next instanceof Error || (next && next.http_status)) throw next;
      return typeof next === 'function' ? next() : next;
    },
    replay: async (id, reason) => { state.replays.push([id, reason]); return replay(id, reason); },
    confirm: async (title, message) => { state.confirms.push([title, message]); return typeof confirm === 'function' ? confirm() : confirm; },
    openLogs: () => { state.logs += 1; },
    openDemoTools: () => { state.demo += 1; },
  };
  const controller = mountAdminDiagnostics({
    doc, host, now: () => state.now, setIntervalImpl: (fn, ms) => state.intervals.push([fn, ms]),
  });
  return { controller, elements, state, host };
}

async function openPanel(elements) {
  elements.adminDiagnostics.open = true;
  await elements.adminDiagnostics.dispatch('toggle');
  await settle();
}

const cardNode = (elements, id) => elements.adminDiagnosticsCards.children.find(node => node.dataset.card === id);
const staleBadge = (elements, id) => cardNode(elements, id).byTestId('admin-diagnostics-stale')[0];

// ------------------------------------------------------------ pure helpers

test('the module exposes a frozen API on window-free hosts', () => {
  assert.ok(Object.isFrozen(diagnosticsUi));
  assert.equal(diagnosticsUi.mountAdminDiagnostics, mountAdminDiagnostics);
  assert.deepEqual(CARD_ORDER, ['outbox', 'outboxWatchdog', 'backupWatchdog', 'execution', 'readiness', 'errors']);
  assert.equal(TICK_MS, 30_000);
  assert.deepEqual(Object.keys(REPLAY_REASON_LABELS), ['OPERATOR_RETRY', 'PROVIDER_RECOVERED', 'CONFIGURATION_FIXED']);
});

test('durations and instants format compactly and handle missing values', () => {
  assert.equal(formatDuration(45_000), '45 s');
  assert.equal(formatDuration(12 * MINUTE), '12 min');
  assert.equal(formatDuration(3 * HOUR), '3 h');
  assert.equal(formatDuration(3 * DAY), '3 d');
  for (const value of [null, undefined, -1, 'x']) assert.equal(formatDuration(value), 'unknown');
  assert.equal(formatInstant('2026-10-20T09:15:30.000Z'), '2026-10-20 09:15 UTC');
  for (const value of [null, undefined, '', 'nope']) assert.equal(formatInstant(value), '');
});

test('evidence age adds the time since the snapshot was fetched', () => {
  assert.deepEqual(evidenceState(null), { tracked: false, stale: false, ageMs: null, maxAgeMs: null });
  assert.deepEqual(evidenceState({ ageMs: 4 * MINUTE, maxAgeMs: 5 * MINUTE }), { tracked: true, stale: false, ageMs: 4 * MINUTE, maxAgeMs: 5 * MINUTE });
  assert.equal(evidenceState({ ageMs: 4 * MINUTE, maxAgeMs: 5 * MINUTE }, 2 * MINUTE).stale, true);
  assert.equal(evidenceState({ ageMs: 4 * MINUTE, maxAgeMs: 5 * MINUTE }, -MINUTE).ageMs, 4 * MINUTE, 'clock skew never subtracts');
  assert.equal(evidenceState({ ageMs: 4 * MINUTE, maxAgeMs: 5 * MINUTE }, 'x').ageMs, 4 * MINUTE);
  assert.equal(evidenceState({ ageMs: null, maxAgeMs: 5 * MINUTE }).stale, true);
  assert.equal(evidenceState({ maxAgeMs: 5 * MINUTE }).stale, true);
  assert.equal(evidenceState({ ageMs: 0 }).stale, true, 'an unknown cadence is never presented as fresh');
  assert.equal(evidenceText('outbox', null), '');
  assert.equal(evidenceText('outbox', { ageMs: 2 * MINUTE, maxAgeMs: 15 * MINUTE }), 'Last dispatcher run 2 min ago; expected at least every 15 min.');
  assert.equal(evidenceText('execution', { ageMs: null, maxAgeMs: 26 * HOUR }), 'No run recorded yet; expected at least every 26 h.');
  assert.equal(evidenceText('mystery', { ageMs: 1000, maxAgeMs: MINUTE }), 'Last update 1 s ago; expected at least every 1 min.');
});

test('every card has a stale-data state when its evidence is older than its cadence', () => {
  const cards = snapshot().cards;
  for (const [id, maxAgeMs] of [['outbox', 15 * MINUTE], ['execution', 26 * HOUR], ['readiness', 5 * MINUTE], ['errors', HOUR]]) {
    const card = { ...cards[id], evidence: { at: null, ageMs: maxAgeMs - 1000, maxAgeMs, stale: false } };
    assert.equal(cardView(id, card).stale, false, `${id} fresh`);
    assert.equal(cardView(id, card, 2000).stale, true, `${id} stale once the snapshot ages past the cadence`);
    assert.equal(cardView(id, { ...card, evidence: { ageMs: null, maxAgeMs } }).stale, true, `${id} stale without evidence`);
  }
  for (const id of ['outboxWatchdog', 'backupWatchdog']) {
    const view = cardView(id, cards[id], 365 * DAY);
    assert.deepEqual([view.status, view.stale, view.evidence], ['deferred', false, ''], `${id} has no evidence to age`);
  }
});

test('outbox card copy follows the delivery verdict and lists provider rejects', () => {
  const card = snapshot().cards.outbox;
  const healthy = cardView('outbox', card);
  assert.deepEqual([healthy.title, healthy.label, healthy.tone], ['Outbox delivery', 'Healthy', 'success']);
  assert.equal(healthy.lines[0], 'Nothing due is older than 15 minutes.');
  assert.equal(healthy.lines[1], '0 due · 0 leased · 0 expired leases · 1 dead-lettered in 24 h.');
  assert.equal(healthy.lines[2], 'Last delivery 2026-10-20 11:00 UTC.');
  assert.equal(healthy.lines[3], 'Provider rejects in 24 h: domain_not_verified ×1.');
  assert.equal(healthy.evidence, 'Last dispatcher run 2 min ago; expected at least every 15 min.');
  const failing = cardView('outbox', { ...card, status: 'failed', category: 'delivery_stale', recentRejectReasons: {},
    totals: { ...card.totals, due: 3, oldestDueAgeMs: 20 * MINUTE, staleLeases: 1, lastDeliveredAt: null } });
  assert.deepEqual([failing.label, failing.tone], ['Failed', 'danger']);
  assert.match(failing.lines[0], /longer than the 15-minute threshold/);
  assert.equal(failing.lines[1], '3 due (oldest 20 min) · 0 leased · 1 expired lease · 1 dead-lettered in 24 h.');
  assert.equal(failing.lines[2], 'No delivery recorded yet.');
  assert.equal(failing.lines.length, 3);
  for (const category of ['lease_stale', 'dead_letters_recent', 'delivery_backlog']) {
    assert.notEqual(cardView('outbox', { ...card, status: 'degraded', category }).lines[0], 'Delivery needs attention.');
  }
  assert.equal(cardView('outbox', { ...card, status: 'degraded', category: 'new_category' }).lines[0], 'Delivery needs attention.');
  assert.equal(cardView('outbox', { status: 'healthy' }).lines[1], '0 due · 0 leased · 0 expired leases · 0 dead-lettered in 24 h.');
});

test('watchdog cards are deferred and explain why', () => {
  const { outboxWatchdog, backupWatchdog } = snapshot().cards;
  const outbox = cardView('outboxWatchdog', outboxWatchdog);
  assert.deepEqual([outbox.label, outbox.tone], ['Deferred', 'info']);
  assert.match(outbox.lines.join(' '), /GitHub Actions artifact.*GitHub token.*15-minute threshold/s);
  assert.equal(outbox.lines.at(-1), 'Expected cadence: every 60 min.');
  const backup = cardView('backupWatchdog', backupWatchdog);
  assert.match(backup.lines.join(' '), /protected GitHub Actions runs.*Readiness and the migration ledger/s);
  assert.equal(backup.lines.at(-1), 'Expected cadence: every 8 d.');
  assert.equal(cardView('somethingElse', { status: 'deferred' }).lines[0], 'Not available yet.');
});

test('execution card shows the provider state and the latest smoke check', () => {
  const card = snapshot().cards.execution;
  const ok = cardView('execution', card);
  assert.deepEqual(ok.lines, ['Provider: vercel-sandbox.', 'Last 24 h: 3 succeeded, 0 failed, 0 unavailable.',
    'Latest run: success.']);
  assert.deepEqual({ ...ok.smoke }, { status: 'passed', label: 'Passed', tone: 'success', stale: false,
    lines: ['JavaScript: ok · Python: ok.'], evidence: 'Last smoke result 3 h ago; expected at least every 26 h.' });
  assert.equal(cardView('outbox', { ...snapshot().cards.outbox, smoke: SMOKE_PASSED }).smoke, null, 'only the execution card has one');
  assert.equal(cardView('execution', { ...card, smoke: undefined }).smoke, null);
  // A failed execution read still shows the separately read smoke result.
  const unreadable = cardView('execution', { status: 'unavailable', category: 'read_failed', evidence: fresh(26 * HOUR, null), smoke: SMOKE_PASSED });
  assert.deepEqual([unreadable.status, unreadable.lines, unreadable.smoke.status], ['unavailable', ['This source could not be read. Try Refresh.'], 'passed']);
  assert.equal(cardView('execution', { ...card, configured: true, provider: null }).lines[0], 'Provider: unknown.');
  assert.match(cardView('execution', { ...card, status: 'failed', configured: false, reason: 'not_set', provider: null }).lines[0], /No execution provider is configured/);
  assert.match(cardView('execution', { ...card, status: 'failed', configured: false, reason: 'unsupported' }).lines[0], /not supported/);
  assert.equal(cardView('execution', { ...card, status: 'failed', configured: false, reason: 'misconfigured', provider: 'piston' }).lines[0],
    'Provider piston has no valid endpoint, so Run is unavailable.');
  assert.equal(cardView('execution', { ...card, status: 'failed', configured: false, reason: 'misconfigured', provider: null }).lines[0],
    'Provider  has no valid endpoint, so Run is unavailable.');
  const unknown = cardView('execution', { status: 'unknown', configured: true, provider: 'piston', lastOutcome: null });
  assert.deepEqual([unknown.label, unknown.tone, unknown.lines[1], unknown.lines[2]],
    ['No data', 'neutral', 'Last 24 h: 0 succeeded, 0 failed, 0 unavailable.', 'No runs recorded yet.']);
});

test('the smoke check view covers every status, language outcome and age', () => {
  assert.equal(smokeView(null), null);
  assert.deepEqual(Object.keys(SMOKE_STATUS_VIEW), ['passed', 'failed', 'pending', 'none', 'unavailable']);
  const failed = smokeView({ status: 'failed', checkedAt: '2026-10-20T11:00:00.000Z', evidence: fresh(26 * HOUR, HOUR),
    languages: { javascript: { status: 'provider_error' }, python: { status: 'timeout' } } });
  assert.deepEqual([failed.label, failed.tone, failed.lines], ['Failed', 'danger', ['JavaScript: provider error · Python: timed out.']]);
  const lines = languages => smokeView({ status: 'failed', languages, evidence: fresh(26 * HOUR) }).lines[0];
  assert.equal(lines({ javascript: { status: 'misconfigured' }, python: { status: 'result_missing' } }), 'JavaScript: misconfigured · Python: no result saved.');
  assert.equal(lines({ javascript: { status: 'stdout: secret' }, python: 'ok' }), 'JavaScript: unknown · Python: unknown.', 'never echoes server text');
  assert.equal(lines(null), 'JavaScript: unknown · Python: unknown.');
  // No saved result: the age is the run's start.
  const pending = smokeView({ status: 'pending', checkedAt: null, evidence: fresh(26 * HOUR, 30 * 1000),
    languages: { javascript: { status: 'pending' }, python: { status: 'pending' } } });
  assert.deepEqual([pending.label, pending.tone, pending.lines[0], pending.evidence],
    ['Running', 'info', 'JavaScript: running · Python: running.', 'Last smoke run started 30 s ago; expected at least every 26 h.']);
  const missing = smokeView({ status: 'failed', checkedAt: null, evidence: fresh(26 * HOUR, 30 * HOUR),
    languages: { javascript: { status: 'result_missing' }, python: { status: 'result_missing' } } });
  assert.deepEqual([missing.stale, missing.evidence], [true, 'Last smoke run started 30 h ago; expected at least every 26 h.']);
  const none = smokeView({ status: 'none', checkedAt: null, languages: null, evidence: { at: null, ageMs: null, maxAgeMs: 26 * HOUR, stale: true } });
  assert.deepEqual([none.label, none.tone, none.stale, none.lines, none.evidence],
    ['No data', 'neutral', true, [], 'No smoke run recorded yet; expected at least every 26 h.']);
  for (const smoke of [{ status: 'unavailable', category: 'read_failed', evidence: { at: null, ageMs: null, maxAgeMs: 26 * HOUR, stale: true } }, { status: 'deferred' }]) {
    const view = smokeView(smoke);
    assert.deepEqual([view.status, view.label, view.tone, view.stale, view.lines, view.evidence],
      ['unavailable', 'Unavailable', 'danger', true, ['The latest smoke result could not be read. Try Refresh.'], '']);
  }
  // The age keeps counting after the snapshot was fetched.
  const later = smokeView(SMOKE_PASSED, 24 * HOUR);
  assert.deepEqual([later.stale, later.evidence], [true, 'Last smoke result 27 h ago; expected at least every 26 h.']);
});

test('readiness card summarises the check and every ledger state', () => {
  const card = snapshot().cards.readiness;
  assert.deepEqual(cardView('readiness', card).lines, ['The readiness check passes.', 'Migration ledger: v23 of v23 (current).',
    'Latest: v23 invite-requests, applied 2026-10-19 10:00 UTC.']);
  const lines = (ledger, extra = {}) => cardView('readiness', { ...card, status: 'failed', ready: false, ...extra, ledger: { ...card.ledger, latest: null, ...ledger } }).lines;
  assert.deepEqual(lines({ state: 'behind', currentVersion: 21 }, { category: 'ledger_behind' }),
    ['The readiness check fails.', 'Migration ledger: v21 of v23; 2 migrations pending.']);
  assert.equal(lines({ state: 'behind', currentVersion: 22 })[1], 'Migration ledger: v22 of v23; 1 migration pending.');
  assert.equal(lines({ state: 'ahead', currentVersion: 24 })[1], 'The database schema (v24) is newer than this app (v23).');
  assert.equal(lines({ state: 'missing' })[1], 'The migration ledger is missing.');
  assert.equal(lines({ state: 'invalid' })[1], 'The migration ledger does not match the reviewed manifest.');
  assert.equal(lines({}, { category: 'unconfigured' })[0], 'Readiness is not configured for this database.');
  assert.equal(lines({}, { category: 'check_failed' })[0], 'The readiness check could not run.');
  assert.deepEqual(cardView('readiness', { status: 'failed', ready: false }).lines, ['The readiness check fails.']);
  assert.equal(cardView('readiness', { ...card, ledger: { ...card.ledger, latest: { version: 3 } } }).lines[2], 'Latest: v3 ,.');
});

test('errors card shows totals, sources and the biggest categories', () => {
  const view = cardView('errors', { ...snapshot().cards.errors, status: 'degraded',
    totals: { error: 1, warn: 6 },
    bySource: { server: { error: 1, warn: 0 }, client: { error: 0, warn: 5 }, runner: { error: 0, warn: 0 }, other: { error: 0, warn: 1 } },
    categories: Array.from({ length: 6 }, (_, index) => ({ source: 'client', event: `event_${index}`, level: 'warn', count: 6 - index })),
    otherCount: 4 });
  assert.equal(view.lines[0], 'Last 24 h: 1 error, 6 warnings.');
  assert.equal(view.lines[1], 'Server 1 · Client 5 · Runner 0 · Other 1.');
  assert.equal(view.lines[2], 'client · event_0 · warn ×6');
  assert.equal(view.lines.length, 2 + 5 + 1);
  assert.equal(view.lines.at(-1), '4 more in smaller categories.');
  const quiet = cardView('errors', { status: 'healthy' });
  assert.deepEqual(quiet.lines, ['Last 24 h: 0 errors, 0 warnings.', 'Server 0 · Client 0 · Runner 0.']);
});

test('unreadable or unknown cards render as unavailable', () => {
  for (const card of [null, { status: 'exploded' }, { status: 'unavailable', evidence: { ageMs: null, maxAgeMs: 1 } }]) {
    const view = cardView('outbox', card);
    assert.deepEqual([view.status, view.label, view.tone, view.evidence], ['unavailable', 'Unavailable', 'danger', '']);
    assert.deepEqual(view.lines, ['This source could not be read. Try Refresh.']);
  }
  assert.deepEqual(cardView('custom', { status: 'healthy' }).lines, []);
  assert.equal(cardView('custom', { status: 'healthy' }).title, 'custom');
  assert.deepEqual(Object.keys(STATUS_VIEW), ['healthy', 'degraded', 'failed', 'unknown', 'unavailable', 'deferred']);
});

test('snapshots are validated before anything renders', () => {
  const valid = normalizeSnapshot(snapshot());
  assert.equal(valid.checkedAt, '2026-10-20T12:00:00.000Z');
  assert.equal(valid.refreshAfterMs, 5 * MINUTE);
  assert.equal(valid.outboxTypes.length, 2);
  assert.deepEqual(valid.deadLetters.items[0], { id: 41, eventType: 'invitation.email.requested', eventVersion: 1,
    errorCode: 'PROVIDER_REJECTED', providerReason: 'domain_not_verified', attempts: 5, replays: 0, ageMs: 2 * HOUR });
  const base = snapshot();
  for (const bad of [null, [], { ...base, ok: false }, { ...base, format: 'other' }, { ...base, checkedAt: 'nope' },
    { ...base, cards: null }, { ...base, cards: { ...base.cards, readiness: { status: 'odd' } } },
    { ...base, cards: { ...base.cards, errors: undefined } }, { ...base, cards: { ...base.cards, deadLetters: null } },
    { ...base, cards: { ...base.cards, deadLetters: { status: 'odd' } } }]) {
    assert.equal(normalizeSnapshot(bad), null, JSON.stringify(bad)?.slice(0, 80));
  }
  const loose = normalizeSnapshot({ ...base, refreshAfterMs: -1, cards: { ...base.cards,
    outbox: { status: 'healthy', byType: 'nope' },
    deadLetters: { status: 'healthy', total: 'x', items: [null, { id: 0, eventType: 'a.b' }, { id: 2 }, { id: 3, eventType: 'a.b', errorCode: 5, providerReason: 7, ageMs: undefined }] } } });
  assert.equal(loose.refreshAfterMs, 5 * MINUTE);
  assert.deepEqual(loose.outboxTypes, []);
  assert.equal(loose.deadLetters.total, 0);
  assert.deepEqual(loose.deadLetters.items, [{ id: 3, eventType: 'a.b', eventVersion: 0, errorCode: null, providerReason: null, attempts: 0, replays: 0, ageMs: null }]);
  assert.deepEqual(normalizeSnapshot({ ...base, cards: { ...base.cards, deadLetters: { status: 'healthy' } } }).deadLetters.items, []);
});

test('error and summary copy is specific and never echoes server text', () => {
  assert.match(loadErrorMessage({ http_status: 403, error: 'secret detail' }), /Only global administrators/);
  assert.match(loadErrorMessage({ http_status: 401 }), /Only global administrators/);
  assert.equal(loadErrorMessage({ http_status: 404 }), 'Diagnostics are turned off.');
  assert.match(loadErrorMessage({ invalid: true }), /unexpected response/);
  assert.match(loadErrorMessage(new Error('boom')), /unavailable right now/);
  assert.equal(replayErrorMessage({ http_status: 409 }, 7), 'Event #7 is no longer dead-lettered.');
  assert.match(replayErrorMessage({ http_status: 403 }, 7), /Only global administrators/);
  assert.match(replayErrorMessage({ http_status: 401 }, 7), /Only global administrators/);
  assert.match(replayErrorMessage({ http_status: 400 }, 7), /rejected/);
  assert.match(replayErrorMessage(null, 7), /Replay failed/);
  assert.equal(deadLetterSummary({ ageMs: 2 * HOUR, attempts: 1, replays: 0, providerReason: null }), 'Dead-lettered 2 h ago · 1 attempt · replayed 0×');
  assert.equal(deadLetterSummary({ ageMs: null, attempts: 5, replays: 2, providerReason: 'quota_exceeded' }), 'Dead-lettered · 5 attempts · replayed 2× · provider: quota_exceeded');
});

// ------------------------------------------------------------ controller

test('the controller is a no-op without its markup', () => {
  const controller = mountAdminDiagnostics({ doc: { getElementById: () => null, createElement: tag => new FakeElement(tag) }, host: {} });
  assert.doesNotThrow(() => { controller.sync(); controller.tick(); controller.reset(); });
  return controller.refresh();
});

test('the disclosure stays hidden and makes no request unless the host allows it', async () => {
  const { controller, elements, state } = harness({ enabled: false });
  assert.equal(elements.adminDiagnostics.hidden, true);
  await openPanel(elements);
  await controller.refresh();
  assert.equal(state.loads, 0);
  state.enabled = true;
  controller.sync();
  assert.equal(elements.adminDiagnostics.hidden, false);
  await settle();
  assert.equal(state.loads, 1, 'an already open disclosure loads once it becomes allowed');
  assert.deepEqual(state.intervals.map(([, ms]) => ms), [TICK_MS]);
});

test('opening the disclosure loads and renders every card and the dead letters', async () => {
  const { elements, state } = harness();
  assert.equal(elements.adminDiagnostics.hidden, false);
  assert.equal(state.loads, 0, 'nothing loads until the disclosure opens');
  await openPanel(elements);
  assert.equal(state.loads, 1);
  await openPanel(elements);
  assert.equal(state.loads, 1, 'reopening keeps the snapshot');
  const cards = elements.adminDiagnosticsCards.children;
  assert.deepEqual(cards.map(node => node.dataset.card), CARD_ORDER);
  assert.deepEqual(cards.map(node => node.dataset.status), ['healthy', 'deferred', 'deferred', 'healthy', 'healthy', 'healthy']);
  assert.ok(cards.every(node => node.dataset.stale === 'false'));
  assert.equal(cardNode(elements, 'outbox').getAttribute('aria-labelledby'), 'adminDiagCard-outbox');
  const table = cardNode(elements, 'outbox').byTestId('admin-outbox-types')[0];
  assert.match(table.textContent, /pairing\.email\.requested1001 \/ 1—/);
  assert.match(table.textContent, /schedule\.email\.requested2200 \/ 03 min/);
  const region = cardNode(elements, 'outbox').all(node => node.attributes?.role === 'region')[0];
  assert.deepEqual([region.attributes.tabindex, region.attributes['aria-label']], ['0', 'Outbox by event type']);
  const badges = cardNode(elements, 'outbox').byTestId('admin-diagnostics-card-status');
  assert.deepEqual([badges[0].textContent, badges[0].dataset.tone], ['Healthy', 'success']);
  assert.equal(cardNode(elements, 'errors').byTestId('admin-diagnostics-card-status')[0].dataset.tone, 'success');
  const rows = elements.adminDeadLetters.byTestId('admin-dead-letter');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].dataset.eventId, '41');
  assert.match(rows[0].textContent, /#41 invitation\.email\.requested v1PROVIDER_REJECTEDDead-lettered 2 h ago · 5 attempts · replayed 0× · provider: domain_not_verified/);
  assert.equal(rows[0].byTestId('admin-dead-letter-replay')[0].getAttribute('aria-label'), 'Replay event #41');
  assert.equal(elements.adminDiagnosticsStatus.textContent, 'Diagnostics updated.');
  assert.equal(elements.adminDiagnosticsAge.textContent, 'Checked 2026-10-20 12:00 UTC.');
  assert.equal(elements.adminDiagnostics.getAttribute('aria-busy'), 'false');
});

test('stale badges and the snapshot notice update in place as time passes', async () => {
  const { controller, elements, state } = harness();
  await openPanel(elements);
  const outbox = cardNode(elements, 'outbox');
  const replayButton = elements.adminDeadLetters.byTestId('admin-dead-letter-replay')[0];
  assert.equal(staleBadge(elements, 'readiness').hidden, true);
  state.now += 6 * MINUTE;
  for (const [fn] of state.intervals) fn();
  assert.equal(cardNode(elements, 'outbox'), outbox, 'cards are not rebuilt, so focus is kept');
  assert.equal(elements.adminDeadLetters.byTestId('admin-dead-letter-replay')[0], replayButton);
  assert.equal(staleBadge(elements, 'readiness').hidden, false);
  assert.equal(cardNode(elements, 'readiness').dataset.stale, 'true');
  assert.equal(staleBadge(elements, 'outbox').hidden, true, '2 + 6 minutes is inside the 15-minute cadence');
  assert.equal(elements.adminDiagnostics.dataset.stale, 'true');
  assert.equal(elements.adminDiagnosticsStatus.textContent, 'This snapshot is out of date. Refresh for current data.');
  assert.equal(elements.adminDiagnosticsAge.textContent, 'Checked 2026-10-20 12:00 UTC · 6 min ago.');
  state.now += 10 * MINUTE;
  controller.tick();
  assert.equal(staleBadge(elements, 'outbox').hidden, false);
  assert.match(cardNode(elements, 'outbox').all(node => node.className.includes('admin-diag-evidence'))[0].textContent, /18 min ago/);
  assert.equal(staleBadge(elements, 'outboxWatchdog').hidden, true, 'deferred cards never go stale');
  await elements.adminDiagnosticsRefresh.dispatch('click');
  assert.equal(state.loads, 2);
  assert.equal(staleBadge(elements, 'readiness').hidden, true);
  assert.equal(elements.adminDiagnostics.dataset.stale, 'false');
});

test('the execution card renders the smoke check with its own badges and updates its age in place', async () => {
  const { controller, elements, state } = harness();
  await openPanel(elements);
  const execution = cardNode(elements, 'execution');
  const head = execution.byTestId('admin-diagnostics-smoke')[0];
  assert.deepEqual([head.className, head.dataset.status, head.dataset.stale], ['admin-diag-card-head', 'passed', 'false']);
  const status = execution.byTestId('admin-diagnostics-smoke-status')[0];
  assert.deepEqual([status.className, status.textContent, status.dataset.tone], ['rc-badge', 'Passed', 'success']);
  const stale = execution.byTestId('admin-diagnostics-smoke-stale')[0];
  assert.deepEqual([stale.textContent, stale.hidden], ['Stale', true]);
  assert.match(execution.textContent, /Provider smoke checkPassedStaleJavaScript: ok · Python: ok\./);
  const age = execution.byTestId('admin-diagnostics-smoke-evidence')[0];
  assert.equal(age.textContent, 'Last smoke result 3 h ago; expected at least every 26 h.');
  assert.equal(execution.byTestId('admin-diagnostics-smoke').length, 1);
  assert.equal(cardNode(elements, 'outbox').byTestId('admin-diagnostics-smoke').length, 0);
  // 3 h + 24 h is past the 26-hour cadence; the nodes are updated, not rebuilt.
  state.now += 24 * HOUR;
  controller.tick();
  assert.equal(cardNode(elements, 'execution').byTestId('admin-diagnostics-smoke-evidence')[0], age);
  assert.deepEqual([head.dataset.stale, stale.hidden, age.textContent],
    ['true', false, 'Last smoke result 27 h ago; expected at least every 26 h.']);
  controller.tick();
  assert.equal(age.textContent, 'Last smoke result 27 h ago; expected at least every 26 h.');
});

test('an unreadable smoke result or execution read fails in isolation', async () => {
  const unavailableSmoke = { status: 'unavailable', category: 'read_failed', checkedAt: null, languages: null,
    evidence: { at: null, ageMs: null, maxAgeMs: 26 * HOUR, stale: true } };
  const { elements } = harness({ payloads: [snapshot({
    execution: { ...snapshot().cards.execution, smoke: unavailableSmoke },
  })] });
  await openPanel(elements);
  let execution = cardNode(elements, 'execution');
  assert.equal(execution.dataset.status, 'healthy');
  assert.equal(execution.dataset.stale, 'false');
  assert.equal(execution.byTestId('admin-diagnostics-smoke')[0].dataset.status, 'unavailable');
  assert.equal(execution.byTestId('admin-diagnostics-smoke-stale')[0].hidden, false);
  assert.match(execution.textContent, /The latest smoke result could not be read\. Try Refresh\./);
  assert.equal(execution.byTestId('admin-diagnostics-smoke-evidence')[0].hidden, true);

  const other = harness({ payloads: [snapshot({
    execution: { status: 'unavailable', category: 'read_failed', evidence: { at: null, ageMs: null, maxAgeMs: 26 * HOUR, stale: true }, smoke: SMOKE_PASSED },
  })] });
  await openPanel(other.elements);
  execution = cardNode(other.elements, 'execution');
  assert.equal(execution.dataset.status, 'unavailable');
  assert.match(execution.textContent, /This source could not be read\. Try Refresh\..*Provider smoke checkPassed/);
  assert.equal(execution.byTestId('admin-diagnostics-smoke-stale')[0].hidden, true);
});

test('cards whose evidence is already stale render the Stale badge immediately', async () => {
  const stale = snapshot({
    outbox: { ...snapshot().cards.outbox, evidence: { at: null, ageMs: null, maxAgeMs: 15 * MINUTE, stale: true } },
    errors: { status: 'unavailable', category: 'read_failed', evidence: { at: null, ageMs: null, maxAgeMs: HOUR, stale: true } },
  });
  const { elements } = harness({ payloads: [stale] });
  await openPanel(elements);
  assert.equal(staleBadge(elements, 'outbox').hidden, false);
  assert.match(cardNode(elements, 'outbox').textContent, /No dispatcher run recorded yet/);
  assert.equal(cardNode(elements, 'errors').dataset.status, 'unavailable');
  assert.equal(staleBadge(elements, 'errors').hidden, false);
  const evidenceNode = cardNode(elements, 'errors').all(node => node.className.includes('admin-diag-evidence'))[0];
  assert.equal(evidenceNode.hidden, true, 'unavailable cards show no evidence line');
});

test('a failed or malformed load clears the view and explains why', async () => {
  for (const [payload, message] of [
    [{ http_status: 403 }, 'Only global administrators can view diagnostics.'],
    [{ http_status: 404 }, 'Diagnostics are turned off.'],
    [{ ok: true, format: 'wrong' }, 'Diagnostics returned an unexpected response. Try Refresh.'],
    [new Error('network'), 'Diagnostics are unavailable right now. Try Refresh.'],
  ]) {
    const { elements } = harness({ payloads: [snapshot(), payload] });
    await openPanel(elements);
    assert.equal(elements.adminDiagnosticsCards.children.length, 6);
    await elements.adminDiagnosticsRefresh.dispatch('click');
    assert.equal(elements.adminDiagnosticsCards.children.length, 0);
    assert.equal(elements.adminDeadLetters.children.length, 0);
    assert.equal(elements.adminDiagnosticsStatus.textContent, message);
    assert.equal(elements.adminDiagnosticsRefresh.disabled, false);
  }
});

test('replay asks for confirmation and does nothing when cancelled', async () => {
  const { elements, state } = harness({ confirm: false });
  await openPanel(elements);
  elements.adminReplayReason.value = 'PROVIDER_RECOVERED';
  await elements.adminDeadLetters.byTestId('admin-dead-letter-replay')[0].dispatch('click');
  assert.equal(state.confirms.length, 1);
  assert.equal(state.confirms[0][0], 'Replay dead letter #41?');
  assert.equal(state.confirms[0][1], 'invitation.email.requested goes back to the delivery queue with the reason “Provider recovered”. The replay is audited under your account.');
  assert.deepEqual(state.replays, []);
  assert.equal(elements.adminDiagnosticsStatus.textContent, 'Replay cancelled. Nothing changed.');
});

test('a confirmed replay uses the selected reason, reloads and keeps focus in the list', async () => {
  const after = snapshot({ deadLetters: { status: 'healthy', total: 0, items: [], evidence: fresh(5 * MINUTE) } });
  const { elements, state } = harness({ payloads: [snapshot(), after] });
  await openPanel(elements);
  elements.adminReplayReason.value = 'CONFIGURATION_FIXED';
  await elements.adminDeadLetters.byTestId('admin-dead-letter-replay')[0].dispatch('click');
  await settle();
  assert.deepEqual(state.replays, [[41, 'CONFIGURATION_FIXED']]);
  assert.equal(state.loads, 2);
  assert.equal(elements.adminDeadLetters.byTestId('admin-dead-letter').length, 0);
  assert.equal(elements.adminDeadLetters.textContent, 'No dead letters.');
  assert.equal(elements.adminDiagnosticsStatus.textContent, 'Event #41 is queued for delivery again. Diagnostics updated.');
  assert.equal(elements.adminDeadLettersTitle.focused, 1);
  await elements.adminDiagnosticsRefresh.dispatch('click');
  assert.equal(elements.adminDiagnosticsStatus.textContent, 'Diagnostics updated.', 'a manual refresh clears the notice');
});

test('an unknown reason falls back to operator retry', async () => {
  const { elements, state } = harness({ withReason: false });
  await openPanel(elements);
  await elements.adminDeadLetters.byTestId('admin-dead-letter-replay')[0].dispatch('click');
  await settle();
  assert.deepEqual(state.replays, [[41, 'OPERATOR_RETRY']]);
});

test('a replay conflict refreshes the list; other failures keep the row for a retry', async () => {
  const conflict = harness({ replay: async () => { throw { http_status: 409 }; } });
  await openPanel(conflict.elements);
  await conflict.elements.adminDeadLetters.byTestId('admin-dead-letter-replay')[0].dispatch('click');
  await settle();
  assert.equal(conflict.state.loads, 2);
  assert.equal(conflict.elements.adminDiagnosticsStatus.textContent, 'Event #41 is no longer dead-lettered. Diagnostics updated.');
  assert.equal(conflict.elements.adminDeadLettersTitle.focused, 1);

  const failure = harness({ replay: async () => { throw { http_status: 503 }; } });
  await openPanel(failure.elements);
  const button = failure.elements.adminDeadLetters.byTestId('admin-dead-letter-replay')[0];
  await button.dispatch('click');
  assert.equal(failure.state.loads, 1);
  assert.equal(button.disabled, false);
  assert.equal(failure.elements.adminDiagnosticsStatus.textContent, 'Replay failed. Nothing changed; try again.');
});

test('replay is ignored while a load is pending or once access is withdrawn', async () => {
  let release;
  const slow = () => new Promise(resolve => { release = () => resolve(snapshot()); });
  const { elements, state, controller } = harness({ payloads: [snapshot(), slow] });
  await openPanel(elements);
  const button = elements.adminDeadLetters.byTestId('admin-dead-letter-replay')[0];
  void controller.refresh();
  await button.dispatch('click');
  assert.equal(state.confirms.length, 0);
  release();
  await settle();
  state.enabled = false;
  await elements.adminDeadLetters.dispatch('noop');
  await button.dispatch('click');
  assert.equal(state.confirms.length, 0);
});

test('withdrawing access hides the view and drops late responses and replays', async () => {
  let release;
  const slow = () => new Promise(resolve => { release = () => resolve(snapshot()); });
  const { elements, state, controller } = harness({ payloads: [slow] });
  await openPanel(elements);
  assert.equal(elements.adminDiagnosticsRefresh.disabled, true);
  assert.equal(elements.adminDiagnostics.getAttribute('aria-busy'), 'true');
  assert.equal(elements.adminDiagnosticsStatus.textContent, 'Loading diagnostics…');
  state.enabled = false;
  controller.sync();
  assert.equal(elements.adminDiagnostics.hidden, true);
  assert.equal(elements.adminDiagnostics.open, false);
  assert.equal(elements.adminDiagnosticsStatus.textContent, '');
  release();
  await settle();
  assert.equal(elements.adminDiagnosticsCards.children.length, 0, 'a response for the previous identity is ignored');
  controller.sync();
  assert.equal(elements.adminDiagnostics.hidden, true);

  // A replay that settles after access is withdrawn changes nothing on screen.
  let finish;
  const late = harness({ replay: () => new Promise((resolve, reject) => { finish = { resolve, reject }; }) });
  await openPanel(late.elements);
  const button = late.elements.adminDeadLetters.byTestId('admin-dead-letter-replay')[0];
  void button.dispatch('click');
  await settle();
  late.state.enabled = false;
  late.controller.sync();
  finish.resolve({ ok: true });
  await settle();
  assert.equal(late.state.loads, 1);
  const lateFailure = harness({ replay: () => new Promise((resolve, reject) => { finish = { resolve, reject }; }) });
  await openPanel(lateFailure.elements);
  void lateFailure.elements.adminDeadLetters.byTestId('admin-dead-letter-replay')[0].dispatch('click');
  await settle();
  lateFailure.controller.reset();
  finish.reject({ http_status: 503 });
  await settle();
  assert.equal(lateFailure.elements.adminDiagnosticsStatus.textContent, '');
});

test('a dead-letter list longer than the page says so; an unreadable list says so too', async () => {
  const many = snapshot({ deadLetters: { ...snapshot().cards.deadLetters, total: 30 } });
  const { elements } = harness({ payloads: [many] });
  await openPanel(elements);
  assert.match(elements.adminDeadLetters.textContent, /Showing the newest 1 of 30\./);
  const broken = snapshot({ deadLetters: { status: 'unavailable', category: 'read_failed', evidence: null } });
  const second = harness({ payloads: [broken] });
  await openPanel(second.elements);
  assert.equal(second.elements.adminDeadLetters.textContent, 'Dead letters could not be read. Try Refresh.');
  const noOutbox = snapshot({ outbox: { status: 'unavailable', evidence: null } });
  const third = harness({ payloads: [noOutbox] });
  await openPanel(third.elements);
  assert.equal(cardNode(third.elements, 'outbox').byTestId('admin-outbox-types').length, 0);
  const emptyTypes = snapshot({ outbox: { ...snapshot().cards.outbox, byType: [] } });
  const fourth = harness({ payloads: [emptyTypes] });
  await openPanel(fourth.elements);
  assert.match(cardNode(fourth.elements, 'outbox').textContent, /No outbox events yet\./);
});

test('the related-tool links call the host', async () => {
  const { elements, state } = harness();
  await elements.adminOpenLogs.dispatch('click');
  await elements.adminOpenDemo.dispatch('click');
  assert.deepEqual([state.logs, state.demo], [1, 1]);
  const bare = harness({ withLinks: false });
  assert.equal(bare.elements.adminOpenLogs, undefined);
});

test('the controller works without an interval scheduler', () => {
  const { doc } = fixture();
  assert.doesNotThrow(() => mountAdminDiagnostics({ doc, host: { enabled: () => false }, setIntervalImpl: null }));
});

test('a load that fails after access is withdrawn shows nothing, and ticks wait for a snapshot', async () => {
  let fail;
  const slow = () => new Promise((resolve, reject) => { fail = reject; });
  const { elements, state, controller } = harness({ payloads: [slow] });
  controller.tick();
  assert.equal(elements.adminDiagnosticsCards.children.length, 0);
  await openPanel(elements);
  state.enabled = false;
  controller.sync();
  fail({ http_status: 503 });
  await settle();
  assert.equal(elements.adminDiagnosticsStatus.textContent, '');
});

test('the controller defaults to the real clock', async () => {
  const { doc, elements } = fixture();
  const controller = mountAdminDiagnostics({ doc, host: { enabled: () => true, load: async () => snapshot() }, setIntervalImpl: null });
  await controller.refresh();
  assert.equal(elements.adminDiagnosticsCards.children.length, CARD_ORDER.length);
  // Snapshot age is measured from when this browser received it, so a skewed
  // device clock cannot make fresh data look stale.
  assert.equal(elements.adminDiagnostics.dataset.stale, 'false');
  assert.equal(elements.adminDiagnosticsStatus.textContent, 'Diagnostics updated.');
  assert.equal(elements.adminDiagnosticsAge.textContent, 'Checked 2026-10-20 12:00 UTC.');
});

test('a replay confirmed after access was withdrawn is not sent', async () => {
  let state;
  const fixtureHarness = harness({ confirm: () => { state.enabled = false; return true; } });
  state = fixtureHarness.state;
  await openPanel(fixtureHarness.elements);
  await fixtureHarness.elements.adminDeadLetters.byTestId('admin-dead-letter-replay')[0].dispatch('click');
  assert.equal(state.confirms.length, 1);
  assert.deepEqual(state.replays, []);
});

function countWrites(element) {
  const property = Object.getOwnPropertyDescriptor(FakeElement.prototype, 'textContent');
  const counter = { writes: 0 };
  Object.defineProperty(element, 'textContent', {
    get() { return property.get.call(this); },
    set(value) { counter.writes += 1; property.set.call(this, value); },
  });
  return counter;
}

test('a Refresh while a replay is in flight keeps Replay usable and still reports the replay', async () => {
  let finish;
  const { elements, state } = harness({
    payloads: [snapshot(), snapshot(), snapshot()],
    replay: () => new Promise((resolve, reject) => { finish = { resolve, reject }; }),
  });
  await openPanel(elements);
  await elements.adminDeadLetters.byTestId('admin-dead-letter-replay')[0].dispatch('click');
  assert.equal(elements.adminDiagnosticsStatus.textContent, 'Replaying event #41…');
  await elements.adminDiagnosticsRefresh.dispatch('click');
  assert.equal(state.loads, 2);
  assert.equal(elements.adminDiagnosticsStatus.textContent, 'Diagnostics updated.');
  finish.resolve({ ok: true, replayed: true });
  await settle();
  assert.equal(state.loads, 3, 'the replay reloads after the Refresh');
  assert.equal(elements.adminDiagnosticsStatus.textContent, 'Event #41 is queued for delivery again. Diagnostics updated.');
  assert.equal(elements.adminDeadLettersTitle.focused, 1);
  await elements.adminDeadLetters.byTestId('admin-dead-letter-replay')[0].dispatch('click');
  assert.equal(state.confirms.length, 2, 'Replay still works');
  finish.reject({ http_status: 503 });
  await settle();
  // A failure after another Refresh also releases the Replay buttons.
  await elements.adminDiagnosticsRefresh.dispatch('click');
  await elements.adminDeadLetters.byTestId('admin-dead-letter-replay')[0].dispatch('click');
  assert.equal(state.confirms.length, 3);
});

test('a replay whose request settles during a Refresh is reported once the Refresh is superseded', async () => {
  let release;
  let finish;
  const slow = () => new Promise(resolve => { release = () => resolve(snapshot()); });
  const after = snapshot({ deadLetters: { status: 'healthy', total: 0, items: [], evidence: fresh(5 * MINUTE) } });
  const { elements, state } = harness({
    payloads: [snapshot(), slow, after],
    replay: () => new Promise(resolve => { finish = resolve; }),
  });
  await openPanel(elements);
  await elements.adminDeadLetters.byTestId('admin-dead-letter-replay')[0].dispatch('click');
  void elements.adminDiagnosticsRefresh.dispatch('click');
  await settle();
  finish({ ok: true });
  await settle();
  release();
  await settle();
  assert.equal(state.loads, 3);
  assert.equal(elements.adminDeadLetters.textContent, 'No dead letters.', 'the stale Refresh response is ignored');
  assert.equal(elements.adminDiagnosticsStatus.textContent, 'Event #41 is queued for delivery again. Diagnostics updated.');
});

test('a failed reload after a successful replay still says the replay happened', async () => {
  const { elements } = harness({ payloads: [snapshot(), { http_status: 503 }] });
  await openPanel(elements);
  await elements.adminDeadLetters.byTestId('admin-dead-letter-replay')[0].dispatch('click');
  await settle();
  assert.equal(elements.adminDiagnosticsStatus.textContent,
    'Event #41 is queued for delivery again. Diagnostics are unavailable right now. Try Refresh.');
  assert.equal(elements.adminDiagnosticsAge.textContent, '');
});

test('the live status announces only the move to stale; the age line updates quietly', async () => {
  const { controller, elements, state } = harness();
  await openPanel(elements);
  const status = countWrites(elements.adminDiagnosticsStatus);
  for (const minutes of [1, 2, 3, 4, 5]) {
    state.now = Date.parse('2026-10-20T12:00:00.000Z') + minutes * MINUTE;
    controller.tick();
    assert.equal(elements.adminDiagnosticsAge.textContent, `Checked 2026-10-20 12:00 UTC · ${minutes} min ago.`);
  }
  assert.equal(status.writes, 0, 'no announcement while the snapshot is fresh');
  for (const minutes of [6, 7, 8, 20]) {
    state.now = Date.parse('2026-10-20T12:00:00.000Z') + minutes * MINUTE;
    controller.tick();
  }
  assert.equal(status.writes, 1, 'one announcement for the move to stale');
  assert.equal(elements.adminDiagnosticsStatus.textContent, 'This snapshot is out of date. Refresh for current data.');
  assert.equal(elements.adminDiagnosticsAge.textContent, 'Checked 2026-10-20 12:00 UTC · 20 min ago.');
});

test('the controller works without the age line', async () => {
  const { elements, state, controller } = harness({ withAge: false });
  await openPanel(elements);
  state.now += 10 * MINUTE;
  controller.tick();
  assert.equal(elements.adminDiagnostics.dataset.stale, 'true');
  assert.equal(elements.adminDiagnosticsStatus.textContent, 'This snapshot is out of date. Refresh for current data.');
});
