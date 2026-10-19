import * as Y from 'yjs';
import { MonacoBinding } from 'y-monaco';

const PENDING_KEY='randori-crdt-pending-v1';
const CLIENT_KEY='randori-crdt-client-v1';
const POLL_MS=1200;
const SEND_DEBOUNCE_MS=120;
const AWAIT_PREREQUISITES_MS=500;
const RETRY_MAX_MS=8000;
const QUEUE_RETENTION_MS=90*24*60*60*1000;
const MAX_UPDATE_BYTES=64*1024;
const VERSION=/^[a-f0-9]{64}$/;
const ROOM=/^week_[1-9]\d*_pair_[1-9]\d*$/;
const ORIGIN_REMOTE=Symbol('remote');
const ORIGIN_PENDING=Symbol('pending');
const memoryQueues=new Map();
const state={epoch:0,room:null,identity:null,actorId:null,doc:null,text:null,binding:null,
  textObserver:null,textareaHandler:null,textareaKeyHandler:null,updateHandler:null,undoManager:null,revision:0,version:null,
  hydrated:false,inFlight:false,controller:null,pollTimer:null,retryMs:500,status:'local',completed:false,
  awaitingRoom:false,hydrationLockEpoch:null};

function actorId(){
  const id=Number(window._randori_auth?.me?.id||window._randori_auth?.me?.uid||0);
  return Number.isSafeInteger(id)&&id>0?id:null;
}

function selectionIdentity(room=window._randori_workspace?.room){
  const selection=window._randori_questions?.selectedIdentity?.();
  const version=Number(selection?.version);
  const language=String(document.getElementById('langSelect')?.value||'');
  if(!ROOM.test(String(room||''))||typeof selection?.slug!=='string'||!selection.slug
    ||!Number.isSafeInteger(version)||version<1||!['javascript','python'].includes(language)) return null;
  return {room:String(room),questionSlug:selection.slug,questionVersion:version,language};
}

function identityKey(identity,owner=actorId()){
  return JSON.stringify([owner,identity.room,identity.questionSlug,identity.questionVersion,identity.language]);
}

function sameIdentity(left,right){
  return !!left&&!!right&&left.room===right.room&&left.questionSlug===right.questionSlug
    &&left.questionVersion===right.questionVersion&&left.language===right.language;
}

function bytesToBase64(bytes){
  let binary='';
  for(let offset=0;offset<bytes.length;offset+=0x8000){
    binary+=String.fromCharCode(...bytes.subarray(offset,offset+0x8000));
  }
  return btoa(binary);
}

function base64ToBytes(value){
  const binary=atob(value); const bytes=new Uint8Array(binary.length);
  for(let index=0;index<binary.length;index+=1) bytes[index]=binary.charCodeAt(index);
  return bytes;
}

function readQueue(identity=state.identity){
  if(!identity||!state.actorId) return [];
  const key=identityKey(identity,state.actorId);
  if(memoryQueues.has(key)) return [...memoryQueues.get(key)];
  try{
    const all=JSON.parse(localStorage.getItem(PENDING_KEY)||'{}');
    const entry=all[key];
    if(!entry||typeof entry!=='object'||Array.isArray(entry)||!Array.isArray(entry.updates)
      ||!Number.isSafeInteger(entry.updated_at)||Date.now()-entry.updated_at>=QUEUE_RETENTION_MS){
      if(Object.prototype.hasOwnProperty.call(all,key)){ delete all[key]; localStorage.setItem(PENDING_KEY,JSON.stringify(all)); }
      return [];
    }
    const queue=entry.updates.filter(item=>typeof item==='string');
    memoryQueues.set(key,queue);
    return [...queue];
  }catch{ return []; }
}

function compactQueue(queue){
  const compact=[];
  for(const encoded of queue){
    if(typeof encoded!=='string') continue;
    if(!compact.length){ compact.push(encoded); continue; }
    try{
      const merged=Y.mergeUpdates([base64ToBytes(compact[compact.length-1]),base64ToBytes(encoded)]);
      if(merged.byteLength<=MAX_UPDATE_BYTES){ compact[compact.length-1]=bytesToBase64(merged); continue; }
    }catch{}
    compact.push(encoded);
  }
  return compact;
}

function writeQueue(queue,identity=state.identity){
  if(!identity||!state.actorId) return false;
  const key=identityKey(identity,state.actorId); const compact=compactQueue(queue);
  if(compact.length) memoryQueues.set(key,compact); else memoryQueues.delete(key);
  try{
    const all=JSON.parse(localStorage.getItem(PENDING_KEY)||'{}');
    if(compact.length) all[key]={updated_at:Date.now(),updates:compact}; else delete all[key];
    localStorage.setItem(PENDING_KEY,JSON.stringify(all));
    return true;
  }catch{ return false; }
}

function purgeExpiredQueues(){
  try{
    const all=JSON.parse(localStorage.getItem(PENDING_KEY)||'{}'); let changed=false;
    for(const [key,entry] of Object.entries(all)){
      if(!entry||typeof entry!=='object'||Array.isArray(entry)||!Array.isArray(entry.updates)
        ||!Number.isSafeInteger(entry.updated_at)||Date.now()-entry.updated_at>=QUEUE_RETENTION_MS){
        delete all[key]; changed=true;
      }
    }
    if(changed) localStorage.setItem(PENDING_KEY,JSON.stringify(all));
  }catch{ try{ localStorage.removeItem(PENDING_KEY); }catch{} }
}

function clearActorQueue(owner){
  if(!owner) return;
  for(const key of memoryQueues.keys()){
    try{ if(JSON.parse(key)[0]===owner) memoryQueues.delete(key); }catch{ memoryQueues.delete(key); }
  }
  try{
    const all=JSON.parse(localStorage.getItem(PENDING_KEY)||'{}');
    for(const key of Object.keys(all)){
      try{ if(JSON.parse(key)[0]===owner) delete all[key]; }catch{ delete all[key]; }
    }
    localStorage.setItem(PENDING_KEY,JSON.stringify(all));
  }catch{}
}

function clearLegacyDraft(identity){
  try{
    const all=JSON.parse(localStorage.getItem('randori-code')||'{}');
    const entry=all[identity.room];
    if(!entry||typeof entry!=='object') return;
    if(entry.codes&&typeof entry.codes==='object') delete entry.codes[identity.language];
    entry.lang=identity.language; entry.qId=identity.questionSlug; entry.qVersion=identity.questionVersion;
    all[identity.room]=entry; localStorage.setItem('randori-code',JSON.stringify(all));
  }catch{}
}

function clientId(){
  try{
    let value=localStorage.getItem(CLIENT_KEY)||'';
    if(!/^[A-Za-z0-9_-]{8,64}$/.test(value)){
      value=(crypto.randomUUID?.()||`client-${Math.random().toString(36).slice(2)}`).replaceAll('-','_');
      localStorage.setItem(CLIENT_KEY,value);
    }
    return value;
  }catch{ return `client_${Math.random().toString(36).slice(2)}`; }
}

const stableClientId=clientId();
purgeExpiredQueues();
let clientSeq=0;

function setStatus(value,message=''){
  if(state.completed&&value!=='error') return;
  state.status=value;
  const node=document.getElementById('codeSyncStatus');
  const labels={local:'local editor',connecting:'connecting…',syncing:'syncing…',synced:'synced',offline:'offline — changes queued',retry:'sync interrupted — retrying',error:'sync unavailable'};
  if(node){ node.dataset.state=value; node.textContent=message||labels[value]||value; }
  const run=document.getElementById('runBtn');
  if(run&&(state.identity||state.awaitingRoom)) run.disabled=!isAcknowledged();
  window.dispatchEvent(new CustomEvent('randori:code-sync-state',{detail:{room:state.room,state:value,acknowledged:isAcknowledged()}}));
}

function isAcknowledged(){
  return !!state.identity&&state.hydrated&&!state.inFlight&&readQueue().length===0
    &&VERSION.test(String(state.version||''))&&state.status==='synced'&&!state.completed;
}

function setEditorReadOnly(readOnly){
  try{ window._randori_code?.getEditor?.()?.updateOptions?.({readOnly}); }catch{}
  const textarea=document.getElementById('editor'); if(textarea) textarea.readOnly=readOnly;
}

function completeIdentity(){
  const identity=state.identity;
  state.completed=true;
  if(identity) writeQueue([],identity);
  disposeDocument();
  setEditorReadOnly(true);
  setStatus('error','session completed — editing closed');
}

function currentCode(){
  try{ return String(window._randori_code?.getCode?.()??document.getElementById('editor')?.value??''); }
  catch{ return String(document.getElementById('editor')?.value||''); }
}

function replaceText(next,origin){
  if(!state.text||state.text.toString()===next) return;
  const previous=state.text.toString();
  let prefix=0;
  while(prefix<previous.length&&prefix<next.length&&previous[prefix]===next[prefix]) prefix+=1;
  let suffix=0;
  while(suffix<previous.length-prefix&&suffix<next.length-prefix
    &&previous[previous.length-1-suffix]===next[next.length-1-suffix]) suffix+=1;
  state.doc.transact(()=>{
    const remove=previous.length-prefix-suffix;
    if(remove) state.text.delete(prefix,remove);
    const insert=next.slice(prefix,next.length-suffix);
    if(insert) state.text.insert(prefix,insert);
  },origin);
}

function attachEditor(epoch){
  if(epoch!==state.epoch||!state.text) return;
  state.binding?.destroy?.(); state.binding=null;
  const textarea=document.getElementById('editor');
  if(state.textObserver) state.text.unobserve(state.textObserver);
  if(state.textareaHandler&&textarea) textarea.removeEventListener('input',state.textareaHandler);
  if(state.textareaKeyHandler&&textarea) textarea.removeEventListener('keydown',state.textareaKeyHandler);
  state.undoManager?.destroy?.(); state.undoManager=null;
  const editor=window._randori_code?.getEditor?.();
  if(editor?.getModel?.()&&window.monaco){
    state.binding=new MonacoBinding(state.text,editor.getModel(),new Set([editor]),null);
  }else if(textarea){
    textarea.value=state.text.toString();
    state.undoManager=new Y.UndoManager(state.text,{trackedOrigins:new Set(['textarea']),captureTimeout:500});
    state.textObserver=(event,transaction)=>{
      if(transaction.origin==='textarea') return;
      const next=state.text?.toString()||'';
      if(textarea.value!==next){
        const transform=offset=>{
          let oldOffset=0,newOffset=0;
          for(const operation of event.delta||[]){
            if(operation.retain){
              if(offset<oldOffset+operation.retain) return newOffset+(offset-oldOffset);
              oldOffset+=operation.retain; newOffset+=operation.retain;
            }else if(operation.insert!==undefined){
              newOffset+=typeof operation.insert==='string'?operation.insert.length:1;
            }else if(operation.delete){
              if(offset<=oldOffset+operation.delete) return newOffset;
              oldOffset+=operation.delete;
            }
          }
          return newOffset+Math.max(0,offset-oldOffset);
        };
        const start=Math.min(transform(textarea.selectionStart||0),next.length);
        const end=Math.min(transform(textarea.selectionEnd??start),next.length);
        textarea.value=next; textarea.setSelectionRange?.(start,end);
      }
    };
    state.text.observe(state.textObserver);
    state.textareaHandler=()=>replaceText(textarea.value,'textarea');
    state.textareaKeyHandler=event=>{
      const modifier=event.metaKey||event.ctrlKey;
      if(!modifier||event.altKey) return;
      if(event.key.toLowerCase()==='z'){
        event.preventDefault();
        if(event.shiftKey) state.undoManager?.redo(); else state.undoManager?.undo();
      }else if(event.key.toLowerCase()==='y'){
        event.preventDefault(); state.undoManager?.redo();
      }
    };
    textarea.addEventListener('input',state.textareaHandler);
    textarea.addEventListener('keydown',state.textareaKeyHandler);
  }
}

function endpoint(identity,{afterRevision=0}={}){
  const url=new URL('/api/code-document',location.origin);
  url.searchParams.set('room_id',identity.room);
  url.searchParams.set('question_slug',identity.questionSlug);
  url.searchParams.set('question_version',String(identity.questionVersion));
  url.searchParams.set('language',identity.language);
  url.searchParams.set('after_revision',String(afterRevision));
  return url;
}

function matches(epoch,identity,owner=state.actorId){
  return epoch===state.epoch&&owner===actorId()&&owner===state.actorId&&sameIdentity(identity,state.identity)
    &&document.visibilityState==='visible'&&!state.completed;
}

function acceptResponse(data,epoch,identity,{apply=true}={}){
  if(!matches(epoch,identity)||data?.ok!==true||!Number.isSafeInteger(Number(data.revision))
    ||!VERSION.test(String(data.document_version||''))) return false;
  if(apply&&data.changed!==false){
    if(typeof data.state!=='string') return false;
    Y.applyUpdate(state.doc,base64ToBytes(data.state),ORIGIN_REMOTE);
  }
  state.revision=Number(data.revision); state.version=data.document_version;
  return true;
}

function schedule(delay=POLL_MS){
  if(state.pollTimer!==null) clearTimeout(state.pollTimer);
  if(!state.identity||document.visibilityState!=='visible'||state.completed) return;
  state.pollTimer=setTimeout(()=>{ state.pollTimer=null; poll(); },delay);
}

async function fetchJson(url,options,epoch,identity){
  const controller=new AbortController(); state.controller?.abort(); state.controller=controller;
  const timeout=setTimeout(()=>controller.abort(),8000);
  try{
    const response=await fetch(url,{credentials:'same-origin',cache:'no-store',...options,signal:controller.signal});
    const data=await response.json().catch(()=>({}));
    if(!matches(epoch,identity)) return {stale:true};
    return {response,data};
  }finally{
    clearTimeout(timeout); if(state.controller===controller) state.controller=null;
  }
}

function releaseHydrationLock(epoch){
  // Only the newest hydration owns the lock; a stale attempt must not unlock
  // an editor that a later hydration has locked again.
  if(state.hydrationLockEpoch!==epoch) return;
  state.hydrationLockEpoch=null;
  if(!state.completed) setEditorReadOnly(false);
}

async function hydrate(identity,epoch){
  setStatus(navigator.onLine?'connecting':'offline');
  if(!navigator.onLine) return false;
  // Keystrokes made while the canonical document is in flight would be
  // replayed as a diff against it and could delete partner edits.
  state.hydrationLockEpoch=epoch; setEditorReadOnly(true);
  const localBefore=currentCode();
  try{
    const result=await fetchJson(endpoint(identity),{},epoch,identity);
    if(result.stale) return false;
    if(result.response.status===401||result.response.status===404){ deactivate(); return false; }
    if(!result.response.ok) throw new Error(result.data.error||'code document unavailable');
    const doc=new Y.Doc({gc:true}); const text=doc.getText('code');
    Y.applyUpdate(doc,base64ToBytes(result.data.state),ORIGIN_REMOTE);
    if(!matches(epoch,identity)) { doc.destroy(); return false; }
    state.doc=doc; state.text=text; state.hydrated=true; state.revision=Number(result.data.revision);
    state.version=result.data.document_version;
    state.updateHandler=(update,origin)=>{
      if(state.completed||origin===ORIGIN_REMOTE||origin===ORIGIN_PENDING||!sameIdentity(identity,state.identity)) return;
      const queue=readQueue(identity); queue.push(bytesToBase64(update));
      const persisted=writeQueue(queue,identity);
      if(!persisted&&!navigator.onLine) setStatus('error','not saved locally — keep this tab open');
      else setStatus(navigator.onLine?'syncing':'offline');
      schedule(SEND_DEBOUNCE_MS);
    };
    doc.on('update',state.updateHandler);
    for(const pending of readQueue(identity)) Y.applyUpdate(doc,base64ToBytes(pending),ORIGIN_PENDING);
    const localNow=currentCode();
    if(localNow!==localBefore&&localNow!==text.toString()) replaceText(localNow,'pre-hydration-edit');
    attachEditor(epoch);
    releaseHydrationLock(epoch);
    if(readQueue(identity).length) { setStatus(navigator.onLine?'syncing':'offline'); await drain(); }
    else setStatus('synced');
    clearLegacyDraft(identity);
    schedule();
    window.dispatchEvent(new CustomEvent('randori:code-document-hydrated',{detail:{room:identity.room,revision:state.revision}}));
    return true;
  }catch(error){
    if(matches(epoch,identity)){ setStatus(navigator.onLine?'retry':'offline'); schedule(state.retryMs); state.retryMs=Math.min(state.retryMs*2,RETRY_MAX_MS); }
    return false;
  }finally{ releaseHydrationLock(epoch); }
}

async function drain(){
  const identity=state.identity,epoch=state.epoch;
  if(!identity||!state.hydrated||state.inFlight||!navigator.onLine||state.completed) return false;
  const queue=readQueue(identity); if(!queue.length){ setStatus('synced'); return true; }
  state.inFlight=true; setStatus('syncing');
  const update=queue[0];
  try{
    const result=await fetchJson('/api/code-document',{
      method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({
        room_id:identity.room,question_slug:identity.questionSlug,question_version:identity.questionVersion,
        language:identity.language,update,client_id:stableClientId,client_seq:++clientSeq,
      }),
    },epoch,identity);
    if(result.stale) return false;
    if(result.response.status===401||result.response.status===404){ deactivate(); return false; }
    if(result.response.status===409&&result.data.code==='session_completed'){
      completeIdentity(); return false;
    }
    if(!result.response.ok) throw new Error(result.data.error||'code sync failed');
    if(!acceptResponse(result.data,epoch,identity)) throw new Error('invalid code document response');
    const remaining=readQueue(identity); if(remaining[0]===update) remaining.shift(); writeQueue(remaining,identity);
    state.retryMs=500;
    return true;
  }catch{
    if(matches(epoch,identity)) setStatus(navigator.onLine?'retry':'offline');
    return false;
  }finally{
    if(epoch===state.epoch) state.inFlight=false;
    if(matches(epoch,identity)){
      if(readQueue(identity).length&&navigator.onLine) schedule(state.status==='retry'?state.retryMs:0);
      else if(!readQueue(identity).length) setStatus('synced');
    }
  }
}

async function poll(){
  const identity=state.identity,epoch=state.epoch;
  if(!identity||!state.hydrated||document.visibilityState!=='visible'||state.completed) return;
  if(readQueue(identity).length){ await drain(); schedule(state.status==='retry'?state.retryMs:POLL_MS); return; }
  if(!navigator.onLine){ setStatus('offline'); schedule(); return; }
  try{
    const result=await fetchJson(endpoint(identity,{afterRevision:state.revision}),{},epoch,identity);
    if(result.stale) return;
    if(result.response.status===401||result.response.status===404){ deactivate(); return; }
    if(!result.response.ok) throw new Error(result.data.error||'poll failed');
    if(!acceptResponse(result.data,epoch,identity,{apply:result.data.changed!==false})) throw new Error('invalid poll response');
    state.retryMs=500; setStatus('synced');
  }catch{ if(matches(epoch,identity)) setStatus(navigator.onLine?'retry':'offline'); }
  schedule(state.status==='retry'?state.retryMs:POLL_MS);
}

function disposeDocument(){
  state.controller?.abort(); state.controller=null;
  if(state.pollTimer!==null){ clearTimeout(state.pollTimer); state.pollTimer=null; }
  state.binding?.destroy?.(); state.binding=null;
  const textarea=document.getElementById('editor');
  if(state.text&&state.textObserver) state.text.unobserve(state.textObserver);
  if(textarea&&state.textareaHandler) textarea.removeEventListener('input',state.textareaHandler);
  if(textarea&&state.textareaKeyHandler) textarea.removeEventListener('keydown',state.textareaKeyHandler);
  if(state.doc&&state.updateHandler) state.doc.off('update',state.updateHandler);
  state.undoManager?.destroy?.(); state.undoManager=null;
  state.doc?.destroy?.(); state.doc=null; state.text=null; state.textObserver=null; state.textareaHandler=null; state.textareaKeyHandler=null; state.updateHandler=null;
  state.hydrated=false; state.inFlight=false; state.revision=0; state.version=null;
}

function deactivate({keepIdentity=false,awaitingRoom=false}={}){
  state.epoch+=1; disposeDocument();
  state.awaitingRoom=awaitingRoom;
  if(!keepIdentity){ state.room=null; state.identity=null; state.actorId=null; state.completed=false; setEditorReadOnly(false); setStatus(awaitingRoom?'connecting':'local'); }
  else setStatus(navigator.onLine?'connecting':'offline');
  const run=document.getElementById('runBtn'); if(run&&!state.identity&&!state.awaitingRoom) run.disabled=false;
}

function fenceIdentityChange(room=window._randori_authorized_room){
  room=String(room||'');
  deactivate({awaitingRoom:ROOM.test(room)&&window._randori_authorized_room===room&&!!actorId()});
}

async function activate(){
  const identity=selectionIdentity(); const owner=actorId();
  if(!owner||!identity||window._randori_workspace?.hydrated!==true
    ||window._randori_workspace?.room!==identity.room||window._randori_authorized_room!==identity.room){
    const room=String(window._randori_authorized_room||'');
    const awaiting=!!owner&&ROOM.test(room);
    deactivate({awaitingRoom:awaiting});
    // A first-ever room hydrates with no workspace snapshot, so no selection
    // event follows once the catalogue selection or workspace checkpoint
    // becomes available. Re-check on a bounded cadence while this exact
    // awaiting epoch is current; any fence, room change, or sign-out bumps
    // the epoch and stops the loop.
    if(awaiting){
      const awaitingEpoch=state.epoch;
      setTimeout(()=>{
        if(awaitingEpoch===state.epoch&&state.awaitingRoom&&document.visibilityState!=='hidden') activate();
      },AWAIT_PREREQUISITES_MS);
    }
    return false;
  }
  if(sameIdentity(identity,state.identity)&&owner===state.actorId&&state.hydrated) return true;
  // The v3 workspace owns code until its exact selection checkpoint is
  // acknowledged. Do not claim CRDT ownership early: doing so would suppress
  // the workspace text write and let an empty bootstrap replace local edits.
  deactivate({awaitingRoom:true});
  const activationEpoch=state.epoch;
  const canApply=()=>activationEpoch===state.epoch&&owner===actorId()
    &&sameIdentity(identity,selectionIdentity())
    &&window._randori_workspace?.hydrated===true
    &&window._randori_workspace?.room===identity.room
    &&window._randori_authorized_room===identity.room;
  if(window._randori_session_completion?.completion?.state==='completed'){
    state.awaitingRoom=false; state.room=identity.room; state.identity=identity; state.actorId=owner;
    completeIdentity(); return false;
  }
  let checkpointed=false;
  try{ checkpointed=await window._randori_workspace?.flush?.(4000,canApply)===true; }catch{}
  if(!checkpointed){
    if(canApply()){
      setStatus(navigator.onLine?'retry':'offline','waiting for workspace acknowledgement');
      setTimeout(()=>{ if(activationEpoch===state.epoch) activate(); },state.retryMs);
    }
    return false;
  }
  if(!canApply()) return false;
  state.awaitingRoom=false; state.room=identity.room; state.identity=identity; state.actorId=owner;
  const epoch=++state.epoch;
  return hydrate(identity,epoch);
}

async function flush(timeoutMs=12000){
  const identity=state.identity,epoch=state.epoch; const deadline=Date.now()+timeoutMs;
  if(!identity||!state.hydrated||state.completed) return null;
  while(Date.now()<deadline&&matches(epoch,identity)){
    if(readQueue(identity).length&&!state.inFlight) await drain();
    if(!state.inFlight&&readQueue(identity).length===0&&VERSION.test(String(state.version||''))){
      setStatus('synced'); return state.version;
    }
    await new Promise(resolve=>setTimeout(resolve,25));
  }
  return null;
}

function scheduleActivation(){ setTimeout(()=>{ activate(); },0); }
window.addEventListener('randori:workspace-hydrated',scheduleActivation);
window.addEventListener('randori:room-change',event=>{
  const room=String(event.detail?.roomId||'');
  fenceIdentityChange(room);
  scheduleActivation();
});
window.addEventListener('randori:workspace-deactivated',()=>deactivate());
window.addEventListener('randori:workspace-selection-applied',scheduleActivation);
window.addEventListener('randori:monaco-ready',()=>{ if(state.hydrated) attachEditor(state.epoch); });
window.addEventListener('randori:auth-refreshed',scheduleActivation);
window.addEventListener('randori:completion-observed',event=>{
  if(event.detail?.room===state.room&&event.detail?.state==='completed'){
    completeIdentity();
  }
});
document.getElementById('questionSelect')?.addEventListener('change',scheduleActivation);
document.getElementById('langSelect')?.addEventListener('change',scheduleActivation);
document.getElementById('questionSelect')?.addEventListener('change',()=>fenceIdentityChange(),true);
document.getElementById('langSelect')?.addEventListener('change',()=>fenceIdentityChange(),true);
document.addEventListener('visibilitychange',()=>{
  if(document.visibilityState==='visible') activate();
  else if(state.identity){ state.epoch+=1; disposeDocument(); setStatus('offline','paused while this tab is hidden'); }
});
window.addEventListener('offline',()=>setStatus('offline'));
window.addEventListener('online',()=>{
  if(state.identity&&state.hydrated){ setStatus('connecting'); schedule(0); }
  else if(state.identity) activate();
});
document.addEventListener('click',event=>{
  if(event.target?.closest?.('#signOutBtn,#dashSignOut,#psSignOut,#meSignOut,#meSignOutAll')){
    clearActorQueue(state.actorId); deactivate();
  }
},{capture:true});

if(document.readyState==='loading') document.addEventListener('DOMContentLoaded',scheduleActivation,{once:true});
else scheduleActivation();

window._randori_crdt={activate,deactivate,poll,flush,fence:fenceIdentityChange,
  ownsCodeFor(room){ return !!state.identity&&state.identity.room===room; },
  reconcile(){ return poll(); },get acknowledged(){ return isAcknowledged(); },
  get documentVersion(){ return isAcknowledged()?state.version:null; },get room(){ return state.room; },
  get identity(){ return state.identity?{...state.identity}:null; },get status(){ return state.status; },
};
