import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  INDEXES,
  PINNED_SCHEMA_MANIFEST_CHECKSUM,
  SCHEMA_MANIFEST_CHECKSUM,
  TABLES,
  TRIGGERS,
  TOLERATED_LEGACY_TABLES,
  checksum,
  resolveCurrentArtifacts,
} from '../../db/schema-manifest.js';
import { MIGRATION_PLANS, validateMigrationPlans } from '../../db/migration-plan.js';
import { expectedColumns, parseIndexSql } from '../../db/schema-inspector.js';

test('schema manifest pins all current tables and named indexes',()=>{
  assert.deepEqual(TABLES.map(item=>item.name),[
    'users','auth_accounts','pairing_weeks','pairing_groups','pairing_participants',
    'pairing_week_runs','pairing_email_outbox','questions','custom_questions','video_signals',
    'pair_room_snapshots','pair_messages','pair_schedules','session_runs','ai_sessions','ai_feedback',
    'ai_usage','ai_account_monthly_usage','ai_account_monthly_reservations','ai_consents','app_logs',
    'user_notification_prefs','auth_rate_limits','circles','circle_memberships','circle_invitations',
    'circle_audit_events','circle_membership_rollout','pairing_cycles',
    'pairing_cycle_availability','auth_provider_identities','auth_sessions',
    'outbox_events','outbox_audit_events','auth_email_activations','auth_password_resets',
    'auth_recent_proofs','auth_provider_email_state','auth_identity_audit_events',
    'chat_retention_control','chat_retention_scopes','chat_retention_runs',
    'chat_retention_legal_holds','chat_retention_audit_events','auth_session_circle_contexts',
    'circle_pairing_publications','circle_pairing_eligibility','circle_pairing_groups',
    'circle_creation_requests','credential_key_controls','circle_pair_schedules',
    'circle_pair_schedule_proposals','session_completion_receipts','pair_meeting_links',
    'pair_session_controls',
  ]);
  assert.deepEqual(INDEXES.map(item=>item.name),[
    'idx_video_signals_room','idx_video_signals_room_id','idx_pair_messages_pair','idx_pair_sched_pair',
    'uq_pair_schedules_week_pair','idx_cq_slug','idx_cq_author','idx_runs_user','idx_runs_question',
    'idx_runs_user_q','idx_runs_pair_activity','idx_messages_pair_activity',
    'idx_pair_room_snapshots_updated_at','idx_logs_level_created','idx_logs_event_created',
    'idx_logs_source_created','idx_logs_created','idx_pairing_email_outbox_pending',
    'idx_pairing_weeks_week_label','uq_auth_accounts_google_sub','uq_circles_active_primary',
    'idx_circle_memberships_user_active','idx_circle_memberships_circle_active',
    'idx_circle_invitations_circle_created','idx_circle_invitations_email',
    'idx_circle_audit_circle_created','idx_pairing_cycle_availability_candidates',
    'idx_auth_sessions_user_active','idx_outbox_events_dispatch','idx_outbox_events_lease',
    'idx_outbox_audit_event','idx_auth_email_activations_token','idx_auth_email_activations_email',
    'idx_auth_password_resets_token','idx_auth_password_resets_email','idx_auth_recent_proofs_user',
    'idx_auth_identity_audit_user','idx_auth_identity_audit_actor',
    'idx_pair_messages_room_cursor','idx_pair_messages_sender_created',
    'idx_chat_retention_runs_dispatch','idx_chat_retention_scopes_tenant',
    'idx_chat_retention_runs_scope','idx_chat_retention_audit_run','idx_pair_messages_retention',
    'uq_auth_sessions_hash_user','idx_auth_session_circle_contexts_user_circle',
    'uq_pairing_cycles_descriptor',
    'idx_circle_pairing_publications_circle_cycle','idx_circle_pairing_eligibility_scope_user',
    'idx_circle_pairing_groups_user_a','idx_circle_pairing_groups_user_b',
    'uq_circle_audit_events_id_circle','idx_circle_creation_requests_circle',
    'uq_circle_pairing_groups_schedule_owner','idx_circle_pair_schedule_proposals_schedule',
    'uq_pairing_groups_completion_pair','uq_pairing_groups_completion_third',
    'uq_pairing_participants_completion_owner',
    'idx_session_completion_receipts_user','uq_pair_schedules_meeting_agreement',
    'idx_pair_meeting_links_updated_by','idx_pair_session_controls_updated_by',
  ]);
  assert.deepEqual(TRIGGERS.map(item=>item.name),[
    'trg_session_completion_receipts_insert_guard',
    'trg_session_completion_receipts_update_guard',
    'trg_pairing_groups_completion_membership_guard',
    'trg_pairing_participants_completion_update_guard',
    'trg_pairing_participants_completion_delete_guard',
    'trg_pairing_participants_completion_insert_guard',
    'trg_pair_schedules_meeting_link_invalidate',
    'trg_pair_meeting_links_insert_guard','trg_pair_meeting_links_update_guard',
    'trg_pairing_groups_meeting_link_guard',
    'trg_pairing_participants_meeting_link_update_guard',
    'trg_pairing_participants_meeting_link_delete_guard',
    'trg_pair_session_controls_insert_guard','trg_pair_session_controls_update_guard',
    'trg_pairing_groups_session_controls_invalidate',
    'trg_pairing_participants_session_controls_update_invalidate',
    'trg_pairing_participants_session_controls_delete_invalidate',
  ]);
  assert.equal(new Set(TABLES.map(item=>item.name)).size,TABLES.length);
  assert.equal(new Set(INDEXES.map(item=>item.name)).size,INDEXES.length);
  assert.equal(new Set(TRIGGERS.map(item=>item.name)).size,TRIGGERS.length);
  assert.equal(SCHEMA_MANIFEST_CHECKSUM,PINNED_SCHEMA_MANIFEST_CHECKSUM);
  assert.deepEqual(TOLERATED_LEGACY_TABLES,['ai_monthly_usage','schema_migrations']);
  assert.ok(TABLES.some(item=>item.name==='circle_invitations'));
  assert.ok(TABLES.some(item=>item.name==='ai_account_monthly_usage'));
  assert.ok(!TABLES.some(item=>item.name==='ai_monthly_usage'));
});

test('immutable migration metadata is contiguous and checksum protected',()=>{
  assert.equal(validateMigrationPlans(),true);
  assert.deepEqual(MIGRATION_PLANS.map(plan=>plan.version),[1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,17,18,19]);
  assert.deepEqual(MIGRATION_PLANS.slice(0,2).map(plan=>({
    version:plan.version,operationsChecksum:plan.operationsChecksum,checksum:plan.checksum,
  })),[{
    version:1,
    operationsChecksum:'2291bdea8c396ce13b3760c15e81b42f027e40cf3d4748400b208f3b06834cdf',
    checksum:'f5d7b032abc2848fe63fbcc14264f210e488c7b9b9fd33b073affb191dca085a',
  },{
    version:2,
    operationsChecksum:'896b4f35344c19a0c70ef091d95a0b50af36d66259893ef6a0b0782c8b8d574a',
    checksum:'ceb0f119d72971762c5c1d9c93e6000386fc90fe43bbf0a9713f326932059d28',
  }]);
  assert.deepEqual(MIGRATION_PLANS[2].operations.map(operation=>`${operation.operation}:${operation.name}`),[
    'ensure-table:pairing_cycles',
    'ensure-table:pairing_cycle_availability',
    'ensure-index:idx_pairing_cycle_availability_candidates',
  ]);
  assert.deepEqual(MIGRATION_PLANS[3].operations.map(operation=>`${operation.operation}:${operation.name}`),[
    'ensure-table:auth_provider_identities',
  ]);
  assert.ok(MIGRATION_PLANS.every(plan=>/^[a-f0-9]{64}$/.test(plan.operationsChecksum)));
  assert.ok(MIGRATION_PLANS.flatMap(plan=>plan.operations).every(operation=>{
    return typeof operation.sql==='string'&&/^CREATE\s+(?:UNIQUE\s+)?(?:TABLE|INDEX|TRIGGER)/i.test(operation.sql);
  }));
  const changed=MIGRATION_PLANS.map(plan=>({...plan,operations:plan.operations.map(operation=>({...operation}))}));
  changed[0].operations[0].sql+=' -- silently changed';
  assert.throws(()=>validateMigrationPlans(changed),/operations checksum does not match/);
  const gap=MIGRATION_PLANS.map(plan=>({...plan}));
  gap[1].version=3;
  assert.throws(()=>validateMigrationPlans(gap),/gap at version 2/);
});

test('secondary rollout preserves v15 control adoption before separate v16 scheduling',()=>{
  const decisions=readFileSync(new URL('../../docs/IMPLEMENTED_DECISIONS.md',import.meta.url),'utf8');
  const section=decisions.match(/## ID-26:[\s\S]*?(?=\n## ID-27:)/)?.[0]||'';
  const scheduling=decisions.match(/## ID-33:[\s\S]*$/)?.[0]||'';
  const activeContext=readFileSync(new URL('../../docs/ACTIVE_CIRCLE_CONTEXT.md',import.meta.url),'utf8');
  assert.match(section,
    /apply managed v13, then v14, then v15 as separate protected migration\s+steps with fresh evidence and approval/);
  assert.match(section,
    /adopt all four configured credential\s+purposes, then use a new rehearsal/);
  assert.match(section,
    /new rehearsal, status artifact, and approval to apply v16\s+separately/);
  assert.match(section,/exact runtime readiness through v16/);
  assert.match(section,
    /Keep its separate email flag false until the sender\s+passes a provider canary/);
  assert.match(scheduling,/Apply v16 alone through the protected one-version\s+workflow after v15/);
  assert.match(activeContext,/separately approve and apply only v16/);
  assert.match(activeContext,
    /Deploy the v16-aware runtime with\s+`SECONDARY_CIRCLE_SCHEDULING_ENABLED=false`/);
});

test('circle creation rollout requires v15 control adoption and current v16 readiness',()=>{
  const decisions=readFileSync(new URL('../../docs/IMPLEMENTED_DECISIONS.md',import.meta.url),'utf8');
  const section=decisions.match(/## ID-29:[\s\S]*?(?=\n## ID-30:)/)?.[0]||'';
  const runbook=readFileSync(new URL('../../docs/CIRCLE_CREATION.md',import.meta.url),'utf8');
  const pairingRunbook=readFileSync(new URL('../../docs/SELECTED_CIRCLE_PAIRING.md',import.meta.url),'utf8');
  assert.match(section,
    /apply each pending v13, v14, and v15 migration separately with a fresh protected\s+rehearsal and approval/);
  assert.match(section,
    /adopt all four configured credential purposes before\s+continuing/);
  assert.match(section,
    /If an existing credential consumer cannot be disabled, hold\s+production promotion/);
  assert.match(section,
    /new rehearsal, status\s+artifact, and approval to apply v16 separately/);
  assert.match(section,/verify exact readiness through\s+v16/);
  assert.match(runbook,/exact managed readiness through v16/);
  assert.match(runbook,
    /credential\s+purposes, and a new rehearsal plus separate v16 apply before runtime\s+promotion/);
  assert.match(pairingRunbook,/Use Steps 2–5/);
  assert.match(pairingRunbook,
    /new rehearsal, status artifact, approval, and\s+separate v16 apply/);
  assert.match(pairingRunbook,/complete managed\s+ledger through v16/);
});

test('provider identities add issuer-scoped subject and account uniqueness without rewriting the baseline',()=>{
  const baseAuth=MIGRATION_PLANS[0].operations.find(item=>item.name==='auth_accounts');
  const membershipAuth=MIGRATION_PLANS[1].operations.find(item=>item.name==='auth_accounts');
  const providerIdentities=MIGRATION_PLANS[3].operations.find(item=>item.name==='auth_provider_identities');
  assert.ok(baseAuth);
  assert.match(baseAuth.sql,/\bgoogle_sub\b/);
  assert.equal(membershipAuth,undefined);
  assert.ok(MIGRATION_PLANS[1].operations.some(item=>item.name==='uq_auth_accounts_google_sub'));
  assert.equal(TABLES.find(item=>item.name==='auth_accounts').sql,baseAuth.sql);
  assert.match(providerIdentities.sql,/PRIMARY KEY\(issuer,subject\)/);
  assert.match(providerIdentities.sql,/UNIQUE\(issuer,user_id\)/);
  assert.match(providerIdentities.sql,/issuer='https:\/\/accounts\.google\.com'/);
});

test('durable sessions pin hashed identifiers, bounded timestamps, and account-scoped lookup',()=>{
  const sessions=MIGRATION_PLANS[4].operations.find(item=>item.name==='auth_sessions');
  const activeIndex=MIGRATION_PLANS[4].operations.find(item=>item.name==='idx_auth_sessions_user_active');
  assert.ok(sessions);
  assert.match(sessions.sql,/session_hash TEXT PRIMARY KEY NOT NULL/);
  assert.match(sessions.sql,/length\(session_hash\)=64/);
  assert.match(sessions.sql,/expires_at>created_at/);
  assert.match(sessions.sql,/FOREIGN KEY\(user_id\) REFERENCES auth_accounts\(id\) ON DELETE CASCADE/);
  assert.deepEqual(activeIndex.keyParts,['user_id','revoked_at','expires_at']);
});

test('durable outbox pins versioned events, leases, replay audit, and dispatch indexes',()=>{
  const events=MIGRATION_PLANS[5].operations.find(item=>item.name==='outbox_events');
  const audit=MIGRATION_PLANS[5].operations.find(item=>item.name==='outbox_audit_events');
  assert.match(events.sql,/idempotency_key TEXT NOT NULL UNIQUE/);
  assert.match(events.sql,/claim_from_status TEXT/);
  assert.match(events.sql,/status IN \('pending','processing','retry','delivered','suppressed','dead_letter'\)/);
  assert.match(audit.sql,/FOREIGN KEY\(outbox_event_id\) REFERENCES outbox_events\(id\) ON DELETE RESTRICT/);
  assert.deepEqual(MIGRATION_PLANS[5].indexes,[
    'idx_outbox_events_dispatch','idx_outbox_events_lease','idx_outbox_audit_event',
  ]);
});

test('verified activation pins hashed one-time credentials and bounded resend state',()=>{
  const activation=MIGRATION_PLANS[6].operations.find(item=>item.name==='auth_email_activations');
  assert.match(activation.sql,/token_hash TEXT NOT NULL UNIQUE/);
  assert.match(activation.sql,/send_count BETWEEN 1 AND 5/);
  assert.match(activation.sql,/FOREIGN KEY\(invitation_id\) REFERENCES circle_invitations\(id\) ON DELETE RESTRICT/);
  assert.deepEqual(MIGRATION_PLANS[6].indexes,[
    'idx_auth_email_activations_token','idx_auth_email_activations_email',
  ]);
});

test('password recovery and recent authentication are durable and session scoped',()=>{
  const reset=MIGRATION_PLANS[7].operations.find(item=>item.name==='auth_password_resets');
  const recent=MIGRATION_PLANS[7].operations.find(item=>item.name==='auth_recent_proofs');
  assert.match(reset.sql,/token_hash TEXT NOT NULL UNIQUE/);
  assert.match(reset.sql,/user_id INTEGER NOT NULL UNIQUE/);
  assert.match(reset.sql,/send_count BETWEEN 1 AND 5/);
  assert.match(recent.sql,/session_hash TEXT PRIMARY KEY NOT NULL/);
  assert.match(recent.sql,/method IN \('password','google'\)/);
  assert.match(recent.sql,/REFERENCES auth_sessions\(session_hash\) ON DELETE CASCADE/);
  assert.deepEqual(MIGRATION_PLANS[7].indexes,[
    'idx_auth_password_resets_token','idx_auth_password_resets_email','idx_auth_recent_proofs_user',
  ]);
});

test('credential key controls pin the four supported purposes and monotonic accepted state',()=>{
  const control=MIGRATION_PLANS[14].operations.find(item=>item.name==='credential_key_controls');
  assert.ok(control);
  assert.match(control.sql,/purpose TEXT PRIMARY KEY NOT NULL/);
  assert.match(control.sql,/email-activation/);
  assert.match(control.sql,/password-reset/);
  assert.match(control.sql,/invitation-email/);
  assert.match(control.sql,/identity-email-observation/);
  assert.match(control.sql,/state IN \('uninitialized','accepted'\)/);
  assert.match(control.sql,/installed_by_migration=15/);
});

test('current-artifact resolution preserves order and uses the latest pairing-weeks definition',()=>{
  const original=`CREATE TABLE IF NOT EXISTS pairing_weeks (id INTEGER PRIMARY KEY AUTOINCREMENT, week_label TEXT NOT NULL, week_start TEXT NOT NULL, focus TEXT NOT NULL DEFAULT 'both', created_at TEXT DEFAULT (datetime('now')))`;
  const replacement=`CREATE TABLE IF NOT EXISTS pairing_weeks (id INTEGER PRIMARY KEY AUTOINCREMENT, week_label TEXT NOT NULL, week_start TEXT NOT NULL, focus TEXT NOT NULL DEFAULT 'both', created_at TEXT DEFAULT (datetime('now')), is_demo INTEGER DEFAULT 0)`;
  const users=`CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, color TEXT NOT NULL)`;
  const resolved=resolveCurrentArtifacts([{
    operations:[
      {operation:'ensure-table',name:'pairing_weeks',sql:original},
      {operation:'ensure-table',name:'users',sql:users},
    ],
  },{
    operations:[{operation:'ensure-table',name:'pairing_weeks',sql:replacement}],
  }],'ensure-table');
  assert.deepEqual(resolved,[
    {name:'pairing_weeks',sql:replacement},
    {name:'users',sql:users},
  ]);
  assert.ok(Object.isFrozen(resolved));
  assert.ok(resolved.every(Object.isFrozen));
});

test('migration metadata covers every artifact and supports append-only replacements',()=>{
  const repin=plan=>{
    const operationsChecksum=checksum(plan.operations);
    const tables=plan.operations.filter(item=>item.operation==='ensure-table').map(item=>item.name);
    const indexes=plan.operations.filter(item=>item.operation==='ensure-index').map(item=>item.name);
    const metadata={version:plan.version,name:plan.name,description:plan.description,operationsChecksum,operations:plan.operations,tables,indexes};
    const triggers=plan.operations.filter(item=>item.operation==='ensure-trigger').map(item=>item.name);
    if(triggers.length) metadata.triggers=triggers;
    return {...metadata,checksum:checksum(metadata)};
  };
  const missing=MIGRATION_PLANS.map(plan=>({...plan,operations:[...plan.operations]}));
  missing[0].operations=missing[0].operations.filter(operation=>!(operation.operation==='ensure-table'&&operation.name==='users'));
  assert.throws(()=>validateMigrationPlans(missing.map(repin)),/do not cover current manifest tables/);
  const duplicate=MIGRATION_PLANS.map(plan=>({...plan,operations:[...plan.operations]}));
  duplicate[1].operations.push(duplicate[1].operations[0]);
  assert.throws(()=>validateMigrationPlans(duplicate.map(repin)),/repeats canonical operations/);

  const unsupported=repin({
    version:20,name:'unsupported-operation',description:'Invalid operation example.',
    operations:[{operation:'drop-table',name:'users',sql:'DROP TABLE users'}],
  });
  assert.throws(()=>validateMigrationPlans([...MIGRATION_PLANS,unsupported]),/unsupported operation/);

  const mislabeled=repin({
    version:20,name:'mislabeled-table',description:'Invalid table example.',
    operations:[{operation:'ensure-table',name:'users',sql:'DROP TABLE users'}],
  });
  assert.throws(()=>validateMigrationPlans([...MIGRATION_PLANS,mislabeled]),/non-canonical CREATE TABLE/);

  const multipleStatements=repin({
    version:20,name:'multiple-statements',description:'Invalid SQL example.',
    operations:[{operation:'ensure-table',name:'users',sql:'CREATE TABLE users (id INTEGER); DROP TABLE auth_accounts'}],
  });
  assert.throws(()=>validateMigrationPlans([...MIGRATION_PLANS,multipleStatements]),/invalid ensure-table definition/);

  const danglingIndex=repin({
    version:20,name:'dangling-index',description:'Invalid index example.',
    operations:[{
      operation:'ensure-index',name:'idx_video_signals_room',table:'missing_table',
      keyParts:['room_id'],unique:false,where:null,
      sql:'CREATE INDEX IF NOT EXISTS idx_video_signals_room ON missing_table(room_id)',
    }],
  });
  assert.throws(()=>validateMigrationPlans([...MIGRATION_PLANS,danglingIndex]),/references unknown table/);

  const replacement={...MIGRATION_PLANS[0].operations.find(operation=>operation.name==='users'),sql:'CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT NOT NULL)'};
  const appended=repin({version:20,name:'future-users-contract',description:'Future replacement example.',operations:[replacement]});
  assert.equal(validateMigrationPlans([...MIGRATION_PLANS,appended]),true);
});

test('table contracts expose column defaults and composite primary keys',()=>{
  const account=expectedColumns(TABLES.find(item=>item.name==='auth_accounts'));
  assert.deepEqual(account.find(item=>item.name==='interview_focus'),{
    name:'interview_focus',type:'TEXT',notNull:false,primaryKeyPosition:0,defaultValue:"'both'",hidden:0,
  });
  const usage=expectedColumns(TABLES.find(item=>item.name==='ai_account_monthly_usage'));
  assert.equal(usage.find(item=>item.name==='month').primaryKeyPosition,1);
  assert.equal(usage.find(item=>item.name==='user_id').primaryKeyPosition,2);
  const cycles=expectedColumns(TABLES.find(item=>item.name==='pairing_cycles'));
  assert.equal(cycles.find(item=>item.name==='scope_key').primaryKeyPosition,1);
  assert.equal(cycles.find(item=>item.name==='cycle_key').primaryKeyPosition,2);
  const availability=expectedColumns(TABLES.find(item=>item.name==='pairing_cycle_availability'));
  assert.equal(availability.find(item=>item.name==='scope_key').primaryKeyPosition,1);
  assert.equal(availability.find(item=>item.name==='cycle_key').primaryKeyPosition,2);
  assert.equal(availability.find(item=>item.name==='user_id').primaryKeyPosition,3);
});

test('index parser preserves unique, partial, expression, and sort semantics',()=>{
  const partial=parseIndexSql('CREATE UNIQUE INDEX uq_example ON accounts(subject) WHERE subject IS NOT NULL');
  assert.deepEqual(partial,{unique:true,table:'accounts',keyParts:['subject'],where:'subject is not null'});
  const expression=parseIndexSql('CREATE INDEX IF NOT EXISTS idx_activity ON events(room_id, julianday(created_at) DESC, id DESC)');
  assert.deepEqual(expression,{
    unique:false,
    table:'events',
    keyParts:['room_id','julianday(created_at)desc','id desc'],
    where:null,
  });
  assert.equal(parseIndexSql('not an index'),null);
});
