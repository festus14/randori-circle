import { expect, test } from '@playwright/test';
import { mockApi, resetClientState } from './helpers';

test('the checked-out app boots without JavaScript exceptions and its tabs navigate', async ({ page }) => {
  const pageErrors: string[] = [];
  let authChecks = 0;
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
  // The app performs three scheduled session refreshes during startup. Wait for
  // the last anonymous route before testing navigation so it cannot hide a view
  // after the corresponding tab has been clicked.
  await expect.poll(() => authChecks).toBeGreaterThanOrEqual(3);
  await expect(page.locator('#view-landing')).toBeVisible();

  for (const [tab, view] of [
    ['pair', '#view-pair'],
    ['code', '#view-code'],
    ['board', '#view-board'],
    ['history', '#view-history'],
  ] as const) {
    await page.locator(`[data-tab="${tab}"]`).click();
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
