import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const html = await readFile(new URL('../../index.html', import.meta.url), 'utf8');

test('light and dark themes define and consume semantic status and control tokens', () => {
  const darkTheme = html.match(/:root\{([\s\S]*?)\}/)?.[1];
  const lightTheme = html.match(/:root\.light\{([\s\S]*?)\}/)?.[1];
  assert.ok(darkTheme, 'dark theme exists');
  assert.ok(lightTheme, 'light theme exists');
  for (const token of [
    'color-canvas', 'color-surface', 'color-surface-raised', 'color-control-border',
    'color-text', 'color-text-secondary', 'color-text-muted', 'color-success',
    'color-warning', 'color-danger', 'color-info', 'color-focus',
    'color-success-surface', 'color-warning-surface', 'color-danger-surface', 'color-info-surface',
  ]) {
    for (const [theme, declarations] of [['dark', darkTheme], ['light', lightTheme]]) {
      assert.equal(
        [...declarations.matchAll(new RegExp(`--${token}:`, 'g'))].length,
        1,
        `${theme} theme defines --${token} exactly once`,
      );
    }
  }
  assert.match(html, /--bad:var\(--color-danger\)/);
  assert.match(html, /--ink-3:var\(--color-text-muted\)/);
  assert.doesNotMatch(html, /var\(--muted\)/);
  assert.match(html, /\.status-chip\.status-success\{[^}]+var\(--ok-surface\)[^}]+var\(--ok\)/);
  assert.match(html, /\.status-chip\.status-warning\{[^}]+var\(--warn-surface\)[^}]+var\(--warn\)/);
  assert.match(html, /\.status-chip\.status-danger\{[^}]+var\(--bad-surface\)[^}]+var\(--bad\)/);
  assert.match(html, /class="kbd status-chip log-badge/);
  assert.match(html, /class="kbd status-chip status-success"/);
  assert.match(html, /\.input,\.textarea,\.select\{[^}]+var\(--control-border\)/);
});

test('shell markup exposes landmarks, focus controls, and live state semantics', () => {
  assert.match(html, /class="skip-link" href="#appMain"/);
  assert.match(html, /<header class="topbar">/);
  assert.match(html, /<nav aria-label="Primary navigation">\s*<div class="tabs" role="group" aria-label="Application views">/);
  assert.match(html, /<main id="appMain" class="main" tabindex="-1">/);
  assert.match(html, /id="meLabel"[^>]+aria-haspopup="menu"[^>]+aria-expanded="false"/);
  assert.match(html, /id="meMenu" role="menu"/);
  assert.match(html, /id="meIdentity" role="menuitem"[^>]+>Account security</);
  assert.match(html, /id="landingNextBar" role="progressbar"[^>]+aria-valuenow="0"/);
  assert.match(html, /id="circleContextPanel" data-state="hidden"/);
  assert.match(html, /id="circleContextRetry"[^>]+hidden/);
  assert.match(html, /class="motion-probe" aria-hidden="true"/);
  assert.match(html, /@media\(prefers-reduced-motion:reduce\)/);
  assert.match(html, /@media\(max-width:520px\)/);
  assert.match(html, /@media\(max-width:640px\)/);
  assert.match(html, /@media\(pointer:coarse\)/);
  assert.match(html, /@media\(forced-colors:active\)/);
  for (const view of ['circle', 'pair', 'code', 'board', 'history']) {
    assert.match(html, new RegExp(`id="tab-${view}"[^>]+aria-controls="view-${view}"`));
    assert.match(html, new RegExp(`id="view-${view}"[^>]+aria-labelledby="tab-${view}"`));
  }
});

test('visible shell copy does not promise unsupported integrations or deployment actions', () => {
  assert.doesNotMatch(html, /id="copyLinkBtn"/);
  assert.doesNotMatch(html, /id="vidScreenBtn"/);
  assert.doesNotMatch(html, /Email \+ SMS when paired|Email \/ SMS reminder/);
  assert.doesNotMatch(html, /Circle Pulse • live|● synced|>✉ Email reminder</);
  assert.doesNotMatch(html, /sms_enabled|id="psRemindSms"|id="remindPhone"/);
  assert.doesNotMatch(html, /AI fills odd/);
  assert.doesNotMatch(html, /Join 50\+ mock interviewers|What people say|Works offline, calls Groq/);
  assert.match(html, /Approved original exercise catalogue/);
  assert.match(html, /authorization-gated/);
  assert.match(html, /Copy session link/);
  assert.match(html, /id="landingStats"[^>]+data-state="loading"[^>]+aria-busy="true"/);
  assert.match(html, /id="psRemindStatus"[^>]+data-state="loading"[^>]+role="status"/);
  assert.match(html, /id="syncStatus"[^>]+data-state="loading"[^>]+role="status"/);
  assert.match(html, /setUiRequestState\(host,status,state,message\)/);
});

test('accessibility tooling is exact-pinned and preserves incomplete review evidence', async () => {
  const packageJson = JSON.parse(await readFile(new URL('../../package.json', import.meta.url), 'utf8'));
  const spec = await readFile(new URL('../e2e/ui-shell-accessibility.spec.ts', import.meta.url), 'utf8');
  assert.equal(packageJson.devDependencies['@axe-core/playwright'], '4.13.0');
  assert.match(spec, /\.withTags\(\['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'\]\)/);
  assert.match(spec, /results\.incomplete/);
  assert.match(spec, /expect\(results\.violations[^\n]+\.toEqual\(\[\]\)/);
  assert.doesNotMatch(spec, /\.exclude\(/);
});
