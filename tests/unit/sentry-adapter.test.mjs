import assert from 'node:assert/strict';
import { after, beforeEach, mock, test } from 'node:test';

const originalEnvironment = {
  NODE_ENV: process.env.NODE_ENV,
  NEXT_PUBLIC_SENTRY_DSN: process.env.NEXT_PUBLIC_SENTRY_DSN,
  SENTRY_DSN: process.env.SENTRY_DSN,
  VERCEL_ENV: process.env.VERCEL_ENV,
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
  delete process.env.NODE_ENV;
  delete process.env.NEXT_PUBLIC_SENTRY_DSN;
  delete process.env.SENTRY_DSN;
  delete process.env.VERCEL_ENV;
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
  assert.equal(adapter.getSentry().ready, false);
  assert.equal(adapter.captureSentryMessage('not sent'), null);
  assert.equal(adapter.captureSentryException(new Error('not sent')), null);
  assert.equal(messageCalls.length, 0);
  assert.equal(exceptionCalls.length, 0);
});

test('Sentry initializes once with the expected server configuration', async () => {
  process.env.SENTRY_DSN = 'https://public@example.test/1';
  process.env.VERCEL_ENV = 'preview';

  const adapter = await loadAdapter('one-time-init');
  adapter.initSentry();
  adapter.initSentry();

  assert.equal(initCalls.length, 1);
  assert.equal(adapter.getSentry().ready, true);
  assert.equal(initCalls[0][0].dsn, process.env.SENTRY_DSN);
  assert.equal(initCalls[0][0].environment, 'preview');
  assert.equal(initCalls[0][0].tracesSampleRate, 0.1);
  assert.equal(initCalls[0][0].sendDefaultPii, false);
  const event = { message: 'preserve me' };
  assert.deepEqual(initCalls[0][0].beforeSend(event), event);
  assert.deepEqual(initCalls[0][0].beforeSendTransaction(event), event);
  assert.deepEqual(initCalls[0][0].beforeSendSpan(event), event);
});

test('Sentry initialization failure remains disabled and retries successfully', async () => {
  process.env.SENTRY_DSN = 'https://public@example.test/2';
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

  const adapter = await loadAdapter('capture-forwarding');
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
