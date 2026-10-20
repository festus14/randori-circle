import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

await import('../../assets/onboarding-flow.js');
const flow = globalThis._randori_onboarding_flow;

const upcoming = (overrides = {}) => ({
  cycleId: '2026-W44',
  startsAt: '2026-10-25T08:00:00.000Z',
  endsAt: '2026-11-01T08:00:00.000Z',
  cutoffAt: '2026-10-25T08:00:00.000Z',
  timeZone: 'Europe/London',
  state: 'upcoming',
  ...overrides,
});
const availability = (overrides = {}) => ({
  cycle: upcoming(),
  cycleKey: 'a'.repeat(64),
  isAvailable: true,
  version: 0,
  source: 'cycle_default',
  editable: true,
  updatedAt: null,
  ...overrides,
});

class FakeNode {
  constructor(tag) {
    this.tag = tag;
    this.children = [];
    this.attributes = new Map();
    this.dataset = {};
    this.className = '';
    this.textContent = '';
  }
  setAttribute(name, value) { this.attributes.set(name, String(value)); }
  getAttribute(name) { return this.attributes.has(name) ? this.attributes.get(name) : null; }
  append(...nodes) { this.children.push(...nodes); }
  replaceChildren(...nodes) { this.children = nodes; }
}
const fakeDoc = { createElement: tag => new FakeNode(tag) };

test('exposes a frozen API with the five spec steps in order', () => {
  assert.ok(Object.isFrozen(flow));
  assert.deepEqual(flow.STEPS.map(step => step.key), ['invite', 'account', 'profile', 'availability', 'next']);
  assert.equal(flow.stepIndex('availability'), 3);
  assert.equal(flow.stepIndex('missing'), -1);
});

test('stepper model marks earlier steps done and the current step', () => {
  const model = flow.stepperModel('profile');
  assert.equal(model.text, 'Step 3 of 5');
  assert.equal(model.total, 5);
  assert.deepEqual(model.items.map(item => item.state), ['done', 'done', 'current', 'upcoming', 'upcoming']);
  assert.equal(flow.stepperModel('nonsense').current, 'invite');
  assert.equal(flow.stepperModel('next').text, 'Step 5 of 5');
});

test('renderStepper builds an ordered list with aria-current="step" and status text', () => {
  const list = new FakeNode('ol');
  const status = new FakeNode('p');
  const model = flow.renderStepper(list, status, 'availability', fakeDoc);
  assert.equal(model.index, 3);
  assert.equal(status.textContent, 'Step 4 of 5');
  assert.equal(list.children.length, 5);
  assert.equal(list.dataset.current, 'availability');
  const current = list.children.filter(li => li.getAttribute('aria-current') === 'step');
  assert.equal(current.length, 1);
  assert.equal(current[0].dataset.step, 'availability');
  const [marker, label, sr] = list.children[0].children;
  assert.equal(marker.textContent, '✓');
  assert.equal(marker.getAttribute('aria-hidden'), 'true');
  assert.equal(label.textContent, 'Invitation');
  assert.equal(sr.textContent, ' (done)');
  assert.equal(list.children[3].children[2].textContent, ' (current step)');
  assert.equal(list.children[4].children[0].textContent, '5');
  assert.equal(list.children[4].children[2].textContent, '');
  // Missing nodes are tolerated.
  assert.equal(flow.renderStepper(null, null, 'profile', fakeDoc).text, 'Step 3 of 5');
  assert.equal(flow.renderStepper(list, null, 'profile', null).index, 2);
});

test('week labels use human dates instead of ISO week codes', () => {
  assert.equal(flow.weekOf(upcoming()), 'Week of 25 Oct');
  assert.equal(flow.weekOf(upcoming({ timeZone: 'Pacific/Kiritimati', startsAt: '2026-10-25T20:00:00.000Z' })), 'Week of 26 Oct');
  assert.equal(flow.weekOf(upcoming({ timeZone: 'Not/AZone' })), 'Week of 25 Oct');
  assert.equal(flow.weekOf({ startsAt: 'garbage' }), '');
  assert.equal(flow.weekOf(null), '');
  assert.equal(flow.weekOf({ startsAt: Date.parse('2026-10-25T08:00:00Z'), timeZone: 'UTC' }), 'Week of 25 Oct');
  assert.equal(flow.weekOf({ startsAt: Number.NaN }), '');
  assert.equal(flow.weekPhrase(upcoming()), 'the week of 25 Oct');
  assert.equal(flow.weekPhrase(null), 'the upcoming cycle');
  assert.equal(flow.weekPhrase(undefined, 'the current cycle'), 'the current cycle');
  assert.doesNotMatch(flow.weekPhrase(upcoming()), /W44/);
});

test('formatMoment renders the instant in the member time zone and tolerates bad input', () => {
  assert.match(flow.formatMoment('2026-10-25T08:00:00.000Z', 'Europe/London'), /^Sun 25 Oct,? 08:00 GMT$/);
  assert.match(flow.formatMoment('2026-10-25T08:00:00.000Z', 'Asia/Tokyo'), /17:00/);
  assert.match(flow.formatMoment('2026-10-25T08:00:00.000Z', 'Bad/Zone'), /25 Oct/);
  assert.equal(flow.formatMoment('nope', 'UTC'), '');
  assert.equal(flow.formatMoment('', 'UTC'), '');
});

test('time zone detection and validation fall back to UTC', () => {
  assert.equal(flow.validTimeZone('Europe/London'), true);
  assert.equal(flow.validTimeZone('Mars/Olympus'), false);
  assert.equal(flow.validTimeZone(''), false);
  assert.equal(flow.validTimeZone(42), false);
  assert.equal(flow.detectTimeZone({ DateTimeFormat: () => ({ resolvedOptions: () => ({ timeZone: 'Asia/Tokyo' }) }) }), 'Asia/Tokyo');
  assert.equal(flow.detectTimeZone({ DateTimeFormat: () => ({ resolvedOptions: () => ({ timeZone: 'Nope/Zone' }) }) }), 'UTC');
  assert.equal(flow.detectTimeZone({ DateTimeFormat: () => { throw new Error('no intl'); } }), 'UTC');
  assert.equal(flow.detectTimeZone(null), 'UTC');
  assert.equal(typeof flow.detectTimeZone(), 'string');
});

test('skip for now saves only the server-required minimum', () => {
  assert.deepEqual(flow.profileMinimum({ name: '  Ada  ', timeZone: 'Europe/London', focus: 'dsa' }), {
    ok: true, payload: { display_name: 'Ada', tz: 'Europe/London', interview_focus: 'dsa' },
  });
  assert.deepEqual(flow.profileMinimum({ accountName: 'Grace Hopper', timeZone: 'Bad/Zone', detectedTimeZone: 'Asia/Tokyo', focus: 'weird' }).payload, {
    display_name: 'Grace Hopper', tz: 'Asia/Tokyo', interview_focus: 'both',
  });
  assert.equal(flow.profileMinimum({ email: 'linus@example.test', detectedTimeZone: 'nope' }).payload.display_name, 'linus');
  assert.equal(flow.profileMinimum({ email: 'linus@example.test', detectedTimeZone: 'nope' }).payload.tz, 'UTC');
  assert.equal(flow.profileMinimum({ name: 'x'.repeat(40) }).payload.display_name.length, 32);
  assert.deepEqual(flow.profileMinimum({}), { ok: false, error: 'Enter a display name to continue.' });
  assert.equal(flow.profileMinimum().ok, false);
});

test('availability step explains saved, inherited, closed and unknown states honestly', () => {
  const loading = flow.availabilityStep(null);
  assert.equal(loading.next, 'Decide later');
  assert.equal(loading.decided, false);
  assert.match(loading.lead, /Checking/);

  const inherited = flow.availabilityStep(availability(), { timeZone: 'Europe/London' });
  assert.equal(inherited.title, 'Are you in for the week of 25 Oct?');
  assert.equal(inherited.next, 'Decide later');
  assert.match(inherited.note, /Not decided yet/);
  assert.match(inherited.note, /Choose by Sun 25 Oct,? 08:00 GMT your time/);
  assert.match(inherited.note, /you’re counted as in \(the circle default\)/);

  const legacySkip = flow.availabilityStep(availability({ source: 'legacy_bridge', isAvailable: false }));
  assert.match(legacySkip.note, /counted as skipping \(your previous setting\)/);

  const saved = flow.availabilityStep(availability({ source: 'user', version: 1 }), { timeZone: 'UTC' });
  assert.equal(saved.decided, true);
  assert.equal(saved.next, 'Continue');
  assert.match(saved.note, /^Saved\. You can change it until /);

  const closed = flow.availabilityStep(availability({ editable: false }));
  assert.equal(closed.next, 'Continue');
  assert.match(closed.note, /cutoff for the week of 25 Oct has passed/);

  const noCutoff = flow.availabilityStep(availability({ cycle: upcoming({ cutoffAt: 'bad' }) }));
  assert.match(noCutoff.note, /Choose by the cutoff/);
  const savedNoCutoff = flow.availabilityStep(availability({ source: 'user', cycle: upcoming({ cutoffAt: 'bad' }) }));
  assert.match(savedNoCutoff.note, /until the cutoff/);
});

test('what happens next is a three-item timeline driven by the upcoming cycle', () => {
  const items = flow.nextSteps(availability({ source: 'user', version: 1 }), { timeZone: 'Europe/London' });
  assert.deepEqual(items.map(item => item.key), ['publish', 'email', 'agree']);
  assert.match(items[0].title, /^Pairings publish Sun 25 Oct,? 08:00 GMT$/);
  assert.match(items[0].detail, /in for the week of 25 Oct/);
  assert.equal(items[1].title, 'You’ll get an email');

  const skipping = flow.nextSteps(availability({ source: 'user', isAvailable: false }), { remindersOn: false });
  assert.match(skipping[0].detail, /You’re skipping the week of 25 Oct/);
  assert.equal(skipping[1].title, 'Check Home for your pair');

  const unknown = flow.nextSteps(null);
  assert.equal(unknown[0].title, 'Pairings publish at the weekly cutoff');
  assert.match(unknown[0].detail, /the next cycle/);
  for (const item of [...items, ...skipping, ...unknown]) assert.doesNotMatch(`${item.title} ${item.detail}`, /W\d\d|\bAI\b|video/i);
});

test('renderTimeline builds DOM nodes with text only', () => {
  const list = new FakeNode('ol');
  const count = flow.renderTimeline(list, [{ key: 'publish', title: '<b>x</b>', detail: 'detail' }], fakeDoc);
  assert.equal(count, 1);
  const [marker, body] = list.children[0].children;
  assert.equal(marker.textContent, '1');
  assert.equal(body.children[0].textContent, '<b>x</b>');
  assert.equal(body.children[0].tag, 'h3');
  assert.equal(body.children[1].textContent, 'detail');
  assert.equal(flow.renderTimeline(null, [], fakeDoc), 0);
  assert.equal(flow.renderTimeline(list, [], null), 0);
});

test('dashboard availability badge never shows week codes', () => {
  assert.equal(flow.availabilityBadge(null), '');
  assert.equal(flow.availabilityBadge(availability()), 'Confirm default for the week of 25 Oct');
  assert.equal(flow.availabilityBadge(availability({ source: 'legacy_bridge' })), 'Confirm inherited choice for the week of 25 Oct');
  assert.equal(flow.availabilityBadge(availability({ source: 'user' })), 'Available for the week of 25 Oct');
  assert.equal(flow.availabilityBadge(availability({ source: 'user', isAvailable: false })), 'Skipping the week of 25 Oct');
  assert.equal(flow.availabilityBadge(availability({ editable: false })), 'Review closed cycle (the week of 25 Oct)');
});

test('setup guide copy reflects authority states with human dates', () => {
  const ready = { status: 'ready', value: availability() };
  const current = { cycleId: '2026-W43', startsAt: '2026-10-18T07:00:00.000Z', timeZone: 'Europe/London' };
  const pending = flow.checklistCopy({
    profile: { status: 'ready' }, availability: ready, pairing: { status: 'ready', value: { cycle: current, paired: false } },
  });
  assert.equal(pending.profile, 'Complete your profile');
  assert.equal(pending.availability, 'Save availability for the week of 25 Oct');
  assert.equal(pending.availabilityAction, 'Confirm or skip');
  assert.equal(pending.availabilityActionLabel, 'Choose availability for the week of 25 Oct');
  assert.equal(pending.pairing, 'Your next pairing appears on Home once it is published');
  assert.equal(pending.room, 'Open your current workspace');

  const done = flow.checklistCopy({
    profile: { status: 'ready' }, availability: { status: 'ready', value: availability({ isAvailable: false }) },
    pairing: { status: 'ready', value: { cycle: current } },
    profileDone: true, availabilityDone: true, pairingDone: true, roomDone: true,
  });
  assert.equal(done.profile, 'Profile saved');
  assert.equal(done.availability, 'Availability saved for the week of 25 Oct');
  assert.equal(done.availabilityAction, 'Confirm skip or change');
  assert.equal(done.pairing, 'Current assignment published for the week of 18 Oct');
  assert.equal(done.room, 'Current workspace opened');

  const loading = flow.checklistCopy({ profile: { status: 'loading' }, availability: { status: 'loading' }, pairing: { status: 'loading' } });
  assert.equal(loading.profile, 'Checking saved profile…');
  assert.equal(loading.availability, 'Checking cycle availability…');
  assert.equal(loading.pairing, 'Checking current pairing…');
  const failed = flow.checklistCopy({ profile: { status: 'error' }, availability: { status: 'error' }, pairing: { status: 'error' } });
  assert.equal(failed.profile, 'Profile status unknown — retry');
  assert.equal(failed.availability, 'Availability status unknown — retry');
  assert.equal(failed.pairing, 'Pairing status unknown — retry');
  assert.equal(flow.checklistCopy().availability, 'Save availability for the upcoming cycle');
  assert.equal(flow.checklistCopy().pairing, 'Your next pairing appears on Home once it is published');
});

test('next unfinished setup step follows authority completion', () => {
  assert.equal(flow.nextSetupStep({}), 'profile');
  assert.equal(flow.nextSetupStep({ profileDone: true }), 'availability');
  assert.equal(flow.nextSetupStep({ profileDone: true, availabilityDone: true }), 'next');
  assert.equal(flow.nextSetupStep(), 'profile');
});

test('members who joined after the cutoff are told when they will be included', () => {
  const current = { startsAt: '2026-10-18T07:00:00.000Z', cutoffAt: '2026-10-18T07:00:00.000Z' };
  assert.equal(flow.joinedAfterCutoff({ createdAt: '2026-10-19T10:00:00.000Z', current }), true);
  assert.equal(flow.joinedAfterCutoff({ createdAt: '2026-10-01T10:00:00.000Z', current }), false);
  assert.equal(flow.joinedAfterCutoff({ createdAt: null, current }), false);
  assert.equal(flow.joinedAfterCutoff({ createdAt: '2026-10-19T10:00:00.000Z', current: { startsAt: '2026-10-18T07:00:00.000Z' } }), true);
  assert.equal(flow.joinedAfterCutoff(), false);

  const copy = flow.newMemberHeroCopy('overdue', { createdAt: '2026-10-19T10:00:00.000Z', current, upcoming: upcoming() });
  assert.equal(copy.title, 'You’ll be included from the week of 25 Oct');
  assert.equal(copy.availability, true);
  assert.doesNotMatch(copy.message, /late/i);
  assert.equal(flow.newMemberHeroCopy('missed', { createdAt: '2026-10-19T10:00:00.000Z', current }).title, 'You’ll be included from the next cycle');
  assert.equal(flow.newMemberHeroCopy('overdue', { createdAt: '2026-10-01T10:00:00.000Z', current }), null);
  assert.equal(flow.newMemberHeroCopy('paired', { createdAt: '2026-10-19T10:00:00.000Z', current }), null);
  assert.equal(flow.newMemberHeroCopy('pending'), null);
});

test('the joined-late hero confirms an availability answer instead of asking again', () => {
  const current = { startsAt: '2026-10-18T07:00:00.000Z', cutoffAt: '2026-10-18T07:00:00.000Z' };
  const next = upcoming();
  const joined = { createdAt: '2026-10-19T10:00:00.000Z', current, upcoming: next };
  const saved = isAvailable => ({ source: 'user', isAvailable, cycle: { cycleId: next.cycleId } });

  const inCopy = flow.newMemberHeroCopy('overdue', { ...joined, availability: saved(true) });
  assert.equal(inCopy.title, 'You’re in for the week of 25 Oct');
  assert.equal(inCopy.availability, false, 'no "Set availability" once answered');
  assert.match(inCopy.message, /email you/);

  const outCopy = flow.newMemberHeroCopy('missed', { ...joined, availability: saved(false) });
  assert.equal(outCopy.title, 'You’re sitting out the week of 25 Oct');
  assert.equal(outCopy.availability, true, 'they can still change their mind');

  // Inherited defaults and answers for another cycle still ask.
  assert.equal(flow.newMemberHeroCopy('overdue', { ...joined, availability: { ...saved(true), source: 'default' } }).availability, true);
  assert.equal(flow.newMemberHeroCopy('overdue', { ...joined, availability: { ...saved(true), cycle: { cycleId: '2026-W01' } } }).availability, true);
  // Without a known upcoming cycle, the member's own answer is trusted.
  assert.equal(flow.newMemberHeroCopy('overdue', { createdAt: joined.createdAt, current, availability: saved(true) }).title, 'You’re in for the next cycle');
});

test('setup guide dismissal is remembered per account only', () => {
  const store = new Map();
  const storage = { getItem: key => store.get(key) ?? null, setItem: (key, value) => store.set(key, value), removeItem: key => store.delete(key) };
  assert.equal(flow.guideDismissKey(7), 'randori-setup-guide-dismissed:7');
  assert.equal(flow.guideDismissKey(0), '');
  assert.equal(flow.guideDismissKey('x'), '');
  assert.equal(flow.guideDismissed(storage, 7), false);
  assert.equal(flow.setGuideDismissed(storage, 7, true), true);
  assert.equal(flow.guideDismissed(storage, 7), true);
  assert.equal(flow.guideDismissed(storage, 8), false);
  assert.equal(flow.setGuideDismissed(storage, 7, false), true);
  assert.equal(flow.guideDismissed(storage, 7), false);
  assert.equal(flow.setGuideDismissed(storage, null, true), false);
  assert.equal(flow.guideDismissed(storage, null), false);
  const broken = { getItem() { throw new Error('denied'); }, setItem() { throw new Error('denied'); } };
  assert.equal(flow.guideDismissed(broken, 7), false);
  assert.equal(flow.setGuideDismissed(broken, 7, true), false);
});

test('fragment tokens are read without throwing', () => {
  assert.equal(flow.fragmentToken('#token=abc'), 'abc');
  assert.equal(flow.fragmentToken('token=abc&x=1'), 'abc');
  assert.equal(flow.fragmentToken('#invite=zzz', 'invite'), 'zzz');
  assert.equal(flow.fragmentToken('#other=1'), '');
  assert.equal(flow.fragmentToken(''), '');
  assert.equal(flow.fragmentToken(undefined), '');
});

test('index.html wires the stepper, removes the banner and tour, and keeps tested ids', async () => {
  const html = await readFile(new URL('../../index.html', import.meta.url), 'utf8');
  assert.match(html, /<script src="\/assets\/onboarding-flow\.js"><\/script>/);
  assert.match(html, /<ol id="setupStepper" class="rc-stepper" aria-label="Setup progress">/);
  assert.match(html, /<ol id="inviteStepper" class="rc-stepper" aria-label="Setup progress">/);
  assert.doesNotMatch(html, /id="welcomeBanner"|id="onboardOverlay"|Restart tour|step 2 of 3/);
  assert.doesNotMatch(html, /#onboardChecklist\[data-state="error"\]:not/);
  for (const id of ['view-profile-setup', 'psName', 'psTz', 'psFocus', 'psSave', 'psSkip', 'psRetry', 'psSaveStatus', 'psRemindEmail', 'psRemindStatus',
    'psAvailabilityLink', 'onboardChecklist', 'chkProfile', 'chkAvail', 'chkAvailAction', 'chkPair', 'chkRoom', 'chkRetry', 'meSetupGuide',
    'setupStepAvailability', 'setupStepNext', 'setupFinish', 'setupTimeline']) {
    assert.match(html, new RegExp(`id="${id}"`), id);
  }
  assert.match(html, /window\.addEventListener\('hashchange'/);
  assert.match(html, /body:not\(\[data-nav="shown"\]\) \.shell > nav\{display:none!important\}/);
});

test('the onboarding steps do not advertise AI or video', async () => {
  const html = await readFile(new URL('../../index.html', import.meta.url), 'utf8');
  const section = html.match(/<section id="view-profile-setup"[\s\S]*?<\/section>/)?.[0] || '';
  assert.ok(section.length > 0);
  assert.doesNotMatch(section, /\bAI\b|Groq|video/i);
});
