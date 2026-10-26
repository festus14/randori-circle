#!/usr/bin/env node
// Documentation drift check (issue #363): fails when the docs no longer
// match the code. It is generic — every list below is derived by scanning
// the repository at run time, never from a hardcoded list of files,
// variables, flags, links or decision IDs.
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
// There is no docs/archive/ on main today; the definition still applies
// the day the first file is archived, with no check change.
//
// Allowlist discipline: DOCUMENTED_BUT_UNREAD_ALLOWLIST holds vars that
// are documented but deliberately not read by the scanned code, with the
// reason why. It is keyed by var name with a reason, never by file, and
// it never excuses a var the code reads but the docs omit.

import { readdirSync, readFileSync } from 'node:fs';
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

const ENV_NAME = '[A-Z][A-Z0-9_]+';
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

// Direct, bracket and destructured reads of the process environment in
// one JavaScript file. `env` and `environment` are the repo's aliases for
// the process environment (function parameters defaulting to it), so
// `env.NAME` and `environment.NAME` count as reads too. Indirect reads
// through a named constant (`env[FLAG]`, where FLAG is a const holding the
// name) and through a `*Env: 'NAME'` property (the key-ring definitions
// in _key-rotation) are resolved to the underlying name.
function codeVarsFromJs(path, source) {
  const stripped = stripJs(source);
  const found = new Map();
  // Aliases and `*Env: 'NAME'` properties are string literals, which
  // the stripped source has blanked, so they are collected from the
  // original source. They only turn into reads when the stripped code
  // actually indexes the environment through them (below), so a stray
  // mention in a comment or a string cannot invent a read.
  const aliases = new Map();
  for (const match of source.matchAll(
    /(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*['"]([A-Z][A-Z0-9_]+)['"]/g,
  )) aliases.set(match[1], match[2]);
  const hasDynamicAccess = /(?:process\.env|(?<![A-Za-z0-9_$])(?:env|environment))\s*(?:\?\.\s*)?\[/.test(stripped);
  if (hasDynamicAccess) {
    for (const match of source.matchAll(
      /[A-Za-z_$][\w$]*Env\s*:\s*['"]([A-Z][A-Z0-9_]+)['"]/g,
    )) {
      addVar(found, match[1], `${path}:${lineNumberBefore(source, match.index)}`);
    }
  }
  const envRead = new RegExp(
    `(?:process\\.env|(?<![A-Za-z0-9_$])(?:env|environment))\\s*`
    + `(?:\\?\\.\\s*|\\.\\s*)`
    + `(${ENV_NAME})`,
    'g',
  );
  for (const match of stripped.matchAll(envRead)) {
    addVar(found, match[1], `${path}:${lineNumberBefore(stripped, match.index)}`);
  }
  // Bracket-string reads (`env['NAME']`) are collected from the
  // comment-stripped source: the full stripper blanks the name string
  // itself, and comments are already gone here so a commented-out
  // read cannot count.
  const commentStripped = stripJsComments(source);
  const bracketRead = new RegExp(
    `(?:process\\.env|(?<![A-Za-z0-9_$])(?:env|environment))\\s*(?:\\?\\.\\s*)?\\[\\s*['"](${ENV_NAME})['"]\\s*\\]`,
    'g',
  );
  for (const match of commentStripped.matchAll(bracketRead)) {
    addVar(found, match[1], `${path}:${lineNumberBefore(commentStripped, match.index)}`);
  }
  const aliasRead = /(?:process\.env|(?<![A-Za-z0-9_$])(?:env|environment))\s*(?:\?\.\s*)?\[\s*([A-Za-z_$][\w$]*)\s*\]/g;
  for (const match of stripped.matchAll(aliasRead)) {
    if (aliases.has(match[1])) {
      addVar(found, aliases.get(match[1]), `${path}:${lineNumberBefore(stripped, match.index)}`);
    }
  }
  const destructured = /(?:const|let|var)\s*\{([^}]*)\}\s*=\s*(?:process\.env|(?<![A-Za-z0-9_$])(?:env|environment))\b/g;
  for (const match of stripped.matchAll(destructured)) {
    for (const part of match[1].split(',')) {
      const name = part.split(/[:=]/)[0].trim().replace(/^\.\.\./, '');
      if (new RegExp(`^${ENV_NAME}$`).test(name)) {
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
  for (const match of stripped.matchAll(
    /(?:^|[;&|])\s*(?:export\s+|local\s+)?([A-Z][A-Z0-9_]+)\s*\+?=(?!=)/gm,
  )) assigned.add(match[1]);
  for (const match of stripped.matchAll(/\bfor\s+([A-Z][A-Z0-9_]+)\s+in\b/g)) {
    assigned.add(match[1]);
  }
  const lineOf = (index) => lineNumberBefore(stripped, index);
  for (const match of stripped.matchAll(
    /\$\{\{\s*(?:vars|secrets|env|inputs)\.([A-Z][A-Z0-9_]+)\b/g,
  )) {
    addVar(found, match[1], `${path}:${lineOf(match.index)}`);
  }
  for (const match of stripped.matchAll(
    /\$\{\{\s*(?:vars|secrets|env)\[['"]([A-Z][A-Z0-9_]+)['"]\]/g,
  )) {
    addVar(found, match[1], `${path}:${lineOf(match.index)}`);
  }
  for (const match of stripped.matchAll(/\$(?:\{)?\s*([A-Z][A-Z0-9_]+)/g)) {
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

export function parseCodeEnvVars(codeFiles) {
  const found = new Map();
  for (const file of [...(codeFiles ?? [])].sort((a, b) => a.path.localeCompare(b.path))) {
    if (typeof file?.content !== 'string') continue;
    const perFile = file.path.includes('.github/workflows/')
      ? codeVarsFromWorkflow(file.path, file.content)
      : codeVarsFromJs(file.path, file.content);
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
  for (const [index, line] of text.split('\n').entries()) {
    if (!line.startsWith('|')) continue;
    const first = line.split('|').map((cell) => cell.trim())[1] ?? '';
    if (/^---/.test(first)) continue;
    // Header rows (`Variable`, `Flag`, `ID`) hold no backticked env
    // name, so they contribute nothing here.
    for (const match of first.matchAll(/`([A-Z][A-Z0-9_]+)`/g)) {
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
  const start = lines.findIndex((line) => /^### Dispatch inputs and step values\s*$/.test(line));
  if (start < 0) return;
  for (let index = start + 1; index < lines.length; index += 1) {
    if (/^#{1,3}\s/.test(lines[index])) break;
    for (const match of lines[index].matchAll(/`([A-Z][A-Z0-9_]+)`/g)) {
      addVar(map, match[1], `${path}:${index + 1}`);
    }
  }
}

function envExampleVars(text, path, map) {
  for (const [index, line] of text.split('\n').entries()) {
    const match = line.match(/^#?\s*([A-Z][A-Z0-9_]+)\s*=/);
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
  const start = lines.findIndex((line) => /^## Feature flags\s*$/.test(line));
  if (start < 0) return flags;
  for (let index = start + 1; index < lines.length; index += 1) {
    if (/^##\s/.test(lines[index])) break;
    if (!lines[index].startsWith('|')) continue;
    const first = lines[index].split('|').map((cell) => cell.trim())[1] ?? '';
    if (/^---/.test(first)) continue;
    for (const match of first.matchAll(/`([A-Z][A-Z0-9_]+)`/g)) {
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

// Extracts relative link targets from one markdown file: inline links
// and <a href>. Links inside fenced code blocks, inline code spans and
// HTML comments are not links, and absolute URLs are out of scope.
export function extractLinks(path, content) {
  const links = [];
  const lines = content.split('\n');
  let inFence = false;
  let inComment = false;
  for (const [index, rawLine] of lines.entries()) {
    let line = rawLine;
    if (/^\s*(```|~~~)/.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    if (inComment) {
      const end = line.indexOf('-->');
      if (end === -1) continue;
      line = line.slice(end + 3);
      inComment = false;
    }
    for (;;) {
      const start = line.indexOf('<!--');
      if (start === -1) break;
      const end = line.indexOf('-->', start + 4);
      if (end === -1) {
        line = line.slice(0, start);
        inComment = true;
        break;
      }
      line = line.slice(0, start) + line.slice(end + 3);
    }
    line = line.replace(/`[^`\n]*`/g, '');
    for (const match of line.matchAll(
      /\[([^\]]*)\]\(\s*(?:<([^>]+)>|([^)\s]+))(?:\s+"[^"]*")?\)/g,
    )) {
      links.push({ target: match[2] ?? match[3] ?? '', line: index + 1 });
    }
    for (const match of line.matchAll(/<a\s[^>]*href\s*=\s*["']([^"']+)["']/gi)) {
      links.push({ target: match[1], line: index + 1 });
    }
  }
  return links;
}

export function validateLinks({ linkSources, anchorSources, paths, directories }) {
  const errors = [];
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
      const pathPart = hashIndex === -1 ? raw : raw.slice(0, hashIndex);
      const fragment = hashIndex === -1 ? '' : raw.slice(hashIndex + 1);
      let decoded;
      try {
        decoded = decodeURIComponent(pathPart);
      } catch {
        errors.push(errorAt(file.path, link.line, `link ${raw} has an invalid percent-encoding`));
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
        errors.push(errorAt(file.path, link.line, `relative link ${raw} points to missing file ${targetPath}`));
        continue;
      }
      if (!fragment) continue;
      if (targetPath.endsWith('.md')) {
        const anchors = anchorsByPath.get(targetPath);
        if (anchors && !anchors.has(fragment)) {
          errors.push(errorAt(file.path, link.line,
            `relative link ${raw} points to missing anchor #${fragment} in ${targetPath}`));
        }
      } else if (targetPath.endsWith('.html')) {
        const anchors = anchorsByPath.get(targetPath);
        if (anchors && !anchors.has(fragment)) {
          errors.push(errorAt(file.path, link.line,
            `relative link ${raw} points to missing anchor #${fragment} in ${targetPath}`));
        }
      } else {
        errors.push(errorAt(file.path, link.line,
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
  const indexHeading = lines.findIndex((line) => /^## Index\s*$/.test(line));
  if (indexHeading >= 0) {
    for (let index = indexHeading + 1; index < lines.length; index += 1) {
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
  let inFence = false;
  for (const [index, line] of lines.entries()) {
    if (/^\s*(```|~~~)/.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
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

export function validateDocsIndex({ docsIndex, docsFiles, archivedAllowlist }) {
  const errors = [];
  if (typeof docsIndex !== 'string') {
    return [`${DOCS_INDEX_PATH}: docs index is missing or empty`];
  }
  const archived = archivedAllowlist ?? ARCHIVED_DOC_ALLOWLIST;
  const indexed = new Set();
  for (const link of extractLinks(DOCS_INDEX_PATH, docsIndex)) {
    const raw = link.target;
    if (!raw || /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(raw) || raw.startsWith('//')) continue;
    const pathPart = raw.split('#')[0];
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
    if (file.startsWith(ARCHIVED_DOC_PREFIX)) continue;
    if (archived.has(file)) continue;
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
    } else if (entry.isFile()) {
      out.paths.add(rel);
      if (rel === ROOT_README_PATH || (rel.startsWith('docs/') && rel.endsWith('.md'))) {
        out.markdown.push(rel);
      }
      if (rel.endsWith('.md') || rel.endsWith('.html')) out.anchorFiles.push(rel);
      if (rel.startsWith('docs/')) out.docsFiles.push(rel);
      if ((rel.startsWith('api/') && rel.endsWith('.js'))
        || (rel.startsWith('scripts/') && rel.endsWith('.mjs'))
        || (rel.startsWith('.github/workflows/') && rel.endsWith('.yml'))) {
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

if (import.meta.url === pathToFileURL(resolve(process.argv[1] || '')).href) main();
