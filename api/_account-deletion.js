// Self-service account deletion (issue #339, ID-81), behind
// ACCOUNT_DELETION_ENABLED. Requires CIRCLE_MEMBERSHIP_ENABLED: the legacy
// membership-free mode treats every account row as a circle member, so a
// tombstone would reappear in its roster and pairing.
//
// The account row is tombstoned, not deleted. Partners' pairings, completed
// sessions, schedules and recaps reference it through RESTRICT foreign keys
// and immutable triggers; keeping the row lets that history resolve to
// "Deleted member" while every personal column is cleared. Everything runs in
// one write transaction with the recent-authentication proof and the
// last-owner rule checked inside it, so concurrent requests serialize and a
// retry is a no-op. No schema change: every column reused here already exists.
import { requireRecentAuth } from './_recent-auth.js';

export const ACCOUNT_DELETION_CONFIRMATION='DELETE';
export const DELETED_MEMBER_NAME='Deleted member';
export const DELETED_MEMBER_COLOR='#9aa0a6';
export const DELETED_ACCOUNT_PASSWORD_HASH='!account-deleted';
export const DELETED_ACCOUNT_EMAIL_DOMAIN='account-deleted.invalid';
export const DELETED_MESSAGE_TEXT='Message deleted';
export const ACCOUNT_DELETED_REASON='ACCOUNT_DELETED';
export const ACCOUNT_DELETED_AUDIT_EVENT='account.deleted';
// Request paths that write to an account by id append this to their WHERE
// clause, so a request authenticated just before a deletion commits cannot
// write into the tombstone afterwards (sign-in refreshes, ADMIN_EMAILS grants,
// profile saves, Google linking, solo runs, notification preferences).
export const LIVE_ACCOUNT_SQL="password_hash<>'!account-deleted'";
// auth_email_activations.password_hash must be 20-128 characters.
const SCRUBBED_ACTIVATION_PASSWORD_HASH='!account-deleted-scrubbed';
const OUTBOX_ACTOR='account-deletion';
const SESSION_REVOCATION_REASON='logout_all';
const MAX_BLOCKING_CIRCLES=20;

// Every table holding this member's personal data or id, and what deletion
// does with it. tests/unit/account-deletion.test.mjs asserts that each listed
// column is handled on a migrated database and that every table in the schema
// manifest is either listed here or in NO_PERSONAL_DATA_TABLES.
export const ACCOUNT_DATA_INVENTORY=Object.freeze([
  ['auth_accounts',['email','password_hash','display_name','color','bio','tz','interview_focus','leetcode_handle','phone','google_sub','last_login','is_available','availability_updated_at','is_admin'],'anonymise',
    'Tombstone: partners\' history and RESTRICT keys need the id. Email becomes non-routable, name "Deleted member", no password or Google subject.'],
  ['auth_sessions',['user_id'],'revoke','Every live session revoked in the same transaction; rows age out through the 30-day session retention.'],
  ['auth_recent_proofs',['session_hash','user_id'],'delete','Step-up proofs are useless once sessions are revoked.'],
  ['auth_session_circle_contexts',['session_hash','user_id','circle_id'],'delete','Per-session circle selection.'],
  ['auth_provider_identities',['subject','user_id'],'delete','Google link removed so the Google account can sign up again as a new member.'],
  ['auth_provider_email_state',['subject','email_hash'],'delete','Keyed hash of the Google email for the removed link.'],
  ['auth_password_resets',['user_id','email_hash','token_hash'],'delete','Pending or used reset tokens.'],
  ['auth_email_activations',['email','email_hash','password_hash','display_name','color'],'anonymise',
    'The activation that created the account still held the email, name and password hash. Scrubbed (pending ones revoked); the row stays for its RESTRICT invitation key.'],
  ['auth_identity_audit_events',['user_id','actor_user_id'],'keep','Security audit of codes only, no personal data; the id now resolves to the tombstone.'],
  ['auth_rate_limits',['key'],'keep','Secret-keyed hashes that expire within 15 minutes and cannot be linked back to the account.'],
  ['circle_memberships',['user_id','role','status','invited_by'],'anonymise',
    'Every membership made inactive and demoted to member. Rows stay so history and invited_by resolve to "Deleted member"; reactivation is refused.'],
  ['circles',['created_by'],'keep','Shared circle; created_by is an opaque id that now resolves to the tombstone.'],
  ['circle_invitations',['created_by','used_by','email_hash'],'revoke',
    'Unused invitations they sent are revoked and audited. The invitation they accepted keeps its provenance but its email fingerprint is replaced with a random value.'],
  ['circle_audit_events',['actor_user_id','subject_user_id'],'keep','Audit trail of ids only. An account.deleted event with no personal data is added per circle.'],
  ['circle_creation_requests',['actor_user_id','initiating_session_hash'],'keep','Idempotency record for circles they created: hashes and ids only, RESTRICT-bound to the circle.'],
  ['invite_requests',['email','name','note','decided_by'],'anonymise','A pending request from their email is expired and scrubbed; decisions they made keep only the opaque decided_by id.'],
  ['pairing_cycle_availability',['user_id'],'delete','Availability decisions. Publications keep their own immutable snapshot.'],
  ['user_notification_prefs',['user_id','phone','email'],'delete','Email and reminder preferences.'],
  ['pairing_participants',['user_id'],'keep','Immutable pairing snapshot that partners\' completed sessions depend on (trigger-guarded).'],
  ['pairing_groups',['user_a_id','user_b_id','user_c_id'],'keep','Partners\' pairing history; shown as "Deleted member".'],
  ['pairing_week_runs',['participants_json'],'keep','Holds only ids, sources and availability versions.'],
  ['circle_pairing_eligibility',['user_id'],'keep','Immutable publication snapshot (RESTRICT).'],
  ['circle_pairing_groups',['user_a_id','user_b_id'],'keep','Partners\' secondary-circle pairing history.'],
  ['circle_pair_schedules',['user_a_id','user_b_id'],'keep','Partners\' agreed secondary-circle schedules.'],
  ['circle_pair_schedule_proposals',['proposed_by'],'keep','Partners\' schedule history; proposer is an opaque id.'],
  ['pair_schedules',['proposed_times'],'keep','Agreed and proposed times stay in the partner\'s recap; proposer ids are opaque.'],
  ['session_completion_receipts',['user_id'],'keep','Immutable; the partner\'s completed-session count needs both receipts.'],
  ['pair_session_controls',['candidate_user_id','updated_by'],'keep','Interview roles stay in the partner\'s progress.'],
  ['pair_messages',['sender_id','message'],'anonymise','Text of every message they sent becomes "Message deleted"; the row keeps the partner\'s conversation in order.'],
  ['session_runs',['user_id','code','test_cases_snapshot','results_json'],'anonymise',
    'Solo runs are deleted. Pair runs keep their verified summary for the partner; code is cleared unless it is the attested shared pair document.'],
  ['pair_code_documents',['last_actor_id','y_state_base64'],'keep','Jointly written pair document; stays with the partner and expires after 90 days.'],
  ['pair_room_snapshots',['updated_by','code'],'keep','Jointly written pair workspace; stays with the partner and expires after 90 days.'],
  ['pair_meeting_links',['updated_by','meeting_url'],'delete','A link they added may be their personal meeting room.'],
  ['video_signals',['from_id','to_id','payload'],'keep','Signalling keyed by random peer ids, not the account; purged after about an hour.'],
  ['ai_sessions',['created_by','transcript','code_snapshots','interviewer_questions'],'delete','AI sessions they started (AI is off in production).'],
  ['ai_feedback',['session_id','feedback_json','evidence'],'delete','Feedback on the AI sessions they started.'],
  ['ai_consents',['user_id'],'delete','AI consent record.'],
  ['ai_account_monthly_usage',['user_id'],'delete','Per-member AI quota counters.'],
  ['ai_account_monthly_reservations',['user_id'],'delete','Per-member AI quota reservations.'],
  ['custom_questions',['author_id'],'anonymise','Shared question text stays; the author link is cleared.'],
  ['app_logs',['user_id','ip','ua','route','message','meta_json'],'delete','Client and server log rows linked to the account.'],
  ['outbox_events',['payload_json'],'anonymise',
    'Pending, retrying and dead-lettered emails to them are suppressed (audited, ACCOUNT_DELETED); their address and token or credential envelopes are scrubbed.'],
  ['outbox_audit_events',['actor_ref'],'keep','Delivery audit; operator references are opaque ids.'],
  ['pairing_email_outbox',['user_id','recipient_email'],'anonymise','Legacy queue rows to them are cancelled and the address replaced.'],
  ['users',['name'],'keep','Legacy pre-membership roster keyed by name only; it cannot be attributed to the account without risking another member\'s row.'],
].map(([table,columns,action,reason])=>Object.freeze({table,columns:Object.freeze(columns),action,reason})));

export const NO_PERSONAL_DATA_TABLES=Object.freeze([
  'ai_usage','chat_retention_audit_events','chat_retention_control','chat_retention_legal_holds','chat_retention_runs',
  'chat_retention_scopes','circle_membership_rollout','circle_pairing_publications','credential_key_controls',
  'pairing_cycles','pairing_weeks','questions',
]);

// Browser storage the client clears after a deletion, and server-side
// services that hold no account data by design. Documented with the table
// inventory in docs/ACCOUNT_DELETION.md.
export const CLIENT_DATA_INVENTORY=Object.freeze([
  Object.freeze({store:'cookie randori_session',action:'delete',reason:'Cleared with Max-Age=0 by the deletion response.'}),
  Object.freeze({store:'localStorage randori-*',action:'delete',reason:'Profile copy, unsent code and whiteboard drafts, last room, reminder contact and device flags; only randori-theme and randori-landing-dismissed stay.'}),
  Object.freeze({store:'sessionStorage randori-*',action:'delete',reason:'Pending recent-auth continuations and invitation bindings.'}),
  Object.freeze({store:'Sentry',action:'keep',reason:'No account data is sent: the server scrubber drops user ids, emails and IPs, and the browser SDK runs with sendDefaultPii=false and no setUser.'}),
]);

export class AccountDeletionInputError extends Error{
  constructor(code){ super(code); this.name='AccountDeletionInputError'; this.code=code; }
}

function positiveId(value){
  const number=Number(value);
  return Number.isSafeInteger(number)&&number>0?number:null;
}

export function accountDeletionEnabled(env=process.env){
  return env?.ACCOUNT_DELETION_ENABLED==='true'&&env?.CIRCLE_MEMBERSHIP_ENABLED==='true';
}

export function deletedAccountEmail(userId){
  const id=positiveId(userId);
  if(!id) throw new TypeError('valid account id required');
  return `deleted-${id}@${DELETED_ACCOUNT_EMAIL_DOMAIN}`;
}

export function isDeletedAccount(row){
  return String(row?.password_hash??'')===DELETED_ACCOUNT_PASSWORD_HASH;
}

/** Accepts exactly {"confirm":"DELETE"}; anything else (including a user id) is refused. */
export function parseAccountDeletionRequest(body){
  if(!body||typeof body!=='object'||Array.isArray(body)) throw new AccountDeletionInputError('confirmation_required');
  const keys=Object.keys(body);
  if(keys.length!==1||keys[0]!=='confirm'||body.confirm!==ACCOUNT_DELETION_CONFIRMATION){
    throw new AccountDeletionInputError('confirmation_required');
  }
  return Object.freeze({confirm:ACCOUNT_DELETION_CONFIRMATION});
}

// Read-only probe of every column this module reads or writes. Missing or
// older schema fails closed before any mutation; there is no request-path DDL.
const READINESS_PROBES=Object.freeze([
  `SELECT id,email,password_hash,display_name,color,created_at,last_login,is_available,availability_updated_at,is_admin,is_demo,bio,tz,interview_focus,leetcode_handle,phone,google_sub FROM auth_accounts LIMIT 0`,
  `SELECT session_hash,user_id,revoked_at,revocation_reason,expires_at FROM auth_sessions LIMIT 0`,
  `SELECT session_hash,user_id,authenticated_at,method FROM auth_recent_proofs LIMIT 0`,
  `SELECT session_hash,user_id,circle_id FROM auth_session_circle_contexts LIMIT 0`,
  `SELECT issuer,subject,user_id FROM auth_provider_identities LIMIT 0`,
  `SELECT issuer,subject,email_hash FROM auth_provider_email_state LIMIT 0`,
  `SELECT id,user_id FROM auth_password_resets LIMIT 0`,
  `SELECT id,email,email_hash,password_hash,display_name,color,created_at,used_at,revoked_at FROM auth_email_activations LIMIT 0`,
  `SELECT circle_id,user_id,role,status,updated_at FROM circle_memberships LIMIT 0`,
  `SELECT id,public_id,name,is_primary,archived_at FROM circles LIMIT 0`,
  `SELECT id,circle_id,email_hash,created_by,used_at,used_by,revoked_at FROM circle_invitations LIMIT 0`,
  `SELECT id,circle_id,event_type,actor_user_id,subject_user_id,invitation_id,dedupe_key,created_at FROM circle_audit_events LIMIT 0`,
  `SELECT id,email,name,note,status,created_at,decided_at,decided_by,invitation_id FROM invite_requests LIMIT 0`,
  `SELECT user_id FROM pairing_cycle_availability LIMIT 0`,
  `SELECT user_id FROM user_notification_prefs LIMIT 0`,
  `SELECT id,sender_id,message FROM pair_messages LIMIT 0`,
  `SELECT id,user_id,pair_group_id,code,test_cases_snapshot FROM session_runs LIMIT 0`,
  `SELECT week_id,pair_group_id,updated_by FROM pair_meeting_links LIMIT 0`,
  `SELECT id,created_by FROM ai_sessions LIMIT 0`,
  `SELECT id,session_id FROM ai_feedback LIMIT 0`,
  `SELECT user_id FROM ai_consents LIMIT 0`,
  `SELECT user_id FROM ai_account_monthly_usage LIMIT 0`,
  `SELECT user_id FROM ai_account_monthly_reservations LIMIT 0`,
  `SELECT id,author_id FROM custom_questions LIMIT 0`,
  `SELECT id,user_id FROM app_logs LIMIT 0`,
  `SELECT id,event_type,payload_json,status,attempt_count,lease_owner,lease_token,leased_until,claim_from_status,last_error_code,updated_at FROM outbox_events LIMIT 0`,
  `SELECT outbox_event_id,action,actor_type,actor_ref,from_status,to_status,reason_code,attempt_number FROM outbox_audit_events LIMIT 0`,
  `SELECT id,user_id,recipient_email,status,updated_at FROM pairing_email_outbox LIMIT 0`,
]);

export async function ensureAccountDeletionReadiness(db){
  if(!db||typeof db.batch!=='function') throw new TypeError('database client is required');
  await db.batch(READINESS_PROBES,'read');
}

async function readAccount(executor,userId){
  const result=await executor.execute({
    sql:`SELECT id,email,password_hash,is_admin,is_demo FROM auth_accounts WHERE id=? LIMIT 2`,
    args:[userId],
  });
  return result.rows?.length===1?result.rows[0]:null;
}

async function lastOwnerCircles(executor,userId){
  const result=await executor.execute({
    sql:`SELECT circle.public_id,circle.name,circle.is_primary
      FROM circle_memberships membership
      JOIN circles circle ON circle.id=membership.circle_id
      WHERE membership.user_id=? AND membership.role='owner' AND membership.status='active'
        AND circle.archived_at IS NULL
        AND NOT EXISTS (
          SELECT 1 FROM circle_memberships other
          JOIN auth_accounts other_account ON other_account.id=other.user_id
          WHERE other.circle_id=membership.circle_id AND other.user_id<>membership.user_id
            AND other.role='owner' AND other.status='active' AND COALESCE(other_account.is_demo,0)=0
        )
      ORDER BY circle.is_primary DESC,circle.id
      LIMIT ?`,
    args:[userId,MAX_BLOCKING_CIRCLES],
  });
  return Object.freeze(result.rows.map(row=>Object.freeze({
    public_id:String(row.public_id),
    name:String(row.name).slice(0,120),
    is_primary:Number(row.is_primary)===1,
  })));
}

// The last active, non-demo app admin cannot remove themselves, mirroring the
// revoke_admin invariant. ADMIN_EMAILS stays the recovery path for operators.
async function isLastAdmin(executor,account,adminEmails){
  const configured=adminEmails.has(String(account.email).trim().toLowerCase());
  if(Number(account.is_admin)!==1&&!configured) return false;
  const result=await executor.execute({
    sql:`SELECT COUNT(DISTINCT admin.id) AS other_admins
      FROM auth_accounts admin
      JOIN circle_memberships membership ON membership.user_id=admin.id
      JOIN circles circle ON circle.id=membership.circle_id
      WHERE admin.id<>? AND admin.is_admin=1 AND COALESCE(admin.is_demo,0)=0
        AND membership.status='active' AND circle.archived_at IS NULL`,
    args:[Number(account.id)],
  });
  return Number(result.rows?.[0]?.other_admins||0)===0;
}

function normalizedAdminEmails(adminEmails){
  return new Set([...adminEmails].map(email=>String(email).trim().toLowerCase()).filter(Boolean));
}

async function evaluateEligibility(executor,account,adminEmails){
  if(Number(account.is_demo)===1) return Object.freeze({ok:false,reason:'demo_account'});
  const circles=await lastOwnerCircles(executor,Number(account.id));
  if(circles.length) return Object.freeze({ok:false,reason:'last_owner',circles});
  if(await isLastAdmin(executor,account,adminEmails)) return Object.freeze({ok:false,reason:'last_admin'});
  return Object.freeze({ok:true});
}

/** Read-only pre-check for the settings UI. The deletion re-checks everything in its transaction. */
export async function readAccountDeletionEligibility(db,{userId,adminEmails=[]}={}){
  const id=positiveId(userId);
  if(!db||typeof db.execute!=='function'||!id) throw new TypeError('valid account deletion eligibility query required');
  const account=await readAccount(db,id);
  if(!account) return Object.freeze({ok:false,reason:'not_found'});
  if(isDeletedAccount(account)) return Object.freeze({ok:false,reason:'already_deleted'});
  return evaluateEligibility(db,account,normalizedAdminEmails(adminEmails));
}

/**
 * True when a still-signed request belongs to an account that was already
 * deleted from that session: the deletion response may have been lost, so a
 * retry is answered as done instead of as an authentication failure.
 */
export async function accountDeletedForSession(db,{userId,sessionHash}={}){
  const id=positiveId(userId);
  if(!db||typeof db.execute!=='function'||!id||!/^[a-f0-9]{64}$/.test(String(sessionHash))) return false;
  const result=await db.execute({
    sql:`SELECT 1 AS deleted FROM auth_sessions session
      JOIN auth_accounts account ON account.id=session.user_id
      WHERE session.session_hash=? AND session.user_id=? AND account.password_hash=?
      LIMIT 1`,
    args:[sessionHash,id,DELETED_ACCOUNT_PASSWORD_HASH],
  });
  return result.rows?.length===1;
}

// Outbox rows addressed to this member, by event type: recipient ids (schedule,
// secondary schedule, reminders), the pairing recipient, the owner of an
// invite-request digest, a recipient email (activation, reset, legacy pairing),
// and the invitation email of the invitation they accepted.
const OUTBOX_RECIPIENT_SQL=`(
  json_extract(payload_json,'$.recipient_user_id')=?
  OR (event_type='pairing.email.requested' AND json_extract(payload_json,'$.user_id')=?)
  OR (event_type='inviterequest.email.requested' AND json_extract(payload_json,'$.owner_user_id')=?)
  OR json_extract(payload_json,'$.recipient_email')=?
  OR (event_type='invitation.email.requested' AND json_extract(payload_json,'$.invitation_id') IN (
    SELECT id FROM circle_invitations WHERE used_by=?))
)`;
// Invitation emails for the unused invitations they sent; those invitations
// are revoked below, so any queued delivery is suppressed too.
const OUTBOX_SENT_INVITATION_SQL=`(event_type='invitation.email.requested'
  AND json_extract(payload_json,'$.invitation_id') IN (
    SELECT id FROM circle_invitations WHERE created_by=? AND used_at IS NULL AND used_by IS NULL AND revoked_at IS NULL))`;
const OUTBOX_ACTIONABLE="status IN ('pending','retry','dead_letter')";

function outboxRecipientArgs(userId,email){
  return [userId,userId,userId,email,userId];
}

function changed(result){
  return Number(result?.rowsAffected||0);
}

async function scrubOutbox(transaction,{userId,email,tombstoneEmail}){
  const recipientArgs=outboxRecipientArgs(userId,email);
  const suppressWhere=`${OUTBOX_ACTIONABLE} AND (${OUTBOX_RECIPIENT_SQL} OR ${OUTBOX_SENT_INVITATION_SQL})`;
  const suppressArgs=[...recipientArgs,userId];
  await transaction.execute({
    sql:`INSERT INTO outbox_audit_events
        (outbox_event_id,action,actor_type,actor_ref,from_status,to_status,reason_code,attempt_number)
      SELECT id,'suppressed','system',?,status,'suppressed',?,attempt_count
      FROM outbox_events WHERE ${suppressWhere}`,
    args:[OUTBOX_ACTOR,ACCOUNT_DELETED_REASON,...suppressArgs],
  });
  const suppressed=await transaction.execute({
    sql:`UPDATE outbox_events
      SET status='suppressed',lease_owner=NULL,lease_token=NULL,leased_until=NULL,claim_from_status=NULL,
        last_error_code=?,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
      WHERE ${suppressWhere}`,
    args:[ACCOUNT_DELETED_REASON,...suppressArgs],
  });
  // A row a worker holds right now keeps its envelope so the in-flight lease
  // and key-rotation metrics stay valid; only the address is replaced. Every
  // other row addressed to them loses its token or credential envelope and
  // the email fingerprint of the invitation they accepted.
  const scrubbed=await transaction.execute({
    sql:`UPDATE outbox_events
      SET payload_json=CASE WHEN status='processing'
          THEN json_replace(payload_json,'$.recipient_email',?)
          ELSE json_remove(json_replace(payload_json,'$.recipient_email',?),
            '$.token_envelope','$.credential_envelope','$.email_hash')
        END,
        updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
      WHERE ${OUTBOX_RECIPIENT_SQL}`,
    args:[tombstoneEmail,tombstoneEmail,...recipientArgs],
  });
  const legacy=await transaction.execute({
    sql:`UPDATE pairing_email_outbox
      SET status=CASE WHEN status IN ('pending','failed','sending','exhausted') THEN 'cancelled' ELSE status END,
        recipient_email=?,updated_at=datetime('now')
      WHERE user_id=?`,
    args:[tombstoneEmail,userId],
  });
  return {outbox_suppressed:changed(suppressed),outbox_scrubbed:changed(scrubbed),legacy_outbox:changed(legacy)};
}

async function revokeSentInvitations(transaction,{userId,occurredAt}){
  const revoked=await transaction.execute({
    sql:`UPDATE circle_invitations SET revoked_at=?
      WHERE created_by=? AND used_at IS NULL AND used_by IS NULL AND revoked_at IS NULL
      RETURNING id,circle_id`,
    args:[occurredAt,userId],
  });
  for(const row of revoked.rows){
    await transaction.execute({
      sql:`INSERT INTO circle_audit_events
          (circle_id,event_type,actor_user_id,subject_user_id,invitation_id,dedupe_key,created_at)
        VALUES (?,'invitation.revoked',?,NULL,?,?,?)
        ON CONFLICT(dedupe_key) DO NOTHING`,
      args:[Number(row.circle_id),userId,String(row.id),`invitation-revoked:${row.id}`,occurredAt],
    });
  }
  // The accepted invitation stays used and unrevoked: it is this account's
  // audited membership provenance. Only its email fingerprint is replaced.
  const accepted=await transaction.execute({
    sql:`UPDATE circle_invitations SET email_hash=lower(hex(randomblob(32))) WHERE used_by=?`,
    args:[userId],
  });
  return {invitations_revoked:revoked.rows?.length||0,invitations_scrubbed:changed(accepted)};
}

async function scrubPreAccountRecords(transaction,{email,tombstoneEmail,nowSeconds}){
  const activations=await transaction.execute({
    sql:`UPDATE auth_email_activations
      SET email=?,email_hash=lower(hex(randomblob(32))),password_hash=?,display_name=?,color=?,
        revoked_at=CASE WHEN used_at IS NULL AND revoked_at IS NULL THEN MAX(?,created_at) ELSE revoked_at END
      WHERE email=?`,
    args:[tombstoneEmail,SCRUBBED_ACTIVATION_PASSWORD_HASH,DELETED_MEMBER_NAME,DELETED_MEMBER_COLOR,nowSeconds,email],
  });
  const requests=await transaction.execute({
    sql:`UPDATE invite_requests
      SET status='expired',email=NULL,name=NULL,note=NULL,decided_at=MAX(?,created_at),decided_by=NULL,invitation_id=NULL
      WHERE status='pending' AND email=?`,
    args:[nowSeconds,email],
  });
  return {activations_scrubbed:changed(activations),invite_requests_expired:changed(requests)};
}

async function removeCredentials(transaction,{userId,nowSeconds}){
  // Same statement as revokeAccountSessions in _db.js, kept here so this
  // module (and the constants other modules import) has no _db.js dependency.
  const sessions=await transaction.execute({
    sql:`UPDATE auth_sessions SET revoked_at=?,revocation_reason=?
      WHERE user_id=? AND revoked_at IS NULL AND expires_at>? RETURNING session_hash`,
    args:[nowSeconds,SESSION_REVOCATION_REASON,userId,nowSeconds],
  });
  await transaction.execute({sql:`DELETE FROM auth_recent_proofs WHERE user_id=?`,args:[userId]});
  await transaction.execute({sql:`DELETE FROM auth_session_circle_contexts WHERE user_id=?`,args:[userId]});
  await transaction.execute({
    sql:`DELETE FROM auth_provider_email_state WHERE EXISTS (
      SELECT 1 FROM auth_provider_identities identity
      WHERE identity.issuer=auth_provider_email_state.issuer AND identity.subject=auth_provider_email_state.subject
        AND identity.user_id=?)`,
    args:[userId],
  });
  const identities=await transaction.execute({sql:`DELETE FROM auth_provider_identities WHERE user_id=?`,args:[userId]});
  await transaction.execute({sql:`DELETE FROM auth_password_resets WHERE user_id=?`,args:[userId]});
  return {sessions_revoked:sessions.rows.length,google_links_removed:changed(identities)};
}

async function removeActivity(transaction,{userId,occurredAt}){
  await transaction.execute({sql:`DELETE FROM pairing_cycle_availability WHERE user_id=?`,args:[userId]});
  await transaction.execute({sql:`DELETE FROM user_notification_prefs WHERE user_id=?`,args:[userId]});
  const memberships=await transaction.execute({
    sql:`UPDATE circle_memberships SET status='inactive',role='member',updated_at=? WHERE user_id=?`,
    args:[occurredAt,userId],
  });
  const messages=await transaction.execute({
    sql:`UPDATE pair_messages SET message=? WHERE sender_id=? AND message<>?`,
    args:[DELETED_MESSAGE_TEXT,userId,DELETED_MESSAGE_TEXT],
  });
  const soloRuns=await transaction.execute({
    sql:`DELETE FROM session_runs WHERE user_id=? AND pair_group_id IS NULL`,args:[userId],
  });
  // v3 pair runs execute the server-acknowledged shared document; their code
  // is the pair's joint work (kept in pair_code_documents) and its hash is
  // what makes the partner's feed show the run as verified.
  const pairRuns=await transaction.execute({
    sql:`UPDATE session_runs SET code=''
      WHERE user_id=? AND pair_group_id IS NOT NULL AND code<>''
        AND (CASE WHEN json_valid(test_cases_snapshot)
          THEN json_extract(test_cases_snapshot,'$.attestation_version') END) IS NOT 3`,
    args:[userId],
  });
  await transaction.execute({sql:`DELETE FROM pair_meeting_links WHERE updated_by=?`,args:[userId]});
  await transaction.execute({
    sql:`DELETE FROM ai_feedback WHERE session_id IN (SELECT id FROM ai_sessions WHERE created_by=?)`,args:[userId],
  });
  await transaction.execute({sql:`DELETE FROM ai_sessions WHERE created_by=?`,args:[userId]});
  await transaction.execute({sql:`DELETE FROM ai_consents WHERE user_id=?`,args:[userId]});
  await transaction.execute({sql:`DELETE FROM ai_account_monthly_usage WHERE user_id=?`,args:[userId]});
  await transaction.execute({sql:`DELETE FROM ai_account_monthly_reservations WHERE user_id=?`,args:[userId]});
  await transaction.execute({sql:`UPDATE custom_questions SET author_id=NULL WHERE author_id=?`,args:[userId]});
  const logs=await transaction.execute({sql:`DELETE FROM app_logs WHERE user_id=?`,args:[userId]});
  return {
    memberships_deactivated:changed(memberships),messages_redacted:changed(messages),
    solo_runs_deleted:changed(soloRuns),pair_run_code_cleared:changed(pairRuns),logs_deleted:changed(logs),
  };
}

async function auditDeletion(transaction,{userId,circleIds,occurredAt}){
  for(const circleId of circleIds){
    await transaction.execute({
      sql:`INSERT INTO circle_audit_events
          (circle_id,event_type,actor_user_id,subject_user_id,invitation_id,dedupe_key,created_at)
        VALUES (?,?,?,?,NULL,?,?)
        ON CONFLICT(dedupe_key) DO NOTHING`,
      args:[circleId,ACCOUNT_DELETED_AUDIT_EVENT,userId,userId,
        `${ACCOUNT_DELETED_AUDIT_EVENT}:${circleId}:${userId}`,occurredAt],
    });
  }
}

async function tombstoneAccount(transaction,{userId,tombstoneEmail}){
  const result=await transaction.execute({
    sql:`UPDATE auth_accounts
      SET email=?,password_hash=?,display_name=?,color=?,google_sub=NULL,bio=NULL,tz=NULL,
        interview_focus='both',leetcode_handle=NULL,phone=NULL,last_login=NULL,is_available=0,
        availability_updated_at=NULL,is_admin=0
      WHERE id=? AND password_hash<>? AND COALESCE(is_demo,0)=0
      RETURNING id`,
    args:[tombstoneEmail,DELETED_ACCOUNT_PASSWORD_HASH,DELETED_MEMBER_NAME,DELETED_MEMBER_COLOR,
      userId,DELETED_ACCOUNT_PASSWORD_HASH],
  });
  if(result.rows?.length!==1||positiveId(result.rows[0].id)!==userId) throw new Error('account tombstone failed');
}

async function rollback(transaction){
  try{ await transaction.rollback(); }catch{}
}

/**
 * Deletes the signed-in member's account. `sessionHash` is the request's own
 * session: the recent-authentication proof must belong to it and is checked
 * inside the write transaction, before any change.
 */
export async function deleteAccount(db,{
  userId,sessionHash,adminEmails=[],nowSeconds=Math.floor(Date.now()/1000),
}={}){
  const id=positiveId(userId);
  if(!db||typeof db.transaction!=='function'||!id||!/^[a-f0-9]{64}$/.test(String(sessionHash))
    ||!Number.isSafeInteger(nowSeconds)||nowSeconds<1){
    throw new TypeError('valid account deletion required');
  }
  const admins=normalizedAdminEmails(adminEmails);
  const occurredAt=new Date(nowSeconds*1000).toISOString();
  const transaction=await db.transaction('write');
  let finished=false;
  const stop=async result=>{
    await rollback(transaction); finished=true;
    return Object.freeze(result);
  };
  try{
    const account=await readAccount(transaction,id);
    if(!account) return await stop({ok:false,reason:'not_found'});
    if(isDeletedAccount(account)) return await stop({ok:true,status:'already_deleted'});
    await requireRecentAuth(transaction,{id,sessionHash},{nowSeconds});
    const eligibility=await evaluateEligibility(transaction,account,admins);
    if(!eligibility.ok) return await stop(eligibility);
    const email=String(account.email).trim().toLowerCase();
    const tombstoneEmail=deletedAccountEmail(id);
    const memberships=await transaction.execute({
      sql:`SELECT DISTINCT circle_id FROM circle_memberships WHERE user_id=? ORDER BY circle_id`,args:[id],
    });
    const circleIds=memberships.rows.map(row=>Number(row.circle_id));
    const summary={
      ...await scrubOutbox(transaction,{userId:id,email,tombstoneEmail}),
      ...await revokeSentInvitations(transaction,{userId:id,occurredAt}),
      ...await scrubPreAccountRecords(transaction,{email,tombstoneEmail,nowSeconds}),
      ...await removeCredentials(transaction,{userId:id,nowSeconds}),
      ...await removeActivity(transaction,{userId:id,occurredAt}),
    };
    await auditDeletion(transaction,{userId:id,circleIds,occurredAt});
    await tombstoneAccount(transaction,{userId:id,tombstoneEmail});
    await transaction.commit(); finished=true;
    return Object.freeze({ok:true,status:'deleted',summary:Object.freeze({...summary,circles_audited:circleIds.length})});
  }catch(error){
    if(!finished) await rollback(transaction);
    throw error;
  }
}
