import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as Y from 'yjs';
import { createCodeRelay, decodeRelayMessage, encodeRelayBytes, openPrivateRelay, relayConfigurationValid,
  RELAY_BATCH_MS, RELAY_FRAME_LIMIT, RELAY_MESSAGES_PER_SECOND, RELAY_UPDATE_LIMIT } from '../../assets/realtime-relay.mjs';
import { applyValidatedRelayUpdate } from '../../assets/realtime-yjs.mjs';
import { fakeRelayClock, mockRelayConfiguration, mockRelaySockets, settleRelayPromises } from '../support/realtime-relay.mjs';

const room='week_10_pair_20';
const sender='a'.repeat(32);
const packet=(bytes,seq=1,nonce=sender)=>({sender:nonce,seq,update:encodeRelayBytes(bytes)});
const response=(config,status=200,retryAfter=null)=>({ok:status===200,status,json:async()=>config,headers:{get:()=>retryAfter}});
const delta=(doc,edit)=>{ const vector=Y.encodeStateVector(doc); edit(doc.getText('code')); return Y.encodeStateAsUpdate(doc,vector); };

function fixture(options={}){
  const clock=fakeRelayClock(); const transport=mockRelaySockets({clock,...options});
  const received=[]; let fallback=0,current=true,calls=0;
  const relay=createCodeRelay({identity:{room},mergeUpdates:Y.mergeUpdates,...clock,WebSocketCtor:transport.Socket,
    fetchToken:async()=>{ calls+=1; return response(mockRelayConfiguration(room,clock)); },
    onUpdate:bytes=>received.push(bytes),onFallback:()=>fallback+=1,isCurrent:()=>current,
    randomBytes:()=>new Uint8Array(16).fill(7),...options});
  return {...clock,...transport,relay,received,get fallback(){ return fallback; },get calls(){ return calls; },setCurrent:value=>current=value};
}
async function join(item){ await item.relay.start(); item.advance(30); await settleRelayPromises(); assert.equal(item.relay.connected,true); }

test('relay payloads contain only canonical bounded base64, a nonce and positive safe monotonic sequence',()=>{
  assert.deepEqual(decodeRelayMessage(packet(new Uint8Array([1,2,3]))),new Uint8Array([1,2,3]));
  assert.equal(encodeRelayBytes(new Uint8Array(40000)).length,Math.ceil(40000/3)*4);
  for(const value of [null,[],{}, {...packet(new Uint8Array([1])),extra:'code'},
    {...packet(new Uint8Array([1])),sender:'user@example.test'}, {...packet(new Uint8Array([1])),seq:0},
    {...packet(new Uint8Array([1])),seq:1.1}, {...packet(new Uint8Array([1])),seq:Number.MAX_SAFE_INTEGER+1},
    {...packet(new Uint8Array([1])),update:''}, {...packet(new Uint8Array([1])),update:'AB=='},
    {...packet(new Uint8Array([1])),update:'AAAA\n'}, {...packet(new Uint8Array([1])),update:42},
    packet(new Uint8Array(RELAY_UPDATE_LIMIT+1))]) assert.equal(decodeRelayMessage(value),null);
  assert.equal(decodeRelayMessage(packet(new Uint8Array(RELAY_UPDATE_LIMIT))).length,RELAY_UPDATE_LIMIT);
});

test('provider config must be same-authority room scoped, HTTPS Supabase, public-key-only and short lived',()=>{
  const clock=fakeRelayClock(),config=mockRelayConfiguration(room,clock),now=Math.floor(clock.now()/1000);
  assert.equal(relayConfigurationValid(config,room,now),true);
  for(const patch of [{ok:false},{topic:'other'},{topic:`rc-code:v1:week_11_pair_20:${'a'.repeat(64)}`},
    {token:null},{token:'x'.repeat(4097)},{token:'token with spaces'},{publishable_key:'sb_secret_bad'},
    {expires_at:now+301},{expires_at:now+30},{expires_at:'bad'}, {url:'http://relay-test.supabase.co'},
    {url:'https://elsewhere.test'},{url:'https://relay-test.supabase.co/path'}, {url:'https://user@relay-test.supabase.co'},
    {url:'https://relay-test.supabase.co?x=1'},{url:'https://relay-test.supabase.co#x'},{url:'bad'},
    {url:'https://relay-test.supabase.co:8443'}]) assert.equal(relayConfigurationValid({...config,...patch},room,now),false);
  assert.equal(relayConfigurationValid(null,room,now),false);
});

test('Phoenix v1 joins only a private broadcast channel, never puts the join JWT in its URL',async()=>{
  const item=fixture(); await join(item);
  const socket=item.sockets[0],url=new URL(socket.url),frame=socket.sent[0];
  assert.equal(url.protocol,'wss:'); assert.equal(url.pathname,'/realtime/v1/websocket');
  assert.equal(url.searchParams.get('vsn'),'1.0.0'); assert.equal(url.searchParams.get('access_token'),null);
  assert.equal(url.searchParams.get('apikey'),'sb_publishable_test_public_key_461');
  assert.equal(frame.event,'phx_join'); assert.equal(frame.ref,'1'); assert.equal(frame.join_ref,'1');
  assert.deepEqual(frame.payload.config,{broadcast:{ack:false,self:false},presence:{enabled:false,key:''},postgres_changes:[],private:true});
  assert.equal(frame.payload.access_token,'header.payload.signature');
  const doc=new Y.Doc(),update=delta(doc,text=>text.insert(0,'relay'));
  assert.equal(item.relay.send(update),true); item.advance(RELAY_BATCH_MS);
  const broadcast=socket.sent[1]; assert.equal(broadcast.event,'broadcast');
  assert.deepEqual(Object.keys(broadcast.payload.payload).sort(),['sender','seq','update']);
  assert.equal(broadcast.payload.payload.seq,1); assert.equal(broadcast.payload.event,'y-update');
  item.relay.stop(); item.relay.stop(); assert.equal(socket.closes,1); assert.equal(item.pending,0); doc.destroy();
});

test('keystroke→partner Yjs apply takes 80ms with mocked realtime and fake timers, before HTTPS/polling',async()=>{
  const clock=fakeRelayClock(),{Socket,sockets}=mockRelaySockets({clock,latency:30});
  const left=new Y.Doc(),right=new Y.Doc();
  const relay=nonce=>createCodeRelay({identity:{room},mergeUpdates:Y.mergeUpdates,...clock,WebSocketCtor:Socket,
    fetchToken:async()=>response(mockRelayConfiguration(room,clock)),randomBytes:()=>new Uint8Array(16).fill(nonce),
    isCurrent:()=>true,onFallback:()=>assert.fail('happy-path fallback'),onUpdate:update=>applyValidatedRelayUpdate(nonce===1?left:right,update,'relay')});
  const a=relay(1),b=relay(2); await Promise.all([a.start(),b.start()]); clock.advance(30);
  const started=clock.now(); const update=delta(left,text=>text.insert(0,'const instant = true;'));
  assert.equal(a.send(update),true); clock.advance(49); assert.equal(right.getText('code').toString(),'');
  clock.advance(1); assert.equal(right.getText('code').toString(),''); clock.advance(30);
  assert.equal(right.getText('code').toString(),'const instant = true;');
  assert.equal(clock.now()-started,80); assert.ok(clock.now()-started<1000);
  assert.equal(sockets[1].sent.filter(frame=>frame.event==='broadcast').length,0,'applying does not echo');
  a.stop(); b.stop(); left.destroy(); right.destroy();
});

test('Yjs relay rejects corrupt/rich/extra-root/oversized updates without changing the live document',()=>{
  const doc=new Y.Doc(); doc.getText('code').insert(0,'base');
  const bad=[new Uint8Array([255]),new Uint8Array(RELAY_UPDATE_LIMIT+1),new Uint8Array(),[],null];
  const extra=new Y.Doc(); extra.getMap('hidden').set('value','secret'); bad.push(Y.encodeStateAsUpdate(extra));
  const rich=new Y.Doc(); rich.getText('code').insert(0,'styled',{bold:true}); bad.push(Y.encodeStateAsUpdate(rich));
  const large=new Y.Doc(); large.getText('code').insert(0,'x'.repeat(20*1024)); bad.push(Y.encodeStateAsUpdate(large));
  for(const update of bad){ assert.equal(applyValidatedRelayUpdate(doc,update,'relay'),false); assert.equal(doc.getText('code').toString(),'base'); }
  const valid=new Y.Doc(); valid.getText('code').insert(0,'peer');
  assert.equal(applyValidatedRelayUpdate(doc,Y.encodeStateAsUpdate(valid),'relay'),true);
  assert.ok(doc.getText('code').toString().includes('peer'));
  for(const item of [doc,extra,rich,large,valid]) item.destroy();
});

test('reordered/dependent and concurrent/offline Yjs updates merge idempotently without loss',async()=>{
  const item=fixture(); await join(item);
  const receiver=new Y.Doc(),offline=new Y.Doc(),local=new Y.Doc();
  const one=delta(offline,text=>text.insert(0,'A')),two=delta(offline,text=>text.insert(1,'B'));
  const own=delta(local,text=>text.insert(0,'C')); Y.applyUpdate(receiver,own);
  const socket=item.sockets[0],topic=socket.topic;
  for(const value of [packet(two,2),packet(one,1),packet(one,1),packet(two,2)]) socket.deliver({topic,event:'broadcast',payload:{type:'broadcast',event:'y-update',payload:value}});
  assert.equal(item.received.length,2,'duplicate sequence dropped but old dependent sequence retained');
  for(const update of item.received) assert.equal(applyValidatedRelayUpdate(receiver,update,'relay'),true);
  assert.ok(receiver.getText('code').toString().includes('AB')); assert.ok(receiver.getText('code').toString().includes('C'));
  Y.applyUpdate(offline,own); assert.equal(receiver.getText('code').toString(),offline.getText('code').toString());
  item.relay.stop(); receiver.destroy(); offline.destroy(); local.destroy();
});

test('malformed, oversized, self-echo, foreign-topic and unknown events are ignored',async()=>{
  const item=fixture(); await join(item); const socket=item.sockets[0];
  const valid=packet(new Uint8Array([1,2,3]));
  const frame=payload=>({topic:socket.topic,event:'broadcast',payload:{type:'broadcast',event:'y-update',payload}});
  for(const value of ['not-json','x'.repeat(RELAY_FRAME_LIMIT+1),'[]','null',
    {...frame(valid),topic:'realtime:foreign'}, {...frame(valid),join_ref:'foreign'},
    {...frame(valid),event:'presence'}, {...frame(valid),payload:{event:'other',type:'broadcast',payload:valid}},
    frame({...valid,sender:'07070707070707070707070707070707'}),frame({...valid,seq:0})]) socket.deliver(value);
  socket.onmessage?.({data:new Uint8Array([1,2,3])});
  assert.equal(item.received.length,0); assert.equal(item.fallback,0);
  socket.deliver(frame(valid)); assert.equal(item.received.length,1);
  item.relay.stop();
});

test('outgoing edits coalesce at 50ms; oversized/invalid/buffered sends never grow a queue',async()=>{
  const item=fixture(); const doc=new Y.Doc();
  assert.equal(item.relay.send(new Uint8Array([1])),false); await join(item);
  assert.equal(item.relay.send(new Uint8Array()),false); assert.equal(item.relay.send(new Uint8Array(RELAY_UPDATE_LIMIT+1)),false);
  for(let index=0;index<10;index+=1) item.relay.send(delta(doc,text=>text.insert(text.length,'x')));
  item.advance(50); assert.equal(item.sockets[0].sent.filter(frame=>frame.event==='broadcast').length,1);
  const merged=item.sockets[0].sent[1].payload.payload;
  const peer=new Y.Doc(); Y.applyUpdate(peer,decodeRelayMessage(merged)); assert.equal(peer.getText('code').toString(),'xxxxxxxxxx');
  item.sockets[0].bufferedAmount=256*1024+1;
  item.relay.send(delta(doc,text=>text.insert(text.length,'y'))); item.advance(50);
  assert.equal(item.relay.connected,false); assert.equal(item.fallback,1);
  item.relay.stop(); peer.destroy(); doc.destroy();
});

test('receive rate and replay metadata are bounded even when a peer invents many senders',async()=>{
  const item=fixture(); await join(item); const socket=item.sockets[0];
  const deliver=value=>socket.deliver({topic:socket.topic,event:'broadcast',payload:{type:'broadcast',event:'y-update',payload:value}});
  for(let index=1;index<=40;index+=1) deliver(packet(new Uint8Array([1]),index));
  assert.equal(item.received.length,RELAY_MESSAGES_PER_SECOND);
  item.advance(1000);
  for(let index=1;index<=10;index+=1) deliver(packet(new Uint8Array([1]),1,index.toString(16).padStart(32,'0')));
  assert.equal(item.received.length,RELAY_MESSAGES_PER_SECOND+7,'up to eight sender replay windows');
  item.relay.stop();
});

test('token 404/429/503, invalid config, rejected JSON and network failure trigger HTTPS fallback without sockets',async()=>{
  for(const status of [404,429,503]){
    const clock=fakeRelayClock(),transport=mockRelaySockets({clock}); let fallback=0,calls=0;
    const relay=createCodeRelay({identity:{room},mergeUpdates:Y.mergeUpdates,...clock,WebSocketCtor:transport.Socket,isCurrent:()=>true,
      fetchToken:async()=>{ calls+=1; return response({},status,status===429?'60':null); },onUpdate:()=>{},onFallback:()=>fallback+=1});
    await relay.start(); assert.equal(fallback,1); assert.equal(transport.sockets.length,0);
    clock.advance(status===404?29999:status===429?59999:999); await settleRelayPromises(); assert.equal(calls,1);
    clock.advance(1); await settleRelayPromises(); assert.equal(calls,2);
    relay.stop(); assert.equal(clock.pending,0);
  }
  for(const fetchToken of [async()=>{ throw Error('offline'); },async()=>response({}),
    async()=>({ok:true,json:async()=>{ throw Error('bad JSON'); }})]){
    const item=fixture({fetchToken}); await item.relay.start(); assert.equal(item.fallback,1); assert.equal(item.sockets.length,0); item.relay.stop();
  }
});

test('connect failure, join refusal/timeout, socket close/error and protocol errors switch to fallback',async()=>{
  const throwing=fixture({WebSocketCtor:class{ constructor(){ throw Error('connect failed'); } }});
  await throwing.relay.start(); assert.equal(throwing.fallback,1); throwing.relay.stop();
  const timeout=fixture({autoOpen:false}); await timeout.relay.start(); timeout.advance(5000);
  assert.equal(timeout.fallback,1); assert.equal(timeout.sockets[0].closes,1); timeout.relay.stop();
  const denied=fixture({joinStatus:'error'}); await denied.relay.start(); denied.advance(30); assert.equal(denied.fallback,1); denied.relay.stop();
  for(const event of ['phx_close','phx_error','system','socket-close','socket-error']){
    const item=fixture(); await join(item); const socket=item.sockets[0];
    if(event==='socket-close') socket.close(); else if(event==='socket-error') socket.onerror?.();
    else socket.deliver({topic:socket.topic,event,payload:{status:'error'}});
    assert.equal(item.relay.connected,false); assert.equal(item.fallback,1,event); item.relay.stop();
  }
});

test('heartbeat detects a silent link; token renewal closes and reauthorizes instead of reusing a cached grant',async()=>{
  const item=fixture(); await join(item);
  item.advance(25000); assert.equal(item.sockets[0].sent.at(-1).event,'heartbeat');
  item.advance(30); assert.equal(item.relay.connected,true);
  // Drop heartbeat replies only; the next heartbeat detects the missing ack.
  item.sockets[0].send=function(raw){ this.sent.push(JSON.parse(raw)); };
  item.advance(25000); item.advance(25000); assert.equal(item.fallback,1); item.relay.stop();
  const renewal=fixture(); await join(renewal); renewal.advance(270000-30);
  assert.equal(renewal.relay.connected,false); assert.equal(renewal.fallback,1);
  renewal.advance(1000); await settleRelayPromises(); renewal.advance(30);
  assert.equal(renewal.calls,2); assert.equal(renewal.sockets.length,2); assert.equal(renewal.relay.connected,true);
  renewal.relay.stop();
});

test('a stop/context fence aborts token requests, pending batches and every reconnect/heartbeat timer',async()=>{
  let signal,resolve;
  const token=new Promise(ok=>{ resolve=ok; });
  const item=fixture({fetchToken:async input=>{ signal=input; return token; }});
  const start=item.relay.start(); assert.ok(signal); item.relay.stop(); assert.equal(signal.aborted,true);
  resolve(response(mockRelayConfiguration(room,item))); await start; assert.equal(item.sockets.length,0); assert.equal(item.pending,0);
  const current=fixture(); await join(current);
  const socket=current.sockets[0],late=socket.onmessage;
  current.relay.send(new Uint8Array([1])); current.setCurrent(false); current.relay.stop(); current.advance(300000);
  late({data:JSON.stringify({topic:socket.topic,event:'broadcast',payload:{type:'broadcast',event:'y-update',payload:packet(new Uint8Array([1]))}})});
  assert.equal(current.received.length,0); assert.equal(current.pending,0); assert.equal(current.calls,1);
});

test('transport send failure and non-OK heartbeat response fail closed exactly once',()=>{
  const clock=fakeRelayClock(),{Socket,sockets}=mockRelaySockets({clock}); let fails=0;
  const config=mockRelayConfiguration(room,clock);
  const channel=openPrivateRelay(config,{...clock,WebSocketCtor:Socket,onUnavailable:()=>fails+=1});
  assert.equal(channel.send(packet(new Uint8Array([1]))),false); clock.advance(30);
  assert.equal(channel.send({}),false);
  clock.advance(25000);
  const heartbeat=sockets[0].sent.at(-1);
  sockets[0].deliver({topic:'phoenix',event:'phx_reply',ref:heartbeat.ref,payload:{status:'error'}});
  assert.equal(fails,1); assert.equal(channel.joined,false); channel.close();
  const next=openPrivateRelay(config,{...clock,WebSocketCtor:Socket,onUnavailable:()=>fails+=1}); clock.advance(30);
  sockets[1].send=()=>{ throw Error('send failed'); };
  assert.equal(next.send(packet(new Uint8Array([1]))),false); assert.equal(fails,2); next.close();
});
