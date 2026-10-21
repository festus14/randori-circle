import { expect, test, type Page } from '@playwright/test';
import { mockApi, resetClientState } from './helpers';

// What an anonymous visitor's landing page downloads. The Monaco editor, the
// CRDT bundle and the Sentry SDK are not needed to show the landing page, so
// they must not compete with it: Monaco and the CRDT bundle load when the code
// view or a pair room first opens, and Sentry loads once the page is idle.

const EDITOR_ASSET = /cdnjs\.cloudflare\.com|cdn\.jsdelivr\.net|unpkg\.com|\/assets\/crdt-editor\.js/;
const TELEMETRY_HOST = /sentry-cdn\.com|sentry\.io/;

type Entry = { url: string; type: string; bytes: number; failed: boolean; at: number };

function recordRequests(page: Page) {
  const entries: Entry[] = [];
  const started = Date.now();
  page.on('requestfinished', async request => {
    const sizes = await request.sizes().catch(() => null);
    entries.push({
      url: request.url(),
      type: request.resourceType(),
      bytes: sizes ? sizes.responseBodySize + sizes.responseHeadersSize : 0,
      failed: false,
      at: Date.now() - started,
    });
  });
  page.on('requestfailed', request => {
    entries.push({ url: request.url(), type: request.resourceType(), bytes: 0, failed: true, at: Date.now() - started });
  });
  return entries;
}

function summary(entries: Entry[], origin: string) {
  const sameOrigin = entries.filter(entry => entry.url.startsWith(origin));
  const thirdParty = entries.filter(entry => !entry.url.startsWith(origin));
  const total = (list: Entry[]) => list.reduce((sum, entry) => sum + entry.bytes, 0);
  return {
    requests: entries.length,
    bytes: total(entries),
    sameOriginRequests: sameOrigin.length,
    sameOriginBytes: total(sameOrigin),
    thirdPartyRequests: thirdParty.length,
    thirdPartyBytes: total(thirdParty),
    thirdParty: thirdParty.map(entry => `${entry.failed ? 'FAILED ' : ''}${new URL(entry.url).host}${new URL(entry.url).pathname} ${entry.bytes}B @${entry.at}ms`),
    editorOrTelemetry: entries.filter(entry => EDITOR_ASSET.test(entry.url) || TELEMETRY_HOST.test(entry.url)).map(entry => new URL(entry.url).pathname),
  };
}

test('an anonymous landing page loads no editor, CRDT or telemetry code before it is idle', async ({ page, baseURL }) => {
  await mockApi(page);
  await resetClientState(page);
  const entries = recordRequests(page);
  await page.goto('/', { waitUntil: 'load' });
  await expect(page.locator('#view-landing')).toBeVisible();
  const atLoad = summary(entries, String(baseURL));
  // Long enough for the old DOMContentLoaded + 450 ms Monaco start and an
  // idle-time Sentry load.
  await page.waitForTimeout(5_000);
  const settled = summary(entries, String(baseURL));
  console.log(`[page-weight] anonymous / at load: ${JSON.stringify(atLoad)}`);
  console.log(`[page-weight] anonymous / after 5 s idle: ${JSON.stringify(settled)}`);
  test.info().annotations.push(
    { type: 'page-weight-load', description: JSON.stringify(atLoad) },
    { type: 'page-weight-settled', description: JSON.stringify(settled) },
  );

  expect(atLoad.editorOrTelemetry).toEqual([]);
  expect(settled.editorOrTelemetry.filter(path => EDITOR_ASSET.test(path) || path.endsWith('crdt-editor.js'))).toEqual([]);
  expect(await page.evaluate(() => typeof (window as typeof window & { _randori_crdt?: unknown })._randori_crdt)).toBe('undefined');
  expect(await page.evaluate(() => typeof (window as typeof window & { require?: unknown }).require)).toBe('undefined');
  // Sentry still loads (and stays disabled outside production) once idle.
  expect(settled.thirdParty.filter(line => TELEMETRY_HOST.test(line))).toHaveLength(1);
  expect(await page.evaluate(() => (window as typeof window & { _sentryReady?: boolean })._sentryReady)).toBe(false);
});

test('opening the code view loads the editor loader and the CRDT bundle on demand', async ({ page }) => {
  const requested: string[] = [];
  await page.route(/(cdnjs\.cloudflare\.com|cdn\.jsdelivr\.net|unpkg\.com)/, route => {
    requested.push(new URL(route.request().url()).host + new URL(route.request().url()).pathname);
    return route.abort();
  });
  page.on('request', request => {
    if (new URL(request.url()).pathname === '/assets/crdt-editor.js') requested.push('/assets/crdt-editor.js');
  });
  await mockApi(page);
  await resetClientState(page);
  await page.goto('/', { waitUntil: 'load' });
  await expect(page.locator('#view-landing')).toBeVisible();
  await page.waitForTimeout(1_000);
  expect(requested).toEqual([]);

  await page.goto('/?view=code', { waitUntil: 'domcontentloaded' });
  await expect(page.locator('#view-code')).toBeVisible();
  await expect.poll(() => requested.filter(path => path === '/assets/crdt-editor.js').length).toBe(1);
  await expect.poll(() => page.evaluate(() => typeof (window as typeof window & { _randori_crdt?: unknown })._randori_crdt)).toBe('object');
  await expect.poll(() => requested.some(path => path === 'cdnjs.cloudflare.com/ajax/libs/monaco-editor/0.45.0/min/vs/loader.min.js')).toBe(true);
  // The CDN is unavailable here, so the plain editor takes over.
  await expect(page.locator('#monacoFallbackNote')).toBeVisible({ timeout: 12_000 });
  await expect(page.locator('#editor')).toBeVisible();
});
