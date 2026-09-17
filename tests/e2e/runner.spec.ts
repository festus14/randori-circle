import { expect, test } from '@playwright/test';
import {
  mockApi,
  openCodeView,
  resetClientState,
  selectLanguage,
  selectQuestion,
  setCode,
  twoSumBroken,
  twoSumCorrect,
} from './helpers';

test('the server JavaScript runner reports exact results for correct and broken code', async ({ page }) => {
  const payloads: Record<string, unknown>[] = [];
  await openCodeView(page, {
    '/api/execute': async request => {
      const payload = request.postDataJSON();
      payloads.push(payload);
      const passed = String(payload.code).includes('return [];') ? 0 : 3;
      return {
        ok: true,
        passed_count: passed,
        total_count: 3,
        results: [0, 1, 2].map(idx => ({ idx, pass: idx < passed })),
        piston: { code: 0, stdout: '', stderr: '' },
      };
    },
  });
  await selectLanguage(page, 'javascript');
  await selectQuestion(page, 'two-sum');
  await expect(page.locator('#useServerRunner')).toBeChecked();
  await expect(page.locator('#useServerRunner')).toBeDisabled();

  await setCode(page, twoSumCorrect);
  await page.locator('#runBtn').click();
  await expect(page.locator('#runOut')).toContainText('Result: 3/3 passed');

  await setCode(page, twoSumBroken);
  await page.locator('#runBtn').click();
  await expect(page.locator('#runOut')).toContainText('Result: 0/3 passed');
  await expect(page.locator('#runOut')).not.toContainText('Result: 3/3 passed');
  expect(payloads.map(payload => payload.code)).toEqual([twoSumCorrect, twoSumBroken]);
  expect(payloads.map(payload => payload.question_slug)).toEqual(['two-sum', 'two-sum']);
  expect(payloads.every(payload => Array.isArray(payload.test_cases))).toBe(true);
});

test('the server runner sends the selected code and renders the returned pass count', async ({ page }) => {
  const question = {
    id: 99,
    slug: 'two-sum-contract',
    title: 'Two Sum Contract',
    type: 'dsa',
    difficulty: 'Easy',
    category: 'array',
    description: 'Return the two matching indexes.',
    examples: [],
    constraints_text: '',
    test_cases: [
      { input: { nums: [2, 7, 11, 15], target: 9 }, expect: [0, 1] },
      { input: { nums: [3, 2, 4], target: 6 }, expect: [1, 2] },
      { input: { nums: [3, 3], target: 6 }, expect: [0, 1] },
    ],
    starter_per_lang: { javascript: 'function twoSum() {}' },
    is_custom: true,
  };
  let executePayload: Record<string, unknown> | undefined;
  await mockApi(page, {
    '/api/questions': { ok: true, questions: [question], count: 1 },
    '/api/execute': async request => {
      executePayload = request.postDataJSON();
      return {
        ok: true,
        language: 'javascript',
        version: 'test',
        passed_count: 3,
        total_count: 3,
        results: question.test_cases.map((entry, idx) => ({ idx, pass: true, got: entry.expect, expect: entry.expect })),
        piston: { code: 0, stdout: '', stderr: '' },
      };
    },
  });
  await resetClientState(page);
  await page.goto('/?view=code', { waitUntil: 'domcontentloaded' });
  await page.locator('[data-tab="code"]').click();
  await expect(page.locator('#questionSelect option[value="two-sum-contract"]')).toHaveCount(1);
  await selectQuestion(page, 'two-sum-contract');
  await selectLanguage(page, 'javascript');
  await setCode(page, twoSumCorrect);
  await expect(page.locator('#useServerRunner')).toBeChecked();
  await expect(page.locator('#useServerRunner')).toBeDisabled();
  await page.locator('#runBtn').click();

  await expect(page.locator('#runOut')).toContainText('Result: 3/3 passed');
  await expect.poll(() => executePayload).toMatchObject({
    language: 'javascript',
    question_slug: 'two-sum-contract',
    code: twoSumCorrect,
  });
});
