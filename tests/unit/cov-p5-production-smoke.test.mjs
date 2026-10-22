import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  DEFAULT_EXPECTED_CAPABILITIES,
  SmokeConfigurationError,
  main,
  parseBaseUrl,
  resolveExpectedCapabilities,
  runProductionSmoke,
} from '../../scripts/production-smoke.mjs';
import { PUBLIC_PAGES } from '../../scripts/public-pages.mjs';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const ORIGIN = 'https://smoke.example.test';
const shell = readFileSync(new URL('../../index.html', import.meta.url), 'utf8');
const publicPages = Object.fromEntries(Object.entries(PUBLIC_PAGES)
  .map(([path, file]) => [path, readFileSync(new URL(`../../${file}`, import.meta.url), 'utf8')]));
const pageHeaders = Object.fromEntries(
  JSON.parse(readFileSync(new URL('../../vercel.json', import.meta.url), 'utf8')).headers
    .find(route => route.source === '/(.*)').headers.map(({ key, value }) => [key.toLowerCase(), value]),
);
const goodCapabilities = {
  ok: true, capabilities: { ...DEFAULT_EXPECTED_CAPABILITIES }, registrationMode: 'verified_invite',
};

const respond = (status, headers, body = '') => new Response(body, { status, headers: { ...pageHeaders, ...headers } });
const apiHeaders = { 'content-type': 'application/json', 'cache-control': 'no-store' };
const api = (body, status = 200, headers = {}) => respond(status, { ...apiHeaders, ...headers }, JSON.stringify(body));

function fakeOrigin(overrides = {}) {
  let calls = 0;
  const fetchImpl = async url => {
    calls += 1;
    const { pathname } = new URL(url);
    if (overrides[pathname]) return overrides[pathname]();
    if (pathname === '/index.html') return respond(308, { location: '/' });
    if (pathname === '/api/health/live') return api({ ok: true, status: 'live' });
    if (pathname === '/api/health/ready') return api({ ok: true, status: 'ready' });
    if (pathname === '/api/auth/capabilities') return api(goodCapabilities);
    if (pathname === '/assets/calendar-export.js') return respond(200, { 'content-type': 'text/javascript' }, 'export {};');
    if (publicPages[pathname]) return respond(200, { 'content-type': 'text/html' }, publicPages[pathname]);
    return respond(200, { 'content-type': 'text/html' }, shell);
  };
  return { fetchImpl, calls: () => calls };
}

const problemsFor = (summary, path) => summary.results.find(result => result.path === path).problems;

test('base URLs must be bare HTTPS origins, with plain HTTP only for loopback hosts', () => {
  assert.equal(parseBaseUrl('http://localhost:3000'), 'http://localhost:3000');
  assert.equal(parseBaseUrl('http://127.0.0.1:8080/'), 'http://127.0.0.1:8080');
  assert.equal(parseBaseUrl('https://example.test/'), 'https://example.test');
  assert.throws(() => parseBaseUrl('ftp://localhost'), /must use https/);
  assert.throws(() => parseBaseUrl('https://example.test/?token=secret'), /bare origin/);
  assert.throws(() => parseBaseUrl('https://example.test/#frag'), /bare origin/);
  assert.throws(() => parseBaseUrl(undefined), SmokeConfigurationError);
});

test('expected capability overrides accept objects and scalars and reject structured values', () => {
  assert.deepEqual(resolveExpectedCapabilities(''), DEFAULT_EXPECTED_CAPABILITIES);
  assert.deepEqual(resolveExpectedCapabilities(null), DEFAULT_EXPECTED_CAPABILITIES);
  const merged = resolveExpectedCapabilities({ passwordSignup: null, recentAuthMaxAgeSeconds: 600, tier: 'beta' });
  assert.equal('passwordSignup' in merged, false);
  assert.equal(merged.recentAuthMaxAgeSeconds, 600);
  assert.equal(merged.tier, 'beta');
  assert.throws(() => resolveExpectedCapabilities('{not json'), /must be a JSON object/);
  assert.throws(() => resolveExpectedCapabilities('null'), /must be a JSON object/);
  assert.throws(() => resolveExpectedCapabilities({ googleOAuth: { enabled: true } }),
    /expected capability googleOAuth must be a scalar or null/);
});

test('one transient network failure is retried before a check is failed', async () => {
  let flaky = 0;
  const { fetchImpl } = fakeOrigin({
    '/api/health/live': () => {
      flaky += 1;
      if (flaky === 1) throw new TypeError('socket hang up');
      return api({ ok: true, status: 'live' });
    },
  });
  const summary = await runProductionSmoke({ baseUrl: ORIGIN, fetchImpl });
  assert.equal(summary.ok, true);
  assert.equal(flaky, 2);
});

test('request timeouts are reported as a timeout category rather than raw errors', async () => {
  const timeout = () => { const error = new Error('aborted https://smoke.example.test/secret'); error.name = 'TimeoutError'; throw error; };
  const { fetchImpl } = fakeOrigin({ '/api/health/ready': timeout });
  const summary = await runProductionSmoke({ baseUrl: ORIGIN, fetchImpl });
  assert.deepEqual(problemsFor(summary, '/api/health/ready'), ['timeout']);
  assert.equal(summary.results.find(result => result.path === '/api/health/ready').status, null);
});

test('API checks flag content type, caching, nosniff, and body drift', async () => {
  const { fetchImpl } = fakeOrigin({
    '/api/health/live': () => respond(200, { 'content-type': 'text/plain', 'x-content-type-options': '' }, 'ok'),
    '/api/health/ready': () => api({ ok: true, status: 'live' }),
  });
  const summary = await runProductionSmoke({ baseUrl: ORIGIN, fetchImpl });
  assert.deepEqual(problemsFor(summary, '/api/health/live'), [
    'not application/json', 'cache-control is not no-store', 'missing nosniff',
    'body is not {"ok":true,"status":"live"}',
  ]);
  assert.deepEqual(problemsFor(summary, '/api/health/ready'), ['body is not {"ok":true,"status":"ready"}']);
});

test('capability checks fail closed on a malformed body and on registration-mode drift', async () => {
  const broken = fakeOrigin({ '/api/auth/capabilities': () => api({ ok: true, capabilities: null }, 500) });
  assert.deepEqual(problemsFor(await runProductionSmoke({ baseUrl: ORIGIN, fetchImpl: broken.fetchImpl }),
    '/api/auth/capabilities'), ['status 500', 'body is not an ok capabilities object']);

  const open = fakeOrigin({ '/api/auth/capabilities': () => api({ ...goodCapabilities, registrationMode: 'open' }) });
  assert.deepEqual(problemsFor(await runProductionSmoke({ baseUrl: ORIGIN, fetchImpl: open.fetchImpl }),
    '/api/auth/capabilities'), ['registrationMode is "open", expected "verified_invite"']);
  const relaxed = await runProductionSmoke({ baseUrl: ORIGIN, fetchImpl: open.fetchImpl, registrationMode: 'any' });
  assert.equal(relaxed.ok, true);
});

test('the /index.html redirect must stay on the origin root', async () => {
  for (const [location, status] of [[null, 308], ['http://[broken', 308], ['https://evil.example/', 301], ['/other', 302]]) {
    const headers = location ? { location } : {};
    const { fetchImpl } = fakeOrigin({ '/index.html': () => respond(status, headers) });
    const summary = await runProductionSmoke({ baseUrl: ORIGIN, fetchImpl });
    assert.deepEqual(problemsFor(summary, '/index.html'), ['does not redirect to /'], String(location));
  }
});

test('the static asset must be served with status 200 and nosniff', async () => {
  const { fetchImpl } = fakeOrigin({
    '/assets/calendar-export.js': () => respond(404, { 'content-type': 'application/javascript', 'x-content-type-options': '' }, 'x'),
  });
  const summary = await runProductionSmoke({ baseUrl: ORIGIN, fetchImpl });
  assert.deepEqual(problemsFor(summary, '/assets/calendar-export.js'), ['status 404', 'missing nosniff']);
});

function capture() {
  const lines = [];
  return { lines, log: line => lines.push(line), error: line => lines.push(line) };
}

test('the CLI validates timeout and flag configuration with exit code 2', async () => {
  for (const timeout of ['500', '60001', '1500.5', 'abc']) {
    const out = capture();
    assert.equal(await main({ argv: [], env: { SMOKE_TIMEOUT_MS: timeout }, fetchImpl: fakeOrigin().fetchImpl, ...out }), 2);
    assert.deepEqual(out.lines, ['production smoke: invalid configuration: SMOKE_TIMEOUT_MS must be an integer between 1000 and 60000']);
  }
  for (const argv of [['--base-url'], ['--base-url', '--expect-capabilities'], ['--expect-registration-mode']]) {
    const out = capture();
    assert.equal(await main({ argv, env: {}, fetchImpl: fakeOrigin().fetchImpl, ...out }), 2);
    assert.match(out.lines[0], /requires a value$/);
  }
  await assert.rejects(main({ argv: null, env: {}, ...capture() }), TypeError);
});

test('CLI flags override environment configuration and failures print their problems', async () => {
  const origin = fakeOrigin({
    '/api/auth/capabilities': () => api({ ...goodCapabilities, registrationMode: 'open', capabilities: { googleOAuth: true } }),
    '/api/health/live': () => { throw new TypeError('offline'); },
  });
  const out = capture();
  const code = await main({
    argv: ['--base-url', ORIGIN, '--expect-capabilities', '{"googleOAuth":true,"passwordLogin":null,"passwordSignup":null,"verifiedEmailActivation":null,"passwordReset":null,"identityManagement":null}', '--expect-registration-mode', 'open'],
    env: { SMOKE_BASE_URL: 'https://ignored.example', SMOKE_EXPECTED_CAPABILITIES: '[]', SMOKE_TIMEOUT_MS: '2000' },
    fetchImpl: origin.fetchImpl,
    ...out,
  });
  assert.equal(code, 1);
  assert.equal(out.lines[0], `production smoke: ${ORIGIN}`);
  assert.ok(out.lines.includes('  ok   auth capabilities (200)'));
  assert.ok(out.lines.includes('  FAIL health live (no response): network_error'));
  assert.equal(out.lines.at(-1), 'production smoke: FAILED 12/13 checks passed');
});

test('the script entrypoint exits 2 on invalid configuration without any network access', () => {
  const result = spawnSync(process.execPath, ['scripts/production-smoke.mjs', '--base-url', 'http://example.com'], {
    cwd: ROOT, encoding: 'utf8', env: { ...process.env, SMOKE_TIMEOUT_MS: '' },
  });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /invalid configuration: base URL must use https/);
});
