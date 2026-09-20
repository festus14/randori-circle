import { expect, test } from '@playwright/test';
import { mockApi, resetClientState } from './helpers';

const owner = {
  id: 1,
  email: 'owner@example.test',
  name: 'Circle Owner',
  display_name: 'Circle Owner',
  color: '#c8f6a0',
  is_admin: false,
  is_available: true,
  tz: 'Europe/London',
  interview_focus: 'both',
};

const members = [
  { id: 1, display_name: 'Circle Owner', name: 'Circle Owner', color: '#c8f6a0', is_available: true, isAvailable: true, bio: '', tz: 'Europe/London', interview_focus: 'both', leetcode_handle: '', source: 'auth' },
  { id: 2, display_name: 'Team Mate', name: 'Team Mate', color: '#a9b6ff', is_available: false, isAvailable: false, bio: '', tz: 'UTC', interview_focus: 'dsa', leetcode_handle: '', source: 'auth' },
];
const inviteBinding = 'I'.repeat(43);

function circleResponse(role: 'owner' | 'member') {
  return {
    ok: true,
    circle_meta: { id: 11, public_id: 'circle_private', name: 'Private Practice' },
    membership: { role },
    circle: members,
    count: members.length,
  };
}

test('fragment invitation is scrubbed before third-party code and prepared exactly once without persistence', async ({ page }) => {
  const token = 'A'.repeat(43);
  const prepareBodies: unknown[] = [];
  const requests: Array<{ url: string; body: string }> = [];
  const consoleMessages: string[] = [];
  page.on('request', request => requests.push({ url: request.url(), body: request.postData() || '' }));
  page.on('console', message => consoleMessages.push(message.text()));
  await page.route('https://js-de.sentry-cdn.com/**', route => route.fulfill({
    status: 200,
    contentType: 'application/javascript',
    body: `(()=>{
      const secret=${JSON.stringify(token)};
      const stringGlobals=Object.getOwnPropertyNames(window).flatMap(key=>{
        try{ const value=window[key]; return typeof value==='string'?[value]:[]; }catch{ return []; }
      });
      window.__thirdPartyInviteProbe={
        location:window.location.href,
        legacyAccessor:typeof window.__randoriTakeInviteBootstrap,
        preparationType:typeof window.__randoriInvitePreparation,
        leaked:stringGlobals.some(value=>value.includes(secret))
          ||Object.values(localStorage).some(value=>value.includes(secret))
          ||Object.values(sessionStorage).some(value=>value.includes(secret)),
      };
    })();`,
  }));
  await mockApi(page, {
    '/api/invitations/prepare': request => {
      prepareBodies.push(request.postDataJSON());
      return { ok: true, binding: inviteBinding, expires_in_seconds: 600 };
    },
    '/api/auth/google/start': request => {
      expect(request.method()).toBe('POST');
      expect(new URL(request.url()).searchParams.get('return_to')).toBe('/invite');
      expect(request.postDataJSON()).toEqual({ purpose: 'invite', invite_binding: inviteBinding });
      return { ok: true, authorizationUrl: 'https://accounts.google.com/o/oauth2/v2/auth?state=invite-state' };
    },
  });
  await page.route('https://accounts.google.com/o/oauth2/v2/auth**', route => route.fulfill({
    status: 200,
    contentType: 'text/html',
    body: '<!doctype html><title>Mock Google</title>',
  }));
  await resetClientState(page);

  await page.goto(`/invite#invite=${token}`, { waitUntil: 'domcontentloaded' });
  await expect(page).toHaveURL(/\/invite$/);
  await expect(page.getByTestId('invite-landing')).toBeVisible();
  await expect(page.getByTestId('invite-status')).toContainText('Invitation verified');
  await expect(page.getByTestId('invite-continue')).toBeEnabled();
  await expect.poll(() => prepareBodies.length).toBe(1);
  expect(prepareBodies).toEqual([{ token }]);
  const thirdPartyProbe = await page.evaluate(() => (window as typeof window & {
    __thirdPartyInviteProbe?: { location: string; legacyAccessor: string; preparationType: string; leaked: boolean };
  }).__thirdPartyInviteProbe);
  expect(thirdPartyProbe).toEqual({
    location: expect.not.stringContaining(token),
    legacyAccessor: 'undefined',
    preparationType: 'object',
    leaked: false,
  });
  expect(await page.locator('html').textContent()).not.toContain(token);
  expect((await page.evaluate(() => [
    ...Object.values(localStorage),
    ...Object.values(sessionStorage),
  ])).join('\n')).not.toContain(token);
  expect((await page.context().cookies()).map(cookie => `${cookie.name}=${cookie.value}`).join(';')).not.toContain(token);
  expect(requests.filter(request => request.url.includes(token))).toEqual([]);
  expect(requests.filter(request => request.body.includes(token))).toEqual([
    expect.objectContaining({ url: expect.stringContaining('/api/invitations/prepare') }),
  ]);
  expect(consoleMessages.join('\n')).not.toContain(token);

  const googleStart = page.waitForRequest(request => new URL(request.url()).pathname === '/api/auth/google/start');
  await page.getByTestId('invite-continue').click();
  const request = await googleStart;
  expect(request.url()).not.toContain(token);
  expect(request.method()).toBe('POST');
  expect(new URL(request.url()).searchParams.get('return_to')).toBe('/invite');
  expect(request.postDataJSON()).toEqual({ purpose: 'invite', invite_binding: inviteBinding });
  expect(prepareBodies).toHaveLength(1);
});

test('an invited member completes the mocked Google provider journey to an authenticated dashboard',async({page})=>{
  const token='C'.repeat(43);
  let prepared=0;
  let providerStarts=0;
  let callbacks=0;
  let appOrigin='';
  const invitedUser={
    id:7,email:'invited@example.test',name:'Invited Member',display_name:'Invited Member',
    color:'#9cc0b5',is_admin:false,is_available:true,tz:'Europe/London',interview_focus:'both',
  };
  await mockApi(page,{
    '/api/invitations/prepare':()=>{
      prepared+=1;
      return {ok:true,binding:inviteBinding,expires_in_seconds:600};
    },
    '/api/auth/google/start':request=>{
      providerStarts+=1;
      expect(request.method()).toBe('POST');
      expect(new URL(request.url()).searchParams.get('return_to')).toBe('/invite');
      expect(request.postDataJSON()).toEqual({purpose:'invite',invite_binding:inviteBinding});
      return {ok:true,authorizationUrl:'https://accounts.google.com/o/oauth2/v2/auth?state=mock-state'};
    },
    '/api/auth/me':async request=>/(?:^|;\s*)randori_session=mocked-provider-session(?:;|$)/
      .test((await request.headerValue('cookie'))||'')
      ?{ok:true,user:invitedUser}
      :{_status:401,ok:false,error:'authentication required'},
    '/api/circle':async request=>/(?:^|;\s*)randori_session=mocked-provider-session(?:;|$)/
      .test((await request.headerValue('cookie'))||'')
      ?circleResponse('member')
      :{_status:401,error:'authentication required'},
  });
  await page.route('https://accounts.google.com/**',route=>route.fulfill({
    status:200,contentType:'text/html',
    body:`<!doctype html><html><body><h1>Mock Google</h1><button onclick="location.href='${appOrigin}/api/auth/google/callback?code=one-time-code&state=mock-state'">Continue as invited@example.test</button></body></html>`,
  }));
  await page.route('**/api/auth/google/callback**',async route=>{
    callbacks+=1;
    await route.fulfill({
      status:302,
      headers:{location:'/?google=success','set-cookie':'randori_session=mocked-provider-session; Path=/; HttpOnly; SameSite=Lax'},
      body:'',
    });
  });
  await resetClientState(page);

  await page.goto(`/invite#invite=${token}`,{waitUntil:'domcontentloaded'});
  appOrigin=new URL(page.url()).origin;
  await expect(page.getByTestId('invite-status')).toContainText('Invitation verified');
  await page.getByTestId('invite-continue').click();
  await expect(page.getByRole('heading',{name:'Mock Google'})).toBeVisible();
  await page.getByRole('button',{name:'Continue as invited@example.test'}).click();
  await expect(page).toHaveURL('/');
  await expect(page.locator('#meLabel')).toContainText('Invited Member');
  await expect(page.locator('#view-dashboard')).toBeVisible();
  expect(prepared).toBe(1);
  expect(providerStarts).toBe(1);
  expect(callbacks).toBe(1);
});

test('a cancelled invited Google attempt returns to the live invitation retry',async({page})=>{
  const token='G'.repeat(43);
  const prepareBodies:unknown[]=[];
  let providerStarts=0;
  let appOrigin='';
  await mockApi(page,{
    '/api/invitations/prepare':request=>{
      const body=request.postDataJSON();
      prepareBodies.push(body);
      return {ok:true,binding:inviteBinding,expires_in_seconds:600};
    },
    '/api/auth/google/start':request=>{
      providerStarts+=1;
      expect(request.method()).toBe('POST');
      expect(new URL(request.url()).searchParams.get('return_to')).toBe('/invite');
      expect(request.postDataJSON()).toEqual({purpose:'invite',invite_binding:inviteBinding});
      return {ok:true,authorizationUrl:`https://accounts.google.com/o/oauth2/v2/auth?state=invite-${providerStarts}`};
    },
  });
  await page.route('https://accounts.google.com/**',route=>route.fulfill({
    status:200,contentType:'text/html',
    body:`<!doctype html><html><body><h1>Mock Google</h1><button onclick="location.href='${appOrigin}/invite?google_error=access_denied'">Cancel Google sign-in</button></body></html>`,
  }));
  await resetClientState(page,false,{},true);

  await page.goto(`/invite#invite=${token}`,{waitUntil:'domcontentloaded'});
  appOrigin=new URL(page.url()).origin;
  await expect(page.getByTestId('invite-status')).toContainText('Invitation verified');
  await page.getByTestId('invite-continue').click();
  await expect(page.getByRole('heading',{name:'Mock Google'})).toBeVisible();
  await page.getByRole('button',{name:'Cancel Google sign-in'}).click();

  await expect(page).toHaveURL(/\/invite$/);
  await expect(page.getByRole('dialog',{name:'Join Randori Circle'})).toBeVisible();
  const retry=page.getByRole('button',{name:'Try Google sign-in again'});
  await expect(retry).toBeVisible();
  expect(prepareBodies).toEqual([{token},{binding:inviteBinding}]);

  const retryStart=page.waitForRequest(request=>new URL(request.url()).pathname==='/api/auth/google/start');
  await retry.click();
  const request=await retryStart;
  expect(request.method()).toBe('POST');
  expect(request.postDataJSON()).toEqual({purpose:'invite',invite_binding:inviteBinding});
  expect(providerStarts).toBe(2);
});

test('a failed invite Google start releases busy state before offering retry',async({page})=>{
  const token='F'.repeat(43);
  let providerStarts=0;
  await mockApi(page,{
    '/api/invitations/prepare':{ok:true,binding:inviteBinding,expires_in_seconds:600},
    '/api/auth/google/start':request=>{
      providerStarts+=1;
      expect(request.method()).toBe('POST');
      expect(request.postDataJSON()).toEqual({purpose:'invite',invite_binding:inviteBinding});
      if(providerStarts===1) return {_status:503,error:'Google sign-in is unavailable'};
      return {ok:true,authorizationUrl:'https://accounts.google.com/o/oauth2/v2/auth?state=retry'};
    },
  });
  await page.route('https://accounts.google.com/**',route=>route.fulfill({
    status:200,contentType:'text/html',body:'<!doctype html><h1>Mock Google retry</h1>',
  }));
  await resetClientState(page);
  await page.goto(`/invite#invite=${token}`,{waitUntil:'domcontentloaded'});

  await page.getByTestId('invite-continue').click();
  const retry=page.getByRole('button',{name:'Try Google sign-in again'});
  await expect(retry).toBeVisible();
  await expect(retry).toBeEnabled();
  await expect(page.locator('#authForm')).toHaveAttribute('aria-busy','false');

  await retry.click();
  await expect(page.getByRole('heading',{name:'Mock Google retry'})).toBeVisible();
  expect(providerStarts).toBe(2);
});

test('an invite OAuth error cannot downgrade to login while identity hydration is unavailable',async({page})=>{
  let meCalls=0;
  let googleStarts=0;
  await mockApi(page,{
    '/api/auth/me':()=>{
      meCalls+=1;
      return {_status:503,ok:false,error:'authentication temporarily unavailable'};
    },
    '/api/invitations/prepare':request=>{
      expect(request.postDataJSON()).toEqual({binding:inviteBinding});
      return {ok:true,binding:inviteBinding,expires_in_seconds:600};
    },
    '/api/auth/google/start':()=>{
      googleStarts+=1;
      return {ok:true,authorizationUrl:'https://accounts.google.com/o/oauth2/v2/auth?state=unsafe-login'};
    },
  });
  await resetClientState(page,false,{},true);
  await page.goto('/',{waitUntil:'domcontentloaded'});
  await page.evaluate(binding=>sessionStorage.setItem('randori-invite-binding-v1',binding),inviteBinding);
  meCalls=0;

  await page.goto('/invite?google_error=access_denied',{waitUntil:'domcontentloaded'});

  await expect(page.getByTestId('invite-status')).toContainText('could not be verified');
  await expect(page.getByTestId('invite-continue')).toBeDisabled();
  await expect(page.locator('#authGoogleRetry')).toBeHidden();
  await expect.poll(()=>meCalls).toBeGreaterThanOrEqual(3);
  expect(googleStarts).toBe(0);

  await page.locator('#authBtn').click();
  await expect(page.getByRole('dialog',{name:'Sign in to Randori'})).toBeVisible();
  await expect(page.locator('#authGoogleRetry')).toBeHidden();
  await expect(page.locator('#authGoogle')).toBeVisible();
  expect(googleStarts).toBe(0);
});

test('circle owner can view members, create a private copy action, and revoke invitations', async ({ page }) => {
  const rawInvite = 'B'.repeat(43);
  const resentInvite = 'D'.repeat(43);
  const firstInvitationId = '11111111-1111-4111-8111-111111111111';
  const secondInvitationId = '22222222-2222-4222-8222-222222222222';
  const invitationRows = [{
    id: firstInvitationId,
    email_fingerprint: 'a1b2c3d4e5f6',
    status: 'pending',
    expires_at: '2026-09-25T12:00:00.000Z',
    created_at: '2026-09-18T12:00:00.000Z',
    used_at: null,
    revoked_at: null,
  }];
  const creates: unknown[] = [];
  const revokedIds: string[] = [];
  const resentIds: string[] = [];
  let copiedInvite = '';
  await page.exposeFunction('captureInviteCopy', (value: string) => { copiedInvite = value; });
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: {
        writeText: (value: string) => (window as typeof window & {
          captureInviteCopy: (copied: string) => Promise<void>;
        }).captureInviteCopy(value),
      },
    });
  });
  await mockApi(page, {
    '/api/auth/me': { ok: true, user: owner },
    '/api/circle': circleResponse('owner'),
    '/api/invitations': async request => {
      if (request.method() === 'POST') {
        creates.push(request.postDataJSON());
        invitationRows.push({
          id: secondInvitationId,
          email_fingerprint: 'f6e5d4c3b2a1',
          status: 'pending',
          expires_at: '2026-09-25T12:05:00.000Z',
          created_at: '2026-09-18T12:05:00.000Z',
          used_at: null,
          revoked_at: null,
        });
        return {
          _status: 201,
          ok: true,
          invitation: { ...invitationRows.at(-1), email: 'new.member@example.test', invite_url: `/invite#invite=${rawInvite}` },
        };
      }
      return { ok: true, invitations: invitationRows, count: invitationRows.length };
    },
    '/api/invitations/:id': request => {
      const id = new URL(request.url()).pathname.split('/').at(-1) || '';
      if (request.method() === 'POST') {
        resentIds.push(id);
        return { ok: true, invitation: { id, status: 'pending',
          expires_at: '2026-09-25T12:05:00.000Z', invite_url: `/invite#invite=${resentInvite}` },
        email_delivery: { queued: true } };
      }
      revokedIds.push(id);
      const invitation = invitationRows.find(row => String(row.id) === id);
      if (invitation) invitation.status = 'revoked';
      return { ok: true, id, status: 'revoked' };
    },
  });
  await resetClientState(page, true);

  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await expect(page.locator('#meLabel')).toContainText('Circle Owner');
  await page.locator('[data-tab="circle"]').click();
  await expect(page.getByTestId('circle-members')).toContainText('Team Mate');
  await expect(page.getByTestId('circle-invite-email')).toBeVisible();
  await expect(page.getByTestId('circle-invites')).toContainText('a1b2c3d4e5f6');

  await page.getByTestId('circle-invite-email').fill('New.Member@Example.test');
  await page.getByTestId('circle-invite-create').click();
  await expect.poll(() => creates).toEqual([{ email: 'New.Member@Example.test' }]);
  await expect(page.getByTestId('circle-invite-link')).toBeVisible();
  expect(await page.locator('html').textContent()).not.toContain(rawInvite);
  expect((await page.evaluate(() => [...Object.values(localStorage), ...Object.values(sessionStorage)])).join('\n')).not.toContain(rawInvite);
  await page.getByTestId('circle-invite-link').click();
  await expect.poll(() => copiedInvite).toBe(new URL(`/invite#invite=${rawInvite}`, page.url()).href);

  await expect(page.getByTestId('circle-invites')).toContainText('f6e5d4c3b2a1');
  await expect(page.getByTestId('circle-invite-revoke')).toHaveCount(2);
  await expect(page.getByTestId('circle-invite-resend')).toHaveCount(2);
  await page.getByTestId('circle-invite-resend').last().click();
  await expect.poll(() => resentIds).toEqual([secondInvitationId]);
  await expect(page.getByTestId('circle-invite-link')).toBeVisible();
  copiedInvite='';
  await page.getByTestId('circle-invite-link').click();
  await expect.poll(() => copiedInvite).toBe(new URL(`/invite#invite=${resentInvite}`,page.url()).href);
  await page.getByTestId('circle-invite-revoke').last().click();
  await expect.poll(() => revokedIds).toEqual([secondInvitationId]);
  await expect(page.getByTestId('circle-invite-link')).toBeHidden();
  await expect(page.getByTestId('circle-invites')).toContainText('revoked');
});

test('multi-circle selection reloads into the chosen isolated roster and invitations',async({page})=>{
  let active:'circle-primary'|'circle-secondary'|null=null;
  let contextVersion=0;
  const selections:unknown[]=[];
  let markSwitchStarted!:()=>void;
  let releaseSwitch!:()=>void;
  const switchStarted=new Promise<void>(resolve=>{ markSwitchStarted=resolve; });
  const switchGate=new Promise<void>(resolve=>{ releaseSwitch=resolve; });
  let markCapabilitiesStarted!:()=>void;
  let releaseCapabilities!:()=>void;
  const capabilitiesStarted=new Promise<void>(resolve=>{ markCapabilitiesStarted=resolve; });
  const capabilitiesGate=new Promise<void>(resolve=>{ releaseCapabilities=resolve; });
  let markProfileStarted!:()=>void;
  let releaseProfile!:()=>void;
  const profileStarted=new Promise<void>(resolve=>{ markProfileStarted=resolve; });
  const profileGate=new Promise<void>(resolve=>{ releaseProfile=resolve; });
  const primaryMember={...members[0],display_name:'Primary Owner',name:'Primary Owner'};
  const secondaryMember={...members[1],id:22,display_name:'Secondary Teammate',name:'Secondary Teammate'};
  await mockApi(page,{
    '/api/auth/capabilities':async()=>{
      markCapabilitiesStarted();
      await capabilitiesGate;
      return {
        ok:true,
        capabilities:{passwordLogin:true,passwordSignup:false,googleOAuth:true,multiCircleControlPlane:true},
        registrationMode:'private_beta',
      };
    },
    '/api/auth/me':{ok:true,user:owner},
    '/api/profile':async()=>{
      markProfileStarted();
      await profileGate;
      return {ok:true,user:owner};
    },
    '/api/circles':async request=>{
      if(request.method()==='PUT'){
        const body=request.postDataJSON();
        selections.push(body);
        markSwitchStarted();
        await switchGate;
        if(body.circle_public_id==='circle-secondary'&&body.expected_context_version===contextVersion){
          active='circle-secondary'; contextVersion+=1;
        }
      }
      const circles=[
        {id:10,public_id:'circle-primary',name:'Primary',role:'owner',is_primary:true},
        {id:20,public_id:'circle-secondary',name:'Secondary',role:'owner',is_primary:false},
      ];
      return {
        ok:true,circles,
        active_circle:active?circles.find(circle=>circle.public_id===active):null,
        context_version:contextVersion,selection_required:active===null,
      };
    },
    '/api/circle':()=>active==='circle-secondary'?{
      ok:true,circle_meta:{id:20,public_id:'circle-secondary',name:'Secondary'},
      membership:{role:'owner'},circle:[secondaryMember],count:1,circle_context_version:contextVersion,
    }:{_status:409,error:'select an active circle',code:'active_circle_required'},
    '/api/invitations':()=>({
      ok:true,invitations:active==='circle-secondary'?[{
        id:'22222222-2222-4222-8222-222222222222',email_fingerprint:'secondary123',
        status:'pending',expires_at:'2026-09-25T12:00:00.000Z',created_at:'2026-09-18T12:00:00.000Z',
      }]:[],count:active==='circle-secondary'?1:0,circle_context_version:contextVersion,
    }),
    '/api/members':()=>({
      ok:true,members:[secondaryMember],count:1,has_more:false,next_cursor:null,scanned:1,
      circle_context_version:contextVersion,
    }),
  });
  try{
    await resetClientState(page,true,{},true);
    await page.goto('/',{waitUntil:'domcontentloaded'});
    await capabilitiesStarted;
    await profileStarted;
    await page.locator('[data-tab="circle"]').click();
    releaseCapabilities();
    const selector=page.getByTestId('circle-context-select');
    await expect(selector).toBeVisible();
    await expect(selector).toHaveValue('');
    await expect(page.getByTestId('circle-members')).toContainText(/select one above/i);
    releaseProfile();
    await expect(page.locator('#view-circle')).toBeVisible();
    await expect(selector).toBeVisible();
    await page.locator('#pairsList').evaluate(element=>{ element.textContent='Primary private pairing'; });
    await page.locator('#historyList').evaluate(element=>{ element.textContent='Primary private history'; });

    const reloaded=page.waitForEvent('domcontentloaded');
    const selecting=selector.selectOption('circle-secondary');
    await switchStarted;
    await expect(page.getByTestId('circle-members')).toBeEmpty();
    await expect(page.locator('#pairsList')).toBeEmpty();
    await expect(page.locator('#historyList')).toBeEmpty();
    releaseSwitch();
    await selecting;
    await expect.poll(()=>selections).toEqual([{
      circle_public_id:'circle-secondary',expected_context_version:0,
    }]);
    await reloaded;
    await page.locator('[data-tab="circle"]').click();
    await expect(page.getByTestId('circle-context-select')).toHaveValue('circle-secondary');
    await expect(page.getByTestId('circle-members')).toContainText('Secondary Teammate');
    await expect(page.getByTestId('circle-members')).not.toContainText('Primary Owner');
    await expect(page.getByTestId('circle-invites')).toContainText('secondary123');
  }finally{
    releaseCapabilities();
    releaseProfile();
    releaseSwitch();
  }
});

for(const delayedAction of ['create','resend'] as const){
  test(`a delayed invitation ${delayedAction} cannot restore old-circle secrets during a switch`,async({page})=>{
    const invitationId='11111111-1111-4111-8111-111111111111';
    let active:'circle-primary'|'circle-secondary'='circle-primary';
    let contextVersion=1;
    let markActionStarted!:()=>void;
    let releaseAction!:()=>void;
    const actionStarted=new Promise<void>(resolve=>{ markActionStarted=resolve; });
    const actionGate=new Promise<void>(resolve=>{ releaseAction=resolve; });
    let markSwitchStarted!:()=>void;
    let releaseSwitch!:()=>void;
    const switchStarted=new Promise<void>(resolve=>{ markSwitchStarted=resolve; });
    const switchGate=new Promise<void>(resolve=>{ releaseSwitch=resolve; });
    const circles=[
      {id:10,public_id:'circle-primary',name:'Primary',role:'owner',is_primary:true},
      {id:20,public_id:'circle-secondary',name:'Secondary',role:'owner',is_primary:false},
    ];
    await mockApi(page,{
      '/api/auth/capabilities':{
        ok:true,capabilities:{passwordLogin:true,passwordSignup:false,googleOAuth:true,multiCircleControlPlane:true},
        registrationMode:'private_beta',
      },
      '/api/auth/me':{ok:true,user:owner},
      '/api/profile':{ok:true,user:owner},
      '/api/circles':async request=>{
        if(request.method()==='PUT'){
          markSwitchStarted();
          await switchGate;
          active='circle-secondary'; contextVersion=2;
        }
        return {ok:true,circles,active_circle:circles.find(circle=>circle.public_id===active),
          context_version:contextVersion,selection_required:false};
      },
      '/api/circle':()=>({
        ok:true,circle_meta:{id:active==='circle-primary'?10:20,public_id:active,name:active},
        membership:{role:'owner'},circle:active==='circle-primary'?members:[members[0]],
        count:active==='circle-primary'?2:1,circle_context_version:contextVersion,
      }),
      '/api/invitations':async request=>{
        if(request.method()==='POST'&&delayedAction==='create'){
          markActionStarted();
          await actionGate;
          return {_status:201,ok:true,invitation:{id:invitationId,status:'pending',
            invite_url:`/invite#invite=${'I'.repeat(43)}`},circle_context_version:1};
        }
        return {ok:true,invitations:active==='circle-primary'?[{
          id:invitationId,email_fingerprint:'primary-only',status:'pending',
          expires_at:'2026-09-25T12:00:00.000Z',created_at:'2026-09-18T12:00:00.000Z',
        }]:[],count:active==='circle-primary'?1:0,circle_context_version:contextVersion};
      },
      '/api/invitations/:id':async request=>{
        if(request.method()==='POST'&&delayedAction==='resend'){
          markActionStarted();
          await actionGate;
          return {ok:true,invitation:{id:invitationId,status:'pending',
            invite_url:`/invite#invite=${'R'.repeat(43)}`},circle_context_version:1};
        }
        return {_status:404,error:'invitation not found'};
      },
      '/api/members':()=>({ok:true,members:[],count:0,has_more:false,next_cursor:null,
        scanned:0,circle_context_version:contextVersion}),
    });
    try{
      await resetClientState(page,true,{},true);
      await page.goto('/',{waitUntil:'domcontentloaded'});
      await expect(page.locator('#view-dashboard')).toBeVisible();
      await page.locator('[data-tab="circle"]').click();
      const selector=page.getByTestId('circle-context-select');
      await expect(selector).toHaveValue('circle-primary');
      await expect(page.getByTestId('circle-invites')).toContainText('primary-only');

      const actionResponse=page.waitForResponse(response=>{
        const request=response.request();
        const path=new URL(response.url()).pathname;
        return request.method()==='POST'&&(delayedAction==='create'
          ?path==='/api/invitations':path===`/api/invitations/${invitationId}`);
      });
      if(delayedAction==='create'){
        await page.getByTestId('circle-invite-email').fill('delayed@example.test');
        await page.getByTestId('circle-invite-create').click();
      }else{
        await page.getByTestId('circle-invite-resend').click();
      }
      await actionStarted;
      const selecting=selector.selectOption('circle-secondary');
      await switchStarted;
      await expect(page.getByTestId('circle-invite-link')).toBeHidden();
      await expect(page.getByTestId('circle-invites')).toBeEmpty();
      await expect(page.locator('#circleOwnerPanel')).toBeHidden();

      releaseAction();
      const completed=await actionResponse;
      await completed.finished();
      await page.evaluate(()=>new Promise<void>(resolve=>requestAnimationFrame(()=>resolve())));
      await expect(page.getByTestId('circle-invite-link')).toBeHidden();
      await expect(page.getByTestId('circle-invites')).toBeEmpty();
      await expect(page.locator('#circleOwnerPanel')).toBeHidden();

      const reloaded=page.waitForEvent('domcontentloaded');
      releaseSwitch();
      await selecting;
      await reloaded;
    }finally{
      releaseAction();
      releaseSwitch();
    }
  });
}

test('an identity refresh recovers from a pending circle switch without reviving its callback',async({page})=>{
  const replacement={...owner,id:7,email:'replacement@example.test',name:'Replacement Owner',display_name:'Replacement Owner'};
  let currentUser=owner;
  let authMeCalls=0;
  let markSwitchStarted!:()=>void;
  let releaseSwitch!:()=>void;
  const switchStarted=new Promise<void>(resolve=>{ markSwitchStarted=resolve; });
  const switchGate=new Promise<void>(resolve=>{ releaseSwitch=resolve; });
  const originalCircles=[
    {id:10,public_id:'circle-primary',name:'Primary',role:'owner',is_primary:true},
    {id:20,public_id:'circle-secondary',name:'Secondary',role:'owner',is_primary:false},
  ];
  const replacementCircle={id:70,public_id:'circle-replacement',name:'Replacement',role:'owner',is_primary:true};
  await mockApi(page,{
    '/api/auth/capabilities':{
      ok:true,capabilities:{passwordLogin:true,passwordSignup:false,googleOAuth:true,multiCircleControlPlane:true},
      registrationMode:'private_beta',
    },
    '/api/auth/me':()=>{
      authMeCalls+=1;
      return {ok:true,user:currentUser};
    },
    '/api/profile':()=>({ok:true,user:currentUser}),
    '/api/circles':async request=>{
      if(request.method()==='PUT'){
        markSwitchStarted();
        await switchGate;
        return {ok:true,circles:originalCircles,active_circle:originalCircles[1],
          context_version:2,selection_required:false};
      }
      return currentUser.id===replacement.id
        ?{ok:true,circles:[replacementCircle],active_circle:replacementCircle,
          context_version:0,selection_required:false,implicit:true}
        :{ok:true,circles:originalCircles,active_circle:originalCircles[0],
          context_version:1,selection_required:false};
    },
    '/api/circle':()=>currentUser.id===replacement.id?{
      ok:true,circle_meta:{id:70,public_id:'circle-replacement',name:'Replacement'},
      membership:{role:'owner'},circle:[replacement],count:1,circle_context_version:0,
    }:{
      ok:true,circle_meta:{id:10,public_id:'circle-primary',name:'Primary'},
      membership:{role:'owner'},circle:members,count:2,circle_context_version:1,
    },
    '/api/invitations':()=>({ok:true,invitations:currentUser.id===replacement.id?[{
      id:'77777777-7777-4777-8777-777777777777',email_fingerprint:'replacement-only',status:'pending',
      expires_at:'2026-09-25T12:00:00.000Z',created_at:'2026-09-18T12:00:00.000Z',
    }]:[],count:currentUser.id===replacement.id?1:0,
    circle_context_version:currentUser.id===replacement.id?0:1}),
    '/api/members':()=>({ok:true,members:[{...currentUser,role:'owner',status:'active'}],count:1,
      has_more:false,next_cursor:null,scanned:1,circle_context_version:currentUser.id===replacement.id?0:1}),
  });
  try{
    await resetClientState(page,true,{},true);
    await page.goto('/',{waitUntil:'domcontentloaded'});
    await expect(page.locator('#view-dashboard')).toBeVisible();
    await page.locator('[data-tab="circle"]').click();
    const selector=page.getByTestId('circle-context-select');
    await expect(selector).toHaveValue('circle-primary');
    // The app deliberately performs three timed bootstrap identity refreshes.
    // Observe and supersede all of them before constructing this explicit
    // switch/identity race, so host timer scheduling cannot cancel the refresh
    // whose commit result is part of this test's contract.
    await expect.poll(()=>authMeCalls).toBeGreaterThanOrEqual(3);
    expect(await page.evaluate(()=>(window as any)._randori_auth.refreshMe())).toBe(true);

    const switchResponse=page.waitForResponse(response=>new URL(response.url()).pathname==='/api/circles'
      &&response.request().method()==='PUT');
    const selecting=selector.selectOption('circle-secondary');
    await switchStarted;
    await expect(page.getByTestId('circle-members')).toBeEmpty();

    currentUser=replacement;
    expect(await page.evaluate(()=>(window as any)._randori_auth.refreshMe())).toBe(true);
    await expect(page.getByTestId('circle-members')).toContainText('Replacement Owner');
    await expect(page.getByTestId('circle-invites')).toContainText('replacement-only');

    releaseSwitch();
    const completed=await switchResponse;
    await completed.finished();
    await selecting;
    await page.evaluate(()=>new Promise<void>(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>resolve()))));
    await expect(page.getByTestId('circle-members')).toContainText('Replacement Owner');
    await expect(page.getByTestId('circle-members')).not.toContainText('Team Mate');
    await expect(page.getByTestId('circle-invites')).toContainText('replacement-only');
  }finally{
    releaseSwitch();
  }
});

test('a same-user refresh cannot cancel a pending circle switch commit',async({page})=>{
  let active:'circle-primary'|'circle-secondary'='circle-primary';
  let contextVersion=1;
  let markSwitchStarted!:()=>void;
  let releaseSwitch!:()=>void;
  const switchStarted=new Promise<void>(resolve=>{ markSwitchStarted=resolve; });
  const switchGate=new Promise<void>(resolve=>{ releaseSwitch=resolve; });
  const circles=[
    {id:10,public_id:'circle-primary',name:'Primary',role:'owner',is_primary:true},
    {id:20,public_id:'circle-secondary',name:'Secondary',role:'owner',is_primary:false},
  ];
  await page.addInitScript(()=>{
    class TestBroadcastChannel {
      readonly name:string;
      constructor(name:string){ this.name=name; }
      addEventListener(){}
      postMessage(value:unknown){
        if(this.name==='randori-circle-context-v1'){
          sessionStorage.setItem('randori-e2e-circle-broadcast',JSON.stringify(value));
        }
      }
      close(){}
    }
    Object.defineProperty(window,'BroadcastChannel',{configurable:true,value:TestBroadcastChannel});
  });
  await mockApi(page,{
    '/api/auth/capabilities':{
      ok:true,capabilities:{passwordLogin:true,passwordSignup:false,googleOAuth:true,multiCircleControlPlane:true},
      registrationMode:'private_beta',
    },
    '/api/auth/me':{ok:true,user:owner},
    '/api/profile':{ok:true,user:owner},
    '/api/circles':async request=>{
      if(request.method()==='PUT'){
        markSwitchStarted();
        await switchGate;
        active='circle-secondary';
        contextVersion=2;
      }
      return {ok:true,circles,active_circle:circles.find(circle=>circle.public_id===active),
        context_version:contextVersion,selection_required:false};
    },
    '/api/circle':()=>({
      ok:true,circle_meta:{id:active==='circle-primary'?10:20,public_id:active,name:active},
      membership:{role:'owner'},circle:active==='circle-primary'?[members[0]]:[members[1]],count:1,
      circle_context_version:contextVersion,
    }),
    '/api/invitations':()=>({ok:true,invitations:[],count:0,circle_context_version:contextVersion}),
    '/api/members':()=>({ok:true,members:[{...(active==='circle-primary'?members[0]:members[1]),
      role:'owner',status:'active'}],count:1,has_more:false,next_cursor:null,scanned:1,
      circle_context_version:contextVersion}),
  });
  try{
    await resetClientState(page,true,{},true);
    await page.goto('/',{waitUntil:'domcontentloaded'});
    await expect(page.locator('#view-dashboard')).toBeVisible();
    await page.locator('[data-tab="circle"]').click();
    const selector=page.getByTestId('circle-context-select');
    await expect(selector).toHaveValue('circle-primary');

    const switchResponse=page.waitForResponse(response=>new URL(response.url()).pathname==='/api/circles'
      &&response.request().method()==='PUT');
    const selecting=selector.selectOption('circle-secondary');
    await switchStarted;
    await expect(page.getByTestId('circle-members')).toBeEmpty();

    expect(await page.evaluate(()=>(window as any)._randori_auth.refreshMe())).toBe(true);
    await expect(page.getByTestId('circle-members')).toBeEmpty();

    const reloaded=page.waitForEvent('domcontentloaded');
    releaseSwitch();
    const completed=await switchResponse;
    await completed.finished();
    await selecting;
    await reloaded;
    await page.locator('[data-tab="circle"]').click();
    await expect(page.getByTestId('circle-context-select')).toHaveValue('circle-secondary');
    await expect(page.getByTestId('circle-members')).toContainText('Team Mate');
    expect(await page.evaluate(()=>JSON.parse(sessionStorage.getItem('randori-e2e-circle-broadcast')||'null')))
      .toEqual({v:1,user_id:owner.id,context_version:2});
  }finally{
    releaseSwitch();
  }
});

test('stale circle responses cannot render after the active context advances',async({page})=>{
  const staleMember={...members[1],id:99,display_name:'Wrong Circle Member',name:'Wrong Circle Member'};
  await mockApi(page,{
    '/api/auth/capabilities':{
      ok:true,
      capabilities:{passwordLogin:true,passwordSignup:false,googleOAuth:true,multiCircleControlPlane:true},
      registrationMode:'private_beta',
    },
    '/api/auth/me':{ok:true,user:owner},
    '/api/circles':{
      ok:true,
      circles:[
        {public_id:'circle-primary',name:'Primary',role:'owner',is_primary:true},
        {public_id:'circle-secondary',name:'Secondary',role:'owner',is_primary:false},
      ],
      active_circle:{public_id:'circle-secondary',name:'Secondary',role:'owner',is_primary:false},
      context_version:2,selection_required:false,
    },
    '/api/circle':{
      ok:true,circle_meta:{id:10,public_id:'circle-primary',name:'Primary'},
      membership:{role:'owner'},circle:[staleMember],count:1,circle_context_version:1,
    },
  });
  await resetClientState(page,true,{},true);
  await page.goto('/',{waitUntil:'domcontentloaded'});
  await page.locator('[data-tab="circle"]').click();
  await expect(page.getByTestId('circle-members')).not.toContainText('Wrong Circle Member');
  await expect(page.getByTestId('circle-members')).toContainText('Circle unavailable');
});

test('ordinary members see the server roster but never owner invitation controls', async ({ page }) => {
  let invitationRequests = 0;
  await mockApi(page, {
    '/api/auth/me': { ok: true, user: { ...owner, is_admin: true } },
    '/api/circle': circleResponse('member'),
    '/api/invitations': () => {
      invitationRequests += 1;
      return { _status: 403, error: 'owner access required' };
    },
  });
  await resetClientState(page, true);

  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await expect(page.locator('#meLabel')).toContainText('Circle Owner');
  await page.locator('[data-tab="circle"]').click();
  await expect(page.getByTestId('circle-members')).toContainText('Team Mate');
  await expect(page.getByTestId('circle-invite-email')).toBeHidden();
  await expect(page.getByTestId('circle-invite-create')).toBeHidden();
  await expect(page.getByTestId('circle-invites')).toBeHidden();
  expect(invitationRequests).toBe(0);
});

test('flag-off legacy circle responses keep the existing roster and admin testing controls usable', async ({ page }) => {
  await mockApi(page, {
    '/api/auth/me': { ok: true, user: { ...owner, is_admin: true } },
    '/api/circle': {
      ok: true,
      source: 'auth_accounts',
      circle: members,
      count: members.length,
    },
  });
  await resetClientState(page, true);

  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await expect(page.locator('#meLabel')).toContainText('Circle Owner');
  await page.locator('[data-tab="circle"]').click();
  await expect(page.getByTestId('circle-members')).toContainText('Team Mate');
  await expect(page.locator('#circleRoleLabel')).toHaveText('legacy');
  await expect(page.locator('#legacyCircleAddActions')).toBeVisible();
  await expect(page.locator('#legacyCircleDemoActions')).toBeVisible();
  await expect(page.getByTestId('circle-invite-email')).toBeHidden();
});

test('a successful one-time invitation remains copyable when the list refresh fails', async ({ page }) => {
  const rawInvite = 'C'.repeat(43);
  let authMeCalls = 0;
  let circleRequestsInFlight = 0;
  let circleRole: 'owner' | 'member' = 'owner';
  let invitationCreated = false;
  let createAttempts = 0;
  let holdNextCircle = false;
  let copiedInvite = '';
  let notifyCircle: (() => void) | null = null;
  let releaseCircle: (() => void) | null = null;
  let notifyCreate: (() => void) | null = null;
  const circleStarted = new Promise<void>(resolve => { notifyCircle = resolve; });
  const circleGate = new Promise<void>(resolve => { releaseCircle = resolve; });
  const createCompleted = new Promise<void>(resolve => { notifyCreate = resolve; });
  await page.exposeFunction('captureInviteCopy', (value: string) => { copiedInvite = value; });
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: {
        writeText: (value: string) => (window as typeof window & {
          captureInviteCopy: (copied: string) => Promise<void>;
        }).captureInviteCopy(value),
      },
    });
  });
  await mockApi(page, {
    '/api/auth/me': () => {
      authMeCalls += 1;
      return { ok: true, user: owner };
    },
    '/api/circle': async () => {
      circleRequestsInFlight += 1;
      try {
        if (holdNextCircle) {
          holdNextCircle = false;
          notifyCircle?.();
          await circleGate;
        }
        return circleResponse(circleRole);
      } finally {
        circleRequestsInFlight -= 1;
      }
    },
    '/api/invitations': async request => {
      if (request.method() === 'POST') {
        createAttempts += 1;
        if (createAttempts > 1) return { _status: 503, error: 'invitations unavailable' };
        invitationCreated = true;
        notifyCreate?.();
        return {
          _status: 201,
          ok: true,
          invitation: {
            id: '33333333-3333-4333-8333-333333333333',
            email: 'member@example.test',
            expires_at: '2026-09-25T12:00:00.000Z',
            status: 'pending',
            invite_url: `/invite#invite=${rawInvite}`,
          },
        };
      }
      return invitationCreated
        ? { _status: 503, error: 'invitations unavailable' }
        : { ok: true, invitations: [], count: 0 };
    },
  });
  await resetClientState(page, true);

  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await expect(page.locator('#meLabel')).toContainText('Circle Owner');
  await page.locator('[data-tab="circle"]').click();
  // Let the fixed bootstrap identity schedule settle. The race below is then
  // driven entirely by explicit request gates rather than wall-clock sleeps.
  await expect.poll(() => authMeCalls).toBeGreaterThanOrEqual(3);
  await page.evaluate(async () => {
    await (window as typeof window & {
      _randori_auth?: { refreshMe?: () => Promise<unknown> };
    })._randori_auth?.refreshMe?.();
  });
  await expect.poll(() => circleRequestsInFlight).toBe(0);
  await expect(page.getByTestId('circle-invite-create')).toBeEnabled();

  holdNextCircle = true;
  await page.evaluate(() => window.dispatchEvent(new Event('randori:auth-refreshed')));
  await circleStarted;
  await page.getByTestId('circle-invite-email').fill('member@example.test');
  await page.getByTestId('circle-invite-create').click();
  await createCompleted;
  // A same-owner revalidation must not tear down usable owner controls or the
  // one-time secret. A changed role/error still clears them when it commits.
  await expect(page.getByTestId('circle-invite-link')).toBeVisible();
  await page.getByTestId('circle-invite-link').click();
  await expect.poll(() => copiedInvite).toBe(new URL(`/invite#invite=${rawInvite}`, page.url()).href);
  releaseCircle?.();
  await expect(page.locator('#circleRoleLabel')).toHaveText('owner');

  copiedInvite = '';
  await page.getByTestId('circle-invite-email').fill('another@example.test');
  await expect(page.getByTestId('circle-invite-create')).toBeEnabled();
  await page.getByTestId('circle-invite-create').click();
  await expect(page.getByTestId('circle-invite-link')).toBeVisible();
  await page.getByTestId('circle-invite-link').click();
  await expect.poll(() => copiedInvite).toBe(new URL(`/invite#invite=${rawInvite}`, page.url()).href);

  circleRole = 'member';
  await page.evaluate(() => window.dispatchEvent(new Event('randori:auth-refreshed')));
  await expect(page.getByTestId('circle-invite-email')).toBeHidden();
  await expect(page.getByTestId('circle-invite-link')).toBeHidden();
});

test('authenticated circle failures show retry and never expose local or demo roster data', async ({ page }) => {
  let circleRequests = 0;
  await mockApi(page, {
    '/api/auth/me': { ok: true, user: owner },
    '/api/circle': () => {
      circleRequests += 1;
      return { _status: 503, error: 'circle unavailable' };
    },
  });
  await resetClientState(page, true, {
    'randori-people': JSON.stringify([{ id: 'local', name: 'LOCAL SECRET ROSTER', color: '#fff' }]),
  });

  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await expect(page.locator('#meLabel')).toContainText('Circle Owner');
  await page.locator('[data-tab="circle"]').click();
  const roster = page.getByTestId('circle-members');
  await expect(roster).toContainText('Circle unavailable');
  await expect(roster).not.toContainText('LOCAL SECRET ROSTER');
  const beforeRetry = circleRequests;
  await roster.getByRole('button', { name: 'Retry' }).click();
  await expect.poll(() => circleRequests).toBeGreaterThan(beforeRetry);
  await expect(roster).not.toContainText('LOCAL SECRET ROSTER');
});
