import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import vm from 'node:vm';

const html = readFileSync(new URL('../../index.html', import.meta.url), 'utf8');
const LOADER_TAG = '<script src="https://js-de.sentry-cdn.com/b4aa012a94edbcd36c8c92ef1aaeddfa.min.js" crossorigin="anonymous"></script>';
const PRODUCTION_ORIGIN = 'https://randori-circle-self.vercel.app';

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
  ['http production host', 'http://randori-circle-self.vercel.app/', 'preview', {}],
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

test('the client logger forwarding is only installed when Sentry is enabled', () => {
  assert.match(html, /if\(window\.Sentry&&window\.__randoriSentry&&window\.__randoriSentry\.enabled\)\{\s*window\._sentryReady=true;/);
});

test('the browser production origin matches the documented production APP_URL', () => {
  const guide = readFileSync(new URL('../../docs/PRODUCTION_BOOTSTRAP_GUIDE.md', import.meta.url), 'utf8');
  assert.match(guide, new RegExp(`\\| \`APP_URL\` \\| \`${PRODUCTION_ORIGIN.replace(/[.]/g, '\\.')}\` \\|`));
  assert.ok(configScript().includes(`var PRODUCTION_ORIGIN='${PRODUCTION_ORIGIN}';`));
});
