import { createHash } from 'node:crypto';
import { expect, Page, Request, test, WebSocketRoute } from '@playwright/test';
import * as Y from 'yjs';

import { mockApi, originalQuestionFixture, setCode } from './helpers';

const room='week_42_pair_7';
const origin=`http://127.0.0.1:${Number(process.env.E2E_PORT||4173)}`;
const starter=originalQuestionFixture.languages.javascript.starter;

type User={id:number;email:string;display_name:string;name:string;color:string;is_available:boolean;tz:string;interview_focus:string};
const users:User[]=[
  {id:1,email:'one@example.test',display_name:'One',name:'One',color:'#c8f6a0',is_available:true,tz:'UTC',interview_focus:'both'},
  {id:2,email:'two@example.test',display_name:'Two',name:'Two',color:'#9cc0b5',is_available:true,tz:'UTC',interview_focus:'both'},
];

function base64(bytes:Uint8Array){ return Buffer.from(bytes).toString('base64'); }
function digest(bytes:Uint8Array|string){ return createHash('sha256').update(bytes).digest('hex'); }

type StoredDocument={doc:Y.Doc;revision:number;persisted:string};

class CodeStore{
  postCount=0;
  getCount=0;
  runCount=0;
  completed=false;
  relayEnabled=false;
  presenceEnabled=false;
  // #462: one TTL row per participant, like the server's keyed heartbeat.
  presenceRows=new Map<number,number>();
  presenceDown=new Set<number>();
  presenceCalls:{user:number;body:Record<string,unknown>}[]=[];
  holdWrites:Promise<void>|null=null;
  private documents=new Map<string,StoredDocument>();
  constructor(){
    for(const language of ['javascript','python'] as const){
      const doc=new Y.Doc(); doc.getText('code').insert(0,originalQuestionFixture.languages[language].starter);
      this.documents.set(language,{doc,revision:1,persisted:base64(Y.encodeStateAsUpdate(doc))});
    }
  }
  restart(){
    for(const [language,current] of this.documents){
      const next=new Y.Doc(); Y.applyUpdate(next,Buffer.from(current.persisted,'base64')); current.doc.destroy();
      this.documents.set(language,{...current,doc:next});
    }
  }
  version(language='javascript'){
    const current=this.get(language);
    return digest(JSON.stringify([current.revision,digest(Buffer.from(current.persisted,'base64')),digest(this.code(language))]));
  }
  code(language='javascript'){ return this.get(language).doc.getText('code').toString(); }
  response(after=0,language='javascript'){
    const current=this.get(language);
    return {ok:true,...(this.relayEnabled?{realtime_relay:true}:{}),...(this.presenceEnabled?{presence:true}:{}),changed:current.revision!==after,created:false,revision:current.revision,
      document_version:this.version(language),state:current.revision!==after?current.persisted:null,
      code_hash:digest(this.code(language)),updated_at:'2026-09-20T10:00:00.000Z'};
  }
  handle=async(request:Request):Promise<Record<string,unknown>>=>{
    const url=new URL(request.url());
    const body=request.method()==='POST'?request.postDataJSON() as {update?:string;language?:string}:null;
    const language=String(body?.language||url.searchParams.get('language')||'');
    const current=this.get(language);
    if(request.method()==='GET'){
      this.getCount+=1;
      return this.response(Number(url.searchParams.get('after_revision')||0),language);
    }
    this.postCount+=1;
    if(this.holdWrites) await this.holdWrites;
    if(this.completed) return {_status:409,ok:false,error:'session is completed',code:'session_completed'};
    if(typeof body.update!=='string') return {_status:400,ok:false,error:'invalid update'};
    const before=current.persisted;
    Y.applyUpdate(current.doc,Buffer.from(body.update,'base64'));
    current.persisted=base64(Y.encodeStateAsUpdate(current.doc));
    const idempotent=current.persisted===before;
    if(!idempotent) current.revision+=1;
    return {...this.response(0,language),idempotent};
  };
  presence(request:Request,user:number):Record<string,unknown>{
    const body=request.postDataJSON() as Record<string,unknown>;
    this.presenceCalls.push({user,body});
    if(!this.presenceEnabled) return {_status:404,error:'pair not found'};
    if(this.presenceDown.has(user)) return {_status:503,error:'presence unavailable'};
    if(body.state==='leave'){ this.presenceRows.delete(user); return {ok:true}; }
    this.presenceRows.set(user,Date.now()+20_000);
    const partner=user===1?2:1;
    return {ok:true,seat:user===1?'a':'b',partner_online:(this.presenceRows.get(partner)||0)>Date.now(),ttl_seconds:20,interval_seconds:5,
      ...(body.state==='join'?{partner:{display_name:users[partner-1].display_name,color:users[partner-1].color}}:{})};
  }
  private get(language:string){
    const current=this.documents.get(language); if(!current) throw new Error(`missing ${language} document`);
    return current;
  }
}

function pair(user:User){
  const partner=user.id===1?users[1]:users[0];
  return {ok:true,paired:true,room_id:room,week_id:42,
    week:{id:42,week_label:'2026-W38'},
    pair:{pg_id:7,user_a_id:1,user_b_id:2,is_ai:false,topic:'Pick together'},partner,partners:[partner],me:user};
}

function workspace(request:Request){
  const url=new URL(request.url());
  if(request.method()==='GET'&&url.searchParams.get('channel')==='workspace'){
    return {ok:true,room_id:room,revision:1,snapshot:{schema_version:3,revision:1,
      client_id:'workspace-server',client_seq:1,code:starter,language:'javascript',
      question_id:originalQuestionFixture.slug,question_version:originalQuestionFixture.version,board:{shapes:[]}}};
  }
  if(request.method()==='POST'){
    const body=request.postDataJSON() as {payload?:Record<string,unknown>};
    return {ok:true,room_id:room,revision:2,snapshot:{...body.payload,revision:2}};
  }
  return {ok:true,signals:[],after:0,count:0};
}

async function open(page:Page,user:User,store:CodeStore,workspaceHandler=workspace,{waitForSync=true}={}){
  await page.route(/(cdnjs\.cloudflare\.com|cdn\.jsdelivr\.net|unpkg\.com)/,route=>route.abort());
  await mockApi(page,{
    '/api/auth/me':{ok:true,user},'/api/profile':{ok:true,user},'/api/my-pair':()=>pair(user),
    '/api/video/signal':workspaceHandler,'/api/code-document':store.handle,
    '/api/code-document/presence':request=>store.presence(request,user.id),
    // This suite exercises legacy peer completion, not interview-mode expiry.
    // Supply the authoritative peer projection so terminal copy is not inferred
    // from a missing controls response that could also be an interview end.
    '/api/session-controls':{ok:true,room_id:room,session_controls:{
      timer_state:'paused',remaining_ms:1500000,duration_ms:1500000,candidate_user_id:1,
      partner_user_id:user.id===1?2:1,viewer_role:user.id===1?'candidate':'interviewer',
      partner_role:user.id===1?'interviewer':'candidate',terminal:false,
      completion_version:'0'.repeat(64),version:'a'.repeat(64),updated_at:null,observed_at:new Date().toISOString(),
    }},
    '/api/code-document/relay-token':request=>{
      if(!store.relayEnabled) return {_status:404,error:'pair not found'};
      const body=request.postDataJSON() as {room_id:string;language:string};
      return {ok:true,url:'https://relay-test.supabase.co',publishable_key:'sb_publishable_test_public_key_461',
        topic:`rc-code:v1:${body.room_id}:${digest(body.language)}`,token:'header.payload.signature',
        expires_at:Math.floor(Date.now()/1000)+300};
    },
    '/api/execute':request=>{
      const body=request.postDataJSON() as {document_version?:string;language?:string};
      const language=String(body.language||'javascript');
      if(body.document_version!==store.version(language)) return {_status:409,error:'code document changed',code:'code_document_changed',latest_document_version:store.version(language)};
      store.runCount+=1;
      return {ok:true,passed_count:1,total_count:1,results:[{idx:0,pass:true}],run_id:store.runCount};
    },
  });
  await page.context().clearCookies();
  await page.context().addCookies([{name:'randori_session',value:`session-${user.id}`,url:origin,httpOnly:true,sameSite:'Lax'}]);
  await page.addInitScript(member=>{
    localStorage.clear(); sessionStorage.clear();
    localStorage.setItem('randori-onboarded','1'); localStorage.setItem('randori-banner-dismissed','1');
    localStorage.setItem('randori-profile-done','1'); localStorage.setItem('randori-landing-dismissed','1');
    localStorage.setItem('randori-me',JSON.stringify(member));
  },user);
  await page.goto(`/join/${room}`,{waitUntil:'domcontentloaded'});
  await expect(page.locator('#view-code')).toBeVisible();
  await expect(page.locator('#monacoFallbackNote')).toBeVisible({timeout:12_000});
  if(waitForSync){
    await expect(page.locator('#codeSyncStatus')).toHaveText('synced',{timeout:12_000});
    await expect(page.locator('#runBtn')).toBeEnabled();
  }
}

async function editorValue(page:Page){ return page.locator('#editor').inputValue(); }
async function insertAt(page:Page,offset:number,value:string){
  const editor=page.locator('#editor'); await editor.focus();
  await editor.evaluate((node,index)=>(node as HTMLTextAreaElement).setSelectionRange(index,index),offset);
  await page.keyboard.type(value);
}

test('two browsers converge through overlapping edits, offline replay, reload, and server restart',async({browser})=>{
  const store=new CodeStore();
  const contexts=await Promise.all([browser.newContext(),browser.newContext()]);
  const pages=await Promise.all(contexts.map(context=>context.newPage()));
  try{
    await Promise.all([open(pages[0],users[0],store),open(pages[1],users[1],store)]);
    const offset=starter.indexOf('return');
    await Promise.all([insertAt(pages[0],offset,'A'),insertAt(pages[1],offset,'B')]);
    await expect.poll(()=>store.code(),{timeout:12_000}).toMatch(/A.*B|B.*A/);
    await expect.poll(()=>editorValue(pages[0]),{timeout:12_000}).toBe(store.code());
    await expect.poll(()=>editorValue(pages[1]),{timeout:12_000}).toBe(store.code());

    const cursorOffset=5;
    await pages[0].locator('#editor').evaluate((node,offset)=>(node as HTMLTextAreaElement).setSelectionRange(offset,offset),cursorOffset);
    await insertAt(pages[1],0,'remote-');
    await expect.poll(()=>editorValue(pages[0]),{timeout:12_000}).toBe(store.code());
    await expect.poll(()=>pages[0].locator('#editor').evaluate(node=>(node as HTMLTextAreaElement).selectionStart))
      .toBe(cursorOffset+'remote-'.length);
    await insertAt(pages[0],(await editorValue(pages[0])).length,' undo-me');
    await expect.poll(()=>store.code(),{timeout:12_000}).toContain('undo-me');
    await pages[0].locator('#editor').press('Control+z');
    await expect.poll(()=>store.code(),{timeout:12_000}).not.toContain('undo-me');
    expect(store.code()).toContain('remote-');

    await contexts[0].setOffline(true);
    await pages[0].evaluate(()=>{
      const original=Storage.prototype.setItem;
      Storage.prototype.setItem=function(key,value){
        if(key==='randori-crdt-pending-v1') throw new DOMException('quota exceeded','QuotaExceededError');
        return original.call(this,key,value);
      };
    });
    const offlineEdits=` offline-${Array.from({length:140},(_,index)=>String.fromCharCode(97+(index%26))).join('')}`;
    await pages[0].locator('#editor').evaluate((node,suffix)=>{
      const editor=node as HTMLTextAreaElement;
      for(const character of suffix){ editor.value+=character; editor.dispatchEvent(new Event('input',{bubbles:true})); }
    },offlineEdits);
    await expect(pages[0].locator('#codeSyncStatus')).toContainText(/keep this tab open/i);
    await expect(pages[0].locator('#runBtn')).toBeDisabled();
    expect(store.code()).not.toContain(offlineEdits);
    await contexts[0].setOffline(false);
    await expect.poll(()=>store.code(),{timeout:12_000}).toContain(offlineEdits);
    await expect.poll(()=>editorValue(pages[1]),{timeout:12_000}).toBe(store.code());

    store.restart();
    await pages[1].reload({waitUntil:'domcontentloaded'});
    await expect(pages[1].locator('#monacoFallbackNote')).toBeVisible({timeout:12_000});
    await expect(pages[1].locator('#codeSyncStatus')).toHaveText('synced',{timeout:12_000});
    await expect.poll(()=>editorValue(pages[1])).toBe(store.code());
  }finally{ await Promise.all(contexts.map(context=>context.close())); }
});

test('language transitions fence the old document and persist the selected document identity',async({page})=>{
  const store=new CodeStore();
  let revision=1;
  let snapshot={schema_version:3,revision,client_id:'workspace-server',client_seq:1,code:starter,
    language:'javascript',question_id:originalQuestionFixture.slug,
    question_version:originalQuestionFixture.version,board:{shapes:[]}};
  const workspaceState=async(request:Request)=>{
    const url=new URL(request.url());
    if(request.method()==='GET'&&url.searchParams.get('channel')==='workspace'){
      const after=Number(url.searchParams.get('after_revision')||0);
      return {ok:true,room_id:room,revision,snapshot:revision>after?snapshot:null};
    }
    if(request.method()==='POST'){
      const body=request.postDataJSON() as {payload?:typeof snapshot&{base_revision?:number}};
      revision+=1; snapshot={...body.payload!,revision};
      return {ok:true,room_id:room,revision,snapshot};
    }
    return {ok:true,signals:[],after:0,count:0};
  };
  await open(page,users[0],store,workspaceState);
  const javascript='function rollUpFocusBlocks(){ return "javascript-only"; }';
  await setCode(page,javascript);
  await expect.poll(()=>store.code('javascript'),{timeout:12_000}).toBe(javascript);

  await page.locator('#langSelect').selectOption('python');
  await expect(page.locator('#codeSyncStatus')).toHaveText('synced',{timeout:12_000});
  expect(store.code('javascript')).toBe(javascript);
  await expect(page.locator('#editor')).toHaveValue(store.code('python'));
  const python='def roll_up_focus_blocks():\n    return "python-only"';
  await setCode(page,python);
  await expect.poll(()=>store.code('python'),{timeout:12_000}).toBe(python);
  await expect.poll(()=>snapshot.language,{timeout:12_000}).toBe('python');

  await page.reload({waitUntil:'domcontentloaded'});
  await expect(page.locator('#codeSyncStatus')).toHaveText('synced',{timeout:12_000});
  await expect(page.locator('#langSelect')).toHaveValue('python');
  await expect(page.locator('#editor')).toHaveValue(python);
  expect(store.code('javascript')).toBe(javascript);
});

test('Run waits for acknowledgement and a stale document race reconciles without executing',async({browser})=>{
  const store=new CodeStore();
  const contexts=await Promise.all([browser.newContext(),browser.newContext()]);
  const pages=await Promise.all(contexts.map(context=>context.newPage()));
  try{
    await Promise.all([open(pages[0],users[0],store),open(pages[1],users[1],store)]);
    await contexts[0].setOffline(true);
    await insertAt(pages[0],starter.length,' queued');
    await expect(pages[0].locator('#runBtn')).toBeDisabled();
    await contexts[0].setOffline(false);
    await expect(pages[0].locator('#runBtn')).toBeEnabled({timeout:12_000});

    // Capture A's acknowledged version, advance the server through B, then
    // force A's next execute request to carry the stale token.
    const staleVersion=await pages[0].evaluate(()=>window._randori_crdt?.documentVersion);
    expect(staleVersion).toMatch(/^[a-f0-9]{64}$/);
    // B must have converged on A's acknowledged edit before typing at the end:
    // typing at a stale offset while ' queued' arrives interleaves the two
    // concurrent inserts (valid CRDT merge, but ' peer' is then not contiguous).
    await expect.poll(()=>store.code(),{timeout:12_000}).toContain(' queued');
    await expect.poll(()=>editorValue(pages[1]),{timeout:12_000}).toBe(store.code());
    await insertAt(pages[1],(await editorValue(pages[1])).length,' peer');
    await expect.poll(()=>store.code(),{timeout:12_000}).toContain('peer');
    // Wait for A to settle on the post-peer document before forcing the
    // stale token: A's next poll converges its editor and its version, so
    // the captured token is provably stale, and Run is enabled because the
    // document is synced — not because a poll was suppressed.
    await expect.poll(()=>editorValue(pages[0]),{timeout:12_000}).toBe(store.code());
    await expect(pages[0].locator('#codeSyncStatus')).toHaveText('synced',{timeout:12_000});
    const currentVersion=await pages[0].evaluate(()=>window._randori_crdt?.documentVersion);
    expect(currentVersion).toMatch(/^[a-f0-9]{64}$/);
    expect(currentVersion).not.toBe(staleVersion);
    // Force the stale token by stubbing flush/documentVersion only. Do NOT
    // abort the /api/code-document route: that also aborts A's background
    // poll GETs, and a failed poll flips the sync status to retry, which
    // disables #runBtn (isAcknowledged requires status 'synced') — so a
    // poll tick landing between the abort and the click made the click
    // time out. Background sync must keep succeeding, as in production.
    await pages[0].evaluate(version=>{
      const crdt=window._randori_crdt;
      if(!crdt) throw new Error('CRDT API unavailable');
      Object.defineProperty(crdt,'documentVersion',{configurable:true,get:()=>version});
      crdt.flush=async()=>version;
    },staleVersion);
    await pages[0].locator('#runBtn').click();
    await expect(pages[0].locator('#runOut')).toContainText(/Execution failed|code document changed/i);
    expect(store.runCount).toBe(0);
  }finally{ await Promise.all(contexts.map(context=>context.close())); }
});

test('failed workspace acknowledgement preserves local code and blocks document bootstrap',async({page})=>{
  const store=new CodeStore();
  const unavailableWorkspace=async(request:Request)=>{
    if(request.method()==='GET') return {ok:true,room_id:room,revision:0,snapshot:null};
    return {_status:400,ok:false,error:'workspace unavailable'};
  };
  await open(page,users[0],store,unavailableWorkspace,{waitForSync:false});
  await expect(page.locator('#codeSyncStatus')).toContainText('workspace acknowledgement',{timeout:12_000});
  await expect(page.locator('#editor')).toHaveValue(starter);
  await expect(page.locator('#runBtn')).toBeDisabled();
  expect(store.getCount).toBe(0);
});

test('terminal write rejection disposes the binding and keeps the editor closed',async({page})=>{
  const store=new CodeStore();
  await open(page,users[0],store);
  store.completed=true;
  await insertAt(page,starter.length,' rejected-after-completion');
  await expect(page.locator('#codeSyncStatus')).toContainText('session completed',{timeout:12_000});
  await expect(page.locator('#editor')).toHaveAttribute('readonly','');
  await expect(page.locator('#runBtn')).toBeDisabled();
  const queued=await page.evaluate(()=>localStorage.getItem('randori-crdt-pending-v1'));
  expect(queued===null||queued==='{}').toBe(true);
  const frozen=await editorValue(page);
  await page.locator('#editor').press('End');
  await page.keyboard.type(' cannot-edit');
  await expect(page.locator('#editor')).toHaveValue(frozen);
});

test('private realtime shows partner edits before HTTPS acknowledgement, then falls back and stops on completion',async({browser})=>{
  const store=new CodeStore(); store.relayEnabled=true;
  const contexts=await Promise.all([browser.newContext(),browser.newContext()]);
  const pages=await Promise.all(contexts.map(context=>context.newPage()));
  const peers=new Map<WebSocketRoute,string>();
  let joins=0,broadcasts=0;
  let releaseWrites=()=>{};
  try{
    for(const page of pages){
      // routeWebSocket never calls connectToServer: no Supabase/network access.
      await page.routeWebSocket('wss://relay-test.supabase.co/realtime/v1/websocket**',socket=>{
        socket.onClose(()=>peers.delete(socket));
        socket.onMessage(raw=>{
          const frame=JSON.parse(typeof raw==='string'?raw:raw.toString());
          if(frame.event==='phx_join'){
            expect(frame.payload.config.private).toBe(true);
            expect(frame.payload.config.presence.enabled).toBe(false);
            expect(frame.payload.config.postgres_changes).toEqual([]);
            peers.set(socket,frame.topic); joins+=1;
            socket.send(JSON.stringify({topic:frame.topic,event:'phx_reply',ref:frame.ref,join_ref:frame.join_ref,
              payload:{status:'ok',response:{}}}));
          }else if(frame.event==='heartbeat') socket.send(JSON.stringify({topic:'phoenix',event:'phx_reply',ref:frame.ref,payload:{status:'ok'}}));
          else if(frame.event==='broadcast'){
            broadcasts+=1;
            expect(Object.keys(frame.payload.payload).sort()).toEqual(['sender','seq','update']);
            for(const [peer,topic] of peers) if(peer!==socket&&topic===frame.topic) peer.send(JSON.stringify({
              topic,event:'broadcast',payload:frame.payload,ref:null,join_ref:'1',
            }));
          }
        });
      });
    }
    await Promise.all([open(pages[0],users[0],store),open(pages[1],users[1],store)]);
    await expect.poll(()=>joins).toBe(2);
    await expect.poll(()=>pages[0].evaluate(()=>window._randori_crdt?.relayConnected)).toBe(true);
    const before=store.code();
    store.holdWrites=new Promise(resolve=>{ releaseWrites=resolve; });
    await pages[0].locator('#editor').evaluate(node=>{
      const editor=node as HTMLTextAreaElement; editor.value=`// relay-before-ack\n${editor.value}`;
      editor.dispatchEvent(new Event('input',{bubbles:true}));
    });
    await expect(pages[1].locator('#editor')).toHaveValue(`// relay-before-ack\n${before}`,{timeout:1000});
    expect(store.code()).toBe(before);
    await expect(pages[0].locator('#runBtn')).toBeDisabled();
    await expect(pages[1].locator('#runBtn')).toBeDisabled();
    expect(await pages[1].evaluate(()=>window._randori_crdt?.documentVersion)).toBeNull();
    expect(broadcasts).toBe(1,'received updates persist over HTTPS without echo');
    releaseWrites(); store.holdWrites=null;
    await expect.poll(()=>store.code(),{timeout:12000}).toContain('relay-before-ack');
    await expect(pages[0].locator('#runBtn')).toBeEnabled();
    await expect(pages[1].locator('#runBtn')).toBeEnabled();
    expect(store.runCount).toBe(0);

    store.relayEnabled=false;
    for(const socket of peers.keys()) socket.close();
    await expect.poll(()=>pages[0].evaluate(()=>window._randori_crdt?.relayConnected)).toBe(false);
    await insertAt(pages[0],(await editorValue(pages[0])).length,' polling-fallback');
    await expect.poll(()=>store.code(),{timeout:12000}).toContain('polling-fallback');
    await expect.poll(()=>editorValue(pages[1]),{timeout:12000}).toBe(store.code());
    expect(broadcasts).toBe(1);

    for(const page of pages) await page.evaluate(activeRoom=>window.dispatchEvent(new CustomEvent('randori:completion-observed',{
      detail:{room:activeRoom,state:'completed'},
    })),room);
    for(const page of pages){
      await expect(page.locator('#editor')).toHaveAttribute('readonly','');
      await expect(page.locator('#runBtn')).toBeDisabled();
    }
  }finally{
    releaseWrites(); store.holdWrites=null;
    await Promise.all(contexts.map(context=>context.close()));
  }
});

test('pair presence: join, live remote cursor, leave on hidden tab and TTL expiry after a silent crash',async({browser})=>{
  test.setTimeout(120_000);
  const store=new CodeStore(); store.relayEnabled=true; store.presenceEnabled=true;
  const contexts=await Promise.all([browser.newContext(),browser.newContext()]);
  const pages=await Promise.all(contexts.map(context=>context.newPage()));
  const peers=new Map<WebSocketRoute,string>(),muted=new Set<WebSocketRoute>(),owners=new Map<WebSocketRoute,number>();
  try{
    for(const [index,page] of pages.entries()){
      await page.routeWebSocket('wss://relay-test.supabase.co/realtime/v1/websocket**',socket=>{
        owners.set(socket,index);
        socket.onClose(()=>peers.delete(socket));
        socket.onMessage(raw=>{
          const frame=JSON.parse(typeof raw==='string'?raw:raw.toString());
          if(frame.event==='phx_join'){
            expect(frame.payload.config.presence.enabled).toBe(false,'Supabase Presence stays off');
            peers.set(socket,frame.topic);
            socket.send(JSON.stringify({topic:frame.topic,event:'phx_reply',ref:frame.ref,join_ref:frame.join_ref,payload:{status:'ok',response:{}}}));
          }else if(frame.event==='heartbeat') socket.send(JSON.stringify({topic:'phoenix',event:'phx_reply',ref:frame.ref,payload:{status:'ok'}}));
          else if(frame.event==='broadcast'){
            if(frame.payload.event==='y-awareness'){
              expect(Object.keys(frame.payload.payload).sort()).toEqual(['awareness','sender']);
              expect(Buffer.from(frame.payload.payload.awareness,'base64').toString()).not.toMatch(/One|Two|example\.test/);
            }
            if(muted.has(socket)) return;
            for(const [peer,topic] of peers) if(peer!==socket&&topic===frame.topic) peer.send(JSON.stringify({
              topic,event:'broadcast',payload:frame.payload,ref:null,join_ref:'1'}));
          }
        });
      });
    }
    await Promise.all([open(pages[0],users[0],store),open(pages[1],users[1],store)]);
    // Join: both see each other live within a few seconds; one polite announcement.
    await expect(pages[0].locator('#presenceText')).toHaveText(/^Two is here · (line \d+ · )?live$/,{timeout:8000});
    await expect(pages[1].locator('#presenceText')).toHaveText(/^One is here · (line \d+ · )?live$/,{timeout:8000});
    await expect(pages[0].locator('#presenceAnnouncer')).toHaveText('Two joined the room');
    await expect(pages[0].locator('#presenceAnnouncer')).toHaveAttribute('aria-live','polite');
    await expect(pages[0].locator('.room-presence')).toHaveAttribute('data-health','live');

    // Remote cursor + selection render on the partner without moving its caret.
    await pages[1].locator('#editor').evaluate(node=>(node as HTMLTextAreaElement).setSelectionRange(2,2));
    const focusedBefore=await pages[1].evaluate(()=>document.activeElement?.id||'');
    const scrollBefore=await pages[1].locator('#editor').evaluate(node=>node.scrollTop);
    const selectionStart=starter.indexOf('return');
    await pages[0].locator('#editor').focus();
    await pages[0].locator('#editor').evaluate((node,start)=>{
      const editor=node as HTMLTextAreaElement; editor.setSelectionRange(start,start+6);
      editor.dispatchEvent(new Event('select'));
    },selectionStart);
    const cursor=pages[1].getByTestId('remote-cursor');
    await expect(cursor).toBeAttached({timeout:3000});
    await expect(cursor).toHaveAttribute('data-offset',String(selectionStart+6));
    await expect(pages[1].getByTestId('remote-selection')).toHaveText('return');
    await expect(pages[1].locator('#presenceText')).toContainText(/One is here · line \d+ · live/);
    expect(await pages[1].locator('#editor').evaluate(node=>[(node as HTMLTextAreaElement).selectionStart,(node as HTMLTextAreaElement).selectionEnd])).toEqual([2,2]);
    expect(await pages[1].evaluate(()=>document.activeElement?.id||'')).toBe(focusedBefore);
    expect(await pages[1].locator('#editor').evaluate(node=>node.scrollTop)).toBe(scrollBefore);
    // Local editing on the partner is undisturbed and still converges.
    await insertAt(pages[1],0,'// partner\n');
    await expect.poll(()=>store.code(),{timeout:12_000}).toContain('// partner');
    await expect(cursor).toHaveAttribute('data-offset',String(selectionStart+6+'// partner\n'.length));
    expect(store.presenceCalls.every(call=>Object.keys(call.body).sort().join()==='room_id,state')).toBe(true);

    // Leave: a hidden tab stops presence, says goodbye and deletes its row.
    await pages[0].evaluate(()=>{
      Object.defineProperty(document,'visibilityState',{configurable:true,get:()=>'hidden'});
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await expect(pages[1].locator('#presenceText')).toHaveText('One not in the room · live',{timeout:3000});
    await expect(pages[1].locator('#presenceAnnouncer')).toHaveText('One left the room');
    await expect(pages[1].getByTestId('remote-cursor')).toHaveCount(0);
    expect(store.presenceRows.has(1)).toBe(false);
    // Return: visible again rejoins.
    await pages[0].evaluate(()=>{
      Object.defineProperty(document,'visibilityState',{configurable:true,get:()=>'visible'});
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await expect(pages[1].locator('#presenceText')).toHaveText(/^One is here/,{timeout:8000});
    await expect(pages[1].locator('#presenceAnnouncer')).toHaveText('One joined the room');

    // Silent crash: One's frames and heartbeats stop with no goodbye. Both
    // the awareness TTL and the server row expire with no cleanup step.
    for(const [socket,index] of owners) if(index===0) muted.add(socket);
    store.presenceDown.add(1); store.presenceRows.set(1,Date.now()-1);
    await expect(pages[1].locator('#presenceText')).toHaveText('One not in the room · live',{timeout:25_000});
    await expect(pages[1].getByTestId('remote-cursor')).toHaveCount(0);
  }finally{ await Promise.all(contexts.map(context=>context.close())); }
});

test('pair presence falls back to HTTPS "online" without the relay and shows no cursors',async({browser})=>{
  const store=new CodeStore(); store.presenceEnabled=true;
  const contexts=await Promise.all([browser.newContext(),browser.newContext()]);
  const pages=await Promise.all(contexts.map(context=>context.newPage()));
  try{
    await Promise.all([open(pages[0],users[0],store),open(pages[1],users[1],store)]);
    await expect(pages[0].locator('#presenceText')).toHaveText('Two online · polling',{timeout:12_000});
    await expect(pages[1].locator('#presenceText')).toHaveText('One online · polling',{timeout:12_000});
    await pages[0].locator('#editor').evaluate(node=>{
      const editor=node as HTMLTextAreaElement; editor.setSelectionRange(3,8); editor.dispatchEvent(new Event('select'));
    });
    await pages[1].waitForTimeout(1500);
    await expect(pages[1].getByTestId('remote-cursor')).toHaveCount(0);
    // Sign-out is one of the presence fences; its leave deletes the row.
    await pages[1].evaluate(()=>window._randori_crdt?.deactivate());
    await expect.poll(()=>store.presenceCalls.some(call=>call.user===2&&call.body.state==='leave')).toBe(true);
    await expect(pages[0].locator('#presenceText')).toHaveText('Two not in the room · polling',{timeout:12_000});
    await expect(pages[0].locator('#presenceAnnouncer')).toHaveText('Two left the room');
  }finally{ await Promise.all(contexts.map(context=>context.close())); }
});
