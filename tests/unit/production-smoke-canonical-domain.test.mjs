// ID-80: the production smoke check's canonical-domain checks, and how it
// behaves on either side of the APP_URL switch. A fake fetch plays all three
// hosts of one deployment: the canonical apex, www and the old Vercel alias.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { CANONICAL_ORIGIN, LEGACY_ORIGIN, WWW_ORIGIN } from '../../scripts/canonical-domain.mjs';
import {
  DEFAULT_BASE_URL,
  DEFAULT_EXPECTED_CAPABILITIES,
  DOMAIN_REDIRECT_PROBE,
  STATIC_ASSET,
  SWITCH_MISMATCH,
  main,
  resolveExpectedCapabilities,
  runProductionSmoke,
} from '../../scripts/production-smoke.mjs';

const shell = readFileSync('index.html', 'utf8');
const pageHeaders = Object.fromEntries(
  JSON.parse(readFileSync('vercel.json', 'utf8')).headers
    .find(route => route.source === '/(.*)').headers.map(({ key, value }) => [key.toLowerCase(), value]),
);
const respond = (status, headers, body = '') => new Response(body, { status, headers: { ...pageHeaders, ...headers } });
const api = body => respond(200, { 'content-type': 'application/json', 'cache-control': 'no-store' }, JSON.stringify(body));
const redirect = (status, location) => () => new Response('', { status, headers: { location } });

// `appUrl` is the host Google sign-in is advertised on (the APP_URL host), or
// null. `redirects` says whether the vercel.json host redirects are deployed.
// `overrides` replace responses by full URL.
function fakeHosts({ appUrl = CANONICAL_ORIGIN, redirects = true, overrides = {} } = {}) {
  const requests = [];
  const fetchImpl = async (url, init) => {
    requests.push({ url, init });
    if (overrides[url]) return overrides[url]();
    const { origin, pathname, search } = new URL(url);
    if (pathname === '/index.html') return respond(308, { location: `/${search}` });
    if (redirects && origin === WWW_ORIGIN) return redirect(308, `${CANONICAL_ORIGIN}${pathname}${search}`)();
    if (redirects && origin === LEGACY_ORIGIN && !/^\/api(?:\/|$)/u.test(pathname)) {
      return redirect(307, `${CANONICAL_ORIGIN}${pathname}${search}`)();
    }
    if (pathname === '/api/health/live') return api({ ok: true, status: 'live' });
    if (pathname === '/api/health/ready') return api({ ok: true, status: 'ready' });
    if (pathname === '/api/auth/capabilities') {
      return api({ ok: true, registrationMode: 'verified_invite',
        capabilities: { ...DEFAULT_EXPECTED_CAPABILITIES, googleOAuth: origin === appUrl } });
    }
    if (pathname === STATIC_ASSET) return respond(200, { 'content-type': 'text/javascript' }, 'export {};');
    return respond(200, { 'content-type': 'text/html' }, shell);
  };
  return { fetchImpl, requests };
}

const byName = (summary, name) => summary.results.find(result => result.name === name);
const failures = summary => Object.fromEntries(summary.results.filter(result => !result.ok)
  .map(result => [result.name, result.problems]));
const DOMAIN_CHECKS = ['legacy host page redirect', 'legacy host API alias', 'www redirect'];

test('the default base URL is the canonical origin', () => {
  assert.equal(DEFAULT_BASE_URL, CANONICAL_ORIGIN);
  assert.equal(DOMAIN_REDIRECT_PROBE, '/invite?smoke=canonical-domain');
});

test('after the switch the canonical origin passes, including the old-alias and www redirects', async () => {
  const { fetchImpl, requests } = fakeHosts();
  const summary = await runProductionSmoke({ fetchImpl });
  assert.equal(summary.ok, true, JSON.stringify(failures(summary)));
  assert.equal(summary.origin, CANONICAL_ORIGIN);
  assert.deepEqual(summary.skipped, []);
  assert.deepEqual(summary.results.slice(-3).map(result => [result.name, result.path, result.status]), [
    ['legacy host page redirect', `${LEGACY_ORIGIN}${DOMAIN_REDIRECT_PROBE}`, 307],
    ['legacy host API alias', `${LEGACY_ORIGIN}/api/health/live`, 200],
    ['www redirect', `${WWW_ORIGIN}${DOMAIN_REDIRECT_PROBE}`, 308],
  ]);
  assert.equal(byName(summary, 'auth capabilities').note, undefined);
  for (const { init } of requests) {
    assert.equal(init.method, 'GET');
    assert.equal(init.redirect, 'manual');
    assert.equal(init.credentials, 'omit');
  }
  // The only extra requests are the read-only capability probe and the three domain checks.
  assert.deepEqual(requests.map(({ url }) => url).filter(url => !url.startsWith(`${CANONICAL_ORIGIN}/`)), [
    `${LEGACY_ORIGIN}${DOMAIN_REDIRECT_PROBE}`, `${LEGACY_ORIGIN}/api/health/live`, `${WWW_ORIGIN}${DOMAIN_REDIRECT_PROBE}`,
  ]);
});

test('the redirects must exist, keep path and query, use the right status, and leave /api alone', async () => {
  const legacyPage = `${LEGACY_ORIGIN}${DOMAIN_REDIRECT_PROBE}`;
  const wwwPage = `${WWW_ORIGIN}${DOMAIN_REDIRECT_PROBE}`;
  const expected = `${CANONICAL_ORIGIN}${DOMAIN_REDIRECT_PROBE}`;
  const missing = `does not redirect to ${expected}`;
  const cases = [
    // Redirects not deployed (e.g. an older deployment is serving).
    [{ redirects: false }, {
      'legacy host page redirect': ['status 200, expected a temporary redirect', missing],
      'www redirect': ['status 200, expected a permanent redirect', missing],
    }],
    [{ overrides: { [legacyPage]: redirect(308, expected) } },
      { 'legacy host page redirect': ['status 308, expected a temporary redirect'] }],
    [{ overrides: { [legacyPage]: redirect(307, `${CANONICAL_ORIGIN}/invite`) } },
      { 'legacy host page redirect': [missing] }],
    [{ overrides: { [legacyPage]: redirect(302, `${LEGACY_ORIGIN}${DOMAIN_REDIRECT_PROBE}`) } },
      { 'legacy host page redirect': [missing] }],
    [{ overrides: { [legacyPage]: redirect(307, DOMAIN_REDIRECT_PROBE) } },
      { 'legacy host page redirect': [missing] }],
    [{ overrides: { [`${LEGACY_ORIGIN}/api/health/live`]: redirect(307, `${CANONICAL_ORIGIN}/api/health/live`) } },
      { 'legacy host API alias': ['status 307', 'not application/json', 'cache-control is not no-store',
        'missing nosniff', 'body is not {"ok":true,"status":"live"}'] }],
    [{ overrides: { [wwwPage]: redirect(307, expected) } },
      { 'www redirect': ['status 307, expected a permanent redirect'] }],
    [{ overrides: { [wwwPage]: redirect(301, `${CANONICAL_ORIGIN}/`) } }, { 'www redirect': [missing] }],
    [{ overrides: { [wwwPage]: () => { throw new TypeError('getaddrinfo ENOTFOUND'); } } },
      { 'www redirect': ['network_error'] }],
  ];
  for (const [options, expectedFailures] of cases) {
    const summary = await runProductionSmoke({ baseUrl: CANONICAL_ORIGIN, fetchImpl: fakeHosts(options).fetchImpl });
    assert.deepEqual(failures(summary), expectedFailures, JSON.stringify(options));
  }
  const offline = await runProductionSmoke({ baseUrl: CANONICAL_ORIGIN,
    fetchImpl: fakeHosts({ overrides: { [wwwPage]: () => { throw new TypeError('offline'); } } }).fetchImpl });
  assert.equal(byName(offline, 'www redirect').path, wwwPage);
  assert.equal(byName(offline, 'www redirect').status, null);
});

const GUARD = 'legacy host serves pages while APP_URL names it';

test('while APP_URL still names the old alias and its pages are still served, the domain checks are skipped with the reason', async () => {
  const summary = await runProductionSmoke({ baseUrl: CANONICAL_ORIGIN,
    fetchImpl: fakeHosts({ appUrl: LEGACY_ORIGIN, redirects: false }).fetchImpl });
  assert.equal(summary.ok, true, JSON.stringify(failures(summary)));
  assert.equal(summary.results.some(result => DOMAIN_CHECKS.includes(result.name)), false);
  assert.deepEqual([byName(summary, GUARD).path, byName(summary, GUARD).status],
    [`${LEGACY_ORIGIN}${DOMAIN_REDIRECT_PROBE}`, 200]);
  assert.deepEqual(summary.skipped, [{ name: 'canonical-domain checks',
    reason: `APP_URL still names ${LEGACY_ORIGIN} (Google sign-in is advertised there); `
      + `they run once APP_URL is ${CANONICAL_ORIGIN}` }]);
  // Google sign-in is checked where APP_URL points, not on the canonical host.
  assert.equal(byName(summary, 'auth capabilities').note,
    `googleOAuth is advertised on ${LEGACY_ORIGIN}, the APP_URL host, so it is not expected here`);
  // An explicit googleOAuth expectation other than true is left as configured.
  const overridden = await runProductionSmoke({ baseUrl: CANONICAL_ORIGIN,
    fetchImpl: fakeHosts({ appUrl: LEGACY_ORIGIN, redirects: false }).fetchImpl,
    expectedCapabilities: resolveExpectedCapabilities('{"googleOAuth":false}') });
  assert.equal(overridden.ok, true);
  assert.equal(byName(overridden, 'auth capabilities').note, undefined);
});

test('redirects live while APP_URL still names the old alias fails: Google sign-in is unreachable', async () => {
  // Merged before the switch, or APP_URL drifted back during a rollback.
  for (const baseUrl of [CANONICAL_ORIGIN, LEGACY_ORIGIN]) {
    const summary = await runProductionSmoke({ baseUrl, fetchImpl: fakeHosts({ appUrl: LEGACY_ORIGIN }).fetchImpl });
    assert.deepEqual(failures(summary), { [GUARD]: [SWITCH_MISMATCH] }, baseUrl);
    assert.equal(byName(summary, GUARD).status, 307);
  }
  assert.equal(SWITCH_MISMATCH, 'APP_URL names the old alias but its pages redirect away; Google sign-in is unreachable');
  // Anything else from the old host's page is not "still serving pages" either.
  const probe = `${LEGACY_ORIGIN}${DOMAIN_REDIRECT_PROBE}`;
  for (const [response, problems] of [
    [() => respond(404, { 'content-type': 'text/plain' }, 'not found'), ['status 404']],
    [redirect(307, `${CANONICAL_ORIGIN}/`), ['status 307']],
    [() => { throw new TypeError('offline'); }, ['network_error']],
  ]) {
    const summary = await runProductionSmoke({ baseUrl: CANONICAL_ORIGIN,
      fetchImpl: fakeHosts({ appUrl: LEGACY_ORIGIN, redirects: false, overrides: { [probe]: response } }).fetchImpl });
    assert.deepEqual(failures(summary), { [GUARD]: problems });
  }
});

test('when neither host advertises Google sign-in the domain checks run and the gap is reported', async () => {
  const summary = await runProductionSmoke({ baseUrl: CANONICAL_ORIGIN, fetchImpl: fakeHosts({ appUrl: null }).fetchImpl });
  assert.deepEqual(failures(summary), { 'auth capabilities': ['capability googleOAuth is false, expected true'] });
  assert.deepEqual(summary.results.slice(-3).map(result => result.name), DOMAIN_CHECKS);
  assert.deepEqual(summary.skipped, []);
});

test('a failed capability probe counts as unknown and the base check reports the failure', async () => {
  const summary = await runProductionSmoke({ baseUrl: CANONICAL_ORIGIN, fetchImpl: fakeHosts({ overrides: {
    [`${CANONICAL_ORIGIN}/api/auth/capabilities`]: () => { throw new TypeError('socket hang up'); },
  } }).fetchImpl });
  assert.deepEqual(failures(summary), { 'auth capabilities': ['network_error'] });
  assert.deepEqual(summary.results.slice(-3).map(result => result.name), DOMAIN_CHECKS);
});

test('a legacy base URL passes before the redirects deploy and after, by following the canonical redirect', async () => {
  const before = await runProductionSmoke({ baseUrl: LEGACY_ORIGIN,
    fetchImpl: fakeHosts({ appUrl: LEGACY_ORIGIN, redirects: false }).fetchImpl });
  assert.equal(before.ok, true, JSON.stringify(failures(before)));
  assert.equal(before.results.some(result => result.note), false);
  assert.deepEqual(before.skipped, [{ name: 'canonical-domain checks',
    reason: `the base URL is the legacy alias; they run against ${CANONICAL_ORIGIN}` }]);

  const { fetchImpl, requests } = fakeHosts({ appUrl: CANONICAL_ORIGIN, redirects: true });
  const after = await runProductionSmoke({ baseUrl: LEGACY_ORIGIN, fetchImpl });
  assert.equal(after.ok, true, JSON.stringify(failures(after)));
  assert.equal(byName(after, 'app route /invite').note, `followed the canonical redirect to ${CANONICAL_ORIGIN}/invite`);
  assert.equal(byName(after, `static asset ${STATIC_ASSET}`).note,
    `followed the canonical redirect to ${CANONICAL_ORIGIN}${STATIC_ASSET}`);
  // cleanUrls answers /index.html on the old alias itself; API probes are never redirected.
  assert.equal(byName(after, 'index.html redirect').note, undefined);
  assert.equal(byName(after, 'health ready').note, undefined);
  assert.equal(byName(after, 'auth capabilities').note,
    `googleOAuth is advertised on ${CANONICAL_ORIGIN}, the APP_URL host, so it is not expected here`);
  assert.ok(requests.some(({ url }) => url === `${CANONICAL_ORIGIN}/join/week_1_pair_1`));
});

test('on a legacy base an API redirect or a permanent page redirect is never followed', async () => {
  const summary = await runProductionSmoke({ baseUrl: LEGACY_ORIGIN, fetchImpl: fakeHosts({ overrides: {
    [`${LEGACY_ORIGIN}/api/health/live`]: redirect(307, `${CANONICAL_ORIGIN}/api/health/live`),
    [`${LEGACY_ORIGIN}/verify`]: redirect(308, `${CANONICAL_ORIGIN}/verify`),
    [`${LEGACY_ORIGIN}/invite`]: redirect(307, `${CANONICAL_ORIGIN}/elsewhere`),
  } }).fetchImpl });
  const failed = failures(summary);
  assert.deepEqual(Object.keys(failed), ['app route /invite', 'app route /verify', 'health live']);
  assert.ok(failed['app route /verify'].includes('status 308'));
  assert.ok(failed['app route /invite'].includes('status 307'));
  assert.ok(failed['health live'].includes('status 307'));
});

test('the CLI prints notes and skip reasons, and fails only once the old alias redirects while APP_URL names it', async () => {
  const lines = [];
  const capture = { log: line => lines.push(line), error: line => lines.push(line) };
  const code = await main({ argv: [], env: {},
    fetchImpl: fakeHosts({ appUrl: LEGACY_ORIGIN, redirects: false }).fetchImpl, ...capture });
  assert.equal(code, 0);
  assert.equal(lines[0], `production smoke: ${CANONICAL_ORIGIN}`);
  assert.ok(lines.includes(`  ok   auth capabilities (200) [googleOAuth is advertised on ${LEGACY_ORIGIN}, `
    + 'the APP_URL host, so it is not expected here]'));
  assert.ok(lines.includes(`  skip canonical-domain checks: APP_URL still names ${LEGACY_ORIGIN} `
    + `(Google sign-in is advertised there); they run once APP_URL is ${CANONICAL_ORIGIN}`));
  assert.ok(lines.includes(`  ok   ${GUARD} (200)`));
  assert.equal(lines.at(-1), 'production smoke: OK 12/12 checks passed');

  lines.length = 0;
  assert.equal(await main({ argv: [], env: {}, fetchImpl: fakeHosts({ appUrl: LEGACY_ORIGIN }).fetchImpl, ...capture }), 1);
  assert.ok(lines.includes(`  FAIL ${GUARD} (307): ${SWITCH_MISMATCH}`));
  assert.equal(lines.at(-1), 'production smoke: FAILED 11/12 checks passed');

  lines.length = 0;
  assert.equal(await main({ argv: ['--base-url', 'https://preview.example.test'], env: {},
    fetchImpl: fakeHosts({ appUrl: 'https://preview.example.test' }).fetchImpl, ...capture }), 0);
  assert.ok(lines.includes(`  skip canonical-domain checks: the base URL is not the canonical origin ${CANONICAL_ORIGIN}`));

  lines.length = 0;
  assert.equal(await main({ argv: [], env: {}, fetchImpl: fakeHosts({ redirects: false }).fetchImpl, ...capture }), 1);
  assert.ok(lines.includes(`  FAIL www redirect (200): status 200, expected a permanent redirect; `
    + `does not redirect to ${CANONICAL_ORIGIN}${DOMAIN_REDIRECT_PROBE}`));
  assert.equal(lines.at(-1), 'production smoke: FAILED 12/14 checks passed');
});
