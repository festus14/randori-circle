import AxeBuilder from '@axe-core/playwright';
import { expect, Page, test, TestInfo } from '@playwright/test';
import { mockApi, resetClientState } from './helpers';

// Golden paths for the WP-A sign-in and account dialogs. Selectors are the
// stable ids and data-testids the dialogs keep across redesigns.

const memberCapabilities = {
  ok: true,
  capabilities: { passwordLogin: true, passwordSignup: false, passwordReset: true, googleOAuth: true, identityManagement: true },
  registrationMode: 'private_beta',
};
const verifiedInviteCapabilities = {
  ok: true,
  capabilities: { passwordLogin: true, passwordSignup: true, verifiedEmailActivation: true, googleOAuth: false },
  registrationMode: 'verified_invite',
};
const member = { id: 3, email: 'member@example.test', name: 'Existing Member', is_admin: false, is_available: true };
const inviteBinding = 'I'.repeat(43);

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

test('email sign-in validates inline, reveals the password, blocks double submit, and recovers from failures', async ({ page }) => {
  let signedIn = false;
  let loginCalls = 0;
  let releaseFirst: (() => void) | undefined;
  const firstGate = new Promise<void>(resolve => { releaseFirst = resolve; });
  await mockApi(page, {
    '/api/auth/capabilities': memberCapabilities,
    '/api/auth/me': () => signedIn ? { ok: true, user: member } : { _status: 401, ok: false, error: 'authentication required' },
    '/api/auth/login': async request => {
      loginCalls += 1;
      expect(request.postDataJSON()).toEqual({ email: 'member@example.test', password: 'correct password' });
      if (loginCalls === 1) { await firstGate; return { _status: 503, ok: false, error: 'login temporarily unavailable' }; }
      if (loginCalls === 2) return { _status: 401, ok: false, error: 'invalid credentials' };
      signedIn = true;
      return { ok: true, user: member };
    },
  });
  await resetClientState(page);
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await page.locator('#landingSignin').click();

  const dialog = page.getByRole('dialog', { name: 'Sign in to Randori' });
  await expect(dialog).toBeVisible();
  await expect(page.locator('#authGoogle')).toBeVisible();
  await expect(page.locator('#authDivider')).toHaveText('or use email');
  await expect(page.locator('#authForgot')).toBeVisible();
  await expect(page.locator('#authEmail')).toBeFocused();

  await page.locator('#authSignin').click();
  await expect(page.locator('#authEmailError')).toHaveText('Enter your email address.');
  await expect(page.locator('#authPassError')).toHaveText('Enter your password.');
  await expect(page.locator('#authEmail')).toHaveAttribute('aria-invalid', 'true');
  await expect(page.locator('#authEmail')).toBeFocused();
  expect(loginCalls).toBe(0);

  await page.locator('#authEmail').fill('member@');
  await expect(page.locator('#authEmailError')).toBeHidden();
  await page.keyboard.press('Tab');
  await expect(page.locator('#authEmailError')).toHaveText('Enter a valid email address.');
  await page.locator('#authEmail').fill('Member@Example.test');
  await page.locator('#authPass').fill('correct password');
  await expect(page.locator('#authPassError')).toBeHidden();

  const toggle = page.locator('#authPassToggle');
  await expect(toggle).toHaveAttribute('aria-pressed', 'false');
  await toggle.click();
  await expect(page.locator('#authPass')).toHaveAttribute('type', 'text');
  await expect(toggle).toHaveAttribute('aria-pressed', 'true');
  await expect(toggle).toHaveAttribute('aria-label', 'Hide password');
  await toggle.click();
  await expect(page.locator('#authPass')).toHaveAttribute('type', 'password');

  await page.locator('#authPass').press('Enter');
  await expect.poll(() => loginCalls).toBe(1);
  await expect(page.locator('#authForm')).toHaveAttribute('aria-busy', 'true');
  await expect(page.locator('#authSignin')).toBeDisabled();
  await expect(page.locator('#authSignin')).toHaveText('Signing in…');
  await expect(page.locator('#authSignin')).toHaveAttribute('aria-busy', 'true');
  await page.locator('#authForm').evaluate(form => {
    form.dispatchEvent(new SubmitEvent('submit', { bubbles: true, cancelable: true }));
  });
  expect(loginCalls).toBe(1);

  releaseFirst?.();
  await expect(page.locator('#authErr')).toHaveText('Sign in is temporarily unavailable. Try again.');
  await expect(page.locator('#authErr')).toHaveAttribute('data-tone', 'error');
  await expect(page.locator('#authSignin')).toBeEnabled();
  await expect(page.locator('#authPass')).toBeFocused();

  await page.locator('#authSignin').click();
  await expect(page.locator('#authErr')).toHaveText('Email or password is incorrect.');
  await page.locator('#authPass').fill('correct password');
  await expect(page.locator('#authErr')).toBeEmpty();
  await page.locator('#authSignin').click();
  await expect(dialog).toBeHidden();
  await expect(page.locator('#meLabel')).toContainText('Existing Member');
  expect(loginCalls).toBe(3);
});

test('a network failure during sign-in reads as a connection problem, not a raw error', async ({ page }) => {
  await mockApi(page, { '/api/auth/capabilities': memberCapabilities });
  await page.route('**/api/auth/login', route => route.abort('internetdisconnected'));
  await resetClientState(page);
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await page.locator('#landingSignin').click();
  await page.locator('#authEmail').fill('member@example.test');
  await page.locator('#authPass').fill('any password');
  await page.locator('#authSignin').click();
  await expect(page.locator('#authErr')).toHaveText("We couldn't reach Randori. Check your connection and try again.");
});

test('forgot password keeps the email, sends an enumeration-safe request and explains rate limits', async ({ page }) => {
  let requests = 0;
  await mockApi(page, {
    '/api/auth/capabilities': memberCapabilities,
    '/api/auth/password-reset/request': request => {
      requests += 1;
      expect(request.postDataJSON()).toEqual({ email: 'member@example.test' });
      return requests === 1
        ? { _status: 202, ok: true, pending: true }
        : { _status: 429, ok: false, error: 'too many reset requests; try again later' };
    },
  });
  await resetClientState(page);
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await page.locator('#landingSignin').click();
  await page.locator('#authEmail').fill('member@example.test');
  await page.locator('#authForgot').click();

  const dialog = page.getByRole('dialog', { name: 'Reset your password' });
  await expect(dialog).toBeVisible();
  await expect(page.locator('#authPasswordField')).toBeHidden();
  await expect(page.locator('#authGoogle')).toBeHidden();
  await expect(page.locator('#authEmail')).toHaveValue('member@example.test');
  await expect(page.locator('#authCapabilityStatus')).toContainText('same message whether or not an account uses this email');

  await page.locator('#authResetRequest').click();
  await expect(page.locator('#authErr')).toContainText('If that account is eligible, a reset link will arrive shortly.');
  await expect(page.locator('#authErr')).toHaveAttribute('data-tone', 'success');
  await page.locator('#authResetRequest').click();
  await expect(page.locator('#authErr')).toHaveText('Too many reset requests. Wait a few minutes, then try again.');
  expect(requests).toBe(2);

  await page.locator('#authModeSwitch').click();
  await expect(page.getByRole('dialog', { name: 'Sign in to Randori' })).toBeVisible();
});

test('signup from an invitation waits for verification, resends safely and lets the email be corrected', async ({ page }) => {
  let signupCalls = 0;
  let resendCalls = 0;
  await mockApi(page, {
    '/api/auth/capabilities': verifiedInviteCapabilities,
    '/api/invitations/prepare': { ok: true, binding: inviteBinding, expires_in_seconds: 600 },
    '/api/auth/signup': request => {
      signupCalls += 1;
      expect(request.postDataJSON()).toEqual({
        email: 'invited@example.test', name: 'Invited Member', password: 'correct horse battery', invite_binding: inviteBinding,
      });
      return { _status: 202, ok: true, pending: true };
    },
    '/api/auth/activation/resend': () => {
      resendCalls += 1;
      return resendCalls === 1
        ? { _status: 202, ok: true, pending: true }
        : { _status: 429, ok: false, error: 'too many activation requests; try again later' };
    },
  });
  await resetClientState(page);
  await page.goto(`/invite#invite=${'A'.repeat(43)}`, { waitUntil: 'domcontentloaded' });
  await expect(page.getByTestId('invite-status')).toContainText('Invitation verified');
  await page.getByTestId('invite-continue').click();

  await expect(page.getByRole('dialog', { name: 'Join Randori Circle' })).toBeVisible();
  await expect(page.locator('#authPassHint')).toHaveText('At least 10 characters.');
  await page.locator('#authEmail').fill('invited@example.test');
  await page.locator('#authName').fill('Invited Member');
  await page.locator('#authPass').fill('short');
  await page.locator('#authSignup').click();
  await expect(page.locator('#authPassError')).toHaveText('Use at least 10 characters.');
  expect(signupCalls).toBe(0);
  await page.locator('#authPass').fill('correct horse battery');
  await page.locator('#authSignup').click();

  const pending = page.getByTestId('activation-pending');
  await expect(pending).toBeVisible();
  await expect(pending).toContainText('Check your email');
  await expect(pending).toContainText('at invited@example.test');
  await expect(page.locator('#authPasswordFields')).toBeHidden();
  await expect(page.locator('#authSignup')).toBeHidden();

  await page.locator('#authActivationResend').click();
  await expect(page.locator('#authErr')).toContainText('remains eligible');
  await expect(page.locator('#authErr')).toHaveAttribute('data-tone', 'success');
  await page.locator('#authActivationResend').click();
  await expect(page.locator('#authErr')).toHaveText('Too many verification emails requested. Wait a few minutes, then try again.');
  expect(resendCalls).toBe(2);

  await page.locator('#authActivationChangeEmail').click();
  await expect(pending).toBeHidden();
  await expect(page.locator('#authEmail')).toBeFocused();
  await expect(page.locator('#authEmail')).toHaveValue('invited@example.test');
  expect(signupCalls).toBe(1);
});

test('Google errors explain what happened and offer the right next step', async ({ page }) => {
  let starts = 0;
  await mockApi(page, { '/api/auth/capabilities': memberCapabilities });
  await page.route('**/api/auth/google/start**', async route => {
    starts += 1;
    await route.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><h1>Mock Google</h1>' });
  });
  await resetClientState(page);

  await page.goto('/?google_error=identity_invalid', { waitUntil: 'domcontentloaded' });
  const dialog = page.getByRole('dialog', { name: 'Sign in to Randori' });
  await expect(dialog).toBeVisible();
  await expect(page.locator('#authErr')).toHaveText("We couldn't verify that Google account. Make sure its email address is verified, then try again.");
  const retry = page.locator('#authGoogleRetry');
  await expect(retry).toBeVisible();
  await expect(retry).toBeFocused();
  await expect(page.locator('#authGoogle')).toBeHidden();
  await expect(page).toHaveURL('/');

  await page.goto('/?google_error=account_exists_use_password', { waitUntil: 'domcontentloaded' });
  await expect(dialog).toBeVisible();
  await expect(page.locator('#authErr')).toContainText('Sign in with your email and password');
  await expect(retry).toBeHidden();
  await expect(page.locator('#authGoogle')).toBeVisible();
  await expect(page.locator('#authEmail')).toBeFocused();

  await page.goto('/?google_error=invalid_state', { waitUntil: 'domcontentloaded' });
  await expect(page.locator('#authErr')).toContainText('Start again to continue safely');
  await retry.click();
  await expect(page.getByRole('heading', { name: 'Mock Google' })).toBeVisible();
  expect(starts).toBe(1);
});

test('account security explains disabled actions and asks for a recent sign-in before linking Google', async ({ page }) => {
  const user = { id: 1, email: 'e2e@example.test', name: 'E2E Tester', is_admin: false, is_available: true };
  let recent = false;
  let confirmCalls = 0;
  let linkStarts = 0;
  const identity = () => ({
    ok: true,
    identity: {
      accountEmail: user.email,
      password: { linked: true, canAdd: false, canUnlink: false },
      google: { linked: false, canLink: true, canUnlink: false },
      recentAuth: recent ? { ok: true, method: 'password', authenticatedAt: 1, expiresAt: 2 } : { ok: false, reason: 'recent_auth_required' },
    },
  });
  await mockApi(page, {
    '/api/auth/capabilities': memberCapabilities,
    '/api/auth/me': { ok: true, user },
    '/api/auth/identities': () => identity(),
    '/api/auth/recent-auth': request => {
      confirmCalls += 1;
      const { password } = request.postDataJSON() as { password: string };
      if (password !== 'correct password') return { _status: 401, error: 'invalid credentials' };
      recent = true;
      return { ok: true, recentAuth: { ok: true, method: 'password' } };
    },
    '/api/auth/google/link/start': () => {
      linkStarts += 1;
      if (linkStarts === 1) {
        // The confirmation lapsed between rendering and clicking.
        recent = false;
        return { _status: 403, error: 'recent authentication required', code: 'recent_auth_required' };
      }
      return { ok: true, authorizationUrl: 'https://accounts.google.com/o/oauth2/v2/auth?state=link' };
    },
  });
  await page.route('https://accounts.google.com/**', route => route.fulfill({
    status: 200, contentType: 'text/html', body: '<!doctype html><title>Google account chooser</title>',
  }));
  await resetClientState(page, true);
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await page.locator('#meLabel').click();
  await page.getByRole('menuitem', { name: 'Account security' }).click();

  const dialog = page.getByRole('dialog', { name: 'Account security' });
  await expect(dialog).toBeVisible();
  await expect(page.locator('#identityDescription')).toHaveText('Sign-in methods for e2e@example.test.');
  await expect(page.locator('#identityRecent')).toBeVisible();
  await expect(page.locator('#identityRecentHint')).toContainText('last 10 minutes');
  await expect(page.locator('#identityGoogleState')).toHaveText('not linked');
  await expect(page.locator('#identityGoogleAction')).toBeDisabled();
  await expect(page.locator('#identityGoogleHelp')).toContainText('Confirm your password above first, then link Google.');
  await expect(page.locator('#identityPasswordAction')).toBeDisabled();
  await expect(page.locator('#identityPasswordHelp')).toContainText('final sign-in method');

  await page.locator('#identityConfirmPassword').click();
  await expect(page.locator('#identityPasswordConfirmError')).toHaveText('Enter your current password.');
  await expect(page.locator('#identityPasswordConfirm')).toBeFocused();
  expect(confirmCalls).toBe(0);

  await page.locator('#identityPasswordConfirm').fill('wrong password');
  await page.locator('#identityPasswordConfirm').press('Enter');
  await expect(page.locator('#identityPasswordConfirmError')).toHaveText("That password isn't right. Try again.");
  await expect(page.locator('#identityPasswordConfirm')).toBeFocused();
  expect(confirmCalls).toBe(1);

  await page.locator('#identityPasswordConfirm').fill('correct password');
  await page.locator('#identityConfirmPassword').click();
  await expect(page.locator('#identityRecent')).toBeHidden();
  await expect(page.getByTestId('identity-status')).toHaveText('Identity confirmed.');
  await expect(page.locator('#identityRecentOk')).toBeVisible();
  await expect(page.locator('#identityGoogleAction')).toBeEnabled();
  await expect(page.locator('#identityGoogleHelp')).toContainText('continue to Google');

  await page.locator('#identityGoogleAction').click();
  await expect(page.getByTestId('identity-status')).toContainText('needs a Randori sign-in from the last 10 minutes');
  await expect(page.locator('#identityRecent')).toBeVisible();
  await expect(page.locator('#identityPasswordConfirm')).toBeFocused();
  await expect(page.locator('#identityGoogleAction')).toBeDisabled();

  await page.locator('#identityPasswordConfirm').fill('correct password');
  await page.locator('#identityConfirmPassword').click();
  await expect(page.locator('#identityGoogleAction')).toBeEnabled();
  await page.locator('#identityGoogleAction').click();
  await expect(page).toHaveURL('https://accounts.google.com/o/oauth2/v2/auth?state=link');
  expect(linkStarts).toBe(2);
  expect(confirmCalls).toBe(3);
});

test('confirmation dialogs trap focus, start on Cancel and return focus on Escape', async ({ page }) => {
  await mockApi(page, { '/api/auth/capabilities': memberCapabilities });
  await resetClientState(page);
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  // Let the app finish its first routing pass, which may move focus itself.
  await page.waitForLoadState('networkidle');
  await expect(page.locator('#landingSignin')).toBeEnabled();
  await page.locator('#landingSignin').focus();
  await expect(page.locator('#landingSignin')).toBeFocused();
  const answer = page.evaluate(() => new Promise(resolve => {
    // showConfirm is private to the app; the board's Clear action is one caller.
    (document.getElementById('clearBtn') as HTMLButtonElement | null)?.click();
    const overlay = document.getElementById('confirmOverlay')!;
    const observer = new MutationObserver(() => {
      if (!overlay.classList.contains('show')) { observer.disconnect(); resolve('closed'); }
    });
    observer.observe(overlay, { attributes: true, attributeFilter: ['class'] });
  }));
  const dialog = page.getByRole('alertdialog', { name: 'Clear board?' });
  await expect(dialog).toBeVisible();
  await expect(page.locator('#confirmCancel')).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(page.locator('#confirmOk')).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(page.locator('#confirmCancel')).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  await expect(answer).resolves.toBe('closed');
  await expect(page.locator('#landingSignin')).toBeFocused();
});

for (const theme of ['dark', 'light'] as const) {
  test(`sign-in sheet and account security pass WCAG 2.2 AA on mobile in ${theme} mode`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width: 393, height: 852 });
    await mockApi(page, {
      '/api/auth/capabilities': memberCapabilities,
      '/api/auth/me': { _status: 401, ok: false, error: 'authentication required' },
    });
    await resetClientState(page, false, { 'randori-theme': theme });
    await page.goto('/?google_error=provider_unavailable', { waitUntil: 'domcontentloaded' });
    const dialog = page.locator('#authDialog');
    await expect(dialog).toBeVisible();
    await expect(page.locator('#authErr')).not.toBeEmpty();
    // Bottom sheet: full width and anchored to the bottom edge once its
    // slide-up animation settles.
    await expect.poll(async () => {
      const box = await dialog.boundingBox();
      return box ? Math.round(box.y + box.height) : null;
    }).toBe(852);
    const box = await dialog.boundingBox();
    expect(box!.x).toBeGreaterThanOrEqual(-0.5);
    expect(box!.x + box!.width).toBeLessThanOrEqual(393.5);
    await page.locator('#authSignin').click();
    await expect(page.locator('#authEmailError')).toBeVisible();
    await expectWcagClean(page, testInfo, `signin-sheet-${theme}`, '#authDialog');
    await page.keyboard.press('Escape');

    await page.unrouteAll({ behavior: 'ignoreErrors' });
    await mockApi(page, {
      '/api/auth/capabilities': memberCapabilities,
      '/api/auth/me': { ok: true, user: { id: 1, email: 'e2e@example.test', name: 'E2E Tester', is_admin: false } },
      '/api/auth/identities': { ok: true, identity: {
        accountEmail: 'e2e@example.test',
        password: { linked: true, canAdd: false, canUnlink: false },
        google: { linked: false, canLink: true, canUnlink: false },
        recentAuth: { ok: false, reason: 'recent_auth_required' },
      } },
    });
    await resetClientState(page, true, { 'randori-theme': theme });
    await page.goto('/', { waitUntil: 'domcontentloaded' });
    await page.locator('#meLabel').click();
    await page.getByRole('menuitem', { name: 'Account security' }).click();
    await expect(page.locator('#identityGoogleHelp')).toBeVisible();
    await expectWcagClean(page, testInfo, `account-security-${theme}`, '#identityDialog');
  });
}
