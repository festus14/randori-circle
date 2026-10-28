// Issue #372 account-deletion grace period through the real /api/auth
// handler on a migrated database: the grace flag switches requests to the
// pending path, the cancel endpoint restores the account, locked accounts
// get 409 deletion_pending from /api/auth/me and 401 everywhere else, and
// with the grace flag off deletion is still immediate.
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { afterEach, test } from 'node:test';

import { createClient } from '@libsql/client';
import bcrypt from 'bcryptjs';

import authHandler from '../../api/auth.js';
import membersHandler from '../../api/members.js';
import { initializeLocalPrimaryCircleData } from '../../api/_admin-init.js';
import { prepareMigrationConnection } from '../../db/migration-runner.js';
import { createMigratedDatabase } from '../support/migrated-db.mjs';

const ORIGIN='https://randori.example.test';
const PASSWORD='correct horse battery';
const ENV_KEYS=['ACCOUNT_DELETION_ENABLED','ACCOUNT_DELETION_GRACE_ENABLED','ADMIN_EMAILS','APP_URL',
  'CIRCLE_MEMBERSHIP_ENABLED','GOOGLE_CLIENT_ID','GOOGLE_CLIENT_SECRET','JWT_SECRET',
  'MULTI_CIRCLE_CONTROL_PLANE_ENABLED','NODE_ENV','TURSO_AUTH_TOKEN','TURSO_DATABASE_URL'];
const previous=Object.fromEntries(ENV_KEYS.map(key=>[key,process.env[key]]));
const resources=[];
let ipCounter=0;

afterEach(async()=>{
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

async function invoke({endpoint,url,method='GET',body,query={},cookie='',origin=ORIGIN,handler=authHandler}){
  const res=response();
  const address=`203.0.113.${(ipCounter+=1)%250}`;
  const headers={host:'randori.example.test','x-forwarded-proto':'https',cookie,'x-forwarded-for':address};
  if(origin!==null) headers.origin=origin;
  await handler({method,url:url||`/api/auth/${endpoint}`,query:endpoint?{endpoint,...query}:query,body,
    headers,socket:{remoteAddress:address}},res);
  return res;
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

async function fixture({grace=true}={}){
  const {directory,url}=await createMigratedDatabase({prefix:'randori-account-deletion-grace-api-'});
  const db=createClient({url});
  resources.push(async()=>{ db.close(); rmSync(directory,{recursive:true,force:true}); });
  await prepareMigrationConnection(db);
  Object.assign(process.env,{
    NODE_ENV:'production',APP_URL:ORIGIN,JWT_SECRET:'grace-api-secret-at-least-32-bytes',
    TURSO_DATABASE_URL:url,CIRCLE_MEMBERSHIP_ENABLED:'true',ACCOUNT_DELETION_ENABLED:'true',
  });
  delete process.env.TURSO_AUTH_TOKEN;
  if(grace) process.env.ACCOUNT_DELETION_GRACE_ENABLED='true';
  const hash=await bcrypt.hash(PASSWORD,4);
  await db.batch([
    {sql:`INSERT INTO auth_accounts (id,email,password_hash,display_name,color,is_admin,google_sub) VALUES
      (1,'owner@example.test',?,'Owner','#111111',1,NULL),
      (2,'member@example.test',?,'Member','#222222',0,NULL)`,args:[hash,hash]},
  ],'write');
  await initializeLocalPrimaryCircleData(db,{ownerUserId:1,ownerEmails:['owner@example.test'],
    randomUuid:()=>'11111111-1111-4111-8111-111111111111'});
  // initializeLocalPrimaryCircleData backfills the membership for the
  // existing member account; inserting it again would violate the key.
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

function deletion(options={}){
  return invoke({endpoint:'account-delete',url:'/api/auth/account/delete',...options});
}

function cancelDeletion(options={}){
  return invoke({endpoint:'account-delete-cancel',url:'/api/auth/account/delete/cancel',...options});
}

async function requestDeletion(cookie){
  return deletion({cookie,method:'POST',body:{confirm:'DELETE'}});
}

test('with the grace flag on, requesting deletion schedules it and the cancel endpoint restores the account',async()=>{
  const db=await fixture({grace:true});
  const cookie=await signedIn();
  const requested=await requestDeletion(cookie);
  assert.deepEqual([requested.statusCode,requested.body.ok,requested.body.status],
    [200,true,'pending_deletion']);
  assert.match(requested.body.scheduled_for,/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  const pending=await db.execute(`SELECT scheduled_for,cancelled_at,executed_at FROM account_deletion_requests WHERE user_id=2`);
  assert.equal(pending.rows.length,1);
  assert.equal(pending.rows[0].cancelled_at,null);
  // The old session is revoked: me answers with the pending state, and the
  // request endpoint answers already_pending.
  assert.deepEqual([(await invoke({endpoint:'me',cookie})).statusCode,
    (await invoke({endpoint:'me',cookie})).body.code],[409,'deletion_pending']);
  assert.deepEqual([(await deletion({cookie,method:'GET'})).statusCode,
    (await deletion({cookie,method:'GET'})).body.deletion_pending],[200,true]);
  assert.deepEqual([(await requestDeletion(cookie)).statusCode,
    (await requestDeletion(cookie)).body.code],[409,'already_pending']);
  // Other APIs refuse the locked account.
  const members=await invoke({endpoint:'members',url:'/api/members',cookie,handler:membersHandler});
  assert.equal(members.statusCode,401);
  // A fresh sign-in succeeds and carries the pending flag, so the app
  // shows the cancel screen instead of the dashboard.
  const freshLogin=await login();
  assert.equal(freshLogin.statusCode,200);
  assert.equal(freshLogin.body.deletion_pending,true);
  assert.equal(freshLogin.body.scheduled_for,requested.body.scheduled_for);
  const fresh=sessionCookie(freshLogin);
  const cancelled=await cancelDeletion({cookie:fresh,method:'POST',body:{}});
  assert.deepEqual([cancelled.statusCode,cancelled.body],[200,{ok:true,status:'cancelled',
    scheduled_for:requested.body.scheduled_for}]);
  // The cancel session keeps working as the restored account.
  const me=await invoke({endpoint:'me',cookie:fresh});
  assert.deepEqual([me.statusCode,me.body.user.email],[200,'member@example.test']);
  const row=await db.execute(`SELECT cancelled_at,executed_at FROM account_deletion_requests WHERE user_id=2`);
  assert.notEqual(row.rows[0].cancelled_at,null);
  assert.equal(row.rows[0].executed_at,null);
});

test('cancel: 401 without a session, 409 when nothing is scheduled, 400 for a non-empty body, flag-off 404',async()=>{
  const db=await fixture({grace:true});
  void db;
  assert.deepEqual([(await cancelDeletion({method:'POST',body:{}})).statusCode], [401]);
  const cookie=await signedIn();
  assert.deepEqual([(await cancelDeletion({cookie,method:'POST',body:{}})).statusCode,
    (await cancelDeletion({cookie,method:'POST',body:{}})).body.code],[409,'not_pending']);
  assert.equal((await cancelDeletion({cookie,method:'POST',body:{cancel:true}})).statusCode,400);
  assert.equal((await cancelDeletion({cookie,method:'GET'})).statusCode,405);
  delete process.env.ACCOUNT_DELETION_ENABLED;
  const unknown=await invoke({endpoint:'account-unknown',cookie});
  assert.deepEqual([ (await cancelDeletion({cookie,method:'POST',body:{}})).statusCode,
    (await cancelDeletion({cookie,method:'POST',body:{}})).body ],
  [404,{...unknown.body,error:`unknown auth endpoint 'account-delete-cancel'`}]);
});

test('with the grace flag off, deletion is still immediate and the cancel endpoint 404s',async()=>{
  await fixture({grace:false});
  const cookie=await signedIn();
  const deleted=await requestDeletion(cookie);
  assert.deepEqual([deleted.statusCode,deleted.body],[200,{ok:true,status:'deleted'}]);
  assert.equal((await invoke({endpoint:'me',cookie})).statusCode,401,'the tombstone has no session');
  // The cancel endpoint is live (the deletion flag is on) but the session
  // died with the account: 401, not a pending cancellation.
  assert.equal((await cancelDeletion({cookie,method:'POST',body:{}})).statusCode,401);
  delete process.env.ACCOUNT_DELETION_ENABLED;
  const unknown=await invoke({endpoint:'account-unknown',cookie});
  assert.deepEqual([(await cancelDeletion({cookie,method:'POST',body:{}})).statusCode,
    (await cancelDeletion({cookie,method:'POST',body:{}})).body],
  [404,{...unknown.body,error:`unknown auth endpoint 'account-delete-cancel'`}]);
});

test('capabilities advertise the grace period only when the flag is on',async()=>{
  await fixture({grace:false});
  assert.equal((await invoke({endpoint:'capabilities'})).body.capabilities.accountDeletionGrace,undefined);
  process.env.ACCOUNT_DELETION_GRACE_ENABLED='true';
  assert.equal((await invoke({endpoint:'capabilities'})).body.capabilities.accountDeletionGrace,true);
});
