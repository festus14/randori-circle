import { expect, Page, test } from '@playwright/test';
import { mockApi, originalQuestionFixture, resetClientState } from './helpers';

const room = 'week_42_pair_7';
const user = {
  id: 1,
  email: 'workspace@example.test',
  name: 'Workspace Tester',
  display_name: 'Workspace Tester',
  color: '#c8f6a0',
  is_admin: false,
  is_available: true,
  tz: 'Europe/London',
  interview_focus: 'both',
};
const partner = {
  id: 2,
  email: 'partner@example.test',
  name: 'Practice Partner',
  display_name: 'Practice Partner',
  color: '#9cc0b5',
  is_admin: false,
  is_available: true,
  tz: 'America/New_York',
  interview_focus: 'dsa',
};
const schedule = {
  version: 'a'.repeat(64),
  proposals: [{
    proposal_id: 'proposal_1',
    value: '2026-09-20T17:00:00.000Z',
    instant: '2026-09-20T17:00:00.000Z',
    proposed_by: partner.id,
    legacy: false,
  }],
  agreed_time: null,
  legacy_agreed_time: null,
  updated_at: '2026-09-19T08:00:00.000Z',
};

function pairResponse() {
  return {
    ok: true,
    paired: true,
    room_id: room,
    week_id: 42,
    week: { id: 42, week_label: '2026-W42' },
    pair: {
      pg_id: 7,
      week_id: 42,
      room_id: room,
      user_a_id: user.id,
      user_b_id: partner.id,
      user_c_id: null,
      is_ai: false,
      is_ai_pair: false,
      topic: 'Pick together',
      topic_kind: 'both',
    },
    partner,
    partners: [partner],
    me: user,
    schedule,
  };
}

async function openSignedInWorkspace(page: Page, overrides: Parameters<typeof mockApi>[1] = {}) {
  await page.route(/^https:\/\//, route => route.abort());
  await mockApi(page, {
    '/api/auth/me': { ok: true, user },
    '/api/profile': { ok: true, user },
    '/api/circle': {
      ok: true,
      circle_meta: { id: 1, public_id: 'circle_workspace', name: 'Workspace Circle' },
      membership: { role: 'member' },
      circle: [user, partner],
      count: 2,
    },
    '/api/my-pair': pairResponse(),
    '/api/schedule': { ok: true, room_id: room, schedule },
    '/api/messages': { ok: true, room_id: room, messages: [], after: 0, count: 0 },
    '/api/questions': { ok: true, questions: [originalQuestionFixture], count: 1 },
    '/api/history': { ok: true, user: { id: user.id }, history: [], total: 0 },
    '/api/video/signal': request => {
      const url = new URL(request.url());
      if (request.method() === 'GET' && url.searchParams.get('channel') === 'workspace') {
        const revision = 1;
        return {
          ok: true,
          room_id: room,
          revision,
          snapshot: Number(url.searchParams.get('after_revision') || 0) < revision ? {
            schema_version: 3,
            revision,
            client_id: 'server-fixture',
            client_seq: 1,
            code: originalQuestionFixture.languages.javascript.starter,
            language: 'javascript',
            question_id: originalQuestionFixture.slug,
            question_version: originalQuestionFixture.version,
            board: { shapes: [] },
          } : null,
        };
      }
      return { ok: true, signals: [], after: 0, count: 0 };
    },
    ...overrides,
  });
  await resetClientState(page, true, { 'randori-theme': 'dark' });
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await expect(page.locator('#view-dashboard')).toBeVisible();
}

test('the paired dashboard and workspaces present an honest, accessible task flow', async ({ page }) => {
  await openSignedInWorkspace(page);

  const coordination = page.getByTestId('coordination-grid');
  await expect(coordination.getByRole('heading', { name: 'Agree a time' })).toBeVisible();
  await expect(coordination.getByRole('heading', { name: 'Pair chat' })).toBeVisible();
  await expect(page.getByTestId('schedule-status')).toHaveAttribute('data-state', 'success');
  await expect(page.getByTestId('pair-chat-status')).toHaveAttribute('data-state', 'idle');
  await expect(page.getByTestId('pair-chat-status')).toHaveText('No messages yet');
  expect(await coordination.evaluate(element => getComputedStyle(element).gridTemplateColumns.split(' ').length)).toBe(2);

  await page.locator('[data-tab="code"]').click();
  await expect(page.getByRole('heading', { name: 'Code together' })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Optional video' })).toBeVisible();
  await page.evaluate(() => {
    const target = window as typeof window & { __mediaRequests?: number };
    target.__mediaRequests = 0;
    Object.defineProperty(navigator, 'mediaDevices', {
      configurable: true,
      value: { getUserMedia: async () => { target.__mediaRequests = (target.__mediaRequests || 0) + 1; throw new Error('not expected before join'); } },
    });
  });
  const cameraPreference = page.getByRole('button', { name: 'Join with camera' });
  const microphonePreference = page.getByRole('button', { name: 'Join with microphone' });
  await expect(cameraPreference).toHaveAttribute('aria-pressed', 'true');
  await expect(microphonePreference).toHaveAttribute('aria-pressed', 'true');
  await cameraPreference.click();
  await expect(page.getByRole('button', { name: 'Join without camera' })).toHaveAttribute('aria-pressed', 'false');
  await page.getByRole('button', { name: 'Join without camera' }).click();
  await expect(page.getByRole('button', { name: 'Join with camera' })).toHaveAttribute('aria-pressed', 'true');
  await expect.poll(() => page.evaluate(() => (window as typeof window & { __mediaRequests?: number }).__mediaRequests)).toBe(0);
  await expect(page.locator('#videoStatus')).toHaveText('off');
  await expect(page.getByRole('button', { name: /screen share/i })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Run code' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Join room' })).toBeVisible();

  await page.locator('[data-tab="board"]').click();
  await expect(page.getByRole('heading', { name: 'Shared whiteboard' })).toBeVisible();
  await expect(page.getByRole('toolbar', { name: 'Whiteboard tools' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Select or move a shape' })).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('#boardSyncStatus')).toHaveAttribute('role', 'status');

  // Leave the polling workspace explicitly. WebKit otherwise waits for its
  // intercepted long-poll requests while Playwright tears the context down.
  await page.goto('about:blank', { waitUntil: 'commit' });
});

test('workspace layouts remain usable without page overflow on a narrow phone', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await openSignedInWorkspace(page);

  const coordination = page.getByTestId('coordination-grid');
  expect(await coordination.evaluate(element => getComputedStyle(element).gridTemplateColumns.split(' ').length)).toBe(1);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(390);
  expect((await page.getByTestId('schedule-propose').boundingBox())?.height).toBeGreaterThanOrEqual(44);

  await page.locator('[data-tab="code"]').click();
  await expect(page.getByRole('heading', { name: 'Code together' })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(390);
  expect(await page.locator('[data-testid="catalog-filters"]').evaluate(element => getComputedStyle(element).gridTemplateColumns.split(' ').length)).toBe(1);

  await page.locator('[data-tab="board"]').click();
  const toolbar = page.getByRole('toolbar', { name: 'Whiteboard tools' });
  await expect(toolbar).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(390);
  expect(await toolbar.evaluate(element => element.scrollWidth > element.clientWidth)).toBe(true);
  expect((await page.getByRole('button', { name: 'Draw with the pen' }).boundingBox())?.height).toBeGreaterThanOrEqual(40);
});

test('circle, catalogue, and history failures stay distinct and recoverable', async ({ page }) => {
  await openSignedInWorkspace(page, {
    '/api/circle': { _status: 503, ok: false, error: 'circle unavailable' },
    '/api/questions': { ok: true, questions: [], count: 0 },
    '/api/history': { _status: 503, ok: false, error: 'history unavailable' },
  });

  await page.locator('[data-tab="circle"]').click();
  await expect(page.getByRole('heading', { name: 'Your practice circle' })).toBeVisible();
  await expect(page.locator('#circleAutoNote')).toHaveAttribute('data-state', 'error');
  await expect(page.locator('#peopleList').getByRole('button', { name: 'Retry' })).toBeVisible();

  await page.locator('[data-tab="code"]').click();
  await expect(page.getByTestId('catalog-empty')).toBeVisible();
  await expect(page.getByTestId('catalog-empty')).toHaveAttribute('data-state', 'empty');
  await expect(page.getByTestId('catalog-empty')).toContainText('No public exercises');

  await page.locator('[data-tab="history"]').click();
  await expect(page.getByRole('heading', { name: 'Pairings and activity' })).toBeVisible();
  await expect(page.getByTestId('pair-history-status')).toHaveAttribute('data-state', 'error');
  await expect(page.getByRole('button', { name: 'Retry history' })).toBeVisible();
});
