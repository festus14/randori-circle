// Production readiness regression (2026-10-22): the first invitee who joined
// through password sign-up + email activation recorded `activation.verified`
// instead of `invitation.accepted`, so membership readiness counted the account
// as having invalid provenance and /api/health/ready plus pairing readiness
// failed. These tests run the real activation code path on a migrated SQLite
// file and check every readiness consumer against it.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, test } from 'node:test';

import { createClient } from '@libsql/client';
import bcrypt from 'bcryptjs';

import {
  activationKeyRing,
  openEmailActivationToken,
  requestEmailActivation,
  verifyEmailActivation,
} from '../../api/_email-activation.js';
import { createInvitationToken, hashInvitationEmail, hashInvitationToken } from '../../api/_circle-membership.js';
import { inspectDatabaseReadiness } from '../../api/_health.js';
import { pairingSchemaV6Ready } from '../../api/_pairing-readiness.js';
import { EXECUTABLE_MIGRATIONS } from '../../db/executable-migrations.js';
import {
  inspectCompletedMembershipRollout,
  inspectMembershipAdoptionReadiness,
  inspectMembershipRolloutReadiness,
} from '../../db/membership-readiness.js';
import { applyMigrations, inspectMigrationState, prepareMigrationConnection } from '../../db/migration-runner.js';
import { adoptCredentialKeyControl } from '../support/credential-key-control.mjs';
import { createMigratedDatabase } from '../support/migrated-db.mjs';

const JWT_SECRET='membership-activation-provenance-secret-at-least-32-bytes';
const ENCRYPTION_KEY=Buffer.alloc(32,9).toString('base64url');
const NOW=Math.floor(Date.now()/1000);
const CIRCLE_ID=10;
const INVITATION_ID='22222222-2222-4222-8222-222222222222';
const SPARE_INVITATION_ID='33333333-3333-4333-8333-333333333333';
const NO_RETRY=Object.freeze({maxAttempts:1,baseDelayMs:0,maxDelayMs:0});
const resources=[];

afterEach(()=>{
  while(resources.length){ try{ resources.pop()(); }catch{} }
});

function configureActivationEnv(){
  process.env.JWT_SECRET=JWT_SECRET;
  process.env.EMAIL_VERIFICATION_ENCRYPTION_KEY=ENCRYPTION_KEY;
  process.env.EMAIL_PASSWORD_ACTIVATION_ENABLED='true';
  process.env.CIRCLE_MEMBERSHIP_ENABLED='true';
  process.env.APP_URL='https://randori.example.test';
}

// The steady state production reached before the incident: one primary circle
// created and backfilled by its owner, rollout closed.
async function seedCompletedRollout(db){
  await db.batch([
    `INSERT INTO auth_accounts (id,email,password_hash,display_name,color,is_admin)
      VALUES (1,'owner@example.test','!owner','Owner','#111111',1)`,
    `INSERT INTO circles (id,public_id,slug,name,is_primary,created_by,created_at)
      VALUES (${CIRCLE_ID},'11111111-1111-4111-8111-111111111111','randori-circle','Randori Circle',1,1,datetime('now'))`,
    `INSERT INTO circle_memberships (circle_id,user_id,role,status,joined_at,updated_at)
      VALUES (${CIRCLE_ID},1,'owner','active',datetime('now'),datetime('now'))`,
    `INSERT INTO circle_audit_events (circle_id,event_type,actor_user_id,subject_user_id,dedupe_key)
      VALUES (${CIRCLE_ID},'membership.backfilled',1,1,'membership-backfilled:${CIRCLE_ID}:1')`,
    `INSERT INTO circle_audit_events (circle_id,event_type,actor_user_id,subject_user_id,dedupe_key)
      VALUES (${CIRCLE_ID},'membership.backfill.completed',1,NULL,'primary-membership-backfill:${CIRCLE_ID}:v1')`,
    `UPDATE circle_membership_rollout SET registrations_closed=1,updated_at=datetime('now') WHERE id=1`,
  ],'write');
}

async function invite(db,email,id=INVITATION_ID){
  const token=createInvitationToken();
  const tokenHash=hashInvitationToken(token);
  const emailHash=hashInvitationEmail(email);
  await db.execute({
    sql:`INSERT INTO circle_invitations
      (id,circle_id,token_hash,email_hash,created_by,created_at,expires_at)
      VALUES (?,?,?,?,1,datetime('now'),datetime('now','+1 day'))`,
    args:[id,CIRCLE_ID,tokenHash,emailHash],
  });
  return {invitation_id:id,circle_id:CIRCLE_ID,token_hash:tokenHash,email_hash:emailHash};
}

// Invite -> password sign-up request -> emailed token -> verify, all through
// the production functions in api/_email-activation.js.
async function joinThroughActivation(db,email='member@example.test'){
  const claim=await invite(db,email);
  const requested=await requestEmailActivation(db,{
    claim,email,passwordHash:await bcrypt.hash('correct horse battery',4),
    displayName:'Invited Member',color:'#123456',
  },{nowSeconds:NOW});
  assert.equal(requested.accepted,true);
  const outbox=(await db.execute(`SELECT payload_json FROM outbox_events
    WHERE event_type='auth.emailverification.requested' ORDER BY id DESC LIMIT 1`)).rows[0];
  const token=openEmailActivationToken(JSON.parse(String(outbox.payload_json)).token_envelope);
  const verified=await verifyEmailActivation(db,{token},{nowSeconds:NOW+60});
  assert.equal(verified.status,'verified');
  return verified.user.id;
}

async function activatedFixture(){
  configureActivationEnv();
  const {directory,url}=await createMigratedDatabase({
    prefix:'randori-activation-provenance-',filename:'readiness.sqlite',
  });
  const db=createClient({url});
  resources.push(()=>{ db.close(); rmSync(directory,{recursive:true,force:true}); });
  await prepareMigrationConnection(db);
  await adoptCredentialKeyControl(db,activationKeyRing());
  await seedCompletedRollout(db);
  const memberId=await joinThroughActivation(db);
  return {db,memberId};
}

// Applies forged rows inside a write transaction, inspects through it, and
// rolls back so each forgery is checked against the same valid baseline.
async function withForgery(db,statements,inspect){
  const transaction=await db.transaction('write');
  try{
    for(const statement of statements) await transaction.execute(statement);
    return await inspect(transaction);
  }finally{
    await transaction.rollback();
  }
}

async function assertAccountAuditInvalid(db,statements,{malformed,invalidProvenance},label){
  await withForgery(db,statements,async transaction=>{
    for(const [name,inspect] of [
      ['completed',inspectCompletedMembershipRollout],
      ['adoption',inspectMembershipAdoptionReadiness],
    ]){
      const result=await inspect(transaction);
      assert.equal(result.ok,false,`${label}: ${name} must fail`);
      assert.ok(result.blockers.includes('closed_rollout_account_audit_invalid'),
        `${label}: ${name} blockers ${JSON.stringify(result.blockers)}`);
      assert.equal(result.counts.malformedActivationAudits,malformed,`${label}: ${name} malformed`);
      assert.equal(result.counts.invalidAccountProvenance,invalidProvenance,`${label}: ${name} provenance`);
    }
  });
}

test('an invitee who joined by email activation keeps health, pairing and migration readiness green',async()=>{
  const {db,memberId}=await activatedFixture();
  assert.equal(memberId,2);
  const audit=(await db.execute(`SELECT event.circle_id,event.actor_user_id,event.subject_user_id,
      event.invitation_id,event.dedupe_key,activation.id AS activation_id,activation.used_at
    FROM circle_audit_events event
    JOIN auth_email_activations activation ON activation.invitation_id=event.invitation_id
    WHERE event.event_type='activation.verified'`)).rows;
  assert.equal(audit.length,1);
  assert.equal(Number(audit[0].circle_id),CIRCLE_ID);
  assert.equal(Number(audit[0].actor_user_id),2);
  assert.equal(Number(audit[0].subject_user_id),2);
  assert.equal(String(audit[0].invitation_id),INVITATION_ID);
  assert.equal(String(audit[0].dedupe_key),`activation-verified:${audit[0].activation_id}`);
  assert.notEqual(audit[0].used_at,null);
  assert.equal(Number((await db.execute(`SELECT COUNT(*) AS count FROM circle_audit_events
    WHERE event_type='invitation.accepted'`)).rows[0].count),0,'the activation path never writes invitation.accepted');

  const completed=await inspectCompletedMembershipRollout(db);
  assert.deepEqual(completed.blockers,[]);
  assert.equal(completed.ok,true);
  assert.equal(completed.counts.invalidAccountProvenance,0);
  assert.equal(completed.counts.malformedActivationAudits,0);

  const adoption=await inspectMembershipAdoptionReadiness(db);
  assert.deepEqual(adoption.blockers,[]);
  assert.equal(adoption.ok,true);
  assert.equal(adoption.counts.malformedActivationAudits,0);
  assert.equal((await inspectMembershipRolloutReadiness(db)).ok,true);

  // The exact consumers that returned 503 / failed in production.
  assert.equal(await inspectDatabaseReadiness(db),true);
  assert.equal(await inspectDatabaseReadiness(db,{membershipRequired:true}),true);
  assert.equal(await pairingSchemaV6Ready(db,{requireClosedMembership:true}),true);

  // A future protected migration cutover inspects the same adoption evidence.
  const migrationState=await inspectMigrationState(db);
  assert.equal(migrationState.ready,true);
  assert.equal(migrationState.adoption.membership.ok,true);
});

test('forged or inconsistent activation audits fail readiness closed',async()=>{
  const {db}=await activatedFixture();
  const event=`event_type='activation.verified' AND subject_user_id=2`;
  await invite(db,'spare@example.test',SPARE_INVITATION_ID);
  assert.equal((await inspectCompletedMembershipRollout(db)).ok,true,'an unused spare invitation is harmless');

  await assertAccountAuditInvalid(db,[`UPDATE circle_audit_events SET actor_user_id=1 WHERE ${event}`],
    {malformed:1,invalidProvenance:1},'mismatched actor');
  await assertAccountAuditInvalid(db,[`UPDATE circle_audit_events SET subject_user_id=1 WHERE ${event}`],
    {malformed:1,invalidProvenance:1},'mismatched subject');
  await assertAccountAuditInvalid(db,[
    `UPDATE circle_audit_events SET invitation_id='${SPARE_INVITATION_ID}' WHERE ${event}`,
  ],{malformed:1,invalidProvenance:1},'mismatched invitation');
  await assertAccountAuditInvalid(db,[
    `UPDATE circle_audit_events SET dedupe_key='activation-verified:44444444-4444-4444-8444-444444444444' WHERE ${event}`,
  ],{malformed:1,invalidProvenance:1},'mismatched activation dedupe key');
  await assertAccountAuditInvalid(db,[
    `UPDATE circle_audit_events SET dedupe_key='invite-accepted:${INVITATION_ID}' WHERE ${event}`,
  ],{malformed:1,invalidProvenance:1},'invitation dedupe key on an activation event');
  await assertAccountAuditInvalid(db,[`UPDATE auth_email_activations SET used_at=NULL`],
    {malformed:1,invalidProvenance:1},'unused activation');
  await assertAccountAuditInvalid(db,[
    `INSERT INTO circles (id,public_id,slug,name,is_primary,created_by)
      VALUES (11,'55555555-5555-4555-8555-555555555555','other-circle','Other',0,1)`,
    `UPDATE auth_email_activations SET circle_id=11`,
  ],{malformed:1,invalidProvenance:1},'activation from another circle');
  await assertAccountAuditInvalid(db,[
    `UPDATE circle_invitations SET revoked_at=datetime('now') WHERE id='${INVITATION_ID}'`,
  ],{malformed:1,invalidProvenance:1},'revoked invitation');
  await assertAccountAuditInvalid(db,[
    `UPDATE circle_invitations SET used_by=1 WHERE id='${INVITATION_ID}'`,
  ],{malformed:1,invalidProvenance:1},'invitation used by another account');
  await assertAccountAuditInvalid(db,[`UPDATE auth_accounts SET is_demo=1 WHERE id=2`],
    {malformed:1,invalidProvenance:0},'demo subject');
  await assertAccountAuditInvalid(db,[`DELETE FROM circle_audit_events WHERE ${event}`],
    {malformed:0,invalidProvenance:1},'missing activation audit');
  // Every account already has valid provenance, yet a stray activation audit
  // with no matching activation is still rejected.
  await assertAccountAuditInvalid(db,[
    `INSERT INTO circle_audit_events (circle_id,event_type,actor_user_id,subject_user_id,invitation_id,dedupe_key)
      VALUES (${CIRCLE_ID},'activation.verified',1,1,'${SPARE_INVITATION_ID}','activation-verified:forged')`,
  ],{malformed:1,invalidProvenance:0},'stray forged activation audit');

  // The baseline is untouched after every rolled-back forgery.
  assert.equal(await inspectDatabaseReadiness(db,{membershipRequired:true}),true);
  assert.equal(await pairingSchemaV6Ready(db,{requireClosedMembership:true}),true);
});

test('before the v7 activation ledger exists, any activation audit is malformed',async()=>{
  const directory=mkdtempSync(join(tmpdir(),'randori-activation-v6-'));
  const db=createClient({url:`file:${join(directory,'v6.sqlite')}`});
  resources.push(()=>{ db.close(); rmSync(directory,{recursive:true,force:true}); });
  await prepareMigrationConnection(db);
  const migrations=EXECUTABLE_MIGRATIONS.slice(0,6);
  assert.equal(migrations.at(-1).version,6);
  const initial=await inspectMigrationState(db,{migrations});
  await applyMigrations(db,{migrations,expectedStateFingerprint:initial.stateFingerprint,retry:NO_RETRY});
  assert.equal(Number((await db.execute(`SELECT COUNT(*) AS count FROM sqlite_schema
    WHERE name='auth_email_activations'`)).rows[0].count),0);
  await seedCompletedRollout(db);

  assert.equal((await inspectCompletedMembershipRollout(db)).ok,true);
  assert.equal((await inspectMembershipAdoptionReadiness(db)).ok,true);
  await db.execute(`INSERT INTO circle_audit_events
    (circle_id,event_type,actor_user_id,subject_user_id,invitation_id,dedupe_key)
    VALUES (${CIRCLE_ID},'activation.verified',1,1,NULL,'activation-verified:pre-v7')`);
  for(const inspect of [inspectCompletedMembershipRollout,inspectMembershipAdoptionReadiness]){
    const result=await inspect(db);
    assert.equal(result.ok,false);
    assert.equal(result.counts.malformedActivationAudits,1);
    assert.ok(result.blockers.includes('closed_rollout_account_audit_invalid'));
  }
});
