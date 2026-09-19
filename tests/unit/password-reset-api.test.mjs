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
import {openPasswordResetToken} from '../../api/_password-reset.js';
import {EXECUTABLE_MIGRATIONS} from '../../db/executable-migrations.js';
import {applyMigrations,inspectMigrationState,prepareMigrationConnection} from '../../db/migration-runner.js';

const resources=[];

afterEach(()=>{
  for(const key of ['APP_URL','CIRCLE_MEMBERSHIP_ENABLED','PASSWORD_RESET_ENABLED',
    'PASSWORD_RESET_ENCRYPTION_KEY','JWT_SECRET','NODE_ENV','RESEND_API_KEY','RESEND_FROM',
    'TURSO_AUTH_TOKEN','TURSO_DATABASE_URL']) delete process.env[key];
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

async function invoke({endpoint,method='POST',body,cookie='',origin='https://randori.example.test',ip='203.0.113.20'}){
  const res=response();
  const headers={host:'randori.example.test','x-forwarded-proto':'https',cookie,'x-forwarded-for':ip};
  if(origin!==null) headers.origin=origin;
  await authHandler({method,url:`/api/auth/${endpoint}`,query:{endpoint},body,headers,
    socket:{remoteAddress:ip}},res);
  return res;
}

function sessionCookie(headers){
  const values=Array.isArray(headers['set-cookie'])?headers['set-cookie']:[headers['set-cookie']];
  return String(values.find(value=>String(value).startsWith('randori_session='))||'').split(';')[0];
}

async function fixture(){
  const directory=mkdtempSync(join(tmpdir(),'randori-password-reset-api-'));
  const path=join(directory,'database.sqlite');
  const url=pathToFileURL(path).href;
  process.env.NODE_ENV='production';
  process.env.APP_URL='https://randori.example.test';
  process.env.CIRCLE_MEMBERSHIP_ENABLED='false';
  process.env.PASSWORD_RESET_ENABLED='true';
  process.env.PASSWORD_RESET_ENCRYPTION_KEY=Buffer.alloc(32,13).toString('base64url');
  process.env.RESEND_API_KEY='re_test_reset';
  process.env.RESEND_FROM='Randori <reset@randori.example.test>';
  process.env.JWT_SECRET='password-reset-api-test-secret-at-least-32-bytes';
  process.env.TURSO_DATABASE_URL=url;
  const db=createClient({url});
  await prepareMigrationConnection(db);
  const initial=await inspectMigrationState(db,{migrations:EXECUTABLE_MIGRATIONS});
  await applyMigrations(db,{migrations:EXECUTABLE_MIGRATIONS,
    expectedStateFingerprint:initial.stateFingerprint,retry:{maxAttempts:1,baseDelayMs:0,maxDelayMs:0}});
  const passwordHash=await bcrypt.hash('old correct horse',4);
  await db.execute({sql:`INSERT INTO auth_accounts
    (id,email,password_hash,display_name,color,is_admin) VALUES (1,?,?,?,?,0)`,
  args:['member@example.test',passwordHash,'Member','#123456']});
  resources.push(()=>{ db.close(); rmSync(directory,{recursive:true,force:true}); });
  return {db};
}

async function resetToken(db){
  const row=(await db.execute(`SELECT payload_json FROM outbox_events
    WHERE event_type='auth.passwordreset.requested' ORDER BY id DESC LIMIT 1`)).rows[0];
  return openPasswordResetToken(JSON.parse(row.payload_json).token_envelope);
}

test('request response is enumeration-safe and reset revokes every existing session',async()=>{
  const {db}=await fixture();
  const first=await issueSession(db,{id:1,email:'member@example.test',name:'Member'});
  const second=await issueSession(db,{id:1,email:'member@example.test',name:'Member'});
  const known=await invoke({endpoint:'password-reset-request',body:{email:'member@example.test'},ip:'203.0.113.21'});
  const unknown=await invoke({endpoint:'password-reset-request',body:{email:'missing@example.test'},ip:'203.0.113.22'});
  assert.equal(known.statusCode,202);
  assert.deepEqual(unknown.body,known.body);
  const token=await resetToken(db);
  const changed=await invoke({endpoint:'password-reset-consume',body:{token,password:'new correct horse'},
    cookie:`randori_session=${encodeURIComponent(first)}`,ip:'203.0.113.23'});
  assert.equal(changed.statusCode,200);
  assert.equal(changed.body.status,'reset');
  assert.match(String(changed.headers['set-cookie']),/randori_session=;/);
  assert.equal(await verifyRequestAuth({headers:{authorization:`Bearer ${second}`}},db),null);
  const login=await invoke({endpoint:'login',body:{email:'member@example.test',password:'new correct horse'},ip:'203.0.113.24'});
  assert.equal(login.statusCode,200);
});

test('reset consume enforces CSRF, password policy, expiry, replay, and durable request limits',async()=>{
  const {db}=await fixture();
  const rejected=await invoke({endpoint:'password-reset-request',body:{email:'member@example.test'},origin:null});
  assert.equal(rejected.statusCode,403);
  const accepted=await invoke({endpoint:'password-reset-request',body:{email:'member@example.test'},ip:'203.0.113.30'});
  assert.equal(accepted.statusCode,202);
  const token=await resetToken(db);
  const weak=await invoke({endpoint:'password-reset-consume',body:{token,password:'short'},ip:'203.0.113.31'});
  assert.equal(weak.statusCode,400);
  const reset=await invoke({endpoint:'password-reset-consume',body:{token,password:'replacement password'},ip:'203.0.113.31'});
  assert.equal(reset.statusCode,200);
  const replay=await invoke({endpoint:'password-reset-consume',body:{token,password:'another replacement'},ip:'203.0.113.31'});
  assert.equal(replay.statusCode,409);
  assert.equal(replay.body.status,'used');

  const statuses=[];
  for(let attempt=0;attempt<6;attempt+=1){
    statuses.push((await invoke({endpoint:'password-reset-request',body:{email:'missing@example.test'},
      ip:'203.0.113.32'})).statusCode);
  }
  assert.deepEqual(statuses.slice(0,5),Array(5).fill(202));
  assert.equal(statuses[5],429);
});

test('password login and explicit confirmation create session-scoped recent-auth evidence',async()=>{
  const {db}=await fixture();
  const login=await invoke({endpoint:'login',body:{email:'member@example.test',password:'old correct horse'},ip:'203.0.113.40'});
  const cookie=sessionCookie(login.headers);
  assert.ok(cookie);
  const recent=await invoke({endpoint:'recent-auth',method:'GET',cookie,ip:'203.0.113.40'});
  assert.equal(recent.statusCode,200);
  assert.equal(recent.body.recentAuth.ok,true);
  assert.equal(recent.body.recentAuth.method,'password');

  const token=await issueSession(db,{id:1,email:'member@example.test',name:'Member'});
  const staleCookie=`randori_session=${encodeURIComponent(token)}`;
  const before=await invoke({endpoint:'recent-auth',method:'GET',cookie:staleCookie,ip:'203.0.113.41'});
  assert.equal(before.body.recentAuth.ok,false);
  const wrong=await invoke({endpoint:'recent-auth',body:{password:'wrong password'},cookie:staleCookie,ip:'203.0.113.41'});
  assert.equal(wrong.statusCode,401);
  const confirmed=await invoke({endpoint:'recent-auth',body:{password:'old correct horse'},cookie:staleCookie,ip:'203.0.113.41'});
  assert.equal(confirmed.statusCode,200);
  assert.equal(confirmed.body.recentAuth.method,'password');
});

test('production reset capability fails closed without the dedicated encryption key',async()=>{
  await fixture();
  delete process.env.PASSWORD_RESET_ENCRYPTION_KEY;
  const capabilities=await invoke({endpoint:'capabilities',method:'GET',origin:null});
  assert.equal(capabilities.body.capabilities.passwordReset,false);
  const request=await invoke({endpoint:'password-reset-request',body:{email:'member@example.test'}});
  assert.equal(request.statusCode,503);
});
