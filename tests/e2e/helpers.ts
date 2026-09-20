import { expect, Page, Request } from '@playwright/test';

type Json = Record<string, unknown>;
type ApiResponse = Json | ((request: Request) => Json | Promise<Json>);
const testOrigin = `http://127.0.0.1:${Number(process.env.E2E_PORT || 4173)}`;

function hasSessionCookie(request: Request) {
  return /(?:^|;\s*)randori_session=/.test(request.headers().cookie || '');
}

export const originalQuestionFixture = {
  slug: 'focus-block-rollup',
  version: 1,
  status: 'active',
  source: 'randori-original',
  title: 'Focus Block Roll-up',
  type: 'array-processing',
  difficulty: 'Easy',
  tags: ['arrays', 'aggregation'],
  prompt: 'Combine adjacent focus blocks that have the same label.',
  constraints: ['The input must not be modified.', 'Labels are case-sensitive.'],
  examples: [{
    input: [[{ label: 'code', minutes: 25 }, { label: 'code', minutes: 10 }]],
    output: [{ label: 'code', minutes: 35 }],
    explanation: 'Adjacent code blocks are combined.',
  }],
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

const defaultApiResponses: Record<string, ApiResponse> = {
  '/api/auth/capabilities': {
    ok: true,
    capabilities: { passwordLogin: true, passwordSignup: false, googleOAuth: true },
    registrationMode: 'private_beta',
  },
  '/api/auth/me': { _status: 401, ok: false, error: 'authentication required' },
  '/api/settings/availability': request => hasSessionCookie(request)
    ? {
        ok: true,
        availability: {
          cycle: {
            cycleId: '2099-W52',
            startsAt: '2099-12-27T08:00:00.000Z',
            endsAt: '2100-01-03T08:00:00.000Z',
            cutoffAt: '2099-12-27T08:00:00.000Z',
            timeZone: 'Europe/London',
            state: 'upcoming',
          },
          cycleKey: 'f'.repeat(64),
          isAvailable: true,
          version: 0,
          source: 'cycle_default',
          editable: true,
          updatedAt: null,
        },
      }
    : { _status: 401, error: 'authentication required' },
  '/api/circle': request => hasSessionCookie(request)
    ? {
        ok: true,
        circle_meta: { id: 1, public_id: 'circle_e2e', name: 'E2E Circle' },
        membership: { role: 'member' },
        circle: [],
        count: 0,
      }
    : { _status: 401, error: 'authentication required' },
  '/api/invitations': { _status: 403, error: 'owner access required' },
  '/api/invitations/:id': { _status: 403, error: 'owner access required' },
  '/api/invitations/prepare': { _status: 400, error: 'invitation unavailable' },
  '/api/weeks': { ok: true, weeks: [] },
  '/api/history': { ok: true, history: [], partner_counts: {}, total: 0 },
  '/api/stats': { ok: true, total_users: 0, total_weeks: 0, total_pairs: 0, total_sessions: 0 },
  '/api/notifications/prefs': request => {
    const requested = request.method() === 'POST'
      ? (request.postDataJSON() as { email_enabled?: boolean } | null)?.email_enabled
      : undefined;
    return {
      ok: true,
      prefs: { user_id: 1, email_enabled: requested ?? true, sms_enabled: false, phone: null },
    };
  },
  '/api/my-pair': { ok: true, paired: false, reason: 'no_week_yet' },
  '/api/profile': { ok: true, user: null },
  '/api/questions': request => hasSessionCookie(request)
    ? { ok: true, questions: [originalQuestionFixture], count: 1 }
    : { _status: 401, ok: false, error: 'authentication required' },
  '/api/runs': { ok: true, runs: [], count: 0 },
  '/api/logs': { ok: true, inserted: 1 },
  '/api/ai/history': { ok: true, feedbacks: [], usage_today: null },
  '/api/video/signal': { ok: true, signals: [], after: 0, count: 0 },
};

export async function mockApi(
  page: Page,
  overrides: Record<string, ApiResponse> = {},
) {
  await page.route('**/api/**', async route => {
    const request = route.request();
    const pathname = new URL(request.url()).pathname;
    const routeKey = /^\/api\/invitations\/[0-9a-f-]+$/i.test(pathname) ? '/api/invitations/:id' : pathname;
    const configured = overrides[routeKey] ?? defaultApiResponses[routeKey];
    const body = typeof configured === 'function' ? await configured(request) : configured;
    const status = Number(body?._status || (body ? 200 : 404));
    const responseBody = body ? { ...body } : { ok: false, error: `Unmocked API route: ${pathname}` };
    // Most feature fixtures predate the explicit cycle envelope now guaranteed
    // by /api/my-pair. Keep them representative without hiding tests that
    // deliberately supply a null or malformed cycle.
    if(routeKey==='/api/my-pair'&&responseBody.ok===true
      &&!Object.prototype.hasOwnProperty.call(responseBody,'current_cycle')
      &&!Object.prototype.hasOwnProperty.call(responseBody,'cycle')){
      const startsAt=Date.now()-86_400_000;
      const endsAt=startsAt+7*86_400_000;
      responseBody.current_cycle={
        cycleId:'2026-W38',startsAt:new Date(startsAt).toISOString(),endsAt:new Date(endsAt).toISOString(),
        cutoffAt:new Date(startsAt).toISOString(),timeZone:'Europe/London',state:'current',
      };
      responseBody.upcoming_cycle={
        cycleId:'2026-W39',startsAt:new Date(endsAt).toISOString(),endsAt:new Date(endsAt+7*86_400_000).toISOString(),
        cutoffAt:new Date(endsAt).toISOString(),timeZone:'Europe/London',state:'upcoming',
      };
    }
    delete responseBody._status;
    await route.fulfill({
      status,
      contentType: 'application/json',
      body: JSON.stringify(responseBody),
    });
  });
}

export async function resetClientState(
  page: Page,
  authenticated = false,
  initialLocalStorage: Record<string, string> = {},
  preserveStateAcrossNavigation = false,
) {
  await page.context().clearCookies();
  if (authenticated) {
    await page.context().addCookies([{
      name: 'randori_session',
      value: 'local-e2e-session',
      url: testOrigin,
      httpOnly: true,
      sameSite: 'Lax',
    }]);
  }
  await page.addInitScript(({ authenticated, initialLocalStorage, preserveStateAcrossNavigation }) => {
    // page.addInitScript also runs in frames. A late same-origin iframe must
    // not clear the top-level application's shared localStorage mid-test.
    if (window.top !== window) return;
    if (preserveStateAcrossNavigation&&sessionStorage.getItem('randori-e2e-state-ready')==='1') return;
    localStorage.clear();
    sessionStorage.clear();
    if(preserveStateAcrossNavigation) sessionStorage.setItem('randori-e2e-state-ready','1');
    localStorage.setItem('randori-onboarded', '1');
    localStorage.setItem('randori-banner-dismissed', '1');
    localStorage.setItem('randori-profile-done', '1');
    localStorage.setItem('randori-landing-dismissed', '1');
    for (const [key, value] of Object.entries(initialLocalStorage)) localStorage.setItem(key, value);
    if (authenticated) {
      localStorage.setItem('randori-me', JSON.stringify({
        id: 1,
        email: 'e2e@example.test',
        name: 'E2E Tester',
        display_name: 'E2E Tester',
        color: '#c8f6a0',
        is_admin: false,
        is_available: true,
        tz: 'Europe/London',
        interview_focus: 'both',
      }));
    }
  }, { authenticated, initialLocalStorage, preserveStateAcrossNavigation });
}

export async function openCodeView(
  page: Page,
  overrides: Record<string, ApiResponse> = {},
) {
  await mockApi(page, overrides);
  await resetClientState(page);
  await page.goto('/?view=code', { waitUntil: 'domcontentloaded' });
  const tab = page.locator('[data-tab="code"]');
  await expect(tab).toBeVisible();
  await tab.click();
  await expect(page.locator('#view-code')).toBeVisible();
}

export async function setCode(page: Page, code: string) {
  await page.waitForFunction(() => {
    const app = window as typeof window & {
      _randori_code?: { getEditor?: () => { getValue(): string } | null };
      _randori_monaco?: { editor?: { getValue(): string }; ready?: boolean };
    };
    const monaco = app._randori_code?.getEditor?.() || app._randori_monaco?.editor;
    if (monaco && typeof monaco.getValue === 'function') return true;

    const textarea = document.querySelector<HTMLTextAreaElement>('#editor');
    return Boolean(textarea && getComputedStyle(textarea).display !== 'none');
  });

  await page.evaluate(value => {
    type Editor = { getValue(): string; setValue(value: string): void };
    type CodeApi = {
      currentRoom?: string;
      getCode?: () => string;
      getEditor?: () => Editor | null;
      setCode?: (value: string, language?: string) => void;
    };
    const app = window as typeof window & {
      _randori_code?: CodeApi;
      _randori_monaco?: { editor?: Editor };
      currentRoom?: string;
    };
    const textarea = document.querySelector<HTMLTextAreaElement>('#editor');
    const language = document.querySelector<HTMLSelectElement>('#langSelect')?.value || 'javascript';
    const question = document.querySelector<HTMLSelectElement>('#questionSelect')?.value || 'two-sum';
    const room = app._randori_code?.currentRoom
      || app.currentRoom
      || document.querySelector<HTMLSelectElement>('#roomSelect')?.value;

    // Monaco performs one deferred room hydration after it becomes ready. Keep
    // that source synchronized so it cannot restore stale starter code.
    if (room) {
      let saved: Record<string, { lang?: string; qId?: string; codes?: Record<string, string> }> = {};
      try { saved = JSON.parse(localStorage.getItem('randori-code') || '{}'); } catch {}
      const entry = saved[room] || { codes: {} };
      entry.lang = language;
      entry.qId = question;
      entry.codes = entry.codes || {};
      entry.codes[language] = value;
      saved[room] = entry;
      localStorage.setItem('randori-code', JSON.stringify(saved));
    }

    const monaco = app._randori_code?.getEditor?.() || app._randori_monaco?.editor;
    if (monaco) {
      if (app._randori_code?.setCode) app._randori_code.setCode(value, language);
      else monaco.setValue(value);
    }
    if (textarea) {
      textarea.value = value;
      textarea.dispatchEvent(new Event('input', { bubbles: true }));
      textarea.dispatchEvent(new Event('change', { bubbles: true }));
    }
  }, code);

  await expect.poll(() => page.evaluate(expected => {
    type Editor = { getValue(): string };
    const app = window as typeof window & {
      _randori_code?: { getCode?: () => string; getEditor?: () => Editor | null };
      _randori_monaco?: { editor?: Editor };
    };
    const monaco = app._randori_code?.getEditor?.() || app._randori_monaco?.editor;
    const textarea = document.querySelector<HTMLTextAreaElement>('#editor');
    const editorValue = monaco?.getValue() ?? textarea?.value ?? '';
    const appValue = app._randori_code?.getCode?.() ?? textarea?.value ?? '';
    return editorValue === expected && appValue === expected;
  }, code)).toBe(true);
}

export async function selectLanguage(page: Page, language: string) {
  await page.locator('#langSelect').selectOption(language);
}

export async function selectQuestion(page: Page, slug: string) {
  await page.locator('#questionSelect').selectOption(slug);
  const overlay = page.locator('#confirmOverlay.show');
  if (await overlay.isVisible()) await page.locator('#confirmOk').click();
}

export const twoSumCorrect = `function twoSum(nums, target) {
  const seen = new Map();
  for (let index = 0; index < nums.length; index += 1) {
    const needed = target - nums[index];
    if (seen.has(needed)) return [seen.get(needed), index];
    seen.set(nums[index], index);
  }
  return [];
}`;

export const twoSumBroken = 'function twoSum() { return []; }';

export const focusBlockRollupCorrect = `function rollUpFocusBlocks(blocks) {
  const rolledUp = [];
  for (const block of blocks) {
    const previous = rolledUp[rolledUp.length - 1];
    if (previous && previous.label === block.label) previous.minutes += block.minutes;
    else rolledUp.push({ ...block });
  }
  return rolledUp;
}`;
