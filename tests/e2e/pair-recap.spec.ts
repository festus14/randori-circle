import { expect, Page, Request, Route, test } from '@playwright/test';
import { mockApi, originalQuestionFixture } from './helpers';

const roomA = 'week_38_pair_29';
const roomB = 'week_39_pair_30';
const testOrigin = `http://127.0.0.1:${Number(process.env.E2E_PORT || 4173)}`;

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

type RecapActor = { id: number; display_name: string };
type MessageActivity = {
  kind: 'message';
  event_id: string;
  created_at: string;
  actor: RecapActor;
  message: string;
};
type RunActivity = {
  kind: 'run';
  event_id: string;
  created_at: string;
  actor: RecapActor;
  question_slug: string;
  question_version: number;
  language: string;
  passed_count: number;
  total_count: number;
  duration_ms: number;
  authoritative: true;
};
type RecapActivity = MessageActivity | RunActivity;
type RecapWorkspace =
  | { artifact_available: false }
  | {
    artifact_available: true;
    revision: number;
    schema_version: number;
    question_slug: string;
    question_version: number;
    language: string;
    updated_at: string;
  };
type PairRecap = {
  pair: {
    id: number;
    week_id: number;
    week_label: string;
    week_start: string;
    topic: string | null;
    topic_kind: string | null;
    is_ai: boolean;
    members: Array<{ id: number | null; display_name: string; is_me: boolean; is_ai: boolean }>;
  };
  schedule: { agreed_time: string | null; legacy_agreed_time: string | null; updated_at: string | null } | null;
  activity: RecapActivity[];
  workspace: RecapWorkspace;
};
type WorkspaceSnapshot = {
  schema_version: 3;
  revision: number;
  client_id: string;
  client_seq: number;
  code: string;
  language: string;
  question_id: string;
  question_version: number;
  board: { shapes: Array<Record<string, unknown>> };
};
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
  tz: 'America/New_York',
  interview_focus: 'both',
};

const outsider: TestUser = {
  id: 9,
  email: 'outsider@example.test',
  name: 'Outsider',
  display_name: 'Outsider',
  color: '#d68a8a',
  is_available: true,
  tz: 'UTC',
  interview_focus: 'both',
};

const xssMessage = '<img src=x onerror="window.__recapXss=1"><script>window.__recapXss=2</script>';
const serverCode = 'function rollUpFocusBlocks() { return "historical server checkpoint"; }';
const serverBoard = {
  shapes: [{ id: 'server_rect', type: 'rect', x: 12, y: 24, w: 160, h: 90, color: '#9cc0b5' }],
};

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function roomParts(room: string) {
  const match = /^week_([1-9]\d*)_pair_([1-9]\d*)$/.exec(room);
  if (!match) throw new Error(`invalid test room ${room}`);
  return { weekId: Number(match[1]), pairId: Number(match[2]) };
}

function pairResponse(room: string, user: TestUser) {
  const { weekId, pairId } = roomParts(room);
  const partner = user.id === userA.id ? userB : userA;
  return {
    ok: true,
    paired: true,
    room_id: room,
    week_id: weekId,
    week: { id: weekId, week_label: `2026-W${weekId}`, week_start: '2026-09-21T00:00:00.000Z' },
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
    schedule: {
      version: '0'.repeat(64),
      proposals: [],
      agreed_time: null,
      legacy_agreed_time: null,
      updated_at: null,
    },
  };
}

function historyResponse(user: TestUser) {
  const partner = user.id === userA.id ? userB : userA;
  const row = (room: string) => {
    const { weekId, pairId } = roomParts(room);
    return {
      pg_id: pairId,
      week_id: weekId,
      week_label: `2026-W${weekId}`,
      week_start: weekId === 39 ? '2026-09-21T00:00:00.000Z' : '2026-09-14T00:00:00.000Z',
      is_ai: false,
      topic: weekId === 39 ? 'Current pairing' : 'Historical arrays practice',
      topic_kind: 'dsa',
      partner_id: partner.id,
      partner_name: partner.display_name,
      partner_ids: [partner.id],
      partner_names: [partner.display_name],
      you_are_a: user.id === userA.id,
    };
  };
  return {
    ok: true,
    user: { id: user.id, name: user.display_name },
    history: [row(roomB), row(roomA)],
    partner_counts: { [partner.display_name]: 2 },
    total: 2,
  };
}

function baseRecap(room: string): PairRecap {
  const { weekId, pairId } = roomParts(room);
  return {
    pair: {
      id: pairId,
      week_id: weekId,
      week_label: `2026-W${weekId}`,
      week_start: weekId === 39 ? '2026-09-21T00:00:00.000Z' : '2026-09-14T00:00:00.000Z',
      topic: weekId === 39 ? 'Current pairing' : 'Historical arrays practice',
      topic_kind: 'dsa',
      is_ai: false,
      members: [
        { id: userA.id, display_name: userA.display_name, is_me: false, is_ai: false },
        { id: userB.id, display_name: userB.display_name, is_me: false, is_ai: false },
      ],
    },
    schedule: room === roomA ? {
      agreed_time: '2026-09-18T18:30:00.000Z',
      legacy_agreed_time: null,
      updated_at: '2026-09-17T12:00:00.000Z',
    } : null,
    activity: room === roomA ? [
      {
        kind: 'message',
        event_id: 'message:11',
        created_at: '2026-09-18T18:31:00.000Z',
        actor: { id: userB.id, display_name: userB.display_name },
        message: xssMessage,
      },
      {
        kind: 'run',
        event_id: 'run:12',
        created_at: '2026-09-18T18:32:00.000Z',
        actor: { id: userA.id, display_name: userA.display_name },
        question_slug: originalQuestionFixture.slug,
        question_version: originalQuestionFixture.version,
        language: 'javascript',
        passed_count: 4,
        total_count: 4,
        duration_ms: 37,
        authoritative: true,
      },
    ] : [{
      kind: 'message',
      event_id: 'message:21',
      created_at: '2026-09-22T10:00:00.000Z',
      actor: { id: userA.id, display_name: userA.display_name },
      message: 'ROOM_B_ONLY',
    }],
    workspace: room === roomA ? {
      artifact_available: true,
      revision: 7,
      schema_version: 3,
      question_slug: originalQuestionFixture.slug,
      question_version: originalQuestionFixture.version,
      language: 'javascript',
      updated_at: '2026-09-18T18:33:00.000Z',
    } : { artifact_available: false },
  };
}

class RecapStore {
  readonly requests: Array<{ user_id: number; room_id: string }> = [];
  readonly servedResponses: Array<Record<string, unknown>> = [];
  readonly contractViolations: string[] = [];
  private readonly recaps = new Map<string, PairRecap>([
    [roomA, baseRecap(roomA)],
    [roomB, baseRecap(roomB)],
  ]);
  private readonly deniedRooms = new Set<string>();
  private deferred: {
    userId: number;
    room: string;
    gate: Promise<void>;
    markStarted: () => void;
    markDelivered: () => void;
  } | null = null;
  private nextMessageId = 30;

  addMessage(room: string, user: TestUser, message: string) {
    const recap = this.recaps.get(room);
    if (!recap) throw new Error(`missing recap ${room}`);
    const id = this.nextMessageId++;
    recap.activity.push({
      kind: 'message',
      event_id: `message:${id}`,
      created_at: new Date(Date.UTC(2026, 8, 18, 18, 34, id)).toISOString(),
      actor: { id: user.id, display_name: user.display_name },
      message,
    });
  }

  deny(room: string) {
    this.deniedRooms.add(room);
  }

  deferNext(userId: number, room: string): DeferredRequest {
    let release!: () => void;
    let markStarted!: () => void;
    let markDelivered!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const started = new Promise<void>(resolve => { markStarted = resolve; });
    const delivered = new Promise<void>(resolve => { markDelivered = resolve; });
    this.deferred = { userId, room, gate, markStarted, markDelivered };
    return { started, delivered, release };
  }

  route = async (route: Route, user: TestUser) => {
    const request = route.request();
    const url = new URL(request.url());
    const keys = [...url.searchParams.keys()].sort();
    const room = String(url.searchParams.get('room_id') || '');
    if (request.method() !== 'GET' || keys.join(',') !== 'room_id') {
      this.contractViolations.push(`${request.method()} ${url.search}`);
      await this.fulfill(route, { _status: 400, error: 'invalid pair recap request' });
      return;
    }
    if (this.deniedRooms.has(room) || !this.recaps.has(room) || ![userA.id, userB.id].includes(user.id)) {
      await this.fulfill(route, { _status: 404, error: 'pair not found' });
      return;
    }
    this.requests.push({ user_id: user.id, room_id: room });
    const projected = this.project(room, user);
    const deferred = this.deferred?.userId === user.id && this.deferred.room === room
      ? this.deferred
      : null;
    let deferredDelivery: (() => void) | null = null;
    try {
      if (deferred) {
        this.deferred = null;
        deferredDelivery = deferred.markDelivered;
        deferred.markStarted();
        await deferred.gate;
      }
      const response = { ok: true, room_id: room, recap: projected };
      this.servedResponses.push(clone(response));
      await this.fulfill(route, response);
    } catch (error) {
      if (!deferredDelivery) throw error;
    } finally {
      deferredDelivery?.();
    }
  };

  private project(room: string, user: TestUser): PairRecap {
    const recap = clone(this.recaps.get(room));
    if (!recap) throw new Error(`missing recap ${room}`);
    recap.pair.members = recap.pair.members.map(member => ({
      ...member,
      is_me: member.id === user.id,
    }));
    return recap;
  }

  private async fulfill(route: Route, body: Record<string, unknown>) {
    const response = { ...body };
    const status = Number(response._status || (response.ok ? 200 : 500));
    delete response._status;
    await route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(response) });
  }
}

class WorkspaceStore {
  readonly getRequests: Array<{ room_id: string; channel: string; after_revision: number }> = [];
  readonly contractViolations: string[] = [];
  private readonly snapshots = new Map<string, WorkspaceSnapshot>([[roomA, {
    schema_version: 3,
    revision: 7,
    client_id: 'server-historical-room-a',
    client_seq: 4,
    code: serverCode,
    language: 'javascript',
    question_id: originalQuestionFixture.slug,
    question_version: originalQuestionFixture.version,
    board: clone(serverBoard),
  }]]);

  route = (request: Request): Record<string, unknown> => {
    const url = new URL(request.url());
    const keys = [...url.searchParams.keys()].sort();
    const room = String(url.searchParams.get('room_id') || '');
    const channel = String(url.searchParams.get('channel') || '');
    const after = Number(url.searchParams.get('after_revision'));
    if (
      request.method() !== 'GET'
      || keys.join(',') !== 'after_revision,channel,room_id'
      || channel !== 'workspace'
      || !Number.isSafeInteger(after)
      || after < 0
      || !this.snapshots.has(room)
    ) {
      this.contractViolations.push(`${request.method()} ${url.search}`);
      return { _status: 400, ok: false, error: 'invalid workspace request' };
    }
    this.getRequests.push({ room_id: room, channel, after_revision: after });
    const snapshot = this.snapshots.get(room)!;
    return {
      ok: true,
      room_id: room,
      revision: snapshot.revision,
      snapshot: snapshot.revision > after ? clone(snapshot) : null,
    };
  };
}

async function prepareUser(page: Page, user: TestUser, poisonWorkspace = false) {
  await page.context().clearCookies();
  await page.context().addCookies([{
    name: 'randori_session',
    value: `local-e2e-recap-${user.id}`,
    url: testOrigin,
    httpOnly: true,
    sameSite: 'Lax',
  }]);
  await page.addInitScript(({ currentUser, poison, historicalRoom, otherRoom }) => {
    localStorage.clear();
    sessionStorage.clear();
    localStorage.setItem('randori-onboarded', '1');
    localStorage.setItem('randori-banner-dismissed', '1');
    localStorage.setItem('randori-profile-done', '1');
    localStorage.setItem('randori-landing-dismissed', '1');
    localStorage.setItem('randori-me', JSON.stringify(currentUser));
    if (poison) {
      localStorage.setItem('randori-code', JSON.stringify({
        [historicalRoom]: {
          lang: 'javascript',
          qId: 'focus-block-rollup',
          qVersion: 1,
          codes: { javascript: 'LOCAL_TARGET_POISON' },
        },
        [otherRoom]: {
          lang: 'javascript',
          qId: 'focus-block-rollup',
          qVersion: 1,
          codes: { javascript: 'OTHER_ROOM_POISON' },
        },
      }));
      localStorage.setItem(`randori-board:${historicalRoom}`, JSON.stringify({
        shapes: [{ id: 'local_poison', type: 'rect', x: 0, y: 0, w: 1, h: 1, color: '#d68a8a' }],
        viewport: { x: 0, y: 0, scale: 1 },
        color: '#d68a8a',
        dirty: false,
      }));
      localStorage.setItem(`randori-board:${otherRoom}`, JSON.stringify({
        shapes: [{ id: 'other_room_poison', type: 'rect', x: 0, y: 0, w: 2, h: 2, color: '#d68a8a' }],
        viewport: { x: 0, y: 0, scale: 1 },
        color: '#d68a8a',
        dirty: false,
      }));
    }
  }, { currentUser: user, poison: poisonWorkspace, historicalRoom: roomA, otherRoom: roomB });
}

async function openHistory(
  page: Page,
  user: TestUser,
  recaps: RecapStore,
  workspaces = new WorkspaceStore(),
  poisonWorkspace = false,
) {
  await page.route(/^https:\/\//, route => route.abort());
  await mockApi(page, {
    '/api/auth/me': { ok: true, user },
    '/api/profile': { ok: true, user },
    // roomB is the current pairing; roomA deliberately exercises historical authorization.
    '/api/my-pair': () => pairResponse(roomB, user),
    '/api/history': () => historyResponse(user),
    '/api/video/signal': request => workspaces.route(request),
    '/api/schedule': request => {
      const room = new URL(request.url()).searchParams.get('room_id') || roomB;
      return {
        ok: true,
        room_id: room,
        schedule: {
          version: '0'.repeat(64),
          proposals: [],
          agreed_time: null,
          legacy_agreed_time: null,
          updated_at: null,
        },
      };
    },
    '/api/messages': request => {
      const url = new URL(request.url());
      return { ok: true, room_id: url.searchParams.get('room_id') || roomB, messages: [], after: 0 };
    },
  });
  await page.route(/\/api\/pair-recap(?:\?|$)/, route => recaps.route(route, user));
  await prepareUser(page, user, poisonWorkspace);
  await page.goto('/?view=history', { waitUntil: 'domcontentloaded' });
  await expect(page.locator('#view-history')).toBeVisible();
  await expect(page.getByTestId('pair-history-status')).toHaveText('2 pairings loaded');
}

async function openRecap(page: Page, room: string) {
  await page.locator(`[data-testid="pair-history-row"][data-room-id="${room}"]`)
    .getByTestId('pair-history-view-recap')
    .click();
  await expect(page.getByTestId('pair-recap-status')).toHaveText('Recap loaded');
  await expect.poll(() => page.evaluate(() => {
    const recap = (window as typeof window & {
      _randori_pair_recap?: { room?: string; status?: string };
    })._randori_pair_recap;
    return { room: recap?.room || null, status: recap?.status || null };
  })).toEqual({ room, status: 'loaded' });
}

async function recapSnapshot(page: Page): Promise<PairRecap | null> {
  return page.evaluate(() => JSON.parse(JSON.stringify(
    (window as typeof window & { _randori_pair_recap?: { recap?: PairRecap | null } })
      ._randori_pair_recap?.recap || null,
  )));
}

function forbiddenPaths(value: unknown, path = 'response'): string[] {
  const forbidden = new Set([
    'board', 'client_id', 'code', 'email', 'expected', 'provider_output', 'results',
    'results_json', 'shapes', 'test_cases', 'test_cases_snapshot', 'tests', 'transcript', 'updated_by',
  ]);
  if (Array.isArray(value)) return value.flatMap((item, index) => forbiddenPaths(item, `${path}[${index}]`));
  if (!value || typeof value !== 'object') return [];
  return Object.entries(value).flatMap(([key, item]) => [
    ...(forbidden.has(key) ? [`${path}.${key}`] : []),
    ...forbiddenPaths(item, `${path}.${key}`),
  ]);
}

function sharedRecap(recap: PairRecap | null) {
  if (!recap) return null;
  return {
    ...recap,
    pair: {
      ...recap.pair,
      members: recap.pair.members.map(({ is_me: _isMe, ...member }) => member),
    },
  };
}

function expectExactSafeProjection(response: Record<string, unknown>) {
  expect(Object.keys(response).sort()).toEqual(['ok', 'recap', 'room_id']);
  const recap = response.recap as PairRecap;
  expect(Object.keys(recap).sort()).toEqual(['activity', 'pair', 'schedule', 'workspace']);
  expect(Object.keys(recap.pair).sort()).toEqual([
    'id', 'is_ai', 'members', 'topic', 'topic_kind', 'week_id', 'week_label', 'week_start',
  ]);
  for (const member of recap.pair.members) {
    expect(Object.keys(member).sort()).toEqual(['display_name', 'id', 'is_ai', 'is_me']);
  }
  if (recap.schedule) {
    expect(Object.keys(recap.schedule).sort()).toEqual(['agreed_time', 'legacy_agreed_time', 'updated_at']);
  }
  for (const event of recap.activity) {
    expect(Object.keys(event.actor).sort()).toEqual(['display_name', 'id']);
    expect(Object.keys(event).sort()).toEqual(event.kind === 'message'
      ? ['actor', 'created_at', 'event_id', 'kind', 'message']
      : [
        'actor', 'authoritative', 'created_at', 'duration_ms', 'event_id', 'kind', 'language',
        'passed_count', 'question_slug', 'question_version', 'total_count',
      ]);
  }
  expect(Object.keys(recap.workspace).sort()).toEqual(recap.workspace.artifact_available
    ? [
      'artifact_available', 'language', 'question_slug', 'question_version', 'revision',
      'schema_version', 'updated_at',
    ]
    : ['artifact_available']);
}

test('both members see the same safe recap, literal messages, explicit updates, and no polling', async ({ browser }) => {
  const recaps = new RecapStore();
  const contexts = await Promise.all([
    browser.newContext({ timezoneId: 'UTC' }),
    browser.newContext({ timezoneId: 'UTC' }),
  ]);
  const pages = await Promise.all(contexts.map(context => context.newPage()));
  try {
    await Promise.all([
      openHistory(pages[0], userA, recaps),
      openHistory(pages[1], userB, recaps),
    ]);
    await Promise.all(pages.map(page => openRecap(page, roomA)));

    expect(sharedRecap(await recapSnapshot(pages[0]))).toEqual(sharedRecap(await recapSnapshot(pages[1])));
    expect(await pages[0].getByTestId('pair-recap-activity').locator('li').allInnerTexts())
      .toEqual(await pages[1].getByTestId('pair-recap-activity').locator('li').allInnerTexts());
    expect(await pages[0].getByTestId('pair-recap-schedule').textContent())
      .toBe(await pages[1].getByTestId('pair-recap-schedule').textContent());
    expect(await pages[0].getByTestId('pair-recap-workspace').textContent())
      .toBe(await pages[1].getByTestId('pair-recap-workspace').textContent());

    for (const page of pages) {
      const xssRow = page.locator('[data-event-id="message:11"]');
      await expect(xssRow).toContainText(xssMessage);
      await expect(xssRow.locator('img,script')).toHaveCount(0);
      expect(await page.evaluate(() => (window as typeof window & { __recapXss?: number }).__recapXss)).toBeUndefined();
      const browserRecap = await recapSnapshot(page);
      expect(forbiddenPaths(browserRecap)).toEqual([]);
    }

    expect(recaps.servedResponses).toHaveLength(2);
    for (const response of recaps.servedResponses) {
      expectExactSafeProjection(response);
      expect(forbiddenPaths(response)).toEqual([]);
      const serialized = JSON.stringify(response);
      expect(serialized).not.toContain('LOCAL_TARGET_POISON');
      expect(serialized).not.toContain('HIDDEN_CASE_SENTINEL');
      expect(serialized).not.toContain('PROVIDER_OUTPUT_SENTINEL');
    }

    recaps.addMessage(roomA, userB, 'available after explicit refresh');
    const beforeRefresh = recaps.requests.filter(request => request.user_id === userA.id).length;
    await pages[0].getByTestId('pair-recap-refresh').click();
    await expect.poll(() => recaps.requests.filter(request => request.user_id === userA.id).length)
      .toBe(beforeRefresh + 1);
    await expect(pages[0].getByTestId('pair-recap-activity')).toContainText('available after explicit refresh');
    await expect(pages[1].getByTestId('pair-recap-activity')).not.toContainText('available after explicit refresh');
    await pages[1].getByTestId('pair-recap-refresh').click();
    await expect(pages[1].getByTestId('pair-recap-activity')).toContainText('available after explicit refresh');

    const requestCount = recaps.requests.length;
    await pages[0].waitForTimeout(3_200);
    expect(recaps.requests).toHaveLength(requestCount);
    expect(recaps.contractViolations).toEqual([]);
  } finally {
    await Promise.all(contexts.map(context => context.close()));
  }
});

test('delayed recap responses cannot cross room, navigation, or authentication boundaries', async ({ page }) => {
  const recaps = new RecapStore();
  await openHistory(page, userA, recaps);
  await openRecap(page, roomA);

  recaps.addMessage(roomA, userB, 'STALE_ROOM_A_RECAP');
  const delayedA = recaps.deferNext(userA.id, roomA);
  await page.getByTestId('pair-recap-refresh').click();
  await delayedA.started;
  await openRecap(page, roomB);
  await expect(page.getByTestId('pair-recap-activity')).toContainText('ROOM_B_ONLY');
  delayedA.release();
  await delayedA.delivered;
  await expect.poll(() => page.evaluate(() => (
    window as typeof window & { _randori_pair_recap?: { room?: string } }
  )._randori_pair_recap?.room)).toBe(roomB);
  await expect(page.getByTestId('pair-recap-activity')).toContainText('ROOM_B_ONLY');
  await expect(page.getByTestId('pair-recap-activity')).not.toContainText('STALE_ROOM_A_RECAP');

  const delayedAfterNavigation = recaps.deferNext(userA.id, roomB);
  await page.getByTestId('pair-recap-refresh').click();
  await delayedAfterNavigation.started;
  await page.locator('[data-tab="pair"]').click();
  await expect(page.locator('#view-pair')).toBeVisible();
  delayedAfterNavigation.release();
  await delayedAfterNavigation.delivered;
  await expect(page.locator('#view-pair')).toBeVisible();
  await expect(page.locator('#view-code')).not.toBeVisible();

  await page.locator('[data-tab="history"]').click();
  await expect(page.getByTestId('pair-history-status')).toHaveText('2 pairings loaded');
  await openRecap(page, roomB);
  const delayedAfterAuth = recaps.deferNext(userA.id, roomB);
  await page.getByTestId('pair-recap-refresh').click();
  await delayedAfterAuth.started;
  const clearedOnIdentityChange = await page.evaluate(nextUser => {
    const app = window as typeof window & { _randori_auth?: { me?: TestUser | null } };
    if (!app._randori_auth) throw new Error('auth hook unavailable');
    Object.defineProperty(app._randori_auth, 'me', { configurable: true, get: () => nextUser });
    window.dispatchEvent(new CustomEvent('randori:auth-refreshed', {
      detail: { signedIn: true, userId: nextUser.id },
    }));
    return {
      historyChildren: document.querySelector('[data-testid="pair-history-list"]')?.childElementCount,
      recapChildren: document.querySelector('[data-testid="pair-recap"]')?.childElementCount,
    };
  }, userB);
  expect(clearedOnIdentityChange).toEqual({ historyChildren: 0, recapChildren: 0 });
  delayedAfterAuth.release();
  await delayedAfterAuth.delivered;
  await expect.poll(() => page.evaluate(() => {
    const recap = (window as typeof window & {
      _randori_pair_recap?: { room?: string | null; recap?: PairRecap | null };
    })._randori_pair_recap;
    return { room: recap?.room || null, recap: recap?.recap || null };
  })).toEqual({ room: null, recap: null });
  await expect(page.getByTestId('pair-recap')).toBeEmpty();
  expect(recaps.contractViolations).toEqual([]);
});

test('a denied historical target preserves the active workspace authorization', async ({ page }) => {
  const recaps = new RecapStore();
  await openHistory(page, userA, recaps);
  await openRecap(page, roomA);
  await page.evaluate(activeRoom => {
    const app = window as typeof window & {
      _randori_authorized_room?: string | null;
      _randori_workspace?: { room?: string; deactivate?: () => void };
      __recapDeactivations?: number;
    };
    if (!app._randori_workspace) throw new Error('workspace hook unavailable');
    app._randori_authorized_room = activeRoom;
    Object.defineProperty(app._randori_workspace, 'room', { configurable: true, get: () => activeRoom });
    app.__recapDeactivations = 0;
    app._randori_workspace.deactivate = () => { app.__recapDeactivations = (app.__recapDeactivations || 0) + 1; };
  }, roomB);
  recaps.deny(roomA);

  await page.getByTestId('pair-recap-reopen').click();
  await expect(page.getByTestId('pair-recap-status')).toHaveText('Workspace is no longer available.');
  await expect(page.locator('#view-history')).toBeVisible();
  expect(await page.evaluate(() => {
    const app = window as typeof window & { _randori_authorized_room?: string | null; __recapDeactivations?: number };
    return { room: app._randori_authorized_room || null, deactivations: app.__recapDeactivations || 0 };
  })).toEqual({ room: roomB, deactivations: 0 });
});

test('a non-member receives no recap content or workspace action', async ({ page }) => {
  const recaps = new RecapStore();
  await openHistory(page, outsider, recaps);
  await page.locator(`[data-testid="pair-history-row"][data-room-id="${roomA}"]`)
    .getByTestId('pair-history-view-recap')
    .click();
  await expect(page.getByTestId('pair-recap-status')).toHaveText('Pairing recap unavailable — try again.');
  await expect(page.getByTestId('pair-recap-activity')).toHaveCount(0);
  await expect(page.getByTestId('pair-recap-reopen')).toHaveCount(0);
  expect(await recapSnapshot(page)).toBeNull();
  expect(recaps.contractViolations).toEqual([]);
});

test('navigation cancels a delayed historical workspace switch', async ({ page }) => {
  const recaps = new RecapStore();
  await openHistory(page, userA, recaps);
  await openRecap(page, roomA);
  await page.evaluate(() => {
    const app = window as typeof window & {
      _randori_workspace?: { requestAccess?: () => Promise<boolean> };
      __recapSwitchStarted?: boolean;
      __releaseRecapSwitch?: () => void;
    };
    if (!app._randori_workspace) throw new Error('workspace hook unavailable');
    app._randori_workspace.requestAccess = () => new Promise(resolve => {
      app.__recapSwitchStarted = true;
      app.__releaseRecapSwitch = () => resolve(true);
    });
  });

  await page.getByTestId('pair-recap-reopen').click();
  await expect.poll(() => page.evaluate(() => (
    window as typeof window & { __recapSwitchStarted?: boolean }
  ).__recapSwitchStarted === true)).toBe(true);
  await page.locator('[data-tab="pair"]').click();
  await page.evaluate(() => (
    window as typeof window & { __releaseRecapSwitch?: () => void }
  ).__releaseRecapSwitch?.());
  await expect(page.locator('#view-pair')).toBeVisible();
  await expect(page.locator('#view-code')).not.toBeVisible();
  await expect(page).not.toHaveURL(new RegExp(`/join/${roomA}$`));
  expect(await page.evaluate(() => localStorage.getItem('randori-last-room'))).not.toBe(roomA);
});

test('historical reopen requires an available artifact and restores only its authoritative code and board', async ({ page }) => {
  const recaps = new RecapStore();
  const workspaces = new WorkspaceStore();
  await openHistory(page, userA, recaps, workspaces, true);

  await openRecap(page, roomB);
  await expect(page.getByTestId('pair-recap-workspace')).toContainText('No recoverable workspace checkpoint');
  await expect(page.getByTestId('pair-recap-reopen')).toHaveCount(0);

  await openRecap(page, roomA);
  await expect(page.getByTestId('pair-recap-reopen')).toBeEnabled();
  await page.getByTestId('pair-recap-reopen').click();
  await expect(page.locator('#view-code')).toBeVisible();
  await expect(page).toHaveURL(new RegExp(`/join/${roomA}$`));
  await expect.poll(() => page.evaluate(() => (
    window as typeof window & { _randori_workspace?: { hydrated?: boolean; room?: string } }
  )._randori_workspace && ({
    hydrated: (window as typeof window & { _randori_workspace?: { hydrated?: boolean } })._randori_workspace?.hydrated,
    room: (window as typeof window & { _randori_workspace?: { room?: string } })._randori_workspace?.room,
  }))).toEqual({ hydrated: true, room: roomA });
  await expect.poll(() => page.evaluate(() => (
    window as typeof window & { _randori_code?: { getCode?: () => string } }
  )._randori_code?.getCode?.() || document.querySelector<HTMLTextAreaElement>('#editor')?.value || '')).toBe(serverCode);
  await expect.poll(() => page.evaluate(() => JSON.parse(JSON.stringify(
    (window as typeof window & { _randori_board?: { shapes?: Array<Record<string, unknown>> } })
      ._randori_board?.shapes || [],
  )))).toEqual(serverBoard.shapes);
  expect(workspaces.getRequests.length).toBeGreaterThan(0);
  expect(workspaces.getRequests.every(request => request.room_id === roomA && request.channel === 'workspace')).toBe(true);

  await page.goBack({ waitUntil: 'domcontentloaded' });
  await expect(page.locator('#view-history')).toBeVisible();
  await expect(page.getByTestId('pair-history-status')).toHaveText('2 pairings loaded');
  await page.goForward({ waitUntil: 'domcontentloaded' });
  await expect(page.locator('#view-code')).toBeVisible();
  await expect(page).toHaveURL(new RegExp(`/join/${roomA}$`));

  await page.reload({ waitUntil: 'domcontentloaded' });
  await expect(page.locator('#view-code')).toBeVisible();
  await expect(page).toHaveURL(new RegExp(`/join/${roomA}$`));
  await expect.poll(() => page.evaluate(() => (
    window as typeof window & { _randori_workspace?: { hydrated?: boolean; room?: string } }
  )._randori_workspace && ({
    hydrated: (window as typeof window & { _randori_workspace?: { hydrated?: boolean } })._randori_workspace?.hydrated,
    room: (window as typeof window & { _randori_workspace?: { room?: string } })._randori_workspace?.room,
  }))).toEqual({ hydrated: true, room: roomA });
  await expect.poll(() => page.evaluate(() => (
    window as typeof window & { _randori_code?: { getCode?: () => string } }
  )._randori_code?.getCode?.() || document.querySelector<HTMLTextAreaElement>('#editor')?.value || '')).toBe(serverCode);
  await expect.poll(() => page.evaluate(() => JSON.parse(JSON.stringify(
    (window as typeof window & { _randori_board?: { shapes?: Array<Record<string, unknown>> } })
      ._randori_board?.shapes || [],
  )))).toEqual(serverBoard.shapes);
  expect(workspaces.getRequests.every(request => request.room_id === roomA)).toBe(true);
  expect(workspaces.contractViolations).toEqual([]);
  expect(recaps.requests.filter(request => request.room_id === roomA).length).toBeGreaterThanOrEqual(3);
  expect(recaps.contractViolations).toEqual([]);
});
