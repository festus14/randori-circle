import assert from 'node:assert/strict';
import test from 'node:test';

import {
  googleOAuthRequestConfiguration,
  resolveGoogleOAuthConfiguration,
  setAuthResponseHeaders,
} from '../../api/_auth-config.js';

function productionEnv(overrides={}){
  return {
    NODE_ENV:'production',
    APP_URL:'https://randori.example.test',
    GOOGLE_CLIENT_ID:'google-client',
    GOOGLE_CLIENT_SECRET:'google-secret',
    ...overrides,
  };
}

function productionRequest(overrides={}){
  return {
    headers:{
      host:'randori.example.test',
      'x-forwarded-proto':'https',
      ...overrides,
    },
  };
}

test('production Google OAuth configuration resolves one canonical origin',()=>{
  const configuration=resolveGoogleOAuthConfiguration(productionEnv());
  assert.deepEqual(configuration,{
    appOrigin:'https://randori.example.test',
    clientId:'google-client',
    clientSecret:'google-secret',
    redirectUri:'https://randori.example.test/api/auth/google/callback',
  });
  assert.deepEqual(googleOAuthRequestConfiguration(productionRequest(),productionEnv()),configuration);
});

test('Google OAuth configuration fails closed for incomplete and unsafe values',()=>{
  const invalid=[
    {APP_URL:undefined},
    {GOOGLE_CLIENT_ID:undefined},
    {GOOGLE_CLIENT_SECRET:undefined},
    {GOOGLE_CLIENT_ID:' google-client'},
    {GOOGLE_CLIENT_SECRET:'google-secret\n'},
    {APP_URL:'not a URL'},
    {APP_URL:'http://randori.example.test'},
    {APP_URL:'https://user:pass@randori.example.test'},
    {APP_URL:'https://randori.example.test/auth'},
    {APP_URL:'https://randori.example.test?next=elsewhere'},
    {APP_URL:'https://randori.example.test#fragment'},
    {APP_URL:'https://127.0.0.1:3000'},
    {RANDORI_LOCAL_RUNTIME:'true'},
    {VERCEL_ENV:'preview',APP_URL:'http://localhost:3000'},
  ];
  for(const overrides of invalid){
    assert.equal(resolveGoogleOAuthConfiguration(productionEnv(overrides)),null,JSON.stringify(overrides));
  }
});

test('development permits explicit loopback HTTP without enabling the isolated local runtime',()=>{
  const env=productionEnv({NODE_ENV:'development',APP_URL:'http://127.0.0.1:4173'});
  assert.ok(resolveGoogleOAuthConfiguration(env));
  assert.ok(googleOAuthRequestConfiguration({headers:{host:'127.0.0.1:4173'}},env));
  assert.equal(resolveGoogleOAuthConfiguration({...env,RANDORI_LOCAL_RUNTIME:'true'}),null);
  assert.equal(resolveGoogleOAuthConfiguration({...env,APP_URL:'http://dev.example.test'}),null);
});

test('OAuth requests must match the advertised host and secure proxy protocol',()=>{
  const env=productionEnv();
  for(const request of [
    {headers:{}},
    productionRequest({host:'preview.example.test'}),
    productionRequest({'x-forwarded-host':'preview.example.test'}),
    productionRequest({'x-forwarded-proto':'http'}),
    productionRequest({'x-forwarded-proto':''}),
  ]){
    assert.equal(googleOAuthRequestConfiguration(request,env),null);
  }
  assert.ok(googleOAuthRequestConfiguration({
    headers:{host:'ignored.example.test','x-forwarded-host':'randori.example.test','x-forwarded-proto':'https, http'},
  },env));
});

test('auth response headers prevent caching, sniffing, and callback referrer leakage',()=>{
  const headers={};
  setAuthResponseHeaders({setHeader(name,value){ headers[String(name).toLowerCase()]=value; }});
  assert.deepEqual(headers,{
    'cache-control':'no-store',
    pragma:'no-cache',
    'x-content-type-options':'nosniff',
    'referrer-policy':'no-referrer',
  });
});
