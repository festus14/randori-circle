import { BlockList, isIP } from 'node:net';

const LOOPBACK_HOSTNAMES=new Set(['localhost','127.0.0.1','::1']);
const MAX_APP_URL_LENGTH=2048;
const MAX_CLIENT_ID_LENGTH=2048;
const MAX_CLIENT_SECRET_LENGTH=4096;
const LOOPBACK_ADDRESSES=new BlockList();
LOOPBACK_ADDRESSES.addSubnet('127.0.0.0',8,'ipv4');
LOOPBACK_ADDRESSES.addAddress('::1','ipv6');
LOOPBACK_ADDRESSES.addSubnet('::ffff:127.0.0.0',104,'ipv6');

function exactConfiguredValue(value,maxLength){
  if(typeof value!=='string'||value.length<1||value.length>maxLength||value!==value.trim()) return null;
  if(/[\u0000-\u001f\u007f]/u.test(value)) return null;
  return value;
}

function secureDeployment(env){
  return env.NODE_ENV==='production'||Boolean(env.VERCEL)||Boolean(env.VERCEL_ENV)||Boolean(env.VERCEL_URL);
}

function loopbackHostname(value){
  const hostname=String(value||'').replace(/^\[|\]$/g,'').toLowerCase().replace(/\.$/u,'');
  if(LOOPBACK_HOSTNAMES.has(hostname)||hostname.endsWith('.localhost')) return true;
  const family=isIP(hostname);
  return family===4
    ?LOOPBACK_ADDRESSES.check(hostname,'ipv4')
    :family===6&&LOOPBACK_ADDRESSES.check(hostname,'ipv6');
}

function canonicalApplicationUrl(value,{requireHttps=false}={}){
  const raw=exactConfiguredValue(value,MAX_APP_URL_LENGTH);
  if(!raw) return null;
  let parsed;
  try{ parsed=new URL(raw); }catch{ return null; }
  if(parsed.username||parsed.password||parsed.search||parsed.hash
    ||(parsed.pathname!==''&&parsed.pathname!=='/')) return null;
  if(raw!==parsed.origin&&raw!==`${parsed.origin}/`) return null;
  const loopback=loopbackHostname(parsed.hostname);
  if(requireHttps){
    if(parsed.protocol!=='https:'||loopback) return null;
  }else if(parsed.protocol!=='https:'&&!(parsed.protocol==='http:'&&loopback)){
    return null;
  }
  return parsed;
}

/**
 * Resolve the only configuration from which Google OAuth may be advertised or
 * entered. Invalid configurations deliberately collapse to null so public
 * responses never disclose which secret or deployment setting is absent.
 */
export function resolveGoogleOAuthConfiguration(env=process.env){
  if(env.RANDORI_LOCAL_RUNTIME==='true') return null;
  const requireHttps=secureDeployment(env);
  const appUrl=canonicalApplicationUrl(env.APP_URL,{requireHttps});
  const clientId=exactConfiguredValue(env.GOOGLE_CLIENT_ID,MAX_CLIENT_ID_LENGTH);
  const clientSecret=exactConfiguredValue(env.GOOGLE_CLIENT_SECRET,MAX_CLIENT_SECRET_LENGTH);
  if(!appUrl||!clientId||!clientSecret) return null;
  const appOrigin=appUrl.origin;
  return Object.freeze({
    appOrigin,
    clientId,
    clientSecret,
    redirectUri:`${appOrigin}/api/auth/google/callback`,
  });
}

function singleHeaderValue(value){
  const raw=String(value||'').trim().toLowerCase();
  return !raw||raw.includes(',')?null:raw;
}

/**
 * Bind OAuth navigation to the advertised origin. Production and hosted
 * deployments must also arrive through an HTTPS-aware trusted proxy.
 */
export function googleOAuthRequestConfiguration(req,env=process.env){
  const configuration=resolveGoogleOAuthConfiguration(env);
  if(!configuration) return null;
  const expected=new URL(configuration.appOrigin);
  const requestHost=singleHeaderValue(req?.headers?.host);
  const forwardedHostValue=req?.headers?.['x-forwarded-host'];
  const forwardedHost=forwardedHostValue===undefined?null:singleHeaderValue(forwardedHostValue);
  const forwardedProtoValue=req?.headers?.['x-forwarded-proto'];
  const forwardedProto=forwardedProtoValue===undefined?null:singleHeaderValue(forwardedProtoValue);
  if(!requestHost||requestHost!==expected.host.toLowerCase()) return null;
  if(forwardedHostValue!==undefined&&(!forwardedHost||forwardedHost!==requestHost)) return null;
  if(secureDeployment(env)){
    if(forwardedProto!=='https') return null;
  }else if(forwardedProtoValue!==undefined&&(!forwardedProto||`${forwardedProto}:`!==expected.protocol)){
    return null;
  }
  return configuration;
}

export function setAuthResponseHeaders(res){
  res.setHeader('Cache-Control','no-store');
  res.setHeader('Pragma','no-cache');
  res.setHeader('X-Content-Type-Options','nosniff');
  res.setHeader('Referrer-Policy','no-referrer');
}
