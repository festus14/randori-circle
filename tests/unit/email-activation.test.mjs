import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, test } from 'node:test';

import { createClient } from '@libsql/client';
import bcrypt from 'bcryptjs';

import {
  createEmailActivationHandler,
  deliverEmailActivations,
  EMAIL_ACTIVATION_RESEND_SECONDS,
  hashEmailActivationToken,
  openEmailActivationToken,
  requestEmailActivation,
  resendEmailActivation,
  sealEmailActivationToken,
  verifyEmailActivation,
} from '../../api/_email-activation.js';
import { createInvitationToken, hashInvitationEmail, hashInvitationToken } from '../../api/_circle-membership.js';
import { EXECUTABLE_MIGRATIONS } from '../../db/executable-migrations.js';
import { applyMigrations, inspectMigrationState, prepareMigrationConnection } from '../../db/migration-runner.js';

const JWT_SECRET='email-activation-test-secret-at-least-thirty-two-bytes';
const ENCRYPTION_KEY=Buffer.alloc(32,7).toString('base64url');
const NOW=Math.floor(Date.now()/1000);
const resources=[];

afterEach(()=>{
  while(resources.length){ try{ resources.pop()(); }catch{} }
});

async function fixture({clients=1}={}){
  process.env.JWT_SECRET=JWT_SECRET;
  process.env.EMAIL_VERIFICATION_ENCRYPTION_KEY=ENCRYPTION_KEY;
  process.env.EMAIL_PASSWORD_ACTIVATION_ENABLED='true';
  process.env.CIRCLE_MEMBERSHIP_ENABLED='true';
  process.env.APP_URL='https://randori.example.test';
  const directory=mkdtempSync(join(tmpdir(),'randori-email-activation-'));
  const url=`file:${join(directory,'activation.sqlite')}`;
  const databases=Array.from({length:clients},()=>createClient({url}));
  for(const db of databases) await prepareMigrationConnection(db);
  const initial=await inspectMigrationState(databases[0]);
  await applyMigrations(databases[0],{
    expectedStateFingerprint:initial.stateFingerprint,
    retry:{maxAttempts:1,baseDelayMs:0,maxDelayMs:0},
  });
  await databases[0].batch([
    `INSERT INTO auth_accounts (id,email,password_hash,display_name,color,is_admin)
      VALUES (1,'owner@example.test','!owner','Owner','#111111',1)`,
    `INSERT INTO circles (id,public_id,slug,name,is_primary,created_by,created_at)
      VALUES (10,'11111111-1111-4111-8111-111111111111','randori-circle','Randori Circle',1,1,datetime('now'))`,
    `INSERT INTO circle_memberships (circle_id,user_id,role,status,joined_at,updated_at)
      VALUES (10,1,'owner','active',datetime('now'),datetime('now'))`,
  ],'write');
  resources.push(()=>{
    for(const db of databases) db.close();
    rmSync(directory,{recursive:true,force:true});
  });
  return {db:databases[0],databases,url};
}

async function invite(db,email,{id='22222222-2222-4222-8222-222222222222'}={}){
  const token=createInvitationToken();
  const tokenHash=hashInvitationToken(token);
  const emailHash=hashInvitationEmail(email);
  await db.execute({
    sql:`INSERT INTO circle_invitations
      (id,circle_id,token_hash,email_hash,created_by,created_at,expires_at)
      VALUES (?,10,?,?,1,datetime('now'),datetime('now','+1 day'))`,
    args:[id,tokenHash,emailHash],
  });
  return {invitation_id:id,circle_id:10,token_hash:tokenHash,email_hash:emailHash};
}

async function request(db,claim,email='member@example.test',nowSeconds=NOW){
  return requestEmailActivation(db,{
    claim,email,passwordHash:await bcrypt.hash('correct horse battery',4),
    displayName:'Invited Member',color:'#123456',
  },{nowSeconds});
}

async function queuedToken(db){
  const row=(await db.execute(`SELECT payload_json FROM outbox_events
    WHERE event_type='auth.emailverification.requested' ORDER BY id DESC LIMIT 1`)).rows[0];
  const payload=JSON.parse(String(row.payload_json));
  return {payload,token:openEmailActivationToken(payload.token_envelope)};
}

function countTransactionStatements(db,counter){
  return {
    transaction:async mode=>{
      const transaction=await db.transaction(mode);
      return {
        execute(statement){ counter.count+=1; return transaction.execute(statement); },
        commit:()=>transaction.commit(),
        rollback:()=>transaction.rollback(),
      };
    },
  };
}

test('activation stores only hashes, delivers through the outbox, and verifies atomically',async()=>{
  const {db}=await fixture();
  const claim=await invite(db,'member@example.test');
  assert.deepEqual(await request(db,claim),{accepted:true});
  const {payload,token}=await queuedToken(db);
  assert.match(token,/^[A-Za-z0-9_-]{43}$/);
  const persisted=JSON.stringify((await db.execute(`SELECT * FROM auth_email_activations`)).rows);
  assert.equal(persisted.includes(token),false);
  assert.equal(String((await db.execute(`SELECT token_hash FROM auth_email_activations`)).rows[0].token_hash),hashEmailActivationToken(token));
  assert.equal(String(payload.token_envelope).includes(token),false);

  const messages=[];
  const delivered=await deliverEmailActivations({
    db,baseUrl:'https://randori.example.test',workerId:'activation-test',
    send:message=>{ messages.push(message); return {providerName:'test',providerMessageId:'message-1'}; },
    workerOptions:{heartbeatIntervalMs:0},
  });
  assert.equal(delivered.delivered,1);
  assert.equal(messages.length,1);
  assert.match(messages[0].html,new RegExp(`/verify#token=${token.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')}`));

  const verified=await verifyEmailActivation(db,{token},{nowSeconds:NOW+100});
  assert.equal(verified.status,'verified');
  assert.match(verified.sessionToken,/^[^.]+\.[^.]+\.[^.]+$/);
  assert.deepEqual((await db.execute(`SELECT email FROM auth_accounts ORDER BY id`)).rows.map(row=>row.email),[
    'owner@example.test','member@example.test',
  ]);
  assert.equal(Number((await db.execute(`SELECT COUNT(*) AS count FROM circle_memberships WHERE user_id=2 AND status='active'`)).rows[0].count),1);
  assert.equal(Number((await db.execute(`SELECT COUNT(*) AS count FROM auth_sessions WHERE user_id=2`)).rows[0].count),1);
  assert.equal((await db.execute(`SELECT event_type FROM circle_audit_events WHERE subject_user_id=2`)).rows[0].event_type,'activation.verified');
  assert.equal((await verifyEmailActivation(db,{token},{nowSeconds:NOW+101})).status,'used');
});

test('wrong email, revoked invitation, expiry, and rotated tokens fail without accounts',async()=>{
  const {db}=await fixture();
  const claim=await invite(db,'member@example.test');
  assert.deepEqual(await request(db,claim,'wrong@example.test'),{accepted:false});
  assert.equal(Number((await db.execute(`SELECT COUNT(*) AS count FROM auth_email_activations`)).rows[0].count),0);
  await request(db,claim);
  const first=(await queuedToken(db)).token;
  await assert.doesNotReject(()=>resendEmailActivation(db,{claim,email:'member@example.test'},
    {nowSeconds:NOW+EMAIL_ACTIVATION_RESEND_SECONDS}));
  const second=(await queuedToken(db)).token;
  assert.notEqual(first,second);
  assert.equal((await verifyEmailActivation(db,{token:first},{nowSeconds:NOW+100})).status,'invalid');
  assert.equal((await verifyEmailActivation(db,{token:second},{nowSeconds:NOW+2_000})).status,'expired');
  await db.execute({sql:`UPDATE circle_invitations SET revoked_at=datetime('now') WHERE id=?`,args:[claim.invitation_id]});
  assert.equal((await verifyEmailActivation(db,{token:second},{nowSeconds:NOW+100})).status,'revoked');
  assert.equal(Number((await db.execute(`SELECT COUNT(*) AS count FROM auth_accounts WHERE email='member@example.test'`)).rows[0].count),0);
});

test('eligible, wrong-email, and existing-account requests use the same bounded statement shape',async()=>{
  const {db}=await fixture();
  const memberClaim=await invite(db,'member@example.test');
  const wrongCounter={count:0};
  assert.deepEqual(await request(countTransactionStatements(db,wrongCounter),memberClaim,'wrong@example.test'),
    {accepted:false});

  const eligibleCounter={count:0};
  assert.deepEqual(await request(countTransactionStatements(db,eligibleCounter),memberClaim),{accepted:true});

  const ownerClaim=await invite(db,'owner@example.test',{id:'44444444-4444-4444-8444-444444444444'});
  const existingCounter={count:0};
  assert.deepEqual(await request(countTransactionStatements(db,existingCounter),ownerClaim,'owner@example.test'),
    {accepted:false});
  assert.deepEqual([wrongCounter.count,eligibleCounter.count,existingCounter.count],[2,2,2]);
});

test('resends are cooldown and lifetime bounded while stale queued messages suppress',async()=>{
  const {db}=await fixture();
  const claim=await invite(db,'member@example.test');
  await request(db,claim);
  assert.deepEqual(await resendEmailActivation(db,{claim,email:'member@example.test'},
    {nowSeconds:NOW+1}),{accepted:false});
  for(let count=2;count<=5;count+=1){
    assert.deepEqual(await resendEmailActivation(db,{claim,email:'member@example.test'},
      {nowSeconds:NOW+(count-1)*EMAIL_ACTIVATION_RESEND_SECONDS}),{accepted:true});
  }
  assert.deepEqual(await resendEmailActivation(db,{claim,email:'member@example.test'},
    {nowSeconds:NOW+1_000}),{accepted:false});
  assert.equal(Number((await db.execute(`SELECT send_count FROM auth_email_activations`)).rows[0].send_count),5);
  const sent=[];
  const handler=createEmailActivationHandler({db,baseUrl:'https://randori.example.test',send:message=>{
    sent.push(message); return {providerName:'test'};
  }});
  const events=(await db.execute(`SELECT id,event_type,event_version,idempotency_key,payload_json
    FROM outbox_events ORDER BY id`)).rows;
  const outcomes=[];
  for(const row of events){
    outcomes.push(await handler({id:Number(row.id),eventType:row.event_type,eventVersion:Number(row.event_version),
      idempotencyKey:row.idempotency_key,payload:JSON.parse(row.payload_json)}));
  }
  assert.deepEqual(outcomes.slice(0,-1).map(item=>item.reasonCode),Array(4).fill('ACTIVATION_INACTIVE'));
  assert.equal(outcomes.at(-1).status,'delivered');
  assert.equal(sent.length,1);
});

test('activation delivery classifies retryable and permanent provider failures without network access',async()=>{
  const {db}=await fixture();
  const claim=await invite(db,'member@example.test');
  await request(db,claim);
  const row=(await db.execute(`SELECT id,event_type,event_version,idempotency_key,payload_json
    FROM outbox_events ORDER BY id DESC LIMIT 1`)).rows[0];
  const event={id:Number(row.id),eventType:row.event_type,eventVersion:Number(row.event_version),
    idempotencyKey:row.idempotency_key,payload:JSON.parse(row.payload_json)};
  const retryable=createEmailActivationHandler({db,baseUrl:'https://randori.example.test',send:async()=>{
    throw Object.assign(new Error('mock rate limit'),{statusCode:429});
  }});
  await assert.rejects(()=>retryable(event),error=>error.code==='PROVIDER_RATE_LIMITED'&&error.retryable===true);
  const permanent=createEmailActivationHandler({db,baseUrl:'https://randori.example.test',send:async()=>{
    throw Object.assign(new Error('mock rejected address'),{statusCode:400});
  }});
  await assert.rejects(()=>permanent(event),error=>error.code==='PROVIDER_REJECTED'&&error.retryable===false);
});

test('verification is race-safe and a session failure rolls the entire activation back',async()=>{
  const {db,databases}=await fixture({clients:2});
  const claim=await invite(db,'member@example.test');
  await request(db,claim);
  const {token}=await queuedToken(db);
  const results=await Promise.allSettled(databases.map(database=>
    verifyEmailActivation(database,{token},{nowSeconds:NOW+100})));
  assert.equal(results.filter(result=>result.status==='fulfilled'&&result.value.status==='verified').length,1);
  assert.equal(Number((await db.execute(`SELECT COUNT(*) AS count FROM auth_accounts WHERE email='member@example.test'`)).rows[0].count),1);

  const secondClaim=await invite(db,'rollback@example.test',{id:'33333333-3333-4333-8333-333333333333'});
  await request(db,secondClaim,'rollback@example.test');
  const rollbackToken=(await queuedToken(db)).token;
  const faultDb={
    transaction:async mode=>{
      const tx=await db.transaction(mode);
      return {
        execute:statement=>String(statement?.sql||statement).includes('INSERT INTO auth_sessions')
          ?Promise.reject(new Error('forced session failure')):tx.execute(statement),
        commit:()=>tx.commit(),rollback:()=>tx.rollback(),close:()=>tx.close?.(),
      };
    },
  };
  await assert.rejects(()=>verifyEmailActivation(faultDb,{token:rollbackToken},{nowSeconds:NOW+100}),/forced session failure/);
  assert.equal(Number((await db.execute(`SELECT COUNT(*) AS count FROM auth_accounts WHERE email='rollback@example.test'`)).rows[0].count),0);
  assert.equal((await db.execute({sql:`SELECT used_at FROM circle_invitations WHERE id=?`,args:[secondClaim.invitation_id]})).rows[0].used_at,null);
});

test('encrypted queued activation survives a database client restart',async()=>{
  const {db,url}=await fixture();
  const claim=await invite(db,'restart@example.test');
  await request(db,claim,'restart@example.test');
  const token=(await queuedToken(db)).token;
  db.close();
  const reopened=createClient({url});
  resources.push(()=>reopened.close());
  await prepareMigrationConnection(reopened);
  const verified=await verifyEmailActivation(reopened,{token},{nowSeconds:NOW+100});
  assert.equal(verified.status,'verified');
});

test('production configuration fails closed and token envelopes reject tampering',()=>{
  const previous={node:process.env.NODE_ENV,key:process.env.EMAIL_VERIFICATION_ENCRYPTION_KEY};
  process.env.NODE_ENV='production';
  delete process.env.EMAIL_VERIFICATION_ENCRYPTION_KEY;
  assert.throws(()=>sealEmailActivationToken('A'.repeat(43)),/EMAIL_VERIFICATION_ENCRYPTION_KEY/);
  process.env.EMAIL_VERIFICATION_ENCRYPTION_KEY=ENCRYPTION_KEY;
  const envelope=sealEmailActivationToken('A'.repeat(43));
  const tampered=`${envelope.slice(0,-1)}${envelope.endsWith('A')?'B':'A'}`;
  assert.equal(openEmailActivationToken(tampered),null);
  if(previous.node===undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV=previous.node;
  if(previous.key===undefined) delete process.env.EMAIL_VERIFICATION_ENCRYPTION_KEY; else process.env.EMAIL_VERIFICATION_ENCRYPTION_KEY=previous.key;
});
