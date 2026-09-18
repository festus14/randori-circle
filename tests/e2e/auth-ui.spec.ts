import { expect, test } from '@playwright/test';
import { mockApi, resetClientState } from './helpers';

const localCapabilities = {
  ok: true,
  capabilities: { passwordLogin: true, passwordSignup: true, googleOAuth: false },
  registrationMode: 'local_open',
};

const privateBetaCapabilities = {
  ok: true,
  capabilities: { passwordLogin: true, passwordSignup: false, googleOAuth: true },
  registrationMode: 'private_beta',
};

test('local capabilities expose an accessible signup flow with validation and one in-flight submit', async ({ page }) => {
  const user = {
    id: 1,
    email: 'local.user@example.test',
    name: 'Local User',
    color: '#9cc0b5',
    is_admin: true,
    is_available: true,
  };
  let signedUp = false;
  let signupCalls = 0;
  const submittedBodies: unknown[] = [];
  let releaseSignup: (() => void) | undefined;
  const signupGate = new Promise<void>(resolve => { releaseSignup = resolve; });

  await mockApi(page, {
    '/api/auth/capabilities': localCapabilities,
    '/api/auth/me': () => signedUp
      ? { ok: true, user }
      : { _status: 401, ok: false, error: 'authentication required' },
    '/api/auth/signup': async request => {
      signupCalls += 1;
      submittedBodies.push(request.postDataJSON());
      if (signupCalls === 1) {
        await signupGate;
        return { _status: 503, ok: false, error: 'signup temporarily unavailable' };
      }
      signedUp = true;
      return { ok: true, user };
    },
  });
  await resetClientState(page);
  await page.goto('/', { waitUntil: 'domcontentloaded' });

  const join = page.locator('#landingSignup');
  await expect(join).toBeEnabled();
  await join.click();

  const dialog = page.getByRole('dialog', { name: 'Join Randori Circle' });
  await expect(dialog).toBeVisible();
  await expect(page.locator('#authCapabilityStatus')).toContainText('Create a local account');
  await expect(page.locator('#authGoogle')).toBeHidden();
  await expect(page.locator('#authNameField')).toBeVisible();
  await expect(page.locator('#authSignup')).toBeVisible();
  await expect(page.locator('#authEmail')).toBeFocused();

  await page.keyboard.press('Shift+Tab');
  await expect(page.locator('#authSignup')).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  await expect(join).toBeFocused();

  await join.click();
  await page.locator('#authSignup').click();
  await expect(page.locator('#authErr')).toHaveText('Enter a valid email address.');
  await expect(page.locator('#authEmail')).toHaveAttribute('aria-invalid', 'true');
  await expect(page.locator('#authSignup')).toBeEnabled();
  expect(signupCalls).toBe(0);

  await page.locator('#authEmail').fill('LOCAL.User@example.test');
  await expect(page.locator('#authEmail')).not.toHaveAttribute('aria-invalid', 'true');
  await expect(page.locator('#authErr')).toBeEmpty();
  await page.locator('#authName').fill('Local User');
  await page.locator('#authPass').fill('correct horse battery');
  await page.locator('#authPass').press('Enter');
  await expect(page.locator('#authForm')).toHaveAttribute('aria-busy', 'true');
  await expect(page.locator('#authSignup')).toBeDisabled();
  await expect(page.locator('#authSignup')).toHaveText('Creating account…');
  await expect.poll(() => signupCalls).toBe(1);
  await page.locator('#authForm').evaluate(form => {
    form.dispatchEvent(new SubmitEvent('submit', { bubbles: true, cancelable: true }));
  });
  await page.waitForTimeout(50);
  expect(signupCalls).toBe(1);

  releaseSignup?.();
  await expect(page.locator('#authErr')).toHaveText('Account creation is temporarily unavailable. Try again.');
  await expect(page.locator('#authSignup')).toBeEnabled();
  await page.locator('#authSignup').click();
  await expect(dialog).toBeHidden();
  await expect(page.locator('#meLabel')).toContainText('Local User (admin)');
  expect(signupCalls).toBe(2);
  expect(submittedBodies).toEqual([{
    email: 'local.user@example.test',
    password: 'correct horse battery',
    name: 'Local User',
  }, {
    email: 'local.user@example.test',
    password: 'correct horse battery',
    name: 'Local User',
  }]);
});

test('a stalled signup can be cancelled without accepting a stale response and then retried', async ({ page }) => {
  const staleUser = { id: 1, email: 'stale@example.test', name: 'Stale User', is_admin: true };
  const retryUser = { id: 2, email: 'retry@example.test', name: 'Retry User', is_admin: true };
  let signupCalls = 0;
  let releaseFirst: (() => void) | undefined;
  const firstGate = new Promise<void>(resolve => { releaseFirst = resolve; });

  await mockApi(page, {
    '/api/auth/capabilities': localCapabilities,
    '/api/auth/signup': async () => {
      signupCalls += 1;
      if (signupCalls === 1) {
        await firstGate;
        return { ok: true, user: staleUser };
      }
      return { ok: true, user: retryUser };
    },
  });
  await resetClientState(page);
  await page.goto('/', { waitUntil: 'domcontentloaded' });

  const join = page.locator('#landingSignup');
  const dialog = page.getByRole('dialog', { name: 'Join Randori Circle' });
  await join.click();
  await page.locator('#authEmail').fill('retry@example.test');
  await page.locator('#authName').fill('Retry User');
  await page.locator('#authPass').fill('correct horse battery');
  await page.locator('#authSignup').click();
  await expect.poll(() => signupCalls).toBe(1);
  await expect(page.locator('#authCancel')).toBeEnabled();

  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  await expect(join).toBeFocused();
  releaseFirst?.();
  await page.waitForTimeout(100);
  await expect(page.locator('#meLabel')).toBeHidden();
  await expect(page.locator('#authBtn')).toBeVisible();

  await join.click();
  await page.locator('#authPass').fill('correct horse battery');
  await page.locator('#authSignup').click();
  await expect(dialog).toBeHidden();
  await expect(page.locator('#meLabel')).toContainText('Retry User (admin)');
  expect(signupCalls).toBe(2);
});

test('existing members recover from a wrong password and can sign out after login', async ({ page }) => {
  const loginCapabilities = {
    ok: true,
    capabilities: { passwordLogin: true, passwordSignup: false, googleOAuth: false },
    registrationMode: 'private_beta',
  };
  const user = {
    id: 3,
    email: 'member@example.test',
    name: 'Existing Member',
    is_admin: false,
    is_available: true,
  };
  let signedIn = false;
  let loginCalls = 0;
  let logoutCalls = 0;
  await mockApi(page, {
    '/api/auth/capabilities': loginCapabilities,
    '/api/auth/me': () => signedIn
      ? { ok: true, user }
      : { _status: 401, ok: false, error: 'authentication required' },
    '/api/auth/login': () => {
      loginCalls += 1;
      if (loginCalls === 1) return { _status: 401, ok: false, error: 'invalid credentials' };
      signedIn = true;
      return { ok: true, user };
    },
    '/api/auth/logout': () => {
      logoutCalls += 1;
      signedIn = false;
      return { ok: true };
    },
  });
  await resetClientState(page);
  await page.goto('/', { waitUntil: 'domcontentloaded' });

  await page.locator('#landingSignin').click();
  await page.locator('#authEmail').fill('member@example.test');
  await page.locator('#authPass').fill('wrong password');
  await page.locator('#authSignin').click();
  await expect(page.locator('#authErr')).toHaveText('Email or password is incorrect.');
  await expect(page.locator('#authSignin')).toBeEnabled();

  await page.locator('#authPass').fill('correct password');
  await expect(page.locator('#authErr')).toBeEmpty();
  await page.locator('#authPass').press('Enter');
  await expect(page.getByRole('dialog', { name: 'Sign in to Randori' })).toBeHidden();
  await expect(page.locator('#meLabel')).toContainText('Existing Member');
  expect(loginCalls).toBe(2);

  await page.locator('#meLabel').click();
  await expect(page.locator('#meSignOut')).toBeVisible();
  await page.locator('#meSignOut').click();
  await expect.poll(() => logoutCalls).toBe(1);
  await expect(page.locator('#authBtn')).toBeVisible();
});

test('private beta capabilities offer Google for joining and password only for existing members', async ({ page }) => {
  await mockApi(page, { '/api/auth/capabilities': privateBetaCapabilities });
  await resetClientState(page);
  await page.goto('/', { waitUntil: 'domcontentloaded' });

  await page.locator('#landingSignup').click();
  await expect(page.getByRole('dialog', { name: 'Join Randori Circle' })).toBeVisible();
  await expect(page.locator('#authGoogle')).toBeVisible();
  await expect(page.locator('#authCapabilityStatus')).toContainText('invitation');
  await expect(page.locator('#authPasswordFields')).toBeHidden();
  await expect(page.locator('#authSignup')).toBeHidden();
  await expect(page.locator('#authModeSwitch')).toHaveText('Already a member? Sign in');

  await page.locator('#authModeSwitch').click();
  await expect(page.getByRole('dialog', { name: 'Sign in to Randori' })).toBeVisible();
  await expect(page.locator('#authPasswordFields')).toBeVisible();
  await expect(page.locator('#authNameField')).toBeHidden();
  await expect(page.locator('#authSignin')).toBeVisible();
  await expect(page.locator('#authSignup')).toBeHidden();
});

test('capability failures fail closed for account creation while preserving existing-user login', async ({ page }) => {
  await mockApi(page, {
    '/api/auth/capabilities': { _status: 503, ok: false, error: 'temporarily unavailable' },
  });
  await resetClientState(page);
  await page.goto('/', { waitUntil: 'domcontentloaded' });

  await expect(page.locator('#landingSignup')).toBeHidden();
  await expect(page.locator('#landingSignin')).toBeEnabled();
  await page.locator('#landingSignin').click();

  await expect(page.locator('#authCapabilityStatus')).toContainText('could not be verified');
  await expect(page.locator('#authSignin')).toBeVisible();
  await expect(page.locator('#authSignup')).toBeHidden();
  await expect(page.locator('#authGoogle')).toBeHidden();
  await expect(page.locator('#authModeSwitch')).toBeHidden();

  await page.keyboard.press('Escape');
  await page.locator('#welcomeBanner').evaluate(element => { element.style.display = 'flex'; });
  await page.locator('#welcomeStartBtn').click();
  await expect(page.getByRole('dialog', { name: 'Sign in to Randori' })).toBeVisible();
  await expect(page.getByRole('dialog', { name: 'Join Randori Circle' })).toBeHidden();
});
