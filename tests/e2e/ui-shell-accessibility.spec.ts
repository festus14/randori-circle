import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Locator, type Page, type TestInfo } from '@playwright/test';
import { mockApi, resetClientState } from './helpers';

const member = {
  id: 1,
  email: 'member@example.test',
  name: 'Keyboard Member',
  display_name: 'Keyboard Member',
  color: '#c8f6a0',
  is_admin: false,
  is_available: true,
  tz: 'Europe/London',
  interview_focus: 'both',
};

async function expectInsideViewport(locator: Locator, width: number) {
  const bounds = await locator.boundingBox();
  expect(bounds, `${await locator.getAttribute('id') || 'element'} must render`).not.toBeNull();
  expect(bounds!.width).toBeGreaterThan(0);
  expect(bounds!.height).toBeGreaterThan(0);
  expect(bounds!.x).toBeGreaterThanOrEqual(-0.5);
  expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(width + 0.5);
}

async function expectDocumentFitsViewport(page: Page) {
  const dimensions = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    innerWidth: window.innerWidth,
  }));
  expect(dimensions.scrollWidth).toBeLessThanOrEqual(dimensions.innerWidth);
}

async function expectWcagClean(page: Page, testInfo: TestInfo, name: string, scope: string) {
  const results = await new AxeBuilder({ page })
    .include(scope)
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
    .analyze();
  await testInfo.attach(`${name}-axe-incomplete`, {
    body: Buffer.from(JSON.stringify(results.incomplete, null, 2)),
    contentType: 'application/json',
  });
  expect(results.violations, `${name} WCAG violations`).toEqual([]);
}

async function attachUiScreenshot(page: Page, testInfo: TestInfo, name: string) {
  await testInfo.attach(name, {
    body: await page.screenshot({ fullPage: true }),
    contentType: 'image/png',
  });
}

async function renderedStatusContrast(page: Page) {
  return page.evaluate(() => {
    const host = document.createElement('div');
    host.id = 'contrast-probes';
    host.style.cssText = 'position:fixed;left:0;top:0;z-index:200;background:var(--card);padding:4px';
    host.innerHTML = [
      '<span class="kbd status-chip">information</span>',
      '<span class="kbd status-chip status-success">success</span>',
      '<span class="kbd status-chip status-warning">warning</span>',
      '<span class="kbd status-chip status-danger">danger</span>',
      '<span class="muted">secondary copy</span>',
    ].join('');
    document.body.append(host);
    const parse = (color: string) => color.match(/[\d.]+/g)!.slice(0, 3).map(value => Number(value) / 255);
    const luminance = (color: string) => {
      const [red, green, blue] = parse(color).map(value => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4);
      return (0.2126 * red) + (0.7152 * green) + (0.0722 * blue);
    };
    const ratio = (element: Element) => {
      const styles = getComputedStyle(element);
      const background = styles.backgroundColor === 'rgba(0, 0, 0, 0)'
        ? getComputedStyle(host).backgroundColor : styles.backgroundColor;
      const values = [luminance(styles.color), luminance(background)].sort((a, b) => b - a);
      return (values[0] + 0.05) / (values[1] + 0.05);
    };
    const ratios = [...host.children].map(ratio);
    host.remove();
    return ratios;
  });
}

async function renderedControlBoundary(locator: Locator) {
  return locator.evaluate(element => {
    const parse = (color: string) => color.match(/[\d.]+/g)!.slice(0, 3).map(value => Number(value) / 255);
    const luminance = (color: string) => {
      const [red, green, blue] = parse(color).map(value => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4);
      return (0.2126 * red) + (0.7152 * green) + (0.0722 * blue);
    };
    const contrast = (left: string, right: string) => {
      const values = [luminance(left), luminance(right)].sort((a, b) => b - a);
      return (values[0] + 0.05) / (values[1] + 0.05);
    };
    const styles = getComputedStyle(element);
    let ancestor = element.parentElement;
    let surrounding = 'rgba(0, 0, 0, 0)';
    while (ancestor && surrounding === 'rgba(0, 0, 0, 0)') {
      surrounding = getComputedStyle(ancestor).backgroundColor;
      ancestor = ancestor.parentElement;
    }
    return {
      borderWidth: Number.parseFloat(styles.borderTopWidth),
      interiorRatio: contrast(styles.borderTopColor, styles.backgroundColor),
      exteriorRatio: contrast(styles.borderTopColor, surrounding),
    };
  });
}

test('anonymous shell has landmarks, truthful copy, AA themes, and reduced motion', async ({ page }, testInfo) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await mockApi(page);
  await resetClientState(page);
  await page.goto('/', { waitUntil: 'domcontentloaded' });

  await expect(page.locator('header.topbar')).toBeVisible();
  const navigation = page.getByRole('navigation', { name: 'Primary navigation' });
  await expect(navigation).toBeAttached();
  await expect(navigation.getByRole('group', { name: 'Application views' })).toBeAttached();
  await expect(navigation.getByRole('tablist')).toHaveCount(0);
  await expect(page.locator('main#appMain')).toBeVisible();
  await expect(page.locator('#view-landing')).toBeVisible();
  await expect(page.getByRole('progressbar', { name: 'Time elapsed in the weekly pairing cycle' })).toHaveAttribute('aria-valuenow', /\d+/);
  await expect(page.locator('#landingSignup')).toHaveText('Use an invitation');
  await expect(page.locator('#view-landing')).toContainText('Invite-only private beta');
  await expect(page.locator('#view-landing')).toContainText('Private by default');
  await expect(page.locator('#landingStats')).toHaveAttribute('data-state', 'ready');
  await expect(page.locator('#landingStatsUpdated')).toHaveText('Updated just now');
  await expect(page.locator('#questionPanel')).toContainText('Approved original exercise catalogue');
  await expect(page.locator('#copyLinkBtn')).toHaveCount(0);
  await expect(page.locator('#vidScreenBtn')).toHaveCount(0);
  await expect(page.locator('#psRemindSms')).toHaveCount(0);

  await page.locator('.skip-link').focus();
  await expect(page.locator('.skip-link')).toBeVisible();
  await page.keyboard.press('Enter');
  await expect(page.locator('#appMain')).toBeFocused();

  const motionProbe = page.locator('.motion-probe');
  await expect(motionProbe).toBeAttached();
  const reducedMotion = await motionProbe.evaluate(element => {
    const styles = getComputedStyle(element);
    return { name: styles.animationName, duration: styles.animationDuration };
  });
  const durationMs = reducedMotion.duration.endsWith('ms')
    ? Number.parseFloat(reducedMotion.duration)
    : Number.parseFloat(reducedMotion.duration) * 1000;
  expect(reducedMotion.name === 'none' || durationMs <= 0.01).toBe(true);

  const darkRatios = await renderedStatusContrast(page);
  expect(Math.min(...darkRatios)).toBeGreaterThanOrEqual(4.5);
  await page.locator('#landingSignin').click();
  const authEmail = page.locator('#authEmail');
  const authPassword = page.locator('#authPass');
  await expect(authPassword).toBeVisible();
  for (const control of [authEmail, authPassword]) {
    const boundary = await renderedControlBoundary(control);
    expect(boundary.borderWidth).toBeGreaterThanOrEqual(1);
    expect(boundary.interiorRatio).toBeGreaterThanOrEqual(3);
    expect(boundary.exteriorRatio).toBeGreaterThanOrEqual(3);
  }
  await expectWcagClean(page, testInfo, 'signin-dialog', '#authDialog');
  await page.keyboard.press('Escape');
  await page.locator('#themeToggle').click();
  await expect(page.locator('html')).toHaveClass(/light/);
  const lightRatios = await renderedStatusContrast(page);
  expect(Math.min(...lightRatios)).toBeGreaterThanOrEqual(4.5);
  await page.locator('#landingSignin').click();
  await expect(authPassword).toBeVisible();
  for (const control of [authEmail, authPassword]) {
    const boundary = await renderedControlBoundary(control);
    expect(boundary.borderWidth).toBeGreaterThanOrEqual(1);
    expect(boundary.interiorRatio).toBeGreaterThanOrEqual(3);
    expect(boundary.exteriorRatio).toBeGreaterThanOrEqual(3);
  }
  await page.keyboard.press('Escape');
  await expectWcagClean(page, testInfo, 'anonymous-landing', '#view-landing');
});

test('account menu starts at the first visible enabled action and supports keyboard navigation', async ({ page }) => {
  await mockApi(page, {
    '/api/auth/capabilities': {
      ok: true,
      capabilities: {
        passwordLogin: true,
        passwordSignup: false,
        googleOAuth: true,
        identityManagement: true,
      },
      registrationMode: 'private_beta',
    },
    '/api/auth/me': { ok: true, user: member },
    '/api/auth/identities': {
      ok: true,
      identity: {
        accountEmail: member.email,
        password: { linked: true, canAdd: false, canUnlink: true },
        google: { linked: true, canLink: false, canUnlink: true },
        recentAuth: { ok: true, method: 'password', authenticatedAt: 1, expiresAt: 2 },
      },
    },
  });
  await resetClientState(page, true);
  await page.goto('/', { waitUntil: 'domcontentloaded' });

  const trigger = page.locator('#meLabel');
  await expect(trigger).toBeVisible();
  await trigger.focus();
  await page.keyboard.press('ArrowDown');
  await expect(page.getByRole('menu')).toBeVisible();
  await expect(page.getByRole('menuitem', { name: 'Account security' })).toBeFocused();
  await page.keyboard.press('ArrowDown');
  await expect(page.getByRole('menuitem', { name: 'Sign out', exact: true })).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(trigger).toBeFocused();
  await expect(trigger).toHaveAttribute('aria-expanded', 'false');

  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Enter');
  await expect(page.getByRole('dialog', { name: 'Account security' })).toBeVisible();
  await expect(trigger).toHaveAttribute('aria-expanded', 'false');
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog', { name: 'Account security' })).toBeHidden();
  await expect(trigger).toBeVisible();
  await expect(trigger).toBeFocused();
  await expect(trigger).toHaveAttribute('aria-expanded', 'false');

  await page.keyboard.press('ArrowDown');
  await expect(page.getByRole('menu')).toBeVisible();
  await page.locator('#themeToggle').click();
  await expect(page.getByRole('menu')).toBeHidden();
  await expect(page.locator('#themeToggle')).toBeFocused();
});

test('view navigation is tabbable and arrow activation shows the matching panel', async ({ page }) => {
  await mockApi(page, {
    '/api/auth/me': { ok: true, user: member },
    '/api/profile': { ok: true, user: member },
  });
  await resetClientState(page, true);
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await expect(page.locator('#view-dashboard')).toBeVisible();

  const navigation = page.getByRole('navigation', { name: 'Primary navigation' });
  const circle = navigation.getByRole('button', { name: /Circle/ });
  const pairing = navigation.getByRole('button', { name: 'Pairing' });
  await expect(circle).toHaveAttribute('aria-controls', 'view-circle');
  await expect(pairing).toHaveAttribute('aria-controls', 'view-pair');
  await circle.focus();
  await page.keyboard.press('Tab');
  await expect(pairing).toBeFocused();
  await page.keyboard.press('Shift+Tab');
  await expect(circle).toBeFocused();
  await page.keyboard.press('ArrowRight');
  await expect(pairing).toBeFocused();
  await expect(pairing).toHaveAttribute('aria-current', 'page');
  await expect(navigation.locator('[aria-current="page"]:visible')).toHaveCount(1);
  const view = await pairing.getAttribute('data-tab');
  expect(view).toBe('pair');
  await expect(page.locator(`#view-${view}`)).toBeVisible();
  await expect(page.locator('#view-circle')).toBeHidden();
  const history = navigation.getByRole('button', { name: 'History' });
  await history.focus();
  await page.keyboard.press('Tab');
  const pairingView = page.locator('#view-pair');
  await expect(pairingView).toBeFocused();
  const focusStyle = await pairingView.evaluate(element => {
    const style = getComputedStyle(element);
    return { style: style.outlineStyle, width: Number.parseFloat(style.outlineWidth) };
  });
  expect(focusStyle.style).not.toBe('none');
  expect(focusStyle.width).toBeGreaterThanOrEqual(3);
});

test('an explicit early pointer navigation survives initial identity hydration', async ({ page }) => {
  let markAuthStarted!: () => void;
  let releaseAuth!: () => void;
  const authStarted = new Promise<void>(resolve => { markAuthStarted = resolve; });
  const authGate = new Promise<void>(resolve => { releaseAuth = resolve; });
  await mockApi(page, {
    '/api/auth/me': async () => {
      markAuthStarted();
      await authGate;
      return { ok: true, user: member };
    },
    '/api/profile': { ok: true, user: member },
  });
  await resetClientState(page, true);
  await page.goto('/', { waitUntil: 'domcontentloaded' });

  await authStarted;
  const pairing = page.locator('[data-tab="pair"]');
  await pairing.click();
  await expect(page.locator('#view-pair')).toBeVisible();
  releaseAuth();
  await expect(page.locator('#view-pair')).toBeVisible();
  await expect(page.locator('#view-dashboard')).toBeHidden();
  await expect(pairing).toHaveAttribute('aria-current', 'page');
});

test('an explicit early keyboard navigation survives initial identity hydration', async ({ page }) => {
  let markAuthStarted!: () => void;
  let releaseAuth!: () => void;
  const authStarted = new Promise<void>(resolve => { markAuthStarted = resolve; });
  const authGate = new Promise<void>(resolve => { releaseAuth = resolve; });
  await mockApi(page, {
    '/api/auth/me': async () => {
      markAuthStarted();
      await authGate;
      return { ok: true, user: member };
    },
    '/api/profile': { ok: true, user: member },
  });
  await resetClientState(page, true);
  await page.goto('/', { waitUntil: 'domcontentloaded' });

  await authStarted;
  const pairing = page.locator('[data-tab="pair"]');
  const code = page.locator('[data-tab="code"]');
  await pairing.focus();
  await page.keyboard.press('ArrowRight');
  await expect(page.locator('#view-code')).toBeVisible();
  releaseAuth();
  await expect(page.locator('#view-code')).toBeVisible();
  await expect(page.locator('#view-dashboard')).toBeHidden();
  await expect(code).toHaveAttribute('aria-current', 'page');
});

test('shell and authentication remain inside 320px, 390px, and 640px viewports', async ({ page }, testInfo) => {
  await mockApi(page, {
    '/api/auth/capabilities': {
      ok: true,
      capabilities: { passwordLogin: true, passwordSignup: true, googleOAuth: false },
      registrationMode: 'local_open',
    },
  });
  await resetClientState(page);

  for (const width of [320, 390, 640]) {
    await page.setViewportSize({ width, height: 720 });
    await page.goto('/', { waitUntil: 'domcontentloaded' });
    await expect(page.locator('#view-landing')).toBeVisible();
    await expect(page.locator('#landingSignup')).toHaveText('Create an account');
    await expectInsideViewport(page.locator('header.topbar'), width);
    await expectInsideViewport(page.locator('.tabs'), width);
    await expectInsideViewport(page.locator('main#appMain'), width);
    await expectInsideViewport(page.locator('#view-landing .hero'), width);
    await expectDocumentFitsViewport(page);
    if (width === 390) await attachUiScreenshot(page, testInfo, 'anonymous-landing-390');
    await page.locator('#landingSignin').click();
    const dialog = page.getByRole('dialog', { name: 'Sign in to Randori' });
    await expect(dialog).toBeVisible();
    await expectInsideViewport(page.locator('#authOverlay'), width);
    await expectInsideViewport(dialog, width);
    await expectDocumentFitsViewport(page);
    await page.keyboard.press('Escape');
  }
});

test('signed-in dashboard, navigation, panels, and account menu fit mobile viewports', async ({ page }, testInfo) => {
  await mockApi(page, {
    '/api/auth/me': { ok: true, user: member },
    '/api/profile': { ok: true, user: member },
  });
  await resetClientState(page, true, {}, true);

  for (const width of [320, 390, 640]) {
    await page.setViewportSize({ width, height: 760 });
    await page.goto('/', { waitUntil: 'domcontentloaded' });
    await expect(page.locator('#view-dashboard')).toBeVisible();
    await expectInsideViewport(page.locator('header.topbar'), width);
    await expectInsideViewport(page.locator('.tabs'), width);
    await expectInsideViewport(page.locator('main#appMain'), width);
    await expectInsideViewport(page.locator('#view-dashboard'), width);
    await expectInsideViewport(page.locator('#dashStatsGrid'), width);
    await expectDocumentFitsViewport(page);
    if (width === 390) await attachUiScreenshot(page, testInfo, 'signed-in-dashboard-390');

    const trigger = page.locator('#meLabel');
    await trigger.click();
    const menu = page.getByRole('menu', { name: 'Account' });
    await expect(menu).toBeVisible();
    await expectInsideViewport(menu, width);
    await expectDocumentFitsViewport(page);
    await trigger.click();
  }
});

test('settled signed-in pairing view has no WCAG-tagged axe violations', async ({ page }, testInfo) => {
  await mockApi(page, {
    '/api/auth/me': { ok: true, user: member },
    '/api/profile': { ok: true, user: member },
  });
  await resetClientState(page, true);
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await page.locator('[data-tab="pair"]').click();
  await expect(page.locator('#availabilityWrap')).toHaveAttribute('aria-busy', 'false');
  await expect(page.locator('#syncStatus')).toHaveAttribute('data-state', /ready|local/);
  await expectWcagClean(page, testInfo, 'signed-in-pairing', '#view-pair');
});

test('landing and reminder controls report request outcomes without delivery promises', async ({ page }) => {
  let preferenceSave = 0;
  await mockApi(page, {
    '/api/stats': { _status: 503, ok: false, error: 'stats unavailable' },
  });
  await resetClientState(page);
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await expect(page.locator('#landingStats')).toHaveAttribute('data-state', 'unavailable');
  await expect(page.locator('#landingStatsUpdated')).toHaveText(/Summary unavailable/);
  await expect(page.locator('#landingNextBar')).toHaveAttribute('aria-valuetext', 'Pairing schedule unavailable');

  await page.unroute('**/api/**');
  await mockApi(page, {
    '/api/auth/me': { ok: true, user: member },
    '/api/profile': { ok: true, user: { ...member, tz: '' } },
    '/api/notifications/prefs': request => {
      if (request.method() === 'GET') {
        return { ok: true, prefs: { user_id: 1, email_enabled: true } };
      }
      preferenceSave += 1;
      if (preferenceSave === 1) {
        return { ok: true, prefs: { user_id: 1, email_enabled: false } };
      }
      return { _status: 503, ok: false, error: 'notification preferences unavailable' };
    },
  });
  await resetClientState(page, true, { 'randori-profile-done': '' });
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await expect(page.locator('#view-profile-setup')).toBeVisible();
  const reminder = page.locator('#psRemindEmail');
  const reminderStatus = page.locator('#psRemindStatus');
  await expect(reminderStatus).toHaveAttribute('data-state', 'ready');
  await reminder.uncheck();
  await expect(reminderStatus).toHaveAttribute('data-state', 'saved');
  await expect(reminderStatus).toHaveText('Preference saved. Email reminders are off.');
  await reminder.check();
  await expect(reminderStatus).toHaveAttribute('data-state', 'error');
  await expect(reminderStatus).toContainText('Could not save to your account');
});

test('a delayed landing summary cannot replace the result of a newer home request', async ({ page }) => {
  let initialStatsCalls = 0;
  await mockApi(page, {
    '/api/stats': () => {
      initialStatsCalls += 1;
      return { ok: true, total_users: 1, total_weeks: 1, total_pairs: 1, total_sessions: 1 };
    },
  });
  await resetClientState(page);
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await expect.poll(() => initialStatsCalls).toBeGreaterThanOrEqual(2);
  await expect(page.locator('#landingStats')).toHaveAttribute('data-state', 'ready');

  let releaseOld!: () => void;
  let markOldStarted!: () => void;
  const oldGate = new Promise<void>(resolve => { releaseOld = resolve; });
  const oldStarted = new Promise<void>(resolve => { markOldStarted = resolve; });
  let request = 0;
  await page.route('**/api/stats*', async route => {
    request += 1;
    if (request === 1) {
      markOldStarted();
      await oldGate;
      await route.fulfill({
        status: 200,
        headers: { 'x-ui-generation': 'old' },
        contentType: 'application/json',
        body: JSON.stringify({ ok: true, total_users: 99, total_weeks: 99, total_pairs: 99, total_sessions: 99 }),
      });
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ ok: true, total_users: 2, total_weeks: 2, total_pairs: 2, total_sessions: 2 }),
    });
  });

  await page.evaluate(() => { void (window as any)._randori_home.bootHome(); });
  await oldStarted;
  await page.evaluate(() => (window as any)._randori_home.bootHome());
  await expect(page.locator('#statMembers')).toHaveText('2');
  const oldResponse = page.waitForResponse(response => response.headers()['x-ui-generation'] === 'old');
  releaseOld();
  await oldResponse;
  await expect(page.locator('#statMembers')).toHaveText('2');
  await expect(page.locator('#landingStats')).toHaveAttribute('data-state', 'ready');
});

test('a delayed account summary cannot cross an authenticated identity change', async ({ page }) => {
  const secondMember = { ...member, id: 2, email: 'second@example.test', name: 'Second Member' };
  let actor = member;
  let initialStatsCalls = 0;
  await mockApi(page, {
    '/api/auth/me': () => ({ ok: true, user: actor }),
    '/api/profile': { ok: true, user: member },
    '/api/stats': () => {
      initialStatsCalls += 1;
      return { ok: true, your_sessions: 1, your_weeks: 1, total_users: 2, total_weeks: 1, total_sessions: 1 };
    },
  });
  await resetClientState(page, true);
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await expect(page.locator('#view-dashboard')).toBeVisible();
  await expect.poll(() => initialStatsCalls).toBeGreaterThanOrEqual(2);

  let releaseFirst!: () => void;
  let markFirstStarted!: () => void;
  const firstGate = new Promise<void>(resolve => { releaseFirst = resolve; });
  const firstStarted = new Promise<void>(resolve => { markFirstStarted = resolve; });
  let request = 0;
  await page.route('**/api/stats*', async route => {
    request += 1;
    if (request === 1) {
      markFirstStarted();
      await firstGate;
      await route.fulfill({
        status: 200,
        headers: { 'x-ui-generation': 'first-account' },
        contentType: 'application/json',
        body: JSON.stringify({ ok: true, your_sessions: 99, your_weeks: 99, total_users: 99, total_weeks: 99, total_sessions: 99 }),
      });
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ ok: true, your_sessions: 2, your_weeks: 2, total_users: 2, total_weeks: 2, total_sessions: 2 }),
    });
  });

  await page.evaluate(() => { void (window as any)._randori_home.bootHome(); });
  await firstStarted;
  actor = secondMember;
  await page.evaluate(() => (window as any)._randori_auth.refreshMe());
  await page.evaluate(() => (window as any)._randori_home.bootHome());
  await expect(page.locator('#dashStatYou')).toHaveText('2');
  const oldResponse = page.waitForResponse(response => response.headers()['x-ui-generation'] === 'first-account');
  releaseFirst();
  await oldResponse;
  await expect(page.locator('#dashStatYou')).toHaveText('2');
  await expect(page.locator('#dashWelcome')).toContainText('Second Member');
});

for (const invalid of [
  {
    label: 'malformed',
    envelope: { ok: true, prefs: { user_id: member.id, email_enabled: 'yes' } },
  },
  {
    label: 'wrong-account',
    envelope: { ok: true, prefs: { user_id: member.id + 1, email_enabled: false } },
  },
  {
    label: 'ok-false',
    envelope: { ok: false, prefs: { user_id: member.id, email_enabled: false } },
  },
] as const) {
  test(`${invalid.label} reminder preference envelopes never report ready or saved`, async ({ page }) => {
    let returnValidGet = false;
    let preferencePosts = 0;
    await mockApi(page, {
      '/api/auth/me': { ok: true, user: member },
      '/api/profile': { ok: true, user: { ...member, tz: '' } },
      '/api/notifications/prefs': request => {
        if (request.method() === 'GET') {
          return returnValidGet
            ? { ok: true, prefs: { user_id: member.id, email_enabled: true } }
            : invalid.envelope;
        }
        preferencePosts += 1;
        return invalid.envelope;
      },
    });
    await resetClientState(page, true, { 'randori-profile-done': '' });
    await page.goto('/', { waitUntil: 'domcontentloaded' });
    await expect(page.locator('#view-profile-setup')).toBeVisible();
    const reminder = page.locator('#psRemindEmail');
    const status = page.locator('#psRemindStatus');
    await expect(status).toHaveAttribute('data-state', 'error');
    await expect(status).toContainText('unavailable');
    expect(await page.evaluate(() => localStorage.getItem('randori-reminder-email'))).toBeNull();

    returnValidGet = true;
    await page.evaluate(() => window.dispatchEvent(new Event('randori:auth-refreshed')));
    await expect(status).toHaveAttribute('data-state', 'ready');
    await reminder.uncheck();
    await expect.poll(() => preferencePosts).toBe(1);
    await expect(status).toHaveAttribute('data-state', 'error');
    await expect(status).toContainText('Could not save to your account');
  });
}

test('a reminder save revalidates identity and cannot mutate a newly authenticated account', async ({ page }) => {
  const secondMember = { ...member, id: 2, email: 'second@example.test', name: 'Second Member' };
  let actor = member;
  let holdIdentityRefresh = false;
  let markIdentityRefreshStarted!: () => void;
  let releaseIdentityRefresh!: () => void;
  const identityRefreshStarted = new Promise<void>(resolve => { markIdentityRefreshStarted = resolve; });
  const identityRefreshGate = new Promise<void>(resolve => { releaseIdentityRefresh = resolve; });
  const preferenceGets: number[] = [];
  let preferencePosts = 0;
  await mockApi(page, {
    '/api/auth/me': async () => {
      if (holdIdentityRefresh) {
        holdIdentityRefresh = false;
        markIdentityRefreshStarted();
        await identityRefreshGate;
      }
      return { ok: true, user: actor };
    },
    '/api/profile': () => ({ ok: true, user: { ...actor, tz: '' } }),
    '/api/notifications/prefs': request => {
      if (request.method() === 'GET') {
        preferenceGets.push(actor.id);
        return { ok: true, prefs: { user_id: actor.id, email_enabled: true } };
      }
      preferencePosts += 1;
      return { ok: true, prefs: { user_id: actor.id, email_enabled: false } };
    },
  });
  try {
    await resetClientState(page, true, { 'randori-profile-done': '' });
    await page.goto('/', { waitUntil: 'domcontentloaded' });
    await expect(page.locator('#view-profile-setup')).toBeVisible();
    const reminder = page.locator('#psRemindEmail');
    const status = page.locator('#psRemindStatus');
    await expect(status).toHaveAttribute('data-state', 'ready');
    await expect(reminder).toBeChecked();

    holdIdentityRefresh = true;
    await reminder.uncheck();
    await identityRefreshStarted;
    actor = secondMember;
    releaseIdentityRefresh();

    await expect.poll(() => page.evaluate(() => (window as any)._randori_auth.me?.id)).toBe(secondMember.id);
    await expect(status).toHaveAttribute('data-state', 'ready');
    await expect(reminder).toBeChecked();
    expect(preferencePosts).toBe(0);
    expect(preferenceGets).toEqual([member.id, secondMember.id]);
  } finally {
    releaseIdentityRefresh?.();
  }
});

test('coarse pointers get touch targets and forced colors retain state distinctions', async ({ browser }) => {
  const context = await browser.newContext({
    viewport: { width: 390, height: 760 },
    hasTouch: true,
    isMobile: true,
  });
  try {
    const page = await context.newPage();
    await mockApi(page);
    await resetClientState(page);
    await page.emulateMedia({ forcedColors: 'active', reducedMotion: 'reduce' });
    await page.goto('/', { waitUntil: 'domcontentloaded' });
    const targetHeight = await page.locator('#landingSignin').evaluate(element =>
      Number.parseFloat(getComputedStyle(element).minHeight));
    expect(targetHeight).toBeGreaterThanOrEqual(44);
    const styles = await page.locator('#landingStatsUpdated').evaluate(element => ({
      color: getComputedStyle(element).color,
      motion: getComputedStyle(document.querySelector('.motion-probe')!).animationDuration,
    }));
    expect(styles.color).not.toBe('rgba(0, 0, 0, 0)');
    const motionMs = styles.motion.endsWith('ms')
      ? Number.parseFloat(styles.motion)
      : Number.parseFloat(styles.motion) * 1000;
    expect(motionMs).toBeLessThanOrEqual(0.01);
    await expectDocumentFitsViewport(page);
  } finally {
    await context.close();
  }
});

test('active-circle selector exposes required, switching, and ready states without changing its contract', async ({ page }) => {
  let activeCircle: 'circle-primary' | 'circle-secondary' | null = null;
  let contextVersion = 0;
  let switchAttempts = 0;
  let releaseSwitch!: () => void;
  const switchGate = new Promise<void>(resolve => { releaseSwitch = resolve; });
  await mockApi(page, {
    '/api/auth/capabilities': {
      ok: true,
      capabilities: {
        passwordLogin: true,
        passwordSignup: false,
        googleOAuth: true,
        multiCircleControlPlane: true,
      },
      registrationMode: 'private_beta',
    },
    '/api/auth/me': { ok: true, user: member },
    '/api/circles': async request => {
      if (request.method() === 'PUT') {
        switchAttempts += 1;
        if (switchAttempts === 1) {
          await switchGate;
          return { _status: 503, error: 'temporarily unavailable' };
        }
        activeCircle = 'circle-secondary';
        contextVersion += 1;
      }
      const circles = [
        { id: 10, public_id: 'circle-primary', name: 'Primary', role: 'owner', is_primary: true },
        { id: 20, public_id: 'circle-secondary', name: 'Secondary', role: 'member', is_primary: false },
      ];
      return {
        ok: true,
        circles,
        active_circle: activeCircle ? circles.find(circle => circle.public_id === activeCircle) : null,
        selection_required: activeCircle === null,
        context_version: contextVersion,
      };
    },
    '/api/circle': {
      ok: true,
      circle_meta: { id: 20, public_id: 'circle-secondary', name: 'Secondary' },
      membership: { role: 'member' },
      circle: [member],
      count: 1,
      circle_context_version: 1,
    },
  });
  await resetClientState(page, true, {}, true);
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await page.locator('[data-tab="circle"]').click();

  const panel = page.locator('#circleContextPanel');
  await expect(panel).toBeVisible();
  await expect(panel).toHaveAttribute('data-state', 'required');
  await expect(page.locator('#circleContextStatus')).toContainText('Choose which circle');

  await page.locator('#circleContextSelect').selectOption('circle-secondary');
  await expect(panel).toHaveAttribute('data-state', 'switching');
  releaseSwitch();
  await expect(panel).toHaveAttribute('data-state', 'error');
  await expect(page.locator('#circleContextRetry')).toBeVisible();
  await page.locator('[data-tab="circle"]').click();
  await expect(panel).toHaveAttribute('data-state', 'error');

  await page.locator('#circleContextRetry').click();
  await expect(panel).toHaveAttribute('data-state', 'required');
  const reloaded = page.waitForEvent('load');
  await page.locator('#circleContextSelect').selectOption('circle-secondary');
  await reloaded;
  await page.locator('[data-tab="circle"]').click();
  await expect(page.locator('#circleContextPanel')).toBeVisible();
  await expect(page.locator('#circleContextPanel')).toHaveAttribute('data-state', 'ready');
  await expect(page.locator('#circleContextSelect')).toHaveValue('circle-secondary');
});
