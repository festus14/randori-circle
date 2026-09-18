import { expect, Page, Request, test } from '@playwright/test';
import { mockApi, resetClientState, setCode } from './helpers';

const roomA = 'week_42_pair_7';
const roomB = 'week_43_pair_8';
const initialCode = 'function shared() { return "server"; }';
const testOrigin = `http://127.0.0.1:${Number(process.env.E2E_PORT || 4173)}`;

type BoardShape = Record<string, unknown> & { id: string; type: string };
type BoardState = { shapes: BoardShape[] };
type WorkspaceSnapshot = {
  schema_version: 3;
  revision: number;
  client_id: string;
  client_seq: number;
  code: string;
  language: string;
  question_id: string;
  question_version: number;
  board: BoardState;
};
type WorkspacePayload = Omit<WorkspaceSnapshot, 'revision'> & { base_revision: number };
type WorkspaceRecord = { revision: number; snapshot: WorkspaceSnapshot };

const signedInUser = {
  id: 1,
  email: 'candidate@example.test',
  name: 'Candidate',
  display_name: 'Candidate',
  color: '#c8f6a0',
  is_available: true,
  tz: 'Europe/London',
  interview_focus: 'both',
};

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function pairResponse(room: string) {
  const match = /^week_(\d+)_pair_(\d+)$/.exec(room);
  if (!match) throw new Error(`invalid test room: ${room}`);
  const weekId = Number(match[1]);
  const pairId = Number(match[2]);
  return {
    ok: true,
    paired: true,
    room_id: room,
    week_id: weekId,
    week: { id: weekId, week_label: `2026-W${weekId}` },
    pair: { pg_id: pairId, user_a_id: 1, user_b_id: 2, is_ai: false, topic: 'Pick together' },
    partner: { id: 2, name: 'Partner', display_name: 'Partner', color: '#9cc0b5', tz: 'UTC' },
  };
}

function initialSnapshot(room: string): WorkspaceSnapshot {
  return {
    schema_version: 3,
    revision: 1,
    client_id: `server-${room.replaceAll('_', '-')}`,
    client_seq: 1,
    code: initialCode,
    language: 'javascript',
    question_id: 'focus-block-rollup',
    question_version: 1,
    board: { shapes: [] },
  };
}

class WorkspaceStore {
  readonly records = new Map<string, WorkspaceRecord>();
  writeAttempts = 0;
  failWrites = false;
  beforeCompareAndSwap: ((room: string, payload: WorkspacePayload) => Promise<void>) | null = null;

  constructor(rooms: string[]) {
    for (const room of rooms) {
      const snapshot = initialSnapshot(room);
      this.records.set(room, { revision: snapshot.revision, snapshot });
    }
  }

  current(room: string): WorkspaceSnapshot {
    const record = this.records.get(room);
    if (!record) throw new Error(`workspace room was not seeded: ${room}`);
    return clone(record.snapshot);
  }

  handler = async (request: Request): Promise<Record<string, unknown>> => {
    const url = new URL(request.url());
    if (request.method() === 'GET' && url.searchParams.get('channel') === 'workspace') {
      const room = String(url.searchParams.get('room_id') || '');
      const record = this.records.get(room);
      if (!record) return { _status: 404, ok: false, error: 'workspace room not found' };
      const after = Number(url.searchParams.get('after_revision') || 0);
      return {
        ok: true,
        room_id: room,
        revision: record.revision,
        snapshot: record.revision > after ? clone(record.snapshot) : null,
      };
    }

    if (request.method() === 'POST') {
      this.writeAttempts += 1;
      if (this.failWrites) return { _status: 503, ok: false, error: 'workspace temporarily unavailable' };
      const body = request.postDataJSON() as {
        room_id?: string;
        type?: string;
        payload?: WorkspacePayload;
      };
      const room = String(body.room_id || '');
      const payload = body.payload;
      const record = this.records.get(room);
      if (body.type !== 'code-sync' || !payload || !record) {
        return { _status: 400, ok: false, error: 'invalid workspace write' };
      }
      const payloadFields = [
        'base_revision', 'board', 'client_id', 'client_seq', 'code', 'language',
        'question_id', 'question_version', 'schema_version',
      ];
      if (
        payload.schema_version !== 3
        || Object.keys(payload).sort().join(',') !== payloadFields.join(',')
        || !payload.board
        || Object.keys(payload.board).sort().join(',') !== 'shapes'
        || !Array.isArray(payload.board.shapes)
      ) {
        return { _status: 400, ok: false, error: 'invalid schema v3 workspace payload' };
      }

      await this.beforeCompareAndSwap?.(room, clone(payload));
      const latest = this.records.get(room);
      if (!latest) return { _status: 404, ok: false, error: 'workspace room not found' };
      if (payload.base_revision !== latest.revision) {
        return {
          _status: 409,
          ok: false,
          error: 'revision conflict',
          current: clone(latest.snapshot),
        };
      }

      const { base_revision: _baseRevision, ...candidate } = payload;
      const revision = latest.revision + 1;
      const snapshot = {
        ...candidate,
        schema_version: 3 as const,
        revision,
        board: clone(candidate.board),
      };
      this.records.set(room, { revision, snapshot });
      return { ok: true, room_id: room, revision, snapshot: clone(snapshot) };
    }

    return { ok: true, signals: [], after: 0, count: 0 };
  };
}

async function stopExternalEditors(page: Page) {
  await page.route(/^https:\/\//, route => route.abort());
}

async function preserveAuthenticatedState(page: Page) {
  await page.context().clearCookies();
  await page.context().addCookies([{
    name: 'randori_session',
    value: 'local-e2e-session',
    url: testOrigin,
    httpOnly: true,
    sameSite: 'Lax',
  }]);
  await page.addInitScript(user => {
    localStorage.setItem('randori-onboarded', '1');
    localStorage.setItem('randori-banner-dismissed', '1');
    localStorage.setItem('randori-profile-done', '1');
    localStorage.setItem('randori-landing-dismissed', '1');
    localStorage.setItem('randori-me', JSON.stringify(user));
  }, signedInUser);
}

async function openPairRoom(
  page: Page,
  room: string,
  store: WorkspaceStore,
  authorizedRoom: () => string = () => room,
  preserveLocalState = false,
) {
  await stopExternalEditors(page);
  await mockApi(page, {
    '/api/auth/me': { ok: true, user: signedInUser },
    '/api/profile': { ok: true, user: signedInUser },
    '/api/my-pair': () => pairResponse(authorizedRoom()),
    '/api/video/signal': store.handler,
  });
  if (preserveLocalState) await preserveAuthenticatedState(page);
  else await resetClientState(page, true);
  await page.goto(`/join/${room}`, { waitUntil: 'domcontentloaded' });
  await expect(page.locator('#view-code')).toBeVisible();
  await expect.poll(() => page.evaluate(() => (
    window as typeof window & { _randori_workspace?: { hydrated?: boolean } }
  )._randori_workspace?.hydrated)).toBe(true);
}

async function openBoard(page: Page) {
  await page.locator('[data-tab="board"]').click();
  await expect(page.locator('#view-board')).toBeVisible();
  await expect(page.locator('#board')).toBeVisible();
}

async function boardShapes(page: Page): Promise<BoardShape[]> {
  return page.evaluate(() => {
    const board = (window as typeof window & {
      _randori_board?: { shapes?: Array<Record<string, unknown>> };
    })._randori_board;
    return JSON.parse(JSON.stringify(board?.shapes || []));
  });
}

async function drawRectangle(page: Page, offset = 0, waitForShape = true) {
  await openBoard(page);
  await page.locator('.tool[data-tool="rect"]').click();
  const canvas = page.locator('#board');
  const box = await canvas.boundingBox();
  if (!box) throw new Error('whiteboard canvas has no layout box');
  await page.mouse.move(box.x + 70 + offset, box.y + 70 + offset);
  await page.mouse.down();
  await page.mouse.move(box.x + 180 + offset, box.y + 145 + offset, { steps: 4 });
  await page.mouse.up();
  if (waitForShape) await expect.poll(() => boardShapes(page)).toHaveLength(1);
}

test('pair members converge on board shapes, recover after refresh, and do not bleed into another room', async ({ browser }) => {
  const store = new WorkspaceStore([roomA, roomB]);
  let firstPageAuthorizedRoom = roomA;
  const contexts = await Promise.all([browser.newContext(), browser.newContext()]);
  const pages = await Promise.all(contexts.map(context => context.newPage()));
  try {
    await Promise.all([
      openPairRoom(pages[0], roomA, store, () => firstPageAuthorizedRoom),
      openPairRoom(pages[1], roomA, store),
    ]);

    await drawRectangle(pages[0]);
    await expect.poll(() => store.current(roomA).board.shapes).toHaveLength(1);
    await expect.poll(() => boardShapes(pages[1]), { timeout: 10_000 }).toHaveLength(1);
    expect(store.current(roomB).board.shapes).toEqual([]);

    const storedShape = store.current(roomA).board.shapes[0];
    expect(storedShape.type).toBe('rect');
    await pages[1].reload({ waitUntil: 'domcontentloaded' });
    await expect.poll(() => pageWorkspaceHydrated(pages[1])).toBe(true);
    await expect.poll(() => boardShapes(pages[1]), { timeout: 10_000 }).toEqual([storedShape]);
    await openBoard(pages[1]);
    await expect(pages[1].locator('#boardSyncStatus')).toContainText(/synced/i);

    // Switch rooms without clearing the browser's local storage. This catches
    // accidental fallback to an unscoped/global board cache as well as server
    // snapshots keyed under the wrong room.
    firstPageAuthorizedRoom = roomB;
    await pages[0].evaluate(async room => {
      const workspace = (window as typeof window & {
        _randori_workspace?: { requestAccess?: (roomId: string) => Promise<boolean> };
      })._randori_workspace;
      if (!workspace?.requestAccess) throw new Error('workspace access API unavailable');
      await workspace.requestAccess(room);
    }, roomB);
    await expect.poll(() => pages[0].evaluate(() => (
      window as typeof window & { _randori_workspace?: { room?: string; hydrated?: boolean } }
    )._randori_workspace?.room)).toBe(roomB);
    await expect.poll(() => pageWorkspaceHydrated(pages[0])).toBe(true);
    await expect.poll(() => boardShapes(pages[0])).toEqual([]);
    expect(store.current(roomB).board.shapes).toEqual([]);
  } finally {
    await Promise.all(contexts.map(context => context.close()));
  }
});

test('switching rooms before either debounce persists the completed gesture to its original room', async ({ page }) => {
  const store = new WorkspaceStore([roomA, roomB]);
  let authorizedRoom = roomA;
  await openPairRoom(page, roomA, store, () => authorizedRoom);

  await drawRectangle(page, 15, false);
  const localShape = (await boardShapes(page))[0];
  expect(localShape?.type).toBe('rect');
  expect(store.writeAttempts).toBe(0);

  authorizedRoom = roomB;
  await page.evaluate(async room => {
    const workspace = (window as typeof window & {
      _randori_workspace?: { requestAccess?: (roomId: string) => Promise<boolean> };
    })._randori_workspace;
    if (!workspace?.requestAccess) throw new Error('workspace access API unavailable');
    if (!await workspace.requestAccess(room)) throw new Error('room switch was denied');
  }, roomB);

  await expect.poll(() => store.current(roomA).board.shapes, { timeout: 10_000 }).toEqual([localShape]);
  await expect.poll(() => page.evaluate(() => (
    window as typeof window & { _randori_workspace?: { room?: string; hydrated?: boolean } }
  )._randori_workspace?.room)).toBe(roomB);
  await expect.poll(() => pageWorkspaceHydrated(page)).toBe(true);
  await expect.poll(() => boardShapes(page)).toEqual([]);
  expect(store.current(roomB).board.shapes).toEqual([]);
});

async function pageWorkspaceHydrated(page: Page) {
  return page.evaluate(() => (
    window as typeof window & { _randori_workspace?: { hydrated?: boolean } }
  )._randori_workspace?.hydrated === true);
}

test('a concurrent code edit rebases over a remote board edit without clobbering either field', async ({ browser }) => {
  const store = new WorkspaceStore([roomA]);
  let releaseCodeWrite: (() => void) | null = null;
  let markCodeWriteStarted: (() => void) | null = null;
  const codeWriteStarted = new Promise<void>(resolve => { markCodeWriteStarted = resolve; });
  const codeWriteGate = new Promise<void>(resolve => { releaseCodeWrite = resolve; });
  const changedCode = 'function shared() { return "code from context A"; }';
  let gated = false;
  store.beforeCompareAndSwap = async (room, payload) => {
    if (room === roomA && payload.code === changedCode && !gated) {
      gated = true;
      markCodeWriteStarted?.();
      await codeWriteGate;
    }
  };

  const contexts = await Promise.all([browser.newContext(), browser.newContext()]);
  const pages = await Promise.all(contexts.map(context => context.newPage()));
  try {
    await Promise.all(pages.map(page => openPairRoom(page, roomA, store)));
    await setCode(pages[0], changedCode);
    await codeWriteStarted;

    await drawRectangle(pages[1], 20);
    await expect.poll(() => store.current(roomA).board.shapes).toHaveLength(1);
    expect(store.current(roomA).code).toBe(initialCode);
    releaseCodeWrite?.();

    await expect.poll(() => store.current(roomA).code, { timeout: 10_000 }).toBe(changedCode);
    expect(store.current(roomA).board.shapes).toHaveLength(1);
    await expect.poll(() => boardShapes(pages[0]), { timeout: 10_000 }).toHaveLength(1);
    await expect.poll(() => pages[1].evaluate(() => (
      window as typeof window & { _randori_code?: { getCode?: () => string } }
    )._randori_code?.getCode?.() || document.querySelector<HTMLTextAreaElement>('#editor')?.value), { timeout: 10_000 }).toBe(changedCode);
  } finally {
    releaseCodeWrite?.();
    await Promise.all(contexts.map(context => context.close()));
  }
});

test('a failed board sync keeps the local drawing visible and reports that it is not synced', async ({ page }) => {
  const store = new WorkspaceStore([roomA]);
  store.failWrites = true;
  await openPairRoom(page, roomA, store);

  await drawRectangle(page);
  await expect.poll(() => store.writeAttempts).toBeGreaterThan(0);
  expect(store.current(roomA).board.shapes).toEqual([]);
  await expect.poll(() => boardShapes(page)).toHaveLength(1);
  await expect.poll(() => page.evaluate(room => {
    const raw = localStorage.getItem(`randori-board:${room}`);
    if (!raw) return 0;
    try { return JSON.parse(raw).shapes?.length || 0; } catch { return 0; }
  }, roomA)).toBe(1);
  await expect(page.locator('#boardSyncStatus')).toContainText(/local|retry|offline|failed|could not sync/i);
});

test('a board edit reloaded before its debounce survives locally and syncs after hydration', async ({ page }) => {
  const store = new WorkspaceStore([roomA]);
  await openPairRoom(page, roomA, store, () => roomA, true);

  await drawRectangle(page, 35, false);
  const localBeforeReload = await page.evaluate(room => {
    const raw = localStorage.getItem(`randori-board:${room}`);
    return raw ? JSON.parse(raw) : null;
  }, roomA) as { shapes?: BoardShape[]; dirty?: boolean } | null;
  expect(localBeforeReload?.shapes).toHaveLength(1);
  expect(localBeforeReload?.dirty).toBe(true);
  expect(store.writeAttempts).toBe(0);

  // Reload before the board's 700 ms event debounce can dispatch. The room's
  // dirty local checkpoint must win initial hydration over the empty server
  // board, then be emitted by the workspace's post-hydration save path.
  await page.reload({ waitUntil: 'domcontentloaded' });
  await expect(page.locator('#view-code')).toBeVisible();
  await expect.poll(() => pageWorkspaceHydrated(page)).toBe(true);
  await expect.poll(() => boardShapes(page)).toEqual(localBeforeReload?.shapes);
  await expect.poll(() => store.current(roomA).board.shapes, { timeout: 10_000 })
    .toEqual(localBeforeReload?.shapes);
  await openBoard(page);
  await expect(page.locator('#boardSyncStatus')).toContainText(/synced/i);
  await expect.poll(() => page.evaluate(room => {
    const raw = localStorage.getItem(`randori-board:${room}`);
    return raw ? JSON.parse(raw).dirty : null;
  }, roomA)).toBe(false);
});
