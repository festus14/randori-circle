export function installInterviewSession({window:root=globalThis.window,document:doc=globalThis.document}={}){
  if(!root||!doc) return null;
  let stoppedRoom=null,editorLock=null,accessEditor=null;
  const locked=new Map(),held=new Map();
  const ended=()=>root._randori_session_controls?.ended===true;
  const watcher=root.MutationObserver?new root.MutationObserver(records=>{
    for(const {target} of records) if(held.has(target)&&!target.disabled){ held.set(target,false); target.disabled=true; }
  }):null;
  const monaco=readOnly=>{ try{ root._randori_code?.getEditor?.()?.updateOptions?.({readOnly}); }catch{} };
  // Lobby/lock (#464): the candidate's selection, editor and lobby Run are
  // inert while the server says so. CRDT, when mounted, owns the editor lock.
  function access(detail){
    const gate=root._randori_session_controls,mine=!ended()&&!!gate&&detail?.room===gate.room;
    const blocked=mine&&gate.editBlocked===true,want=new Set();
    // Catalogue and kit filters can move the local selection; the room's stays the interviewer's.
    if(mine&&gate.selectionOwned===true) for(const id of ['questionSelect','langSelect','editorResetBtn','catalogSearch','catalogTrack',
      'catalogKit','catalogDifficulty','catalogType','catalogLanguage','catalogClearFilters']) want.add(id);
    if(blocked) for(const id of ['formatBtn','editorResetBtn']) want.add(id);
    if(mine&&gate.inLobby===true) want.add('runBtn');
    for(const [node,value] of held) if(!want.has(node.id)){ if(!locked.has(node)) node.disabled=value; held.delete(node); }
    for(const id of want){
      const node=doc.getElementById(id);
      if(node&&!held.has(node)){ held.set(node,node.disabled); node.disabled=true; watcher?.observe(node,{attributes:true,attributeFilter:['disabled']}); }
    }
    if(root._randori_crdt) return;
    const editor=doc.getElementById('editor');
    if(blocked){
      if(editor&&!accessEditor) accessEditor={node:editor,previous:editor.readOnly};
      if(editor) editor.readOnly=true; monaco(true);
    }else if(accessEditor){
      if(!ended()){ accessEditor.node.readOnly=accessEditor.previous; monaco(false); }
      accessEditor=null;
    }
  }
  function unlock(){
    access(null);
    stoppedRoom=null;
    for(const [node,value] of locked) node.disabled=value;
    locked.clear();
    // CRDT owns hydration/terminal locks once mounted. Without it, release
    // only the plain editor lock this coordinator acquired.
    if(editorLock&&!root._randori_crdt) editorLock.node.readOnly=editorLock.previous;
    editorLock=null;
  }
  function stop(detail){
    const room=root._randori_session_controls?.room;
    if(!ended()||detail?.room!==room) return false;
    if(stoppedRoom!==room){
      stoppedRoom=room;
      root._randori_workspace?.endInterview?.(room);
      root._randori_video?.disposeForScopeChange?.();
      root._randori_chat?.stop?.({clear:false});
      root._randori_schedule?.stop?.({clear:false});
      root._randori_pair_runs?.stop?.();
    }
    const editor=doc.getElementById('editor');
    if(editor){
      if(!editorLock) editorLock={node:editor,previous:editor.readOnly};
      editor.readOnly=true;
    }
    try{ root._randori_code?.getEditor?.()?.updateOptions?.({readOnly:true}); }catch{}
    for(const id of ['runBtn','questionSelect','langSelect','formatBtn','editorResetBtn','vidJoinBtn','chatSend','chatIn']){
      const node=doc.getElementById(id);
      if(!node) continue;
      if(!locked.has(node)) locked.set(node,node.disabled);
      node.disabled=true;
    }
    return true;
  }
  root.addEventListener('randori:interview-ended',event=>stop(event.detail));
  root.addEventListener('randori:interview-access',event=>access(event.detail));
  for(const name of ['randori:room-change','randori:workspace-scope-reset','randori:workspace-deactivated']) root.addEventListener(name,unlock);
  root.addEventListener('randori:auth-refreshed',()=>{ if(!ended()) unlock(); });
  // Module scripts may mount after initial hydration and control reconciliation.
  stop({room:root._randori_session_controls?.room});
  return Object.freeze({stop,unlock,access,get room(){return stoppedRoom;}});
}

if(typeof window!=='undefined'&&typeof document!=='undefined'){
  installInterviewSession();
  document.addEventListener('click',event=>{const button=event.target.closest('[data-toolkit]');if(button)import('./interviewer-toolkit.js').then(module=>module.openToolkit(button.dataset.toolkit));});
}
