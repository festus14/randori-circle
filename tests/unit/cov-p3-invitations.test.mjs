import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, mock, test } from 'node:test';

import { createClient } from '@libsql/client';

import { prepareMigrationConnection } from '../../db/migration-runner.js';
import { copyMigratedDatabase } from '../support/migrated-db.mjs';
import { adoptCredentialKeyControl } from '../support/credential-key-control.mjs';

const SECRET='cov-p3-invitations-secret-at-least-thirty-two-bytes';
const SESSION_HASH='a'.repeat(64);
let currentDb=null;
const captured=[];

function authPayload(req){
  const identity=req?.headers?.['x-test-auth'];
  if(identity==='owner') return {id:1,email:'owner@example.test',sessionHash:SESSION_HASH};
  if(identity==='owner-uid') return {uid:1,email:'owner@example.test',sessionHash:SESSION_HASH};
  if(identity==='member') return {id:2,email:'member@example.test',sessionHash:'b'.repeat(64)};
  if(identity==='bogus') return {id:'1'};
  return null;
}

mock.module('../../api/_db.js',{
  exports:{
    captureSentryException:(error,context)=>{ captured.push(context?.tags?.event); return null; },
    captureSentryMessage:()=>null,
    getAdminEmails:()=>new Set(),
    getClient:()=>{ if(currentDb instanceof Error) throw currentDb; return currentDb; },
    getJwtSecret:()=>SECRET,
    initSentry:()=>{},
    isSentryConfigured:()=>false,
    verifyMutationOrigin:req=>req?.headers?.['x-test-cross']!=='1',
    verifyRequestAuth:authPayload,
    verifySignedRequestAuth:authPayload,
    issueSessionInTransaction:async()=>{ throw new Error('unused'); },
    revokeAccountSessions:async()=>{ throw new Error('unused'); },
  },
});

const { default:handler }=await import('../../api/invitations.js');
const membership=await import('../../api/_circle-membership.js');
const invitationEmail=await import('../../api/_invitation-email.js');

const ENV_KEYS=['APP_URL','CIRCLE_MEMBERSHIP_ENABLED','MULTI_CIRCLE_CONTROL_PLANE_ENABLED','NODE_ENV',
  'INVITATION_EMAIL_DELIVERY_ENABLED','INVITATION_EMAIL_ENCRYPTION_KEY','INVITATION_EMAIL_ENCRYPTION_KEY_VERSION',
  'INVITATION_EMAIL_ENVELOPE_WRITE_VERSION','RESEND_API_KEY','RESEND_FROM','TURSO_DATABASE_URL',
  'OUTBOX_IMMEDIATE_DELIVERY','VERCEL'];
const saved=Object.fromEntries(ENV_KEYS.map(key=>[key,process.env[key]]));
const directories=[];
const ORIGIN={origin:'https://randori.example.test',host:'randori.example.test'};
const OWNER={...ORIGIN,'x-test-auth':'owner'};

beforeEach(()=>{
  for(const key of ENV_KEYS) delete process.env[key];
  process.env.CIRCLE_MEMBERSHIP_ENABLED='true';
  process.env.NODE_ENV='production';
  process.env.APP_URL='https://randori.example.test';
  captured.length=0;
});

afterEach(()=>{
  for(const key of ENV_KEYS){
    if(saved[key]===undefined) delete process.env[key];
    else process.env[key]=saved[key];
  }
  if(currentDb&&!(currentDb instanceof Error)) try{ currentDb.close?.(); }catch{}
  currentDb=null;
  while(directories.length) rmSync(directories.pop(),{recursive:true,force:true});
});

function enableEmail(){
  process.env.RESEND_API_KEY='re_invitation_test';
  process.env.RESEND_FROM='Randori <invite@randori.example.test>';
  process.env.INVITATION_EMAIL_DELIVERY_ENABLED='true';
  process.env.INVITATION_EMAIL_ENCRYPTION_KEY=Buffer.alloc(32,9).toString('base64url');
}

async function database(){
  const directory=mkdtempSync(join(tmpdir(),'randori-cov-invitations-'));
  directories.push(directory);
  await copyMigratedDatabase(join(directory,'invitations.sqlite'));
  const db=createClient({url:`file:${join(directory,'invitations.sqlite')}`});
  await prepareMigrationConnection(db);
  await db.batch([
    `INSERT INTO auth_accounts (id,email,password_hash,display_name,color,is_admin,is_demo)
      VALUES (1,'owner@example.test','!o','Owner','#111111',1,0),(2,'member@example.test','!m','Member','#222222',0,0)`,
    `INSERT INTO circles (id,public_id,slug,name,is_primary,created_by,created_at)
      VALUES (10,'11111111-1111-4111-8111-111111111111','randori-circle','Primary',1,1,datetime('now'))`,
    `INSERT INTO circle_memberships (circle_id,user_id,role,status,joined_at,updated_at)
      VALUES (10,1,'owner','active',datetime('now'),datetime('now')),(10,2,'member','active',datetime('now'),datetime('now'))`,
    {sql:`INSERT INTO auth_sessions (session_hash,user_id,created_at,expires_at)
      VALUES (?,1,strftime('%s','now'),strftime('%s','now')+3600),(?,2,strftime('%s','now'),strftime('%s','now')+3600)`,
    args:[SESSION_HASH,'b'.repeat(64)]},
  ],'write');
  return db;
}

// Wraps a real client so specific statements can fail or be rewritten.
function faulty(db,{execute=null,transactionExecute=null,onTransaction=null,commit=null}={}){
  return {
    execute:statement=>execute?.(statement,()=>db.execute(statement))??db.execute(statement),
    batch:(...args)=>db.batch(...args),
    close:()=>db.close(),
    async transaction(mode){
      if(onTransaction) await onTransaction(db);
      const tx=await db.transaction(mode);
      return {
        execute:statement=>transactionExecute?.(statement,()=>tx.execute(statement))??tx.execute(statement),
        rollback:()=>tx.rollback(),
        commit:()=>commit?commit(tx):tx.commit(),
        close:()=>tx.close(),
      };
    },
  };
}

const sqlOf=statement=>String(statement?.sql||statement);

function invoke({method='GET',url='/api/invitations',query={endpoint:'invitations'},headers={},body}={}){
  return new Promise((resolve,reject)=>{
    let statusCode=200;
    let settled=false;
    const responseHeaders={};
    const finish=payload=>{
      if(settled) return;
      settled=true;
      resolve({status:statusCode,headers:responseHeaders,body:payload});
    };
    const res={
      status(code){ statusCode=code; return this; },
      json(payload){ finish(payload); return this; },
      setHeader(name,value){ responseHeaders[String(name).toLowerCase()]=value; },
      end(payload){ finish(payload); },
    };
    const req={method,url,query,headers,body,socket:{remoteAddress:'127.0.0.1'}};
    Promise.resolve(handler(req,res)).then(()=>finish(undefined)).catch(reject);
  });
}

async function createInvitation(body={email:'invitee@example.test'},headers=OWNER){
  return invoke({method:'POST',headers,body});
}

test('routing rejects disabled membership, unknown endpoints, duplicate or extra query keys, and bad methods',async()=>{
  currentDb=await database();
  delete process.env.CIRCLE_MEMBERSHIP_ENABLED;
  assert.equal((await invoke({headers:OWNER})).status,404);
  process.env.CIRCLE_MEMBERSHIP_ENABLED='true';

  const listed=await invoke({headers:OWNER});
  assert.equal(listed.status,200);
  assert.equal(listed.headers['cache-control'],'private, no-store');

  assert.equal((await invoke({query:{endpoint:'other'},headers:OWNER})).status,400);
  assert.equal((await invoke({query:{endpoint:['invitations','prepare']},headers:OWNER})).status,400,
    'array endpoint is ambiguous');
  assert.equal((await invoke({query:{},url:'/api/invitations?endpoint=invitations&endpoint=prepare',headers:OWNER})).status,400);
  assert.equal((await invoke({query:{endpoint:'invitations',extra:'1'},headers:OWNER})).status,400);
  assert.equal((await invoke({query:{endpoint:'invitations',list:['a']},headers:OWNER})).status,400);
  assert.equal((await invoke({query:{endpoint:'invitations'},url:'/api/invitations?x=1&x=2',headers:OWNER})).status,400);
  assert.equal((await invoke({query:{endpoint:'invitations'},url:'http://[bad',headers:OWNER})).status,400,
    'an unparsable URL fails closed');
  assert.equal((await invoke({method:'POST',query:{endpoint:'invitations',extra:'1'},headers:OWNER,
    body:{email:'a@example.test'}})).status,400);
  assert.equal((await invoke({method:'DELETE',query:{endpoint:'invitations',zzz:'1'},headers:OWNER})).status,400);
  assert.equal((await invoke({method:'POST',url:'/api/invitations/prepare',query:{endpoint:'prepare',x:'1'},
    headers:ORIGIN,body:{token:'x'}})).status,400);
  const patched=await invoke({method:'PATCH',headers:OWNER});
  assert.equal(patched.status,405);
  assert.equal(patched.headers.allow,'GET, POST, DELETE');
  assert.equal((await invoke({method:'POST',headers:{...OWNER,'x-test-cross':'1'},body:{email:'a@example.test'}})).status,403);

  // Path-based routing without explicit query parameters.
  const prepareByPath=await invoke({method:'GET',url:'/api/invitations/prepare/',query:{},headers:ORIGIN});
  assert.equal(prepareByPath.status,405);
  assert.equal(prepareByPath.headers.allow,'POST');
});

test('owner context: authentication, storage failure, membership role, and uid payloads',async()=>{
  currentDb=await database();
  assert.equal((await invoke({headers:{}})).status,401);
  assert.equal((await invoke({headers:{'x-test-auth':'bogus'}})).status,401,'string ids are not trusted');
  assert.equal((await invoke({headers:{'x-test-auth':'member'}})).status,403);
  assert.equal((await invoke({headers:{'x-test-auth':'owner-uid'}})).status,200,'uid payloads are accepted');

  const real=currentDb;
  currentDb=new Error('client unavailable');
  const unavailable=await invoke({headers:OWNER});
  assert.deepEqual([unavailable.status,unavailable.body],[503,{error:'invitations unavailable'}]);
  assert.ok(captured.includes('circle_invitation_owner_check_fail'));
  currentDb=real;

  await real.execute(`UPDATE circles SET archived_at=datetime('now') WHERE id=10`);
  assert.equal((await invoke({headers:OWNER})).status,403,'archived primary circle has no owner');
});

test('multi-circle owner context requires a selection, owner role, and a current context version',async()=>{
  currentDb=await database();
  process.env.MULTI_CIRCLE_CONTROL_PLANE_ENABLED='true';
  const implicit=await invoke({headers:OWNER});
  assert.equal(implicit.status,200);
  assert.equal(implicit.body.circle_context_version,0);
  assert.equal((await invoke({headers:{'x-test-auth':'member'}})).status,403,'member role is not owner');

  await currentDb.batch([
    `INSERT INTO circles (id,public_id,slug,name,is_primary,created_by,created_at)
      VALUES (20,'33333333-3333-4333-8333-333333333333','second','Second',0,1,datetime('now'))`,
    `INSERT INTO circle_memberships (circle_id,user_id,role,status,joined_at,updated_at)
      VALUES (20,1,'owner','active',datetime('now'),datetime('now'))`,
  ],'write');
  const ambiguous=await invoke({headers:OWNER});
  assert.deepEqual([ambiguous.status,ambiguous.body.code],[409,'active_circle_required']);

  await currentDb.execute({sql:`INSERT INTO auth_session_circle_contexts (session_hash,user_id,circle_id,context_version,updated_at)
    VALUES (?,1,20,3,strftime('%s','now'))`,args:[SESSION_HASH]});
  const stale=await invoke({headers:{...OWNER,'x-randori-circle-context-version':'2'}});
  assert.deepEqual([stale.status,stale.body.code],[409,'circle_context_changed']);
  const current=await invoke({headers:{...OWNER,'x-randori-circle-context-version':'3'}});
  assert.equal(current.status,200);
  assert.equal(current.body.circle_context_version,3);

  const created=await createInvitation({email:'second@example.test'},{...OWNER,'x-randori-circle-context-version':'3'});
  assert.equal(created.status,201);
  assert.equal(created.body.circle_context_version,3);
  const row=(await currentDb.execute({sql:'SELECT circle_id FROM circle_invitations WHERE id=?',
    args:[created.body.invitation.id]})).rows[0];
  assert.equal(Number(row.circle_id),20,'creation is scoped to the selected circle');

  // The context changes between the authorization read and the write transaction.
  const real=currentDb;
  currentDb=faulty(real,{onTransaction:db=>db.execute({sql:`UPDATE auth_session_circle_contexts
    SET context_version=context_version+1 WHERE session_hash=?`,args:[SESSION_HASH]})});
  const raced=await createInvitation({email:'raced@example.test'},{...OWNER,'x-randori-circle-context-version':'3'});
  assert.deepEqual([raced.status,raced.body.code],[409,'circle_context_changed']);
  const revokeRaced=await invoke({method:'DELETE',url:`/api/invitations/${created.body.invitation.id}`,
    query:{endpoint:'invitations',id:created.body.invitation.id},headers:{...OWNER,'x-randori-circle-context-version':'4'}});
  assert.deepEqual([revokeRaced.status,revokeRaced.body.code],[409,'circle_context_changed']);
  currentDb=real;
  const revoked=await invoke({method:'DELETE',url:`/api/invitations/${created.body.invitation.id}`,
    query:{endpoint:'invitations',id:created.body.invitation.id},headers:{...OWNER,'x-randori-circle-context-version':'5'}});
  assert.deepEqual(revoked.body,{ok:true,id:created.body.invitation.id,status:'revoked',circle_context_version:5});
});

test('create validates the body and fails closed on missing writes, audit, and email intent',async()=>{
  currentDb=await database();
  assert.equal((await createInvitation({email:'a@example.test',extra:1})).status,400);
  assert.equal((await createInvitation({email:'not-an-email'})).status,400);
  assert.equal((await createInvitation(null)).status,400);

  const real=currentDb;
  currentDb=faulty(real,{transactionExecute:(statement,run)=>sqlOf(statement).includes('INSERT INTO circle_invitations')
    ?Promise.resolve({rows:[]}):null});
  assert.equal((await createInvitation()).status,403,'an ownership race inside the transaction is a 403');
  currentDb=faulty(real,{transactionExecute:(statement)=>sqlOf(statement).includes('INSERT INTO circle_audit_events')
    ?Promise.resolve({rows:[]}):null});
  const noAudit=await createInvitation();
  assert.equal(noAudit.status,503);
  assert.ok(captured.includes('circle_invitation_create_fail'));
  assert.equal(Number((await real.execute('SELECT COUNT(*) AS n FROM circle_invitations')).rows[0].n),0,
    'a missing audit rolls the invitation back');

  enableEmail();
  await adoptCredentialKeyControl(real,invitationEmail.invitationKeyRing());
  currentDb=faulty(real,{transactionExecute:(statement)=>sqlOf(statement).includes('INSERT INTO outbox_events')
    ?Promise.resolve({rowsAffected:0}):null});
  assert.equal((await createInvitation()).status,503,'a dropped email intent aborts creation');
  assert.equal(Number((await real.execute('SELECT COUNT(*) AS n FROM circle_invitations')).rows[0].n),0);

  currentDb=faulty(real,{commit:()=>Promise.reject(new Error('commit failed'))});
  assert.equal((await createInvitation()).status,503);
  currentDb=real;
  const created=await createInvitation();
  assert.equal(created.status,201);
  assert.deepEqual(created.body.email_delivery,{queued:true});
});

test('create falls back to manual links when the credential key control is not adopted',async()=>{
  currentDb=await database();
  enableEmail();
  const created=await createInvitation();
  assert.equal(created.status,201);
  assert.deepEqual(created.body.email_delivery,{queued:false});
  assert.equal(Number((await currentDb.execute('SELECT COUNT(*) AS n FROM outbox_events')).rows[0].n),0);

  const real=currentDb;
  currentDb=faulty(real,{execute:(statement)=>sqlOf(statement).includes('FROM outbox_events LIMIT 0')
    ?Promise.reject(new Error('no such table: outbox_events')):null});
  assert.equal((await createInvitation()).status,503,'other readiness errors are not downgraded');
});

async function emailFixture(){
  currentDb=await database();
  enableEmail();
  await adoptCredentialKeyControl(currentDb,invitationEmail.invitationKeyRing());
  const created=await createInvitation();
  assert.equal(created.status,201);
  const id=created.body.invitation.id;
  await currentDb.execute(`UPDATE outbox_events SET created_at=strftime('%Y-%m-%dT%H:%M:%fZ','now','-2 minutes')`);
  return {id,token:created.body.invitation.invite_url.split('=')[1]};
}

function resend(id,{headers=OWNER,body={action:'resend'},url=`/api/invitations/${id}`,query={endpoint:'invitations',id}}={}){
  return invoke({method:'POST',url,query,headers,body});
}

test('resend validates the action, target, delivery gate, and pending state',async()=>{
  const {id}=await emailFixture();
  assert.equal((await resend(id,{body:{action:'nope'}})).status,400);
  assert.equal((await resend(id,{body:{action:'resend',x:1}})).status,400);
  const badId=await resend('x',{url:'/api/invitations/not-a-uuid',query:{endpoint:'invitations'}});
  assert.equal(badId.status,404,'path target that is not a uuid');
  assert.equal((await resend('33333333-3333-4333-8333-333333333333')).status,404,'unknown invitation');

  // Path-only target routes to resend.
  const byPath=await resend(id,{query:{}});
  assert.equal(byPath.status,200);
  assert.deepEqual(byPath.body.email_delivery,{queued:true});
  const rotated=byPath.body.invitation.invite_url.split('=')[1];
  assert.equal((await currentDb.execute({sql:'SELECT token_hash FROM circle_invitations WHERE id=?',args:[id]})).rows[0].token_hash,
    membership.hashInvitationToken(rotated));

  const limited=await resend(id);
  assert.equal(limited.status,429);
  assert.ok(Number(limited.headers['retry-after'])>=1&&Number(limited.headers['retry-after'])<=60);

  for(const [mutation,label] of [
    [`UPDATE circle_invitations SET revoked_at=datetime('now')`,'revoked'],
  ]){
    await currentDb.execute(mutation);
    const blocked=await resend(id);
    assert.deepEqual([blocked.status,blocked.body.error],[409,'invitation is no longer pending'],label);
  }

  delete process.env.INVITATION_EMAIL_DELIVERY_ENABLED;
  const gated=await resend(id);
  assert.equal(gated.status,409);
  assert.match(gated.body.error,/delivery unavailable/);
});

test('resend refuses expired, exhausted, corrupt, and undated history without rotating',async()=>{
  const {id}=await emailFixture();
  const tokenHash=async()=>(await currentDb.execute({sql:'SELECT token_hash FROM circle_invitations WHERE id=?',args:[id]})).rows[0].token_hash;
  const before=await tokenHash();
  const expectRefusal=async(label,pattern=/cannot be resent/)=>{
    const response=await resend(id);
    assert.equal(response.status,409,label);
    assert.match(response.body.error,pattern,label);
    assert.equal(await tokenHash(),before,`${label} does not rotate`);
  };

  await currentDb.execute(`UPDATE circle_invitations SET expires_at=strftime('%Y-%m-%dT%H:%M:%fZ','now','-1 second')`);
  await expectRefusal('expired',/no longer pending/);
  await currentDb.execute(`UPDATE circle_invitations SET expires_at='not a date'`);
  await expectRefusal('unparsable expiry',/no longer pending/);
  await currentDb.execute(`UPDATE circle_invitations SET expires_at=strftime('%Y-%m-%dT%H:%M:%fZ','now','+1 day')`);

  const payload=(await currentDb.execute('SELECT payload_json FROM outbox_events')).rows[0].payload_json;
  await currentDb.execute({sql:'UPDATE outbox_events SET payload_json=?',args:[JSON.stringify({invitation_id:id})]});
  await expectRefusal('payload missing credential');
  await currentDb.execute({sql:'UPDATE outbox_events SET payload_json=?',args:[payload]});

  await currentDb.execute(`UPDATE outbox_events SET event_version=2`);
  await expectRefusal('unsupported latest version');
  await currentDb.execute(`UPDATE outbox_events SET event_version=1`);

  await currentDb.execute(`UPDATE circle_invitations SET email_hash='${'e'.repeat(64)}'`);
  await expectRefusal('email hash drift');
  await currentDb.execute({sql:'UPDATE circle_invitations SET email_hash=? WHERE id=?',
    args:[membership.hashInvitationEmail('invitee@example.test'),id]});

  await currentDb.execute(`UPDATE outbox_events SET created_at='garbage'`);
  await expectRefusal('undated last send');

  // Five sends exhaust the resend budget.
  await currentDb.execute(`UPDATE outbox_events SET created_at=strftime('%Y-%m-%dT%H:%M:%fZ','now','-2 minutes')`);
  for(let sequence=2;sequence<=5;sequence+=1){
    await currentDb.execute({sql:`INSERT INTO outbox_events (event_type,event_version,idempotency_key,payload_json,status,
        not_before,next_attempt_at,attempt_count,max_attempts,delivery_timeout_ms,created_at,updated_at)
      SELECT event_type,event_version,?,payload_json,'delivered',not_before,next_attempt_at,0,5,10000,created_at,updated_at
      FROM outbox_events ORDER BY id LIMIT 1`,args:[`invitation-email/v1/${id}/${sequence}`]});
  }
  await expectRefusal('exhausted');
});

test('resend aborts atomically when rotation, intent, audit, or commit fail',async()=>{
  const {id}=await emailFixture();
  const real=currentDb;
  const before=(await real.execute('SELECT token_hash FROM circle_invitations')).rows[0].token_hash;
  for(const [needle,result,label] of [
    ['UPDATE circle_invitations SET token_hash',{rows:[]},'rotation lost authorization'],
    ['INSERT INTO outbox_events',{rowsAffected:0},'intent missing'],
    ["'invitation.resent'",{rows:[]},'audit missing'],
  ]){
    currentDb=faulty(real,{transactionExecute:(statement)=>sqlOf(statement).includes(needle)?Promise.resolve(result):null});
    const response=await resend(id);
    assert.equal(response.status,503,label);
    assert.equal((await real.execute('SELECT token_hash FROM circle_invitations')).rows[0].token_hash,before,label);
  }
  assert.ok(captured.includes('circle_invitation_resend_fail'));
  process.env.MULTI_CIRCLE_CONTROL_PLANE_ENABLED='true';
  currentDb=faulty(real,{onTransaction:db=>db.batch([
    `INSERT INTO circles (id,public_id,slug,name,is_primary,created_by,created_at)
      VALUES (30,'44444444-4444-4444-8444-444444444444','third','Third',0,1,datetime('now'))`,
    `INSERT INTO circle_memberships (circle_id,user_id,role,status,joined_at,updated_at)
      VALUES (30,1,'member','active',datetime('now'),datetime('now'))`,
  ],'write')});
  const raced=await resend(id);
  assert.deepEqual([raced.status,raced.body.code],[409,'circle_context_changed'],
    'a second membership invalidates the implicit context during resend');
  assert.equal((await real.execute('SELECT token_hash FROM circle_invitations')).rows[0].token_hash,before);
});

test('list reports derived statuses, hides raw values, and fails closed',async()=>{
  currentDb=await database();
  const ids=[];
  for(const email of ['a@example.test','b@example.test','c@example.test','d@example.test']){
    ids.push((await createInvitation({email})).body.invitation.id);
  }
  await currentDb.batch([
    {sql:`UPDATE circle_invitations SET revoked_at=datetime('now') WHERE id=?`,args:[ids[0]]},
    {sql:`UPDATE circle_invitations SET used_by=2 WHERE id=?`,args:[ids[1]]},
    {sql:`UPDATE circle_invitations SET expires_at='garbage' WHERE id=?`,args:[ids[2]]},
  ],'write');
  const listed=await invoke({headers:OWNER});
  const statuses=Object.fromEntries(listed.body.invitations.map(item=>[item.id,item.status]));
  assert.deepEqual(statuses,{[ids[0]]:'revoked',[ids[1]]:'used',[ids[2]]:'expired',[ids[3]]:'pending'});
  assert.equal(listed.body.count,4);
  assert.ok(listed.body.invitations.every(item=>item.email_fingerprint.length===12));
  assert.deepEqual(listed.body.invitations.map(item=>item.email_rejected),
    listed.body.invitations.map(item=>item.status==='pending'?false:undefined));

  const real=currentDb;
  currentDb=faulty(real,{execute:(statement)=>sqlOf(statement).includes('WITH owner AS')?Promise.resolve({rows:[]}):null});
  assert.equal((await invoke({headers:OWNER})).status,403);
  currentDb=faulty(real,{execute:(statement)=>sqlOf(statement).includes('WITH owner AS')?Promise.reject(new Error('boom')):null});
  assert.equal((await invoke({headers:OWNER})).status,503);
  assert.ok(captured.includes('circle_invitation_list_fail'));
});

test('list flags pending invitations whose latest email the provider rejected, without provider detail',async()=>{
  enableEmail();
  currentDb=await database();
  await adoptCredentialKeyControl(currentDb,invitationEmail.invitationKeyRing());
  const rejectedId=(await createInvitation({email:'rejected@example.test'})).body.invitation.id;
  const okId=(await createInvitation({email:'fine@example.test'})).body.invitation.id;
  const revokedId=(await createInvitation({email:'gone@example.test'})).body.invitation.id;
  const markRejected=id=>currentDb.execute({sql:`UPDATE outbox_events SET status='dead_letter',
      last_error_code='PROVIDER_REJECTED',dead_lettered_at=strftime('%Y-%m-%dT%H:%M:%fZ','now'),
      lease_owner=NULL,lease_token=NULL,leased_until=NULL
    WHERE json_extract(payload_json,'$.invitation_id')=?`,args:[id]});
  await markRejected(rejectedId);
  await markRejected(revokedId);
  await currentDb.execute({sql:`UPDATE outbox_events SET status='dead_letter',last_error_code='PROVIDER_UNAVAILABLE',
      lease_owner=NULL,lease_token=NULL,leased_until=NULL
    WHERE json_extract(payload_json,'$.invitation_id')=?`,args:[okId]});
  await currentDb.execute({sql:`UPDATE circle_invitations SET revoked_at=datetime('now') WHERE id=?`,args:[revokedId]});
  const flags=async()=>Object.fromEntries((await invoke({headers:OWNER})).body.invitations
    .map(item=>[item.id,item.email_rejected]));
  const listed=await invoke({headers:OWNER});
  assert.equal(listed.status,200);
  assert.deepEqual(await flags(),{[rejectedId]:true,[okId]:false,[revokedId]:undefined});
  assert.doesNotMatch(JSON.stringify(listed.body),/PROVIDER_|validation_error|@example\.test/);

  // A newer send (resend) for the same invitation clears the hint.
  await currentDb.execute({sql:`INSERT INTO outbox_events (event_type,event_version,idempotency_key,payload_json,
      status,not_before,next_attempt_at)
    SELECT event_type,event_version,?,payload_json,'pending',not_before,next_attempt_at
    FROM outbox_events WHERE json_extract(payload_json,'$.invitation_id')=? ORDER BY id LIMIT 1`,
  args:[`invitation-email/v1/${rejectedId}/2`,rejectedId]});
  assert.equal((await flags())[rejectedId],false);

  // An outbox read failure only hides the hint; the list still answers.
  const real=currentDb;
  currentDb=faulty(real,{execute:(statement)=>sqlOf(statement).includes("event.status='dead_letter'")
    ?Promise.reject(new Error('boom')):null});
  const degraded=await invoke({headers:OWNER});
  assert.equal(degraded.status,200);
  assert.ok(degraded.body.invitations.every(item=>item.email_rejected!==true));
});

test('revoke requires a valid target and rolls back on audit or storage failure',async()=>{
  currentDb=await database();
  const id=(await createInvitation()).body.invitation.id;
  const revoke=(target,headers=OWNER)=>invoke({method:'DELETE',url:`/api/invitations/${target}`,
    query:{endpoint:'invitations',id:target},headers});
  assert.equal((await revoke('bad')).status,404);
  assert.equal((await revoke('33333333-3333-4333-8333-333333333333')).status,404,'unknown ids are indistinguishable');
  assert.equal((await revoke(id,{'x-test-auth':'member'})).status,403);

  const real=currentDb;
  currentDb=faulty(real,{transactionExecute:(statement)=>sqlOf(statement).includes("'invitation.revoked'")
    ?Promise.resolve({rows:[]}):null});
  assert.equal((await revoke(id)).status,503,'missing revocation audit');
  assert.equal((await real.execute('SELECT revoked_at FROM circle_invitations')).rows[0].revoked_at,null);
  currentDb=faulty(real,{transactionExecute:(statement)=>sqlOf(statement).includes('SET revoked_at')
    ?Promise.reject(new Error('locked')):null});
  assert.equal((await revoke(id)).status,503);
  assert.ok(captured.includes('circle_invitation_revoke_fail'));
  currentDb=real;
  assert.equal((await revoke(id)).status,200);
  assert.equal((await revoke(id)).status,404,'a second revoke is not found');
});

test('public prepare is same-origin, enumeration-safe, rate limited, and binding checked',async()=>{
  currentDb=await database();
  const created=await createInvitation();
  const token=created.body.invitation.invite_url.split('=')[1];
  const prepare=(body,headers=ORIGIN)=>invoke({method:'POST',url:'/api/invitations/prepare',query:{endpoint:'prepare'},
    headers,body});

  assert.equal((await prepare({token},{origin:'https://evil.example',host:'randori.example.test'})).status,403);
  assert.equal((await prepare({token},{origin:'::bad',host:'randori.example.test'})).status,403);
  assert.equal((await prepare({token},{host:'randori.example.test'})).status,403);
  assert.equal((await prepare({token},{Origin:'https://randori.example.test','x-forwarded-host':'randori.example.test, proxy'})).status,
    200,'capitalized Origin and forwarded host are honoured');
  assert.equal((await prepare({token:'x',binding:'y'})).status,400);
  assert.equal((await prepare({token:7})).status,400);

  const unknown=await prepare({token:'x'.repeat(43)});
  const malformed=await prepare({token:'short'});
  assert.deepEqual([unknown.status,unknown.body],[400,{error:'invitation unavailable'}]);
  assert.deepEqual(malformed.body,unknown.body,'malformed and unknown tokens are indistinguishable');

  const prepared=await prepare({token});
  assert.equal(prepared.status,200);
  const cookie=prepared.headers['set-cookie'][1].split(';')[0];
  const bound=await prepare({binding:prepared.body.binding},{...ORIGIN,cookie});
  assert.equal(bound.status,200);
  assert.equal(bound.body.binding,prepared.body.binding);
  assert.ok(bound.body.expires_in_seconds>0&&bound.body.expires_in_seconds<=600);
  assert.equal((await prepare({binding:'Z'.repeat(43)},{...ORIGIN,cookie})).status,400,'wrong binding');
  assert.equal((await prepare({binding:prepared.body.binding})).status,400,'no cookie');
  await currentDb.execute(`UPDATE circle_invitations SET revoked_at=datetime('now')`);
  assert.equal((await prepare({binding:prepared.body.binding},{...ORIGIN,cookie})).status,400,'revoked after prepare');

  // Rate limiting is per forwarded client address.
  const client={...ORIGIN,'x-forwarded-for':'203.0.113.9, 10.0.0.1'};
  let last;
  for(let attempt=0;attempt<13;attempt+=1) last=await prepare({token:'x'.repeat(43)},client);
  assert.equal(last.status,429);
  assert.ok(Number(last.headers['retry-after'])>=1);
  assert.equal(last.body.retry_after_seconds,Number(last.headers['retry-after']));
  assert.equal((await prepare({token:'x'.repeat(43)},{...ORIGIN,'x-forwarded-for':'203.0.113.10'})).status,400,
    'another client is not limited');

  const real=currentDb;
  currentDb=faulty(real,{execute:(statement)=>sqlOf(statement).includes('INSERT INTO auth_rate_limits')
    ?Promise.resolve({rows:[{attempts:'x',expires_at:1}]}):null});
  const corrupt=await prepare({token});
  assert.equal(corrupt.status,503,'corrupt rate-limit state fails closed');
  assert.ok(captured.includes('circle_invitation_prepare_fail'));
});
