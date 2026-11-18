// Minimal Supabase Realtime Phoenix v1 broadcast-only transport. Wire shape
// checked against @supabase/realtime-js 2.15.4; no SDK/CDN, presence, REST
// broadcasts, database subscriptions, logger or token storage. This module is
// bundled with the pinned Yjs provider by build:crdt/check:crdt.
export const RELAY_UPDATE_LIMIT=64*1024;
export const RELAY_FRAME_LIMIT=Math.ceil(RELAY_UPDATE_LIMIT/3)*4+1024;
export const RELAY_MESSAGES_PER_SECOND=20;
export const RELAY_BATCH_MS=50;
const BASE64=/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
const NONCE=/^[a-f0-9]{32}$/;
const TOPIC=/^rc-code:v1:week_[1-9]\d*_pair_[1-9]\d*:[a-f0-9]{64}$/;

export function encodeRelayBytes(bytes){
  let binary='';
  for(let offset=0;offset<bytes.length;offset+=0x8000) binary+=String.fromCharCode(...bytes.subarray(offset,offset+0x8000));
  return btoa(binary);
}

export function decodeRelayMessage(message){
  if(!message||typeof message!=='object'||Array.isArray(message)||Object.keys(message).length!==3
    ||!NONCE.test(message.sender)||!Number.isSafeInteger(message.seq)||message.seq<1
    ||typeof message.update!=='string'||message.update.length<4
    ||message.update.length>Math.ceil(RELAY_UPDATE_LIMIT/3)*4||!BASE64.test(message.update)) return null;
  try{
    const binary=atob(message.update);
    if(!binary.length||binary.length>RELAY_UPDATE_LIMIT||btoa(binary)!==message.update) return null;
    return Uint8Array.from(binary,character=>character.charCodeAt(0));
  }catch{ return null; }
}

export function relayConfigurationValid(config,room,nowSeconds=Math.floor(Date.now()/1000)){
  if(!config||config.ok!==true||typeof config.topic!=='string'||!TOPIC.test(config.topic)
    ||!config.topic.startsWith(`rc-code:v1:${room}:`)||typeof config.token!=='string'
    ||config.token.length>4096||!/^[-\w]+\.[-\w]+\.[-\w]+$/.test(config.token)
    ||typeof config.publishable_key!=='string'||!/^sb_publishable_[A-Za-z0-9_-]{16,256}$/.test(config.publishable_key)
    ||!Number.isSafeInteger(config.expires_at)||config.expires_at<=nowSeconds+30||config.expires_at>nowSeconds+300) return false;
  try{
    const url=new URL(config.url);
    return url.protocol==='https:'&&/^[a-z0-9-]+\.supabase\.co$/.test(url.hostname)
      &&!url.port&&!url.username&&!url.password&&url.pathname==='/'&&!url.search&&!url.hash;
  }catch{ return false; }
}

export function openPrivateRelay(config,{WebSocketCtor=globalThis.WebSocket,onMessage,onJoined,onUnavailable,onRenew,
  setTimer=setTimeout,clearTimer=clearTimeout,now=Date.now}={}){
  const url=new URL('/realtime/v1/websocket',config.url); url.protocol='wss:';
  url.searchParams.set('apikey',config.publishable_key); url.searchParams.set('vsn','1.0.0');
  const socket=new WebSocketCtor(url.href),topic=`realtime:${config.topic}`;
  let closed=false,joined=false,ref=1,pendingHeartbeat=null;
  let joinTimer,heartbeatTimer,expiryTimer;
  const close=()=>{
    if(closed) return;
    closed=true; joined=false;
    for(const timer of [joinTimer,heartbeatTimer,expiryTimer]) clearTimer(timer);
    socket.onopen=null; socket.onmessage=null; socket.onerror=null; socket.onclose=null;
    try{ socket.close(1000); }catch{}
  };
  const fail=()=>{ if(closed) return; close(); onUnavailable?.(); };
  const push=(event,payload,{channelTopic=topic,reference=String(++ref),joinRef='1'}={})=>{
    if(closed||socket.readyState!==1||socket.bufferedAmount>256*1024) return false;
    try{ socket.send(JSON.stringify({topic:channelTopic,event,payload,ref:reference,join_ref:joinRef})); return true; }
    catch{ fail(); return false; }
  };
  const heartbeat=()=>{
    if(closed) return;
    if(pendingHeartbeat!==null){ fail(); return; }
    pendingHeartbeat=String(++ref);
    if(!push('heartbeat',{}, {channelTopic:'phoenix',reference:pendingHeartbeat,joinRef:null})){ fail(); return; }
    heartbeatTimer=setTimer(heartbeat,25000);
  };
  joinTimer=setTimer(fail,5000);
  expiryTimer=setTimer(()=>{
    if(closed) return;
    close(); onRenew?.(); // planned fresh authorization, not a failure/backoff
  },Math.max(0,config.expires_at*1000-now()-30000));
  socket.onopen=()=>{
    if(!push('phx_join',{config:{broadcast:{ack:false,self:false},presence:{enabled:false,key:''},
      postgres_changes:[],private:true},access_token:config.token},{reference:'1'})) fail();
  };
  socket.onmessage=event=>{
    if(closed||typeof event.data!=='string'||event.data.length>RELAY_FRAME_LIMIT) return;
    let message; try{ message=JSON.parse(event.data); }catch{ return; }
    if(!message||typeof message!=='object'||Array.isArray(message)) return;
    if(pendingHeartbeat!==null&&message.topic==='phoenix'&&message.event==='phx_reply'&&message.ref===pendingHeartbeat){
      if(message.payload?.status!=='ok'){ fail(); return; }
      pendingHeartbeat=null; return;
    }
    if(message.topic!==topic||(message.join_ref!=null&&message.join_ref!=='1')) return;
    if(message.event==='phx_reply'&&message.ref==='1'&&!joined){
      if(message.payload?.status!=='ok'){ fail(); return; }
      clearTimer(joinTimer); joined=true;
      heartbeatTimer=setTimer(heartbeat,25000); onJoined?.();
    }else if(message.event==='phx_error'||message.event==='phx_close'
      ||(message.event==='system'&&message.payload?.status==='error')) fail();
    else if(joined&&message.event==='broadcast'&&message.payload?.type==='broadcast'
      &&message.payload.event==='y-update') onMessage?.(message.payload.payload);
  };
  socket.onerror=fail; socket.onclose=fail;
  return {close,get joined(){ return joined&&!closed; },send(payload){
    if(!joined||!decodeRelayMessage(payload)) return false;
    const sent=push('broadcast',{type:'broadcast',event:'y-update',payload});
    if(!sent) fail();
    return sent;
  }};
}

export function createCodeRelay({identity,fetchToken,mergeUpdates,onUpdate,onFallback,isCurrent,
  WebSocketCtor=globalThis.WebSocket,setTimer=setTimeout,clearTimer=clearTimeout,now=Date.now,
  randomBytes=()=>crypto.getRandomValues(new Uint8Array(16))}={}){
  const sender=Array.from(randomBytes(),byte=>byte.toString(16).padStart(2,'0')).join('');
  let stopped=false,channel=null,controller=null,retryTimer=null,batchTimer=null,pending=[],seq=0;
  let retryMs=1000,receiveWindow=0,receiveCount=0,sendWindow=0,sendCount=0;
  const seen=new Map();
  const current=()=>!stopped&&isCurrent();
  const received=message=>{
    if(!current()) return;
    const second=Math.floor(now()/1000);
    if(second!==receiveWindow){ receiveWindow=second; receiveCount=0; }
    if(++receiveCount>RELAY_MESSAGES_PER_SECOND) return;
    const bytes=decodeRelayMessage(message);
    if(!bytes||message.sender===sender) return;
    let sequences=seen.get(message.sender);
    if(!sequences){ if(seen.size>=8) return; sequences=new Set(); seen.set(message.sender,sequences); }
    if(sequences.has(message.seq)) return;
    // Sequence is replay metadata, not authorization or a Yjs delivery-order
    // guard: reordered dependent updates must still be applied without loss.
    sequences.add(message.seq);
    if(sequences.size>256) sequences.delete(sequences.values().next().value);
    try{ onUpdate(bytes); }catch{} // invalid Yjs is rejected by the provider
  };
  const unavailable=(delay=retryMs)=>{
    channel?.close(); channel=null; pending=[];
    if(batchTimer!==null) clearTimer(batchTimer); batchTimer=null;
    if(!current()||retryTimer!==null) return;
    onFallback();
    retryTimer=setTimer(()=>{ retryTimer=null; connect(); },delay);
    retryMs=Math.min(30000,retryMs*2);
  };
  const connect=async()=>{
    if(!current()||controller||channel) return;
    controller=new AbortController(); const active=controller;
    const timeout=setTimer(()=>active.abort(),5000);
    try{
      const response=await fetchToken(active.signal);
      if(!current()) return;
      const config=await response.json();
      if(!current()) return;
      if(!response.ok||!relayConfigurationValid(config,identity.room,Math.floor(now()/1000))){
        // A missing/disabled/denied endpoint never changes durable authority.
        // Avoid hammering 404/429; HTTPS polling continues independently.
        const retryAfter=Number(response.headers?.get?.('retry-after'));
        const delay=response.status===404?30000:response.status===429
          ?Math.max(1000,Math.min(300000,(Number.isFinite(retryAfter)&&retryAfter>0?retryAfter:30)*1000)):retryMs;
        unavailable(delay); return;
      }
      channel=openPrivateRelay(config,{WebSocketCtor,setTimer,clearTimer,now,onMessage:received,
        onJoined:()=>{ retryMs=1000; },onUnavailable:()=>unavailable(),onRenew:()=>{
          channel=null; pending=[];
          if(batchTimer!==null) clearTimer(batchTimer); batchTimer=null;
          if(current()) connect(); // no extra reconcile, delay or backoff increase
        }});
    }catch{ if(current()) unavailable(); }
    finally{ clearTimer(timeout); if(controller===active) controller=null; }
  };
  const flush=()=>{
    batchTimer=null;
    if(!current()||!channel?.joined){ pending=[]; return; }
    const updates=pending; pending=[];
    if(!updates.length) return;
    const second=Math.floor(now()/1000);
    if(second!==sendWindow){ sendWindow=second; sendCount=0; }
    if(++sendCount>RELAY_MESSAGES_PER_SECOND) return;
    try{
      const bytes=updates.length===1?updates[0]:mergeUpdates(updates);
      if(bytes.length>RELAY_UPDATE_LIMIT||seq>=Number.MAX_SAFE_INTEGER) return;
      if(!channel.send({sender,seq:++seq,update:encodeRelayBytes(bytes)})) unavailable();
    }catch{} // HTTPS queue already owns every skipped/oversized update
  };
  const relay={
    start:connect,
    send(bytes){
      if(!current()||!channel?.joined||!bytes?.length||bytes.length>RELAY_UPDATE_LIMIT) return false;
      // At most one 64-KiB coalesced update retained; never an unbounded socket queue.
      try{
        const merged=pending.length?mergeUpdates([...pending,bytes]):bytes;
        if(merged.length>RELAY_UPDATE_LIMIT) return false;
        pending=[merged];
      }catch{ return false; }
      if(batchTimer===null) batchTimer=setTimer(flush,RELAY_BATCH_MS);
      return true;
    },
    stop(){
      stopped=true; controller?.abort(); controller=null;
      channel?.close(); channel=null; pending=[]; seen.clear();
      clearTimer(retryTimer); clearTimer(batchTimer); retryTimer=null; batchTimer=null;
    },
    get connected(){ return current()&&channel?.joined===true; },
  };
  return relay;
}
