import { expect, test, type Page } from '@playwright/test';
import { mockApi, resetClientState } from './helpers';

// Golden paths for the WP-S app shell: every primary destination is reachable
// on phones (bottom tab bar) and desktops (member sidebar), the theme choice
// persists, and the account menu signs the member out.

const member = {
  id: 1,
  email: 'shell@example.test',
  name: 'Shell Member',
  display_name: 'Shell Member',
  color: '#c8f6a0',
  is_admin: false,
  is_available: true,
  tz: 'Europe/London',
  interview_focus: 'both',
};

const destinations = [
  { tab: 'circle', view: '#view-circle' },
  { tab: 'pair', view: '#view-pair' },
  { tab: 'code', view: '#view-code' },
  { tab: 'board', view: '#view-board' },
  { tab: 'history', view: '#view-history' },
] as const;

async function signedInShell(page: Page) {
  await mockApi(page, {
    '/api/auth/me': { ok: true, user: member },
    '/api/profile': { ok: true, user: member },
  });
  await resetClientState(page, true, {}, true);
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await expect(page.locator('#view-dashboard')).toBeVisible();
}

async function visitEveryDestination(page: Page) {
  const navigation = page.getByRole('navigation', { name: 'Primary navigation' });
  const home = page.locator('#tab-home');
  await expect(home).toHaveAttribute('aria-current', 'page');
  for (const { tab, view } of destinations) {
    const button = page.locator(`[data-tab="${tab}"]`);
    await expect(button).toBeVisible();
    await button.click();
    await expect(page.locator(view)).toBeVisible();
    await expect(button).toHaveAttribute('aria-current', 'page');
    await expect(navigation.locator('[aria-current="page"]')).toHaveCount(1);
    await expect(home).not.toHaveAttribute('aria-current', 'page');
  }
  await home.click();
  await expect(page.locator('#view-dashboard')).toBeVisible();
  await expect(home).toHaveAttribute('aria-current', 'page');
  await expect(navigation.locator('[aria-current="page"]')).toHaveCount(1);
}

test.describe('phone', () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

  test('a compact topbar and a bottom tab bar reach every destination', async ({ page }) => {
    await signedInShell(page);
    const topbar = await page.locator('header.topbar').boundingBox();
    expect(topbar!.height).toBeLessThanOrEqual(64);

    const bar = await page.locator('.tabs').boundingBox();
    expect(bar!.x).toBeGreaterThanOrEqual(-0.5);
    expect(bar!.x + bar!.width).toBeLessThanOrEqual(390.5);
    expect(bar!.y + bar!.height).toBeGreaterThanOrEqual(843);
    for (const id of ['tab-home', 'tab-circle', 'tab-pair', 'tab-code', 'tab-board', 'tab-history']) {
      const box = await page.locator(`#${id}`).boundingBox();
      expect(box, `${id} renders`).not.toBeNull();
      expect(box!.x).toBeGreaterThanOrEqual(-0.5);
      expect(box!.x + box!.width).toBeLessThanOrEqual(390.5);
      expect(box!.width).toBeGreaterThanOrEqual(44);
      expect(box!.height).toBeGreaterThanOrEqual(44);
    }
    await visitEveryDestination(page);
  });

  test('every destination still fits at 320px', async ({ page }) => {
    await page.setViewportSize({ width: 320, height: 720 });
    await signedInShell(page);
    for (const id of ['tab-home', 'tab-circle', 'tab-pair', 'tab-code', 'tab-board', 'tab-history']) {
      const box = await page.locator(`#${id}`).boundingBox();
      expect(box!.x + box!.width).toBeLessThanOrEqual(320.5);
      expect(box!.width).toBeGreaterThanOrEqual(44);
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(320);
  });
});

test.describe('desktop', () => {
  test.use({ viewport: { width: 1280, height: 800 } });

  test('members navigate every destination from the sidebar', async ({ page }) => {
    await signedInShell(page);
    const home = await page.locator('#tab-home').boundingBox();
    const history = await page.locator('#tab-history').boundingBox();
    const main = await page.locator('main#appMain').boundingBox();
    expect(home!.x + home!.width).toBeLessThanOrEqual(260);
    expect(history!.y).toBeGreaterThan(home!.y);
    expect(main!.x).toBeGreaterThanOrEqual(home!.x + home!.width);
    await visitEveryDestination(page);
  });
});

test('the theme choice persists across reloads', async ({ page }) => {
  await mockApi(page);
  await resetClientState(page, false, {}, true);
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  const toggle = page.locator('#themeToggle');
  await expect(toggle).toHaveAttribute('aria-label', 'Switch to light theme');
  await toggle.click();
  await expect(page.locator('html')).toHaveClass(/(^|\s)light(\s|$)/);
  await expect(toggle).toHaveAttribute('aria-label', 'Switch to dark theme');

  await page.reload({ waitUntil: 'domcontentloaded' });
  await expect(page.locator('html')).toHaveClass(/(^|\s)light(\s|$)/);
  await expect(page.locator('#themeToggle')).toHaveAttribute('aria-label', 'Switch to dark theme');
  await page.locator('#themeToggle').click();
  await expect(page.locator('html')).not.toHaveClass(/(^|\s)light(\s|$)/);
});

test('the account menu signs the member out', async ({ page }) => {
  let signedIn = true;
  let logoutCalls = 0;
  await mockApi(page, {
    '/api/auth/me': () => signedIn
      ? { ok: true, user: member }
      : { _status: 401, ok: false, error: 'authentication required' },
    '/api/profile': { ok: true, user: member },
    '/api/auth/logout': () => {
      logoutCalls += 1;
      signedIn = false;
      return { ok: true };
    },
  });
  // Sign-out reloads the page; keep the seeded storage from being re-applied.
  await resetClientState(page, true, {}, true);
  await page.goto('/', { waitUntil: 'domcontentloaded' });

  const trigger = page.locator('#meLabel');
  await expect(trigger).toContainText('Shell Member');
  await expect(trigger).toHaveAccessibleName('Account menu for Shell Member');
  await trigger.click();
  await expect(trigger).toHaveAttribute('aria-expanded', 'true');
  const menu = page.getByRole('menu', { name: 'Account' });
  await expect(menu).toBeVisible();
  await menu.getByRole('menuitem', { name: 'Sign out', exact: true }).click();
  await expect.poll(() => logoutCalls).toBe(1);
  await expect(page.locator('#authBtn')).toBeVisible();
  await expect(trigger).toBeHidden();
  await expect(page.locator('#view-landing')).toBeVisible();
});

test('toasts are a polite live region that dismisses on click', async ({ page }) => {
  await mockApi(page);
  await resetClientState(page);
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => Boolean((window as any)._randori_shell?.toast));
  const toast = page.locator('#toast');
  await expect(toast).toHaveAttribute('role', 'status');
  await expect(toast).toHaveAttribute('aria-live', 'polite');
  await page.evaluate(() => (window as any).toast('Saved to your account'));
  await expect(toast).toBeVisible();
  await expect(toast).toHaveText('Saved to your account');
  await toast.click();
  await expect(toast).toBeHidden();
});
