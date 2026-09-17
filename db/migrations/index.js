import { createHash } from 'node:crypto';
import { MigrationPreflightError } from '../errors.js';
import {
  INITIAL_SCHEMA_TABLE_DEFINITIONS,
  MIGRATION_1_INDEX_DEFINITIONS,
  MIGRATION_2_LEGACY_COLUMN_ADDITIONS,
  PAIR_SCHEDULE_UNIQUE_INDEX_DEFINITION,
  PAIRING_WEEK_UNIQUE_INDEX_DEFINITION,
  assertCompatibleExistingIndex,
  buildTableContract,
} from '../schema.js';

export const SCHEDULE_ARCHIVE_TABLE='pair_schedule_duplicates_archive';
export const SCHEDULE_ARCHIVE_SQL=`CREATE TABLE IF NOT EXISTS pair_schedule_duplicates_archive (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  original_id INTEGER NOT NULL UNIQUE,
  week_id INTEGER NOT NULL,
  pair_group_id INTEGER NOT NULL,
  proposed_times TEXT,
  agreed_time TEXT,
  created_at TEXT,
  updated_at TEXT,
  archived_at TEXT NOT NULL DEFAULT (datetime('now')),
  archive_reason TEXT NOT NULL
)`;

export const SCHEDULE_ARCHIVE_CONTRACT=buildTableContract({
  name:SCHEDULE_ARCHIVE_TABLE,
  sql:SCHEDULE_ARCHIVE_SQL,
});

const ARCHIVE_SCHEDULE_DUPLICATES_SQL=`INSERT INTO pair_schedule_duplicates_archive (
  original_id, week_id, pair_group_id, proposed_times, agreed_time,
  created_at, updated_at, archive_reason
)
SELECT id, week_id, pair_group_id, proposed_times, agreed_time,
       created_at, updated_at, 'duplicate_week_pair'
FROM pair_schedules
WHERE id NOT IN (
  SELECT MAX(id) FROM pair_schedules GROUP BY week_id, pair_group_id
)`;

const DELETE_SCHEDULE_DUPLICATES_SQL=`DELETE FROM pair_schedules
WHERE id NOT IN (
  SELECT MAX(id) FROM pair_schedules GROUP BY week_id, pair_group_id
)`;

const PAIRING_WEEK_DUPLICATES_SQL=`SELECT week_label, COUNT(*) AS duplicate_count
FROM pairing_weeks
GROUP BY week_label
HAVING COUNT(*) > 1
ORDER BY week_label
LIMIT 20`;

function assertIdentifier(value) {
  if(!/^[a-z][a-z0-9_]*$/.test(value)) throw new TypeError(`Unsafe SQL identifier: ${value}`);
  return value;
}

function deepFreeze(value) {
  if(!value||typeof value!=='object'||Object.isFrozen(value)) return value;
  for(const nested of Object.values(value)) deepFreeze(nested);
  return Object.freeze(value);
}

function sqlOperation(sql) {
  return {operation:'sql',sql};
}

function indexOperation(definition) {
  return {
    operation:'ensure-index',
    definition:{
      name:definition.name,
      table:definition.table,
      columns:[...definition.columns],
      unique:Boolean(definition.unique),
      sql:definition.sql,
      ...(definition.stage?{stage:definition.stage}:{}),
    },
  };
}

function guardedColumnOperation({table,column,definition}) {
  const safeTable=assertIdentifier(table);
  const safeColumn=assertIdentifier(column);
  return {
    operation:'add-column-if-missing',
    table:safeTable,
    column:safeColumn,
    inspectSql:`PRAGMA table_info("${safeTable}")`,
    sql:`ALTER TABLE "${safeTable}" ADD COLUMN "${safeColumn}" ${definition}`,
  };
}

function duplicateWeekPreflightOperation() {
  return {
    operation:'assert-empty-result',
    sql:PAIRING_WEEK_DUPLICATES_SQL,
    error:{
      message:'Duplicate pairing week labels require manual reconciliation before migration',
      detailsKey:'duplicates',
      fields:[
        {source:'week_label',target:'weekLabel',type:'string'},
        {source:'duplicate_count',target:'count',type:'number'},
      ],
    },
  };
}

const MIGRATION_PLAN_DEFINITIONS=[
  {
    version:1,
    name:'current_application_schema',
    operations:[
      ...INITIAL_SCHEMA_TABLE_DEFINITIONS.map(({sql})=>sqlOperation(sql)),
      ...MIGRATION_1_INDEX_DEFINITIONS.map(indexOperation),
    ],
    checksum:'91e4e110f9d619dc52051b570fddb0cb3e67a0f8be624837fb71e915279b7618',
  },
  {
    version:2,
    name:'guarded_legacy_columns',
    operations:MIGRATION_2_LEGACY_COLUMN_ADDITIONS.map(guardedColumnOperation),
    checksum:'75d210f7f1b92559c9d3c449227dd5274a320de0f52bd560bf24fad046b79f80',
  },
  {
    version:3,
    name:'archive_and_dedupe_pair_schedules',
    operations:[
      sqlOperation(SCHEDULE_ARCHIVE_SQL),
      sqlOperation(ARCHIVE_SCHEDULE_DUPLICATES_SQL),
      sqlOperation(DELETE_SCHEDULE_DUPLICATES_SQL),
      indexOperation(PAIR_SCHEDULE_UNIQUE_INDEX_DEFINITION),
    ],
    checksum:'b44d3b14adc133d5e9a5ba05b889a977a86f29f79f518c8e74efb1c3c06c5f16',
  },
  {
    version:4,
    name:'unique_pairing_week_labels',
    operations:[
      duplicateWeekPreflightOperation(),
      indexOperation(PAIRING_WEEK_UNIQUE_INDEX_DEFINITION),
    ],
    checksum:'9336a43511012fef7d5566cf545ccc47567eb6669b82c982e390a9e9764bd7b6',
  },
];

function mapResultDetails(rows, errorDefinition) {
  return rows.map(row=>Object.fromEntries(errorDefinition.fields.map(field=>{
    const raw=row[field.source];
    if(field.type==='string') return [field.target,String(raw)];
    if(field.type==='number') return [field.target,Number(raw)];
    throw new TypeError(`Unsupported migration result field type: ${field.type}`);
  })));
}

export async function executeMigrationPlan(db, operations) {
  for(const operation of operations){
    if(operation.operation==='sql'){
      await db.execute(operation.sql);
      continue;
    }
    if(operation.operation==='ensure-index'){
      await assertCompatibleExistingIndex(db,operation.definition);
      await db.execute(operation.definition.sql);
      continue;
    }
    if(operation.operation==='add-column-if-missing'){
      const result=await db.execute(operation.inspectSql);
      const columns=new Set((result.rows||[]).map(row=>String(row.name)));
      if(!columns.has(operation.column)) await db.execute(operation.sql);
      continue;
    }
    if(operation.operation==='assert-empty-result'){
      const result=await db.execute(operation.sql);
      if(result.rows?.length){
        throw new MigrationPreflightError(operation.error.message,{
          [operation.error.detailsKey]:mapResultDetails(result.rows,operation.error),
        });
      }
      continue;
    }
    throw new TypeError(`Unsupported migration operation: ${operation.operation}`);
  }
}

export function checksumMigrationPlan({version,name,operations}) {
  return createHash('sha256')
    .update(JSON.stringify({version,name,operations}))
    .digest('hex');
}

function defineMigration(definition) {
  const operations=deepFreeze(structuredClone(definition.operations));
  const calculatedChecksum=checksumMigrationPlan({
    version:definition.version,
    name:definition.name,
    operations,
  });
  if(calculatedChecksum!==definition.checksum){
    throw new Error(`Immutable migration ${definition.version} execution plan has changed`);
  }
  return Object.freeze({
    version:definition.version,
    name:definition.name,
    checksum:definition.checksum,
    operations,
    up:db=>executeMigrationPlan(db,operations),
  });
}

export const MIGRATIONS=Object.freeze(MIGRATION_PLAN_DEFINITIONS.map(defineMigration));

export const LATEST_SCHEMA_VERSION=MIGRATIONS.at(-1)?.version||0;
