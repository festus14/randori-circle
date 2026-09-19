import { randomUUID } from 'node:crypto';
import { captureSentryException, captureSentryMessage, getClient, initSentry, isSentryConfigured, verifyMutationOrigin, verifyRequestAuth } from './_db.js';
import { AUTH_PAIR_ACCESS_SQL, authPairAccessArgs } from './_pair-access.js';
import { parseCanonicalRoomPath } from './_pairing.js';

initSentry();

function getEndpoint(req){
  const q = req.query?.endpoint;
  if (q) return String(q).toLowerCase();
  try{
    const u = new URL(req.url,'http://localhost');
    const ep = u.searchParams.get('endpoint');
    if (ep) return ep.toLowerCase();
    const idParam = u.searchParams.get('id');
    if (idParam) return 'feedback';
    const parts = u.pathname.split('/').filter(Boolean);
    const last = parts.pop()?.toLowerCase()||'';
    if (['analyze','feedback','history'].includes(last)) return last;
    return last;
  }catch{ return (req.url||'').split('?')[0].split('/').filter(Boolean).pop()?.toLowerCase()||''; }
}

function todayISO(){ const d=new Date(); return d.toISOString().slice(0,10); }
function currentMonthISO(){ return todayISO().slice(0,7); }

const AI_ACCOUNT_MONTHLY_USAGE_TABLE_SQL=`CREATE TABLE IF NOT EXISTS ai_account_monthly_usage (
  month TEXT NOT NULL CHECK(length(month)=7 AND month GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]'),
  user_id INTEGER NOT NULL CHECK(user_id>0),
  calls INTEGER NOT NULL DEFAULT 0 CHECK(calls>=0),
  tokens_in INTEGER NOT NULL DEFAULT 0 CHECK(tokens_in>=0),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY(month,user_id)
)`;
const AI_ACCOUNT_MONTHLY_RESERVATIONS_TABLE_SQL=`CREATE TABLE IF NOT EXISTS ai_account_monthly_reservations (
  reservation_id TEXT PRIMARY KEY,
  month TEXT NOT NULL,
  user_id INTEGER NOT NULL CHECK(user_id>0),
  tokens_in INTEGER NOT NULL DEFAULT 0 CHECK(tokens_in>=0),
  session_id INTEGER UNIQUE,
  refunded_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
)`;

async function ensureTables(db){
  await db.execute(`CREATE TABLE IF NOT EXISTS ai_sessions (
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
  )`);
  await db.execute(`CREATE TABLE IF NOT EXISTS ai_feedback (
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
  )`);
  await db.execute(`CREATE TABLE IF NOT EXISTS ai_usage (
    date TEXT PRIMARY KEY,
    calls INTEGER DEFAULT 0,
    tokens_in INTEGER DEFAULT 0,
    tokens_out INTEGER DEFAULT 0,
    updated_at TEXT DEFAULT (datetime('now'))
  )`);
  // The legacy ai_monthly_usage table used month as its sole primary key, so it
  // cannot safely represent more than one account and its numeric ids have no
  // provenance. Keep it untouched and use this additive auth-account ledger.
  await db.execute(AI_ACCOUNT_MONTHLY_USAGE_TABLE_SQL);
  await db.execute(AI_ACCOUNT_MONTHLY_RESERVATIONS_TABLE_SQL);
  await db.execute(`CREATE TABLE IF NOT EXISTS ai_consents (
    user_id INTEGER PRIMARY KEY,
    consented_at TEXT NOT NULL DEFAULT (datetime('now')),
    revoked_at TEXT,
    policy_version TEXT NOT NULL
  )`);
}

async function ensureAppLogs(db){
  try{
    await db.execute(`CREATE TABLE IF NOT EXISTS app_logs (
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
    )`);
  }catch{}
  try{ await db.execute(`CREATE INDEX IF NOT EXISTS idx_logs_level_created ON app_logs(level, created_at DESC)`) }catch{}
}

async function logServer(level, event, message, meta, reqCtx){
  try{
    const db=getClient();
    await ensureAppLogs(db);
    const allowed=['info','warn','error','success','debug'];
    let lvl=String(level||'info').toLowerCase();
    if(!allowed.includes(lvl)) lvl='info';
    const src = (reqCtx && reqCtx.source) ? String(reqCtx.source).slice(0,20) : 'server-ai';
    const ev = event ? String(event).slice(0,80) : null;
    let msg = String(message||'').slice(0,2000);
    let metaStr=null;
    try{ metaStr = typeof meta==='string' ? meta.slice(0,8000) : JSON.stringify(meta).slice(0,8000); }catch{ metaStr=String(meta).slice(0,8000); }
    let user_id=null;
    try{
      if(reqCtx){
        if(reqCtx.user_id) user_id=reqCtx.user_id;
        else if(reqCtx.payload && (reqCtx.payload.id||reqCtx.payload.uid)) user_id=reqCtx.payload.id||reqCtx.payload.uid;
        else if(reqCtx.userId) user_id=reqCtx.userId;
      }
    }catch{}
    let route=null, ua=null, ip=null;
    try{
      if(reqCtx && reqCtx.route) route=String(reqCtx.route).slice(0,300);
      else if(reqCtx && reqCtx.req && reqCtx.req.url) route=String(reqCtx.req.url).slice(0,300);
      else if(reqCtx && reqCtx.headers && reqCtx.url) route=String(reqCtx.url).slice(0,300);
      if(reqCtx && reqCtx.ua) ua=String(reqCtx.ua).slice(0,300);
      else if(reqCtx && reqCtx.headers) ua=(reqCtx.headers['user-agent']||'').toString().slice(0,300);
      else if(reqCtx && reqCtx.req && reqCtx.req.headers) ua=(reqCtx.req.headers['user-agent']||'').toString().slice(0,300);
      if(reqCtx && reqCtx.ip) ip=String(reqCtx.ip).slice(0,80);
      else if(reqCtx && reqCtx.headers) ip=(reqCtx.headers['x-forwarded-for']||'').toString().split(',')[0].trim().slice(0,80);
      else if(reqCtx && reqCtx.req && reqCtx.req.headers) ip=(reqCtx.req.headers['x-forwarded-for']||'').toString().split(',')[0].trim().slice(0,80);
    }catch{}
    await db.execute({sql:`INSERT INTO app_logs (level, source, event, message, meta_json, user_id, route, ua, ip, created_at) VALUES (?,?,?,?,?,?,?,?,?, datetime('now'))`, args:[lvl, src, ev, msg, metaStr, user_id, route, ua, ip]});
    try{
      if((lvl==='error' || lvl==='warn') && isSentryConfigured() && !reqCtx?.skipSentry){
        const tags={event: ev||'ai', level:lvl, source:src};
        captureSentryMessage(msg, {
          level:lvl==='error'?'error':'warning',
          tags,
          extra:{meta: metaStr?.slice(0,1500), route},
        });
      }
    }catch{}
  }catch{}
}

const MODELS = {
  fast: { name:'llama-3.1-8b-instant', price_in_per_mtok:0.05, price_out_per_mtok:0.08, context:131072 },
  balanced: { name:'llama-3.3-70b-versatile', price_in_per_mtok:0.59, price_out_per_mtok:0.79, context:131072 },
};
const AI_CONSENT_POLICY_VERSION='2026-09-17';

class AiPairAccessError extends Error{
  constructor(){
    super('trusted room membership required');
    this.name='AiPairAccessError';
  }
}

// AI processing requires consent from every human participant. A room with a
// legacy or missing participant identity cannot satisfy that contract, even if
// the authenticated caller's own membership is source-tagged.
const AUTH_ONLY_PAIR_ACCESS_SQL=`SELECT access.* FROM (${AUTH_PAIR_ACCESS_SQL}) AS access
  WHERE EXISTS (
    SELECT 1 FROM pairing_participants participant_a
    WHERE participant_a.week_id=access.week_id
      AND participant_a.user_id=access.user_a_id
      AND participant_a.source='auth'
  )
    AND EXISTS (
      SELECT 1 FROM pairing_participants participant_b
      WHERE participant_b.week_id=access.week_id
        AND participant_b.user_id=access.user_b_id
        AND participant_b.source='auth'
    )
    AND (access.user_c_id IS NULL OR EXISTS (
      SELECT 1 FROM pairing_participants participant_c
      WHERE participant_c.week_id=access.week_id
        AND participant_c.user_id=access.user_c_id
        AND participant_c.source='auth'
    ))`;

function canonicalAnalysisRoom(value){
  if(typeof value!=='string') return null;
  const parsed=parseCanonicalRoomPath(`/join/${value}`);
  return parsed?.roomId===value?parsed:null;
}

function pairAccessArgs(userId,room){
  return authPairAccessArgs({
    userId,
    weekId:room.weekId,
    pairGroupId:room.pairGroupId,
  });
}

function estimateTokens(str){ if(!str) return 0; return Math.ceil(String(str).length/4); }

function pickModel({ transcript, code, role, durationSec, interviewerQuestions, usage }){
  const transTokens=estimateTokens(transcript); const codeTokens=estimateTokens(code); const totalIn=transTokens+codeTokens+800;
  const callsToday=usage?.calls||0; const nearLimit=callsToday>13000; const heavy=usage?.tokens_in>8000000;
  if (nearLimit||heavy) return { model:MODELS.fast, reason:`free-tier guard: ${callsToday} calls today (cap 14.4k) — forced cheap/fast`, totalIn, totalTokens:totalIn };
  if (totalIn>6000 || transcript?.length>24000) return { model:MODELS.balanced, reason:`long ~${totalIn} tokens (>6k) needs 70b`, totalIn, totalTokens:totalIn };
  if ((interviewerQuestions && String(interviewerQuestions).length>500) || durationSec>1200) return { model:MODELS.balanced, reason:`system design / longer ${Math.round((durationSec||0)/60)}m → 70b`, totalIn, totalTokens:totalIn };
  return { model:MODELS.fast, reason:`short ~${totalIn} tokens ${role||'both'} → 8b-instant`, totalIn, totalTokens:totalIn };
}

function buildPrompt({ role, transcript, code, interviewerQuestions, durationSec, pairLabel }){
  return `You are Randori AI staff interview coach.
Session: ${pairLabel||'mock'} duration ${durationSec? Math.round(durationSec/60)+' min':'?'} role ${role||'both'}
TRANSCRIPT:
${(transcript||'(none)').slice(0,18000)}
CODE:
${(typeof code==='string'?code:JSON.stringify(code||'')).slice(0,12000)}
INTERVIEWER QS:
${(interviewerQuestions||'(none)').slice(0,4000)}
Produce STRICT JSON only:
{
 "candidate":{"strengths":[{"point":"..","evidence":"verbatim substring","confidence":0-1}], "improvements":[{"point":"..","evidence":"..","suggestion":".."}]},
 "interviewer":{"strengths":[{"point":"..","evidence":".."}],"improvements":[{"point":"..","evidence":"..","suggestion":".."}]},
 "overall_score":1-10,
 "next_time_checklist":["..",".."]
}
Rules: evidence MUST be verbatim 5-20 words from TRANSCRIPT/CODE, else "". 2-3 per role. JSON only.`;
}

function normalizeFeedbackItem(item, improvement){
  if(!item || typeof item!=='object' || Array.isArray(item)) return null;
  if(typeof item.point!=='string' || !item.point.trim() || typeof item.evidence!=='string') return null;
  if(improvement && (typeof item.suggestion!=='string' || !item.suggestion.trim())) return null;
  if(item.confidence!==undefined && (!Number.isFinite(item.confidence) || item.confidence<0 || item.confidence>1)) return null;
  const normalized={ point:item.point.trim().slice(0,500), evidence:item.evidence.trim().slice(0,500) };
  if(improvement) normalized.suggestion=item.suggestion.trim().slice(0,800);
  if(item.confidence!==undefined) normalized.confidence=item.confidence;
  return normalized;
}

function normalizeFeedbackSection(section){
  if(!section || typeof section!=='object' || Array.isArray(section)) return null;
  if(!Array.isArray(section.strengths) || !Array.isArray(section.improvements)) return null;
  const strengths=section.strengths.slice(0,10).map(item=>normalizeFeedbackItem(item,false));
  const improvements=section.improvements.slice(0,10).map(item=>normalizeFeedbackItem(item,true));
  if(strengths.some(item=>!item) || improvements.some(item=>!item)) return null;
  return {strengths,improvements};
}

function normalizeFeedback(feedback){
  if(!feedback || typeof feedback!=='object' || Array.isArray(feedback)) return null;
  const candidate=normalizeFeedbackSection(feedback.candidate);
  const interviewer=normalizeFeedbackSection(feedback.interviewer);
  if(!candidate || !interviewer) return null;
  if(!Number.isFinite(feedback.overall_score) || feedback.overall_score<1 || feedback.overall_score>10) return null;
  if(!Array.isArray(feedback.next_time_checklist) || feedback.next_time_checklist.some(item=>typeof item!=='string')) return null;
  return {
    candidate,
    interviewer,
    overall_score:feedback.overall_score,
    next_time_checklist:feedback.next_time_checklist.slice(0,20).map(item=>item.trim().slice(0,500)).filter(Boolean),
  };
}

function parseProviderFeedback(content){
  if(typeof content!=='string') return content;
  try{ return JSON.parse(content); }catch{ return null; }
}

function verifyEvidence(feedback, combined){
  const low=(combined||'').toLowerCase(); let val=0, tot=0, lowered=false;
  for(const r of ['candidate','interviewer']){
    const sec=feedback[r]; if(!sec) continue;
    for(const k of ['strengths','improvements']){
      for(const it of (sec[k]||[])){
        tot++; const ev=(it.evidence||'').trim();
        if(!ev){ it.evidence='no direct quote'; it.confidence=Math.min(it.confidence||0.9,0.55); lowered=true; continue; }
        if (low.includes(ev.toLowerCase().slice(0,120)) || low.includes(ev.toLowerCase())){
          val++;
        } else {
          const words=ev.split(/\s+/).filter(Boolean); let found=false;
          if(words.length>=5) for(let i=0;i<=words.length-5;i++){ const chunk=words.slice(i,i+5).join(' ').toLowerCase(); if(chunk.length>10 && low.includes(chunk)){ found=true; break; } }
          if(!found && words.length>=3) for(let i=0;i<=words.length-3;i++){ const c=words.slice(i,i+3).join(' ').toLowerCase(); if(c.length>8 && low.includes(c)){ found=true; break; } }
          if(found) val++; else { it.evidence='no direct quote - inferred'; if(it.confidence) it.confidence=Math.min(it.confidence,0.6); lowered=true; }
        }
      }
    }
  }
  return { validated:val, total:tot, score:tot?val/tot:1, loweredConfidence:lowered };
}

function parseProviderEnvelope(provider,res,text){
  let json;
  try{ json=JSON.parse(text); }catch{ json=null; }
  const validObject=!!json && typeof json==='object' && !Array.isArray(json);
  if(!res.ok){
    const providerError=validObject
      ? (typeof json.error==='object' && json.error ? json.error.message : json.error)
      : null;
    return {error:`${provider} ${res.status}: ${providerError||text.slice(0,400)}`,status:res.status,raw:validObject?json:null};
  }
  const choice=validObject && Array.isArray(json.choices) ? json.choices[0] : null;
  const message=choice && typeof choice==='object' && !Array.isArray(choice) ? choice.message : null;
  const content=message && typeof message==='object' && !Array.isArray(message) ? message.content : null;
  if(typeof content!=='string' || !content.trim()){
    return {error:`${provider} ${res.status}: invalid provider response`,status:res.status,raw:validObject?json:null,invalid_response:true};
  }
  const usage=json.usage && typeof json.usage==='object' && !Array.isArray(json.usage) ? json.usage : {};
  return {content,usage,raw:json};
}

async function callGroq({ modelName, prompt }){
  const key=process.env.GROQ_API_KEY;
  if(!key) return { error:'missing GROQ_API_KEY', mocked:true };
  const body={ model:modelName, messages:[{role:'system',content:'You are JSON generator only.'},{role:'user',content:prompt}], temperature:0.25, max_tokens:1600, response_format:{type:'json_object'} };
  const controller=new AbortController(); const timer=setTimeout(()=>controller.abort(),15000);
  let res, text;
  try{
    res=await fetch('https://api.groq.com/openai/v1/chat/completions',{ method:'POST', headers:{ Authorization:`Bearer ${key}`, 'Content-Type':'application/json'}, body:JSON.stringify(body), signal:controller.signal});
    text=await res.text();
  }
  catch(error){ return { error:error?.name==='AbortError'?'groq request timed out':'groq request failed', network_error:true }; }
  finally{ clearTimeout(timer); }
  return parseProviderEnvelope('groq',res,text);
}

async function callOpenAI({ modelName, prompt }){
  const key=process.env.OPENAI_API_KEY;
  if(!key) return { error:'missing OPENAI_API_KEY' };
  const model = modelName.includes('70b') ? 'gpt-4o-mini' : 'gpt-4o-mini';
  const body={ model, messages:[{role:'system',content:'You are JSON generator only. Output JSON.'},{role:'user',content:prompt}], temperature:0.25, max_tokens:1500, response_format:{type:'json_object'} };
  const controller=new AbortController(); const timer=setTimeout(()=>controller.abort(),15000);
  let res, text;
  try{
    res=await fetch('https://api.openai.com/v1/chat/completions',{ method:'POST', headers:{ Authorization:`Bearer ${key}`, 'Content-Type':'application/json'}, body:JSON.stringify(body), signal:controller.signal});
    text=await res.text();
  }
  catch(error){ return { error:error?.name==='AbortError'?'openai request timed out':'openai request failed', network_error:true }; }
  finally{ clearTimeout(timer); }
  return parseProviderEnvelope('openai',res,text);
}

async function tryAuth(req){
  const payload=await verifyRequestAuth(req);
  if(!payload) return { authed:false, userId:null, payload:null, isDemo:true };
  const uid=payload.id??payload.uid;
  const isDemo=!!payload.is_demo || String(payload.email||'').includes('randori.demo');
  return {authed:true,userId:uid,payload,isDemo};
}

async function resolveDemoFlag(db, authInfo){
  if(!authInfo?.userId) return true;
  try{
    const rs=await db.execute({sql:`SELECT is_demo FROM auth_accounts WHERE id=?`, args:[authInfo.userId]});
    if(rs.rows.length) return !!rs.rows[0].is_demo;
  }catch{}
  return !!authInfo.isDemo;
}

async function resolveAnalysisRoom(db, roomId, userId){
  const room=canonicalAnalysisRoom(roomId);
  if(!room) return null;
  const result=await db.execute({
    sql:`SELECT pg.id AS pair_group_id,pg.week_id,pg.user_a_id,pg.user_b_id,pg.user_c_id,
        COALESCE(pg.is_ai_pair,0) AS is_ai_pair,pw.week_label
      FROM pairing_groups pg
      JOIN pairing_weeks pw ON pw.id=pg.week_id
      WHERE pg.id=? AND pg.week_id=?
        AND EXISTS (${AUTH_ONLY_PAIR_ACCESS_SQL})
      LIMIT 1`,
    args:[room.pairGroupId,room.weekId,...pairAccessArgs(userId,room)],
  });
  const row=result.rows?.[0];
  if(!row) return null;

  const participantIds=[row.user_a_id,row.user_b_id,row.user_c_id]
    .map(Number)
    .filter(Number.isSafeInteger)
    .filter((id,index,all)=>id>0 && all.indexOf(id)===index);
  if(!participantIds.length) return null;

  return {
    roomId:room.roomId,
    weekId:room.weekId,
    pairGroupId:room.pairGroupId,
    pairLabel:`${row.week_label||`Week ${Number(row.week_id)}`} · Pair ${Number(row.pair_group_id)}`,
    participantIds,
    singleUser:!!row.is_ai_pair && participantIds.length===1,
  };
}

async function recordAndVerifyRoomConsent(db, userId, room, participantIds){
  await db.execute({
    sql:`INSERT INTO ai_consents (user_id,consented_at,revoked_at,policy_version)
      SELECT ?,datetime('now'),NULL,?
      WHERE EXISTS (${AUTH_ONLY_PAIR_ACCESS_SQL})
      ON CONFLICT(user_id) DO UPDATE SET
        consented_at=datetime('now'),revoked_at=NULL,policy_version=excluded.policy_version`,
    args:[userId,AI_CONSENT_POLICY_VERSION,...pairAccessArgs(userId,room)],
  });
  const placeholders=participantIds.map(()=>'?').join(',');
  const result=await db.execute({
    sql:`WITH access AS (${AUTH_ONLY_PAIR_ACCESS_SQL}), consented AS (
        SELECT user_id FROM ai_consents
        WHERE user_id IN (${placeholders}) AND revoked_at IS NULL AND policy_version=?
      )
      SELECT consented.user_id
      FROM access LEFT JOIN consented ON 1=1`,
    args:[...pairAccessArgs(userId,room),...participantIds,AI_CONSENT_POLICY_VERSION],
  });
  if(!result.rows?.length) throw new AiPairAccessError();
  const consented=new Set(result.rows.map(row=>Number(row.user_id)).filter(Number.isSafeInteger));
  return participantIds.filter(id=>!consented.has(Number(id)));
}

function isLegacyAiSessionSchemaError(error){
  return /(?:has no column named|no such column)[^\n]*(?:started_at|ended_at)/i.test(String(error?.message||error||''));
}

async function createAuthorizedSession(db,{room,userId,pairLabel,transcript,code,questions,durationSec,reservationId}){
  const accessArgs=pairAccessArgs(userId,room);
  const attachReservation={
    sql:`UPDATE ai_account_monthly_reservations
      SET session_id=last_insert_rowid()
      WHERE reservation_id=? AND user_id=? AND session_id IS NULL AND refunded_at IS NULL
        AND changes()=1
      RETURNING session_id`,
    args:[reservationId,userId],
  };
  let results;
  try{
    results=await db.batch([{
        sql:`INSERT INTO ai_sessions (
            room_id,pair_label,transcript,code_snapshots,interviewer_questions,
            started_at,ended_at,duration_sec,created_by
          )
          SELECT ?,?,?,?,?,datetime('now'),datetime('now'),?,?
          WHERE EXISTS (${AUTH_ONLY_PAIR_ACCESS_SQL})
          RETURNING id`,
        args:[room.roomId,pairLabel||'mock',transcript.slice(0,28000),code.slice(0,28000),questions.slice(0,8000),Number(durationSec)||0,userId,...accessArgs],
      },attachReservation], 'write');
  }catch(error){
    if(!isLegacyAiSessionSchemaError(error)) throw error;
    results=await db.batch([{
        sql:`INSERT INTO ai_sessions (
            room_id,pair_label,transcript,code_snapshots,interviewer_questions,duration_sec,created_by
          )
          SELECT ?,?,?,?,?,?,?
          WHERE EXISTS (${AUTH_ONLY_PAIR_ACCESS_SQL})
          RETURNING id`,
        args:[room.roomId,pairLabel||'mock',transcript.slice(0,8000),code.slice(0,8000),questions.slice(0,3000),Number(durationSec)||0,userId,...accessArgs],
      },attachReservation], 'write');
  }
  const [inserted,attached]=results;
  const sessionId=Number(inserted.rows?.[0]?.id);
  if(!Number.isSafeInteger(sessionId)||sessionId<1) throw new AiPairAccessError();
  if(Number(attached?.rows?.[0]?.session_id)!==sessionId){
    throw new Error('AI quota reservation was not attached to its session');
  }
  return sessionId;
}

async function createAuthorizedFeedback(db,{room,userId,sessionId,role,feedback,verification,modelUsed,reason,costCents,combinedLength}){
  const accessArgs=pairAccessArgs(userId,room);
  const sessionGuard=`EXISTS (
    SELECT 1 FROM ai_sessions guarded_session
    WHERE guarded_session.id=? AND guarded_session.room_id=? AND guarded_session.created_by=?
  )`;
  let inserted;
  try{
    inserted=await db.execute({
      sql:`INSERT INTO ai_feedback (
          session_id,role,feedback_json,evidence,model_used,reason_for_pick,
          estimated_cost_cents,confidence
        )
        SELECT ?,?,?,?,?,?,?,?
        WHERE EXISTS (${AUTH_ONLY_PAIR_ACCESS_SQL}) AND ${sessionGuard}
        RETURNING id`,
      args:[sessionId,role||'both',JSON.stringify(feedback||{}),JSON.stringify({validation:verification,combined_len:combinedLength}),modelUsed,reason,costCents,verification.score,
        ...accessArgs,sessionId,room.roomId,userId],
    });
  }catch{
    inserted=await db.execute({
      sql:`INSERT INTO ai_feedback (session_id,role,feedback_json,model_used)
        SELECT ?,?,?,?
        WHERE EXISTS (${AUTH_ONLY_PAIR_ACCESS_SQL}) AND ${sessionGuard}
        RETURNING id`,
      args:[sessionId,role||'both',JSON.stringify(feedback||{}),modelUsed,
        ...accessArgs,sessionId,room.roomId,userId],
    });
  }
  const feedbackId=Number(inserted.rows?.[0]?.id);
  if(!Number.isSafeInteger(feedbackId)||feedbackId<1) throw new AiPairAccessError();
  return feedbackId;
}

// History queries need to authorize rows from multiple rooms at once, so they
// use the same invariant as AUTH_PAIR_ACCESS_SQL as correlated joins.
const AUTH_SESSION_OWNERSHIP_JOINS=`JOIN pairing_groups owner_group
    ON ase.room_id=printf('week_%d_pair_%d',owner_group.week_id,owner_group.id)
  JOIN pairing_participants owner_viewer
    ON owner_viewer.week_id=owner_group.week_id
   AND owner_viewer.user_id=? AND owner_viewer.source='auth'`;
const AUTH_SESSION_OWNERSHIP_WHERE=`ase.created_by=?
  AND (owner_group.user_a_id=? OR owner_group.user_b_id=? OR owner_group.user_c_id=?)
  AND EXISTS (
    SELECT 1 FROM pairing_participants owner_a
    WHERE owner_a.week_id=owner_group.week_id
      AND owner_a.user_id=owner_group.user_a_id AND owner_a.source='auth'
  )
  AND EXISTS (
    SELECT 1 FROM pairing_participants owner_b
    WHERE owner_b.week_id=owner_group.week_id
      AND owner_b.user_id=owner_group.user_b_id AND owner_b.source='auth'
  )
  AND (owner_group.user_c_id IS NULL OR EXISTS (
    SELECT 1 FROM pairing_participants owner_c
    WHERE owner_c.week_id=owner_group.week_id
      AND owner_c.user_id=owner_group.user_c_id AND owner_c.source='auth'
  ))`;

function authSessionOwnershipArgs(userId){
  return [userId,userId,userId,userId,userId];
}

async function checkMonthlyQuota(db, userId, isDemo){
  if(!userId) return {blocked:false,count:0,limit:isDemo?100:500};
  const month=currentMonthISO();
  const rs=await db.execute({
    sql:`SELECT calls FROM ai_account_monthly_usage WHERE month=? AND user_id=?`,
    args:[month,userId],
  });
  const stored=Number(rs.rows?.[0]?.calls||0);
  if(!Number.isSafeInteger(stored)||stored<0) throw new Error('invalid monthly AI usage');
  const limit=isDemo?100:500;
  if(stored>=limit) return {blocked:true,count:stored,limit,reason:`monthly limit ${limit} reached (${stored} used) — upgrade or wait next month`};
  return {blocked:false,count:stored,limit};
}

async function reserveMonthlyQuota(db,{userId,isDemo,tokensIn,room}){
  const limit=isDemo?100:500;
  const month=currentMonthISO();
  const reservationId=randomUUID();
  const normalizedTokens=Math.max(0,Number(tokensIn)||0);
  const accessArgs=pairAccessArgs(userId,room);
  const [reserved,usage]=await db.batch([
    {
      sql:`WITH access AS (${AUTH_ONLY_PAIR_ACCESS_SQL})
        INSERT INTO ai_account_monthly_reservations
          (reservation_id,month,user_id,tokens_in,session_id,refunded_at,created_at)
        SELECT ?,?,?,?,NULL,NULL,datetime('now') FROM access
        WHERE COALESCE((SELECT calls FROM ai_account_monthly_usage
          WHERE month=? AND user_id=?),0)<?
        RETURNING reservation_id`,
      args:[...accessArgs,reservationId,month,userId,normalizedTokens,month,userId,limit],
    },
    {
      sql:`INSERT INTO ai_account_monthly_usage (month,user_id,calls,tokens_in,updated_at)
        SELECT month,user_id,1,tokens_in,datetime('now')
        FROM ai_account_monthly_reservations
        WHERE reservation_id=? AND refunded_at IS NULL
        ON CONFLICT(month,user_id) DO UPDATE SET
          calls=ai_account_monthly_usage.calls+1,
          tokens_in=ai_account_monthly_usage.tokens_in+excluded.tokens_in,
          updated_at=datetime('now')
        WHERE ai_account_monthly_usage.calls<?
        RETURNING calls`,
      args:[reservationId,limit],
    },
  ],'write');
  const count=Number(usage?.rows?.[0]?.calls);
  if(reserved?.rows?.length===1 && Number.isSafeInteger(count) && count>0){
    return {blocked:false,count,limit,reservationId,month,userId,tokensIn:normalizedTokens};
  }
  const access=await db.execute({sql:AUTH_ONLY_PAIR_ACCESS_SQL,args:accessArgs});
  if(!access.rows?.length) throw new AiPairAccessError();
  const quota=await checkMonthlyQuota(db,userId,isDemo);
  if(quota.blocked) return quota;
  throw new Error('monthly AI quota was not reserved');
}

async function refundMonthlyQuota(db,reservation){
  if(!reservation?.reservationId) return;
  const [usage,refunded]=await db.batch([
    {
      sql:`UPDATE ai_account_monthly_usage
        SET calls=calls-1,
          tokens_in=MAX(0,tokens_in-?),
          updated_at=datetime('now')
        WHERE month=? AND user_id=? AND calls>0
          AND EXISTS (
            SELECT 1 FROM ai_account_monthly_reservations
            WHERE reservation_id=? AND month=? AND user_id=?
              AND session_id IS NULL AND refunded_at IS NULL
          )
        RETURNING calls`,
      args:[reservation.tokensIn,reservation.month,reservation.userId,
        reservation.reservationId,reservation.month,reservation.userId],
    },
    {
      sql:`UPDATE ai_account_monthly_reservations
        SET refunded_at=datetime('now')
        WHERE reservation_id=? AND month=? AND user_id=?
          AND session_id IS NULL AND refunded_at IS NULL
        RETURNING reservation_id`,
      args:[reservation.reservationId,reservation.month,reservation.userId],
    },
  ],'write');
  if(refunded?.rows?.length && !usage?.rows?.length){
    throw new Error('monthly AI quota refund was inconsistent');
  }
}

async function parseBody(req){
  if(req.body && typeof req.body==='object' && Object.keys(req.body).length){
    return req.body;
  }
  return await new Promise((resolve)=>{
    let buf=''; req.on('data',c=>buf+=c); req.on('end',()=>{
      if(!buf) return resolve({});
      try{ return resolve(JSON.parse(buf)); }catch{
        try{
          const qs=new URLSearchParams(buf);
          const obj={}; for(const [k,v] of qs) obj[k]=v;
          if(Object.keys(obj).length) return resolve(obj);
        }catch{}
        try{
          const m=buf.match(/\{[\s\S]*\}/);
          if(m) return resolve(JSON.parse(m[0]));
        }catch{}
        return resolve({raw:buf.slice(0,8000)});
      }
    }); req.on('error',()=>resolve({}));
  });
}

async function handleAnalyze(req,res){
  if(req.method!=='POST') return res.status(405).json({error:'POST only'});
  if(process.env.AI_ENABLED!=='true') return res.status(503).json({error:'AI coaching is not enabled for this release'});
  let authInfo=await tryAuth(req);
  if(!authInfo.authed) return res.status(401).json({error:'authentication required'});
  let userId=authInfo.userId;
  let isDemo=authInfo.isDemo;
  let payloadCtx=authInfo.payload;
  const anonMode = !authInfo.authed;
  let body;
  try{ body=await parseBody(req); }catch{ body={}; }
  if(body.ai_consent!==true) return res.status(403).json({error:'explicit AI processing consent required'});

  // FormData / multipart plain handling: if body has FormData fields named payload etc
  // Body may include room_id etc in top-level
  const requestedRoomId = body.room_id || body.roomId || body.room || '';
  const transcript = body.transcript || body.notes || '';
  const code = body.code || body.code_snapshots || body.codeSnapshots || '';
  const interviewer_questions = body.interviewer_questions || body.interviewerQuestions || body.iqs || '';
  const duration_sec = body.duration_sec ?? body.duration ?? body.durationSec ?? 0;
  const role = body.role || 'both';

  const transStr = typeof transcript==='string' ? transcript : JSON.stringify(transcript||'');
  const codeFlat = typeof code==='string' ? code : JSON.stringify(code||'');
  const iq = typeof interviewer_questions==='string' ? interviewer_questions : JSON.stringify(interviewer_questions||'');

  if(!transStr && !codeFlat){
    return res.status(400).json({ error:'transcript or code required', hint:'send {transcript, code} or FormData transcript+code' });
  }

  let db;
  try{ db=getClient(); }catch(e){
    return res.status(503).json({ error:'AI service temporarily unavailable' });
  }
  try{ await ensureTables(db); await ensureAppLogs(db); }catch{}

  const numericUserId=Number(userId);
  if(!Number.isSafeInteger(numericUserId)||numericUserId<1){
    return res.status(401).json({error:'authentication required'});
  }
  let trustedRoom;
  try{ trustedRoom=await resolveAnalysisRoom(db,requestedRoomId,numericUserId); }
  catch{ return res.status(503).json({error:'AI service temporarily unavailable'}); }
  if(!trustedRoom || !trustedRoom.participantIds.includes(numericUserId)){
    return res.status(403).json({error:'trusted room membership required'});
  }
  if(trustedRoom.participantIds.length===1 && !trustedRoom.singleUser){
    return res.status(403).json({error:'single-user analysis requires a trusted AI-pair room'});
  }
  const room_id=trustedRoom.roomId;
  const pair_label=trustedRoom.pairLabel;

  let missingConsents;
  try{
    missingConsents=await recordAndVerifyRoomConsent(db,numericUserId,trustedRoom,trustedRoom.participantIds);
  }catch(error){
    if(error instanceof AiPairAccessError) return res.status(403).json({error:'trusted room membership required'});
    return res.status(500).json({error:'unable to record AI consent'});
  }
  if(missingConsents.length){
    return res.status(403).json({error:'AI consent required from every room participant',pending_participant_count:missingConsents.length});
  }

  // resolve real is_demo from DB if authed
  if(authInfo.authed){
    try{ isDemo = await resolveDemoFlag(db, authInfo); }catch{}
  }

  // quota — monthly (demo 100 / regular 500) + daily free-tier guard
  try{
    const todayCheck=todayISO();
    try{
      const du=await db.execute({sql:`SELECT calls FROM ai_usage WHERE date=?`, args:[todayCheck]});
      const todayCalls=du.rows[0]?.calls||0;
      if(isDemo && todayCalls>=100){
        await logServer('warn','ai_quota_daily_demo', `demo daily 100 reached (${todayCalls})`, {userId, todayCalls}, {req, source:'server-ai'});
        return res.status(429).json({ ok:false, error:'daily demo limit 100 reached', detail:`${todayCalls} calls today — regular users have 14.4k/day`, calls_today:todayCalls, limit:100, demo:true });
      }
      if(todayCalls>=14400){
        await logServer('warn','ai_quota_daily_global', `global 14.4k reached`, {todayCalls}, {req, source:'server-ai'});
        return res.status(429).json({ ok:false, error:'free-tier daily pool 14,400 exhausted', calls_today:todayCalls });
      }
    }catch{}
  }catch{}
  let monthlyQuota;
  try{ monthlyQuota=await checkMonthlyQuota(db,numericUserId,isDemo); }
  catch{ return res.status(503).json({error:'AI quota temporarily unavailable'}); }
  if(monthlyQuota.blocked){
    await logServer('warn','ai_quota_blocked', `quota blocked user ${userId||'anon'} ${monthlyQuota.reason}`, {userId, isDemo, count:monthlyQuota.count, limit:monthlyQuota.limit}, {req, source:'server-ai', payload:payloadCtx});
    return res.status(429).json({ ok:false, error:'quota exceeded', reason:monthlyQuota.reason, count:monthlyQuota.count, limit:monthlyQuota.limit });
  }

  // daily pool guard (global) for anon
  if(anonMode){
    try{
      const today=todayISO();
      const ur=await db.execute({sql:`SELECT calls FROM ai_usage WHERE date=?`, args:[today]});
      const calls=ur.rows[0]?.calls||0;
      if(calls>=120){
        return res.status(429).json({ ok:false, error:'free-tier daily pool exhausted', detail:`${calls} calls today — sign in for higher quota`, calls_today:calls });
      }
    }catch{}
  }

  const today=todayISO();
  let usageRow={calls:0,tokens_in:0};
  try{ const ur=await db.execute({ sql:`SELECT calls,tokens_in FROM ai_usage WHERE date=?`, args:[today]}); if(ur.rows.length) usageRow=ur.rows[0]; }catch{}

  const picking=pickModel({ transcript:transStr, code:codeFlat, role, durationSec:duration_sec, interviewerQuestions:iq, usage:usageRow });

  let reservation;
  try{
    reservation=await reserveMonthlyQuota(db,{
      userId:numericUserId,isDemo,tokensIn:picking.totalIn,room:trustedRoom,
    });
  }catch(error){
    if(error instanceof AiPairAccessError) return res.status(403).json({error:'trusted room membership required'});
    return res.status(503).json({error:'AI quota temporarily unavailable'});
  }
  if(reservation.blocked){
    await logServer('warn','ai_quota_blocked', `quota blocked user ${userId||'anon'} ${reservation.reason}`, {userId, isDemo, count:reservation.count, limit:reservation.limit}, {req, source:'server-ai', payload:payloadCtx});
    return res.status(429).json({ ok:false, error:'quota exceeded', reason:reservation.reason, count:reservation.count, limit:reservation.limit });
  }
  monthlyQuota=reservation;

  let sessId;
  try{
    sessId=await createAuthorizedSession(db,{
      room:trustedRoom,userId:numericUserId,pairLabel:pair_label,
      transcript:transStr,code:codeFlat,questions:iq,durationSec:duration_sec,
      reservationId:reservation.reservationId,
    });
  }catch(error){
    try{ await refundMonthlyQuota(db,reservation); }catch{}
    if(error instanceof AiPairAccessError) return res.status(403).json({error:'trusted room membership required'});
    await logServer('error','ai_session_insert_fail',String(error?.message||error).slice(0,300),{room_id},{req,source:'server-ai'});
    return res.status(500).json({error:'session create failed'});
  }

  let modelUsed=picking.model.name, reason=picking.reason, estIn=picking.totalIn, estOut=900, costCents=Math.ceil((estIn/1e6*picking.model.price_in_per_mtok + estOut/1e6*picking.model.price_out_per_mtok)*100);
  let feedbackJson=null, groqUsage=null, mocked=false, openaiFallback=false;

  if(!process.env.GROQ_API_KEY && !process.env.OPENAI_API_KEY){
    mocked=true; modelUsed=picking.model.name+' (mocked)'; reason+=' | GROQ_API_KEY+OPENAI missing — template';
    const firstQuote=(transStr.split('\n').filter(l=>l.trim().length>10)[0]||'').slice(0,120);
    const codeLine=(codeFlat.split('\n').filter(l=>l.trim().length>3)[0]||'').slice(0,120);
    feedbackJson={ candidate:{ strengths:[{point:'Structured decomposition', evidence:firstQuote||codeLine||'clear walkthrough', confidence:0.75},{point:'Communicated tradeoffs', evidence:firstQuote||'explained', confidence:0.7}], improvements:[{point:'Edge-case handling', evidence:codeLine||'no direct quote', suggestion:'Ask empty/duplicate? guard clause'},{point:'Complexity clarity', evidence:'no direct quote', suggestion:'State O(n) time space'}]}, interviewer:{ strengths:[{point:'Kept focused', evidence:iq?.split('\n')[0]||'good pacing', confidence:0.7}], improvements:[{point:'Deeper follow-ups', evidence:'no direct quote', suggestion:'Ask what breaks 1M streaming'}]}, overall_score:7, next_time_checklist:['60s framing','one failing test','summarize complexity'] };
  } else if(!process.env.GROQ_API_KEY && process.env.OPENAI_API_KEY){
    openaiFallback=true; modelUsed='gpt-4o-mini (openai fallback)'; reason+=' | GROQ missing — using OpenAI';
    const prompt=buildPrompt({ role, transcript:transStr, code:codeFlat, interviewerQuestions:iq, durationSec:duration_sec, pairLabel:pair_label });
    let oRes=await callOpenAI({ modelName:picking.model.name, prompt });
    if(oRes.content){
      feedbackJson=parseProviderFeedback(oRes.content);
      groqUsage=oRes.usage;
      if(groqUsage?.prompt_tokens) estIn=groqUsage.prompt_tokens;
      if(groqUsage?.completion_tokens) estOut=groqUsage.completion_tokens;
      costCents=Math.ceil((estIn/1e6*0.15 + estOut/1e6*0.6)*100);
    } else {
      if(oRes.invalid_response){
        await logServer('error','ai_provider_invalid_envelope','AI provider returned an invalid response envelope',{room_id,model:modelUsed},{req,source:'server-ai'});
        return res.status(502).json({ok:false,error:'AI provider temporarily unavailable',session_id:sessId});
      }
      mocked=true; reason+=' | openai failed '+ (oRes.error||'unknown');
      feedbackJson={ candidate:{ strengths:[], improvements:[]}, interviewer:{strengths:[], improvements:[]}, overall_score:6, next_time_checklist:['retry with smaller transcript'] };
    }
  } else {
    const prompt=buildPrompt({ role, transcript:transStr, code:codeFlat, interviewerQuestions:iq, durationSec:duration_sec, pairLabel:pair_label });
    let groqRes=await callGroq({ modelName:picking.model.name, prompt });
    if(groqRes.error && !groqRes.content && picking.model.name!==MODELS.fast.name){
      const retry=await callGroq({ modelName:MODELS.fast.name, prompt:buildPrompt({ role, transcript:transStr.slice(0,8000), code:String(codeFlat).slice(0,6000), interviewerQuestions:iq, durationSec:duration_sec, pairLabel:pair_label })});
      if(retry.content){ modelUsed=MODELS.fast.name; reason+=` | primary failed (${groqRes.error.slice(0,80)}), fallback fast`; groqRes=retry; } else {
        reason+=` | primary and fast Groq failed`;
        groqRes=retry;
      }
    }
    if(groqRes.error && !groqRes.content){
      // try openai fallback if available
      if(process.env.OPENAI_API_KEY){
        const oRes=await callOpenAI({ modelName:picking.model.name, prompt:buildPrompt({ role, transcript:transStr, code:codeFlat, interviewerQuestions:iq, durationSec:duration_sec, pairLabel:pair_label })});
        if(oRes.content){
          openaiFallback=true; modelUsed='gpt-4o-mini (fallback)'; reason+=' | groq fail -> openai';
          feedbackJson=parseProviderFeedback(oRes.content);
          groqUsage=oRes.usage;
          if(groqUsage?.prompt_tokens) estIn=groqUsage.prompt_tokens;
          if(groqUsage?.completion_tokens) estOut=groqUsage.completion_tokens;
          costCents=Math.ceil((estIn/1e6*0.15 + estOut/1e6*0.6)*100);
        }else{
          await logServer('error','ai_groq_fail', groqRes.error.slice(0,300), {room_id}, {req, source:'server-ai'});
          return res.status(502).json({ ok:false, error:'AI provider temporarily unavailable', session_id:sessId });
        }
      } else {
        await logServer('error','ai_groq_fail', groqRes.error.slice(0,300), {room_id}, {req, source:'server-ai'});
        return res.status(502).json({ ok:false, error:'AI provider temporarily unavailable', session_id:sessId });
      }
    }
    if(groqRes && groqRes.content && !feedbackJson){
      feedbackJson=parseProviderFeedback(groqRes.content);
      groqUsage=groqRes.usage; if(groqUsage?.prompt_tokens) estIn=groqUsage.prompt_tokens; if(groqUsage?.completion_tokens) estOut=groqUsage.completion_tokens;
      costCents=Math.ceil((estIn/1e6*picking.model.price_in_per_mtok + estOut/1e6*picking.model.price_out_per_mtok)*100);
    }
  }

  feedbackJson=normalizeFeedback(feedbackJson);
  if(!feedbackJson){
    await logServer('error','ai_provider_invalid_feedback','AI provider returned invalid feedback JSON',{room_id,model:modelUsed},{req,source:'server-ai'});
    return res.status(502).json({ok:false,error:'AI provider temporarily unavailable',session_id:sessId});
  }

  const combined=`${transStr}\n${typeof codeFlat==='string'?codeFlat:JSON.stringify(codeFlat)}\n${iq}`;
  const verification=feedbackJson?verifyEvidence(feedbackJson, combined):{validated:0,total:0,score:0};

  let fbId;
  try{
    fbId=await createAuthorizedFeedback(db,{
      room:trustedRoom,userId:numericUserId,sessionId:sessId,role,
      feedback:feedbackJson,verification,modelUsed,reason,costCents,
      combinedLength:combined.length,
    });
  }catch(error){
    if(error instanceof AiPairAccessError) return res.status(403).json({error:'trusted room membership required'});
    await logServer('error','ai_feedback_insert_fail',String(error?.message||error).slice(0,300),{room_id,session_id:sessId},{req,source:'server-ai'});
    return res.status(500).json({error:'feedback create failed'});
  }

  try{ await db.execute({ sql:`INSERT INTO ai_usage (date,calls,tokens_in,tokens_out,updated_at) VALUES (?,?,?, ?, datetime('now')) ON CONFLICT(date) DO UPDATE SET calls=calls+1, tokens_in=tokens_in+excluded.tokens_in, tokens_out=tokens_out+excluded.tokens_out, updated_at=datetime('now')`, args:[today,1,estIn,estOut]}); }catch{}

  try{
    await db.execute({
      sql:`UPDATE ai_sessions SET cost_cents=?,ended_at=datetime('now')
        WHERE id=? AND room_id=? AND created_by=?
          AND EXISTS (${AUTH_ONLY_PAIR_ACCESS_SQL})`,
      args:[costCents,sessId,room_id,numericUserId,...pairAccessArgs(numericUserId,trustedRoom)],
    });
  }catch{}

  try{ await logServer('success','ai_analyze_success', `${anonMode?'anon':'user '+userId} -> ${modelUsed} ${verification.validated}/${verification.total} evidence cost ${costCents}c`, {session_id:sessId, feedback_id:fbId, model_used:modelUsed, mocked, openaiFallback, costCents, tokens_in:estIn, tokens_out:estOut, room_id, anon:anonMode, isDemo}, {req, source:'server-ai', user_id:userId, payload:payloadCtx}); }catch{}

  return res.json({ ok:true, mocked, openaiFallback, anon:anonMode, session_id:sessId, feedback_id:fbId, model_used:modelUsed, reason_for_pick:reason, estimated_cost:{ cents:costCents, usd:(costCents/100).toFixed(4), tokens_in:estIn, tokens_out:estOut, groq_usage:groqUsage||null }, evidence_validated:verification, feedback:feedbackJson, quota:{ demo:isDemo, calls_this_month:monthlyQuota.count } });
}

async function handleFeedback(req,res){
  if(req.method!=='GET') return res.status(405).json({error:'GET only'});
  let id=req.query?.id || req.query?.sessionId;
  if(!id){ try{ const u=new URL(req.url,'http://localhost'); id=u.searchParams.get('id')||u.searchParams.get('sessionId'); const parts=u.pathname.split('/'); const last=parts.pop(); if(last && last!=='feedback' && last!=='analyze' && last!=='history' && !isNaN(Number(last))) id=last; }catch{} }
  const authInfo=await tryAuth(req);
  if(!authInfo.authed) return res.status(401).json({error:'authentication required'});
  const db=getClient(); await ensureTables(db);

  const uid=Number(authInfo.userId);
  if(!Number.isSafeInteger(uid)||uid<1) return res.status(401).json({error:'authentication required'});
  if(id){
    const rs=await db.execute({
      sql:`SELECT af.*,ase.room_id,ase.pair_label,ase.created_by
        FROM ai_feedback af JOIN ai_sessions ase ON ase.id=af.session_id
        ${AUTH_SESSION_OWNERSHIP_JOINS}
        WHERE (af.session_id=? OR af.id=?) AND ${AUTH_SESSION_OWNERSHIP_WHERE}
        ORDER BY af.created_at DESC LIMIT 5`,
      args:[uid,id,id,...authSessionOwnershipArgs(uid).slice(1)],
    });
    if(!rs.rows.length){
      return res.status(404).json({ error:'not found', session_id:id});
    }
    // SQL enforces both creator ownership and source-tagged canonical-room membership.
    // Keep the postcondition because tests and adapters may return unexpected rows.
    const own = rs.rows.filter(r=> r.created_by==uid);
    if(!own.length){
      return res.status(403).json({error:'forbidden'});
    }
    const r=own[0];
    const parsedFeedback = (()=>{ try{ return JSON.parse(r.feedback_json);}catch{ return {}; }})();
    const parsedEvidence = (()=>{ try{ return r.evidence ? JSON.parse(r.evidence) : null; }catch{ return r.evidence; }})();
    return res.json({ ok:true, session_id:r.session_id, feedback_id:r.id, feedback:parsedFeedback, evidence:parsedEvidence, model_used:r.model_used, reason_for_pick:r.reason_for_pick, confidence:r.confidence, created_at:r.created_at, room_id:r.room_id, pair_label:r.pair_label, created_by:r.created_by });
  }

  const list=await db.execute({
    sql:`SELECT af.id,af.session_id,af.model_used,af.created_at,ase.room_id,ase.pair_label,af.confidence
      FROM ai_feedback af JOIN ai_sessions ase ON ase.id=af.session_id
      ${AUTH_SESSION_OWNERSHIP_JOINS}
      WHERE ${AUTH_SESSION_OWNERSHIP_WHERE}
      ORDER BY af.created_at DESC LIMIT 20`,
    args:authSessionOwnershipArgs(uid),
  });
  return res.json({ ok:true, count:list.rows.length, feedbacks:list.rows });
}

async function handleHistory(req,res){
  if(req.method!=='GET') return res.status(405).json({ error:'GET only'});
  const authInfo=await tryAuth(req);
  const uid=Number(authInfo.userId);
  if(!authInfo.authed){
    return res.status(401).json({error:'authentication required'});
  }
  if(!Number.isSafeInteger(uid)||uid<1) return res.status(401).json({error:'authentication required'});
  const db=getClient(); await ensureTables(db);
  const rs=await db.execute({
    sql:`SELECT af.id,af.session_id,af.role,af.model_used,af.estimated_cost_cents,
        af.confidence,af.created_at,ase.room_id,ase.pair_label,ase.duration_sec
      FROM ai_feedback af JOIN ai_sessions ase ON ase.id=af.session_id
      ${AUTH_SESSION_OWNERSHIP_JOINS}
      WHERE ${AUTH_SESSION_OWNERSHIP_WHERE}
      ORDER BY af.created_at DESC LIMIT 20`,
    args:authSessionOwnershipArgs(uid),
  });
  const today=todayISO(); let usage=null; try{ const u=await db.execute({ sql:`SELECT * FROM ai_usage WHERE date=?`, args:[today]}); usage=u.rows[0]||null; }catch{}
  // monthly quota info
  let monthly=null; try{ const q=await checkMonthlyQuota(db, uid, authInfo.isDemo); monthly={count:q.count, limit:q.limit, demo:authInfo.isDemo}; }catch{}
  return res.json({ ok:true, usage_today:usage, monthly, feedbacks:rs.rows });
}

export default async function handler(req,res){
  try{
    if(!verifyMutationOrigin(req)) return res.status(403).json({error:'cross-origin mutation rejected'});
    initSentry();
    const epRaw=getEndpoint(req);
    const ep=epRaw.replace('feedback/','feedback ').split(' ')[0];
    const path=(req.url||'').toLowerCase();
    if (ep==='analyze' || path.includes('/analyze')) return await handleAnalyze(req,res);
    if (ep.startsWith('feedback') || ep==='feedback' || path.includes('/feedback')) return await handleFeedback(req,res);
    if (ep==='history' || path.includes('/history')) return await handleHistory(req,res);
    if (req.method==='POST') return await handleAnalyze(req,res);
    return res.status(400).json({ error:'ai route required: analyze|feedback/:id|history', got:ep, available:['analyze','feedback','history'] });
  }catch(e){
    try{ await logServer('error','api_unhandled', String(e && e.message||e).slice(0,500), {stack: e && e.stack ? String(e.stack).slice(0,2000):'', url: req && req.url}, {req, source:'server-ai', route:req && req.url, skipSentry:true}); }catch{}
    captureSentryException(e, {tags:{event:'api_unhandled', source:'server-ai'}, extra:{route:req && req.url}});
    return res.status(500).json({ ok:false, error:'ai_unhandled' });
  }
}
