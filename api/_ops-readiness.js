const readinessByClient=new WeakMap();

function clientReadiness(db){
  if(!db||typeof db.execute!=='function') throw new TypeError('database client is required');
  let readiness=readinessByClient.get(db);
  if(!readiness){
    readiness=new Map();
    readinessByClient.set(db,readiness);
  }
  return readiness;
}

async function ensureReadiness(db,key,probe){
  const readiness=clientReadiness(db);
  const existing=readiness.get(key);
  if(existing) return existing;
  const pending=probe(db);
  readiness.set(key,pending);
  try{ return await pending; }
  catch(error){
    if(readiness.get(key)===pending) readiness.delete(key);
    throw error;
  }
}

function requirePrimaryKey(result,expected){
  const actual=(result?.rows||[])
    .map(row=>({name:String(row?.name||''),position:Number(row?.pk)}))
    .filter(column=>Number.isSafeInteger(column.position)&&column.position>0)
    .sort((left,right)=>left.position-right.position)
    .map(column=>column.name);
  if(actual.length!==expected.length||actual.some((name,index)=>name!==expected[index])){
    throw new Error('operations schema constraint unavailable');
  }
}

function requireUniqueIndex(result,expected,{name=null}={}){
  const indexes=new Map();
  for(const row of result?.rows||[]){
    if(Number(row?.is_unique)!==1||Number(row?.partial)!==0) continue;
    const indexName=String(row?.index_name||'');
    if(!indexName) continue;
    const columns=indexes.get(indexName)||[];
    columns.push({name:String(row?.column_name||''),position:Number(row?.seqno)});
    indexes.set(indexName,columns);
  }
  const ready=[...indexes].some(([indexName,columns])=>{
    if(name&&indexName!==name) return false;
    const ordered=columns.sort((left,right)=>left.position-right.position).map(column=>column.name);
    return ordered.length===expected.length&&ordered.every((column,index)=>column===expected[index]);
  });
  if(!ready) throw new Error('operations schema constraint unavailable');
}

async function probeAuthAccountWriteConstraints(db){
  requirePrimaryKey(
    await db.execute(`SELECT name,pk FROM pragma_table_info('auth_accounts') WHERE pk>0 ORDER BY pk`),
    ['id'],
  );
  requireUniqueIndex(
    await db.execute(`SELECT list.name AS index_name,list."unique" AS is_unique,
      list.partial,info.seqno,info.name AS column_name
      FROM pragma_index_list('auth_accounts') AS list
      JOIN pragma_index_info(list.name) AS info
      WHERE list."unique"=1 AND list.partial=0
      ORDER BY list.seq,info.seqno`),
    ['email'],
  );
}

async function probePairingWriteConstraints(db){
  requirePrimaryKey(
    await db.execute(`SELECT name,pk FROM pragma_table_info('pairing_week_runs') WHERE pk>0 ORDER BY pk`),
    ['week_label'],
  );
  requirePrimaryKey(
    await db.execute(`SELECT name,pk FROM pragma_table_info('pairing_participants') WHERE pk>0 ORDER BY pk`),
    ['week_id','user_id'],
  );
  requireUniqueIndex(
    await db.execute(`SELECT list.name AS index_name,list."unique" AS is_unique,
      list.partial,info.seqno,info.name AS column_name
      FROM pragma_index_list('pairing_weeks') AS list
      JOIN pragma_index_info(list.name) AS info
      WHERE list.name='idx_pairing_weeks_week_label'
      ORDER BY info.seqno`),
    ['week_label'],
    {name:'idx_pairing_weeks_week_label'},
  );
}

/**
 * Prove migration-owned operations contracts without changing schema or data.
 * SQLite resolves every projected column before returning LIMIT 0. Metadata
 * reads additionally prove the uniqueness contracts used by idempotent writes.
 */
async function probeNotificationPreferencesReadiness(db){
  await db.execute(`SELECT user_id,email_enabled,sms_enabled,phone,email,updated_at FROM user_notification_prefs LIMIT 0`);
  return true;
}

async function probeAdminPromotionReadiness(db){
  await db.execute(`SELECT id,email,is_admin FROM auth_accounts LIMIT 0`);
  await probeAuthAccountWriteConstraints(db);
  return true;
}

async function probeDemoSeedReadiness(db){
  await db.execute(`SELECT id,email,password_hash,display_name,color,is_available,is_admin,is_demo
    FROM auth_accounts LIMIT 0`);
  await probeAuthAccountWriteConstraints(db);
  return true;
}

async function probeDemoShuffleReadiness(db){
  await db.execute(`SELECT id,email,password_hash,display_name,color,is_available,is_admin,is_demo
    FROM auth_accounts LIMIT 0`);
  await db.execute(`SELECT id,week_label,week_start,focus,created_at,is_demo
    FROM pairing_weeks LIMIT 0`);
  await db.execute(`SELECT id,week_id,user_a_id,user_b_id,user_c_id,is_ai_pair,topic,
    topic_kind,created_at FROM pairing_groups LIMIT 0`);
  await db.execute(`SELECT week_label,week_id,generation_token,generation,algorithm_version,
    algorithm_seed,participant_count,participants_json,created_at,updated_at
    FROM pairing_week_runs LIMIT 0`);
  await db.execute(`SELECT week_id,user_id,position,source,created_at
    FROM pairing_participants LIMIT 0`);
  await probeAuthAccountWriteConstraints(db);
  await probePairingWriteConstraints(db);
  return true;
}

async function probeDemoResetReadiness(db){
  await db.execute(`SELECT id,is_demo FROM auth_accounts LIMIT 0`);
  await db.execute(`SELECT id,is_demo FROM pairing_weeks LIMIT 0`);
  await db.execute(`SELECT week_id FROM pairing_groups LIMIT 0`);
  await db.execute(`SELECT week_id FROM pairing_week_runs LIMIT 0`);
  await db.execute(`SELECT week_id FROM pairing_participants LIMIT 0`);
  return true;
}

export function ensureNotificationPreferencesReadiness(db){
  return ensureReadiness(db,'notification-preferences',probeNotificationPreferencesReadiness);
}

export function ensureAdminPromotionReadiness(db){
  return ensureReadiness(db,'admin-promotion',probeAdminPromotionReadiness);
}

export function ensureDemoSeedReadiness(db){
  return ensureReadiness(db,'demo-seed',probeDemoSeedReadiness);
}

export function ensureDemoShuffleReadiness(db){
  return ensureReadiness(db,'demo-shuffle',probeDemoShuffleReadiness);
}

export function ensureDemoResetReadiness(db){
  return ensureReadiness(db,'demo-reset',probeDemoResetReadiness);
}
