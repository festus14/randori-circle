-- Historical pre-ledger deployment fixture.
--
-- The DDL below was assembled from the runtime CREATE/ALTER statements in:
--   git show cbe4afb:api/auth.js
--   git show cbe4afb:api/data.js
--   git show cbe4afb:api/ai.js
--   git show cbe4afb:api/ops.js
--   git show cbe4afb:api/video.js
-- cbe4afb was main immediately before versioned migrations were introduced.
-- This intentionally has application data but no schema_migrations table.

CREATE TABLE auth_accounts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  display_name TEXT NOT NULL,
  color TEXT NOT NULL,
  created_at TEXT DEFAULT (datetime('now')),
  last_login TEXT,
  is_available INTEGER DEFAULT 1,
  availability_updated_at TEXT,
  is_admin INTEGER DEFAULT 0,
  is_demo INTEGER DEFAULT 0,
  bio TEXT,
  tz TEXT,
  interview_focus TEXT DEFAULT 'both',
  leetcode_handle TEXT,
  phone TEXT,
  google_sub TEXT
);

CREATE TABLE users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  color TEXT NOT NULL,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE pairing_weeks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  week_label TEXT NOT NULL,
  week_start TEXT NOT NULL,
  focus TEXT NOT NULL DEFAULT 'both',
  created_at TEXT DEFAULT (datetime('now')),
  is_demo INTEGER DEFAULT 0
);

CREATE TABLE pairing_groups (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  week_id INTEGER NOT NULL REFERENCES pairing_weeks(id) ON DELETE CASCADE,
  user_a_id INTEGER NOT NULL,
  user_b_id INTEGER NOT NULL,
  user_c_id INTEGER,
  is_ai_pair INTEGER DEFAULT 0,
  topic TEXT DEFAULT 'Pick together',
  topic_kind TEXT DEFAULT 'both',
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE questions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  slug TEXT UNIQUE NOT NULL,
  title TEXT NOT NULL,
  type TEXT NOT NULL,
  difficulty TEXT NOT NULL,
  category TEXT NOT NULL,
  description TEXT NOT NULL
);

CREATE TABLE video_signals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  room_id TEXT NOT NULL,
  from_id TEXT NOT NULL,
  to_id TEXT,
  type TEXT NOT NULL,
  payload TEXT NOT NULL,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE ai_sessions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  room_id TEXT,
  pair_label TEXT,
  transcript TEXT,
  code_snapshots TEXT,
  interviewer_questions TEXT,
  started_at TEXT DEFAULT (datetime('now')),
  ended_at TEXT,
  duration_sec INTEGER,
  cost_cents INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now')),
  created_by INTEGER
);

CREATE TABLE ai_feedback (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id INTEGER NOT NULL REFERENCES ai_sessions(id) ON DELETE CASCADE,
  role TEXT DEFAULT 'both',
  feedback_json TEXT NOT NULL,
  evidence TEXT,
  model_used TEXT,
  reason_for_pick TEXT,
  estimated_cost_cents INTEGER,
  confidence REAL DEFAULT 0.85,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE ai_usage (
  date TEXT PRIMARY KEY,
  calls INTEGER DEFAULT 0,
  tokens_in INTEGER DEFAULT 0,
  tokens_out INTEGER DEFAULT 0,
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE ai_monthly_usage (
  month TEXT PRIMARY KEY,
  user_id INTEGER,
  calls INTEGER DEFAULT 0,
  tokens_in INTEGER DEFAULT 0,
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE ai_consents (
  user_id INTEGER PRIMARY KEY,
  consented_at TEXT NOT NULL DEFAULT (datetime('now')),
  revoked_at TEXT,
  policy_version TEXT NOT NULL
);

CREATE TABLE pair_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  week_id INTEGER NOT NULL,
  pair_group_id INTEGER NOT NULL,
  sender_id INTEGER NOT NULL,
  message TEXT NOT NULL,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE pair_schedules (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  week_id INTEGER NOT NULL,
  pair_group_id INTEGER NOT NULL,
  proposed_times TEXT,
  agreed_time TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),
  UNIQUE (week_id, pair_group_id)
);

CREATE TABLE custom_questions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  slug TEXT UNIQUE NOT NULL,
  title TEXT NOT NULL,
  type TEXT DEFAULT 'dsa',
  difficulty TEXT DEFAULT 'Medium',
  category TEXT DEFAULT 'custom',
  description TEXT NOT NULL,
  input_format TEXT,
  constraints_text TEXT,
  examples TEXT,
  test_cases TEXT NOT NULL,
  starter_per_lang TEXT,
  author_id INTEGER,
  source TEXT DEFAULT 'custom',
  leetcode_slug TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE app_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  level TEXT NOT NULL,
  source TEXT NOT NULL,
  event TEXT,
  message TEXT NOT NULL,
  meta_json TEXT,
  user_id INTEGER,
  route TEXT,
  ua TEXT,
  ip TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE session_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER,
  week_id INTEGER,
  pair_group_id INTEGER,
  question_id INTEGER,
  question_slug TEXT,
  language TEXT,
  code TEXT NOT NULL,
  test_cases_snapshot TEXT,
  results_json TEXT,
  passed_count INTEGER DEFAULT 0,
  total_count INTEGER DEFAULT 0,
  duration_ms INTEGER,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE user_notification_prefs (
  user_id INTEGER PRIMARY KEY,
  email_enabled INTEGER DEFAULT 1,
  sms_enabled INTEGER DEFAULT 0,
  phone TEXT,
  email TEXT,
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE auth_rate_limits (
  key TEXT PRIMARY KEY,
  attempts INTEGER NOT NULL DEFAULT 0,
  expires_at INTEGER NOT NULL
);

CREATE TABLE pairing_week_runs (
  week_label TEXT PRIMARY KEY,
  week_id INTEGER,
  generation_token TEXT NOT NULL,
  generation INTEGER NOT NULL DEFAULT 1,
  algorithm_version TEXT NOT NULL,
  algorithm_seed TEXT NOT NULL,
  participant_count INTEGER NOT NULL,
  participants_json TEXT NOT NULL,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE pairing_participants (
  week_id INTEGER NOT NULL,
  user_id INTEGER NOT NULL,
  position INTEGER NOT NULL,
  source TEXT NOT NULL DEFAULT 'auth',
  created_at TEXT DEFAULT (datetime('now')),
  PRIMARY KEY (week_id, user_id)
);

CREATE TABLE pairing_email_outbox (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  week_id INTEGER NOT NULL,
  user_id INTEGER NOT NULL,
  kind TEXT NOT NULL,
  recipient_email TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  attempt_count INTEGER NOT NULL DEFAULT 0,
  claimed_at TEXT,
  sent_at TEXT,
  provider_message_id TEXT,
  last_error TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),
  UNIQUE (week_id, user_id, kind)
);

CREATE TABLE pair_room_snapshots (
  room_id TEXT PRIMARY KEY,
  week_id INTEGER NOT NULL,
  pair_group_id INTEGER NOT NULL,
  revision INTEGER NOT NULL,
  schema_version INTEGER NOT NULL,
  client_id TEXT NOT NULL,
  client_seq INTEGER NOT NULL,
  language TEXT NOT NULL,
  question_id TEXT NOT NULL,
  code TEXT NOT NULL,
  updated_by INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (week_id, pair_group_id),
  FOREIGN KEY (pair_group_id) REFERENCES pairing_groups(id) ON DELETE CASCADE
);

CREATE INDEX idx_video_signals_room ON video_signals(room_id, created_at);
CREATE INDEX idx_video_signals_room_id ON video_signals(room_id, id);
CREATE INDEX idx_pair_messages_pair ON pair_messages(pair_group_id, created_at);
CREATE INDEX idx_pair_sched_pair ON pair_schedules(pair_group_id);
CREATE INDEX idx_cq_slug ON custom_questions(slug);
CREATE INDEX idx_cq_author ON custom_questions(author_id);
CREATE INDEX idx_runs_user ON session_runs(user_id, created_at DESC);
CREATE INDEX idx_runs_question ON session_runs(question_slug);
CREATE INDEX idx_runs_user_q ON session_runs(user_id, question_slug);
CREATE INDEX idx_logs_level_created ON app_logs(level, created_at DESC);
CREATE INDEX idx_logs_event_created ON app_logs(event, created_at DESC);
CREATE INDEX idx_logs_source_created ON app_logs(source, created_at DESC);
CREATE INDEX idx_logs_created ON app_logs(created_at DESC);
CREATE INDEX idx_pairing_email_outbox_pending
  ON pairing_email_outbox(week_id, status, created_at);
CREATE UNIQUE INDEX idx_pairing_weeks_week_label ON pairing_weeks(week_label);

INSERT INTO auth_accounts (
  id,email,password_hash,display_name,color,is_available,is_admin,bio,tz,
  interview_focus,leetcode_handle,phone,google_sub
) VALUES
  (101,'aya@example.test','legacy-hash-a','Aya','#ef4444',1,1,'Graph enthusiast','Europe/London','dsa','aya-code','+447700900101','google-aya'),
  (102,'ben@example.test','legacy-hash-b','Ben','#3b82f6',1,0,'Systems learner','America/New_York','both','ben-code','+12025550102','google-ben');

INSERT INTO users (id,name,color) VALUES (101,'Aya','#ef4444'),(102,'Ben','#3b82f6');
INSERT INTO pairing_weeks (id,week_label,week_start,focus,is_demo)
  VALUES (201,'2026-W37','2026-09-07','both',0);
INSERT INTO pairing_groups (
  id,week_id,user_a_id,user_b_id,is_ai_pair,topic,topic_kind
) VALUES (301,201,101,102,0,'Graphs and API design','both');
INSERT INTO questions (id,slug,title,type,difficulty,category,description)
  VALUES (401,'two-sum','Two Sum','dsa','Easy','arrays','Return the matching indices.');
INSERT INTO video_signals (id,room_id,from_id,to_id,type,payload)
  VALUES (501,'week_201_pair_301','101','102','offer','{"sdp":"legacy-offer"}');
INSERT INTO ai_sessions (
  id,room_id,pair_label,transcript,duration_sec,cost_cents,created_by
) VALUES (601,'week_201_pair_301','Aya + Ben','Discussed hash maps',1800,3,101);
INSERT INTO ai_feedback (id,session_id,role,feedback_json,model_used)
  VALUES (602,601,'both','{"summary":"Clear collaboration"}','legacy-model');
INSERT INTO ai_usage (date,calls,tokens_in,tokens_out)
  VALUES ('2026-09-08',1,120,45);
INSERT INTO ai_monthly_usage (month,user_id,calls,tokens_in)
  VALUES ('2026-09',101,1,120);
INSERT INTO ai_consents (user_id,policy_version) VALUES (101,'2026-01');
INSERT INTO pair_messages (id,week_id,pair_group_id,sender_id,message)
  VALUES (701,201,301,101,'Tuesday evening works for me.');
INSERT INTO pair_schedules (
  id,week_id,pair_group_id,proposed_times,agreed_time
) VALUES (702,201,301,'["2026-09-09T18:00:00Z"]','2026-09-09T18:00:00Z');
INSERT INTO custom_questions (
  id,slug,title,description,test_cases,author_id,source
) VALUES (801,'legacy-queue','Queue Exercise','Implement a queue.','[{"input":[],"expected":[]}]',101,'custom');
INSERT INTO app_logs (id,level,source,event,message,user_id)
  VALUES (901,'info','server','legacy_fixture','Fixture created',101);
INSERT INTO session_runs (
  id,user_id,week_id,pair_group_id,question_id,question_slug,language,code,
  results_json,passed_count,total_count,duration_ms
) VALUES (1001,101,201,301,401,'two-sum','javascript','return [0,1];','{"ok":true}',2,2,35);
INSERT INTO user_notification_prefs (user_id,email_enabled,sms_enabled,phone,email)
  VALUES (101,1,1,'+447700900101','aya@example.test');
INSERT INTO auth_rate_limits (key,attempts,expires_at)
  VALUES ('login:aya@example.test',2,1790000000000);
INSERT INTO pairing_week_runs (
  week_label,week_id,generation_token,generation,algorithm_version,
  algorithm_seed,participant_count,participants_json
) VALUES ('2026-W37',201,'legacy-generation-token',2,'seeded-v1','seed-37',2,'[101,102]');
INSERT INTO pairing_participants (week_id,user_id,position,source)
  VALUES (201,101,0,'auth'),(201,102,1,'auth');
INSERT INTO pairing_email_outbox (
  id,week_id,user_id,kind,recipient_email,status,attempt_count
) VALUES (1101,201,101,'pairing','aya@example.test','sent',1);
INSERT INTO pair_room_snapshots (
  room_id,week_id,pair_group_id,revision,schema_version,client_id,client_seq,
  language,question_id,code,updated_by
) VALUES (
  'week_201_pair_301',201,301,4,1,'legacy_client_101',9,
  'javascript','two-sum','function twoSum() { return [0, 1]; }',101
);
