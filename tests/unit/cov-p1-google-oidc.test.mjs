import assert from 'node:assert/strict';
import {afterEach,test} from 'node:test';

import {
  exchangeGoogleAuthorizationCode,
  fetchBoundedJson,
  GoogleOidcError,
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

const base={clientId:GOOGLE_TEST_CLIENT_ID,nonce:GOOGLE_TEST_NONCE,jwks:GOOGLE_TEST_JWKS};
const KEY=GOOGLE_TEST_JWKS.keys[0];

function code(expected){
  return error=>error instanceof GoogleOidcError&&error.code===expected;
}

function withHeader(token,header){
  const [,payload,signature]=token.split('.');
  return [Buffer.from(JSON.stringify(header)).toString('base64url'),payload,signature].join('.');
}

test('verification rejects malformed inputs before decoding',()=>{
  const token=googleTestIdToken();
  for(const [idToken,options] of [
    [42,base],
    ['',base],
    ['x'.repeat(16*1024+1),base],
    [token,{...base,clientId:''}],
    [token,{...base,clientId:7}],
    [token,{...base,nonce:''}],
    [token,{...base,nonce:'n'.repeat(129)}],
    [token,{...base,nonce:null}],
  ]){
    assert.throws(()=>verifyGoogleIdToken(idToken,options),code('identity_invalid'));
  }
  // Not a JWT at all: decode returns null.
  assert.throws(()=>verifyGoogleIdToken('not.a.jwt',base),code('identity_invalid'));
  assert.throws(()=>verifyGoogleIdToken('garbage',base),code('identity_invalid'));
});

test('JWKS shape and header algorithm/kid are enforced (no alg confusion)',()=>{
  const token=googleTestIdToken();
  for(const jwks of [null,[],{keys:'x'},{keys:Array(17).fill(KEY)}]){
    assert.throws(()=>verifyGoogleIdToken(token,{...base,jwks}),code('provider_response_invalid'));
  }
  for(const header of [
    {alg:'HS256',kid:KEY.kid},
    {alg:'none',kid:KEY.kid},
    {alg:'RS256'},
    {alg:'RS256',kid:''},
    {alg:'RS256',kid:'k'.repeat(129)},
  ]){
    assert.throws(()=>verifyGoogleIdToken(withHeader(token,header),base),code('identity_invalid'));
  }
});

test('signing keys must be well-formed RSA signature keys',()=>{
  const token=googleTestIdToken();
  const variants=[
    {...KEY,kty:'EC'},
    {...KEY,alg:'RS512'},
    {...KEY,n:'short'},
    {...KEY,n:'A'.repeat(2049)},
    {...KEY,e:''},
    {...KEY,e:7},
    // Structurally plausible but not a valid key: createPublicKey rejects it.
    {...KEY,n:'!'.repeat(400)},
  ];
  for(const key of variants){
    assert.throws(()=>verifyGoogleIdToken(token,{...base,jwks:{keys:[key]}}),code('identity_invalid'));
  }
  // Non-object entries are ignored when matching by kid.
  const ok=verifyGoogleIdToken(token,{...base,jwks:{keys:[null,'x',KEY]}});
  assert.equal(ok.subject,'google-test-subject');
  // Optional use/alg may be omitted.
  const {use:_use,alg:_alg,...bare}=KEY;
  assert.equal(verifyGoogleIdToken(token,{...base,jwks:{keys:[bare]}}).email,'member@example.test');
});

test('maxAuthAgeSeconds must be a bounded integer when reauth is requested',()=>{
  const now=Math.floor(Date.now()/1000);
  const token=googleTestIdToken({auth_time:now});
  for(const maxAuthAgeSeconds of [-1,601,1.5,'120']){
    assert.throws(()=>verifyGoogleIdToken(token,{...base,nowSeconds:now,maxAuthAgeSeconds}),code('identity_invalid'));
  }
  assert.equal(verifyGoogleIdToken(token,{...base,nowSeconds:now,maxAuthAgeSeconds:0}).authTime,now);
});

test('claims edge cases: missing nonce, non-string email, blank or control-character names',()=>{
  // An undefined claim is omitted from the signed token entirely.
  assert.throws(()=>verifyGoogleIdToken(googleTestIdToken({nonce:undefined}),base),code('identity_invalid'));
  assert.throws(()=>verifyGoogleIdToken(googleTestIdToken({email:['a@b.test']}),base),code('identity_invalid'));
  assert.throws(()=>verifyGoogleIdToken(googleTestIdToken({email:`${'a'.repeat(250)}@b.test`}),base),code('identity_invalid'));
  assert.throws(()=>verifyGoogleIdToken(googleTestIdToken({email:'   '}),base),code('identity_invalid'));
  assert.throws(()=>verifyGoogleIdToken(googleTestIdToken({sub:42}),base),code('identity_invalid'));
  assert.equal(verifyGoogleIdToken(googleTestIdToken({name:'   '}),base).name,null);
  assert.equal(verifyGoogleIdToken(googleTestIdToken({name:7}),base).name,null);
  assert.equal(verifyGoogleIdToken(googleTestIdToken({name:'A\u0000B\u007fC'.padEnd(40,'x')}),base).name,
    'ABC'.padEnd(32,'x'));
  // The issuer is normalized to the canonical HTTPS form.
  assert.equal(verifyGoogleIdToken(googleTestIdToken({iss:'accounts.google.com'}),base).issuer,
    'https://accounts.google.com');
});

test('bounded fetch handles empty bodies, streaming overflow, invalid JSON and reader errors',async()=>{
  globalThis.fetch=async()=>({ok:true,headers:new Headers(),body:null});
  await assert.rejects(fetchBoundedJson('https://p.test'),code('provider_response_invalid'));

  globalThis.fetch=async()=>new Response('{"ok":true}',{status:500});
  await assert.rejects(fetchBoundedJson('https://p.test'),code('provider_unavailable'));

  globalThis.fetch=async()=>{ throw new TypeError('network down'); };
  await assert.rejects(fetchBoundedJson('https://p.test'),code('provider_unavailable'));

  globalThis.fetch=async()=>new Response('{"a":1}',{status:200,headers:{'content-length':'abc'}});
  await assert.rejects(fetchBoundedJson('https://p.test'),code('provider_response_too_large'));

  // Undeclared length: the streamed body is counted and cut off.
  globalThis.fetch=async()=>new Response(new ReadableStream({
    start(controller){ controller.enqueue(new TextEncoder().encode('{"a":"')); controller.enqueue(new Uint8Array(64)); controller.close(); },
  }),{status:200});
  await assert.rejects(fetchBoundedJson('https://p.test',{}, {maxBytes:32}),code('provider_response_too_large'));

  globalThis.fetch=async()=>new Response('{not json',{status:200});
  await assert.rejects(fetchBoundedJson('https://p.test'),code('provider_response_invalid'));

  globalThis.fetch=async()=>new Response(new ReadableStream({
    pull(){ throw new Error('socket reset'); },
  }),{status:200});
  await assert.rejects(fetchBoundedJson('https://p.test'),code('provider_unavailable'));

  // Default limits apply when none are passed.
  globalThis.fetch=async()=>new Response('{"ok":1}',{status:200});
  assert.deepEqual(await fetchBoundedJson('https://p.test'),{ok:1});
});

test('code exchange rejects bad codes and token responses without an acceptable id_token',async()=>{
  const args={clientId:GOOGLE_TEST_CLIENT_ID,clientSecret:'s',redirectUri:'https://r.test/cb',
    codeVerifier:GOOGLE_TEST_VERIFIER,nonce:GOOGLE_TEST_NONCE};
  let calls=0;
  globalThis.fetch=async()=>{ calls+=1; return new Response('{}',{status:200}); };
  for(const extra of [{code:''},{code:'c'.repeat(4097)},{code:7},{code:'c',codeVerifier:'v'.repeat(129)},
    {code:'c',codeVerifier:null}]){
    await assert.rejects(exchangeGoogleAuthorizationCode({...args,...extra}),code('provider_response_invalid'));
  }
  assert.equal(calls,0);

  await assert.rejects(exchangeGoogleAuthorizationCode({...args,code:'c'}),code('identity_invalid'));
  globalThis.fetch=async()=>new Response(JSON.stringify({id_token:'x'.repeat(16*1024+1)}),{status:200});
  await assert.rejects(exchangeGoogleAuthorizationCode({...args,code:'c'}),code('identity_invalid'));
  assert.equal(calls,1);
});

test('public error mapping never leaks provider detail',()=>{
  assert.equal(publicGoogleAuthorizationError('server_error'),'provider_unavailable');
  assert.equal(publicGoogleAuthorizationError(undefined),'provider_denied');
  assert.equal(publicGoogleErrorCode(new GoogleOidcError('provider_unavailable')),'provider_unavailable');
  assert.equal(publicGoogleErrorCode(new GoogleOidcError('identity_invalid')),'identity_invalid');
  assert.equal(publicGoogleErrorCode(new GoogleOidcError('provider_response_invalid')),'identity_invalid');
});
