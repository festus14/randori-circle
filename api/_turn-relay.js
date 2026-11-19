// Free TURN relays for the direct browser call (issue #305, ID-107).
//
// The pair room's direct call is peer-to-peer WebRTC with database
// signalling. STUN alone cannot connect two browsers that are both behind
// restrictive NATs, so while TURN_RELAY_ENABLED is on the server hands one
// authorized pair member short-lived relay credentials from, in order:
//   1. Cloudflare Realtime TURN (free monthly allowance), then
//   2. Metered Open Relay (free 20 GB/month) as the backup,
// each only while its own monthly usage gate (api/_turn-budget.js) allows.
// Randori never relays media itself and never logs a credential.
//
// Provider adapter assumptions (each in one place; the orchestrator verifies
// them against the live APIs before enabling):
// - Cloudflare credentials: POST
//   https://rtc.live.cloudflare.com/v1/turn/keys/{key id}/credentials/generate-ice-servers
//   with `Authorization: Bearer <API token>` and {"ttl": seconds} answers
//   201 {"iceServers":[{"urls":[...]},{"urls":[...],"username","credential"}]}.
//   No `customIdentifier` is sent: the request schema for it is unconfirmed.
// - Cloudflare usage: GraphQL callsTurnUsageAdaptiveGroups sum
//   {egressBytes ingressBytes} for the key over the UTC month.
// - Metered credentials: GET https://{app}.metered.live/api/v1/turn/credentials?apiKey=…
//   answers 200 with an iceServers array (a pre-created credential: Metered
//   needs up to two minutes to propagate new ones, so none is minted per call).
// - Metered usage: GET https://{app}.metered.live/api/v1/turn/current_usage?secretKey=…
//   answers 200 {"quotaInGB","usageInGB","overageInGB"} for the billing cycle.
// Anything else fails closed and the browser keeps its STUN-only call.
import { clientAddress, rateLimitAddress } from './_client-address.js';
import { consumeKeyedRateLimits } from './_keyed-rate-limit.js';

export const CLOUDFLARE_TURN_API_BASE='https://rtc.live.cloudflare.com/v1/turn/keys';
export const CLOUDFLARE_GRAPHQL_URL='https://api.cloudflare.com/client/v4/graphql';
export const TURN_PROVIDERS=Object.freeze(['cloudflare','metered']);
export const TURN_MAX_TTL_SECONDS=60*60;
export const TURN_PROVIDER_TIMEOUT_MS=5000;
export const TURN_RATE_WINDOW_SECONDS=15*60;
export const TURN_RATE_LIMITS=Object.freeze({account:20,address:60});
export const TURN_DEFAULT_BUDGET_GB=Object.freeze({cloudflare:800,metered:16});
// One credential's worst case for one hour: a relayed allocation carries both
// directions of the call and Cloudflare/Metered count each byte on ingress
// and again on egress, so 2 streams x 2 x 1 Mbps x 3600 s / 8 = 1,800 MB.
export const TURN_DEFAULT_RESERVE_MB_PER_CALL=1800;
export const TURN_LIMITS=Object.freeze({
  responseBytes:16*1024,entries:8,urlsPerEntry:12,urls:16,urlLength:256,credentialLength:512,
});

const KEY_ID=/^[A-Za-z0-9_-]{8,128}$/;
const API_TOKEN=/^[A-Za-z0-9._~+/=-]{20,512}$/;
const ACCOUNT_ID=/^[a-f0-9]{32}$/;
const METERED_DOMAIN=/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.metered\.live$/;
const METERED_KEY=/^[A-Za-z0-9._~-]{16,256}$/;
const POSITIVE_NUMBER=/^(?:[1-9]\d{0,6}|0)(?:\.\d{1,3})?$/;
const CREDENTIAL=/^[\x21-\x7e]+$/;
// scheme:host[:port][?transport=udp|tcp]; the host is checked per provider.
const ICE_URL=/^(stun|turns?):([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*)(?::([1-9]\d{0,4}))?(?:\?transport=(udp|tcp))?$/;
// Browsers block port 53, so Cloudflare's :53 alternates are dropped.
const BLOCKED_PORTS=new Set([53]);
const PROVIDER_HOSTS=Object.freeze({cloudflare:'cloudflare.com',metered:'metered.ca'});

export class TurnRelayInputError extends Error{
  constructor(message){ super(message); this.name='TurnRelayInputError'; }
}

// Carries only the provider, the failing stage and the provider's HTTP
// status: never the request, the response body, a key, a token or a
// credential.
export class TurnProviderError extends Error{
  constructor(stage,status=null,provider=null){
    super('call relay provider request failed');
    this.name='TurnProviderError'; this.stage=stage; this.status=status; this.provider=provider;
  }
}

function text(value){ return String(value??'').trim(); }

// A positive decimal (up to three places); unset means the default; anything
// else is invalid (null), which fails the provider closed.
export function parseBudgetGb(value,fallback){
  const raw=String(value??'').trim();
  if(!raw) return fallback;
  if(!POSITIVE_NUMBER.test(raw)) return null;
  const parsed=Number(raw);
  return Number.isFinite(parsed)&&parsed>0?parsed:null;
}

export function turnReserveMbPerCall(env=process.env){
  const raw=text(env.TURN_RESERVE_MB_PER_CALL);
  if(!raw) return TURN_DEFAULT_RESERVE_MB_PER_CALL;
  if(!/^[1-9]\d{0,6}$/.test(raw)) return null;
  return Number(raw);
}

function cloudflareConfiguration(env,reserveMb){
  const keyId=text(env.CLOUDFLARE_TURN_KEY_ID),apiToken=text(env.CLOUDFLARE_TURN_API_TOKEN);
  const accountId=text(env.CLOUDFLARE_ACCOUNT_ID).toLowerCase(),analyticsToken=text(env.CLOUDFLARE_ANALYTICS_API_TOKEN);
  if(!keyId&&!apiToken&&!accountId&&!analyticsToken) return {config:null,issue:null};
  const budgetGb=parseBudgetGb(env.TURN_MONTHLY_GB_BUDGET,TURN_DEFAULT_BUDGET_GB.cloudflare);
  if(!KEY_ID.test(keyId)||!API_TOKEN.test(apiToken)||!ACCOUNT_ID.test(accountId)||!API_TOKEN.test(analyticsToken)
    ||budgetGb===null||reserveMb===null) return {config:null,issue:'configuration'};
  return {config:Object.freeze({provider:'cloudflare',keyId,apiToken,accountId,analyticsToken,
    budgetMb:Math.floor(budgetGb*1000),reserveMb}),issue:null};
}

function meteredConfiguration(env,reserveMb){
  const domain=text(env.METERED_TURN_APP_DOMAIN).toLowerCase();
  const apiKey=text(env.METERED_TURN_API_KEY),secretKey=text(env.METERED_TURN_SECRET_KEY);
  if(!domain&&!apiKey&&!secretKey) return {config:null,issue:null};
  const budgetGb=parseBudgetGb(env.METERED_TURN_MONTHLY_GB_BUDGET,TURN_DEFAULT_BUDGET_GB.metered);
  if(!METERED_DOMAIN.test(domain)||!METERED_KEY.test(apiKey)||!METERED_KEY.test(secretKey)
    ||budgetGb===null||reserveMb===null) return {config:null,issue:'configuration'};
  return {config:Object.freeze({provider:'metered',domain,apiKey,secretKey,
    budgetMb:Math.floor(budgetGb*1000),reserveMb}),issue:null};
}

/**
 * The flag is literal `true` only and the one-command local runtime never
 * enables it. Each provider is optional and exists only with every one of its
 * values well formed (credentials, usage access and budget); a provider with
 * some values set but any invalid is reported as a configuration issue and
 * never used. Returns null when no relay is available at all.
 */
export function turnRelayConfiguration(env=process.env){
  if(env.TURN_RELAY_ENABLED!=='true'||env.RANDORI_LOCAL_RUNTIME==='true') return null;
  const reserveMb=turnReserveMbPerCall(env);
  const cloudflare=cloudflareConfiguration(env,reserveMb),metered=meteredConfiguration(env,reserveMb);
  const providers=[cloudflare.config,metered.config].filter(Boolean);
  if(!providers.length) return null;
  return Object.freeze({providers:Object.freeze(providers),
    issues:Object.freeze({cloudflare:cloudflare.issue,metered:metered.issue})});
}

/** Per-provider state for diagnostics, without any secret. */
export function turnProviderStates(env=process.env){
  const enabled=env.TURN_RELAY_ENABLED==='true'&&env.RANDORI_LOCAL_RUNTIME!=='true';
  const reserveMb=turnReserveMbPerCall(env);
  const states={};
  for(const [provider,read] of [['cloudflare',cloudflareConfiguration],['metered',meteredConfiguration]]){
    const {config,issue}=read(env,reserveMb);
    const fallback=TURN_DEFAULT_BUDGET_GB[provider];
    const budgetGb=parseBudgetGb(provider==='cloudflare'?env.TURN_MONTHLY_GB_BUDGET:env.METERED_TURN_MONTHLY_GB_BUDGET,fallback);
    states[provider]=Object.freeze({enabled:enabled&&!!config,issue:enabled?issue:null,
      budgetMb:config?config.budgetMb:budgetGb===null?null:Math.floor(budgetGb*1000)});
  }
  return Object.freeze({enabled,providers:Object.freeze(states)});
}

export function cloudflareTurnCredentialsUrl(keyId){
  return `${CLOUDFLARE_TURN_API_BASE}/${encodeURIComponent(keyId)}/credentials/generate-ice-servers`;
}

export function meteredCredentialsUrl(config){
  return `https://${config.domain}/api/v1/turn/credentials?apiKey=${encodeURIComponent(config.apiKey)}`;
}

export function meteredUsageUrl(config){
  return `https://${config.domain}/api/v1/turn/current_usage?secretKey=${encodeURIComponent(config.secretKey)}`;
}

function exactKeys(value,expected){
  if(!value||typeof value!=='object'||Array.isArray(value)) return false;
  const actual=Object.keys(value).sort();
  return actual.length===expected.length&&actual.every((key,index)=>key===expected[index]);
}

export function parseTurnRelayRequest(req,parseRoom){
  const search=new URL(req.url||'/','http://localhost').searchParams;
  const queryKeys=new Set([...search.keys(),...Object.keys(req.query||{})]);
  for(const key of queryKeys){
    const value=req.query?.[key]??search.get(key);
    if(key!=='endpoint'||Array.isArray(value)||search.getAll(key).length>1||value!=='turn'){
      throw new TurnRelayInputError('unsupported query parameter');
    }
  }
  if(!exactKeys(req.body,['room_id'])) throw new TurnRelayInputError('room_id is required');
  const room=parseRoom(req.body.room_id);
  if(!room) throw new TurnRelayInputError('canonical room_id required');
  return room;
}

/** Account, then client network, through the shared keyed limiter. */
export function enforceTurnRelayRateLimit(db,{req,userId,secret,nowSeconds=Math.floor(Date.now()/1000)}){
  const window={windowSeconds:TURN_RATE_WINDOW_SECONDS};
  return consumeKeyedRateLimits(db,{
    label:'randori-turn-relay-rate-v1',secret,nowSeconds,
    dimensions:[
      ['account',String(userId),{...window,limit:TURN_RATE_LIMITS.account}],
      ['address',rateLimitAddress(clientAddress(req)),{...window,limit:TURN_RATE_LIMITS.address}],
    ],
  });
}

/**
 * Credential lifetime: an interview room never outlives the time left on its
 * shared timer; every other room is capped at one hour. Zero means the
 * session has no time left.
 */
export function turnGrantWindow({nowMs=Date.now(),state=null}={}){
  let ttl=TURN_MAX_TTL_SECONDS;
  if(state?.interview_mode===true){
    const remaining=Number(state.remaining_ms);
    ttl=Math.min(ttl,Number.isSafeInteger(remaining)&&remaining>0?Math.floor(remaining/1000):0);
  }
  ttl=Math.max(0,ttl);
  return Object.freeze({ttlSeconds:ttl,expiresAtMs:Math.floor(nowMs/1000)*1000+ttl*1000});
}

function parseIceUrl(value,provider){
  if(typeof value!=='string'||value.length>TURN_LIMITS.urlLength) return null;
  const match=ICE_URL.exec(value);
  if(!match) return null;
  const [,scheme,host,port,transport]=match;
  const allowed=PROVIDER_HOSTS[provider];
  if(host!==allowed&&!host.endsWith(`.${allowed}`)) return null;
  if(port!==undefined&&Number(port)>65535) return null;
  if(scheme==='stun'&&transport!==undefined) return null;
  return {scheme,port:port===undefined?null:Number(port)};
}

function validCredential(value){
  return typeof value==='string'&&value.length<=TURN_LIMITS.credentialLength&&CREDENTIAL.test(value);
}

/**
 * Strict projection of a provider's ICE servers: only stun:/turn:/turns: URLs
 * on that provider's hosts (Cloudflare: cloudflare.com; Metered: metered.ca),
 * bounded counts and lengths, and a username/credential pair on every relay
 * entry. Any violation rejects the whole response; only the browser-blocked
 * :53 alternates are dropped. Unknown fields are never copied.
 */
export function parseProviderIceServers(entries,provider){
  if(!Array.isArray(entries)||entries.length<1||entries.length>TURN_LIMITS.entries||!PROVIDER_HOSTS[provider]){
    throw new TurnProviderError('response',null,provider);
  }
  const fail=()=>{ throw new TurnProviderError('response',null,provider); };
  const servers=[];
  let total=0,relays=0;
  for(const entry of entries){
    if(!entry||typeof entry!=='object'||Array.isArray(entry)) fail();
    const urls=typeof entry.urls==='string'?[entry.urls]:entry.urls;
    if(!Array.isArray(urls)||urls.length<1||urls.length>TURN_LIMITS.urlsPerEntry) fail();
    const kept=[];
    let relay=false;
    for(const url of urls){
      const parsed=parseIceUrl(url,provider);
      if(!parsed) fail();
      if(parsed.scheme!=='stun') relay=true;
      if(parsed.port!==null&&BLOCKED_PORTS.has(parsed.port)) continue;
      kept.push(url);
    }
    const hasUsername=entry.username!==undefined, hasCredential=entry.credential!==undefined;
    if(hasUsername!==hasCredential||(relay&&!hasUsername)) fail();
    if(hasUsername&&(!validCredential(entry.username)||!validCredential(entry.credential))) fail();
    if(!kept.length) continue;
    total+=kept.length;
    if(kept.some(url=>!url.startsWith('stun:'))) relays+=1;
    servers.push(hasUsername?{urls:kept,username:entry.username,credential:entry.credential}:{urls:kept});
  }
  if(!relays||total>TURN_LIMITS.urls) fail();
  return servers;
}

/** Cloudflare's response shape: {"iceServers":[…]}. */
export function parseCloudflareIceServers(payload){
  if(!payload||typeof payload!=='object'||Array.isArray(payload)) throw new TurnProviderError('response',null,'cloudflare');
  return parseProviderIceServers(payload.iceServers,'cloudflare');
}

/** Metered's response shape: a bare iceServers array. */
export function parseMeteredIceServers(payload){
  return parseProviderIceServers(payload,'metered');
}

/**
 * One bounded provider call: no redirects, a deadline covering the body, a
 * size cap, and JSON only. Throws TurnProviderError(`${prefix}request` |
 * `${prefix}status` | `${prefix}response`) on any failure.
 */
export async function providerJson(provider,url,init,{fetchImpl,signal,okStatuses=[200],prefix=''}){
  const fail=(stage,status=null)=>new TurnProviderError(`${prefix}${stage}`,status,provider);
  let response,body;
  try{ response=await fetchImpl(url,{...init,redirect:'error',signal}); }
  catch{ throw fail('request'); }
  const status=response.status;
  if(!okStatuses.includes(status)) throw fail('status',status);
  const declared=Number(response.headers?.get?.('content-length'));
  if(Number.isFinite(declared)&&declared>TURN_LIMITS.responseBytes) throw fail('response',status);
  try{ body=await response.text(); }catch{ throw fail('request',status); }
  if(typeof body!=='string'||Buffer.byteLength(body,'utf8')>TURN_LIMITS.responseBytes) throw fail('response',status);
  try{ return {status,payload:JSON.parse(body)}; }
  catch{ throw fail('response',status); }
}

/** Returns {iceServers, expiresAt, relay}; throws TurnProviderError. */
export async function mintTurnIceServers(config,{window,fetchImpl=globalThis.fetch}){
  if(!config||!PROVIDER_HOSTS[config.provider]||!(window?.ttlSeconds>0)) throw new TurnProviderError('configuration',null,config?.provider??null);
  const signal=AbortSignal.timeout(TURN_PROVIDER_TIMEOUT_MS);
  let result;
  if(config.provider==='cloudflare'){
    result=await providerJson('cloudflare',cloudflareTurnCredentialsUrl(config.keyId),{
      method:'POST',
      headers:{authorization:`Bearer ${config.apiToken}`,'content-type':'application/json',accept:'application/json'},
      body:JSON.stringify({ttl:window.ttlSeconds}),
    },{fetchImpl,signal,okStatuses:[200,201]});
  }else{
    result=await providerJson('metered',meteredCredentialsUrl(config),{method:'GET',headers:{accept:'application/json'}},
      {fetchImpl,signal});
  }
  let iceServers;
  try{ iceServers=config.provider==='cloudflare'?parseCloudflareIceServers(result.payload):parseMeteredIceServers(result.payload); }
  catch{ throw new TurnProviderError('response',result.status,config.provider); }
  return Object.freeze({iceServers,expiresAt:new Date(window.expiresAtMs).toISOString(),relay:config.provider});
}
