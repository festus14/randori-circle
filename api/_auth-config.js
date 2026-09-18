const LOOPBACK_HOSTNAMES=new Set(['localhost','127.0.0.1','::1']);
const MAX_APP_URL_LENGTH=2048;
const MAX_CLIENT_ID_LENGTH=2048;
const MAX_CLIENT_SECRET_LENGTH=4096;

function exactConfiguredValue(value,maxLength){
  if(typeof value!=='string'||value.length<1||value.length>maxLength||value!==value.trim()) return null;
  if(/[\u0000-\u001f\u007f]/u.test(value)) return null;
  return value;
}

function secureDeployment(env){
  return env.NODE_ENV==='production'||Boolean(env.VERCEL)||Boolean(env.VERCEL_ENV)||Boolean(env.VERCEL_URL);
}

function canonicalApplicationUrl(value,{requireHttps=false}={}){
  const raw=exactConfiguredValue(value,MAX_APP_URL_LENGTH);
  if(!raw) return null;
  let parsed;
  try{ parsed=new URL(raw); }catch{ return null; }
  if(parsed.username||parsed.password||parsed.search||parsed.hash
    ||(parsed.pathname!==''&&parsed.pathname!=='/')) return null;
  const loopback=LOOPBACK_HOSTNAMES.has(parsed.hostname.toLowerCase());
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

function firstForwardedValue(value){
  return String(value||'').split(',')[0].trim().toLowerCase();
}

/**
 * Bind OAuth navigation to the advertised origin. Production and hosted
 * deployments must also arrive through an HTTPS-aware trusted proxy.
 */
export function googleOAuthRequestConfiguration(req,env=process.env){
  const configuration=resolveGoogleOAuthConfiguration(env);
  if(!configuration) return null;
  const expected=new URL(configuration.appOrigin);
  const requestHost=firstForwardedValue(req?.headers?.['x-forwarded-host']||req?.headers?.host);
  const forwardedProto=firstForwardedValue(req?.headers?.['x-forwarded-proto']);
  if(!requestHost||requestHost!==expected.host.toLowerCase()) return null;
  if(secureDeployment(env)){
    if(forwardedProto!=='https') return null;
  }else if(forwardedProto&&`${forwardedProto}:`!==expected.protocol){
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
