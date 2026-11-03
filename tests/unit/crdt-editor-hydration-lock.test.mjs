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

function harness({room=ROOM,solo=false,circlePublicId=null,queues={}}={}){
  const listeners=new Map();
  const target=()=>({addEventListener(type,fn){ listeners.set(type,fn); },removeEventListener(){},dispatchEvent(){ return true; }});
  const textarea={...target(),value:'',readOnly:false,selectionStart:0,selectionEnd:0,setSelectionRange(){}};
  const elements={editor:textarea,langSelect:{...target(),value:'javascript'},codeSyncStatus:{dataset:{},textContent:''},runBtn:{disabled:false}};
  const storage=new Map([['randori-crdt-pending-v1',JSON.stringify(queues)]]);
  const fetches=[];
  const window={
    addEventListener(){},dispatchEvent(){ return true; },
    _randori_auth:{me:{id:1}},
    RandoriWorkspaceScope:{canonicalRoom:value=>/^(?:week_[1-9]\d*_pair_[1-9]\d*|circle_[1-9]\d*_publication_[1-9]\d*_group_[1-9]\d*)$/.test(value),isSolo:value=>solo&&value===room},
    _randori_circle_control:{scheduleContext:()=>({circlePublicId})},
    _randori_authorized_room:room,
    _randori_questions:{selectedIdentity:()=>({slug:'focus-block-rollup',version:1})},
    _randori_workspace:{hydrated:true,room,flush:async()=>true},
  };
  const context={
    window,
    document:{readyState:'complete',visibilityState:'visible',getElementById:id=>elements[id]||null,addEventListener(){}},
    navigator:{onLine:true},
    location:{origin:'https://randori.test'},
    localStorage:{getItem:key=>storage.get(key)??null,setItem:(key,value)=>storage.set(key,String(value)),removeItem:key=>storage.delete(key)},
    fetch:(url,options)=>{ const call={...deferred(),url,options}; fetches.push(call); return call.promise; },
    setTimeout:()=>0,clearTimeout(){},
    AbortController,URL,CustomEvent:class{ constructor(type,init){ this.type=type; this.detail=init?.detail; } },
    crypto:globalThis.crypto,btoa,atob,TextEncoder,TextDecoder,console,
  };
  context.globalThis=context;
  vm.runInNewContext(BUNDLE,context);
  return {crdt:window._randori_crdt,textarea,fetches,storage,elements};
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

test('an authorized solo room bypasses paired CRDT without disabling Run or awaiting hydration',async()=>{
  const {crdt,textarea,fetches,elements}=harness({room:'circle_20_publication_1_group_1',solo:true});
  crdt.fence('circle_20_publication_1_group_1');
  assert.equal(await crdt.activate(),false);
  assert.equal(crdt.identity,null);
  assert.equal(crdt.status,'local');
  assert.equal(elements.runBtn.disabled,false);
  assert.equal(textarea.readOnly,false);
  assert.equal(fetches.length,0);
});

function queuedEdit(room=ROOM){
  const doc=new Y.Doc();
  doc.getText('code').insert(0,'// saved primary edit\n');
  const update=Buffer.from(Y.encodeStateAsUpdate(doc)).toString('base64');
  doc.destroy();
  const key=JSON.stringify([1,room,'focus-block-rollup',1,'javascript']);
  return {key,update,queues:{[key]:{updated_at:Date.now(),updates:[update]}}};
}

test('authorized primary hydration migrates, restores and submits a legacy queued edit with the flag off',async()=>{
  const {key,update,queues}=queuedEdit();
  const {crdt,textarea,fetches,storage}=harness({circlePublicId:'primary-circle',queues});
  const activation=crdt.activate();
  await waitFor(()=>fetches.length===1);
  // Before server authorization the saved queue remains in its old namespace.
  assert.ok(JSON.parse(storage.get('randori-crdt-pending-v1'))[key]);
  fetches[0].resolve({ok:true,status:200,json:async()=>({ok:true,revision:1,document_version:VERSION,state:emptyState()})});
  await waitFor(()=>fetches.length===2);
  assert.equal(textarea.value,'// saved primary edit\n');
  assert.equal(crdt.status,'syncing');
  const pending=JSON.parse(storage.get('randori-crdt-pending-v1'));
  assert.equal(pending[key],undefined);
  assert.deepEqual(pending[JSON.stringify([1,'primary-circle',ROOM,'focus-block-rollup',1,'javascript'])].updates,[update]);
  assert.equal(fetches[1].options.method,'POST');
  const submitted=JSON.parse(fetches[1].options.body);
  assert.equal(submitted.room_id,ROOM);
  const restored=new Y.Doc();Y.applyUpdate(restored,Buffer.from(submitted.update,'base64'));
  assert.equal(restored.getText('code').toString(),'// saved primary edit\n');restored.destroy();
  fetches[1].resolve({ok:true,status:200,json:async()=>({ok:true,revision:2,document_version:VERSION,state:update})});
  assert.equal(await activation,true);
  assert.equal(crdt.acknowledged,true);
  assert.deepEqual(JSON.parse(storage.get('randori-crdt-pending-v1')),{});
});

test('legacy queues remain inaccessible until authorized hydration and never migrate into secondary rooms',async()=>{
  const legacy=queuedEdit();
  const denied=harness({queues:legacy.queues});
  const activation=denied.crdt.activate();
  await waitFor(()=>denied.fetches.length===1);
  denied.fetches[0].resolve({ok:false,status:404,json:async()=>({error:'pair not found'})});
  assert.equal(await activation,false);
  assert.ok(JSON.parse(denied.storage.get('randori-crdt-pending-v1'))[legacy.key]);
  assert.equal(denied.fetches.length,1);

  const secondaryLegacy=queuedEdit('circle_20_publication_1_group_1');
  const secondary=harness({room:'circle_20_publication_1_group_1',circlePublicId:'secondary-circle',queues:{...legacy.queues,...secondaryLegacy.queues}});
  const second=secondary.crdt.activate();
  await waitFor(()=>secondary.fetches.length===1);
  secondary.fetches[0].resolve({ok:true,status:200,json:async()=>({ok:true,revision:1,document_version:VERSION,state:emptyState()})});
  assert.equal(await second,true);
  assert.equal(secondary.textarea.value,'');
  assert.equal(secondary.fetches.length,1);
  assert.ok(JSON.parse(secondary.storage.get('randori-crdt-pending-v1'))[secondaryLegacy.key]);
  assert.ok(JSON.parse(secondary.storage.get('randori-crdt-pending-v1'))[legacy.key]);
});
