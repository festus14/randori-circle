import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { mockApi, resetClientState } from './helpers';

// Final UX pass: the app navigation (tabs, and the phone bottom bar) is for
// members only. Visitors see the logo, the theme toggle and Sign in, on every
// route, while identity loads, and right after signing out.

const member = {
  id: 1,
  email: 'nav@example.test',
  name: 'Nav Member',
  display_name: 'Nav Member',
  color: '#c8f6a0',
  is_admin: false,
  is_available: true,
  tz: 'Europe/London',
  interview_focus: 'both',
};
const capabilities = {
  ok: true,
  capabilities: { passwordLogin: true, passwordSignup: false, passwordReset: true, googleOAuth: false },
  registrationMode: 'private_beta',
};

const primaryNavigation = (page: Page) => page.getByRole('navigation', { name: 'Primary navigation', includeHidden: true });

async function settledIdentity(page: Page) {
  await expect.poll(() => page.evaluate(() => (window as any)._randori_auth?.identitySettled === true)).toBe(true);
}

async function expectVisitorChrome(page: Page) {
  await expect(page.locator('body')).toHaveAttribute('data-nav', 'hidden');
  await expect(primaryNavigation(page)).toBeHidden();
  await expect(page.locator('.tabs')).toBeHidden();
  await expect(page.locator('header.topbar .brand')).toBeVisible();
  await expect(page.locator('#themeToggle')).toBeVisible();
  await expect(page.locator('#authBtn')).toBeVisible();
  await expect(page.locator('#meLabel')).toBeHidden();
}

for (const viewport of [
  { name: 'phone', width: 393, height: 852 },
  { name: 'desktop', width: 1440, height: 900 },
]) {
  test.describe(`visitors on a ${viewport.name}`, () => {
    test.use({ viewport: { width: viewport.width, height: viewport.height } });

    test('see no app navigation on the landing, recovery, join and unknown routes', async ({ page }) => {
      await mockApi(page, { '/api/auth/capabilities': capabilities });
      await resetClientState(page);
      for (const path of ['/', '/reset-password#token=not-a-real-token', '/invite', '/verify', '/reset-password', '/join/not-a-room']) {
        await page.goto(path, { waitUntil: 'domcontentloaded' });
        await settledIdentity(page);
        await expectVisitorChrome(page);
        if (viewport.width < 600) {
          expect(await page.evaluate(() => Number.parseFloat(getComputedStyle(document.body).paddingBottom)), path).toBe(0);
        }
      }
    });

    test('opening a pair link asks them to sign in over a page without tabs', async ({ page }) => {
      await mockApi(page, { '/api/auth/capabilities': capabilities });
      await resetClientState(page);
      await page.goto('/join/week_1_pair_1', { waitUntil: 'domcontentloaded' });
      await settledIdentity(page);
      await expect(page.getByRole('dialog', { name: 'Sign in to join your pairing room' })).toBeVisible();
      await expectVisitorChrome(page);
      expect(new URL(page.url()).pathname).toBe('/join/week_1_pair_1');
    });

    test('solo practice shows the code view with a sign-in prompt and no tabs', async ({ page }) => {
      await mockApi(page, { '/api/auth/capabilities': capabilities });
      await resetClientState(page);
      await page.goto('/?view=code', { waitUntil: 'domcontentloaded' });
      await settledIdentity(page);
      await expect(page.locator('#view-code')).toBeVisible();
      await expect(page.locator('body')).toHaveAttribute('data-surface', 'solo');
      await expectVisitorChrome(page);
      const prompt = page.getByTestId('solo-practice-bar');
      await expect(prompt).toBeVisible();
      await expect(prompt).toContainText('Exercises and test runs are for circle members.');
      // Pair-only controls do nothing without an account.
      await expect(page.locator('#vidJoinBtn')).toBeHidden();
      await expect(page.locator('#roleToggle')).toBeHidden();
      await page.locator('#soloSignIn').click();
      await expect(page.getByRole('dialog', { name: 'Sign in to Randori' })).toBeVisible();
      const results = await new AxeBuilder({ page })
        .include('#soloPracticeBar')
        .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22a', 'wcag22aa'])
        .analyze();
      expect(results.violations).toEqual([]);
    });
  });
}

test('a member deep link asks a visitor to sign in, then opens that view', async ({ page }) => {
  let signedIn = false;
  await mockApi(page, {
    '/api/auth/capabilities': capabilities,
    '/api/auth/me': () => signedIn ? { ok: true, user: member } : { _status: 401, ok: false, error: 'authentication required' },
    '/api/auth/login': () => { signedIn = true; return { ok: true, user: member }; },
    '/api/profile': { ok: true, user: member },
  });
  await resetClientState(page);
  await page.goto('/?view=pair', { waitUntil: 'domcontentloaded' });
  await settledIdentity(page);
  const dialog = page.getByRole('dialog', { name: 'Sign in to continue' });
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText('Sign in to open Pairing.');
  await expectVisitorChrome(page);
  await expect(page.locator('#view-pair')).toBeHidden();

  await page.locator('#authEmail').fill('nav@example.test');
  await page.locator('#authPass').fill('correct password');
  await page.locator('#authSignin').click();
  await expect(dialog).toBeHidden();
  await expect(page.locator('#view-pair')).toBeVisible();
  await expect(page.locator('body')).toHaveAttribute('data-nav', 'shown');
  await expect(primaryNavigation(page)).toBeVisible();
  await expect(page.locator('#tab-pair')).toHaveClass(/active/);
});

test('a returning member gets a neutral loading view, not the visitor landing page, while identity loads', async ({ page }) => {
  let releaseMe: (() => void) | undefined;
  const meGate = new Promise<void>(resolve => { releaseMe = resolve; });
  await mockApi(page, {
    '/api/auth/me': async () => { await meGate; return { ok: true, user: member }; },
    '/api/profile': { ok: true, user: member },
  });
  // A returning member: this browser has seen the account before.
  await resetClientState(page, true);
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await expect(page.locator('#view-boot')).toBeVisible();
  await expect(page.locator('#view-landing')).toBeHidden();
  // Their navigation stays usable while the check runs (see
  // ui-shell-accessibility's early-navigation tests).
  await expect(page.locator('body')).toHaveAttribute('data-returning', 'true');
  await expect(primaryNavigation(page)).toBeVisible();

  releaseMe?.();
  await expect(page.locator('#view-dashboard')).toBeVisible();
  await expect(page.locator('#view-boot')).toBeHidden();
  await expect(primaryNavigation(page)).toBeVisible();
});

test('a visitor sees the landing page and no member tabs while the identity check runs', async ({ page }) => {
  let releaseMe: (() => void) | undefined;
  const meGate = new Promise<void>(resolve => { releaseMe = resolve; });
  await mockApi(page, {
    '/api/auth/me': async () => { await meGate; return { _status: 401, ok: false, error: 'authentication required' }; },
  });
  await resetClientState(page);
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await expect(page.locator('#view-landing')).toBeVisible();
  await expect(page.locator('body')).toHaveAttribute('data-identity', 'pending');
  await expect(page.locator('body')).toHaveAttribute('data-nav', 'hidden');
  await expect(primaryNavigation(page)).toBeHidden();
  releaseMe?.();
  await settledIdentity(page);
  await expectVisitorChrome(page);
});

test('members keep the navigation, and it disappears as soon as they sign out', async ({ page }) => {
  let signedIn = true;
  await mockApi(page, {
    '/api/auth/me': () => signedIn ? { ok: true, user: member } : { _status: 401, ok: false, error: 'authentication required' },
    '/api/profile': { ok: true, user: member },
    '/api/auth/logout': () => { signedIn = false; return { ok: true }; },
  });
  await resetClientState(page, true, {}, true);
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await expect(page.locator('#view-dashboard')).toBeVisible();
  await expect(page.locator('body')).toHaveAttribute('data-nav', 'shown');
  const navigation = primaryNavigation(page);
  await expect(navigation).toBeVisible();
  for (const id of ['tab-home', 'tab-circle', 'tab-pair', 'tab-code', 'tab-board', 'tab-history']) {
    await expect(page.locator(`#${id}`)).toBeVisible();
  }

  await page.locator('#meLabel').click();
  await page.getByRole('menuitem', { name: 'Sign out', exact: true }).click();
  await expect(page.locator('#authBtn')).toBeVisible();
  await expect(page.locator('#view-landing')).toBeVisible();
  await expectVisitorChrome(page);
});
