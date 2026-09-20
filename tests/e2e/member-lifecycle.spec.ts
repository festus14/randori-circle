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
        has_more:false,
        next_cursor:null,
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
  await expect(panel.getByText('2 memberships shown. All members loaded.')).toBeVisible();
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
      ],count:2,has_more:false,next_cursor:null,scanned:2};
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
  let capabilityCalls=0;
  let targetStatus:'active'|'inactive'='active';
  const patches:unknown[]=[];
  await mockApi(page,{
    '/api/auth/capabilities':async()=>{
      capabilityCalls+=1;
      if(capabilityCalls>1) await new Promise(resolve=>setTimeout(resolve,100));
      return {
        ok:true,
        capabilities:{passwordLogin:true,passwordSignup:false,googleOAuth:true,identityManagement:false,multiCircleControlPlane:true},
        registrationMode:'private_beta',
      };
    },
    '/api/auth/me':{ok:true,user:owner},
    '/api/circles':{
      ok:true,circles:[
        {public_id:'circle_e2e',name:'E2E Circle',role:'owner',is_primary:true},
        {public_id:'circle_other',name:'Other Circle',role:'member',is_primary:false},
      ],active_circle:{public_id:'circle_e2e',name:'E2E Circle',role:'owner',is_primary:true},
      context_version:1,selection_required:false,
    },
    '/api/profile':{ok:true,user:owner},
    '/api/circle':{
      ok:true,circle_meta:{id:10,public_id:'circle_e2e',name:'E2E Circle'},
      membership:{role:'owner'},circle:[owner,member],count:2,circle_context_version:1,
    },
    '/api/invitations':{ok:true,invitations:[],count:0,circle_context_version:1},
    '/api/auth/recent-auth':{ok:true,recentAuth:{ok:false},methods:{password:false,google:true}},
    '/api/members':request=>{
      if(request.method()==='GET') return {ok:true,members:[
        {...owner,role:'owner',status:'active'},
        {...member,role:'owner',status:targetStatus},
      ],count:2,has_more:false,next_cursor:null,scanned:2,circle_context_version:1};
      const body=request.postDataJSON(); patches.push(body);
      if(!recent) return {_status:403,error:'recent authentication required',code:'recent_auth_required'};
      targetStatus='inactive';
      return {ok:true,action:'deactivate',member:{id:member.id,role:'owner',status:'inactive'},circle_context_version:1};
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
          ],count:2,has_more:false,next_cursor:null,scanned:2};
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
      await page.getByTestId('circle-member-search').fill('member');
      await page.evaluate(()=>document.querySelector<HTMLFormElement>('#circleMemberSearchForm')?.requestSubmit());
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
    const refreshedRoster=page.waitForResponse(response=>new URL(response.url()).pathname==='/api/members'
      &&response.request().method()==='GET');
    await page.evaluate(()=>document.querySelector<HTMLFormElement>('#circleMemberSearchForm')?.requestSubmit());
    await refreshedRoster;
    await page.evaluate(()=>new Promise<void>(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>resolve()))));
    await expect(page.locator('#circleLifecycleStatus')).toContainText(failure.message);
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
      ],count:2,has_more:false,next_cursor:null,scanned:2};
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

test('a delayed member mutation cannot restore an old-circle roster during a switch',async({page})=>{
  let active:'circle-primary'|'circle-secondary'='circle-primary';
  let contextVersion=1;
  let circleReads=0;
  let markPatchStarted!:()=>void;
  let releasePatch!:()=>void;
  const patchStarted=new Promise<void>(resolve=>{ markPatchStarted=resolve; });
  const patchGate=new Promise<void>(resolve=>{ releasePatch=resolve; });
  let markSwitchStarted!:()=>void;
  let releaseSwitch!:()=>void;
  const switchStarted=new Promise<void>(resolve=>{ markSwitchStarted=resolve; });
  const switchGate=new Promise<void>(resolve=>{ releaseSwitch=resolve; });
  let holdOldCircleInvitations=false;
  let markOldCircleRenderBlocked!:()=>void;
  let releaseOldCircleRender!:()=>void;
  const oldCircleRenderBlocked=new Promise<void>(resolve=>{ markOldCircleRenderBlocked=resolve; });
  const oldCircleRenderGate=new Promise<void>(resolve=>{ releaseOldCircleRender=resolve; });
  const circles=[
    {id:10,public_id:'circle-primary',name:'Primary',role:'owner',is_primary:true},
    {id:20,public_id:'circle-secondary',name:'Secondary',role:'owner',is_primary:false},
  ];
  await mockApi(page,{
    '/api/auth/capabilities':{
      ok:true,
      capabilities:{passwordLogin:true,passwordSignup:false,googleOAuth:true,multiCircleControlPlane:true},
      registrationMode:'private_beta',
    },
    '/api/auth/me':{ok:true,user:owner},
    '/api/profile':{ok:true,user:owner},
    '/api/circles':async request=>{
      if(request.method()==='PUT'){
        markSwitchStarted();
        await switchGate;
        active='circle-secondary';
        contextVersion=2;
      }else{
        circleReads+=1;
      }
      return {ok:true,circles,active_circle:circles.find(circle=>circle.public_id===active),
        context_version:contextVersion,selection_required:false};
    },
    '/api/circle':()=>({
      ok:true,circle_meta:{id:active==='circle-primary'?10:20,public_id:active,name:active},
      membership:{role:'owner'},circle:active==='circle-primary'?[owner,member]:[owner],
      count:active==='circle-primary'?2:1,circle_context_version:contextVersion,
    }),
    '/api/invitations':async()=>{
      if(holdOldCircleInvitations){
        holdOldCircleInvitations=false;
        markOldCircleRenderBlocked();
        await oldCircleRenderGate;
      }
      return {ok:true,invitations:[],count:0,circle_context_version:contextVersion};
    },
    '/api/members':async request=>{
      if(request.method()==='GET') return {ok:true,members:active==='circle-primary'?[
        {...owner,role:'owner',status:'active'},
        {...member,role:'member',status:'active'},
      ]:[{...owner,role:'owner',status:'active'}],count:active==='circle-primary'?2:1,
      has_more:false,next_cursor:null,scanned:active==='circle-primary'?2:1,
      circle_context_version:contextVersion};
      expect(request.method()).toBe('PATCH');
      markPatchStarted();
      await patchGate;
      return {ok:true,action:'deactivate',member:{id:member.id,role:'member',status:'inactive'},
        circle_context_version:1};
    },
  });
  try{
    await resetClientState(page,true,{},true);
    await page.goto('/',{waitUntil:'domcontentloaded'});
    await expect(page.locator('#view-dashboard')).toBeVisible();
    await page.locator('[data-tab="circle"]').click();
    const selector=page.getByTestId('circle-context-select');
    await expect(selector).toHaveValue('circle-primary');
    const target=page.locator('[data-testid="circle-member-row"][data-member-id="2"]');
    await expect(target).toContainText('member • active');

    const mutationResponse=page.waitForResponse(response=>new URL(response.url()).pathname==='/api/members'
      &&response.request().method()==='PATCH');
    await target.getByRole('button',{name:'Deactivate Circle Member'}).click();
    await confirmAction(page,/Deactivate Circle Member/);
    await patchStarted;

    // Hold an independent old-circle render after it has authorized the owner
    // but before it reaches the lifecycle panel. This reproduces the Linux CI
    // interleaving deterministically instead of relying on startup timing.
    holdOldCircleInvitations=true;
    const oldCircleInvitationResponse=page.waitForResponse(response=>new URL(response.url()).pathname==='/api/invitations'
      &&response.request().method()==='GET');
    await page.locator('[data-tab="circle"]').click();
    await oldCircleRenderBlocked;

    const selecting=selector.selectOption('circle-secondary');
    await switchStarted;
    const readsAtSwitch=circleReads;
    releaseOldCircleRender();
    const staleRenderResponse=await oldCircleInvitationResponse;
    await staleRenderResponse.finished();
    await page.evaluate(()=>new Promise<void>(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>resolve()))));
    await expect(page.locator('[data-testid="circle-member-row"]')).toHaveCount(0);
    await expect(page.getByTestId('circle-lifecycle')).toBeHidden();
    await expect(page.locator('#circleOwnerPanel')).toBeHidden();

    releasePatch();
    const completed=await mutationResponse;
    await completed.finished();
    await page.evaluate(()=>new Promise<void>(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>resolve()))));
    expect(circleReads).toBe(readsAtSwitch);
    await expect(page.locator('[data-testid="circle-member-row"]')).toHaveCount(0);
    await expect(page.getByTestId('circle-lifecycle')).toBeHidden();
    await expect(page.locator('#circleOwnerPanel')).toBeHidden();

    const reloaded=page.waitForEvent('domcontentloaded');
    releaseSwitch();
    await selecting;
    await reloaded;
  }finally{
    releasePatch();
    releaseSwitch();
    releaseOldCircleRender();
  }
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
      return {ok:true,action:'leave',signed_out:true};
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
      if(request.method()==='GET') return {ok:true,members:[{...owner,role:'owner',status:'active'}],count:1,has_more:false,next_cursor:null};
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
  const refreshedRoster=page.waitForResponse(response=>new URL(response.url()).pathname==='/api/members'
    &&response.request().method()==='GET');
  await page.evaluate(()=>document.querySelector<HTMLFormElement>('#circleMemberSearchForm')?.requestSubmit());
  await refreshedRoster;
  await expect(page.locator('#circleLifecycleStatus')).toHaveText('Transfer ownership before removing the last active owner.');
  await expect(page.getByTestId('circle-manage-members')).toBeVisible();
  await expect(page.locator('#circleRoleLabel')).toHaveText('owner');
});

test('an owner loads additional bounded roster pages with accessible progress',async({page})=>{
  const members=Array.from({length:120},(_,index)=>({
    ...member,
    id:index+2,
    display_name:`Member ${index+2}`,
    role:'member',
    status:'active',
  }));
  members.unshift({...owner,role:'owner',status:'active'});
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
      const cursor=new URL(request.url()).searchParams.get('cursor');
      const start=cursor==='page-2'?50:cursor==='page-3'?100:0;
      const pageMembers=members.slice(start,start+50);
      const next=start+50<members.length?(start===0?'page-2':'page-3'):null;
      return {ok:true,members:pageMembers,count:pageMembers.length,has_more:Boolean(next),next_cursor:next,scanned:pageMembers.length};
    },
  });
  await resetClientState(page,true);
  await page.goto('/',{waitUntil:'domcontentloaded'});
  await expect(page.locator('#view-dashboard')).toBeVisible();
  await page.locator('[data-tab="circle"]').click();
  const status=page.locator('#circleMemberSearchStatus');
  await expect(status).toHaveText('50 memberships shown. More members are available.');
  const loadMore=page.getByTestId('circle-members-load-more');
  await expect(loadMore).toHaveAttribute('aria-controls','circleManageMembers');
  await expect(loadMore).toBeEnabled();
  await loadMore.focus();
  await expect(loadMore).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(status).toHaveText('100 memberships shown. More members are available.');
  await loadMore.evaluate((button:HTMLButtonElement)=>button.click());
  await expect(status).toHaveText('121 memberships shown. All members loaded.');
  await expect(page.locator('[data-testid="circle-member-row"]')).toHaveCount(121);
  await expect(loadMore).toBeHidden();
});

test('transient append failures preserve rows while failed replacement searches clear them',async({page})=>{
  await mockApi(page,{
    '/api/auth/me':{ok:true,user:owner},
    '/api/profile':{ok:true,user:owner},
    '/api/circle':{
      ok:true,circle_meta:{id:10,public_id:'circle_e2e',name:'E2E Circle'},
      membership:{role:'owner'},circle:[owner],count:1,
    },
    '/api/invitations':{ok:true,invitations:[],count:0},
    '/api/members':request=>{
      const url=new URL(request.url());
      if(url.searchParams.has('cursor')) return {_status:503,error:'temporarily unavailable'};
      if(url.searchParams.get('q')==='replacement') return {_status:503,error:'temporarily unavailable'};
      return {
        ok:true,members:[{...owner,role:'owner',status:'active'}],count:1,
        has_more:true,next_cursor:'next-page',scanned:1,
      };
    },
  });
  await resetClientState(page,true);
  await page.goto('/',{waitUntil:'domcontentloaded'});
  await expect(page.locator('#view-dashboard')).toBeVisible();
  await page.locator('[data-tab="circle"]').click();
  const rows=page.locator('[data-testid="circle-member-row"]');
  await expect(rows).toHaveCount(1);

  await page.getByTestId('circle-members-load-more').click();
  await expect(page.locator('#circleMemberSearchStatus')).toHaveText('More members could not be loaded. Existing results are unchanged.');
  await expect(rows).toHaveCount(1);
  await expect(page.getByText('Circle Owner',{exact:true}).last()).toBeVisible();
  await expect(page.getByTestId('circle-members-load-more')).toHaveText('Retry more members');

  const search=page.getByTestId('circle-member-search');
  await search.fill('replacement');
  await search.press('Enter');
  await expect(page.locator('#circleMemberSearchStatus')).toHaveText('Member search is unavailable. Try again.');
  await expect(rows).toHaveCount(0);
  await expect(page.getByRole('button',{name:'Retry members'})).toBeVisible();
});

test('display-name search ignores stale responses and exposes screen-reader status',async({page})=>{
  let markSlowSearchStarted!:()=>void;
  let releaseSlowSearch!:()=>void;
  const slowSearchStarted=new Promise<void>(resolve=>{ markSlowSearchStarted=resolve; });
  const slowSearchRelease=new Promise<void>(resolve=>{ releaseSlowSearch=resolve; });
  await mockApi(page,{
    '/api/auth/me':{ok:true,user:owner},
    '/api/profile':{ok:true,user:owner},
    '/api/circle':{
      ok:true,circle_meta:{id:10,public_id:'circle_e2e',name:'E2E Circle'},
      membership:{role:'owner'},circle:[owner],count:1,
    },
    '/api/invitations':{ok:true,invitations:[],count:0},
    '/api/members':async request=>{
      const q=new URL(request.url()).searchParams.get('q')||'';
      if(q==='slow'){
        markSlowSearchStarted();
        await slowSearchRelease;
      }
      const result=q==='fast'?[{...member,id:42,display_name:'Fast Result',role:'member',status:'active'}]
        :q==='slow'?[{...member,id:41,display_name:'Slow Result',role:'member',status:'active'}]
        :[{...owner,role:'owner',status:'active'}];
      return {ok:true,members:result,count:result.length,has_more:false,next_cursor:null,scanned:result.length};
    },
  });
  await resetClientState(page,true);
  await page.goto('/',{waitUntil:'domcontentloaded'});
  await expect(page.locator('#view-dashboard')).toBeVisible();
  await page.locator('[data-tab="circle"]').click();
  const input=page.getByTestId('circle-member-search');
  await expect(input).toBeVisible();
  await expect(page.locator('#circleMemberSearchStatus')).toHaveText('1 membership shown. All members loaded.');
  await input.fill('slow');
  await input.press('Enter');
  await slowSearchStarted;
  await input.fill('fast');
  await page.locator('#circleMemberSearchSubmit').click();
  await expect(page.locator('#circleMemberSearchStatus')).toHaveText('1 matching member shown. Search complete.');
  await expect(page.getByText('Fast Result',{exact:true})).toBeVisible();
  const staleResponse=page.waitForResponse(response=>{
    const url=new URL(response.url());
    return url.pathname==='/api/members'&&url.searchParams.get('q')==='slow';
  });
  releaseSlowSearch();
  await staleResponse;
  await expect(page.getByText('Fast Result',{exact:true})).toBeVisible();
  await expect(page.getByText('Slow Result',{exact:true})).toHaveCount(0);
  await expect(page.locator('#circleMemberSearchStatus')).toHaveAttribute('aria-live','polite');
  await page.getByRole('button',{name:'Clear'}).click();
  await expect(input).toBeFocused();
});

for(const deniedStatus of [401,403]){
  test(`a delayed same-actor ${deniedStatus} clears a newer successful roster`,async({page})=>{
    let authChecks=0;
    let markDeniedRequestStarted!:()=>void;
    let releaseDeniedRequest!:()=>void;
    const deniedRequestStarted=new Promise<void>(resolve=>{ markDeniedRequestStarted=resolve; });
    const deniedRequestRelease=new Promise<void>(resolve=>{ releaseDeniedRequest=resolve; });
    await mockApi(page,{
      '/api/auth/me':()=>{
        authChecks+=1;
        return {ok:true,user:owner};
      },
      '/api/profile':{ok:true,user:owner},
      '/api/circle':{
        ok:true,circle_meta:{id:10,public_id:'circle_e2e',name:'E2E Circle'},
        membership:{role:'owner'},circle:[owner],count:1,
      },
      '/api/invitations':{ok:true,invitations:[],count:0},
      '/api/members':async request=>{
        const q=new URL(request.url()).searchParams.get('q')||'';
        if(q==='slow-denied'){
          markDeniedRequestStarted();
          await deniedRequestRelease;
          return {_status:deniedStatus,error:'opaque access failure'};
        }
        const result=q==='newer-success'
          ?[{...member,id:42,display_name:'Newer Result',role:'member',status:'active'}]
          :[{...owner,role:'owner',status:'active'}];
        return {ok:true,members:result,count:result.length,has_more:false,next_cursor:null,scanned:result.length};
      },
    });
    await page.clock.install();
    await resetClientState(page,true);
    await page.goto('/',{waitUntil:'domcontentloaded'});
    // Resolve the first bootstrap identity check, then hold the remaining
    // scheduled retries until after the denial. Advancing the virtual clock
    // later reproduces hosted run 35498175187 without depending on wall time.
    await page.clock.fastForward(200);
    await expect.poll(()=>authChecks).toBe(1);
    await expect.poll(()=>page.evaluate(()=>(window as any)._randori_auth.me?.email)).toBe(owner.email);
    await expect(page.locator('#view-dashboard')).toBeVisible();
    await page.locator('[data-tab="circle"]').click();
    const input=page.getByTestId('circle-member-search');
    await expect(input).toBeVisible();
    await input.fill('slow-denied');
    await input.press('Enter');
    await deniedRequestStarted;
    await input.fill('newer-success');
    await input.press('Enter');
    await expect(page.getByText('Newer Result',{exact:true})).toBeVisible();

    const deniedResponse=page.waitForResponse(response=>{
      const url=new URL(response.url());
      return url.pathname==='/api/members'&&url.searchParams.get('q')==='slow-denied';
    });
    releaseDeniedRequest();
    await deniedResponse;
    await expect(page.locator('[data-testid="circle-member-row"]')).toHaveCount(0);
    await expect(page.getByTestId('circle-member-search-form')).toBeHidden();
    await expect(page.getByText('Newer Result',{exact:true})).toHaveCount(0);
    await page.clock.fastForward(1_100);
    expect(authChecks).toBe(1);
    await expect(page.locator('[data-testid="circle-member-row"]')).toHaveCount(0);
    await expect(page.getByTestId('circle-member-search-form')).toBeHidden();
  });
}

test('identity bootstrap retries a transient failure and stops after the first authoritative result',async({page})=>{
  let authChecks=0;
  await mockApi(page,{
    '/api/auth/me':()=>{
      authChecks+=1;
      return authChecks===1
        ?{_status:503,ok:false,error:'authentication temporarily unavailable'}
        :{ok:true,user:owner};
    },
    '/api/profile':{ok:true,user:owner},
    '/api/circle':{
      ok:true,circle_meta:{id:10,public_id:'circle_e2e',name:'E2E Circle'},
      membership:{role:'owner'},circle:[owner],count:1,
    },
    '/api/invitations':{ok:true,invitations:[],count:0},
    '/api/members':{ok:true,members:[{...owner,role:'owner',status:'active'}],count:1,
      has_more:false,next_cursor:null,scanned:1},
  });
  await page.clock.install();
  await resetClientState(page,true);
  await page.goto('/',{waitUntil:'domcontentloaded'});

  await page.clock.fastForward(200);
  await expect.poll(()=>authChecks).toBe(1);
  await expect.poll(()=>page.evaluate(()=>(window as any)._randori_auth.me)).toBeNull();

  await page.clock.fastForward(250);
  await expect.poll(()=>authChecks).toBe(2);
  await expect.poll(()=>page.evaluate(()=>(window as any)._randori_auth.me?.email)).toBe(owner.email);

  await page.clock.fastForward(1_000);
  expect(authChecks).toBe(2);
});

test('a delayed denial from a different actor cannot clear the current owner roster',async({page})=>{
  const nextOwner={...owner,id:9,email:'next-owner@example.test',display_name:'Next Owner',name:'Next Owner'};
  let currentUser=owner;
  let markDeniedRequestStarted!:()=>void;
  let releaseDeniedRequest!:()=>void;
  const deniedRequestStarted=new Promise<void>(resolve=>{ markDeniedRequestStarted=resolve; });
  const deniedRequestRelease=new Promise<void>(resolve=>{ releaseDeniedRequest=resolve; });
  await mockApi(page,{
    '/api/auth/me':()=>({ok:true,user:currentUser}),
    '/api/profile':()=>({ok:true,user:currentUser}),
    '/api/circle':()=>({
      ok:true,circle_meta:{id:10,public_id:'circle_e2e',name:'E2E Circle'},
      membership:{role:'owner'},circle:[currentUser],count:1,
    }),
    '/api/invitations':{ok:true,invitations:[],count:0},
    '/api/members':async request=>{
      const q=new URL(request.url()).searchParams.get('q')||'';
      if(q==='slow-denied'){
        markDeniedRequestStarted();
        await deniedRequestRelease;
        return {_status:403,error:'opaque access failure'};
      }
      const result=[{...currentUser,role:'owner',status:'active'}];
      return {ok:true,members:result,count:1,has_more:false,next_cursor:null,scanned:1};
    },
  });
  await resetClientState(page,true);
  await page.goto('/',{waitUntil:'domcontentloaded'});
  await expect(page.locator('#view-dashboard')).toBeVisible();
  await page.locator('[data-tab="circle"]').click();
  const input=page.getByTestId('circle-member-search');
  await expect(input).toBeVisible();
  await input.fill('slow-denied');
  await input.press('Enter');
  await deniedRequestStarted;

  currentUser=nextOwner;
  await page.evaluate(async()=>{ await (window as any)._randori_auth.refreshMe(); });
  await page.locator('[data-tab="circle"]').click();
  await expect(page.getByText('Next Owner',{exact:true}).last()).toBeVisible();
  const deniedResponse=page.waitForResponse(response=>{
    const url=new URL(response.url());
    return url.pathname==='/api/members'&&url.searchParams.get('q')==='slow-denied';
  });
  releaseDeniedRequest();
  await deniedResponse;
  await expect(page.getByText('Next Owner',{exact:true}).last()).toBeVisible();
  await expect(page.locator('[data-testid="circle-member-row"]')).toHaveCount(1);
  await expect(page.getByTestId('circle-member-search-form')).toBeVisible();
});

test('a delayed denial from a superseded circle context cannot clear the selected owner roster',async({page})=>{
  let active:'circle-primary'|'circle-secondary'='circle-primary';
  let contextVersion=1;
  let markDeniedRequestStarted!:()=>void;
  let releaseDeniedRequest!:()=>void;
  const deniedRequestStarted=new Promise<void>(resolve=>{ markDeniedRequestStarted=resolve; });
  const deniedRequestRelease=new Promise<void>(resolve=>{ releaseDeniedRequest=resolve; });
  let markSwitchStarted!:()=>void;
  let releaseSwitch!:()=>void;
  const switchStarted=new Promise<void>(resolve=>{ markSwitchStarted=resolve; });
  const switchRelease=new Promise<void>(resolve=>{ releaseSwitch=resolve; });
  const circles=[
    {id:10,public_id:'circle-primary',name:'Primary',role:'owner',is_primary:true},
    {id:20,public_id:'circle-secondary',name:'Secondary',role:'owner',is_primary:false},
  ];
  await mockApi(page,{
    '/api/auth/capabilities':{
      ok:true,
      capabilities:{passwordLogin:true,passwordSignup:false,googleOAuth:true,multiCircleControlPlane:true},
      registrationMode:'private_beta',
    },
    '/api/auth/me':{ok:true,user:owner},
    '/api/profile':{ok:true,user:owner},
    '/api/circles':async request=>{
      if(request.method()==='PUT'){
        markSwitchStarted();
        await switchRelease;
        active='circle-secondary';
        contextVersion=2;
      }
      return {ok:true,circles,active_circle:circles.find(circle=>circle.public_id===active),
        context_version:contextVersion,selection_required:false};
    },
    '/api/circle':()=>({
      ok:true,circle_meta:{id:active==='circle-primary'?10:20,public_id:active,name:active},
      membership:{role:'owner'},circle:[owner],count:1,circle_context_version:contextVersion,
    }),
    '/api/invitations':()=>({ok:true,invitations:[],count:0,circle_context_version:contextVersion}),
    '/api/members':async request=>{
      const q=new URL(request.url()).searchParams.get('q')||'';
      if(q==='slow-denied'){
        markDeniedRequestStarted();
        await deniedRequestRelease;
        return {_status:403,error:'opaque access failure'};
      }
      const display_name=active==='circle-primary'?'Primary Owner':'Secondary Owner';
      return {ok:true,members:[{...owner,display_name,role:'owner',status:'active'}],count:1,
        has_more:false,next_cursor:null,scanned:1,circle_context_version:contextVersion};
    },
  });
  try{
    await resetClientState(page,true,{},true);
    await page.goto('/',{waitUntil:'domcontentloaded'});
    await expect(page.locator('#view-dashboard')).toBeVisible();
    await page.locator('[data-tab="circle"]').click();
    await expect(page.getByText('Primary Owner',{exact:true})).toBeVisible();
    const search=page.getByTestId('circle-member-search');
    await search.fill('slow-denied');
    await search.press('Enter');
    await deniedRequestStarted;

    const selecting=page.getByTestId('circle-context-select').selectOption('circle-secondary');
    await switchStarted;
    // The switch has already performed its own synchronous teardown. Count
    // any later roster reset so this test proves the stale catch is inert,
    // rather than merely observing an already-hidden panel before reload.
    await page.evaluate(()=>{
      const roster=document.getElementById('circleManageMembers') as any;
      const original=roster.replaceChildren.bind(roster);
      (window as any).__staleRosterResetCalls=0;
      roster.replaceChildren=(...nodes:any[])=>{
        (window as any).__staleRosterResetCalls+=1;
        return original(...nodes);
      };
    });
    const deniedResponse=page.waitForResponse(response=>{
      const url=new URL(response.url());
      return url.pathname==='/api/members'&&url.searchParams.get('q')==='slow-denied';
    });
    releaseDeniedRequest();
    const completedDenial=await deniedResponse;
    await completedDenial.finished();
    await page.evaluate(()=>new Promise<void>(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>resolve()))));
    expect(await page.evaluate(()=>(window as any).__staleRosterResetCalls)).toBe(0);
    await expect(page.getByTestId('circle-lifecycle')).toBeHidden();

    const reloaded=page.waitForEvent('domcontentloaded');
    releaseSwitch();
    await selecting;
    await reloaded;
    await page.locator('[data-tab="circle"]').click();
    await expect(page.getByText('Secondary Owner',{exact:true})).toBeVisible();
    await expect(page.getByTestId('circle-member-search-form')).toBeVisible();
  }finally{
    releaseDeniedRequest();
    releaseSwitch();
  }
});

test('a revoked owner loses retained roster controls on an opaque 403 response',async({page})=>{
  let revoked=false;
  await mockApi(page,{
    '/api/auth/me':{ok:true,user:owner},
    '/api/profile':{ok:true,user:owner},
    '/api/circle':()=>({
      ok:true,circle_meta:{id:10,public_id:'circle_e2e',name:'E2E Circle'},
      membership:{role:revoked?'member':'owner'},circle:[owner,member],count:2,
    }),
    '/api/invitations':{ok:true,invitations:[],count:0},
    '/api/members':request=>{
      if(new URL(request.url()).searchParams.has('cursor')){
        revoked=true;
        return {_status:403,error:'access state changed'};
      }
      return {ok:true,members:[{...owner,role:'owner',status:'active'}],count:1,has_more:true,next_cursor:'next-page',scanned:2};
    },
  });
  await resetClientState(page,true);
  await page.goto('/',{waitUntil:'domcontentloaded'});
  await expect(page.locator('#view-dashboard')).toBeVisible();
  await page.locator('[data-tab="circle"]').click();
  await expect(page.getByTestId('circle-members-load-more')).toBeEnabled();
  await page.getByTestId('circle-members-load-more').click();
  await expect(page.locator('#circleRoleLabel')).toHaveText('member');
  await expect(page.getByTestId('circle-manage-members')).toBeHidden();
  await expect(page.locator('[data-testid="circle-member-row"]')).toHaveCount(0);
  await expect(page.getByTestId('circle-member-search-form')).toBeHidden();
});

test('an expired session clears retained search results on an opaque 401 response',async({page})=>{
  let expired=false;
  await mockApi(page,{
    '/api/auth/me':{ok:true,user:owner},
    '/api/profile':{ok:true,user:owner},
    '/api/circle':()=>expired?{_status:401,error:'authentication required'}:{
      ok:true,circle_meta:{id:10,public_id:'circle_e2e',name:'E2E Circle'},
      membership:{role:'owner'},circle:[owner],count:1,
    },
    '/api/invitations':{ok:true,invitations:[],count:0},
    '/api/members':request=>{
      const q=new URL(request.url()).searchParams.get('q')||'';
      if(q){ expired=true; return {_status:401,error:'session no longer valid'}; }
      return {ok:true,members:[{...owner,role:'owner',status:'active'}],count:1,has_more:false,next_cursor:null,scanned:1};
    },
  });
  await resetClientState(page,true);
  await page.goto('/',{waitUntil:'domcontentloaded'});
  await expect(page.locator('#view-dashboard')).toBeVisible();
  await page.locator('[data-tab="circle"]').click();
  const search=page.getByTestId('circle-member-search');
  await expect(search).toBeVisible();
  await search.fill('owner');
  await search.press('Enter');
  await expect(page.getByTestId('circle-lifecycle')).toBeHidden();
  await expect(page.locator('[data-testid="circle-member-row"]')).toHaveCount(0);
  await expect(page.getByTestId('circle-member-search-form')).toBeHidden();
});

test('an auth refresh restarts a delayed initial roster without a stuck loader',async({page})=>{
  let calls=0;
  let markFirstRequestStarted!:()=>void;
  let markSecondRequestStarted!:()=>void;
  let releaseFirstRequest!:()=>void;
  const firstRequestStarted=new Promise<void>(resolve=>{ markFirstRequestStarted=resolve; });
  const secondRequestStarted=new Promise<void>(resolve=>{ markSecondRequestStarted=resolve; });
  const firstRequestRelease=new Promise<void>(resolve=>{ releaseFirstRequest=resolve; });
  await mockApi(page,{
    '/api/auth/me':{ok:true,user:owner},
    '/api/profile':{ok:true,user:owner},
    '/api/circle':{
      ok:true,circle_meta:{id:10,public_id:'circle_e2e',name:'E2E Circle'},
      membership:{role:'owner'},circle:[owner],count:1,
    },
    '/api/invitations':{ok:true,invitations:[],count:0},
    '/api/members':async()=>{
      calls+=1;
      if(calls===1){
        markFirstRequestStarted();
        await firstRequestRelease;
        return {ok:true,members:[{...owner,display_name:'Stale Initial',role:'owner',status:'active'}],count:1,has_more:false,next_cursor:null,scanned:1};
      }
      markSecondRequestStarted();
      return {ok:true,members:[{...owner,display_name:'Fresh Restart',role:'owner',status:'active'}],count:1,has_more:false,next_cursor:null,scanned:1};
    },
  });
  await resetClientState(page,true);
  await page.goto('/',{waitUntil:'domcontentloaded'});
  await firstRequestStarted;
  await page.evaluate(()=>window.dispatchEvent(new Event('randori:auth-refreshed')));
  await secondRequestStarted;
  expect(calls).toBeGreaterThanOrEqual(2);
  await page.locator('[data-tab="circle"]').click();
  await expect(page.getByText('Fresh Restart',{exact:true})).toBeVisible();
  await expect(page.getByTestId('circle-manage-members')).toHaveAttribute('aria-busy','false');
  const staleResponse=page.waitForResponse(response=>new URL(response.url()).pathname==='/api/members');
  releaseFirstRequest();
  await staleResponse;
  await expect(page.getByText('Fresh Restart',{exact:true})).toBeVisible();
  await expect(page.getByText('Stale Initial',{exact:true})).toHaveCount(0);
});
