import { expect, test } from '@playwright/test';
import { mockApi, openRoomPanel, resetClientState, selectLanguage, selectQuestion, setCode } from './helpers';

const question = {
  slug: 'focus-block-rollup', version: 1, status: 'active', title: 'Focus Block Roll-up', type: 'array-processing',
  difficulty: 'Easy', tags: ['arrays'], prompt: 'Combine adjacent blocks with the same label.',
  constraints: ['Do not modify the input.'], examples: [{ input: [[]], output: [], explanation: 'Empty stays empty.' }],
  languages: {
    javascript: { entrypoint: 'rollUpFocusBlocks', signature: 'function rollUpFocusBlocks(blocks)', starter: 'function rollUpFocusBlocks(blocks) { return []; }' },
    python: { entrypoint: 'roll_up_focus_blocks', signature: 'def roll_up_focus_blocks(blocks):', starter: 'def roll_up_focus_blocks(blocks):\n    return []' },
    typescript: { entrypoint: 'rollUpFocusBlocks', signature: 'function rollUpFocusBlocks(blocks: any): any', starter: 'function rollUpFocusBlocks(blocks: any): any { return null; }' },
  },
};
const user = { id: 7, email: 'runner@example.test', name: 'Runner Tester', display_name: 'Runner Tester', is_admin: false, is_available: true };
const solution = `type Block = {label: string; minutes: number};
function rollUpFocusBlocks(blocks: Block[]): Block[] {
  const out: Block[] = [];
  for (const block of blocks) {
    const last=out.at(-1);
    if(last && last.label===block.label) last.minutes+=block.minutes;
    else out.push({...block});
  }
  return out;
}`;

test.beforeEach(async ({ page }) => { await page.route(/^https:\/\//, route => route.abort()); });

test('TypeScript goes from enabled server starter through editor to verified summary without hidden data', async ({ page }) => {
  let submitted: Record<string, unknown> | undefined;
  await mockApi(page, {
    '/api/auth/me': { ok: true, user },
    '/api/questions': { ok: true, questions: [question], count: 1 },
    '/api/execute': async request => {
      submitted = request.postDataJSON();
      return { ok: true, question_slug: question.slug, question_version: 1, language: 'typescript',
        version: '24', runtime_version: '24', run_id: 701, passed_count: 8, total_count: 8,
        results: Array.from({ length: 8 }, (_, idx) => ({ idx, pass: true, error: null })),
        execution: { provider: 'vercel-sandbox', code: 0, signal: null, timed_out: false, has_stderr: false } };
    },
    '/api/runs': { ok: true, count: 1, runs: [{ id: 701, question_slug: question.slug, language: 'typescript',
      passed_count: 8, total_count: 8, authoritative: true, created_at: '2026-11-18T12:00:00Z' }] },
  });
  await resetClientState(page, true);
  await page.goto('/?view=code', { waitUntil: 'domcontentloaded' });
  await expect(page.locator('#langSelect option[value="typescript"]')).toHaveCount(1);
  await expect(page.locator('#langSelect option[value="go"]')).toHaveCount(0);
  await selectQuestion(page, question.slug);
  await selectLanguage(page, 'typescript');
  await expect.poll(() => page.evaluate(() => (window as any)._randori_code?.getCode?.() || (document.getElementById('editor') as HTMLTextAreaElement).value)).toContain('blocks: any');
  await setCode(page, solution);
  await selectLanguage(page, 'javascript');
  await selectLanguage(page, 'typescript');
  await expect.poll(() => page.evaluate(() => (window as any)._randori_code?.getCode?.() || (document.getElementById('editor') as HTMLTextAreaElement).value)).toBe(solution);
  await page.locator('#runBtn').click();
  await expect(page.locator('#runOut')).toContainText('Result: 8/8 passed');
  await expect(page.locator('#runOut')).toContainText('Checked on the server');
  expect(submitted).toEqual({ language: 'typescript', code: solution, question_slug: question.slug, question_version: 1 });
  expect(submitted).not.toHaveProperty('test_cases'); expect(submitted).not.toHaveProperty('stdin');
  await expect(page.locator('#recentRunsList')).toContainText('TypeScript');
  await expect(page.locator('#recentRunsList')).toContainText('verified');
});

test('Go is advertised only by server support and explicitly hides private stdin', async ({ page }) => {
  const go = { entrypoint: 'rollUpFocusBlocks', signature: 'func rollUpFocusBlocks(blocks interface{}) interface{}',
    starter: 'package main\nfunc rollUpFocusBlocks(blocks interface{}) interface{} { return nil }' };
  await mockApi(page, {
    '/api/auth/me': { ok: true, user },
    '/api/auth/capabilities': { ok: true, registrationMode: 'private_beta', capabilities: { passwordLogin: true, passwordSignup: false, googleOAuth: true, executionStdin: true } },
    '/api/questions': { ok: true, questions: [{ ...question, languages: { ...question.languages, go } }], count: 1 },
  });
  await resetClientState(page, true);
  await page.goto('/?view=code', { waitUntil: 'domcontentloaded' });
  await expect(page.locator('#langSelect option[value="go"]')).toHaveCount(1);
  await selectQuestion(page, question.slug); await selectLanguage(page, 'typescript');
  await openRoomPanel(page, 'results'); await expect(page.locator('#customStdinPanel')).toBeVisible();
  await page.locator('#customStdinEnabled').check(); await page.locator('#customStdin').fill('PRIVATE_GO_SWITCH');
  await selectLanguage(page, 'go'); await expect(page.locator('#customStdinPanel')).toBeHidden();
  await selectLanguage(page, 'typescript'); await expect(page.locator('#customStdin')).toHaveValue('');
});

test('a TypeScript workspace selection hydrated before a delayed catalogue is restored without overwriting its draft', async ({ page }) => {
  let release!: () => void, started!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const requested = new Promise<void>(resolve => { started = resolve; });
  await mockApi(page, { '/api/auth/me': { ok: true, user }, '/api/questions': async () => {
    started(); await gate; return { ok: true, questions: [question], count: 1 };
  } });
  await resetClientState(page, true);
  try {
    await page.goto('/?view=code', { waitUntil: 'domcontentloaded' }); await requested;
    await page.evaluate(({ slug, code }) => (window as any)._randori_questions.loadRoomState({
      questionId: slug, questionVersion: 1, language: 'typescript', code, hasStoredCode: true,
    }), { slug: question.slug, code: solution });
    release();
    await expect(page.locator('#langSelect')).toHaveValue('typescript');
    await expect.poll(() => page.evaluate(() => (window as any)._randori_code?.getCode?.() || (document.getElementById('editor') as HTMLTextAreaElement).value)).toBe(solution);
  } finally { release(); }
});

test('Go compile failure is visible only as a fixed requester note, not provider output', async ({ page }) => {
  const go = { entrypoint: 'rollUpFocusBlocks', signature: 'func rollUpFocusBlocks(blocks interface{}) interface{}',
    starter: 'package main\nfunc rollUpFocusBlocks(blocks interface{}) interface{} { return nil }' };
  await mockApi(page, {
    '/api/auth/me': { ok: true, user },
    '/api/questions': { ok: true, questions: [{ ...question, languages: { ...question.languages, go } }], count: 1 },
    '/api/execute': { ok: true, language: 'go', passed_count: 0, total_count: 8,
      results: Array.from({ length: 8 }, (_, idx) => ({ idx, pass: false, error: 'no result' })),
      execution: { compile_failed: true, has_stderr: true, stderr: 'PRIVATE_COMPILER_BYTES' } },
  });
  await resetClientState(page, true); await page.goto('/?view=code', { waitUntil: 'domcontentloaded' });
  await expect(page.locator('#langSelect option[value="go"]')).toHaveCount(1);
  await selectQuestion(page, question.slug); await selectLanguage(page, 'go'); await setCode(page, go.starter);
  await page.locator('#runBtn').click();
  await expect(page.locator('#runOut')).toContainText('Go compilation failed.');
  await expect(page.locator('#runOut')).not.toContainText('PRIVATE_COMPILER_BYTES');
});

test('default-off catalogue never loads the language adapter or offers new languages', async ({ page }) => {
  const { typescript: omitted, ...baseLanguages } = question.languages;
  const requested: string[] = [];
  page.on('request', request => { if (request.url().includes('/assets/execution-languages.js')) requested.push(request.url()); });
  await mockApi(page, { '/api/auth/me': { ok: true, user }, '/api/questions': { ok: true, questions: [{ ...question, languages: baseLanguages }] } });
  await resetClientState(page, true); await page.goto('/?view=code', { waitUntil: 'domcontentloaded' });
  await expect(page.locator('#questionSelect option[value="focus-block-rollup"]')).toHaveCount(1);
  await expect(page.locator('#langSelect option')).toHaveCount(2);
  expect(requested).toEqual([]);
});
