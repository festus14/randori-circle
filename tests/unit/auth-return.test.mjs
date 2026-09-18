import assert from 'node:assert/strict';
import { afterEach, mock, test } from 'node:test';

const database = {
  async execute(statement) {
    const sql = typeof statement === 'string' ? statement : String(statement?.sql || '');
    if (sql.includes('SELECT registrations_closed FROM circle_membership_rollout')) {
      return { rows: [{ registrations_closed: 0 }] };
    }
    if (sql.includes('SELECT id, is_admin, password_hash, google_sub')) return { rows: [] };
    if (sql.includes('INSERT INTO auth_accounts') && sql.includes('RETURNING id')) return { rows: [{ id: 41 }] };
    if (sql.includes('SELECT id FROM users')) return { rows: [] };
    return { rows: [], rowsAffected: 0 };
  },
  async batch(statements) {
    const results=[];
    for(const statement of statements) results.push(await this.execute(statement));
    return results;
  },
};

mock.module('../../api/_db.js', {
  exports: {
    JWT_AUDIENCE: 'randori-web',
    JWT_ISSUER: 'randori-circle',
    getClient: () => database,
    getJwtSecret: () => 'unit-test-secret-at-least-thirty-two-characters',
    deterministicColor: () => '#123456',
    getAdminEmails: () => new Set(),
    verifyMutationOrigin: () => true,
    verifyRequestAuth: () => null,
  },
});

const { default: authHandler } = await import('../../api/auth.js');
const { parseCanonicalRoomPath } = await import('../../api/_pairing.js');
const originalFetch = globalThis.fetch;

function invoke({ url, query, headers = {} }) {
  return new Promise((resolve, reject) => {
    let status = 200;
    let settled = false;
    const responseHeaders = {};
    const finish = body => {
      if (settled) return;
      settled = true;
      resolve({ status, headers: responseHeaders, body });
    };
    const response = {
      status(code) { status = code; return this; },
      json(body) { finish(body); return this; },
      setHeader(name, value) { responseHeaders[String(name).toLowerCase()] = value; },
      getHeader(name) { return responseHeaders[String(name).toLowerCase()]; },
      writeHead(code, values = {}) {
        status = code;
        for (const [name, value] of Object.entries(values)) {
          responseHeaders[name.toLowerCase()] = value;
        }
        return this;
      },
      end(body) { finish(body); },
    };
    const request = { method: 'GET', url, query, headers };
    Promise.resolve(authHandler(request, response)).then(() => finish()).catch(reject);
  });
}

function cookiesFrom(response) {
  const value = response.headers['set-cookie'];
  return Array.isArray(value) ? value : [String(value || '')];
}

function oauthCookies({ state = 'expected-state', verifier = 'verifier', returnPath = '/' } = {}) {
  return [
    `randori_oauth_state=${encodeURIComponent(state)}`,
    `randori_oauth_verifier=${encodeURIComponent(verifier)}`,
    `randori_oauth_return=${encodeURIComponent(returnPath)}`,
  ].join('; ');
}

function enableGoogleOAuth(){
  process.env.NODE_ENV='production';
  process.env.APP_URL='https://randori.example.test';
  process.env.GOOGLE_CLIENT_ID='client';
  process.env.GOOGLE_CLIENT_SECRET='secret';
}

function oauthRequestHeaders(cookie){
  return {
    host:'randori.example.test',
    'x-forwarded-proto':'https',
    ...(cookie?{cookie}:{}),
  };
}

afterEach(() => {
  globalThis.fetch = originalFetch;
  for (const key of ['APP_URL', 'CIRCLE_MEMBERSHIP_ENABLED', 'GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'NODE_ENV', 'SIGNUP_ALLOWLIST']) {
    delete process.env[key];
  }
});

test('canonical pair-room parser accepts only exact positive safe-integer paths', () => {
  assert.deepEqual(parseCanonicalRoomPath('/join/week_12_pair_34'), {
    path: '/join/week_12_pair_34',
    roomId: 'week_12_pair_34',
    weekId: 12,
    pairGroupId: 34,
  });

  for (const unsafe of [
    '', '/', '//evil.example', 'https://evil.example/join/week_1_pair_2',
    '%2Fjoin%2Fweek_1_pair_2', '/join%2Fweek_1_pair_2', '\\join\\week_1_pair_2',
    '/join/week_0_pair_2', '/join/week_1_pair_0', '/join/week_01_pair_2',
    '/join/week_1_pair_02', '/join/week_-1_pair_2', '/join/week_1.5_pair_2',
    '/join/week_1_pair_2/', '/join/week_1_pair_2?next=//evil.example',
    '/join/week_1_pair_2#fragment', '/join/week_9007199254740992_pair_2',
    ' /join/week_1_pair_2', null, undefined, { path: '/join/week_1_pair_2' },
  ]) {
    assert.equal(parseCanonicalRoomPath(unsafe), null, String(unsafe));
  }
});

test('Google OAuth start stores only a validated canonical return path', async () => {
  enableGoogleOAuth();

  const safe = await invoke({
    url: '/api/auth/google/start?return_to=%2Fjoin%2Fweek_12_pair_34',
    query: { endpoint: 'google-start', return_to: '/join/week_12_pair_34' },
    headers: oauthRequestHeaders(),
  });
  const returnCookie = cookiesFrom(safe).find(cookie => cookie.startsWith('randori_oauth_return='));
  assert.match(returnCookie, /^randori_oauth_return=%2Fjoin%2Fweek_12_pair_34;/);
  assert.match(returnCookie, /Path=\/api\/auth\/google/);
  assert.match(returnCookie, /HttpOnly/);
  assert.match(returnCookie, /SameSite=Lax/);
  assert.match(returnCookie, /Max-Age=600/);
  assert.match(returnCookie, /Secure/);

  for (const returnTo of [
    'https://evil.example', '//evil.example', '%2Fjoin%2Fweek_12_pair_34',
    '/join/week_12_pair_34?next=https://evil.example', '/join\\week_12_pair_34',
    '/join/week_0_pair_34', '/join/week_12_pair_034',
  ]) {
    const rejected = await invoke({
      url: '/api/auth/google/start',
      query: { endpoint: 'google-start', return_to: returnTo },
      headers: oauthRequestHeaders(),
    });
    const cookie = cookiesFrom(rejected).find(item => item.startsWith('randori_oauth_return='));
    assert.match(cookie, /^randori_oauth_return=%2F;/, returnTo);
  }
});

test('OAuth callback ignores a callback return override and consumes the stored path', async () => {
  enableGoogleOAuth();
  const result = await invoke({
    url: '/api/auth/google/callback',
    query: {
      endpoint: 'callback',
      error: 'access_denied',
      state: 'expected-state',
      return_to: 'https://evil.example/steal',
    },
    headers: oauthRequestHeaders(oauthCookies({ returnPath: '/join/week_12_pair_34' })),
  });

  assert.equal(result.status, 302);
  assert.equal(result.headers.location, 'https://randori.example.test/join/week_12_pair_34?google_error=access_denied');
  assert.doesNotMatch(result.headers.location, /evil\.example/);
  const cleared = cookiesFrom(result).find(cookie => cookie.startsWith('randori_oauth_return='));
  assert.match(cleared, /^randori_oauth_return=;/);
  assert.match(cleared, /Path=\/api\/auth\/google/);
  assert.match(cleared, /Max-Age=0/);
});

test('OAuth callback validates state before provider errors and revalidates its return cookie', async () => {
  enableGoogleOAuth();
  const wrongState = await invoke({
    url: '/api/auth/google/callback',
    query: { endpoint: 'callback', error: 'access_denied', state: 'wrong-state' },
    headers: oauthRequestHeaders(oauthCookies({ returnPath: '/join/week_12_pair_34' })),
  });
  assert.equal(wrongState.headers.location, 'https://randori.example.test/join/week_12_pair_34?google_error=invalid_state');

  const tamperedReturn = await invoke({
    url: '/api/auth/google/callback',
    query: { endpoint: 'callback', error: 'access_denied', state: 'expected-state' },
    headers: oauthRequestHeaders(oauthCookies({ returnPath: '//evil.example' })),
  });
  assert.equal(tamperedReturn.headers.location, 'https://randori.example.test/?google_error=access_denied');
});

test('successful OAuth callback returns to the stored room and never a callback override', async () => {
  enableGoogleOAuth();
  process.env.SIGNUP_ALLOWLIST='pair@example.test';
  globalThis.fetch = async url => {
    if (String(url).includes('/token')) {
      return new Response(JSON.stringify({ access_token: 'google-access' }), { status: 200 });
    }
    return new Response(JSON.stringify({
      email: 'pair@example.test',
      name: 'Pair User',
      sub: 'google-pair-1',
      email_verified: true,
    }), { status: 200 });
  };

  const result = await invoke({
    url: '/api/auth/google/callback',
    query: {
      endpoint: 'callback',
      code: 'valid-code',
      state: 'expected-state',
      return_to: '//evil.example',
    },
    headers: oauthRequestHeaders(oauthCookies({ returnPath: '/join/week_12_pair_34' })),
  });

  assert.equal(result.status, 302);
  assert.equal(result.headers.location, 'https://randori.example.test/join/week_12_pair_34?google=success');
  assert.match(String(result.headers['set-cookie']), /randori_session=/);
  assert.doesNotMatch(result.headers.location, /evil\.example/);
});
