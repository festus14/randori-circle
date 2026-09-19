import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {afterEach,test} from 'node:test';

import {createClient} from '@libsql/client';
import bcrypt from 'bcryptjs';

import authHandler from '../../api/auth.js';
import {issueSession,verifyRequestAuth} from '../../api/_db.js';
import {
  GOOGLE_ISSUER,
  identityEmailHashConfiguration,
  observeGoogleProviderEmail,
} from '../../api/_identity-linking.js';
import {EXECUTABLE_MIGRATIONS} from '../../db/executable-migrations.js';
import {applyMigrations,inspectMigrationState,prepareMigrationConnection} from '../../db/migration-runner.js';
import {googleProviderFetch} from '../support/google-oidc.mjs';
import {adoptCredentialKeyControl} from '../support/credential-key-control.mjs';

const originalFetch=globalThis.fetch;
const resources=[];

  afterEach(()=>{
  globalThis.fetch=originalFetch;
  for(const key of ['APP_URL','CIRCLE_MEMBERSHIP_ENABLED','GOOGLE_CLIENT_ID','GOOGLE_CLIENT_SECRET',
    'IDENTITY_EMAIL_HASH_KEY','IDENTITY_EMAIL_HASH_KEY_VERSION','IDENTITY_MANAGEMENT_ENABLED','JWT_SECRET',
    'NODE_ENV','SIGNUP_ALLOWLIST','TURSO_AUTH_TOKEN','TURSO_DATABASE_URL']) delete process.env[key];
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

async function invoke({endpoint,method='GET',body,query={},cookie='',origin='https://randori.example.test',ip='203.0.113.70'}){
  const res=response();
  const headers={host:'randori.example.test','x-forwarded-proto':'https',cookie,'x-forwarded-for':ip};
  if(origin!==null) headers.origin=origin;
  await authHandler({method,url:`/api/auth/${endpoint}`,query:{endpoint,...query},body,headers,
    socket:{remoteAddress:ip}},res);
  return res;
}

function cookiesFrom(headers){
  const values=Array.isArray(headers['set-cookie'])?headers['set-cookie']:[headers['set-cookie']];
  return values.filter(Boolean).map(value=>String(value).split(';')[0]);
}

function cookieFor(token){ return `randori_session=${encodeURIComponent(token)}`; }

async function fixture({throughVersion=15,identityManagement=true}={}){
  const directory=mkdtempSync(join(tmpdir(),'randori-identity-linking-api-'));
  const url=pathToFileURL(join(directory,'database.sqlite')).href;
  process.env.NODE_ENV='production';
  process.env.APP_URL='https://randori.example.test';
  process.env.CIRCLE_MEMBERSHIP_ENABLED='false';
  process.env.GOOGLE_CLIENT_ID='client';
  process.env.GOOGLE_CLIENT_SECRET='secret';
  if(identityManagement) process.env.IDENTITY_MANAGEMENT_ENABLED='true';
  process.env.IDENTITY_EMAIL_HASH_KEY=Buffer.alloc(32,9).toString('base64url');
  process.env.IDENTITY_EMAIL_HASH_KEY_VERSION='1';
  process.env.JWT_SECRET='identity-linking-api-secret-at-least-32-bytes';
  process.env.TURSO_DATABASE_URL=url;
  const db=createClient({url});
  await prepareMigrationConnection(db);
  const migrations=EXECUTABLE_MIGRATIONS.slice(0,throughVersion);
  const state=await inspectMigrationState(db,{migrations});
  await applyMigrations(db,{expectedStateFingerprint:state.stateFingerprint,
    migrations,
    retry:{maxAttempts:1,baseDelayMs:0,maxDelayMs:0}});
  if(throughVersion>=15) await adoptCredentialKeyControl(db,identityEmailHashConfiguration());
  resources.push(()=>{ db.close(); rmSync(directory,{recursive:true,force:true}); });
  return db;
}

async function addPasswordAccount(db,{id=1,email='member@example.test'}={}){
  const passwordHash=await bcrypt.hash('correct horse battery',4);
  await db.execute({sql:`INSERT INTO auth_accounts
    (id,email,password_hash,display_name,color,is_admin) VALUES (?,?,?,?,?,0)`,
  args:[id,email,passwordHash,'Member','#123456']});
}

function oauthValues(start){
  const authorization=new URL(start.body?.authorizationUrl||start.headers.location);
  const cookies=cookiesFrom(start.headers);
  const nonce=decodeURIComponent(String(cookies.find(cookie=>cookie.startsWith('randori_oauth_nonce=')))
    .slice('randori_oauth_nonce='.length));
  return {authorization,cookies,nonce,state:authorization.searchParams.get('state')};
}

test('production identity management stays fail-closed until explicitly enabled',async()=>{
  process.env.NODE_ENV='production';
  process.env.APP_URL='https://randori.example.test';
  process.env.GOOGLE_CLIENT_ID='client';
  process.env.GOOGLE_CLIENT_SECRET='secret';
  let providerCalls=0;
  globalThis.fetch=async()=>{ providerCalls+=1; throw new Error('provider must not be called'); };
  const capabilities=await invoke({endpoint:'capabilities'});
  assert.equal(capabilities.body.capabilities.identityManagement,false);
  const state=await invoke({endpoint:'identities'});
  assert.equal(state.statusCode,503);
  const start=await invoke({endpoint:'google-link-start',method:'POST'});
  assert.equal(start.statusCode,503);
  process.env.IDENTITY_MANAGEMENT_ENABLED='true';
  const misconfigured=await invoke({endpoint:'capabilities'});
  assert.equal(misconfigured.body.capabilities.identityManagement,false);
  assert.equal(misconfigured.body.capabilities.googleOAuth,false);
  const blockedLogin=await invoke({endpoint:'google-start'});
  assert.equal(blockedLogin.statusCode,503);
  assert.equal(providerCalls,0);
});

test('flag-disabled Google login stays compatible with managed v8',async()=>{
  const db=await fixture({throughVersion:8,identityManagement:false});
  process.env.SIGNUP_ALLOWLIST='v8-member@example.test';
  const start=await invoke({endpoint:'google-start'});
  const oauth=oauthValues(start);
  globalThis.fetch=googleProviderFetch({claims:{
    email:'v8-member@example.test',sub:'v8-compatible-subject',nonce:oauth.nonce,
  }});
  const callback=await invoke({endpoint:'google-callback',query:{code:'v8-code',state:oauth.state},
    cookie:oauth.cookies.join('; ')});
  assert.equal(callback.headers.location,'https://randori.example.test/?google=success');
  assert.equal(Number((await db.execute(`SELECT COUNT(*) AS count FROM auth_accounts`)).rows[0].count),1);
});

test('enabled identity management requires complete v9 before exchanging a Google code',async()=>{
  const db=await fixture({throughVersion:8});
  process.env.SIGNUP_ALLOWLIST='blocked@example.test';
  const blockedStart=await invoke({endpoint:'google-start'});
  assert.equal(blockedStart.statusCode,503);
  delete process.env.IDENTITY_MANAGEMENT_ENABLED;
  const start=await invoke({endpoint:'google-start'});
  const oauth=oauthValues(start);
  process.env.IDENTITY_MANAGEMENT_ENABLED='true';
  let providerCalls=0;
  globalThis.fetch=async()=>{ providerCalls+=1; throw new Error('provider must not be called'); };
  const callback=await invoke({endpoint:'google-callback',query:{code:'must-not-exchange',state:oauth.state},
    cookie:oauth.cookies.join('; ')});
  assert.match(callback.headers.location,/google_error=db_error/);
  assert.equal(providerCalls,0);
  assert.equal(Number((await db.execute(`SELECT COUNT(*) AS count FROM auth_accounts`)).rows[0].count),0);
});

test('Google linking is POST-only, same-origin, recent-authenticated, and bound to the exact initiating session',async()=>{
  const db=await fixture();
  await addPasswordAccount(db);
  const stale=await issueSession(db,{id:1,email:'member@example.test',name:'Member'});
  const csrf=await invoke({endpoint:'google-link-start',method:'POST',cookie:cookieFor(stale),origin:null});
  assert.equal(csrf.statusCode,403);
  const notRecent=await invoke({endpoint:'google-link-start',method:'POST',cookie:cookieFor(stale)});
  assert.equal(notRecent.statusCode,403);
  assert.equal(notRecent.body.code,'recent_auth_required');

  const fresh=await issueSession(db,{id:1,email:'member@example.test',name:'Member'},
    {recentAuthMethod:'password'});
  const start=await invoke({endpoint:'google-link-start',method:'POST',cookie:cookieFor(fresh),ip:'203.0.113.71'});
  assert.equal(start.statusCode,200);
  const {authorization,cookies,nonce,state}=oauthValues(start);
  assert.equal(authorization.searchParams.get('max_age'),'0');
  assert.equal(authorization.searchParams.get('prompt'),'select_account');
  assert.ok(cookies.some(cookie=>cookie.startsWith('randori_oauth_purpose=link%3A1%3A')));

  globalThis.fetch=googleProviderFetch({claims:{email:'member@example.test',sub:'explicit-subject',nonce,
    auth_time:Math.floor(Date.now()/1000)}});
  const changedSession=await issueSession(db,{id:1,email:'member@example.test',name:'Member'},
    {recentAuthMethod:'password'});
  const wrongSession=await invoke({endpoint:'google-callback',query:{code:'code',state},
    cookie:[cookieFor(changedSession),...cookies].join('; ')});
  assert.match(wrongSession.headers.location,/identity_link_error=session_changed/);
  assert.equal(Number((await db.execute(`SELECT COUNT(*) AS count FROM auth_provider_identities`)).rows[0].count),0);
});

test('same-email Google login conflicts until the signed-in account explicitly links it',async()=>{
  const db=await fixture();
  await addPasswordAccount(db);

  const loginStart=await invoke({endpoint:'google-start'});
  const login=oauthValues(loginStart);
  globalThis.fetch=googleProviderFetch({claims:{email:'member@example.test',sub:'explicit-subject',nonce:login.nonce}});
  const conflict=await invoke({endpoint:'google-callback',query:{code:'login-code',state:login.state},
    cookie:login.cookies.join('; ')});
  assert.match(conflict.headers.location,/google_error=account_exists_use_password/);
  assert.equal(Number((await db.execute(`SELECT COUNT(*) AS count FROM auth_provider_identities`)).rows[0].count),0);

  const token=await issueSession(db,{id:1,email:'member@example.test',name:'Member'},{recentAuthMethod:'password'});
  const start=await invoke({endpoint:'google-link-start',method:'POST',cookie:cookieFor(token),ip:'203.0.113.72'});
  const link=oauthValues(start);
  globalThis.fetch=googleProviderFetch({claims:{email:'member@example.test',sub:'explicit-subject',nonce:link.nonce,
    auth_time:Math.floor(Date.now()/1000)}});
  const callback=await invoke({endpoint:'google-callback',query:{code:'link-code',state:link.state},
    cookie:[cookieFor(token),...link.cookies].join('; ')});
  assert.equal(callback.headers.location,'https://randori.example.test/?identity_link=linked');
  assert.deepEqual((await db.execute(`SELECT subject,user_id FROM auth_provider_identities`)).rows,
    [{subject:'explicit-subject',user_id:1}]);
  assert.equal(Number((await db.execute(`SELECT COUNT(*) AS count FROM auth_accounts`)).rows[0].count),1);

  const state=await invoke({endpoint:'identities',cookie:cookieFor(token)});
  assert.equal(state.statusCode,200);
  assert.equal(state.body.identity.password.linked,true);
  assert.equal(state.body.identity.google.linked,true);
});

test('password credential add and unlink expose safe final-credential states and enforce CSRF',async()=>{
  const db=await fixture();
  await db.execute({sql:`INSERT INTO auth_accounts
    (id,email,password_hash,display_name,color,google_sub) VALUES (1,?,?,?,?,?)`,
  args:['google@example.test','!oauth:opaque','Google Member','#123456','google-subject']});
  await db.execute({sql:`INSERT INTO auth_provider_identities (issuer,subject,user_id) VALUES (?,?,1)`,
    args:[GOOGLE_ISSUER,'google-subject']});
  const token=await issueSession(db,{id:1,email:'google@example.test',name:'Google Member'},
    {recentAuthMethod:'google'});
  const cookie=cookieFor(token);

  const csrf=await invoke({endpoint:'identity-password',method:'POST',body:{action:'add',password:'new strong password'},
    cookie,origin:null});
  assert.equal(csrf.statusCode,403);
  const denied=await invoke({endpoint:'identity-google-unlink',method:'POST',body:{action:'unlink'},cookie,ip:'203.0.113.73'});
  assert.equal(denied.statusCode,409);
  assert.equal(denied.body.status,'final_credential');
  const added=await invoke({endpoint:'identity-password',method:'POST',body:{action:'add',password:'new strong password'},
    cookie,ip:'203.0.113.74'});
  assert.equal(added.statusCode,200);
  assert.equal(added.body.status,'linked');
  const removed=await invoke({endpoint:'identity-google-unlink',method:'POST',body:{action:'unlink'},cookie,ip:'203.0.113.75'});
  assert.equal(removed.statusCode,200);
  assert.equal(removed.body.status,'unlinked');
  assert.equal(removed.body.identity.password.linked,true);
  assert.equal(removed.body.identity.google.linked,false);
});

test('stable Google subject survives provider email change without rewriting the account or exposing the new email in audit',async()=>{
  const db=await fixture();
  await addPasswordAccount(db,{email:'canonical@example.test'});
  await db.execute({sql:`UPDATE auth_accounts SET google_sub=? WHERE id=1`,args:['stable-subject']});
  await db.execute({sql:`INSERT INTO auth_provider_identities (issuer,subject,user_id) VALUES (?,?,1)`,
    args:[GOOGLE_ISSUER,'stable-subject']});
  await observeGoogleProviderEmail(db,{issuer:GOOGLE_ISSUER,subject:'stable-subject',userId:1,
    providerEmail:'old-provider@example.test'});

  const start=await invoke({endpoint:'google-start'});
  const oauth=oauthValues(start);
  globalThis.fetch=googleProviderFetch({claims:{email:'new-provider@example.test',sub:'stable-subject',nonce:oauth.nonce}});
  const callback=await invoke({endpoint:'google-callback',query:{code:'changed-email',state:oauth.state},
    cookie:oauth.cookies.join('; ')});
  assert.equal(callback.headers.location,
    'https://randori.example.test/?google=success&identity_notice=provider_email_changed');
  assert.equal((await db.execute(`SELECT email FROM auth_accounts WHERE id=1`)).rows[0].email,'canonical@example.test');
  const sessionCookie=cookiesFrom(callback.headers).find(cookie=>cookie.startsWith('randori_session='));
  const payload=await verifyRequestAuth({headers:{cookie:sessionCookie}},db);
  assert.equal(payload.email,'canonical@example.test');
  const audit=JSON.stringify((await db.execute(`SELECT event_type,provider,outcome,reason_code
    FROM auth_identity_audit_events`)).rows);
  assert.match(audit,/provider_email_changed/);
  assert.doesNotMatch(audit,/new-provider@example/);
});
