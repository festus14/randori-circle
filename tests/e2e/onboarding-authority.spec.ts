import { expect, test } from '@playwright/test';
import { mockApi, resetClientState } from './helpers';

const member = {
  id: 1,
  email: 'member@example.test',
  name: 'Member',
  display_name: 'Member',
  color: '#c8f6a0',
  is_admin: false,
  tz: 'Europe/London',
  interview_focus: 'both',
};

const fixtureCycles = (() => {
  const startsAt = Date.now() - 60_000;
  const endsAt = startsAt + 7 * 86_400_000;
  return {
    current: {
      cycleId: '2099-W51',
      startsAt: new Date(startsAt).toISOString(),
      endsAt: new Date(endsAt).toISOString(),
      cutoffAt: new Date(startsAt).toISOString(),
      timeZone: 'Europe/London',
      state: 'current',
    },
    upcoming: {
      cycleId: '2099-W52',
      startsAt: new Date(endsAt).toISOString(),
      endsAt: new Date(endsAt + 7 * 86_400_000).toISOString(),
      cutoffAt: new Date(endsAt).toISOString(),
      timeZone: 'Europe/London',
      state: 'upcoming',
    },
  };
})();

function cycles() {
  return structuredClone(fixtureCycles);
}

function availability(source: 'cycle_default' | 'user' = 'cycle_default', isAvailable = true) {
  return {
    ok: true,
    availability: {
      cycle: cycles().upcoming,
      cycleKey: 'a'.repeat(64),
      isAvailable,
      version: source === 'user' ? 1 : 0,
      source,
      editable: true,
      updatedAt: source === 'user' ? new Date().toISOString() : null,
    },
  };
}

function publicationState(
  cycle: ReturnType<typeof cycles>['current'],
  state: 'pending' | 'published' = 'pending',
) {
  const scheduled = Date.parse(cycle.cutoffAt);
  const observed = Math.max(
    Date.parse(cycle.startsAt),
    Math.min(Date.now(), Date.parse(cycle.endsAt) - 1),
  );
  return {
    state,
    cycle_key: 'c'.repeat(64),
    observed_at: new Date(observed).toISOString(),
    scheduled_at: new Date(scheduled).toISOString(),
    recovery_at: new Date(scheduled + 30 * 60_000).toISOString(),
    published_at: state === 'published' ? new Date(observed).toISOString() : null,
  };
}

const noPair = () => {
  const value = cycles();
  return {
    ok: true,
    paired: false,
    pairing_status: 'unpublished',
    current_cycle: value.current,
    upcoming_cycle: value.upcoming,
    publication_state: publicationState(value.current),
  };
};

async function openAsMember(page: Parameters<typeof resetClientState>[0], overrides: Parameters<typeof mockApi>[1] = {}) {
  await mockApi(page, {
    '/api/auth/me': () => ({ ok: true, user: member }),
    '/api/profile': () => ({ ok: true, user: member }),
    '/api/settings/availability': () => availability(),
    '/api/my-pair': () => noPair(),
    ...overrides,
  });
  await resetClientState(page, true, {
    'randori-onboarded': '0',
    'randori-profile-done': '1',
    'randori-last-room': 'week_999_pair_999',
  });
  await page.goto('/', { waitUntil: 'domcontentloaded' });
}

test('complete profiles wait for onboarding authority readiness before routing', async ({ page }) => {
  let markProfileRead!: () => void;
  let markBarrierReached!: () => void;
  let releaseAuthorityScript!: () => void;
  const profileRead = new Promise<void>(resolve => { markProfileRead = resolve; });
  const barrierReached = new Promise<void>(resolve => { markBarrierReached = resolve; });
  const authorityScriptGate = new Promise<void>(resolve => { releaseAuthorityScript = resolve; });
  await page.addInitScript(() => {
    const testWindow = window as typeof window & {
      __authRefreshed?: boolean;
      __profileFetches?: number;
    };
    testWindow.__authRefreshed = false;
    testWindow.__profileFetches = 0;
    const originalFetch = window.fetch.bind(window);
    window.fetch = (input, init) => {
      if (new URL(input instanceof Request ? input.url : String(input), location.href).pathname === '/api/profile') {
        testWindow.__profileFetches = (testWindow.__profileFetches || 0) + 1;
      }
      return originalFetch(input, init);
    };
    window.addEventListener('randori:auth-refreshed', () => { testWindow.__authRefreshed = true; }, { once: true });
  });
  await page.route('**/*', async route => {
    if (new URL(route.request().url()).pathname !== '/') return route.fallback();
    const response = await route.fetch();
    const body = await response.text();
    const marker = '<script>\n// Server-authoritative first-run progress.';
    expect(body).toContain(marker);
    await route.fulfill({
      response,
      body: body.replace(marker, `<script src="/onboarding-authority-barrier.js"></script>\n${marker}`),
    });
  });
  await page.route('**/onboarding-authority-barrier.js', async route => {
    markBarrierReached();
    await authorityScriptGate;
    await route.fulfill({ status: 200, contentType: 'application/javascript', body: '' });
  });
  await mockApi(page, {
    '/api/auth/me': async () => {
      await barrierReached;
      return { ok: true, user: member };
    },
    '/api/profile': () => {
      markProfileRead();
      return { ok: true, user: member };
    },
    '/api/settings/availability': () => availability('user'),
  });
  await resetClientState(page, true, { 'randori-onboarded': '0' });
  const navigation = page.goto('/', { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => (window as typeof window & { __authRefreshed?: boolean }).__authRefreshed === true);
  expect(await page.evaluate(() => (window as typeof window & { __profileFetches?: number }).__profileFetches)).toBe(0);
  releaseAuthorityScript();
  await navigation;
  await profileRead;

  await expect(page.locator('#view-dashboard')).toBeVisible();
  await expect(page.locator('#view-profile-setup')).not.toBeVisible();
  await expect(page.locator('#chkProfile')).toHaveAttribute('data-state', 'done');
});

test('profile failure remains unknown with an accessible retry', async ({ page }) => {
  let profileAvailable = false;
  await openAsMember(page, {
    '/api/profile': () => profileAvailable
      ? { ok: true, user: member }
      : { _status: 503, error: 'profile unavailable' },
  });

  await expect(page.locator('#onboardChecklist')).toBeVisible();
  await expect(page.locator('#chkProfile')).toHaveAttribute('data-state', 'error');
  await expect(page.locator('#chkProfile')).toContainText('Profile status unknown');
  await expect(page.locator('#chkRetry')).toBeVisible();
  await expect(page.locator('#onboardChecklistStatus')).toContainText('could not be verified');

  profileAvailable = true;
  await page.locator('#chkRetry').click();
  await expect(page.locator('#chkProfile')).toHaveAttribute('data-state', 'done');
  await expect(page.locator('#chkProfile')).toContainText('Profile saved');
});

test('an unavailable circle scope keeps profile routing on a visible retry path', async ({ page }) => {
  await mockApi(page, {
    '/api/auth/capabilities': {
      ok: true,
      capabilities: {
        passwordLogin: true, passwordSignup: false, googleOAuth: true,
        multiCircleControlPlane: true, multiCircleAvailability: true,
      },
      registrationMode: 'private_beta',
    },
    '/api/auth/me': () => ({ ok: true, user: member }),
    '/api/profile': () => ({ ok: true, user: member }),
    '/api/circles': () => ({ _status: 503, error: 'circle context unavailable' }),
  });
  await resetClientState(page, true, { 'randori-onboarded': '0' });
  await page.goto('/', { waitUntil: 'domcontentloaded' });

  await expect(page.locator('#view-profile-setup')).toBeVisible();
  await expect(page.locator('#view-dashboard')).not.toBeVisible();
  await expect(page.locator('#psSaveStatus')).toHaveAttribute('data-state', 'loading_error');
  await expect(page.locator('#psSaveStatus')).toContainText('Profile status is unknown');
  await expect(page.locator('#psSave')).toBeDisabled();
  await expect(page.locator('#psRetry')).toBeVisible();
});

test('a stale browser-wide tour dismissal cannot hide another account setup', async ({ page }) => {
  await mockApi(page, {
    '/api/auth/me': () => ({ ok: true, user: member }),
    '/api/profile': () => ({ ok: true, user: member }),
    '/api/settings/availability': () => availability(),
    '/api/my-pair': () => noPair(),
  });
  await resetClientState(page, true, {
    'randori-onboarded': '1',
    'randori-profile-done': '1',
  });
  await page.goto('/', { waitUntil: 'domcontentloaded' });

  await expect(page.locator('#view-dashboard')).toBeVisible();
  await expect(page.locator('#onboardChecklist')).toBeVisible();
  await expect(page.locator('#chkProfile')).toHaveAttribute('data-state', 'done');
  await expect(page.locator('#chkAvail')).toHaveAttribute('data-state', 'ready');
  await expect(page.locator('#chkPair')).toHaveAttribute('data-state', 'ready');
});

test('an availability outage does not block independent profile editing or saving', async ({ page }) => {
  let profile = { ...member, tz: '' };
  let saves = 0;
  await mockApi(page, {
    '/api/auth/me': () => ({ ok: true, user: profile }),
    '/api/profile': request => {
      if (request.method() === 'GET') return { ok: true, user: profile };
      saves += 1;
      profile = { ...profile, ...(request.postDataJSON() as object) };
      return { ok: true, user: profile };
    },
    '/api/settings/availability': () => ({ _status: 503, error: 'availability unavailable' }),
    '/api/my-pair': () => noPair(),
  });
  await resetClientState(page, true, { 'randori-onboarded': '0' });
  await page.goto('/', { waitUntil: 'domcontentloaded' });

  await expect(page.locator('#view-profile-setup')).toBeVisible();
  await expect(page.locator('#psSaveStatus')).toHaveAttribute('data-state', 'idle');
  await expect(page.locator('#psSave')).toBeEnabled();
  await page.locator('#psTz').selectOption('Europe/London');
  await page.locator('#psSave').click();
  await expect.poll(() => saves).toBe(1);
});

test('a stalled availability read does not delay profile setup or save', async ({ page }) => {
  let profile = { ...member, tz: '' };
  let saves = 0;
  let markAvailabilityStarted!: () => void;
  let releaseAvailability!: () => void;
  const availabilityStarted = new Promise<void>(resolve => { markAvailabilityStarted = resolve; });
  const availabilityGate = new Promise<void>(resolve => { releaseAvailability = resolve; });
  await mockApi(page, {
    '/api/auth/me': () => ({ ok: true, user: profile }),
    '/api/profile': request => {
      if (request.method() === 'GET') return { ok: true, user: profile };
      saves += 1;
      profile = { ...profile, ...(request.postDataJSON() as object) };
      return { ok: true, user: profile };
    },
    '/api/settings/availability': async () => {
      markAvailabilityStarted();
      await availabilityGate;
      return availability();
    },
    '/api/my-pair': () => noPair(),
  });
  await resetClientState(page, true, { 'randori-onboarded': '0' });
  try {
    await page.goto('/', { waitUntil: 'domcontentloaded' });
    await availabilityStarted;
    await expect(page.locator('#view-profile-setup')).toBeVisible();
    await expect(page.locator('#psSave')).toBeEnabled();
    await page.locator('#psTz').selectOption('Europe/London');
    await page.locator('#psSave').click();
    await expect.poll(() => saves).toBe(1);
    await expect(page.locator('#view-dashboard')).toBeVisible();
  } finally {
    releaseAvailability();
  }
});

test('availability completes only after the active target cycle has a user save', async ({ page }) => {
  let saved = false;
  await openAsMember(page, {
    '/api/settings/availability': request => {
      if (request.method() === 'POST') saved = true;
      return availability(saved ? 'user' : 'cycle_default', saved ? false : true);
    },
  });

  await expect(page.locator('#chkAvail')).toHaveAttribute('data-state', 'ready');
  await expect(page.locator('#chkAvail')).toContainText('Save availability for 2099-W52');
  await page.locator('[data-tab="pair"]').click();
  await expect(page.locator('#availAvailable')).toHaveAttribute('aria-pressed', 'false');
  await page.locator('#availSkip').click();
  await expect(page.locator('#chkAvail')).toHaveAttribute('data-state', 'done');
  await expect(page.locator('#chkAvail')).toContainText('Availability saved for 2099-W52');
});

test('checklist and tour actions open and focus the active-circle cycle decision', async ({ page }) => {
  await openAsMember(page);

  await expect(page.locator('#chkAvailAction')).toBeVisible();
  await page.locator('#chkAvailAction').click();
  await expect(page.locator('#view-pair')).toBeVisible();
  await expect(page.locator('#availAvailable')).toBeFocused();

  await page.evaluate(() => window._randori_onboard?.start?.(4));
  await expect(page.locator('#onbAvailabilityAction')).toBeVisible();
  await page.locator('#onbAvailabilityAction').click();
  await expect(page.locator('#onboardOverlay')).not.toHaveClass(/show/);
  await expect(page.locator('#view-pair')).toBeVisible();
  await expect(page.locator('#availAvailable')).toBeFocused();
});

test('an availability rollover rejects the old pair and reacquires the new published cycle', async ({ page }) => {
  let currentAvailability = availability('user');
  const value = cycles();
  let holdOldPairRead = false;
  let serveNewPair = false;
  let markOldReadStarted!: () => void;
  let releaseOldRead!: () => void;
  let markNewReadStarted!: () => void;
  let releaseNewRead!: () => void;
  let markRolloverAvailabilityRead!: () => void;
  let expectRolloverAvailability = false;
  const oldReadStarted = new Promise<void>(resolve => { markOldReadStarted = resolve; });
  const oldReadGate = new Promise<void>(resolve => { releaseOldRead = resolve; });
  const newReadStarted = new Promise<void>(resolve => { markNewReadStarted = resolve; });
  const newReadGate = new Promise<void>(resolve => { releaseNewRead = resolve; });
  const rolloverAvailabilityRead = new Promise<void>(resolve => { markRolloverAvailabilityRead = resolve; });
  const pairFor = (
    current: ReturnType<typeof cycles>['current'],
    upcoming: ReturnType<typeof cycles>['upcoming'],
    pairId: number,
  ) => ({
    ok: true,
    paired: true,
    pairing_status: 'paired',
    workspace_available: false,
    coordination_only: true,
    week_id: pairId,
    current_cycle: current,
    upcoming_cycle: upcoming,
    publication_state: publicationState(current, 'published'),
    week: { id: pairId, week_label: current.cycleId },
    pair: { id: pairId, pg_id: pairId, topic: 'both' },
    partner: { id: 2, name: `Partner ${pairId}`, color: '#9cc0b5', tz: 'UTC', interview_focus: 'both' },
  });
  const oldPair = pairFor(value.current, value.upcoming, 51);
  let newPair: ReturnType<typeof pairFor>;
  await openAsMember(page, {
    '/api/settings/availability': () => {
      const response = structuredClone(currentAvailability);
      if (expectRolloverAvailability && response.availability.cycleKey === 'b'.repeat(64)) {
        expectRolloverAvailability = false;
        markRolloverAvailabilityRead();
      }
      return response;
    },
    '/api/my-pair': async () => {
      if (serveNewPair) {
        markNewReadStarted();
        await newReadGate;
        return newPair;
      }
      if (holdOldPairRead) {
        holdOldPairRead = false;
        markOldReadStarted();
        await oldReadGate;
        return oldPair;
      }
      return oldPair;
    },
  });
  await expect(page.locator('#chkAvail')).toContainText('Availability saved for 2099-W52');
  await expect(page.locator('#chkPair')).toContainText('Current assignment published for 2099-W51');

  holdOldPairRead = true;
  const staleDashboard = page.evaluate(() => window._randori_journey?.showDashboard?.());
  await oldReadStarted;
  // showDashboard starts availability refresh without awaiting it. Join that
  // owner promise before changing the fixture so the rollover request cannot
  // coalesce with an old-envelope read.
  await page.evaluate(() => window._randori_availability?.refresh?.());

  const nextStarts = Date.parse(currentAvailability.availability.cycle.endsAt);
  currentAvailability = {
    ok: true,
    availability: {
      ...currentAvailability.availability,
      cycleKey: 'b'.repeat(64),
      cycle: {
        ...currentAvailability.availability.cycle,
        cycleId: '2100-W01',
        startsAt: new Date(nextStarts).toISOString(),
        endsAt: new Date(nextStarts + 7 * 86_400_000).toISOString(),
        cutoffAt: new Date(nextStarts).toISOString(),
      },
    },
  };
  newPair = pairFor(
    { ...value.upcoming, state: 'current' },
    currentAvailability.availability.cycle,
    52,
  );
  serveNewPair = true;
  expectRolloverAvailability = true;
  const rolloverRefresh = page.evaluate(() => window._randori_availability?.refresh?.());
  await rolloverAvailabilityRead;
  await rolloverRefresh;

  await expect.poll(() => page.evaluate(() => window._randori_onboarding_authority?.snapshot.scope?.targetCycleKey)).toBe('b'.repeat(64));
  await newReadStarted;
  releaseOldRead();
  await staleDashboard;
  await expect(page.locator('#chkPair')).not.toContainText('2099-W51');
  expect(await page.evaluate(() => window._randori_onboarding_authority?.snapshot.pairing.value)).toBeNull();

  releaseNewRead();
  await expect(page.locator('#chkAvail')).toContainText('Availability saved for 2100-W01');
  await expect(page.locator('#chkPair')).toHaveAttribute('data-state', 'done');
  await expect(page.locator('#chkPair')).toContainText('Current assignment published for 2099-W52');
});

test('pair and workspace completion ignore stale room storage and require exact authorized hydration', async ({ page }) => {
  const roomId = 'week_41_pair_73';
  const value = cycles();
  await openAsMember(page, {
    '/api/settings/availability': () => availability('user'),
    '/api/my-pair': () => ({
      ok: true,
      paired: true,
      pairing_status: 'paired',
      workspace_available: true,
      room_id: roomId,
      week_id: 41,
      current_cycle: value.current,
      upcoming_cycle: value.upcoming,
      publication_state: publicationState(value.current, 'published'),
      week: { id: 41, week_label: '2099-W51' },
      pair: { id: 73, pg_id: 73, topic: 'both' },
      partner: { id: 2, name: 'Partner', color: '#9cc0b5', tz: 'UTC', interview_focus: 'both' },
    }),
    '/api/weeks': () => ({
      ok: true,
      current_cycle: cycles().current,
      upcoming_cycle: cycles().upcoming,
      weeks: [{
        id: 41,
        week_label: '2099-W51',
        is_current: true,
        pairs: [{ pg_id: 73, a_id: 1, b_id: 2, a_name: 'Member', b_name: 'Partner' }],
      }],
    }),
    '/api/video/signal': request => {
      const url = new URL(request.url());
      if (url.searchParams.get('channel') === 'workspace') {
        return { ok: true, room_id: roomId, snapshot: null, revision: 0 };
      }
      return { ok: true, room_id: roomId, signals: [], after: 0, count: 0 };
    },
  });

  await expect(page.locator('#chkPair')).toHaveAttribute('data-state', 'done');
  await expect(page.locator('#chkRoom')).toBeVisible();
  await expect(page.locator('#chkRoom')).toHaveAttribute('data-state', 'pending');
  await expect.poll(() => page.evaluate(() => localStorage.getItem('randori-last-room'))).toBeNull();

  await expect(page.locator('#dashJoinSession')).toBeVisible();
  await expect(page.evaluate(room => window._randori_journey?.openAuthorizedJoin?.(room, { forceOpen: true }), roomId)).resolves.toBe(true);
  await expect.poll(() => page.evaluate(() => ({
    room: window._randori_workspace?.room || null,
    hydrated: window._randori_workspace?.hydrated === true,
    authorized: window._randori_authorized_room || null,
  }))).toEqual({ room: roomId, hydrated: true, authorized: roomId });
  await expect(page.locator('#chkRoom')).toHaveAttribute('data-state', 'done');
  await expect(page.locator('#chkRoom')).toContainText('Current workspace opened');
});

test('pairing uses the database observation instant instead of the browser clock', async ({ page }) => {
  const value = cycles();
  await page.clock.install({ time: new Date('2200-01-01T00:00:00.000Z') });
  await openAsMember(page, {
    '/api/settings/availability': () => availability('user'),
    '/api/my-pair': () => ({
      ok: true,
      paired: true,
      pairing_status: 'paired',
      workspace_available: false,
      coordination_only: true,
      week_id: 41,
      current_cycle: value.current,
      upcoming_cycle: value.upcoming,
      publication_state: publicationState(value.current, 'published'),
      week: { id: 41, week_label: value.current.cycleId },
      pair: { id: 73, pg_id: 73, topic: 'both' },
    }),
  });

  await expect(page.locator('#chkPair')).toHaveAttribute('data-state', 'done');
  await expect(page.locator('#chkPair')).toContainText(`Current assignment published for ${value.current.cycleId}`);
});

test('profile save uses inline error and retry states without opening a dialog', async ({ page }) => {
  let saveFails = true;
  let profile = { ...member, tz: '' };
  let dialogOpened = false;
  page.on('dialog', async dialog => { dialogOpened = true; await dialog.dismiss(); });
  await openAsMember(page, {
    '/api/auth/me': () => ({ ok: true, user: profile }),
    '/api/profile': request => {
      if (request.method() === 'GET') return { ok: true, user: profile };
      if (saveFails) return { _status: 503, error: 'update unavailable' };
      profile = { ...profile, ...(request.postDataJSON() as object) };
      return { ok: true, user: profile };
    },
  });

  await expect(page.locator('#view-profile-setup')).toBeVisible();
  await page.locator('#psTz').selectOption('Europe/London');
  await page.locator('#psSave').click();
  await expect(page.locator('#psSaveStatus')).toHaveAttribute('data-state', 'save_error');
  await expect(page.locator('#psSaveStatus')).toContainText('Profile was not saved');
  await expect(page.locator('#psRetry')).toBeVisible();
  expect(dialogOpened).toBe(false);

  saveFails = false;
  await page.locator('#psRetry').click();
  await expect(page.locator('#view-dashboard')).toBeVisible();
  expect(dialogOpened).toBe(false);
});

test('a delayed prior-account profile cannot complete the next account checklist', async ({ page }) => {
  let currentUser = member;
  let firstProfileStarted!: () => void;
  let releaseFirstProfile!: () => void;
  const started = new Promise<void>(resolve => { firstProfileStarted = resolve; });
  const release = new Promise<void>(resolve => { releaseFirstProfile = resolve; });
  let profileReads = 0;
  await openAsMember(page, {
    '/api/auth/me': () => ({ ok: true, user: currentUser }),
    '/api/profile': async () => {
      profileReads += 1;
      const captured = currentUser;
      if (profileReads === 1) {
        firstProfileStarted();
        await release;
      }
      return { ok: true, user: captured };
    },
  });

  await started;
  currentUser = { ...member, id: 2, email: 'next@example.test', name: 'Next', display_name: 'Next', tz: '' };
  await page.evaluate(() => window._randori_auth?.refreshMe?.());
  releaseFirstProfile();

  await expect(page.locator('#chkProfile')).toHaveAttribute('data-state', 'ready');
  await expect(page.locator('#chkProfile')).toContainText('Complete your profile');
  const snapshot = await page.evaluate(() => window._randori_onboarding_authority?.snapshot);
  expect(snapshot?.actorId).toBe(2);
  expect(snapshot?.profile?.user?.id).toBe(2);
});

test('a delayed profile read cannot cross a same-account circle switch', async ({ page }) => {
  let active = 'circle-a';
  let contextVersion = 1;
  let holdRead = false;
  let markReadStarted!: () => void;
  let releaseRead!: () => void;
  let markSwitchStarted!: () => void;
  let releaseSwitch!: () => void;
  const readStarted = new Promise<void>(resolve => { markReadStarted = resolve; });
  const readGate = new Promise<void>(resolve => { releaseRead = resolve; });
  const switchStarted = new Promise<void>(resolve => { markSwitchStarted = resolve; });
  const switchGate = new Promise<void>(resolve => { releaseSwitch = resolve; });
  const circles = [
    { id: 10, public_id: 'circle-a', name: 'Circle A', role: 'owner', is_primary: true },
    { id: 20, public_id: 'circle-b', name: 'Circle B', role: 'owner', is_primary: false },
  ];
  await mockApi(page, {
    '/api/auth/capabilities': {
      ok: true,
      capabilities: {
        passwordLogin: true, passwordSignup: false, googleOAuth: true,
        multiCircleControlPlane: true, multiCircleAvailability: true,
      },
      registrationMode: 'private_beta',
    },
    '/api/auth/me': () => ({ ok: true, user: member }),
    '/api/profile': async () => {
      if (holdRead) { markReadStarted(); await readGate; }
      return { ok: true, user: { ...member, display_name: holdRead ? 'Stale Circle A' : member.display_name } };
    },
    '/api/circles': async request => {
      if (request.method() === 'PUT') {
        markSwitchStarted();
        await switchGate;
        active = 'circle-b'; contextVersion = 2;
      }
      return {
        ok: true, circles, active_circle: circles.find(circle => circle.public_id === active),
        context_version: contextVersion, selection_required: false,
      };
    },
    '/api/circle': () => ({
      ok: true, circle_meta: { id: active === 'circle-a' ? 10 : 20, public_id: active, name: active },
      membership: { role: 'owner' }, circle: [member], count: 1, circle_context_version: contextVersion,
    }),
    '/api/settings/availability': () => ({ ...availability('user'), circle_context_version: contextVersion }),
    '/api/my-pair': () => ({ ...noPair(), circle_public_id: active, circle_context_version: contextVersion }),
  });
  await resetClientState(page, true, { 'randori-onboarded': '0' });
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await expect(page.locator('#chkProfile')).toHaveAttribute('data-state', 'done');

  holdRead = true;
  const pendingRead = page.evaluate(() => window._randori_onboarding_authority?.refresh({ reason: 'test_read' }));
  await readStarted;
  await page.locator('[data-tab="circle"]').click();
  const selecting = page.getByTestId('circle-context-select').selectOption('circle-b');
  await switchStarted;
  releaseRead();
  await pendingRead;
  const snapshot = await page.evaluate(() => window._randori_onboarding_authority?.snapshot);
  expect(snapshot?.profile?.user).toBeNull();
  expect(snapshot?.reason).toBe('circle');
  releaseSwitch();
  await selecting;
});

test('a delayed profile save cannot commit after a same-account circle switch', async ({ page }) => {
  let active = 'circle-a';
  let contextVersion = 1;
  let markSaveStarted!: () => void;
  let releaseSave!: () => void;
  let markSwitchStarted!: () => void;
  let releaseSwitch!: () => void;
  const saveStarted = new Promise<void>(resolve => { markSaveStarted = resolve; });
  const saveGate = new Promise<void>(resolve => { releaseSave = resolve; });
  const switchStarted = new Promise<void>(resolve => { markSwitchStarted = resolve; });
  const switchGate = new Promise<void>(resolve => { releaseSwitch = resolve; });
  const circles = [
    { id: 10, public_id: 'circle-a', name: 'Circle A', role: 'owner', is_primary: true },
    { id: 20, public_id: 'circle-b', name: 'Circle B', role: 'owner', is_primary: false },
  ];
  await mockApi(page, {
    '/api/auth/capabilities': {
      ok: true,
      capabilities: {
        passwordLogin: true, passwordSignup: false, googleOAuth: true,
        multiCircleControlPlane: true, multiCircleAvailability: true,
      },
      registrationMode: 'private_beta',
    },
    '/api/auth/me': () => ({ ok: true, user: member }),
    '/api/profile': async request => {
      if (request.method() === 'POST') {
        markSaveStarted();
        await saveGate;
        return { ok: true, user: { ...member, ...(request.postDataJSON() as object) } };
      }
      return { ok: true, user: member };
    },
    '/api/circles': async request => {
      if (request.method() === 'PUT') {
        markSwitchStarted();
        await switchGate;
        active = 'circle-b'; contextVersion = 2;
      }
      return {
        ok: true, circles, active_circle: circles.find(circle => circle.public_id === active),
        context_version: contextVersion, selection_required: false,
      };
    },
    '/api/circle': () => ({
      ok: true, circle_meta: { id: active === 'circle-a' ? 10 : 20, public_id: active, name: active },
      membership: { role: 'owner' }, circle: [member], count: 1, circle_context_version: contextVersion,
    }),
    '/api/settings/availability': () => ({ ...availability('user'), circle_context_version: contextVersion }),
    '/api/my-pair': () => ({ ...noPair(), circle_public_id: active, circle_context_version: contextVersion }),
  });
  await resetClientState(page, true, { 'randori-onboarded': '0' });
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await page.locator('#dashProfileBtn').click();
  await page.locator('#psName').fill('Stale Circle A');
  await page.locator('#psSave').click();
  await saveStarted;
  const saveAttempt = await page.evaluate(() => window._randori_journey?.profileSaveAttempt);
  expect(saveAttempt).toBeGreaterThan(0);

  await page.locator('[data-tab="circle"]').click();
  const selecting = page.getByTestId('circle-context-select').selectOption('circle-b');
  await switchStarted;
  releaseSave();
  await page.evaluate(attempt => window._randori_journey?.waitForProfileSaveAttempt?.(attempt), saveAttempt);
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('randori-me') || '{}').display_name)).toBe(member.display_name);
  expect((await page.evaluate(() => window._randori_onboarding_authority?.snapshot.profile.user))?.display_name).not.toBe('Stale Circle A');
  await expect(page.locator('#psSaveStatus')).not.toHaveAttribute('data-state', 'saved');
  await expect(page.locator('#view-dashboard')).not.toBeVisible();
  releaseSwitch();
  await selecting;
});
