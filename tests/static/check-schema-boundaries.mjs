import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SQL_SEPARATOR = String.raw`(?:\s|\/\*[\s\S]*?\*\/|--[^\r\n]*(?:\r?\n|$))+`;
const CREATE_MODIFIER = String.raw`(?:UNIQUE|TEMP(?:ORARY)?|VIRTUAL|OR${SQL_SEPARATOR}REPLACE)`;
const SOURCE_EXTENSION = /\.(?:[cm]?js|[cm]?ts)$/i;

export const FORBIDDEN_SCHEMA_PATTERNS = Object.freeze([
  {
    label: 'schema DDL',
    pattern: new RegExp(
      String.raw`\bCREATE${SQL_SEPARATOR}(?:${CREATE_MODIFIER}${SQL_SEPARATOR})*(?:TABLE|INDEX|VIEW|TRIGGER)\b`,
      'i',
    ),
  },
  {
    label: 'schema DDL',
    pattern: new RegExp(
      String.raw`\b(?:ALTER|DROP)${SQL_SEPARATOR}(?:TABLE|INDEX|VIEW|TRIGGER)\b`,
      'i',
    ),
  },
  {
    label: 'legacy destructive schedule repair',
    pattern: new RegExp(
      String.raw`\bDELETE${SQL_SEPARATOR}FROM${SQL_SEPARATOR}pair_schedules\b`,
      'i',
    ),
  },
]);

export function sourceFilesUnder(directory) {
  return readdirSync(directory, { withFileTypes: true })
    .flatMap(entry => {
      const path = `${directory}/${entry.name}`;
      if (entry.isDirectory()) return sourceFilesUnder(path);
      return entry.isFile() && SOURCE_EXTENSION.test(entry.name) ? [path] : [];
    })
    .sort();
}

function preserveLineBreaks(value) {
  const lineBreaks = value.match(/\r\n|\r|\n/g);
  return lineBreaks ? lineBreaks.join('') : ' ';
}

/**
 * Make straightforward string assembly visible to the SQL patterns. This
 * catches forms such as `'CREATE ' + 'TABLE ...'` and
 * `['CREATE', 'INDEX ...'].join(' ')` without attempting to evaluate code.
 * Newlines are retained so violation line numbers still point at the source.
 */
export function collapseObviousLiteralAssembly(source) {
  let collapsed = source;
  for (let pass = 0; pass < 8; pass += 1) {
    const next = collapsed.replace(
      /(['"`])(\s*(?:\+|,)\s*)(['"`])/g,
      (_match, _leftQuote, separator) => preserveLineBreaks(separator),
    );
    if (next === collapsed) break;
    collapsed = next;
  }
  return collapsed;
}

export function scanSchemaBoundarySource(file, source) {
  const violations = new Set();
  const candidates = [source, collapseObviousLiteralAssembly(source)];
  for (const candidate of candidates) {
    for (const rule of FORBIDDEN_SCHEMA_PATTERNS) {
      const match = rule.pattern.exec(candidate);
      if (!match) continue;
      const line = candidate.slice(0, match.index).split('\n').length;
      violations.add(`${file}:${line}: ${rule.label} belongs in db/migrations`);
    }
  }
  return [...violations];
}

export function checkSchemaBoundaries(directory = 'api') {
  const runtimeFiles = sourceFilesUnder(directory);
  const violations = runtimeFiles.flatMap(file =>
    scanSchemaBoundarySource(file, readFileSync(file, 'utf8')),
  );
  return { runtimeFiles, violations };
}

export function main(directory = 'api') {
  const { runtimeFiles, violations } = checkSchemaBoundaries(directory);
  assert.deepEqual(
    violations,
    [],
    `Runtime schema boundary violations:\n${violations.join('\n')}`,
  );
  console.log(`Schema boundary OK: ${runtimeFiles.length} API modules contain no migrations`);
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) main();
