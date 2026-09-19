import { expect, Request, test } from '@playwright/test';
import { mockApi, resetClientState } from './helpers';

const user = {
  id: 1,
  email: 'owner@example.test',
  name: 'Circle Owner',
  display_name: 'Circle Owner',
  color: '#c8f6a0',
  is_admin: true,
  // Deliberately stale: the availability endpoint is authoritative.
  is_available: true,
  tz: 'Europe/London',
  interview_focus: 'both',
};

function availability({
  cycleId = '2026-W39',
  cycleKey,
  startsAt,
  endsAt,
  cutoffAt,
  isAvailable = false,
  version = 4,
  editable = true,
  source,
}: {
  cycleId?: string;
  cycleKey?: string;
  startsAt?: string;
  endsAt?: string;
  cutoffAt?: string;
  isAvailable?: boolean;
  version?: number;
  editable?: boolean;
  source?: 'user' | 'legacy_bridge' | 'cycle_default';
} = {}) {
  const nextCycle = cycleId === '2026-W40';
  return {
    cycle: {
      cycleId,
      startsAt: startsAt || (nextCycle ? '2026-09-27T07:00:00.000Z' : '2026-09-20T07:00:00.000Z'),
      endsAt: endsAt || (nextCycle ? '2026-10-04T07:00:00.000Z' : '2026-09-27T07:00:00.000Z'),
      cutoffAt: cutoffAt || (nextCycle ? '2026-09-27T07:00:00.000Z' : '2026-09-20T07:00:00.000Z'),
      timeZone: 'Europe/London',
      state: 'upcoming',
    },
    cycleKey: cycleKey || (nextCycle ? 'b' : 'a').repeat(64),
    isAvailable,
    version,
    source: source || (version ? 'user' : 'cycle_default'),
    editable,
    updatedAt: version ? '2026-09-18T10:00:00.000Z' : null,
  };
}

function circle() {
  return {
    ok: true,
    circle_meta: { id: 1, public_id: 'circle_e2e', name: 'E2E Circle' },
    membership: { role: 'owner' },
    circle: [user],
    count: 1,
  };
}

test('availability is loaded from its cycle API and posts the exact versioned boolean contract', async ({ page }) => {
  const posts: Record<string, unknown>[] = [];
  let serverAvailability = availability();
  await mockApi(page, {
    '/api/auth/me': { ok: true, user },
    '/api/circle': circle(),
    '/api/settings/availability': (request: Request) => {
      if (request.method() === 'POST') {
        posts.push(request.postDataJSON());
        serverAvailability = availability({ isAvailable: true, version: 5 });
        return { ok: true, availability: serverAvailability };
      }
      return { ok: true, availability: serverAvailability };
    },
  });
  await resetClientState(page, true);
  await page.goto('/?view=pair', { waitUntil: 'domcontentloaded' });

  const card = page.getByTestId('availability-card');
  const toggle = page.locator('#availToggle');
  await expect(card).toBeVisible();
  await expect(page.locator('#availTitle')).toHaveText('Availability for 2026-W39');
  await expect(page.getByTestId('availability-cycle')).toContainText('Upcoming cycle starts');
  await expect(page.getByTestId('availability-cycle')).toContainText('2026');
  await expect(page.getByTestId('availability-cutoff')).toContainText('Europe/London');
  await expect(toggle).not.toBeChecked();
  await expect(toggle).toBeEnabled();
  await expect(page.locator('#availLabel')).toHaveText('OFF (skipped)');

  // The old cached account boolean remains untouched and does not drive the card.
  await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem('randori-me') || '{}').is_available)).toBe(true);

  await toggle.check();
  await expect.poll(() => posts.length).toBe(1);
  expect(posts[0]).toEqual({
    cycle_key: 'a'.repeat(64),
    expected_version: 4,
    is_available: true,
  });
  expect(typeof posts[0].is_available).toBe('boolean');
  await expect(toggle).toBeChecked();
  await expect(page.locator('#availLabel')).toHaveText('ON (included)');
});

test('an in-flight availability save cannot cross an authentication identity change', async ({ page }) => {
  const userB = { ...user, id: 2, email: 'member@example.test', name: 'Circle Member', display_name: 'Circle Member', is_admin: false };
  let currentUser: typeof user | null = user;
  let releasePost: (() => void) | null = null;
  let notifyPost: (() => void) | null = null;
  let notifyPostCompleted: (() => void) | null = null;
  const postStarted = new Promise<void>(resolve => { notifyPost = resolve; });
  const postCompleted = new Promise<void>(resolve => { notifyPostCompleted = resolve; });
  const userAAvailability = availability({ isAvailable: true, version: 4, cycleKey: 'a'.repeat(64) });
  const userBAvailability = availability({ isAvailable: false, version: 9, cycleKey: 'c'.repeat(64) });

  await mockApi(page, {
    '/api/auth/me': () => currentUser
      ? { ok: true, user: currentUser }
      : { _status: 401, ok: false, error: 'authentication required' },
    '/api/circle': circle(),
    '/api/settings/availability': async (request: Request) => {
      if (request.method() === 'POST') {
        notifyPost?.();
        await new Promise<void>(resolve => { releasePost = resolve; });
        notifyPostCompleted?.();
        return { ok: true, availability: availability({ isAvailable: false, version: 5, cycleKey: 'a'.repeat(64) }) };
      }
      if (!currentUser) return { _status: 401, ok: false, error: 'authentication required' };
      return { ok: true, availability: currentUser.id === user.id ? userAAvailability : userBAvailability };
    },
  });
  await resetClientState(page, true);
  await page.goto('/?view=pair', { waitUntil: 'domcontentloaded' });
  await expect(page.locator('#availToggle')).toBeChecked();

  await page.locator('#availToggle').uncheck();
  await postStarted;
  currentUser = null;
  await page.evaluate(() => (window as typeof window & { _randori_auth?: { refreshMe(): Promise<void> } })._randori_auth?.refreshMe());
  currentUser = userB;
  await page.evaluate(() => (window as typeof window & { _randori_auth?: { refreshMe(): Promise<void> } })._randori_auth?.refreshMe());
  await expect.poll(() => page.evaluate(() => {
    const state = (window as typeof window & { _randori_availability?: { current?: { version?: number } } })._randori_availability?.current;
    return state?.version;
  })).toBe(9);

  releasePost?.();
  await postCompleted;
  await page.waitForTimeout(100);
  await expect.poll(() => page.evaluate(() => {
    const state = (window as typeof window & { _randori_availability?: { current?: { cycleKey?: string; version?: number; isAvailable?: boolean } } })._randori_availability?.current;
    return state && { cycleKey: state.cycleKey, version: state.version, isAvailable: state.isAvailable };
  })).toEqual({ cycleKey: 'c'.repeat(64), version: 9, isAvailable: false });
});

test('availability revalidates on resume and automatically advances after its cutoff', async ({ page }) => {
  let serverAvailability = availability({ isAvailable: true, version: 1 });
  await mockApi(page, {
    '/api/auth/me': { ok: true, user },
    '/api/circle': circle(),
    '/api/settings/availability': () => ({ ok: true, availability: serverAvailability }),
  });
  await resetClientState(page, true);
  await page.goto('/?view=pair', { waitUntil: 'domcontentloaded' });
  await expect(page.locator('#availToggle')).toBeChecked();

  serverAvailability = availability({ isAvailable: false, version: 2 });
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  await expect(page.locator('#availToggle')).not.toBeChecked();

  const cutoff = Date.now() + 3000;
  serverAvailability = availability({
    isAvailable: false,
    version: 3,
    startsAt: new Date(cutoff).toISOString(),
    cutoffAt: new Date(cutoff).toISOString(),
    endsAt: new Date(cutoff + 7 * 24 * 60 * 60 * 1000).toISOString(),
  });
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await expect.poll(() => page.evaluate(() => {
    const state = (window as typeof window & { _randori_availability?: { current?: { version?: number } } })._randori_availability?.current;
    return state?.version;
  })).toBe(3);

  serverAvailability = availability({ cycleId: '2026-W40', isAvailable: true, version: 0 });
  await expect(page.locator('#availTitle')).toHaveText('Availability for 2026-W40', { timeout: 8000 });
  await expect(page.locator('#availToggle')).toBeChecked();
});

test('invalid availability envelopes fail closed and expose a working retry', async ({ page }) => {
  let returnValid = false;
  let authMeCalls = 0;
  await mockApi(page, {
    '/api/auth/me': () => {
      authMeCalls += 1;
      return { ok: true, user };
    },
    '/api/circle': circle(),
    '/api/settings/availability': () => ({
      ok: true,
      availability: returnValid
        ? availability({ isAvailable: true })
        : { ...availability({ isAvailable: true }), source: 'stored', cycle: { ...availability().cycle, cycleId: '2026-W00' } },
    }),
  });
  await resetClientState(page, true);
  await page.goto('/?view=pair', { waitUntil: 'domcontentloaded' });

  await expect(page.locator('#availLabel')).toHaveText('UNAVAILABLE');
  await expect(page.locator('#availRetry')).toBeVisible();
  // Once every scheduled auth attempt has started, make one explicit attempt
  // newest and await the availability request it starts (or coalesces with).
  // No bootstrap refresh can then consume the valid retry response below.
  await expect.poll(() => authMeCalls).toBeGreaterThanOrEqual(3);
  await page.evaluate(async () => {
    const app = window as typeof window & {
      _randori_auth?: { refreshMe?: () => Promise<unknown> };
      _randori_availability?: { refresh?: () => Promise<unknown> };
    };
    await app._randori_auth?.refreshMe?.();
    await app._randori_availability?.refresh?.();
  });
  await expect(page.locator('#availRetry')).toBeVisible();
  returnValid = true;
  await page.locator('#availRetry').click();
  await expect(page.locator('#availTitle')).toHaveText('Availability for 2026-W39');
  await expect(page.locator('#availRetry')).toBeHidden();
});

test('an availability change queued during same-account revalidation uses the refreshed version', async ({ page }) => {
  let authMeCalls = 0;
  let holdNextGet = false;
  let notifyGet: (() => void) | null = null;
  let releaseGet: (() => void) | null = null;
  const getStarted = new Promise<void>(resolve => { notifyGet = resolve; });
  const getGate = new Promise<void>(resolve => { releaseGet = resolve; });
  const posts: Record<string, unknown>[] = [];
  let serverAvailability = availability({ isAvailable: true, version: 4 });
  await mockApi(page, {
    '/api/auth/me': () => {
      authMeCalls += 1;
      return { ok: true, user };
    },
    '/api/circle': circle(),
    '/api/settings/availability': async (request: Request) => {
      if (request.method() === 'POST') {
        posts.push(request.postDataJSON());
        serverAvailability = availability({ isAvailable: false, version: 6 });
        return { ok: true, availability: serverAvailability };
      }
      if (holdNextGet) {
        holdNextGet = false;
        notifyGet?.();
        await getGate;
      }
      return { ok: true, availability: serverAvailability };
    },
  });
  await resetClientState(page, true);
  await page.goto('/?view=pair', { waitUntil: 'domcontentloaded' });

  const toggle = page.locator('#availToggle');
  await expect(toggle).toBeChecked();
  // Wait for all three scheduled bootstrap identity refreshes so this test
  // controls the only revalidation that can overlap the user intent.
  await expect.poll(() => authMeCalls).toBeGreaterThanOrEqual(3);
  await page.evaluate(async () => {
    const app = window as typeof window & {
      _randori_auth?: { refreshMe?: () => Promise<unknown> };
      _randori_availability?: { refresh?: () => Promise<unknown> };
    };
    await app._randori_auth?.refreshMe?.();
    await app._randori_availability?.refresh?.();
  });
  await expect(toggle).toBeEnabled();

  holdNextGet = true;
  serverAvailability = availability({ isAvailable: true, version: 5 });
  await page.evaluate(() => {
    void (window as typeof window & {
      _randori_availability?: { refresh?: () => Promise<unknown> };
    })._randori_availability?.refresh?.();
  });
  await getStarted;
  await expect(toggle).toBeChecked();
  await expect(toggle).toBeDisabled();

  // This is the exact browser interleaving from the failing trace: the input
  // change lands after revalidation has started. The intent must be serialized
  // behind the GET rather than silently discarded.
  await page.evaluate(() => {
    const input = document.querySelector<HTMLInputElement>('#availToggle');
    if (!input) throw new Error('availability toggle missing');
    input.checked = false;
    input.dispatchEvent(new Event('change', { bubbles: true }));
  });
  releaseGet?.();

  await expect.poll(() => posts.length).toBe(1);
  expect(posts[0]).toEqual({
    cycle_key: 'a'.repeat(64),
    expected_version: 5,
    is_available: false,
  });
  await expect(toggle).not.toBeChecked();
  await expect(page.locator('#availLabel')).toHaveText('OFF (skipped)');
});

for (const scenario of [
  { error: 'availability_stale', cycleId: '2026-W39', editable: true, message: 'changed elsewhere' },
  { error: 'availability_cycle_changed', cycleId: '2026-W40', editable: true, message: 'pairing cycle changed' },
  { error: 'availability_cutoff_closed', cycleId: '2026-W40', editable: false, message: 'cutoff has closed' },
] as const) {
  test(`a 409 ${scenario.error} response replaces stale UI with the returned availability`, async ({ page }) => {
    let authMeCalls = 0;
    let releasePost: (() => void) | null = null;
    let notifyPost: (() => void) | null = null;
    const postStarted = new Promise<void>(resolve => { notifyPost = resolve; });
    let serverAvailability = availability({ isAvailable: true });
    await mockApi(page, {
      '/api/auth/me': () => {
        authMeCalls += 1;
        return { ok: true, user };
      },
      '/api/circle': circle(),
      '/api/settings/availability': async (request: Request) => {
        if (request.method() !== 'POST') return { ok: true, availability: serverAvailability };
        notifyPost?.();
        await new Promise<void>(resolve => { releasePost = resolve; });
        serverAvailability = availability({
          cycleId: scenario.cycleId,
          isAvailable: false,
          version: 7,
          editable: scenario.editable,
        });
        return {
          _status: 409,
          ok: false,
          error: scenario.error,
          availability: serverAvailability,
        };
      },
    });
    await resetClientState(page, true);
    await page.goto('/?view=pair', { waitUntil: 'domcontentloaded' });

    const toggle = page.locator('#availToggle');
    await expect(toggle).toBeChecked();
    // Remove bootstrap identity refreshes from this conflict-contract test;
    // overlap behavior is covered explicitly above.
    await expect.poll(() => authMeCalls).toBeGreaterThanOrEqual(3);
    await page.evaluate(async () => {
      const app = window as typeof window & {
        _randori_auth?: { refreshMe?: () => Promise<unknown> };
        _randori_availability?: { refresh?: () => Promise<unknown> };
      };
      await app._randori_auth?.refreshMe?.();
      await app._randori_availability?.refresh?.();
    });
    await expect(toggle).toBeEnabled();
    await toggle.uncheck();
    await postStarted;
    await expect(toggle).toBeDisabled();
    await expect(page.locator('#availLabel')).toHaveText('SAVING OFF…');
    releasePost?.();

    await expect(page.locator('#availTitle')).toHaveText(`Availability for ${scenario.cycleId}`);
    await expect(toggle).not.toBeChecked();
    await expect(page.locator('#availExplan')).toContainText(scenario.message);
    await page.evaluate(async () => {
      const api = (window as typeof window & {
        _randori_availability?: { refresh?: () => Promise<unknown> };
      })._randori_availability;
      await api?.refresh?.();
    });
    await expect(page.locator('#availExplan')).toContainText(scenario.message);
    if (scenario.editable) await expect(toggle).toBeEnabled();
    else {
      await expect(toggle).toBeDisabled();
      await expect(page.locator('#availLabel')).toHaveText('CLOSED');
    }

    serverAvailability = availability({
      cycleId: scenario.cycleId,
      isAvailable: true,
      version: 8,
      editable: scenario.editable,
    });
    await page.evaluate(async () => {
      const api = (window as typeof window & {
        _randori_availability?: { refresh?: () => Promise<unknown> };
      })._randori_availability;
      await api?.refresh?.();
    });
    await expect(page.locator('#availExplan')).toBeHidden();
  });
}

test('an availability conflict notice cannot cross an authentication identity change', async ({ page }) => {
  const userB = { ...user, id: 2, email: 'member@example.test', name: 'Circle Member', display_name: 'Circle Member', is_admin: false };
  const conflictAvailability = availability({
    cycleId: '2026-W40', isAvailable: false, version: 7, editable: true,
  });
  let currentUser = user;
  let holdUserBAvailability = false;
  let notifyPost: (() => void) | null = null;
  let releasePost: (() => void) | null = null;
  let notifyUserBGet: (() => void) | null = null;
  let releaseUserBGet: (() => void) | null = null;
  const postStarted = new Promise<void>(resolve => { notifyPost = resolve; });
  const postGate = new Promise<void>(resolve => { releasePost = resolve; });
  const userBGetStarted = new Promise<void>(resolve => { notifyUserBGet = resolve; });
  const userBGetGate = new Promise<void>(resolve => { releaseUserBGet = resolve; });

  await mockApi(page, {
    '/api/auth/me': () => ({ ok: true, user: currentUser }),
    '/api/circle': circle(),
    '/api/settings/availability': async (request: Request) => {
      if (request.method() === 'POST') {
        notifyPost?.();
        await postGate;
        return {
          _status: 409,
          ok: false,
          error: 'availability_cycle_changed',
          availability: conflictAvailability,
        };
      }
      if (currentUser.id === userB.id && holdUserBAvailability) {
        notifyUserBGet?.();
        await userBGetGate;
      }
      return { ok: true, availability: conflictAvailability };
    },
  });
  await resetClientState(page, true);
  await page.goto('/?view=pair', { waitUntil: 'domcontentloaded' });

  const toggle = page.locator('#availToggle');
  await expect(toggle).not.toBeChecked();
  await toggle.check();
  await postStarted;
  await expect(page.locator('#availLabel')).toHaveText('SAVING ON…');
  releasePost?.();
  await expect(page.locator('#availExplan')).toContainText('pairing cycle changed');

  currentUser = userB;
  holdUserBAvailability = true;
  await page.evaluate(async () => {
    await (window as typeof window & {
      _randori_auth?: { refreshMe(): Promise<void> };
    })._randori_auth?.refreshMe();
  });
  await userBGetStarted;
  await expect(page.locator('#meLabel')).toContainText('Circle Member');
  await expect(page.locator('#availExplan')).toBeHidden();
  releaseUserBGet?.();
  await expect(toggle).not.toBeChecked();
});

test('profile saves no availability field and links to the cycle-specific control', async ({ page }) => {
  const profilePosts: Record<string, unknown>[] = [];
  await mockApi(page, {
    '/api/auth/me': { ok: true, user },
    '/api/circle': circle(),
    '/api/profile': (request: Request) => {
      if (request.method() === 'POST') {
        const body = request.postDataJSON();
        profilePosts.push(body);
        return { ok: true, user: { ...user, ...body } };
      }
      return { ok: true, user };
    },
    '/api/settings/availability': { ok: true, availability: availability({ isAvailable: true }) },
  });
  await resetClientState(page, true);
  await page.goto('/', { waitUntil: 'domcontentloaded' });

  await expect(page.locator('#dashProfileBtn')).toBeVisible();
  await page.locator('#dashProfileBtn').click();
  await expect(page.locator('#view-profile-setup')).toBeVisible();
  await expect(page.locator('#psAvail')).toHaveCount(0);
  await expect(page.locator('#psAvailabilityLink')).toBeVisible();

  await page.locator('#psSave').click();
  await expect.poll(() => profilePosts.length).toBe(1);
  expect(profilePosts[0]).not.toHaveProperty('is_available');

  await page.locator('#dashProfileBtn').click();
  await page.locator('#psAvailabilityLink').click();
  await expect(page.locator('#view-pair')).toBeVisible();
  await expect(page.getByTestId('availability-card')).toBeVisible();
  await expect(page.getByTestId('availability-card')).toBeFocused();
  await expect(page.locator('#availToggle')).toHaveAttribute('aria-labelledby', 'availTitle availLabel');
  await expect(page.locator('#availTitle')).toHaveText('Availability for 2026-W39');
});

test('the circle roster does not label legacy account flags as cycle availability', async ({ page }) => {
  await mockApi(page, {
    '/api/auth/me': { ok: true, user },
    '/api/circle': circle(),
    '/api/settings/availability': { ok: true, availability: availability({ isAvailable: false }) },
  });
  await resetClientState(page, true);
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await page.locator('[data-tab="circle"]').click();
  await expect(page.locator('#peopleList .person')).toHaveCount(1);
  await expect(page.locator('#peopleList')).not.toContainText(/available|away/i);
});
