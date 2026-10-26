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
  // WP-Z (#400): the 31 legacy aliases are gone — no alias definition and
  // no alias var() use may come back — and the six proven-dead canonicals
  // (--ease-in-out, --space-0, --space-16, --z-banner, --z-base,
  // --z-overlay) stay deleted. Canonical tokens only.
  for (const alias of [
    'bg', 'bg-2', 'bg-3', 'bg-4', 'card', 'card-2', 'border', 'control-border',
    'line', 'line-strong', 'ink', 'ink-2', 'ink-3', 'accent', 'accent-2',
    'accent-3', 'accent-4', 'ok', 'warn', 'bad', 'info', 'focus',
    'ok-surface', 'warn-surface', 'bad-surface', 'info-surface', 'radius',
    'shadow', 'shadow-soft', 'max', 'gap',
  ]) {
    assert.doesNotMatch(html, new RegExp(`--${alias}:`), `--${alias} must not be defined`);
    assert.doesNotMatch(html, new RegExp(`var\\(--${alias}[\\s,)]`), `--${alias} must not be used`);
  }
  for (const dead of ['ease-in-out', 'space-0', 'space-16', 'z-banner', 'z-base', 'z-overlay']) {
    assert.doesNotMatch(html, new RegExp(`--${dead}:`), `--${dead} must stay deleted`);
  }
  assert.doesNotMatch(html, /var\(--muted\)/);
  assert.match(html, /\.status-chip\.status-success\{[^}]+var\(--color-success-surface\)[^}]+var\(--color-success\)/);
  assert.match(html, /\.status-chip\.status-warning\{[^}]+var\(--color-warning-surface\)[^}]+var\(--color-warning\)/);
  assert.match(html, /\.status-chip\.status-danger\{[^}]+var\(--color-danger-surface\)[^}]+var\(--color-danger\)/);
  assert.match(html, /class="kbd status-chip log-badge/);
  assert.match(html, /class="kbd status-chip status-success"/);
  assert.match(html, /\.input,\.textarea,\.select\{[^}]+var\(--color-control-border\)/);
});

test('shell markup exposes landmarks, focus controls, and live state semantics', () => {
  assert.match(html, /class="skip-link" href="#appMain"/);
  assert.match(html, /<header class="topbar">/);
  assert.match(html, /<nav aria-label="Primary navigation">\s*<div class="tabs" role="group" aria-label="Application views">/);
  assert.match(html, /<main id="appMain" class="main" tabindex="-1">/);
  assert.match(html, /id="meLabel"[^>]+aria-haspopup="menu"[^>]+aria-expanded="false"/);
  assert.match(html, /id="meMenu" role="menu"/);
  assert.match(html, /id="meIdentity" role="menuitem"[^>]+>Account security</);
  assert.match(html, /<section id="view-landing" class="view" aria-labelledby="landingTitle"/);
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
  assert.match(html, /Original Randori exercises/);
  assert.doesNotMatch(html, /authorization-gated|id="landingStats"|id="landingNextBar"/);
  assert.match(html, /Copy session link/);
  assert.match(html, /id="psRemindStatus"[^>]+data-state="loading"[^>]+role="status"/);
  assert.match(html, /id="syncStatus"[^>]+data-state="loading"[^>]+role="status"/);
  assert.match(html, /setUiRequestState\(host,status,state,message\)/);
});

test('user-visible copy has no implementation jargon (final cleanup)', () => {
  for (const phrase of [
    /evaluated by the server execution gateway/, /authenticated server runner/, /server AI\./,
    /explicit, fresh provider confirmation/, /verified control of the linked Google account/,
    /provider readiness/, /next honest action/, /odd-member assignment/, /Open Solo Catalogue/,
    /Authorized pairing room/,
    /No verified current pairing room/, /authoritative current-cycle schedule/,
    /private server history/, /try Pairings & activity/, /legacy \/ unverified/,
    /calls today/, /AI ready \$\{model\}/, /Get AI Feedback/, /embedded credentials/,
    /HTTPS meeting URL/, /That Google identity/, /are no longer authorized/,
  ]) assert.doesNotMatch(html, phrase);
  // Raw pair room ids and cycle keys are replaced by labels.
  assert.doesNotMatch(html, /`room \$\{room\.slice/);
  assert.doesNotMatch(html, /\$\{recap\.pair\.week_label\} recap/);
  assert.match(html, /circleUi\.pairingWeekLabel\(recap\.pair\)/);
  // Model routing, cost and quota details are admin-only.
  assert.match(html, /function aiDebugPanel\(\)\{[\s\S]{0,200}window\._randori_logs\?\.isAdmin/);
  assert.match(html, /const dbgEl=aiDebugPanel\(\);/);
});

test('empty-state titles use the body text token and only the leading icon is muted', () => {
  assert.match(html, /\.rc-empty-title\{[^}]*color:var\(--color-text\)/);
  assert.match(html, /\.rc-empty > \.rc-icon:first-child\{color:var\(--color-text-muted\)\}/);
  assert.doesNotMatch(html, /\.rc-empty > :first-child\{/);
  assert.match(html, /id="catalogEmptyTitle" class="[^"]*\brc-empty-title\b/);
  // The #0f0f10 inline-color shim is gone because no inline style uses it.
  assert.doesNotMatch(html, /#0f0f10/i);
  assert.doesNotMatch(html, /font-family:ui-monospace, monospace/);
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
