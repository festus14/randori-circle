import { MigrationPreflightError } from './errors.js';

/**
 * Canonical application schema.
 *
 * INITIAL_SCHEMA_TABLE_DEFINITIONS and MIGRATION_1_INDEX_DEFINITIONS are the
 * immutable version-1 snapshot. Never edit those definitions after release.
 * Evolve TABLE_DEFINITIONS/INDEX_DEFINITIONS independently and append a new
 * migration whenever the current application schema changes.
 */
export const APPLICATION_TABLES = Object.freeze([
  'auth_accounts',
  'users',
  'pairing_weeks',
  'pairing_groups',
  'questions',
  'video_signals',
  'ai_sessions',
  'ai_feedback',
  'ai_usage',
  'ai_monthly_usage',
  'ai_consents',
  'pair_messages',
  'pair_schedules',
  'custom_questions',
  'app_logs',
  'session_runs',
  'user_notification_prefs',
  'auth_rate_limits',
  'pairing_week_runs',
  'pairing_participants',
  'pairing_email_outbox',
  'pair_room_snapshots',
]);

export const INITIAL_SCHEMA_TABLE_DEFINITIONS = Object.freeze([
  Object.freeze({
    name: 'auth_accounts',
    sql: `CREATE TABLE IF NOT EXISTS auth_accounts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      email TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      display_name TEXT NOT NULL,
      color TEXT NOT NULL,
      created_at TEXT DEFAULT (datetime('now')),
      last_login TEXT,
      is_available INTEGER DEFAULT 1,
      availability_updated_at TEXT,
      is_admin INTEGER DEFAULT 0,
      is_demo INTEGER DEFAULT 0,
      bio TEXT,
      tz TEXT,
      interview_focus TEXT DEFAULT 'both',
      leetcode_handle TEXT,
      phone TEXT,
      google_sub TEXT
    )`,
    columns: Object.freeze(['id','email','password_hash','display_name','color','created_at','last_login','is_available','availability_updated_at','is_admin','is_demo','bio','tz','interview_focus','leetcode_handle','phone','google_sub']),
  }),
  Object.freeze({
    name: 'users',
    sql: `CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      color TEXT NOT NULL,
      created_at TEXT DEFAULT (datetime('now'))
    )`,
    columns: Object.freeze(['id','name','color','created_at']),
  }),
  Object.freeze({
    name: 'pairing_weeks',
    sql: `CREATE TABLE IF NOT EXISTS pairing_weeks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      week_label TEXT NOT NULL,
      week_start TEXT NOT NULL,
      focus TEXT NOT NULL DEFAULT 'both',
      created_at TEXT DEFAULT (datetime('now')),
      is_demo INTEGER DEFAULT 0
    )`,
    columns: Object.freeze(['id','week_label','week_start','focus','created_at','is_demo']),
  }),
  Object.freeze({
    name: 'pairing_groups',
    sql: `CREATE TABLE IF NOT EXISTS pairing_groups (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      week_id INTEGER NOT NULL,
      user_a_id INTEGER NOT NULL,
      user_b_id INTEGER NOT NULL,
      user_c_id INTEGER,
      is_ai_pair INTEGER DEFAULT 0,
      topic TEXT DEFAULT 'Pick together',
      topic_kind TEXT DEFAULT 'both',
      created_at TEXT DEFAULT (datetime('now'))
    )`,
    columns: Object.freeze(['id','week_id','user_a_id','user_b_id','user_c_id','is_ai_pair','topic','topic_kind','created_at']),
  }),
  Object.freeze({
    name: 'questions',
    sql: `CREATE TABLE IF NOT EXISTS questions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      slug TEXT UNIQUE NOT NULL,
      title TEXT NOT NULL,
      type TEXT NOT NULL,
      difficulty TEXT NOT NULL,
      category TEXT NOT NULL,
      description TEXT NOT NULL
    )`,
    columns: Object.freeze(['id','slug','title','type','difficulty','category','description']),
  }),
  Object.freeze({
    name: 'video_signals',
    sql: `CREATE TABLE IF NOT EXISTS video_signals (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      room_id TEXT NOT NULL,
      from_id TEXT NOT NULL,
      to_id TEXT,
      type TEXT NOT NULL,
      payload TEXT NOT NULL,
      created_at TEXT DEFAULT (datetime('now'))
    )`,
    columns: Object.freeze(['id','room_id','from_id','to_id','type','payload','created_at']),
  }),
  Object.freeze({
    name: 'ai_sessions',
    sql: `CREATE TABLE IF NOT EXISTS ai_sessions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      room_id TEXT,
      pair_label TEXT,
      transcript TEXT,
      code_snapshots TEXT,
      interviewer_questions TEXT,
      started_at TEXT DEFAULT (datetime('now')),
      ended_at TEXT,
      duration_sec INTEGER,
      cost_cents INTEGER DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now')),
      created_by INTEGER
    )`,
    columns: Object.freeze(['id','room_id','pair_label','transcript','code_snapshots','interviewer_questions','started_at','ended_at','duration_sec','cost_cents','created_at','created_by']),
  }),
  Object.freeze({
    name: 'ai_feedback',
    sql: `CREATE TABLE IF NOT EXISTS ai_feedback (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id INTEGER NOT NULL REFERENCES ai_sessions(id) ON DELETE CASCADE,
      role TEXT DEFAULT 'both',
      feedback_json TEXT NOT NULL,
      evidence TEXT,
      model_used TEXT,
      reason_for_pick TEXT,
      estimated_cost_cents INTEGER,
      confidence REAL DEFAULT 0.85,
      created_at TEXT DEFAULT (datetime('now'))
    )`,
    columns: Object.freeze(['id','session_id','role','feedback_json','evidence','model_used','reason_for_pick','estimated_cost_cents','confidence','created_at']),
  }),
  Object.freeze({
    name: 'ai_usage',
    sql: `CREATE TABLE IF NOT EXISTS ai_usage (
      date TEXT PRIMARY KEY,
      calls INTEGER DEFAULT 0,
      tokens_in INTEGER DEFAULT 0,
      tokens_out INTEGER DEFAULT 0,
      updated_at TEXT DEFAULT (datetime('now'))
    )`,
    columns: Object.freeze(['date','calls','tokens_in','tokens_out','updated_at']),
  }),
  Object.freeze({
    name: 'ai_monthly_usage',
    sql: `CREATE TABLE IF NOT EXISTS ai_monthly_usage (
      month TEXT PRIMARY KEY,
      user_id INTEGER,
      calls INTEGER DEFAULT 0,
      tokens_in INTEGER DEFAULT 0,
      updated_at TEXT DEFAULT (datetime('now'))
    )`,
    columns: Object.freeze(['month','user_id','calls','tokens_in','updated_at']),
  }),
  Object.freeze({
    name: 'ai_consents',
    sql: `CREATE TABLE IF NOT EXISTS ai_consents (
      user_id INTEGER PRIMARY KEY,
      consented_at TEXT NOT NULL DEFAULT (datetime('now')),
      revoked_at TEXT,
      policy_version TEXT NOT NULL
    )`,
    columns: Object.freeze(['user_id','consented_at','revoked_at','policy_version']),
  }),
  Object.freeze({
    name: 'pair_messages',
    sql: `CREATE TABLE IF NOT EXISTS pair_messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      week_id INTEGER NOT NULL,
      pair_group_id INTEGER NOT NULL,
      sender_id INTEGER NOT NULL,
      message TEXT NOT NULL,
      created_at TEXT DEFAULT (datetime('now'))
    )`,
    columns: Object.freeze(['id','week_id','pair_group_id','sender_id','message','created_at']),
  }),
  Object.freeze({
    name: 'pair_schedules',
    sql: `CREATE TABLE IF NOT EXISTS pair_schedules (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      week_id INTEGER NOT NULL,
      pair_group_id INTEGER NOT NULL,
      proposed_times TEXT,
      agreed_time TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    )`,
    columns: Object.freeze(['id','week_id','pair_group_id','proposed_times','agreed_time','created_at','updated_at']),
  }),
  Object.freeze({
    name: 'custom_questions',
    sql: `CREATE TABLE IF NOT EXISTS custom_questions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      slug TEXT UNIQUE NOT NULL,
      title TEXT NOT NULL,
      type TEXT DEFAULT 'dsa',
      difficulty TEXT DEFAULT 'Medium',
      category TEXT DEFAULT 'custom',
      description TEXT NOT NULL,
      input_format TEXT,
      constraints_text TEXT,
      examples TEXT,
      test_cases TEXT NOT NULL,
      starter_per_lang TEXT,
      author_id INTEGER,
      source TEXT DEFAULT 'custom',
      leetcode_slug TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    )`,
    columns: Object.freeze(['id','slug','title','type','difficulty','category','description','input_format','constraints_text','examples','test_cases','starter_per_lang','author_id','source','leetcode_slug','created_at']),
  }),
  Object.freeze({
    name: 'app_logs',
    sql: `CREATE TABLE IF NOT EXISTS app_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      level TEXT,
      source TEXT,
      event TEXT,
      message TEXT,
      meta_json TEXT,
      user_id INTEGER,
      route TEXT,
      ua TEXT,
      ip TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    )`,
    columns: Object.freeze(['id','level','source','event','message','meta_json','user_id','route','ua','ip','created_at']),
  }),
  Object.freeze({
    name: 'session_runs',
    sql: `CREATE TABLE IF NOT EXISTS session_runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER,
      week_id INTEGER,
      pair_group_id INTEGER,
      question_id INTEGER,
      question_slug TEXT,
      language TEXT,
      code TEXT NOT NULL,
      test_cases_snapshot TEXT,
      results_json TEXT,
      passed_count INTEGER DEFAULT 0,
      total_count INTEGER DEFAULT 0,
      duration_ms INTEGER,
      created_at TEXT DEFAULT (datetime('now'))
    )`,
    columns: Object.freeze(['id','user_id','week_id','pair_group_id','question_id','question_slug','language','code','test_cases_snapshot','results_json','passed_count','total_count','duration_ms','created_at']),
  }),
  Object.freeze({
    name: 'user_notification_prefs',
    sql: `CREATE TABLE IF NOT EXISTS user_notification_prefs (
      user_id INTEGER PRIMARY KEY,
      email_enabled INTEGER DEFAULT 1,
      sms_enabled INTEGER DEFAULT 0,
      phone TEXT,
      email TEXT,
      updated_at TEXT DEFAULT (datetime('now'))
    )`,
    columns: Object.freeze(['user_id','email_enabled','sms_enabled','phone','email','updated_at']),
  }),
  Object.freeze({
    name: 'auth_rate_limits',
    sql: `CREATE TABLE IF NOT EXISTS auth_rate_limits (
      key TEXT PRIMARY KEY,
      attempts INTEGER NOT NULL DEFAULT 0,
      expires_at INTEGER NOT NULL
    )`,
    columns: Object.freeze(['key','attempts','expires_at']),
  }),
  Object.freeze({
    name: 'pairing_week_runs',
    sql: `CREATE TABLE IF NOT EXISTS pairing_week_runs (
      week_label TEXT PRIMARY KEY,
      week_id INTEGER,
      generation_token TEXT NOT NULL,
      generation INTEGER NOT NULL DEFAULT 1,
      algorithm_version TEXT NOT NULL,
      algorithm_seed TEXT NOT NULL,
      participant_count INTEGER NOT NULL,
      participants_json TEXT NOT NULL,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    )`,
    columns: Object.freeze(['week_label','week_id','generation_token','generation','algorithm_version','algorithm_seed','participant_count','participants_json','created_at','updated_at']),
  }),
  Object.freeze({
    name: 'pairing_participants',
    sql: `CREATE TABLE IF NOT EXISTS pairing_participants (
      week_id INTEGER NOT NULL,
      user_id INTEGER NOT NULL,
      position INTEGER NOT NULL,
      source TEXT NOT NULL DEFAULT 'auth',
      created_at TEXT DEFAULT (datetime('now')),
      PRIMARY KEY (week_id, user_id)
    )`,
    columns: Object.freeze(['week_id','user_id','position','source','created_at']),
  }),
  Object.freeze({
    name: 'pairing_email_outbox',
    sql: `CREATE TABLE IF NOT EXISTS pairing_email_outbox (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      week_id INTEGER NOT NULL,
      user_id INTEGER NOT NULL,
      kind TEXT NOT NULL,
      recipient_email TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      attempt_count INTEGER NOT NULL DEFAULT 0,
      claimed_at TEXT,
      sent_at TEXT,
      provider_message_id TEXT,
      last_error TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now')),
      UNIQUE (week_id, user_id, kind)
    )`,
    columns: Object.freeze(['id','week_id','user_id','kind','recipient_email','status','attempt_count','claimed_at','sent_at','provider_message_id','last_error','created_at','updated_at']),
  }),
  Object.freeze({
    name: 'pair_room_snapshots',
    sql: `CREATE TABLE IF NOT EXISTS pair_room_snapshots (
      room_id TEXT PRIMARY KEY,
      week_id INTEGER NOT NULL,
      pair_group_id INTEGER NOT NULL,
      revision INTEGER NOT NULL,
      schema_version INTEGER NOT NULL,
      client_id TEXT NOT NULL,
      client_seq INTEGER NOT NULL,
      language TEXT NOT NULL,
      question_id TEXT NOT NULL,
      code TEXT NOT NULL,
      updated_by INTEGER NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE (week_id, pair_group_id),
      FOREIGN KEY (pair_group_id) REFERENCES pairing_groups(id) ON DELETE CASCADE
    )`,
    columns: Object.freeze(['room_id','week_id','pair_group_id','revision','schema_version','client_id','client_seq','language','question_id','code','updated_by','created_at','updated_at']),
  }),
]);

// This is the current schema contract used by readiness. It deliberately has
// its own array so later migrations can extend or replace definitions without
// rewriting the immutable version-1 migration snapshot above.
export const TABLE_DEFINITIONS = Object.freeze([
  ...INITIAL_SCHEMA_TABLE_DEFINITIONS,
]);

function indexDefinition({name,table,columns,sql,unique=false,stage}) {
  const value={name,table,columns:Object.freeze([...columns]),unique,sql};
  if(stage) value.stage=stage;
  return Object.freeze(value);
}

export const MIGRATION_1_INDEX_DEFINITIONS = Object.freeze([
  indexDefinition({name:'idx_video_signals_room',table:'video_signals',columns:['room_id','created_at'],sql:'CREATE INDEX IF NOT EXISTS idx_video_signals_room ON video_signals(room_id, created_at)'}),
  indexDefinition({name:'idx_video_signals_room_id',table:'video_signals',columns:['room_id','id'],sql:'CREATE INDEX IF NOT EXISTS idx_video_signals_room_id ON video_signals(room_id, id)'}),
  indexDefinition({name:'idx_pair_messages_pair',table:'pair_messages',columns:['pair_group_id','created_at'],sql:'CREATE INDEX IF NOT EXISTS idx_pair_messages_pair ON pair_messages(pair_group_id, created_at)'}),
  indexDefinition({name:'idx_pair_sched_pair',table:'pair_schedules',columns:['pair_group_id'],sql:'CREATE INDEX IF NOT EXISTS idx_pair_sched_pair ON pair_schedules(pair_group_id)'}),
  indexDefinition({name:'idx_cq_slug',table:'custom_questions',columns:['slug'],sql:'CREATE INDEX IF NOT EXISTS idx_cq_slug ON custom_questions(slug)'}),
  indexDefinition({name:'idx_cq_author',table:'custom_questions',columns:['author_id'],sql:'CREATE INDEX IF NOT EXISTS idx_cq_author ON custom_questions(author_id)'}),
  indexDefinition({name:'idx_runs_user',table:'session_runs',columns:['user_id','created_at DESC'],sql:'CREATE INDEX IF NOT EXISTS idx_runs_user ON session_runs(user_id, created_at DESC)'}),
  indexDefinition({name:'idx_runs_question',table:'session_runs',columns:['question_slug'],sql:'CREATE INDEX IF NOT EXISTS idx_runs_question ON session_runs(question_slug)'}),
  indexDefinition({name:'idx_runs_user_q',table:'session_runs',columns:['user_id','question_slug'],sql:'CREATE INDEX IF NOT EXISTS idx_runs_user_q ON session_runs(user_id, question_slug)'}),
  indexDefinition({name:'idx_logs_level_created',table:'app_logs',columns:['level','created_at DESC'],sql:'CREATE INDEX IF NOT EXISTS idx_logs_level_created ON app_logs(level, created_at DESC)'}),
  indexDefinition({name:'idx_logs_event_created',table:'app_logs',columns:['event','created_at DESC'],sql:'CREATE INDEX IF NOT EXISTS idx_logs_event_created ON app_logs(event, created_at DESC)'}),
  indexDefinition({name:'idx_logs_source_created',table:'app_logs',columns:['source','created_at DESC'],sql:'CREATE INDEX IF NOT EXISTS idx_logs_source_created ON app_logs(source, created_at DESC)'}),
  indexDefinition({name:'idx_logs_created',table:'app_logs',columns:['created_at DESC'],sql:'CREATE INDEX IF NOT EXISTS idx_logs_created ON app_logs(created_at DESC)'}),
  indexDefinition({name:'idx_pairing_email_outbox_pending',table:'pairing_email_outbox',columns:['week_id','status','created_at'],sql:'CREATE INDEX IF NOT EXISTS idx_pairing_email_outbox_pending ON pairing_email_outbox(week_id, status, created_at)'}),
]);

export const PAIR_SCHEDULE_UNIQUE_INDEX_DEFINITION=indexDefinition({
  name:'uq_pair_schedules_week_pair',
  table:'pair_schedules',
  columns:['week_id','pair_group_id'],
  unique:true,
  sql:'CREATE UNIQUE INDEX IF NOT EXISTS uq_pair_schedules_week_pair ON pair_schedules(week_id, pair_group_id)',
  stage:'schedule',
});

export const PAIRING_WEEK_UNIQUE_INDEX_DEFINITION=indexDefinition({
  name:'idx_pairing_weeks_week_label',
  table:'pairing_weeks',
  columns:['week_label'],
  unique:true,
  sql:'CREATE UNIQUE INDEX IF NOT EXISTS idx_pairing_weeks_week_label ON pairing_weeks(week_label)',
  stage:'pairing-week',
});

export const INDEX_DEFINITIONS = Object.freeze([
  ...MIGRATION_1_INDEX_DEFINITIONS,
  PAIR_SCHEDULE_UNIQUE_INDEX_DEFINITION,
  PAIRING_WEEK_UNIQUE_INDEX_DEFINITION,
]);

export const MIGRATION_2_LEGACY_COLUMN_ADDITIONS = Object.freeze([
  Object.freeze({table:'auth_accounts',column:'is_available',definition:'INTEGER DEFAULT 1'}),
  Object.freeze({table:'auth_accounts',column:'availability_updated_at',definition:'TEXT'}),
  Object.freeze({table:'auth_accounts',column:'is_admin',definition:'INTEGER DEFAULT 0'}),
  Object.freeze({table:'auth_accounts',column:'is_demo',definition:'INTEGER DEFAULT 0'}),
  Object.freeze({table:'auth_accounts',column:'bio',definition:'TEXT'}),
  Object.freeze({table:'auth_accounts',column:'tz',definition:'TEXT'}),
  Object.freeze({table:'auth_accounts',column:'interview_focus',definition:"TEXT DEFAULT 'both'"}),
  Object.freeze({table:'auth_accounts',column:'leetcode_handle',definition:'TEXT'}),
  Object.freeze({table:'auth_accounts',column:'phone',definition:'TEXT'}),
  Object.freeze({table:'auth_accounts',column:'google_sub',definition:'TEXT'}),
  Object.freeze({table:'pairing_weeks',column:'is_demo',definition:'INTEGER DEFAULT 0'}),
  Object.freeze({table:'pairing_week_runs',column:'generation',definition:'INTEGER NOT NULL DEFAULT 1'}),
]);

export const LEGACY_COLUMN_ADDITIONS=MIGRATION_2_LEGACY_COLUMN_ADDITIONS;

export const REQUIRED_COLUMNS = Object.freeze(Object.fromEntries(
  TABLE_DEFINITIONS.map(({name,columns}) => [name, columns]),
));

export const REQUIRED_INDEXES = Object.freeze(INDEX_DEFINITIONS.map(({name}) => name));

function splitSqlList(value) {
  const parts=[];
  let start=0;
  let depth=0;
  let quote=null;
  for(let index=0;index<value.length;index+=1){
    const character=value[index];
    if(quote){
      if(character===quote){
        if(value[index+1]===quote) index+=1;
        else quote=null;
      }
      continue;
    }
    if(character==="'"||character==='"'){
      quote=character;
      continue;
    }
    if(character==='(') depth+=1;
    else if(character===')') depth-=1;
    else if(character===','&&depth===0){
      parts.push(value.slice(start,index).trim());
      start=index+1;
    }
  }
  parts.push(value.slice(start).trim());
  return parts.filter(Boolean);
}

function unquoteIdentifier(value) {
  return value.trim().replace(/^[`"\[]|[`"\]]$/g,'');
}

function parseIdentifierList(value) {
  return splitSqlList(value).map(part=>unquoteIdentifier(part.split(/\s+/)[0]));
}

function referentialAction(fragment,kind) {
  const match=new RegExp(`\\bON\\s+${kind}\\s+(NO\\s+ACTION|SET\\s+NULL|SET\\s+DEFAULT|CASCADE|RESTRICT)\\b`,'i')
    .exec(fragment);
  return (match?.[1]||'NO ACTION').toUpperCase().replace(/\s+/g,' ');
}

function foreignKeyContract({table,fromColumns,referencedTable,toColumns,fragment}) {
  return Object.freeze({
    table,
    fromColumns:Object.freeze(fromColumns),
    referencedTable,
    toColumns:Object.freeze(toColumns),
    onUpdate:referentialAction(fragment,'UPDATE'),
    onDelete:referentialAction(fragment,'DELETE'),
    match:'NONE',
  });
}

function readDefaultExpression(fragment) {
  const match=/\bDEFAULT\b/i.exec(fragment);
  if(!match) return undefined;
  let index=match.index+match[0].length;
  while(/\s/.test(fragment[index]||'')) index+=1;
  const start=index;
  const first=fragment[index];
  if(first==="'"||first==='"'){
    index+=1;
    while(index<fragment.length){
      if(fragment[index]===first){
        if(fragment[index+1]===first){ index+=2; continue; }
        index+=1;
        break;
      }
      index+=1;
    }
    return fragment.slice(start,index);
  }
  if(first==='('){
    let depth=0;
    let quote=null;
    for(;index<fragment.length;index+=1){
      const character=fragment[index];
      if(quote){
        if(character===quote){
          if(fragment[index+1]===quote) index+=1;
          else quote=null;
        }
      }else if(character==="'"||character==='"') quote=character;
      else if(character==='(') depth+=1;
      else if(character===')'&&--depth===0) return fragment.slice(start,index+1);
    }
  }
  while(index<fragment.length&&!/\s|,/.test(fragment[index])) index+=1;
  return fragment.slice(start,index);
}

/** Normalizes the form SQLite exposes through PRAGMA table_info. */
export function normalizeSqlDefault(value) {
  if(value===null||value===undefined) return null;
  let normalized=String(value).trim();
  while(normalized.startsWith('(')&&normalized.endsWith(')')){
    let depth=0;
    let wraps=true;
    let quote=null;
    for(let index=0;index<normalized.length;index+=1){
      const character=normalized[index];
      if(quote){
        if(character===quote){
          if(normalized[index+1]===quote) index+=1;
          else quote=null;
        }
        continue;
      }
      if(character==="'"||character==='"') quote=character;
      else if(character==='(') depth+=1;
      else if(character===')'){
        depth-=1;
        if(depth===0&&index!==normalized.length-1){ wraps=false; break; }
      }
    }
    if(!wraps||depth!==0) break;
    normalized=normalized.slice(1,-1).trim();
  }
  return normalized.replace(/\s+/g,' ');
}

export function buildTableContract(definition) {
  const body=definition.sql.slice(
    definition.sql.indexOf('(')+1,
    definition.sql.lastIndexOf(')'),
  );
  const columns=[];
  const primaryKey=[];
  const uniqueConstraints=[];
  const foreignKeys=[];
  for(const fragment of splitSqlList(body)){
    const tablePrimaryKey=/^PRIMARY\s+KEY\s*\(([^)]+)\)/i.exec(fragment);
    if(tablePrimaryKey){
      primaryKey.push(...parseIdentifierList(tablePrimaryKey[1]));
      continue;
    }
    const tableUnique=/^UNIQUE\s*\(([^)]+)\)/i.exec(fragment);
    if(tableUnique){
      uniqueConstraints.push(Object.freeze(parseIdentifierList(tableUnique[1])));
      continue;
    }
    const tableForeignKey=/^FOREIGN\s+KEY\s*\(([^)]+)\)\s+REFERENCES\s+[`"\[]?([a-z][a-z0-9_]*)[`"\]]?\s*\(([^)]+)\)([\s\S]*)$/i.exec(fragment);
    if(tableForeignKey){
      foreignKeys.push(foreignKeyContract({
        table:definition.name,
        fromColumns:parseIdentifierList(tableForeignKey[1]),
        referencedTable:tableForeignKey[2],
        toColumns:parseIdentifierList(tableForeignKey[3]),
        fragment:tableForeignKey[4],
      }));
      continue;
    }
    if(/^(?:CHECK|CONSTRAINT)\b/i.test(fragment)) continue;
    const columnMatch=/^[`"\[]?([a-z][a-z0-9_]*)[`"\]]?\s+([a-z][a-z0-9_]*(?:\s*\([^)]*\))?)([\s\S]*)$/i.exec(fragment);
    if(!columnMatch) throw new TypeError(`Could not parse schema column: ${fragment}`);
    const [,name,type,remainder]=columnMatch;
    const defaultExpression=readDefaultExpression(remainder);
    const column={
      name,
      type:type.trim().toUpperCase().replace(/\s+/g,' '),
      notNull:/\bNOT\s+NULL\b/i.test(remainder),
      primaryKeyPosition:/\bPRIMARY\s+KEY\b/i.test(remainder)?1:0,
    };
    if(defaultExpression!==undefined) column.defaultValue=normalizeSqlDefault(defaultExpression);
    if(/\bUNIQUE\b/i.test(remainder)) uniqueConstraints.push(Object.freeze([name]));
    const inlineForeignKey=/\bREFERENCES\s+[`"\[]?([a-z][a-z0-9_]*)[`"\]]?\s*\(([^)]+)\)([\s\S]*)$/i.exec(remainder);
    if(inlineForeignKey){
      foreignKeys.push(foreignKeyContract({
        table:definition.name,
        fromColumns:[name],
        referencedTable:inlineForeignKey[1],
        toColumns:parseIdentifierList(inlineForeignKey[2]),
        fragment:inlineForeignKey[3],
      }));
    }
    columns.push(column);
  }
  if(primaryKey.length){
    for(const [position,name] of primaryKey.entries()){
      const column=columns.find(candidate=>candidate.name===name);
      if(!column) throw new TypeError(`Unknown primary-key column ${definition.name}.${name}`);
      column.primaryKeyPosition=position+1;
    }
  }
  return Object.freeze({
    name:definition.name,
    columns:Object.freeze(columns.map(column=>Object.freeze(column))),
    uniqueConstraints:Object.freeze(uniqueConstraints),
    foreignKeys:Object.freeze(foreignKeys),
  });
}

/**
 * Semantic table contracts used by readiness. Nullable columns deliberately
 * accept a legacy NOT NULL declaration, while required NOT NULL declarations,
 * types, primary-key positions, and stable defaults are enforced.
 */
export const TABLE_CONTRACTS = Object.freeze(Object.fromEntries(
  TABLE_DEFINITIONS.map(definition=>{
    const contract=buildTableContract(definition);
    return [contract.name,contract];
  }),
));

export const REQUIRED_UNIQUE_CONSTRAINTS = Object.freeze(TABLE_DEFINITIONS.flatMap(({name})=>
  TABLE_CONTRACTS[name].uniqueConstraints.map(columns=>Object.freeze({table:name,columns})),
));

export const REQUIRED_FOREIGN_KEYS = Object.freeze(TABLE_DEFINITIONS.flatMap(({name})=>
  TABLE_CONTRACTS[name].foreignKeys,
));

function assertIdentifier(value) {
  if(!/^[a-z][a-z0-9_]*$/.test(value)) throw new TypeError(`Unsafe SQL identifier: ${value}`);
  return value;
}

export function expectedIndexColumns(definition) {
  return definition.columns.map(value=>{
    const match=/^([a-z][a-z0-9_]*)(?:\s+(ASC|DESC))?$/i.exec(value);
    if(!match) throw new TypeError(`Invalid index column definition: ${value}`);
    return {name:match[1],descending:(match[2]||'ASC').toUpperCase()==='DESC'};
  });
}

export function inspectIndexCompatibility(definition, actual) {
  const expected={
    table:definition.table,
    unique:Boolean(definition.unique),
    partial:false,
    columns:expectedIndexColumns(definition),
  };
  if(!actual) return {exists:false,compatible:false,reason:'missing',expected};
  const compatible=actual.table===expected.table &&
    actual.unique===expected.unique && actual.partial===expected.partial &&
    actual.columns.length===expected.columns.length &&
    actual.columns.every((column,index)=>column.name===expected.columns[index].name &&
      column.descending===expected.columns[index].descending);
  return {
    exists:true,
    compatible,
    reason:compatible?null:'definition_mismatch',
    actual,
    expected,
  };
}

export async function inspectIndexDefinition(db, definition) {
  const name=assertIdentifier(definition.name);
  const table=assertIdentifier(definition.table);
  const object=await db.execute({
    sql:`SELECT type,tbl_name FROM sqlite_master WHERE name=? LIMIT 1`,
    args:[name],
  });
  if(!object.rows?.length) return {exists:false,compatible:false,reason:'missing'};
  const objectRow=object.rows[0];
  if(String(objectRow.type)!=='index'||String(objectRow.tbl_name)!==table){
    return {
      exists:true,
      compatible:false,
      reason:'object_mismatch',
      actual:{type:String(objectRow.type),table:String(objectRow.tbl_name)},
    };
  }

  const indexList=await db.execute(`PRAGMA index_list("${table}")`);
  const listRow=(indexList.rows||[]).find(row=>String(row.name)===name);
  if(!listRow){
    return {exists:true,compatible:false,reason:'index_metadata_missing'};
  }
  const unique=Number(listRow.unique)===1;
  const partial=Number(listRow.partial)===1;
  const indexInfo=await db.execute(`PRAGMA index_xinfo("${name}")`);
  const actualColumns=(indexInfo.rows||[])
    .filter(row=>Number(row.key)===1)
    .sort((a,b)=>Number(a.seqno)-Number(b.seqno))
    .map(row=>({name:row.name===null?null:String(row.name),descending:Number(row.desc)===1}));
  return inspectIndexCompatibility(definition,{table,unique,partial,columns:actualColumns});
}

export async function assertCompatibleExistingIndex(db, definition) {
  const inspection=await inspectIndexDefinition(db,definition);
  if(inspection.exists&&!inspection.compatible){
    throw new MigrationPreflightError(
      `Existing index ${definition.name} does not match the required definition`,
      {index:definition.name,reason:inspection.reason,actual:inspection.actual,expected:inspection.expected},
    );
  }
  return inspection;
}
