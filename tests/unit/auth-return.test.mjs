import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import { afterEach, mock, test } from 'node:test';
import {
  GOOGLE_TEST_NONCE,
  GOOGLE_TEST_VERIFIER,
  googleOAuthCookieHeader,
  googleProviderFetch,
} from '../support/google-oidc.mjs';

const database = {
  async execute(statement) {
    const sql = typeof statement === 'string' ? statement : String(statement?.sql || '');
    if (sql.includes('SELECT registrations_closed FROM circle_membership_rollout')) {
      return { rows: [{ registrations_closed: 0 }] };
    }
    if (sql.includes('SELECT id, email, is_admin, password_hash, google_sub')) return { rows: [] };
    if (sql.includes('INSERT INTO auth_accounts') && sql.includes('RETURNING id')) return { rows: [{ id: 41 }] };
    if (sql.includes('INSERT INTO auth_provider_identities') && sql.includes('RETURNING user_id')) {
      return { rows: [{ user_id: Number(statement.args[2]) }] };
    }
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

function oauthCookies({ state = 'expected-state', verifier = GOOGLE_TEST_VERIFIER, nonce=GOOGLE_TEST_NONCE, returnPath = '/' } = {}) {
  return googleOAuthCookieHeader({state,verifier,nonce,returnPath});
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
  const nonceCookie = cookiesFrom(safe).find(cookie => cookie.startsWith('randori_oauth_nonce='));
  const authorizationUrl=new URL(safe.headers.location);
  const nonce=authorizationUrl.searchParams.get('nonce');
  const verifierCookie=cookiesFrom(safe).find(cookie => cookie.startsWith('randori_oauth_verifier='));
  const verifier=decodeURIComponent(verifierCookie.split(';')[0].split('=')[1]);
  assert.equal(nonce,decodeURIComponent(nonceCookie.split(';')[0].split('=')[1]));
  assert.equal(authorizationUrl.searchParams.get('code_challenge'),createHash('sha256').update(verifier).digest('base64url'));
  assert.equal(authorizationUrl.searchParams.get('code_challenge_method'),'S256');
  assert.match(nonceCookie, /^randori_oauth_nonce=[A-Za-z0-9_-]+;/);
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

  const rawProviderError = await invoke({
    url: '/api/auth/google/callback',
    query: { endpoint: 'callback', error: 'secret-provider-diagnostic', state: 'expected-state' },
    headers: oauthRequestHeaders(oauthCookies()),
  });
  assert.equal(rawProviderError.headers.location, 'https://randori.example.test/?google_error=provider_denied');
  assert.doesNotMatch(rawProviderError.headers.location,/secret-provider-diagnostic/);
});

test('OAuth callback requires its nonce and a consumed browser callback cannot be replayed',async()=>{
  enableGoogleOAuth();
  process.env.SIGNUP_ALLOWLIST='pair@example.test';
  let providerRequests=0;
  const successfulProvider=googleProviderFetch({
    claims:{email:'pair@example.test',name:'Pair User',sub:'google-pair-1'},
    onRequest:()=>{ providerRequests+=1; },
  });
  let tokenExchanges=0;
  globalThis.fetch=async(url,options)=>{
    if(String(url).endsWith('/token')){
      tokenExchanges+=1;
      if(tokenExchanges>1){
        providerRequests+=1;
        return new Response(JSON.stringify({error:'invalid_grant'}),{status:400});
      }
    }
    return successfulProvider(url,options);
  };

  const missingNonce=await invoke({
    url:'/api/auth/google/callback',
    query:{endpoint:'callback',code:'valid-code',state:'expected-state'},
    headers:oauthRequestHeaders(oauthCookies({nonce:''})),
  });
  assert.equal(missingNonce.headers.location,'https://randori.example.test/?google_error=invalid_state');
  assert.equal(providerRequests,0);

  const first=await invoke({
    url:'/api/auth/google/callback',
    query:{endpoint:'callback',code:'one-time-code',state:'expected-state'},
    headers:oauthRequestHeaders(oauthCookies()),
  });
  assert.equal(first.headers.location,'https://randori.example.test/?google=success');
  assert.equal(providerRequests,2);
  assert.match(String(first.headers['set-cookie']),/randori_oauth_nonce=;/);

  const copiedCookieReplay=await invoke({
    url:'/api/auth/google/callback',
    query:{endpoint:'callback',code:'one-time-code',state:'expected-state'},
    headers:oauthRequestHeaders(oauthCookies()),
  });
  assert.equal(copiedCookieReplay.headers.location,'https://randori.example.test/?google_error=provider_unavailable');
  assert.doesNotMatch(String(copiedCookieReplay.headers['set-cookie']),/randori_session=[^;]/);
  assert.equal(providerRequests,3,'Google must see the copied authorization code exactly once more and reject it');

  const consumedCookieReplay=await invoke({
    url:'/api/auth/google/callback',
    query:{endpoint:'callback',code:'one-time-code',state:'expected-state'},
    headers:oauthRequestHeaders(),
  });
  assert.equal(consumedCookieReplay.headers.location,'https://randori.example.test/?google_error=invalid_state');
  assert.equal(providerRequests,3,'a replay without consumed transient cookies must not reach Google');
  assert.doesNotMatch(String(consumedCookieReplay.headers['set-cookie']),/randori_session=[^;]/);
});

test('OAuth callback binds the signed ID token nonce and emits only a safe error',async()=>{
  enableGoogleOAuth();
  globalThis.fetch=googleProviderFetch({claims:{nonce:'attacker-nonce'}});
  const result=await invoke({
    url:'/api/auth/google/callback',
    query:{endpoint:'callback',code:'valid-code',state:'expected-state'},
    headers:oauthRequestHeaders(oauthCookies()),
  });
  assert.equal(result.headers.location,'https://randori.example.test/?google_error=identity_invalid');
  assert.doesNotMatch(String(result.headers['set-cookie']),/randori_session=[^;]/);
});

test('successful OAuth callback returns to the stored room and never a callback override', async () => {
  enableGoogleOAuth();
  process.env.SIGNUP_ALLOWLIST='pair@example.test';
  globalThis.fetch = googleProviderFetch({claims:{
    email:'pair@example.test',name:'Pair User',sub:'google-pair-1',
  }});

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
