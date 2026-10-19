import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import test from 'node:test';

import { navigationPath } from '../../scripts/local-server.mjs';
import { APP_ROUTES } from '../../scripts/production-smoke.mjs';
import { isStaticAppRoute } from '../support/static-server.mjs';

// Local dev and e2e servers special-case client routes, so they cannot see a
// broken vercel.json fallback (the cleanUrls + /index.html bug fixed in #255).
// This test models the subset of Vercel routing the app relies on and checks
// that every path either local server treats as the app shell, and every link
// the app emails, resolves to index.html in production.

const vercel = JSON.parse(readFileSync('vercel.json', 'utf8'));
const deployedFiles = new Set([
  'index.html',
  ...readdirSync('assets').map(file => `assets/${file}`),
]);

function compileSource(source) {
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

// Serve a path from the static output only (no rewrites), with cleanUrls
// semantics: `/` -> index.html, `/name` -> name.html, `*.html` and `/index`
// are redirected away rather than served.
function filesystem(pathname, config, files) {
  const relative = pathname.replace(/^\/+/u, '');
  if (config.cleanUrls) {
    if (/\.html$/u.test(relative) || relative === 'index' || relative.endsWith('/index')) {
      return { kind: 'redirect' };
    }
    if (relative === '' && files.has('index.html')) return { kind: 'file', file: 'index.html' };
    if (relative && files.has(`${relative}.html`)) return { kind: 'file', file: `${relative}.html` };
  } else if (relative === '' && files.has('index.html')) {
    return { kind: 'file', file: 'index.html' };
  }
  if (relative && files.has(relative)) return { kind: 'file', file: relative };
  return null;
}

export function resolveVercelPath(pathname, config = vercel, files = deployedFiles) {
  const direct = filesystem(pathname, config, files);
  if (direct) return direct;
  for (const rewrite of config.rewrites ?? []) {
    if (!compileSource(rewrite.source).test(pathname)) continue;
    const destination = rewrite.destination.split('?')[0];
    if (destination.startsWith('/api/')) return { kind: 'function', destination };
    // A rewrite destination is resolved against the filesystem; under
    // cleanUrls `/index.html` is a redirect source, not a servable file.
    const target = filesystem(destination, config, files);
    return target?.kind === 'file' ? target : { kind: 'not-found' };
  }
  return { kind: 'not-found' };
}

function servesShell(pathname, config = vercel) {
  const resolved = resolveVercelPath(pathname, config);
  return resolved.kind === 'file' && resolved.file === 'index.html';
}

const CLIENT_ROUTES = ['/', '/invite', '/verify', '/reset-password', '/join/week_1_pair_1'];
const PROBE_PATHS = [
  ...CLIENT_ROUTES,
  '/join/abc', '/join/week_12_pair_3', '/join/a/b', '/join/', '/invite/', '/verify/x',
  '/reset-password/extra', '/settings', '/history', '/unknown/deep/path',
];

function emailLinks(file) {
  const source = readFileSync(file, 'utf8');
  const links = [];
  for (const match of source.matchAll(/\$\{(?:origin|baseUrl|safeBaseUrl)\}([^`"'#?\s]*)/gu)) {
    links.push((match[1] || '/').replace(/\$\{[^}]*\}/gu, 'week_1_pair_1'));
  }
  return links;
}

test('the SPA fallback rewrites to / while cleanUrls is enabled', () => {
  assert.equal(vercel.cleanUrls, true);
  const fallback = vercel.rewrites.at(-1);
  assert.deepEqual(fallback, { source: '/(.*)', destination: '/' });
});

test('every client route resolves to the app shell under the vercel.json routing model', () => {
  for (const pathname of CLIENT_ROUTES) {
    assert.ok(servesShell(pathname), `${pathname} must serve index.html in production`);
  }
  assert.deepEqual(resolveVercelPath('/index.html'), { kind: 'redirect' });
  assert.deepEqual(resolveVercelPath('/assets/calendar-export.js'),
    { kind: 'file', file: 'assets/calendar-export.js' });
  assert.equal(resolveVercelPath('/api/health/live').kind, 'function');
  assert.equal(resolveVercelPath('/api/invitations/abc').kind, 'function');
});

test('the routing model reproduces the cleanUrls fallback outage', () => {
  const broken = structuredClone(vercel);
  broken.rewrites.at(-1).destination = '/index.html';
  for (const pathname of CLIENT_ROUTES.filter(path => path !== '/')) {
    assert.deepEqual(resolveVercelPath(pathname, broken), { kind: 'not-found' },
      `${pathname} should 404 with the pre-#255 fallback`);
  }
  // `/` itself is served from the filesystem, which is why the bug was easy to miss.
  assert.ok(servesShell('/', broken));
});

test('every path the local dev and e2e servers treat as the app shell is served by vercel.json', () => {
  for (const pathname of CLIENT_ROUTES) {
    assert.ok(navigationPath(pathname), `local server must treat ${pathname} as an app route`);
    assert.ok(isStaticAppRoute(pathname), `e2e static server must treat ${pathname} as an app route`);
  }
  for (const pathname of PROBE_PATHS) {
    if (navigationPath(pathname) || isStaticAppRoute(pathname)) {
      assert.ok(servesShell(pathname), `${pathname} is an app route locally but not in production`);
    }
  }
});

test('every link generated in transactional email resolves to the app shell in production', () => {
  const files = [
    'api/_email-activation.js',
    'api/_invitation-email.js',
    'api/_password-reset.js',
    'api/_pairing-email.js',
    'api/_schedule-email.js',
  ];
  const paths = new Set();
  for (const file of files) {
    const links = emailLinks(file);
    assert.ok(links.length > 0, `${file} must still generate at least one app link`);
    for (const link of links) {
      paths.add(link);
      assert.ok(servesShell(link), `${file} links to ${link}, which vercel.json does not serve`);
    }
  }
  for (const expected of ['/', '/verify', '/invite', '/reset-password', '/join/week_1_pair_1']) {
    assert.ok(paths.has(expected), `expected an emailed link to ${expected}`);
  }
});

test('the production smoke check covers every client route', () => {
  for (const pathname of CLIENT_ROUTES) {
    assert.ok(APP_ROUTES.includes(pathname), `production smoke must check ${pathname}`);
  }
  assert.ok(APP_ROUTES.some(pathname => !navigationPath(pathname) && servesShell(pathname)),
    'production smoke must also check an unknown path that relies on the fallback');
});
