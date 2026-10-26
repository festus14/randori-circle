// Issue #365 data export through the real /api/auth handler on a migrated
// database: the flag hides the endpoint completely, only the signed-in
// member exports themselves, recent authentication gates it, the rate limit
// and the size bound hold, and the archive downloads as an attachment.
import assert from 'node:assert/strict';
import { readFileSync, rmSync } from 'node:fs';
import { afterEach, test } from 'node:test';

import { createClient } from '@libsql/client';
import bcrypt from 'bcryptjs';

import authHandler from '../../api/auth.js';
import { initializeLocalPrimaryCircleData } from '../../api/_admin-init.js';
import { prepareMigrationConnection } from '../../db/migration-runner.js';
import { createMigratedDatabase } from '../support/migrated-db.mjs';

const ORIGIN='https://randori.example.test';
const PASSWORD='correct horse battery';
const ENV_KEYS=['DATA_EXPORT_ENABLED','ADMIN_EMAILS','APP_URL','CIRCLE_MEMBERSHIP_ENABLED','EXECUTION_API_URL',
  'EXECUTION_PROVIDER','GOOGLE_CLIENT_ID','GOOGLE_CLIENT_SECRET','IDENTITY_MANAGEMENT_ENABLED','JWT_SECRET',
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

async function invoke({endpoint,url=`/api/auth/${endpoint}`,method='GET',body,query={},cookie='',origin=ORIGIN,ip,handler=authHandler}){
  const res=response();
  const address=ip||`203.0.113.${(ipCounter+=1)%250}`;
  const headers={host:'randori.example.test','x-forwarded-proto':'https',cookie,'x-forwarded-for':address};
  if(origin!==null) headers.origin=origin;
  await handler({method,url,query:endpoint?{endpoint,...query}:query,body,headers,socket:{remoteAddress:address}},res);
  return res;
}

function exportRequest(options={}){
  return invoke({endpoint:'account-export',url:'/api/auth/account/export',...options});
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
  const {directory,url}=await createMigratedDatabase({prefix:'randori-data-export-api-'});
  const db=createClient({url});
  resources.push(async()=>{ db.close(); rmSync(directory,{recursive:true,force:true}); });
  await prepareMigrationConnection(db);
  Object.assign(process.env,{
    NODE_ENV:'production',APP_URL:ORIGIN,GOOGLE_CLIENT_ID:'client',GOOGLE_CLIENT_SECRET:'secret',
    JWT_SECRET:'data-export-api-secret-at-least-32-bytes',TURSO_DATABASE_URL:url,CIRCLE_MEMBERSHIP_ENABLED:'true',
  });
  delete process.env.TURSO_AUTH_TOKEN;
  if(enabled) process.env.DATA_EXPORT_ENABLED='true';
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
    `INSERT INTO pair_messages (week_id,pair_group_id,sender_id,message) VALUES (10,1,2,'my message'),(10,1,3,'partner message')`,
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

test('with the flag off the endpoint answers exactly like an unknown one and is not advertised',async()=>{
  await fixture({enabled:false});
  const cookie=await signedIn();
  const unknown=await invoke({endpoint:'account-unknown',cookie});
  const expected={...unknown.body,error:`unknown auth endpoint 'account-export'`};
  assert.deepEqual([(await exportRequest({cookie})).statusCode,(await exportRequest({cookie})).body],[404,expected]);
  const bare=await invoke({url:'/api/auth/account/export',cookie});
  assert.deepEqual([bare.statusCode,bare.body],[404,{...unknown.body,error:`unknown auth endpoint 'export'`}]);
  const capabilities=await invoke({endpoint:'capabilities'});
  assert.equal('dataExport' in capabilities.body.capabilities,false);
  process.env.DATA_EXPORT_ENABLED='true';
  assert.equal((await invoke({endpoint:'capabilities'})).body.capabilities.dataExport,true);
});

test('only the signed-in member exports themselves, as a JSON attachment',async()=>{
  await fixture();
  assert.equal((await exportRequest()).statusCode,401);
  const cookie=await signedIn();
  const res=await exportRequest({cookie});
  assert.equal(res.statusCode,200,JSON.stringify(res.body));
  assert.equal(res.getHeader('content-disposition'),'attachment; filename="randori-circle-data-export.json"');
  assert.equal(res.body.account.email,'member@example.test');
  assert.deepEqual(res.body.messages.map(row=>row.message),['my message']);
  assert.deepEqual(res.body.pairings.primary[0].partners,['Partner']);
  assert.ok(!JSON.stringify(res.body).includes('partner message'));
  assert.ok(!JSON.stringify(res.body).includes('member-google-sub'));

  const partnerCookie=await signedIn('partner@example.test');
  const partner=await exportRequest({cookie:partnerCookie});
  assert.equal(partner.statusCode,200);
  assert.equal(partner.body.account.email,'partner@example.test');
  assert.deepEqual(partner.body.messages.map(row=>row.message),['partner message']);
  assert.ok(!JSON.stringify(partner.body).includes('my message'));
});

test('without recent authentication the export is refused, and POST is refused',async()=>{
  const db=await fixture();
  const cookie=await signedIn();
  await db.execute(`UPDATE auth_recent_proofs SET authenticated_at=authenticated_at-3600`);
  const stale=await exportRequest({cookie});
  assert.deepEqual([stale.statusCode,stale.body],[403,{error:'recent authentication required',code:'recent_auth_required'}]);
  const post=await exportRequest({cookie,method:'POST',body:{}});
  assert.deepEqual([post.statusCode,post.body],[405,{error:'GET only'}]);
  assert.equal(post.getHeader('allow'),'GET');
});

test('the rate limit is five exports per account per fifteen minutes',async()=>{
  await fixture();
  const cookie=await signedIn();
  for(let attempt=0;attempt<5;attempt+=1){
    const res=await exportRequest({cookie});
    assert.equal(res.statusCode,200,`attempt ${attempt+1}`);
  }
  const limited=await exportRequest({cookie});
  assert.deepEqual([limited.statusCode,limited.body],[429,{error:'too many attempts; try again later'}]);
});

test('an archive over the size bound is refused with 413',async()=>{
  const db=await fixture();
  const big='x'.repeat(300_000);
  await db.batch(Array.from({length:20},()=>({sql:
    `INSERT INTO session_runs (user_id,question_slug,language,code) VALUES (2,'big','javascript',?)`,args:[big]})),'write');
  const cookie=await signedIn();
  const res=await exportRequest({cookie});
  assert.deepEqual([res.statusCode,res.body],[413,{error:'data export is too large',code:'export_too_large'}]);
});

test('the vercel rewrite routes /api/auth/account/export to the export endpoint',()=>{
  const config=JSON.parse(readFileSync('vercel.json','utf8'));
  assert.deepEqual(config.rewrites.find(item=>item.source==='/api/auth/account/export'),
    {source:'/api/auth/account/export',destination:'/api/auth?endpoint=account-export'});
});
