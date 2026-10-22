#!/usr/bin/env node
// Read-only post-deploy smoke check for a deployed Randori Circle origin.
//
// It issues anonymous GET requests only: no credentials, no cookies, no
// writes. It asserts the routing contract that CI cannot see (Vercel's
// cleanUrls + SPA fallback), the health probes, the public auth capability
// surface, a static asset, and the security headers from check-deployability.
//
// Against the canonical origin it also checks the canonical-domain redirects
// (ID-80): the old Vercel alias sends page paths to the canonical host with
// their path and query but still serves /api/*, and www redirects to the apex.
// Google sign-in is advertised only on the host APP_URL names, so googleOAuth
// is expected only there, and while APP_URL still names the old alias those
// checks are skipped with the reason printed. A run therefore never fails just
// because the APP_URL switch and the merge happen in either order.
//
// Usage:
//   npm run smoke:production
//   npm run smoke:production -- --base-url https://preview.example.vercel.app
//
// Configuration (flags win over environment):
//   --base-url / SMOKE_BASE_URL                        default canonical origin
//   --expect-capabilities / SMOKE_EXPECTED_CAPABILITIES
//       JSON object merged over the MVP defaults. Set a key to null to stop
//       asserting it, e.g. '{"googleOAuth":null}' or '{"googleOAuth":false}'.
//   --expect-registration-mode / SMOKE_EXPECTED_REGISTRATION_MODE
//       default verified_invite; "any" disables the assertion.
//   SMOKE_TIMEOUT_MS                                   per-request timeout (15000)
//
// Behind an HTTP proxy run with NODE_USE_ENV_PROXY=1 so fetch honours it.
// Exit codes: 0 all checks passed, 1 a check failed, 2 invalid configuration.
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { REQUIRED_SECURITY_HEADERS, securityHeaderIsSafe } from './check-deployability.mjs';
import { CANONICAL_ORIGIN, LEGACY_ORIGIN, WWW_ORIGIN } from './canonical-domain.mjs';

export const DEFAULT_BASE_URL = CANONICAL_ORIGIN;
export const DEFAULT_EXPECTED_CAPABILITIES = Object.freeze({
  passwordLogin: true,
  passwordSignup: true,
  verifiedEmailActivation: true,
  passwordReset: true,
  googleOAuth: true,
  identityManagement: true,
});
export const DEFAULT_REGISTRATION_MODE = 'verified_invite';
// Every client route the app links to (emails, navigation) plus an unknown
// path that must still reach the SPA shell through the vercel.json fallback.
export const APP_ROUTES = Object.freeze([
  '/',
  '/invite',
  '/verify',
  '/reset-password',
  '/join/week_1_pair_1',
  '/smoke-check/unknown-route',
]);
export const STATIC_ASSET = '/assets/calendar-export.js';
const SHELL_MARKERS = ['<title>Randori Circle</title>', 'id="appMain"'];
const REDIRECT_STATUSES = new Set([301, 302, 307, 308]);
const TEMPORARY_REDIRECT_STATUSES = new Set([302, 307]);
const PERMANENT_REDIRECT_STATUSES = new Set([301, 308]);
// A page path with a query: the host redirects must keep both.
export const DOMAIN_REDIRECT_PROBE = '/invite?smoke=canonical-domain';

export class SmokeConfigurationError extends Error {}

export function parseBaseUrl(value) {
  let url;
  try { url = new URL(String(value)); } catch { throw new SmokeConfigurationError('base URL must be an absolute URL'); }
  const local = url.hostname === 'localhost' || url.hostname === '127.0.0.1';
  if (url.protocol !== 'https:' && !(local && url.protocol === 'http:')) {
    throw new SmokeConfigurationError('base URL must use https (http is allowed only for localhost)');
  }
  if (url.username || url.password || url.search || url.hash || (url.pathname && url.pathname !== '/')) {
    throw new SmokeConfigurationError('base URL must be a bare origin without credentials, path, query or fragment');
  }
  return url.origin;
}

export function resolveExpectedCapabilities(override) {
  const expected = { ...DEFAULT_EXPECTED_CAPABILITIES };
  if (override === undefined || override === null || override === '') return expected;
  let parsed;
  try { parsed = typeof override === 'string' ? JSON.parse(override) : override; }
  catch { throw new SmokeConfigurationError('expected capabilities must be a JSON object'); }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new SmokeConfigurationError('expected capabilities must be a JSON object');
  }
  for (const [key, value] of Object.entries(parsed)) {
    if (value === null) delete expected[key];
    else if (typeof value === 'boolean' || typeof value === 'number' || typeof value === 'string') expected[key] = value;
    else throw new SmokeConfigurationError(`expected capability ${key} must be a scalar or null`);
  }
  return expected;
}

function securityHeaderFailures(headers) {
  return REQUIRED_SECURITY_HEADERS.filter(key => !securityHeaderIsSafe(key, headers.get(key) ?? ''));
}

async function request(fetchImpl, url, timeoutMs) {
  let lastError;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const response = await fetchImpl(url, {
        method: 'GET',
        redirect: 'manual',
        credentials: 'omit',
        headers: { accept: '*/*', 'user-agent': 'randori-production-smoke/1' },
        signal: AbortSignal.timeout(timeoutMs),
      });
      const body = await response.text();
      return { status: response.status, headers: response.headers, body };
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError;
}

function parseJson(body) {
  try { return JSON.parse(body); } catch { return null; }
}

function checkAppRoute(result) {
  const problems = [];
  if (result.status !== 200) problems.push(`status ${result.status}`);
  if (!/^text\/html\b/i.test(result.headers.get('content-type') || '')) problems.push('not text/html');
  for (const marker of SHELL_MARKERS) if (!result.body.includes(marker)) problems.push(`missing app shell marker ${marker}`);
  for (const key of securityHeaderFailures(result.headers)) problems.push(`unsafe or missing ${key}`);
  return problems;
}

function checkApiHeaders(result) {
  const problems = [];
  if (!/^application\/json\b/i.test(result.headers.get('content-type') || '')) problems.push('not application/json');
  if (result.headers.get('cache-control') !== 'no-store') problems.push('cache-control is not no-store');
  if ((result.headers.get('x-content-type-options') || '').toLowerCase() !== 'nosniff') problems.push('missing nosniff');
  return problems;
}

function checkHealth(probe) {
  return result => {
    const problems = [];
    if (result.status !== 200) problems.push(`status ${result.status}`);
    problems.push(...checkApiHeaders(result));
    const json = parseJson(result.body);
    if (json?.ok !== true || json?.status !== probe) problems.push(`body is not {"ok":true,"status":"${probe}"}`);
    return problems;
  };
}

function checkCapabilities(expected, registrationMode) {
  return result => {
    const problems = [];
    if (result.status !== 200) problems.push(`status ${result.status}`);
    problems.push(...checkApiHeaders(result));
    const json = parseJson(result.body);
    if (json?.ok !== true || !json.capabilities || typeof json.capabilities !== 'object') {
      problems.push('body is not an ok capabilities object');
      return problems;
    }
    for (const [key, value] of Object.entries(expected)) {
      if (json.capabilities[key] !== value) {
        problems.push(`capability ${key} is ${JSON.stringify(json.capabilities[key])}, expected ${JSON.stringify(value)}`);
      }
    }
    if (registrationMode !== 'any' && json.registrationMode !== registrationMode) {
      problems.push(`registrationMode is ${JSON.stringify(json.registrationMode)}, expected ${JSON.stringify(registrationMode)}`);
    }
    return problems;
  };
}

function checkIndexRedirect(origin) {
  return result => {
    const problems = [];
    if (!REDIRECT_STATUSES.has(result.status)) problems.push(`status ${result.status}, expected a redirect`);
    const location = result.headers.get('location');
    let target = null;
    try { target = location ? new URL(location, origin) : null; } catch { target = null; }
    if (!target || target.origin !== origin || target.pathname !== '/') problems.push('does not redirect to /');
    return problems;
  };
}

function checkStaticAsset(result) {
  const problems = [];
  if (result.status !== 200) problems.push(`status ${result.status}`);
  if (!/^(?:application|text)\/javascript\b/i.test(result.headers.get('content-type') || '')) problems.push('not JavaScript');
  if (/<html/i.test(result.body.slice(0, 512))) problems.push('served HTML instead of the asset');
  if ((result.headers.get('x-content-type-options') || '').toLowerCase() !== 'nosniff') problems.push('missing nosniff');
  return problems;
}

export function smokeChecks(origin, { expectedCapabilities = DEFAULT_EXPECTED_CAPABILITIES,
  registrationMode = DEFAULT_REGISTRATION_MODE } = {}) {
  return [
    ...APP_ROUTES.map(path => ({ name: `app route ${path}`, path, check: checkAppRoute })),
    { name: 'index.html redirect', path: '/index.html', check: checkIndexRedirect(origin) },
    { name: 'health live', path: '/api/health/live', check: checkHealth('live') },
    { name: 'health ready', path: '/api/health/ready', check: checkHealth('ready') },
    { name: 'auth capabilities', path: '/api/auth/capabilities',
      check: checkCapabilities(expectedCapabilities, registrationMode) },
    { name: `static asset ${STATIC_ASSET}`, path: STATIC_ASSET, check: checkStaticAsset },
  ];
}

// ID-80: the canonical URL a response redirects to, if it keeps the exact path
// and query; otherwise null.
function canonicalLocation(result, pathAndQuery) {
  let target;
  try { target = new URL(result.headers.get('location')); } catch { return null; }
  return target.href === `${CANONICAL_ORIGIN}${pathAndQuery}` ? target.href : null;
}

function checkCanonicalRedirect(statuses, kind) {
  return result => {
    const problems = [];
    if (!statuses.has(result.status)) problems.push(`status ${result.status}, expected a ${kind} redirect`);
    if (!canonicalLocation(result, DOMAIN_REDIRECT_PROBE)) {
      problems.push(`does not redirect to ${CANONICAL_ORIGIN}${DOMAIN_REDIRECT_PROBE}`);
    }
    return problems;
  };
}

// Checks on the other two hosts, run only when the base is the canonical origin.
export function canonicalDomainChecks() {
  return [
    { name: 'legacy host page redirect', url: `${LEGACY_ORIGIN}${DOMAIN_REDIRECT_PROBE}`,
      check: checkCanonicalRedirect(TEMPORARY_REDIRECT_STATUSES, 'temporary') },
    // Not redirected: cron-job.org and in-flight API calls still use the old alias.
    { name: 'legacy host API alias', url: `${LEGACY_ORIGIN}/api/health/ready`, check: checkHealth('ready') },
    { name: 'www redirect', url: `${WWW_ORIGIN}${DOMAIN_REDIRECT_PROBE}`,
      check: checkCanonicalRedirect(PERMANENT_REDIRECT_STATUSES, 'permanent') },
  ];
}

// Google sign-in is advertised only on the host APP_URL names
// (api/_auth-config.js), so this tells which of the two hosts that is, or null
// when neither advertises it.
async function googleOAuthOrigin(fetchImpl, timeoutMs) {
  for (const origin of [CANONICAL_ORIGIN, LEGACY_ORIGIN]) {
    try {
      const result = await request(fetchImpl, `${origin}/api/auth/capabilities`, timeoutMs);
      if (parseJson(result.body)?.capabilities?.googleOAuth === true) return origin;
    } catch {
      // Unknown. The capability check reports the base origin's own failure.
    }
  }
  return null;
}

function canonicalDomainSkipReason(origin, oauthOrigin) {
  if (origin === LEGACY_ORIGIN) return `the base URL is the legacy alias; they run against ${CANONICAL_ORIGIN}`;
  if (origin !== CANONICAL_ORIGIN) return `the base URL is not the canonical origin ${CANONICAL_ORIGIN}`;
  return `APP_URL still names ${oauthOrigin} (Google sign-in is advertised there); `
    + `they run once APP_URL is ${CANONICAL_ORIGIN}`;
}

export async function runProductionSmoke({ baseUrl = DEFAULT_BASE_URL, fetchImpl = globalThis.fetch,
  expectedCapabilities = DEFAULT_EXPECTED_CAPABILITIES, registrationMode = DEFAULT_REGISTRATION_MODE,
  timeoutMs = 15_000 } = {}) {
  const origin = parseBaseUrl(baseUrl);
  const legacyBase = origin === LEGACY_ORIGIN;
  const oauthOrigin = origin === CANONICAL_ORIGIN || legacyBase ? await googleOAuthOrigin(fetchImpl, timeoutMs) : null;
  let expected = expectedCapabilities;
  let capabilityNote = null;
  if (oauthOrigin && oauthOrigin !== origin && expected.googleOAuth === true) {
    expected = Object.fromEntries(Object.entries(expected).filter(([key]) => key !== 'googleOAuth'));
    capabilityNote = `googleOAuth is advertised on ${oauthOrigin}, the APP_URL host, so it is not expected here`;
  }
  const checks = smokeChecks(origin, { expectedCapabilities: expected, registrationMode });
  const skipped = [];
  if (origin === CANONICAL_ORIGIN && oauthOrigin !== LEGACY_ORIGIN) checks.push(...canonicalDomainChecks());
  else skipped.push({ name: 'canonical-domain checks', reason: canonicalDomainSkipReason(origin, oauthOrigin) });

  const results = [];
  for (const { name, path, url = `${origin}${path}`, check } of checks) {
    const label = path ?? url;
    try {
      let response = await request(fetchImpl, url, timeoutMs);
      let note = path === '/api/auth/capabilities' ? capabilityNote : null;
      // The legacy alias redirects page paths, never /api/*: check the page it
      // now lands on.
      const target = legacyBase && !path.startsWith('/api/') && TEMPORARY_REDIRECT_STATUSES.has(response.status)
        ? canonicalLocation(response, path) : null;
      if (target) {
        response = await request(fetchImpl, target, timeoutMs);
        note = `followed the canonical redirect to ${target}`;
      }
      const problems = check(response);
      results.push({ name, path: label, status: response.status, ok: problems.length === 0, problems,
        ...(note ? { note } : {}) });
    } catch (error) {
      const category = error?.name === 'TimeoutError' ? 'timeout' : 'network_error';
      results.push({ name, path: label, status: null, ok: false, problems: [category] });
    }
  }
  return { ok: results.every(result => result.ok), origin, results, skipped };
}

function argValue(argv, flag) {
  const index = argv.indexOf(flag);
  if (index === -1) return undefined;
  const value = argv[index + 1];
  if (value === undefined || value.startsWith('--')) throw new SmokeConfigurationError(`${flag} requires a value`);
  return value;
}

export async function main({ argv = process.argv.slice(2), env = process.env, fetchImpl = globalThis.fetch,
  log = console.log, error = console.error } = {}) {
  let options;
  try {
    const timeoutMs = Number(env.SMOKE_TIMEOUT_MS || 15_000);
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > 60_000) {
      throw new SmokeConfigurationError('SMOKE_TIMEOUT_MS must be an integer between 1000 and 60000');
    }
    options = {
      baseUrl: parseBaseUrl(argValue(argv, '--base-url') || env.SMOKE_BASE_URL || DEFAULT_BASE_URL),
      expectedCapabilities: resolveExpectedCapabilities(
        argValue(argv, '--expect-capabilities') ?? env.SMOKE_EXPECTED_CAPABILITIES),
      registrationMode: argValue(argv, '--expect-registration-mode')
        || env.SMOKE_EXPECTED_REGISTRATION_MODE || DEFAULT_REGISTRATION_MODE,
      timeoutMs,
      fetchImpl,
    };
  } catch (cause) {
    if (!(cause instanceof SmokeConfigurationError)) throw cause;
    error(`production smoke: invalid configuration: ${cause.message}`);
    return 2;
  }

  const summary = await runProductionSmoke(options);
  log(`production smoke: ${summary.origin}`);
  for (const result of summary.results) {
    log(`  ${result.ok ? 'ok  ' : 'FAIL'} ${result.name} (${result.status ?? 'no response'})`
      + (result.ok ? '' : `: ${result.problems.join('; ')}`) + (result.note ? ` [${result.note}]` : ''));
  }
  for (const { name, reason } of summary.skipped) log(`  skip ${name}: ${reason}`);
  const failed = summary.results.filter(result => !result.ok).length;
  log(`production smoke: ${failed === 0 ? 'OK' : 'FAILED'} ${summary.results.length - failed}/${summary.results.length} checks passed`);
  return failed === 0 ? 0 : 1;
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : null;
if (invokedPath === import.meta.url) {
  main().then(code => { process.exitCode = code; }, cause => {
    console.error(`production smoke: unexpected ${cause?.name || 'Error'}`);
    process.exitCode = 1;
  });
}
