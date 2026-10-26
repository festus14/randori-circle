#!/usr/bin/env node
// Documentation drift check (issue #363): fails when the docs no longer
// match the code. It is generic — every list below is derived by scanning
// the repository at run time, with no hardcoded per-var/flag/link/ID lists.
// The structural constants that remain hardcoded (the required-doc list,
// the `## Feature flags` / `## Index` / Dispatch-inputs headings and the
// skipped directories) describe the repo's layout, not its contents.
//
// What it checks:
//  - Env vars read in api/, scripts/ and .github/workflows/ must be
//    documented in docs/ENVIRONMENT.md AND in .env.example, and every
//    documented var must still be read (except the small allowlist below).
//  - Every flag in the feature-flag table in docs/ENVIRONMENT.md must be
//    read in code, and every flag-shaped var read in code must be in the
//    table. A flag is a documented flag-table entry, or a code var ending
//    in _ENABLED.
//  - Every relative link in README.md and docs/**/*.md must point at an
//    existing file (or directory), and every #anchor must resolve in its
//    target, using GitHub's heading-slug rules.
//  - docs/IMPLEMENTED_DECISIONS.md: no duplicate IDs, entries and Index
//    rows both in numeric order, one Index row per entry and one entry
//    per Index row, and each Index row's title and anchor must match its
//    entry. The Index is found by its `## Index` heading, not by position.
//  - Every file under docs/ must be linked from docs/README.md, unless it
//    is archived: under docs/archive/ or in the archived allowlist below.
//
// Archived definition: a docs/ file is archived when its path starts with
// `docs/archive/` or it is listed in ARCHIVED_DOC_ALLOWLIST with a reason.
// Archiving is not a free exemption: a file under docs/archive/ must
// carry its reason in the file itself (a line `Archived: <reason>`,
// e.g. in an HTML comment) or in a reasoned entry for it in
// docs/archive/README.md, and an allowlist entry must have a
// non-empty reason — the checker enforces both, so "with a reason"
// is a checkable requirement, not a comment.
// There is no docs/archive/ on main today; the definition still applies
// the day the first file is archived, with no check change.
//
// Allowlist discipline: DOCUMENTED_BUT_UNREAD_ALLOWLIST holds vars that
// are documented but deliberately not read by the scanned code, with the
// reason why. It is keyed by var name with a reason, never by file, and
// it never excuses a var the code reads but the docs omit.
//
// Known limitations (documented, not silently assumed):
// - Env reads are resolved per file, scope-aware for function
//   parameters / local declarations (see codeVarsFromJs). A name proved
//   to be process.env in one scope does not prove the same name in a
//   shadowing scope, and a function parameter is proved only when it
//   defaults to process.env, is assigned process.env, is passed a
//   proved value at a same-file call site, or is passed a proved value
//   at a cross-file call site through a direct import (including
//   namespace calls). Dynamic imports, method calls on objects
//   (`obj.helper(process.env)`), and calls through higher-order
//   wrappers are not tracked as proof.
// - Imported string-constant aliases (`process.env[FLAG]` where FLAG is
//   imported from another scanned file) are resolved through direct
//   imports and re-exports of string literals. Computed names,
//   dynamic imports, namespace-import member access beyond the
//   `ns.FLAG` form, and aliases from outside the scanned files are not
//   resolved.
// - Link destinations with nested brackets in the link text are not
//   parsed; indented (four-space) code blocks are not treated as
//   fenced code, so a link-looking example there still counts as a
//   link.
// - Only uppercase env names are tracked; a lowercase
//   `process.env.foo` read, a computed bracket name
//   (`process.env['A' + 'B']`), and enumeration of the whole
//   environment (`Object.keys(process.env)`, `for … in`) are not
//   resolved to individual vars.
// - Symlinked directories are not followed when walking the repo (a
//   symlinked file is followed); a symlinked directory's contents are
//   not scanned.

import { readdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { posix, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export const ARCHIVED_DOC_PREFIX = 'docs/archive/';

// Docs files that count as archived even though they are not under
// docs/archive/. Empty on main: no doc needs this exception today.
export const ARCHIVED_DOC_ALLOWLIST = Object.freeze(new Map());

// Documented vars the scanned code deliberately does not read. Each entry
// needs a reason; a var is allowlisted only for the documented-but-unread
// direction, never for the read-but-undocumented direction.
export const DOCUMENTED_BUT_UNREAD_ALLOWLIST = Object.freeze(new Map([
  ['COVERAGE_DEBUG', 'test harness only (tests/support/coverage.mjs); outside the api/, scripts/, .github/workflows/ scan scope'],
  ['E2E_PORT', 'test harness only (tests/ and playwright.config.js); outside the scan scope'],
  ['RANDORI_MIGRATED_TEMPLATE_CACHE', 'test harness only (tests/support/migrated-db.mjs); outside the scan scope'],
  ['TWILIO_AUTH_TOKEN', 'documented as intentionally unread: npm run dev blanks the ambient value so it cannot leak into the process'],
]));

const ENV_NAME = '[A-Z][A-Z0-9_]*';
const DOCS_INDEX_PATH = 'docs/README.md';
const DECISIONS_PATH = 'docs/IMPLEMENTED_DECISIONS.md';
const ENVIRONMENT_PATH = 'docs/ENVIRONMENT.md';
const ENV_EXAMPLE_PATH = '.env.example';
const ROOT_README_PATH = 'README.md';
const REQUIRED_DOCS = Object.freeze([
  ROOT_README_PATH,
  DOCS_INDEX_PATH,
  ENVIRONMENT_PATH,
  DECISIONS_PATH,
  ENV_EXAMPLE_PATH,
]);
const SKIPPED_DIRS = new Set([
  'node_modules', '.git', '.local', 'test-results', 'playwright-report', '.vercel',
]);

function isRecord(value) {
  return value && typeof value === 'object' && !Array.isArray(value);
}

function sorted(values) {
  return [...values].sort();
}

function lineNumberBefore(text, index) {
  return text.slice(0, index).split('\n').length;
}

function errorAt(path, line, message) {
  return line ? `${path}:${line}: ${message}` : `${path}: ${message}`;
}

function isFenceLine(line) {
  return /^\s*(```|~~~)/.test(line);
}

// For each line, whether it lies inside a fenced code block (fence
// delimiter lines themselves are not "inside"). Fence state is tracked
// from the top of the file, so a block opened before a section still
// suppresses lines inside that section.
function fenceStates(lines) {
  const states = [];
  let inFence = false;
  for (const line of lines) {
    if (isFenceLine(line)) {
      states.push(false);
      inFence = !inFence;
      continue;
    }
    states.push(inFence);
  }
  return states;
}

// Split on top-level commas: commas inside (), [], {} or nested pairs
// do not split (used for parameter lists, argument lists and
// destructured bindings).
function splitTopLevelCommas(text) {
  const parts = [];
  let depth = 0;
  let start = 0;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (char === '(' || char === '[' || char === '{') depth += 1;
    else if (char === ')' || char === ']' || char === '}') depth -= 1;
    else if (char === ',' && depth === 0) {
      parts.push(text.slice(start, index));
      start = index + 1;
    }
  }
  parts.push(text.slice(start));
  return parts;
}

// Index of the closing delimiter matching the opening one at openIndex
// (paren, bracket or brace), or -1. Strings/comments are already blanked
// in stripped source, so a plain delimiter count is reliable.
function matchingClose(text, openIndex) {
  const open = text[openIndex];
  const close = open === '(' ? ')' : open === '[' ? ']' : open === '{' ? '}' : null;
  if (!close) return -1;
  let depth = 0;
  for (let index = openIndex; index < text.length; index += 1) {
    const char = text[index];
    if (char === '(' || char === '[' || char === '{') depth += 1;
    else if (char === ')' || char === ']' || char === '}') {
      depth -= 1;
      if (depth === 0 && char === close) return index;
    }
  }
  return -1;
}

// --- Source stripping -------------------------------------------------
// Returns the source with comments, string literals and regex literals
// replaced by spaces (newlines preserved), except template-literal
// ${...} expressions, which are real code and are kept. That way a
// `process.env` mention inside a comment or a string is never mistaken
// for a read, and every reported line number stays correct.
function stripJs(source) {
  let out = '';
  let index = 0;
  const pushSpaces = (text) => {
    out += text.replace(/[^\n]/g, ' ');
  };
  while (index < source.length) {
    const char = source[index];
    const next = source[index + 1] ?? '';
    if (char === '/' && next === '/') {
      const end = source.indexOf('\n', index);
      pushSpaces(source.slice(index, end === -1 ? source.length : end));
      index = end === -1 ? source.length : end;
      continue;
    }
    if (char === '/' && next === '*') {
      const end = source.indexOf('*/', index + 2);
      const stop = end === -1 ? source.length : end + 2;
      pushSpaces(source.slice(index, stop));
      index = stop;
      continue;
    }
    if (char === "'" || char === '"') {
      let end = index + 1;
      while (end < source.length && source[end] !== char) {
        if (source[end] === '\\') end += 1;
        if (source[end] === '\n') break;
        end += 1;
      }
      pushSpaces(source.slice(index, Math.min(end + 1, source.length)));
      index = Math.min(end + 1, source.length);
      continue;
    }
    if (char === '`') {
      // Template literal: blank the literal parts, keep ${...} code.
      out += ' ';
      index += 1;
      while (index < source.length && source[index] !== '`') {
        if (source[index] === '\\') {
          pushSpaces(source.slice(index, index + 2));
          index += 2;
          continue;
        }
        if (source[index] === '$' && source[index + 1] === '{') {
          out += '${';
          index += 2;
          let depth = 1;
          const start = index;
          while (index < source.length && depth > 0) {
            if (source[index] === '{') depth += 1;
            if (source[index] === '}') depth -= 1;
            index += 1;
          }
          out += stripJs(source.slice(start, index - 1));
          out += '}';
          continue;
        }
        if (source[index] === '\n') out += '\n';
        else out += ' ';
        index += 1;
      }
      if (index < source.length) {
        out += ' ';
        index += 1;
      }
      continue;
    }
    if (char === '/') {
      // Regex literal when the previous token cannot end an
      // expression (an operator, opener, or a keyword such as return);
      // otherwise this is division.
      const before = out.trimEnd().slice(-1);
      const beforeWord = out.trimEnd().match(/[A-Za-z_$][\w$]*$/)?.[0] ?? '';
      const keywordRegex = ['return', 'typeof', 'case', 'delete', 'void', 'in', 'of', 'new', 'instanceof', 'yield', 'await'].includes(beforeWord);
      if (before === '' || keywordRegex || '=({,:[!&|?;+-*%<>^~'.includes(before)) {
        let end = index + 1;
        let inClass = false;
        while (end < source.length) {
          if (source[end] === '\\') {
            end += 2;
            continue;
          }
          if (source[end] === '\n') break;
          if (source[end] === '[') inClass = true;
          if (source[end] === ']') inClass = false;
          if (source[end] === '/' && !inClass) break;
          end += 1;
        }
        pushSpaces(source.slice(index, Math.min(end + 1, source.length)));
        index = Math.min(end + 1, source.length);
        continue;
      }
    }
    out += char;
    index += 1;
  }
  return out;
}

// Like stripJs, but keeps string literals and regex literals: only
// comments are blanked. Used for bracket-string reads such as
// `process.env['NAME']`, where the name itself is a string literal
// that the full stripper blanks.
function stripJsComments(source) {
  let out = '';
  let index = 0;
  while (index < source.length) {
    const char = source[index];
    const next = source[index + 1] ?? '';
    if (char === '/' && next === '/') {
      const end = source.indexOf('\n', index);
      const stop = end === -1 ? source.length : end;
      out += ' '.repeat(stop - index);
      index = stop;
      continue;
    }
    if (char === '/' && next === '*') {
      const end = source.indexOf('*/', index + 2);
      const stop = end === -1 ? source.length : end + 2;
      out += source.slice(index, stop).replace(/[^\n]/g, ' ');
      index = stop;
      continue;
    }
    if (char === "'" || char === '"' || char === '`') {
      let end = index + 1;
      while (end < source.length && source[end] !== char) {
        if (source[end] === '\\') end += 1;
        end += 1;
      }
      out += source.slice(index, Math.min(end + 1, source.length));
      index = Math.min(end + 1, source.length);
      continue;
    }
    if (char === '/') {
      const before = out.trimEnd().slice(-1);
      const beforeWord = out.trimEnd().match(/[A-Za-z_$][\w$]*$/)?.[0] ?? '';
      const keywordRegex = ['return', 'typeof', 'case', 'delete', 'void', 'in', 'of', 'new', 'instanceof', 'yield', 'await'].includes(beforeWord);
      if (before === '' || keywordRegex || '=({,:[!&|?;+-*%<>^~'.includes(before)) {
        let end = index + 1;
        let inClass = false;
        while (end < source.length) {
          if (source[end] === '\\') {
            end += 2;
            continue;
          }
          if (source[end] === '\n') break;
          if (source[end] === '[') inClass = true;
          if (source[end] === ']') inClass = false;
          if (source[end] === '/' && !inClass) break;
          end += 1;
        }
        out += source.slice(index, Math.min(end + 1, source.length));
        index = Math.min(end + 1, source.length);
        continue;
      }
    }
    out += char;
    index += 1;
  }
  return out;
}

function stripYamlComments(source) {
  return source.split('\n').map((line) => {
    let single = false;
    let double = false;
    for (let index = 0; index < line.length; index += 1) {
      const char = line[index];
      if (char === "'" && !double) single = !single;
      if (char === '"' && !single && line[index - 1] !== '\\') double = !double;
      if (char === '#' && !single && !double
        && (index === 0 || /\s/.test(line[index - 1]))) {
        return line.slice(0, index);
      }
    }
    return line;
  }).join('\n');
}

// --- Env vars ---------------------------------------------------------

function addVar(map, name, location) {
  if (!map.has(name)) map.set(name, []);
  if (!map.get(name).includes(location)) map.get(name).push(location);
}

// --- Proved process.env aliases ---------------------------------------
// An identifier counts as the process environment only when it is
// provably process.env in its own scope:
//  - it is process.env itself,
//  - a variable / assignment bound to process.env (or to a proved alias),
//  - destructured from `process` (`const { env } = process`),
//  - a function parameter defaulting to process.env, or
//  - a function parameter that a call site passes a proved value to
//    (transitive: a caller whose own `env` defaults to process.env
//    passing it down proves the callee's `env`), same-file or
//    cross-file through a direct import.
// A bare `env` parameter with no default and no proved call site, or a
// local `const env = { ... }` object, is an unrelated object and its
// members do NOT count as env reads. Analysis is scope-aware for
// function parameters / local declarations; cross-file call sites are
// tracked in parseCodeEnvVars (see the header limitations).

const ENV_KEYWORDS = new Set(['if', 'for', 'while', 'switch', 'catch', 'return', 'typeof', 'function', 'const', 'let', 'var', 'export', 'import', 'new', 'delete', 'void', 'in', 'of', 'instanceof', 'yield', 'await', 'do', 'else', 'try', 'finally', 'class', 'extends', 'case', 'throw', 'with']);

function isProcessEnvText(text) {
  return /^\s*process\s*(?:\?\.|\.)\s*env\s*$/.test(text ?? '');
}

function singleIdentifier(text) {
  return (text ?? '').trim().match(/^([A-Za-z_$][\w$]*)$/)?.[1] ?? null;
}

// One parsed parameter: plain (`env`, `env = process.env`, `...env`)
// or object-destructured (`{ env, other }`, `{ env = process.env }`).
function parseParams(paramText) {
  const params = [];
  for (const rawPart of splitTopLevelCommas(paramText ?? '')) {
    const part = rawPart.trim();
    if (!part) continue;
    if (part.startsWith('{')) {
      const close = matchingClose(part, 0);
      if (close < 0) continue;
      const inner = part.slice(1, close);
      const rest = part.slice(close + 1).trim();
      const defaultText = rest.startsWith('=') ? rest.slice(1).trim() : '';
      const props = [];
      for (const rawProp of splitTopLevelCommas(inner)) {
        const prop = rawProp.trim().replace(/^\.\.\./, '');
        if (!prop) continue;
        const [left, ...defaultBits] = prop.split('=');
        const propDefault = defaultBits.join('=').trim();
        const [propName, alias] = left.split(':').map((s) => s.trim());
        if (!propName) continue;
        props.push({
          prop: propName, local: alias || propName,
          defaultIsProcessEnv: isProcessEnvText(propDefault),
          defaultIdentifier: singleIdentifier(propDefault),
        });
      }
      params.push({ kind: 'object', props, defaultText, defaultIsProcessEnv: isProcessEnvText(defaultText) });
      continue;
    }
    if (part.startsWith('[')) {
      params.push({ kind: 'array', name: '' });
      continue;
    }
    const [left, ...defaultBits] = part.split('=');
    const defaultText = defaultBits.join('=').trim();
    const name = left.trim().replace(/^\.\.\./, '');
    if (!name) continue;
    params.push({
      kind: 'plain', name,
      defaultIsProcessEnv: isProcessEnvText(defaultText),
      defaultIdentifier: singleIdentifier(defaultText),
    });
  }
  return params;
}

function blankRanges(text, ranges) {
  let out = text;
  for (const [start, end] of ranges) {
    out = out.slice(0, start) + ' '.repeat(Math.max(0, end - start)) + out.slice(end);
  }
  return out;
}

// Function definitions (named, const/let/var arrow/function, methods)
// with balanced parameter lists and body spans.
function parseFunctions(stripped) {
  const functions = [];
  const seen = new Set();
  const add = (name, paramText, start, bodyStart, bodyEnd, exported = false) => {
    if (seen.has(start)) return;
    seen.add(start);
    functions.push({ name, params: parseParams(paramText), start, bodyStart, bodyEnd, exported });
  };
  // Named functions: `function name(params) {` and `export async function …`
  for (const match of stripped.matchAll(/(?:export\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)?\s*\(/g)) {
    const open = match.index + match[0].length - 1;
    const close = matchingClose(stripped, open);
    if (close < 0) continue;
    const after = stripped.slice(close + 1).trimStart();
    if (!after.startsWith('{')) continue;
    const bodyStart = close + 1 + (stripped.slice(close + 1).length - after.length);
    const bodyEnd = matchingClose(stripped, bodyStart);
    if (bodyEnd < 0) continue;
    add(match[1] ?? null, stripped.slice(open + 1, close), match.index, bodyStart, bodyEnd + 1, match[0].includes('export'));
  }
  // Arrow / function expressions assigned to a variable, or assigned
  // without a declaration (`name = (params) => …`).
  for (const match of stripped.matchAll(/(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s+)?/g)) {
    const exportedDecl = stripped.slice(Math.max(0, match.index - 10), match.index).includes('export');
    let pos = match.index + match[0].length;
    const rest = stripped.slice(pos);
    if (rest.startsWith('function')) {
      const fn = rest.match(/function\s*(?:[A-Za-z_$][\w$]*)?\s*\(/);
      if (!fn) continue;
      const open = pos + fn[0].length - 1;
      const close = matchingClose(stripped, open);
      if (close < 0) continue;
      const after = stripped.slice(close + 1).trimStart();
      if (!after.startsWith('{')) continue;
      const bodyStart = close + 1 + (stripped.slice(close + 1).length - after.length);
      const bodyEnd = matchingClose(stripped, bodyStart);
      if (bodyEnd < 0) continue;
      add(match[1], stripped.slice(open + 1, close), match.index, bodyStart, bodyEnd + 1, exportedDecl);
      continue;
    }
    if (rest.startsWith('(')) {
      const open = pos;
      const close = matchingClose(stripped, open);
      if (close < 0) continue;
      const after = stripped.slice(close + 1).trimStart();
      if (!after.startsWith('=>')) continue;
      const arrowEnd = close + 1 + (stripped.slice(close + 1).length - after.length) + 2;
      const bodyAfter = stripped.slice(arrowEnd).trimStart();
      const bodyStart = arrowEnd + (stripped.slice(arrowEnd).length - bodyAfter.length);
      if (bodyAfter.startsWith('{')) {
        const bodyEnd = matchingClose(stripped, bodyStart);
        if (bodyEnd < 0) continue;
        add(match[1], stripped.slice(open + 1, close), match.index, bodyStart, bodyEnd + 1, exportedDecl);
      } else {
        const semi = stripped.indexOf(';', bodyStart);
        add(match[1], stripped.slice(open + 1, close), match.index, bodyStart, semi < 0 ? stripped.length : semi + 1, exportedDecl);
      }
      continue;
    }
    const single = rest.match(/^([A-Za-z_$][\w$]*)\s*=>/);
    if (single) {
      const arrowEnd = pos + single[0].length;
      const bodyAfter = stripped.slice(arrowEnd).trimStart();
      const bodyStart = arrowEnd + (stripped.slice(arrowEnd).length - bodyAfter.length);
      if (bodyAfter.startsWith('{')) {
        const bodyEnd = matchingClose(stripped, bodyStart);
        if (bodyEnd < 0) continue;
        add(match[1], single[1], match.index, bodyStart, bodyEnd + 1, exportedDecl);
      } else {
        const semi = stripped.indexOf(';', bodyStart);
        add(match[1], single[1], match.index, bodyStart, semi < 0 ? stripped.length : semi + 1, exportedDecl);
      }
    }
  }
  // Object / class methods: `name(params) {` at a statement boundary.
  for (const match of stripped.matchAll(/(?:^|[;{,]\s*)(?:async\s+)?([A-Za-z_$][\w$]*)\s*\(/gm)) {
    const name = match[1];
    if (ENV_KEYWORDS.has(name)) continue;
    const before = stripped.slice(0, match.index).trimEnd();
    if (before.endsWith('.')) continue;
    const open = match.index + match[0].length - 1;
    const close = matchingClose(stripped, open);
    if (close < 0) continue;
    const after = stripped.slice(close + 1).trimStart();
    if (!after.startsWith('{')) continue;
    const bodyStart = close + 1 + (stripped.slice(close + 1).length - after.length);
    const bodyEnd = matchingClose(stripped, bodyStart);
    if (bodyEnd < 0) continue;
    add(name, stripped.slice(open + 1, close), match.index, bodyStart, bodyEnd + 1);
  }
  functions.sort((a, b) => a.start - b.start);
  return functions;
}

// Scan a (nested-functions-blanked) chunk for `name = RHS` and
// `{ … } = RHS` declarators / assignments. Returns records
// { lhs, rhsKind: 'processEnv' | 'identifier' | 'process' | 'other',
//   rhsIdentifier, pos } — pos is relative to the chunk.
function scanAssignments(chunk) {
  const records = [];
  for (const match of chunk.matchAll(/(?:const|let|var)\s*\{([^}]*)\}\s*=\s*/g)) {
    const rhsStart = match.index + match[0].length;
    const rhs = chunk.slice(rhsStart, rhsStart + 80).trim();
    for (const rawProp of splitTopLevelCommas(match[1])) {
      const prop = rawProp.trim().replace(/^\.\.\./, '');
      if (!prop) continue;
      const [propName, alias] = prop.split(':').map((s) => s.trim());
      const local = alias || propName;
      if (!local) continue;
      // Only `const { env } = process` creates an env alias. Destructuring
      // from process.env / a proved alias yields var *values*, not aliases.
      if (/^process\s*(?:[;,\)\]]|$)/.test(rhs)) records.push({ lhs: local, rhsKind: 'process', rhsIdentifier: null, pos: match.index });
    }
  }
  const plainPattern = /(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*|(?<![A-Za-z0-9_$.=])([A-Za-z_$][\w$]*)\s*=\s*(?!=)(?!>)/g;
  for (const match of chunk.matchAll(plainPattern)) {
    const lhs = match[1] ?? match[2];
    if (!lhs) continue;
    const rhsStart = match.index + match[0].length;
    const rhs = chunk.slice(rhsStart, rhsStart + 80);
    const rhsTrim = rhs.trim();
    if (isProcessEnvText(rhsTrim.split(/[;,\)\]]/)[0])) {
      records.push({ lhs, rhsKind: 'processEnv', rhsIdentifier: null, pos: match.index });
    } else if (rhsTrim.startsWith('{')) {
      // A spread copy (`const env = { ...provedEnv }` or
      // `{ ...process.env }`) is an env alias, like a direct assignment.
      const spread = rhsTrim.match(/^\{\s*\.\.\.\s*(process\s*(?:\?\.|\.)\s*env|[A-Za-z_$][\w$]*)/);
      if (spread && isProcessEnvText(spread[1])) {
        records.push({ lhs, rhsKind: 'processEnv', rhsIdentifier: null, pos: match.index });
      } else if (spread) {
        records.push({ lhs, rhsKind: 'identifier', rhsIdentifier: spread[1], pos: match.index });
      } else {
        records.push({ lhs, rhsKind: 'other', rhsIdentifier: null, pos: match.index });
      }
    } else if (rhsTrim.startsWith('Object.assign(')) {
      // `Object.assign({}, provedEnv)` / `Object.assign({}, process.env)`.
      const inner = rhsTrim.slice('Object.assign('.length);
      const args = splitTopLevelCommas(inner.slice(0, inner.lastIndexOf(')')));
      const sourceArg = (args[1] ?? '').trim();
      if (isProcessEnvText(sourceArg)) {
        records.push({ lhs, rhsKind: 'processEnv', rhsIdentifier: null, pos: match.index });
      } else {
        const id = singleIdentifier(sourceArg);
        records.push({ lhs, rhsKind: id ? 'identifier' : 'other', rhsIdentifier: id, pos: match.index });
      }
    } else {
      const id = singleIdentifier(rhsTrim.split(/[;,\)\]]/)[0]);
      records.push({ lhs, rhsKind: id ? 'identifier' : 'other', rhsIdentifier: id, pos: match.index });
    }
  }
  return records;
}

// Which parameter locals a call `fn(args)` proves, given a function
// that answers whether an argument expression is provably process.env
// in the caller's scope. Shared by same-file and cross-file call sites.
function provedParamsFromCall(params, args, argProved) {
  const proved = [];
  params.forEach((param, paramIdx) => {
    const arg = args[paramIdx];
    if (arg === undefined) return;
    if (param.kind === 'plain') {
      if (argProved(arg)) proved.push(param.name);
    } else if (param.kind === 'object' && arg.trim().startsWith('{')) {
      const argClose = matchingClose(arg.trim(), 0);
      if (argClose < 0) return;
      const argProps = new Map();
      for (const rawProp of splitTopLevelCommas(arg.trim().slice(1, argClose))) {
        const prop = rawProp.trim();
        if (!prop) continue;
        const colon = prop.indexOf(':');
        const eq = prop.indexOf('=');
        if (colon >= 0) argProps.set(prop.slice(0, colon).trim(), prop.slice(colon + 1).trim());
        else if (eq >= 0) argProps.set(prop.slice(0, eq).trim(), prop.slice(eq + 1).trim());
        else argProps.set(prop.replace(/^\.\.\./, ''), prop.replace(/^\.\.\./, ''));
      }
      for (const prop of param.props) {
        const value = argProps.get(prop.prop);
        if (value !== undefined && argProved(value)) proved.push(prop.local);
      }
    }
  });
  return proved;
}

// Whether an argument expression is provably process.env in the
// caller's scope (`process.env` literally, or a proved identifier).
function argIsProved(arg, callPos, resolve) {
  const trimmed = (arg ?? '').trim();
  if (isProcessEnvText(trimmed)) return true;
  const id = singleIdentifier(trimmed);
  if (id) return resolve(id, callPos);
  return false;
}

function analyzeEnvProvenance(stripped, externalProved = new Map()) {
  const functions = parseFunctions(stripped);
  // Per-function state: declared Map name -> proved, paramProved Map name -> proved.
  const fnState = functions.map((fn) => {
    const paramProved = new Map();
    for (const param of fn.params) {
      if (param.kind === 'plain') {
        paramProved.set(param.name, Boolean(param.defaultIsProcessEnv)
          || (fn.name ? Boolean(externalProved.get(`${fn.name}:${param.name}`)) : false));
      } else if (param.kind === 'object') {
        for (const prop of param.props) {
          paramProved.set(prop.local, Boolean(prop.defaultIsProcessEnv)
            || (fn.name ? Boolean(externalProved.get(`${fn.name}:${prop.local}`)) : false));
        }
      }
    }
    return { fn, paramProved, declared: new Map(), records: [] };
  });
  const globalRecords = scanAssignments(blankRanges(stripped, functions.map((fn) => [fn.start, fn.bodyEnd])));
  const globalDeclared = new Map();
  for (const record of globalRecords) {
    if (record.rhsKind === 'processEnv' || record.rhsKind === 'process') globalDeclared.set(record.lhs, true);
    else if (!globalDeclared.has(record.lhs)) globalDeclared.set(record.lhs, false);
  }
  for (let idx = 0; idx < functions.length; idx += 1) {
    const fn = functions[idx];
    const nested = functions.filter((other, otherIdx) => otherIdx !== idx
      && other.start >= fn.bodyStart && other.bodyEnd <= fn.bodyEnd);
    const body = blankRanges(stripped.slice(fn.bodyStart, fn.bodyEnd),
      nested.map((other) => [other.start - fn.bodyStart, other.bodyEnd - fn.bodyStart]));
    const records = scanAssignments(body);
    fnState[idx].records = records;
    for (const record of records) {
      if (record.rhsKind === 'processEnv' || record.rhsKind === 'process') fnState[idx].declared.set(record.lhs, true);
      else if (!fnState[idx].declared.has(record.lhs)) fnState[idx].declared.set(record.lhs, false);
    }
  }
  // Resolve an identifier at a position in stripped source, innermost
  // function first, then outer functions, then global scope.
  const resolve = (identifier, pos) => {
    const containing = functions
      .map((fn, idx) => ({ fn, idx }))
      .filter(({ fn }) => pos >= fn.bodyStart && pos < fn.bodyEnd)
      .sort((a, b) => (a.fn.bodyEnd - a.fn.bodyStart) - (b.fn.bodyEnd - b.fn.bodyStart));
    for (const { idx } of containing) {
      const state = fnState[idx];
      if (state.paramProved.has(identifier)) return state.paramProved.get(identifier);
      if (state.declared.has(identifier)) return state.declared.get(identifier);
    }
    if (globalDeclared.has(identifier)) return globalDeclared.get(identifier);
    return false;
  };
  const argProved = (arg, callPos) => {
    const trimmed = arg.trim();
    if (isProcessEnvText(trimmed)) return true;
    const id = singleIdentifier(trimmed);
    if (id) return resolve(id, callPos);
    return false;
  };
  // Fixpoint: assignment dependencies, param identifier defaults, and
  // same-file call sites.
  for (let iteration = 0; iteration < 20; iteration += 1) {
    let changed = false;
    const promote = (map, name, value) => {
      if (value && !map.get(name)) { map.set(name, true); changed = true; }
    };
    for (const record of globalRecords) {
      if (record.rhsKind === 'identifier' && record.rhsIdentifier) {
        // Assignment position in global (blanked) text is not meaningful
        // for scope, so resolve at 0: only global + no containing fn.
        promote(globalDeclared, record.lhs, resolve(record.rhsIdentifier, 0));
      }
    }
    for (let idx = 0; idx < functions.length; idx += 1) {
      const state = fnState[idx];
      const fn = functions[idx];
      for (const record of state.records) {
        if (record.rhsKind === 'identifier' && record.rhsIdentifier) {
          promote(state.declared, record.lhs, resolve(record.rhsIdentifier, fn.bodyStart + record.pos));
        }
      }
      for (const param of fn.params) {
        if (param.kind === 'plain' && param.defaultIdentifier) {
          promote(state.paramProved, param.name, resolve(param.defaultIdentifier, fn.start));
        } else if (param.kind === 'object') {
          for (const prop of param.props) {
            if (prop.defaultIdentifier) promote(state.paramProved, prop.local, resolve(prop.defaultIdentifier, fn.start));
          }
        }
      }
    }
    // Call sites: `name(args)` — skip keywords, method calls, and a
    // function's own signature.
    for (const match of stripped.matchAll(/(?<![A-Za-z0-9_$.])([A-Za-z_$][\w$]*)\s*\(/g)) {
      const name = match[1];
      if (ENV_KEYWORDS.has(name)) continue;
      const open = match.index + match[0].length - 1;
      const close = matchingClose(stripped, open);
      if (close < 0) continue;
      const calleeIdx = functions.findIndex((fn) => fn.name === name && !(fn.start <= match.index && match.index < fn.bodyStart));
      if (calleeIdx < 0) continue;
      const callee = fnState[calleeIdx];
      const args = splitTopLevelCommas(stripped.slice(open + 1, close));
      callee.fn.params.forEach((param, paramIdx) => {
        const arg = args[paramIdx];
        if (arg === undefined) return;
        if (param.kind === 'plain') {
          promote(callee.paramProved, param.name, argProved(arg, match.index));
        } else if (param.kind === 'object' && arg.trim().startsWith('{')) {
          const argClose = matchingClose(arg.trim(), 0);
          if (argClose < 0) return;
          const argProps = new Map();
          for (const rawProp of splitTopLevelCommas(arg.trim().slice(1, argClose))) {
            const prop = rawProp.trim();
            if (!prop) continue;
            const colon = prop.indexOf(':');
            const eq = prop.indexOf('=');
            if (colon >= 0) argProps.set(prop.slice(0, colon).trim(), prop.slice(colon + 1).trim());
            else if (eq >= 0) argProps.set(prop.slice(0, eq).trim(), prop.slice(eq + 1).trim());
            else argProps.set(prop.replace(/^\.\.\./, ''), prop.replace(/^\.\.\./, ''));
          }
          for (const prop of param.props) {
            const value = argProps.get(prop.prop);
            if (value !== undefined) promote(callee.paramProved, prop.local, argProved(value, match.index));
          }
        }
      });
    }
    if (!changed) break;
  }
  return { resolve, functions, fnState };
}

// Direct, bracket and destructured reads of the process environment in
// one JavaScript file. Only identifiers provably bound to process.env
// (see analyzeEnvProvenance) count as env reads. Indirect reads through
// a named constant (`env[FLAG]`, where FLAG is a const holding the
// name) and through a `*Env: 'NAME'` property (the key-ring definitions
// in _key-rotation) are resolved to the underlying name. `externalAliases`
// are string-constant aliases imported from other scanned files.
function codeVarsFromJs(path, source, externalAliases = new Map(), externalProved = new Map()) {
  const stripped = stripJs(source);
  const found = new Map();
  const { resolve } = analyzeEnvProvenance(stripped, externalProved);
  const isEnvBase = (text, pos) => {
    const trimmed = (text ?? '').trim();
    if (isProcessEnvText(trimmed)) return true;
    const id = singleIdentifier(trimmed);
    return id ? resolve(id, pos) : false;
  };
  // Aliases and `*Env: 'NAME'` properties are string literals, which
  // the stripped source has blanked, so they are collected from the
  // comment-stripped source. They only turn into reads when the
  // stripped code actually indexes the environment through them (below),
  // so a stray mention in a comment or a string cannot invent a read.
  const aliases = new Map(externalAliases);
  for (const match of stripJsComments(source).matchAll(
    /(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*['"]([A-Z][A-Z0-9_]*)['"]/g,
  )) {
    if (!aliases.has(match[1])) aliases.set(match[1], match[2]);
  }
  // Dynamic access through a proved base (`process.env[x]`,
  // `provedEnv[x]`, `provedEnv?.[x]`).
  let hasDynamicAccess = false;
  for (const match of stripped.matchAll(/(?:process\s*(?:\?\.|\.)\s*env|([A-Za-z_$][\w$]*))\s*(?:\?\.\s*)?\[/g)) {
    if (!match[1] || isEnvBase(match[1], match.index)) hasDynamicAccess = true;
  }
  if (hasDynamicAccess) {
    for (const match of stripJsComments(source).matchAll(
      /[A-Za-z_$][\w$]*Env\s*:\s*['"]([A-Z][A-Z0-9_]*)['"]/g,
    )) {
      addVar(found, match[1], `${path}:${lineNumberBefore(source, match.index)}`);
    }
  }
  const envRead = /([A-Za-z_$][\w$]*)\s*(?:\?\.\s*|\.\s*)([A-Z][A-Z0-9_]*)/g;
  for (const match of stripped.matchAll(envRead)) {
    const base = match[1];
    if (base === 'process') continue;
    // `process.env.FOO` also matches here with base `env`; the full
    // `process.env` form below owns that read, so skip it here to
    // avoid a duplicate location for the same var.
    const before = stripped.slice(Math.max(0, match.index - 12), match.index);
    if (base === 'env' && /process\s*(?:\?\.|\.)\s*$/.test(before)) continue;
    if (isEnvBase(base, match.index)) {
      addVar(found, match[2], `${path}:${lineNumberBefore(stripped, match.index)}`);
    }
  }
  // The `process.env.FOO` form: `process` followed by `.env` then `.FOO`.
  const processEnvRead = /process\s*(?:\?\.|\.)\s*env\s*(?:\?\.\s*|\.\s*)([A-Z][A-Z0-9_]*)/g;
  for (const match of stripped.matchAll(processEnvRead)) {
    addVar(found, match[1], `${path}:${lineNumberBefore(stripped, match.index)}`);
  }
  // Bracket-string reads (`env['NAME']`) are collected from the
  // comment-stripped source: the full stripper blanks the name string
  // itself, and comments are already gone here so a commented-out
  // read cannot count.
  const commentStripped = stripJsComments(source);
  for (const match of commentStripped.matchAll(
    /(?:process\s*(?:\?\.|\.)\s*env|([A-Za-z_$][\w$]*))\s*(?:\?\.\s*)?\[\s*['"]([A-Z][A-Z0-9_]*)['"]\s*\]/g,
  )) {
    if (!match[1] || isEnvBase(match[1], match.index)) {
      addVar(found, match[2], `${path}:${lineNumberBefore(commentStripped, match.index)}`);
    }
  }
  // Bracket reads through a name (`env[FLAG]`), where FLAG resolves via
  // a string const in this file or an imported one, plus namespace
  // imports (`env[ns.FLAG]`).
  for (const match of stripped.matchAll(
    /(?:process\s*(?:\?\.|\.)\s*env|([A-Za-z_$][\w$]*))\s*(?:\?\.\s*)?\[\s*([A-Za-z_$][\w$]*(?:\s*\.\s*[A-Za-z_$][\w$]*)?)\s*\]/g,
  )) {
    if (match[1] && !isEnvBase(match[1], match.index)) continue;
    const indexExpr = match[2].replace(/\s+/g, '');
    if (aliases.has(indexExpr)) {
      addVar(found, aliases.get(indexExpr), `${path}:${lineNumberBefore(stripped, match.index)}`);
    }
  }
  // Destructured reads: `const { FOO } = process.env` / `= provedEnv`,
  // and `const { env } = process` (proved alias, not a var read).
  for (const match of stripped.matchAll(/(?:const|let|var)\s*\{([^}]*)\}\s*=\s*([^\s;,]+)/g)) {
    const rhsStart = match.index + match[0].length - match[2].length;
    const rhs = match[2];
    // `= process.env` / `= provedEnv` — the captured RHS is the first
    // token; re-derive the full RHS from stripped source.
    const rhsFull = stripped.slice(rhsStart).match(/^(?:process\s*(?:\?\.|\.)\s*env|[A-Za-z_$][\w$]*)/)?.[0] ?? rhs;
    if (!(isProcessEnvText(rhsFull) || isEnvBase(rhsFull, rhsStart))) continue;
    for (const part of match[1].split(',')) {
      const name = part.split(/[:=]/)[0].trim().replace(/^\.\.\./, '');
      if (new RegExp(`^${ENV_NAME}$`).test(name) && name) {
        addVar(found, name, `${path}:${lineNumberBefore(stripped, match.index)}`);
      }
    }
  }
  return found;
}


// Reads in one workflow file: GitHub expressions (`vars.` / `secrets.` /
// `env.`), shell `$NAME` / `${NAME}` references in run blocks, and any
// embedded JavaScript. A shell name assigned in the same workflow file
// (`NAME=...`, `export NAME=...`, `for NAME in ...`) is a local shell
// variable, not an environment read, so it is excluded.
function codeVarsFromWorkflow(path, source) {
  const stripped = stripYamlComments(source);
  const found = new Map();
  const assigned = new Set();
  // A one-line `run: VAR=…` step assigns VAR in that step's shell, just
  // like a line-start assignment: blank the leading `run:` prefix (and
  // any `- run:` list marker) so the assignment scan sees it.
  const withoutRunPrefix = stripped.split('\n').map((line) => line.replace(
    /^(\s*(?:-\s*)?run:\s*)/, (prefix) => ' '.repeat(prefix.length),
  )).join('\n');
  for (const match of withoutRunPrefix.matchAll(
    /(?:^|[;&|])\s*(?:export\s+|local\s+)?([A-Z][A-Z0-9_]*)\s*\+?=(?!=)/gm,
  )) assigned.add(match[1]);
  for (const match of stripped.matchAll(/\bfor\s+([A-Z][A-Z0-9_]*)\s+in\b/g)) {
    assigned.add(match[1]);
  }
  const lineOf = (index) => lineNumberBefore(stripped, index);
  for (const match of stripped.matchAll(
    /\$\{\{\s*(?:vars|secrets|env|inputs)\.([A-Z][A-Z0-9_]*)\b/g,
  )) {
    addVar(found, match[1], `${path}:${lineOf(match.index)}`);
  }
  for (const match of stripped.matchAll(
    /\$\{\{\s*(?:vars|secrets|env)\[['"]([A-Z][A-Z0-9_]*)['"]\]/g,
  )) {
    addVar(found, match[1], `${path}:${lineOf(match.index)}`);
  }
  for (const match of stripped.matchAll(/\$(?:\{)?\s*([A-Z][A-Z0-9_]*)/g)) {
    if (!assigned.has(match[1])) {
      addVar(found, match[1], `${path}:${lineOf(match.index)}`);
    }
  }
  const envRead = new RegExp(
    `process\\.env\\s*(?:\\?\\.\\s*\\[\\s*['"]|\\?\\.\\s*|\\.\\s*|\\[\\s*['"])(${ENV_NAME})(?:['"]\\s*\\])?`,
    'g',
  );
  for (const match of stripped.matchAll(envRead)) {
    addVar(found, match[1], `${path}:${lineOf(match.index)}`);
  }
  return found;
}

// --- Cross-file imports -------------------------------------------------
// Imported string-constant aliases and imported-function env parameters
// are resolved through direct imports / re-exports between scanned
// files, so `import { FLAG } from './constants.js'; process.env[FLAG]`
// and `import { helper } from './helper.js'; helper(process.env)`
// both count, with the callee's `env` parameter proved by the
// cross-file call site (and, transitively, by its own caller).

function resolveImportPath(fromPath, specifier, knownPaths) {
  if (!specifier?.startsWith('.')) return null;
  const base = posix.normalize(posix.join(posix.dirname(fromPath), specifier));
  const candidates = [base, `${base}.js`, `${base}.mjs`, `${base}.cjs`, `${base}/index.js`, `${base}/index.mjs`, `${base}/index.cjs`];
  for (const candidate of candidates) {
    if (knownPaths.has(candidate)) return candidate;
  }
  return null;
}

function parseImports(source) {
  const imports = new Map(); // local -> { specifier, original, kind }
  const noComments = stripJsComments(source);
  for (const match of noComments.matchAll(/import\s*\*\s*as\s+([A-Za-z_$][\w$]*)\s+from\s*['"]([^'"]+)['"]/g)) {
    imports.set(match[1], { specifier: match[2], original: '*', kind: 'namespace' });
  }
  for (const match of noComments.matchAll(/import\s+([A-Za-z_$][\w$]*)\s*,\s*\{([^}]*)\}\s*from\s*['"]([^'"]+)['"]/g)) {
    imports.set(match[1], { specifier: match[3], original: 'default', kind: 'default' });
    for (const raw of splitTopLevelCommas(match[2])) {
      const part = raw.trim();
      if (!part) continue;
      const [orig, alias] = part.split(/\s+as\s+/).map((s) => s.trim());
      if (orig) imports.set(alias || orig, { specifier: match[3], original: orig, kind: 'named' });
    }
  }
  for (const match of noComments.matchAll(/import\s*\{([^}]*)\}\s*from\s*['"]([^'"]+)['"]/g)) {
    for (const raw of splitTopLevelCommas(match[1])) {
      const part = raw.trim();
      if (!part) continue;
      const [orig, alias] = part.split(/\s+as\s+/).map((s) => s.trim());
      if (orig) imports.set(alias || orig, { specifier: match[2], original: orig, kind: 'named' });
    }
  }
  for (const match of noComments.matchAll(/import\s+([A-Za-z_$][\w$]*)\s+from\s*['"]([^'"]+)['"]/g)) {
    if (!imports.has(match[1])) imports.set(match[1], { specifier: match[2], original: 'default', kind: 'default' });
  }
  return imports;
}

function parseExportInfo(source) {
  const named = new Map(); // exported -> local
  const reExports = new Map(); // exported -> { specifier, original }
  let defaultString = null;
  const noComments = stripJsComments(source);
  for (const match of noComments.matchAll(/export\s*\{([^}]*)\}\s*(?:from\s*['"]([^'"]+)['"])?/g)) {
    for (const raw of splitTopLevelCommas(match[1])) {
      const part = raw.trim();
      if (!part) continue;
      const [orig, alias] = part.split(/\s+as\s+/).map((s) => s.trim());
      if (!orig) continue;
      if (match[2]) reExports.set(alias || orig, { specifier: match[2], original: orig });
      else named.set(alias || orig, orig);
    }
  }
  for (const match of noComments.matchAll(/export\s+(?:async\s+)?(?:const|let|var|function|class)\s+([A-Za-z_$][\w$]*)/g)) {
    if (!named.has(match[1])) named.set(match[1], match[1]);
  }
  const defaultMatch = noComments.match(/export\s+default\s*['"]([A-Z][A-Z0-9_]*)['"]/);
  if (defaultMatch) defaultString = defaultMatch[1];
  return { named, reExports, defaultString };
}

function localStringConsts(source) {
  const map = new Map();
  for (const match of stripJsComments(source).matchAll(
    /(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*['"]([A-Z][A-Z0-9_]*)['"]/g,
  )) {
    if (!map.has(match[1])) map.set(match[1], match[2]);
  }
  return map;
}

function resolveExportedStringConst(fileInfoByPath, filePath, exportedName, visited = new Set()) {
  const key = `${filePath}:${exportedName}`;
  if (visited.has(key)) return null;
  visited.add(key);
  const info = fileInfoByPath.get(filePath);
  if (!info) return null;
  if (exportedName === 'default') return info.exportInfo.defaultString;
  if (info.exportInfo.reExports.has(exportedName)) {
    const re = info.exportInfo.reExports.get(exportedName);
    const target = resolveImportPath(filePath, re.specifier, new Set(fileInfoByPath.keys()));
    if (!target) return null;
    return resolveExportedStringConst(fileInfoByPath, target, re.original, visited);
  }
  const local = info.exportInfo.named.get(exportedName);
  if (local && info.stringConsts.has(local)) return info.stringConsts.get(local);
  // A locally defined string const that is exported via `export { … }`
  // is in `named`; a const that is not exported cannot be imported.
  return null;
}

function exportedStringConsts(fileInfoByPath, filePath) {
  const info = fileInfoByPath.get(filePath);
  if (!info) return new Map();
  const out = new Map();
  for (const exported of info.exportInfo.named.keys()) {
    const value = resolveExportedStringConst(fileInfoByPath, filePath, exported, new Set());
    if (value) out.set(exported, value);
  }
  for (const exported of info.exportInfo.reExports.keys()) {
    const value = resolveExportedStringConst(fileInfoByPath, filePath, exported, new Set());
    if (value) out.set(exported, value);
  }
  if (info.exportInfo.defaultString) out.set('default', info.exportInfo.defaultString);
  return out;
}

function resolveExportedFunction(fileInfoByPath, filePath, exportedName, visited = new Set()) {
  const key = `${filePath}:${exportedName}`;
  if (visited.has(key)) return null;
  visited.add(key);
  const info = fileInfoByPath.get(filePath);
  if (!info) return null;
  if (info.exportInfo.reExports.has(exportedName)) {
    const re = info.exportInfo.reExports.get(exportedName);
    const target = resolveImportPath(filePath, re.specifier, new Set(fileInfoByPath.keys()));
    if (!target) return null;
    return resolveExportedFunction(fileInfoByPath, target, re.original, visited);
  }
  const local = info.exportInfo.named.get(exportedName);
  if (!local) return null;
  const fn = info.functions.find((item) => item.name === local);
  if (!fn) return null;
  return { filePath, fn };
}

// Calls in one file to functions imported from other scanned files,
// with the parameter locals they prove. `analyses` maps a file path
// to its current { stripped, resolve }.
function crossFileCallProved(filePath, info, analyses, fileInfoByPath) {
  const proved = []; // { targetPath, fnName, paramLocal }
  const analysis = analyses.get(filePath);
  if (!analysis) return proved;
  const { stripped, resolve } = analysis;
  const argProved = (arg, callPos) => argIsProved(arg, callPos, resolve);
  const record = (targetPath, exportedName, args, callPos) => {
    const resolved = resolveExportedFunction(fileInfoByPath, targetPath, exportedName);
    if (!resolved) return;
    for (const local of provedParamsFromCall(resolved.fn.params, args, (arg) => argProved(arg, callPos))) {
      proved.push({ targetPath: resolved.filePath, fnName: resolved.fn.name, paramLocal: local });
    }
  };
  for (const match of stripped.matchAll(/(?<![A-Za-z0-9_$.])([A-Za-z_$][\w$]*)\s*\(/g)) {
    const name = match[1];
    if (ENV_KEYWORDS.has(name)) continue;
    const open = match.index + match[0].length - 1;
    const close = matchingClose(stripped, open);
    if (close < 0) continue;
    // Skip this file's own function signatures.
    if (info.functions.some((fn) => fn.name === name && fn.start <= match.index && match.index < fn.bodyStart)) continue;
    const imp = info.imports.get(name);
    if (!imp || imp.kind === 'namespace') continue;
    const target = resolveImportPath(filePath, imp.specifier, new Set(fileInfoByPath.keys()));
    if (!target) continue;
    record(target, imp.original, splitTopLevelCommas(stripped.slice(open + 1, close)), match.index);
  }
  // Namespace calls: `ns.fn(args)`.
  for (const match of stripped.matchAll(/(?<![A-Za-z0-9_$])([A-Za-z_$][\w$]*)\s*\.\s*([A-Za-z_$][\w$]*)\s*\(/g)) {
    const ns = match[1];
    const imp = info.imports.get(ns);
    if (!imp || imp.kind !== 'namespace') continue;
    if (ns === 'process') continue;
    const open = match.index + match[0].length - 1;
    const close = matchingClose(stripped, open);
    if (close < 0) continue;
    const target = resolveImportPath(filePath, imp.specifier, new Set(fileInfoByPath.keys()));
    if (!target) continue;
    record(target, match[2], splitTopLevelCommas(stripped.slice(open + 1, close)), match.index);
  }
  return proved;
}

export function parseCodeEnvVars(codeFiles) {
  const found = new Map();
  const files = [...(codeFiles ?? [])].sort((a, b) => a.path.localeCompare(b.path));
  const jsFiles = files.filter((file) => typeof file?.content === 'string'
    && !file.path.includes('.github/workflows/'));
  const knownPaths = new Set(jsFiles.map((file) => file.path));
  // Per-file static info for cross-file resolution.
  const fileInfoByPath = new Map();
  for (const file of jsFiles) {
    const stripped = stripJs(file.content);
    fileInfoByPath.set(file.path, {
      path: file.path, content: file.content, stripped,
      functions: parseFunctions(stripped),
      imports: parseImports(file.content),
      exportInfo: parseExportInfo(file.content),
      stringConsts: localStringConsts(file.content),
    });
  }
  // Cross-file string-constant aliases per file.
  const externalAliasesByPath = new Map();
  for (const file of jsFiles) {
    const info = fileInfoByPath.get(file.path);
    const aliases = new Map();
    for (const [local, imp] of info.imports) {
      if (imp.kind === 'named' || imp.kind === 'default') {
        const target = resolveImportPath(file.path, imp.specifier, knownPaths);
        if (!target) continue;
        const value = resolveExportedStringConst(fileInfoByPath, target, imp.original);
        if (value) aliases.set(local, value);
      } else if (imp.kind === 'namespace') {
        const target = resolveImportPath(file.path, imp.specifier, knownPaths);
        if (!target) continue;
        for (const [exported, value] of exportedStringConsts(fileInfoByPath, target)) {
          if (exported !== 'default') aliases.set(`${local}.${exported}`, value);
        }
      }
    }
    externalAliasesByPath.set(file.path, aliases);
  }
  // Cross-file env-parameter proof: iterate until no new parameter
  // is proved by a cross-file call site.
  const externalProvedByPath = new Map(jsFiles.map((file) => [file.path, new Map()]));
  for (let iteration = 0; iteration < 8; iteration += 1) {
    let changed = false;
    const analyses = new Map();
    for (const file of jsFiles) {
      const analysis = analyzeEnvProvenance(
        fileInfoByPath.get(file.path).stripped,
        externalProvedByPath.get(file.path),
      );
      analyses.set(file.path, { stripped: fileInfoByPath.get(file.path).stripped, resolve: analysis.resolve });
    }
    for (const file of jsFiles) {
      const info = fileInfoByPath.get(file.path);
      for (const proved of crossFileCallProved(file.path, info, analyses, fileInfoByPath)) {
        const map = externalProvedByPath.get(proved.targetPath);
        const key = `${proved.fnName}:${proved.paramLocal}`;
        if (map && !map.get(key)) { map.set(key, true); changed = true; }
      }
    }
    if (!changed) break;
  }
  for (const file of files) {
    if (typeof file?.content !== 'string') continue;
    const perFile = file.path.includes('.github/workflows/')
      ? codeVarsFromWorkflow(file.path, file.content)
      : codeVarsFromJs(
        file.path, file.content,
        externalAliasesByPath.get(file.path) ?? new Map(),
        externalProvedByPath.get(file.path) ?? new Map(),
      );
    for (const [name, locations] of perFile) {
      for (const location of locations) addVar(found, name, location);
    }
  }
  return found;
}


// --- Documented env vars ----------------------------------------------

// Table vars: every backticked env-shaped name in the first cell of
// every table row in the given markdown. The first cell is where this
// repo's env tables put the name; other cells hold prose that may
// mention other names (for example `EMAIL_VERIFICATION_*` in a
// dependency column), and those must not count as documented vars.
function tableVars(text, path, map) {
  const lines = text.split('\n');
  const fenced = fenceStates(lines);
  for (const [index, line] of lines.entries()) {
    if (fenced[index]) continue;
    if (!line.startsWith('|')) continue;
    const first = line.split('|').map((cell) => cell.trim())[1] ?? '';
    if (/^---/.test(first)) continue;
    // Header rows (`Variable`, `Flag`, `ID`) hold no backticked env
    // name, so they contribute nothing here.
    for (const match of first.matchAll(/`([A-Z][A-Z0-9_]*)`/g)) {
      addVar(map, match[1], `${path}:${index + 1}`);
    }
  }
}

// The "Dispatch inputs and step values" section lists workflow inputs
// and step values in prose, not in a table; its backticked env-shaped
// names are documented vars. The section is found by heading, and it
// ends at the next heading of the same or higher level.
function dispatchSectionVars(text, path, map) {
  const lines = text.split('\n');
  const fenced = fenceStates(lines);
  let sectionStart = -1;
  for (let idx = 0; idx < lines.length; idx += 1) {
    if (!fenced[idx] && /^### Dispatch inputs and step values\s*$/.test(lines[idx])) { sectionStart = idx; break; }
  }
  if (sectionStart < 0) return;
  for (let index = sectionStart + 1; index < lines.length; index += 1) {
    if (fenced[index]) continue;
    if (/^#{1,3}\s/.test(lines[index])) break;
    for (const match of lines[index].matchAll(/`([A-Z][A-Z0-9_]*)`/g)) {
      addVar(map, match[1], `${path}:${index + 1}`);
    }
  }
}

function envExampleVars(text, path, map) {
  for (const [index, line] of text.split('\n').entries()) {
    const match = line.match(/^#?\s*([A-Z][A-Z0-9_]*)\s*=/);
    if (match) addVar(map, match[1], `${path}:${index + 1}`);
  }
}

export function parseDocumentedEnvVars(environmentMd, envExample) {
  const environment = new Map();
  const example = new Map();
  if (typeof environmentMd === 'string') {
    tableVars(environmentMd, ENVIRONMENT_PATH, environment);
    dispatchSectionVars(environmentMd, ENVIRONMENT_PATH, environment);
  }
  if (typeof envExample === 'string') envExampleVars(envExample, ENV_EXAMPLE_PATH, example);
  return { environment, example };
}

// Flag tables: the tables under the `## Feature flags` heading in
// docs/ENVIRONMENT.md (both the application and operator-gate tables).
export function parseFlagTable(environmentMd) {
  const flags = new Map();
  if (typeof environmentMd !== 'string') return flags;
  const lines = environmentMd.split('\n');
  const fenced = fenceStates(lines);
  let start = -1;
  for (let idx = 0; idx < lines.length; idx += 1) {
    if (!fenced[idx] && /^## Feature flags\s*$/.test(lines[idx])) { start = idx; break; }
  }
  if (start < 0) return flags;
  for (let index = start + 1; index < lines.length; index += 1) {
    if (fenced[index]) continue;
    if (/^##\s/.test(lines[index])) break;
    if (!lines[index].startsWith('|')) continue;
    const first = lines[index].split('|').map((cell) => cell.trim())[1] ?? '';
    if (/^---/.test(first)) continue;
    for (const match of first.matchAll(/`([A-Z][A-Z0-9_]*)`/g)) {
      addVar(flags, match[1], `${ENVIRONMENT_PATH}:${index + 1}`);
    }
  }
  return flags;
}

export function validateEnvVars({ code, environment, example, allowlist }) {
  const errors = [];
  const allowed = allowlist ?? DOCUMENTED_BUT_UNREAD_ALLOWLIST;
  for (const name of sorted(code.keys())) {
    if (!environment.has(name)) {
      errors.push(errorAt('docs/ENVIRONMENT.md', null,
        `env var ${name} is read in ${code.get(name)[0]} but is not documented in docs/ENVIRONMENT.md`));
    }
    if (!example.has(name)) {
      errors.push(errorAt(ENV_EXAMPLE_PATH, null,
        `env var ${name} is read in ${code.get(name)[0]} but is not listed in .env.example`));
    }
  }
  const documented = new Set([...environment.keys(), ...example.keys()]);
  for (const name of sorted(documented)) {
    if (code.has(name)) continue;
    if (allowed.has(name)) continue;
    const where = environment.has(name) ? environment.get(name)[0] : example.get(name)[0];
    errors.push(errorAt(ENVIRONMENT_PATH, null,
      `env var ${name} is documented in ${where} but is not read in api/, scripts/ or .github/workflows/`));
  }
  const documentedInEnvironmentOnly = sorted([...environment.keys()].filter((n) => !example.has(n)));
  for (const name of documentedInEnvironmentOnly) {
    errors.push(errorAt(ENV_EXAMPLE_PATH, null,
      `env var ${name} is documented in ${environment.get(name)[0]} but is not listed in .env.example`));
  }
  const documentedInExampleOnly = sorted([...example.keys()].filter((n) => !environment.has(n)));
  for (const name of documentedInExampleOnly) {
    errors.push(errorAt(ENVIRONMENT_PATH, null,
      `env var ${name} is listed in ${example.get(name)[0]} but is not documented in docs/ENVIRONMENT.md`));
  }
  return errors;
}

export function validateFlags({ code, flagTable }) {
  const errors = [];
  const codeFlags = new Set([...code.keys()].filter(
    (name) => flagTable.has(name) || name.endsWith('_ENABLED'),
  ));
  for (const name of sorted(codeFlags)) {
    if (!flagTable.has(name)) {
      errors.push(errorAt(ENVIRONMENT_PATH, null,
        `flag ${name} is read in ${code.get(name)[0]} but is not in the feature flag table in docs/ENVIRONMENT.md`));
    }
  }
  for (const name of sorted(flagTable.keys())) {
    if (!codeFlags.has(name)) {
      errors.push(errorAt(ENVIRONMENT_PATH, null,
        `flag ${name} is in the feature flag table (${flagTable.get(name)[0]}) but is not read in api/, scripts/ or .github/workflows/`));
    }
  }
  return errors;
}

// --- Links and anchors ------------------------------------------------

export function githubSlug(heading) {
  const text = heading
    .replace(/<[^>]+>/g, '')
    .replace(/`([^`]+)`/g, '$1')
    .trim()
    .toLowerCase()
    // GitHub keeps letters (any language), digits, spaces, hyphens and
    // underscores; every other character is dropped, and every remaining
    // space becomes one hyphen (no collapsing: "a  b" keeps two).
    .replace(/[^\p{L}\p{N} _-]+/gu, '');
  return text.replace(/ /g, '-');
}

function anchorsForMarkdown(content) {
  const anchors = new Set();
  const counts = new Map();
  let inFence = false;
  for (const line of content.split('\n')) {
    if (/^\s*(```|~~~)/.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    const heading = line.match(/^#{1,6}\s+(.+)$/);
    if (heading) {
      const base = githubSlug(heading[1]);
      const count = counts.get(base) ?? 0;
      counts.set(base, count + 1);
      anchors.add(count > 0 ? `${base}-${count}` : base);
    }
    for (const match of line.matchAll(/<a\s[^>]*(?:id|name)\s*=\s*["']([^"']+)["']/gi)) {
      anchors.add(match[1]);
    }
  }
  return anchors;
}

function anchorsForHtml(content) {
  const anchors = new Set();
  for (const match of content.matchAll(/(?:id|name)\s*=\s*["']([^"']+)["']/gi)) {
    anchors.add(match[1]);
  }
  return anchors;
}

// Extracts relative link targets from one markdown file: inline links,
// <a href>, and reference links (full `[text][label]`, collapsed
// `[label][]` and shortcut `[label]`), plus the reference definitions
// themselves (`[label]: target`), which also count as links — a
// definition pointing at a missing file is a dangling link, and a
// definition in docs/README.md indexes its target. Links inside fenced
// code blocks, inline code spans and HTML comments are not links, and
// absolute URLs are out of scope.
// Inline destinations may be `<angle>` or bare, may be preceded /
// followed by whitespace spanning lines, and may carry a title in
// `"…"`, `'…'` or `(…)` form.
export function extractLinks(path, content) {
  if (typeof content !== 'string') return [];
  // Blank (to spaces, newlines preserved) everything that is not a
  // link: fenced blocks, HTML comments and inline code spans. Offsets
  // — and therefore line numbers — are preserved.
  const lines = content.split('\n');
  const fenced = fenceStates(lines);
  const blankedLines = lines.map((line, idx) => (fenced[idx] ? ' '.repeat(line.length) : line));
  let cleaned = blankedLines.join('\n');
  cleaned = cleaned.replace(/<!--[\s\S]*?-->/g, (match) => match.replace(/[^\n]/g, ' '));
  cleaned = cleaned.replace(/<!--[\s\S]*$/g, (match) => match.replace(/[^\n]/g, ' '));
  cleaned = cleaned.replace(/`[^`\n]*`/g, (match) => ' '.repeat(match.length));
  const blankRange = (start, end) => {
    cleaned = cleaned.slice(0, start) + cleaned.slice(start, end).replace(/[^\n]/g, ' ') + cleaned.slice(end);
  };
  const lineOf = (index) => cleaned.slice(0, index).split('\n').length;
  const found = []; // { target, line, index }
  const push = (target, index) => {
    if (target) found.push({ target, line: lineOf(index), index });
  };
  // 1. Reference definitions: `[label]: destination` (optionally on
  //    the next line, optionally with a title). First definition wins,
  //    labels are case-insensitive with collapsed whitespace, and
  //    footnote definitions (`[^1]: …`) are not links.
  const definitions = new Map();
  const normalizeLabel = (label) => label.trim().toLowerCase().replace(/\s+/g, ' ');
  for (const match of cleaned.matchAll(
    /^[ \t]{0,3}\[([^\]\n]+)\]:[ \t]*(?:\n[ \t]*)?(?:<([^>\n]+)>|([^\s\n]+))(?:[ \t]+(?:"[^"]*"|'[^']*'|\([^)]*\)))?[ \t]*$/gm,
  )) {
    const label = normalizeLabel(match[1]);
    if (!label || label.startsWith('^')) continue;
    const target = match[2] ?? (match[3] ?? '').replace(/\\(.)/g, '$1');
    if (!definitions.has(label)) definitions.set(label, target);
    push(target, match.index);
    blankRange(match.index, match.index + match[0].length);
  }
  // 2. Inline links: `[text](destination)` / `![alt](destination)`.
  // A bare destination may contain escaped characters (`\(` / `\)`
  // for a filename with parentheses) and may be split across lines
  // (`NO\nPE.md`): whitespace inside a bare destination is joined
  // away, and a following quote/paren starts a title, not a second
  // destination token.
  const inlineRanges = [];
  for (const match of cleaned.matchAll(
    /!?\[[^\]]*\]\(\s*(?:<([^>\n]+)>|((?:\\.|[^\s)])+(?:\s+(?![\"' (])(?:\\.|[^\s)])+)*))(?:\s+(?:"[^"]*"|'[^']*'|\([^)]*\)))?\s*\)/g,
  )) {
    const target = match[1] ?? (match[2] ?? '').replace(/\s+/g, '').replace(/\\(.)/g, '$1');
    push(target, match.index);
    inlineRanges.push([match.index, match.index + match[0].length]);
  }
  for (const [start, end] of inlineRanges) blankRange(start, end);
  // 3. <a href>.
  const anchorRanges = [];
  for (const match of cleaned.matchAll(/<a\s[^>]*href\s*=\s*["']([^"']+)["']/gi)) {
    push(match[1], match.index);
    anchorRanges.push([match.index, match.index + match[0].length]);
  }
  for (const [start, end] of anchorRanges) blankRange(start, end);
  // 4. Reference links, on what remains: `[text][label]`,
  //    `[text][]` (label = text) and shortcut `[text]`.
  for (const match of cleaned.matchAll(/!?\[[^\]\n]*\](?:\[([^\]\n]*)\])?/g)) {
    const text = match[0].replace(/^!?\[/, '').replace(/\].*$/, '');
    const labelPart = match[1];
    const label = normalizeLabel(labelPart === undefined || labelPart === '' ? text : labelPart);
    if (!label || label.startsWith('^')) continue;
    const target = definitions.get(label);
    if (target) push(target, match.index);
  }
  return found.sort((a, b) => a.index - b.index).map(({ target, line }) => ({ target, line }));
}

export function validateLinks({ linkSources, anchorSources, paths, directories }) {
  const errors = [];
  // The same underlying problem must be reported once: a reference-style
  // link contributes both a usage (`[Missing][ref1]`) and a definition
  // (`[ref1]: NOPE.md`) pointing at the same target, and repeated links
  // to the same target are the same defect. Key diagnostics by source
  // file + resolved target + kind (+ fragment for anchor errors), so a
  // different target — or a different missing anchor — still reports.
  // The first occurrence (the usage site when it precedes the definition)
  // is the one kept.
  const seen = new Set();
  const report = (key, message) => {
    if (seen.has(key)) return;
    seen.add(key);
    errors.push(message);
  };
  const anchorsByPath = new Map();
  for (const file of anchorSources ?? []) {
    if (typeof file?.content !== 'string') continue;
    anchorsByPath.set(file.path, file.path.endsWith('.md')
      ? anchorsForMarkdown(file.content)
      : anchorsForHtml(file.content));
  }
  for (const file of [...(linkSources ?? [])].sort((a, b) => a.path.localeCompare(b.path))) {
    if (typeof file?.content !== 'string') continue;
    for (const link of extractLinks(file.path, file.content)) {
      const raw = link.target;
      if (!raw) continue;
      if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(raw) || raw.startsWith('//')) continue;
      const hashIndex = raw.indexOf('#');
      const queryIndex = raw.indexOf('?');
      const cut = [hashIndex, queryIndex].filter((i) => i !== -1);
      const pathPart = cut.length ? raw.slice(0, Math.min(...cut)) : raw;
      const fragment = hashIndex === -1 ? '' : raw.slice(hashIndex + 1);
      let decoded;
      try {
        decoded = decodeURIComponent(pathPart);
      } catch {
        report(`encoding:${file.path}:${raw}`,
          errorAt(file.path, link.line, `link ${raw} has an invalid percent-encoding`));
        continue;
      }
      // A leading slash is repo-root-relative; anything else is
      // relative to the linking file.
      const target = pathPart
        ? posix.normalize(decoded.startsWith('/')
          ? decoded.slice(1)
          : posix.join(posix.dirname(file.path), decoded))
        : file.path;
      const targetPath = target.replace(/\/$/, '');
      if (!paths.has(targetPath) && !directories.has(targetPath)) {
        report(`missing-file:${file.path}:${targetPath}`,
          errorAt(file.path, link.line, `relative link ${raw} points to missing file ${targetPath}`));
        continue;
      }
      if (!fragment) continue;
      if (targetPath.endsWith('.md')) {
        const anchors = anchorsByPath.get(targetPath);
        if (anchors && !anchors.has(fragment)) {
          report(`missing-anchor:${file.path}:${targetPath}#${fragment}`,
            errorAt(file.path, link.line,
              `relative link ${raw} points to missing anchor #${fragment} in ${targetPath}`));
        }
      } else if (targetPath.endsWith('.html')) {
        const anchors = anchorsByPath.get(targetPath);
        if (anchors && !anchors.has(fragment)) {
          report(`missing-anchor:${file.path}:${targetPath}#${fragment}`,
            errorAt(file.path, link.line,
              `relative link ${raw} points to missing anchor #${fragment} in ${targetPath}`));
        }
      } else {
        report(`anchor-non-doc:${file.path}:${targetPath}#${fragment}`,
          errorAt(file.path, link.line,
            `relative link ${raw} points to anchor #${fragment} on ${targetPath}, which is not a Markdown or HTML file so the anchor cannot resolve`));
      }
    }
  }
  return errors;
}

// --- Decision log -----------------------------------------------------

// Index rows and entry headings of the decision log, with line numbers.
// The Index is the table under the `## Index` heading; entries are the
// `## ID-NN: Title` headings that follow it (entry headings also appear
// after the Index, so the search starts at the top of the file).
export function parseDecisionLog(content) {
  const indexRows = [];
  const entries = [];
  if (typeof content !== 'string') return { indexRows, entries };
  const lines = content.split('\n');
  const fenced = fenceStates(lines);
  let indexHeading = -1;
  for (let idx = 0; idx < lines.length; idx += 1) {
    if (!fenced[idx] && /^## Index\s*$/.test(lines[idx])) { indexHeading = idx; break; }
  }
  if (indexHeading >= 0) {
    for (let index = indexHeading + 1; index < lines.length; index += 1) {
      if (fenced[index]) continue;
      if (/^##\s/.test(lines[index])) break;
      if (!lines[index].startsWith('|')) continue;
      const cells = lines[index].split('|').map((cell) => cell.trim());
      const first = cells[1] ?? '';
      if (/^---/.test(first) || /^ID$/i.test(first)) continue;
      const link = first.match(/\[?(ID-\d+)\]?\((#[^)]+)\)/);
      const bare = first.match(/^(ID-\d+)$/);
      if (link) {
        indexRows.push({
          id: link[1], anchor: link[2].slice(1), title: cells[2] ?? '', line: index + 1,
        });
      } else if (bare) {
        indexRows.push({
          id: bare[1], anchor: null, title: cells[2] ?? '', line: index + 1,
        });
      }
    }
  }
  for (const [index, line] of lines.entries()) {
    if (fenced[index]) continue;
    const match = line.match(/^## (ID-\d+):\s*(.+)$/);
    if (match) entries.push({ id: match[1], title: match[2].trim(), line: index + 1 });
  }
  return { indexRows, entries };
}

function normalizeTitle(title) {
  return String(title ?? '').replace(/`/g, '').replace(/\s+/g, ' ').trim();
}

export function validateDecisions(content) {
  const errors = [];
  if (typeof content !== 'string' || !content) {
    return [`${DECISIONS_PATH}: decision log is missing or empty`];
  }
  const { indexRows, entries } = parseDecisionLog(content);
  if (indexRows.length === 0) {
    errors.push(`${DECISIONS_PATH}: decision log has no Index table under a ## Index heading`);
  }
  const seenIndex = new Map();
  for (const row of indexRows) {
    if (seenIndex.has(row.id)) {
      errors.push(errorAt(DECISIONS_PATH, row.line, `duplicate decision ID ${row.id} in the Index (first at line ${seenIndex.get(row.id)})`));
    } else seenIndex.set(row.id, row.line);
  }
  const seenEntries = new Map();
  for (const entry of entries) {
    if (seenEntries.has(entry.id)) {
      errors.push(errorAt(DECISIONS_PATH, entry.line, `duplicate decision entry ${entry.id} (first at line ${seenEntries.get(entry.id)})`));
    } else seenEntries.set(entry.id, entry.line);
  }
  const numeric = (id) => Number(id.slice(3));
  const indexIds = indexRows.map((row) => row.id);
  const entryIds = entries.map((entry) => entry.id);
  const outOfOrder = (ids) => ids.find(
    (id, at) => at > 0 && numeric(id) <= numeric(ids[at - 1]),
  );
  const indexOutOfOrder = outOfOrder(indexIds);
  if (indexOutOfOrder) {
    const row = indexRows.find((item) => item.id === indexOutOfOrder);
    errors.push(errorAt(DECISIONS_PATH, row.line, `Index row ${indexOutOfOrder} is out of numeric order`));
  }
  const entryOutOfOrder = outOfOrder(entryIds);
  if (entryOutOfOrder) {
    const entry = entries.find((item) => item.id === entryOutOfOrder);
    errors.push(errorAt(DECISIONS_PATH, entry.line, `decision entry ${entryOutOfOrder} is out of numeric order`));
  }
  const byId = new Map(entries.map((entry) => [entry.id, entry]));
  for (const row of indexRows) {
    const entry = byId.get(row.id);
    if (!entry) {
      errors.push(errorAt(DECISIONS_PATH, row.line, `Index row ${row.id} has no matching entry`));
      continue;
    }
    if (normalizeTitle(row.title) !== normalizeTitle(entry.title)) {
      errors.push(errorAt(DECISIONS_PATH, row.line,
        `Index row ${row.id} title "${normalizeTitle(row.title)}" does not match entry title "${normalizeTitle(entry.title)}"`));
    }
    const expectedAnchor = githubSlug(`${row.id}: ${entry.title}`);
    if (row.anchor !== expectedAnchor) {
      errors.push(errorAt(DECISIONS_PATH, row.line,
        `Index row ${row.id} links to #${row.anchor ?? '(none)'} but the entry heading anchors to #${expectedAnchor}`));
    }
  }
  for (const entry of entries) {
    if (!seenIndex.has(entry.id)) {
      errors.push(errorAt(DECISIONS_PATH, entry.line, `decision entry ${entry.id} is missing from the Index`));
    }
  }
  return errors;
}

// --- Docs index -------------------------------------------------------

export function validateDocsIndex({ docsIndex, docsFiles, archivedAllowlist, docsContents }) {
  const errors = [];
  if (typeof docsIndex !== 'string') {
    return [`${DOCS_INDEX_PATH}: docs index is missing or empty`];
  }
  const archived = archivedAllowlist ?? ARCHIVED_DOC_ALLOWLIST;
  const contentsByPath = new Map();
  if (Array.isArray(docsContents)) {
    for (const file of docsContents) {
      if (typeof file?.content === 'string') contentsByPath.set(file.path, file.content);
    }
  } else if (docsContents instanceof Map) {
    for (const [path, content] of docsContents) {
      if (typeof content === 'string') contentsByPath.set(path, content);
    }
  }
  const archiveReadme = contentsByPath.get(`${ARCHIVED_DOC_PREFIX}README.md`) ?? null;
  const hasReasonInFile = (file) => {
    const content = contentsByPath.get(file);
    return typeof content === 'string'
      && content.split('\n').some((line) => /archived:\s*\S/i.test(line));
  };
  const hasReasonInArchiveReadme = (file) => {
    if (typeof archiveReadme !== 'string') return false;
    const basename = file.slice(ARCHIVED_DOC_PREFIX.length).split('/').pop();
    for (const line of archiveReadme.split('\n')) {
      if (!line.includes(basename)) continue;
      // Strip the link / filename itself; what remains must be a reason.
      const text = line
        .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
        .split(basename).join('')
        .replace(/[#*`_|>-]/g, ' ')
        .trim();
      if (text.length >= 3) return true;
    }
    return false;
  };
  for (const [file, reason] of archived) {
    if (typeof reason !== 'string' || !reason.trim()) {
      errors.push(`${DOCS_INDEX_PATH}: ${file} is in ARCHIVED_DOC_ALLOWLIST without a non-empty reason`);
    }
  }
  const indexed = new Set();
  for (const link of extractLinks(DOCS_INDEX_PATH, docsIndex)) {
    const raw = link.target;
    if (!raw || /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(raw) || raw.startsWith('//')) continue;
    const pathPart = raw.split('#')[0].split('?')[0];
    if (!pathPart) continue;
    let decoded;
    try {
      decoded = decodeURIComponent(pathPart);
    } catch {
      continue;
    }
    indexed.add(posix.normalize(decoded.startsWith('/') ? decoded.slice(1) : posix.join('docs', decoded)));
  }
  for (const file of sorted(docsFiles ?? [])) {
    if (file === DOCS_INDEX_PATH) continue;
    if (indexed.has(file)) continue;
    if (file.startsWith(ARCHIVED_DOC_PREFIX)) {
      // docs/archive/README.md is the reason artifact itself.
      if (file === `${ARCHIVED_DOC_PREFIX}README.md`) continue;
      if (hasReasonInFile(file) || hasReasonInArchiveReadme(file)) continue;
      errors.push(`${DOCS_INDEX_PATH}: ${file} is archived but has no reason (add an \`Archived: <reason>\` line to the file, or a reasoned entry for it in docs/archive/README.md)`);
      continue;
    }
    if (archived.has(file)) {
      if (typeof archived.get(file) === 'string' && archived.get(file).trim()) continue;
      // Empty reason: already reported once above for this file; the
      // exemption does not apply, but a second "not indexed" diagnostic
      // for the same entry would double-report the same defect.
      continue;
    }
    errors.push(`${DOCS_INDEX_PATH}: ${file} is not indexed in docs/README.md (link it there, or move it under docs/archive/ with a reason)`);
  }
  return errors;
}

// --- Whole contract ---------------------------------------------------

export function validateDocsContract(contract) {
  if (!isRecord(contract)) return ['docs contract must be an object'];
  const errors = [];
  const paths = contract.paths instanceof Set ? contract.paths : new Set();
  for (const required of REQUIRED_DOCS) {
    if (!paths.has(required)) errors.push(`${required}: required documentation file is missing`);
  }
  const code = parseCodeEnvVars(contract.code);
  const { environment, example } = parseDocumentedEnvVars(
    contract.environmentMd ?? null, contract.envExample ?? null,
  );
  const hasEnvironment = typeof contract.environmentMd === 'string' && contract.environmentMd.length > 0;
  const hasExample = typeof contract.envExample === 'string' && contract.envExample.length > 0;
  if (hasEnvironment && hasExample) {
    errors.push(...validateEnvVars({ code, environment, example, allowlist: contract.documentedButUnreadAllowlist }));
    errors.push(...validateFlags({ code, flagTable: parseFlagTable(contract.environmentMd) }));
  } else {
    // The env/example sync checks need both references; with either
    // missing, one skipped error per missing file is enough.
    if (!hasEnvironment) errors.push(`${ENVIRONMENT_PATH}: env and flag checks skipped because the file is missing or empty`);
    if (!hasExample) errors.push(`${ENV_EXAMPLE_PATH}: env checks skipped because the file is missing or empty`);
  }
  errors.push(...validateLinks({
    linkSources: contract.linkSources,
    anchorSources: contract.anchorSources,
    paths,
    directories: contract.directories instanceof Set ? contract.directories : new Set(),
  }));
  if (typeof contract.decisions === 'string' && contract.decisions) {
    errors.push(...validateDecisions(contract.decisions));
  } else {
    errors.push(`${DECISIONS_PATH}: decision checks skipped because the file is missing or empty`);
  }
  if (typeof contract.docsIndex === 'string' && contract.docsIndex) {
    errors.push(...validateDocsIndex({
      docsIndex: contract.docsIndex,
      docsFiles: contract.docsFiles,
      archivedAllowlist: contract.archivedAllowlist,
      docsContents: contract.docsContents ?? [...(contract.linkSources ?? []), ...(contract.anchorSources ?? [])],
    }));
  } else {
    errors.push(`${DOCS_INDEX_PATH}: docs-index check skipped because the file is missing or empty`);
  }
  return Object.freeze(errors);
}

function walkRepo(root, dir, out) {
  let entries;
  try {
    entries = readdirSync(resolve(root, dir), { withFileTypes: true });
  } catch {
    return;
  }
  entries.sort((a, b) => a.name.localeCompare(b.name));
  for (const entry of entries) {
    const rel = dir ? `${dir}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      if (SKIPPED_DIRS.has(entry.name)) continue;
      out.directories.add(rel);
      walkRepo(root, rel, out);
    } else if (entry.isFile() || entry.isSymbolicLink()) {
      // A symlinked file is followed (its target is read through the
      // link); a symlinked directory is not followed, to avoid cycles.
      let isFile = entry.isFile();
      if (entry.isSymbolicLink()) {
        try {
          isFile = statSync(resolve(root, rel)).isFile();
        } catch {
          isFile = false;
        }
      }
      if (!isFile) continue;
      out.paths.add(rel);
      if (rel === ROOT_README_PATH || (rel.startsWith('docs/') && rel.endsWith('.md'))) {
        out.markdown.push(rel);
      }
      if (rel.endsWith('.md') || rel.endsWith('.html')) out.anchorFiles.push(rel);
      if (rel.startsWith('docs/')) out.docsFiles.push(rel);
      const isCode = (prefix, exts) => rel.startsWith(prefix) && exts.some((ext) => rel.endsWith(ext));
      if (isCode('api/', ['.js', '.mjs', '.cjs'])
        || isCode('scripts/', ['.js', '.mjs', '.cjs'])
        || isCode('.github/workflows/', ['.yml', '.yaml'])) {
        out.code.push(rel);
      }
    }
  }
}

export function inspectDocsContract(rootDirectory = process.cwd()) {
  const root = resolve(rootDirectory);
  const found = {
    paths: new Set(), directories: new Set(), markdown: [], anchorFiles: [], docsFiles: [], code: [],
  };
  walkRepo(root, '', found);
  const read = (rel) => {
    try {
      return readFileSync(resolve(root, rel), 'utf8');
    } catch {
      return null;
    }
  };
  const byPath = (rel) => {
    const content = read(rel);
    return content === null ? null : { path: rel, content };
  };
  const linkSources = found.markdown.map(byPath).filter(Boolean);
  const anchorSources = found.anchorFiles.map(byPath).filter(Boolean);
  const docsContents = found.docsFiles.map(byPath).filter(Boolean);
  return {
    environmentMd: read(ENVIRONMENT_PATH),
    envExample: read(ENV_EXAMPLE_PATH),
    docsIndex: read(DOCS_INDEX_PATH),
    decisions: read(DECISIONS_PATH),
    linkSources,
    anchorSources,
    code: found.code.map(byPath).filter(Boolean),
    paths: found.paths,
    directories: found.directories,
    docsFiles: found.docsFiles,
    docsContents,
  };
}

function main() {
  const errors = validateDocsContract(inspectDocsContract());
  if (errors.length) {
    process.stderr.write(`${JSON.stringify({ ok: false, gate: 'documentation-drift', providerNetworkRequired: false, externalMutation: false, errors }, null, 2)}\n`);
    process.exitCode = 1;
    return;
  }
  process.stdout.write(`${JSON.stringify({ ok: true, gate: 'documentation-drift', providerNetworkRequired: false, externalMutation: false })}\n`);
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
