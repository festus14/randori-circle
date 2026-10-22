import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import vm from 'node:vm';

import { CANONICAL_ORIGIN, LEGACY_ORIGIN, WWW_ORIGIN } from '../../scripts/canonical-domain.mjs';

const html = readFileSync(new URL('../../index.html', import.meta.url), 'utf8');
const LOADER_URL = 'https://js-de.sentry-cdn.com/b4aa012a94edbcd36c8c92ef1aaeddfa.min.js';
const LOADER_TAG = `<script id="randoriSentryLoader" type="text/plain" data-src="${LOADER_URL}"></script>`;
// ID-80: the canonical domain, not the old Vercel alias.
const PRODUCTION_ORIGIN = 'https://randoricircle.com';

function configScript() {
  const match = html.match(/<script id="randoriSentryConfig">([\s\S]*?)<\/script>/);
  assert.ok(match, 'index.html must define the randoriSentryConfig script');
  return match[1];
}

function runConfig(href, { webdriver = false, localRuntime = false } = {}) {
  const url = new URL(href);
  const window = {
    location: { href: url.href, origin: url.origin, hostname: url.hostname },
    navigator: { webdriver },
  };
  if (localRuntime) window.__RANDORI_LOCAL_RUNTIME__ = true;
  vm.runInNewContext(configScript(), { window });
  const initCalls = [];
  window.Sentry = { init: options => initCalls.push(options) };
  window.sentryOnLoad();
  assert.equal(initCalls.length, 1);
  return { window, options: initCalls[0] };
}

test('the Sentry config runs before the DE loader so sentryOnLoad can scope it', () => {
  const configIndex = html.indexOf('<script id="randoriSentryConfig">');
  const loaderIndex = html.indexOf(LOADER_TAG);
  assert.ok(configIndex > 0 && loaderIndex > configIndex);
  assert.equal(html.split(LOADER_TAG).length, 2, 'exactly one Sentry loader tag');
  // The loader URL appears only in the inert tag: nothing fetches it while parsing.
  assert.equal(html.split(LOADER_URL).length, 2);
  assert.doesNotMatch(html, /<script[^>]+\ssrc="https:\/\/js-de\.sentry-cdn\.com/);
  // The local runtime strips this exact tag; keep both in sync.
  assert.ok(readFileSync(new URL('../../scripts/local-server.mjs', import.meta.url), 'utf8').includes(LOADER_TAG));
});

test('the canonical production origin reports with environment=production', () => {
  const { window, options } = runConfig(`${PRODUCTION_ORIGIN}/history?week=1`);
  assert.equal(options.environment, 'production');
  assert.equal(options.enabled, true);
  assert.equal(options.sendDefaultPii, false);
  const event = { message: 'kept' };
  assert.equal(options.beforeSend(event), event);
  assert.equal(options.beforeSendTransaction(event), event);
  assert.deepEqual({ ...window.__randoriSentry }, { environment: 'production', enabled: true, productionOrigin: PRODUCTION_ORIGIN });
});

for (const [name, href, environment, flags] of [
  ['vercel preview', 'https://randori-circle-git-feature-festus14.vercel.app/', 'preview', {}],
  ['look-alike vercel host', 'https://randori-circle.vercel.app/', 'preview', {}],
  ['playwright static server', 'http://127.0.0.1:4173/', 'development', {}],
  ['localhost', 'http://localhost:3000/', 'development', {}],
  ['legacy Vercel alias (ID-80)', `${LEGACY_ORIGIN}/invite?x=1`, 'preview', {}],
  ['legacy Vercel alias over http', 'http://randori-circle-self.vercel.app/', 'preview', {}],
  ['www alias of the canonical host', `${WWW_ORIGIN}/`, 'development', {}],
  ['http canonical host', 'http://randoricircle.com/', 'development', {}],
  ['canonical host on another port', 'https://randoricircle.com:8443/', 'development', {}],
  ['look-alike canonical suffix', 'https://randoricircle.com.evil.test/', 'development', {}],
  ['canonical subdomain', 'https://app.randoricircle.com/', 'development', {}],
  ['other origin', 'https://example.test/', 'development', {}],
  ['local runtime marker', `${PRODUCTION_ORIGIN}/`, 'production', { localRuntime: true }],
  ['automated browser on production', `${PRODUCTION_ORIGIN}/`, 'production', { webdriver: true }],
]) {
  test(`non-production browser contexts never send Sentry events: ${name}`, () => {
    const { window, options } = runConfig(href, flags);
    assert.equal(options.environment, environment);
    assert.equal(options.enabled, false);
    assert.equal(options.beforeSend({ message: 'dropped' }), null);
    assert.equal(options.beforeSendTransaction({ type: 'transaction' }), null);
    assert.equal(window.__randoriSentry.enabled, false);
  });
}

test('browser Sentry reports errors only: no tracing, session replay or logs on any origin (ID-79)', () => {
  // The loader's dashboard config enables tracing, replay and logs; these
  // init options override it, and the Privacy Policy promises they are off.
  for (const [href, flags] of [[`${PRODUCTION_ORIGIN}/`, {}], ['https://randori-circle-git-x.vercel.app/', {}],
    ['http://127.0.0.1:4173/', {}], [`${PRODUCTION_ORIGIN}/`, { webdriver: true }]]) {
    const { options } = runConfig(href, flags);
    assert.equal(options.tracesSampleRate, 0, href);
    assert.equal(options.replaysSessionSampleRate, 0, href);
    assert.equal(options.replaysOnErrorSampleRate, 0, href);
    assert.equal(options.enableLogs, false, href);
    assert.equal(options.sendDefaultPii, false, href);
    assert.equal('integrations' in options, false, 'no integrations (such as replay) are added in code');
  }
  const privacy = readFileSync(new URL('../../privacy.html', import.meta.url), 'utf8');
  assert.match(privacy, /We don’t use Sentry’s session recording or performance tracing in your browser\./);
});

test('the client logger forwarding is only installed when Sentry is enabled', () => {
  assert.match(html, /if\(window\.Sentry&&window\.__randoriSentry&&window\.__randoriSentry\.enabled\)\{\s*window\._sentryReady=true;/);
});

test('the browser production origin matches the documented production APP_URL', () => {
  const guide = readFileSync(new URL('../../docs/PRODUCTION_BOOTSTRAP_GUIDE.md', import.meta.url), 'utf8');
  assert.match(guide, new RegExp(`\\| \`APP_URL\` \\| \`${PRODUCTION_ORIGIN.replace(/[.]/g, '\\.')}\` \\|`));
  assert.ok(configScript().includes(`var PRODUCTION_ORIGIN='${PRODUCTION_ORIGIN}';`));
});

test('the browser production origin is the canonical domain and index.html never names the old alias (ID-80)', () => {
  assert.equal(PRODUCTION_ORIGIN, CANONICAL_ORIGIN);
  // The gate and the session-link fallback both use the canonical origin; the
  // old alias appears nowhere, so it can only ever be tagged preview.
  assert.equal(html.includes(new URL(LEGACY_ORIGIN).hostname), false);
  assert.match(html, /const base = location\.origin \|\| 'https:\/\/randoricircle\.com';/);
});

function loadScript() {
  const match = html.match(/<script id="randoriSentryLoad">([\s\S]*?)<\/script>/);
  assert.ok(match, 'index.html must define the randoriSentryLoad script');
  return match[1];
}

// Runs the idle loader against a minimal fake page. The tag attribute is the
// loader URL, or null when the local runtime stripped the inert tag.
function runLoader({ src = LOADER_URL, readyState = 'loading', idle = true, enabled = false, logger } = {}) {
  const listeners = new Map();
  const appended = [];
  const idleCallbacks = [];
  const captured = [];
  const window = {
    __randoriSentry: Object.freeze({ environment: enabled ? 'production' : 'development', enabled, productionOrigin: PRODUCTION_ORIGIN }),
    addEventListener(type, listener) { listeners.set(type, [...(listeners.get(type) || []), listener]); },
    removeEventListener(type, listener) { listeners.set(type, (listeners.get(type) || []).filter(item => item !== listener)); },
  };
  if (logger) window._randori_log = logger;
  if (idle) window.requestIdleCallback = (callback, options) => idleCallbacks.push({ callback, options });
  const document = {
    readyState,
    getElementById: id => (id === 'randoriSentryLoader' && src !== null ? { getAttribute: name => (name === 'data-src' ? src : null) } : null),
    createElement: () => ({}),
    head: { appendChild: node => appended.push(node) },
  };
  const timers = [];
  // As in a browser, window is the global object (the script also uses bare `Sentry`).
  Object.assign(window, { window, document, console: { log() {}, warn() {} }, setTimeout: callback => timers.push(callback) });
  const context = vm.createContext(window);
  vm.runInContext(loadScript(), context);
  // Errors must come from the page's own realm, as they do in a browser.
  const makeError = message => vm.runInContext(`new Error(${JSON.stringify(message)})`, context);
  const fire = (type, event = { type }) => (listeners.get(type) || []).slice().forEach(listener => listener(event));
  const sentry = {
    addEventProcessor() {},
    captureException: (error, options) => captured.push({ error, options }),
    captureMessage: (message, options) => captured.push({ message, options }),
  };
  return { window, appended, idleCallbacks, timers, captured, fire, listeners, sentry, makeError };
}

test('the Sentry loader is not fetched while the page parses, only after load when the browser is idle', () => {
  const page = runLoader();
  assert.equal(page.appended.length, 0, 'nothing is fetched before the load event');
  assert.equal(page.window._sentryReady, undefined);
  page.fire('load');
  assert.equal(page.appended.length, 0, 'load only schedules an idle callback');
  assert.equal(page.idleCallbacks.length, 1);
  assert.equal(page.idleCallbacks[0].options.timeout, 3000);
  page.idleCallbacks[0].callback();
  assert.equal(page.appended.length, 1);
  assert.equal(page.appended[0].src, LOADER_URL);
  assert.equal(page.appended[0].crossOrigin, 'anonymous');
  // Outside production the SDK stays off; a blocked or failed loader says so.
  page.appended[0].onerror();
  assert.equal(page.window._sentryReady, false);
});

test('a page that already finished loading schedules the loader at once, with a timer fallback', () => {
  const page = runLoader({ readyState: 'complete', idle: false });
  assert.equal(page.timers.length, 1);
  page.timers[0]();
  assert.equal(page.appended.length, 1);
});

test('the local runtime strips the inert tag and nothing is fetched', () => {
  const page = runLoader({ src: null });
  page.fire('load');
  assert.equal(page.appended.length, 0);
  assert.equal(page.idleCallbacks.length, 0);
  assert.equal(page.window._sentryReady, false);
  assert.equal((page.listeners.get('error') || []).length, 0);
});

test('production errors raised before the loader arrives are reported once it has', () => {
  const page = runLoader({ enabled: true, logger: { _lastEvent: '' } });
  const boot = page.makeError('boot failure');
  page.fire('error', { type: 'error', error: boot });
  page.fire('unhandledrejection', { type: 'unhandledrejection', reason: 'rejected early' });
  page.fire('load');
  page.idleCallbacks[0].callback();
  page.window.Sentry = page.sentry;
  page.appended[0].onload();
  assert.equal(page.window._sentryReady, true);
  assert.deepEqual(page.captured.map(entry => entry.error || entry.message), [boot, 'rejected early']);
  assert.equal((page.listeners.get('error') || []).length, 0, 'the early-error buffer is removed once the loader ran');
});

test('outside production early errors are dropped, not reported', () => {
  const page = runLoader({ enabled: false });
  page.fire('error', { type: 'error', error: page.makeError('dev only') });
  page.fire('load');
  page.idleCallbacks[0].callback();
  page.window.Sentry = page.sentry;
  page.appended[0].onload();
  assert.equal(page.window._sentryReady, false);
  assert.deepEqual(page.captured, []);
});

test('no environment creates a logger placeholder, so the client logger installs in production too (ID-72)', () => {
  for (const href of [`${PRODUCTION_ORIGIN}/`, 'https://randori-circle-git-feature-festus14.vercel.app/', 'http://127.0.0.1:4173/']) {
    const { window } = runConfig(href);
    assert.equal(window._randori_log, undefined, href);
  }
  assert.doesNotMatch(configScript(), /_randori_log\s*=/);
});

test('the Sentry step never creates, replaces or wraps the logger', () => {
  for (const logger of [undefined, { _lastEvent: '' }, { log() {}, _lastEvent: '' }]) {
    const log = logger?.log;
    const page = runLoader({ enabled: true, logger });
    page.fire('load');
    page.idleCallbacks[0].callback();
    page.window.Sentry = page.sentry;
    page.appended[0].onload();
    assert.equal(page.window._sentryReady, true);
    assert.equal(page.window.__randoriPatchLogger, undefined);
    assert.equal(page.window._randori_log, logger);
    assert.equal(logger?.log, log);
  }
});
