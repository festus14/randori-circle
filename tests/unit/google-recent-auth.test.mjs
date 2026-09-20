import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {afterEach,test} from 'node:test';

import {createClient} from '@libsql/client';

import authHandler from '../../api/auth.js';
import {issueSession,verifyRequestAuth} from '../../api/_db.js';
import {readRecentAuth} from '../../api/_recent-auth.js';
import {EXECUTABLE_MIGRATIONS} from '../../db/executable-migrations.js';
import {applyMigrations,inspectMigrationState,prepareMigrationConnection} from '../../db/migration-runner.js';
import {decodeGoogleOAuthTransactionCookie,googleProviderFetch,
  googleOAuthTransactionCookieName} from '../support/google-oidc.mjs';

const originalFetch=globalThis.fetch;
const resources=[];

afterEach(()=>{
  globalThis.fetch=originalFetch;
  for(const key of ['APP_URL','CIRCLE_MEMBERSHIP_ENABLED','GOOGLE_CLIENT_ID','GOOGLE_CLIENT_SECRET',
    'IDENTITY_EMAIL_HASH_KEY','IDENTITY_EMAIL_HASH_KEY_VERSION','IDENTITY_MANAGEMENT_ENABLED',
    'JWT_SECRET','NODE_ENV','SIGNUP_ALLOWLIST','TURSO_AUTH_TOKEN','TURSO_DATABASE_URL']) delete process.env[key];
  while(resources.length){ try{ resources.pop()(); }catch{} }
});

function response(){
  return {
    statusCode:200,headers:{},body:null,
    status(code){ this.statusCode=code; return this; },
    setHeader(name,value){ this.headers[String(name).toLowerCase()]=value; },
    getHeader(name){ return this.headers[String(name).toLowerCase()]; },
    json(value){ this.body=value; return this; },
    writeHead(code,headers={}){ this.statusCode=code; for(const [name,value] of Object.entries(headers)) this.setHeader(name,value); },
    end(){ return this; },
  };
}

async function invoke({endpoint,url,query,method='GET',body,cookie='',origin='https://randori.example.test'}){
  const res=response();
  await authHandler({method,url,query:{endpoint,...query},body,
    headers:{host:'randori.example.test','x-forwarded-proto':'https',cookie,origin},
    socket:{remoteAddress:'203.0.113.50'}},res);
  return res;
}

function cookiesFrom(headers){
  const values=Array.isArray(headers['set-cookie'])?headers['set-cookie']:[headers['set-cookie']];
  return values.filter(Boolean).map(value=>String(value).split(';')[0]);
}

async function fixture({throughVersion=9}={}){
  const directory=mkdtempSync(join(tmpdir(),'randori-google-recent-'));
  const url=`file:${join(directory,'database.sqlite')}`;
  process.env.NODE_ENV='production';
  process.env.APP_URL='https://randori.example.test';
  process.env.GOOGLE_CLIENT_ID='client';
  process.env.GOOGLE_CLIENT_SECRET='secret';
  process.env.JWT_SECRET='google-recent-auth-secret-at-least-32-bytes';
  process.env.CIRCLE_MEMBERSHIP_ENABLED='false';
  process.env.TURSO_DATABASE_URL=url;
  const db=createClient({url});
  await prepareMigrationConnection(db);
  const migrations=EXECUTABLE_MIGRATIONS.slice(0,throughVersion);
  const state=await inspectMigrationState(db,{migrations});
  await applyMigrations(db,{expectedStateFingerprint:state.stateFingerprint,
    migrations,
    retry:{maxAttempts:1,baseDelayMs:0,maxDelayMs:0}});
  await db.batch([
    `INSERT INTO auth_accounts (id,email,password_hash,display_name,color,google_sub)
      VALUES (1,'google@example.test','!oauth:opaque','Google Member','#123456','stable-subject')`,
    `INSERT INTO auth_provider_identities (issuer,subject,user_id)
      VALUES ('https://accounts.google.com','stable-subject',1)`,
  ],'write');
  resources.push(()=>{ db.close(); rmSync(directory,{recursive:true,force:true}); });
  return {db};
}

test('Google reauthentication forces a fresh challenge and binds proof to the initiating account',async()=>{
  const {db}=await fixture({throughVersion:8});
  // Lifecycle step-up remains available even if separately gated identity
  // management is requested but cannot pass its v9 hash-key configuration.
  process.env.IDENTITY_MANAGEMENT_ENABLED='true';
  const original=await issueSession(db,{id:1,email:'google@example.test',name:'Google Member'});
  const originalPayload=await verifyRequestAuth({headers:{authorization:`Bearer ${original}`}},db);
  const methods=await invoke({endpoint:'recent-auth',url:'/api/auth/recent-auth',
    query:{},cookie:`randori_session=${encodeURIComponent(original)}`});
  assert.deepEqual(methods.body.methods,{password:false,google:true});
  const start=await invoke({endpoint:'google-reauth-start',url:'/api/auth/google/reauth/start',
    method:'POST',body:{},query:{},cookie:`randori_session=${encodeURIComponent(original)}`});
  assert.equal(start.statusCode,200);
  const authorization=new URL(start.body.authorizationUrl);
  assert.equal(authorization.searchParams.get('max_age'),'0');
  assert.equal(authorization.searchParams.get('prompt'),'select_account');
  const state=authorization.searchParams.get('state');
  const startCookies=cookiesFrom(start.headers);
  const transactionCookie=startCookies
    .find(cookie=>cookie.startsWith(`${googleOAuthTransactionCookieName(state)}=`));
  const transaction=decodeGoogleOAuthTransactionCookie(transactionCookie,state);
  assert.equal(transaction.purpose,`reauth:1:${originalPayload.sessionHash}`);
  const nonce=transaction.nonce;

  globalThis.fetch=googleProviderFetch({claims:{
    email:'google@example.test',name:'Google Member',sub:'stable-subject',nonce,
    auth_time:Math.floor(Date.now()/1000),
  }});
  const callback=await invoke({endpoint:'google-callback',url:'/api/auth/google/callback',
    query:{code:'fresh-code',state},cookie:[`randori_session=${encodeURIComponent(original)}`,...startCookies].join('; ')});
  assert.equal(callback.statusCode,302);
  assert.equal(callback.headers.location,'https://randori.example.test/?google_reauth=success');
  const replacementCookie=cookiesFrom(callback.headers).find(cookie=>cookie.startsWith('randori_session='));
  assert.ok(replacementCookie);
  const replacement=decodeURIComponent(replacementCookie.slice('randori_session='.length));
  const payload=await verifyRequestAuth({headers:{authorization:`Bearer ${replacement}`}},db);
  assert.equal(payload.id,1);
  assert.equal((await readRecentAuth(db,payload)).method,'google');
});

test('Google reauthentication rejects a same-account session swap before provider exchange',async()=>{
  const {db}=await fixture();
  const original=await issueSession(db,{id:1,email:'google@example.test',name:'Google Member'});
  const swapped=await issueSession(db,{id:1,email:'google@example.test',name:'Google Member'});
  const start=await invoke({endpoint:'google-reauth-start',url:'/api/auth/google/reauth/start',
    method:'POST',body:{},query:{},cookie:`randori_session=${encodeURIComponent(original)}`});
  const authorization=new URL(start.body.authorizationUrl);
  const startCookies=cookiesFrom(start.headers);
  let providerCalls=0;
  globalThis.fetch=async()=>{ providerCalls+=1; throw new Error('provider must not be called'); };
  const callback=await invoke({endpoint:'google-callback',url:'/api/auth/google/callback',
    query:{code:'unused-code',state:authorization.searchParams.get('state')},
    cookie:[`randori_session=${encodeURIComponent(swapped)}`,...startCookies].join('; ')});
  assert.equal(callback.statusCode,302);
  assert.equal(callback.headers.location,'https://randori.example.test/?google_error=reauth_required');
  assert.equal(providerCalls,0);
});

test('Google reauthentication start has a bounded per-account retry budget',async()=>{
  const {db}=await fixture();
  const original=await issueSession(db,{id:1,email:'google@example.test',name:'Google Member'});
  const statuses=[];
  for(let attempt=0;attempt<11;attempt+=1){
    statuses.push((await invoke({endpoint:'google-reauth-start',url:'/api/auth/google/reauth/start',
      method:'POST',body:{},query:{},cookie:`randori_session=${encodeURIComponent(original)}`})).statusCode);
  }
  assert.deepEqual(statuses.slice(0,10),Array(10).fill(200));
  assert.equal(statuses[10],429);
});

test('Google reauthentication start is same-origin POST-only and fails in place when unavailable',async()=>{
  const {db}=await fixture();
  const original=await issueSession(db,{id:1,email:'google@example.test',name:'Google Member'});
  let response=await invoke({endpoint:'google-reauth-start',url:'/api/auth/google/reauth/start',
    query:{},cookie:`randori_session=${encodeURIComponent(original)}`});
  assert.equal(response.statusCode,405);
  assert.equal(response.body.error,'POST only');

  response=await invoke({endpoint:'google-reauth-start',url:'/api/auth/google/reauth/start',
    method:'POST',body:{unexpected:true},query:{},cookie:`randori_session=${encodeURIComponent(original)}`});
  assert.equal(response.statusCode,400);

  process.env.GOOGLE_CLIENT_SECRET='';
  response=await invoke({endpoint:'google-reauth-start',url:'/api/auth/google/reauth/start',
    method:'POST',body:{},query:{},cookie:`randori_session=${encodeURIComponent(original)}`});
  assert.equal(response.statusCode,503);
  assert.equal(response.headers.location,undefined);
  assert.equal(response.body.error,'Google sign-in is unavailable');
});
