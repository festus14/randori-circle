import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { afterEach, test } from 'node:test';
import jwt from 'jsonwebtoken';

import aiHandler from '../../api/ai.js';
import authHandler from '../../api/auth.js';
import dataHandler from '../../api/data.js';
import opsHandler from '../../api/ops.js';
import videoHandler from '../../api/video.js';
import {
  JWT_AUDIENCE,
  JWT_ISSUER,
  deterministicColor,
  getAdminEmails,
  getCronSecret,
  getJwtSecret,
  isoWeekLabel,
  shuffleArray,
  verifyMutationOrigin,
  verifySignedRequestAuth,
} from '../../api/_db.js';

const originalEnvironment = {
  NODE_ENV: process.env.NODE_ENV,
  JWT_SECRET: process.env.JWT_SECRET,
  GOOGLE_CLIENT_ID: process.env.GOOGLE_CLIENT_ID,
  GOOGLE_CLIENT_SECRET: process.env.GOOGLE_CLIENT_SECRET,
  APP_URL: process.env.APP_URL,
  ALLOW_OPEN_SIGNUP: process.env.ALLOW_OPEN_SIGNUP,
  CIRCLE_MEMBERSHIP_ENABLED: process.env.CIRCLE_MEMBERSHIP_ENABLED,
  RANDORI_LOCAL_RUNTIME: process.env.RANDORI_LOCAL_RUNTIME,
  TURSO_AUTH_TOKEN: process.env.TURSO_AUTH_TOKEN,
  TURSO_DATABASE_URL: process.env.TURSO_DATABASE_URL,
  VERCEL: process.env.VERCEL,
  VERCEL_ENV: process.env.VERCEL_ENV,
  VERCEL_URL: process.env.VERCEL_URL,
  AI_ENABLED: process.env.AI_ENABLED,
  ADMIN_EMAILS: process.env.ADMIN_EMAILS,
  CRON_SECRET: process.env.CRON_SECRET,
};

afterEach(() => {
  for (const [key, value] of Object.entries(originalEnvironment)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

function invoke(handler, { method = 'GET', url = '/', query = {}, headers = {}, body = {} } = {}) {
  return new Promise((resolve, reject) => {
    let statusCode = 200;
    let settled = false;
    const finish = (payload) => {
      if (!settled) {
        settled = true;
        resolve({ status: statusCode, headers: responseHeaders, body: payload });
      }
    };
    const responseHeaders = {};
    const response = {
      status(code) { statusCode = code; return this; },
      json(payload) { finish(payload); return this; },
      setHeader(name, value) { responseHeaders[name.toLowerCase()] = value; },
      getHeader(name) { return responseHeaders[name.toLowerCase()]; },
      writeHead(code, headersToSet = {}) {
        statusCode = code;
        for (const [name, value] of Object.entries(headersToSet)) {
          responseHeaders[name.toLowerCase()] = value;
        }
        return this;
      },
      end(payload) { finish(payload); },
    };
    Promise.resolve(handler({ method, url, query, headers, body, socket:{remoteAddress:'127.0.0.1'} }, response))
      .then(() => finish(undefined))
      .catch(reject);
  });
}

const sameOriginHeaders = {
  origin: 'https://randori.example.test',
  host: 'randori.example.test',
  'x-forwarded-proto': 'https',
};

test('production refuses to use a built-in JWT signing secret', () => {
  process.env.NODE_ENV = 'production';
  delete process.env.JWT_SECRET;
  assert.throws(() => getJwtSecret(), /JWT_SECRET/i);
});

test('signed request authentication accepts session cookies and Bearer tokens only with the pinned JWT contract', () => {
  process.env.JWT_SECRET = 'test-only-secret-that-is-long-enough-for-tests';
  const validToken = jwt.sign(
    { id: 42, email: 'person@example.test', jti:'A'.repeat(43) },
    process.env.JWT_SECRET,
    { algorithm: 'HS256', issuer: JWT_ISSUER, audience: JWT_AUDIENCE, expiresIn: '5m' },
  );

  assert.equal(verifySignedRequestAuth({ headers: { cookie: `randori_session=${validToken}` } })?.id, 42);
  assert.equal(verifySignedRequestAuth({ headers: { authorization: `Bearer ${validToken}` } })?.id, 42);

  const compatibleStringId = jwt.sign(
    { id: '42', email: 'legacy-client@example.test', jti:'B'.repeat(43) },
    process.env.JWT_SECRET,
    { algorithm: 'HS256', issuer: JWT_ISSUER, audience: JWT_AUDIENCE, expiresIn: '5m' },
  );
  assert.equal(verifySignedRequestAuth({ headers: { authorization: `Bearer ${compatibleStringId}` } })?.id, 42);

  const legacyTokenWithoutSessionId=jwt.sign(
    {id:42,email:'legacy@example.test'},
    process.env.JWT_SECRET,
    {algorithm:'HS256',issuer:JWT_ISSUER,audience:JWT_AUDIENCE,expiresIn:'5m'},
  );
  assert.equal(verifySignedRequestAuth({headers:{cookie:`randori_session=${legacyTokenWithoutSessionId}`}}),null);

  for(const invalidId of [true,[42],' 42 ','042','4.2',Number.MAX_SAFE_INTEGER+1]){
    const malformedToken=jwt.sign(
      {id:invalidId,jti:'C'.repeat(43)},
      process.env.JWT_SECRET,
      {algorithm:'HS256',issuer:JWT_ISSUER,audience:JWT_AUDIENCE,expiresIn:'5m'},
    );
    assert.equal(verifySignedRequestAuth({headers:{authorization:`Bearer ${malformedToken}`}}),null);
  }

  const wrongIssuer = jwt.sign(
    { id: 42,jti:'D'.repeat(43) },
    process.env.JWT_SECRET,
    { algorithm: 'HS256', issuer: 'another-app', audience: JWT_AUDIENCE, expiresIn: '5m' },
  );
  const wrongAudience = jwt.sign(
    { id: 42,jti:'E'.repeat(43) },
    process.env.JWT_SECRET,
    { algorithm: 'HS256', issuer: JWT_ISSUER, audience: 'another-client', expiresIn: '5m' },
  );
  assert.equal(verifySignedRequestAuth({ headers: { cookie: `randori_session=${wrongIssuer}` } }), null);
  assert.equal(verifySignedRequestAuth({ headers: { authorization: `Bearer ${wrongAudience}` } }), null);
});

test('cookie mutations require a same-origin request while explicit Bearer mutations remain supported', () => {
  const cookie = 'randori_session=session-value';
  assert.equal(verifyMutationOrigin({
    method: 'POST',
    headers: { cookie, origin: 'https://randori.example', host: 'randori.example' },
  }), true);
  assert.equal(verifyMutationOrigin({ method: 'POST', headers: { cookie, host: 'randori.example' } }), false);
  assert.equal(verifyMutationOrigin({
    method: 'POST',
    headers: { cookie, origin: 'https://attacker.example', host: 'randori.example' },
  }), false);
  assert.equal(verifyMutationOrigin({
    method: 'POST',
    headers: { authorization: 'Bearer api-client-token', origin: 'https://attacker.example' },
  }), true);
  assert.equal(verifyMutationOrigin({ method: 'GET', headers: { cookie } }), true);
  assert.equal(verifyMutationOrigin({ method: 'POST', headers: {} }), true);
});

test('database utility configuration and deterministic helpers have stable behavior', () => {
  delete process.env.CRON_SECRET;
  assert.throws(() => getCronSecret(), /CRON_SECRET/);
  process.env.CRON_SECRET = 'cron-test-secret';
  assert.equal(getCronSecret(), 'cron-test-secret');

  process.env.ADMIN_EMAILS = ' Admin@Example.test, second@example.test ';
  assert.deepEqual([...getAdminEmails()], ['admin@example.test', 'second@example.test']);
  assert.equal(isoWeekLabel(new Date('2026-09-17T12:00:00Z')), '2026-W38');
  assert.equal(deterministicColor('same-name'), deterministicColor('same-name'));
  assert.deepEqual([...shuffleArray([1])], [1]);
});

test('auth endpoints reject malformed or unauthenticated requests before database access', async () => {
  process.env.NODE_ENV='development';
  process.env.RANDORI_LOCAL_RUNTIME='true';
  process.env.ALLOW_OPEN_SIGNUP='true';
  process.env.CIRCLE_MEMBERSHIP_ENABLED='false';
  process.env.TURSO_DATABASE_URL='file:///tmp/randori-api-contracts.sqlite';
  process.env.APP_URL='http://127.0.0.1:3000';
  const signup = await invoke(authHandler, {
    method: 'POST',
    url: '/api/auth/signup',
    query: { endpoint: 'signup' },
    headers: {origin:'http://127.0.0.1:3000',host:'127.0.0.1:3000'},
    body: { email: 'person@example.com', password: 'short' },
  });
  assert.equal(signup.status, 400);

  const login = await invoke(authHandler, {
    method: 'POST',
    url: '/api/auth/login',
    query: { endpoint: 'login' },
    headers: sameOriginHeaders,
  });
  assert.equal(login.status, 400);

  const me = await invoke(authHandler, {
    method: 'GET',
    url: '/api/auth/me',
    query: { endpoint: 'me' },
  });
  assert.equal(me.status, 401);

  process.env.JWT_SECRET = 'test-only-secret-that-is-long-enough-for-tests';
  const invalidCookie = await invoke(authHandler, {
    method: 'GET',
    url: '/api/auth/me',
    query: { endpoint: 'me' },
    headers: { cookie: 'randori_session=not-a-valid-jwt' },
  });
  assert.equal(invalidCookie.status, 401);
});

test('logout clears the HttpOnly session cookie', async () => {
  const result = await invoke(authHandler, {
    method: 'POST',
    url: '/api/auth/logout',
    query: { endpoint: 'logout' },
    headers: sameOriginHeaders,
  });
  assert.equal(result.status, 200);
  const header = result.headers['set-cookie'];
  const cookies = Array.isArray(header) ? header : [String(header || '')];
  const sessionCookie = cookies.find(cookie => cookie.startsWith('randori_session=')) || '';
  assert.match(sessionCookie, /^randori_session=;/);
  assert.match(sessionCookie, /HttpOnly/i);
  assert.match(sessionCookie, /SameSite=Lax/i);
  assert.match(sessionCookie, /Max-Age=0/i);
});

test('AI analysis is disabled by default and requires authentication when enabled', async () => {
  delete process.env.AI_ENABLED;
  const disabled = await invoke(aiHandler, {
    method: 'POST',
    url: '/api/ai/analyze',
    query: { endpoint: 'analyze' },
    body: { transcript: 'test transcript' },
  });
  assert.equal(disabled.status, 503);

  process.env.AI_ENABLED = 'true';
  const anonymous = await invoke(aiHandler, {
    method: 'POST',
    url: '/api/ai/analyze',
    query: { endpoint: 'analyze' },
    body: { transcript: 'test transcript' },
  });
  assert.equal(anonymous.status, 401);
});

test('private data endpoints reject anonymous callers before database access', async () => {
  const cases = [
    ['circle', 'GET', {}],
    ['weeks', 'GET', {}],
    ['profile', 'GET', {}],
    ['history', 'GET', {}],
    ['my-pair', 'GET', {}],
    ['pair-recap', 'GET', {}],
    ['schedule', 'GET', {}],
    ['messages', 'GET', {}],
    ['questions', 'GET', {}],
    ['runs', 'POST', { code: 'return 1' }],
    ['execute', 'POST', { code: 'return 1' }],
    ['logs', 'POST', { level: 'info', message: 'test' }],
    ['init', 'POST', {}],
  ];
  for (const [endpoint, method, body] of cases) {
    const result = await invoke(dataHandler, {
      method,
      url: `/api/${endpoint}`,
      query: { endpoint },
      body,
    });
    assert.equal(result.status, 401, `${endpoint} should require authentication`);
  }
});

test('LeetCode detail and sync routes reject anonymous callers without network access', async () => {
  const detail = await invoke(dataHandler, {
    method: 'GET',
    url: '/api/leetcode/two-sum',
    query: { endpoint: 'leetcode', slug: 'two-sum' },
  });
  assert.equal(detail.status, 401);

  const sync = await invoke(dataHandler, {
    method: 'POST',
    url: '/api/leetcode/sync',
    query: { endpoint: 'leetcode-sync' },
    body: { slug: 'two-sum' },
  });
  assert.equal(sync.status, 401);
});

test('LeetCode synchronization keeps its explicit ingestion authorization gate', () => {
  const source = readFileSync(new URL('../../api/data.js', import.meta.url), 'utf8');
  const start = source.indexOf('async function handleLeetcodeSync');
  const end = source.indexOf('async function pistonVersions', start);
  assert.ok(start >= 0 && end > start, 'could not locate the LeetCode sync handler');

  const handlerSource = source.slice(start, end);
  const gate = handlerSource.search(
    /process\.env\.LEETCODE_INGESTION_AUTHORIZED\s*!==\s*['"]true['"]/,
  );
  const ingestion = handlerSource.indexOf('leetListSlugs(');
  assert.ok(gate >= 0, 'LeetCode sync must require LEETCODE_INGESTION_AUTHORIZED=true');
  assert.ok(ingestion >= 0 && gate < ingestion, 'the ingestion gate must run before external fetching');
  assert.match(handlerSource.slice(gate, ingestion), /status\(403\)/);
});

test('admin operations reject anonymous callers before database access', async () => {
  const reshuffle = await invoke(opsHandler, {
    method: 'POST',
    url: '/api/admin/reshuffle',
    query: { endpoint: 'reshuffle' },
  });
  assert.equal(reshuffle.status, 401);

  const pairingRun = await invoke(opsHandler, {
    method: 'POST',
    url: '/api/pairing/run',
    query: { endpoint: 'pairing-run' },
  });
  assert.equal(pairingRun.status, 401);

  const weekly = await invoke(opsHandler, {
    method: 'POST',
    url: '/api/cron/weekly',
    query: { endpoint: 'weekly' },
  });
  assert.equal(weekly.status, 401);
});

test('video signaling rejects anonymous callers before database access', async () => {
  const result = await invoke(videoHandler, {
    method: 'GET',
    url: '/api/video/signal?room_id=week_1_pair_1',
    query: { endpoint: 'signal', room_id: 'week_1_pair_1' },
  });
  assert.equal(result.status, 401);
});

test('Google OAuth start binds state to a secure, HTTP-only cookie', async () => {
  process.env.NODE_ENV = 'production';
  process.env.GOOGLE_CLIENT_ID = 'test-client';
  process.env.GOOGLE_CLIENT_SECRET = 'test-secret';
  process.env.APP_URL = 'https://preview.example.test';
  const result = await invoke(authHandler, {
    method: 'GET',
    url: '/api/auth/google/start',
    query: { endpoint: 'google-start' },
    headers:{host:'preview.example.test','x-forwarded-proto':'https'},
  });

  assert.equal(result.status, 302);
  const location = new URL(result.headers.location);
  const state = location.searchParams.get('state');
  const cookieHeader = result.headers['set-cookie'];
  const cookies = Array.isArray(cookieHeader) ? cookieHeader : [String(cookieHeader || '')];
  const stateCookie = cookies.find(cookie => cookie.startsWith('randori_oauth_state=')) || '';
  const verifierCookie = cookies.find(cookie => cookie.startsWith('randori_oauth_verifier=')) || '';
  assert.ok(state, 'OAuth redirect must include state');
  assert.match(stateCookie, new RegExp(`^randori_oauth_state=${state};`));
  assert.ok(verifierCookie, 'OAuth start must set a PKCE verifier cookie');
  for (const cookie of [stateCookie, verifierCookie]) {
    assert.match(cookie, /HttpOnly/i);
    assert.match(cookie, /Secure/i);
    assert.match(cookie, /SameSite=Lax/i);
  }
});
