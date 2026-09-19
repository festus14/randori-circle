import { Download, expect, Page, Request, Route, test } from '@playwright/test';
import { mockApi } from './helpers';

const roomA = 'week_42_pair_7';
const roomB = 'week_43_pair_8';
const testOrigin = `http://127.0.0.1:${Number(process.env.E2E_PORT || 4173)}`;
const londonDraft = '2026-10-06T18:30';
const londonInstant = '2026-10-06T17:30:00.000Z';
const losAngelesDraft = '2026-10-06T18:30';
const losAngelesInstant = '2026-10-07T01:30:00.000Z';

type TestUser = {
  id: number;
  email: string;
  name: string;
  display_name: string;
  color: string;
  is_available: boolean;
  tz: string;
  interview_focus: string;
};

type ScheduleProposal = {
  proposal_id: string;
  value: string;
  instant: string | null;
  proposed_by: number | null;
  legacy: boolean;
};

type ScheduleSnapshot = {
  version: string;
  proposals: ScheduleProposal[];
  agreed_time: string | null;
  legacy_agreed_time: string | null;
  updated_at: string | null;
};

type ClientScheduleSnapshot = Omit<ScheduleSnapshot, 'updated_at'>;

type DeferredRequest = {
  started: Promise<void>;
  delivered: Promise<void>;
  release: () => void;
};

const userA: TestUser = {
  id: 1,
  email: 'candidate-a@example.test',
  name: 'Candidate A',
  display_name: 'Candidate A',
  color: '#c8f6a0',
  is_available: true,
  tz: 'Europe/London',
  interview_focus: 'both',
};

const userB: TestUser = {
  id: 2,
  email: 'candidate-b@example.test',
  name: 'Candidate B',
  display_name: 'Candidate B',
  color: '#9cc0b5',
  is_available: true,
  tz: 'America/Los_Angeles',
  interview_focus: 'both',
};

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function opaqueId(value: number): string {
  return value.toString(16).padStart(64, '0');
}

function pairResponse(room: string, user: TestUser, schedule: ScheduleSnapshot | null) {
  const match = /^week_(\d+)_pair_(\d+)$/.exec(room);
  if (!match) throw new Error(`invalid test room: ${room}`);
  const weekId = Number(match[1]);
  const pairId = Number(match[2]);
  const partner = user.id === userA.id ? userB : userA;
  return {
    ok: true,
    paired: true,
    room_id: room,
    week_id: weekId,
    week: { id: weekId, week_label: `2026-W${weekId}` },
    pair: {
      pg_id: pairId,
      week_id: weekId,
      room_id: room,
      user_a_id: userA.id,
      user_b_id: userB.id,
      user_c_id: null,
      is_ai_pair: false,
      is_ai: false,
      topic: 'Pick together',
      topic_kind: 'both',
    },
    partner,
    partners: [partner],
    me: user,
    schedule: schedule ? clone(schedule) : null,
    messagesPreview: [],
  };
}

class ScheduleStore {
  readonly getRequests: string[] = [];
  readonly postBodies: Array<{ user_id: number; body: Record<string, unknown> }> = [];
  readonly conflicts: Array<{ user_id: number; body: Record<string, unknown> }> = [];
  private readonly schedules = new Map<string, ScheduleSnapshot>();
  private revision = 0;
  private proposalSequence = 10_000;
  private deferredGet: {
    room: string;
    response: Record<string, unknown> | null;
    gate: Promise<void>;
    markStarted: () => void;
    markDelivered: () => void;
  } | null = null;
  private deferredPost: {
    userId: number;
    gate: Promise<void>;
    markStarted: () => void;
    markDelivered: () => void;
  } | null = null;

  constructor(rooms: string[]) {
    for (const room of rooms) this.schedules.set(room, this.emptySnapshot());
  }

  snapshot(room: string): ScheduleSnapshot {
    const schedule = this.schedules.get(room);
    if (!schedule) throw new Error(`missing schedule fixture for ${room}`);
    return clone(schedule);
  }

  seed(room: string, values: Partial<Omit<ScheduleSnapshot, 'version' | 'updated_at'>>) {
    const current = this.snapshot(room);
    this.schedules.set(room, {
      ...current,
      ...clone(values),
      version: this.nextVersion(),
      updated_at: this.nextUpdatedAt(),
    });
  }

  deferNextGet(room: string): DeferredRequest {
    let release!: () => void;
    let markStarted!: () => void;
    let markDelivered!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const started = new Promise<void>(resolve => { markStarted = resolve; });
    const delivered = new Promise<void>(resolve => { markDelivered = resolve; });
    this.deferredGet = { room, response: null, gate, markStarted, markDelivered };
    return { started, delivered, release };
  }

  deferNextPost(userId: number): DeferredRequest {
    let release!: () => void;
    let markStarted!: () => void;
    let markDelivered!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const started = new Promise<void>(resolve => { markStarted = resolve; });
    const delivered = new Promise<void>(resolve => { markDelivered = resolve; });
    this.deferredPost = { userId, gate, markStarted, markDelivered };
    return { started, delivered, release };
  }

  route = async (route: Route, user: TestUser, authorizedRoom: () => string) => {
    const request = route.request();
    const url = new URL(request.url());
    let wasDeferred = false;
    let markDelivered: (() => void) | undefined;
    try {
      if (request.method() === 'GET') {
        const queryKeys = [...url.searchParams.keys()].sort();
        const room = String(url.searchParams.get('room_id') || '');
        if (queryKeys.join(',') !== 'room_id' || room !== authorizedRoom() || !this.schedules.has(room)) {
          await this.fulfill(route, { _status: 403, error: 'not member of this pair' });
          return;
        }
        this.getRequests.push(room);
        const deferred = this.deferredGet?.room === room ? this.deferredGet : null;
        if (deferred) {
          this.deferredGet = null;
          deferred.response = { ok: true, room_id: room, schedule: this.snapshot(room) };
          deferred.markStarted();
          wasDeferred = true;
          markDelivered = deferred.markDelivered;
          await deferred.gate;
          await this.fulfill(route, deferred.response);
          return;
        }
        await this.fulfill(route, { ok: true, room_id: room, schedule: this.snapshot(room) });
        return;
      }

      if (request.method() !== 'POST') {
        await this.fulfill(route, { _status: 405, error: 'GET or POST only' });
        return;
      }
      const body = request.postDataJSON() as Record<string, unknown>;
      this.postBodies.push({ user_id: user.id, body: clone(body) });
      const action = String(body.action || '');
      const expectedFields = action === 'propose'
        ? ['action', 'base_version', 'instant', 'room_id']
        : action === 'accept' || action === 'remove'
          ? ['action', 'base_version', 'proposal_id', 'room_id']
          : action === 'clear'
            ? ['action', 'base_version', 'room_id']
            : [];
      const room = String(body.room_id || '');
      if (
        !expectedFields.length
        || Object.keys(body).sort().join(',') !== expectedFields.sort().join(',')
        || room !== authorizedRoom()
        || !this.schedules.has(room)
        || typeof body.base_version !== 'string'
        || !/^[a-f0-9]{64}$/.test(body.base_version)
      ) {
        await this.fulfill(route, { _status: 400, error: 'invalid schedule mutation' });
        return;
      }

      const deferred = this.deferredPost?.userId === user.id ? this.deferredPost : null;
      if (deferred) {
        this.deferredPost = null;
        deferred.markStarted();
        wasDeferred = true;
        markDelivered = deferred.markDelivered;
        await deferred.gate;
      }

      const current = this.snapshot(room);
      if (body.base_version !== current.version) {
        this.conflicts.push({ user_id: user.id, body: clone(body) });
        await this.fulfill(route, {
          _status: 409,
          error: 'schedule changed',
          room_id: room,
          schedule: current,
        });
        return;
      }

      const proposals = [...current.proposals];
      let agreedTime = current.agreed_time;
      let legacyAgreedTime = current.legacy_agreed_time;
      if (action === 'propose') {
        const instant = String(body.instant || '');
        if (new Date(instant).toISOString() !== instant || proposals.some(item => item.instant === instant)) {
          await this.fulfill(route, { _status: 400, error: 'invalid or duplicate instant' });
          return;
        }
        proposals.push({
          proposal_id: opaqueId(++this.proposalSequence),
          value: instant,
          instant,
          proposed_by: user.id,
          legacy: false,
        });
      } else {
        const proposalId = String(body.proposal_id || '');
        const proposalIndex = proposals.findIndex(item => item.proposal_id === proposalId);
        if (action === 'remove') {
          if (proposalIndex < 0) {
            await this.fulfill(route, { _status: 400, error: 'proposal not found' });
            return;
          }
          proposals.splice(proposalIndex, 1);
        } else if (action === 'accept') {
          const proposal = proposals[proposalIndex];
          if (!proposal || proposal.legacy || !proposal.instant) {
            await this.fulfill(route, { _status: 400, error: 'current normalized proposal required' });
            return;
          }
          agreedTime = proposal.instant;
          legacyAgreedTime = null;
        } else if (action === 'clear') {
          agreedTime = null;
          legacyAgreedTime = null;
        }
      }

      const next: ScheduleSnapshot = {
        version: this.nextVersion(),
        proposals,
        agreed_time: agreedTime,
        legacy_agreed_time: legacyAgreedTime,
        updated_at: this.nextUpdatedAt(),
      };
      this.schedules.set(room, next);
      await this.fulfill(route, { ok: true, room_id: room, schedule: clone(next) });
    } catch (error) {
      if (!wasDeferred) throw error;
    } finally {
      markDelivered?.();
    }
  };

  private emptySnapshot(): ScheduleSnapshot {
    return {
      version: this.nextVersion(),
      proposals: [],
      agreed_time: null,
      legacy_agreed_time: null,
      updated_at: null,
    };
  }

  private nextVersion(): string {
    this.revision += 1;
    return opaqueId(this.revision);
  }

  private nextUpdatedAt(): string {
    return `2026-09-18T05:${String(this.revision).padStart(2, '0')}:00.000Z`;
  }

  private async fulfill(route: Route, body: Record<string, unknown>) {
    const response = { ...body };
    const status = Number(response._status || 200);
    delete response._status;
    await route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(response) });
  }
}

async function prepareUser(page: Page, user: TestUser) {
  await page.context().clearCookies();
  await page.context().addCookies([{
    name: 'randori_session',
    value: `local-e2e-schedule-${user.id}`,
    url: testOrigin,
    httpOnly: true,
    sameSite: 'Lax',
  }]);
  await page.addInitScript(currentUser => {
    localStorage.clear();
    sessionStorage.clear();
    localStorage.setItem('randori-onboarded', '1');
    localStorage.setItem('randori-banner-dismissed', '1');
    localStorage.setItem('randori-profile-done', '1');
    localStorage.setItem('randori-landing-dismissed', '1');
    localStorage.setItem('randori-me', JSON.stringify(currentUser));
  }, user);
}

async function openDashboard(
  page: Page,
  user: TestUser,
  store: ScheduleStore,
  authorizedRoom: () => string,
  initialSchedule: () => ScheduleSnapshot | null = () => store.snapshot(authorizedRoom()),
) {
  await page.route(/^https:\/\//, route => route.abort());
  await mockApi(page, {
    '/api/auth/me': { ok: true, user },
    '/api/profile': { ok: true, user },
    '/api/my-pair': () => pairResponse(authorizedRoom(), user, initialSchedule()),
    '/api/messages': { ok: true, messages: [], after: 0 },
  });
  await page.route(/\/api\/schedule(?:\?|$)/, route => store.route(route, user, authorizedRoom));
  await prepareUser(page, user);
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await waitForSchedule(page, authorizedRoom());
}

async function waitForSchedule(page: Page, room: string) {
  await expect(page.locator('#view-dashboard')).toBeVisible();
  await expect(page.getByTestId('schedule-area')).toBeVisible();
  await expect.poll(() => page.evaluate(() => {
    const schedule = (window as typeof window & {
      _randori_schedule?: { room?: string; version?: string };
    })._randori_schedule;
    return { room: schedule?.room || null, version: schedule?.version || null };
  })).toEqual({ room, version: expect.stringMatching(/^[a-f0-9]{64}$/) });
}

async function refreshSchedule(page: Page): Promise<boolean> {
  return page.evaluate(async () => {
    const schedule = (window as typeof window & {
      _randori_schedule?: { refresh?: () => Promise<boolean> };
    })._randori_schedule;
    if (!schedule?.refresh) throw new Error('schedule API unavailable');
    return schedule.refresh();
  });
}

async function scheduleSnapshot(page: Page): Promise<ClientScheduleSnapshot | null> {
  return page.evaluate(() => JSON.parse(JSON.stringify((window as typeof window & {
    _randori_schedule?: { schedule?: ClientScheduleSnapshot | null };
  })._randori_schedule?.schedule || null)) as ClientScheduleSnapshot | null);
}

async function localDisplay(page: Page, instant: string): Promise<string> {
  return page.evaluate(value => new Intl.DateTimeFormat(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    timeZoneName: 'short',
  }).format(new Date(value)), instant);
}

async function downloadText(download: Download): Promise<string> {
  const stream = await download.createReadStream();
  if (!stream) throw new Error('calendar download stream was unavailable');
  const chunks: string[] = [];
  for await (const chunk of stream) chunks.push(chunk.toString());
  return chunks.join('');
}

test('pair members converge on a normalized proposal and acceptance in their own timezones', async ({ browser }) => {
  const store = new ScheduleStore([roomA]);
  const contexts = await Promise.all([
    browser.newContext({ timezoneId: 'Europe/London' }),
    browser.newContext({ timezoneId: 'America/Los_Angeles' }),
  ]);
  const pages = await Promise.all(contexts.map(context => context.newPage()));

  try {
    await Promise.all([
      openDashboard(pages[0], userA, store, () => roomA),
      openDashboard(pages[1], userB, store, () => roomA),
    ]);
    const initialVersion = store.snapshot(roomA).version;
    await pages[0].getByTestId('schedule-input').fill(londonDraft);
    await pages[0].getByTestId('schedule-propose').click();

    await expect.poll(() => store.postBodies).toHaveLength(1);
    expect(store.postBodies[0]).toEqual({
      user_id: userA.id,
      body: {
        room_id: roomA,
        base_version: initialVersion,
        action: 'propose',
        instant: londonInstant,
      },
    });
    await refreshSchedule(pages[1]);
    for (const page of pages) {
      await expect.poll(() => scheduleSnapshot(page)).toMatchObject({
        proposals: [{ value: londonInstant, instant: londonInstant, proposed_by: userA.id, legacy: false }],
        agreed_time: null,
      });
      await expect(page.getByTestId('schedule-proposal')).toHaveCount(1);
      await expect(page.getByTestId('schedule-proposal').locator(`time[datetime="${londonInstant}"]`)).toHaveCount(1);
    }
    const londonText = await pages[0].getByTestId('schedule-proposal').locator('time').textContent();
    const losAngelesText = await pages[1].getByTestId('schedule-proposal').locator('time').textContent();
    expect(londonText).toBe(await localDisplay(pages[0], londonInstant));
    expect(losAngelesText).toBe(await localDisplay(pages[1], londonInstant));
    expect(londonText).not.toBe(losAngelesText);

    const proposed = store.snapshot(roomA).proposals[0];
    const acceptVersion = store.snapshot(roomA).version;
    await pages[1].getByTestId('schedule-accept').click();
    await expect.poll(() => store.postBodies).toHaveLength(2);
    expect(store.postBodies[1]).toEqual({
      user_id: userB.id,
      body: {
        room_id: roomA,
        base_version: acceptVersion,
        action: 'accept',
        proposal_id: proposed.proposal_id,
      },
    });
    await refreshSchedule(pages[0]);
    for (const page of pages) {
      await expect.poll(() => scheduleSnapshot(page)).toMatchObject({ agreed_time: londonInstant });
      await expect(page.getByTestId('schedule-area').locator(`time[datetime="${londonInstant}"]`)).toHaveCount(2);
      await expect(page.getByTestId('schedule-area')).toContainText('Agreed:');
    }
  } finally {
    await Promise.all(contexts.map(context => context.close()));
  }
});

test('accepted schedule exports privately at 320px, reschedules in place, and disappears when cleared', async ({ page }) => {
  const store = new ScheduleStore([roomA]);
  store.seed(roomA, { agreed_time: londonInstant, legacy_agreed_time: null });
  await page.setViewportSize({ width: 320, height: 720 });
  await openDashboard(page, userA, store, () => roomA);
  await page.waitForFunction(() => Boolean((window as typeof window & {
    _randori_calendar_export?: { download?: unknown };
  })._randori_calendar_export?.download));

  const action = page.getByTestId('schedule-calendar-export');
  await expect(action).toBeVisible();
  await expect(action).toHaveAccessibleName(/add the agreed .* session to your calendar/i);
  await expect(page.getByTestId('schedule-area')).toContainText(/60 minutes.*calendar app controls/i);
  const mobileGeometry = await page.evaluate(() => ({
    clientWidth: document.documentElement.clientWidth,
    scrollWidth: document.documentElement.scrollWidth,
    overflowers: [...document.querySelectorAll<HTMLElement>('body *')].flatMap(element => {
      const style = getComputedStyle(element);
      const bounds = element.getBoundingClientRect();
      if (style.display === 'none' || style.visibility === 'hidden'
        || (bounds.left >= -0.5 && bounds.right <= window.innerWidth + 0.5)) return [];
      return [{
        tag: element.tagName,
        id: element.id,
        testId: element.dataset.testid || '',
        className: String(element.className || '').slice(0, 100),
        left: Math.round(bounds.left * 10) / 10,
        right: Math.round(bounds.right * 10) / 10,
        width: Math.round(bounds.width * 10) / 10,
      }];
    }).slice(0, 12),
  }));
  expect(mobileGeometry.clientWidth).toBe(320);
  expect(mobileGeometry.scrollWidth, JSON.stringify(mobileGeometry))
    .toBeLessThanOrEqual(mobileGeometry.clientWidth);

  await action.focus();
  const firstDownloadPromise = page.waitForEvent('download');
  await action.press('Enter');
  const firstDownload = await firstDownloadPromise;
  const firstContent = await downloadText(firstDownload);
  expect(firstDownload.suggestedFilename()).toBe(`randori-${roomA}.ics`);
  expect(firstContent).toContain(`UID:${roomA}@calendar.randori-circle`);
  expect(firstContent).toContain('DTSTART:20261006T173000Z');
  expect(firstContent).toContain('DTEND:20261006T183000Z');
  expect(firstContent).toContain(`URL:${testOrigin}/join/${roomA}`);
  expect(firstContent).not.toMatch(/candidate|example\.test|token|source code|private chat/i);

  const rescheduledInstant = '2026-10-08T19:00:00.000Z';
  store.seed(roomA, { agreed_time: rescheduledInstant, legacy_agreed_time: null });
  await refreshSchedule(page);
  await expect(page.getByTestId('schedule-area').locator(`time[datetime="${rescheduledInstant}"]`)).toHaveCount(1);

  const secondDownloadPromise = page.waitForEvent('download');
  await page.getByTestId('schedule-calendar-export').click();
  const secondContent = await downloadText(await secondDownloadPromise);
  expect(secondContent).toContain(`UID:${roomA}@calendar.randori-circle`);
  expect(secondContent).toContain('DTSTART:20261008T190000Z');
  expect(secondContent).toContain('DTEND:20261008T200000Z');
  expect(secondContent).not.toContain('DTSTART:20261006T173000Z');

  await page.getByTestId('schedule-clear').click();
  await expect.poll(() => store.snapshot(roomA).agreed_time).toBeNull();
  await expect(page.getByTestId('schedule-calendar-export')).toHaveCount(0);
});

test('calendar export stays hidden for proposals, legacy text, cleared schedules, and invalid accepted values', async ({ page }) => {
  const store = new ScheduleStore([roomA]);
  store.seed(roomA, {
    proposals: [{
      proposal_id: opaqueId(9_001),
      value: londonInstant,
      instant: londonInstant,
      proposed_by: userA.id,
      legacy: false,
    }],
    agreed_time: null,
    legacy_agreed_time: null,
  });
  await openDashboard(page, userA, store, () => roomA);
  await expect(page.getByTestId('schedule-calendar-export')).toHaveCount(0);

  store.seed(roomA, {
    proposals: [],
    agreed_time: '2026-10-06',
    legacy_agreed_time: null,
  });
  expect(await refreshSchedule(page)).toBe(true);
  await expect(page.getByTestId('schedule-calendar-export')).toHaveCount(0);

  store.seed(roomA, {
    proposals: [],
    agreed_time: null,
    legacy_agreed_time: 'Tuesday after work',
  });
  await refreshSchedule(page);
  await expect(page.getByTestId('schedule-calendar-export')).toHaveCount(0);
  await expect(page.getByTestId('schedule-area')).toContainText('Legacy agreement:');

  await page.getByTestId('schedule-clear').click();
  await expect.poll(() => store.snapshot(roomA).legacy_agreed_time).toBeNull();
  await expect(page.getByTestId('schedule-calendar-export')).toHaveCount(0);
});

test('a nonexistent daylight-saving wall time is rejected without a schedule mutation', async ({ browser }) => {
  const store = new ScheduleStore([roomA]);
  const context = await browser.newContext({ timezoneId: 'America/Los_Angeles' });
  const page = await context.newPage();

  try {
    await openDashboard(page, userA, store, () => roomA);
    const input = page.getByTestId('schedule-input');
    await expect(page.getByTestId('schedule-area')).toContainText('America/Los_Angeles');
    await expect(page.getByTestId('schedule-area')).toContainText(/clocks go back.*earlier occurrence/i);
    await input.fill('2026-03-08T02:30');
    await page.getByTestId('schedule-propose').click();

    await expect(page.locator('#toast')).toBeVisible();
    await expect(page.locator('#toast')).toContainText(/time may not exist because clocks change/i);
    await expect(input).toHaveValue('2026-03-08T02:30');
    await expect.poll(() => page.evaluate(() => (
      window as typeof window & { _randori_schedule?: { draft?: string } }
    )._randori_schedule?.draft)).toBe('2026-03-08T02:30');
    // A valid click reaches the mocked route synchronously; two animation
    // frames let any erroneously queued fetch surface without a timer sleep.
    await page.evaluate(() => new Promise<void>(resolve => {
      requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
    }));
    expect(store.postBodies).toHaveLength(0);
    await expect.poll(() => scheduleSnapshot(page)).toMatchObject({ proposals: [] });
  } finally {
    await context.close();
  }
});

test('a stale same-version proposal refreshes without losing either member draft or update', async ({ browser }) => {
  const store = new ScheduleStore([roomA]);
  const contexts = await Promise.all([
    browser.newContext({ timezoneId: 'Europe/London' }),
    browser.newContext({ timezoneId: 'America/Los_Angeles' }),
  ]);
  const pages = await Promise.all(contexts.map(context => context.newPage()));

  try {
    await Promise.all([
      openDashboard(pages[0], userA, store, () => roomA, () => null),
      openDashboard(pages[1], userB, store, () => roomA, () => null),
    ]);
    expect(store.getRequests.filter(room => room === roomA).length).toBeGreaterThanOrEqual(2);
    const sharedVersion = store.snapshot(roomA).version;
    await pages[0].getByTestId('schedule-input').fill(londonDraft);
    await pages[1].getByTestId('schedule-input').fill(losAngelesDraft);

    const stale = store.deferNextPost(userA.id);
    await pages[0].getByTestId('schedule-propose').click();
    await stale.started;
    await pages[1].getByTestId('schedule-propose').click();
    await expect.poll(() => store.snapshot(roomA).proposals.map(item => item.instant))
      .toEqual([losAngelesInstant]);
    await pages[0].evaluate(() => {
      const app = window as typeof window & { __sawScheduleConflict?: boolean };
      const area = document.querySelector('[data-testid="schedule-area"]');
      app.__sawScheduleConflict = false;
      const inspect = () => {
        if (/conflict — refreshed/i.test(area?.textContent || '')) app.__sawScheduleConflict = true;
      };
      inspect();
      new MutationObserver(inspect).observe(area || document.body, {
        childList: true,
        subtree: true,
        characterData: true,
      });
    });
    stale.release();
    await stale.delivered;

    await expect.poll(() => store.conflicts).toHaveLength(1);
    expect(store.postBodies.slice(0, 2).map(entry => entry.body)).toEqual([
      { room_id: roomA, base_version: sharedVersion, action: 'propose', instant: londonInstant },
      { room_id: roomA, base_version: sharedVersion, action: 'propose', instant: losAngelesInstant },
    ]);
    await expect.poll(() => pages[0].evaluate(() => (
      window as typeof window & { __sawScheduleConflict?: boolean }
    ).__sawScheduleConflict)).toBe(true);
    await expect(pages[0].getByTestId('schedule-input')).toHaveValue(londonDraft);
    await expect.poll(() => pages[0].evaluate(() => (
      window as typeof window & { _randori_schedule?: { draft?: string } }
    )._randori_schedule?.draft)).toBe(londonDraft);

    const retryVersion = store.snapshot(roomA).version;
    await pages[0].getByTestId('schedule-propose').click();
    await expect.poll(() => store.postBodies).toHaveLength(3);
    expect(store.postBodies[2]).toEqual({
      user_id: userA.id,
      body: { room_id: roomA, base_version: retryVersion, action: 'propose', instant: londonInstant },
    });
    await refreshSchedule(pages[1]);
    const expectedInstants = [losAngelesInstant, londonInstant];
    expect(store.snapshot(roomA).proposals.map(item => item.instant)).toEqual(expectedInstants);
    for (const page of pages) {
      await expect.poll(async () => (await scheduleSnapshot(page))?.proposals.map(item => item.instant))
        .toEqual(expectedInstants);
    }
  } finally {
    await Promise.all(contexts.map(context => context.close()));
  }
});

test('legacy values remain removable and stale polling cannot cross pair or dashboard navigation', async ({ page }) => {
  const store = new ScheduleStore([roomA, roomB]);
  const legacyProposalId = opaqueId(8_001);
  const legacyProposal = 'Tuesday after work — confirm in chat';
  const legacyAgreement = 'Next Tuesday, same time as usual';
  store.seed(roomA, {
    proposals: [{
      proposal_id: legacyProposalId,
      value: legacyProposal,
      instant: null,
      proposed_by: null,
      legacy: true,
    }],
    agreed_time: null,
    legacy_agreed_time: legacyAgreement,
  });
  const roomBInstant = '2026-10-08T19:00:00.000Z';
  store.seed(roomB, {
    proposals: [{
      proposal_id: opaqueId(8_002),
      value: roomBInstant,
      instant: roomBInstant,
      proposed_by: userB.id,
      legacy: false,
    }],
  });
  let authorizedRoom = roomA;
  await openDashboard(page, userA, store, () => authorizedRoom);

  const legacyRow = page.getByTestId('schedule-proposal').filter({ hasText: legacyProposal });
  await expect(legacyRow).toBeVisible();
  await expect(legacyRow).toContainText(/legacy proposal/i);
  await expect(legacyRow.getByTestId('schedule-accept')).toHaveCount(0);
  await expect(legacyRow.getByTestId('schedule-remove')).toHaveCount(1);
  await expect(page.getByTestId('schedule-area')).toContainText(legacyAgreement);

  const clearVersion = store.snapshot(roomA).version;
  await page.getByTestId('schedule-clear').click();
  await expect.poll(() => store.postBodies).toHaveLength(1);
  expect(store.postBodies[0]).toEqual({
    user_id: userA.id,
    body: { room_id: roomA, base_version: clearVersion, action: 'clear' },
  });
  await expect(page.getByTestId('schedule-area')).not.toContainText(legacyAgreement);

  const removeVersion = store.snapshot(roomA).version;
  await page.getByTestId('schedule-remove').click();
  await expect.poll(() => store.postBodies).toHaveLength(2);
  expect(store.postBodies[1]).toEqual({
    user_id: userA.id,
    body: { room_id: roomA, base_version: removeVersion, action: 'remove', proposal_id: legacyProposalId },
  });
  await expect(page.getByTestId('schedule-proposal')).toHaveCount(0);

  store.seed(roomA, {
    proposals: [{
      proposal_id: opaqueId(8_003),
      value: 'STALE_ROOM_A_SCHEDULE',
      instant: null,
      proposed_by: null,
      legacy: true,
    }],
  });
  const delayed = store.deferNextGet(roomA);
  try {
    const refreshPromise = refreshSchedule(page);
    await delayed.started;

    await page.locator('[data-tab="pair"]').click();
    await expect(page.locator('#view-pair')).toBeVisible();
    await expect.poll(() => page.evaluate(() => (
      window as typeof window & { _randori_schedule?: { room?: string | null } }
    )._randori_schedule?.room ?? null)).toBeNull();
    const requestsAfterNavigation = store.getRequests.length;
    expect(await refreshSchedule(page)).toBe(false);
    expect(store.getRequests).toHaveLength(requestsAfterNavigation);
    // The production poll interval is 3s. Staying off-dashboard for a full
    // interval proves the timer itself is gated, not only the public hook.
    await page.waitForTimeout(3_200);
    expect(store.getRequests).toHaveLength(requestsAfterNavigation);

    authorizedRoom = roomB;
    await page.locator('.brand').click();
    await waitForSchedule(page, roomB);
    await expect(page.getByTestId('schedule-area')).toContainText(await localDisplay(page, roomBInstant));

    delayed.release();
    await Promise.allSettled([refreshPromise, delayed.delivered]);
    await expect.poll(() => page.evaluate(() => (
      window as typeof window & { _randori_schedule?: { room?: string | null } }
    )._randori_schedule?.room ?? null)).toBe(roomB);
    await expect(page.getByTestId('schedule-area')).not.toContainText('STALE_ROOM_A_SCHEDULE');
    await expect(page.getByTestId('schedule-area')).toContainText(await localDisplay(page, roomBInstant));
  } finally {
    delayed.release();
  }
});
