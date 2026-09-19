import { expect, Page, test } from '@playwright/test';
import { mockApi, resetClientState } from './helpers';

const owner = {
  id: 1,
  email: 'owner@example.test',
  name: 'Circle Owner',
  display_name: 'Circle Owner',
  color: '#c8f6a0',
  is_admin: false,
  is_available: true,
  tz: 'Europe/London',
  interview_focus: 'both',
};
const member = {
  id: 2,
  email: 'member@example.test',
  name: 'Circle Member',
  display_name: 'Circle Member',
  color: '#9cc0b5',
  is_admin: false,
  is_available: true,
  tz: 'UTC',
  interview_focus: 'dsa',
};

async function confirmAction(page: Page, title: RegExp) {
  await expect(page.locator('#confirmTitle')).toHaveText(title);
  await page.locator('#confirmOk').click();
}

test('an owner deactivates, reactivates, and safely transfers ownership',async({page})=>{
  let ownerRole:'owner'|'member'='owner';
  let memberRole:'owner'|'member'='member';
  let memberStatus:'active'|'inactive'='active';
  let recent=false;
  let recentRequests=0;
  const actions:string[]=[];
  await mockApi(page,{
    '/api/auth/me':{ok:true,user:owner},
    '/api/profile':{ok:true,user:owner},
    '/api/circle':()=>({
      ok:true,
      circle_meta:{id:10,public_id:'circle_e2e',name:'E2E Circle'},
      membership:{role:ownerRole},
      circle:[owner,...(memberStatus==='active'?[member]:[])],
      count:memberStatus==='active'?2:1,
    }),
    '/api/invitations':{ok:true,invitations:[],count:0},
    '/api/auth/recent-auth':request=>{
      recentRequests+=1;
      if(request.method()==='GET') return {ok:true,recentAuth:{ok:recent},methods:{password:true,google:true}};
      expect(request.method()).toBe('POST');
      expect(request.postDataJSON()).toEqual({password:'owner password'});
      recent=true;
      return {ok:true,recentAuth:{ok:true,method:'password'}};
    },
    '/api/members':request=>{
      if(request.method()==='GET') return {
        ok:true,
        members:[
          {...owner,role:ownerRole,status:'active',joined_at:'2026-09-01T00:00:00.000Z',updated_at:'2026-09-01T00:00:00.000Z'},
          {...member,role:memberRole,status:memberStatus,joined_at:'2026-09-02T00:00:00.000Z',updated_at:'2026-09-19T00:00:00.000Z'},
        ],
        count:2,
      };
      expect(request.method()).toBe('PATCH');
      const body=request.postDataJSON() as {action:string;member_id?:number};
      expect(body.member_id).toBe(member.id);
      actions.push(body.action);
      if(body.action==='transfer'&&!recent){
        return {_status:403,error:'recent authentication required',code:'recent_auth_required'};
      }
      if(body.action==='deactivate') memberStatus='inactive';
      if(body.action==='reactivate') memberStatus='active';
      if(body.action==='transfer'){ ownerRole='member'; memberRole='owner'; }
      return {ok:true,action:body.action,member:{id:member.id,role:memberRole,status:memberStatus}};
    },
  });
  await resetClientState(page,true);
  await page.goto('/',{waitUntil:'domcontentloaded'});
  await expect(page.locator('#view-dashboard')).toBeVisible();
  await page.locator('[data-tab="circle"]').click();

  const panel=page.getByTestId('circle-lifecycle');
  await expect(panel).toBeVisible();
  await expect(panel.getByText('2 memberships available to manage.')).toBeVisible();
  const memberRow=panel.locator('[data-testid="circle-member-row"][data-member-id="2"]');
  await expect(memberRow).toContainText('member • active');

  await memberRow.getByRole('button',{name:'Deactivate Circle Member'}).click();
  await confirmAction(page,/Deactivate Circle Member/);
  await expect(memberRow).toContainText('member • inactive');
  await expect(memberRow.getByRole('button',{name:'Reactivate Circle Member'})).toBeVisible();

  await memberRow.getByRole('button',{name:'Reactivate Circle Member'}).click();
  await confirmAction(page,/Reactivate Circle Member/);
  await expect(memberRow).toContainText('member • active');

  await memberRow.getByRole('button',{name:'Transfer ownership to Circle Member'}).click();
  await confirmAction(page,/Transfer ownership to Circle Member/);
  const confirmation=page.getByRole('dialog',{name:'Confirm this sensitive change'});
  await expect(confirmation).toBeVisible();
  await expect(page.locator('#identityGoogleCard')).toBeHidden();
  await expect(page.locator('#identityPasswordCard')).toBeHidden();
  await page.locator('#identityPasswordConfirm').fill('owner password');
  await page.getByRole('button',{name:'Confirm password'}).click();
  await expect(panel.getByText('You are an active circle member.')).toBeVisible();
  await expect(page.getByTestId('circle-manage-members')).toBeHidden();
  expect(actions).toEqual(['deactivate','reactivate','transfer','transfer']);
  expect(recentRequests).toBe(2);
  await page.evaluate(()=>window.dispatchEvent(new CustomEvent('randori:recent-auth-confirmed')));
  await page.waitForTimeout(100);
  expect(actions).toEqual(['deactivate','reactivate','transfer','transfer']);
});

test('a proof that becomes fresh during the challenge resumes after the first request unwinds',async({page})=>{
  let patches=0;
  let targetRole:'member'|'owner'='member';
  await mockApi(page,{
    '/api/auth/me':{ok:true,user:owner},
    '/api/profile':{ok:true,user:owner},
    '/api/circle':{
      ok:true,circle_meta:{id:10,public_id:'circle_e2e',name:'E2E Circle'},
      membership:{role:'owner'},circle:[owner,member],count:2,
    },
    '/api/invitations':{ok:true,invitations:[],count:0},
    '/api/auth/recent-auth':{ok:true,recentAuth:{ok:true,method:'password'},methods:{password:true,google:false}},
    '/api/members':request=>{
      if(request.method()==='GET') return {ok:true,members:[
        {...owner,role:'owner',status:'active'},
        {...member,role:targetRole,status:'active'},
      ],count:2};
      patches+=1;
      if(patches===1) return {_status:403,error:'recent authentication required',code:'recent_auth_required'};
      targetRole='owner';
      return {ok:true,action:'transfer',member:{id:member.id,role:'owner',status:'active'}};
    },
  });
  await resetClientState(page,true);
  await page.goto('/',{waitUntil:'domcontentloaded'});
  await expect(page.locator('#view-dashboard')).toBeVisible();
  await page.locator('[data-tab="circle"]').click();
  await page.getByRole('button',{name:'Transfer ownership to Circle Member'}).click();
  await confirmAction(page,/Transfer ownership/);
  await expect.poll(()=>patches).toBe(2);
  expect(await page.evaluate(()=>sessionStorage.getItem('randori-lifecycle-recent-action-v1'))).toBeNull();
});

test('Google confirmation resumes exact owner deactivation once without identity management',async({page})=>{
  let recent=false;
  let targetStatus:'active'|'inactive'='active';
  const patches:unknown[]=[];
  await mockApi(page,{
    '/api/auth/capabilities':{
      ok:true,
      capabilities:{passwordLogin:true,passwordSignup:false,googleOAuth:true,identityManagement:false},
      registrationMode:'private_beta',
    },
    '/api/auth/me':{ok:true,user:owner},
    '/api/profile':{ok:true,user:owner},
    '/api/circle':{
      ok:true,circle_meta:{id:10,public_id:'circle_e2e',name:'E2E Circle'},
      membership:{role:'owner'},circle:[owner,member],count:2,
    },
    '/api/invitations':{ok:true,invitations:[],count:0},
    '/api/auth/recent-auth':{ok:true,recentAuth:{ok:false},methods:{password:false,google:true}},
    '/api/members':request=>{
      if(request.method()==='GET') return {ok:true,members:[
        {...owner,role:'owner',status:'active'},
        {...member,role:'owner',status:targetStatus},
      ],count:2};
      const body=request.postDataJSON(); patches.push(body);
      if(!recent) return {_status:403,error:'recent authentication required',code:'recent_auth_required'};
      targetStatus='inactive';
      return {ok:true,action:'deactivate',member:{id:member.id,role:'owner',status:'inactive'}};
    },
  });
  await resetClientState(page,true,{},true);
  await page.goto('/',{waitUntil:'domcontentloaded'});
  await expect(page.locator('#view-dashboard')).toBeVisible();
  await page.locator('[data-tab="circle"]').click();
  const target=page.locator('[data-testid="circle-member-row"][data-member-id="2"]');
  await target.getByRole('button',{name:'Deactivate Circle Member'}).click();
  await confirmAction(page,/Deactivate Circle Member/);
  await expect(page.getByRole('dialog',{name:'Confirm this sensitive change'})).toBeVisible();
  await expect(page.getByRole('button',{name:'Confirm with Google'})).toBeVisible();
  expect(await page.evaluate(()=>JSON.parse(sessionStorage.getItem('randori-lifecycle-recent-action-v1')||'null')))
    .toMatchObject({v:1,action:'deactivate',member_id:2,actor_id:1});

  recent=true;
  await page.goto('/?google_reauth=success',{waitUntil:'domcontentloaded'});
  await expect(page).toHaveURL('/');
  await expect(page.locator('#view-dashboard')).toBeVisible();
  await page.locator('[data-tab="circle"]').click();
  await expect(page.locator('[data-testid="circle-member-row"][data-member-id="2"]'))
    .toContainText('owner • inactive');
  expect(patches).toEqual([
    {action:'deactivate',member_id:2},
    {action:'deactivate',member_id:2},
  ]);
  expect(await page.evaluate(()=>sessionStorage.getItem('randori-lifecycle-recent-action-v1'))).toBeNull();
});

for(const failure of [
  {label:'401',response:{_status:401,error:'authentication required'},message:'Your session changed'},
  {label:'429',response:{_status:429,error:'too many confirmation attempts; try again later'},message:'Too many Google confirmation attempts'},
  {label:'503',response:{_status:503,error:'Google reauthentication is unavailable'},message:'Google confirmation is temporarily unavailable'},
  {label:'malicious authorization URL',response:{ok:true,authorizationUrl:'https://accounts.google.com.attacker.test/o/oauth2/v2/auth?state=bad'},message:'Google confirmation is temporarily unavailable'},
  {label:'malformed authorization URL',response:{ok:true,authorizationUrl:'not-a-url'},message:'Google confirmation is temporarily unavailable'},
] as const){
  test(`a ${failure.label} Google confirmation start failure stays in the app and cancels the action`,async({page})=>{
    let patches=0;
    let holdRoster=false;
    let releaseRoster!:()=>void;
    let markRosterStarted!:()=>void;
    const rosterGate=new Promise<void>(resolve=>{ releaseRoster=resolve; });
    const rosterStarted=new Promise<void>(resolve=>{ markRosterStarted=resolve; });
    await mockApi(page,{
      '/api/auth/capabilities':{
        ok:true,
        capabilities:{passwordLogin:true,passwordSignup:false,googleOAuth:true,identityManagement:false},
        registrationMode:'private_beta',
      },
      '/api/auth/me':{ok:true,user:owner},
      '/api/profile':{ok:true,user:owner},
      '/api/circle':{
        ok:true,circle_meta:{id:10,public_id:'circle_e2e',name:'E2E Circle'},
        membership:{role:'owner'},circle:[owner,member],count:2,
      },
      '/api/invitations':{ok:true,invitations:[],count:0},
      '/api/auth/recent-auth':{ok:true,recentAuth:{ok:false},methods:{password:false,google:true}},
      '/api/auth/google/reauth/start':request=>{
        expect(request.method()).toBe('POST');
        expect(request.postDataJSON()).toEqual({});
        return failure.response;
      },
      '/api/members':request=>{
        if(request.method()==='GET') return (async()=>{
          if(holdRoster){
            holdRoster=false;
            markRosterStarted();
            await rosterGate;
          }
          return {ok:true,members:[
            {...owner,role:'owner',status:'active'},
            {...member,role:'owner',status:'active'},
          ],count:2};
        })();
        patches+=1;
        return {_status:403,error:'recent authentication required',code:'recent_auth_required'};
      },
    });
    await resetClientState(page,true);
    await page.goto('/',{waitUntil:'domcontentloaded'});
    await expect(page.locator('#view-dashboard')).toBeVisible();
    await page.locator('[data-tab="circle"]').click();
    const target=page.locator('[data-testid="circle-member-row"][data-member-id="2"]');
    await target.getByRole('button',{name:'Deactivate Circle Member'}).click();
    await confirmAction(page,/Deactivate Circle Member/);
    await expect(page.getByRole('dialog',{name:'Confirm this sensitive change'})).toBeVisible();
    if(failure.label==='401'){
      holdRoster=true;
      await page.evaluate(()=>document.querySelector<HTMLElement>('[data-tab="circle"]')?.click());
      await rosterStarted;
    }
    await page.getByRole('button',{name:'Confirm with Google'}).click();
    await expect(page).toHaveURL('/');
    await expect(page.getByRole('dialog',{name:'Confirm this sensitive change'})).toBeHidden();
    await expect(page.locator('#circleLifecycleStatus')).toContainText(failure.message);
    expect(await page.evaluate(()=>sessionStorage.getItem('randori-lifecycle-recent-action-v1'))).toBeNull();
    expect(patches).toBe(1);
    if(failure.label==='401'){
      const rosterResponse=page.waitForResponse(response=>new URL(response.url()).pathname==='/api/members'
        &&response.request().method()==='GET');
      releaseRoster();
      await rosterResponse;
      await page.evaluate(()=>new Promise<void>(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>resolve()))));
      await expect(page.locator('#circleLifecycleStatus')).toContainText(failure.message);
      expect(patches).toBe(1);
    }else{
      releaseRoster();
    }
  });
}

test('cancel, expiry, actor change, and missing methods discard the one-time continuation',async({page})=>{
  let currentUser=owner;
  let methods={password:true,google:true};
  let patchCount=0;
  await mockApi(page,{
    '/api/auth/me':()=>({ok:true,user:currentUser}),
    '/api/profile':{ok:true,user:owner},
    '/api/circle':{
      ok:true,circle_meta:{id:10,public_id:'circle_e2e',name:'E2E Circle'},
      membership:{role:'owner'},circle:[owner,member],count:2,
    },
    '/api/invitations':{ok:true,invitations:[],count:0},
    '/api/auth/recent-auth':request=>request.method()==='GET'
      ?{ok:true,recentAuth:{ok:false},methods}
      :{ok:true,recentAuth:{ok:true,method:'password'}},
    '/api/members':request=>{
      if(request.method()==='GET') return {ok:true,members:[
        {...owner,role:'owner',status:'active'},{...member,role:'member',status:'active'},
      ],count:2};
      patchCount+=1;
      return {_status:403,error:'recent authentication required',code:'recent_auth_required'};
    },
  });
  await resetClientState(page,true,{},true);
  await page.goto('/',{waitUntil:'domcontentloaded'});
  await expect(page.locator('#view-dashboard')).toBeVisible();
  await page.locator('[data-tab="circle"]').click();
  const transfer=page.getByRole('button',{name:'Transfer ownership to Circle Member'});

  await transfer.click(); await confirmAction(page,/Transfer ownership/);
  await expect(page.getByRole('dialog',{name:'Confirm this sensitive change'})).toBeVisible();
  await page.locator('#identityClose').click();
  expect(patchCount).toBe(1);
  expect(await page.evaluate(()=>sessionStorage.getItem('randori-lifecycle-recent-action-v1'))).toBeNull();

  await transfer.click(); await confirmAction(page,/Transfer ownership/);
  await expect(page.getByRole('dialog',{name:'Confirm this sensitive change'})).toBeVisible();
  await page.goto('/?google_error=access_denied',{waitUntil:'domcontentloaded'});
  await expect(page).toHaveURL('/');
  expect(await page.evaluate(()=>sessionStorage.getItem('randori-lifecycle-recent-action-v1'))).toBeNull();
  expect(patchCount).toBe(2);

  await expect(page.locator('#view-dashboard')).toBeVisible();
  await page.locator('[data-tab="circle"]').click();
  await page.getByRole('button',{name:'Transfer ownership to Circle Member'}).click();
  await confirmAction(page,/Transfer ownership/);
  await expect(page.getByRole('dialog',{name:'Confirm this sensitive change'})).toBeVisible();
  await page.evaluate(()=>{
    const key='randori-lifecycle-recent-action-v1';
    const pending=JSON.parse(sessionStorage.getItem(key)||'null');
    pending.created_at=Date.now()-11*60*1000;
    sessionStorage.setItem(key,JSON.stringify(pending));
  });
  await page.locator('#identityPasswordConfirm').fill('owner password');
  await page.getByRole('button',{name:'Confirm password'}).click();
  await expect(page.locator('#circleLifecycleStatus')).toContainText('expired');
  expect(patchCount).toBe(3);

  await page.getByRole('button',{name:'Transfer ownership to Circle Member'}).click();
  await confirmAction(page,/Transfer ownership/);
  await expect(page.getByRole('dialog',{name:'Confirm this sensitive change'})).toBeVisible();
  currentUser={...member,id:9,email:'other@example.test'};
  await page.evaluate(async()=>{ await (window as any)._randori_auth.refreshMe(); });
  await page.locator('#identityPasswordConfirm').fill('owner password');
  await page.getByRole('button',{name:'Confirm password'}).click();
  await expect(page.locator('#circleLifecycleStatus')).toContainText('signed-in account changed');
  expect(patchCount).toBe(4);

  currentUser=owner;
  await page.evaluate(async()=>{ await (window as any)._randori_auth.refreshMe(); });
  await page.locator('[data-tab="circle"]').click();
  await page.getByRole('button',{name:'Transfer ownership to Circle Member'}).click();
  await confirmAction(page,/Transfer ownership/);
  await expect(page.getByRole('dialog',{name:'Confirm this sensitive change'})).toBeVisible();
  methods={password:false,google:false};
  // Retry the action so the confirmation surface reloads the now-empty method set.
  await page.locator('#identityClose').click();
  await page.getByRole('button',{name:'Transfer ownership to Circle Member'}).click();
  await confirmAction(page,/Transfer ownership/);
  await expect(page.locator('#identityStatus')).toContainText('No confirmation method is available');
  expect(await page.evaluate(()=>sessionStorage.getItem('randori-lifecycle-recent-action-v1'))).toBeNull();
  expect(patchCount).toBe(6);
});

test('a member can leave and is returned to signed-out state immediately',async({page})=>{
  let signedIn=true;
  const actions:string[]=[];
  await mockApi(page,{
    '/api/auth/me':()=>signedIn?{ok:true,user:member}:{_status:401,error:'authentication required'},
    '/api/profile':{ok:true,user:member},
    '/api/circle':{
      ok:true,
      circle_meta:{id:10,public_id:'circle_e2e',name:'E2E Circle'},
      membership:{role:'member'},
      circle:[owner,member],
      count:2,
    },
    '/api/members':request=>{
      expect(request.method()).toBe('PATCH');
      const body=request.postDataJSON() as {action:string};
      expect(body).toEqual({action:'leave'});
      actions.push(body.action);
      signedIn=false;
      return {ok:true,action:'leave'};
    },
  });
  await resetClientState(page,true);
  await page.goto('/',{waitUntil:'domcontentloaded'});
  await expect(page.locator('#view-dashboard')).toBeVisible();
  await page.locator('[data-tab="circle"]').click();

  const panel=page.getByTestId('circle-lifecycle');
  await expect(panel.getByText('You are an active circle member.')).toBeVisible();
  await panel.getByRole('button',{name:'Leave circle'}).click();
  await page.evaluate(()=>{
    (window as any)._randori_auth.refreshMe=async()=>{ throw new Error('forced refresh failure'); };
    (window as any)._randori_nav.showView('code');
  });
  await confirmAction(page,/Leave this circle/);

  await expect(page.locator('#view-landing')).toBeVisible();
  await expect(page.locator('#view-code')).toBeHidden();
  await expect(page.locator('#authBtn')).toBeVisible();
  expect(actions).toEqual(['leave']);
});

test('the last-owner refusal is actionable and preserves the owner controls',async({page})=>{
  await mockApi(page,{
    '/api/auth/me':{ok:true,user:owner},
    '/api/profile':{ok:true,user:owner},
    '/api/circle':{
      ok:true,
      circle_meta:{id:10,public_id:'circle_e2e',name:'E2E Circle'},
      membership:{role:'owner'},
      circle:[owner],
      count:1,
    },
    '/api/invitations':{ok:true,invitations:[],count:0},
    '/api/members':request=>{
      if(request.method()==='GET') return {ok:true,members:[{...owner,role:'owner',status:'active'}],count:1};
      expect(request.method()).toBe('PATCH');
      expect(request.postDataJSON()).toEqual({action:'leave'});
      return {_status:409,error:'another active owner is required'};
    },
  });
  await resetClientState(page,true);
  await page.goto('/',{waitUntil:'domcontentloaded'});
  await expect(page.locator('#view-dashboard')).toBeVisible();
  await page.locator('[data-tab="circle"]').click();

  await page.getByTestId('circle-leave').click();
  await confirmAction(page,/Leave this circle/);
  await expect(page.locator('#circleLifecycleStatus')).toHaveText('Transfer ownership before removing the last active owner.');
  await expect(page.getByTestId('circle-manage-members')).toBeVisible();
  await expect(page.locator('#circleRoleLabel')).toHaveText('owner');
});

test('a capped owner roster tells the owner that additional memberships are not shown',async({page})=>{
  const members=Array.from({length:500},(_,index)=>({
    ...member,
    id:index+2,
    display_name:`Member ${index+2}`,
    role:'member',
    status:'active',
  }));
  members.unshift({...owner,role:'owner',status:'active'});
  members.length=500;
  await mockApi(page,{
    '/api/auth/me':{ok:true,user:owner},
    '/api/profile':{ok:true,user:owner},
    '/api/circle':{
      ok:true,
      circle_meta:{id:10,public_id:'circle_e2e',name:'E2E Circle'},
      membership:{role:'owner'},
      circle:[owner],
      count:1,
    },
    '/api/invitations':{ok:true,invitations:[],count:0},
    '/api/members':{ok:true,members,count:500,truncated:true},
  });
  await resetClientState(page,true);
  await page.goto('/',{waitUntil:'domcontentloaded'});
  await expect(page.locator('#view-dashboard')).toBeVisible();
  await page.locator('[data-tab="circle"]').click();
  await expect(page.locator('#circleLifecycleStatus'))
    .toHaveText('Showing the first 500 memberships. Additional members are not shown.');
  await expect(page.locator('[data-testid="circle-member-row"]')).toHaveCount(500);
});
