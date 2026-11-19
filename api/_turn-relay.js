// Free TURN relay for the direct browser call (issue #305, ID-107).
//
// The pair room's direct call is peer-to-peer WebRTC with database
// signalling. STUN alone cannot connect two browsers that are both behind
// restrictive NATs, so while TURN_RELAY_ENABLED is on this module mints
// short-lived Cloudflare Realtime TURN credentials for one authorized pair
// member. Randori never relays media itself, stores nothing about the call
// and never logs a credential: the only state is the shared keyed-hash
// rate-limit counter.
//
// Cloudflare adapter assumption (one place to change, see
// cloudflareTurnCredentialsUrl and parseCloudflareIceServers):
//   POST https://rtc.live.cloudflare.com/v1/turn/keys/{key id}/credentials/generate-ice-servers
//   Authorization: Bearer <API token>, body {"ttl": <seconds>}
//   -> 200/201 {"iceServers":[{"urls":[...]} , {"urls":[...],"username":"…","credential":"…"}]}
// Anything else fails closed and the browser keeps its STUN-only call.
import { clientAddress, rateLimitAddress } from './_client-address.js';
import { consumeKeyedRateLimits } from './_keyed-rate-limit.js';

export const CLOUDFLARE_TURN_API_BASE='https://rtc.live.cloudflare.com/v1/turn/keys';
export const TURN_MAX_TTL_SECONDS=60*60;
export const TURN_PROVIDER_TIMEOUT_MS=5000;
export const TURN_RATE_WINDOW_SECONDS=15*60;
export const TURN_RATE_LIMITS=Object.freeze({account:20,address:60});
export const TURN_LIMITS=Object.freeze({
  responseBytes:16*1024,entries:4,urlsPerEntry:12,urls:16,urlLength:256,credentialLength:512,
});

const KEY_ID=/^[A-Za-z0-9_-]{8,128}$/;
const API_TOKEN=/^[A-Za-z0-9._~+/=-]{20,512}$/;
const CREDENTIAL=/^[\x21-\x7e]+$/;
// scheme:host[:port][?transport=udp|tcp] with a Cloudflare host only.
const ICE_URL=/^(stun|turns?):([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*)(?::([1-9]\d{0,4}))?(?:\?transport=(udp|tcp))?$/;
// Browsers block port 53, so Cloudflare's :53 alternates are dropped.
const BLOCKED_PORTS=new Set([53]);

export class TurnRelayInputError extends Error{
  constructor(message){ super(message); this.name='TurnRelayInputError'; }
}

// Carries only the failing stage and the provider's HTTP status: never the
// request, the response body, the key id, the API token or a credential.
export class TurnProviderError extends Error{
  constructor(stage,status=null){
    super('call relay provider request failed');
    this.name='TurnProviderError'; this.stage=stage; this.status=status;
  }
}

/**
 * The flag is literal `true` only, and the capability exists only with a
 * well-formed key id and server-only API token. The one-command local
 * runtime never enables it, whatever its environment says.
 */
export function turnRelayConfiguration(env=process.env){
  if(env.TURN_RELAY_ENABLED!=='true'||env.RANDORI_LOCAL_RUNTIME==='true') return null;
  const keyId=String(env.CLOUDFLARE_TURN_KEY_ID??'').trim();
  const apiToken=String(env.CLOUDFLARE_TURN_API_TOKEN??'').trim();
  if(!KEY_ID.test(keyId)||!API_TOKEN.test(apiToken)) return null;
  return Object.freeze({keyId,apiToken});
}

export function cloudflareTurnCredentialsUrl(keyId){
  return `${CLOUDFLARE_TURN_API_BASE}/${encodeURIComponent(keyId)}/credentials/generate-ice-servers`;
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

function parseIceUrl(value){
  if(typeof value!=='string'||value.length>TURN_LIMITS.urlLength) return null;
  const match=ICE_URL.exec(value);
  if(!match) return null;
  const [,scheme,host,port,transport]=match;
  if(host!=='cloudflare.com'&&!host.endsWith('.cloudflare.com')) return null;
  if(port!==undefined&&Number(port)>65535) return null;
  if(scheme==='stun'&&transport!==undefined) return null;
  return {scheme,port:port===undefined?null:Number(port)};
}

function validCredential(value){
  return typeof value==='string'&&value.length<=TURN_LIMITS.credentialLength&&CREDENTIAL.test(value);
}

/**
 * Strict projection of Cloudflare's response: only stun:/turn:/turns: URLs on
 * Cloudflare hosts, bounded counts and lengths, and a username/credential pair
 * on every relay entry. Any violation rejects the whole response; only the
 * browser-blocked :53 alternates are dropped. Unknown fields are never copied.
 */
export function parseCloudflareIceServers(payload){
  const entries=payload?.iceServers;
  if(!payload||typeof payload!=='object'||Array.isArray(payload)
    ||!Array.isArray(entries)||entries.length<1||entries.length>TURN_LIMITS.entries){
    throw new TurnProviderError('response');
  }
  const servers=[];
  let total=0,relays=0;
  for(const entry of entries){
    if(!entry||typeof entry!=='object'||Array.isArray(entry)) throw new TurnProviderError('response');
    const urls=typeof entry.urls==='string'?[entry.urls]:entry.urls;
    if(!Array.isArray(urls)||urls.length<1||urls.length>TURN_LIMITS.urlsPerEntry) throw new TurnProviderError('response');
    const kept=[];
    let relay=false;
    for(const url of urls){
      const parsed=parseIceUrl(url);
      if(!parsed) throw new TurnProviderError('response');
      if(parsed.scheme!=='stun') relay=true;
      if(parsed.port!==null&&BLOCKED_PORTS.has(parsed.port)) continue;
      kept.push(url);
    }
    const hasUsername=entry.username!==undefined, hasCredential=entry.credential!==undefined;
    if(hasUsername!==hasCredential||(relay&&!hasUsername)) throw new TurnProviderError('response');
    if(hasUsername&&(!validCredential(entry.username)||!validCredential(entry.credential))) throw new TurnProviderError('response');
    if(!kept.length) continue;
    total+=kept.length;
    if(relay&&kept.some(url=>!url.startsWith('stun:'))) relays+=1;
    servers.push(hasUsername?{urls:kept,username:entry.username,credential:entry.credential}:{urls:kept});
  }
  if(!relays||total>TURN_LIMITS.urls) throw new TurnProviderError('response');
  return servers;
}

/** Returns {iceServers, expiresAt}; throws TurnProviderError. */
export async function mintTurnIceServers(config,{window,fetchImpl=globalThis.fetch}){
  if(!config||!(window?.ttlSeconds>0)) throw new TurnProviderError('configuration');
  let response,text;
  try{
    response=await fetchImpl(cloudflareTurnCredentialsUrl(config.keyId),{
      method:'POST',
      headers:{authorization:`Bearer ${config.apiToken}`,'content-type':'application/json',accept:'application/json'},
      body:JSON.stringify({ttl:window.ttlSeconds}),
      redirect:'error',
      signal:AbortSignal.timeout(TURN_PROVIDER_TIMEOUT_MS),
    });
  }catch{ throw new TurnProviderError('request'); }
  if(response.status!==200&&response.status!==201) throw new TurnProviderError('status',response.status);
  const declared=Number(response.headers?.get?.('content-length'));
  if(Number.isFinite(declared)&&declared>TURN_LIMITS.responseBytes) throw new TurnProviderError('response',response.status);
  try{ text=await response.text(); }catch{ throw new TurnProviderError('request',response.status); }
  if(typeof text!=='string'||Buffer.byteLength(text,'utf8')>TURN_LIMITS.responseBytes) throw new TurnProviderError('response',response.status);
  let payload;
  try{ payload=JSON.parse(text); }catch{ throw new TurnProviderError('response',response.status); }
  let iceServers;
  try{ iceServers=parseCloudflareIceServers(payload); }
  catch{ throw new TurnProviderError('response',response.status); }
  return Object.freeze({iceServers,expiresAt:new Date(window.expiresAtMs).toISOString()});
}
