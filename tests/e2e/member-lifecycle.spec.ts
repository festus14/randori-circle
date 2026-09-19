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
  await expect(panel.getByText('You are an active circle member.')).toBeVisible();
  await expect(page.getByTestId('circle-manage-members')).toBeHidden();
  expect(actions).toEqual(['deactivate','reactivate','transfer']);
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
