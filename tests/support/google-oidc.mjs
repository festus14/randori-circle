import {generateKeyPairSync} from 'node:crypto';
import jwt from 'jsonwebtoken';

export const GOOGLE_TEST_CLIENT_ID='client';
export const GOOGLE_TEST_NONCE='test-nonce-value';
export const GOOGLE_TEST_VERIFIER='v'.repeat(64);
export const GOOGLE_TEST_KEY_ID='randori-google-test-key';

const {privateKey,publicKey}=generateKeyPairSync('rsa',{modulusLength:2048});
const publicJwk=publicKey.export({format:'jwk'});
export const GOOGLE_TEST_JWKS=Object.freeze({
  keys:[Object.freeze({...publicJwk,kid:GOOGLE_TEST_KEY_ID,use:'sig',alg:'RS256'})],
});

export function googleTestIdToken(overrides={}){
  const now=Math.floor(Date.now()/1000);
  const claims={
    iss:'https://accounts.google.com',
    aud:GOOGLE_TEST_CLIENT_ID,
    sub:'google-test-subject',
    email:'member@example.test',
    email_verified:true,
    name:'Test Member',
    nonce:GOOGLE_TEST_NONCE,
    iat:now,
    exp:now+3600,
    ...overrides,
  };
  return jwt.sign(claims,privateKey,{algorithm:'RS256',keyid:GOOGLE_TEST_KEY_ID});
}

export function googleProviderFetch({claims={},tokenStatus=200,jwks=GOOGLE_TEST_JWKS,onRequest}={}){
  const idToken=googleTestIdToken(claims);
  return async (url,options={})=>{
    const href=String(url);
    onRequest?.(href,options);
    if(href==='https://oauth2.googleapis.com/token'){
      return new Response(JSON.stringify(tokenStatus===200?{id_token:idToken}:{error:'invalid_grant'}),{status:tokenStatus});
    }
    if(href==='https://www.googleapis.com/oauth2/v3/certs'){
      return new Response(JSON.stringify(jwks),{status:200});
    }
    throw new Error('unexpected provider request');
  };
}

export function googleOAuthCookieHeader({
  state='expected-state',
  verifier=GOOGLE_TEST_VERIFIER,
  nonce=GOOGLE_TEST_NONCE,
  returnPath,
  invitationClaim,
}={}){
  const values=[
    `randori_oauth_state=${encodeURIComponent(state)}`,
    `randori_oauth_verifier=${encodeURIComponent(verifier)}`,
    `randori_oauth_nonce=${encodeURIComponent(nonce)}`,
  ];
  if(returnPath!==undefined) values.push(`randori_oauth_return=${encodeURIComponent(returnPath)}`);
  if(invitationClaim!==undefined) values.push(`randori_invite_claim=${encodeURIComponent(invitationClaim)}`);
  return values.join('; ');
}
