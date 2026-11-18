import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  BYTE_BUDGET_THRESHOLDS,
  inspectByteBudget,
  measureByteBudget,
} from '../../scripts/check-byte-budget.mjs';

const SCRIPT = fileURLToPath(new URL('../../scripts/check-byte-budget.mjs', import.meta.url));
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

function fixture(files) {
  const root = mkdtempSync(join(tmpdir(), 'byte-budget-'));
  for (const [relative, content] of Object.entries(files)) {
    const path = join(root, relative);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content);
  }
  return root;
}

function minimalIndex({ style = 'a{color:red}', script = 'x();', extra = '' } = {}) {
  return `<!doctype html><html><head><style>${style}</style>`
    + `<link rel="stylesheet" href="/assets/a.css"/>`
    + `</head><body><script>${script}</script>`
    + `<script src="/assets/a.js"></script>${extra}</body></html>`;
}

test('the current tree passes the adopted #412 thresholds', () => {
  assert.deepEqual(inspectByteBudget(REPO_ROOT), []);
  const { measurement } = measureByteBudget(REPO_ROOT);
  assert.ok(measurement.indexHtml > 0);
  assert.ok(measurement.indexHtml <= BYTE_BUDGET_THRESHOLDS.indexHtml);
  assert.ok(measurement.cssInitial <= BYTE_BUDGET_THRESHOLDS.cssInitial);
  assert.ok(measurement.cssTotal <= BYTE_BUDGET_THRESHOLDS.cssTotal);
  assert.ok(measurement.jsInitial <= BYTE_BUDGET_THRESHOLDS.jsInitial);
  assert.ok(measurement.jsTotal <= BYTE_BUDGET_THRESHOLDS.jsTotal);
  assert.deepEqual(measurement.linkedStylesheets, ['assets/circle-history.css']);
  assert.equal(measurement.assetJsFiles, 35); // 31 .js files (incl. the lazy execution-busy retry controller, #468) plus the four served .mjs modules: realtime relay/yjs (ID-96, ID-101) and presence/presence-ui (ID-100).
  // Rebasing onto 929cad6 moved the comparison to 998,173 -> 954,051 bytes.
  // Preserve the structural boundary and at least 40 KB of deliberate initial
  // headroom. Update this regression guard deliberately, not to mask growth.
  assert.ok(measurement.jsInitial <= 960_000, 'ID-101 initial-JS headroom guard');
  for (const optional of ['landing', 'bulk-invite', 'calendar-export', 'email-validation']) {
    assert.ok(!measurement.scriptSrcs.includes(`assets/${optional}.js`));
  }
  assert.equal(measurement.assetCssFiles, 3);
});

test('slices separate initial-load from totals and ignore external references', () => {
  const root = fixture({
    'index.html': minimalIndex({ extra: '<script src="https://example.invalid/x.js"></script><link rel="stylesheet" href="https://example.invalid/x.css"/>' }),
    'assets/a.js': 'a'.repeat(10),
    'assets/a.css': 'b'.repeat(20),
    'assets/lazy.js': 'c'.repeat(100),
    'assets/legal.css': 'd'.repeat(50),
  });
  try {
    const { measurement } = measureByteBudget(root);
    // inline style + linked a.css only; legal.css is total-only.
    assert.equal(measurement.cssInitial, 'a{color:red}'.length + 20);
    assert.equal(measurement.cssTotal, 'a{color:red}'.length + 20 + 50);
    // inline script + src a.js only; lazy.js is total-only; external ignored.
    assert.equal(measurement.jsInitial, 'x();'.length + 10);
    assert.equal(measurement.jsTotal, 'x();'.length + 10 + 100);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('thresholds stay fixed and total accounting only tightens for .mjs (ID-101)', () => {
  assert.deepEqual(BYTE_BUDGET_THRESHOLDS, {
    indexHtml: 1_000_000, cssInitial: 130_000, cssTotal: 135_000,
    jsInitial: 1_000_000, jsTotal: 1_450_000,
  });
  const root = fixture({
    'index.html': minimalIndex({ extra: '<script type="module" src="/assets/initial.mjs"></script>' }),
    'assets/a.js': 'a'.repeat(10),
    'assets/a.css': '',
    'assets/initial.mjs': 'm'.repeat(20),
    'assets/lazy.mjs': 'l'.repeat(30),
    'assets/crdt-editor-source.js': 's'.repeat(40),
  });
  try {
    const { measurement } = measureByteBudget(root);
    assert.equal(measurement.jsInitial, 4 + 10 + 20);
    assert.equal(measurement.jsTotal, 4 + 10 + 20 + 30 + 40);
    assert.equal(measurement.assetJsFiles, 4);
    writeFileSync(join(root, 'assets/lazy.mjs'), 'x'.repeat(BYTE_BUDGET_THRESHOLDS.jsTotal));
    assert.ok(inspectByteBudget(root).some(e => /JS total byte budget exceeded/.test(e)));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('an over-budget slice, a missing linked asset, and a missing index fail closed', () => {
  const over = fixture({
    'index.html': minimalIndex({ style: 'x'.repeat(BYTE_BUDGET_THRESHOLDS.cssInitial + 1) }),
    'assets/a.js': '',
    'assets/a.css': '',
  });
  try {
    assert.ok(inspectByteBudget(over).some((e) => /CSS initial-load byte budget exceeded/.test(e)));
  } finally { rmSync(over, { recursive: true, force: true }); }

  const missingAsset = fixture({
    'index.html': minimalIndex(),
    'assets/a.css': '',
  });
  try {
    assert.ok(inspectByteBudget(missingAsset).some((e) => /referenced file is missing: assets\/a\.js/.test(e)));
  } finally { rmSync(missingAsset, { recursive: true, force: true }); }

  const missingIndex = fixture({ 'assets/a.js': '', 'assets/a.css': '' });
  try {
    assert.ok(inspectByteBudget(missingIndex).some((e) => /index\.html is missing/.test(e)));
  } finally { rmSync(missingIndex, { recursive: true, force: true }); }
});

test('the CLI is offline, mutation-free, and reports JSON', () => {
  const result = spawnSync(process.execPath, [SCRIPT], { encoding: 'utf8', cwd: REPO_ROOT });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.gate, 'byte-budget');
  assert.equal(parsed.externalMutation, false);
  assert.ok(parsed.measurement.indexHtml > 0);
});
