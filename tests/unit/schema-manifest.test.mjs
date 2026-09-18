import test from 'node:test';
import assert from 'node:assert/strict';
import {
  INDEXES,
  PINNED_SCHEMA_MANIFEST_CHECKSUM,
  SCHEMA_MANIFEST_CHECKSUM,
  TABLES,
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
    'circle_audit_events','circle_membership_rollout',
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
    'idx_circle_audit_circle_created',
  ]);
  assert.equal(new Set(TABLES.map(item=>item.name)).size,TABLES.length);
  assert.equal(new Set(INDEXES.map(item=>item.name)).size,INDEXES.length);
  assert.equal(SCHEMA_MANIFEST_CHECKSUM,PINNED_SCHEMA_MANIFEST_CHECKSUM);
  assert.deepEqual(TOLERATED_LEGACY_TABLES,['ai_monthly_usage','schema_migrations']);
  assert.ok(TABLES.some(item=>item.name==='circle_invitations'));
  assert.ok(TABLES.some(item=>item.name==='ai_account_monthly_usage'));
  assert.ok(!TABLES.some(item=>item.name==='ai_monthly_usage'));
});

test('immutable migration metadata is contiguous and checksum protected',()=>{
  assert.equal(validateMigrationPlans(),true);
  assert.deepEqual(MIGRATION_PLANS.map(plan=>plan.version),[1,2]);
  assert.ok(MIGRATION_PLANS.every(plan=>/^[a-f0-9]{64}$/.test(plan.operationsChecksum)));
  assert.ok(MIGRATION_PLANS.flatMap(plan=>plan.operations).every(operation=>{
    return typeof operation.sql==='string'&&/^CREATE\s+(?:UNIQUE\s+)?(?:TABLE|INDEX)/i.test(operation.sql);
  }));
  const changed=MIGRATION_PLANS.map(plan=>({...plan,operations:plan.operations.map(operation=>({...operation}))}));
  changed[0].operations[0].sql+=' -- silently changed';
  assert.throws(()=>validateMigrationPlans(changed),/operations checksum does not match/);
  const gap=MIGRATION_PLANS.map(plan=>({...plan}));
  gap[1].version=3;
  assert.throws(()=>validateMigrationPlans(gap),/gap at version 2/);
});

test('baseline owns Google subjects while membership adds their uniqueness index',()=>{
  const baseAuth=MIGRATION_PLANS[0].operations.find(item=>item.name==='auth_accounts');
  const membershipAuth=MIGRATION_PLANS[1].operations.find(item=>item.name==='auth_accounts');
  assert.ok(baseAuth);
  assert.match(baseAuth.sql,/\bgoogle_sub\b/);
  assert.equal(membershipAuth,undefined);
  assert.ok(MIGRATION_PLANS[1].operations.some(item=>item.name==='uq_auth_accounts_google_sub'));
  assert.equal(TABLES.find(item=>item.name==='auth_accounts').sql,baseAuth.sql);
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
    return {...metadata,checksum:checksum(metadata)};
  };
  const missing=MIGRATION_PLANS.map(plan=>({...plan,operations:[...plan.operations]}));
  missing[0].operations=missing[0].operations.filter(operation=>!(operation.operation==='ensure-table'&&operation.name==='users'));
  assert.throws(()=>validateMigrationPlans(missing.map(repin)),/do not cover current manifest tables/);
  const duplicate=MIGRATION_PLANS.map(plan=>({...plan,operations:[...plan.operations]}));
  duplicate[1].operations.push(duplicate[1].operations[0]);
  assert.throws(()=>validateMigrationPlans(duplicate.map(repin)),/repeats canonical operations/);

  const unsupported=repin({
    version:3,name:'unsupported-operation',description:'Invalid operation example.',
    operations:[{operation:'drop-table',name:'users',sql:'DROP TABLE users'}],
  });
  assert.throws(()=>validateMigrationPlans([...MIGRATION_PLANS,unsupported]),/unsupported operation/);

  const mislabeled=repin({
    version:3,name:'mislabeled-table',description:'Invalid table example.',
    operations:[{operation:'ensure-table',name:'users',sql:'DROP TABLE users'}],
  });
  assert.throws(()=>validateMigrationPlans([...MIGRATION_PLANS,mislabeled]),/non-canonical CREATE TABLE/);

  const multipleStatements=repin({
    version:3,name:'multiple-statements',description:'Invalid SQL example.',
    operations:[{operation:'ensure-table',name:'users',sql:'CREATE TABLE users (id INTEGER); DROP TABLE auth_accounts'}],
  });
  assert.throws(()=>validateMigrationPlans([...MIGRATION_PLANS,multipleStatements]),/invalid ensure-table definition/);

  const danglingIndex=repin({
    version:3,name:'dangling-index',description:'Invalid index example.',
    operations:[{
      operation:'ensure-index',name:'idx_video_signals_room',table:'missing_table',
      keyParts:['room_id'],unique:false,where:null,
      sql:'CREATE INDEX IF NOT EXISTS idx_video_signals_room ON missing_table(room_id)',
    }],
  });
  assert.throws(()=>validateMigrationPlans([...MIGRATION_PLANS,danglingIndex]),/references unknown table/);

  const replacement={...MIGRATION_PLANS[0].operations.find(operation=>operation.name==='users'),sql:'CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT NOT NULL)'};
  const appended=repin({version:3,name:'future-users-contract',description:'Future replacement example.',operations:[replacement]});
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
