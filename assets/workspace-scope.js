// Workspace transport uses the existing session-circle epoch. URL values and
// browser storage identify a requested room; only server responses authorize it.
(function installWorkspaceScope(root) {
  'use strict';
  const originalFetch=root.fetch.bind(root);
  const controllers=new Set();
  const rooms=new Map();
  let generation=0;
  const ROOM=/^(?:week_([1-9]\d*)_pair_([1-9]\d*)|circle_([1-9]\d*)_publication_([1-9]\d*)_group_([1-9]\d*))$/;
  function canonicalRoom(value){
    const match=ROOM.exec(String(value||''));
    return !!match&&match.slice(1).filter(Boolean).every(id=>Number.isSafeInteger(Number(id)));
  }
  function secondaryRoom(value){ return canonicalRoom(value)&&String(value).startsWith('circle_'); }
  function enabled(){ return root._randori_auth?.capabilities?.secondaryCircleWorkspace===true; }
  function circleNode(circle){ return root.RandoriCircleUI?.circleBadgeNode?.(document,circle)||null; }
  function showRoomCircle(room){
    const record=rooms.get(room),host=document.getElementById('view-code');
    document.getElementById('workspaceCircleBadge')?.remove();
    if(!record||record.generation!==generation||root._randori_authorized_room!==room||!host) return;
    const badge=circleNode(record.circle);
    if(badge){ badge.id='workspaceCircleBadge'; badge.dataset.testid='workspace-circle'; host.prepend(badge); }
  }
  function stop(){
    generation+=1;
    for(const controller of controllers) controller.abort();
    controllers.clear(); rooms.clear();
    root._randori_crdt?.deactivate?.();
    root._randori_video?.leaveVideo?.();
    root._randori_workspace?.deactivate?.();
    root._randori_authorized_room=null;
    root._randori_join_room=null;
    document.getElementById('workspaceCircleBadge')?.remove();
    root.dispatchEvent(new CustomEvent('randori:workspace-scope-reset'));
  }
  function reset(){
    stop();
    // These maps and pending queues contain private circle data. Settings,
    // identity credentials and theme preferences have separate storage keys.
    for(let index=localStorage.length-1;index>=0;index-=1){ const key=localStorage.key(index); if(key?.startsWith('randori-board:')) localStorage.removeItem(key); }
    for(const key of ['randori-code','randori-board','randori-presence','randori-crdt-pending-v1','randori-last-room','randori-last-my-pair']){
      try{ localStorage.removeItem(key); }catch{}
    }
    root._randori_code?.setCode?.('');
    root._randori_board?.applySnapshot?.({shapes:[]},undefined,{persist:false,authoritative:true});
    const editor=document.getElementById('editor'); if(editor) editor.value='';
    try{ root._randori_code?.getEditor?.()?.setValue?.(''); }catch{}
  }
  function unavailable(){
    reset();
    const host=document.getElementById('view-code');
    let notice=document.getElementById('workspaceCircleUnavailable');
    if(!notice&&host){ notice=document.createElement('p'); notice.id='workspaceCircleUnavailable'; notice.setAttribute('role','status'); host.prepend(notice); }
    if(notice) notice.textContent='Workspace is not available in this circle yet.';
  }
  const WORKSPACE=/^\/api\/(?:history|messages|runs|execute|pair-recap|session-completion|session-controls|meeting-link|code-document|video(?:\/.*)?|ai(?:\/.*)?)$/;
  root.fetch=async function workspaceFetch(input,options={}){
    const url=new URL(typeof input==='string'||input instanceof URL?String(input):input.url,root.location.origin);
    const control=root._randori_circle_control;
    if(url.origin!==root.location.origin||!WORKSPACE.test(url.pathname)||!control) return originalFetch(input,options);
    const id=Number(root._randori_auth?.me?.id||root._randori_auth?.me?.uid||0);
    if(!id) return originalFetch(input,options);
    const started=generation,operation=await control.capturePairing(id);
    const matches=()=>started===generation&&control.matchesPairing(operation);
    if(!matches()) throw new DOMException('circle context changed','AbortError');
    const controller=new AbortController(),source=options.signal||input?.signal;
    const abort=()=>controller.abort();
    if(source?.aborted) controller.abort(); else source?.addEventListener('abort',abort,{once:true});
    controllers.add(controller);
    const headers=new Headers(options.headers||input?.headers);
    if(Number.isSafeInteger(operation.contextVersion)) headers.set('X-Randori-Circle-Context-Version',String(operation.contextVersion));
    const release=()=>{ controllers.delete(controller); source?.removeEventListener('abort',abort); };
    const check=body=>{
      if(!matches()) throw new DOMException('circle context changed','AbortError');
      if(body?.code==='circle_feature_unavailable'){ unavailable(); return body; }
      if(body?.code==='circle_context_changed'||body?.code==='active_circle_required'||body?.error==='active circle membership required'){ reset(); return body; }
      if(enabled()&&body?.ok===true){
        if(!control.matchesPairing(operation,body)) throw new DOMException('circle context changed','AbortError');
        if(body.circle&&canonicalRoom(body.room_id)){
          rooms.set(body.room_id,{circle:body.circle,generation,solo:body.recap?.pair?body.recap.pair.solo===true:rooms.get(body.room_id)?.solo===true});
          showRoomCircle(body.room_id);
        }
      }
      return body;
    };
    try{
      const response=await originalFetch(input,{...options,headers,signal:controller.signal});
      if(!matches()) throw new DOMException('circle context changed','AbortError');
      const json=response.json.bind(response),text=response.text.bind(response),clone=response.clone.bind(response);
      response.json=async()=>{ try{ return check(await json()); }finally{ release(); } };
      response.text=async()=>{ try{ const value=await text(); let body; try{ body=JSON.parse(value); }catch{} check(body); return value; }finally{ release(); } };
      response.clone=()=>{
        const copy=clone(),read=copy.json.bind(copy),readText=copy.text.bind(copy);
        copy.json=async()=>check(await read());
        copy.text=async()=>{ const value=await readText();let body;try{body=JSON.parse(value);}catch{}check(body);return value; };
        return copy;
      };
      return response;
    }catch(error){ release(); throw error; }
  };
  root.RandoriWorkspaceScope=Object.freeze({canonicalRoom,secondaryRoom,enabled,reset,showRoomCircle,
    isSolo(room){ return rooms.get(room)?.solo===true; }});
})(window);
