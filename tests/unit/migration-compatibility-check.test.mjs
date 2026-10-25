// The migration check (ID-87, #371): a migration declared 'additive' must
// really be additive, or the readiness tolerance would let code run against a
// schema it changes. Synthetic migration 22 cases are appended to the real
// executable migrations, so "existing" means the real current schema.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { inspectMigrationReleaseContract } from '../../scripts/check-deployability.mjs';
import { EXECUTABLE_MIGRATIONS, validateExecutableMigrations } from '../../db/executable-migrations.js';
import {
  additiveViolations,
  assertMigrationCompatibility,
  formatCompatibilityViolation,
  inspectMigrationCompatibility,
  normalizeMigrationSql,
} from '../../db/migration-compatibility-check.js';
import { MIGRATION_CONTRACTS, validateMigrationContracts } from '../../db/migration-contract.js';

const HEX='b'.repeat(64);

const table=(name,sql)=>({operation:'ensure-table',name,sql});
const index=(name,tableName,sql)=>({operation:'ensure-index',name,table:tableName,sql});
const trigger=(name,tableName,sql)=>({operation:'ensure-trigger',name,table:tableName,sql});
const row=(name,tableName,sql)=>({operation:'ensure-row',name,table:tableName,sql});

const FEEDBACK=table('feedback_items',`CREATE TABLE IF NOT EXISTS feedback_items (id TEXT PRIMARY KEY, author_user_id INTEGER NOT NULL, kind TEXT NOT NULL CHECK(kind IN ('bug','feature_request','feedback')), body TEXT NOT NULL CHECK(body <> 'DROP TABLE auth_accounts; DELETE FROM users'), created_at TEXT NOT NULL DEFAULT (datetime('now')), FOREIGN KEY(author_user_id) REFERENCES auth_accounts(id) ON DELETE CASCADE ON UPDATE NO ACTION)`);
const EVENTS=table('feedback_events',`CREATE TABLE IF NOT EXISTS feedback_events (id INTEGER PRIMARY KEY AUTOINCREMENT, item_id TEXT NOT NULL, action TEXT NOT NULL)`);
const FEEDBACK_INDEX=index('idx_feedback_items_author','feedback_items',`CREATE UNIQUE INDEX IF NOT EXISTS idx_feedback_items_author ON feedback_items(author_user_id,id)`);
const EXISTING_TABLE_INDEX=index('idx_auth_accounts_created','auth_accounts',`CREATE INDEX IF NOT EXISTS idx_auth_accounts_created ON auth_accounts(created_at)`);
const NEW_TABLE_TRIGGER=trigger('trg_feedback_items_audit','feedback_items',`CREATE TRIGGER IF NOT EXISTS trg_feedback_items_audit AFTER UPDATE OF kind ON feedback_items FOR EACH ROW WHEN NEW.kind <> OLD.kind BEGIN
  SELECT RAISE(ABORT,'no; DROP TABLE users') WHERE NEW.kind IS NULL;
  INSERT INTO feedback_events (item_id,action) VALUES (NEW.id,'kind');
  DELETE FROM "feedback_events" WHERE item_id IS NULL;
END`);
const SEED=row('feedback_events:seed','feedback_events',`INSERT INTO feedback_events (item_id,action) VALUES ('seed','created') ON CONFLICT DO NOTHING`);

const VALID_OPERATIONS=Object.freeze([FEEDBACK,EVENTS,FEEDBACK_INDEX,EXISTING_TABLE_INDEX,NEW_TABLE_TRIGGER,SEED]);
const VALID_INTRODUCES=Object.freeze({
  tables:['feedback_items','feedback_events'],
  indexes:['idx_feedback_items_author','idx_auth_accounts_created'],
  triggers:['trg_feedback_items_audit'],
});

function candidate(operations,{introduces,compatibility='additive'}={}){
  const migration={version:22,name:'synthetic-22',checksum:HEX,operations};
  const contract={version:22,name:'synthetic-22',checksum:HEX,compatibility};
  if(compatibility==='additive'){
    const derived={tables:[],indexes:[],triggers:[]};
    for(const operation of operations){
      const kind={'ensure-table':'tables','ensure-index':'indexes','ensure-trigger':'triggers'}[operation?.operation];
      if(kind) derived[kind].push(operation.name);
    }
    if(!derived.tables.length&&!derived.indexes.length&&!derived.triggers.length) derived.tables.push('placeholder_table');
    contract.introduces=introduces||derived;
  }
  return {
    migrations:[...EXECUTABLE_MIGRATIONS,migration],
    contracts:[...MIGRATION_CONTRACTS,contract],
  };
}

// Unless a test passes its own `introduces`, the contract is derived from the
// operations, so only the operations are under test (a migration with no
// artifacts would also fail the separate introduces check, tested below).
function codes(operations,options={}){
  return inspectMigrationCompatibility(candidate(operations,options))
    .filter(item=>options.introduces||item.code!=='introduces_mismatch')
    .map(item=>`${item.code}${item.detail?`:${item.detail}`:''}`);
}

test('the checked-in migrations pass the check, and every one is declared breaking',()=>{
  assert.deepEqual(inspectMigrationCompatibility({migrations:EXECUTABLE_MIGRATIONS}),[]);
  assert.equal(assertMigrationCompatibility({migrations:EXECUTABLE_MIGRATIONS}),true);
  assert.equal(validateExecutableMigrations(),true);
});

test('the check tells additive history from breaking history',()=>{
  const verdicts=EXECUTABLE_MIGRATIONS.map((migration,position)=>[
    migration.version,
    [...new Set(additiveViolations(migration,{previous:EXECUTABLE_MIGRATIONS.slice(0,position)}).map(item=>item.code))],
  ]);
  const breaking=Object.fromEntries(verdicts.filter(([,found])=>found.length));
  assert.deepEqual(breaking,{
    2:['unique_index_on_existing_table'],
    12:['unique_index_on_existing_table'],
    13:['unique_index_on_existing_table'],
    14:['unique_index_on_existing_table'],
    16:['unique_index_on_existing_table'],
    17:['unique_index_on_existing_table','trigger_on_existing_table'],
    18:['unique_index_on_existing_table','trigger_on_existing_table'],
    19:['trigger_on_existing_table'],
    20:['trigger_on_existing_table'],
  });
  // Migration 21 (invite requests) only adds a table and its indexes.
  assert.ok(verdicts.some(([version,found])=>version===21&&found.length===0));
});

test('a real additive migration passes: new tables, their indexes, triggers and seeds, plus a plain index on an existing table',()=>{
  assert.deepEqual(codes(VALID_OPERATIONS,{introduces:VALID_INTRODUCES}),[]);
  // Literals, comments and quoted names cannot smuggle statements in or out.
  assert.equal(normalizeMigrationSql(`select 'a''b;drop' -- drop table x\n, /* delete */ "Feedback" [x y] \`t\``),
    "SELECT '' , FEEDBACK _QUOTED_IDENTIFIER_ T");
  assert.throws(()=>normalizeMigrationSql(null),TypeError);
});

test('the check rejects an additive migration that contains destructive SQL',()=>{
  const cases=[
    [[table('feedback_items','DROP TABLE auth_accounts')],['destructive_sql:DROP']],
    [[table('feedback_items','ALTER TABLE auth_accounts RENAME TO accounts')],['destructive_sql:ALTER']],
    [[table('feedback_items','ALTER TABLE auth_accounts DROP COLUMN phone')],['destructive_sql:ALTER']],
    [[table('feedback_items',"UPDATE auth_accounts SET phone=NULL")],['destructive_sql:UPDATE']],
    [[table('feedback_items',"DELETE FROM auth_sessions")],['destructive_sql:DELETE']],
    [[table('feedback_items',"REPLACE INTO auth_accounts (id) VALUES (1)")],['destructive_sql:REPLACE']],
    [[table('feedback_items','PRAGMA foreign_keys=OFF')],['destructive_sql:PRAGMA']],
    [[table('feedback_items',`${FEEDBACK.sql}; DROP TABLE users`)],['destructive_sql:DROP']],
    [[index('idx_x','auth_accounts','/* create */ DROP INDEX idx_cq_slug')],['destructive_sql:DROP']],
    [[row('seed','auth_accounts',"UPDATE auth_accounts SET is_admin=1")],['destructive_sql:UPDATE']],
    [[EVENTS,trigger('trg_x','feedback_events',`CREATE TRIGGER trg_x AFTER INSERT ON feedback_events BEGIN SELECT 1; END; DROP TABLE users`)],
      ['destructive_sql:DROP']],
    [[EVENTS,trigger('trg_x','feedback_events',`CREATE TRIGGER trg_x AFTER INSERT ON feedback_events BEGIN DELETE FROM auth_accounts; UPDATE OR IGNORE circles SET name=''; END`)],
      ['trigger_writes_existing_table:AUTH_ACCOUNTS','trigger_writes_existing_table:CIRCLES']],
    [[EVENTS,trigger('trg_x','feedback_events',`CREATE TRIGGER trg_x AFTER INSERT ON feedback_events BEGIN REPLACE INTO users (id) VALUES (1); END`)],
      ['trigger_writes_existing_table:USERS']],
  ];
  for(const [operations,expected] of cases){
    assert.deepEqual(codes(operations),expected,JSON.stringify(operations.map(item=>item.sql)));
  }
});

test('the check rejects changes to existing artifacts that alter how running code behaves',()=>{
  const cases=[
    [[table('auth_accounts','CREATE TABLE IF NOT EXISTS auth_accounts (id INTEGER PRIMARY KEY)')],
      ['redefines_existing_artifact']],
    [[table('schema_migrations','CREATE TABLE schema_migrations (version INTEGER)')],['redefines_existing_artifact']],
    [[table('sqlite_stat9','CREATE TABLE sqlite_stat9 (x)')],['redefines_existing_artifact']],
    [[index('idx_cq_slug','custom_questions','CREATE INDEX idx_cq_slug ON custom_questions(slug,id)')],
      ['redefines_existing_artifact']],
    [[index('uq_auth_accounts_phone','auth_accounts','CREATE UNIQUE INDEX uq_auth_accounts_phone ON auth_accounts(phone)')],
      ['unique_index_on_existing_table:AUTH_ACCOUNTS']],
    [[trigger('trg_users_guard','users','CREATE TRIGGER trg_users_guard BEFORE DELETE ON users BEGIN SELECT RAISE(ABORT,\'no\'); END')],
      ['trigger_on_existing_table:USERS']],
    [[row('circle_membership_rollout:2','circle_membership_rollout',"INSERT INTO circle_membership_rollout (id) VALUES (2)")],
      ['seed_row_in_existing_table:CIRCLE_MEMBERSHIP_ROLLOUT']],
    [[table('feedback_items','ALTER TABLE auth_accounts ADD COLUMN deletion_requested_at TEXT')],
      ['add_column_unsupported:ALTER TABLE ADD COLUMN']],
    [[{operation:'ensure-column',name:'auth_accounts.x',sql:'ALTER TABLE auth_accounts ADD COLUMN x TEXT'}],
      ['unsupported_operation']],
    [[{operation:'ensure-table',name:'feedback_items'}],['unsupported_operation']],
    [[null],['unsupported_operation']],
    [[],['no_operations']],
  ];
  for(const [operations,expected] of cases){
    assert.deepEqual(codes(operations),expected,JSON.stringify(operations));
  }
});

test('the check refuses SQL it cannot prove is a plain create statement',()=>{
  const cases=[
    [[table('feedback_items','CREATE TEMP TABLE feedback_items (id)')],['non_canonical_create_table']],
    [[table('feedback_items','CREATE TABLE other_name (id)')],['non_canonical_create_table']],
    [[table('feedback_items','CREATE TABLE feedback_items AS SELECT * FROM auth_accounts')],['non_canonical_create_table']],
    [[table('feedback_items','')],['non_canonical_create_table']],
    [[FEEDBACK,index('idx_y','feedback_items','CREATE INDEX idx_other ON feedback_items(id)')],['non_canonical_create_index']],
    [[FEEDBACK,index('idx_y','auth_accounts','CREATE INDEX idx_y ON feedback_items(id)')],['non_canonical_create_index']],
    [[index('idx_y','ghost_table','CREATE INDEX idx_y ON ghost_table(id)')],['index_on_unknown_table:GHOST_TABLE']],
    [[index('idx_y','schema_migrations','CREATE INDEX idx_y ON schema_migrations(applied_at)')],
      ['index_on_unknown_table:SCHEMA_MIGRATIONS']],
    [[EVENTS,trigger('trg_y','feedback_events','CREATE TRIGGER trg_other AFTER INSERT ON feedback_events BEGIN SELECT 1; END')],
      ['non_canonical_create_trigger']],
    [[EVENTS,trigger('trg_y','feedback_events','CREATE TRIGGER trg_y AFTER INSERT ON feedback_events BEGIN VACUUM; END')],
      ['unsupported_trigger_statement:VACUUM']],
    [[EVENTS,row('seed','feedback_events',"INSERT OR REPLACE INTO feedback_events (id) VALUES (1)")],['non_canonical_seed_row']],
    [[EVENTS,row('seed','users',"INSERT INTO feedback_events (id) VALUES (1)")],['non_canonical_seed_row']],
  ];
  for(const [operations,expected] of cases){
    assert.deepEqual(codes(operations),expected,JSON.stringify(operations.map(item=>item.sql)));
  }
});

test('malformed or truncated input fails closed instead of slipping through',()=>{
  // Unterminated comments, literals and quoted names swallow the rest.
  assert.equal(normalizeMigrationSql('create table t (a) -- trailing'),'CREATE TABLE T (A)');
  assert.equal(normalizeMigrationSql('create table t (a) /* never closed DROP TABLE x'),'CREATE TABLE T (A)');
  assert.equal(normalizeMigrationSql('create table "t (a)'),'CREATE TABLE _QUOTED_IDENTIFIER_');
  const cases=[
    [[EVENTS,trigger('trg_y','feedback_events','CREATE TRIGGER trg_y AFTER INSERT ON feedback_events BEGIN SELECT 1')],
      ['non_canonical_create_trigger']],
    [[EVENTS,trigger('trg_y','feedback_events','')],['non_canonical_create_trigger']],
    [[EVENTS,trigger('trg_y',undefined,'CREATE TRIGGER trg_y AFTER INSERT ON feedback_events BEGIN SELECT 1; END')],
      ['non_canonical_create_trigger']],
    [[FEEDBACK,index('idx_y','feedback_items','')],['non_canonical_create_index']],
    [[FEEDBACK,index('idx_y',undefined,'CREATE INDEX idx_y ON feedback_items(id)')],['non_canonical_create_index']],
    [[EVENTS,row('seed','feedback_events',"INSERT INTO feedback_events (id) VALUES (1); INSERT INTO feedback_events (id) VALUES (2)")],
      ['non_canonical_seed_row']],
    [[EVENTS,row('seed',undefined,"INSERT INTO feedback_events (id) VALUES (1)")],['non_canonical_seed_row']],
    [[{operation:'ensure-row',sql:'DELETE FROM users'}],['destructive_sql:DELETE']],
  ];
  for(const [operations,expected] of cases){
    assert.deepEqual(codes(operations),expected,JSON.stringify(operations));
  }
  assert.deepEqual(codes([{operation:'ensure-table',name:42,sql:'CREATE TABLE feedback_items (id)'}],
    {introduces:{tables:['feedback_items'],indexes:[],triggers:[]}}),
  ['non_canonical_create_table','introduces_mismatch:tables']);
  assert.deepEqual(additiveViolations(null).map(item=>[item.version,item.code]),[[null,'no_operations']]);
  assert.deepEqual(additiveViolations({version:5,operations:[FEEDBACK]},{previous:[{version:1}]}),[]);
  const {migrations,contracts}=candidate([FEEDBACK]);
  migrations[21]={...migrations[21],operations:undefined};
  assert.deepEqual(inspectMigrationCompatibility({migrations,contracts}).map(item=>item.code),
    ['no_operations','introduces_mismatch']);
});

test('the contract must list exactly what an additive migration introduces',()=>{
  // A seed-only additive migration introduces nothing, which no contract can list.
  assert.deepEqual(inspectMigrationCompatibility(candidate([row('seed','users','INSERT INTO users (id) VALUES (1)')]))
    .map(item=>item.code),['seed_row_in_existing_table','introduces_mismatch']);
  assert.deepEqual(codes([FEEDBACK],{introduces:{tables:['feedback_items','extra_table'],indexes:[],triggers:[]}}),
    ['introduces_mismatch:tables']);
  assert.deepEqual(codes([FEEDBACK,FEEDBACK_INDEX],{introduces:{tables:['feedback_items'],indexes:[],triggers:['trg_z']}}),
    ['introduces_mismatch:indexes','introduces_mismatch:triggers']);
  // A breaking declaration is not inspected at all.
  assert.deepEqual(codes([table('feedback_items','DROP TABLE users')],{compatibility:'breaking'}),[]);
  // The migrations must be the contracts, in order.
  const {migrations,contracts}=candidate([FEEDBACK]);
  migrations[21]={...migrations[21],name:'renamed'};
  assert.deepEqual(inspectMigrationCompatibility({migrations,contracts}).map(item=>item.code),['contract_mismatch']);
  assert.throws(()=>inspectMigrationCompatibility({migrations:[],contracts}),/non-empty prefix/);
  assert.throws(()=>inspectMigrationCompatibility({migrations:[...migrations,migrations[0]],contracts}),/non-empty prefix/);
  assert.throws(()=>inspectMigrationCompatibility(),/non-empty prefix/);
});

test('violations are reported with the migration, the reason and the offending statement',()=>{
  const options=candidate([table('feedback_items','DROP TABLE auth_accounts')]);
  assert.throws(()=>assertMigrationCompatibility(options),error=>{
    assert.equal(error.code,'MIGRATION_COMPATIBILITY_INVALID');
    assert.equal(error.violations.length,1);
    assert.equal(error.message,'migration 22 is marked additive but destructive_sql (ensure-table feedback_items: DROP)');
    return true;
  });
  assert.equal(formatCompatibilityViolation({version:3,code:'no_operations',operation:null,name:null,detail:null}),
    'migration 3 is marked additive but no_operations');
  assert.equal(formatCompatibilityViolation({version:3,code:'introduces_mismatch',operation:null,name:null,detail:'tables'}),
    'migration 3 is marked additive but introduces_mismatch: tables');
});

test('contracts must declare a compatibility, and additive ones what they introduce',()=>{
  const base={version:1,name:'one',checksum:HEX,compatibility:'breaking'};
  const second={version:2,name:'two',checksum:HEX};
  const introduces={tables:['t2'],indexes:[],triggers:[]};
  assert.equal(validateMigrationContracts([base,{...second,compatibility:'additive',introduces}]),true);
  assert.equal(validateMigrationContracts(MIGRATION_CONTRACTS),true);
  for(const [contracts,message] of [
    [[{...base,compatibility:undefined}],/must declare compatibility/],
    [[{...base,compatibility:'expand'}],/must declare compatibility/],
    [[{...base,compatibility:'additive',introduces}],/1 cannot be additive/],
    [[base,{...second,compatibility:'breaking',introduces}],/must not list introduced artifacts/],
    [[base,{...second,compatibility:'additive'}],/must list the tables/],
    [[base,{...second,compatibility:'additive',introduces:[]}],/must list the tables/],
    [[base,{...second,compatibility:'additive',introduces:{tables:['t2'],indexes:[]}}],/must list the tables/],
    [[base,{...second,compatibility:'additive',introduces:{tables:'t2',indexes:[],triggers:[]}}],/must list the tables/],
    [[base,{...second,compatibility:'additive',introduces:{tables:[],indexes:[],triggers:[]}}],/must list the tables/],
    [[base,{...second,compatibility:'additive',introduces:{tables:['bad name'],indexes:[],triggers:[]}}],/must list the tables/],
    [[base,{...second,compatibility:'additive',introduces:{tables:['t2'],indexes:['t2'],triggers:[]}}],/must list the tables/],
  ]){
    assert.throws(()=>validateMigrationContracts(contracts),message);
  }
});

test('the deployability gate reports a mislabelled migration and a migration set that cannot load',async()=>{
  assert.deepEqual(await inspectMigrationReleaseContract(),[]);
  const {migrations,contracts}=candidate([table('feedback_items','DROP TABLE auth_accounts')]);
  const loadWith=(executable,contractList)=>async()=>[
    {EXECUTABLE_MIGRATIONS:executable},
    await import('../../db/migration-compatibility-check.js'),
    {MIGRATION_CONTRACTS:contractList},
  ];
  assert.deepEqual(await inspectMigrationReleaseContract({load:loadWith(migrations,contracts)}),[
    'migration release contract: migration 22 is marked additive but destructive_sql (ensure-table feedback_items: DROP)',
  ]);
  assert.deepEqual(await inspectMigrationReleaseContract({load:async()=>{ throw new Error('migration 20 is marked additive but trigger_on_existing_table'); }}),
    ['migration release contract: migration 20 is marked additive but trigger_on_existing_table']);
  assert.deepEqual(await inspectMigrationReleaseContract({load:async()=>{ throw null; }}),
    ['migration release contract: migrations could not be loaded']);
});
