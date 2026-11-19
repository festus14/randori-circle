#!/usr/bin/env node
// Offline expiry inspection only: no signature verification, provider calls,
// dependencies, file writes or token-derived diagnostics. GitHub masks the
// secrets supplied in the workflow's step env before displaying runner logs;
// we never print even an add-mask command containing credential material.

const SECONDS_PER_DAY = 86_400;
const FAILURE_DAYS = 30;
const WARNING_DAYS = 45;

export function inspectTokenExpiry(token, nowSeconds = Date.now() / 1000) {
  try {
    if (typeof token !== 'string' || token.length > 65_536
      || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/u.test(token)) {
      return { status: 'malformed' };
    }
    // Inspect ONLY the payload's exp. Do not decode the header/signature or
    // return any other claim, raw bytes, parser exception or token fragment.
    const payload = token.split('.')[1];
    const bytes = Buffer.from(payload, 'base64url');
    if (bytes.toString('base64url') !== payload) return { status: 'malformed' };
    const claims = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    if (!claims || typeof claims !== 'object' || Array.isArray(claims)) {
      return { status: 'malformed' };
    }
    if (!Object.hasOwn(claims, 'exp')) return { status: 'no-exp' };
    const exp = claims.exp;
    if (typeof exp !== 'number' || !Number.isFinite(exp)
      || Math.abs(exp) > Number.MAX_SAFE_INTEGER || !Number.isFinite(nowSeconds)) {
      return { status: 'malformed' };
    }
    const days = (exp - nowSeconds) / SECONDS_PER_DAY;
    // Compare exact seconds, not a rounded display value. Both bounds inclusive.
    const status = days <= FAILURE_DAYS ? 'error' : days <= WARNING_DAYS ? 'warning' : 'ok';
    return { status, daysRemaining: Math.floor(days) };
  } catch {
    // JSON/UTF-8 exceptions can include credential bytes. Never expose them.
    return { status: 'malformed' };
  }
}

export function checkCredentialExpiry(env = process.env, nowSeconds = Date.now() / 1000, log = console.log) {
  // Fixed names only: callers cannot inject annotations via credential names.
  const credentials = [
    { name: 'DELETION_LEDGER_AUTH_TOKEN', token: env.DELETION_LEDGER_AUTH_TOKEN, optional: false },
    { name: 'TURSO_AUTH_TOKEN_EXPIRY_WATCH', token: env.TURSO_AUTH_TOKEN_EXPIRY_WATCH, optional: true },
  ];
  let failed = false;
  for (const { name, token, optional } of credentials) {
    if (token === undefined || token === '') {
      const level = optional ? 'notice' : 'error';
      log(`::${level} title=Credential expiry::${name}: days remaining unknown (missing secret; ${optional ? 'skipped' : 'required'}).`);
      if (!optional) failed = true;
      continue;
    }
    const result = inspectTokenExpiry(token, nowSeconds);
    if (result.status === 'malformed') {
      log(`::error title=Credential expiry::${name}: days remaining unknown (malformed JWT or exp; replace the secret).`);
      failed = true;
    } else if (result.status === 'no-exp') {
      log(`::notice title=Credential expiry::${name}: days remaining unbounded (no exp claim; expiry check not applicable).`);
    } else {
      const message = `${name}: ${result.daysRemaining} days remaining`;
      if (result.status === 'error') {
        log(`::error title=Credential expiry::${message} (30-day rotation deadline or expired; rotate now).`);
        failed = true;
      } else if (result.status === 'warning') {
        log(`::warning title=Credential expiry::${message} (45-day warning; plan rotation).`);
      } else {
        log(message);
      }
    }
  }
  return failed ? 1 : 0;
}

if (import.meta.main) process.exitCode = checkCredentialExpiry();
