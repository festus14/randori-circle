import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import vm from 'node:vm';
import * as Y from 'yjs';
import { fakeRelayClock, mockRelayConfiguration, mockRelaySockets, settleRelayPromises } from '../support/realtime-relay.mjs';

const bundle=readFileSync(new URL('../../assets/crdt-editor.js',import.meta.url),'utf8');
const room='week_10_pair_20';
function target(){
  const listeners=new Map();
  return {addEventListener(type,fn){ if(!listeners.has(type)) listeners.set(type,new Set()); listeners.get(type).add(fn); },
    removeEventListener(type,fn){ listeners.get(type)?.delete(fn); },
    dispatchEvent(event){ for(const fn of listeners.get(event.type)||[]) fn(event); return true; }};
}
function store(){
  const doc=new Y.Doc(); doc.getText('code').insert(0,'base');
  let revision=1,flag=true,postStatus=200,tokenStatus=200;
  const calls=[];
  const state=()=>Buffer.from(Y.encodeStateAsUpdate(doc)).toString('base64');
  const version=()=>createHash('sha256').update(`${revision}:${state()}`).digest('hex');
  return {doc,calls,version,get code(){ return doc.getText('code').toString(); },setFlag:value=>flag=value,
    setPostStatus:value=>postStatus=value,setTokenStatus:value=>tokenStatus=value,
    async fetch(url,options,clock){
      const path=new URL(String(url),'https://randori.test').pathname;
      calls.push({path,options});
      const body=options.body?JSON.parse(options.body):null;
      if(path.endsWith('/relay-token')) return {ok:tokenStatus===200,status:tokenStatus,
        json:async()=>tokenStatus===200?mockRelayConfiguration(room,clock):{},headers:{get:()=>null}};
      if(options.method==='POST'){
        if(postStatus!==200) return {ok:false,status:postStatus,json:async()=>postStatus===409?{code:'session_completed'}:{}};
        Y.applyUpdate(doc,Buffer.from(body.update,'base64')); revision+=1;
      }
      return {ok:true,status:200,json:async()=>({ok:true,state:state(),revision,document_version:version(),...(flag?{realtime_relay:true}:{})})};
    },
  };
}
function harness({clock,Socket,server,id=1,circleContext=null}={}){
  const window=target(),document=target(),textarea={...target(),value:'',readOnly:false,selectionStart:0,selectionEnd:0,setSelectionRange(){}};
  const elements={editor:textarea,langSelect:{...target(),value:'javascript'},questionSelect:target(),
    codeSyncStatus:{dataset:{},textContent:''},runBtn:{disabled:false}};
  const storage=new Map();
  Object.assign(window,{_randori_auth:{me:{id}},_randori_authorized_room:room,
    RandoriWorkspaceScope:{canonicalRoom:value=>/^week_[1-9]\d*_pair_[1-9]\d*$/.test(value),isSolo:()=>false},
    _randori_circle_control:{scheduleContext:()=>circleContext},
    _randori_questions:{selectedIdentity:()=>({slug:'focus-block-rollup',version:1})},
    _randori_workspace:{hydrated:true,room,flush:async()=>true}});
  Object.assign(document,{readyState:'loading',visibilityState:'visible',getElementById:key=>elements[key]||null});
  const context={window,document,navigator:{onLine:true},location:{origin:'https://randori.test'},
    localStorage:{getItem:key=>storage.get(key)??null,setItem:(key,value)=>storage.set(key,String(value)),removeItem:key=>storage.delete(key)},
    fetch:(url,options)=>server.fetch(url,options,clock),WebSocket:Socket,
    setTimeout:clock.setTimer,clearTimeout:clock.clearTimer,
    AbortController,URL,CustomEvent:class{ constructor(type,init){ this.type=type; this.detail=init?.detail; } },
    Date:class extends Date{ static now(){ return clock.now(); } },
    crypto:globalThis.crypto,btoa,atob,TextEncoder,TextDecoder,console,
  };
  context.globalThis=context;
  vm.runInNewContext(bundle,context);
  return {window,document,textarea,elements,storage,crdt:window._randori_crdt,
    edit(value){ textarea.value=value; textarea.dispatchEvent({type:'input'}); },
    event(type,detail){ window.dispatchEvent({type,detail}); },
    hidden(){ document.visibilityState='hidden'; document.dispatchEvent({type:'visibilitychange'}); },
  };
}
async function initialise(item,clock){ assert.equal(await item.crdt.activate(),true); await settleRelayPromises(); clock.advance(30); await settleRelayPromises(); }

test('bundled provider applies relay bytes before persistence but never acknowledges/executes them',async()=>{
  const clock=fakeRelayClock(),{Socket,sockets}=mockRelaySockets({clock}); const server=store();
  const left=harness({clock,Socket,server,id:1}),right=harness({clock,Socket,server,id:2});
  await initialise(left,clock); await initialise(right,clock);
  assert.equal(left.crdt.relayConnected,true); assert.equal(right.crdt.relayConnected,true);
  const acknowledged=right.crdt.documentVersion; assert.equal(right.crdt.acknowledged,true);
  left.edit('base + instant'); clock.advance(80); await settleRelayPromises();
  assert.equal(right.textarea.value,'base + instant'); assert.equal(server.code,'base');
  assert.equal(left.crdt.documentVersion,null); assert.equal(right.crdt.documentVersion,null);
  assert.equal(right.crdt.acknowledged,false); assert.equal(right.elements.runBtn.disabled,true);
  assert.ok(JSON.parse(right.storage.get('randori-crdt-pending-v1'))[JSON.stringify([2,null,room,'focus-block-rollup',1,'javascript'])]);
  assert.equal(sockets[1].sent.filter(frame=>frame.event==='broadcast').length,0,'receiver persistence is not rebroadcast');
  clock.advance(120); await settleRelayPromises();
  assert.equal(server.code,'base + instant');
  assert.equal(right.crdt.acknowledged,true); assert.notEqual(right.crdt.documentVersion,acknowledged);
  assert.equal(right.elements.runBtn.disabled,false);
  assert.equal(server.calls.filter(call=>call.options.method==='POST'&&call.path==='/api/code-document').length,2,'both clients persist idempotently over HTTPS');
  left.crdt.deactivate(); right.crdt.deactivate(); server.doc.destroy();
});

test('primary relay tokens carry the live context-version fence without the secondary-workspace wrapper',async()=>{
  const clock=fakeRelayClock(),{Socket,sockets}=mockRelaySockets({clock}),server=store();
  const context={circlePublicId:'primary-test',isPrimary:true,contextVersion:7};
  const item=harness({clock,Socket,server,circleContext:context});
  await initialise(item,clock);
  const tokenCalls=()=>server.calls.filter(call=>call.path.endsWith('/relay-token'));
  assert.equal(tokenCalls()[0].options.headers['X-Randori-Circle-Context-Version'],'7');
  context.contextVersion=8; sockets[0].close(); clock.advance(1000); await settleRelayPromises(); clock.advance(30);
  assert.equal(tokenCalls()[1].options.headers['X-Randori-Circle-Context-Version'],'8','each retry reads the current context fence');
  assert.equal(item.crdt.relayConnected,true);
  item.crdt.deactivate(); server.doc.destroy();
});

test('flag off preserves the polling path exactly; flag withdrawal disposes an existing socket',async()=>{
  const clock=fakeRelayClock(),{Socket,sockets}=mockRelaySockets({clock}),server=store(); server.setFlag(false);
  const item=harness({clock,Socket,server}); await initialise(item,clock);
  assert.equal(sockets.length,0); assert.equal(server.calls.some(call=>call.path.endsWith('/relay-token')),false);
  clock.advance(1200); await settleRelayPromises(); assert.equal(server.calls.length,2);
  server.setFlag(true); await item.crdt.poll(); await settleRelayPromises(); clock.advance(30);
  assert.equal(item.crdt.relayConnected,true);
  server.setFlag(false); await item.crdt.poll(); assert.equal(item.crdt.relayConnected,false); assert.equal(sockets[0].closes,1);
  item.crdt.deactivate(); server.doc.destroy();
});

test('unavailable token/transport engages the HTTPS polling fallback without disabling acknowledged Run',async()=>{
  for(const tokenStatus of [404,429,503]){
    const clock=fakeRelayClock(),{Socket,sockets}=mockRelaySockets({clock}),server=store(); server.setTokenStatus(tokenStatus);
    const item=harness({clock,Socket,server}); await initialise(item,clock);
    clock.advance(0); await settleRelayPromises();
    assert.equal(sockets.length,0); assert.equal(item.crdt.acknowledged,true);
    assert.ok(server.calls.filter(call=>call.path==='/api/code-document').length>=2,'fallback scheduled an immediate HTTPS reconcile');
    item.crdt.deactivate(); server.doc.destroy();
  }
  const clock=fakeRelayClock(),{Socket,sockets}=mockRelaySockets({clock}),server=store();
  const item=harness({clock,Socket,server}); await initialise(item,clock); const before=server.calls.length;
  sockets[0].close(); clock.advance(0); await settleRelayPromises();
  assert.equal(item.crdt.relayConnected,false); assert.ok(server.calls.length>before);
  item.crdt.deactivate(); server.doc.destroy();
});

test('terminal, hidden, sign-out, context and selection fences close the socket and stop late delivery',async()=>{
  for(const reason of ['terminal','hidden','sign-out','scope','selection','room','offline']){
    const clock=fakeRelayClock(),{Socket,sockets}=mockRelaySockets({clock}),server=store();
    const item=harness({clock,Socket,server}); await initialise(item,clock);
    const socket=sockets[0],oldMessage=socket.onmessage,previous=item.textarea.value;
    if(reason==='terminal') item.event('randori:completion-observed',{room,state:'completed'});
    else if(reason==='hidden') item.hidden();
    else if(reason==='sign-out'){
      item.window._randori_auth.me=null;
      item.document.dispatchEvent({type:'click',target:{closest:()=>true}});
    }else if(reason==='scope') item.event('randori:workspace-scope-reset');
    else if(reason==='selection') item.elements.questionSelect.dispatchEvent({type:'change'});
    else if(reason==='room') item.event('randori:room-change',{roomId:'week_11_pair_21'});
    else item.event('offline');
    assert.equal(socket.readyState,3,reason); assert.equal(item.crdt.relayConnected,false,reason);
    const doc=new Y.Doc(); doc.getText('code').insert(0,'late private code');
    oldMessage({data:JSON.stringify({topic:socket.topic,event:'broadcast',payload:{type:'broadcast',event:'y-update',
      payload:{sender:'a'.repeat(32),seq:1,update:Buffer.from(Y.encodeStateAsUpdate(doc)).toString('base64')}}})});
    assert.equal(item.textarea.value,previous,reason);
    if(reason==='terminal') { assert.equal(item.textarea.readOnly,true); assert.equal(item.elements.runBtn.disabled,true); }
    item.crdt.deactivate(); server.doc.destroy(); doc.destroy();
  }
});

test('HTTPS terminal rejection after a relay edit disposes transport and discards unsendable queue',async()=>{
  const clock=fakeRelayClock(),{Socket,sockets}=mockRelaySockets({clock}),server=store();
  const item=harness({clock,Socket,server}); await initialise(item,clock); server.setPostStatus(409);
  item.edit('base completed'); clock.advance(120); await settleRelayPromises();
  assert.equal(item.crdt.relayConnected,false); assert.equal(sockets[0].readyState,3);
  assert.equal(item.textarea.readOnly,true); assert.equal(item.crdt.documentVersion,null);
  assert.deepEqual(JSON.parse(item.storage.get('randori-crdt-pending-v1')),{});
  item.crdt.deactivate(); server.doc.destroy();
});
