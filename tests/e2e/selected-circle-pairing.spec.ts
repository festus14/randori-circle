import { expect, Request, Route, test } from '@playwright/test';

import { mockApi, resetClientState } from './helpers';

const user={
  id:1,email:'owner@example.test',name:'Circle Owner',display_name:'Circle Owner',
  color:'#c8f6a0',is_admin:true,is_available:true,tz:'Europe/London',interview_focus:'both',
};

const currentCycle={
  cycleId:'2026-W38',startsAt:'2026-09-13T07:00:00.000Z',endsAt:'2099-09-20T07:00:00.000Z',
  cutoffAt:'2026-09-13T07:00:00.000Z',timeZone:'Europe/London',state:'current',
};

const upcomingCycle={
  cycleId:'2099-W39',startsAt:'2099-09-20T07:00:00.000Z',endsAt:'2099-09-27T07:00:00.000Z',
  cutoffAt:'2099-09-20T07:00:00.000Z',timeZone:'Europe/London',state:'upcoming',
};

const circles=[
  {public_id:'circle-primary',name:'Primary',role:'owner',is_primary:true},
  {public_id:'circle-secondary',name:'Secondary',role:'owner',is_primary:false},
];

function availability(){
  return {
    cycle:upcomingCycle,cycleKey:'a'.repeat(64),isAvailable:true,version:0,
    source:'cycle_default',editable:true,updatedAt:null,
  };
}

test('selected secondary pairing is context-fenced coordination without room capabilities',async({page})=>{
  const pairingHeaders:string[]=[];
  const forbiddenWorkspaceRequests:string[]=[];
  const pageErrors:string[]=[];
  page.on('pageerror',error=>pageErrors.push(error.message));
  await mockApi(page,{
    '/api/auth/capabilities':{
      ok:true,capabilities:{passwordLogin:true,passwordSignup:false,googleOAuth:true,
        multiCircleControlPlane:true,multiCircleAvailability:true,secondaryCircleCoordination:true},
      registrationMode:'private_beta',
    },
    '/api/auth/me':{ok:true,user},
    '/api/profile':{ok:true,user:{...user,bio:'',leetcode_handle:''}},
    '/api/circles':{ok:true,circles,active_circle:circles[1],context_version:7,selection_required:false},
    '/api/circle':{ok:true,circle_meta:{public_id:'circle-secondary',name:'Secondary'},
      membership:{role:'owner'},circle:[user],count:1,circle_context_version:7},
    '/api/invitations':{ok:true,invitations:[],count:0,circle_context_version:7},
    '/api/settings/availability':{ok:true,availability:availability(),circle_context_version:7},
    '/api/weeks':(request:Request)=>{
      pairingHeaders.push(request.headers()['x-randori-circle-context-version']||'');
      return {ok:true,coordination_only:true,workspace_available:false,
        circle_public_id:'circle-secondary',circle_context_version:7,current_cycle:currentCycle,
        upcoming_cycle:upcomingCycle,current_week_id:null,filtered_demo:true,weeks:[{
          week_label:currentCycle.cycleId,week_start:currentCycle.startsAt,focus:'both',
          created_at:'2026-09-13T08:00:00.000Z',is_demo:false,is_current:true,
          coordination_only:true,workspace_available:false,pairs:[{
            members:[{name:'Circle Owner',color:'#c8f6a0'},
              {name:'Ada Partner',color:'#654321'}],
            solo:false,topic:'Pick together',topic_kind:'both',workspace_available:false,
          }],
        }]};
    },
    '/api/my-pair':(request:Request)=>{
      pairingHeaders.push(request.headers()['x-randori-circle-context-version']||'');
      return {ok:true,paired:true,pairing_status:'paired',coordination_only:true,
        workspace_available:false,circle_public_id:'circle-secondary',circle_context_version:7,
        cycle:currentCycle,current_cycle:currentCycle,upcoming_cycle:upcomingCycle,
        pair:{solo:false,workspace_available:false},
        partner:{name:'Ada Partner',color:'#654321'},
        partners:[{name:'Ada Partner',color:'#654321'}],
      };
    },
  });
  await page.route('**/api/**',route=>{
    const path=new URL(route.request().url()).pathname;
    if(['/api/schedule','/api/messages','/api/video/signal','/api/ai/analyze'].includes(path)){
      forbiddenWorkspaceRequests.push(path);
    }
    return route.fallback();
  });
  await resetClientState(page,true,{'randori-last-room':'week_9_pair_9','randori-last-my-pair':'unsafe'});
  await page.goto('/',{waitUntil:'domcontentloaded'});
  await expect(page.getByTestId('secondary-pair-card')).toContainText('Ada Partner');
  await expect(page.getByTestId('secondary-pair-card')).toContainText('Workspace not enabled');
  await expect(page.locator('#dashJoinSession')).toHaveCount(0);
  await expect(page.locator('#dashScheduleArea')).toBeEmpty();
  await expect(page.locator('#dashChatArea')).toBeEmpty();
  await page.locator('[data-tab="pair"]').click();
  await expect(page.getByTestId('secondary-pair-row')).toContainText('Ada Partner');
  expect(pairingHeaders.length).toBeGreaterThanOrEqual(2);
  expect(pairingHeaders.every(value=>value==='7')).toBe(true);
  expect(forbiddenWorkspaceRequests).toEqual([]);
  expect(pageErrors).toEqual([]);
  expect(await page.evaluate(()=>({
    authorized:(window as typeof window&{_randori_authorized_room?:unknown})._randori_authorized_room,
    room:localStorage.getItem('randori-last-room'),pair:localStorage.getItem('randori-last-my-pair'),
  }))).toEqual({authorized:null,room:null,pair:null});
});

test('switching circles aborts an in-flight selected pairing read and fences its stale result',async({page})=>{
  let pending:Route|null=null;
  let startedResolve:()=>void=()=>{};
  const started=new Promise<void>(resolve=>{ startedResolve=resolve; });
  const failed:string[]=[];
  page.on('requestfailed',request=>{
    if(new URL(request.url()).pathname==='/api/my-pair') failed.push(request.failure()?.errorText||'failed');
  });
  await mockApi(page,{
    '/api/auth/capabilities':{ok:true,capabilities:{passwordLogin:true,passwordSignup:false,googleOAuth:true,
      multiCircleControlPlane:true,multiCircleAvailability:true,secondaryCircleCoordination:true},registrationMode:'private_beta'},
    '/api/auth/me':{ok:true,user},
    '/api/profile':{ok:true,user:{...user,bio:'',leetcode_handle:''}},
    '/api/circles':request=>request.method()==='GET'
      ?{ok:true,circles,active_circle:circles[1],context_version:7,selection_required:false}
      :{_status:503,ok:false,error:'switch unavailable'},
    '/api/circle':{ok:true,circle_meta:{public_id:'circle-secondary',name:'Secondary'},
      membership:{role:'owner'},circle:[user],count:1,circle_context_version:7},
    '/api/invitations':{ok:true,invitations:[],count:0,circle_context_version:7},
    '/api/settings/availability':{ok:true,availability:availability(),circle_context_version:7},
  });
  await page.route('**/api/my-pair',async route=>{
    pending=route;
    startedResolve();
  });
  await resetClientState(page,true,{'randori-last-room':'week_9_pair_9','randori-last-my-pair':'unsafe'});
  await page.goto('/',{waitUntil:'domcontentloaded'});
  await started;
  await page.getByTestId('circle-context-select').selectOption('circle-primary');
  await expect.poll(()=>failed.length).toBeGreaterThan(0);
  await pending?.fulfill({status:200,contentType:'application/json',body:JSON.stringify({
    ok:true,paired:true,pairing_status:'paired',coordination_only:true,workspace_available:false,
    circle_public_id:'circle-secondary',circle_context_version:7,current_cycle:currentCycle,
    partner:{name:'Stale Partner',color:'#654321'},partners:[{name:'Stale Partner',color:'#654321'}],
    pair:{solo:false,workspace_available:false},
  })}).catch(()=>{});
  await expect(page.getByText('Stale Partner')).toHaveCount(0);
  expect(await page.evaluate(()=>({
    authorized:(window as typeof window&{_randori_authorized_room?:unknown})._randori_authorized_room,
    room:localStorage.getItem('randori-last-room'),pair:localStorage.getItem('randori-last-my-pair'),
  }))).toEqual({authorized:null,room:null,pair:null});
});

test('sign-out aborts an in-flight selected pairing read before clearing identity',async({page})=>{
  let pending:Route|null=null;
  let startedResolve:()=>void=()=>{};
  const started=new Promise<void>(resolve=>{ startedResolve=resolve; });
  const failed:string[]=[];
  page.on('requestfailed',request=>{
    if(new URL(request.url()).pathname==='/api/my-pair') failed.push(request.failure()?.errorText||'failed');
  });
  await mockApi(page,{
    '/api/auth/capabilities':{ok:true,capabilities:{passwordLogin:true,passwordSignup:false,googleOAuth:true,
      multiCircleControlPlane:true,multiCircleAvailability:true,secondaryCircleCoordination:true},registrationMode:'private_beta'},
    '/api/auth/me':{ok:true,user},
    '/api/auth/logout':{ok:true},
    '/api/profile':{ok:true,user:{...user,bio:'',leetcode_handle:''}},
    '/api/circles':{ok:true,circles,active_circle:circles[1],context_version:7,selection_required:false},
    '/api/circle':{ok:true,circle_meta:{public_id:'circle-secondary',name:'Secondary'},
      membership:{role:'owner'},circle:[user],count:1,circle_context_version:7},
    '/api/invitations':{ok:true,invitations:[],count:0,circle_context_version:7},
    '/api/settings/availability':{ok:true,availability:availability(),circle_context_version:7},
  });
  await page.route('**/api/my-pair',async route=>{
    pending=route;
    startedResolve();
  });
  await resetClientState(page,true,{'randori-last-room':'week_9_pair_9','randori-last-my-pair':'unsafe'});
  await page.goto('/',{waitUntil:'domcontentloaded'});
  await started;
  await page.locator('#dashSignOut').click();
  await expect.poll(()=>failed.length).toBeGreaterThan(0);
  await pending?.fulfill({status:200,contentType:'application/json',body:JSON.stringify({
    ok:true,paired:true,pairing_status:'paired',coordination_only:true,workspace_available:false,
    circle_public_id:'circle-secondary',circle_context_version:7,current_cycle:currentCycle,
    partner:{name:'Stale Partner',color:'#654321'},partners:[{name:'Stale Partner',color:'#654321'}],
    pair:{solo:false,workspace_available:false},
  })}).catch(()=>{});
  await expect(page.getByText('Stale Partner')).toHaveCount(0);
  await expect(page.locator('#view-landing')).toBeVisible();
});

test('partner-unavailable secondary state exposes no identity or workspace controls',async({page})=>{
  await mockApi(page,{
    '/api/auth/capabilities':{
      ok:true,capabilities:{passwordLogin:true,passwordSignup:false,googleOAuth:true,
        multiCircleControlPlane:true,multiCircleAvailability:true,secondaryCircleCoordination:true},
      registrationMode:'private_beta',
    },
    '/api/auth/me':{ok:true,user},
    '/api/profile':{ok:true,user:{...user,bio:'',leetcode_handle:''}},
    '/api/circles':{ok:true,circles,active_circle:circles[1],context_version:7,selection_required:false},
    '/api/circle':{ok:true,circle_meta:{public_id:'circle-secondary',name:'Secondary'},
      membership:{role:'owner'},circle:[user],count:1,circle_context_version:7},
    '/api/invitations':{ok:true,invitations:[],count:0,circle_context_version:7},
    '/api/settings/availability':{ok:true,availability:availability(),circle_context_version:7},
    '/api/my-pair':{ok:true,paired:false,pairing_status:'partner_unavailable',
      reason:'partner_unavailable',coordination_only:true,workspace_available:false,
      circle_public_id:'circle-secondary',circle_context_version:7,
      cycle:currentCycle,current_cycle:currentCycle,upcoming_cycle:upcomingCycle,
      message:'Your pairing partner is no longer available in this circle.'},
  });
  await resetClientState(page,true);
  await page.goto('/',{waitUntil:'domcontentloaded'});
  await expect(page.locator('#dashEmptyTitle')).toHaveText('Partner unavailable');
  await expect(page.locator('#dashEmptyMessage')).not.toContainText('User ');
  await expect(page.locator('#dashJoinSession')).toHaveCount(0);
});
