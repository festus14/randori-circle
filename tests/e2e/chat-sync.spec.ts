import { expect, Page, Request, Route, test } from '@playwright/test';
import { mockApi } from './helpers';

const roomA = 'week_52_pair_26';
const roomB = 'week_53_pair_27';
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

type SafeMessage = {
  id: number;
  sender_id: number;
  sender_name: string;
  message: string;
  created_at: string;
};

type StoredMessage = SafeMessage & {
  room_id: string;
  sender_email: string;
  internal_note: string;
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

class ChatStore {
  readonly getRequests: Array<{ user_id: number; room_id: string; after_id: number; limit: number }> = [];
  readonly postBodies: Array<{ user_id: number; body: Record<string, unknown> }> = [];
  readonly contractViolations: string[] = [];
  private readonly messages = new Map<string, StoredMessage[]>();
  private nextId = 1;
  private nextPostStatus: { userId: number; status: number; error: string; retryAfter?: string } | null = null;
  private nextGetStatus: { userId: number; room: string; status: number; error: string } | null = null;
  private malformedPostUserId: number | null = null;
  private mismatch: { userId: number; room: string; responseRoom: string } | null = null;
  private _mismatchConsumed = false;
  private deferredGet: {
    userId: number;
    room: string;
    gate: Promise<void>;
    markStarted: () => void;
    markDelivered: () => void;
  } | null = null;
  private deferredPost: {
    userId: number;
    room: string;
    gate: Promise<void>;
    markStarted: () => void;
    markDelivered: () => void;
  } | null = null;

  constructor(rooms: string[]) {
    rooms.forEach(room => this.messages.set(room, []));
  }

  get mismatchConsumed(): boolean {
    return this._mismatchConsumed;
  }

  add(room: string, user: TestUser, message: string): SafeMessage {
    const list = this.messages.get(room);
    if (!list) throw new Error(`missing chat fixture for ${room}`);
    const id = this.nextId++;
    const stored: StoredMessage = {
      id,
      room_id: room,
      sender_id: user.id,
      sender_name: user.display_name,
      sender_email: user.email,
      internal_note: `private-${id}`,
      message,
      created_at: new Date(Date.UTC(2026, 8, 18, 8, 0, 0) + id * 1_000).toISOString(),
    };
    list.push(stored);
    return this.safe(stored);
  }

  seed(room: string, count: number, messageForId: (id: number) => string = id => `seed message ${id}`) {
    for (let index = 0; index < count; index += 1) {
      const nextId = this.nextId;
      this.add(room, nextId % 2 === 0 ? userB : userA, messageForId(nextId));
    }
  }

  failNextPost(userId: number) {
    this.rejectNextPost(userId, 503, 'messages unavailable');
  }

  rejectNextPost(userId: number, status: number, error: string, retryAfter?: string) {
    this.nextPostStatus = { userId, status, error, retryAfter };
  }

  rejectNextGet(userId: number, room: string, status: number, error: string) {
    this.nextGetStatus = { userId, room, status, error };
  }

  malformNextPostAcknowledgement(userId: number) {
    this.malformedPostUserId = userId;
  }

  mismatchNextGet(userId: number, room: string, responseRoom: string) {
    this._mismatchConsumed = false;
    this.mismatch = { userId, room, responseRoom };
  }

  deferNextGet(userId: number, room: string): DeferredRequest {
    let release!: () => void;
    let markStarted!: () => void;
    let markDelivered!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const started = new Promise<void>(resolve => { markStarted = resolve; });
    const delivered = new Promise<void>(resolve => { markDelivered = resolve; });
    this.deferredGet = { userId, room, gate, markStarted, markDelivered };
    return { started, delivered, release };
  }

  deferNextPost(userId: number, room: string): DeferredRequest {
    let release!: () => void;
    let markStarted!: () => void;
    let markDelivered!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const started = new Promise<void>(resolve => { markStarted = resolve; });
    const delivered = new Promise<void>(resolve => { markDelivered = resolve; });
    this.deferredPost = { userId, room, gate, markStarted, markDelivered };
    return { started, delivered, release };
  }

  route = async (route: Route, user: TestUser, authorizedRoom: () => string) => {
    const request = route.request();
    const url = new URL(request.url());
    let deferredDelivery: (() => void) | null = null;
    try {
      if (request.method() === 'GET') {
        const keys = [...url.searchParams.keys()].sort();
        const room = String(url.searchParams.get('room_id') || '');
        const after = Number(url.searchParams.get('after_id'));
        const limit = Number(url.searchParams.get('limit'));
        if (
          keys.join(',') !== 'after_id,limit,room_id'
          || room !== authorizedRoom()
          || !this.messages.has(room)
          || !Number.isSafeInteger(after)
          || after < 0
          || limit !== 50
        ) {
          this.contractViolations.push(`${request.method()} ${url.search}`);
          await this.fulfill(route, { _status: 400, error: 'invalid chat query' });
          return;
        }
        this.getRequests.push({ user_id: user.id, room_id: room, after_id: after, limit });
        const rejectedGet = this.nextGetStatus?.userId === user.id && this.nextGetStatus.room === room
          ? this.nextGetStatus
          : null;
        if (rejectedGet) {
          this.nextGetStatus = null;
          await this.fulfill(route, { _status: rejectedGet.status, error: rejectedGet.error });
          return;
        }
        const deferred = this.deferredGet?.userId === user.id && this.deferredGet.room === room
          ? this.deferredGet
          : null;
        if (deferred) {
          this.deferredGet = null;
          deferredDelivery = deferred.markDelivered;
          deferred.markStarted();
          await deferred.gate;
        }
        const available = (this.messages.get(room) || []).filter(message => message.id > after);
        const selected = after === 0 ? available.slice(-limit) : available.slice(0, limit);
        const configuredMismatch = this.mismatch?.userId === user.id && this.mismatch.room === room
          ? this.mismatch
          : null;
        const responseRoom = configuredMismatch?.responseRoom || room;
        if (configuredMismatch) this.mismatch = null;
        await this.fulfill(route, {
          ok: true,
          room_id: responseRoom,
          messages: selected.map(message => this.safe(message)),
          after: selected.length ? selected.at(-1)?.id : after,
        });
        if (configuredMismatch) this._mismatchConsumed = true;
        return;
      }

      if (request.method() !== 'POST') {
        this.contractViolations.push(request.method());
        await this.fulfill(route, { _status: 405, error: 'GET or POST only' });
        return;
      }
      const body = request.postDataJSON() as Record<string, unknown>;
      this.postBodies.push({ user_id: user.id, body: clone(body) });
      const room = String(body.room_id || '');
      if (
        Object.keys(body).sort().join(',') !== 'message,room_id'
        || room !== authorizedRoom()
        || !this.messages.has(room)
        || typeof body.message !== 'string'
      ) {
        this.contractViolations.push(`${request.method()} ${JSON.stringify(body)}`);
        await this.fulfill(route, { _status: 400, error: 'invalid chat send' });
        return;
      }
      const rejectedPost = this.nextPostStatus?.userId === user.id ? this.nextPostStatus : null;
      if (rejectedPost) {
        this.nextPostStatus = null;
        await this.fulfill(
          route,
          { _status: rejectedPost.status, error: rejectedPost.error },
          rejectedPost.retryAfter ? { 'Retry-After': rejectedPost.retryAfter } : {},
        );
        return;
      }
      const deferred = this.deferredPost?.userId === user.id && this.deferredPost.room === room
        ? this.deferredPost
        : null;
      if (deferred) {
        this.deferredPost = null;
        deferredDelivery = deferred.markDelivered;
        deferred.markStarted();
        await deferred.gate;
      }
      const message = this.add(room, user, body.message);
      if (this.malformedPostUserId === user.id) {
        this.malformedPostUserId = null;
        await this.fulfill(route, {
          _status: 201,
          ok: true,
          room_id: room,
          message: { ...message, created_at: 'not-a-canonical-instant' },
        });
        return;
      }
      await this.fulfill(route, { _status: 201, ok: true, room_id: room, message });
    } catch (error) {
      if (!deferredDelivery) throw error;
    } finally {
      deferredDelivery?.();
    }
  };

  private safe(message: StoredMessage): SafeMessage {
    return {
      id: message.id,
      sender_id: message.sender_id,
      sender_name: message.sender_name,
      message: message.message,
      created_at: message.created_at,
    };
  }

  private async fulfill(route: Route, body: Record<string, unknown>, headers: Record<string, string> = {}) {
    const response = { ...body };
    const status = Number(response._status || (response.ok ? 200 : 500));
    delete response._status;
    await route.fulfill({ status, headers, contentType: 'application/json', body: JSON.stringify(response) });
  }
}

async function prepareUser(page: Page, user: TestUser) {
  await page.context().clearCookies();
  await page.context().addCookies([{
    name: 'randori_session',
    value: `local-e2e-chat-${user.id}`,
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
  store: ChatStore,
  authorizedRoom: () => string,
  waitUntilReady = true,
) {
  await page.route(/^https:\/\//, route => route.abort());
  await mockApi(page, {
    '/api/auth/me': { ok: true, user },
    '/api/profile': { ok: true, user },
    '/api/my-pair': () => pairResponse(authorizedRoom(), user),
  });
  await page.route(/\/api\/messages(?:\?|$)/, route => store.route(route, user, authorizedRoom));
  await prepareUser(page, user);
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  if (waitUntilReady) await waitForChat(page, authorizedRoom());
}

async function waitForChat(page: Page, room: string) {
  await expect(page.locator('#view-dashboard')).toBeVisible();
  await expect(page.getByTestId('pair-chat')).toBeVisible();
  await expect.poll(() => page.evaluate(() => {
    const chat = (window as typeof window & {
      _randori_chat?: { room?: string; status?: string };
    })._randori_chat;
    return { room: chat?.room || null, status: chat?.status || null };
  })).toEqual({ room, status: expect.stringMatching(/^(?:Up to date|No messages yet)$/) });
}

async function refreshChat(page: Page): Promise<boolean> {
  return page.evaluate(async () => {
    const chat = (window as typeof window & {
      _randori_chat?: { refresh?: () => Promise<boolean> };
    })._randori_chat;
    if (!chat?.refresh) throw new Error('chat API unavailable');
    return chat.refresh();
  });
}

async function renderedMessageIds(page: Page): Promise<number[]> {
  return page.getByTestId('pair-chat-list').locator('[data-message-id]').evaluateAll(items => (
    items.map(item => Number((item as HTMLElement).dataset.messageId))
  ));
}

async function chatSnapshot(page: Page) {
  return page.evaluate(() => {
    const chat = (window as typeof window & {
      _randori_chat?: {
        room?: string;
        after?: number;
        status?: string;
        draft?: string;
        messages?: SafeMessage[];
      };
    })._randori_chat;
    return JSON.parse(JSON.stringify({
      room: chat?.room || null,
      after: chat?.after || 0,
      status: chat?.status || '',
      draft: chat?.draft || '',
      messages: chat?.messages || [],
    }));
  });
}

test('two pair members converge through newest and incremental windows without duplicate or unsafe rendering', async ({ browser }) => {
  const store = new ChatStore([roomA]);
  const htmlMessage = '<img src=x onerror="window.__chatXss=1"><script>window.__chatXss=2</script>';
  store.seed(roomA, 55, id => id === 54 ? htmlMessage : `seed message ${id}`);
  const contexts = await Promise.all([browser.newContext(), browser.newContext()]);
  const pages = await Promise.all(contexts.map(context => context.newPage()));
  let initialBootstrap: DeferredRequest | null = store.deferNextGet(userA.id, roomA);
  let duplicatePoll: DeferredRequest | null = null;

  try {
    await Promise.all([
      openDashboard(pages[0], userA, store, () => roomA, false),
      openDashboard(pages[1], userB, store, () => roomA),
    ]);
    await initialBootstrap.started;
    await expect(pages[0].getByTestId('pair-chat-list')).toHaveAttribute('aria-live', 'off');
    initialBootstrap.release();
    await initialBootstrap.delivered;
    initialBootstrap = null;
    await waitForChat(pages[0], roomA);
    await expect(pages[0].getByTestId('pair-chat-list')).toHaveAttribute('aria-live', 'polite');
    const initialIds = Array.from({ length: 50 }, (_, index) => index + 6);
    for (const page of pages) {
      await expect.poll(() => renderedMessageIds(page)).toEqual(initialIds);
      const htmlRow = page.locator('[data-message-id="54"]');
      await expect(htmlRow.locator('.msg-body')).toHaveText(htmlMessage);
      await expect(htmlRow.locator('img, script')).toHaveCount(0);
      expect(await page.evaluate(() => (window as typeof window & { __chatXss?: number }).__chatXss)).toBeUndefined();
    }
    for (const user of [userA, userB]) {
      expect(store.getRequests.find(request => request.user_id === user.id)).toEqual({
        user_id: user.id,
        room_id: roomA,
        after_id: 0,
        limit: 50,
      });
    }
    const retainedRow = pages[0].locator('[data-message-id="54"]');
    const retainedNode = await retainedRow.elementHandle();
    expect(retainedNode).not.toBeNull();

    const firstIncrement = store.add(roomA, userB, 'increment 56');
    const secondIncrement = store.add(roomA, userA, 'increment 57');
    await Promise.all(pages.map(refreshChat));
    for (const page of pages) {
      await expect.poll(() => renderedMessageIds(page)).toEqual([...initialIds, firstIncrement.id, secondIncrement.id]);
      await expect.poll(async () => (await chatSnapshot(page)).after).toBe(secondIncrement.id);
    }
    expect(await retainedRow.evaluate((node, previous) => node === previous, retainedNode)).toBe(true);
    expect(store.getRequests).toEqual(expect.arrayContaining([
      { user_id: userA.id, room_id: roomA, after_id: 55, limit: 50 },
      { user_id: userB.id, room_id: roomA, after_id: 55, limit: 50 },
    ]));

    duplicatePoll = store.deferNextGet(userA.id, roomA);
    const overlappingRefresh = refreshChat(pages[0]);
    await duplicatePoll.started;
    await pages[0].getByTestId('pair-chat-input').fill('acknowledged once');
    await pages[0].getByTestId('pair-chat-send').click();
    await expect.poll(() => store.postBodies).toHaveLength(1);
    const acknowledgedId = secondIncrement.id + 1;
    const acknowledgedRow = pages[0].locator(`[data-message-id="${acknowledgedId}"]`);
    await expect(acknowledgedRow).toHaveCount(1);
    const acknowledgedNode = await acknowledgedRow.elementHandle();
    expect(acknowledgedNode).not.toBeNull();
    await expect(pages[0].getByTestId('pair-chat-status')).toHaveText('Sent');
    duplicatePoll.release();
    await Promise.all([overlappingRefresh, duplicatePoll.delivered]);
    await expect(acknowledgedRow).toHaveCount(1);
    expect(await acknowledgedRow.evaluate((node, previous) => node === previous, acknowledgedNode)).toBe(true);
    await expect(pages[0].getByTestId('pair-chat-status')).toHaveText('Sent');
    await expect.poll(() => renderedMessageIds(pages[0])).toEqual([...initialIds, firstIncrement.id, secondIncrement.id, acknowledgedId]);
    expect(await refreshChat(pages[0])).toBe(true);
    expect(await acknowledgedRow.evaluate((node, previous) => node === previous, acknowledgedNode)).toBe(true);
    await expect(pages[0].getByTestId('pair-chat-status')).toHaveText('Sent');
    expect(store.postBodies[0]).toEqual({
      user_id: userA.id,
      body: { room_id: roomA, message: 'acknowledged once' },
    });

    await refreshChat(pages[1]);
    await expect.poll(() => renderedMessageIds(pages[1])).toEqual([...initialIds, firstIncrement.id, secondIncrement.id, acknowledgedId]);
    await pages[1].reload({ waitUntil: 'domcontentloaded' });
    await waitForChat(pages[1], roomA);
    const newestAfterRefresh = Array.from({ length: 50 }, (_, index) => index + 9);
    await expect.poll(() => renderedMessageIds(pages[1])).toEqual(newestAfterRefresh);

    const browserMessages = (await chatSnapshot(pages[1])).messages as Array<Record<string, unknown>>;
    expect(browserMessages.every(message => (
      Object.keys(message).sort().join(',') === 'created_at,id,message,sender_id,sender_name'
    ))).toBe(true);
    expect(store.contractViolations).toEqual([]);
  } finally {
    initialBootstrap?.release?.();
    duplicatePoll?.release?.();
    await Promise.all(contexts.map(context => context.close()));
  }
});

test('a failed send preserves its exact draft and retries only when explicitly requested', async ({ page }) => {
  test.slow();
  const store = new ChatStore([roomA]);
  store.failNextPost(userA.id);
  await openDashboard(page, userA, store, () => roomA);

  const rawDraft = '  Keep   exact <b>draft</b>  ';
  await page.getByTestId('pair-chat-input').fill(rawDraft);
  await page.getByTestId('pair-chat-send').click();
  await expect.poll(() => store.postBodies).toHaveLength(1);
  expect(store.postBodies[0]).toEqual({
    user_id: userA.id,
    body: { room_id: roomA, message: rawDraft.trim() },
  });
  await expect(page.getByTestId('pair-chat-status')).toHaveText('Not sent — retry');
  await expect(page.getByTestId('pair-chat-input')).toHaveValue(rawDraft);
  await expect.poll(async () => (await chatSnapshot(page)).draft).toBe(rawDraft);

  await page.waitForTimeout(3_200);
  expect(store.postBodies).toHaveLength(1);
  await expect(page.getByTestId('pair-chat-status')).toHaveText('Not sent — retry');
  await expect(page.getByTestId('pair-chat-input')).toHaveValue(rawDraft);
  await page.getByTestId('pair-chat-send').click();
  await expect.poll(() => store.postBodies).toHaveLength(2);
  expect(store.postBodies[1]).toEqual(store.postBodies[0]);
  await expect(page.getByTestId('pair-chat-input')).toHaveValue('');
  await expect(page.locator('[data-message-id="1"] .msg-body')).toHaveText(rawDraft.trim());
  await expect.poll(async () => (await chatSnapshot(page)).draft).toBe('');

  const delayedPost = store.deferNextPost(userA.id, roomA);
  const submittedDraft = 'first draft to send';
  const newerDraft = 'newer draft must survive';
  await page.getByTestId('pair-chat-input').fill(submittedDraft);
  await page.getByTestId('pair-chat-send').click();
  await delayedPost.started;
  await page.getByTestId('pair-chat-input').fill(newerDraft);
  delayedPost.release();
  await delayedPost.delivered;
  await expect(page.locator('[data-message-id="2"] .msg-body')).toHaveText(submittedDraft);
  await expect(page.getByTestId('pair-chat-status')).toHaveText('Sent');
  await expect(page.getByTestId('pair-chat-input')).toHaveValue(newerDraft);
  await expect.poll(async () => (await chatSnapshot(page)).draft).toBe(newerDraft);
  expect(store.postBodies[2]).toEqual({
    user_id: userA.id,
    body: { room_id: roomA, message: submittedDraft },
  });
  expect(store.contractViolations).toEqual([]);
  await page.locator('[data-tab="pair"]').click();
  await expect(page.getByTestId('pair-chat')).toHaveCount(0);
  await page.unrouteAll({ behavior: 'ignoreErrors' });
});

test('a malformed successful acknowledgement blocks retry until a valid refresh resolves delivery uncertainty', async ({ page }) => {
  const store = new ChatStore([roomA]);
  store.malformNextPostAcknowledgement(userA.id);
  await openDashboard(page, userA, store, () => roomA);

  const staleGet = store.deferNextGet(userA.id, roomA);
  const staleRefresh = refreshChat(page);
  await staleGet.started;
  const recoveryGet = store.deferNextGet(userA.id, roomA);
  try {
    const rawDraft = '  possibly delivered <em>once</em>  ';
    await page.getByTestId('pair-chat-input').fill(rawDraft);
    await page.getByTestId('pair-chat-send').click();

    await expect.poll(() => store.postBodies).toHaveLength(1);
    expect(store.postBodies[0]).toEqual({
      user_id: userA.id,
      body: { room_id: roomA, message: rawDraft.trim() },
    });
    await expect(page.getByTestId('pair-chat-status')).toHaveText('Delivery uncertain — refresh before retry');
    await expect(page.getByTestId('pair-chat-input')).toHaveValue(rawDraft);
    await expect(page.getByTestId('pair-chat-send')).toBeDisabled();
    await expect.poll(async () => (await chatSnapshot(page)).draft).toBe(rawDraft);

    await recoveryGet.started;
    staleGet.release();
    await Promise.allSettled([staleRefresh, staleGet.delivered]);
    await expect(page.getByTestId('pair-chat-status')).toHaveText('Delivery uncertain — refresh before retry');
    await expect(page.getByTestId('pair-chat-send')).toBeDisabled();

    recoveryGet.release();
    await recoveryGet.delivered;
    await expect(page.getByTestId('pair-chat-status')).toHaveText('Latest messages loaded — check before retry');
    await expect(page.getByTestId('pair-chat-send')).toBeEnabled();
    await expect(page.getByTestId('pair-chat-input')).toHaveValue(rawDraft);
    await expect(page.locator('[data-message-id="1"] .msg-body')).toHaveText(rawDraft.trim());
    expect(store.postBodies).toHaveLength(1);
    expect(store.contractViolations).toEqual([]);
  } finally {
    staleGet.release();
    recoveryGet.release();
  }
});

test('rate limits allow only an explicit later retry while a full room remains terminal', async ({ page }) => {
  test.slow();
  const store = new ChatStore([roomA]);
  await openDashboard(page, userA, store, () => roomA);

  const rateLimitedDraft = '  preserve through rate limit  ';
  store.rejectNextPost(userA.id, 429, 'message rate limit reached', '2');
  await page.getByTestId('pair-chat-input').fill(rateLimitedDraft);
  await page.getByTestId('pair-chat-send').click();
  await expect.poll(() => store.postBodies).toHaveLength(1);
  await expect(page.getByTestId('pair-chat-status')).toHaveText(/^Rate limited — retry in [12]s$/);
  await expect(page.getByTestId('pair-chat-input')).toHaveValue(rateLimitedDraft);
  await expect(page.getByTestId('pair-chat-send')).toBeDisabled();

  await expect(page.getByTestId('pair-chat-status')).toHaveText('Rate limit ended — retry when ready');
  await expect(page.getByTestId('pair-chat-send')).toBeEnabled();
  expect(store.postBodies).toHaveLength(1);
  await page.getByTestId('pair-chat-send').click();
  await expect.poll(() => store.postBodies).toHaveLength(2);
  expect(store.postBodies[1]).toEqual(store.postBodies[0]);
  await expect(page.getByTestId('pair-chat-input')).toHaveValue('');

  const fullRoomDraft = 'keep this when the room is full';
  store.rejectNextPost(userA.id, 409, 'room message limit reached');
  await page.getByTestId('pair-chat-input').fill(fullRoomDraft);
  await page.getByTestId('pair-chat-send').click();
  await expect.poll(() => store.postBodies).toHaveLength(3);
  await expect(page.getByTestId('pair-chat-status')).toHaveText('Room is full — sending is disabled');
  await expect(page.getByTestId('pair-chat-input')).toHaveValue(fullRoomDraft);
  await expect.poll(async () => (await chatSnapshot(page)).draft).toBe(fullRoomDraft);
  await expect(page.getByTestId('pair-chat-send')).toBeDisabled();

  expect(await refreshChat(page)).toBe(true);
  await expect(page.getByTestId('pair-chat-status')).toHaveText('Room is full — sending is disabled');
  await expect(page.getByTestId('pair-chat-send')).toBeDisabled();
  expect(store.postBodies).toHaveLength(3);
  expect(store.contractViolations).toEqual([]);
  await page.locator('[data-tab="pair"]').click();
  await expect(page.getByTestId('pair-chat')).toHaveCount(0);
  await page.unrouteAll({ behavior: 'ignoreErrors' });
});

test('a missing pair room clears stale chat and terminates its polling loop', async ({ page }) => {
  const store = new ChatStore([roomA]);
  store.add(roomA, userB, 'stale room message');
  await openDashboard(page, userA, store, () => roomA);
  await expect(page.getByTestId('pair-chat-list')).toContainText('stale room message');

  store.rejectNextGet(userA.id, roomA, 404, 'pair not found');
  expect(await refreshChat(page)).toBe(false);
  await expect(page.getByTestId('pair-chat-status')).toHaveText('Pair room no longer available — refresh dashboard');
  await expect(page.getByTestId('pair-chat')).toHaveCount(0);
  await expect.poll(async () => (await chatSnapshot(page))).toMatchObject({
    room: null,
    after: 0,
    draft: '',
    messages: [],
  });

  const getCountAfterNotFound = store.getRequests.length;
  expect(await refreshChat(page)).toBe(false);
  expect(store.getRequests).toHaveLength(getCountAfterNotFound);
  await page.waitForTimeout(3_200);
  expect(store.getRequests).toHaveLength(getCountAfterNotFound);
  expect(store.contractViolations).toEqual([]);
});

test('hidden chat stays network-silent, resumes immediately, and purges state when auth identity changes', async ({ page }) => {
  const store = new ChatStore([roomA]);
  store.add(roomA, userB, 'visible baseline');
  await openDashboard(page, userA, store, () => roomA);

  await page.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  const hiddenGetCount = store.getRequests.length;
  store.add(roomA, userB, 'arrived while hidden');
  await page.waitForTimeout(3_200);
  expect(store.getRequests).toHaveLength(hiddenGetCount);
  await expect(page.getByTestId('pair-chat')).toHaveCount(0);

  await page.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await expect.poll(() => store.getRequests.length).toBeGreaterThan(hiddenGetCount);
  await expect(page.getByTestId('pair-chat-list')).toContainText('arrived while hidden');

  const privateDraft = 'remove on identity change';
  await page.getByTestId('pair-chat-input').fill(privateDraft);
  await expect.poll(async () => (await chatSnapshot(page)).draft).toBe(privateDraft);
  await page.evaluate(nextUser => {
    const app = window as typeof window & {
      _randori_auth?: { me?: TestUser };
    };
    if (!app._randori_auth) throw new Error('auth API unavailable');
    Object.defineProperty(app._randori_auth, 'me', { configurable: true, get: () => nextUser });
    history.replaceState({}, document.title, '/?view=pair');
    window.dispatchEvent(new CustomEvent('randori:auth-refreshed', {
      detail: { signedIn: true, userId: nextUser.id },
    }));
  }, userB);
  await expect.poll(async () => (await chatSnapshot(page))).toMatchObject({
    room: null,
    after: 0,
    draft: '',
    messages: [],
  });
  await expect(page.getByTestId('pair-chat')).toHaveCount(0);
  expect(store.contractViolations).toEqual([]);
});

test('stale room responses and mismatched envelopes cannot leak after navigation', async ({ page }) => {
  const store = new ChatStore([roomA, roomB]);
  store.add(roomA, userB, 'room A baseline');
  store.add(roomB, userB, 'ROOM_B_ONLY');
  let authorizedRoom = roomA;
  await openDashboard(page, userA, store, () => authorizedRoom);

  store.add(roomA, userB, 'STALE_ROOM_A_GET');
  const delayedGet = store.deferNextGet(userA.id, roomA);
  const staleRefresh = refreshChat(page);
  await delayedGet.started;

  const delayedPost = store.deferNextPost(userA.id, roomA);
  await page.getByTestId('pair-chat-input').fill('LATE_ROOM_A_POST');
  await page.getByTestId('pair-chat-send').click();
  await delayedPost.started;

  authorizedRoom = roomB;
  await page.locator('.brand').click();
  await waitForChat(page, roomB);
  await expect(page.getByTestId('pair-chat-list')).toContainText('ROOM_B_ONLY');

  delayedGet.release();
  delayedPost.release();
  await Promise.allSettled([staleRefresh, delayedGet.delivered, delayedPost.delivered]);
  await expect.poll(async () => (await chatSnapshot(page)).room).toBe(roomB);
  await expect(page.getByTestId('pair-chat-list')).not.toContainText('STALE_ROOM_A_GET');
  await expect(page.getByTestId('pair-chat-list')).not.toContainText('LATE_ROOM_A_POST');
  await expect(page.getByTestId('pair-chat-list')).toContainText('ROOM_B_ONLY');

  const beforeMismatch = await chatSnapshot(page);
  store.mismatchNextGet(userA.id, roomB, roomA);
  const mismatchRefresh = refreshChat(page);
  await expect.poll(() => store.mismatchConsumed).toBe(true);
  await mismatchRefresh;
  const afterMismatch = await chatSnapshot(page);
  expect({
    room: afterMismatch.room,
    after: afterMismatch.after,
    draft: afterMismatch.draft,
    messages: afterMismatch.messages,
  }).toEqual({
    room: beforeMismatch.room,
    after: beforeMismatch.after,
    draft: beforeMismatch.draft,
    messages: beforeMismatch.messages,
  });

  await page.locator('[data-tab="pair"]').click();
  await expect(page.locator('#view-pair')).toBeVisible();
  await expect.poll(async () => (await chatSnapshot(page)).room).toBeNull();
  const getCountOffDashboard = store.getRequests.length;
  expect(await refreshChat(page)).toBe(false);
  expect(store.getRequests).toHaveLength(getCountOffDashboard);
  await page.waitForTimeout(3_200);
  expect(store.getRequests).toHaveLength(getCountOffDashboard);
  expect(store.contractViolations).toEqual([]);
});
