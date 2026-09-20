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

async function probePairAccessSchema(db,{includeWeek=false}={}){
  if(includeWeek) await db.execute(`SELECT id,week_label FROM pairing_weeks LIMIT 0`);
  await db.execute(`SELECT id,week_id,user_a_id,user_b_id,user_c_id,is_ai_pair
    FROM pairing_groups LIMIT 0`);
  await db.execute(`SELECT week_id,user_id,source FROM pairing_participants LIMIT 0`);
  if(includeWeek&&process.env.CIRCLE_MEMBERSHIP_ENABLED==='true'){
    await db.execute(`SELECT id,is_primary,archived_at FROM circles LIMIT 0`);
    await db.execute(`SELECT circle_id,user_id,status FROM circle_memberships LIMIT 0`);
  }
}

async function probeAnalyzeSchema(db){
  await db.execute(`SELECT id,is_demo FROM auth_accounts LIMIT 0`);
  await probePairAccessSchema(db,{includeWeek:true});
  await db.execute(`SELECT id,room_id,pair_label,transcript,code_snapshots,
    interviewer_questions,started_at,ended_at,duration_sec,cost_cents,created_at,
    created_by FROM ai_sessions LIMIT 0`);
  await db.execute(`SELECT id,session_id,role,feedback_json,evidence,model_used,
    reason_for_pick,estimated_cost_cents,confidence,created_at
    FROM ai_feedback LIMIT 0`);
  await db.execute(`SELECT date,calls,tokens_in,tokens_out,updated_at FROM ai_usage LIMIT 0`);
  await db.execute(`SELECT month,user_id,calls,tokens_in,updated_at
    FROM ai_account_monthly_usage LIMIT 0`);
  await db.execute(`SELECT reservation_id,month,user_id,tokens_in,session_id,
    refunded_at,created_at FROM ai_account_monthly_reservations LIMIT 0`);
  await db.execute(`SELECT user_id,consented_at,revoked_at,policy_version
    FROM ai_consents LIMIT 0`);
  return true;
}

async function probeFeedbackSchema(db){
  await probePairAccessSchema(db);
  await db.execute(`SELECT id,room_id,pair_label,created_by FROM ai_sessions LIMIT 0`);
  await db.execute(`SELECT id,session_id,feedback_json,evidence,model_used,
    reason_for_pick,confidence,created_at FROM ai_feedback LIMIT 0`);
  return true;
}

async function probeHistorySchema(db){
  await probePairAccessSchema(db);
  await db.execute(`SELECT id,room_id,pair_label,duration_sec,created_by
    FROM ai_sessions LIMIT 0`);
  await db.execute(`SELECT id,session_id,role,model_used,estimated_cost_cents,
    confidence,created_at FROM ai_feedback LIMIT 0`);
  await db.execute(`SELECT date,calls,tokens_in,tokens_out,updated_at FROM ai_usage LIMIT 0`);
  await db.execute(`SELECT month,user_id,calls FROM ai_account_monthly_usage LIMIT 0`);
  return true;
}

async function probeLogSchema(db){
  await db.execute(`SELECT id,level,source,event,message,meta_json,user_id,route,ua,ip,
    created_at FROM app_logs LIMIT 0`);
  return true;
}

export function ensureAiAnalyzeReadiness(db){
  return ensureReadiness(db,'analyze',probeAnalyzeSchema);
}

export function ensureAiFeedbackReadiness(db){
  return ensureReadiness(db,'feedback',probeFeedbackSchema);
}

export function ensureAiHistoryReadiness(db){
  return ensureReadiness(db,'history',probeHistorySchema);
}

export function ensureAiLogReadiness(db){
  return ensureReadiness(db,'log',probeLogSchema);
}
