import { expect, Request, Route, test } from '@playwright/test';

import { mockApi, resetClientState } from './helpers';

const user={
  id:1,email:'owner@example.test',name:'Circle Owner',display_name:'Circle Owner',
  color:'#c8f6a0',is_admin:false,is_available:true,tz:'Europe/London',interview_focus:'both',
};
const primary={public_id:'circle-primary',name:'Primary',role:'owner',is_primary:true};
const secondary={public_id:'circle-created',name:'Saturday Practice',role:'owner',is_primary:false};
const cycle={
  cycleId:'2099-W39',startsAt:'2099-09-20T07:00:00.000Z',endsAt:'2099-09-27T07:00:00.000Z',
  cutoffAt:'2099-09-20T07:00:00.000Z',timeZone:'Europe/London',state:'upcoming',
};
const currentCycle={
  cycleId:'2026-W38',startsAt:'2026-09-13T07:00:00.000Z',endsAt:'2099-09-20T07:00:00.000Z',
  cutoffAt:'2026-09-13T07:00:00.000Z',timeZone:'Europe/London',state:'current',
};

function capabilities(){
  return {ok:true,capabilities:{passwordLogin:true,passwordSignup:false,googleOAuth:true,
    multiCircleControlPlane:true,multiCircleAvailability:true,secondaryCircleCoordination:true},
  registrationMode:'private_beta'};
}

function availability(){
  return {cycle,cycleKey:'a'.repeat(64),isAvailable:true,version:0,
    source:'cycle_default',editable:true,updatedAt:null};
}

test('sole-primary owner can keyboard-create and immediately use an empty selected circle at 320px',async({page})=>{
  await page.setViewportSize({width:320,height:720});
  let created=false;
  let postBody:Record<string,unknown>|null=null;
  await mockApi(page,{
    '/api/auth/capabilities':capabilities(),
    '/api/auth/me':{ok:true,user},
    '/api/profile':{ok:true,user:{...user,bio:'',leetcode_handle:''}},
    '/api/circles':(request:Request)=>{
      if(request.method()==='POST'){
        postBody=request.postDataJSON(); created=true;
        return {_status:201,ok:true,circle:secondary,context_version:8};
      }
      return created
        ?{ok:true,circles:[primary,secondary],active_circle:secondary,context_version:8,selection_required:false}
        :{ok:true,circles:[primary],active_circle:primary,context_version:7,selection_required:false};
    },
    '/api/circle':()=>created
      ?{ok:true,circle_meta:{public_id:secondary.public_id,name:secondary.name},membership:{role:'owner'},
        circle:[user],count:1,circle_context_version:8}
      :{ok:true,circle_meta:{public_id:primary.public_id,name:primary.name},membership:{role:'owner'},
        circle:[user],count:1,circle_context_version:7},
    '/api/invitations':()=>({ok:true,invitations:[],count:0,circle_context_version:created?8:7}),
    '/api/settings/availability':()=>({ok:true,availability:availability(),circle_context_version:created?8:7}),
    '/api/my-pair':()=>({ok:true,paired:false,reason:'no_week_yet',pairing_status:'unpublished',
      coordination_only:created,workspace_available:!created,circle_public_id:created?secondary.public_id:primary.public_id,
      circle_context_version:created?8:7,current_cycle:currentCycle,cycle:currentCycle}),
    '/api/weeks':()=>({ok:true,weeks:[],coordination_only:created,workspace_available:!created,
      circle_public_id:created?secondary.public_id:primary.public_id,circle_context_version:created?8:7,
      current_cycle:currentCycle,current_week_id:null}),
  });
  await resetClientState(page,true,{},true);
  await page.goto('/?view=circle',{waitUntil:'domcontentloaded'});
  await page.locator('[data-tab="circle"]').click();
  const form=page.getByTestId('circle-create-form');
  await expect(form).toBeVisible();
  await expect(page.getByTestId('circle-context-select')).toHaveValue(primary.public_id);
  await page.getByTestId('circle-create-name').focus();
  await page.keyboard.type(secondary.name);
  await page.keyboard.press('Tab');
  await expect(page.getByTestId('circle-create-submit')).toBeFocused();
  const navigated=page.waitForEvent('framenavigated',frame=>frame===page.mainFrame());
  await page.keyboard.press('Enter');
  await expect.poll(()=>created).toBe(true);
  expect(postBody).toEqual({name:secondary.name,request_id:expect.stringMatching(/^[A-Za-z0-9_-]{16,128}$/)});
  await navigated;
  await page.locator('[data-tab="circle"]').click();
  await expect(page.getByTestId('circle-context-select')).toHaveValue(secondary.public_id);
  await expect(page.getByTestId('circle-members')).toContainText(user.name);
  await expect(page.locator('#peopleCount')).toHaveText('1');
  await page.locator('[data-tab="pair"]').click();
  await expect(page.getByTestId('availability-card')).toBeVisible();
  await expect(page.locator('#availLabel')).toHaveText('ON (included)');
  await expect.poll(()=>page.evaluate(()=>(window as typeof window&{
    _randori_availability?:{current?:{source?:string;version?:number}},
  })._randori_availability?.current)).toMatchObject({source:'cycle_default',version:0});
  await expect(page.locator('#pairsList')).toContainText('No pairings have been published');
  const dimensions=await page.evaluate(()=>({scrollWidth:document.documentElement.scrollWidth,innerWidth}));
  expect(dimensions.scrollWidth).toBeLessThanOrEqual(dimensions.innerWidth);
});

test('retry keeps one opaque request id and terminal validation never sends',async({page})=>{
  const requestIds:string[]=[];
  let posts=0;
  let created=false;
  await mockApi(page,{
    '/api/auth/capabilities':capabilities(),
    '/api/auth/me':{ok:true,user},
    '/api/profile':{ok:true,user},
    '/api/circles':(request:Request)=>{
      if(request.method()==='POST'){
        posts+=1;
        requestIds.push(String(request.postDataJSON().request_id));
        if(posts===1) return {_status:503,error:'circle creation status unknown',code:'circle_creation_status_unknown'};
        created=true;
        return {ok:true,circle:secondary,context_version:8};
      }
      return created
        ?{ok:true,circles:[primary,secondary],active_circle:secondary,context_version:8,selection_required:false}
        :{ok:true,circles:[primary],active_circle:primary,context_version:7,selection_required:false};
    },
    '/api/circle':()=>({ok:true,circle_meta:{public_id:created?secondary.public_id:primary.public_id,
      name:created?secondary.name:primary.name},membership:{role:'owner'},circle:[user],count:1,
      circle_context_version:created?8:7}),
    '/api/invitations':()=>({ok:true,invitations:[],count:0,circle_context_version:created?8:7}),
    '/api/settings/availability':()=>({ok:true,availability:availability(),circle_context_version:created?8:7}),
    '/api/my-pair':()=>({ok:true,paired:false,reason:'no_week_yet',current_cycle:currentCycle,cycle:currentCycle,
      circle_public_id:created?secondary.public_id:primary.public_id,circle_context_version:created?8:7}),
  });
  await resetClientState(page,true,{},true);
  await page.goto('/?view=circle',{waitUntil:'domcontentloaded'});
  await page.locator('[data-tab="circle"]').click();
  const input=page.getByTestId('circle-create-name');
  await input.fill(' Saturday Practice');
  await page.getByTestId('circle-create-submit').click();
  await expect(page.getByTestId('circle-create-status')).toContainText('Use 1-80');
  expect(posts).toBe(0);
  await input.fill(secondary.name);
  await page.getByTestId('circle-create-submit').click();
  await expect(page.getByTestId('circle-create-status')).toContainText('Retry to safely reuse');
  await page.getByTestId('circle-create-submit').click();
  await expect.poll(()=>posts).toBe(2);
  expect(requestIds[0]).toBe(requestIds[1]);
});

test('a cross-tab context change aborts and fences an in-flight creation response',async({page})=>{
  let pending:Route|null=null;
  let notify:()=>void=()=>{};
  const started=new Promise<void>(resolve=>{ notify=resolve; });
  await mockApi(page,{
    '/api/auth/capabilities':capabilities(),
    '/api/auth/me':{ok:true,user},
    '/api/profile':{ok:true,user},
    '/api/circles':(request:Request)=>request.method()==='GET'
      ?{ok:true,circles:[primary],active_circle:primary,context_version:7,selection_required:false}
      :{_status:503,error:'unexpected fallback'},
    '/api/circle':{ok:true,circle_meta:{public_id:primary.public_id,name:primary.name},
      membership:{role:'owner'},circle:[user],count:1,circle_context_version:7},
    '/api/invitations':{ok:true,invitations:[],count:0,circle_context_version:7},
    '/api/settings/availability':{ok:true,availability:availability(),circle_context_version:7},
  });
  await page.route('**/api/circles',async route=>{
    if(route.request().method()!=='POST') return route.fallback();
    pending=route; notify();
  });
  await resetClientState(page,true,{},true);
  await page.goto('/?view=circle',{waitUntil:'domcontentloaded'});
  await page.locator('[data-tab="circle"]').click();
  await page.getByTestId('circle-create-name').fill(secondary.name);
  await page.getByTestId('circle-create-submit').click();
  await started;
  await page.evaluate(()=>{
    const channel=new BroadcastChannel('randori-circle-context-v1');
    channel.postMessage({v:1,user_id:1,context_version:9});
    channel.close();
  });
  await pending?.fulfill({status:201,contentType:'application/json',body:JSON.stringify({
    ok:true,circle:secondary,context_version:8,
  })}).catch(()=>{});
  await expect(page.getByTestId('circle-create-status')).not.toContainText('was created');
});
