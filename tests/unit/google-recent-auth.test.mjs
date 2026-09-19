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
import {googleProviderFetch} from '../support/google-oidc.mjs';

const originalFetch=globalThis.fetch;
const resources=[];

afterEach(()=>{
  globalThis.fetch=originalFetch;
  for(const key of ['APP_URL','CIRCLE_MEMBERSHIP_ENABLED','GOOGLE_CLIENT_ID','GOOGLE_CLIENT_SECRET',
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

async function invoke({endpoint,url,query,cookie=''}){
  const res=response();
  await authHandler({method:'GET',url,query:{endpoint,...query},
    headers:{host:'randori.example.test','x-forwarded-proto':'https',cookie},
    socket:{remoteAddress:'203.0.113.50'}},res);
  return res;
}

function cookiesFrom(headers){
  const values=Array.isArray(headers['set-cookie'])?headers['set-cookie']:[headers['set-cookie']];
  return values.filter(Boolean).map(value=>String(value).split(';')[0]);
}

async function fixture(){
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
  const state=await inspectMigrationState(db);
  await applyMigrations(db,{expectedStateFingerprint:state.stateFingerprint,
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
  const {db}=await fixture();
  const original=await issueSession(db,{id:1,email:'google@example.test',name:'Google Member'});
  const start=await invoke({endpoint:'google-reauth-start',url:'/api/auth/google/reauth/start',
    query:{return_to:'/'},cookie:`randori_session=${encodeURIComponent(original)}`});
  assert.equal(start.statusCode,302);
  const authorization=new URL(start.headers.location);
  assert.equal(authorization.searchParams.get('max_age'),'0');
  assert.equal(authorization.searchParams.get('prompt'),'select_account');
  const state=authorization.searchParams.get('state');
  const startCookies=cookiesFrom(start.headers);
  assert.ok(startCookies.some(cookie=>cookie.startsWith('randori_oauth_purpose=reauth%3A1')));
  const nonce=decodeURIComponent(String(startCookies.find(cookie=>cookie.startsWith('randori_oauth_nonce=')))
    .slice('randori_oauth_nonce='.length));

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
