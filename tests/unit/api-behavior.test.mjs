import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash, createHmac } from 'node:crypto';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { after, beforeEach, mock, test } from 'node:test';
import { createClient } from '@libsql/client';
import bcrypt from 'bcryptjs';
import { availabilityCycleKey } from '../../api/_availability.js';
import { resolvePairingCycle } from '../../api/_pairing-cycle.js';
import {googleOAuthCookieHeader,googleProviderFetch} from '../support/google-oidc.mjs';

const realFetch = globalThis.fetch;
const TEST_JWT_SECRET = 'unit-test-secret-at-least-thirty-two-characters';
let executeHandler = () => ({ rows: [], rowsAffected: 0 });
let databaseDelegate = null;
let getClientCalls = 0;
const executed = [];
const sentryMessageCalls = [];
const sentryExceptionCalls = [];
let lastPairingRun = null;
let persistedPairGroups = [];
let persistedPairingParticipants = [];
const mockAvailabilityCycles=new Map();
const mockAvailabilityDecisions=new Map();

function sqlText(statement) {
  return typeof statement === 'string' ? statement : String(statement?.sql || '');
}

function availabilityFixtureResult(sql,args=[]){
  if(sql.includes("strftime('%Y-%m-%dT%H:%M:%fZ','now') AS now_utc")){
    return rows([{now_utc:new Date().toISOString()}]);
  }
  if(sql.includes("PRAGMA table_info('pairing_cycles')")) return rows([
    ['scope_key','TEXT',1,1],['circle_id','INTEGER',0,0],['cycle_key','TEXT',1,2],
    ['cycle_id','TEXT',1,0],['starts_at','TEXT',1,0],['ends_at','TEXT',1,0],
    ['cutoff_at','TEXT',1,0],['time_zone','TEXT',1,0],['default_source','TEXT',1,0],
    ['created_at','TEXT',1,0],
  ].map(([name,type,notnull,pk])=>({name,type,notnull,pk})));
  if(sql.includes("PRAGMA table_info('pairing_cycle_availability')")) return rows([
    ['scope_key','TEXT',1,1],['cycle_key','TEXT',1,2],['user_id','INTEGER',1,3],
    ['is_available','INTEGER',1,0],['version','INTEGER',1,0],
    ['decision_source','TEXT',1,0],['created_at','TEXT',1,0],['updated_at','TEXT',1,0],
  ].map(([name,type,notnull,pk])=>({name,type,notnull,pk})));
  if(sql.includes("PRAGMA index_list('pairing_cycle_availability')")) return rows([{
    name:'idx_pairing_cycle_availability_candidates',unique:0,partial:0,
  }]);
  if(sql.includes("PRAGMA index_info('idx_pairing_cycle_availability_candidates')")){
    return rows(['scope_key','cycle_key','is_available','user_id'].map((name,seqno)=>({name,seqno})));
  }
  if(sql.includes('FROM pairing_cycles WHERE scope_key=? AND cycle_key=?')){
    const cycle=mockAvailabilityCycles.get(`${args[0]}:${args[1]}`);
    return rows(cycle?[cycle]:[]);
  }
  if(sql.includes('INSERT INTO pairing_cycles')){
    const [scope_key,circle_id,cycle_key,cycle_id,starts_at,ends_at,cutoff_at,time_zone]=args;
    const key=`${scope_key}:${cycle_key}`;
    if(!mockAvailabilityCycles.has(key)) mockAvailabilityCycles.set(key,{
      scope_key,circle_id,cycle_key,cycle_id,starts_at,ends_at,cutoff_at,time_zone,
      default_source:[...mockAvailabilityCycles.values()].some(row=>row.scope_key===scope_key)
        ?'cycle_default':'legacy_bridge',created_at:new Date().toISOString(),
    });
    return rows([], {rowsAffected:1});
  }
  if(sql.includes('FROM pairing_cycle_availability')&&sql.includes('user_id IN')){
    const [scopeKey,cycleKey,...userIds]=args;
    return rows(userIds.map(id=>mockAvailabilityDecisions.get(`${scopeKey}:${cycleKey}:${id}`)).filter(Boolean));
  }
  if(sql.includes('FROM pairing_cycle_availability')&&sql.includes('user_id=?')){
    const decision=mockAvailabilityDecisions.get(`${args[0]}:${args[1]}:${args[2]}`);
    return rows(decision?[decision]:[]);
  }
  if(sql.includes('INSERT INTO pairing_cycle_availability')){
    const [scopeKey,cycleKey,userId,isAvailable,createdAt,updatedAt]=args;
    const decision={user_id:userId,is_available:isAvailable,version:1,decision_source:'user',created_at:createdAt,updated_at:updatedAt};
    mockAvailabilityDecisions.set(`${scopeKey}:${cycleKey}:${userId}`,decision);
    return rows([decision],{rowsAffected:1});
  }
  if(sql.includes('UPDATE auth_accounts SET is_available=?,availability_updated_at=?')){
    return rows([],{rowsAffected:1});
  }
  if(sql.includes('SELECT account.id,account.is_available,circle.id AS circle_id')){
    return rows([{id:Number(args[0]),is_available:1,circle_id:1,circle_public_id:'circle_test',circle_name:'Test Circle'}]);
  }
  if(sql.includes('SELECT id,public_id,name FROM circles')&&sql.includes('is_primary=1')){
    return rows([{id:1,public_id:'circle_test',name:'Test Circle'}]);
  }
  return undefined;
}

function createMockDb(){
  return {
    async execute(statement) {
      const sql = sqlText(statement);
      executed.push({ sql, args: statement?.args || [] });
      if (databaseDelegate) return databaseDelegate.execute(statement);
      const availabilityResult=availabilityFixtureResult(sql,statement?.args||[]);
      if(availabilityResult!==undefined) return availabilityResult;
      const result = await executeHandler(sql, statement?.args || []);
      if(!(result?.rows?.length)&&sql.includes('INSERT INTO auth_provider_identities')&&sql.includes('RETURNING user_id')){
        return rows([{user_id:Number(statement?.args?.[2])}]);
      }
      if((result?.rows?.length||result?.rowsAffected)||!lastPairingRun) return result || { rows: [], rowsAffected: 0 };
      if(sql.includes('FROM pairing_week_runs WHERE week_label=?')&&String(statement?.args?.[0])===lastPairingRun.weekLabel) return rows([{
        week_label:lastPairingRun.weekLabel,
        week_id:lastPairingRun.weekId,
        generation_token:lastPairingRun.generationToken,
        generation:lastPairingRun.generation,
        algorithm_version:lastPairingRun.algorithmVersion||'fair-v2',
        algorithm_seed:lastPairingRun.algorithmSeed||`${lastPairingRun.weekLabel}:weekly`,
        participant_count:lastPairingRun.participantCount||persistedPairingParticipants.length,
        participants_json:lastPairingRun.participantsJson||JSON.stringify(persistedPairingParticipants.map(item=>({user_id:item.user_id,source:item.source}))),
        created_at:'2026-09-20T07:00:00.000Z',
      }]);
      if(sql.includes('FROM pairing_weeks WHERE week_label=?')&&String(statement?.args?.[0])===lastPairingRun.weekLabel) return rows([{
        id:lastPairingRun.weekId,week_label:lastPairingRun.weekLabel,
        week_start:lastPairingRun.weekStart||resolvePairingCycle().startsAt,is_demo:0,
      }]);
      if(sql.includes('FROM pairing_participants pp')) return rows(persistedPairingParticipants);
      if(sql.includes('FROM pairing_groups pg')&&sql.includes('JOIN pairing_week_runs pwr')) return rows(persistedPairGroups.map(group=>({
        id:group.id,user_a_id:group.user_a_id,user_b_id:group.user_b_id,user_c_id:null,is_ai_pair:group.is_ai_pair,
      })));
      return result || { rows: [], rowsAffected: 0 };
    },
    async batch(statements, mode) {
      if (databaseDelegate) {
        for (const statement of statements) {
          executed.push({ sql: sqlText(statement), args: statement?.args || [] });
        }
        return databaseDelegate.batch(statements, mode);
      }
      const nextGroups = [];
      const nextParticipants = [];
      const results = [];
      for (const statement of statements) {
        if (sqlText(statement).includes('INSERT INTO pairing_week_runs')) {
          const publicationWrite=sqlText(statement).includes('SELECT ?,NULL,?,1');
          lastPairingRun = {
            weekLabel: statement.args[0],
            generationToken: statement.args[1],
            generation: publicationWrite?1:Number(statement.args[2]),
            weekId: 10,
            algorithmVersion:publicationWrite?statement.args[2]:statement.args[3],
            algorithmSeed:publicationWrite?statement.args[3]:statement.args[4],
            participantCount:publicationWrite?Number(statement.args[4]):Number(statement.args[5]),
            participantsJson:publicationWrite?statement.args[5]:statement.args[6],
          };
        }
        if(sqlText(statement).includes('INSERT INTO pairing_weeks')&&lastPairingRun){
          lastPairingRun.weekStart=String(statement.args[1]);
        }
        if (sqlText(statement).includes('INSERT INTO pairing_participants')) {
          nextParticipants.push({
            user_id:Number(statement.args[0]),position:Number(statement.args[1]),source:String(statement.args[2]),
          });
        }
        if (sqlText(statement).includes('INSERT INTO pairing_groups')) {
          nextGroups.push({
            id: 90 + nextGroups.length,
            user_a_id: Number(statement.args[0]),
            user_b_id: Number(statement.args[1]),
            is_ai_pair: Number(statement.args[2]),
          });
        }
        results.push(await this.execute(statement));
      }
      if (nextGroups.length) persistedPairGroups = nextGroups;
      if (nextParticipants.length) persistedPairingParticipants = nextParticipants;
      return results;
    },
    async transaction(){
      return {
        execute:this.execute.bind(this),
        batch:this.batch.bind(this),
        async commit(){},
        async rollback(){},
      };
    },
  };
}

let db=createMockDb();

function authPayload(req) {
  const identity = req?.headers?.['x-test-auth'];
  if (identity === 'admin') return { id: 1, email: 'admin@example.test', name: 'Admin', is_admin: true };
  if (identity === 'demo') return { id: 3, email: 'demo@randori.demo', name: 'Demo', is_demo: true };
  if (identity === 'user') return { id: 2, email: 'user@example.test', name: 'User' };
  return null;
}

mock.module('../../api/_db.js', {
  exports: {
    JWT_AUDIENCE: 'randori-web',
    JWT_ISSUER: 'randori-circle',
    getClient: () => { getClientCalls+=1; return db; },
    getJwtSecret: () => TEST_JWT_SECRET,
    getCronSecret: () => {
      if (!process.env.CRON_SECRET) throw new Error('Missing CRON_SECRET');
      return process.env.CRON_SECRET;
    },
    getAdminEmails: () => new Set(['admin@example.test']),
    deterministicColor: () => '#123456',
    issueSession: async (_db,user) => `test-session-${user.id||user.uid}`,
    issueSessionInTransaction: async (_db,user) => `test-session-${user.id||user.uid}`,
    revokeAccountSessions: async () => 0,
    revokeRequestSession: async () => ({authenticated:false,revoked:false,userId:null}),
    isoWeekLabel: () => '2026-W38',
    shuffleArray: values => [...values],
    verifyRequestAuth: authPayload,
    verifySignedRequestAuth: () => null,
    verifyMutationOrigin: () => true,
    initSentry: () => {},
    isSentryConfigured: () => Boolean(process.env.SENTRY_DSN || process.env.NEXT_PUBLIC_SENTRY_DSN),
    getSentry: () => ({ Sentry: null, ready: false }),
    captureSentryMessage: (...args) => { sentryMessageCalls.push(args); return null; },
    captureSentryException: (...args) => { sentryExceptionCalls.push(args); return null; },
  },
});

const [
  { default: aiHandler },
  { default: authHandler, localPasswordSignupEnabled },
  { default: dataHandler },
  { default: opsHandler },
  { default: videoHandler },
  { createEvaluationSuite, listPublicExercises },
  { localIdentityAdapterEnabled },
] = await Promise.all([
  import('../../api/ai.js'),
  import('../../api/auth.js'),
  import('../../api/data.js'),
  import('../../api/ops.js'),
  import('../../api/video.js'),
  import('../../api/_catalog.js'),
  import('../../api/_local-runtime.js'),
]);

function rows(values = [], extra = {}) {
  return { rows: values, rowsAffected: 0, ...extra };
}

async function withFixedNow(iso,callback){
  const NativeDate=globalThis.Date;
  const instant=new NativeDate(iso).getTime();
  globalThis.Date=class FixedDate extends NativeDate{
    constructor(...args){ super(...(args.length?args:[instant])); }
    static now(){ return instant; }
  };
  try{ return await callback(); }
  finally{ globalThis.Date=NativeDate; }
}

function existingPairingPublication(sql,{
  participantId=2,
  participantRows=null,
  groupRows=null,
  weekId=10,
  cycleId=resolvePairingCycle().cycleId,
  startsAt=resolvePairingCycle().startsAt,
}={}){
  const storedParticipants=participantRows||[{user_id:participantId,position:0,source:'auth'}];
  const storedGroups=groupRows||[{id:20,user_a_id:participantId,user_b_id:participantId,user_c_id:null,is_ai_pair:1}];
  if(sql.includes('FROM pairing_week_runs WHERE week_label=?')) return rows([{
    week_label:cycleId,week_id:weekId,generation_token:'existing-token',generation:1,
    algorithm_version:'fair-v2',algorithm_seed:`${cycleId}:weekly`,participant_count:storedParticipants.length,
    participants_json:JSON.stringify(storedParticipants.map(item=>({user_id:item.user_id,source:item.source}))),created_at:startsAt,
  }]);
  if(sql.includes('FROM pairing_weeks WHERE week_label=?')) return rows([{
    id:weekId,week_label:cycleId,week_start:startsAt,is_demo:0,
  }]);
  if(sql.includes('FROM pairing_participants pp')) return rows(storedParticipants);
  if(sql.includes('FROM pairing_groups pg')&&sql.includes('JOIN pairing_week_runs pwr')) return rows(storedGroups);
  return null;
}

function signRunForTest({userId,questionSlug,questionVersion,language,passedCount,totalCount,resultsJson}){
  const resultsDigest=createHash('sha256').update(String(resultsJson||''),'utf8').digest('hex');
  const payload=JSON.stringify([2,Number(userId),String(questionSlug),Number(questionVersion),String(language),Number(passedCount),Number(totalCount),resultsDigest]);
  return createHmac('sha256',TEST_JWT_SECRET).update(`randori-run-attestation-v2\0${payload}`,'utf8').digest('hex');
}

function runKeyIdForTest(secret=TEST_JWT_SECRET){
  return createHash('sha256').update(`randori-run-key\0${secret}`,'utf8').digest('hex').slice(0,16);
}

const sameOriginHeaders = {
  origin: 'https://randori.example.test',
  host: 'randori.example.test',
  'x-forwarded-proto': 'https',
};

const localOriginHeaders = {
  origin: 'http://127.0.0.1:3000',
  host: '127.0.0.1:3000',
};

function enableLocalPasswordSignup(){
  process.env.NODE_ENV='development';
  process.env.RANDORI_LOCAL_RUNTIME='true';
  process.env.ALLOW_OPEN_SIGNUP='true';
  process.env.CIRCLE_MEMBERSHIP_ENABLED='false';
  process.env.TURSO_DATABASE_URL='file:///tmp/randori-circle-unit-test.sqlite';
  process.env.APP_URL='http://127.0.0.1:3000';
}

function enableLocalInviteSignup(){
  enableLocalPasswordSignup();
  process.env.ALLOW_OPEN_SIGNUP='false';
  process.env.CIRCLE_MEMBERSHIP_ENABLED='true';
  process.env.RANDORI_LOCAL_IDENTITY='true';
}

function invoke(handler, { method = 'GET', url = '/', query = {}, headers = {}, body = {}, remoteAddress='127.0.0.1' } = {}) {
  return new Promise((resolve, reject) => {
    let statusCode = 200;
    let settled = false;
    const responseHeaders = {};
    const finish = payload => {
      if (settled) return;
      settled = true;
      resolve({ status: statusCode, headers: responseHeaders, body: payload });
    };
    const response = {
      status(code) { statusCode = code; return this; },
      json(payload) { finish(payload); return this; },
      setHeader(name, value) { responseHeaders[String(name).toLowerCase()] = value; },
      getHeader(name) { return responseHeaders[String(name).toLowerCase()]; },
      writeHead(code, values = {}) {
        statusCode = code;
        for (const [name, value] of Object.entries(values)) responseHeaders[name.toLowerCase()] = value;
        return this;
      },
      end(payload) { finish(payload); },
    };
    const request = { method, url, query, headers, body, socket: { remoteAddress } };
    Promise.resolve(handler(request, response)).then(() => finish(undefined)).catch(reject);
  });
}

beforeEach(() => {
  db=createMockDb();
  executed.length = 0;
  sentryMessageCalls.length = 0;
  sentryExceptionCalls.length = 0;
  databaseDelegate = null;
  getClientCalls = 0;
  lastPairingRun = null;
  persistedPairGroups = [];
  persistedPairingParticipants = [];
  mockAvailabilityCycles.clear();
  mockAvailabilityDecisions.clear();
  executeHandler = () => rows();
  globalThis.fetch = realFetch;
  for (const key of [
    'ADMIN_EMAILS', 'AI_ENABLED', 'APP_URL', 'CRON_SECRET', 'GOOGLE_CLIENT_ID', 'NODE_ENV',
    'GOOGLE_CLIENT_SECRET', 'GROQ_API_KEY', 'OPENAI_API_KEY', 'RESEND_API_KEY', 'RESEND_FROM',
    'NEXT_PUBLIC_SENTRY_DSN', 'SENTRY_DSN',
    'ALLOW_OPEN_SIGNUP', 'SIGNUP_ALLOWLIST', 'LEETCODE_INGESTION_AUTHORIZED',
    'AUTH_SCHEMA_BOOTSTRAP_ENABLED', 'CIRCLE_MEMBERSHIP_ENABLED', 'RANDORI_LOCAL_RUNTIME',
    'RANDORI_LOCAL_DATABASE_PATH', 'RANDORI_LOCAL_IDENTITY',
    'TURSO_AUTH_TOKEN', 'TURSO_DATABASE_URL', 'VERCEL', 'VERCEL_ENV', 'VERCEL_URL',
    'RUN_ATTESTATION_SECRET', 'RUN_ATTESTATION_PREVIOUS_SECRETS',
    'TWILIO_ACCOUNT_SID', 'TWILIO_AUTH_TOKEN', 'TWILIO_FROM',
  ]) delete process.env[key];
});

test('an unhandled data API failure is reported to Sentry exactly once', async () => {
  executeHandler = () => { throw new Error('forced handler failure'); };
  const originalError=console.error;
  console.error=()=>{};
  try{
    const result=await invoke(dataHandler,{
      url:'/api/profile',
      query:{endpoint:'profile'},
      headers:{'x-test-auth':'user'},
    });
    assert.equal(result.status,500);
    assert.equal(sentryExceptionCalls.length,1);
    assert.match(sentryExceptionCalls[0][0].message,/forced handler failure/);
  }finally{
    console.error=originalError;
  }
});

after(() => {
  globalThis.fetch = realFetch;
});

test('password signup, login, and authenticated profile lookup return cookie sessions', async () => {
  enableLocalPasswordSignup();
  const passwordHash = await bcrypt.hash('correct horse battery', 4);
  executeHandler = sql => {
    if (sql.includes('RETURNING attempts')) return rows([{ attempts: 1 }]);
    if (sql.includes('SELECT id FROM auth_accounts WHERE email=')) return rows([]);
    if (sql.includes('INSERT INTO auth_accounts') && sql.includes('RETURNING id')) return rows([{ id: 7 }]);
    if (sql.includes('SELECT id,email,password_hash')) return rows([{
      id: 7,
      email: 'person@example.test',
      password_hash: passwordHash,
      display_name: 'Person',
      color: '#123456',
      is_admin: 0,
    }]);
    if (sql.includes('SELECT id,email,display_name,color,created_at')) return rows([{
      id: 2,
      email: 'user@example.test',
      display_name: 'User',
      color: '#123456',
      is_available: 1,
      is_admin: 0,
    }]);
    return rows();
  };

  const signup = await invoke(authHandler, {
    method: 'POST',
    url: '/api/auth/signup',
    query: { endpoint: 'signup' },
    headers: { ...localOriginHeaders, 'x-forwarded-proto': 'https' },
    body: { email: 'PERSON@example.test', password: 'correct horse battery', name: 'Person' },
  });
  assert.equal(signup.status, 200);
  assert.equal(signup.body.user.id, 7);
  assert.equal('token' in signup.body, false);
  assert.match(String(signup.headers['set-cookie']), /randori_session=.*HttpOnly.*Secure/);

  const login = await invoke(authHandler, {
    method: 'POST',
    url: '/api/auth/login',
    query: { endpoint: 'login' },
    headers: sameOriginHeaders,
    body: { email: 'person@example.test', password: 'correct horse battery' },
  });
  assert.equal(login.status, 200);
  assert.equal(login.body.user.name, 'Person');
  assert.match(String(login.headers['set-cookie']), /randori_session=/);

  const me = await invoke(authHandler, {
    url: '/api/auth/me',
    query: { endpoint: 'me' },
    headers: { 'x-test-auth': 'user' },
  });
  assert.equal(me.status, 200);
  assert.equal(me.body.user.email, 'user@example.test');
});

test('password signup is local-only while production and private-beta registration stay disabled', async () => {
  process.env.NODE_ENV = 'production';
  process.env.ALLOW_OPEN_SIGNUP = 'true';
  const production = await invoke(authHandler, {
    method: 'POST', url: '/api/auth/signup', query: { endpoint: 'signup' },
    headers: sameOriginHeaders,
    body: { email: 'outsider@example.test', password: 'correct horse battery', name: 'Outsider' },
  });
  assert.equal(production.status, 503);
  assert.equal(executed.length, 0, 'production password signup must be rejected before database access');

  process.env.NODE_ENV='development';
  delete process.env.RANDORI_LOCAL_RUNTIME;
  process.env.SIGNUP_ALLOWLIST = 'invited@example.test';
  const denied = await invoke(authHandler, {
    method: 'POST', url: '/api/auth/signup', query: { endpoint: 'signup' },
    headers: sameOriginHeaders,
    body: { email: 'outsider@example.test', password: 'correct horse battery', name: 'Outsider' },
  });
  assert.equal(denied.status, 503);
  assert.equal(executed.length, 0, 'non-local signup must be rejected before database access');
});

test('auth capabilities report the exact local or private-beta contract without database access', async () => {
  let result=await invoke(authHandler,{
    url:'/api/auth/capabilities',query:{endpoint:'capabilities'},headers:{host:'randori.example.test'},
  });
  assert.equal(result.status,200);
  assert.equal(result.headers['cache-control'],'no-store');
  assert.deepEqual(result.body,{
    ok:true,
    capabilities:{passwordLogin:true,passwordSignup:false,localIdentity:false,googleOAuth:false},
    registrationMode:'private_beta',
  });
  assert.equal(executed.length,0);

  process.env.GOOGLE_CLIENT_ID='google-client';
  process.env.GOOGLE_CLIENT_SECRET='google-secret';
  process.env.NODE_ENV='production';
  process.env.APP_URL='https://randori.example.test';
  result=await invoke(authHandler,{
    url:'/api/auth/capabilities',query:{endpoint:'capabilities'},headers:sameOriginHeaders,
  });
  assert.deepEqual(result.body,{
    ok:true,
    capabilities:{passwordLogin:true,passwordSignup:false,localIdentity:false,googleOAuth:true},
    registrationMode:'private_beta',
  });

  enableLocalPasswordSignup();
  result=await invoke(authHandler,{
    url:'/api/auth/capabilities',query:{endpoint:'capabilities'},headers:{host:'127.0.0.1:3000'},
  });
  assert.equal(result.status,200);
  assert.deepEqual(result.body,{
    ok:true,
    capabilities:{passwordLogin:true,passwordSignup:true,localIdentity:false,googleOAuth:false},
    registrationMode:'local_open',
  });
  assert.equal(executed.length,0);

  const wrongMethod=await invoke(authHandler,{
    method:'POST',url:'/api/auth/capabilities',query:{endpoint:'capabilities'},headers:localOriginHeaders,
  });
  assert.equal(wrongMethod.status,405);
  assert.deepEqual(wrongMethod.body,{error:'GET only'});
});

test('invalid production OAuth configuration is not advertised and stops before provider or database access',async()=>{
  process.env.NODE_ENV='production';
  process.env.APP_URL='http://randori.example.test';
  process.env.GOOGLE_CLIENT_ID='google-client';
  process.env.GOOGLE_CLIENT_SECRET='google-secret';
  let providerCalls=0;
  globalThis.fetch=async()=>{ providerCalls+=1; throw new Error('provider must not be called'); };

  const headers={host:'randori.example.test','x-forwarded-proto':'https'};
  const capabilities=await invoke(authHandler,{
    url:'/api/auth/capabilities',query:{endpoint:'capabilities'},headers,
  });
  assert.equal(capabilities.status,200);
  assert.equal(capabilities.body.capabilities.googleOAuth,false);

  const start=await invoke(authHandler,{
    url:'/api/auth/google/start',query:{endpoint:'google-start'},headers,
  });
  assert.equal(start.status,503);
  assert.deepEqual(start.body,{error:'Google sign-in is unavailable'});

  const callback=await invoke(authHandler,{
    url:'/api/auth/google/callback',query:{endpoint:'callback',code:'code',state:'state'},headers,
  });
  assert.equal(callback.status,503);
  assert.deepEqual(callback.body,start.body);
  const wrongMethod=await invoke(authHandler,{
    method:'POST',url:'/api/auth/google/callback',query:{endpoint:'callback'},headers,
  });
  assert.equal(wrongMethod.status,405);
  assert.deepEqual(wrongMethod.body,{error:'GET only'});
  assert.equal(providerCalls,0);
  assert.equal(getClientCalls,0);
  assert.equal(executed.length,0);
  for(const response of [capabilities,start,callback,wrongMethod]){
    assert.equal(response.headers['cache-control'],'no-store');
    assert.equal(response.headers.pragma,'no-cache');
    assert.equal(response.headers['x-content-type-options'],'nosniff');
    assert.equal(response.headers['referrer-policy'],'no-referrer');
  }
});

test('local password signup guard fails closed outside the isolated loopback runtime', () => {
  enableLocalPasswordSignup();
  const localRequest={headers:{host:'127.0.0.1:3000'},socket:{remoteAddress:'127.0.0.1'}};
  assert.equal(localPasswordSignupEnabled(localRequest),true);

  const cases=[
    ['NODE_ENV','production'],
    ['RANDORI_LOCAL_RUNTIME','false'],
    ['ALLOW_OPEN_SIGNUP','false'],
    ['CIRCLE_MEMBERSHIP_ENABLED','true'],
    ['VERCEL','1'],
    ['VERCEL_ENV','preview'],
    ['VERCEL_URL','preview.example.test'],
    ['TURSO_AUTH_TOKEN','remote-token'],
    ['TURSO_DATABASE_URL','libsql://production.example.test'],
    ['APP_URL','https://127.0.0.1:3000'],
    ['APP_URL','http://randori.example.test'],
  ];
  for(const [key,value] of cases){
    enableLocalPasswordSignup();
    process.env[key]=value;
    assert.equal(localPasswordSignupEnabled(localRequest),false,`${key} must disable local signup`);
    delete process.env[key];
  }
  enableLocalPasswordSignup();
  assert.equal(localPasswordSignupEnabled({headers:{host:'randori.example.test'},socket:{remoteAddress:'127.0.0.1'}}),false);
  assert.equal(localPasswordSignupEnabled({headers:{host:'127.0.0.1:3001'},socket:{remoteAddress:'127.0.0.1'}}),false);
  assert.equal(localPasswordSignupEnabled({headers:{host:'127.0.0.1:3000'},socket:{remoteAddress:'203.0.113.8'}}),false);
  process.env.APP_URL='http://localhost:3000';
  assert.equal(localPasswordSignupEnabled({headers:{host:'localhost:3000'},socket:{remoteAddress:'::1'}}),true);
});

test('local verified-identity adapter requires invite mode and fails closed in preview, production, remote, or non-loopback contexts',()=>{
  const localRequest={headers:{host:'127.0.0.1:3000'},socket:{remoteAddress:'127.0.0.1'}};
  enableLocalInviteSignup();
  assert.equal(localIdentityAdapterEnabled(localRequest),true);
  assert.equal(localPasswordSignupEnabled(localRequest),true);

  const cases=[
    ['NODE_ENV','production'],
    ['RANDORI_LOCAL_RUNTIME','false'],
    ['RANDORI_LOCAL_IDENTITY','false'],
    ['ALLOW_OPEN_SIGNUP','true'],
    ['CIRCLE_MEMBERSHIP_ENABLED','false'],
    ['VERCEL','1'],
    ['VERCEL_ENV','preview'],
    ['VERCEL_URL','preview.example.test'],
    ['TURSO_AUTH_TOKEN','remote-token'],
    ['TURSO_DATABASE_URL','libsql://production.example.test'],
    ['APP_URL','https://127.0.0.1:3000'],
    ['APP_URL','http://randori.example.test'],
  ];
  for(const [key,value] of cases){
    for(const cleanupKey of ['VERCEL','VERCEL_ENV','VERCEL_URL','TURSO_AUTH_TOKEN']) delete process.env[cleanupKey];
    enableLocalInviteSignup();
    process.env[key]=value;
    assert.equal(localIdentityAdapterEnabled(localRequest),false,`${key} must disable local identity`);
    delete process.env[key];
  }
  enableLocalInviteSignup();
  assert.equal(localIdentityAdapterEnabled({headers:{host:'randori.example.test'},socket:{remoteAddress:'127.0.0.1'}}),false);
  assert.equal(localIdentityAdapterEnabled({headers:{host:'127.0.0.1:3001'},socket:{remoteAddress:'127.0.0.1'}}),false);
  assert.equal(localIdentityAdapterEnabled({headers:{host:'127.0.0.1:3000'},socket:{remoteAddress:'203.0.113.9'}}),false);
});

test('capabilities and signup enforce the same production, preview, remote-db, and network boundary', async () => {
  const cases=[
    {name:'production',env:{NODE_ENV:'production'}},
    {name:'preview',env:{VERCEL_ENV:'preview'}},
    {name:'remote database',env:{TURSO_DATABASE_URL:'libsql://production.example.test'}},
    {name:'remote token',env:{TURSO_AUTH_TOKEN:'remote-token'}},
    {name:'public host',headers:{origin:'http://randori.example.test',host:'randori.example.test'}},
    {name:'remote peer',remoteAddress:'203.0.113.9'},
  ];
  for(const testCase of cases){
    for(const key of ['VERCEL','VERCEL_ENV','VERCEL_URL','TURSO_AUTH_TOKEN']) delete process.env[key];
    enableLocalPasswordSignup();
    Object.assign(process.env,testCase.env||{});
    const headers=testCase.headers||localOriginHeaders;
    const capabilities=await invoke(authHandler,{
      url:'/api/auth/capabilities',query:{endpoint:'capabilities'},headers,
      remoteAddress:testCase.remoteAddress,
    });
    assert.equal(capabilities.status,200,testCase.name);
    assert.equal(capabilities.body.capabilities.passwordSignup,false,testCase.name);
    assert.equal(capabilities.body.registrationMode,'private_beta',testCase.name);
    executed.length=0;
    const signup=await invoke(authHandler,{
      method:'POST',url:'/api/auth/signup',query:{endpoint:'signup'},headers,
      remoteAddress:testCase.remoteAddress,
      body:{email:'person@example.test',password:'correct horse battery',name:'Person'},
    });
    assert.equal(signup.status,503,testCase.name);
    assert.equal(executed.length,0,`${testCase.name} must be rejected before database access`);
  }
});

test('Google callback validates state and establishes a cookie session without leaking a token', async () => {
  process.env.APP_URL = 'https://preview.example.test';
  process.env.GOOGLE_CLIENT_ID = 'client';
  process.env.GOOGLE_CLIENT_SECRET = 'secret';
  globalThis.fetch = googleProviderFetch({claims:{
    email:'oauth@example.test',name:'OAuth User',sub:'google-123',
  }});
  executeHandler = sql => {
    if (sql.includes('SELECT id, email, is_admin, password_hash, google_sub')) return rows([]);
    if (sql.includes('INSERT INTO auth_accounts') && sql.includes('RETURNING id')) return rows([{ id: 8 }]);
    if (sql.includes('SELECT id FROM users')) return rows([]);
    return rows();
  };
  const state = 'state-value';
  const result = await invoke(authHandler, {
    url: `/api/auth/google/callback?code=ok&state=${state}`,
    query: { endpoint: 'callback', code: 'ok', state },
    headers: {
      host:'preview.example.test','x-forwarded-proto':'https',
      cookie:googleOAuthCookieHeader({state}),
    },
  });
  assert.equal(result.status, 302);
  assert.equal(result.headers.location, 'https://preview.example.test/?google=success');
  assert.doesNotMatch(result.headers.location, /token=/);
  assert.match(String(result.headers['set-cookie']), /randori_session=/);
});

test('auth validation and OAuth failure paths fail closed', async () => {
  enableLocalPasswordSignup();
  const cases = [
    [{ method: 'GET', url: '/api/auth/signup', query: { endpoint: 'signup' } }, 405],
    [{ method: 'POST', url: '/api/auth/signup', query: { endpoint: 'signup' }, body: { email: 'bad', password: 'long-enough-password', name: 'Name' } }, 400],
    [{ method: 'POST', url: '/api/auth/signup', query: { endpoint: 'signup' }, body: { email: 'a@b.test', password: 'short', name: 'Name' } }, 400],
    [{ method: 'POST', url: '/api/auth/signup', query: { endpoint: 'signup' }, body: { email: 'a@b.test', password: 'long-enough-password', name: 'X' } }, 400],
    [{ method: 'GET', url: '/api/auth/login', query: { endpoint: 'login' } }, 405],
    [{ method: 'POST', url: '/api/auth/login', query: { endpoint: 'login' }, body: {} }, 400],
    [{ method: 'POST', url: '/api/auth/logout', query: { endpoint: 'logout' } }, 200],
    [{ method: 'GET', url: '/api/auth/logout', query: { endpoint: 'logout' } }, 405],
    [{ method: 'GET', url: '/api/auth/google/start', query: { endpoint: 'google-start' } }, 503],
    [{ url: '/api/auth/unknown', query: { endpoint: 'unknown' } }, 404],
  ];
  for (const [request, status] of cases) {
    const result = await invoke(authHandler, {
      ...request,
      headers: request.method === 'POST' ? localOriginHeaders : request.headers,
    });
    assert.equal(result.status, status, request.url);
  }

  process.env.APP_URL = 'https://preview.example.test';
  process.env.GOOGLE_CLIENT_ID = 'client';
  process.env.GOOGLE_CLIENT_SECRET = 'secret';
  delete process.env.RANDORI_LOCAL_RUNTIME;
  delete process.env.RANDORI_LOCAL_IDENTITY;
  process.env.NODE_ENV='production';
  for (const query of [
    { endpoint: 'callback', error: 'denied' },
    { endpoint: 'callback' },
    { endpoint: 'callback', code: 'code', state: 'wrong' },
  ]) {
    const result = await invoke(authHandler, {
      url: '/api/auth/google/callback', query,
      headers:{host:'preview.example.test','x-forwarded-proto':'https'},
    });
    assert.equal(result.status, 302);
    assert.match(result.headers.location, /google_error=/);
  }
});

test('login rejects missing or cross-origin requests before credential or database work', async () => {
  for (const headers of [
    {},
    { origin: 'https://attacker.example', host: 'randori.example.test' },
  ]) {
    executed.length = 0;
    const result = await invoke(authHandler, {
      method: 'POST', url: '/api/auth/login', query: { endpoint: 'login' }, headers,
      body: { email: 'person@example.test', password: 'correct horse battery' },
    });
    assert.equal(result.status, 403);
    assert.equal(executed.length, 0);
  }
});

test('data read models map database rows and expose non-mutating health probes', async () => {
  const currentCycleId=resolvePairingCycle().cycleId;
  executeHandler = sql => {
    if(sql.includes('SELECT aa.id')&&sql.includes('JOIN circle_memberships cm')&&sql.includes('LIMIT 2')) return rows([{id:2,circle_id:1}]);
    const publication=existingPairingPublication(sql,{
      participantRows:[
        {user_id:2,position:0,source:'auth'},
        {user_id:4,position:1,source:'auth'},
      ],
      groupRows:[{id:20,user_a_id:2,user_b_id:4,user_c_id:null,is_ai_pair:0}],
    });
    if(publication) return publication;
    if (sql.includes('FROM auth_accounts WHERE COALESCE(is_demo,0)=0 ORDER BY id')) return rows([
      { id: 2, display_name: 'User', color: '#123456', is_available: 1, bio: '', tz: 'UTC', interview_focus: 'dsa' },
      { id: 4, display_name: 'Partner', color: '#abcdef', is_available: 0, bio: 'bio', tz: 'UTC', interview_focus: 'both' },
    ]);
    if (sql.includes('SELECT id,display_name AS name,color FROM auth_accounts')) return rows([
      { id: 2, name: 'User', color: '#123456' },
      { id: 4, name: 'Partner', color: '#abcdef' },
    ]);
    if(sql.includes('SELECT aa.id,aa.display_name AS name,aa.color')) return rows([
      {id:2,name:'User',color:'#123456'},
      {id:4,name:'Partner',color:'#abcdef'},
    ]);
    if (sql.includes('display_name as name, color, tz')) return rows([
      { id: 2, name: 'User', color: '#123456', tz: 'UTC' },
      { id: 4, name: 'Partner', color: '#abcdef', tz: 'UTC' },
      { id: 6, name: 'Third', color: '#fedcba', tz: 'UTC' },
    ]);
    if (sql.includes('FROM pairing_groups pg') && sql.includes('ORDER BY pw.week_start')) return rows([
      { pg_id: 20, week_id: 10, user_a_id: 2, user_b_id: 4, user_a_source:'auth', user_b_source:'auth', is_ai_pair: 0, week_label: '2026-W38', week_start: '2026-09-20' },
    ]);
    if (/SELECT id,\s*display_name AS name FROM auth_accounts/i.test(sql)) return rows([{ id: 2, name: 'User' }, { id: 4, name: 'Partner' }]);
    if (sql.includes('COUNT(*) as c FROM auth_accounts')) return rows([{ c: 4 }]);
    if (sql.includes('COUNT(*) as c FROM pairing_weeks')) return rows([{ c: 2 }]);
    if (sql.includes('COUNT(*) as c FROM pairing_groups pg JOIN')) return rows([{ c: 3 }]);
    if (sql.includes('COUNT(*) as c FROM pairing_groups') && sql.includes('pairing_participants viewer')) return rows([{ c: 2 }]);
    if (sql.includes('COUNT(DISTINCT pairing_groups.week_id)')) return rows([{ c: 2 }]);
    if (sql.includes('ORDER BY pw.id DESC LIMIT 1') && sql.includes('pairing_participants viewer')) return rows([{ pg_id: 20, week_id: 10 }]);
    return rows();
  };
  const auth = { 'x-test-auth': 'user' };
  const health = await invoke(dataHandler, {
    url: '/api/health/live', query: { endpoint: 'health', probe:'live' },
  });
  assert.equal(health.status,200);
  assert.deepEqual(health.body,{ok:true,status:'live'});
  assert.equal(health.headers['cache-control'],'no-store');
  assert.equal(executed.length,0,'liveness must not touch the database');
  const unavailable = await invoke(dataHandler, {
    url: '/api/health/ready', query: { endpoint: 'health', probe:'ready' },
  });
  assert.equal(unavailable.status,503);
  assert.deepEqual(unavailable.body,{ok:false,status:'unavailable'});
  assert.equal(executed.length,0,'missing readiness configuration must not touch the database');

  const circle = await invoke(dataHandler, { url: '/api/circle', query: { endpoint: 'circle' }, headers: auth });
  assert.equal(circle.body.circle.length, 2);
  assert.equal(circle.body.circle[1].is_available, false);

  const weeks = await invoke(dataHandler, { url: '/api/weeks', query: { endpoint: 'weeks' }, headers: auth });
  assert.equal(weeks.body.weeks.length,1);
  assert.equal(weeks.body.weeks[0].pairs[0].b_name,'Partner');
  assert.equal(weeks.body.weeks[0].pairs[0].c_name,null);
  assert.equal(weeks.body.weeks[0].members,undefined);
  assert.equal(weeks.body.weeks[0].pairs[0].members.length,2);
  assert.equal(weeks.body.weeks[0].is_current,true);
  assert.equal(weeks.body.weeks[0].week_label,currentCycleId);
  assert.equal(weeks.body.current_week_id,10);

  const history = await invoke(dataHandler, { url: '/api/history', query: { endpoint: 'history' }, headers: auth });
  assert.equal(history.body.history[0].partner_name, 'Partner');

  const stats = await invoke(dataHandler, { url: '/api/stats', query: { endpoint: 'stats' }, headers: auth });
  assert.equal(stats.body.total_users, 4);
  assert.equal(stats.body.your_sessions, 2);
});

test('database readiness failures are generic, private, and never logged through mutating health paths',async()=>{
  process.env.TURSO_DATABASE_URL='libsql://private-database.example.test';
  process.env.TURSO_AUTH_TOKEN='private-readiness-token';
  executeHandler=()=>{ throw new Error('SELECT secret FROM private_table using private-readiness-token'); };
  const result=await invoke(dataHandler,{
    url:'/api/health/ready',query:{endpoint:'health',probe:'ready'},
  });
  assert.equal(result.status,503);
  assert.equal(result.headers['cache-control'],'no-store');
  assert.deepEqual(result.body,{ok:false,status:'unavailable'});
  assert.doesNotMatch(JSON.stringify(result.body),/secret|private|select|libsql/i);
  assert.equal(sentryExceptionCalls.length,0);
  assert.equal(sentryMessageCalls.length,0);
  assert.equal(executed.some(call=>/\b(?:CREATE|ALTER|DROP|INSERT|UPDATE|DELETE|REPLACE)\b/i.test(call.sql)),false);

  const invalidMethod=await invoke(dataHandler,{
    method:'POST',url:'/api/health/ready',query:{endpoint:'health',probe:'ready'},
  });
  assert.equal(invalidMethod.status,405);
  assert.equal(invalidMethod.headers.allow,'GET, HEAD');
  assert.deepEqual(invalidMethod.body,{ok:false,status:'unavailable'});
});

test('local readiness refuses an absent database before client construction or file creation',async()=>{
  const directory=mkdtempSync(join(tmpdir(),'randori-health-handler-'));
  const databasePath=join(directory,'missing.sqlite');
  try{
    process.env.NODE_ENV='development';
    process.env.RANDORI_LOCAL_RUNTIME='true';
    process.env.TURSO_DATABASE_URL=pathToFileURL(databasePath).href;
    process.env.RANDORI_LOCAL_DATABASE_PATH=databasePath;
    process.env.CIRCLE_MEMBERSHIP_ENABLED='false';
    const result=await invoke(dataHandler,{
      url:'/api/health/ready',query:{endpoint:'health',probe:'ready'},
    });
    assert.equal(result.status,503);
    assert.deepEqual(result.body,{ok:false,status:'unavailable'});
    assert.equal(result.headers['cache-control'],'no-store');
    assert.equal(getClientCalls,0);
    assert.equal(existsSync(databasePath),false);
  }finally{
    rmSync(directory,{recursive:true,force:true});
  }
});

test('profile, pair schedule, and messages enforce ownership while catalogue and run history are read-only', async () => {
  let scheduleState = {
    id: 30,
    week_id: 10,
    pair_group_id: 20,
    proposed_times: '[]',
    agreed_time: null,
    updated_at: 'now',
  };
  let scheduleWrites = 0;
  const profileRow = {
    id: 2, email: 'user@example.test', display_name: 'Updated User', color: '#123456',
    is_available: 1, is_admin: 0, bio: 'Ready', tz: 'UTC', interview_focus: 'system', leetcode_handle: 'coder',
  };
  executeHandler = (sql, args) => {
    if (sql.includes('SELECT id,email,is_admin FROM auth_accounts WHERE id=')) return rows([{ id: 1, email: 'admin@example.test', is_admin: 1 }]);
    if (sql.trimStart().startsWith('SELECT pg.id AS pair_group_id')) return rows([{ pair_group_id: 20, week_id:10, user_a_id: 2, user_b_id: 4, user_c_id:null }]);
    if (sql.includes('SELECT id,email,display_name,color') || sql.includes('SELECT id,email,display_name,color,is_available')) return rows([profileRow]);
    if (sql.startsWith("PRAGMA table_info('pair_schedules')")) return rows([
      'week_id','pair_group_id','proposed_times','agreed_time','created_at','updated_at',
    ].map(name=>({name})));
    if (sql.startsWith("PRAGMA index_list('pair_schedules')")) return rows([{name:'uq_pair_schedules_week_pair',unique:1}]);
    if (sql.startsWith('PRAGMA index_info')) return rows([{seqno:0,name:'week_id'},{seqno:1,name:'pair_group_id'}]);
    if (sql.includes('UPDATE pair_schedules') && sql.includes('RETURNING proposed_times')) {
      scheduleWrites += 1;
      const [proposed,agreed,updatedAt,weekId,pairId,oldProposed,oldAgreed,oldUpdatedAt]=args;
      if(oldProposed!==scheduleState.proposed_times || oldAgreed!==scheduleState.agreed_time || oldUpdatedAt!==scheduleState.updated_at){
        return rows([]);
      }
      scheduleState = {
        ...scheduleState,
        week_id: weekId,
        pair_group_id: pairId,
        proposed_times: proposed,
        agreed_time: agreed,
        updated_at: updatedAt,
      };
      return rows([{...scheduleState}],{rowsAffected:1});
    }
    if (sql.includes('FROM pair_schedules') && sql.includes('pair_access')) return rows([{...scheduleState,data_present:1}]);
    if (sql.includes('SELECT id,display_name FROM auth_accounts WHERE id=')) return rows([{ id: 2, display_name: 'Updated User' }]);
    if (sql.includes('INSERT INTO pair_messages') && sql.includes('RETURNING id')) return rows([{
      id: 40, sender_id: 2, message: 'Sunday works', created_at: '2026-09-18T06:00:00.000Z',
    }]);
    if (sql.includes('FROM pair_messages pm')) return rows([{
      id: 40, sender_id: 2, sender_name: 'Updated User', message: 'Sunday works', created_at: '2026-09-18T06:00:00.000Z',
    }]);
    if (sql.includes('FROM session_runs WHERE user_id=')) return rows([{
      id:60,
      user_id:2,
      question_slug:'binary-search',
      code_preview:'function binarySearch() {}',
      test_cases_snapshot:'{"source":"original-catalog","version":3,"total_count":5}',
    }]);
    return rows();
  };
  const headers = { 'x-test-auth': 'user' };
  const profile = await invoke(dataHandler, {
    method: 'POST', url: '/api/profile', query: { endpoint: 'profile' }, headers,
    body: { name: 'Updated User', bio: 'Ready', tz: 'UTC', interview_focus: 'system_design' },
  });
  assert.equal(profile.status, 200);
  assert.equal(profile.body.user.interview_focus, 'system');

  const bypassedAvailability = await invoke(dataHandler, {
    method: 'POST', url: '/api/profile', query: { endpoint: 'profile' }, headers,
    body: { is_available: false },
  });
  assert.equal(bypassedAvailability.status,400);
  assert.match(bypassedAvailability.body.error,/settings\/availability/);

  const initialSchedule = await invoke(dataHandler, {
    url: '/api/schedule?room_id=week_10_pair_20', query: { endpoint: 'schedule', room_id:'week_10_pair_20' }, headers,
  });
  assert.equal(initialSchedule.status,200);
  assert.deepEqual(initialSchedule.body.schedule.proposals,[]);

  const schedule = await invoke(dataHandler, {
    method: 'POST', url: '/api/schedule', query: { endpoint: 'schedule' }, headers,
    body: { room_id:'week_10_pair_20', action:'propose', base_version:initialSchedule.body.schedule.version, instant:'2026-09-20T08:00:00+01:00' },
  });
  assert.equal(schedule.status, 200);
  assert.equal(schedule.body.schedule.proposals[0].instant,'2026-09-20T07:00:00.000Z');
  assert.equal(schedule.body.schedule.proposals[0].proposed_by,2);

  const accepted = await invoke(dataHandler, {
    method: 'POST', url: '/api/schedule', query: { endpoint: 'schedule' }, headers,
    body: { room_id:'week_10_pair_20', action:'accept', base_version:schedule.body.schedule.version, proposal_id:schedule.body.schedule.proposals[0].proposal_id },
  });
  assert.equal(accepted.body.schedule.agreed_time,'2026-09-20T07:00:00.000Z');

  const clearedAgreement = await invoke(dataHandler, {
    method: 'POST', url: '/api/schedule', query: { endpoint: 'schedule' }, headers,
    body: { room_id:'week_10_pair_20', action:'clear', base_version:accepted.body.schedule.version },
  });
  assert.equal(clearedAgreement.body.schedule.agreed_time,null);

  const removed = await invoke(dataHandler, {
    method: 'POST', url: '/api/schedule', query: { endpoint: 'schedule' }, headers,
    body: { room_id:'week_10_pair_20', action:'remove', base_version:clearedAgreement.body.schedule.version, proposal_id:schedule.body.schedule.proposals[0].proposal_id },
  });
  assert.deepEqual(removed.body.schedule.proposals,[]);
  assert.equal(scheduleWrites,4);

  const message = await invoke(dataHandler, {
    method: 'POST', url: '/api/messages', query: { endpoint: 'messages' }, headers,
    body: { room_id: 'week_10_pair_20', message: 'Sunday works' },
  });
  assert.equal(message.status, 201);
  assert.equal(message.body.room_id, 'week_10_pair_20');
  assert.equal(message.body.message.message, 'Sunday works');

  const question = await invoke(dataHandler, {
    method: 'POST', url: '/api/questions', query: { endpoint: 'questions' }, headers: { 'x-test-auth': 'admin' },
    body: { title: 'Binary Search', description: 'Find a value.', test_cases: [{ input: [1], expect: 0 }] },
  });
  assert.equal(question.status, 405);
  assert.match(question.body.error, /read-only/i);

  const run = await invoke(dataHandler, {
    method: 'POST', url: '/api/runs', query: { endpoint: 'runs' }, headers,
    body: { code: 'return 0', question_slug: 'binary-search', passed_count: 999, total_count: 999 },
  });
  assert.equal(run.status, 405);
  assert.match(run.body.error, /execution service/i);
  assert.equal(executed.some(call => call.sql.includes('INSERT INTO session_runs')), false);

  const history = await invoke(dataHandler, {
    url: '/api/runs', query: { endpoint: 'runs' }, headers,
  });
  assert.equal(history.status, 200);
  assert.equal(history.body.runs[0].id, 60);
  assert.equal(history.body.runs[0].question_version,null);
  assert.equal(history.body.runs[0].authoritative,false);
  assert.equal(history.body.runs[0].code_preview,'function binarySearch() {}');
  assert.equal('test_cases_snapshot' in history.body.runs[0],false);
});

test('migrated local profile requests probe schema without request-time DDL',async()=>{
  enableLocalInviteSignup();
  const profileRow={
    id:2,email:'user@example.test',display_name:'Local User',color:'#123456',is_available:1,
    is_admin:0,is_demo:0,bio:'',tz:'UTC',interview_focus:'both',leetcode_handle:'',
  };
  executeHandler=sql=>sql.includes('FROM auth_accounts WHERE id=?')?rows([profileRow]):rows();
  const headers={...localOriginHeaders,'x-test-auth':'user'};
  const read=await invoke(dataHandler,{url:'/api/profile',query:{endpoint:'profile'},headers});
  assert.equal(read.status,200);
  const write=await invoke(dataHandler,{
    method:'POST',url:'/api/profile',query:{endpoint:'profile'},headers,
    body:{display_name:'Local User',tz:'UTC'},
  });
  assert.equal(write.status,200);
  assert.equal(executed.some(call=>/\b(?:CREATE|ALTER|DROP)\b/i.test(call.sql)),false);
  assert.equal(executed.some(call=>/FROM auth_accounts LIMIT 0/i.test(call.sql)),true);
});

test('run history verifies signed authoritative results and rejects legacy or tampered attestations', async () => {
  const resultsJson=JSON.stringify([{idx:0,pass:true,error:null},{idx:1,pass:false,error:null}]);
  const fields={
    userId:2,
    questionSlug:'focus-block-rollup',
    questionVersion:1,
    language:'javascript',
    passedCount:1,
    totalCount:2,
    resultsJson,
  };
  const attestation=signRunForTest(fields);
  const signedSnapshot=JSON.stringify({
    source:'original-catalog',
    version:1,
    total_count:2,
    attestation_version:2,
    attestation_key_id:runKeyIdForTest(),
    attestation,
  });
  process.env.RUN_ATTESTATION_SECRET='rotated-run-attestation-secret-at-least-32-characters';
  process.env.RUN_ATTESTATION_PREVIOUS_SECRETS=TEST_JWT_SECRET;
  executeHandler=sql=>{
    if(sql.includes('FROM session_runs WHERE user_id=')) return rows([
      {id:71,user_id:2,question_slug:fields.questionSlug,language:fields.language,code_preview:'const privatePersonalCode = true;',passed_count:1,total_count:2,results_json:resultsJson,test_cases_snapshot:signedSnapshot},
      {id:72,user_id:2,question_slug:fields.questionSlug,language:fields.language,code_preview:'preview 72',passed_count:2,total_count:2,results_json:resultsJson,test_cases_snapshot:signedSnapshot},
      {id:73,user_id:2,question_slug:fields.questionSlug,language:fields.language,code_preview:'preview 73',passed_count:1,total_count:2,results_json:'[]',test_cases_snapshot:signedSnapshot},
      {id:74,user_id:2,question_slug:'legacy-question',language:'javascript',code_preview:'preview 74',passed_count:999,total_count:999,results_json:'[]',test_cases_snapshot:null},
    ]);
    return rows();
  };
  const history=await invoke(dataHandler,{
    url:'/api/runs',query:{endpoint:'runs'},headers:{'x-test-auth':'user'},
  });
  assert.equal(history.status,200);
  assert.deepEqual(history.body.runs.map(run=>run.authoritative),[true,false,false,false]);
  assert.deepEqual(history.body.runs.map(run=>run.question_version),[1,null,null,null]);
  assert.equal(history.body.runs[0].code_preview,'const privatePersonalCode = true;');
  assert.equal(history.body.runs.every(run=>
    !('code' in run) && !('results_json' in run) && !('test_cases_snapshot' in run)
  ),true);
});

test('run schema readiness coalesces concurrent pair-feed initialization and probes before access', async () => {
  let releaseInitialization;
  let reportInitializationStarted;
  const initializationGate=new Promise(resolve=>{ releaseInitialization=resolve; });
  const initializationStarted=new Promise(resolve=>{ reportInitializationStarted=resolve; });
  let baseInitializations=0;
  let completedProbes=0;
  let accessChecks=0;
  executeHandler=async sql=>{
    if(sql.startsWith('CREATE TABLE IF NOT EXISTS auth_accounts')){
      baseInitializations+=1;
      reportInitializationStarted();
      await initializationGate;
      return rows();
    }
    if(sql.startsWith('SELECT id,display_name FROM auth_accounts LIMIT 0')
      || sql.startsWith('SELECT id,week_id,user_a_id,user_b_id,user_c_id FROM pairing_groups LIMIT 0')
      || sql.startsWith('SELECT week_id,user_id,source FROM pairing_participants LIMIT 0')
      || sql.startsWith('SELECT id,user_id,week_id,pair_group_id,question_id,question_slug,language,code,test_cases_snapshot')){
      completedProbes+=1;
      return rows();
    }
    if(sql.trimStart().startsWith('SELECT pg.id AS pair_group_id')){
      assert.equal(completedProbes,4,'pair access must wait for every readiness probe');
      accessChecks+=1;
      return rows([{pair_group_id:20,week_id:10,user_a_id:2,user_b_id:4,user_c_id:null}]);
    }
    if(sql.includes('FROM session_runs sr')) return rows([{id:null}]);
    return rows();
  };
  const request={
    url:'/api/runs?room_id=week_10_pair_20&after_id=0&limit=20',
    query:{endpoint:'runs',room_id:'week_10_pair_20',after_id:'0',limit:'20'},
    headers:{'x-test-auth':'user'},
  };

  const first=invoke(dataHandler,request);
  await initializationStarted;
  const second=invoke(dataHandler,request);
  await Promise.resolve();
  assert.equal(baseInitializations,1,'concurrent requests must share one in-flight initialization');
  assert.equal(accessChecks,0,'membership checks must not race ahead of readiness');
  releaseInitialization();

  const responses=await Promise.all([first,second]);
  assert.deepEqual(responses.map(response=>response.status),[200,200]);
  assert.equal(baseInitializations,1);
  assert.equal(completedProbes,4,'the shared readiness promise probes each required table once');
  assert.equal(accessChecks,2,'each request still performs its own membership authorization');
});

test('failed run schema readiness is not cached and the next request retries initialization', async () => {
  let baseInitializations=0;
  let authProbeAttempts=0;
  let accessChecks=0;
  executeHandler=sql=>{
    if(sql.startsWith('CREATE TABLE IF NOT EXISTS auth_accounts')) baseInitializations+=1;
    if(sql.startsWith('SELECT id,display_name FROM auth_accounts LIMIT 0')){
      authProbeAttempts+=1;
      if(authProbeAttempts===1) throw new Error('schema probe unavailable');
      return rows();
    }
    if(sql.trimStart().startsWith('SELECT pg.id AS pair_group_id')){
      accessChecks+=1;
      return rows([{pair_group_id:20,week_id:10,user_a_id:2,user_b_id:4,user_c_id:null}]);
    }
    if(sql.includes('FROM session_runs sr')) return rows([{id:null}]);
    return rows();
  };
  const request={
    url:'/api/runs?room_id=week_10_pair_20&after_id=0&limit=20',
    query:{endpoint:'runs',room_id:'week_10_pair_20',after_id:'0',limit:'20'},
    headers:{'x-test-auth':'user'},
  };
  const originalError=console.error;
  console.error=()=>{};
  try{
    const failed=await invoke(dataHandler,request);
    assert.equal(failed.status,503);
    assert.deepEqual(failed.body,{error:'runs unavailable'});
    assert.equal(accessChecks,0);

    const retried=await invoke(dataHandler,request);
    assert.equal(retried.status,200);
    assert.equal(baseInitializations,2,'a rejected readiness promise must be cleared');
    assert.equal(authProbeAttempts,2);
    assert.equal(accessChecks,1);
  }finally{
    console.error=originalError;
  }
});

test('pair run feed is member-scoped, incremental, private, and verifies the submitting user', async () => {
  const memoryDb=createClient({url:'file::memory:'});
  const validResults=JSON.stringify([{idx:0,pass:true,error:null}]);
  const validFields={
    userId:4,
    questionSlug:'focus-block-rollup',
    questionVersion:1,
    language:'javascript',
    passedCount:1,
    totalCount:1,
    resultsJson:validResults,
  };
  const validSnapshot=JSON.stringify({
    source:'original-catalog',version:1,total_count:1,attestation_version:2,
    attestation_key_id:runKeyIdForTest(),attestation:signRunForTest(validFields),
  });
  const tamperedSnapshot=JSON.stringify({
    source:'original-catalog',version:1,total_count:1,attestation_version:2,
    attestation_key_id:runKeyIdForTest(),attestation:'0'.repeat(64),
  });
  try{
    await memoryDb.batch([
      `CREATE TABLE auth_accounts (id INTEGER PRIMARY KEY,email TEXT,display_name TEXT,color TEXT)`,
      `CREATE TABLE pairing_groups (id INTEGER PRIMARY KEY,week_id INTEGER NOT NULL,user_a_id INTEGER NOT NULL,user_b_id INTEGER NOT NULL,user_c_id INTEGER)`,
      `CREATE TABLE pairing_participants (week_id INTEGER NOT NULL,user_id INTEGER NOT NULL,position INTEGER NOT NULL,source TEXT NOT NULL,PRIMARY KEY(week_id,user_id))`,
      `CREATE TABLE session_runs (id INTEGER PRIMARY KEY,user_id INTEGER,week_id INTEGER,pair_group_id INTEGER,question_id INTEGER,question_slug TEXT,language TEXT,code TEXT NOT NULL,test_cases_snapshot TEXT,results_json TEXT,passed_count INTEGER,total_count INTEGER,duration_ms INTEGER,created_at TEXT)`,
      `INSERT INTO auth_accounts (id,email,display_name,color) VALUES (2,'viewer@example.test','Viewer','#123456'),(4,'partner@example.test','Partner','#654321'),(5,'outsider@example.test','Outsider','#abcdef')`,
      `INSERT INTO pairing_groups (id,week_id,user_a_id,user_b_id,user_c_id) VALUES (20,10,2,4,NULL),(21,11,4,5,NULL)`,
      `INSERT INTO pairing_participants (week_id,user_id,position,source) VALUES (10,2,0,'auth'),(10,4,1,'auth'),(11,4,0,'auth'),(11,5,1,'auth')`,
    ],'write');
    await memoryDb.execute({
      sql:`INSERT INTO session_runs (id,user_id,week_id,pair_group_id,question_slug,language,code,test_cases_snapshot,results_json,passed_count,total_count,duration_ms,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      args:[79,4,10,20,'focus-block-rollup','javascript','PRIVATE OLD CODE',validSnapshot,validResults,1,1,9,'2026-09-18T08:00:00Z'],
    });
    await memoryDb.execute({
      sql:`INSERT INTO session_runs (id,user_id,week_id,pair_group_id,question_slug,language,code,test_cases_snapshot,results_json,passed_count,total_count,duration_ms,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      args:[81,4,10,20,'focus-block-rollup','javascript','PRIVATE PARTNER CODE',validSnapshot,validResults,1,1,12,'2026-09-18T08:01:00Z'],
    });
    await memoryDb.execute({
      sql:`INSERT INTO session_runs (id,user_id,week_id,pair_group_id,question_slug,language,code,test_cases_snapshot,results_json,passed_count,total_count,duration_ms,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      args:[82,4,11,21,'focus-block-rollup','javascript','OTHER ROOM CODE',validSnapshot,validResults,1,1,13,'2026-09-18T08:02:00Z'],
    });
    await memoryDb.execute({
      sql:`INSERT INTO session_runs (id,user_id,week_id,pair_group_id,question_slug,language,code,test_cases_snapshot,results_json,passed_count,total_count,duration_ms,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      args:[83,2,10,20,'focus-block-rollup','python','PRIVATE VIEWER CODE',tamperedSnapshot,validResults,1,1,14,'2026-09-18T08:03:00Z'],
    });
    databaseDelegate=memoryDb;

    const feed=await invoke(dataHandler,{
      url:'/api/runs?room_id=week_10_pair_20&after_id=80&limit=2',
      query:{endpoint:'runs',room_id:'week_10_pair_20',after_id:'80',limit:'2'},
      headers:{'x-test-auth':'user'},
    });
    assert.equal(feed.status,200);
    assert.deepEqual(feed.body,{
      ok:true,
      room_id:'week_10_pair_20',
      runs:[{
        id:81,
        runner:{id:4,display_name:'Partner'},
        question_slug:'focus-block-rollup',question_version:1,language:'javascript',
        passed_count:1,total_count:1,duration_ms:12,created_at:'2026-09-18T08:01:00Z',authoritative:true,
      },{
        id:83,
        runner:{id:2,display_name:'Viewer'},
        question_slug:'focus-block-rollup',question_version:null,language:'python',
        passed_count:1,total_count:1,duration_ms:14,created_at:'2026-09-18T08:03:00Z',authoritative:false,
      }],
      after:83,
    });
    assert.equal(JSON.stringify(feed.body).includes('PRIVATE'),false);
    for(const field of ['code','code_preview','test_cases_snapshot','results_json','attestation','email','piston','stdout','stderr']){
      assert.equal(Object.hasOwn(feed.body.runs[0],field),false,`${field} must stay private`);
    }

    const bootstrap=await invoke(dataHandler,{
      url:'/api/runs?room_id=week_10_pair_20&after_id=0&limit=2',
      query:{endpoint:'runs',room_id:'week_10_pair_20',after_id:'0',limit:'2'},
      headers:{'x-test-auth':'user'},
    });
    assert.equal(bootstrap.status,200);
    assert.deepEqual(bootstrap.body.runs.map(run=>run.id),[81,83],
      'initial load returns the newest bounded window in ascending display order');
    assert.equal(bootstrap.body.after,83);
  }finally{
    databaseDelegate=null;
    memoryDb.close();
  }
});

test('pair run feed strictly validates cursors and authorizes the exact canonical room', async () => {
  const headers={'x-test-auth':'user'};
  const invalidQueries=[
    {endpoint:'runs',room_id:''},
    {endpoint:'runs',room_id:'week_01_pair_2'},
    {endpoint:'runs',room_id:'week_1_pair_2/extra'},
    {endpoint:'runs',room_id:['week_1_pair_2','week_2_pair_3']},
    {endpoint:'runs',room_id:'week_1_pair_2',after_id:'-1'},
    {endpoint:'runs',room_id:'week_1_pair_2',after_id:'01'},
    {endpoint:'runs',room_id:'week_1_pair_2',after_id:['1','2']},
    {endpoint:'runs',room_id:'week_1_pair_2',after_id:'9007199254740992'},
    {endpoint:'runs',room_id:'week_1_pair_2',limit:'0'},
    {endpoint:'runs',room_id:'week_1_pair_2',limit:'21'},
    {endpoint:'runs',room_id:'week_1_pair_2',limit:'01'},
    {endpoint:'runs',room_id:'week_1_pair_2',limit:['1','2']},
  ];
  for(const query of invalidQueries){
    executed.length=0;
    const invalid=await invoke(dataHandler,{url:'/api/runs',query,headers});
    assert.equal(invalid.status,400,JSON.stringify(query));
    assert.equal(executed.length,0,'invalid room feed queries must fail before database access');
  }

  for(const access of ['missing','forbidden']){
    const accessDb=createClient({url:'file::memory:'});
    try{
      await accessDb.batch([
        `CREATE TABLE auth_accounts (id INTEGER PRIMARY KEY,email TEXT,display_name TEXT,color TEXT)`,
        `CREATE TABLE pairing_groups (id INTEGER PRIMARY KEY,week_id INTEGER NOT NULL,user_a_id INTEGER NOT NULL,user_b_id INTEGER NOT NULL,user_c_id INTEGER)`,
        `CREATE TABLE pairing_participants (week_id INTEGER NOT NULL,user_id INTEGER NOT NULL,position INTEGER NOT NULL,source TEXT NOT NULL,PRIMARY KEY(week_id,user_id))`,
        `CREATE TABLE session_runs (id INTEGER PRIMARY KEY,user_id INTEGER,week_id INTEGER,pair_group_id INTEGER,question_id INTEGER,question_slug TEXT,language TEXT,code TEXT NOT NULL,test_cases_snapshot TEXT,results_json TEXT,passed_count INTEGER,total_count INTEGER,duration_ms INTEGER,created_at TEXT)`,
      ],'write');
      if(access==='forbidden'){
        await accessDb.batch([
          `INSERT INTO pairing_groups (id,week_id,user_a_id,user_b_id,user_c_id) VALUES (2,1,4,5,NULL)`,
          `INSERT INTO pairing_participants (week_id,user_id,position,source) VALUES (1,4,0,'auth'),(1,5,1,'auth')`,
        ],'write');
      }
      databaseDelegate=accessDb;
      const denied=await invoke(dataHandler,{
        url:'/api/runs',query:{endpoint:'runs',room_id:'week_1_pair_2'},headers,
      });
      assert.equal(denied.status,404,access);
    }finally{
      databaseDelegate=null;
      accessDb.close();
    }
  }

  executeHandler=(sql,args)=>{
    if(sql.includes('FROM session_runs WHERE user_id=')){
      assert.equal(args.at(-1),50,'personal history retains its existing limit contract');
      return rows([]);
    }
    return rows();
  };
  const personal=await invoke(dataHandler,{
    url:'/api/runs',query:{endpoint:'runs',limit:'50',after_id:'not-a-room-cursor'},headers,
  });
  assert.equal(personal.status,200);
});

test('my-pair returns only current-cycle membership and a canonical room id', async () => {
  let paired = true;
  let solo = false;
  let poisonedSchedule = false;
  executeHandler = (sql,args) => {
    if(sql.includes('SELECT aa.id')&&sql.includes('JOIN circle_memberships cm')&&sql.includes('LIMIT 2')) return rows([{id:2,circle_id:1}]);
    const participantRows=paired
      ?(solo?[{user_id:2,position:0,source:'auth'}]:[
        {user_id:2,position:0,source:'auth'},
        {user_id:4,position:1,source:'auth'},
      ])
      :[{user_id:4,position:0,source:'auth'}];
    const groupRows=paired
      ?[solo
        ?{id:20,user_a_id:2,user_b_id:2,user_c_id:null,is_ai_pair:1}
        :{id:20,user_a_id:2,user_b_id:4,user_c_id:null,is_ai_pair:0}]
      :[{id:20,user_a_id:4,user_b_id:4,user_c_id:null,is_ai_pair:1}];
    const publication=existingPairingPublication(sql,{participantRows,groupRows});
    if(publication) return publication;
    if(sql.includes('SELECT aa.id,aa.display_name AS name,aa.color')) return rows(participantRows.map(item=>({
      id:item.user_id,name:item.user_id===2?'User':'Partner',color:item.user_id===2?'#123456':'#abcdef',
    })));
    if (sql.includes('SELECT aa.id,aa.display_name,aa.color,aa.bio,aa.tz,aa.interview_focus,aa.leetcode_handle')) {
      return rows([{ id: 4, display_name: 'Partner', color: '#abcdef', bio: '', tz: 'UTC', interview_focus: 'dsa', leetcode_handle: 'partner' }]);
    }
    if (sql.includes('SELECT id, display_name, color, tz, interview_focus FROM auth_accounts')) {
      return rows([{ id: 2, display_name: 'User', color: '#123456', tz: 'UTC', interview_focus: 'both' }]);
    }
    if (sql.includes('FROM pair_schedules') && sql.includes('pair_access')) {
      return rows(poisonedSchedule
        ? [{id:30,proposed_times:'not-json',agreed_time:null,updated_at:'now',access_present:1}]
        : [{id:null,proposed_times:null,agreed_time:null,updated_at:null,access_present:1}]);
    }
    return rows();
  };

  const current = await invoke(dataHandler, {
    url: '/api/my-pair', query: { endpoint: 'my-pair' }, headers: { 'x-test-auth': 'user' },
  });
  assert.equal(current.status, 200);
  assert.equal(current.body.room_id, 'week_10_pair_20');
  assert.equal(current.body.pair.room_id, 'week_10_pair_20');
  assert.equal('email' in current.body.partner, false);

  solo = true;
  const soloPractice = await invoke(dataHandler, {
    url: '/api/my-pair', query: { endpoint: 'my-pair' }, headers: { 'x-test-auth': 'user' },
  });
  assert.equal(soloPractice.status,200);
  assert.equal(soloPractice.body.partner.name,'Solo practice');
  assert.equal(soloPractice.body.pair.solo_practice,true);

  solo = false;
  poisonedSchedule = true;
  const poisoned = await invoke(dataHandler, {
    url: '/api/my-pair', query: { endpoint: 'my-pair' }, headers: { 'x-test-auth': 'user' },
  });
  assert.equal(poisoned.status,200);
  assert.equal(poisoned.body.schedule,null,'invalid legacy schedule data must not take down the pair dashboard');

  paired = false;
  executed.length = 0;
  const absent = await invoke(dataHandler, {
    url: '/api/my-pair', query: { endpoint: 'my-pair' }, headers: { 'x-test-auth': 'user' },
  });
  assert.equal(absent.status, 200);
  assert.equal(absent.body.paired, false);
  assert.equal(absent.body.reason, 'not_paired_this_cycle');
  assert.equal(executed.some(call => call.sql.includes('JOIN pairing_weeks')), false);
});

test('my-pair ignores stale and future weeks but fails closed on a current legacy week',async()=>{
  let currentCycleQuery=null;
  let legacyCurrent=true;
  executeHandler=(sql,args)=>{
    if(sql.includes('SELECT aa.id')&&sql.includes('JOIN circle_memberships cm')&&sql.includes('LIMIT 2')) return rows([{id:2,circle_id:1}]);
    if(sql.includes('FROM pairing_week_runs WHERE week_label=?')) return rows([]);
    if(sql.includes('FROM pairing_weeks WHERE week_label=?')){
      currentCycleQuery={sql,args};
      return legacyCurrent?rows([{
        id:10,week_label:resolvePairingCycle().cycleId,week_start:resolvePairingCycle().startsAt,is_demo:0,
      }]):rows([]);
    }
    return rows();
  };

  const legacy=await invoke(dataHandler,{
    url:'/api/my-pair',query:{endpoint:'my-pair'},headers:{'x-test-auth':'user'},
  });
  assert.equal(legacy.status,503);
  assert.deepEqual(legacy.body,{error:'pairing unavailable'});

  legacyCurrent=false;
  const result=await invoke(dataHandler,{
    url:'/api/my-pair',query:{endpoint:'my-pair'},headers:{'x-test-auth':'user'},
  });
  assert.equal(result.status,200);
  assert.equal(result.body.paired,false);
  assert.equal(result.body.reason,'no_pairing_for_current_cycle');
  assert.ok(currentCycleQuery);
  assert.equal(currentCycleQuery.args.length,1);
  assert.match(String(currentCycleQuery.args[0]),/^\d{4}-W\d{2}$/);
  assert.equal(executed.some(call=>call.sql.includes('JOIN pairing_participants AS viewer')),false);
});

test('current pairing reads reject revoked members and incomplete publications without leaking history',async()=>{
  let member=false;
  let corrupt=false;
  let outsideCircle=false;
  executeHandler=sql=>{
    if(sql.includes('SELECT aa.id')&&sql.includes('JOIN circle_memberships cm')&&sql.includes('LIMIT 2')){
      return rows(member?[{id:2,circle_id:1}]:[]);
    }
    if(corrupt){
      const cycle=resolvePairingCycle();
      if(sql.includes('FROM pairing_week_runs WHERE week_label=?')) return rows([{
        week_label:cycle.cycleId,week_id:10,generation_token:'corrupt-token',generation:1,
        algorithm_version:'fair-v2',algorithm_seed:`${cycle.cycleId}:weekly`,participant_count:2,
        participants_json:'[{"user_id":2,"source":"auth"},{"user_id":4,"source":"auth"}]',created_at:cycle.startsAt,
      }]);
      if(sql.includes('FROM pairing_weeks WHERE week_label=?')) return rows([{
        id:10,week_label:cycle.cycleId,week_start:cycle.startsAt,is_demo:0,
      }]);
      if(sql.includes('FROM pairing_participants pp')) return rows([{user_id:2,position:0,source:'auth'}]);
      if(sql.includes('FROM pairing_groups pg')&&sql.includes('JOIN pairing_week_runs pwr')) return rows([{
        id:20,user_a_id:2,user_b_id:4,user_c_id:null,is_ai_pair:0,
      }]);
    }
    if(outsideCircle){
      const publication=existingPairingPublication(sql,{
        participantRows:[
          {user_id:2,position:0,source:'auth'},
          {user_id:99,position:1,source:'auth'},
        ],
        groupRows:[{id:20,user_a_id:2,user_b_id:99,user_c_id:null,is_ai_pair:0}],
      });
      if(publication) return publication;
      if(sql.includes('SELECT aa.id,aa.display_name AS name,aa.color')){
        return rows([{id:2,name:'User',color:'#123456'}]);
      }
    }
    return rows();
  };

  for(const endpoint of ['weeks','my-pair']){
    executed.length=0;
    const revoked=await invoke(dataHandler,{
      url:`/api/${endpoint}`,query:{endpoint},headers:{'x-test-auth':'user'},
    });
    assert.equal(revoked.status,403);
    assert.deepEqual(revoked.body,{error:'circle membership required'});
    assert.equal(executed.some(call=>call.sql.includes('FROM pairing_week_runs WHERE week_label=?')),false);
  }

  member=true;
  corrupt=true;
  for(const endpoint of ['weeks','my-pair']){
    const result=await invoke(dataHandler,{
      url:`/api/${endpoint}`,query:{endpoint},headers:{'x-test-auth':'user'},
    });
    assert.equal(result.status,503);
    assert.equal(result.body.error,'pairing unavailable');
    assert.doesNotMatch(JSON.stringify(result.body),/corrupt-token|participants_json/);
  }

  corrupt=false;
  outsideCircle=true;
  for(const endpoint of ['weeks','my-pair']){
    const result=await invoke(dataHandler,{
      url:`/api/${endpoint}`,query:{endpoint},headers:{'x-test-auth':'user'},
    });
    assert.equal(result.status,503);
    assert.equal(result.body.error,'pairing unavailable');
    assert.doesNotMatch(JSON.stringify(result.body),/99/);
  }
});

test('history includes every other member when the viewer is user_c', async () => {
  executeHandler=sql=>{
    if(sql.includes('FROM pairing_groups pg') && sql.includes('ORDER BY pw.week_start')) return rows([{
      pg_id:20,week_id:10,user_a_id:4,user_b_id:5,user_c_id:2,
      user_a_source:'auth',user_b_source:'auth',user_c_source:'auth',is_ai_pair:0,
      week_label:'2026-W38',week_start:'2026-09-20',topic:'Arrays',topic_kind:'dsa',
    }]);
    if(/SELECT id,\s*display_name AS name FROM auth_accounts/i.test(sql)) return rows([
      {id:2,name:'User'},
      {id:4,name:'First partner'},
      {id:5,name:'Second partner'},
    ]);
    return rows();
  };
  const result=await invoke(dataHandler,{
    url:'/api/history',query:{endpoint:'history'},headers:{'x-test-auth':'user'},
  });
  assert.equal(result.status,200);
  assert.deepEqual(result.body.history[0].partner_ids,[4,5]);
  assert.deepEqual(result.body.history[0].partner_names,['First partner','Second partner']);
  assert.equal(result.body.partner_counts['First partner'],1);
  assert.equal(result.body.partner_counts['Second partner'],1);
});

test('execution uses only server-owned versioned cases and persists exact authoritative results', async () => {
  const question=listPublicExercises()[0];
  const submitted=[];
  let nextRunId=70;
  executeHandler = sql => {
    if(sql.trimStart().startsWith('SELECT pg.id AS pair_group_id')) return rows([{pair_group_id:20,week_id:10,user_a_id:8,user_b_id:9,user_c_id:2}]);
    if(sql.includes("'execute_lease_start'") && sql.includes('RETURNING id')) return rows([{id:500+nextRunId}]);
    if(sql.includes('INSERT INTO session_runs') && sql.includes('RETURNING id')) return rows([{id:nextRunId++}]);
    return rows();
  };
  globalThis.fetch = async (url,options) => {
    assert.match(String(url),/piston\/execute/);
    assert.doesNotMatch(String(url),/leetcode/i);
    const submission=JSON.parse(options.body);
    submitted.push(submission);
    const source=submission.files[0].content;
    const prefix=source.match(/(__RANDORI_RESULT_[a-f0-9]{32}__:)/)?.[1];
    assert.ok(prefix,'the harness must use a per-run result marker');
    const command=submission.language==='javascript'?process.execPath:'python3';
    // Feed the generated harness over stdin: Linux limits each argv entry to
    // roughly 128 KiB, while the real runner receives this source in an HTTP
    // body and supports the bounded scale cases below that request limit.
    const execution=spawnSync(command,['-'],{input:source,encoding:'utf8',timeout:5000});
    assert.equal(
      execution.error,
      undefined,
      `${submission.language === 'python' ? 'Python 3 (`python3`)' : 'Node.js'} is required for the ${submission.language} execution test`,
    );
    return new Response(JSON.stringify({run:{code:execution.status,stdout:`{"idx":0,"pass":true}\n${execution.stdout}`,stderr:execution.stderr}}),{status:200});
  };

  const headers={'x-test-auth':'user'};
  for(const [language,expectedFile] of [['javascript','main.js'],['python','main.py']]){
    const suite=createEvaluationSuite(question.slug,question.version,language,{random:()=>0.5});
    executed.length=0;
    const code=language==='javascript'
      ? `function ${suite.entrypoint}(blocks){
          const result=[];
          for(const block of blocks){
            const previous=result[result.length-1];
            if(previous && previous.label===block.label) previous.minutes+=block.minutes;
            else result.push({...block});
          }
          return result;
        } // PASS_ALL_SUBMISSION`
      : `def ${suite.entrypoint}(blocks):
          result=[]
          for block in blocks:
              previous=result[-1] if result else None
              if previous and previous['label']==block['label']:
                  previous['minutes']+=block['minutes']
              else:
                  result.append(dict(block))
          return result`;
    const result=await invoke(dataHandler,{
      method:'POST',url:'/api/execute',query:{endpoint:'execute'},headers,
      body:{
        language,
        code,
        question_slug:question.slug,
        test_cases:[{input:'CLIENT_FORGED_SECRET',expect:'CLIENT_FORGED_SECRET'}],
        results:[{pass:true}],
        passed_count:999,
        total_count:999,
        ...(language==='python'?{week_id:10,pair_group_id:20}:{}),
      },
    });
    assert.equal(result.status,200,language);
    assert.equal(result.body.question_version,question.version);
    assert.equal(result.body.passed_count,suite.tests.length);
    assert.equal(result.body.total_count,suite.tests.length);
    assert.equal(result.body.run_id,language==='javascript'?70:71);
    assert.equal(submitted.at(-1).files[0].name,expectedFile);
    assert.equal(JSON.stringify(result.body).includes('CLIENT_FORGED_SECRET'),false);
    assert.equal('test_cases' in result.body,false);
    assert.equal('stdout' in result.body.piston,false);
    assert.equal('stderr' in result.body.piston,false);
    assert.deepEqual(Object.keys(result.body.results[0]).sort(),['error','idx','pass']);

    const encoded=submitted.at(-1).files[0].content.match(/(?:Buffer\.from|b64decode)\('([A-Za-z0-9+/=]+)'/)?.[1];
    assert.ok(encoded,`hidden ${language} suite must be embedded server-side`);
    const runnerBundle=JSON.parse(Buffer.from(encoded,'base64').toString('utf8'));
    assert.equal(JSON.stringify(runnerBundle).includes('"expected"'),false,'answer keys must remain in the API process');
    assert.equal(runnerBundle.entrypoint,suite.entrypoint);
    assert.equal(runnerBundle.tests.length,suite.tests.length);
    assert.equal(runnerBundle.tests.every(test=>Object.keys(test).length===1 && Array.isArray(test.args)),true);
    assert.equal(submitted.at(-1).files[0].content.includes('CLIENT_FORGED_SECRET'),false);

    const insert=executed.find(call=>call.sql.includes('INSERT INTO session_runs') && call.sql.includes('RETURNING id'));
    assert.ok(insert,'execute must persist its server-computed result');
    const persistedArgs=insert.args.slice(-12);
    assert.equal(persistedArgs[4],question.slug);
    assert.equal(persistedArgs[1],language==='python'?10:null);
    assert.equal(persistedArgs[2],language==='python'?20:null);
    assert.equal(persistedArgs[9],suite.tests.length);
    assert.equal(persistedArgs[10],suite.tests.length);
    const snapshot=JSON.parse(persistedArgs[7]);
    assert.equal(snapshot.source,'original-catalog');
    assert.equal(snapshot.version,question.version);
    assert.equal(snapshot.total_count,suite.tests.length);
    assert.equal(snapshot.attestation_version,2);
    assert.equal(snapshot.attestation_key_id,runKeyIdForTest());
    assert.equal(snapshot.attestation,signRunForTest({
      userId:2,
      questionSlug:question.slug,
      questionVersion:question.version,
      language,
      passedCount:suite.tests.length,
      totalCount:suite.tests.length,
      resultsJson:persistedArgs[8],
    }));
    assert.deepEqual(JSON.parse(persistedArgs[8]),result.body.results);
    assert.equal(executed.some(call=>/CREATE TABLE|ALTER TABLE|CREATE INDEX/i.test(call.sql)),false);
  }

  for(const language of ['javascript','python']){
    const suite=createEvaluationSuite(question.slug,question.version,language,{random:()=>0.5});
    const code=language==='javascript'
      ? `function ${suite.entrypoint}(){ return null; }`
      : `def ${suite.entrypoint}(*args):\n    return None`;
    const broken=await invoke(dataHandler,{
      method:'POST',url:'/api/execute',query:{endpoint:'execute'},headers,
      body:{language,code,question_slug:question.slug,question_version:question.version},
    });
    assert.equal(broken.status,200,language);
    assert.equal(broken.body.passed_count,0,language);
    assert.equal(broken.body.total_count,suite.tests.length,language);
    assert.equal(broken.body.results.every(result=>result.pass===false),true,language);
  }

  for (const language of ['typescript','java','go','c++','c','ruby']) {
    const rejected=await invoke(dataHandler,{
      method:'POST',url:'/api/execute',query:{endpoint:'execute'},headers,
      body:{language,code:'print(1)',question_slug:question.slug},
    });
    assert.equal(rejected.status,400,language);
    assert.match(rejected.body.error,/javascript and python/i);
  }
});

test('canonical room execution authorizes membership before work and persists the derived pair', async () => {
  const question=listPublicExercises()[0];
  const entrypoint=question.languages.javascript.entrypoint;
  let networkCalls=0;
  executeHandler=(sql,args)=>{
    if(sql.trimStart().startsWith('SELECT pg.id AS pair_group_id')){
      assert.deepEqual(args,[2,20,42,2,2,2]);
      return rows([{pair_group_id:20,week_id:42,user_a_id:2,user_b_id:4,user_c_id:null}]);
    }
    if(sql.includes("'execute_lease_start'") && sql.includes('RETURNING id')) return rows([{id:220}]);
    if(sql.includes("event='execute_attempt'")) return rows([{c:1}]);
    if(sql.includes('INSERT INTO session_runs') && sql.includes('RETURNING id')) return rows([{id:120}]);
    return rows();
  };
  globalThis.fetch=async url=>{
    networkCalls+=1;
    assert.match(String(url),/piston\/execute/);
    return new Response(JSON.stringify({run:{code:0,stdout:'',stderr:''}}),{status:200});
  };

  const result=await invoke(dataHandler,{
    method:'POST',url:'/api/execute',query:{endpoint:'execute'},headers:{'x-test-auth':'user'},
    body:{
      room_id:'week_42_pair_20',
      language:'javascript',
      code:`function ${entrypoint}(){ return null; }`,
      question_slug:question.slug,
      question_version:question.version,
    },
  });
  assert.equal(result.status,200);
  assert.equal(result.body.run_id,120);
  assert.equal(networkCalls,1);

  const membershipIndex=executed.findIndex(call=>call.sql.trimStart().startsWith('SELECT pg.id AS pair_group_id'));
  const firstWriteIndex=executed.findIndex(call=>call.sql.includes('INSERT INTO app_logs'));
  assert.ok(membershipIndex>=0);
  assert.ok(firstWriteIndex>membershipIndex,'membership must be proven before leases, quota writes, or provider work');
  const insert=executed.find(call=>call.sql.includes('INSERT INTO session_runs') && call.sql.includes('RETURNING id'));
  assert.ok(insert);
  assert.equal(insert.args.slice(-12)[1],42);
  assert.equal(insert.args.slice(-12)[2],20);
});

test('canonical room execution rejects ambiguous, malformed, missing, and unauthorized rooms before work', async () => {
  const question=listPublicExercises()[0];
  const entrypoint=question.languages.javascript.entrypoint;
  const base={
    language:'javascript',
    code:`function ${entrypoint}(){ return null; }`,
    question_slug:question.slug,
    question_version:question.version,
  };
  let networkCalls=0;
  globalThis.fetch=async()=>{ networkCalls+=1; throw new Error('unauthorized request must not reach Piston'); };

  for(const room_id of ['',null,42,'week_0_pair_20','week_01_pair_20','week_42_pair_020','week_42_pair_20/extra','week_9007199254740992_pair_20']){
    executed.length=0;
    const malformed=await invoke(dataHandler,{
      method:'POST',url:'/api/execute',query:{endpoint:'execute'},headers:{'x-test-auth':'user'},
      body:{...base,room_id},
    });
    assert.equal(malformed.status,400,String(room_id));
    assert.equal(executed.length,0,'malformed room ids fail before database access');
  }

  for(const field of ['week_id','pair_group_id','pg_id','pair_id']){
    executed.length=0;
    const ambiguous=await invoke(dataHandler,{
      method:'POST',url:'/api/execute',query:{endpoint:'execute'},headers:{'x-test-auth':'user'},
      body:{...base,room_id:'week_42_pair_20',[field]:null},
    });
    assert.equal(ambiguous.status,400,field);
    assert.equal(executed.length,0,'ambiguous identifiers fail before database access');
  }

  let access='missing';
  executeHandler=sql=>{
    if(sql.trimStart().startsWith('SELECT pg.id AS pair_group_id')){
      return rows([]);
    }
    throw new Error('room access denial must stop all later database work');
  };
  const missing=await invoke(dataHandler,{
    method:'POST',url:'/api/execute',query:{endpoint:'execute'},headers:{'x-test-auth':'user'},
    body:{...base,room_id:'week_42_pair_20'},
  });
  assert.equal(missing.status,404);
  access='forbidden';
  const forbidden=await invoke(dataHandler,{
    method:'POST',url:'/api/execute',query:{endpoint:'execute'},headers:{'x-test-auth':'user'},
    body:{...base,room_id:'week_42_pair_20'},
  });
  assert.equal(forbidden.status,404);
  assert.equal(networkCalls,0);
  assert.equal(executed.some(call=>call.sql.includes('INSERT INTO app_logs') || call.sql.includes('INSERT INTO session_runs')),false);
});

test('execution rejects unavailable questions and enforces pair membership before calling Piston', async () => {
  const question=listPublicExercises()[0];
  let networkCalls=0;
  globalThis.fetch=async()=>{ networkCalls+=1; throw new Error('network must not be reached'); };
  executeHandler=sql=>{
    if(sql.trimStart().startsWith('SELECT pg.id AS pair_group_id')) return rows([]);
    return rows();
  };
  const headers={'x-test-auth':'user'};
  for(const [slug,version] of [['unknown-original-question',1],['archived-session-streak',1],[question.slug,999]]){
    const result=await invoke(dataHandler,{
      method:'POST',url:'/api/execute',query:{endpoint:'execute'},headers,
      body:{language:'javascript',code:'function answer(){}',question_slug:slug,question_version:version},
    });
    assert.equal(result.status,404,`${slug}@${version}`);
    assert.match(result.body.error,/not found or unavailable/i);
  }
  const invalidVersion=await invoke(dataHandler,{
    method:'POST',url:'/api/execute',query:{endpoint:'execute'},headers,
    body:{language:'javascript',code:'function answer(){}',question_slug:question.slug,question_version:'latest'},
  });
  assert.equal(invalidVersion.status,400);

  const oversized=await invoke(dataHandler,{
    method:'POST',url:'/api/execute',query:{endpoint:'execute'},headers,
    body:{language:'javascript',code:'x'.repeat(20001),question_slug:question.slug},
  });
  assert.equal(oversized.status,413);

  const forbidden=await invoke(dataHandler,{
    method:'POST',url:'/api/execute',query:{endpoint:'execute'},headers,
    body:{language:'javascript',code:'function answer(){}',question_slug:question.slug,week_id:10,pair_group_id:20},
  });
  assert.equal(forbidden.status,404);

  executeHandler=sql=>{
    if(sql.includes("'execute_lease_start'") && sql.includes('RETURNING id')) return rows([{id:201}]);
    if(sql.includes("event='execute_attempt'")) return rows([{c:11}]);
    return rows();
  };
  const rateLimited=await invoke(dataHandler,{
    method:'POST',url:'/api/execute',query:{endpoint:'execute'},headers,
    body:{language:'javascript',code:'function answer(){}',question_slug:question.slug},
  });
  assert.equal(rateLimited.status,429);
  assert.match(rateLimited.body.error,/rate limit/i);
  assert.equal(networkCalls,0);
  assert.equal(executed.some(call=>call.sql.includes('INSERT INTO session_runs')),false);
});

test('execution failures never run request-time schema DDL', async () => {
  const question=listPublicExercises()[0];
  executeHandler=sql=>{
    if(sql.trimStart().startsWith('SELECT pg.id AS pair_group_id')) throw new Error('forced membership lookup failure');
    return rows();
  };
  const originalError=console.error;
  console.error=()=>{};
  try{
    const result=await invoke(dataHandler,{
      method:'POST',url:'/api/execute',query:{endpoint:'execute'},headers:{'x-test-auth':'user'},
      body:{language:'javascript',code:'function answer(){}',question_slug:question.slug,week_id:10,pair_group_id:20},
    });
    assert.equal(result.status,503);
    assert.deepEqual(result.body,{error:'execution service unavailable'});
    assert.equal(executed.some(call=>/CREATE TABLE|ALTER TABLE|CREATE INDEX/i.test(call.sql)),false);
  }finally{
    console.error=originalError;
  }
});

test('Piston failures are reported without leaking provider output or persisting a partial run', async () => {
  const question=listPublicExercises()[0];
  executeHandler=sql=>sql.includes("'execute_lease_start'") && sql.includes('RETURNING id')?rows([{id:202}]):rows();
  process.env.NEXT_PUBLIC_SENTRY_DSN='https://public@example.test/1';
  globalThis.fetch=async url=>{
    assert.match(String(url),/piston\/execute/);
    return new Response('UPSTREAM_ECHOED_HIDDEN_HARNESS',{status:502});
  };
  const failed=await invoke(dataHandler,{
    method:'POST',url:'/api/execute',query:{endpoint:'execute'},headers:{'x-test-auth':'user'},
    body:{language:'javascript',code:'function answer(){}',question_slug:question.slug},
  });
  assert.equal(failed.status,500);
  assert.equal(JSON.stringify(failed.body).includes('UPSTREAM_ECHOED_HIDDEN_HARNESS'),false);
  assert.equal(executed.some(call=>call.sql.includes('INSERT INTO session_runs')),false);
  assert.equal(sentryMessageCalls.length,1);
  assert.equal(sentryMessageCalls[0][1].tags.event,'execute_fail');
});

test('a concurrent execution by the same user is rejected before a second Piston call', async () => {
  const question=listPublicExercises()[0];
  const entrypoint=question.languages.javascript.entrypoint;
  let releaseFirst;
  let markStarted;
  let networkCalls=0;
  const firstCanFinish=new Promise(resolve=>{ releaseFirst=resolve; });
  const firstStarted=new Promise(resolve=>{ markStarted=resolve; });
  executeHandler=sql=>{
    if(sql.includes("'execute_lease_start'") && sql.includes('RETURNING id')) return rows([{id:203}]);
    if(sql.includes("event='execute_attempt'")) return rows([{c:1}]);
    if(sql.includes('INSERT INTO session_runs') && sql.includes('RETURNING id')) return rows([{id:90}]);
    return rows();
  };
  globalThis.fetch=async (_url,options)=>{
    networkCalls+=1;
    const submission=JSON.parse(options.body);
    assert.match(submission.files[0].content,/__RANDORI_RESULT_[a-f0-9]{32}__:/);
    markStarted();
    await firstCanFinish;
    return new Response(JSON.stringify({run:{code:0,stdout:'',stderr:''}}),{status:200});
  };
  const request={
    method:'POST',url:'/api/execute',query:{endpoint:'execute'},headers:{'x-test-auth':'user'},
    body:{language:'javascript',code:`function ${entrypoint}(){ return []; }`,question_slug:question.slug},
  };
  const first=invoke(dataHandler,request);
  await firstStarted;
  const concurrent=await invoke(dataHandler,request);
  assert.equal(concurrent.status,429);
  assert.match(concurrent.body.error,/already in progress/i);
  assert.equal(networkCalls,1);
  releaseFirst();
  const completed=await first;
  assert.equal(completed.status,200);
});

test('an unmatched database lease rejects a cross-instance-style concurrent execution', async () => {
  const question=listPublicExercises()[0];
  let networkCalls=0;
  executeHandler=sql=>{
    if(sql.includes("'execute_lease_start'") && sql.includes('RETURNING id')) return rows([]);
    return rows();
  };
  globalThis.fetch=async()=>{ networkCalls+=1; throw new Error('Piston must not be called without a lease'); };
  const result=await invoke(dataHandler,{
    method:'POST',url:'/api/execute',query:{endpoint:'execute'},headers:{'x-test-auth':'user'},
    body:{language:'javascript',code:'function answer(){}',question_slug:question.slug},
  });
  assert.equal(result.status,429);
  assert.match(result.body.error,/already in progress/i);
  assert.equal(networkCalls,0);
  assert.equal(executed.some(call=>call.sql.includes("'execute_attempt'")),false);
});

test('client telemetry cannot forge runner leases or execution quota rows', async () => {
  const result=await invoke(dataHandler,{
    method:'POST',
    url:'/api/logs',
    query:{endpoint:'logs'},
    headers:{'x-test-auth':'user'},
    body:{level:'info',source:'runner',event:'execute_lease_end',message:'123'},
  });
  assert.equal(result.status,200);
  assert.equal(result.body.inserted,1);
  const insert=executed.find(call=>call.sql.includes('INSERT INTO app_logs') && call.args.length===9);
  assert.ok(insert);
  assert.equal(insert.args[1],'client');
  assert.equal(insert.args[2],'client_execute_lease_end');

  executed.length=0;
  const quota=await invoke(dataHandler,{
    method:'POST',
    url:'/api/logs',
    query:{endpoint:'logs'},
    headers:{'x-test-auth':'user'},
    body:{source:'client',event:'execute_attempt',message:'forged quota'},
  });
  assert.equal(quota.status,200);
  const quotaInsert=executed.find(call=>call.sql.includes('INSERT INTO app_logs') && call.args.length===9);
  assert.equal(quotaInsert.args[2],'client_execute_attempt');
});

test('declared and streamed oversized Piston responses fail closed before run persistence', async () => {
  const question=listPublicExercises()[0];
  executeHandler=sql=>sql.includes("'execute_lease_start'") && sql.includes('RETURNING id')?rows([{id:204}]):rows();
  const responses=[
    ()=>new Response('{}',{status:200,headers:{'content-length':String(300*1024)}}),
    ()=>new Response('x'.repeat(300*1024),{status:200}),
  ];
  for(const response of responses){
    globalThis.fetch=async()=>response();
    const result=await invoke(dataHandler,{
      method:'POST',url:'/api/execute',query:{endpoint:'execute'},headers:{'x-test-auth':'user'},
      body:{language:'javascript',code:'function answer(){}',question_slug:question.slug},
    });
    assert.equal(result.status,500);
    await new Promise(resolve=>setImmediate(resolve));
  }
  assert.equal(executed.some(call=>call.sql.includes('INSERT INTO session_runs')),false);
});

test('questions expose only the active original catalogue and make no LeetCode or database request', async () => {
  let networkCalls=0;
  globalThis.fetch=async()=>{ networkCalls+=1; throw new Error('catalogue browsing must be offline'); };
  const anonymous = await invoke(dataHandler, { url: '/api/questions', query: { endpoint: 'questions' } });
  assert.equal(anonymous.status, 401);

  executed.length = 0;
  const questions = await invoke(dataHandler, {
    url: '/api/questions', query: { endpoint: 'questions' }, headers: { 'x-test-auth': 'user' },
  });
  assert.equal(questions.status, 200);
  assert.equal(questions.body.questions.length,10);
  assert.equal(questions.body.questions.every(question=>question.source==='randori-original' && question.status==='active'),true);
  assert.equal(questions.body.questions.some(question=>question.slug==='archived-session-streak'),false);
  for(const question of questions.body.questions){
    const serialized=JSON.stringify(question);
    assert.doesNotMatch(serialized,/"(?:tests|test_cases|expected|evaluationSuites)"\s*:/);
    assert.doesNotMatch(serialized,/leetcode/i);
  }
  assert.equal(executed.length,0);
  assert.equal(networkCalls,0);

  const first=questions.body.questions[0];
  const detail=await invoke(dataHandler,{
    url:`/api/questions?slug=${first.slug}`,
    query:{endpoint:'questions',slug:first.slug},
    headers:{'x-test-auth':'user'},
  });
  assert.equal(detail.status,200);
  assert.deepEqual(detail.body.question,first);

  const retired=await invoke(dataHandler,{
    url:'/api/questions?slug=archived-session-streak&version=1',
    query:{endpoint:'questions',slug:'archived-session-streak',version:'1'},
    headers:{'x-test-auth':'user'},
  });
  assert.equal(retired.status,404);

  const mutation=await invoke(dataHandler,{
    method:'POST',url:'/api/questions',query:{endpoint:'questions'},headers:{'x-test-auth':'admin'},
    body:{title:'Forged',test_cases:[{input:'hidden',expect:true}]},
  });
  assert.equal(mutation.status,405);
  assert.equal(executed.some(call => call.sql.includes('DELETE FROM pair_schedules WHERE id NOT IN')), false,
    'ordinary requests must not run the destructive legacy schedule migration');
  assert.equal(executed.some(call => call.sql.includes('CREATE UNIQUE INDEX IF NOT EXISTS uq_pair_schedules_week_pair')), false,
    'ordinary requests must not create the legacy schedule uniqueness index');
});

test('bundled legacy seed ingestion runs only through admin init', async () => {
  executeHandler = sql => {
    if (sql.includes('SELECT id,email,is_admin FROM auth_accounts WHERE id=')) return rows([{ id: 1, email: 'admin@example.test', is_admin: 1 }]);
    if (sql.includes('SELECT id FROM circles WHERE is_primary=1')) return rows([{ id: 1 }]);
    return rows();
  };
  executed.length = 0;
  const initialized = await invoke(dataHandler, {
    method: 'POST', url: '/api/init', query: { endpoint: 'init' }, headers: { 'x-test-auth': 'admin' },
  });
  assert.equal(initialized.status, 200);
  assert.equal(executed.some(call => call.sql.includes('INSERT INTO custom_questions')), true);
  const dedupe = executed.findIndex(call => call.sql.includes('DELETE FROM pair_schedules WHERE id NOT IN'));
  const uniqueIndex = executed.findIndex(call => call.sql.includes('CREATE UNIQUE INDEX IF NOT EXISTS uq_pair_schedules_week_pair'));
  assert.ok(dedupe >= 0 && uniqueIndex > dedupe, 'legacy schedules must be deterministically deduped before the unique index');
});

test('admin init reports a visible error when the legacy schedule migration fails', async () => {
  executeHandler = sql => {
    if (sql.includes('SELECT id,email,is_admin FROM auth_accounts WHERE id=')) return rows([{ id: 1, email: 'admin@example.test', is_admin: 1 }]);
    if (sql.includes('DELETE FROM pair_schedules WHERE id NOT IN')) throw new Error('database is read only');
    return rows();
  };
  const result = await invoke(dataHandler, {
    method: 'POST', url: '/api/init', query: { endpoint: 'init' }, headers: { 'x-test-auth': 'admin' },
  });
  assert.equal(result.status, 500);
  assert.match(result.body.error, /schedule uniqueness migration failed/i);
  assert.match(result.body.detail, /read only/i);
});

test('data validation and access-control branches reject malformed or cross-pair requests', async () => {
  executeHandler = sql => {
    if (sql.trimStart().startsWith('SELECT pg.id AS pair_group_id')) return rows([]);
    if (sql.includes('SELECT author_id FROM custom_questions')) return rows([{ author_id: 7 }]);
    if (sql.includes('SELECT is_admin FROM auth_accounts')) return rows([{ is_admin: 0 }]);
    return rows();
  };
  const headers = { 'x-test-auth': 'user' };
  const cases = [
    [{ method: 'POST', url: '/api/circle', query: { endpoint: 'circle' }, headers }, 405],
    [{ method: 'POST', url: '/api/weeks', query: { endpoint: 'weeks' }, headers }, 405],
    [{ method: 'POST', url: '/api/history', query: { endpoint: 'history' }, headers }, 405],
    [{ method: 'GET', url: '/api/init', query: { endpoint: 'init' }, headers }, 405],
    [{ method: 'PUT', url: '/api/profile', query: { endpoint: 'profile' }, headers }, 405],
    [{ method: 'POST', url: '/api/profile', query: { endpoint: 'profile' }, headers, body: {} }, 400],
    [{ url: '/api/schedule', query: { endpoint: 'schedule' }, headers }, 400],
    [{ url: '/api/schedule', query: { endpoint:'schedule', room_id:'week_10_pair_20' }, headers }, 404],
    [{ method: 'POST', url: '/api/messages', query: { endpoint: 'messages' }, headers, body: {} }, 400],
    [{ method: 'POST', url: '/api/messages', query: { endpoint: 'messages' }, headers, body: { room_id: 'week_10_pair_20', message: 'no access' } }, 404],
    [{ method: 'POST', url: '/api/questions', query: { endpoint: 'questions' }, headers, body: {} }, 405],
    [{ method: 'POST', url: '/api/questions', query: { endpoint: 'questions' }, headers, body: { title: 'Title' } }, 405],
    [{ method: 'DELETE', url: '/api/questions', query: { endpoint: 'questions' }, headers, body: {} }, 405],
    [{ method: 'DELETE', url: '/api/questions', query: { endpoint: 'questions', id: 50 }, headers }, 405],
    [{ method: 'PUT', url: '/api/runs', query: { endpoint: 'runs' }, headers }, 405],
    [{ method: 'POST', url: '/api/runs', query: { endpoint: 'runs' }, headers, body: {} }, 405],
    [{ method: 'POST', url: '/api/execute', query: { endpoint: 'execute' }, headers, body: {} }, 400],
    [{ method: 'POST', url: '/api/leetcode', query: { endpoint: 'leetcode' }, headers }, 405],
    [{ url: '/api/leetcode', query: { endpoint: 'leetcode' }, headers }, 403],
    [{ method: 'PUT', url: '/api/logs', query: { endpoint: 'logs' }, headers }, 405],
    [{ url: '/api/not-real', query: { endpoint: 'not-real' }, headers }, 404],
  ];
  for (const [request, status] of cases) {
    const result = await invoke(dataHandler, request);
    assert.equal(result.status, status, `${request.method || 'GET'} ${request.url}`);
  }
});

test('LeetCode detail cannot publish cached content while authorization is disabled', async () => {
  let queriedCache = false;
  executeHandler = sql => {
    if (sql.includes('FROM custom_questions WHERE leetcode_slug=')) queriedCache = true;
    return rows();
  };
  const result = await invoke(dataHandler, {
    method: 'GET', url: '/api/leetcode/two-sum',
    query: { endpoint: 'leetcode', slug: 'two-sum' },
    headers: { 'x-test-auth': 'admin' },
  });
  assert.equal(result.status, 403);
  assert.match(result.body.error, /written authorization/i);
  assert.equal(queriedCache, false);
});

test('authorized LeetCode detail remains admin-only', async () => {
  process.env.LEETCODE_INGESTION_AUTHORIZED = 'true';
  let queriedCache = false;
  executeHandler = sql => {
    if (sql.includes('SELECT id,email,is_admin FROM auth_accounts WHERE id=')) {
      return rows([{ id: 2, email: 'user@example.test', is_admin: 0 }]);
    }
    if (sql.includes('FROM custom_questions WHERE leetcode_slug=')) queriedCache = true;
    return rows();
  };
  const result = await invoke(dataHandler, {
    method: 'GET', url: '/api/leetcode/two-sum',
    query: { endpoint: 'leetcode', slug: 'two-sum' },
    headers: { 'x-test-auth': 'user' },
  });
  assert.equal(result.status, 403);
  assert.match(result.body.error, /admin only/i);
  assert.equal(queriedCache, false);
});

test('authorized LeetCode ingestion parses approved remote metadata through mocked HTTP only', async () => {
  process.env.LEETCODE_INGESTION_AUTHORIZED = 'true';
  globalThis.fetch = async url => {
    if (String(url).includes('leetcode.com/graphql')) {
      return new Response(JSON.stringify({ data: { question: {
        title: 'Two Sum', titleSlug: 'two-sum', difficulty: 'Easy',
        content: '<p>Example 1:</p><pre>Input: nums = [2,7,11,15], target = 9\nOutput: [0,1]</pre><p>Constraints: 2 <= nums.length <= 100</p>',
        exampleTestcases: '[2,7,11,15]\n9', topicTags: [{ slug: 'array' }],
      } } }), { status: 200 });
    }
    if (String(url).includes('alfa-leetcode-api')) {
      return new Response(JSON.stringify({ exampleTestcases: '[3,2,4]\n6', content: '' }), { status: 200 });
    }
    throw new Error(`unexpected network target: ${url}`);
  };
  executeHandler = sql => {
    if (sql.includes('SELECT id,email,is_admin FROM auth_accounts WHERE id=')) return rows([{ id: 1, email: 'admin@example.test', is_admin: 1 }]);
    return rows();
  };
  const result = await invoke(dataHandler, {
    method: 'POST', url: '/api/leetcode/sync', query: { endpoint: 'leetcode-sync', slug: 'two-sum' },
    headers: { 'x-test-auth': 'admin' }, body: {},
  });
  assert.equal(result.status, 200);
  assert.equal(result.body.synced_count, 1);
  assert.equal(result.body.synced[0].slug, 'two-sum');
  assert.ok(result.body.synced[0].test_cases_count >= 2);
});

test('AI consent path stores a template analysis and exposes owned feedback history', async () => {
  process.env.AI_ENABLED = 'true';
  executeHandler = sql => {
    if (sql.trimStart().startsWith('SELECT pg.id AS pair_group_id')) return rows([{ pair_group_id: 20, week_id: 10, user_a_id: 2, user_b_id: 3, user_c_id: null, is_ai_pair: 0, week_label: '2026-W38' }]);
    if (sql.includes('SELECT user_id FROM ai_consents')) return rows([{ user_id: 2 }, { user_id: 3 }]);
    if (sql.includes('SELECT is_demo FROM auth_accounts')) return rows([{ is_demo: 0 }]);
    if (sql.trimStart().startsWith('SELECT calls FROM ai_account_monthly_usage')) return rows([{ calls: 2 }]);
    if (sql.includes('INSERT INTO ai_account_monthly_reservations') && sql.includes('RETURNING reservation_id')) return rows([{ reservation_id: 'reservation-70' }]);
    if (sql.includes('INSERT INTO ai_account_monthly_usage') && sql.includes('RETURNING calls')) return rows([{ calls: 3 }]);
    if (sql.includes('SELECT calls FROM ai_usage')) return rows([{ calls: 3 }]);
    if (sql.includes('SELECT calls,tokens_in FROM ai_usage')) return rows([{ calls: 3, tokens_in: 100 }]);
    if (sql.includes('INSERT INTO ai_sessions') && sql.includes('RETURNING id')) return rows([{ id: 70 }]);
    if (sql.includes('UPDATE ai_account_monthly_reservations') && sql.includes('RETURNING session_id')) return rows([{ session_id: 70 }]);
    if (sql.includes('INSERT INTO ai_feedback') && sql.includes('RETURNING id')) return rows([{ id: 71 }]);
    if (sql.includes('FROM ai_feedback af JOIN ai_sessions ase') && sql.includes('af.session_id=')) return rows([{
      id: 71, session_id: 70, feedback_json: '{"overall_score":7}', evidence: '{"validation":true}',
      model_used: 'mock', created_by: 2, room_id: 'room', pair_label: 'Pair', confidence: 0.8,
    }]);
    if (sql.includes('FROM ai_feedback af JOIN ai_sessions ase') && sql.includes('ase.created_by=')) return rows([{ id: 71, session_id: 70 }]);
    if (sql.includes('SELECT * FROM ai_usage')) return rows([{ calls: 3 }]);
    return rows();
  };
  const headers = { 'x-test-auth': 'user' };
  const denied = await invoke(aiHandler, {
    method: 'POST', url: '/api/ai/analyze', query: { endpoint: 'analyze' }, headers,
    body: { room_id: 'week_10_pair_20', transcript: 'I explained the approach clearly.', ai_consent: false },
  });
  assert.equal(denied.status, 403);

  const analyzed = await invoke(aiHandler, {
    method: 'POST', url: '/api/ai/analyze', query: { endpoint: 'analyze' }, headers,
    body: { room_id: 'week_10_pair_20', pair_label: 'untrusted label', transcript: 'I explained the approach clearly and discussed complexity.', code: 'return answer;', ai_consent: true, duration_sec: 600 },
  });
  assert.equal(analyzed.status, 200);
  assert.equal(analyzed.body.mocked, true);
  assert.equal(analyzed.body.session_id, 70);
  const sessionInsert = executed.find(entry => entry.sql.includes('INSERT INTO ai_sessions'));
  assert.equal(sessionInsert.args[0], 'week_10_pair_20');
  assert.equal(sessionInsert.args[1], '2026-W38 · Pair 20');

  const feedback = await invoke(aiHandler, {
    url: '/api/ai/feedback?id=70', query: { endpoint: 'feedback', id: 70 }, headers,
  });
  assert.equal(feedback.body.feedback.overall_score, 7);

  const history = await invoke(aiHandler, {
    url: '/api/ai/history', query: { endpoint: 'history' }, headers,
  });
  assert.equal(history.status, 200);
  assert.equal(history.body.feedbacks.length, 1);
});

test('AI analysis requires trusted room membership and every human participant consent', async () => {
  process.env.AI_ENABLED = 'true';
  let consentedIds = [2];
  executeHandler = (sql, args) => {
    if (sql.trimStart().startsWith('SELECT pg.id AS pair_group_id')) {
      if (Number(args[0]) === 20) return rows([{ pair_group_id: 20, week_id: 10, user_a_id: 2, user_b_id: 3, user_c_id: null, is_ai_pair: 0, week_label: '2026-W38' }]);
      if (Number(args[0]) === 21) return rows([{ pair_group_id: 21, week_id: 10, user_a_id: 1, user_b_id: 3, user_c_id: null, is_ai_pair: 0, week_label: '2026-W38' }]);
      return rows([]);
    }
    if (sql.includes('SELECT user_id FROM ai_consents')) return rows(consentedIds.map(user_id => ({ user_id })));
    if (sql.includes('SELECT is_demo FROM auth_accounts')) return rows([{ is_demo: 0 }]);
    if (sql.includes('SELECT calls FROM ai_usage')) return rows([{ calls: 0 }]);
    if (sql.includes('SELECT calls,tokens_in FROM ai_usage')) return rows([{ calls: 0, tokens_in: 0 }]);
    if (sql.trimStart().startsWith('SELECT calls FROM ai_account_monthly_usage')) return rows([]);
    if (sql.includes('INSERT INTO ai_account_monthly_reservations') && sql.includes('RETURNING reservation_id')) return rows([{ reservation_id: 'reservation-80' }]);
    if (sql.includes('INSERT INTO ai_account_monthly_usage') && sql.includes('RETURNING calls')) return rows([{ calls: 1 }]);
    if (sql.includes('INSERT INTO ai_sessions') && sql.includes('RETURNING id')) return rows([{ id: 80 }]);
    if (sql.includes('UPDATE ai_account_monthly_reservations') && sql.includes('RETURNING session_id')) return rows([{ session_id: 80 }]);
    if (sql.includes('INSERT INTO ai_feedback') && sql.includes('RETURNING id')) return rows([{ id: 81 }]);
    return rows();
  };
  const request = room_id => invoke(aiHandler, {
    method: 'POST', url: '/api/ai/analyze', query: { endpoint: 'analyze' }, headers: { 'x-test-auth': 'user' },
    body: { room_id, transcript: 'Candidate and interviewer discussed a solution.', ai_consent: true },
  });

  assert.equal((await request('untrusted-room')).status, 403);
  assert.equal((await request('week_10_pair_21')).status, 403);

  const missingPartnerConsent = await request('week_10_pair_20');
  assert.equal(missingPartnerConsent.status, 403);
  assert.equal(missingPartnerConsent.body.pending_participant_count, 1);
  assert.equal(executed.some(entry => entry.sql.includes('INSERT INTO ai_sessions')), false);

  consentedIds = [2, 3];
  const approved = await request('week_10_pair_20');
  assert.equal(approved.status, 200);
  assert.equal(approved.body.session_id, 80);
});

test('AI provider network failures preserve Groq retries and OpenAI fallback', async () => {
  process.env.AI_ENABLED = 'true';
  process.env.NEXT_PUBLIC_SENTRY_DSN = 'https://public@example.test/1';
  process.env.GROQ_API_KEY = 'test-groq-key';
  process.env.OPENAI_API_KEY = 'test-openai-key';
  executeHandler = sql => {
    if (sql.trimStart().startsWith('SELECT pg.id AS pair_group_id')) return rows([{ pair_group_id: 22, week_id: 10, user_a_id: 2, user_b_id: 2, user_c_id: null, is_ai_pair: 1, week_label: '2026-W38' }]);
    if (sql.includes('SELECT user_id FROM ai_consents')) return rows([{ user_id: 2 }]);
    if (sql.includes('SELECT is_demo FROM auth_accounts')) return rows([{ is_demo: 0 }]);
    if (sql.includes('SELECT calls FROM ai_usage')) return rows([{ calls: 0 }]);
    if (sql.includes('SELECT calls,tokens_in FROM ai_usage')) return rows([{ calls: 0, tokens_in: 0 }]);
    if (sql.trimStart().startsWith('SELECT calls FROM ai_account_monthly_usage')) return rows([]);
    if (sql.includes('INSERT INTO ai_account_monthly_reservations') && sql.includes('RETURNING reservation_id')) return rows([{ reservation_id: 'reservation-82' }]);
    if (sql.includes('INSERT INTO ai_account_monthly_usage') && sql.includes('RETURNING calls')) return rows([{ calls: 1 }]);
    if (sql.includes('INSERT INTO ai_sessions') && sql.includes('RETURNING id')) return rows([{ id: 82 }]);
    if (sql.includes('UPDATE ai_account_monthly_reservations') && sql.includes('RETURNING session_id')) return rows([{ session_id: 82 }]);
    if (sql.includes('INSERT INTO ai_feedback') && sql.includes('RETURNING id')) return rows([{ id: 83 }]);
    return rows();
  };
  const providerCalls = [];
  globalThis.fetch = async url => {
    providerCalls.push(String(url));
    if (String(url).includes('api.groq.com')) throw new TypeError('simulated network failure');
    return new Response(JSON.stringify({
      choices: [{ message: { content: JSON.stringify({
        candidate: { strengths: [], improvements: [] }, interviewer: { strengths: [], improvements: [] },
        overall_score: 8, next_time_checklist: ['practice'],
      }) } }],
      usage: { prompt_tokens: 20, completion_tokens: 10 },
    }), { status: 200 });
  };

  const result = await invoke(aiHandler, {
    method: 'POST', url: '/api/ai/analyze', query: { endpoint: 'analyze' }, headers: { 'x-test-auth': 'user' },
    body: { room_id: 'week_10_pair_22', transcript: 'detailed analysis '.repeat(2_000), ai_consent: true },
  });
  assert.equal(result.status, 200);
  assert.equal(result.body.openaiFallback, true);
  assert.equal(result.body.estimated_cost.tokens_in, 20);
  assert.equal(result.body.estimated_cost.tokens_out, 10);
  assert.equal(result.body.estimated_cost.cents, 1);
  assert.deepEqual(providerCalls.map(url => url.includes('api.groq.com') ? 'groq' : 'openai'), ['groq', 'groq', 'openai']);

  globalThis.fetch = async () => { throw new TypeError('simulated provider outage'); };
  const unavailable = await invoke(aiHandler, {
    method: 'POST', url: '/api/ai/analyze', query: { endpoint: 'analyze' }, headers: { 'x-test-auth': 'user' },
    body: { room_id: 'week_10_pair_22', transcript: 'A short solo analysis.', ai_consent: true },
  });
  assert.equal(unavailable.status, 502);
  assert.equal(sentryMessageCalls.some(call => call[1].tags.event === 'ai_groq_fail'), true);

  delete process.env.GROQ_API_KEY;
  globalThis.fetch = async () => { throw Object.assign(new Error('simulated timeout'), { name: 'AbortError' }); };
  const openAiTimeout = await invoke(aiHandler, {
    method: 'POST', url: '/api/ai/analyze', query: { endpoint: 'analyze' }, headers: { 'x-test-auth': 'user' },
    body: { room_id: 'week_10_pair_22', transcript: 'A short solo analysis.', ai_consent: true },
  });
  assert.equal(openAiTimeout.status, 200);
  assert.equal(openAiTimeout.body.mocked, true);
  assert.match(openAiTimeout.body.reason_for_pick, /openai failed openai request timed out/);
});

test('AI rejects malformed provider feedback with the generic provider error', async () => {
  process.env.AI_ENABLED = 'true';
  process.env.GROQ_API_KEY = 'test-groq-key';
  const memoryDb = createClient({ url: 'file::memory:' });
  databaseDelegate = memoryDb;
  try {
    await memoryDb.batch([
      `CREATE TABLE auth_accounts (id INTEGER PRIMARY KEY, email TEXT NOT NULL, is_demo INTEGER DEFAULT 0)`,
      `CREATE TABLE pairing_weeks (id INTEGER PRIMARY KEY, week_label TEXT NOT NULL)`,
      `CREATE TABLE pairing_groups (
        id INTEGER PRIMARY KEY,
        week_id INTEGER NOT NULL,
        user_a_id INTEGER NOT NULL,
        user_b_id INTEGER NOT NULL,
        user_c_id INTEGER,
        is_ai_pair INTEGER DEFAULT 0
      )`,
      `CREATE TABLE pairing_participants (
        week_id INTEGER NOT NULL,
        user_id INTEGER NOT NULL,
        position INTEGER NOT NULL,
        source TEXT NOT NULL,
        PRIMARY KEY (week_id,user_id)
      )`,
      `INSERT INTO auth_accounts (id,email,is_demo) VALUES (2,'user@example.test',0)`,
      `INSERT INTO pairing_weeks (id,week_label) VALUES (10,'2026-W38')`,
      `INSERT INTO pairing_groups (id,week_id,user_a_id,user_b_id,user_c_id,is_ai_pair) VALUES (23,10,2,2,NULL,1)`,
      `INSERT INTO pairing_participants (week_id,user_id,position,source) VALUES (10,2,0,'auth')`,
    ], 'write');

    let providerContent=JSON.stringify({
      candidate: { strengths: {}, improvements: [] },
      interviewer: { strengths: [], improvements: [] },
      overall_score: 7,
      next_time_checklist: ['practice'],
    });
    globalThis.fetch = async () => new Response(JSON.stringify({
      choices: [{ message: { content: providerContent } }],
      usage: { prompt_tokens: 20, completion_tokens: 10 },
    }), { status: 200 });
    const request = () => invoke(aiHandler, {
      method: 'POST', url: '/api/ai/analyze', query: { endpoint: 'analyze' }, headers: { 'x-test-auth': 'user' },
      body: { room_id: 'week_10_pair_23', transcript: 'A short solo analysis.', ai_consent: true },
    });

    const malformedShape = await request();
    assert.equal(malformedShape.status, 502);
    assert.deepEqual(malformedShape.body, { ok: false, error: 'AI provider temporarily unavailable', session_id: 1 });

    providerContent='{not valid json';
    const malformedJson = await request();
    assert.equal(malformedJson.status, 502);
    assert.equal(malformedJson.body.error, 'AI provider temporarily unavailable');

    globalThis.fetch = async () => new Response('null', { status: 200 });
    const nullEnvelope = await request();
    assert.equal(nullEnvelope.status, 502);
    assert.deepEqual(nullEnvelope.body, { ok: false, error: 'AI provider temporarily unavailable', session_id: 3 });

    const feedbackCount = await memoryDb.execute(`SELECT COUNT(*) AS count FROM ai_feedback`);
    const sessionCount = await memoryDb.execute(`SELECT COUNT(*) AS count FROM ai_sessions`);
    const consentCount = await memoryDb.execute(`SELECT COUNT(*) AS count FROM ai_consents WHERE user_id=2 AND revoked_at IS NULL`);
    assert.equal(Number(feedbackCount.rows[0].count), 0);
    assert.equal(Number(sessionCount.rows[0].count), 3);
    assert.equal(Number(consentCount.rows[0].count), 1);
  } finally {
    databaseDelegate = null;
    memoryDb.close();
  }
});

test('AI provider selection, quota, and ownership branches remain fail-closed', async () => {
  process.env.AI_ENABLED = 'true';
  executeHandler = sql => {
    if (sql.trimStart().startsWith('SELECT pg.id AS pair_group_id')) return rows([{ pair_group_id: 21, week_id: 10, user_a_id: 2, user_b_id: 2, user_c_id: null, is_ai_pair: 1, week_label: '2026-W38' }]);
    if (sql.includes('SELECT user_id FROM ai_consents')) return rows([{ user_id: 2 }]);
    if (sql.includes('SELECT is_demo FROM auth_accounts')) return rows([{ is_demo: 0 }]);
    if (sql.trimStart().startsWith('SELECT calls FROM ai_account_monthly_usage')) return rows([]);
    if (sql.includes('INSERT INTO ai_account_monthly_reservations') && sql.includes('RETURNING reservation_id')) return rows([{ reservation_id: 'reservation-72' }]);
    if (sql.includes('INSERT INTO ai_account_monthly_usage') && sql.includes('RETURNING calls')) return rows([{ calls: 1 }]);
    if (sql.includes('SELECT calls FROM ai_usage')) return rows([{ calls: 0 }]);
    if (sql.includes('SELECT calls,tokens_in FROM ai_usage')) return rows([{ calls: 0, tokens_in: 0 }]);
    if (sql.includes('INSERT INTO ai_sessions') && sql.includes('RETURNING id')) return rows([{ id: 72 }]);
    if (sql.includes('UPDATE ai_account_monthly_reservations') && sql.includes('RETURNING session_id')) return rows([{ session_id: 72 }]);
    if (sql.includes('INSERT INTO ai_feedback') && sql.includes('RETURNING id')) return rows([{ id: 73 }]);
    if (sql.includes('FROM ai_feedback af JOIN ai_sessions ase') && sql.includes('af.session_id=')) return rows([{ id: 73, session_id: 72, feedback_json: '{}', created_by: 99 }]);
    return rows();
  };
  process.env.OPENAI_API_KEY = 'test-openai-key';
  globalThis.fetch = async url => {
    assert.match(String(url), /api\.openai\.com/);
    return new Response(JSON.stringify({
      choices: [{ message: { content: JSON.stringify({
        candidate: { strengths: [], improvements: [] }, interviewer: { strengths: [], improvements: [] },
        overall_score: 8, next_time_checklist: ['practice'],
      }) } }],
      usage: { prompt_tokens: 20, completion_tokens: 10 },
    }), { status: 200 });
  };
  const headers = { 'x-test-auth': 'user' };
  const analyzed = await invoke(aiHandler, {
    method: 'POST', url: '/api/ai/analyze', query: { endpoint: 'analyze' }, headers,
    body: { room_id: 'week_10_pair_21', transcript: 'A sufficiently detailed interview transcript.', ai_consent: true, interviewer_questions: 'Why this approach?' },
  });
  assert.equal(analyzed.status, 200);
  assert.equal(analyzed.body.openaiFallback, true);
  assert.equal(analyzed.body.feedback.overall_score, 8);

  const forbidden = await invoke(aiHandler, { url: '/api/ai/feedback?id=72', query: { endpoint: 'feedback', id: 72 }, headers });
  assert.equal(forbidden.status, 403);

  const wrongMethods = await Promise.all([
    invoke(aiHandler, { method: 'GET', url: '/api/ai/analyze', query: { endpoint: 'analyze' }, headers }),
    invoke(aiHandler, { method: 'POST', url: '/api/ai/feedback', query: { endpoint: 'feedback' }, headers }),
    invoke(aiHandler, { method: 'POST', url: '/api/ai/history', query: { endpoint: 'history' }, headers }),
  ]);
  assert.deepEqual(wrongMethods.map(result => result.status), [405, 405, 405]);
});

test('AI rejects missing content and enforces demo quota before provider calls', async () => {
  process.env.AI_ENABLED = 'true';
  const headers = { 'x-test-auth': 'demo' };
  const empty = await invoke(aiHandler, {
    method: 'POST', url: '/api/ai/analyze', query: { endpoint: 'analyze' }, headers,
    body: { ai_consent: true },
  });
  assert.equal(empty.status, 400);

  executeHandler = sql => {
    if (sql.trimStart().startsWith('SELECT pg.id AS pair_group_id')) return rows([{ pair_group_id: 22, week_id: 10, user_a_id: 3, user_b_id: 3, user_c_id: null, is_ai_pair: 1, week_label: '2026-W38' }]);
    if (sql.includes('SELECT user_id FROM ai_consents')) return rows([{ user_id: 3 }]);
    if (sql.includes('SELECT is_demo FROM auth_accounts')) return rows([{ is_demo: 1 }]);
    if (sql.includes('SELECT calls FROM ai_usage')) return rows([{ calls: 100 }]);
    return rows();
  };
  const limited = await invoke(aiHandler, {
    method: 'POST', url: '/api/ai/analyze', query: { endpoint: 'analyze' }, headers,
    body: { room_id: 'week_10_pair_22', transcript: 'A detailed transcript.', ai_consent: true },
  });
  assert.equal(limited.status, 429);
  assert.equal(limited.body.demo, true);
});

test('operations cover preferences, availability, admin promotion, demo lifecycle, and cron auth', async () => {
  process.env.CRON_SECRET = 'cron-secret';
  let insertedId = 100;
  executeHandler = sql => {
    if (sql.includes('SELECT id,email,is_admin FROM auth_accounts WHERE id=')) return rows([{ id: 1, email: 'admin@example.test', is_admin: 1 }]);
    if (sql.includes('SELECT user_id,email_enabled')) return rows([{ user_id: 2, email_enabled: 1, sms_enabled: 0 }]);
    if (sql.includes('SELECT id,email,display_name,is_available')) return rows([{ id: 2, email: 'user@example.test', display_name: 'User', is_available: 1 }]);
    if (sql.includes('SELECT id,email,is_admin FROM auth_accounts WHERE lower(email)')) return rows([{ id: 2, email: 'user@example.test', is_admin: 0 }]);
    if (sql.includes('SELECT id FROM auth_accounts WHERE email=')) return rows([{ id: insertedId++ }]);
    if (sql.includes('COUNT(*) as c FROM auth_accounts WHERE is_demo=1')) return rows([{ c: 6 }]);
    if (sql.includes('COUNT(*) AS c FROM auth_accounts WHERE is_demo=1')) return rows([{ c: 6 }]);
    if (sql.includes('COUNT(*) AS c FROM pairing_groups WHERE week_id IN')) return rows([{ c: 2 }]);
    if (sql.includes('COUNT(*) AS c FROM pairing_weeks WHERE is_demo=1')) return rows([{ c: 1 }]);
    if (sql.includes('SELECT id, display_name as name, email, color, is_available, is_demo')) return rows([
      { id: 1, name: 'Admin', email: 'admin@example.test', color: '#1', is_available: 1, is_demo: 0 },
      { id: 2, name: 'User', email: 'user@example.test', color: '#2', is_available: 1, is_demo: 1 },
    ]);
    if (sql.includes('SELECT id, display_name as name, color, email, is_available, is_demo')) return rows([
      { id: 1, name: 'Admin', email: 'admin@example.test', color: '#1', is_available: 1, is_demo: 0 },
      { id: 2, name: 'User', email: 'user@example.test', color: '#2', is_available: 1, is_demo: 1 },
    ]);
    if(sql.includes('SELECT aa.id,aa.display_name AS name')&&sql.includes('circle_memberships')) return rows([
      {id:1,name:'Admin',email:'admin@example.test',color:'#1',is_available:1},
      {id:2,name:'User',email:'user@example.test',color:'#2',is_available:1},
    ]);
    if (sql.includes('SELECT week_id,generation_token,generation FROM pairing_week_runs')) return rows([{
      week_id: lastPairingRun?.weekId,
      generation_token: lastPairingRun?.generationToken,
      generation: lastPairingRun?.generation,
    }]);
    if (sql.includes('INSERT INTO pairing_weeks') && sql.includes('RETURNING id')) return rows([{ id: 10 }]);
    if (sql.includes('DELETE FROM pairing_groups')) return rows([], { rowsAffected: 2 });
    if (sql.includes('COUNT(*) as c FROM pairing_weeks WHERE is_demo=1')) return rows([{ c: 1 }]);
    return rows();
  };
  const user = { 'x-test-auth': 'user' };
  const admin = { 'x-test-auth': 'admin' };

  const prefs = await invoke(opsHandler, { url: '/api/notifications/prefs', query: { endpoint: 'notifications-prefs' }, headers: user });
  assert.equal(prefs.body.prefs.user_id, 2);
  const saved = await invoke(opsHandler, {
    method: 'POST', url: '/api/notifications/prefs', query: { endpoint: 'notifications-prefs' }, headers: user,
    body: { email_enabled: false, sms_enabled: true, phone: '+440000000' },
  });
  assert.equal(saved.body.prefs.sms_enabled, true);

  const availabilityState = await invoke(opsHandler, {
    method: 'GET', url: '/api/settings/availability', query: { endpoint: 'availability' }, headers: user,
  });
  assert.equal(availabilityState.status,200);
  assert.equal(availabilityState.headers['cache-control'],'private, no-store');
  const availability = await invoke(opsHandler, {
    method: 'POST', url: '/api/settings/availability', query: { endpoint: 'availability' }, headers: user,
    body: {
      cycle_key:availabilityState.body.availability.cycleKey,
      expected_version:availabilityState.body.availability.version,
      is_available:false,
    },
  });
  assert.equal(availability.body.availability.isAvailable,false);

  const promoted = await invoke(opsHandler, {
    method: 'POST', url: '/api/admin/reshuffle', query: { endpoint: 'reshuffle' }, headers: admin,
    body: { action: 'promote', email: 'user@example.test' },
  });
  assert.equal(promoted.body.promoted, 'user@example.test');

  const seeded = await invoke(opsHandler, { method: 'POST', url: '/api/demo-seed', query: { endpoint: 'demo-seed' }, headers: admin });
  assert.equal(seeded.body.seeded_count, 6);
  const shuffled = await invoke(opsHandler, { method: 'POST', url: '/api/demo-shuffle', query: { endpoint: 'demo-shuffle' }, headers: admin });
  assert.equal(shuffled.status, 200, JSON.stringify(shuffled.body));
  assert.equal(shuffled.body.pairs.length, 1);
  const reset = await invoke(opsHandler, { method: 'POST', url: '/api/demo-reset', query: { endpoint: 'demo-reset' }, headers: admin });
  assert.equal(reset.body.deleted.groups, 2);

  const cronDenied = await invoke(opsHandler, { method: 'POST', url: '/api/cron/weekly', query: { endpoint: 'weekly' }, headers: { 'x-cron-secret': 'wrong' } });
  assert.equal(cronDenied.status, 401);
  assert.match(cronDenied.body.hint, /x-cron-secret.*Authorization: Bearer/);
  assert.doesNotMatch(cronDenied.body.hint, /\?secret=|x-vercel-cron/);

  executed.length=0;
  const outsideWindow=await withFixedNow('2026-09-18T12:00:00.000Z',()=>invoke(opsHandler,{
    method:'GET',url:'/api/cron/weekly',query:{endpoint:'weekly'},headers:{'x-cron-secret':'cron-secret'},
  }));
  assert.equal(outsideWindow.status,200);
  assert.equal(outsideWindow.body.reason,'outside_due_window');
  assert.equal(executed.length,0,'an authenticated off-window cron must not touch storage');

  const weekly = await withFixedNow('2026-09-20T08:15:00.000Z',()=>invoke(opsHandler, { method: 'POST', url: '/api/cron/weekly', query: { endpoint:'weekly' }, headers: { 'x-cron-secret': 'cron-secret' } }));
  assert.equal(weekly.status, 200);
  assert.equal(weekly.body.pairs.length, 1);
  assert.doesNotMatch(JSON.stringify(weekly.body),/@example\.test/);
  assert.equal(executed.some(call => !call.sql.trim()), false, 'migration arrays must not execute undefined DDL entries');
});

test('weekly email delivery caps stale outbox retries and exhausts the fifth failed attempt', async () => {
  process.env.CRON_SECRET = 'cron-secret';
  process.env.RESEND_API_KEY = 're_test';
  globalThis.fetch = async () => new Response(JSON.stringify({ message: 'provider unavailable' }), {
    status: 503,
    headers: { 'content-type': 'application/json' },
  });
  executeHandler = sql => {
    const publication=existingPairingPublication(sql,{participantId:2});
    if(publication) return publication;
    if (sql.startsWith("UPDATE pairing_email_outbox SET status='exhausted'")) return rows([], { rowsAffected: 0 });
    if (sql.includes('SELECT id,week_id,user_id,kind,recipient_email,status,attempt_count')) return rows([{
      id: 70,
      week_id: 10,
      user_id: 2,
      kind: 'paired',
      recipient_email: 'user@example.test',
      status: 'sending',
      attempt_count: 4,
    }]);
    if (sql.includes('SELECT week_label FROM pairing_weeks')) return rows([{ week_label: '2026-W38' }]);
    if (sql.includes("SET status='sending',attempt_count=attempt_count+1")) return rows([{ id: 70, attempt_count: 5 }]);
    if (sql.includes('SELECT is_demo FROM auth_accounts')) return rows([{ is_demo: 0 }]);
    if (sql.includes('SELECT email_enabled FROM user_notification_prefs')) return rows([{ email_enabled: 1 }]);
    if (sql.includes('SELECT id,user_a_id,user_b_id,is_ai_pair FROM pairing_groups')) return rows([{
      id: 20, user_a_id: 2, user_b_id: 2, is_ai_pair: 1,
    }]);
    if (sql.includes("SET status=CASE WHEN attempt_count>=? THEN 'exhausted'")) return rows([{ status: 'exhausted' }]);
    if (sql.includes('SELECT COUNT(*) AS c FROM pairing_email_outbox')) return rows([{ c: 0 }]);
    return rows();
  };

  const disabled = await withFixedNow('2026-09-20T08:15:00.000Z',()=>invoke(opsHandler, {
    method: 'POST', url: '/api/cron/weekly', query: { endpoint: 'weekly' },
    headers: { 'x-cron-secret': 'cron-secret' },
  }));
  assert.match(disabled.body.email_delivery.summary, /email disabled.*RESEND_API_KEY \+ RESEND_FROM/);
  process.env.RESEND_FROM = 'Randori <verified@example.test>';

  const result = await withFixedNow('2026-09-20T08:15:00.000Z',()=>invoke(opsHandler, {
    method: 'POST', url: '/api/cron/weekly', query: { endpoint: 'weekly' },
    headers: { 'x-cron-secret': 'cron-secret' },
  }));
  assert.equal(result.status, 200);
  assert.equal(result.body.skipped, true);
  assert.equal(result.body.email_delivery.failed, 1);
  assert.equal(result.body.email_delivery.exhausted, 1);
  assert.equal(result.body.email_delivery.pending, 0);
  assert.equal(executed.some(call=>call.sql.includes('pairing_cycles')),false,
    'an immutable existing publication must not materialize or consume an availability bridge');

  const candidateQuery = executed.find(call => call.sql.includes('SELECT id,week_id,user_id,kind,recipient_email,status,attempt_count'));
  assert.match(candidateQuery.sql, /attempt_count<\?/);
  assert.match(candidateQuery.sql, /status='sending'.*claimed_at<datetime/);
  assert.deepEqual(candidateQuery.args, [10, 5]);
  const claim = executed.find(call => call.sql.includes("SET status='sending',attempt_count=attempt_count+1"));
  assert.deepEqual(claim.args, [70, 5]);
  const transition = executed.find(call => call.sql.includes("SET status=CASE WHEN attempt_count>=? THEN 'exhausted'"));
  assert.match(transition.sql, /status='sending' AND attempt_count=\?/);
  assert.deepEqual(transition.args, [5, 'provider unavailable', 70, 5]);
});

test('stale email workers cannot overwrite a newer lease or inflate delivery counters', async () => {
  process.env.CRON_SECRET = 'cron-secret';
  process.env.RESEND_API_KEY = 're_test';
  process.env.RESEND_FROM = 'Randori <verified@example.test>';
  globalThis.fetch = async () => new Response(JSON.stringify({ id: 'mail_123' }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
  executeHandler = (sql,args) => {
    const publication=existingPairingPublication(sql,{participantId:4});
    if(publication) return publication;
    if (sql.startsWith("UPDATE pairing_email_outbox SET status='exhausted'")) return rows([], { rowsAffected: 0 });
    if (sql.includes('SELECT id,week_id,user_id,kind,recipient_email,status,attempt_count')) return rows([
      { id: 70, week_id: 10, user_id: 2, kind: 'paired', recipient_email: 'demo@example.test', status: 'failed', attempt_count: 1 },
      { id: 71, week_id: 10, user_id: 3, kind: 'paired', recipient_email: 'disabled@example.test', status: 'failed', attempt_count: 1 },
      { id: 72, week_id: 10, user_id: 4, kind: 'paired', recipient_email: 'active@example.test', status: 'failed', attempt_count: 1 },
    ]);
    if (sql.includes('SELECT week_label FROM pairing_weeks')) return rows([{ week_label: '2026-W38' }]);
    if (sql.includes("SET status='sending',attempt_count=attempt_count+1")) return rows([{ id: args[0], attempt_count: 2 }]);
    if (sql.includes('SELECT is_demo FROM auth_accounts')) return rows([{ is_demo: Number(args[0])===2 ? 1 : 0 }]);
    if (sql.includes('SELECT email_enabled FROM user_notification_prefs')) return rows([{ email_enabled: Number(args[0])===3 ? 0 : 1 }]);
    if (sql.includes("SET status='suppressed'")) return Number(args[0])===71 ? rows([{ id: 71 }]) : rows([]);
    if (sql.includes('SELECT id,user_a_id,user_b_id,is_ai_pair FROM pairing_groups')) return rows([{
      id: 20, user_a_id: 4, user_b_id: 4, is_ai_pair: 1,
    }]);
    if (sql.includes("SET status='sent'")) return rows([]);
    if (sql.includes('SELECT COUNT(*) AS c FROM pairing_email_outbox')) return rows([{ c: 0 }]);
    return rows();
  };

  const result = await withFixedNow('2026-09-20T08:15:00.000Z',()=>invoke(opsHandler, {
    method: 'POST', url: '/api/cron/weekly', query: { endpoint: 'weekly' },
    headers: { 'x-cron-secret': 'cron-secret' },
  }));
  assert.equal(result.status, 200);
  assert.equal(result.body.email_delivery.sent, 0, 'a stale successful sender must not count an uncommitted transition');
  assert.equal(result.body.email_delivery.suppressed, 1, 'only the worker that still owns its lease may count suppression');
  assert.equal(result.body.email_delivery.failed, 0);

  const terminalUpdates=executed.filter(call => call.sql.includes("SET status='sent'") || call.sql.includes("SET status='suppressed'"));
  assert.equal(terminalUpdates.length, 3);
  for(const update of terminalUpdates){
    assert.match(update.sql, /status='sending' AND attempt_count=\? RETURNING/);
    assert.equal(update.args.at(-1), 2);
  }
});

test('operation validation rejects unsupported methods and non-admin mutations', async () => {
  const user = { 'x-test-auth': 'user' };
  const admin = { 'x-test-auth': 'admin' };
  const simple = [
    [{ method: 'PATCH', url: '/api/notifications/prefs', query: { endpoint: 'notifications-prefs' }, headers: user }, 405],
    [{ method: 'PATCH', url: '/api/availability', query: { endpoint: 'availability' }, headers: user }, 405],
    [{ method: 'POST', url: '/api/availability', query: { endpoint: 'availability' }, headers: user, body: {} }, 400],
    [{ method: 'GET', url: '/api/pairing/run', query: { endpoint: 'pairing-run' }, headers: admin }, 405],
    [{ method: 'PUT', url: '/api/cron/weekly', query: { endpoint: 'weekly' } }, 405],
    [{ method: 'GET', url: '/api/demo-seed', query: { endpoint: 'demo-seed' }, headers: admin }, 405],
    [{ method: 'GET', url: '/api/demo-shuffle', query: { endpoint: 'demo-shuffle' }, headers: admin }, 405],
    [{ method: 'GET', url: '/api/demo-reset', query: { endpoint: 'demo-reset' }, headers: admin }, 405],
    [{ url: '/api/unknown', query: { endpoint: 'unknown' } }, 404],
  ];
  for (const [request, status] of simple) {
    const result = await invoke(opsHandler, request);
    assert.equal(result.status, status, request.url);
  }

  executeHandler = sql => {
    if (sql.includes('SELECT id,email,is_admin FROM auth_accounts WHERE id=')) return rows([{ id: 2, email: 'user@example.test', is_admin: 0 }]);
    return rows();
  };
  const forbidden = await invoke(opsHandler, {
    method: 'POST', url: '/api/admin/reshuffle', query: { endpoint: 'reshuffle' }, headers: user,
  });
  assert.equal(forbidden.status, 403);

  executeHandler = sql => {
    if (sql.includes('SELECT id,email,is_admin FROM auth_accounts WHERE id=')) return rows([{ id: 1, email: 'admin@example.test', is_admin: 1 }]);
    if (sql.includes('SELECT id,email,is_admin FROM auth_accounts WHERE lower(email)')) return rows([]);
    return rows();
  };
  for (const [body, status] of [
    [{ action: 'promote' }, 400],
    [{ action: 'promote', email: 'not-an-email' }, 400],
    [{ action: 'promote', email: 'missing@example.test' }, 404],
  ]) {
    const result = await invoke(opsHandler, {
      method: 'POST', url: '/api/admin/reshuffle', query: { endpoint: 'reshuffle' }, headers: admin, body,
    });
    assert.equal(result.status, status);
  }
});

test('owner publication is immutable and the legacy reshuffle URL cannot remix it', async () => {
  const participants = [
    { id: 1, name: 'Admin', email: 'admin@example.test', color: '#1', is_available: 1, is_demo: 0 },
    { id: 2, name: 'Ada', email: 'ada@example.test', color: '#2', is_available: 1, is_demo: 0 },
    { id: 3, name: 'Grace', email: 'grace@example.test', color: '#3', is_available: 1, is_demo: 0 },
    { id: 4, name: 'Linus', email: 'linus@example.test', color: '#4', is_available: 1, is_demo: 0 },
  ];
  executeHandler = sql => {
    if (sql.includes("cm.role='owner'")) return rows([{ id: 1, role: 'owner', circle_id:1 }]);
    if (sql.includes('SELECT aa.id,aa.display_name AS name') && sql.includes('circle_memberships')) return rows(participants);
    return rows();
  };
  const cycle=resolvePairingCycle();
  const cycleKey=availabilityCycleKey({kind:'circle',circleId:1},cycle);
  mockAvailabilityDecisions.set(`circle:1:${cycleKey}:2`,{
    user_id:2,is_available:0,version:1,decision_source:'user',
    created_at:new Date().toISOString(),updated_at:new Date().toISOString(),
  });
  const request = {
    method: 'POST', url: '/api/pairing/run', query: { endpoint: 'pairing-run' },
    headers: { 'x-test-auth': 'admin' }, body: {},
  };
  const first = await invoke(opsHandler, request);
  const second = await invoke(opsHandler, {
    ...request,url:'/api/admin/reshuffle',query:{endpoint:'reshuffle'},
  });
  assert.equal(first.status, 200);
  assert.equal(second.status, 200);
  assert.equal(first.body.created, true);
  assert.equal(second.body.created, false);
  assert.equal(first.body.generation, 1);
  assert.equal(first.body.total_accounts,4);
  assert.equal(first.body.available_count,3);
  assert.equal(first.body.unavailable_count,1);
  assert.equal(first.body.pairs.some(pair=>pair.a_id===2||pair.b_id===2),false);
  assert.ok(executed.some(call=>call.sql.includes('INSERT INTO pairing_email_outbox')
    &&Number(call.args[0])===2&&call.args[1]==='unavailable'),
  'the dated opt-out receives the unavailable notification instead of a paired outbox row');
  assert.equal(second.body.generation, 1);
  assert.deepEqual(second.body.pairs,first.body.pairs);
  assert.doesNotMatch(JSON.stringify(first.body),/@example\.test/);

  const claims = executed.filter(call => call.sql.includes('INSERT INTO pairing_week_runs'));
  assert.equal(claims.length,1);
  assert.equal(executed.some(call=>/^\s*(?:CREATE|ALTER|DROP)\b/i.test(call.sql)),false);

  const remix=await invoke(opsHandler,{...request,body:{remix:true}});
  assert.equal(remix.status,400);
  assert.match(remix.body.error,/cannot be remixed/);
  assert.equal(executed.filter(call=>call.sql.includes('INSERT INTO pairing_week_runs')).length,1);
});

test('current-cycle publication fails before its irreversible claim when scoped history cannot be read',async()=>{
  const participants=[
    {id:1,name:'Admin',email:'admin@example.test',color:'#1',is_available:1,is_demo:0},
    {id:2,name:'Ada',email:'ada@example.test',color:'#2',is_available:1,is_demo:0},
  ];
  executeHandler=sql=>{
    if(sql.includes("cm.role='owner'")) return rows([{id:1,role:'owner',circle_id:1}]);
    if(sql.includes('SELECT aa.id,aa.display_name AS name')&&sql.includes('circle_memberships')) return rows(participants);
    if(sql.includes('FROM pairing_groups pg')&&sql.includes('JOIN pairing_week_runs pwr')&&sql.includes("ppa.source='auth'")) throw new Error('history unavailable');
    return rows();
  };

  const result=await invoke(opsHandler,{
    method:'POST',url:'/api/pairing/run',query:{endpoint:'pairing-run'},
    headers:{'x-test-auth':'admin'},body:{},
  });
  assert.equal(result.status,503);
  assert.deepEqual(result.body,{error:'pairing unavailable'});
  const historyQuery=executed.find(call=>call.sql.includes('FROM pairing_groups pg')&&call.sql.includes("ppa.source='auth'"));
  assert.ok(historyQuery);
  assert.match(historyQuery.sql,/ppa\.source='auth'/);
  assert.match(historyQuery.sql,/ppb\.source='auth'/);
  assert.equal(executed.some(call=>call.sql.includes('INSERT INTO pairing_week_runs')),false);
});

test('manual publication revalidates owner authority inside the write transaction',async()=>{
  let ownerChecks=0;
  executeHandler=sql=>{
    if(sql.includes("cm.role='owner'")){
      ownerChecks+=1;
      return rows(ownerChecks===1?[{id:1,role:'owner',circle_id:1}]:[]);
    }
    return rows();
  };

  const result=await invoke(opsHandler,{
    method:'POST',url:'/api/pairing/run',query:{endpoint:'pairing-run'},
    headers:{'x-test-auth':'admin'},body:{},
  });
  assert.equal(result.status,403);
  assert.deepEqual(result.body,{error:'primary circle owner required'});
  assert.equal(ownerChecks,2);
  assert.equal(executed.some(call=>call.sql.includes('display_name as name')),false);
  assert.equal(executed.some(call=>call.sql.includes('INSERT INTO pairing_week_runs')),false);
});

test('publication retries only vetted pre-commit lock conflicts and never an ambiguous commit',async()=>{
  const participants=[
    {id:1,name:'Admin',email:'admin@example.test',color:'#1',is_available:1,is_demo:0},
    {id:2,name:'Ada',email:'ada@example.test',color:'#2',is_available:1,is_demo:0},
  ];
  executeHandler=sql=>{
    if(sql.includes("cm.role='owner'")) return rows([{id:1,role:'owner',circle_id:1}]);
    if(sql.includes('SELECT aa.id,aa.display_name AS name')&&sql.includes('circle_memberships')) return rows(participants);
    return rows();
  };
  const delegate=createMockDb();
  let transactionAttempts=0;
  db={
    execute:delegate.execute.bind(delegate),
    batch:delegate.batch.bind(delegate),
    async transaction(){
      transactionAttempts+=1;
      const transaction=await delegate.transaction();
      if(transactionAttempts>=3) return transaction;
      return {
        ...transaction,
        async execute(statement){
          const sql=sqlText(statement);
          if(sql.includes('SELECT id,public_id,name FROM circles')){
            throw Object.assign(new Error('database is busy'),{code:'SQLITE_BUSY'});
          }
          return transaction.execute(statement);
        },
      };
    },
  };
  const request={
    method:'POST',url:'/api/pairing/run',query:{endpoint:'pairing-run'},headers:{'x-test-auth':'admin'},body:{},
  };
  const retried=await invoke(opsHandler,request);
  assert.equal(retried.status,200);
  assert.equal(retried.body.created,true);
  assert.equal(transactionAttempts,3);
  assert.equal(executed.filter(call=>call.sql.includes("strftime('%Y-%m-%dT%H:%M:%fZ','now') AS now_utc")).length,3,
    'database time and cycle context are re-read inside every transaction attempt');

  lastPairingRun=null;
  persistedPairGroups=[];
  persistedPairingParticipants=[];
  const committedDelegate=createMockDb();
  transactionAttempts=0;
  db={
    execute:committedDelegate.execute.bind(committedDelegate),
    batch:committedDelegate.batch.bind(committedDelegate),
    async transaction(){
      transactionAttempts+=1;
      const transaction=await committedDelegate.transaction();
      return {
        ...transaction,
        async commit(){
          await transaction.commit();
          throw Object.assign(new Error('database is busy'),{code:'SQLITE_BUSY'});
        },
      };
    },
  };
  const ambiguous=await invoke(opsHandler,request);
  assert.equal(ambiguous.status,503);
  assert.deepEqual(ambiguous.body,{error:'pairing unavailable'});
  assert.equal(transactionAttempts,1);
});

test('concurrent handler publications across two file-backed clients converge on one result',async()=>{
  const directory=mkdtempSync(join(tmpdir(),'randori-handler-pairing-'));
  const databaseUrl=pathToFileURL(join(directory,'pairing.sqlite')).href;
  const setup=createClient({url:databaseUrl});
  const clients=[];
  try{
    await setup.batch([
      `CREATE TABLE auth_accounts (id INTEGER PRIMARY KEY,email TEXT NOT NULL,display_name TEXT NOT NULL,color TEXT NOT NULL,is_available INTEGER,is_admin INTEGER,is_demo INTEGER)`,
      `CREATE TABLE circles (id INTEGER PRIMARY KEY,public_id TEXT,slug TEXT,name TEXT,is_primary INTEGER,archived_at TEXT)`,
      `CREATE TABLE circle_memberships (circle_id INTEGER,user_id INTEGER,role TEXT,status TEXT,PRIMARY KEY(circle_id,user_id))`,
      `CREATE TABLE pairing_weeks (id INTEGER PRIMARY KEY AUTOINCREMENT,week_label TEXT NOT NULL UNIQUE,week_start TEXT NOT NULL,focus TEXT NOT NULL DEFAULT 'both',created_at TEXT DEFAULT (datetime('now')),is_demo INTEGER DEFAULT 0)`,
      `CREATE TABLE pairing_groups (id INTEGER PRIMARY KEY AUTOINCREMENT,week_id INTEGER NOT NULL,user_a_id INTEGER NOT NULL,user_b_id INTEGER NOT NULL,user_c_id INTEGER,is_ai_pair INTEGER DEFAULT 0,topic TEXT,topic_kind TEXT,created_at TEXT DEFAULT (datetime('now')))`,
      `CREATE TABLE pairing_participants (week_id INTEGER NOT NULL,user_id INTEGER NOT NULL,position INTEGER NOT NULL,source TEXT NOT NULL,created_at TEXT DEFAULT (datetime('now')),PRIMARY KEY(week_id,user_id))`,
      `CREATE TABLE pairing_week_runs (week_label TEXT PRIMARY KEY,week_id INTEGER,generation_token TEXT NOT NULL,generation INTEGER NOT NULL,algorithm_version TEXT NOT NULL,algorithm_seed TEXT NOT NULL,participant_count INTEGER NOT NULL,participants_json TEXT NOT NULL,created_at TEXT DEFAULT (datetime('now')),updated_at TEXT DEFAULT (datetime('now')))`,
      `CREATE TABLE pairing_email_outbox (id INTEGER PRIMARY KEY AUTOINCREMENT,week_id INTEGER NOT NULL,user_id INTEGER NOT NULL,kind TEXT NOT NULL,recipient_email TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'pending',attempt_count INTEGER NOT NULL DEFAULT 0,claimed_at TEXT,sent_at TEXT,provider_message_id TEXT,last_error TEXT,created_at TEXT DEFAULT (datetime('now')),updated_at TEXT DEFAULT (datetime('now')),UNIQUE(week_id,user_id,kind))`,
      `CREATE TABLE pairing_cycles (scope_key TEXT NOT NULL,circle_id INTEGER,cycle_key TEXT NOT NULL,cycle_id TEXT NOT NULL,starts_at TEXT NOT NULL,ends_at TEXT NOT NULL,cutoff_at TEXT NOT NULL,time_zone TEXT NOT NULL,default_source TEXT NOT NULL,created_at TEXT NOT NULL DEFAULT (datetime('now')),PRIMARY KEY(scope_key,cycle_key))`,
      `CREATE TABLE pairing_cycle_availability (scope_key TEXT NOT NULL,cycle_key TEXT NOT NULL,user_id INTEGER NOT NULL,is_available INTEGER NOT NULL,version INTEGER NOT NULL,decision_source TEXT NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,PRIMARY KEY(scope_key,cycle_key,user_id))`,
      `CREATE INDEX idx_pairing_cycle_availability_candidates ON pairing_cycle_availability(scope_key,cycle_key,is_available,user_id)`,
      `INSERT INTO auth_accounts (id,email,display_name,color,is_available,is_admin,is_demo) VALUES (1,'admin@example.test','Admin','#111',1,1,0),(2,'ada@example.test','Ada','#222',1,0,0)`,
      `INSERT INTO circles (id,public_id,slug,name,is_primary) VALUES (1,'circle_test','randori-circle','Test Circle',1)`,
      `INSERT INTO circle_memberships (circle_id,user_id,role,status) VALUES (1,1,'owner','active'),(1,2,'member','active')`,
    ],'write');
    await setup.close();
    clients.push(createClient({url:databaseUrl}),createClient({url:databaseUrl}));
    let transactionIndex=0;
    db={
      execute:statement=>clients[0].execute(statement),
      batch:(statements,mode)=>clients[0].batch(statements,mode),
      transaction:mode=>clients[transactionIndex++%clients.length].transaction(mode),
    };
    const request={
      method:'POST',url:'/api/pairing/run',query:{endpoint:'pairing-run'},headers:{'x-test-auth':'admin'},body:{},
    };
    const results=await withFixedNow('2026-09-20T07:15:00.000Z',()=>Promise.all([
      invoke(opsHandler,request),invoke(opsHandler,request),
    ]));
    assert.deepEqual(results.map(result=>result.status),[200,200]);
    assert.equal(results.filter(result=>result.body.created===true).length,1);
    assert.equal(results.filter(result=>result.body.created===false).length,1);
    assert.equal(results[0].body.week_id,results[1].body.week_id);
    assert.deepEqual(results[0].body.pairs,results[1].body.pairs);
    assert.ok(transactionIndex>=2);
  }finally{
    try{ await setup.close(); }catch{}
    for(const client of clients){ try{ client.close(); }catch{} }
    rmSync(directory,{recursive:true,force:true});
  }
});

test('video signaling validates membership and supports post, filtered poll, and purge', async () => {
  executeHandler = sql => {
    if (sql.includes('INSERT INTO video_signals')) return rows([{ id: 80 }]);
    if (sql.includes('LEFT JOIN video_signals signal')) return rows([
      { id: 80, room_id: 'week_10_pair_20', from_id: 'other', to_id: 'peer', type: 'offer', payload: '{}', created_at: 'now', signal_present:1 },
      { id: 81, room_id: 'week_10_pair_20', from_id: 'third', to_id: 'someone-else', type: 'ice', payload: '{}', created_at: 'now', signal_present:1 },
    ]);
    if (sql.includes('DELETE FROM video_signals')) return rows();
    if (sql.includes("JOIN pairing_participants AS viewer")) return rows([{
      pair_group_id:20,
      week_id:10,
      user_a_id:2,
      user_b_id:4,
      user_c_id:null,
      is_ai_pair:0,
    }]);
    return rows();
  };
  const headers = { 'x-test-auth': 'user' };
  const posted = await invoke(videoHandler, {
    method: 'POST', url: '/api/video/signal', query: { endpoint: 'signal' }, headers,
    body: { room_id: 'week_10_pair_20', from_id: 'peer', type: 'offer', payload: { sdp: 'value' } },
  });
  assert.equal(posted.body.id, 80);

  const polled = await invoke(videoHandler, {
    url: '/api/video/signal?room_id=week_10_pair_20&peer_id=peer',
    query: { endpoint: 'signal', room_id: 'week_10_pair_20', peer_id: 'peer' }, headers,
  });
  assert.equal(polled.body.count, 1);

  const purged = await invoke(videoHandler, {
    method: 'DELETE', url: '/api/video/signal', query: { endpoint: 'signal', room_id: 'week_10_pair_20' }, headers,
  });
  assert.equal(purged.body.purged, true);

  const forbidden = await invoke(videoHandler, {
    url: '/api/video/signal', query: { endpoint: 'signal', room_id: 'ad-hoc-room' }, headers,
  });
  assert.equal(forbidden.status, 403);

  const invalidType = await invoke(videoHandler, {
    method: 'POST', url: '/api/video/signal', query: { endpoint: 'signal' }, headers,
    body: { room_id: 'week_10_pair_20', from_id: 'peer', type: 'invalid' },
  });
  assert.equal(invalidType.status, 400);

  const tooLarge = await invoke(videoHandler, {
    method: 'POST', url: '/api/video/signal', query: { endpoint: 'signal' }, headers,
    body: { room_id: 'week_10_pair_20', from_id: 'peer', type: 'offer', payload: 'x'.repeat(20_001) },
  });
  assert.equal(tooLarge.status, 413);

  const missingPayload = await invoke(videoHandler, {
    method: 'POST', url: '/api/video/signal', query: { endpoint: 'signal' }, headers,
    body: { room_id: 'week_10_pair_20', from_id: 'peer', type: 'offer' },
  });
  assert.equal(missingPayload.status, 400);
  assert.match(missingPayload.body.error, /payload required/i);

  const cyclicPayload = {};
  cyclicPayload.self = cyclicPayload;
  const invalidPayload = await invoke(videoHandler, {
    method: 'POST', url: '/api/video/signal', query: { endpoint: 'signal' }, headers,
    body: { room_id: 'week_10_pair_20', from_id: 'peer', type: 'offer', payload: cyclicPayload },
  });
  assert.equal(invalidPayload.status, 400);
  assert.match(invalidPayload.body.error, /JSON serializable/i);

  const unsupported = await invoke(videoHandler, { method: 'PATCH', url: '/api/video/signal', query: { endpoint: 'signal' }, headers });
  assert.equal(unsupported.status, 405);

  const missingPostFields = await invoke(videoHandler, {
    method: 'POST', url: '/api/video/signal', query: { endpoint: 'signal' }, headers, body: {},
  });
  assert.equal(missingPostFields.status, 400);
  const missingRoom = await invoke(videoHandler, { url: '/api/video/signal', query: { endpoint: 'signal' }, headers });
  assert.equal(missingRoom.status, 400);
  const unknown = await invoke(videoHandler, { url: '/api/video/config', query: { endpoint: 'config' }, headers });
  assert.equal(unknown.status, 400);
});
