import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as Sentry from '@sentry/node';
import { sanitizeSentryEvent } from '../../api/_sentry.js';

test('the real Sentry SDK emits valid identifiers without URL secrets in envelope headers', async () => {
  const envelopes = [];
  Sentry.init({
    dsn: 'https://public@example.test/1',
    defaultIntegrations: false,
    sendDefaultPii: false,
    tracesSampleRate: 1,
    beforeSend: sanitizeSentryEvent,
    beforeSendTransaction: sanitizeSentryEvent,
    beforeSendSpan: sanitizeSentryEvent,
    transport: () => ({
      send(envelope) {
        envelopes.push(envelope);
        return Promise.resolve({ statusCode: 200 });
      },
      flush() {
        return Promise.resolve(true);
      },
    }),
  });

  try {
    await Sentry.startSpan({
      name: 'GET https://app.test/path?token=transport-secret#private-fragment',
      op: 'http.server',
    }, async () => {
      Sentry.captureMessage('safe transport event');
    });
    await Sentry.flush(2_000);

    const serialized = JSON.stringify(envelopes);
    assert.doesNotMatch(serialized, /transport-secret|private-fragment/);

    const eventEnvelopes = envelopes.filter(envelope =>
      envelope[1].some(item => item[0].type === 'event' || item[0].type === 'transaction'));
    assert.equal(eventEnvelopes.length, 2);
    for (const [header] of eventEnvelopes) {
      assert.match(header.event_id, /^[a-f0-9]{32}$/);
      assert.match(header.trace.trace_id, /^[a-f0-9]{32}$/);
      assert.match(header.trace.sample_rand, /^(?:0(?:\.\d+)?|1(?:\.0+)?)$/);
      assert.equal(header.trace.transaction, 'GET https://app.test/path');
    }
  } finally {
    await Sentry.close(2_000);
  }
});
