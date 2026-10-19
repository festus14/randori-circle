import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import test from 'node:test';

import {
  countPassed,
  DEFAULT_SMOKE_PROVIDER,
  egressFailure,
  smokeEnvironment,
  smokeFailureMessage,
} from '../../scripts/execution-smoke-checks.mjs';
import {
  DEFAULT_PROD_URL,
  parseOptions,
  readOnlyRequestDecision,
  VIEWPORTS,
} from '../../scripts/ui-screenshots-policy.mjs';

// ------------------------------------------------------ execution smoke ---

test('the execution smoke defaults to the live sandbox and refuses to run without an OIDC token', () => {
  for (const token of [undefined, '', '   ']) {
    const setup = smokeEnvironment({ VERCEL_OIDC_TOKEN: token, OTHER: 'kept' });
    assert.equal(setup.ok, false);
    assert.equal(setup.exitCode, 2);
    assert.equal(setup.env.EXECUTION_PROVIDER, DEFAULT_SMOKE_PROVIDER);
  }
  const ready = smokeEnvironment({ VERCEL_OIDC_TOKEN: 'oidc', OTHER: 'kept' });
  assert.equal(ready.ok, true);
  assert.equal(ready.env.EXECUTION_PROVIDER, 'vercel-sandbox');
  assert.equal(ready.env.OTHER, 'kept');
});

test('the execution smoke runs another explicit provider without sandbox credentials', () => {
  const env = { EXECUTION_PROVIDER: 'piston' };
  const setup = smokeEnvironment(env);
  assert.equal(setup.ok, true);
  assert.equal(setup.env.EXECUTION_PROVIDER, 'piston');
  assert.notEqual(setup.env, env, 'the caller environment is copied, not mutated');
});

test('only results that explicitly passed are counted', () => {
  assert.equal(countPassed([{ pass: true }, { pass: false }, { pass: 'yes' }, null, { pass: true }]), 2);
  assert.equal(countPassed(), 0);
});

test('the egress probe passes only on positive proof that egress is blocked', () => {
  assert.equal(egressFailure({ stdout: 'EGRESS_BLOCKED\n' }), null);
  assert.equal(egressFailure({ stdout: 'EGRESS_OPEN\n' }), 'sandbox egress is not denied');
  assert.equal(egressFailure({ stdout: 'EGRESS_OPEN EGRESS_BLOCKED' }), 'sandbox egress is not denied');
  const unconfirmed = 'sandbox egress probe did not positively confirm that egress is denied';
  assert.equal(egressFailure({ stdout: '' }), unconfirmed);
  assert.equal(egressFailure({}), unconfirmed);
  assert.equal(egressFailure({ stdout: 'EGRESS_BLOCKED', timedOut: true }), unconfirmed);
});

test('smoke failure messages keep the error name, message and cause', () => {
  const error = new TypeError('provider refused', { cause: new Error('socket closed') });
  assert.equal(smokeFailureMessage(error), 'TypeError: provider refused (cause: socket closed)');
  assert.equal(smokeFailureMessage(new Error('x', { cause: 'plain' })), 'Error: x (cause: plain)');
  assert.equal(smokeFailureMessage('boom'), 'Error: boom');
  assert.equal(smokeFailureMessage({ name: 'AbortError', message: 'timed out' }), 'AbortError: timed out');
});

// ------------------------------------------------------- ui screenshots ---

test('screenshot options default to both viewports against the https production origin', () => {
  const options = parseOptions({});
  assert.equal(options.scope, 'all');
  assert.deepEqual(options.viewports, ['mobile', 'desktop']);
  assert.equal(options.prodOrigin, new URL(DEFAULT_PROD_URL).origin);
  assert.equal(options.outDir, resolve('ui-screenshots'));
  assert.deepEqual(Object.keys(VIEWPORTS).sort(), ['desktop', 'mobile']);
});

test('screenshot options accept a trimmed scope, viewport list and origin', () => {
  const options = parseOptions({
    UI_SCREENSHOTS_SCOPE: ' public ',
    UI_SCREENSHOTS_VIEWPORTS: ' desktop , ,',
    UI_SCREENSHOTS_PROD_URL: ' https://preview.example.test/some/path?x=1 ',
    UI_SCREENSHOTS_OUT: 'out-dir',
  });
  assert.equal(options.scope, 'public');
  assert.deepEqual(options.viewports, ['desktop']);
  assert.equal(options.prodOrigin, 'https://preview.example.test');
  assert.equal(options.outDir, resolve('out-dir'));
});

test('screenshot options refuse unknown scopes, viewports and non-https origins', () => {
  assert.throws(() => parseOptions({ UI_SCREENSHOTS_SCOPE: 'prod' }), /invalid UI_SCREENSHOTS_SCOPE: prod/);
  assert.throws(() => parseOptions({ UI_SCREENSHOTS_VIEWPORTS: 'mobile,tablet' }), /invalid viewport: tablet/);
  // Inherited object keys are not viewports.
  for (const name of ['constructor', 'toString', '__proto__']) {
    assert.throws(() => parseOptions({ UI_SCREENSHOTS_VIEWPORTS: name }), /invalid viewport/);
  }
  assert.throws(() => parseOptions({ UI_SCREENSHOTS_PROD_URL: 'http://randori.example.test' }), /must be https/);
  assert.throws(() => parseOptions({ UI_SCREENSHOTS_PROD_URL: 'not a url' }), TypeError);
});

test('public capture lets only read requests through and records blocked ones without query or fragment', () => {
  for (const method of ['GET', 'HEAD', 'OPTIONS', 'get']) {
    assert.deepEqual(readOnlyRequestDecision(method, 'https://x.test/a?token=1'), { allow: true });
  }
  for (const method of ['POST', 'PUT', 'PATCH', 'DELETE', '', undefined]) {
    const decision = readOnlyRequestDecision(method, 'https://x.test/api/auth?token=secret#frag');
    assert.equal(decision.allow, false, `${method} must be blocked`);
    assert.equal(decision.blocked.url, 'https://x.test/api/auth');
    assert.doesNotMatch(JSON.stringify(decision), /secret|frag/);
  }
  assert.deepEqual(readOnlyRequestDecision('post', 'https://x.test/log#a?b').blocked,
    { method: 'POST', url: 'https://x.test/log' });
  assert.deepEqual(readOnlyRequestDecision('DELETE').blocked, { method: 'DELETE', url: '' });
});
