// ID-72: the inline client logger in index.html, run in a VM against a fake
// page. Covers the redaction helper (and its parity with the API backstop),
// the production level rule, signed-out suppression and identity changes,
// dedupe and the per-page cap, and the Sentry interplay.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import vm from 'node:vm';

import { redactLogText, redactLogValue } from '../../api/_client-log-policy.js';

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
  ['hash was #invite=xyz and #/invite/SECRET', 'hash was  and '],
  ['/api/data?endpoint=x&token=abc123&view=code -> 401', '/api/data?endpoint=x&token=[redacted]&view=code -> 401'],
  ['g_token=one access_token=two x-api-key=three x_session=four cycleKey=kept', 'g_token=[redacted] access_token=[redacted] x-api-key=[redacted] x_session=[redacted] cycleKey=kept'],
  ['accessToken=a apiKey=b inviteToken=c refreshToken=d sessionId=e session_id=f sid=g', 'accessToken=[redacted] apiKey=[redacted] inviteToken=[redacted] refreshToken=[redacted] sessionId=[redacted] session_id=[redacted] sid=[redacted]'],
  ['/oauth?code=one-time&state=s', '/oauth?code=[redacted]&state=s'],
  ['body {"invite_token":"se\\"cret","ok":true}', 'body {"invite_token":"[redacted]","ok":true}'],
  ['body {"accessToken":"abc","otp":123456,"code":987654,"ok":true}', 'body {"accessToken":"[redacted]","otp":"[redacted]","code":"[redacted]","ok":true}'],
  ['escaped {\\"token\\":\\"S\\",\\"ok\\":true}', 'escaped {\\"token\\":\\"[redacted]\\",\\"ok\\":true}'],
  ['Authorization: Bearer abc.def-ghi', 'Authorization: [redacted]'],
  ['Authorization: Token abc123, authorization=Bearer xyz', 'Authorization: [redacted], authorization=[redacted]'],
  ['retry with Bearer abc.def', 'retry with Bearer [redacted]'],
  ['password: hunter2 and secret : s3', 'password: [redacted] and secret : [redacted]'],
  ['jwt eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.signature_part', 'jwt [jwt]'],
  ['member alice.smith+x@example.co.uk failed', 'member [email] failed'],
  ['MEMBER JANE.DOE@EXAMPLE.COM FAILED', 'MEMBER [email] FAILED'],
  ['/api/members?q=jane%40example.com -> 500', '/api/members?q=[email] -> 500'],
  ['%23token%3Dsecret and ?next=%2Finvite%23invite%3DSSSS', ' and ?next=/invite'],
  ['firefox frame boot@https://x.test/a.js:1:2 and pkg@1.2.3', 'firefox frame boot@https://x.test/a.js:1:2 and pkg@1.2.3'],
  ['issue #123 in #logsArea and ?view=code', 'issue #123 in #logsArea and ?view=code'],
  ['/'.repeat(50) + '#fragment', '/'.repeat(50)],
  ['x'.repeat(100) + '@example.test', 'x'.repeat(36) + '[email]'],
  ['headers: {Authorization: "Bearer abc.def"}', 'headers: {Authorization: "[redacted]"}'],
  ["{ Authorization: 'Bearer abc' } and Authorization=\"Bearer abc\"", "{ Authorization: '[redacted]' } and Authorization=\"[redacted]\""],
  ['token="abc" password=\'x\' activationToken=y x-csrf=z', 'token="[redacted]" password=\'[redacted]\' activationToken=[redacted] x-csrf=[redacted]'],
  ['code: 123456, secret_key: k, status code: 500', 'code: [redacted], secret_key: [redacted], status code: 500'],
  ['jane%2540example.com and jane%2Edoe%40example%2Ecom', '[email] and [email]'],
];

// One object corpus for both implementations, so the key rules, limits and
// the 16k-character budget cannot drift.
const VALUE_CORPUS = [
  { path: '/api/x?token=abc', email: 'erin@example.test', count: 3, ok: false, missing: null },
  { accessToken: 'a', apiKey: 'b', api_key: 'c', sessionId: 'd', sid: 'e', code: 'print(1)', otp: 1, cycleKey: 'kept', key: 'k' },
  { list: Array.from({ length: 25 }, (_, index) => `item ${index} frank@example.test`) },
  { a: { b: { c: { d: 'too deep' } } } },
  Object.fromEntries(Array.from({ length: 40 }, (_, index) => [`k${index}`, index])),
  { big: 'x '.repeat(5000), bigger: 'y '.repeat(5000), after: 'gone' },
  Object.fromEntries(Array.from({ length: 28 }, (_, k) => [`k${k}`, Array.from({ length: 20 }, () => 'eyJ-'.repeat(2000))])),
];

test('redaction strips fragments, secret pairs, credentials, JWTs and emails, identically in the browser and the API', () => {
  const { log } = createPage();
  for (const [input, expected] of REDACTION_CORPUS) {
    assert.equal(log()._redact(input), expected, input);
    assert.equal(redactLogText(input), expected, `API backstop: ${input}`);
  }
  assert.equal(log()._redact(null), '');
  for (const value of VALUE_CORPUS) {
    const browser = JSON.parse(JSON.stringify(log()._redactValue(value)));
    assert.deepEqual(browser, redactLogValue(value));
  }
  const budgeted = redactLogValue(VALUE_CORPUS[5]);
  assert.equal(budgeted.after, '[truncated]', 'values past the 16k budget are dropped');
  assert.ok(JSON.stringify(redactLogValue(VALUE_CORPUS[6])).length < 17_000);
});

test('a cut never keeps half a token: the partial trailing token is dropped before redaction', () => {
  const { log } = createPage();
  const email = 'x '.repeat(3995) + 'jane.doe@gmail.com';
  const jwt = 'y '.repeat(3990) + 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.sig';
  for (const redact of [log()._redact, redactLogText]) {
    assert.equal(redact(email), 'x '.repeat(3995) + '[truncated]');
    assert.equal(redact(jwt), 'y '.repeat(3990) + '[truncated]');
    assert.equal(redact('a '.repeat(10) + 'token=abcdef', 23), 'a '.repeat(10) + '[truncated]');
    assert.equal(redact('x'.repeat(9000)), '[truncated]');
    assert.equal(redact('{"token":"abcdef","x":1}', 14), '{"token":"[truncated]');
  }
});

// Fastest of five runs, to keep scheduler noise out of the comparison.
function fastest(redact, input) {
  let best = Infinity;
  for (let run = 0; run < 5; run += 1) {
    const started = performance.now();
    redact(input);
    best = Math.min(best, performance.now() - started);
  }
  return best;
}

test('adversarial input costs about as much as benign input of the same size, in both copies (C1)', () => {
  const { log } = createPage();
  // A quadratic pattern turns these into tens of milliseconds (the old \beyJ
  // JWT pattern took ~22 ms on the first one); benign text takes ~1-2 ms.
  const inputs = ['eyJ-'.repeat(2000), 'eyJaaaaaaaa.'.repeat(700), '-a'.repeat(4000), '\\"token\\":\\"'.repeat(600), '%40'.repeat(2600), '/'.repeat(8000)];
  for (const redact of [log()._redact, redactLogText]) {
    const benign = fastest(redact, 'x'.repeat(8000));
    for (const input of inputs) {
      const adversarial = fastest(redact, input);
      assert.ok(adversarial < 4 * benign + 2, `${input.slice(0, 12)}…: ${adversarial.toFixed(2)} ms vs ${benign.toFixed(2)} ms benign`);
    }
  }
  const benignValue = Object.fromEntries(Array.from({ length: 28 }, (_, k) => [`k${k}`, Array.from({ length: 20 }, () => 'x'.repeat(8000))]));
  for (const redact of [log()._redactValue, redactLogValue]) {
    const benign = fastest(redact, benignValue);
    const adversarial = fastest(redact, VALUE_CORPUS[6]);
    assert.ok(adversarial < 4 * benign + 2, `the C1 meta: ${adversarial.toFixed(2)} ms vs ${benign.toFixed(2)} ms benign`);
  }
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

test('the logger replaces a placeholder and keeps a real logger', () => {
  const placeholder = { _lastEvent: 'boot_event' };
  const page = createPage({ logger: placeholder });
  assert.notEqual(page.log(), placeholder);
  assert.equal(typeof page.log().log, 'function');
  assert.equal(page.log()._lastEventVal, 'boot_event');
  assert.equal(page.window._log, page.log().log);

  const real = { log() {} };
  assert.equal(createPage({ logger: real }).log(), real);
  const installed = createPage();
  const logger = installed.log();
  installed.run(inlineScript('randoriClientLogger'));
  assert.equal(installed.log(), logger, 'an installed logger is never reinstalled');
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

test('the Sentry step tags events with the last logger event and never wraps or forwards the logger', () => {
  const captured = [];
  const processors = [];
  const sentry = {
    addEventProcessor: processor => processors.push(processor),
    addBreadcrumb() {},
    captureMessage: (message, options) => captured.push([message, options.level]),
    captureException: () => captured.push(['exception']),
  };
  const page = createPage({ href: `${PRODUCTION_ORIGIN}/`, environment: 'production', auth: signedIn() });
  const log = page.log().log;
  const loader = runSentryStep(page);
  page.window.Sentry = sentry;
  loader.onload();
  assert.equal(page.window._sentryReady, true);
  assert.equal(page.log().log, log, 'the logger is not wrapped');
  assert.equal(page.window.__randoriPatchLogger, undefined);
  page.log().log('error', 'logged_event', 'failed with token=abc');
  page.log().warn('logged_event', 'slow');
  assert.deepEqual(captured, [], 'logger entries are breadcrumbs, not Sentry events');
  assert.deepEqual(page.queue().map(entry => entry.message), ['failed with token=[redacted]', 'slow']);
  const event = processors[0]({});
  assert.equal(event.tags.randori_event, 'logged_event');
  assert.equal(event.tags.app, 'randori-circle');
});

// The app's api() wrapper, extracted from index.html and run against stubs.
function loadApiWrapper({ responses }) {
  const source = html.slice(html.indexOf('  async function api(path, opts={}){'), html.indexOf('  function invalidateAuthRefreshes(){'));
  assert.ok(source.startsWith('  async function api('), 'index.html must define api()');
  const logged = [];
  const reported = [];
  const logger = Object.fromEntries(['info', 'warn', 'error'].map(level => [level, (event, message, meta) => logged.push({ level, event, message, meta })]));
  const context = vm.createContext({
    window: { _randori_log: logger, Sentry: {} },
    Sentry: {
      captureMessage: (message, options) => reported.push(['message', message, options]),
      captureException: (error, options) => reported.push(['exception', String(error.message), options]),
    },
    authCapabilities: {},
    activeCircleContext: null,
    performance,
    fetch: async path => {
      const next = responses.shift();
      // A network failure is an Error from the page's own realm.
      if (next === 'network') throw vm.runInContext('new TypeError("Failed to fetch")', context);
      return { ok: next.status < 400, status: next.status, text: async () => JSON.stringify(next.body) };
    },
  });
  context.window.Sentry = context.Sentry;
  return { api: vm.runInContext(`${source}; api`, context), logged, reported };
}

test('api() logs and reports each HTTP failure once, as a warning for 4xx, and never logs the query (m4)', async () => {
  const { api, logged, reported } = loadApiWrapper({ responses: [
    { status: 409, body: { error: 'schedule changed' } },
    { status: 503, body: { error: 'unavailable' } },
    'network',
  ] });
  await assert.rejects(api('/api/members?q=jane%40example.com'), problem => problem.http_status === 409);
  await assert.rejects(api('/api/schedule?room=week_1_pair_2'), problem => problem.http_status === 503);
  await assert.rejects(api('/api/profile?token=abc'), /Failed to fetch/);
  assert.deepEqual(logged.map(({ level, event, message }) => [level, event, message]), [
    ['warn', 'api_fail', '/api/members -> 409'],
    ['error', 'api_fail', '/api/schedule -> 503'],
    ['error', 'api_fail', 'api /api/profile failed: Failed to fetch'],
  ]);
  assert.deepEqual(logged.map(entry => entry.meta.path), ['/api/members', '/api/schedule', '/api/profile']);
  assert.deepEqual(reported.map(([kind, message, options]) => [kind, message, options.tags.path, options.level]), [
    ['message', 'api_fail /api/members', '/api/members', 'warning'],
    ['message', 'api_fail /api/schedule', '/api/schedule', 'error'],
    ['exception', 'Failed to fetch', '/api/profile', undefined],
  ]);
  assert.equal(JSON.stringify([logged, reported]).includes('jane'), false);
});
