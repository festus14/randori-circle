import { Browser, Page, Request, Route, expect, test } from '@playwright/test';
import { mockApi, originalQuestionFixture, resetClientState } from './helpers';

const roomId='week_42_pair_7';
const scheduleVersion='a'.repeat(64);
const completionVersion='c'.repeat(64);
const acceptedAt='2099-10-20T18:00:00.000Z';
const user={
  id:1,email:'candidate@example.test',name:'Candidate',display_name:'Candidate',
  color:'#c8f6a0',is_available:true,tz:'Europe/London',interview_focus:'both',
};

function pairResponse(){
  return {
    ok:true,paired:true,room_id:roomId,week_id:42,
    week:{id:42,week_label:'2099-W42'},
    pair:{pg_id:7,week_id:42,user_a_id:1,user_b_id:2,user_c_id:null,is_ai_pair:false,is_ai:false,topic:'Pick together'},
    partner:{id:2,name:'Partner',display_name:'Partner',color:'#9cc0b5',tz:'UTC'},
    partners:[{id:2,name:'Partner',display_name:'Partner',color:'#9cc0b5',tz:'UTC'}],
    schedule:{version:scheduleVersion,proposals:[],agreed_time:acceptedAt,legacy_agreed_time:null,updated_at:'2099-10-19T10:00:00.000Z'},
  };
}

class MeetingStore{
  revision=0;
  url:string|null=null;
  scheduleVersion=scheduleVersion;
  completionVersion=completionVersion;
  acceptedAt=acceptedAt;
  lifecycle:'active'|'completed'='active';
  requests:Array<{method:string;body:Record<string,unknown>|null}>=[];
  delayed:null|{started:()=>void;gate:Promise<void>}=null;

  delayNext(){
    let release=()=>{}; let startedResolve=()=>{};
    const started=new Promise<void>(resolve=>{ startedResolve=resolve; });
    const gate=new Promise<void>(resolve=>{ release=resolve; });
    this.delayed={started:startedResolve,gate};
    return {started,release};
  }

  payload(){
    return {ok:true,room_id:roomId,meeting_link:{
      lifecycle:this.lifecycle,accepted_schedule_at:this.acceptedAt,schedule_version:this.scheduleVersion,
      completion_version:this.completionVersion,
      version:this.lifecycle==='active'?String(this.revision).padStart(64,'0'):null,
      url:this.lifecycle==='active'?this.url:null,
      hostname:this.lifecycle==='active'&&this.url?new URL(this.url).hostname:null,
      updated_at:this.lifecycle==='active'&&this.revision?`2099-10-19T10:00:0${Math.min(this.revision,9)}.000Z`:null,
    }};
  }

  route=async(route:Route)=>{
    const request=route.request();
    const body=request.method()==='POST'?(request.postDataJSON() as Record<string,unknown>):null;
    this.requests.push({method:request.method(),body});
    if(this.delayed){ const delayed=this.delayed; this.delayed=null; delayed.started(); await delayed.gate; }
    if(body){
      if(body.base_version!==String(this.revision).padStart(64,'0')){
        await route.fulfill({status:409,contentType:'application/json',body:JSON.stringify({
          ...this.payload(),error:'The meeting link changed.',code:'meeting_link_changed',
        })}); return;
      }
      this.revision+=1;
      this.url=body.action==='set'?String(body.url):null;
    }
    await route.fulfill({status:200,contentType:'application/json',body:JSON.stringify(this.payload())});
  };
}

async function configure(page:Page,store:MeetingStore){
  await page.route(/^https:\/\/(?!127\.0\.0\.1)/,route=>route.abort());
  let workspaceRevision=0;
  await mockApi(page,{
    '/api/auth/me':{ok:true,user},'/api/profile':{ok:true,user},
    '/api/questions':{ok:true,questions:[originalQuestionFixture],count:1},
    '/api/my-pair':pairResponse(),
    '/api/session-completion':{ok:true,room_id:roomId,completion:{
      state:'not_recorded',viewer_confirmed:false,confirmed_count:0,required_count:2,
      version:completionVersion,completed_at:null,
    }},
    '/api/schedule':(request:Request)=>request.method()==='GET'
      ?{ok:true,room_id:roomId,schedule:pairResponse().schedule}
      :{_status:400,error:'not used'},
    '/api/messages':{ok:true,room_id:roomId,messages:[],next_after_id:0,has_more:false},
    '/api/video/signal':(request:Request)=>{
      const url=new URL(request.url());
      if(request.method()==='GET'&&url.searchParams.get('channel')==='workspace'){
        return {ok:true,room_id:roomId,revision:workspaceRevision,snapshot:null};
      }
      const body=request.postDataJSON() as {payload?:Record<string,unknown>};
      workspaceRevision+=1;
      return {ok:true,room_id:roomId,revision:workspaceRevision,snapshot:{...body.payload,revision:workspaceRevision}};
    },
  });
  await page.route(/\/api\/meeting-link(?:\?.*)?$/,store.route);
  await resetClientState(page,true);
}

async function openWorkspace(page:Page,store:MeetingStore){
  await configure(page,store);
  await page.goto(`/join/${roomId}`,{waitUntil:'domcontentloaded'});
  await expect(page.locator('#view-code')).toBeVisible();
  await expect.poll(()=>page.evaluate(()=>(window as typeof window & {_randori_workspace?:{hydrated?:boolean}})._randori_workspace?.hydrated)).toBe(true);
  await expect.poll(()=>page.evaluate(()=>({
    room:window._randori_meeting_link?.room??null,
    lifecycle:window._randori_meeting_link?.meeting?.lifecycle??null,
    authorized:(window as typeof window & {_randori_authorized_room?:string})._randori_authorized_room??null,
  }))).toEqual({room:roomId,lifecycle:'active',authorized:roomId});
  await expect(page.getByTestId('meeting-link-workspace')).toBeVisible();
}

test('two browsers add, join, change, and remove the same private meeting link',async({browser})=>{
  const store=new MeetingStore();
  const first=await browser.newPage(); const second=await browser.newPage();
  try{
    await Promise.all([openWorkspace(first,store),openWorkspace(second,store)]);
    const firstCard=first.getByTestId('meeting-link-workspace');
    await firstCard.getByTestId('meeting-link-add').click();
    await firstCard.getByTestId('meeting-link-input').fill('https://meet.example.test/private-room?token=opaque');
    await firstCard.getByTestId('meeting-link-save').click();
    await expect(firstCard.getByTestId('meeting-link-hostname')).toHaveText('meet.example.test');
    const join=firstCard.getByTestId('meeting-link-join');
    await expect(join).toHaveAttribute('target','_blank');
    await expect(join).toHaveAttribute('rel',/noopener/);
    await expect(join).toHaveAttribute('rel',/noreferrer/);
    await expect(firstCard).toContainText('opens an external website');

    await second.evaluate(()=>window._randori_meeting_link?.load());
    const secondCard=second.getByTestId('meeting-link-workspace');
    await expect(secondCard.getByTestId('meeting-link-hostname')).toHaveText('meet.example.test');
    await secondCard.getByTestId('meeting-link-change').click();
    await secondCard.getByTestId('meeting-link-input').fill('https://calls.example.test/new-room');
    await secondCard.getByTestId('meeting-link-save').click();
    await first.evaluate(()=>window._randori_meeting_link?.load());
    await expect(firstCard.getByTestId('meeting-link-hostname')).toHaveText('calls.example.test');
    await firstCard.getByTestId('meeting-link-remove').click();
    await expect(firstCard.getByTestId('meeting-link-add')).toBeVisible();
    expect(store.requests.filter(request=>request.method==='POST').map(request=>request.body?.action)).toEqual(['set','set','clear']);
    expect(JSON.stringify(store.requests)).not.toContain('user_id');
  }finally{ await first.close(); await second.close(); }
});

test('accepted dashboard time exposes the meeting controls and malformed URLs never leave the browser',async({page})=>{
  const store=new MeetingStore(); await configure(page,store);
  await page.goto('/',{waitUntil:'domcontentloaded'});
  await expect(page.locator('#view-dashboard')).toBeVisible();
  const dashboard=page.getByTestId('meeting-link-dashboard');
  await expect(dashboard.getByTestId('meeting-link-add')).toBeVisible();
  await dashboard.getByTestId('meeting-link-add').click();
  const input=dashboard.getByTestId('meeting-link-input');
  await input.fill('https://user:password@meet.example.test/private');
  await dashboard.getByTestId('meeting-link-save').click();
  await expect(input).toHaveAttribute('aria-invalid','true');
  await expect(dashboard.getByTestId('meeting-link-status')).toContainText('without embedded credentials');
  expect(store.requests.filter(request=>request.method==='POST')).toHaveLength(0);
});

test('delayed meeting data cannot cross schedule, completion, room, or account fences',async({page})=>{
  const store=new MeetingStore(); await openWorkspace(page,store);
  const delayed=store.delayNext();
  await page.evaluate(()=>{ void window._randori_meeting_link?.load(); });
  await delayed.started;
  await page.evaluate(({room,schedule})=>{
    window.dispatchEvent(new CustomEvent('randori:schedule-observed',{detail:{
      room,kind:'primary',scheduleVersion:'d'.repeat(64),agreedTime:'2099-10-21T18:00:00.000Z',
      cycleToken:'changed',circlePublicId:null,contextVersion:null,
    }}));
    window.dispatchEvent(new CustomEvent('randori:completion-observed',{detail:{
      room,completionVersion:'e'.repeat(64),state:'completed',
    }}));
    window.dispatchEvent(new CustomEvent('randori:auth-refreshed',{detail:{signedIn:false,userId:null}}));
  },{room:roomId,schedule:scheduleVersion});
  await expect(page.getByTestId('meeting-link-workspace')).toBeHidden();
  delayed.release();
  await page.waitForTimeout(50);
  await expect(page.getByTestId('meeting-link-workspace')).toBeHidden();
  expect(await page.evaluate(()=>({
    room:window._randori_meeting_link?.room??null,
    meeting:window._randori_meeting_link?.meeting??null,
  }))).toEqual({room:null,meeting:null});
});

test('remote reschedule and completion responses fail closed before a fresh authoritative render',async({page})=>{
  const store=new MeetingStore(); await openWorkspace(page,store);
  const card=page.getByTestId('meeting-link-workspace');
  await card.getByTestId('meeting-link-add').click();
  await card.getByTestId('meeting-link-input').fill('https://old.example.test/private');
  await card.getByTestId('meeting-link-save').click();
  await expect(card.getByTestId('meeting-link-hostname')).toHaveText('old.example.test');

  store.scheduleVersion='d'.repeat(64); store.acceptedAt='2099-10-21T18:00:00.000Z';
  store.url=null; store.revision+=1;
  await page.evaluate(()=>{ void window._randori_meeting_link?.load(); });
  await expect(card.getByTestId('meeting-link-add')).toBeVisible();
  await expect(card).not.toContainText('old.example.test');

  await card.getByTestId('meeting-link-add').click();
  await card.getByTestId('meeting-link-input').fill('https://next.example.test/private');
  await card.getByTestId('meeting-link-save').click();
  await expect(card.getByTestId('meeting-link-hostname')).toHaveText('next.example.test');
  store.completionVersion='e'.repeat(64); store.lifecycle='completed';
  await page.evaluate(()=>{ void window._randori_meeting_link?.load(); });
  await expect(card).toBeHidden();
  expect(await page.evaluate(()=>window._randori_meeting_link?.meeting??null)).toBeNull();
});
