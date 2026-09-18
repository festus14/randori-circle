import { expect, test } from '@playwright/test';
import { mockApi, resetClientState } from './helpers';

test('server-provided profile fields are rendered as text, not executable markup', async ({ page }) => {
  const hostileName = '<img src=x onerror="window.__randoriXss=true">';
  await mockApi(page, {
    '/api/auth/me': {
      ok: true,
      user: {
        id: 1,
        email: 'admin@example.test',
        name: 'Admin',
        display_name: 'Admin',
        color: '#c8f6a0',
        is_admin: true,
        is_available: true,
        tz: 'Europe/London',
        interview_focus: 'both',
      },
    },
    '/api/circle': {
      ok: true,
      count: 1,
      circle_meta: { id: 1, public_id: 'circle_security', name: 'Security Circle' },
      membership: { role: 'member' },
      circle: [{ id: 2, display_name: hostileName, color: '#c8f6a0', is_available: true }],
    },
  });
  await resetClientState(page, true);
  await page.addInitScript(() => {
    const user = JSON.parse(localStorage.getItem('randori-me') || '{}');
    user.is_admin = true;
    user.email = 'admin@example.test';
    localStorage.setItem('randori-me', JSON.stringify(user));
  });

  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await page.locator('[data-tab="circle"]').click();
  await expect(page.locator('#peopleList')).toContainText(hostileName);
  expect(await page.evaluate(() => (window as typeof window & { __randoriXss?: boolean }).__randoriXss)).not.toBe(true);
  await expect(page.locator('#peopleList img')).toHaveCount(0);
});
