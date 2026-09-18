import { createPublicKey, timingSafeEqual } from 'node:crypto';
import jwt from 'jsonwebtoken';

export const GOOGLE_AUTHORIZATION_ENDPOINT='https://accounts.google.com/o/oauth2/v2/auth';
export const GOOGLE_TOKEN_ENDPOINT='https://oauth2.googleapis.com/token';
export const GOOGLE_JWKS_ENDPOINT='https://www.googleapis.com/oauth2/v3/certs';
export const GOOGLE_IDENTITY_ISSUER='https://accounts.google.com';

const GOOGLE_ISSUERS=Object.freeze([GOOGLE_IDENTITY_ISSUER,'accounts.google.com']);
const PROVIDER_TIMEOUT_MS=8_000;
const TOKEN_RESPONSE_MAX_BYTES=32*1024;
const JWKS_RESPONSE_MAX_BYTES=256*1024;
const ID_TOKEN_MAX_BYTES=16*1024;
const MAX_TOKEN_LIFETIME_SECONDS=65*60;
const MAX_CLOCK_SKEW_SECONDS=60;

export class GoogleOidcError extends Error{
  constructor(code){
    super(code);
    this.name='GoogleOidcError';
    this.code=code;
  }
}

function fail(code){ throw new GoogleOidcError(code); }

function safeEqual(left,right){
  const a=Buffer.from(String(left||''),'utf8');
  const b=Buffer.from(String(right||''),'utf8');
  return a.length===b.length&&timingSafeEqual(a,b);
}

function singleJsonObject(value){
  return value!==null&&typeof value==='object'&&!Array.isArray(value);
}

function abortable(promise,signal){
  if(signal.aborted) return Promise.reject(new GoogleOidcError('provider_unavailable'));
  return new Promise((resolve,reject)=>{
    const aborted=()=>reject(new GoogleOidcError('provider_unavailable'));
    signal.addEventListener('abort',aborted,{once:true});
    Promise.resolve(promise).then(resolve,reject).finally(()=>signal.removeEventListener('abort',aborted));
  });
}

async function readBoundedBody(response,maxBytes,controller){
  const declared=String(response.headers?.get?.('content-length')||'').trim();
  if(declared&&(/^\d+$/.test(declared)===false||Number(declared)>maxBytes)){
    controller.abort();
    fail('provider_response_too_large');
  }
  if(!response.body) return Buffer.alloc(0);
  const reader=response.body.getReader();
  const chunks=[];
  let length=0;
  try{
    while(true){
      const {done,value}=await abortable(reader.read(),controller.signal);
      if(done) break;
      length+=value.byteLength;
      if(length>maxBytes){
        controller.abort();
        fail('provider_response_too_large');
      }
      chunks.push(Buffer.from(value));
    }
  }finally{
    try{ reader.releaseLock(); }catch{}
  }
  return Buffer.concat(chunks,length);
}

export async function fetchBoundedJson(url,options={},limits={}){
  const timeoutMs=limits.timeoutMs??PROVIDER_TIMEOUT_MS;
  const maxBytes=limits.maxBytes??TOKEN_RESPONSE_MAX_BYTES;
  const controller=new AbortController();
  const timer=setTimeout(()=>controller.abort(),timeoutMs);
  try{
    let response;
    try{ response=await abortable(fetch(url,{...options,signal:controller.signal}),controller.signal); }
    catch{ fail('provider_unavailable'); }
    if(!response?.ok){
      controller.abort();
      fail('provider_unavailable');
    }
    let bytes;
    try{ bytes=await readBoundedBody(response,maxBytes,controller); }
    catch(error){
      if(error instanceof GoogleOidcError) throw error;
      fail('provider_unavailable');
    }
    let value;
    try{ value=JSON.parse(bytes.toString('utf8')); }
    catch{ fail('provider_response_invalid'); }
    if(!singleJsonObject(value)) fail('provider_response_invalid');
    return value;
  }finally{
    clearTimeout(timer);
  }
}

function normalizeEmail(value){
  if(typeof value!=='string') return null;
  const email=value.trim().toLowerCase();
  if(!email||Buffer.byteLength(email,'utf8')>254||!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return null;
  return email;
}

function signingKey(jwks,header){
  if(!singleJsonObject(jwks)||!Array.isArray(jwks.keys)||jwks.keys.length<1||jwks.keys.length>16){
    fail('provider_response_invalid');
  }
  if(!singleJsonObject(header)||header.alg!=='RS256'||typeof header.kid!=='string'||header.kid.length<1||header.kid.length>128){
    fail('identity_invalid');
  }
  const matches=jwks.keys.filter(key=>singleJsonObject(key)&&key.kid===header.kid);
  if(matches.length!==1) fail('identity_invalid');
  const key=matches[0];
  if(key.kty!=='RSA'||(key.use!==undefined&&key.use!=='sig')||(key.alg!==undefined&&key.alg!=='RS256')
    ||typeof key.n!=='string'||key.n.length<342||key.n.length>2048
    ||typeof key.e!=='string'||key.e.length<1||key.e.length>16){
    fail('identity_invalid');
  }
  try{ return createPublicKey({key,format:'jwk'}); }
  catch{ fail('identity_invalid'); }
}

export function verifyGoogleIdToken(idToken,{clientId,nonce,jwks,nowSeconds=Math.floor(Date.now()/1000)}){
  if(typeof idToken!=='string'||idToken.length<1||Buffer.byteLength(idToken,'utf8')>ID_TOKEN_MAX_BYTES
    ||typeof clientId!=='string'||!clientId||typeof nonce!=='string'||nonce.length<1||nonce.length>128){
    fail('identity_invalid');
  }
  let decoded;
  try{ decoded=jwt.decode(idToken,{complete:true}); }
  catch{ fail('identity_invalid'); }
  if(!singleJsonObject(decoded)||!singleJsonObject(decoded.header)) fail('identity_invalid');
  const key=signingKey(jwks,decoded.header);
  let claims;
  try{
    claims=jwt.verify(idToken,key,{
      algorithms:['RS256'],
      issuer:GOOGLE_ISSUERS,
      audience:clientId,
      clockTimestamp:nowSeconds,
    });
  }catch{ fail('identity_invalid'); }
  if(!singleJsonObject(claims)||!GOOGLE_ISSUERS.includes(claims.iss)||claims.aud!==clientId
    ||(claims.azp!==undefined&&claims.azp!==clientId)
    ||!Number.isSafeInteger(claims.iat)||!Number.isSafeInteger(claims.exp)
    ||claims.iat>nowSeconds+MAX_CLOCK_SKEW_SECONDS||claims.exp<=nowSeconds
    ||claims.exp<=claims.iat||claims.exp-claims.iat>MAX_TOKEN_LIFETIME_SECONDS
    ||!safeEqual(claims.nonce,nonce)||claims.email_verified!==true){
    fail('identity_invalid');
  }
  const subject=typeof claims.sub==='string'&&/^[A-Za-z0-9_-]{1,255}$/.test(claims.sub)
    ?claims.sub:null;
  const email=normalizeEmail(claims.email);
  if(!subject||!email) fail('identity_invalid');
  const name=typeof claims.name==='string'&&claims.name.trim()
    ?claims.name.trim().replace(/[\u0000-\u001f\u007f]/g,'').slice(0,32)
    :null;
  return {issuer:GOOGLE_IDENTITY_ISSUER,subject,email,name};
}

export async function exchangeGoogleAuthorizationCode({clientId,clientSecret,redirectUri,code,codeVerifier,nonce}){
  if(typeof code!=='string'||code.length<1||code.length>4096||typeof codeVerifier!=='string'||codeVerifier.length<43||codeVerifier.length>128){
    fail('provider_response_invalid');
  }
  const body=new URLSearchParams({
    client_id:clientId,
    client_secret:clientSecret,
    code,
    code_verifier:codeVerifier,
    redirect_uri:redirectUri,
    grant_type:'authorization_code',
  });
  const tokenResponse=await fetchBoundedJson(GOOGLE_TOKEN_ENDPOINT,{
    method:'POST',
    headers:{accept:'application/json','content-type':'application/x-www-form-urlencoded'},
    body:body.toString(),
    redirect:'error',
  },{maxBytes:TOKEN_RESPONSE_MAX_BYTES});
  if(typeof tokenResponse.id_token!=='string'||Buffer.byteLength(tokenResponse.id_token,'utf8')>ID_TOKEN_MAX_BYTES){
    fail('identity_invalid');
  }
  const jwks=await fetchBoundedJson(GOOGLE_JWKS_ENDPOINT,{
    method:'GET',headers:{accept:'application/json'},cache:'no-store',redirect:'error',
  },{maxBytes:JWKS_RESPONSE_MAX_BYTES});
  return verifyGoogleIdToken(tokenResponse.id_token,{clientId,nonce,jwks});
}

export function publicGoogleErrorCode(error){
  if(error instanceof GoogleOidcError){
    if(error.code==='provider_unavailable') return 'provider_unavailable';
    if(error.code==='provider_response_too_large') return 'provider_response_invalid';
    return 'identity_invalid';
  }
  return 'provider_unavailable';
}

export function publicGoogleAuthorizationError(value){
  switch(String(value||'')){
    case 'access_denied': return 'access_denied';
    case 'server_error':
    case 'temporarily_unavailable': return 'provider_unavailable';
    default: return 'provider_denied';
  }
}
