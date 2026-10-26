#!/usr/bin/env node
// CI guard for issue #419: fail when an e2e spec does themeToggle -> axe
// without an intervening waitForThemeSettled. A file-level grep cannot do
// this soundly: a toggle in one test and axe in an unrelated test in the
// same file is compliant, and one settle anywhere in the file must not mask
// a second unsettled toggle -> axe site in another test.
//
// The guard is per-test-block, on the TypeScript AST (typescript 5.9.3,
// pinned exact in package.json — the precursor #423/#431 landed it for
// exactly this use). For each test body it linearises the events in source
// order, expanding same-file helper calls in place, and requires that
// every theme toggle with a later axe in the same test has a
// waitForThemeSettled between the toggle and that axe.
//
// Events:
// - toggle: `.click()` on `*.locator('#themeToggle')`, on an alias bound to
//   that locator (`const toggle = page.locator('#themeToggle')`), or on
//   `document.getElementById('themeToggle')` / `document.querySelector(
//   '#themeToggle')` (the `page.evaluate(...)` form the golden specs use).
//   Only string-literal selectors are recognised — a bare identifier
//   selector is never a toggle, and merely locating the toggle
//   (`toBeVisible()`, `toHaveAttribute(...)`, `toBeFocused()`) is not a
//   click. Non-theme toggles (`#authPassToggle`) are not theme toggles.
// - settle: a call to `waitForThemeSettled` (by name, wherever it is
//   imported from — the shared helper in tests/e2e/golden-theme-settle.ts).
// - axe: `.analyze()` on a `new AxeBuilder(...)` chain, directly or
//   through an expanded helper (`expectWcagClean`, `expectAccessible`).
//
// A helper is only judged as part of a calling test: a helper that contains
// axe but no toggle (golden-public-pages' `expectAccessible`, which drives
// the theme with `emulateMedia({colorScheme})` on no-script pages) needs no
// settle, and a helper that contains toggle + settle + axe
// (account-deletion / data-export `expectAccessible`) makes a test that
// only calls the helper compliant. Theme presets via `randori-theme` in
// localStorage before `goto` are not clicks and are ignored, as is
// `emulateMedia`.
//
// Known limitations (documented, not silently assumed):
// - Statements are linearised in source order: branches and loops are
//   flattened, so a toggle inside an `if` counts, and a settle after that
//   `if` counts for it. A settle inside a *different* branch than the
//   toggle would also count — the guard does not do path-sensitive
//   branch analysis. The current tree has no such shape.
// - Only same-file helpers are expanded. Helpers imported from another
//   file are opaque, except `waitForThemeSettled`, recognised by name.
//   (No imported helper in tests/e2e contains a toggle or an axe run.)
// - Alias tracking is per-function frame and only grows: an alias
//   reassigned to a non-theme locator later in the same frame still
//   counts as a theme alias. The current tree has no reassignment.
// - Selectors must be string literals (`'#themeToggle'`, `'themeToggle'`).
//   Template literals with substitutions, concatenated selectors, and an
//   `AxeBuilder` imported under another name are not recognised, and fail
//   open — a violation using one of those shapes would not be flagged.
// - Helpers declared inside a test body are expanded at their call site,
//   not at their definition point; a helper that is never called
//   contributes no events. Callbacks passed as arguments (e.g. the
//   `page.evaluate(() => ...)` arrow) are linearised inline at the call.
// - Recursive helper calls expand once; the recursive re-entry is opaque.
// - A settle is only credited when it sits between a toggle and the next
//   axe after that toggle. A settle before the toggle, or after the axe,
//   does not count, and one settle does not cover a toggle after it.

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import ts from 'typescript';

const GATE = 'theme-toggle-axe';
const THEME_SELECTOR = '#themeToggle';
const THEME_ELEMENT_ID = 'themeToggle';

// A string literal with exactly this text, or null. Template literals with
// substitutions are not static strings and are deliberately rejected.
function literalText(node) {
  if (!node) return null;
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  return null;
}

// Strip `as ...`, `(...)`, `!` and `satisfies ...` wrappers.
function unwrap(node) {
  let current = node;
  while (current && (
    ts.isAsExpression(current)
    || ts.isParenthesizedExpression(current)
    || ts.isTypeAssertionExpression(current)
    || ts.isNonNullExpression(current)
    || ts.isSatisfiesExpression(current)
  )) current = current.expression;
  return current;
}

function isFunctionLike(node) {
  return !!node && (ts.isArrowFunction(node) || ts.isFunctionExpression(node)
    || ts.isFunctionDeclaration(node));
}

// `*.locator('#themeToggle')` — any receiver, string-literal selector only.
function isThemeLocatorCall(node) {
  const target = unwrap(node);
  if (!target || !ts.isCallExpression(target)) return false;
  const callee = target.expression;
  if (!ts.isPropertyAccessExpression(callee) || callee.name.text !== 'locator') return false;
  return literalText(target.arguments[0]) === THEME_SELECTOR;
}

// `*.getElementById('themeToggle')` or `*.querySelector('#themeToggle')`.
function isThemeElementCall(node) {
  const target = unwrap(node);
  if (!target || !ts.isCallExpression(target)) return false;
  const callee = target.expression;
  if (!ts.isPropertyAccessExpression(callee)) return false;
  if (callee.name.text === 'getElementById') return literalText(target.arguments[0]) === THEME_ELEMENT_ID;
  if (callee.name.text === 'querySelector') return literalText(target.arguments[0]) === THEME_SELECTOR;
  return false;
}

function isToggleClick(node, aliases) {
  if (!ts.isCallExpression(node)) return false;
  const callee = node.expression;
  if (!ts.isPropertyAccessExpression(callee) || callee.name.text !== 'click') return false;
  const receiver = unwrap(callee.expression);
  if (isThemeLocatorCall(receiver) || isThemeElementCall(receiver)) return true;
  return !!receiver && ts.isIdentifier(receiver) && aliases.has(receiver.text);
}

function isSettleCall(node) {
  if (!ts.isCallExpression(node)) return false;
  const callee = node.expression;
  if (ts.isIdentifier(callee)) return callee.text === 'waitForThemeSettled';
  return ts.isPropertyAccessExpression(callee) && callee.name.text === 'waitForThemeSettled';
}

// `.analyze()` on a chain rooted at `new AxeBuilder(...)`.
function isAxeAnalyze(node) {
  if (!ts.isCallExpression(node)) return false;
  const callee = node.expression;
  if (!ts.isPropertyAccessExpression(callee) || callee.name.text !== 'analyze') return false;
  let current = unwrap(callee.expression);
  while (current) {
    if (ts.isNewExpression(current)) {
      return !!current.expression && ts.isIdentifier(current.expression)
        && current.expression.text === 'AxeBuilder';
    }
    if (ts.isCallExpression(current)) { current = unwrap(current.expression); continue; }
    if (ts.isPropertyAccessExpression(current)) { current = unwrap(current.expression); continue; }
    return false;
  }
  return false;
}

function lineOf(sourceFile, node) {
  return sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
}

function testNameOf(sourceFile, call) {
  const first = call.arguments[0];
  const text = first ? literalText(first) : null;
  if (text !== null) return text;
  if (!first) return '<unnamed test>';
  return sourceFile.text.slice(first.getStart(sourceFile), first.getEnd(sourceFile));
}

// The test callback: the first function-like argument, or a same-file
// helper referenced by name (e.g. `test('name', helper)`).
function testCallback(call, helpers) {
  for (const argument of call.arguments.slice(1)) {
    if (isFunctionLike(argument)) return argument;
    if (ts.isIdentifier(argument) && helpers.has(argument.text)) return helpers.get(argument.text);
  }
  return null;
}

function isTestCall(node) {
  if (!ts.isCallExpression(node)) return false;
  const callee = node.expression;
  if (ts.isIdentifier(callee)) return callee.text === 'test' && node.arguments.length >= 2;
  if (ts.isPropertyAccessExpression(callee)
    && ts.isIdentifier(callee.expression) && callee.expression.text === 'test'
    && ['only', 'skip', 'fixme'].includes(callee.name.text)) {
    return node.arguments.length >= 2;
  }
  return false;
}

// Same-file helpers: top-level (or describe-level) function declarations
// and `const name = async (...) => {...}` / `function(...) {...}`
// declarators. Functions declared inside a test body are local to that
// test and are not collected — walking into a test callback is skipped.
function collectHelpers(sourceFile) {
  const helpers = new Map();
  const visit = (node) => {
    if (isTestCall(node)) return;
    if (ts.isFunctionDeclaration(node) && node.name && node.body) {
      if (!helpers.has(node.name.text)) helpers.set(node.name.text, node);
    }
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && isFunctionLike(node.initializer)) {
      if (!helpers.has(node.name.text)) helpers.set(node.name.text, node.initializer);
    }
    node.forEachChild(visit);
  };
  visit(sourceFile);
  return helpers;
}

// Linearise one function body's events in source order. `aliases` is the
// frame-local set of theme-toggle aliases; `stack` is the set of helpers
// currently being expanded (cycle cut). Events are appended to `events`.
//
// Helpers declared inside the frame (`const local = async () => {...}` and
// `function local() {...}`) are registered, not expanded, at their
// definition point — their events happen at the call site, not where the
// function is declared. The same applies to nested blocks: a function
// declaration directly inside a block is pre-registered (they hoist),
// while a `const` arrow function is registered in statement order.
function collectEvents(body, sourceFile, helpers, aliases, events, stack) {
  const locals = new Map();
  const visit = (node, frameAliases) => {
    if (!node) return;
    if (ts.isCallExpression(node)) {
      const callee = node.expression;
      // Expand a helper call at this position — same-file helper, or a
      // helper declared in this frame. Its arguments evaluate before the
      // call, so visit them first, then the body.
      if (ts.isIdentifier(callee) && !stack.has(callee.text)) {
        const helper = locals.get(callee.text) ?? helpers.get(callee.text);
        if (helper) {
          for (const argument of node.arguments) visit(argument, frameAliases);
          stack.add(callee.text);
          collectEvents(helper.body, sourceFile, helpers, new Set(), events, stack);
          stack.delete(callee.text);
          return;
        }
      }
      if (isToggleClick(node, frameAliases)) {
        events.push({ kind: 'toggle', line: lineOf(sourceFile, node) });
      } else if (isSettleCall(node)) {
        events.push({ kind: 'settle', line: lineOf(sourceFile, node) });
      } else if (isAxeAnalyze(node)) {
        events.push({ kind: 'axe', line: lineOf(sourceFile, node) });
      }
      node.forEachChild((child) => visit(child, frameAliases));
      return;
    }
    if (ts.isBlock(node)) {
      // Pre-register function declarations directly in this block: they
      // hoist, so a call above the declaration still reaches their body.
      node.forEachChild((child) => {
        if (ts.isFunctionDeclaration(child) && child.name) locals.set(child.name.text, child);
      });
      node.forEachChild((child) => visit(child, frameAliases));
      return;
    }
    if (ts.isFunctionDeclaration(node)) {
      if (node.name) locals.set(node.name.text, node);
      return;
    }
    if (ts.isVariableDeclaration(node)) {
      if (ts.isIdentifier(node.name) && isFunctionLike(node.initializer)) {
        locals.set(node.name.text, node.initializer);
        return;
      }
      // `const toggle = page.locator('#themeToggle')`, `const btn = toggle`.
      const init = node.initializer ? unwrap(node.initializer) : null;
      if (ts.isIdentifier(node.name) && init
        && (isThemeLocatorCall(init) || isThemeElementCall(init)
          || (ts.isIdentifier(init) && frameAliases.has(init.text)))) {
        frameAliases.add(node.name.text);
      }
      node.forEachChild((child) => visit(child, frameAliases));
      return;
    }
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
      if (ts.isIdentifier(node.left) && isFunctionLike(node.right)) {
        locals.set(node.left.text, node.right);
        return;
      }
      // `toggle = page.locator('#themeToggle')` reassignment.
      const right = unwrap(node.right);
      if (ts.isIdentifier(node.left)
        && (isThemeLocatorCall(right) || isThemeElementCall(right)
          || (ts.isIdentifier(right) && frameAliases.has(right.text)))) {
        frameAliases.add(node.left.text);
      }
      node.forEachChild((child) => visit(child, frameAliases));
      return;
    }
    if (isFunctionLike(node)) {
      // A nested callback (e.g. the `page.evaluate(() => ...)` arrow) runs
      // as part of this test's sequence, but its alias bindings are its
      // own frame. Local helpers registered in this frame stay visible
      // to it: a callback that calls a test-local helper expands it.
      if (node.body) visit(node.body, new Set());
      return;
    }
    node.forEachChild((child) => visit(child, frameAliases));
  };
  if (!body) return;
  visit(body, aliases);
}

function checkTest(sourceFile, call, helpers, relPath) {
  const callback = testCallback(call, helpers);
  if (!callback || !callback.body) return [];
  const events = [];
  collectEvents(callback.body, sourceFile, helpers, new Set(), events, new Set());
  const violations = [];
  for (let index = 0; index < events.length; index += 1) {
    if (events[index].kind !== 'toggle') continue;
    const axe = events.slice(index + 1).find((event) => event.kind === 'axe');
    if (!axe) continue;
    const settled = events.slice(index + 1, events.indexOf(axe))
      .some((event) => event.kind === 'settle');
    if (settled) continue;
    violations.push(
      `${relPath}:${events[index].line} test "${testNameOf(sourceFile, call)}": `
      + `theme toggle at line ${events[index].line} reaches axe at line ${axe.line} `
      + 'without an intervening waitForThemeSettled',
    );
  }
  return violations;
}

export function checkThemeToggleAxeSource(source, relPath = 'fixture.spec.ts') {
  const sourceFile = ts.createSourceFile(
    relPath, String(source ?? ''), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS,
  );
  const diagnostics = sourceFile.parseDiagnostics ?? [];
  if (diagnostics.length > 0) {
    return diagnostics.map((diagnostic) => {
      const message = ts.flattenDiagnosticMessageText(diagnostic.messageText, ' ');
      const line = diagnostic.start !== undefined
        ? sourceFile.getLineAndCharacterOfPosition(diagnostic.start).line + 1
        : 1;
      return `${relPath}:${line} TypeScript parse error: ${message}`;
    });
  }
  const helpers = collectHelpers(sourceFile);
  const violations = [];
  const visit = (node) => {
    if (isTestCall(node)) {
      violations.push(...checkTest(sourceFile, node, helpers, relPath));
      // Do not walk into the test body again looking for nested tests.
      return;
    }
    node.forEachChild(visit);
  };
  visit(sourceFile);
  return violations;
}

export function collectSpecFiles(directory) {
  const found = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.isFile() && entry.name.endsWith('.spec.ts')) found.push(path);
    }
  };
  walk(directory);
  return found.sort();
}

function checkPaths(paths, base = process.cwd()) {
  const violations = [];
  for (const target of paths) {
    const stat = statSync(target, { throwIfNoEntry: false });
    if (!stat) {
      violations.push(`${target} does not exist`);
      continue;
    }
    const files = stat.isFile() ? [target] : collectSpecFiles(target);
    for (const file of files) {
      const rel = relative(base, file) || file;
      violations.push(...checkThemeToggleAxeSource(readFileSync(file, 'utf8'), rel));
    }
  }
  return violations;
}

export function inspectThemeToggleAxeGuard(rootDirectory = process.cwd()) {
  const root = resolve(rootDirectory);
  const e2e = join(root, 'tests', 'e2e');
  const stat = statSync(e2e, { throwIfNoEntry: false });
  if (!stat || !stat.isDirectory()) {
    return [`tests/e2e directory not found under ${root}`];
  }
  return checkPaths([e2e], root);
}

function main() {
  const args = process.argv.slice(2);
  const errors = args.length > 0
    ? checkPaths(args.map((arg) => resolve(arg)))
    : inspectThemeToggleAxeGuard(process.cwd());
  if (errors.length > 0) {
    process.stderr.write(`${JSON.stringify({
      ok: false, gate: GATE, providerNetworkRequired: false, externalMutation: false, errors,
    }, null, 2)}\n`);
    process.exitCode = 1;
    return;
  }
  process.stdout.write(`${JSON.stringify({
    ok: true, gate: GATE, providerNetworkRequired: false, externalMutation: false,
  })}\n`);
}

if (import.meta.url === pathToFileURL(resolve(process.argv[1] || '')).href) main();
