import { expect, Page, Request } from '@playwright/test';

type Json = Record<string, unknown>;
const testOrigin = `http://127.0.0.1:${Number(process.env.E2E_PORT || 4173)}`;

const defaultApiResponses: Record<string, Json> = {
  '/api/auth/me': { _status: 401, ok: false, error: 'authentication required' },
  '/api/circle': { ok: true, circle: [], count: 0 },
  '/api/weeks': { ok: true, weeks: [] },
  '/api/history': { ok: true, history: [], partner_counts: {}, total: 0 },
  '/api/stats': { ok: true, total_users: 0, total_weeks: 0, total_pairs: 0, total_sessions: 0 },
  '/api/my-pair': { ok: true, paired: false, reason: 'no_week_yet' },
  '/api/profile': { ok: true, user: null },
  '/api/questions': { ok: true, questions: [], count: 0 },
  '/api/runs': { ok: true, runs: [], count: 0 },
  '/api/logs': { ok: true, inserted: 1 },
  '/api/ai/history': { ok: true, feedbacks: [], usage_today: null },
  '/api/video/signal': { ok: true, signals: [], after: 0, count: 0 },
};

export async function mockApi(
  page: Page,
  overrides: Record<string, Json | ((request: Request) => Json | Promise<Json>)> = {},
) {
  await page.route('**/api/**', async route => {
    const request = route.request();
    const pathname = new URL(request.url()).pathname;
    const configured = overrides[pathname] ?? defaultApiResponses[pathname];
    const body = typeof configured === 'function' ? await configured(request) : configured;
    const status = Number(body?._status || (body ? 200 : 404));
    const responseBody = body ? { ...body } : { ok: false, error: `Unmocked API route: ${pathname}` };
    delete responseBody._status;
    await route.fulfill({
      status,
      contentType: 'application/json',
      body: JSON.stringify(responseBody),
    });
  });
}

export async function resetClientState(page: Page, authenticated = false) {
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
  await page.addInitScript(({ authenticated }) => {
    localStorage.clear();
    sessionStorage.clear();
    localStorage.setItem('randori-onboarded', '1');
    localStorage.setItem('randori-banner-dismissed', '1');
    localStorage.setItem('randori-profile-done', '1');
    localStorage.setItem('randori-landing-dismissed', '1');
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
  }, { authenticated });
}

export async function openCodeView(
  page: Page,
  overrides: Record<string, Json | ((request: Request) => Json | Promise<Json>)> = {},
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
