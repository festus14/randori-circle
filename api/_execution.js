// Provider-neutral execution gateway for server-owned catalogue evaluations.
//
// The API process never runs submitted code. It builds a harness around the
// submission, sends that one file to an isolated provider, and receives only
// bounded stdout/stderr back. Expected outputs stay in the API process and are
// compared by data.js after the provider returns.
//
// Providers are opt-in through EXECUTION_PROVIDER:
// - `vercel-sandbox`: an ephemeral, non-persistent Firecracker microVM per run
//   with all egress denied, authenticated by the deployment's Vercel OIDC token.
// - `piston`: a self-hosted Piston-compatible endpoint at EXECUTION_API_URL.
// Anything else (including unset) leaves execution unavailable and fails closed.
import { Writable } from 'node:stream';

export const EXECUTION_PROVIDERS = Object.freeze(['vercel-sandbox', 'piston']);
export const MAX_EXECUTION_OUTPUT_BYTES = 256 * 1024;
export const PISTON_REQUEST_TIMEOUT_MS = 12_000;
export const SANDBOX_CREATE_TIMEOUT_MS = 20_000;
export const SANDBOX_COMMAND_TIMEOUT_MS = 10_000;
// Upper bound on the microVM session if cleanup is ever interrupted. Sandbox
// memory is billed in one-minute increments, so shorter values save nothing.
export const SANDBOX_SESSION_TIMEOUT_MS = 60_000;

// The public emkc.org Piston API became whitelist-only on 2026-02-15. It must
// never be reintroduced as an implicit default or accepted as a configured URL.
const RETIRED_PUBLIC_EXECUTION_HOSTS = Object.freeze(['emkc.org']);

const LANGUAGE_FILES = Object.freeze({ javascript: 'main.js', python: 'main.py' });

const SANDBOX_RUNTIMES = Object.freeze({
  javascript: Object.freeze({ image: 'vercel/sandbox/node:24', cmd: 'node', version: '24' }),
  python: Object.freeze({ image: 'vercel/sandbox/python:3.14', cmd: 'python3', version: '3.14' }),
});

const PISTON_RUNTIMES = Object.freeze({ javascript: '18.15.0', python: '3.10.0' });

export class ExecutionUnavailableError extends Error {
  constructor(message = 'code execution is unavailable', options) {
    super(message, options);
    this.name = 'ExecutionUnavailableError';
    this.code = 'execution_unavailable';
  }
}

export class ExecutionFailedError extends Error {
  constructor(message = 'code execution failed', options) {
    super(message, options);
    this.name = 'ExecutionFailedError';
    this.code = 'execution_failed';
  }
}

function retiredHost(hostname) {
  const host = String(hostname || '').toLowerCase().replace(/\.$/, '');
  return RETIRED_PUBLIC_EXECUTION_HOSTS.some(retired => host === retired || host.endsWith(`.${retired}`));
}

function parsePistonUrl(value) {
  const raw = String(value || '').trim();
  if (!raw) return { url: null, reason: 'EXECUTION_API_URL is not set' };
  let parsed;
  try { parsed = new URL(raw); } catch { return { url: null, reason: 'EXECUTION_API_URL is not a valid URL' }; }
  if (parsed.protocol !== 'https:') return { url: null, reason: 'EXECUTION_API_URL must use https' };
  if (parsed.username || parsed.password) return { url: null, reason: 'EXECUTION_API_URL must not embed credentials' };
  if (retiredHost(parsed.hostname)) return { url: null, reason: 'the retired public Piston API is not supported' };
  return { url: parsed.href, reason: null };
}

/**
 * Resolve the configured provider without performing any I/O.
 * @returns {{provider: string|null, configured: boolean, reason: string|null, url?: string|null}}
 */
export function resolveExecutionProvider(env = process.env) {
  const provider = String(env.EXECUTION_PROVIDER || '').trim().toLowerCase();
  if (!provider) return { provider: null, configured: false, reason: 'EXECUTION_PROVIDER is not set' };
  if (!EXECUTION_PROVIDERS.includes(provider)) {
    return { provider: null, configured: false, reason: 'EXECUTION_PROVIDER is not supported' };
  }
  if (provider === 'piston') {
    const { url, reason } = parsePistonUrl(env.EXECUTION_API_URL);
    return { provider, configured: !!url, reason, url };
  }
  return { provider, configured: true, reason: null };
}

export function executionRuntimeVersion(provider, language) {
  if (provider === 'vercel-sandbox') return SANDBOX_RUNTIMES[language]?.version ?? null;
  if (provider === 'piston') return PISTON_RUNTIMES[language] ?? null;
  return null;
}

function boundedCollector(limit, onOverflow) {
  const chunks = { stdout: [], stderr: [] };
  let bytes = 0;
  let overflowed = false;
  const stream = name => new Writable({
    write(chunk, encoding, callback) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), encoding);
      bytes += buffer.byteLength;
      if (bytes > limit) {
        if (!overflowed) { overflowed = true; onOverflow(); }
      } else {
        chunks[name].push(buffer);
      }
      callback();
    },
  });
  return {
    stdout: stream('stdout'),
    stderr: stream('stderr'),
    get overflowed() { return overflowed; },
    text(name) { return Buffer.concat(chunks[name]).toString('utf8'); },
  };
}

async function loadVercelSandboxSdk() {
  return import('@vercel/sandbox');
}

async function runInVercelSandbox({ language, source }, { loadSandboxSdk = loadVercelSandboxSdk } = {}) {
  const runtime = SANDBOX_RUNTIMES[language];
  let Sandbox;
  try {
    ({ Sandbox } = await loadSandboxSdk());
    if (typeof Sandbox?.create !== 'function') throw new Error('Sandbox SDK did not export Sandbox.create');
  } catch (error) {
    throw new ExecutionUnavailableError('Vercel Sandbox SDK is unavailable', { cause: error });
  }

  let sandbox;
  const createController = new AbortController();
  const createTimer = setTimeout(() => createController.abort(), SANDBOX_CREATE_TIMEOUT_MS);
  try {
    sandbox = await Sandbox.create({
      image: runtime.image,
      resources: { vcpus: 1 },
      timeout: SANDBOX_SESSION_TIMEOUT_MS,
      networkPolicy: 'deny-all',
      persistent: false,
      tags: { app: 'randori-circle', purpose: 'catalog-evaluation' },
      signal: createController.signal,
    });
  } catch (error) {
    // Missing OIDC credentials, exhausted plan quota, and provider outages all
    // mean the run never started; nothing about the submission is implied.
    throw new ExecutionUnavailableError('Vercel Sandbox could not be created', { cause: error });
  } finally {
    clearTimeout(createTimer);
  }

  const commandController = new AbortController();
  let timedOut = false;
  const collector = boundedCollector(MAX_EXECUTION_OUTPUT_BYTES, () => commandController.abort());
  const commandTimer = setTimeout(() => { timedOut = true; commandController.abort(); }, SANDBOX_COMMAND_TIMEOUT_MS);
  try {
    const filename = LANGUAGE_FILES[language];
    await sandbox.writeFiles([{ path: filename, content: Buffer.from(source, 'utf8') }], { signal: commandController.signal });
    let exitCode = null;
    try {
      const finished = await sandbox.runCommand({
        cmd: runtime.cmd,
        args: [filename],
        stdout: collector.stdout,
        stderr: collector.stderr,
        signal: commandController.signal,
      });
      exitCode = Number.isInteger(finished?.exitCode) ? finished.exitCode : null;
    } catch (error) {
      if (collector.overflowed) throw new ExecutionFailedError('execution output exceeded size limit', { cause: error });
      if (!timedOut) throw new ExecutionFailedError('sandbox command failed', { cause: error });
    }
    if (collector.overflowed) throw new ExecutionFailedError('execution output exceeded size limit');
    return {
      provider: 'vercel-sandbox',
      runtimeVersion: runtime.version,
      stdout: collector.text('stdout'),
      stderr: collector.text('stderr'),
      code: timedOut ? null : exitCode,
      signal: timedOut ? 'SIGKILL' : null,
      timedOut,
    };
  } catch (error) {
    if (error instanceof ExecutionFailedError) throw error;
    throw new ExecutionFailedError('sandbox execution failed', { cause: error });
  } finally {
    clearTimeout(commandTimer);
    // Delete stops the microVM and discards its filesystem. Failure here must
    // not change the evaluation result; the session timeout is the backstop.
    try { await sandbox.delete(); } catch { try { await sandbox.stop(); } catch {} }
  }
}

async function readBoundedJson(response, controller) {
  const declaredLength = Number(response.headers.get('content-length'));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_EXECUTION_OUTPUT_BYTES) {
    controller.abort();
    throw new ExecutionFailedError('execution response exceeded size limit');
  }
  const reader = response.body?.getReader?.();
  let text;
  if (!reader) {
    text = await response.text();
    if (Buffer.byteLength(text, 'utf8') > MAX_EXECUTION_OUTPUT_BYTES) throw new ExecutionFailedError('execution response exceeded size limit');
  } else {
    const chunks = [];
    let received = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      received += value.byteLength;
      if (received > MAX_EXECUTION_OUTPUT_BYTES) {
        await reader.cancel().catch(() => {});
        throw new ExecutionFailedError('execution response exceeded size limit');
      }
      chunks.push(Buffer.from(value));
    }
    text = Buffer.concat(chunks, received).toString('utf8');
  }
  try { return JSON.parse(text); } catch (error) { throw new ExecutionFailedError('execution response was not JSON', { cause: error }); }
}

async function runInPiston({ language, source }, { url, token, fetchImpl = globalThis.fetch } = {}) {
  const version = PISTON_RUNTIMES[language];
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PISTON_REQUEST_TIMEOUT_MS);
  try {
    const headers = { 'Content-Type': 'application/json' };
    if (token) headers.Authorization = `Bearer ${token}`;
    let response;
    try {
      response = await fetchImpl(url, {
        method: 'POST',
        headers,
        body: JSON.stringify({ language, version, files: [{ name: LANGUAGE_FILES[language], content: source }] }),
        signal: controller.signal,
        redirect: 'error',
      });
    } catch (error) {
      throw new ExecutionUnavailableError('execution endpoint is unreachable', { cause: error });
    }
    if (!response.ok) {
      response.body?.cancel?.().catch?.(() => {});
      throw new ExecutionUnavailableError(`execution endpoint returned status ${response.status}`);
    }
    const payload = await readBoundedJson(response, controller);
    const run = payload && typeof payload === 'object' && payload.run && typeof payload.run === 'object' ? payload.run : {};
    return {
      provider: 'piston',
      runtimeVersion: version,
      stdout: String(run.stdout || ''),
      stderr: String(run.stderr || ''),
      code: Number.isInteger(run.code) ? run.code : null,
      signal: typeof run.signal === 'string' ? run.signal.slice(0, 64) : null,
      timedOut: false,
    };
  } catch (error) {
    if (error instanceof ExecutionUnavailableError || error instanceof ExecutionFailedError) throw error;
    throw new ExecutionFailedError('execution request failed', { cause: error });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Execute one generated harness file in the configured isolated provider.
 * @param {{language: 'javascript'|'python', source: string}} request
 * @param {{env?: object, fetchImpl?: typeof fetch, loadSandboxSdk?: () => Promise<any>}} [options]
 */
export async function executeProgram(request, { env = process.env, fetchImpl, loadSandboxSdk } = {}) {
  const language = request?.language;
  if (!Object.prototype.hasOwnProperty.call(LANGUAGE_FILES, language)) throw new TypeError('unsupported execution language');
  if (typeof request.source !== 'string' || !request.source) throw new TypeError('execution source is required');
  const resolved = resolveExecutionProvider(env);
  if (!resolved.configured) throw new ExecutionUnavailableError(resolved.reason || 'code execution is unavailable');
  if (resolved.provider === 'vercel-sandbox') return runInVercelSandbox(request, { loadSandboxSdk });
  return runInPiston(request, {
    url: resolved.url,
    token: String(env.EXECUTION_API_TOKEN || '').trim() || null,
    fetchImpl: fetchImpl || globalThis.fetch,
  });
}

// ----- Harness generation and result normalisation -----

function encodeRunnerPayload(value) {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64');
}

export function buildJsHarness(userCode, testSuite, resultPrefix) {
  const encodedSuite = encodeRunnerPayload({
    entrypoint: testSuite.entrypoint,
    tests: testSuite.tests.map(test => ({ args: test.args })),
  });
  const encodedCode = Buffer.from(userCode, 'utf8').toString('base64');
  return `;(function(){
  const __randori_bundle=JSON.parse(Buffer.from('${encodedSuite}','base64').toString('utf8'));
  const __randori_source=Buffer.from('${encodedCode}','base64').toString('utf8');
  const __randori_vm=require('node:vm');
  const __randori_context=__randori_vm.createContext(Object.create(null),{codeGeneration:{strings:false,wasm:false}});
  let __randori_ready=true;
  try{ __randori_vm.runInContext(__randori_source,__randori_context,{timeout:1000}); }catch{ __randori_ready=false; }
  for(let index=0;index<__randori_bundle.tests.length;index++){
    const test=__randori_bundle.tests[index];
    let got=null, ok=false, error=null;
    try{
      if(!__randori_ready) throw new Error('submission did not load');
      __randori_context.__randori_args_json__=JSON.stringify(test.args);
      // A function that returns nothing (undefined) is a wrong answer, not a
      // crash: serialise it as null so the case reads as a plain fail.
      const expression='JSON.stringify(('+__randori_bundle.entrypoint+'(...JSON.parse(__randori_args_json__)))??null)';
      const serialized=__randori_vm.runInContext(expression,__randori_context,{timeout:1000});
      got=JSON.parse(serialized);
      ok=true;
    }catch{ error='runtime error'; }
    process.stdout.write('${resultPrefix}'+JSON.stringify({idx:index,ok,got,error})+'\\n');
  }
})();
`;
}

export function buildPythonHarness(userCode, testSuite, resultPrefix) {
  const encodedSuite = encodeRunnerPayload({
    entrypoint: testSuite.entrypoint,
    tests: testSuite.tests.map(test => ({ args: test.args })),
  });
  const encodedCode = Buffer.from(userCode, 'utf8').toString('base64');
  return `import base64 as __randori_base64
import json as __randori_json

def __randori_run():
    bundle=__randori_json.loads(__randori_base64.b64decode('${encodedSuite}').decode('utf-8'))
    source=__randori_base64.b64decode('${encodedCode}').decode('utf-8')
    safe_builtins={
        'Exception':Exception,'IndexError':IndexError,'KeyError':KeyError,'TypeError':TypeError,
        'ValueError':ValueError,'abs':abs,'all':all,'any':any,'bool':bool,'chr':chr,'dict':dict,'divmod':divmod,
        'enumerate':enumerate,'filter':filter,'float':float,'int':int,'isinstance':isinstance,
        'len':len,'list':list,'map':map,'max':max,'min':min,'next':next,'object':object,'ord':ord,
        'pow':pow,'range':range,'reversed':reversed,'round':round,'set':set,'sorted':sorted,
        'str':str,'sum':sum,'tuple':tuple,'zip':zip,
    }
    namespace={'__builtins__':safe_builtins}
    ready=True
    try:
        exec(compile(source,'submission.py','exec'),namespace,namespace)
    except Exception:
        ready=False
    fn=namespace.get(bundle['entrypoint'])
    for index,test in enumerate(bundle['tests']):
        ok=False
        got=None
        error=None
        try:
            if not ready or not callable(fn):
                raise RuntimeError('entrypoint not found')
            got=fn(*test['args'])
            __randori_json.dumps(got,separators=(',',':'))
            ok=True
        except Exception:
            error='runtime error'
        print('${resultPrefix}'+__randori_json.dumps({'idx':index,'ok':ok,'got':got,'error':error},separators=(',',':')))

__randori_run()
`;
}

export function buildExecutionHarness(language, userCode, testSuite, resultPrefix) {
  return language === 'javascript'
    ? buildJsHarness(userCode, testSuite, resultPrefix)
    : buildPythonHarness(userCode, testSuite, resultPrefix);
}

function runnerValuesEqual(a, b) {
  if (Object.is(a, b)) return true;
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((value, index) => runnerValuesEqual(value, b[index]));
  }
  if (a && b && typeof a === 'object' && typeof b === 'object') {
    const aKeys = Object.keys(a), bKeys = Object.keys(b);
    return aKeys.length === bKeys.length
      && aKeys.every(key => Object.prototype.hasOwnProperty.call(b, key) && runnerValuesEqual(a[key], b[key]));
  }
  return false;
}

export function normalizeRunnerResults(stdout, resultPrefix, tests) {
  const byIndex = new Map();
  for (const line of String(stdout || '').split('\n')) {
    const value = line.trim();
    if (!value.startsWith(resultPrefix) || value.length > 100000) continue;
    try {
      const parsed = JSON.parse(value.slice(resultPrefix.length));
      if (!Number.isInteger(parsed.idx) || parsed.idx < 0 || parsed.idx >= tests.length || typeof parsed.ok !== 'boolean') continue;
      const pass = parsed.ok && runnerValuesEqual(parsed.got, tests[parsed.idx].expected);
      byIndex.set(parsed.idx, { idx: parsed.idx, pass, error: parsed.error ? 'runtime error' : null });
    } catch {}
  }
  return tests.map((_, idx) => byIndex.get(idx) || { idx, pass: false, error: 'no result' });
}
