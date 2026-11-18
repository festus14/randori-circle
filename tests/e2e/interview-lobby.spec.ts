import { createHash } from 'node:crypto';
import { Browser, BrowserContext, Page, Request, Route, WebSocketRoute, expect, test } from '@playwright/test';
import * as Y from 'yjs';

import { mockApi, openRoomPanel, originalQuestionFixture } from './helpers';

// Two-participant interview lifecycle (#464, ID-99): lobby -> admit -> live
// -> lock (held candidate edit) -> unlock (replayed) -> end, plus the
// schedule-driven start. The fixture server applies the same rules as the
// API: only the interviewer controls; the candidate writes nothing in the
// lobby, never changes the selection, and is held while editing is locked.
const room='week_42_pair_7';
const origin=`http://127.0.0.1:${Number(process.env.E2E_PORT||4173)}`;
const starter=originalQuestionFixture.languages.javascript.starter;
const DURATION=25*60*1000;
const users={
  1:{id:1,email:'one@example.test',name:'One',display_name:'One',color:'#c8f6a0',is_available:true,tz:'UTC',interview_focus:'both'},
  2:{id:2,email:'two@example.test',name:'Two',display_name:'Two',color:'#9cc0b5',is_available:true,tz:'UTC',interview_focus:'both'},
} as const;
const CANDIDATE=1,INTERVIEWER=2;

function base64(bytes:Uint8Array){ return Buffer.from(bytes).toString('base64'); }
function digest(value:Uint8Array|string){ return createHash('sha256').update(value).digest('hex'); }

class InterviewServer{
  revision=0; admitted=false; locked=false; ended=false; scheduledStartMs:number|null=null;
  timerState:'paused'|'running'='paused'; remainingMs=DURATION; anchorMs:number|null=null;
  controlPosts:Array<{actorId:number;action:string;status:number}>=[];
  workspacePosts:Array<{actorId:number;status:number;code?:string}>=[];
  codePosts:Array<{actorId:number;status:number}>=[];
  doc=new Y.Doc(); docRevision=1; persisted='';
  relayEnabled=false; relayTokens:Array<{actorId:number;status:number}>=[];
  peers=new Map<WebSocketRoute,{topic:string;actorId:number}>(); broadcasts:Array<{actorId:number}>=[];
  workspaceRevision=1;
  constructor(){ this.doc.getText('code').insert(0,`// PREPARED\n${starter}`); this.persisted=base64(Y.encodeStateAsUpdate(this.doc)); }
  candidateInLobby(actorId:number){ return actorId===CANDIDATE&&!this.live()&&!this.terminal(); }

  scheduleRun(){ return !this.admitted&&this.timerState==='paused'&&this.remainingMs===DURATION&&this.scheduledStartMs!==null&&Date.now()>=this.scheduledStartMs; }
  live(){ return this.admitted||this.timerState==='running'||this.remainingMs<DURATION||this.scheduleRun(); }
  remaining(){
    if(this.scheduleRun()) return Math.max(0,DURATION-(Date.now()-(this.scheduledStartMs as number)));
    if(this.timerState!=='running'||this.anchorMs===null) return this.remainingMs;
    return Math.max(0,this.remainingMs-(Date.now()-this.anchorMs));
  }
  terminal(){ return this.ended||this.remaining()===0; }
  candidateBlocked(actorId:number){ return actorId===CANDIDATE&&(!this.live()||this.locked||this.terminal()); }
  version(){ return this.revision.toString(16).padStart(64,'0'); }
  controls(actorId:number){
    const remaining=this.remaining(),terminal=this.terminal(),role=actorId===CANDIDATE?'candidate':'interviewer';
    const running=this.scheduleRun()||this.timerState==='running';
    return {ok:true,room_id:room,session_controls:{
      timer_state:remaining===0?'expired':running?'running':'paused',remaining_ms:Math.floor(remaining),duration_ms:DURATION,
      candidate_user_id:CANDIDATE,partner_user_id:actorId===1?2:1,viewer_role:role,partner_role:role==='candidate'?'interviewer':'candidate',
      terminal,interview_mode:true,can_control:role==='interviewer'&&!terminal,
      end_reason:terminal?(this.ended?'interviewer_ended':'timer_expired'):null,
      lobby_mode:true,phase:terminal?'ended':this.live()?'live':'lobby',
      admission:this.admitted?'interviewer':this.scheduleRun()?'schedule':null,
      scheduled_start_at:this.scheduledStartMs===null?null:new Date(this.scheduledStartMs).toISOString(),
      editing_locked:this.locked,can_edit:!terminal&&(role==='interviewer'||this.live()&&!this.locked),
      completion_version:'c'.repeat(64),observed_at:new Date().toISOString(),updated_at:null,version:this.version(),
    }};
  }
  controlsRoute=async(route:Route,actorId:number)=>{
    const request=route.request();
    if(request.method()!=='POST'){ await route.fulfill({contentType:'application/json',body:JSON.stringify(this.controls(actorId))}); return; }
    const body=request.postDataJSON() as {action:string;base_version:string};
    const reply=async(status:number,payload:Record<string,unknown>)=>{
      this.controlPosts.push({actorId,action:body.action,status});
      await route.fulfill({status,contentType:'application/json',body:JSON.stringify(payload)});
    };
    if(actorId===CANDIDATE) return reply(404,{error:'pair not found'});
    if(this.terminal()) return reply(409,{...this.controls(actorId),code:'interview_session_ended',error:'The interview has ended.'});
    if(body.base_version!==this.version()) return reply(409,{...this.controls(actorId),code:'session_controls_changed',error:'Session controls changed.'});
    if(body.action==='admit') this.admitted=true;
    else if(body.action==='lock_editing') this.locked=true;
    else if(body.action==='unlock_editing') this.locked=false;
    else if(body.action==='end'){ this.ended=true; this.timerState='paused'; this.remainingMs=0; }
    else if(body.action==='start'){
      if(!this.live()) return reply(409,{...this.controls(actorId),code:'interview_lobby',error:'Admit the candidate first.'});
      this.timerState='running'; this.anchorMs=Date.now();
    }
    this.revision+=1;
    return reply(200,this.controls(actorId));
  };
  documentResponse(after=0,actorId=0){
    const code=this.doc.getText('code').toString();
    return {ok:true,...(this.relayEnabled?{realtime_relay:true,realtime_relay_direction:actorId===CANDIDATE?'receive':'send'}:{}),
      changed:this.docRevision!==after,created:false,revision:this.docRevision,
      document_version:digest(JSON.stringify([this.docRevision,this.persisted])),state:this.docRevision!==after?this.persisted:null,
      code_hash:digest(code),updated_at:'2026-09-20T10:00:00.000Z'};
  }
  codeDocument(actorId:number){
    return (request:Request)=>{
      const url=new URL(request.url());
      if(request.method()==='GET'){
        if(this.candidateInLobby(actorId)) return {_status:409,ok:false,code:'interview_lobby',error:'Waiting for the interviewer to admit you.'};
        return this.documentResponse(Number(url.searchParams.get('after_revision')||0),actorId);
      }
      if(this.terminal()){ this.codePosts.push({actorId,status:409}); return {_status:409,ok:false,code:'session_completed',error:'ended'}; }
      if(this.candidateBlocked(actorId)){
        this.codePosts.push({actorId,status:409});
        return {_status:409,ok:false,code:'interview_editing_locked',error:'The interviewer has paused candidate editing.'};
      }
      const body=request.postDataJSON() as {update:string};
      const before=this.persisted;
      Y.applyUpdate(this.doc,Buffer.from(body.update,'base64'));
      this.persisted=base64(Y.encodeStateAsUpdate(this.doc));
      if(this.persisted!==before) this.docRevision+=1;
      this.codePosts.push({actorId,status:200});
      return {...this.documentResponse(0,actorId),idempotent:this.persisted===before};
    };
  }
  relayToken(actorId:number){
    return ()=>{
      const denied=!this.relayEnabled||this.terminal()||this.candidateBlocked(actorId);
      this.relayTokens.push({actorId,status:denied?404:200});
      if(denied) return {_status:404,error:'pair not found'};
      return {ok:true,url:'https://relay-test.supabase.co',publishable_key:'sb_publishable_test_public_key_461',
        topic:`rc-code:v1:${room}:${digest('javascript')}`,token:'header.payload.signature',
        expires_at:Math.floor(Date.now()/1000)+(actorId===CANDIDATE?90:300)};
    };
  }
  relaySocket(actorId:number){
    return (socket:WebSocketRoute)=>{
      socket.onClose(()=>this.peers.delete(socket));
      socket.onMessage(raw=>{
        const frame=JSON.parse(typeof raw==='string'?raw:raw.toString());
        if(frame.event==='phx_join'){
          this.peers.set(socket,{topic:frame.topic,actorId});
          socket.send(JSON.stringify({topic:frame.topic,event:'phx_reply',ref:frame.ref,join_ref:frame.join_ref,payload:{status:'ok',response:{}}}));
        }else if(frame.event==='heartbeat') socket.send(JSON.stringify({topic:'phoenix',event:'phx_reply',ref:frame.ref,payload:{status:'ok'}}));
        else if(frame.event==='broadcast'){
          this.broadcasts.push({actorId});
          for(const [peer,info] of this.peers) if(peer!==socket&&info.topic===frame.topic) peer.send(JSON.stringify({topic:info.topic,event:'broadcast',payload:frame.payload,ref:null,join_ref:'1'}));
        }
      });
    };
  }
  // What a modified candidate client holding an earlier token could inject.
  forge(text:string){
    const doc=new Y.Doc(); Y.applyUpdate(doc,Buffer.from(this.persisted,'base64'));
    const before=Y.encodeStateVector(doc); doc.getText('code').insert(0,text);
    const update=base64(Y.encodeStateAsUpdate(doc,before)); doc.destroy();
    for(const [peer,info] of this.peers) if(info.actorId===INTERVIEWER) peer.send(JSON.stringify({topic:info.topic,event:'broadcast',
      payload:{type:'broadcast',event:'y-update',payload:{sender:'f'.repeat(32),seq:1,update}},ref:null,join_ref:'1'}));
  }
  snapshot(){
    return {schema_version:3,revision:this.workspaceRevision,client_id:'workspace-server',client_seq:this.workspaceRevision,
      code:this.doc.getText('code').toString(),language:'javascript',question_id:originalQuestionFixture.slug,
      question_version:originalQuestionFixture.version,board:{shapes:[]}};
  }
  workspace(actorId:number){
    return (request:Request)=>{
      const url=new URL(request.url());
      if(request.method()==='GET'&&url.searchParams.get('channel')==='workspace'){
        if(this.candidateInLobby(actorId)){
          return {ok:true,lobby:true,revision:0,snapshot:url.searchParams.get('after_revision')==='0'
            ?{...this.snapshot(),revision:0,client_id:'interview-lobby',client_seq:0,code:'',board:{shapes:[]}}:null};
        }
        return {ok:true,room_id:room,revision:this.workspaceRevision,snapshot:this.snapshot()};
      }
      if(request.method()!=='POST') return {ok:true,signals:[],after:0,count:0};
      const payload=(request.postDataJSON() as {payload:Record<string,unknown>}).payload;
      if(actorId===CANDIDATE&&!this.live()){ this.workspacePosts.push({actorId,status:409}); return {_status:409,ok:false,code:'interview_lobby',current:this.snapshot()}; }
      if(actorId===CANDIDATE&&(payload.language!=='javascript'||payload.question_id!==originalQuestionFixture.slug)){
        this.workspacePosts.push({actorId,status:409}); return {_status:409,ok:false,code:'interview_selection_owned',current:this.snapshot()};
      }
      this.workspaceRevision+=1; this.workspacePosts.push({actorId,status:200});
      return {ok:true,room_id:room,revision:this.workspaceRevision,snapshot:this.snapshot()};
    };
  }
}

async function open(browser:Browser,server:InterviewServer,actorId:1|2):Promise<{context:BrowserContext;page:Page}>{
  const context=await browser.newContext(),page=await context.newPage(),user=users[actorId];
  await page.route(/^https:\/\//,route=>route.abort());
  await mockApi(page,{
    '/api/auth/me':{ok:true,user},'/api/profile':{ok:true,user},
    '/api/questions':{ok:true,questions:[originalQuestionFixture],count:1},
    '/api/my-pair':{ok:true,paired:true,room_id:room,week_id:42,week:{id:42,week_label:'2099-W42'},
      pair:{pg_id:7,week_id:42,user_a_id:1,user_b_id:2,user_c_id:null,is_ai_pair:false,is_ai:false,topic:'Pick together'},
      partner:users[actorId===1?2:1],partners:[users[actorId===1?2:1]],me:user},
    '/api/session-completion':{ok:true,room_id:room,completion:{state:'not_recorded',viewer_confirmed:false,confirmed_count:0,
      required_count:2,version:'c'.repeat(64),completed_at:null}},
    '/api/video/signal':server.workspace(actorId),'/api/code-document':server.codeDocument(actorId),
    '/api/code-document/relay-token':server.relayToken(actorId),
  });
  // routeWebSocket never connects to a server: no Supabase/network access.
  await page.routeWebSocket('wss://relay-test.supabase.co/realtime/v1/websocket**',server.relaySocket(actorId));
  await page.route(/\/api\/session-controls(?:\?.*)?$/,route=>server.controlsRoute(route,actorId));
  await context.addCookies([{name:'randori_session',value:`session-${actorId}`,url:origin,httpOnly:true,sameSite:'Lax'}]);
  await page.addInitScript(member=>{
    localStorage.clear(); sessionStorage.clear();
    for(const key of ['randori-onboarded','randori-banner-dismissed','randori-profile-done','randori-landing-dismissed']) localStorage.setItem(key,'1');
    localStorage.setItem('randori-me',JSON.stringify(member));
  },user);
  await page.goto(`/join/${room}`,{waitUntil:'domcontentloaded'});
  await expect(page.locator('#view-code')).toBeVisible();
  await expect(page.locator('#monacoFallbackNote')).toBeVisible({timeout:12_000});
  await openRoomPanel(page,'session');
  await expect(page.getByTestId('session-controls-status')).not.toContainText('Loading',{timeout:12_000});
  return {context,page};
}

async function type(page:Page,value:string){
  const editor=page.locator('#editor');
  await editor.evaluate((node,text)=>{
    const area=node as HTMLTextAreaElement; area.value=`${text}${area.value}`;
    area.dispatchEvent(new Event('input',{bubbles:true}));
  },value);
}

test('scheduled interview moves lobby -> live -> locked -> unlocked -> ended for both participants and a late join',async({browser})=>{
  const server=new InterviewServer();
  const candidate=await open(browser,server,CANDIDATE),interviewer=await open(browser,server,INTERVIEWER);
  const contexts=[candidate.context,interviewer.context];
  try{
    const c=candidate.page,i=interviewer.page;
    await expect(c.getByTestId('session-controls-status')).toContainText('You are in the lobby');
    await expect(i.getByTestId('session-controls-status')).toContainText('Your candidate is in the lobby');
    await expect(c.getByTestId('session-controls-admit')).toBeHidden();
    await expect(c.getByTestId('session-controls-lock')).toBeHidden();
    await expect(i.getByTestId('session-controls-admit')).toBeEnabled();
    await expect(i.getByTestId('session-controls-start-pause')).toBeDisabled();
    await expect(c.locator('#editor')).toHaveJSProperty('readOnly',true);
    await expect(c.locator('#editor')).not.toHaveValue(/PREPARED/);
    await expect(i.locator('#editor')).toHaveValue(/PREPARED/,{timeout:12_000});
    for(const id of ['#questionSelect','#langSelect','#runBtn']) await expect(c.locator(id)).toBeDisabled();
    await expect(i.locator('#langSelect')).toBeEnabled();
    expect(await c.evaluate(()=>window._randori_session_controls?.mutate('admit'))).toBe(false);
    expect(server.controlPosts).toHaveLength(0);
    expect(server.workspacePosts.filter(post=>post.actorId===CANDIDATE)).toHaveLength(0);

    await i.getByTestId('session-controls-admit').click();
    await expect(i.getByTestId('session-controls-status')).toContainText('Candidate admitted');
    await expect(c.getByTestId('session-controls-status')).toContainText('admitted you',{timeout:8_000});
    await expect(c.locator('#editor')).toHaveJSProperty('readOnly',false);
    await expect(c.locator('#questionSelect')).toBeDisabled();
    await expect(c.locator('#langSelect')).toBeDisabled();
    await expect(c.locator('#codeSyncStatus')).toHaveText('synced',{timeout:12_000});
    await expect(c.locator('#editor')).toHaveValue(/PREPARED/,{timeout:12_000});
    await type(c,'cand-');
    await expect.poll(()=>server.doc.getText('code').toString(),{timeout:12_000}).toContain('cand-');

    // The lock lands on the server before the candidate's next poll: the
    // candidate's racing edit is held locally and visibly, not lost.
    await i.getByTestId('session-controls-lock').click();
    await expect(i.getByTestId('session-controls-lock')).toHaveText('Unlock candidate editing');
    await type(c,'held-');
    await expect(c.locator('#codeSyncStatus')).toContainText('editing paused',{timeout:12_000});
    expect(server.doc.getText('code').toString()).not.toContain('held-');
    await expect(c.locator('#editor')).toHaveJSProperty('readOnly',true,{timeout:8_000});
    await expect(c.getByTestId('session-controls-status')).toContainText('paused your editing');
    await expect(c.locator('#editor')).toHaveValue(/^held-cand-/);
    await type(i,'int-');
    await expect.poll(()=>server.doc.getText('code').toString(),{timeout:12_000}).toContain('int-');

    await i.getByTestId('session-controls-lock').click();
    await expect(i.getByTestId('session-controls-lock')).toHaveText('Lock candidate editing');
    await expect.poll(()=>server.doc.getText('code').toString(),{timeout:15_000}).toContain('held-');
    expect(server.doc.getText('code').toString()).toContain('int-');
    await expect(c.locator('#editor')).toHaveJSProperty('readOnly',false);
    await expect(c.locator('#codeSyncStatus')).toHaveText('synced',{timeout:12_000});
    expect(server.workspacePosts.filter(post=>post.actorId===CANDIDATE&&post.status!==200)).toHaveLength(0);

    i.once('dialog',dialog=>dialog.accept());
    await i.getByTestId('session-controls-end').click();
    for(const page of [c,i]){
      await expect(page.getByTestId('session-controls-status')).toContainText('Interview ended',{timeout:8_000});
      await expect(page.locator('#editor')).toHaveJSProperty('readOnly',true);
      await expect(page.locator('#runBtn')).toBeDisabled();
    }
    const late=await open(browser,server,CANDIDATE); contexts.push(late.context);
    await expect(late.page.getByTestId('session-controls-status')).toContainText('Interview ended');
    await expect(late.page.locator('#editor')).toHaveJSProperty('readOnly',true);
  }finally{ await Promise.all(contexts.map(context=>context.close())); }
});

test('the agreed schedule admits the waiting candidate without an interviewer action',async({browser})=>{
  const server=new InterviewServer();
  server.scheduledStartMs=Date.now()+3_000;
  const candidate=await open(browser,server,CANDIDATE),interviewer=await open(browser,server,INTERVIEWER);
  try{
    await expect(candidate.page.getByTestId('session-controls-status')).toContainText('starts automatically');
    await expect(candidate.page.locator('#editor')).toHaveJSProperty('readOnly',true);
    await expect(candidate.page.getByTestId('session-controls-status')).toContainText('started on schedule',{timeout:12_000});
    for(const page of [candidate.page,interviewer.page]){
      await expect(page.getByTestId('session-controls-status')).not.toContainText('lobby',{timeout:12_000});
      await expect(page.getByTestId('session-controls-start-pause')).toHaveText('Pause');
    }
    await expect(candidate.page.locator('#editor')).toHaveJSProperty('readOnly',false);
    expect(server.controlPosts).toHaveLength(0);
  }finally{ await candidate.context.close(); await interviewer.context.close(); }
});

test('the realtime relay is one-way in interview mode: a locked candidate never reaches the interviewer document',async({browser})=>{
  const server=new InterviewServer(); server.relayEnabled=true; server.admitted=true;
  const candidate=await open(browser,server,CANDIDATE),interviewer=await open(browser,server,INTERVIEWER);
  try{
    const c=candidate.page,i=interviewer.page;
    await expect.poll(()=>c.evaluate(()=>window._randori_crdt?.relayConnected),{timeout:12_000}).toBe(true);
    await expect.poll(()=>i.evaluate(()=>window._randori_crdt?.relayConnected),{timeout:12_000}).toBe(true);
    await expect(c.locator('#codeSyncStatus')).toHaveText('synced',{timeout:12_000});
    // Interviewer -> candidate stays realtime.
    await type(i,'live-int-');
    await expect(c.locator('#editor')).toHaveValue(/live-int-/,{timeout:3_000});
    expect(server.broadcasts.some(item=>item.actorId===INTERVIEWER)).toBe(true);
    // The candidate never broadcasts; its edits travel over HTTPS only.
    await type(c,'cand-https-');
    await expect.poll(()=>server.doc.getText('code').toString(),{timeout:12_000}).toContain('cand-https-');
    expect(server.broadcasts.filter(item=>item.actorId===CANDIDATE)).toHaveLength(0);

    await i.getByTestId('session-controls-lock').click();
    await expect(i.getByTestId('session-controls-lock')).toHaveText('Unlock candidate editing');
    await expect(c.locator('#editor')).toHaveJSProperty('readOnly',true,{timeout:8_000});
    const before=server.doc.getText('code').toString();
    // A forged candidate-origin packet (e.g. a stale token and a modified
    // client) is dropped by the interviewer's browser and never persisted.
    server.forge('FORGED-');
    await i.waitForTimeout(2_500);
    await expect(i.locator('#editor')).not.toHaveValue(/FORGED-/);
    expect(server.doc.getText('code').toString()).toBe(before);
    expect(server.codePosts.filter(post=>post.actorId===INTERVIEWER&&post.status===200).length).toBeGreaterThan(0);
    expect(server.doc.getText('code').toString()).not.toContain('FORGED-');
    await type(c,'held-');
    await c.waitForTimeout(1_500);
    expect(server.broadcasts.filter(item=>item.actorId===CANDIDATE)).toHaveLength(0);
    await expect(i.locator('#editor')).not.toHaveValue(/held-/);
    expect(server.doc.getText('code').toString()).not.toContain('held-');
    await expect.poll(()=>server.relayTokens.some(item=>item.actorId===CANDIDATE&&item.status===404),{timeout:1_000}).toBe(false);
    await c.evaluate(()=>window._randori_crdt?.deactivate?.());
    await c.evaluate(()=>window._randori_crdt?.activate?.());
    await expect.poll(()=>server.relayTokens.some(item=>item.actorId===CANDIDATE&&item.status===404),{timeout:12_000}).toBe(true);
  }finally{ await candidate.context.close(); await interviewer.context.close(); }
});
