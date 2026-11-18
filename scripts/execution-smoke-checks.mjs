// Pure decision logic for scripts/execution-smoke.mjs. The smoke itself
// creates real Vercel Sandboxes and is excluded from unit coverage; these
// helpers hold the parts that decide pass/fail so they can be unit tested.

import { availableExecutionLanguages } from '../api/_execution-languages.js';
export function smokeLanguages(env = process.env) {
  const selected = String(env.EXECUTION_SMOKE_LANGUAGE || '').trim().toLowerCase();
  if (!selected) return ['javascript', 'python']; // <= five real creations incl. egress probe
  if (!availableExecutionLanguages(env).includes(selected)) throw new Error('selected smoke language is not enabled or provider-supported');
  return [selected]; // two oracle runs + at most one egress probe
}

export const DEFAULT_SMOKE_PROVIDER = 'vercel-sandbox';

// Returns the environment the smoke runs with, or a refusal when the live
// provider is selected without credentials (the smoke must never fall back
// to a different provider silently).
export function smokeEnvironment(processEnv = {}) {
  const env = { ...processEnv, EXECUTION_PROVIDER: processEnv.EXECUTION_PROVIDER || DEFAULT_SMOKE_PROVIDER };
  if (env.EXECUTION_PROVIDER === DEFAULT_SMOKE_PROVIDER && !String(env.VERCEL_OIDC_TOKEN || '').trim()) {
    return { ok: false, env, exitCode: 2 };
  }
  return { ok: true, env };
}

export function countPassed(results = []) {
  return results.filter(result => result?.pass === true).length;
}

// The egress probe passes only on positive proof that egress is denied: an
// open request fails, and so does a timeout or missing marker.
export function egressFailure(probe = {}) {
  const stdout = String(probe.stdout || '');
  if (stdout.includes('EGRESS_OPEN')) return 'sandbox egress is not denied';
  if (probe.timedOut || !stdout.includes('EGRESS_BLOCKED')) {
    return 'sandbox egress probe did not positively confirm that egress is denied';
  }
  return null;
}

export function smokeFailureMessage(error) {
  const cause = error?.cause ? ` (cause: ${error.cause.message || error.cause})` : '';
  return `${error?.name || 'Error'}: ${error?.message || error}${cause}`;
}
