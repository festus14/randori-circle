import assert from 'node:assert/strict';
import {afterEach,test} from 'node:test';
import {
  GoogleOidcError,
  exchangeGoogleAuthorizationCode,
  fetchBoundedJson,
  publicGoogleAuthorizationError,
  publicGoogleErrorCode,
  verifyGoogleIdToken,
} from '../../api/_google-oidc.js';
import {
  GOOGLE_TEST_CLIENT_ID,
  GOOGLE_TEST_JWKS,
  GOOGLE_TEST_NONCE,
  GOOGLE_TEST_VERIFIER,
  googleTestIdToken,
} from '../support/google-oidc.mjs';

const originalFetch=globalThis.fetch;
afterEach(()=>{ globalThis.fetch=originalFetch; });

function verify(overrides={},options={}){
  return verifyGoogleIdToken(googleTestIdToken(overrides),{
    clientId:GOOGLE_TEST_CLIENT_ID,
    nonce:GOOGLE_TEST_NONCE,
    jwks:GOOGLE_TEST_JWKS,
    ...options,
  });
}

test('strict Google ID token validation returns a fixed issuer and normalized identity',()=>{
  const identity=verify({email:'  MEMBER@Example.Test ',name:'  Member Name  '});
  assert.deepEqual(identity,{
    issuer:'https://accounts.google.com',
    subject:'google-test-subject',
    email:'member@example.test',
    name:'Member Name',
  });
});

test('ID token validation rejects issuer, audience, expiry, subject, verification, and nonce failures',()=>{
  const now=Math.floor(Date.now()/1000);
  for(const [name,claims,options] of [
    ['issuer',{iss:'https://evil.example'},{}],
    ['audience',{aud:'other-client'},{}],
    ['audience array',{aud:[GOOGLE_TEST_CLIENT_ID]},{}],
    ['authorized party',{azp:'other-client'},{}],
    ['expiry',{iat:now-4000,exp:now-1},{nowSeconds:now}],
    ['lifetime',{iat:now-100,exp:now+4000},{nowSeconds:now}],
    ['future issued-at',{iat:now+61,exp:now+3600},{nowSeconds:now}],
    ['subject',{sub:''},{}],
    ['subject characters',{sub:'subject with spaces'},{}],
    ['unverified',{email_verified:false},{}],
    ['email',{email:'not-an-email'},{}],
    ['nonce',{nonce:'different'},{}],
  ]){
    assert.throws(()=>verify(claims,options),error=>error instanceof GoogleOidcError&&error.code==='identity_invalid',name);
  }
});

test('ID token validation rejects unknown, ambiguous, and non-signing keys',()=>{
  const token=googleTestIdToken();
  for(const jwks of [
    {keys:[]},
    {keys:[...GOOGLE_TEST_JWKS.keys,...GOOGLE_TEST_JWKS.keys]},
    {keys:[{...GOOGLE_TEST_JWKS.keys[0],use:'enc'}]},
  ]){
    assert.throws(()=>verifyGoogleIdToken(token,{clientId:GOOGLE_TEST_CLIENT_ID,nonce:GOOGLE_TEST_NONCE,jwks}),GoogleOidcError);
  }
});

test('provider JSON reads are bounded, parsed as objects, and time limited',async()=>{
  globalThis.fetch=async()=>new Response('{"ok":true}',{status:200});
  assert.deepEqual(await fetchBoundedJson('https://provider.test',{}, {maxBytes:32,timeoutMs:100}),{ok:true});

  globalThis.fetch=async()=>new Response('x'.repeat(33),{status:200,headers:{'content-length':'33'}});
  await assert.rejects(fetchBoundedJson('https://provider.test',{}, {maxBytes:32,timeoutMs:100}),error=>error.code==='provider_response_too_large');

  globalThis.fetch=async()=>new Response('[]',{status:200});
  await assert.rejects(fetchBoundedJson('https://provider.test',{}, {maxBytes:32,timeoutMs:100}),error=>error.code==='provider_response_invalid');

  globalThis.fetch=async(_url,{signal})=>new Promise((_resolve,reject)=>{
    signal.addEventListener('abort',()=>reject(new DOMException('aborted','AbortError')),{once:true});
  });
  await assert.rejects(fetchBoundedJson('https://provider.test',{}, {maxBytes:32,timeoutMs:5}),error=>error.code==='provider_unavailable');

  globalThis.fetch=async()=>new Response(new ReadableStream({start(){}}),{status:200});
  await assert.rejects(fetchBoundedJson('https://provider.test',{}, {maxBytes:32,timeoutMs:5}),error=>error.code==='provider_unavailable');
});

test('authorization-code exchange sends the exact PKCE verifier and validates the returned identity',async()=>{
  const requests=[];
  const token=googleTestIdToken({email:'oidc@example.test',sub:'oidc-subject'});
  globalThis.fetch=async(url,options={})=>{
    requests.push({url:String(url),options});
    if(String(url).endsWith('/token')) return new Response(JSON.stringify({id_token:token}),{status:200});
    return new Response(JSON.stringify(GOOGLE_TEST_JWKS),{status:200});
  };
  const identity=await exchangeGoogleAuthorizationCode({
    clientId:GOOGLE_TEST_CLIENT_ID,
    clientSecret:'test-client-secret',
    redirectUri:'https://randori.example.test/api/auth/google/callback',
    code:'single-use-code',
    codeVerifier:GOOGLE_TEST_VERIFIER,
    nonce:GOOGLE_TEST_NONCE,
  });
  assert.equal(identity.subject,'oidc-subject');
  assert.equal(requests.length,2);
  const tokenBody=new URLSearchParams(String(requests[0].options.body));
  assert.equal(tokenBody.get('code_verifier'),GOOGLE_TEST_VERIFIER);
  assert.equal(tokenBody.get('code'),'single-use-code');
  assert.equal(requests[1].url,'https://www.googleapis.com/oauth2/v3/certs');

  await assert.rejects(exchangeGoogleAuthorizationCode({
    clientId:GOOGLE_TEST_CLIENT_ID,clientSecret:'secret',redirectUri:'https://randori.example.test/callback',
    code:'code',codeVerifier:'too-short',nonce:GOOGLE_TEST_NONCE,
  }),error=>error.code==='provider_response_invalid');
});

test('only stable public provider errors leave the callback boundary',()=>{
  assert.equal(publicGoogleAuthorizationError('access_denied'),'access_denied');
  assert.equal(publicGoogleAuthorizationError('temporarily_unavailable'),'provider_unavailable');
  assert.equal(publicGoogleAuthorizationError('raw secret from provider'),'provider_denied');
  assert.equal(publicGoogleErrorCode(new GoogleOidcError('provider_response_too_large')),'provider_response_invalid');
  assert.equal(publicGoogleErrorCode(new Error('raw provider payload')),'provider_unavailable');
});
