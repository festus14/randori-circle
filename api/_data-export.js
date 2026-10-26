// Member data export (issue #365, ID-90), behind DATA_EXPORT_ENABLED.
//
// A signed-in member downloads a machine-readable JSON archive of their OWN
// data. Every table in the account-deletion inventory (api/_account-deletion.js)
// is accounted for in DATA_EXPORT_TABLE_COVERAGE below: a table is either
// exported through one of the sections, or explicitly excluded with a reason
// (secrets, ephemeral session/session-context rows, security audit trails,
// joint pair documents whose other half belongs to a partner, operational
// logs and outbox envelopes, or rows that cannot be attributed to one member).
// A table the inventory gains later that has no explicit entry here falls
// back to "excluded, not yet reviewed" at runtime, so a new inventory table
// can never leak through the export; tests/unit/data-export.test.mjs
// asserts no fallback entry remains, so the test fails until the entry
// is written.
//
// Partner privacy: no other member's private data is included. Partners
// appear by display name only (the same rule as the member's history views):
// no partner ids, emails, phones, hashes or tokens anywhere in the archive.
// Only the requesting member's own messages are exported, never a partner's
// chat messages, even though both partners see the conversation in the room.
// Meeting links are included only for pair groups the member belongs to, the
// same visibility the room already gives them.
//
// Feedback (#353, `feedback_items` / `feedback_votes` / `feedback_events`)
// is not in the inventory yet. When those tables exist, the member's own
// feedback items and their own votes are included; when they do not exist
// they are cleanly skipped (feedback.included=false). Feedback events are an
// audit trail and are never exported. A follow-up issue (#385) tracks confirming
// the #353 column names once #353 lands.
//
// Size: every section is capped (DATA_EXPORT_SECTION_LIMITS) and the
// sections that hit their cap are listed in `truncated_sections`, so a
// capped archive is explicit about what it left out instead of silently
// partial. The whole serialised archive must fit DATA_EXPORT_MAX_BYTES,
// otherwise the export is refused with EXPORT_TOO_LARGE.
// Partner privacy: proposed schedule times are projected to
// {instant, proposed_by_me} — see projectProposedTimes.
import { ACCOUNT_DATA_INVENTORY } from './_account-deletion.js';
import { hashInvitationEmail } from './_circle-membership.js';

export const DATA_EXPORT_VERSION=1;
export const DATA_EXPORT_FORMAT='randori-circle-data-export';
// 5 MB: comfortably above any real member archive (profile, pairings and a
// few thousand messages/runs) and well inside a serverless response budget.
export const DATA_EXPORT_MAX_BYTES=5_000_000;

export function dataExportEnabled(env=process.env){
  return env?.DATA_EXPORT_ENABLED==='true';
}

export class DataExportTooLargeError extends Error{
  constructor(){
    super('data export exceeds the size bound');
    this.name='DataExportTooLargeError';
    this.code='EXPORT_TOO_LARGE';
  }
}

export const DATA_EXPORT_SECTION_LIMITS=Object.freeze({
  memberships:100,
  availability:500,
  primaryPairings:500,
  participations:500,
  secondaryPairingGroups:500,
  secondaryEligibility:500,
  primarySchedules:500,
  secondarySchedules:500,
  scheduleProposals:1000,
  meetingLinks:500,
  sessionCompletions:1000,
  sessionControls:500,
  messages:2000,
  codeRuns:1000,
  customQuestions:500,
  invitationsSent:500,
  invitationsAccepted:500,
  invitationsReceived:500,
  createdCircles:100,
  inviteRequests:100,
  aiSessions:200,
  aiFeedback:500,
  aiUsage:120,
  aiReservations:500,
  feedbackItems:500,
  feedbackVotes:1000,
});

// Coverage of every account-deletion inventory table. `section` names the
// export section that carries the table's rows, or null when it is excluded.
const EXPLICIT_TABLE_COVERAGE=Object.freeze({
  auth_accounts:{section:'profile',included:true,reason:'Own profile row, without password hash or Google subject.'},
  auth_sessions:{section:null,included:false,reason:'Ephemeral session records; session hashes are secrets and no user content is in them.'},
  auth_recent_proofs:{section:null,included:false,reason:'Step-up proof for the current session only; no user content.'},
  auth_session_circle_contexts:{section:null,included:false,reason:'Ephemeral per-session circle selection; no user content.'},
  auth_provider_identities:{section:'profile',included:true,reason:'Summarised only as profile.google_linked; the Google subject itself is a credential identifier and is not exported.'},
  auth_provider_email_state:{section:null,included:false,reason:'Keyed hash of the Google email for the removed-link check; a credential artefact, not user content.'},
  auth_password_resets:{section:null,included:false,reason:'Token hashes for password recovery; secrets, not user content.'},
  auth_email_activations:{section:null,included:false,reason:'Holds the account-creation password hash and email; a credential artefact, not user content.'},
  auth_identity_audit_events:{section:null,included:false,reason:'Security audit trail of identity changes; ids and codes only, not user content.'},
  auth_rate_limits:{section:null,included:false,reason:'Secret-keyed rate-limit hashes that expire within 15 minutes.'},
  circle_memberships:{section:'memberships',included:true,reason:'Own memberships, with the circle and the inviter by display name.'},
  circles:{section:'memberships',included:true,reason:'Circle metadata for circles the member belongs to, plus circles they created but hold no membership for (created_circles), reached through their membership or created_by.'},
  circle_invitations:{section:'invitations',included:true,reason:'Invitations the member sent, accepted, or received (pending invitations addressed to them, matched by email hash), without token or email hashes.'},
  circle_audit_events:{section:null,included:false,reason:'Circle audit trail of ids and event types; not user content.'},
  circle_creation_requests:{section:null,included:false,reason:'Idempotency record holding a session hash; a credential artefact.'},
  invite_requests:{section:'invite_requests',included:true,reason:'Own pending requests to join (decided rows are scrubbed of email and cannot be attributed).'},
  pairing_cycle_availability:{section:'availability',included:true,reason:'Own availability decisions per cycle.'},
  user_notification_prefs:{section:'notification_preferences',included:true,reason:'Own email and reminder preferences.'},
  pairing_participants:{section:'pairings',included:true,reason:'Own participation rows.'},
  pairing_groups:{section:'pairings',included:true,reason:'Pair groups the member belongs to, partners by display name only.'},
  pairing_week_runs:{section:null,included:false,reason:'Holds every participant id for a week; the member\'s own pairings are exported from pairing_groups instead.'},
  circle_pairing_eligibility:{section:'pairings',included:true,reason:'Own secondary-circle pairing eligibility snapshot.'},
  circle_pairing_groups:{section:'pairings',included:true,reason:'Secondary-circle pair groups the member belongs to, partner by display name only.'},
  circle_pair_schedules:{section:'schedules',included:true,reason:'Secondary-circle schedules for the member\'s own groups.'},
  circle_pair_schedule_proposals:{section:'schedules',included:true,reason:'Schedule proposals for the member\'s own secondary groups, proposer by display name.'},
  pair_schedules:{section:'schedules',included:true,reason:'Agreed and proposed times for the member\'s own pair groups.'},
  session_completion_receipts:{section:'session_completions',included:true,reason:'Own completion receipts, partners by display name only.'},
  pair_session_controls:{section:'session_controls',included:true,reason:'Timer and interview-role controls for the member\'s own pair groups, actors by display name.'},
  pair_messages:{section:'messages',included:true,reason:'Only messages the member sent; a partner\'s messages are the partner\'s data and are never exported.'},
  session_runs:{section:'code_runs',included:true,reason:'Own code runs, solo and pair.'},
  pair_code_documents:{section:null,included:false,reason:'Jointly written pair document; the partner\'s contributions are the partner\'s data.'},
  pair_room_snapshots:{section:null,included:false,reason:'Jointly written pair workspace; the partner\'s contributions are the partner\'s data.'},
  pair_meeting_links:{section:'schedules',included:true,reason:'Meeting links for the member\'s own pair groups, the same visibility the room already gives them.'},
  video_signals:{section:null,included:false,reason:'Ephemeral call set-up signalling keyed by random peer ids, purged after about an hour.'},
  ai_sessions:{section:'ai',included:true,reason:'AI sessions the member started.'},
  ai_feedback:{section:'ai',included:true,reason:'Feedback on the member\'s own AI sessions (distinct from #353 product feedback).'},
  ai_consents:{section:'ai',included:true,reason:'Own AI consent record.'},
  ai_account_monthly_usage:{section:'ai',included:true,reason:'Own per-month AI quota counters.'},
  ai_account_monthly_reservations:{section:'ai',included:true,reason:'Own per-month AI quota reservations.'},
  custom_questions:{section:'custom_questions',included:true,reason:'Questions the member authored.'},
  app_logs:{section:null,included:false,reason:'Operational log rows; they can carry other members\' or system data in their metadata and are not user content.'},
  outbox_events:{section:null,included:false,reason:'Email queue rows holding sealed token and credential envelopes; secrets, not user content.'},
  outbox_audit_events:{section:null,included:false,reason:'Delivery audit with operator references; not user content.'},
  pairing_email_outbox:{section:null,included:false,reason:'Legacy email queue rows; the member\'s own address is already in their profile.'},
  users:{section:null,included:false,reason:'Legacy pre-membership roster keyed by name only; it cannot be attributed to one account without risking another member\'s row.'},
});

export const DATA_EXPORT_TABLE_COVERAGE=Object.freeze(ACCOUNT_DATA_INVENTORY.map(({table})=>{
  const entry=EXPLICIT_TABLE_COVERAGE[table];
  if(entry) return Object.freeze({table,section:entry.section,included:entry.included,reason:entry.reason});
  return Object.freeze({table,section:null,included:false,
    reason:'Not yet reviewed for export; excluded until reviewed.'});
}));

export const DATA_EXPORT_EXCLUDED_TABLES=Object.freeze(
  DATA_EXPORT_TABLE_COVERAGE.filter(entry=>!entry.included)
    .map(entry=>Object.freeze({table:entry.table,reason:entry.reason})),
);

function positiveId(value){
  const number=Number(value);
  return Number.isSafeInteger(number)&&number>0?number:null;
}

async function query(db,sql,args=[]){
  const result=await db.execute({sql,args});
  return result.rows??[];
}

function parsedJson(value){
  if(typeof value!=='string') return value??null;
  try{ return JSON.parse(value); }catch{ return value; }
}

/**
 * Project stored `pair_schedules.proposed_times` for export. The stored
 * form mixes legacy bare instants with modern
 * {instant, proposed_by:<numeric member id>} entries, and the raw numeric
 * id is another member's id whenever the partner proposed the time, so it
 * must never reach the archive. The projection keeps only the instant and
 * whether the requesting member proposed it; a legacy entry, whose
 * proposer is unknown, gets proposed_by_me:null. Every other JSON blob
 * the export carries was audited for the same shape and carries no
 * partner numeric id: session-run attestation snapshots hold only
 * week/pair-group ids, hashes and signatures; ai_feedback.feedback_json
 * and feedback diagnostics_json are the member's own rows' payloads.
 */
function projectProposedTimes(value,userId){
  const parsed=parsedJson(value);
  if(!Array.isArray(parsed)){
    if(parsed&&typeof parsed==='object'&&'proposed_by' in parsed){
      const proposedBy=Number(parsed.proposed_by);
      return Object.freeze({instant:typeof parsed.instant==='string'?parsed.instant:null,
        proposed_by_me:Number.isSafeInteger(proposedBy)?proposedBy===userId:null});
    }
    return parsed;
  }
  return Object.freeze(parsed.map(entry=>{
    if(typeof entry==='string') return Object.freeze({instant:entry,proposed_by_me:null});
    if(entry&&typeof entry==='object'&&typeof entry.instant==='string'){
      const proposedBy=Number(entry.proposed_by);
      return Object.freeze({instant:entry.instant,
        proposed_by_me:Number.isSafeInteger(proposedBy)?proposedBy===userId:null});
    }
    return Object.freeze({instant:null,proposed_by_me:null});
  }));
}

/**
 * Run a capped section query with one extra row: fetching limit+1 tells
 * the export whether the section hit its cap without a separate COUNT
 * that could drift from the query's joins/filters. Returns the first
 * `limit` rows plus `truncated`.
 */
async function cappedQuery(db,sql,args,limit){
  const rows=await query(db,sql,[...args,limit+1]);
  return {rows:rows.slice(0,limit),truncated:rows.length>limit};
}

/** Display names of the ids in `pairs` ([id, displayName]) except the member. */
function partnerNames(pairs,userId){
  return pairs.filter(([id,name])=>Number(id)!==Number(userId)&&typeof name==='string'&&name)
    .map(([,name])=>String(name).slice(0,80));
}

function displayName(value){
  return typeof value==='string'&&value?String(value).slice(0,80):null;
}

async function tableExists(db,name){
  const rows=await query(db,
    `SELECT 1 AS present FROM sqlite_master WHERE type='table' AND name=? LIMIT 1`,[name]);
  return rows.length===1;
}

async function tableColumns(db,name){
  const rows=await query(db,`PRAGMA table_info(${name})`);
  return new Set(rows.map(row=>String(row.name)));
}

function pickColumn(columns,candidates){
  return candidates.find(candidate=>columns.has(candidate))||null;
}

/**
 * The member's own product-feedback rows (#353), when those tables exist.
 * Column names are discovered with PRAGMA, so a feedback table whose final
 * #353 schema names its author/voter column differently is skipped cleanly
 * instead of failing the whole export. Feedback events (audit) are never
 * exported.
 */
async function readFeedback(db,userId){
  const empty=Object.freeze({included:false,items:[],votes:[],votes_included:false,events_included:false,
    truncated_items:false,truncated_votes:false,
    reason:'Feedback tables are not present (issue #353 has not landed).'});
  if(!await tableExists(db,'feedback_items')) return empty;
  const itemColumns=await tableColumns(db,'feedback_items');
  const authorColumn=pickColumn(itemColumns,['author_user_id','user_id','author_id']);
  if(!authorColumn) return Object.freeze({...empty,
    reason:'feedback_items has no recognised author column; skipped.'});
  const wanted=['id','circle_id',authorColumn,'kind','title','body','status','visibility',
    'diagnostics_json','created_at','updated_at'];
  const selected=wanted.filter(column=>itemColumns.has(column));
  const itemRowsAll=await query(db,
    `SELECT ${selected.join(',')} FROM feedback_items WHERE ${authorColumn}=? ORDER BY created_at DESC,id DESC LIMIT ?`,
    [userId,DATA_EXPORT_SECTION_LIMITS.feedbackItems+1]);
  const truncatedItems=itemRowsAll.length>DATA_EXPORT_SECTION_LIMITS.feedbackItems;
  const itemRows=itemRowsAll.slice(0,DATA_EXPORT_SECTION_LIMITS.feedbackItems);
  const items=itemRows.map(row=>{
    const item={};
    for(const column of selected) item[column]=column==='diagnostics_json'?parsedJson(row[column]):row[column]??null;
    return Object.freeze(item);
  });
  let votes=[];
  let votesIncluded=false;
  let votesReason=null;
  let truncatedVotes=false;
  if(await tableExists(db,'feedback_votes')){
    const voteColumns=await tableColumns(db,'feedback_votes');
    const voterColumn=pickColumn(voteColumns,['voter_user_id','user_id','author_user_id']);
    const itemColumn=pickColumn(voteColumns,['feedback_item_id','item_id','feedback_id']);
    if(voterColumn&&itemColumn){
      const voteWanted=['id',itemColumn,voterColumn,'value','created_at','updated_at'];
      const voteSelected=voteWanted.filter(column=>voteColumns.has(column));
      const voteRowsAll=await query(db,
        `SELECT ${voteSelected.join(',')} FROM feedback_votes WHERE ${voterColumn}=? ORDER BY created_at DESC,id DESC LIMIT ?`,
        [userId,DATA_EXPORT_SECTION_LIMITS.feedbackVotes+1]);
      truncatedVotes=voteRowsAll.length>DATA_EXPORT_SECTION_LIMITS.feedbackVotes;
      const voteRows=voteRowsAll.slice(0,DATA_EXPORT_SECTION_LIMITS.feedbackVotes);
      votes=voteRows.map(row=>{
        const vote={};
        for(const column of voteSelected) vote[column]=row[column]??null;
        return Object.freeze(vote);
      });
      votesIncluded=true;
    }else{
      votesReason='feedback_votes has no recognised voter/item column; skipped.';
    }
  }
  return Object.freeze({included:true,items:Object.freeze(items),votes:Object.freeze(votes),
    votes_included:votesIncluded,events_included:false,
    truncated_items:truncatedItems,truncated_votes:truncatedVotes,
    ...(votesReason?{votes_reason:votesReason}:{})});
}

const READINESS_PROBES=Object.freeze([
  `SELECT id,email,display_name,color,created_at,last_login,is_available,availability_updated_at,is_admin,is_demo,bio,tz,interview_focus,leetcode_handle,phone FROM auth_accounts LIMIT 0`,
  `SELECT issuer,subject,user_id FROM auth_provider_identities LIMIT 0`,
  `SELECT circle_id,user_id,role,status,invited_by,joined_at,updated_at FROM circle_memberships LIMIT 0`,
  `SELECT id,public_id,name,is_primary,archived_at,created_by,created_at FROM circles LIMIT 0`,
  `SELECT id,circle_id,email_hash,created_by,created_at,expires_at,used_at,used_by,revoked_at FROM circle_invitations LIMIT 0`,
  `SELECT id,circle_id,email,name,note,status,created_at,expires_at,decided_at,decided_by,invitation_id FROM invite_requests LIMIT 0`,
  `SELECT scope_key,cycle_key,user_id,is_available,version,decision_source,created_at,updated_at FROM pairing_cycle_availability LIMIT 0`,
  `SELECT scope_key,cycle_key,cycle_id FROM pairing_cycles LIMIT 0`,
  `SELECT user_id,phone,email,email_enabled,sms_enabled,updated_at FROM user_notification_prefs LIMIT 0`,
  `SELECT week_id,user_id,position,source,created_at FROM pairing_participants LIMIT 0`,
  `SELECT id,week_id,user_a_id,user_b_id,user_c_id,is_ai_pair,topic,topic_kind,created_at FROM pairing_groups LIMIT 0`,
  `SELECT id,week_label,week_start,is_demo FROM pairing_weeks LIMIT 0`,
  `SELECT id,publication_id,scope_key,circle_id,cycle_key,position,member_count,user_a_id,user_b_id,is_solo,created_at FROM circle_pairing_groups LIMIT 0`,
  `SELECT publication_id,scope_key,circle_id,cycle_key,user_id,is_available,availability_version,availability_source,position,group_position,group_size,member_position,created_at FROM circle_pairing_eligibility LIMIT 0`,
  `SELECT id,week_id,pair_group_id,proposed_times,agreed_time,created_at,updated_at FROM pair_schedules LIMIT 0`,
  `SELECT id,publication_id,scope_key,circle_id,cycle_key,group_id,user_a_id,user_b_id,revision,agreed_time,created_at,updated_at FROM circle_pair_schedules LIMIT 0`,
  `SELECT id,schedule_id,group_id,user_a_id,user_b_id,proposed_by,instant,created_at FROM circle_pair_schedule_proposals LIMIT 0`,
  `SELECT week_id,pair_group_id,accepted_schedule_at,meeting_url,revision,updated_by,pair_user_a_id,pair_user_b_id,pair_user_c_id,created_at,updated_at FROM pair_meeting_links LIMIT 0`,
  `SELECT week_id,pair_group_id,user_id,participant_source,pair_user_a_id,pair_user_b_id,pair_user_c_id,confirmed_at FROM session_completion_receipts LIMIT 0`,
  `SELECT week_id,pair_group_id,pair_user_a_id,pair_user_b_id,pair_user_c_id,candidate_user_id,timer_state,remaining_ms,anchor_at,revision,updated_by,created_at,updated_at FROM pair_session_controls LIMIT 0`,
  `SELECT id,week_id,pair_group_id,sender_id,message,created_at FROM pair_messages LIMIT 0`,
  `SELECT id,user_id,week_id,pair_group_id,question_id,question_slug,language,code,test_cases_snapshot,results_json,passed_count,total_count,duration_ms,created_at FROM session_runs LIMIT 0`,
  `SELECT id,slug,title,type,difficulty,category,description,input_format,constraints_text,examples,test_cases,starter_per_lang,author_id,source,leetcode_slug,created_at FROM custom_questions LIMIT 0`,
  `SELECT id,room_id,pair_label,transcript,code_snapshots,interviewer_questions,started_at,ended_at,duration_sec,cost_cents,created_at,created_by FROM ai_sessions LIMIT 0`,
  `SELECT id,session_id,role,feedback_json,evidence,model_used,reason_for_pick,estimated_cost_cents,confidence,created_at FROM ai_feedback LIMIT 0`,
  `SELECT user_id,consented_at,revoked_at,policy_version FROM ai_consents LIMIT 0`,
  `SELECT month,user_id,calls,tokens_in,updated_at FROM ai_account_monthly_usage LIMIT 0`,
  `SELECT reservation_id,month,user_id,tokens_in,session_id,refunded_at,created_at FROM ai_account_monthly_reservations LIMIT 0`,
]);

export async function ensureDataExportReadiness(db){
  if(!db||typeof db.execute!=='function') throw new TypeError('database client is required');
  for(const sql of READINESS_PROBES) await db.execute(sql);
}

/** Builds the member's export archive. Throws DataExportTooLargeError over the bound. */
export async function buildDataExport(db,{userId}={}){
  const id=positiveId(userId);
  if(!db||typeof db.execute!=='function'||!id) throw new TypeError('valid data export required');

  const profileRows=await query(db,
    `SELECT account.id,account.email,account.display_name,account.color,account.created_at,
      account.last_login,account.is_available,account.availability_updated_at,account.is_admin,
      account.is_demo,account.bio,account.tz,account.interview_focus,account.leetcode_handle,
      account.phone,
      EXISTS (SELECT 1 FROM auth_provider_identities identity WHERE identity.user_id=account.id) AS google_linked
    FROM auth_accounts account WHERE account.id=? LIMIT 2`,[id]);
  if(profileRows.length!==1) throw new Error('account not found');
  const profileRow=profileRows[0];
  const profile=Object.freeze({
    id:Number(profileRow.id),
    email:String(profileRow.email),
    display_name:String(profileRow.display_name),
    color:String(profileRow.color),
    created_at:profileRow.created_at??null,
    last_login:profileRow.last_login??null,
    is_available:Number(profileRow.is_available)===1,
    availability_updated_at:profileRow.availability_updated_at??null,
    is_admin:Number(profileRow.is_admin)===1,
    is_demo:Number(profileRow.is_demo)===1,
    bio:profileRow.bio??null,
    tz:profileRow.tz??null,
    interview_focus:profileRow.interview_focus??null,
    leetcode_handle:profileRow.leetcode_handle??null,
    phone:profileRow.phone??null,
    google_linked:Number(profileRow.google_linked)===1,
  });
  const email=profile.email;
  // Sections that hit their per-section cap. The archive lists them in
  // `truncated_sections` instead of silently dropping the excess rows.
  const truncatedSections=[];
  const markTruncated=(name,truncated)=>{ if(truncated) truncatedSections.push(name); };

  const {rows:membershipRows,truncated:membershipsTruncated}=await cappedQuery(db,
    `SELECT membership.circle_id,circle.public_id,circle.name,circle.is_primary,circle.archived_at,
      membership.role,membership.status,membership.joined_at,membership.updated_at,
      inviter.display_name AS invited_by_display_name
    FROM circle_memberships membership
    JOIN circles circle ON circle.id=membership.circle_id
    LEFT JOIN auth_accounts inviter ON inviter.id=membership.invited_by
    WHERE membership.user_id=? ORDER BY circle.id LIMIT ?`,
    [id],DATA_EXPORT_SECTION_LIMITS.memberships);
  markTruncated('memberships',membershipsTruncated);
  const memberships=Object.freeze(membershipRows.map(row=>Object.freeze({
    circle_id:Number(row.circle_id),
    circle_public_id:String(row.public_id),
    circle_name:String(row.name),
    circle_is_primary:Number(row.is_primary)===1,
    circle_archived_at:row.archived_at??null,
    role:String(row.role),
    status:String(row.status),
    joined_at:row.joined_at??null,
    updated_at:row.updated_at??null,
    invited_by:displayName(row.invited_by_display_name),
  })));

  const {rows:availabilityRows,truncated:availabilityTruncated}=await cappedQuery(db,
    `SELECT availability.scope_key,availability.cycle_key,cycle.cycle_id,availability.is_available,
      availability.version,availability.decision_source,availability.created_at,availability.updated_at
    FROM pairing_cycle_availability availability
    LEFT JOIN pairing_cycles cycle ON cycle.scope_key=availability.scope_key AND cycle.cycle_key=availability.cycle_key
    WHERE availability.user_id=? ORDER BY availability.created_at DESC LIMIT ?`,
    [id],DATA_EXPORT_SECTION_LIMITS.availability);
  markTruncated('availability',availabilityTruncated);
  const availability=Object.freeze(availabilityRows.map(row=>Object.freeze({
    scope_key:String(row.scope_key),
    cycle_key:String(row.cycle_key),
    cycle_id:row.cycle_id??null,
    is_available:Number(row.is_available)===1,
    version:Number(row.version),
    decision_source:String(row.decision_source),
    created_at:row.created_at??null,
    updated_at:row.updated_at??null,
  })));

  const {rows:primaryPairingRows,truncated:primaryPairingsTruncated}=await cappedQuery(db,
    `SELECT pairing.id AS pair_group_id,pairing.week_id,week.week_label,week.week_start,week.is_demo,
      pairing.is_ai_pair,pairing.topic,pairing.topic_kind,pairing.created_at,
      pairing.user_a_id,pairing.user_b_id,pairing.user_c_id,
      partner_a.display_name AS partner_a_display_name,partner_b.display_name AS partner_b_display_name,
      partner_c.display_name AS partner_c_display_name
    FROM pairing_groups pairing
    JOIN pairing_weeks week ON week.id=pairing.week_id
    LEFT JOIN auth_accounts partner_a ON partner_a.id=pairing.user_a_id
    LEFT JOIN auth_accounts partner_b ON partner_b.id=pairing.user_b_id
    LEFT JOIN auth_accounts partner_c ON partner_c.id=pairing.user_c_id
    WHERE pairing.user_a_id=? OR pairing.user_b_id=? OR pairing.user_c_id=?
    ORDER BY pairing.week_id DESC,pairing.id DESC LIMIT ?`,
    [id,id,id],DATA_EXPORT_SECTION_LIMITS.primaryPairings);
  markTruncated('pairings_primary',primaryPairingsTruncated);
  const primaryPairings=Object.freeze(primaryPairingRows.map(row=>Object.freeze({
    pair_group_id:Number(row.pair_group_id),
    week_id:Number(row.week_id),
    week_label:String(row.week_label),
    week_start:String(row.week_start),
    week_is_demo:Number(row.is_demo)===1,
    is_ai_pair:Number(row.is_ai_pair)===1,
    topic:row.topic??null,
    topic_kind:row.topic_kind??null,
    created_at:row.created_at??null,
    partners:Object.freeze(partnerNames([
      [row.user_a_id,row.partner_a_display_name],
      [row.user_b_id,row.partner_b_display_name],
      [row.user_c_id,row.partner_c_display_name],
    ],id)),
  })));

  const {rows:participationRows,truncated:participationsTruncated}=await cappedQuery(db,
    `SELECT week_id,position,source,created_at FROM pairing_participants
    WHERE user_id=? ORDER BY week_id DESC LIMIT ?`,[id],DATA_EXPORT_SECTION_LIMITS.participations);
  markTruncated('participations',participationsTruncated);
  const participations=Object.freeze(participationRows.map(row=>Object.freeze({
    week_id:Number(row.week_id),
    position:Number(row.position),
    source:String(row.source),
    created_at:row.created_at??null,
  })));

  const {rows:secondaryGroupRows,truncated:secondaryGroupsTruncated}=await cappedQuery(db,
    `SELECT grouping.id AS group_id,grouping.publication_id,grouping.circle_id,grouping.cycle_key,
      grouping.position,grouping.member_count,grouping.is_solo,grouping.created_at,
      grouping.user_a_id,grouping.user_b_id,
      partner_a.display_name AS partner_a_display_name,partner_b.display_name AS partner_b_display_name
    FROM circle_pairing_groups grouping
    LEFT JOIN auth_accounts partner_a ON partner_a.id=grouping.user_a_id
    LEFT JOIN auth_accounts partner_b ON partner_b.id=grouping.user_b_id
    WHERE grouping.user_a_id=? OR grouping.user_b_id=?
    ORDER BY grouping.id DESC LIMIT ?`,[id,id],DATA_EXPORT_SECTION_LIMITS.secondaryPairingGroups);
  markTruncated('pairings_secondary_groups',secondaryGroupsTruncated);
  const secondaryPairingGroups=Object.freeze(secondaryGroupRows.map(row=>Object.freeze({
    group_id:Number(row.group_id),
    publication_id:Number(row.publication_id),
    circle_id:Number(row.circle_id),
    cycle_key:String(row.cycle_key),
    position:Number(row.position),
    member_count:Number(row.member_count),
    is_solo:Number(row.is_solo)===1,
    created_at:row.created_at??null,
    partners:Object.freeze(partnerNames([
      [row.user_a_id,row.partner_a_display_name],
      [row.user_b_id,row.partner_b_display_name],
    ],id)),
  })));

  const {rows:eligibilityRows,truncated:eligibilityTruncated}=await cappedQuery(db,
    `SELECT publication_id,circle_id,cycle_key,is_available,availability_version,availability_source,
      position,group_position,group_size,member_position,created_at
    FROM circle_pairing_eligibility WHERE user_id=? ORDER BY created_at DESC LIMIT ?`,
    [id],DATA_EXPORT_SECTION_LIMITS.secondaryEligibility);
  markTruncated('pairings_secondary_eligibility',eligibilityTruncated);
  const secondaryEligibility=Object.freeze(eligibilityRows.map(row=>Object.freeze({
    publication_id:Number(row.publication_id),
    circle_id:Number(row.circle_id),
    cycle_key:String(row.cycle_key),
    is_available:Number(row.is_available)===1,
    availability_version:Number(row.availability_version),
    availability_source:String(row.availability_source),
    position:Number(row.position),
    group_position:row.group_position??null,
    group_size:row.group_size??null,
    member_position:row.member_position??null,
    created_at:row.created_at??null,
  })));

  const {rows:primaryScheduleRows,truncated:primarySchedulesTruncated}=await cappedQuery(db,
    `SELECT schedule.id AS schedule_id,schedule.week_id,schedule.pair_group_id,schedule.proposed_times,
      schedule.agreed_time,schedule.created_at,schedule.updated_at,week.week_label,
      pairing.user_a_id,pairing.user_b_id,pairing.user_c_id,
      partner_a.display_name AS partner_a_display_name,partner_b.display_name AS partner_b_display_name,
      partner_c.display_name AS partner_c_display_name
    FROM pair_schedules schedule
    JOIN pairing_groups pairing ON pairing.id=schedule.pair_group_id AND pairing.week_id=schedule.week_id
    JOIN pairing_weeks week ON week.id=schedule.week_id
    LEFT JOIN auth_accounts partner_a ON partner_a.id=pairing.user_a_id
    LEFT JOIN auth_accounts partner_b ON partner_b.id=pairing.user_b_id
    LEFT JOIN auth_accounts partner_c ON partner_c.id=pairing.user_c_id
    WHERE pairing.user_a_id=? OR pairing.user_b_id=? OR pairing.user_c_id=?
    ORDER BY schedule.week_id DESC,schedule.id DESC LIMIT ?`,
    [id,id,id],DATA_EXPORT_SECTION_LIMITS.primarySchedules);
  markTruncated('schedules_primary',primarySchedulesTruncated);
  const primarySchedules=Object.freeze(primaryScheduleRows.map(row=>Object.freeze({
    schedule_id:Number(row.schedule_id),
    week_id:Number(row.week_id),
    week_label:String(row.week_label),
    pair_group_id:Number(row.pair_group_id),
    partners:Object.freeze(partnerNames([
      [row.user_a_id,row.partner_a_display_name],
      [row.user_b_id,row.partner_b_display_name],
      [row.user_c_id,row.partner_c_display_name],
    ],id)),
    proposed_times:projectProposedTimes(row.proposed_times,id),
    agreed_time:row.agreed_time??null,
    created_at:row.created_at??null,
    updated_at:row.updated_at??null,
  })));

  const {rows:secondaryScheduleRows,truncated:secondarySchedulesTruncated}=await cappedQuery(db,
    `SELECT schedule.id AS schedule_id,schedule.publication_id,schedule.circle_id,schedule.cycle_key,
      schedule.group_id,schedule.revision,schedule.agreed_time,schedule.created_at,schedule.updated_at,
      schedule.user_a_id,schedule.user_b_id,
      partner_a.display_name AS partner_a_display_name,partner_b.display_name AS partner_b_display_name
    FROM circle_pair_schedules schedule
    LEFT JOIN auth_accounts partner_a ON partner_a.id=schedule.user_a_id
    LEFT JOIN auth_accounts partner_b ON partner_b.id=schedule.user_b_id
    WHERE schedule.user_a_id=? OR schedule.user_b_id=?
    ORDER BY schedule.id DESC LIMIT ?`,[id,id],DATA_EXPORT_SECTION_LIMITS.secondarySchedules);
  markTruncated('schedules_secondary',secondarySchedulesTruncated);
  const secondarySchedules=Object.freeze(secondaryScheduleRows.map(row=>Object.freeze({
    schedule_id:Number(row.schedule_id),
    publication_id:Number(row.publication_id),
    circle_id:Number(row.circle_id),
    cycle_key:String(row.cycle_key),
    group_id:Number(row.group_id),
    revision:Number(row.revision),
    agreed_time:row.agreed_time??null,
    created_at:row.created_at??null,
    updated_at:row.updated_at??null,
    partners:Object.freeze(partnerNames([
      [row.user_a_id,row.partner_a_display_name],
      [row.user_b_id,row.partner_b_display_name],
    ],id)),
  })));

  const {rows:proposalRows,truncated:proposalsTruncated}=await cappedQuery(db,
    `SELECT proposal.id AS proposal_id,proposal.schedule_id,proposal.group_id,proposal.instant,
      proposal.created_at,proposal.user_a_id,proposal.user_b_id,
      partner_a.display_name AS partner_a_display_name,partner_b.display_name AS partner_b_display_name,
      proposer.display_name AS proposed_by_display_name
    FROM circle_pair_schedule_proposals proposal
    LEFT JOIN auth_accounts partner_a ON partner_a.id=proposal.user_a_id
    LEFT JOIN auth_accounts partner_b ON partner_b.id=proposal.user_b_id
    LEFT JOIN auth_accounts proposer ON proposer.id=proposal.proposed_by
    WHERE proposal.user_a_id=? OR proposal.user_b_id=?
    ORDER BY proposal.id DESC LIMIT ?`,[id,id],DATA_EXPORT_SECTION_LIMITS.scheduleProposals);
  markTruncated('schedule_proposals',proposalsTruncated);
  const scheduleProposals=Object.freeze(proposalRows.map(row=>Object.freeze({
    proposal_id:Number(row.proposal_id),
    schedule_id:Number(row.schedule_id),
    group_id:Number(row.group_id),
    instant:String(row.instant),
    created_at:row.created_at??null,
    partners:Object.freeze(partnerNames([
      [row.user_a_id,row.partner_a_display_name],
      [row.user_b_id,row.partner_b_display_name],
    ],id)),
    proposed_by:displayName(row.proposed_by_display_name),
  })));

  const {rows:meetingLinkRows,truncated:meetingLinksTruncated}=await cappedQuery(db,
    `SELECT link.week_id,link.pair_group_id,link.accepted_schedule_at,link.meeting_url,link.revision,
      link.created_at,link.updated_at,
      link.pair_user_a_id,link.pair_user_b_id,link.pair_user_c_id,
      partner_a.display_name AS partner_a_display_name,partner_b.display_name AS partner_b_display_name,
      partner_c.display_name AS partner_c_display_name,updater.display_name AS updated_by_display_name
    FROM pair_meeting_links link
    LEFT JOIN auth_accounts partner_a ON partner_a.id=link.pair_user_a_id
    LEFT JOIN auth_accounts partner_b ON partner_b.id=link.pair_user_b_id
    LEFT JOIN auth_accounts partner_c ON partner_c.id=link.pair_user_c_id
    LEFT JOIN auth_accounts updater ON updater.id=link.updated_by
    WHERE link.pair_user_a_id=? OR link.pair_user_b_id=? OR link.pair_user_c_id=?
    ORDER BY link.week_id DESC,link.pair_group_id DESC LIMIT ?`,
    [id,id,id],DATA_EXPORT_SECTION_LIMITS.meetingLinks);
  markTruncated('meeting_links',meetingLinksTruncated);
  const meetingLinks=Object.freeze(meetingLinkRows.map(row=>Object.freeze({
    week_id:Number(row.week_id),
    pair_group_id:Number(row.pair_group_id),
    partners:Object.freeze(partnerNames([
      [row.pair_user_a_id,row.partner_a_display_name],
      [row.pair_user_b_id,row.partner_b_display_name],
      [row.pair_user_c_id,row.partner_c_display_name],
    ],id)),
    accepted_schedule_at:String(row.accepted_schedule_at),
    meeting_url:row.meeting_url??null,
    revision:Number(row.revision),
    updated_by:displayName(row.updated_by_display_name),
    created_at:row.created_at??null,
    updated_at:row.updated_at??null,
  })));

  const {rows:completionRows,truncated:completionsTruncated}=await cappedQuery(db,
    `SELECT receipt.week_id,receipt.pair_group_id,receipt.participant_source,receipt.confirmed_at,
      receipt.pair_user_a_id,receipt.pair_user_b_id,receipt.pair_user_c_id,
      partner_a.display_name AS partner_a_display_name,partner_b.display_name AS partner_b_display_name,
      partner_c.display_name AS partner_c_display_name
    FROM session_completion_receipts receipt
    LEFT JOIN auth_accounts partner_a ON partner_a.id=receipt.pair_user_a_id
    LEFT JOIN auth_accounts partner_b ON partner_b.id=receipt.pair_user_b_id
    LEFT JOIN auth_accounts partner_c ON partner_c.id=receipt.pair_user_c_id
    WHERE receipt.user_id=? ORDER BY receipt.week_id DESC,receipt.pair_group_id DESC LIMIT ?`,
    [id],DATA_EXPORT_SECTION_LIMITS.sessionCompletions);
  markTruncated('session_completions',completionsTruncated);
  const sessionCompletions=Object.freeze(completionRows.map(row=>Object.freeze({
    week_id:Number(row.week_id),
    pair_group_id:Number(row.pair_group_id),
    participant_source:String(row.participant_source),
    confirmed_at:String(row.confirmed_at),
    partners:Object.freeze(partnerNames([
      [row.pair_user_a_id,row.partner_a_display_name],
      [row.pair_user_b_id,row.partner_b_display_name],
      [row.pair_user_c_id,row.partner_c_display_name],
    ],id)),
  })));

  const {rows:controlRows,truncated:controlsTruncated}=await cappedQuery(db,
    `SELECT control.week_id,control.pair_group_id,control.timer_state,control.remaining_ms,
      control.anchor_at,control.revision,control.created_at,control.updated_at,
      control.pair_user_a_id,control.pair_user_b_id,control.pair_user_c_id,
      partner_a.display_name AS partner_a_display_name,partner_b.display_name AS partner_b_display_name,
      partner_c.display_name AS partner_c_display_name,
      candidate.display_name AS candidate_display_name,updater.display_name AS updated_by_display_name
    FROM pair_session_controls control
    LEFT JOIN auth_accounts partner_a ON partner_a.id=control.pair_user_a_id
    LEFT JOIN auth_accounts partner_b ON partner_b.id=control.pair_user_b_id
    LEFT JOIN auth_accounts partner_c ON partner_c.id=control.pair_user_c_id
    LEFT JOIN auth_accounts candidate ON candidate.id=control.candidate_user_id
    LEFT JOIN auth_accounts updater ON updater.id=control.updated_by
    WHERE control.pair_user_a_id=? OR control.pair_user_b_id=? OR control.pair_user_c_id=?
    ORDER BY control.week_id DESC,control.pair_group_id DESC LIMIT ?`,
    [id,id,id],DATA_EXPORT_SECTION_LIMITS.sessionControls);
  markTruncated('session_controls',controlsTruncated);
  const sessionControls=Object.freeze(controlRows.map(row=>Object.freeze({
    week_id:Number(row.week_id),
    pair_group_id:Number(row.pair_group_id),
    partners:Object.freeze(partnerNames([
      [row.pair_user_a_id,row.partner_a_display_name],
      [row.pair_user_b_id,row.partner_b_display_name],
      [row.pair_user_c_id,row.partner_c_display_name],
    ],id)),
    candidate:displayName(row.candidate_display_name),
    timer_state:String(row.timer_state),
    remaining_ms:Number(row.remaining_ms),
    anchor_at:row.anchor_at??null,
    revision:Number(row.revision),
    updated_by:displayName(row.updated_by_display_name),
    created_at:row.created_at??null,
    updated_at:row.updated_at??null,
  })));

  const {rows:messageRows,truncated:messagesTruncated}=await cappedQuery(db,
    `SELECT message.id AS message_id,message.week_id,message.pair_group_id,message.message,message.created_at,
      pairing.user_a_id,pairing.user_b_id,pairing.user_c_id,
      partner_a.display_name AS partner_a_display_name,partner_b.display_name AS partner_b_display_name,
      partner_c.display_name AS partner_c_display_name
    FROM pair_messages message
    JOIN pairing_groups pairing ON pairing.id=message.pair_group_id AND pairing.week_id=message.week_id
    LEFT JOIN auth_accounts partner_a ON partner_a.id=pairing.user_a_id
    LEFT JOIN auth_accounts partner_b ON partner_b.id=pairing.user_b_id
    LEFT JOIN auth_accounts partner_c ON partner_c.id=pairing.user_c_id
    WHERE message.sender_id=? ORDER BY message.id DESC LIMIT ?`,
    [id],DATA_EXPORT_SECTION_LIMITS.messages);
  markTruncated('messages',messagesTruncated);
  const messages=Object.freeze(messageRows.map(row=>Object.freeze({
    message_id:Number(row.message_id),
    week_id:Number(row.week_id),
    pair_group_id:Number(row.pair_group_id),
    partners:Object.freeze(partnerNames([
      [row.user_a_id,row.partner_a_display_name],
      [row.user_b_id,row.partner_b_display_name],
      [row.user_c_id,row.partner_c_display_name],
    ],id)),
    message:String(row.message),
    created_at:row.created_at??null,
  })));

  const {rows:runRows,truncated:codeRunsTruncated}=await cappedQuery(db,
    `SELECT run.id AS run_id,run.week_id,run.pair_group_id,run.question_id,run.question_slug,run.language,
      run.code,run.test_cases_snapshot,run.results_json,run.passed_count,run.total_count,run.duration_ms,
      run.created_at,pairing.user_a_id,pairing.user_b_id,pairing.user_c_id,
      partner_a.display_name AS partner_a_display_name,partner_b.display_name AS partner_b_display_name,
      partner_c.display_name AS partner_c_display_name
    FROM session_runs run
    LEFT JOIN pairing_groups pairing ON pairing.id=run.pair_group_id AND pairing.week_id=run.week_id
    LEFT JOIN auth_accounts partner_a ON partner_a.id=pairing.user_a_id
    LEFT JOIN auth_accounts partner_b ON partner_b.id=pairing.user_b_id
    LEFT JOIN auth_accounts partner_c ON partner_c.id=pairing.user_c_id
    WHERE run.user_id=? ORDER BY run.id DESC LIMIT ?`,[id],DATA_EXPORT_SECTION_LIMITS.codeRuns);
  markTruncated('code_runs',codeRunsTruncated);
  const codeRuns=Object.freeze(runRows.map(row=>Object.freeze({
    run_id:Number(row.run_id),
    week_id:row.week_id??null,
    pair_group_id:row.pair_group_id??null,
    partners:row.pair_group_id==null?Object.freeze([]):Object.freeze(partnerNames([
      [row.user_a_id,row.partner_a_display_name],
      [row.user_b_id,row.partner_b_display_name],
      [row.user_c_id,row.partner_c_display_name],
    ],id)),
    question_id:row.question_id??null,
    question_slug:row.question_slug??null,
    language:row.language??null,
    code:String(row.code),
    test_cases_snapshot:parsedJson(row.test_cases_snapshot),
    results_json:parsedJson(row.results_json),
    passed_count:Number(row.passed_count),
    total_count:Number(row.total_count),
    duration_ms:row.duration_ms??null,
    created_at:row.created_at??null,
  })));

  const prefRows=await query(db,
    `SELECT email_enabled,sms_enabled,phone,email,updated_at FROM user_notification_prefs WHERE user_id=? LIMIT 2`,[id]);
  const notificationPreferences=prefRows.length===1?Object.freeze({
    email_enabled:Number(prefRows[0].email_enabled)===1,
    sms_enabled:Number(prefRows[0].sms_enabled)===1,
    phone:prefRows[0].phone??null,
    email:prefRows[0].email??null,
    updated_at:prefRows[0].updated_at??null,
  }):null;

  const {rows:questionRows,truncated:questionsTruncated}=await cappedQuery(db,
    `SELECT id,slug,title,type,difficulty,category,description,input_format,constraints_text,examples,
      test_cases,starter_per_lang,source,leetcode_slug,created_at FROM custom_questions
    WHERE author_id=? ORDER BY id DESC LIMIT ?`,[id],DATA_EXPORT_SECTION_LIMITS.customQuestions);
  markTruncated('custom_questions',questionsTruncated);
  const customQuestions=Object.freeze(questionRows.map(row=>Object.freeze({
    question_id:Number(row.id),
    slug:String(row.slug),
    title:String(row.title),
    type:row.type??null,
    difficulty:row.difficulty??null,
    category:row.category??null,
    description:String(row.description),
    input_format:row.input_format??null,
    constraints_text:row.constraints_text??null,
    examples:row.examples??null,
    test_cases:String(row.test_cases),
    starter_per_lang:row.starter_per_lang??null,
    source:row.source??null,
    leetcode_slug:row.leetcode_slug??null,
    created_at:row.created_at??null,
  })));

  const {rows:sentRows,truncated:sentTruncated}=await cappedQuery(db,
    `SELECT invitation.id AS invitation_id,invitation.circle_id,circle.public_id,circle.name,
      invitation.created_at,invitation.expires_at,invitation.used_at,invitation.revoked_at,
      used.display_name AS used_by_display_name
    FROM circle_invitations invitation
    JOIN circles circle ON circle.id=invitation.circle_id
    LEFT JOIN auth_accounts used ON used.id=invitation.used_by
    WHERE invitation.created_by=? ORDER BY invitation.created_at DESC LIMIT ?`,
    [id],DATA_EXPORT_SECTION_LIMITS.invitationsSent);
  markTruncated('invitations_sent',sentTruncated);
  const invitationsSent=Object.freeze(sentRows.map(row=>Object.freeze({
    invitation_id:String(row.invitation_id),
    circle_id:Number(row.circle_id),
    circle_public_id:String(row.public_id),
    circle_name:String(row.name),
    created_at:String(row.created_at),
    expires_at:String(row.expires_at),
    used_at:row.used_at??null,
    revoked_at:row.revoked_at??null,
    used_by:displayName(row.used_by_display_name),
  })));

  const {rows:acceptedRows,truncated:acceptedTruncated}=await cappedQuery(db,
    `SELECT invitation.id AS invitation_id,invitation.circle_id,circle.public_id,circle.name,
      invitation.created_at,invitation.expires_at,invitation.used_at,invitation.revoked_at,
      creator.display_name AS created_by_display_name
    FROM circle_invitations invitation
    JOIN circles circle ON circle.id=invitation.circle_id
    LEFT JOIN auth_accounts creator ON creator.id=invitation.created_by
    WHERE invitation.used_by=? ORDER BY invitation.created_at DESC LIMIT ?`,
    [id],DATA_EXPORT_SECTION_LIMITS.invitationsAccepted);
  markTruncated('invitations_accepted',acceptedTruncated);
  const invitationsAccepted=Object.freeze(acceptedRows.map(row=>Object.freeze({
    invitation_id:String(row.invitation_id),
    circle_id:Number(row.circle_id),
    circle_public_id:String(row.public_id),
    circle_name:String(row.name),
    created_at:String(row.created_at),
    expires_at:String(row.expires_at),
    used_at:row.used_at??null,
    revoked_at:row.revoked_at??null,
    created_by:displayName(row.created_by_display_name),
  })));

  // Pending invitations addressed to this member: circle_invitations
  // stores only the email hash, so match it with the same
  // hashInvitationEmail the invitation flow uses. Used, revoked and
  // already-accepted invitations are not "pending" — an accepted one is
  // in `accepted` above. No token or email hash is exported.
  const receivedEmailHash=hashInvitationEmail(email);
  const {rows:receivedRows,truncated:receivedTruncated}=receivedEmailHash
    ?await cappedQuery(db,
      `SELECT invitation.id AS invitation_id,invitation.circle_id,circle.public_id,circle.name,
        invitation.created_at,invitation.expires_at,
        creator.display_name AS created_by_display_name
      FROM circle_invitations invitation
      JOIN circles circle ON circle.id=invitation.circle_id
      LEFT JOIN auth_accounts creator ON creator.id=invitation.created_by
      WHERE invitation.email_hash=? AND invitation.used_at IS NULL
        AND invitation.used_by IS NULL AND invitation.revoked_at IS NULL
      ORDER BY invitation.created_at DESC LIMIT ?`,
      [receivedEmailHash],DATA_EXPORT_SECTION_LIMITS.invitationsReceived)
    :{rows:[],truncated:false};
  markTruncated('invitations_received',receivedTruncated);
  const invitationsReceived=Object.freeze(receivedRows.map(row=>Object.freeze({
    invitation_id:String(row.invitation_id),
    circle_id:Number(row.circle_id),
    circle_public_id:String(row.public_id),
    circle_name:String(row.name),
    created_at:String(row.created_at),
    expires_at:String(row.expires_at),
    created_by:displayName(row.created_by_display_name),
    status:'pending',
  })));

  // Circles the member created but holds no membership for: they are
  // the member's own creation record, and they would otherwise be
  // invisible (memberships only covers circles they belong to). Circles
  // they belong to stay in `memberships` only, never duplicated here.
  const {rows:createdCircleRows,truncated:createdCirclesTruncated}=await cappedQuery(db,
    `SELECT circle.id AS circle_id,circle.public_id,circle.name,circle.is_primary,
      circle.archived_at,circle.created_at
    FROM circles circle
    WHERE circle.created_by=? AND NOT EXISTS (
      SELECT 1 FROM circle_memberships membership
      WHERE membership.circle_id=circle.id AND membership.user_id=?)
    ORDER BY circle.id LIMIT ?`,
    [id,id],DATA_EXPORT_SECTION_LIMITS.createdCircles);
  markTruncated('created_circles',createdCirclesTruncated);
  const createdCircles=Object.freeze(createdCircleRows.map(row=>Object.freeze({
    circle_id:Number(row.circle_id),
    circle_public_id:String(row.public_id),
    circle_name:String(row.name),
    circle_is_primary:Number(row.is_primary)===1,
    circle_archived_at:row.archived_at??null,
    created_at:row.created_at??null,
  })));

  const {rows:requestRows,truncated:requestTruncated}=await cappedQuery(db,
    `SELECT request.id AS request_id,request.circle_id,circle.name AS circle_name,request.email,
      request.name,request.note,request.status,request.created_at,request.expires_at,request.decided_at,
      request.invitation_id,decider.display_name AS decided_by_display_name
    FROM invite_requests request
    JOIN circles circle ON circle.id=request.circle_id
    LEFT JOIN auth_accounts decider ON decider.id=request.decided_by
    WHERE request.email=? ORDER BY request.created_at DESC LIMIT ?`,
    [email],DATA_EXPORT_SECTION_LIMITS.inviteRequests);
  markTruncated('invite_requests',requestTruncated);
  const inviteRequests=Object.freeze(requestRows.map(row=>Object.freeze({
    request_id:String(row.request_id),
    circle_id:Number(row.circle_id),
    circle_name:String(row.circle_name),
    email:String(row.email),
    name:row.name??null,
    note:row.note??null,
    status:String(row.status),
    created_at:Number(row.created_at),
    expires_at:Number(row.expires_at),
    decided_at:row.decided_at??null,
    decided_by:displayName(row.decided_by_display_name),
    invitation_id:row.invitation_id??null,
  })));

  const {rows:aiSessionRows,truncated:aiSessionsTruncated}=await cappedQuery(db,
    `SELECT id,room_id,pair_label,transcript,code_snapshots,interviewer_questions,started_at,ended_at,
      duration_sec,cost_cents,created_at FROM ai_sessions WHERE created_by=?
    ORDER BY id DESC LIMIT ?`,[id],DATA_EXPORT_SECTION_LIMITS.aiSessions);
  markTruncated('ai_sessions',aiSessionsTruncated);
  const aiSessions=Object.freeze(aiSessionRows.map(row=>Object.freeze({
    session_id:Number(row.id),
    room_id:row.room_id??null,
    pair_label:row.pair_label??null,
    transcript:row.transcript??null,
    code_snapshots:row.code_snapshots??null,
    interviewer_questions:row.interviewer_questions??null,
    started_at:row.started_at??null,
    ended_at:row.ended_at??null,
    duration_sec:row.duration_sec??null,
    cost_cents:Number(row.cost_cents),
    created_at:row.created_at??null,
  })));

  const {rows:aiFeedbackRows,truncated:aiFeedbackTruncated}=await cappedQuery(db,
    `SELECT feedback.id AS feedback_id,feedback.session_id,feedback.role,feedback.feedback_json,
      feedback.evidence,feedback.model_used,feedback.reason_for_pick,feedback.estimated_cost_cents,
      feedback.confidence,feedback.created_at
    FROM ai_feedback feedback JOIN ai_sessions session ON session.id=feedback.session_id
    WHERE session.created_by=? ORDER BY feedback.id DESC LIMIT ?`,
    [id],DATA_EXPORT_SECTION_LIMITS.aiFeedback);
  markTruncated('ai_feedback',aiFeedbackTruncated);
  const aiFeedback=Object.freeze(aiFeedbackRows.map(row=>Object.freeze({
    feedback_id:Number(row.feedback_id),
    session_id:Number(row.session_id),
    role:row.role??null,
    feedback_json:parsedJson(row.feedback_json),
    evidence:row.evidence??null,
    model_used:row.model_used??null,
    reason_for_pick:row.reason_for_pick??null,
    estimated_cost_cents:row.estimated_cost_cents??null,
    confidence:row.confidence??null,
    created_at:row.created_at??null,
  })));

  const aiConsentRows=await query(db,
    `SELECT consented_at,revoked_at,policy_version FROM ai_consents WHERE user_id=? LIMIT 2`,[id]);
  const aiConsents=aiConsentRows.length===1?Object.freeze({
    consented_at:String(aiConsentRows[0].consented_at),
    revoked_at:aiConsentRows[0].revoked_at??null,
    policy_version:String(aiConsentRows[0].policy_version),
  }):null;

  const {rows:aiUsageRows,truncated:aiUsageTruncated}=await cappedQuery(db,
    `SELECT month,calls,tokens_in,updated_at FROM ai_account_monthly_usage WHERE user_id=?
    ORDER BY month DESC LIMIT ?`,[id],DATA_EXPORT_SECTION_LIMITS.aiUsage);
  markTruncated('ai_usage',aiUsageTruncated);
  const aiUsage=Object.freeze(aiUsageRows.map(row=>Object.freeze({
    month:String(row.month),
    calls:Number(row.calls),
    tokens_in:Number(row.tokens_in),
    updated_at:row.updated_at??null,
  })));

  const {rows:aiReservationRows,truncated:aiReservationsTruncated}=await cappedQuery(db,
    `SELECT reservation_id,month,tokens_in,session_id,refunded_at,created_at
    FROM ai_account_monthly_reservations WHERE user_id=? ORDER BY created_at DESC LIMIT ?`,
    [id],DATA_EXPORT_SECTION_LIMITS.aiReservations);
  markTruncated('ai_reservations',aiReservationsTruncated);
  const aiReservations=Object.freeze(aiReservationRows.map(row=>Object.freeze({
    reservation_id:String(row.reservation_id),
    month:String(row.month),
    tokens_in:Number(row.tokens_in),
    session_id:row.session_id??null,
    refunded_at:row.refunded_at??null,
    created_at:row.created_at??null,
  })));

  const feedback=await readFeedback(db,id);
  markTruncated('feedback_items',feedback.truncated_items);
  markTruncated('feedback_votes',feedback.truncated_votes);

  const archive=Object.freeze({
    version:DATA_EXPORT_VERSION,
    format:DATA_EXPORT_FORMAT,
    exported_at:new Date().toISOString(),
    account:Object.freeze({id:profile.id,email:profile.email,display_name:profile.display_name}),
    profile,
    memberships,
    availability,
    pairings:Object.freeze({primary:primaryPairings,participations,
      secondary_groups:secondaryPairingGroups,secondary_eligibility:secondaryEligibility}),
    schedules:Object.freeze({primary:primarySchedules,secondary:secondarySchedules,
      proposals:scheduleProposals,meeting_links:meetingLinks}),
    session_completions:sessionCompletions,
    session_controls:sessionControls,
    messages,
    code_runs:codeRuns,
    notification_preferences:notificationPreferences,
    custom_questions:customQuestions,
    invitations:Object.freeze({sent:invitationsSent,accepted:invitationsAccepted,received:invitationsReceived}),
    created_circles:createdCircles,
    invite_requests:inviteRequests,
    ai:Object.freeze({sessions:aiSessions,feedback:aiFeedback,consents:aiConsents,
      usage:aiUsage,reservations:aiReservations}),
    feedback,
    excluded_tables:DATA_EXPORT_EXCLUDED_TABLES,
    // Sections whose rows were capped: `counts` holds the exported rows,
    // and this list names every section where rows beyond the cap exist
    // but are not in the archive. Empty when nothing was capped.
    truncated_sections:Object.freeze([...truncatedSections]),
    counts:Object.freeze({
      memberships:memberships.length,
      availability:availability.length,
      pairings_primary:primaryPairings.length,
      participations:participations.length,
      pairings_secondary_groups:secondaryPairingGroups.length,
      pairings_secondary_eligibility:secondaryEligibility.length,
      schedules_primary:primarySchedules.length,
      schedules_secondary:secondarySchedules.length,
      schedule_proposals:scheduleProposals.length,
      meeting_links:meetingLinks.length,
      session_completions:sessionCompletions.length,
      session_controls:sessionControls.length,
      messages:messages.length,
      code_runs:codeRuns.length,
      custom_questions:customQuestions.length,
      invitations_sent:invitationsSent.length,
      invitations_accepted:invitationsAccepted.length,
      invitations_received:invitationsReceived.length,
      created_circles:createdCircles.length,
      invite_requests:inviteRequests.length,
      ai_sessions:aiSessions.length,
      ai_feedback:aiFeedback.length,
      ai_usage:aiUsage.length,
      ai_reservations:aiReservations.length,
      feedback_items:feedback.items.length,
      feedback_votes:feedback.votes.length,
    }),
  });

  const bytes=Buffer.byteLength(JSON.stringify(archive),'utf8');
  if(bytes>DATA_EXPORT_MAX_BYTES) throw new DataExportTooLargeError();
  return archive;
}
