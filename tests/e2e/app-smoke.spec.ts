import { expect, test, type Page } from '@playwright/test';
import { blockTelemetry, mockApi, resetClientState } from './helpers';

test('the checked-out app boots without JavaScript exceptions and its tabs navigate', { tag: '@smoke' }, async ({ page }) => {
  await blockTelemetry(page);
  const pageErrors: string[] = [];
  let authChecks = 0;
  await page.clock.install();
  page.on('pageerror', error => pageErrors.push(error.message));
  await mockApi(page, {
    '/api/auth/me': () => {
      authChecks += 1;
      return { _status: 401, ok: false, error: 'authentication required' };
    },
  });
  await resetClientState(page);

  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await expect(page.getByRole('heading', { name: 'Randori Circle', exact: true })).toBeVisible();
  // Exercise background timers, then await one explicit refresh so the final
  // anonymous route cannot depend on DOMContentLoaded or host scheduling.
  await page.clock.fastForward(1_300);
  await page.evaluate(async () => {
    await (window as typeof window & {
      _randori_auth?: { refreshMe?: () => Promise<unknown> };
    })._randori_auth?.refreshMe?.();
  });
  expect(await page.evaluate(()=>Number.isSafeInteger((window as any)._randoriUserNavigationEpoch))).toBe(true);
  expect(authChecks).toBeGreaterThanOrEqual(1);
  await expect(page.locator('#view-landing')).toBeVisible();
  // Visitors on the landing page get no app navigation (WP-O).
  await expect(page.getByRole('navigation', { name: 'Primary navigation' })).toBeHidden();

  // Solo practice (/?view=code): visitors get the code view with a sign-in
  // prompt, and still no app navigation (every other view needs an account).
  await page.goto('/?view=code', { waitUntil: 'domcontentloaded' });
  await page.clock.fastForward(1_300);
  await page.evaluate(async () => {
    await (window as typeof window & {
      _randori_auth?: { refreshMe?: () => Promise<unknown> };
    })._randori_auth?.refreshMe?.();
  });
  await expect(page.locator('#view-code')).toBeVisible();
  await expect(page.getByRole('navigation', { name: 'Primary navigation' })).toBeHidden();
  await expect(page.getByTestId('solo-practice-bar')).toBeVisible();

  // The tab handlers still boot cleanly; the buttons are just not shown to
  // visitors, so drive them through the DOM.
  for (const [tab, view] of [
    ['pair', '#view-pair'],
    ['code', '#view-code'],
    ['board', '#view-board'],
    ['history', '#view-history'],
  ] as const) {
    await page.evaluate(name => (document.querySelector(`[data-tab="${name}"]`) as HTMLButtonElement).click(), tab);
    await expect(page.locator(view)).toBeVisible();
  }

  expect(pageErrors, pageErrors.join('\n')).toEqual([]);
});

test('the browser suite is pinned to the local checkout', { tag: '@smoke' }, async ({ page }) => {
  await blockTelemetry(page);
  const response = await page.goto('/', { waitUntil: 'domcontentloaded' });
  expect(response?.url()).toMatch(/^http:\/\/127\.0\.0\.1:/);
  expect(new URL(page.url()).hostname).toBe('127.0.0.1');

  const apiResponse = await page.request.get('/api/not-configured');
  expect(apiResponse.status()).toBe(503);
  expect(await apiResponse.json()).toMatchObject({
    error: 'API not configured in local static test server',
  });
});

test('browser tests never load the production telemetry SDK (Chromium host-resolver mechanism)', async ({ page }, testInfo) => {
  // Chromium-only: this proves the --host-resolver-rules mechanism, whose
  // failure mode (net::ERR_NAME_NOT_RESOLVED) exists in no other engine.
  // It must NOT call blockTelemetry — route interception would mask the
  // host-resolver failure this test guards. Untouched by @smoke, so the
  // smoke projects never run it; the cross-engine version below covers them.
  test.skip(testInfo.project.name !== 'chromium', 'host-resolver rules are Chromium-only');
  // The Sentry SDK's iframe-based timer probing races Playwright's fake clock
  // and would report CI sessions to production. playwright.config.js makes its
  // hosts unresolvable; this guards that contract on networked runners.
  const telemetryFailures: string[] = [];
  page.on('requestfailed', request => {
    if (/sentry-cdn\.com|sentry\.io/.test(new URL(request.url()).hostname)) {
      telemetryFailures.push(request.failure()?.errorText || '');
    }
  });
  await mockApi(page);
  await resetClientState(page);
  await page.goto('/', { waitUntil: 'load' });
  await expect.poll(() => page.evaluate(() => (window as typeof window & { _sentryReady?: boolean })._sentryReady)).toBe(false);
  expect(await page.evaluate(() => typeof (window as typeof window & { Sentry?: unknown }).Sentry)).toBe('undefined');
  // Even if the loader resolved, the environment-scoped config (#252) keeps
  // non-production origins and automated browsers disabled.
  expect(await page.evaluate(() => (window as typeof window & { __randoriSentry?: unknown }).__randoriSentry)).toEqual({
    environment: 'development',
    enabled: false,
    productionOrigin: 'https://randoricircle.com',
  });
  // The loader is requested once the page is idle (after load), not while it parses.
  await expect.poll(() => telemetryFailures).toEqual(['net::ERR_NAME_NOT_RESOLVED']);
});

test('telemetry SDK never initialises under route interception', { tag: '@smoke' }, async ({ page }) => {
  // Cross-engine version of the Chromium host-resolver test above (#399):
  // the loader is aborted at the route layer in every engine, so Sentry
  // never initialises and no telemetry request can succeed. The failure
  // mode is net::ERR_BLOCKED_BY_CLIENT, distinct from the host-resolver
  // failure, by design.
  const telemetryFailures: string[] = [];
  page.on('requestfailed', request => {
    if (/sentry-cdn\.com|sentry\.io/.test(new URL(request.url()).hostname)) {
      telemetryFailures.push(request.failure()?.errorText || '');
    }
  });
  await blockTelemetry(page);
  await mockApi(page);
  await resetClientState(page);
  await page.goto('/', { waitUntil: 'load' });
  await expect.poll(() => page.evaluate(() => (window as typeof window & { _sentryReady?: boolean })._sentryReady)).toBe(false);
  expect(await page.evaluate(() => typeof (window as typeof window & { Sentry?: unknown }).Sentry)).toBe('undefined');
  // Even if the loader resolved, the environment-scoped config (#252) keeps
  // non-production origins and automated browsers disabled.
  expect(await page.evaluate(() => (window as typeof window & { __randoriSentry?: unknown }).__randoriSentry)).toEqual({
    environment: 'development',
    enabled: false,
    productionOrigin: 'https://randoricircle.com',
  });
  // The loader is requested once the page is idle (after load), not while it parses.
  await expect.poll(() => telemetryFailures).toEqual(['net::ERR_BLOCKED_BY_CLIENT']);
});

// ID-72: the client logger installs everywhere, including production. This
// runs the checked-out app on the production origin (requests to it are
// served from the local test server) so the production send policy is used.
const PRODUCTION_ORIGIN = 'https://randoricircle.com';
type ClientLogEntry = { level: string; event: string; message: string; route: string; meta?: Record<string, unknown> };
type LoggerWindow = typeof window & {
  _randori_log?: {
    log?: unknown;
    queue: ClientLogEntry[];
    flush(): void;
  } & Record<'info' | 'warn' | 'error' | 'success' | 'debug', (event: string, message: string) => void>;
  _randori_auth?: { me?: { id?: number } | null; identitySettled?: boolean };
};

async function serveProductionOrigin(page: Page, baseURL: string) {
  await page.route(`${PRODUCTION_ORIGIN}/**`, async route => {
    const url = new URL(route.request().url());
    if (url.pathname.startsWith('/api/')) return route.fallback();
    const response = await page.request.get(new URL(url.pathname + url.search, baseURL).href);
    return route.fulfill({ response });
  });
}

function sentEntries(bodies: unknown[]): ClientLogEntry[] {
  return bodies.flatMap(body => ((body as { logs?: ClientLogEntry[] }).logs || [body as ClientLogEntry]));
}

test('on the production origin the client logger sends nothing for visitors and only redacted warn/error for members', async ({ page, baseURL }) => {
  const member = { id: 1, email: 'member@example.test', name: 'Member', display_name: 'Member', is_admin: false };
  const logBodies: unknown[] = [];
  let signedIn = false;
  await mockApi(page, {
    '/api/auth/me': () => signedIn ? { ok: true, user: member } : { _status: 401, ok: false, error: 'authentication required' },
    '/api/profile': { ok: true, user: member },
    '/api/logs': request => {
      logBodies.push(request.postDataJSON());
      return { ok: true, inserted: 1 };
    },
  });
  await serveProductionOrigin(page, String(baseURL));
  await resetClientState(page);

  // A visitor: the real logger is installed (no production placeholder), but
  // nothing is queued or sent while signed out.
  await page.goto(`${PRODUCTION_ORIGIN}/`, { waitUntil: 'domcontentloaded' });
  await expect.poll(() => page.evaluate(() => (window as LoggerWindow)._randori_auth?.identitySettled)).toBe(true);
  expect(await page.evaluate(() => (window as typeof window & { __randoriSentry?: unknown }).__randoriSentry)).toEqual({
    environment: 'production', enabled: false, productionOrigin: PRODUCTION_ORIGIN,
  });
  expect(await page.evaluate(() => typeof (window as LoggerWindow)._randori_log?.log)).toBe('function');
  await page.evaluate(() => {
    const log = (window as LoggerWindow)._randori_log!;
    log.error('e2e_probe', 'visitor error');
    log.flush();
  });
  expect(await page.evaluate(() => (window as LoggerWindow)._randori_log!.queue.length)).toBe(0);
  await page.waitForTimeout(500);
  expect(logBodies).toEqual([]);

  // A member: info, success and debug stay in the browser; warn and error are
  // sent, redacted, with the route but never the fragment.
  signedIn = true;
  // The session cookie lets the member fixtures answer, keeping boot noise low.
  await page.context().addCookies([{ name: 'randori_session', value: 'local-e2e-session', url: PRODUCTION_ORIGIN, httpOnly: true, sameSite: 'Lax' }]);
  const secret = 'S'.repeat(43);
  await page.goto(`${PRODUCTION_ORIGIN}/?view=history#e2e-fragment-${secret}`, { waitUntil: 'domcontentloaded' });
  await expect.poll(() => page.evaluate(() => (window as LoggerWindow)._randori_auth?.me?.id)).toBe(1);
  const route = await page.evaluate(secretValue => {
    const log = (window as LoggerWindow)._randori_log!;
    log.info('e2e_probe', 'info stays in the browser');
    log.success('e2e_probe', 'success stays in the browser');
    log.debug('e2e_probe', 'debug stays in the browser');
    log.warn('e2e_probe', 'warn for member@example.test at /reset?token=abc123');
    log.error('e2e_probe', `error at ${location.origin}/invite#invite=${secretValue}`);
    log.flush();
    return location.pathname + location.search;
  }, secret);
  await expect.poll(() => sentEntries(logBodies).filter(entry => entry.event === 'e2e_probe').map(entry => entry.level)).toEqual(['warn', 'error']);
  const [warn, error] = sentEntries(logBodies).filter(entry => entry.event === 'e2e_probe');
  expect(warn.message).toBe('warn for [email] at /reset?token=[redacted]');
  expect(error.message).toBe(`error at ${PRODUCTION_ORIGIN}/invite`);
  expect(warn.route).toBe(route);
  expect(warn.route).not.toContain('#');
  expect(warn.meta).not.toHaveProperty('href');
  const wire = JSON.stringify(logBodies);
  expect(wire).not.toContain(secret);
  expect(wire).not.toContain('member@example.test');
  expect(wire).not.toContain('e2e-fragment');
});
