import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, test } from 'node:test';

import { createClient } from '@libsql/client';

import authHandler from '../../api/auth.js';
import {
  EMAIL_ACTIVATION_EVENT_TYPE,
  activationKeyRing,
  emailActivationKeyRotationStatus,
  openEmailActivationToken,
  sealEmailActivationToken,
} from '../../api/_email-activation.js';
import {createOutboxEventStatement} from '../../api/_outbox.js';
import {
  createInvitationToken,
  createInviteClaim,
  hashInvitationEmail,
  hashInvitationToken,
  inviteClaimCookie,
} from '../../api/_circle-membership.js';
import { EXECUTABLE_MIGRATIONS } from '../../db/executable-migrations.js';
import { applyMigrations, inspectMigrationState, prepareMigrationConnection } from '../../db/migration-runner.js';
import {adoptCredentialKeyControl} from '../support/credential-key-control.mjs';

const resources=[];

afterEach(()=>{
  for(const key of ['APP_URL','CIRCLE_MEMBERSHIP_ENABLED','EMAIL_PASSWORD_ACTIVATION_ENABLED',
    'EMAIL_VERIFICATION_ENCRYPTION_KEY','JWT_SECRET','NODE_ENV','RESEND_API_KEY','RESEND_FROM',
    'TURSO_AUTH_TOKEN','TURSO_DATABASE_URL']){
    delete process.env[key];
  }
  while(resources.length){ try{ resources.pop()(); }catch{} }
});

function response(){
  return {
    statusCode:200,headers:{},body:null,
    status(code){ this.statusCode=code; return this; },
    setHeader(name,value){ this.headers[name.toLowerCase()]=value; },
    getHeader(name){ return this.headers[String(name).toLowerCase()]; },
    json(value){ this.body=value; return this; },
    writeHead(code,headers={}){ this.statusCode=code; for(const [name,value] of Object.entries(headers)) this.setHeader(name,value); },
    end(){ return this; },
  };
}

async function invoke({endpoint,body,cookie=''}){
  const res=response();
  await authHandler({
    method:'POST',url:`/api/auth/${endpoint}`,query:{endpoint},body,
    headers:{host:'randori.example.test','x-forwarded-proto':'https',origin:'https://randori.example.test',cookie},
    socket:{remoteAddress:'203.0.113.10'},
  },res);
  return res;
}

async function fixture(){
  const directory=mkdtempSync(join(tmpdir(),'randori-email-activation-api-'));
  const path=join(directory,'database.sqlite');
  const url=pathToFileURL(path).href;
  process.env.NODE_ENV='production';
  process.env.APP_URL='https://randori.example.test';
  process.env.CIRCLE_MEMBERSHIP_ENABLED='true';
  process.env.EMAIL_PASSWORD_ACTIVATION_ENABLED='true';
  process.env.EMAIL_VERIFICATION_ENCRYPTION_KEY=Buffer.alloc(32,7).toString('base64url');
  process.env.RESEND_API_KEY='re_test_activation';
  process.env.RESEND_FROM='Randori <activation@randori.example.test>';
  process.env.JWT_SECRET='api-email-activation-test-secret-at-least-32-bytes';
  process.env.TURSO_DATABASE_URL=url;
  const db=createClient({url});
  await prepareMigrationConnection(db);
  const initial=await inspectMigrationState(db);
  await applyMigrations(db,{expectedStateFingerprint:initial.stateFingerprint,
    retry:{maxAttempts:1,baseDelayMs:0,maxDelayMs:0}});
  await adoptCredentialKeyControl(db,activationKeyRing());
  await db.batch([
    `INSERT INTO auth_accounts (id,email,password_hash,display_name,color,is_admin)
      VALUES (1,'owner@example.test','!owner','Owner','#111111',1)`,
    `INSERT INTO circles (id,public_id,slug,name,is_primary,created_by,created_at)
      VALUES (10,'11111111-1111-4111-8111-111111111111','randori-circle','Randori Circle',1,1,datetime('now'))`,
    `INSERT INTO circle_memberships (circle_id,user_id,role,status,joined_at,updated_at)
      VALUES (10,1,'owner','active',datetime('now'),datetime('now'))`,
  ],'write');
  const email='member@example.test';
  const invitationId='22222222-2222-4222-8222-222222222222';
  const invitationToken=createInvitationToken();
  const tokenHash=hashInvitationToken(invitationToken);
  const emailHash=hashInvitationEmail(email);
  await db.execute({sql:`INSERT INTO circle_invitations
    (id,circle_id,token_hash,email_hash,created_by,created_at,expires_at)
    VALUES (?,10,?,?,1,datetime('now'),datetime('now','+1 day'))`,args:[invitationId,tokenHash,emailHash]});
  const binding='b'.repeat(43);
  const claim=createInviteClaim({invitationId,circleId:10,tokenHash,emailHash},{binding});
  resources.push(()=>{ db.close(); rmSync(directory,{recursive:true,force:true}); });
  return {db,email,cookie:inviteClaimCookie(claim),binding};
}

test('production signup stays generic, creates no account, and verification creates the session',async()=>{
  const {db,email,cookie,binding}=await fixture();
  const unrelatedKey='auth-activation/v1/33333333-3333-4333-8333-333333333333/1';
  await db.execute(createOutboxEventStatement({eventType:EMAIL_ACTIVATION_EVENT_TYPE,
    idempotencyKey:unrelatedKey,payload:{
      token_envelope:sealEmailActivationToken('A'.repeat(43),{idempotencyKey:unrelatedKey}),
    },maxAttempts:1}));
  await db.execute({sql:`UPDATE outbox_events SET status='dead_letter' WHERE idempotency_key=?`,
    args:[unrelatedKey]});
  const rotation=await emailActivationKeyRotationStatus(db);
  assert.equal(rotation.ready,false,
    'operator retirement health remains red for unrelated legacy dead letters');
  assert.equal(rotation.legacy_v1,1);
  const body={email,password:'correct horse battery',name:'Invited Member',invite_binding:binding};
  const acceptedStarted=Date.now();
  const accepted=await invoke({endpoint:'signup',body,cookie});
  const acceptedElapsed=Date.now()-acceptedStarted;
  const wrongStarted=Date.now();
  const wrong=await invoke({endpoint:'signup',body:{...body,email:'wrong@example.test'},cookie});
  const wrongElapsed=Date.now()-wrongStarted;
  const mismatched=await invoke({endpoint:'signup',body:{...body,invite_binding:'Z'.repeat(43)},cookie});
  assert.equal(accepted.statusCode,202);
  assert.deepEqual(wrong.body,accepted.body);
  assert.equal(mismatched.statusCode,202);
  assert.deepEqual(mismatched.body,accepted.body);
  assert.equal(mismatched.headers['set-cookie'],undefined);
  assert.ok(acceptedElapsed>=300,`eligible response completed too quickly: ${acceptedElapsed}ms`);
  assert.ok(wrongElapsed>=300,`ineligible response completed too quickly: ${wrongElapsed}ms`);
  const mismatchedResend=await invoke({endpoint:'activation-resend',cookie,
    body:{email,invite_binding:'Y'.repeat(43)}});
  assert.equal(mismatchedResend.statusCode,202);
  assert.deepEqual(mismatchedResend.body,{
    ok:true,pending:true,message:'If a pending activation exists, a new verification email will arrive shortly.',
  });
  assert.equal(mismatchedResend.headers['set-cookie'],undefined);
  assert.equal(Number((await db.execute(`SELECT COUNT(*) AS count FROM auth_email_activations`)).rows[0].count),1,
    'wrong emails and mismatched bindings must not create pending activations');
  assert.equal(Number((await db.execute({sql:`SELECT COUNT(*) AS count FROM outbox_events
    WHERE event_type=?`,args:[EMAIL_ACTIVATION_EVENT_TYPE]})).rows[0].count),2,
  'wrong emails and mismatched bindings must not queue delivery');
  assert.equal(Number((await db.execute({sql:'SELECT COUNT(*) AS count FROM auth_accounts WHERE email=?',args:[email]})).rows[0].count),0);
  const outbox=(await db.execute(`SELECT payload_json FROM outbox_events
    WHERE event_type='auth.emailverification.requested' ORDER BY id DESC LIMIT 1`)).rows[0];
  const token=openEmailActivationToken(JSON.parse(outbox.payload_json).token_envelope);
  const verified=await invoke({endpoint:'activation-verify',body:{token}});
  assert.equal(verified.statusCode,200);
  assert.equal(verified.body.status,'verified');
  assert.match(String(verified.headers['set-cookie']),/randori_session=/);
  const replay=await invoke({endpoint:'activation-verify',body:{token}});
  assert.equal(replay.statusCode,409);
  assert.equal(replay.body.status,'used');
});

test('production activation is absent when its encryption configuration is missing',async()=>{
  const {cookie,binding}=await fixture();
  delete process.env.EMAIL_VERIFICATION_ENCRYPTION_KEY;
  const capabilities=response();
  await authHandler({method:'GET',url:'/api/auth/capabilities',query:{endpoint:'capabilities'},
    headers:{host:'randori.example.test','x-forwarded-proto':'https'}},capabilities);
  assert.equal(capabilities.body.capabilities.passwordSignup,false);
  assert.equal(capabilities.body.capabilities.verifiedEmailActivation,false);
  const signup=await invoke({endpoint:'signup',cookie,
    body:{email:'member@example.test',password:'correct horse battery',name:'Invited Member',invite_binding:binding}});
  assert.equal(signup.statusCode,503);
});

test('production activation is absent when provider delivery configuration is incomplete',async()=>{
  const {cookie,binding}=await fixture();
  delete process.env.RESEND_FROM;
  const capabilities=response();
  await authHandler({method:'GET',url:'/api/auth/capabilities',query:{endpoint:'capabilities'},
    headers:{host:'randori.example.test','x-forwarded-proto':'https'}},capabilities);
  assert.equal(capabilities.body.capabilities.passwordSignup,false);
  assert.equal(capabilities.body.capabilities.verifiedEmailActivation,false);
  const signup=await invoke({endpoint:'signup',cookie,
    body:{email:'member@example.test',password:'correct horse battery',name:'Invited Member',invite_binding:binding}});
  assert.equal(signup.statusCode,503);
});

test('verification attempts are durably IP-rate-limited before untrusted tokens can keep opening transactions',async()=>{
  const {db}=await fixture();
  const statuses=[];
  for(let attempt=0;attempt<21;attempt+=1){
    statuses.push((await invoke({endpoint:'activation-verify',body:{token:'D'.repeat(43)}})).statusCode);
  }
  assert.deepEqual(statuses.slice(0,20),Array(20).fill(409));
  assert.equal(statuses[20],429);
  const limits=await db.execute(`SELECT attempts FROM auth_rate_limits`);
  assert.equal(limits.rows.length,1);
  assert.equal(Number(limits.rows[0].attempts),21);
});
