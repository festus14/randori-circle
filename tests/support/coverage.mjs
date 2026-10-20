#!/usr/bin/env node
// Accurate unit-test coverage for api/*.js, db/*.js, scripts/*.mjs and the
// browser modules with unit tests (assets/auth-dialog.js, assets/onboarding-flow.js,
// assets/app-shell.js).
//
// Why not `node --experimental-test-coverage`? Node 24's built-in coverage
// merger mis-reports any module that is also replaced with `mock.module()`:
// when `--test-coverage-include` globs are set, the include check returns
// before the `?node-test-mock=` URL filter runs, so the mock's tiny synthetic
// source is attributed to the real file path. The per-file table then shows
// the synthetic module (e.g. `_outbox.js` at ~7% lines / 100% functions) and
// the totals double count. Real imports with a cache-busting query string
// (`_db.js?sentry-test=...`) are likewise never merged with the plain URL.
//
// This runner collects raw V8 coverage with NODE_V8_COVERAGE, drops mock
// module entries, folds query-string imports back onto the real file URL,
// and lets c8 (@bcoe/v8-coverage + istanbul) merge and report. `--all` adds
// files that no test loads at 0%.
//
// Usage:
//   node tests/support/coverage.mjs [--report] [--lines=N --branches=N --functions=N]
//     --report       print the per-file table (default prints a summary only)
//     --out=DIR      keep the istanbul reports (json-summary, json, lcov) in DIR
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
// Browser modules with unit tests (WP-A auth dialog, WP-O onboarding flow, WP-S app shell).
const INCLUDE = ['api/*.js', 'db/*.js', 'scripts/*.mjs', 'assets/auth-dialog.js', 'assets/onboarding-flow.js', 'assets/app-shell.js'];
const MOCK_PARAM = 'node-test-mock';

const args = process.argv.slice(2);
const flag = (name) => args.includes(`--${name}`);
const option = (name) => args.find((arg) => arg.startsWith(`--${name}=`))?.split('=').slice(1).join('=');

export function sanitizeProcessCoverage(processCov) {
  const result = [];
  for (const script of processCov.result || []) {
    const { url } = script;
    if (!url.startsWith('file:')) continue;
    const queryIndex = url.indexOf('?');
    if (queryIndex === -1) {
      result.push(script);
      continue;
    }
    const params = new URLSearchParams(url.slice(queryIndex + 1));
    if (params.has(MOCK_PARAM)) continue;
    result.push({ ...script, url: url.slice(0, queryIndex) });
  }
  return { ...processCov, result };
}

function run(command, commandArgs, env) {
  const child = spawnSync(command, commandArgs, { cwd: ROOT, stdio: 'inherit', env });
  if (child.error) throw child.error;
  return child.status ?? 1;
}

function main() {
  const work = mkdtempSync(join(tmpdir(), 'randori-coverage-'));
  const rawDir = join(work, 'raw');
  const cleanDir = join(work, 'clean');
  mkdirSync(rawDir);
  mkdirSync(cleanDir);
  try {
    const testFiles = readdirSync(join(ROOT, 'tests', 'unit'))
      .filter((name) => name.endsWith('.test.mjs'))
      .sort()
      .map((name) => join('tests', 'unit', name));
    const testStatus = run(process.execPath, ['--experimental-test-module-mocks', '--test', ...testFiles], {
      ...process.env,
      NODE_V8_COVERAGE: rawDir,
    });
    if (testStatus !== 0) {
      console.error(`coverage: unit tests failed (exit ${testStatus})`);
      return testStatus;
    }

    let dropped = 0;
    for (const name of readdirSync(rawDir)) {
      if (!name.endsWith('.json')) continue;
      const raw = JSON.parse(readFileSync(join(rawDir, name), 'utf8'));
      const clean = sanitizeProcessCoverage(raw);
      dropped += (raw.result?.length || 0) - clean.result.length;
      writeFileSync(join(cleanDir, name), JSON.stringify(clean));
    }

    const c8 = join(ROOT, 'node_modules', 'c8', 'bin', 'c8.js');
    const outDir = option('out');
    const reportsDir = outDir ? resolve(ROOT, outDir) : join(work, 'report');
    const c8Args = [
      c8, 'report',
      `--temp-directory=${cleanDir}`,
      `--reports-dir=${reportsDir}`,
      `--src=${ROOT}`,
      '--all',
      '--exclude-node-modules',
      ...INCLUDE.map((glob) => `--include=${glob}`),
      `--reporter=${flag('report') ? 'text' : 'text-summary'}`,
      ...(outDir ? ['--reporter=json-summary', '--reporter=json', '--reporter=lcovonly'] : []),
    ];
    const thresholds = ['lines', 'branches', 'functions']
      .map((metric) => [metric, option(metric)])
      .filter(([, value]) => value !== undefined);
    if (thresholds.length > 0) {
      c8Args.push('--check-coverage', ...thresholds.map(([metric, value]) => `--${metric}=${value}`));
    }
    const reportStatus = run(process.execPath, c8Args, process.env);
    if (process.env.COVERAGE_DEBUG) console.error(`coverage: dropped ${dropped} non-file or mock script entries`);
    return reportStatus;
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main();
}
