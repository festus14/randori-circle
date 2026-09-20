import { expect, test } from '@playwright/test';
import { mockApi, resetClientState } from './helpers';

const localCapabilities = {
  ok: true,
  capabilities: { passwordLogin: true, passwordSignup: true, googleOAuth: false },
  registrationMode: 'local_open',
};

const privateBetaCapabilities = {
  ok: true,
  capabilities: { passwordLogin: true, passwordSignup: false, googleOAuth: true, identityManagement: true },
  registrationMode: 'private_beta',
};

test('account security stays unavailable until the server capability is enabled',async({page})=>{
  const user={id:1,email:'member@example.test',name:'Member',is_admin:false,is_available:true};
  let identityCalls=0;
  await mockApi(page,{
    '/api/auth/capabilities':{
      ...privateBetaCapabilities,
      capabilities:{...privateBetaCapabilities.capabilities,identityManagement:false},
    },
    '/api/auth/me':{ok:true,user},
    '/api/auth/identities':()=>{ identityCalls+=1; return {_status:503,error:'unavailable'}; },
  });
  await resetClientState(page,true);
  await page.goto('/',{waitUntil:'domcontentloaded'});
  await expect(page.locator('#meLabel')).toContainText('Member');
  await page.locator('#meLabel').click();
  await expect(page.getByRole('menuitem',{name:'Account security'})).toBeHidden();
  await page.evaluate(()=>(window as any)._randori_identity.open());
  await expect(page.getByRole('dialog',{name:'Account security'})).toBeHidden();
  expect(identityCalls).toBe(0);
});

test('OAuth identity feedback waits for delayed capabilities and authenticated state',async({page})=>{
  const user={id:1,email:'member@example.test',name:'Member',is_admin:false,is_available:true};
  let releaseCapabilities:undefined|(()=>void);
  let identityCalls=0;
  const delayedCapabilities=new Promise<void>(resolve=>{ releaseCapabilities=resolve; });
  await mockApi(page,{
    '/api/auth/capabilities':async()=>{
      await delayedCapabilities;
      return privateBetaCapabilities;
    },
    '/api/auth/me':{ok:true,user},
    '/api/auth/identities':async()=>{
      identityCalls+=1;
      expect(await page.evaluate(()=>Number((window as any)._randori_auth?.me?.id))).toBe(user.id);
      return {ok:true,identity:{
        accountEmail:user.email,
        password:{linked:true,canAdd:false,canUnlink:true},
        google:{linked:true,canLink:false,canUnlink:true},
        recentAuth:{ok:true,method:'password',authenticatedAt:1,expiresAt:2},
      }};
    },
  });
  await resetClientState(page,true);
  await page.goto('/?identity_link_error=provider_in_use',{waitUntil:'domcontentloaded'});
  await expect(page).toHaveURL(/identity_link_error=provider_in_use/);
  await expect(page.getByRole('dialog',{name:'Account security'})).toBeHidden();
  releaseCapabilities?.();
  await expect(page).toHaveURL('/');
  const dialog=page.getByRole('dialog',{name:'Account security'});
  await expect(dialog).toBeVisible();
  await expect(page.getByTestId('identity-status')).toContainText('already belongs to another Randori account');
  expect(identityCalls).toBe(1);
});

const recoveryCapabilities = {
  ok: true,
  capabilities: { passwordLogin: true, passwordSignup: false, passwordReset: true, googleOAuth: false },
  registrationMode: 'private_beta',
};

const verifiedInviteCapabilities = {
  ok: true,
  capabilities: {
    passwordLogin: true,
    passwordSignup: true,
    verifiedEmailActivation: true,
    localIdentity: false,
    googleOAuth: false,
  },
  registrationMode: 'verified_invite',
};
const inviteBinding='I'.repeat(43);

test('production invite signup waits for email verification and offers a bounded resend action',async({page})=>{
  const token='A'.repeat(43);
  let signupCalls=0;
  let resendCalls=0;
  await mockApi(page,{
    '/api/auth/capabilities':verifiedInviteCapabilities,
    '/api/invitations/prepare':{ok:true,binding:inviteBinding,expires_in_seconds:600},
    '/api/auth/signup':request=>{
      signupCalls+=1;
      expect(request.postDataJSON()).toEqual({
        email:'invited@example.test',name:'Invited Member',password:'correct horse battery',
        invite_binding:inviteBinding,
      });
      return {_status:202,ok:true,pending:true,message:'If this invitation can be activated, a verification email will arrive shortly.'};
    },
    '/api/auth/activation/resend':request=>{
      resendCalls+=1;
      expect(request.postDataJSON()).toEqual({email:'invited@example.test',
        invite_binding:inviteBinding});
      return {_status:202,ok:true,pending:true};
    },
  });
  await resetClientState(page);
  await page.goto(`/invite#invite=${token}`,{waitUntil:'domcontentloaded'});
  await expect(page.getByTestId('invite-status')).toContainText('Invitation verified');
  await expect(page.getByTestId('invite-continue')).toHaveText('Create account');
  await page.getByTestId('invite-continue').click();
  await expect(page.getByRole('dialog',{name:'Join Randori Circle'})).toBeVisible();
  await expect(page.locator('#authCapabilityStatus')).toContainText('activates only after');
  await page.locator('#authEmail').fill('invited@example.test');
  await page.locator('#authName').fill('Invited Member');
  await page.locator('#authPass').fill('correct horse battery');
  await page.locator('#authSignup').click();
  await expect(page.getByTestId('activation-pending')).toBeVisible();
  await expect(page.getByTestId('activation-pending')).toContainText('If this invitation can be activated');
  await expect(page.locator('#meLabel')).toBeHidden();
  expect(signupCalls).toBe(1);
  await page.locator('#authActivationResend').click();
  await expect(page.locator('#authErr')).toContainText('remains eligible');
  expect(resendCalls).toBe(1);
});

test('private beta keeps direct account creation closed until this tab prepares an invitation',async({page})=>{
  let signupCalls=0;
  await mockApi(page,{
    '/api/auth/capabilities':privateBetaCapabilities,
    '/api/auth/signup':()=>{ signupCalls+=1; return {_status:202,ok:true,pending:true}; },
  });
  await resetClientState(page);
  await page.goto('/',{waitUntil:'domcontentloaded'});

  await expect(page.locator('#landingSignup')).toBeVisible();
  await expect(page.locator('#landingSignup')).toBeDisabled();
  await expect(page.locator('#landingInviteHelp')).toContainText('Open the invitation link');

  await page.evaluate(()=>(window as any)._randori_auth.openModal('signup'));
  await expect(page.getByRole('dialog',{name:'Join Randori Circle'})).toBeHidden();
  await expect(page.getByRole('dialog',{name:'Sign in to Randori'})).toBeVisible();
  await expect(page.locator('#authGoogle')).toBeVisible();
  await expect(page.locator('#authSignup')).toBeHidden();
  expect(signupCalls).toBe(0);
  await expect(page.locator('#authModeSwitch')).toBeHidden();
});

test('invite reload refreshes only the opaque tab binding and preserves its bounded lifetime',async({page})=>{
  const token='R'.repeat(43);
  const prepareBodies:unknown[]=[];
  await page.clock.install();
  await mockApi(page,{
    '/api/auth/capabilities':verifiedInviteCapabilities,
    '/api/invitations/prepare':request=>{
      const body=request.postDataJSON();
      prepareBodies.push(body);
      if(prepareBodies.length===1){
        expect(body).toEqual({token});
        return {ok:true,binding:inviteBinding,expires_in_seconds:600};
      }
      expect(body).toEqual({binding:inviteBinding});
      return {ok:true,binding:inviteBinding,expires_in_seconds:420};
    },
  });
  await resetClientState(page,false,{},true);

  await page.goto(`/invite#invite=${token}`,{waitUntil:'domcontentloaded'});
  await expect(page.getByTestId('invite-status')).toContainText('Invitation verified');
  await page.reload({waitUntil:'domcontentloaded'});
  await expect(page.getByTestId('invite-status')).toContainText('Invitation verified');
  expect(prepareBodies).toEqual([{token},{binding:inviteBinding}]);
  expect(await page.evaluate(secret=>[
    ...Object.values(localStorage),...Object.values(sessionStorage),
  ].some(value=>String(value).includes(secret)),token)).toBe(false);

  await page.clock.fastForward(420_100);
  await expect(page.getByTestId('invite-status')).toContainText('expired');
  expect(await page.evaluate(()=>sessionStorage.getItem('randori-invite-binding-v1'))).toBeNull();
});

test('an auth change fences a delayed invitation preparation response',async({page})=>{
  const token='D'.repeat(43);
  const user={id:19,email:'member@example.test',name:'Existing Member',is_admin:false,is_available:true};
  let signedIn=false;
  let prepareStarted=false;
  let releasePrepare:(()=>void)|undefined;
  const prepareGate=new Promise<void>(resolve=>{ releasePrepare=resolve; });
  await mockApi(page,{
    '/api/auth/capabilities':verifiedInviteCapabilities,
    '/api/invitations/prepare':async()=>{
      prepareStarted=true;
      await prepareGate;
      return {ok:true,binding:inviteBinding,expires_in_seconds:600};
    },
    '/api/auth/me':()=>signedIn?{ok:true,user}:{_status:401,ok:false,error:'authentication required'},
    '/api/auth/login':()=>{ signedIn=true; return {ok:true,user}; },
  });
  await resetClientState(page);
  await page.goto(`/invite#invite=${token}`,{waitUntil:'domcontentloaded'});
  await expect.poll(()=>prepareStarted).toBe(true);
  await page.locator('#authBtn').click();
  await page.locator('#authEmail').fill('member@example.test');
  await page.locator('#authPass').fill('correct horse battery');
  await page.locator('#authSignin').click();
  await expect(page.locator('#meLabel')).toContainText('Existing Member');

  releasePrepare?.();
  await expect(page.getByTestId('invite-status')).toContainText('expired');
  await expect(page.getByTestId('invite-continue')).toBeDisabled();
  expect(await page.evaluate(()=>sessionStorage.getItem('randori-invite-binding-v1'))).toBeNull();
});

test('initial existing-member hydration preserves a delayed prepared invitation',async({page})=>{
  const token='H'.repeat(43);
  const user={id:1,email:'e2e@example.test',name:'E2E Tester',is_admin:false,is_available:true};
  let prepareStarted=false;
  let releasePrepare:(()=>void)|undefined;
  const prepareGate=new Promise<void>(resolve=>{ releasePrepare=resolve; });
  await mockApi(page,{
    '/api/auth/capabilities':verifiedInviteCapabilities,
    '/api/auth/me':{ok:true,user},
    '/api/invitations/prepare':async()=>{
      prepareStarted=true;
      await prepareGate;
      return {ok:true,binding:inviteBinding,expires_in_seconds:600};
    },
  });
  await resetClientState(page,true);
  await page.goto(`/invite#invite=${token}`,{waitUntil:'domcontentloaded'});
  await expect.poll(()=>prepareStarted).toBe(true);
  await expect(page.locator('#meLabel')).toContainText('E2E Tester');

  releasePrepare?.();
  await expect(page.getByTestId('invite-status')).toContainText('Invitation verified');
  await expect(page.getByTestId('invite-continue')).toBeEnabled();
  expect(await page.evaluate(()=>sessionStorage.getItem('randori-invite-binding-v1'))).toBe(inviteBinding);
});

test('invite-bound actions wait for authoritative identity hydration',async({page})=>{
  const token='A'.repeat(43);
  const user={id:1,email:'e2e@example.test',name:'E2E Tester',is_admin:false,is_available:true};
  let meStarted=false;
  let releaseMe:(()=>void)|undefined;
  let providerStarts=0;
  const meGate=new Promise<void>(resolve=>{ releaseMe=resolve; });
  await mockApi(page,{
    '/api/auth/capabilities':privateBetaCapabilities,
    '/api/auth/me':async()=>{
      meStarted=true;
      await meGate;
      return {ok:true,user};
    },
    '/api/invitations/prepare':{ok:true,binding:inviteBinding,expires_in_seconds:600},
    '/api/auth/google/start':request=>{
      providerStarts+=1;
      expect(request.postDataJSON()).toEqual({purpose:'invite',invite_binding:inviteBinding});
      return {ok:true,authorizationUrl:'https://accounts.google.com/o/oauth2/v2/auth?state=hydrated'};
    },
  });
  await page.route('https://accounts.google.com/**',route=>route.fulfill({
    status:200,contentType:'text/html',body:'<!doctype html><h1>Mock Google</h1>',
  }));
  await resetClientState(page,true);
  await page.goto(`/invite#invite=${token}`,{waitUntil:'domcontentloaded'});

  await expect(page.getByTestId('invite-status')).toContainText('Checking your account session');
  await expect(page.getByTestId('invite-continue')).toBeDisabled();
  await expect.poll(()=>meStarted).toBe(true);
  expect(providerStarts).toBe(0);

  releaseMe?.();
  await expect(page.locator('#meLabel')).toContainText('E2E Tester');
  await expect(page.getByTestId('invite-continue')).toBeEnabled();
  await page.getByTestId('invite-continue').click();
  await expect(page.getByRole('heading',{name:'Mock Google'})).toBeVisible();
  expect(providerStarts).toBe(1);
});

test('a prepare response arriving after its advertised lifetime stores no stale binding',async({page})=>{
  const token='T'.repeat(43);
  let releasePrepare:(()=>void)|undefined;
  const prepareGate=new Promise<void>(resolve=>{ releasePrepare=resolve; });
  await page.addInitScript(()=>{
    (window as any).__inviteTestNow=100;
    Object.defineProperty(performance,'now',{
      configurable:true,
      value:()=>Number((window as any).__inviteTestNow),
    });
  });
  await mockApi(page,{
    '/api/auth/capabilities':verifiedInviteCapabilities,
    '/api/invitations/prepare':async()=>{
      await prepareGate;
      return {ok:true,binding:inviteBinding,expires_in_seconds:1};
    },
  });
  await resetClientState(page,false,{},true);
  await page.goto(`/invite#invite=${token}`,{waitUntil:'domcontentloaded'});

  await page.evaluate(()=>{ (window as any).__inviteTestNow=1_101; });
  releasePrepare?.();

  await expect(page.getByTestId('invite-status')).toContainText('expired');
  await expect(page.getByTestId('invite-continue')).toBeDisabled();
  expect(await page.evaluate(()=>sessionStorage.getItem('randori-invite-binding-v1'))).toBeNull();
});

test('invite expiry aborts an in-flight signup and fences its delayed success response',async({page})=>{
  const token='E'.repeat(43);
  let signupCalls=0;
  let signupResponseReady=false;
  let releaseSignup:(()=>void)|undefined;
  const signupGate=new Promise<void>(resolve=>{ releaseSignup=resolve; });
  await page.clock.install();
  await page.addInitScript(()=>{
    (window as any).__inviteSignupAbortObserved=false;
    const originalFetch=window.fetch.bind(window);
    window.fetch=(input,init)=>{
      const requestUrl=new URL(input instanceof Request?input.url:String(input),window.location.href);
      if(requestUrl.pathname==='/api/auth/signup'&&init?.signal){
        init.signal.addEventListener('abort',()=>{
          (window as any).__inviteSignupAbortObserved=true;
        },{once:true});
      }
      return originalFetch(input,init);
    };
  });
  await mockApi(page,{
    '/api/auth/capabilities':verifiedInviteCapabilities,
    '/api/invitations/prepare':{ok:true,binding:inviteBinding,expires_in_seconds:60},
    '/api/auth/signup':async()=>{
      signupCalls+=1;
      await signupGate;
      signupResponseReady=true;
      return {_status:202,ok:true,pending:true};
    },
  });
  await resetClientState(page);
  await page.goto(`/invite#invite=${token}`,{waitUntil:'domcontentloaded'});
  await page.evaluate(()=>(window as any)._randori_auth.refreshMe());
  await page.getByTestId('invite-continue').click();
  await page.locator('#authEmail').fill('invited@example.test');
  await page.locator('#authName').fill('Invited Member');
  await page.locator('#authPass').fill('correct horse battery');
  await page.locator('#authSignup').click();
  await expect.poll(()=>signupCalls).toBe(1);
  await expect(page.locator('#authForm')).toHaveAttribute('aria-busy','true');

  await page.clock.fastForward(60_100);
  await expect(page.getByTestId('invite-status')).toContainText('expired');
  await expect.poll(()=>page.evaluate(()=>(window as any).__inviteSignupAbortObserved)).toBe(true);
  await expect(page.locator('#authForm')).toHaveAttribute('aria-busy','false');
  await expect(page.locator('#authSignup')).toBeHidden();
  releaseSignup?.();
  await expect.poll(()=>signupResponseReady).toBe(true);
  await expect(page.getByTestId('activation-pending')).toBeHidden();
  expect(await page.evaluate(()=>sessionStorage.getItem('randori-invite-binding-v1'))).toBeNull();
});

test('a stale resend completion cannot clear or overwrite a newer modal request',async({page})=>{
  const token='S'.repeat(43);
  let resendCalls=0;
  let firstResponseReady=false;
  let secondResponseReady=false;
  let releaseFirst:(()=>void)|undefined;
  let releaseSecond:(()=>void)|undefined;
  const firstGate=new Promise<void>(resolve=>{ releaseFirst=resolve; });
  const secondGate=new Promise<void>(resolve=>{ releaseSecond=resolve; });
  await mockApi(page,{
    '/api/auth/capabilities':verifiedInviteCapabilities,
    '/api/invitations/prepare':{ok:true,binding:inviteBinding,expires_in_seconds:600},
    '/api/auth/signup':{_status:202,ok:true,pending:true},
    '/api/auth/activation/resend':async request=>{
      const call=++resendCalls;
      expect(request.postDataJSON()).toEqual({email:'invited@example.test',invite_binding:inviteBinding});
      await (call===1?firstGate:secondGate);
      if(call===1) firstResponseReady=true;
      else secondResponseReady=true;
      return {_status:202,ok:true,pending:true};
    },
  });
  await resetClientState(page);
  await page.goto(`/invite#invite=${token}`,{waitUntil:'domcontentloaded'});
  await page.getByTestId('invite-continue').click();
  await page.locator('#authEmail').fill('invited@example.test');
  await page.locator('#authName').fill('Invited Member');
  await page.locator('#authPass').fill('correct horse battery');
  await page.locator('#authSignup').click();
  await expect(page.getByTestId('activation-pending')).toBeVisible();

  await page.locator('#authActivationResend').click();
  await expect.poll(()=>resendCalls).toBe(1);
  await page.locator('#authCancel').click();
  await page.getByTestId('invite-continue').click();
  await expect(page.getByTestId('activation-pending')).toBeVisible();
  await page.locator('#authActivationResend').click();
  await expect.poll(()=>resendCalls).toBe(2);
  await expect(page.locator('#authForm')).toHaveAttribute('aria-busy','true');

  releaseFirst?.();
  await expect.poll(()=>firstResponseReady).toBe(true);
  await expect(page.locator('#authForm')).toHaveAttribute('aria-busy','true');
  await expect(page.locator('#authErr')).toBeEmpty();
  releaseSecond?.();
  await expect.poll(()=>secondResponseReady).toBe(true);
  await expect(page.locator('#authForm')).toHaveAttribute('aria-busy','false');
  await expect(page.locator('#authErr')).toContainText('remains eligible');
});

test('verification landing renders success and terminal link states without exposing the token',async({page})=>{
  const token='B'.repeat(43);
  let verificationStatus='verified';
  await mockApi(page,{
    '/api/auth/activation/verify':request=>{
      expect(request.postDataJSON()).toEqual({token});
      return verificationStatus==='verified'
        ?{ok:true,status:'verified',user:{id:8,email:'verified@example.test',name:'Verified Member',color:'#123456'}}
        :{_status:409,ok:false,status:verificationStatus};
    },
  });
  await resetClientState(page);
  await page.goto(`/verify#token=${token}`,{waitUntil:'domcontentloaded'});
  await expect(page).toHaveURL(/\/verify$/);
  await expect(page.getByTestId('activation-status')).toContainText('account is ready');
  await expect(page.getByTestId('activation-continue')).toBeVisible();

  for(const status of ['expired','used','revoked']){
    verificationStatus=status;
    await page.goto(`/verify?state=${status}#token=${token}`,{waitUntil:'domcontentloaded'});
    await expect(page.getByTestId('activation-status')).toContainText(
      status==='expired'?'expired':status==='used'?'already been used':'no longer available',
    );
  }
});

test('a temporary verification failure retains the scrubbed token only in memory for explicit retry',async({page})=>{
  const token='C'.repeat(43);
  let attempts=0;
  await mockApi(page,{
    '/api/auth/activation/verify':request=>{
      attempts+=1;
      expect(request.postDataJSON()).toEqual({token});
      return attempts===1
        ?{_status:503,error:'email activation temporarily unavailable'}
        :{ok:true,status:'verified',user:{id:9,email:'retry@example.test',name:'Retry Member',color:'#654321'}};
    },
  });
  await resetClientState(page);
  await page.goto(`/verify#token=${token}`,{waitUntil:'domcontentloaded'});
  await expect(page).toHaveURL(/\/verify$/);
  await expect(page.getByTestId('activation-status')).toContainText('temporarily unavailable');
  await expect(page.getByTestId('activation-continue')).toHaveText('Retry verification');
  await page.getByTestId('activation-continue').click();
  await expect(page.getByTestId('activation-status')).toContainText('account is ready');
  expect(attempts).toBe(2);
});

test('sign-in offers an enumeration-safe password reset request',async({page})=>{
  let requests=0;
  await mockApi(page,{
    '/api/auth/capabilities':recoveryCapabilities,
    '/api/auth/password-reset/request':request=>{
      requests+=1;
      expect(request.postDataJSON()).toEqual({email:'member@example.test'});
      return {_status:202,ok:true,pending:true,
        message:'If that account can use password recovery, a reset email will arrive shortly.'};
    },
  });
  await resetClientState(page);
  await page.goto('/',{waitUntil:'domcontentloaded'});
  await page.locator('#landingSignin').click();
  await expect(page.locator('#authForgot')).toBeVisible();
  await page.locator('#authForgot').click();
  await expect(page.getByRole('dialog',{name:'Reset your password'})).toBeVisible();
  await expect(page.locator('#authPasswordField')).toBeHidden();
  await page.locator('#authEmail').fill('MEMBER@example.test');
  await page.locator('#authResetRequest').click();
  await expect(page.locator('#authErr')).toContainText('If that account is eligible');
  expect(requests).toBe(1);
  await page.locator('#authModeSwitch').click();
  await expect(page.getByRole('dialog',{name:'Sign in to Randori'})).toBeVisible();
});

test('password reset landing scrubs the fragment and submits a matching policy-compliant password',async({page})=>{
  const token='R'.repeat(43);
  let calls=0;
  await mockApi(page,{
    '/api/auth/password-reset/consume':request=>{
      calls+=1;
      expect(request.postDataJSON()).toEqual({token,password:'replacement password'});
      return {ok:true,status:'reset'};
    },
  });
  await resetClientState(page);
  await page.goto(`/reset-password#token=${token}`,{waitUntil:'domcontentloaded'});
  await expect(page).toHaveURL(/\/reset-password$/);
  await expect(page.getByTestId('password-reset-landing')).toBeVisible();
  await page.locator('#passwordResetNew').fill('short');
  await page.locator('#passwordResetConfirm').fill('short');
  await page.locator('#passwordResetSubmit').click();
  await page.evaluate(()=>(window as any)._randori_password_reset_flow.show());
  await expect(page.getByTestId('password-reset-status')).toContainText('10–72 UTF-8 bytes');
  await expect(page.locator('#passwordResetSubmit')).toBeEnabled();
  expect(calls).toBe(0);
  await page.locator('#passwordResetNew').fill('replacement password');
  await page.locator('#passwordResetConfirm').fill('different password');
  await page.locator('#passwordResetSubmit').click();
  await page.evaluate(()=>(window as any)._randori_password_reset_flow.show());
  await expect(page.getByTestId('password-reset-status')).toContainText('do not match');
  await expect(page.locator('#passwordResetSubmit')).toBeEnabled();
  expect(calls).toBe(0);
  await page.locator('#passwordResetConfirm').fill('replacement password');
  await page.locator('#passwordResetSubmit').click();
  await expect(page.getByTestId('password-reset-status')).toContainText('all existing sessions were signed out');
  await expect(page.locator('#passwordResetSignin')).toBeVisible();
  expect(calls).toBe(1);
});

test('expired and revoked password reset links expose a terminal recovery path',async({page})=>{
  const token='T'.repeat(43);
  let terminalStatus='expired';
  await mockApi(page,{
    '/api/auth/password-reset/consume':()=>({
      _status:409,ok:false,status:terminalStatus,
    }),
  });
  await resetClientState(page);

  for(const status of ['expired','revoked']){
    terminalStatus=status;
    await page.goto(`/reset-password?state=${status}#token=${token}`,{waitUntil:'domcontentloaded'});
    await page.locator('#passwordResetNew').fill('replacement password');
    await page.locator('#passwordResetConfirm').fill('replacement password');
    await page.locator('#passwordResetSubmit').click();
    await expect(page.getByTestId('password-reset-status')).toContainText(
      status==='expired'?'expired':'no longer available',
    );
    await expect(page.locator('#passwordResetNew')).toBeHidden();
    await expect(page.locator('#passwordResetConfirm')).toBeHidden();
    await expect(page.locator('#passwordResetSubmit')).toBeHidden();
    await expect(page.locator('#passwordResetSignin')).toBeVisible();
  }
});

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
  const logoutAll=page.getByRole('menuitem',{name:'Sign out everywhere'});
  await expect(logoutAll).toBeVisible();
  const reloaded=page.waitForEvent('load');
  await logoutAll.click();
  await expect.poll(()=>logoutAllCalls).toBe(1);
  await reloaded;
  await expect(page.locator('#authBtn')).toBeVisible();
  expect(await page.evaluate(()=>(window as any)._randori_auth.me)).toBeNull();
  await expect.poll(()=>page.evaluate(()=>localStorage.getItem('randori-me'))).toBeNull();
});

test('account security requires recent auth and never removes the final credential',async({page})=>{
  const user={id:1,email:'e2e@example.test',name:'E2E Tester',is_admin:false,is_available:true};
  let recent=false;
  let googleLinked=true;
  let confirmationCalls=0;
  let unlinkCalls=0;
  const identity=()=>({
    ok:true,
    identity:{
      accountEmail:user.email,
      password:{linked:true,canAdd:false,canUnlink:googleLinked},
      google:{linked:googleLinked,canLink:!googleLinked,canUnlink:googleLinked},
      recentAuth:recent?{ok:true,method:'password',authenticatedAt:1,expiresAt:2}:{ok:false,reason:'recent_auth_required'},
    },
  });
  await mockApi(page,{
    '/api/auth/capabilities':privateBetaCapabilities,
    '/api/auth/me':{ok:true,user},
    '/api/auth/identities':()=>identity(),
    '/api/auth/recent-auth':request=>{
      confirmationCalls+=1;
      expect(request.postDataJSON()).toEqual({password:'correct password'});
      recent=true;
      return {ok:true,recentAuth:{ok:true,method:'password'}};
    },
    '/api/auth/identities/google':request=>{
      unlinkCalls+=1;
      expect(request.postDataJSON()).toEqual({action:'unlink'});
      googleLinked=false;
      return {...identity(),status:'unlinked'};
    },
  });
  await resetClientState(page,true);
  await page.goto('/',{waitUntil:'domcontentloaded'});
  await page.locator('#meLabel').click();
  await page.getByRole('menuitem',{name:'Account security'}).click();
  const dialog=page.getByRole('dialog',{name:'Account security'});
  await expect(dialog).toBeVisible();
  await page.locator('#identityClose').focus();
  await page.keyboard.press('Tab');
  await expect(page.locator('#identityPasswordConfirm')).toBeFocused();
  await expect(page.getByTestId('identity-status')).toContainText('Choose a sign-in method');
  await expect(page.locator('#identityRecent')).toBeVisible();
  await expect(page.locator('#identityGoogleAction')).toBeDisabled();
  await page.locator('#identityPasswordConfirm').fill('correct password');
  await page.locator('#identityConfirmPassword').click();
  await expect(page.locator('#identityRecent')).toBeHidden();
  await expect(page.locator('#identityGoogleAction')).toBeEnabled();
  page.once('dialog',nativeDialog=>nativeDialog.accept());
  await page.locator('#identityGoogleAction').click();
  await expect(page.locator('#identityGoogleState')).toHaveText('not linked');
  await expect(page.locator('#identityPasswordAction')).toBeDisabled();
  await expect(page.locator('#identityPasswordHelp')).toContainText('final sign-in method');
  expect(confirmationCalls).toBe(1);
  expect(unlinkCalls).toBe(1);
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
});

test('account security starts Google reauthentication through same-origin POST before navigation',async({page})=>{
  const user={id:1,email:'e2e@example.test',name:'E2E Tester',is_admin:false,is_available:true};
  let starts=0;
  await mockApi(page,{
    '/api/auth/capabilities':privateBetaCapabilities,
    '/api/auth/me':{ok:true,user},
    '/api/auth/identities':{ok:true,identity:{
      accountEmail:user.email,
      password:{linked:true,canAdd:false,canUnlink:true},
      google:{linked:true,canLink:false,canUnlink:true},
      recentAuth:{ok:false,reason:'recent_auth_required'},
    }},
    '/api/auth/google/reauth/start':request=>{
      starts+=1;
      expect(request.method()).toBe('POST');
      expect(request.postDataJSON()).toEqual({});
      return {ok:true,authorizationUrl:'https://accounts.google.com/o/oauth2/v2/auth?state=e2e'};
    },
  });
  await page.route('https://accounts.google.com/**',route=>route.fulfill({
    status:200,contentType:'text/html',body:'<!doctype html><title>Google confirmation</title>',
  }));
  await resetClientState(page,true);
  await page.goto('/',{waitUntil:'domcontentloaded'});
  await expect(page.locator('#meLabel')).toContainText('E2E Tester');
  await page.locator('#meLabel').click();
  await page.getByRole('menuitem',{name:'Account security'}).click();
  await page.getByRole('button',{name:'Confirm with Google'}).click();
  await expect(page).toHaveURL('https://accounts.google.com/o/oauth2/v2/auth?state=e2e');
  expect(starts).toBe(1);
});

test('closing and reopening account security invalidates a delayed Google start response',async({page})=>{
  const user={id:1,email:'e2e@example.test',name:'E2E Tester',is_admin:false,is_available:true};
  let releaseStart!:()=>void;
  let markStart!:()=>void;
  const startGate=new Promise<void>(resolve=>{ releaseStart=resolve; });
  const startBegan=new Promise<void>(resolve=>{ markStart=resolve; });
  let starts=0;
  // Exercise the generation guard even if a transport cannot cancel a request
  // that has already reached the server.
  await page.addInitScript(()=>{ AbortController.prototype.abort=function(){}; });
  await mockApi(page,{
    '/api/auth/capabilities':privateBetaCapabilities,
    '/api/auth/me':{ok:true,user},
    '/api/auth/identities':{ok:true,identity:{
      accountEmail:user.email,
      password:{linked:true,canAdd:false,canUnlink:true},
      google:{linked:true,canLink:false,canUnlink:true},
      recentAuth:{ok:false,reason:'recent_auth_required'},
    }},
    '/api/auth/google/reauth/start':async()=>{
      starts+=1;
      markStart();
      await startGate;
      return {ok:true,authorizationUrl:'https://accounts.google.com/o/oauth2/v2/auth?state=stale'};
    },
  });
  await resetClientState(page,true);
  await page.goto('/',{waitUntil:'domcontentloaded'});
  await page.locator('#meLabel').click();
  await page.getByRole('menuitem',{name:'Account security'}).click();
  await page.getByRole('button',{name:'Confirm with Google'}).click();
  await startBegan;
  await page.locator('#identityClose').click();
  await page.locator('#meLabel').click();
  await page.getByRole('menuitem',{name:'Account security'}).click();
  const dialog=page.getByRole('dialog',{name:'Account security'});
  await expect(dialog).toBeVisible();
  const response=page.waitForResponse(value=>new URL(value.url()).pathname==='/api/auth/google/reauth/start');
  releaseStart();
  await response;
  await page.evaluate(()=>new Promise<void>(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>resolve()))));
  await expect(page).toHaveURL('/');
  await expect(dialog).toBeVisible();
  await expect(page.getByTestId('identity-status')).toHaveText('Choose a sign-in method to manage.');
  expect(starts).toBe(1);
});

test('a Google-only account can add a validated password after verified Google control',async({page})=>{
  const user={id:1,email:'e2e@example.test',name:'E2E Tester',is_admin:false,is_available:true};
  let passwordLinked=false;
  let addCalls=0;
  const identity=()=>({
    accountEmail:user.email,
    password:{linked:passwordLinked,canAdd:!passwordLinked,canUnlink:passwordLinked},
    google:{linked:true,canLink:false,canUnlink:passwordLinked},
    recentAuth:{ok:true,method:'google',authenticatedAt:1,expiresAt:2},
  });
  await mockApi(page,{
    '/api/auth/capabilities':privateBetaCapabilities,
    '/api/auth/me':{ok:true,user},
    '/api/auth/identities':()=>({ok:true,identity:identity()}),
    '/api/auth/identities/password':request=>{
      addCalls+=1;
      expect(request.postDataJSON()).toEqual({action:'add',password:'new linked password'});
      passwordLinked=true;
      return {ok:true,status:'linked',identity:identity()};
    },
  });
  await resetClientState(page,true);
  await page.goto('/',{waitUntil:'domcontentloaded'});
  await page.locator('#meLabel').click();
  await page.getByRole('menuitem',{name:'Account security'}).click();
  await expect(page.locator('#identityPasswordAdd')).toBeVisible();
  await page.locator('#identityNewPassword').fill('new linked password');
  await page.locator('#identityNewPasswordConfirm').fill('different password');
  await page.locator('#identityPasswordAction').click();
  await expect(page.getByTestId('identity-status')).toContainText('Passwords do not match');
  expect(addCalls).toBe(0);
  await page.locator('#identityNewPasswordConfirm').fill('new linked password');
  await page.locator('#identityPasswordAction').click();
  await expect(page.locator('#identityPasswordState')).toHaveText('linked');
  await expect(page.locator('#identityGoogleAction')).toBeEnabled();
  expect(addCalls).toBe(1);
});

test('private beta capabilities reserve direct entry for existing members', async ({ page }) => {
  await mockApi(page, { '/api/auth/capabilities': privateBetaCapabilities });
  await resetClientState(page);
  await page.goto('/', { waitUntil: 'domcontentloaded' });

  await expect(page.locator('#landingSignup')).toBeDisabled();
  await expect(page.locator('#landingInviteHelp')).toContainText('Open the invitation link');
  await page.locator('#landingSignin').click();
  await expect(page.getByRole('dialog', { name: 'Sign in to Randori' })).toBeVisible();
  await expect(page.locator('#authGoogle')).toBeVisible();
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
    expect(route.request().method()).toBe('GET');
    expect(new URL(route.request().url()).searchParams.get('purpose')).toBe('login');
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
