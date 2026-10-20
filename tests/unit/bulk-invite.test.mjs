// Circle owner bulk invite UI: pure helpers and the DOM controller (ID-68).
import assert from 'node:assert/strict';
import { test } from 'node:test';

import bulkUi, {
  bulkErrorMessage,
  formatWait,
  mountBulkInvite,
  normalizeBulkResponse,
  previewSummary,
  remainingInput,
  resultView,
  submitLabel,
  summarizeResults,
  withoutLines,
} from '../../assets/bulk-invite.js';
import { parseEmailList } from '../../assets/email-validation.js';

const ORIGIN = 'https://randori.example.test';
const TOKEN = 'A'.repeat(43);
const id = n => `${String(n).padStart(8, '0')}-0000-4000-8000-000000000000`;

// ------------------------------------------------------------ minimal DOM

class FakeElement {
  constructor(tag) {
    this.tagName = tag.toUpperCase();
    this.children = [];
    this.dataset = {};
    this.attributes = {};
    this.listeners = {};
    this.hidden = false;
    this.disabled = false;
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
  // Listeners fire-and-forget their async work (as in the browser); settle it.
  async dispatch(type, event = {}) {
    for (const listener of this.listeners[type] || []) listener(event);
    await new Promise(resolve => setImmediate(resolve));
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

function fakeDocument() {
  const elements = new Map();
  for (const name of ['circleBulkInviteForm', 'circleBulkInviteInput', 'circleBulkInviteCount', 'circleBulkInvitePreview',
    'circleBulkInviteSubmit', 'circleBulkInviteStatus', 'circleBulkInviteResults']) {
    elements.set(name, new FakeElement(name === 'circleBulkInviteInput' ? 'textarea' : 'div'));
  }
  return {
    elements,
    getElementById: name => elements.get(name) || null,
    createElement: tag => new FakeElement(tag),
  };
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((ok, fail) => { resolve = ok; reject = fail; });
  return { promise, resolve, reject };
}

function fakeHost(overrides = {}) {
  const calls = { createMany: [], resend: [], remembered: [], refresh: 0, copied: [] };
  const host = {
    origin: ORIGIN,
    owner: true,
    operationValid: true,
    canInvite: () => host.owner,
    capture: () => ({ token: 1 }),
    matches: () => host.operationValid,
    createMany: async emails => { calls.createMany.push(emails); return host.respond(emails); },
    respond: emails => createdResponse(emails),
    resend: async invitationId => { calls.resend.push(invitationId); return { ok: true, invitation: { invite_url: `/invite#invite=${'R'.repeat(43)}` }, email_delivery: { queued: true } }; },
    rememberEmail: (invitationId, email) => { calls.remembered.push([invitationId, email]); },
    refresh: async () => { calls.refresh += 1; },
    copy: async text => { calls.copied.push(text); },
    ...overrides,
  };
  return { host, calls };
}

function createdResponse(emails, statusFor = () => 'created') {
  return {
    ok: true,
    results: emails.map((email, index) => {
      const status = statusFor(email, index);
      const result = { index, input: email, email, status };
      if (status === 'created') {
        Object.assign(result, { invitation: { id: id(index + 1), email, status: 'pending', invite_url: `/invite#invite=${TOKEN}` },
          email_delivery: { queued: true } });
      }
      if (status === 'already_invited') result.invitation = { id: id(90 + index), status: 'pending' };
      if (status === 'already_member') result.member_status = 'active';
      if (status === 'failed') result.reason = 'unavailable';
      return result;
    }),
  };
}

function mount(overrides) {
  const doc = fakeDocument();
  const { host, calls } = fakeHost(overrides);
  const controller = mountBulkInvite({ doc, host });
  const el = name => doc.elements.get(`circleBulkInvite${name}`);
  const type = async value => { el('Input').value = value; await el('Input').dispatch('input'); };
  const submit = () => el('Form').dispatch('submit', { preventDefault() {} });
  return { doc, host, calls, controller, el, type, submit };
}

// ------------------------------------------------------------ pure helpers

test('preview summary counts ready, invalid, merged and blocks more than 50', () => {
  assert.deepEqual({ ...previewSummary(parseEmailList('')) }, { text: '', ready: 0, canSubmit: false, tone: 'none' });
  assert.deepEqual({ ...previewSummary(parseEmailList('a@example.com A@example.com bad')) },
    { text: '1 ready to invite · 1 to fix · 1 duplicate merged', ready: 1, canSubmit: true, tone: 'warning' });
  assert.equal(previewSummary(parseEmailList('a@x.com b@x.com, b@x.com c@x.com c@x.com')).text,
    '3 ready to invite · 2 duplicates merged');
  assert.equal(previewSummary(parseEmailList('bad')).canSubmit, false);
  const over = previewSummary(parseEmailList(Array.from({ length: 53 }, (_, n) => `p${n}@example.com`).join(',')));
  assert.deepEqual([over.canSubmit, over.tone], [false, 'danger']);
  assert.match(over.text, /^53 addresses found\. You can invite up to 50 at a time; remove 3 to continue\.$/);
  assert.match(previewSummary(parseEmailList('x '.repeat(600))).text, /Only the first part of this paste was read\.$/);
  assert.equal(previewSummary(parseEmailList('a@example.com')).tone, 'info');
});

test('submit labels, wait copy, and remaining input', () => {
  assert.equal(submitLabel(0), 'Invite people');
  assert.equal(submitLabel(1), 'Invite 1 person');
  assert.equal(submitLabel(7), 'Invite 7 people');
  assert.equal(submitLabel(7, true), 'Inviting…');
  assert.equal(formatWait(undefined), 'later');
  assert.equal(formatWait(30), 'in a minute or two');
  assert.equal(formatWait(600), 'in about 10 minutes');
  assert.equal(formatWait(60 * 60 * 5), 'in about 5 hours');
  assert.equal(formatWait(3600), 'in about 1 hour');
  assert.equal(remainingInput([
    { status: 'created', email: 'a@x.com' }, { status: 'invalid', raw: 'bad' }, { status: 'failed', email: 'f@x.com', raw: 'F@x.com' },
    { status: 'already_member', email: 'm@x.com' }, { status: 'failed', email: 'g@x.com' },
  ]), 'bad\nF@x.com\ng@x.com');
  assert.equal(withoutLines('a@x.com\n Bad \nkeep', ['bad', null, 'A@X.COM']), 'keep');
  assert.equal(withoutLines(undefined, ['x']), '');
});

test('responses are trusted only when they match what was sent', () => {
  const sent = ['a@x.com', 'b@x.com', 'c@x.com', 'd@x.com', 'e@x.com'];
  const response = createdResponse(sent, (email, index) => ['created', 'already_invited', 'already_member', 'failed', 'invalid'][index]);
  response.results[2].member_status = 'inactive';
  response.results[4].reason = 'local_dots';
  const rows = normalizeBulkResponse(response, sent, { origin: ORIGIN });
  assert.deepEqual(rows.map(row => row.status), ['created', 'already_invited', 'already_member', 'failed', 'invalid']);
  assert.deepEqual([rows[0].id, rows[0].inviteUrl, rows[0].queued], [id(1), `${ORIGIN}/invite#invite=${TOKEN}`, true]);
  assert.equal(rows[1].id, id(91));
  assert.equal(rows[2].inactive, true);
  assert.equal(rows[4].reason, 'local_dots');

  const broken = [
    null,
    { ok: false, results: [] },
    { ok: true, results: [] },
    { ok: true, results: [{ index: 1, status: 'created' }] },
    { ok: true, results: [{ index: 0, status: 'weird' }] },
    { ok: true, results: [{ index: 0, status: 'created', invitation: { id: 'nope', invite_url: `/invite#invite=${TOKEN}` } }] },
    { ok: true, results: [{ index: 0, status: 'created', invitation: { id: id(1), invite_url: 'https://evil.example/invite' } }] },
  ];
  for (const candidate of broken) assert.equal(normalizeBulkResponse(candidate, ['a@x.com'], { origin: ORIGIN }), null);
  assert.equal(normalizeBulkResponse(createdResponse(['a@x.com']), ['a@x.com'], { origin: 'not a url' }), null);
  const invited = normalizeBulkResponse({ ok: true, results: [{ index: 0, status: 'already_invited', invitation: { id: 'x' } }] },
    ['a@x.com'], { origin: ORIGIN });
  assert.equal(invited[0].id, null, 'an unusable id disables resend instead of failing the whole response');
});

test('result rows map each status to copy and the one action it allows', () => {
  const view = row => ({ ...resultView(row) });
  assert.deepEqual(view({ status: 'created', inviteUrl: 'u', queued: true }),
    { label: 'Invited', tone: 'success', detail: 'Invitation email on its way. Copy the link as a fallback.', action: 'copy' });
  assert.equal(view({ status: 'created', inviteUrl: 'u', queued: false, resent: true }).label, 'Resent');
  assert.equal(view({ status: 'created', queued: false }).detail, 'Copy the link and send it privately.');
  assert.equal(view({ status: 'created' }).action, null);
  assert.deepEqual([view({ status: 'already_member' }).label, view({ status: 'already_member', inactive: true }).label],
    ['Already a member', 'Former member']);
  assert.equal(view({ status: 'already_invited', id: id(1) }).action, 'resend');
  assert.equal(view({ status: 'already_invited', id: null, note: 'n' }).detail, 'n');
  assert.equal(view({ status: 'already_invited', id: null }).action, null);
  assert.deepEqual(view({ status: 'invalid', reason: 'tld_invalid' }),
    { label: 'Invalid', tone: 'danger', detail: 'The ending of the domain doesn’t look right (like .com or .org).', action: null });
  assert.equal(view({ status: 'duplicate_in_request' }).label, 'Duplicate');
  assert.deepEqual(view({ status: 'failed', reason: 'rate_limited' }),
    { label: 'Failed', tone: 'danger', detail: 'Daily invitation limit reached. Try again later.', action: 'retry' });
  assert.equal(view({ status: 'failed', reason: 'mystery' }).detail, 'Could not create this invitation. Try again.');
  assert.equal(view({ status: 'failed', note: 'custom' }).detail, 'custom');
});

test('summaries and request-level errors read as plain sentences', () => {
  assert.equal(summarizeResults([]), 'Nothing to invite.');
  assert.equal(summarizeResults([
    { status: 'created' }, { status: 'created' }, { status: 'already_member' }, { status: 'already_invited' },
    { status: 'invalid' }, { status: 'failed' },
  ]), 'Invited 2 people · 1 already in the circle · 1 already invited · 1 to fix · 1 failed.');
  assert.equal(summarizeResults([{ status: 'created' }]), 'Invited 1 person.');
  assert.equal(bulkErrorMessage({ http_status: 429, remaining: 3, retry_after_seconds: 7200 }),
    'You can invite 3 more people today. Try again in about 2 hours. Nothing was sent.');
  assert.equal(bulkErrorMessage({ http_status: 429, remaining: 1 }),
    'You can invite 1 more person today. Try again later. Nothing was sent.');
  assert.equal(bulkErrorMessage({ code: 'invitation_quota_exceeded', remaining: 0 }),
    'You have reached today’s invitation limit. Try again later. Nothing was sent.');
  assert.equal(bulkErrorMessage({ code: 'bulk_invite_too_many' }), 'Invite up to 50 people at a time.');
  assert.match(bulkErrorMessage({ code: 'circle_context_changed' }), /active circle changed/);
  assert.match(bulkErrorMessage({ http_status: 403 }), /Only the circle owner/);
  assert.match(bulkErrorMessage({ http_status: 401 }), /Sign in again/);
  assert.match(bulkErrorMessage(new TypeError('Failed to fetch')), /Could not confirm/);
});

// ------------------------------------------------------------ controller

test('the controller previews a paste live and gates the submit button', async () => {
  const { el, type } = mount();
  assert.equal(el('Submit').disabled, true);
  assert.equal(el('Preview').hidden, true);
  await type('Ada <ada@example.com>, ADA@example.com, bad');
  assert.equal(el('Count').textContent, '1 ready to invite · 1 to fix · 1 duplicate merged');
  assert.equal(el('Count').dataset.tone, 'warning');
  assert.equal(el('Submit').disabled, false);
  assert.equal(el('Submit').textContent, 'Invite 1 person');
  const rows = el('Preview').byTestId('circle-bulk-invite-preview-row');
  assert.deepEqual(rows.map(row => row.dataset.valid), ['true', 'false']);
  assert.match(rows[0].textContent, /ada@example\.comReadyDuplicate merged \(listed 2 times\)\./);
  assert.match(rows[1].textContent, /badFixThis address is missing the @ sign\./);

  await type(Array.from({ length: 120 }, (_, n) => `bad${n}`).join('\n'));
  assert.equal(el('Preview').children.length, 101, 'the preview is capped with an overflow line');
  assert.equal(el('Preview').children.at(-1).textContent, 'and 20 more');

  await type(Array.from({ length: 51 }, (_, n) => `p${n}@example.com`).join('\n'));
  assert.equal(el('Submit').disabled, true);
  assert.equal(el('Input').getAttribute('aria-invalid'), 'true');
});

test('submitting sends only valid unique addresses once, then shows per-email results', async () => {
  const pending = deferred();
  const { el, type, submit, calls, host } = mount();
  host.respond = emails => pending.promise.then(() => createdResponse(emails, (email, index) =>
    ['created', 'already_member', 'already_invited', 'failed'][index]));
  await type('new@example.com, member@example.com\ninvited@example.com; fail@example.com bad NEW@example.com');
  await submit();
  await submit();
  assert.equal(el('Submit').disabled, true);
  assert.equal(el('Submit').textContent, 'Inviting…');
  assert.equal(el('Form').getAttribute('aria-busy'), 'true');
  assert.equal(el('Status').textContent, 'Inviting 4 people…');
  pending.resolve();
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(calls.createMany, [['new@example.com', 'member@example.com', 'invited@example.com', 'fail@example.com']],
    'double submit is ignored and invalid or duplicate entries are never sent');
  assert.equal(el('Status').textContent, 'Invited 1 person · 1 already in the circle · 1 already invited · 1 to fix · 1 failed.');
  const results = el('Results').byTestId('circle-bulk-invite-result');
  assert.deepEqual(results.map(row => row.dataset.status), ['created', 'already_member', 'already_invited', 'failed', 'invalid']);
  assert.equal(el('Results').hidden, false);
  assert.deepEqual(calls.remembered, [[id(1), 'new@example.com']]);
  assert.equal(calls.refresh, 1);
  assert.equal(el('Input').value, 'fail@example.com\nbad', 'only what still needs the owner stays in the textarea');
  assert.equal(el('Form').getAttribute('aria-busy'), 'false');
  assert.equal(el('Submit').textContent, 'Invite 1 person');
  assert.equal(el('Results').byTestId('circle-bulk-invite-copy')[0].getAttribute('aria-label'),
    'Copy invitation link for new@example.com');
});

test('copy, resend and retry act on one row each', async () => {
  const { el, type, submit, calls, host } = mount();
  host.respond = emails => createdResponse(emails, (email, index) => ['created', 'already_invited', 'failed'][index]);
  await type('new@example.com invited@example.com fail@example.com');
  await submit();

  await el('Results').byTestId('circle-bulk-invite-copy')[0].dispatch('click');
  assert.deepEqual(calls.copied, [`${ORIGIN}/invite#invite=${TOKEN}`]);
  assert.match(el('Status').textContent, /Invitation link for new@example.com copied/);
  host.copy = async () => { throw new Error('denied'); };
  await el('Results').byTestId('circle-bulk-invite-copy')[0].dispatch('click');
  assert.match(el('Status').textContent, /Copy failed/);

  await el('Results').byTestId('circle-bulk-invite-resend')[0].dispatch('click');
  assert.deepEqual(calls.resend, [id(91)]);
  const resent = el('Results').byTestId('circle-bulk-invite-result')[1];
  assert.equal(resent.dataset.status, 'created');
  assert.match(resent.textContent, /Resent/);
  assert.match(el('Status').textContent, /Fresh invitation sent to invited@example.com/);

  host.respond = emails => createdResponse(emails);
  await el('Results').byTestId('circle-bulk-invite-retry')[0].dispatch('click');
  assert.deepEqual(calls.createMany.at(-1), ['fail@example.com']);
  assert.equal(el('Results').byTestId('circle-bulk-invite-result')[2].dataset.status, 'created');
  assert.equal(el('Input').value, '', 'a retried address leaves the textarea');
  assert.equal(el('Status').textContent, 'Invited 1 person.');
});

test('resend and retry failures keep the row and explain why', async () => {
  const { el, type, submit, host } = mount();
  host.respond = emails => createdResponse(emails, (email, index) => ['already_invited', 'failed', 'already_invited'][index]);
  await type('a@example.com b@example.com c@example.com');
  await submit();
  const results = () => el('Results').byTestId('circle-bulk-invite-result');

  host.resend = async () => { throw { http_status: 429, retry_after_seconds: 30 }; };
  await el('Results').byTestId('circle-bulk-invite-resend')[0].dispatch('click');
  assert.match(results()[0].textContent, /Resent recently\. Try again in a minute or two\./);
  host.resend = async () => { throw { http_status: 409 }; };
  await el('Results').byTestId('circle-bulk-invite-resend')[0].dispatch('click');
  assert.match(results()[0].textContent, /can’t be resent/);
  host.resend = async () => ({ ok: true, invitation: { invite_url: 'https://evil.example/x' } });
  await el('Results').byTestId('circle-bulk-invite-resend')[1].dispatch('click');
  assert.match(results()[2].textContent, /Could not resend\. Try again\./);

  host.respond = () => { throw { http_status: 429, remaining: 0 }; };
  await el('Results').byTestId('circle-bulk-invite-retry')[0].dispatch('click');
  assert.match(results()[1].textContent, /reached today’s invitation limit/);
  host.respond = () => ({ ok: true, results: [] });
  await el('Results').byTestId('circle-bulk-invite-retry')[0].dispatch('click');
  assert.match(results()[1].textContent, /Could not confirm/);
  host.respond = emails => createdResponse(emails, () => 'failed');
  await el('Results').byTestId('circle-bulk-invite-retry')[0].dispatch('click');
  assert.equal(el('Input').value, 'b@example.com', 'a still-failing address stays in the textarea');
});

test('request-level failures keep the paste and only refresh when the outcome is unknown', async () => {
  const { el, type, submit, calls, host } = mount();
  await type('a@example.com b@example.com');
  host.respond = () => { throw { http_status: 429, remaining: 1, retry_after_seconds: 120 }; };
  await submit();
  assert.equal(el('Status').textContent, 'You can invite 1 more person today. Try again in about 2 minutes. Nothing was sent.');
  assert.equal(el('Input').value, 'a@example.com b@example.com');
  assert.equal(calls.refresh, 0);
  assert.equal(el('Submit').disabled, false);

  host.respond = () => { throw new TypeError('Failed to fetch'); };
  await submit();
  assert.match(el('Status').textContent, /Could not confirm the invitations/);
  assert.equal(calls.refresh, 1, 'an unknown outcome refreshes the pending list');

  host.respond = () => ({ ok: true, results: [{ index: 0, status: 'created' }] });
  await submit();
  assert.match(el('Status').textContent, /Could not confirm/);
});

test('guards: non-owners, stale operations, empty pastes, and reset during a request', async () => {
  const { el, type, submit, calls, host, controller } = mount();
  await submit();
  assert.equal(calls.createMany.length, 0, 'nothing to send');
  await type('bad');
  await submit();
  assert.equal(el('Input').focused, 1, 'an all-invalid paste moves focus back to the textarea');
  assert.equal(calls.createMany.length, 0);

  await type('a@example.com');
  host.owner = false;
  await submit();
  assert.equal(calls.createMany.length, 0);
  host.owner = true;
  host.operationValid = false;
  await submit();
  assert.equal(calls.createMany.length, 0, 'a stale circle context never sends');
  host.operationValid = true;

  const pending = deferred();
  host.respond = emails => pending.promise.then(() => createdResponse(emails));
  await submit();
  controller.reset();
  pending.resolve();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(el('Input').value, '');
  assert.equal(el('Status').textContent, '');
  assert.equal(el('Results').hidden, true);
  assert.deepEqual(calls.remembered, [], 'a response that lands after reset is dropped');

  const failing = deferred();
  host.respond = () => failing.promise;
  await type('b@example.com');
  await submit();
  host.operationValid = false;
  failing.reject(new Error('late'));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(el('Status').textContent, 'Inviting 1 person…', 'a stale failure does not overwrite the view');
});

test('row actions respect ownership and stale operations', async () => {
  const { el, type, submit, calls, host } = mount();
  host.respond = emails => createdResponse(emails, (email, index) => ['created', 'already_invited', 'failed'][index]);
  await type('a@example.com b@example.com c@example.com');
  await submit();
  host.owner = false;
  await el('Results').byTestId('circle-bulk-invite-copy')[0].dispatch('click');
  await el('Results').byTestId('circle-bulk-invite-resend')[0].dispatch('click');
  await el('Results').byTestId('circle-bulk-invite-retry')[0].dispatch('click');
  assert.deepEqual([calls.copied.length, calls.resend.length, calls.createMany.length], [0, 0, 1]);
  host.owner = true;
  host.operationValid = false;
  await el('Results').byTestId('circle-bulk-invite-resend')[0].dispatch('click');
  await el('Results').byTestId('circle-bulk-invite-retry')[0].dispatch('click');
  assert.deepEqual([calls.resend.length, calls.createMany.length], [0, 1]);

  // Responses that arrive after the circle context changed are ignored.
  host.operationValid = true;
  let flip = false;
  host.matches = () => !flip;
  host.resend = async () => { flip = true; return { ok: true }; };
  await el('Results').byTestId('circle-bulk-invite-resend')[0].dispatch('click');
  assert.equal(el('Results').byTestId('circle-bulk-invite-result')[1].dataset.status, 'already_invited');
  flip = false;
  host.resend = async () => { flip = true; throw new Error('late'); };
  await el('Results').byTestId('circle-bulk-invite-resend')[0].dispatch('click');
  flip = false;
  host.respond = () => { flip = true; return createdResponse(['c@example.com']); };
  await el('Results').byTestId('circle-bulk-invite-retry')[0].dispatch('click');
  flip = false;
  host.respond = () => { flip = true; throw new Error('late'); };
  await el('Results').byTestId('circle-bulk-invite-retry')[0].dispatch('click');
  assert.equal(el('Results').byTestId('circle-bulk-invite-result')[2].dataset.status, 'failed');
});

test('a missing card is a no-op and the module installs its browser global', async () => {
  const controller = mountBulkInvite({ doc: { getElementById: () => null }, host: {} });
  assert.doesNotThrow(() => controller.reset());
  assert.equal(bulkUi.mountBulkInvite, mountBulkInvite);
  const events = [];
  globalThis.window = globalThis;
  globalThis.dispatchEvent = event => { events.push(event.type); return true; };
  try {
    const fresh = await import(`../../assets/bulk-invite.js?browser=${Date.now()}`);
    assert.equal(globalThis.RandoriBulkInvite, fresh.default);
    assert.deepEqual(events, ['randori:bulk-invite-ready']);
    globalThis.dispatchEvent = () => { throw new Error('no events'); };
    await import(`../../assets/bulk-invite.js?browser-again=${Date.now()}`);
  } finally {
    delete globalThis.RandoriBulkInvite;
    delete globalThis.RandoriEmailValidation;
    delete globalThis.dispatchEvent;
    delete globalThis.window;
  }
});
