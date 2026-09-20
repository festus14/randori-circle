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
