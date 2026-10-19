import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

await import('../../assets/landing.js');
const landing = globalThis._randori_landing;

class FakeElement {
  constructor(doc, id, { value = '', hidden = false } = {}) {
    this.doc = doc;
    this.id = id;
    this.value = value;
    this.hidden = hidden;
    this.textContent = '';
    this.disabled = false;
    this.dataset = {};
    this.style = {};
    this.attributes = new Map();
    this.listeners = new Map();
    this.scrolled = [];
    this.clicks = 0;
  }
  setAttribute(name, value) { this.attributes.set(name, String(value)); }
  getAttribute(name) { return this.attributes.has(name) ? this.attributes.get(name) : null; }
  removeAttribute(name) { this.attributes.delete(name); }
  addEventListener(type, handler) {
    if (!this.listeners.has(type)) this.listeners.set(type, []);
    this.listeners.get(type).push(handler);
  }
  dispatch(type, init = {}) {
    const event = { type, defaultPrevented: false, preventDefault() { this.defaultPrevented = true; }, ...init };
    for (const handler of this.listeners.get(type) || []) handler(event);
    return event;
  }
  focus() { this.doc.activeElement = this; }
  click() { this.clicks += 1; this.dispatch('click'); }
  scrollIntoView(options) { this.scrolled.push(options); }
}

const IDS = [
  'view-landing', 'landingRequestInvite', 'landingSignup', 'landingInviteHelp', 'landingThemeToggle', 'themeToggle',
  'request-invite', 'requestInviteClosed', 'requestInviteSignin', 'requestInviteForm', 'requestInviteFormError',
  'requestInviteName', 'requestInviteNameError', 'requestInviteEmail', 'requestInviteEmailError',
  'requestInviteNote', 'requestInviteNoteError', 'requestInviteNoteCount', 'requestInviteWebsite',
  'requestInviteSubmit', 'requestInviteDone',
  'inviteTitle', 'inviteNextSteps', 'inviteSignin', 'activationTitle', 'activationNextSteps', 'activationSignin',
  'passwordResetTitle', 'passwordResetNextSteps',
];

function makeDocument() {
  const doc = { activeElement: null, elements: new Map(), links: [] };
  for (const id of IDS) doc.elements.set(id, new FakeElement(doc, id));
  doc.links.push(new FakeElement(doc, 'request-link-1'));
  doc.getElementById = id => doc.elements.get(id) || null;
  doc.querySelectorAll = selector => (selector === '[data-invite-request-link]' ? doc.links : []);
  doc.$ = id => doc.elements.get(id);
  doc.$('view-landing').style.display = 'block';
  doc.$('landingInviteHelp').hidden = true;
  doc.$('requestInviteForm').hidden = true;
  doc.$('requestInviteDone').hidden = true;
  doc.$('landingRequestInvite').hidden = true;
  for (const key of ['Name', 'Email', 'Note']) doc.$(`requestInvite${key}Error`).hidden = true;
  return doc;
}

function withGlobals(values, run) {
  const previous = new Map();
  for (const [key, value] of Object.entries(values)) {
    previous.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  }
  const restore = () => {
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    }
  };
  try {
    const result = run();
    if (result && typeof result.then === 'function') return result.finally(restore);
    restore();
    return result;
  } catch (error) {
    restore();
    throw error;
  }
}

function response(status, body, { invalidJson = false } = {}) {
  return {
    status,
    async json() {
      if (invalidJson) throw new SyntaxError('bad json');
      return body;
    },
  };
}

function mounted({ fetchImpl } = {}) {
  landing._reset();
  const doc = makeDocument();
  landing.mount(doc, { fetchImpl });
  return doc;
}

function fill(doc, { name = 'Ada Lovelace', email = 'Ada@Example.com', note = '', website = '' } = {}) {
  doc.$('requestInviteName').value = name;
  doc.$('requestInviteEmail').value = email;
  doc.$('requestInviteNote').value = note;
  doc.$('requestInviteWebsite').value = website;
}

test('validation normalizes the WP-L2 payload exactly like the server contract', () => {
  const result = landing.validateInviteRequest({
    name: '  Ada \t  Lovelace ', email: '  Ada@Example.COM ', note: '  Graphs\r\nand system design  ', website: '',
  });
  assert.equal(result.ok, true);
  assert.deepEqual(result.errors, {});
  assert.deepEqual(result.payload, {
    name: 'Ada Lovelace', email: 'ada@example.com', note: 'Graphs\nand system design', website: '',
  });
  const blankNote = landing.validateInviteRequest({ name: 'Al', email: 'a@b.co', note: '   ' });
  assert.equal(blankNote.payload.note, null);
  assert.equal(blankNote.payload.website, '');
  const honeypot = landing.validateInviteRequest({ name: 'Al', email: 'a@b.co', website: 'https://spam.example' });
  assert.equal(honeypot.payload.website, 'https://spam.example', 'the honeypot is forwarded so the server can drop it');
  const decomposed = landing.validateInviteRequest({ name: 'Rene\u0301', email: 'r@e.io' });
  assert.equal(decomposed.payload.name, 'Ren\u00E9');
});

test('validation reports every field rule with user-facing copy', () => {
  const empty = landing.validateInviteRequest({});
  assert.equal(empty.ok, false);
  assert.equal(empty.payload, null);
  assert.equal(empty.errors.name, 'Enter your name.');
  assert.equal(empty.errors.email, 'Enter your email address.');
  assert.equal(empty.errors.note, undefined);

  assert.match(landing.validateInviteRequest({ name: 'A', email: 'a@b.co' }).errors.name, /at least 2/);
  assert.match(landing.validateInviteRequest({ name: 'x'.repeat(61), email: 'a@b.co' }).errors.name, /60 characters or fewer/);
  assert.equal(landing.validateInviteRequest({ name: '\u{1F600}'.repeat(60), email: 'a@b.co' }).ok, true,
    'length is counted in code points, not UTF-16 units');
  assert.match(landing.validateInviteRequest({ name: 'Ada\u202ELovelace', email: 'a@b.co' }).errors.name, /unusual characters/);
  assert.match(landing.validateInviteRequest({ name: 'Ada\u0007', email: 'a@b.co' }).errors.name, /unusual characters/);

  for (const email of ['ada', 'ada@', '@example.com', 'ada@example', 'a da@example.com', 'ada@example.']) {
    assert.match(landing.validateInviteRequest({ name: 'Ada', email }).errors.email, /like name@example\.com/, email);
  }
  assert.match(landing.validateInviteRequest({ name: 'Ada', email: `${'a'.repeat(250)}@b.co` }).errors.email, /254/);

  assert.match(landing.validateInviteRequest({ name: 'Ada', email: 'a@b.co', note: 'n'.repeat(281) }).errors.note, /280/);
  assert.equal(landing.validateInviteRequest({ name: 'Ada', email: 'a@b.co', note: 'n'.repeat(280) }).ok, true);
  assert.match(landing.validateInviteRequest({ name: 'Ada', email: 'a@b.co', note: 'tab\there' }).errors.note, /unusual/);
  assert.equal(landing.validateInviteRequest({ name: 'Ada', email: 'a@b.co', note: 'two\nlines' }).ok, true);
});

test('the note counter counts code points after newline normalization', () => {
  assert.deepEqual(landing.noteCounter(''), { used: 0, remaining: 280, text: '0 / 280' });
  assert.deepEqual(landing.noteCounter('a\r\nb'), { used: 3, remaining: 277, text: '3 / 280' });
  assert.equal(landing.noteCounter('\u{1F600}\u{1F600}').used, 2);
  assert.equal(landing.noteCounter(null).used, 0);
});

test('responses map to generic success, field errors, rate limit, unavailable and error states', () => {
  const { MESSAGES } = landing;
  for (const outcome of [
    { status: 202, body: { ok: true, message: 'server text is ignored' } },
    { status: 202, body: null },
    { status: 200, body: { ok: true } },
  ]) {
    assert.deepEqual(landing.interpretInviteRequestResponse(outcome), { state: 'success', message: MESSAGES.success, fields: {} });
  }
  const invalid = landing.interpretInviteRequestResponse({
    status: 400,
    body: { fields: { name: '  Name is too short. ', email: 42, note: '', form: undefined, extra: 'ignored' } },
  });
  assert.deepEqual(invalid, { state: 'invalid', message: MESSAGES.invalidForm, fields: { name: 'Name is too short.' } });
  const longField = landing.interpretInviteRequestResponse({ status: 400, body: { fields: { form: 'x'.repeat(500) } } });
  assert.equal(longField.fields.form.length, 200);
  assert.equal(longField.message, longField.fields.form);
  assert.deepEqual(landing.interpretInviteRequestResponse({ status: 400, body: { error: 'invalid invite request' } }).fields,
    { form: MESSAGES.invalidForm });
  assert.equal(landing.interpretInviteRequestResponse({ status: 429, body: { retry_after_seconds: 60 } }).message,
    'Too many requests — try again later.');
  assert.equal(landing.interpretInviteRequestResponse({ status: 429 }).state, 'rate-limited');
  assert.equal(landing.interpretInviteRequestResponse({ status: 404 }).state, 'unavailable');
  assert.equal(landing.interpretInviteRequestResponse({ status: 503 }).message, MESSAGES.unavailable);
  assert.deepEqual(landing.interpretInviteRequestResponse({ status: 403 }), { state: 'error', message: MESSAGES.rejected, fields: {} });
  assert.deepEqual(landing.interpretInviteRequestResponse({ status: 500 }), { state: 'error', message: MESSAGES.generic, fields: {} });
  assert.deepEqual(landing.interpretInviteRequestResponse({ status: 201, body: { ok: false } }).state, 'error');
  assert.deepEqual(landing.interpretInviteRequestResponse({ networkError: true }), { state: 'error', message: MESSAGES.network, fields: {} });
  assert.equal(landing.interpretInviteRequestResponse().state, 'error');
});

test('submission posts same-origin JSON to the public endpoint and survives bad bodies and failures', async () => {
  const calls = [];
  const ok = await landing.submitInviteRequest({ name: 'Ada', email: 'a@b.co', note: null, website: '' }, {
    fetchImpl: async (url, init) => { calls.push({ url, init }); return response(202, { ok: true }); },
  });
  assert.equal(ok.state, 'success');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, '/api/invite-requests');
  assert.equal(calls[0].init.method, 'POST');
  assert.equal(calls[0].init.credentials, 'same-origin');
  assert.equal(calls[0].init.headers['content-type'], 'application/json');
  assert.deepEqual(JSON.parse(calls[0].init.body), { name: 'Ada', email: 'a@b.co', note: null, website: '' });
  assert.ok(calls[0].init.signal);

  assert.equal((await landing.submitInviteRequest({}, { fetchImpl: async () => response(503, null, { invalidJson: true }) })).state,
    'unavailable');
  assert.equal((await landing.submitInviteRequest({}, { fetchImpl: async () => { throw new TypeError('offline'); } })).state,
    'error');
  const timedOut = await landing.submitInviteRequest({}, {
    timeoutMs: 5,
    fetchImpl: (_url, init) => new Promise((_resolve, reject) => {
      init.signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
    }),
  });
  assert.equal(timedOut.message, landing.MESSAGES.network);
  await withGlobals({ fetch: undefined }, async () => {
    assert.equal((await landing.submitInviteRequest({})).message, landing.MESSAGES.network);
  });
  await withGlobals({ fetch: async () => response(429, {}) }, async () => {
    assert.equal((await landing.submitInviteRequest({})).state, 'rate-limited');
  });
});

test('recovery pages turn dead ends into next steps with honest titles', () => {
  assert.deepEqual(landing.recoveryState('invite', 'live'), { title: 'You’re invited to Randori', showNextSteps: false });
  assert.deepEqual(landing.recoveryState('invite', 'failed'), { title: 'This invitation link can’t be used', showNextSteps: true });
  assert.deepEqual(landing.recoveryState('invite', 'expired'), { title: 'This invitation link has expired', showNextSteps: true });
  for (const status of ['expired', 'revoked', 'invalid']) {
    assert.equal(landing.recoveryState('activation', status).showNextSteps, true, status);
    assert.equal(landing.recoveryState('passwordReset', status).showNextSteps, true, status);
  }
  for (const status of ['checking', 'verified', 'used', 'unavailable']) {
    assert.equal(landing.recoveryState('activation', status).showNextSteps, false, status);
  }
  assert.equal(landing.recoveryState('activation', 'verified').title, 'Your account is ready');
  assert.equal(landing.recoveryState('passwordReset', 'ready').title, 'Choose a new password');
  assert.equal(landing.recoveryState('passwordReset', 'reset').title, 'Password changed');
  assert.equal(landing.recoveryState('passwordReset', 'used').showNextSteps, false);
  assert.equal(landing.recoveryState('nope', 'invalid'), null);

  landing._reset();
  assert.equal(landing.applyRecovery('invite', 'failed').showNextSteps, true, 'state is computed before mount');
  const doc = makeDocument();
  doc.$('inviteNextSteps').hidden = true;
  landing.mount(doc);
  assert.equal(doc.$('inviteTitle').textContent, 'This invitation link can’t be used', 'pending recovery state applies on mount');
  assert.equal(doc.$('inviteNextSteps').hidden, false);
  landing.applyRecovery('invite', 'live');
  assert.equal(doc.$('inviteNextSteps').hidden, true);
  landing.applyRecovery('activation', 'expired');
  assert.equal(doc.$('activationTitle').textContent, 'This verification link has expired');
  assert.equal(doc.$('activationNextSteps').hidden, false);
  landing.applyRecovery('passwordReset', 'invalid');
  assert.equal(doc.$('passwordResetNextSteps').hidden, false);
  assert.equal(landing.applyRecovery('unknown', 'x'), null);
});

test('the request form appears only when the capability is advertised', () => {
  const doc = mounted();
  assert.equal(doc.$('requestInviteClosed').hidden, false, 'invite-only note is the default');
  assert.equal(doc.$('requestInviteForm').hidden, true);
  assert.equal(doc.$('landingRequestInvite').hidden, true);
  landing.setCapabilities({ loaded: true, inviteRequests: true });
  assert.deepEqual(landing.capabilities, { loaded: true, failed: false, inviteRequests: true });
  assert.equal(doc.$('requestInviteClosed').hidden, true);
  assert.equal(doc.$('requestInviteForm').hidden, false);
  assert.equal(doc.$('requestInviteDone').hidden, true);
  assert.equal(doc.$('landingRequestInvite').hidden, false);
  assert.equal(doc.links[0].hidden, false);
  landing.setCapabilities({ loaded: true, failed: true, inviteRequests: 'yes' });
  assert.equal(landing.capabilities.inviteRequests, false, 'only a literal true opens the form');
  assert.equal(doc.$('requestInviteForm').hidden, true);
  assert.equal(doc.links[0].hidden, true);
  landing.setCapabilities();
  assert.equal(landing.capabilities.loaded, true);
});

test('"I have an invitation" explains invitations, and opens signup only with a prepared invite', () => {
  const opened = [];
  withGlobals({ _randori_auth: { openModal: mode => opened.push(mode) } }, () => {
    const doc = mounted();
    const button = doc.$('landingSignup');
    const help = doc.$('landingInviteHelp');
    button.dataset.action = 'help';
    landing.syncInviteHelp();
    assert.equal(button.getAttribute('aria-expanded'), 'false');
    assert.equal(button.getAttribute('aria-controls'), 'landingInviteHelp');
    button.click();
    assert.equal(help.hidden, false);
    assert.equal(button.getAttribute('aria-expanded'), 'true');
    help.dispatch('keydown', { key: 'Enter' });
    assert.equal(help.hidden, false);
    help.dispatch('keydown', { key: 'Escape' });
    assert.equal(help.hidden, true);
    assert.equal(doc.activeElement, button, 'Escape returns focus to the toggle');
    button.click();
    button.dispatch('keydown', { key: 'Escape' });
    assert.equal(help.hidden, true);
    button.dispatch('keydown', { key: 'Escape' });
    assert.equal(landing.toggleInviteHelp(true), true);

    button.dataset.action = 'signup';
    landing.syncInviteHelp();
    assert.equal(help.hidden, true);
    assert.equal(button.getAttribute('aria-expanded'), null);
    assert.equal(button.getAttribute('aria-controls'), null);
    button.click();
    assert.deepEqual(opened, ['signup']);
    button.disabled = true;
    button.click();
    assert.deepEqual(opened, ['signup'], 'disabled while capabilities load');

    for (const id of ['requestInviteSignin', 'inviteSignin', 'activationSignin']) doc.$(id).click();
    assert.deepEqual(opened, ['signup', 'signin', 'signin', 'signin']);
    doc.$('landingThemeToggle').click();
    assert.equal(doc.$('themeToggle').clicks, 1);
  });
  landing._reset();
  assert.equal(landing.toggleInviteHelp(), false, 'no document, no toggle');
  landing.syncInviteHelp();
});

test('a valid request shows a pending button, then collapses to the generic success message', async () => {
  let release;
  const calls = [];
  const doc = mounted({
    fetchImpl: (url, init) => {
      calls.push(JSON.parse(init.body));
      return new Promise(resolve => { release = () => resolve(response(202, { ok: true })); });
    },
  });
  landing.setCapabilities({ inviteRequests: true });
  fill(doc, { note: 'Graphs' });
  doc.$('requestInviteNote').dispatch('input');
  assert.equal(doc.$('requestInviteNoteCount').textContent, '6 / 280');
  const pending = landing.submit({ preventDefault() {} });
  const submit = doc.$('requestInviteSubmit');
  assert.equal(submit.disabled, true);
  assert.equal(submit.getAttribute('aria-busy'), 'true');
  assert.equal(submit.textContent, 'Sending…');
  assert.equal(doc.$('requestInviteForm').getAttribute('aria-busy'), 'true');
  assert.equal(await landing.submit(), null, 'a second submit while pending is ignored');
  release();
  const outcome = await pending;
  assert.equal(outcome.state, 'success');
  assert.deepEqual(calls, [{ name: 'Ada Lovelace', email: 'ada@example.com', note: 'Graphs', website: '' }]);
  assert.equal(submit.disabled, false);
  assert.equal(submit.getAttribute('aria-busy'), null);
  assert.equal(submit.textContent, 'Request an invite');
  assert.equal(doc.$('requestInviteForm').hidden, true);
  assert.equal(doc.$('requestInviteDone').hidden, false);
  assert.equal(doc.$('requestInviteDone').textContent, landing.MESSAGES.success);
  assert.equal(doc.activeElement, doc.$('requestInviteDone'));
  assert.equal(landing.submitted, true);
  assert.equal(await landing.submit(), null, 'nothing is resent after success');
  landing.setCapabilities({ inviteRequests: true });
  assert.equal(doc.$('requestInviteForm').hidden, true, 'capability refresh keeps the success state');
});

test('client and server validation errors are linked to their fields', async () => {
  let reply = response(400, { error: 'invalid invite request', fields: { email: 'Use a different email.' } });
  const doc = mounted({ fetchImpl: async () => reply });
  assert.equal(await landing.submit(), null, 'no capability, no submission');
  landing.setCapabilities({ inviteRequests: true });
  fill(doc, { name: 'A', email: 'nope' });
  const local = await landing.submit();
  assert.equal(local.state, 'invalid');
  assert.equal(doc.$('requestInviteNameError').hidden, false);
  assert.match(doc.$('requestInviteNameError').textContent, /at least 2/);
  assert.equal(doc.$('requestInviteName').getAttribute('aria-invalid'), 'true');
  assert.equal(doc.$('requestInviteEmail').getAttribute('aria-invalid'), 'true');
  assert.equal(doc.$('requestInviteFormError').textContent, landing.MESSAGES.invalidForm);
  assert.equal(doc.activeElement, doc.$('requestInviteName'), 'focus moves to the first invalid field');
  doc.$('requestInviteName').dispatch('input');
  assert.equal(doc.$('requestInviteName').getAttribute('aria-invalid'), null, 'typing clears the field error');
  assert.equal(doc.$('requestInviteNameError').hidden, true);
  doc.$('requestInviteNote').dispatch('input');

  fill(doc);
  const server = await landing.submit();
  assert.equal(server.state, 'invalid');
  assert.equal(doc.$('requestInviteEmailError').textContent, 'Use a different email.');
  assert.equal(doc.$('requestInviteName').getAttribute('aria-invalid'), null);
  assert.equal(doc.activeElement, doc.$('requestInviteEmail'));

  reply = response(400, { fields: { form: 'Something is off.' } });
  await landing.submit();
  assert.equal(doc.$('requestInviteFormError').textContent, 'Something is off.');
  assert.equal(doc.activeElement, doc.$('requestInviteFormError'));
});

test('rate limits, outages and network errors keep the form and show one recovery message', async () => {
  const replies = [
    async () => response(429, { error: 'too many requests; try again later', retry_after_seconds: 3600 }),
    async () => response(503, { error: 'invite requests unavailable' }),
    async () => { throw new TypeError('Failed to fetch'); },
    async () => response(202, { ok: true }),
  ];
  const doc = mounted({ fetchImpl: () => replies.shift()() });
  landing.setCapabilities({ inviteRequests: true });
  fill(doc);
  for (const expected of [landing.MESSAGES.rateLimited, landing.MESSAGES.unavailable, landing.MESSAGES.network]) {
    const outcome = await landing.submit();
    assert.notEqual(outcome.state, 'success');
    assert.equal(doc.$('requestInviteFormError').hidden, false);
    assert.equal(doc.$('requestInviteFormError').textContent, expected);
    assert.equal(doc.$('requestInviteForm').hidden, false);
    assert.equal(doc.$('requestInviteName').value, 'Ada Lovelace', 'drafts are kept for a retry');
  }
  assert.equal((await landing.submit()).state, 'success');
  assert.equal(doc.$('requestInviteFormError').hidden, true);
});

test('the hero CTA and /#request-invite deep links scroll to the form, honouring reduced motion', () => {
  const replaced = [];
  const history = { state: { keep: true }, replaceState: (...args) => replaced.push(args) };
  withGlobals({ history, matchMedia: () => ({ matches: true }), location: { hash: '' } }, () => {
    const doc = mounted();
    landing.setCapabilities({ inviteRequests: true });
    const event = doc.$('landingRequestInvite').dispatch('click');
    assert.equal(event.defaultPrevented, true);
    assert.deepEqual(replaced, [[{ keep: true }, '', '#request-invite']]);
    assert.deepEqual(doc.$('request-invite').scrolled, [{ behavior: 'auto', block: 'start' }]);
    assert.equal(doc.activeElement, doc.$('requestInviteName'));
    assert.equal(landing.revealRequestedSection(), false, 'no deep link, no automatic scroll');
  });
  withGlobals({ matchMedia: () => { throw new Error('unsupported'); }, location: { hash: '#request-invite' } }, () => {
    landing._reset();
    const doc = makeDocument();
    doc.$('view-landing').style.display = 'none';
    let observerCallback;
    let disconnected = 0;
    globalThis.MutationObserver = class {
      constructor(callback) { observerCallback = callback; }
      observe(target, options) { assert.equal(target, doc.$('view-landing')); assert.deepEqual(options.attributeFilter, ['style']); }
      disconnect() { disconnected += 1; }
    };
    try {
      landing.mount(doc);
      landing.setCapabilities({ inviteRequests: false });
      assert.deepEqual(doc.$('request-invite').scrolled, [], 'hidden landing does not scroll');
      observerCallback();
      assert.equal(disconnected, 0);
      doc.$('view-landing').style.display = 'block';
      observerCallback();
      assert.equal(disconnected, 1);
      assert.deepEqual(doc.$('request-invite').scrolled, [{ behavior: 'smooth', block: 'start' }]);
      assert.equal(doc.activeElement, doc.$('request-invite'), 'the section, not a field, takes focus on arrival');
      observerCallback();
      assert.equal(disconnected, 2);
      assert.equal(landing.revealRequestedSection(), false, 'reveals only once');
      assert.equal(landing.scrollToRequest(), true);
    } finally {
      delete globalThis.MutationObserver;
    }
  });
  landing._reset();
  assert.equal(landing.scrollToRequest(), false);
});

test('index.html loads the module early and keeps the landing contract hooks', () => {
  const html = readFileSync(new URL('../../index.html', import.meta.url), 'utf8');
  const gate = html.indexOf('<script src="/assets/invite-gate.js"></script>');
  const module = html.indexOf('<script src="/assets/landing.js"></script>');
  const authLayer = html.indexOf('// ---------- auth layer ----------');
  assert.ok(gate >= 0 && module > gate && module < authLayer);
  assert.match(html, /<h1 id="landingTitle">Mock interviews with people you trust\.<\/h1>/);
  assert.match(html, /id="request-invite"[^>]+aria-labelledby="requestInviteTitle"/);
  assert.match(html, /id="requestInviteWebsite" name="website" type="text" tabindex="-1" autocomplete="off" aria-hidden="true"/);
  assert.match(html, /class="landing-hp" aria-hidden="true"/);
  for (const field of ['Name', 'Email']) {
    assert.match(html, new RegExp(`id="requestInvite${field}"[^>]+aria-describedby="requestInvite${field}Error"`));
  }
  assert.match(html, /id="requestInviteNote"[^>]+maxlength="280"[^>]+aria-describedby="requestInviteNoteHint requestInviteNoteCount requestInviteNoteError"/);
  assert.match(html, /Invite-only — ask a member for an invitation\./);
  assert.match(html, /inviteRequests:capabilities\.inviteRequests===true/);
  assert.match(html, /window\._randori_landing\?\.setCapabilities\?\.\(/);
  for (const page of ['invite', 'activation', 'passwordReset']) {
    assert.match(html, new RegExp(`_randori_landing\\?\\.applyRecovery\\?\\.\\('${page}'`));
  }
  assert.doesNotMatch(html, /authorization-gated|id="landingStats"|id="landingNextBar"|>Use an invitation</);
});
