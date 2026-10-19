#!/usr/bin/env node
// Capture a visual baseline of Randori Circle for design review.
//
// Two sources are rendered at a mobile (393x852 @3x, touch) and a desktop
// (1440x900) viewport:
//
//  1. Public production pages, strictly read-only. Every non-GET/HEAD request
//     to any origin is aborted and recorded, and third-party telemetry is
//     blocked, so the capture cannot submit forms, write logs, or mutate data.
//  2. Signed-in screens rendered against the repository's real loopback
//     runtime (scripts/local-server.mjs) over a fresh private temporary
//     database. State is created only through product endpoints and UI, the
//     same way tests/e2e/pairing-real-runtime.spec.ts drives the journey.
//
// Output: <out>/<viewport>__<screen>.png plus <out>/manifest.json.
// This is a design tool, not a test: a failing step is recorded in the
// manifest and the run continues so one broken screen never hides the rest.
//
// Usage:
//   node scripts/ui-screenshots.mjs
// Environment:
//   UI_SCREENSHOTS_OUT         output directory (default: ui-screenshots)
//   UI_SCREENSHOTS_PROD_URL    public origin (default: https://randori-circle-self.vercel.app)
//   UI_SCREENSHOTS_SCOPE       all | public | local (default: all)
//   UI_SCREENSHOTS_VIEWPORTS   comma list of mobile,desktop (default: both)

import { spawn } from 'node:child_process';
import { copyFileSync, cpSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { chromium } from '@playwright/test';

import {
  LOCAL_OWNER_EMAIL,
  LOCAL_OWNER_PASSWORD,
  resolveLocalServerConfig,
  startLocalDevelopmentServer,
} from './local-server.mjs';

const REPOSITORY_ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const DEFAULT_PROD_URL = 'https://randori-circle-self.vercel.app';
const MEMBER_PASSWORD = 'member-password-123';
const MEMBER_EMAIL = 'invited.member@example.test';
const MEMBER_NAME = 'Invited Member';
const EXECUTION_API_URL = 'https://execution.screenshots.invalid/api/v2/execute';

const VIEWPORTS = Object.freeze({
  mobile: {
    viewport: { width: 393, height: 852 },
    deviceScaleFactor: 3,
    isMobile: true,
    hasTouch: true,
    userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 '
      + '(KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1',
  },
  desktop: {
    viewport: { width: 1440, height: 900 },
    deviceScaleFactor: 1,
    isMobile: false,
    hasTouch: false,
  },
});

const TELEMETRY_RESOLVER_RULES = [
  'MAP js-de.sentry-cdn.com ~NOTFOUND',
  'MAP browser.sentry-cdn.com ~NOTFOUND',
  'MAP *.sentry.io ~NOTFOUND',
].join(', ');

const sleep = ms => new Promise(done => setTimeout(done, ms));

// Clicks through the real control; if a layout bug (for example an
// overflowing mobile sheet) blocks Playwright's actionability checks, fall
// back to a DOM click so one layout defect does not hide later screens.
async function tap(page, selector) {
  const target = typeof selector === 'string' ? page.locator(selector) : selector;
  try { await target.first().click({ timeout: 8_000 }); }
  catch { await target.first().evaluate(element => element.click()); }
}

// A response wait that never becomes an unhandled rejection when the action
// that should trigger it fails first.
function responseOf(page, predicate, timeout = 30_000) {
  const pending = page.waitForResponse(predicate, { timeout });
  pending.catch(() => {});
  return pending;
}

function parseOptions(env = process.env) {
  const scope = String(env.UI_SCREENSHOTS_SCOPE || 'all').trim();
  if (!['all', 'public', 'local'].includes(scope)) throw new Error(`invalid UI_SCREENSHOTS_SCOPE: ${scope}`);
  const viewports = String(env.UI_SCREENSHOTS_VIEWPORTS || 'mobile,desktop').split(',')
    .map(item => item.trim()).filter(Boolean);
  for (const name of viewports) if (!VIEWPORTS[name]) throw new Error(`invalid viewport: ${name}`);
  const prodUrl = new URL(String(env.UI_SCREENSHOTS_PROD_URL || DEFAULT_PROD_URL).trim());
  if (prodUrl.protocol !== 'https:') throw new Error('UI_SCREENSHOTS_PROD_URL must be https');
  return {
    scope,
    viewports,
    prodOrigin: prodUrl.origin,
    outDir: resolve(String(env.UI_SCREENSHOTS_OUT || 'ui-screenshots')),
  };
}

class Recorder {
  constructor(outDir) {
    this.outDir = outDir;
    this.shots = [];
    this.failures = [];
    this.blocked = [];
    mkdirSync(outDir, { recursive: true });
  }

  async shot(page, viewport, name, { fullPage = true, settle = 700 } = {}) {
    const file = `${viewport}__${name}.png`;
    try {
      await page.waitForLoadState('domcontentloaded');
      await sleep(settle);
      await page.screenshot({ path: join(this.outDir, file), fullPage, animations: 'disabled', timeout: 30_000 });
      this.shots.push({ file, url: page.url() });
      process.stdout.write(`captured ${file}\n`);
    } catch (error) {
      this.fail(`${viewport}:${name}`, error);
    }
  }

  fail(step, error) {
    const message = String(error?.message || error).split('\n')[0].slice(0, 400);
    this.failures.push({ step, message });
    process.stdout.write(`step failed ${step}: ${message}\n`);
  }

  async step(label, fn) {
    try { return await fn(); }
    catch (error) { this.fail(label, error); return undefined; }
  }

  write(meta) {
    writeFileSync(join(this.outDir, 'manifest.json'), `${JSON.stringify({
      ...meta,
      generated_at: new Date().toISOString(),
      screenshots: this.shots,
      failures: this.failures,
      blocked_non_get_requests: this.blocked,
    }, null, 2)}\n`);
  }
}

// ---------------------------------------------------------------- public ---

async function guardReadOnly(context, recorder) {
  await context.route('**/*', route => {
    const request = route.request();
    const method = request.method();
    if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') return route.continue();
    recorder.blocked.push({ method, url: request.url().split('?')[0] });
    return route.abort('blockedbyclient');
  });
}

async function waitForAuthDialog(page) {
  await page.locator('#authOverlay.show').waitFor({ state: 'visible', timeout: 15_000 });
  await page.waitForFunction(() => {
    const text = document.getElementById('authCapabilityStatus')?.textContent || '';
    return !/^Checking/i.test(text.trim());
  }, null, { timeout: 15_000 }).catch(() => {});
}

async function capturePublic(browser, viewportName, origin, recorder) {
  const freshContext = async ({ returning = false, theme = 'dark' } = {}) => {
    const context = await browser.newContext({ ...VIEWPORTS[viewportName], timezoneId: 'Europe/London', locale: 'en-GB' });
    await guardReadOnly(context, recorder);
    await context.addInitScript(({ returningVisitor, preferredTheme }) => {
      try {
        localStorage.setItem('randori-theme', preferredTheme);
        if (returningVisitor) {
          localStorage.setItem('randori-onboarded', '1');
          localStorage.setItem('randori-banner-dismissed', '1');
        }
      } catch {}
    }, { returningVisitor: returning, preferredTheme: theme });
    return context;
  };
  const visit = async (page, path) => {
    await page.goto(`${origin}${path}`, { waitUntil: 'domcontentloaded', timeout: 45_000 });
    await page.waitForLoadState('networkidle', { timeout: 10_000 }).catch(() => {});
  };

  // First-time visitor: exactly what a new person sees, banner and all.
  let context = await freshContext();
  let page = await context.newPage();
  await recorder.step(`${viewportName}:public-first-visit`, async () => {
    await visit(page, '/');
    await sleep(1200);
    await recorder.shot(page, viewportName, 'landing');
    await recorder.shot(page, viewportName, 'landing-above-fold', { fullPage: false });
  });
  await context.close();

  // Returning visitor: landing without the first-visit banner, then auth dialogs.
  context = await freshContext({ returning: true });
  page = await context.newPage();
  await recorder.step(`${viewportName}:public-returning`, async () => {
    await visit(page, '/');
    await sleep(800);
    await recorder.shot(page, viewportName, 'landing-returning');
  });
  await recorder.step(`${viewportName}:public-signin`, async () => {
    await tap(page, '#landingSignin');
    await waitForAuthDialog(page);
    await recorder.shot(page, viewportName, 'signin-dialog', { fullPage: false });
  });
  await recorder.step(`${viewportName}:public-forgot`, async () => {
    const forgot = page.locator('#authForgot');
    await forgot.waitFor({ state: 'visible', timeout: 10_000 });
    await tap(page, forgot);
    await sleep(400);
    await recorder.shot(page, viewportName, 'forgot-password-dialog', { fullPage: false });
  });
  await recorder.step(`${viewportName}:public-invite-help`, async () => {
    await visit(page, '/');
    await tap(page, '#landingSignup');
    await sleep(500);
    await recorder.shot(page, viewportName, 'landing-use-invitation-clicked');
  });
  for (const [path, name] of [['/invite', 'invite-no-token'], ['/verify', 'verify-no-token'], ['/reset-password', 'reset-password-no-token']]) {
    await recorder.step(`${viewportName}:public-${name}`, async () => {
      await visit(page, path);
      await sleep(1000);
      await recorder.shot(page, viewportName, name);
    });
  }
  await context.close();

  context = await freshContext({ returning: true, theme: 'light' });
  page = await context.newPage();
  await recorder.step(`${viewportName}:public-light`, async () => {
    await visit(page, '/');
    await sleep(800);
    await recorder.shot(page, viewportName, 'landing-light');
  });
  await context.close();
}

// ----------------------------------------------------------------- local ---

function executeLocalHarness(source) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(process.execPath, ['--input-type=commonjs'], { stdio: ['pipe', 'pipe', 'pipe'] });
    const stdout = [];
    const stderr = [];
    let bytes = 0;
    const timer = setTimeout(() => { child.kill('SIGKILL'); rejectRun(new Error('execution timed out')); }, 20_000);
    const capture = target => chunk => {
      bytes += chunk.length;
      if (bytes > 4 * 1024 * 1024) { child.kill('SIGKILL'); return; }
      target.push(chunk);
    };
    child.stdout.on('data', capture(stdout));
    child.stderr.on('data', capture(stderr));
    child.once('error', error => { clearTimeout(timer); rejectRun(error); });
    child.once('close', (code, signal) => {
      clearTimeout(timer);
      resolveRun({
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: Buffer.concat(stderr).toString('utf8'),
        code,
        signal,
      });
    });
    child.stdin.end(source);
  });
}

// Same deterministic, process-local execution boundary the real-runtime e2e
// uses: only the exact provider-shaped JavaScript envelope is executed, in a
// child Node process; every other server-side network destination is refused.
function installLocalExecutionTransport(getRuntimeOrigin) {
  const nativeFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (new URL(url).origin === getRuntimeOrigin()) return nativeFetch(input, init);
    if (url !== EXECUTION_API_URL) throw new Error('unexpected server-side network request');
    const request = JSON.parse(String(init?.body || '{}'));
    const files = request.files || [];
    if (init?.method !== 'POST' || files.length !== 1 || typeof files[0]?.content !== 'string') {
      throw new Error('invalid execution request');
    }
    const result = await executeLocalHarness(files[0].content);
    return new Response(JSON.stringify({
      language: request.language,
      version: request.version,
      run: result,
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  return () => { globalThis.fetch = nativeFetch; };
}

function fixServerTime(iso) {
  const NativeDate = globalThis.Date;
  const instant = new NativeDate(iso).getTime();
  globalThis.Date = class FixedDate extends NativeDate {
    constructor(...args) { super(...(args.length ? args : [instant])); }
    static now() { return instant; }
  };
  return () => { globalThis.Date = NativeDate; };
}

async function browserJson(page, path, method = 'GET', body) {
  return page.evaluate(async input => {
    const response = await fetch(input.path, {
      method: input.method,
      credentials: 'same-origin',
      cache: 'no-store',
      ...(input.body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(input.body) }),
    });
    let payload = null;
    try { payload = await response.json(); } catch {}
    return { status: response.status, body: payload };
  }, { path, method, body });
}

async function refreshState(page) {
  return page.evaluate(async () => {
    await window._randori_auth?.refreshMe?.();
    await window._randori_availability?.refresh?.();
    return JSON.parse(JSON.stringify({
      user: window._randori_auth?.me || null,
      availability: window._randori_availability?.current || null,
    }));
  });
}

async function openTab(page, tab) {
  await tap(page, `[data-tab="${tab}"]`);
  await page.locator(`#view-${tab}`).waitFor({ state: 'visible', timeout: 10_000 });
}

async function openDashboard(page) {
  await page.evaluate(async () => { await window._randori_journey?.showDashboard?.(); });
  await page.locator('#view-dashboard').waitFor({ state: 'visible', timeout: 10_000 });
}

async function dismissTour(page) {
  await page.evaluate(() => { window._randori_onboard?.skip?.(); }).catch(() => {});
}

async function newLocalPage(browser, viewportName, timezoneId, getOrigin, { firstRun = false } = {}) {
  const context = await browser.newContext({ ...VIEWPORTS[viewportName], timezoneId, locale: 'en-GB' });
  // The loopback runtime is the only reachable origin.
  await context.route(/^https?:\/\//, route => {
    const target = new URL(route.request().url());
    return target.origin === getOrigin() ? route.continue() : route.abort('blockedbyclient');
  });
  if (!firstRun) {
    await context.addInitScript(() => {
      localStorage.setItem('randori-onboarded', '1');
      localStorage.setItem('randori-banner-dismissed', '1');
    });
  }
  return { context, page: await context.newPage() };
}

// Public landing and recovery pages rendered from the local runtime, so a
// branch's landing can be reviewed before it reaches production. The
// request-an-invite form is shown even when the runtime does not advertise
// the capability yet (screen names say so); its submission is answered
// locally with the contract's generic 202 and never reaches a database.
async function captureLocalPublic(browser, v, base, getOrigin, contexts, recorder) {
  const open = async ({ theme = 'dark', forceInviteRequests = false } = {}) => {
    const local = await newLocalPage(browser, v, 'Europe/London', getOrigin);
    contexts.push(local.context);
    await local.context.addInitScript(preferredTheme => {
      try { localStorage.setItem('randori-theme', preferredTheme); } catch {}
    }, theme);
    if (forceInviteRequests) {
      await local.page.route(/\/api\/auth\/capabilities(?:\?|$)/, async route => {
        const response = await route.fetch();
        const payload = await response.json().catch(() => null);
        if (payload?.capabilities) payload.capabilities.inviteRequests = true;
        await route.fulfill({ status: response.status(), json: payload });
      });
      await local.page.route(/\/api\/invite-requests(?:\?|$)/, route => route.fulfill({
        status: 202,
        json: { ok: true, message: 'Thanks — if the circle has room, you’ll get an invitation by email.' },
      }));
    }
    return local.page;
  };
  const visit = async (page, path) => {
    await page.goto(`${base}${path}`, { waitUntil: 'domcontentloaded' });
    await page.waitForLoadState('networkidle', { timeout: 10_000 }).catch(() => {});
    await sleep(600);
  };

  await recorder.step(`${v}:local-landing`, async () => {
    for (const theme of ['dark', 'light']) {
      const page = await open({ theme });
      await visit(page, '/');
      await recorder.shot(page, v, `local-landing${theme === 'light' ? '-light' : ''}`);
      if (theme === 'dark') {
        await recorder.shot(page, v, 'local-landing-above-fold', { fullPage: false });
        await tap(page, '#landingSignup');
        await recorder.shot(page, v, 'local-landing-invitation-help', { fullPage: false, settle: 300 });
      }
    }
  });
  await recorder.step(`${v}:local-landing-request-form`, async () => {
    for (const theme of ['dark', 'light']) {
      const page = await open({ theme, forceInviteRequests: true });
      await visit(page, '/');
      await recorder.shot(page, v, `local-landing-request-form${theme === 'light' ? '-light' : ''}`);
      if (theme !== 'dark') continue;
      await tap(page, '#landingRequestInvite');
      await tap(page, '#requestInviteSubmit');
      await recorder.shot(page, v, 'local-landing-request-validation', { fullPage: false, settle: 400 });
      await page.locator('#requestInviteName').fill('Ada Lovelace');
      await page.locator('#requestInviteEmail').fill('ada@example.test');
      await page.locator('#requestInviteNote').fill('Onsite loops in March: graphs and system design.');
      await tap(page, '#requestInviteSubmit');
      await page.getByTestId('request-invite-done').waitFor({ state: 'visible', timeout: 10_000 });
      await recorder.shot(page, v, 'local-landing-request-success', { fullPage: false, settle: 400 });
    }
  });
  await recorder.step(`${v}:local-recovery`, async () => {
    for (const theme of ['dark', 'light']) {
      const page = await open({ theme, forceInviteRequests: true });
      const suffix = theme === 'light' ? '-light' : '';
      for (const [path, name] of [['/invite', 'invite-no-token'], ['/verify', 'verify-no-token'], ['/reset-password', 'reset-password-no-token']]) {
        await visit(page, path);
        await recorder.shot(page, v, `local-${name}${suffix}`);
      }
    }
  });
}

async function captureLocal(browser, viewportName, recorder) {
  const v = viewportName;
  const rootDir = realpathSync(mkdtempSync(join(tmpdir(), 'randori-ui-screens-')));
  mkdirSync(join(rootDir, '.local'), { mode: 0o700 });
  copyFileSync(join(REPOSITORY_ROOT, 'index.html'), join(rootDir, 'index.html'));
  cpSync(join(REPOSITORY_ROOT, 'assets'), join(rootDir, 'assets'), { recursive: true });
  const config = resolveLocalServerConfig({
    rootDir,
    argv: [],
    env: {
      NODE_ENV: 'development',
      RANDORI_LOCAL_HOST: '127.0.0.1',
      RANDORI_LOCAL_PORT: '0',
      RANDORI_LOCAL_DATABASE_URL: pathToFileURL(join(rootDir, '.local', 'randori.sqlite')).href,
    },
  });
  let origin = null;
  const getOrigin = () => origin;
  const restoreFetch = installLocalExecutionTransport(getOrigin);
  let restoreTime = () => {};
  let runtime = null;
  const contexts = [];
  try {
    runtime = await startLocalDevelopmentServer({ config, logger: { log() {}, error() {} } });
    origin = new URL(runtime.url).origin;
    process.env.EXECUTION_PROVIDER = 'piston';
    process.env.EXECUTION_API_URL = EXECUTION_API_URL;
    const base = runtime.url;

    await captureLocalPublic(browser, v, base, getOrigin, contexts, recorder);

    // Owner is a returning user; the member experiences the real first run.
    const owner = await newLocalPage(browser, v, 'Europe/London', getOrigin);
    const member = await newLocalPage(browser, v, 'America/New_York', getOrigin, { firstRun: true });
    contexts.push(owner.context, member.context);
    const op = owner.page;
    const mp = member.page;

    await recorder.step(`${v}:owner-signin`, async () => {
      await op.goto(base, { waitUntil: 'domcontentloaded' });
      await tap(op, '#landingSignin');
      await waitForAuthDialog(op);
      await op.locator('#authEmail').fill(LOCAL_OWNER_EMAIL);
      await op.locator('#authPass').fill(LOCAL_OWNER_PASSWORD);
      await recorder.shot(op, v, 'app-signin-filled', { fullPage: false, settle: 200 });
      const login = responseOf(op, r => r.url() === `${base}/api/auth/login` && r.request().method() === 'POST');
      await tap(op, '#authSignin');
      const response = await login;
      if (response.status() !== 200) throw new Error(`owner login ${response.status()}`);
      await op.locator('#meLabel').waitFor({ state: 'visible' });
      await refreshState(op);
      await sleep(1500);
      await recorder.shot(op, v, 'app-owner-first-route');
    });

    await recorder.step(`${v}:owner-dashboard-empty`, async () => {
      await openDashboard(op);
      await sleep(1200);
      await recorder.shot(op, v, 'dashboard-owner-no-pairing');
    });

    await recorder.step(`${v}:account-menu`, async () => {
      await tap(op, '#meLabel');
      await op.locator('#meMenu').waitFor({ state: 'visible' });
      await recorder.shot(op, v, 'account-menu-open', { fullPage: false, settle: 300 });
      await op.keyboard.press('Escape');
    });

    await recorder.step(`${v}:circle-solo`, async () => {
      await openTab(op, 'circle');
      await sleep(900);
      await recorder.shot(op, v, 'circle-owner-before-invite');
    });

    let inviteUrl = null;
    await recorder.step(`${v}:circle-invite`, async () => {
      await op.getByTestId('circle-invite-email').fill(MEMBER_EMAIL);
      const created = responseOf(op, r => r.url() === `${base}/api/invitations` && r.request().method() === 'POST');
      await tap(op, op.getByTestId('circle-invite-create'));
      const response = await created;
      const payload = await response.json();
      if (response.status() !== 201) throw new Error(`invite ${response.status()}`);
      inviteUrl = new URL(String(payload.invitation?.invite_url || ''), base).href;
      await sleep(800);
      await recorder.shot(op, v, 'circle-invitation-created');
    });

    await recorder.step(`${v}:member-invite`, async () => {
      if (!inviteUrl) throw new Error('no invitation');
      await mp.goto(inviteUrl, { waitUntil: 'domcontentloaded' });
      await mp.getByTestId('invite-status').filter({ hasText: 'Invitation verified' }).waitFor({ timeout: 15_000 });
      await recorder.shot(mp, v, 'onboarding-1-invite-verified');
      await tap(mp, mp.getByTestId('invite-continue'));
      await waitForAuthDialog(mp);
      await recorder.shot(mp, v, 'onboarding-2-create-account', { fullPage: false });
      await mp.locator('#authEmail').fill(MEMBER_EMAIL);
      await mp.locator('#authName').fill(MEMBER_NAME);
      await mp.locator('#authPass').fill(MEMBER_PASSWORD);
      const signup = responseOf(mp, r => r.url() === `${base}/api/auth/signup` && r.request().method() === 'POST');
      await tap(mp, '#authSignup');
      const response = await signup;
      if (response.status() !== 200) throw new Error(`signup ${response.status()}`);
      await mp.locator('#meLabel').waitFor({ state: 'visible' });
      await sleep(1800);
      await recorder.shot(mp, v, 'onboarding-3-first-route-after-signup');
    });

    await recorder.step(`${v}:member-profile`, async () => {
      await dismissTour(mp);
      await mp.evaluate(async () => { await window._randori_journey?.showProfileSetup?.(); });
      await mp.locator('#view-profile-setup').waitFor({ state: 'visible' });
      await sleep(800);
      await recorder.shot(mp, v, 'onboarding-4-profile-setup');
      await mp.locator('#psBio').fill('Practising DSA and system design before onsite loops.');
      const saved = responseOf(mp, r => r.url().includes('/api/profile') && r.request().method() === 'POST');
      await tap(mp, '#psSave');
      await saved;
      await sleep(1500);
      await recorder.shot(mp, v, 'onboarding-5-after-profile-save');
    });

    await recorder.step(`${v}:member-tour`, async () => {
      await openDashboard(mp);
      await mp.evaluate(() => window._randori_onboard?.start?.(1));
      await mp.locator('#onboardOverlay.show').waitFor({ state: 'visible' });
      await recorder.shot(mp, v, 'onboarding-tour-step-1', { fullPage: false, settle: 400 });
      await tap(mp, '#onbNext');
      await tap(mp, '#onbNext');
      await tap(mp, '#onbNext');
      await sleep(500);
      await recorder.shot(mp, v, 'onboarding-tour-step-4', { fullPage: false, settle: 400 });
      await dismissTour(mp);
      await openDashboard(mp);
      await sleep(1200);
      await recorder.shot(mp, v, 'dashboard-member-first-run-checklist');
    });

    const optIn = async (page, label) => {
      await openTab(page, 'pair');
      await page.getByTestId('availability-card').waitFor({ state: 'visible' });
      await page.locator('#availAvailable').waitFor({ state: 'visible' });
      await page.waitForFunction(() => !document.getElementById('availAvailable')?.disabled, null, { timeout: 15_000 });
      await sleep(600);
      if (label) await recorder.shot(page, v, label);
      const state = await refreshState(page);
      // Same deterministic baseline as the e2e journey, through the real endpoint.
      await browserJson(page, '/api/settings/availability', 'POST', {
        cycle_key: state.availability?.cycleKey,
        expected_version: state.availability?.version,
        is_available: false,
      });
      await page.evaluate(async () => { await window._randori_availability?.refresh?.(); });
      await page.waitForFunction(() => !document.getElementById('availAvailable')?.disabled, null, { timeout: 15_000 });
      const saved = responseOf(page, r => r.url().includes('/api/settings/availability') && r.request().method() === 'POST');
      await tap(page, '#availAvailable');
      const response = await saved;
      const payload = await response.json();
      return payload.availability?.cycle || null;
    };

    let cycle = null;
    await recorder.step(`${v}:availability`, async () => {
      cycle = await optIn(mp, 'availability-member-unsaved');
      await sleep(700);
      await recorder.shot(mp, v, 'availability-member-saved');
      await optIn(op, null);
      await sleep(700);
      await recorder.shot(op, v, 'pairing-owner-before-publication');
    });

    await recorder.step(`${v}:publish`, async () => {
      if (!cycle?.startsAt) throw new Error('no cycle to publish');
      const instant = new Date(Date.parse(cycle.startsAt) + 30 * 60_000).toISOString();
      restoreTime = fixServerTime(instant);
      await browserJson(op, '/api/auth/login', 'POST', { email: LOCAL_OWNER_EMAIL, password: LOCAL_OWNER_PASSWORD });
      await browserJson(mp, '/api/auth/login', 'POST', { email: MEMBER_EMAIL, password: MEMBER_PASSWORD });
      await Promise.all([op.clock.setFixedTime(instant), mp.clock.setFixedTime(instant)]);
      await Promise.all([refreshState(op), refreshState(mp)]);
      await openTab(op, 'pair');
      await op.locator('#newWeekBtn').waitFor({ state: 'visible', timeout: 15_000 });
      const published = responseOf(op, r => r.url().endsWith('/api/pairing/run') && r.request().method() === 'POST');
      await tap(op, '#newWeekBtn');
      const response = await published;
      if (response.status() !== 200) throw new Error(`publish ${response.status()}`);
      await sleep(1200);
      await recorder.shot(op, v, 'pairing-owner-published');
    });

    const roomOf = page => page.evaluate(() => window._randori_schedule?.room || null);
    let room = null;
    await recorder.step(`${v}:dashboard-paired`, async () => {
      await Promise.all([openDashboard(op), openDashboard(mp)]);
      await op.waitForFunction(() => /^week_\d+_pair_\d+$/.test(String(window._randori_schedule?.room || '')), null, { timeout: 15_000 });
      room = await roomOf(op);
      await sleep(1000);
      await recorder.shot(op, v, 'dashboard-paired-schedule-empty');
    });

    await recorder.step(`${v}:schedule`, async () => {
      const value = await op.evaluate(() => {
        const at = new Date(Date.now() + 36 * 60 * 60_000);
        at.setMinutes(0);
        const pad = n => String(n).padStart(2, '0');
        return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}T${pad(at.getHours())}:${pad(at.getMinutes())}`;
      });
      await op.getByTestId('schedule-input').fill(value);
      await tap(op, op.getByTestId('schedule-propose'));
      await op.waitForFunction(() => (window._randori_schedule?.schedule?.proposals || []).length === 1, null, { timeout: 15_000 });
      await sleep(600);
      await recorder.shot(op, v, 'schedule-proposal-sent');
      await openDashboard(mp);
      await mp.waitForFunction(() => (window._randori_schedule?.schedule?.proposals || []).length === 1, null, { timeout: 15_000 });
      await sleep(600);
      await recorder.shot(mp, v, 'schedule-proposal-received');
      await tap(mp, mp.getByTestId('schedule-accept'));
      await mp.waitForFunction(() => Boolean(window._randori_schedule?.schedule?.agreed_time), null, { timeout: 15_000 });
      await sleep(600);
      await recorder.shot(mp, v, 'schedule-agreed');
    });

    await recorder.step(`${v}:chat`, async () => {
      if (!room) throw new Error('no room');
      await browserJson(op, '/api/messages', 'POST', { room_id: room, message: 'I will drive the first implementation.' });
      await browserJson(mp, '/api/messages', 'POST', { room_id: room, message: 'Great, I will navigate and review edge cases.' });
      await browserJson(op, '/api/messages', 'POST', { room_id: room, message: 'Shall we start with the focus block rollup exercise?' });
      for (const page of [op, mp]) await page.evaluate(async () => { await window._randori_chat?.refresh?.(); });
      await sleep(800);
      await recorder.shot(op, v, 'dashboard-paired-with-chat');
      const chat = op.locator('#dashChatArea');
      if (await chat.isVisible()) {
        await chat.scrollIntoViewIfNeeded();
        await recorder.shot(op, v, 'chat-viewport', { fullPage: false, settle: 300 });
      }
    });

    await recorder.step(`${v}:workspace`, async () => {
      if (!room) throw new Error('no room');
      const code = `function rollUpFocusBlocks(blocks) {
  const result = [];
  for (const block of blocks) {
    const previous = result.at(-1);
    if (previous && previous.label === block.label) previous.minutes += block.minutes;
    else result.push({ label: block.label, minutes: block.minutes });
  }
  return result;
}`;
      const board = { shapes: [
        { id: 'session-plan', type: 'rect', x: 40, y: 50, w: 180, h: 90, color: '#c8f6a0' },
        { id: 'review-note', type: 'sticky', x: 260, y: 50, w: 180, h: 110, text: 'Review edge cases', bg: '#fff2a8' },
      ] };
      const path = `/api/video/signal?channel=workspace&room_id=${encodeURIComponent(room)}&after_revision=0`;
      const write = revision => browserJson(op, '/api/video/signal', 'POST', {
        room_id: room,
        type: 'code-sync',
        payload: {
          schema_version: 3, base_revision: revision, client_id: 'ui-screenshots', client_seq: revision + 1,
          code, language: 'javascript', question_id: 'focus-block-rollup', question_version: 1, board,
        },
      });
      const current = await browserJson(op, path);
      let result = await write(Number(current.body?.revision || 0));
      if (result.status === 409) result = await write(Number(result.body?.current?.revision || 0));
      if (result.status !== 200) throw new Error(`workspace write ${result.status}`);
      await op.goto(`${base}/join/${room}`, { waitUntil: 'domcontentloaded' });
      await op.locator('#view-code').waitFor({ state: 'visible', timeout: 15_000 });
      await op.waitForFunction(() => window._randori_workspace?.hydrated === true, null, { timeout: 15_000 });
      await sleep(1200);
      await recorder.shot(op, v, 'workspace-editor');
      await recorder.shot(op, v, 'workspace-editor-viewport', { fullPage: false });
    });

    // WP-R: the room shows one panel at a time on phones and a tabbed side
    // panel beside the editor on desktop. Capture each panel in the viewport.
    await recorder.step(`${v}:workspace-panels`, async () => {
      for (const panel of ['problem', 'session', 'notes']) {
        await op.evaluate(name => window._randori_room?.show?.(name), panel);
        await recorder.shot(op, v, `workspace-${panel}`, { fullPage: false, settle: 300 });
      }
      await op.evaluate(() => window._randori_room?.show?.('code'));
    });

    await recorder.step(`${v}:workspace-run`, async () => {
      const executed = responseOf(op, r => r.url().endsWith('/api/execute') && r.request().method() === 'POST');
      await tap(op, '#runBtn');
      await executed;
      await sleep(2500);
      await recorder.shot(op, v, 'workspace-after-run');
      const out = op.locator('#runOut');
      if (await out.isVisible()) {
        await out.scrollIntoViewIfNeeded();
        await recorder.shot(op, v, 'workspace-run-results-viewport', { fullPage: false, settle: 300 });
      }
    });

    await recorder.step(`${v}:whiteboard`, async () => {
      await openTab(op, 'board');
      await sleep(1200);
      await recorder.shot(op, v, 'workspace-whiteboard');
    });

    await recorder.step(`${v}:light-theme`, async () => {
      await openTab(op, 'code');
      await tap(op, '#themeToggle');
      await sleep(500);
      await recorder.shot(op, v, 'workspace-editor-light');
      await openDashboard(op);
      await sleep(1000);
      await recorder.shot(op, v, 'dashboard-paired-light');
      await openTab(op, 'pair');
      await sleep(1000);
      await recorder.shot(op, v, 'pairing-owner-published-light');
      await tap(op, '#themeToggle');
    });

    await recorder.step(`${v}:catalogue`, async () => {
      await openTab(mp, 'code');
      // The catalogue lives in the room's Problem panel (WP-R).
      await mp.evaluate(() => window._randori_room?.show?.('problem'));
      await mp.getByTestId('catalog-status').filter({ hasNotText: 'Loading' }).waitFor({ timeout: 15_000 }).catch(() => {});
      await sleep(1000);
      await recorder.shot(mp, v, 'catalogue-browse');
      await mp.getByTestId('catalog-search').fill('zzzz-no-such-exercise');
      await sleep(600);
      await recorder.shot(mp, v, 'catalogue-empty-filter');
      await mp.getByTestId('catalog-search').fill('');
    });

    await recorder.step(`${v}:history`, async () => {
      await openTab(op, 'history');
      await sleep(1500);
      await recorder.shot(op, v, 'history');
      const recap = op.locator('#historyPersonal button, #historyList button').first();
      if (await recap.count()) {
        await recap.click().catch(() => {});
        await sleep(1500);
        await recorder.shot(op, v, 'history-recap');
      }
    });

    await recorder.step(`${v}:circle-two-members`, async () => {
      await openTab(op, 'circle');
      await sleep(1000);
      await recorder.shot(op, v, 'circle-owner-two-members');
      await openTab(mp, 'circle');
      await sleep(1000);
      await recorder.shot(mp, v, 'circle-member-view');
    });

    // WP-C: light theme for the circle and history surfaces.
    await recorder.step(`${v}:circle-history-light`, async () => {
      await tap(op, '#themeToggle');
      await openTab(op, 'circle');
      await sleep(1000);
      await recorder.shot(op, v, 'circle-owner-light');
      await openTab(op, 'history');
      await sleep(1500);
      const recap = op.locator('#historyPersonal button').first();
      if (await recap.count()) {
        await recap.click().catch(() => {});
        await sleep(1500);
      }
      await recorder.shot(op, v, 'history-recap-light');
      await tap(op, '#themeToggle');
    });

    // WP-C: owner "Invite requests" panel. The WP-L2 API is mocked in the
    // browser (capability plus a pending list) until that backend ships.
    await recorder.step(`${v}:circle-invite-requests-mocked`, async () => {
      const now = Date.now();
      await op.route('**/api/auth/capabilities', async route => {
        const response = await route.fetch();
        const body = await response.json();
        body.capabilities = { ...(body.capabilities || {}), inviteRequests: true };
        await route.fulfill({ response, json: body });
      });
      await op.route('**/api/invite-requests**', route => route.fulfill({ json: {
        ok: true, status: 'pending', pending_count: 2, next_cursor: null,
        requests: [
          { id: '0f8fad5b-d9cb-469f-a165-70867728950e', name: 'Ada Lovelace', email: 'ada@example.com',
            note: 'Preparing for system design loops in November.',
            created_at: new Date(now - 2 * 86_400_000).toISOString(), expires_at: new Date(now + 28 * 86_400_000).toISOString() },
          { id: '7c9e6679-7425-40de-944b-e07fc1f90ae7', name: 'Grace Hopper', email: 'grace@example.com', note: null,
            created_at: new Date(now - 3_600_000).toISOString(), expires_at: new Date(now + 30 * 86_400_000).toISOString() },
        ],
      } }));
      await op.reload({ waitUntil: 'domcontentloaded' });
      await openTab(op, 'circle');
      await op.getByTestId('circle-invite-requests').waitFor({ state: 'visible', timeout: 10_000 }).catch(() => {});
      await sleep(800);
      await recorder.shot(op, v, 'circle-owner-invite-requests');
      await op.unroute('**/api/invite-requests**');
      await op.unroute('**/api/auth/capabilities');
      await op.reload({ waitUntil: 'domcontentloaded' });
    });

    await recorder.step(`${v}:account-security`, async () => {
      await openDashboard(op);
      await tap(op, '#meLabel');
      const identity = op.locator('#meIdentity');
      await identity.waitFor({ state: 'visible', timeout: 8_000 });
      await tap(op, identity);
      await op.locator('#identityOverlay.show').waitFor({ state: 'visible', timeout: 10_000 });
      await sleep(1200);
      await recorder.shot(op, v, 'account-security-dialog', { fullPage: false });
      await op.locator('#identityClose').click().catch(() => {});
    });

    // Loading and error states: same signed-in owner, with data APIs held or
    // failed in the browser only. Authentication stays real.
    await recorder.step(`${v}:loading-state`, async () => {
      const page = await owner.context.newPage();
      await page.route(/\/api\/(?!auth\/)/, () => {});
      await page.goto(base, { waitUntil: 'domcontentloaded' });
      await sleep(3000);
      await recorder.shot(page, v, 'state-dashboard-loading', { settle: 0 });
      await page.close();
    });
    await recorder.step(`${v}:error-state`, async () => {
      const page = await owner.context.newPage();
      await page.route(/\/api\/(?!auth\/)/, route => route.fulfill({
        status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'service unavailable' }),
      }));
      await page.goto(base, { waitUntil: 'domcontentloaded' });
      await sleep(4000);
      await recorder.shot(page, v, 'state-api-unavailable');
      await openTab(page, 'pair').catch(() => {});
      await sleep(1500);
      await recorder.shot(page, v, 'state-pairing-api-unavailable');
      await page.close();
    });
    await recorder.step(`${v}:offline-state`, async () => {
      const page = await member.context.newPage();
      await page.goto(base, { waitUntil: 'domcontentloaded' });
      await sleep(2000);
      await member.context.setOffline(true);
      await openTab(page, 'pair').catch(() => {});
      await page.evaluate(async () => { try { await window._randori_availability?.refresh?.(); } catch {} });
      await sleep(2000);
      await recorder.shot(page, v, 'state-offline-pairing');
      await member.context.setOffline(false);
      await page.close();
    });
    await recorder.step(`${v}:anonymous-local-landing`, async () => {
      const anon = await newLocalPage(browser, v, 'Europe/London', getOrigin, { firstRun: true });
      contexts.push(anon.context);
      await anon.page.goto(`${base}/join/${room || 'week_1_pair_1'}`, { waitUntil: 'domcontentloaded' });
      await sleep(1500);
      await recorder.shot(anon.page, v, 'deep-link-join-signed-out', { fullPage: false });
    });
  } finally {
    for (const context of contexts) await context.close().catch(() => {});
    restoreTime();
    restoreFetch();
    await runtime?.close().catch(() => {});
    rmSync(rootDir, { recursive: true, force: true });
  }
}

export async function main(env = process.env) {
  const options = parseOptions(env);
  const recorder = new Recorder(options.outDir);
  const browser = await chromium.launch({ args: [`--host-resolver-rules=${TELEMETRY_RESOLVER_RULES}`] });
  try {
    for (const viewport of options.viewports) {
      if (options.scope !== 'local') {
        await recorder.step(`${viewport}:public`, () => capturePublic(browser, viewport, options.prodOrigin, recorder));
      }
      if (options.scope !== 'public') {
        await recorder.step(`${viewport}:local`, () => captureLocal(browser, viewport, recorder));
      }
    }
  } finally {
    await browser.close();
    recorder.write({ prod_origin: options.prodOrigin, scope: options.scope, viewports: options.viewports });
  }
  process.stdout.write(`${recorder.shots.length} screenshots, ${recorder.failures.length} failed steps, `
    + `${recorder.blocked.length} blocked non-GET requests\n`);
  return recorder;
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  process.on('unhandledRejection', error => {
    process.stdout.write(`unhandled rejection: ${String(error?.message || error).split('\n')[0]}\n`);
  });
  main().catch(error => {
    process.stderr.write(`${String(error?.stack || error)}\n`);
    process.exitCode = 1;
  });
}
