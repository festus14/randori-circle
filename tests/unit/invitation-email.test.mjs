import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, test } from 'node:test';

import { createClient } from '@libsql/client';

import { createInvitationToken, hashInvitationEmail, hashInvitationToken } from '../../api/_circle-membership.js';
import {
  createInvitationEmailEvent,
  createInvitationEmailHandler,
  deliverInvitationEmails,
  invitationEmailConfiguration,
  invitationEmailPayload,
  invitationEmailStatus,
  INVITATION_EMAIL_DRAIN_BATCH_SIZE,
  INVITATION_EMAIL_EVENT_TYPE,
  INVITATION_EMAIL_EVENT_VERSION,
  INVITATION_EMAIL_MAX_SENDS,
  INVITATION_EMAIL_RESEND_SECONDS,
  INVITATION_EMAIL_TEMPLATE_VERSION,
  openInvitationEmailCredential,
  sealInvitationEmailCredential,
} from '../../api/_invitation-email.js';
import { applyMigrations, inspectMigrationState, prepareMigrationConnection } from '../../db/migration-runner.js';

const resources=[];

afterEach(async()=>{
  for(const key of ['APP_URL','CIRCLE_MEMBERSHIP_ENABLED','INVITATION_EMAIL_ENCRYPTION_KEY',
    'JWT_SECRET','NODE_ENV','RESEND_API_KEY','RESEND_FROM']) delete process.env[key];
  while(resources.length){ try{ await resources.pop()(); }catch{} }
});

function configureProduction(){
  process.env.NODE_ENV='production';
  process.env.APP_URL='https://randori.example.test';
  process.env.CIRCLE_MEMBERSHIP_ENABLED='true';
  process.env.INVITATION_EMAIL_ENCRYPTION_KEY=Buffer.alloc(32,12).toString('base64url');
  process.env.RESEND_API_KEY='re_invitation_test';
  process.env.RESEND_FROM='Randori <invite@randori.example.test>';
  process.env.JWT_SECRET='invitation-email-unit-secret-at-least-32-bytes';
}

async function fixture(){
  configureProduction();
  const directory=mkdtempSync(join(tmpdir(),'randori-invitation-email-'));
  const db=createClient({url:`file:${join(directory,'invitation.sqlite')}`});
  await prepareMigrationConnection(db);
  const initial=await inspectMigrationState(db);
  await applyMigrations(db,{expectedStateFingerprint:initial.stateFingerprint,
    retry:{maxAttempts:1,baseDelayMs:0,maxDelayMs:0}});
  await db.batch([
    `INSERT INTO auth_accounts (id,email,password_hash,display_name,color,is_admin,is_demo)
      VALUES (1,'owner@example.test','!owner','Owner <Lead>','#111111',1,0)`,
    `INSERT INTO circles (id,public_id,slug,name,is_primary,created_by,created_at)
      VALUES (10,'11111111-1111-4111-8111-111111111111','randori-circle','Randori <Circle>',1,1,datetime('now'))`,
    `INSERT INTO circle_memberships (circle_id,user_id,role,status,joined_at,updated_at)
      VALUES (10,1,'owner','active',datetime('now'),datetime('now'))`,
  ],'write');
  resources.push(async()=>{ await db.close(); rmSync(directory,{recursive:true,force:true}); });
  return db;
}

async function seed(db,{id='22222222-2222-4222-8222-222222222222',
  email='invitee@example.test',token=createInvitationToken(),expires="datetime('now','+1 day')",
  actorUserId=1,sequence=1}={}){
  await db.execute({sql:`INSERT INTO circle_invitations
      (id,circle_id,token_hash,email_hash,created_by,created_at,expires_at)
    VALUES (?,10,?,?,1,datetime('now'),${expires})`,
  args:[id,hashInvitationToken(token),hashInvitationEmail(email)]});
  const statement=createInvitationEmailEvent({invitationId:id,circleId:10,actorUserId,email,token,
    sendSequence:sequence,localRuntime:false});
  await db.execute(statement);
  return {id,email,token,statement};
}

function workerOptions(){
  return {heartbeatIntervalMs:0,leaseDurationMs:1000,baseBackoffMs:1000,maxBackoffMs:1000};
}

test('configuration and the dedicated AES-GCM envelope fail closed in production',()=>{
  process.env.NODE_ENV='production';
  process.env.APP_URL='https://randori.example.test';
  process.env.CIRCLE_MEMBERSHIP_ENABLED='true';
  process.env.RESEND_API_KEY='re_test';
  process.env.RESEND_FROM='Randori <invite@randori.example.test>';
  process.env.JWT_SECRET='invitation-email-unit-secret-at-least-32-bytes';
  assert.equal(invitationEmailConfiguration(),null,'production requires its dedicated encryption key');
  process.env.INVITATION_EMAIL_ENCRYPTION_KEY=Buffer.alloc(32,12).toString('base64url');
  assert.deepEqual(invitationEmailConfiguration(),{origin:'https://randori.example.test',localRuntime:false});
  const invitationId='22222222-2222-4222-8222-222222222222';
  const token=createInvitationToken();
  const envelope=sealInvitationEmailCredential({invitationId,email:' Invitee@Example.Test ',token});
  assert.equal(envelope.includes(token),false);
  assert.equal(envelope.includes('invitee@example.test'),false);
  assert.deepEqual(openInvitationEmailCredential({invitationId,envelope}),{
    email:'invitee@example.test',token,
  });
  const [encodedIv,encodedCiphertext,encodedTag]=envelope.split('.');
  const tamperedCiphertext=Buffer.from(encodedCiphertext,'base64url');
  tamperedCiphertext[0]^=1;
  const tampered=`${encodedIv}.${tamperedCiphertext.toString('base64url')}.${encodedTag}`;
  assert.equal(openInvitationEmailCredential({invitationId,envelope:tampered}),null);
  assert.equal(openInvitationEmailCredential({invitationId:'33333333-3333-4333-8333-333333333333',envelope}),null);
  assert.throws(()=>createInvitationEmailHandler({db:{execute(){}},baseUrl:'http://randori.example.test',
    send:async()=>({})}),/valid invitation email base URL/);
  assert.throws(()=>createInvitationEmailHandler({db:{execute(){}},baseUrl:'https://user:pass@randori.example.test',
    send:async()=>({})}),/valid invitation email base URL/);

  delete process.env.INVITATION_EMAIL_ENCRYPTION_KEY;
  delete process.env.RESEND_API_KEY;
  delete process.env.RESEND_FROM;
  process.env.NODE_ENV='development';
  process.env.APP_URL='http://127.0.0.1:3000';
  assert.deepEqual(invitationEmailConfiguration({localRuntime:true}),{
    origin:'http://127.0.0.1:3000',localRuntime:true,
  });
  assert.equal(invitationEmailConfiguration({localRuntime:false}),null);
});

test('invitation event is versioned, bounded, idempotent, and contains no plaintext credential or address',async()=>{
  const db=await fixture();
  const seeded=await seed(db);
  await db.execute(seeded.statement);
  const stored=(await db.execute(`SELECT * FROM outbox_events`)).rows;
  assert.equal(stored.length,1);
  assert.equal(stored[0].event_type,INVITATION_EMAIL_EVENT_TYPE);
  assert.equal(Number(stored[0].event_version),INVITATION_EMAIL_EVENT_VERSION);
  assert.equal(Number(stored[0].max_attempts),5);
  assert.equal(Number(stored[0].delivery_timeout_ms),10_000);
  assert.equal(stored[0].idempotency_key,`invitation-email/v1/${seeded.id}/1`);
  assert.equal(String(stored[0].payload_json).includes(seeded.email),false);
  assert.equal(String(stored[0].payload_json).includes(seeded.token),false);
  assert.equal(Number(JSON.parse(stored[0].payload_json).actor_user_id),1);
  const payload=invitationEmailPayload({eventVersion:1,payload:JSON.parse(stored[0].payload_json)});
  assert.equal(payload.email,seeded.email);
  assert.equal(payload.token,seeded.token);
  assert.equal(JSON.parse(stored[0].payload_json).template_version,INVITATION_EMAIL_TEMPLATE_VERSION);
  assert.equal(INVITATION_EMAIL_MAX_SENDS,5);
  assert.equal(INVITATION_EMAIL_RESEND_SECONDS,60);
  assert.equal(INVITATION_EMAIL_DRAIN_BATCH_SIZE,3);
});

test('delivery renders a safe fragment link once and retains provider idempotency',async()=>{
  const db=await fixture();
  const seeded=await seed(db);
  const messages=[];
  const delivered=await deliverInvitationEmails({db,baseUrl:'https://randori.example.test',
    workerId:'invitation-delivery',send:async message=>{
      messages.push(message);
      return {providerName:'capture',providerMessageId:'invite-message-1'};
    },workerOptions:workerOptions()});
  assert.equal(delivered.delivered,1);
  assert.equal(messages.length,1);
  assert.equal(messages[0].to,seeded.email);
  assert.equal(messages[0].idempotencyKey,`invitation-email/v1/${seeded.id}/1`);
  assert.ok(messages[0].html.includes('Randori &lt;Circle&gt;'));
  assert.ok(messages[0].html.includes(`/invite#invite=${seeded.token}`));
  assert.equal(messages[0].html.includes('Owner <Lead>'),false);
  const duplicate=await deliverInvitationEmails({db,baseUrl:'https://randori.example.test',
    workerId:'invitation-duplicate',send:async()=>assert.fail('delivered work must not repeat'),
    workerOptions:workerOptions()});
  assert.equal(duplicate.claimed,0);
  assert.deepEqual(await invitationEmailStatus(db),{
    pending:0,processing:0,retry:0,delivered:1,suppressed:0,dead_letter:0,
  });
});

test('revoked, expired, consumed, rotated, owner-revoked, and existing-member invitations suppress',async()=>{
  const scenarios=[
    ['revoked',`UPDATE circle_invitations SET revoked_at=datetime('now')`],
    ['expired',`UPDATE circle_invitations SET expires_at=datetime('now','-1 second')`],
    ['consumed',`UPDATE circle_invitations SET used_at=datetime('now'),used_by=2`],
    ['rotated',`UPDATE circle_invitations SET token_hash='${'f'.repeat(64)}'`],
    ['owner-revoked',`UPDATE circle_memberships SET status='inactive' WHERE user_id=1`],
  ];
  for(const [name,mutation] of scenarios){
    const db=await fixture();
    await seed(db);
    await db.execute(mutation);
    const result=await deliverInvitationEmails({db,baseUrl:'https://randori.example.test',
      workerId:`suppress-${name}`,send:async()=>assert.fail(`${name} must not send`),
      workerOptions:workerOptions()});
    assert.equal(result.suppressed,1,name);
  }

  const db=await fixture();
  const seeded=await seed(db);
  await db.batch([
    {sql:`INSERT INTO auth_accounts (id,email,password_hash,display_name,color,is_demo)
      VALUES (2,?,'!member','Already Member','#222222',0)`,args:[seeded.email]},
    `INSERT INTO circle_memberships (circle_id,user_id,role,status,joined_at,updated_at)
      VALUES (10,2,'member','active',datetime('now'),datetime('now'))`,
  ],'write');
  const existing=await deliverInvitationEmails({db,baseUrl:'https://randori.example.test',
    workerId:'existing-member',send:async()=>assert.fail('existing member must not send'),
    workerOptions:workerOptions()});
  assert.equal(existing.suppressed,1);
  assert.equal((await db.execute(`SELECT last_error_code FROM outbox_events`)).rows[0].last_error_code,
    'INVITATION_INACTIVE');
});

test('rotation suppresses old work, provider failures retry, and malformed envelopes are permanent',async()=>{
  const db=await fixture();
  const first=await seed(db);
  const secondToken=createInvitationToken();
  await db.execute({sql:`UPDATE circle_invitations SET token_hash=? WHERE id=?`,
    args:[hashInvitationToken(secondToken),first.id]});
  await db.execute(createInvitationEmailEvent({invitationId:first.id,circleId:10,actorUserId:1,email:first.email,
    token:secondToken,sendSequence:2}));
  const messages=[];
  const rotated=await deliverInvitationEmails({db,baseUrl:'https://randori.example.test',
    workerId:'rotated-worker',send:async message=>{
      messages.push(message);
      return {providerName:'capture',providerMessageId:'new-link'};
    },workerOptions:workerOptions()});
  assert.equal(rotated.suppressed,1);
  assert.equal(rotated.delivered,1);
  assert.equal(messages.length,1);
  assert.ok(messages[0].html.includes(secondToken));
  assert.equal(messages[0].html.includes(first.token),false);

  const retryId='33333333-3333-4333-8333-333333333333';
  const retry=await seed(db,{id:retryId,email:'retry@example.test'});
  const retried=await deliverInvitationEmails({db,baseUrl:'https://randori.example.test',
    workerId:'retry-worker',send:async()=>{ throw Object.assign(new Error('private provider body'),{statusCode:429}); },
    workerOptions:workerOptions()});
  assert.equal(retried.retried,1);
  const retryRow=(await db.execute({sql:`SELECT status,last_error_code,payload_json FROM outbox_events
    WHERE idempotency_key=?`,args:[`invitation-email/v1/${retry.id}/1`]})).rows[0];
  assert.equal(retryRow.status,'retry');
  assert.equal(retryRow.last_error_code,'PROVIDER_RATE_LIMITED');
  assert.equal(String(retryRow.payload_json).includes('private provider body'),false);

  await db.execute({sql:`UPDATE circle_invitations SET used_at=datetime('now'),used_by=1 WHERE id=?`,
    args:[retry.id]});
  await db.execute({sql:`UPDATE outbox_events SET next_attempt_at=datetime('now','-1 second')
    WHERE idempotency_key=?`,args:[`invitation-email/v1/${retry.id}/1`]});
  const consumedBeforeRetry=await deliverInvitationEmails({db,baseUrl:'https://randori.example.test',
    workerId:'consumed-before-retry',send:async()=>assert.fail('a consumed invitation must not retry'),
    workerOptions:workerOptions()});
  assert.equal(consumedBeforeRetry.suppressed,1);

  const handler=createInvitationEmailHandler({db,baseUrl:'https://randori.example.test',send:async()=>({})});
  await assert.rejects(()=>handler({eventVersion:2,payload:{}}),error=>
    error?.code==='EVENT_VERSION_UNSUPPORTED'&&error?.retryable===false);
  await assert.rejects(()=>handler({eventVersion:1,payload:{}}),error=>
    error?.code==='PAYLOAD_INVALID'&&error?.retryable===false);
});
