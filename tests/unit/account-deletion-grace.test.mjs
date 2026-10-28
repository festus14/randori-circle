// Issue #372 account-deletion grace period against a real migrated SQLite
// database: request locks the account and schedules deletion, cancelling
// restores it exactly, the cron job executes due deletions with a
// controlled clock, locked accounts get no mail and are not paired,
// confirmation + reminder go out once each, and the last-owner / last-admin
// rules hold at execution time.
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { afterEach, test } from 'node:test';

import { createClient } from '@libsql/client';

import {
  DELETED_ACCOUNT_PASSWORD_HASH,
  DELETED_MEMBER_NAME,
  executeScheduledAccountDeletion,
} from '../../api/_account-deletion.js';
import {
  ACCOUNT_DELETION_BLOCKED_EVENT_TYPE,
  ACCOUNT_DELETION_CONFIRMATION_EVENT_TYPE,
  ACCOUNT_DELETION_REMINDER_EVENT_TYPE,
  DELETION_GRACE_SECONDS,
  accountDeletionGraceEnabled,
  cancelAccountDeletion,
  createAccountDeletionEmailHandler,
  graceSchemaAvailable,
  isDeletionPending,
  requestAccountDeletion,
  runAccountDeletionGraceJobs,
} from '../../api/_account-deletion-grace.js';
import { initializeLocalPrimaryCircleData } from '../../api/_admin-init.js';
import { hashInvitationEmail } from '../../api/_circle-membership.js';
import { issueSession, verifyRequestAuth, verifySignedRequestAuth } from '../../api/_db.js';
import { inspectDatabaseReadiness } from '../../api/_health.js';
import { pairingSchemaV6Ready } from '../../api/_pairing-readiness.js';
import { inspectMembershipRolloutReadiness } from '../../db/membership-readiness.js';
import { EXECUTABLE_MIGRATIONS } from '../../db/executable-migrations.js';
import { MIGRATION_CONTRACTS } from '../../db/migration-contract.js';
import { applyMigrations, inspectMigrationState, prepareMigrationConnection } from '../../db/migration-runner.js';
import { readMigrationLedger, validateMigrationLedger } from '../../db/migration-ledger-readiness.js';
import { ledgerReadiness } from '../../db/migration-compatibility.js';
import { createMigratedDatabase } from '../support/migrated-db.mjs';

const JWT_SECRET='account-deletion-grace-test-secret-at-least-32-bytes';
const NOW=1_750_000_000;
const ISO=new Date(NOW*1000).toISOString();
const SCHEDULED_ISO=new Date((NOW+DELETION_GRACE_SECONDS)*1000).toISOString();
const HEX=character=>character.repeat(64);
const MEMBER=2;
const MEMBER_EMAIL='member@example.test';
const resources=[];
const originalSecret=process.env.JWT_SECRET;

afterEach(async()=>{
  while(resources.length){ try{ await resources.pop()(); }catch{} }
  if(originalSecret===undefined) delete process.env.JWT_SECRET; else process.env.JWT_SECRET=originalSecret;
  for(const key of ['ACCOUNT_DELETION_ENABLED','ACCOUNT_DELETION_GRACE_ENABLED','CIRCLE_MEMBERSHIP_ENABLED',
    'REMINDERS_ENABLED','FEEDBACK_ENABLED'])
    delete process.env[key];
});

async function database(){
  const {directory,url}=await createMigratedDatabase({prefix:'randori-account-deletion-grace-'});
  const db=createClient({url});
  resources.push(async()=>{ db.close(); rmSync(directory,{recursive:true,force:true}); });
  await prepareMigrationConnection(db);
  process.env.JWT_SECRET=JWT_SECRET;
  return {db,url};
}

async function fixture(){
  const {db,url}=await database();
  await db.batch([
    `INSERT INTO auth_accounts (id,email,password_hash,display_name,color,is_admin,is_demo,bio,phone)
      VALUES (1,'owner@example.test','$2a$10$owner','Owner','#111111',1,0,NULL,NULL),
      (3,'partner@example.test','$2a$10$partner','Partner','#333333',0,0,NULL,NULL),
      (4,'zoe@example.test','$2a$10$zoe','Zoe','#444444',0,0,NULL,NULL),
      (5,'demo@example.test','demo','Demo','#555555',0,1,NULL,NULL)`,
  ],'write');
  await initializeLocalPrimaryCircleData(db,{ownerUserId:1,ownerEmails:['owner@example.test'],
    randomUuid:()=>'11111111-1111-4111-8111-111111111111'});
  await db.batch([
    {sql:`INSERT INTO auth_accounts (id,email,password_hash,display_name,color,is_admin,is_demo,bio,phone)
      VALUES (2,?,'$2a$10$member','Member','#222222',0,0,'Keeps notes','+44 7700 900123')`,args:[MEMBER_EMAIL]},
    `INSERT INTO circle_memberships (circle_id,user_id,role,status,invited_by) VALUES (1,2,'member','active',1)`,
    {sql:`INSERT INTO circle_invitations (id,circle_id,token_hash,email_hash,created_by,created_at,expires_at,used_at,used_by)
      VALUES ('22222222-2222-4222-8222-222222222222',1,?,?,1,?,'2098-09-20T12:00:00.000Z',?,2)`,
    args:[HEX('a'),hashInvitationEmail(MEMBER_EMAIL),ISO,ISO]},
    {sql:`INSERT INTO circle_audit_events (circle_id,event_type,actor_user_id,subject_user_id,invitation_id,dedupe_key,created_at)
      VALUES (1,'invitation.accepted',2,2,?,? ,?)`,
    args:['22222222-2222-4222-8222-222222222222','invite-accepted:22222222-2222-4222-8222-222222222222',ISO]},
    // A still-usable invitation to the member from another owner: cancelling
    // must not reopen or revoke it (it was never closed).
    {sql:`INSERT INTO circle_invitations (id,circle_id,token_hash,email_hash,created_by,created_at,expires_at)
      VALUES ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',1,?,?,1,?,'2098-09-20T12:00:00.000Z')`,
    args:[HEX('b'),hashInvitationEmail(MEMBER_EMAIL),ISO]},
    `INSERT INTO circles (id,public_id,slug,name,is_primary,created_by,archived_at) VALUES
      (20,'circle-twenty','twenty','Night Owls',0,4,NULL)`,
    `INSERT INTO circle_memberships (circle_id,user_id,role,status,invited_by) VALUES (20,4,'owner','active',NULL)`,
    `INSERT INTO circle_memberships (circle_id,user_id,role,status,invited_by) VALUES (20,3,'member','active',4)`,
    `INSERT INTO circle_memberships (circle_id,user_id,role,status,invited_by) VALUES (20,2,'member','active',4)`,
  ],'write');
  return {db,url};
}

// JWT-only session: works for locked accounts, whose fresh sign-in session is
// exactly what the cancel flow verifies.
async function session(db,id,email,{at=NOW}={}){
  const token=await issueSession(db,{id,email,name:`User ${id}`},{recentAuthMethod:'password',nowSeconds:at});
  return verifySignedRequestAuth({headers:{cookie:`randori_session=${encodeURIComponent(token)}`}},
    {nowSeconds:at});
}

// Full verification: null for locked accounts, the payload once restored.
async function verifiedSession(db,id,email,{at=NOW}={}){
  const token=await issueSession(db,{id,email,name:`User ${id}`},{recentAuthMethod:'password',nowSeconds:at});
  return verifyRequestAuth({headers:{cookie:`randori_session=${encodeURIComponent(token)}`}},db,{nowSeconds:at});
}

function sessionHashFor(tokenPayload){
  return tokenPayload?.sessionHash;
}

async function one(db,sql,args=[]){
  const result=await db.execute({sql,args});
  return result.rows[0]||null;
}

async function count(db,sql,args=[]){
  return Number((await one(db,sql,args))?.count||0);
}

async function pendingRow(db,userId=MEMBER){
  return one(db,`SELECT * FROM account_deletion_requests WHERE user_id=? ORDER BY id DESC LIMIT 1`,[userId]);
}

async function outboxRows(db,type){
  const result=await db.execute({sql:`SELECT * FROM outbox_events WHERE event_type=? ORDER BY id`,args:[type]});
  return result.rows||[];
}

async function auditEvents(db,type,userId=MEMBER){
  const result=await db.execute({
    sql:`SELECT * FROM circle_audit_events WHERE event_type=? AND subject_user_id=? ORDER BY id`,
    args:[type,userId]});
  return result.rows||[];
}

async function request(db,{at=NOW,sessionAt=NOW}={}){
  const payload=await session(db,MEMBER,MEMBER_EMAIL,{at:sessionAt});
  return requestAccountDeletion(db,{userId:MEMBER,sessionHash:sessionHashFor(payload),
    adminEmails:[],nowSeconds:at});
}

test('flag: grace needs both flags',()=>{
  assert.equal(accountDeletionGraceEnabled({}),false);
  assert.equal(accountDeletionGraceEnabled({ACCOUNT_DELETION_ENABLED:'true',CIRCLE_MEMBERSHIP_ENABLED:'true'}),false);
  assert.equal(accountDeletionGraceEnabled({ACCOUNT_DELETION_ENABLED:'true',CIRCLE_MEMBERSHIP_ENABLED:'true',ACCOUNT_DELETION_GRACE_ENABLED:'true'}),true);
  assert.equal(accountDeletionGraceEnabled({ACCOUNT_DELETION_ENABLED:'true',CIRCLE_MEMBERSHIP_ENABLED:'true',ACCOUNT_DELETION_GRACE_ENABLED:'false'}),false);
});

test('request locks the account, schedules +14 days, keeps every personal column, and enqueues one confirmation',async()=>{
  const {db}=await fixture();
  const result=await request(db);
  assert.equal(result.ok,true,JSON.stringify(result));
  assert.equal(result.status,'pending_deletion');
  assert.equal(result.scheduled_for,SCHEDULED_ISO);
  assert.equal((await pendingRow(db))?.scheduled_for,NOW+DELETION_GRACE_SECONDS);
  // Personal data untouched: cancelling restores exactly this.
  const account=await one(db,`SELECT bio,phone,display_name,email FROM auth_accounts WHERE id=?`,[MEMBER]);
  assert.deepEqual([account.bio,account.phone,account.display_name,account.email],
    ['Keeps notes','+44 7700 900123','Member',MEMBER_EMAIL]);
  assert.equal((await one(db,`SELECT status FROM circle_memberships WHERE circle_id=1 AND user_id=?`,[MEMBER]))?.status,'active');
  // Every session revoked — including the requester's own.
  assert.equal(await count(db,`SELECT COUNT(*) AS count FROM auth_sessions WHERE user_id=? AND revoked_at IS NULL`,[MEMBER]),0);
  // Locked: a fresh sign-in session verifies as nothing through verifyRequestAuth.
  assert.equal(await verifiedSession(db,MEMBER,MEMBER_EMAIL,{at:NOW+60}),null);
  assert.equal(await isDeletionPending(db,MEMBER),true);
  // One confirmation outbox row with a stable idempotency key.
  const confirmations=await outboxRows(db,ACCOUNT_DELETION_CONFIRMATION_EVENT_TYPE);
  assert.equal(confirmations.length,1);
  assert.equal(confirmations[0].idempotency_key,`account-deletion-confirmation/v1/${MEMBER}/${NOW}`);
  // One requested audit event per circle the member belongs to (1 and 20).
  assert.equal((await auditEvents(db,'account.deletion_requested')).length,2);
  // A second request is already_pending, not a second row or a second email.
  const again=await request(db,{at:NOW+120,sessionAt:NOW+120});
  assert.deepEqual({ok:again.ok,reason:again.reason,scheduled_for:again.scheduled_for},
    {ok:false,reason:'already_pending',scheduled_for:SCHEDULED_ISO});
  assert.equal(await count(db,`SELECT COUNT(*) AS count FROM account_deletion_requests WHERE user_id=?`,[MEMBER]),1);
  assert.equal((await outboxRows(db,ACCOUNT_DELETION_CONFIRMATION_EVENT_TYPE)).length,1);
});

test('request refuses last-owner, last-admin and demo accounts',async()=>{
  const {db}=await fixture();
  // Member becomes the only owner of circle 20.
  await db.execute({sql:`UPDATE circle_memberships SET role='owner' WHERE circle_id=20 AND user_id=?`,args:[MEMBER]});
  await db.execute({sql:`UPDATE circle_memberships SET status='inactive' WHERE circle_id=20 AND user_id=4`});
  const ownerBlocked=await request(db);
  assert.deepEqual({ok:ownerBlocked.ok,reason:ownerBlocked.reason},{ok:false,reason:'last_owner'});
  assert.equal(await count(db,`SELECT COUNT(*) AS count FROM account_deletion_requests`),0);
  // Restore a co-owner, then make the member the only admin.
  await db.execute({sql:`UPDATE circle_memberships SET status='active' WHERE circle_id=20 AND user_id=4`});
  await db.execute({sql:`UPDATE circle_memberships SET role='member' WHERE circle_id=20 AND user_id=?`,args:[MEMBER]});
  await db.execute({sql:`UPDATE auth_accounts SET is_admin=1 WHERE id=?`,args:[MEMBER]});
  await db.execute({sql:`UPDATE auth_accounts SET is_admin=0 WHERE id=1`});
  const adminBlocked=await request(db);
  assert.deepEqual({ok:adminBlocked.ok,reason:adminBlocked.reason},{ok:false,reason:'last_admin'});
  // Demo accounts cannot request: executeScheduled / request path refuses via eligibility.
  const demoPayload=await session(db,5,'demo@example.test',{at:NOW});
  const demo=await requestAccountDeletion(db,{userId:5,sessionHash:sessionHashFor(demoPayload),
    adminEmails:[],nowSeconds:NOW});
  assert.deepEqual({ok:demo.ok,reason:demo.reason},{ok:false,reason:'demo_account'});
});

test('cancel restores the account exactly: membership, data, session, invitation untouched',async()=>{
  const {db}=await fixture();
  assert.equal((await request(db)).ok,true);
  const cancelPayload=await session(db,MEMBER,MEMBER_EMAIL,{at:NOW+60});
  assert.ok(cancelPayload,'a fresh sign-in session exists for the cancel flow');
  const cancelled=await cancelAccountDeletion(db,{userId:MEMBER,
    sessionHash:sessionHashFor(cancelPayload),nowSeconds:NOW+60});
  assert.deepEqual({ok:cancelled.ok,status:cancelled.status,scheduled_for:cancelled.scheduled_for},
    {ok:true,status:'cancelled',scheduled_for:SCHEDULED_ISO});
  const row=await pendingRow(db);
  assert.equal(row.cancelled_at,NOW+60);
  assert.equal(row.executed_at,null);
  // The cancel session itself keeps working: the account is restored.
  assert.notEqual(await verifiedSession(db,MEMBER,MEMBER_EMAIL,{at:NOW+61}),null);
  const account=await one(db,`SELECT bio,phone,display_name,email FROM auth_accounts WHERE id=?`,[MEMBER]);
  assert.deepEqual([account.bio,account.phone,account.display_name,account.email],
    ['Keeps notes','+44 7700 900123','Member',MEMBER_EMAIL]);
  assert.equal((await one(db,`SELECT status FROM circle_memberships WHERE circle_id=1 AND user_id=?`,[MEMBER]))?.status,'active');
  // The still-usable invitation was NOT reopened or revoked.
  const invitation=await one(db,`SELECT revoked_at,used_at FROM circle_invitations WHERE id='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'`);
  assert.deepEqual([invitation.revoked_at,invitation.used_at],[null,null]);
  // One cancelled audit event per circle (1 and 20).
  assert.equal((await auditEvents(db,'account.deletion_cancelled')).length,2);
  // Cancelling again is not_pending.
  const again=await cancelAccountDeletion(db,{userId:MEMBER,
    sessionHash:sessionHashFor(cancelPayload),nowSeconds:NOW+120});
  assert.deepEqual({ok:again.ok,reason:again.reason},{ok:false,reason:'not_pending'});
});

test('a re-request after cancelling starts a new 14 days',async()=>{
  const {db}=await fixture();
  assert.equal((await request(db)).ok,true);
  const cancelPayload=await session(db,MEMBER,MEMBER_EMAIL,{at:NOW+60});
  assert.equal((await cancelAccountDeletion(db,{userId:MEMBER,
    sessionHash:sessionHashFor(cancelPayload),nowSeconds:NOW+60})).ok,true);
  const secondAt=NOW+3600;
  const secondPayload=await session(db,MEMBER,MEMBER_EMAIL,{at:secondAt});
  const second=await requestAccountDeletion(db,{userId:MEMBER,
    sessionHash:sessionHashFor(secondPayload),adminEmails:[],nowSeconds:secondAt});
  assert.equal(second.ok,true);
  assert.equal(second.scheduled_for,new Date((secondAt+DELETION_GRACE_SECONDS)*1000).toISOString());
  assert.equal(await count(db,`SELECT COUNT(*) AS count FROM account_deletion_requests WHERE user_id=?`,[MEMBER]),2);
  const rows=await db.execute({sql:`SELECT cancelled_at,scheduled_for FROM account_deletion_requests WHERE user_id=? ORDER BY id`,args:[MEMBER]});
  assert.equal(rows.rows[0].cancelled_at,secondAt-3540);
  assert.equal(rows.rows[1].scheduled_for,secondAt+DELETION_GRACE_SECONDS);
});

test('the cron job ignores not-due requests and enqueues one 48h reminder, idempotently',async()=>{
  const {db}=await fixture();
  assert.equal((await request(db)).ok,true);
  const early=await runAccountDeletionGraceJobs(db,{nowSeconds:NOW+DELETION_GRACE_SECONDS-49*3600,
    adminEmails:[],hashInvitationEmail});
  assert.deepEqual({executed:early.executed,blocked:early.blocked,reminders_queued:early.reminders_queued},
    {executed:0,blocked:0,reminders_queued:0});
  const window=await runAccountDeletionGraceJobs(db,{nowSeconds:NOW+DELETION_GRACE_SECONDS-48*3600,
    adminEmails:[],hashInvitationEmail});
  assert.equal(window.reminders_queued,1);
  const reminders=await outboxRows(db,ACCOUNT_DELETION_REMINDER_EVENT_TYPE);
  assert.equal(reminders.length,1);
  assert.equal(reminders[0].idempotency_key,`account-deletion-reminder/v1/${MEMBER}/${NOW+DELETION_GRACE_SECONDS}`);
  const rerun=await runAccountDeletionGraceJobs(db,{nowSeconds:NOW+DELETION_GRACE_SECONDS-47*3600,
    adminEmails:[],hashInvitationEmail});
  assert.equal(rerun.reminders_queued,0,'the reminder row is never duplicated');
  assert.equal((await outboxRows(db,ACCOUNT_DELETION_REMINDER_EVENT_TYPE)).length,1);
  assert.equal(await isDeletionPending(db,MEMBER),true,'still pending: no execution before the date');
});

test('the cron job executes on day 14, tombstones, and never executes twice',async()=>{
  const {db}=await fixture();
  assert.equal((await request(db)).ok,true);
  const due=await runAccountDeletionGraceJobs(db,{nowSeconds:NOW+DELETION_GRACE_SECONDS,
    adminEmails:[],hashInvitationEmail});
  assert.deepEqual({executed:due.executed,blocked:due.blocked,errors:due.errors},
    {executed:1,blocked:0,errors:[]});
  const account=await one(db,`SELECT email,password_hash,display_name FROM auth_accounts WHERE id=?`,[MEMBER]);
  assert.deepEqual([account.email,account.password_hash,account.display_name],
    [`deleted-${MEMBER}@account-deleted.invalid`,DELETED_ACCOUNT_PASSWORD_HASH,DELETED_MEMBER_NAME]);
  const row=await pendingRow(db);
  assert.equal(row.executed_at,NOW+DELETION_GRACE_SECONDS);
  assert.equal((await auditEvents(db,'account.deleted')).length,2,'one per circle');
  const again=await runAccountDeletionGraceJobs(db,{nowSeconds:NOW+DELETION_GRACE_SECONDS+60,
    adminEmails:[],hashInvitationEmail});
  assert.deepEqual({executed:again.executed,blocked:again.blocked,skipped:again.skipped},
    {executed:0,blocked:0,skipped:0});
  // Executing directly after the fact is already_deleted.
  const direct=await executeScheduledAccountDeletion(db,{userId:MEMBER,adminEmails:[],
    hashInvitationEmail,nowSeconds:NOW+DELETION_GRACE_SECONDS+120});
  assert.deepEqual({ok:direct.ok,status:direct.status},{ok:true,status:'already_deleted'});
});

test('a member removed by an owner during the grace period is still deleted on schedule',async()=>{
  const {db}=await fixture();
  assert.equal((await request(db)).ok,true);
  await db.execute({sql:`UPDATE circle_memberships SET status='inactive' WHERE circle_id=1 AND user_id=?`,args:[MEMBER]});
  // They cannot cancel any more: no active membership, so no cancel session.
  const due=await runAccountDeletionGraceJobs(db,{nowSeconds:NOW+DELETION_GRACE_SECONDS,
    adminEmails:[],hashInvitationEmail});
  assert.equal(due.executed,1);
  assert.equal((await one(db,`SELECT password_hash FROM auth_accounts WHERE id=?`,[MEMBER]))?.password_hash,
    DELETED_ACCOUNT_PASSWORD_HASH);
});

test('last-owner at execution keeps the account locked and notifies admins once',async()=>{
  const {db}=await fixture();
  assert.equal((await request(db)).ok,true);
  // After the request the member becomes the only owner of circle 20.
  await db.execute({sql:`UPDATE circle_memberships SET role='owner' WHERE circle_id=20 AND user_id=?`,args:[MEMBER]});
  await db.execute({sql:`UPDATE circle_memberships SET status='inactive' WHERE circle_id=20 AND user_id=4`});
  const blockedRun=await runAccountDeletionGraceJobs(db,{nowSeconds:NOW+DELETION_GRACE_SECONDS,
    adminEmails:[],hashInvitationEmail});
  assert.deepEqual({executed:blockedRun.executed,blocked:blockedRun.blocked,
    blocked_notifications:blockedRun.blocked_notifications},
  {executed:0,blocked:1,blocked_notifications:1});
  assert.equal(await isDeletionPending(db,MEMBER),true,'still locked');
  assert.notEqual((await one(db,`SELECT password_hash FROM auth_accounts WHERE id=?`,[MEMBER]))?.password_hash,
    DELETED_ACCOUNT_PASSWORD_HASH);
  assert.equal((await auditEvents(db,'account.deletion_blocked')).length,2,'one per circle');
  const blocked=await outboxRows(db,ACCOUNT_DELETION_BLOCKED_EVENT_TYPE);
  assert.equal(blocked.length,1);
  assert.equal(blocked[0].idempotency_key,
    `account-deletion-blocked/v1/${MEMBER}/${NOW+DELETION_GRACE_SECONDS}/1`);
  // A second run does not re-notify.
  const rerun=await runAccountDeletionGraceJobs(db,{nowSeconds:NOW+DELETION_GRACE_SECONDS+300,
    adminEmails:[],hashInvitationEmail});
  assert.deepEqual({blocked:rerun.blocked,blocked_notifications:rerun.blocked_notifications},
    {blocked:1,blocked_notifications:0});
  // Once a co-owner exists, the deletion runs.
  await db.execute({sql:`UPDATE circle_memberships SET status='active' WHERE circle_id=20 AND user_id=4`});
  const unblocked=await runAccountDeletionGraceJobs(db,{nowSeconds:NOW+DELETION_GRACE_SECONDS+600,
    adminEmails:[],hashInvitationEmail});
  assert.equal(unblocked.executed,1);
});

test('last-admin at execution blocks, then runs once another admin exists',async()=>{
  const {db}=await fixture();
  assert.equal((await request(db)).ok,true);
  await db.execute({sql:`UPDATE auth_accounts SET is_admin=1 WHERE id=?`,args:[MEMBER]});
  await db.execute({sql:`UPDATE auth_accounts SET is_admin=0 WHERE id=1`});
  const blockedRun=await runAccountDeletionGraceJobs(db,{nowSeconds:NOW+DELETION_GRACE_SECONDS,
    adminEmails:[],hashInvitationEmail});
  assert.deepEqual({executed:blockedRun.executed,blocked:blockedRun.blocked},
    {executed:0,blocked:1});
  await db.execute({sql:`UPDATE auth_accounts SET is_admin=1 WHERE id=1`});
  const unblocked=await runAccountDeletionGraceJobs(db,{nowSeconds:NOW+DELETION_GRACE_SECONDS+60,
    adminEmails:[],hashInvitationEmail});
  assert.equal(unblocked.executed,1);
});

test('emails: confirmation and reminder deliver once; cancelled or executed requests suppress',async()=>{
  const {db}=await fixture();
  assert.equal((await request(db)).ok,true);
  const sent=[];
  const handler=createAccountDeletionEmailHandler({db,baseUrl:'https://randori.example.test',
    send:async message=>{ sent.push(message); return {providerName:'test'}; }});
  const confirmation=(await outboxRows(db,ACCOUNT_DELETION_CONFIRMATION_EVENT_TYPE))[0];
  const confirmationEvent={eventType:confirmation.event_type,eventVersion:confirmation.event_version,
    payload:JSON.parse(confirmation.payload_json),idempotencyKey:confirmation.idempotency_key};
  const delivered=await handler(confirmationEvent,{});
  assert.equal(delivered.status,'delivered');
  assert.equal(sent.length,1);
  assert.equal(sent[0].to,MEMBER_EMAIL);
  assert.match(sent[0].subject,/scheduled for deletion/);
  assert.ok(sent[0].html.includes('29 June 2025'),sent[0].html);
  assert.equal(sent[0].html.includes('unsubscribe'),false,'account emails carry no unsubscribe link');
  // Cancelling suppresses the queued reminder even if it was enqueued.
  await runAccountDeletionGraceJobs(db,{nowSeconds:NOW+DELETION_GRACE_SECONDS-3600,
    adminEmails:[],hashInvitationEmail});
  const reminder=(await outboxRows(db,ACCOUNT_DELETION_REMINDER_EVENT_TYPE))[0];
  const cancelPayload=await session(db,MEMBER,MEMBER_EMAIL,{at:NOW+120});
  assert.equal((await cancelAccountDeletion(db,{userId:MEMBER,
    sessionHash:sessionHashFor(cancelPayload),nowSeconds:NOW+120})).ok,true);
  const suppressed=await handler({eventType:reminder.event_type,eventVersion:reminder.event_version,
    payload:JSON.parse(reminder.payload_json),idempotencyKey:reminder.idempotency_key},{});
  assert.deepEqual(suppressed,{status:'suppressed',reasonCode:'ACCOUNT_DELETION_NOT_PENDING'});
  assert.equal(sent.length,1,'no reminder after cancellation');
});

test('locked accounts get no reminder, pairing, schedule or feedback email',async()=>{
  const {db}=await fixture();
  assert.equal((await request(db)).ok,true);
  const { createReminderEmailHandler, REMINDER_EMAIL_EVENT_VERSION, REMINDER_TEMPLATE_VERSION } =
    await import('../../api/_reminders.js');
  const { createPairingEmailHandler } = await import('../../api/_pairing-email.js');
  const { createScheduleEmailHandler, SCHEDULE_EMAIL_EVENT_VERSION, SCHEDULE_EMAIL_TEMPLATE_VERSION } =
    await import('../../api/_schedule-email.js');
  const { createFeedbackSubmittedHandler, FEEDBACK_SUBMITTED_EVENT_VERSION } =
    await import('../../api/_feedback-notification.js');
  const sent=[];
  const send=async message=>{ sent.push(message); return {providerName:'test'}; };
  // The pending guard sits after each handler's flag check, so the flags
  // must be on for the guard to be reached.
  process.env.REMINDERS_ENABLED='true';
  process.env.FEEDBACK_ENABLED='true';
  const reminderHandler=createReminderEmailHandler({db,baseUrl:'https://randori.example.test',send});
  const reminderSuppressed=await reminderHandler({eventVersion:REMINDER_EMAIL_EVENT_VERSION,
    payload:{kind:'availability_cutoff',circle_id:1,
      cycle_key:HEX('c'),recipient_user_id:MEMBER,template_version:REMINDER_TEMPLATE_VERSION}},{});
  assert.deepEqual(reminderSuppressed,{status:'suppressed',reasonCode:'ACCOUNT_DELETION_PENDING'});
  const pairingHandler=createPairingEmailHandler({db,baseUrl:'https://randori.example.test',send});
  const pairingSuppressed=await pairingHandler({eventVersion:1,
    payload:{kind:'paired',recipient_email:MEMBER_EMAIL,user_id:MEMBER,week_id:1}},{});
  assert.deepEqual(pairingSuppressed,{status:'suppressed',reasonCode:'ACCOUNT_DELETION_PENDING'});
  const scheduleHandler=createScheduleEmailHandler({db,baseUrl:'https://randori.example.test',send});
  // The schedule guard runs after the recipient query (the handler pins
  // that query first), so this unresolvable payload suppresses under its
  // own reason. The invariant is no send.
  const scheduleSuppressed=await scheduleHandler({eventVersion:SCHEDULE_EMAIL_EVENT_VERSION,
    payload:{actor_user_id:1,instant:'2026-01-01T10:00:00.000Z',kind:'changed',pair_group_id:1,previous_instant:'2026-01-01T09:00:00.000Z',
      recipient_user_id:MEMBER,schedule_version:'1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef',
      template_version:SCHEDULE_EMAIL_TEMPLATE_VERSION,week_id:1}},{});
  assert.equal(scheduleSuppressed.status,'suppressed');
  const feedbackHandler=createFeedbackSubmittedHandler({db,baseUrl:'https://randori.example.test',send});
  // As with schedule: the feedback guard runs after the recipient
  // query, so this event (no such item) suppresses under its own reason.
  const feedbackSuppressed=await feedbackHandler({eventVersion:FEEDBACK_SUBMITTED_EVENT_VERSION,
    payload:{feedback_id:'11111111-1111-4111-8111-111111111111',circle_id:1,author_user_id:1,
      recipient_user_id:MEMBER,kind:'bug',title:'A title',template_version:1}},{});
  assert.equal(feedbackSuppressed.status,'suppressed');
  assert.equal(sent.length,0);
});

test('readiness stays green while pending, after cancelling and after deletion',async()=>{
  const {db}=await fixture();
  async function assertReady(label){
    assert.equal(await inspectDatabaseReadiness(db,{membershipRequired:true}),true,`health readiness ${label}`);
    assert.equal(await inspectDatabaseReadiness(db),true,`rollout readiness ${label}`);
    assert.equal(await pairingSchemaV6Ready(db,{requireClosedMembership:true}),true,`pairing readiness ${label}`);
    assert.equal((await inspectMembershipRolloutReadiness(db)).ok,true,`membership readiness ${label}`);
  }
  await assertReady('before request');
  assert.equal((await request(db)).ok,true);
  await assertReady('pending');
  const cancelPayload=await session(db,MEMBER,MEMBER_EMAIL,{at:NOW+60});
  assert.equal((await cancelAccountDeletion(db,{userId:MEMBER,
    sessionHash:sessionHashFor(cancelPayload),nowSeconds:NOW+60})).ok,true);
  await assertReady('cancelled');
  const secondPayload=await session(db,MEMBER,MEMBER_EMAIL,{at:NOW+120});
  assert.equal((await requestAccountDeletion(db,{userId:MEMBER,
    sessionHash:sessionHashFor(secondPayload),adminEmails:[],nowSeconds:NOW+120})).ok,true);
  const executed=await runAccountDeletionGraceJobs(db,{nowSeconds:NOW+120+DELETION_GRACE_SECONDS,
    adminEmails:[],hashInvitationEmail});
  assert.equal(executed.executed,1);
  await assertReady('deleted');
});

test('code at v23 with a v22 database is ready and the lock stays off (additive tolerance)',async()=>{
  const { mkdtempSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const v22dir=mkdtempSync(join(tmpdir(),'randori-grace-v22-'));
  resources.push(()=>rmSync(v22dir,{recursive:true,force:true}));
  const v22=createClient({url:`file:${join(v22dir,'db.sqlite')}`});
  resources.push(async()=>{ v22.close(); });
  await prepareMigrationConnection(v22);
  const initial=await inspectMigrationState(v22,{migrations:EXECUTABLE_MIGRATIONS.slice(0,22)});
  await applyMigrations(v22,{migrations:EXECUTABLE_MIGRATIONS.slice(0,22),
    expectedStateFingerprint:initial.stateFingerprint,retry:{maxAttempts:1,baseDelayMs:0,maxDelayMs:0}});
  const ledger=validateMigrationLedger(await readMigrationLedger(v22,{limit:30}),MIGRATION_CONTRACTS);
  const readiness=ledgerReadiness(ledger,{contracts:MIGRATION_CONTRACTS});
  assert.deepEqual({ready:readiness.ready,state:readiness.state,pendingVersion:readiness.pendingVersion},
    {ready:true,state:'pending_additive',pendingVersion:23});
  assert.equal(await graceSchemaAvailable(v22),false);
  assert.equal(await isDeletionPending(v22,MEMBER),false);
});

