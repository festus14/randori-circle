// Interview termination reuses the existing workspace/CRDT fences. Receipt
// confirmation stays separate: ending a timer never claims attendance.
export function installInterviewSession({window:root=globalThis.window,document:doc=globalThis.document}={}){
  if(!root||!doc) return null;
  let stoppedRoom=null,editorLock=null;
  const locked=new Map();
  const ended=()=>root._randori_session_controls?.ended===true;
  function unlock(){
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
  for(const name of ['randori:room-change','randori:workspace-scope-reset','randori:workspace-deactivated']) root.addEventListener(name,unlock);
  root.addEventListener('randori:auth-refreshed',()=>{ if(!ended()) unlock(); });
  // Module scripts may mount after initial hydration and control reconciliation.
  stop({room:root._randori_session_controls?.room});
  return Object.freeze({stop,unlock,get room(){return stoppedRoom;}});
}

if(typeof window!=='undefined'&&typeof document!=='undefined') installInterviewSession();
