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
 * One in-memory source of ICE servers for the direct call. `servers(room)`
 * always resolves (never rejects) to STUN `base` plus any relay servers.
 */
export function createIceServerSource(base,{fetchImpl=(...args)=>globalThis.fetch(...args),now=()=>Date.now(),timeoutMs=TURN_TIMEOUT_MS}={}){
  const stun=()=>base.map(entry=>({...entry}));
  let cached=null,pending=null,retryAt=0;

  async function request(room){
    const controller=new AbortController();
    const timer=setTimeout(()=>controller.abort(),timeoutMs);
    try{
      const response=await fetchImpl(TURN_ENDPOINT,{
        method:'POST',credentials:'same-origin',cache:'no-store',
        headers:{'content-type':'application/json'},
        body:JSON.stringify({room_id:room}),signal:controller.signal,
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
    }finally{ clearTimeout(timer); }
  }

  async function servers(room){
    if(typeof room!=='string'||!room) return stun();
    if(cached?.room===room&&cached.expiresAtMs-now()>TURN_REFRESH_MARGIN_MS) return [...stun(),...cached.servers];
    if(now()<retryAt) return stun();
    if(pending?.room!==room){
      const entry={room};
      entry.promise=request(room).then(relay=>{
        // A clear() while this was in flight wins: nothing is kept.
        if(pending!==entry) return null;
        pending=null;
        if(relay) cached={room,servers:relay.servers,expiresAtMs:relay.expiresAtMs};
        return relay;
      });
      pending=entry;
    }
    const relay=await pending.promise;
    return relay?[...stun(),...relay.servers]:stun();
  }

  // Sign-out: forget the pass and any back-off.
  function clear(){ cached=null; pending=null; retryAt=0; }

  return Object.freeze({servers,clear});
}
