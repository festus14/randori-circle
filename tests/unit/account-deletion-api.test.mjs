// Issue #339 account deletion through the real /api/auth handler on a
// migrated database: the flag hides the endpoint completely, only the
// signed-in member can delete themselves, password and Google recent
// authentication gate it, the last owner is refused, a retry is answered as
// done, sign-in is impossible afterwards and the email can register again.
import assert from 'node:assert/strict';
import { readFileSync, rmSync } from 'node:fs';
import { afterEach, test } from 'node:test';

import { createClient } from '@libsql/client';
import bcrypt from 'bcryptjs';

import authHandler from '../../api/auth.js';
import dataHandler from '../../api/data.js';
import opsHandler from '../../api/ops.js';
import { initializeLocalPrimaryCircleData } from '../../api/_admin-init.js';
import { prepareMigrationConnection } from '../../db/migration-runner.js';
import { decodeGoogleOAuthTransactionCookie, googleOAuthTransactionCookieName, googleProviderFetch } from '../support/google-oidc.mjs';
import { createMigratedDatabase } from '../support/migrated-db.mjs';

const ORIGIN='https://randori.example.test';
const PASSWORD='correct horse battery';
const ENV_KEYS=['ACCOUNT_DELETION_ENABLED','ADMIN_EMAILS','APP_URL','CIRCLE_MEMBERSHIP_ENABLED','GOOGLE_CLIENT_ID',
  'GOOGLE_CLIENT_SECRET','IDENTITY_MANAGEMENT_ENABLED','JWT_SECRET','MULTI_CIRCLE_CONTROL_PLANE_ENABLED','NODE_ENV',
  'TURSO_AUTH_TOKEN','TURSO_DATABASE_URL'];
const previous=Object.fromEntries(ENV_KEYS.map(key=>[key,process.env[key]]));
const originalFetch=globalThis.fetch;
const resources=[];
let ipCounter=0;

afterEach(async()=>{
  globalThis.fetch=originalFetch;
  while(resources.length){ try{ await resources.pop()(); }catch{} }
  for(const [key,value] of Object.entries(previous)){
    if(value===undefined) delete process.env[key]; else process.env[key]=value;
  }
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

async function invoke({endpoint,url=`/api/auth/${endpoint}`,method='GET',body,query={},cookie='',origin=ORIGIN,ip,handler=authHandler}){
  const res=response();
  const address=ip||`203.0.113.${(ipCounter+=1)%250}`;
  const headers={host:'randori.example.test','x-forwarded-proto':'https',cookie,'x-forwarded-for':address};
  if(origin!==null) headers.origin=origin;
  await handler({method,url,query:endpoint?{endpoint,...query}:query,body,headers,socket:{remoteAddress:address}},res);
  return res;
}

function deletion(options={}){
  return invoke({endpoint:'account-delete',url:'/api/auth/account/delete',...options});
}

function cookiesFrom(headers){
  const values=Array.isArray(headers['set-cookie'])?headers['set-cookie']:[headers['set-cookie']];
  return values.filter(Boolean).map(value=>String(value).split(';')[0]);
}

function sessionCookie(res){
  const cookie=cookiesFrom(res.headers).find(value=>value.startsWith('randori_session='));
  assert.ok(cookie,'a session cookie was issued');
  return cookie;
}

async function fixture({enabled=true}={}){
  const {directory,url}=await createMigratedDatabase({prefix:'randori-account-deletion-api-'});
  const db=createClient({url});
  resources.push(async()=>{ db.close(); rmSync(directory,{recursive:true,force:true}); });
  await prepareMigrationConnection(db);
  Object.assign(process.env,{
    NODE_ENV:'production',APP_URL:ORIGIN,GOOGLE_CLIENT_ID:'client',GOOGLE_CLIENT_SECRET:'secret',
    JWT_SECRET:'account-deletion-api-secret-at-least-32-bytes',TURSO_DATABASE_URL:url,CIRCLE_MEMBERSHIP_ENABLED:'true',
  });
  delete process.env.TURSO_AUTH_TOKEN;
  if(enabled) process.env.ACCOUNT_DELETION_ENABLED='true';
  const hash=await bcrypt.hash(PASSWORD,4);
  await db.batch([
    {sql:`INSERT INTO auth_accounts (id,email,password_hash,display_name,color,is_admin,google_sub) VALUES
      (1,'owner@example.test',?,'Owner','#111111',1,NULL),
      (2,'member@example.test',?,'Member','#222222',0,'member-google-sub'),
      (3,'partner@example.test',?,'Partner','#333333',0,NULL)`,args:[hash,hash,hash]},
    `INSERT INTO auth_provider_identities (issuer,subject,user_id) VALUES ('https://accounts.google.com','member-google-sub',2)`,
  ],'write');
  await initializeLocalPrimaryCircleData(db,{ownerUserId:1,ownerEmails:['owner@example.test'],
    randomUuid:()=> '11111111-1111-4111-8111-111111111111'});
  await db.batch([
    `INSERT INTO pairing_weeks (id,week_label,week_start,focus,is_demo) VALUES (10,'2098-W38','2098-09-14T07:00:00.000Z','both',0)`,
    `INSERT INTO pairing_participants (week_id,user_id,position,source) VALUES (10,2,0,'auth'),(10,3,1,'auth')`,
    `INSERT INTO pairing_groups (id,week_id,user_a_id,user_b_id,is_ai_pair) VALUES (1,10,2,3,0)`,
  ],'write');
  return db;
}

async function login(email='member@example.test',password=PASSWORD){
  return invoke({endpoint:'login',method:'POST',body:{email,password}});
}

async function signedIn(email='member@example.test'){
  const res=await login(email);
  assert.equal(res.statusCode,200,JSON.stringify(res.body));
  return sessionCookie(res);
}

async function ageRecentProofs(db){
  await db.execute(`UPDATE auth_recent_proofs SET authenticated_at=authenticated_at-3600`);
}

test('with the flag off the endpoint answers exactly like an unknown one and is not advertised',async()=>{
  await fixture({enabled:false});
  const cookie=await signedIn();
  const unknown=await invoke({endpoint:'account-unknown',cookie});
  const expected={...unknown.body,error:`unknown auth endpoint 'account-delete'`};
  for(const res of [await deletion({cookie}),await deletion({cookie,method:'POST',body:{confirm:'DELETE'}}),
    await deletion({method:'POST',body:{confirm:'DELETE'},origin:null})]){
    assert.deepEqual([res.statusCode,res.body],[404,expected]);
  }
  const bare=await invoke({url:'/api/auth/account/delete',method:'POST',body:{confirm:'DELETE'},cookie});
  assert.deepEqual([bare.statusCode,bare.body],[404,{...unknown.body,error:`unknown auth endpoint 'delete'`}]);
  const capabilities=await invoke({endpoint:'capabilities'});
  assert.equal('accountDeletion' in capabilities.body.capabilities,false);
  process.env.ACCOUNT_DELETION_ENABLED='true';
  process.env.CIRCLE_MEMBERSHIP_ENABLED='false';
  assert.equal((await deletion({cookie})).statusCode,404,'membership-free mode keeps the endpoint off');
  process.env.CIRCLE_MEMBERSHIP_ENABLED='true';
  assert.equal((await invoke({endpoint:'capabilities'})).body.capabilities.accountDeletion,true);
});

test('only the signed-in member, same-origin, with the exact confirmation, after recent authentication',async()=>{
  const db=await fixture();
  assert.equal((await deletion()).statusCode,401);
  assert.equal((await deletion({method:'POST',body:{confirm:'DELETE'}})).statusCode,401);
  const cookie=await signedIn();
  const eligibility=await deletion({cookie});
  assert.deepEqual([eligibility.statusCode,eligibility.body],[200,{ok:true,eligible:true}]);
  assert.equal((await deletion({cookie,method:'PUT'})).statusCode,405);
  assert.equal((await deletion({cookie,method:'PUT'})).headers.allow,'GET, POST');
  const crossSite=await deletion({cookie,method:'POST',body:{confirm:'DELETE'},origin:'https://evil.example.test'});
  assert.equal(crossSite.statusCode,403);
  for(const body of [undefined,{},{confirm:'delete'},{confirm:'DELETE',user_id:3}]){
    const res=await deletion({cookie,method:'POST',body});
    assert.deepEqual([res.statusCode,res.body],[400,{error:'type DELETE to confirm',code:'confirmation_required'}]);
  }
  await ageRecentProofs(db);
  const stale=await deletion({cookie,method:'POST',body:{confirm:'DELETE'}});
  assert.deepEqual([stale.statusCode,stale.body],[403,{error:'recent authentication required',code:'recent_auth_required'}]);
  const wrong=await invoke({endpoint:'recent-auth',method:'POST',body:{password:'not the password'},cookie});
  assert.equal(wrong.statusCode,401);
  assert.equal((await deletion({cookie,method:'POST',body:{confirm:'DELETE'}})).statusCode,403);
  // Nothing changed for anyone while the requests were refused.
  assert.equal(String((await db.execute(`SELECT email FROM auth_accounts WHERE id=2`)).rows[0].email),'member@example.test');

  const confirmed=await invoke({endpoint:'recent-auth',method:'POST',body:{password:PASSWORD},cookie});
  assert.equal(confirmed.statusCode,200);
  const deleted=await deletion({cookie,method:'POST',body:{confirm:'DELETE'}});
  assert.deepEqual([deleted.statusCode,deleted.body],[200,{ok:true,status:'deleted'}]);
  assert.match(String(deleted.headers['set-cookie']),/randori_session=; Path=\/; HttpOnly; SameSite=Lax; Max-Age=0; Secure/);

  // The old cookie is dead, a lost response is answered as done, sign-in is
  // impossible, and the partner's history shows "Deleted member".
  assert.equal((await invoke({endpoint:'me',cookie})).statusCode,401);
  const retry=await deletion({cookie,method:'POST',body:{confirm:'DELETE'}});
  assert.deepEqual([retry.statusCode,retry.body],[200,{ok:true,status:'already_deleted'}]);
  assert.equal((await deletion({cookie})).statusCode,401,'GET does not reveal anything to a dead session');
  const relogin=await login();
  assert.deepEqual([relogin.statusCode,relogin.body],[401,{error:'invalid credentials'}]);
  const partnerSees=await db.execute(`SELECT account.display_name FROM pairing_groups pg JOIN auth_accounts account ON account.id=pg.user_a_id`);
  assert.equal(partnerSees.rows[0].display_name,'Deleted member');
  assert.equal(Number((await db.execute(`SELECT COUNT(*) AS count FROM circle_audit_events WHERE event_type='account.deleted'`)).rows[0].count),1);

  // The same email registers again as a brand-new account.
  const hash=await bcrypt.hash('a brand new password',4);
  const created=await db.execute({sql:`INSERT INTO auth_accounts (email,password_hash,display_name,color) VALUES ('member@example.test',?,'Member Again','#999999') RETURNING id`,args:[hash]});
  const newId=Number(created.rows[0].id);
  assert.notEqual(newId,2);
  await db.execute({sql:`INSERT INTO circle_memberships (circle_id,user_id,role,status) VALUES (1,?,'member','active')`,args:[newId]});
  const again=await login('member@example.test','a brand new password');
  assert.equal(again.statusCode,200);
  assert.deepEqual([again.body.user.id,again.body.user.name],[newId,'Member Again']);
});

test('the last owner is refused with guidance, and eligibility says so before re-authentication',async()=>{
  await fixture();
  const cookie=await signedIn('owner@example.test');
  const eligibility=await deletion({cookie});
  assert.equal(eligibility.statusCode,200);
  assert.equal(eligibility.body.eligible,false);
  assert.equal(eligibility.body.code,'last_owner');
  assert.equal(eligibility.body.circles.length,1);
  assert.equal(eligibility.body.circles[0].is_primary,true);
  const refused=await deletion({cookie,method:'POST',body:{confirm:'DELETE'}});
  assert.equal(refused.statusCode,409);
  assert.deepEqual({...refused.body,circles:undefined},
    {error:'make another member an owner or archive the circle first',code:'last_owner',circles:undefined});
});

test('the last app admin and demo accounts are refused',async()=>{
  const db=await fixture();
  await db.batch([
    `UPDATE circle_memberships SET role='owner' WHERE user_id=3`,
    `UPDATE auth_accounts SET is_admin=CASE WHEN id=3 THEN 1 ELSE 0 END`,
  ],'write');
  const cookie=await signedIn('partner@example.test');
  assert.deepEqual((await deletion({cookie})).body,{ok:true,eligible:false,code:'last_admin'});
  const refused=await deletion({cookie,method:'POST',body:{confirm:'DELETE'}});
  assert.deepEqual([refused.statusCode,refused.body],[409,{error:'make another member an app admin first',code:'last_admin'}]);
  await db.execute(`UPDATE auth_accounts SET is_demo=1 WHERE id=3`);
  const demo=await deletion({cookie,method:'POST',body:{confirm:'DELETE'}});
  assert.deepEqual([demo.statusCode,demo.body],[403,{error:'demo accounts cannot be deleted',code:'demo_account'}]);
  assert.deepEqual((await deletion({cookie})).body,{ok:true,eligible:false,code:'demo_account'});
});

test('Google re-authentication with a fresh auth_time authorizes the deletion; a stale one does not',async()=>{
  const db=await fixture();
  const cookie=await signedIn();
  await ageRecentProofs(db);
  async function googleReauth(sessionCookieValue,authTime){
    const start=await invoke({endpoint:'google-reauth-start',url:'/api/auth/google/reauth/start',method:'POST',body:{},
      cookie:sessionCookieValue});
    assert.equal(start.statusCode,200,JSON.stringify(start.body));
    const state=new URL(start.body.authorizationUrl).searchParams.get('state');
    const startCookies=cookiesFrom(start.headers);
    const transaction=decodeGoogleOAuthTransactionCookie(
      startCookies.find(value=>value.startsWith(`${googleOAuthTransactionCookieName(state)}=`)),state);
    globalThis.fetch=googleProviderFetch({claims:{email:'member@example.test',name:'Member',sub:'member-google-sub',
      nonce:transaction.nonce,auth_time:authTime}});
    return invoke({endpoint:'google-callback',url:'/api/auth/google/callback',query:{code:'code',state},
      cookie:[sessionCookieValue,...startCookies].join('; ')});
  }
  const stale=await googleReauth(cookie,Math.floor(Date.now()/1000)-10*60);
  assert.match(String(stale.headers.location),/google_error=/);
  assert.equal((await deletion({cookie,method:'POST',body:{confirm:'DELETE'}})).statusCode,403);
  const fresh=await googleReauth(cookie,Math.floor(Date.now()/1000));
  assert.equal(fresh.headers.location,`${ORIGIN}/?google_reauth=success`);
  const replacement=sessionCookie(fresh);
  const deleted=await deletion({cookie:replacement,method:'POST',body:{confirm:'DELETE'}});
  assert.deepEqual([deleted.statusCode,deleted.body],[200,{ok:true,status:'deleted'}]);
  assert.equal(Number((await db.execute(`SELECT COUNT(*) AS count FROM auth_provider_identities`)).rows[0].count),0);

  // Signing in with the same Google account no longer reaches the old account.
  const start=await invoke({endpoint:'google-start',url:'/api/auth/google/start'});
  const state=new URL(start.headers.location).searchParams.get('state');
  const startCookies=cookiesFrom(start.headers);
  const transaction=decodeGoogleOAuthTransactionCookie(
    startCookies.find(value=>value.startsWith(`${googleOAuthTransactionCookieName(state)}=`)),state);
  globalThis.fetch=googleProviderFetch({claims:{email:'member@example.test',name:'Member',sub:'member-google-sub',nonce:transaction.nonce}});
  const google=await invoke({endpoint:'google-callback',url:'/api/auth/google/callback',query:{code:'code',state},
    cookie:startCookies.join('; ')});
  assert.match(String(google.headers.location),/google_error=private_beta/);
  assert.equal(cookiesFrom(google.headers).some(value=>value.startsWith('randori_session=')&&value!=='randori_session='),false);
});

test('deletion attempts share the per-account identity budget',async()=>{
  const db=await fixture();
  const cookie=await signedIn();
  await ageRecentProofs(db);
  const statuses=[];
  for(let attempt=0;attempt<11;attempt+=1){
    statuses.push((await deletion({cookie,method:'POST',body:{confirm:'DELETE'}})).statusCode);
  }
  assert.deepEqual(statuses,[...Array(10).fill(403),429]);
});

test('an unready or failing database answers 503 without detail',async()=>{
  const db=await fixture();
  const cookie=await signedIn();
  await db.execute(`UPDATE auth_recent_proofs SET authenticated_at=authenticated_at`);
  await db.execute(`DROP TABLE pairing_email_outbox`);
  for(const options of [{cookie},{cookie,method:'POST',body:{confirm:'DELETE'}}]){
    const res=await deletion(options);
    assert.deepEqual([res.statusCode,res.body],[503,{error:'account deletion temporarily unavailable'}]);
  }
});

test('a deletion mid-cycle keeps the circle\'s current pairing readable; another ex-member still fails closed',async()=>{
  const db=await fixture();
  const ownerCookie=await signedIn('owner@example.test');
  const memberCookie=await signedIn();
  const weeks=await invoke({handler:dataHandler,endpoint:'weeks',url:'/api/weeks',cookie:ownerCookie});
  assert.equal(weeks.statusCode,200,JSON.stringify(weeks.body));
  const published=await invoke({handler:opsHandler,endpoint:'pairing-run',url:'/api/pairing/run',method:'POST',
    body:{expected_cycle_key:weeks.body.publication_state.cycle_key},cookie:ownerCookie});
  assert.equal(published.statusCode,200,JSON.stringify(published.body));
  const before=await invoke({handler:dataHandler,endpoint:'weeks',url:'/api/weeks',cookie:ownerCookie});
  assert.ok(JSON.stringify(before.body).includes('Member'));

  const deleted=await deletion({cookie:memberCookie,method:'POST',body:{confirm:'DELETE'}});
  assert.equal(deleted.statusCode,200,JSON.stringify(deleted.body));
  const after=await invoke({handler:dataHandler,endpoint:'weeks',url:'/api/weeks',cookie:ownerCookie});
  assert.equal(after.statusCode,200,JSON.stringify(after.body));
  assert.ok(JSON.stringify(after.body).includes('Deleted member'));
  assert.equal(JSON.stringify(after.body).includes('member@example.test'),false);

  await db.execute(`UPDATE circle_memberships SET status='inactive' WHERE user_id=3`);
  const outside=await invoke({handler:dataHandler,endpoint:'weeks',url:'/api/weeks',cookie:ownerCookie});
  assert.deepEqual([outside.statusCode,outside.body],[503,{ok:false,error:'pairing unavailable'}]);
});

test('the deletion route is wired in vercel.json and the local runtime',()=>{
  const config=JSON.parse(readFileSync(new URL('../../vercel.json',import.meta.url),'utf8'));
  assert.deepEqual(config.rewrites.find(item=>item.source==='/api/auth/account/delete'),
    {source:'/api/auth/account/delete',destination:'/api/auth?endpoint=account-delete'});
  const local=readFileSync(new URL('../../scripts/local-server.mjs',import.meta.url),'utf8');
  assert.ok(local.includes(`['/api/auth/account/delete','account-delete']`));
});
