// #462 / ID-100: presence indicator and partner cursor rendering. Pure DOM,
// textContent only; nothing here moves the local caret, selection or scroll.
// Styles are injected by this lazily loaded bundle so the initial CSS budget
// is untouched.
const COLOR=/^#[0-9a-fA-F]{6}$/;
const DEFAULT_COLOR='#9cc0b5';
const STYLE_ID='rcPresenceStyle';
const LAYER_ID='rcRemoteCursorLayer';
const ANNOUNCER_ID='presenceAnnouncer';
const MIRRORED=['boxSizing','borderTopWidth','borderRightWidth','borderBottomWidth','borderLeftWidth','borderStyle',
  'paddingTop','paddingRight','paddingBottom','paddingLeft','fontFamily','fontSize','fontWeight','fontStyle',
  'lineHeight','letterSpacing','tabSize','textIndent','textTransform','wordSpacing'];

// The dashboard's cached pair wins; a direct /join link has none, so the
// presence join reply supplies the same already-visible partner fields.
export function partnerIdentity(room,pair=globalThis.window?._randori_pair_cache,fallback=null){
  const cached=pair&&pair.room_id===room&&pair.partner&&typeof pair.partner==='object'?pair.partner:null;
  const partner=cached||(fallback&&typeof fallback==='object'?fallback:null);
  const raw=typeof partner?.display_name==='string'&&partner.display_name.trim()?partner.display_name
    :typeof partner?.name==='string'?partner.name:'';
  const name=raw.replace(/\s+/g,' ').trim().slice(0,60)||'Your partner';
  return {name,color:COLOR.test(String(partner?.color||''))?partner.color:DEFAULT_COLOR};
}

function soft(color){
  const value=parseInt(color.slice(1),16);
  return `rgba(${value>>16&255},${value>>8&255},${value&255},0.32)`;
}

export function lineOf(text,offset){
  let line=1;
  for(let index=0;index<offset&&index<text.length;index+=1) if(text.charCodeAt(index)===10) line+=1;
  return line;
}

// The single sentence shown in the room bar. `presence` is the merged view:
// here (live awareness) | online (HTTPS fallback) | away | unknown.
export function presenceLabel({name,presence,status=null,line=null,health}){
  const parts=[presence==='here'?`${name} is here`:presence==='online'?`${name} online`
    :presence==='away'?`${name} not in the room`:`Checking for ${name}…`];
  if(presence==='here'&&status==='idle') parts.push('idle');
  if(presence==='here'&&Number.isSafeInteger(line)) parts.push(`line ${line}`);
  parts.push(health==='live'?'live':health==='offline'?'reconnecting':'polling');
  return parts.join(' · ');
}

export function createPresenceView({document=globalThis.document,window=globalThis.window,room,partner=()=>null}={}){
  const identity=()=>partnerIdentity(room,window?._randori_pair_cache,partner());
  let destroyed=false,lastPresent=null,decorations=null,layer=null,announcer=null,styleColor=null;
  const byId=key=>{ try{ return document?.getElementById?.(key)||null; }catch{ return null; } };
  const create=(tag)=>{ try{ return document?.createElement?.(tag)||null; }catch{ return null; } };
  const ensureStyle=color=>{
    if(styleColor===color) return;
    let style=byId(STYLE_ID);
    if(!style){ style=create('style'); if(!style) return; style.id=STYLE_ID; document.head?.appendChild?.(style); }
    styleColor=color;
    // Colour is validated as #rrggbb above; nothing else is interpolated.
    style.textContent=`#roomPanel-code{position:relative}`
      +`.rc-remote-selection{background:${soft(color)}}`
      +`.rc-remote-caret{position:relative;display:inline-block;width:0;height:1.25em;margin-left:-1px;`
      +`border-left:2px solid ${color};vertical-align:text-bottom}`
      +`#${LAYER_ID}{position:absolute;overflow:hidden;pointer-events:none;color:transparent;`
      +`white-space:pre-wrap;overflow-wrap:break-word;border-color:transparent;background:transparent;z-index:1}`;
  };
  // Live region on <body>: the room-bar chip is display:none on phones and a
  // hidden live region is never announced.
  const ensureAnnouncer=()=>{
    const host=document?.body;
    if(announcer||!host) return announcer;
    announcer=byId(ANNOUNCER_ID)||create('span');
    if(!announcer) return null;
    announcer.id=ANNOUNCER_ID; announcer.className='sr-only';
    announcer.setAttribute?.('role','status'); announcer.setAttribute?.('aria-live','polite');
    if(!announcer.parentNode) host.appendChild?.(announcer);
    return announcer;
  };
  const clearMonaco=()=>{ try{ decorations?.clear?.(); }catch{} decorations=null; };
  const clearLayer=()=>{ try{ layer?.remove?.(); }catch{} layer=null; };
  const renderMonaco=(editor,selection)=>{
    const monaco=window?.monaco,model=editor?.getModel?.();
    if(!monaco?.Range||!model||typeof editor.createDecorationsCollection!=='function'){ clearMonaco(); return false; }
    const items=[];
    if(selection){
      const start=model.getPositionAt(Math.min(selection.anchor,selection.head));
      const end=model.getPositionAt(Math.max(selection.anchor,selection.head));
      const head=model.getPositionAt(selection.head);
      if(selection.anchor!==selection.head) items.push({range:new monaco.Range(start.lineNumber,start.column,end.lineNumber,end.column),
        options:{className:'rc-remote-selection',stickiness:1}});
      items.push({range:new monaco.Range(head.lineNumber,head.column,head.lineNumber,head.column),
        options:{beforeContentClassName:'rc-remote-caret',stickiness:1}});
    }
    try{
      if(!decorations) decorations=editor.createDecorationsCollection(items); else decorations.set(items);
    }catch{ clearMonaco(); }
    return true;
  };
  const renderTextarea=(textarea,selection)=>{
    const visible=textarea&&textarea.style?.display!=='none'&&textarea.offsetParent!==null&&textarea.offsetParent!==undefined;
    if(!selection||!visible||typeof window?.getComputedStyle!=='function'){ clearLayer(); return; }
    if(!layer){
      layer=create('div'); if(!layer) return;
      layer.id=LAYER_ID; layer.setAttribute?.('aria-hidden','true'); layer.dataset.testid='remote-cursor-layer';
      textarea.insertAdjacentElement?.('afterend',layer);
    }
    const computed=window.getComputedStyle(textarea);
    for(const property of MIRRORED) layer.style[property]=computed[property];
    Object.assign(layer.style,{top:`${textarea.offsetTop}px`,left:`${textarea.offsetLeft}px`,
      width:`${textarea.offsetWidth}px`,height:`${textarea.offsetHeight}px`});
    const value=String(textarea.value||'');
    const start=Math.min(selection.anchor,selection.head),end=Math.max(selection.anchor,selection.head);
    const inner=create('div'),before=document.createTextNode(value.slice(0,start));
    inner.style.transform=`translate(${-textarea.scrollLeft||0}px,${-textarea.scrollTop||0}px)`;
    const caret=create('span'); caret.className='rc-remote-caret'; caret.dataset.testid='remote-cursor';
    caret.dataset.offset=String(selection.head);
    const parts=[before];
    if(end>start){
      const mark=create('span'); mark.className='rc-remote-selection'; mark.dataset.testid='remote-selection';
      mark.textContent=value.slice(start,end);
      parts.push(...(selection.head<=selection.anchor?[caret,mark]:[mark,caret]));
    }else parts.push(caret);
    // Trailing text keeps wrapping identical to the textarea's own layout.
    parts.push(document.createTextNode(value.slice(end)||' '));
    inner.replaceChildren(...parts);
    layer.replaceChildren(inner);
  };
  return {
    // view: {presence, status, selection:{anchor,head}|null, health, text}
    render(view){
      if(destroyed) return;
      const {name,color}=identity();
      ensureStyle(color);
      const label=byId('presenceText'),host=label?.parentElement||null;
      const line=view.presence==='here'&&view.selection?lineOf(String(view.text||''),view.selection.head):null;
      if(label) label.textContent=presenceLabel({name,presence:view.presence,status:view.status,line,health:view.health});
      if(host?.dataset){ host.dataset.partner=view.presence; host.dataset.health=view.health; }
      const dot=host?.querySelector?.('.dot');
      if(dot?.style) dot.style.background=view.presence==='here'||view.presence==='online'?color:'';
      // Announce joins/leaves only, never per heartbeat or cursor move.
      const present=view.presence==='here'||view.presence==='online'?true:view.presence==='away'?false:null;
      if(present!==null&&present!==lastPresent){
        const target=ensureAnnouncer();
        if(target&&(lastPresent!==null||present)) target.textContent=present?`${name} joined the room`:`${name} left the room`;
        lastPresent=present;
      }
      const cursor=view.presence==='here'?view.selection:null;
      const editor=window?._randori_code?.getEditor?.();
      if(!renderMonaco(editor,cursor)) renderTextarea(byId('editor'),cursor); else clearLayer();
    },
    destroy(){
      if(destroyed) return;
      destroyed=true; clearMonaco(); clearLayer();
      const label=byId('presenceText'),host=label?.parentElement||null;
      if(host?.dataset){ delete host.dataset.partner; delete host.dataset.health; }
      const dot=host?.querySelector?.('.dot'); if(dot?.style) dot.style.background='';
      if(announcer) announcer.textContent='';
      try{ window?._randori_refresh_presence?.(); }catch{}
    },
  };
}
