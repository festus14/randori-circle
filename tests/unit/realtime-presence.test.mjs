import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as Y from 'yjs';
import { Awareness, encodeAwarenessUpdate } from 'y-protocols/awareness';
import * as encoding from 'lib0/encoding';
import { createCodeRelay, decodeAwarenessMessage, encodeRelayBytes, RELAY_AWARENESS_EVENT,
  RELAY_AWARENESS_LIMIT, RELAY_AWARENESS_PER_SECOND } from '../../assets/realtime-relay.mjs';
import { createFallbackPresence, createPresenceSession, parseAwarenessUpdate, PRESENCE_FALLBACK_MS,
  PRESENCE_FALLBACK_RELAY_MS, PRESENCE_IDLE_MS, PRESENCE_MAX_PEERS, PRESENCE_RENEW_MS, PRESENCE_SEND_MS,
  PRESENCE_TTL_MS, validPresenceState, validRelativePosition } from '../../assets/realtime-presence.mjs';
import { fakeRelayClock, mockRelayConfiguration, mockRelaySockets, settleRelayPromises as settleRelay } from '../support/realtime-relay.mjs';

const settleRelayPromises=async()=>{ for(let index=0;index<4;index+=1) await settleRelay(); };

const room='week_10_pair_20';
const response=(config,status=200)=>({ok:status===200,status,json:async()=>config,headers:{get:()=>null}});

function encodeEntries(entries){
  const encoder=encoding.createEncoder();
  encoding.writeVarUint(encoder,entries.length);
  for(const {clientID,clock,state} of entries){
    encoding.writeVarUint(encoder,clientID); encoding.writeVarUint(encoder,clock);
    encoding.writeVarString(encoder,typeof state==='string'?state:JSON.stringify(state));
  }
  return encoding.toUint8Array(encoder);
}

function documentPair(){
  const left=new Y.Doc(),right=new Y.Doc();
  left.getText('code').insert(0,'function solve(){\n  return 42;\n}\n');
  Y.applyUpdate(right,Y.encodeStateAsUpdate(left));
  return {left,right};
}

// Two presence sessions wired directly (no relay) with fake timers.
function directPair(){
  const clock=fakeRelayClock(),{left,right}=documentPair(),sent={a:[],b:[]};
  let sessions;
  const make=(doc,seat,other)=>createPresenceSession({doc,text:doc.getText('code'),seat,...clock,
    send:bytes=>{ sent[seat].push(bytes); return sessions[other].receive(bytes); }});
  sessions={b:null,a:null};
  sessions.a=make(left,'a','b'); sessions.b=make(right,'b','a');
  return {clock,left,right,sent,sessions};
}

const position={tname:'code',item:{client:1,clock:2},assoc:0};

test('presence states accept only the bounded root-text cursor schema',()=>{
  assert.equal(validRelativePosition(position),true);
  assert.equal(validRelativePosition({tname:'code'}),true);
  assert.equal(validRelativePosition({tname:'code',assoc:-1}),true);
  for(const value of [null,[],{tname:'other'},{...position,type:{client:1,clock:1}},{...position,assoc:2},
    {...position,item:{client:-1,clock:0}},{...position,item:{client:2**32,clock:0}},{...position,item:{client:1}},
    {...position,item:{client:1,clock:1,extra:1}},{...position,name:'Two'}]) assert.equal(validRelativePosition(value),false);
  const state={v:1,seat:'a',status:'active',sel:{anchor:position,head:position}};
  assert.equal(validPresenceState(state),true);
  assert.equal(validPresenceState({...state,sel:null}),true);
  for(const value of [null,{},{...state,v:2},{...state,seat:'c'},{...state,status:'typing'},{...state,name:'Two'},
    {...state,email:'two@example.test'},{...state,sel:{anchor:position}},{...state,sel:{anchor:position,head:{tname:'x'}}},
    {v:1,seat:'a',status:'active'}]) assert.equal(validPresenceState(value),false);
});

test('awareness updates are decoded fully, bounded and never claim the local client',()=>{
  const state={v:1,seat:'b',status:'idle',sel:null};
  assert.deepEqual(parseAwarenessUpdate(encodeEntries([{clientID:7,clock:3,state}]),{localClientId:1}),[{clientID:7,clock:3,state}]);
  assert.deepEqual(parseAwarenessUpdate(encodeEntries([{clientID:7,clock:4,state:null}])),[{clientID:7,clock:4,state:null}]);
  const many=Array.from({length:5},(_,index)=>({clientID:index+2,clock:1,state}));
  const trailing=new Uint8Array([...encodeEntries([{clientID:7,clock:1,state}]),0]);
  for(const bytes of [new Uint8Array(),new Uint8Array(RELAY_AWARENESS_LIMIT+1),encodeEntries([]),encodeEntries(many),
    encodeEntries([{clientID:1,clock:1,state}]),encodeEntries([{clientID:7,clock:1,state},{clientID:7,clock:2,state}]),
    encodeEntries([{clientID:2**32,clock:1,state}]),encodeEntries([{clientID:7,clock:1,state:'{bad'}]),
    encodeEntries([{clientID:7,clock:1,state:{...state,name:'Two'}}]),trailing,new Uint8Array([1,7]),'not-bytes'])
    assert.equal(parseAwarenessUpdate(bytes,{localClientId:1}),null);
  // The production encoder is wire-compatible with this validator.
  const doc=new Y.Doc(),awareness=new Awareness(doc);
  awareness.setLocalState({v:1,seat:'a',status:'active',sel:null});
  assert.equal(parseAwarenessUpdate(encodeAwarenessUpdate(awareness,[doc.clientID]))?.[0].state.seat,'a');
  awareness.destroy(); doc.destroy();
});

test('connected peers exchange cursor anchors as relative positions that survive concurrent edits',()=>{
  const {clock,left,right,sessions}=directPair();
  sessions.a.connection(true); sessions.b.connection(true); clock.advance(0);
  assert.equal(sessions.a.partner()?.status,'active'); assert.equal(sessions.b.partner()?.selection,null);
  const offset=left.getText('code').toString().indexOf('42');
  sessions.a.setSelection(offset,offset+2); clock.advance(PRESENCE_SEND_MS);
  assert.deepEqual(sessions.b.partner().selection,{anchor:offset,head:offset+2});
  // Partner text inserted before the anchor shifts it; local editing is untouched.
  right.getText('code').insert(0,'// header\n');
  assert.deepEqual(sessions.b.partner().selection,{anchor:offset+10,head:offset+12});
  // Backward selection keeps anchor/head direction.
  sessions.a.setSelection(offset+2,offset); clock.advance(PRESENCE_SEND_MS);
  assert.deepEqual(sessions.b.partner().selection,{anchor:offset+12,head:offset+10});
  for(const session of Object.values(sessions)) session.destroy();
  left.destroy(); right.destroy();
});

test('local broadcasts are coalesced to at most one per 200 ms and renewed every five seconds',()=>{
  const {clock,sent,sessions}=directPair();
  sessions.a.connection(true); sessions.b.connection(true); clock.advance(0);
  const before=sent.a.length;
  for(let index=0;index<50;index+=1){ sessions.a.setSelection(index%10,index%10); clock.advance(10); }
  assert.ok(sent.a.length-before<=Math.ceil(500/PRESENCE_SEND_MS)+1,`sent ${sent.a.length-before}`);
  // Unchanged selections do not broadcast.
  const settled=(clock.advance(PRESENCE_SEND_MS),sent.a.length);
  sessions.a.setSelection(9,9); clock.advance(PRESENCE_SEND_MS);
  assert.equal(sent.a.length,settled);
  clock.advance(PRESENCE_RENEW_MS); assert.ok(sent.a.length>settled,'heartbeat renews the clock');
  for(const session of Object.values(sessions)) session.destroy();
});

test('a silent peer expires after the TTL without cleanup; departure removes it at once',()=>{
  const {clock,sessions}=directPair();
  sessions.a.connection(true); sessions.b.connection(true); clock.advance(0);
  assert.ok(sessions.b.partner());
  // A disappears without saying goodbye (crash): stop its renewals only.
  sessions.a.connection(false);
  clock.advance(PRESENCE_TTL_MS-1000); assert.ok(sessions.b.partner(),'still within TTL');
  clock.advance(2000); assert.equal(sessions.b.partner(),null,'expired by TTL');
  assert.equal(sessions.b.size.states,1,'only the local state remains');
  clock.advance(PRESENCE_TTL_MS+1000);
  assert.equal(sessions.b.size.meta,1,'expired peer clocks are forgotten');
  // Explicit departure: B announces, then A sees it gone immediately.
  sessions.a.connection(true); clock.advance(0); assert.ok(sessions.b.partner());
  const leftAt=clock.now(); sessions.a.destroy();
  assert.equal(sessions.b.partner(),null); assert.equal(sessions.b.partnerLeftAt,leftAt);
  sessions.a.destroy(); sessions.b.destroy(); assert.equal(clock.pending,0,'no timers survive teardown');
});

test('replayed, own-seat, phantom and over-cap peers cannot create or extend presence',()=>{
  const clock=fakeRelayClock(),{right}=documentPair(),changes=[];
  const session=createPresenceSession({doc:right,text:right.getText('code'),seat:'b',...clock,send:()=>true,onChange:()=>changes.push(1)});
  const state=(seat='a')=>({v:1,seat,status:'active',sel:null});
  assert.equal(session.receive(encodeEntries([{clientID:9,clock:1,state:state()}])),false,'ignored while disconnected');
  session.connection(true);
  assert.equal(session.receive(encodeEntries([{clientID:9,clock:1,state:state()}])),true);
  assert.equal(session.partner().clientID,9);
  // Replaying the same frame does not renew the TTL.
  clock.advance(PRESENCE_TTL_MS-500);
  session.receive(encodeEntries([{clientID:9,clock:1,state:state()}]));
  clock.advance(2000); assert.equal(session.partner(),null);
  // Another tab of our own seat is not the partner.
  assert.equal(session.receive(encodeEntries([{clientID:10,clock:1,state:state('b')}])),true);
  assert.equal(session.partner(),null);
  // Removal of an unknown client is refused (no meta growth).
  assert.equal(session.receive(encodeEntries([{clientID:99,clock:5,state:null}])),false);
  for(let index=11;index<11+PRESENCE_MAX_PEERS;index+=1) session.receive(encodeEntries([{clientID:index,clock:1,state:state()}]));
  assert.ok(session.size.states<=PRESENCE_MAX_PEERS+1,'bounded peer map');
  assert.equal(session.receive(encodeEntries([{clientID:500,clock:1,state:state()}])),false);
  assert.equal(session.receive(encodeEntries([{clientID:session.clientID,clock:99,state:state()}])),false);
  // Disconnect drops every remote cursor immediately.
  session.connection(false); assert.equal(session.size.states,1);
  assert.ok(changes.length>0); session.destroy(); session.setSelection(1,1); session.activity();
  assert.equal(session.partner(),null); right.destroy();
  assert.throws(()=>createPresenceSession({seat:'a'}),TypeError);
});

test('activity state goes idle after a minute without local input and back on input',()=>{
  const {clock,sessions}=directPair();
  sessions.a.connection(true); sessions.b.connection(true); clock.advance(0);
  clock.advance(PRESENCE_IDLE_MS+2000);
  assert.equal(sessions.b.partner().status,'idle','idle peers stay present through renewals');
  sessions.a.activity(); clock.advance(PRESENCE_SEND_MS);
  assert.equal(sessions.b.partner().status,'active');
  clock.advance(PRESENCE_IDLE_MS+2000); sessions.a.setSelection(1,1); clock.advance(PRESENCE_SEND_MS);
  assert.equal(sessions.b.partner().status,'active');
  for(const session of Object.values(sessions)) session.destroy();
});

test('awareness rides the private relay as a separate bounded, rate-capped broadcast event',async()=>{
  const clock=fakeRelayClock(),{Socket,sockets}=mockRelaySockets({clock,latency:30}),{left,right}=documentPair();
  const connections={1:[],2:[]},sessions={};
  const relay=(nonce,doc,seat)=>{
    const instance=createCodeRelay({identity:{room},mergeUpdates:Y.mergeUpdates,...clock,WebSocketCtor:Socket,
      fetchToken:async()=>response(mockRelayConfiguration(room,clock)),randomBytes:()=>new Uint8Array(16).fill(nonce),
      isCurrent:()=>true,onFallback:()=>{},onUpdate:()=>{},
      onAwareness:bytes=>sessions[nonce]?.receive(bytes),onConnection:value=>{ connections[nonce].push(value); sessions[nonce]?.connection(value); }});
    sessions[nonce]=createPresenceSession({doc,text:doc.getText('code'),seat,...clock,send:bytes=>instance.sendAwareness(bytes)});
    return instance;
  };
  const a=relay(1,left,'a'),b=relay(2,right,'b');
  await Promise.all([a.start(),b.start()]); clock.advance(30); await settleRelayPromises(); clock.advance(100);
  assert.deepEqual(connections,{1:[true],2:[true]});
  assert.equal(sessions[2].partner()?.status,'active');
  sessions[1].setSelection(3,3); clock.advance(PRESENCE_SEND_MS+30);
  assert.deepEqual(sessions[2].partner().selection,{anchor:3,head:3});
  const frame=sockets[0].sent.find(item=>item.payload?.event===RELAY_AWARENESS_EVENT);
  assert.deepEqual(Object.keys(frame.payload.payload).sort(),['awareness','sender']);
  assert.equal(frame.payload.type,'broadcast');
  // Envelope validation.
  assert.equal(decodeAwarenessMessage(frame.payload.payload).length>0,true);
  for(const value of [null,{...frame.payload.payload,extra:1},{sender:'bad',awareness:frame.payload.payload.awareness},
    {sender:'a'.repeat(32),awareness:encodeRelayBytes(new Uint8Array(RELAY_AWARENESS_LIMIT+1))},{sender:'a'.repeat(32),awareness:'AB=='}])
    assert.equal(decodeAwarenessMessage(value),null);
  assert.equal(a.sendAwareness(new Uint8Array(RELAY_AWARENESS_LIMIT+1)),false);
  assert.equal(a.sendAwareness('x'),false);
  // Send cap per second, independent of y-update.
  let accepted=0; for(let index=0;index<RELAY_AWARENESS_PER_SECOND+5;index+=1) if(a.sendAwareness(new Uint8Array([1,1,1,0]))) accepted+=1;
  assert.ok(accepted<=RELAY_AWARENESS_PER_SECOND);
  // Receive cap: a flood is dropped after ten frames per second.
  let received=0; const counter=createCodeRelay({identity:{room},mergeUpdates:Y.mergeUpdates,...clock,WebSocketCtor:Socket,
    fetchToken:async()=>response(mockRelayConfiguration(room,clock)),randomBytes:()=>new Uint8Array(16).fill(3),
    isCurrent:()=>true,onFallback:()=>{},onUpdate:()=>{},onAwareness:()=>{ received+=1; }});
  await counter.start(); clock.advance(30); await settleRelayPromises();
  const socket=sockets.at(-1);
  for(let index=0;index<RELAY_AWARENESS_PER_SECOND*3;index+=1) socket.deliver({topic:socket.topic,event:'broadcast',ref:null,join_ref:'1',
    payload:{type:'broadcast',event:RELAY_AWARENESS_EVENT,payload:{sender:'b'.repeat(32),awareness:encodeRelayBytes(new Uint8Array([1,2,3]))}}});
  assert.equal(received,RELAY_AWARENESS_PER_SECOND);
  socket.deliver({topic:socket.topic,event:'broadcast',ref:null,join_ref:'1',
    payload:{type:'broadcast',event:'presence_state',payload:{}}});
  // Departure: destroying A's session sends a null state through the live
  // relay (the final frame bypasses the sender's own per-second cap).
  clock.advance(1000); sessions[1].destroy(); clock.advance(30);
  assert.equal(sessions[2].partner(),null);
  // Transport loss reports disconnection and clears remote cursors.
  sessions[1]=null; sockets[1].close();
  assert.deepEqual(connections[2],[true,false]);
  a.stop(); b.stop(); counter.stop(); sessions[2].destroy(); left.destroy(); right.destroy();
});

test('planned token renewal reports a brief disconnect then re-announces after the fresh join',async()=>{
  const clock=fakeRelayClock(),{Socket}=mockRelaySockets({clock,latency:30});
  const connections=[];
  const relay=createCodeRelay({identity:{room},mergeUpdates:Y.mergeUpdates,...clock,WebSocketCtor:Socket,
    fetchToken:async()=>response(mockRelayConfiguration(room,clock)),randomBytes:()=>new Uint8Array(16).fill(4),
    isCurrent:()=>true,onFallback:()=>{},onUpdate:()=>{},onConnection:value=>connections.push(value)});
  await relay.start(); clock.advance(30); await settleRelayPromises();
  clock.advance(271000); await settleRelayPromises(); clock.advance(30); await settleRelayPromises();
  assert.deepEqual(connections,[true,false,true]);
  relay.stop();
});

function fallbackHarness(replies){
  const clock=fakeRelayClock(),calls=[],changes=[];
  let relay=false;
  const presence=createFallbackPresence({...clock,relayConnected:()=>relay,onChange:info=>changes.push(info||null),
    request:async(state,signal,options)=>{
      calls.push({state,signal:!!signal,options:options||null});
      const next=state==='leave'?{status:200,body:{ok:true}}:(replies.shift()||{status:200,body:{ok:true,seat:'a',partner_online:true,ttl_seconds:20}});
      if(next.throws) throw new Error('network');
      return {ok:next.status===200,status:next.status,json:async()=>next.body,headers:{get:name=>name==='retry-after'?next.retryAfter??null:null}};
    }});
  return {clock,calls,changes,presence,setRelay:value=>relay=value};
}

test('HTTPS fallback presence learns the seat, polls cheaply and leaves without cleanup',async()=>{
  const item=fallbackHarness([{status:200,body:{ok:true,seat:'a',partner_online:false,ttl_seconds:20,
    partner:{display_name:'Two',color:'#9cc0b5'}}}]);
  assert.equal(item.presence.partner,null);
  item.presence.start(); item.clock.advance(0); await settleRelayPromises();
  assert.equal(item.presence.seat,'a'); assert.equal(item.calls[0].state,'join');
  assert.deepEqual(item.presence.partner,{display_name:'Two',color:'#9cc0b5'}); assert.equal(item.presence.partnerOnline,false); assert.equal(item.presence.healthy,true);
  item.clock.advance(PRESENCE_FALLBACK_MS-1); await settleRelayPromises(); assert.equal(item.calls.length,1);
  item.clock.advance(1); await settleRelayPromises();
  assert.equal(item.calls.length,2); assert.equal(item.presence.partnerOnline,true,'partner joined within one interval');
  assert.equal(item.calls[1].state,'online');
  item.setRelay(true); item.clock.advance(PRESENCE_FALLBACK_MS); await settleRelayPromises();
  item.clock.advance(PRESENCE_FALLBACK_RELAY_MS-PRESENCE_FALLBACK_MS-1); await settleRelayPromises();
  assert.equal(item.calls.length,3,'slower cadence while the relay is live');
  item.presence.nudge(); item.clock.advance(0); await settleRelayPromises(); assert.equal(item.calls.length,4);
  assert.ok(item.presence.lastSuccessAt>0);
  item.presence.stop(); item.presence.stop();
  assert.deepEqual(item.calls.at(-1),{state:'leave',signal:false,options:{keepalive:true}});
  assert.equal(item.presence.partnerOnline,null); assert.equal(item.clock.pending,0);
  item.presence.nudge(); item.presence.start(); item.clock.advance(PRESENCE_FALLBACK_RELAY_MS); assert.equal(item.calls.length,5);
});

test('fallback degrades to unknown after the TTL, backs off on 429 and stops on denial',async()=>{
  const failing=fallbackHarness([{status:200,body:{ok:true,seat:'a',partner_online:true,ttl_seconds:6}},{throws:true},{status:503,body:{}},
    {status:200,body:{ok:true,seat:'b',partner_online:true,ttl_seconds:20}},{status:200,body:{ok:true,seat:'a',partner_online:'yes',ttl_seconds:20}}]);
  failing.presence.start(); failing.clock.advance(0); await settleRelayPromises();
  failing.clock.advance(PRESENCE_FALLBACK_MS); await settleRelayPromises();
  assert.equal(failing.presence.healthy,false); assert.equal(failing.presence.partnerOnline,true,'still within TTL');
  failing.clock.advance(PRESENCE_FALLBACK_MS); await settleRelayPromises();
  assert.equal(failing.presence.partnerOnline,null,'stale presence expires');
  failing.clock.advance(PRESENCE_FALLBACK_MS); await settleRelayPromises();
  assert.equal(failing.presence.seat,'a','a changed seat is rejected');
  failing.clock.advance(PRESENCE_FALLBACK_MS); await settleRelayPromises();
  assert.equal(failing.presence.healthy,false); failing.presence.stop({leave:false});
  assert.equal(failing.calls.some(call=>call.state==='leave'),false);

  const limited=fallbackHarness([{status:429,body:{},retryAfter:'40'}]);
  limited.presence.start(); limited.clock.advance(0); await settleRelayPromises();
  limited.clock.advance(39000); await settleRelayPromises(); assert.equal(limited.calls.length,1);
  limited.clock.advance(1000); await settleRelayPromises(); assert.equal(limited.calls.length,2);
  limited.presence.stop();

  for(const status of [401,404]){
    const denied=fallbackHarness([{status,body:{error:'pair not found'}}]);
    denied.presence.start(); denied.clock.advance(0); await settleRelayPromises();
    assert.equal(denied.presence.stopped,true); assert.deepEqual(denied.changes,[{unavailable:true}]);
    assert.equal(denied.calls.length,1,'no leave without a learned seat'); assert.equal(denied.clock.pending,0);
  }
});

test('defaults: a bare fallback polls at the relay-off cadence and sessions report their link state',async()=>{
  const clock=fakeRelayClock();let calls=0;
  const bare=createFallbackPresence({...clock,request:async()=>{ calls+=1; return {ok:true,status:200,headers:{get:()=>null},
    json:async()=>({ok:true,seat:'a',partner_online:false,ttl_seconds:20})}; }});
  bare.start(); clock.advance(0); await settleRelayPromises(); clock.advance(PRESENCE_FALLBACK_MS); await settleRelayPromises();
  assert.equal(calls,2); bare.stop({leave:false});
  const doc=new Y.Doc(),session=createPresenceSession({doc,text:doc.getText('code'),seat:'a',...clock,send:()=>true});
  assert.equal(session.connected,false); session.connection(true); assert.equal(session.connected,true);
  session.destroy(); assert.equal(session.connected,false); session.connection(true); assert.equal(session.connected,false);
  doc.destroy();
});
