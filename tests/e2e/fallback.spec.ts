import { expect, test } from '@playwright/test';
import { focusBlockRollupCorrect, mockApi, resetClientState } from './helpers';

test('the plain editor remains usable when Monaco and formatter CDNs are unavailable', async ({ page }) => {
  let executePayload: Record<string, unknown> | undefined;
  await page.route(/(cdnjs\.cloudflare\.com|cdn\.jsdelivr\.net|unpkg\.com)/, route => route.abort());
  await mockApi(page, {
    '/api/auth/me': {
      ok: true,
      user: { id: 1, email: 'e2e@example.test', display_name: 'E2E Tester', is_admin: false },
    },
    '/api/execute': request => {
      executePayload = request.postDataJSON();
      return {
        ok: true,
        passed_count: 3,
        total_count: 3,
        results: [0, 1, 2].map(idx => ({ idx, pass: true })),
        piston: { code: 0, stdout: '', stderr: '' },
      };
    },
  });
  await resetClientState(page, true);
  await page.goto('/?view=code', { waitUntil: 'domcontentloaded' });
  await page.locator('[data-tab="code"]').click();

  await expect(page.locator('#monacoFallbackNote')).toBeVisible({ timeout: 12_000 });
  await expect(page.locator('#editor')).toBeVisible();
  await expect(page.locator('#useServerRunner')).toBeChecked();
  await expect(page.locator('#useServerRunner')).toBeDisabled();
  await page.locator('#editor').fill(focusBlockRollupCorrect);
  await page.locator('#langSelect').selectOption('python');
  await expect(page.locator('#editor')).toHaveValue(/def roll_up_focus_blocks/);
  const pythonDraft = 'def roll_up_focus_blocks(blocks):\n    return blocks';
  await page.locator('#editor').fill(pythonDraft);
  await page.locator('#langSelect').selectOption('javascript');
  await expect(page.locator('#editor')).toHaveValue(focusBlockRollupCorrect);
  await page.locator('#langSelect').selectOption('python');
  await expect(page.locator('#editor')).toHaveValue(pythonDraft);
  await page.locator('#langSelect').selectOption('javascript');
  await page.locator('#runBtn').click();
  await expect(page.locator('#runOut')).toContainText('Result: 3/3 passed');
  await expect.poll(() => executePayload).toEqual({
    code: focusBlockRollupCorrect,
    language: 'javascript',
    question_slug: 'focus-block-rollup',
    question_version: 1,
  });
});
