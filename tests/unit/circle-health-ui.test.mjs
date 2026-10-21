// Issue #292 owner "Circle health" panel: response validation, cell text and
// the DOM controller, against a minimal fake DOM.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import healthUi, {
  CACHE_TTL_MS,
  cellView,
  cycleLabel,
  footnoteText,
  formatDuration,
  METRICS,
  mountCircleHealth,
  normalizeCell,
  normalizeHealthResponse,
  renderHealthTable,
  visibleMetrics,
} from '../../assets/circle-health.js';

class FakeElement {
  constructor(tag) {
    this.tagName = tag.toUpperCase();
    this.children = [];
    this.attributes = {};
    this.listeners = {};
    this.hidden = false;
    this.disabled = false;
    this.className = '';
    this.style = {};
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
  async dispatch(type) {
    for (const listener of this.listeners[type] || []) listener({});
    await new Promise(resolve => setImmediate(resolve));
  }
  all(predicate, found = []) {
    for (const child of this.children) {
      if (predicate(child)) found.push(child);
      child.all?.(predicate, found);
    }
    return found;
  }
}

class FakeText {
  constructor(text) { this.textContent = text; }
}

const IDS = ['circleHealthPanel', 'circleHealthStatus', 'circleHealthTableWrap', 'circleHealthTable', 'circleHealthEmpty',
  'circleHealthFootnote', 'circleHealthRefresh', 'circleHealthDefinitions'];

function fakeDocument({ without = [] } = {}) {
  const elements = new Map(IDS.filter(id => !without.includes(id)).map(id => [id, new FakeElement(id === 'circleHealthTable' ? 'table' : 'div')]));
  const panel = elements.get('circleHealthPanel');
  if (panel) panel.hidden = true;
  elements.get('circleHealthTableWrap') && (elements.get('circleHealthTableWrap').hidden = true);
  return {
    elements,
    getElementById: id => elements.get(id) || null,
    createElement: tag => new FakeElement(tag),
    createTextNode: text => new FakeText(text),
  };
}

const ok = value => ({ status: 'ok', value });
const hidden = { status: 'suppressed', value: null };
const none = { status: 'no_data', value: null };
const untracked = { status: 'not_tracked', value: null };

function cycle(overrides = {}) {
  return {
    cycle_id: '2026-W43', starts_at: '2026-10-18T07:00:00.000Z', in_progress: false, suppressed: false,
    metrics: {
      available: ok(8), paired: ok(8), solo: ok(0), scheduled: hidden, completed: ok(4), cancelled: untracked,
      no_show: untracked, median_hours_to_agreed_time: ok(36), repeat_pair_percent: none,
    },
    ...overrides,
  };
}

function response(cycles = [cycle()], health = {}) {
  return {
    ok: true,
    health: { version: 1, scope: 'primary', window_cycles: 8, lookback_cycles: 8, min_cell_size: 3, completion_tracked: true,
      attendance_outcomes_tracked: false, generated_at: '2026-10-20T12:00:00.000Z', cycles, ...health },
  };
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((ok, fail) => { resolve = ok; reject = fail; });
  return { promise, resolve, reject };
}

function fakeHost(overrides = {}) {
  const host = {
    owner: true, valid: true, key: 'user:1', calls: 0, clock: 1000,
    now: () => host.clock,
    canView: () => host.owner,
    cacheKey: () => host.key,
    capture: () => ({ token: host.key }),
    matches: () => host.valid,
    fetch: async () => { host.calls += 1; return host.respond(); },
    respond: () => response(),
    weekLabel: item => `Week of ${item.week_start.slice(5, 10)}`,
    ...overrides,
  };
  return host;
}

function rows(doc) {
  return doc.elements.get('circleHealthTable').all(node => node.attributes?.['data-testid'] === 'circle-health-row');
}

test('cells are accepted only in the server contract shape', () => {
  assert.deepEqual(normalizeCell(ok(3)), ok(3));
  assert.deepEqual(normalizeCell(hidden), hidden);
  assert.deepEqual(normalizeCell(none), none);
  assert.deepEqual(normalizeCell(untracked), untracked);
  assert.equal(normalizeCell({ status: 'suppressed', value: 1 }), null, 'a suppressed cell never carries a value');
  assert.equal(normalizeCell({ status: 'ok', value: 1.5 }), null);
  assert.equal(normalizeCell({ status: 'ok', value: -1 }), null);
  assert.equal(normalizeCell({ status: 'ok', value: '3' }), null);
  assert.equal(normalizeCell({ status: 'other', value: null }), null);
  assert.equal(normalizeCell(null), null);
  assert.deepEqual(normalizeCell(ok(36.5), 'hours'), ok(36.5));
  assert.equal(normalizeCell(ok(24 * 400), 'hours'), null);
  assert.deepEqual(normalizeCell(ok(100), 'percent'), ok(100));
  assert.equal(normalizeCell(ok(101), 'percent'), null);
});

test('a response is rendered only when every cycle and cell is valid', () => {
  const health = normalizeHealthResponse(response([cycle({ in_progress: true }), cycle({ cycle_id: '2026-W42', starts_at: null })]));
  assert.equal(health.scope, 'primary');
  assert.equal(health.completionTracked, true);
  assert.equal(health.attendanceTracked, false);
  assert.equal(health.minimum, 3);
  assert.deepEqual(health.cycles.map(item => item.cycle_id), ['2026-W43', '2026-W42']);
  for (const invalid of [
    null, { ok: false }, { ok: true }, response([], { scope: 'tertiary' }), response([], { completion_tracked: 'yes' }),
    response([], { min_cell_size: 1 }), response([], { cycles: {} }), response(Array.from({ length: 9 }, () => cycle())),
    response([cycle({ cycle_id: 'W43' })]), response([cycle({ in_progress: 'no' })]), response([cycle({ suppressed: 1 })]),
    response([cycle({ starts_at: 'not a date' })]), response([cycle({ metrics: null })]),
    response([cycle({ metrics: { ...cycle().metrics, no_show: undefined } })]),
    response([cycle({ metrics: { ...cycle().metrics, available: { status: 'suppressed', value: 2 } } })]),
  ]) {
    assert.equal(normalizeHealthResponse(invalid), null, JSON.stringify(invalid)?.slice(0, 120));
  }
});

test('cell text explains hidden, empty and untracked values', () => {
  const count = METRICS.find(metric => metric.key === 'available');
  const hours = METRICS.find(metric => metric.key === 'median_hours_to_agreed_time');
  const percent = METRICS.find(metric => metric.key === 'repeat_pair_percent');
  assert.deepEqual(cellView(count, ok(7)), { text: '7', state: 'ok' });
  assert.deepEqual(cellView(percent, ok(50)), { text: '50%', state: 'ok' });
  assert.deepEqual(cellView(hours, ok(36)), { text: '36 h', state: 'ok' });
  assert.deepEqual(cellView(count, hidden), { text: 'Hidden', state: 'suppressed', title: 'Hidden so it cannot describe fewer than 3 members' });
  assert.equal(cellView(count, hidden, { minimum: 5 }).title, 'Hidden so it cannot describe fewer than 5 members');
  assert.deepEqual(cellView(count, none), { text: '—', state: 'none', title: 'Nothing to measure yet' });
  assert.deepEqual(cellView(count, untracked), { text: 'Not tracked', state: 'not-tracked' });
  assert.equal(formatDuration(0.4), 'under 1 h');
  assert.equal(formatDuration(9.4), '9 h');
  assert.equal(formatDuration(47.6), '48 h');
  assert.equal(formatDuration(60), '2.5 days');
});

test('secondary circles drop the completion column and say why', () => {
  const primary = normalizeHealthResponse(response());
  const secondary = normalizeHealthResponse(response([cycle({ metrics: { ...cycle().metrics, completed: untracked } })],
    { scope: 'secondary', completion_tracked: false, attendance_outcomes_tracked: true }));
  assert.ok(visibleMetrics(primary).some(metric => metric.key === 'completed'));
  assert.ok(!visibleMetrics(secondary).some(metric => metric.key === 'completed'));
  assert.equal(footnoteText(primary), 'Cancellations and no-shows will appear once cancel and no-show reporting is available.');
  assert.equal(footnoteText(secondary), 'This circle does not record completed sessions.');
});

test('cycle labels prefer the host week label and fall back to the cycle id', () => {
  const item = cycle();
  assert.equal(cycleLabel(item, () => '  Week of 18 Oct '), 'Week of 18 Oct');
  assert.equal(cycleLabel(item, () => ''), '2026-W43');
  assert.equal(cycleLabel(item, () => { throw new Error('no locale'); }), '2026-W43');
  assert.equal(cycleLabel(item), '2026-W43');
});

test('the table is text-only, one row per cycle, with withheld cycles spanning the row', () => {
  const doc = fakeDocument();
  const table = doc.elements.get('circleHealthTable');
  const health = normalizeHealthResponse(response([
    cycle({ in_progress: true }),
    cycle({ cycle_id: '2026-W42', suppressed: true, metrics: Object.fromEntries(Object.keys(cycle().metrics).map(key => [key, hidden])) }),
  ]));
  renderHealthTable(doc, table, health, { weekLabel: () => 'Week of 18 Oct' });
  const [caption, head, body] = table.children;
  assert.equal(caption.tagName, 'CAPTION');
  assert.match(caption.textContent, /last 2 cycles, newest first\. Hidden values would describe fewer than 3 members/);
  assert.deepEqual(head.children[0].children.map(cell => cell.textContent),
    ['Cycle', 'Available', 'Paired', 'Agreed a time', 'Completed', 'Solo', 'Pairing to session', 'Repeat pairs']);
  const [current, withheld] = body.children;
  assert.equal(current.children[0].textContent, 'Week of 18 Oct In progress');
  assert.deepEqual(current.children.slice(1).map(cell => [cell.attributes['data-metric'], cell.textContent]), [
    ['available', '8'], ['paired', '8'], ['scheduled', 'Hidden'], ['completed', '4'], ['solo', '0'],
    ['median_hours_to_agreed_time', '36 h'], ['repeat_pair_percent', '—'],
  ]);
  assert.equal(current.children[3].attributes.title, 'Hidden so it cannot describe fewer than 3 members');
  assert.equal(withheld.attributes['data-suppressed'], 'true');
  assert.equal(withheld.children.length, 2);
  assert.equal(withheld.children[1].attributes.colspan, '7');
  assert.equal(withheld.children[1].textContent, 'Hidden: fewer than 3 members took part');
});

test('the controller needs every panel element', () => {
  assert.equal(mountCircleHealth({ doc: fakeDocument({ without: ['circleHealthRefresh'] }), host: fakeHost() }), null);
  const doc = fakeDocument({ without: ['circleHealthDefinitions'] });
  assert.ok(mountCircleHealth({ doc, host: fakeHost() }), 'the definitions list is optional');
});

test('an owner sees the panel load once per circle context and reuse it', async () => {
  const doc = fakeDocument();
  const host = fakeHost();
  const controller = mountCircleHealth({ doc, host });
  assert.match(doc.elements.get('circleHealthDefinitions').textContent, /Pairing to session.*Repeat pairs.*Hidden/s);
  assert.equal(await controller.show(), true);
  const panel = doc.elements.get('circleHealthPanel');
  assert.equal(panel.hidden, false);
  assert.equal(panel.style.display, '');
  assert.equal(doc.elements.get('circleHealthTableWrap').hidden, false);
  assert.equal(doc.elements.get('circleHealthTableWrap').getAttribute('aria-busy'), 'false');
  assert.equal(doc.elements.get('circleHealthEmpty').hidden, true);
  assert.equal(rows(doc).length, 1);
  assert.equal(doc.elements.get('circleHealthFootnote').hidden, false);
  assert.equal(doc.elements.get('circleHealthStatus').textContent, '');
  host.clock += CACHE_TTL_MS - 1;
  assert.equal(await controller.show(), true);
  assert.equal(host.calls, 1, 'the same circle context reuses a recent copy in memory');
  host.clock += 1;
  await controller.show();
  assert.equal(host.calls, 2, 'an expired copy is fetched again');
  host.key = 'user:1:other-circle';
  await controller.show();
  assert.equal(host.calls, 3, 'a different circle context fetches again');
  await doc.elements.get('circleHealthRefresh').dispatch('click');
  assert.equal(host.calls, 4, 'Refresh always fetches');
  controller.invalidate();
  await controller.show();
  assert.equal(host.calls, 5, 'an invalidated copy is fetched again');
  delete host.now;
  host.key = 'user:1:wall-clock';
  await controller.show();
  await controller.show();
  assert.equal(host.calls, 6, 'the wall clock is the default');
});

test('non-owners never see the panel or trigger a request', async () => {
  const doc = fakeDocument();
  const host = fakeHost({ owner: false });
  const controller = mountCircleHealth({ doc, host });
  assert.equal(await controller.show(), false);
  assert.equal(await controller.refresh(), false);
  assert.equal(doc.elements.get('circleHealthPanel').hidden, true);
  assert.equal(doc.elements.get('circleHealthPanel').style.display, 'none');
  assert.equal(host.calls, 0);
});

test('an empty history shows the empty state', async () => {
  const doc = fakeDocument();
  const controller = mountCircleHealth({ doc, host: fakeHost({ respond: () => response([], { attendance_outcomes_tracked: true }) }) });
  await controller.show();
  assert.equal(doc.elements.get('circleHealthEmpty').hidden, false);
  assert.equal(doc.elements.get('circleHealthTableWrap').hidden, true);
  assert.equal(doc.elements.get('circleHealthFootnote').hidden, true);
});

test('403 or 404 hides the panel; other failures offer a retry', async () => {
  const doc = fakeDocument();
  let failure = Object.assign(new Error('forbidden'), { http_status: 403 });
  const host = fakeHost({ fetch: async () => { host.calls += 1; throw failure; } });
  const controller = mountCircleHealth({ doc, host });
  assert.equal(await controller.show(), false);
  assert.equal(doc.elements.get('circleHealthPanel').hidden, true);
  failure = { error: 'circle health unavailable', http_status: 503 };
  await controller.show();
  assert.equal(doc.elements.get('circleHealthPanel').hidden, false);
  assert.equal(doc.elements.get('circleHealthStatus').textContent, 'Circle health is unavailable right now.');
  assert.equal(doc.elements.get('circleHealthRefresh').textContent, 'Try again');
  assert.equal(doc.elements.get('circleHealthRefresh').disabled, false);
  host.fetch = async () => ({ ok: true, health: { cycles: 'nope' } });
  await controller.refresh();
  assert.equal(doc.elements.get('circleHealthStatus').textContent, 'Circle health is unavailable right now.', 'an invalid body is a failure');
  host.fetch = async () => response();
  await controller.refresh();
  assert.equal(doc.elements.get('circleHealthRefresh').textContent, 'Refresh');
  assert.equal(rows(doc).length, 1);
});

test('stale responses and changed circle contexts are ignored', async () => {
  const doc = fakeDocument();
  const pending = deferred();
  const host = fakeHost({ fetch: () => pending.promise });
  const controller = mountCircleHealth({ doc, host });
  const first = controller.show();
  assert.equal(controller.refresh(), first, 'a second request for the same context joins the first');
  assert.equal(doc.elements.get('circleHealthRefresh').disabled, true);
  assert.equal(doc.elements.get('circleHealthStatus').textContent, 'Loading circle health…');
  host.valid = false;
  pending.resolve(response());
  assert.equal(await first, false);
  assert.equal(rows(doc).length, 0, 'a response for an old context never renders');
  const failing = deferred();
  host.fetch = () => failing.promise;
  host.valid = true;
  const second = controller.refresh();
  host.valid = false;
  failing.reject(Object.assign(new Error('gone'), { http_status: 403 }));
  assert.equal(await second, false);
  assert.equal(doc.elements.get('circleHealthPanel').hidden, false, 'a stale failure changes nothing');
  host.valid = false;
  assert.equal(await controller.refresh(), false, 'nothing is requested while the context is changing');
});

test('a newer circle context supersedes an older request, and reset clears everything', async () => {
  const doc = fakeDocument();
  const older = deferred();
  const host = fakeHost({ fetch: () => older.promise });
  const controller = mountCircleHealth({ doc, host });
  const first = controller.show();
  host.key = 'user:1:newer';
  host.fetch = async () => response([cycle({ cycle_id: '2026-W40' })]);
  assert.equal(await controller.show(), true);
  older.resolve(response());
  assert.equal(await first, false);
  assert.equal(rows(doc)[0].attributes['data-cycle'], '2026-W40');
  const pending = deferred();
  host.fetch = () => pending.promise;
  const inFlight = controller.refresh();
  controller.reset();
  pending.resolve(response());
  assert.equal(await inFlight, false);
  assert.equal(doc.elements.get('circleHealthPanel').hidden, true);
  assert.equal(rows(doc).length, 0);
  assert.equal(doc.elements.get('circleHealthRefresh').disabled, false);
  host.fetch = async () => { host.calls += 1; return response(); };
  await controller.show();
  assert.equal(host.calls, 1, 'reset drops the cached copy');
});

test('the module registers itself for index.html', async () => {
  assert.equal(typeof healthUi.mountCircleHealth, 'function');
  const events = [];
  globalThis.window = { dispatchEvent: event => events.push(event.type) };
  try {
    const fresh = await import(`../../assets/circle-health.js?browser=${Date.now()}`);
    assert.equal(globalThis.window.RandoriCircleHealth, fresh.default);
    assert.deepEqual(events, ['randori:circle-health-ready']);
    globalThis.window = { dispatchEvent: () => { throw new Error('old browser'); } };
    await import(`../../assets/circle-health.js?browser-again=${Date.now()}`);
    assert.ok(globalThis.window.RandoriCircleHealth);
  } finally {
    delete globalThis.window;
  }
});
