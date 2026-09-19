import test from 'node:test';
import assert from 'node:assert/strict';
import { createClient } from '@libsql/client';
import { INDEXES, SCHEMA_MANIFEST, TABLES } from '../../db/schema-manifest.js';
import { MIGRATION_PLANS } from '../../db/migration-plan.js';
import { assertReadOnlyStatement, buildReadOnlyPlan, inspectSchema, planVersionFor, readOnlyDatabase } from '../../db/schema-inspector.js';

async function currentDatabase({legacy=false}={}){
  const db=createClient({url:'file::memory:'});
  for(const definition of TABLES) await db.execute(definition.sql);
  for(const definition of INDEXES) await db.execute(definition.sql);
  if(legacy) await db.execute(`CREATE TABLE ai_monthly_usage (month TEXT PRIMARY KEY)`);
  return db;
}

test('current schema passes read-only inspection and tolerates the retired AI table',async()=>{
  const db=await currentDatabase({legacy:true});
  const statements=[];
  const status=await inspectSchema({execute(statement){
    statements.push(typeof statement==='string'?statement:statement.sql);
    return db.execute(statement);
  }},{manifest:SCHEMA_MANIFEST});
  assert.equal(status.ok,true);
  assert.deepEqual(status.summary,{
    expectedTables:48,presentTables:48,expectedIndexes:51,presentIndexes:51,blockers:0,warnings:0,
  });
  assert.deepEqual(status.tolerated.legacyTables,['ai_monthly_usage']);
  assert.ok(statements.length>50);
  assert.ok(statements.every(statement=>/^(?:SELECT|PRAGMA)\b/i.test(statement.trim())));
  db.close();
});

test('inspection reports missing, incompatible, and unexpected artifacts structurally',async()=>{
  const db=createClient({url:'file::memory:'});
  await db.execute(`CREATE TABLE widgets (id INTEGER PRIMARY KEY, label INTEGER, extra TEXT)`);
  await db.execute(`CREATE INDEX idx_widgets_label ON widgets(label) WHERE label IS NULL`);
  await db.execute(`CREATE UNIQUE INDEX surprise_unique ON widgets(extra)`);
  await db.execute(`CREATE TRIGGER erase_widget AFTER INSERT ON widgets BEGIN DELETE FROM widgets; END`);
  await db.execute(`CREATE TABLE unrelated (id INTEGER)`);
  const manifest={
    version:7,
    checksum:'test',
    toleratedLegacyTables:[],
    tables:[
      {name:'widgets',sql:`CREATE TABLE widgets (id INTEGER PRIMARY KEY, label TEXT NOT NULL DEFAULT 'ready' UNIQUE CHECK(length(label)>0), created_at TEXT)`},
      {name:'missing_table',sql:`CREATE TABLE missing_table (id INTEGER PRIMARY KEY)`},
    ],
    indexes:[
      {name:'idx_widgets_label',table:'widgets',keyParts:['lower(label) DESC'],unique:true,where:'label IS NOT NULL',sql:'CREATE UNIQUE INDEX idx_widgets_label ON widgets(lower(label) DESC) WHERE label IS NOT NULL'},
      {name:'idx_missing',table:'widgets',keyParts:['created_at'],unique:false,where:null,sql:'CREATE INDEX idx_missing ON widgets(created_at)'},
    ],
  };
  const status=await inspectSchema(db,{manifest});
  assert.equal(status.ok,false);
  assert.deepEqual(status.drift.missingTables,['missing_table']);
  assert.deepEqual(status.drift.missingColumns,[{table:'widgets',column:'created_at'}]);
  assert.equal(status.drift.columnDrift[0].column,'label');
  assert.deepEqual(status.drift.unexpectedColumns,[{table:'widgets',column:'extra'}]);
  assert.deepEqual(status.drift.constraintDrift.map(item=>item.kind),['checks','unique','conflictPolicies']);
  assert.deepEqual(status.drift.missingIndexes,['idx_missing']);
  assert.equal(status.drift.indexDrift[0].index,'idx_widgets_label');
  assert.deepEqual(status.drift.unexpectedTables,['unrelated']);
  assert.deepEqual(status.drift.unexpectedUniqueIndexes,['surprise_unique']);
  assert.deepEqual(status.drift.unexpectedTriggers,['erase_widget']);
  assert.ok(status.blockers.some(blocker=>blocker.code==='index_drift'));
  assert.ok(status.warnings.some(warning=>warning.code==='unexpected_table'));
  db.close();
});

test('empty database produces a non-executable, checksum-bearing plan',async()=>{
  const db=createClient({url:'file::memory:'});
  const status=await inspectSchema(db,{manifest:SCHEMA_MANIFEST});
  const plan=buildReadOnlyPlan(status,{manifest:SCHEMA_MANIFEST,plans:MIGRATION_PLANS});
  assert.equal(status.blockers.length,99);
  assert.equal(plan.readOnly,true);
  assert.equal(plan.executable,false);
  assert.equal(plan.actions.length,99);
  assert.ok(plan.actions.some(action=>action.artifact.name==='circles'&&action.kind==='create_table'));
  assert.ok(plan.actions.some(action=>action.artifact.name==='uq_circles_active_primary'&&action.kind==='create_index'));
  assert.ok(plan.plans.every(item=>/^[a-f0-9]{64}$/.test(item.checksum)));
  db.close();
});

test('bounded schema inspection fails closed when metadata exceeds its cap',async()=>{
  const calls=[];
  const status=await inspectSchema({execute(statement){
    const sql=typeof statement==='string'?statement:statement.sql;
    calls.push({sql,args:statement?.args||[]});
    if(sql.includes('FROM sqlite_schema')) return {rows:[
      {type:'table',name:'a',tbl_name:'a',sql:'CREATE TABLE a (id INTEGER)'},
      {type:'table',name:'b',tbl_name:'b',sql:'CREATE TABLE b (id INTEGER)'},
      {type:'table',name:'c',tbl_name:'c',sql:'CREATE TABLE c (id INTEGER)'},
    ]};
    if(sql==='PRAGMA foreign_keys') return {rows:[{foreign_keys:1}]};
    if(sql==='PRAGMA ignore_check_constraints') return {rows:[{ignore_check_constraints:0}]};
    return {rows:[]};
  }},{
    manifest:{version:1,checksum:'test',tables:[],indexes:[],toleratedLegacyTables:[]},
    maxSchemaObjects:2,
  });
  assert.equal(status.ok,false);
  assert.ok(status.blockers.some(item=>item.code==='schema_object_limit_exceeded'));
  assert.deepEqual(calls[0].args,[3]);
  await assert.rejects(
    inspectSchema({execute(){ return {rows:[]}; }},{
      manifest:{tables:[],indexes:[],toleratedLegacyTables:[]},maxSchemaObjects:0,
    }),
    /maxSchemaObjects/,
  );
});

test('read-only adapter rejects mutations before delegating',async()=>{
  const calls=[];
  const db=readOnlyDatabase({execute(statement){ calls.push(statement); return {rows:[]}; }});
  await db.execute('PRAGMA table_info("users")');
  await db.execute('SELECT 1');
  assert.throws(()=>db.execute('CREATE TABLE forbidden (id INTEGER)'),/non-read-only/);
  assert.throws(()=>assertReadOnlyStatement({sql:'DELETE FROM users'}),/non-read-only/);
  assert.throws(()=>assertReadOnlyStatement('PRAGMA user_version=7'),/non-read-only/);
  assert.throws(()=>assertReadOnlyStatement('WITH x AS (SELECT 1) DELETE FROM users'),/non-read-only/);
  assert.throws(()=>assertReadOnlyStatement('SELECT 1; DELETE FROM users'),/non-read-only/);
  assert.equal(calls.length,2);
  let reads=0;
  const guarded=readOnlyDatabase({execute(statement){ calls.push(statement); return {rows:[]}; }});
  await guarded.execute({get sql(){ reads+=1; return reads===1?'SELECT 1':'DELETE FROM users'; },args:[]});
  assert.equal(reads,1);
  assert.equal(calls.at(-1).sql,'SELECT 1');
});

test('plan marks column and index repairs as manually blocked',()=>{
  const status={
    ok:false,
    drift:{
      missingTables:[],
      missingColumns:[{table:'auth_accounts',column:'phone'}],
      unexpectedColumns:[],
      columnDrift:[{table:'users',column:'name',differences:[{property:'type',expected:'TEXT',actual:'INTEGER'}]}],
      constraintDrift:[],
      missingIndexes:[],
      indexDrift:[{index:'uq_auth_accounts_google_sub',differences:[{property:'where',expected:'google_sub is not null',actual:null}]}],
      unexpectedUniqueIndexes:[],unexpectedViews:[],unexpectedTriggers:[],
    },
    blockers:[],warnings:[],tolerated:{legacyTables:[]},
  };
  const plan=buildReadOnlyPlan(status,{manifest:SCHEMA_MANIFEST,plans:MIGRATION_PLANS});
  assert.equal(plan.actions.length,3);
  assert.ok(plan.actions.every(action=>action.blocked&&action.sql===null));
});

test('plan actions point to the latest replacement definition',()=>{
  const plans=[
    {version:1,tables:['users'],indexes:[]},
    {version:2,tables:['circles'],indexes:[]},
    {version:3,tables:['users'],indexes:[]},
  ];
  assert.equal(planVersionFor('table','users',plans),3);
  assert.equal(planVersionFor('table','circles',plans),2);
  assert.equal(planVersionFor('index','missing',plans),null);
});

test('default comparison preserves quoted literal case and whitespace',async()=>{
  const db=createClient({url:'file::memory:'});
  await db.execute(`CREATE TABLE settings (mode TEXT DEFAULT 'medium', label TEXT DEFAULT 'a b')`);
  const status=await inspectSchema(db,{manifest:{
    version:1,checksum:'test',toleratedLegacyTables:[],indexes:[],
    tables:[{name:'settings',sql:`CREATE TABLE settings (mode TEXT DEFAULT 'Medium', label TEXT DEFAULT 'a  b')`}],
  }});
  assert.equal(status.drift.columnDrift.length,2);
  assert.ok(status.drift.columnDrift.every(item=>item.differences.some(diff=>diff.property==='defaultValue')));
  db.close();
});

test('write-affecting table options and conflict semantics are drift',async()=>{
  const db=createClient({url:'file::memory:'});
  await db.execute(`CREATE TABLE policies (a TEXT COLLATE NOCASE, b TEXT, PRIMARY KEY(a DESC,b) ON CONFLICT REPLACE) STRICT`);
  const status=await inspectSchema(db,{manifest:{
    version:1,checksum:'test',toleratedLegacyTables:[],indexes:[],
    tables:[{name:'policies',sql:`CREATE TABLE policies (a TEXT, b TEXT, PRIMARY KEY(a,b))`}],
  }});
  const kinds=status.drift.constraintDrift.map(item=>item.kind);
  assert.ok(kinds.includes('collations'));
  assert.ok(kinds.includes('conflictPolicies'));
  assert.ok(kinds.includes('primaryKeyTerms'));
  assert.ok(kinds.includes('tableOptions'));
  db.close();
});

test('conflict policies remain bound to the constraints they govern',async()=>{
  const db=createClient({url:'file::memory:'});
  await db.execute(`CREATE TABLE policies (
    a TEXT UNIQUE ON CONFLICT REPLACE,
    b TEXT UNIQUE ON CONFLICT IGNORE
  )`);
  const status=await inspectSchema(db,{manifest:{
    version:1,checksum:'test',toleratedLegacyTables:[],indexes:[],
    tables:[{name:'policies',sql:`CREATE TABLE policies (
      a TEXT UNIQUE ON CONFLICT IGNORE,
      b TEXT UNIQUE ON CONFLICT REPLACE
    )`}],
  }});
  const drift=status.drift.constraintDrift.find(item=>item.kind==='conflictPolicies');
  assert.ok(drift);
  assert.notDeepEqual(drift.actual,drift.expected);
  assert.equal(status.ready,false);
  db.close();
});

test('table primary-key conflict clauses preserve expected composite columns',async()=>{
  const db=createClient({url:'file::memory:'});
  const sql=`CREATE TABLE policies (
    a TEXT,
    b TEXT,
    PRIMARY KEY(a,b) ON CONFLICT REPLACE
  )`;
  await db.execute(sql);
  const status=await inspectSchema(db,{manifest:{
    version:1,checksum:'test',toleratedLegacyTables:[],indexes:[],
    tables:[{name:'policies',sql}],
  }});
  assert.deepEqual(status.drift.missingColumns,[]);
  assert.deepEqual(status.drift.columnDrift,[]);
  assert.equal(status.ready,true);
  db.close();
});

test('equivalent inline and table primary keys share indexed-term semantics',async()=>{
  const db=createClient({url:'file::memory:'});
  await db.execute(`CREATE TABLE policies (
    a TEXT COLLATE NOCASE PRIMARY KEY DESC ON CONFLICT REPLACE
  )`);
  const status=await inspectSchema(db,{manifest:{
    version:1,checksum:'test',toleratedLegacyTables:[],indexes:[],
    tables:[{name:'policies',sql:`CREATE TABLE policies (
      a TEXT COLLATE NOCASE,
      PRIMARY KEY(a COLLATE NOCASE DESC) ON CONFLICT REPLACE
    )`}],
  }});
  assert.deepEqual(status.drift.columnDrift,[]);
  assert.deepEqual(status.drift.constraintDrift,[]);
  assert.equal(status.ready,true);
  db.close();
});

test('primary-key collation, order, and conflict policy remain drift',async()=>{
  const db=createClient({url:'file::memory:'});
  await db.execute(`CREATE TABLE policies (
    a TEXT COLLATE NOCASE,
    b TEXT,
    PRIMARY KEY(a DESC,b) ON CONFLICT REPLACE
  )`);
  const inspect=sql=>inspectSchema(db,{manifest:{
    version:1,checksum:'test',toleratedLegacyTables:[],indexes:[],
    tables:[{name:'policies',sql}],
  }});
  const changedCollation=await inspect(`CREATE TABLE policies (
    a TEXT COLLATE NOCASE,
    b TEXT,
    PRIMARY KEY(a COLLATE BINARY DESC,b) ON CONFLICT REPLACE
  )`);
  assert.ok(changedCollation.drift.constraintDrift.some(item=>item.kind==='primaryKeyTerms'));
  assert.ok(changedCollation.drift.constraintDrift.some(item=>item.kind==='conflictPolicies'));

  const changedOrder=await inspect(`CREATE TABLE policies (
    a TEXT COLLATE NOCASE,
    b TEXT,
    PRIMARY KEY(b,a DESC) ON CONFLICT REPLACE
  )`);
  assert.ok(changedOrder.drift.constraintDrift.some(item=>item.kind==='primaryKeyTerms'));
  assert.ok(changedOrder.drift.constraintDrift.some(item=>item.kind==='conflictPolicies'));

  const changedPolicy=await inspect(`CREATE TABLE policies (
    a TEXT COLLATE NOCASE,
    b TEXT,
    PRIMARY KEY(a DESC,b) ON CONFLICT IGNORE
  )`);
  assert.ok(changedPolicy.drift.constraintDrift.some(item=>item.kind==='conflictPolicies'));
  assert.ok(!changedPolicy.drift.constraintDrift.some(item=>item.kind==='primaryKeyTerms'));
  db.close();
});

test('equivalent inline and table UNIQUE policies have one canonical target',async()=>{
  const db=createClient({url:'file::memory:'});
  await db.execute(`CREATE TABLE policies (a TEXT COLLATE NOCASE UNIQUE ON CONFLICT REPLACE)`);
  const status=await inspectSchema(db,{manifest:{
    version:1,checksum:'test',toleratedLegacyTables:[],indexes:[],
    tables:[{name:'policies',sql:`CREATE TABLE policies (a TEXT COLLATE NOCASE, UNIQUE(a) ON CONFLICT REPLACE)`}],
  }});
  assert.deepEqual(status.drift.constraintDrift,[]);
  assert.equal(status.ready,true);
  db.close();
});

test('named table constraints retain primary-key, unique, foreign-key, and policy semantics',async()=>{
  const db=createClient({url:'file::memory:'});
  await db.execute(`CREATE TABLE parents (id INTEGER PRIMARY KEY)`);
  const sql=`CREATE TABLE children (
    parent_id INTEGER,
    code TEXT,
    CONSTRAINT child_pk PRIMARY KEY(parent_id,code) ON CONFLICT REPLACE,
    CONSTRAINT child_unique UNIQUE(code) ON CONFLICT IGNORE,
    CONSTRAINT child_parent FOREIGN KEY(parent_id) REFERENCES parents(id) ON DELETE CASCADE,
    CONSTRAINT child_code CHECK(length(code)>0)
  )`;
  await db.execute(sql);
  const status=await inspectSchema(db,{manifest:{
    version:1,checksum:'test',toleratedLegacyTables:[],indexes:[],
    tables:[
      {name:'parents',sql:`CREATE TABLE parents (id INTEGER PRIMARY KEY)`},
      {name:'children',sql},
    ],
  }});
  assert.deepEqual(status.drift.missingColumns,[]);
  assert.deepEqual(status.drift.columnDrift,[]);
  assert.deepEqual(status.drift.constraintDrift,[]);
  assert.equal(status.ready,true);
  const changedPolicy=await inspectSchema(db,{manifest:{
    version:1,checksum:'test',toleratedLegacyTables:[],indexes:[],
    tables:[
      {name:'parents',sql:`CREATE TABLE parents (id INTEGER PRIMARY KEY)`},
      {name:'children',sql:sql.replace('UNIQUE(code) ON CONFLICT IGNORE','UNIQUE(code) ON CONFLICT REPLACE')},
    ],
  }});
  assert.ok(changedPolicy.drift.constraintDrift.some(item=>item.kind==='conflictPolicies'));
  assert.equal(changedPolicy.ready,false);
  db.close();
});

test('comments, generated columns, and AUTOINCREMENT loss cannot spoof readiness',async()=>{
  const db=createClient({url:'file::memory:'});
  await db.execute(`CREATE TABLE widgets (id INTEGER PRIMARY KEY, value TEXT /* UNIQUE */, derived TEXT GENERATED ALWAYS AS (lower(value)) STORED)`);
  const status=await inspectSchema(db,{manifest:{
    version:1,checksum:'test',toleratedLegacyTables:[],indexes:[],
    tables:[{name:'widgets',sql:`CREATE TABLE widgets (id INTEGER PRIMARY KEY AUTOINCREMENT, value TEXT UNIQUE)`}],
  }});
  assert.deepEqual(status.drift.unexpectedColumns,[{table:'widgets',column:'derived'}]);
  assert.ok(status.drift.constraintDrift.some(item=>item.kind==='unique'));
  assert.ok(status.drift.constraintDrift.some(item=>item.kind==='autoincrementColumns'));
  assert.equal(status.ready,false);
  db.close();
});

test('unique collation, foreign-key timing, and disabled CHECK enforcement fail readiness',async()=>{
  const db=createClient({url:'file::memory:'});
  await db.execute(`CREATE TABLE parents (id INTEGER PRIMARY KEY)`);
  await db.execute(`CREATE TABLE children (id INTEGER PRIMARY KEY, parent_id INTEGER, code TEXT COLLATE NOCASE UNIQUE, CHECK(length(code)>0), FOREIGN KEY(parent_id) REFERENCES parents(id) DEFERRABLE INITIALLY DEFERRED)`);
  await db.execute('PRAGMA ignore_check_constraints=ON');
  const status=await inspectSchema(db,{manifest:{
    version:1,checksum:'test',toleratedLegacyTables:[],indexes:[],
    tables:[
      {name:'parents',sql:`CREATE TABLE parents (id INTEGER PRIMARY KEY)`},
      {name:'children',sql:`CREATE TABLE children (id INTEGER PRIMARY KEY, parent_id INTEGER, code TEXT UNIQUE, CHECK(length(code)>0), FOREIGN KEY(parent_id) REFERENCES parents(id))`},
    ],
  }});
  assert.ok(status.drift.constraintDrift.some(item=>item.kind==='unique'));
  assert.ok(status.drift.constraintDrift.some(item=>item.kind==='foreignKeyTimings'));
  assert.equal(status.checkConstraintsEnabled,false);
  assert.ok(status.blockers.some(item=>item.code==='check_constraints_disabled'));
  db.close();
});

test('arithmetic expression indexes are recognized without false drift',async()=>{
  const db=createClient({url:'file::memory:'});
  await db.execute(`CREATE TABLE values_table (a INTEGER, b INTEGER)`);
  await db.execute(`CREATE INDEX idx_values_sum ON values_table(a+b)`);
  const status=await inspectSchema(db,{manifest:{
    version:1,checksum:'test',toleratedLegacyTables:[],
    tables:[{name:'values_table',sql:`CREATE TABLE values_table (a INTEGER, b INTEGER)`}],
    indexes:[{name:'idx_values_sum',table:'values_table',keyParts:['a+b'],unique:false,where:null,sql:'CREATE INDEX idx_values_sum ON values_table(a+b)'}],
  }});
  assert.equal(status.ok,true);
  assert.deepEqual(status.drift.indexDrift,[]);
  db.close();
});

test('explicit ASC index ordering matches SQLite implicit ascending order',async()=>{
  const db=createClient({url:'file::memory:'});
  await db.execute(`CREATE TABLE labels (value TEXT)`);
  await db.execute(`CREATE INDEX idx_labels_value ON labels(value ASC)`);
  const status=await inspectSchema(db,{manifest:{
    version:1,checksum:'test',toleratedLegacyTables:[],
    tables:[{name:'labels',sql:`CREATE TABLE labels (value TEXT)`}],
    indexes:[{name:'idx_labels_value',table:'labels',keyParts:['value'],unique:false,where:null,sql:'CREATE INDEX idx_labels_value ON labels(value)'}],
  }});
  assert.equal(status.ok,true);
  assert.deepEqual(status.drift.indexDrift,[]);
  db.close();
});

test('collated indexes and inherited UNIQUE collations compare semantically',async()=>{
  const db=createClient({url:'file::memory:'});
  await db.execute(`CREATE TABLE labels (value TEXT COLLATE NOCASE, UNIQUE(value))`);
  await db.execute(`CREATE INDEX idx_labels_value ON labels(value COLLATE NOCASE)`);
  const status=await inspectSchema(db,{manifest:{
    version:1,checksum:'test',toleratedLegacyTables:[],
    tables:[{name:'labels',sql:`CREATE TABLE labels (value TEXT COLLATE NOCASE, UNIQUE(value))`}],
    indexes:[{name:'idx_labels_value',table:'labels',keyParts:['value COLLATE NOCASE'],unique:false,where:null,sql:'CREATE INDEX idx_labels_value ON labels(value COLLATE NOCASE)'}],
  }});
  assert.equal(status.ok,true);
  assert.deepEqual(status.drift.constraintDrift,[]);
  assert.deepEqual(status.drift.indexDrift,[]);
  db.close();
});

test('unknown CHECK-enforcement state fails closed',async()=>{
  const db=await currentDatabase();
  const status=await inspectSchema({execute(statement){
    const sql=typeof statement==='string'?statement:statement.sql;
    if(sql==='PRAGMA ignore_check_constraints') return {rows:[]};
    return db.execute(statement);
  }},{manifest:SCHEMA_MANIFEST});
  assert.equal(status.checkConstraintsEnabled,false);
  assert.ok(status.blockers.some(item=>item.code==='check_constraints_disabled'));
  db.close();
});
