import { Page, Request, Route, expect, test } from '@playwright/test';
import { mockApi, originalQuestionFixture, resetClientState } from './helpers';

const roomId='week_42_pair_7';
const completionVersion='c'.repeat(64);
const users={
  1:{id:1,email:'one@example.test',name:'One',display_name:'One',color:'#c8f6a0',is_available:true,tz:'Europe/London',interview_focus:'both'},
  2:{id:2,email:'two@example.test',name:'Two',display_name:'Two',color:'#9cc0b5',is_available:true,tz:'UTC',interview_focus:'both'},
};

function pairResponse(actorId:1|2){
  const partnerId=actorId===1?2:1;
  return {
    ok:true,paired:true,room_id:roomId,week_id:42,
    week:{id:42,week_label:'2099-W42'},
    pair:{pg_id:7,week_id:42,user_a_id:1,user_b_id:2,user_c_id:null,is_ai_pair:false,is_ai:false,topic:'Pick together'},
    partner:users[partnerId],partners:[users[partnerId]],
  };
}

class ControlsStore{
  revision=0;
  candidateId=1;
  timerState:'paused'|'running'='paused';
  remainingMs=25*60*1000;
  anchorMs:number|null=null;
  terminal=false;
  completionVersion=completionVersion;
  requests:Array<{actorId:number;method:string;body:Record<string,unknown>|null;status:number}>=[];
  private delayed:null|{started:()=>void;gate:Promise<void>}=null;

  delayNext(){
    let release=()=>{}; let startedResolve=()=>{};
    const started=new Promise<void>(resolve=>{ startedResolve=resolve; });
    const gate=new Promise<void>(resolve=>{ release=resolve; });
    this.delayed={started:startedResolve,gate};
    return {started,release};
  }

  effectiveRemaining(){
    if(this.timerState!=='running'||this.anchorMs===null||this.terminal) return this.remainingMs;
    return Math.max(0,this.remainingMs-(Date.now()-this.anchorMs));
  }

  version(){ return this.revision.toString(16).padStart(64,'0'); }

  payload(actorId:number){
    const remaining=this.effectiveRemaining();
    const partnerId=actorId===1?2:1;
    const viewerRole=this.candidateId===actorId?'candidate':'interviewer';
    return {ok:true,room_id:roomId,session_controls:{
      timer_state:remaining===0?'expired':this.timerState,
      remaining_ms:Math.floor(remaining),duration_ms:25*60*1000,
      candidate_user_id:this.candidateId,partner_user_id:partnerId,
      viewer_role:viewerRole,partner_role:viewerRole==='candidate'?'interviewer':'candidate',
      terminal:this.terminal,completion_version:this.completionVersion,
      observed_at:new Date().toISOString(),updated_at:this.revision?new Date().toISOString():null,
      version:this.version(),
    }};
  }

  route=async(route:Route,actorId:number)=>{
    const request=route.request();
    const body=request.method()==='POST'?(request.postDataJSON() as Record<string,unknown>):null;
    if(this.delayed){ const delayed=this.delayed; this.delayed=null; delayed.started(); await delayed.gate; }
    if(!body){
      this.requests.push({actorId,method:'GET',body:null,status:200});
      await route.fulfill({status:200,contentType:'application/json',body:JSON.stringify(this.payload(actorId))});
      return;
    }
    if(this.terminal){
      this.requests.push({actorId,method:'POST',body,status:409});
      await route.fulfill({status:409,contentType:'application/json',body:JSON.stringify({
        ...this.payload(actorId),error:'Session controls are read-only.',code:'session_controls_completed',
      })}); return;
    }
    const action=String(body.action||'');
    const desiredAlready=(action==='start'&&this.timerState==='running'&&this.effectiveRemaining()>0)
      ||(action==='pause'&&(this.timerState==='paused'||this.effectiveRemaining()===0))
      ||(action==='reset'&&this.timerState==='paused'&&this.remainingMs===25*60*1000)
      ||(action==='set_candidate'&&Number(body.candidate_user_id)===this.candidateId);
    if(!desiredAlready&&body.base_version!==this.version()){
      this.requests.push({actorId,method:'POST',body,status:409});
      await route.fulfill({status:409,contentType:'application/json',body:JSON.stringify({
        ...this.payload(actorId),error:'Session controls changed.',code:'session_controls_changed',
      })}); return;
    }
    if(!desiredAlready){
      if(action==='start'){
        this.remainingMs=this.effectiveRemaining(); this.timerState='running'; this.anchorMs=Date.now();
      }else if(action==='pause'){
        this.remainingMs=this.effectiveRemaining(); this.timerState='paused'; this.anchorMs=null;
      }else if(action==='reset'){
        this.timerState='paused'; this.remainingMs=25*60*1000; this.anchorMs=null;
      }else if(action==='set_candidate') this.candidateId=Number(body.candidate_user_id);
      this.revision+=1;
    }
    this.requests.push({actorId,method:'POST',body,status:200});
    await route.fulfill({status:200,contentType:'application/json',body:JSON.stringify(this.payload(actorId))});
  };
}

async function configure(page:Page,store:ControlsStore,actorId:1|2){
  const user=users[actorId];
  await page.route(/^https:\/\//,route=>route.abort());
  let workspaceRevision=0;
  await mockApi(page,{
    '/api/auth/me':{ok:true,user},'/api/profile':{ok:true,user},
    '/api/questions':{ok:true,questions:[originalQuestionFixture],count:1},
    '/api/my-pair':pairResponse(actorId),
    '/api/session-completion':{ok:true,room_id:roomId,completion:{
      state:'not_recorded',viewer_confirmed:false,confirmed_count:0,required_count:2,
      version:store.completionVersion,completed_at:null,
    }},
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
  await page.route(/\/api\/session-controls(?:\?.*)?$/,route=>store.route(route,actorId));
  await resetClientState(page,true);
}

async function openWorkspace(page:Page,store:ControlsStore,actorId:1|2){
  await configure(page,store,actorId);
  await page.goto(`/join/${roomId}`,{waitUntil:'domcontentloaded'});
  await expect(page.locator('#view-code')).toBeVisible();
  await expect.poll(()=>page.evaluate(()=>(window as typeof window & {_randori_workspace?:{hydrated?:boolean}})._randori_workspace?.hydrated)).toBe(true);
  await expect(page.getByTestId('session-controls')).toBeVisible();
  await expect(page.getByTestId('session-controls-status')).not.toContainText('Loading');
}

test('two participants converge on roles and a durable timer across restart',async({browser})=>{
  const store=new ControlsStore();
  const first=await browser.newPage(); const second=await browser.newPage();
  try{
    await Promise.all([openWorkspace(first,store,1),openWorkspace(second,store,2)]);
    await expect(first.getByTestId('session-controls-roles')).toHaveText('You are candidate. Partner is interviewer.');
    await expect(second.getByTestId('session-controls-roles')).toHaveText('You are interviewer. Partner is candidate.');

    await second.getByTestId('session-controls-candidate').selectOption('2');
    await expect(second.getByTestId('session-controls-roles')).toHaveText('You are candidate. Partner is interviewer.');
    await first.evaluate(()=>window._randori_session_controls?.load());
    await expect(first.getByTestId('session-controls-roles')).toHaveText('You are interviewer. Partner is candidate.');
    await expect(first.getByTestId('session-controls-status')).toHaveText('Participant roles updated. You are interviewer.');

    await first.getByTestId('session-controls-start-pause').focus();
    await first.keyboard.press('Enter');
    await expect(first.getByTestId('session-controls-status')).toHaveText('Shared timer started.');
    await second.evaluate(()=>window._randori_session_controls?.load());
    await expect(second.getByTestId('session-controls-start-pause')).toHaveText('Pause');
    const before=await second.getByTestId('session-controls-countdown').textContent();
    await second.waitForTimeout(1100);
    const after=await second.getByTestId('session-controls-countdown').textContent();
    expect(after).not.toBe(before);
    expect(store.requests.filter(request=>request.method==='POST').map(request=>request.body)).toEqual([
      {room_id:roomId,action:'set_candidate',base_version:'0'.repeat(64),candidate_user_id:2},
      {room_id:roomId,action:'start',base_version:'1'.padStart(64,'0')},
    ]);

    await second.reload({waitUntil:'domcontentloaded'});
    await expect(second.getByTestId('session-controls-start-pause')).toHaveText('Pause');
    await expect(second.getByTestId('session-controls-roles')).toHaveText('You are candidate. Partner is interviewer.');
    await expect(second.getByTestId('session-controls-status')).toHaveAttribute('aria-live','polite');
    await expect(second.getByTestId('session-controls-countdown')).not.toHaveAttribute('aria-live');
  }finally{ await first.close(); await second.close(); }
});

test('simultaneous actions expose the winner through safe conflict reconciliation',async({browser})=>{
  const store=new ControlsStore();
  const first=await browser.newPage(); const second=await browser.newPage();
  try{
    await Promise.all([openWorkspace(first,store,1),openWorkspace(second,store,2)]);
    await Promise.all([
      first.getByTestId('session-controls-start-pause').click(),
      second.getByTestId('session-controls-candidate').selectOption('2'),
    ]);
    const writes=store.requests.filter(request=>request.method==='POST');
    expect(writes).toHaveLength(2);
    expect(writes.filter(request=>request.status===200)).toHaveLength(1);
    expect(writes.filter(request=>request.status===409)).toHaveLength(1);
    await Promise.all([
      first.evaluate(()=>window._randori_session_controls?.load()),
      second.evaluate(()=>window._randori_session_controls?.load()),
    ]);
    const states=await Promise.all([first,second].map(page=>page.evaluate(()=>window._randori_session_controls?.controls)));
    expect(states[0]?.version).toBe(states[1]?.version);
    expect(states[0]?.candidateUserId).toBe(states[1]?.candidateUserId);
    expect(states[0]?.timerState).toBe(states[1]?.timerState);
  }finally{ await first.close(); await second.close(); }
});

test('expiry never completes a session and terminal completion freezes all controls',async({page})=>{
  const store=new ControlsStore(); store.timerState='running'; store.remainingMs=500; store.anchorMs=Date.now(); store.revision=1;
  await openWorkspace(page,store,1);
  await expect(page.getByTestId('session-controls-countdown')).toHaveText('00:00',{timeout:3000});
  await expect(page.getByTestId('session-controls-status')).toContainText('Time is up');
  await expect(page.getByTestId('session-controls-start-pause')).toHaveText('Start');
  await expect(page.getByTestId('session-controls-start-pause')).toBeDisabled();
  await expect(page.locator('#timerBtn')).toBeDisabled();
  await expect(page.locator('#timerBtn')).toHaveAttribute('aria-label','Shared focus timer expired; reset required');
  expect(store.terminal).toBe(false);
  expect(store.requests.filter(request=>request.method==='POST')).toHaveLength(0);

  store.timerState='paused'; store.remainingMs=321_000; store.anchorMs=null; store.terminal=true;
  store.completionVersion='d'.repeat(64); store.revision+=1;
  await page.evaluate(()=>window._randori_session_controls?.load());
  await expect(page.getByTestId('session-controls-status')).toContainText('read-only');
  await expect(page.getByTestId('session-controls-start-pause')).toBeDisabled();
  await expect(page.getByTestId('session-controls-reset')).toBeDisabled();
  await expect(page.getByTestId('session-controls-candidate')).toBeDisabled();
  const frozen=await page.getByTestId('session-controls-countdown').textContent();
  await page.waitForTimeout(1100);
  await expect(page.getByTestId('session-controls-countdown')).toHaveText(frozen||'');
});

test('a delayed response is fenced across room and account changes',async({page})=>{
  const store=new ControlsStore(); await openWorkspace(page,store,1);
  const delayed=store.delayNext();
  await page.evaluate(()=>{ void window._randori_session_controls?.load(); });
  await delayed.started;
  await page.evaluate(()=>{
    window.dispatchEvent(new CustomEvent('randori:auth-refreshed',{detail:{signedIn:false,userId:null}}));
    window.dispatchEvent(new CustomEvent('randori:room-change',{detail:{roomId:'week_43_pair_8'}}));
  });
  delayed.release(); await page.waitForTimeout(50);
  await expect(page.getByTestId('session-controls')).toBeHidden();
  expect(await page.evaluate(()=>({
    room:window._randori_session_controls?.room??null,
    controls:window._randori_session_controls?.controls??null,
  }))).toEqual({room:null,controls:null});
});
