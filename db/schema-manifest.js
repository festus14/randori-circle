import { createHash } from 'node:crypto';

export const SCHEMA_MANIFEST_VERSION=1;

function table(name,sql){
  return Object.freeze({operation:'ensure-table',name,sql});
}

function index(name,tableName,keyParts,{unique=false,where=null}={}){
  const uniqueSql=unique?'UNIQUE ':'';
  const whereSql=where?` WHERE ${where}`:'';
  return Object.freeze({
    operation:'ensure-index',
    name,
    table:tableName,
    keyParts:Object.freeze([...keyParts]),
    unique,
    where,
    sql:`CREATE ${uniqueSql}INDEX IF NOT EXISTS ${name} ON ${tableName}(${keyParts.join(',')})${whereSql}`,
  });
}

const DECLARED_TABLE_OPERATIONS=Object.freeze([
  table('users',`CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, color TEXT NOT NULL, created_at TEXT DEFAULT (datetime('now')))`),
  table('auth_accounts',`CREATE TABLE IF NOT EXISTS auth_accounts (id INTEGER PRIMARY KEY AUTOINCREMENT, email TEXT UNIQUE NOT NULL, password_hash TEXT NOT NULL, display_name TEXT NOT NULL, color TEXT NOT NULL, created_at TEXT DEFAULT (datetime('now')), last_login TEXT, is_available INTEGER DEFAULT 1, availability_updated_at TEXT, is_admin INTEGER DEFAULT 0, is_demo INTEGER DEFAULT 0, bio TEXT, tz TEXT, interview_focus TEXT DEFAULT 'both', leetcode_handle TEXT, phone TEXT, google_sub TEXT)`),
  table('pairing_weeks',`CREATE TABLE IF NOT EXISTS pairing_weeks (id INTEGER PRIMARY KEY AUTOINCREMENT, week_label TEXT NOT NULL, week_start TEXT NOT NULL, focus TEXT NOT NULL DEFAULT 'both', created_at TEXT DEFAULT (datetime('now')), is_demo INTEGER DEFAULT 0)`),
  table('pairing_groups',`CREATE TABLE IF NOT EXISTS pairing_groups (id INTEGER PRIMARY KEY AUTOINCREMENT, week_id INTEGER NOT NULL REFERENCES pairing_weeks(id) ON DELETE CASCADE, user_a_id INTEGER NOT NULL, user_b_id INTEGER NOT NULL, user_c_id INTEGER, is_ai_pair INTEGER DEFAULT 0, topic TEXT DEFAULT 'Pick together', topic_kind TEXT DEFAULT 'both', created_at TEXT DEFAULT (datetime('now')))`),
  table('pairing_participants',`CREATE TABLE IF NOT EXISTS pairing_participants (week_id INTEGER NOT NULL, user_id INTEGER NOT NULL, position INTEGER NOT NULL, source TEXT NOT NULL DEFAULT 'auth', created_at TEXT DEFAULT (datetime('now')), PRIMARY KEY (week_id,user_id))`),
  table('pairing_week_runs',`CREATE TABLE IF NOT EXISTS pairing_week_runs (week_label TEXT PRIMARY KEY, week_id INTEGER, generation_token TEXT NOT NULL, generation INTEGER NOT NULL DEFAULT 1, algorithm_version TEXT NOT NULL, algorithm_seed TEXT NOT NULL, participant_count INTEGER NOT NULL, participants_json TEXT NOT NULL, created_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now')))`),
  table('pairing_email_outbox',`CREATE TABLE IF NOT EXISTS pairing_email_outbox (id INTEGER PRIMARY KEY AUTOINCREMENT, week_id INTEGER NOT NULL, user_id INTEGER NOT NULL, kind TEXT NOT NULL, recipient_email TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending', attempt_count INTEGER NOT NULL DEFAULT 0, claimed_at TEXT, sent_at TEXT, provider_message_id TEXT, last_error TEXT, created_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now')), UNIQUE (week_id,user_id,kind))`),
  table('questions',`CREATE TABLE IF NOT EXISTS questions (id INTEGER PRIMARY KEY AUTOINCREMENT, slug TEXT UNIQUE NOT NULL, title TEXT NOT NULL, type TEXT NOT NULL, difficulty TEXT NOT NULL, category TEXT NOT NULL, description TEXT NOT NULL)`),
  table('custom_questions',`CREATE TABLE IF NOT EXISTS custom_questions (id INTEGER PRIMARY KEY AUTOINCREMENT, slug TEXT UNIQUE NOT NULL, title TEXT NOT NULL, type TEXT DEFAULT 'dsa', difficulty TEXT DEFAULT 'Medium', category TEXT DEFAULT 'custom', description TEXT NOT NULL, input_format TEXT, constraints_text TEXT, examples TEXT, test_cases TEXT NOT NULL, starter_per_lang TEXT, author_id INTEGER, source TEXT DEFAULT 'custom', leetcode_slug TEXT, created_at TEXT DEFAULT (datetime('now')))`),
  table('video_signals',`CREATE TABLE IF NOT EXISTS video_signals (id INTEGER PRIMARY KEY AUTOINCREMENT, room_id TEXT NOT NULL, from_id TEXT NOT NULL, to_id TEXT, type TEXT NOT NULL, payload TEXT NOT NULL, created_at TEXT DEFAULT (datetime('now')))`),
  table('pair_room_snapshots',`CREATE TABLE IF NOT EXISTS pair_room_snapshots (room_id TEXT PRIMARY KEY, week_id INTEGER NOT NULL, pair_group_id INTEGER NOT NULL, revision INTEGER NOT NULL, schema_version INTEGER NOT NULL, client_id TEXT NOT NULL, client_seq INTEGER NOT NULL, language TEXT NOT NULL, question_id TEXT NOT NULL, code TEXT NOT NULL, updated_by INTEGER NOT NULL, created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now')), UNIQUE(week_id,pair_group_id), FOREIGN KEY(pair_group_id) REFERENCES pairing_groups(id) ON DELETE CASCADE)`),
  table('pair_messages',`CREATE TABLE IF NOT EXISTS pair_messages (id INTEGER PRIMARY KEY AUTOINCREMENT, week_id INTEGER NOT NULL, pair_group_id INTEGER NOT NULL, sender_id INTEGER NOT NULL, message TEXT NOT NULL, created_at TEXT DEFAULT (datetime('now')))`),
  table('pair_schedules',`CREATE TABLE IF NOT EXISTS pair_schedules (id INTEGER PRIMARY KEY AUTOINCREMENT, week_id INTEGER NOT NULL, pair_group_id INTEGER NOT NULL, proposed_times TEXT, agreed_time TEXT, created_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now')), UNIQUE(week_id,pair_group_id))`),
  table('session_runs',`CREATE TABLE IF NOT EXISTS session_runs (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER, week_id INTEGER, pair_group_id INTEGER, question_id INTEGER, question_slug TEXT, language TEXT, code TEXT NOT NULL, test_cases_snapshot TEXT, results_json TEXT, passed_count INTEGER DEFAULT 0, total_count INTEGER DEFAULT 0, duration_ms INTEGER, created_at TEXT DEFAULT (datetime('now')))`),
  table('ai_sessions',`CREATE TABLE IF NOT EXISTS ai_sessions (id INTEGER PRIMARY KEY AUTOINCREMENT, room_id TEXT, pair_label TEXT, transcript TEXT, code_snapshots TEXT, interviewer_questions TEXT, started_at TEXT DEFAULT (datetime('now')), ended_at TEXT, duration_sec INTEGER, cost_cents INTEGER DEFAULT 0, created_at TEXT DEFAULT (datetime('now')), created_by INTEGER)`),
  table('ai_feedback',`CREATE TABLE IF NOT EXISTS ai_feedback (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id INTEGER NOT NULL REFERENCES ai_sessions(id) ON DELETE CASCADE, role TEXT DEFAULT 'both', feedback_json TEXT NOT NULL, evidence TEXT, model_used TEXT, reason_for_pick TEXT, estimated_cost_cents INTEGER, confidence REAL DEFAULT 0.85, created_at TEXT DEFAULT (datetime('now')))`),
  table('ai_usage',`CREATE TABLE IF NOT EXISTS ai_usage (date TEXT PRIMARY KEY, calls INTEGER DEFAULT 0, tokens_in INTEGER DEFAULT 0, tokens_out INTEGER DEFAULT 0, updated_at TEXT DEFAULT (datetime('now')))`),
  table('ai_account_monthly_usage',`CREATE TABLE IF NOT EXISTS ai_account_monthly_usage (month TEXT NOT NULL CHECK(length(month)=7 AND month GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]'), user_id INTEGER NOT NULL CHECK(user_id>0), calls INTEGER NOT NULL DEFAULT 0 CHECK(calls>=0), tokens_in INTEGER NOT NULL DEFAULT 0 CHECK(tokens_in>=0), updated_at TEXT NOT NULL DEFAULT (datetime('now')), PRIMARY KEY(month,user_id))`),
  table('ai_account_monthly_reservations',`CREATE TABLE IF NOT EXISTS ai_account_monthly_reservations (reservation_id TEXT PRIMARY KEY, month TEXT NOT NULL, user_id INTEGER NOT NULL CHECK(user_id>0), tokens_in INTEGER NOT NULL DEFAULT 0 CHECK(tokens_in>=0), session_id INTEGER UNIQUE, refunded_at TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')))`),
  table('ai_consents',`CREATE TABLE IF NOT EXISTS ai_consents (user_id INTEGER PRIMARY KEY, consented_at TEXT NOT NULL DEFAULT (datetime('now')), revoked_at TEXT, policy_version TEXT NOT NULL)`),
  table('app_logs',`CREATE TABLE IF NOT EXISTS app_logs (id INTEGER PRIMARY KEY AUTOINCREMENT, level TEXT NOT NULL, source TEXT NOT NULL, event TEXT, message TEXT NOT NULL, meta_json TEXT, user_id INTEGER, route TEXT, ua TEXT, ip TEXT, created_at TEXT DEFAULT (datetime('now')))`),
  table('user_notification_prefs',`CREATE TABLE IF NOT EXISTS user_notification_prefs (user_id INTEGER PRIMARY KEY, email_enabled INTEGER DEFAULT 1, sms_enabled INTEGER DEFAULT 0, phone TEXT, email TEXT, updated_at TEXT DEFAULT (datetime('now')))`),
  table('circles',`CREATE TABLE IF NOT EXISTS circles (id INTEGER PRIMARY KEY AUTOINCREMENT, public_id TEXT NOT NULL UNIQUE, slug TEXT NOT NULL UNIQUE, name TEXT NOT NULL, is_primary INTEGER NOT NULL DEFAULT 0 CHECK(is_primary IN (0,1)), created_by INTEGER, created_at TEXT NOT NULL DEFAULT (datetime('now')), archived_at TEXT)`),
  table('circle_memberships',`CREATE TABLE IF NOT EXISTS circle_memberships (circle_id INTEGER NOT NULL, user_id INTEGER NOT NULL, role TEXT NOT NULL CHECK(role IN ('owner','member')), status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','inactive')), invited_by INTEGER, joined_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now')), PRIMARY KEY(circle_id,user_id), FOREIGN KEY(circle_id) REFERENCES circles(id) ON DELETE CASCADE)`),
  table('circle_invitations',`CREATE TABLE IF NOT EXISTS circle_invitations (id TEXT PRIMARY KEY, circle_id INTEGER NOT NULL, token_hash TEXT NOT NULL UNIQUE CHECK(length(token_hash)=64), email_hash TEXT NOT NULL CHECK(length(email_hash)=64), created_by INTEGER NOT NULL, created_at TEXT NOT NULL, expires_at TEXT NOT NULL, used_at TEXT, used_by INTEGER, revoked_at TEXT, FOREIGN KEY(circle_id) REFERENCES circles(id) ON DELETE CASCADE)`),
  table('circle_audit_events',`CREATE TABLE IF NOT EXISTS circle_audit_events (id INTEGER PRIMARY KEY AUTOINCREMENT, circle_id INTEGER NOT NULL, event_type TEXT NOT NULL, actor_user_id INTEGER, subject_user_id INTEGER, invitation_id TEXT, dedupe_key TEXT UNIQUE, created_at TEXT NOT NULL DEFAULT (datetime('now')), FOREIGN KEY(circle_id) REFERENCES circles(id) ON DELETE CASCADE)`),
  table('auth_rate_limits',`CREATE TABLE IF NOT EXISTS auth_rate_limits (key TEXT PRIMARY KEY, attempts INTEGER NOT NULL DEFAULT 0, expires_at INTEGER NOT NULL)`),
  table('circle_membership_rollout',`CREATE TABLE IF NOT EXISTS circle_membership_rollout (id INTEGER PRIMARY KEY CHECK(id=1), registrations_closed INTEGER NOT NULL DEFAULT 0 CHECK(registrations_closed IN (0,1)), updated_at TEXT NOT NULL DEFAULT (datetime('now')))`),
]);

const DECLARED_INDEX_OPERATIONS=Object.freeze([
  index('idx_video_signals_room','video_signals',['room_id','created_at']),
  index('idx_video_signals_room_id','video_signals',['room_id','id']),
  index('idx_pair_messages_pair','pair_messages',['pair_group_id','created_at']),
  index('idx_pair_sched_pair','pair_schedules',['pair_group_id']),
  index('uq_pair_schedules_week_pair','pair_schedules',['week_id','pair_group_id'],{unique:true}),
  index('idx_cq_slug','custom_questions',['slug']),
  index('idx_cq_author','custom_questions',['author_id']),
  index('idx_runs_user','session_runs',['user_id','created_at DESC']),
  index('idx_runs_question','session_runs',['question_slug']),
  index('idx_runs_user_q','session_runs',['user_id','question_slug']),
  index('idx_runs_pair_activity','session_runs',['week_id','pair_group_id','julianday(created_at) DESC','id DESC']),
  index('idx_messages_pair_activity','pair_messages',['week_id','pair_group_id','julianday(created_at) DESC','id DESC']),
  index('idx_pair_room_snapshots_updated_at','pair_room_snapshots',['updated_at']),
  index('idx_logs_level_created','app_logs',['level','created_at DESC']),
  index('idx_logs_event_created','app_logs',['event','created_at DESC']),
  index('idx_logs_source_created','app_logs',['source','created_at DESC']),
  index('idx_logs_created','app_logs',['created_at DESC']),
  index('idx_pairing_email_outbox_pending','pairing_email_outbox',['week_id','status','created_at']),
  index('idx_pairing_weeks_week_label','pairing_weeks',['week_label'],{unique:true}),
  index('uq_auth_accounts_google_sub','auth_accounts',['google_sub'],{unique:true,where:'google_sub IS NOT NULL'}),
  index('uq_circles_active_primary','circles',['is_primary'],{unique:true,where:'is_primary=1 AND archived_at IS NULL'}),
  index('idx_circle_memberships_user_active','circle_memberships',['user_id','status','circle_id']),
  index('idx_circle_memberships_circle_active','circle_memberships',['circle_id','status','user_id']),
  index('idx_circle_invitations_circle_created','circle_invitations',['circle_id','created_at DESC']),
  index('idx_circle_invitations_email','circle_invitations',['circle_id','email_hash','expires_at']),
  index('idx_circle_audit_circle_created','circle_audit_events',['circle_id','created_at DESC','id DESC']),
]);

const PLAN_1_TABLE_NAMES=new Set([
  'users','auth_accounts','pairing_weeks','pairing_groups','pairing_participants','pairing_week_runs',
  'pairing_email_outbox','questions','custom_questions','video_signals','pair_room_snapshots','pair_messages',
  'pair_schedules','session_runs','ai_sessions','ai_feedback','ai_usage','ai_account_monthly_usage',
  'ai_account_monthly_reservations','ai_consents','app_logs','user_notification_prefs','auth_rate_limits',
]);
const PLAN_1_INDEX_NAMES=new Set([
  'idx_video_signals_room','idx_video_signals_room_id','idx_pair_messages_pair','idx_pair_sched_pair',
  'uq_pair_schedules_week_pair','idx_cq_slug','idx_cq_author','idx_runs_user','idx_runs_question','idx_runs_user_q',
  'idx_runs_pair_activity','idx_messages_pair_activity','idx_pair_room_snapshots_updated_at','idx_logs_level_created',
  'idx_logs_event_created','idx_logs_source_created','idx_logs_created','idx_pairing_email_outbox_pending',
  'idx_pairing_weeks_week_label',
]);

export const SCHEMA_OPERATION_SETS=Object.freeze([
  Object.freeze({
    version:1,
    operations:Object.freeze([
      ...DECLARED_TABLE_OPERATIONS.filter(item=>PLAN_1_TABLE_NAMES.has(item.name)),
      ...DECLARED_INDEX_OPERATIONS.filter(item=>PLAN_1_INDEX_NAMES.has(item.name)),
    ]),
  }),
  Object.freeze({
    version:2,
    operations:Object.freeze([
      ...DECLARED_TABLE_OPERATIONS.filter(item=>!PLAN_1_TABLE_NAMES.has(item.name)),
      ...DECLARED_INDEX_OPERATIONS.filter(item=>!PLAN_1_INDEX_NAMES.has(item.name)),
    ]),
  }),
]);

function currentArtifacts(operation){
  const byName=new Map();
  SCHEMA_OPERATION_SETS.forEach(plan=>plan.operations
    .filter(item=>item.operation===operation)
    .forEach(item=>byName.set(item.name,item)));
  return Object.freeze([...byName.values()].map(item=>{
    const {operation:_operation,...definition}=item;
    return Object.freeze(definition);
  }));
}

export const TABLES=currentArtifacts('ensure-table');
export const INDEXES=currentArtifacts('ensure-index');

export const TOLERATED_LEGACY_TABLES=Object.freeze(['ai_monthly_usage']);

export function stableJson(value){
  if(Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if(value&&typeof value==='object'){
    return `{${Object.keys(value).sort().map(key=>`${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

export function checksum(value){
  return createHash('sha256').update(stableJson(value)).digest('hex');
}

export const SCHEMA_MANIFEST_CHECKSUM=checksum({
  version:SCHEMA_MANIFEST_VERSION,
  tables:TABLES,
  indexes:INDEXES,
  toleratedLegacyTables:TOLERATED_LEGACY_TABLES,
});

// Updating the schema is intentional only when this pinned checksum is updated
// in the same reviewed change.
export const PINNED_SCHEMA_MANIFEST_CHECKSUM='46df08c20a198b1740750b108024c13c04c9d21575363408a76df0a44a7422c9';

if(SCHEMA_MANIFEST_CHECKSUM!==PINNED_SCHEMA_MANIFEST_CHECKSUM){
  throw new Error(`Schema manifest checksum changed: ${SCHEMA_MANIFEST_CHECKSUM}`);
}

export const SCHEMA_MANIFEST=Object.freeze({
  version:SCHEMA_MANIFEST_VERSION,
  checksum:SCHEMA_MANIFEST_CHECKSUM,
  tables:TABLES,
  indexes:INDEXES,
  toleratedLegacyTables:TOLERATED_LEGACY_TABLES,
});
