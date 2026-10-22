// Issue #293 progress UI: response validation, copy (including the non-shaming
// streak wording), accessible chart text equivalents, and the request-fenced
// controller, against a minimal DOM.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  coverageState,
  coverageSummary,
  mountProgress,
  normalizeProgress,
  patternLabel,
  renderProgress,
  rolesSentence,
  runsSummary,
  STATUS_COPY,
  statusLabel,
  streakSentence,
  weekLabel,
  weeksSummary,
} from '../../assets/progress-view.js';

// ------------------------------------------------------------ minimal DOM

class FakeNode {
  constructor(tag, namespace = null) {
    this.tagName = tag.toUpperCase();
    this.namespace = namespace;
    this.children = [];
    this.dataset = {};
    this.attributes = {};
    this.listeners = {};
    this.hidden = false;
    this.className = '';
    this._text = '';
  }
  get textContent() { return this._text + this.children.map(child => (typeof child === 'string' ? child : child.textContent)).join(''); }
  set textContent(value) { this._text = String(value); this.children = []; }
  append(...nodes) { this.children.push(...nodes); }
  appendChild(node) { this.children.push(node); return node; }
  replaceChildren(...nodes) { this.children = nodes; }
  setAttribute(name, value) { this.attributes[name] = String(value); }
  getAttribute(name) { return this.attributes[name] ?? null; }
  addEventListener(type, listener) { (this.listeners[type] ||= []).push(listener); }
  all(predicate, found = []) {
    for (const child of this.children) {
      if (typeof child === 'string') continue;
      if (predicate(child)) found.push(child);
      child.all(predicate, found);
    }
    return found;
  }
  byTestId(id) { return this.all(child => child.dataset.testid === id)[0] || null; }
  byTag(tag) { return this.all(child => child.tagName === tag.toUpperCase()); }
}

function fakeDocument({ withSection = true } = {}) {
  const section = new FakeNode('section');
  section.id = 'historyProgress';
  section.hidden = true;
  return {
    section,
    createElement: tag => new FakeNode(tag),
    createElementNS: (namespace, tag) => new FakeNode(tag, namespace),
    getElementById: id => (withSection && id === 'historyProgress' ? section : null),
  };
}

// ------------------------------------------------------------ fixtures

const ME = 2;
const ZONE = 'Europe/London';
const STARTS = ['2026-08-16T07:00:00.000Z', '2026-08-23T07:00:00.000Z', '2026-08-30T07:00:00.000Z',
  '2026-09-06T07:00:00.000Z', '2026-09-13T07:00:00.000Z', '2026-09-20T07:00:00.000Z', '2026-09-27T07:00:00.000Z',
  '2026-10-04T07:00:00.000Z', '2026-10-11T07:00:00.000Z', '2026-10-18T07:00:00.000Z', '2026-10-25T08:00:00.000Z',
  '2026-11-01T08:00:00.000Z', '2026-11-08T08:00:00.000Z'];
const STATUSES = ['no_pairing', 'no_pairing', 'no_pairing', 'no_pairing', 'no_pairing', 'completed', 'not_completed',
  'completed', 'not_available', 'solo', 'completed', 'in_progress'];

function body(overrides = {}) {
  const weeks = STATUSES.map((status, index) => ({
    cycle_id: `2026-W${String(34 + index).padStart(2, '0')}`,
    starts_at: STARTS[index], ends_at: STARTS[index + 1], status,
    completion: status === 'not_completed' ? 'awaiting_participants' : status === 'in_progress' ? 'not_recorded' : null,
    verified_runs: index === 10 ? 3 : index === 11 ? 1 : 0,
    passed_runs: index === 10 ? 2 : 0,
  }));
  return {
    ok: true, user: { id: ME }, generated_at: '2026-11-04T12:00:00.000Z', time_zone: ZONE,
    current_cycle: { cycle_id: '2026-W45', starts_at: STARTS[11], ends_at: STARTS[12] },
    sessions: { completed: 4, solo_completed: 1, pairings: 6, demo_pairings: 0, window_limited: false },
    streak: { rules_version: 1, current_weeks: 2, longest_weeks: 2, this_week: 'in_progress' },
    weeks,
    runs: { window_weeks: 12, verified: 4, passed: 2, scan_limited: false },
    coverage: {
      exercises: { total: 4, attempted: 2, solved: 1 },
      patterns: [
        { key: 'array-processing', exercises: 1, attempted: 1, solved: 1 },
        { key: 'binary-search', exercises: 2, attempted: 2, solved: 1 },
        { key: 'graph-traversal', exercises: 1, attempted: 1, solved: 0 },
        { key: 'two-pointers', exercises: 1, attempted: 0, solved: 0 },
      ],
      topics: [{ key: 'arrays', exercises: 3, attempted: 2, solved: 1 }],
    },
    roles: { available: true, sessions: 3, candidate: 2, interviewer: 1 },
    feedback: { available: false },
    ...overrides,
  };
}

const view = (overrides) => normalizeProgress(body(overrides), { userId: ME });

// ------------------------------------------------------------ validation

test('a valid progress body becomes a view model', () => {
  const result = view();
  assert.equal(result.timeZone, ZONE);
  assert.deepEqual(result.sessions, { completed: 4, pairings: 6, soloCompleted: 1, demoPairings: 0, windowLimited: false });
  assert.deepEqual(result.streak, { current: 2, longest: 2, thisWeek: 'in_progress' });
  assert.equal(result.weeks.length, 12);
  assert.deepEqual(result.weeks[6], {
    cycleId: '2026-W40', startsAt: STARTS[6], start: Date.parse(STARTS[6]), status: 'not_completed',
    completion: 'awaiting_participants', verified: 0, passed: 0,
  });
  assert.deepEqual(result.roles, { candidate: 2, interviewer: 1, sessions: 3 });
  assert.equal(view({ roles: { available: false } }).roles, null);
});

test('anything malformed, inconsistent or for another member is rejected', () => {
  const week = patch => body().weeks.map((item, index) => (index === 3 ? { ...item, ...patch } : item));
  const cases = [
    null, 'text', { ...body(), ok: false }, { ...body(), user: { id: 3 } },
    body({ sessions: { completed: 7, solo_completed: 0, pairings: 6, demo_pairings: 0, window_limited: false } }),
    body({ sessions: { completed: 1, solo_completed: 2, pairings: 6, demo_pairings: 0, window_limited: false } }),
    body({ sessions: { completed: 1, solo_completed: 0, pairings: 6, demo_pairings: 0, window_limited: 'no' } }),
    body({ sessions: { completed: -1, solo_completed: 0, pairings: 6, demo_pairings: 0, window_limited: false } }),
    body({ sessions: { completed: 1, solo_completed: 0, pairings: 6, window_limited: false } }),
    body({ sessions: { completed: 1, solo_completed: 0, pairings: 6, demo_pairings: -1, window_limited: false } }),
    body({ streak: { current_weeks: 3, longest_weeks: 2, this_week: 'in_progress' } }),
    body({ streak: { current_weeks: 0, longest_weeks: null, this_week: 'in_progress' } }),
    body({ streak: { current_weeks: 0, longest_weeks: 0, this_week: 'unknown' } }),
    body({ streak: { current_weeks: 0, longest_weeks: 0, this_week: 'completed' } }),
    body({ weeks: [] }), body({ weeks: 'none' }), body({ weeks: [...body().weeks, body().weeks[0]] }),
    body({ weeks: week({ cycle_id: 'W40' }) }), body({ weeks: week({ starts_at: '2026-09-06' }) }),
    body({ weeks: week({ starts_at: '2026-02-30T07:00:00.000Z' }) }),
    body({ weeks: week({ ends_at: STARTS[3] }) }), body({ weeks: week({ status: 'missed' }) }),
    body({ weeks: week({ verified_runs: 1.5 }) }), body({ weeks: week({ passed_runs: 1 }) }),
    body({ weeks: week({ completion: 'not_recorded' }) }),
    body({ weeks: week({ status: 'not_completed', completion: null }) }),
    body({ weeks: [body().weeks[1], body().weeks[0], ...body().weeks.slice(2)] }),
    body({ weeks: [null, ...body().weeks.slice(1)] }),
    body({ runs: { window_weeks: 12, verified: 5, passed: 2, scan_limited: false } }),
    body({ runs: { window_weeks: 12, verified: 4, passed: 5, scan_limited: false } }),
    body({ runs: { window_weeks: 12, verified: 4, passed: 2 } }),
    body({ runs: { window_weeks: 12, verified: null, passed: 0, scan_limited: false } }),
    body({ coverage: { ...body().coverage, exercises: { total: null, attempted: 0, solved: 0 } } }),
    body({ coverage: { ...body().coverage, exercises: { total: 1, attempted: 2, solved: 0 } } }),
    body({ coverage: { ...body().coverage, exercises: { total: 4, attempted: 1, solved: 2 } } }),
    body({ coverage: { ...body().coverage, patterns: null } }),
    body({ coverage: { ...body().coverage, patterns: Array.from({ length: 201 }, () => body().coverage.patterns[0]) } }),
    body({ coverage: { ...body().coverage, topics: [{ key: 'Arrays!', exercises: 1, attempted: 0, solved: 0 }] } }),
    body({ coverage: { ...body().coverage, topics: [{ key: 'arrays', exercises: 0, attempted: 0, solved: 0 }] } }),
    body({ coverage: { ...body().coverage, topics: [{ key: 'arrays', exercises: 1, attempted: 2, solved: 0 }] } }),
    body({ coverage: { ...body().coverage, topics: [{ key: 'a'.repeat(81), exercises: 1, attempted: 0, solved: 0 }] } }),
    body({ coverage: { ...body().coverage, topics: [null] } }),
    body({ time_zone: '' }), body({ time_zone: 7 }), body({ time_zone: 'Z'.repeat(101) }),
    body({ roles: null }), body({ roles: { available: 'yes' } }),
    body({ roles: { available: true, sessions: 2, candidate: 2, interviewer: 1 } }),
    body({ roles: { available: true, sessions: 0, candidate: 0, interviewer: 0 } }),
    body({ roles: { available: true, sessions: 1, candidate: null, interviewer: 1 } }),
  ];
  for (const [index, candidate] of cases.entries()) {
    assert.equal(normalizeProgress(candidate, { userId: ME }), null, `case ${index}`);
  }
  assert.equal(normalizeProgress(body()), null);
});

// ------------------------------------------------------------ copy

test('weeks are labelled by their start in the cycle time zone', () => {
  assert.equal(weekLabel('2026-10-25T08:00:00.000Z', ZONE), 'Week of 25 Oct');
  // 23:30 UTC on Saturday is already Sunday in Auckland.
  assert.equal(weekLabel('2026-10-24T23:30:00.000Z', 'Pacific/Auckland'), 'Week of 25 Oct');
  assert.equal(weekLabel('2026-10-24T23:30:00.000Z', 'Not/AZone'), 'Week of 24 Oct');
});

test('patterns and statuses read as plain language', () => {
  assert.equal(patternLabel('binary-search'), 'Binary search');
  assert.equal(patternLabel(''), '');
  assert.equal(patternLabel(undefined), '');
  assert.equal(statusLabel({ status: 'not_completed', completion: 'awaiting_participants' }), 'Not everyone confirmed');
  assert.equal(statusLabel({ status: 'not_completed', completion: 'not_recorded' }), 'No session recorded');
  for (const status of ['completed', 'in_progress', 'not_available', 'solo', 'no_pairing']) {
    assert.equal(statusLabel({ status, completion: null }), STATUS_COPY[status]);
  }
  // Paused weeks say so; nothing calls a week missed or failed.
  assert.match(STATUS_COPY.not_available, /paused/);
  assert.doesNotMatch(Object.values(STATUS_COPY).join(' '), /miss|fail|broke|lost/i);
});

test('the streak sentence explains the rule without blame', () => {
  const going = streakSentence(view());
  assert.match(going, /^You have practised with a partner 2 weeks in a row\. This week still counts once you both confirm it\./);
  assert.match(going, /only pause your streak\. It ends only when a paired week finishes without everyone confirming\.$/);
  assert.match(streakSentence(view({ streak: { current_weeks: 1, longest_weeks: 1, this_week: 'in_progress' } })), /1 week in a row/);
  const restart = streakSentence(view({ streak: { current_weeks: 0, longest_weeks: 4, this_week: 'in_progress' } }));
  assert.match(restart, /^Your next completed session starts a new streak\./);
  const weeks = body().weeks.map((week, index) => (index === 11 ? { ...week, status: 'no_pairing', completion: null } : week));
  const first = streakSentence(view({ weeks, streak: { current_weeks: 0, longest_weeks: 0, this_week: 'no_pairing' } }));
  assert.match(first, /^Complete a session with your pair, and both confirm it in the room’s Session panel, to start a streak\. A week/);
});

test('chart summaries carry the numbers as text', () => {
  const result = view();
  // Weeks before the first pairing are not counted as paused.
  assert.equal(weeksSummary(result.weeks), 'Last 12 weeks: 3 weeks with a completed session, 2 paused weeks, 1 week with no session recorded.');
  assert.equal(weeksSummary([{ status: 'completed' }]), 'Last 1 week: 1 week with a completed session.');
  assert.equal(weeksSummary([{ status: 'no_pairing' }, { status: 'no_pairing' }]), 'Last 2 weeks: no pairings yet.');
  assert.equal(weeksSummary([{ status: 'no_pairing' }, { status: 'completed' }, { status: 'no_pairing' }, { status: 'in_progress' }]),
    'Last 4 weeks: 1 week with a completed session, 1 paused week.');
  assert.equal(runsSummary(result), '4 verified runs in the last 12 weeks, 2 passed every case. Most runs: 3 in the week of 25 oct.');
  const quiet = view({ weeks: body().weeks.map(week => ({ ...week, verified_runs: 0, passed_runs: 0 })),
    runs: { window_weeks: 12, verified: 0, passed: 0, scan_limited: false } });
  assert.equal(runsSummary(quiet), 'No verified runs in the last 12 weeks. Runs you make in a room or in solo practice appear here.');
  assert.equal(coverageSummary(result.coverage), '3 of 4 patterns started. 1 of 4 exercises solved, 2 tried.');
  assert.equal(rolesSentence(result.roles), 'In 3 completed sessions with roles recorded you were the candidate 2 times and the interviewer 1 time.');
  assert.equal(rolesSentence({ sessions: 1, candidate: 1, interviewer: 0 }), 'In 1 completed session with roles recorded you were the candidate 1 time and the interviewer 0 times.');
});

test('coverage states distinguish solved, partly solved, tried and untouched', () => {
  assert.deepEqual(coverageState({ exercises: 1, attempted: 1, solved: 1 }), { label: 'Solved', tone: 'success' });
  assert.deepEqual(coverageState({ exercises: 2, attempted: 2, solved: 1 }), { label: 'Partly solved', tone: 'info' });
  assert.deepEqual(coverageState({ exercises: 1, attempted: 1, solved: 0 }), { label: 'Tried', tone: 'warning' });
  assert.deepEqual(coverageState({ exercises: 1, attempted: 0, solved: 0 }), { label: 'Not started', tone: '' });
});

// ------------------------------------------------------------ rendering

test('the dashboard renders tiles, aria-hidden charts with text equivalents, coverage and roles', () => {
  const doc = fakeDocument();
  renderProgress(doc, doc.section, view());
  const section = doc.section;
  assert.equal(section.byTag('h3')[0].id, 'historyProgressTitle');
  assert.equal(section.byTag('h3')[0].textContent, 'Your progress');
  assert.match(section.textContent, /Private to you\. Weeks run from Sunday 08:00 \(Europe\/London\)\./);
  assert.equal(section.byTestId('progress-status').getAttribute('role'), 'status');
  assert.equal(section.byTestId('progress-completed').textContent, 'Completed sessions4');
  assert.equal(section.byTestId('progress-streak').textContent, 'Weekly streak2 weeks');
  assert.equal(section.byTestId('progress-longest').textContent, 'Longest streak2 weeks');
  assert.equal(section.byTestId('progress-solved').textContent, 'Exercises solved1 of 4');
  assert.equal(section.byTestId('progress-empty'), null);

  const charts = section.all(child => child.tagName === 'SVG');
  assert.equal(charts.length, 3);
  for (const chart of charts) {
    assert.equal(chart.getAttribute('aria-hidden'), 'true');
    assert.equal(chart.namespace, 'http://www.w3.org/2000/svg');
  }
  const weekMarks = section.byTestId('progress-weeks').all(child => child.tagName === 'RECT');
  assert.deepEqual(weekMarks.map(mark => mark.getAttribute('class').replace('progress-week progress-week--', '')),
    ['paused', 'paused', 'paused', 'paused', 'paused', 'completed', 'not_completed', 'completed', 'paused', 'paused', 'completed', 'in_progress']);
  assert.equal(section.byTestId('progress-weeks-summary').textContent, weeksSummary(view().weeks));
  const bars = section.byTestId('progress-runs').all(child => child.tagName === 'RECT');
  // 12 verified bars plus one passed bar for the one week with passes.
  assert.equal(bars.length, 13);
  assert.equal(bars.filter(bar => bar.getAttribute('class').endsWith('passed'))[0].getAttribute('height'), '40');
  assert.equal(section.byTestId('progress-runs-summary').textContent, runsSummary(view()));

  const table = section.byTestId('progress-weeks-table');
  assert.equal(table.tagName, 'DETAILS');
  assert.equal(table.byTag('summary')[0].textContent, 'Show weeks as a table');
  const rows = table.byTag('tbody')[0].byTag('tr');
  assert.equal(rows.length, 12);
  assert.equal(rows[6].dataset.status, 'not_completed');
  // Month abbreviations vary by ICU version ("Sep"/"Sept"), so use the same formatter.
  assert.equal(rows[6].textContent, `${weekLabel(STARTS[6], ZONE)}Not everyone confirmed00`);
  assert.equal(rows[10].textContent, 'Week of 25 OctSession completed32');
  assert.equal(rows[0].byTag('th')[0].getAttribute('scope'), 'row');

  const patterns = section.byTestId('progress-patterns').byTag('li');
  assert.deepEqual(patterns.map(row => [row.dataset.key, row.dataset.state]), [
    ['array-processing', 'started'], ['binary-search', 'started'], ['graph-traversal', 'started'], ['two-pointers', 'untouched'],
  ]);
  assert.equal(patterns[1].textContent, 'Binary searchPartly solved1 of 2 exercises solved, 2 tried');
  assert.equal(patterns[3].textContent, 'Two pointersNot started0 of 1 exercise solved');
  const meter = patterns[1].byTag('progress')[0];
  assert.deepEqual([meter.max, meter.value, meter.getAttribute('aria-hidden')], [2, 1, 'true']);
  assert.equal(section.byTestId('progress-topics').byTag('summary')[0].textContent, 'All topics (1)');
  assert.equal(section.byTestId('progress-roles-summary').textContent, rolesSentence(view().roles));
  const roleBars = section.byTestId('progress-roles').all(child => child.tagName === 'RECT');
  assert.deepEqual(roleBars.map(bar => bar.getAttribute('width')), ['67', '33']);
});

test('new members get an empty state; limited totals are disclosed; no roles section without data', () => {
  const doc = fakeDocument();
  const weeks = body().weeks.map(week => ({ ...week, status: 'no_pairing', completion: null, verified_runs: 0, passed_runs: 0 }));
  renderProgress(doc, doc.section, view({
    weeks, streak: { current_weeks: 0, longest_weeks: 0, this_week: 'no_pairing' },
    sessions: { completed: 0, solo_completed: 0, pairings: 0, demo_pairings: 0, window_limited: false },
    runs: { window_weeks: 12, verified: 0, passed: 0, scan_limited: false },
    roles: { available: false },
  }));
  assert.match(doc.section.byTestId('progress-empty').textContent, /starts with your first pairing/);
  assert.equal(doc.section.byTestId('progress-roles'), null);
  assert.doesNotMatch(doc.section.textContent, /most recent records/);
  // Zero runs still draw a visible baseline bar.
  assert.ok(doc.section.byTestId('progress-runs').all(child => child.tagName === 'RECT').every(bar => bar.getAttribute('height') === '2'));
  assert.equal(doc.section.byTestId('progress-demo-note'), null);
  const demo = fakeDocument();
  renderProgress(demo, demo.section, view({ sessions: { completed: 4, solo_completed: 1, pairings: 6, demo_pairings: 2, window_limited: false } }));
  assert.equal(demo.section.byTestId('progress-demo-note').textContent, 'Demo sessions aren’t counted here.');
  const limited = fakeDocument();
  renderProgress(limited, limited.section, view({ sessions: { completed: 4, solo_completed: 1, pairings: 6, demo_pairings: 0, window_limited: true } }));
  assert.match(limited.section.textContent, /Totals cover your most recent records only\./);
  const scanned = fakeDocument();
  renderProgress(scanned, scanned.section, view({ runs: { window_weeks: 12, verified: 4, passed: 2, scan_limited: true } }));
  assert.match(scanned.section.textContent, /Totals cover your most recent records only\./);
});

// ------------------------------------------------------------ controller

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

function response(status, payload) {
  return { ok: status >= 200 && status < 300, status, json: async () => payload };
}

function host({ userId = ME, visible = true, replies = [] } = {}) {
  const state = { userId, visible, calls: [] };
  return {
    state,
    userId: () => state.userId,
    visible: () => state.visible,
    fetchProgress: signal => {
      state.calls.push(signal);
      const next = replies.shift();
      return typeof next === 'function' ? next(signal) : Promise.resolve(next);
    },
  };
}

test('without the section the controller is inert', async () => {
  const controller = mountProgress({ doc: fakeDocument({ withSection: false }), host: host() });
  assert.equal(await controller.load(), false);
  controller.release(ME);
  assert.equal(await controller.resume(), false);
  controller.stop();
  controller.reset();
});

test('load shows a loading state, then the dashboard', async () => {
  const doc = fakeDocument();
  const pending = deferred();
  const fake = host({ replies: [() => pending.promise] });
  const controller = mountProgress({ doc, host: fake });
  const loading = controller.load();
  assert.equal(doc.section.hidden, false);
  assert.equal(doc.section.getAttribute('aria-busy'), 'true');
  assert.equal(doc.section.byTestId('progress-status').textContent, 'Loading your progress…');
  pending.resolve(response(200, body()));
  assert.equal(await loading, true);
  assert.equal(doc.section.getAttribute('aria-busy'), 'false');
  assert.equal(doc.section.byTestId('progress-completed').textContent, 'Completed sessions4');
  // A refresh keeps the current dashboard visible instead of a skeleton.
  const refresh = deferred();
  fake.fetchProgress = () => refresh.promise;
  const again = controller.load();
  assert.ok(doc.section.byTestId('progress-completed'));
  refresh.resolve(response(200, body({ sessions: { completed: 5, solo_completed: 1, pairings: 6, demo_pairings: 0, window_limited: false } })));
  assert.equal(await again, true);
  assert.equal(doc.section.byTestId('progress-completed').textContent, 'Completed sessions5');
});

test('nothing loads for a signed-out member or while History is hidden', async () => {
  const doc = fakeDocument();
  assert.equal(await mountProgress({ doc, host: host({ userId: null }) }).load(), false);
  assert.equal(await mountProgress({ doc, host: host({ visible: false }) }).load(), false);
  assert.equal(doc.section.hidden, true);
});

test('a response for a previous member, a hidden view or an older request never renders', async () => {
  for (const change of [state => { state.userId = 9; }, state => { state.visible = false; }]) {
    const doc = fakeDocument();
    const pending = deferred();
    const fake = host({ replies: [() => pending.promise] });
    const controller = mountProgress({ doc, host: fake });
    const loading = controller.load();
    change(fake.state);
    pending.resolve(response(200, body()));
    assert.equal(await loading, false);
    assert.equal(doc.section.byTestId('progress-completed'), null);
  }
  // Failures that arrive after the member changed are ignored too.
  for (const failure of [
    pending => pending.resolve(response(503, { error: 'progress unavailable' })),
    pending => pending.reject(new TypeError('network down')),
  ]) {
    const doc = fakeDocument();
    let fail;
    const fake = host({ replies: [() => new Promise((resolve, reject) => { fail = { resolve, reject }; })] });
    const loading = mountProgress({ doc, host: fake }).load();
    fake.state.userId = 9;
    failure(fail);
    assert.equal(await loading, false);
    assert.equal(doc.section.byTestId('progress-retry'), null);
  }
});

test('when two loads overlap only the newer one renders', async () => {
  const doc = fakeDocument();
  const older = deferred();
  const newer = deferred();
  const fake = host({ replies: [() => older.promise, () => newer.promise] });
  const controller = mountProgress({ doc, host: fake });
  const first = controller.load();
  const second = controller.load();
  assert.equal(fake.state.calls[0].aborted, true);
  older.resolve(response(200, body({ sessions: { completed: 1, solo_completed: 0, pairings: 6, demo_pairings: 0, window_limited: false } })));
  assert.equal(await first, false);
  assert.equal(doc.section.getAttribute('aria-busy'), 'true');
  newer.resolve(response(200, body()));
  assert.equal(await second, true);
  assert.equal(doc.section.byTestId('progress-completed').textContent, 'Completed sessions4');
});

test('a 404 after History loaded means the flag went off: the section hides', async () => {
  const doc = fakeDocument();
  const controller = mountProgress({ doc, host: host({ replies: [response(404, { error: "unknown data endpoint 'progress'" })] }) });
  assert.equal(await controller.load(), false);
  assert.equal(doc.section.hidden, true);
  assert.equal(doc.section.children.length, 0);
});

test('failures offer one Retry that loads again', async () => {
  const doc = fakeDocument();
  const fake = host({ replies: [response(503, { error: 'progress unavailable' }), response(200, { ok: true }),
    { ok: true, status: 200, json: async () => { throw new SyntaxError('bad json'); } }, response(200, body())] });
  const controller = mountProgress({ doc, host: fake });
  assert.equal(await controller.load(), false);
  assert.equal(doc.section.byTestId('progress-status').textContent, 'Progress is unavailable right now.');
  const retry = () => {
    const button = doc.section.byTestId('progress-retry');
    assert.equal(button.type, 'button');
    button.listeners.click[0]();
  };
  retry();
  await new Promise(resolve => setImmediate(resolve));
  assert.ok(doc.section.byTestId('progress-retry'), 'an invalid body is an error too');
  retry();
  await new Promise(resolve => setImmediate(resolve));
  assert.ok(doc.section.byTestId('progress-retry'), 'unreadable JSON is an error too');
  retry();
  await new Promise(resolve => setImmediate(resolve));
  await new Promise(resolve => setImmediate(resolve));
  assert.ok(doc.section.byTestId('progress-completed'));
  assert.equal(fake.state.calls.length, 4);
});

test('re-rendering History keeps the same member’s dashboard until the reload replaces it', async () => {
  const doc = fakeDocument();
  const fake = host({ replies: [response(200, body())] });
  const controller = mountProgress({ doc, host: fake });
  // Nothing shown yet: release clears.
  controller.release(ME);
  assert.equal(doc.section.hidden, true);
  assert.equal(await controller.load(), true);
  controller.release(ME);
  assert.equal(doc.section.hidden, false);
  assert.ok(doc.section.byTestId('progress-completed'), 'kept for the same member');
  const refresh = deferred();
  fake.fetchProgress = () => refresh.promise;
  const reloading = controller.load();
  assert.ok(doc.section.byTestId('progress-completed'), 'no skeleton while reloading');
  assert.equal(doc.section.byTestId('progress-status').textContent, 'Progress loaded');
  refresh.resolve(response(200, body({ sessions: { completed: 5, solo_completed: 1, pairings: 6, demo_pairings: 0, window_limited: false } })));
  assert.equal(await reloading, true);
  assert.equal(doc.section.byTestId('progress-completed').textContent, 'Completed sessions5');
  // Another member, or none, clears it immediately.
  controller.release(9);
  assert.equal(doc.section.hidden, true);
  assert.equal(doc.section.children.length, 0);
  assert.equal(await mountProgress({ doc, host: host({ replies: [response(200, body())] }) }).load(), true);
});

test('a dashboard rendered for another member is replaced by a skeleton first', async () => {
  const doc = fakeDocument();
  const fake = host({ replies: [response(200, body())] });
  const controller = mountProgress({ doc, host: fake });
  assert.equal(await controller.load(), true);
  fake.state.userId = 9;
  const pending = deferred();
  fake.fetchProgress = () => pending.promise;
  const loading = controller.load();
  assert.equal(doc.section.byTestId('progress-completed'), null);
  assert.equal(doc.section.byTestId('progress-status').textContent, 'Loading your progress…');
  pending.resolve(response(200, { ...body(), user: { id: 9 } }));
  assert.equal(await loading, true);
  controller.release(null);
  assert.equal(doc.section.hidden, true);
});

test('stop aborts an in-flight load and resume restarts it; reset clears everything', async () => {
  const doc = fakeDocument();
  const pending = deferred();
  const fake = host({ replies: [() => pending.promise, response(200, body())] });
  const controller = mountProgress({ doc, host: fake });
  const loading = controller.load();
  controller.stop();
  assert.equal(fake.state.calls[0].aborted, true);
  pending.resolve(response(200, body()));
  assert.equal(await loading, false);
  assert.equal(await controller.resume(), true);
  assert.ok(doc.section.byTestId('progress-completed'));
  // Nothing was interrupted, so there is nothing to resume.
  controller.stop();
  assert.equal(await controller.resume(), false);
  controller.reset();
  assert.equal(doc.section.hidden, true);
  assert.equal(doc.section.children.length, 0);
  assert.equal(doc.section.getAttribute('aria-busy'), 'false');
});
