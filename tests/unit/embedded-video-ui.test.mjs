// Issue #463 (ID-98): the embedded-video browser module. Consent comes first
// (no request, no frame, no media prompt before Join), Leave and every stop
// condition unload the frame, and an unavailable provider falls back to the
// private external meeting link. Minimal DOM and a scripted host.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { COPY, DAILY_FRAME_ORIGIN, embeddedFrameUrl, mountEmbeddedVideo } from '../../assets/embedded-video.js';

const ROOM='week_10_pair_20';
const ROOM_URL=`${DAILY_FRAME_ORIGIN}/rc-${'a'.repeat(32)}`;
const TOKEN='eyJhbGciOi.test-token.signature';

class FakeNode{
  constructor(doc,tag){
    this.doc=doc; this.tagName=tag.toUpperCase(); this.children=[]; this.dataset={}; this.attributes={};
    this.listeners={}; this.hidden=false; this.disabled=false; this.className=''; this._text=''; this.style={};
    this.parent=null; this.removed=false; this.srcHistory=[];
  }
  get textContent(){ return this._text+this.children.map(child=>child.textContent).join(''); }
  set textContent(value){ this._text=String(value); this.children=[]; }
  get src(){ return this.srcHistory.at(-1)??''; }
  set src(value){ this.srcHistory.push(String(value)); }
  append(...nodes){ for(const child of nodes){ child.parent=this; this.children.push(child); } }
  replaceChildren(...nodes){ this.children=[]; this.append(...nodes); }
  remove(){ this.removed=true; if(this.parent) this.parent.children=this.parent.children.filter(child=>child!==this); this.parent=null; }
  setAttribute(name,value){ this.attributes[name]=String(value); }
  getAttribute(name){ return this.attributes[name]??null; }
  addEventListener(type,listener){ (this.listeners[type]||=[]).push(listener); }
  focus(){ this.doc.activeElement=this; }
  click(){ if(!this.disabled) for(const listener of this.listeners.click||[]) listener({type:'click',target:this}); }
  all(found=[]){ for(const child of this.children){ found.push(child); child.all(found); } return found; }
  querySelector(selector){
    const testId=selector.match(/^\[data-testid="([^"]+)"\]$/)?.[1];
    return this.all().find(child=>child.dataset.testid===testId)||null;
  }
}

function fixture({room=ROOM,actorId=2,ended=false,meetingLink='https://meet.example.test/abc',legacy=true}={}){
  const listeners={};
  const timers=new Map();
  let timerId=0;
  const root={
    addEventListener(type,listener){ (listeners[type]||=[]).push(listener); },
    setTimeout(fn,ms){ timerId+=1; timers.set(timerId,{fn,ms}); return timerId; },
    clearTimeout(id){ timers.delete(id); },
  };
  const doc={activeElement:null,visibilityState:'visible',docListeners:{}};
  doc.createElement=tag=>new FakeNode(doc,tag);
  doc.addEventListener=(type,listener)=>{ (doc.docListeners[type]||=[]).push(listener); };
  const section=new FakeNode(doc,'section'); section.id='embeddedVideoPanel'; section.hidden=true;
  doc.getElementById=id=>id==='embeddedVideoPanel'?section:null;
  const calls=[];
  const responses=[];
  const media={prompts:0};
  const host={
    room:()=>f.room,actorId:()=>f.actorId,ended:()=>f.ended,solo:()=>f.solo,
    meetingLinkHref:()=>f.meetingLink,
    legacyJoin:legacy?()=>calls.push(['legacy']):undefined,
    fetch:async(url,init)=>{
      calls.push(['fetch',url,init]);
      const next=responses.shift();
      if(next instanceof Error) throw next;
      if(typeof next==='function') return next(init);
      return {status:next?.status??200,json:async()=>next?.body};
    },
  };
  const f={room,actorId,ended,solo:false,meetingLink,root,doc,section,calls,responses,timers,media,
    controller:mountEmbeddedVideo({window:root,document:doc,host}),
    fire(type,detail){ for(const listener of listeners[type]||[]) listener({type,detail}); },
    fireDoc(type){ for(const listener of doc.docListeners[type]||[]) listener({type}); },
    byTestId(id){ return section.querySelector(`[data-testid="${id}"]`); },
    frames(){ return section.all().filter(node=>node.tagName==='IFRAME'); },
    status(){ return this.byTestId('embedded-video-status')?.textContent||''; },
  };
  return f;
}

function granted(overrides={}){
  return {status:200,body:{ok:true,room_id:ROOM,provider:'daily',room_url:ROOM_URL,token:TOKEN,
    expires_at:new Date(Date.now()+10*60*1000).toISOString(),expires_in:600,recording:false,...overrides}};
}

const tick=()=>new Promise(resolve=>setImmediate(resolve));

test('the frame URL accepts only a private Daily room on the CSP-allowed origin',()=>{
  assert.equal(embeddedFrameUrl(granted().body,{expectedRoom:ROOM}),`${ROOM_URL}?t=${TOKEN}`);
  for(const body of [
    {...granted().body,ok:false},{...granted().body,provider:'other'},{...granted().body,recording:true},
    {...granted().body,room_id:'week_10_pair_21'},{...granted().body,token:'short'},{...granted().body,token:'has space in it 123'},
    {...granted().body,expires_at:'soon'},{...granted().body,expires_in:undefined},{...granted().body,expires_in:0},
    {...granted().body,expires_in:3601},{...granted().body,expires_in:'600'},{...granted().body,expires_in:1.5},{...granted().body,room_url:'https://evil.daily.co/rc-'+'a'.repeat(32)},
    {...granted().body,room_url:'http://randori-circle.daily.co/rc-'+'a'.repeat(32)},
    {...granted().body,room_url:`${DAILY_FRAME_ORIGIN}/week_10_pair_20`},{...granted().body,room_url:`${ROOM_URL}?t=other`},
    {...granted().body,room_url:`${ROOM_URL}#x`},{...granted().body,room_url:'not a url'},null,
  ]) assert.equal(embeddedFrameUrl(body,{expectedRoom:ROOM}),null,JSON.stringify(body));
});

test('consent comes first: opening shows the notice with no request, no frame and no media prompt',async()=>{
  const f=fixture();
  assert.equal(f.section.hidden,true);
  assert.equal(f.controller.open(),true);
  assert.equal(f.section.hidden,false);
  assert.equal(f.controller.phase,'consent');
  assert.equal(f.byTestId('embedded-video-notice').textContent,COPY.notice);
  assert.match(f.section.textContent,/not recorded/);
  assert.equal(f.byTestId('embedded-video-camera').checked,true);
  assert.equal(f.byTestId('embedded-video-microphone').checked,true);
  assert.equal(f.doc.activeElement,f.byTestId('embedded-video-join'));
  await tick();
  assert.equal(f.calls.length,0,'nothing is requested before Join');
  assert.equal(f.frames().length,0,'no frame (and so no permission prompt) before Join');
  f.byTestId('embedded-video-cancel').click();
  assert.equal(f.controller.phase,'idle'); assert.equal(f.section.hidden,true);
  assert.equal(f.calls.length,0);
});

test('Join posts the exact consent choices and loads a sandboxed, media-delegated frame',async()=>{
  const f=fixture();
  f.responses.push(granted());
  f.controller.open();
  f.byTestId('embedded-video-camera').checked=false;
  f.byTestId('embedded-video-join').click();
  assert.equal(f.controller.phase,'joining');
  assert.equal(f.status(),COPY.joining);
  await tick(); await tick();
  const [kind,url,init]=f.calls[0];
  assert.equal(kind,'fetch'); assert.equal(url,'/api/video/room');
  assert.equal(init.method,'POST'); assert.equal(init.credentials,'same-origin');
  assert.deepEqual(JSON.parse(init.body),{room_id:ROOM,camera:false,microphone:true});
  assert.equal(f.controller.phase,'live');
  const [frame]=f.frames();
  assert.equal(frame.src,`${ROOM_URL}?t=${TOKEN}`);
  assert.equal(frame.getAttribute('allow'),'camera; microphone; autoplay; fullscreen');
  assert.equal(frame.getAttribute('sandbox'),'allow-scripts allow-same-origin');
  assert.equal(frame.getAttribute('referrerpolicy'),'no-referrer');
  assert.equal(frame.title,COPY.frameTitle);
  assert.equal(f.status(),COPY.live);
  assert.equal(f.controller.open(),false,'a second Join while live does not start another call');
  assert.equal(f.calls.length,1);

  // Leave unloads the provider page, then detaches the frame.
  f.byTestId('embedded-video-leave').click();
  assert.deepEqual(frame.srcHistory,[`${ROOM_URL}?t=${TOKEN}`,'about:blank']);
  assert.equal(frame.removed,true);
  assert.equal(f.frames().length,0);
  assert.equal(f.controller.phase,'closed');
  assert.equal(f.status(),COPY.left);
  assert.equal(f.timers.size,0,'the expiry timer is cleared');
  f.byTestId('embedded-video-dismiss').click();
  assert.equal(f.section.hidden,true);
});

test('the call closes itself after the server-computed pass lifetime, whatever the device clock says',async()=>{
  // expires_at disagrees with the device clock in both directions; only
  // the server's expires_in schedules the close.
  for(const skewMs of [-6*60*60*1000,6*60*60*1000,0]){
    const f=fixture();
    f.responses.push(granted({expires_in:90,expires_at:new Date(Date.now()+skewMs+90_000).toISOString()}));
    f.controller.open(); f.byTestId('embedded-video-join').click();
    await tick(); await tick();
    assert.equal(f.controller.phase,'live',`skew ${skewMs}`);
    const [[,timer]]=[...f.timers];
    assert.equal(timer.ms,90_000,`skew ${skewMs}`);
    const frame=f.controller.frame;
    timer.fn();
    assert.equal(frame.removed,true);
    assert.equal(f.controller.phase,'closed');
    assert.equal(f.status(),COPY.expired);
  }
});

test('unanimous completion closes a live call in peer mode, but not another room\'s',async()=>{
  const f=fixture(); f.responses.push(granted());
  f.controller.open(); f.byTestId('embedded-video-join').click();
  await tick(); await tick();
  const frame=f.controller.frame;
  f.fire('randori:completion-observed',{room:'week_10_pair_21',state:'completed'});
  f.fire('randori:completion-observed',{room:ROOM,state:'awaiting_participants'});
  f.fire('randori:completion-observed',{room:null});
  assert.equal(f.controller.phase,'live');
  f.fire('randori:completion-observed',{room:ROOM,state:'completed',completionVersion:'d'.repeat(64)});
  assert.equal(frame.removed,true);
  assert.equal(f.controller.phase,'closed');
  assert.equal(f.status(),COPY.completed);
  f.fire('randori:completion-observed',{room:ROOM,state:'completed'});
  assert.equal(f.status(),COPY.completed,'a repeated observation leaves the closed notice alone');
  const pending=fixture();
  pending.controller.open();
  pending.fire('randori:completion-observed',{room:ROOM,state:'completed'});
  assert.equal(pending.controller.phase,'closed','a pending consent closes too');
  const idle=fixture();
  idle.fire('randori:completion-observed',{room:ROOM,state:'completed'});
  assert.equal(idle.controller.phase,'idle');
});

test('an unavailable provider falls back to the external meeting link and the direct call',async()=>{
  for(const response of [{status:503,body:{error:'embedded video unavailable'}},{status:404,body:{error:'pair not found'}},
    new Error('offline'),{status:200,body:{ok:true}},{status:200,body:granted({room_url:'https://evil.example.test/x'}).body}]){
    const f=fixture();
    f.responses.push(response);
    f.controller.open(); f.byTestId('embedded-video-join').click();
    await tick(); await tick();
    assert.equal(f.controller.phase,'fallback',JSON.stringify(response));
    assert.equal(f.frames().length,0);
    assert.equal(f.status(),COPY.unavailable);
    const link=f.byTestId('embedded-video-fallback-link');
    assert.equal(link.href,'https://meet.example.test/abc');
    assert.equal(link.target,'_blank'); assert.equal(link.rel,'noopener noreferrer');
    f.byTestId('embedded-video-legacy').click();
    assert.deepEqual(f.calls.at(-1),['legacy']);
    assert.equal(f.controller.phase,'idle');
  }
  const noLink=fixture({meetingLink:'javascript:alert(1)',legacy:false});
  noLink.responses.push({status:503,body:{}});
  noLink.controller.open(); noLink.byTestId('embedded-video-join').click();
  await tick(); await tick();
  assert.equal(noLink.byTestId('embedded-video-fallback-link'),null,'only an https link is offered');
  assert.equal(noLink.byTestId('embedded-video-fallback-hint').textContent,COPY.fallbackNoLink);
  assert.equal(noLink.byTestId('embedded-video-legacy'),null);
  noLink.byTestId('embedded-video-cancel').click();
  assert.equal(noLink.controller.phase,'idle');
});

test('ended, completed, signed-out, rate-limited, solo and roomless joins explain themselves without a frame',async()=>{
  const cases=[
    [{status:409,body:{code:'interview_session_ended'}},COPY.ended,'closed'],
    [{status:409,body:{code:'session_completed'}},COPY.completed,'closed'],
    [{status:401,body:{}},COPY.signedOut,'closed'],
    [{status:429,body:{}},COPY.rateLimited,'fallback'],
  ];
  for(const [response,message,phase] of cases){
    const f=fixture(); f.responses.push(response);
    f.controller.open(); f.byTestId('embedded-video-join').click();
    await tick(); await tick();
    assert.equal(f.controller.phase,phase); assert.equal(f.status(),message); assert.equal(f.frames().length,0);
  }
  const ended=fixture({ended:true}); assert.equal(ended.controller.open(),false); assert.equal(ended.status(),COPY.ended);
  const solo=fixture(); solo.solo=true; assert.equal(solo.controller.open(),false); assert.equal(solo.status(),COPY.solo);
  const roomless=fixture({room:''}); assert.equal(roomless.controller.open(),false); assert.equal(roomless.status(),COPY.noRoom);
  const signedOut=fixture({actorId:null}); assert.equal(signedOut.controller.open(),false); assert.equal(signedOut.status(),COPY.signedOut);
  for(const f of [ended,solo,roomless,signedOut]) assert.equal(f.calls.length,0);
});

test('room, scope, account, terminal and unload changes tear the call down',async()=>{
  const stops=[
    f=>f.fire('randori:room-change',{roomId:'week_10_pair_21'}),
    f=>f.fire('randori:workspace-scope-reset'),
    f=>f.fire('randori:workspace-deactivated'),
    f=>f.fire('randori:auth-refreshed',{signedIn:false,userId:null}),
    f=>f.fire('randori:auth-refreshed',{signedIn:true,userId:4}),
    f=>f.fire('pagehide'),
    f=>f.fire('randori:interview-ended',{room:ROOM}),
    f=>f.controller.teardown(),
  ];
  for(const stop of stops){
    const f=fixture(); f.responses.push(granted());
    f.controller.open(); f.byTestId('embedded-video-join').click();
    await tick(); await tick();
    const frame=f.controller.frame;
    assert.ok(frame);
    stop(f);
    assert.equal(frame.removed,true,stop.toString());
    assert.equal(frame.src,'about:blank');
    assert.equal(f.frames().length,0);
    assert.equal(f.timers.size,0);
  }
  // Same room, same account and another room's end are not stop conditions.
  const f=fixture(); f.responses.push(granted());
  f.controller.open(); f.byTestId('embedded-video-join').click();
  await tick(); await tick();
  f.fire('randori:room-change',{roomId:ROOM});
  f.fire('randori:auth-refreshed',{signedIn:true,userId:2});
  f.fire('randori:interview-ended',{room:'week_10_pair_21'});
  f.doc.visibilityState='hidden'; f.fireDoc('visibilitychange');
  assert.equal(f.controller.phase,'live','a live call survives a tab switch');
  f.fire('randori:interview-ended',{room:ROOM});
  assert.equal(f.status(),COPY.ended);
});

test('a join abandoned mid-request never mounts a frame, and a hidden tab drops a pending consent',async()=>{
  let release;
  const f=fixture();
  f.responses.push(init=>new Promise(resolve=>{ release=()=>resolve({status:200,json:async()=>granted().body}); init.signal.addEventListener('abort',()=>{}); }));
  f.controller.open(); f.byTestId('embedded-video-join').click();
  await tick();
  f.fire('randori:room-change',{roomId:'week_10_pair_21'});
  release(); await tick(); await tick();
  assert.equal(f.frames().length,0);
  assert.equal(f.controller.phase,'idle');

  const switched=fixture(); switched.responses.push(granted());
  switched.controller.open(); switched.byTestId('embedded-video-join').click();
  switched.room='week_10_pair_21';
  await tick(); await tick();
  assert.equal(switched.frames().length,0,'a response for a room the member left is discarded');
  assert.equal(switched.controller.phase,'idle');

  const hidden=fixture();
  hidden.controller.open();
  hidden.doc.visibilityState='hidden'; hidden.fireDoc('visibilitychange');
  assert.equal(hidden.controller.phase,'idle');
  assert.equal(hidden.calls.length,0);
});

test('mounting needs a window, a document, the panel and a host',()=>{
  assert.equal(mountEmbeddedVideo({window:null,document:null,host:{}}),null);
  const doc={getElementById:()=>null};
  assert.equal(mountEmbeddedVideo({window:{addEventListener(){}},document:doc,host:{}}),null);
});

test('controller edges: no join without consent, unreadable responses, idle events, leave() and room',async()=>{
  const f=fixture({meetingLink:null});
  assert.equal(await f.controller.join({camera:true,microphone:true}),false,'no join without the consent step');
  f.fire('randori:auth-refreshed',{signedIn:false});
  assert.equal(f.controller.phase,'idle');
  assert.equal(f.calls.length,0);
  f.responses.push(()=>({status:200,json:async()=>{ throw new SyntaxError('not json'); }}));
  f.controller.open();
  assert.equal(f.controller.room,ROOM);
  f.byTestId('embedded-video-join').click();
  await tick(); await tick();
  assert.equal(f.controller.phase,'fallback');
  assert.equal(f.byTestId('embedded-video-fallback-link'),null,'no meeting link to offer');
  f.controller.open(); f.responses.push(granted());
  f.byTestId('embedded-video-join').click();
  await tick(); await tick();
  const frame=f.controller.frame;
  assert.equal(f.controller.leave(),true);
  assert.equal(frame.removed,true);
  assert.equal(f.status(),COPY.left);
});
