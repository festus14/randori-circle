// Issue #365 member data export: the builder on a real migrated database.
// The archive holds the member's own data from every exported inventory
// table, partners appear by display name only, no other member's private
// data (ids, emails, messages, code) and no secret ever appears, feedback
// is skipped when its tables are absent and included when they are present,
// and the size bound and per-section caps hold.
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { afterEach, test } from 'node:test';

import { createClient } from '@libsql/client';

import {
  ACCOUNT_DATA_INVENTORY,
  NO_PERSONAL_DATA_TABLES,
} from '../../api/_account-deletion.js';
import { hashInvitationEmail } from '../../api/_circle-membership.js';
import {
  DATA_EXPORT_MAX_BYTES,
  DATA_EXPORT_SECTION_LIMITS,
  DATA_EXPORT_TABLE_COVERAGE,
  DataExportTooLargeError,
  buildDataExport,
  dataExportEnabled,
  ensureDataExportReadiness,
} from '../../api/_data-export.js';
import { createMigratedDatabase } from '../support/migrated-db.mjs';
import { prepareMigrationConnection } from '../../db/migration-runner.js';

// hashInvitationEmail needs the JWT secret, as in production; the
// fixture computes invitation email hashes with the same secret the
// builder uses, so the match is exact.
process.env.JWT_SECRET='data-export-test-secret-at-least-32-bytes';
const resources=[];
afterEach(async()=>{
  while(resources.length){ try{ await resources.pop()(); }catch{} }
});

async function database(){
  const {directory,url}=await createMigratedDatabase({prefix:'randori-data-export-'});
  const db=createClient({url});
  resources.push(async()=>{ db.close(); rmSync(directory,{recursive:true,force:true}); });
  await prepareMigrationConnection(db);
  return db;
}

const HEX=(character)=>character.repeat(64);
const CYCLE_KEY=HEX('a');
const CYCLE_START='2026-01-05T08:00:00.000Z';
const CYCLE_END='2026-01-12T08:00:00.000Z';
const AGREED='2026-01-07T10:00:00.000Z';

// Member 2 exports; 3 is their partner; 4 is an unrelated member whose
// data must never appear; 1 is the owner.
async function fixture(){
  const db=await database();
  const statements=[
    `INSERT INTO auth_accounts (id,email,password_hash,display_name,color,is_admin,is_demo,bio,tz,interview_focus,leetcode_handle,phone,google_sub,last_login,is_available,availability_updated_at)
      VALUES (1,'owner@example.test','owner-hash-secret','Owner','#111111',1,0,NULL,NULL,'both',NULL,NULL,NULL,NULL,1,NULL)`,
    `INSERT INTO auth_accounts (id,email,password_hash,display_name,color,is_admin,is_demo,bio,tz,interview_focus,leetcode_handle,phone,google_sub,last_login,is_available,availability_updated_at)
      VALUES (2,'member@example.test','member-hash-secret','Member','#222222',0,0,'Member bio','Europe/London','dsa','member-lc','+44 7700 900222','google-subject-secret',NULL,1,NULL)`,
    `INSERT INTO auth_accounts (id,email,password_hash,display_name,color,is_admin,is_demo,bio,tz,interview_focus,leetcode_handle,phone,google_sub,last_login,is_available,availability_updated_at)
      VALUES (3,'partner@example.test','partner-hash-secret','Partner','#333333',0,0,NULL,NULL,'both',NULL,'+44 7700 900333','partner-google-subject',NULL,1,NULL)`,
    `INSERT INTO auth_accounts (id,email,password_hash,display_name,color,is_admin,is_demo,bio,tz,interview_focus,leetcode_handle,phone,google_sub,last_login,is_available,availability_updated_at)
      VALUES (4,'outsider@example.test','outsider-hash-secret','Outsider','#444444',0,0,NULL,NULL,'both',NULL,NULL,NULL,NULL,1,NULL)`,
    `INSERT INTO circles (id,public_id,slug,name,is_primary,created_by) VALUES (1,'circle-1','circle-1','Circle',1,1)`,
    `INSERT INTO circle_memberships (circle_id,user_id,role,status,invited_by) VALUES (1,1,'owner','active',NULL),(1,2,'member','active',1),(1,3,'member','active',1),(1,4,'member','active',1)`,
    `INSERT INTO auth_provider_identities (issuer,subject,user_id) VALUES ('https://accounts.google.com','google-subject-secret',2)`,
    `INSERT INTO pairing_cycles (scope_key,circle_id,cycle_key,cycle_id,starts_at,ends_at,cutoff_at,time_zone,default_source)
      VALUES ('local',NULL,'${CYCLE_KEY}','2026-W01','${CYCLE_START}','${CYCLE_END}','2026-01-04T08:00:00.000Z','Europe/London','cycle_default')`,
    `INSERT INTO pairing_cycles (scope_key,circle_id,cycle_key,cycle_id,starts_at,ends_at,cutoff_at,time_zone,default_source)
      VALUES ('circle:1',1,'${CYCLE_KEY}','2026-W01','${CYCLE_START}','${CYCLE_END}','2026-01-04T08:00:00.000Z','Europe/London','cycle_default')`,
    `INSERT INTO pairing_cycle_availability (scope_key,cycle_key,user_id,is_available,version,decision_source) VALUES ('local','${CYCLE_KEY}',2,1,1,'user'),('local','${CYCLE_KEY}',3,0,1,'user'),('local','${CYCLE_KEY}',4,1,1,'user')`,
    `INSERT INTO pairing_weeks (id,week_label,week_start,focus,is_demo) VALUES (1,'2026-W01','2026-01-05','both',0)`,
    `INSERT INTO pairing_participants (week_id,user_id,position,source) VALUES (1,2,0,'auth'),(1,3,1,'auth')`,
    `INSERT INTO pairing_groups (id,week_id,user_a_id,user_b_id,user_c_id,is_ai_pair,topic,topic_kind) VALUES (1,1,2,3,NULL,0,'Two Sum','dsa')`,
    `INSERT INTO pair_schedules (id,week_id,pair_group_id,proposed_times,agreed_time) VALUES (1,1,1,'[{"instant":"${AGREED}","proposed_by":3},{"instant":"2026-01-08T10:00:00.000Z","proposed_by":2},"2026-01-09T10:00:00.000Z"]','${AGREED}')`,
    `INSERT INTO pair_meeting_links (week_id,pair_group_id,accepted_schedule_at,meeting_url,revision,updated_by,updated_by_source,pair_user_a_id,pair_user_b_id,pair_user_c_id,created_at,updated_at)
      VALUES (1,1,'${AGREED}','https://meet.example.test/pair-room',1,2,'auth',2,3,NULL,'${AGREED}','${AGREED}')`,
    `INSERT INTO session_completion_receipts (week_id,pair_group_id,user_id,participant_source,pair_user_a_id,pair_user_b_id,pair_user_c_id,confirmed_at)
      VALUES (1,1,2,'auth',2,3,NULL,'2026-01-07T12:00:00.000Z'),(1,1,3,'auth',2,3,NULL,'2026-01-07T12:00:00.000Z')`,
    `INSERT INTO pair_session_controls (week_id,pair_group_id,pair_user_a_id,pair_user_a_source,pair_user_b_id,pair_user_b_source,pair_user_c_id,candidate_user_id,candidate_source,timer_state,remaining_ms,anchor_at,revision,updated_by,updated_by_source,created_at,updated_at)
      VALUES (1,1,2,'auth',3,'auth',NULL,2,'auth','paused',600000,NULL,1,2,'auth','2026-01-07T10:00:00.000Z','2026-01-07T10:00:00.000Z')`,
    `INSERT INTO pair_messages (week_id,pair_group_id,sender_id,message) VALUES (1,1,2,'hello from me'),(1,1,3,'partner secret message')`,
    `INSERT INTO session_runs (user_id,week_id,pair_group_id,question_id,question_slug,language,code,test_cases_snapshot,results_json,passed_count,total_count,duration_ms)
      VALUES (2,NULL,NULL,7,'two-sum','javascript','MY-SOLO-CODE','{}','[]',1,1,100)`,
    `INSERT INTO session_runs (user_id,week_id,pair_group_id,question_id,question_slug,language,code,test_cases_snapshot,results_json,passed_count,total_count,duration_ms)
      VALUES (2,1,1,7,'two-sum','javascript','MY-PAIR-CODE','{}','[]',2,2,200)`,
    `INSERT INTO session_runs (user_id,week_id,pair_group_id,question_id,question_slug,language,code,test_cases_snapshot,results_json,passed_count,total_count,duration_ms)
      VALUES (3,1,1,7,'two-sum','javascript','PARTNER-CODE','{}','[]',2,2,200)`,
    `INSERT INTO session_runs (user_id,week_id,pair_group_id,question_id,question_slug,language,code,test_cases_snapshot,results_json,passed_count,total_count,duration_ms)
      VALUES (4,NULL,NULL,7,'two-sum','javascript','OUTSIDER-CODE','{}','[]',1,1,100)`,
    `INSERT INTO user_notification_prefs (user_id,email_enabled,sms_enabled,phone,email) VALUES (2,1,0,'+44 7700 900222','member@example.test')`,
    `INSERT INTO custom_questions (slug,title,type,difficulty,category,description,test_cases,author_id) VALUES ('my-question','My Question','dsa','Medium','custom','Mine','[]',2),('partner-question','Partner Question','dsa','Medium','custom','Theirs','[]',3)`,
    `INSERT INTO circle_invitations (id,circle_id,token_hash,email_hash,created_by,created_at,expires_at,used_at,used_by,revoked_at)
      VALUES ('11111111-1111-4111-8111-111111111111',1,'${HEX('1')}','${HEX('2')}',2,'2026-01-01T00:00:00.000Z','2026-01-08T00:00:00.000Z',NULL,NULL,NULL)`,
    `INSERT INTO circle_invitations (id,circle_id,token_hash,email_hash,created_by,created_at,expires_at,used_at,used_by,revoked_at)
      VALUES ('22222222-2222-4222-8222-222222222222',1,'${HEX('3')}','${HEX('4')}',1,'2026-01-01T00:00:00.000Z','2026-01-08T00:00:00.000Z','2026-01-02T00:00:00.000Z',2,NULL)`,
    `INSERT INTO circle_invitations (id,circle_id,token_hash,email_hash,created_by,created_at,expires_at,used_at,used_by,revoked_at)
      VALUES ('33333333-3333-4333-8333-333333333333',1,'${HEX('5')}','${HEX('6')}',3,'2026-01-01T00:00:00.000Z','2026-01-08T00:00:00.000Z',NULL,NULL,NULL)`,
    // Pending invitation addressed to the member (hash of their email),
    // one addressed to the partner (must not appear in the member's
    // export), one revoked, one used by the member (accepted, not
    // received), and one expired-but-unused addressed to the member
    // (excluded by the received expiry filter, not labelled pending).
    // The pending invitation's expiry is far in the future so the
    // expiry filter keeps it regardless of when the test runs.
    `INSERT INTO circle_invitations (id,circle_id,token_hash,email_hash,created_by,created_at,expires_at,used_at,used_by,revoked_at)
      VALUES ('66666666-6666-4666-8666-666666666666',1,'${HEX('c')}','${hashInvitationEmail('member@example.test')}',1,'2026-01-04T00:00:00.000Z','2099-01-11T00:00:00.000Z',NULL,NULL,NULL)`,
    `INSERT INTO circle_invitations (id,circle_id,token_hash,email_hash,created_by,created_at,expires_at,used_at,used_by,revoked_at)
      VALUES ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',1,'${HEX('b')}','${hashInvitationEmail('member@example.test')}',1,'2026-01-04T00:00:00.000Z','2020-01-01T00:00:00.000Z',NULL,NULL,NULL)`,
    `INSERT INTO circle_invitations (id,circle_id,token_hash,email_hash,created_by,created_at,expires_at,used_at,used_by,revoked_at)
      VALUES ('77777777-7777-4777-8777-777777777777',1,'${HEX('d')}','${hashInvitationEmail('partner@example.test')}',1,'2026-01-04T00:00:00.000Z','2026-01-11T00:00:00.000Z',NULL,NULL,NULL)`,
    `INSERT INTO circle_invitations (id,circle_id,token_hash,email_hash,created_by,created_at,expires_at,used_at,used_by,revoked_at)
      VALUES ('88888888-8888-4888-8888-888888888888',1,'${HEX('e')}','${hashInvitationEmail('member@example.test')}',1,'2026-01-04T00:00:00.000Z','2026-01-11T00:00:00.000Z',NULL,NULL,'2026-01-05T00:00:00.000Z')`,
    `INSERT INTO circle_invitations (id,circle_id,token_hash,email_hash,created_by,created_at,expires_at,used_at,used_by,revoked_at)
      VALUES ('99999999-9999-4999-8999-999999999999',1,'${HEX('f')}','${hashInvitationEmail('member@example.test')}',1,'2026-01-03T00:00:00.000Z','2026-01-10T00:00:00.000Z','2026-01-03T00:00:00.000Z',2,NULL)`,
    // A circle the member created but holds no membership for.
    `INSERT INTO circles (id,public_id,slug,name,is_primary,created_by) VALUES (2,'circle-2','circle-2','Created Circle',0,2)`,
    `INSERT INTO invite_requests (id,circle_id,email_hash,email,name,note,status,created_at,expires_at)
      VALUES ('44444444-4444-4444-8444-444444444444',1,'${HEX('7')}','member@example.test','Member','Please let me in','pending',1700000000,1702600000)`,
    `INSERT INTO invite_requests (id,circle_id,email_hash,email,name,note,status,created_at,expires_at)
      VALUES ('55555555-5555-4555-8555-555555555555',1,'${HEX('8')}','partner@example.test','Partner','Partner request','pending',1700000000,1702600000)`,
    `INSERT INTO circle_pairing_publications (id,scope_key,circle_id,cycle_key,cycle_id,starts_at,ends_at,cutoff_at,time_zone,generation_token,algorithm_version,algorithm_seed,participant_count)
      VALUES (1,'circle:1',1,'${CYCLE_KEY}','2026-W01','${CYCLE_START}','${CYCLE_END}','2026-01-04T08:00:00.000Z','Europe/London','66666666-6666-4666-8666-666666666666','v1','seed',2)`,
    `INSERT INTO circle_pairing_eligibility (publication_id,scope_key,circle_id,cycle_key,user_id,is_available,availability_version,availability_source,position,group_position,group_size,member_position)
      VALUES (1,'circle:1',1,'${CYCLE_KEY}',2,1,1,'user',0,0,2,0),(1,'circle:1',1,'${CYCLE_KEY}',3,1,1,'user',1,0,2,1)`,
    `INSERT INTO circle_pairing_groups (publication_id,scope_key,circle_id,cycle_key,position,member_count,user_a_id,user_a_available,user_a_member_position,user_b_id,user_b_available,user_b_member_position,is_solo)
      VALUES (1,'circle:1',1,'${CYCLE_KEY}',0,2,2,1,0,3,1,1,0)`,
    `INSERT INTO circle_pair_schedules (schedule_key,publication_id,scope_key,circle_id,cycle_key,group_id,member_count,user_a_id,user_b_id,is_solo,revision,agreed_time,created_at,updated_at)
      VALUES ('${HEX('9')}',1,'circle:1',1,'${CYCLE_KEY}',1,2,2,3,0,1,'${AGREED}','${AGREED}','${AGREED}')`,
    `INSERT INTO circle_pair_schedule_proposals (schedule_id,schedule_key,publication_id,scope_key,circle_id,cycle_key,group_id,member_count,user_a_id,user_b_id,is_solo,proposal_key,instant,proposed_by,created_at)
      VALUES (1,'${HEX('9')}',1,'circle:1',1,'${CYCLE_KEY}',1,2,2,3,0,'${HEX('a')}', '${AGREED}',3,'${AGREED}')`,
    `INSERT INTO ai_sessions (room_id,pair_label,transcript,code_snapshots,interviewer_questions,created_by) VALUES ('room-1','pair','my transcript','{}','[]',2),('room-2','pair','partner transcript','{}','[]',3)`,
    `INSERT INTO ai_feedback (session_id,role,feedback_json,evidence) VALUES (1,'both','{"score":1}','my evidence'),(2,'both','{"score":2}','partner evidence')`,
    `INSERT INTO ai_consents (user_id,consented_at,revoked_at,policy_version) VALUES (2,'2026-01-01T00:00:00.000Z',NULL,'v1')`,
    `INSERT INTO ai_account_monthly_usage (month,user_id,calls,tokens_in) VALUES ('2026-01',2,3,100)`,
    `INSERT INTO ai_account_monthly_reservations (reservation_id,month,user_id,tokens_in,session_id) VALUES ('res-1','2026-01',2,50,1)`,
  ];
  for(const [index,sql] of statements.entries()){ try{ await db.execute(sql); }catch(error){ error.message=`fixture statement ${index}: ${sql.slice(0,140)}: ${error.message}`; throw error; } }
  return db;
}

test('the flag is off unless exactly true',()=>{
  assert.equal(dataExportEnabled({DATA_EXPORT_ENABLED:'true'}),true);
  assert.equal(dataExportEnabled({DATA_EXPORT_ENABLED:'false'}),false);
  assert.equal(dataExportEnabled({}),false);
  assert.equal(dataExportEnabled(),process.env.DATA_EXPORT_ENABLED==='true');
});

// The hard-coded expected coverage. This must NOT be derived from
// ACCOUNT_DATA_INVENTORY or DATA_EXPORT_TABLE_COVERAGE: the earlier test
// compared the coverage list against the inventory it was built from,
// so it passed every mutation it was meant to catch — adding a table to
// the inventory (which the fallback then "covers" with "Not yet
// reviewed"), removing a table from the inventory, and deleting an
// explicit entry (which also silently falls back). All three mutations
// must fail this test: the first two change the length / table list,
// the third changes the entry's section/included and trips the
// "Not yet reviewed" assertion below.
const EXPECTED_TABLE_COVERAGE=[
  {table:'auth_accounts',section:'profile',included:true},
  {table:'auth_sessions',section:null,included:false},
  {table:'auth_recent_proofs',section:null,included:false},
  {table:'auth_session_circle_contexts',section:null,included:false},
  {table:'auth_provider_identities',section:'profile',included:true},
  {table:'auth_provider_email_state',section:null,included:false},
  {table:'auth_password_resets',section:null,included:false},
  {table:'auth_email_activations',section:null,included:false},
  {table:'auth_identity_audit_events',section:null,included:false},
  {table:'auth_rate_limits',section:null,included:false},
  {table:'circle_memberships',section:'memberships',included:true},
  {table:'circles',section:'memberships',included:true},
  {table:'circle_invitations',section:'invitations',included:true},
  {table:'circle_audit_events',section:null,included:false},
  {table:'circle_creation_requests',section:null,included:false},
  {table:'invite_requests',section:'invite_requests',included:true},
  {table:'feedback_items',section:'feedback',included:true},
  {table:'feedback_votes',section:'feedback',included:true},
  {table:'feedback_events',section:null,included:false},
  {table:'pairing_cycle_availability',section:'availability',included:true},
  {table:'user_notification_prefs',section:'notification_preferences',included:true},
  {table:'pairing_participants',section:'pairings',included:true},
  {table:'pairing_groups',section:'pairings',included:true},
  {table:'pairing_week_runs',section:null,included:false},
  {table:'circle_pairing_eligibility',section:'pairings',included:true},
  {table:'circle_pairing_groups',section:'pairings',included:true},
  {table:'circle_pair_schedules',section:'schedules',included:true},
  {table:'circle_pair_schedule_proposals',section:'schedules',included:true},
  {table:'pair_schedules',section:'schedules',included:true},
  {table:'session_completion_receipts',section:'session_completions',included:true},
  {table:'pair_session_controls',section:'session_controls',included:true},
  {table:'pair_messages',section:'messages',included:true},
  {table:'session_runs',section:'code_runs',included:true},
  {table:'pair_code_documents',section:null,included:false},
  {table:'pair_room_snapshots',section:null,included:false},
  {table:'pair_meeting_links',section:'schedules',included:true},
  {table:'video_signals',section:null,included:false},
  {table:'ai_sessions',section:'ai',included:true},
  {table:'ai_feedback',section:'ai',included:true},
  {table:'ai_consents',section:'ai',included:true},
  {table:'ai_account_monthly_usage',section:'ai',included:true},
  {table:'ai_account_monthly_reservations',section:'ai',included:true},
  {table:'custom_questions',section:'custom_questions',included:true},
  {table:'app_logs',section:null,included:false},
  {table:'outbox_events',section:null,included:false},
  {table:'outbox_audit_events',section:null,included:false},
  {table:'pairing_email_outbox',section:null,included:false},
  {table:'users',section:null,included:false},
];

test('every inventory table has explicit export coverage',()=>{
  assert.equal(EXPECTED_TABLE_COVERAGE.length,48);
  assert.equal(ACCOUNT_DATA_INVENTORY.length,48);
  assert.deepEqual(
    DATA_EXPORT_TABLE_COVERAGE.map(entry=>({table:entry.table,section:entry.section,included:entry.included})),
    EXPECTED_TABLE_COVERAGE);
  for(const entry of DATA_EXPORT_TABLE_COVERAGE){
    assert.equal(typeof entry.reason,'string');
    assert.ok(entry.reason.length>10,entry.table);
    assert.ok(!entry.reason.startsWith('Not yet reviewed'),`${entry.table} has no explicit coverage entry`);
    assert.equal(typeof entry.included,'boolean');
    if(entry.included) assert.equal(typeof entry.section,'string',entry.table);
    else assert.equal(entry.section,null,entry.table);
  }
  for(const table of NO_PERSONAL_DATA_TABLES){
    assert.ok(!DATA_EXPORT_TABLE_COVERAGE.some(entry=>entry.table===table),table);
  }
});

test('readiness stays green on a migrated database and fails closed on drift',async()=>{
  const db=await fixture();
  await ensureDataExportReadiness(db);
  await db.execute('DROP TABLE pair_messages');
  await assert.rejects(()=>ensureDataExportReadiness(db));

  // The builder selects session_runs.code, so the readiness probe must
  // too: dropping the column must fail readiness, not the export.
  const other=await fixture();
  await other.execute('ALTER TABLE session_runs DROP COLUMN code');
  await assert.rejects(()=>ensureDataExportReadiness(other));
});

test('the export holds the member\'s own data from every exported section',async()=>{
  const db=await fixture();
  const archive=await buildDataExport(db,{userId:2});
  assert.equal(archive.version,1);
  assert.equal(archive.format,'randori-circle-data-export');
  assert.deepEqual(archive.account,{id:2,email:'member@example.test',display_name:'Member'});
  assert.equal(archive.profile.email,'member@example.test');
  assert.equal(archive.profile.phone,'+44 7700 900222');
  assert.equal(archive.profile.google_linked,true);
  assert.equal(archive.profile.is_admin,false);
  assert.deepEqual(archive.memberships.map(row=>row.circle_name),['Circle']);
  assert.equal(archive.memberships[0].invited_by,'Owner');
  assert.equal(archive.availability.length,1);
  assert.equal(archive.availability[0].cycle_id,'2026-W01');
  assert.deepEqual(archive.pairings.primary[0].partners,['Partner']);
  assert.equal(archive.pairings.primary[0].topic,'Two Sum');
  assert.equal(archive.pairings.participations.length,1);
  assert.deepEqual(archive.pairings.secondary_groups[0].partners,['Partner']);
  assert.equal(archive.pairings.secondary_eligibility.length,1);
  assert.deepEqual(archive.schedules.primary[0].partners,['Partner']);
  assert.equal(archive.schedules.primary[0].agreed_time,AGREED);
  // Proposed times are projected to instants + proposed_by_me: the raw
  // numeric proposer id (3, the partner) never reaches the archive.
  assert.deepEqual(archive.schedules.primary[0].proposed_times,[
    {instant:AGREED,proposed_by_me:false},
    {instant:'2026-01-08T10:00:00.000Z',proposed_by_me:true},
    {instant:'2026-01-09T10:00:00.000Z',proposed_by_me:null},
  ]);
  assert.deepEqual(archive.schedules.secondary[0].partners,['Partner']);
  assert.equal(archive.schedules.proposals[0].proposed_by,'Partner');
  assert.equal(archive.schedules.meeting_links[0].meeting_url,'https://meet.example.test/pair-room');
  assert.equal(archive.schedules.meeting_links[0].updated_by,'Member');
  assert.equal(archive.session_completions.length,1);
  assert.deepEqual(archive.session_completions[0].partners,['Partner']);
  assert.equal(archive.session_controls[0].candidate,'Member');
  assert.equal(archive.session_controls[0].updated_by,'Member');
  assert.deepEqual(archive.messages.map(row=>row.message),['hello from me']);
  assert.deepEqual(archive.messages[0].partners,['Partner']);
  assert.deepEqual(archive.code_runs.map(row=>row.code),['MY-PAIR-CODE','MY-SOLO-CODE']);
  assert.deepEqual(archive.notification_preferences.email,'member@example.test');
  assert.deepEqual(archive.custom_questions.map(row=>row.slug),['my-question']);
  assert.equal(archive.invitations.sent.length,1);
  assert.equal(archive.invitations.accepted.length,2);
  assert.equal(archive.invitations.accepted[0].created_by,'Owner');
  // Only the pending, unexpired invitation addressed to the member is received:
  // the partner's, the revoked one, the already-accepted one and the
  // expired-but-unused one are not.
  assert.equal(archive.invitations.received.length,1);
  assert.equal(archive.invitations.received[0].invitation_id,'66666666-6666-4666-8666-666666666666');
  assert.equal(archive.invitations.received[0].created_by,'Owner');
  assert.equal(archive.invitations.received[0].status,'pending');
  // The circle the member created but holds no membership for is
  // exported once, and only there — never duplicated in memberships.
  assert.deepEqual(archive.created_circles.map(row=>row.circle_name),['Created Circle']);
  assert.deepEqual(archive.memberships.map(row=>row.circle_name),['Circle']);
  assert.deepEqual(archive.truncated_sections,[]);
  assert.equal(archive.invite_requests.length,1);
  assert.equal(archive.invite_requests[0].email,'member@example.test');
  assert.equal(archive.ai.sessions.length,1);
  assert.equal(archive.ai.sessions[0].transcript,'my transcript');
  assert.equal(archive.ai.feedback.length,1);
  assert.equal(archive.ai.consents.policy_version,'v1');
  assert.equal(archive.ai.usage.length,1);
  assert.equal(archive.ai.reservations.length,1);
  // The migrated database has the v22 feedback tables, empty: the
  // feedback section is present (included) with no rows, not skipped.
  assert.equal(archive.feedback.included,true);
  assert.deepEqual(archive.feedback.items,[]);
  assert.deepEqual(archive.feedback.votes,[]);
  assert.equal(archive.feedback.events_included,false);
  assert.ok(archive.excluded_tables.some(row=>row.table==='auth_sessions'));
  assert.ok(archive.excluded_tables.some(row=>row.table==='pair_code_documents'));
  assert.equal(archive.counts.invitations_received,1);
  assert.equal(archive.counts.created_circles,1);
  assert.equal(archive.counts.messages,1);
  assert.equal(archive.counts.code_runs,2);
  assert.equal(archive.counts.feedback_items,0);
});

test('expired-but-unused invitations are excluded from received, not labelled pending',async()=>{
  const db=await fixture();
  const archive=await buildDataExport(db,{userId:2});
  assert.equal(archive.invitations.received.length,1);
  assert.ok(!archive.invitations.received.some(row=>row.invitation_id==='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'));
  assert.ok(!JSON.stringify(archive.invitations.received).includes('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'));
});

test('non-array proposed_times normalises to a single projected entry',async()=>{
  const cases=[
    // A bare instant, with or without JSON string quoting.
    ['2026-01-09T10:00:00.000Z',{instant:'2026-01-09T10:00:00.000Z',proposed_by_me:null}],
    ['"2026-01-09T10:00:00.000Z"',{instant:'2026-01-09T10:00:00.000Z',proposed_by_me:null}],
    // Anything else collapses to a null instant, never the raw value.
    ['123',{instant:null,proposed_by_me:null}],
    ['null',{instant:null,proposed_by_me:null}],
    // An object without proposed_by is not projected from its instant.
    ['{"instant":"2026-01-09T10:00:00.000Z"}',{instant:null,proposed_by_me:null}],
  ];
  for(const [stored,expected] of cases){
    const db=await fixture();
    await db.execute({sql:`UPDATE pair_schedules SET proposed_times=? WHERE id=1`,args:[stored]});
    const archive=await buildDataExport(db,{userId:2});
    assert.deepEqual(archive.schedules.primary[0].proposed_times,expected,stored);
  }
});

test('no other member\'s private data and no secret appears anywhere in the archive',async()=>{
  const db=await fixture();
  const archive=await buildDataExport(db,{userId:2});
  const text=JSON.stringify(archive);
  for(const secret of [
    'partner@example.test','outsider@example.test','partner-hash-secret','outsider-hash-secret',
    'member-hash-secret','google-subject-secret','partner-google-subject',
    'partner secret message','PARTNER-CODE','OUTSIDER-CODE','Partner request','partner transcript',
    'partner evidence','+44 7700 900333',
  ]) assert.ok(!text.includes(secret),secret);
  // Partner ids must not appear as an id field; the partner's display name is the only trace.
  assert.ok(!/\"(?:user_id|partner_id|sender_id|author_id|created_by|used_by|invited_by|proposed_by|updated_by|candidate_user_id|voter_user_id)\":3/.test(text));
  // The modern schedule proposal is from the partner (id 3): its raw
  // proposed_by must not appear anywhere in the archive, in any form.
  assert.ok(!text.includes('"proposed_by":3'),'"proposed_by":3 leaked');
  assert.ok(!text.includes('"proposed_by":"3"'),'"proposed_by":"3" leaked');
  assert.ok(!text.includes('"google_sub"'));
  assert.ok(!text.includes('token_hash'));
  assert.ok(!text.includes('email_hash'));
});

test('an outsider export holds only their own rows',async()=>{
  const db=await fixture();
  const archive=await buildDataExport(db,{userId:4});
  assert.deepEqual(archive.messages,[]);
  assert.deepEqual(archive.code_runs.map(row=>row.code),['OUTSIDER-CODE']);
  assert.deepEqual(archive.pairings.primary,[]);
  assert.equal(archive.profile.email,'outsider@example.test');
});

test('unknown accounts and bad input are refused',async()=>{
  const db=await fixture();
  await assert.rejects(()=>buildDataExport(db,{userId:99}),/account not found/);
  await assert.rejects(()=>buildDataExport(db,{userId:0}),/valid data export required/);
  await assert.rejects(()=>buildDataExport(null,{userId:2}),/valid data export required/);
});

test('feedback is included when its tables exist, and skipped when the author column is unrecognised',async()=>{
  const db=await fixture();
  // The v22 feedback tables already exist in the migrated database, so
  // seed them with the landed schema — never CREATE them here (that
  // collides with the real tables). Ids are UUIDs, timestamps are epoch
  // seconds, votes key on feedback_id/user_id, events carry a marker
  // detail that must never reach the archive.
  const statements=[
    `INSERT INTO feedback_items (id,circle_id,author_user_id,kind,title,body,status,visibility,diagnostics_json,idempotency_key,created_at,updated_at,closed_at) VALUES
      ('11111111-1111-4111-8111-111111111111',1,2,'bug','My bug','my body','open','private','{"browser":"TestBrowser"}','feedback-mine-12345678',1700000000,1700000000,NULL),
      ('22222222-2222-4222-8222-222222222222',1,3,'feature_request','Partner bug','partner body','open','private',NULL,'feedback-partner-12345678',1700000001,1700000001,NULL)`,
    `INSERT INTO feedback_votes (feedback_id,user_id,value,created_at) VALUES
      ('22222222-2222-4222-8222-222222222222',2,1,1700000002),
      ('11111111-1111-4111-8111-111111111111',3,1,1700000002)`,
    `INSERT INTO feedback_events (feedback_id,event_type,actor_user_id,detail_json,created_at) VALUES
      ('11111111-1111-4111-8111-111111111111','feedback.created',2,'{"audit_marker":"feedback-event-must-not-export"}',1700000000),
      ('22222222-2222-4222-8222-222222222222','feedback.status_changed',2,'{"from_status":"open","to_status":"in_progress"}',1700000003)`,
  ];
  await db.batch(statements,'write');
  const archive=await buildDataExport(db,{userId:2});
  assert.equal(archive.feedback.included,true);
  assert.deepEqual(archive.feedback.items.map(row=>row.title),['My bug']);
  assert.deepEqual(archive.feedback.items[0],{
    id:'11111111-1111-4111-8111-111111111111',circle_id:1,author_user_id:2,
    kind:'bug',title:'My bug',body:'my body',status:'open',visibility:'private',
    diagnostics_json:{browser:'TestBrowser'},created_at:1700000000,updated_at:1700000000,
  });
  // Only the vote the member cast (on the partner's item) is exported;
  // the partner's vote on the member's item is not the member's data.
  assert.equal(archive.feedback.votes.length,1);
  assert.equal(archive.feedback.votes[0].feedback_id,'22222222-2222-4222-8222-222222222222');
  assert.equal(archive.feedback.votes[0].user_id,2);
  assert.equal(archive.feedback.votes[0].value,1);
  assert.equal(archive.feedback.events_included,false);
  assert.equal(archive.counts.feedback_items,1);
  assert.equal(archive.counts.feedback_votes,1);
  const text=JSON.stringify(archive);
  assert.ok(!text.includes('partner body'));
  // Events are never exported, even for the member's own item / actor.
  assert.ok(!text.includes('feedback-event-must-not-export'));
  assert.ok(!text.includes('audit_marker'));
  // The item's idempotency key is a dedup token, not user content.
  assert.ok(!text.includes('feedback-mine-12345678'));

  // A feedback_items table with no recognised author column is skipped
  // cleanly. The real table is dropped (children first, FKs are on) and
  // replaced with a stub in this disposable test database only.
  const other=await fixture();
  await other.batch([
    `DROP TABLE feedback_events`,
    `DROP TABLE feedback_votes`,
    `DROP TABLE feedback_items`,
    `CREATE TABLE feedback_items (id INTEGER PRIMARY KEY, creator_id INTEGER, title TEXT)`,
  ],'write');
  const skipped=await buildDataExport(other,{userId:2});
  assert.equal(skipped.feedback.included,false);
  assert.match(skipped.feedback.reason,/no recognised author column/);
});

test('the size bound refuses an archive over 5 MB',async()=>{
  const db=await fixture();
  const big='x'.repeat(300_000);
  const statements=Array.from({length:20},(_,index)=>({sql:
    `INSERT INTO session_runs (user_id,question_slug,language,code) VALUES (2,'big-${index}','javascript',?)`,
    args:[big]}));
  await db.batch(statements,'write');
  await assert.rejects(()=>buildDataExport(db,{userId:2}),
    (error)=>error instanceof DataExportTooLargeError&&error.code==='EXPORT_TOO_LARGE');
  assert.ok(DATA_EXPORT_MAX_BYTES===5_000_000);
});

test('per-section caps bound the archive: only the newest 1,000 code runs are kept',async()=>{
  const db=await fixture();
  const statements=Array.from({length:DATA_EXPORT_SECTION_LIMITS.codeRuns+5},(_,index)=>({sql:
    `INSERT INTO session_runs (user_id,question_slug,language,code) VALUES (2,'cap-${index}','javascript','code-${index}')`,
    args:[]}));
  await db.batch(statements,'write');
  const archive=await buildDataExport(db,{userId:2});
  assert.equal(archive.code_runs.length,DATA_EXPORT_SECTION_LIMITS.codeRuns);
  assert.equal(archive.code_runs[0].code,'code-1004');
  assert.equal(archive.counts.code_runs,DATA_EXPORT_SECTION_LIMITS.codeRuns);
  // The cap is disclosed, not silent: only code_runs hit its cap.
  assert.deepEqual(archive.truncated_sections,['code_runs']);
});

test('a capped feedback section is disclosed in truncated_sections',async()=>{
  const db=await fixture();
  // The v22 feedback_items table already exists: insert into it with the
  // landed schema (UUID id, epoch timestamps, per-author idempotency
  // key). Distinct created_at values make newest-first order exact.
  const statements=Array.from({length:DATA_EXPORT_SECTION_LIMITS.feedbackItems+1},(_,index)=>({sql:
    `INSERT INTO feedback_items (id,circle_id,author_user_id,kind,title,body,status,visibility,idempotency_key,created_at,updated_at,closed_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,NULL)`,
    args:[`00000000-0000-4000-8000-${String(index).padStart(12,'0')}`,1,2,'bug',`Bug ${index+1}`,'body','open','private',`feedback-cap-${index}-12345678`,1700000000+index,1700000000+index]}));
  await db.batch(statements,'write');
  const archive=await buildDataExport(db,{userId:2});
  assert.equal(archive.feedback.included,true);
  assert.equal(archive.feedback.items.length,DATA_EXPORT_SECTION_LIMITS.feedbackItems);
  assert.equal(archive.feedback.items[0].title,`Bug ${DATA_EXPORT_SECTION_LIMITS.feedbackItems+1}`);
  assert.equal(archive.feedback.truncated_items,true);
  assert.equal(archive.feedback.truncated_votes,false);
  assert.ok(archive.truncated_sections.includes('feedback_items'));
});
