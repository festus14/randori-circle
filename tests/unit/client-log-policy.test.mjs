// ID-72: the server-side client log policy behind POST /api/logs. Parity of
// redactLogText with the browser logger is covered in client-logger.test.mjs.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  CLIENT_LOG_PRODUCTION_LEVELS,
  clientLogLevelAccepted,
  redactLogRoute,
  redactLogText,
  redactLogValue,
} from '../../api/_client-log-policy.js';

test('only Vercel production restricts client levels to warn and error', () => {
  assert.deepEqual(CLIENT_LOG_PRODUCTION_LEVELS, ['warn', 'error']);
  const production = { VERCEL_ENV: 'production', NODE_ENV: 'production' };
  assert.deepEqual(['info', 'warn', 'error', 'success', 'debug'].filter(level => clientLogLevelAccepted(level, production)), ['warn', 'error']);
  for (const env of [{ VERCEL_ENV: 'preview', NODE_ENV: 'production' }, { NODE_ENV: 'production' }, {}]) {
    assert.equal(clientLogLevelAccepted('debug', env), true, JSON.stringify(env));
  }
  const previous = process.env.VERCEL_ENV;
  try {
    process.env.VERCEL_ENV = 'production';
    assert.equal(clientLogLevelAccepted('info'), false, 'defaults to process.env');
  } finally {
    if (previous === undefined) delete process.env.VERCEL_ENV; else process.env.VERCEL_ENV = previous;
  }
});

test('a route keeps pathname and search only', () => {
  assert.equal(redactLogRoute('/invite?view=code&token=abc#invite=' + 'A'.repeat(43)), '/invite?view=code&token=[redacted]');
  assert.equal(redactLogRoute('/history'), '/history');
  assert.equal(redactLogRoute(undefined), '');
});

test('values are redacted recursively, bounded, and secret-named keys lose their value', () => {
  const nested = { a: { b: { c: { d: 'too deep' } } } };
  const value = redactLogValue({
    path: '/api/x?token=abc',
    email: 'erin@example.test',
    Authorization: 'Bearer abc',
    sessionHash: 'f'.repeat(64),
    code: 'print(1)',
    otp: '123456',
    cycleKey: 'kept',
    count: 3,
    ok: false,
    missing: null,
    list: Array.from({ length: 25 }, (_, index) => `item ${index} frank@example.test`),
    nested,
    err: new Error('failure for gina@example.test'),
    big: 12n,
  });
  assert.equal(value.path, '/api/x?token=[redacted]');
  assert.equal(value.email, '[email]');
  for (const key of ['Authorization', 'sessionHash', 'code', 'otp']) assert.equal(value[key], '[redacted]', key);
  assert.equal(value.cycleKey, 'kept');
  assert.equal(value.count, 3);
  assert.equal(value.ok, false);
  assert.equal(value.missing, null);
  assert.equal(value.list.length, 20);
  assert.equal(value.list[0], 'item 0 [email]');
  assert.deepEqual(value.nested, { a: { b: { c: '[truncated]' } } });
  assert.match(value.err, /^Error: failure for \[email\]\n/);
  assert.equal(value.big, '12');
  assert.equal(redactLogValue(undefined), undefined);
  assert.equal(redactLogValue('hal@example.test'), '[email]');
  const stackless = new Error('stackless ivy@example.test');
  stackless.stack = '';
  assert.equal(redactLogValue(stackless), 'Error: stackless [email]');
  const wide = Object.fromEntries(Array.from({ length: 40 }, (_, index) => [`k${index}`, index]));
  assert.equal(Object.keys(redactLogValue(wide)).length, 30);
});

test('text redaction coerces and caps its input', () => {
  assert.equal(redactLogText(undefined), '');
  assert.equal(redactLogText(42), '42');
  assert.equal(redactLogText('y'.repeat(9000)).length, 8000);
});
