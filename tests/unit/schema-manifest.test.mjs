import test from 'node:test';
import assert from 'node:assert/strict';
import {
  INDEXES,
  PINNED_SCHEMA_MANIFEST_CHECKSUM,
  SCHEMA_MANIFEST_CHECKSUM,
  TABLES,
  TOLERATED_LEGACY_TABLES,
  checksum,
} from '../../db/schema-manifest.js';
import { MIGRATION_PLANS, validateMigrationPlans } from '../../db/migration-plan.js';
import { expectedColumns, parseIndexSql } from '../../db/schema-inspector.js';

test('schema manifest pins all current tables and named indexes',()=>{
  assert.equal(TABLES.length,28);
  assert.equal(INDEXES.length,26);
  assert.equal(new Set(TABLES.map(item=>item.name)).size,TABLES.length);
  assert.equal(new Set(INDEXES.map(item=>item.name)).size,INDEXES.length);
  assert.equal(SCHEMA_MANIFEST_CHECKSUM,PINNED_SCHEMA_MANIFEST_CHECKSUM);
  assert.deepEqual(TOLERATED_LEGACY_TABLES,['ai_monthly_usage']);
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
