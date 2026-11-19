// Issue #463 (ID-98): POST /api/video/room mints a private Daily room and a
// short-lived token only for an authorized participant of a canonical primary
// two-person room. Daily is never contacted: globalThis.fetch is replaced by
// an in-memory provider that records every request.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, mock, test } from 'node:test';
import { createClient } from '@libsql/client';

import { dailyBudgetMonth } from '../../api/_daily-budget.js';
import {
  DAILY_FRAME_ORIGIN,
  DAILY_RATE_LIMITS,
  DAILY_TOKEN_MAX_TTL_SECONDS,
  dailyGrantWindow,
  dailyRoomName,
  DailyProviderError,
  dailyErrorCode,
  dailyRoomMatches,
  dailyVideoConfiguration,
  enforceDailyVideoRateLimit,
  mintDailyRoomGrant,
} from '../../api/_daily-video.js';

let currentDb=null;
let currentDirectory=null;
const SECRET='daily-video-test-secret-at-least-thirty-two-characters';
const API_KEY='daily-test-api-key-0123456789abcdef';
const ENV_KEYS=['DAILY_MONTHLY_MINUTE_BUDGET','DAILY_VIDEO_ENABLED','DAILY_API_KEY','DAILY_DOMAIN','RANDORI_LOCAL_RUNTIME','INTERVIEW_SESSION_ENABLED',
  'CIRCLE_MEMBERSHIP_ENABLED','MULTI_CIRCLE_CONTROL_PLANE_ENABLED','MULTI_CIRCLE_AVAILABILITY_ENABLED',
  'SECONDARY_CIRCLE_COORDINATION_ENABLED','SECONDARY_CIRCLE_WORKSPACE_ENABLED'];

function authPayload(req){
  const identity=req?.headers?.['x-test-auth'];
  if(identity==='member') return {id:2,email:'member@example.test'};
  if(identity==='uid-member') return {uid:2,email:'member@example.test'};
  if(identity==='partner') return {id:4,email:'partner@example.test'};
  if(identity==='outsider') return {id:9,email:'outsider@example.test'};
  return null;
}

mock.module('../../api/_db.js',{exports:{
  captureSentryException:()=>{},captureSentryMessage:()=>{},getAdminEmails:()=>new Set(),
  getClient:()=>currentDb,getJwtSecret:()=>SECRET,initSentry:()=>{},isSentryConfigured:()=>false,
  verifyMutationOrigin:req=>req?.headers?.origin!=='https://evil.example.test',
  verifyRequestAuth:authPayload,verifySignedRequestAuth:authPayload,
}});

let selectedWorkspace=null;
const dispatchedSecondary=[];
mock.module('../../api/_workspace-router.js',{exports:{
  prepareWorkspaceRequest:async req=>{ if(selectedWorkspace) req.workspace=selectedWorkspace; return selectedWorkspace; },
  dispatchWorkspaceVideo:async(_req,res)=>{ dispatchedSecondary.push(true); return res.json({ok:true,secondary:true}); },
  sendWorkspaceFailure:res=>res.status(503).json({error:'workspace unavailable'}),
}});

const {default:videoHandler}=await import('../../api/video.js');

class FakeDaily{
  constructor(){ this.requests=[]; this.rooms=new Map(); this.fail=null; this.tokens=0; }
  fetch=async(url,init)=>{
    const body=init?.body?JSON.parse(init.body):null;
    this.requests.push({url:String(url),method:init?.method,headers:init?.headers,body,redirect:init?.redirect,signal:init?.signal});
    const path=new URL(url).pathname;
    const failed=this.fail?.(path);
    if(failed) return failed;
    const json=(status,value)=>new Response(JSON.stringify(value),{status,headers:{'content-type':'application/json'}});
    if(path==='/v1/meetings') return json(200,{total_count:0,data:[]});
    if(path==='/v1/rooms'){
      if(this.rooms.has(body.name)) return json(400,{error:'invalid-request-error',info:'room exists'});
      this.rooms.set(body.name,{name:body.name,privacy:body.privacy,config:body.properties});
      return json(200,this.rooms.get(body.name));
    }
    const room=path.match(/^\/v1\/rooms\/([^/]+)$/)?.[1];
    if(room){
      if(!this.rooms.has(room)) return json(404,{error:'not-found'});
      const current=this.rooms.get(room);
      Object.assign(current,{privacy:body.privacy,config:{...current.config,...body.properties}});
      return json(200,current);
    }
    if(path==='/v1/meeting-tokens'){ this.tokens+=1; return json(200,{token:`eyJ.test-token-${this.tokens}.sig`}); }
    return json(404,{error:'not-found'});
  };
}

let provider;
let originalFetch;

function invoke({method='POST',url='/api/video/room',query={endpoint:'room'},headers={'x-test-auth':'member'},
  body={room_id:'week_10_pair_20',camera:true,microphone:true},address='198.51.100.7',workspaceDb=null}={}){
  return new Promise((resolve,reject)=>{
    let statusCode=200,settled=false;
    const responseHeaders={};
    const finish=value=>{ if(!settled){ settled=true; resolve({status:statusCode,headers:responseHeaders,body:value}); } };
    const res={
      status(code){ statusCode=code; return this; },
      setHeader(name,value){ responseHeaders[String(name).toLowerCase()]=value; },
      json(value){ finish(value); return this; },end(value){ finish(value); return this; },
    };
    const req={method,url,query,headers:{'x-forwarded-for':address,...headers},body,socket:{remoteAddress:address},
      ...(workspaceDb?{workspace:{db:workspaceDb,mode:'primary'}}:{})};
    Promise.resolve(videoHandler(req,res)).then(()=>finish(undefined)).catch(reject);
  });
}

async function readyDatabase(){
  currentDirectory=mkdtempSync(join(tmpdir(),'randori-daily-video-'));
  const db=createClient({url:`file:${join(currentDirectory,'test.sqlite')}`});
  await db.batch([
    `CREATE TABLE auth_accounts (id INTEGER PRIMARY KEY,display_name TEXT NOT NULL)`,
    `CREATE TABLE auth_rate_limits (key TEXT PRIMARY KEY, attempts INTEGER NOT NULL DEFAULT 0, expires_at INTEGER NOT NULL)`,
    `CREATE TABLE pairing_groups (id INTEGER PRIMARY KEY,week_id INTEGER NOT NULL,user_a_id INTEGER NOT NULL,user_b_id INTEGER NOT NULL,user_c_id INTEGER,is_ai_pair INTEGER)`,
    `CREATE TABLE pairing_participants (week_id INTEGER NOT NULL,user_id INTEGER NOT NULL,source TEXT NOT NULL,PRIMARY KEY(week_id,user_id))`,
    `CREATE TABLE session_completion_receipts (week_id INTEGER NOT NULL,pair_group_id INTEGER NOT NULL,user_id INTEGER NOT NULL,participant_source TEXT NOT NULL,pair_user_a_id INTEGER NOT NULL,pair_user_b_id INTEGER NOT NULL,pair_user_c_id INTEGER,confirmed_at TEXT NOT NULL,PRIMARY KEY(week_id,pair_group_id,user_id))`,
    `CREATE TABLE pair_session_controls (week_id INTEGER NOT NULL,pair_group_id INTEGER NOT NULL,pair_user_a_id INTEGER NOT NULL,pair_user_a_source TEXT NOT NULL,pair_user_b_id INTEGER NOT NULL,pair_user_b_source TEXT NOT NULL,pair_user_c_id INTEGER,candidate_user_id INTEGER NOT NULL,candidate_source TEXT NOT NULL,timer_state TEXT NOT NULL,remaining_ms INTEGER NOT NULL,anchor_at TEXT,revision INTEGER NOT NULL,updated_by INTEGER NOT NULL,updated_by_source TEXT NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,PRIMARY KEY(week_id,pair_group_id))`,
    `INSERT INTO auth_accounts (id,display_name) VALUES (2,'Member Private Name'),(4,'Partner Private Name'),(6,'Third'),(9,'Outsider')`,
    // 20: the primary human pair; 21: a triad; 22: an AI pair; 23: a pair
    // whose partner comes from a stale pre-auth (users) snapshot.
    `INSERT INTO pairing_groups (id,week_id,user_a_id,user_b_id,user_c_id,is_ai_pair) VALUES
      (20,10,2,4,NULL,0),(21,10,2,4,6,0),(22,10,2,2,NULL,1),(23,10,2,6,NULL,0)`,
    `INSERT INTO pairing_participants (week_id,user_id,source) VALUES
      (10,2,'auth'),(10,4,'auth'),(10,6,'users'),(10,9,'auth')`,
  ],'write');
  // Existing successful-path tests run with a fresh shared usage snapshot.
  const at=Math.floor(Date.now()/1000),month=dailyBudgetMonth(at);
  for(const [key,value] of [[`${month.key}:u`,0],[`${month.key}:t`,at]]){
    await db.execute({sql:'INSERT INTO auth_rate_limits VALUES (?,?,?)',args:[key,value,month.end+3600]});
  }
  return db;
}

async function seedControls(db,{timerState='paused',remainingMs=25*60*1000,anchor=null,candidate=2}={}){
  await db.execute({sql:`INSERT INTO pair_session_controls
    (week_id,pair_group_id,pair_user_a_id,pair_user_a_source,pair_user_b_id,pair_user_b_source,
      pair_user_c_id,candidate_user_id,candidate_source,timer_state,remaining_ms,anchor_at,
      revision,updated_by,updated_by_source,created_at,updated_at)
    VALUES (10,20,2,'auth',4,'auth',NULL,?,'auth',?,?,${anchor===null?'NULL':`strftime('%Y-%m-%dT%H:%M:%fZ','now')`},
      1,2,'auth',strftime('%Y-%m-%dT%H:%M:%fZ','now'),strftime('%Y-%m-%dT%H:%M:%fZ','now'))`,
  args:[candidate,timerState,remainingMs]});
}

function enable(){
  Object.assign(process.env,{DAILY_VIDEO_ENABLED:'true',DAILY_API_KEY:API_KEY,DAILY_DOMAIN:'randori-circle.daily.co'});
}

beforeEach(()=>{
  currentDb=null; selectedWorkspace=null; dispatchedSecondary.length=0;
  for(const key of ENV_KEYS) delete process.env[key];
  provider=new FakeDaily();
  originalFetch=globalThis.fetch;
  globalThis.fetch=provider.fetch;
});
afterEach(()=>{
  globalThis.fetch=originalFetch;
  try{ currentDb?.close?.(); }catch{} currentDb=null;
  if(currentDirectory){ rmSync(currentDirectory,{recursive:true,force:true}); currentDirectory=null; }
  for(const key of ENV_KEYS) delete process.env[key];
});

test('the flag is literal true only and requires a valid server key and the CSP-allowed Daily domain',()=>{
  const valid={DAILY_VIDEO_ENABLED:'true',DAILY_API_KEY:API_KEY,DAILY_DOMAIN:'randori-circle.daily.co'};
  assert.deepEqual({...dailyVideoConfiguration(valid)},{apiKey:API_KEY,domain:'randori-circle.daily.co',origin:DAILY_FRAME_ORIGIN,monthlyMinuteBudget:9000});
  assert.equal(dailyVideoConfiguration({...valid,DAILY_DOMAIN:' Randori-Circle.daily.co '})?.origin,DAILY_FRAME_ORIGIN);
  for(const env of [
    {},{DAILY_VIDEO_ENABLED:'true'},{...valid,DAILY_VIDEO_ENABLED:'TRUE'},{...valid,DAILY_VIDEO_ENABLED:'1'},{...valid,DAILY_VIDEO_ENABLED:'yes'},
    {...valid,DAILY_API_KEY:''},{...valid,DAILY_API_KEY:'short'},{...valid,DAILY_API_KEY:'has spaces in the key value 1234'},
    {...valid,DAILY_DOMAIN:''},{...valid,DAILY_DOMAIN:'https://randori-circle.daily.co'},
    {...valid,DAILY_DOMAIN:'randori-circle.daily.co.evil.test'},{...valid,DAILY_DOMAIN:'other.daily.co'},
    {...valid,DAILY_DOMAIN:'randori-circle.daily.co/path'},{...valid,RANDORI_LOCAL_RUNTIME:'true'},
  ]) assert.equal(dailyVideoConfiguration(env),null,JSON.stringify(env));
});

test('with the flag off the route keeps its existing signaling behaviour and never contacts the provider',async()=>{
  currentDb=await readyDatabase();
  process.env.DAILY_API_KEY=API_KEY; process.env.DAILY_DOMAIN='randori-circle.daily.co';
  for(const flag of [undefined,'false','TRUE']){
    if(flag===undefined) delete process.env.DAILY_VIDEO_ENABLED; else process.env.DAILY_VIDEO_ENABLED=flag;
    const response=await invoke();
    assert.equal(response.status,400);
    assert.match(response.body.error,/room_id, from_id, type, payload required/);
  }
  process.env.DAILY_VIDEO_ENABLED='true'; process.env.DAILY_DOMAIN='elsewhere.daily.co';
  assert.equal((await invoke()).status,400,'a misconfigured domain is the same as off');
  assert.equal(provider.requests.length,0);
});

test('an authorized participant gets a private two-person room and a short non-owner token',async()=>{
  currentDb=await readyDatabase(); enable();
  const response=await invoke({body:{room_id:'week_10_pair_20',camera:false,microphone:true}});
  assert.equal(response.status,200,JSON.stringify(response.body));
  assert.equal(response.headers['cache-control'],'private, no-store');
  const name=dailyRoomName('week_10_pair_20',SECRET);
  assert.match(name,/^rc-[a-f0-9]{32}$/);
  assert.deepEqual(Object.keys(response.body).sort(),['expires_at','expires_in','ok','provider','recording','room_id','room_url','token']);
  assert.equal(response.body.expires_in,DAILY_TOKEN_MAX_TTL_SECONDS,'the server, not the browser clock, says how long the pass lasts');
  assert.equal(response.body.room_url,`${DAILY_FRAME_ORIGIN}/${name}`);
  assert.equal(response.body.recording,false);
  assert.equal(response.body.token,'eyJ.test-token-1.sig');

  assert.deepEqual(provider.requests.map(request=>[request.method,new URL(request.url).pathname]),[
    ['POST',`/v1/rooms/${name}`],['POST','/v1/rooms'],['POST','/v1/meeting-tokens'],
  ]);
  for(const request of provider.requests){
    assert.equal(request.url.startsWith('https://api.daily.co/v1/'),true);
    assert.equal(request.headers.authorization,`Bearer ${API_KEY}`);
    assert.equal(request.redirect,'error');
    assert.ok(request.signal instanceof AbortSignal,'every provider call has a timeout');
  }
  const created=provider.requests[1].body;
  assert.equal(created.name,name); assert.equal(created.privacy,'private');
  const nowSeconds=Math.floor(Date.now()/1000);
  assert.deepEqual(Object.keys(created.properties).sort(),['eject_at_room_exp','enable_chat','enable_knocking',
    'enable_live_captions_ui','enable_prejoin_ui','enable_screenshare','exp','max_participants']);
  assert.equal(created.properties.max_participants,2);
  assert.equal(created.properties.enable_screenshare,false);
  assert.equal(created.properties.enable_chat,false);
  assert.ok(Math.abs(created.properties.exp-(nowSeconds+2*60*60))<=5,'room expires within two hours');
  const token=provider.requests[2].body;
  assert.deepEqual(Object.keys(token),['properties']);
  assert.deepEqual({...token.properties,exp:0},{
    room_name:name,exp:0,is_owner:false,user_name:'Candidate',eject_at_token_exp:true,
    enable_prejoin_ui:false,enable_screenshare:false,enable_recording_ui:false,
    start_video_off:true,start_audio_off:false,
  });
  assert.ok(Math.abs(token.properties.exp-(nowSeconds+DAILY_TOKEN_MAX_TTL_SECONDS))<=5);
  assert.equal(Date.parse(response.body.expires_at)/1000,token.properties.exp);
  for(const request of provider.requests){
    const serialized=JSON.stringify(request.body);
    assert.doesNotMatch(serialized,/enable_recording"|start_cloud_recording|Private Name|member@|week_10|pair_20/,
      'no recording switch, name, email or Randori room id reaches the provider');
  }

  // The partner reuses the same room (update, no second create) and gets its own role label.
  provider.requests.length=0;
  const partner=await invoke({headers:{'x-test-auth':'partner'}});
  assert.equal(partner.status,200,JSON.stringify(partner.body));
  assert.equal(partner.body.room_url,response.body.room_url);
  assert.deepEqual(provider.requests.map(request=>new URL(request.url).pathname),[`/v1/rooms/${name}`,'/v1/meeting-tokens']);
  assert.equal(provider.requests[1].body.properties.user_name,'Interviewer');
  assert.equal(provider.requests[1].body.properties.start_video_off,false);
});

test('room names are opaque HMACs: stable per room, distinct across rooms and secrets',()=>{
  const a=dailyRoomName('week_10_pair_20',SECRET);
  assert.equal(dailyRoomName('week_10_pair_20',SECRET),a);
  assert.notEqual(dailyRoomName('week_10_pair_21',SECRET),a);
  assert.notEqual(dailyRoomName('week_10_pair_20',`${SECRET}-rotated`),a);
  assert.doesNotMatch(a,/week|pair|_10_|_20/);
  assert.throws(()=>dailyRoomName('week_10_pair_20',''),TypeError);
});

test('non-participants, wrong rooms, triads, AI pairs and stale snapshots all receive the identical 404',async()=>{
  currentDb=await readyDatabase(); enable();
  const denied=[
    invoke({headers:{'x-test-auth':'outsider'}}),
    invoke({body:{room_id:'week_10_pair_99',camera:true,microphone:true}}),
    invoke({body:{room_id:'week_11_pair_20',camera:true,microphone:true}}),
    invoke({body:{room_id:'week_10_pair_21',camera:true,microphone:true}}),
    invoke({body:{room_id:'week_10_pair_22',camera:true,microphone:true}}),
    invoke({body:{room_id:'week_10_pair_23',camera:true,microphone:true}}),
  ];
  for(const response of await Promise.all(denied)){
    assert.equal(response.status,404);
    assert.deepEqual(response.body,{error:'pair not found'});
  }
  assert.equal(provider.requests.length,0);
});

test('authentication, method, origin and exact input are enforced before any provider call',async()=>{
  currentDb=await readyDatabase(); enable();
  assert.equal((await invoke({headers:{}})).status,401);
  const get=await invoke({method:'GET'});
  assert.equal(get.status,405); assert.equal(get.headers.allow,'POST');
  assert.equal((await invoke({headers:{'x-test-auth':'member',origin:'https://evil.example.test'}})).status,403);
  for(const body of [
    {room_id:'week_10_pair_20'},{room_id:'week_10_pair_20',camera:'true',microphone:true},
    {room_id:'week_10_pair_20',camera:true,microphone:true,extra:1},{room_id:'w10-p2-4',camera:true,microphone:true},
    {room_id:'circle_abc',camera:true,microphone:true},{room_id:20,camera:true,microphone:true},null,[],
  ]) assert.equal((await invoke({body})).status,400,JSON.stringify(body));
  assert.equal((await invoke({url:'/api/video/room?x=1',query:{endpoint:'room',x:'1'}})).status,400);
  assert.equal((await invoke({url:'/api/video/room?endpoint=room&endpoint=room',query:undefined})).status,400);
  assert.equal((await invoke({query:{endpoint:['room','room']}})).status,400);
  assert.equal(provider.requests.length,0);
});

test('terminal and expired interviews are refused using the database clock',async()=>{
  currentDb=await readyDatabase(); enable();
  process.env.INTERVIEW_SESSION_ENABLED='true';
  await seedControls(currentDb,{timerState:'paused',remainingMs:0});
  const ended=await invoke();
  assert.equal(ended.status,409);
  assert.equal(ended.body.code,'interview_session_ended');
  await currentDb.execute(`UPDATE pair_session_controls SET timer_state='running',remaining_ms=500,
    anchor_at=strftime('%Y-%m-%dT%H:%M:%fZ','now','-10 seconds'),updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now','-10 seconds'),
    created_at=strftime('%Y-%m-%dT%H:%M:%fZ','now','-20 seconds')`);
  const expired=await invoke();
  assert.equal(expired.status,409); assert.equal(expired.body.code,'interview_session_ended');

  await currentDb.execute(`DELETE FROM pair_session_controls`);
  await currentDb.execute(`INSERT INTO session_completion_receipts VALUES
    (10,20,2,'auth',2,4,NULL,strftime('%Y-%m-%dT%H:%M:%fZ','now')),(10,20,4,'auth',2,4,NULL,strftime('%Y-%m-%dT%H:%M:%fZ','now'))`);
  delete process.env.INTERVIEW_SESSION_ENABLED;
  const completed=await invoke();
  assert.equal(completed.status,409); assert.equal(completed.body.code,'session_completed');
  assert.equal(provider.requests.length,0);
});

test('an interview token never outlives the time left on the shared timer',async()=>{
  currentDb=await readyDatabase(); enable();
  process.env.INTERVIEW_SESSION_ENABLED='true';
  await seedControls(currentDb,{timerState:'running',remainingMs:5*60*1000,anchor:'now'});
  const response=await invoke();
  assert.equal(response.status,200,JSON.stringify(response.body));
  const exp=provider.requests.at(-1).body.properties.exp;
  const nowSeconds=Math.floor(Date.now()/1000);
  assert.ok(exp<=nowSeconds+5*60&&exp>=nowSeconds+5*60-5,`token exp ${exp-nowSeconds}s is within the remaining five minutes`);
  assert.equal(provider.requests.at(-1).body.properties.user_name,'Candidate');

  assert.deepEqual({...dailyGrantWindow({databaseNow:'2026-11-18T10:00:00.900Z',state:{interview_mode:true,remaining_ms:90_999}})},
    {nowSeconds:Date.parse('2026-11-18T10:00:00Z')/1000,ttlSeconds:90,expiresAt:Date.parse('2026-11-18T10:01:30Z')/1000});
  assert.equal(dailyGrantWindow({databaseNow:'2026-11-18T10:00:00.000Z',state:{interview_mode:true,remaining_ms:20*60*60*1000}}).ttlSeconds,DAILY_TOKEN_MAX_TTL_SECONDS);
  assert.equal(dailyGrantWindow({databaseNow:'2026-11-18T10:00:00.000Z',state:{remaining_ms:1000}}).ttlSeconds,DAILY_TOKEN_MAX_TTL_SECONDS);
  assert.equal(dailyGrantWindow({databaseNow:'2026-11-18T10:00:00.000Z',state:{interview_mode:true,remaining_ms:0}}).ttlSeconds,0);
});

test('provider failures and timeouts map to a generic 503 that leaks no secret or token',async()=>{
  currentDb=await readyDatabase(); enable();
  const warnings=[];
  const originalWarn=console.warn;
  console.warn=(...args)=>warnings.push(args.map(String).join(' '));
  try{
    const scenarios=[
      // First, while the room does not exist yet: the create itself fails.
      path=>path==='/v1/rooms'?new Response('server error',{status:500}):undefined,
      ()=>new Response('{"error":"authentication-error"}',{status:401}),
      ()=>new Response('upstream down',{status:502}),
      path=>path==='/v1/meeting-tokens'?new Response('{"token":42}',{status:200}):undefined,
      path=>path==='/v1/meeting-tokens'?new Response('not json',{status:200}):undefined,
      ()=>{ throw new DOMException('The operation was aborted due to timeout','TimeoutError'); },
      path=>path.startsWith('/v1/rooms/')?new Response(JSON.stringify({name:'x',privacy:'public'}),{status:200}):undefined,
    ];
    for(const scenario of scenarios){
      provider.fail=path=>scenario(path);
      const response=await invoke();
      assert.equal(response.status,503,JSON.stringify(response.body));
      assert.deepEqual(response.body,{error:'video_unavailable',fallback:'direct_call'});
    }
  }finally{ console.warn=originalWarn; }
  assert.equal(warnings.length,7);
  const name=dailyRoomName('week_10_pair_20',SECRET);
  for(const line of warnings){
    assert.match(line,/^\[video\] embedded provider unavailable \{"stage":"[a-z-]+","status":(?:\d+|null),"error":(?:"[a-z-]+"|null)\}$/);
    for(const secret of [API_KEY,name,'Candidate','member@example.test','week_10_pair_20','eyJ']) assert.equal(line.includes(secret),false);
  }
});

test('a concurrent partner creation is absorbed by one update retry',async()=>{
  currentDb=await readyDatabase(); enable();
  const name=dailyRoomName('week_10_pair_20',SECRET);
  let updates=0;
  provider.fail=path=>{
    if(path===`/v1/rooms/${name}`&&updates++===0) return new Response('{"error":"not-found"}',{status:404});
    if(path==='/v1/rooms'){ provider.rooms.set(name,{name,privacy:'private',config:{max_participants:2}}); return new Response('{"error":"invalid-request-error"}',{status:400}); }
    return undefined;
  };
  const response=await invoke();
  assert.equal(response.status,200,JSON.stringify(response.body));
  assert.deepEqual(provider.requests.map(request=>new URL(request.url).pathname),
    [`/v1/rooms/${name}`,'/v1/rooms',`/v1/rooms/${name}`,'/v1/meeting-tokens']);
});

test('joins are rate limited per account and per network before authorization or provider calls',async()=>{
  currentDb=await readyDatabase(); enable();
  for(let index=0;index<DAILY_RATE_LIMITS.account;index+=1){
    assert.equal((await invoke({address:`198.51.100.${index+1}`})).status,200);
  }
  const calls=provider.requests.length;
  const limited=await invoke({address:'198.51.100.200'});
  assert.equal(limited.status,429);
  const retryAfter=Number(limited.headers['retry-after']);
  const window=15*60;
  const remaining=window-(Math.floor(Date.now()/1000)%window);
  assert.ok(Number.isSafeInteger(retryAfter)&&retryAfter>=1&&retryAfter<=window,'Retry-After is the rest of the window');
  assert.ok((retryAfter-remaining+window)%window<=2,`Retry-After ${retryAfter} matches the remaining ${remaining}s`);
  assert.equal(provider.requests.length,calls,'a limited join never reaches the provider');
  // A non-participant's probes count against its own windows before authorization.
  for(let index=0;index<DAILY_RATE_LIMITS.account;index+=1){
    assert.equal((await invoke({headers:{'x-test-auth':'outsider'},address:'203.0.113.9'})).status,404);
  }
  assert.equal((await invoke({headers:{'x-test-auth':'outsider'},address:'203.0.113.10'})).status,429);
  // The network window is independent of the account: many accounts, one /64.
  const nowSeconds=Math.floor(Date.now()/1000);
  const req={headers:{'x-forwarded-for':'2001:db8:1:2::1'},socket:{}};
  for(let userId=100;userId<100+DAILY_RATE_LIMITS.address;userId+=1){
    assert.equal((await enforceDailyVideoRateLimit(currentDb,{req,userId,secret:SECRET,nowSeconds})).allowed,true);
  }
  const rotated={headers:{'x-forwarded-for':'2001:db8:1:2:ffff::9'},socket:{}};
  const blocked=await enforceDailyVideoRateLimit(currentDb,{req:rotated,userId:999,secret:SECRET,nowSeconds});
  assert.deepEqual({...blocked},{allowed:false,dimension:'address',retryAfter:15*60-(nowSeconds%(15*60))});
  const keys=await currentDb.execute('SELECT key FROM auth_rate_limits');
  for(const row of keys.rows) assert.match(String(row.key),/^(?:[a-f0-9]{64}|dvb1:[a-z0-9:-]+)$/,'keyed hashes or aggregate/random namespaced budget keys only');
});

test('a rate-limit store failure is a generic 503, not an unlimited grant',async()=>{
  currentDb=await readyDatabase(); enable();
  await currentDb.execute('DROP TABLE auth_rate_limits');
  const response=await invoke();
  assert.equal(response.status,503);
  assert.equal(provider.requests.length,0);
});

test('a secondary-circle workspace room never receives embedded video',async()=>{
  currentDb=await readyDatabase(); enable();
  Object.assign(process.env,{CIRCLE_MEMBERSHIP_ENABLED:'true',MULTI_CIRCLE_CONTROL_PLANE_ENABLED:'true',
    MULTI_CIRCLE_AVAILABILITY_ENABLED:'true',SECONDARY_CIRCLE_COORDINATION_ENABLED:'true',SECONDARY_CIRCLE_WORKSPACE_ENABLED:'true'});
  selectedWorkspace={db:currentDb,mode:'secondary',context:{}};
  const response=await invoke();
  assert.equal(response.status,404);
  assert.deepEqual(response.body,{error:'pair not found'});
  assert.equal(dispatchedSecondary.length,0,'the secondary workspace router is not asked to handle it');
  assert.equal(provider.requests.length,0);
});

test('the session id may arrive as uid and the endpoint only in the URL',async()=>{
  currentDb=await readyDatabase(); enable();
  const response=await invoke({headers:{'x-test-auth':'uid-member'},url:'/api/video/room?endpoint=room',query:undefined});
  assert.equal(response.status,200,JSON.stringify(response.body));
});

test('a primary workspace request uses the scoped workspace client',async()=>{
  currentDb=await readyDatabase(); enable();
  Object.assign(process.env,{CIRCLE_MEMBERSHIP_ENABLED:'true',MULTI_CIRCLE_CONTROL_PLANE_ENABLED:'true',
    MULTI_CIRCLE_AVAILABILITY_ENABLED:'true',SECONDARY_CIRCLE_COORDINATION_ENABLED:'true',SECONDARY_CIRCLE_WORKSPACE_ENABLED:'true'});
  await currentDb.batch([
    `CREATE TABLE circles (id INTEGER PRIMARY KEY,is_primary INTEGER NOT NULL,archived_at TEXT)`,
    `CREATE TABLE circle_memberships (user_id INTEGER NOT NULL,circle_id INTEGER NOT NULL,status TEXT NOT NULL)`,
    `INSERT INTO circles VALUES (1,1,NULL)`,
    `INSERT INTO circle_memberships VALUES (2,1,'active'),(4,1,'active')`,
  ],'write');
  let scopedCalls=0;
  const original=currentDb;
  const scoped={execute:statement=>{ scopedCalls+=1; return original.execute(statement); },transaction:mode=>{ scopedCalls+=1; return original.transaction(mode); }};
  currentDb=null;
  selectedWorkspace={db:scoped,mode:'primary',context:{}};
  try{
    const response=await invoke();
    assert.equal(response.status,200,JSON.stringify(response.body));
    assert.ok(scopedCalls>0,'every statement went through the workspace client');
  }finally{ currentDb=original; }
});

test('schema, stored-state and unexpected failures are generic 503s',async()=>{
  currentDb=await readyDatabase(); enable();
  process.env.INTERVIEW_SESSION_ENABLED='true';
  await seedControls(currentDb);
  await currentDb.execute(`UPDATE pair_session_controls SET timer_state='bogus'`);
  const corrupt=await invoke();
  assert.equal(corrupt.status,503); assert.equal(corrupt.body.fallback,'direct_call');
  await currentDb.execute('DELETE FROM pair_session_controls');

  const warnings=[]; const originalWarn=console.warn;
  console.warn=(...args)=>warnings.push(args.join(' '));
  try{
    globalThis.fetch=async()=>null;
    const unexpected=await invoke({address:'198.51.100.99'});
    assert.equal(unexpected.status,503);
    assert.deepEqual(warnings,['[video] embedded provider unavailable {"stage":"unexpected","status":null,"error":null}']);
  }finally{ console.warn=originalWarn; globalThis.fetch=provider.fetch; }

  await currentDb.execute('DROP TABLE pair_session_controls');
  const unready=await invoke({address:'198.51.100.98'});
  assert.equal(unready.status,503);
  assert.equal(provider.requests.length,0);
});

test('a failed update after a create race is a 503',async()=>{
  currentDb=await readyDatabase(); enable();
  provider.fail=path=>path==='/v1/rooms'?new Response('{"error":"exists"}',{status:400})
    :path.startsWith('/v1/rooms/')?new Response('{"error":"not-found"}',{status:404}):undefined;
  const warnings=[]; const originalWarn=console.warn;
  console.warn=(...args)=>warnings.push(args.join(' '));
  try{ assert.equal((await invoke()).status,503); }finally{ console.warn=originalWarn; }
  assert.deepEqual(warnings,['[video] embedded provider unavailable {"stage":"room-update","status":404,"error":"not-found"}']);
  assert.equal(provider.requests.filter(request=>new URL(request.url).pathname==='/v1/meeting-tokens').length,0);
});

test('grant helpers fail closed on a bad clock, no configuration or no time left',async()=>{
  assert.throws(()=>dailyGrantWindow({databaseNow:'not a time',state:{}}),TypeError);
  const window=dailyGrantWindow({databaseNow:'2026-11-18T10:00:00.000Z',state:{}});
  await assert.rejects(mintDailyRoomGrant(null,{roomId:'week_10_pair_20',secret:SECRET,window}),DailyProviderError);
  const config=dailyVideoConfiguration({DAILY_VIDEO_ENABLED:'true',DAILY_API_KEY:API_KEY,DAILY_DOMAIN:'randori-circle.daily.co'});
  await assert.rejects(mintDailyRoomGrant(config,{roomId:'week_10_pair_20',secret:SECRET,
    window:{...window,ttlSeconds:0}}),DailyProviderError);
  assert.equal(provider.requests.length,0);
});

test('a room Daily reports with recording, extra seats or public access fails closed before any token',async()=>{
  currentDb=await readyDatabase(); enable();
  const name=dailyRoomName('week_10_pair_20',SECRET);
  const warnings=[]; const originalWarn=console.warn;
  console.warn=(...args)=>warnings.push(args.join(' '));
  try{
    for(const reported of [
      {name,privacy:'private',config:{max_participants:2,enable_recording:'cloud'}},
      {name,privacy:'private',config:{max_participants:2,enable_recording:'local'}},
      {name,privacy:'private',config:{max_participants:3}},
      {name,privacy:'private',config:{}},
      {name,privacy:'private'},
      {name,privacy:'public',config:{max_participants:2}},
      {name:'rc-other',privacy:'private',config:{max_participants:2}},
    ]){
      provider.requests.length=0;
      provider.fail=path=>path===`/v1/rooms/${name}`?new Response(JSON.stringify(reported),{status:200}):undefined;
      const response=await invoke();
      assert.equal(response.status,503,JSON.stringify(reported));
      assert.equal(response.body.fallback,'direct_call');
      assert.equal(provider.requests.some(request=>new URL(request.url).pathname==='/v1/meeting-tokens'),false,'no token for a mismatched room');
    }
    // The create path is checked the same way.
    provider.fail=path=>path===`/v1/rooms/${name}`?new Response('{"error":"not-found"}',{status:404})
      :path==='/v1/rooms'?new Response(JSON.stringify({name,privacy:'private',config:{max_participants:2,enable_recording:'raw-tracks'}}),{status:200}):undefined;
    assert.equal((await invoke()).status,503);
  }finally{ console.warn=originalWarn; }
  assert.equal(warnings.length,8);
  for(const line of warnings) assert.equal(line,'[video] embedded provider unavailable {"stage":"room-config","status":200,"error":null}');
  assert.equal(dailyRoomMatches({name,privacy:'private',config:{max_participants:2,enable_recording:null}},name),true);
  assert.equal(dailyRoomMatches({name,privacy:'private',config:{max_participants:2,enable_recording:false}},name),true);
  assert.equal(dailyRoomMatches({name,privacy:'private',config:{max_participants:2,enable_recording:''}},name),true);
});

test('the 503 log carries Daily\'s fixed error code but never its free text',async()=>{
  currentDb=await readyDatabase(); enable();
  const warnings=[]; const originalWarn=console.warn;
  console.warn=(...args)=>warnings.push(args.join(' '));
  try{
    provider.fail=()=>new Response(JSON.stringify({error:'authentication-error',info:`bad key ${API_KEY}`}),{status:401});
    assert.equal((await invoke()).status,503);
    provider.fail=()=>new Response(JSON.stringify({error:`Bearer ${API_KEY}`,info:'x'}),{status:400});
    assert.equal((await invoke()).status,503);
    provider.fail=path=>path==='/v1/meeting-tokens'?new Response(JSON.stringify({error:'rate-limit-error'}),{status:429}):undefined;
    assert.equal((await invoke()).status,503);
  }finally{ console.warn=originalWarn; }
  assert.deepEqual(warnings,[
    '[video] embedded provider unavailable {"stage":"room-update","status":401,"error":"authentication-error"}',
    '[video] embedded provider unavailable {"stage":"room-update","status":400,"error":null}',
    '[video] embedded provider unavailable {"stage":"token","status":429,"error":"rate-limit-error"}',
  ]);
  assert.equal(dailyErrorCode({error:'invalid-request-error'}),'invalid-request-error');
  for(const payload of [null,{},{error:42},{error:'Has Caps'},{error:'x'.repeat(80)}]) assert.equal(dailyErrorCode(payload),null);
});

test('#490 cold usage is read before any room/token creation and a fresh snapshot survives a read outage',async()=>{
  currentDb=await readyDatabase(); enable();
  await currentDb.execute("DELETE FROM auth_rate_limits WHERE key GLOB 'dvb1:*'");
  const response=await invoke();
  assert.equal(response.status,200);
  assert.equal(new URL(provider.requests[0].url).pathname,'/v1/meetings');
  assert.equal(provider.tokens,1);
  assert.equal((await currentDb.execute("SELECT SUM(attempts) AS n FROM auth_rate_limits WHERE key GLOB 'dvb1:p:*' AND key NOT GLOB '*:paused'")).rows[0].n,120);
  provider.fail=path=>path==='/v1/meetings'?new Response('outage',{status:503}):undefined;
  provider.requests.length=0;
  assert.equal((await invoke({headers:{'x-test-auth':'partner'}})).status,200);
  assert.equal(provider.requests.some(request=>new URL(request.url).pathname==='/v1/meetings'),false);
});

test('#490 cold read failure and stale evidence return the typed fallback without creating a room/token',async()=>{
  currentDb=await readyDatabase(); enable();
  await currentDb.execute("DELETE FROM auth_rate_limits WHERE key GLOB 'dvb1:*'");
  const warnings=[],originalWarn=console.warn;
  console.warn=(...args)=>warnings.push(args.join(' '));
  try{
    provider.fail=path=>path==='/v1/meetings'?new Response(JSON.stringify({error:'private-room',info:'private-participant secret-token'}),{status:502}):undefined;
    const response=await invoke();
    assert.equal(response.status,503); assert.deepEqual(response.body,{error:'video_unavailable',fallback:'direct_call'});
    assert.equal(response.headers['cache-control'],'private, no-store');
    assert.equal(provider.requests.length,1); assert.equal(provider.rooms.size,0); assert.equal(provider.tokens,0);
    const at=Math.floor(Date.now()/1000),month=dailyBudgetMonth(at);
    await currentDb.execute({sql:'INSERT INTO auth_rate_limits VALUES (?,?,?),(?,?,?)',
      args:[`${month.key}:u`,0,month.end+3600,`${month.key}:t`,at-300,month.end+3600]});
    assert.equal((await invoke()).status,503);
    assert.equal(provider.requests.length,1,'failed-read cooldown does not refetch; stale usage never allows tokens');
  }finally{ console.warn=originalWarn; }
  assert.equal(warnings.length,2);
  for(const warning of warnings) assert.doesNotMatch(warning,/private-room|private-participant|secret-token/);
});

test('#490 budget invalid/overspent never calls Daily; equality passes and racing grants do not overspend',async()=>{
  currentDb=await readyDatabase(); enable();
  for(const invalid of ['','0','-1','9000.5','garbage','9007199254740992']){
    process.env.DAILY_MONTHLY_MINUTE_BUDGET=invalid;
    const response=await invoke();
    assert.equal(response.status,503); assert.deepEqual(response.body,{error:'video_unavailable',fallback:'direct_call'});
    assert.equal(response.headers['cache-control'],'private, no-store');
  }
  assert.equal(provider.requests.length,0);
  process.env.DAILY_MONTHLY_MINUTE_BUDGET='119';
  const warnings=[],originalWarn=console.warn; console.warn=(...args)=>warnings.push(args.join(' '));
  try{
    assert.equal((await invoke()).status,503); assert.equal(provider.requests.length,0);
    process.env.DAILY_MONTHLY_MINUTE_BUDGET='120';
    // Distinct clients share one database, as two serverless instances do.
    const second=createClient({url:`file:${join(currentDirectory,'test.sqlite')}`});
    let results;
    try{ results=await Promise.all([invoke(),invoke({headers:{'x-test-auth':'partner'},address:'203.0.113.8',workspaceDb:second})]); }
    finally{ second.close(); }
    assert.deepEqual(results.map(result=>result.status).sort(),[200,200],JSON.stringify({results,warnings}));
    assert.equal(provider.tokens,2);
    assert.equal((await currentDb.execute("SELECT SUM(attempts) AS n FROM auth_rate_limits WHERE key GLOB 'dvb1:p:*' AND key NOT GLOB '*:paused'")).rows[0].n,120);
  }finally{ console.warn=originalWarn; }
  assert.doesNotMatch(warnings.join(' '),/week_10|rc-[a-f0-9]|eyJ|Candidate|Interviewer/);
});

test('Daily rate-lock retries are bounded and never retry an unknown outcome',async()=>{
  currentDb=await readyDatabase();let calls=0;
  const request={headers:{'x-forwarded-for':'203.0.113.8'},socket:{}};
  const flaky={execute:async statement=>{if(++calls<=2)throw Object.assign(new Error('locked'),{code:'SQLITE_BUSY'});return currentDb.execute(statement);}};
  assert.equal((await enforceDailyVideoRateLimit(flaky,{req:request,userId:2,secret:SECRET})).allowed,true);
  assert.equal(calls,4);
  let failed=0;const saturated={execute:async()=>{failed++;throw Object.assign(new Error('locked'),{code:'SQLITE_LOCKED'});}};
  await assert.rejects(enforceDailyVideoRateLimit(saturated,{req:request,userId:2,secret:SECRET}));assert.equal(failed,4);
  let unknown=0;const uncertain={execute:async()=>{unknown++;throw new Error('lost acknowledgement');}};
  await assert.rejects(enforceDailyVideoRateLimit(uncertain,{req:request,userId:2,secret:SECRET}));assert.equal(unknown,1);
});

test('#490 provider error strings cannot smuggle identifiers into logs; failed tokens keep their reservation',async()=>{
  currentDb=await readyDatabase(); enable();
  const warnings=[],originalWarn=console.warn; console.warn=(...args)=>warnings.push(args.join(' '));
  const secrets=[dailyRoomName('week_10_pair_20',SECRET),'private-participant-id','private-token'];
  try{
    for(const secret of secrets){
      provider.fail=path=>path==='/v1/meeting-tokens'?new Response(JSON.stringify({error:secret,info:secret}),{status:502}):undefined;
      assert.equal((await invoke()).status,503);
      assert.equal(dailyErrorCode({error:secret}),null);
    }
  }finally{ console.warn=originalWarn; }
  assert.equal((await currentDb.execute("SELECT SUM(attempts) AS n FROM auth_rate_limits WHERE key GLOB 'dvb1:p:*' AND key NOT GLOB '*:paused'")).rows[0].n,120);
  for(const secret of secrets) assert.equal(warnings.join(' ').includes(secret),false);
});
