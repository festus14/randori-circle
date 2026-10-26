import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
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

function assertFails(source, { count = 1, match = /without an intervening waitForThemeSettled/, resolver } = {}) {
  const violations = checkThemeToggleAxeSource(source, 'fixture.spec.ts', resolver);
  assert.equal(violations.length, count, JSON.stringify(violations));
  for (const violation of violations) assert.match(violation, match);
  return violations;
}

function assertPasses(source, resolver) {
  assert.deepEqual(checkThemeToggleAxeSource(source, 'fixture.spec.ts', resolver), []);
}

// An in-memory import resolver for cross-file fixtures: './helper' maps
// to files.helper.
function resolverFor(files) {
  return (specifier) => {
    const key = specifier.replace(/^\.\//, '');
    return Object.hasOwn(files, key) ? { source: files[key], relPath: `${key}.ts` } : null;
  };
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

test('R1: imported helpers expand like same-file ones, both directions', () => {
  // a.spec.ts: imported toggle helper does the click, spec runs axe directly.
  assertFails(spec([
    "import { toggleTheme } from './a-helper';",
    "test('imported toggle', async ({ page }) => {",
    '  await toggleTheme(page);',
    `  ${AXE}`,
    '});',
  ].join('\n')), {
    resolver: resolverFor({
      'a-helper': [
        'export async function toggleTheme(page) {',
        "  await page.locator('#themeToggle').click();",
        '}',
      ].join('\n'),
    }),
  });
  // b.spec.ts: spec toggles directly, imported helper runs axe.
  assertFails(spec([
    "import { runAxe } from './b-helper';",
    "test('imported axe', async ({ page }) => {",
    `  ${TOGGLE}`,
    '  await runAxe(page);',
    '});',
  ].join('\n')), {
    resolver: resolverFor({
      'b-helper': [
        "import AxeBuilder from '@axe-core/playwright';",
        'export async function runAxe(page) {',
        '  const results = await new AxeBuilder({ page }).analyze();',
        '}',
      ].join('\n'),
    }),
  });
  // An imported helper that toggles, settles, then runs axe is compliant.
  assertPasses(spec([
    "import { doAll } from './c-helper';",
    "test('imported helper does everything', async ({ page }) => {",
    '  await doAll(page);',
    '});',
  ].join('\n')), resolverFor({
    'c-helper': [
      "import AxeBuilder from '@axe-core/playwright';",
      'export async function doAll(page) {',
      "  await page.locator('#themeToggle').click();",
      "  await waitForThemeSettled(page, '#view-landing', true);",
      '  const results = await new AxeBuilder({ page }).analyze();',
      '}',
    ].join('\n'),
  }));
  // An imported helper with no toggle/axe events stays green (the real
  // helpers.ts / golden-runtime.ts shape: page.route, locators, no axe).
  assertPasses(spec([
    "import { mockApi } from './helpers';",
    "test('imported inert helper', async ({ page }) => {",
    '  await mockApi(page);',
    `  ${TOGGLE}`,
    `  ${SETTLE}`,
    `  ${AXE}`,
    '});',
  ].join('\n')), resolverFor({
    helpers: [
      'export async function mockApi(page) {',
      "  await page.route('**/api/**', async (route) => {});",
      "  await page.locator('#view-code').click();",
      '}',
    ].join('\n'),
  }));
  // Re-exported and namespace-imported helpers resolve too.
  assertFails(spec([
    "import { toggleTheme } from './reexp';",
    "test('re-exported toggle', async ({ page }) => {",
    '  await toggleTheme(page);',
    `  ${AXE}`,
    '});',
  ].join('\n')), {
    resolver: resolverFor({
      reexp: "export { toggleTheme } from './impl';",
      impl: [
        'export async function toggleTheme(page) {',
        "  await page.locator('#themeToggle').click();",
        '}',
      ].join('\n'),
    }),
  });
  assertFails(spec([
    "import * as h from './ns-helper';",
    "test('namespaced toggle', async ({ page }) => {",
    '  await h.toggleTheme(page);',
    `  ${AXE}`,
    '});',
  ].join('\n')), {
    resolver: resolverFor({
      'ns-helper': [
        'export async function toggleTheme(page) {',
        "  await page.locator('#themeToggle').click();",
        '}',
      ].join('\n'),
    }),
  });
  // An imported helper that cannot be parsed fails closed.
  assertFails(spec([
    "import { toggleTheme } from './bad-helper';",
    "test('unparseable helper', async ({ page }) => {",
    '  await toggleTheme(page);',
    `  ${AXE}`,
    '});',
  ].join('\n')), {
    count: 1,
    match: /imported helper bad-helper\.ts has TypeScript parse errors/,
    resolver: resolverFor({
      'bad-helper': 'export async function toggleTheme(page) { await page.locator(; }',
    }),
  });
  // An imported helper called from a beforeEach hook expands too.
  assertFails(spec([
    "import { setup } from './setup-helper';",
    "test.beforeEach(async ({ page }) => {",
    '  await setup(page);',
    '});',
    "test('hook helper toggle', async ({ page }) => {",
    `  ${AXE}`,
    '});',
  ].join('\n')), {
    resolver: resolverFor({
      'setup-helper': [
        'export async function setup(page) {',
        "  await page.locator('#themeToggle').click();",
        '}',
      ].join('\n'),
    }),
  });
  // A test whose callback itself is imported resolves.
  assertFails(spec([
    "import { body } from './body-helper';",
    "test('imported callback', body);",
  ].join('\n')), {
    resolver: resolverFor({
      'body-helper': [
        "import AxeBuilder from '@axe-core/playwright';",
        'export async function body({ page }) {',
        "  await page.locator('#themeToggle').click();",
        '  const results = await new AxeBuilder({ page }).analyze();',
        '}',
      ].join('\n'),
    }),
  });
});

test('R1: cross-file fixtures on disk (filesystem resolver)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'check-theme-toggle-axe-cross-file-'));
  try {
    writeTree(dir, {
      'tests/e2e/golden-theme-settle.ts':
        'export async function waitForThemeSettled(page, selector, light) {}',
      'tests/e2e/a-helper.ts': [
        'export async function toggleTheme(page) {',
        "  await page.locator('#themeToggle').click();",
        '}',
      ].join('\n'),
      'tests/e2e/b-helper.ts': [
        "import AxeBuilder from '@axe-core/playwright';",
        'export async function runAxe(page) {',
        '  const results = await new AxeBuilder({ page }).analyze();',
        '}',
      ].join('\n'),
      'tests/e2e/a.spec.ts': spec([
        "import { toggleTheme } from './a-helper';",
        "test('imported toggle', async ({ page }) => {",
        '  await toggleTheme(page);',
        `  ${AXE}`,
        '});',
      ].join('\n')),
      'tests/e2e/b.spec.ts': spec([
        "import { runAxe } from './b-helper';",
        "test('imported axe', async ({ page }) => {",
        `  ${TOGGLE}`,
        '  await runAxe(page);',
        '});',
      ].join('\n')),
      'tests/e2e/clean.spec.ts': spec([
        "import { runAxe } from './b-helper';",
        "test('imported axe settled', async ({ page }) => {",
        `  ${TOGGLE}`,
        `  ${SETTLE}`,
        '  await runAxe(page);',
        '});',
      ].join('\n')),
    });
    const violations = inspectThemeToggleAxeGuard(dir);
    assert.equal(violations.length, 2, JSON.stringify(violations));
    assert.ok(violations.some((v) => v.includes('a.spec.ts')));
    assert.ok(violations.some((v) => v.includes('b.spec.ts')));
    assert.ok(violations.every((v) => !v.includes('clean.spec.ts')));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('R2: beforeEach / beforeAll hooks are prepended to each test in scope', () => {
  assertFails(spec([
    "test.beforeEach(async ({ page }) => {",
    `  ${TOGGLE}`,
    '});',
    "test('hook toggle, test axe', async ({ page }) => {",
    `  ${AXE}`,
    '});',
  ].join('\n')));
  assertFails(spec([
    "test.describe('group', () => {",
    "  test.beforeEach(async ({ page }) => {",
    `    ${TOGGLE}`,
    '  });',
    "  test('describe hook toggle', async ({ page }) => {",
    `    ${AXE}`,
    '  });',
    '});',
  ].join('\n')));
  assertFails(spec([
    "test.beforeAll(async ({ page }) => {",
    `  ${TOGGLE}`,
    '});',
    "test('beforeAll toggle, test axe', async ({ page }) => {",
    `  ${AXE}`,
    '});',
  ].join('\n')));
  // A settle that ran in beforeEach, before the test's toggle, does not
  // cover that toggle.
  assertFails(spec([
    "test.beforeEach(async ({ page }) => {",
    `  ${SETTLE}`,
    '});',
    "test('hook settle, test toggle', async ({ page }) => {",
    `  ${TOGGLE}`,
    `  ${AXE}`,
    '});',
  ].join('\n')));
  // A toggle in the hook settled inside the test passes; a toggle and a
  // settle both in the hook pass too.
  assertPasses(spec([
    "test.beforeEach(async ({ page }) => {",
    `  ${TOGGLE}`,
    '});',
    "test('hook toggle settled in test', async ({ page }) => {",
    `  ${SETTLE}`,
    `  ${AXE}`,
    '});',
  ].join('\n')));
  assertPasses(spec([
    "test.beforeEach(async ({ page }) => {",
    `  ${TOGGLE}`,
    `  ${SETTLE}`,
    '});',
    "test('hook toggle settled in hook', async ({ page }) => {",
    `  ${AXE}`,
    '});',
  ].join('\n')));
  // Hooks do not leak into a sibling describe block.
  assertFails(spec([
    "test.describe('group one', () => {",
    "  test.beforeEach(async ({ page }) => {",
    `    ${TOGGLE}`,
    '  });',
    "  test('hooked', async ({ page }) => {",
    `    ${AXE}`,
    '  });',
    '});',
    "test.describe('group two', () => {",
    "  test('unhooked', async ({ page }) => {",
    `    ${AXE}`,
    '  });',
    '});',
  ].join('\n')), { count: 1, match: /test "hooked"/ });
  // Nested describes accumulate hooks: the outer toggle is settled by
  // the inner hook's settle before the test's axe.
  assertPasses(spec([
    "test.describe('outer', () => {",
    "  test.beforeEach(async ({ page }) => {",
    `    ${TOGGLE}`,
    '  });',
    "  test.describe('inner', () => {",
    "    test.beforeEach(async ({ page }) => {",
    `      ${SETTLE}`,
    '    });',
    "    test('nested hooks', async ({ page }) => {",
    `      ${AXE}`,
    '    });',
    '  });',
    '});',
  ].join('\n')));
  // A hook that calls a same-file helper by name expands.
  assertFails(spec([
    'async function toggleIt(page) {',
    `  ${TOGGLE}`,
    '}',
    'test.beforeEach(toggleIt);',
    "test('hook helper', async ({ page }) => {",
    `  ${AXE}`,
    '});',
  ].join('\n')));
});

test('nits: constant-propagated selectors, page.click, first/nth, getByTestId, dispatchEvent', () => {
  // (1) const sel = '#themeToggle'; page.locator(sel).click()
  assertFails(spec([
    "test('const selector', async ({ page }) => {",
    "  const sel = '#themeToggle';",
    '  await page.locator(sel).click();',
    `  ${AXE}`,
    '});',
  ].join('\n')));
  // (2) const id = 'themeToggle'; document.getElementById(id).click()
  assertFails(spec([
    "test('const id', async ({ page }) => {",
    "  const id = 'themeToggle';",
    "  await page.evaluate(() => document.getElementById(id).click());",
    `  ${AXE}`,
    '});',
  ].join('\n')));
  // (4) page.click('#themeToggle'), including through a const selector.
  assertFails(spec([
    "test('page.click', async ({ page }) => {",
    "  await page.click('#themeToggle');",
    `  ${AXE}`,
    '});',
  ].join('\n')));
  assertFails(spec([
    "test('page.click const', async ({ page }) => {",
    "  const sel = '#themeToggle';",
    '  await page.click(sel);',
    `  ${AXE}`,
    '});',
  ].join('\n')));
  // A page.click on a non-theme selector is not a toggle.
  assertPasses(spec([
    "test('page.click other', async ({ page }) => {",
    "  await page.click('#other');",
    `  ${AXE}`,
    '});',
  ].join('\n')));
  // (5) .first() / .nth(0) / .last() on a theme locator.
  assertFails(spec([
    "test('first/nth/last', async ({ page }) => {",
    "  await page.locator('#themeToggle').first().click();",
    `  ${AXE}`,
    "  await page.locator('#themeToggle').nth(0).click();",
    `  ${AXE}`,
    "  await page.locator('#themeToggle').last().click();",
    `  ${AXE}`,
    '});',
  ].join('\n')), { count: 3 });
  // (6) getByTestId('themeToggle'), directly and through an alias.
  assertFails(spec([
    "test('getByTestId', async ({ page }) => {",
    "  await page.getByTestId('themeToggle').click();",
    `  ${AXE}`,
    '});',
  ].join('\n')));
  assertFails(spec([
    "test('getByTestId alias', async ({ page }) => {",
    "  const toggle = page.getByTestId('themeToggle');",
    '  await toggle.click();',
    `  ${AXE}`,
    '});',
  ].join('\n')));
  // (7) dispatchEvent('click') on a theme locator, and
  // page.dispatchEvent('#themeToggle', 'click').
  assertFails(spec([
    "test('dispatchEvent locator', async ({ page }) => {",
    "  await page.locator('#themeToggle').dispatchEvent('click');",
    `  ${AXE}`,
    '});',
  ].join('\n')));
  assertFails(spec([
    "test('dispatchEvent page', async ({ page }) => {",
    "  await page.dispatchEvent('#themeToggle', 'click');",
    `  ${AXE}`,
    '});',
  ].join('\n')));
  // dispatchEvent with a non-click type, and a form submit, are not toggles.
  assertPasses(spec([
    "test('dispatchEvent other', async ({ page }) => {",
    "  await page.locator('#themeToggle').dispatchEvent('mouseover');",
    `  ${AXE}`,
    '});',
  ].join('\n')));
  assertPasses(spec([
    "test('dispatchEvent submit', async ({ page }) => {",
    "  const form = page.locator('#form');",
    "  await form.dispatchEvent('submit');",
    `  ${AXE}`,
    '});',
  ].join('\n')));
});

test('nit 3: an identifier bound to new AxeBuilder(...) is an axe run', () => {
  assertFails(spec([
    "test('axe alias var', async ({ page }) => {",
    `  ${TOGGLE}`,
    '  const a = new AxeBuilder({ page });',
    '  await a.analyze();',
    '});',
  ].join('\n')));
  assertFails(spec([
    "test('axe alias var chained', async ({ page }) => {",
    `  ${TOGGLE}`,
    '  const a = new AxeBuilder({ page });',
    "  await a.include('#view-landing').analyze();",
    '});',
  ].join('\n')));
  // Rebinding the axe var to a non-axe value stops it counting.
  assertPasses(spec([
    "test('axe alias rebound', async ({ page }) => {",
    `  ${TOGGLE}`,
    '  let a = new AxeBuilder({ page });',
    '  a = other;',
    '  await a.analyze();',
    '});',
  ].join('\n')));
});

test('nit 8: settle aliases count (const alias and import rename)', () => {
  assertPasses(spec([
    "test('settle alias', async ({ page }) => {",
    `  ${TOGGLE}`,
    '  const s = waitForThemeSettled;',
    "  await s(page, '#view-landing', true);",
    `  ${AXE}`,
    '});',
  ].join('\n')));
  assertPasses([
    "import { expect, test } from '@playwright/test';",
    "import AxeBuilder from '@axe-core/playwright';",
    "import { waitForThemeSettled as settle } from './golden-theme-settle';",
    '',
    "test('settle import alias', async ({ page }) => {",
    `  ${TOGGLE}`,
    "  await settle(page, '#view-landing', true);",
    `  ${AXE}`,
    '});',
  ].join('\n'));
  // Rebinding a settle alias to a non-settle function stops it counting.
  assertFails(spec([
    "test('settle alias rebound', async ({ page }) => {",
    '  let s = waitForThemeSettled;',
    '  s = otherFn;',
    `  ${TOGGLE}`,
    '  await s(page);',
    `  ${AXE}`,
    '});',
  ].join('\n')));
});

test('nit 9: an alias reassigned to a non-theme locator stops counting', () => {
  assertPasses(spec([
    "test('alias reassigned away', async ({ page }) => {",
    "  const themeLocator = page.locator('#themeToggle');",
    "  const otherLocator = page.locator('#other');",
    '  let t = themeLocator;',
    '  t = otherLocator;',
    '  await t.click();',
    `  ${AXE}`,
    '});',
  ].join('\n')));
  // ... while reassignment onto the theme locator still counts.
  assertFails(spec([
    "test('alias reassigned onto theme', async ({ page }) => {",
    "  const otherLocator = page.locator('#other');",
    "  const themeLocator = page.locator('#themeToggle');",
    '  let t = otherLocator;',
    '  t = themeLocator;',
    '  await t.click();',
    `  ${AXE}`,
    '});',
  ].join('\n')));
  // A const declaration shadowing the alias with a non-theme locator
  // stops the shadowing click counting.
  assertPasses(spec([
    "test('alias shadowed', async ({ page }) => {",
    "  const t = page.locator('#themeToggle');",
    '  {',
    "    const t = page.locator('#other');",
    '    await t.click();',
    '  }',
    `  ${AXE}`,
    '});',
  ].join('\n')));
});

test('harder, fixed cheaply: aliased AxeBuilder import, helper param binding, caller-closing helpers', () => {
  // Aliased import: new MyAxe(...).analyze() counts as axe.
  assertFails([
    "import { expect, test } from '@playwright/test';",
    "import MyAxe from '@axe-core/playwright';",
    "import { waitForThemeSettled } from './golden-theme-settle';",
    '',
    "test('aliased AxeBuilder import', async ({ page }) => {",
    `  ${TOGGLE}`,
    '  const results = await new MyAxe({ page }).analyze();',
    '});',
  ].join('\n'));
  // Helper param binding: clickIt(toggle), helper does btn.click().
  assertFails(spec([
    'async function clickIt(btn) {',
    '  await btn.click();',
    '}',
    "test('param-bound toggle', async ({ page }) => {",
    "  const toggle = page.locator('#themeToggle');",
    '  await clickIt(toggle);',
    `  ${AXE}`,
    '});',
  ].join('\n')));
  // Helper param binding for an AxeBuilder variable.
  assertFails(spec([
    'async function runIt(builder) {',
    '  await builder.analyze();',
    '}',
    "test('param-bound axe', async ({ page }) => {",
    `  ${TOGGLE}`,
    '  const a = new AxeBuilder({ page });',
    '  await runIt(a);',
    '});',
  ].join('\n')));
  // Helper param binding for a string-constant selector.
  assertFails(spec([
    'async function clickSel(sel) {',
    '  await page.locator(sel).click();',
    '}',
    "test('param-bound selector', async ({ page }) => {",
    "  const sel = '#themeToggle';",
    '  await clickSel(sel);',
    `  ${AXE}`,
    '});',
  ].join('\n')));
  // A test-local helper closes over the caller's const toggle.
  assertFails(spec([
    "test('test-local helper closes over toggle', async ({ page }) => {",
    "  const toggle = page.locator('#themeToggle');",
    '  async function doIt() {',
    '    await toggle.click();',
    '  }',
    '  await doIt();',
    `  ${AXE}`,
    '});',
  ].join('\n')));
  // A module-level helper does NOT close over the caller's const toggle:
  // its `toggle` is a free variable in its own module, not the test's.
  assertPasses(spec([
    'async function doIt() {',
    '  await toggle.click();',
    '}',
    "test('module helper no closure', async ({ page }) => {",
    "  const toggle = page.locator('#themeToggle');",
    '  await doIt();',
    `  ${AXE}`,
    '});',
  ].join('\n')));
  // Path-sensitive shapes stay documented, not silently fixed: a settle
  // in the else branch still counts for a toggle in the if branch, as
  // the guard linearises branches in source order.
  assertPasses(spec([
    "test('settle in else branch (documented)', async ({ page }) => {",
    '  const c = true;',
    '  if (c) {',
    `    ${TOGGLE}`,
    '  } else {',
    `    ${SETTLE}`,
    '  }',
    `  ${AXE}`,
    '});',
  ].join('\n')));
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
    // Invoked through a symlinked path (e.g. /tmp on macOS, where
    // /tmp -> /private/tmp), the CLI must still run: the old main guard
    // compared the unresolved argv path and silently exited 0.
    const link = join(dir, 'guard-link.mjs');
    symlinkSync(SCRIPT, link);
    const viaSymlink = spawnSync(process.execPath, [link, join(dir, 'tests/e2e/violating.spec.ts')], {
      cwd: dir, encoding: 'utf8',
    });
    assert.equal(viaSymlink.status, 1, viaSymlink.stdout || viaSymlink.stderr);
    assert.match(JSON.parse(viaSymlink.stderr).errors[0], /violating/);
    const viaSymlinkClean = spawnSync(process.execPath, [link, join(dir, 'tests/e2e/clean.spec.ts')], {
      cwd: dir, encoding: 'utf8',
    });
    assert.equal(viaSymlinkClean.status, 0, viaSymlinkClean.stderr || viaSymlinkClean.stdout);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
