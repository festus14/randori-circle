import { expect, test } from '@playwright/test';
import { mockApi, resetClientState } from './helpers';

test('the checked-out app boots without JavaScript exceptions and its tabs navigate', async ({ page }) => {
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

test('the browser suite is pinned to the local checkout', async ({ page }) => {
  const response = await page.goto('/', { waitUntil: 'domcontentloaded' });
  expect(response?.url()).toMatch(/^http:\/\/127\.0\.0\.1:/);
  expect(new URL(page.url()).hostname).toBe('127.0.0.1');

  const apiResponse = await page.request.get('/api/not-configured');
  expect(apiResponse.status()).toBe(503);
  expect(await apiResponse.json()).toMatchObject({
    error: 'API not configured in local static test server',
  });
});

test('browser tests never load the production telemetry SDK', async ({ page }) => {
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
    productionOrigin: 'https://randori-circle-self.vercel.app',
  });
  expect(telemetryFailures).toEqual(['net::ERR_NAME_NOT_RESOLVED']);
});
