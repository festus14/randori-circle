// Migration v24: parallel circle-owned workspace and retention.
// Reuses the v16 group ownership index; production apply is a protected owner cutover.
export const SECONDARY_WORKSPACE_OPERATIONS=Object.freeze([
  {
    "operation": "ensure-table",
    "name": "circle_pair_messages",
    "sql": "CREATE TABLE IF NOT EXISTS circle_pair_messages (id INTEGER PRIMARY KEY AUTOINCREMENT, publication_id INTEGER NOT NULL, group_id INTEGER NOT NULL, sender_id INTEGER NOT NULL, message TEXT NOT NULL, created_at TEXT DEFAULT (datetime('now')), scope_key TEXT NOT NULL, circle_id INTEGER NOT NULL CHECK(circle_id>0), cycle_key TEXT NOT NULL CHECK(length(cycle_key)=64 AND cycle_key NOT GLOB '*[^0-9a-f]*'), group_member_count INTEGER NOT NULL CHECK(group_member_count IN (1,2)), group_user_a_id INTEGER NOT NULL CHECK(group_user_a_id>0), group_user_b_id INTEGER, group_is_solo INTEGER NOT NULL CHECK(group_is_solo IN (0,1)), CHECK(scope_key=('circle:'||circle_id)), FOREIGN KEY(group_id,publication_id,scope_key,circle_id,cycle_key,group_member_count,group_user_a_id,group_user_b_id,group_is_solo) REFERENCES circle_pairing_groups(id,publication_id,scope_key,circle_id,cycle_key,member_count,user_a_id,user_b_id,is_solo) ON DELETE RESTRICT, FOREIGN KEY(group_id) REFERENCES circle_pairing_groups(id) ON DELETE RESTRICT, FOREIGN KEY(publication_id,scope_key,circle_id,cycle_key) REFERENCES circle_pairing_publications(id,scope_key,circle_id,cycle_key) ON DELETE RESTRICT)"
  },
  {
    "operation": "ensure-trigger",
    "name": "circle_pair_messages_insert_guard",
    "table": "circle_pair_messages",
    "sql": "CREATE TRIGGER IF NOT EXISTS circle_pair_messages_insert_guard BEFORE INSERT ON circle_pair_messages WHEN NOT EXISTS (SELECT 1 FROM circle_pairing_groups pg WHERE pg.id=NEW.group_id AND pg.publication_id=NEW.publication_id AND pg.scope_key=NEW.scope_key AND pg.circle_id=NEW.circle_id AND pg.cycle_key=NEW.cycle_key AND NEW.sender_id IN (pg.user_a_id,pg.user_b_id)) BEGIN SELECT RAISE(ABORT,'circle workspace actor mismatch'); END"
  },
  {
    "operation": "ensure-trigger",
    "name": "circle_pair_messages_update_guard",
    "table": "circle_pair_messages",
    "sql": "CREATE TRIGGER IF NOT EXISTS circle_pair_messages_update_guard BEFORE UPDATE ON circle_pair_messages WHEN NOT EXISTS (SELECT 1 FROM circle_pairing_groups pg WHERE pg.id=NEW.group_id AND pg.publication_id=NEW.publication_id AND pg.scope_key=NEW.scope_key AND pg.circle_id=NEW.circle_id AND pg.cycle_key=NEW.cycle_key AND NEW.sender_id IN (pg.user_a_id,pg.user_b_id)) BEGIN SELECT RAISE(ABORT,'circle workspace actor mismatch'); END"
  },
  {
    "operation": "ensure-trigger",
    "name": "circle_pair_messages_owner_immutable",
    "table": "circle_pair_messages",
    "sql": "CREATE TRIGGER IF NOT EXISTS circle_pair_messages_owner_immutable BEFORE UPDATE ON circle_pair_messages WHEN NEW.publication_id<>OLD.publication_id OR NEW.group_id<>OLD.group_id OR NEW.scope_key<>OLD.scope_key OR NEW.circle_id<>OLD.circle_id OR NEW.cycle_key<>OLD.cycle_key BEGIN SELECT RAISE(ABORT,'circle workspace ownership is immutable'); END"
  },
  {
    "operation": "ensure-index",
    "name": "circle_idx_pair_messages_pair",
    "table": "circle_pair_messages",
    "keyParts": [
      "group_id",
      "created_at"
    ],
    "unique": false,
    "where": null,
    "sql": "CREATE INDEX IF NOT EXISTS circle_idx_pair_messages_pair ON circle_pair_messages(group_id,created_at)"
  },
  {
    "operation": "ensure-index",
    "name": "circle_idx_messages_pair_activity",
    "table": "circle_pair_messages",
    "keyParts": [
      "publication_id",
      "group_id",
      "julianday(created_at) DESC",
      "id DESC"
    ],
    "unique": false,
    "where": null,
    "sql": "CREATE INDEX IF NOT EXISTS circle_idx_messages_pair_activity ON circle_pair_messages(publication_id,group_id,julianday(created_at) DESC,id DESC)"
  },
  {
    "operation": "ensure-index",
    "name": "circle_idx_pair_messages_room_cursor",
    "table": "circle_pair_messages",
    "keyParts": [
      "publication_id",
      "group_id",
      "id"
    ],
    "unique": false,
    "where": null,
    "sql": "CREATE INDEX IF NOT EXISTS circle_idx_pair_messages_room_cursor ON circle_pair_messages(publication_id,group_id,id)"
  },
  {
    "operation": "ensure-index",
    "name": "circle_idx_pair_messages_sender_created",
    "table": "circle_pair_messages",
    "keyParts": [
      "sender_id",
      "created_at"
    ],
    "unique": false,
    "where": null,
    "sql": "CREATE INDEX IF NOT EXISTS circle_idx_pair_messages_sender_created ON circle_pair_messages(sender_id,created_at)"
  },
  {
    "operation": "ensure-index",
    "name": "circle_idx_pair_messages_retention",
    "table": "circle_pair_messages",
    "keyParts": [
      "julianday(created_at)",
      "id",
      "publication_id",
      "group_id"
    ],
    "unique": false,
    "where": null,
    "sql": "CREATE INDEX IF NOT EXISTS circle_idx_pair_messages_retention ON circle_pair_messages(julianday(created_at),id,publication_id,group_id)"
  },
  {
    "operation": "ensure-table",
    "name": "circle_session_runs",
    "sql": "CREATE TABLE IF NOT EXISTS circle_session_runs (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER, publication_id INTEGER, group_id INTEGER, question_id INTEGER, question_slug TEXT, language TEXT, code TEXT NOT NULL, test_cases_snapshot TEXT, results_json TEXT, passed_count INTEGER DEFAULT 0, total_count INTEGER DEFAULT 0, duration_ms INTEGER, created_at TEXT DEFAULT (datetime('now')), scope_key TEXT NOT NULL, circle_id INTEGER NOT NULL CHECK(circle_id>0), cycle_key TEXT NOT NULL CHECK(length(cycle_key)=64 AND cycle_key NOT GLOB '*[^0-9a-f]*'), group_member_count INTEGER NOT NULL CHECK(group_member_count IN (1,2)), group_user_a_id INTEGER NOT NULL CHECK(group_user_a_id>0), group_user_b_id INTEGER, group_is_solo INTEGER NOT NULL CHECK(group_is_solo IN (0,1)), CHECK(scope_key=('circle:'||circle_id)), FOREIGN KEY(group_id,publication_id,scope_key,circle_id,cycle_key,group_member_count,group_user_a_id,group_user_b_id,group_is_solo) REFERENCES circle_pairing_groups(id,publication_id,scope_key,circle_id,cycle_key,member_count,user_a_id,user_b_id,is_solo) ON DELETE RESTRICT, FOREIGN KEY(group_id) REFERENCES circle_pairing_groups(id) ON DELETE RESTRICT, FOREIGN KEY(publication_id,scope_key,circle_id,cycle_key) REFERENCES circle_pairing_publications(id,scope_key,circle_id,cycle_key) ON DELETE RESTRICT)"
  },
  {
    "operation": "ensure-trigger",
    "name": "circle_session_runs_insert_guard",
    "table": "circle_session_runs",
    "sql": "CREATE TRIGGER IF NOT EXISTS circle_session_runs_insert_guard BEFORE INSERT ON circle_session_runs WHEN NOT EXISTS (SELECT 1 FROM circle_pairing_groups pg WHERE pg.id=NEW.group_id AND pg.publication_id=NEW.publication_id AND pg.scope_key=NEW.scope_key AND pg.circle_id=NEW.circle_id AND pg.cycle_key=NEW.cycle_key AND NEW.user_id IN (pg.user_a_id,pg.user_b_id)) BEGIN SELECT RAISE(ABORT,'circle workspace actor mismatch'); END"
  },
  {
    "operation": "ensure-trigger",
    "name": "circle_session_runs_update_guard",
    "table": "circle_session_runs",
    "sql": "CREATE TRIGGER IF NOT EXISTS circle_session_runs_update_guard BEFORE UPDATE ON circle_session_runs WHEN NOT EXISTS (SELECT 1 FROM circle_pairing_groups pg WHERE pg.id=NEW.group_id AND pg.publication_id=NEW.publication_id AND pg.scope_key=NEW.scope_key AND pg.circle_id=NEW.circle_id AND pg.cycle_key=NEW.cycle_key AND NEW.user_id IN (pg.user_a_id,pg.user_b_id)) BEGIN SELECT RAISE(ABORT,'circle workspace actor mismatch'); END"
  },
  {
    "operation": "ensure-trigger",
    "name": "circle_session_runs_owner_immutable",
    "table": "circle_session_runs",
    "sql": "CREATE TRIGGER IF NOT EXISTS circle_session_runs_owner_immutable BEFORE UPDATE ON circle_session_runs WHEN NEW.publication_id<>OLD.publication_id OR NEW.group_id<>OLD.group_id OR NEW.scope_key<>OLD.scope_key OR NEW.circle_id<>OLD.circle_id OR NEW.cycle_key<>OLD.cycle_key BEGIN SELECT RAISE(ABORT,'circle workspace ownership is immutable'); END"
  },
  {
    "operation": "ensure-index",
    "name": "circle_idx_runs_user",
    "table": "circle_session_runs",
    "keyParts": [
      "user_id",
      "created_at DESC"
    ],
    "unique": false,
    "where": null,
    "sql": "CREATE INDEX IF NOT EXISTS circle_idx_runs_user ON circle_session_runs(user_id,created_at DESC)"
  },
  {
    "operation": "ensure-index",
    "name": "circle_idx_runs_question",
    "table": "circle_session_runs",
    "keyParts": [
      "question_slug"
    ],
    "unique": false,
    "where": null,
    "sql": "CREATE INDEX IF NOT EXISTS circle_idx_runs_question ON circle_session_runs(question_slug)"
  },
  {
    "operation": "ensure-index",
    "name": "circle_idx_runs_user_q",
    "table": "circle_session_runs",
    "keyParts": [
      "user_id",
      "question_slug"
    ],
    "unique": false,
    "where": null,
    "sql": "CREATE INDEX IF NOT EXISTS circle_idx_runs_user_q ON circle_session_runs(user_id,question_slug)"
  },
  {
    "operation": "ensure-index",
    "name": "circle_idx_runs_pair_activity",
    "table": "circle_session_runs",
    "keyParts": [
      "publication_id",
      "group_id",
      "julianday(created_at) DESC",
      "id DESC"
    ],
    "unique": false,
    "where": null,
    "sql": "CREATE INDEX IF NOT EXISTS circle_idx_runs_pair_activity ON circle_session_runs(publication_id,group_id,julianday(created_at) DESC,id DESC)"
  },
  {
    "operation": "ensure-table",
    "name": "circle_pair_room_snapshots",
    "sql": "CREATE TABLE IF NOT EXISTS circle_pair_room_snapshots (room_id TEXT PRIMARY KEY, publication_id INTEGER NOT NULL, group_id INTEGER NOT NULL, revision INTEGER NOT NULL, schema_version INTEGER NOT NULL, client_id TEXT NOT NULL, client_seq INTEGER NOT NULL, language TEXT NOT NULL, question_id TEXT NOT NULL, code TEXT NOT NULL, updated_by INTEGER NOT NULL, created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now')), scope_key TEXT NOT NULL, circle_id INTEGER NOT NULL CHECK(circle_id>0), cycle_key TEXT NOT NULL CHECK(length(cycle_key)=64 AND cycle_key NOT GLOB '*[^0-9a-f]*'), group_member_count INTEGER NOT NULL CHECK(group_member_count IN (1,2)), group_user_a_id INTEGER NOT NULL CHECK(group_user_a_id>0), group_user_b_id INTEGER, group_is_solo INTEGER NOT NULL CHECK(group_is_solo IN (0,1)), UNIQUE(publication_id,group_id), CHECK(scope_key=('circle:'||circle_id)), FOREIGN KEY(group_id,publication_id,scope_key,circle_id,cycle_key,group_member_count,group_user_a_id,group_user_b_id,group_is_solo) REFERENCES circle_pairing_groups(id,publication_id,scope_key,circle_id,cycle_key,member_count,user_a_id,user_b_id,is_solo) ON DELETE RESTRICT, FOREIGN KEY(group_id) REFERENCES circle_pairing_groups(id) ON DELETE RESTRICT, FOREIGN KEY(publication_id,scope_key,circle_id,cycle_key) REFERENCES circle_pairing_publications(id,scope_key,circle_id,cycle_key) ON DELETE RESTRICT, CHECK(room_id=('circle_'||circle_id||'_publication_'||publication_id||'_group_'||group_id)))"
  },
  {
    "operation": "ensure-trigger",
    "name": "circle_pair_room_snapshots_insert_guard",
    "table": "circle_pair_room_snapshots",
    "sql": "CREATE TRIGGER IF NOT EXISTS circle_pair_room_snapshots_insert_guard BEFORE INSERT ON circle_pair_room_snapshots WHEN NOT EXISTS (SELECT 1 FROM circle_pairing_groups pg WHERE pg.id=NEW.group_id AND pg.publication_id=NEW.publication_id AND pg.scope_key=NEW.scope_key AND pg.circle_id=NEW.circle_id AND pg.cycle_key=NEW.cycle_key AND NEW.updated_by IN (pg.user_a_id,pg.user_b_id)) BEGIN SELECT RAISE(ABORT,'circle workspace actor mismatch'); END"
  },
  {
    "operation": "ensure-trigger",
    "name": "circle_pair_room_snapshots_update_guard",
    "table": "circle_pair_room_snapshots",
    "sql": "CREATE TRIGGER IF NOT EXISTS circle_pair_room_snapshots_update_guard BEFORE UPDATE ON circle_pair_room_snapshots WHEN NOT EXISTS (SELECT 1 FROM circle_pairing_groups pg WHERE pg.id=NEW.group_id AND pg.publication_id=NEW.publication_id AND pg.scope_key=NEW.scope_key AND pg.circle_id=NEW.circle_id AND pg.cycle_key=NEW.cycle_key AND NEW.updated_by IN (pg.user_a_id,pg.user_b_id)) BEGIN SELECT RAISE(ABORT,'circle workspace actor mismatch'); END"
  },
  {
    "operation": "ensure-trigger",
    "name": "circle_pair_room_snapshots_owner_immutable",
    "table": "circle_pair_room_snapshots",
    "sql": "CREATE TRIGGER IF NOT EXISTS circle_pair_room_snapshots_owner_immutable BEFORE UPDATE ON circle_pair_room_snapshots WHEN NEW.publication_id<>OLD.publication_id OR NEW.group_id<>OLD.group_id OR NEW.scope_key<>OLD.scope_key OR NEW.circle_id<>OLD.circle_id OR NEW.cycle_key<>OLD.cycle_key BEGIN SELECT RAISE(ABORT,'circle workspace ownership is immutable'); END"
  },
  {
    "operation": "ensure-index",
    "name": "circle_idx_pair_room_snapshots_updated_at",
    "table": "circle_pair_room_snapshots",
    "keyParts": [
      "updated_at"
    ],
    "unique": false,
    "where": null,
    "sql": "CREATE INDEX IF NOT EXISTS circle_idx_pair_room_snapshots_updated_at ON circle_pair_room_snapshots(updated_at)"
  },
  {
    "operation": "ensure-table",
    "name": "circle_pair_code_documents",
    "sql": "CREATE TABLE IF NOT EXISTS circle_pair_code_documents (publication_id INTEGER NOT NULL CHECK(typeof(publication_id)='integer' AND publication_id>0), group_id INTEGER NOT NULL CHECK(typeof(group_id)='integer' AND group_id>0), question_slug TEXT NOT NULL CHECK(length(question_slug)>=1 AND length(question_slug)<=120 AND question_slug NOT GLOB '*[^a-z0-9-]*'), question_version INTEGER NOT NULL CHECK(typeof(question_version)='integer' AND question_version>0), language TEXT NOT NULL CHECK(language IN ('javascript','python')), y_state_base64 TEXT NOT NULL CHECK(length(y_state_base64)>=4 AND length(y_state_base64)<=349528 AND y_state_base64 NOT GLOB '*[^A-Za-z0-9+/=]*'), state_hash TEXT NOT NULL CHECK(length(state_hash)=64 AND state_hash NOT GLOB '*[^0-9a-f]*'), code_hash TEXT NOT NULL CHECK(length(code_hash)=64 AND code_hash NOT GLOB '*[^0-9a-f]*'), revision INTEGER NOT NULL CHECK(typeof(revision)='integer' AND revision>=1), pair_user_a_id INTEGER NOT NULL CHECK(typeof(pair_user_a_id)='integer' AND pair_user_a_id>0), pair_user_a_source TEXT NOT NULL DEFAULT 'auth' CHECK(pair_user_a_source='auth'), pair_user_b_id INTEGER NOT NULL CHECK(typeof(pair_user_b_id)='integer' AND pair_user_b_id>0 AND pair_user_b_id<>pair_user_a_id), pair_user_b_source TEXT NOT NULL DEFAULT 'auth' CHECK(pair_user_b_source='auth'), pair_user_c_id INTEGER CHECK(pair_user_c_id IS NULL), last_actor_id INTEGER NOT NULL CHECK(typeof(last_actor_id)='integer' AND last_actor_id>0 AND last_actor_id IN (pair_user_a_id,pair_user_b_id)), last_actor_source TEXT NOT NULL DEFAULT 'auth' CHECK(last_actor_source='auth'), last_client_id TEXT NOT NULL CHECK(length(last_client_id)>=8 AND length(last_client_id)<=64 AND last_client_id NOT GLOB '*[^A-Za-z0-9_-]*'), last_client_seq INTEGER NOT NULL CHECK(typeof(last_client_seq)='integer' AND last_client_seq>=0), created_at TEXT NOT NULL CHECK(length(created_at)=24 AND created_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z' AND julianday(created_at) IS NOT NULL AND strftime('%Y-%m-%dT%H:%M:%fZ',created_at)=created_at), updated_at TEXT NOT NULL CHECK(length(updated_at)=24 AND updated_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z' AND julianday(updated_at) IS NOT NULL AND strftime('%Y-%m-%dT%H:%M:%fZ',updated_at)=updated_at), scope_key TEXT NOT NULL, circle_id INTEGER NOT NULL CHECK(circle_id>0), cycle_key TEXT NOT NULL CHECK(length(cycle_key)=64 AND cycle_key NOT GLOB '*[^0-9a-f]*'), group_member_count INTEGER NOT NULL CHECK(group_member_count IN (1,2)), group_user_a_id INTEGER NOT NULL CHECK(group_user_a_id>0), group_user_b_id INTEGER, group_is_solo INTEGER NOT NULL CHECK(group_is_solo IN (0,1)), PRIMARY KEY(publication_id,group_id,question_slug,question_version,language), CHECK(julianday(updated_at)>=julianday(created_at)), FOREIGN KEY(last_actor_id) REFERENCES auth_accounts(id) ON DELETE RESTRICT, CHECK(scope_key=('circle:'||circle_id)), FOREIGN KEY(group_id,publication_id,scope_key,circle_id,cycle_key,group_member_count,group_user_a_id,group_user_b_id,group_is_solo) REFERENCES circle_pairing_groups(id,publication_id,scope_key,circle_id,cycle_key,member_count,user_a_id,user_b_id,is_solo) ON DELETE RESTRICT, FOREIGN KEY(group_id) REFERENCES circle_pairing_groups(id) ON DELETE RESTRICT, FOREIGN KEY(publication_id,scope_key,circle_id,cycle_key) REFERENCES circle_pairing_publications(id,scope_key,circle_id,cycle_key) ON DELETE RESTRICT, CHECK(pair_user_c_id IS NULL))"
  },
  {
    "operation": "ensure-trigger",
    "name": "circle_pair_code_documents_insert_guard",
    "table": "circle_pair_code_documents",
    "sql": "CREATE TRIGGER IF NOT EXISTS circle_pair_code_documents_insert_guard BEFORE INSERT ON circle_pair_code_documents WHEN NOT EXISTS (SELECT 1 FROM circle_pairing_groups pg WHERE pg.id=NEW.group_id AND pg.publication_id=NEW.publication_id AND pg.scope_key=NEW.scope_key AND pg.circle_id=NEW.circle_id AND pg.cycle_key=NEW.cycle_key AND NEW.last_actor_id IN (pg.user_a_id,pg.user_b_id) AND NEW.pair_user_a_id=pg.user_a_id AND NEW.pair_user_b_id IS pg.user_b_id AND pg.is_solo=0 AND pg.member_count=2) BEGIN SELECT RAISE(ABORT,'circle workspace actor mismatch'); END"
  },
  {
    "operation": "ensure-trigger",
    "name": "circle_pair_code_documents_update_guard",
    "table": "circle_pair_code_documents",
    "sql": "CREATE TRIGGER IF NOT EXISTS circle_pair_code_documents_update_guard BEFORE UPDATE ON circle_pair_code_documents WHEN NOT EXISTS (SELECT 1 FROM circle_pairing_groups pg WHERE pg.id=NEW.group_id AND pg.publication_id=NEW.publication_id AND pg.scope_key=NEW.scope_key AND pg.circle_id=NEW.circle_id AND pg.cycle_key=NEW.cycle_key AND NEW.last_actor_id IN (pg.user_a_id,pg.user_b_id) AND NEW.pair_user_a_id=pg.user_a_id AND NEW.pair_user_b_id IS pg.user_b_id AND pg.is_solo=0 AND pg.member_count=2) BEGIN SELECT RAISE(ABORT,'circle workspace actor mismatch'); END"
  },
  {
    "operation": "ensure-trigger",
    "name": "circle_pair_code_documents_owner_immutable",
    "table": "circle_pair_code_documents",
    "sql": "CREATE TRIGGER IF NOT EXISTS circle_pair_code_documents_owner_immutable BEFORE UPDATE ON circle_pair_code_documents WHEN NEW.publication_id<>OLD.publication_id OR NEW.group_id<>OLD.group_id OR NEW.scope_key<>OLD.scope_key OR NEW.circle_id<>OLD.circle_id OR NEW.cycle_key<>OLD.cycle_key BEGIN SELECT RAISE(ABORT,'circle workspace ownership is immutable'); END"
  },
  {
    "operation": "ensure-index",
    "name": "circle_idx_pair_code_documents_retention",
    "table": "circle_pair_code_documents",
    "keyParts": [
      "updated_at",
      "publication_id",
      "group_id"
    ],
    "unique": false,
    "where": null,
    "sql": "CREATE INDEX IF NOT EXISTS circle_idx_pair_code_documents_retention ON circle_pair_code_documents(updated_at,publication_id,group_id)"
  },
  {
    "operation": "ensure-index",
    "name": "circle_idx_pair_code_documents_actor",
    "table": "circle_pair_code_documents",
    "keyParts": [
      "last_actor_id",
      "updated_at"
    ],
    "unique": false,
    "where": null,
    "sql": "CREATE INDEX IF NOT EXISTS circle_idx_pair_code_documents_actor ON circle_pair_code_documents(last_actor_id,updated_at)"
  },
  {
    "operation": "ensure-table",
    "name": "circle_session_completion_receipts",
    "sql": "CREATE TABLE IF NOT EXISTS circle_session_completion_receipts (publication_id INTEGER NOT NULL CHECK(typeof(publication_id)='integer' AND publication_id>0), group_id INTEGER NOT NULL CHECK(typeof(group_id)='integer' AND group_id>0), user_id INTEGER NOT NULL CHECK(typeof(user_id)='integer' AND user_id>0), participant_source TEXT NOT NULL DEFAULT 'auth' CHECK(participant_source='auth'), pair_user_a_id INTEGER NOT NULL CHECK(typeof(pair_user_a_id)='integer' AND pair_user_a_id>0), pair_user_b_id INTEGER CHECK(pair_user_b_id IS NULL OR (typeof(pair_user_b_id)='integer' AND pair_user_b_id>0)), pair_user_c_id INTEGER CHECK(pair_user_c_id IS NULL OR (typeof(pair_user_c_id)='integer' AND pair_user_c_id>0)), confirmed_at TEXT NOT NULL CHECK(length(confirmed_at)=24 AND confirmed_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z' AND julianday(confirmed_at) IS NOT NULL AND strftime('%Y-%m-%dT%H:%M:%fZ',confirmed_at)=confirmed_at), scope_key TEXT NOT NULL, circle_id INTEGER NOT NULL CHECK(circle_id>0), cycle_key TEXT NOT NULL CHECK(length(cycle_key)=64 AND cycle_key NOT GLOB '*[^0-9a-f]*'), group_member_count INTEGER NOT NULL CHECK(group_member_count IN (1,2)), group_user_a_id INTEGER NOT NULL CHECK(group_user_a_id>0), group_user_b_id INTEGER, group_is_solo INTEGER NOT NULL CHECK(group_is_solo IN (0,1)), PRIMARY KEY(publication_id,group_id,user_id), CHECK(user_id=pair_user_a_id OR user_id=pair_user_b_id OR (pair_user_c_id IS NOT NULL AND user_id=pair_user_c_id)), FOREIGN KEY(user_id) REFERENCES auth_accounts(id) ON DELETE RESTRICT, CHECK(scope_key=('circle:'||circle_id)), FOREIGN KEY(group_id,publication_id,scope_key,circle_id,cycle_key,group_member_count,group_user_a_id,group_user_b_id,group_is_solo) REFERENCES circle_pairing_groups(id,publication_id,scope_key,circle_id,cycle_key,member_count,user_a_id,user_b_id,is_solo) ON DELETE RESTRICT, FOREIGN KEY(group_id) REFERENCES circle_pairing_groups(id) ON DELETE RESTRICT, FOREIGN KEY(publication_id,scope_key,circle_id,cycle_key) REFERENCES circle_pairing_publications(id,scope_key,circle_id,cycle_key) ON DELETE RESTRICT, CHECK(pair_user_c_id IS NULL))"
  },
  {
    "operation": "ensure-trigger",
    "name": "circle_session_completion_receipts_insert_guard",
    "table": "circle_session_completion_receipts",
    "sql": "CREATE TRIGGER IF NOT EXISTS circle_session_completion_receipts_insert_guard BEFORE INSERT ON circle_session_completion_receipts WHEN NOT EXISTS (SELECT 1 FROM circle_pairing_groups pg WHERE pg.id=NEW.group_id AND pg.publication_id=NEW.publication_id AND pg.scope_key=NEW.scope_key AND pg.circle_id=NEW.circle_id AND pg.cycle_key=NEW.cycle_key AND NEW.user_id IN (pg.user_a_id,pg.user_b_id) AND NEW.pair_user_a_id=pg.user_a_id AND NEW.pair_user_b_id IS pg.user_b_id) BEGIN SELECT RAISE(ABORT,'circle workspace actor mismatch'); END"
  },
  {
    "operation": "ensure-trigger",
    "name": "circle_session_completion_receipts_update_guard",
    "table": "circle_session_completion_receipts",
    "sql": "CREATE TRIGGER IF NOT EXISTS circle_session_completion_receipts_update_guard BEFORE UPDATE ON circle_session_completion_receipts WHEN NOT EXISTS (SELECT 1 FROM circle_pairing_groups pg WHERE pg.id=NEW.group_id AND pg.publication_id=NEW.publication_id AND pg.scope_key=NEW.scope_key AND pg.circle_id=NEW.circle_id AND pg.cycle_key=NEW.cycle_key AND NEW.user_id IN (pg.user_a_id,pg.user_b_id) AND NEW.pair_user_a_id=pg.user_a_id AND NEW.pair_user_b_id IS pg.user_b_id) BEGIN SELECT RAISE(ABORT,'circle workspace actor mismatch'); END"
  },
  {
    "operation": "ensure-trigger",
    "name": "circle_session_completion_receipts_owner_immutable",
    "table": "circle_session_completion_receipts",
    "sql": "CREATE TRIGGER IF NOT EXISTS circle_session_completion_receipts_owner_immutable BEFORE UPDATE ON circle_session_completion_receipts WHEN NEW.publication_id<>OLD.publication_id OR NEW.group_id<>OLD.group_id OR NEW.scope_key<>OLD.scope_key OR NEW.circle_id<>OLD.circle_id OR NEW.cycle_key<>OLD.cycle_key BEGIN SELECT RAISE(ABORT,'circle workspace ownership is immutable'); END"
  },
  {
    "operation": "ensure-index",
    "name": "circle_idx_session_completion_receipts_user",
    "table": "circle_session_completion_receipts",
    "keyParts": [
      "user_id",
      "publication_id",
      "group_id"
    ],
    "unique": false,
    "where": null,
    "sql": "CREATE INDEX IF NOT EXISTS circle_idx_session_completion_receipts_user ON circle_session_completion_receipts(user_id,publication_id,group_id)"
  },
  {
    "operation": "ensure-table",
    "name": "circle_pair_session_controls",
    "sql": "CREATE TABLE IF NOT EXISTS circle_pair_session_controls (publication_id INTEGER NOT NULL CHECK(typeof(publication_id)='integer' AND publication_id>0), group_id INTEGER NOT NULL CHECK(typeof(group_id)='integer' AND group_id>0), pair_user_a_id INTEGER NOT NULL CHECK(typeof(pair_user_a_id)='integer' AND pair_user_a_id>0), pair_user_a_source TEXT NOT NULL DEFAULT 'auth' CHECK(pair_user_a_source='auth'), pair_user_b_id INTEGER NOT NULL CHECK(typeof(pair_user_b_id)='integer' AND pair_user_b_id>0 AND pair_user_b_id<>pair_user_a_id), pair_user_b_source TEXT NOT NULL DEFAULT 'auth' CHECK(pair_user_b_source='auth'), pair_user_c_id INTEGER CHECK(pair_user_c_id IS NULL), candidate_user_id INTEGER NOT NULL CHECK(typeof(candidate_user_id)='integer' AND candidate_user_id>0 AND candidate_user_id IN (pair_user_a_id,pair_user_b_id)), candidate_source TEXT NOT NULL DEFAULT 'auth' CHECK(candidate_source='auth'), timer_state TEXT NOT NULL CHECK(timer_state IN ('paused','running')), remaining_ms INTEGER NOT NULL CHECK(typeof(remaining_ms)='integer' AND remaining_ms>=0 AND remaining_ms<=1500000), anchor_at TEXT, revision INTEGER NOT NULL CHECK(typeof(revision)='integer' AND revision>=1), updated_by INTEGER NOT NULL CHECK(typeof(updated_by)='integer' AND updated_by>0 AND updated_by IN (pair_user_a_id,pair_user_b_id)), updated_by_source TEXT NOT NULL DEFAULT 'auth' CHECK(updated_by_source='auth'), created_at TEXT NOT NULL CHECK(length(created_at)=24 AND created_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z' AND julianday(created_at) IS NOT NULL AND strftime('%Y-%m-%dT%H:%M:%fZ',created_at)=created_at), updated_at TEXT NOT NULL CHECK(length(updated_at)=24 AND updated_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z' AND julianday(updated_at) IS NOT NULL AND strftime('%Y-%m-%dT%H:%M:%fZ',updated_at)=updated_at), scope_key TEXT NOT NULL, circle_id INTEGER NOT NULL CHECK(circle_id>0), cycle_key TEXT NOT NULL CHECK(length(cycle_key)=64 AND cycle_key NOT GLOB '*[^0-9a-f]*'), group_member_count INTEGER NOT NULL CHECK(group_member_count IN (1,2)), group_user_a_id INTEGER NOT NULL CHECK(group_user_a_id>0), group_user_b_id INTEGER, group_is_solo INTEGER NOT NULL CHECK(group_is_solo IN (0,1)), PRIMARY KEY(publication_id,group_id), CHECK(anchor_at IS NULL OR (length(anchor_at)=24 AND anchor_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z' AND julianday(anchor_at) IS NOT NULL AND strftime('%Y-%m-%dT%H:%M:%fZ',anchor_at)=anchor_at)), CHECK((timer_state='paused' AND anchor_at IS NULL) OR (timer_state='running' AND anchor_at IS NOT NULL AND remaining_ms>0)), CHECK(julianday(updated_at)>=julianday(created_at)), CHECK(anchor_at IS NULL OR julianday(updated_at)>=julianday(anchor_at)), FOREIGN KEY(pair_user_a_id) REFERENCES auth_accounts(id) ON DELETE RESTRICT, FOREIGN KEY(pair_user_b_id) REFERENCES auth_accounts(id) ON DELETE RESTRICT, FOREIGN KEY(candidate_user_id) REFERENCES auth_accounts(id) ON DELETE RESTRICT, FOREIGN KEY(updated_by) REFERENCES auth_accounts(id) ON DELETE RESTRICT, CHECK(scope_key=('circle:'||circle_id)), FOREIGN KEY(group_id,publication_id,scope_key,circle_id,cycle_key,group_member_count,group_user_a_id,group_user_b_id,group_is_solo) REFERENCES circle_pairing_groups(id,publication_id,scope_key,circle_id,cycle_key,member_count,user_a_id,user_b_id,is_solo) ON DELETE RESTRICT, FOREIGN KEY(group_id) REFERENCES circle_pairing_groups(id) ON DELETE RESTRICT, FOREIGN KEY(publication_id,scope_key,circle_id,cycle_key) REFERENCES circle_pairing_publications(id,scope_key,circle_id,cycle_key) ON DELETE RESTRICT, CHECK(pair_user_c_id IS NULL))"
  },
  {
    "operation": "ensure-trigger",
    "name": "circle_pair_session_controls_insert_guard",
    "table": "circle_pair_session_controls",
    "sql": "CREATE TRIGGER IF NOT EXISTS circle_pair_session_controls_insert_guard BEFORE INSERT ON circle_pair_session_controls WHEN NOT EXISTS (SELECT 1 FROM circle_pairing_groups pg WHERE pg.id=NEW.group_id AND pg.publication_id=NEW.publication_id AND pg.scope_key=NEW.scope_key AND pg.circle_id=NEW.circle_id AND pg.cycle_key=NEW.cycle_key AND NEW.updated_by IN (pg.user_a_id,pg.user_b_id) AND NEW.pair_user_a_id=pg.user_a_id AND NEW.pair_user_b_id IS pg.user_b_id AND pg.is_solo=0 AND pg.member_count=2) BEGIN SELECT RAISE(ABORT,'circle workspace actor mismatch'); END"
  },
  {
    "operation": "ensure-trigger",
    "name": "circle_pair_session_controls_update_guard",
    "table": "circle_pair_session_controls",
    "sql": "CREATE TRIGGER IF NOT EXISTS circle_pair_session_controls_update_guard BEFORE UPDATE ON circle_pair_session_controls WHEN NOT EXISTS (SELECT 1 FROM circle_pairing_groups pg WHERE pg.id=NEW.group_id AND pg.publication_id=NEW.publication_id AND pg.scope_key=NEW.scope_key AND pg.circle_id=NEW.circle_id AND pg.cycle_key=NEW.cycle_key AND NEW.updated_by IN (pg.user_a_id,pg.user_b_id) AND NEW.pair_user_a_id=pg.user_a_id AND NEW.pair_user_b_id IS pg.user_b_id AND pg.is_solo=0 AND pg.member_count=2) BEGIN SELECT RAISE(ABORT,'circle workspace actor mismatch'); END"
  },
  {
    "operation": "ensure-trigger",
    "name": "circle_pair_session_controls_owner_immutable",
    "table": "circle_pair_session_controls",
    "sql": "CREATE TRIGGER IF NOT EXISTS circle_pair_session_controls_owner_immutable BEFORE UPDATE ON circle_pair_session_controls WHEN NEW.publication_id<>OLD.publication_id OR NEW.group_id<>OLD.group_id OR NEW.scope_key<>OLD.scope_key OR NEW.circle_id<>OLD.circle_id OR NEW.cycle_key<>OLD.cycle_key BEGIN SELECT RAISE(ABORT,'circle workspace ownership is immutable'); END"
  },
  {
    "operation": "ensure-index",
    "name": "circle_idx_pair_session_controls_updated_by",
    "table": "circle_pair_session_controls",
    "keyParts": [
      "updated_by",
      "publication_id",
      "group_id"
    ],
    "unique": false,
    "where": null,
    "sql": "CREATE INDEX IF NOT EXISTS circle_idx_pair_session_controls_updated_by ON circle_pair_session_controls(updated_by,publication_id,group_id)"
  },
  {
    "operation": "ensure-table",
    "name": "circle_pair_meeting_links",
    "sql": "CREATE TABLE IF NOT EXISTS circle_pair_meeting_links (publication_id INTEGER NOT NULL CHECK(typeof(publication_id)='integer' AND publication_id>0), group_id INTEGER NOT NULL CHECK(typeof(group_id)='integer' AND group_id>0), accepted_schedule_at TEXT NOT NULL CHECK(length(accepted_schedule_at)=24 AND accepted_schedule_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z' AND julianday(accepted_schedule_at) IS NOT NULL AND strftime('%Y-%m-%dT%H:%M:%fZ',accepted_schedule_at)=accepted_schedule_at), meeting_url TEXT CHECK(meeting_url IS NULL OR (typeof(meeting_url)='text' AND length(meeting_url)>=9 AND length(CAST(meeting_url AS BLOB))<=2048 AND substr(meeting_url,1,8)='https://')), revision INTEGER NOT NULL CHECK(typeof(revision)='integer' AND revision>=1), updated_by INTEGER NOT NULL CHECK(typeof(updated_by)='integer' AND updated_by>0 AND (updated_by=pair_user_a_id OR updated_by=pair_user_b_id OR (pair_user_c_id IS NOT NULL AND updated_by=pair_user_c_id))), updated_by_source TEXT NOT NULL DEFAULT 'auth' CHECK(updated_by_source='auth'), pair_user_a_id INTEGER NOT NULL CHECK(typeof(pair_user_a_id)='integer' AND pair_user_a_id>0), pair_user_b_id INTEGER NOT NULL CHECK(typeof(pair_user_b_id)='integer' AND pair_user_b_id>0), pair_user_c_id INTEGER CHECK(pair_user_c_id IS NULL OR (typeof(pair_user_c_id)='integer' AND pair_user_c_id>0)), created_at TEXT NOT NULL CHECK(length(created_at)=24 AND created_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z' AND julianday(created_at) IS NOT NULL AND strftime('%Y-%m-%dT%H:%M:%fZ',created_at)=created_at), updated_at TEXT NOT NULL CHECK(length(updated_at)=24 AND updated_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z' AND julianday(updated_at) IS NOT NULL AND strftime('%Y-%m-%dT%H:%M:%fZ',updated_at)=updated_at), scope_key TEXT NOT NULL, circle_id INTEGER NOT NULL CHECK(circle_id>0), cycle_key TEXT NOT NULL CHECK(length(cycle_key)=64 AND cycle_key NOT GLOB '*[^0-9a-f]*'), group_member_count INTEGER NOT NULL CHECK(group_member_count IN (1,2)), group_user_a_id INTEGER NOT NULL CHECK(group_user_a_id>0), group_user_b_id INTEGER, group_is_solo INTEGER NOT NULL CHECK(group_is_solo IN (0,1)), PRIMARY KEY(publication_id,group_id), CHECK(julianday(updated_at)>=julianday(created_at)), FOREIGN KEY(updated_by) REFERENCES auth_accounts(id) ON DELETE RESTRICT, CHECK(scope_key=('circle:'||circle_id)), FOREIGN KEY(group_id,publication_id,scope_key,circle_id,cycle_key,group_member_count,group_user_a_id,group_user_b_id,group_is_solo) REFERENCES circle_pairing_groups(id,publication_id,scope_key,circle_id,cycle_key,member_count,user_a_id,user_b_id,is_solo) ON DELETE RESTRICT, FOREIGN KEY(group_id) REFERENCES circle_pairing_groups(id) ON DELETE RESTRICT, FOREIGN KEY(publication_id,scope_key,circle_id,cycle_key) REFERENCES circle_pairing_publications(id,scope_key,circle_id,cycle_key) ON DELETE RESTRICT, CHECK(pair_user_c_id IS NULL), FOREIGN KEY(publication_id,scope_key,circle_id,cycle_key,group_id,accepted_schedule_at) REFERENCES circle_pair_schedules(publication_id,scope_key,circle_id,cycle_key,group_id,agreed_time) ON DELETE RESTRICT)"
  },
  {
    "operation": "ensure-trigger",
    "name": "circle_pair_meeting_links_insert_guard",
    "table": "circle_pair_meeting_links",
    "sql": "CREATE TRIGGER IF NOT EXISTS circle_pair_meeting_links_insert_guard BEFORE INSERT ON circle_pair_meeting_links WHEN NOT EXISTS (SELECT 1 FROM circle_pairing_groups pg WHERE pg.id=NEW.group_id AND pg.publication_id=NEW.publication_id AND pg.scope_key=NEW.scope_key AND pg.circle_id=NEW.circle_id AND pg.cycle_key=NEW.cycle_key AND NEW.updated_by IN (pg.user_a_id,pg.user_b_id) AND NEW.pair_user_a_id=pg.user_a_id AND NEW.pair_user_b_id IS pg.user_b_id) BEGIN SELECT RAISE(ABORT,'circle workspace actor mismatch'); END"
  },
  {
    "operation": "ensure-trigger",
    "name": "circle_pair_meeting_links_update_guard",
    "table": "circle_pair_meeting_links",
    "sql": "CREATE TRIGGER IF NOT EXISTS circle_pair_meeting_links_update_guard BEFORE UPDATE ON circle_pair_meeting_links WHEN NOT EXISTS (SELECT 1 FROM circle_pairing_groups pg WHERE pg.id=NEW.group_id AND pg.publication_id=NEW.publication_id AND pg.scope_key=NEW.scope_key AND pg.circle_id=NEW.circle_id AND pg.cycle_key=NEW.cycle_key AND NEW.updated_by IN (pg.user_a_id,pg.user_b_id) AND NEW.pair_user_a_id=pg.user_a_id AND NEW.pair_user_b_id IS pg.user_b_id) BEGIN SELECT RAISE(ABORT,'circle workspace actor mismatch'); END"
  },
  {
    "operation": "ensure-trigger",
    "name": "circle_pair_meeting_links_owner_immutable",
    "table": "circle_pair_meeting_links",
    "sql": "CREATE TRIGGER IF NOT EXISTS circle_pair_meeting_links_owner_immutable BEFORE UPDATE ON circle_pair_meeting_links WHEN NEW.publication_id<>OLD.publication_id OR NEW.group_id<>OLD.group_id OR NEW.scope_key<>OLD.scope_key OR NEW.circle_id<>OLD.circle_id OR NEW.cycle_key<>OLD.cycle_key BEGIN SELECT RAISE(ABORT,'circle workspace ownership is immutable'); END"
  },
  {
    "operation": "ensure-index",
    "name": "circle_idx_pair_meeting_links_updated_by",
    "table": "circle_pair_meeting_links",
    "keyParts": [
      "updated_by",
      "publication_id",
      "group_id"
    ],
    "unique": false,
    "where": null,
    "sql": "CREATE INDEX IF NOT EXISTS circle_idx_pair_meeting_links_updated_by ON circle_pair_meeting_links(updated_by,publication_id,group_id)"
  },
  {
    "operation": "ensure-table",
    "name": "circle_video_signals",
    "sql": "CREATE TABLE IF NOT EXISTS circle_video_signals (id INTEGER PRIMARY KEY AUTOINCREMENT, room_id TEXT NOT NULL, from_id TEXT NOT NULL, to_id TEXT, type TEXT NOT NULL, payload TEXT NOT NULL, created_at TEXT DEFAULT (datetime('now')), publication_id INTEGER NOT NULL CHECK(publication_id>0), group_id INTEGER NOT NULL CHECK(group_id>0), scope_key TEXT NOT NULL, circle_id INTEGER NOT NULL CHECK(circle_id>0), cycle_key TEXT NOT NULL CHECK(length(cycle_key)=64 AND cycle_key NOT GLOB '*[^0-9a-f]*'), group_member_count INTEGER NOT NULL CHECK(group_member_count IN (1,2)), group_user_a_id INTEGER NOT NULL CHECK(group_user_a_id>0), group_user_b_id INTEGER, group_is_solo INTEGER NOT NULL CHECK(group_is_solo IN (0,1)), CHECK(scope_key=('circle:'||circle_id)), FOREIGN KEY(group_id,publication_id,scope_key,circle_id,cycle_key,group_member_count,group_user_a_id,group_user_b_id,group_is_solo) REFERENCES circle_pairing_groups(id,publication_id,scope_key,circle_id,cycle_key,member_count,user_a_id,user_b_id,is_solo) ON DELETE RESTRICT, FOREIGN KEY(group_id) REFERENCES circle_pairing_groups(id) ON DELETE RESTRICT, FOREIGN KEY(publication_id,scope_key,circle_id,cycle_key) REFERENCES circle_pairing_publications(id,scope_key,circle_id,cycle_key) ON DELETE RESTRICT, CHECK(room_id=('circle_'||circle_id||'_publication_'||publication_id||'_group_'||group_id)))"
  },
  {
    "operation": "ensure-trigger",
    "name": "circle_video_signals_owner_immutable",
    "table": "circle_video_signals",
    "sql": "CREATE TRIGGER IF NOT EXISTS circle_video_signals_owner_immutable BEFORE UPDATE ON circle_video_signals WHEN NEW.publication_id<>OLD.publication_id OR NEW.group_id<>OLD.group_id OR NEW.scope_key<>OLD.scope_key OR NEW.circle_id<>OLD.circle_id OR NEW.cycle_key<>OLD.cycle_key BEGIN SELECT RAISE(ABORT,'circle workspace ownership is immutable'); END"
  },
  {
    "operation": "ensure-index",
    "name": "circle_idx_video_signals_room",
    "table": "circle_video_signals",
    "keyParts": [
      "room_id",
      "created_at"
    ],
    "unique": false,
    "where": null,
    "sql": "CREATE INDEX IF NOT EXISTS circle_idx_video_signals_room ON circle_video_signals(room_id,created_at)"
  },
  {
    "operation": "ensure-index",
    "name": "circle_idx_video_signals_room_id",
    "table": "circle_video_signals",
    "keyParts": [
      "room_id",
      "id"
    ],
    "unique": false,
    "where": null,
    "sql": "CREATE INDEX IF NOT EXISTS circle_idx_video_signals_room_id ON circle_video_signals(room_id,id)"
  },
  {
    "operation": "ensure-trigger",
    "name": "circle_completion_receipt_update_guard",
    "table": "circle_session_completion_receipts",
    "sql": "CREATE TRIGGER IF NOT EXISTS circle_completion_receipt_update_guard BEFORE UPDATE ON circle_session_completion_receipts WHEN 1 BEGIN SELECT RAISE(ABORT,'session completion receipts are immutable'); END"
  },
  {
    "operation": "ensure-trigger",
    "name": "circle_completion_group_update_guard",
    "table": "circle_pairing_groups",
    "sql": "CREATE TRIGGER IF NOT EXISTS circle_completion_group_update_guard BEFORE UPDATE ON circle_pairing_groups WHEN EXISTS (SELECT 1 FROM circle_session_completion_receipts r WHERE r.circle_id=OLD.circle_id AND r.publication_id=OLD.publication_id AND r.group_id=OLD.id) BEGIN SELECT RAISE(ABORT,'confirmed pairing snapshot is immutable'); END"
  },
  {
    "operation": "ensure-trigger",
    "name": "circle_completion_eligibility_update_guard",
    "table": "circle_pairing_eligibility",
    "sql": "CREATE TRIGGER IF NOT EXISTS circle_completion_eligibility_update_guard BEFORE UPDATE ON circle_pairing_eligibility WHEN EXISTS (SELECT 1 FROM circle_session_completion_receipts r WHERE r.circle_id=OLD.circle_id AND r.publication_id=OLD.publication_id AND (r.pair_user_a_id=OLD.user_id OR r.pair_user_b_id=OLD.user_id)) BEGIN SELECT RAISE(ABORT,'confirmed participant snapshot is immutable'); END"
  },
  {
    "operation": "ensure-trigger",
    "name": "circle_completion_group_delete_guard",
    "table": "circle_pairing_groups",
    "sql": "CREATE TRIGGER IF NOT EXISTS circle_completion_group_delete_guard BEFORE DELETE ON circle_pairing_groups WHEN EXISTS (SELECT 1 FROM circle_session_completion_receipts r WHERE r.circle_id=OLD.circle_id AND r.publication_id=OLD.publication_id AND r.group_id=OLD.id) BEGIN SELECT RAISE(ABORT,'confirmed pairing snapshot is immutable'); END"
  },
  {
    "operation": "ensure-trigger",
    "name": "circle_completion_eligibility_delete_guard",
    "table": "circle_pairing_eligibility",
    "sql": "CREATE TRIGGER IF NOT EXISTS circle_completion_eligibility_delete_guard BEFORE DELETE ON circle_pairing_eligibility WHEN EXISTS (SELECT 1 FROM circle_session_completion_receipts r WHERE r.circle_id=OLD.circle_id AND r.publication_id=OLD.publication_id AND (r.pair_user_a_id=OLD.user_id OR r.pair_user_b_id=OLD.user_id)) BEGIN SELECT RAISE(ABORT,'confirmed participant snapshot is immutable'); END"
  },
  {
    "operation": "ensure-table",
    "name": "circle_chat_retention_control",
    "sql": "CREATE TABLE IF NOT EXISTS circle_chat_retention_control (id INTEGER PRIMARY KEY CHECK(id=1), enabled INTEGER NOT NULL DEFAULT 0 CHECK(enabled IN (0,1)), generation INTEGER NOT NULL CHECK(typeof(generation)='integer' AND generation>=1), policy_version TEXT NOT NULL CHECK(policy_version='private-beta-v1'), retention_days INTEGER NOT NULL CHECK(retention_days=90), updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')))"
  },
  {
    "operation": "ensure-table",
    "name": "circle_chat_retention_scopes",
    "sql": "CREATE TABLE IF NOT EXISTS circle_chat_retention_scopes (publication_id INTEGER NOT NULL CHECK(typeof(publication_id)='integer' AND publication_id>0), group_id INTEGER NOT NULL CHECK(typeof(group_id)='integer' AND group_id>0), scope_key TEXT NOT NULL CHECK(length(scope_key)>=5 AND length(scope_key)<=80), circle_id INTEGER NOT NULL CHECK(circle_id>0), registered_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')), cycle_key TEXT NOT NULL CHECK(length(cycle_key)=64 AND cycle_key NOT GLOB '*[^0-9a-f]*'), group_member_count INTEGER NOT NULL CHECK(group_member_count IN (1,2)), group_user_a_id INTEGER NOT NULL CHECK(group_user_a_id>0), group_user_b_id INTEGER, group_is_solo INTEGER NOT NULL CHECK(group_is_solo IN (0,1)), PRIMARY KEY(circle_id,group_id), UNIQUE(publication_id,group_id), CHECK((scope_key='local' AND circle_id IS NULL) OR (typeof(circle_id)='integer' AND circle_id>0 AND scope_key=('circle:'||circle_id))), FOREIGN KEY(group_id,publication_id,scope_key,circle_id,cycle_key,group_member_count,group_user_a_id,group_user_b_id,group_is_solo) REFERENCES circle_pairing_groups(id,publication_id,scope_key,circle_id,cycle_key,member_count,user_a_id,user_b_id,is_solo) ON DELETE RESTRICT, FOREIGN KEY(group_id) REFERENCES circle_pairing_groups(id) ON DELETE RESTRICT, FOREIGN KEY(publication_id,scope_key,circle_id,cycle_key) REFERENCES circle_pairing_publications(id,scope_key,circle_id,cycle_key) ON DELETE RESTRICT)"
  },
  {
    "operation": "ensure-index",
    "name": "circle_idx_chat_retention_scopes_tenant",
    "table": "circle_chat_retention_scopes",
    "keyParts": [
      "scope_key",
      "publication_id",
      "group_id"
    ],
    "unique": false,
    "where": null,
    "sql": "CREATE INDEX IF NOT EXISTS circle_idx_chat_retention_scopes_tenant ON circle_chat_retention_scopes(scope_key,publication_id,group_id)"
  },
  {
    "operation": "ensure-table",
    "name": "circle_chat_retention_runs",
    "sql": "CREATE TABLE IF NOT EXISTS circle_chat_retention_runs (id INTEGER PRIMARY KEY AUTOINCREMENT, run_key TEXT NOT NULL UNIQUE CHECK(length(run_key)=64 AND run_key NOT GLOB '*[^0-9a-f]*'), mode TEXT NOT NULL CHECK(mode IN ('dry_run','purge')), scope_key TEXT NOT NULL CHECK(length(scope_key)>=5 AND length(scope_key)<=80), circle_id INTEGER NOT NULL CHECK(circle_id>0), publication_id INTEGER NOT NULL CHECK(typeof(publication_id)='integer' AND publication_id>0), group_id INTEGER NOT NULL CHECK(typeof(group_id)='integer' AND group_id>0), cutoff_at TEXT NOT NULL CHECK(length(cutoff_at)=24 AND cutoff_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z' AND julianday(cutoff_at) IS NOT NULL AND strftime('%Y-%m-%dT%H:%M:%fZ',cutoff_at)=cutoff_at), source_max_message_id INTEGER NOT NULL CHECK(typeof(source_max_message_id)='integer' AND source_max_message_id>0), status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','processing','retry','held','completed','dead_letter')), checkpoint INTEGER NOT NULL DEFAULT 0 CHECK(typeof(checkpoint)='integer' AND checkpoint>=0), scan_cursor_id INTEGER NOT NULL DEFAULT 0 CHECK(typeof(scan_cursor_id)='integer' AND scan_cursor_id>=0), claim_count INTEGER NOT NULL DEFAULT 0 CHECK(typeof(claim_count)='integer' AND claim_count>=0), failure_count INTEGER NOT NULL DEFAULT 0 CHECK(typeof(failure_count)='integer' AND failure_count>=0), max_failures INTEGER NOT NULL DEFAULT 5 CHECK(typeof(max_failures)='integer' AND max_failures BETWEEN 1 AND 20), control_generation INTEGER CHECK(control_generation IS NULL OR (typeof(control_generation)='integer' AND control_generation>=1)), next_attempt_at TEXT NOT NULL, lease_owner TEXT, lease_token TEXT, leased_until TEXT, backup_evidence_digest TEXT NOT NULL CHECK(length(backup_evidence_digest)=64 AND backup_evidence_digest NOT GLOB '*[^0-9a-f]*'), backup_through_at TEXT NOT NULL, backup_completed_at TEXT NOT NULL, export_evidence_digest TEXT NOT NULL CHECK(length(export_evidence_digest)=64 AND export_evidence_digest NOT GLOB '*[^0-9a-f]*'), export_through_at TEXT NOT NULL, export_completed_at TEXT NOT NULL, eligible_count INTEGER NOT NULL DEFAULT 0 CHECK(typeof(eligible_count)='integer' AND eligible_count>=0), deleted_count INTEGER NOT NULL DEFAULT 0 CHECK(typeof(deleted_count)='integer' AND deleted_count>=0), replay_count INTEGER NOT NULL DEFAULT 0 CHECK(typeof(replay_count)='integer' AND replay_count>=0), last_error_code TEXT CHECK(last_error_code IS NULL OR (length(last_error_code)>=1 AND length(last_error_code)<=64 AND last_error_code NOT GLOB '*[^A-Z0-9_]*')), completed_at TEXT, dead_lettered_at TEXT, created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')), updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')), UNIQUE(scope_key,publication_id,group_id,cutoff_at,mode), CHECK((scope_key='local' AND circle_id IS NULL) OR (typeof(circle_id)='integer' AND circle_id>0 AND scope_key=('circle:'||circle_id))), CHECK(deleted_count<=eligible_count), CHECK(mode='purge' OR deleted_count=0), CHECK((status='processing' AND lease_owner IS NOT NULL AND lease_token IS NOT NULL AND leased_until IS NOT NULL AND control_generation IS NOT NULL) OR (status<>'processing' AND lease_owner IS NULL AND lease_token IS NULL AND leased_until IS NULL)), FOREIGN KEY(publication_id,group_id) REFERENCES circle_chat_retention_scopes(publication_id,group_id) ON DELETE RESTRICT)"
  },
  {
    "operation": "ensure-index",
    "name": "circle_idx_chat_retention_runs_dispatch",
    "table": "circle_chat_retention_runs",
    "keyParts": [
      "mode",
      "status",
      "next_attempt_at",
      "leased_until",
      "id"
    ],
    "unique": false,
    "where": null,
    "sql": "CREATE INDEX IF NOT EXISTS circle_idx_chat_retention_runs_dispatch ON circle_chat_retention_runs(mode,status,next_attempt_at,leased_until,id)"
  },
  {
    "operation": "ensure-index",
    "name": "circle_idx_chat_retention_runs_scope",
    "table": "circle_chat_retention_runs",
    "keyParts": [
      "scope_key",
      "publication_id",
      "group_id",
      "cutoff_at",
      "mode"
    ],
    "unique": false,
    "where": null,
    "sql": "CREATE INDEX IF NOT EXISTS circle_idx_chat_retention_runs_scope ON circle_chat_retention_runs(scope_key,publication_id,group_id,cutoff_at,mode)"
  },
  {
    "operation": "ensure-table",
    "name": "circle_chat_retention_legal_holds",
    "sql": "CREATE TABLE IF NOT EXISTS circle_chat_retention_legal_holds (scope_key TEXT NOT NULL CHECK(length(scope_key)>=5 AND length(scope_key)<=80), circle_id INTEGER, publication_id INTEGER NOT NULL CHECK(typeof(publication_id)='integer' AND publication_id>=0), group_id INTEGER NOT NULL CHECK(typeof(group_id)='integer' AND group_id>=0), hold_level TEXT NOT NULL CHECK(hold_level IN ('tenant','room')), status TEXT NOT NULL CHECK(status IN ('active','released')), reason_code TEXT NOT NULL CHECK(length(reason_code)>=1 AND length(reason_code)<=64 AND reason_code NOT GLOB '*[^A-Z0-9_]*'), created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')), released_at TEXT, PRIMARY KEY(scope_key,publication_id,group_id), CHECK((scope_key='local' AND circle_id IS NULL) OR (typeof(circle_id)='integer' AND circle_id>0 AND scope_key=('circle:'||circle_id))), CHECK((hold_level='tenant' AND publication_id=0 AND group_id=0) OR (hold_level='room' AND publication_id>0 AND group_id>0)), CHECK((status='active' AND released_at IS NULL) OR (status='released' AND released_at IS NOT NULL)))"
  },
  {
    "operation": "ensure-table",
    "name": "circle_chat_retention_audit_events",
    "sql": "CREATE TABLE IF NOT EXISTS circle_chat_retention_audit_events (id INTEGER PRIMARY KEY AUTOINCREMENT, retention_run_id INTEGER NOT NULL, action TEXT NOT NULL CHECK(action IN ('enqueued','claimed','batch_scanned','batch_deleted','yielded','held','completed','retry_scheduled','dead_lettered','replayed')), from_status TEXT, to_status TEXT NOT NULL, item_count INTEGER NOT NULL DEFAULT 0 CHECK(typeof(item_count)='integer' AND item_count>=0), duration_ms INTEGER NOT NULL DEFAULT 0 CHECK(typeof(duration_ms)='integer' AND duration_ms>=0), reason_code TEXT CHECK(reason_code IS NULL OR (length(reason_code)>=1 AND length(reason_code)<=64 AND reason_code NOT GLOB '*[^A-Z0-9_]*')), created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')), FOREIGN KEY(retention_run_id) REFERENCES circle_chat_retention_runs(id) ON DELETE RESTRICT)"
  },
  {
    "operation": "ensure-index",
    "name": "circle_idx_chat_retention_audit_run",
    "table": "circle_chat_retention_audit_events",
    "keyParts": [
      "retention_run_id",
      "id"
    ],
    "unique": false,
    "where": null,
    "sql": "CREATE INDEX IF NOT EXISTS circle_idx_chat_retention_audit_run ON circle_chat_retention_audit_events(retention_run_id,id)"
  },
  {
    "operation": "ensure-trigger",
    "name": "circle_pair_messages_chain_insert_guard",
    "table": "circle_pair_messages",
    "sql": "CREATE TRIGGER IF NOT EXISTS circle_pair_messages_chain_insert_guard BEFORE INSERT ON circle_pair_messages WHEN NOT EXISTS (SELECT 1 FROM circle_pairing_groups pg WHERE pg.id=NEW.group_id AND pg.publication_id=NEW.publication_id AND pg.scope_key=NEW.scope_key AND pg.circle_id=NEW.circle_id AND pg.cycle_key=NEW.cycle_key AND pg.member_count=NEW.group_member_count AND pg.user_a_id=NEW.group_user_a_id AND pg.user_b_id IS NEW.group_user_b_id AND pg.is_solo=NEW.group_is_solo) BEGIN SELECT RAISE(ABORT,'invalid circle workspace ownership chain'); END"
  },
  {
    "operation": "ensure-trigger",
    "name": "circle_pair_messages_chain_update_guard",
    "table": "circle_pair_messages",
    "sql": "CREATE TRIGGER IF NOT EXISTS circle_pair_messages_chain_update_guard BEFORE UPDATE ON circle_pair_messages WHEN NOT EXISTS (SELECT 1 FROM circle_pairing_groups pg WHERE pg.id=NEW.group_id AND pg.publication_id=NEW.publication_id AND pg.scope_key=NEW.scope_key AND pg.circle_id=NEW.circle_id AND pg.cycle_key=NEW.cycle_key AND pg.member_count=NEW.group_member_count AND pg.user_a_id=NEW.group_user_a_id AND pg.user_b_id IS NEW.group_user_b_id AND pg.is_solo=NEW.group_is_solo) BEGIN SELECT RAISE(ABORT,'invalid circle workspace ownership chain'); END"
  },
  {
    "operation": "ensure-trigger",
    "name": "circle_session_runs_chain_insert_guard",
    "table": "circle_session_runs",
    "sql": "CREATE TRIGGER IF NOT EXISTS circle_session_runs_chain_insert_guard BEFORE INSERT ON circle_session_runs WHEN NOT EXISTS (SELECT 1 FROM circle_pairing_groups pg WHERE pg.id=NEW.group_id AND pg.publication_id=NEW.publication_id AND pg.scope_key=NEW.scope_key AND pg.circle_id=NEW.circle_id AND pg.cycle_key=NEW.cycle_key AND pg.member_count=NEW.group_member_count AND pg.user_a_id=NEW.group_user_a_id AND pg.user_b_id IS NEW.group_user_b_id AND pg.is_solo=NEW.group_is_solo) BEGIN SELECT RAISE(ABORT,'invalid circle workspace ownership chain'); END"
  },
  {
    "operation": "ensure-trigger",
    "name": "circle_session_runs_chain_update_guard",
    "table": "circle_session_runs",
    "sql": "CREATE TRIGGER IF NOT EXISTS circle_session_runs_chain_update_guard BEFORE UPDATE ON circle_session_runs WHEN NOT EXISTS (SELECT 1 FROM circle_pairing_groups pg WHERE pg.id=NEW.group_id AND pg.publication_id=NEW.publication_id AND pg.scope_key=NEW.scope_key AND pg.circle_id=NEW.circle_id AND pg.cycle_key=NEW.cycle_key AND pg.member_count=NEW.group_member_count AND pg.user_a_id=NEW.group_user_a_id AND pg.user_b_id IS NEW.group_user_b_id AND pg.is_solo=NEW.group_is_solo) BEGIN SELECT RAISE(ABORT,'invalid circle workspace ownership chain'); END"
  },
  {
    "operation": "ensure-trigger",
    "name": "circle_pair_room_snapshots_chain_insert_guard",
    "table": "circle_pair_room_snapshots",
    "sql": "CREATE TRIGGER IF NOT EXISTS circle_pair_room_snapshots_chain_insert_guard BEFORE INSERT ON circle_pair_room_snapshots WHEN NOT EXISTS (SELECT 1 FROM circle_pairing_groups pg WHERE pg.id=NEW.group_id AND pg.publication_id=NEW.publication_id AND pg.scope_key=NEW.scope_key AND pg.circle_id=NEW.circle_id AND pg.cycle_key=NEW.cycle_key AND pg.member_count=NEW.group_member_count AND pg.user_a_id=NEW.group_user_a_id AND pg.user_b_id IS NEW.group_user_b_id AND pg.is_solo=NEW.group_is_solo) BEGIN SELECT RAISE(ABORT,'invalid circle workspace ownership chain'); END"
  },
  {
    "operation": "ensure-trigger",
    "name": "circle_pair_room_snapshots_chain_update_guard",
    "table": "circle_pair_room_snapshots",
    "sql": "CREATE TRIGGER IF NOT EXISTS circle_pair_room_snapshots_chain_update_guard BEFORE UPDATE ON circle_pair_room_snapshots WHEN NOT EXISTS (SELECT 1 FROM circle_pairing_groups pg WHERE pg.id=NEW.group_id AND pg.publication_id=NEW.publication_id AND pg.scope_key=NEW.scope_key AND pg.circle_id=NEW.circle_id AND pg.cycle_key=NEW.cycle_key AND pg.member_count=NEW.group_member_count AND pg.user_a_id=NEW.group_user_a_id AND pg.user_b_id IS NEW.group_user_b_id AND pg.is_solo=NEW.group_is_solo) BEGIN SELECT RAISE(ABORT,'invalid circle workspace ownership chain'); END"
  },
  {
    "operation": "ensure-trigger",
    "name": "circle_pair_code_documents_chain_insert_guard",
    "table": "circle_pair_code_documents",
    "sql": "CREATE TRIGGER IF NOT EXISTS circle_pair_code_documents_chain_insert_guard BEFORE INSERT ON circle_pair_code_documents WHEN NOT EXISTS (SELECT 1 FROM circle_pairing_groups pg WHERE pg.id=NEW.group_id AND pg.publication_id=NEW.publication_id AND pg.scope_key=NEW.scope_key AND pg.circle_id=NEW.circle_id AND pg.cycle_key=NEW.cycle_key AND pg.member_count=NEW.group_member_count AND pg.user_a_id=NEW.group_user_a_id AND pg.user_b_id IS NEW.group_user_b_id AND pg.is_solo=NEW.group_is_solo) BEGIN SELECT RAISE(ABORT,'invalid circle workspace ownership chain'); END"
  },
  {
    "operation": "ensure-trigger",
    "name": "circle_pair_code_documents_chain_update_guard",
    "table": "circle_pair_code_documents",
    "sql": "CREATE TRIGGER IF NOT EXISTS circle_pair_code_documents_chain_update_guard BEFORE UPDATE ON circle_pair_code_documents WHEN NOT EXISTS (SELECT 1 FROM circle_pairing_groups pg WHERE pg.id=NEW.group_id AND pg.publication_id=NEW.publication_id AND pg.scope_key=NEW.scope_key AND pg.circle_id=NEW.circle_id AND pg.cycle_key=NEW.cycle_key AND pg.member_count=NEW.group_member_count AND pg.user_a_id=NEW.group_user_a_id AND pg.user_b_id IS NEW.group_user_b_id AND pg.is_solo=NEW.group_is_solo) BEGIN SELECT RAISE(ABORT,'invalid circle workspace ownership chain'); END"
  },
  {
    "operation": "ensure-trigger",
    "name": "circle_session_completion_receipts_chain_insert_guard",
    "table": "circle_session_completion_receipts",
    "sql": "CREATE TRIGGER IF NOT EXISTS circle_session_completion_receipts_chain_insert_guard BEFORE INSERT ON circle_session_completion_receipts WHEN NOT EXISTS (SELECT 1 FROM circle_pairing_groups pg WHERE pg.id=NEW.group_id AND pg.publication_id=NEW.publication_id AND pg.scope_key=NEW.scope_key AND pg.circle_id=NEW.circle_id AND pg.cycle_key=NEW.cycle_key AND pg.member_count=NEW.group_member_count AND pg.user_a_id=NEW.group_user_a_id AND pg.user_b_id IS NEW.group_user_b_id AND pg.is_solo=NEW.group_is_solo) BEGIN SELECT RAISE(ABORT,'invalid circle workspace ownership chain'); END"
  },
  {
    "operation": "ensure-trigger",
    "name": "circle_session_completion_receipts_chain_update_guard",
    "table": "circle_session_completion_receipts",
    "sql": "CREATE TRIGGER IF NOT EXISTS circle_session_completion_receipts_chain_update_guard BEFORE UPDATE ON circle_session_completion_receipts WHEN NOT EXISTS (SELECT 1 FROM circle_pairing_groups pg WHERE pg.id=NEW.group_id AND pg.publication_id=NEW.publication_id AND pg.scope_key=NEW.scope_key AND pg.circle_id=NEW.circle_id AND pg.cycle_key=NEW.cycle_key AND pg.member_count=NEW.group_member_count AND pg.user_a_id=NEW.group_user_a_id AND pg.user_b_id IS NEW.group_user_b_id AND pg.is_solo=NEW.group_is_solo) BEGIN SELECT RAISE(ABORT,'invalid circle workspace ownership chain'); END"
  },
  {
    "operation": "ensure-trigger",
    "name": "circle_pair_session_controls_chain_insert_guard",
    "table": "circle_pair_session_controls",
    "sql": "CREATE TRIGGER IF NOT EXISTS circle_pair_session_controls_chain_insert_guard BEFORE INSERT ON circle_pair_session_controls WHEN NOT EXISTS (SELECT 1 FROM circle_pairing_groups pg WHERE pg.id=NEW.group_id AND pg.publication_id=NEW.publication_id AND pg.scope_key=NEW.scope_key AND pg.circle_id=NEW.circle_id AND pg.cycle_key=NEW.cycle_key AND pg.member_count=NEW.group_member_count AND pg.user_a_id=NEW.group_user_a_id AND pg.user_b_id IS NEW.group_user_b_id AND pg.is_solo=NEW.group_is_solo) BEGIN SELECT RAISE(ABORT,'invalid circle workspace ownership chain'); END"
  },
  {
    "operation": "ensure-trigger",
    "name": "circle_pair_session_controls_chain_update_guard",
    "table": "circle_pair_session_controls",
    "sql": "CREATE TRIGGER IF NOT EXISTS circle_pair_session_controls_chain_update_guard BEFORE UPDATE ON circle_pair_session_controls WHEN NOT EXISTS (SELECT 1 FROM circle_pairing_groups pg WHERE pg.id=NEW.group_id AND pg.publication_id=NEW.publication_id AND pg.scope_key=NEW.scope_key AND pg.circle_id=NEW.circle_id AND pg.cycle_key=NEW.cycle_key AND pg.member_count=NEW.group_member_count AND pg.user_a_id=NEW.group_user_a_id AND pg.user_b_id IS NEW.group_user_b_id AND pg.is_solo=NEW.group_is_solo) BEGIN SELECT RAISE(ABORT,'invalid circle workspace ownership chain'); END"
  },
  {
    "operation": "ensure-trigger",
    "name": "circle_pair_meeting_links_chain_insert_guard",
    "table": "circle_pair_meeting_links",
    "sql": "CREATE TRIGGER IF NOT EXISTS circle_pair_meeting_links_chain_insert_guard BEFORE INSERT ON circle_pair_meeting_links WHEN NOT EXISTS (SELECT 1 FROM circle_pairing_groups pg WHERE pg.id=NEW.group_id AND pg.publication_id=NEW.publication_id AND pg.scope_key=NEW.scope_key AND pg.circle_id=NEW.circle_id AND pg.cycle_key=NEW.cycle_key AND pg.member_count=NEW.group_member_count AND pg.user_a_id=NEW.group_user_a_id AND pg.user_b_id IS NEW.group_user_b_id AND pg.is_solo=NEW.group_is_solo) BEGIN SELECT RAISE(ABORT,'invalid circle workspace ownership chain'); END"
  },
  {
    "operation": "ensure-trigger",
    "name": "circle_pair_meeting_links_chain_update_guard",
    "table": "circle_pair_meeting_links",
    "sql": "CREATE TRIGGER IF NOT EXISTS circle_pair_meeting_links_chain_update_guard BEFORE UPDATE ON circle_pair_meeting_links WHEN NOT EXISTS (SELECT 1 FROM circle_pairing_groups pg WHERE pg.id=NEW.group_id AND pg.publication_id=NEW.publication_id AND pg.scope_key=NEW.scope_key AND pg.circle_id=NEW.circle_id AND pg.cycle_key=NEW.cycle_key AND pg.member_count=NEW.group_member_count AND pg.user_a_id=NEW.group_user_a_id AND pg.user_b_id IS NEW.group_user_b_id AND pg.is_solo=NEW.group_is_solo) BEGIN SELECT RAISE(ABORT,'invalid circle workspace ownership chain'); END"
  },
  {
    "operation": "ensure-trigger",
    "name": "circle_video_signals_chain_insert_guard",
    "table": "circle_video_signals",
    "sql": "CREATE TRIGGER IF NOT EXISTS circle_video_signals_chain_insert_guard BEFORE INSERT ON circle_video_signals WHEN NOT EXISTS (SELECT 1 FROM circle_pairing_groups pg WHERE pg.id=NEW.group_id AND pg.publication_id=NEW.publication_id AND pg.scope_key=NEW.scope_key AND pg.circle_id=NEW.circle_id AND pg.cycle_key=NEW.cycle_key AND pg.member_count=NEW.group_member_count AND pg.user_a_id=NEW.group_user_a_id AND pg.user_b_id IS NEW.group_user_b_id AND pg.is_solo=NEW.group_is_solo) BEGIN SELECT RAISE(ABORT,'invalid circle workspace ownership chain'); END"
  },
  {
    "operation": "ensure-trigger",
    "name": "circle_video_signals_chain_update_guard",
    "table": "circle_video_signals",
    "sql": "CREATE TRIGGER IF NOT EXISTS circle_video_signals_chain_update_guard BEFORE UPDATE ON circle_video_signals WHEN NOT EXISTS (SELECT 1 FROM circle_pairing_groups pg WHERE pg.id=NEW.group_id AND pg.publication_id=NEW.publication_id AND pg.scope_key=NEW.scope_key AND pg.circle_id=NEW.circle_id AND pg.cycle_key=NEW.cycle_key AND pg.member_count=NEW.group_member_count AND pg.user_a_id=NEW.group_user_a_id AND pg.user_b_id IS NEW.group_user_b_id AND pg.is_solo=NEW.group_is_solo) BEGIN SELECT RAISE(ABORT,'invalid circle workspace ownership chain'); END"
  },
  {
    "operation": "ensure-trigger",
    "name": "circle_chat_retention_scopes_chain_insert_guard",
    "table": "circle_chat_retention_scopes",
    "sql": "CREATE TRIGGER IF NOT EXISTS circle_chat_retention_scopes_chain_insert_guard BEFORE INSERT ON circle_chat_retention_scopes WHEN NOT EXISTS (SELECT 1 FROM circle_pairing_groups pg WHERE pg.id=NEW.group_id AND pg.publication_id=NEW.publication_id AND pg.scope_key=NEW.scope_key AND pg.circle_id=NEW.circle_id AND pg.cycle_key=NEW.cycle_key AND pg.member_count=NEW.group_member_count AND pg.user_a_id=NEW.group_user_a_id AND pg.user_b_id IS NEW.group_user_b_id AND pg.is_solo=NEW.group_is_solo) BEGIN SELECT RAISE(ABORT,'invalid circle workspace ownership chain'); END"
  },
  {
    "operation": "ensure-trigger",
    "name": "circle_chat_retention_scopes_chain_update_guard",
    "table": "circle_chat_retention_scopes",
    "sql": "CREATE TRIGGER IF NOT EXISTS circle_chat_retention_scopes_chain_update_guard BEFORE UPDATE ON circle_chat_retention_scopes WHEN NOT EXISTS (SELECT 1 FROM circle_pairing_groups pg WHERE pg.id=NEW.group_id AND pg.publication_id=NEW.publication_id AND pg.scope_key=NEW.scope_key AND pg.circle_id=NEW.circle_id AND pg.cycle_key=NEW.cycle_key AND pg.member_count=NEW.group_member_count AND pg.user_a_id=NEW.group_user_a_id AND pg.user_b_id IS NEW.group_user_b_id AND pg.is_solo=NEW.group_is_solo) BEGIN SELECT RAISE(ABORT,'invalid circle workspace ownership chain'); END"
  },
  {
    "operation": "ensure-trigger",
    "name": "circle_pair_code_documents_revision_guard",
    "table": "circle_pair_code_documents",
    "sql": "CREATE TRIGGER IF NOT EXISTS circle_pair_code_documents_revision_guard BEFORE UPDATE ON circle_pair_code_documents WHEN NEW.question_slug<>OLD.question_slug OR NEW.question_version<>OLD.question_version OR NEW.language<>OLD.language OR NEW.pair_user_a_id<>OLD.pair_user_a_id OR NEW.pair_user_a_source<>OLD.pair_user_a_source OR NEW.pair_user_b_id<>OLD.pair_user_b_id OR NEW.pair_user_b_source<>OLD.pair_user_b_source OR NEW.created_at<>OLD.created_at OR NEW.revision<>OLD.revision+1 BEGIN SELECT RAISE(ABORT,'invalid circle workspace revision'); END"
  },
  {
    "operation": "ensure-trigger",
    "name": "circle_pair_session_controls_revision_guard",
    "table": "circle_pair_session_controls",
    "sql": "CREATE TRIGGER IF NOT EXISTS circle_pair_session_controls_revision_guard BEFORE UPDATE ON circle_pair_session_controls WHEN NEW.pair_user_a_id<>OLD.pair_user_a_id OR NEW.pair_user_a_source<>OLD.pair_user_a_source OR NEW.pair_user_b_id<>OLD.pair_user_b_id OR NEW.pair_user_b_source<>OLD.pair_user_b_source OR NEW.created_at<>OLD.created_at OR NEW.revision<>OLD.revision+1 BEGIN SELECT RAISE(ABORT,'invalid circle workspace revision'); END"
  },
  {
    "operation": "ensure-trigger",
    "name": "circle_pair_meeting_links_revision_guard",
    "table": "circle_pair_meeting_links",
    "sql": "CREATE TRIGGER IF NOT EXISTS circle_pair_meeting_links_revision_guard BEFORE UPDATE ON circle_pair_meeting_links WHEN NEW.accepted_schedule_at<>OLD.accepted_schedule_at OR NEW.pair_user_a_id<>OLD.pair_user_a_id OR NEW.pair_user_b_id<>OLD.pair_user_b_id OR NEW.created_at<>OLD.created_at OR NEW.revision<>OLD.revision+1 BEGIN SELECT RAISE(ABORT,'invalid circle workspace revision'); END"
  },
  {
    "operation": "ensure-index",
    "name": "uq_circle_pair_schedules_meeting_owner",
    "table": "circle_pair_schedules",
    "keyParts": [
      "publication_id",
      "scope_key",
      "circle_id",
      "cycle_key",
      "group_id",
      "agreed_time"
    ],
    "unique": true,
    "where": null,
    "sql": "CREATE UNIQUE INDEX IF NOT EXISTS uq_circle_pair_schedules_meeting_owner ON circle_pair_schedules(publication_id,scope_key,circle_id,cycle_key,group_id,agreed_time)"
  },
  {
    "operation": "ensure-trigger",
    "name": "circle_schedule_meeting_link_invalidate",
    "table": "circle_pair_schedules",
    "sql": "CREATE TRIGGER IF NOT EXISTS circle_schedule_meeting_link_invalidate BEFORE UPDATE OF agreed_time ON circle_pair_schedules WHEN NEW.agreed_time IS NOT OLD.agreed_time BEGIN DELETE FROM circle_pair_meeting_links WHERE publication_id=OLD.publication_id AND group_id=OLD.group_id AND circle_id=OLD.circle_id AND scope_key=OLD.scope_key AND cycle_key=OLD.cycle_key; END"
  }
]);
