import { expect, Page, test } from '@playwright/test';
import { mockApi, originalQuestionFixture, resetClientState, setCode } from './helpers';

const workspaceRoom = 'week_24_pair_24';

const signedInUser = {
  id: 24,
  email: 'catalogue@example.test',
  name: 'Catalogue Tester',
  display_name: 'Catalogue Tester',
  is_admin: false,
  is_available: true,
};

function publicQuestion(
  slug: string,
  title: string,
  type: string,
  difficulty: 'Easy' | 'Medium' | 'Hard',
  tags: string[],
) {
  const entrypoint = slug.replace(/-([a-z])/g, (_match, letter: string) => letter.toUpperCase());
  const pythonEntrypoint = slug.replace(/-/g, '_');
  return {
    slug,
    version: 1,
    status: 'active',
    source: 'randori-original',
    title,
    type,
    difficulty,
    tags,
    prompt: `Solve the original ${title} exercise.`,
    constraints: ['Return a deterministic result without modifying the input.'],
    examples: [{ input: [[]], output: [] }],
    languages: {
      javascript: {
        entrypoint,
        signature: `function ${entrypoint}(items)`,
        starter: `function ${entrypoint}(items) {\n  return [];\n}`,
      },
      python: {
        entrypoint: pythonEntrypoint,
        signature: `def ${pythonEntrypoint}(items):`,
        starter: `def ${pythonEntrypoint}(items):\n    return []`,
      },
    },
  };
}

const catalogue = [
  originalQuestionFixture,
  publicQuestion(
    'balanced-template-markers',
    'Balanced Template Markers',
    'stack-string',
    'Easy',
    ['stack', 'strings'],
  ),
  publicQuestion(
    'capacity-upgrade-index',
    'Capacity Upgrade Index',
    'binary-search',
    'Easy',
    ['arrays', 'binary-search'],
  ),
  publicQuestion(
    'shortest-handoff-path',
    'Shortest Handoff Path',
    'graph-traversal',
    'Medium',
    ['graphs', 'breadth-first-search'],
  ),
  publicQuestion(
    'message-frequency-leaders',
    'Message Frequency Leaders',
    'hash-map',
    'Medium',
    ['hash-maps', 'sorting'],
  ),
  publicQuestion(
    'recovery-budget-plan',
    'Recovery Budget Plan',
    'dynamic-programming',
    'Medium',
    ['dynamic-programming', 'optimization'],
  ),
];

const privateFieldPattern = /^(?:tests?|test[_-]?cases?|hidden[_-]?cases?|oracle|generators?|reference[_-]?solutions?|solutions?)$/i;

function privateFieldPaths(value: unknown, path = 'catalogue'): string[] {
  if (Array.isArray(value)) {
    return value.flatMap((item, index) => privateFieldPaths(item, `${path}[${index}]`));
  }
  if (!value || typeof value !== 'object') return [];
  return Object.entries(value).flatMap(([key, item]) => {
    const childPath = `${path}.${key}`;
    return [
      ...(privateFieldPattern.test(key) ? [childPath] : []),
      ...privateFieldPaths(item, childPath),
    ];
  });
}

function pairResponse() {
  return {
    ok: true,
    paired: true,
    room_id: workspaceRoom,
    week_id: 24,
    week: { id: 24, week_label: '2026-W38' },
    pair: { pg_id: 24, user_a_id: signedInUser.id, user_b_id: 25, is_ai: false, topic: 'Pick together' },
    partner: { id: 25, name: 'Partner', display_name: 'Partner', color: '#9cc0b5', tz: 'UTC' },
  };
}

async function openCatalogue(page: Page, requestCounts: { questions: number }) {
  await page.route(/^https:\/\//, route => route.abort());
  await mockApi(page, {
    '/api/auth/me': { ok: true, user: signedInUser },
    '/api/questions': () => {
      requestCounts.questions += 1;
      return { ok: true, questions: catalogue, count: catalogue.length };
    },
  });
  await resetClientState(page, true);
  await page.goto('/?view=code', { waitUntil: 'domcontentloaded' });
  await expect(page.locator('#view-code')).toBeVisible();
  await expect(page.locator('#questionSelect option')).toHaveCount(catalogue.length);
  await expect.poll(() => requestCounts.questions).toBe(1);
}

async function expectVisibleSlugs(page: Page, slugs: string[]) {
  await expect.poll(() => page.evaluate(() => {
    const app = window as typeof window & {
      _randori_catalog_filters?: { state?: { visibleSlugs?: string[] } };
    };
    return app._randori_catalog_filters?.state?.visibleSlugs || [];
  })).toEqual(slugs);
  await expect(page.locator('#questionSelect option')).toHaveCount(slugs.length || 1);
}

test('discovers exercises by title, tag, difficulty, and type without refetching the catalogue', async ({ page }) => {
  const requestCounts = { questions: 0 };
  await openCatalogue(page, requestCounts);

  const search = page.getByTestId('catalog-search');
  const difficulty = page.getByTestId('catalog-difficulty');
  const type = page.getByTestId('catalog-type');
  const questionSelect = page.locator('#questionSelect');

  await expect(difficulty.locator('option')).toHaveText(['All', 'Easy', 'Medium', 'Hard']);
  await expect.poll(() => type.locator('option').evaluateAll(options => (
    options.map(option => (option as HTMLOptionElement).value)
  ))).toEqual([
    'all',
    'array-processing',
    'binary-search',
    'dynamic-programming',
    'graph-traversal',
    'hash-map',
    'stack-string',
  ]);

  await search.fill('  CAPACITY upgrade  ');
  await expectVisibleSlugs(page, ['capacity-upgrade-index']);
  await expect(questionSelect).toHaveValue('capacity-upgrade-index');
  await expect(page.locator('#qTitle')).toHaveText('Capacity Upgrade Index');
  await expect(page.locator('#qDesc')).toContainText('Solve the original Capacity Upgrade Index exercise.');

  await search.fill('');
  await expectVisibleSlugs(page, catalogue.map(question => question.slug));
  await expect(questionSelect).toHaveValue('capacity-upgrade-index');

  await search.fill('shortest BREADTH-first-search');
  await expectVisibleSlugs(page, ['shortest-handoff-path']);
  await expect(questionSelect).toHaveValue('shortest-handoff-path');
  await expect(page.locator('#qTitle')).toHaveText('Shortest Handoff Path');

  await search.fill('');
  await difficulty.selectOption('Easy');
  await expectVisibleSlugs(page, [
    'focus-block-rollup',
    'balanced-template-markers',
    'capacity-upgrade-index',
  ]);
  await expect(questionSelect).toHaveValue('focus-block-rollup');

  await difficulty.selectOption('all');
  await expectVisibleSlugs(page, catalogue.map(question => question.slug));
  await expect(questionSelect).toHaveValue('focus-block-rollup');

  await type.selectOption('binary-search');
  await expectVisibleSlugs(page, ['capacity-upgrade-index']);
  await expect(questionSelect).toHaveValue('capacity-upgrade-index');

  await type.selectOption('all');
  await expectVisibleSlugs(page, catalogue.map(question => question.slug));
  await expect(questionSelect).toHaveValue('capacity-upgrade-index');
  expect(requestCounts.questions).toBe(1);

  const browserCatalogue = await page.evaluate(() => {
    return (window as typeof window & {
      _randori_questions?: { custom?: unknown[] };
    })._randori_questions?.custom || [];
  });
  expect(browserCatalogue).toEqual(catalogue);
  expect(privateFieldPaths(browserCatalogue, 'window._randori_questions.custom')).toEqual([]);
});

test('shows a combined-filter empty state without losing the last valid selection', async ({ page }) => {
  const requestCounts = { questions: 0 };
  await openCatalogue(page, requestCounts);

  const difficulty = page.getByTestId('catalog-difficulty');
  const type = page.getByTestId('catalog-type');
  const empty = page.getByTestId('catalog-empty');
  const questionSelect = page.locator('#questionSelect');

  await type.selectOption('binary-search');
  await expectVisibleSlugs(page, ['capacity-upgrade-index']);
  await expect(questionSelect).toHaveValue('capacity-upgrade-index');
  await expect(page.locator('#qTitle')).toHaveText('Capacity Upgrade Index');

  await difficulty.selectOption('Medium');
  await expectVisibleSlugs(page, []);
  await expect(questionSelect).toBeDisabled();
  await expect(questionSelect.locator('option')).toHaveCount(1);
  await expect(questionSelect.locator('option')).toHaveText('No exercises match filters');
  await expect(empty).toBeVisible();
  await expect(empty).toContainText('No public exercises match these filters');
  await expect(page.locator('#qTitle')).toHaveText('Capacity Upgrade Index');
  await expect(page.locator('#qDesc')).toContainText('Solve the original Capacity Upgrade Index exercise.');
  await expect.poll(() => page.evaluate(() => {
    const app = window as typeof window & {
      _randori_questions?: { selectedIdentity?: () => { slug: string; version: number | null } };
    };
    return app._randori_questions?.selectedIdentity?.();
  })).toEqual({ slug: 'capacity-upgrade-index', version: 1 });

  await difficulty.selectOption('all');
  await expectVisibleSlugs(page, ['capacity-upgrade-index']);
  await expect(questionSelect).toBeEnabled();
  await expect(questionSelect).toHaveValue('capacity-upgrade-index');
  await expect(empty).toBeHidden();

  await type.selectOption('all');
  await expectVisibleSlugs(page, catalogue.map(question => question.slug));
  await expect(questionSelect).toHaveValue('capacity-upgrade-index');
  await expect(page.locator('#qTitle')).toHaveText('Capacity Upgrade Index');
  expect(requestCounts.questions).toBe(1);
});

test('keeps an off-filter hydrated workspace question versioned when editing and saving', async ({ page }) => {
  const workspaceWrites: Array<Record<string, unknown>> = [];
  const hydratedCode = 'function shortestHandoffPath() { return "hydrated"; }';
  const editedCode = 'function shortestHandoffPath() { return "edited off filter"; }';
  let revision = 1;
  let snapshot: Record<string, unknown> = {
    schema_version: 3,
    revision,
    client_id: 'server-seed',
    client_seq: 1,
    code: hydratedCode,
    language: 'javascript',
    question_id: 'shortest-handoff-path',
    question_version: 1,
    board: { shapes: [] },
  };

  await page.route(/^https:\/\//, route => route.abort());
  await mockApi(page, {
    '/api/auth/me': { ok: true, user: signedInUser },
    '/api/profile': { ok: true, user: signedInUser },
    '/api/my-pair': pairResponse(),
    '/api/questions': { ok: true, questions: catalogue, count: catalogue.length },
    '/api/video/signal': async request => {
      const url = new URL(request.url());
      if (request.method() === 'GET' && url.searchParams.get('channel') === 'workspace') {
        return { ok: true, room_id: workspaceRoom, revision, snapshot };
      }
      if (request.method() === 'POST') {
        const body = request.postDataJSON() as {
          room_id?: string;
          type?: string;
          payload?: Record<string, unknown>;
        };
        workspaceWrites.push(body);
        if (body.room_id !== workspaceRoom || body.type !== 'code-sync' || !body.payload) {
          return { _status: 400, ok: false, error: 'invalid workspace write' };
        }
        const { base_revision: _baseRevision, ...next } = body.payload;
        revision += 1;
        snapshot = { ...next, schema_version: 3, revision };
        return { ok: true, room_id: workspaceRoom, revision, snapshot };
      }
      return { ok: true, signals: [], after: 0, count: 0 };
    },
  });
  await resetClientState(page, true);

  await page.goto('/?view=code', { waitUntil: 'domcontentloaded' });
  await expect(page.locator('#view-code')).toBeVisible();
  await expect(page.locator('#questionSelect option')).toHaveCount(catalogue.length);
  await expect.poll(() => page.evaluate(() => Boolean(
    (window as typeof window & { _randori_auth?: { me?: unknown } })._randori_auth?.me,
  ))).toBe(true);

  await page.getByTestId('catalog-type').selectOption('binary-search');
  await expectVisibleSlugs(page, ['capacity-upgrade-index']);
  await expect(page.locator('#questionSelect')).toHaveValue('capacity-upgrade-index');

  await page.evaluate(async room => {
    const workspace = (window as typeof window & {
      _randori_workspace?: { requestAccess?: (roomId: string) => Promise<boolean> };
    })._randori_workspace;
    if (!workspace?.requestAccess || !await workspace.requestAccess(room)) {
      throw new Error('workspace access failed');
    }
  }, workspaceRoom);
  await expect.poll(() => page.evaluate(() => (
    (window as typeof window & { _randori_workspace?: { hydrated?: boolean } })
      ._randori_workspace?.hydrated
  ))).toBe(true);

  const filteredCurrent = page.getByTestId('catalog-filtered-current');
  await expect(filteredCurrent).toHaveAttribute('value', 'shortest-handoff-path');
  await expect(filteredCurrent).toHaveAttribute('data-question-version', '1');
  await expect(filteredCurrent).toHaveAttribute('data-workspace-filtered', '1');
  await expect(filteredCurrent).toHaveText('Shortest Handoff Path · v1 · current workspace (filtered)');
  await expect(page.locator('#questionSelect option')).toHaveCount(2);
  await expect(page.locator('#questionSelect')).toBeEnabled();
  await expect(page.locator('#questionSelect')).toHaveValue('shortest-handoff-path');
  await expect(page.locator('#qTitle')).toHaveText('Shortest Handoff Path');
  await expect.poll(() => page.evaluate(() => {
    const app = window as typeof window & {
      _randori_questions?: { selectedIdentity?: () => { slug: string; version: number | null } };
    };
    return app._randori_questions?.selectedIdentity?.();
  })).toEqual({ slug: 'shortest-handoff-path', version: 1 });
  await expect.poll(() => page.evaluate(() => (
    (window as typeof window & { _randori_code?: { getCode?: () => string } })
      ._randori_code?.getCode?.() || document.querySelector<HTMLTextAreaElement>('#editor')?.value || ''
  ))).toBe(hydratedCode);

  const expectWorkspacePreserved = async (visibleSlugs: string[]) => {
    await expect.poll(() => page.evaluate(() => {
      const app = window as typeof window & {
        _randori_catalog_filters?: { state?: { visibleSlugs?: string[] } };
      };
      return app._randori_catalog_filters?.state?.visibleSlugs || [];
    })).toEqual(visibleSlugs);
    await expect(page.getByTestId('catalog-filtered-current')).toHaveCount(1);
    await expect(page.locator('#questionSelect option')).toHaveCount(visibleSlugs.length + 1);
    await expect(page.locator('#questionSelect')).toHaveValue('shortest-handoff-path');
    await expect(page.locator('#qTitle')).toHaveText('Shortest Handoff Path');
    await expect.poll(() => page.evaluate(() => {
      const app = window as typeof window & {
        _randori_questions?: { selectedIdentity?: () => { slug: string; version: number | null } };
      };
      return app._randori_questions?.selectedIdentity?.();
    })).toEqual({ slug: 'shortest-handoff-path', version: 1 });
    await expect.poll(() => page.evaluate(() => (
      (window as typeof window & { _randori_code?: { getCode?: () => string } })
        ._randori_code?.getCode?.() || document.querySelector<HTMLTextAreaElement>('#editor')?.value || ''
    ))).toBe(hydratedCode);
  };

  const search = page.getByTestId('catalog-search');
  const difficulty = page.getByTestId('catalog-difficulty');
  const type = page.getByTestId('catalog-type');
  await search.fill('capacity');
  await expectWorkspacePreserved(['capacity-upgrade-index']);
  await search.fill('');
  await expectWorkspacePreserved(['capacity-upgrade-index']);
  await difficulty.selectOption('Easy');
  await expectWorkspacePreserved(['capacity-upgrade-index']);
  await difficulty.selectOption('all');
  await expectWorkspacePreserved(['capacity-upgrade-index']);
  await type.selectOption('stack-string');
  await expectWorkspacePreserved(['balanced-template-markers']);
  await type.selectOption('binary-search');
  await expectWorkspacePreserved(['capacity-upgrade-index']);
  const filterFlush = await page.evaluate(async () => {
    return (window as typeof window & {
      _randori_workspace?: { flush?: () => Promise<boolean> };
    })._randori_workspace?.flush?.();
  });
  expect(filterFlush).toBe(true);
  expect(workspaceWrites).toHaveLength(0);

  await setCode(page, editedCode);
  await expect.poll(() => workspaceWrites.length, { timeout: 10_000 }).toBe(1);
  const write = workspaceWrites[0] as {
    room_id: string;
    type: string;
    payload: Record<string, unknown>;
  };
  expect(Object.keys(write).sort()).toEqual(['payload', 'room_id', 'type']);
  expect(write.room_id).toBe(workspaceRoom);
  expect(write.type).toBe('code-sync');
  expect(Object.keys(write.payload).sort()).toEqual([
    'base_revision',
    'board',
    'client_id',
    'client_seq',
    'code',
    'language',
    'question_id',
    'question_version',
    'schema_version',
  ]);
  expect(workspaceWrites.every(item => {
    const payload = item.payload as Record<string, unknown> | undefined;
    return payload?.question_id === 'shortest-handoff-path' && payload.question_version === 1;
  })).toBe(true);
  expect(write.payload).toMatchObject({
    schema_version: 3,
    base_revision: 1,
    code: editedCode,
    language: 'javascript',
    question_id: 'shortest-handoff-path',
    question_version: 1,
    board: { shapes: [] },
  });

  await expect.poll(() => page.evaluate(() => (
    (window as typeof window & { _randori_code?: { getCode?: () => string } })
      ._randori_code?.getCode?.() || document.querySelector<HTMLTextAreaElement>('#editor')?.value || ''
  ))).toBe(editedCode);
  await expect.poll(() => page.evaluate(room => {
    const saved = JSON.parse(localStorage.getItem('randori-code') || '{}');
    const entry = saved[room];
    return {
      qId: entry?.qId,
      qVersion: entry?.qVersion,
      code: entry?.codes?.javascript,
    };
  }, workspaceRoom)).toEqual({
    qId: 'shortest-handoff-path',
    qVersion: 1,
    code: editedCode,
  });

  await page.evaluate(() => {
    (window as typeof window & {
      _randori_workspace?: { deactivate?: () => void };
    })._randori_workspace?.deactivate?.();
  });
  await page.locator('#questionSelect').selectOption('capacity-upgrade-index');
  await expect(page.getByTestId('catalog-filtered-current')).toHaveCount(0);
  await expect(page.locator('#questionSelect option')).toHaveCount(1);
  await expect(page.locator('#questionSelect')).toHaveValue('capacity-upgrade-index');
  await expect(page.locator('#qTitle')).toHaveText('Capacity Upgrade Index');
  await expect.poll(() => page.evaluate(() => (
    (window as typeof window & {
      _randori_questions?: { selectedIdentity?: () => { slug: string; version: number | null } };
    })._randori_questions?.selectedIdentity?.()
  ))).toEqual({ slug: 'capacity-upgrade-index', version: 1 });

  await page.evaluate(() => {
    const questions = (window as typeof window & {
      _randori_questions?: { selectWorkspaceQuestion?: (slug: string, version: number) => boolean };
    })._randori_questions;
    questions?.selectWorkspaceQuestion?.('shortest-handoff-path', 1);
    questions?.selectWorkspaceQuestion?.('message-frequency-leaders', 1);
  });
  await expect(page.getByTestId('catalog-filtered-current')).toHaveCount(1);
  await expect(page.getByTestId('catalog-filtered-current')).toHaveAttribute('value', 'message-frequency-leaders');
  await expect(page.locator('#questionSelect option')).toHaveCount(2);
  await expect(page.locator('#questionSelect')).toHaveValue('message-frequency-leaders');
  await expect.poll(() => page.evaluate(() => (
    (window as typeof window & {
      _randori_questions?: { selectedIdentity?: () => { slug: string; version: number | null } };
    })._randori_questions?.selectedIdentity?.()
  ))).toEqual({ slug: 'message-frequency-leaders', version: 1 });
});
