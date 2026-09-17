import { expect, test } from '@playwright/test';
import { mockApi, resetClientState } from './helpers';

test('the checked-out app boots without JavaScript exceptions and its tabs navigate', async ({ page }) => {
  const pageErrors: string[] = [];
  page.on('pageerror', error => pageErrors.push(error.message));
  await mockApi(page);
  await resetClientState(page);

  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await expect(page.getByRole('heading', { name: 'Randori Circle', exact: true })).toBeVisible();

  for (const [tab, view] of [
    ['Pairing', '#view-pair'],
    ['Code', '#view-code'],
    ['Board', '#view-board'],
    ['History', '#view-history'],
  ] as const) {
    await page.getByRole('button', { name: new RegExp(tab) }).click();
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
