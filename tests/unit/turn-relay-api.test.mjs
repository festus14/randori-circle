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
  TURN_DEFAULT_RESERVE_MB_PER_CALL,
  TURN_LIMITS,
  TURN_MAX_TTL_SECONDS,
  TURN_PROVIDER_TIMEOUT_MS,
  TURN_RATE_LIMITS,
  TurnProviderError,
  cloudflareTurnCredentialsUrl,
  enforceTurnRelayRateLimit,
  meteredCredentialsUrl,
  meteredUsageUrl,
  mintTurnIceServers,
  parseBudgetGb,
  parseCloudflareIceServers,
  parseMeteredIceServers,
  parseProviderIceServers,
  turnGrantWindow,
  turnProviderStates,
  turnRelayConfiguration,
  turnReserveMbPerCall,
} from '../../api/_turn-relay.js';

let currentDb=null;
let currentDirectory=null;
const SECRET='turn-relay-test-secret-at-least-thirty-two-characters';
const KEY_ID='0123456789abcdef0123456789abcdef';
const API_TOKEN='cf-turn-api-token-SECRET-0123456789abcdef';
const USERNAME='turn-username-SECRET-0123456789abcdef';
const CREDENTIAL='turn-credential-SECRET-abcdef0123456789';
const ACCOUNT_ID='0123456789abcdef0123456789abcdef'.replace(/0/g,'a');
const ANALYTICS_TOKEN='cf-analytics-token-SECRET-0123456789abcdef';
const METERED_DOMAIN='randori-circle.metered.live';
const METERED_API_KEY='metered-api-key-SECRET-0123456789';
const METERED_SECRET='metered-secret-key-SECRET-0123456789';
const ENV_KEYS=['TURN_RELAY_ENABLED','CLOUDFLARE_TURN_KEY_ID','CLOUDFLARE_TURN_API_TOKEN','RANDORI_LOCAL_RUNTIME',
  'CLOUDFLARE_ACCOUNT_ID','CLOUDFLARE_ANALYTICS_API_TOKEN','TURN_MONTHLY_GB_BUDGET','TURN_RESERVE_MB_PER_CALL',
  'METERED_TURN_APP_DOMAIN','METERED_TURN_API_KEY','METERED_TURN_SECRET_KEY','METERED_TURN_MONTHLY_GB_BUDGET',
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

function meteredServers({username=USERNAME,credential=CREDENTIAL}={}){
  return [
    {urls:'stun:stun.relay.metered.ca:80'},
    {urls:'turn:global.relay.metered.ca:80',username,credential},
    {urls:'turn:global.relay.metered.ca:80?transport=tcp',username,credential},
    {urls:'turn:global.relay.metered.ca:443',username,credential},
    {urls:'turns:global.relay.metered.ca:443?transport=tcp',username,credential},
  ];
}

const json=(status,value)=>new Response(JSON.stringify(value),{status,headers:{'content-type':'application/json'}});

// Routes by URL: Cloudflare credentials and GraphQL usage, Metered
// credentials and usage. `respond[kind]` overrides one kind.
class FakeProviders{
  constructor(){ this.requests=[]; this.respond={}; this.cloudflareBytes=0; this.meteredGb=0; }
  kind(url){
    const parsed=new URL(url);
    if(parsed.host==='rtc.live.cloudflare.com') return 'cloudflare';
    if(parsed.host==='api.cloudflare.com') return 'cloudflareUsage';
    if(parsed.pathname.endsWith('/current_usage')) return 'meteredUsage';
    return 'metered';
  }
  fetch=async(url,init)=>{
    const kind=this.kind(String(url));
    this.requests.push({kind,url:String(url),method:init?.method,headers:init?.headers,
      body:init?.body?JSON.parse(init.body):null,redirect:init?.redirect,signal:init?.signal});
    if(this.respond[kind]) return this.respond[kind](url,init);
    if(kind==='cloudflare') return json(201,cloudflareServers());
    if(kind==='cloudflareUsage') return json(200,{data:{viewer:{accounts:[{callsTurnUsageAdaptiveGroups:
      this.cloudflareBytes===null?[]:[{sum:{egressBytes:this.cloudflareBytes,ingressBytes:0}}]}]}},errors:null});
    if(kind==='meteredUsage') return json(200,{quotaInGB:20,usageInGB:this.meteredGb,overageInGB:0});
    return json(200,meteredServers());
  };
  of(kind){ return this.requests.filter(request=>request.kind===kind); }
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

const CLOUDFLARE_ENV={CLOUDFLARE_TURN_KEY_ID:KEY_ID,CLOUDFLARE_TURN_API_TOKEN:API_TOKEN,
  CLOUDFLARE_ACCOUNT_ID:ACCOUNT_ID,CLOUDFLARE_ANALYTICS_API_TOKEN:ANALYTICS_TOKEN};
const METERED_ENV={METERED_TURN_APP_DOMAIN:METERED_DOMAIN,METERED_TURN_API_KEY:METERED_API_KEY,METERED_TURN_SECRET_KEY:METERED_SECRET};
const SECRETS=[API_TOKEN,KEY_ID,USERNAME,CREDENTIAL,ANALYTICS_TOKEN,METERED_API_KEY,METERED_SECRET,'SECRET'];

function enable({cloudflare=true,metered=false}={}){
  Object.assign(process.env,{TURN_RELAY_ENABLED:'true'},cloudflare?CLOUDFLARE_ENV:{},metered?METERED_ENV:{});
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
  provider=new FakeProviders();
  originalFetch=globalThis.fetch;
  globalThis.fetch=provider.fetch;
});
afterEach(()=>{
  globalThis.fetch=originalFetch;
  try{ currentDb?.close?.(); }catch{} currentDb=null;
  if(currentDirectory){ rmSync(currentDirectory,{recursive:true,force:true}); currentDirectory=null; }
  for(const key of ENV_KEYS) delete process.env[key];
});

const CF={TURN_RELAY_ENABLED:'true',...CLOUDFLARE_ENV};
const METERED={TURN_RELAY_ENABLED:'true',...METERED_ENV};
const credentialRequests=()=>provider.requests.filter(request=>request.kind==='cloudflare'||request.kind==='metered');

test('the flag is literal true only and each provider needs every value well formed',()=>{
  const both=turnRelayConfiguration({...CF,...METERED_ENV});
  assert.deepEqual(both.providers.map(item=>item.provider),['cloudflare','metered'],'Cloudflare first, then Metered');
  assert.deepEqual({...both.providers[0]},{provider:'cloudflare',keyId:KEY_ID,apiToken:API_TOKEN,accountId:ACCOUNT_ID,
    analyticsToken:ANALYTICS_TOKEN,budgetMb:800_000,reserveMb:TURN_DEFAULT_RESERVE_MB_PER_CALL});
  assert.deepEqual({...both.providers[1]},{provider:'metered',domain:METERED_DOMAIN,apiKey:METERED_API_KEY,
    secretKey:METERED_SECRET,budgetMb:16_000,reserveMb:TURN_DEFAULT_RESERVE_MB_PER_CALL});
  assert.deepEqual({...both.issues},{cloudflare:null,metered:null});
  assert.equal(TURN_DEFAULT_RESERVE_MB_PER_CALL,1800,'2 streams x ingress+egress x 1 Mbps x 1 h');
  assert.deepEqual(turnRelayConfiguration(METERED).providers.map(item=>item.provider),['metered'],'each provider is optional');
  assert.equal(turnRelayConfiguration({...CF,CLOUDFLARE_TURN_KEY_ID:` ${KEY_ID} `,CLOUDFLARE_ACCOUNT_ID:ACCOUNT_ID.toUpperCase()}).providers[0].keyId,KEY_ID);
  assert.equal(turnRelayConfiguration({...CF,TURN_MONTHLY_GB_BUDGET:'12.5',TURN_RESERVE_MB_PER_CALL:'300'}).providers[0].budgetMb,12_500);
  assert.equal(turnRelayConfiguration({...CF,TURN_RESERVE_MB_PER_CALL:'300'}).providers[0].reserveMb,300);
  assert.equal(turnRelayConfiguration({...METERED,METERED_TURN_MONTHLY_GB_BUDGET:'2'}).providers[0].budgetMb,2000);
  for(const env of [
    {},{TURN_RELAY_ENABLED:'true'},{...CF,TURN_RELAY_ENABLED:'TRUE'},{...CF,TURN_RELAY_ENABLED:'1'},
    {...CF,TURN_RELAY_ENABLED:'false'},{...CF,RANDORI_LOCAL_RUNTIME:'true'},
    {...CF,CLOUDFLARE_TURN_KEY_ID:''},{...CF,CLOUDFLARE_TURN_KEY_ID:'short'},
    {...CF,CLOUDFLARE_TURN_KEY_ID:'../../accounts/x/abc'},{...CF,CLOUDFLARE_TURN_KEY_ID:'a'.repeat(129)},
    {...CF,CLOUDFLARE_TURN_API_TOKEN:''},{...CF,CLOUDFLARE_TURN_API_TOKEN:'has spaces in the token value 12345'},
    {...CF,CLOUDFLARE_ACCOUNT_ID:''},{...CF,CLOUDFLARE_ACCOUNT_ID:'not-hex'},{...CF,CLOUDFLARE_ANALYTICS_API_TOKEN:''},
    {...CF,TURN_MONTHLY_GB_BUDGET:'0'},{...CF,TURN_MONTHLY_GB_BUDGET:'-5'},{...CF,TURN_MONTHLY_GB_BUDGET:'lots'},
    {...CF,TURN_MONTHLY_GB_BUDGET:'1e3'},{...CF,TURN_RESERVE_MB_PER_CALL:'0'},{...CF,TURN_RESERVE_MB_PER_CALL:'1.5'},
    {...METERED,METERED_TURN_APP_DOMAIN:'randori.metered.ca'},{...METERED,METERED_TURN_APP_DOMAIN:'evil.example/x.metered.live'},
    {...METERED,METERED_TURN_APP_DOMAIN:'metered.live'},{...METERED,METERED_TURN_API_KEY:''},
    {...METERED,METERED_TURN_SECRET_KEY:''},{...METERED,METERED_TURN_SECRET_KEY:'has space in it 123456'},
    {...METERED,METERED_TURN_MONTHLY_GB_BUDGET:'none'},
  ]) assert.equal(turnRelayConfiguration(env),null,JSON.stringify(env));
  const partial=turnRelayConfiguration({...CF,...METERED_ENV,METERED_TURN_MONTHLY_GB_BUDGET:'x'});
  assert.deepEqual(partial.providers.map(item=>item.provider),['cloudflare']);
  assert.equal(partial.issues.metered,'configuration','an invalid provider is reported, never used');
  assert.equal(turnRelayConfiguration(),null,'reads process.env by default');
  assert.equal(parseBudgetGb(undefined,7),7); assert.equal(parseBudgetGb(' 0.5 ',7),0.5); assert.equal(parseBudgetGb('0.000',7),null);
  assert.equal(turnReserveMbPerCall({}),1800); assert.equal(turnReserveMbPerCall({TURN_RESERVE_MB_PER_CALL:'x'}),null);
  assert.equal(turnReserveMbPerCall(),1800);
});

test('provider states for diagnostics carry budgets and issues, never secrets',()=>{
  const off=turnProviderStates({...CF,TURN_RELAY_ENABLED:'false'});
  assert.equal(off.enabled,false);
  assert.deepEqual({...off.providers.cloudflare},{enabled:false,issue:null,budgetMb:800_000});
  const on=turnProviderStates({...CF,METERED_TURN_APP_DOMAIN:'bad',METERED_TURN_MONTHLY_GB_BUDGET:'x'});
  assert.deepEqual({...on.providers.cloudflare},{enabled:true,issue:null,budgetMb:800_000});
  assert.deepEqual({...on.providers.metered},{enabled:false,issue:'configuration',budgetMb:null});
  assert.doesNotMatch(JSON.stringify(on),new RegExp(SECRETS.join('|')));
  assert.equal(turnProviderStates().enabled,false);
});

test('the adapters have one endpoint shape each',()=>{
  assert.equal(CLOUDFLARE_TURN_API_BASE,'https://rtc.live.cloudflare.com/v1/turn/keys');
  assert.equal(cloudflareTurnCredentialsUrl(KEY_ID),
    `https://rtc.live.cloudflare.com/v1/turn/keys/${KEY_ID}/credentials/generate-ice-servers`);
  assert.equal(cloudflareTurnCredentialsUrl('a/b?c'),
    'https://rtc.live.cloudflare.com/v1/turn/keys/a%2Fb%3Fc/credentials/generate-ice-servers');
  const metered={domain:METERED_DOMAIN,apiKey:'k&x',secretKey:'s#y'};
  assert.equal(meteredCredentialsUrl(metered),`https://${METERED_DOMAIN}/api/v1/turn/credentials?apiKey=k%26x`);
  assert.equal(meteredUsageUrl(metered),`https://${METERED_DOMAIN}/api/v1/turn/current_usage?secretKey=s%23y`);
});

test('with the flag off the route is a typed 404 for everyone and never contacts a provider',async()=>{
  currentDb=await readyDatabase();
  Object.assign(process.env,CLOUDFLARE_ENV,METERED_ENV);
  for(const flag of [undefined,'false','TRUE','1']){
    if(flag===undefined) delete process.env.TURN_RELAY_ENABLED; else process.env.TURN_RELAY_ENABLED=flag;
    for(const headers of [{'x-test-auth':'member'},{'x-test-auth':'outsider'},{}]){
      const response=await invoke({headers});
      assert.equal(response.status,404);
      assert.deepEqual(response.body,{error:'call relay unavailable',code:'turn_relay_disabled'});
      assert.equal(response.headers['cache-control'],'private, no-store');
    }
  }
  for(const key of ENV_KEYS) delete process.env[key];
  enable(); process.env.CLOUDFLARE_TURN_API_TOKEN='';
  assert.equal((await invoke()).status,404,'a provider with a missing token is the same as off');
  enable(); process.env.RANDORI_LOCAL_RUNTIME='true';
  assert.equal((await invoke()).status,404,'never in the local runtime');
  assert.equal(provider.requests.length,0);
  // The signalling route is untouched by the new endpoint.
  delete process.env.RANDORI_LOCAL_RUNTIME;
  const signal=await invoke({url:'/api/video/signal',query:{endpoint:'signal'},body:{}});
  assert.equal(signal.status,400);
});

test('a pair member gets Cloudflare STUN and TURN servers with an expiry, nothing else',async()=>{
  currentDb=await readyDatabase(); enable({metered:true});
  const before=Date.now();
  const response=await invoke();
  assert.equal(response.status,200,JSON.stringify(response.body));
  assert.equal(response.headers['cache-control'],'private, no-store');
  assert.deepEqual(Object.keys(response.body).sort(),['expiresAt','iceServers','relay']);
  assert.equal(response.body.relay,'cloudflare');
  assert.deepEqual(response.body.iceServers,[
    {urls:['stun:stun.cloudflare.com:3478']},
    {urls:['turn:turn.cloudflare.com:3478?transport=udp','turn:turn.cloudflare.com:3478?transport=tcp',
      'turns:turn.cloudflare.com:5349?transport=tcp','turns:turn.cloudflare.com:443?transport=tcp'],
    username:USERNAME,credential:CREDENTIAL},
  ],'browser-blocked :53 alternates are dropped');
  const expiresAt=Date.parse(response.body.expiresAt);
  assert.ok(expiresAt>=Math.floor(before/1000)*1000+TURN_MAX_TTL_SECONDS*1000);
  assert.ok(expiresAt<=Date.now()+TURN_MAX_TTL_SECONDS*1000);

  assert.deepEqual(provider.requests.map(request=>request.kind),['cloudflareUsage','cloudflare'],
    'usage is read first; Metered is never contacted while Cloudflare works');
  const [usage,request]=provider.requests;
  assert.equal(usage.url,'https://api.cloudflare.com/client/v4/graphql');
  assert.equal(usage.headers.authorization,`Bearer ${ANALYTICS_TOKEN}`,'the least-privilege analytics token reads usage');
  assert.equal(usage.redirect,'error');
  assert.match(usage.body.query,new RegExp(`accountTag:"${ACCOUNT_ID}"`));
  assert.match(usage.body.query,new RegExp(`keyId:"${KEY_ID}"`));
  assert.match(usage.body.query,/callsTurnUsageAdaptiveGroups\(limit:1,filter:\{date_geq:"\d{4}-\d{2}-01",date_leq:"\d{4}-\d{2}-\d{2}"/);
  assert.match(usage.body.query,/sum\{egressBytes ingressBytes\}/);
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
  assert.equal(provider.of('cloudflareUsage').length,1,'a fresh usage snapshot is reused for five minutes');
});

test('Metered is the backup: used when Cloudflare is over budget or failing, or alone',async()=>{
  currentDb=await readyDatabase(); enable({metered:true});
  provider.cloudflareBytes=800_000*1_000_000; // exactly the 800 GB budget
  const capture=captureWarnings();
  let response;
  try{ response=await invoke(); }finally{ capture.restore(); }
  assert.equal(response.status,200,JSON.stringify(response.body));
  assert.equal(response.body.relay,'metered');
  assert.deepEqual(response.body.iceServers,[
    {urls:['stun:stun.relay.metered.ca:80']},
    {urls:['turn:global.relay.metered.ca:80'],username:USERNAME,credential:CREDENTIAL},
    {urls:['turn:global.relay.metered.ca:80?transport=tcp'],username:USERNAME,credential:CREDENTIAL},
    {urls:['turn:global.relay.metered.ca:443'],username:USERNAME,credential:CREDENTIAL},
    {urls:['turns:global.relay.metered.ca:443?transport=tcp'],username:USERNAME,credential:CREDENTIAL},
  ]);
  assert.deepEqual(provider.requests.map(request=>request.kind),['cloudflareUsage','meteredUsage','metered']);
  assert.equal(provider.of('cloudflare').length,0,'no Cloudflare credential over budget');
  const [usage,credentials]=[provider.of('meteredUsage')[0],provider.of('metered')[0]];
  assert.equal(usage.url,meteredUsageUrl({domain:METERED_DOMAIN,secretKey:METERED_SECRET}));
  assert.equal(credentials.url,meteredCredentialsUrl({domain:METERED_DOMAIN,apiKey:METERED_API_KEY}));
  assert.equal(credentials.method,'GET'); assert.equal(credentials.redirect,'error');
  assert.deepEqual(capture.warnings,['[video] turn relay unavailable {"provider":"cloudflare","stage":"budget","status":null,"reason":"budget_reached"}']);

  // Cloudflare's credential call failing also falls back (and releases its reservation).
  for(const key of ENV_KEYS) delete process.env[key];
  currentDb.close(); rmSync(currentDirectory,{recursive:true,force:true}); currentDb=await readyDatabase(); enable({metered:true});
  provider.requests.length=0; provider.cloudflareBytes=0;
  provider.respond.cloudflare=()=>json(500,{errors:[{message:`down ${API_TOKEN}`}]});
  const quiet=captureWarnings();
  try{ response=await invoke(); }finally{ quiet.restore(); }
  assert.equal(response.body.relay,'metered');
  assert.match(quiet.warnings[0],/"provider":"cloudflare","stage":"status","status":500/);
  const reservations=(await currentDb.execute(`SELECT key FROM auth_rate_limits WHERE key GLOB 'trb1:c:r:*'`)).rows;
  assert.equal(reservations.length,0,'a credential never handed out holds no reservation');
  assert.equal((await currentDb.execute(`SELECT key FROM auth_rate_limits WHERE key GLOB 'trb1:m:r:*'`)).rows.length,1);

  // Metered alone.
  for(const key of ENV_KEYS) delete process.env[key];
  enable({cloudflare:false,metered:true}); provider.requests.length=0; provider.respond={};
  response=await invoke();
  assert.equal(response.body.relay,'metered');
  assert.deepEqual(provider.requests.map(request=>request.kind),['metered'],'the fresh Metered snapshot is reused');
});

test('with every relay over budget the answer is relay none and the call stays STUN-only',async()=>{
  currentDb=await readyDatabase(); enable({metered:true});
  provider.cloudflareBytes=900_000*1_000_000; provider.meteredGb=16;
  const capture=captureWarnings();
  let response;
  try{ response=await invoke(); }finally{ capture.restore(); }
  assert.equal(response.status,200);
  assert.deepEqual(response.body,{iceServers:[],expiresAt:null,relay:'none',reason:'budget_reached'});
  assert.equal(credentialRequests().length,0);
  assert.equal(capture.warnings.length,2);
  // One provider paused and one failing is an outage, not a pause.
  await currentDb.execute(`DELETE FROM auth_rate_limits WHERE key GLOB 'trb1:m:*'`);
  provider.meteredGb=0; provider.respond.metered=()=>json(401,{error:'Invalid API Key'});
  const failing=captureWarnings();
  try{ response=await invoke(); }finally{ failing.restore(); }
  assert.equal(response.status,503);
  assert.deepEqual(response.body,{error:'call relay unavailable',code:'turn_relay_unavailable'});
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
  assert.deepEqual(provider.of('cloudflare').at(-1).body,{ttl:TURN_MAX_TTL_SECONDS});
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
  assert.deepEqual(provider.of('cloudflare')[0].body,{ttl:12*60});
  const [reservation]=(await currentDb.execute(`SELECT attempts FROM auth_rate_limits WHERE key GLOB 'trb1:c:r:*'`)).rows;
  assert.equal(Number(reservation.attempts),Math.ceil(1800*12*60/3600),'the reservation is prorated by lifetime');
  await currentDb.execute(`UPDATE pair_session_controls SET remaining_ms=0`);
  const ended=await invoke();
  assert.equal(ended.status,409);
  assert.equal(ended.body.code,'interview_session_ended');
  assert.equal(credentialRequests().length,1);
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
  process.env.TURN_RESERVE_MB_PER_CALL='1';
  for(let index=0;index<TURN_RATE_LIMITS.account;index+=1){
    assert.equal((await invoke()).status,200);
  }
  const limited=await invoke();
  assert.equal(limited.status,429);
  assert.equal(limited.body.code,'turn_relay_rate_limited');
  assert.ok(Number(limited.headers['retry-after'])>=1);
  assert.equal(credentialRequests().length,TURN_RATE_LIMITS.account);
  const keys=(await currentDb.execute(`SELECT key FROM auth_rate_limits WHERE key NOT GLOB 'trb1:*'`)).rows.map(row=>String(row.key));
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

test('database or readiness failures are a typed 503 without contacting a provider',async()=>{
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

test('provider failures are a typed 503 and the log carries no credential, token or key',async()=>{
  currentDb=await readyDatabase(); enable();
  process.env.TURN_RESERVE_MB_PER_CALL='1';
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
      provider.respond.cloudflare=failure;
      const response=await invoke();
      assert.equal(response.status,503);
      assert.deepEqual(response.body,{error:'call relay unavailable',code:'turn_relay_unavailable'});
      assert.doesNotMatch(JSON.stringify(response.body),/SECRET|turn:|stun:/);
    }
    // Usage that cannot be read fails closed: no credential is minted.
    provider.respond.cloudflare=null;
    await currentDb.execute(`DELETE FROM auth_rate_limits WHERE key GLOB 'trb1:*'`);
    provider.respond.cloudflareUsage=()=>json(200,{data:null,errors:[{message:`denied ${ANALYTICS_TOKEN}`}]});
    const before=credentialRequests().length;
    assert.equal((await invoke()).status,503);
    assert.equal(credentialRequests().length,before);
  }finally{ capture.restore(); }
  assert.equal(capture.warnings.length,failures.length+1);
  for(const line of capture.warnings){
    assert.match(line,/^\[video\] turn relay unavailable \{"provider":"cloudflare","stage":"(request|status|response|budget)","status":(null|\d{3}),"reason":(null|"[a-z_]+")\}$/);
    assert.doesNotMatch(line,new RegExp(SECRETS.join('|')));
  }
  // A successful mint logs nothing at all.
  provider.respond={};
  await currentDb.execute(`DELETE FROM auth_rate_limits WHERE key GLOB 'trb1:*'`);
  const quiet=captureWarnings();
  try{ assert.equal((await invoke()).status,200); }finally{ quiet.restore(); }
  assert.deepEqual(quiet.warnings,[]);
});

test('an unexpected error is still a typed 503 with an opaque log line',async()=>{
  currentDb=await readyDatabase(); enable();
  provider.respond.cloudflare=()=>({get status(){ throw new RangeError('response broke'); }});
  const capture=captureWarnings();
  let response;
  try{ response=await invoke(); }finally{ capture.restore(); }
  assert.equal(response.status,503);
  assert.deepEqual(capture.warnings,['[video] turn relay unavailable {"provider":"cloudflare","stage":"unexpected","status":null,"reason":null}']);
});

test('the provider deadline aborts a hung request as a request failure',async()=>{
  const [config]=turnRelayConfiguration(CF).providers;
  const window=turnGrantWindow();
  let seen;
  const hung=(_url,init)=>new Promise((_resolve,reject)=>{
    seen=init.signal;
    init.signal.addEventListener('abort',()=>reject(init.signal.reason));
  });
  const pending=mintTurnIceServers(config,{window,fetchImpl:hung});
  // Abort as AbortSignal.timeout(5000) would, without waiting five seconds.
  assert.ok(seen instanceof AbortSignal);
  seen.dispatchEvent(new Event('abort'));
  await assert.rejects(pending,error=>error instanceof TurnProviderError&&error.stage==='request'&&error.status===null&&error.provider==='cloudflare');
  // A body read that fails (for example, aborted mid-stream) is also a request failure.
  const brokenBody={status:201,headers:new Headers(),text:async()=>{ throw new Error('aborted'); }};
  await assert.rejects(mintTurnIceServers(config,{window,fetchImpl:async()=>brokenBody}),
    error=>error.stage==='request'&&error.status===201);
  await assert.rejects(mintTurnIceServers(null,{window,fetchImpl:hung}),error=>error.stage==='configuration');
  await assert.rejects(mintTurnIceServers({provider:'other'},{window,fetchImpl:hung}),error=>error.stage==='configuration');
  await assert.rejects(mintTurnIceServers(config,{window:{ttlSeconds:0},fetchImpl:hung}),error=>error.stage==='configuration');
  // A declared oversize body is refused before it is read.
  let read=false;
  const declared={status:200,headers:new Headers({'content-length':String(TURN_LIMITS.responseBytes+1)}),text:async()=>{ read=true; return '{}'; }};
  await assert.rejects(mintTurnIceServers(config,{window,fetchImpl:async()=>declared}),error=>error.stage==='response');
  assert.equal(read,false);
  const ok=await mintTurnIceServers(config,{window,fetchImpl:async()=>new Response(JSON.stringify(cloudflareServers()),{status:200})});
  assert.equal(ok.iceServers.length,2); assert.equal(ok.relay,'cloudflare');
  assert.equal(ok.expiresAt,new Date(window.expiresAtMs).toISOString());
  const [metered]=turnRelayConfiguration(METERED).providers;
  await assert.rejects(mintTurnIceServers(metered,{window,fetchImpl:async()=>json(200,cloudflareServers().iceServers)}),
    error=>error.stage==='response'&&error.provider==='metered','Cloudflare hosts are not Metered hosts');
  await assert.rejects(mintTurnIceServers(metered,{window,fetchImpl:async()=>json(201,meteredServers())}),
    error=>error.stage==='status'&&error.status===201);
  assert.equal((await mintTurnIceServers(metered,{window,fetchImpl:async()=>json(200,meteredServers())})).relay,'metered');
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
  assert.equal(parseMeteredIceServers(meteredServers()).length,5);
  assert.deepEqual(parseMeteredIceServers([{urls:'turn:a.relay.metered.ca:80',username:'u',credential:'c'}]),
    [{urls:['turn:a.relay.metered.ca:80'],username:'u',credential:'c'}]);
  assert.throws(()=>parseProviderIceServers(meteredServers(),'other'),TurnProviderError);

  const rejected=[
    null,[],'x',{},{iceServers:{}},{iceServers:[]},
    {iceServers:Array.from({length:TURN_LIMITS.entries+1},()=>({urls:'turn:turn.cloudflare.com',username:'u',credential:'c'}))},
    {iceServers:[null]},{iceServers:[[]]},{iceServers:[{}]},{iceServers:[{urls:[]}]},{iceServers:[{urls:42}]},
    // Only STUN: nothing to relay.
    {iceServers:[{urls:'stun:stun.cloudflare.com:3478'}]},
    {iceServers:[{urls:'turn:turn.cloudflare.com:53',username:'u',credential:'c'}]},
    // Non-Cloudflare hosts (Metered's included).
    turn('turn:turn.example.com:3478'),turn('turn:evilcloudflare.com:3478'),turn('turn:turn.cloudflare.com.evil.test:3478'),
    turn('turn:cloudflare.co:3478'),turn('turn:[::1]:3478'),turn('turn:203.0.113.5:3478'),turn('turn:user@turn.cloudflare.com'),
    turn('turn:global.relay.metered.ca:80'),
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
  for(const payload of [
    {iceServers:meteredServers()},null,[],[{urls:'turn:turn.cloudflare.com',username:'u',credential:'c'}],
    [{urls:'turn:relay.metered.live:80',username:'u',credential:'c'}],[{urls:'turn:metered.ca.evil.test:80',username:'u',credential:'c'}],
    [{urls:'turn:global.relay.metered.ca:80'}],[{urls:'stun:stun.relay.metered.ca:80'}],
  ]){
    assert.throws(()=>parseMeteredIceServers(payload),
      error=>error instanceof TurnProviderError&&error.stage==='response'&&error.provider==='metered',JSON.stringify(payload)?.slice(0,160));
  }
});
