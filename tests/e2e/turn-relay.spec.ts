import { Page, Request, expect, test } from '@playwright/test';
import { mockApi, originalQuestionFixture, resetClientState } from './helpers';

// Issue #305 (ID-107): the direct browser call asks /api/video/turn for
// short-lived Cloudflare TURN credentials just before it creates its
// RTCPeerConnection, and falls back to STUN-only when the route is off,
// failing or slow. The route is mocked and RTCPeerConnection is a fake that
// records its configuration; no relay or provider is ever contacted.
const roomId='week_42_pair_7';
const users={
  1:{id:1,email:'one@example.test',name:'One',display_name:'One',color:'#c8f6a0',is_available:true,tz:'Europe/London',interview_focus:'both'},
  2:{id:2,email:'two@example.test',name:'Two',display_name:'Two',color:'#9cc0b5',is_available:true,tz:'UTC',interview_focus:'both'},
};
const GOOGLE_STUN=['stun:stun.l.google.com:19302','stun:stun1.l.google.com:19302',
  'stun:stun2.l.google.com:19302','stun:stun3.l.google.com:19302'];
const RELAY={urls:['turn:turn.cloudflare.com:3478?transport=udp','turns:turn.cloudflare.com:443?transport=tcp'],
  username:'e2e-turn-username',credential:'e2e-turn-credential'};

type Turn=(request:Request)=>Promise<Record<string,unknown>|null>|Record<string,unknown>|null;

function pairResponse(){
  const partner=users[2];
  return {
    ok:true,paired:true,room_id:roomId,week_id:42,week:{id:42,week_label:'2099-W42'},
    pair:{pg_id:7,week_id:42,user_a_id:1,user_b_id:2,user_c_id:null,is_ai_pair:false,is_ai:false,topic:'Pick together'},
    partner,partners:[partner],
  };
}

async function openRoom(page:Page,turn:Turn){
  const turnPosts:Array<Record<string,unknown>>=[];
  await page.route(/^https:\/\//,route=>route.abort());
  await page.addInitScript(()=>{
    const app=window as any;
    app.__peerConfigs=[];
    class FakePeerConnection{
      signalingState='stable'; connectionState='new'; localDescription:any=null;
      ontrack:any=null; onicecandidate:any=null; onconnectionstatechange:any=null;
      constructor(config:any){ app.__peerConfigs.push(JSON.parse(JSON.stringify(config))); }
      addTrack(){} close(){ this.connectionState='closed'; }
      async setRemoteDescription(){} async createAnswer(){ return {type:'answer',sdp:'a'}; }
      async createOffer(){ return {type:'offer',sdp:'o'}; }
      async setLocalDescription(value:any){ this.localDescription=value; }
      async addIceCandidate(){} getSenders(){ return []; }
    }
    Object.defineProperty(window,'RTCPeerConnection',{configurable:true,writable:true,value:FakePeerConnection});
    // A fake capture stream: no device prompt; video elements just hold it.
    const track=(kind:string)=>({kind,enabled:true,readyState:'live',stop(){ this.readyState='ended'; }});
    const tracks=[track('video'),track('audio')];
    const stream={getTracks:()=>tracks,getVideoTracks:()=>[tracks[0]],getAudioTracks:()=>[tracks[1]]};
    Object.defineProperty(navigator,'mediaDevices',{configurable:true,value:{getUserMedia:async()=>stream}});
    Object.defineProperty(HTMLMediaElement.prototype,'srcObject',{configurable:true,
      get(){ return (this as any).__fakeSrc??null; },set(value){ (this as any).__fakeSrc=value; }});
    HTMLMediaElement.prototype.play=async()=>{};
  });
  await mockApi(page,{
    '/api/auth/me':{ok:true,user:users[1]},'/api/profile':{ok:true,user:users[1]},
    '/api/questions':{ok:true,questions:[originalQuestionFixture],count:1},
    '/api/my-pair':pairResponse(),
    '/api/video/signal':(request:Request)=>{
      const url=new URL(request.url());
      if(request.method()==='GET'&&url.searchParams.get('channel')==='workspace') return {ok:true,room_id:roomId,revision:0,snapshot:null};
      return {ok:true,room_id:roomId,signals:[],after:0,count:0};
    },
    '/api/video/turn':async(request:Request)=>{
      turnPosts.push({method:request.method(),body:request.postDataJSON()});
      return turn(request);
    },
  });
  await resetClientState(page,true);
  await page.goto(`/join/${roomId}`,{waitUntil:'domcontentloaded'});
  await expect(page.locator('#view-code')).toBeVisible();
  await expect.poll(()=>page.evaluate(()=>(window as any)._randori_video?.roomId)).toBe(roomId);
  return turnPosts;
}

async function joinAndReadConfig(page:Page){
  await page.evaluate(()=>(window as any)._randori_video.joinVideo());
  await expect.poll(()=>page.evaluate(()=>(window as any).__peerConfigs.length),{timeout:10_000}).toBeGreaterThan(0);
  return page.evaluate(()=>(window as any).__peerConfigs[0].iceServers as Array<{urls:string|string[];username?:string;credential?:string}>);
}

async function expectNothingStored(page:Page){
  const stored=await page.evaluate(()=>JSON.stringify({local:{...localStorage},session:{...sessionStorage},cookie:document.cookie}));
  expect(stored).not.toContain('e2e-turn');
}

test('the direct call uses STUN plus the returned Cloudflare TURN servers',async({page})=>{
  const posts=await openRoom(page,()=>({iceServers:[{urls:['stun:stun.cloudflare.com:3478']},RELAY],
    expiresAt:new Date(Date.now()+60*60*1000).toISOString()}));
  const servers=await joinAndReadConfig(page);
  expect(servers.slice(0,4).map(server=>server.urls)).toEqual(GOOGLE_STUN);
  expect(servers.slice(4)).toEqual([{urls:['stun:stun.cloudflare.com:3478']},RELAY]);
  expect(posts).toEqual([{method:'POST',body:{room_id:roomId}}]);
  await expectNothingStored(page);
});

for(const [label,status] of [['off (404)',404],['failing (503)',503]] as const){
  test(`the direct call stays STUN-only when the relay is ${label}`,async({page})=>{
    const posts=await openRoom(page,()=>({_status:status,error:'call relay unavailable',
      code:status===404?'turn_relay_disabled':'turn_relay_unavailable'}));
    const servers=await joinAndReadConfig(page);
    expect(servers.map(server=>server.urls)).toEqual(GOOGLE_STUN);
    expect(servers.every(server=>server.username===undefined&&server.credential===undefined)).toBe(true);
    expect(posts.length).toBe(1);
  });
}

test('a slow relay route times out and the call proceeds STUN-only within three seconds',async({page})=>{
  await openRoom(page,()=>new Promise(()=>{}));
  const started=Date.now();
  const servers=await joinAndReadConfig(page);
  expect(servers.map(server=>server.urls)).toEqual(GOOGLE_STUN);
  // Join waits 1.2 s before the initiator creates its peer; the lookup adds at most 3 s.
  expect(Date.now()-started).toBeLessThan(8_000);
});

test('a non-Cloudflare relay from the route is ignored',async({page})=>{
  await openRoom(page,()=>({iceServers:[{urls:'turn:relay.example.com:3478',username:'e2e-turn-u',credential:'e2e-turn-c'}],
    expiresAt:new Date(Date.now()+60*60*1000).toISOString()}));
  const servers=await joinAndReadConfig(page);
  expect(servers.map(server=>server.urls)).toEqual(GOOGLE_STUN);
});
