// Issue #305 (ID-107): POST /api/video/turn mints short-lived Cloudflare
// Realtime TURN credentials for a member of the direct call's room. Cloudflare
// is never contacted: globalThis.fetch is replaced by an in-memory provider
// that records every request.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, mock, test } from 'node:test';
import { createClient } from '@libsql/client';

import {
  CLOUDFLARE_TURN_API_BASE,
  TURN_LIMITS,
  TURN_MAX_TTL_SECONDS,
  TURN_PROVIDER_TIMEOUT_MS,
  TURN_RATE_LIMITS,
  TurnProviderError,
  cloudflareTurnCredentialsUrl,
  enforceTurnRelayRateLimit,
  mintTurnIceServers,
  parseCloudflareIceServers,
  turnGrantWindow,
  turnRelayConfiguration,
} from '../../api/_turn-relay.js';

let currentDb=null;
let currentDirectory=null;
const SECRET='turn-relay-test-secret-at-least-thirty-two-characters';
const KEY_ID='0123456789abcdef0123456789abcdef';
const API_TOKEN='cf-turn-api-token-SECRET-0123456789abcdef';
const USERNAME='turn-username-SECRET-0123456789abcdef';
const CREDENTIAL='turn-credential-SECRET-abcdef0123456789';
const ENV_KEYS=['TURN_RELAY_ENABLED','CLOUDFLARE_TURN_KEY_ID','CLOUDFLARE_TURN_API_TOKEN','RANDORI_LOCAL_RUNTIME',
  'INTERVIEW_SESSION_ENABLED','CIRCLE_MEMBERSHIP_ENABLED','MULTI_CIRCLE_CONTROL_PLANE_ENABLED',
  'MULTI_CIRCLE_AVAILABILITY_ENABLED','SECONDARY_CIRCLE_COORDINATION_ENABLED','SECONDARY_CIRCLE_WORKSPACE_ENABLED',
  'DAILY_VIDEO_ENABLED'];

function authPayload(req){
  const identity=req?.headers?.['x-test-auth'];
  if(identity==='member') return {id:2,email:'member@example.test'};
  if(identity==='uid-member') return {uid:2,email:'member@example.test'};
  if(identity==='partner') return {id:4,email:'partner@example.test'};
  if(identity==='third') return {id:6,email:'third@example.test'};
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

function cloudflareServers({username=USERNAME,credential=CREDENTIAL}={}){
  return {iceServers:[
    {urls:['stun:stun.cloudflare.com:3478','stun:stun.cloudflare.com:53']},
    {urls:['turn:turn.cloudflare.com:3478?transport=udp','turn:turn.cloudflare.com:53?transport=udp',
      'turn:turn.cloudflare.com:3478?transport=tcp','turns:turn.cloudflare.com:5349?transport=tcp',
      'turns:turn.cloudflare.com:443?transport=tcp'],username,credential},
  ]};
}

class FakeCloudflare{
  constructor(){ this.requests=[]; this.respond=null; }
  fetch=async(url,init)=>{
    this.requests.push({url:String(url),method:init?.method,headers:init?.headers,
      body:init?.body?JSON.parse(init.body):null,redirect:init?.redirect,signal:init?.signal});
    if(this.respond) return this.respond(url,init);
    return new Response(JSON.stringify(cloudflareServers()),{status:201,headers:{'content-type':'application/json'}});
  };
}

let provider;
let originalFetch;

function invoke({method='POST',url='/api/video/turn',query={endpoint:'turn'},headers={'x-test-auth':'member'},
  body={room_id:'week_10_pair_20'},address='198.51.100.7'}={}){
  return new Promise((resolve,reject)=>{
    let statusCode=200,settled=false;
    const responseHeaders={};
    const finish=value=>{ if(!settled){ settled=true; resolve({status:statusCode,headers:responseHeaders,body:value}); } };
    const res={
      status(code){ statusCode=code; return this; },
      setHeader(name,value){ responseHeaders[String(name).toLowerCase()]=value; },
      json(value){ finish(value); return this; },end(value){ finish(value); return this; },
    };
    const req={method,url,query,headers:{'x-forwarded-for':address,...headers},body,socket:{remoteAddress:address}};
    Promise.resolve(videoHandler(req,res)).then(()=>finish(undefined)).catch(reject);
  });
}

async function readyDatabase(){
  currentDirectory=mkdtempSync(join(tmpdir(),'randori-turn-relay-'));
  const db=createClient({url:`file:${join(currentDirectory,'test.sqlite')}`});
  await db.batch([
    `CREATE TABLE auth_accounts (id INTEGER PRIMARY KEY,display_name TEXT NOT NULL)`,
    `CREATE TABLE auth_rate_limits (key TEXT PRIMARY KEY, attempts INTEGER NOT NULL DEFAULT 0, expires_at INTEGER NOT NULL)`,
    `CREATE TABLE pairing_groups (id INTEGER PRIMARY KEY,week_id INTEGER NOT NULL,user_a_id INTEGER NOT NULL,user_b_id INTEGER NOT NULL,user_c_id INTEGER,is_ai_pair INTEGER)`,
    `CREATE TABLE pairing_participants (week_id INTEGER NOT NULL,user_id INTEGER NOT NULL,source TEXT NOT NULL,PRIMARY KEY(week_id,user_id))`,
    `CREATE TABLE session_completion_receipts (week_id INTEGER NOT NULL,pair_group_id INTEGER NOT NULL,user_id INTEGER NOT NULL,participant_source TEXT NOT NULL,pair_user_a_id INTEGER NOT NULL,pair_user_b_id INTEGER NOT NULL,pair_user_c_id INTEGER,confirmed_at TEXT NOT NULL,PRIMARY KEY(week_id,pair_group_id,user_id))`,
    `CREATE TABLE pair_session_controls (week_id INTEGER NOT NULL,pair_group_id INTEGER NOT NULL,pair_user_a_id INTEGER NOT NULL,pair_user_a_source TEXT NOT NULL,pair_user_b_id INTEGER NOT NULL,pair_user_b_source TEXT NOT NULL,pair_user_c_id INTEGER,candidate_user_id INTEGER NOT NULL,candidate_source TEXT NOT NULL,timer_state TEXT NOT NULL,remaining_ms INTEGER NOT NULL,anchor_at TEXT,revision INTEGER NOT NULL,updated_by INTEGER NOT NULL,updated_by_source TEXT NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,PRIMARY KEY(week_id,pair_group_id))`,
    `INSERT INTO auth_accounts (id,display_name) VALUES (2,'Member Private Name'),(4,'Partner Private Name'),(6,'Third'),(9,'Outsider')`,
    // 20: the primary human pair; 21: a triad (third member signed in).
    `INSERT INTO pairing_groups (id,week_id,user_a_id,user_b_id,user_c_id,is_ai_pair) VALUES
      (20,10,2,4,NULL,0),(21,10,2,4,6,0)`,
    `INSERT INTO pairing_participants (week_id,user_id,source) VALUES
      (10,2,'auth'),(10,4,'auth'),(10,6,'auth'),(10,9,'auth')`,
  ],'write');
  return db;
}

async function seedControls(db,{timerState='paused',remainingMs=25*60*1000}={}){
  await db.execute({sql:`INSERT INTO pair_session_controls
    (week_id,pair_group_id,pair_user_a_id,pair_user_a_source,pair_user_b_id,pair_user_b_source,
      pair_user_c_id,candidate_user_id,candidate_source,timer_state,remaining_ms,anchor_at,
      revision,updated_by,updated_by_source,created_at,updated_at)
    VALUES (10,20,2,'auth',4,'auth',NULL,2,'auth',?,?,NULL,
      1,2,'auth',strftime('%Y-%m-%dT%H:%M:%fZ','now'),strftime('%Y-%m-%dT%H:%M:%fZ','now'))`,
  args:[timerState,remainingMs]});
}

function enable(){
  Object.assign(process.env,{TURN_RELAY_ENABLED:'true',CLOUDFLARE_TURN_KEY_ID:KEY_ID,CLOUDFLARE_TURN_API_TOKEN:API_TOKEN});
}

function captureWarnings(){
  const warnings=[]; const originalWarn=console.warn; const originalError=console.error; const originalLog=console.log;
  const push=(...args)=>warnings.push(args.map(String).join(' '));
  console.warn=push; console.error=push; console.log=push;
  return {warnings,restore(){ console.warn=originalWarn; console.error=originalError; console.log=originalLog; }};
}

beforeEach(()=>{
  currentDb=null; selectedWorkspace=null; dispatchedSecondary.length=0;
  for(const key of ENV_KEYS) delete process.env[key];
  provider=new FakeCloudflare();
  originalFetch=globalThis.fetch;
  globalThis.fetch=provider.fetch;
});
afterEach(()=>{
  globalThis.fetch=originalFetch;
  try{ currentDb?.close?.(); }catch{} currentDb=null;
  if(currentDirectory){ rmSync(currentDirectory,{recursive:true,force:true}); currentDirectory=null; }
  for(const key of ENV_KEYS) delete process.env[key];
});

test('the flag is literal true only and requires a well-formed key id and server-only token',()=>{
  const valid={TURN_RELAY_ENABLED:'true',CLOUDFLARE_TURN_KEY_ID:KEY_ID,CLOUDFLARE_TURN_API_TOKEN:API_TOKEN};
  assert.deepEqual({...turnRelayConfiguration(valid)},{keyId:KEY_ID,apiToken:API_TOKEN});
  assert.deepEqual({...turnRelayConfiguration({...valid,CLOUDFLARE_TURN_KEY_ID:` ${KEY_ID} `})},{keyId:KEY_ID,apiToken:API_TOKEN});
  for(const env of [
    {},{TURN_RELAY_ENABLED:'true'},{...valid,TURN_RELAY_ENABLED:'TRUE'},{...valid,TURN_RELAY_ENABLED:'1'},
    {...valid,TURN_RELAY_ENABLED:'yes'},{...valid,TURN_RELAY_ENABLED:'false'},
    {...valid,CLOUDFLARE_TURN_KEY_ID:''},{...valid,CLOUDFLARE_TURN_KEY_ID:'short'},
    {...valid,CLOUDFLARE_TURN_KEY_ID:'../../accounts/x/abc'},{...valid,CLOUDFLARE_TURN_KEY_ID:'a'.repeat(129)},
    {...valid,CLOUDFLARE_TURN_API_TOKEN:''},{...valid,CLOUDFLARE_TURN_API_TOKEN:'short'},
    {...valid,CLOUDFLARE_TURN_API_TOKEN:'has spaces in the token value 12345'},
    {...valid,RANDORI_LOCAL_RUNTIME:'true'},
  ]) assert.equal(turnRelayConfiguration(env),null,JSON.stringify(env));
  assert.equal(turnRelayConfiguration(),null,'reads process.env by default');
});

test('the adapter has one Cloudflare endpoint shape',()=>{
  assert.equal(CLOUDFLARE_TURN_API_BASE,'https://rtc.live.cloudflare.com/v1/turn/keys');
  assert.equal(cloudflareTurnCredentialsUrl(KEY_ID),
    `https://rtc.live.cloudflare.com/v1/turn/keys/${KEY_ID}/credentials/generate-ice-servers`);
  assert.equal(cloudflareTurnCredentialsUrl('a/b?c'),
    'https://rtc.live.cloudflare.com/v1/turn/keys/a%2Fb%3Fc/credentials/generate-ice-servers');
});

test('with the flag off the route is a typed 404 for everyone and never contacts the provider',async()=>{
  currentDb=await readyDatabase();
  process.env.CLOUDFLARE_TURN_KEY_ID=KEY_ID; process.env.CLOUDFLARE_TURN_API_TOKEN=API_TOKEN;
  for(const flag of [undefined,'false','TRUE','1']){
    if(flag===undefined) delete process.env.TURN_RELAY_ENABLED; else process.env.TURN_RELAY_ENABLED=flag;
    for(const headers of [{'x-test-auth':'member'},{'x-test-auth':'outsider'},{}]){
      const response=await invoke({headers});
      assert.equal(response.status,404);
      assert.deepEqual(response.body,{error:'call relay unavailable',code:'turn_relay_disabled'});
      assert.equal(response.headers['cache-control'],'private, no-store');
    }
  }
  enable(); process.env.CLOUDFLARE_TURN_API_TOKEN='';
  assert.equal((await invoke()).status,404,'a missing token is the same as off');
  enable(); process.env.RANDORI_LOCAL_RUNTIME='true';
  assert.equal((await invoke()).status,404,'never in the local runtime');
  assert.equal(provider.requests.length,0);
  // The signalling route is untouched by the new endpoint.
  delete process.env.RANDORI_LOCAL_RUNTIME;
  const signal=await invoke({url:'/api/video/signal',query:{endpoint:'signal'},body:{}});
  assert.equal(signal.status,400);
});

test('a pair member gets STUN and TURN servers with an expiry, nothing else',async()=>{
  currentDb=await readyDatabase(); enable();
  const before=Date.now();
  const response=await invoke();
  assert.equal(response.status,200,JSON.stringify(response.body));
  assert.equal(response.headers['cache-control'],'private, no-store');
  assert.deepEqual(Object.keys(response.body).sort(),['expiresAt','iceServers']);
  assert.deepEqual(response.body.iceServers,[
    {urls:['stun:stun.cloudflare.com:3478']},
    {urls:['turn:turn.cloudflare.com:3478?transport=udp','turn:turn.cloudflare.com:3478?transport=tcp',
      'turns:turn.cloudflare.com:5349?transport=tcp','turns:turn.cloudflare.com:443?transport=tcp'],
    username:USERNAME,credential:CREDENTIAL},
  ],'browser-blocked :53 alternates are dropped');
  const expiresAt=Date.parse(response.body.expiresAt);
  assert.ok(expiresAt>=Math.floor(before/1000)*1000+TURN_MAX_TTL_SECONDS*1000);
  assert.ok(expiresAt<=Date.now()+TURN_MAX_TTL_SECONDS*1000);

  assert.equal(provider.requests.length,1);
  const [request]=provider.requests;
  assert.equal(request.method,'POST');
  assert.equal(request.url,cloudflareTurnCredentialsUrl(KEY_ID));
  assert.equal(request.headers.authorization,`Bearer ${API_TOKEN}`);
  assert.equal(request.headers['content-type'],'application/json');
  assert.equal(request.redirect,'error','no redirects');
  assert.ok(request.signal instanceof AbortSignal,'the provider call has a deadline');
  assert.equal(request.signal.aborted,false);
  assert.equal(TURN_PROVIDER_TIMEOUT_MS,5000);
  assert.deepEqual(request.body,{ttl:TURN_MAX_TTL_SECONDS});
  assert.doesNotMatch(JSON.stringify(request.body),/Private Name|member@|week_10|pair_20/,
    'no name, email or Randori room id reaches the provider');

  for(const identity of ['uid-member','partner']){
    const other=await invoke({headers:{'x-test-auth':identity}});
    assert.equal(other.status,200,identity);
  }
});

test('the direct call signalling authorization decides: outsiders and unknown rooms get the identical 404',async()=>{
  currentDb=await readyDatabase(); enable();
  const denied=await Promise.all([
    invoke({headers:{'x-test-auth':'outsider'}}),
    invoke({body:{room_id:'week_10_pair_99'}}),
    invoke({body:{room_id:'week_11_pair_20'}}),
    invoke({headers:{'x-test-auth':'third'}}),
  ]);
  for(const response of denied){
    assert.equal(response.status,404);
    assert.deepEqual(response.body,{error:'pair not found'});
  }
  assert.equal(provider.requests.length,0);
  // A triad is a signalling room too, so its members (all three) may relay.
  const triad=await invoke({headers:{'x-test-auth':'third'},body:{room_id:'week_10_pair_21'}});
  assert.equal(triad.status,200,JSON.stringify(triad.body));
  assert.deepEqual(provider.requests.at(-1).body,{ttl:TURN_MAX_TTL_SECONDS});
  // Active primary membership is required while circle membership is on.
  process.env.CIRCLE_MEMBERSHIP_ENABLED='true';
  await currentDb.batch([
    `CREATE TABLE circles (id INTEGER PRIMARY KEY,is_primary INTEGER NOT NULL,archived_at TEXT)`,
    `CREATE TABLE circle_memberships (circle_id INTEGER NOT NULL,user_id INTEGER NOT NULL,status TEXT NOT NULL)`,
    `INSERT INTO circles (id,is_primary,archived_at) VALUES (1,1,NULL)`,
    `INSERT INTO circle_memberships (circle_id,user_id,status) VALUES (1,2,'active'),(1,4,'removed')`,
  ],'write');
  assert.equal((await invoke()).status,200);
  assert.equal((await invoke({headers:{'x-test-auth':'partner'}})).status,404);
});

test('authentication, method, origin, query and body are checked before anything else',async()=>{
  currentDb=await readyDatabase(); enable();
  const unauthenticated=await invoke({headers:{}});
  assert.equal(unauthenticated.status,401);
  const get=await invoke({method:'GET'});
  assert.equal(get.status,405); assert.equal(get.headers.allow,'POST');
  assert.equal(get.headers['cache-control'],'private, no-store');
  const crossOrigin=await invoke({headers:{'x-test-auth':'member',origin:'https://evil.example.test'}});
  assert.equal(crossOrigin.status,403);
  for(const body of [null,[],{},{room_id:'week_10_pair_20',extra:true},{room_id:20},
    {room_id:'w10-p2-4'},{room_id:' week_10_pair_20'},{room_id:'week_10_pair_20/../x'}]){
    const response=await invoke({body});
    assert.equal(response.status,400,JSON.stringify(body));
  }
  for(const [url,query] of [
    ['/api/video/turn?debug=1',{endpoint:'turn',debug:'1'}],
    ['/api/video/turn?endpoint=turn&endpoint=turn',{endpoint:'turn'}],
    ['/api/video/turn',{endpoint:['turn','turn']}],
  ]){
    const response=await invoke({url,query});
    assert.equal(response.status,400,url);
  }
  assert.equal(provider.requests.length,0);
});

test('secondary-circle rooms never get a relay pass',async()=>{
  currentDb=await readyDatabase(); enable();
  Object.assign(process.env,{CIRCLE_MEMBERSHIP_ENABLED:'true',MULTI_CIRCLE_CONTROL_PLANE_ENABLED:'true',
    MULTI_CIRCLE_AVAILABILITY_ENABLED:'true',SECONDARY_CIRCLE_COORDINATION_ENABLED:'true',SECONDARY_CIRCLE_WORKSPACE_ENABLED:'true'});
  await currentDb.batch([
    `CREATE TABLE circles (id INTEGER PRIMARY KEY,is_primary INTEGER NOT NULL,archived_at TEXT)`,
    `CREATE TABLE circle_memberships (circle_id INTEGER NOT NULL,user_id INTEGER NOT NULL,status TEXT NOT NULL)`,
    `INSERT INTO circles (id,is_primary,archived_at) VALUES (1,1,NULL)`,
    `INSERT INTO circle_memberships (circle_id,user_id,status) VALUES (1,2,'active')`,
  ],'write');
  selectedWorkspace={mode:'secondary',db:currentDb,context:{}};
  const response=await invoke();
  assert.equal(response.status,404);
  assert.deepEqual(response.body,{error:'pair not found'});
  assert.equal(dispatchedSecondary.length,0);
  selectedWorkspace={mode:'primary',db:currentDb,context:{}};
  assert.equal((await invoke()).status,200,'a selected primary room keeps the normal route');
});

test('an interview room credential never outlives the shared timer, and a finished session gets none',async()=>{
  currentDb=await readyDatabase(); enable(); process.env.INTERVIEW_SESSION_ENABLED='true';
  await seedControls(currentDb,{timerState:'paused',remainingMs:12*60*1000+500});
  const response=await invoke();
  assert.equal(response.status,200,JSON.stringify(response.body));
  assert.deepEqual(provider.requests[0].body,{ttl:12*60});
  await currentDb.execute(`UPDATE pair_session_controls SET remaining_ms=0`);
  const ended=await invoke();
  assert.equal(ended.status,409);
  assert.equal(ended.body.code,'interview_session_ended');
  assert.equal(provider.requests.length,1);
});

test('the grant window is min(call window, one hour)',()=>{
  const nowMs=Date.parse('2026-11-19T12:00:00.250Z');
  assert.deepEqual({...turnGrantWindow({nowMs})},{ttlSeconds:3600,expiresAtMs:Date.parse('2026-11-19T13:00:00.000Z')});
  assert.equal(turnGrantWindow({nowMs,state:{interview_mode:false,remaining_ms:1}}).ttlSeconds,3600);
  assert.equal(turnGrantWindow({nowMs,state:{interview_mode:true,remaining_ms:90_999}}).ttlSeconds,90);
  assert.equal(turnGrantWindow({nowMs,state:{interview_mode:true,remaining_ms:5*3600*1000}}).ttlSeconds,3600);
  assert.equal(turnGrantWindow({nowMs,state:{interview_mode:true,remaining_ms:0}}).ttlSeconds,0);
  assert.equal(turnGrantWindow({nowMs,state:{interview_mode:true,remaining_ms:'x'}}).ttlSeconds,0);
  assert.ok(turnGrantWindow().expiresAtMs>Date.now());
});

test('completed non-interview sessions get a typed 409',async()=>{
  currentDb=await readyDatabase(); enable();
  await currentDb.execute(`INSERT INTO session_completion_receipts VALUES
    (10,20,2,'auth',2,4,NULL,strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    (10,20,4,'auth',2,4,NULL,strftime('%Y-%m-%dT%H:%M:%fZ','now'))`);
  const response=await invoke();
  assert.equal(response.status,409,JSON.stringify(response.body));
  assert.equal(response.body.code,'session_completed');
  assert.equal(provider.requests.length,0);
});

test('requests are rate limited per account and per network with a keyed counter',async()=>{
  currentDb=await readyDatabase(); enable();
  for(let index=0;index<TURN_RATE_LIMITS.account;index+=1){
    assert.equal((await invoke()).status,200);
  }
  const limited=await invoke();
  assert.equal(limited.status,429);
  assert.equal(limited.body.code,'turn_relay_rate_limited');
  assert.ok(Number(limited.headers['retry-after'])>=1);
  assert.equal(provider.requests.length,TURN_RATE_LIMITS.account);
  const keys=(await currentDb.execute('SELECT key FROM auth_rate_limits')).rows.map(row=>String(row.key));
  assert.ok(keys.every(key=>/^[a-f0-9]{64}$/.test(key)),'only HMAC keys are stored');

  const nowSeconds=Math.floor(Date.now()/1000)+3600;
  const req={headers:{'x-forwarded-for':'203.0.113.9'},socket:{}};
  for(let index=0;index<TURN_RATE_LIMITS.address;index+=1){
    const rate=await enforceTurnRelayRateLimit(currentDb,{req,userId:100+index,secret:SECRET,nowSeconds});
    assert.equal(rate.allowed,true);
  }
  const network=await enforceTurnRelayRateLimit(currentDb,{req,userId:999,secret:SECRET,nowSeconds});
  assert.equal(network.allowed,false); assert.equal(network.dimension,'address');
  assert.ok((await enforceTurnRelayRateLimit(currentDb,{req,userId:999,secret:SECRET})).allowed,'default clock');
});

test('database or readiness failures are a typed 503 without contacting the provider',async()=>{
  enable();
  currentDb={execute:async()=>{ throw new Error('database down'); },transaction:async()=>{ throw new Error('down'); }};
  const response=await invoke();
  assert.equal(response.status,503);
  assert.deepEqual(response.body,{error:'call relay unavailable',code:'turn_relay_unavailable'});
  // Rate limiting fails after readiness passes.
  currentDb=await readyDatabase();
  await currentDb.execute('DROP TABLE auth_rate_limits');
  assert.equal((await invoke()).status,503);
  // The authorization read fails after the limiter passes.
  await currentDb.execute(`CREATE TABLE auth_rate_limits (key TEXT PRIMARY KEY, attempts INTEGER NOT NULL DEFAULT 0, expires_at INTEGER NOT NULL)`);
  const real=currentDb;
  currentDb={
    execute:statement=>{
      if(String(statement?.sql||statement).includes('FROM pairing_groups AS pg')
        &&!String(statement?.sql||statement).includes('WITH access')) throw new Error('pair read failed');
      return real.execute(statement);
    },
    transaction:mode=>real.transaction(mode),batch:(...args)=>real.batch(...args),
  };
  assert.equal((await invoke()).status,503);
  currentDb=real;
  assert.equal(provider.requests.length,0);
});

test('provider failures are a typed 503 and the log carries no credential, token or key id',async()=>{
  currentDb=await readyDatabase(); enable();
  const json=(status,value)=>new Response(JSON.stringify(value),{status,headers:{'content-type':'application/json'}});
  const failures=[
    ()=>{ throw new TypeError(`network down ${API_TOKEN}`); },
    ()=>json(401,{success:false,errors:[{message:`bad token ${API_TOKEN}`}]}),
    ()=>json(500,cloudflareServers()),
    ()=>new Response(`not json ${CREDENTIAL}`,{status:201}),
    ()=>json(201,{iceServers:[{urls:'turn:turn.evil.example:3478',username:USERNAME,credential:CREDENTIAL}]}),
    ()=>json(201,{iceServers:[{urls:'stun:stun.cloudflare.com:3478'}]}),
    ()=>new Response(JSON.stringify({...cloudflareServers(),pad:'x'.repeat(TURN_LIMITS.responseBytes)}),{status:201}),
  ];
  const capture=captureWarnings();
  try{
    for(const failure of failures){
      provider.respond=failure;
      const response=await invoke();
      assert.equal(response.status,503);
      assert.deepEqual(response.body,{error:'call relay unavailable',code:'turn_relay_unavailable'});
      assert.doesNotMatch(JSON.stringify(response.body),/SECRET|turn:|stun:/);
    }
  }finally{ capture.restore(); }
  assert.equal(capture.warnings.length,failures.length);
  for(const line of capture.warnings){
    assert.match(line,/^\[video\] turn relay unavailable \{"stage":"(request|status|response)","status":(null|\d{3})\}$/);
    assert.doesNotMatch(line,new RegExp([API_TOKEN,KEY_ID,USERNAME,CREDENTIAL,'SECRET'].join('|')));
  }
  // A successful mint logs nothing at all.
  provider.respond=null;
  const quiet=captureWarnings();
  try{ assert.equal((await invoke()).status,200); }finally{ quiet.restore(); }
  assert.deepEqual(quiet.warnings,[]);
});

test('an unexpected error is still a typed 503 with an opaque log line',async()=>{
  currentDb=await readyDatabase(); enable();
  provider.respond=()=>({get status(){ throw new RangeError('response broke'); }});
  const capture=captureWarnings();
  let response;
  try{ response=await invoke(); }finally{ capture.restore(); }
  assert.equal(response.status,503);
  assert.deepEqual(capture.warnings,['[video] turn relay unavailable {"stage":"unexpected","status":null}']);
});

test('the provider deadline aborts a hung request as a request failure',async()=>{
  const config=turnRelayConfiguration({TURN_RELAY_ENABLED:'true',CLOUDFLARE_TURN_KEY_ID:KEY_ID,CLOUDFLARE_TURN_API_TOKEN:API_TOKEN});
  const window=turnGrantWindow();
  let seen;
  const hung=(_url,init)=>new Promise((_resolve,reject)=>{
    seen=init.signal;
    init.signal.addEventListener('abort',()=>reject(init.signal.reason));
  });
  const pending=mintTurnIceServers(config,{window,fetchImpl:hung});
  // Abort exactly as AbortSignal.timeout(5000) would, without waiting 5 s.
  assert.ok(seen instanceof AbortSignal);
  seen.dispatchEvent(new Event('abort'));
  await assert.rejects(pending,error=>error instanceof TurnProviderError&&error.stage==='request'&&error.status===null);
  // A body read that fails (for example, aborted mid-stream) is also a request failure.
  const brokenBody={status:201,headers:new Headers(),text:async()=>{ throw new Error('aborted'); }};
  await assert.rejects(mintTurnIceServers(config,{window,fetchImpl:async()=>brokenBody}),
    error=>error.stage==='request'&&error.status===201);
  await assert.rejects(mintTurnIceServers(null,{window,fetchImpl:hung}),error=>error.stage==='configuration');
  await assert.rejects(mintTurnIceServers(config,{window:{ttlSeconds:0},fetchImpl:hung}),error=>error.stage==='configuration');
  // A declared oversize body is refused before it is read.
  let read=false;
  const declared={status:200,headers:new Headers({'content-length':String(TURN_LIMITS.responseBytes+1)}),text:async()=>{ read=true; return '{}'; }};
  await assert.rejects(mintTurnIceServers(config,{window,fetchImpl:async()=>declared}),error=>error.stage==='response');
  assert.equal(read,false);
  const ok=await mintTurnIceServers(config,{window,fetchImpl:async()=>new Response(JSON.stringify(cloudflareServers()),{status:200})});
  assert.equal(ok.iceServers.length,2);
  assert.equal(ok.expiresAt,new Date(window.expiresAtMs).toISOString());
});

test('provider responses are validated strictly',()=>{
  const turn=(urls,extra={})=>({iceServers:[{urls,username:USERNAME,credential:CREDENTIAL,...extra}]});
  const accepted=parseCloudflareIceServers({iceServers:[
    {urls:'stun:stun.cloudflare.com'},
    {urls:'turn:cloudflare.com:3478',username:USERNAME,credential:CREDENTIAL,credentialType:'password',extra:'dropped'},
  ]});
  assert.deepEqual(accepted,[{urls:['stun:stun.cloudflare.com']},
    {urls:['turn:cloudflare.com:3478'],username:USERNAME,credential:CREDENTIAL}],'unknown fields are never copied');
  assert.deepEqual(parseCloudflareIceServers(turn(['turns:turn.cloudflare.com:443?transport=tcp','turn:turn.cloudflare.com:53'])),
    [{urls:['turns:turn.cloudflare.com:443?transport=tcp'],username:USERNAME,credential:CREDENTIAL}]);
  assert.deepEqual(parseCloudflareIceServers({iceServers:[{urls:['stun:stun.cloudflare.com:53']},
    {urls:'turn:turn.cloudflare.com:3478',username:'u',credential:'c'}]}),
  [{urls:['turn:turn.cloudflare.com:3478'],username:'u',credential:'c'}],'an all-:53 entry is dropped');
  assert.deepEqual(parseCloudflareIceServers({iceServers:[{urls:'stun:stun.cloudflare.com',username:'u',credential:'c'},
    {urls:'turn:turn.cloudflare.com',username:'u',credential:'c'}]})[0],{urls:['stun:stun.cloudflare.com'],username:'u',credential:'c'});

  const rejected=[
    null,[],'x',{},{iceServers:{}},{iceServers:[]},
    {iceServers:Array.from({length:TURN_LIMITS.entries+1},()=>({urls:'turn:turn.cloudflare.com',username:'u',credential:'c'}))},
    {iceServers:[null]},{iceServers:[[]]},{iceServers:[{}]},{iceServers:[{urls:[]}]},{iceServers:[{urls:42}]},
    // Only STUN: nothing to relay.
    {iceServers:[{urls:'stun:stun.cloudflare.com:3478'}]},
    {iceServers:[{urls:'turn:turn.cloudflare.com:53',username:'u',credential:'c'}]},
    // Non-Cloudflare hosts.
    turn('turn:turn.example.com:3478'),turn('turn:evilcloudflare.com:3478'),turn('turn:turn.cloudflare.com.evil.test:3478'),
    turn('turn:cloudflare.co:3478'),turn('turn:[::1]:3478'),turn('turn:203.0.113.5:3478'),turn('turn:user@turn.cloudflare.com'),
    // Bad schemes and shapes.
    turn('http://turn.cloudflare.com'),turn('https://turn.cloudflare.com'),turn('turnx:turn.cloudflare.com'),
    turn('TURN:turn.cloudflare.com'),turn('turn:Turn.Cloudflare.com'),turn('turn:turn.cloudflare.com:0'),
    turn('turn:turn.cloudflare.com:70000'),turn('turn:turn.cloudflare.com:3478?transport=sctp'),
    turn('turn:turn.cloudflare.com:3478?transport=udp&x=1'),turn('turn:turn.cloudflare.com/path'),
    turn('turn:turn.cloudflare.com:3478 '),turn('turn:-bad.cloudflare.com'),
    {iceServers:[{urls:'stun:stun.cloudflare.com:3478?transport=udp'},{urls:'turn:turn.cloudflare.com',username:'u',credential:'c'}]},
    // Oversize.
    turn(`turn:${'a'.repeat(TURN_LIMITS.urlLength)}.cloudflare.com`),
    turn(Array.from({length:TURN_LIMITS.urlsPerEntry+1},()=>'turn:turn.cloudflare.com')),
    {iceServers:[{urls:Array.from({length:9},()=>'turn:turn.cloudflare.com'),username:'u',credential:'c'},
      {urls:Array.from({length:8},()=>'turn:turn.cloudflare.com'),username:'u',credential:'c'}]},
    turn('turn:turn.cloudflare.com',{credential:'c'.repeat(TURN_LIMITS.credentialLength+1)}),
    turn('turn:turn.cloudflare.com',{username:'u'.repeat(TURN_LIMITS.credentialLength+1)}),
    // Credentials missing, unpaired or malformed on a relay.
    {iceServers:[{urls:'turn:turn.cloudflare.com'}]},
    {iceServers:[{urls:'turn:turn.cloudflare.com',username:'u'}]},
    {iceServers:[{urls:'turn:turn.cloudflare.com',credential:'c'}]},
    turn('turn:turn.cloudflare.com',{username:''}),turn('turn:turn.cloudflare.com',{username:'has space'}),
    turn('turn:turn.cloudflare.com',{credential:42}),turn('turn:turn.cloudflare.com',{credential:'line\nbreak'}),
  ];
  for(const payload of rejected){
    assert.throws(()=>parseCloudflareIceServers(payload),
      error=>error instanceof TurnProviderError&&error.stage==='response',JSON.stringify(payload)?.slice(0,160));
  }
});
