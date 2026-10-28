import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { afterEach, test } from 'node:test';

import { createClient } from '@libsql/client';

import { createInvitationToken, hashInvitationEmail, hashInvitationToken } from '../../api/_circle-membership.js';
import {
  createInvitationEmailEvent,
  createInvitationEmailHandler,
  ensureInvitationEmailReadiness,
  invitationEmailConfiguration,
  invitationEmailEnvelopeRotationMetrics,
  invitationEmailPayload,
  invitationKeyRing,
  openInvitationEmailCredential,
  sealInvitationEmailCredential,
} from '../../api/_invitation-email.js';
import { sealCredentialEnvelope } from '../../api/_key-rotation.js';
import { prepareMigrationConnection } from '../../db/migration-runner.js';
import { adoptCredentialKeyControl } from '../support/credential-key-control.mjs';
import { createMigratedDatabase } from '../support/migrated-db.mjs';

const ENV_KEYS=['APP_URL','CIRCLE_MEMBERSHIP_ENABLED','INVITATION_EMAIL_ENCRYPTION_KEY',
  'INVITATION_EMAIL_ENCRYPTION_KEY_VERSION','INVITATION_EMAIL_ENCRYPTION_PREVIOUS_KEYS',
  'INVITATION_EMAIL_ENVELOPE_WRITE_VERSION','INVITATION_EMAIL_DELIVERY_ENABLED',
  'JWT_SECRET','NODE_ENV','RESEND_API_KEY','RESEND_FROM'];
const saved=Object.fromEntries(ENV_KEYS.map(key=>[key,process.env[key]]));
const resources=[];
const INVITATION_ID='22222222-2222-4222-8222-222222222222';
const BASE_URL='https://randori.example.test';

afterEach(async()=>{
  for(const key of ENV_KEYS){
    if(saved[key]===undefined) delete process.env[key];
    else process.env[key]=saved[key];
  }
  while(resources.length){ try{ await resources.pop()(); }catch{} }
});

function configureProduction(){
  process.env.NODE_ENV='production';
  process.env.APP_URL=BASE_URL;
  process.env.CIRCLE_MEMBERSHIP_ENABLED='true';
  process.env.INVITATION_EMAIL_DELIVERY_ENABLED='true';
  process.env.INVITATION_EMAIL_ENCRYPTION_KEY=Buffer.alloc(32,12).toString('base64url');
  process.env.RESEND_API_KEY='re_invitation_test';
  process.env.RESEND_FROM='Randori <invite@randori.example.test>';
  process.env.JWT_SECRET='invitation-email-unit-secret-at-least-32-bytes';
}

async function fixture({circleName='Randori Circle'}={}){
  configureProduction();
  const {directory,url}=await createMigratedDatabase({prefix:'randori-cov-invitation-email-',filename:'invitation.sqlite'});
  const db=createClient({url});
  resources.push(async()=>{
    try{ db.close(); }finally{ rmSync(directory,{recursive:true,force:true}); }
  });
  await prepareMigrationConnection(db);
  await adoptCredentialKeyControl(db,invitationKeyRing());
  await db.batch([
    `INSERT INTO auth_accounts (id,email,password_hash,display_name,color,is_admin,is_demo)
      VALUES (1,'owner@example.test','!owner','Owner','#111111',1,0)`,
    {sql:`INSERT INTO circles (id,public_id,slug,name,is_primary,created_by,created_at)
      VALUES (10,'11111111-1111-4111-8111-111111111111','randori-circle',?,1,1,datetime('now'))`,args:[circleName]},
    `INSERT INTO circle_memberships (circle_id,user_id,role,status,joined_at,updated_at)
      VALUES (10,1,'owner','active',datetime('now'),datetime('now'))`,
  ],'write');
  return db;
}

async function seededEvent(db,{email='invitee@example.test',token=createInvitationToken()}={}){
  await db.execute({sql:`INSERT INTO circle_invitations
      (id,circle_id,token_hash,email_hash,created_by,created_at,expires_at)
    VALUES (?,10,?,?,1,datetime('now'),datetime('now','+1 day'))`,
  args:[INVITATION_ID,hashInvitationToken(token),hashInvitationEmail(email)]});
  const statement=createInvitationEmailEvent({invitationId:INVITATION_ID,circleId:10,actorUserId:1,
    email,token,sendSequence:1});
  const payload=JSON.parse(statement.args[3]);
  return {email,token,event:{eventVersion:1,idempotencyKey:statement.args[2],payload}};
}

test('configuration rejects unsafe origins, missing provider secrets, and an invalid key ring',()=>{
  configureProduction();
  assert.deepEqual(invitationEmailConfiguration(),{origin:BASE_URL,localRuntime:false});

  for(const url of ['not a url','https://randori.example.test/app','https://randori.example.test/?x=1',
    'https://randori.example.test/#frag','https://localhost','http://randori.example.test']){
    process.env.APP_URL=url;
    assert.equal(invitationEmailConfiguration(),null,url);
  }
  process.env.APP_URL=BASE_URL;

  process.env.CIRCLE_MEMBERSHIP_ENABLED='false';
  assert.equal(invitationEmailConfiguration(),null,'membership must be enabled');
  process.env.CIRCLE_MEMBERSHIP_ENABLED='true';

  process.env.RESEND_API_KEY='   ';
  assert.equal(invitationEmailConfiguration(),null,'blank provider key');
  process.env.RESEND_API_KEY='re_test';
  delete process.env.RESEND_FROM;
  assert.equal(invitationEmailConfiguration(),null,'missing sender');
  process.env.RESEND_FROM='Randori <invite@randori.example.test>';

  process.env.INVITATION_EMAIL_ENCRYPTION_KEY='short';
  assert.equal(invitationEmailConfiguration(),null,'invalid key ring fails closed');
  assert.throws(()=>invitationKeyRing(),error=>error.message==='INVITATION_EMAIL_ENCRYPTION_KEY ring is invalid');

  // Local runtime requires development + http loopback, and never production.
  process.env.APP_URL='http://localhost:3000';
  process.env.NODE_ENV='production';
  assert.equal(invitationEmailConfiguration({localRuntime:true}),null);
  process.env.NODE_ENV='development';
  process.env.APP_URL='https://localhost:3000';
  assert.equal(invitationEmailConfiguration({localRuntime:true}),null);
  process.env.APP_URL='http://randori.example.test';
  assert.equal(invitationEmailConfiguration({localRuntime:true}),null);
});

test('sealing and opening reject malformed identifiers, credentials, and plaintext shapes',()=>{
  configureProduction();
  const token=createInvitationToken();
  assert.throws(()=>sealInvitationEmailCredential({invitationId:'nope',email:'a@example.test',token}),
    /valid invitation email credential/);
  assert.throws(()=>sealInvitationEmailCredential({invitationId:INVITATION_ID,email:'not-email',token}),
    /valid invitation email credential/);
  assert.throws(()=>sealInvitationEmailCredential({invitationId:INVITATION_ID,email:'a@example.test',token:'x'}),
    /valid invitation email credential/);

  const envelope=sealInvitationEmailCredential({invitationId:INVITATION_ID,email:'a@example.test',token});
  assert.equal(openInvitationEmailCredential({invitationId:'not-a-uuid',envelope}),null);
  assert.equal(openInvitationEmailCredential({invitationId:INVITATION_ID,envelope:'garbage'}),null);

  const ring=invitationKeyRing();
  const sealRaw=plaintext=>sealCredentialEnvelope({plaintext,ring,
    legacyAad:()=>Buffer.from(`randori-invitation-email-envelope-v1\0${INVITATION_ID}`,'utf8')});
  for(const plaintext of [
    'not json',
    JSON.stringify([1,2,3]),
    JSON.stringify({v:1,email:'a@example.test',token,extra:true}),
    JSON.stringify({v:2,email:'a@example.test',token}),
    JSON.stringify({v:1,email:'not-email',token}),
    JSON.stringify({v:1,email:'a@example.test',token:'short'}),
    JSON.stringify({v:1,email:'a@example.test',token:42}),
  ]){
    assert.equal(openInvitationEmailCredential({invitationId:INVITATION_ID,envelope:sealRaw(plaintext)}),null,plaintext);
  }
  assert.deepEqual(openInvitationEmailCredential({invitationId:INVITATION_ID,
    envelope:sealRaw(JSON.stringify({v:1,email:'A@Example.test',token}))}),{email:'a@example.test',token});
});

test('event construction and payload validation are strict and non-retryable for corrupt work',()=>{
  configureProduction();
  const token=createInvitationToken();
  const base={invitationId:INVITATION_ID,circleId:10,actorUserId:1,email:'a@example.test',token,sendSequence:1};
  for(const override of [{invitationId:'x'},{circleId:0},{actorUserId:-1},{email:'bad'},{token:'bad'},
    {sendSequence:0},{sendSequence:6},{sendSequence:1.5}]){
    assert.throws(()=>createInvitationEmailEvent({...base,...override}),/valid invitation email event/,
      JSON.stringify(override));
  }
  const statement=createInvitationEmailEvent(base);
  const payload=JSON.parse(statement.args[3]);
  const event=overrides=>({eventVersion:1,idempotencyKey:statement.args[2],payload:{...payload,...overrides}});

  assert.throws(()=>invitationEmailPayload({eventVersion:0,payload}),
    error=>error.code==='EVENT_VERSION_UNSUPPORTED'&&error.retryable===false);
  assert.throws(()=>invitationEmailPayload({eventVersion:1,payload:[]}),error=>error.code==='PAYLOAD_INVALID');
  for(const override of [{invitation_id:'nope'},{circle_id:0},{actor_user_id:'x'},{token_hash:'abc'},
    {email_hash:'abc'},{send_sequence:9},{template_version:2},{credential_envelope:42},
    {credential_envelope:'a'.repeat(8193)}]){
    assert.throws(()=>invitationEmailPayload(event(override)),
      error=>error.code==='PAYLOAD_INVALID'&&error.retryable===false,JSON.stringify(override).slice(0,60));
  }

  // A corrupt envelope surfaces the envelope classification, not a provider retry.
  assert.throws(()=>invitationEmailPayload(event({credential_envelope:'not.an.envelope'})),
    error=>error.name==='OutboxDeliveryError'&&error.code==='ENVELOPE_INVALID'&&error.retryable===false);

  // An authentic envelope that does not match the declared hashes is rejected.
  const other=createInvitationToken();
  assert.throws(()=>invitationEmailPayload(event({token_hash:hashInvitationToken(other)})),
    error=>error.code==='PAYLOAD_INVALID');
  assert.throws(()=>invitationEmailPayload(event({email_hash:hashInvitationEmail('b@example.test')})),
    error=>error.code==='PAYLOAD_INVALID');

  const opened=invitationEmailPayload(event({}));
  assert.equal(opened.email,'a@example.test');
  assert.equal(opened.token,token);
});

test('handler construction validates its dependencies and local base URL contract',()=>{
  configureProduction();
  const db={execute(){}};
  const send=async()=>({});
  assert.throws(()=>createInvitationEmailHandler({db:null,baseUrl:BASE_URL,send}),/database and provider/);
  assert.throws(()=>createInvitationEmailHandler({db,baseUrl:BASE_URL,send:null}),/database and provider/);
  assert.throws(()=>createInvitationEmailHandler({db,baseUrl:BASE_URL,send,localRuntime:'yes'}),/runtime/);
  assert.throws(()=>createInvitationEmailHandler({db,baseUrl:'::not a url',send}),/base URL/);
  assert.throws(()=>createInvitationEmailHandler({db,baseUrl:'https://localhost',send}),/base URL/);
  assert.throws(()=>createInvitationEmailHandler({db,baseUrl:`${BASE_URL}/path`,send}),/base URL/);
  assert.throws(()=>createInvitationEmailHandler({db,baseUrl:'http://randori.example.test',send,localRuntime:true}),
    /base URL/);
  assert.throws(()=>createInvitationEmailHandler({db,baseUrl:'https://127.0.0.1:3000',send,localRuntime:true}),
    /base URL/);
  assert.equal(typeof createInvitationEmailHandler({db,baseUrl:'http://127.0.0.1:3000',send,localRuntime:true}),
    'function');
});

test('handler sanitizes the circle subject and maps provider results and errors',async()=>{
  const db=await fixture({circleName:'\u0001\u0002'});
  const {event,email,token}=await seededEvent(db);
  const messages=[];
  let reply={data:{id:'resend-message-9'}};
  const handler=createInvitationEmailHandler({db,baseUrl:BASE_URL,send:async message=>{
    messages.push(message);
    return reply;
  }});
  const delivered=await handler(event);
  assert.deepEqual(delivered,{status:'delivered',providerName:'email',providerMessageId:'resend-message-9'});
  assert.equal(messages[0].to,email);
  assert.equal(messages[0].subject,'You are invited to Randori Circle','control-only names fall back');
  assert.ok(messages[0].html.includes(`${BASE_URL}/invite#invite=${token}`));
  assert.equal(messages[0].idempotencyKey,event.idempotencyKey);

  reply={providerName:'resend',providerMessageId:null};
  assert.deepEqual(await handler(event),{status:'delivered',providerName:'resend',providerMessageId:null});

  reply={error:Object.assign(new Error('provider body'),{statusCode:429})};
  await assert.rejects(()=>handler(event),error=>error.code==='PROVIDER_RATE_LIMITED'&&error.retryable===true);

  reply=null;
  assert.deepEqual(await handler(event),{status:'delivered',providerName:'email',providerMessageId:null});

  // Preflight passes but the recipient has since joined: suppression uses current state.
  await db.batch([
    {sql:`INSERT INTO auth_accounts (id,email,password_hash,display_name,color,is_demo)
      VALUES (2,?,'!m','Member','#222222',0)`,args:[email]},
    `INSERT INTO circle_memberships (circle_id,user_id,role,status,joined_at,updated_at)
      VALUES (10,2,'member','active',datetime('now'),datetime('now'))`,
  ],'write');
  const sent=messages.length;
  assert.deepEqual(await handler(event),{status:'suppressed',reasonCode:'INVITATION_INACTIVE'});
  assert.equal(messages.length,sent,'no provider call after suppression');
});

test('handler suppresses an invitation to a recipient with a pending deletion',async()=>{
  const db=await fixture();
  // The recipient is a real account, but not a member of the invited circle
  // (invited to another circle): without the pending check they would be emailed.
  await db.execute({sql:`INSERT INTO auth_accounts (id,email,password_hash,display_name,color,is_demo)
    VALUES (2,?,'!m','Pending Member','#222222',0)`,args:['invitee@example.test']});
  const {event}=await seededEvent(db);
  const messages=[];
  const handler=createInvitationEmailHandler({db,baseUrl:BASE_URL,send:async message=>{
    messages.push(message);
    return {data:{id:'resend-message-1'}};
  }});
  assert.deepEqual(await handler(event),{status:'delivered',providerName:'email',providerMessageId:'resend-message-1'});
  assert.equal(messages.length,1);
  const now=Math.floor(Date.now()/1000);
  await db.execute({sql:`INSERT INTO account_deletion_requests (user_id,requested_at,scheduled_for)
    VALUES (?,?,?)`,args:[2,now,now+14*24*3600]});
  assert.deepEqual(await handler(event),{status:'suppressed',reasonCode:'ACCOUNT_DELETION_PENDING'});
  assert.equal(messages.length,1,'no invitation mail to a pending account');
});

test('rotation metrics and readiness require a client and bound their snapshot',async()=>{
  configureProduction();
  await assert.rejects(()=>invitationEmailEnvelopeRotationMetrics(null),/database client is required/);
  await assert.rejects(()=>ensureInvitationEmailReadiness({}),/database client is required/);
  const huge={execute:async()=>({rows:Array.from({length:10001},(_,id)=>({id,retained:0,envelope:'x'}))})};
  await assert.rejects(()=>invitationEmailEnvelopeRotationMetrics(huge),/limit exceeded/);
  const empty=await invitationEmailEnvelopeRotationMetrics({execute:async()=>({})},{ring:invitationKeyRing()});
  assert.equal(empty.actionable,0);
  assert.equal(empty.retained,0);

  const db=await fixture();
  assert.equal(await ensureInvitationEmailReadiness(db),true);
});
