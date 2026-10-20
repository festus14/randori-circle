import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { test } from 'node:test';
import {
  EXECUTION_PROVIDERS,
  ExecutionFailedError,
  ExecutionUnavailableError,
  MAX_EXECUTION_OUTPUT_BYTES,
  SANDBOX_COMMAND_TIMEOUT_MS,
  buildExecutionHarness,
  executeProgram,
  executionRuntimeVersion,
  normalizeRunnerResults,
  resolveExecutionProvider,
} from '../../api/_execution.js';

const SANDBOX_ENV = { EXECUTION_PROVIDER: 'vercel-sandbox' };
const PISTON_URL = 'https://runner.example.test/api/v2/execute';

function fakeSandboxSdk({ create, writeFiles, runCommand, onDelete, deleteFails = false } = {}) {
  const calls = { create: [], writeFiles: [], runCommand: [], deleted: 0, stopped: 0 };
  const sandbox = {
    async writeFiles(files, opts) {
      calls.writeFiles.push({ files, opts });
      if (writeFiles) await writeFiles(files, opts);
    },
    async runCommand(params) {
      calls.runCommand.push(params);
      return runCommand ? runCommand(params) : { exitCode: 0 };
    },
    async delete() {
      calls.deleted += 1;
      onDelete?.();
      if (deleteFails) throw new Error('delete failed');
    },
    async stop() { calls.stopped += 1; },
  };
  const sdk = {
    Sandbox: {
      async create(params) {
        calls.create.push(params);
        if (create) await create(params);
        return sandbox;
      },
    },
  };
  return { calls, loadSandboxSdk: async () => sdk };
}

test('the retired public emkc.org Piston endpoint is never referenced by runtime code', () => {
  const runtimeFiles = [
    ...readdirSync(new URL('../../api/', import.meta.url)).filter(name => name.endsWith('.js')).map(name => `api/${name}`),
    'index.html',
  ];
  for (const file of runtimeFiles) {
    const source = readFileSync(new URL(`../../${file}`, import.meta.url), 'utf8');
    assert.doesNotMatch(source, /https?:\/\/(?:[\w-]+\.)*emkc\.org|emkc\.org\/api/i, `${file} must not call the retired public Piston API`);
  }
});

test('the retired public Piston host is rejected even when configured explicitly', async () => {
  for (const url of [
    'https://emkc.org/api/v2/piston/execute',
    'https://EMKC.org./api/v2/piston/execute',
    'https://api.emkc.org/api/v2/piston/execute',
  ]) {
    const resolved = resolveExecutionProvider({ EXECUTION_PROVIDER: 'piston', EXECUTION_API_URL: url });
    assert.equal(resolved.configured, false, url);
    let calls = 0;
    await assert.rejects(
      executeProgram({ language: 'javascript', source: '1' }, {
        env: { EXECUTION_PROVIDER: 'piston', EXECUTION_API_URL: url },
        fetchImpl: async () => { calls += 1; return new Response('{}'); },
      }),
      ExecutionUnavailableError,
    );
    assert.equal(calls, 0);
  }
});

test('provider resolution is explicit, allow-listed, and performs no I/O', () => {
  assert.deepEqual(EXECUTION_PROVIDERS, ['vercel-sandbox', 'piston']);
  assert.deepEqual(resolveExecutionProvider({}), { provider: null, configured: false, reason: 'EXECUTION_PROVIDER is not set' });
  assert.equal(resolveExecutionProvider({ EXECUTION_PROVIDER: 'judge0' }).configured, false);
  assert.equal(resolveExecutionProvider({ EXECUTION_PROVIDER: ' Vercel-Sandbox ' }).configured, true);
  assert.equal(resolveExecutionProvider({ EXECUTION_PROVIDER: 'piston' }).configured, false);
  for (const url of ['not a url', 'http://runner.example.test/execute', 'https://user:pass@runner.example.test/execute']) {
    assert.equal(resolveExecutionProvider({ EXECUTION_PROVIDER: 'piston', EXECUTION_API_URL: url }).configured, false, url);
  }
  assert.deepEqual(resolveExecutionProvider({ EXECUTION_PROVIDER: 'piston', EXECUTION_API_URL: PISTON_URL }), {
    provider: 'piston', configured: true, reason: null, url: PISTON_URL,
  });
  assert.equal(executionRuntimeVersion('vercel-sandbox', 'javascript'), '24');
  assert.equal(executionRuntimeVersion('vercel-sandbox', 'python'), '3.14');
  assert.equal(executionRuntimeVersion('piston', 'javascript'), '18.15.0');
  assert.equal(executionRuntimeVersion(null, 'javascript'), null);
});

test('unconfigured execution fails closed and validates its request', async () => {
  await assert.rejects(executeProgram({ language: 'javascript', source: '1' }, { env: {} }), ExecutionUnavailableError);
  await assert.rejects(executeProgram({ language: 'ruby', source: '1' }, { env: SANDBOX_ENV }), TypeError);
  await assert.rejects(executeProgram({ language: 'python', source: '' }, { env: SANDBOX_ENV }), TypeError);
});

test('Vercel Sandbox runs each harness in a fresh, non-persistent, egress-denied microVM and deletes it', async () => {
  for (const [language, image, cmd, file] of [
    ['javascript', 'vercel/sandbox/node:24', 'node', 'main.js'],
    ['python', 'vercel/sandbox/python:3.14', 'python3', 'main.py'],
  ]) {
    const { calls, loadSandboxSdk } = fakeSandboxSdk({
      runCommand(params) {
        params.stdout.write('RESULT line\n');
        params.stderr.write('warning\n');
        return { exitCode: 0 };
      },
    });
    const result = await executeProgram({ language, source: 'HARNESS' }, { env: SANDBOX_ENV, loadSandboxSdk });
    assert.deepEqual(result, {
      provider: 'vercel-sandbox',
      runtimeVersion: language === 'javascript' ? '24' : '3.14',
      stdout: 'RESULT line\n',
      stderr: 'warning\n',
      code: 0,
      signal: null,
      timedOut: false,
    });
    const created = calls.create[0];
    assert.equal(created.image, image);
    assert.equal(created.networkPolicy, 'deny-all');
    assert.equal(created.persistent, false);
    assert.deepEqual(created.resources, { vcpus: 1 });
    assert.ok(created.timeout <= 60_000);
    assert.ok(created.signal instanceof AbortSignal);
    assert.equal(Object.hasOwn(created, 'env'), false, 'no application secrets enter the sandbox');
    assert.equal(calls.writeFiles[0].files[0].path, file);
    assert.equal(calls.writeFiles[0].files[0].content.toString('utf8'), 'HARNESS');
    assert.equal(calls.runCommand[0].cmd, cmd);
    assert.deepEqual(calls.runCommand[0].args, [file]);
    assert.equal(calls.runCommand[0].sudo, undefined);
    assert.equal(calls.deleted, 1);
  }
});

test('Vercel Sandbox creation and SDK failures are reported as execution unavailable', async () => {
  const unavailableSdk = { loadSandboxSdk: async () => { throw new Error('module not found'); } };
  await assert.rejects(executeProgram({ language: 'javascript', source: '1' }, { env: SANDBOX_ENV, ...unavailableSdk }), ExecutionUnavailableError);
  await assert.rejects(
    executeProgram({ language: 'javascript', source: '1' }, { env: SANDBOX_ENV, loadSandboxSdk: async () => ({ Sandbox: {} }) }),
    ExecutionUnavailableError,
  );
  const { calls, loadSandboxSdk } = fakeSandboxSdk({ create() { throw new Error('quota exceeded'); } });
  await assert.rejects(executeProgram({ language: 'python', source: '1' }, { env: SANDBOX_ENV, loadSandboxSdk }), ExecutionUnavailableError);
  assert.equal(calls.runCommand.length, 0);
});

test('Vercel Sandbox command failures and oversized output fail closed after cleanup', async () => {
  const failing = fakeSandboxSdk({ runCommand() { throw new Error('stream reset'); }, deleteFails: true });
  await assert.rejects(executeProgram({ language: 'javascript', source: '1' }, { env: SANDBOX_ENV, loadSandboxSdk: failing.loadSandboxSdk }), ExecutionFailedError);
  assert.equal(failing.calls.deleted, 1);
  assert.equal(failing.calls.stopped, 1, 'stop is the fallback when delete fails');

  const writeFailing = fakeSandboxSdk({ writeFiles() { throw new Error('write failed'); } });
  await assert.rejects(executeProgram({ language: 'javascript', source: '1' }, { env: SANDBOX_ENV, loadSandboxSdk: writeFailing.loadSandboxSdk }), ExecutionFailedError);
  assert.equal(writeFailing.calls.deleted, 1);

  const noisy = fakeSandboxSdk({
    async runCommand(params) {
      params.stdout.write(Buffer.alloc(MAX_EXECUTION_OUTPUT_BYTES + 1, 'x'));
      assert.equal(params.signal.aborted, true, 'overflow aborts the command immediately');
      throw new Error('aborted');
    },
  });
  await assert.rejects(
    executeProgram({ language: 'python', source: '1' }, { env: SANDBOX_ENV, loadSandboxSdk: noisy.loadSandboxSdk }),
    error => error instanceof ExecutionFailedError && /size limit/.test(error.message),
  );
  assert.equal(noisy.calls.deleted, 1);

  const quietOverflow = fakeSandboxSdk({
    runCommand(params) {
      params.stderr.write('y'.repeat(MAX_EXECUTION_OUTPUT_BYTES + 1));
      return { exitCode: 0 };
    },
  });
  await assert.rejects(executeProgram({ language: 'python', source: '1' }, { env: SANDBOX_ENV, loadSandboxSdk: quietOverflow.loadSandboxSdk }), ExecutionFailedError);
});

test('a Vercel Sandbox command that exceeds its deadline is killed and reported as a timed-out run', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { calls, loadSandboxSdk } = fakeSandboxSdk({
    runCommand(params) {
      params.stdout.write('PARTIAL\n');
      return new Promise((_, reject) => params.signal.addEventListener('abort', () => reject(new Error('aborted'))));
    },
  });
  const pending = executeProgram({ language: 'python', source: 'while True: pass' }, { env: SANDBOX_ENV, loadSandboxSdk });
  for (let index = 0; index < 5 && calls.runCommand.length === 0; index += 1) await new Promise(resolve => setImmediate(resolve));
  t.mock.timers.tick(SANDBOX_COMMAND_TIMEOUT_MS);
  const result = await pending;
  assert.equal(result.timedOut, true);
  assert.equal(result.signal, 'SIGKILL');
  assert.equal(result.code, null);
  assert.equal(result.stdout, 'PARTIAL\n');
  assert.equal(calls.deleted, 1);
});

test('the self-hosted Piston provider posts one file with an optional bearer token and bounded response', async () => {
  const requests = [];
  const result = await executeProgram({ language: 'python', source: 'print(1)' }, {
    env: { EXECUTION_PROVIDER: 'piston', EXECUTION_API_URL: PISTON_URL, EXECUTION_API_TOKEN: ' secret-token ' },
    fetchImpl: async (url, options) => {
      requests.push({ url, options });
      return new Response(JSON.stringify({ run: { stdout: '1\n', stderr: '', code: 0, signal: null } }), { status: 200 });
    },
  });
  assert.deepEqual(result, { provider: 'piston', runtimeVersion: '3.10.0', stdout: '1\n', stderr: '', code: 0, signal: null, timedOut: false });
  assert.equal(requests[0].url, PISTON_URL);
  assert.equal(requests[0].options.headers.Authorization, 'Bearer secret-token');
  assert.equal(requests[0].options.redirect, 'error');
  assert.deepEqual(JSON.parse(requests[0].options.body), {
    language: 'python', version: '3.10.0', files: [{ name: 'main.py', content: 'print(1)' }],
  });

  const env = { EXECUTION_PROVIDER: 'piston', EXECUTION_API_URL: PISTON_URL };
  await assert.rejects(executeProgram({ language: 'javascript', source: '1' }, { env, fetchImpl: async () => { throw new TypeError('fetch failed'); } }), ExecutionUnavailableError);
  await assert.rejects(executeProgram({ language: 'javascript', source: '1' }, { env, fetchImpl: async () => new Response('busy', { status: 429 }) }), ExecutionUnavailableError);
  await assert.rejects(executeProgram({ language: 'javascript', source: '1' }, { env, fetchImpl: async () => new Response('nope', { status: 200 }) }), ExecutionFailedError);
  const sansToken = [];
  await executeProgram({ language: 'javascript', source: '1' }, { env, fetchImpl: async (_url, options) => { sansToken.push(options); return new Response('{}'); } });
  assert.equal(Object.hasOwn(sansToken[0].headers, 'Authorization'), false);
});

test('the JavaScript harness reports a function that returns nothing as a wrong answer, not a runtime error', async () => {
  const { execFileSync } = await import('node:child_process');
  const suite = { entrypoint: 'solve', tests: [{ args: [1], expected: 1 }, { args: [2], expected: null }] };
  const stub = buildExecutionHarness('javascript', 'function solve(value) {\n  // TODO\n}', suite, '__P__:');
  const stubResults = execFileSync(process.execPath, ['-e', stub], { encoding: 'utf8' }).trim().split('\n')
    .map(line => JSON.parse(line.slice('__P__:'.length)));
  assert.deepEqual(stubResults, [
    { idx: 0, ok: true, got: null, error: null },
    { idx: 1, ok: true, got: null, error: null },
  ]);
  assert.deepEqual(normalizeRunnerResults(stubResults.map(r => '__P__:' + JSON.stringify(r)).join('\n'), '__P__:', suite.tests), [
    { idx: 0, pass: false, error: null },
    { idx: 1, pass: true, error: null },
  ]);
  const thrower = buildExecutionHarness('javascript', 'function solve() { throw new Error("boom"); }', suite, '__P__:');
  const thrown = execFileSync(process.execPath, ['-e', thrower], { encoding: 'utf8' }).trim().split('\n')
    .map(line => JSON.parse(line.slice('__P__:'.length)));
  assert.equal(thrown[0].error, 'runtime error', 'a real exception is still an error');
});

test('harnesses keep answer keys server-side and results are normalised against expected values', () => {
  const suite = { entrypoint: 'add', tests: [{ args: [1, 2], expected: 3 }, { args: [2, 2], expected: 5 }, { args: [0, 0], expected: 0 }] };
  for (const language of ['javascript', 'python']) {
    const harness = buildExecutionHarness(language, 'SUBMISSION', suite, '__P__:');
    const encoded = harness.match(/(?:Buffer\.from|b64decode)\('([A-Za-z0-9+/=]+)'/)[1];
    assert.equal(JSON.stringify(JSON.parse(Buffer.from(encoded, 'base64').toString('utf8'))).includes('expected'), false);
  }
  const stdout = [
    '__P__:{"idx":0,"ok":true,"got":3,"error":null}',
    '__P__:{"idx":1,"ok":true,"got":4,"error":null}',
    'noise',
    '__P__:{"idx":7,"ok":true,"got":0,"error":null}',
  ].join('\n');
  assert.deepEqual(normalizeRunnerResults(stdout, '__P__:', suite.tests), [
    { idx: 0, pass: true, error: null },
    { idx: 1, pass: false, error: null },
    { idx: 2, pass: false, error: 'no result' },
  ]);
});
