// ID-80: the canonical-domain redirects in vercel.json. Vercel runs these at
// the edge, so CI cannot request them; this test evaluates the rules the way
// Vercel compiles them (@vercel/routing-utils 6.6.0, path-to-regexp in strict
// mode) and checks host, path, API exclusion, status and ordering.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import {
  CANONICAL_DOMAIN_REDIRECTS,
  CANONICAL_ORIGIN,
  LEGACY_ORIGIN,
  WWW_ORIGIN,
  hostPattern,
} from '../../scripts/canonical-domain.mjs';
import {
  inspectDeploymentContract,
  validateCanonicalDomainRedirects,
  validateDeploymentContract,
} from '../../scripts/check-deployability.mjs';

const vercel = JSON.parse(readFileSync('vercel.json', 'utf8'));
const LEGACY_HOST = new URL(LEGACY_ORIGIN).hostname;
const WWW_HOST = new URL(WWW_ORIGIN).hostname;
const CANONICAL_HOST = new URL(CANONICAL_ORIGIN).hostname;

// The `src` Vercel generates for each redirect source, copied from
// getTransformedRoutes(vercel.json). A named parameter with a custom pattern
// compiles to ^(?:/(pattern))$.
const VERCEL_COMPILED_SOURCES = {
  '/:path(.*)': '^(?:/(.*))$',
  '/:path((?!api(?:/|$)).*)': '^(?:/((?!api(?:/|$)).*))$',
};
// cleanUrls redirects, which Vercel places before every user redirect.
const CLEAN_URL_REDIRECTS = [
  { src: '^/(?:(.+)/)?index(?:\\.html)?/?$', location: '/$1' },
  { src: '^/(.*)\\.html/?$', location: '/$1' },
];

function compileRedirectSource(source) {
  const match = /^\/:([A-Za-z_]\w*)\((.*)\)$/u.exec(source);
  assert.ok(match, `${source} must be a single named parameter with a custom pattern`);
  return { name: match[1], src: `^(?:/(${match[2]}))$` };
}

// Vercel matches a `has` host value as an anchored pattern against the
// request hostname.
function hostMatches(rule, host) {
  return rule.has.every(item => item.type !== 'host' || new RegExp(`^${item.value}$`, 'u').test(host));
}

// One routing step for a request: the first matching cleanUrls redirect, then
// the first matching host redirect. Vercel passes the request query through to
// a redirect whose destination has none.
function redirectFor(host, pathAndQuery, config = vercel) {
  const url = new URL(pathAndQuery, `https://${host}`);
  for (const { src, location } of CLEAN_URL_REDIRECTS) {
    const match = new RegExp(src, 'u').exec(url.pathname);
    if (match) return { status: 308, location: location.replace('$1', match[1] ?? '') + url.search };
  }
  for (const rule of config.redirects ?? []) {
    if (!hostMatches(rule, host)) continue;
    const { name, src } = compileRedirectSource(rule.source);
    const match = new RegExp(src, 'u').exec(url.pathname);
    if (!match) continue;
    return {
      status: rule.permanent ? 308 : 307,
      location: rule.destination.replace(`:${name}`, match[1]) + url.search,
    };
  }
  return null;
}

function compileRewriteSource(source) {
  const pattern = source
    .split(/(\(\.\*\)|:[A-Za-z_][A-Za-z0-9_]*)/u)
    .map(part => {
      if (part === '(.*)') return '(.*)';
      if (/^:[A-Za-z_]/u.test(part)) return '([^/]+?)';
      return part.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
    })
    .join('');
  return new RegExp(`^${pattern}$`, 'u');
}

function rewriteFor(pathname) {
  return vercel.rewrites.find(rewrite => compileRewriteSource(rewrite.source).test(pathname));
}

test('vercel.json defines exactly the reviewed canonical-domain redirects', () => {
  assert.deepEqual(vercel.redirects, CANONICAL_DOMAIN_REDIRECTS);
  assert.deepEqual(validateCanonicalDomainRedirects(vercel.redirects), []);
  for (const rule of vercel.redirects) {
    assert.equal(compileRedirectSource(rule.source).src, VERCEL_COMPILED_SOURCES[rule.source]);
    // One exact hostname per rule: a string `has` value is a regex, so the
    // dots are escaped and nothing else could reach a preview host.
    assert.equal(rule.has.length, 1);
    assert.match(rule.has[0].value, /^(?:[a-z0-9-]+\\\.)+[a-z]+$/u);
    assert.ok(rule.destination.startsWith(`${CANONICAL_ORIGIN}/`));
  }
  assert.deepEqual(vercel.redirects.map(rule => rule.has[0].value),
    ['www\\.randoricircle\\.com', 'randori-circle-self\\.vercel\\.app']);
  assert.equal(hostPattern(WWW_ORIGIN), 'www\\.randoricircle\\.com');
  assert.equal(CANONICAL_ORIGIN, 'https://randoricircle.com');
});

test('www redirects every path, including the bare host, permanently to the apex with path and query', () => {
  for (const [path, location] of [
    ['/', `${CANONICAL_ORIGIN}/`],
    ['/?ref=x', `${CANONICAL_ORIGIN}/?ref=x`],
    ['/invite?smoke=1#invite=abc', `${CANONICAL_ORIGIN}/invite?smoke=1`],
    ['/join/week_1_pair_1', `${CANONICAL_ORIGIN}/join/week_1_pair_1`],
    ['/privacy', `${CANONICAL_ORIGIN}/privacy`],
    ['/api/health/ready', `${CANONICAL_ORIGIN}/api/health/ready`],
  ]) {
    assert.deepEqual(redirectFor(WWW_HOST, path), { status: 308, location }, path);
  }
  // The strict `/:path*` form Vercel would compile does not match `/`.
  assert.equal(new RegExp('^(?:/((?:[^/]+?)(?:/(?:[^/]+?))*))?$', 'u').test('/'), false);
});

test('the old alias redirects page paths temporarily with path and query, and never /api', () => {
  for (const [path, location] of [
    ['/', `${CANONICAL_ORIGIN}/`],
    ['/invite?smoke=canonical-domain', `${CANONICAL_ORIGIN}/invite?smoke=canonical-domain`],
    ['/verify', `${CANONICAL_ORIGIN}/verify`],
    ['/reset-password?a=1&b=2', `${CANONICAL_ORIGIN}/reset-password?a=1&b=2`],
    ['/join/week_12_pair_3', `${CANONICAL_ORIGIN}/join/week_12_pair_3`],
    ['/privacy', `${CANONICAL_ORIGIN}/privacy`],
    ['/terms', `${CANONICAL_ORIGIN}/terms`],
    ['/assets/calendar-export.js', `${CANONICAL_ORIGIN}/assets/calendar-export.js`],
    ['/apiary', `${CANONICAL_ORIGIN}/apiary`],
    ['/docs/api/x', `${CANONICAL_ORIGIN}/docs/api/x`],
  ]) {
    assert.deepEqual(redirectFor(LEGACY_HOST, path), { status: 307, location }, path);
  }
  for (const path of ['/api', '/api/', '/api/cron/outbox', '/api/cron/outbox-health', '/api/cron/weekly',
    '/api/health/ready?probe=1', '/api/auth/capabilities', '/api/auth/google/callback?code=x',
    '/api/invitations/abc', '/api/logs']) {
    assert.equal(redirectFor(LEGACY_HOST, path), null, `${path} must keep working on the old alias`);
  }
});

test('/api paths on the old alias still reach their function rewrites', () => {
  for (const path of ['/api/cron/outbox', '/api/cron/outbox-health', '/api/health/ready', '/api/auth/capabilities',
    '/api/invitations/abc']) {
    assert.equal(redirectFor(LEGACY_HOST, path), null);
    assert.match(rewriteFor(path).destination, /^\/api\/[a-z]+\?endpoint=/u, path);
  }
});

test('the canonical host, previews, deployment URLs and look-alikes are never redirected', () => {
  for (const host of [CANONICAL_HOST, 'randori-circle-git-feature-festus14s-projects.vercel.app',
    'randori-circle-abc123def-festus14s-projects.vercel.app', 'randori-circle.vercel.app',
    'self.vercel.app', 'www.randoricircle.com.evil.test', 'evil-randori-circle-self.vercel.app',
    'randori-circle-self.vercel.app.evil.test', 'app.randoricircle.com', 'localhost',
    // Unescaped dots would have matched these.
    'wwwXrandoricircle.com', 'randori-circle-selfXvercel.app']) {
    for (const path of ['/', '/invite?x=1', '/api/health/ready']) {
      assert.equal(redirectFor(host, path), null, `${host}${path}`);
    }
  }
});

test('cleanUrls redirects run before the host redirects, so .html paths on the old alias take two hops', () => {
  assert.deepEqual(redirectFor(LEGACY_HOST, '/index.html?x=1'), { status: 308, location: '/?x=1' });
  assert.deepEqual(redirectFor(LEGACY_HOST, '/?x=1'), { status: 307, location: `${CANONICAL_ORIGIN}/?x=1` });
  assert.deepEqual(redirectFor(LEGACY_HOST, '/privacy.html'), { status: 308, location: '/privacy' });
  assert.deepEqual(redirectFor(LEGACY_HOST, '/privacy'), { status: 307, location: `${CANONICAL_ORIGIN}/privacy` });
  // The SPA fallback is a rewrite, which Vercel only reaches after every
  // redirect and the filesystem; it stays the last rewrite.
  assert.deepEqual(vercel.rewrites.at(-1), { source: '/(.*)', destination: '/' });
});

test('headers and the CSP are host-agnostic, so the same deployment serves every host', () => {
  const serialized = JSON.stringify(vercel.headers);
  for (const host of [CANONICAL_HOST, WWW_HOST, LEGACY_HOST, 'vercel.app']) {
    assert.equal(serialized.includes(host), false, host);
  }
  assert.equal(vercel.headers.some(route => route.has || route.missing), false);
  assert.equal(vercel.rewrites.some(route => route.has || route.missing), false);
});

test('the deployability contract rejects missing or weakened canonical-domain redirects', () => {
  assert.deepEqual(inspectDeploymentContract(), []);
  // Only the vercel.json part differs, so the other parts' errors cancel out.
  const errorsFor = config => validateDeploymentContract({ vercel: config, packageJson: {}, files: [] });
  const baseline = errorsFor(structuredClone(vercel));
  const withoutRedirects = structuredClone(vercel);
  delete withoutRedirects.redirects;
  assert.deepEqual(errorsFor(withoutRedirects).filter(error => !baseline.includes(error)),
    ['vercel.json must define the canonical-domain redirects']);

  const error = 'vercel.json redirects must be exactly the reviewed canonical-domain redirects: '
    + JSON.stringify(CANONICAL_DOMAIN_REDIRECTS);
  const mutations = [
    // The old alias must stay temporary and must never redirect /api.
    rules => { rules[1].permanent = true; },
    rules => { rules[1].source = '/:path(.*)'; },
    rules => { rules[1].destination = `${CANONICAL_ORIGIN}/`; },
    // A pattern host would also catch preview deployments; an unescaped one
    // matches more than the one host.
    rules => { rules[1].has[0].value = '.*\\.vercel\\.app'; },
    rules => { rules[1].has[0].value = LEGACY_HOST; },
    rules => { rules.push(structuredClone(rules[1])); },
    rules => { rules[0].permanent = false; },
    rules => { rules[0].source = '/:path*'; },
    rules => { delete rules[0].has; },
    rules => { rules.reverse(); },
    rules => { rules.splice(0, 2, null, 'x'); },
    // Extra rules beside the reviewed two: host-less, or for another host.
    rules => { rules.unshift({ source: '/api/:path*', destination: `${CANONICAL_ORIGIN}/api/:path*`, permanent: false }); },
    rules => { rules.push({ source: '/(.*)', has: [{ type: 'host', value: 'randori-circle\\.vercel\\.app' }],
      destination: `${CANONICAL_ORIGIN}/$1`, permanent: true }); },
  ];
  for (const mutate of mutations) {
    const rules = structuredClone(vercel.redirects);
    mutate(rules);
    assert.deepEqual(validateCanonicalDomainRedirects(rules), [error], JSON.stringify(rules));
  }
  assert.deepEqual(validateCanonicalDomainRedirects({}), ['vercel.json must define the canonical-domain redirects']);
});
