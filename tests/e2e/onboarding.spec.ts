import { expect, test, type Page, type Request } from '@playwright/test';
import { mockApi, resetClientState } from './helpers';

// Golden paths for WP-O: one progressive onboarding flow (invite -> account ->
// profile basics -> availability -> what happens next), the Home setup guide,
// no app navigation for anonymous visitors, and same-tab reset links.

const newMember = {
  id: 1,
  email: 'new.member@example.test',
  name: 'New Member',
  display_name: 'New Member',
  color: '#c8f6a0',
  is_admin: false,
  tz: '',
  interview_focus: 'both',
};

function upcomingCycle() {
  const startsAt = Date.now() + 3 * 86_400_000;
  return {
    cycleId: '2099-W52',
    startsAt: new Date(startsAt).toISOString(),
    endsAt: new Date(startsAt + 7 * 86_400_000).toISOString(),
    cutoffAt: new Date(startsAt).toISOString(),
    timeZone: 'Europe/London',
    state: 'upcoming',
  };
}

function availabilityEnvelope(cycle: ReturnType<typeof upcomingCycle>, saved: boolean | null, version = 0) {
  return {
    ok: true,
    availability: {
      cycle,
      cycleKey: 'a'.repeat(64),
      isAvailable: saved ?? true,
      version,
      source: saved === null ? 'cycle_default' : 'user',
      editable: true,
      updatedAt: saved === null ? null : new Date().toISOString(),
    },
  };
}

async function firstRunMember(page: Page) {
  let profile = { ...newMember };
  const profilePosts: Record<string, unknown>[] = [];
  const availabilityPosts: Record<string, unknown>[] = [];
  const cycle = upcomingCycle();
  let saved: boolean | null = null;
  let version = 0;
  await mockApi(page, {
    '/api/auth/me': () => ({ ok: true, user: profile }),
    '/api/profile': (request: Request) => {
      if (request.method() === 'POST') {
        const body = request.postDataJSON() as Record<string, unknown>;
        profilePosts.push(body);
        profile = { ...profile, ...body } as typeof profile;
      }
      return { ok: true, user: profile };
    },
    '/api/settings/availability': (request: Request) => {
      if (request.method() === 'POST') {
        const body = request.postDataJSON() as { is_available: boolean };
        availabilityPosts.push(body);
        saved = body.is_available;
        version += 1;
      }
      return availabilityEnvelope(cycle, saved, version);
    },
  });
  await resetClientState(page, true, { 'randori-profile-done': '' });
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  return { profilePosts, availabilityPosts, cycle };
}

test('a new member completes profile basics, availability and what happens next in one stepper', async ({ page }) => {
  const { profilePosts, availabilityPosts } = await firstRunMember(page);

  await expect(page.locator('#view-profile-setup')).toBeVisible();
  const stepper = page.getByRole('list', { name: 'Setup progress' }).first();
  await expect(stepper).toBeVisible();
  await expect(page.locator('#setupStepText')).toHaveText('Step 3 of 5');
  await expect(stepper.locator('[aria-current="step"]')).toContainText('Profile');
  await expect(page.locator('#psAvailabilityLink')).toBeHidden();
  await expect(page.locator('#psMore')).not.toHaveAttribute('open', '');
  await expect(page.locator('#view-profile-setup')).not.toContainText(/step 2 of 3/i);

  await page.locator('#psName').fill('Ada Lovelace');
  await page.locator('#psTz').selectOption('Europe/London');
  await page.locator('#psFocus [data-focus="dsa"]').click();
  await expect(page.locator('#psFocus [data-focus="dsa"]')).toHaveAttribute('aria-pressed', 'true');
  await page.locator('#psSave').click();

  await expect(page.locator('#setupStepAvailability')).toBeVisible();
  await expect(page.locator('#setupStepText')).toHaveText('Step 4 of 5');
  await expect(page.locator('#setupAvailabilityTitle')).toBeFocused();
  expect(profilePosts[0]).toMatchObject({ display_name: 'Ada Lovelace', tz: 'Europe/London', interview_focus: 'dsa' });
  await expect(page.locator('#setupAvailabilityTitle')).toHaveText(/^Your availability for the week of \d{1,2} [A-Z][a-z]{2,3}$/);
  await expect(page.locator('#setupAvailabilityNote')).toContainText('Not decided yet');
  await expect(page.locator('#setupAvailabilityNext')).toHaveText('Decide later');
  const card = page.locator('#setupStepAvailability #availabilityWrap');
  await expect(card).toBeVisible();
  await expect(page.locator('#availAvailable')).toBeEnabled();
  await page.locator('#availAvailable').click();
  await expect.poll(() => availabilityPosts.length).toBe(1);
  expect(availabilityPosts[0]).toMatchObject({ is_available: true, expected_version: 0 });
  await expect(page.locator('#setupAvailabilityNote')).toContainText('Saved');
  await expect(page.locator('#setupAvailabilityNext')).toHaveText('Continue');
  await page.locator('#setupAvailabilityNext').click();

  await expect(page.locator('#setupStepNext')).toBeVisible();
  await expect(page.locator('#setupStepText')).toHaveText('Step 5 of 5');
  await expect(page.locator('#setupTimeline li')).toHaveCount(3);
  await expect(page.locator('#setupTimeline')).toContainText('Pairings publish');
  await expect(page.locator('#setupTimeline')).toContainText('Agree a time with your partner');
  await expect(page.locator('#setupTimeline')).not.toContainText(/\d{4}-W\d{2}/);
  await expect(page.locator('#psRemindEmail')).toBeVisible();
  await page.locator('#setupFinish').click();

  await expect(page.locator('#view-dashboard')).toBeVisible();
  await expect(page.locator('#view-pair #availabilityWrap')).toHaveCount(1);
  await expect(page.locator('#welcomeBanner')).toHaveCount(0);
  await expect(page.locator('#onboardOverlay')).toHaveCount(0);
  await expect(page.locator('#dashAvailBadge')).toContainText(/Available for the week of \d{1,2} [A-Z][a-z]{2,3}/);
  await expect(page.locator('#dashAvailBadge')).not.toContainText(/\d{4}-W\d{2}/);
});

test('skipping profile details saves only the required minimum and availability can be decided later', async ({ page }) => {
  const { profilePosts, availabilityPosts } = await firstRunMember(page);

  await expect(page.locator('#view-profile-setup')).toBeVisible();
  await page.locator('#psName').fill('');
  await page.locator('#psSkip').click();
  await expect(page.locator('#setupStepAvailability')).toBeVisible();
  expect(profilePosts).toHaveLength(1);
  expect(Object.keys(profilePosts[0]).sort()).toEqual(['display_name', 'interview_focus', 'tz']);
  expect(profilePosts[0].display_name).toBe('New Member');
  expect(String(profilePosts[0].tz || '')).not.toBe('');

  await page.locator('#setupAvailabilityNext').click();
  await expect(page.locator('#setupStepNext')).toBeVisible();
  await page.locator('#setupNextBack').click();
  await expect(page.locator('#setupStepAvailability')).toBeVisible();
  await page.locator('#setupAvailabilityNext').click();
  await page.locator('#setupFinish').click();
  await expect(page.locator('#view-dashboard')).toBeVisible();
  expect(availabilityPosts).toHaveLength(0);

  // The setup guide shows the remaining step with a human week label.
  await expect(page.locator('#onboardChecklist')).toBeVisible();
  await expect(page.locator('#onboardChecklistTitle')).toHaveText('Setup guide');
  await expect(page.locator('#chkProfile')).toHaveAttribute('data-state', 'done');
  await expect(page.locator('#chkAvail')).toHaveAttribute('data-state', 'ready');
  await expect(page.locator('#chkAvail')).toContainText(/Save availability for the week of \d{1,2} [A-Z][a-z]{2,3}/);
  await expect(page.locator('#onboardChecklist')).not.toContainText(/\d{4}-W\d{2}/);

  // Reopen the stepper from the account menu at the first unfinished step.
  await page.locator('#meLabel').click();
  await page.getByRole('menuitem', { name: 'Setup guide' }).click();
  await expect(page.locator('#setupStepAvailability')).toBeVisible();
  await expect(page.locator('#setupStepText')).toHaveText('Step 4 of 5');
  await page.locator('[data-tab="pair"]').click();
  await expect(page.locator('#view-pair #availabilityWrap')).toBeVisible();

  // Hiding the guide is remembered for this account only.
  await page.locator('#tab-home').click();
  await expect(page.locator('#onboardChecklist')).toBeVisible();
  await page.locator('#checklistToggle').click();
  await expect(page.locator('#onboardChecklist')).toBeHidden();
  await expect(page.locator('#meLabel')).toBeFocused();
  expect(await page.evaluate(() => localStorage.getItem('randori-setup-guide-dismissed:1'))).toBe('1');
  await page.locator('[data-tab="history"]').click();
  await page.locator('#tab-home').click();
  await expect(page.locator('#view-dashboard')).toBeVisible();
  await expect(page.locator('#onboardChecklist')).toBeHidden();
});

test.describe('anonymous visitors on a phone', () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

  test('the landing and recovery pages show no app navigation or welcome banner', async ({ page }) => {
    await mockApi(page);
    await resetClientState(page);
    await page.goto('/', { waitUntil: 'domcontentloaded' });
    await expect(page.locator('#view-landing')).toBeVisible();
    await expect(page.locator('body')).toHaveAttribute('data-nav', 'hidden');
    await expect(page.getByRole('navigation', { name: 'Primary navigation' })).toBeHidden();
    await expect(page.locator('.tabs')).toBeHidden();
    await expect(page.locator('#authBtn')).toBeVisible();
    await expect(page.locator('#welcomeBanner')).toHaveCount(0);
    expect(await page.evaluate(() => Number.parseFloat(getComputedStyle(document.body).paddingBottom))).toBe(0);

    for (const path of ['/invite', '/verify', '/reset-password']) {
      await page.goto(path, { waitUntil: 'domcontentloaded' });
      await expect(page.locator('body')).toHaveAttribute('data-nav', 'hidden');
      await expect(page.getByRole('navigation', { name: 'Primary navigation' })).toBeHidden();
    }
  });
});

test('members keep the app navigation', async ({ page }) => {
  await mockApi(page, {
    '/api/auth/me': { ok: true, user: { ...newMember, tz: 'Europe/London' } },
    '/api/profile': { ok: true, user: { ...newMember, tz: 'Europe/London' } },
  });
  await resetClientState(page, true);
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await expect(page.locator('#view-dashboard')).toBeVisible();
  await expect(page.locator('body')).toHaveAttribute('data-nav', 'shown');
  await expect(page.getByRole('navigation', { name: 'Primary navigation' })).toBeVisible();
});

test('a second reset link opened in the same tab replaces the first token and leaves the URL', async ({ page }) => {
  const consumed: string[] = [];
  await mockApi(page, {
    '/api/auth/password-reset/consume': (request: Request) => {
      consumed.push(String((request.postDataJSON() as { token?: string }).token || ''));
      return { ok: true, status: 'reset' };
    },
  });
  await resetClientState(page);
  await page.goto('/reset-password#token=first-token-value', { waitUntil: 'domcontentloaded' });
  await expect(page).toHaveURL(/\/reset-password$/);
  await expect(page.getByTestId('password-reset-status')).toContainText('Enter a new password');
  await page.locator('#passwordResetNew').fill('half-typed-password');

  await page.evaluate(() => { window.location.hash = '#token=second-token-value'; });
  await expect(page).toHaveURL(/\/reset-password$/);
  await expect(page.locator('#passwordResetNew')).toHaveValue('');
  await expect(page.locator('#passwordResetNew')).toBeFocused();
  await page.locator('#passwordResetNew').fill('a-brand-new-password');
  await page.locator('#passwordResetConfirm').fill('a-brand-new-password');
  await page.locator('#passwordResetSubmit').click();
  await expect.poll(() => consumed).toEqual(['second-token-value']);
  await expect(page.getByTestId('password-reset-status')).toContainText('Your password was changed');

  // A later link in the same tab starts a fresh form again.
  await page.evaluate(() => { window.location.hash = '#token=third-token-value'; });
  await expect(page).toHaveURL(/\/reset-password$/);
  await expect(page.locator('#passwordResetNew')).toBeVisible();
  await expect(page.locator('#passwordResetSubmit')).toBeVisible();
});

test('a member who joined after this week’s cutoff is told when they will be included', async ({ page }) => {
  const now = Date.now();
  const current = {
    cycleId: '2099-W51', startsAt: new Date(now - 86_400_000).toISOString(), endsAt: new Date(now + 6 * 86_400_000).toISOString(),
    cutoffAt: new Date(now - 86_400_000).toISOString(), timeZone: 'Europe/London', state: 'current',
  };
  const upcoming = {
    cycleId: '2099-W52', startsAt: current.endsAt, endsAt: new Date(now + 13 * 86_400_000).toISOString(),
    cutoffAt: current.endsAt, timeZone: 'Europe/London', state: 'upcoming',
  };
  const scheduled = Date.parse(current.cutoffAt);
  const member = { ...newMember, tz: 'Europe/London', created_at: new Date(now - 3_600_000).toISOString() };
  await mockApi(page, {
    '/api/auth/me': { ok: true, user: member },
    '/api/profile': { ok: true, user: member },
    '/api/my-pair': {
      ok: true, paired: false, pairing_status: 'unpublished', current_cycle: current, upcoming_cycle: upcoming,
      publication_state: {
        state: 'overdue', cycle_key: 'c'.repeat(64), observed_at: new Date(now).toISOString(),
        scheduled_at: new Date(scheduled).toISOString(), recovery_at: new Date(scheduled + 30 * 60_000).toISOString(),
        published_at: null, can_publish_now: false,
      },
    },
  });
  await resetClientState(page, true);
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await expect(page.locator('#view-dashboard')).toBeVisible();
  await expect(page.locator('#dashEmptyTitle')).toHaveText(/^You’ll be included from the week of \d{1,2} [A-Z][a-z]{2,3}$/);
  await expect(page.locator('#dashEmpty')).not.toContainText(/late/i);
});
