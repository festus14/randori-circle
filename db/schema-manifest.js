import {checksum} from './stable-checksum.js';

export {checksum,stableJson} from './stable-checksum.js';

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

const AUTH_ACCOUNTS_OPERATION=table('auth_accounts',`CREATE TABLE IF NOT EXISTS auth_accounts (id INTEGER PRIMARY KEY AUTOINCREMENT, email TEXT UNIQUE NOT NULL, password_hash TEXT NOT NULL, display_name TEXT NOT NULL, color TEXT NOT NULL, created_at TEXT DEFAULT (datetime('now')), last_login TEXT, is_available INTEGER DEFAULT 1, availability_updated_at TEXT, is_admin INTEGER DEFAULT 0, is_demo INTEGER DEFAULT 0, bio TEXT, tz TEXT, interview_focus TEXT DEFAULT 'both', leetcode_handle TEXT, phone TEXT, google_sub TEXT)`);

const PLAN_1_TABLE_OPERATIONS=Object.freeze([
  table('users',`CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, color TEXT NOT NULL, created_at TEXT DEFAULT (datetime('now')))`),
  AUTH_ACCOUNTS_OPERATION,
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
  table('auth_rate_limits',`CREATE TABLE IF NOT EXISTS auth_rate_limits (key TEXT PRIMARY KEY, attempts INTEGER NOT NULL DEFAULT 0, expires_at INTEGER NOT NULL)`),
]);

const PLAN_1_INDEX_OPERATIONS=Object.freeze([
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
]);

const PLAN_2_OPERATIONS=Object.freeze([
  table('circles',`CREATE TABLE IF NOT EXISTS circles (id INTEGER PRIMARY KEY AUTOINCREMENT, public_id TEXT NOT NULL UNIQUE, slug TEXT NOT NULL UNIQUE, name TEXT NOT NULL, is_primary INTEGER NOT NULL DEFAULT 0 CHECK(is_primary IN (0,1)), created_by INTEGER, created_at TEXT NOT NULL DEFAULT (datetime('now')), archived_at TEXT)`),
  table('circle_memberships',`CREATE TABLE IF NOT EXISTS circle_memberships (circle_id INTEGER NOT NULL, user_id INTEGER NOT NULL, role TEXT NOT NULL CHECK(role IN ('owner','member')), status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','inactive')), invited_by INTEGER, joined_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now')), PRIMARY KEY(circle_id,user_id), FOREIGN KEY(circle_id) REFERENCES circles(id) ON DELETE CASCADE)`),
  table('circle_invitations',`CREATE TABLE IF NOT EXISTS circle_invitations (id TEXT PRIMARY KEY, circle_id INTEGER NOT NULL, token_hash TEXT NOT NULL UNIQUE CHECK(length(token_hash)=64), email_hash TEXT NOT NULL CHECK(length(email_hash)=64), created_by INTEGER NOT NULL, created_at TEXT NOT NULL, expires_at TEXT NOT NULL, used_at TEXT, used_by INTEGER, revoked_at TEXT, FOREIGN KEY(circle_id) REFERENCES circles(id) ON DELETE CASCADE)`),
  table('circle_audit_events',`CREATE TABLE IF NOT EXISTS circle_audit_events (id INTEGER PRIMARY KEY AUTOINCREMENT, circle_id INTEGER NOT NULL, event_type TEXT NOT NULL, actor_user_id INTEGER, subject_user_id INTEGER, invitation_id TEXT, dedupe_key TEXT UNIQUE, created_at TEXT NOT NULL DEFAULT (datetime('now')), FOREIGN KEY(circle_id) REFERENCES circles(id) ON DELETE CASCADE)`),
  table('circle_membership_rollout',`CREATE TABLE IF NOT EXISTS circle_membership_rollout (id INTEGER PRIMARY KEY CHECK(id=1), registrations_closed INTEGER NOT NULL DEFAULT 0 CHECK(registrations_closed IN (0,1)), updated_at TEXT NOT NULL DEFAULT (datetime('now')))`),
  index('uq_auth_accounts_google_sub','auth_accounts',['google_sub'],{unique:true,where:'google_sub IS NOT NULL'}),
  index('uq_circles_active_primary','circles',['is_primary'],{unique:true,where:'is_primary=1 AND archived_at IS NULL'}),
  index('idx_circle_memberships_user_active','circle_memberships',['user_id','status','circle_id']),
  index('idx_circle_memberships_circle_active','circle_memberships',['circle_id','status','user_id']),
  index('idx_circle_invitations_circle_created','circle_invitations',['circle_id','created_at DESC']),
  index('idx_circle_invitations_email','circle_invitations',['circle_id','email_hash','expires_at']),
  index('idx_circle_audit_circle_created','circle_audit_events',['circle_id','created_at DESC','id DESC']),
]);

const PLAN_3_OPERATIONS=Object.freeze([
  table('pairing_cycles',`CREATE TABLE IF NOT EXISTS pairing_cycles (scope_key TEXT NOT NULL, circle_id INTEGER, cycle_key TEXT NOT NULL CHECK(length(cycle_key)=64 AND cycle_key NOT GLOB '*[^0-9a-f]*'), cycle_id TEXT NOT NULL CHECK(length(cycle_id)=8 AND cycle_id GLOB '[0-9][0-9][0-9][0-9]-W[0-9][0-9]' AND substr(cycle_id,7,2) BETWEEN '01' AND '53'), starts_at TEXT NOT NULL CHECK(length(starts_at)=24 AND starts_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z' AND julianday(starts_at) IS NOT NULL AND strftime('%Y-%m-%dT%H:%M:%fZ',starts_at)=starts_at), ends_at TEXT NOT NULL CHECK(length(ends_at)=24 AND ends_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z' AND julianday(ends_at) IS NOT NULL AND strftime('%Y-%m-%dT%H:%M:%fZ',ends_at)=ends_at), cutoff_at TEXT NOT NULL CHECK(length(cutoff_at)=24 AND cutoff_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z' AND julianday(cutoff_at) IS NOT NULL AND strftime('%Y-%m-%dT%H:%M:%fZ',cutoff_at)=cutoff_at), time_zone TEXT NOT NULL CHECK(length(time_zone)>=1 AND length(time_zone)<=100 AND time_zone=trim(time_zone)), default_source TEXT NOT NULL CHECK(default_source IN ('legacy_bridge','cycle_default')), created_at TEXT NOT NULL DEFAULT (datetime('now')), PRIMARY KEY(scope_key,cycle_key), CHECK((scope_key='local' AND circle_id IS NULL) OR (typeof(circle_id)='integer' AND circle_id>0 AND scope_key=('circle:'||circle_id))), CHECK(cutoff_at<=starts_at AND starts_at<ends_at), FOREIGN KEY(circle_id) REFERENCES circles(id))`),
  table('pairing_cycle_availability',`CREATE TABLE IF NOT EXISTS pairing_cycle_availability (scope_key TEXT NOT NULL, cycle_key TEXT NOT NULL CHECK(length(cycle_key)=64 AND cycle_key NOT GLOB '*[^0-9a-f]*'), user_id INTEGER NOT NULL CHECK(typeof(user_id)='integer' AND user_id>0), is_available INTEGER NOT NULL CHECK(typeof(is_available)='integer' AND is_available IN (0,1)), version INTEGER NOT NULL DEFAULT 1 CHECK(typeof(version)='integer' AND version>=1), decision_source TEXT NOT NULL CHECK(decision_source IN ('user','legacy_bridge','cycle_default')), created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now')), PRIMARY KEY(scope_key,cycle_key,user_id), FOREIGN KEY(scope_key,cycle_key) REFERENCES pairing_cycles(scope_key,cycle_key), FOREIGN KEY(user_id) REFERENCES auth_accounts(id))`),
  index('idx_pairing_cycle_availability_candidates','pairing_cycle_availability',['scope_key','cycle_key','is_available','user_id']),
]);

const PLAN_4_OPERATIONS=Object.freeze([
  table('auth_provider_identities',`CREATE TABLE IF NOT EXISTS auth_provider_identities (issuer TEXT NOT NULL CHECK(issuer='https://accounts.google.com'), subject TEXT NOT NULL CHECK(length(subject)>=1 AND length(subject)<=255 AND subject NOT GLOB '*[^A-Za-z0-9_-]*'), user_id INTEGER NOT NULL, created_at TEXT NOT NULL DEFAULT (datetime('now')), last_login TEXT NOT NULL DEFAULT (datetime('now')), PRIMARY KEY(issuer,subject), UNIQUE(issuer,user_id), FOREIGN KEY(user_id) REFERENCES auth_accounts(id) ON DELETE CASCADE)`),
]);

const PLAN_5_OPERATIONS=Object.freeze([
  table('auth_sessions',`CREATE TABLE IF NOT EXISTS auth_sessions (session_hash TEXT PRIMARY KEY NOT NULL CHECK(length(session_hash)=64 AND session_hash NOT GLOB '*[^0-9a-f]*'), user_id INTEGER NOT NULL, created_at INTEGER NOT NULL CHECK(typeof(created_at)='integer' AND created_at>0), expires_at INTEGER NOT NULL CHECK(typeof(expires_at)='integer' AND expires_at>created_at), revoked_at INTEGER CHECK(revoked_at IS NULL OR (typeof(revoked_at)='integer' AND revoked_at>=created_at)), revocation_reason TEXT CHECK(revocation_reason IS NULL OR revocation_reason IN ('current_logout','logout_all','password_change','identity_change','membership_removed','rotation')), FOREIGN KEY(user_id) REFERENCES auth_accounts(id) ON DELETE CASCADE)`),
  index('idx_auth_sessions_user_active','auth_sessions',['user_id','revoked_at','expires_at']),
]);

const PLAN_6_OPERATIONS=Object.freeze([
  table('outbox_events',`CREATE TABLE IF NOT EXISTS outbox_events (id INTEGER PRIMARY KEY AUTOINCREMENT, event_type TEXT NOT NULL CHECK(length(event_type)>=3 AND length(event_type)<=100), event_version INTEGER NOT NULL CHECK(typeof(event_version)='integer' AND event_version>=1 AND event_version<=1000), idempotency_key TEXT NOT NULL UNIQUE CHECK(length(idempotency_key)>=8 AND length(idempotency_key)<=255), payload_json TEXT NOT NULL CHECK(length(payload_json)<=65536 AND json_valid(payload_json) AND json_type(payload_json)='object'), status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','processing','retry','delivered','suppressed','dead_letter')), not_before TEXT NOT NULL, next_attempt_at TEXT NOT NULL, attempt_count INTEGER NOT NULL DEFAULT 0 CHECK(typeof(attempt_count)='integer' AND attempt_count>=0), max_attempts INTEGER NOT NULL DEFAULT 5 CHECK(typeof(max_attempts)='integer' AND max_attempts BETWEEN 1 AND 100), delivery_timeout_ms INTEGER NOT NULL DEFAULT 10000 CHECK(typeof(delivery_timeout_ms)='integer' AND delivery_timeout_ms BETWEEN 100 AND 120000), lease_owner TEXT, lease_token TEXT, leased_until TEXT, claim_from_status TEXT CHECK(claim_from_status IS NULL OR claim_from_status IN ('pending','processing','retry')), provider_name TEXT, provider_message_id TEXT, last_error_code TEXT, delivered_at TEXT, dead_lettered_at TEXT, replay_count INTEGER NOT NULL DEFAULT 0 CHECK(typeof(replay_count)='integer' AND replay_count>=0), created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')), updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')), CHECK((status='processing' AND lease_owner IS NOT NULL AND lease_token IS NOT NULL AND leased_until IS NOT NULL) OR (status<>'processing' AND lease_owner IS NULL AND lease_token IS NULL AND leased_until IS NULL)))`),
  table('outbox_audit_events',`CREATE TABLE IF NOT EXISTS outbox_audit_events (id INTEGER PRIMARY KEY AUTOINCREMENT, outbox_event_id INTEGER NOT NULL, action TEXT NOT NULL CHECK(action IN ('claimed','lease_renewed','retry_scheduled','delivered','suppressed','dead_lettered','replayed')), actor_type TEXT NOT NULL CHECK(actor_type IN ('worker','operator','system')), actor_ref TEXT NOT NULL CHECK(length(actor_ref)>=1 AND length(actor_ref)<=100), from_status TEXT, to_status TEXT NOT NULL, reason_code TEXT CHECK(reason_code IS NULL OR (length(reason_code)>=1 AND length(reason_code)<=64)), attempt_number INTEGER NOT NULL CHECK(typeof(attempt_number)='integer' AND attempt_number>=0), created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')), FOREIGN KEY(outbox_event_id) REFERENCES outbox_events(id) ON DELETE RESTRICT)`),
  index('idx_outbox_events_dispatch','outbox_events',['status','next_attempt_at','not_before','id']),
  index('idx_outbox_events_lease','outbox_events',['status','leased_until','id']),
  index('idx_outbox_audit_event','outbox_audit_events',['outbox_event_id','id']),
]);

const PLAN_7_OPERATIONS=Object.freeze([
  table('auth_email_activations',`CREATE TABLE IF NOT EXISTS auth_email_activations (id TEXT PRIMARY KEY NOT NULL CHECK(length(id)=36), invitation_id TEXT NOT NULL UNIQUE, circle_id INTEGER NOT NULL, email TEXT NOT NULL CHECK(length(email)>=3 AND length(email)<=254 AND email=lower(trim(email))), email_hash TEXT NOT NULL CHECK(length(email_hash)=64 AND email_hash NOT GLOB '*[^0-9a-f]*'), password_hash TEXT NOT NULL CHECK(length(password_hash)>=20 AND length(password_hash)<=128), display_name TEXT NOT NULL CHECK(length(display_name)>=2 AND length(display_name)<=32), color TEXT NOT NULL CHECK(length(color)>=1 AND length(color)<=32), token_hash TEXT NOT NULL UNIQUE CHECK(length(token_hash)=64 AND token_hash NOT GLOB '*[^0-9a-f]*'), created_at INTEGER NOT NULL CHECK(typeof(created_at)='integer' AND created_at>0), expires_at INTEGER NOT NULL CHECK(typeof(expires_at)='integer' AND expires_at>created_at), last_sent_at INTEGER NOT NULL CHECK(typeof(last_sent_at)='integer' AND last_sent_at>=created_at), send_count INTEGER NOT NULL DEFAULT 1 CHECK(typeof(send_count)='integer' AND send_count BETWEEN 1 AND 5), used_at INTEGER CHECK(used_at IS NULL OR (typeof(used_at)='integer' AND used_at>=created_at)), revoked_at INTEGER CHECK(revoked_at IS NULL OR (typeof(revoked_at)='integer' AND revoked_at>=created_at)), CHECK(used_at IS NULL OR revoked_at IS NULL), FOREIGN KEY(invitation_id) REFERENCES circle_invitations(id) ON DELETE RESTRICT, FOREIGN KEY(circle_id) REFERENCES circles(id) ON DELETE RESTRICT)`),
  index('idx_auth_email_activations_token','auth_email_activations',['token_hash','expires_at']),
  index('idx_auth_email_activations_email','auth_email_activations',['email_hash','created_at DESC']),
]);

const PLAN_8_OPERATIONS=Object.freeze([
  table('auth_password_resets',`CREATE TABLE IF NOT EXISTS auth_password_resets (id TEXT PRIMARY KEY NOT NULL CHECK(length(id)=36), user_id INTEGER NOT NULL UNIQUE, email_hash TEXT NOT NULL CHECK(length(email_hash)=64 AND email_hash NOT GLOB '*[^0-9a-f]*'), token_hash TEXT NOT NULL UNIQUE CHECK(length(token_hash)=64 AND token_hash NOT GLOB '*[^0-9a-f]*'), created_at INTEGER NOT NULL CHECK(typeof(created_at)='integer' AND created_at>0), expires_at INTEGER NOT NULL CHECK(typeof(expires_at)='integer' AND expires_at>created_at), last_sent_at INTEGER NOT NULL CHECK(typeof(last_sent_at)='integer' AND last_sent_at>=created_at), send_count INTEGER NOT NULL DEFAULT 1 CHECK(typeof(send_count)='integer' AND send_count BETWEEN 1 AND 5), used_at INTEGER CHECK(used_at IS NULL OR (typeof(used_at)='integer' AND used_at>=created_at)), revoked_at INTEGER CHECK(revoked_at IS NULL OR (typeof(revoked_at)='integer' AND revoked_at>=created_at)), CHECK(used_at IS NULL OR revoked_at IS NULL), FOREIGN KEY(user_id) REFERENCES auth_accounts(id) ON DELETE CASCADE)`),
  table('auth_recent_proofs',`CREATE TABLE IF NOT EXISTS auth_recent_proofs (session_hash TEXT PRIMARY KEY NOT NULL CHECK(length(session_hash)=64 AND session_hash NOT GLOB '*[^0-9a-f]*'), user_id INTEGER NOT NULL, authenticated_at INTEGER NOT NULL CHECK(typeof(authenticated_at)='integer' AND authenticated_at>0), method TEXT NOT NULL CHECK(method IN ('password','google')), FOREIGN KEY(session_hash) REFERENCES auth_sessions(session_hash) ON DELETE CASCADE, FOREIGN KEY(user_id) REFERENCES auth_accounts(id) ON DELETE CASCADE)`),
  index('idx_auth_password_resets_token','auth_password_resets',['token_hash','expires_at']),
  index('idx_auth_password_resets_email','auth_password_resets',['email_hash','created_at DESC']),
  index('idx_auth_recent_proofs_user','auth_recent_proofs',['user_id','authenticated_at DESC']),
]);

const PLAN_9_OPERATIONS=Object.freeze([
  table('auth_provider_email_state',`CREATE TABLE IF NOT EXISTS auth_provider_email_state (issuer TEXT NOT NULL CHECK(issuer='https://accounts.google.com'), subject TEXT NOT NULL CHECK(length(subject)>=1 AND length(subject)<=255 AND subject NOT GLOB '*[^A-Za-z0-9_-]*'), email_hash TEXT NOT NULL CHECK(length(email_hash)=64 AND email_hash NOT GLOB '*[^0-9a-f]*'), hash_key_version INTEGER NOT NULL CHECK(typeof(hash_key_version)='integer' AND hash_key_version>=1 AND hash_key_version<=2147483647), hash_key_fingerprint TEXT NOT NULL CHECK(length(hash_key_fingerprint)=64 AND hash_key_fingerprint NOT GLOB '*[^0-9a-f]*'), observed_at INTEGER NOT NULL CHECK(typeof(observed_at)='integer' AND observed_at>0), changed_at INTEGER CHECK(changed_at IS NULL OR (typeof(changed_at)='integer' AND changed_at<=observed_at)), PRIMARY KEY(issuer,subject), FOREIGN KEY(issuer,subject) REFERENCES auth_provider_identities(issuer,subject) ON DELETE CASCADE)`),
  table('auth_identity_audit_events',`CREATE TABLE IF NOT EXISTS auth_identity_audit_events (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, actor_user_id INTEGER NOT NULL, event_type TEXT NOT NULL CHECK(event_type IN ('google_linked','google_unlinked','password_added','password_unlinked','link_conflict','unlink_denied','provider_email_changed','provider_email_rekeyed','recovery_completed')), provider TEXT NOT NULL CHECK(provider IN ('google','password')), outcome TEXT NOT NULL CHECK(outcome IN ('succeeded','denied','conflict','observed')), reason_code TEXT NOT NULL CHECK(length(reason_code)>=1 AND length(reason_code)<=64 AND reason_code NOT GLOB '*[^a-z0-9_]*'), created_at INTEGER NOT NULL CHECK(typeof(created_at)='integer' AND created_at>0), FOREIGN KEY(user_id) REFERENCES auth_accounts(id) ON DELETE RESTRICT, FOREIGN KEY(actor_user_id) REFERENCES auth_accounts(id) ON DELETE RESTRICT)`),
  index('idx_auth_identity_audit_user','auth_identity_audit_events',['user_id','created_at DESC','id DESC']),
  index('idx_auth_identity_audit_actor','auth_identity_audit_events',['actor_user_id','created_at DESC','id DESC']),
]);

const PLAN_10_OPERATIONS=Object.freeze([
  index('idx_pair_messages_room_cursor','pair_messages',['week_id','pair_group_id','id']),
  index('idx_pair_messages_sender_created','pair_messages',['sender_id','created_at']),
]);

const PLAN_11_OPERATIONS=Object.freeze([
  table('chat_retention_control',`CREATE TABLE IF NOT EXISTS chat_retention_control (id INTEGER PRIMARY KEY CHECK(id=1), enabled INTEGER NOT NULL DEFAULT 0 CHECK(enabled IN (0,1)), generation INTEGER NOT NULL CHECK(typeof(generation)='integer' AND generation>=1), policy_version TEXT NOT NULL CHECK(policy_version='private-beta-v1'), retention_days INTEGER NOT NULL CHECK(retention_days=90), updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')))`),
  table('chat_retention_scopes',`CREATE TABLE IF NOT EXISTS chat_retention_scopes (week_id INTEGER NOT NULL CHECK(typeof(week_id)='integer' AND week_id>0), pair_group_id INTEGER NOT NULL CHECK(typeof(pair_group_id)='integer' AND pair_group_id>0), scope_key TEXT NOT NULL CHECK(length(scope_key)>=5 AND length(scope_key)<=80), circle_id INTEGER, registered_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')), PRIMARY KEY(week_id,pair_group_id), UNIQUE(pair_group_id), CHECK((scope_key='local' AND circle_id IS NULL) OR (typeof(circle_id)='integer' AND circle_id>0 AND scope_key=('circle:'||circle_id))))`),
  table('chat_retention_runs',`CREATE TABLE IF NOT EXISTS chat_retention_runs (id INTEGER PRIMARY KEY AUTOINCREMENT, run_key TEXT NOT NULL UNIQUE CHECK(length(run_key)=64 AND run_key NOT GLOB '*[^0-9a-f]*'), mode TEXT NOT NULL CHECK(mode IN ('dry_run','purge')), scope_key TEXT NOT NULL CHECK(length(scope_key)>=5 AND length(scope_key)<=80), circle_id INTEGER, week_id INTEGER NOT NULL CHECK(typeof(week_id)='integer' AND week_id>0), pair_group_id INTEGER NOT NULL CHECK(typeof(pair_group_id)='integer' AND pair_group_id>0), cutoff_at TEXT NOT NULL CHECK(length(cutoff_at)=24 AND cutoff_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z' AND julianday(cutoff_at) IS NOT NULL AND strftime('%Y-%m-%dT%H:%M:%fZ',cutoff_at)=cutoff_at), source_max_message_id INTEGER NOT NULL CHECK(typeof(source_max_message_id)='integer' AND source_max_message_id>0), status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','processing','retry','held','completed','dead_letter')), checkpoint INTEGER NOT NULL DEFAULT 0 CHECK(typeof(checkpoint)='integer' AND checkpoint>=0), scan_cursor_id INTEGER NOT NULL DEFAULT 0 CHECK(typeof(scan_cursor_id)='integer' AND scan_cursor_id>=0), claim_count INTEGER NOT NULL DEFAULT 0 CHECK(typeof(claim_count)='integer' AND claim_count>=0), failure_count INTEGER NOT NULL DEFAULT 0 CHECK(typeof(failure_count)='integer' AND failure_count>=0), max_failures INTEGER NOT NULL DEFAULT 5 CHECK(typeof(max_failures)='integer' AND max_failures BETWEEN 1 AND 20), control_generation INTEGER CHECK(control_generation IS NULL OR (typeof(control_generation)='integer' AND control_generation>=1)), next_attempt_at TEXT NOT NULL, lease_owner TEXT, lease_token TEXT, leased_until TEXT, backup_evidence_digest TEXT NOT NULL CHECK(length(backup_evidence_digest)=64 AND backup_evidence_digest NOT GLOB '*[^0-9a-f]*'), backup_through_at TEXT NOT NULL, backup_completed_at TEXT NOT NULL, export_evidence_digest TEXT NOT NULL CHECK(length(export_evidence_digest)=64 AND export_evidence_digest NOT GLOB '*[^0-9a-f]*'), export_through_at TEXT NOT NULL, export_completed_at TEXT NOT NULL, eligible_count INTEGER NOT NULL DEFAULT 0 CHECK(typeof(eligible_count)='integer' AND eligible_count>=0), deleted_count INTEGER NOT NULL DEFAULT 0 CHECK(typeof(deleted_count)='integer' AND deleted_count>=0), replay_count INTEGER NOT NULL DEFAULT 0 CHECK(typeof(replay_count)='integer' AND replay_count>=0), last_error_code TEXT CHECK(last_error_code IS NULL OR (length(last_error_code)>=1 AND length(last_error_code)<=64 AND last_error_code NOT GLOB '*[^A-Z0-9_]*')), completed_at TEXT, dead_lettered_at TEXT, created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')), updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')), UNIQUE(scope_key,week_id,pair_group_id,cutoff_at,mode), CHECK((scope_key='local' AND circle_id IS NULL) OR (typeof(circle_id)='integer' AND circle_id>0 AND scope_key=('circle:'||circle_id))), CHECK(deleted_count<=eligible_count), CHECK(mode='purge' OR deleted_count=0), CHECK((status='processing' AND lease_owner IS NOT NULL AND lease_token IS NOT NULL AND leased_until IS NOT NULL AND control_generation IS NOT NULL) OR (status<>'processing' AND lease_owner IS NULL AND lease_token IS NULL AND leased_until IS NULL)), FOREIGN KEY(week_id,pair_group_id) REFERENCES chat_retention_scopes(week_id,pair_group_id) ON DELETE RESTRICT)`),
  table('chat_retention_legal_holds',`CREATE TABLE IF NOT EXISTS chat_retention_legal_holds (scope_key TEXT NOT NULL CHECK(length(scope_key)>=5 AND length(scope_key)<=80), circle_id INTEGER, week_id INTEGER NOT NULL CHECK(typeof(week_id)='integer' AND week_id>=0), pair_group_id INTEGER NOT NULL CHECK(typeof(pair_group_id)='integer' AND pair_group_id>=0), hold_level TEXT NOT NULL CHECK(hold_level IN ('tenant','room')), status TEXT NOT NULL CHECK(status IN ('active','released')), reason_code TEXT NOT NULL CHECK(length(reason_code)>=1 AND length(reason_code)<=64 AND reason_code NOT GLOB '*[^A-Z0-9_]*'), created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')), released_at TEXT, PRIMARY KEY(scope_key,week_id,pair_group_id), CHECK((scope_key='local' AND circle_id IS NULL) OR (typeof(circle_id)='integer' AND circle_id>0 AND scope_key=('circle:'||circle_id))), CHECK((hold_level='tenant' AND week_id=0 AND pair_group_id=0) OR (hold_level='room' AND week_id>0 AND pair_group_id>0)), CHECK((status='active' AND released_at IS NULL) OR (status='released' AND released_at IS NOT NULL)))`),
  table('chat_retention_audit_events',`CREATE TABLE IF NOT EXISTS chat_retention_audit_events (id INTEGER PRIMARY KEY AUTOINCREMENT, retention_run_id INTEGER NOT NULL, action TEXT NOT NULL CHECK(action IN ('enqueued','claimed','batch_scanned','batch_deleted','yielded','held','completed','retry_scheduled','dead_lettered','replayed')), from_status TEXT, to_status TEXT NOT NULL, item_count INTEGER NOT NULL DEFAULT 0 CHECK(typeof(item_count)='integer' AND item_count>=0), duration_ms INTEGER NOT NULL DEFAULT 0 CHECK(typeof(duration_ms)='integer' AND duration_ms>=0), reason_code TEXT CHECK(reason_code IS NULL OR (length(reason_code)>=1 AND length(reason_code)<=64 AND reason_code NOT GLOB '*[^A-Z0-9_]*')), created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')), FOREIGN KEY(retention_run_id) REFERENCES chat_retention_runs(id) ON DELETE RESTRICT)`),
  index('idx_chat_retention_runs_dispatch','chat_retention_runs',['mode','status','next_attempt_at','leased_until','id']),
  index('idx_chat_retention_scopes_tenant','chat_retention_scopes',['scope_key','week_id','pair_group_id']),
  index('idx_chat_retention_runs_scope','chat_retention_runs',['scope_key','week_id','pair_group_id','cutoff_at','mode']),
  index('idx_chat_retention_audit_run','chat_retention_audit_events',['retention_run_id','id']),
  index('idx_pair_messages_retention','pair_messages',['julianday(created_at)','id','week_id','pair_group_id']),
]);

const PLAN_12_OPERATIONS=Object.freeze([
  index('uq_auth_sessions_hash_user','auth_sessions',['session_hash','user_id'],{unique:true}),
  table('auth_session_circle_contexts',`CREATE TABLE IF NOT EXISTS auth_session_circle_contexts (session_hash TEXT PRIMARY KEY NOT NULL CHECK(length(session_hash)=64 AND session_hash NOT GLOB '*[^0-9a-f]*'), user_id INTEGER NOT NULL, circle_id INTEGER NOT NULL, context_version INTEGER NOT NULL CHECK(typeof(context_version)='integer' AND context_version>=1), updated_at INTEGER NOT NULL CHECK(typeof(updated_at)='integer' AND updated_at>0), FOREIGN KEY(session_hash,user_id) REFERENCES auth_sessions(session_hash,user_id) ON DELETE CASCADE, FOREIGN KEY(circle_id) REFERENCES circles(id) ON DELETE RESTRICT)`),
  index('idx_auth_session_circle_contexts_user_circle','auth_session_circle_contexts',['user_id','circle_id']),
]);

const PLAN_13_OPERATIONS=Object.freeze([
  index('uq_pairing_cycles_descriptor','pairing_cycles',['scope_key','circle_id','cycle_key','cycle_id','starts_at','ends_at','cutoff_at','time_zone'],{unique:true}),
  table('circle_pairing_publications',`CREATE TABLE IF NOT EXISTS circle_pairing_publications (id INTEGER PRIMARY KEY AUTOINCREMENT, scope_key TEXT NOT NULL CHECK(length(scope_key)>=8 AND length(scope_key)<=80), circle_id INTEGER NOT NULL CHECK(typeof(circle_id)='integer' AND circle_id>0), cycle_key TEXT NOT NULL CHECK(length(cycle_key)=64 AND cycle_key NOT GLOB '*[^0-9a-f]*'), cycle_id TEXT NOT NULL CHECK(length(cycle_id)=8 AND cycle_id GLOB '[0-9][0-9][0-9][0-9]-W[0-9][0-9]' AND substr(cycle_id,7,2) BETWEEN '01' AND '53'), starts_at TEXT NOT NULL CHECK(length(starts_at)=24 AND starts_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z' AND julianday(starts_at) IS NOT NULL AND strftime('%Y-%m-%dT%H:%M:%fZ',starts_at)=starts_at), ends_at TEXT NOT NULL CHECK(length(ends_at)=24 AND ends_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z' AND julianday(ends_at) IS NOT NULL AND strftime('%Y-%m-%dT%H:%M:%fZ',ends_at)=ends_at), cutoff_at TEXT NOT NULL CHECK(length(cutoff_at)=24 AND cutoff_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z' AND julianday(cutoff_at) IS NOT NULL AND strftime('%Y-%m-%dT%H:%M:%fZ',cutoff_at)=cutoff_at), time_zone TEXT NOT NULL CHECK(length(time_zone)>=1 AND length(time_zone)<=100 AND time_zone=trim(time_zone)), generation_token TEXT NOT NULL CHECK(length(generation_token)=36), algorithm_version TEXT NOT NULL CHECK(length(algorithm_version)>=1 AND length(algorithm_version)<=64), algorithm_seed TEXT NOT NULL CHECK(length(algorithm_seed)>=1 AND length(algorithm_seed)<=255), participant_count INTEGER NOT NULL CHECK(typeof(participant_count)='integer' AND participant_count>=0), created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')), UNIQUE(scope_key,cycle_key), UNIQUE(id,scope_key,circle_id,cycle_key), CHECK(scope_key=('circle:'||circle_id)), CHECK(cutoff_at<=starts_at AND starts_at<ends_at), FOREIGN KEY(circle_id) REFERENCES circles(id) ON DELETE RESTRICT, FOREIGN KEY(scope_key,circle_id,cycle_key,cycle_id,starts_at,ends_at,cutoff_at,time_zone) REFERENCES pairing_cycles(scope_key,circle_id,cycle_key,cycle_id,starts_at,ends_at,cutoff_at,time_zone) ON DELETE RESTRICT)`),
  table('circle_pairing_eligibility',`CREATE TABLE IF NOT EXISTS circle_pairing_eligibility (publication_id INTEGER NOT NULL CHECK(typeof(publication_id)='integer' AND publication_id>0), scope_key TEXT NOT NULL, circle_id INTEGER NOT NULL CHECK(typeof(circle_id)='integer' AND circle_id>0), cycle_key TEXT NOT NULL CHECK(length(cycle_key)=64 AND cycle_key NOT GLOB '*[^0-9a-f]*'), user_id INTEGER NOT NULL CHECK(typeof(user_id)='integer' AND user_id>0), is_available INTEGER NOT NULL CHECK(typeof(is_available)='integer' AND is_available IN (0,1)), availability_version INTEGER NOT NULL CHECK(typeof(availability_version)='integer' AND availability_version>=0), availability_source TEXT NOT NULL CHECK(availability_source IN ('user','cycle_default')), position INTEGER NOT NULL CHECK(typeof(position)='integer' AND position>=0), group_position INTEGER, group_size INTEGER, member_position INTEGER, created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')), PRIMARY KEY(publication_id,user_id), UNIQUE(publication_id,position), UNIQUE(publication_id,group_position,member_position), UNIQUE(publication_id,scope_key,circle_id,cycle_key,user_id), UNIQUE(publication_id,scope_key,circle_id,cycle_key,user_id,is_available,group_position,group_size,member_position), CHECK(scope_key=('circle:'||circle_id)), CHECK((is_available=0 AND group_position IS NULL AND group_size IS NULL AND member_position IS NULL) OR (is_available=1 AND typeof(group_position)='integer' AND group_position>=0 AND typeof(group_size)='integer' AND group_size IN (1,2) AND typeof(member_position)='integer' AND member_position>=0 AND member_position<group_size AND (group_size=2 OR member_position=0))), FOREIGN KEY(publication_id,scope_key,circle_id,cycle_key) REFERENCES circle_pairing_publications(id,scope_key,circle_id,cycle_key) ON DELETE RESTRICT, FOREIGN KEY(user_id) REFERENCES auth_accounts(id) ON DELETE RESTRICT)`),
  table('circle_pairing_groups',`CREATE TABLE IF NOT EXISTS circle_pairing_groups (id INTEGER PRIMARY KEY AUTOINCREMENT, publication_id INTEGER NOT NULL CHECK(typeof(publication_id)='integer' AND publication_id>0), scope_key TEXT NOT NULL, circle_id INTEGER NOT NULL CHECK(typeof(circle_id)='integer' AND circle_id>0), cycle_key TEXT NOT NULL CHECK(length(cycle_key)=64 AND cycle_key NOT GLOB '*[^0-9a-f]*'), position INTEGER NOT NULL CHECK(typeof(position)='integer' AND position>=0), member_count INTEGER NOT NULL CHECK(typeof(member_count)='integer' AND member_count IN (1,2)), user_a_id INTEGER NOT NULL CHECK(typeof(user_a_id)='integer' AND user_a_id>0), user_a_available INTEGER NOT NULL DEFAULT 1 CHECK(typeof(user_a_available)='integer' AND user_a_available=1), user_a_member_position INTEGER NOT NULL DEFAULT 0 CHECK(typeof(user_a_member_position)='integer' AND user_a_member_position=0), user_b_id INTEGER, user_b_available INTEGER, user_b_member_position INTEGER, is_solo INTEGER NOT NULL CHECK(typeof(is_solo)='integer' AND is_solo IN (0,1)), created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')), UNIQUE(publication_id,position), CHECK(scope_key=('circle:'||circle_id)), CHECK((is_solo=1 AND member_count=1 AND user_b_id IS NULL AND user_b_available IS NULL AND user_b_member_position IS NULL) OR (is_solo=0 AND member_count=2 AND typeof(user_b_id)='integer' AND user_b_id>0 AND user_b_id<>user_a_id AND typeof(user_b_available)='integer' AND user_b_available=1 AND typeof(user_b_member_position)='integer' AND user_b_member_position=1)), FOREIGN KEY(publication_id,scope_key,circle_id,cycle_key) REFERENCES circle_pairing_publications(id,scope_key,circle_id,cycle_key) ON DELETE RESTRICT, FOREIGN KEY(publication_id,scope_key,circle_id,cycle_key,user_a_id,user_a_available,position,member_count,user_a_member_position) REFERENCES circle_pairing_eligibility(publication_id,scope_key,circle_id,cycle_key,user_id,is_available,group_position,group_size,member_position) ON DELETE RESTRICT, FOREIGN KEY(publication_id,scope_key,circle_id,cycle_key,user_b_id,user_b_available,position,member_count,user_b_member_position) REFERENCES circle_pairing_eligibility(publication_id,scope_key,circle_id,cycle_key,user_id,is_available,group_position,group_size,member_position) ON DELETE RESTRICT)`),
  index('idx_circle_pairing_publications_circle_cycle','circle_pairing_publications',['circle_id','starts_at DESC','id DESC']),
  index('idx_circle_pairing_eligibility_scope_user','circle_pairing_eligibility',['scope_key','user_id','publication_id DESC']),
  index('idx_circle_pairing_groups_user_a','circle_pairing_groups',['publication_id','user_a_id']),
  index('idx_circle_pairing_groups_user_b','circle_pairing_groups',['publication_id','user_b_id']),
]);

const PLAN_14_OPERATIONS=Object.freeze([
  index('uq_circle_audit_events_id_circle','circle_audit_events',['id','circle_id'],{unique:true}),
  table('circle_creation_requests',`CREATE TABLE IF NOT EXISTS circle_creation_requests (actor_user_id INTEGER NOT NULL CHECK(typeof(actor_user_id)='integer' AND actor_user_id>0), request_hash TEXT NOT NULL CHECK(length(request_hash)=64 AND request_hash NOT GLOB '*[^0-9a-f]*'), request_fingerprint TEXT NOT NULL CHECK(length(request_fingerprint)=64 AND request_fingerprint NOT GLOB '*[^0-9a-f]*'), initiating_session_hash TEXT NOT NULL CHECK(length(initiating_session_hash)=64 AND initiating_session_hash NOT GLOB '*[^0-9a-f]*'), circle_id INTEGER NOT NULL UNIQUE CHECK(typeof(circle_id)='integer' AND circle_id>0), audit_event_id INTEGER NOT NULL UNIQUE CHECK(typeof(audit_event_id)='integer' AND audit_event_id>0), context_version INTEGER NOT NULL CHECK(typeof(context_version)='integer' AND context_version>=1), created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')), PRIMARY KEY(actor_user_id,request_hash), FOREIGN KEY(actor_user_id) REFERENCES auth_accounts(id) ON DELETE RESTRICT, FOREIGN KEY(circle_id) REFERENCES circles(id) ON DELETE RESTRICT, FOREIGN KEY(circle_id,actor_user_id) REFERENCES circle_memberships(circle_id,user_id) ON DELETE RESTRICT, FOREIGN KEY(audit_event_id,circle_id) REFERENCES circle_audit_events(id,circle_id) ON DELETE RESTRICT)`),
  index('idx_circle_creation_requests_circle','circle_creation_requests',['circle_id','actor_user_id']),
]);

const PLAN_15_OPERATIONS=Object.freeze([
  table('credential_key_controls',`CREATE TABLE IF NOT EXISTS credential_key_controls (purpose TEXT PRIMARY KEY NOT NULL CHECK(purpose IN ('email-activation','password-reset','invitation-email','identity-email-observation')), control_version INTEGER NOT NULL DEFAULT 1 CHECK(typeof(control_version)='integer' AND control_version=1), state TEXT NOT NULL DEFAULT 'uninitialized' CHECK(state IN ('uninitialized','accepted')), highest_key_version INTEGER CHECK(highest_key_version IS NULL OR (typeof(highest_key_version)='integer' AND highest_key_version>=1 AND highest_key_version<=2147483647)), highest_key_fingerprint TEXT CHECK(highest_key_fingerprint IS NULL OR (length(highest_key_fingerprint)=64 AND highest_key_fingerprint NOT GLOB '*[^0-9a-f]*')), generation INTEGER NOT NULL DEFAULT 0 CHECK(typeof(generation)='integer' AND generation>=0), installed_by_migration INTEGER NOT NULL DEFAULT 15 CHECK(typeof(installed_by_migration)='integer' AND installed_by_migration=15), installed_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')), updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')), CHECK((state='uninitialized' AND highest_key_version IS NULL AND highest_key_fingerprint IS NULL AND generation=0) OR (state='accepted' AND highest_key_version IS NOT NULL AND highest_key_fingerprint IS NOT NULL AND generation>=1)), CHECK(julianday(installed_at) IS NOT NULL AND julianday(updated_at) IS NOT NULL AND julianday(updated_at)>=julianday(installed_at)))`),
]);

export const SCHEMA_OPERATION_SETS=Object.freeze([
  Object.freeze({
    version:1,
    operations:Object.freeze([
      ...PLAN_1_TABLE_OPERATIONS,
      ...PLAN_1_INDEX_OPERATIONS,
    ]),
  }),
  Object.freeze({
    version:2,
    operations:PLAN_2_OPERATIONS,
  }),
  Object.freeze({
    version:3,
    operations:PLAN_3_OPERATIONS,
  }),
  Object.freeze({
    version:4,
    operations:PLAN_4_OPERATIONS,
  }),
  Object.freeze({
    version:5,
    operations:PLAN_5_OPERATIONS,
  }),
  Object.freeze({
    version:6,
    operations:PLAN_6_OPERATIONS,
  }),
  Object.freeze({
    version:7,
    operations:PLAN_7_OPERATIONS,
  }),
  Object.freeze({
    version:8,
    operations:PLAN_8_OPERATIONS,
  }),
  Object.freeze({
    version:9,
    operations:PLAN_9_OPERATIONS,
  }),
  Object.freeze({
    version:10,
    operations:PLAN_10_OPERATIONS,
  }),
  Object.freeze({
    version:11,
    operations:PLAN_11_OPERATIONS,
  }),
  Object.freeze({
    version:12,
    operations:PLAN_12_OPERATIONS,
  }),
  Object.freeze({
    version:13,
    operations:PLAN_13_OPERATIONS,
  }),
  Object.freeze({
    version:14,
    operations:PLAN_14_OPERATIONS,
  }),
  Object.freeze({
    version:15,
    operations:PLAN_15_OPERATIONS,
  }),
]);

export function resolveCurrentArtifacts(operationSets,operation){
  const byName=new Map();
  operationSets.forEach(plan=>plan.operations
    .filter(item=>item.operation===operation)
    .forEach(item=>byName.set(item.name,item)));
  return Object.freeze([...byName.values()].map(item=>{
    const {operation:_operation,...definition}=item;
    return Object.freeze(definition);
  }));
}

export const TABLES=resolveCurrentArtifacts(SCHEMA_OPERATION_SETS,'ensure-table');
export const INDEXES=resolveCurrentArtifacts(SCHEMA_OPERATION_SETS,'ensure-index');

export const TOLERATED_LEGACY_TABLES=Object.freeze(['ai_monthly_usage','schema_migrations']);

export const SCHEMA_MANIFEST_CHECKSUM=checksum({
  version:SCHEMA_MANIFEST_VERSION,
  tables:TABLES,
  indexes:INDEXES,
  toleratedLegacyTables:TOLERATED_LEGACY_TABLES,
});

// Updating the schema is intentional only when this pinned checksum is updated
// in the same reviewed change.
export const PINNED_SCHEMA_MANIFEST_CHECKSUM='b600670e379b6b1b9720672bac31587f9e509e0dfaf9653394bc52a1984c3dbf';

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
