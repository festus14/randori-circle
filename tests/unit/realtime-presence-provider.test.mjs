import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import vm from 'node:vm';
import * as Y from 'yjs';
import { fakeRelayClock, mockRelayConfiguration, mockRelaySockets, settleRelayPromises as settle } from '../support/realtime-relay.mjs';

// The shipped bundle, end to end: HTTPS document + private relay + presence.
const bundle=readFileSync(new URL('../../assets/crdt-editor.js',import.meta.url),'utf8');
const room='week_10_pair_20';
const settleRelayPromises=async()=>{ for(let index=0;index<4;index+=1) await settle(); };
function target(){
  const listeners=new Map();
  return {addEventListener(type,fn){ if(!listeners.has(type)) listeners.set(type,new Set()); listeners.get(type).add(fn); },
    removeEventListener(type,fn){ listeners.get(type)?.delete(fn); },
    dispatchEvent(event){ for(const fn of listeners.get(event.type)||[]) fn(event); return true; },
    listeners:type=>listeners.get(type)?.size||0};
}
function store({relay=true,presence=true}={}){
  const doc=new Y.Doc(); doc.getText('code').insert(0,'function solve(){ return 1; }');
  let revision=1;
  const calls=[],rows=new Map();
  const state=()=>Buffer.from(Y.encodeStateAsUpdate(doc)).toString('base64');
  const version=()=>createHash('sha256').update(`${revision}:${state()}`).digest('hex');
  return {doc,calls,rows,flags:{relay,presence},
    async fetch(url,options,clock,user){
      const path=new URL(String(url),'https://randori.test').pathname;
      const body=options.body?JSON.parse(options.body):null;
      calls.push({path,user,body,keepalive:options.keepalive===true});
      if(path.endsWith('/relay-token')) return {ok:true,status:200,json:async()=>mockRelayConfiguration(room,clock),headers:{get:()=>null}};
      if(path.endsWith('/presence')){
        if(!this.flags.presence) return {ok:false,status:404,json:async()=>({error:'pair not found'}),headers:{get:()=>null}};
        if(body.state==='leave'){ rows.delete(user); return {ok:true,status:200,json:async()=>({ok:true}),headers:{get:()=>null}}; }
        rows.set(user,clock.now()+20000);
        const partner=user===1?2:1;
        return {ok:true,status:200,headers:{get:()=>null},json:async()=>({ok:true,seat:user===1?'a':'b',
          partner_online:(rows.get(partner)||0)>clock.now(),ttl_seconds:20,interval_seconds:5})};
      }
      if(options.method==='POST'){ Y.applyUpdate(doc,Buffer.from(body.update,'base64')); revision+=1; }
      return {ok:true,status:200,json:async()=>({ok:true,state:state(),revision,document_version:version(),
        ...(this.flags.relay?{realtime_relay:true}:{}),...(this.flags.presence?{presence:true}:{})})};
    },
  };
}
function harness({clock,Socket,server,id}){
  const window=target(),document=target();
  const textarea={...target(),value:'',readOnly:false,selectionStart:0,selectionEnd:0,selectionDirection:'forward',setSelectionRange(){}};
  const presenceText={textContent:'you alone',parentElement:null};
  const elements={editor:textarea,langSelect:{...target(),value:'javascript'},questionSelect:target(),
    codeSyncStatus:{dataset:{},textContent:''},runBtn:{disabled:false},presenceText};
  const storage=new Map();
  Object.assign(window,{_randori_auth:{me:{id}},_randori_authorized_room:room,
    _randori_pair_cache:{room_id:room,partner:{display_name:id===1?'Two':'One',color:'#9cc0b5'}},
    RandoriWorkspaceScope:{canonicalRoom:value=>/^week_[1-9]\d*_pair_[1-9]\d*$/.test(value),isSolo:()=>false},
    _randori_circle_control:{scheduleContext:()=>null},
    _randori_questions:{selectedIdentity:()=>({slug:'focus-block-rollup',version:1})},
    _randori_workspace:{hydrated:true,room,flush:async()=>true}});
  Object.assign(document,{readyState:'loading',visibilityState:'visible',activeElement:null,getElementById:key=>elements[key]||null});
  const context={window,document,navigator:{onLine:true},location:{origin:'https://randori.test'},
    localStorage:{getItem:key=>storage.get(key)??null,setItem:(key,value)=>storage.set(key,String(value)),removeItem:key=>storage.delete(key)},
    fetch:(url,options)=>server.fetch(url,options,clock,id),WebSocket:Socket,
    setTimeout:clock.setTimer,clearTimeout:clock.clearTimer,setInterval:()=>0,clearInterval:()=>{},
    AbortController,URL,CustomEvent:class{ constructor(type,init){ this.type=type; this.detail=init?.detail; } },
    Date:class extends Date{ static now(){ return clock.now(); } },
    crypto:globalThis.crypto,btoa,atob,TextEncoder,TextDecoder,console};
  context.globalThis=context;
  vm.runInNewContext(bundle,context);
  return {window,document,textarea,elements,crdt:window._randori_crdt,
    select(start,end,direction='forward'){
      Object.assign(textarea,{selectionStart:start,selectionEnd:end,selectionDirection:direction});
      textarea.dispatchEvent({type:'select'});
    },
    event(type,detail){ window.dispatchEvent({type,detail}); },
    hidden(){ document.visibilityState='hidden'; document.dispatchEvent({type:'visibilitychange'}); }};
}
async function initialise(item,clock){
  assert.equal(await item.crdt.activate(),true); await settleRelayPromises();
  for(let step=0;step<4;step+=1){ clock.advance(30); await settleRelayPromises(); }
}
async function pump(clock,ms,step=50){ for(let elapsed=0;elapsed<ms;elapsed+=step){ clock.advance(step); await settleRelayPromises(); } }
const plain=value=>JSON.parse(JSON.stringify(value));
const presenceCalls=(server,state)=>server.calls.filter(call=>call.path.endsWith('/presence')&&(!state||call.body.state===state));

test('bundled presence: live partner join, cursor, then departure on hidden tab within one tick',async()=>{
  const clock=fakeRelayClock(),{Socket,sockets}=mockRelaySockets({clock}),server=store();
  const left=harness({clock,Socket,server,id:1}),right=harness({clock,Socket,server,id:2});
  await initialise(left,clock); await initialise(right,clock); await pump(clock,400);
  assert.equal(left.crdt.presence.presence,'here'); assert.equal(right.crdt.presence.presence,'here');
  assert.equal(left.crdt.presence.health,'live');
  assert.equal(left.elements.presenceText.textContent,'Two is here · live');
  assert.equal(left.window._randori_presence_active,true);
  for(const call of presenceCalls(server)) assert.deepEqual(Object.keys(call.body).sort(),
    ['language','question_slug','question_version','room_id','state'],'no cursor/name/email in HTTPS presence');
  const awareness=sockets.flatMap(socket=>socket.sent).filter(frame=>frame.payload?.event==='y-awareness');
  assert.ok(awareness.length>=2);
  for(const frame of awareness) assert.doesNotMatch(Buffer.from(frame.payload.payload.awareness,'base64').toString(),/One|Two|example\.test/);
  // Remote selection: shown on the partner, the local selection is untouched.
  left.select(9,15); await pump(clock,300);
  assert.deepEqual(plain(right.crdt.presence.selection),{anchor:9,head:15});
  assert.equal(right.textarea.selectionStart,0); assert.equal(right.textarea.selectionEnd,0);
  assert.equal(right.elements.presenceText.textContent,'One is here · line 1 · live');
  left.select(9,15,'backward'); await pump(clock,300);
  assert.deepEqual(plain(right.crdt.presence.selection),{anchor:15,head:9});
  // Partner edits move the remote cursor with the text (relative positions).
  right.textarea.value=`// note\n${right.textarea.value}`; right.textarea.dispatchEvent({type:'input'});
  await pump(clock,300);
  assert.deepEqual(plain(right.crdt.presence.selection),{anchor:23,head:17});
  // Hidden tab: presence stops, awareness says goodbye and the HTTPS row is deleted.
  left.hidden(); await pump(clock,100);
  assert.equal(left.crdt.presence,null); assert.equal(left.window._randori_presence_active,false);
  assert.equal(right.crdt.presence.presence,'away','departure is visible before any TTL');
  assert.equal(right.crdt.presence.selection,null);
  const leave=presenceCalls(server,'leave'); assert.equal(leave.length,1); assert.equal(leave[0].user,1); assert.equal(leave[0].keepalive,true);
  assert.equal(server.rows.has(1),false);
  await pump(clock,16000,500);
  assert.equal(right.crdt.presence.presence,'away','a later HTTPS beat agrees');
  assert.equal(left.textarea.listeners('select'),0,'editor listeners are removed');
  left.crdt.deactivate(); right.crdt.deactivate(); server.doc.destroy();
});

test('bundled presence degrades to HTTPS "online" when the relay is off and stops on terminal state',async()=>{
  const clock=fakeRelayClock(),{Socket,sockets}=mockRelaySockets({clock}),server=store({relay:false});
  const left=harness({clock,Socket,server,id:1}),right=harness({clock,Socket,server,id:2});
  await initialise(left,clock); await initialise(right,clock);
  assert.equal(sockets.length,0,'no socket without the relay');
  await pump(clock,5200,200);
  assert.equal(left.crdt.presence.presence,'online'); assert.equal(left.crdt.presence.health,'polling');
  assert.equal(left.crdt.presence.selection,null,'no cursors on the polling fallback');
  assert.equal(left.elements.presenceText.textContent,'Two online · polling');
  const beats=presenceCalls(server,'online').length;
  await pump(clock,10000,500);
  assert.ok(presenceCalls(server,'online').length-beats<=4,'about one heartbeat per five seconds per participant');
  // Partner signs out: its row is deleted; the next beat shows it gone.
  right.window._randori_auth.me=null;
  right.document.dispatchEvent({type:'click',target:{closest:()=>true}});
  await pump(clock,5200,200);
  assert.equal(left.crdt.presence.presence,'away');
  // Terminal completion stops presence on the remaining participant.
  left.event('randori:completion-observed',{room,state:'completed'});
  assert.equal(left.crdt.presence,null);
  const after=presenceCalls(server).length; await pump(clock,10000,1000);
  assert.equal(presenceCalls(server).length,after,'no heartbeats after the room closes');
  left.crdt.deactivate(); right.crdt.deactivate(); server.doc.destroy();
});

test('presence flag off keeps the existing room bar and makes no presence request or awareness frame',async()=>{
  const clock=fakeRelayClock(),{Socket,sockets}=mockRelaySockets({clock}),server=store({presence:false});
  const left=harness({clock,Socket,server,id:1}),right=harness({clock,Socket,server,id:2});
  await initialise(left,clock); await initialise(right,clock); await pump(clock,6000,500);
  assert.equal(left.crdt.relayConnected,true); assert.equal(left.crdt.presence,null);
  assert.equal(presenceCalls(server).length,0);
  assert.equal(sockets.flatMap(socket=>socket.sent).some(frame=>frame.payload?.event==='y-awareness'),false);
  assert.equal(left.elements.presenceText.textContent,'you alone');
  // Withdrawing the flag on a later poll stops an active presence session.
  server.flags.presence=true; await left.crdt.poll(); await pump(clock,400);
  assert.ok(left.crdt.presence);
  server.flags.presence=false; await left.crdt.poll(); await settleRelayPromises();
  assert.equal(left.crdt.presence,null);
  left.crdt.deactivate(); right.crdt.deactivate(); server.doc.destroy();
});
