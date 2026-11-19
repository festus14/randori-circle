// Embedded interview audio/video (issue #463, ID-98), behind
// DAILY_VIDEO_ENABLED. index.html imports this module only while the server
// advertises the embeddedVideo capability; otherwise the room keeps its
// existing call button and the private external meeting link.
//
// Consent first: nothing is requested from the server, no frame is created
// and no camera/microphone prompt can appear until the member reads the
// notice and clicks Join. Daily Prebuilt then runs inside a sandboxed
// cross-origin iframe and owns its own mute, camera and leave controls; the
// member's Join choices only set whether the call starts muted or with the
// camera off. Leave (and every stop condition below) unloads the frame, which
// ends capture. Calls are never recorded. Rendering uses DOM nodes and
// textContent only.
export const DAILY_FRAME_ORIGIN='https://randori-circle.daily.co';
export const ROOM_ENDPOINT='/api/video/room';
const FRAME_ALLOW='camera; microphone; autoplay; fullscreen';
const FRAME_SANDBOX='allow-scripts allow-same-origin';
// The server's longest pass (DAILY_TOKEN_MAX_TTL_SECONDS).
const MAX_PASS_SECONDS=60*60;

export const COPY=Object.freeze({
  title:'Video call',
  notice:'Talk and see each other without leaving this room. Audio and video go through Daily, our video provider, only between you and your partner. Your browser asks for camera and microphone access only after you click Join.',
  notRecorded:'Calls are not recorded by Randori or Daily.',
  camera:'Start with my camera on',
  microphone:'Start with my microphone on',
  join:'Join video call',
  cancel:'Not now',
  joining:'Connecting to the video call…',
  live:'Live. Use the controls inside the call to mute or turn your camera off. Leave ends the call on this device.',
  leave:'Leave call',
  left:'You left the video call.',
  expired:'The call reached the end of this session’s time. Join again if time remains.',
  ended:'This interview has ended, so the video call is closed.',
  completed:'This session is complete, so the video call is closed.',
  rateLimited:'Too many join attempts. Wait a few minutes and try again.',
  signedOut:'Sign in again to join the video call.',
  noRoom:'Open your pair room first.',
  solo:'Solo practice has no partner to call. Use Code and Board instead.',
  unavailable:'Built-in video is paused — use the direct call',
  fallbackLink:'Open your private meeting link',
  fallbackLinkHint:'Opens outside Randori.',
  fallbackNoLink:'You can add a private meeting link in the Session tab, or use the direct browser call.',
  legacy:'Use the direct browser call',
  frameTitle:'Video call with your pair partner',
  privacy:'How video is handled',
});

/** The provider room URL with its token, or null when anything is off. */
export function embeddedFrameUrl(payload,{expectedRoom}={}){
  if(!payload||payload.ok!==true||payload.provider!=='daily'||payload.recording!==false) return null;
  if(expectedRoom!==undefined&&payload.room_id!==expectedRoom) return null;
  if(typeof payload.token!=='string'||!/^[A-Za-z0-9._-]{16,4096}$/.test(payload.token)) return null;
  if(typeof payload.expires_at!=='string'||!Number.isFinite(Date.parse(payload.expires_at))) return null;
  if(!Number.isSafeInteger(payload.expires_in)||payload.expires_in<1||payload.expires_in>MAX_PASS_SECONDS) return null;
  let url;
  try{ url=new URL(String(payload.room_url)); }catch{ return null; }
  if(url.origin!==DAILY_FRAME_ORIGIN||!/^\/rc-[a-f0-9]{32}$/.test(url.pathname)
    ||url.search||url.hash||url.username||url.password) return null;
  url.searchParams.set('t',payload.token);
  return url.href;
}

export function mountEmbeddedVideo({window:root=globalThis.window,document:doc=globalThis.document,host}={}){
  const section=doc?.getElementById?.('embeddedVideoPanel');
  if(!root||!doc||!section||!host) return null;
  const state={phase:'idle',epoch:0,room:null,actorId:null,controller:null,timer:null,frame:null,message:''};

  function node(tag,{text='',className='',testId=''}={}){
    const element=doc.createElement(tag);
    if(text!=='') element.textContent=String(text);
    if(className) element.className=className;
    if(testId) element.dataset.testid=testId;
    return element;
  }
  function button(text,testId,className,onClick){
    const element=node('button',{text,testId,className});
    element.type='button';
    element.addEventListener('click',onClick);
    return element;
  }
  function status(text){
    const element=node('div',{className:'small muted',text,testId:'embedded-video-status'});
    element.setAttribute('role','status'); element.setAttribute('aria-live','polite');
    return element;
  }
  function shell(){
    const wrapper=node('div'); wrapper.style.cssText='display:grid;gap:8px';
    const heading=node('b',{text:COPY.title}); heading.style.fontSize='12.5px';
    wrapper.append(heading);
    return wrapper;
  }

  function releaseFrame(){
    const frame=state.frame;
    state.frame=null;
    if(!frame) return;
    // Navigate away before detaching so the provider page unloads and the
    // browser stops capture even if a reference to the frame survives.
    frame.src='about:blank';
    frame.remove();
  }

  function stop(phase='idle',message=''){
    state.epoch+=1;
    state.controller?.abort();
    state.controller=null;
    if(state.timer!==null){ root.clearTimeout(state.timer); state.timer=null; }
    releaseFrame();
    const wasActive=state.phase!=='idle';
    state.phase=phase; state.message=message;
    if(phase==='idle'){ state.room=null; state.actorId=null; }
    render();
    return wasActive;
  }

  function render(){
    section.replaceChildren();
    if(state.phase==='idle'){ section.hidden=true; return; }
    section.hidden=false;
    const content=shell();
    if(state.phase==='consent'){
      content.append(node('p',{className:'small',text:COPY.notice,testId:'embedded-video-notice'}));
      content.append(node('p',{className:'small muted',text:COPY.notRecorded}));
      const choices=node('div',{className:'row'}); choices.style.cssText='gap:12px;flex-wrap:wrap';
      const camera=node('input',{testId:'embedded-video-camera'}); camera.type='checkbox'; camera.checked=true;
      const microphone=node('input',{testId:'embedded-video-microphone'}); microphone.type='checkbox'; microphone.checked=true;
      const cameraLabel=node('label',{className:'small'}); cameraLabel.append(camera,node('span',{text:` ${COPY.camera}`}));
      const microphoneLabel=node('label',{className:'small'}); microphoneLabel.append(microphone,node('span',{text:` ${COPY.microphone}`}));
      choices.append(cameraLabel,microphoneLabel);
      const actions=node('div',{className:'row'}); actions.style.cssText='gap:8px;flex-wrap:wrap';
      actions.append(
        button(COPY.join,'embedded-video-join','btn',()=>join({camera:camera.checked===true,microphone:microphone.checked===true})),
        button(COPY.cancel,'embedded-video-cancel','btn secondary sm',()=>stop()),
      );
      const privacy=node('a',{className:'small',text:COPY.privacy}); privacy.href='/privacy#video';
      content.append(choices,actions,privacy);
    }else if(state.phase==='joining'){
      content.append(status(COPY.joining),button(COPY.cancel,'embedded-video-cancel','btn secondary sm',()=>stop()));
    }else if(state.phase==='live'){
      content.append(status(COPY.live));
      if(state.frame) content.append(state.frame);
      content.append(button(COPY.leave,'embedded-video-leave','btn danger sm',()=>stop('closed',COPY.left)));
    }else if(state.phase==='fallback'){
      content.append(status(state.message));
      const actions=node('div',{className:'row'}); actions.style.cssText='gap:8px;flex-wrap:wrap;align-items:center';
      const href=safeExternalHref(host.meetingLinkHref?.());
      if(href){
        const link=node('a',{className:'btn',text:COPY.fallbackLink,testId:'embedded-video-fallback-link'});
        link.href=href; link.target='_blank'; link.rel='noopener noreferrer';
        actions.append(link,node('span',{className:'small muted',text:COPY.fallbackLinkHint}));
      }else content.append(node('div',{className:'small muted',text:COPY.fallbackNoLink,testId:'embedded-video-fallback-hint'}));
      if(typeof host.legacyJoin==='function'){
        actions.append(button(COPY.legacy,'embedded-video-legacy','btn secondary sm',()=>{ stop(); host.legacyJoin(); }));
      }
      actions.append(button(COPY.cancel,'embedded-video-cancel','btn ghost sm',()=>stop()));
      content.append(actions);
    }else{
      content.append(status(state.message));
      content.append(button(COPY.cancel,'embedded-video-dismiss','btn ghost sm',()=>stop()));
    }
    section.append(content);
  }

  function safeExternalHref(value){
    try{
      const url=new URL(String(value||''));
      return url.protocol==='https:'&&!url.username&&!url.password?url.href:null;
    }catch{ return null; }
  }

  function current(){
    return state.room&&state.room===host.room()&&state.actorId===host.actorId()&&host.ended?.()!==true;
  }

  function open(){
    if(state.phase==='live'||state.phase==='joining') return false;
    const room=host.room();
    const actorId=host.actorId();
    stop('idle');
    if(host.ended?.()===true){ state.phase='closed'; state.message=COPY.ended; render(); return false; }
    if(host.solo?.()===true){ state.phase='closed'; state.message=COPY.solo; render(); return false; }
    if(!room||!actorId){ state.phase='closed'; state.message=actorId?COPY.noRoom:COPY.signedOut; render(); return false; }
    state.room=room; state.actorId=actorId; state.phase='consent'; render();
    section.querySelector?.('[data-testid="embedded-video-join"]')?.focus?.();
    return true;
  }

  async function join({camera,microphone}){
    if(state.phase!=='consent'||!current()) return false;
    const epoch=++state.epoch;
    const controller=new AbortController();
    state.controller=controller; state.phase='joining'; render();
    let response=null,payload=null;
    try{
      response=await host.fetch(ROOM_ENDPOINT,{
        method:'POST',credentials:'same-origin',headers:{'content-type':'application/json'},
        body:JSON.stringify({room_id:state.room,camera,microphone}),signal:controller.signal,
      });
      try{ payload=await response.json(); }catch{}
    }catch{ response=null; }
    if(epoch!==state.epoch) return false;
    state.controller=null;
    if(!current()){ stop(); return false; }
    const statusCode=Number(response?.status)||0;
    if(statusCode===409){
      return fail(payload?.code==='session_completed'?COPY.completed:COPY.ended,'closed');
    }
    if(statusCode===401) return fail(COPY.signedOut,'closed');
    if(statusCode===429) return fail(COPY.rateLimited,'fallback');
    const src=statusCode===200?embeddedFrameUrl(payload,{expectedRoom:state.room}):null;
    if(!src) return fail(COPY.unavailable,'fallback');
    const frame=node('iframe',{testId:'embedded-video-frame'});
    frame.title=COPY.frameTitle;
    frame.setAttribute('allow',FRAME_ALLOW);
    frame.setAttribute('sandbox',FRAME_SANDBOX);
    frame.setAttribute('referrerpolicy','no-referrer');
    frame.style.cssText='width:100%;height:min(62vh,520px);border:0;border-radius:10px;background:#111';
    frame.src=src;
    state.frame=frame; state.phase='live'; render();
    // expires_in is computed on the server from the database clock, so a
    // fast or slow device clock cannot end the call early or keep it late.
    state.timer=root.setTimeout(()=>{ state.timer=null; if(epoch===state.epoch) stop('closed',COPY.expired); },
      payload.expires_in*1000);
    return true;
  }

  function fail(message,phase){
    releaseFrame();
    state.phase=phase; state.message=message; render();
    return false;
  }

  // Stop conditions mirror the room's other loops: room or circle change,
  // workspace reset/deactivation, sign-out or a different account, the
  // interview terminal coordinator, unanimous completion, and page unload.
  // A hidden tab before the frame exists abandons the join so no prompt
  // appears in the background; a live call survives a tab switch, as a
  // phone call would.
  const stopIfActive=()=>{ if(state.phase!=='idle') stop(); };
  root.addEventListener('randori:room-change',event=>{ if(event?.detail?.roomId!==state.room) stopIfActive(); });
  for(const name of ['randori:workspace-scope-reset','randori:workspace-deactivated','pagehide']) root.addEventListener(name,stopIfActive);
  root.addEventListener('randori:auth-refreshed',event=>{
    if(state.phase==='idle') return;
    if(event?.detail?.signedIn!==true||String(event.detail.userId)!==String(state.actorId)) stop();
  });
  root.addEventListener('randori:interview-ended',event=>{
    if(state.phase!=='idle'&&event?.detail?.room===state.room) stop('closed',COPY.ended);
  });
  // Unanimous completion closes the call in peer mode too, where no
  // interview-ended event exists.
  root.addEventListener('randori:completion-observed',event=>{
    if(state.phase!=='idle'&&state.phase!=='closed'&&event?.detail?.room===state.room
      &&event.detail.state==='completed') stop('closed',COPY.completed);
  });
  doc.addEventListener?.('visibilitychange',()=>{
    if(doc.visibilityState==='hidden'&&(state.phase==='consent'||state.phase==='joining')) stop();
  });

  render();
  return Object.freeze({
    open,join,leave:()=>stop('closed',COPY.left),
    teardown:()=>stop(),
    get phase(){ return state.phase; },
    get room(){ return state.room; },
    get frame(){ return state.frame; },
  });
}
