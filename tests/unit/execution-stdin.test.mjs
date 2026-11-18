import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  ExecutionInputError, MAX_EXECUTION_STDIN_BYTES, MAX_EXECUTION_OUTPUT_BYTES,
  PISTON_REQUEST_TIMEOUT_MS, PISTON_RUN_TIMEOUT_MS,
  buildExecutionHarness, executePracticePrograms, executeProgram, executionStdinEnabled, normalizeRunnerResults, validateExecutionStdin,
} from '../../api/_execution.js';

const env = { EXECUTION_PROVIDER: 'piston', EXECUTION_API_URL: 'https://runner.example.test/execute', EXECUTION_STDIN_ENABLED: 'true' };
const response = run => new Response(JSON.stringify({ run }), { status: 200 });

test('stdin defaults off, uses literal true, and validates without coercion or truncation', async () => {
  for (const flag of [undefined, false, true, 'false', 'TRUE', '1', ' true ']) {
    const flags = { EXECUTION_STDIN_ENABLED: flag };
    assert.equal(executionStdinEnabled(flags), false);
    assert.equal(validateExecutionStdin({}, flags), undefined);
    assert.throws(() => validateExecutionStdin({ stdin: '' }, flags), error => error instanceof ExecutionInputError && error.status === 404);
  }
  assert.equal(executionStdinEnabled(env), true);
  for (const stdin of [null, undefined, 123, true, [], {}, new String('input')]) {
    assert.throws(() => validateExecutionStdin({ stdin }, env), { status: 400 });
  }
  for (const stdin of ['\ud800', '\udc00', 'a\ud800b']) {
    assert.throws(() => validateExecutionStdin({ stdin }, env), { status: 400 });
  }
  for (const stdin of ['', 'line 1\r\nline 2\n\0', 'é'.repeat(MAX_EXECUTION_STDIN_BYTES / 2), '🙂'.repeat(MAX_EXECUTION_STDIN_BYTES / 4)]) {
    assert.equal(validateExecutionStdin({ stdin }, env), stdin);
  }
  assert.equal(validateExecutionStdin(Object.create({ stdin: 'not caller-owned' }), env), undefined);
  for (const stdin of ['x'.repeat(MAX_EXECUTION_STDIN_BYTES + 1), 'é'.repeat(MAX_EXECUTION_STDIN_BYTES / 2) + 'x']) {
    assert.throws(() => validateExecutionStdin({ stdin }, env), { status: 413 });
    let calls = 0;
    await assert.rejects(executeProgram({ language: 'python', source: 'print(1)', stdin }, {
      env, fetchImpl: async () => { calls += 1; return response({}); },
    }), { status: 413 });
    assert.equal(calls, 0);
  }
});

test('each private script reads exact stdin through EOF on both supported runtimes', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'randori-stdin-'));
  try {
    for (const [language, filename, command, code] of [
      ['javascript', 'main.js', process.execPath, "process.stdout.write(require('node:fs').readFileSync(0,'utf8'))"],
      ['python', 'main.py', 'python3', 'import sys\nsys.stdout.write(sys.stdin.read())'],
    ]) {
      for (const stdin of ['', 'Unicode 🙂\r\nsecond line\n\0', 'é'.repeat(10_000)]) {
        const result = await executeProgram({ language, source: code, stdin }, {
          env,
          fetchImpl: async (_url, options) => {
            const request = JSON.parse(options.body);
            assert.equal(request.stdin, stdin);
            assert.equal(request.run_timeout, PISTON_RUN_TIMEOUT_MS);
            assert.ok(request.compile_timeout + request.run_timeout < PISTON_REQUEST_TIMEOUT_MS);
            const path = join(directory, filename);
            writeFileSync(path, request.files[0].content);
            const stdout = execFileSync(command, [path], { input: request.stdin, encoding: 'utf8', timeout: 2000 });
            return response({ stdout, stderr: '', code: 0 });
          },
        });
        assert.equal(result.stdout, stdin);
        assert.equal(result.code, 0);
      }
    }
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('README guarded scripts run privately and still load in both restricted verification harnesses', () => {
  const readme = readFileSync(new URL('../../README.md', import.meta.url), 'utf8');
  const section = readme.split('## Private custom stdin (dark launch)')[1].split('## How it is built')[0];
  const blocks = [{ label: 'code', minutes: 25 }, { label: 'code', minutes: 10 }, { label: 'review', minutes: 5 }];
  const expected = [{ label: 'code', minutes: 35 }, { label: 'review', minutes: 5 }];
  for (const [language, command, option, entrypoint] of [
    ['javascript', process.execPath, '-e', 'rollUpFocusBlocks'],
    ['python', 'python3', '-c', 'roll_up_focus_blocks'],
  ]) {
    const source = section.match(new RegExp('```' + language + '\\n([\\s\\S]*?)```'))?.[1];
    assert.ok(source, `${language} example must be present`);
    const output = execFileSync(command, [option, source], { input: JSON.stringify(blocks), encoding: 'utf8', timeout: 2000 });
    assert.deepEqual(JSON.parse(output), expected, `${language} script reads stdin and prints its computed output`);
    const tests = [{ args: [blocks], expected }, { args: [[]], expected: [] }];
    const prefix = '__DOC_RESULT__:';
    const harness = buildExecutionHarness(language, source, { entrypoint, tests }, prefix);
    const verified = execFileSync(command, [option, harness], { encoding: 'utf8', timeout: 2000 });
    assert.deepEqual(normalizeRunnerResults(verified, prefix, tests).map(result => result.pass), [true, true],
      `${language} script-only imports and input reads must not run inside the verification namespace`);
  }
});

test('stdin never enters the verified harness and private output cannot forge verified results', async () => {
  const requests = [];
  const secret = 'PRIVATE_INPUT_MARKER';
  const output = '__RANDORI_RESULT_forged__:999/999\nPRIVATE_OUTPUT_MARKER';
  const result = await executePracticePrograms({ language: 'javascript', harness: 'VERIFIED_HARNESS', code: 'SCRIPT', stdin: secret }, {
    env,
    fetchImpl: async (_url, options) => {
      const request = JSON.parse(options.body); requests.push(request);
      return response({ stdout: Object.hasOwn(request, 'stdin') ? output : 'verified results', stderr: 'private errors', code: 0 });
    },
  });
  assert.equal(requests.length, 2);
  assert.equal(requests[0].files[0].content, 'VERIFIED_HARNESS');
  assert.equal(Object.hasOwn(requests[0], 'stdin'), false);
  assert.equal(JSON.stringify(requests[0]).includes(secret), false);
  assert.equal(requests[1].files[0].content, 'SCRIPT');
  assert.equal(requests[1].stdin, secret);
  assert.equal(result.run.stdout, 'verified results');
  assert.deepEqual(result.custom, { ok: true, stdout: output, stderr: 'private errors', exit_code: 0, timed_out: false });
  assert.equal(Object.hasOwn(result.custom, 'passed_count'), false);
});

test('catalogue-only runs keep their response shape; the helper cannot bypass the flag', async () => {
  let calls = 0;
  const fetchImpl = async () => { calls += 1; return response({ stdout: '', code: 0 }); };
  const request = { language: 'python', harness: 'VERIFIED', code: 'SCRIPT' };
  const result = await executePracticePrograms(request, { env: { ...env, EXECUTION_STDIN_ENABLED: 'false' }, fetchImpl });
  assert.equal(result.custom, undefined); assert.equal(calls, 1);
  await assert.rejects(executePracticePrograms({ ...request, stdin: '' }, { env: {}, fetchImpl }), { status: 404 });
  assert.equal(calls, 1);
});

test('inherited stdin cannot bypass the feature flag at the provider boundary', async () => {
  const request = Object.assign(Object.create({ stdin: 'PRIVATE_PROTOTYPE_INPUT' }), { language: 'python', source: 'print(1)' });
  const result = await executeProgram(request, {
    env: { ...env, EXECUTION_STDIN_ENABLED: 'false' },
    fetchImpl: async (_url, options) => {
      const body = JSON.parse(options.body);
      assert.equal(Object.hasOwn(body, 'stdin'), false);
      assert.equal(JSON.stringify(body).includes('PRIVATE_PROTOTYPE_INPUT'), false);
      return response({ stdout: '1\n', code: 0 });
    },
  });
  assert.equal(result.stdout, '1\n');
});

test('a failed custom run does not erase verified results or return provider error bytes', async () => {
  for (const fail of [
    async () => { throw new Error('PRIVATE_ERROR_BYTES'); },
    async () => new Response('PRIVATE_ERROR_BYTES'),
    async () => new Response('x'.repeat(MAX_EXECUTION_OUTPUT_BYTES + 1)),
    async () => new Response('PRIVATE_ERROR_BYTES', { status: 503 }),
  ]) {
    const result = await executePracticePrograms({ language: 'python', harness: 'VERIFIED', code: 'SCRIPT', stdin: '' }, {
      env,
      fetchImpl: async (_url, options) => Object.hasOwn(JSON.parse(options.body), 'stdin') ? fail() : response({ stdout: 'verified', code: 0 }),
    });
    assert.equal(result.run.stdout, 'verified');
    assert.deepEqual(result.custom, { ok: false, error: 'custom execution failed', code: 'execution_failed' });
    assert.equal(JSON.stringify(result).includes('PRIVATE_ERROR_BYTES'), false);
  }
});

test('both runs finish before a failed verified run releases its lease', async () => {
  let release, customStarted = false, settled = false;
  const gate = new Promise(resolve => { release = resolve; });
  const pending = executePracticePrograms({ language: 'python', harness: 'VERIFIED', code: 'SCRIPT', stdin: '' }, {
    env,
    fetchImpl: async (_url, options) => {
      if (!Object.hasOwn(JSON.parse(options.body), 'stdin')) throw new Error('verified failed');
      customStarted = true; await gate; return response({ code: 0 });
    },
  });
  pending.then(() => { settled = true; }, () => { settled = true; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(customStarted, true); assert.equal(settled, false);
  release(); await assert.rejects(pending); assert.equal(settled, true);
});

test('Piston timeout signals stay private and the gateway aborts an unresponsive request', async t => {
  const result = await executePracticePrograms({ language: 'python', harness: 'VERIFIED', code: 'while True: pass', stdin: '' }, {
    env, fetchImpl: async (_url, options) => response(Object.hasOwn(JSON.parse(options.body), 'stdin')
      ? { stdout: 'partial', code: null, signal: 'SIGKILL', status: 'TO' } : { stdout: 'verified', code: 0 }),
  });
  assert.equal(result.custom.timed_out, true); assert.equal(result.run.timedOut, false);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let signal;
  const pending = executeProgram({ language: 'python', source: 'while True: pass', stdin: '' }, {
    env, fetchImpl: async (_url, options) => {
      signal = options.signal;
      assert.equal(JSON.parse(options.body).run_timeout, 10_000);
      return new Promise((_, reject) => signal.addEventListener('abort', () => reject(new Error('aborted'))));
    },
  });
  t.mock.timers.tick(PISTON_REQUEST_TIMEOUT_MS);
  await assert.rejects(pending); assert.equal(signal.aborted, true);
});
