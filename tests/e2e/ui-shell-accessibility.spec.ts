import { expect, test, type Locator, type Page } from '@playwright/test';
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

test('anonymous shell has landmarks, truthful copy, AA themes, and reduced motion', async ({ page }) => {
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

test('shell and authentication remain inside 320px and 390px viewports', async ({ page }) => {
  await mockApi(page, {
    '/api/auth/capabilities': {
      ok: true,
      capabilities: { passwordLogin: true, passwordSignup: true, googleOAuth: false },
      registrationMode: 'local_open',
    },
  });
  await resetClientState(page);

  for (const width of [320, 390]) {
    await page.setViewportSize({ width, height: 720 });
    await page.goto('/', { waitUntil: 'domcontentloaded' });
    await expect(page.locator('#view-landing')).toBeVisible();
    await expect(page.locator('#landingSignup')).toHaveText('Create an account');
    await expectInsideViewport(page.locator('header.topbar'), width);
    await expectInsideViewport(page.locator('.tabs'), width);
    await expectInsideViewport(page.locator('main#appMain'), width);
    await expectInsideViewport(page.locator('#view-landing .hero'), width);
    await expectDocumentFitsViewport(page);
    await page.locator('#landingSignin').click();
    const dialog = page.getByRole('dialog', { name: 'Sign in to Randori' });
    await expect(dialog).toBeVisible();
    await expectInsideViewport(page.locator('#authOverlay'), width);
    await expectInsideViewport(dialog, width);
    await expectDocumentFitsViewport(page);
    await page.keyboard.press('Escape');
  }
});

test('signed-in dashboard, navigation, panels, and account menu fit mobile viewports', async ({ page }) => {
  await mockApi(page, {
    '/api/auth/me': { ok: true, user: member },
    '/api/profile': { ok: true, user: member },
  });
  await resetClientState(page, true, {}, true);

  for (const width of [320, 390]) {
    await page.setViewportSize({ width, height: 760 });
    await page.goto('/', { waitUntil: 'domcontentloaded' });
    await expect(page.locator('#view-dashboard')).toBeVisible();
    await expectInsideViewport(page.locator('header.topbar'), width);
    await expectInsideViewport(page.locator('.tabs'), width);
    await expectInsideViewport(page.locator('main#appMain'), width);
    await expectInsideViewport(page.locator('#view-dashboard'), width);
    await expectInsideViewport(page.locator('#dashStatsGrid'), width);
    await expectDocumentFitsViewport(page);

    const trigger = page.locator('#meLabel');
    await trigger.click();
    const menu = page.getByRole('menu', { name: 'Account' });
    await expect(menu).toBeVisible();
    await expectInsideViewport(menu, width);
    await expectDocumentFitsViewport(page);
    await trigger.click();
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
