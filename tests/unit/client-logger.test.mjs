// ID-72: the inline client logger in index.html, run in a VM against a fake
// page. Covers the redaction helper (and its parity with the API backstop),
// the production level rule, signed-out suppression and identity changes,
// dedupe and the per-page cap, and the Sentry interplay.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import vm from 'node:vm';

import { redactLogText } from '../../api/_client-log-policy.js';

const html = readFileSync(new URL('../../index.html', import.meta.url), 'utf8');
const PRODUCTION_ORIGIN = 'https://randori-circle-self.vercel.app';
const START = Date.parse('2026-10-20T12:00:00.000Z');

function inlineScript(id) {
  const match = html.match(new RegExp(`<script id="${id}">([\\s\\S]*?)<\\/script>`));
  assert.ok(match, `index.html must define the ${id} script`);
  return match[1];
}

// A minimal page: a global window with location, timers, fetch and console
// recorders, an optional _randori_auth stub, and a controllable clock.
function createPage({ href = 'http://127.0.0.1:4173/', environment = 'development', auth, logger, sentry } = {}) {
  const url = new URL(href);
  const listeners = new Map();
  const fetches = [];
  const consoleLines = [];
  const timers = [];
  const clock = { now: START };
  const window = {
    location: { href: url.href, origin: url.origin, pathname: url.pathname, search: url.search, hash: url.hash },
    navigator: { userAgent: 'unit-test-agent' },
    __randoriSentry: { environment },
    addEventListener(type, listener) { listeners.set(type, [...(listeners.get(type) || []), listener]); },
    removeEventListener(type, listener) { listeners.set(type, (listeners.get(type) || []).filter(item => item !== listener)); },
    fetch(path, options) {
      fetches.push({ path, options, body: JSON.parse(options.body) });
      return Promise.resolve({ ok: true });
    },
    setTimeout(callback, ms) { timers.push({ callback, ms }); return timers.length; },
    setInterval() { return 0; },
    console: Object.fromEntries(['log', 'warn', 'error', 'debug'].map(level => [level, (...args) => consoleLines.push([level, args.join(' ')])])),
  };
  if (auth !== undefined) window._randori_auth = auth;
  if (logger !== undefined) window._randori_log = logger;
  if (sentry) window.Sentry = sentry;
  window.window = window;
  window.Date = class extends Date {
    constructor(...args) { super(...(args.length ? args : [clock.now])); }
    static now() { return clock.now; }
  };
  const context = vm.createContext(window);
  const run = source => vm.runInContext(source, context);
  run(inlineScript('randoriClientLogger'));
  return {
    window,
    run,
    fetches,
    consoleLines,
    timers,
    clock,
    log: () => window._randori_log,
    // Plain copies: values from the VM realm have their own prototypes.
    queue: () => JSON.parse(JSON.stringify(window._randori_log.queue)),
    fire: (type, event) => (listeners.get(type) || []).forEach(listener => listener(event)),
    sent: () => fetches.flatMap(({ body }) => body.logs || [body]),
  };
}

const signedIn = (id = 1) => ({ me: { id }, identitySettled: true });
const signedOut = () => ({ me: null, identitySettled: true });

// One corpus for both implementations; `expected` pins the intended output.
const REDACTION_CORPUS = [
  ['https://randori-circle-self.vercel.app/invite#invite=' + 'A'.repeat(43), 'https://randori-circle-self.vercel.app/invite'],
  ['    at boot (https://randori-circle-self.vercel.app/reset#token=abc:12:34)', '    at boot (https://randori-circle-self.vercel.app/reset:12:34)'],
  ['at https://randori-circle-self.vercel.app/#token=abc.def:1697:23', 'at https://randori-circle-self.vercel.app/:1697:23'],
  ['redirect to /verify#token=abc then /invite#invite=xyz', 'redirect to /verify then /invite'],
  ['hash was #invite=xyz', 'hash was #invite=[redacted]'],
  ['/api/data?endpoint=x&token=abc123&view=code -> 401', '/api/data?endpoint=x&token=[redacted]&view=code -> 401'],
  ['g_token=one access_token=two x-api-key=three cycleKey=kept', 'g_token=[redacted] access_token=[redacted] x-api-key=[redacted] cycleKey=kept'],
  ['/oauth?code=one-time&state=s', '/oauth?code=[redacted]&state=s'],
  ['body {"invite_token":"se\\"cret","ok":true}', 'body {"invite_token":"[redacted]","ok":true}'],
  ['Authorization: Bearer abc.def-ghi', 'Authorization: Bearer [redacted]'],
  ['jwt eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.signature_part', 'jwt [jwt]'],
  ['member alice.smith+x@example.co.uk failed', 'member [email] failed'],
  ['firefox frame boot@https://x.test/a.js:1:2 and pkg@1.2.3', 'firefox frame boot@https://x.test/a.js:1:2 and pkg@1.2.3'],
  ['issue #123 in #logsArea and ?view=code', 'issue #123 in #logsArea and ?view=code'],
  ['/'.repeat(50) + '#fragment', '/'.repeat(50)],
  ['x'.repeat(100) + '@example.test', 'x'.repeat(36) + '[email]'],
];

test('redaction strips fragments, secret pairs, bearer tokens, JWTs and emails, identically in the browser and the API', () => {
  const { log } = createPage();
  for (const [input, expected] of REDACTION_CORPUS) {
    assert.equal(log()._redact(input), expected, input);
    assert.equal(redactLogText(input), expected, `API backstop: ${input}`);
  }
  assert.equal(log()._redact(null), '');
  assert.equal(log()._redact('x'.repeat(9000)).length, 8000);
});

test('outside production every level is queued; on the production origin only warn and error are', () => {
  const levels = ['info', 'warn', 'error', 'success', 'debug'];
  const preview = createPage({ href: 'https://randori-circle-git-x.vercel.app/', environment: 'preview', auth: signedIn() });
  levels.forEach(level => preview.log()[level]('probe', `${level} entry`));
  assert.deepEqual(preview.queue().map(entry => entry.level), levels);

  const production = createPage({ href: `${PRODUCTION_ORIGIN}/`, environment: 'production', auth: signedIn() });
  levels.forEach(level => production.log()[level]('probe', `${level} entry`));
  production.log().log('bogus', 'probe', 'unknown level is info');
  assert.deepEqual(production.queue().map(entry => entry.level), ['warn', 'error']);
  // Every level is still mirrored to the console.
  assert.equal(production.consoleLines.length, 6);
  production.log().flush();
  assert.deepEqual(production.sent().map(entry => entry.message), ['warn entry', 'error entry']);
  assert.equal(production.fetches[0].path, '/api/logs');
  assert.equal(production.fetches[0].options.credentials, 'same-origin');
});

test('a signed-out visitor queues and sends nothing', () => {
  const page = createPage({ auth: signedOut() });
  page.log().error('probe', 'visitor error');
  page.log().warn('probe', 'visitor warning');
  assert.deepEqual(page.queue(), []);
  page.log().flush();
  assert.deepEqual(page.fetches, []);
  assert.equal(page.consoleLines.length, 2);
});

test('entries from before identity settles go only to the identity it settles as', () => {
  const page = createPage();
  page.log().error('boot', 'boot error');
  assert.equal(page.queue().length, 1);
  page.log().flush();
  assert.deepEqual(page.fetches, [], 'nothing is sent while identity is unknown');
  page.window._randori_auth = { me: null, identitySettled: false };
  page.log().flush();
  assert.deepEqual(page.fetches, []);
  page.window._randori_auth = signedIn(7);
  page.log().flush();
  assert.deepEqual(page.sent().map(entry => entry.message), ['boot error']);

  const visitor = createPage();
  visitor.log().error('boot', 'boot error');
  visitor.window._randori_auth = signedOut();
  visitor.log().flush();
  assert.deepEqual(visitor.queue(), [], 'settling signed out drops the queue');
  visitor.window._randori_auth = signedIn(8);
  visitor.log().flush();
  assert.deepEqual(visitor.fetches, [], 'a later sign-in never receives the visitor entries');
});

test('an identity change clears the queue, so entries are never sent as another user', () => {
  const page = createPage({ auth: signedIn(1) });
  page.log().error('probe', 'user one error');
  page.window._randori_auth = signedIn(2);
  page.log().flush();
  assert.deepEqual(page.fetches, []);
  assert.deepEqual(page.queue(), []);
  page.log().error('probe', 'user two error');
  page.log().flush();
  assert.deepEqual(page.sent().map(entry => entry.message), ['user two error']);

  const signOut = createPage({ auth: signedIn(1) });
  signOut.log().warn('probe', 'before sign-out');
  signOut.window._randori_auth = signedOut();
  signOut.log().flush();
  signOut.window._randori_auth = signedIn(1);
  signOut.log().flush();
  assert.deepEqual(signOut.fetches, [], 'signing out drops the queue even if the same user returns');

  const uid = createPage({ auth: { me: { uid: 'u-9' } } });
  uid.log().warn('probe', 'legacy uid');
  uid.log().flush();
  assert.equal(uid.fetches.length, 1);
  const anonymousMe = createPage({ auth: { me: { id: '' } } });
  anonymousMe.log().warn('probe', 'no id yet');
  anonymousMe.log().flush();
  assert.deepEqual(anonymousMe.fetches, [], 'an account without an id is treated as unknown');
});

test('the same entry is queued at most once a minute, and at most 50 entries per page', () => {
  const page = createPage({ auth: signedIn() });
  for (let index = 0; index < 3; index += 1) page.log().error('api_fail', '/api/x -> 500');
  assert.equal(page.queue().length, 1);
  page.clock.now += 59_999;
  page.log().error('api_fail', '/api/x -> 500');
  assert.equal(page.queue().length, 1);
  page.clock.now += 1;
  page.log().error('api_fail', '/api/x -> 500');
  page.log().warn('api_fail', '/api/x -> 500');
  assert.equal(page.queue().length, 3, 'a minute later, and another level, are new entries');
  for (let index = 0; index < 60; index += 1) page.log().warn('probe', `distinct ${index}`);
  assert.equal(page.queue().length, 50);
  page.log().flush();
  page.log().flush();
  page.log().flush();
  assert.deepEqual(page.fetches.map(({ body }) => body.logs.length), [20, 20, 10]);
  page.clock.now += 120_000;
  page.log().error('probe', 'after the cap');
  assert.deepEqual(page.queue(), []);
  assert.equal(page.consoleLines.length, 67, 'the console still sees everything');
});

test('errors flush soon; a burst of other entries flushes on a short timer, at most every 3 s', () => {
  const page = createPage({ auth: signedIn() });
  page.log().warn('probe', 'one');
  page.log().warn('probe', 'two');
  assert.deepEqual(page.timers, []);
  page.log().warn('probe', 'three');
  assert.deepEqual(page.timers.map(timer => timer.ms), [400]);
  page.log().error('probe', 'four');
  assert.deepEqual(page.timers.map(timer => timer.ms), [400, 200]);
  page.timers[1].callback();
  assert.equal(page.sent().length, 4);
  ['five', 'six', 'seven'].forEach(message => page.log().warn('probe', message));
  assert.equal(page.timers.length, 2, 'no burst timer within 3 s of the last flush');
  page.clock.now += 3_001;
  page.log().warn('probe', 'eight');
  assert.deepEqual(page.timers.map(timer => timer.ms), [400, 200, 400]);
});

test('an entry carries pathname and search only, redacted, and no href or user agent', () => {
  const secret = 'S'.repeat(43);
  const page = createPage({ href: `${PRODUCTION_ORIGIN}/invite?view=code&token=abc#invite=${secret}`, environment: 'production', auth: signedIn() });
  const metaError = page.run('new Error("meta failure for bob@example.test")');
  page.log().error('probe', `failed ${PRODUCTION_ORIGIN}/invite#invite=${secret} for bob@example.test`, {
    url: `/invite#invite=${secret}`,
    inviteToken: secret,
    nested: { list: ['carol@example.test', 2, true, null], deep: { deeper: { deepest: { gone: 1 } } } },
    err: metaError,
    big: 10n,
  });
  page.log().warn('probe', 'scalar meta', 'value with token=abc');
  page.log().warn('probe', 'error meta', metaError);
  page.log().flush();
  const [entry, scalar, errorMeta] = page.sent();
  assert.equal(entry.route, '/invite?view=code&token=[redacted]');
  assert.equal(entry.meta.route, entry.route);
  assert.equal(entry.message, `failed ${PRODUCTION_ORIGIN}/invite for [email]`);
  assert.equal(entry.meta.url, '/invite');
  assert.equal(entry.meta.inviteToken, '[redacted]');
  assert.deepEqual(entry.meta.nested, { list: ['[email]', 2, true, null], deep: { deeper: { deepest: '[truncated]' } } });
  assert.match(entry.meta.err, /^Error: meta failure for \[email\]/);
  assert.equal(entry.meta.big, '10');
  assert.equal('href' in entry.meta, false);
  assert.equal('ua' in entry.meta, false);
  assert.equal(scalar.meta.extra, 'value with token=[redacted]');
  assert.match(errorMeta.meta.extra, /^Error: meta failure for \[email\]/);
  const wire = JSON.stringify(page.fetches.map(({ body }) => body));
  for (const leaked of [secret, 'bob@example.test', 'carol@example.test', '#']) assert.equal(wire.includes(leaked), false, leaked);
  assert.equal(page.consoleLines.some(([, line]) => line.includes(secret) || line.includes('@example.test')), false);
});

test('uncaught errors and rejections are queued redacted, and the logger creates no Sentry events', () => {
  const calls = [];
  const sentry = {
    addBreadcrumb: crumb => calls.push(['breadcrumb', crumb]),
    captureMessage: (...args) => calls.push(['message', ...args]),
    captureException: (...args) => calls.push(['exception', ...args]),
  };
  const page = createPage({ auth: signedIn(), sentry });
  const error = page.run('new Error("boom for dave@example.test")');
  page.fire('error', { message: 'boom for dave@example.test', filename: `${PRODUCTION_ORIGIN}/#token=abc`, lineno: 3, colno: 4, error });
  page.fire('error', {});
  page.fire('unhandledrejection', { reason: page.run('new Error("rejected token=abc")') });
  page.fire('unhandledrejection', { reason: 'plain reason' });
  page.fire('unhandledrejection', {});
  const queue = page.queue();
  assert.deepEqual(queue.map(entry => entry.event), ['js_exception', 'js_exception', 'unhandled_rejection', 'unhandled_rejection', 'unhandled_rejection']);
  assert.equal(queue[0].message, `boom for [email] @ ${PRODUCTION_ORIGIN}/:3:4`);
  assert.equal(queue[0].meta.filename, `${PRODUCTION_ORIGIN}/`);
  assert.match(queue[0].meta.stack, /boom for \[email\]/);
  assert.equal(queue[1].message, 'js_exception @ ::');
  assert.equal(queue[2].message, 'rejected token=[redacted]');
  assert.equal(queue[3].message, 'plain reason');
  assert.equal(queue[4].message, '[object Object]');
  assert.deepEqual(calls.filter(([kind]) => kind !== 'breadcrumb'), []);
  const crumbs = calls.map(([, crumb]) => crumb);
  assert.equal(crumbs.length, 5);
  assert.equal(crumbs[0].level, 'error');
  assert.equal(crumbs[0].message, `js_exception: boom for [email] @ ${PRODUCTION_ORIGIN}/:3:4`);
  page.log().warn('probe', 'warn crumb');
  page.log().info('probe', 'info crumb');
  assert.deepEqual(calls.slice(-2).map(([, crumb]) => crumb.level), ['warning', 'info']);
});

test('safe() logs and reports a thrown error and returns the result otherwise', () => {
  const exceptions = [];
  const page = createPage({ auth: signedIn(), sentry: { captureException: (error, options) => exceptions.push(options.tags.event) } });
  assert.equal(page.window._randori_safe(() => 42), 42);
  page.window._randori_safe(() => { throw new Error('first'); }, 'custom_event');
  page.window._randori_safe(() => { throw 'second'; });
  assert.deepEqual(page.queue().map(entry => [entry.event, entry.message]), [['custom_event', 'first'], ['js_exception', 'second']]);
  assert.deepEqual(exceptions, ['custom_event', 'safe_wrapper']);
});

test('the logger replaces a placeholder, keeps a real logger, and asks the Sentry step to patch it', () => {
  const placeholder = { _lastEvent: 'boot_event' };
  const page = createPage({ logger: placeholder });
  assert.notEqual(page.log(), placeholder);
  assert.equal(typeof page.log().log, 'function');
  assert.equal(page.log()._lastEventVal, 'boot_event');
  assert.equal(page.window._log, page.log().log);

  const real = { log() {} };
  assert.equal(createPage({ logger: real }).log(), real);

  let patched = 0;
  const hooked = createPage({ logger: real });
  hooked.window._randori_log = undefined;
  hooked.window.__randoriPatchLogger = () => { patched += 1; };
  hooked.run(inlineScript('randoriClientLogger'));
  assert.equal(patched, 1);
  hooked.run(inlineScript('randoriClientLogger'));
  assert.equal(patched, 1, 'an installed logger is never reinstalled');
  hooked.window._randori_log = undefined;
  hooked.window.__randoriPatchLogger = () => { throw new Error('patch failure'); };
  assert.doesNotThrow(() => hooked.run(inlineScript('randoriClientLogger')));
  assert.equal(typeof hooked.log().log, 'function');
});

test('the logger methods record the last event for Sentry tagging', () => {
  const page = createPage({ auth: signedIn() });
  page.log().warn('first_event', 'one');
  assert.equal(page.log()._lastEvent, 'first_event');
  page.log().log('error', 'second_event', 'two');
  assert.equal(page.log()._lastEvent, 'second_event');
  assert.equal(page.log()._lastEventVal, 'second_event');
  page.log().error(null, 'no event');
  assert.equal(page.queue().at(-1).event, 'app');
});

// The Sentry load step and the logger share one page here.
function runSentryStep(page) {
  const appended = [];
  page.window.__randoriSentry = Object.freeze({ environment: 'production', enabled: true, productionOrigin: PRODUCTION_ORIGIN });
  page.window.document = {
    readyState: 'complete',
    getElementById: () => ({ getAttribute: () => 'https://js-de.sentry-cdn.com/loader.min.js' }),
    createElement: () => ({}),
    head: { appendChild: node => appended.push(node) },
  };
  page.window.requestIdleCallback = callback => callback();
  page.run(inlineScript('randoriSentryLoad'));
  return appended[0];
}

test('the Sentry step patches the real logger exactly once, whichever script runs first', () => {
  const captured = [];
  const sentry = {
    addEventProcessor() {},
    addBreadcrumb() {},
    captureMessage: (message, options) => captured.push([message, options.level]),
    captureException: () => captured.push(['exception']),
  };
  // Logger first (the normal order): the step patches it when Sentry loads.
  const loggerFirst = createPage({ href: `${PRODUCTION_ORIGIN}/`, environment: 'production', auth: signedIn() });
  const loader = runSentryStep(loggerFirst);
  loggerFirst.window.Sentry = sentry;
  loader.onload();
  assert.equal(loggerFirst.window._sentryReady, true);
  assert.equal(loggerFirst.log()._sentryPatched, true);
  loggerFirst.log().log('error', 'patched_event', 'failed with token=abc');
  loggerFirst.log().log('warn', 'patched_event', 'slow');
  loggerFirst.log().log('info', 'patched_event', 'fine');
  loggerFirst.log().error('direct_event', 'direct calls are not forwarded');
  assert.deepEqual(captured, [['failed with token=[redacted]', 'error'], ['slow', 'warning']]);
  // Production queues warn and error only, so the info call stays local.
  assert.deepEqual(loggerFirst.queue().map(entry => entry.event), ['patched_event', 'patched_event', 'direct_event']);
  const patchedLog = loggerFirst.log().log;
  loggerFirst.window.__randoriPatchLogger();
  assert.equal(loggerFirst.log().log, patchedLog, 'a second patch is a no-op');

  // Sentry step first: the logger asks it to patch once it installs.
  captured.length = 0;
  const stepFirst = createPage({ href: `${PRODUCTION_ORIGIN}/`, environment: 'production' });
  stepFirst.window._randori_log = undefined;
  const stepLoader = runSentryStep(stepFirst);
  stepFirst.window.Sentry = sentry;
  stepLoader.onload();
  assert.equal(stepFirst.window._randori_log, undefined);
  stepFirst.run(inlineScript('randoriClientLogger'));
  assert.equal(stepFirst.log()._sentryPatched, true);
  stepFirst.log().log('error', 'late_event', 'late logger');
  assert.deepEqual(captured, [['late logger', 'error']]);
  assert.equal(stepFirst.log()._lastEvent, 'late_event');
});
