import { createHash } from 'node:crypto';

import { inspectCompletedMembershipRollout } from '../db/membership-readiness.js';
import { MIGRATION_CONTRACTS } from '../db/migration-contract.js';

const REQUIRED_MIGRATIONS=Object.freeze([
  Object.freeze({version:1,name:'current-application-schema-baseline',checksum:'27944847696265114fbbb0e70ffa961a7f766a8f85cc4fe251ef00a779aac0df'}),
  Object.freeze({version:2,name:'primary-circle-membership-schema',checksum:'ceca22b30cc4f546359dc8d5731e1ab157e82b748b468e6eed510a8a4379444d'}),
  Object.freeze({version:3,name:'cycle-scoped-availability',checksum:'dd467c77944b1da0b722ddd91ebef1071811fb24c65fdff7d2121b67fb204270'}),
  Object.freeze({version:4,name:'provider-scoped-identities',checksum:'99e63a04a8617d4dcc12d5ff71ac8590e21ba5a44bdcaba90ead405f42f5625e'}),
  Object.freeze({version:5,name:'durable-revocable-sessions',checksum:'cad0dcadb3b75ae267dd6d7ff9393507e122f0d104e648357631a1c4af0b98ad'}),
  Object.freeze({version:6,name:'durable-provider-neutral-outbox',checksum:'e62bdb26e9055eeae387e80bbd3dba08130228bf9a42673b2fceecddd9fc2f6b'}),
]);

// Generated from the canonical managed object SQL and the structural projection
// below. The public name remains stable for existing callers, while the value
// advances when a migration changes a projected core table or unique index.
export const PAIRING_SCHEMA_V6_FINGERPRINT='39e2e889b10de0a03cd87fb44c968a57ceb59d83c639720f26c0d93d0e61bce1';

const TOLERATED_TABLES=new Set(['ai_monthly_usage']);
const REQUIRED_TABLES=new Set([
  'schema_migrations','users','auth_accounts','pairing_weeks','pairing_groups',
  'pairing_participants','pairing_week_runs','pairing_email_outbox','questions',
  'custom_questions','video_signals','pair_room_snapshots','pair_messages',
  'pair_schedules','session_runs','ai_sessions','ai_feedback','ai_usage',
  'ai_account_monthly_usage','ai_account_monthly_reservations','ai_consents',
  'app_logs','user_notification_prefs','auth_rate_limits','circles',
  'circle_memberships','circle_invitations','circle_audit_events',
  'circle_membership_rollout','pairing_cycles','pairing_cycle_availability',
  'auth_provider_identities','auth_sessions','outbox_events','outbox_audit_events',
]);
const REQUIRED_INDEXES=new Set([
  'idx_video_signals_room','idx_video_signals_room_id','idx_pair_messages_pair',
  'idx_pair_sched_pair','uq_pair_schedules_week_pair','idx_cq_slug','idx_cq_author',
  'idx_runs_user','idx_runs_question','idx_runs_user_q','idx_runs_pair_activity',
  'idx_messages_pair_activity','idx_pair_room_snapshots_updated_at',
  'idx_logs_level_created','idx_logs_event_created','idx_logs_source_created',
  'idx_logs_created','idx_pairing_email_outbox_pending','idx_pairing_weeks_week_label',
  'uq_auth_accounts_google_sub','uq_circles_active_primary',
  'idx_circle_memberships_user_active','idx_circle_memberships_circle_active',
  'idx_circle_invitations_circle_created','idx_circle_invitations_email',
  'idx_circle_audit_circle_created','idx_pairing_cycle_availability_candidates',
  'idx_auth_sessions_user_active',
  'idx_outbox_events_dispatch','idx_outbox_events_lease','idx_outbox_audit_event',
]);
const LATER_UNIQUE_INDEXES=new Set([
  'uq_pairing_groups_completion_pair','uq_pairing_groups_completion_third',
  'uq_pairing_participants_completion_owner',
]);
const LATER_TRIGGER_DIGESTS=new Map([
  ['trg_pairing_groups_completion_membership_guard','b25b7d3f592529397d0193760d8753e0cc7d2c7ca46a041d8b39d93ca0411f6f'],
  ['trg_pairing_participants_completion_update_guard','27febbcdca9672d871414b66369252e3737661402bb3f9b0780e795464e6356e'],
  ['trg_pairing_participants_completion_delete_guard','26c275263b2adc9bd85d0c1d754a7637227eb5ec5af2b7484d610b575c57e03f'],
  ['trg_pairing_participants_completion_insert_guard','c8e175332e4ca596c03ad144dbe4ca5e7f2b807132534374556f74f383e5e7e1'],
]);
const REQUIRED_OBJECTS=new Set([...REQUIRED_TABLES,...REQUIRED_INDEXES]);

function scalar(value){
  if(value===null||value===undefined) return null;
  return String(value);
}

function projectRows(rows,fields){
  return (rows||[]).map(row=>Object.fromEntries(fields.map(field=>[field,scalar(row?.[field])])));
}

function normalizeSchemaSql(value){
  return scalar(value)?.replace(/\s+/g,' ').trim()||null;
}

function stableJson(value){
  if(Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if(value&&typeof value==='object'){
    return `{${Object.keys(value).sort().map(key=>`${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function digest(value){
  return createHash('sha256').update(stableJson(value)).digest('hex');
}

function quoteIdentifier(value){
  const name=String(value||'');
  if(!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) throw new Error('invalid schema identifier');
  return `"${name}"`;
}

async function readBatch(db,statements){
  if(!statements.length) return [];
  if(typeof db.batch==='function') return db.batch(statements,'read');
  const results=[];
  for(const statement of statements) results.push(await db.execute(statement));
  return results;
}

function validLedgerTimestamp(value){
  return /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(?:\.\d+)?$/.test(String(value||''));
}

async function validateLedger(db){
  const result=await db.execute(`SELECT version,name,checksum,applied_at,execution_ms,disposition
    FROM schema_migrations ORDER BY version`);
  const rows=result.rows||[];
  if(rows.length<REQUIRED_MIGRATIONS.length||rows.length>MIGRATION_CONTRACTS.length) return false;
  let appliedSeen=false;
  for(const [index,row] of rows.entries()){
    const expected=MIGRATION_CONTRACTS[index];
    const executionMs=Number(row?.execution_ms);
    const disposition=String(row?.disposition||'');
    if(Number(row?.version)!==expected.version||String(row?.name)!==expected.name
      ||String(row?.checksum)!==expected.checksum||!validLedgerTimestamp(row?.applied_at)
      ||!Number.isSafeInteger(executionMs)||executionMs<0
      ||!['applied','adopted'].includes(disposition)
      ||(disposition==='adopted'&&(executionMs!==0||appliedSeen))) return false;
    if(disposition==='applied') appliedSeen=true;
  }
  return true;
}

/** Build a data-independent fingerprint using only SELECT and bounded PRAGMA. */
export async function pairingSchemaV6Fingerprint(db){
  if(!db||typeof db.execute!=='function') throw new TypeError('database client required');
  const objectResult=await db.execute(`SELECT type,name,tbl_name,sql FROM sqlite_schema
    WHERE type IN ('table','index','view','trigger') ORDER BY type,name LIMIT 256`);
  if((objectResult.rows||[]).length>=256) throw new Error('schema object limit exceeded');
  const objects=projectRows(objectResult.rows,['type','name','tbl_name','sql'])
    .filter(item=>!String(item.name).startsWith('sqlite_')
      &&!TOLERATED_TABLES.has(String(item.name))
      &&!TOLERATED_TABLES.has(String(item.tbl_name))
      &&!(item.type==='trigger'&&LATER_TRIGGER_DIGESTS.get(String(item.name))===digest(normalizeSchemaSql(item.sql)))
      &&(REQUIRED_OBJECTS.has(String(item.name))
        ||(item.type==='trigger'&&REQUIRED_TABLES.has(String(item.tbl_name)))))
    .map(item=>({...item,sql:normalizeSchemaSql(item.sql)}));
  const tables=objects.filter(item=>item.type==='table').map(item=>item.name).sort();
  const tableMetadata=await readBatch(db,tables.flatMap(table=>{
    const identifier=quoteIdentifier(table);
    return [
      `PRAGMA table_xinfo(${identifier})`,
      `PRAGMA foreign_key_list(${identifier})`,
      `PRAGMA index_list(${identifier})`,
    ];
  }));
  const structure=[];
  const indexRequests=[];
  for(const [tableIndex,table] of tables.entries()){
    const columnsResult=tableMetadata[tableIndex*3];
    const foreignKeysResult=tableMetadata[(tableIndex*3)+1];
    const indexListResult=tableMetadata[(tableIndex*3)+2];
    const indexes=[];
    if((indexListResult.rows||[]).length>64) throw new Error('schema index limit exceeded');
    for(const row of indexListResult.rows||[]){
      const name=String(row.name||'');
      if(LATER_UNIQUE_INDEXES.has(name)) continue;
      if(String(row.origin)==='c'&&!REQUIRED_INDEXES.has(name)&&Number(row.unique)!==1) continue;
      indexes.push({
        name:String(row.origin)==='c'?name:'<automatic>',
        unique:Number(row.unique),partial:Number(row.partial),origin:String(row.origin||''),
        columns:null,
      });
      indexRequests.push({target:indexes.length-1,indexes,sql:`PRAGMA index_xinfo(${quoteIdentifier(name)})`});
    }
    structure.push({
      table,
      columns:projectRows(columnsResult.rows,['cid','name','type','notnull','dflt_value','pk','hidden']),
      foreignKeys:projectRows(foreignKeysResult.rows,
        ['id','seq','table','from','to','on_update','on_delete','match']),
      indexes,
    });
  }
  const indexMetadata=await readBatch(db,indexRequests.map(request=>request.sql));
  for(const [index,request] of indexRequests.entries()){
    request.indexes[request.target].columns=projectRows(indexMetadata[index].rows,
      ['seqno','cid','name','desc','coll','key']);
  }
  for(const item of structure){
    item.indexes.sort((left,right)=>stableJson(left).localeCompare(stableJson(right)));
  }
  return digest({objects,structure});
}

/** Read-only, request-safe verification of the exact managed state needed by publication. */
export async function pairingSchemaV6Ready(db,{requireClosedMembership=false}={}){
  if(!db||typeof db.execute!=='function') return false;
  try{
    const foreignKeys=await db.execute('PRAGMA foreign_keys');
    const checks=await db.execute('PRAGMA ignore_check_constraints');
    if(Number(foreignKeys.rows?.[0]?.foreign_keys)!==1
      ||Number(checks.rows?.[0]?.ignore_check_constraints)!==0
      ||!(await validateLedger(db))) return false;
    if((await pairingSchemaV6Fingerprint(db))!==PAIRING_SCHEMA_V6_FINGERPRINT) return false;
    if(requireClosedMembership){
      const membership=await inspectCompletedMembershipRollout(db);
      if(!membership.ok||membership.registrationState!=='closed') return false;
    }
    return true;
  }catch{
    return false;
  }
}
