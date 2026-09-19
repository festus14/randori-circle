import { expect, Page, test } from '@playwright/test';
import { mockApi, resetClientState } from './helpers';

const user = {
  id: 1,
  email: 'ui@example.test',
  name: 'UI Tester',
  display_name: 'UI Tester',
  color: '#c8f6a0',
  is_admin: false,
  is_demo: false,
  bio: 'Practising clear explanations.',
  tz: 'Europe/London',
  interview_focus: 'both',
};

async function openLanding(page: Page) {
  await mockApi(page);
  await resetClientState(page, false, { 'randori-theme': 'dark' });
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await expect(page.locator('#view-landing')).toBeVisible();
}

async function themeContrast(page: Page) {
  return page.evaluate(() => {
    const root = getComputedStyle(document.documentElement);
    const hex = (name: string) => root.getPropertyValue(name).trim();
    const luminance = (value: string) => {
      const match = /^#([0-9a-f]{6})$/i.exec(value);
      if (!match) throw new Error(`Expected a six-digit color for ${value}`);
      const channels = [0, 2, 4].map(offset => Number.parseInt(match[1].slice(offset, offset + 2), 16) / 255)
        .map(channel => channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4);
      return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
    };
    const ratio = (foreground: string, background: string) => {
      const values = [luminance(foreground), luminance(background)].sort((a, b) => b - a);
      return (values[0] + 0.05) / (values[1] + 0.05);
    };
    return {
      secondaryOnPage: ratio(hex('--ink-2'), hex('--bg')),
      mutedOnPage: ratio(hex('--ink-3'), hex('--bg')),
      secondaryOnCard: ratio(hex('--ink-2'), hex('--card')),
      mutedOnCard: ratio(hex('--ink-3'), hex('--card')),
    };
  });
}

test('the polished shell exposes landmarks, current navigation, skip focus, and AA text tokens', async ({ page }) => {
  await openLanding(page);

  await expect(page.getByRole('banner')).toBeVisible();
  const navigation = page.getByRole('navigation', { name: 'Practice areas' });
  await expect(navigation).toBeVisible();
  await expect(page.getByRole('main')).toBeVisible();
  await expect(page.locator('#themeToggle')).toHaveAttribute('aria-label', 'Dark color theme; switch to light');
  const cycleProgress = page.getByRole('progressbar', { name: 'Weekly cycle progress toward the next pairing run' });
  await expect(cycleProgress).toHaveAttribute('aria-valuenow', '0');
  await expect(cycleProgress).toHaveAttribute('aria-valuetext', 'Schedule unavailable');

  const skip = page.getByRole('link', { name: 'Skip to main content' });
  await skip.focus();
  await expect(skip).toBeFocused();
  await expect.poll(async () => (await skip.boundingBox())?.y || 0).toBeGreaterThanOrEqual(0);
  await skip.press('Enter');
  await expect(page.locator('#appMain')).toBeFocused();

  const pairing = navigation.getByRole('button', { name: /Pairing/ });
  await pairing.click();
  await expect(pairing).toHaveAttribute('aria-current', 'page');
  await expect(navigation.locator('[aria-current="page"]')).toHaveCount(1);

  for (const ratio of Object.values(await themeContrast(page))) expect(ratio).toBeGreaterThanOrEqual(4.5);
  await page.locator('#themeToggle').click();
  await expect(page.locator('html')).toHaveClass(/light/);
  await expect(page.locator('#themeToggle')).toHaveAttribute('aria-label', 'Light color theme; switch to dark');
  for (const ratio of Object.values(await themeContrast(page))) expect(ratio).toBeGreaterThanOrEqual(4.5);

  await page.locator('#authBtn').click();
  await page.locator('#authErr').evaluate(element => { element.textContent = 'Readable error'; });
  const errorContrast = await page.locator('#authErr').evaluate(element => {
    const channel = (value: number) => {
      const normalized = value > 1 ? value / 255 : value;
      return normalized <= 0.04045 ? normalized / 12.92 : ((normalized + 0.055) / 1.055) ** 2.4;
    };
    const luminance = (value: string) => {
      const channels = value.match(/[\d.]+/g)?.slice(0, 3).map(Number) || [];
      if (channels.length !== 3) throw new Error(`Expected an RGB color for ${value}`);
      return 0.2126 * channel(channels[0]) + 0.7152 * channel(channels[1]) + 0.0722 * channel(channels[2]);
    };
    const foreground = luminance(getComputedStyle(element).color);
    const background = luminance(getComputedStyle(element).backgroundColor);
    return (Math.max(foreground, background) + 0.05) / (Math.min(foreground, background) + 0.05);
  });
  expect(errorContrast).toBeGreaterThanOrEqual(4.5);
});

test('the landing and authentication flow remain focused and overflow-free on a narrow phone', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await openLanding(page);

  expect(await page.evaluate(() => ({
    viewport: document.documentElement.clientWidth,
    content: document.documentElement.scrollWidth,
  }))).toEqual({ viewport: 390, content: 390 });

  const join = page.locator('#landingSignup');
  const signIn = page.locator('#landingSignin');
  const [joinBox, signInBox] = await Promise.all([join.boundingBox(), signIn.boundingBox()]);
  expect(joinBox?.height).toBeGreaterThanOrEqual(48);
  expect(signInBox?.height).toBeGreaterThanOrEqual(48);
  expect(Math.abs((joinBox?.width || 0) - (signInBox?.width || 0))).toBeLessThan(2);

  const tabs = page.getByRole('navigation', { name: 'Practice areas' });
  expect(await tabs.evaluate(element => getComputedStyle(element).flexWrap)).toBe('nowrap');
  for (const tab of await tabs.getByRole('button').all()) {
    expect((await tab.boundingBox())?.height).toBeGreaterThanOrEqual(44);
  }

  await signIn.click();
  const dialog = page.getByRole('dialog', { name: 'Sign in to Randori' });
  await expect(dialog).toBeVisible();
  const dialogBox = await dialog.boundingBox();
  expect(dialogBox?.width).toBe(390);
  expect(Math.abs((dialogBox?.y || 0) + (dialogBox?.height || 0) - 844)).toBeLessThanOrEqual(1);
  const email = dialog.getByRole('textbox', { name: 'Email' });
  await expect(email).toBeVisible();
  expect((await email.boundingBox())?.height).toBeGreaterThanOrEqual(46);

  await email.focus();
  const focusStyle = await email.evaluate(element => ({
    outlineWidth: getComputedStyle(element).outlineWidth,
    boxShadow: getComputedStyle(element).boxShadow,
  }));
  expect(focusStyle.outlineWidth === '3px' || focusStyle.boxShadow !== 'none').toBe(true);
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  await expect(signIn).toBeFocused();

  await page.setViewportSize({ width: 320, height: 700 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(320);
});

test('dashboard summary cards stack on mobile and the account menu is keyboard complete', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await mockApi(page, {
    '/api/auth/me': { ok: true, user },
    '/api/profile': { ok: true, user },
    '/api/circle': {
      ok: true,
      circle_meta: { id: 1, public_id: 'circle_ui', name: 'UI Circle' },
      membership: { role: 'member' },
      circle: [user],
      count: 1,
    },
    '/api/my-pair': { ok: true, paired: false, reason: 'no_week_yet' },
  });
  await resetClientState(page, true, { 'randori-theme': 'dark' });
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await expect(page.locator('#view-dashboard')).toBeVisible();

  const summary = page.getByRole('list', { name: 'Practice summary' });
  await expect(summary.getByRole('listitem')).toHaveCount(3);
  expect(await summary.evaluate(element => getComputedStyle(element).gridTemplateColumns.split(' ').length)).toBe(1);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(390);

  const account = page.locator('#meLabel');
  await expect(account).toBeVisible();
  await account.focus();
  await account.press('ArrowDown');
  await expect(account).toHaveAttribute('aria-expanded', 'true');
  await expect(page.locator('#meSignOut')).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(account).toHaveAttribute('aria-expanded', 'false');
  await expect(account).toBeFocused();
});
