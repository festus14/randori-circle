import AxeBuilder from '@axe-core/playwright';
import { expect, Page, test } from '@playwright/test';
import { mockApi, resetClientState } from './helpers';

// WP-C owner "Invite requests" panel against the WP-L2 contract
// (docs/INVITE_REQUESTS.md). The API is mocked here so every decision path
// (approve, decline, 409, hidden states) is deterministic.

const owner = {
  id: 1, email: 'owner@example.test', name: 'Circle Owner', display_name: 'Circle Owner',
  color: '#c8f6a0', is_admin: false, is_available: true, tz: 'Europe/London', interview_focus: 'both',
};
const roster = [
  { id: 1, display_name: 'Circle Owner', name: 'Circle Owner', color: '#c8f6a0', interview_focus: 'both', source: 'auth' },
  { id: 2, display_name: 'Team Mate', name: 'Team Mate', color: '#a9b6ff', interview_focus: 'dsa', source: 'auth' },
];
const ADA = '0f8fad5b-d9cb-469f-a165-70867728950e';
const GRACE = '7c9e6679-7425-40de-944b-e07fc1f90ae7';
const INVITE_ID = '16fd2706-8baf-433b-82eb-8c7fada847da';
const XSS_NOTE = '<img src=x onerror="window.__requestXss=1">System design loops';

function capabilities(inviteRequests: boolean) {
  return {
    ok: true,
    capabilities: { passwordLogin: true, passwordSignup: false, googleOAuth: true, ...(inviteRequests ? { inviteRequests: true } : {}) },
    registrationMode: 'private_beta',
  };
}

function pendingRequests() {
  const now = Date.now();
  return [
    { id: ADA, name: 'Ada Lovelace', email: 'ada@example.test', note: XSS_NOTE,
      created_at: new Date(now - 2 * 86_400_000).toISOString(), expires_at: new Date(now + 28 * 86_400_000).toISOString() },
    { id: GRACE, name: 'Grace Hopper', email: 'grace@example.test', note: null,
      created_at: new Date(now - 3_600_000).toISOString(), expires_at: new Date(now + 30 * 86_400_000).toISOString() },
  ];
}

async function setupOwner(page: Page, {
  inviteRequests = true,
  role = 'owner' as 'owner' | 'member',
  decision,
}: {
  inviteRequests?: boolean;
  role?: 'owner' | 'member';
  decision?: (body: { id: string; decision: string }) => Record<string, unknown>;
} = {}) {
  let requests = pendingRequests();
  const invitations: Array<Record<string, unknown>> = [];
  const decisions: unknown[] = [];
  let listCalls = 0;
  await mockApi(page, {
    '/api/auth/capabilities': capabilities(inviteRequests),
    '/api/auth/me': { ok: true, user: owner },
    '/api/circle': {
      ok: true, circle_meta: { id: 11, public_id: 'circle_private', name: 'Private Practice' },
      membership: { role }, circle: roster, count: roster.length,
    },
    '/api/members': {
      ok: true, has_more: false, next_cursor: null,
      members: [
        { id: 1, display_name: 'Circle Owner', color: '#c8f6a0', role: 'owner', status: 'active', joined_at: '2026-09-01 10:00:00' },
        { id: 2, display_name: 'Team Mate', color: '#a9b6ff', role: 'member', status: 'active', joined_at: '2026-09-10 10:00:00' },
      ],
    },
    '/api/invitations': () => ({ ok: true, invitations, count: invitations.length }),
    '/api/invite-requests': request => {
      listCalls += 1;
      expect(request.method()).toBe('GET');
      const url = new URL(request.url());
      expect(url.searchParams.get('status')).toBe('pending');
      return { ok: true, status: 'pending', requests, pending_count: requests.length, next_cursor: null };
    },
    '/api/invite-requests/decision': request => {
      expect(request.method()).toBe('POST');
      const body = request.postDataJSON() as { id: string; decision: string; expected_status: string };
      decisions.push(body);
      if (decision) return decision(body);
      const target = requests.find(item => item.id === body.id);
      requests = requests.filter(item => item.id !== body.id);
      const decidedAt = new Date().toISOString();
      if (body.decision === 'approve') {
        invitations.unshift({ id: INVITE_ID, email_fingerprint: 'abcdef123456', status: 'pending',
          created_at: decidedAt, expires_at: new Date(Date.now() + 7 * 86_400_000).toISOString() });
        return { ok: true, request: { id: body.id, status: 'approved', decided_at: decidedAt },
          invitation: { id: INVITE_ID, email: target?.email, expires_at: decidedAt, status: 'pending', invite_url: `/invite#invite=${'R'.repeat(43)}` },
          email_delivery: { queued: true } };
      }
      return { ok: true, request: { id: body.id, status: 'declined', decided_at: decidedAt } };
    },
  });
  await resetClientState(page, true);
  return { decisions, listCalls: () => listCalls };
}

test('owner reviews invite requests: approve sends an invitation, decline is confirmed and silent', async ({ page }, testInfo) => {
  const api = await setupOwner(page);
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await expect(page.locator('#meLabel')).toContainText('Circle Owner');
  await page.locator('[data-tab="circle"]').click();

  const panel = page.getByTestId('circle-invite-requests');
  await expect(panel).toBeVisible();
  await expect(panel.getByRole('heading', { name: 'Invite requests' })).toBeVisible();
  await expect(page.getByTestId('circle-invite-requests-count')).toHaveText('2 waiting');
  const ada = panel.locator(`[data-request-id="${ADA}"]`);
  await expect(ada).toContainText('Ada Lovelace');
  await expect(ada).toContainText('ada@example.test');
  // Notes render as text only.
  await expect(ada).toContainText(XSS_NOTE);
  await expect(ada.locator('img')).toHaveCount(0);
  expect(await page.evaluate(() => (window as typeof window & { __requestXss?: number }).__requestXss)).toBeUndefined();
  await expect(ada).toContainText(/Asked 2 days ago/);

  // One members list for owners: managed rows with roles and status, roster hidden.
  await expect(page.getByTestId('circle-manage-members')).toBeVisible();
  await expect(page.getByTestId('circle-members')).toBeHidden();
  await expect(page.locator('[data-testid="circle-member-row"][data-member-id="2"]')).toContainText('Member');

  const results = await new AxeBuilder({ page })
    .include('#view-circle')
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
    .analyze();
  await testInfo.attach('circle-owner-axe-incomplete', { body: Buffer.from(JSON.stringify(results.incomplete, null, 2)), contentType: 'application/json' });
  expect(results.violations, 'circle owner WCAG violations').toEqual([]);

  await ada.getByRole('button', { name: 'Approve Ada Lovelace and send an invitation' }).click();
  await expect.poll(() => api.decisions).toEqual([{ id: ADA, decision: 'approve', expected_status: 'pending' }]);
  await expect(page.locator('#circleInviteRequestsStatus')).toHaveText('Approved. An invitation email is on its way to ada@example.test.');
  await expect(page.getByTestId('circle-invite-requests-count')).toHaveText('1 waiting');
  await expect(ada).toHaveCount(0);
  // The approved invitation joins the normal invitation list, recognisable by address.
  const invite = page.getByTestId('circle-invites').locator(`[data-invitation-id="${INVITE_ID}"]`);
  await expect(invite).toContainText('ada@example.test');
  await expect(invite).toHaveAttribute('data-invitation-status', 'pending');
  await expect(page.getByTestId('circle-invite-link')).toBeVisible();
  await expect(page.getByTestId('circle-invites')).not.toContainText('abcdef123456');

  const grace = panel.locator(`[data-request-id="${GRACE}"]`);
  await grace.getByRole('button', { name: 'Decline Grace Hopper' }).click();
  await expect(page.locator('#confirmTitle')).toHaveText('Decline Grace Hopper?');
  await page.locator('#confirmOk').click();
  await expect.poll(() => api.decisions).toHaveLength(2);
  expect(api.decisions[1]).toEqual({ id: GRACE, decision: 'decline', expected_status: 'pending' });
  await expect(page.locator('#circleInviteRequestsStatus')).toHaveText("Declined Grace Hopper's request. They are not notified.");
  await expect(page.getByTestId('circle-invite-requests-count')).toHaveText('None waiting');
  await expect(panel).toContainText('No one is waiting');
});

test('cancelling a decline sends nothing, and a stale decision refreshes the list', async ({ page }) => {
  const api = await setupOwner(page, {
    decision: () => ({ _status: 409, error: 'invite request is no longer pending', code: 'invite_request_not_pending', status: 'declined' }),
  });
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await expect(page.locator('#meLabel')).toContainText('Circle Owner');
  await page.locator('[data-tab="circle"]').click();
  const panel = page.getByTestId('circle-invite-requests');
  await expect(panel.locator('[data-testid="circle-invite-request-row"]')).toHaveCount(2);

  await panel.getByRole('button', { name: 'Decline Ada Lovelace' }).click();
  await page.locator('#confirmCancel').click();
  expect(api.decisions).toEqual([]);

  const before = api.listCalls();
  await panel.getByRole('button', { name: 'Approve Ada Lovelace and send an invitation' }).click();
  await expect(page.locator('#circleInviteRequestsStatus')).toHaveText('This request was already handled. It was declined. The list has been refreshed.');
  await expect.poll(() => api.listCalls()).toBeGreaterThan(before);
  await expect(panel.getByRole('button', { name: 'Approve Grace Hopper and send an invitation' })).toBeEnabled();
});

test('the panel stays hidden without the capability or for members, and never calls the API', async ({ page }) => {
  const api = await setupOwner(page, { inviteRequests: false });
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await expect(page.locator('#meLabel')).toContainText('Circle Owner');
  await page.locator('[data-tab="circle"]').click();
  await expect(page.getByTestId('circle-invite-email')).toBeVisible();
  await expect(page.getByTestId('circle-invite-requests')).toBeHidden();
  expect(api.listCalls()).toBe(0);
});

test('members see one roster with no owner panels', async ({ page }) => {
  const api = await setupOwner(page, { role: 'member' });
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await expect(page.locator('#meLabel')).toContainText('Circle Owner');
  await page.locator('[data-tab="circle"]').click();
  await expect(page.getByTestId('circle-members')).toBeVisible();
  await expect(page.getByTestId('circle-members')).toContainText('Team Mate');
  await expect(page.getByTestId('circle-members')).toContainText('(you)');
  await expect(page.locator('#circleRoleLabel')).toHaveText('member');
  await expect(page.locator('#circleOwnerPanel')).toBeHidden();
  await expect(page.getByTestId('circle-invite-requests')).toBeHidden();
  await expect(page.getByTestId('circle-manage-members')).toBeHidden();
  await expect(page.getByTestId('circle-leave')).toBeVisible();
  // Demo controls never appear next to real data.
  await expect(page.locator('#demoBtn')).toBeHidden();
  expect(api.listCalls()).toBe(0);
});
