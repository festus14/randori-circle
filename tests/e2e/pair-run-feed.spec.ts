import { expect, Page, Request, Route, test } from '@playwright/test';
import { mockApi, originalQuestionFixture, setCode } from './helpers';

const roomA = 'week_42_pair_7';
const roomB = 'week_43_pair_8';
const testOrigin = `http://127.0.0.1:${Number(process.env.E2E_PORT || 4173)}`;
const starterCode = originalQuestionFixture.languages.javascript.starter;

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

type SafeRun = {
  id: number;
  runner: { id: number; display_name: string };
  question_slug: string;
  question_version: number;
  language: string;
  passed_count: number;
  total_count: number;
  duration_ms: number;
  created_at: string;
  authoritative: boolean;
};

type StoredRun = SafeRun & {
  room_id: string | null;
  code: string;
  test_cases_snapshot: string;
  results_json: string;
  attestation: string;
  provider_output: string;
  runner_email: string;
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

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function pairResponse(room: string, user: TestUser) {
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
    pair: { pg_id: pairId, user_a_id: 1, user_b_id: 2, is_ai: false, topic: 'Pick together' },
    partner,
    partners: [partner],
    me: user,
  };
}

class WorkspaceStore {
  private readonly snapshots = new Map<string, WorkspaceSnapshot>();

  constructor(rooms: string[]) {
    for (const room of rooms) {
      this.snapshots.set(room, {
        schema_version: 3,
        revision: 1,
        client_id: `server-${room}`,
        client_seq: 1,
        code: starterCode,
        language: 'javascript',
        question_id: originalQuestionFixture.slug,
        question_version: originalQuestionFixture.version,
        board: { shapes: [] },
      });
    }
  }

  handle = (request: Request): Record<string, unknown> => {
    const url = new URL(request.url());
    if (request.method() === 'GET' && url.searchParams.get('channel') === 'workspace') {
      const room = String(url.searchParams.get('room_id') || '');
      const snapshot = this.snapshots.get(room);
      if (!snapshot) return { _status: 404, ok: false, error: 'workspace not found' };
      const after = Number(url.searchParams.get('after_revision') || 0);
      return {
        ok: true,
        room_id: room,
        revision: snapshot.revision,
        snapshot: snapshot.revision > after ? clone(snapshot) : null,
      };
    }
    if (request.method() === 'POST') {
      const body = request.postDataJSON() as {
        room_id?: string;
        type?: string;
        payload?: Omit<WorkspaceSnapshot, 'revision'> & { base_revision: number };
      };
      const room = String(body.room_id || '');
      const current = this.snapshots.get(room);
      if (body.type !== 'code-sync' || !body.payload || !current) {
        return { _status: 400, ok: false, error: 'invalid workspace write' };
      }
      if (body.payload.base_revision !== current.revision) {
        return { _status: 409, ok: false, error: 'revision conflict', current: clone(current) };
      }
      const { base_revision: _baseRevision, ...next } = body.payload;
      const snapshot = { ...next, schema_version: 3 as const, revision: current.revision + 1 };
      this.snapshots.set(room, snapshot);
      return { ok: true, room_id: room, revision: snapshot.revision, snapshot: clone(snapshot) };
    }
    return { ok: true, signals: [], after: 0, count: 0 };
  };
}

type DeferredFeed = {
  room: string;
  started: Promise<void>;
  delivered: Promise<void>;
  release: () => void;
};

class PairRunStore {
  readonly records: StoredRun[] = [];
  readonly executeBodies: Array<Record<string, unknown>> = [];
  readonly pairFeedResponses: Array<Record<string, unknown>> = [];
  readonly pairFeedRequests: Array<{ room_id: string; after_id: number; limit: number }> = [];
  private nextId = 1;
  private deferred: {
    room: string;
    gate: Promise<void>;
    release: () => void;
    started: () => void;
    delivered: () => void;
  } | null = null;

  add(run: Omit<StoredRun, 'id'>): StoredRun {
    const stored = { ...run, id: this.nextId++ };
    this.records.push(stored);
    return stored;
  }

  deferNextFeed(room: string): DeferredFeed {
    let release!: () => void;
    let markStarted!: () => void;
    let markDelivered!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const started = new Promise<void>(resolve => { markStarted = resolve; });
    const delivered = new Promise<void>(resolve => { markDelivered = resolve; });
    this.deferred = { room, gate, release, started: markStarted, delivered: markDelivered };
    return { room, started, delivered, release };
  }

  private safe(run: StoredRun): SafeRun {
    return {
      id: run.id,
      runner: clone(run.runner),
      question_slug: run.question_slug,
      question_version: run.question_version,
      language: run.language,
      passed_count: run.passed_count,
      total_count: run.total_count,
      duration_ms: run.duration_ms,
      created_at: run.created_at,
      authoritative: run.authoritative,
    };
  }

  async routeExecute(route: Route, user: TestUser) {
    const request = route.request();
    const body = request.postDataJSON() as Record<string, unknown>;
    const expectedFields = ['code', 'language', 'question_slug', 'question_version', 'room_id'];
    if (request.method() !== 'POST' || Object.keys(body).sort().join(',') !== expectedFields.join(',')) {
      await this.fulfill(route, { _status: 400, ok: false, error: 'invalid execute request' });
      return;
    }
    const room = String(body.room_id || '');
    if (![roomA, roomB].includes(room)) {
      await this.fulfill(route, { _status: 400, ok: false, error: 'canonical room_id required' });
      return;
    }
    this.executeBodies.push(clone(body));
    const run = this.add({
      room_id: room,
      runner: { id: user.id, display_name: user.display_name },
      question_slug: String(body.question_slug),
      question_version: Number(body.question_version),
      language: String(body.language),
      passed_count: 3,
      total_count: 3,
      duration_ms: 41,
      created_at: '2026-09-18T03:20:00.000Z',
      authoritative: true,
      code: String(body.code),
      test_cases_snapshot: 'HIDDEN_CASE_SENTINEL',
      results_json: 'HIDDEN_RESULT_SENTINEL',
      attestation: 'ATTESTATION_SENTINEL',
      provider_output: 'PROVIDER_OUTPUT_SENTINEL',
      runner_email: user.email,
    });
    await this.fulfill(route, {
      ok: true,
      run_id: run.id,
      question_slug: run.question_slug,
      question_version: run.question_version,
      language: run.language,
      version: '18.15.0',
      runtime_version: '18.15.0',
      passed_count: run.passed_count,
      total_count: run.total_count,
      duration_ms: run.duration_ms,
      results: [0, 1, 2].map(idx => ({ idx, pass: true })),
      piston: { code: 0, signal: null, has_stderr: false },
    });
  }

  async routeRuns(route: Route, user: TestUser) {
    const request = route.request();
    const url = new URL(request.url());
    const room = url.searchParams.get('room_id');
    if (!room) {
      const personalRuns = this.records
        .filter(run => run.runner.id === user.id && run.room_id === null)
        .map(run => this.safe(run));
      await this.fulfill(route, { ok: true, runs: personalRuns, count: personalRuns.length });
      return;
    }

    const queryFields = [...url.searchParams.keys()].sort();
    const afterId = Number(url.searchParams.get('after_id'));
    const limit = Number(url.searchParams.get('limit'));
    if (
      request.method() !== 'GET'
      || queryFields.join(',') !== 'after_id,limit,room_id'
      || !/^week_[1-9]\d*_pair_[1-9]\d*$/.test(room)
      || !Number.isSafeInteger(afterId)
      || afterId < 0
      || !Number.isSafeInteger(limit)
      || limit < 1
      || limit > 20
    ) {
      await this.fulfill(route, { _status: 400, ok: false, error: 'invalid room feed request' });
      return;
    }

    const delayed = this.deferred?.room === room ? this.deferred : null;
    if (delayed) {
      this.deferred = null;
      delayed.started();
      await delayed.gate;
    }

    this.pairFeedRequests.push({ room_id: room, after_id: afterId, limit });
    const roomRuns = this.records
      .filter(run => run.room_id === room)
      .sort((left, right) => left.id - right.id);
    const selected = afterId === 0
      ? roomRuns.slice(-limit)
      : roomRuns.filter(run => run.id > afterId).slice(0, limit);
    const runs = selected.map(run => this.safe(run));
    const response = {
      ok: true,
      room_id: room,
      runs,
      after: runs.length ? runs[runs.length - 1].id : afterId,
    };
    this.pairFeedResponses.push(clone(response));
    try {
      await this.fulfill(route, response);
    } catch (error) {
      // A room switch is required to abort the old request. Playwright may
      // reject fulfillment after that browser-side cancellation; delivery is
      // still considered complete for the test's ordering barrier.
      if (!delayed) throw error;
    } finally {
      delayed?.delivered();
    }
  }

  private async fulfill(route: Route, body: Record<string, unknown>) {
    const response = { ...body };
    const status = Number(response._status || 200);
    delete response._status;
    await route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(response) });
  }
}

function storedRun(
  room: string | null,
  runner: TestUser,
  questionSlug: string,
  authoritative = true,
): Omit<StoredRun, 'id'> {
  return {
    room_id: room,
    runner: { id: runner.id, display_name: runner.display_name },
    question_slug: questionSlug,
    question_version: 1,
    language: 'javascript',
    passed_count: authoritative ? 3 : 0,
    total_count: 3,
    duration_ms: 52,
    created_at: '2026-09-18T03:15:00.000Z',
    authoritative,
    code: `SOURCE_SENTINEL_${questionSlug}`,
    test_cases_snapshot: `HIDDEN_CASE_SENTINEL_${questionSlug}`,
    results_json: `HIDDEN_RESULT_SENTINEL_${questionSlug}`,
    attestation: `ATTESTATION_SENTINEL_${questionSlug}`,
    provider_output: `PROVIDER_OUTPUT_SENTINEL_${questionSlug}`,
    runner_email: runner.email,
  };
}

async function prepareUser(page: Page, user: TestUser) {
  await page.context().clearCookies();
  await page.context().addCookies([{
    name: 'randori_session',
    value: `local-e2e-session-${user.id}`,
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

async function openPairRoom(
  page: Page,
  room: string,
  user: TestUser,
  store: PairRunStore,
  workspace: WorkspaceStore,
  authorizedRoom: () => string = () => room,
) {
  await page.route(/^https:\/\//, route => route.abort());
  await mockApi(page, {
    '/api/auth/me': { ok: true, user },
    '/api/profile': { ok: true, user },
    '/api/questions': { ok: true, questions: [originalQuestionFixture], count: 1 },
    '/api/my-pair': () => pairResponse(authorizedRoom(), user),
    '/api/video/signal': workspace.handle,
  });
  // These are registered after the broad API mock so Playwright gives the
  // contract-sensitive handlers precedence.
  await page.route(/\/api\/runs(?:\?|$)/, route => store.routeRuns(route, user));
  await page.route('**/api/execute', route => store.routeExecute(route, user));
  await prepareUser(page, user);
  await page.goto(`/join/${room}`, { waitUntil: 'domcontentloaded' });
  await waitForRoom(page, room);
}

async function waitForRoom(page: Page, room: string) {
  await expect(page.locator('#view-code')).toBeVisible();
  await expect.poll(() => page.evaluate(() => (
    window as typeof window & { _randori_workspace?: { hydrated?: boolean } }
  )._randori_workspace?.hydrated)).toBe(true);
  await expect.poll(() => page.evaluate(() => {
    const feed = (window as typeof window & {
      _randori_pair_runs?: { room?: string };
    })._randori_pair_runs;
    return feed?.room || null;
  })).toBe(room);
  await expect(page.locator('#pairRunsCard')).toBeVisible();
}

async function feedItems(page: Page): Promise<SafeRun[]> {
  return page.evaluate(() => JSON.parse(JSON.stringify((window as typeof window & {
    _randori_pair_runs?: { items?: SafeRun[] };
  })._randori_pair_runs?.items || [])) as SafeRun[]);
}

async function refreshFeed(page: Page) {
  await page.evaluate(async () => {
    const feed = (window as typeof window & {
      _randori_pair_runs?: { refresh?: () => Promise<void> };
    })._randori_pair_runs;
    if (!feed?.refresh) throw new Error('pair run feed API unavailable');
    await feed.refresh();
  });
}

function assertSafeFeedResponses(responses: Array<Record<string, unknown>>) {
  for (const response of responses) {
    expect(Object.keys(response).sort()).toEqual(['after', 'ok', 'room_id', 'runs']);
    for (const run of response.runs as Array<Record<string, unknown>>) {
      expect(Object.keys(run).sort()).toEqual([
        'authoritative', 'created_at', 'duration_ms', 'id', 'language', 'passed_count',
        'question_slug', 'question_version', 'runner', 'total_count',
      ]);
      expect(Object.keys(run.runner as Record<string, unknown>).sort()).toEqual(['display_name', 'id']);
    }
  }
}

test('both pair members see a verified safe room run after execution and refresh', async ({ browser }) => {
  const store = new PairRunStore();
  const workspace = new WorkspaceStore([roomA, roomB]);
  store.add(storedRun(null, userA, 'personal-private-run'));
  store.add(storedRun(roomB, userB, 'other-room-private-run'));
  const contexts = await Promise.all([browser.newContext(), browser.newContext()]);
  const pages = await Promise.all(contexts.map(context => context.newPage()));
  const submittedCode = 'function rollUpFocusBlocks() { return "SOURCE_ONLY_IN_EDITOR"; }';

  try {
    await Promise.all([
      openPairRoom(pages[0], roomA, userA, store, workspace),
      openPairRoom(pages[1], roomA, userB, store, workspace),
    ]);
    await setCode(pages[0], submittedCode);
    await pages[0].locator('#runBtn').click();

    await expect.poll(() => store.executeBodies).toHaveLength(1);
    expect(store.executeBodies[0]).toEqual({
      language: 'javascript',
      code: submittedCode,
      question_slug: originalQuestionFixture.slug,
      question_version: originalQuestionFixture.version,
      room_id: roomA,
    });
    for (const page of pages) {
      await expect.poll(() => feedItems(page), { timeout: 10_000 }).toHaveLength(1);
      const list = page.locator('#pairRunsList');
      await expect(list).toContainText('Candidate A');
      await expect(list).toContainText(/focus[- ]block[- ]rollup/i);
      await expect(list).toContainText('3/3');
      await expect(list).toContainText(/verified/i);
      await expect(list).not.toContainText(/personal-private-run|other-room-private-run/i);
      await expect(list).not.toContainText(/SOURCE_|HIDDEN_|ATTESTATION_|PROVIDER_|example\.test/i);
    }

    expect(store.pairFeedRequests.every(request => request.room_id === roomA && request.limit === 20)).toBe(true);
    assertSafeFeedResponses(store.pairFeedResponses);
    expect(JSON.stringify(store.pairFeedResponses)).not.toMatch(
      /personal-private-run|other-room-private-run|SOURCE_|HIDDEN_|ATTESTATION_|PROVIDER_|example\.test/i,
    );

    await pages[1].reload({ waitUntil: 'domcontentloaded' });
    await waitForRoom(pages[1], roomA);
    await expect.poll(() => feedItems(pages[1]), { timeout: 10_000 }).toHaveLength(1);
    await expect(pages[1].locator('#pairRunsList')).toContainText('Candidate A');
    await expect(pages[1].locator('#pairRunsList')).toContainText(/verified/i);
  } finally {
    await Promise.all(contexts.map(context => context.close()));
  }
});

test('a run started before workspace hydration is still attributed to the authorized pair room', async ({ page }) => {
  const store = new PairRunStore();
  const workspace = new WorkspaceStore([roomA]);
  let releaseHydration!: () => void;
  let markHydrationStarted!: () => void;
  const hydrationGate = new Promise<void>(resolve => { releaseHydration = resolve; });
  const hydrationStarted = new Promise<void>(resolve => { markHydrationStarted = resolve; });
  let delayedInitialRead = true;

  await page.route(/^https:\/\//, route => route.abort());
  await mockApi(page, {
    '/api/auth/me': { ok: true, user: userA },
    '/api/profile': { ok: true, user: userA },
    '/api/questions': { ok: true, questions: [originalQuestionFixture], count: 1 },
    '/api/my-pair': pairResponse(roomA, userA),
    '/api/video/signal': async request => {
      const url = new URL(request.url());
      if (
        delayedInitialRead
        && request.method() === 'GET'
        && url.searchParams.get('channel') === 'workspace'
        && url.searchParams.get('room_id') === roomA
      ) {
        delayedInitialRead = false;
        markHydrationStarted();
        await hydrationGate;
      }
      return workspace.handle(request);
    },
  });
  await page.route(/\/api\/runs(?:\?|$)/, route => store.routeRuns(route, userA));
  await page.route('**/api/execute', route => store.routeExecute(route, userA));
  await prepareUser(page, userA);

  try {
    await page.goto(`/join/${roomA}`, { waitUntil: 'domcontentloaded' });
    await hydrationStarted;
    await expect(page.locator('#view-code')).toBeVisible();
    await expect(page.locator('#runBtn')).toBeVisible();
    await expect(page.locator('#runBtn')).toBeEnabled();
    await expect(page.locator('#questionSelect')).toHaveValue(originalQuestionFixture.slug);
    await expect.poll(() => page.evaluate(room => {
      const app = window as typeof window & {
        _randori_authorized_room?: string;
        _randori_workspace?: { room?: string; hydrated?: boolean };
      };
      return {
        authorized: app._randori_authorized_room === room,
        workspaceRoom: app._randori_workspace?.room,
        hydrated: app._randori_workspace?.hydrated,
      };
    }, roomA)).toEqual({ authorized: true, workspaceRoom: roomA, hydrated: false });

    const codeAtExecution = await page.evaluate(() => (
      (window as typeof window & { _randori_code?: { getCode?: () => string } })._randori_code?.getCode?.()
      || document.querySelector<HTMLTextAreaElement>('#editor')?.value
      || ''
    ));
    expect(codeAtExecution).toContain('rollUpFocusBlocks');
    await page.locator('#runBtn').click();

    await expect.poll(() => store.executeBodies).toHaveLength(1);
    expect(store.executeBodies[0]).toEqual({
      language: 'javascript',
      code: codeAtExecution,
      question_slug: originalQuestionFixture.slug,
      question_version: originalQuestionFixture.version,
      room_id: roomA,
    });
    const [roomRun] = store.records.filter(run => run.room_id === roomA);
    if (!roomRun) throw new Error('execute result was not attributed to the pair room');

    releaseHydration();
    await waitForRoom(page, roomA);
    await expect.poll(() => feedItems(page), { timeout: 10_000 }).toHaveLength(1);
    await expect.poll(async () => (await feedItems(page))[0]?.id).toBe(roomRun.id);
    await expect(page.locator('#pairRunsList')).toContainText('Candidate A');
    await expect(page.locator('#pairRunsList')).toContainText(/verified/i);
  } finally {
    releaseHydration();
  }
});

test('a delayed old-room response cannot render after switching rooms', async ({ page }) => {
  const store = new PairRunStore();
  const workspace = new WorkspaceStore([roomA, roomB]);
  store.add(storedRun(roomB, userB, 'room-b-current-run'));
  let authorizedRoom = roomA;
  await openPairRoom(page, roomA, userA, store, workspace, () => authorizedRoom);
  await expect.poll(() => store.pairFeedRequests.filter(request => request.room_id === roomA).length)
    .toBeGreaterThan(0);

  await page.evaluate(() => {
    const feed = (window as typeof window & {
      _randori_pair_runs?: { stop?: () => void };
    })._randori_pair_runs;
    if (!feed?.stop) throw new Error('pair run feed API unavailable');
    feed.stop();
  });
  store.add(storedRun(roomA, userA, 'stale-room-a-run'));
  const delayed = store.deferNextFeed(roomA);
  try {
    const refreshPromise = refreshFeed(page);
    await delayed.started;

    await page.evaluate(() => {
      const list = document.getElementById('pairRunsList');
      (window as typeof window & { __sawStalePairRun?: boolean }).__sawStalePairRun = false;
      const inspect = () => {
        if (/stale-room-a-run/i.test(list?.textContent || '')) {
          (window as typeof window & { __sawStalePairRun?: boolean }).__sawStalePairRun = true;
        }
      };
      inspect();
      new MutationObserver(inspect).observe(list || document.body, { childList: true, subtree: true, characterData: true });
    });

    authorizedRoom = roomB;
    await page.evaluate(async room => {
      const workspaceApi = (window as typeof window & {
        _randori_workspace?: { requestAccess?: (roomId: string) => Promise<boolean> };
      })._randori_workspace;
      if (!workspaceApi?.requestAccess || !await workspaceApi.requestAccess(room)) {
        throw new Error('room switch failed');
      }
    }, roomB);
    await waitForRoom(page, roomB);
    await expect.poll(() => feedItems(page)).toHaveLength(1);
    await expect(page.locator('#pairRunsList')).toContainText(/room[- ]b[- ]current[- ]run/i);

    delayed.release();
    await Promise.allSettled([refreshPromise, delayed.delivered]);
    await refreshFeed(page);
    await expect.poll(() => page.evaluate(() => (
      window as typeof window & { __sawStalePairRun?: boolean }
    ).__sawStalePairRun)).toBe(false);
    await expect(page.locator('#pairRunsList')).not.toContainText(/stale-room-a-run/i);
    await expect(page.locator('#pairRunsList')).toContainText(/room[- ]b[- ]current[- ]run/i);
    expect(store.pairFeedRequests.some(request => request.room_id === roomB)).toBe(true);
  } finally {
    delayed.release();
  }
});
