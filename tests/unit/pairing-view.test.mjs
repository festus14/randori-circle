import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

await import('../../assets/pairing-view.js');
const view = globalThis._randori_pairing_view;
const html = await readFile(new URL('../../index.html', import.meta.url), 'utf8');

const LOCALE = 'en-GB';
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

function cycle(overrides = {}) {
  return {
    cycleId: '2026-W39',
    startsAt: '2026-09-20T17:00:00.000Z',
    endsAt: '2026-09-27T17:00:00.000Z',
    cutoffAt: '2026-09-20T17:00:00.000Z',
    timeZone: 'Europe/London',
    state: 'upcoming',
    ...overrides,
  };
}

function availability(overrides = {}) {
  return {
    cycle: cycle(),
    cycleKey: 'a'.repeat(64),
    isAvailable: true,
    version: 3,
    source: 'user',
    editable: true,
    updatedAt: '2026-09-18T10:00:00.000Z',
    ...overrides,
  };
}

function publication(overrides = {}) {
  return {
    state: 'pending',
    cycle_key: 'b'.repeat(64),
    observed_at: '2026-09-20T16:00:00.000Z',
    scheduled_at: '2026-09-20T17:00:00.000Z',
    recovery_at: '2026-09-20T17:30:00.000Z',
    published_at: null,
    time_zone: 'Europe/London',
    ...overrides,
  };
}

const beforeCutoff = Date.parse('2026-09-18T15:00:00.000Z');

test('the module installs one frozen global and the page loads it before the app script', () => {
  assert.ok(Object.isFrozen(view));
  assert.match(html, /<script src="\/assets\/pairing-view\.js"><\/script>/);
  assert.ok(html.indexOf('/assets/pairing-view.js') < html.indexOf('function renderAvailability()'));
});

test('ISO cycle ids become human week labels', () => {
  assert.equal(view.weekNumber('2026-W39'), 39);
  assert.equal(view.weekNumber('2026-W01'), 1);
  assert.equal(view.weekNumber('2026-W54'), null);
  assert.equal(view.weekNumber('2026-W00'), null);
  assert.equal(view.weekNumber('nope'), null);
  assert.equal(view.weekNumber(undefined), null);
  assert.equal(view.weekLabel('2026-W39'), 'week 39');
  assert.equal(view.weekLabel('2026-W39', { capitalize: true }), 'Week 39');
  assert.equal(view.weekLabel(''), 'this cycle');
  assert.equal(view.weekLabel(null, { capitalize: true }), 'This cycle');
});

test('dates format in the cycle time zone without raw ISO strings', () => {
  assert.match(view.formatDay('2026-09-20T17:00:00.000Z', 'Europe/London', LOCALE), /^Sun,? 20 Sept? 2026$/);
  const day = view.formatDay('2026-09-20T23:30:00.000Z', 'Pacific/Auckland', LOCALE);
  assert.match(day, /Mon/);
  assert.match(day, /21/);
  assert.match(day, /2026/);
  const moment = view.formatMoment('2026-09-20T17:00:00.000Z', 'Europe/London', LOCALE);
  assert.match(moment, /18:00/);
  assert.match(moment, /BST|GMT\+1/);
  assert.doesNotMatch(moment, /T17:00/);
  assert.equal(view.formatDay('not a date', 'Europe/London', LOCALE), 'an unknown time');
  // An invalid zone falls back to the viewer's zone instead of throwing.
  assert.match(view.formatDay('2026-09-20T12:00:00.000Z', 'Mars/Olympus', LOCALE), /2026/);
});

test('the cutoff countdown rounds down and never promises extra time', () => {
  const cutoff = '2026-09-20T17:00:00.000Z';
  const end = Date.parse(cutoff);
  assert.deepEqual(view.countdown(cutoff, end - (2 * DAY + 5 * HOUR + 59 * 60 * 1000)),
    { closed: false, urgent: false, text: '2 days 5 hours left' });
  assert.deepEqual(view.countdown(cutoff, end - 3 * DAY), { closed: false, urgent: false, text: '3 days left' });
  assert.deepEqual(view.countdown(cutoff, end - (DAY + HOUR)), { closed: false, urgent: false, text: '1 day 1 hour left' });
  assert.deepEqual(view.countdown(cutoff, end - 5 * HOUR - 1), { closed: false, urgent: true, text: '5 hours left' });
  assert.deepEqual(view.countdown(cutoff, end - HOUR), { closed: false, urgent: true, text: '1 hour left' });
  assert.deepEqual(view.countdown(cutoff, end - 30 * 60 * 1000), { closed: false, urgent: true, text: '30 minutes left' });
  assert.deepEqual(view.countdown(cutoff, end - 1000), { closed: false, urgent: true, text: '1 minute left' });
  assert.deepEqual(view.countdown(cutoff, end), { closed: true, urgent: false, text: '' });
  assert.deepEqual(view.countdown('garbage', end), { closed: false, urgent: false, text: '' });
  assert.deepEqual(view.countdown(cutoff, Number.NaN), { closed: false, urgent: false, text: '' });
  assert.equal(view.countdown(end, end - 2 * HOUR).text, '2 hours left');
});

test('initials and avatar ink stay readable', () => {
  assert.equal(view.initials('Ada Lovelace'), 'AL');
  assert.equal(view.initials('ada'), 'AD');
  assert.equal(view.initials('Grace Brewster Hopper'), 'GH');
  assert.equal(view.initials('   '), '?');
  assert.equal(view.avatarInk('#ffffff'), '#0B0D12');
  assert.equal(view.avatarInk('#fff'), '#0B0D12');
  assert.equal(view.avatarInk('#101010'), '#FFFFFF');
  assert.equal(view.avatarInk('var(--accent)'), '');
  assert.equal(view.avatarInk(null), '');
});

test('signed-out availability exposes no controls', () => {
  const model = view.availabilityView();
  assert.equal(model.visible, false);
  assert.equal(model.available.disabled, true);
  assert.equal(model.skip.disabled, true);
  assert.equal(model.retry.hidden, true);
  assert.equal(model.status, '');
});

test('availability without an authoritative value shows loading or a retryable error', () => {
  const loading = view.availabilityView({ signedIn: true, loading: true });
  assert.equal(loading.visible, false, 'placeholders stay hidden until the first result');
  assert.equal(loading.busy, true);
  assert.equal(loading.badge.text, 'Loading…');
  assert.match(loading.cycleText, /Loading the upcoming pairing cycle/);
  assert.equal(loading.retry.hidden, true);

  const failed = view.availabilityView({ signedIn: true, error: 'Weekly availability is temporarily unavailable. Try again.' });
  assert.equal(failed.visible, true);
  assert.equal(failed.badge.text, "Couldn't load");
  assert.equal(failed.badge.tone, 'danger');
  assert.equal(failed.status, 'Weekly availability is temporarily unavailable. Try again.');
  assert.equal(failed.retry.hidden, false);
  assert.equal(failed.retry.disabled, false);
  assert.equal(failed.available.disabled, true);
  assert.equal(failed.note, null);

  const retrying = view.availabilityView({ signedIn: true, error: 'x', loading: true });
  assert.equal(retrying.retry.disabled, true);

  const offline = view.availabilityView({ signedIn: true, error: 'x', online: false });
  assert.equal(offline.note, null, 'the page-level offline banner is not repeated');
  assert.equal(offline.status, "You're offline. Reconnect, then retry.");
  assert.equal(view.availabilityView({ signedIn: true, loading: true, online: false }).status, '');
});

test('a saved choice is a dated, explicit decision with a cutoff countdown', () => {
  const model = view.availabilityView({
    signedIn: true, value: availability(), now: beforeCutoff, locale: LOCALE,
  });
  assert.equal(model.visible, true);
  assert.equal(model.title, 'Are you in for week 39?');
  assert.deepEqual(model.badge, { text: "Saved · You're in", tone: 'success' });
  assert.match(model.decision, /^Saved choice: you're in for week 39\./);
  assert.match(model.cycleText, /^Upcoming cycle starts .*2026 and ends .*2026\.$/);
  assert.match(model.cutoffText, /^Decide by .*18:00.* \(Europe\/London\) · 2 days 2 hours left\.$/);
  assert.equal(model.cutoffUrgent, false);
  assert.deepEqual(model.available, { disabled: false, pressed: true, text: "I'm in" });
  assert.deepEqual(model.skip, { disabled: false, pressed: false, text: 'Skip this cycle' });
  assert.equal(model.note, null, 'no leftover banner for a saved choice');
  assert.doesNotMatch(JSON.stringify(model), /2026-W39|T17:00/);
});

test('skipping is saved per cycle and the badge stays neutral', () => {
  const model = view.availabilityView({
    signedIn: true, value: availability({ isAvailable: false }), now: beforeCutoff, locale: LOCALE,
  });
  assert.deepEqual(model.badge, { text: 'Saved · Skipping', tone: 'neutral' });
  assert.match(model.decision, /skipping week 39\. Only this cycle is affected/);
  assert.equal(model.skip.pressed, true);
  assert.equal(model.available.pressed, false);
});

test('inherited values are never shown as a saved choice', () => {
  const fallback = view.availabilityView({
    signedIn: true, value: availability({ source: 'cycle_default', version: 0, updatedAt: null }), now: beforeCutoff, locale: LOCALE,
  });
  assert.deepEqual(fallback.badge, { text: 'Not saved · Included', tone: 'warning' });
  assert.match(fallback.decision, /includes you by default/);
  assert.equal(fallback.available.pressed, false);
  assert.equal(fallback.skip.pressed, false);

  const legacy = view.availabilityView({
    signedIn: true, value: availability({ source: 'legacy_bridge', isAvailable: false, version: 0 }), now: beforeCutoff, locale: LOCALE,
  });
  assert.deepEqual(legacy.badge, { text: 'Not saved · Skipping', tone: 'warning' });
  assert.match(legacy.decision, /previous account setting counts you as skipping/);

  const legacyClosed = view.availabilityView({
    signedIn: true, value: availability({ source: 'legacy_bridge', editable: false, version: 0 }), locale: LOCALE,
  });
  assert.match(legacyClosed.decision, /previous account setting counted you as available, and the cutoff has passed/);
  assert.equal(legacyClosed.badge.text, 'Closed · Not saved');

  const defaultClosed = view.availabilityView({
    signedIn: true, value: availability({ source: 'cycle_default', editable: false, version: 0 }), locale: LOCALE,
  });
  assert.match(defaultClosed.decision, /includes you by default, and the cutoff has passed/);
});

test('a closed cycle disables both choices and explains why', () => {
  const model = view.availabilityView({
    signedIn: true, value: availability({ editable: false }), now: beforeCutoff, locale: LOCALE,
  });
  assert.deepEqual(model.badge, { text: 'Closed · Saved', tone: 'neutral' });
  assert.equal(model.available.disabled, true);
  assert.equal(model.skip.disabled, true);
  assert.equal(model.cutoffText, 'The cutoff for week 39 has passed.');
  assert.match(model.decision, /The cutoff has passed/);
  assert.equal(model.cutoffUrgent, false);
});

test('saving shows the pending choice and locks both actions', () => {
  const skip = view.availabilityView({
    signedIn: true, value: availability(), saving: true, pendingValue: false, now: beforeCutoff, locale: LOCALE,
  });
  assert.equal(skip.busy, true);
  assert.deepEqual(skip.badge, { text: 'Saving: skip…', tone: 'info' });
  assert.equal(skip.skip.text, 'Saving…');
  assert.equal(skip.available.text, "I'm in");
  assert.equal(skip.available.disabled, true);
  assert.equal(skip.available.pressed, true, 'pressed reflects the saved server value until it changes');

  const join = view.availabilityView({
    signedIn: true, value: availability({ isAvailable: false }), saving: true, pendingValue: true, locale: LOCALE,
  });
  assert.equal(join.badge.text, "Saving: I'm in…");
  assert.equal(join.available.text, 'Saving…');

  const unknownPending = view.availabilityView({
    signedIn: true, value: availability({ isAvailable: false }), saving: true, locale: LOCALE,
  });
  assert.equal(unknownPending.badge.text, 'Saving: skip…');
});

test('offline keeps the saved choice visible but disables changes with a reason', () => {
  const model = view.availabilityView({
    signedIn: true, value: availability(), online: false, now: beforeCutoff, locale: LOCALE,
  });
  assert.equal(model.available.disabled, true);
  assert.equal(model.skip.disabled, true);
  assert.equal(model.available.pressed, true);
  assert.match(model.note.text, /offline.*reconnect to change it/i);
});

test('the last hour before the cutoff is marked urgent', () => {
  const value = availability();
  const model = view.availabilityView({
    signedIn: true, value, now: Date.parse(value.cycle.cutoffAt) - 20 * 60 * 1000, locale: LOCALE,
  });
  assert.equal(model.cutoffUrgent, true);
  assert.match(model.cutoffText, /20 minutes left\.$/);

  const past = view.availabilityView({
    signedIn: true, value, now: Date.parse(value.cycle.cutoffAt) + 1000, locale: LOCALE,
  });
  assert.match(past.cutoffText, /\(Europe\/London\)\.$/, 'server still says editable: no countdown, no contradiction');
});

test('notices and errors surface as status text', () => {
  const notice = view.availabilityView({
    signedIn: true, value: availability(), notice: 'The pairing cycle changed.', locale: LOCALE,
  });
  assert.equal(notice.status, 'The pairing cycle changed.');
  const error = view.availabilityView({
    signedIn: true, value: availability(), error: 'Availability was not saved.', notice: 'ignored', locale: LOCALE,
  });
  assert.equal(error.status, 'Availability was not saved.');
});

test('saved toasts use week labels', () => {
  assert.equal(view.savedToast(availability()), "You're in for week 39");
  assert.equal(view.savedToast(availability({ isAvailable: false })), 'Skipping week 39');
  assert.equal(view.savedToast(null), 'Availability saved');
});

test('owner tools are only visible to owners or when recovery is allowed', () => {
  assert.equal(view.publicationView({ signedIn: true }).visible, false);
  assert.equal(view.publicationView({ signedIn: false, isOwner: true }).visible, false);
  assert.equal(view.publicationView({ signedIn: true, isOwner: true }).visible, true);
  assert.equal(view.publicationView({ signedIn: true, allowed: true }).visible, true);
});

test('owner publication states are distinct and the action is idempotent-retry aware', () => {
  const checking = view.publicationView({ signedIn: true, isOwner: true });
  assert.equal(checking.state, 'loading');
  assert.equal(checking.button.hidden, true);

  const unknown = view.publicationView({ signedIn: true, isOwner: true, loadFailed: true });
  assert.equal(unknown.state, 'unknown');
  assert.equal(unknown.tone, 'danger');
  assert.doesNotMatch(unknown.text, /published/i, 'a failed read never claims publication');

  const pending = view.publicationView({ signedIn: true, isOwner: true, publication: publication(), locale: LOCALE });
  assert.equal(pending.state, 'pending');
  assert.match(pending.text, /publish automatically at .*18:00.*publish manually from .*18:30/);

  const published = view.publicationView({
    signedIn: true, isOwner: true, locale: LOCALE,
    publication: publication({ state: 'published', published_at: '2026-09-20T17:00:05.000Z' }),
  });
  assert.equal(published.state, 'published');
  assert.equal(published.tone, 'success');
  assert.equal(published.button.hidden, true);

  const overdue = view.publicationView({
    signedIn: true, isOwner: true, allowed: true, locale: LOCALE,
    publication: publication({ state: 'overdue', can_publish_now: true }),
  });
  assert.equal(overdue.state, 'overdue');
  assert.deepEqual(overdue.button, { hidden: false, disabled: false, text: 'Publish now' });
  assert.match(overdue.text, /retrying is safe/);

  const retry = view.publicationView({
    signedIn: true, isOwner: true, allowed: true, retryReady: true,
    publication: publication({ state: 'overdue', can_publish_now: true }),
  });
  assert.equal(retry.button.text, 'Retry publication');
  assert.match(retry.text, /last attempt failed/);

  const publishing = view.publicationView({ signedIn: true, isOwner: true, allowed: true, publishing: true, publication: publication({ state: 'overdue' }) });
  assert.equal(publishing.state, 'publishing');
  assert.deepEqual(publishing.button, { hidden: false, disabled: true, text: 'Publishing…' });

  const notAllowed = view.publicationView({
    signedIn: true, isOwner: true, publication: publication({ state: 'overdue', can_publish_now: false }),
  });
  assert.equal(notAllowed.button.hidden, true);
  assert.match(notAllowed.text, /isn't available for this circle/);
});

test('owner hints show the next cutoff, or the offline reason when publishing is blocked', () => {
  const upcoming = cycle({ cutoffAt: '2026-09-27T17:00:00.000Z' });
  const hint = view.publicationView({ signedIn: true, isOwner: true, upcoming, locale: LOCALE });
  assert.match(hint.hint, /^Next cutoff: .*18:00/);
  const offline = view.publicationView({
    signedIn: true, isOwner: true, allowed: true, online: false, upcoming,
    publication: publication({ state: 'overdue', can_publish_now: true }),
  });
  assert.equal(offline.button.disabled, true);
  assert.equal(offline.hint, "You're offline. Reconnect to publish.");
  assert.equal(view.publicationView({ signedIn: true, isOwner: true }).hint, '');
});

test('pairs status copy matches each failure and never shows cached pairs', () => {
  const failed = view.pairsStatusView('load-error');
  assert.equal(failed.tone, 'danger');
  assert.equal(failed.retry, true);
  assert.match(failed.body, /Local or cached pairs are not shown/);
  const offline = view.pairsStatusView('load-error', { online: false });
  assert.equal(offline.title, "You're offline");
  assert.match(offline.body, /Local or cached pairs are not shown/);

  const unverified = view.pairsStatusView('unverified');
  assert.match(unverified.meta, /could not be confirmed/);
  assert.doesNotMatch(`${unverified.meta} ${unverified.body}`, /server state|verified/);
  assert.equal(unverified.retry, true);

  assert.match(view.pairsStatusView('future').meta, /not started/);
  assert.match(view.pairsStatusView('stale').meta, /ended/);
  assert.match(view.pairsStatusView('invalid').meta, /could not be confirmed/);
  assert.doesNotMatch(view.pairsStatusView('future').meta, /returned/);

  const loading = view.pairsStatusView('loading');
  assert.equal(loading.retry, false);
  assert.match(loading.meta, /Loading/);
});

test('unpublished pairs explain the schedule for members and owners', () => {
  const upcoming = cycle({ cutoffAt: '2026-09-27T17:00:00.000Z' });
  const none = view.pairsStatusView('unpublished', { cycleId: '2026-W38', upcoming, locale: LOCALE });
  assert.match(none.meta, /^Week 38 · pairs not published yet · next cutoff /);
  assert.equal(none.body, 'No pairings have been published for the current cycle.');
  const noNext = view.pairsStatusView('unpublished', { cycleId: '2026-W38' });
  assert.equal(noNext.meta, 'Week 38 · pairs not published yet');

  const pending = view.pairsStatusView('unpublished', { cycleId: '2026-W38', publication: publication(), locale: LOCALE });
  assert.match(pending.meta, /^Week 38 · pairs publish .*18:00/);
  assert.match(pending.body, /publish automatically/);

  const overdueOwner = view.pairsStatusView('unpublished', {
    cycleId: '2026-W38', allowed: true, publication: publication({ state: 'overdue' }),
  });
  assert.equal(overdueOwner.tone, 'warning');
  assert.match(overdueOwner.meta, /publication is late/);
  assert.match(overdueOwner.body, /not published automatically.*Publish now in Owner tools/);

  const overdueMember = view.pairsStatusView('unpublished', { cycleId: '2026-W38', publication: publication({ state: 'overdue' }) });
  assert.match(overdueMember.body, /circle owner can publish it now/);
});

test('published meta counts pairs with a friendly start date', () => {
  assert.match(view.publishedMeta({ cycleId: '2026-W38', count: 3, startsAt: '2026-09-13T17:00:00.000Z', timeZone: 'Europe/London', locale: LOCALE }),
    /^Week 38 · 3 pairs · started .*2026$/);
  assert.equal(view.publishedMeta({ cycleId: '2026-W38', count: 1 }), 'Week 38 · 1 pair');
  assert.equal(view.publishedMeta({ count: -2 }), 'This cycle · 0 pairs');
  assert.equal(view.publishedMeta(), 'This cycle · 0 pairs');
});

test('pair members mark the viewer and collapse solo practice', () => {
  const pair = {
    pg_id: 30, a_id: 1, b_id: 2, a_name: 'Circle Owner', b_name: 'Current Partner', a_color: '#ffffff', b_color: '#000000',
    members: [{ id: 1, name: 'Circle Owner', color: '#ffffff' }, { id: 2, name: 'Current Partner', color: '#000000', is_ai: false }],
    is_ai: false,
  };
  const mine = view.pairMembers(pair, 1);
  assert.equal(mine.mine, true);
  assert.equal(mine.solo, false);
  assert.deepEqual(mine.members.map(member => [member.name, member.initials, member.isMe]), [
    ['Circle Owner', 'CO', true], ['Current Partner', 'CP', false],
  ]);
  assert.equal(view.pairMembers(pair, 9).mine, false);
  assert.equal(view.pairMembers(pair, null).mine, false);

  const legacy = view.pairMembers({ a_id: 4, b_id: 5, a_name: 'A Person', b_name: '' }, 5);
  assert.deepEqual(legacy.members.map(member => member.name), ['A Person', 'Member']);
  assert.equal(legacy.mine, true);

  const solo = view.pairMembers({
    a_id: 4, b_id: null, is_ai: true,
    members: [{ id: 4, name: 'Solo Person' }, { id: null, name: 'Solo practice', is_ai: true }],
  }, 4);
  assert.equal(solo.solo, true);
  assert.deepEqual(solo.members.map(member => member.name), ['Solo Person']);

  const coordination = view.pairMembers({ solo: true, members: [{ id: 7, name: 'Ada Partner' }, null] }, 3);
  assert.equal(coordination.solo, true);
  assert.deepEqual(coordination.members.map(member => member.name), ['Ada Partner']);
  assert.equal(coordination.identityKnown, true);
  const withheld = view.pairMembers({ members: [{ name: 'Ada Partner' }, { name: 'Viewer' }] }, 3);
  assert.equal(withheld.mine, false);
  assert.equal(withheld.identityKnown, false, 'ids withheld: the viewer cannot be identified');
  assert.equal(mine.identityKnown, true);
});

test('the pairing view keeps its test hooks and drops the browser-state framing', () => {
  for (const id of ['availabilityWrap', 'availTitle', 'availLabel', 'availDecision', 'availCycle', 'availCutoff',
    'availActions', 'availAvailable', 'availSkip', 'availBanner', 'availExplan', 'availRetry', 'pairsList',
    'currentWeekMeta', 'newWeekBtn', 'demoRunBtn', 'demoResetBtn', 'syncStatus', 'presencePanel']) {
    assert.match(html, new RegExp(`id="${id}"`), id);
  }
  const section = html.slice(html.indexOf('<section id="view-pair"'), html.indexOf('<section id="view-code"'));
  assert.doesNotMatch(section, /browser state|Browser-tab|✦/i);
  assert.match(section, /id="pairOwnerPanel"[^>]+hidden/);
  assert.match(section, /<details id="pairDiagnostics"[^>]+hidden/);
  assert.ok(section.indexOf('id="demoRunBtn"') > section.indexOf('id="pairDiagnostics"'), 'demo tools sit inside Diagnostics');
  assert.ok(section.indexOf('id="newWeekBtn"') > section.indexOf('id="pairOwnerPanel"'), 'publish lives in Owner tools');
});

test('room labels never show the raw pair room id', () => {
  assert.equal(view.roomLabel('week_12_pair_34'), 'Pair room');
  assert.equal(view.roomLabel(''), 'room —');
  assert.equal(view.roomLabel(null), 'room —');
  assert.equal(view.roomLabel('week_0_pair_1'), 'room —');
});
