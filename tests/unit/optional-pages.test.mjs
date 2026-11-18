import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import vm from 'node:vm';
import { test } from 'node:test';

const source = readFileSync(new URL('../../assets/optional-pages.js', import.meta.url), 'utf8');
const settle = () => new Promise(resolve => setImmediate(resolve));

class Element {
  constructor(tag = 'div') {
    this.tagName = tag.toUpperCase(); this.children = []; this.listeners = {};
    this.attributes = {}; this.dataset = {}; this.style = { display: 'none' };
    this.hidden = false; this.inert = false; this.textContent = '';
  }
  append(...nodes) { this.children.push(...nodes); }
  prepend(node) { this.children.unshift(node); }
  setAttribute(key, value) { this.attributes[key] = value; }
  querySelector(selector) { return selector === '.landing' ? this.content : this.focusTarget; }
  addEventListener(type, listener) { this.listeners[type] = listener; }
  remove() { this.removed = true; }
  focus() { this.focused = true; }
}

function browser() {
  const scripts = [];
  const views = new Map(['landing', 'invite', 'activation', 'password-reset'].map(id => {
    const view = new Element(); view.content = new Element(); view.content.focusTarget = new Element('button');
    return [`view-${id}`, view];
  }));
  const timers = new Map(); let timerId = 0;
  const doc = {
    readyState: 'loading', activeElement: null,
    createElement: tag => new Element(tag),
    getElementById: id => views.get(id),
    head: { appendChild: script => scripts.push(script) },
    addEventListener(type, callback) { this[type] = callback; },
  };
  const window = {
    document: doc,
    setTimeout(callback) { const id = ++timerId; timers.set(id, callback); return id; },
    clearTimeout(id) { timers.delete(id); },
    MutationObserver: class {
      constructor(callback) { this.callback = callback; }
      observe(view) { view.observer = this.callback; }
    },
  };
  vm.runInNewContext(source, { window, Promise, Map, Object, Error });
  return { window, doc, views, scripts, timers, load: window._randori_optional_pages.load };
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
  assert.equal(view.content.inert, true);
  assert.equal(view.content.attributes['aria-busy'], 'true');
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
  assert.equal(view.content.inert, true);
  b.doc.activeElement = retry;
  retry.listeners.click();
  assert.equal(b.scripts[1].src, '/assets/email-validation.js?retry=1');
  finish(b.scripts[1], b, 'email'); await settle();
  finish(b.scripts[2], b, 'landing', { setCapabilities() {}, applyRecovery() {} }); await settle();
  assert.equal(view.content.inert, false);
  assert.equal(notice.hidden, true);
  assert.equal(view.content.focusTarget.focused, true);
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
