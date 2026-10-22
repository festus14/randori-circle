import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import {
  DEFAULT_EXPECTED_CAPABILITIES,
  main,
  resolveExpectedCapabilities,
  runProductionSmoke,
} from '../../scripts/production-smoke.mjs';
import { PUBLIC_PAGES } from '../../scripts/public-pages.mjs';

const ORIGIN = 'https://smoke.example.test';
const shell = readFileSync('index.html', 'utf8');
const publicPages = Object.fromEntries(Object.entries(PUBLIC_PAGES)
  .map(([path, file]) => [path, readFileSync(file, 'utf8')]));
const pageHeaders = Object.fromEntries(
  JSON.parse(readFileSync('vercel.json', 'utf8')).headers
    .find(route => route.source === '/(.*)').headers.map(({ key, value }) => [key.toLowerCase(), value]),
);
const capabilities = {
  ok: true,
  capabilities: { ...DEFAULT_EXPECTED_CAPABILITIES, localIdentity: false, recentAuthMaxAgeSeconds: 600 },
  registrationMode: 'verified_invite',
};

function respond(status, headers, body = '') {
  return new Response(body, { status, headers: { ...pageHeaders, ...headers } });
}

const api = body => respond(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  JSON.stringify(body));

// Emulates the deployed origin. `overrides` replace individual paths.
function fakeProduction(overrides = {}) {
  const requests = [];
  const fetchImpl = async (url, init) => {
    requests.push({ url, init });
    const { pathname } = new URL(url);
    if (overrides[pathname]) return overrides[pathname]();
    if (pathname === '/index.html') return respond(308, { location: '/' });
    if (pathname === '/api/health/live') return api({ ok: true, status: 'live' });
    if (pathname === '/api/health/ready') return api({ ok: true, status: 'ready' });
    if (pathname === '/api/auth/capabilities') return api(capabilities);
    if (pathname === '/assets/calendar-export.js') {
      return respond(200, { 'content-type': 'application/javascript; charset=utf-8' }, 'export {};');
    }
    if (publicPages[pathname]) return respond(200, { 'content-type': 'text/html; charset=utf-8' }, publicPages[pathname]);
    return respond(200, { 'content-type': 'text/html; charset=utf-8' }, shell);
  };
  return { fetchImpl, requests };
}

const notFound = () => respond(404, { 'content-type': 'text/plain' }, 'The page could not be found');

test('a healthy deployment passes every check using anonymous GET requests only', async () => {
  const { fetchImpl, requests } = fakeProduction();
  const summary = await runProductionSmoke({ baseUrl: ORIGIN, fetchImpl });
  assert.equal(summary.ok, true, JSON.stringify(summary.results.filter(result => !result.ok)));
  assert.equal(summary.results.length, 13);
  for (const { url, init } of requests) {
    assert.ok(url.startsWith(`${ORIGIN}/`));
    assert.equal(init.method, 'GET');
    assert.equal(init.redirect, 'manual');
    assert.equal(init.body, undefined);
    assert.equal(Object.keys(init.headers).some(key => /authorization|cookie/iu.test(key)), false);
  }
});

test('the cleanUrls fallback outage fails the client route checks', async () => {
  const { fetchImpl } = fakeProduction({
    '/invite': notFound, '/verify': notFound, '/reset-password': notFound,
    '/join/week_1_pair_1': notFound, '/smoke-check/unknown-route': notFound,
  });
  const summary = await runProductionSmoke({ baseUrl: ORIGIN, fetchImpl });
  assert.equal(summary.ok, false);
  assert.deepEqual(summary.results.filter(result => !result.ok).map(result => result.path),
    ['/invite', '/verify', '/reset-password', '/join/week_1_pair_1', '/smoke-check/unknown-route']);
});

test('the privacy and terms pages must be their own documents, not the shell or a 404', async () => {
  const { fetchImpl } = fakeProduction({
    '/privacy': () => respond(200, { 'content-type': 'text/html; charset=utf-8' }, shell),
    '/terms': notFound,
  });
  const summary = await runProductionSmoke({ baseUrl: ORIGIN, fetchImpl });
  const failed = Object.fromEntries(summary.results.filter(result => !result.ok)
    .map(result => [result.path, result.problems]));
  assert.deepEqual(failed, {
    '/privacy': ['missing public page marker data-public-page="privacy"',
      'served the app shell instead of the public page'],
    '/terms': ['status 404', 'not text/html', 'missing public page marker data-public-page="terms"'],
  });
  assert.equal(summary.results.find(result => result.path === '/privacy').name, 'public page /privacy');
});

test('a public page without the page security headers fails', async () => {
  const { fetchImpl } = fakeProduction({
    '/terms': () => new Response(publicPages['/terms'], { status: 200, headers: { 'content-type': 'text/html' } }),
  });
  const summary = await runProductionSmoke({ baseUrl: ORIGIN, fetchImpl });
  const problems = summary.results.find(result => result.path === '/terms').problems;
  assert.ok(problems.includes('unsafe or missing content-security-policy'));
  assert.ok(problems.includes('unsafe or missing x-frame-options'));
});

test('missing security headers, a served /index.html, and HTML in place of assets fail', async () => {
  const { fetchImpl } = fakeProduction({
    '/': () => new Response(shell, { status: 200, headers: { 'content-type': 'text/html' } }),
    '/index.html': () => respond(200, { 'content-type': 'text/html' }, shell),
    '/assets/calendar-export.js': () => respond(200, { 'content-type': 'text/html' }, shell),
  });
  const summary = await runProductionSmoke({ baseUrl: ORIGIN, fetchImpl });
  const failed = Object.fromEntries(summary.results.filter(result => !result.ok)
    .map(result => [result.path, result.problems]));
  assert.deepEqual(Object.keys(failed), ['/', '/index.html', '/assets/calendar-export.js']);
  assert.ok(failed['/'].includes('unsafe or missing content-security-policy'));
  assert.ok(failed['/index.html'].includes('does not redirect to /'));
  assert.ok(failed['/assets/calendar-export.js'].includes('not JavaScript'));
});

test('capability drift fails unless the expectation is overridden', async () => {
  const drifted = { ...capabilities, capabilities: { ...capabilities.capabilities, googleOAuth: false } };
  const { fetchImpl } = fakeProduction({ '/api/auth/capabilities': () => api(drifted) });

  const strict = await runProductionSmoke({ baseUrl: ORIGIN, fetchImpl });
  assert.deepEqual(strict.results.find(result => result.path === '/api/auth/capabilities').problems,
    ['capability googleOAuth is false, expected true']);

  for (const override of ['{"googleOAuth":false}', '{"googleOAuth":null}']) {
    const relaxed = await runProductionSmoke({ baseUrl: ORIGIN, fetchImpl,
      expectedCapabilities: resolveExpectedCapabilities(override) });
    assert.equal(relaxed.ok, true);
  }
});

test('unhealthy probes and network failures are reported as bounded categories', async () => {
  const { fetchImpl } = fakeProduction({
    '/api/health/ready': () => respond(503, { 'content-type': 'application/json', 'cache-control': 'no-store' },
      JSON.stringify({ ok: false, status: 'not_ready' })),
    '/api/health/live': () => { throw new TypeError('fetch failed'); },
  });
  const summary = await runProductionSmoke({ baseUrl: ORIGIN, fetchImpl });
  assert.deepEqual(summary.results.find(result => result.path === '/api/health/live').problems, ['network_error']);
  assert.ok(summary.results.find(result => result.path === '/api/health/ready').problems.includes('status 503'));
});

test('the CLI rejects unsafe configuration and exits non-zero on failure', async () => {
  const lines = [];
  const capture = { log: line => lines.push(line), error: line => lines.push(line) };
  for (const baseUrl of ['http://example.com', 'https://user:pw@example.com', 'https://example.com/path', 'nope']) {
    assert.equal(await main({ argv: ['--base-url', baseUrl], env: {}, fetchImpl: fakeProduction().fetchImpl,
      ...capture }), 2);
  }
  assert.equal(await main({ argv: [], env: { SMOKE_EXPECTED_CAPABILITIES: '[1]' },
    fetchImpl: fakeProduction().fetchImpl, ...capture }), 2);

  assert.equal(await main({ argv: ['--base-url', ORIGIN], env: {}, fetchImpl: fakeProduction().fetchImpl,
    ...capture }), 0);
  assert.equal(await main({ argv: [], env: { SMOKE_BASE_URL: ORIGIN },
    fetchImpl: fakeProduction({ '/verify': notFound }).fetchImpl, ...capture }), 1);
  assert.ok(lines.some(line => /FAIL app route \/verify \(404\): status 404/u.test(line)));
});
