import { expect, test } from '@playwright/test';
import { listPublicExercises } from '../../api/_catalog.js';
import { mockApi, openRoomPanel, resetClientState, setCode } from './helpers';

const questions = listPublicExercises();
const backendId = 'backend-data-processing';
const frontendId = 'frontend-state-logic';
const slugsFor = (kit: string) => questions.filter(q => q.kits.some(k => k.id === kit)).map(q => q.slug);
const user = { id: 24, email: 'kit-reader@example.test', name: 'Kit Reader', display_name: 'Kit Reader', is_admin: false, is_available: true };

async function visibleSlugs(page: any, slugs: string[]) {
  await expect.poll(() => page.evaluate(() => (window as any)._randori_catalog_filters.state.visibleSlugs)).toEqual(slugs);
  await expect(page.getByTestId('catalog-list').locator('.catalog-card')).toHaveCount(slugs.length);
}

test('original kits are discoverable by track, difficulty and language and use the existing versioned Run path', async ({ page }) => {
  const executions: any[] = [];
  let reads = 0;
  await page.route(/^https:\/\//, route => route.abort());
  await mockApi(page, {
    '/api/auth/me': { ok: true, user },
    '/api/questions': () => { reads += 1; return { ok: true, questions, count: questions.length }; },
    '/api/execute': request => {
      executions.push(request.postDataJSON());
      return { ok: true, passed_count: 8, total_count: 8, results: Array.from({ length: 8 }, (_, idx) => ({ idx, pass: true })) };
    },
  });
  await resetClientState(page, true);
  await page.goto('/?view=code', { waitUntil: 'domcontentloaded' });
  await openRoomPanel(page, 'problem');
  await expect(page.locator('#questionSelect option')).toHaveCount(27);
  const track = page.getByTestId('catalog-track'), kit = page.getByTestId('catalog-kit');
  await expect(track.locator('option')).toHaveText(['All', 'Backend', 'Frontend']);
  await expect(kit.locator('option')).toHaveText(['All', 'Backend data processing', 'Frontend state logic']);
  await track.selectOption('backend');
  await expect(kit.locator('option')).toHaveText(['All', 'Backend data processing']);
  await kit.selectOption(backendId);
  await visibleSlugs(page, slugsFor(backendId));
  await page.getByTestId('catalog-difficulty').selectOption('Medium');
  await page.getByTestId('catalog-language').selectOption('python');
  await visibleSlugs(page, ['message-frequency-leaders', 'release-feed-merge', 'shard-window-audit', 'retry-credit-rounds']);
  await page.locator('.catalog-card[data-slug="shard-window-audit"]').click();
  await expect(page.locator('#qTitle')).toHaveText('Shard Window Audit');
  await expect(page.locator('#qDiff')).toContainText('Backend data processing');
  await expect(page.locator('#qExamples')).toContainText('The first window includes both time-four adjustments');
  await page.locator('#langSelect').selectOption('python');
  const code = 'def shard_window_audit(events, queries):\n    return []';
  await setCode(page, code);
  await page.locator('#runBtn').click();
  await expect(page.locator('#runOut')).toContainText('Result: 8/8 passed');
  expect(executions[0]).toMatchObject({ question_slug: 'shard-window-audit', question_version: 1, language: 'python', code });
  expect(executions[0]).not.toHaveProperty('kit');
  expect(executions[0]).not.toHaveProperty('tests');

  await openRoomPanel(page, 'problem');
  await page.getByTestId('catalog-search').fill('no-such-kit-question-zzz');
  await expect(page.getByTestId('catalog-empty')).toBeVisible();
  await expect(page.locator('#qTitle')).toHaveText('Shard Window Audit');
  await page.locator('#catalogEmptyClear').click();
  await visibleSlugs(page, questions.map(q => q.slug));
  await expect(kit).toHaveValue('all');
  await expect(track).toHaveValue('all');
  await expect(page.locator('#questionSelect')).toHaveValue('shard-window-audit');
  await track.selectOption('backend');
  await kit.selectOption(backendId);
  await track.selectOption('frontend');
  await expect(kit).toHaveValue('all');
  await expect(kit.locator('option')).toHaveText(['All', 'Frontend state logic']);
  await visibleSlugs(page, slugsFor(frontendId));
  expect(reads).toBe(1);
  expect(await page.evaluate(() => (window as any)._randori_questions.custom)).toEqual(questions);
});

test('kit browsing preserves a hydrated room question and explicit card selection saves its exact version', async ({ page }) => {
  const room = 'week_24_pair_24';
  const writes: any[] = [];
  const hydratedCode = 'function releaseFeedMerge(feeds) { return ["kept"]; }';
  let revision = 1;
  let snapshot: any = { schema_version: 3, revision, client_id: 'kit-server-seed', client_seq: 1, code: hydratedCode,
    language: 'javascript', question_id: 'release-feed-merge', question_version: 1, board: { shapes: [] } };
  await page.route(/^https:\/\//, route => route.abort());
  await mockApi(page, {
    '/api/auth/me': { ok: true, user },
    '/api/profile': { ok: true, user },
    '/api/my-pair': { ok: true, paired: true, room_id: room, week_id: 24, week: { id: 24, week_label: '2026-W38' },
      pair: { pg_id: 24, user_a_id: user.id, user_b_id: 25, is_ai: false, topic: 'Pick together' },
      partner: { id: 25, name: 'Partner', display_name: 'Partner', color: '#9cc0b5', tz: 'UTC' } },
    '/api/questions': { ok: true, questions, count: questions.length },
    '/api/video/signal': request => {
      if (request.method() === 'GET' && new URL(request.url()).searchParams.get('channel') === 'workspace') {
        return { ok: true, room_id: room, revision, snapshot };
      }
      if (request.method() === 'POST') {
        const body = request.postDataJSON();
        writes.push(body);
        const { base_revision, ...next } = body.payload;
        revision += 1;
        snapshot = { ...next, schema_version: 3, revision };
        return { ok: true, room_id: room, revision, snapshot };
      }
      return { ok: true, signals: [], after: 0, count: 0 };
    },
  });
  await resetClientState(page, true);
  await page.goto('/?view=code', { waitUntil: 'domcontentloaded' });
  await expect(page.locator('#questionSelect option')).toHaveCount(27);
  await page.evaluate(async roomId => {
    if (!await (window as any)._randori_workspace.requestAccess(roomId)) throw new Error('workspace access failed');
  }, room);
  await expect.poll(() => page.evaluate(() => (window as any)._randori_workspace.hydrated)).toBe(true);
  await openRoomPanel(page, 'problem');
  await page.getByTestId('catalog-track').selectOption('frontend');
  await page.getByTestId('catalog-kit').selectOption(frontendId);
  await expect(page.locator('#questionSelect')).toHaveValue('release-feed-merge');
  await expect(page.getByTestId('catalog-filtered-current')).toHaveAttribute('data-question-version', '1');
  await expect(page.locator('#qTitle')).toHaveText('Release Feed Merge');
  expect(await page.evaluate(() => (window as any)._randori_questions.selectedIdentity())).toEqual({ slug: 'release-feed-merge', version: 1 });
  expect(await page.evaluate(() => (window as any)._randori_code?.getCode?.() ?? document.querySelector<HTMLTextAreaElement>('#editor')?.value)).toBe(hydratedCode);
  expect(await page.evaluate(() => (window as any)._randori_workspace.flush())).toBe(true);
  expect(writes).toHaveLength(0);

  await page.locator('.catalog-card[data-slug="draft-revision-fold"]').click();
  await expect(page.locator('#questionSelect')).toHaveValue('draft-revision-fold');
  await expect(page.getByTestId('catalog-filtered-current')).toHaveCount(0);
  await expect(page.locator('#qTitle')).toHaveText('Draft Revision Fold');
  expect(await page.evaluate(() => (window as any)._randori_workspace.flush())).toBe(true);
  await expect.poll(() => writes.length).toBe(1);
  expect(writes[0]).toMatchObject({ room_id: room, type: 'code-sync', payload: {
    question_id: 'draft-revision-fold', question_version: 1, language: 'javascript', schema_version: 3, base_revision: 1,
  } });
  expect(writes[0].payload).not.toHaveProperty('kit');
  expect(writes[0].payload).not.toHaveProperty('track');
});

test('phone kit filters fit the Problem panel and retain the original difficulty spread', async ({ page }) => {
  await page.setViewportSize({ width: 393, height: 852 });
  await page.route(/^https:\/\//, route => route.abort());
  await mockApi(page, { '/api/auth/me': { ok: true, user }, '/api/questions': { ok: true, questions, count: questions.length } });
  await resetClientState(page, true);
  await page.goto('/?view=code', { waitUntil: 'domcontentloaded' });
  await openRoomPanel(page, 'problem');
  await page.getByTestId('catalog-kit').selectOption(frontendId);
  await page.getByTestId('catalog-difficulty').selectOption('Hard');
  await visibleSlugs(page, ['command-message-segmentation', 'focus-shortcut-tour']);
  expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(0);
  await page.locator('.catalog-card[data-slug="focus-shortcut-tour"]').click();
  await expect(page.locator('#qTitle')).toHaveText('Focus Shortcut Tour');
  await page.locator('#qStartCoding').click();
  await expect(page.locator('#roomPanel-code')).toBeVisible();
  await expect(page.locator('#runBtn')).toBeVisible();
});
