import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { availableExecutionLanguages, executionLanguageEnabled, normalizeExecutionLanguage, providerSupportsLanguage } from '../../api/_execution-languages.js';
import { buildExecutionHarness, executeProgram, executePracticePrograms, executionRuntimeVersion, ExecutionInputError, ExecutionFailedError, MAX_EXECUTION_OUTPUT_BYTES, normalizeRunnerResults, stripSubmissionTypes } from '../../api/_execution.js';
import { createEvaluationSuite, getPublicExercise, listPublicExercises } from '../../api/_catalog.js';
import { deriveExerciseLanguages } from '../../api/_catalog-languages.js';
import { canonicalExerciseHash } from '../../api/_catalog-provenance.js';
import { parseCodeDocumentQuery, purgeExpiredCodeDocuments } from '../../api/_code-document.js';
import { runReferenceProgram, typescriptOracleSource, validateAdditionalLanguageReferences } from '../../scripts/validate-interview-kits.mjs';
import { GO_CATALOG_REFERENCES } from '../../scripts/catalog-go-references.mjs';
import { smokeEnvironment, smokeLanguages } from '../../scripts/execution-smoke-checks.mjs';
import { EXECUTION_SMOKE_EXPECTED_OUTPUT, runExecutionSmoke, throttledExecutionSmokeBody } from '../../api/_execution-smoke.js';
import { assessExecutionSmoke } from '../../scripts/github-execution-smoke.mjs';
import { COMPILE_FAILURE_NOTE, compileNote, syncLanguageOptions } from '../../assets/execution-languages.js';

const TS = { EXECUTION_PROVIDER: 'vercel-sandbox', EXECUTION_LANGUAGE_TYPESCRIPT_ENABLED: 'true' };
const PISTON = { EXECUTION_PROVIDER: 'piston', EXECUTION_API_URL: 'https://runner.example.test/execute',
  EXECUTION_LANGUAGE_TYPESCRIPT_ENABLED: 'true', EXECUTION_LANGUAGE_GO_ENABLED: 'true' };
const prefix = '__LANGUAGE_TEST__:';
const tests = [{ args: [2], expected: 3 }, { args: [-1], expected: 0 }];
const suite = { entrypoint: 'answer', tests };
function withEnv(env, action) {
  const keys = ['EXECUTION_PROVIDER', 'EXECUTION_API_URL', 'EXECUTION_LANGUAGE_TYPESCRIPT_ENABLED', 'EXECUTION_LANGUAGE_GO_ENABLED'];
  const prior = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  for (const key of keys) { delete process.env[key]; if (env[key] !== undefined) process.env[key] = env[key]; }
  try { return action(); } finally { for (const key of keys) { if (prior[key] === undefined) delete process.env[key]; else process.env[key] = prior[key]; } }
}

test('new languages require literal flags AND a configured supporting provider', async () => {
  assert.deepEqual(availableExecutionLanguages({}), ['javascript', 'python']);
  for (const flag of [undefined, false, true, 'TRUE', '1', 'false']) assert.equal(executionLanguageEnabled('typescript', { EXECUTION_LANGUAGE_TYPESCRIPT_ENABLED: flag }), false);
  assert.deepEqual(availableExecutionLanguages(TS), ['javascript', 'python', 'typescript']);
  assert.deepEqual(availableExecutionLanguages({ ...TS, EXECUTION_LANGUAGE_GO_ENABLED: 'true' }), ['javascript', 'python', 'typescript']);
  assert.deepEqual(availableExecutionLanguages(PISTON), ['javascript', 'python', 'typescript', 'go']);
  for (const url of ['', 'http://runner.example.test/execute', 'https://emkc.org/execute', 'https://a:b@runner.example.test/execute']) {
    assert.deepEqual(availableExecutionLanguages({ ...PISTON, EXECUTION_API_URL: url }), ['javascript', 'python']);
  }
  assert.equal(providerSupportsLanguage('vercel-sandbox', 'go'), false);
  assert.equal(executionRuntimeVersion('vercel-sandbox', 'go'), null);
  assert.equal(executionRuntimeVersion('piston', 'go'), '1.16.2');
  assert.equal(normalizeExecutionLanguage('TS'), 'typescript');
  assert.equal(normalizeExecutionLanguage('go'), 'go');
  assert.equal(normalizeExecutionLanguage('ruby'), null);
  let calls = 0;
  const forbidden = () => { calls++; throw new Error('provider must not be called'); };
  await assert.rejects(executeProgram({ language: 'typescript', source: '1' }, { env: { EXECUTION_PROVIDER: 'vercel-sandbox' }, loadSandboxSdk: forbidden }), ExecutionInputError);
  await assert.rejects(executeProgram({ language: 'go', source: 'package main' }, { env: { ...TS, EXECUTION_LANGUAGE_GO_ENABLED: 'true' }, loadSandboxSdk: forbidden }), ExecutionInputError);
  assert.equal(calls, 0);
});

test('TypeScript strips erasable syntax only, preserves VM limits and never ships expected outputs', () => {
  const source = 'type Count = number; function answer<T extends Count>(value: T): number { return value+1; }';
  const harness = buildExecutionHarness('typescript', source, suite, prefix);
  const output = runReferenceProgram('typescript', harness);
  assert.ok(normalizeRunnerResults(output, prefix, tests).every(result => result.pass));
  assert.match(harness, /codeGeneration:\{strings:false,wasm:false\}/);
  assert.match(harness, /timeout:1000/);
  assert.doesNotMatch(harness, /"expected"/);
  for (const source of ['function answer(x: number) { while(true) {} }', 'function answer(x: number) { return undefined; }']) {
    const output = runReferenceProgram('typescript', buildExecutionHarness('typescript', source, suite, prefix));
    assert.ok(normalizeRunnerResults(output, prefix, tests).every(result => !result.pass));
  }
  assert.throws(() => buildExecutionHarness('ruby', '', suite, prefix), /unsupported/);
  assert.doesNotMatch(stripSubmissionTypes(source), /type Count|extends Count|: number/);
});

test('unsupported TypeScript is a clear input error before any provider work', async () => {
  const invalid = ['enum Choice { First }', 'namespace Values { export const x = 1 }', 'class Box { constructor(public value: number) {} }'];
  let calls = 0;
  const forbidden = async () => { calls++; throw new Error('provider must not be reached'); };
  for (const source of invalid) {
    assert.throws(() => buildExecutionHarness('typescript', source, suite, prefix), error => error instanceof ExecutionInputError && error.status === 400 && /unsupported TypeScript syntax; use erasable types only/.test(error.message));
    for (const env of [TS, PISTON]) {
      await assert.rejects(executeProgram({ language: 'typescript', source }, { env, fetchImpl: forbidden, loadSandboxSdk: forbidden }), ExecutionInputError);
      await assert.rejects(executePracticePrograms({ language: 'typescript', harness: '1', code: source, stdin: '' }, { env: { ...env, EXECUTION_STDIN_ENABLED: 'true' }, fetchImpl: forbidden, loadSandboxSdk: forbidden }), ExecutionInputError);
    }
  }
  assert.equal(calls, 0);
});

test('strict Go result framing rejects duplicates, reordering, extra output and partial streams', () => {
  const rows = tests.map((test, idx) => prefix + JSON.stringify({ idx, ok: true, got: test.expected }));
  const strict = output => normalizeRunnerResults(output, prefix, tests, { strictSequence: true });
  assert.ok(strict(rows.join('\n')).every(result => result.pass));
  assert.deepEqual(strict(' \n'), tests.map((_, idx) => ({ idx, pass: false, error: 'no result' })));
  for (const output of [rows[0]+'\n'+rows.join('\n'), rows.join('\n')+'\n'+rows[1], [...rows].reverse().join('\n'), rows[0],
    'debug output\n'+rows.join('\n'), prefix+'{bad json}\n'+rows.join('\n'),
    prefix+JSON.stringify({ idx: 9, ok: true, got: 3 })+'\n'+rows.join('\n'),
    prefix+JSON.stringify({ idx: 0, ok: 'true', got: 3 })+'\n'+rows.join('\n'),
    prefix+'x'.repeat(100001)+'\n'+rows.join('\n')]) {
    assert.deepEqual(strict(output), tests.map((_, idx) => ({ idx, pass: false, error: 'invalid result sequence' })));
  }
  // Legacy JS/Python framing is intentionally unchanged with both flags off.
  assert.ok(normalizeRunnerResults(rows[0]+'\n'+rows.join('\n'), prefix, tests).every(result => result.pass));
});

test('TypeScript oracle annotations support plain and zero-argument functions and reject unsupported shapes', () => {
  function zero() { return 42; }
  const source = typescriptOracleSource(zero);
  assert.match(source, /function zero\(\): any/);
  const cases = [{ args: [], expected: 42 }];
  assert.ok(normalizeRunnerResults(runReferenceProgram('typescript', buildExecutionHarness('typescript', source, { entrypoint: 'zero', tests: cases }, prefix)), prefix, cases)[0].pass);
  for (const oracle of [function defaulted(value = 1) { return value; }, function unpack({ value }) { return value; }, function rest(...values) { return values; }, value => value]) {
    assert.throws(() => typescriptOracleSource(oracle), /plain identifier parameters/);
  }
});

test('Vercel TypeScript keeps fresh deny-all sandboxes, native stripping, bounded output and cleanup', async () => {
  const calls = []; let deleted = 0;
  const sandbox = { async writeFiles(files) { calls.push(files); }, async runCommand(params) {
    calls.push(params); params.stdout.write(`${prefix}{"idx":0,"ok":true,"got":3}\n`); return { exitCode: 0 };
  }, async delete() { deleted++; } };
  const creates = [];
  const loadSandboxSdk = async () => ({ Sandbox: { async create(options) { creates.push(options); return sandbox; } } });
  const run = await executeProgram({ language: 'typescript', source: buildExecutionHarness('typescript', 'function answer(x: number): number {return x+1}', suite, prefix) }, { env: TS, loadSandboxSdk });
  assert.equal(run.runtimeVersion, '24'); assert.equal(creates[0].networkPolicy, 'deny-all'); assert.equal(creates[0].persistent, false);
  assert.equal(calls[0][0].path, 'main.cts'); assert.deepEqual(calls[1].args, ['--experimental-strip-types', 'main.cts']); assert.equal(deleted, 1);
  sandbox.runCommand = async params => { params.stderr.write(Buffer.alloc(MAX_EXECUTION_OUTPUT_BYTES + 1)); return { exitCode: 0 }; };
  await assert.rejects(executeProgram({ language: 'typescript', source: '1' }, { env: TS, loadSandboxSdk }), ExecutionFailedError);
  assert.equal(deleted, 2);
});

test('Piston TypeScript uses its existing JS runtime and exact private stdin; Go uses a bounded compile+run', async () => {
  const requests = [];
  const fetchImpl = async (url, options) => {
    requests.push(JSON.parse(options.body));
    return new Response(JSON.stringify({ run: { code: 0, stdout: `${prefix}{"idx":0,"ok":true,"got":3}\n`, stderr: '' } }));
  };
  const source = 'function answer(x: number): number { return x+1; }';
  const result = await executePracticePrograms({ language: 'typescript', harness: buildExecutionHarness('typescript', source, suite, prefix), code: source, stdin: 'private input' }, { env: { ...PISTON, EXECUTION_STDIN_ENABLED: 'true' }, fetchImpl });
  assert.equal(requests.length, 2); assert.equal(requests[0].language, 'javascript'); assert.equal(requests[0].version, '18.15.0');
  assert.equal(requests[1].stdin, 'private input'); assert.doesNotMatch(requests[1].files[0].content, /: number/); assert.equal(result.custom.ok, true);
  const go = buildExecutionHarness('go', 'package main\nfunc answer(x int) int { return x+1 }', suite, prefix);
  assert.doesNotMatch(go.harness, /"expected"/);
  assert.match(go.harness, /randoriJson.Unmarshal\(raw,value.Interface\(\)\)/);
  assert.match(go.harness, /recover\(\)/);
  assert.match(go.harness, /returned=true/);
  assert.throws(() => buildExecutionHarness('go', 'package main', { ...suite, entrypoint: 'bad();' }, prefix), /invalid Go entrypoint/);
  await executeProgram({ language: 'go', source: go }, { env: PISTON, fetchImpl });
  const request = requests[2]; assert.equal(request.language, 'go'); assert.equal(request.version, '1.16.2');
  assert.deepEqual(request.files.map(file => file.name), ['main.go', 'submission.go']); assert.equal(request.files[1].content, go.submission);
  assert.equal(request.compile_timeout, 10_000); assert.equal(request.run_timeout, 10_000); assert.equal(request.run_cpu_time, 10_000);
  await assert.rejects(executePracticePrograms({ language: 'go', harness: go, code: go.submission, stdin: '' }, { env: { ...PISTON, EXECUTION_STDIN_ENABLED: 'true' }, fetchImpl }), /custom stdin is not supported for Go/);
  assert.equal(requests.length, 3);
});

test('Go compilation errors, timeouts, output caps and missing case results normalize fail closed', async () => {
  const request = { language: 'go', source: buildExecutionHarness('go', 'package main', suite, prefix) };
  for (const phase of [{ code: 1, stderr: 'compile failure' }, { code: null, status: 'TO', signal: 'SIGKILL' }]) {
    const run = await executeProgram(request, { env: PISTON, fetchImpl: async () => new Response(JSON.stringify({ compile: phase })) });
    assert.equal(run.timedOut, phase.status === 'TO'); assert.ok(normalizeRunnerResults(run.stdout, prefix, tests).every(result => !result.pass));
  }
  const failed = await executeProgram(request, { env: PISTON, fetchImpl: async () => new Response(JSON.stringify({ compile: { code: 0 }, run: { code: 1, stdout: `${prefix}{"idx":0,"ok":false,"got":null,"error":"panic"}\n` } })) });
  assert.deepEqual(normalizeRunnerResults(failed.stdout, prefix, tests), [{ idx: 0, pass: false, error: 'runtime error' }, { idx: 1, pass: false, error: 'no result' }]);
  await assert.rejects(executeProgram(request, { env: PISTON, fetchImpl: async () => new Response('x'.repeat(MAX_EXECUTION_OUTPUT_BYTES + 1)) }), /size limit/);
});

test('all active catalogue additions are derived without rehashing or leaking private suites', () => {
  const raw = JSON.parse(readFileSync(new URL('../../data/randori-catalog-v1.json', import.meta.url)));
  const hashes = raw.exercises.map(canonicalExerciseHash);
  withEnv({}, () => { for (const exercise of listPublicExercises()) assert.deepEqual(Object.keys(exercise.languages), ['javascript', 'python']); });
  withEnv(PISTON, () => {
    for (const exercise of listPublicExercises()) {
      assert.deepEqual(Object.keys(exercise.languages), ['javascript', 'python', 'typescript', 'go']);
      assert.doesNotMatch(JSON.stringify(exercise), /"tests"|"expected"|"oracle"/);
      for (const language of ['typescript', 'go']) {
        const suite = createEvaluationSuite(exercise.slug, exercise.version, language, { random: () => 0.5 });
        assert.equal(suite.tests.length, 8); assert.equal(suite.entrypoint, exercise.languages[language].entrypoint);
      }
    }
    assert.equal(getPublicExercise('archived-session-streak', 1), null);
    assert.equal(createEvaluationSuite('archived-session-streak', 1, 'go'), null);
    const query = { query: { room_id: 'week_1_pair_2', question_slug: 'focus-block-rollup', question_version: 1, language: 'typescript' } };
    assert.equal(parseCodeDocumentQuery(query).language, 'typescript');
    assert.equal(parseCodeDocumentQuery({ query: { ...query.query, language: 'go' } }).language, 'go');
  });
  assert.deepEqual(raw.exercises.map(canonicalExerciseHash), hashes);
  withEnv(TS, () => assert.throws(() => parseCodeDocumentQuery({ query: { room_id: 'week_1_pair_2', question_slug: 'focus-block-rollup', question_version: 1, language: 'go' } }), /provider-supported/));
  assert.throws(() => deriveExerciseLanguages({ slug: 'invalid', version: 1, languages: { javascript: { signature: 'broken' } } }), /Cannot derive/);
});

test('historical Go documents still purge after the rollout flag is off', async () => {
  const queries = [];
  const db = { async execute(statement) {
    queries.push(statement);
    if (statement.sql.includes('ORDER BY updated_at')) return { rows: [{ week_id: 1, pair_group_id: 2,
      question_slug: 'focus-block-rollup', question_version: 1, language: 'go' }] };
    if (statement.sql.includes('AS stale')) return { rows: [{ stale: 1 }] };
    return { rows: [] };
  } };
  const result = await purgeExpiredCodeDocuments(db);
  assert.deepEqual(result, { purged: 1, more: false });
  assert.ok(queries.some(statement => statement.sql.includes('DELETE FROM pair_code_documents') && statement.args.includes('go')));
});

test('offline validator runs TypeScript starters/oracles, exposes Go skips and requires Go in CI', () => {
  const raw = JSON.parse(readFileSync(new URL('../../data/randori-catalog-v1.json', import.meta.url)));
  const result = validateAdditionalLanguageReferences(raw, { goAvailable: false });
  assert.equal(result.typescriptCases, 80); assert.equal(result.goSkipped, true);
  assert.equal(Object.keys(GO_CATALOG_REFERENCES).length, 11);
  assert.throws(() => validateAdditionalLanguageReferences(raw, { goAvailable: false, requireGo: true }), /requires a local Go toolchain/);
  assert.throws(() => validateAdditionalLanguageReferences(raw, { goAvailable: false, runProgram: () => '' }), /invalid TypeScript starter/);
});

test('Go reference processes use offline toolchain settings and mock failures remain explicit', () => {
  const source = buildExecutionHarness('go', 'package main\nfunc answer(x int) int { return x+1 }', suite, prefix);
  const output = runReferenceProgram('go', source, { spawn(command, args, options) {
    assert.equal(command, 'go'); assert.deepEqual(args, ['run', 'main.go', 'submission.go']);
    assert.equal(options.env.GOPROXY, 'off'); assert.equal(options.env.GOSUMDB, 'off'); assert.equal(options.env.GOTOOLCHAIN, 'local');
    assert.equal(readFileSync(`${options.cwd}/submission.go`, 'utf8'), source.submission);
    return { status: 0, stdout: 'mock output' };
  } });
  assert.equal(output, 'mock output');
  assert.throws(() => runReferenceProgram('go', source, { spawn: () => ({ status: 1, stderr: 'mock compiler failure' }) }), /go reference process failed: mock compiler failure/);
  const raw = JSON.parse(readFileSync(new URL('../../data/randori-catalog-v1.json', import.meta.url)));
  assert.throws(() => validateAdditionalLanguageReferences(raw, { goAvailable: true, runProgram(language, program) {
    return language === 'go' ? '' : runReferenceProgram(language, program);
  } }), /go reference disagrees with oracle/);
});

test('Go references run locally only when a toolchain already exists', t => {
  if (spawnSync('go', ['version']).status !== 0) return t.skip('Go is not installed: no compiler download or provider calls permitted');
  const raw = JSON.parse(readFileSync(new URL('../../data/randori-catalog-v1.json', import.meta.url)));
  const result = validateAdditionalLanguageReferences(raw, { goAvailable: true, requireGo: true });
  assert.ok(result.goCases >= 110);
});

test('own Go compile-failure note is fixed text and never renders provider diagnostics', () => {
  const notes = [], out = { ownerDocument: { createElement: () => ({}) }, appendChild: note => notes.push(note) };
  compileNote(out, { language: 'go', execution: { compile_failed: true, stderr: 'PRIVATE_SOURCE_BYTES' } });
  assert.equal(notes[0].textContent, COMPILE_FAILURE_NOTE);
  compileNote(out, { language: 'go', execution: { compile_failed: false } }); compileNote(null, {});
  assert.equal(notes.length, 1); assert.doesNotMatch(JSON.stringify(notes), /PRIVATE_SOURCE_BYTES/);
});

test('lazy language selector uses only server-advertised additions', () => {
  const select = { options: [{ value: 'javascript' }, { value: 'python' }], appendChild(option) { this.options.push(option); } };
  const doc = { createElement() { return { remove() { select.options.splice(select.options.indexOf(this), 1); } }; } };
  select.dataset = { pendingLanguage: 'typescript' };
  syncLanguageOptions(select, [{ languages: { typescript: {} } }], doc);
  assert.equal(select.value, 'typescript'); assert.equal(select.dataset.pendingLanguage, undefined);
  assert.deepEqual(select.options.map(option => option.value), ['javascript', 'python', 'typescript']);
  syncLanguageOptions(select, [{ languages: { go: {} } }], doc);
  assert.deepEqual(select.options.map(option => option.value), ['javascript', 'python', 'go']);
  syncLanguageOptions(select, [], doc); assert.equal(select.options.length, 2);
});

test('language smoke targets fit existing budgets, and cache cannot hide new-language failures', async () => {
  assert.deepEqual(smokeLanguages(PISTON), ['javascript', 'python']);
  const setup = smokeEnvironment({ EXECUTION_LANGUAGE_TYPESCRIPT_ENABLED: 'true', VERCEL_OIDC_TOKEN: 'unused-offline-test-token' });
  assert.deepEqual(smokeLanguages({ ...setup.env, EXECUTION_SMOKE_LANGUAGE: 'typescript' }), ['typescript']);
  assert.equal(createEvaluationSuite('focus-block-rollup', 1, 'typescript', { env: setup.env }).tests.length, 8);
  assert.match(readFileSync(new URL('../../scripts/execution-smoke.mjs', import.meta.url), 'utf8'), /createEvaluationSuite\(SLUG, VERSION, language, \{ env \}\)/);
  assert.deepEqual(smokeLanguages({ ...PISTON, EXECUTION_SMOKE_LANGUAGE: 'go' }), ['go']);
  assert.throws(() => smokeLanguages({ ...TS, EXECUTION_SMOKE_LANGUAGE: 'go' }), /not enabled or provider-supported/);
  const calls = [], writes = [];
  const db = { async execute(statement) { writes.push(statement); return { rows: statement.sql.includes('RETURNING id') ? [{ id: 1 }] : [] }; } };
  const result = await runExecutionSmoke({ trigger: 'deploy', getDb: () => db, env: PISTON, execute: async request => {
    calls.push(request); return { code: 0, stdout: EXECUTION_SMOKE_EXPECTED_OUTPUT };
  } });
  assert.deepEqual(calls.map(request => request.language), ['javascript', 'python', 'typescript', 'go']);
  assert.equal(result.body.ok, true); assert.equal(writes.length, 2); assert.equal(assessExecutionSmoke(result.body).ok, true);
  const old = { saved: true, checkedAt: '2026-11-18T12:00:00Z', claimAgeSeconds: 100, languages: { javascript: { status: 'ok', durationMs: 1 }, python: { status: 'ok', durationMs: 1 } } };
  const cached = throttledExecutionSmokeBody(old, { languageNames: availableExecutionLanguages(PISTON) });
  assert.equal(cached.ok, false); assert.equal(cached.languages.go.lastStatus, 'result_missing'); assert.equal(assessExecutionSmoke(cached).ok, false);
  const failing = structuredClone(result.body); failing.ok = false; failing.languages.go.status = 'provider_error';
  assert.equal(assessExecutionSmoke(failing).category, 'execution_failed');
  const unknown = structuredClone(result.body); unknown.languages.ruby = { status: 'ok', durationMs: 1 };
  assert.equal(assessExecutionSmoke(unknown).category, 'malformed_response');
});
