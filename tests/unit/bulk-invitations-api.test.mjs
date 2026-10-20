// Bulk owner invitations: POST /api/invitations with {emails:[...]} (ID-68).
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, mock, test } from 'node:test';

import { createClient } from '@libsql/client';

import { applyMigrations, inspectMigrationState, prepareMigrationConnection } from '../../db/migration-runner.js';
import { outboxStatementIdentity } from '../../api/_outbox-identity.js';
import { adoptCredentialKeyControl } from '../support/credential-key-control.mjs';

const SECRET='bulk-invitations-secret-at-least-thirty-two-bytes';
const SESSION_HASH='c'.repeat(64);
let currentDb=null;
const sentry=[];
const delivered=[];

function authPayload(req){
  const identity=req?.headers?.['x-test-auth'];
  if(identity==='owner') return {id:1,email:'owner@example.test',sessionHash:SESSION_HASH};
  if(identity==='member') return {id:2,email:'member@example.test',sessionHash:'d'.repeat(64)};
  return null;
}

mock.module('../../api/_db.js',{
  exports:{
    captureSentryException:(error,context)=>{ sentry.push({message:String(error?.message||error),context}); return null; },
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
mock.module('../../api/_outbox-immediate.js',{
  exports:{
    deliverCommittedOutboxEvents:(req,events)=>{ delivered.push(events); return Promise.resolve(null); },
    outboxEventsFromStatements:statements=>(statements||[]).map(outboxStatementIdentity).filter(Boolean),
  },
});

const { default:handler }=await import('../../api/invitations.js');
const membership=await import('../../api/_circle-membership.js');
const invitationEmail=await import('../../api/_invitation-email.js');
const quota=await import('../../api/_invitation-create.js');

const ENV_KEYS=['APP_URL','CIRCLE_MEMBERSHIP_ENABLED','MULTI_CIRCLE_CONTROL_PLANE_ENABLED','NODE_ENV',
  'INVITATION_EMAIL_DELIVERY_ENABLED','INVITATION_EMAIL_ENCRYPTION_KEY','INVITATION_EMAIL_ENCRYPTION_KEY_VERSION',
  'INVITATION_EMAIL_ENVELOPE_WRITE_VERSION','RESEND_API_KEY','RESEND_FROM','TURSO_DATABASE_URL'];
const saved=Object.fromEntries(ENV_KEYS.map(key=>[key,process.env[key]]));
const directories=[];
const ORIGIN={origin:'https://randori.example.test',host:'randori.example.test'};
const OWNER={...ORIGIN,'x-test-auth':'owner'};

beforeEach(()=>{
  for(const key of ENV_KEYS) delete process.env[key];
  process.env.CIRCLE_MEMBERSHIP_ENABLED='true';
  process.env.NODE_ENV='production';
  process.env.APP_URL='https://randori.example.test';
  sentry.length=0;
  delivered.length=0;
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
  process.env.INVITATION_EMAIL_ENCRYPTION_KEY=Buffer.alloc(32,7).toString('base64url');
}

async function database(){
  const directory=mkdtempSync(join(tmpdir(),'randori-bulk-invitations-'));
  directories.push(directory);
  const db=createClient({url:`file:${join(directory,'bulk.sqlite')}`});
  await prepareMigrationConnection(db);
  const initial=await inspectMigrationState(db);
  await applyMigrations(db,{expectedStateFingerprint:initial.stateFingerprint,
    retry:{maxAttempts:1,baseDelayMs:0,maxDelayMs:0}});
  await db.batch([
    `INSERT INTO auth_accounts (id,email,password_hash,display_name,color,is_admin,is_demo)
      VALUES (1,'owner@example.test','!o','Owner','#111111',1,0),(2,'member@example.test','!m','Member','#222222',0,0),
        (3,'former@example.test','!f','Former','#333333',0,0)`,
    `INSERT INTO circles (id,public_id,slug,name,is_primary,created_by,created_at)
      VALUES (10,'11111111-1111-4111-8111-111111111111','randori-circle','Primary',1,1,datetime('now'))`,
    `INSERT INTO circle_memberships (circle_id,user_id,role,status,joined_at,updated_at)
      VALUES (10,1,'owner','active',datetime('now'),datetime('now')),(10,2,'member','active',datetime('now'),datetime('now')),
        (10,3,'member','inactive',datetime('now'),datetime('now'))`,
    {sql:`INSERT INTO auth_sessions (session_hash,user_id,created_at,expires_at)
      VALUES (?,1,strftime('%s','now'),strftime('%s','now')+3600)`,args:[SESSION_HASH]},
  ],'write');
  return db;
}

function faulty(db,{transactionExecute=null,onTransaction=null,commit=null,execute=null}={}){
  let transactions=0;
  return {
    execute:statement=>execute?.(statement,()=>db.execute(statement))??db.execute(statement),
    batch:(...args)=>db.batch(...args),
    close:()=>db.close(),
    async transaction(mode){
      transactions+=1;
      const number=transactions;
      if(onTransaction) await onTransaction(db,number);
      const tx=await db.transaction(mode);
      return {
        execute:statement=>transactionExecute?.(statement,()=>tx.execute(statement),number)??tx.execute(statement),
        rollback:()=>tx.rollback(),
        commit:()=>commit?commit(tx,number):tx.commit(),
        close:()=>tx.close(),
      };
    },
  };
}

const sqlOf=statement=>String(statement?.sql||statement);
const count=async(sql,args=[])=>Number((await currentDb.execute({sql,args})).rows[0].n);

function invoke({method='POST',url='/api/invitations',query={endpoint:'invitations'},headers=OWNER,body}={}){
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

const bulk=(emails,headers=OWNER)=>invoke({headers,body:{emails}});

test('bulk create requires same-origin, authentication, the owner role, and a bounded list',async()=>{
  currentDb=await database();
  assert.equal((await bulk(['a@example.test'],{...OWNER,'x-test-cross':'1'})).status,403,'cross-origin');
  assert.equal((await bulk(['a@example.test'],ORIGIN)).status,401,'anonymous');
  const member=await bulk(['a@example.test'],{...ORIGIN,'x-test-auth':'member'});
  assert.deepEqual([member.status,member.body],[403,{error:'circle owner required'}]);

  for(const emails of [[],'a@example.test',null,{0:'a@example.test'}]){
    const response=await bulk(emails);
    assert.deepEqual([response.status,response.body.code],[400,'bulk_invite_invalid'],JSON.stringify(emails));
  }
  const tooMany=await bulk(Array.from({length:51},(_,index)=>`p${index}@example.test`));
  assert.deepEqual([tooMany.status,tooMany.body.code,tooMany.body.max],[400,'bulk_invite_too_many',50]);
  assert.equal((await invoke({body:{emails:['a@example.test'],email:'b@example.test'}})).status,400,
    'mixing the single and bulk contracts is rejected');
  assert.equal(await count('SELECT COUNT(*) AS n FROM circle_invitations'),0,'nothing was written');

  const fifty=await bulk(Array.from({length:50},(_,index)=>`p${index}@example.test`));
  assert.equal(fifty.status,200);
  assert.equal(fifty.body.summary.created,50,'exactly the maximum is accepted');
});

test('mixed lists return per-email results in input order and create through the shared writer',async()=>{
  currentDb=await database();
  const existing=await invoke({body:{email:'Pending@Example.test'}});
  assert.equal(existing.status,201);
  const input=['New.One@Example.test',' not-an-email ','member@example.test','NEW.ONE@example.test',
    'pending@example.test','former@example.test',42,'two@example.test','a..b@example.test'];
  const response=await bulk(input);
  assert.equal(response.status,200);
  assert.equal(response.headers['cache-control'],'private, no-store');
  const {results,summary}=response.body;
  assert.deepEqual(results.map(result=>[result.index,result.status,result.reason??null]),[
    [0,'created',null],[1,'invalid','missing_at'],[2,'already_member',null],[3,'duplicate_in_request',null],
    [4,'already_invited',null],[5,'already_member',null],[6,'invalid','invalid_type'],[7,'created',null],
    [8,'invalid','local_dots'],
  ]);
  assert.deepEqual(summary,{created:2,invalid:3,duplicate_in_request:1,already_member:2,already_invited:1,failed:0});
  assert.equal(results[3].duplicate_of,0);
  assert.equal(results[2].member_status,'active');
  assert.equal(results[5].member_status,'inactive');
  assert.deepEqual(results[4].invitation,{id:existing.body.invitation.id,status:'pending'},
    'an already-invited address points at the live invitation so the owner can resend');
  assert.equal(results[1].input,' not-an-email ');
  assert.equal(results[6].input,null);
  assert.equal(results[0].email,'new.one@example.test');

  // A created result carries the same invitation data as the single path.
  const created=results[0];
  assert.deepEqual(Object.keys(created.invitation).sort(),Object.keys(existing.body.invitation).sort());
  assert.match(created.invitation.invite_url,/^\/invite#invite=[A-Za-z0-9_-]{43}$/);
  assert.deepEqual([created.invitation.email,created.invitation.status,created.email_delivery],
    ['new.one@example.test','pending',{queued:false}]);
  const row=(await currentDb.execute({sql:'SELECT circle_id,email_hash,token_hash,created_by FROM circle_invitations WHERE id=?',
    args:[created.invitation.id]})).rows[0];
  assert.deepEqual([Number(row.circle_id),Number(row.created_by)],[10,1]);
  assert.equal(row.email_hash,membership.hashInvitationEmail('new.one@example.test'));
  assert.equal(row.token_hash,membership.hashInvitationToken(created.invitation.invite_url.split('=')[1]));
  assert.equal(await count(`SELECT COUNT(*) AS n FROM circle_audit_events WHERE event_type='invitation.created'`),3,
    'every created invitation has its audit row');
  assert.equal(await count('SELECT COUNT(*) AS n FROM circle_invitations'),3);
  assert.deepEqual(response.body.email_delivery,{queued:0});
  assert.equal(delivered.length,0,'no email events means no inline delivery is scheduled');
});

test('created invitations queue outbox email with the existing idempotency key and schedule inline delivery',async()=>{
  currentDb=await database();
  enableEmail();
  await adoptCredentialKeyControl(currentDb,invitationEmail.invitationKeyRing());
  const emails=Array.from({length:10},(_,index)=>`person${index}@example.test`);
  const response=await bulk(emails);
  assert.equal(response.status,200);
  assert.equal(response.body.summary.created,10);
  assert.deepEqual(response.body.email_delivery,{queued:10});
  assert.ok(response.body.results.every(result=>result.email_delivery.queued===true));
  const events=(await currentDb.execute(`SELECT event_type,idempotency_key,payload_json FROM outbox_events ORDER BY id`)).rows;
  assert.deepEqual(events.map(event=>event.idempotency_key),
    response.body.results.map(result=>`invitation-email/v1/${result.invitation.id}/1`));
  assert.ok(events.every(event=>event.event_type===invitationEmail.INVITATION_EMAIL_EVENT_TYPE));
  for(const [index,email] of emails.entries()){
    assert.ok(!String(events[index].payload_json).includes(email),'the outbox payload stores the address encrypted only');
  }
  assert.equal(delivered.length,1,'one bounded post-response attempt is scheduled');
  assert.deepEqual(delivered[0].map(event=>event.idempotencyKey),events.map(event=>event.idempotency_key),
    'all committed events are handed over; the helper applies its own per-request cap');
});

test('one failing address does not block the others and nothing about it reaches telemetry or logs',async()=>{
  currentDb=await database();
  const real=currentDb;
  const poisoned=membership.hashInvitationEmail('poison@example.test');
  currentDb=faulty(real,{transactionExecute:(statement)=>sqlOf(statement).includes('INSERT INTO circle_invitations')
    &&statement.args?.includes(poisoned)?Promise.reject(new Error('SQLITE_BUSY: database is locked')):null});
  const lines=[];
  const originals={};
  for(const level of ['log','info','warn','error']){
    originals[level]=console[level];
    console[level]=(...args)=>{ lines.push(args.map(String).join(' ')); };
  }
  let response;
  try{
    response=await bulk(['first@example.test','poison@example.test','last@example.test']);
  }finally{
    for(const level of Object.keys(originals)) console[level]=originals[level];
  }
  assert.equal(response.status,200);
  assert.deepEqual(response.body.results.map(result=>[result.status,result.reason??null]),
    [['created',null],['failed','unavailable'],['created',null]]);
  assert.equal(await count('SELECT COUNT(*) AS n FROM circle_invitations'),2);
  assert.equal(await count(`SELECT COUNT(*) AS n FROM circle_audit_events WHERE event_type='invitation.created'`),2,
    'the failed address left no audit row behind');
  assert.deepEqual(sentry.map(item=>item.context.tags.event),['circle_invitation_bulk_item_fail']);
  const telemetry=JSON.stringify([sentry,lines]);
  for(const email of ['first@example.test','poison@example.test','last@example.test']){
    assert.ok(!telemetry.includes(email),`${email} must not appear in logs or Sentry`);
  }
});

test('commit failures, ownership loss, and context changes are reported per email or for the request',async()=>{
  currentDb=await database();
  const real=currentDb;
  currentDb=faulty(real,{commit:(tx,number)=>number===2?Promise.reject(new Error('commit failed')):tx.commit()});
  const committed=await bulk(['c1@example.test','c2@example.test','c3@example.test']);
  assert.deepEqual(committed.body.results.map(result=>result.status),['created','failed','created']);

  currentDb=faulty(real,{transactionExecute:(statement)=>sqlOf(statement).includes('INSERT INTO circle_invitations')
    ?Promise.resolve({rows:[]}):null});
  const lost=await bulk(['o1@example.test','o2@example.test']);
  assert.deepEqual([lost.status,lost.body],[403,{error:'circle owner required'}],'nothing created: plain 403');

  currentDb=faulty(real,{transactionExecute:(statement,run,number)=>number===2
    &&sqlOf(statement).includes('INSERT INTO circle_invitations')?Promise.resolve({rows:[]}):null});
  const partial=await bulk(['p1@example.test','p2@example.test','p3@example.test']);
  assert.equal(partial.status,200);
  assert.deepEqual(partial.body.results.map(result=>[result.status,result.reason??null]),
    [['created',null],['failed','owner_required'],['failed','owner_required']],
    'once ownership is lost the rest of the batch is not attempted');

  process.env.MULTI_CIRCLE_CONTROL_PLANE_ENABLED='true';
  currentDb=faulty(real,{onTransaction:(db,number)=>number===2?db.batch([
    `INSERT INTO circles (id,public_id,slug,name,is_primary,created_by,created_at)
      VALUES (40,'55555555-5555-4555-8555-555555555555','other','Other',0,1,datetime('now'))`,
    `INSERT INTO circle_memberships (circle_id,user_id,role,status,joined_at,updated_at)
      VALUES (40,1,'member','active',datetime('now'),datetime('now'))`,
  ],'write'):null});
  const switched=await bulk(['s1@example.test','s2@example.test','s3@example.test']);
  assert.equal(switched.status,200);
  assert.deepEqual(switched.body.results.map(result=>[result.status,result.reason??null]),
    [['created',null],['failed','circle_context_changed'],['failed','circle_context_changed']]);
  assert.equal(switched.body.circle_context_version,0);

  await real.execute(`DELETE FROM circle_memberships WHERE circle_id=40`);
  currentDb=faulty(real,{onTransaction:db=>db.batch([
    `INSERT INTO circle_memberships (circle_id,user_id,role,status,joined_at,updated_at)
      VALUES (40,1,'member','active',datetime('now'),datetime('now'))`,
  ],'write')});
  const raced=await bulk(['r1@example.test']);
  assert.deepEqual([raced.status,raced.body.code],[409,'circle_context_changed'],'nothing created: plain 409');

  await real.execute(`DELETE FROM circle_memberships WHERE circle_id=40`);
  delete process.env.MULTI_CIRCLE_CONTROL_PLANE_ENABLED;
  currentDb=faulty(real,{execute:(statement)=>sqlOf(statement).includes('lower(account.email) IN')
    ?Promise.reject(new Error('storage offline')):null});
  const offline=await bulk(['x@example.test']);
  assert.deepEqual([offline.status,offline.body],[503,{error:'invitations unavailable'}]);
  assert.ok(sentry.some(item=>item.context.tags.event==='circle_invitation_bulk_fail'));
});

test('bulk invitations stay inside the selected circle',async()=>{
  currentDb=await database();
  process.env.MULTI_CIRCLE_CONTROL_PLANE_ENABLED='true';
  await currentDb.batch([
    `INSERT INTO circles (id,public_id,slug,name,is_primary,created_by,created_at)
      VALUES (20,'33333333-3333-4333-8333-333333333333','second','Second',0,1,datetime('now'))`,
    `INSERT INTO circle_memberships (circle_id,user_id,role,status,joined_at,updated_at)
      VALUES (20,1,'owner','active',datetime('now'),datetime('now'))`,
    {sql:`INSERT INTO auth_session_circle_contexts (session_hash,user_id,circle_id,context_version,updated_at)
      VALUES (?,1,10,1,strftime('%s','now'))`,args:[SESSION_HASH]},
  ],'write');
  const primary=await bulk(['shared@example.test'],{...OWNER,'x-randori-circle-context-version':'1'});
  assert.equal(primary.body.results[0].status,'created');

  await currentDb.execute({sql:`UPDATE auth_session_circle_contexts SET circle_id=20,context_version=2 WHERE session_hash=?`,
    args:[SESSION_HASH]});
  const stale=await bulk(['shared@example.test'],{...OWNER,'x-randori-circle-context-version':'1'});
  assert.deepEqual([stale.status,stale.body.code],[409,'circle_context_changed']);
  const second=await bulk(['shared@example.test','member@example.test'],{...OWNER,'x-randori-circle-context-version':'2'});
  assert.equal(second.status,200);
  assert.deepEqual(second.body.results.map(result=>result.status),['created','created'],
    'an invitation or membership in another circle does not count here');
  assert.equal(second.body.circle_context_version,2);
  const rows=(await currentDb.execute({sql:'SELECT circle_id FROM circle_invitations WHERE id IN (?,?)',
    args:second.body.results.map(result=>result.invitation.id)})).rows;
  assert.deepEqual(rows.map(row=>Number(row.circle_id)),[20,20]);
});

test('the daily per-circle quota rejects whole batches with Retry-After and also limits single invitations',async()=>{
  currentDb=await database();
  const reserved=await quota.reserveInvitationQuota(currentDb,{circleId:10,count:quota.INVITATION_CREATE_DAILY_LIMIT-2});
  assert.equal(reserved.ok,true);
  const state=await quota.invitationQuotaState(currentDb,{circleId:10});
  assert.equal(state.remaining,2);

  const over=await bulk(['q1@example.test','q2@example.test','q3@example.test','member@example.test']);
  assert.equal(over.status,429);
  assert.equal(over.body.code,'invitation_quota_exceeded');
  assert.equal(over.body.remaining,2);
  assert.equal(over.body.limit,200);
  const retryAfter=Number(over.headers['retry-after']);
  assert.ok(retryAfter>86000&&retryAfter<=86400,'retry after the fixed 24-hour window');
  assert.equal(over.body.retry_after_seconds,retryAfter);
  assert.equal(await count('SELECT COUNT(*) AS n FROM circle_invitations'),0,'a rejected batch creates nothing');

  const fits=await bulk(['q1@example.test','q2@example.test','member@example.test','bad']);
  assert.equal(fits.status,200,'members and invalid addresses do not use quota');
  assert.equal(fits.body.summary.created,2);
  const nothingNew=await bulk(['q1@example.test','member@example.test']);
  assert.equal(nothingNew.status,200,'a batch with nothing to create needs no quota');

  const single=await invoke({body:{email:'single@example.test'}});
  assert.equal(single.status,429);
  assert.equal(single.body.code,'invitation_quota_exceeded');
  assert.ok(Number(single.headers['retry-after'])>0);
  assert.equal(await count('SELECT COUNT(*) AS n FROM circle_invitations'),2);

  // The window is fixed: once it has passed the full quota returns.
  await currentDb.execute(`UPDATE auth_rate_limits SET expires_at=strftime('%s','now')-1`);
  assert.equal((await quota.invitationQuotaState(currentDb,{circleId:10})).remaining,200);
  const renewed=await invoke({body:{email:'single@example.test'}});
  assert.equal(renewed.status,201);
  assert.equal((await quota.invitationQuotaState(currentDb,{circleId:10})).remaining,199);
});

test('a quota race inside the batch stops further creation and a failed invitation refunds its reservation',async()=>{
  currentDb=await database();
  const real=currentDb;
  currentDb=faulty(real,{transactionExecute:(statement,run,number)=>number===2
    &&sqlOf(statement).includes('INSERT INTO auth_rate_limits')?Promise.resolve({rows:[]}):null});
  const raced=await bulk(['r1@example.test','r2@example.test','r3@example.test']);
  assert.equal(raced.status,200);
  assert.deepEqual(raced.body.results.map(result=>[result.status,result.reason??null]),
    [['created',null],['failed','rate_limited'],['failed','rate_limited']]);
  assert.ok(raced.body.results[1].retry_after_seconds>=1);

  currentDb=faulty(real,{transactionExecute:(statement)=>sqlOf(statement).includes('INSERT INTO auth_rate_limits')
    ?Promise.resolve({rows:[]}):null});
  const limited=await bulk(['l1@example.test']);
  assert.equal(limited.status,429,'nothing created because of the quota: plain 429');
  assert.ok(Number(limited.headers['retry-after'])>=1);

  currentDb=faulty(real,{transactionExecute:(statement)=>sqlOf(statement).includes("'invitation.created'")
    ?Promise.resolve({rows:[]}):null});
  const before=(await quota.invitationQuotaState(real,{circleId:10})).remaining;
  const failed=await bulk(['f1@example.test']);
  assert.equal(failed.body.results[0].status,'failed');
  assert.equal((await quota.invitationQuotaState(real,{circleId:10})).remaining,before,
    'the rolled-back transaction gives the reservation back');

  await assert.rejects(quota.reserveInvitationQuota(real,{circleId:0}),TypeError);
  await assert.rejects(quota.reserveInvitationQuota(real,{circleId:10,count:0}),TypeError);
  await assert.rejects(quota.reserveInvitationQuota(real,{circleId:10,count:201}),TypeError);
  await real.execute(`UPDATE auth_rate_limits SET attempts='corrupt'`);
  await assert.rejects(quota.invitationQuotaState(real,{circleId:10}),/invalid invitation quota state/);
});

test('single invitations validate with the shared strict rules and report the reason',async()=>{
  currentDb=await database();
  for(const [email,reason] of [['a@b.c','tld_invalid'],['a..b@example.test','local_dots'],['jürgen@example.test','non_ascii']]){
    const response=await invoke({body:{email}});
    assert.deepEqual(response.body,{error:'valid email required',code:'invalid_email',reason},email);
    assert.equal(response.status,400);
  }
  const created=await invoke({body:{email:' Plus+Tag@Example.test '}});
  assert.equal(created.status,201);
  assert.equal(created.body.invitation.email,'plus+tag@example.test');
});
