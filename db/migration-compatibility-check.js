// Migration-only proof that a migration declared 'additive' in
// migration-contract.js really is additive (ID-87, #371). Readiness tolerates
// a database one additive migration behind the code, so this check is what
// keeps that tolerance safe: the running code must behave the same on the
// schema before and after the migration.
//
// An additive migration may only:
// - create tables whose names are new;
// - create indexes whose names are new, on a new table or (non-unique) on an
//   existing table;
// - create triggers whose names are new, on a new table, whose bodies only
//   read, or write to tables the same migration creates;
// - seed rows into a table the same migration creates.
// It may not drop, rename, alter or rewrite anything that exists, add a unique
// index or trigger to an existing table (both change how the running code's
// writes behave), or use any other operation kind. ALTER TABLE ... ADD COLUMN
// has no executable operation in the runner yet, so it is refused here too;
// adding one means extending the runner, the inspector and this check
// together. Unknown operations and statements fail closed.
import {
  INTRODUCED_ARTIFACT_KINDS,
  MIGRATION_COMPATIBILITY,
  MIGRATION_CONTRACTS,
  validateMigrationContracts,
} from './migration-contract.js';
import { MIGRATION_LEDGER_TABLE } from './migration-ledger-readiness.js';
import { TOLERATED_LEGACY_TABLES } from './schema-manifest.js';

const IDENTIFIER='[A-Z_][A-Z0-9_]*';
// A regex rather than a list of strings, so the Turso SQL check does not read
// the keywords themselves as statements.
const DESTRUCTIVE_VERB=/^(DROP|ALTER|DELETE|UPDATE|REPLACE|TRUNCATE|PRAGMA|ATTACH|DETACH|VACUUM|REINDEX)\b/;
const ARTIFACT_OPERATIONS=Object.freeze({
  'ensure-table':'tables',
  'ensure-index':'indexes',
  'ensure-trigger':'triggers',
});

function quotedIdentifier(inner){
  return new RegExp(`^${IDENTIFIER}$`,'i').test(inner)?inner:'_QUOTED_IDENTIFIER_';
}

/**
 * Upper-cased SQL with comments and string literals removed and quoted
 * identifiers unquoted, so keyword checks cannot be hidden inside a literal
 * and table names cannot be hidden inside quotes.
 */
export function normalizeMigrationSql(sql){
  if(typeof sql!=='string') throw new TypeError('migration SQL must be a string');
  let output='';
  for(let index=0;index<sql.length;){
    const char=sql[index];
    const next=sql[index+1];
    if(char==='-'&&next==='-'){
      const end=sql.indexOf('\n',index);
      index=end===-1?sql.length:end+1;
      output+=' ';
    }else if(char==='/'&&next==='*'){
      const end=sql.indexOf('*/',index+2);
      index=end===-1?sql.length:end+2;
      output+=' ';
    }else if(char==="'"){
      let cursor=index+1;
      while(cursor<sql.length&&!(sql[cursor]==="'"&&sql[cursor+1]!=="'")) cursor+=sql[cursor]==="'"?2:1;
      index=cursor+1;
      output+="''";
    }else if(char==='"'||char==='`'||char==='['){
      const close=char==='['?']':char;
      const end=sql.indexOf(close,index+1);
      const stop=end===-1?sql.length:end;
      output+=quotedIdentifier(sql.slice(index+1,stop));
      index=stop+1;
    }else{
      output+=char;
      index+=1;
    }
  }
  return output.replace(/\s+/g,' ').replace(/\s*;\s*/g,';').trim().toUpperCase();
}

function statements(normalized){
  return normalized.split(';').map(item=>item.trim()).filter(Boolean);
}

// A trigger's own body is judged by triggerViolations; everything else in its
// SQL (the CREATE header and anything after the final END) is scanned here.
function topLevelStatements(kind,sql){
  const parts=statements(sql);
  if(kind!=='ensure-trigger') return parts;
  const end=parts.lastIndexOf('END');
  return parts.length?[parts[0],...(end===-1?[]:parts.slice(end+1))]:[];
}

function statementViolation(statement){
  if(new RegExp(`^ALTER TABLE ${IDENTIFIER} ADD\\b`).test(statement)) return {code:'add_column_unsupported',detail:'ALTER TABLE ADD COLUMN'};
  const verb=DESTRUCTIVE_VERB.exec(statement)?.[1];
  return verb?{code:'destructive_sql',detail:verb}:null;
}

function violation(version,code,{operation=null,name=null,detail=null}={}){
  return Object.freeze({version,code,operation,name,detail});
}

function writeTarget(statement){
  const patterns=[
    new RegExp(`^INSERT (?:OR [A-Z]+ )?INTO (${IDENTIFIER})\\b`),
    new RegExp(`^REPLACE INTO (${IDENTIFIER})\\b`),
    new RegExp(`^UPDATE (?:OR [A-Z]+ )?(${IDENTIFIER})\\b`),
    new RegExp(`^DELETE FROM (${IDENTIFIER})\\b`),
  ];
  for(const pattern of patterns){
    const match=pattern.exec(statement);
    if(match) return match[1];
  }
  return null;
}

// The ledger and retired legacy tables are reserved names but never valid
// targets: nothing may be created on them.
function priorArtifacts(migrations){
  const names=new Set([...TOLERATED_LEGACY_TABLES,MIGRATION_LEDGER_TABLE].map(name=>name.toUpperCase()));
  const tables=new Set();
  for(const migration of migrations){
    for(const operation of migration.operations||[]){
      if(!ARTIFACT_OPERATIONS[operation?.operation]||typeof operation.name!=='string') continue;
      names.add(operation.name.toUpperCase());
      if(operation.operation==='ensure-table') tables.add(operation.name.toUpperCase());
    }
  }
  return {names,tables};
}

function tableViolations(version,operation,sql,prior,created){
  const name=String(operation.name).toUpperCase();
  const parts=statements(sql);
  const match=new RegExp(`^CREATE TABLE (?:IF NOT EXISTS )?(${IDENTIFIER}) ?\\((.*)\\)$`).exec(parts[0]||'');
  if(parts.length!==1||!match||match[1]!==name){
    return [violation(version,'non_canonical_create_table',{operation:operation.operation,name:operation.name})];
  }
  created.add(name);
  return [];
}

function indexViolations(version,operation,sql,prior,created){
  const name=String(operation.name).toUpperCase();
  const parts=statements(sql);
  const match=new RegExp(`^CREATE (UNIQUE )?INDEX (?:IF NOT EXISTS )?(${IDENTIFIER}) ON (${IDENTIFIER}) ?\\(`).exec(parts[0]||'');
  if(parts.length!==1||!match||match[2]!==name||match[3]!==String(operation.table||'').toUpperCase()){
    return [violation(version,'non_canonical_create_index',{operation:operation.operation,name:operation.name})];
  }
  const table=match[3];
  if(created.has(table)) return [];
  if(!prior.tables.has(table)){
    return [violation(version,'index_on_unknown_table',{operation:operation.operation,name:operation.name,detail:table})];
  }
  return match[1]
    ?[violation(version,'unique_index_on_existing_table',{operation:operation.operation,name:operation.name,detail:table})]
    :[];
}

function triggerViolations(version,operation,sql,prior,created){
  const name=String(operation.name).toUpperCase();
  const match=new RegExp(`^CREATE TRIGGER (?:IF NOT EXISTS )?(${IDENTIFIER}) (?:BEFORE |AFTER |INSTEAD OF )?(?:DELETE|INSERT|UPDATE)(?: OF [^;]*?)? ON (${IDENTIFIER})(?: FOR EACH ROW)?(?: WHEN .*?)? BEGIN (.*;)END$`).exec(sql);
  if(!match||match[1]!==name||match[2]!==String(operation.table||'').toUpperCase()){
    return [violation(version,'non_canonical_create_trigger',{operation:operation.operation,name:operation.name})];
  }
  const table=match[2];
  if(!created.has(table)){
    return [violation(version,'trigger_on_existing_table',{operation:operation.operation,name:operation.name,detail:table})];
  }
  const found=[];
  for(const statement of statements(match[3])){
    if(/^SELECT\b/.test(statement)) continue;
    const target=writeTarget(statement);
    if(target===null){
      found.push(violation(version,'unsupported_trigger_statement',{
        operation:operation.operation,name:operation.name,detail:statement.split(' ',1)[0],
      }));
    }else if(!created.has(target)){
      found.push(violation(version,'trigger_writes_existing_table',{
        operation:operation.operation,name:operation.name,detail:target,
      }));
    }
  }
  return found;
}

function rowViolations(version,operation,sql,prior,created){
  const parts=statements(sql);
  const target=parts.length===1?new RegExp(`^INSERT (?:OR IGNORE )?INTO (${IDENTIFIER})\\b`).exec(parts[0])?.[1]:null;
  if(!target||target!==String(operation.table||'').toUpperCase()){
    return [violation(version,'non_canonical_seed_row',{operation:operation.operation,name:operation.name})];
  }
  return created.has(target)
    ?[]
    :[violation(version,'seed_row_in_existing_table',{operation:operation.operation,name:operation.name,detail:target})];
}

const OPERATION_CHECKS=Object.freeze({
  'ensure-table':tableViolations,
  'ensure-index':indexViolations,
  'ensure-trigger':triggerViolations,
  'ensure-row':rowViolations,
});

/**
 * Every reason `migration` is not additive given the migrations before it.
 * An empty list means it is additive. Tables come first so indexes, triggers
 * and seed rows may target tables created anywhere in the same migration.
 */
export function additiveViolations(migration,{previous=[]}={}){
  const version=migration?.version??null;
  const operations=Array.isArray(migration?.operations)?migration.operations:null;
  if(!operations||operations.length===0) return [violation(version,'no_operations')];
  const prior=priorArtifacts(previous);
  const created=new Set();
  const found=[];
  const ordered=[
    ...operations.filter(operation=>operation?.operation==='ensure-table'),
    ...operations.filter(operation=>operation?.operation!=='ensure-table'),
  ];
  for(const operation of ordered){
    const kind=operation?.operation;
    const check=OPERATION_CHECKS[kind];
    if(!check||typeof operation.sql!=='string'){
      found.push(violation(version,'unsupported_operation',{operation:kind??null,name:operation?.name??null}));
      continue;
    }
    const sql=normalizeMigrationSql(operation.sql);
    const refused=topLevelStatements(kind,sql).map(statementViolation).filter(Boolean);
    if(refused.length){
      found.push(...refused.map(item=>violation(version,item.code,{
        operation:kind,name:operation.name??null,detail:item.detail,
      })));
      continue;
    }
    const name=typeof operation.name==='string'?operation.name.toUpperCase():'';
    if(ARTIFACT_OPERATIONS[kind]&&(prior.names.has(name)||name.startsWith('SQLITE_'))){
      found.push(violation(version,'redefines_existing_artifact',{operation:kind,name:operation.name}));
      continue;
    }
    found.push(...check(version,operation,sql,prior,created));
  }
  return found;
}

function introducedViolations(migration,contract){
  const actual=Object.fromEntries(INTRODUCED_ARTIFACT_KINDS.map(kind=>[kind,[]]));
  for(const operation of migration.operations||[]){
    const kind=ARTIFACT_OPERATIONS[operation?.operation];
    if(kind) actual[kind].push(String(operation.name));
  }
  return INTRODUCED_ARTIFACT_KINDS
    .filter(kind=>JSON.stringify([...actual[kind]].sort())!==JSON.stringify([...contract.introduces[kind]].sort()))
    .map(kind=>violation(migration.version,'introduces_mismatch',{detail:kind}));
}

/**
 * Check every migration declared additive against its contract. Migrations
 * may be a prefix of the contracts (the runner passes prefixes); each must be
 * the contract at the same version.
 */
export function inspectMigrationCompatibility({migrations,contracts=MIGRATION_CONTRACTS}={}){
  validateMigrationContracts(contracts);
  if(!Array.isArray(migrations)||migrations.length===0||migrations.length>contracts.length){
    throw new TypeError('migrations must be a non-empty prefix of the migration contracts');
  }
  const found=[];
  migrations.forEach((migration,index)=>{
    const contract=contracts[index];
    if(migration?.version!==contract.version||migration?.name!==contract.name){
      found.push(violation(index+1,'contract_mismatch'));
      return;
    }
    if(contract.compatibility!==MIGRATION_COMPATIBILITY.ADDITIVE) return;
    found.push(...additiveViolations(migration,{previous:migrations.slice(0,index)}));
    found.push(...introducedViolations(migration,contract));
  });
  return Object.freeze(found);
}

export function formatCompatibilityViolation(item){
  const subject=[item.operation,item.name].filter(Boolean).join(' ');
  const detail=item.detail?`: ${item.detail}`:'';
  return `migration ${item.version} is marked additive but ${item.code}${subject?` (${subject}${detail})`:detail}`;
}

export function assertMigrationCompatibility(options){
  const found=inspectMigrationCompatibility(options);
  if(found.length){
    const error=new Error(found.map(formatCompatibilityViolation).join('; '));
    error.code='MIGRATION_COMPATIBILITY_INVALID';
    error.violations=found;
    throw error;
  }
  return true;
}
