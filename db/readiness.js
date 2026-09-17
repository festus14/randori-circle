import { MigrationLedgerError } from './errors.js';
import {
  LATEST_SCHEMA_VERSION,
  MIGRATIONS,
  SCHEDULE_ARCHIVE_CONTRACT,
  SCHEDULE_ARCHIVE_TABLE,
} from './migrations/index.js';
import {
  MIGRATION_LEDGER_CONTRACT,
  MIGRATION_LEDGER_TABLE,
  validateMigrationLedger,
} from './migrate.js';
import {
  APPLICATION_TABLES,
  INDEX_DEFINITIONS,
  REQUIRED_COLUMNS,
  REQUIRED_FOREIGN_KEYS,
  REQUIRED_UNIQUE_CONSTRAINTS,
  TABLE_CONTRACTS,
  inspectIndexCompatibility,
  normalizeSqlDefault,
} from './schema.js';

const LEDGER_COLUMNS=Object.freeze(['version','name','checksum','applied_at','execution_ms']);

function baseResult(latestVersion) {
  return {
    ready:false,
    status:'schema_invalid',
    reason:'schema_mismatch',
    currentVersion:0,
    latestVersion,
    pendingVersions:[],
    missingTables:[],
    missingIndexes:[],
    missingColumns:[],
    columnDrift:[],
    missingUniqueConstraints:[],
    foreignKeyDrift:[],
    foreignKeysEnabled:null,
    indexDrift:[],
    missingMigrationArtifacts:[],
    issues:[],
  };
}

function issue(code,message,details) {
  const value={code,message};
  if(details!==undefined) value.details=details;
  return value;
}

function normalizeType(value) {
  return String(value||'').trim().toUpperCase().replace(/\s+/g,' ');
}

function groupColumns(rows) {
  const tables=new Map();
  for(const row of rows||[]){
    const table=String(row.table_name);
    if(!tables.has(table)) tables.set(table,new Map());
    tables.get(table).set(String(row.name),{
      name:String(row.name),
      type:normalizeType(row.type),
      notNull:Number(row.not_null)===1,
      primaryKeyPosition:Number(row.pk)||0,
      defaultValue:normalizeSqlDefault(row.dflt_value),
    });
  }
  return tables;
}

function groupIndexes(rows) {
  const indexes=new Map();
  for(const row of rows||[]){
    const name=String(row.index_name);
    if(!indexes.has(name)){
      indexes.set(name,{
        table:String(row.table_name),
        unique:Number(row.is_unique)===1,
        partial:Number(row.partial)===1,
        columns:[],
      });
    }
    if(Number(row.is_key)===1){
      indexes.get(name).columns.push({
        sequence:Number(row.seqno),
        name:row.column_name===null?null:String(row.column_name),
        descending:Number(row.descending)===1,
      });
    }
  }
  for(const index of indexes.values()){
    index.columns.sort((a,b)=>a.sequence-b.sequence);
    index.columns=index.columns.map(({name,descending})=>({name,descending}));
  }
  return indexes;
}

function groupForeignKeys(rows) {
  const grouped=new Map();
  for(const row of rows||[]){
    const table=String(row.table_name);
    const id=Number(row.foreign_key_id);
    const key=`${table}\0${id}`;
    if(!grouped.has(key)){
      grouped.set(key,{
        table,
        fromColumns:[],
        referencedTable:String(row.referenced_table),
        toColumns:[],
        onUpdate:String(row.on_update).toUpperCase(),
        onDelete:String(row.on_delete).toUpperCase(),
        match:String(row.match).toUpperCase(),
        entries:[],
      });
    }
    grouped.get(key).entries.push({
      sequence:Number(row.sequence),
      from:row.from_column===null?null:String(row.from_column),
      to:row.to_column===null?null:String(row.to_column),
    });
  }
  return [...grouped.values()].map(foreignKey=>{
    foreignKey.entries.sort((a,b)=>a.sequence-b.sequence);
    foreignKey.fromColumns=foreignKey.entries.map(entry=>entry.from);
    foreignKey.toColumns=foreignKey.entries.map(entry=>entry.to);
    delete foreignKey.entries;
    return foreignKey;
  });
}

function compareColumn(expected,actual) {
  const mismatches=[];
  if(actual.type!==expected.type){
    mismatches.push({property:'type',expected:expected.type,actual:actual.type});
  }
  // A stricter legacy NOT NULL declaration is compatible; a missing required
  // declaration is not.
  if(expected.notNull&&!actual.notNull){
    mismatches.push({property:'notNull',expected:true,actual:false});
  }
  if(actual.primaryKeyPosition!==expected.primaryKeyPosition){
    mismatches.push({
      property:'primaryKeyPosition',
      expected:expected.primaryKeyPosition,
      actual:actual.primaryKeyPosition,
    });
  }
  if(Object.hasOwn(expected,'defaultValue')&&actual.defaultValue!==expected.defaultValue){
    mismatches.push({
      property:'defaultValue',
      expected:expected.defaultValue,
      actual:actual.defaultValue,
    });
  }
  return mismatches;
}

function hasUniqueConstraint(indexes,{table,columns}) {
  return [...indexes.values()].some(index=>index.table===table && index.unique && !index.partial &&
    index.columns.length===columns.length &&
    index.columns.every((column,position)=>column.name===columns[position]));
}

function sameList(actual,expected) {
  return actual.length===expected.length &&
    actual.every((value,index)=>value===expected[index]);
}

function sameForeignKey(actual,expected) {
  return actual.table===expected.table &&
    actual.referencedTable===expected.referencedTable &&
    sameList(actual.fromColumns,expected.fromColumns) &&
    sameList(actual.toColumns,expected.toColumns) &&
    actual.onUpdate===expected.onUpdate && actual.onDelete===expected.onDelete &&
    actual.match===expected.match;
}

/**
 * Performs SELECT/PRAGMA checks only. It deliberately does not initialize the
 * ledger or repair drift; deploys must run the explicit migration command.
 */
export async function checkDatabaseReadiness(db, options={}) {
  const migrations=options.migrations||MIGRATIONS;
  const latestVersion=migrations.at(-1)?.version||LATEST_SCHEMA_VERSION;
  const result=baseResult(latestVersion);
  if(!db||typeof db.execute!=='function'){
    result.status='unreachable';
    result.reason='database_unreachable';
    result.issues.push(issue('database_unreachable','Database client is unavailable'));
    return result;
  }

  let objects;
  let columnsByTable;
  let indexesByName;
  let foreignKeys;
  try{
    const schema=await db.execute(`SELECT name,type,
        (SELECT foreign_keys FROM pragma_foreign_keys) AS foreign_keys
      FROM sqlite_master WHERE type IN ('table','index')
      UNION ALL
      SELECT NULL AS name,NULL AS type,foreign_keys FROM pragma_foreign_keys
      ORDER BY type,name`);
    objects=schema.rows||[];
    result.foreignKeysEnabled=objects.some(row=>Number(row.foreign_keys)===1);
    const columns=await db.execute(`SELECT m.name AS table_name,p.cid,p.name,p.type,
        p."notnull" AS not_null,p.dflt_value,p.pk
      FROM sqlite_schema m JOIN pragma_table_info(m.name) p
      WHERE m.type='table' ORDER BY m.name,p.cid`);
    columnsByTable=groupColumns(columns.rows);
    const indexes=await db.execute(`SELECT m.name AS index_name,m.tbl_name AS table_name,
        l."unique" AS is_unique,l.partial,x.seqno,x.name AS column_name,
        x."desc" AS descending,x."key" AS is_key
      FROM sqlite_schema m
      JOIN pragma_index_list(m.tbl_name) l ON l.name=m.name
      JOIN pragma_index_xinfo(m.name) x
      WHERE m.type='index' ORDER BY m.name,x.seqno`);
    indexesByName=groupIndexes(indexes.rows);
    const foreignKeyRows=await db.execute(`SELECT m.name AS table_name,
        f.id AS foreign_key_id,f.seq AS sequence,f."table" AS referenced_table,
        f."from" AS from_column,f."to" AS to_column,f.on_update,f.on_delete,f.match
      FROM sqlite_schema m JOIN pragma_foreign_key_list(m.name) f
      WHERE m.type='table' ORDER BY m.name,f.id,f.seq`);
    foreignKeys=groupForeignKeys(foreignKeyRows.rows);
  }catch{
    result.status='unreachable';
    result.reason='database_unreachable';
    result.issues.push(issue('database_unreachable','Database schema could not be read'));
    return result;
  }

  const tables=new Set(objects.filter(row=>row.type==='table').map(row=>String(row.name)));
  const indexes=new Set(objects.filter(row=>row.type==='index').map(row=>String(row.name)));
  result.missingTables=APPLICATION_TABLES.filter(name=>!tables.has(name));
  for(const definition of INDEX_DEFINITIONS){
    if(!indexes.has(definition.name)){
      result.missingIndexes.push(definition.name);
      continue;
    }
    const inspection=inspectIndexCompatibility(definition,indexesByName.get(definition.name));
    if(!inspection.compatible){
      result.missingIndexes.push(definition.name);
      result.indexDrift.push({
        index:definition.name,
        reason:inspection.reason,
        expected:inspection.expected,
        actual:inspection.actual,
      });
    }
  }
  if(!tables.has(SCHEDULE_ARCHIVE_TABLE)) result.missingMigrationArtifacts.push(SCHEDULE_ARCHIVE_TABLE);

  for(const table of APPLICATION_TABLES){
    if(!tables.has(table)) continue;
    const columns=columnsByTable.get(table)||new Map();
    for(const column of REQUIRED_COLUMNS[table]||[]){
      if(!columns.has(column)) result.missingColumns.push(`${table}.${column}`);
    }
    for(const expected of TABLE_CONTRACTS[table]?.columns||[]){
      const actual=columns.get(expected.name);
      if(!actual) continue;
      const mismatches=compareColumn(expected,actual);
      if(mismatches.length){
        result.columnDrift.push({
          table,
          column:expected.name,
          mismatches,
        });
      }
    }
  }
  if(tables.has(SCHEDULE_ARCHIVE_TABLE)){
    const columns=columnsByTable.get(SCHEDULE_ARCHIVE_TABLE)||new Map();
    for(const expected of SCHEDULE_ARCHIVE_CONTRACT.columns){
      const actual=columns.get(expected.name);
      if(!actual){
        result.missingColumns.push(`${SCHEDULE_ARCHIVE_TABLE}.${expected.name}`);
        continue;
      }
      const mismatches=compareColumn(expected,actual);
      if(mismatches.length){
        result.columnDrift.push({
          table:SCHEDULE_ARCHIVE_TABLE,
          column:expected.name,
          mismatches,
        });
      }
    }
  }
  const requiredUniqueConstraints=[
    ...REQUIRED_UNIQUE_CONSTRAINTS,
    ...SCHEDULE_ARCHIVE_CONTRACT.uniqueConstraints.map(columns=>({
      table:SCHEDULE_ARCHIVE_TABLE,
      columns,
    })),
  ];
  result.missingUniqueConstraints=requiredUniqueConstraints
    .filter(constraint=>tables.has(constraint.table)&&!hasUniqueConstraint(indexesByName,constraint))
    .map(({table,columns})=>({table,columns:[...columns]}));
  result.foreignKeyDrift=REQUIRED_FOREIGN_KEYS
    .filter(expected=>tables.has(expected.table)&&
      !foreignKeys.some(actual=>sameForeignKey(actual,expected)))
    .map(expected=>({
      expected,
      actual:foreignKeys.filter(candidate=>candidate.table===expected.table &&
        sameList(candidate.fromColumns,expected.fromColumns)),
    }));

  if(!tables.has(MIGRATION_LEDGER_TABLE)){
    result.status='migration_required';
    result.reason='schema_uninitialized';
    result.pendingVersions=migrations.map(({version})=>version);
    result.issues.push(issue('schema_uninitialized','Migration ledger is missing'));
    return result;
  }

  try{
    const ledgerColumns=columnsByTable.get(MIGRATION_LEDGER_TABLE)||new Map();
    const missingLedgerColumns=LEDGER_COLUMNS.filter(column=>!ledgerColumns.has(column));
    const ledgerColumnDrift=[];
    for(const [name,expected] of Object.entries(MIGRATION_LEDGER_CONTRACT)){
      const actual=ledgerColumns.get(name);
      if(!actual) continue;
      const mismatches=compareColumn(expected,actual);
      if(mismatches.length) ledgerColumnDrift.push({column:name,mismatches});
    }
    if(missingLedgerColumns.length||ledgerColumnDrift.length){
      result.reason='schema_mismatch';
      result.issues.push(issue('schema_mismatch','Migration ledger has an incompatible schema',{
        missingColumns:missingLedgerColumns,
        columnDrift:ledgerColumnDrift,
      }));
      return result;
    }
    const ledger=await db.execute(`SELECT version,name,checksum,applied_at,execution_ms
      FROM ${MIGRATION_LEDGER_TABLE} ORDER BY version`);
    const rows=ledger.rows||[];
    try{
      const state=validateMigrationLedger(rows,migrations);
      result.currentVersion=state.currentVersion;
    }catch(error){
      if(!(error instanceof MigrationLedgerError)) throw error;
      const maxVersion=rows.reduce((max,row)=>Math.max(max,Number(row.version)||0),0);
      result.currentVersion=maxVersion;
      result.reason=maxVersion>latestVersion?'schema_ahead':'schema_mismatch';
      result.issues.push(issue(result.reason,error.message,error.details));
      return result;
    }
  }catch(error){
    if(result.issues.length) return result;
    result.status='unreachable';
    result.reason='database_unreachable';
    result.issues.push(issue('database_unreachable','Migration state could not be read'));
    return result;
  }

  if(result.currentVersion<latestVersion){
    result.status='migration_required';
    result.reason='schema_outdated';
    result.pendingVersions=migrations
      .filter(({version})=>version>result.currentVersion)
      .map(({version})=>version);
    result.issues.push(issue('schema_outdated','Database migrations are pending',{
      currentVersion:result.currentVersion,
      latestVersion,
    }));
    return result;
  }

  if(result.missingTables.length||result.missingIndexes.length||
    result.missingColumns.length||result.columnDrift.length||
    result.missingUniqueConstraints.length||result.foreignKeyDrift.length||
    result.foreignKeysEnabled!==true||
    result.indexDrift.length||
    result.missingMigrationArtifacts.length){
    result.reason='schema_drift';
    result.issues.push(issue('schema_drift','Required database objects or constraints do not match',{
      missingTables:result.missingTables,
      missingIndexes:result.missingIndexes,
      indexDrift:result.indexDrift,
      missingColumns:result.missingColumns,
      columnDrift:result.columnDrift,
      missingUniqueConstraints:result.missingUniqueConstraints,
      foreignKeyDrift:result.foreignKeyDrift,
      foreignKeysEnabled:result.foreignKeysEnabled,
      missingMigrationArtifacts:result.missingMigrationArtifacts,
    }));
    return result;
  }

  result.ready=true;
  result.status='ready';
  result.reason=null;
  return result;
}

export const checkReadiness=checkDatabaseReadiness;
