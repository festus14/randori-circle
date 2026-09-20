import { expect, Page, Request, Route, test } from '@playwright/test';
import { mockApi, originalQuestionFixture, resetClientState } from './helpers';

const roomId='week_42_pair_7';
const user={
  id:1,email:'candidate@example.test',name:'Candidate',display_name:'Candidate',
  color:'#c8f6a0',is_available:true,tz:'Europe/London',interview_focus:'both',
};

function pairResponse(){
  return {
    ok:true,paired:true,room_id:roomId,week_id:42,
    week:{id:42,week_label:'2026-W42'},
    pair:{pg_id:7,week_id:42,user_a_id:1,user_b_id:2,user_c_id:null,is_ai_pair:false,is_ai:false,topic:'Pick together'},
    partner:{id:2,name:'Partner',display_name:'Partner',color:'#9cc0b5',tz:'UTC'},
    partners:[{id:2,name:'Partner',display_name:'Partner',color:'#9cc0b5',tz:'UTC'}],
  };
}

class CompletionStore{
  requests:Array<{method:string;body:Record<string,unknown>|null}>=[];
  completion={
    state:'not_recorded',viewer_confirmed:false,confirmed_count:0,required_count:2,
    version:'0'.repeat(64),completed_at:null as string|null,
  };
  private delayed:null|{started:()=>void;gate:Promise<void>}=null;

  delayNext(){
    let release=()=>{};
    let startedResolve=()=>{};
    const started=new Promise<void>(resolve=>{ startedResolve=resolve; });
    const gate=new Promise<void>(resolve=>{ release=resolve; });
    this.delayed={started:startedResolve,gate};
    return {started,release};
  }

  completeForEveryone(){
    this.completion={
      state:'completed',viewer_confirmed:true,confirmed_count:2,required_count:2,
      version:'2'.repeat(64),completed_at:'2026-09-20T18:30:00.000Z',
    };
  }

  route=async(route:Route)=>{
    const request=route.request();
    const body=request.method()==='POST'?(request.postDataJSON() as Record<string,unknown>):null;
    this.requests.push({method:request.method(),body});
    if(this.delayed){
      const delayed=this.delayed; this.delayed=null; delayed.started(); await delayed.gate;
    }
    if(body?.action==='confirm'&&this.completion.state==='not_recorded'){
      this.completion={
        state:'awaiting_participants',viewer_confirmed:true,confirmed_count:1,required_count:2,
        version:'1'.repeat(64),completed_at:null,
      };
    }else if(body?.action==='withdraw'&&this.completion.state==='awaiting_participants'){
      this.completion={
        state:'not_recorded',viewer_confirmed:false,confirmed_count:0,required_count:2,
        version:'3'.repeat(64),completed_at:null,
      };
    }
    await route.fulfill({
      status:200,contentType:'application/json',
      body:JSON.stringify({ok:true,room_id:roomId,completion:this.completion}),
    });
  };
}

async function openWorkspace(page:Page,completion:CompletionStore){
  await page.route(/^https:\/\//,route=>route.abort());
  let revision=0;
  await mockApi(page,{
    '/api/auth/me':{ok:true,user},'/api/profile':{ok:true,user},
    '/api/questions':{ok:true,questions:[originalQuestionFixture],count:1},
    '/api/my-pair':pairResponse(),
    '/api/video/signal':(request:Request)=>{
      const url=new URL(request.url());
      if(request.method()==='GET'&&url.searchParams.get('channel')==='workspace'){
        return {ok:true,room_id:roomId,revision,snapshot:null};
      }
      const body=request.postDataJSON() as {payload?:Record<string,unknown>};
      revision+=1;
      return {ok:true,room_id:roomId,revision,snapshot:{...body.payload,revision}};
    },
  });
  await page.route(/\/api\/session-completion(?:\?.*)?$/,completion.route);
  await resetClientState(page,true);
  await page.goto(`/join/${roomId}`,{waitUntil:'domcontentloaded'});
  await expect(page.locator('#view-code')).toBeVisible();
  await expect.poll(()=>page.evaluate(()=>(window as typeof window & {
    _randori_workspace?:{hydrated?:boolean};
  })._randori_workspace?.hydrated)).toBe(true);
  await expect(page.getByTestId('session-completion')).toBeVisible();
}

test('workspace wrap-up confirms, waits for the partner, and renders terminal completion',async({page})=>{
  const completion=new CompletionStore();
  await openWorkspace(page,completion);
  const card=page.getByTestId('session-completion');
  const status=page.locator('#sessionCompletionStatus');
  const action=page.locator('#sessionCompletionAction');
  await expect(status).toHaveText('Completion not recorded. Every participant must confirm.');
  await expect(action).toHaveText('Confirm session completed');
  await expect(card).toHaveAttribute('aria-busy','false');

  await action.click();
  await expect(status).toHaveText('You confirmed. Waiting for 1 participant.');
  await expect(action).toHaveText('Withdraw confirmation');
  const post=completion.requests.find(request=>request.method==='POST');
  expect(Object.keys(post?.body||{}).sort()).toEqual(['action','base_version','room_id']);
  expect(post?.body).toEqual({room_id:roomId,action:'confirm',base_version:'0'.repeat(64)});
  expect(JSON.stringify(post?.body)).not.toContain('user_id');

  completion.completeForEveryone();
  await expect(status).toContainText('Session completed');
  await expect(action).toBeHidden();
});

test('a delayed completion response cannot cross an account or room boundary',async({page})=>{
  const completion=new CompletionStore();
  await openWorkspace(page,completion);
  await expect(page.locator('#sessionCompletionStatus')).toContainText('Completion not recorded');
  completion.completeForEveryone();
  const delayed=completion.delayNext();
  await page.evaluate(()=>{
    void (window as typeof window & {_randori_session_completion?:{load:()=>Promise<boolean>}})
      ._randori_session_completion?.load();
  });
  await delayed.started;
  await page.evaluate(()=>{
    window.dispatchEvent(new CustomEvent('randori:auth-refreshed',{detail:{signedIn:false,userId:null}}));
    window.dispatchEvent(new CustomEvent('randori:room-change',{detail:{roomId:'week_43_pair_8'}}));
  });
  delayed.release();
  await page.waitForTimeout(50);
  await expect(page.getByTestId('session-completion')).toBeHidden();
  expect(await page.evaluate(()=>{
    const api=(window as typeof window & {
      _randori_session_completion?:{completion?:unknown;room?:string|null};
    })._randori_session_completion;
    return {completion:api?.completion??null,room:api?.room??null};
  })).toEqual({completion:null,room:null});
});

test('the shared completion fixture rejects access after sign-out removes the session',async({page})=>{
  let signedIn=true;
  await mockApi(page,{
    '/api/auth/me':()=>signedIn?{ok:true,user}:{_status:401,ok:false,error:'authentication required'},
    '/api/profile':{ok:true,user},
    '/api/auth/logout':()=>{ signedIn=false; return {ok:true}; },
  });
  await resetClientState(page,true);
  await page.goto('/',{waitUntil:'domcontentloaded'});

  const readCompletion=()=>page.evaluate(async room=>{
    const response=await fetch(`/api/session-completion?room_id=${encodeURIComponent(room)}`);
    return {status:response.status,body:await response.json()};
  },roomId);
  await expect(readCompletion()).resolves.toMatchObject({
    status:200,body:{ok:true,room_id:roomId},
  });

  await page.locator('#meLabel').click();
  const reloaded=page.waitForEvent('load');
  await page.locator('#meSignOut').click();
  await reloaded;
  await expect(page.locator('#authBtn')).toBeVisible();
  // The route fixture cannot emit the production logout response's Set-Cookie
  // deletion, so model that server-side session removal before the API probe.
  await page.context().clearCookies();
  await expect(readCompletion()).resolves.toEqual({
    status:401,body:{ok:false,error:'authentication required'},
  });
});

test('completed-session dashboard totals never fall back to week or pairing counts',async({page})=>{
  await mockApi(page,{
    '/api/auth/me':{ok:true,user},'/api/profile':{ok:true,user},
    '/api/stats':{ok:true,total_users:5,total_weeks:7,total_pairs:9,your_weeks:4,your_pairings:6},
  });
  await resetClientState(page,true);
  await page.goto('/',{waitUntil:'domcontentloaded'});
  await expect(page.locator('#view-dashboard')).toBeVisible();
  await expect(page.locator('#dashStatYou')).toHaveText('—');
  await expect(page.locator('#dashStatYouSub')).toHaveText('from 6 pairings');
  await expect(page.locator('#statSessions')).toHaveText('—');
});
