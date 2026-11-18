import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import vm from 'node:vm';
import { test } from 'node:test';

const source = readFileSync(new URL('../../assets/optional-pages.js', import.meta.url), 'utf8');
const settle = () => new Promise(resolve => setImmediate(resolve));

class Element {
  constructor(tag = 'div', doc = null) {
    this.tagName = tag.toUpperCase(); this.children = []; this.listeners = {};
    this.attributes = {}; this.dataset = {}; this.style = { display: 'none' };
    this.doc = doc; this.hidden = false; this.inert = false; this.textContent = '';
  }
  get hidden() { return this._hidden; }
  set hidden(value) {
    this._hidden = value;
    if (value && this.doc && this.contains(this.doc.activeElement)) this.doc.activeElement = this.doc.body;
  }
  contains(node) { return node === this || this.children.some(child => child.contains(node)); }
  append(...nodes) { for (const node of nodes) node.parent = this; this.children.push(...nodes); }
  prepend(node) { node.parent = this; this.children.unshift(node); }
  setAttribute(key, value) { this.attributes[key] = value; }
  querySelector(selector) { return selector === '.landing' ? this.content : this.focusTarget; }
  querySelectorAll() { return this.controls || []; }
  addEventListener(type, listener) { this.listeners[type] = listener; }
  remove() { this.removed = true; }
  focus() {
    for (let node = this; node; node = node.parent) if (node.hidden || node.inert) return;
    this.focused = true; if (this.doc) this.doc.activeElement = this;
  }
}

function browser({ readyState = 'loading', emptyViews = false } = {}) {
  const scripts = []; const observers = [];
  const timers = new Map(); let timerId = 0;
  const doc = {
    readyState, activeElement: null,
    createElement: tag => new Element(tag, doc),
    getElementById: id => views.get(id),
    head: { appendChild: script => scripts.push(script) },
    addEventListener(type, callback) { this[type] = callback; },
  };
  doc.body = new Element('body', doc); doc.activeElement = doc.body;
  const views = new Map((emptyViews ? [] : ['landing', 'invite', 'activation', 'password-reset']).map(id => {
    const view = new Element('section', doc); view.content = new Element('div', doc);
    view.content.focusTarget = new Element('h1', doc); view.content.append(view.content.focusTarget);
    view.controls = id === 'landing' ? [new Element('form', doc)] : [];
    view.content.append(...view.controls); view.append(view.content);
    return [`view-${id}`, view];
  }));
  const window = {
    document: doc,
    setTimeout(callback) { const id = ++timerId; timers.set(id, callback); return id; },
    clearTimeout(id) { timers.delete(id); },
    MutationObserver: class {
      constructor(callback) { this.callback = callback; observers.push(this); }
      observe(view) { view.observer = () => { if (!this.disconnected) this.callback(); }; }
      disconnect() { this.disconnected = true; }
    },
  };
  const context = { window, Promise, Map, Set, Object, Error };
  const evaluate = () => vm.runInNewContext(source, context, { filename: new URL('../../assets/optional-pages.js', import.meta.url).href });
  evaluate();
  return { window, doc, views, scripts, observers, timers, evaluate, load: window._randori_optional_pages.load };
}

function finish(script, browser, name, value = {}) {
  const globals = { email: 'RandoriEmailValidation', bulk: 'RandoriBulkInvite', calendar: '_randori_calendar_export', landing: '_randori_landing' };
  if (name === 'landing') browser.window._randori_landing.hydrate(value);
  Object.defineProperty(browser.window, globals[name], { configurable: true, value });
  script.onload();
}

test('no optional download at boot, and concurrent first use loads once', async () => {
  const b = browser(); b.doc.DOMContentLoaded();
  assert.equal(b.scripts.length, 0);
  const one = b.load('calendar'); const two = b.load('calendar');
  assert.equal(one, two);
  assert.equal(b.scripts.length, 1);
  assert.equal(b.scripts[0].src, '/assets/calendar-export.js');
  assert.equal(b.scripts[0].type, 'module');
  const api = { download() {} };
  finish(b.scripts[0], b, 'calendar', api);
  assert.equal(await one, api);
  assert.equal(await b.load('calendar'), api);
  assert.equal(b.scripts.length, 1);
  assert.equal(b.timers.size, 0);
  await assert.rejects(b.load('unknown'));
});

test('network, timeout and missing API failures are retryable, not sticky or automatic', async () => {
  for (const failure of ['network', 'timeout', 'missing-api']) {
    const b = browser();
    const pending = b.load('bulk');
    const rejection = assert.rejects(pending, /Optional asset unavailable/);
    if (failure === 'network') b.scripts[0].onerror();
    else if (failure === 'timeout') [...b.timers.values()][0]();
    else b.scripts[0].onload();
    await rejection;
    assert.equal(b.scripts.length, 1, 'failure alone never retries');
    assert.equal(b.scripts[0].removed, true);
    const retry = b.load('bulk');
    assert.equal(b.scripts[1].src, '/assets/bulk-invite.js?retry=1');
    finish(b.scripts[1], b, 'bulk');
    await retry;
    assert.equal(b.timers.size, 0);
  }
});

test('late readiness after a timeout is reused safely without another download', async () => {
  const b = browser(); const pending = b.load('calendar');
  const rejection = assert.rejects(pending);
  [...b.timers.values()][0](); await rejection;
  b.window._randori_calendar_export = { download() {} };
  assert.equal(await b.load('calendar'), b.window._randori_calendar_export);
  assert.equal(b.scripts.length, 1);
});

test('public first use awaits email then landing and replays latest state without fetching for a member', async () => {
  const b = browser(); const bridge = b.window._randori_landing;
  bridge.setCapabilities({ loaded: true, inviteRequests: false });
  assert.equal(bridge.applyRecovery('invite', 'expired').showNextSteps, true);
  bridge.applyRecovery('invite', 'live');
  b.doc.DOMContentLoaded();
  assert.equal(b.scripts.length, 0, 'writing auth/recovery state is not first use');
  const view = b.views.get('view-landing');
  view.style.display = 'block'; view.observer(); view.observer();
  const notice = view.children[0];
  assert.equal(view.content.inert, false);
  assert.equal(view.controls[0].inert, true);
  assert.equal(view.controls[0].attributes['aria-busy'], 'true');
  assert.match(notice.children[0].textContent, /Loading page/);
  assert.equal(b.scripts.length, 1);
  assert.equal(b.scripts[0].src, '/assets/email-validation.js');
  bridge.setCapabilities({ loaded: true, inviteRequests: true });
  finish(b.scripts[0], b, 'email'); await settle();
  assert.equal(b.scripts[1].src, '/assets/landing.js');
  assert.equal(b.scripts[1].type, '');
  const calls = [];
  finish(b.scripts[1], b, 'landing', {
    setCapabilities: value => calls.push(value),
    applyRecovery: (...value) => calls.push(value),
  });
  await settle();
  assert.deepEqual(calls, [{ loaded: true, inviteRequests: true }, ['invite', 'live']]);
  assert.equal(view.content.inert, false);
  assert.equal(notice.hidden, true);
  view.observer(); assert.equal(b.scripts.length, 2);
});

test('a public load failure leaves a visible retry, preserving the page and restoring retry focus', async () => {
  const b = browser(); b.doc.DOMContentLoaded();
  const view = b.views.get('view-invite'); view.style.display = 'block'; view.observer();
  b.scripts[0].onerror(); await settle();
  const notice = view.children[0]; const retry = notice.children[1];
  assert.match(notice.children[0].textContent, /could not load/);
  assert.equal(retry.hidden, false);
  assert.equal(view.content.inert, false);
  retry.focus();
  retry.listeners.click();
  assert.equal(b.doc.activeElement, notice.children[0], 'pending status owns focus while retry is hidden');
  assert.equal(b.scripts[1].src, '/assets/email-validation.js?retry=1');
  finish(b.scripts[1], b, 'email'); await settle();
  finish(b.scripts[2], b, 'landing', { setCapabilities() {}, applyRecovery() {} }); await settle();
  assert.equal(view.content.inert, false);
  assert.equal(notice.hidden, true);
  assert.equal(b.doc.activeElement, view.content.focusTarget);
  assert.ok(b.observers.every(observer => observer.disconnected));
});

test('hidden elements blur, retry failure restores focus, and unrelated focus is never stolen', async () => {
  const b = browser(); b.doc.DOMContentLoaded();
  const view = b.views.get('view-landing'); view.style.display = 'block'; view.observer();
  b.scripts[0].onerror(); await settle();
  const notice = view.children[0]; const retry = notice.children[1];
  retry.focus(); retry.hidden = true;
  assert.equal(b.doc.activeElement, b.doc.body, 'the fake must reproduce browser blur on hidden');
  retry.hidden = false; retry.focus(); retry.listeners.click();
  b.scripts[1].onerror(); await settle();
  assert.equal(b.doc.activeElement, retry);
  retry.listeners.click();
  const elsewhere = new Element('button', b.doc); elsewhere.focus();
  finish(b.scripts[2], b, 'email'); await settle();
  finish(b.scripts[3], b, 'landing', { setCapabilities() {}, applyRecovery() {} }); await settle();
  assert.equal(b.doc.activeElement, elsewhere, 'a user moving focus during loading keeps it');
});

test('the bootstrap and lazy module copies are idempotent, and recovery uses one frozen predicate table', async () => {
  const b = browser(); const api = b.window._randori_optional_pages; const boot = b.doc.DOMContentLoaded;
  b.evaluate();
  assert.equal(b.window._randori_optional_pages, api);
  assert.equal(b.doc.DOMContentLoaded, boot, 'late copy cannot register another bootstrap');
  const bridge = b.window._randori_landing;
  bridge.syncInviteHelp();
  for (const [page, states] of Object.entries(api.recoveryDeadEnds)) {
    assert.ok(Object.isFrozen(states));
    const ids = { invite: 'inviteNextSteps', activation: 'activationNextSteps', passwordReset: 'passwordResetNextSteps' };
    const steps = new Element('div', b.doc); b.views.set(ids[page], steps);
    for (const state of states) {
      assert.equal(bridge.applyRecovery(page, state).showNextSteps, true);
      assert.equal(steps.hidden, false, 'core recovery stays usable before optional code loads');
    }
    assert.equal(bridge.applyRecovery(page, 'live').showNextSteps, false);
    assert.equal(steps.hidden, true);
  }
  assert.equal(bridge.applyRecovery('unknown', 'invalid').showNextSteps, false);
  assert.equal(bridge.applyRecovery('constructor', 'invalid').showNextSteps, false);
});

test('an already-ready document boots once and absent public views need no observers', () => {
  const b = browser({ readyState: 'complete' });
  assert.equal(b.observers.length, 4);
  assert.equal(b.doc.DOMContentLoaded, undefined);
  const empty = browser({ readyState: 'complete', emptyViews: true });
  assert.equal(empty.observers.length, 0);
  assert.equal(empty.scripts.length, 0);
});

test('named optional assets exist, remain same-origin, and invitation security precedes the bridge', () => {
  const paths = [...source.matchAll(/\['(\/assets\/[^']+\.js)'/g)].map(match => match[1]);
  assert.equal(paths.length, 4);
  for (const path of paths) {
    assert.ok(existsSync(new URL(`../..${path}`, import.meta.url)), path);
  }
  const html = readFileSync(new URL('../../index.html', import.meta.url), 'utf8');
  assert.ok(html.indexOf('/assets/invite-gate.js') < html.indexOf('/assets/optional-pages.js'));
  assert.match(html, /<script src="\/assets\/onboarding-flow\.js"><\/script>/);
  for (const file of ['landing', 'bulk-invite', 'email-validation', 'calendar-export']) {
    assert.doesNotMatch(html, new RegExp(`<script[^>]+src="/assets/${file}\\.js"`));
  }
  const vercel = JSON.parse(readFileSync(new URL('../../vercel.json', import.meta.url), 'utf8'));
  const csp = vercel.headers.find(h => h.source === '/(.*)').headers.find(h => h.key === 'Content-Security-Policy').value;
  assert.match(csp, /script-src 'self'/);
});
