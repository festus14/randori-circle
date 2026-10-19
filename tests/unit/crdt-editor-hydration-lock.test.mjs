import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import * as Y from 'yjs';

const BUNDLE=readFileSync(new URL('../../assets/crdt-editor.js',import.meta.url),'utf8');
const ROOM='week_10_pair_20';
const VERSION='a'.repeat(64);

function emptyState(){
  return Buffer.from(Y.encodeStateAsUpdate(new Y.Doc())).toString('base64');
}

function deferred(){
  let resolve,reject;
  const promise=new Promise((ok,fail)=>{ resolve=ok; reject=fail; });
  return {promise,resolve,reject};
}

function harness(){
  const listeners=new Map();
  const target=()=>({addEventListener(type,fn){ listeners.set(type,fn); },removeEventListener(){},dispatchEvent(){ return true; }});
  const textarea={...target(),value:'',readOnly:false,selectionStart:0,selectionEnd:0,setSelectionRange(){}};
  const elements={editor:textarea,langSelect:{...target(),value:'javascript'},codeSyncStatus:{dataset:{},textContent:''}};
  const storage=new Map();
  const fetches=[];
  const window={
    addEventListener(){},dispatchEvent(){ return true; },
    _randori_auth:{me:{id:1}},
    _randori_authorized_room:ROOM,
    _randori_questions:{selectedIdentity:()=>({slug:'focus-block-rollup',version:1})},
    _randori_workspace:{hydrated:true,room:ROOM,flush:async()=>true},
  };
  const context={
    window,
    document:{readyState:'complete',visibilityState:'visible',getElementById:id=>elements[id]||null,addEventListener(){}},
    navigator:{onLine:true},
    location:{origin:'https://randori.test'},
    localStorage:{getItem:key=>storage.get(key)??null,setItem:(key,value)=>storage.set(key,String(value)),removeItem:key=>storage.delete(key)},
    fetch:()=>{ const call=deferred(); fetches.push(call); return call.promise; },
    setTimeout:()=>0,clearTimeout(){},
    AbortController,URL,CustomEvent:class{ constructor(type,init){ this.type=type; this.detail=init?.detail; } },
    crypto:globalThis.crypto,btoa,atob,TextEncoder,TextDecoder,console,
  };
  context.globalThis=context;
  vm.runInNewContext(BUNDLE,context);
  return {crdt:window._randori_crdt,textarea,fetches};
}

async function waitFor(predicate){
  for(let attempt=0;attempt<200&&!predicate();attempt+=1) await new Promise(resolve=>setImmediate(resolve));
  assert.equal(predicate(),true);
}

test('hydration keeps the editor read-only until the canonical document is attached',async()=>{
  const {crdt,textarea,fetches}=harness();
  const activation=crdt.activate();
  await waitFor(()=>fetches.length===1);
  assert.equal(textarea.readOnly,true);
  fetches[0].resolve({ok:true,status:200,json:async()=>({ok:true,revision:1,document_version:VERSION,state:emptyState()})});
  assert.equal(await activation,true);
  assert.equal(textarea.readOnly,false);
});

test('a failed hydration restores editability',async()=>{
  const {crdt,textarea,fetches}=harness();
  const activation=crdt.activate();
  await waitFor(()=>fetches.length===1);
  assert.equal(textarea.readOnly,true);
  fetches[0].resolve({ok:false,status:503,json:async()=>({ok:false,error:'code document unavailable'})});
  assert.equal(await activation,false);
  assert.equal(textarea.readOnly,false);
});

test('a stale hydration restores editability without unlocking a newer hydration',async()=>{
  const {crdt,textarea,fetches}=harness();
  const first=crdt.activate();
  await waitFor(()=>fetches.length===1);
  crdt.fence(ROOM);
  const second=crdt.activate();
  await waitFor(()=>fetches.length===2);
  assert.equal(textarea.readOnly,true);
  fetches[0].resolve({ok:true,status:200,json:async()=>({ok:true,revision:1,document_version:VERSION,state:emptyState()})});
  assert.equal(await first,false);
  assert.equal(textarea.readOnly,true);
  fetches[1].resolve({ok:true,status:200,json:async()=>({ok:true,revision:1,document_version:VERSION,state:emptyState()})});
  assert.equal(await second,true);
  assert.equal(textarea.readOnly,false);
});
