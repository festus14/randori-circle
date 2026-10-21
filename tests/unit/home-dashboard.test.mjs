import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

await import('../../assets/home-dashboard.js');
const home = globalThis._randori_home_ui;

const NOW = Date.parse('2026-10-19T12:00:00.000Z');
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const iso = offset => new Date(NOW + offset).toISOString();
const fmt = { locale: 'en-US', timeZone: 'UTC' };

class FakeElement {
  constructor(id = '') {
    this.id = id;
    this.dataset = {};
    this.hidden = false;
    this.textContent = '';
    this.className = '';
    this.style = {};
  }
}

function fakeDocument(elements, readyState = 'complete') {
  const listeners = {};
  return {
    readyState,
    listeners,
    getElementById: id => elements[id] || null,
    addEventListener(type, handler) { listeners[type] = handler; },
  };
}

test('exposes a frozen API on the global object', () => {
  assert.ok(Object.isFrozen(home));
  assert.equal(home.SESSION_LENGTH_MS, HOUR);
  assert.equal(home.STARTING_SOON_MS, 15 * 60 * 1000);
});

test('relativeTime picks minutes, hours or days and handles invalid input', () => {
  assert.equal(home.relativeTime(iso(30 * 1000), NOW, 'en-US'), 'now');
  assert.equal(home.relativeTime(iso(25 * 60 * 1000), NOW, 'en-US'), 'in 25 minutes');
  assert.equal(home.relativeTime(iso(-3 * HOUR), NOW, 'en-US'), '3 hours ago');
  assert.equal(home.relativeTime(iso(2 * DAY), NOW, 'en-US'), 'in 2 days');
  assert.equal(home.relativeTime(iso(DAY), NOW, 'en-US'), 'tomorrow');
  assert.equal(home.relativeTime(NOW + 2 * HOUR, NOW, 'en-US'), 'in 2 hours');
  assert.equal(home.relativeTime('not a date', NOW), '');
  assert.equal(home.relativeTime(null, NOW), '');
  assert.equal(home.relativeTime(Number.NaN, NOW), '');
  assert.equal(home.relativeTime(iso(HOUR), Number.NaN), '');
});

test('relativeTime falls back to plain English when Intl.RelativeTimeFormat throws', () => {
  const original = Intl.RelativeTimeFormat;
  Intl.RelativeTimeFormat = function Broken() { throw new Error('unsupported'); };
  try {
    assert.equal(home.relativeTime(iso(2 * DAY), NOW), 'in 2 days');
    assert.equal(home.relativeTime(iso(-60 * 1000), NOW), '1 minute ago');
    assert.equal(home.relativeTime(iso(HOUR), NOW), 'in 1 hour');
  } finally {
    Intl.RelativeTimeFormat = original;
  }
});

test('formatInstant renders a local weekday time and survives a bad time zone', () => {
  assert.equal(home.formatInstant(iso(2 * DAY + 2 * HOUR), fmt), 'Wed, Oct 21, 02:00 PM UTC');
  assert.match(home.formatInstant(iso(0), { locale: 'en-US', timeZone: 'Not/AZone' }), /Oct 19/);
  assert.match(home.formatInstant(iso(0)), /\d/);
  assert.equal(home.formatInstant('garbage'), '');
  assert.equal(home.formatInstant(''), '');
});

test('formatInstant falls back to ISO when Intl.DateTimeFormat is unusable', () => {
  const original = Intl.DateTimeFormat;
  Intl.DateTimeFormat = function Broken() { throw new Error('unsupported'); };
  try {
    assert.equal(home.formatInstant(iso(0), fmt), '2026-10-19T12:00:00.000Z');
  } finally {
    Intl.DateTimeFormat = original;
  }
});

test('cycleWeekLabel replaces ISO week keys with a readable week start', () => {
  assert.equal(home.cycleWeekLabel({ cycleId: '2026-W43', startsAt: '2026-10-19T07:00:00.000Z', timeZone: 'UTC' }, { locale: 'en-US' }), 'Week of Oct 19');
  assert.equal(home.cycleWeekLabel({ startsAt: '2026-10-19T07:00:00.000Z', timeZone: 'Bad/Zone' }, { locale: 'en-US' }), 'Week of Oct 19');
  assert.match(home.cycleWeekLabel({ startsAt: '2026-10-19T07:00:00.000Z' }), /^Week of /);
  assert.equal(home.cycleWeekLabel({ cycleId: '2026-W43' }), '');
  assert.equal(home.cycleWeekLabel(null), '');
});

test('Home week labels use the same day-month style as the setup guide, in the cycle zone', () => {
  // No locale passed: the label matches assets/onboarding-flow.js weekOf().
  assert.equal(home.cycleWeekLabel({ startsAt: '2026-10-25T08:00:00.000Z', timeZone: 'Europe/London' }), 'Week of 25 Oct');
  assert.equal(home.cycleWeekLabel({ startsAt: '2026-10-25T20:00:00.000Z', timeZone: 'Pacific/Kiritimati' }), 'Week of 26 Oct');
  assert.equal(home.cycleWeekPhrase({ startsAt: '2026-10-25T08:00:00.000Z', timeZone: 'Europe/London' }), 'the week of 25 Oct');
  assert.equal(home.cycleWeekPhrase({ cycleId: '2026-W44' }), 'this cycle');
  assert.equal(home.cycleWeekPhrase(null), 'this cycle');
});

test('proposalIsMine recognises self markers and the viewer id only', () => {
  assert.equal(home.proposalIsMine('self', 7), true);
  assert.equal(home.proposalIsMine('partner', 7), false);
  assert.equal(home.proposalIsMine(null, 7), false);
  assert.equal(home.proposalIsMine(undefined, 7), false);
  assert.equal(home.proposalIsMine(7, 7), true);
  assert.equal(home.proposalIsMine('7', 7), true);
  assert.equal(home.proposalIsMine(8, 7), false);
  assert.equal(home.proposalIsMine(0, 0), false);
  assert.equal(home.proposalIsMine(7, null), false);
});

test('nextStep is loading until the server schedule arrives', () => {
  const step = home.nextStep({ schedule: null, now: NOW });
  assert.equal(step.step, 'loading');
  assert.equal(step.action, null);
  assert.equal(home.nextStep().step, 'loading');
});

test('nextStep asks the pair to agree a time when nothing is proposed', () => {
  const step = home.nextStep({ schedule: { proposals: [], agreed_time: null }, partnerName: '  Ada  ', now: NOW });
  assert.equal(step.step, 'agree');
  assert.equal(step.title, 'Agree a time with Ada');
  assert.deepEqual(step.action, { kind: 'propose', label: 'Propose a time' });
  assert.equal(step.joinPrimary, false);
  const unnamed = home.nextStep({ schedule: { proposals: 'nope' }, now: NOW });
  assert.equal(unnamed.title, 'Agree a time with your partner');
});

test('nextStep ignores expired and legacy proposals', () => {
  const step = home.nextStep({
    schedule: { proposals: [
      { proposal_id: 'a', instant: iso(-HOUR), proposed_by: 2 },
      { proposal_id: 'b', legacy: true, value: 'Tuesday-ish', proposed_by: 2 },
      null,
    ] },
    meId: 1, partnerName: 'Ada', now: NOW,
  });
  assert.equal(step.step, 'agree');
});

test('nextStep asks the viewer to review the earliest partner proposal', () => {
  const step = home.nextStep({
    schedule: { proposals: [
      { proposal_id: 'late', instant: iso(3 * DAY), proposed_by: 2 },
      { proposal_id: 'soon', instant: iso(DAY + HOUR), proposed_by: 'partner' },
      { proposal_id: 'mine', instant: iso(2 * HOUR), proposed_by: 1 },
    ] },
    meId: 1, partnerName: 'Ada', now: NOW, ...fmt,
  });
  assert.equal(step.step, 'respond');
  assert.equal(step.title, 'Ada proposed a time');
  assert.equal(step.action.kind, 'review');
  assert.equal(step.action.proposalId, 'soon');
  assert.match(step.detail, /Tue, Oct 20, 01:00 PM UTC \(tomorrow\)/);
  const anonymous = home.nextStep({ schedule: { proposals: [{ instant: iso(DAY), proposed_by: 2 }] }, meId: 1, now: NOW });
  assert.equal(anonymous.title, 'Your partner proposed a time');
  assert.equal(anonymous.action.proposalId, '');
});

test('nextStep waits on the partner after the viewer proposes', () => {
  const schedule = { proposals: [{ proposal_id: 'x', instant: iso(2 * DAY), proposed_by: 'self' }] };
  const step = home.nextStep({ schedule, partnerName: 'Ada', now: NOW, ...fmt });
  assert.equal(step.step, 'waiting');
  assert.equal(step.title, 'Waiting for Ada to accept');
  assert.equal(step.detail, 'You proposed Wed, Oct 21, 12:00 PM UTC (in 2 days).');
  assert.deepEqual(step.action, { kind: 'chat', label: 'Send a message' });
  assert.equal(home.nextStep({ schedule, chatAvailable: false, now: NOW }).action, null);
});

test('nextStep promotes Join once a future time is agreed', () => {
  const step = home.nextStep({ schedule: { agreed_time: iso(2 * DAY), proposals: [] }, partnerName: 'Ada', now: NOW, ...fmt });
  assert.equal(step.step, 'ready');
  assert.equal(step.title, 'Session in 2 days');
  assert.equal(step.joinPrimary, true);
  assert.equal(step.action, null);
  assert.match(step.detail, /with Ada/);
});

test('nextStep marks the session window as live and then past', () => {
  const soon = home.nextStep({ schedule: { agreed_time: iso(10 * 60 * 1000) }, now: NOW });
  assert.equal(soon.step, 'live');
  assert.equal(soon.title, 'Your session starts soon');
  const on = home.nextStep({ schedule: { agreed_time: iso(-30 * 60 * 1000) }, now: NOW });
  assert.equal(on.title, 'Your session has started');
  assert.match(on.detail, /propose a new time/);
  assert.equal(on.joinPrimary, true);
  const past = home.nextStep({ schedule: { agreed_time: iso(-2 * HOUR) }, now: NOW });
  assert.equal(past.step, 'past');
  assert.equal(past.action.kind, 'propose');
  assert.equal(past.joinPrimary, false);
});

test('nextStep explains legacy agreements', () => {
  const step = home.nextStep({ schedule: { agreed_time: null, legacy_agreed_time: 'next tue 6pm' }, now: NOW });
  assert.equal(step.step, 'legacy');
  assert.equal(step.tone, 'warning');
  assert.equal(step.action.kind, 'propose');
});

test('pairStateCopy keeps stable titles and avoids internal jargon', () => {
  const states = ['stale', 'future', 'pending', 'overdue', 'unpublished', 'unavailable', 'missed', 'partner_unavailable', 'error', 'mystery'];
  for (const state of states) {
    const copy = home.pairStateCopy(state, { week: 'the week of 19 Oct', nextCutoff: 'Sun 25 Oct, 08:00 GMT' });
    assert.ok(copy.title && copy.message, state);
    assert.doesNotMatch(copy.message, /snapshot|durable|idempotent|eligibility|\d{4}-W\d{2}/i, state);
    assert.equal(typeof copy.availability, 'boolean');
    assert.equal(typeof copy.retry, 'boolean');
  }
  assert.equal(home.pairStateCopy('unpublished').title, 'Current pairing is not published yet');
  assert.equal(home.pairStateCopy('unavailable').title, 'Unavailable for this cycle');
  assert.equal(home.pairStateCopy('stale').title, 'Previous pairing cycle ended');
  assert.equal(home.pairStateCopy('future').title, 'Future pairing is not active yet');
  assert.equal(home.pairStateCopy('partner_unavailable').title, 'Partner unavailable');
  assert.equal(home.pairStateCopy('mystery').title, 'No current pairing');
});

test('pairStateCopy surfaces the one recovery action per state', () => {
  assert.equal(home.pairStateCopy('missed', { nextCutoff: 'Sun' }).availability, true);
  assert.match(home.pairStateCopy('missed', { nextCutoff: 'Sun' }).message, /before Sun/);
  assert.doesNotMatch(home.pairStateCopy('unavailable').message, /before/);
  assert.match(home.pairStateCopy('unavailable').message, /You’re skipping this cycle\./);
  // The week phrase reads naturally mid-sentence (no "Pairs for Week of …").
  assert.match(home.pairStateCopy('unpublished', { week: 'the week of 19 Oct' }).message, /^Pairs for the week of 19 Oct haven’t been published yet\./);
  assert.equal(home.pairStateCopy('error').retry, true);
  assert.match(home.pairStateCopy('error').title, /temporarily unavailable/);
  assert.equal(home.pairStateCopy('overdue', { canPublishNow: true }).title, 'This week’s pairing needs publishing');
  assert.match(home.pairStateCopy('overdue').message, /circle owner can retry/);
  assert.match(home.pairStateCopy('pending', { scheduled: 'Sun 08:00', recovery: 'Sun 10:00' }).message, /Sun 08:00.*Sun 10:00/);
  assert.match(home.pairStateCopy('pending').title, /scheduled/);
  assert.doesNotMatch(home.pairStateCopy('pending').message, /owner/);
  assert.match(home.pairStateCopy('future', { startsAt: 'Mon' }).message, /Mon/);
  assert.match(home.pairStateCopy('future').message, /week begins/);
});

test('applyNextStep writes the hero copy and button emphasis', () => {
  const nodes = {
    region: new FakeElement('dashNextStep'), title: new FakeElement(), detail: new FakeElement(),
    action: new FakeElement(), join: new FakeElement(),
  };
  const agree = home.nextStep({ schedule: { proposals: [] }, partnerName: 'Ada', now: NOW });
  assert.equal(home.applyNextStep(nodes, agree), true);
  assert.equal(nodes.region.dataset.step, 'agree');
  assert.equal(nodes.region.dataset.tone, 'action');
  assert.equal(nodes.title.textContent, 'Agree a time with Ada');
  assert.equal(nodes.detail.hidden, false);
  assert.equal(nodes.action.hidden, false);
  assert.equal(nodes.action.textContent, 'Propose a time');
  assert.equal(nodes.action.dataset.kind, 'propose');
  assert.equal(nodes.action.className, 'btn');
  assert.equal(nodes.join.className, 'btn secondary');

  const ready = home.nextStep({ schedule: { agreed_time: iso(DAY * 2) }, now: NOW });
  home.applyNextStep(nodes, ready);
  assert.equal(nodes.action.hidden, true);
  assert.equal(nodes.action.textContent, '');
  assert.equal(nodes.action.dataset.proposalId, '');
  assert.equal(nodes.join.className, 'btn');

  const loading = home.nextStep({ now: NOW });
  home.applyNextStep(nodes, loading);
  assert.equal(nodes.detail.hidden, true);
  assert.equal(nodes.join.className, 'btn');

  const minimal = { region: new FakeElement() };
  assert.equal(home.applyNextStep(minimal, { ...agree, joinPrimary: true }), true);
  assert.equal(home.applyNextStep({}, agree), false);
  assert.equal(home.applyNextStep(null, agree), false);
  assert.equal(home.applyNextStep(nodes, null), false);
});

test('syncDiagnostics mirrors the admin logs widget visibility', () => {
  const wrapper = new FakeElement('dashDiagnostics');
  const area = new FakeElement('logsArea');
  area.style.display = 'none';
  const doc = fakeDocument({ dashDiagnostics: wrapper, logsArea: area });
  assert.equal(home.syncDiagnostics(doc), false);
  assert.equal(wrapper.hidden, true);
  area.style.display = 'block';
  assert.equal(home.syncDiagnostics(doc), true);
  assert.equal(wrapper.hidden, false);
  area.hidden = true;
  assert.equal(home.syncDiagnostics(doc), false);
  assert.equal(home.syncDiagnostics(fakeDocument({ logsArea: area })), false);
  assert.equal(home.syncDiagnostics(null), false);
  assert.equal(home.syncDiagnostics(fakeDocument({ dashDiagnostics: wrapper })), false);
});

test('installDiagnostics observes the logs widget style', () => {
  const wrapper = new FakeElement('dashDiagnostics');
  const area = new FakeElement('logsArea');
  area.style.display = 'none';
  const observed = [];
  class FakeObserver {
    constructor(callback) { this.callback = callback; observed.push(this); }
    observe(target, options) { this.target = target; this.options = options; }
  }
  const sync = home.installDiagnostics({ document: fakeDocument({ dashDiagnostics: wrapper, logsArea: area }), MutationObserverImpl: FakeObserver });
  assert.equal(typeof sync, 'function');
  assert.equal(wrapper.hidden, true);
  assert.equal(observed[0].target, area);
  assert.deepEqual(observed[0].options.attributeFilter, ['style', 'hidden']);
  area.style.display = 'block';
  observed[0].callback();
  assert.equal(wrapper.hidden, false);
  assert.equal(home.installDiagnostics({ document: fakeDocument({}) }), null);
  assert.equal(home.installDiagnostics({ document: null }), null);
  const noObserver = home.installDiagnostics({ document: fakeDocument({ dashDiagnostics: wrapper, logsArea: area }), MutationObserverImpl: null });
  assert.equal(typeof noObserver, 'function');
});

test('the browser build installs diagnostics on load', () => {
  const source = readFileSync(new URL('../../assets/home-dashboard.js', import.meta.url), 'utf8');
  const wrapper = new FakeElement('dashDiagnostics');
  const area = new FakeElement('logsArea');
  area.style.display = 'block';
  wrapper.hidden = true;
  const loadingDoc = fakeDocument({ dashDiagnostics: wrapper, logsArea: area }, 'loading');
  const browser = vm.createContext({ document: loadingDoc, Intl });
  browser.window = browser;
  vm.runInContext(source, browser, { filename: 'assets/home-dashboard.js' });
  assert.equal(typeof browser._randori_home_ui.nextStep, 'function');
  assert.equal(wrapper.hidden, true);
  loadingDoc.listeners.DOMContentLoaded();
  assert.equal(wrapper.hidden, false);

  wrapper.hidden = true;
  const ready = vm.createContext({ document: fakeDocument({ dashDiagnostics: wrapper, logsArea: area }), Intl });
  ready.window = ready;
  vm.runInContext(source, ready, { filename: 'assets/home-dashboard.js' });
  assert.equal(wrapper.hidden, false);
});

test('index.html loads the module synchronously and keeps the dashboard hooks', () => {
  const html = readFileSync(new URL('../../index.html', import.meta.url), 'utf8');
  assert.match(html, /<script src="\/assets\/home-dashboard\.js"><\/script>/);
  for (const id of ['dashEmpty', 'dashPairArea', 'dashScheduleArea', 'dashChatArea', 'dashStatsGrid', 'dashDiagnostics', 'logsArea', 'dashSetAvailability', 'dashRetry', 'dashLoading']) {
    assert.match(html, new RegExp(`id="${id}"`), id);
  }
  // Sign out lives in the account menu, not the page body.
  assert.doesNotMatch(html, /id="dashSignOut"/);
  const dashboard = html.slice(html.indexOf('<section id="view-dashboard"'), html.indexOf('<!-- CIRCLE -->'));
  assert.ok(dashboard.indexOf('id="dashEmpty"') < dashboard.indexOf('id="dashStatsGrid"'), 'the hero precedes the stats');
  assert.ok(dashboard.indexOf('id="dashDiagnostics"') > dashboard.indexOf('id="recentRunsArea"'), 'diagnostics are last');
});
