function present(value){
  return value!==undefined&&value!==null&&String(value).trim()!=='';
}

function loopbackHost(value){
  const raw=String(value||'').split(',')[0].trim();
  if(!raw) return null;
  try{
    const url=new URL(`http://${raw}`);
    const hostname=url.hostname.replace(/^\[|\]$/g,'').toLowerCase();
    return hostname==='localhost'||hostname==='127.0.0.1'||hostname==='::1' ? url.host.toLowerCase() : null;
  }catch{
    return null;
  }
}

function loopbackAddress(value){
  const address=String(value||'').trim().toLowerCase();
  return address==='127.0.0.1'||address==='::1'||address==='::ffff:127.0.0.1';
}

/**
 * This is the common fail-closed boundary for every local-only adapter.  A
 * development NODE_ENV alone is deliberately insufficient: the one-command
 * runtime must opt in, use a credential-free file database, advertise the
 * exact HTTP loopback origin, and receive the request from loopback.
 */
export function localRuntimeRequest(req,{requireIdentityAdapter=false}={}){
  if(process.env.NODE_ENV!=='development'
    ||process.env.RANDORI_LOCAL_RUNTIME!=='true'
    ||(requireIdentityAdapter&&process.env.RANDORI_LOCAL_IDENTITY!=='true')
    ||process.env.VERCEL||process.env.VERCEL_ENV||process.env.VERCEL_URL
    ||present(process.env.TURSO_AUTH_TOKEN)) return false;

  let databaseUrl,appUrl,requestUrl;
  try{
    databaseUrl=new URL(String(process.env.TURSO_DATABASE_URL||''));
    appUrl=new URL(String(process.env.APP_URL||''));
    requestUrl=new URL(`http://${String(req?.headers?.host||'')}`);
  }catch{
    return false;
  }
  if(databaseUrl.protocol!=='file:'||databaseUrl.host||databaseUrl.username||databaseUrl.password
    ||databaseUrl.search||databaseUrl.hash) return false;
  const appHost=loopbackHost(appUrl.host);
  const requestHost=loopbackHost(req?.headers?.host);
  if(appUrl.protocol!=='http:'||appUrl.username||appUrl.password||appUrl.search||appUrl.hash
    ||(appUrl.pathname!=='/'&&appUrl.pathname!=='')||!appHost||!requestHost
    ||appHost!==requestUrl.host.toLowerCase()||appHost!==requestHost) return false;
  return loopbackAddress(req?.socket?.remoteAddress);
}

export function localIdentityAdapterEnabled(req){
  return localRuntimeRequest(req,{requireIdentityAdapter:true})
    &&process.env.CIRCLE_MEMBERSHIP_ENABLED==='true'
    &&process.env.ALLOW_OPEN_SIGNUP!=='true';
}
