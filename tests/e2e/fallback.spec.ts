import { expect, test } from '@playwright/test';
import { mockApi, resetClientState, setCode, twoSumCorrect } from './helpers';

test('the plain editor remains usable when Monaco and formatter CDNs are unavailable', async ({ page }) => {
  await page.route(/(cdnjs\.cloudflare\.com|cdn\.jsdelivr\.net|unpkg\.com)/, route => route.abort());
  await mockApi(page, {
    '/api/execute': {
      ok: true,
      passed_count: 3,
      total_count: 3,
      results: [0, 1, 2].map(idx => ({ idx, pass: true })),
      piston: { code: 0, stdout: '', stderr: '' },
    },
  });
  await resetClientState(page);
  await page.goto('/?view=code', { waitUntil: 'domcontentloaded' });
  await page.locator('[data-tab="code"]').click();

  await expect(page.locator('#monacoFallbackNote')).toBeVisible({ timeout: 12_000 });
  await expect(page.locator('#editor')).toBeVisible();
  await expect(page.locator('#useServerRunner')).toBeChecked();
  await expect(page.locator('#useServerRunner')).toBeDisabled();
  await setCode(page, twoSumCorrect);
  await page.locator('#runBtn').click();
  await expect(page.locator('#runOut')).toContainText('Result: 3/3 passed');
});
