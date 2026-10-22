// Issue #339 account-deletion UI: guidance copy, device-data clearing, the
// Google continuation marker, and the re-auth -> type DELETE -> final confirm
// controller with request fencing, against a minimal DOM and a scripted host.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  COPY,
  CONFIRMATION_WORD,
  DELETED_NOTICE_KEY,
  KEPT_LOCAL_KEYS,
  REAUTH_MARKER_KEY,
  REAUTH_TTL_MS,
  blockedMessage,
  clearDeviceData,
  mountAccountDeletion,
  readReauthMarker,
} from '../../assets/account-deletion.js';

const NOW=1_800_000_000_000;

class FakeNode {
  constructor(doc,tag){
    this.doc=doc;
    this.tagName=tag.toUpperCase();
    this.children=[];
    this.dataset={};
    this.attributes={};
    this.listeners={};
    this.hidden=false;
    this.disabled=false;
    this.className='';
    this.value='';
    this._text='';
  }
  get textContent(){ return this._text+this.children.map(child=>child.textContent).join(''); }
  set textContent(value){ this._text=String(value); this.children=[]; }
  append(...nodes){ this.children.push(...nodes); }
  replaceChildren(...nodes){ this.children=nodes; }
  setAttribute(name,value){ this.attributes[name]=String(value); }
  getAttribute(name){ return this.attributes[name]??null; }
  addEventListener(type,listener){ (this.listeners[type]||=[]).push(listener); }
  focus(){ this.doc.activeElement=this; }
  fire(type){ for(const listener of this.listeners[type]||[]) listener({type,target:this}); }
  click(){ if(!this.disabled) this.fire('click'); }
  all(found=[]){ for(const child of this.children){ found.push(child); child.all(found); } return found; }
  byId(id){ return this.all().find(child=>child.id===id)||null; }
}

function fakeDocument({withSection=true}={}){
  const doc={activeElement:null};
  doc.createElement=tag=>new FakeNode(doc,tag);
  doc.body=new FakeNode(doc,'body');
  const section=new FakeNode(doc,'section');
  section.id='accountDeletion';
  section.hidden=true;
  doc.section=section;
  doc.getElementById=id=>(withSection&&id==='accountDeletion'?section:null);
  doc.find=id=>section.byId(id)||doc.body.byId(id);
  return doc;
}

class FakeStorage {
  constructor(entries={}){ this.map=new Map(Object.entries(entries)); }
  get length(){ return this.map.size; }
  key(index){ return [...this.map.keys()][index]??null; }
  getItem(key){ return this.map.has(key)?this.map.get(key):null; }
  setItem(key,value){ this.map.set(key,String(value)); }
  removeItem(key){ this.map.delete(key); }
  keys(){ return [...this.map.keys()].sort(); }
}

function deferred(){
  let resolve,reject;
  const promise=new Promise((yes,no)=>{ resolve=yes; reject=no; });
  return {promise,resolve,reject};
}

const flush=async()=>{ for(let index=0;index<6;index+=1) await Promise.resolve(); };

function problem(status,body={}){ return Object.assign(new Error('request failed'),{http_status:status,...body}); }

function harness({routes={},enabled=true,userId=7,local={},session={}}={}){
  const doc=fakeDocument();
  const calls=[];
  const events=[];
  const state={enabled,userId,result:null,dialog:null};
  const host={
    enabled:()=>state.enabled,
    userId:()=>state.userId,
    api:async(path,options={})=>{
      calls.push(`${options.method||'GET'} ${path}${options.body?` ${JSON.stringify(options.body)}`:''}`);
      const route=routes[`${options.method||'GET'} ${path}`];
      if(!route) throw new Error(`unexpected ${path}`);
      return typeof route==='function'?route(options):route;
    },
    openDialog:(overlay,options)=>{
      events.push('open');
      state.dialog=options;
      overlay.setAttribute('aria-hidden','false');
      return ()=>{ events.push('close'); overlay.setAttribute('aria-hidden','true'); };
    },
    navigate:url=>events.push(`navigate ${url}`),
    reload:path=>events.push(`reload ${path}`),
    signOutLocally:async()=>{ events.push('signed-out'); },
    storage:{local:new FakeStorage(local),session:new FakeStorage(session)},
    now:()=>NOW,
    takeReauthResult:()=>{ const result=state.result; state.result=null; return result; },
    openCircle:()=>events.push('circle'),
  };
  const controller=mountAccountDeletion({doc,host});
  return {doc,host,calls,events,state,controller,find:id=>doc.find(id)};
}

const ELIGIBLE={'GET /api/auth/account/delete':{ok:true,eligible:true}};
const recent=(ok,methods={password:true,google:false})=>({'GET /api/auth/recent-auth':{ok:true,recentAuth:{ok},methods}});

async function openReady(routes){
  const ui=harness({routes:{...ELIGIBLE,...routes}});
  ui.controller.sync();
  await flush();
  ui.find('accountDeletionOpen').click();
  await flush();
  return ui;
}

test('guidance names the circles and offers archiving only for secondary circles',()=>{
  assert.equal(blockedMessage('last_admin'),'You’re the only app admin. Make another member an app admin on the Circle page first.');
  assert.equal(blockedMessage('last_owner',[{name:'Graph Club',is_primary:false}]),
    'You’re the only owner of Graph Club. Make another member an owner on the Circle page, or archive the circle, before deleting your account.');
  assert.equal(blockedMessage('last_owner',[{name:'Randori',is_primary:true},{name:'  ',is_primary:false}]),
    'You’re the only owner of Randori, your circle. Make another member an owner on the Circle page before deleting your account.');
  assert.equal(blockedMessage('last_owner','nope'),
    'You’re the only owner of a circle. Make another member an owner on the Circle page before deleting your account.');
  assert.equal(blockedMessage('last_owner',[null,{name:7}]),blockedMessage('last_owner',[]));
  assert.equal(blockedMessage('demo_account'),null);
});

test('device data: every randori key goes except the theme and landing preference',()=>{
  const local=new FakeStorage({'randori-me':'{"email":"x"}','randori-crdt-pending-v1':'code','randori-board:week_1_pair_1':'b',
    'randori-theme':'light','randori-landing-dismissed':'1','other-app':'keep'});
  const session=new FakeStorage({'randori-lifecycle-recent-action-v1':'{}','randori-theme':'session copy','unrelated':'1'});
  clearDeviceData({local,session});
  assert.deepEqual(local.keys(),['other-app',...KEPT_LOCAL_KEYS].sort());
  assert.deepEqual(session.keys(),['unrelated']);
  clearDeviceData({local:null,session:undefined});
  clearDeviceData();
});

test('the Google marker is single-use, bound to the member and ten minutes',()=>{
  const marker=(value)=>new FakeStorage({[REAUTH_MARKER_KEY]:typeof value==='string'?value:JSON.stringify(value)});
  const store=marker({v:1,actor_id:7,created_at:NOW-1000});
  assert.equal(readReauthMarker(store,{userId:7,now:NOW}),true);
  assert.equal(store.getItem(REAUTH_MARKER_KEY),null,'consumed');
  assert.equal(readReauthMarker(store,{userId:7,now:NOW}),false);
  assert.equal(readReauthMarker(marker({v:1,actor_id:8,created_at:NOW}),{userId:7,now:NOW}),false);
  assert.equal(readReauthMarker(marker({v:1,actor_id:7,created_at:NOW-REAUTH_TTL_MS-1}),{userId:7,now:NOW}),false);
  assert.equal(readReauthMarker(marker({v:1,actor_id:7,created_at:NOW+60_000}),{userId:7,now:NOW}),false);
  assert.equal(readReauthMarker(marker({v:2,actor_id:7,created_at:NOW}),{userId:7,now:NOW}),false);
  assert.equal(readReauthMarker(marker('{not json'),{userId:7,now:NOW}),false);
  assert.equal(readReauthMarker({getItem(){ throw new Error('blocked'); }},{userId:7,now:NOW}),false);
});

test('mounting needs the section; it stays hidden and silent while not allowed',async()=>{
  assert.equal(mountAccountDeletion({doc:fakeDocument({withSection:false}),host:{}}),null);
  const ui=harness({enabled:false});
  ui.controller.sync();
  assert.equal(ui.doc.section.hidden,true);
  assert.deepEqual(ui.calls,[]);
  assert.equal(ui.controller.open(),false);
  assert.equal(ui.doc.section.textContent.includes(COPY.deleted[0]),true,'the explanation is built once, from text nodes');
});

test('the section explains what is deleted and what stays, then enables the action when eligible',async()=>{
  const ui=harness({routes:ELIGIBLE});
  ui.controller.sync();
  assert.equal(ui.doc.section.hidden,false);
  assert.equal(ui.find('accountDeletionStatus').textContent,COPY.checking);
  assert.equal(ui.find('accountDeletionOpen').disabled,true);
  await flush();
  for(const line of [COPY.title,COPY.intro,...COPY.deleted,...COPY.kept,COPY.rejoin]) assert.ok(ui.doc.section.textContent.includes(line),line);
  assert.equal(ui.doc.section.getAttribute('aria-labelledby'),'accountDeletionTitle');
  assert.equal(ui.find('accountDeletionOpen').disabled,false);
  assert.equal(ui.find('accountDeletionStatus').textContent,'');
  assert.equal(ui.find('accountDeletionBlocked').hidden,true);
  ui.controller.sync();
  await flush();
  assert.deepEqual(ui.calls,['GET /api/auth/account/delete'],'a repeat sync for the same member does not refetch');
  assert.deepEqual(ui.controller.state.eligibility,{eligible:true,code:undefined,circles:undefined});
});

test('a blocked owner sees the guidance and a way to the Circle page',async()=>{
  const ui=harness({routes:{'GET /api/auth/account/delete':{ok:true,eligible:false,code:'last_owner',
    circles:[{public_id:'c',name:'Graph Club',is_primary:false}]}}});
  ui.controller.sync();
  await flush();
  assert.equal(ui.find('accountDeletionBlocked').hidden,false);
  assert.match(ui.find('accountDeletionBlocked').textContent,/only owner of Graph Club/);
  assert.equal(ui.find('accountDeletionOpen').disabled,true);
  ui.find('accountDeletionCircle').click();
  assert.deepEqual(ui.events,['circle']);
});

test('eligibility failures offer a retry; malformed and stale answers are ignored',async()=>{
  let attempt=0;
  const ui=harness({routes:{'GET /api/auth/account/delete':()=>{
    attempt+=1;
    if(attempt===1) throw problem(503);
    if(attempt===2) return {ok:true};
    return {ok:true,eligible:true};
  }}});
  ui.controller.sync();
  await flush();
  assert.equal(ui.find('accountDeletionStatus').textContent,COPY.unavailable);
  assert.equal(ui.find('accountDeletionRetry').hidden,false);
  ui.find('accountDeletionRetry').click();
  await flush();
  assert.equal(ui.find('accountDeletionStatus').textContent,COPY.unavailable,'a malformed body is a failure');
  await ui.controller.refresh();
  assert.equal(ui.find('accountDeletionOpen').disabled,false);

  const answers=[deferred(),deferred()];
  let call=0;
  const late=harness({routes:{'GET /api/auth/account/delete':()=>answers[call++].promise}});
  late.controller.sync();
  late.state.userId=8;
  late.controller.sync();
  answers[0].resolve({ok:true,eligible:false,code:'last_admin'});
  await flush();
  assert.equal(late.controller.state.eligibility,null,'an answer for the previous member never renders');
  answers[1].resolve({ok:true,eligible:true});
  await flush();
  assert.equal(late.controller.state.eligibility.eligible,true);
  late.state.enabled=false;
  late.controller.sync();
  assert.equal(late.doc.section.hidden,true);
});

test('password re-auth, type DELETE, final confirm, then sign out with cleared device data',async()=>{
  const ui=await openReady({
    ...recent(false),
    'POST /api/auth/recent-auth':{ok:true,recentAuth:{ok:true}},
    'POST /api/auth/account/delete':{ok:true,status:'deleted'},
  });
  ui.host.storage.local.setItem('randori-me','{"name":"Me"}');
  ui.host.storage.local.setItem('randori-theme','light');
  assert.deepEqual(ui.events,['open']);
  assert.equal(ui.find('accountDeletionDialogTitle').textContent,COPY.reauthTitle);
  const password=ui.find('accountDeletionPassword');
  assert.equal(password.type,'password');
  assert.equal(password.autocomplete,'current-password');
  assert.equal(ui.doc.activeElement,password);
  assert.equal(ui.find('accountDeletionGoogle'),null);

  ui.find('accountDeletionConfirmPassword').click();
  assert.equal(ui.find('accountDeletionPasswordError').textContent,COPY.passwordMissing);
  assert.equal(password.getAttribute('aria-invalid'),'true');
  password.value='secret password';
  ui.find('accountDeletionConfirmPassword').click();
  ui.find('accountDeletionConfirmPassword').click();
  await flush();
  assert.deepEqual(ui.calls.filter(call=>call.startsWith('POST /api/auth/recent-auth')),
    ['POST /api/auth/recent-auth {"password":"secret password"}'],'one confirmation while busy');

  assert.equal(ui.find('accountDeletionDialogTitle').textContent,COPY.typeTitle);
  const confirm=ui.find('accountDeletionConfirm');
  const next=ui.find('accountDeletionContinue');
  assert.equal(ui.doc.activeElement,confirm);
  assert.equal(next.disabled,true);
  confirm.value='delete';
  confirm.fire('input');
  assert.equal(next.disabled,true);
  ui.state.dialog.onEnter();
  assert.equal(ui.controller.state.step,'type','Enter does nothing until DELETE is typed');
  confirm.value=CONFIRMATION_WORD;
  confirm.fire('input');
  assert.equal(next.disabled,false);
  next.click();

  assert.equal(ui.find('accountDeletionDialogTitle').textContent,COPY.finalTitle);
  assert.equal(ui.doc.activeElement,ui.find('accountDeletionCancel'),'Cancel is focused on the irreversible step');
  ui.find('accountDeletionConfirmDelete').click();
  ui.state.dialog.onCancel();
  assert.equal(ui.controller.state.step,'deleting','an in-flight deletion cannot be cancelled');
  await flush();
  assert.equal(ui.calls.at(-1),'POST /api/auth/account/delete {"confirm":"DELETE"}');
  assert.deepEqual(ui.events,['open','close','signed-out','reload /']);
  assert.deepEqual(ui.host.storage.local.keys(),['randori-theme']);
  assert.equal(ui.host.storage.session.getItem(DELETED_NOTICE_KEY),'1');
  ui.controller.close();
  assert.equal(ui.controller.state.step,'done');
});

test('a recent sign-in skips straight to typing DELETE; Enter moves on',async()=>{
  const ui=await openReady(recent(true));
  assert.equal(ui.controller.state.step,'type');
  ui.find('accountDeletionConfirm').value=CONFIRMATION_WORD;
  ui.state.dialog.onEnter();
  assert.equal(ui.controller.state.step,'final');
  ui.state.dialog.onEnter();
  assert.equal(ui.controller.state.step,'final');
  ui.find('accountDeletionCancel').click();
  assert.deepEqual(ui.events,['open','close']);
  assert.equal(ui.controller.state.step,'closed');
  assert.equal(ui.controller.open({step:'type'}),true);
  assert.equal(ui.controller.state.step,'type');
  assert.equal(ui.controller.open(),false,'one dialog at a time');
});

test('password failures: wrong password, rate limit and outage keep the member on the step',async()=>{
  let answer=problem(401);
  const ui=await openReady({...recent(false),'POST /api/auth/recent-auth':()=>{ throw answer; }});
  const password=ui.find('accountDeletionPassword');
  password.value='wrong';
  ui.state.dialog.onEnter();
  await flush();
  assert.equal(ui.find('accountDeletionPasswordError').textContent,COPY.passwordWrong);
  assert.equal(password.value,'');
  answer=problem(429);
  password.value='again';
  ui.find('accountDeletionConfirmPassword').click();
  await flush();
  assert.equal(ui.find('accountDeletionDialogStatus').textContent,COPY.rateLimited);
  answer=new Error('offline');
  password.value='again';
  ui.find('accountDeletionConfirmPassword').click();
  await flush();
  assert.equal(ui.find('accountDeletionDialogStatus').textContent,COPY.unavailable);
  assert.equal(ui.controller.state.step,'reauth');
});

test('closing while a confirmation is in flight ignores its answer',async()=>{
  const slow=deferred();
  const ui=await openReady({...recent(false),'POST /api/auth/recent-auth':()=>slow.promise});
  ui.find('accountDeletionPassword').value='secret';
  ui.find('accountDeletionConfirmPassword').click();
  ui.state.dialog.onCancel();
  slow.resolve({ok:true});
  await flush();
  assert.equal(ui.controller.state.step,'closed');

  const failing=deferred();
  const other=await openReady({...recent(false),'POST /api/auth/recent-auth':()=>failing.promise});
  other.find('accountDeletionPassword').value='secret';
  other.find('accountDeletionConfirmPassword').click();
  other.controller.close();
  failing.reject(problem(401));
  await flush();
  assert.equal(other.controller.state.step,'closed');

  const checking=deferred();
  const third=harness({routes:{...ELIGIBLE,'GET /api/auth/recent-auth':()=>checking.promise}});
  third.controller.sync();
  await flush();
  third.find('accountDeletionOpen').click();
  third.controller.close();
  checking.resolve({ok:true,recentAuth:{ok:true},methods:{password:true}});
  await flush();
  assert.equal(third.controller.state.step,'closed');
});

test('an unreachable confirmation check offers a retry; no method at all says so',async()=>{
  let attempt=0;
  const ui=await openReady({'GET /api/auth/recent-auth':()=>{
    attempt+=1;
    if(attempt===1) throw new Error('offline');
    return {ok:true,recentAuth:{ok:false},methods:{}};
  }});
  assert.equal(ui.controller.state.step,'unavailable');
  assert.equal(ui.find('accountDeletionDialogStatus').textContent,COPY.unavailable);
  ui.find('accountDeletionDialogRetry').click();
  await flush();
  assert.equal(ui.controller.state.step,'reauth');
  assert.equal(ui.find('accountDeletionDialogText').textContent,COPY.reauthNone);
  assert.equal(ui.find('accountDeletionPassword'),null);
  ui.state.dialog.onEnter();
  assert.equal(ui.controller.state.step,'reauth');
});

test('Google confirmation stores a marker and navigates only to Google',async()=>{
  let start={authorizationUrl:'https://accounts.google.com/o/oauth2/v2/auth?state=s'};
  const ui=await openReady({...recent(false,{password:false,google:true}),
    'POST /api/auth/google/reauth/start':()=>{ if(start instanceof Error) throw start; return start; }});
  const google=ui.find('accountDeletionGoogle');
  assert.equal(google.className,'btn','Google is the primary action without a password');
  assert.equal(ui.doc.activeElement,google);
  google.click();
  google.click();
  await flush();
  assert.equal(ui.calls.filter(call=>call.includes('google')).length,1);
  assert.deepEqual(JSON.parse(ui.host.storage.session.getItem(REAUTH_MARKER_KEY)),{v:1,actor_id:7,created_at:NOW});
  assert.equal(ui.events.at(-1),'navigate https://accounts.google.com/o/oauth2/v2/auth?state=s');

  for(const [answer,status] of [[{authorizationUrl:'https://evil.example.test/o/oauth2/v2/auth'},COPY.googleUnavailable],
    [{authorizationUrl:'https://user:pw@accounts.google.com/o/oauth2/v2/auth'},COPY.googleUnavailable],
    [{},COPY.googleUnavailable],[problem(429),COPY.rateLimited]]){
    const other=await openReady({...recent(false,{password:true,google:true}),
      'POST /api/auth/google/reauth/start':()=>{ if(answer instanceof Error) throw answer; return answer; }});
    assert.equal(other.find('accountDeletionGoogle').className,'btn secondary');
    other.find('accountDeletionGoogle').click();
    await flush();
    assert.equal(other.find('accountDeletionDialogStatus').textContent,status);
    assert.equal(other.host.storage.session.getItem(REAUTH_MARKER_KEY),null);
    assert.equal(other.events.some(event=>event.startsWith('navigate')),false);
  }

  const slow=deferred();
  const closed=await openReady({...recent(false,{password:false,google:true}),'POST /api/auth/google/reauth/start':()=>slow.promise});
  closed.find('accountDeletionGoogle').click();
  closed.controller.close();
  slow.resolve(start);
  await flush();
  assert.equal(closed.events.some(event=>event.startsWith('navigate')),false,'a closed dialog never leaves the page');
  assert.equal(closed.host.storage.session.getItem(REAUTH_MARKER_KEY),null);
  start=new Error('unused');
});

test('back from Google the dialog reopens for the same member only',async()=>{
  const marker=JSON.stringify({v:1,actor_id:7,created_at:NOW-1000});
  const ui=harness({routes:{...ELIGIBLE,...recent(true)},session:{[REAUTH_MARKER_KEY]:marker}});
  ui.state.result='success';
  ui.controller.sync();
  await flush();
  assert.equal(ui.controller.state.step,'type');
  assert.equal(ui.host.storage.session.getItem(REAUTH_MARKER_KEY),null);

  const failed=harness({routes:{...ELIGIBLE,...recent(false)},session:{[REAUTH_MARKER_KEY]:marker}});
  failed.state.result='error';
  failed.controller.sync();
  await flush();
  assert.equal(failed.controller.state.step,'reauth');
  assert.equal(failed.find('accountDeletionDialogStatus').textContent,COPY.reauthGoogleFailed);

  const stranger=harness({routes:ELIGIBLE,userId:9,session:{[REAUTH_MARKER_KEY]:marker}});
  stranger.state.result='success';
  stranger.controller.sync();
  await flush();
  assert.equal(stranger.controller.state.step,'closed');
  const nothing=harness({routes:ELIGIBLE,session:{[REAUTH_MARKER_KEY]:marker}});
  nothing.controller.sync();
  await flush();
  assert.equal(nothing.controller.state.step,'closed');
  assert.equal(nothing.host.storage.session.getItem(REAUTH_MARKER_KEY),marker,'without an OAuth result the marker waits');
});

test('server refusals: expired proof, last owner, signed out, rate limit and outages',async()=>{
  let answer;
  let recentOk=true;
  const routes={'GET /api/auth/recent-auth':()=>({ok:true,recentAuth:{ok:recentOk},methods:{password:true}}),
    'POST /api/auth/account/delete':()=>{ if(answer instanceof Error) throw answer; return answer; }};
  async function finalStep(){
    const ui=await openReady(routes);
    ui.find('accountDeletionConfirm').value=CONFIRMATION_WORD;
    ui.find('accountDeletionConfirm').fire('input');
    ui.find('accountDeletionContinue').click();
    return ui;
  }
  answer=problem(403,{code:'recent_auth_required'});
  let ui=await finalStep();
  recentOk=false;
  ui.find('accountDeletionConfirmDelete').click();
  await flush();
  assert.equal(ui.controller.state.step,'reauth');
  assert.equal(ui.find('accountDeletionDialogStatus').textContent,COPY.reauthExpired);
  recentOk=true;

  answer=problem(409,{code:'last_owner',circles:[{name:'Graph Club',is_primary:false}]});
  ui=await finalStep();
  ui.find('accountDeletionConfirmDelete').click();
  await flush();
  assert.equal(ui.controller.state.step,'blocked');
  assert.match(ui.find('accountDeletionDialogText').textContent,/Graph Club/);
  assert.equal(ui.find('accountDeletionBlocked').hidden,false,'the section shows the same guidance');
  ui.find('accountDeletionClose').click();
  assert.equal(ui.controller.state.step,'closed');

  answer=problem(409,{code:'last_admin'});
  ui=await finalStep();
  ui.find('accountDeletionConfirmDelete').click();
  await flush();
  assert.match(ui.find('accountDeletionDialogText').textContent,/only app admin/);

  for(const [failure,status] of [[problem(401),COPY.signedOut],[problem(429),COPY.rateLimited],
    [problem(503),COPY.failed],[{ok:false},COPY.failed]]){
    answer=failure;
    ui=await finalStep();
    ui.find('accountDeletionConfirmDelete').click();
    await flush();
    assert.equal(ui.controller.state.step,'final');
    assert.equal(ui.find('accountDeletionDialogStatus').textContent,status);
    assert.equal(ui.events.includes('reload /'),false);
  }
});

test('a member change closes the dialog and reloads eligibility; sign-out survives a failing hook',async()=>{
  const ui=await openReady({...recent(true),'POST /api/auth/account/delete':{ok:true,status:'deleted'}});
  ui.state.userId=8;
  ui.controller.sync();
  assert.deepEqual(ui.events,['open','close']);
  assert.equal(ui.controller.state.userId,8);
  assert.equal(ui.calls.filter(call=>call==='GET /api/auth/account/delete').length,2);

  const broken=await openReady({...recent(true),'POST /api/auth/account/delete':{ok:true,status:'already_deleted'}});
  broken.host.signOutLocally=async()=>{ throw new Error('hook failed'); };
  broken.host.storage.session={setItem(){ throw new Error('blocked'); },length:0};
  broken.controller.open?.();
  broken.find('accountDeletionConfirm').value=CONFIRMATION_WORD;
  broken.find('accountDeletionConfirm').fire('input');
  broken.find('accountDeletionContinue').click();
  broken.find('accountDeletionConfirmDelete').click();
  await flush();
  assert.equal(broken.events.at(-1),'reload /');
});

test('racing events while a request is busy are ignored, and broken storage never strands the flow',async()=>{
  const slowPassword=deferred();
  const ui=await openReady({...recent(false,{password:true,google:true}),
    'POST /api/auth/recent-auth':()=>slowPassword.promise,
    'POST /api/auth/google/reauth/start':()=>{ throw problem(503); }});
  ui.find('accountDeletionPassword').value='secret';
  ui.state.dialog.onEnter();
  ui.state.dialog.onEnter();
  ui.find('accountDeletionGoogle').fire('click');
  assert.equal(ui.calls.filter(call=>call.startsWith('POST')).length,1,'Enter and a racing Google click are ignored while busy');
  slowPassword.resolve({ok:true});
  await flush();
  assert.equal(ui.controller.state.step,'type');

  const slowDelete=deferred();
  const final=await openReady({...recent(true),'POST /api/auth/account/delete':()=>slowDelete.promise});
  final.find('accountDeletionConfirm').value=CONFIRMATION_WORD;
  final.find('accountDeletionConfirm').fire('input');
  final.find('accountDeletionContinue').click();
  final.find('accountDeletionConfirmDelete').fire('click');
  final.find('accountDeletionConfirmDelete').fire('click');
  assert.equal(final.calls.filter(call=>call.startsWith('POST /api/auth/account/delete')).length,1);
  slowDelete.resolve({ok:true,status:'deleted'});
  await flush();
  assert.equal(final.events.at(-1),'reload /');

  const broken=await openReady({...recent(false,{password:false,google:true})});
  broken.host.storage.session={setItem(){ throw new Error('blocked'); },removeItem(){ throw new Error('blocked'); }};
  broken.find('accountDeletionGoogle').click();
  await flush();
  assert.equal(broken.find('accountDeletionDialogStatus').textContent,COPY.googleUnavailable);
});
