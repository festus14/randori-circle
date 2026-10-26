import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  checkThemeToggleAxeSource,
  collectSpecFiles,
  inspectThemeToggleAxeGuard,
} from '../../scripts/check-theme-toggle-axe.mjs';

const SCRIPT = fileURLToPath(new URL('../../scripts/check-theme-toggle-axe.mjs', import.meta.url));
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

const HEAD = [
  "import { expect, test } from '@playwright/test';",
  "import AxeBuilder from '@axe-core/playwright';",
  "import { waitForThemeSettled } from './golden-theme-settle';",
  '',
].join('\n');

const AXE = 'const results = await new AxeBuilder({ page }).analyze();';
const SETTLE = "await waitForThemeSettled(page, '#view-landing', true);";
const TOGGLE = "await page.locator('#themeToggle').click();";

function spec(body) {
  return `${HEAD}${body}\n`;
}

function assertFails(source, { count = 1, match = /without an intervening waitForThemeSettled/ } = {}) {
  const violations = checkThemeToggleAxeSource(source, 'fixture.spec.ts');
  assert.equal(violations.length, count, JSON.stringify(violations));
  for (const violation of violations) assert.match(violation, match);
  return violations;
}

function assertPasses(source) {
  assert.deepEqual(checkThemeToggleAxeSource(source, 'fixture.spec.ts'), []);
}

test('a direct toggle -> axe without settle fails, with settle passes', () => {
  assertFails(spec([
    "test('theme axe race', async ({ page }) => {",
    `  ${TOGGLE}`,
    `  ${AXE}`,
    '});',
  ].join('\n')), { match: /fixture\.spec\.ts:5 test "theme axe race": theme toggle at line 5 reaches axe at line 6 / });
  assertPasses(spec([
    "test('theme axe settled', async ({ page }) => {",
    `  ${TOGGLE}`,
    `  ${SETTLE}`,
    `  ${AXE}`,
    '});',
  ].join('\n')));
});

test('a settle before the toggle, or after the axe, does not count', () => {
  assertFails(spec([
    "test('settle too early', async ({ page }) => {",
    `  ${SETTLE}`,
    `  ${TOGGLE}`,
    `  ${AXE}`,
    '});',
  ].join('\n')));
  assertFails(spec([
    "test('settle too late', async ({ page }) => {",
    `  ${TOGGLE}`,
    `  ${AXE}`,
    `  ${SETTLE}`,
    '});',
  ].join('\n')));
});

test('two toggles with only one settle fail (AC fixture)', () => {
  const violations = assertFails(spec([
    "test('two toggles, one settle', async ({ page }) => {",
    `  ${TOGGLE}`,
    `  ${SETTLE}`,
    `  ${AXE}`,
    `  ${TOGGLE}`,
    `  ${AXE}`,
    '});',
  ].join('\n')));
  assert.match(violations[0], /theme toggle at line 8 reaches axe at line 9/);
});

test('one settle after two toggles covers both toggles', () => {
  assertPasses(spec([
    "test('two toggles, one settle after both', async ({ page }) => {",
    `  ${TOGGLE}`,
    `  ${TOGGLE}`,
    `  ${SETTLE}`,
    `  ${AXE}`,
    '});',
  ].join('\n')));
});

test('a toggle with no axe, and axe with no toggle, do not flag', () => {
  assertPasses(spec([
    "test('toggle only', async ({ page }) => {",
    `  ${TOGGLE}`,
    '});',
  ].join('\n')));
  assertPasses(spec([
    "test('axe only', async ({ page }) => {",
    `  ${AXE}`,
    '});',
  ].join('\n')));
  assertPasses(spec([
    "test('axe before toggle', async ({ page }) => {",
    `  ${AXE}`,
    `  ${TOGGLE}`,
    '});',
  ].join('\n')));
});

test('a toggle in one test and axe in another test do not flag (per-test scoping)', () => {
  assertPasses(spec([
    "test('toggle here', async ({ page }) => {",
    `  ${TOGGLE}`,
    '});',
    "test('axe there', async ({ page }) => {",
    `  ${AXE}`,
    '});',
  ].join('\n')));
});

test('an aliased toggle counts, including alias chains and reassignment', () => {
  assertFails(spec([
    "test('aliased toggle', async ({ page }) => {",
    "  const toggle = page.locator('#themeToggle');",
    '  await toggle.click();',
    `  ${AXE}`,
    '});',
  ].join('\n')));
  assertPasses(spec([
    "test('aliased toggle settled', async ({ page }) => {",
    "  const toggle = page.locator('#themeToggle');",
    '  await toggle.click();',
    `  ${SETTLE}`,
    `  ${AXE}`,
    '});',
  ].join('\n')));
  assertPasses(spec([
    "test('alias chain settled', async ({ page }) => {",
    "  const toggle = page.locator('#themeToggle');",
    '  const button = toggle;',
    '  await button.click();',
    `  ${SETTLE}`,
    `  ${AXE}`,
    '});',
  ].join('\n')));
  assertFails(spec([
    "test('reassigned alias', async ({ page }) => {",
    '  let toggle;',
    "  toggle = page.locator('#themeToggle');",
    '  await toggle.click();',
    `  ${AXE}`,
    '});',
  ].join('\n')));
});

test('page.evaluate getElementById / querySelector toggles count', () => {
  assertFails(spec([
    "test('evaluate toggle', async ({ page }) => {",
    "  await page.evaluate(() => (document.getElementById('themeToggle') as HTMLButtonElement).click());",
    `  ${AXE}`,
    '});',
  ].join('\n')));
  assertPasses(spec([
    "test('evaluate toggle settled', async ({ page }) => {",
    "  await page.evaluate(() => (document.getElementById('themeToggle') as HTMLButtonElement).click());",
    `  ${SETTLE}`,
    `  ${AXE}`,
    '});',
  ].join('\n')));
  assertFails(spec([
    "test('querySelector toggle', async ({ page }) => {",
    "  await page.evaluate(() => document.querySelector('#themeToggle')!.click());",
    `  ${AXE}`,
    '});',
  ].join('\n')));
  assertFails(spec([
    "test('type-assertion toggle', async ({ page }) => {",
    "  await page.evaluate(() => (<HTMLButtonElement>document.getElementById('themeToggle')).click());",
    `  ${AXE}`,
    '});',
  ].join('\n')));
  assertPasses(spec([
    "test('satisfies toggle settled', async ({ page }) => {",
    "  await (page.locator('#themeToggle') satisfies object).click();",
    `  ${SETTLE}`,
    `  ${AXE}`,
    '});',
  ].join('\n')));
});

test('helper resolution: axe-only helper after an unsettled toggle fails, after a settled one passes', () => {
  const helper = [
    'async function expectWcagClean(page) {',
    '  const results = await new AxeBuilder({ page }).analyze();',
    '}',
    '',
  ].join('\n');
  assertFails(spec([
    helper,
    "test('helper axe unsettled', async ({ page }) => {",
    `  ${TOGGLE}`,
    '  await expectWcagClean(page);',
    '});',
  ].join('\n')));
  assertPasses(spec([
    helper,
    "test('helper axe settled', async ({ page }) => {",
    `  ${TOGGLE}`,
    `  ${SETTLE}`,
    '  await expectWcagClean(page);',
    '});',
  ].join('\n')));
  // A function-expression helper resolves the same way.
  assertFails(spec([
    'const expectWcagClean = async function (page) {',
    '  const results = await new AxeBuilder({ page }).analyze();',
    '};',
    '',
    "test('function-expression helper', async ({ page }) => {",
    `  ${TOGGLE}`,
    '  await expectWcagClean(page);',
    '});',
  ].join('\n')));
  // A helper calling another helper resolves transitively.
  assertFails(spec([
    'async function inner(page) {',
    '  const results = await new AxeBuilder({ page }).analyze();',
    '}',
    'async function outer(page) {',
    '  await inner(page);',
    '}',
    '',
    "test('nested helper', async ({ page }) => {",
    `  ${TOGGLE}`,
    '  await outer(page);',
    '});',
  ].join('\n')));
  // A helper defined inside a describe block resolves too.
  assertFails(spec([
    "test.describe('group', () => {",
    '  async function axeOnly(page) {',
    '    const results = await new AxeBuilder({ page }).analyze();',
    '  }',
    "  test('describe helper', async ({ page }) => {",
    `    ${TOGGLE}`,
    '    await axeOnly(page);',
    '  });',
    '});',
  ].join('\n')));
});

test('helper resolution: toggle+settle+axe inside one helper is compliant on its own', () => {
  assertPasses(spec([
    'async function expectAccessible(page) {',
    "  await page.evaluate(() => (document.getElementById('themeToggle') as HTMLButtonElement).click());",
    "  await waitForThemeSettled(page, '#view-landing', true);",
    '  const results = await new AxeBuilder({ page }).analyze();',
    '}',
    '',
    "test('helper does everything', async ({ page }) => {",
    '  await expectAccessible(page);',
    '});',
  ].join('\n')));
  // ... and the same helper with the settle removed is a violation.
  assertFails(spec([
    'async function expectAccessible(page) {',
    "  await page.evaluate(() => (document.getElementById('themeToggle') as HTMLButtonElement).click());",
    '  const results = await new AxeBuilder({ page }).analyze();',
    '}',
    '',
    "test('helper missing settle', async ({ page }) => {",
    '  await expectAccessible(page);',
    '});',
  ].join('\n')));
});

test('an axe-only helper with no toggle anywhere needs no settle (golden-public-pages shape)', () => {
  assertPasses(spec([
    'async function expectAccessible(page) {',
    "  await page.emulateMedia({ colorScheme: 'light' });",
    '  const results = await new AxeBuilder({ page }).analyze();',
    '}',
    '',
    "test('public pages', async ({ page }) => {",
    '  await expectAccessible(page);',
    '});',
  ].join('\n')));
});

test('a conditional toggle inside a helper still counts, settled after the branch', () => {
  assertPasses(spec([
    'async function expectAccessible(page) {',
    '  const isLight = await page.evaluate(() => document.documentElement.classList.contains(\'light\'));',
    "  if (isLight !== true) await page.evaluate(() => (document.getElementById('themeToggle') as HTMLButtonElement).click());",
    "  await waitForThemeSettled(page, '#view-landing', true);",
    '  const results = await new AxeBuilder({ page }).analyze();',
    '}',
    '',
    "test('conditional toggle in helper', async ({ page }) => {",
    '  await expectAccessible(page);',
    '});',
  ].join('\n')));
});

test('helpers declared inside a test expand at the call site, not the definition', () => {
  assertFails(spec([
    "test('test-local helper', async ({ page }) => {",
    '  async function localAxe() {',
    '    const results = await new AxeBuilder({ page }).analyze();',
    '  }',
    `  ${TOGGLE}`,
    '  await localAxe();',
    '});',
  ].join('\n')));
  assertPasses(spec([
    "test('test-local helper settled', async ({ page }) => {",
    '  const localAxe = async () => {',
    '    const results = await new AxeBuilder({ page }).analyze();',
    '  };',
    `  ${TOGGLE}`,
    `  ${SETTLE}`,
    '  await localAxe();',
    '});',
  ].join('\n')));
  assertPasses(spec([
    "test('test-local helper never called', async ({ page }) => {",
    '  async function localAxe() {',
    '    const results = await new AxeBuilder({ page }).analyze();',
    '  }',
    `  ${TOGGLE}`,
    '});',
  ].join('\n')));
  // A hoisted function declaration still resolves when called above it.
  assertFails(spec([
    "test('hoisted test-local helper', async ({ page }) => {",
    `  ${TOGGLE}`,
    '  await localAxe();',
    '  async function localAxe() {',
    '    const results = await new AxeBuilder({ page }).analyze();',
    '  }',
    '});',
  ].join('\n')));
});

test('non-violations: password toggle, theme preset, emulateMedia, visibility-only locator', () => {
  assertPasses(spec([
    "test('password toggle', async ({ page }) => {",
    "  const toggle = page.locator('#authPassToggle');",
    '  await toggle.click();',
    `  ${AXE}`,
    '});',
  ].join('\n')));
  assertPasses(spec([
    "test('theme preset', async ({ page }) => {",
    "  await resetClientState(page, false, { 'randori-theme': 'light' });",
    `  ${AXE}`,
    '});',
  ].join('\n')));
  assertPasses(spec([
    "test('emulateMedia', async ({ page }) => {",
    "  await page.emulateMedia({ colorScheme: 'light' });",
    `  ${AXE}`,
    '});',
  ].join('\n')));
  assertPasses(spec([
    "test('visibility only', async ({ page }) => {",
    "  await expect(page.locator('#themeToggle')).toBeVisible();",
    `  ${AXE}`,
    '});',
  ].join('\n')));
});

test('describe blocks, for-loop tests, test.only/skip, options objects and named callbacks', () => {
  assertFails(spec([
    "test.describe('group', () => {",
    "  test('inside describe', async ({ page }) => {",
    `    ${TOGGLE}`,
    `    ${AXE}`,
    '  });',
    '});',
  ].join('\n')), { match: /test "inside describe"/ });
  assertFails(spec([
    "for (const theme of ['dark', 'light']) {",
    "  test(`theme ${theme}`, async ({ page }) => {",
    `    ${TOGGLE}`,
    `    ${AXE}`,
    '  });',
    '}',
  ].join('\n')), { match: /test "`theme \$\{theme\}`"/ });
  assertFails(spec([
    "test.only('only', async ({ page }) => {",
    `  ${TOGGLE}`,
    `  ${AXE}`,
    '});',
  ].join('\n')));
  assertFails(spec([
    "test.skip('skipped but still in the tree', async ({ page }) => {",
    `  ${TOGGLE}`,
    `  ${AXE}`,
    '});',
  ].join('\n')));
  assertFails(spec([
    "test('with options', { annotation: { type: 'issue', description: 'x' } }, async ({ page }) => {",
    `  ${TOGGLE}`,
    `  ${AXE}`,
    '});',
  ].join('\n')));
  assertFails(spec([
    'async function body(page) {',
    `  ${TOGGLE}`,
    `  ${AXE}`,
    '}',
    "test('named callback', body);",
  ].join('\n')));
  assertPasses(spec([
    "test('no tests here', async () => {});",
    'const value = 1;',
  ].join('\n')));
  assertPasses('');
});

test('a TypeScript parse error fails closed', () => {
  const violations = checkThemeToggleAxeSource(
    "test('broken', async ({ page }) => { await page.locator(;",
    'broken.spec.ts',
  );
  assert.ok(violations.length > 0);
  assert.ok(violations.every((violation) => violation.includes('TypeScript parse error')));
});

test('a settle reached through a namespace call counts', () => {
  assertPasses(spec([
    "test('namespaced settle', async ({ page }) => {",
    `  ${TOGGLE}`,
    "  await helpers.waitForThemeSettled(page, '#view-landing', true);",
    `  ${AXE}`,
    '});',
  ].join('\n')));
});

function writeTree(dir, files) {
  for (const [rel, content] of Object.entries(files)) {
    const target = join(dir, rel);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, content);
  }
}

test('the guard scans a fixture tree, ignores non-spec files, and reports file:line', () => {
  const dir = mkdtempSync(join(tmpdir(), 'check-theme-toggle-axe-'));
  try {
    writeTree(dir, {
      'tests/e2e/clean.spec.ts': spec([
        "test('clean', async ({ page }) => {",
        `  ${TOGGLE}`,
        `  ${SETTLE}`,
        `  ${AXE}`,
        '});',
      ].join('\n')),
      'tests/e2e/violating.spec.ts': spec([
        "test('violating', async ({ page }) => {",
        `  ${TOGGLE}`,
        `  ${AXE}`,
        '});',
      ].join('\n')),
      'tests/e2e/nested/deep.spec.ts': spec([
        "test('deep', async ({ page }) => {",
        `  ${TOGGLE}`,
        `  ${AXE}`,
        '});',
      ].join('\n')),
      // Not a spec file: never scanned, however violating.
      'tests/e2e/helper.ts': spec([
        "test('not a spec', async ({ page }) => {",
        `  ${TOGGLE}`,
        `  ${AXE}`,
        '});',
      ].join('\n')),
    });
    const violations = inspectThemeToggleAxeGuard(dir);
    assert.equal(violations.length, 2);
    assert.ok(violations.some((violation) => violation.startsWith('tests/e2e/violating.spec.ts:5')));
    assert.ok(violations.some((violation) => violation.startsWith('tests/e2e/nested/deep.spec.ts:5')));
    assert.ok(violations.every((violation) => !violation.includes('helper.ts')));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  const empty = mkdtempSync(join(tmpdir(), 'check-theme-toggle-axe-empty-'));
  try {
    const missing = inspectThemeToggleAxeGuard(empty);
    assert.equal(missing.length, 1);
    assert.match(missing[0], /^tests\/e2e directory not found under /);
  } finally {
    rmSync(empty, { recursive: true, force: true });
  }
});

test('the guard passes on the current tree and sees the real specs', () => {
  const files = collectSpecFiles(join(REPO_ROOT, 'tests', 'e2e'));
  assert.ok(files.length > 50, `expected many specs, got ${files.length}`);
  assert.ok(files.some((file) => file.endsWith('ui-shell-accessibility.spec.ts')));
  assert.deepEqual(inspectThemeToggleAxeGuard(REPO_ROOT), []);
});

test('the CLI passes on a clean fixture tree and fails with JSON on a violating one', () => {
  const dir = mkdtempSync(join(tmpdir(), 'check-theme-toggle-axe-cli-'));
  try {
    writeTree(dir, {
      'tests/e2e/clean.spec.ts': spec([
        "test('clean', async ({ page }) => {",
        `  ${TOGGLE}`,
        `  ${SETTLE}`,
        `  ${AXE}`,
        '});',
      ].join('\n')),
    });
    const pass = spawnSync(process.execPath, [SCRIPT], { cwd: dir, encoding: 'utf8' });
    assert.equal(pass.status, 0, pass.stderr || pass.stdout);
    assert.deepEqual(JSON.parse(pass.stdout), {
      ok: true, gate: 'theme-toggle-axe', providerNetworkRequired: false, externalMutation: false,
    });
    writeTree(dir, {
      'tests/e2e/violating.spec.ts': spec([
        "test('violating', async ({ page }) => {",
        `  ${TOGGLE}`,
        `  ${AXE}`,
        '});',
      ].join('\n')),
    });
    const fail = spawnSync(process.execPath, [SCRIPT], { cwd: dir, encoding: 'utf8' });
    assert.equal(fail.status, 1);
    const payload = JSON.parse(fail.stderr);
    assert.equal(payload.ok, false);
    assert.equal(payload.gate, 'theme-toggle-axe');
    assert.equal(payload.errors.length, 1);
    assert.match(payload.errors[0], /tests\/e2e\/violating\.spec\.ts:5 test "violating"/);
    // An explicit spec-file argument is scanned directly.
    const byFile = spawnSync(process.execPath, [SCRIPT, join(dir, 'tests/e2e/violating.spec.ts')], {
      cwd: dir, encoding: 'utf8',
    });
    assert.equal(byFile.status, 1);
    assert.match(JSON.parse(byFile.stderr).errors[0], /violating/);
    // A missing path fails closed.
    const missing = spawnSync(process.execPath, [SCRIPT, join(dir, 'nope.spec.ts')], {
      cwd: dir, encoding: 'utf8',
    });
    assert.equal(missing.status, 1);
    assert.match(JSON.parse(missing.stderr).errors[0], /does not exist/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
