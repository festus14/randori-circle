import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createClient } from '@libsql/client';
import { createMigratedDatabase } from '../support/migrated-db.mjs';
import { executeProgram, executePracticePrograms, buildExecutionHarness, ExecutionInputError } from '../../api/_execution.js';
import { readExecutionQueueHealth, ExecutionBusyError } from '../../api/_execution-queue.js';
import { runExecutionSmoke, EXECUTION_SMOKE_EXPECTED_OUTPUT } from '../../api/_execution-smoke.js';
import { assessExecutionSmoke } from '../../scripts/github-execution-smoke.mjs';

const ENV = { EXECUTION_QUEUE_ENABLED: 'true', EXECUTION_PROVIDER: 'vercel-sandbox',
  JWT_SECRET: 'offline-languages-admission-test-secret'.repeat(2),
  EXECUTION_LANGUAGE_TYPESCRIPT_ENABLED: 'true', EXECUTION_LANGUAGE_GO_ENABLED: 'true', EXECUTION_STDIN_ENABLED: 'true' };
const PISTON = { ...ENV, EXECUTION_PROVIDER: 'piston', EXECUTION_API_URL: 'https://offline-piston.example.test/execute' };
async function fixture(t) {
  const file = await createMigratedDatabase({ prefix: 'randori-languages-admission-' });
  const db = createClient({ url: file.url }); t.after(() => { db.close(); file.cleanup(); }); return db;
}
const context = operation => ({ userId: 1, circleId: 1, interview: false, operation });
function sdk(createHook = async () => {}) {
  const calls = { created: [], files: [], commands: [], deleted: 0 };
  return { calls, loadSandboxSdk: async () => ({ Sandbox: { async create(params) {
    calls.created.push(params); await createHook();
    return { async writeFiles(files) { calls.files.push(files); }, async runCommand(params) {
      calls.commands.push(params); params.stdout.write('mock output'); return { exitCode: 0 };
    }, async delete() { calls.deleted++; } };
  } } }) };
}

test('Go compile+run goes through one durable provider unit and known compile exit releases it', async t => {
  const db = await fixture(t), source = buildExecutionHarness('go', 'package main\nfunc answer(x int) int {return x}',
    { entrypoint: 'answer', tests: [{ args: [1], expected: 1 }] }, '__TEST__:');
  let calls = 0;
  const run = await executeProgram({ language: 'go', source }, { env: PISTON, db, executionContext: context('go-compile'),
    fetchImpl: async (url, options) => {
      calls++; assert.equal(url, PISTON.EXECUTION_API_URL);
      assert.equal((await readExecutionQueueHealth(db, { env: PISTON })).activeUnits, 1);
      const body = JSON.parse(options.body); assert.equal(body.files.length, 2); assert.equal(body.compile_timeout, 10000);
      return new Response(JSON.stringify({ compile: { code: 1, stderr: 'private compile bytes' } }));
    } });
  assert.equal(calls, 1); assert.equal(run.compileFailed, true);
  const health = await readExecutionQueueHealth(db, { env: PISTON });
  assert.equal(health.activeUnits, 0); assert.equal(health.spend.usedDayUnits, 1);
});

test('TypeScript plus stdin reserves exactly two units before either fresh sandbox starts', async t => {
  const db = await fixture(t), observed = [];
  const fake = sdk(async () => observed.push((await readExecutionQueueHealth(db, { env: ENV })).activeUnits));
  const code = 'function answer(x: number): number {return x+1}';
  const harness = buildExecutionHarness('typescript', code, { entrypoint: 'answer', tests: [{ args: [1], expected: 2 }] }, '__TEST__:');
  await executePracticePrograms({ language: 'typescript', harness, code, stdin: 'private' },
    { env: ENV, db, executionContext: context('ts-private'), loadSandboxSdk: fake.loadSandboxSdk });
  assert.deepEqual(observed, [2, 2]); assert.equal(fake.calls.created.length, 2); assert.equal(fake.calls.deleted, 2);
  const health = await readExecutionQueueHealth(db, { env: ENV });
  assert.equal(health.recent.admitted, 1); assert.equal(health.spend.usedDayUnits, 2); assert.equal(health.activeUnits, 0);
});

test('Go stdin, invalid TypeScript and disabled/provider-unsupported languages fail before admission', async t => {
  const db = await fixture(t), fake = sdk();
  const options = { env: PISTON, db, executionContext: context('invalid'), fetchImpl: async () => { throw new Error('must not dispatch'); }, loadSandboxSdk: fake.loadSandboxSdk };
  await assert.rejects(executePracticePrograms({ language: 'go', code: 'package main', harness: 'package main', stdin: '' }, options), /custom stdin is not supported for Go/);
  await assert.rejects(executePracticePrograms({ language: 'typescript', code: 'enum X { A }', harness: '1' }, options), ExecutionInputError);
  await assert.rejects(executePracticePrograms({ language: 'go', code: 'package main', harness: 'package main' }, { ...options, env: ENV }), /not supported by this provider/);
  await assert.rejects(executePracticePrograms({ language: 'go', code: 'package main', harness: 'package main' }, { ...options, env: { ...PISTON, EXECUTION_LANGUAGE_GO_ENABLED: 'false' } }), /not enabled/);
  assert.equal(fake.calls.created.length, 0); assert.equal((await readExecutionQueueHealth(db, { env: PISTON })).spend.usedDayUnits, 0);
});

test('TypeScript restores the pristine JavaScript Node 24 snapshot, with a separate cold override', async t => {
  const db = await fixture(t), env = { ...ENV, EXECUTION_WARM_JAVASCRIPT_SNAPSHOT_ID: 'snap_pristine_node24' }, fake = sdk();
  const options = { env, db, executionContext: context('ts-warm'), loadSandboxSdk: fake.loadSandboxSdk };
  const first = await executeProgram({ language: 'typescript', source: 'const x: number=1' }, options);
  const second = await executeProgram({ language: 'typescript', source: 'const x: number=2' }, { ...options, cold: true });
  assert.equal(first.startup.mode, 'snapshot'); assert.equal(second.startup.mode, 'cold');
  assert.deepEqual(fake.calls.created[0].source, { type: 'snapshot', snapshotId: 'snap_pristine_node24' });
  assert.equal(Object.hasOwn(fake.calls.created[0], 'image'), false); assert.equal(fake.calls.created[1].image, 'vercel/sandbox/node:24');
  for (const params of fake.calls.created) { assert.equal(params.networkPolicy, 'deny-all'); assert.equal(params.persistent, false); }
  assert.deepEqual(fake.calls.commands[0].args, ['--experimental-strip-types', 'main.cts']);
  assert.doesNotMatch(fake.calls.files[0][0].content.toString(), /: number/);
});

test('combined measured smoke spends four JS/Python calls plus one TypeScript call, without cohort pollution', async t => {
  const db = await fixture(t), calls = [], env = { ...ENV, EXECUTION_WARM_MEASURE_ENABLED: 'true',
    EXECUTION_WARM_JAVASCRIPT_SNAPSHOT_ID: 'snap_js', EXECUTION_WARM_PYTHON_SNAPSHOT_ID: 'snap_py' };
  const execute = async (request, options) => { calls.push({ request, options }); return { code: 0, stdout: EXECUTION_SMOKE_EXPECTED_OUTPUT,
    startup: { mode: options.cold ? 'cold' : 'snapshot', createMs: options.cold ? 1000 : 300 } }; };
  const result = await runExecutionSmoke({ trigger: 'schedule', getDb: () => db, env, execute });
  assert.equal(result.body.ok, true); assert.equal(calls.length, 5);
  assert.equal(calls.filter(call => call.request.language === 'typescript').length, 1);
  assert.equal(calls.filter(call => call.options.cold).length, 2);
  assert.equal(result.body.languages.typescript.startup, undefined);
  assert.deepEqual(Object.keys(result.body.coldStart.languages), ['javascript', 'python']);
  assert.equal(result.body.coldStart.languages.javascript.cold.samples, 1);
  assert.equal(assessExecutionSmoke(result.body).ok, true);
  await runExecutionSmoke({ trigger: 'schedule', getDb: () => db, env, execute }); assert.equal(calls.length, 5);
});

test('new-language busy admission is deferred, but store failure is an alert', async t => {
  for (const reason of ['capacity', 'store']) {
    const db = await fixture(t);
    const result = await runExecutionSmoke({ trigger: 'schedule', getDb: () => db, env: ENV,
      execute: async request => { if (request.language === 'typescript') throw new ExecutionBusyError(reason);
        return { code: 0, stdout: EXECUTION_SMOKE_EXPECTED_OUTPUT }; } });
    const assessment = assessExecutionSmoke(result.body);
    assert.equal(result.body.languages.typescript.status, reason === 'capacity' ? 'busy' : 'provider_error');
    assert.equal(assessment.ok, reason === 'capacity'); assert.equal(assessment.category, reason === 'capacity' ? 'execution_busy' : 'execution_failed');
  }
});
