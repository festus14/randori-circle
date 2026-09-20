import { expect, Page, Request, test } from '@playwright/test';

import { mockApi, resetClientState } from './helpers';

const owner={
  id:1,email:'owner@example.test',name:'Circle Owner',display_name:'Circle Owner',
  color:'#c8f6a0',is_admin:false,is_available:true,tz:'Europe/London',interview_focus:'both',
};
const primary={public_id:'circle-primary',name:'Primary',role:'owner',is_primary:true};
const secondary={public_id:'circle-secondary',name:'Secondary',role:'owner',is_primary:false};

async function confirmAction(page:Page,title:RegExp){
  await expect(page.locator('#confirmTitle')).toHaveText(title);
  await page.locator('#confirmOk').click();
}

test('a secondary owner step-ups, archives, and lands on the deterministic fallback',async({page})=>{
  let archived=false;
  let recent=false;
  const deletes:{body:Record<string,unknown>;context:string|undefined}[]=[];
  await mockApi(page,{
    '/api/auth/capabilities':{
      ok:true,capabilities:{passwordLogin:true,passwordSignup:false,googleOAuth:true,
        multiCircleControlPlane:true,multiCircleAvailability:true,secondaryCircleCoordination:true},
      registrationMode:'private_beta',
    },
    '/api/auth/me':{ok:true,user:owner},
    '/api/profile':{ok:true,user:owner},
    '/api/auth/recent-auth':request=>{
      if(request.method()==='GET'){
        return {ok:true,recentAuth:{ok:recent},methods:{password:true,google:false}};
      }
      expect(request.method()).toBe('POST');
      expect(request.postDataJSON()).toEqual({password:'owner password'});
      recent=true;
      return {ok:true,recentAuth:{ok:true,method:'password'}};
    },
    '/api/circles':(request:Request)=>{
      if(request.method()==='DELETE'){
        deletes.push({
          body:request.postDataJSON(),
          context:request.headers()['x-randori-circle-context-version'],
        });
        if(!recent) return {_status:403,error:'recent authentication required',code:'recent_auth_required'};
        archived=true;
        return {ok:true,circles:[primary],active_circle:primary,context_version:5,
          selection_required:false,archived_circle_public_id:secondary.public_id,archived:true};
      }
      return archived
        ?{ok:true,circles:[primary],active_circle:primary,context_version:5,selection_required:false}
        :{ok:true,circles:[primary,secondary],active_circle:secondary,context_version:4,selection_required:false};
    },
    '/api/circle':()=>({
      ok:true,circle_meta:{public_id:archived?primary.public_id:secondary.public_id,
        name:archived?primary.name:secondary.name},
      membership:{role:'owner'},circle:[owner],count:1,circle_context_version:archived?5:4,
    }),
    '/api/invitations':()=>({ok:true,invitations:[],count:0,circle_context_version:archived?5:4}),
    '/api/members':()=>({ok:true,members:[{...owner,role:'owner',status:'active'}],count:1,
      has_more:false,next_cursor:null,scanned:1,circle_context_version:archived?5:4}),
    '/api/settings/availability':()=>({ok:true,availability:{cycle:{
      cycleId:'2099-W39',startsAt:'2099-09-20T07:00:00.000Z',endsAt:'2099-09-27T07:00:00.000Z',
      cutoffAt:'2099-09-20T07:00:00.000Z',timeZone:'Europe/London',state:'upcoming',
    },cycleKey:'a'.repeat(64),isAvailable:true,version:0,source:'cycle_default',editable:true,
    updatedAt:null},circle_context_version:archived?5:4}),
    '/api/my-pair':()=>({ok:true,paired:false,reason:'no_week_yet',pairing_status:'unpublished',
      coordination_only:!archived,workspace_available:archived,
      circle_public_id:archived?primary.public_id:secondary.public_id,
      circle_context_version:archived?5:4}),
  });
  await resetClientState(page,true,{},true);
  await page.goto('/?view=circle',{waitUntil:'domcontentloaded'});
  await page.locator('[data-tab="circle"]').click();
  await expect(page.getByTestId('circle-context-select')).toHaveValue(secondary.public_id);
  const archive=page.getByTestId('circle-archive');
  await expect(archive).toBeVisible();
  await archive.click();
  await confirmAction(page,/Archive Secondary/);
  await expect(page.getByRole('dialog',{name:'Confirm this sensitive change'})).toBeVisible();
  expect(deletes).toEqual([{
    body:{circle_public_id:secondary.public_id,expected_context_version:4},context:'4',
  }]);
  expect(await page.evaluate(()=>JSON.parse(sessionStorage.getItem('randori-lifecycle-recent-action-v1')||'null')))
    .toMatchObject({v:1,action:'archive',actor_id:1,circle_public_id:secondary.public_id,context_version:4});

  const reloaded=page.waitForEvent('domcontentloaded');
  await page.locator('#identityPasswordConfirm').fill('owner password');
  await page.getByRole('button',{name:'Confirm password'}).click();
  await reloaded;
  await page.locator('[data-tab="circle"]').click();
  await expect(page.getByTestId('circle-context-select')).toHaveValue(primary.public_id);
  await expect(page.getByTestId('circle-context-select').locator('option')).toHaveCount(1);
  await expect(page.getByTestId('circle-archive')).toBeHidden();
  expect(deletes).toEqual([
    {body:{circle_public_id:secondary.public_id,expected_context_version:4},context:'4'},
    {body:{circle_public_id:secondary.public_id,expected_context_version:4},context:'4'},
  ]);
  expect(await page.evaluate(()=>sessionStorage.getItem('randori-lifecycle-recent-action-v1'))).toBeNull();
});

test('archive control is never offered to a member or for the primary circle',async({page})=>{
  let role:'owner'|'member'='owner';
  let active=primary;
  await mockApi(page,{
    '/api/auth/capabilities':{
      ok:true,capabilities:{passwordLogin:true,passwordSignup:false,googleOAuth:true,
        multiCircleControlPlane:true,multiCircleAvailability:true},registrationMode:'private_beta',
    },
    '/api/auth/me':{ok:true,user:owner},
    '/api/profile':{ok:true,user:owner},
    '/api/circles':()=>({ok:true,circles:[primary,secondary],active_circle:{...active,role},
      context_version:4,selection_required:false}),
    '/api/circle':()=>({ok:true,circle_meta:{public_id:active.public_id,name:active.name},
      membership:{role},circle:[owner],count:1,circle_context_version:4}),
    '/api/invitations':{ok:true,invitations:[],count:0,circle_context_version:4},
    '/api/members':{ok:true,members:[{...owner,role:'owner',status:'active'}],count:1,
      has_more:false,next_cursor:null,scanned:1,circle_context_version:4},
  });
  await resetClientState(page,true);
  await page.goto('/?view=circle',{waitUntil:'domcontentloaded'});
  await page.locator('[data-tab="circle"]').click();
  await expect(page.getByTestId('circle-archive')).toBeHidden();

  role='member'; active=secondary;
  await page.reload({waitUntil:'domcontentloaded'});
  await page.locator('[data-tab="circle"]').click();
  await expect(page.getByTestId('circle-archive')).toBeHidden();
});

test('a known committed archive reloads even when fallback projection fails',async({page})=>{
  let archived=false;
  await mockApi(page,{
    '/api/auth/capabilities':{
      ok:true,capabilities:{passwordLogin:true,passwordSignup:false,googleOAuth:true,
        multiCircleControlPlane:true,multiCircleAvailability:true},registrationMode:'private_beta',
    },
    '/api/auth/me':{ok:true,user:owner},
    '/api/profile':{ok:true,user:owner},
    '/api/circles':request=>{
      if(request.method()==='DELETE'){
        archived=true;
        return {_status:503,error:'circle archived; reload required',
          code:'circle_archive_refresh_required',archived_circle_public_id:secondary.public_id,
          context_version:5};
      }
      return archived
        ?{ok:true,circles:[primary],active_circle:primary,context_version:5,selection_required:false}
        :{ok:true,circles:[primary,secondary],active_circle:secondary,context_version:4,selection_required:false};
    },
    '/api/circle':()=>({ok:true,circle_meta:{public_id:archived?primary.public_id:secondary.public_id,
      name:archived?primary.name:secondary.name},membership:{role:'owner'},circle:[owner],count:1,
      circle_context_version:archived?5:4}),
    '/api/invitations':()=>({ok:true,invitations:[],count:0,circle_context_version:archived?5:4}),
    '/api/members':()=>({ok:true,members:[{...owner,role:'owner',status:'active'}],count:1,
      has_more:false,next_cursor:null,scanned:1,circle_context_version:archived?5:4}),
  });
  await resetClientState(page,true);
  await page.goto('/?view=circle',{waitUntil:'domcontentloaded'});
  await page.locator('[data-tab="circle"]').click();
  const reloaded=page.waitForEvent('domcontentloaded');
  await page.getByTestId('circle-archive').click();
  await confirmAction(page,/Archive Secondary/);
  await reloaded;
  await page.locator('[data-tab="circle"]').click();
  await expect(page.getByTestId('circle-context-select')).toHaveValue(primary.public_id);
  await expect(page.getByTestId('circle-archive')).toBeHidden();
});

test('archive session loss immediately clears private state and returns to signed-out UI',async({page})=>{
  let sessionLive=true;
  await mockApi(page,{
    '/api/auth/capabilities':{
      ok:true,capabilities:{passwordLogin:true,passwordSignup:false,googleOAuth:true,
        multiCircleControlPlane:true,multiCircleAvailability:true},registrationMode:'private_beta',
    },
    '/api/auth/me':()=>sessionLive?{ok:true,user:owner}:{_status:401,error:'authentication required'},
    '/api/profile':{ok:true,user:owner},
    '/api/circles':request=>{
      if(request.method()==='DELETE'){
        sessionLive=false;
        return {_status:401,error:'authentication required'};
      }
      return {ok:true,circles:[primary,secondary],active_circle:secondary,
        context_version:4,selection_required:false};
    },
    '/api/circle':{ok:true,circle_meta:{public_id:secondary.public_id,name:secondary.name},
      membership:{role:'owner'},circle:[owner],count:1,circle_context_version:4},
    '/api/invitations':{ok:true,invitations:[],count:0,circle_context_version:4},
    '/api/members':{ok:true,members:[{...owner,role:'owner',status:'active'}],count:1,
      has_more:false,next_cursor:null,scanned:1,circle_context_version:4},
  });
  await resetClientState(page,true);
  await page.goto('/?view=circle',{waitUntil:'domcontentloaded'});
  await page.locator('[data-tab="circle"]').click();
  await expect(page.getByTestId('circle-archive')).toBeVisible();
  await page.evaluate(()=>{
    const app=window as any;
    app._randori_authorized_room='week_1_pair_1';
    app.__archiveRefreshCalls=0;
    app._randori_auth.refreshMe=async()=>{ app.__archiveRefreshCalls+=1; throw new Error('unexpected refresh'); };
    localStorage.setItem('randori-token','legacy-token');
    localStorage.setItem('randori-demo-active','1');
    localStorage.setItem('randori-last-room','week_1_pair_1');
    localStorage.setItem('randori-last-tab','code');
    localStorage.setItem('randori-last-view','code');
    localStorage.setItem('randori-code','private draft');
  });
  await page.getByTestId('circle-archive').click();
  await confirmAction(page,/Archive Secondary/);
  await expect(page.locator('#view-landing')).toBeVisible();
  await expect(page.getByTestId('circle-lifecycle')).toBeHidden();
  await expect(page.getByTestId('circle-archive')).toBeHidden();
  expect(await page.evaluate(()=>({signedIn:(window as any)._randori_auth.signedIn,
    room:(window as any)._randori_authorized_room,
    refreshCalls:(window as any).__archiveRefreshCalls,
    retained:['randori-token','randori-me','randori-demo-active','randori-last-room',
      'randori-last-tab','randori-last-view','randori-code'].filter(key=>localStorage.getItem(key)!==null)})))
    .toEqual({signedIn:false,room:null,refreshCalls:0,retained:[]});
});

test('archive owner loss reloads and re-resolves the selected membership role',async({page})=>{
  let ownerAccess=true;
  await mockApi(page,{
    '/api/auth/capabilities':{
      ok:true,capabilities:{passwordLogin:true,passwordSignup:false,googleOAuth:true,
        multiCircleControlPlane:true,multiCircleAvailability:true},registrationMode:'private_beta',
    },
    '/api/auth/me':{ok:true,user:owner},
    '/api/profile':{ok:true,user:owner},
    '/api/circles':request=>{
      if(request.method()==='DELETE'){
        ownerAccess=false;
        return {_status:404,error:'circle unavailable'};
      }
      return {ok:true,circles:[primary,{...secondary,role:ownerAccess?'owner':'member'}],
        active_circle:{...secondary,role:ownerAccess?'owner':'member'},context_version:4,
        selection_required:false};
    },
    '/api/circle':()=>({ok:true,circle_meta:{public_id:secondary.public_id,name:secondary.name},
      membership:{role:ownerAccess?'owner':'member'},circle:[owner],count:1,circle_context_version:4}),
    '/api/invitations':()=>ownerAccess
      ?{ok:true,invitations:[],count:0,circle_context_version:4}
      :{_status:403,error:'owner access required'},
    '/api/members':{ok:true,members:[{...owner,role:'member',status:'active'}],count:1,
      has_more:false,next_cursor:null,scanned:1,circle_context_version:4},
  });
  await resetClientState(page,true);
  await page.goto('/?view=circle',{waitUntil:'domcontentloaded'});
  await page.locator('[data-tab="circle"]').click();
  await expect(page.getByTestId('circle-archive')).toBeVisible();
  const reloaded=page.waitForEvent('domcontentloaded');
  await page.getByTestId('circle-archive').click();
  await confirmAction(page,/Archive Secondary/);
  await reloaded;
  await page.locator('[data-tab="circle"]').click();
  await expect(page.locator('#circleRoleLabel')).toHaveText('member');
  await expect(page.getByTestId('circle-archive')).toBeHidden();
});

for(const failure of ['ambiguous response','transport loss'] as const){
  test(`archive ${failure} clears stale state and reloads the authoritative context`,async({page})=>{
    let archived=false;
    await mockApi(page,{
      '/api/auth/capabilities':{
        ok:true,capabilities:{passwordLogin:true,passwordSignup:false,googleOAuth:true,
          multiCircleControlPlane:true,multiCircleAvailability:true},registrationMode:'private_beta',
      },
      '/api/auth/me':{ok:true,user:owner},
      '/api/profile':{ok:true,user:owner},
      '/api/circles':request=>{
        if(request.method()==='DELETE'){
          archived=true;
          return {_status:503,error:'circle archive status unknown; retry the same archive request',
            code:'circle_archive_status_unknown'};
        }
        return archived
          ?{ok:true,circles:[primary],active_circle:primary,context_version:5,selection_required:false}
          :{ok:true,circles:[primary,secondary],active_circle:secondary,
            context_version:4,selection_required:false};
      },
      '/api/circle':()=>({ok:true,circle_meta:{public_id:archived?primary.public_id:secondary.public_id,
        name:archived?primary.name:secondary.name},membership:{role:'owner'},circle:[owner],count:1,
        circle_context_version:archived?5:4}),
      '/api/invitations':()=>({ok:true,invitations:[],count:0,circle_context_version:archived?5:4}),
      '/api/members':()=>({ok:true,members:[{...owner,role:'owner',status:'active'}],count:1,
        has_more:false,next_cursor:null,scanned:1,circle_context_version:archived?5:4}),
    });
    if(failure==='transport loss'){
      await page.route('**/api/circles',async route=>{
        if(route.request().method()==='DELETE'){
          archived=true;
          await route.abort('connectionreset');
          return;
        }
        await route.fallback();
      });
    }
    await resetClientState(page,true);
    await page.goto('/?view=circle',{waitUntil:'domcontentloaded'});
    await page.locator('[data-tab="circle"]').click();
    await expect(page.getByTestId('circle-archive')).toBeVisible();
    const reloaded=page.waitForEvent('domcontentloaded');
    await page.getByTestId('circle-archive').click();
    await confirmAction(page,/Archive Secondary/);
    await reloaded;
    await page.locator('[data-tab="circle"]').click();
    await expect(page.getByTestId('circle-context-select')).toHaveValue(primary.public_id);
    await expect(page.getByTestId('circle-archive')).toBeHidden();
  });
}
