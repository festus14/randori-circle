import { expect, test } from '@playwright/test';
import { mockApi } from './helpers';

test('a first-time visitor can dismiss onboarding and the choice survives reload', async ({ page }) => {
  await mockApi(page);

  await page.goto('/', { waitUntil: 'domcontentloaded' });
  const banner = page.locator('#welcomeBanner');
  await expect(banner).toBeVisible();
  await page.locator('#welcomeDismiss').click();
  await expect(banner).toBeHidden();
  await expect.poll(() => page.evaluate(() => localStorage.getItem('randori-onboarded'))).toBe('1');

  await page.reload({ waitUntil: 'domcontentloaded' });
  await expect(page.locator('#welcomeBanner')).toBeHidden();
  await expect(page.locator('#onboardOverlay')).not.toHaveClass(/show/);
});
