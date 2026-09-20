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

async function probeAdminSchema(db){
  await db.execute(`SELECT id,email,is_admin FROM auth_accounts LIMIT 0`);
  return true;
}

async function probeProfileSchema(db){
  await db.execute(`SELECT id,email,password_hash,display_name,color,created_at,last_login,
    is_available,availability_updated_at,is_admin,is_demo,bio,tz,interview_focus,
    leetcode_handle,google_sub FROM auth_accounts LIMIT 0`);
  return true;
}

async function probeCircleSchema(db){
  await db.execute(`SELECT id,email,display_name,color,created_at,is_available,
    availability_updated_at,is_admin,is_demo,bio,tz,interview_focus,leetcode_handle
    FROM auth_accounts LIMIT 0`);
  await db.execute(`SELECT id,name,color,created_at FROM users LIMIT 0`);
  return true;
}

async function probeWeeksSchema(db){
  await db.execute(`SELECT id,display_name,color,is_demo FROM auth_accounts LIMIT 0`);
  await db.execute(`SELECT id,name,color FROM users LIMIT 0`);
  await db.execute(`SELECT id,week_label,week_start,focus,is_demo FROM pairing_weeks LIMIT 0`);
  await db.execute(`SELECT id,week_id,user_a_id,user_b_id,user_c_id,is_ai_pair,topic,
    topic_kind FROM pairing_groups LIMIT 0`);
  await db.execute(`SELECT week_id,user_id,source FROM pairing_participants LIMIT 0`);
  await db.execute(`SELECT week_label,week_id,generation_token,generation,algorithm_version,
    algorithm_seed,participant_count,participants_json,created_at
    FROM pairing_week_runs LIMIT 0`);
  return true;
}

async function probeHistorySchema(db){
  await db.execute(`SELECT id,display_name FROM auth_accounts LIMIT 0`);
  await db.execute(`SELECT id,name FROM users LIMIT 0`);
  await db.execute(`SELECT id,week_label,week_start FROM pairing_weeks LIMIT 0`);
  await db.execute(`SELECT id,week_id,user_a_id,user_b_id,user_c_id,is_ai_pair,topic,
    topic_kind FROM pairing_groups LIMIT 0`);
  await db.execute(`SELECT week_id,user_id,source FROM pairing_participants LIMIT 0`);
  return true;
}

async function probeStatsSchema(db){
  await db.execute(`SELECT id,is_demo FROM auth_accounts LIMIT 0`);
  await db.execute(`SELECT id,is_demo FROM pairing_weeks LIMIT 0`);
  await db.execute(`SELECT id,week_id,user_a_id,user_b_id,user_c_id FROM pairing_groups LIMIT 0`);
  await db.execute(`SELECT week_id,user_id,source FROM pairing_participants LIMIT 0`);
  return true;
}

async function probeMyPairSchema(db){
  await db.execute(`SELECT id,display_name,color,is_demo,bio,tz,interview_focus,
    leetcode_handle FROM auth_accounts LIMIT 0`);
  await db.execute(`SELECT id,name,color FROM users LIMIT 0`);
  await db.execute(`SELECT id,week_label,week_start,focus,is_demo FROM pairing_weeks LIMIT 0`);
  await db.execute(`SELECT id,week_id,user_a_id,user_b_id,user_c_id,is_ai_pair,topic,
    topic_kind FROM pairing_groups LIMIT 0`);
  await db.execute(`SELECT week_id,user_id,source FROM pairing_participants LIMIT 0`);
  await db.execute(`SELECT week_label,week_id,generation_token,generation,algorithm_version,
    algorithm_seed,participant_count,participants_json,created_at
    FROM pairing_week_runs LIMIT 0`);
  await db.execute(`SELECT week_id,user_id,kind FROM pairing_email_outbox LIMIT 0`);
  await db.execute(`SELECT id,week_id,pair_group_id,proposed_times,agreed_time,updated_at
    FROM pair_schedules LIMIT 0`);
  return true;
}

async function probeRunsSchema(db){
  await db.execute(`SELECT id,display_name FROM auth_accounts LIMIT 0`);
  await db.execute(`SELECT id,week_id,user_a_id,user_b_id,user_c_id FROM pairing_groups LIMIT 0`);
  await db.execute(`SELECT week_id,user_id,source FROM pairing_participants LIMIT 0`);
  await db.execute(`SELECT id,user_id,week_id,pair_group_id,question_id,question_slug,
    language,code,test_cases_snapshot,results_json,passed_count,total_count,duration_ms,
    created_at FROM session_runs LIMIT 0`);
  return true;
}

async function probeLogSchema(db){
  await db.execute(`SELECT id,level,source,event,message,meta_json,user_id,route,ua,ip,
    created_at FROM app_logs LIMIT 0`);
  return true;
}

export function ensureDataAdminReadiness(db){
  return ensureReadiness(db,'admin',probeAdminSchema);
}

export function ensureDataProfileReadiness(db){
  return ensureReadiness(db,'profile',probeProfileSchema);
}

export function ensureDataCircleReadiness(db){
  return ensureReadiness(db,'circle',probeCircleSchema);
}

export function ensureDataWeeksReadiness(db){
  return ensureReadiness(db,'weeks',probeWeeksSchema);
}

export function ensureDataHistoryReadiness(db){
  return ensureReadiness(db,'history',probeHistorySchema);
}

export function ensureDataStatsReadiness(db){
  return ensureReadiness(db,'stats',probeStatsSchema);
}

export function ensureMyPairDataReadiness(db){
  return ensureReadiness(db,'my-pair',probeMyPairSchema);
}

export function ensureDataRunsReadiness(db){
  return ensureReadiness(db,'runs',probeRunsSchema);
}

export function ensureDataLogReadiness(db){
  return ensureReadiness(db,'logs',probeLogSchema);
}
