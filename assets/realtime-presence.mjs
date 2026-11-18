import * as Y from 'yjs';
import { applyAwarenessUpdate, Awareness, encodeAwarenessUpdate, removeAwarenessStates } from 'y-protocols/awareness';
import * as decoding from 'lib0/decoding';
import { RELAY_AWARENESS_LIMIT } from './realtime-relay.mjs';

// #462 / ID-100: pair-room presence and remote cursors. Awareness is the
// pinned y-protocols 1.0.6 wire format, carried only by the private relay;
// HTTPS supplies a coarse "partner online" fallback. Nothing here is durable.
export const PRESENCE_TTL_MS=15000;        // a silent remote peer disappears
export const PRESENCE_RENEW_MS=5000;       // local clock renewal (heartbeat)
export const PRESENCE_SWEEP_MS=1000;
export const PRESENCE_SEND_MS=200;         // at most five local broadcasts/s
export const PRESENCE_IDLE_MS=60000;
export const PRESENCE_MAX_PEERS=4;         // two seats, a spare tab each
export const PRESENCE_MAX_ENTRIES=4;
export const PRESENCE_FALLBACK_MS=5000;
export const PRESENCE_FALLBACK_RELAY_MS=15000;
const SEATS=new Set(['a','b']);
const STATUSES=new Set(['active','idle']);
const STATE_KEYS=['seat','sel','status','v'];
const MAX_CLIENT=0xffffffff;

const record=value=>!!value&&typeof value==='object'&&!Array.isArray(value);
const id=value=>record(value)&&Object.keys(value).length===2&&Number.isSafeInteger(value.client)
  &&value.client>=0&&value.client<=MAX_CLIENT&&Number.isSafeInteger(value.clock)&&value.clock>=0;

// Only Y.relativePositionToJSON's shape for the root `code` text is accepted:
// no nested type ids, no other roots, no extra fields.
export function validRelativePosition(value){
  if(!record(value)||value.tname!=='code'||!Object.keys(value).every(key=>['tname','item','assoc'].includes(key))) return false;
  if(Object.hasOwn(value,'item')&&!id(value.item)) return false;
  return !Object.hasOwn(value,'assoc')||value.assoc===0||value.assoc===-1;
}

export function validPresenceState(state){
  if(!record(state)||Object.keys(state).sort().join()!==STATE_KEYS.join()||state.v!==1
    ||!SEATS.has(state.seat)||!STATUSES.has(state.status)) return false;
  return state.sel===null||(record(state.sel)&&Object.keys(state.sel).sort().join()==='anchor,head'
    &&validRelativePosition(state.sel.anchor)&&validRelativePosition(state.sel.head));
}

// Decode the whole awareness update before it touches the live Awareness:
// bounded size and entry count, unique uint32 client ids, never our own id,
// and every non-null state in the exact presence schema.
export function parseAwarenessUpdate(update,{localClientId}={}){
  if(!(update instanceof Uint8Array)||!update.byteLength||update.byteLength>RELAY_AWARENESS_LIMIT) return null;
  try{
    const decoder=decoding.createDecoder(update);
    const count=decoding.readVarUint(decoder);
    if(!Number.isSafeInteger(count)||count<1||count>PRESENCE_MAX_ENTRIES) return null;
    const entries=[],ids=new Set();
    for(let index=0;index<count;index+=1){
      const clientID=decoding.readVarUint(decoder),clock=decoding.readVarUint(decoder);
      const state=JSON.parse(decoding.readVarString(decoder));
      if(!Number.isSafeInteger(clientID)||clientID>MAX_CLIENT||clientID===localClientId||ids.has(clientID)
        ||!Number.isSafeInteger(clock)||(state!==null&&!validPresenceState(state))) return null;
      ids.add(clientID); entries.push({clientID,clock,state});
    }
    return decoding.hasContent(decoder)?null:entries;
  }catch{ return null; }
}

function absolute(doc,text,position){
  try{
    const result=Y.createAbsolutePositionFromRelativePosition(Y.createRelativePositionFromJSON(position),doc);
    return result&&result.type===text?Math.max(0,Math.min(result.index,text.length)):null;
  }catch{ return null; }
}

export function createPresenceSession({doc,text,seat,send,onChange=()=>{},now=Date.now,
  setTimer=setTimeout,clearTimer=clearTimeout}={}){
  if(!doc||!text||!SEATS.has(seat)||typeof send!=='function') throw new TypeError('invalid presence session');
  const awareness=new Awareness(doc);
  // The class's own 3 s interval uses wall-clock time; this session owns
  // renewal/expiry on injectable timers instead (pinned 1.0.6 field).
  clearInterval(awareness._checkInterval);
  const seenAt=new Map(),removedAt=new Map();
  let destroyed=false,closing=false,connected=false,lastSent=-Infinity,sendTimer=null,renewTimer=null,sweepTimer=null;
  let lastActivity=now(),selectionKey='null',partnerLeftAt=0;
  awareness.setLocalState({v:1,seat,status:'active',sel:null});
  const flush=()=>{
    sendTimer=null;
    if(closing||!connected) return;
    lastSent=now();
    try{ send(encodeAwarenessUpdate(awareness,[awareness.clientID])); }catch{}
  };
  // Coalesce: the newest local state wins and goes out at most every 200 ms.
  const queueSend=(immediate=false)=>{
    if(closing||!connected||sendTimer!==null) return;
    const wait=immediate?0:Math.max(0,PRESENCE_SEND_MS-(now()-lastSent));
    sendTimer=setTimer(flush,wait);
  };
  awareness.on('update',(_change,origin)=>{ if(origin==='local') queueSend(); });
  awareness.on('change',({added,removed})=>{
    if(closing) return;
    for(const clientID of removed) if(clientID!==awareness.clientID){ seenAt.delete(clientID); removedAt.set(clientID,now()); }
    // A newcomer has none of our state yet: answer once, still throttled.
    if(added.some(clientID=>clientID!==awareness.clientID)) queueSend(true);
    onChange();
  });
  const renew=()=>{
    renewTimer=null;
    if(destroyed) return;
    awareness.setLocalState({...awareness.getLocalState()}); // clock+1 → broadcast
    renewTimer=setTimer(renew,PRESENCE_RENEW_MS);
  };
  const sweep=()=>{
    sweepTimer=null;
    if(destroyed) return;
    const time=now(),expired=[];
    for(const [clientID,at] of seenAt) if(time-at>PRESENCE_TTL_MS) expired.push(clientID);
    if(expired.length) removeAwarenessStates(awareness,expired,'timeout');
    // Forget clocks of long-gone peers so churn cannot grow the meta map.
    for(const [clientID,at] of removedAt) if(time-at>PRESENCE_TTL_MS){ removedAt.delete(clientID); awareness.meta.delete(clientID); }
    const local=awareness.getLocalState();
    if(local?.status==='active'&&time-lastActivity>PRESENCE_IDLE_MS) awareness.setLocalStateField('status','idle');
    sweepTimer=setTimer(sweep,PRESENCE_SWEEP_MS);
  };
  renewTimer=setTimer(renew,PRESENCE_RENEW_MS);
  sweepTimer=setTimer(sweep,PRESENCE_SWEEP_MS);
  const clearRemote=origin=>{
    const remote=[...awareness.states.keys()].filter(clientID=>clientID!==awareness.clientID);
    if(remote.length) removeAwarenessStates(awareness,remote,origin);
  };
  return {
    get clientID(){ return awareness.clientID; },
    get connected(){ return connected&&!destroyed; },
    receive(update){
      if(destroyed||!connected) return false;
      const entries=parseAwarenessUpdate(update,{localClientId:awareness.clientID});
      if(!entries) return false;
      for(const {clientID,state} of entries){
        // Unknown clients must arrive with a state (no meta for phantom
        // removals) and cannot exceed the peer cap.
        if(!awareness.states.has(clientID)&&(state===null
          ||awareness.states.size-1>=PRESENCE_MAX_PEERS)) return false;
      }
      const before=new Map(entries.map(({clientID})=>[clientID,awareness.meta.get(clientID)?.clock??-1]));
      const time=now();
      // An explicit, newer null state is the partner closing/hiding/leaving
      // the room. Record it first: the awareness change event renders.
      if(entries.some(({clientID,clock,state})=>state===null&&clock>before.get(clientID)
        &&awareness.states.get(clientID)?.seat!==seat)) partnerLeftAt=time;
      try{ applyAwarenessUpdate(awareness,update,'relay'); }catch{ return false; }
      // Only a strictly newer clock renews the TTL: a replayed frame cannot
      // keep a departed peer alive.
      for(const {clientID,clock,state} of entries){
        if(state!==null&&clock>before.get(clientID)&&awareness.states.has(clientID)) seenAt.set(clientID,time);
      }
      return true;
    },
    connection(value){
      if(destroyed) return;
      connected=value===true;
      if(connected){ lastSent=-Infinity; queueSend(true); }
      else{
        if(sendTimer!==null){ clearTimer(sendTimer); sendTimer=null; }
        clearRemote('disconnect'); // no stale cursors while the relay is down
      }
    },
    setSelection(anchorIndex,headIndex){
      if(destroyed) return;
      lastActivity=now();
      let sel=null;
      if(Number.isSafeInteger(anchorIndex)&&Number.isSafeInteger(headIndex)){
        const clamp=value=>Math.max(0,Math.min(value,text.length));
        sel={anchor:Y.relativePositionToJSON(Y.createRelativePositionFromTypeIndex(text,clamp(anchorIndex))),
          head:Y.relativePositionToJSON(Y.createRelativePositionFromTypeIndex(text,clamp(headIndex)))};
      }
      const key=JSON.stringify(sel),local=awareness.getLocalState();
      if(key===selectionKey&&local?.status==='active') return;
      selectionKey=key;
      awareness.setLocalState({...local,status:'active',sel});
    },
    activity(){
      if(destroyed) return;
      lastActivity=now();
      if(awareness.getLocalState()?.status==='idle') awareness.setLocalStateField('status','active');
    },
    // The freshest remote peer on the other seat; another tab of our own seat
    // is never reported as the partner.
    partner(){
      if(destroyed) return null;
      let best=null;
      for(const [clientID,state] of awareness.states){
        if(clientID===awareness.clientID||!validPresenceState(state)||state.seat===seat) continue;
        const at=seenAt.get(clientID)??0;
        if(!best||at>best.at) best={clientID,at,state};
      }
      if(!best) return null;
      const anchor=best.state.sel?absolute(doc,text,best.state.sel.anchor):null;
      const head=best.state.sel?absolute(doc,text,best.state.sel.head):null;
      return {clientID:best.clientID,status:best.state.status,
        selection:anchor===null||head===null?null:{anchor,head}};
    },
    get partnerLeftAt(){ return partnerLeftAt; },
    get size(){ return {states:awareness.states.size,meta:awareness.meta.size}; },
    destroy(){
      if(destroyed) return;
      closing=true;
      for(const timer of [sendTimer,renewTimer,sweepTimer]) if(timer!==null) clearTimer(timer);
      sendTimer=renewTimer=sweepTimer=null;
      // Announce departure with an incremented clock before the socket closes.
      awareness.setLocalState(null);
      if(connected){ try{ send(encodeAwarenessUpdate(awareness,[awareness.clientID]),{final:true}); }catch{} }
      destroyed=true; connected=false;
      awareness.destroy();
      seenAt.clear(); removedAt.clear();
    },
  };
}

// Coarse HTTPS fallback: one tiny authenticated POST per interval; the
// server's keyed TTL row is the only state. `leave` is fire-and-forget.
export function createFallbackPresence({request,onChange=()=>{},relayConnected=()=>false,now=Date.now,
  setTimer=setTimeout,clearTimer=clearTimeout}={}){
  let stopped=false,timer=null,controller=null,seat=null,partnerOnline=null,healthy=null,expiresAt=0,lastSuccessAt=0;
  const schedule=delay=>{ if(!stopped){ if(timer!==null) clearTimer(timer); timer=setTimer(beat,delay); } };
  const beat=async()=>{
    timer=null;
    if(stopped||controller) return;
    controller=new AbortController(); const active=controller;
    const timeout=setTimer(()=>active.abort(),5000);
    let delay=relayConnected()?PRESENCE_FALLBACK_RELAY_MS:PRESENCE_FALLBACK_MS;
    try{
      const response=await request('online',active.signal);
      if(stopped) return;
      const data=await response.json().catch(()=>null);
      if(stopped) return;
      if(response.status===401||response.status===404){ stop({leave:false,unavailable:true}); return; }
      if(response.status===429){
        const retry=Number(response.headers?.get?.('retry-after'));
        delay=Math.max(delay,Math.min(60000,(Number.isFinite(retry)&&retry>0?retry:30)*1000));
        throw new Error('presence rate limited');
      }
      if(!response.ok||data?.ok!==true||!SEATS.has(data.seat)||typeof data.partner_online!=='boolean'
        ||!Number.isSafeInteger(data.ttl_seconds)||data.ttl_seconds<1||data.ttl_seconds>120) throw new Error('presence unavailable');
      if(seat!==null&&seat!==data.seat) throw new Error('presence seat changed');
      seat=data.seat; partnerOnline=data.partner_online; healthy=true; lastSuccessAt=now(); expiresAt=lastSuccessAt+data.ttl_seconds*1000;
    }catch{
      if(stopped) return;
      healthy=false;
      // A last-known "online" is only as good as the server TTL behind it.
      if(partnerOnline!==null&&now()>=expiresAt) partnerOnline=null;
    }finally{
      clearTimer(timeout); if(controller===active) controller=null;
    }
    if(!stopped){ onChange(); schedule(delay); }
  };
  const stop=({leave=true,unavailable=false}={})=>{
    if(stopped) return;
    stopped=true; controller?.abort(); controller=null;
    if(timer!==null) clearTimer(timer); timer=null;
    if(leave&&seat!==null){ try{ Promise.resolve(request('leave',null,{keepalive:true})).catch(()=>{}); }catch{} }
    if(unavailable) onChange({unavailable:true});
  };
  return {
    start(){ schedule(0); },
    stop,
    nudge(){ if(!stopped&&!controller) schedule(0); },
    get seat(){ return seat; },
    get partnerOnline(){ return stopped?null:partnerOnline; },
    get healthy(){ return healthy; },
    get lastSuccessAt(){ return lastSuccessAt; },
    get stopped(){ return stopped; },
  };
}
