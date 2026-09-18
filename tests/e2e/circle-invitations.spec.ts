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
      return { ok: true, expires_in_seconds: 600 };
    },
  });
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
  expect(prepareBodies).toHaveLength(1);
});

test('circle owner can view members, create a private copy action, and revoke invitations', async ({ page }) => {
  const rawInvite = 'B'.repeat(43);
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
  await page.getByTestId('circle-invite-revoke').last().click();
  await expect.poll(() => revokedIds).toEqual([secondInvitationId]);
  await expect(page.getByTestId('circle-invite-link')).toBeHidden();
  await expect(page.getByTestId('circle-invites')).toContainText('revoked');
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
  let invitationCreated = false;
  let createAttempts = 0;
  let delayNextCircle = false;
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
    '/api/circle': async () => {
      if (delayNextCircle) {
        delayNextCircle = false;
        await new Promise(resolve => setTimeout(resolve, 250));
      }
      return circleResponse('owner');
    },
    '/api/invitations': async request => {
      if (request.method() === 'POST') {
        createAttempts += 1;
        if (createAttempts > 1) return { _status: 503, error: 'invitations unavailable' };
        await new Promise(resolve => setTimeout(resolve, 100));
        invitationCreated = true;
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
  await page.getByTestId('circle-invite-email').fill('member@example.test');
  await page.getByTestId('circle-invite-create').click();
  delayNextCircle = true;
  await page.evaluate(() => window.dispatchEvent(new Event('randori:auth-refreshed')));
  await expect(page.getByTestId('circle-invite-link')).toBeVisible();
  await page.getByTestId('circle-invite-link').click();
  await expect.poll(() => copiedInvite).toBe(new URL(`/invite#invite=${rawInvite}`, page.url()).href);

  copiedInvite = '';
  await page.getByTestId('circle-invite-email').fill('another@example.test');
  await expect(page.getByTestId('circle-invite-create')).toBeEnabled();
  await page.getByTestId('circle-invite-create').click();
  await expect(page.getByTestId('circle-invite-link')).toBeVisible();
  await page.getByTestId('circle-invite-link').click();
  await expect.poll(() => copiedInvite).toBe(new URL(`/invite#invite=${rawInvite}`, page.url()).href);
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
