import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page, type TestInfo } from '@playwright/test';
import {
  focusBlockRollupCorrect,
  mockApi,
  openRoomPanel,
  originalQuestionFixture,
  resetClientState,
  setCode,
} from './helpers';

// Golden paths for the WP-R pair room: editor first, one panel at a time on
// phones, editor plus a tabbed side panel on wide screens, results brought
// forward on Run, opt-in AI feedback, and Board as a room mode.

const member = {
  id: 1,
  email: 'room@example.test',
  name: 'Room Member',
  display_name: 'Room Member',
  is_admin: false,
  is_available: true,
};

async function openRoom(page: Page) {
  await page.route(/(cdnjs\.cloudflare\.com|cdn\.jsdelivr\.net|unpkg\.com)/, route => route.abort());
  await mockApi(page, {
    '/api/auth/me': { ok: true, user: member },
    '/api/profile': { ok: true, user: member },
    '/api/questions': { ok: true, questions: [originalQuestionFixture], count: 1 },
    '/api/execute': {
      ok: true,
      passed_count: 3,
      total_count: 3,
      results: [0, 1, 2].map(idx => ({ idx, pass: true })),
      execution: { provider: 'vercel-sandbox', code: 0, signal: null, timed_out: false, has_stderr: false },
    },
  });
  // Keep storage across the reload in the AI opt-in test.
  await resetClientState(page, true, {}, true);
  await page.goto('/?view=code', { waitUntil: 'domcontentloaded' });
  await page.locator('[data-tab="code"]').click();
  await expect(page.locator('#view-code')).toBeVisible();
  await expect(page.locator('#questionSelect option[value="focus-block-rollup"]')).toHaveCount(1);
}

async function expectWcagClean(page: Page, testInfo: TestInfo, name: string) {
  const results = await new AxeBuilder({ page })
    .include('#view-code')
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
    .analyze();
  await testInfo.attach(`${name}-axe-incomplete`, {
    body: Buffer.from(JSON.stringify(results.incomplete, null, 2)),
    contentType: 'application/json',
  });
  expect(results.violations, `${name} WCAG violations`).toEqual([]);
}

async function documentHeight(page: Page) {
  return page.evaluate(() => ({
    scrollHeight: document.documentElement.scrollHeight,
    innerHeight: window.innerHeight,
    scrollWidth: document.documentElement.scrollWidth,
    innerWidth: window.innerWidth,
  }));
}

test.describe('wide screens', () => {
  test.use({ viewport: { width: 1280, height: 800 } });

  test('the editor sits beside a tabbed side panel and Run brings results forward', async ({ page }, testInfo) => {
    await openRoom(page);
    const view = page.locator('#view-code');
    await expect(page.locator('#roomPanel-code')).toBeVisible();
    await expect(page.locator('#roomPanel-problem')).toBeVisible();
    await expect(page.locator('[data-room-tab="code"]')).toBeHidden();
    await expect(page.locator('[data-room-tab="problem"]')).toHaveAttribute('aria-selected', 'true');
    await expect(page.locator('#qTitle')).toHaveText('Focus Block Roll-up');

    // A focused room: one Join action, the call strip collapsed until joined,
    // and no second AI panel.
    await expect(view.getByRole('button', { name: /join/i })).toHaveCount(1);
    await expect(page.locator('#vidJoinBtn')).toBeVisible();
    await expect(page.locator('#videoBar')).toBeHidden();
    await expect(page.locator('#aiFeedbackCardBelowBoard')).toHaveCount(0);

    const editor = await page.locator('#roomPanel-code').boundingBox();
    const side = await page.locator('#roomSide').boundingBox();
    expect(editor!.x + editor!.width).toBeLessThanOrEqual(side!.x);
    expect(editor!.height).toBeGreaterThan(400);
    const size = await documentHeight(page);
    expect(size.scrollHeight).toBeLessThanOrEqual(size.innerHeight + 2);

    // Arrow keys move between side-panel tabs.
    await page.locator('[data-room-tab="problem"]').focus();
    await page.keyboard.press('ArrowRight');
    await expect(page.locator('[data-room-tab="results"]')).toBeFocused();
    await expect(page.locator('#roomPanel-results')).toBeVisible();
    await expect(page.locator('#roomPanel-problem')).toBeHidden();
    await page.keyboard.press('End');
    await expect(page.locator('[data-room-tab="notes"]')).toHaveAttribute('aria-selected', 'true');
    await page.keyboard.press('Home');
    await expect(page.locator('[data-room-tab="problem"]')).toHaveAttribute('aria-selected', 'true');
    await expectWcagClean(page, testInfo, 'room-wide-problem');

    await setCode(page, focusBlockRollupCorrect);
    await page.locator('#runBtn').click();
    await expect(page.locator('[data-room-tab="results"]')).toHaveAttribute('aria-selected', 'true');
    await expect(page.locator('#runOut')).toBeVisible();
    await expect(page.locator('#runOut')).toContainText('Result: 3/3 passed');
    await expect(page.locator('#runOut .run-case')).toHaveCount(3);
    await expect(page.locator('#runOut')).toContainText('Case 1 ✓ pass');
    await expectWcagClean(page, testInfo, 'room-wide-results');
  });

  test('notes come first and AI feedback stays off until the member opts in', async ({ page }, testInfo) => {
    await openRoom(page);
    await openRoomPanel(page, 'notes');
    const transcript = page.locator('#aiTranscript');
    await expect(transcript).toBeVisible();
    const placeholder = await transcript.getAttribute('placeholder');
    expect(placeholder).toContain('\n');
    expect(placeholder).not.toContain('\\n');
    expect(await page.locator('#aiInterviewerQs').getAttribute('placeholder')).not.toContain('\\n');

    const toggle = page.getByRole('switch', { name: /AI feedback/ });
    await expect(toggle).not.toBeChecked();
    await expect(page.locator('#aiAnalyzeBtn')).toBeHidden();
    await expect(page.locator('#aiFeedbackHint')).toContainText('Off.');
    await expectWcagClean(page, testInfo, 'room-wide-notes-off');

    await toggle.check();
    await expect(page.locator('#aiAnalyzeBtn')).toBeVisible();
    await expect(page.locator('#aiAnalyzeBtn')).toBeEnabled();
    await expect(page.locator('#aiRecordBtn')).toHaveAttribute('aria-pressed', 'false');
    await page.locator('#aiRecordBtn').click();
    await expect(page.locator('#aiRecordBtn')).toHaveAttribute('aria-pressed', 'true');
    await expect(page.locator('#aiStatus')).toContainText('Recording');
    await page.locator('#aiRecordBtn').click();
    await expect(page.locator('#aiRecordBtn')).toHaveAttribute('aria-pressed', 'false');

    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.locator('[data-tab="code"]').click();
    await openRoomPanel(page, 'notes');
    await expect(page.getByRole('switch', { name: /AI feedback/ })).toBeChecked();
  });

  test('the editor more-menu holds the secondary actions and works with the plain editor', async ({ page }) => {
    await openRoom(page);
    // The CDNs are blocked, so this is the plain editor: Format needs Monaco
    // and is disabled with a reason; Copy starter and Reset still work.
    await expect(page.locator('#monacoFallbackNote')).toBeVisible({ timeout: 12_000 });
    const trigger = page.locator('#editorMoreBtn');
    await expect(page.locator('#formatBtn')).toBeHidden();
    await trigger.click();
    await expect(trigger).toHaveAttribute('aria-expanded', 'true');
    await expect(page.getByRole('menuitem', { name: 'Format code' })).toBeDisabled();
    await expect(page.locator('#formatBtn')).toHaveAttribute('title', 'Formatting needs the full editor');
    await expect(page.getByRole('menuitem', { name: 'Copy starter' })).toBeFocused();
    await page.keyboard.press('ArrowDown');
    await expect(page.getByRole('menuitem', { name: 'Reset to starter' })).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(page.locator('#editorMoreMenu')).toBeHidden();
    await expect(trigger).toBeFocused();
  });
});

test.describe('phones', () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

  test('the editor fills the room and panels switch with segmented tabs', async ({ page }, testInfo) => {
    await openRoom(page);
    await expect(page.locator('[data-room-tab="code"]')).toHaveAttribute('aria-selected', 'true');
    await expect(page.locator('#roomPanel-code')).toBeVisible();
    await expect(page.locator('#roomSide')).toBeHidden();
    const editor = await page.locator('#roomPanel-code').boundingBox();
    expect(editor!.height).toBeGreaterThan(380);
    let size = await documentHeight(page);
    expect(size.scrollWidth).toBeLessThanOrEqual(size.innerWidth);
    // The room fits the screen instead of a ~4,000 px scroll.
    expect(size.scrollHeight).toBeLessThanOrEqual(size.innerHeight + 2);
    for (const id of ['code', 'problem', 'results', 'session', 'notes']) {
      const box = await page.locator(`[data-room-tab="${id}"]`).boundingBox();
      expect(box!.height, `${id} tab is a 44 px target`).toBeGreaterThanOrEqual(44);
    }
    await expectWcagClean(page, testInfo, 'room-phone-code');

    await page.locator('[data-room-tab="problem"]').click();
    await expect(page.locator('#qTitle')).toBeVisible();
    await expect(page.locator('#roomPanel-code')).toBeHidden();
    size = await documentHeight(page);
    expect(size.scrollHeight).toBeLessThanOrEqual(size.innerHeight + 2);

    await page.locator('[data-room-tab="code"]').click();
    await setCode(page, focusBlockRollupCorrect);
    await page.locator('#runBtn').click();
    await expect(page.locator('[data-room-tab="results"]')).toHaveAttribute('aria-selected', 'true');
    await expect(page.locator('#runOut')).toContainText('Result: 3/3 passed');
    await expect(page.locator('#roomPanel-code')).toBeHidden();

    await page.locator('[data-room-tab="session"]').click();
    await expect(page.locator('#roomPanel-session')).toContainText('appear here once your pair room is ready');
  });

  test('the whiteboard is a room mode with icon tools', async ({ page }) => {
    await openRoom(page);
    await page.locator('#view-code [data-room-mode="board"]').click();
    await expect(page.locator('#view-board')).toBeVisible();
    await expect(page.locator('#tab-board')).toHaveAttribute('aria-current', 'page');
    await expect(page.locator('#board')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Draw a rectangle' })).toBeVisible();
    const canvas = await page.locator('#board').boundingBox();
    expect(canvas!.height).toBeGreaterThan(250);
    const size = await documentHeight(page);
    expect(size.scrollWidth).toBeLessThanOrEqual(size.innerWidth);
    await page.locator('#view-board [data-room-mode="code"]').click();
    await expect(page.locator('#view-code')).toBeVisible();
    await expect(page.locator('#tab-code')).toHaveAttribute('aria-current', 'page');
  });
});
