// Issue #339 self-service account deletion against a real migrated SQLite
// database: every inventoried table and column is handled, partners keep
// their history as "Deleted member", the last-owner/last-admin rules and
// recent authentication are enforced in the transaction, the deletion is
// idempotent and concurrency-safe, and membership readiness stays green.
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { afterEach, test } from 'node:test';

import { createClient } from '@libsql/client';

import {
  ACCOUNT_DATA_INVENTORY,
  ACCOUNT_DELETED_AUDIT_EVENT,
  ACCOUNT_DELETED_REASON,
  ACCOUNT_DELETION_CONFIRMATION,
  AccountDeletionInputError,
  CLIENT_DATA_INVENTORY,
  DELETED_ACCOUNT_PASSWORD_HASH,
  DELETED_MEMBER_COLOR,
  DELETED_MEMBER_NAME,
  DELETED_MESSAGE_TEXT,
  NO_PERSONAL_DATA_TABLES,
  accountDeletedForSession,
  accountDeletionEnabled,
  deleteAccount,
  deletedAccountEmail,
  ensureAccountDeletionReadiness,
  isDeletedAccount,
  parseAccountDeletionRequest,
  readAccountDeletionEligibility,
} from '../../api/_account-deletion.js';
import { initializeLocalPrimaryCircleData } from '../../api/_admin-init.js';
import { issueSession, verifyRequestAuth } from '../../api/_db.js';
import { changeCircleMemberStatus, changeCircleOwnerRole, listCircleMembersForOwner } from '../../api/_member-lifecycle.js';
import { inspectMembershipRolloutReadiness } from '../../db/membership-readiness.js';
import { prepareMigrationConnection } from '../../db/migration-runner.js';
import { TABLES } from '../../db/schema-manifest.js';
import { createMigratedDatabase } from '../support/migrated-db.mjs';

const JWT_SECRET='account-deletion-test-secret-at-least-32-bytes';
const NOW=Math.floor(Date.now()/1000);
const ISO=new Date(NOW*1000).toISOString();
const FUTURE='2098-09-20T12:00:00.000Z';
const HEX=character=>character.repeat(64);
const X=2;
const X_EMAIL='xavier@example.test';
const X_PHONE='+44 7700 900123';
const X_BIO='Xavier prepares for onsite loops';
const PRIMARY=1;
const resources=[];
const originalSecret=process.env.JWT_SECRET;

afterEach(async()=>{
  while(resources.length){ try{ await resources.pop()(); }catch{} }
  if(originalSecret===undefined) delete process.env.JWT_SECRET; else process.env.JWT_SECRET=originalSecret;
  for(const key of ['ACCOUNT_DELETION_ENABLED','CIRCLE_MEMBERSHIP_ENABLED']) delete process.env[key];
});

async function database(){
  const {directory,url}=await createMigratedDatabase({prefix:'randori-account-deletion-'});
  const db=createClient({url});
  resources.push(async()=>{ db.close(); rmSync(directory,{recursive:true,force:true}); });
  await prepareMigrationConnection(db);
  process.env.JWT_SECRET=JWT_SECRET;
  return {db,url};
}

async function connect(url){
  const client=createClient({url});
  resources.push(async()=>{ client.close(); });
  await prepareMigrationConnection(client);
  return client;
}

async function session(db,id,email,{recent=true,authenticatedAt=NOW}={}){
  const token=await issueSession(db,{id,email,name:`User ${id}`},{
    ...(recent?{recentAuthMethod:'password'}:{}),nowSeconds:authenticatedAt,
  });
  return verifyRequestAuth({headers:{cookie:`randori_session=${encodeURIComponent(token)}`}},db,{nowSeconds:NOW});
}

async function one(db,sql,args=[]){
  const result=await db.execute({sql,args});
  return result.rows[0]||null;
}

async function count(db,sql,args=[]){
  return Number((await one(db,sql,args))?.count||0);
}

// Owner 1 (admin) owns the primary circle with members 3 (partner Y) and 4
// (Zoe); 5 is a demo account. Xavier (2) joins the primary circle through an
// activated email invitation, co-owns circle 20 with Zoe and circle 30 with
// Y, and has data in every inventoried table.
async function fixture({xavierOwnsAloneIn30=false}={}){
  const {db,url}=await database();
  await db.batch([
    `INSERT INTO auth_accounts (id,email,password_hash,display_name,color,is_admin,is_demo) VALUES
      (1,'owner@example.test','$2a$10$owner','Owner','#111111',1,0),
      (3,'partner@example.test','$2a$10$partner','Partner','#333333',0,0),
      (4,'zoe@example.test','$2a$10$zoe','Zoe','#444444',0,0),
      (5,'demo@example.test','demo','Demo','#555555',0,1)`,
    `INSERT INTO users (name,color) VALUES ('Xavier','#222222')`,
  ],'write');
  await initializeLocalPrimaryCircleData(db,{ownerUserId:1,ownerEmails:['owner@example.test'],
    randomUuid:()=> '11111111-1111-4111-8111-111111111111'});
  const invitationId='22222222-2222-4222-8222-222222222222';
  await db.batch([
    {sql:`INSERT INTO auth_accounts (id,email,password_hash,display_name,color,is_admin,is_demo,bio,tz,
        interview_focus,leetcode_handle,phone,google_sub,last_login,is_available,availability_updated_at)
      VALUES (2,?,'$2a$10$xavier','Xavier','#222222',0,0,?,'Europe/London','dsa','xavier-lc',?,'x-google-sub',datetime('now'),1,datetime('now'))`,
    args:[X_EMAIL,X_BIO,X_PHONE]},
    {sql:`INSERT INTO circle_invitations (id,circle_id,token_hash,email_hash,created_by,created_at,expires_at,used_at,used_by)
      VALUES (?,?,?,?,1,?,?,?,2)`,args:[invitationId,PRIMARY,HEX('a'),HEX('b'),ISO,FUTURE,ISO]},
    {sql:`INSERT INTO circle_memberships (circle_id,user_id,role,status,invited_by) VALUES (?,2,'member','active',1)`,args:[PRIMARY]},
    {sql:`INSERT INTO circle_audit_events (circle_id,event_type,actor_user_id,subject_user_id,invitation_id,dedupe_key,created_at)
      VALUES (?,'invitation.accepted',2,2,?,?,?)`,args:[PRIMARY,invitationId,`invite-accepted:${invitationId}`,ISO]},
    {sql:`INSERT INTO auth_email_activations (id,invitation_id,circle_id,email,email_hash,password_hash,display_name,color,
        token_hash,created_at,expires_at,last_sent_at,send_count,used_at)
      VALUES ('33333333-3333-4333-8333-333333333333',?,?,?,?,'$2a$10$xavierpasswordhash00','Xavier','#222222',?,?,?,?,1,?)`,
    args:[invitationId,PRIMARY,X_EMAIL,HEX('c'),HEX('d'),NOW-100,NOW+1000,NOW-100,NOW-50]},
    `INSERT INTO circles (id,public_id,slug,name,is_primary,created_by) VALUES
      (20,'circle-twenty','twenty','Night Owls',0,4),(30,'circle-thirty','thirty','Graph Club',0,2)`,
    `INSERT INTO circle_memberships (circle_id,user_id,role,status,invited_by) VALUES
      (20,4,'owner','active',NULL),(20,2,'owner','active',4),(20,3,'member','active',2),
      (30,2,'owner','active',NULL)`,
    {sql:`INSERT INTO circle_memberships (circle_id,user_id,role,status,invited_by) VALUES (30,3,?,'active',2)`,
      args:[xavierOwnsAloneIn30?'member':'owner']},
    {sql:`INSERT INTO circle_audit_events (id,circle_id,event_type,actor_user_id,subject_user_id,invitation_id,dedupe_key,created_at)
      VALUES (900,30,'circle.created',2,NULL,NULL,'circle-created:30',?)`,args:[ISO]},
    {sql:`INSERT INTO circle_creation_requests (actor_user_id,request_hash,request_fingerprint,initiating_session_hash,
        circle_id,audit_event_id,context_version) VALUES (2,?,?,?,30,900,1)`,args:[HEX('e'),HEX('f'),HEX('1')]},
    // Invitations Xavier sent: one still pending (revoked), one already used (kept).
    {sql:`INSERT INTO circle_invitations (id,circle_id,token_hash,email_hash,created_by,created_at,expires_at)
      VALUES ('44444444-4444-4444-8444-444444444444',20,?,?,2,?,?)`,args:[HEX('2'),HEX('3'),ISO,FUTURE]},
    {sql:`INSERT INTO circle_invitations (id,circle_id,token_hash,email_hash,created_by,created_at,expires_at,used_at,used_by)
      VALUES ('55555555-5555-4555-8555-555555555555',30,?,?,2,?,?,?,3)`,args:[HEX('4'),HEX('5'),ISO,FUTURE,ISO]},
    // Invite requests: Xavier's own pending one, someone else's, and one Xavier decided.
    {sql:`INSERT INTO invite_requests (id,circle_id,email_hash,email,name,note,status,created_at,expires_at)
      VALUES ('66666666-6666-4666-8666-666666666666',?,?,?,'Xavier','Second account please','pending',?,?)`,
    args:[PRIMARY,HEX('6'),X_EMAIL,NOW-10,NOW+10000]},
    {sql:`INSERT INTO invite_requests (id,circle_id,email_hash,email,name,note,status,created_at,expires_at)
      VALUES ('77777777-7777-4777-8777-777777777777',?,?,'other@example.test','Other Person',NULL,'pending',?,?)`,
    args:[PRIMARY,HEX('7'),NOW-10,NOW+10000]},
    {sql:`INSERT INTO invite_requests (id,circle_id,email_hash,email,name,note,status,created_at,expires_at,decided_at,decided_by)
      VALUES ('88888888-8888-4888-8888-888888888888',?,?,NULL,NULL,NULL,'declined',?,?,?,2)`,
    args:[PRIMARY,HEX('8'),NOW-20,NOW+10000,NOW-5]},
    `INSERT INTO auth_provider_identities (issuer,subject,user_id) VALUES ('https://accounts.google.com','x-google-sub',2)`,
    {sql:`INSERT INTO auth_provider_email_state (issuer,subject,email_hash,hash_key_version,hash_key_fingerprint,observed_at)
      VALUES ('https://accounts.google.com','x-google-sub',?,1,?,?)`,args:[HEX('9'),HEX('a'),NOW]},
    {sql:`INSERT INTO auth_password_resets (id,user_id,email_hash,token_hash,created_at,expires_at,last_sent_at)
      VALUES ('99999999-9999-4999-8999-999999999999',2,?,?,?,?,?)`,args:[HEX('b'),HEX('c'),NOW-10,NOW+1000,NOW-10]},
    `INSERT INTO user_notification_prefs (user_id,email_enabled,phone,email) VALUES
      (2,1,'${X_PHONE}','${X_EMAIL}'),(3,1,NULL,NULL)`,
    `INSERT INTO pairing_email_outbox (week_id,user_id,kind,recipient_email,status) VALUES
      (10,2,'paired','${X_EMAIL}','pending'),(10,3,'paired','partner@example.test','pending')`,
    `INSERT INTO custom_questions (slug,title,description,test_cases,author_id) VALUES ('mine','Mine','Text','[]',2)`,
    `INSERT INTO app_logs (level,source,event,message,user_id,ua,ip) VALUES
      ('error','client','boom','Xavier saw an error',2,'Firefox','203.0.113.9'),
      ('warn','client','slow','slow',2,'Firefox','203.0.113.9'),
      ('warn','client','slow','partner slow',3,'Safari','203.0.113.10'),
      ('info','server','tick','anonymous',NULL,NULL,NULL)`,
    `INSERT INTO ai_sessions (id,room_id,pair_label,transcript,created_by) VALUES
      (1,'week_10_pair_1','Week 10 · Pair 1','Xavier said hello',2),(2,'week_10_pair_1','Week 10 · Pair 1','Partner said hi',3)`,
    `INSERT INTO ai_feedback (session_id,feedback_json) VALUES (1,'{"x":1}'),(2,'{"y":1}')`,
    `INSERT INTO ai_consents (user_id,policy_version) VALUES (2,'v1'),(3,'v1')`,
    `INSERT INTO ai_account_monthly_usage (month,user_id,calls) VALUES ('2098-09',2,3),('2098-09',3,1)`,
    `INSERT INTO ai_account_monthly_reservations (reservation_id,month,user_id,session_id) VALUES ('r-x','2098-09',2,1),('r-y','2098-09',3,2)`,
    `INSERT INTO video_signals (room_id,from_id,to_id,type,payload) VALUES ('week_10_pair_1','peer-a','peer-b','offer','{}')`,
  ],'write');
  await seedPrimaryPair(db);
  await seedSecondaryPair(db);
  await seedOutbox(db);
  const xSession=await session(db,X,X_EMAIL);
  const xOtherSession=await session(db,X,X_EMAIL,{recent:false});
  await session(db,3,'partner@example.test');
  await db.execute({sql:`INSERT INTO auth_session_circle_contexts (session_hash,user_id,circle_id,context_version,updated_at)
    VALUES (?,2,20,1,?)`,args:[xOtherSession.sessionHash,NOW]});
  return {db,url,xSession,xOtherSession,invitationId};
}

async function seedPrimaryPair(db){
  const cycleKey=HEX('d');
  await db.batch([
    {sql:`INSERT INTO pairing_cycles (scope_key,circle_id,cycle_key,cycle_id,starts_at,ends_at,cutoff_at,time_zone,default_source)
      VALUES (?,?,?,'2098-W38','2098-09-14T07:00:00.000Z','2098-09-21T07:00:00.000Z','2098-09-14T07:00:00.000Z','Europe/London','cycle_default')`,
    args:[`circle:${PRIMARY}`,PRIMARY,cycleKey]},
    {sql:`INSERT INTO pairing_cycle_availability (scope_key,cycle_key,user_id,is_available,decision_source) VALUES
      (?,?,2,1,'user'),(?,?,3,1,'user')`,args:[`circle:${PRIMARY}`,cycleKey,`circle:${PRIMARY}`,cycleKey]},
    `INSERT INTO pairing_weeks (id,week_label,week_start,focus,is_demo) VALUES (10,'2098-W38','2098-09-14T07:00:00.000Z','both',0)`,
    `INSERT INTO pairing_week_runs (week_label,week_id,generation_token,generation,algorithm_version,algorithm_seed,participant_count,participants_json)
      VALUES ('2098-W38',10,'token-10',1,'fair-v1','seed',2,'[{"user_id":2,"source":"auth"},{"user_id":3,"source":"auth"}]')`,
    `INSERT INTO pairing_participants (week_id,user_id,position,source) VALUES (10,2,0,'auth'),(10,3,1,'auth')`,
    `INSERT INTO pairing_groups (id,week_id,user_a_id,user_b_id,is_ai_pair) VALUES (1,10,2,3,0)`,
    `INSERT INTO pair_schedules (week_id,pair_group_id,proposed_times,agreed_time) VALUES (10,1,'[]','${FUTURE}')`,
    `INSERT INTO pair_meeting_links (week_id,pair_group_id,accepted_schedule_at,meeting_url,revision,updated_by,
        pair_user_a_id,pair_user_b_id,created_at,updated_at)
      VALUES (10,1,'${FUTURE}','https://meet.example.test/xavier-room',1,2,2,3,'${ISO}','${ISO}')`,
    `INSERT INTO session_completion_receipts (week_id,pair_group_id,user_id,pair_user_a_id,pair_user_b_id,confirmed_at)
      VALUES (10,1,2,2,3,'${ISO}'),(10,1,3,2,3,'${ISO}')`,
    `INSERT INTO pair_session_controls (week_id,pair_group_id,pair_user_a_id,pair_user_b_id,candidate_user_id,timer_state,
        remaining_ms,revision,updated_by,created_at,updated_at)
      VALUES (10,1,2,3,2,'paused',1500000,1,3,'${ISO}','${ISO}')`,
    {sql:`INSERT INTO pair_code_documents (week_id,pair_group_id,question_slug,question_version,language,y_state_base64,state_hash,
        code_hash,revision,pair_user_a_id,pair_user_b_id,last_actor_id,last_client_id,last_client_seq,created_at,updated_at)
      VALUES (10,1,'focus-block-rollup',1,'javascript','AAAA',?,?,1,2,3,2,'client-xavier',1,?,?)`,
    args:[HEX('e'),HEX('f'),ISO,ISO]},
    `INSERT INTO pair_room_snapshots (room_id,week_id,pair_group_id,revision,schema_version,client_id,client_seq,language,
        question_id,code,updated_by) VALUES ('week_10_pair_1',10,1,1,3,'client-xavier',1,'javascript','focus-block-rollup','shared();',2)`,
    `INSERT INTO pair_messages (id,week_id,pair_group_id,sender_id,message) VALUES
      (1,10,1,2,'My number is ${X_PHONE}'),(2,10,1,3,'Thanks!'),(3,10,1,2,'See you Tuesday')`,
    `INSERT INTO session_runs (id,user_id,week_id,pair_group_id,question_slug,language,code,test_cases_snapshot,passed_count,total_count) VALUES
      (1,2,NULL,NULL,'focus-block-rollup','javascript','solo();','{"attestation_version":2}',1,1),
      (2,2,10,1,'focus-block-rollup','javascript','legacy_pair();','{"attestation_version":2}',1,1),
      (3,2,10,1,'focus-block-rollup','javascript','shared_document();','{"attestation_version":3}',1,1),
      (4,3,10,1,'focus-block-rollup','javascript','partner();','{"attestation_version":2}',1,1),
      (5,2,10,1,'focus-block-rollup','javascript','unparsed();','not json',0,1)`,
  ],'write');
}

async function seedSecondaryPair(db){
  const key=HEX('9');
  await db.batch([
    {sql:`INSERT INTO pairing_cycles (scope_key,circle_id,cycle_key,cycle_id,starts_at,ends_at,cutoff_at,time_zone,default_source)
      VALUES ('circle:20',20,?,'2098-W38','2098-09-14T07:00:00.000Z','2098-09-21T07:00:00.000Z','2098-09-14T07:00:00.000Z','Europe/London','cycle_default')`,
    args:[key]},
    {sql:`INSERT INTO circle_pairing_publications (id,scope_key,circle_id,cycle_key,cycle_id,starts_at,ends_at,cutoff_at,time_zone,
        generation_token,algorithm_version,algorithm_seed,participant_count)
      VALUES (1,'circle:20',20,?,'2098-W38','2098-09-14T07:00:00.000Z','2098-09-21T07:00:00.000Z','2098-09-14T07:00:00.000Z',
        'Europe/London','11111111-1111-4111-8111-111111111111','fair-seeded-v1','seed',2)`,args:[key]},
    {sql:`INSERT INTO circle_pairing_eligibility (publication_id,scope_key,circle_id,cycle_key,user_id,is_available,availability_version,
        availability_source,position,group_position,group_size,member_position)
      VALUES (1,'circle:20',20,?,2,1,0,'cycle_default',0,0,2,0),(1,'circle:20',20,?,3,1,0,'cycle_default',1,0,2,1)`,args:[key,key]},
    {sql:`INSERT INTO circle_pairing_groups (id,publication_id,scope_key,circle_id,cycle_key,position,member_count,user_a_id,
        user_b_id,user_b_available,user_b_member_position,is_solo) VALUES (1,1,'circle:20',20,?,0,2,2,3,1,1,0)`,args:[key]},
    {sql:`INSERT INTO circle_pair_schedules (id,schedule_key,publication_id,scope_key,circle_id,cycle_key,group_id,member_count,
        user_a_id,user_b_id,is_solo,revision,agreed_time,created_at,updated_at)
      VALUES (1,?,1,'circle:20',20,?,1,2,2,3,0,1,NULL,?,?)`,args:[HEX('c'),key,ISO,ISO]},
    {sql:`INSERT INTO circle_pair_schedule_proposals (schedule_id,schedule_key,publication_id,scope_key,circle_id,cycle_key,group_id,
        member_count,user_a_id,user_b_id,is_solo,proposal_key,instant,proposed_by,created_at)
      VALUES (1,?,1,'circle:20',20,?,1,2,2,3,0,?,?,2,?)`,args:[HEX('c'),key,HEX('b'),FUTURE,ISO]},
  ],'write');
}

function outboxRow(id,eventType,payload,{status='pending',version=1,lease=false}={}){
  return {sql:`INSERT INTO outbox_events (id,event_type,event_version,idempotency_key,payload_json,status,not_before,next_attempt_at,
      attempt_count,lease_owner,lease_token,leased_until,claim_from_status)
    VALUES (?,?,?,?,?,?,?,?,1,?,?,?,?)`,
  args:[id,eventType,version,`key-${id}-${eventType}`,JSON.stringify(payload),status,ISO,ISO,
    lease?'worker':null,lease?'lease-token':null,lease?FUTURE:null,lease?'pending':null]};
}

async function seedOutbox(db){
  await db.batch([
    outboxRow(1,'schedule.email.requested',{kind:'proposed',week_id:10,pair_group_id:1,actor_user_id:3,recipient_user_id:2}),
    outboxRow(2,'schedule.email.requested',{kind:'proposed',week_id:10,pair_group_id:1,actor_user_id:2,recipient_user_id:3}),
    outboxRow(3,'reminder.email.requested',{kind:'agree_time',scope:'primary',week_id:10,pair_group_id:1,recipient_user_id:2},{status:'dead_letter'}),
    outboxRow(4,'auth.passwordreset.requested',{reset_id:'r',recipient_email:X_EMAIL,token_envelope:'sealed-reset'},{status:'delivered'}),
    outboxRow(5,'pairing.email.requested',{week_id:10,user_id:2,kind:'paired',recipient_email:X_EMAIL},{status:'processing',lease:true}),
    outboxRow(6,'invitation.email.requested',{invitation_id:'44444444-4444-4444-8444-444444444444',circle_id:20,actor_user_id:2,
      token_hash:HEX('2'),email_hash:HEX('3'),credential_envelope:'sealed-invitee'}),
    outboxRow(7,'invitation.email.requested',{invitation_id:'22222222-2222-4222-8222-222222222222',circle_id:PRIMARY,actor_user_id:1,
      token_hash:HEX('a'),email_hash:HEX('b'),credential_envelope:'sealed-xavier'},{status:'delivered'}),
    outboxRow(8,'inviterequest.email.requested',{circle_id:20,owner_user_id:2,digest_hour:1}),
    outboxRow(9,'auth.emailverification.requested',{activation_id:'a',recipient_email:X_EMAIL,token_envelope:'sealed-activation'},{status:'delivered'}),
    outboxRow(10,'pairing.email.requested',{publication_id:1,circle_id:20,user_id:3,kind:'paired'},{version:2}),
  ],'write');
}

async function allText(db,{exclude=[]}={}){
  const tables=await db.execute(`SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%'`);
  const values=[];
  for(const {name} of tables.rows){
    if(exclude.includes(String(name))) continue;
    const rows=await db.execute(`SELECT * FROM "${name}"`);
    for(const row of rows.rows){
      for(const value of Object.values(row)) if(typeof value==='string') values.push(`${name}:${value}`);
    }
  }
  return values;
}

test('the inventory covers every table in the schema manifest and names only real columns',async()=>{
  const {db}=await database();
  const listed=ACCOUNT_DATA_INVENTORY.map(entry=>entry.table);
  assert.equal(new Set(listed).size,listed.length,'each table is listed once');
  assert.deepEqual(listed.filter(table=>NO_PERSONAL_DATA_TABLES.includes(table)),[]);
  const manifest=TABLES.map(table=>table.name).sort();
  assert.deepEqual([...listed,...NO_PERSONAL_DATA_TABLES].sort(),manifest,
    'a new table must be added to the deletion inventory or the no-personal-data list');
  for(const entry of ACCOUNT_DATA_INVENTORY){
    assert.ok(['delete','anonymise','keep','revoke'].includes(entry.action),entry.table);
    assert.ok(entry.reason.length>10&&entry.reason.length<=200,entry.table);
    const info=await db.execute(`PRAGMA table_info('${entry.table}')`);
    const columns=new Set(info.rows.map(row=>String(row.name)));
    for(const column of entry.columns) assert.ok(columns.has(column),`${entry.table}.${column}`);
  }
  assert.deepEqual(CLIENT_DATA_INVENTORY.map(entry=>entry.store),
    ['cookie randori_session','localStorage randori-*','sessionStorage randori-*','Sentry']);
});

test('helpers: flag, tombstone email, marker and the exact confirmation body',()=>{
  assert.equal(accountDeletionEnabled({}),false);
  assert.equal(accountDeletionEnabled({ACCOUNT_DELETION_ENABLED:'true'}),false,'needs circle membership');
  assert.equal(accountDeletionEnabled({ACCOUNT_DELETION_ENABLED:'true',CIRCLE_MEMBERSHIP_ENABLED:'true'}),true);
  assert.equal(accountDeletionEnabled(null),false);
  process.env.ACCOUNT_DELETION_ENABLED='true';
  process.env.CIRCLE_MEMBERSHIP_ENABLED='true';
  assert.equal(accountDeletionEnabled(),true);
  assert.equal(deletedAccountEmail(7),'deleted-7@account-deleted.invalid');
  assert.throws(()=>deletedAccountEmail(0),TypeError);
  assert.equal(isDeletedAccount({password_hash:DELETED_ACCOUNT_PASSWORD_HASH}),true);
  assert.equal(isDeletedAccount({password_hash:'$2a$'}),false);
  assert.equal(isDeletedAccount(null),false);
  assert.deepEqual(parseAccountDeletionRequest({confirm:ACCOUNT_DELETION_CONFIRMATION}),{confirm:'DELETE'});
  for(const body of [null,[],'DELETE',{},{confirm:'delete'},{confirm:'DELETE',user_id:3},{user_id:3}]){
    assert.throws(()=>parseAccountDeletionRequest(body),error=>error instanceof AccountDeletionInputError
      &&error.code==='confirmation_required');
  }
});

test('readiness is read-only on a migrated database and fails closed on a missing schema',async()=>{
  const {db}=await database();
  await ensureAccountDeletionReadiness(db);
  const empty=createClient({url:':memory:'});
  resources.push(async()=>{ empty.close(); });
  await assert.rejects(ensureAccountDeletionReadiness(empty));
  await assert.rejects(ensureAccountDeletionReadiness(null),TypeError);
});

test('deletion erases or anonymises every inventoried column and keeps partners\' history readable',async()=>{
  const {db,xSession,xOtherSession,invitationId}=await fixture();
  const keptBefore={
    participants:await count(db,`SELECT COUNT(*) AS count FROM pairing_participants WHERE user_id=2`),
    groups:await count(db,`SELECT COUNT(*) AS count FROM pairing_groups WHERE user_a_id=2`),
    receipts:await count(db,`SELECT COUNT(*) AS count FROM session_completion_receipts WHERE user_id=2`),
    controls:await count(db,`SELECT COUNT(*) AS count FROM pair_session_controls WHERE candidate_user_id=2`),
    documents:await count(db,`SELECT COUNT(*) AS count FROM pair_code_documents WHERE last_actor_id=2`),
    snapshots:await count(db,`SELECT COUNT(*) AS count FROM pair_room_snapshots WHERE updated_by=2`),
    eligibility:await count(db,`SELECT COUNT(*) AS count FROM circle_pairing_eligibility WHERE user_id=2`),
    circleGroups:await count(db,`SELECT COUNT(*) AS count FROM circle_pairing_groups WHERE user_a_id=2`),
    schedules:await count(db,`SELECT COUNT(*) AS count FROM circle_pair_schedules WHERE user_a_id=2`),
    proposals:await count(db,`SELECT COUNT(*) AS count FROM circle_pair_schedule_proposals WHERE proposed_by=2`),
    creation:await count(db,`SELECT COUNT(*) AS count FROM circle_creation_requests WHERE actor_user_id=2`),
    identityAudit:await count(db,`SELECT COUNT(*) AS count FROM auth_identity_audit_events`),
  };
  assert.deepEqual(await readAccountDeletionEligibility(db,{userId:X}),{ok:true});

  const result=await deleteAccount(db,{userId:X,sessionHash:xSession.sessionHash,nowSeconds:NOW});
  assert.equal(result.ok,true);
  assert.equal(result.status,'deleted');
  assert.deepEqual(result.summary,{
    outbox_suppressed:4,outbox_scrubbed:7,legacy_outbox:1,invitations_revoked:1,invitations_scrubbed:1,
    activations_scrubbed:1,invite_requests_expired:1,sessions_revoked:2,google_links_removed:1,
    memberships_deactivated:3,messages_redacted:2,solo_runs_deleted:1,pair_run_code_cleared:2,logs_deleted:2,
    circles_audited:3,
  });

  // auth_accounts: tombstoned; partners resolve the id to "Deleted member".
  assert.deepEqual({...await one(db,`SELECT email,password_hash,display_name,color,bio,tz,interview_focus,leetcode_handle,
      phone,google_sub,last_login,is_available,availability_updated_at,is_admin,is_demo FROM auth_accounts WHERE id=2`)},{
    email:'deleted-2@account-deleted.invalid',password_hash:DELETED_ACCOUNT_PASSWORD_HASH,display_name:DELETED_MEMBER_NAME,
    color:DELETED_MEMBER_COLOR,bio:null,tz:null,interview_focus:'both',leetcode_handle:null,phone:null,google_sub:null,
    last_login:null,is_available:0,availability_updated_at:null,is_admin:0,is_demo:0,
  });
  assert.equal((await one(db,`SELECT display_name FROM auth_accounts WHERE id=3`)).display_name,'Partner');

  // Credentials and sessions.
  assert.equal(await count(db,`SELECT COUNT(*) AS count FROM auth_sessions WHERE user_id=2 AND revoked_at IS NULL`),0);
  assert.equal(await count(db,`SELECT COUNT(*) AS count FROM auth_sessions WHERE user_id=2 AND revocation_reason='logout_all'`),2);
  assert.equal(await count(db,`SELECT COUNT(*) AS count FROM auth_sessions WHERE user_id=3 AND revoked_at IS NULL`),1);
  for(const table of ['auth_recent_proofs','auth_session_circle_contexts','auth_provider_identities','auth_password_resets']){
    assert.equal(await count(db,`SELECT COUNT(*) AS count FROM ${table} WHERE user_id=2`),0,table);
  }
  assert.equal(await count(db,`SELECT COUNT(*) AS count FROM auth_provider_email_state`),0);
  assert.equal(await verifyRequestAuth({headers:{cookie:'x'}},db),null);
  assert.equal(await accountDeletedForSession(db,{userId:X,sessionHash:xOtherSession.sessionHash}),true);
  assert.equal(await accountDeletedForSession(db,{userId:3,sessionHash:xOtherSession.sessionHash}),false);

  // The activation that created the account is scrubbed but stays used.
  const activation=await one(db,`SELECT email,email_hash,password_hash,display_name,color,used_at,revoked_at FROM auth_email_activations`);
  assert.equal(activation.email,'deleted-2@account-deleted.invalid');
  assert.match(String(activation.email_hash),/^[0-9a-f]{64}$/);
  assert.notEqual(activation.email_hash,HEX('c'));
  assert.equal(activation.password_hash,'!account-deleted-scrubbed');
  assert.equal(activation.display_name,DELETED_MEMBER_NAME);
  assert.equal(activation.used_at,NOW-50);
  assert.equal(activation.revoked_at,null);

  // Invitations: the pending one Xavier sent is revoked and audited; the used
  // one stays; the accepted one keeps its provenance with a fresh fingerprint.
  const invitations=await db.execute(`SELECT id,email_hash,used_by,used_at,revoked_at FROM circle_invitations ORDER BY id`);
  const byId=Object.fromEntries(invitations.rows.map(row=>[row.id,row]));
  assert.equal(byId['44444444-4444-4444-8444-444444444444'].revoked_at,ISO);
  assert.equal(byId['55555555-5555-4555-8555-555555555555'].revoked_at,null);
  assert.equal(byId[invitationId].used_by,2);
  assert.equal(byId[invitationId].revoked_at,null);
  assert.notEqual(byId[invitationId].email_hash,HEX('b'));
  assert.equal(await count(db,`SELECT COUNT(*) AS count FROM circle_audit_events WHERE event_type='invitation.revoked'
    AND invitation_id='44444444-4444-4444-8444-444444444444' AND actor_user_id=2 AND subject_user_id IS NULL`),1);

  // Invite requests.
  const requests=Object.fromEntries((await db.execute(`SELECT id,status,email,name,note,decided_by FROM invite_requests`)).rows
    .map(row=>[row.id,{...row}]));
  assert.deepEqual(requests['66666666-6666-4666-8666-666666666666'],
    {id:'66666666-6666-4666-8666-666666666666',status:'expired',email:null,name:null,note:null,decided_by:null});
  assert.equal(requests['77777777-7777-4777-8777-777777777777'].email,'other@example.test');
  assert.equal(requests['88888888-8888-4888-8888-888888888888'].decided_by,2);

  // Availability, preferences, memberships and the audit trail.
  assert.equal(await count(db,`SELECT COUNT(*) AS count FROM pairing_cycle_availability WHERE user_id=2`),0);
  assert.equal(await count(db,`SELECT COUNT(*) AS count FROM pairing_cycle_availability WHERE user_id=3`),1);
  assert.equal(await count(db,`SELECT COUNT(*) AS count FROM user_notification_prefs WHERE user_id=2`),0);
  assert.equal(await count(db,`SELECT COUNT(*) AS count FROM user_notification_prefs WHERE user_id=3`),1);
  const memberships=(await db.execute(`SELECT circle_id,role,status FROM circle_memberships WHERE user_id=2 ORDER BY circle_id`)).rows
    .map(row=>`${row.circle_id}:${row.role}/${row.status}`);
  assert.deepEqual(memberships,['1:member/inactive','20:member/inactive','30:member/inactive']);
  const audits=(await db.execute(`SELECT circle_id,actor_user_id,subject_user_id,invitation_id,dedupe_key FROM circle_audit_events
    WHERE event_type=? ORDER BY circle_id`,[ACCOUNT_DELETED_AUDIT_EVENT])).rows.map(row=>({...row}));
  assert.deepEqual(audits,[1,20,30].map(circle=>({circle_id:circle,actor_user_id:2,subject_user_id:2,invitation_id:null,
    dedupe_key:`account.deleted:${circle}:2`})));

  // Pair activity: kept for the partner, minus Xavier's own content.
  assert.deepEqual((await db.execute(`SELECT id,message FROM pair_messages ORDER BY id`)).rows.map(row=>[row.id,row.message]),
    [[1,DELETED_MESSAGE_TEXT],[2,'Thanks!'],[3,DELETED_MESSAGE_TEXT]]);
  assert.deepEqual((await db.execute(`SELECT id,code FROM session_runs ORDER BY id`)).rows.map(row=>[row.id,row.code]),
    [[2,''],[3,'shared_document();'],[4,'partner();'],[5,'']]);
  assert.equal(await count(db,`SELECT COUNT(*) AS count FROM pair_meeting_links`),0);
  assert.equal(await count(db,`SELECT COUNT(*) AS count FROM pair_schedules WHERE agreed_time=?`,[FUTURE]),1);
  assert.deepEqual({
    participants:await count(db,`SELECT COUNT(*) AS count FROM pairing_participants WHERE user_id=2`),
    groups:await count(db,`SELECT COUNT(*) AS count FROM pairing_groups WHERE user_a_id=2`),
    receipts:await count(db,`SELECT COUNT(*) AS count FROM session_completion_receipts WHERE user_id=2`),
    controls:await count(db,`SELECT COUNT(*) AS count FROM pair_session_controls WHERE candidate_user_id=2`),
    documents:await count(db,`SELECT COUNT(*) AS count FROM pair_code_documents WHERE last_actor_id=2`),
    snapshots:await count(db,`SELECT COUNT(*) AS count FROM pair_room_snapshots WHERE updated_by=2`),
    eligibility:await count(db,`SELECT COUNT(*) AS count FROM circle_pairing_eligibility WHERE user_id=2`),
    circleGroups:await count(db,`SELECT COUNT(*) AS count FROM circle_pairing_groups WHERE user_a_id=2`),
    schedules:await count(db,`SELECT COUNT(*) AS count FROM circle_pair_schedules WHERE user_a_id=2`),
    proposals:await count(db,`SELECT COUNT(*) AS count FROM circle_pair_schedule_proposals WHERE proposed_by=2`),
    creation:await count(db,`SELECT COUNT(*) AS count FROM circle_creation_requests WHERE actor_user_id=2`),
    identityAudit:await count(db,`SELECT COUNT(*) AS count FROM auth_identity_audit_events`),
  },keptBefore);
  const partnerView=await one(db,`SELECT account.display_name FROM pairing_groups pg JOIN auth_accounts account ON account.id=pg.user_a_id WHERE pg.id=1`);
  assert.equal(partnerView.display_name,DELETED_MEMBER_NAME);

  // AI, questions, logs.
  assert.deepEqual((await db.execute(`SELECT id FROM ai_sessions`)).rows.map(row=>row.id),[2]);
  assert.deepEqual((await db.execute(`SELECT session_id FROM ai_feedback`)).rows.map(row=>row.session_id),[2]);
  for(const table of ['ai_consents','ai_account_monthly_usage','ai_account_monthly_reservations']){
    assert.equal(await count(db,`SELECT COUNT(*) AS count FROM ${table} WHERE user_id=2`),0,table);
    assert.equal(await count(db,`SELECT COUNT(*) AS count FROM ${table} WHERE user_id=3`),1,table);
  }
  assert.equal((await one(db,`SELECT author_id FROM custom_questions`)).author_id,null);
  assert.deepEqual((await db.execute(`SELECT user_id FROM app_logs ORDER BY id`)).rows.map(row=>row.user_id),[3,null]);
  assert.equal(await count(db,`SELECT COUNT(*) AS count FROM video_signals`),1);

  // Outbox: emails to Xavier are suppressed (audited) and scrubbed; an
  // in-flight row keeps its lease; partner mail is untouched.
  const outbox=Object.fromEntries((await db.execute(`SELECT id,status,payload_json,last_error_code,lease_token FROM outbox_events`)).rows
    .map(row=>[row.id,{status:row.status,payload:JSON.parse(String(row.payload_json)),error:row.last_error_code,lease:row.lease_token}]));
  for(const id of [1,3,6,8]){
    assert.equal(outbox[id].status,'suppressed',`event ${id}`);
    assert.equal(outbox[id].error,ACCOUNT_DELETED_REASON);
  }
  assert.equal(outbox[2].status,'pending');
  assert.equal(outbox[10].status,'pending');
  assert.equal(outbox[4].status,'delivered');
  assert.deepEqual(outbox[4].payload,{reset_id:'r',recipient_email:'deleted-2@account-deleted.invalid'});
  assert.deepEqual(outbox[9].payload,{activation_id:'a',recipient_email:'deleted-2@account-deleted.invalid'});
  assert.equal(outbox[5].status,'processing');
  assert.equal(outbox[5].lease,'lease-token');
  assert.equal(outbox[5].payload.recipient_email,'deleted-2@account-deleted.invalid');
  assert.equal('credential_envelope' in outbox[7].payload,false);
  assert.equal('email_hash' in outbox[7].payload,false);
  assert.equal(outbox[6].payload.credential_envelope,'sealed-invitee','the invitee\'s own data is not Xavier\'s');
  const outboxAudits=(await db.execute(`SELECT outbox_event_id,from_status,to_status,reason_code,actor_type,actor_ref
    FROM outbox_audit_events ORDER BY outbox_event_id`)).rows.map(row=>({...row}));
  assert.deepEqual(outboxAudits,[
    {outbox_event_id:1,from_status:'pending',to_status:'suppressed',reason_code:ACCOUNT_DELETED_REASON,actor_type:'system',actor_ref:'account-deletion'},
    {outbox_event_id:3,from_status:'dead_letter',to_status:'suppressed',reason_code:ACCOUNT_DELETED_REASON,actor_type:'system',actor_ref:'account-deletion'},
    {outbox_event_id:6,from_status:'pending',to_status:'suppressed',reason_code:ACCOUNT_DELETED_REASON,actor_type:'system',actor_ref:'account-deletion'},
    {outbox_event_id:8,from_status:'pending',to_status:'suppressed',reason_code:ACCOUNT_DELETED_REASON,actor_type:'system',actor_ref:'account-deletion'},
  ]);
  assert.deepEqual((await db.execute(`SELECT user_id,status,recipient_email FROM pairing_email_outbox ORDER BY user_id`)).rows
    .map(row=>[row.user_id,row.status,row.recipient_email]),
  [[2,'cancelled','deleted-2@account-deleted.invalid'],[3,'pending','partner@example.test']]);

  // Nothing personal is left anywhere except the legacy name-only roster.
  const leftovers=(await allText(db,{exclude:['users']})).filter(value=>
    value.includes(X_EMAIL)||value.includes(X_PHONE)||value.includes(X_BIO)||value.includes('Xavier')
    ||value.includes('xavier-lc')||value.includes('x-google-sub')||value.includes('meet.example.test'));
  assert.deepEqual(leftovers,[]);
  assert.equal(await count(db,`SELECT COUNT(*) AS count FROM users WHERE name='Xavier'`),1);

  // Partners still see one active owner and the deployment stays ready.
  assert.equal((await inspectMembershipRolloutReadiness(db)).ok,true);
  const roster=await listCircleMembersForOwner(db,{actorUserId:4,circleId:20,cursorSecret:JWT_SECRET});
  assert.deepEqual(roster.members.map(member=>member.id),[3,4],'the tombstone is hidden from the owner roster');
});

test('a deleted member cannot be reactivated by an owner',async()=>{
  const {db,xSession}=await fixture();
  await deleteAccount(db,{userId:X,sessionHash:xSession.sessionHash,nowSeconds:NOW});
  const result=await changeCircleMemberStatus(db,{actorUserId:4,targetUserId:X,circleId:20,action:'reactivate'});
  assert.deepEqual(result,{ok:false,reason:'state_conflict'});
  assert.equal((await one(db,`SELECT status FROM circle_memberships WHERE circle_id=20 AND user_id=2`)).status,'inactive');
  // Ordinary members can still be reactivated.
  await changeCircleMemberStatus(db,{actorUserId:4,targetUserId:3,circleId:20,action:'deactivate'});
  assert.equal((await changeCircleMemberStatus(db,{actorUserId:4,targetUserId:3,circleId:20,action:'reactivate'})).ok,true);
});

test('recent authentication is required, bound to the request session, and checked before any change',async()=>{
  const {db,xOtherSession}=await fixture();
  const before=await allText(db);
  await assert.rejects(deleteAccount(db,{userId:X,sessionHash:xOtherSession.sessionHash,nowSeconds:NOW}),
    error=>error.code==='RECENT_AUTH_REQUIRED');
  const stale=await session(db,X,X_EMAIL,{authenticatedAt:NOW-11*60});
  await assert.rejects(deleteAccount(db,{userId:X,sessionHash:stale.sessionHash,nowSeconds:NOW}),
    error=>error.code==='RECENT_AUTH_REQUIRED');
  const partner=await session(db,3,'partner@example.test');
  await assert.rejects(deleteAccount(db,{userId:X,sessionHash:partner.sessionHash,nowSeconds:NOW}),
    error=>error.code==='RECENT_AUTH_REQUIRED','another member\'s proof never authorizes the deletion');
  const after=(await allText(db)).filter(value=>!value.startsWith('auth_sessions:')&&!value.startsWith('auth_recent_proofs:'));
  assert.deepEqual(after,before.filter(value=>!value.startsWith('auth_sessions:')&&!value.startsWith('auth_recent_proofs:')));
  assert.equal((await one(db,`SELECT email FROM auth_accounts WHERE id=2`)).email,X_EMAIL);
});

test('the only active owner of a circle is blocked with the circles to hand over',async()=>{
  const {db,xSession}=await fixture({xavierOwnsAloneIn30:true});
  const blocked={ok:false,reason:'last_owner',circles:[{public_id:'circle-thirty',name:'Graph Club',is_primary:false}]};
  assert.deepEqual(await readAccountDeletionEligibility(db,{userId:X}),blocked);
  assert.deepEqual(await deleteAccount(db,{userId:X,sessionHash:xSession.sessionHash,nowSeconds:NOW}),blocked);
  assert.equal((await one(db,`SELECT email FROM auth_accounts WHERE id=2`)).email,X_EMAIL);
  assert.equal(await count(db,`SELECT COUNT(*) AS count FROM auth_sessions WHERE user_id=2 AND revoked_at IS NULL`),2);
  // A demo co-owner does not count as someone to hand over to.
  await db.execute(`INSERT INTO circle_memberships (circle_id,user_id,role,status) VALUES (30,5,'owner','active')`);
  assert.deepEqual(await readAccountDeletionEligibility(db,{userId:X}),blocked);
  // Making another member an owner (make_owner) unblocks the deletion.
  assert.equal((await changeCircleOwnerRole(db,{actorUserId:X,targetUserId:3,circleId:30,action:'make_owner',
    session:xSession,nowSeconds:NOW})).ok,true);
  assert.equal((await deleteAccount(db,{userId:X,sessionHash:xSession.sessionHash,nowSeconds:NOW})).status,'deleted');
});

test('the primary circle owner and the last app admin are blocked; demo accounts are refused',async()=>{
  const {db}=await fixture();
  const owner=await session(db,1,'owner@example.test');
  assert.deepEqual(await deleteAccount(db,{userId:1,sessionHash:owner.sessionHash,nowSeconds:NOW}),
    {ok:false,reason:'last_owner',circles:[{public_id:String((await one(db,`SELECT public_id FROM circles WHERE id=1`)).public_id),
      name:String((await one(db,`SELECT name FROM circles WHERE id=1`)).name),is_primary:true}]});
  // Zoe becomes the only admin; with another owner in the primary circle the
  // owner rule passes and the admin rule decides.
  await db.execute(`UPDATE circle_memberships SET role='owner' WHERE circle_id=1 AND user_id=3`);
  await db.execute(`UPDATE auth_accounts SET is_admin=CASE WHEN id=4 THEN 1 ELSE 0 END`);
  const zoe=await session(db,4,'zoe@example.test');
  assert.deepEqual(await readAccountDeletionEligibility(db,{userId:4}),{ok:false,reason:'last_admin'});
  assert.deepEqual(await deleteAccount(db,{userId:4,sessionHash:zoe.sessionHash,nowSeconds:NOW}),{ok:false,reason:'last_admin'});
  // An ADMIN_EMAILS account counts as an admin even before its flag is synced.
  await db.execute(`UPDATE auth_accounts SET is_admin=0`);
  assert.deepEqual(await readAccountDeletionEligibility(db,{userId:4,adminEmails:[' ZOE@example.test ']}),{ok:false,reason:'last_admin'});
  await db.execute(`UPDATE auth_accounts SET is_admin=1 WHERE id=1`);
  assert.deepEqual(await readAccountDeletionEligibility(db,{userId:4,adminEmails:['zoe@example.test']}),{ok:true});
  // Demo accounts and unknown ids.
  await db.execute(`INSERT INTO circle_memberships (circle_id,user_id,role,status) VALUES (1,5,'member','active')`);
  const demo=await session(db,5,'demo@example.test');
  assert.deepEqual(await deleteAccount(db,{userId:5,sessionHash:demo.sessionHash,nowSeconds:NOW}),{ok:false,reason:'demo_account'});
  assert.deepEqual(await readAccountDeletionEligibility(db,{userId:5}),{ok:false,reason:'demo_account'});
  assert.deepEqual(await readAccountDeletionEligibility(db,{userId:99}),{ok:false,reason:'not_found'});
  assert.deepEqual(await deleteAccount(db,{userId:99,sessionHash:HEX('0'),nowSeconds:NOW}),{ok:false,reason:'not_found'});
  await assert.rejects(readAccountDeletionEligibility(db,{userId:0}),TypeError);
  await assert.rejects(deleteAccount(db,{userId:2,sessionHash:'short'}),TypeError);
  await assert.rejects(deleteAccount(null,{userId:2,sessionHash:HEX('0')}),TypeError);
  await assert.rejects(deleteAccount(db,{userId:2,sessionHash:HEX('0'),nowSeconds:0}),TypeError);
  assert.equal(await accountDeletedForSession(null,{userId:2,sessionHash:HEX('0')}),false);
  assert.equal(await accountDeletedForSession(db,{userId:2,sessionHash:'nope'}),false);
});

test('deletion is idempotent: a repeat is a no-op answered as already deleted',async()=>{
  const {db,xSession}=await fixture();
  assert.equal((await deleteAccount(db,{userId:X,sessionHash:xSession.sessionHash,nowSeconds:NOW})).status,'deleted');
  const snapshot=await allText(db);
  assert.deepEqual(await deleteAccount(db,{userId:X,sessionHash:xSession.sessionHash,nowSeconds:NOW+5}),
    {ok:true,status:'already_deleted'});
  assert.deepEqual(await allText(db),snapshot);
  assert.deepEqual(await readAccountDeletionEligibility(db,{userId:X}),{ok:false,reason:'already_deleted'});
});

test('concurrent deletions serialize: one commit, consistent audits, and an owner always remains',async()=>{
  const {db,url,xSession}=await fixture();
  const clients=[db,await connect(url),await connect(url)];
  const outcomes=await Promise.allSettled(clients.map(client=>
    deleteAccount(client,{userId:X,sessionHash:xSession.sessionHash,nowSeconds:NOW})));
  for(const outcome of outcomes){
    if(outcome.status==='rejected') assert.match(String(outcome.reason?.code||outcome.reason?.message),/SQLITE_BUSY|database is locked/i);
  }
  const committed=outcomes.filter(outcome=>outcome.status==='fulfilled'&&outcome.value.status==='deleted');
  assert.equal(committed.length,1);
  assert.equal(await count(db,`SELECT COUNT(*) AS count FROM circle_audit_events WHERE event_type='account.deleted'`),3);

  // Circle 20 has two owners (Zoe and, before, Xavier). Make Partner and Zoe
  // the only owners of circle 30 and have both delete at once: at most one
  // can leave, so circle 30 keeps an active owner.
  await db.batch([
    `UPDATE circle_memberships SET role='owner',status='active' WHERE circle_id=30 AND user_id=3`,
    `INSERT INTO circle_memberships (circle_id,user_id,role,status) VALUES (30,4,'owner','active')`,
    `UPDATE auth_accounts SET is_admin=1 WHERE id IN (1,3,4)`,
  ],'write');
  const partner=await session(db,3,'partner@example.test');
  const zoe=await session(db,4,'zoe@example.test');
  const race=await Promise.allSettled([
    deleteAccount(clients[1],{userId:3,sessionHash:partner.sessionHash,nowSeconds:NOW}),
    deleteAccount(clients[2],{userId:4,sessionHash:zoe.sessionHash,nowSeconds:NOW}),
  ]);
  for(const outcome of race){
    if(outcome.status==='rejected') assert.match(String(outcome.reason?.code||outcome.reason?.message),/SQLITE_BUSY|database is locked/i);
  }
  assert.ok(await count(db,`SELECT COUNT(*) AS count FROM circle_memberships WHERE circle_id=30 AND role='owner' AND status='active'`)>=1);
});

test('a failure inside the transaction rolls every change back',async()=>{
  const {db,xSession}=await fixture();
  const before=await allText(db);
  const failing={
    async transaction(mode){
      const transaction=await db.transaction(mode);
      return {
        execute(statement){
          if(String(statement?.sql||statement).includes('UPDATE auth_accounts')) throw new Error('injected');
          return transaction.execute(statement);
        },
        commit:()=>transaction.commit(),
        rollback:()=>transaction.rollback(),
      };
    },
  };
  await assert.rejects(deleteAccount(failing,{userId:X,sessionHash:xSession.sessionHash,nowSeconds:NOW}),/injected/);
  assert.deepEqual(await allText(db),before);
});

test('a tombstone update that matches nothing aborts instead of committing a partial deletion',async()=>{
  const {db,xSession}=await fixture();
  const racing={
    async transaction(mode){
      const transaction=await db.transaction(mode);
      return {
        async execute(statement){
          const result=await transaction.execute(statement);
          return String(statement?.sql||'').includes('UPDATE auth_accounts')?{rows:[],rowsAffected:0}:result;
        },
        commit:()=>transaction.commit(),
        rollback:async()=>{ await transaction.rollback(); throw new Error('rollback noise is ignored'); },
      };
    },
  };
  await assert.rejects(deleteAccount(racing,{userId:X,sessionHash:xSession.sessionHash,nowSeconds:NOW}),/tombstone failed/);
  assert.equal((await one(db,`SELECT email FROM auth_accounts WHERE id=2`)).email,X_EMAIL);
});
