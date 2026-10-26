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
// order, expanding helper calls in place, and requires that every theme
// toggle with a later axe in the same test has a waitForThemeSettled
// between the toggle and that axe.
//
// Events:
// - toggle: `.click()` on `*.locator('#themeToggle')`, on an alias bound to
//   that locator (`const toggle = ...; toggle.click()`), on
//   `document.getElementById('themeToggle')` / `document.querySelector(
//   '#themeToggle')` (the `page.evaluate(...)` form the golden specs use),
//   on `page.getByTestId('themeToggle')`, on `page.click('#themeToggle')`,
//   or a `dispatchEvent('click')` on one of those theme locators. Selector
//   strings may come through a `const sel = '#themeToggle'` binding, and
//   trailing `.first()` / `.nth(n)` / `.last()` on the locator are unwrapped.
//   Only string-literal (or constant-propagated) selectors are recognised,
//   and merely locating the toggle (`toBeVisible()`,
//   `toHaveAttribute(...)`, `toBeFocused()`) is not a click. Non-theme
//   toggles (`#authPassToggle`) are not theme toggles.
// - settle: a call to `waitForThemeSettled` (by name, wherever it is
//   imported from — the shared helper in tests/e2e/golden-theme-settle.ts),
//   through an alias bound to it (`const s = waitForThemeSettled; s(...)`),
//   or through an import renamed to that name.
// - axe: `.analyze()` on a `new AxeBuilder(...)` chain, directly, through an
//   identifier bound to such a chain (`const a = new AxeBuilder(...);
//   a.analyze()`), or through the same shapes with `AxeBuilder` imported
//   under another name (`import MyAxe from '@axe-core/playwright'`).
//
// Helpers: a helper is only judged as part of a calling test: a helper
// that contains axe but no toggle (golden-public-pages' `expectAccessible`,
// which drives the theme with `emulateMedia({colorScheme})` on no-script
// pages) needs no settle, and a helper that contains toggle + settle + axe
// (account-deletion / data-export `expectAccessible`) makes a test that
// only calls the helper compliant. Theme presets via `randori-theme` in
// localStorage before `goto` are not clicks and are ignored, as is
// `emulateMedia`.
//
// Helpers are expanded wherever they are declared or imported from:
// same-file helpers, helpers declared inside the test, and helpers imported
// through a relative same-directory import (`./helper`) — the imported
// file is parsed and its helpers expanded like same-file ones, including
// helpers that file itself imports from its own directory (transitively,
// cycle-cut). A helper call binds its arguments to the helper's parameters
// (`clickIt(toggle)`, where the helper does `btn.click()`), and a helper
// declared inside a test closes over the caller's aliases / string
// constants. Module-level and imported helpers do NOT close over the
// caller: they get a fresh frame seeded with their own module's
// `waitForThemeSettled` import aliases, plus the parameter bindings.
//
// Hooks: `test.beforeEach` / `test.beforeAll` callbacks at file scope and
// inside `test.describe` blocks are collected per scope and their events
// are prepended to every test in that scope (outer scopes first, beforeAll
// before beforeEach within a scope). A settle that ran in a hook before
// the test's toggle does not cover that toggle; a toggle in a hook
// reaches an axe in the test.
//
// Known limitations (documented, not silently assumed):
// - Statements are linearised in source order: branches and loops are
//   flattened, so a toggle inside an `if` counts, and a settle after that
//   `if` counts for it. A settle inside a *different* branch than the
//   toggle would also count — the guard does not do path-sensitive
//   branch analysis. The current tree has no such shape.
// - Only relative same-directory imports (`./helper`) are resolved.
//   Helpers imported from another directory (`../support/...`,
//   `../../api/...`) stay opaque, except `waitForThemeSettled`,
//   recognised by name. No helper imported that way in tests/e2e
//   contains a toggle or an axe run.
// - An imported file that cannot be parsed fails closed: the spec gets
//   a violation naming the unparseable helper file.
// - Alias tracking deletes on reassignment: an alias rebound to a
//   non-theme locator, a non-literal string, or a non-AxeBuilder value
//   stops counting. Block scoping is not modelled — the frame is
//   function-wide.
// - Selectors must be string literals or constants bound (transitively)
//   to string literals (`'#themeToggle'`, `'themeToggle'`). Template
//   literals with substitutions and concatenated selectors are not
//   recognised, and fail open — a violation using one of those shapes
//   would not be flagged.
// - Helpers declared inside a test body are expanded at their call site,
//   not at their definition point; a helper that is never called
//   contributes no events. Callbacks passed as arguments (e.g. the
//   `page.evaluate(() => ...)` arrow) are linearised inline at the call.
// - Recursive helper calls expand once; the recursive re-entry is opaque.
// - A settle is only credited when it sits between a toggle and the next
//   axe after that toggle. A settle before the toggle, or after the axe,
//   does not count, and one settle does not cover a toggle after it.

import { readdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
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

// The frame-local state of one function body: aliases bound to the theme
// locator, string constants, identifiers bound to an AxeBuilder chain, and
// identifiers bound to waitForThemeSettled. Frames are copied at function
// boundaries so a callee's rebinding never leaks back to the caller.
function freshFrame(module) {
  return {
    aliases: new Set(),
    consts: new Map(),
    axeVars: new Set(),
    settleVars: new Set(module ? module.settleImportNames : []),
  };
}

function copyFrame(frame) {
  return {
    aliases: new Set(frame.aliases),
    consts: new Map(frame.consts),
    axeVars: new Set(frame.axeVars),
    settleVars: new Set(frame.settleVars),
  };
}

// Identifier parameter names of a function-like node (binding patterns
// have no single name and are left unbound).
function paramNames(node) {
  if (!node || !node.parameters) return [];
  return node.parameters
    .filter((param) => ts.isIdentifier(param.name))
    .map((param) => param.name.text);
}

// A string literal, or an identifier bound to one in this frame.
function resolveString(node, frame) {
  const target = unwrap(node);
  if (!target) return null;
  const literal = literalText(target);
  if (literal !== null) return literal;
  if (frame && ts.isIdentifier(target)) return frame.consts.get(target.text) ?? null;
  return null;
}

// `*.locator('#themeToggle')` / `*.getByTestId('themeToggle')` — any
// receiver, string-literal (or constant-propagated) selector only.
function isThemeLocatorCall(node, frame) {
  const target = unwrap(node);
  if (!target || !ts.isCallExpression(target)) return false;
  const callee = target.expression;
  if (!ts.isPropertyAccessExpression(callee)) return false;
  if (callee.name.text === 'locator') {
    return resolveString(target.arguments[0], frame) === THEME_SELECTOR;
  }
  if (callee.name.text === 'getByTestId') {
    return resolveString(target.arguments[0], frame) === THEME_ELEMENT_ID;
  }
  return false;
}

// `*.getElementById('themeToggle')` or `*.querySelector('#themeToggle')`.
function isThemeElementCall(node, frame) {
  const target = unwrap(node);
  if (!target || !ts.isCallExpression(target)) return false;
  const callee = target.expression;
  if (!ts.isPropertyAccessExpression(callee)) return false;
  if (callee.name.text === 'getElementById') {
    return resolveString(target.arguments[0], frame) === THEME_ELEMENT_ID;
  }
  if (callee.name.text === 'querySelector') {
    return resolveString(target.arguments[0], frame) === THEME_SELECTOR;
  }
  return false;
}

// Strip trailing `.first()` / `.nth(n)` / `.last()` locator calls.
function unwrapToggleReceiver(receiver) {
  let current = unwrap(receiver);
  while (current && ts.isCallExpression(current)) {
    const callee = current.expression;
    if (ts.isPropertyAccessExpression(callee)
      && ['first', 'nth', 'last'].includes(callee.name.text)) {
      current = unwrap(callee.expression);
      continue;
    }
    break;
  }
  return current;
}

function isToggleClick(node, frame) {
  if (!ts.isCallExpression(node)) return false;
  const callee = node.expression;
  if (!ts.isPropertyAccessExpression(callee)) return false;
  if (callee.name.text === 'click') {
    const receiver = unwrapToggleReceiver(callee.expression);
    if (isThemeLocatorCall(receiver, frame) || isThemeElementCall(receiver, frame)) return true;
    if (receiver && ts.isIdentifier(receiver) && frame.aliases.has(receiver.text)) return true;
    // `page.click('#themeToggle')` — the selector is the first argument.
    return node.arguments.length >= 1
      && resolveString(node.arguments[0], frame) === THEME_SELECTOR;
  }
  if (callee.name.text === 'dispatchEvent') {
    const receiver = unwrapToggleReceiver(callee.expression);
    const onTheme = isThemeLocatorCall(receiver, frame) || isThemeElementCall(receiver, frame)
      || (!!receiver && ts.isIdentifier(receiver) && frame.aliases.has(receiver.text));
    if (onTheme) return resolveString(node.arguments[0], frame) === 'click';
    // `page.dispatchEvent('#themeToggle', 'click')`.
    return node.arguments.length >= 2
      && resolveString(node.arguments[0], frame) === THEME_SELECTOR
      && resolveString(node.arguments[1], frame) === 'click';
  }
  return false;
}

function isSettleReference(node, frame) {
  const target = unwrap(node);
  if (!target) return false;
  if (ts.isIdentifier(target)) {
    return target.text === 'waitForThemeSettled' || frame.settleVars.has(target.text);
  }
  return ts.isPropertyAccessExpression(target) && target.name.text === 'waitForThemeSettled';
}

function isSettleCall(node, frame) {
  if (!ts.isCallExpression(node)) return false;
  return isSettleReference(node.expression, frame);
}

// A chain rooted at `new <AxeBuilder-name>(...)`, walking through
// `.include(...)` / `.withTags(...)` / other chained calls.
function isAxeBuilderChain(node, module) {
  let current = unwrap(node);
  while (current) {
    if (ts.isNewExpression(current)) {
      const ctor = current.expression;
      if (ctor && ts.isIdentifier(ctor)) {
        return ctor.text === 'AxeBuilder' || module.axeConstructorNames.has(ctor.text);
      }
      if (ctor && ts.isPropertyAccessExpression(ctor)
        && ts.isIdentifier(ctor.expression)
        && module.axeNamespaces.has(ctor.expression.text)
        && ['AxeBuilder', 'default'].includes(ctor.name.text)) return true;
      return false;
    }
    if (ts.isCallExpression(current)) { current = unwrap(current.expression); continue; }
    if (ts.isPropertyAccessExpression(current)) { current = unwrap(current.expression); continue; }
    return false;
  }
  return false;
}

// `.analyze()` on a chain rooted at `new AxeBuilder(...)`, or on an
// identifier bound to such a chain (`const a = new AxeBuilder(...);`).
function isAxeAnalyze(node, frame, module) {
  if (!ts.isCallExpression(node)) return false;
  const callee = node.expression;
  if (!ts.isPropertyAccessExpression(callee) || callee.name.text !== 'analyze') return false;
  const receiver = unwrap(callee.expression);
  if (isAxeBuilderChain(receiver, module)) return true;
  let root = receiver;
  while (root && (ts.isCallExpression(root) || ts.isPropertyAccessExpression(root))) {
    root = unwrap(root.expression);
  }
  return !!root && ts.isIdentifier(root) && frame.axeVars.has(root.text);
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

// Same-file helpers: top-level (or describe-level) function declarations
// and `const name = async (...) => {...}` / `function(...) {...}`
// declarators, plus `export default` functions (under the key 'default')
// and same-file `export { foo as bar }` aliases. Functions declared inside
// a test body are local to that test and are not collected — walking into
// a test callback is skipped.
function collectHelpers(sourceFile) {
  const helpers = new Map();
  const visit = (node) => {
    if (isTestCall(node)) return;
    if (ts.isFunctionDeclaration(node) && node.body) {
      if (node.name) {
        if (!helpers.has(node.name.text)) helpers.set(node.name.text, node);
      } else if (!helpers.has('default')) {
        helpers.set('default', node);
      }
    }
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && isFunctionLike(node.initializer)) {
      if (!helpers.has(node.name.text)) helpers.set(node.name.text, node.initializer);
    }
    if (ts.isExportAssignment(node) && !node.isExportEquals && isFunctionLike(node.expression)) {
      if (!helpers.has('default')) helpers.set('default', node.expression);
    }
    if (ts.isExportAssignment(node) && !node.isExportEquals
      && ts.isIdentifier(node.expression) && helpers.has(node.expression.text)) {
      if (!helpers.has('default')) helpers.set('default', helpers.get(node.expression.text));
    }
    node.forEachChild(visit);
  };
  visit(sourceFile);
  // `export { local as exported }` (no module specifier): alias the helper.
  const aliasPass = (node) => {
    if (ts.isExportDeclaration(node) && !node.moduleSpecifier && node.exportClause
      && ts.isNamedExports(node.exportClause)) {
      for (const specifier of node.exportClause.elements) {
        const local = specifier.propertyName ? specifier.propertyName.text : specifier.name.text;
        if (helpers.has(local) && !helpers.has(specifier.name.text)) {
          helpers.set(specifier.name.text, helpers.get(local));
        }
      }
    }
    node.forEachChild(aliasPass);
  };
  aliasPass(sourceFile);
  return helpers;
}

// Import bindings: local name -> { importedName, specifier, namespace }.
// Also collected: the local names that construct AxeBuilder (default or
// named import from '@axe-core/playwright', plus 'AxeBuilder' itself),
// namespace imports of that module, local names imported as
// `waitForThemeSettled`, and `export ... from './...'` re-exports.
function collectImports(sourceFile) {
  const imports = new Map();
  const reExports = new Map();
  const axeConstructorNames = new Set(['AxeBuilder']);
  const axeNamespaces = new Set();
  const settleImportNames = new Set();
  const visit = (node) => {
    if (ts.isImportDeclaration(node) && node.importClause && node.moduleSpecifier) {
      const specifier = literalText(node.moduleSpecifier);
      if (specifier !== null) {
        const clause = node.importClause;
        if (clause.name) {
          imports.set(clause.name.text, { importedName: 'default', specifier, namespace: false });
          if (specifier === '@axe-core/playwright') axeConstructorNames.add(clause.name.text);
        }
        if (clause.namedBindings) {
          if (ts.isNamespaceImport(clause.namedBindings)) {
            imports.set(clause.namedBindings.name.text,
              { importedName: '*', specifier, namespace: true });
            if (specifier === '@axe-core/playwright') axeNamespaces.add(clause.namedBindings.name.text);
          } else if (ts.isNamedImports(clause.namedBindings)) {
            for (const element of clause.namedBindings.elements) {
              const importedName = element.propertyName ? element.propertyName.text : element.name.text;
              imports.set(element.name.text, { importedName, specifier, namespace: false });
              if (specifier === '@axe-core/playwright'
                && (importedName === 'AxeBuilder' || importedName === 'default')) {
                axeConstructorNames.add(element.name.text);
              }
              if (importedName === 'waitForThemeSettled') settleImportNames.add(element.name.text);
            }
          }
        }
      }
    }
    if (ts.isExportDeclaration(node) && node.moduleSpecifier && node.exportClause
      && ts.isNamedExports(node.exportClause)) {
      const specifier = literalText(node.moduleSpecifier);
      if (specifier !== null) {
        for (const element of node.exportClause.elements) {
          const importedName = element.propertyName ? element.propertyName.text : element.name.text;
          reExports.set(element.name.text, { importedName, specifier });
        }
      }
    }
    node.forEachChild(visit);
  };
  visit(sourceFile);
  return { imports, reExports, axeConstructorNames, axeNamespaces, settleImportNames };
}

// A relative import that stays in the same directory: `./helper`.
function isSameDirSpecifier(specifier) {
  return /^\.\/[^/]+$/.test(specifier);
}

function parseSource(source, relPath) {
  const sourceFile = ts.createSourceFile(
    relPath, String(source ?? ''), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS,
  );
  const diagnostics = sourceFile.parseDiagnostics ?? [];
  return { sourceFile, parseErrors: diagnostics };
}

// One parsed file: its helpers, its import bindings, and the modules its
// same-directory imports resolved to (transitively, cycle-cut by the
// loader's `building` set).
function buildModule(source, relPath, load) {
  const { sourceFile, parseErrors } = parseSource(source, relPath);
  const helpers = collectHelpers(sourceFile);
  const collected = collectImports(sourceFile);
  const module = {
    relPath,
    sourceFile,
    parseErrors,
    helpers,
    imports: collected.imports,
    reExports: collected.reExports,
    axeConstructorNames: collected.axeConstructorNames,
    axeNamespaces: collected.axeNamespaces,
    settleImportNames: collected.settleImportNames,
    importedModules: new Map(),
  };
  const specifiers = new Set([
    ...[...collected.imports.values()].map((binding) => binding.specifier),
    ...[...collected.reExports.values()].map((binding) => binding.specifier),
  ]);
  for (const specifier of specifiers) {
    if (isSameDirSpecifier(specifier)) {
      module.importedModules.set(specifier, load(specifier, relPath));
    }
  }
  return module;
}

// Resolves same-directory imports through `resolver`:
// `(specifier, fromRelPath) => { source, relPath } | null`. When no
// resolver is given, imported helpers stay opaque. Modules are cached
// per top-level check so a shared helper file is parsed once per spec.
function createModuleLoader(resolver) {
  const cache = new Map();
  const building = new Set();
  const load = (specifier, fromRelPath) => {
    if (!resolver) return null;
    const resolved = resolver(specifier, fromRelPath);
    if (!resolved) return null;
    if (cache.has(resolved.relPath)) return cache.get(resolved.relPath);
    if (building.has(resolved.relPath)) return null;
    building.add(resolved.relPath);
    const module = buildModule(resolved.source, resolved.relPath, load);
    building.delete(resolved.relPath);
    cache.set(resolved.relPath, module);
    return module;
  };
  return { load, modules: () => [...cache.values()] };
}

// A filesystem resolver for same-directory imports: tries the usual
// extensions and an index file, and reports paths relative to `base`.
export function createFileImportResolver(base = process.cwd()) {
  const extensions = ['.ts', '.tsx', '.mts', '.cts', '.js', '.mjs', '.cjs'];
  return (specifier, fromRelPath) => {
    if (!isSameDirSpecifier(specifier)) return null;
    const dir = dirname(resolve(base, fromRelPath));
    const candidates = [
      ...extensions.map((ext) => join(dir, `${specifier}${ext}`)),
      ...extensions.map((ext) => join(dir, specifier, `index${ext}`)),
    ];
    for (const candidate of candidates) {
      const stat = statSync(candidate, { throwIfNoEntry: false });
      if (stat && stat.isFile()) {
        return { source: readFileSync(candidate, 'utf8'), relPath: relative(base, candidate) };
      }
    }
    return null;
  };
}

// Resolve an imported helper by its exported name, following re-exports.
function resolveImportedHelper(module, importedName) {
  if (!module) return null;
  if (module.helpers.has(importedName)) {
    return { node: module.helpers.get(importedName), module, key: importedName };
  }
  const reExport = module.reExports.get(importedName);
  if (reExport && module.importedModules.has(reExport.specifier)) {
    return resolveImportedHelper(
      module.importedModules.get(reExport.specifier), reExport.importedName,
    );
  }
  return null;
}

// A function reference: the function-like node plus the module it lives
// in, so line numbers and import bindings resolve in the right file.
function resolveFunctionRef(argument, module) {
  if (isFunctionLike(argument)) return { node: argument, module, key: null };
  if (ts.isIdentifier(argument)) {
    if (module.helpers.has(argument.text)) {
      return { node: module.helpers.get(argument.text), module, key: argument.text };
    }
    const binding = module.imports.get(argument.text);
    if (binding && !binding.namespace) {
      const imported = module.importedModules.get(binding.specifier);
      if (imported) return resolveImportedHelper(imported, binding.importedName);
    }
  }
  if (ts.isPropertyAccessExpression(argument) && ts.isIdentifier(argument.expression)) {
    const binding = module.imports.get(argument.expression.text);
    if (binding && binding.namespace) {
      const imported = module.importedModules.get(binding.specifier);
      if (imported) return resolveImportedHelper(imported, argument.name.text);
    }
  }
  return null;
}

// The test callback: the first function-like argument, or a same-file /
// imported helper referenced by name (e.g. `test('name', helper)`).
function testCallback(call, module) {
  for (const argument of call.arguments.slice(1)) {
    const ref = resolveFunctionRef(argument, module);
    if (ref) return ref;
  }
  return null;
}

function isTestCall(node) {
  if (!ts.isCallExpression(node)) return false;
  const callee = node.expression;
  if (ts.isIdentifier(callee)) return callee.text === 'test' && node.arguments.length >= 2;
  if (ts.isPropertyAccessExpression(callee)
    && ts.isIdentifier(callee.expression) && callee.expression.text === 'test'
    && ['only', 'skip', 'fixme', 'serial'].includes(callee.name.text)) {
    return node.arguments.length >= 2;
  }
  return false;
}

// `test.describe(...)`, including `.serial` / `.parallel` / `.skip` chains.
function isDescribeCall(node) {
  if (!ts.isCallExpression(node)) return false;
  const names = [];
  let current = node.expression;
  while (ts.isPropertyAccessExpression(current)) {
    names.unshift(current.name.text);
    current = current.expression;
  }
  return ts.isIdentifier(current) && current.text === 'test' && names[0] === 'describe';
}

function describeCallback(call, module) {
  for (const argument of call.arguments) {
    const ref = resolveFunctionRef(argument, module);
    if (ref) return ref;
  }
  return null;
}

function isHookCall(node) {
  if (!ts.isCallExpression(node)) return false;
  const callee = node.expression;
  return ts.isPropertyAccessExpression(callee)
    && ts.isIdentifier(callee.expression) && callee.expression.text === 'test'
    && ['beforeEach', 'beforeAll'].includes(callee.name.text);
}

// Bind a helper's parameters to the call-site arguments in a fresh frame:
// an argument that is (or is bound to) a theme alias / string constant /
// AxeBuilder chain / settle reference makes the parameter one too.
function applyParamBinding(frame, fnNode, callArgs, callerFrame, callerModule) {
  const params = paramNames(fnNode);
  for (const param of params) {
    frame.aliases.delete(param);
    frame.consts.delete(param);
    frame.axeVars.delete(param);
    frame.settleVars.delete(param);
  }
  params.forEach((param, index) => {
    const argument = callArgs[index];
    if (!argument) return;
    const target = unwrap(argument);
    if (ts.isIdentifier(target)) {
      if (callerFrame.aliases.has(target.text)) frame.aliases.add(param);
      if (callerFrame.consts.has(target.text)) frame.consts.set(param, callerFrame.consts.get(target.text));
      if (callerFrame.axeVars.has(target.text)) frame.axeVars.add(param);
      if (callerFrame.settleVars.has(target.text)) frame.settleVars.add(param);
      return;
    }
    if (isThemeLocatorCall(target, callerFrame) || isThemeElementCall(target, callerFrame)) {
      frame.aliases.add(param);
    }
    const text = resolveString(target, callerFrame);
    if (text !== null) frame.consts.set(param, text);
    if (callerModule && isAxeBuilderChain(target, callerModule)) frame.axeVars.add(param);
    if (isSettleReference(target, callerFrame)) frame.settleVars.add(param);
  });
}

// Classify a variable's initializer into the frame sets it belongs to (or
// none). A binding that classifies as none deletes the name from every set:
// a fresh `const`/`let` (or an assignment) shadows/rebinds the name.
function classifyBinding(frame, module, name, init) {
  const target = init ? unwrap(init) : null;
  if (!target) return;
  if (ts.isIdentifier(target)) {
    if (target.text === 'waitForThemeSettled' || frame.settleVars.has(target.text)) {
      frame.settleVars.add(name);
      return;
    }
    if (frame.aliases.has(target.text)) { frame.aliases.add(name); return; }
    if (frame.consts.has(target.text)) { frame.consts.set(name, frame.consts.get(target.text)); return; }
    if (frame.axeVars.has(target.text)) { frame.axeVars.add(name); return; }
    frame.aliases.delete(name);
    frame.consts.delete(name);
    frame.axeVars.delete(name);
    frame.settleVars.delete(name);
    return;
  }
  if (literalText(target) !== null) {
    frame.consts.set(name, literalText(target));
    frame.aliases.delete(name);
    frame.axeVars.delete(name);
    frame.settleVars.delete(name);
    return;
  }
  if (isThemeLocatorCall(target, frame) || isThemeElementCall(target, frame)) {
    frame.aliases.add(name);
    frame.consts.delete(name);
    frame.axeVars.delete(name);
    frame.settleVars.delete(name);
    return;
  }
  if (isAxeBuilderChain(target, module)) {
    frame.axeVars.add(name);
    frame.aliases.delete(name);
    frame.consts.delete(name);
    frame.settleVars.delete(name);
    return;
  }
  if (isSettleReference(target, frame)) {
    frame.settleVars.add(name);
    frame.aliases.delete(name);
    frame.consts.delete(name);
    frame.axeVars.delete(name);
    return;
  }
  frame.aliases.delete(name);
  frame.consts.delete(name);
  frame.axeVars.delete(name);
  frame.settleVars.delete(name);
}

// Linearise one function body's events in source order. `frame` is the
// frame-local state; `stack` is the set of helpers currently being
// expanded (cycle cut). Events are appended to `events`.
//
// Helpers declared inside the frame (`const local = async () => {...}` and
// `function local() {...}`) are registered, not expanded, at their
// definition point — their events happen at the call site, not where the
// function is declared. The same applies to nested blocks: a function
// declaration directly inside a block is pre-registered (they hoist),
// while a `const` arrow function is registered in statement order.
function collectEvents(body, module, frame, events, stack) {
  const locals = new Map();
  const visit = (node, currentFrame) => {
    if (!node) return;
    if (ts.isCallExpression(node)) {
      const callee = node.expression;
      // A settle call is an event, never a helper to expand: the shared
      // `waitForThemeSettled` helper is itself imported (from
      // ./golden-theme-settle), so expanding it would swallow the settle
      // event its body never re-emits.
      if (isSettleCall(node, currentFrame)) {
        events.push({ kind: 'settle', line: lineOf(module.sourceFile, node), file: module.relPath });
        node.forEachChild((child) => visit(child, currentFrame));
        return;
      }
      // Expand a helper call at this position. Its arguments evaluate
      // before the call, so visit them first, then the body.
      let ref = null;
      let refKey = null;
      let closeOverCaller = false;
      if (ts.isIdentifier(callee)) {
        if (locals.has(callee.text)) {
          ref = { node: locals.get(callee.text), module, key: callee.text };
          refKey = `${module.relPath}#${callee.text}`;
          closeOverCaller = true;
        } else if (module.helpers.has(callee.text)) {
          ref = { node: module.helpers.get(callee.text), module, key: callee.text };
          refKey = `${module.relPath}#${callee.text}`;
        } else {
          const binding = module.imports.get(callee.text);
          if (binding && !binding.namespace) {
            const imported = module.importedModules.get(binding.specifier);
            if (imported) {
              ref = resolveImportedHelper(imported, binding.importedName);
              if (ref) refKey = `${ref.module.relPath}#${ref.key}`;
            }
          }
        }
      } else if (ts.isPropertyAccessExpression(callee) && ts.isIdentifier(callee.expression)) {
        const binding = module.imports.get(callee.expression.text);
        if (binding && binding.namespace) {
          const imported = module.importedModules.get(binding.specifier);
          if (imported) {
            ref = resolveImportedHelper(imported, callee.name.text);
            if (ref) refKey = `${ref.module.relPath}#${ref.key}`;
          }
        }
      }
      if (ref && refKey && !stack.has(refKey)) {
        for (const argument of node.arguments) visit(argument, currentFrame);
        stack.add(refKey);
        // Test-local helpers close over the caller; module-level and
        // imported helpers get a fresh frame (their own module's settle
        // imports) plus the parameter bindings from this call.
        const helperFrame = closeOverCaller
          ? copyFrame(currentFrame)
          : freshFrame(ref.module);
        applyParamBinding(helperFrame, ref.node, node.arguments, currentFrame, module);
        collectEvents(ref.node.body, ref.module, helperFrame, events, stack);
        stack.delete(refKey);
        return;
      }
      if (isToggleClick(node, currentFrame)) {
        events.push({ kind: 'toggle', line: lineOf(module.sourceFile, node), file: module.relPath });
      } else if (isAxeAnalyze(node, currentFrame, module)) {
        events.push({ kind: 'axe', line: lineOf(module.sourceFile, node), file: module.relPath });
      }
      node.forEachChild((child) => visit(child, currentFrame));
      return;
    }
    if (ts.isBlock(node)) {
      // Pre-register function declarations directly in this block: they
      // hoist, so a call above the declaration still reaches their body.
      node.forEachChild((child) => {
        if (ts.isFunctionDeclaration(child) && child.name) locals.set(child.name.text, child);
      });
      node.forEachChild((child) => visit(child, currentFrame));
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
      if (ts.isIdentifier(node.name) && node.initializer) {
        classifyBinding(currentFrame, module, node.name.text, node.initializer);
      }
      node.forEachChild((child) => visit(child, currentFrame));
      return;
    }
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
      if (ts.isIdentifier(node.left) && isFunctionLike(node.right)) {
        locals.set(node.left.text, node.right);
        return;
      }
      // `toggle = page.locator('#themeToggle')` reassignment, and
      // reassignment to anything else deletes the alias (nit: an alias
      // rebound to a non-theme locator stops counting).
      if (ts.isIdentifier(node.left)) {
        classifyBinding(currentFrame, module, node.left.text, node.right);
      }
      node.forEachChild((child) => visit(child, currentFrame));
      return;
    }
    if (isFunctionLike(node)) {
      // A nested callback (e.g. the `page.evaluate(() => ...)` arrow) runs
      // as part of this test's sequence and closes over this frame, but
      // its parameters shadow the caller's names.
      const childFrame = copyFrame(currentFrame);
      for (const param of paramNames(node)) {
        childFrame.aliases.delete(param);
        childFrame.consts.delete(param);
        childFrame.axeVars.delete(param);
        childFrame.settleVars.delete(param);
      }
      if (node.body) visit(node.body, childFrame);
      return;
    }
    node.forEachChild((child) => visit(child, currentFrame));
  };
  if (!body) return;
  visit(body, frame);
}

function checkTest(call, module, hookEvents) {
  const ref = testCallback(call, module);
  if (!ref || !ref.node.body) return [];
  const events = [...hookEvents];
  collectEvents(ref.node.body, ref.module, freshFrame(ref.module), events, new Set());
  const violations = [];
  for (let index = 0; index < events.length; index += 1) {
    if (events[index].kind !== 'toggle') continue;
    const axe = events.slice(index + 1).find((event) => event.kind === 'axe');
    if (!axe) continue;
    const settled = events.slice(index + 1, events.indexOf(axe))
      .some((event) => event.kind === 'settle');
    if (settled) continue;
    const axeSuffix = axe.file === events[index].file ? '' : ` (axe in ${axe.file}:${axe.line})`;
    violations.push(
      `${events[index].file}:${events[index].line} test "${testNameOf(module.sourceFile, call)}": `
      + `theme toggle at line ${events[index].line} reaches axe at line ${axe.line}${axeSuffix} `
      + 'without an intervening waitForThemeSettled',
    );
  }
  return violations;
}

// Events of the `test.beforeEach` / `test.beforeAll` callbacks declared
// as direct statements of one scope (a file or a describe body).
function hookEventsFor(scopeBody, module) {
  const events = [];
  const statements = scopeBody && ts.isBlock(scopeBody)
    ? [...scopeBody.statements]
    : scopeBody && ts.isSourceFile(scopeBody) ? [...scopeBody.statements] : [];
  for (const statement of statements) {
    if (!ts.isExpressionStatement(statement)) continue;
    const call = statement.expression;
    if (!isHookCall(call)) continue;
    const ref = resolveFunctionRef(call.arguments[0], module);
    if (ref && ref.node.body) {
      collectEvents(ref.node.body, ref.module, freshFrame(ref.module), events, new Set());
    }
  }
  return events;
}

function collectViolations(module) {
  const violations = [];
  const walk = (node, inheritedHookEvents) => {
    if (isTestCall(node)) {
      violations.push(...checkTest(node, module, inheritedHookEvents));
      // Do not walk into the test body again looking for nested tests.
      return;
    }
    if (isDescribeCall(node)) {
      const ref = describeCallback(node, module);
      if (ref && ref.node.body && ts.isBlock(ref.node.body)) {
        const scopeHooks = hookEventsFor(ref.node.body, ref.module);
        walk(ref.node.body, [...inheritedHookEvents, ...scopeHooks]);
        return;
      }
    }
    if (isHookCall(node)) {
      // Hook bodies are expanded once per scope by hookEventsFor; do not
      // walk into them again here.
      return;
    }
    node.forEachChild((child) => walk(child, inheritedHookEvents));
  };
  const fileHooks = hookEventsFor(module.sourceFile, module);
  walk(module.sourceFile, fileHooks);
  return violations;
}

export function checkThemeToggleAxeSource(source, relPath = 'fixture.spec.ts', resolveImport) {
  const loader = createModuleLoader(
    typeof resolveImport === 'function' ? resolveImport : resolveImport?.resolveImport,
  );
  const root = buildModule(String(source ?? ''), relPath, loader.load);
  if (root.parseErrors.length > 0) {
    return root.parseErrors.map((diagnostic) => {
      const message = ts.flattenDiagnosticMessageText(diagnostic.messageText, ' ');
      const line = diagnostic.start !== undefined
        ? root.sourceFile.getLineAndCharacterOfPosition(diagnostic.start).line + 1
        : 1;
      return `${relPath}:${line} TypeScript parse error: ${message}`;
    });
  }
  const violations = [];
  for (const imported of loader.modules()) {
    if (imported.parseErrors.length > 0) {
      violations.push(
        `${relPath}:1 imported helper ${imported.relPath} has TypeScript parse errors `
        + 'and could not be checked',
      );
    }
  }
  violations.push(...collectViolations(root));
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
  const resolveImport = createFileImportResolver(base);
  for (const target of paths) {
    const stat = statSync(target, { throwIfNoEntry: false });
    if (!stat) {
      violations.push(`${target} does not exist`);
      continue;
    }
    const files = stat.isFile() ? [target] : collectSpecFiles(target);
    for (const file of files) {
      const rel = relative(base, file) || file;
      violations.push(...checkThemeToggleAxeSource(readFileSync(file, 'utf8'), rel, resolveImport));
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

// import.meta.url is the real (symlink-resolved) path, while
// process.argv[1] may be a logical / symlinked path (/tmp on macOS is
// /private/tmp, and a symlinked script path is not its realpath).
// Realpath the argv path before comparing, or an invocation through
// a symlinked path would silently do nothing (exit 0, no output).
function isMainModule() {
  try {
    return import.meta.url === pathToFileURL(realpathSync(process.argv[1] || '')).href;
  } catch {
    return false;
  }
}

if (isMainModule()) main();
