const DEFAULT_BASE_URL='https://api.turso.tech';

const PUBLIC_MESSAGES=Object.freeze({
  TURSO_PLATFORM_INVALID:'Turso Platform API configuration is invalid.',
  TURSO_PLATFORM_TIMEOUT:'The Turso Platform API request timed out.',
  TURSO_PLATFORM_NOT_FOUND:'The requested Turso database was not found.',
  TURSO_PLATFORM_RATE_LIMITED:'The Turso Platform API request was rate limited.',
  TURSO_PLATFORM_UNAVAILABLE:'The Turso Platform API is unavailable.',
  TURSO_PLATFORM_REJECTED:'The Turso Platform API rejected the request.',
  TURSO_PLATFORM_RESPONSE_INVALID:'The Turso Platform API returned an invalid response.',
  TURSO_PLATFORM_FAILED:'The Turso Platform API request failed.',
});

const DEFAULT_TIMEOUT_MS=15_000;
const DEFAULT_MAX_RESPONSE_BYTES=256*1024;
const NAME=/^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;
const EXPIRATION=/^(?:[1-9][0-9]*[wdhms])+$/;

export class TursoPlatformError extends Error{
  constructor(code,message,{cause,status,retryable=false}={}){
    super(message,cause?{cause}:undefined);
    this.name='TursoPlatformError';
    this.code=code;
    if(Number.isSafeInteger(status)) this.status=status;
    this.retryable=retryable===true;
  }
}

function fail(code,message,details){ throw new TursoPlatformError(code,message,details); }

function boundedInteger(value,name,{minimum=1,maximum=Number.MAX_SAFE_INTEGER}={}){
  if(!Number.isSafeInteger(value)||value<minimum||value>maximum){
    fail('TURSO_PLATFORM_INVALID',`${name} is invalid`);
  }
  return value;
}

function platformName(value,name){
  if(typeof value!=='string'||!NAME.test(value)||value.length>64){
    fail('TURSO_PLATFORM_INVALID',`${name} is invalid`);
  }
  return value;
}

function opaque(value,name,{maximum=512}={}){
  if(typeof value!=='string'||value.length===0||value!==value.trim()
    ||Buffer.byteLength(value,'utf8')>maximum||/[\u0000-\u001f\u007f]/u.test(value)){
    fail('TURSO_PLATFORM_RESPONSE_INVALID',`${name} is invalid`);
  }
  return value;
}

function hostname(value){
  const result=opaque(value,'database hostname',{maximum:253}).toLowerCase();
  if(result!==value||result.endsWith('.')||!result.includes('.')
    ||result.split('.').some(label=>!NAME.test(label))){
    fail('TURSO_PLATFORM_RESPONSE_INVALID','database hostname is invalid');
  }
  return result;
}

function timestamp(value,name='timestamp'){
  if(typeof value!=='string') fail('TURSO_PLATFORM_INVALID',`${name} is invalid`);
  const milliseconds=Date.parse(value);
  if(!Number.isFinite(milliseconds)||new Date(milliseconds).toISOString()!==value){
    fail('TURSO_PLATFORM_INVALID',`${name} is invalid`);
  }
  return value;
}

function providerTimestamp(value,name){
  if(typeof value!=='string'||!/^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(?:\.[0-9]{1,9})?Z$/.test(value)){
    fail('TURSO_PLATFORM_RESPONSE_INVALID',`${name} is invalid`);
  }
  const milliseconds=Date.parse(value);
  if(!Number.isFinite(milliseconds)) fail('TURSO_PLATFORM_RESPONSE_INVALID',`${name} is invalid`);
  return new Date(milliseconds).toISOString();
}

function baseUrl(value){
  let parsed;
  try{ parsed=new URL(value); }catch{ fail('TURSO_PLATFORM_INVALID','base URL is invalid'); }
  if(parsed.protocol!=='https:'||parsed.username||parsed.password||parsed.search||parsed.hash
    ||parsed.pathname!=='/'||parsed.origin==='null'){
    fail('TURSO_PLATFORM_INVALID','base URL is invalid');
  }
  return parsed.origin;
}

function canonicalDatabase(value,{created=false}={}){
  const database=value?.database??value;
  if(!database||typeof database!=='object'||Array.isArray(database)){
    fail('TURSO_PLATFORM_RESPONSE_INVALID','database response is invalid');
  }
  const result={
    id:opaque(database.DbId,'database ID'),
    name:platformName(database.Name,'database name'),
    hostname:hostname(database.Hostname),
  };
  if(!created){
    result.group=platformName(database.group,'database group');
    if(typeof database.block_writes!=='boolean'){
      fail('TURSO_PLATFORM_RESPONSE_INVALID','database write state is invalid');
    }
    result.blockWrites=database.block_writes;
    if(database.parent===null){
      result.parent=null;
    }else if(database.parent===undefined){
      fail('TURSO_PLATFORM_RESPONSE_INVALID','database parent status is missing');
    }else{
      result.parent=Object.freeze({
        id:opaque(database.parent?.id,'parent database ID'),
        name:platformName(database.parent?.name,'parent database name'),
        branchedAt:providerTimestamp(database.parent?.branched_at,'parent branch timestamp'),
      });
    }
  }
  return Object.freeze(result);
}

function canonicalCreatedDatabase(value){
  const database=value?.database;
  if(!database||typeof database!=='object'||Array.isArray(database)){
    fail('TURSO_PLATFORM_RESPONSE_INVALID','create database response is invalid');
  }
  return canonicalDatabase({database:{...database,Hostname:database.Hostname}},{created:true});
}

function canonicalConfiguration(value){
  if(!value||typeof value!=='object'||Array.isArray(value)||typeof value.block_writes!=='boolean'){
    fail('TURSO_PLATFORM_RESPONSE_INVALID','database configuration response is invalid');
  }
  return Object.freeze({blockWrites:value.block_writes});
}

function publicCodeForStatus(status){
  if(status===404) return 'TURSO_PLATFORM_NOT_FOUND';
  if(status===429) return 'TURSO_PLATFORM_RATE_LIMITED';
  if(status>=500) return 'TURSO_PLATFORM_UNAVAILABLE';
  return 'TURSO_PLATFORM_REJECTED';
}

function isAbort(error,signal){
  return signal.aborted||error?.name==='AbortError'||error?.code==='ABORT_ERR';
}

async function responseBytes(response,maximum){
  const declared=response.headers?.get?.('content-length');
  if(declared!==null&&declared!==undefined){
    const length=Number(declared);
    if(!Number.isSafeInteger(length)||length<0||length>maximum){
      fail('TURSO_PLATFORM_RESPONSE_INVALID','response size is invalid');
    }
  }
  let bytes;
  try{ bytes=new Uint8Array(await response.arrayBuffer()); }
  catch(error){
    if(error instanceof TursoPlatformError) throw error;
    throw new TursoPlatformError('TURSO_PLATFORM_RESPONSE_INVALID','response could not be read',{cause:error});
  }
  if(bytes.byteLength>maximum){
    fail('TURSO_PLATFORM_RESPONSE_INVALID','response is too large');
  }
  return bytes;
}

function parseJson(bytes){
  if(bytes.byteLength===0) fail('TURSO_PLATFORM_RESPONSE_INVALID','response body is empty');
  try{ return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes)); }
  catch(error){
    throw new TursoPlatformError('TURSO_PLATFORM_RESPONSE_INVALID','response JSON is invalid',{cause:error});
  }
}

function freeze(value){
  if(Array.isArray(value)) return Object.freeze(value.map(freeze));
  if(value&&typeof value==='object'){
    return Object.freeze(Object.fromEntries(Object.entries(value).map(([key,item])=>[key,freeze(item)])));
  }
  return value;
}

export function publicTursoPlatformError(error){
  const code=error instanceof TursoPlatformError&&PUBLIC_MESSAGES[error.code]
    ?error.code:'TURSO_PLATFORM_FAILED';
  return Object.freeze({ok:false,error:code,message:PUBLIC_MESSAGES[code]});
}

export function createTursoPlatformClient(options={}){
  const organization=platformName(options.organization,'organization');
  if(typeof options.token!=='string'||options.token.length<16||options.token.length>16*1024
    ||options.token!==options.token.trim()||/[\u0000-\u001f\u007f]/u.test(options.token)){
    fail('TURSO_PLATFORM_INVALID','platform token is invalid');
  }
  const token=options.token;
  const fetchImpl=options.fetchImpl??globalThis.fetch;
  if(typeof fetchImpl!=='function') fail('TURSO_PLATFORM_INVALID','fetch implementation is invalid');
  const origin=baseUrl(options.baseUrl??DEFAULT_BASE_URL);
  const externalSignal=options.signal;
  if(externalSignal!==undefined
    &&(!externalSignal||typeof externalSignal.aborted!=='boolean'
      ||typeof externalSignal.addEventListener!=='function')){
    fail('TURSO_PLATFORM_INVALID','abort signal is invalid');
  }
  const timeoutMs=boundedInteger(options.timeoutMs??DEFAULT_TIMEOUT_MS,'request timeout',{maximum:60_000});
  const maxResponseBytes=boundedInteger(
    options.maxResponseBytes??DEFAULT_MAX_RESPONSE_BYTES,
    'maximum response size',
    {maximum:1024*1024},
  );
  const organizationPath=`/v1/organizations/${encodeURIComponent(organization)}`;

  async function request(method,path,{body,allowNotFound=false}={}){
    const controller=new AbortController();
    const signal=externalSignal?AbortSignal.any([controller.signal,externalSignal]):controller.signal;
    const timer=setTimeout(()=>controller.abort(),timeoutMs);
    try{
      let response;
      try{
        response=await fetchImpl(`${origin}${path}`,{
          method,
          headers:{
            authorization:`Bearer ${token}`,
            accept:'application/json',
            ...(body===undefined?{}:{'content-type':'application/json'}),
          },
          ...(body===undefined?{}:{body:JSON.stringify(body)}),
          signal,
          redirect:'error',
        });
      }catch(error){
        if(isAbort(error,signal)){
          throw new TursoPlatformError('TURSO_PLATFORM_TIMEOUT','platform request timed out',{cause:error,retryable:true});
        }
        throw new TursoPlatformError('TURSO_PLATFORM_FAILED','platform request failed',{cause:error,retryable:true});
      }
      if(!response||typeof response.status!=='number'){
        fail('TURSO_PLATFORM_RESPONSE_INVALID','response metadata is invalid');
      }
      if(!response.ok){
        const code=publicCodeForStatus(response.status);
        if(allowNotFound&&response.status===404) return null;
        throw new TursoPlatformError(code,'platform request was rejected',{
          status:response.status,retryable:response.status===429||response.status>=500,
        });
      }
      return parseJson(await responseBytes(response,maxResponseBytes));
    }finally{ clearTimeout(timer); }
  }

  const databasePath=name=>`${organizationPath}/databases/${encodeURIComponent(platformName(name,'database name'))}`;

  return freeze({
    async getDatabase(name,{allowNotFound=false}={}){
      const value=await request('GET',databasePath(name),{allowNotFound});
      return value===null?null:canonicalDatabase(value);
    },
    async getDatabaseConfiguration(name){
      return canonicalConfiguration(await request('GET',`${databasePath(name)}/configuration`));
    },
    async setDatabaseBlockWrites(name,blockWrites){
      if(typeof blockWrites!=='boolean') fail('TURSO_PLATFORM_INVALID','block_writes is invalid');
      const value=canonicalConfiguration(await request('PATCH',`${databasePath(name)}/configuration`,{
        body:{block_writes:blockWrites},
      }));
      if(value.blockWrites!==blockWrites){
        fail('TURSO_PLATFORM_RESPONSE_INVALID','write state update was not acknowledged');
      }
      return value;
    },
    async createPitrDatabase({name,group,sourceName,pitrAt}={}){
      const databaseName=platformName(name,'restore database name');
      const databaseGroup=platformName(group,'database group');
      const sourceDatabaseName=platformName(sourceName,'source database name');
      const recoveryTimestamp=timestamp(pitrAt,'PITR timestamp');
      const value=canonicalCreatedDatabase(await request('POST',`${organizationPath}/databases`,{
        body:{
          name:databaseName,
          group:databaseGroup,
          seed:{type:'database',name:sourceDatabaseName,timestamp:recoveryTimestamp},
        },
      }));
      if(value.name!==databaseName){
        fail('TURSO_PLATFORM_RESPONSE_INVALID','created database name does not match');
      }
      return value;
    },
    async createDatabaseToken(name,{expiration='15m',authorization}={}){
      platformName(name,'database name');
      if(typeof expiration!=='string'||expiration.length>32||!EXPIRATION.test(expiration)){
        fail('TURSO_PLATFORM_INVALID','token expiration is invalid');
      }
      if(!['read-only','full-access'].includes(authorization)){
        fail('TURSO_PLATFORM_INVALID','token authorization is invalid');
      }
      const query=new URLSearchParams({expiration,authorization});
      const value=await request('POST',`${databasePath(name)}/auth/tokens?${query}`);
      return opaque(value?.jwt,'database token',{maximum:16*1024});
    },
    async deleteDatabase(name){
      const databaseName=platformName(name,'database name');
      const value=await request('DELETE',databasePath(databaseName));
      if(value?.database!==databaseName){
        fail('TURSO_PLATFORM_RESPONSE_INVALID','deleted database name does not match');
      }
      return Object.freeze({deleted:true});
    },
  });
}
