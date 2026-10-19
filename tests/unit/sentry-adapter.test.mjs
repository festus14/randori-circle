import assert from 'node:assert/strict';
import { after, beforeEach, mock, test } from 'node:test';

const originalEnvironment = {
  NODE_ENV: process.env.NODE_ENV,
  NEXT_PUBLIC_SENTRY_DSN: process.env.NEXT_PUBLIC_SENTRY_DSN,
  SENTRY_DSN: process.env.SENTRY_DSN,
  VERCEL_ENV: process.env.VERCEL_ENV,
  VERCEL: process.env.VERCEL,
  SENTRY_ENVIRONMENT: process.env.SENTRY_ENVIRONMENT,
  SENTRY_ENABLE_PREVIEW: process.env.SENTRY_ENABLE_PREVIEW,
  RANDORI_LOCAL_RUNTIME: process.env.RANDORI_LOCAL_RUNTIME,
  CI: process.env.CI,
  GITHUB_ACTIONS: process.env.GITHUB_ACTIONS,
};

const initCalls = [];
const messageCalls = [];
const exceptionCalls = [];
let initFailuresRemaining = 0;

mock.module('@sentry/node', {
  exports: {
    init: (...args) => {
      initCalls.push(args);
      if (initFailuresRemaining > 0) {
        initFailuresRemaining -= 1;
        throw new Error('expected Sentry init failure');
      }
    },
    captureMessage: (...args) => {
      messageCalls.push(args);
      return 'message-event-id';
    },
    captureException: (...args) => {
      exceptionCalls.push(args);
      return 'exception-event-id';
    },
  },
});

function clearSentryEnvironment() {
  for (const key of Object.keys(originalEnvironment)) delete process.env[key];
}

function restoreEnvironment() {
  for (const [key, value] of Object.entries(originalEnvironment)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

async function loadAdapter(name) {
  return import(`../../api/_db.js?sentry-test=${name}`);
}

beforeEach(() => {
  clearSentryEnvironment();
  initCalls.length = 0;
  messageCalls.length = 0;
  exceptionCalls.length = 0;
  initFailuresRemaining = 0;
});

after(restoreEnvironment);

test('Sentry remains disabled when neither server nor public DSN is configured', async () => {
  const adapter = await loadAdapter('no-dsn');

  adapter.initSentry();

  assert.equal(initCalls.length, 0);
  assert.equal(adapter.isSentryConfigured(), false);
  assert.equal(adapter.getSentry().ready, false);
  assert.equal(adapter.captureSentryMessage('not sent'), null);
  assert.equal(adapter.captureSentryException(new Error('not sent')), null);
  assert.equal(messageCalls.length, 0);
  assert.equal(exceptionCalls.length, 0);
});

test('Sentry initializes once with the expected server configuration', async () => {
  process.env.SENTRY_DSN = 'https://public@example.test/1';
  process.env.VERCEL_ENV = 'production';

  const adapter = await loadAdapter('one-time-init');
  adapter.initSentry();
  adapter.initSentry();

  assert.equal(initCalls.length, 1);
  assert.equal(adapter.getSentry().ready, true);
  assert.equal(initCalls[0][0].dsn, process.env.SENTRY_DSN);
  assert.equal(initCalls[0][0].environment, 'production');
  assert.equal(initCalls[0][0].tracesSampleRate, 0.1);
  assert.equal(initCalls[0][0].sendDefaultPii, false);
  const event = { message: 'preserve me' };
  assert.deepEqual(initCalls[0][0].beforeSend(event), event);
  assert.deepEqual(initCalls[0][0].beforeSendTransaction(event), event);
  assert.deepEqual(initCalls[0][0].beforeSendSpan(event), event);
});

for (const [name, environment, reason] of [
  ['local-runtime', { VERCEL_ENV: 'production', RANDORI_LOCAL_RUNTIME: 'true' }, 'local_runtime'],
  ['ci', { SENTRY_ENVIRONMENT: 'production', CI: 'true' }, 'ci'],
  ['github-actions', { SENTRY_ENVIRONMENT: 'production', GITHUB_ACTIONS: 'true' }, 'ci'],
  ['node-test', { VERCEL_ENV: 'production', NODE_ENV: 'test' }, 'test'],
  ['development', {}, 'development'],
  ['vercel-development', { VERCEL_ENV: 'development' }, 'development'],
  ['preview', { VERCEL_ENV: 'preview' }, 'preview_disabled'],
]) {
  test(`Sentry never initializes outside production: ${name}`, async () => {
    process.env.SENTRY_DSN = 'https://public@example.test/9';
    Object.assign(process.env, environment);
    const adapter = await loadAdapter(`disabled-${name}`);
    adapter.initSentry();

    assert.equal(initCalls.length, 0);
    assert.equal(adapter.getSentry().ready, false);
    assert.equal(adapter.isSentryConfigured(), false);
    assert.equal(adapter.captureSentryMessage('not sent'), null);
    assert.equal(adapter.captureSentryException(new Error('not sent')), null);
    assert.equal(messageCalls.length + exceptionCalls.length, 0);
    const { resolveSentryRuntime } = await import('../../api/_sentry.js');
    assert.equal(resolveSentryRuntime(process.env).reason, reason);
  });
}

test('Sentry preview reporting is opt-in and tagged preview', async () => {
  process.env.SENTRY_DSN = 'https://public@example.test/10';
  process.env.VERCEL_ENV = 'preview';
  process.env.SENTRY_ENABLE_PREVIEW = 'true';
  const adapter = await loadAdapter('preview-opt-in');
  assert.equal(initCalls.length, 1);
  assert.equal(initCalls[0][0].environment, 'preview');
  assert.equal(adapter.getSentry().ready, true);
});

test('Sentry environment prefers VERCEL_ENV, falls back to SENTRY_ENVIRONMENT, and rejects unknown values', async () => {
  const { resolveSentryRuntime } = await import('../../api/_sentry.js');
  assert.deepEqual({ ...resolveSentryRuntime({ VERCEL_ENV: 'production', SENTRY_ENVIRONMENT: 'preview' }) },
    { environment: 'production', enabled: true, reason: null });
  assert.deepEqual({ ...resolveSentryRuntime({ SENTRY_ENVIRONMENT: 'Production' }) },
    { environment: 'production', enabled: true, reason: null });
  assert.deepEqual({ ...resolveSentryRuntime({ SENTRY_ENVIRONMENT: 'staging' }) },
    { environment: 'development', enabled: false, reason: 'development' });
  assert.equal(resolveSentryRuntime({ VERCEL: '1', VERCEL_ENV: 'production', CI: '1' }).enabled, true);
});

test('Sentry initialization failure remains disabled and retries successfully', async () => {
  process.env.SENTRY_DSN = 'https://public@example.test/2';
  process.env.VERCEL_ENV = 'production';
  initFailuresRemaining = 1;
  const originalWarn = console.warn;
  console.warn = () => {};

  try {
    const adapter = await loadAdapter('init-retry');
    assert.equal(adapter.getSentry().ready, false);
    assert.equal(initCalls.length, 1);

    adapter.initSentry();
    adapter.initSentry();

    assert.equal(initCalls.length, 2);
    assert.equal(adapter.getSentry().ready, true);
  } finally {
    console.warn = originalWarn;
  }
});

test('capture wrappers forward sanitized messages, exceptions, and contexts', async () => {
  process.env.NEXT_PUBLIC_SENTRY_DSN = 'https://public@example.test/2';
  process.env.VERCEL_ENV = 'production';

  const adapter = await loadAdapter('capture-forwarding');
  assert.equal(adapter.isSentryConfigured(), true);
  const error = new Error('email=owner@example.test token=abc phone=+44 7700 900123');
  error.stack = `Error: ${error.message}\n    at safe-file.js:1:1`;
  const messageContext = {
    level: 'warning',
    tags: { event: 'unit-test', user_id: '42' },
    extra: {
      route: '/api/logs?token=secret',
      meta: '{"transcript":"private"}',
      nested: { email: 'owner@example.test', safe: 'kept' },
    },
  };
  const exceptionContext = {
    tags: { event: 'unit-exception' },
    extra: { code: 'console.log(secret)', transcript: 'private words', safe: true },
  };

  const messageId = adapter.captureSentryMessage(
    'contact owner@example.test with Bearer secret-token; user_id=42',
    messageContext,
  );
  const exceptionId = adapter.captureSentryException(error, exceptionContext);
  const repeatedExceptionId = adapter.captureSentryException(error, exceptionContext);

  assert.equal(messageId, 'message-event-id');
  assert.equal(exceptionId, 'exception-event-id');
  assert.equal(repeatedExceptionId, 'exception-event-id');
  assert.equal(messageCalls.length, 1);
  assert.equal(exceptionCalls.length, 2);
  assert.doesNotMatch(messageCalls[0][0], /owner@example\.test|secret-token|user_id=42/);
  assert.deepEqual(messageCalls[0][1], {
    level: 'warning',
    tags: { event: 'unit-test' },
    extra: { route: '/api/logs', nested: { safe: 'kept' } },
  });
  assert.equal(exceptionCalls[0][0], error);
  assert.equal(exceptionCalls[1][0], error);
  assert.deepEqual(exceptionCalls[0][1], {
    tags: { event: 'unit-exception' },
    extra: { safe: true },
  });
});

test('beforeSend removes sensitive request, identity, and payload fields', async () => {
  process.env.SENTRY_DSN = 'https://public@example.test/3';
  process.env.VERCEL_ENV = 'production';
  const adapter = await loadAdapter('event-redaction');
  const beforeSend = initCalls[0][0].beforeSend;
  const capturedSpanScope = { opaque: true };
  const sdkProcessingMetadata = {
    capturedSpanScope,
    dynamicSamplingContext: {
      public_key: 'safe-public-key',
      sample_rand: '0.1234567890123456',
      trace_id: 'safe-trace',
      transaction: 'GET https://app.test/api/analyze?token=private#private-fragment',
      user_segment: 'person@example.test',
    },
  };

  const sanitized = beforeSend({
    event_id: '12345678901234567890123456789012',
    message: 'failure for person@example.test at https://app.test/path?token=private',
    user: { id: '42', email: 'person@example.test', ip_address: '127.0.0.1' },
    request: {
      method: 'POST',
      url: 'https://app.test/api/analyze?token=private',
      headers: { authorization: 'Bearer private', cookie: 'session=private' },
      cookies: { session: 'private' },
      query_string: 'token=private',
      data: { code: 'private code' },
    },
    tags: { event: 'api_failure', userId: '42' },
    extra: { transcript: 'private words', code: 'private code', meta: 'private metadata', safe: 'kept' },
    metadata: { sdk: 'preserved' },
    sdkProcessingMetadata,
    exception: {
      values: [{
        type: 'Error',
        value: 'email=person@example.test token=private phone=+44 7700 900123',
      }],
    },
    contexts: {
      profile: { email: 'person@example.test', phone: '+44 7700 900123', role: 'candidate' },
      runtime: { name: 'node' },
    },
  });

  assert.doesNotMatch(JSON.stringify(sanitized), /person@example\.test|private code|private words|private metadata|Bearer private|7700|900123|token=private|session=private|"42"/);
  assert.deepEqual(sanitized.request, {
    method: 'POST',
    url: 'https://app.test/api/analyze',
  });
  assert.equal(sanitized.event_id, '12345678901234567890123456789012');
  assert.deepEqual(sanitized.tags, { event: 'api_failure' });
  assert.deepEqual(sanitized.extra, { safe: 'kept' });
  assert.deepEqual(sanitized.metadata, { sdk: 'preserved' });
  assert.equal(sanitized.sdkProcessingMetadata.capturedSpanScope, capturedSpanScope);
  assert.deepEqual(sanitized.sdkProcessingMetadata.dynamicSamplingContext, {
    public_key: 'safe-public-key',
    sample_rand: '0.1234567890123456',
    trace_id: 'safe-trace',
    transaction: 'GET https://app.test/api/analyze',
  });
  assert.deepEqual(sanitized.contexts, {
    profile: { role: 'candidate' },
    runtime: { name: 'node' },
  });

  const sanitizedSpan = initCalls[0][0].beforeSendSpan({
    trace_id: 'safe-trace-id',
    span_id: 'safe-span-id',
    start_timestamp: 123.5,
    description: 'POST https://app.test/api/analyze?token=private#fragment',
    data: {
      'http.method': 'POST',
      'url.full': 'https://app.test/api/analyze?token=private#fragment',
      'http.request.header.authorization': 'Bearer private',
      'http.fragment': 'private-fragment',
      'user.id': '42',
      apiKey: 'private-api-key',
      'server.address': 'app.test',
    },
  });
  assert.doesNotMatch(JSON.stringify(sanitizedSpan), /private|fragment|"42"/);
  assert.equal(sanitizedSpan.trace_id, 'safe-trace-id');
  assert.equal(sanitizedSpan.span_id, 'safe-span-id');
  assert.equal(sanitizedSpan.start_timestamp, 123.5);
  assert.equal(sanitizedSpan.description, 'POST https://app.test/api/analyze');
  assert.deepEqual(sanitizedSpan.data, {
    'http.method': 'POST',
    'url.full': 'https://app.test/api/analyze',
    'server.address': 'app.test',
  });
});
