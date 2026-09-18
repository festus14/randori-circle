import { expect, test } from '@playwright/test';
import { mockApi, resetClientState } from './helpers';

const user = {
  id: 1,
  email: 'owner@example.test',
  name: 'Circle Owner',
  display_name: 'Circle Owner',
  color: '#c8f6a0',
  is_admin: false,
  is_available: true,
  tz: 'Europe/London',
  interview_focus: 'both',
};

const currentWeek = {
  id: 20,
  week_label: '2026-W38',
  week_start: '2026-09-13T07:00:00.000Z',
  focus: 'both',
  is_demo: false,
  is_current: true,
  pairs: [{
    pg_id: 30,
    week_id: 20,
    a_id: 1,
    b_id: 2,
    a_name: 'Current Owner',
    b_name: 'Current Partner',
    a_color: '#c8f6a0',
    b_color: '#9cc0b5',
    is_ai: false,
    topic: 'Pick together',
    topic_kind: 'both',
  }],
};

const futureWeek = {
  ...currentWeek,
  id: 99,
  week_label: '2099-W52',
  week_start: '2099-12-27T08:00:00.000Z',
  is_current: false,
  pairs: [{ ...currentWeek.pairs[0], pg_id: 99, week_id: 99, a_name: 'Future Pair' }],
};

function circle(role: 'owner' | 'member') {
  return {
    ok: true,
    circle_meta: { id: 1, public_id: 'circle_e2e', name: 'E2E Circle' },
    membership: { role },
    circle: [user],
    count: 1,
  };
}

test('the owner sees only the server-marked current cycle and can run it idempotently', async ({ page }) => {
  let pairingRuns = 0;
  await mockApi(page, {
    '/api/auth/me': { ok: true, user },
    '/api/circle': circle('owner'),
    '/api/weeks': {
      ok: true,
      current_cycle: { cycleId: '2026-W38' },
      current_week_id: 20,
      weeks: [futureWeek, currentWeek],
    },
    '/api/pairing/run': () => {
      pairingRuns += 1;
      return {
        ok: true,
        created: false,
        skipped: true,
        week_label: '2026-W38',
        week_id: 20,
        count: 2,
        pairs: [],
        message: 'Current-cycle pairings were already published; no pairs were changed.',
      };
    },
  });
  await resetClientState(page, true, {
    'randori-weeks': JSON.stringify([{
      id: 'fake-local', label: 'Fake local week', date: '2098-01-01T00:00:00.000Z',
      pairs: [{ id: 'fake-room', aId: 'a', bId: 'b', isAI: false }],
    }]),
  });
  await page.goto('/', { waitUntil: 'domcontentloaded' });

  await page.locator('[data-tab="pair"]').click();
  await expect(page.locator('#pairsList')).toContainText('Current Partner');
  await expect(page.locator('#pairsList')).not.toContainText('Future Pair');
  await expect(page.locator('#pairsList')).not.toContainText('Fake local week');
  await expect(page.locator('#roomSelect')).toHaveValue('week_20_pair_30');
  await expect(page.getByRole('button', { name: 'Remix' })).toHaveCount(0);

  await page.locator('[data-tab="code"]').click();
  await expect(page.locator('#roomSelect')).toHaveValue('week_20_pair_30');
  await expect(page.locator('#roomSelect')).not.toContainText('fake-room');

  await page.locator('[data-tab="pair"]').click();

  const runButton = page.getByRole('button', { name: 'Run current cycle' });
  await expect(runButton).toBeVisible();
  await runButton.click();
  await expect.poll(() => pairingRuns).toBe(1);
  await expect(page.locator('#pairsList')).toContainText('Current Partner');
});

test('a signed-in member never sees stale or local fallback pairs as this week', async ({ page }) => {
  await mockApi(page, {
    '/api/auth/me': { ok: true, user },
    '/api/circle': circle('member'),
    '/api/weeks': {
      ok: true,
      current_cycle: { cycleId: '2026-W38' },
      current_week_id: null,
      weeks: [futureWeek, { ...currentWeek, is_current: false, week_label: '2026-W37' }],
    },
  });
  await resetClientState(page, true, {
    'randori-weeks': JSON.stringify([{
      id: 'fake-local', label: 'Fake local week', date: '2098-01-01T00:00:00.000Z',
      pairs: [{ id: 'fake-room', aId: 'a', bId: null, isAI: true }],
    }]),
    'randori-people': JSON.stringify([{ id: 'a', name: 'Fake Local Person', color: '#ffffff' }]),
  });
  await page.goto('/', { waitUntil: 'domcontentloaded' });

  await page.locator('[data-tab="pair"]').click();
  await expect(page.locator('#currentWeekMeta')).toContainText('awaiting current-cycle publication');
  await expect(page.locator('#pairsList')).toContainText('No pairings have been published for the current cycle');
  await expect(page.locator('#pairsList')).not.toContainText('Future Pair');
  await expect(page.locator('#pairsList')).not.toContainText('Fake Local Person');
  await expect(page.locator('#roomSelect')).toHaveValue('');
  await expect(page.locator('#roomSelect')).toContainText('No current-cycle room');
  await expect(page.getByRole('button', { name: 'Run current cycle' })).toBeHidden();

  await page.locator('[data-tab="code"]').click();
  await expect(page.locator('#roomSelect')).toHaveValue('');
  await expect(page.locator('#roomSelect')).toContainText('No current-cycle room');
  await expect(page.locator('#roomSelect')).not.toContainText('fake-room');
});

test('the home countdown uses the server cycle boundary instead of a fixed UTC hour',async({page})=>{
  await mockApi(page,{
    '/api/stats':{
      ok:true,total_users:0,total_weeks:0,total_pairs:0,total_sessions:0,
      next_shuffle_utc:'2099-11-01T08:00:00.000Z',
      next_shuffle_label:'Sunday 08:00 London time • 1 Nov',
    },
  });
  await resetClientState(page);
  await page.goto('/',{waitUntil:'domcontentloaded'});

  await expect(page.locator('#landingNextLabel')).toHaveText('Sunday 08:00 London time • 1 Nov');
  await expect(page.locator('#landingNextCountdown')).toHaveText(/^\d{4,}d \d+h to pairing$/);
});
