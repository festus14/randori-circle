import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page, type TestInfo } from '@playwright/test';
import { mockApi, resetClientState } from './helpers';

// UI redesign WP-L1: public landing, request-an-invite form and recovery
// pages. POST /api/invite-requests is mocked here until the WP-L2 backend
// (docs/INVITE_REQUESTS.md) merges; the real-runtime path is covered there.

const SUCCESS = 'Thanks — if the circle has room, you’ll get an invitation by email.';

const capabilities = (inviteRequests: boolean, overrides: Record<string, unknown> = {}) => ({
  ok: true,
  capabilities: {
    passwordLogin: true,
    passwordSignup: false,
    googleOAuth: true,
    ...(inviteRequests ? { inviteRequests: true } : {}),
    ...overrides,
  },
  registrationMode: 'private_beta',
});

const verifiedInviteCapabilities = {
  ok: true,
  capabilities: {
    passwordLogin: true,
    passwordSignup: true,
    verifiedEmailActivation: true,
    localIdentity: false,
    googleOAuth: false,
    inviteRequests: true,
  },
  registrationMode: 'verified_invite',
};

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

async function expectDocumentFitsViewport(page: Page) {
  const dimensions = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    innerWidth: window.innerWidth,
  }));
  expect(dimensions.scrollWidth).toBeLessThanOrEqual(dimensions.innerWidth);
}

test('without the capability the landing explains invite-only access and offers sign in', async ({ page }, testInfo) => {
  let inviteRequestPosts = 0;
  await mockApi(page, {
    '/api/auth/capabilities': capabilities(false),
    '/api/invite-requests': () => { inviteRequestPosts += 1; return { _status: 404, error: 'not found' }; },
  });
  await resetClientState(page);
  await page.goto('/', { waitUntil: 'domcontentloaded' });

  await expect(page.getByRole('heading', { level: 1, name: 'Mock interviews with people you trust.' })).toBeVisible();
  await expect(page.locator('#view-landing')).not.toContainText(/authorization-gated|Circle summary|weeks paired/);
  const closed = page.getByTestId('request-invite-closed');
  await expect(closed).toBeVisible();
  await expect(closed).toContainText('Invite-only — ask a member for an invitation.');
  await expect(page.getByTestId('request-invite-form')).toBeHidden();
  await expect(page.getByTestId('landing-request-invite')).toBeHidden();

  const inviteButton = page.locator('#landingSignup');
  await expect(inviteButton).toHaveText('I have an invitation');
  await inviteButton.click();
  await expect(page.getByTestId('landing-invite-help')).toBeVisible();
  await expect(inviteButton).toHaveAttribute('aria-expanded', 'true');
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('landing-invite-help')).toBeHidden();
  await expect(inviteButton).toBeFocused();

  await expectWcagClean(page, testInfo, 'landing-invite-only', '#view-landing');
  await page.locator('#requestInviteSignin').click();
  await expect(page.getByRole('dialog', { name: 'Sign in to Randori' })).toBeVisible();
  expect(inviteRequestPosts).toBe(0);
});

test('anonymous visitor requests an invite and sees the generic confirmation', async ({ page }, testInfo) => {
  const posts: unknown[] = [];
  await mockApi(page, {
    '/api/auth/capabilities': capabilities(true),
    '/api/invite-requests': request => {
      expect(request.method()).toBe('POST');
      expect(request.headers()['content-type']).toContain('application/json');
      posts.push(request.postDataJSON());
      return { _status: 202, ok: true, message: SUCCESS };
    },
  });
  await resetClientState(page);
  await page.goto('/', { waitUntil: 'domcontentloaded' });

  const form = page.getByTestId('request-invite-form');
  await expect(page.getByTestId('request-invite-closed')).toBeHidden();
  await expectWcagClean(page, testInfo, 'landing-request-form-dark', '#view-landing');

  await page.getByTestId('landing-request-invite').click();
  await expect(page).toHaveURL(/#request-invite$/);
  await expect(page.locator('#requestInviteName')).toBeFocused();
  await expect(form).toBeInViewport();

  // Client validation: linked messages, aria-invalid, focus on the first problem.
  await page.locator('#requestInviteSubmit').click();
  await expect(page.locator('#requestInviteName')).toHaveAttribute('aria-invalid', 'true');
  await expect(page.locator('#requestInviteNameError')).toHaveText('Enter your name.');
  await expect(page.locator('#requestInviteName')).toHaveAttribute('aria-describedby', 'requestInviteNameError');
  await expect(page.locator('#requestInviteEmailError')).toHaveText('Enter your email address.');
  await expect(page.locator('#requestInviteName')).toBeFocused();
  expect(posts).toHaveLength(0);

  await page.locator('#requestInviteName').fill('  Ada   Lovelace ');
  await expect(page.locator('#requestInviteName')).not.toHaveAttribute('aria-invalid', 'true');
  await page.locator('#requestInviteEmail').fill('Ada@Example.com');
  await page.locator('#requestInviteNote').fill('Onsite loops in March');
  await expect(page.locator('#requestInviteNoteCount')).toHaveText('21 / 280');
  // The honeypot is present for bots but out of reach for people.
  const honeypot = page.locator('#requestInviteWebsite');
  await expect(honeypot).toHaveAttribute('tabindex', '-1');
  await expect(honeypot).toHaveAttribute('aria-hidden', 'true');
  await expect(honeypot).not.toBeInViewport();

  await page.locator('#requestInviteSubmit').click();
  const done = page.getByTestId('request-invite-done');
  await expect(done).toHaveText(SUCCESS);
  await expect(done).toBeFocused();
  await expect(form).toBeHidden();
  expect(posts).toEqual([{ name: 'Ada Lovelace', email: 'ada@example.com', note: 'Onsite loops in March', website: '' }]);

  await page.locator('#themeToggle').click();
  await expect(page.locator('html')).toHaveClass(/light/);
  await expectWcagClean(page, testInfo, 'landing-request-success-light', '#view-landing');
});

test('request errors keep the draft and show field, rate-limit, outage and network messages', async ({ page }) => {
  const replies: Array<Record<string, unknown> | 'abort'> = [
    { _status: 400, error: 'invalid invite request', fields: { email: 'That email address cannot receive invitations.' } },
    { _status: 429, error: 'too many requests; try again later', retry_after_seconds: 3600 },
    { _status: 503, error: 'invite requests unavailable' },
    'abort',
  ];
  await mockApi(page, { '/api/auth/capabilities': capabilities(true) });
  await page.route('**/api/invite-requests', async route => {
    const reply = replies.shift();
    if (reply === 'abort' || !reply) return route.abort('internetdisconnected');
    const { _status, ...body } = reply;
    return route.fulfill({ status: Number(_status), contentType: 'application/json', body: JSON.stringify(body) });
  });
  await resetClientState(page);
  await page.goto('/#request-invite', { waitUntil: 'domcontentloaded' });
  await expect(page.getByTestId('request-invite-form')).toBeInViewport();
  await page.locator('#requestInviteName').fill('Ada Lovelace');
  await page.locator('#requestInviteEmail').fill('ada@example.com');
  const submit = page.locator('#requestInviteSubmit');
  const banner = page.getByTestId('request-invite-error');

  await submit.click();
  await expect(page.locator('#requestInviteEmailError')).toHaveText('That email address cannot receive invitations.');
  await expect(page.locator('#requestInviteEmail')).toHaveAttribute('aria-invalid', 'true');
  await expect(page.locator('#requestInviteEmail')).toBeFocused();

  await submit.click();
  await expect(banner).toHaveText('Too many requests — try again later.');
  await expect(page.locator('#requestInviteEmail')).not.toHaveAttribute('aria-invalid', 'true');

  await submit.click();
  await expect(banner).toHaveText('Invite requests are paused right now. Ask a member for an invitation, or try again later.');

  await submit.click();
  await expect(banner).toHaveText('We couldn’t send your request. Check your connection and try again.');
  await expect(page.locator('#requestInviteName')).toHaveValue('Ada Lovelace');
  await expect(submit).toBeEnabled();
  await expect(submit).toHaveText('Request an invite');
  await expect(page.getByTestId('request-invite-done')).toBeHidden();
});

test('a valid invitation link still continues to account creation', async ({ page }) => {
  await mockApi(page, {
    '/api/auth/capabilities': verifiedInviteCapabilities,
    '/api/invitations/prepare': { ok: true, binding: 'I'.repeat(43), expires_in_seconds: 600 },
  });
  await resetClientState(page);
  await page.goto(`/invite#invite=${'A'.repeat(43)}`, { waitUntil: 'domcontentloaded' });
  await expect(page.getByTestId('invite-status')).toContainText('Invitation verified');
  await expect(page.locator('#inviteTitle')).toHaveText('You’re invited to Randori');
  await expect(page.getByTestId('invite-next-steps')).toBeHidden();
  await expect(page.locator('#inviteInstructions')).toBeVisible();
  const proceed = page.getByTestId('invite-continue');
  await expect(proceed).toBeEnabled();
  await proceed.click();
  await expect(page.getByRole('dialog', { name: 'Join Randori Circle' })).toBeVisible();
});

test('recovery pages without a token show next steps instead of dead ends', async ({ page }, testInfo) => {
  await mockApi(page, { '/api/auth/capabilities': capabilities(true, { passwordReset: true }) });
  await resetClientState(page);

  await page.goto('/invite', { waitUntil: 'domcontentloaded' });
  await expect(page.getByTestId('invite-status')).toContainText('unavailable');
  await expect(page.locator('#inviteTitle')).toHaveText('This invitation link can’t be used');
  const inviteSteps = page.getByTestId('invite-next-steps');
  await expect(inviteSteps).toBeVisible();
  await expect(page.getByTestId('invite-continue')).toBeHidden();
  await expect(page.getByTestId('invite-continue')).toBeDisabled();
  await expect(inviteSteps.getByRole('link', { name: 'Go to the home page' })).toHaveAttribute('href', '/');
  await expectWcagClean(page, testInfo, 'invite-no-token', '#view-invite');
  await inviteSteps.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('dialog', { name: 'Sign in to Randori' })).toBeVisible();
  await page.keyboard.press('Escape');
  await inviteSteps.getByRole('link', { name: 'Request an invite' }).click();
  await expect(page).toHaveURL(/\/#request-invite$/);
  await expect(page.getByTestId('request-invite-form')).toBeInViewport();

  await page.goto('/verify', { waitUntil: 'domcontentloaded' });
  await expect(page.getByTestId('activation-status')).toContainText('invalid or unavailable');
  await expect(page.locator('#activationTitle')).toHaveText('This verification link can’t be used');
  const activationSteps = page.getByTestId('activation-next-steps');
  await expect(activationSteps).toBeVisible();
  await expect(activationSteps.getByRole('link', { name: 'Go to the home page' })).toHaveAttribute('href', '/');
  await expectWcagClean(page, testInfo, 'verify-no-token', '#view-activation');
  await activationSteps.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('dialog', { name: 'Sign in to Randori' })).toBeVisible();
  await page.keyboard.press('Escape');

  await page.goto('/reset-password', { waitUntil: 'domcontentloaded' });
  await expect(page.getByTestId('password-reset-status')).toContainText('not valid');
  await expect(page.locator('#passwordResetTitle')).toHaveText('This reset link can’t be used');
  await expect(page.getByTestId('password-reset-next-steps')).toBeVisible();
  await expect(page.locator('#passwordResetSignin')).toBeVisible();
  await expect(page.getByTestId('password-reset-request-new')).toBeVisible();
  await expect(page.getByRole('link', { name: 'Back to the home page' })).toHaveAttribute('href', '/');
  await expectWcagClean(page, testInfo, 'reset-password-no-token', '#view-password-reset');
  await page.getByTestId('password-reset-request-new').click();
  await expect(page.getByRole('dialog', { name: 'Reset your password' })).toBeVisible();
});

test('landing, form and recovery pages fit 320px and 390px mobile viewports', async ({ page }) => {
  await mockApi(page, { '/api/auth/capabilities': capabilities(true) });
  await resetClientState(page);
  for (const width of [320, 390]) {
    await page.setViewportSize({ width, height: 800 });
    for (const path of ['/', '/invite', '/verify', '/reset-password']) {
      await page.goto(path, { waitUntil: 'domcontentloaded' });
      if (path === '/') await expect(page.getByTestId('request-invite-form')).toBeAttached();
      await page.waitForTimeout(150);
      await expectDocumentFitsViewport(page);
    }
  }
});
