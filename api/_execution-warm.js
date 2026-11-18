// Immutable, pristine runtime snapshots: never reuse a submitted-code VM.
// The pinned SDK exposes Sandbox.snapshot({expiration}) and
// Sandbox.create({source:{type:'snapshot',snapshotId}}), not an image plus source.
import { ExecutionBusyError, executionQueueEnabled } from './_execution-queue.js';

export const EXECUTION_RUNTIME_IMAGES = Object.freeze({
  javascript: 'vercel/sandbox/node:24', python: 'vercel/sandbox/python:3.14',
});
export const WARM_SNAPSHOT_EXPIRATION_MS = 30 * 24 * 60 * 60 * 1000;

export function executionWarmSnapshot(language, env = process.env) {
  if (!executionQueueEnabled(env)) return null;
  const value = { javascript: env.EXECUTION_WARM_JAVASCRIPT_SNAPSHOT_ID, python: env.EXECUTION_WARM_PYTHON_SNAPSHOT_ID }[language];
  if (value === undefined || value === '') return null;
  if (typeof value !== 'string' || !/^snap_[A-Za-z0-9_-]{1,128}$/.test(value)) throw new ExecutionBusyError('configuration');
  return value;
}

export function executionWarmStatus(env = process.env) {
  return Object.fromEntries(Object.keys(EXECUTION_RUNTIME_IMAGES).map(language => [language,
    { supported: env.EXECUTION_PROVIDER === 'vercel-sandbox', configured: !!executionWarmSnapshot(language, env) }]));
}

/** Opt-in operator/CLI creation, injected SDK for provider-free tests.
 * Only a fixed interpreter-version command executes before the snapshot. No
 * files, source, stdin, env secrets, ports, mounts or persistent sessions.
 */
export async function prepareExecutionSnapshot(language, { Sandbox, beforeCreate = async () => {}, lifecycle = () => {} } = {}) {
  const image = EXECUTION_RUNTIME_IMAGES[language];
  if (!image || typeof Sandbox?.create !== 'function') throw new TypeError('supported runtime and SDK required');
  let sandbox;
  const signal = AbortSignal.timeout(20000);
  await beforeCreate();
  lifecycle('start');
  try {
    sandbox = await Sandbox.create({ image, resources: { vcpus: 1 }, timeout: 60000,
      networkPolicy: 'deny-all', persistent: false, tags: { app: 'randori-circle', purpose: 'pristine-runtime' }, signal });
    if (typeof sandbox.snapshot !== 'function') throw new TypeError('SDK snapshot support required');
    const command = await sandbox.runCommand({ cmd: language === 'javascript' ? 'node' : 'python3', args: ['--version'],
      timeoutMs: 10000, signal: AbortSignal.timeout(10000) });
    if (command.exitCode !== 0) throw new Error('runtime preparation failed');
    const snapshot = await sandbox.snapshot({ expiration: WARM_SNAPSHOT_EXPIRATION_MS, signal: AbortSignal.timeout(20000) });
    if (!/^snap_[A-Za-z0-9_-]{1,128}$/.test(snapshot?.snapshotId || '')) throw new Error('snapshot unavailable');
    return { snapshotId: snapshot.snapshotId, expirationMs: WARM_SNAPSHOT_EXPIRATION_MS };
  } finally {
    if (sandbox) {
      try { await sandbox.delete({ signal: AbortSignal.timeout(5000) }); lifecycle('stopped'); }
      catch { try { await sandbox.stop({ signal: AbortSignal.timeout(5000) }); lifecycle('stopped'); } catch {} }
    }
  }
}
