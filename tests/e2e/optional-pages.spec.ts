import { expect, test, type Page } from '@playwright/test';
import { mockApi, resetClientState } from './helpers';

// ID-101: verify actual request boundaries, not only removal of script tags.
const optionalAsset = /\/assets\/(?:landing|bulk-invite|email-validation|calendar-export)\.js/;
const owner = { id: 1, name: 'Owner', display_name: 'Owner', email: 'owner@example.test',
  tz: 'Europe/London', interview_focus: 'both', color: '#9cc0b5', is_available: true };
const room = 'week_42_pair_7';

async function ownerCircle(page: Page, posts: unknown[]) {
  await mockApi(page, {
    '/api/auth/me': { ok: true, user: owner },
    '/api/profile': { ok: true, user: owner },
    '/api/circle': { ok: true, circle_meta: { id: 11, public_id: 'circle_private', name: 'Private Practice' },
      membership: { role: 'owner' }, circle: [owner], count: 1 },
    '/api/invitations': request => {
      if (request.method() !== 'POST') return { ok: true, invitations: [], count: 0 };
      const body = request.postDataJSON(); posts.push(body);
      if (!body.emails) return { ok: true, invitation: {
        id: '11111111-1111-4111-8111-111111111111', invite_url: `/invite#invite=${'A'.repeat(43)}`,
      } };
      return { ok: true, results: body.emails.map((email: string, index: number) => ({
        index, status: 'created', email, invitation: {
          id: `${String(index + 1).padStart(8, '0')}-0000-4000-8000-000000000000`,
          invite_url: `/invite#invite=${'A'.repeat(43)}`,
        },
      })) };
    },
  });
  await resetClientState(page, true);
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await expect(page.locator('#meLabel')).toContainText('Owner');
  await page.locator('[data-tab="circle"]').click();
  await expect(page.getByTestId('circle-invite-email')).toBeVisible();
}

test('a signed-in pair room never requests public, invitation or calendar tools, even while idle', async ({ page }) => {
  const requests: string[] = [];
  page.on('request', request => { if (optionalAsset.test(request.url())) requests.push(request.url()); });
  await page.route(/^https:\/\//, route => route.abort());
  await mockApi(page, {
    '/api/auth/me': { ok: true, user: owner }, '/api/profile': { ok: true, user: owner },
    '/api/my-pair': { ok: true, paired: true, room_id: room, week_id: 42,
      week: { id: 42, week_label: '2026-W38' },
      pair: { pg_id: 7, user_a_id: 1, user_b_id: 2, is_ai: false, topic: 'Pick together' },
      partner: { id: 2, name: 'Partner', display_name: 'Partner', tz: 'UTC' } },
  });
  await resetClientState(page, true);
  await page.goto(`/join/${room}`, { waitUntil: 'load' });
  await expect(page.locator('#view-code')).toBeVisible();
  await page.waitForTimeout(1_500); // Covers the shell's old 1.2 s cold-start retry.
  expect(requests).toEqual([]);
  expect(await page.evaluate(() => typeof (window as any).RandoriBulkInvite)).toBe('undefined');
  expect(await page.evaluate(() => typeof (window as any)._randori_calendar_export)).toBe('undefined');
});

test('public controls show pending and a keyboard retry, then hydrate capabilities without duplicate handlers', async ({ page }) => {
  let scripts = 0;
  await mockApi(page, {
    '/api/auth/capabilities': { ok: true, registrationMode: 'private_beta', capabilities: {
      passwordLogin: true, passwordSignup: false, googleOAuth: true, inviteRequests: true,
    } },
  });
  await page.route('**/assets/landing.js*', route => ++scripts === 1 ? route.abort() : route.continue());
  await resetClientState(page);
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  const status = page.locator('#view-landing [data-testid="optional-page-status"]');
  await expect(status).toContainText('Page controls could not load');
  expect(await page.locator('#view-landing .landing').evaluate((node: HTMLElement) => node.inert)).toBe(false);
  expect(await page.locator('#requestInviteForm').evaluate((node: HTMLElement) => node.inert)).toBe(true);
  const retry = status.getByRole('button', { name: 'Retry page' });
  await retry.focus(); await retry.press('Enter');
  await expect(status).toBeHidden();
  expect(scripts).toBe(2);
  await expect(page.getByTestId('request-invite-form')).toBeVisible();
  await expect(page.getByTestId('landing-request-invite')).toBeVisible();
  await page.locator('#landingSignup').click();
  await expect(page.getByTestId('landing-invite-help')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('landing-invite-help')).toBeHidden();
  await expect(page.locator('#landingSignup')).toBeFocused();
});

for (const failure of ['network', 'evaluation']) for (const failedAsset of ['bulk-invite', 'email-validation']) test(`bulk first use retries ${failedAsset} ${failure}, keeps an early paste and sends once on double submit`, async ({ page }) => {
  const posts: unknown[] = []; let scripts = 0;
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  await page.route(`**/assets/${failedAsset}.js*`, async route => {
    scripts += 1;
    if (scripts === 1) return failure === 'network' ? route.abort() : route.fulfill({
      status: 200, contentType: 'application/javascript', body: 'throw new Error("Optional module failed");',
    });
    await gate; await route.continue();
  });
  await ownerCircle(page, posts);
  expect(scripts).toBe(0);
  await page.getByTestId('circle-bulk-invite').locator('summary').press('Enter');
  const status = page.getByTestId('circle-bulk-invite-status');
  await expect(status).toContainText('Invitation tools could not load');
  const retry = page.getByRole('button', { name: 'Retry invitation tools' });
  await retry.click();
  await expect(status).toHaveText('Loading invitation tools…');
  await expect(page.locator('#circleBulkInviteForm')).toHaveAttribute('aria-busy', 'true');
  await page.getByTestId('circle-bulk-invite-input').fill('Ada <ada@example.test>, ADA@example.test');
  await page.evaluate(() => (document.getElementById('circleBulkInviteLoadRetry') as HTMLButtonElement).click());
  release();
  await expect(page.getByTestId('circle-bulk-invite-count')).toHaveText('1 ready to invite · 1 duplicate merged');
  expect(scripts).toBe(2);
  expect(posts).toEqual([]);
  await page.evaluate(() => {
    const form = document.getElementById('circleBulkInviteForm') as HTMLFormElement;
    form.requestSubmit(); form.requestSubmit();
  });
  await expect(status).toHaveText('Invited 1 person.');
  expect(posts).toEqual([{ emails: ['ada@example.test'] }]);
});

test('retry focus survives real hidden-element blur, a second failure and eventual success', async ({ page }) => {
  await mockApi(page);
  let loads = 0;
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  await page.route('**/assets/landing.js*', async route => {
    if (++loads < 3) return route.abort();
    await gate; await route.continue();
  });
  await resetClientState(page);
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  const notice = page.locator('#view-landing [data-testid="optional-page-status"]');
  const retry = notice.getByRole('button', { name: 'Retry page' });
  await expect(retry).toBeVisible();
  await retry.focus(); await retry.press('Enter');
  await expect(retry).toBeVisible();
  await expect(retry).toBeFocused();
  await retry.press('Enter');
  await expect(notice.locator('[role="status"]')).toHaveText('Loading page controls…');
  await expect(notice.locator('[role="status"]')).toBeFocused();
  release();
  await expect(notice).toBeHidden();
  await expect(page.locator('#landingTitle')).toBeFocused();
});

test('header signup awaits failed email validation, retries strict rules, and never posts an invalid address', async ({ page }) => {
  const posts: unknown[] = [];
  await mockApi(page, {
    '/api/auth/capabilities': { ok: true, registrationMode: 'local_open', capabilities: {
      passwordLogin: true, passwordSignup: true, googleOAuth: false, localIdentity: true,
    } },
    '/api/auth/signup': request => { posts.push(request.postDataJSON()); return { ok: true, pending: true }; },
  });
  let blocked = true;
  await page.route('**/assets/email-validation.js*', route => blocked ? route.abort() : route.continue());
  await resetClientState(page);
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await page.locator('#authBtn').click();
  await page.locator('#authModeSwitch').click();
  await expect(page.locator('#authName')).toBeVisible();
  await page.locator('#authEmail').fill('a..b@example.test');
  await page.locator('#authName').fill('Ada');
  await page.locator('#authPass').fill('long-enough-password');
  await page.locator('#authSignup').click();
  await expect(page.locator('#authErr')).toContainText('Email checks could not load');
  await expect(page.locator('#authSignup')).toBeEnabled();
  await expect(page.locator('#authSignup')).toBeFocused();
  expect(posts).toEqual([]);
  blocked = false;
  await page.locator('#authSignup').click();
  await expect(page.locator('#authEmailError')).toHaveText('Dots can’t start, end, or repeat before the @.');
  await expect(page.locator('#authEmail')).toBeFocused();
  expect(posts).toEqual([]);
  await page.locator('#authEmail').fill('ada@example.test');
  await page.locator('#authSignup').click();
  await expect.poll(() => posts.length).toBe(1);
});

test('closing signup during the validator load fences its completion and blocks double submit', async ({ page }) => {
  const posts: unknown[] = [];
  await mockApi(page, {
    '/api/auth/capabilities': { ok: true, registrationMode: 'local_open', capabilities: {
      passwordLogin: true, passwordSignup: true, googleOAuth: false, localIdentity: true,
    } },
    '/api/auth/signup': request => { posts.push(request.postDataJSON()); return { ok: true, pending: true }; },
  });
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  await page.route('**/assets/email-validation.js*', async route => { await gate; await route.continue(); });
  await resetClientState(page);
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await page.locator('#authBtn').click(); await page.locator('#authModeSwitch').click();
  await page.locator('#authEmail').fill('ada@example.test');
  await page.locator('#authName').fill('Ada'); await page.locator('#authPass').fill('long-enough-password');
  await page.evaluate(() => {
    const form = document.getElementById('authForm') as HTMLFormElement;
    form.requestSubmit(); form.requestSubmit();
  });
  await expect(page.locator('#authSignup')).toHaveText('Checking email…');
  await expect(page.locator('#authSignup')).toBeDisabled();
  await page.keyboard.press('Escape');
  release();
  await expect(page.locator('#view-landing [data-testid="optional-page-status"]')).toBeHidden();
  expect(posts).toEqual([]);
  await expect(page.locator('#authOverlay')).not.toHaveClass(/show/);
});

test('blocked optional landing code never disables invitation acceptance, reset forms or in-page sign-in', async ({ page }) => {
  await mockApi(page, {
    '/api/auth/capabilities': { ok: true, registrationMode: 'verified_invite', capabilities: {
      passwordLogin: true, passwordSignup: true, googleOAuth: false, verifiedEmailActivation: true, passwordReset: true,
    } },
    '/api/invitations/prepare': { ok: true, binding: 'I'.repeat(43), expires_in_seconds: 600 },
  });
  await page.route('**/assets/landing.js*', route => route.abort());
  await resetClientState(page);
  await page.goto(`/invite#invite=${'A'.repeat(43)}`);
  await expect(page.locator('#view-invite [data-testid="optional-page-status"]')).toContainText('could not load');
  await expect(page.getByTestId('invite-continue')).toBeEnabled();
  await page.getByTestId('invite-continue').click();
  await expect(page.getByRole('dialog', { name: 'Join Randori Circle' })).toBeVisible();
  await page.keyboard.press('Escape');
  await page.goto('/invite');
  await expect(page.getByTestId('invite-next-steps')).toBeVisible();
  await page.locator('#inviteSignin').click();
  await expect(page.getByRole('dialog', { name: 'Sign in to Randori' })).toBeVisible();
  await page.keyboard.press('Escape');
  await page.goto('/verify');
  await expect(page.getByTestId('activation-next-steps')).toBeVisible();
  await page.locator('#activationSignin').click();
  await expect(page.getByRole('dialog', { name: 'Sign in to Randori' })).toBeVisible();
  await page.keyboard.press('Escape');
  await page.goto('/reset-password');
  await page.getByTestId('password-reset-request-new').click();
  await expect(page.getByRole('dialog', { name: 'Reset your password' })).toBeVisible();
  await page.keyboard.press('Escape');
  await page.goto('/', { waitUntil: 'domcontentloaded' }); await page.locator('#requestInviteSignin').click();
  await expect(page.getByRole('dialog', { name: 'Sign in to Randori' })).toBeVisible();
});

test('single invitation awaits strict email rules and keeps a failed-load draft retryable', async ({ page }) => {
  const posts: unknown[] = []; let scripts = 0;
  await page.route('**/assets/email-validation.js*', route => ++scripts === 1 ? route.abort() : route.continue());
  await ownerCircle(page, posts);
  expect(scripts).toBe(0);
  const input = page.getByTestId('circle-invite-email');
  await input.fill('a..b@example.test');
  await page.getByTestId('circle-invite-create').click();
  await expect(page.locator('#circleInviteStatus')).toContainText('Nothing was sent.');
  await expect(input).toHaveValue('a..b@example.test');
  await expect(page.getByTestId('circle-invite-create')).toBeEnabled();
  await page.getByTestId('circle-invite-create').click();
  await expect(page.locator('#circleInviteEmailError')).toHaveText('Dots can’t start, end, or repeat before the @.');
  expect(posts).toEqual([]);
  expect(scripts).toBe(2);
  await input.fill('ada@example.test');
  await page.evaluate(() => {
    const form = document.getElementById('circleInviteForm') as HTMLFormElement;
    form.requestSubmit(); form.requestSubmit();
  });
  await expect(page.getByTestId('circle-invite-link')).toBeVisible();
  expect(posts).toEqual([{ email: 'ada@example.test' }]);
});
