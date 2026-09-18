import { expect, test } from '@playwright/test';
import {
  mockApi,
  resetClientState,
  selectLanguage,
  selectQuestion,
  setCode,
} from './helpers';

const originalQuestion = {
  slug: 'focus-block-rollup',
  version: 1,
  status: 'active',
  title: 'Focus Block Roll-up',
  type: 'array-processing',
  difficulty: 'Easy',
  tags: ['arrays', 'aggregation'],
  prompt: 'Combine adjacent focus blocks that have the same label.',
  constraints: ['The input must not be modified.', 'Labels are case-sensitive.'],
  examples: [
    {
      input: [[{ label: 'code', minutes: 25 }, { label: 'code', minutes: 10 }]],
      output: [{ label: 'code', minutes: 35 }],
      explanation: 'Adjacent code blocks are combined.',
    },
  ],
  languages: {
    javascript: {
      entrypoint: 'rollUpFocusBlocks',
      signature: 'function rollUpFocusBlocks(blocks)',
      starter: 'function rollUpFocusBlocks(blocks) {\n  return [];\n}',
    },
    python: {
      entrypoint: 'roll_up_focus_blocks',
      signature: 'def roll_up_focus_blocks(blocks):',
      starter: 'def roll_up_focus_blocks(blocks):\n    return []',
    },
  },
};

const correctSolution = `function rollUpFocusBlocks(blocks) {
  const rolledUp = [];
  for (const block of blocks) {
    const previous = rolledUp[rolledUp.length - 1];
    if (previous && previous.label === block.label) previous.minutes += block.minutes;
    else rolledUp.push({ ...block });
  }
  return rolledUp;
}`;

const signedInUser = {
  id: 7,
  email: 'runner@example.test',
  name: 'Runner Tester',
  display_name: 'Runner Tester',
  is_admin: false,
  is_available: true,
};

test('authenticated deep links survive delayed auth refreshes and follow later tab navigation', async ({ page }) => {
  await mockApi(page, {
    '/api/auth/me': { ok: true, user: signedInUser },
    '/api/questions': { ok: true, questions: [originalQuestion], count: 1 },
  });
  await resetClientState(page, true);
  await page.goto('/?view=code', { waitUntil: 'domcontentloaded' });

  await expect(page.locator('#view-code')).toBeVisible();
  await page.waitForTimeout(1_500);
  await expect(page.locator('#view-code')).toBeVisible();

  await page.locator('[data-tab="pair"]').click();
  await expect(page).toHaveURL(/(?:\?|&)view=pair(?:&|$)/);
  await page.evaluate(async () => {
    const journey = (window as typeof window & {
      _randori_journey?: { routeByAuth?: () => Promise<void> };
    })._randori_journey;
    await journey?.routeByAuth?.();
  });
  await expect(page.locator('#view-pair')).toBeVisible();

  await page.locator('#homeBtn').click();
  await expect(page).not.toHaveURL(/(?:\?|&)(?:view|tab)=/);
  await expect(page.locator('#view-dashboard')).toBeVisible();
});

test('selects an original exercise and renders authoritative server results without sending tests', async ({ page }) => {
  let executePayload: Record<string, unknown> | undefined;
  const leetCodeRequests: string[] = [];
  page.on('request', request => {
    if (/leetcode/i.test(request.url())) leetCodeRequests.push(request.url());
  });

  await mockApi(page, {
    '/api/auth/me': { ok: true, user: signedInUser },
    '/api/questions': { ok: true, questions: [originalQuestion], count: 1 },
    '/api/execute': async request => {
      executePayload = request.postDataJSON();
      return {
        ok: true,
        question_slug: originalQuestion.slug,
        question_version: originalQuestion.version,
        language: 'javascript',
        version: '20.17.0',
        passed_count: 3,
        total_count: 3,
        results: [0, 1, 2].map(idx => ({ idx, pass: true })),
        piston: { code: 0 },
      };
    },
  });
  await resetClientState(page, true);
  await page.goto('/?view=code', { waitUntil: 'domcontentloaded' });
  await page.locator('[data-tab="code"]').click();

  await expect(page.locator('#questionSelect option[value="focus-block-rollup"]')).toHaveCount(1);
  await selectQuestion(page, originalQuestion.slug);
  await expect(page.locator('#qTitle')).toHaveText(originalQuestion.title);
  await expect(page.locator('#qDesc')).toContainText(originalQuestion.prompt);
  await expect(page.locator('#qExamples')).toContainText('Adjacent code blocks are combined');
  await expect(page.locator('#qTests')).toContainText('Fresh server-generated cases');
  await expect(page.locator('#qLeetBtn')).toHaveCount(0);
  await expect(page.locator('#qUploadBtn')).toHaveCount(0);

  await selectLanguage(page, 'javascript');
  await setCode(page, correctSolution);
  await page.locator('#runBtn').click();

  await expect(page.locator('#runOut')).toContainText('Result: 3/3 passed');
  await expect(page.locator('#runOut')).toContainText('authoritative server result');
  await expect(page.locator('#runOut')).toContainText('Case 1 ✓ pass');
  await expect.poll(() => executePayload).toEqual({
    language: 'javascript',
    code: correctSolution,
    question_slug: originalQuestion.slug,
    question_version: originalQuestion.version,
  });
  expect(executePayload).not.toHaveProperty('test_cases');
  expect(leetCodeRequests).toEqual([]);
});

test('displays a failed authoritative result without calculating against public examples', async ({ page }) => {
  let executePayload: Record<string, unknown> | undefined;
  await mockApi(page, {
    '/api/auth/me': { ok: true, user: signedInUser },
    '/api/questions': { ok: true, questions: [originalQuestion], count: 1 },
    '/api/execute': async request => {
      executePayload = request.postDataJSON();
      return {
        ok: true,
        question_slug: originalQuestion.slug,
        question_version: originalQuestion.version,
        language: 'javascript',
        version: '20.17.0',
        passed_count: 0,
        total_count: 3,
        results: [0, 1, 2].map(idx => ({ idx, pass: false })),
        piston: { code: 0 },
      };
    },
  });
  await resetClientState(page, true);
  await page.goto('/?view=code', { waitUntil: 'domcontentloaded' });
  await page.locator('[data-tab="code"]').click();
  await selectQuestion(page, originalQuestion.slug);
  await setCode(page, 'function rollUpFocusBlocks() { return []; }');
  await page.locator('#runBtn').click();

  await expect(page.locator('#runOut')).toContainText('Result: 0/3 passed');
  await expect(page.locator('#runOut')).toContainText('Case 1 ✗ fail');
  expect(executePayload).toMatchObject({ question_version: originalQuestion.version });
  expect(executePayload).not.toHaveProperty('test_cases');
});

test('language changes update the active editor and preserve each language draft', async ({ page }) => {
  await mockApi(page, {
    '/api/auth/me': { ok: true, user: signedInUser },
    '/api/questions': { ok: true, questions: [originalQuestion], count: 1 },
  });
  await resetClientState(page, true);
  await page.goto('/?view=code', { waitUntil: 'domcontentloaded' });
  await page.locator('[data-tab="code"]').click();
  await expect(page.locator('#questionSelect option[value="focus-block-rollup"]')).toHaveCount(1);

  const javascriptDraft = 'function rollUpFocusBlocks(blocks) { return blocks; }';
  const pythonDraft = 'def roll_up_focus_blocks(blocks):\n    return blocks';
  await setCode(page, javascriptDraft);
  await selectLanguage(page, 'python');
  await expect.poll(() => page.evaluate(() => (
    (window as typeof window & { _randori_code?: { getCode?: () => string } })._randori_code?.getCode?.()
      || document.querySelector<HTMLTextAreaElement>('#editor')?.value
      || ''
  ))).toContain('def roll_up_focus_blocks');
  await setCode(page, pythonDraft);
  await selectLanguage(page, 'javascript');
  await expect.poll(() => page.evaluate(() => (
    (window as typeof window & { _randori_code?: { getCode?: () => string } })._randori_code?.getCode?.()
      || document.querySelector<HTMLTextAreaElement>('#editor')?.value
      || ''
  ))).toBe(javascriptDraft);
  await selectLanguage(page, 'python');
  await expect.poll(() => page.evaluate(() => (
    (window as typeof window & { _randori_code?: { getCode?: () => string } })._randori_code?.getCode?.()
      || document.querySelector<HTMLTextAreaElement>('#editor')?.value
      || ''
  ))).toBe(pythonDraft);
});

test('Monaco waits empty in the selected language until a delayed catalogue supplies the starter', async ({ page }) => {
  let releaseCatalogue: (() => void) | null = null;
  let markCatalogueStarted: (() => void) | null = null;
  const catalogueStarted = new Promise<void>(resolve => { markCatalogueStarted = resolve; });
  const catalogueGate = new Promise<void>(resolve => { releaseCatalogue = resolve; });
  await page.route(/^https:\/\//, route => route.abort());
  await page.addInitScript(() => {
    let currentValue = '';
    let contentListener: (() => void) | undefined;
    const editor = {
      getValue: () => currentValue,
      setValue: (value: string) => { currentValue = value; contentListener?.(); },
      getModel: () => ({}),
      addAction: () => undefined,
      getAction: () => ({ run: async () => undefined }),
      onDidChangeModelContent: (listener: () => void) => { contentListener = listener; },
      onDidChangeModelDecorations: () => undefined,
    };
    const app = window as typeof window & {
      require?: ((dependencies: string[], callback: () => void) => void) & { config?: () => void };
      monaco?: Record<string, unknown>;
      __monacoLanguage?: string;
    };
    const amd = ((_: string[], callback: () => void) => queueMicrotask(callback)) as typeof app.require;
    if (amd) amd.config = () => undefined;
    app.require = amd;
    app.monaco = {
      editor: {
        create: (_host: unknown, options: { language?: string }) => {
          app.__monacoLanguage = options.language;
          return editor;
        },
        setModelLanguage: (_model: unknown, language: string) => { app.__monacoLanguage = language; },
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
  await mockApi(page, {
    '/api/auth/me': { ok: true, user: signedInUser },
    '/api/questions': async () => {
      markCatalogueStarted?.();
      await catalogueGate;
      return { ok: true, questions: [originalQuestion], count: 1 };
    },
  });
  await resetClientState(page, true);

  try {
    await page.goto('/?view=code', { waitUntil: 'domcontentloaded' });
    await catalogueStarted;
    await page.locator('#langSelect').selectOption('python');
    await expect.poll(() => page.evaluate(() => (
      window as typeof window & { _randori_monaco?: { ready?: boolean } }
    )._randori_monaco?.ready)).toBe(true);
    expect(await page.evaluate(() => (
      window as typeof window & { _randori_code?: { getCode?: () => string } }
    )._randori_code?.getCode?.())).toBe('');
    expect(await page.evaluate(() => (
      window as typeof window & { __monacoLanguage?: string }
    ).__monacoLanguage)).toBe('python');

    releaseCatalogue?.();
    await expect.poll(() => page.evaluate(() => (
      window as typeof window & { _randori_code?: { getCode?: () => string } }
    )._randori_code?.getCode?.())).toContain('def roll_up_focus_blocks');
    await expect.poll(() => page.evaluate(() => (
      window as typeof window & { __monacoLanguage?: string }
    ).__monacoLanguage)).toBe('python');
  } finally {
    releaseCatalogue?.();
  }
});

test('retries transient catalogue failures a bounded number of times and supports explicit recovery', async ({ page }) => {
  let catalogueRequests = 0;
  await mockApi(page, {
    '/api/auth/me': { ok: true, user: signedInUser },
    '/api/questions': () => {
      catalogueRequests += 1;
      if(catalogueRequests <= 3) return { _status: 503, ok: false, error: 'catalogue warming up' };
      return { ok: true, questions: [originalQuestion], count: 1 };
    },
  });
  await resetClientState(page, true);
  await page.goto('/?view=code', { waitUntil: 'domcontentloaded' });
  await page.locator('[data-tab="code"]').click();

  await expect.poll(() => catalogueRequests).toBe(3);
  await page.waitForTimeout(1_200);
  expect(catalogueRequests).toBe(3);
  await expect(page.locator('#catalogRetryBtn')).toBeVisible();
  await page.locator('#catalogRetryBtn').click();

  await expect(page.locator('#questionSelect option[value="focus-block-rollup"]')).toHaveCount(1);
  await expect(page.locator('#catalogRetryBtn')).toBeHidden();
  expect(catalogueRequests).toBe(4);
});

test('authenticated run history uses server records and labels unverified legacy rows', async ({ page }) => {
  await mockApi(page, {
    '/api/auth/me': { ok: true, user: signedInUser },
    '/api/questions': { ok: true, questions: [originalQuestion], count: 1 },
    '/api/runs': request => {
      expect(request.headers().cookie).toContain('randori_session=');
      return {
        ok: true,
        count: 2,
        runs: [
          { id: 1, question_slug: 'focus-block-rollup', language: 'javascript', passed_count: 8, total_count: 8, authoritative: true, created_at: '2026-09-18T08:00:00Z' },
          { id: 2, question_slug: 'legacy-question', language: 'python', passed_count: 2, total_count: 2, authoritative: false, created_at: '2026-09-17T08:00:00Z' },
        ],
      };
    },
  });
  await resetClientState(page, true, {
    'randori-runs-local': JSON.stringify([{
      question_slug: 'forged-local-run', language: 'javascript', passed_count: 999, total_count: 999,
    }]),
  });

  await page.goto('/?view=code', { waitUntil: 'domcontentloaded' });
  const history=page.locator('#recentRunsList');
  await expect(history).toContainText('focus-block-rollup');
  await expect(history.getByText('verified',{exact:true})).toHaveCount(1);
  await expect(history.getByText('legacy / unverified',{exact:true})).toHaveCount(1);
  await expect(history).not.toContainText('forged-local-run');
});
