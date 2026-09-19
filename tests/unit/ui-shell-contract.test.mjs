import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const html = await readFile(new URL('../../index.html', import.meta.url), 'utf8');

test('light and dark themes define and consume semantic status and control tokens', () => {
  for (const token of ['ok', 'warn', 'bad', 'info', 'focus', 'control-border', 'ok-surface', 'warn-surface', 'bad-surface', 'info-surface']) {
    assert.ok([...html.matchAll(new RegExp(`--${token}:`, 'g'))].length >= 2, `both themes define --${token}`);
  }
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
});

test('visible shell copy does not promise unsupported integrations or deployment actions', () => {
  assert.doesNotMatch(html, /id="copyLinkBtn"/);
  assert.doesNotMatch(html, /id="vidScreenBtn"/);
  assert.doesNotMatch(html, /Email \+ SMS when paired|Email \/ SMS reminder/);
  assert.doesNotMatch(html, /sms_enabled|id="psRemindSms"|id="remindPhone"/);
  assert.doesNotMatch(html, /AI fills odd/);
  assert.doesNotMatch(html, /Join 50\+ mock interviewers|What people say|Works offline, calls Groq/);
  assert.match(html, /Approved original exercise catalogue/);
  assert.match(html, /authorization-gated/);
  assert.match(html, /Copy session link/);
});
