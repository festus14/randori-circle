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
  let firstResponseReady = false;
  let releaseFirst: (() => void) | undefined;
  const firstGate = new Promise<void>(resolve => { releaseFirst = resolve; });

  await mockApi(page, {
    '/api/auth/capabilities': localCapabilities,
    '/api/auth/signup': async () => {
      signupCalls += 1;
      if (signupCalls === 1) {
        await firstGate;
        firstResponseReady = true;
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
  await expect(page.locator('#authCancel')).toBeFocused();

  // Chromium may move focus outside a modal after its submit control becomes
  // disabled. Escape must remain owned by the visible auth modal regardless.
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await expect(page.locator('body')).toBeFocused();

  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  await expect(join).toBeFocused();
  releaseFirst?.();
  await expect.poll(() => firstResponseReady).toBe(true);
  await expect(page.locator('#meLabel')).toBeHidden();
  await expect(page.locator('#authBtn')).toBeVisible();

  await join.click();
  await page.locator('#authPass').fill('correct horse battery');
  await page.locator('#authSignup').click();
  await expect(dialog).toBeHidden();
  await expect(page.locator('#meLabel')).toContainText('Retry User (admin)');
  expect(signupCalls).toBe(2);
});

test('a pre-auth refresh cannot clear a newer successful signup identity', async ({ page }) => {
  const user = { id: 4, email: 'fresh@example.test', name: 'Fresh User', is_admin: true, tz: 'Europe/London' };
  let signedUp = false;
  let authMeCalls = 0;
  let delayNextRefresh = false;
  let delayedRefreshStarted = false;
  let releaseDelayedRefresh: (() => void) | undefined;
  const delayedRefreshGate = new Promise<void>(resolve => { releaseDelayedRefresh = resolve; });

  await mockApi(page, {
    '/api/auth/capabilities': localCapabilities,
    '/api/auth/me': async () => {
      authMeCalls += 1;
      if(delayNextRefresh){
        delayNextRefresh=false;
        delayedRefreshStarted=true;
        await delayedRefreshGate;
        return { _status: 401, ok: false, error: 'authentication required' };
      }
      return signedUp
        ? { ok: true, user }
        : { _status: 401, ok: false, error: 'authentication required' };
    },
    '/api/auth/signup': () => {
      signedUp=true;
      return { ok: true, user };
    },
  });
  await resetClientState(page);
  await page.goto('/', { waitUntil: 'domcontentloaded' });

  // Let the three bootstrap reconciliation attempts start so the controlled
  // request below cannot be stolen by a scheduled refresh.
  await expect.poll(() => authMeCalls).toBeGreaterThanOrEqual(3);
  delayNextRefresh=true;
  const staleRefresh=page.evaluate(()=>(window as any)._randori_auth.refreshMe());
  await expect.poll(()=>delayedRefreshStarted).toBe(true);

  await page.locator('#landingSignup').click();
  await page.locator('#authEmail').fill('fresh@example.test');
  await page.locator('#authName').fill('Fresh User');
  await page.locator('#authPass').fill('correct horse battery');
  await page.locator('#authSignup').click();
  await expect(page.getByRole('dialog', { name: 'Join Randori Circle' })).toBeHidden();
  await expect(page.locator('#meLabel')).toContainText('Fresh User (admin)');

  releaseDelayedRefresh?.();
  await staleRefresh;
  await expect(page.locator('#meLabel')).toContainText('Fresh User (admin)');
  expect(await page.evaluate(()=>(window as any)._randori_auth.me?.email)).toBe('fresh@example.test');
  expect(await page.evaluate(()=>JSON.parse(localStorage.getItem('randori-me')||'null')?.email)).toBe('fresh@example.test');
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
  let delayNextRefresh = false;
  let delayedRefreshStarted = false;
  let releaseDelayedRefresh: (() => void) | undefined;
  const delayedRefreshGate = new Promise<void>(resolve => { releaseDelayedRefresh = resolve; });
  await mockApi(page, {
    '/api/auth/capabilities': loginCapabilities,
    '/api/auth/me': async () => {
      if(delayNextRefresh){
        delayNextRefresh=false;
        delayedRefreshStarted=true;
        await delayedRefreshGate;
        return { ok: true, user };
      }
      return signedIn
        ? { ok: true, user }
        : { _status: 401, ok: false, error: 'authentication required' };
    },
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

  delayNextRefresh=true;
  const staleRefresh=page.evaluate(()=>(window as any)._randori_auth.refreshMe());
  await expect.poll(()=>delayedRefreshStarted).toBe(true);
  await page.locator('#meLabel').click();
  await expect(page.locator('#meSignOut')).toBeVisible();
  await page.locator('#meSignOut').click();
  await expect.poll(() => logoutCalls).toBe(1);
  await expect(page.locator('#authBtn')).toBeVisible();
  releaseDelayedRefresh?.();
  await staleRefresh;
  await expect(page.locator('#authBtn')).toBeVisible();
  expect(await page.evaluate(()=>(window as any)._randori_auth.me)).toBeNull();
});

test('an authenticated member can sign out every session from the account menu',async({page})=>{
  const user={id:3,email:'member@example.test',name:'Existing Member',is_admin:false,is_available:true};
  let signedIn=true;
  let logoutAllCalls=0;
  await mockApi(page,{
    '/api/auth/capabilities':privateBetaCapabilities,
    '/api/auth/me':()=>signedIn?{ok:true,user}:{_status:401,ok:false,error:'authentication required'},
    '/api/auth/logout-all':()=>{
      logoutAllCalls+=1;
      signedIn=false;
      return {ok:true};
    },
  });
  await resetClientState(page,true);
  await page.goto('/',{waitUntil:'domcontentloaded'});

  await expect(page.locator('#meLabel')).toContainText('Existing Member');
  await page.locator('#meLabel').click();
  const logoutAll=page.getByRole('button',{name:'Sign out everywhere'});
  await expect(logoutAll).toBeVisible();
  await logoutAll.click();
  await expect.poll(()=>logoutAllCalls).toBe(1);
  await expect(page.locator('#authBtn')).toBeVisible();
  expect(await page.evaluate(()=>(window as any)._randori_auth.me)).toBeNull();
  expect(await page.evaluate(()=>localStorage.getItem('randori-me'))).toBeNull();
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

test('Google failure offers an accessible retry and a mocked provider returns the member to the app', async ({ page }) => {
  const user = {
    id: 9,
    email: 'invited@example.test',
    name: 'Invited Member',
    is_admin: false,
    is_available: true,
  };
  let starts=0;
  let callbacks=0;
  await mockApi(page,{
    '/api/auth/capabilities':privateBetaCapabilities,
    '/api/auth/me':async request=>/(?:^|;\s*)randori_session=mocked-provider-session(?:;|$)/
      .test((await request.headerValue('cookie'))||'')
      ?{ok:true,user}
      :{_status:401,ok:false,error:'authentication required'},
  });
  await page.route('**/api/auth/google/start**',async route=>{
    starts+=1;
    await route.fulfill({
      status:200,
      contentType:'text/html',
      body:`<!doctype html><html><body><h1>Mock Google</h1><button id="approve" onclick="location.href='/api/auth/google/callback?code=one-time-code&state=mock-state'">Continue as invited@example.test</button></body></html>`,
    });
  });
  await page.route('**/api/auth/google/callback**',async route=>{
    callbacks+=1;
    await route.fulfill({
      status:302,
      headers:{location:'/?google=success','set-cookie':'randori_session=mocked-provider-session; Path=/; HttpOnly; SameSite=Lax'},
      body:'',
    });
  });
  await resetClientState(page);
  await page.goto('/?google_error=provider_unavailable',{waitUntil:'domcontentloaded'});

  const dialog=page.getByRole('dialog',{name:'Sign in to Randori'});
  const retry=page.getByRole('button',{name:'Try Google sign-in again'});
  await expect(dialog).toBeVisible();
  await expect(page.locator('#authErr')).toHaveText('Google sign-in is temporarily unavailable. Please try again.');
  await expect(retry).toBeVisible();
  await expect(retry).toBeFocused();
  await retry.click();

  await expect(page.getByRole('heading',{name:'Mock Google'})).toBeVisible();
  await page.getByRole('button',{name:'Continue as invited@example.test'}).click();
  await expect(page).toHaveURL('/');
  await expect(page.locator('#meLabel')).toContainText('Invited Member');
  expect(starts).toBe(1);
  expect(callbacks).toBe(1);
});

test('capability failures fail closed for account creation while preserving existing-user login', async ({ page }) => {
  await mockApi(page, {
    '/api/auth/capabilities': { _status: 503, ok: false, error: 'temporarily unavailable' },
  });
  await resetClientState(page, false, {
    'randori-onboarded': '0',
    'randori-banner-dismissed': '0',
    'randori-onboard-step': '0',
  });
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
  await expect(page.getByRole('dialog', { name: 'Sign in to Randori' })).toBeHidden();
  await expect(page.locator('#welcomeBanner')).toBeVisible();
  await page.locator('#welcomeStartBtn').click();
  await expect(page.getByRole('dialog', { name: 'Sign in to Randori' })).toBeVisible();
  await expect(page.getByRole('dialog', { name: 'Join Randori Circle' })).toBeHidden();
  await expect(page.locator('#onboardOverlay')).not.toHaveClass(/show/);
});

test('closing auth while capabilities load does not reopen the dialog or steal focus', async ({ page }) => {
  let capabilityRequestStarted = false;
  let capabilityResponseReady = false;
  let releaseCapabilities: (() => void) | undefined;
  const capabilityGate = new Promise<void>(resolve => { releaseCapabilities = resolve; });

  await mockApi(page, {
    '/api/auth/capabilities': async () => {
      capabilityRequestStarted = true;
      await capabilityGate;
      capabilityResponseReady = true;
      return localCapabilities;
    },
  });
  await resetClientState(page);
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await expect.poll(() => capabilityRequestStarted).toBe(true);

  const entry = page.locator('#authBtn');
  await entry.click();
  const dialog = page.getByRole('dialog', { name: 'Sign in to Randori' });
  await expect(dialog).toBeVisible();
  await expect(page.locator('#authCapabilityStatus')).toHaveText('Checking sign-in options…');

  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  await expect(entry).toBeFocused();

  releaseCapabilities?.();
  await expect.poll(() => capabilityResponseReady).toBe(true);
  await expect(page.locator('#authCapabilityStatus')).toContainText('Sign in with your existing email and password');
  await expect(dialog).toBeHidden();
  await expect(entry).toBeFocused();
});
