import { createHash } from 'node:crypto';
import { expect, Page, Request, test } from '@playwright/test';
import * as Y from 'yjs';

import { mockApi, originalQuestionFixture } from './helpers';

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

class CodeStore{
  doc=new Y.Doc();
  revision=1;
  postCount=0;
  runCount=0;
  private persisted='';
  constructor(){ this.doc.getText('code').insert(0,starter); this.persist(); }
  persist(){ this.persisted=base64(Y.encodeStateAsUpdate(this.doc)); }
  restart(){ const next=new Y.Doc(); Y.applyUpdate(next,Buffer.from(this.persisted,'base64')); this.doc.destroy(); this.doc=next; }
  version(){ return digest(JSON.stringify([this.revision,digest(Buffer.from(this.persisted,'base64')),digest(this.code())])); }
  code(){ return this.doc.getText('code').toString(); }
  response(after=0){
    return {ok:true,changed:this.revision>after,created:false,revision:this.revision,
      document_version:this.version(),state:this.revision>after?this.persisted:null,
      code_hash:digest(this.code()),updated_at:'2026-09-20T10:00:00.000Z'};
  }
  handle=async(request:Request):Promise<Record<string,unknown>>=>{
    const url=new URL(request.url());
    if(request.method()==='GET') return this.response(Number(url.searchParams.get('after_revision')||0));
    this.postCount+=1;
    const body=request.postDataJSON() as {update?:string};
    if(typeof body.update!=='string') return {_status:400,ok:false,error:'invalid update'};
    const before=this.persisted;
    Y.applyUpdate(this.doc,Buffer.from(body.update,'base64'));
    this.persist();
    const idempotent=this.persisted===before;
    if(!idempotent) this.revision+=1;
    return {...this.response(0),idempotent};
  };
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

async function open(page:Page,user:User,store:CodeStore){
  await page.route(/(cdnjs\.cloudflare\.com|cdn\.jsdelivr\.net|unpkg\.com)/,route=>route.abort());
  await mockApi(page,{
    '/api/auth/me':{ok:true,user},'/api/profile':{ok:true,user},'/api/my-pair':()=>pair(user),
    '/api/video/signal':workspace,'/api/code-document':store.handle,
    '/api/execute':request=>{
      const body=request.postDataJSON() as {document_version?:string};
      if(body.document_version!==store.version()) return {_status:409,error:'code document changed',code:'code_document_changed',latest_document_version:store.version()};
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
  await expect(page.locator('#codeSyncStatus')).toHaveText('synced',{timeout:12_000});
  await expect(page.locator('#runBtn')).toBeEnabled();
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

    await contexts[0].setOffline(true);
    await insertAt(pages[0],store.code().length,' offline');
    await expect(pages[0].locator('#codeSyncStatus')).toContainText(/offline/i);
    expect(store.code()).not.toContain('offline');
    await contexts[0].setOffline(false);
    await expect.poll(()=>store.code(),{timeout:12_000}).toContain('offline');
    await expect.poll(()=>editorValue(pages[1]),{timeout:12_000}).toBe(store.code());

    store.restart();
    await pages[1].reload({waitUntil:'domcontentloaded'});
    await expect(pages[1].locator('#monacoFallbackNote')).toBeVisible({timeout:12_000});
    await expect(pages[1].locator('#codeSyncStatus')).toHaveText('synced',{timeout:12_000});
    await expect.poll(()=>editorValue(pages[1])).toBe(store.code());
  }finally{ await Promise.all(contexts.map(context=>context.close())); }
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
