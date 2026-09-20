import { Download, expect, Request, test } from '@playwright/test';

import { mockApi, resetClientState } from './helpers';

const scheduleId='a'.repeat(64);
const currentCycle={
  cycleId:'2026-W38',startsAt:'2026-09-13T07:00:00.000Z',endsAt:'2099-09-20T07:00:00.000Z',
  cutoffAt:'2026-09-13T07:00:00.000Z',timeZone:'Europe/London',state:'current',
};
const upcomingCycle={
  cycleId:'2099-W39',startsAt:'2099-09-20T07:00:00.000Z',endsAt:'2099-09-27T07:00:00.000Z',
  cutoffAt:'2099-09-20T07:00:00.000Z',timeZone:'Europe/London',state:'upcoming',
};
const user={
  id:1,email:'owner@example.test',name:'Circle Owner',display_name:'Circle Owner',
  color:'#c8f6a0',is_admin:true,is_available:true,tz:'Europe/London',interview_focus:'both',
};
const circles=[
  {public_id:'circle-primary',name:'Primary',role:'owner',is_primary:true},
  {public_id:'circle-secondary',name:'Secondary',role:'owner',is_primary:false},
];

function schedule(version:string,proposals:Array<Record<string,unknown>>=[],agreedTime:string|null=null){
  return {version,proposals,agreed_time:agreedTime,legacy_agreed_time:null,updated_at:null};
}

async function downloadText(download:Download){
  const stream=await download.createReadStream();
  if(!stream) throw new Error('calendar download stream unavailable');
  const chunks:string[]=[];
  for await(const chunk of stream) chunks.push(chunk.toString());
  return chunks.join('');
}

function unfoldCalendar(content:string){
  return content.replace(/\r\n[ \t]/g,'');
}

test('secondary partners schedule and export from the dashboard without a room capability',async({page})=>{
  let current=schedule('1'.repeat(64));
  let scheduleDenied=false;
  let scheduleConflict=false;
  let downloadCount=0;
  const requests:Array<{method:string,query:string,body:Record<string,unknown>|null,context:string}>=[];
  await mockApi(page,{
    '/api/auth/capabilities':{ok:true,capabilities:{passwordLogin:true,passwordSignup:false,googleOAuth:true,
      multiCircleControlPlane:true,multiCircleAvailability:true,secondaryCircleCoordination:true,
      secondaryCircleScheduling:true},registrationMode:'private_beta'},
    '/api/auth/me':{ok:true,user},
    '/api/profile':{ok:true,user:{...user,bio:'',leetcode_handle:''}},
    '/api/circles':{ok:true,circles,active_circle:circles[1],context_version:7,selection_required:false},
    '/api/circle':{ok:true,circle_meta:{public_id:'circle-secondary',name:'Secondary'},
      membership:{role:'owner'},circle:[user],count:1,circle_context_version:7},
    '/api/invitations':{ok:true,invitations:[],count:0,circle_context_version:7},
    '/api/settings/availability':{ok:true,availability:{cycle:upcomingCycle,cycleKey:'b'.repeat(64),
      isAvailable:true,version:0,source:'cycle_default',editable:true,updatedAt:null},circle_context_version:7},
    '/api/my-pair':{ok:true,paired:true,pairing_status:'paired',coordination_only:true,
      workspace_available:false,circle_public_id:'circle-secondary',circle_context_version:7,
      cycle:currentCycle,current_cycle:currentCycle,upcoming_cycle:upcomingCycle,
      pair:{solo:false,workspace_available:false},partner:{name:'Ada Partner',color:'#654321'},
      partners:[{name:'Ada Partner',color:'#654321'}],schedule_available:true,schedule_id:scheduleId,
      dashboard_path:'/?view=dashboard'},
    '/api/schedule':(request:Request)=>{
      const url=new URL(request.url());
      const body=request.method()==='POST'?request.postDataJSON() as Record<string,unknown>:null;
      requests.push({method:request.method(),query:url.search,body,
        context:request.headers()['x-randori-circle-context-version']||''});
      if(scheduleDenied) return {_status:404,ok:false,error:'current paired assignment unavailable'};
      if(request.method()==='POST'){
        expect(Object.keys(body||{}).sort()).toEqual(['action','base_version','instant']);
        expect(body).not.toHaveProperty('room_id');
        expect(body).not.toHaveProperty('circle_id');
        expect(body).not.toHaveProperty('group_id');
        const instant=String(body?.instant||'');
        if(scheduleConflict){
          scheduleConflict=false;
          current=schedule('3'.repeat(64),[{
            proposal_id:'d'.repeat(64),value:'2098-10-07T17:30:00.000Z',
            instant:'2098-10-07T17:30:00.000Z',proposed_by:'partner',legacy:false,
          }]);
          return {_status:409,ok:false,error:'schedule changed',coordination_only:true,
            workspace_available:false,circle_public_id:'circle-secondary',circle_context_version:7,
            schedule_id:scheduleId,dashboard_path:'/?view=dashboard',schedule:current};
        }
        current=schedule('2'.repeat(64),[{
          proposal_id:'c'.repeat(64),value:instant,instant,proposed_by:'self',legacy:false,
        }]);
      }
      return {ok:true,coordination_only:true,workspace_available:false,
        circle_public_id:'circle-secondary',circle_context_version:7,schedule_id:scheduleId,
        dashboard_path:'/?view=dashboard',schedule:current};
    },
  });
  await resetClientState(page,true,{'randori-last-room':'week_9_pair_9'});
  page.on('download',()=>{ downloadCount+=1; });
  await page.goto('/',{waitUntil:'domcontentloaded'});
  await expect(page.getByTestId('secondary-pair-card')).toContainText('Agree a time below');
  await expect(page.getByTestId('schedule-area')).toBeVisible();
  await expect.poll(()=>page.evaluate(()=>{
    const value=(window as typeof window&{_randori_schedule?:{room?:string;version?:string}})._randori_schedule;
    return {room:value?.room,version:value?.version};
  })).toEqual({room:scheduleId,version:'1'.repeat(64)});

  await page.getByTestId('schedule-input').fill('2098-10-06T18:30');
  await page.getByTestId('schedule-propose').click();
  await expect(page.getByTestId('schedule-proposal')).toContainText('Proposed by You');
  expect(requests.some(item=>item.method==='GET'&&item.query==='')).toBe(true);
  expect(requests.every(item=>item.context==='7')).toBe(true);
  expect(await page.evaluate(()=>({
    authorized:(window as typeof window&{_randori_authorized_room?:unknown})._randori_authorized_room,
    legacyRoom:localStorage.getItem('randori-last-room'),
  }))).toEqual({authorized:null,legacyRoom:null});

  scheduleConflict=true;
  await page.getByTestId('schedule-input').fill('2098-10-07T18:30');
  await page.getByTestId('schedule-propose').click();
  await expect.poll(()=>page.evaluate(()=>(window as typeof window&{
    _randori_schedule?:{version?:string}
  })._randori_schedule?.version)).toBe('3'.repeat(64));
  await expect(page.getByTestId('schedule-proposal')).toContainText('Proposed by Your partner');

  current=schedule('4'.repeat(64),current.proposals,'2098-10-06T17:30:00.000Z');
  await page.evaluate(()=>
    (window as typeof window&{_randori_schedule?:{refresh?:()=>Promise<boolean>}})._randori_schedule?.refresh?.());
  const downloadPromise=page.waitForEvent('download');
  await page.getByTestId('schedule-calendar-export').click();
  const calendar=await downloadPromise;
  const content=await downloadText(calendar);
  expect(calendar.suggestedFilename()).toBe(`randori-${scheduleId.slice(0,16)}.ics`);
  expect(unfoldCalendar(content)).toContain(`UID:secondary-${scheduleId}@calendar.randori-circle`);
  expect(content).toContain('URL:http://127.0.0.1:4173/?view=dashboard');
  expect(content).not.toContain('/join/');
  expect(downloadCount).toBe(1);

  scheduleDenied=true;
  expect(await page.evaluate(()=>(window as typeof window&{
    _randori_schedule?:{refresh?:()=>Promise<boolean>}
  })._randori_schedule?.refresh?.())).toBe(false);
  await expect(page.locator('#dashScheduleArea')).toBeEmpty();
  expect(await page.evaluate(()=>(window as typeof window&{
    _randori_schedule?:{room?:string|null;schedule?:unknown}
  })._randori_schedule)).toMatchObject({room:null,schedule:null});
  await expect(page.getByTestId('schedule-calendar-export')).toHaveCount(0);
  expect(downloadCount).toBe(1);
});

test('secondary scheduling stays hidden when its dependent flag is off',async({page})=>{
  const scheduleRequests:string[]=[];
  await mockApi(page,{
    '/api/auth/capabilities':{ok:true,capabilities:{passwordLogin:true,passwordSignup:false,googleOAuth:true,
      multiCircleControlPlane:true,multiCircleAvailability:true,secondaryCircleCoordination:true},registrationMode:'private_beta'},
    '/api/auth/me':{ok:true,user},
    '/api/profile':{ok:true,user:{...user,bio:'',leetcode_handle:''}},
    '/api/circles':{ok:true,circles,active_circle:circles[1],context_version:7,selection_required:false},
    '/api/circle':{ok:true,circle_meta:{public_id:'circle-secondary',name:'Secondary'},membership:{role:'owner'},
      circle:[user],count:1,circle_context_version:7},
    '/api/invitations':{ok:true,invitations:[],count:0,circle_context_version:7},
    '/api/my-pair':{ok:true,paired:true,pairing_status:'paired',coordination_only:true,
      workspace_available:false,circle_public_id:'circle-secondary',circle_context_version:7,
      cycle:currentCycle,current_cycle:currentCycle,upcoming_cycle:upcomingCycle,
      pair:{solo:false,workspace_available:false},partner:{name:'Ada Partner',color:'#654321'},
      partners:[{name:'Ada Partner',color:'#654321'}]},
  });
  page.on('request',request=>{
    if(new URL(request.url()).pathname==='/api/schedule') scheduleRequests.push(request.url());
  });
  await resetClientState(page,true);
  await page.goto('/',{waitUntil:'domcontentloaded'});
  await expect(page.getByTestId('secondary-pair-card')).toContainText('Scheduling, chat, room links');
  await expect(page.locator('#dashScheduleArea')).toBeEmpty();
  expect(scheduleRequests).toEqual([]);
});

test('explicitly selected primary scheduling retains its room contract and sends the context fence',async({page})=>{
  const room='week_42_pair_7';
  let current=schedule('4'.repeat(64));
  const requests:Array<{method:string;query:string;body:Record<string,unknown>|null;context:string}>=[];
  await mockApi(page,{
    '/api/auth/capabilities':{ok:true,capabilities:{passwordLogin:true,passwordSignup:false,googleOAuth:true,
      multiCircleControlPlane:true,multiCircleAvailability:true,secondaryCircleCoordination:true,
      secondaryCircleScheduling:true},registrationMode:'private_beta'},
    '/api/auth/me':{ok:true,user},
    '/api/profile':{ok:true,user:{...user,bio:'',leetcode_handle:''}},
    '/api/circles':{ok:true,circles,active_circle:circles[0],context_version:11,selection_required:false},
    '/api/circle':{ok:true,circle_meta:{public_id:'circle-primary',name:'Primary'},membership:{role:'owner'},
      circle:[user],count:1,circle_context_version:11},
    '/api/invitations':{ok:true,invitations:[],count:0,circle_context_version:11},
    '/api/settings/availability':{ok:true,availability:{cycle:upcomingCycle,cycleKey:'b'.repeat(64),
      isAvailable:true,version:0,source:'cycle_default',editable:true,updatedAt:null},circle_context_version:11},
    '/api/my-pair':{ok:true,paired:true,pairing_status:'paired',room_id:room,week_id:42,
      circle_public_id:'circle-primary',circle_context_version:11,
      cycle:currentCycle,current_cycle:currentCycle,upcoming_cycle:upcomingCycle,
      week:{id:42,week_label:'2026-W42'},pair:{pg_id:7,id:7,week_id:42,room_id:room,
        user_a_id:1,user_b_id:2,is_ai_pair:false,is_ai:false,topic:'Pick together',topic_kind:'both'},
      partner:{id:2,name:'Primary Partner',display_name:'Primary Partner',color:'#654321',
        interview_focus:'both',tz:'Europe/London'},
      partners:[{id:2,name:'Primary Partner',display_name:'Primary Partner',color:'#654321'}],
      schedule:current,messagesPreview:[]},
    '/api/messages':{ok:true,messages:[],after:0},
    '/api/schedule':(request:Request)=>{
      const url=new URL(request.url());
      const body=request.method()==='POST'?request.postDataJSON() as Record<string,unknown>:null;
      requests.push({method:request.method(),query:url.search,body,
        context:request.headers()['x-randori-circle-context-version']||''});
      if(request.method()==='POST') current=schedule('5'.repeat(64),[{
        proposal_id:'d'.repeat(64),value:String(body?.instant),instant:String(body?.instant),
        proposed_by:1,legacy:false,
      }]);
      return {ok:true,room_id:room,schedule:current};
    },
  });
  await resetClientState(page,true);
  await page.goto('/',{waitUntil:'domcontentloaded'});
  await expect(page.getByTestId('schedule-area')).toBeVisible();
  await page.evaluate(()=>(window as typeof window&{
    _randori_schedule?:{refresh?:()=>Promise<boolean>}
  })._randori_schedule?.refresh?.());
  await page.getByTestId('schedule-input').fill('2098-10-06T18:30');
  await page.getByTestId('schedule-propose').click();
  await expect(page.getByTestId('schedule-proposal')).toBeVisible();
  expect(requests.some(item=>item.method==='GET'&&item.query===`?room_id=${room}`)).toBe(true);
  expect(requests.some(item=>item.method==='POST'&&item.body?.room_id===room)).toBe(true);
  expect(requests.every(item=>item.context==='11')).toBe(true);
});
