import { expect, Page, Request, test } from '@playwright/test';
import { mockApi, originalQuestionFixture, resetClientState, setCode } from './helpers';

const roomId = 'week_42_pair_7';
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

function pairResponse(room = roomId) {
  return {
    ok: true,
    paired: true,
    room_id: room,
    week_id: 42,
    week: { id: 42, week_label: '2026-W38' },
    pair: { pg_id: 7, user_a_id: 1, user_b_id: 2, is_ai: false, topic: 'Pick together' },
    partner: { id: 2, name: 'Partner', display_name: 'Partner', color: '#9cc0b5', tz: 'UTC' },
  };
}

async function stopExternalEditors(page: Page) {
  await page.route(/^https:\/\//, route => route.abort());
}

async function installFakeMonaco(page: Page) {
  await stopExternalEditors(page);
  await page.addInitScript(() => {
    let currentValue = '';
    let contentListener: (() => void) | undefined;
    const editor = {
      getValue: () => currentValue,
      setValue: (value: string) => {
        if (value === currentValue) return;
        currentValue = value;
        contentListener?.();
      },
      getModel: () => ({}),
      addAction: () => undefined,
      getAction: () => ({ run: async () => undefined }),
      onDidChangeModelContent: (listener: () => void) => { contentListener = listener; },
      onDidChangeModelDecorations: () => undefined,
    };
    const app = window as typeof window & {
      require?: ((dependencies: string[], callback: () => void) => void) & { config?: () => void };
      monaco?: Record<string, unknown>;
    };
    const amd = ((_: string[], callback: () => void) => queueMicrotask(callback)) as typeof app.require;
    if (amd) amd.config = () => undefined;
    app.require = amd;
    app.monaco = {
      editor: {
        create: (_host: unknown, options: { value?: string }) => {
          currentValue = options.value || '';
          return editor;
        },
        setModelLanguage: () => undefined,
        getModelMarkers: () => [],
        setTheme: () => undefined,
      },
      languages: {
        typescript: {
          javascriptDefaults: { setDiagnosticsOptions: () => undefined, setCompilerOptions: () => undefined },
          typescriptDefaults: { setEagerModelSync: () => undefined },
          ScriptTarget: { ES2020: 1 },
          ModuleResolutionKind: { NodeJs: 1 },
          ModuleKind: { CommonJS: 1 },
        },
      },
      KeyMod: { Shift: 1, Alt: 2 },
      KeyCode: { KeyF: 3 },
    };
  });
}

test('canonical invite preserves its URL and requires authentication before storing or opening the room', async ({ page }) => {
  await stopExternalEditors(page);
  await mockApi(page);
  await resetClientState(page, false);

  await page.goto(`/join/${roomId}`, { waitUntil: 'domcontentloaded' });

  await expect(page).toHaveURL(new RegExp(`/join/${roomId}$`));
  await expect(page.locator('#authOverlay')).toHaveClass(/show/);
  await expect(page.locator('#view-landing')).toBeVisible();
  await expect(page.locator('#view-code')).not.toBeVisible();
  expect(await page.evaluate(() => localStorage.getItem('randori-last-room'))).toBeNull();

  await page.locator('#authGoogle').click();
  await expect(page).toHaveURL(/\/api\/auth\/google\/start\?return_to=%2Fjoin%2Fweek_42_pair_7$/);
});

test('an authenticated invite is denied unless it exactly matches /api/my-pair room_id', async ({ page }) => {
  let workspaceRequests = 0;
  await stopExternalEditors(page);
  await mockApi(page, {
    '/api/auth/me': { ok: true, user: signedInUser },
    '/api/profile': { ok: true, user: signedInUser },
    '/api/my-pair': pairResponse('week_42_pair_999'),
    '/api/video/signal': () => { workspaceRequests += 1; return { ok: true, revision: 0, snapshot: null }; },
  });
  await resetClientState(page, true);

  await page.goto(`/join/${roomId}`, { waitUntil: 'domcontentloaded' });

  await expect(page).toHaveURL(new RegExp(`/join/${roomId}$`));
  await expect(page.locator('#view-dashboard')).toBeVisible();
  await expect(page.locator('#view-code')).not.toBeVisible();
  expect(await page.evaluate(() => localStorage.getItem('randori-last-room'))).toBeNull();
  expect(workspaceRequests).toBe(0);
});

test('an empty pair workspace starts from the versioned catalogue instead of a legacy question', async ({ page }) => {
  let savedPayload: Record<string, unknown> | undefined;
  let revision = 0;
  await stopExternalEditors(page);
  await mockApi(page, {
    '/api/auth/me': { ok: true, user: signedInUser },
    '/api/profile': { ok: true, user: signedInUser },
    '/api/my-pair': pairResponse(),
    '/api/video/signal': request => {
      const url = new URL(request.url());
      if (request.method() === 'GET' && url.searchParams.get('channel') === 'workspace') {
        return { ok: true, room_id: roomId, revision, snapshot: null };
      }
      const body = request.postDataJSON() as { payload?: Record<string, unknown> };
      savedPayload = body.payload;
      revision += 1;
      return { ok: true, room_id: roomId, revision, snapshot: { ...body.payload, revision } };
    },
  });
  await resetClientState(page, true);

  await page.goto(`/join/${roomId}`, { waitUntil: 'domcontentloaded' });
  await expect(page.locator('#view-code')).toBeVisible();
  await expect(page.locator('#qTitle')).toHaveText('Focus Block Roll-up');
  await expect.poll(() => page.locator('#editor').inputValue()).toContain('rollUpFocusBlocks');
  await expect(page.locator('#editor')).not.toHaveValue(/twoSum/);
  await expect.poll(() => savedPayload, { timeout: 10_000 }).toMatchObject({
    schema_version: 2,
    language: 'javascript',
    question_id: 'focus-block-rollup',
    question_version: 1,
  });
});

test('a legacy unpinned workspace remains explicit and preserves its code', async ({ page }) => {
  const legacyCode = 'function legacyDraft() { return "preserved"; }';
  let writes = 0;
  await stopExternalEditors(page);
  await mockApi(page, {
    '/api/auth/me': { ok: true, user: signedInUser },
    '/api/profile': { ok: true, user: signedInUser },
    '/api/my-pair': pairResponse(),
    '/api/video/signal': request => {
      const url = new URL(request.url());
      if (request.method() === 'GET' && url.searchParams.get('channel') === 'workspace') {
        return {
          ok: true,
          room_id: roomId,
          revision: 1,
          snapshot: {
            schema_version: 1,
            revision: 1,
            client_id: 'legacy-client',
            client_seq: 1,
            code: legacyCode,
            language: 'javascript',
            question_id: 'focus-block-rollup',
          },
        };
      }
      writes += 1;
      return { _status: 400, ok: false, error: 'legacy workspaces must be pinned first' };
    },
  });
  await resetClientState(page, true);

  await page.goto(`/join/${roomId}`, { waitUntil: 'domcontentloaded' });
  await expect(page.locator('#view-code')).toBeVisible();
  await expect(page.locator('#questionSelect option:checked')).toContainText('Unpinned workspace exercise');
  await expect(page.locator('#qTitle')).toHaveText('Exercise unavailable');
  await expect.poll(() => page.locator('#editor').inputValue()).toBe(legacyCode);
  await expect(page.locator('#editor')).toBeVisible({ timeout: 12_000 });
  await page.locator('#editor').fill(`${legacyCode}\n// local edit`);
  await page.waitForTimeout(800);
  expect(writes).toBe(0);
  await page.locator('#questionSelect').selectOption('focus-block-rollup');
  await expect(page.locator('#editor')).toHaveValue(/function rollUpFocusBlocks/);
  await expect(page.locator('#editor')).not.toHaveValue(/legacyDraft/);
});

test('catalogue initialization does not override a delayed authoritative workspace snapshot', async ({ page }) => {
  const serverCode = 'function authoritative() { return "server wins"; }';
  let releaseCatalogue: (() => void) | null = null;
  let releaseWorkspace: (() => void) | null = null;
  let markCatalogueStarted: (() => void) | null = null;
  let markWorkspaceStarted: (() => void) | null = null;
  const catalogueStarted = new Promise<void>(resolve => { markCatalogueStarted = resolve; });
  const workspaceStarted = new Promise<void>(resolve => { markWorkspaceStarted = resolve; });
  const catalogueGate = new Promise<void>(resolve => { releaseCatalogue = resolve; });
  const workspaceGate = new Promise<void>(resolve => { releaseWorkspace = resolve; });
  let writes = 0;
  await stopExternalEditors(page);
  await mockApi(page, {
    '/api/auth/me': { ok: true, user: signedInUser },
    '/api/profile': { ok: true, user: signedInUser },
    '/api/my-pair': pairResponse(),
    '/api/questions': async () => {
      markCatalogueStarted?.();
      await catalogueGate;
      return { ok: true, questions: [originalQuestionFixture], count: 1 };
    },
    '/api/video/signal': async request => {
      const url = new URL(request.url());
      if (request.method() === 'GET' && url.searchParams.get('channel') === 'workspace') {
        markWorkspaceStarted?.();
        await workspaceGate;
        return {
          ok: true,
          room_id: roomId,
          revision: 1,
          snapshot: {
            schema_version: 2,
            revision: 1,
            client_id: 'authoritative-client',
            client_seq: 1,
            code: serverCode,
            language: 'javascript',
            question_id: 'focus-block-rollup',
            question_version: 1,
          },
        };
      }
      writes += 1;
      return { _status: 409, ok: false, error: 'unexpected write' };
    },
  });
  await resetClientState(page, true);

  try {
    await page.goto(`/join/${roomId}`, { waitUntil: 'domcontentloaded' });
    await Promise.all([catalogueStarted, workspaceStarted]);
    releaseCatalogue?.();
    await expect(page.locator('#qTitle')).toHaveText('Focus Block Roll-up');
    await expect.poll(() => page.locator('#editor').inputValue()).toContain('rollUpFocusBlocks');
    releaseWorkspace?.();

    await expect.poll(() => page.locator('#editor').inputValue()).toBe(serverCode);
    await page.waitForTimeout(800);
    expect(writes).toBe(0);
  } finally {
    releaseCatalogue?.();
    releaseWorkspace?.();
  }
});

test('Monaco does not revive a stale local draft while authoritative workspace hydration is delayed', async ({ page }) => {
  const serverCode = 'function authoritative() { return "server wins"; }';
  const stalePythonCode = 'def stale_local_draft():\n    return "must not win"';
  let releaseWorkspace: (() => void) | null = null;
  let markWorkspaceStarted: (() => void) | null = null;
  const workspaceStarted = new Promise<void>(resolve => { markWorkspaceStarted = resolve; });
  const workspaceGate = new Promise<void>(resolve => { releaseWorkspace = resolve; });
  let writes = 0;

  await installFakeMonaco(page);
  await mockApi(page, {
    '/api/auth/me': { ok: true, user: signedInUser },
    '/api/profile': { ok: true, user: signedInUser },
    '/api/my-pair': pairResponse(),
    '/api/video/signal': async request => {
      const url = new URL(request.url());
      if (request.method() === 'GET' && url.searchParams.get('channel') === 'workspace') {
        markWorkspaceStarted?.();
        await workspaceGate;
        return {
          ok: true,
          room_id: roomId,
          revision: 1,
          snapshot: {
            schema_version: 2,
            revision: 1,
            client_id: 'authoritative-client',
            client_seq: 1,
            code: serverCode,
            language: 'javascript',
            question_id: 'focus-block-rollup',
            question_version: 1,
          },
        };
      }
      writes += 1;
      return { _status: 409, ok: false, error: 'unexpected write' };
    },
  });
  await resetClientState(page, true, {
    'randori-code': JSON.stringify({
      [roomId]: {
        lang: 'javascript',
        qId: 'focus-block-rollup',
        qVersion: 1,
        codes: { python: stalePythonCode },
      },
    }),
  });

  try {
    await page.goto(`/join/${roomId}`, { waitUntil: 'domcontentloaded' });
    await workspaceStarted;
    await expect.poll(() => page.evaluate(() => (
      window as typeof window & { _randori_monaco?: { ready?: boolean } }
    )._randori_monaco?.ready)).toBe(true);

    // Stay beyond the removed legacy 700 ms Monaco restore. That restore used
    // to copy the first saved language into JavaScript and mark hydration dirty.
    await page.waitForTimeout(900);
    expect(await page.evaluate(() => (
      window as typeof window & { _randori_code?: { getCode?: () => string } }
    )._randori_code?.getCode?.())).not.toBe(stalePythonCode);

    releaseWorkspace?.();
    await expect.poll(() => page.evaluate(() => (
      window as typeof window & { _randori_code?: { getCode?: () => string } }
    )._randori_code?.getCode?.())).toBe(serverCode);
    await page.waitForTimeout(800);
    expect(writes).toBe(0);
  } finally {
    releaseWorkspace?.();
  }
});

test('an edit made during initial hydration is preserved and rebased onto the server snapshot', async ({ page }) => {
  let revision = 1;
  let snapshot = {
    schema_version: 2,
    revision,
    client_id: 'server-seed',
    client_seq: 1,
    code: 'function shared() { return "server"; }',
    language: 'javascript',
    question_id: 'focus-block-rollup',
    question_version: 1,
  };
  let releaseInitialPoll: (() => void) | null = null;
  let markInitialPollStarted: (() => void) | null = null;
  const initialPollStarted = new Promise<void>(resolve => { markInitialPollStarted = resolve; });
  const initialPollGate = new Promise<void>(resolve => { releaseInitialPoll = resolve; });
  let firstPoll = true;

  await stopExternalEditors(page);
  await mockApi(page, {
    '/api/auth/me': { ok: true, user: signedInUser },
    '/api/profile': { ok: true, user: signedInUser },
    '/api/my-pair': pairResponse(),
    '/api/video/signal': async request => {
      const url = new URL(request.url());
      if (request.method() === 'GET' && url.searchParams.get('channel') === 'workspace') {
        if (firstPoll) {
          firstPoll = false;
          markInitialPollStarted?.();
          await initialPollGate;
        }
        return { ok: true, revision, snapshot };
      }
      const body = request.postDataJSON() as { payload?: typeof snapshot & { base_revision?: number } };
      if (!body.payload || body.payload.base_revision !== revision) {
        return { _status: 409, ok: false, error: 'revision conflict', current: snapshot };
      }
      revision += 1;
      snapshot = { ...body.payload, schema_version: 2, revision };
      return { ok: true, snapshot };
    },
  });
  await resetClientState(page, true);

  try {
    await page.goto(`/join/${roomId}`, { waitUntil: 'domcontentloaded' });
    await expect(page.locator('#view-code')).toBeVisible();
    await initialPollStarted;

    const localEdit = 'function shared() { return "typed during hydration"; }';
    await page.locator('#editor').fill(localEdit);
    releaseInitialPoll?.();

    await expect.poll(() => snapshot.code, { timeout: 10_000 }).toBe(localEdit);
    await expect.poll(() => page.locator('#editor').inputValue()).toBe(localEdit);
    expect(revision).toBe(2);
  } finally {
    releaseInitialPoll?.();
  }
});

test('two authenticated browser contexts hydrate from the server and exchange ordered workspace revisions', async ({ browser }) => {
  let revision = 1;
  let snapshot = {
    schema_version: 2,
    revision,
    client_id: 'server-seed',
    client_seq: 1,
    code: 'function shared() { return "server"; }',
    language: 'javascript',
    question_id: 'focus-block-rollup',
    question_version: 1,
  };
  let forceConflict = false;
  let conflictStarted: (() => void) | null = null;
  let releaseConflict: (() => void) | null = null;

  const workspace = async (request: Request) => {
    const url = new URL(request.url());
    if (request.method() === 'GET' && url.searchParams.get('channel') === 'workspace') {
      return { ok: true, room_id: roomId, revision, snapshot };
    }
    if (request.method() === 'POST') {
      const body = request.postDataJSON() as {
        room_id?: string;
        type?: string;
        payload?: typeof snapshot & { base_revision?: number };
      };
      if (body.type !== 'code-sync' || body.room_id !== roomId || !body.payload) {
        return { _status: 400, ok: false, error: 'invalid workspace write' };
      }
      if (body.payload.base_revision !== revision) {
        return { _status: 409, ok: false, error: 'revision conflict', current: snapshot };
      }
      if (forceConflict) {
        forceConflict = false;
        conflictStarted?.();
        await new Promise<void>(resolve => { releaseConflict = resolve; });
        revision += 1;
        snapshot = {
          schema_version: 2,
          revision,
          client_id: 'remote-conflict',
          client_seq: revision,
          code: 'function shared() { return "remote conflict"; }',
          language: 'javascript',
          question_id: 'focus-block-rollup',
          question_version: 1,
        };
        return { _status: 409, ok: false, error: 'revision conflict', current: snapshot };
      }
      revision += 1;
      snapshot = { ...body.payload, schema_version: 2, revision };
      return { ok: true, room_id: roomId, revision, snapshot };
    }
    return { ok: true, signals: [], after: 0, count: 0 };
  };

  const contexts = await Promise.all([browser.newContext(), browser.newContext()]);
  const pages = await Promise.all(contexts.map(context => context.newPage()));
  try {
    for (const page of pages) {
      await stopExternalEditors(page);
      await mockApi(page, {
        '/api/auth/me': { ok: true, user: signedInUser },
        '/api/profile': { ok: true, user: signedInUser },
        '/api/my-pair': pairResponse(),
        '/api/video/signal': workspace,
      });
      await resetClientState(page, true);
      await page.goto(`/join/${roomId}`, { waitUntil: 'domcontentloaded' });
      await expect(page.locator('#view-code')).toBeVisible();
      await expect.poll(() => page.evaluate(() => (window as typeof window & { _randori_workspace?: { hydrated?: boolean } })._randori_workspace?.hydrated)).toBe(true);
      await expect.poll(() => page.evaluate(() => (window as typeof window & { _randori_code?: { getCode?: () => string } })._randori_code?.getCode?.() || document.querySelector<HTMLTextAreaElement>('#editor')?.value)).toBe(snapshot.code);
      expect(await page.evaluate(() => localStorage.getItem('randori-last-room'))).toBe(roomId);
    }

    const updatedCode = 'function shared() { return "from context A"; }';
    await setCode(pages[0], updatedCode);
    await expect.poll(() => revision).toBeGreaterThanOrEqual(2);
    await expect.poll(() => pages[1].evaluate(() => (window as typeof window & { _randori_code?: { getCode?: () => string } })._randori_code?.getCode?.() || document.querySelector<HTMLTextAreaElement>('#editor')?.value), { timeout: 10_000 }).toBe(updatedCode);

    expect(snapshot.client_id).not.toBe('server-seed');
    expect(snapshot.client_seq).toBeGreaterThan(0);

    const beforeUndoRevision = revision;
    await pages[0].evaluate(({ temporary, restored }) => {
      const editor = document.querySelector<HTMLTextAreaElement>('#editor');
      if (!editor) throw new Error('editor unavailable');
      editor.value = temporary;
      editor.dispatchEvent(new Event('input', { bubbles: true }));
      editor.value = restored;
      editor.dispatchEvent(new Event('input', { bubbles: true }));
    }, { temporary: 'function shared() { return "temporary"; }', restored: updatedCode });
    await pages[0].waitForTimeout(700);
    expect(revision).toBe(beforeUndoRevision);

    const pythonCode = 'def shared():\n    return "python room"';
    await pages[0].evaluate(code => {
      const language = document.querySelector<HTMLSelectElement>('#langSelect');
      const question = document.querySelector<HTMLSelectElement>('#questionSelect');
      const editor = document.querySelector<HTMLTextAreaElement>('#editor');
      if (!language || !question || !editor) throw new Error('workspace controls unavailable');
      language.value = 'python';
      question.value = 'focus-block-rollup';
      editor.value = code;
      editor.dispatchEvent(new Event('input', { bubbles: true }));
    }, pythonCode);
    await expect.poll(() => snapshot.code).toBe(pythonCode);
    expect(snapshot.language).toBe('python');
    expect(snapshot.question_id).toBe('focus-block-rollup');
    expect(snapshot.question_version).toBe(1);
    await expect.poll(() => pages[1].locator('#langSelect').inputValue()).toBe('python');
    await expect.poll(() => pages[1].locator('#questionSelect').inputValue()).toBe('focus-block-rollup');

    let conflictBegan = new Promise<void>(resolve => { conflictStarted = resolve; });
    forceConflict = true;
    const retryCode = 'function shared() { return "retry after conflict"; }';
    await setCode(pages[0], retryCode);
    await conflictBegan;
    releaseConflict?.();
    await expect.poll(() => snapshot.code, { timeout: 10_000 }).toBe(retryCode);

    conflictBegan = new Promise<void>(resolve => { conflictStarted = resolve; });
    forceConflict = true;
    await setCode(pages[0], 'function shared() { return "in flight"; }');
    await conflictBegan;
    const queuedCode = 'function shared() { return "queued after conflict"; }';
    await setCode(pages[0], queuedCode);
    releaseConflict?.();
    await expect.poll(() => snapshot.code, { timeout: 10_000 }).toBe(queuedCode);
    await expect.poll(() => pages[1].evaluate(() => (window as typeof window & { _randori_code?: { getCode?: () => string } })._randori_code?.getCode?.() || document.querySelector<HTMLTextAreaElement>('#editor')?.value), { timeout: 10_000 }).toBe(queuedCode);

    await pages[1].reload({ waitUntil: 'domcontentloaded' });
    await expect(pages[1].locator('#view-code')).toBeVisible();
    await expect.poll(() => pages[1].evaluate(() => (window as typeof window & { _randori_workspace?: { hydrated?: boolean } })._randori_workspace?.hydrated)).toBe(true);
    await expect.poll(() => pages[1].evaluate(() => (window as typeof window & { _randori_code?: { getCode?: () => string } })._randori_code?.getCode?.() || document.querySelector<HTMLTextAreaElement>('#editor')?.value), { timeout: 10_000 }).toBe(queuedCode);
  } finally {
    await Promise.all(contexts.map(context => context.close()));
  }
});
