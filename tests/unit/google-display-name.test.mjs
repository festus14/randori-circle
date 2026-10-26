import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {afterEach,test} from 'node:test';

import {createClient} from '@libsql/client';

import authHandler from '../../api/auth.js';
import {verifyRequestAuth} from '../../api/_db.js';
import {
  INVITE_CLAIM_COOKIE,
  createInvitationToken,
  hashInvitationEmail,
  hashInvitationToken,
  prepareInvitationClaim,
} from '../../api/_circle-membership.js';
import {EXECUTABLE_MIGRATIONS} from '../../db/executable-migrations.js';
import {applyMigrations,inspectMigrationState,prepareMigrationConnection} from '../../db/migration-runner.js';
import {decodeGoogleOAuthTransactionCookie,googleProviderFetch,
  googleOAuthTransactionCookieName} from '../support/google-oidc.mjs';

const originalFetch=globalThis.fetch;
const resources=[];

afterEach(()=>{
  globalThis.fetch=originalFetch;
  for(const key of ['APP_URL','CIRCLE_MEMBERSHIP_ENABLED','GOOGLE_CLIENT_ID','GOOGLE_CLIENT_SECRET',
    'JWT_SECRET','NODE_ENV','SIGNUP_ALLOWLIST','TURSO_DATABASE_URL']) delete process.env[key];
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

async function invoke({endpoint,method='GET',body,query={},cookie='',origin='https://randori.example.test'}){
  const res=response();
  const headers={host:'randori.example.test','x-forwarded-proto':'https',cookie,'x-forwarded-for':'203.0.113.70'};
  if(origin!==null) headers.origin=origin;
  await authHandler({method,url:`/api/auth/${endpoint}`,query:{endpoint,...query},body,headers,
    socket:{remoteAddress:'203.0.113.70'}},res);
  return res;
}

function cookiesFrom(headers){
  const values=Array.isArray(headers['set-cookie'])?headers['set-cookie']:[headers['set-cookie']];
  return values.filter(Boolean).map(value=>String(value).split(';')[0]);
}

function oauthValues(start){
  const authorization=new URL(start.body?.authorizationUrl||start.headers.location);
  const cookies=cookiesFrom(start.headers);
  const state=authorization.searchParams.get('state');
  const transactionCookie=cookies
    .find(cookie=>cookie.startsWith(`${googleOAuthTransactionCookieName(state)}=`));
  const transaction=decodeGoogleOAuthTransactionCookie(transactionCookie,state);
  return {authorization,cookies,nonce:transaction.nonce,purpose:transaction.purpose,state};
}

async function fixture({membershipEnabled=false}={}){
  const directory=mkdtempSync(join(tmpdir(),'randori-google-display-name-'));
  const url=pathToFileURL(join(directory,'database.sqlite')).href;
  process.env.NODE_ENV='production';
  process.env.APP_URL='https://randori.example.test';
  process.env.CIRCLE_MEMBERSHIP_ENABLED=membershipEnabled?'true':'false';
  process.env.GOOGLE_CLIENT_ID='client';
  process.env.GOOGLE_CLIENT_SECRET='secret';
  process.env.JWT_SECRET='google-display-name-secret-at-least-32-bytes';
  process.env.TURSO_DATABASE_URL=url;
  const db=createClient({url});
  await prepareMigrationConnection(db);
  const fresh=await inspectMigrationState(db);
  await applyMigrations(db,{expectedStateFingerprint:fresh.stateFingerprint,
    retry:{maxAttempts:1,baseDelayMs:0,maxDelayMs:0}});
  resources.push(()=>{ db.close(); rmSync(directory,{recursive:true,force:true}); });
  return db;
}

async function signInWithGoogle({googleName,googleSub,email}){
  const start=await invoke({endpoint:'google-start'});
  const oauth=oauthValues(start);
  globalThis.fetch=googleProviderFetch({claims:{
    email,name:googleName,sub:googleSub,nonce:oauth.nonce,
  }});
  return invoke({endpoint:'google-callback',query:{code:'google-code',state:oauth.state},
    cookie:oauth.cookies.join('; ')});
}

async function sessionName(db,callback){
  const sessionCookie=cookiesFrom(callback.headers).find(cookie=>cookie.startsWith('randori_session='));
  assert.ok(sessionCookie,'Google sign-in must issue a session');
  const payload=await verifyRequestAuth({headers:{cookie:sessionCookie}},db);
  return payload?.name;
}

test('#397 Google sign-in preserves a member-set display name (provider-identity path)',async()=>{
  const db=await fixture();
  await db.execute({sql:`INSERT INTO auth_accounts
    (id,email,password_hash,display_name,color,google_sub) VALUES (1,?,?,?,?,?)`,
  args:['member@example.test','!oauth:existing','Google Name','#123456','google-subject-1']});
  await db.execute({sql:`INSERT INTO auth_provider_identities (issuer,subject,user_id) VALUES (?,?,1)`,
    args:['https://accounts.google.com','google-subject-1']});
  // The member changed their name via POST /api/profile; that endpoint writes
  // auth_accounts.display_name, which is the state the callback must preserve.
  await db.execute({sql:`UPDATE auth_accounts SET display_name=? WHERE id=1`,
    args:['Member Set Name']});

  const callback=await signInWithGoogle({googleName:'Google Renamed',googleSub:'google-subject-1',
    email:'member@example.test'});
  assert.equal(callback.headers.location,'https://randori.example.test/?google=success');
  assert.equal((await db.execute(`SELECT display_name FROM auth_accounts WHERE id=1`)).rows[0].display_name,
    'Member Set Name','a Google sign-in alone must never overwrite a member-set name');
  assert.equal(await sessionName(db,callback),'Member Set Name',
    'the session must carry the stored name, not the Google name');
});

test('#397 Google sign-in preserves a member-set display name (legacy google_sub path)',async()=>{
  const db=await fixture();
  await db.execute({sql:`INSERT INTO auth_accounts
    (id,email,password_hash,display_name,color,google_sub) VALUES (1,?,?,?,?,?)`,
  args:['legacy@example.test','!oauth:existing','Member Set Name','#123456','google-legacy-1']});

  const callback=await signInWithGoogle({googleName:'Google Renamed',googleSub:'google-legacy-1',
    email:'legacy@example.test'});
  assert.equal(callback.headers.location,'https://randori.example.test/?google=success');
  assert.equal((await db.execute(`SELECT display_name FROM auth_accounts WHERE id=1`)).rows[0].display_name,
    'Member Set Name');
  assert.equal(await sessionName(db,callback),'Member Set Name');
  assert.deepEqual((await db.execute(`SELECT subject,user_id FROM auth_provider_identities`)).rows,
    [{subject:'google-legacy-1',user_id:1}]);
});

test('#397 a new account created via Google gets the Google name',async()=>{
  const db=await fixture({membershipEnabled:true});
  await db.execute({sql:`INSERT INTO circles (id,public_id,slug,name,is_primary,created_by,created_at)
    VALUES (10,'3c20c4da-1906-4ca4-b4fd-5971f1dd066d','randori-circle','Randori Circle',1,1,datetime('now'))`});
  const email='new@example.test';
  const token=createInvitationToken();
  await db.execute({
    sql:`INSERT INTO circle_invitations
      (id,circle_id,token_hash,email_hash,created_by,created_at,expires_at)
      VALUES (?,10,?,?,1,datetime('now'),datetime('now','+7 days'))`,
    args:['94948c6c-23e0-4b0f-9dd2-45e9367fc456',hashInvitationToken(token),hashInvitationEmail(email)],
  });
  const prepared=await prepareInvitationClaim(db,{token});
  assert.equal(prepared.ok,true);
  const inviteCookie=`${INVITE_CLAIM_COOKIE}=${encodeURIComponent(prepared.claim)}`;

  const start=await invoke({endpoint:'google-start',method:'POST',
    body:{purpose:'invite',invite_binding:prepared.binding},cookie:inviteCookie});
  assert.equal(start.statusCode,200);
  const oauth=oauthValues(start);
  globalThis.fetch=googleProviderFetch({claims:{
    email,name:'Google New Name',sub:'google-new-1',nonce:oauth.nonce,
  }});
  const callback=await invoke({endpoint:'google-callback',
    query:{code:'invite-code',state:oauth.state},
    cookie:[...oauth.cookies,inviteCookie].join('; ')});
  assert.equal(callback.headers.location,'https://randori.example.test/?google=success');
  const created=await db.execute({sql:`SELECT display_name FROM auth_accounts WHERE email=?`,args:[email]});
  assert.equal(created.rows.length,1);
  assert.equal(created.rows[0].display_name,'Google New Name',
    'account creation is the one Google sign-in path that sets the display name');
  assert.equal(await sessionName(db,callback),'Google New Name');
});
