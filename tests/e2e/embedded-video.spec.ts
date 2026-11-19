import { Page, Request, Route, expect, test } from '@playwright/test';
import { mockApi, openRoomPanel, originalQuestionFixture, resetClientState } from './helpers';

// Issue #463 (ID-98): embedded Daily video in the pair room. The Daily frame
// origin is routed to a local stub page; Daily itself is never contacted.
const roomId='week_42_pair_7';
const dailyOrigin='https://randori-circle.daily.co';
const dailyRoom=`rc-${'b'.repeat(32)}`;
const completionVersion='c'.repeat(64);
const scheduleVersion='a'.repeat(64);
const acceptedAt='2099-10-20T18:00:00.000Z';
const meetingUrl='https://meet.example.test/private-room';
const users={
  1:{id:1,email:'one@example.test',name:'One',display_name:'One',color:'#c8f6a0',is_available:true,tz:'Europe/London',interview_focus:'both'},
  2:{id:2,email:'two@example.test',name:'Two',display_name:'Two',color:'#9cc0b5',is_available:true,tz:'UTC',interview_focus:'both'},
};

type Options={embedded?:boolean;roomStatus?:number};
type Store={roomPosts:Array<{actorId:number;body:Record<string,unknown>}>;frames:string[];ended:boolean;roomStatus:number};

function pairResponse(actorId:1|2){
  const partner=users[actorId===1?2:1];
  return {
    ok:true,paired:true,room_id:roomId,week_id:42,week:{id:42,week_label:'2099-W42'},
    pair:{pg_id:7,week_id:42,user_a_id:1,user_b_id:2,user_c_id:null,is_ai_pair:false,is_ai:false,topic:'Pick together'},
    partner,partners:[partner],
    schedule:{version:scheduleVersion,proposals:[],agreed_time:acceptedAt,legacy_agreed_time:null,updated_at:'2099-10-19T10:00:00.000Z'},
  };
}

function controls(store:Store,actorId:number){
  const viewerRole=actorId===1?'candidate':'interviewer';
  return {ok:true,room_id:roomId,session_controls:{
    timer_state:store.ended?'expired':'running',remaining_ms:store.ended?0:20*60*1000,duration_ms:25*60*1000,
    candidate_user_id:1,partner_user_id:actorId===1?2:1,viewer_role:viewerRole,
    partner_role:viewerRole==='candidate'?'interviewer':'candidate',terminal:store.ended,
    interview_mode:true,can_control:viewerRole==='interviewer'&&!store.ended,
    end_reason:store.ended?'interviewer_ended':null,completion_version:completionVersion,
    observed_at:new Date().toISOString(),updated_at:new Date().toISOString(),version:(store.ended?'e':'f').repeat(64),
  }};
}

async function openRoom(page:Page,store:Store,actorId:1|2,{embedded=true}:Options={}){
  await page.route(/^https:\/\//,route=>route.abort());
  // Registered later, so it wins: the Daily Prebuilt URL becomes a stub page.
  await page.route(`${dailyOrigin}/**`,async(route:Route)=>{
    store.frames.push(route.request().url());
    await route.fulfill({status:200,contentType:'text/html',body:'<!doctype html><title>Daily stub</title><main>Daily stub room</main>'});
  });
  await mockApi(page,{
    '/api/auth/capabilities':{ok:true,registrationMode:'private_beta',
      capabilities:{passwordLogin:true,passwordSignup:false,googleOAuth:true,...(embedded?{embeddedVideo:true}:{})}},
    '/api/auth/me':{ok:true,user:users[actorId]},'/api/profile':{ok:true,user:users[actorId]},
    '/api/questions':{ok:true,questions:[originalQuestionFixture],count:1},
    '/api/my-pair':pairResponse(actorId),
    '/api/session-completion':{ok:true,room_id:roomId,completion:{state:'not_recorded',viewer_confirmed:false,
      confirmed_count:0,required_count:2,version:completionVersion,completed_at:null}},
    '/api/session-controls':()=>controls(store,actorId),
    '/api/meeting-link':{ok:true,room_id:roomId,meeting_link:{lifecycle:'active',accepted_schedule_at:acceptedAt,
      schedule_version:scheduleVersion,completion_version:completionVersion,version:'1'.padStart(64,'0'),
      url:meetingUrl,hostname:'meet.example.test',updated_at:'2099-10-19T10:00:01.000Z'}},
    '/api/video/signal':(request:Request)=>{
      const url=new URL(request.url());
      if(request.method()==='GET'&&url.searchParams.get('channel')==='workspace') return {ok:true,room_id:roomId,revision:0,snapshot:null};
      return {ok:true,room_id:roomId,signals:[],after:0,count:0};
    },
    '/api/video/room':(request:Request)=>{
      store.roomPosts.push({actorId,body:request.postDataJSON() as Record<string,unknown>});
      if(store.roomStatus!==200) return {_status:store.roomStatus,error:'video_unavailable',fallback:'direct_call'};
      return {ok:true,room_id:roomId,provider:'daily',room_url:`${dailyOrigin}/${dailyRoom}`,
        token:`eyJhbGci.actor-${actorId}.signature`,expires_at:new Date(Date.now()+20*60*1000).toISOString(),expires_in:20*60,recording:false};
    },
  });
  await resetClientState(page,true);
  await page.goto(`/join/${roomId}`,{waitUntil:'domcontentloaded'});
  await expect(page.locator('#view-code')).toBeVisible();
  await expect.poll(()=>page.evaluate(()=>(window as typeof window & {_randori_workspace?:{hydrated?:boolean}})._randori_workspace?.hydrated)).toBe(true);
}

function newStore(roomStatus=200):Store{ return {roomPosts:[],frames:[],ended:false,roomStatus}; }

test('interviewer and candidate consent, join the same private room in-page, and leave',async({browser})=>{
  const store=newStore();
  const candidate=await browser.newPage(),interviewer=await browser.newPage();
  const permissionRequests:string[]=[];
  try{
    await Promise.all([openRoom(candidate,store,1),openRoom(interviewer,store,2)]);
    for(const page of [candidate,interviewer]){
      await page.locator('#vidJoinBtn').click();
      const panel=page.getByTestId('embedded-video');
      await expect(panel).toBeVisible();
      await expect(page.getByTestId('embedded-video-notice')).toContainText('only after you click Join');
      await expect(panel).toContainText('not recorded');
      await expect(page.getByTestId('embedded-video-frame')).toHaveCount(0);
    }
    expect(store.roomPosts).toHaveLength(0);
    expect(store.frames).toHaveLength(0);
    candidate.on('request',request=>{ if(request.url().startsWith(dailyOrigin)) permissionRequests.push(request.url()); });

    await candidate.getByTestId('embedded-video-camera').uncheck();
    await candidate.getByTestId('embedded-video-join').click();
    await interviewer.getByTestId('embedded-video-microphone').uncheck();
    await interviewer.getByTestId('embedded-video-join').click();
    for(const page of [candidate,interviewer]){
      const frame=page.getByTestId('embedded-video-frame');
      await expect(frame).toHaveAttribute('sandbox','allow-scripts allow-same-origin');
      await expect(frame).toHaveAttribute('allow','camera; microphone; autoplay; fullscreen');
      await expect(page.frameLocator('[data-testid="embedded-video-frame"]').getByText('Daily stub room')).toBeVisible();
      await expect(page.getByTestId('embedded-video-status')).toContainText('Live');
      await expect(page.locator('#view-code')).toBeVisible();
    }
    expect(store.roomPosts.map(post=>[post.actorId,post.body]).sort()).toEqual([
      [1,{room_id:roomId,camera:false,microphone:true}],[2,{room_id:roomId,camera:true,microphone:false}],
    ]);
    expect(store.frames.map(url=>new URL(url).pathname)).toEqual([`/${dailyRoom}`,`/${dailyRoom}`]);
    expect(store.frames.map(url=>new URL(url).searchParams.get('t')).sort()).toEqual(["eyJhbGci.actor-1.signature","eyJhbGci.actor-2.signature"]);
    expect(permissionRequests.length).toBeGreaterThan(0);

    await candidate.getByTestId('embedded-video-leave').click();
    await expect(candidate.getByTestId('embedded-video-frame')).toHaveCount(0);
    await expect(candidate.getByTestId('embedded-video-status')).toHaveText('You left the video call.');
    await expect(interviewer.getByTestId('embedded-video-frame')).toHaveCount(1);
  }finally{ await candidate.close(); await interviewer.close(); }
});

test('an interview end closes the live frame for the participant',async({page})=>{
  const store=newStore();
  await openRoom(page,store,2);
  await page.locator('#vidJoinBtn').click();
  await page.getByTestId('embedded-video-join').click();
  await expect(page.getByTestId('embedded-video-frame')).toHaveCount(1);
  store.ended=true;
  await page.evaluate(()=>(window as typeof window & {_randori_session_controls?:{load:()=>unknown}})._randori_session_controls?.load());
  await expect(page.getByTestId('embedded-video-frame')).toHaveCount(0);
  await expect(page.locator('#vidJoinBtn')).toBeDisabled();
});

test('an unavailable provider falls back to the private meeting link without loading a frame',async({page})=>{
  const store=newStore(503);
  await openRoom(page,store,1);
  await openRoomPanel(page,'session');
  await expect(page.getByTestId('meeting-link-join')).toBeVisible();
  await page.locator('#vidJoinBtn').click();
  await page.getByTestId('embedded-video-join').click();
  await expect(page.getByTestId('embedded-video-status')).toHaveText('Built-in video is paused — use the direct call');
  const link=page.getByTestId('embedded-video-fallback-link');
  await expect(link).toHaveAttribute('href',meetingUrl);
  await expect(link).toHaveAttribute('rel','noopener noreferrer');
  await expect(page.getByTestId('embedded-video-legacy')).toBeVisible();
  await expect(page.getByTestId('embedded-video-frame')).toHaveCount(0);
  expect(store.frames).toHaveLength(0);
  const originalUrl=page.url();
  const directJoin=page.waitForRequest(request=>request.url().endsWith('/api/video/signal')
    &&request.method()==='POST'&&(request.postDataJSON() as {type?:string}).type==='join');
  await page.getByTestId('embedded-video-legacy').click();
  await directJoin;
  expect(page.url()).toBe(originalUrl);
  await expect(page.getByTestId('embedded-video-frame')).toHaveCount(0);
  expect(store.roomPosts).toHaveLength(1);
});

test('with the capability off the room keeps its existing call and never loads the embed',async({page})=>{
  const store=newStore();
  const assets:string[]=[];
  page.on('request',request=>{ if(request.url().includes('/assets/embedded-video.js')) assets.push(request.url()); });
  await openRoom(page,store,1,{embedded:false});
  await expect(page.getByTestId('embedded-video')).toBeHidden();
  expect(await page.evaluate(()=>(window as typeof window & {_randori_embedded_video_entry?:{enabled:()=>boolean}})._randori_embedded_video_entry?.enabled())).toBe(false);
  const legacyJoin=page.waitForRequest(request=>request.url().endsWith('/api/video/signal')
    &&request.method()==='POST'&&(request.postDataJSON() as {type?:string}).type==='join');
  await page.locator('#vidJoinBtn').click();
  await legacyJoin;
  await expect(page.getByTestId('embedded-video')).toBeHidden();
  expect(assets).toHaveLength(0);
  expect(store.roomPosts).toHaveLength(0);
});
