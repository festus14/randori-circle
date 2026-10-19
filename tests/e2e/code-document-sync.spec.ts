import { createHash } from 'node:crypto';
import { expect, Page, Request, test } from '@playwright/test';
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
    return {ok:true,changed:current.revision!==after,created:false,revision:current.revision,
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
    if(this.completed) return {_status:409,ok:false,error:'session is completed',code:'session_completed'};
    if(typeof body.update!=='string') return {_status:400,ok:false,error:'invalid update'};
    const before=current.persisted;
    Y.applyUpdate(current.doc,Buffer.from(body.update,'base64'));
    current.persisted=base64(Y.encodeStateAsUpdate(current.doc));
    const idempotent=current.persisted===before;
    if(!idempotent) current.revision+=1;
    return {...this.response(0,language),idempotent};
  };
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
    // B must have converged on A's acknowledged edit before typing at the end:
    // typing at a stale offset while ' queued' arrives interleaves the two
    // concurrent inserts (valid CRDT merge, but ' peer' is then not contiguous).
    await expect.poll(()=>store.code(),{timeout:12_000}).toContain(' queued');
    await expect.poll(()=>editorValue(pages[1]),{timeout:12_000}).toBe(store.code());
    await insertAt(pages[1],(await editorValue(pages[1])).length,' peer');
    await expect.poll(()=>store.code(),{timeout:12_000}).toContain('peer');
    await pages[0].route('**/api/code-document?**',route=>route.abort());
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
