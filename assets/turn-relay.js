// Direct-call TURN relay client (issue #305, ID-107). index.html imports this
// module just before the direct call creates its RTCPeerConnection. It asks
// the same-origin /api/video/turn route for short-lived relay credentials
// (Cloudflare, or the Metered backup) and returns STUN plus those servers.
// Whenever the route is off (404), fails (503 or anything else), answers
// `relay: "none"` (every free allowance is used up), or takes longer than
// three seconds, the call proceeds STUN-only exactly as before. Credentials live only in
// this module's memory: never in localStorage, sessionStorage or a cookie.
export const TURN_ENDPOINT='/api/video/turn';
export const TURN_TIMEOUT_MS=3000;
// Re-fetch a minute before expiry so a new peer never starts on a stale pass.
export const TURN_REFRESH_MARGIN_MS=60*1000;
// After a 404 the relay is off for this deployment; ask again later.
export const TURN_OFF_RETRY_MS=10*60*1000;
// After a failure keep reconnects STUN-only briefly instead of hammering.
export const TURN_FAILURE_RETRY_MS=30*1000;
// Every relay is over budget: check again in five minutes.
export const TURN_PAUSED_RETRY_MS=5*60*1000;
// Each relay's servers live on its own hosts only.
export const RELAY_HOSTS=Object.freeze({cloudflare:'cloudflare.com',metered:'metered.ca'});

const MAX_ENTRIES=8, MAX_URLS=16, MAX_URL=256, MAX_SECRET=512;
const ICE_URL=/^(?:stun|turns?):[a-z0-9.-]+(?::\d{1,5})?(?:\?transport=(?:udp|tcp))?$/;
const HOST=/^(?:stun|turns?):([a-z0-9.-]+)/;
const SECRET=/^[\x21-\x7e]+$/;

function relayHost(url,domain){
  const host=HOST.exec(url)?.[1]||'';
  return host===domain||host.endsWith(`.${domain}`);
}

/** The route's servers, re-checked in the browser; null when anything is off. */
export function relayServersFrom(payload,nowMs=Date.now()){
  if(!payload||typeof payload!=='object'||!Array.isArray(payload.iceServers)) return null;
  const domain=Object.hasOwn(RELAY_HOSTS,payload.relay)?RELAY_HOSTS[payload.relay]:null;
  if(!domain) return null;
  const expiresAtMs=Date.parse(payload.expiresAt);
  if(!Number.isFinite(expiresAtMs)||expiresAtMs<=nowMs) return null;
  const list=payload.iceServers;
  if(list.length<1||list.length>MAX_ENTRIES) return null;
  const servers=[];
  let total=0,relay=false;
  for(const entry of list){
    const urls=Array.isArray(entry?.urls)?entry.urls:[entry?.urls];
    if(!urls.length||!urls.every(url=>typeof url==='string'&&url.length<=MAX_URL&&ICE_URL.test(url)&&relayHost(url,domain))) return null;
    total+=urls.length;
    const secret=entry.username!==undefined||entry.credential!==undefined;
    if(secret&&![entry.username,entry.credential].every(value=>typeof value==='string'&&value.length<=MAX_SECRET&&SECRET.test(value))) return null;
    const turn=urls.some(url=>!url.startsWith('stun:'));
    if(turn&&!secret) return null;
    relay||=turn;
    servers.push(secret?{urls:[...urls],username:entry.username,credential:entry.credential}:{urls:[...urls]});
  }
  if(!relay||total>MAX_URLS) return null;
  return {servers,expiresAtMs,relay:payload.relay};
}

/**
 * One in-memory source of ICE servers for the direct call.
 * - `peek(room)` answers synchronously with an array (STUN `base` plus a
 *   fresh relay, or STUN alone while relays are off, backing off or there is
 *   no room), or else a single-flight Promise for that array.
 * - `servers(room)` always resolves (never rejects) to that array.
 * - `create(room, key, make)` runs `make(servers)` synchronously whenever
 *   `peek` can answer synchronously, so the caller's peer slot is claimed at
 *   once exactly as without a relay. Otherwise it shares one pending creation
 *   per `key` (the call's epoch) between every caller until the relay answers
 *   or the deadline passes: two callers can never create two peers.
 * - `clear()` forgets the pass, any back-off and any pending creation.
 * The whole lookup is capped at `timeoutMs` (three seconds), whatever the
 * network does.
 */
export function createIceServerSource(base,{fetchImpl=(...args)=>globalThis.fetch(...args),now=()=>Date.now(),timeoutMs=TURN_TIMEOUT_MS}={}){
  const stun=()=>base.map(entry=>({...entry}));
  let cached=null,pending=null,retryAt=0,slot=null;

  async function attempt(room,signal){
    try{
      const response=await fetchImpl(TURN_ENDPOINT,{
        method:'POST',credentials:'same-origin',cache:'no-store',
        headers:{'content-type':'application/json'},
        body:JSON.stringify({room_id:room}),signal,
      });
      if(!response.ok){
        retryAt=now()+(response.status===404?TURN_OFF_RETRY_MS:TURN_FAILURE_RETRY_MS);
        return null;
      }
      const payload=await response.json();
      const relay=relayServersFrom(payload,now());
      if(!relay) retryAt=now()+(payload?.relay==='none'?TURN_PAUSED_RETRY_MS:TURN_FAILURE_RETRY_MS);
      return relay;
    }catch{
      retryAt=now()+TURN_FAILURE_RETRY_MS;
      return null;
    }
  }

  // A hard deadline: even a fetch that ignores its abort signal cannot hold
  // the call past `timeoutMs`.
  async function request(room){
    const controller=new AbortController();
    let timer;
    const deadline=new Promise(resolve=>{ timer=setTimeout(()=>{ controller.abort(); resolve(false); },timeoutMs); });
    try{
      const result=await Promise.race([attempt(room,controller.signal),deadline]);
      if(result===false){ retryAt=now()+TURN_FAILURE_RETRY_MS; return null; }
      return result;
    }finally{ clearTimeout(timer); }
  }

  function peek(room){
    if(typeof room!=='string'||!room) return stun();
    if(cached?.room===room&&cached.expiresAtMs-now()>TURN_REFRESH_MARGIN_MS) return [...stun(),...cached.servers];
    if(now()<retryAt) return stun();
    if(pending?.room!==room){
      const entry={room};
      entry.promise=request(room).then(relay=>{
        // A clear() while this was in flight wins: nothing is kept.
        if(pending!==entry) return stun();
        pending=null;
        if(!relay) return stun();
        cached={room,servers:relay.servers,expiresAtMs:relay.expiresAtMs};
        return [...stun(),...relay.servers];
      });
      pending=entry;
    }
    return pending.promise.then(list=>list.map(entry=>({...entry})));
  }

  async function servers(room){ return peek(room); }

  function create(room,key,make){
    if(slot&&slot.key===key) return slot.promise;
    const answer=peek(room);
    if(Array.isArray(answer)) return make(answer);
    const entry={key};
    entry.promise=answer.then(make).finally(()=>{ if(slot===entry) slot=null; });
    slot=entry;
    return entry.promise;
  }

  // Sign-out: forget the pass, any back-off and any pending creation.
  function clear(){ cached=null; pending=null; retryAt=0; slot=null; }

  return Object.freeze({peek,servers,create,clear});
}
