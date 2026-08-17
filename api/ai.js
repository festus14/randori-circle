import { getClient, getJwtSecret, initSentry, getSentry } from './_db.js';
import jwt from 'jsonwebtoken';
import * as SentryLib from '@sentry/node';

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
  // monthly aggregate optional
  try{ await db.execute(`CREATE TABLE IF NOT EXISTS ai_monthly_usage (month TEXT PRIMARY KEY, user_id INTEGER, calls INTEGER DEFAULT 0, tokens_in INTEGER DEFAULT 0, updated_at TEXT DEFAULT (datetime('now')))`) }catch{}
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
      if((lvl==='error' || lvl==='warn') && process.env.SENTRY_DSN){
        try{ initSentry(); }catch{}
        const {Sentry, ready} = (()=>{ try{ return getSentry(); }catch{ return {Sentry:null, ready:false}; } })();
        if(ready && Sentry){
          const tags={event: ev||'ai', level:lvl, source:src};
          if(lvl==='error'){
            Sentry.captureMessage(msg, {level:'error', tags, extra:{meta: metaStr?.slice(0,1500), route}});
          }else{
            Sentry.captureMessage(msg, {level:'warning', tags, extra:{meta: metaStr?.slice(0,1500)}});
          }
        }else if(SentryLib && SentryLib.captureMessage && process.env.SENTRY_DSN){
          SentryLib.captureMessage(msg, {level:lvl==='error'?'error':'warning'});
        }
      }
    }catch{}
  }catch{}
}

const MODELS = {
  fast: { name:'llama-3.1-8b-instant', price_in_per_mtok:0.05, price_out_per_mtok:0.08, context:131072 },
  balanced: { name:'llama-3.3-70b-versatile', price_in_per_mtok:0.59, price_out_per_mtok:0.79, context:131072 },
};

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

async function callGroq({ modelName, prompt }){
  const key=process.env.GROQ_API_KEY;
  if(!key) return { error:'missing GROQ_API_KEY', mocked:true };
  const body={ model:modelName, messages:[{role:'system',content:'You are JSON generator only.'},{role:'user',content:prompt}], temperature:0.25, max_tokens:1600, response_format:{type:'json_object'} };
  const res=await fetch('https://api.groq.com/openai/v1/chat/completions',{ method:'POST', headers:{ Authorization:`Bearer ${key}`, 'Content-Type':'application/json'}, body:JSON.stringify(body)});
  const text=await res.text(); let json; try{ json=JSON.parse(text);}catch{ json={error:`parse ${res.status}`, raw:text.slice(0,1200)}; }
  if(!res.ok) return { error:`groq ${res.status}: ${json.error?.message||json.error||text.slice(0,400)}`, status:res.status, raw:json };
  const content=json.choices?.[0]?.message?.content||''; return { content, usage:json.usage||{}, raw:json };
}

async function callOpenAI({ modelName, prompt }){
  const key=process.env.OPENAI_API_KEY;
  if(!key) return { error:'missing OPENAI_API_KEY' };
  const model = modelName.includes('70b') ? 'gpt-4o-mini' : 'gpt-4o-mini';
  const body={ model, messages:[{role:'system',content:'You are JSON generator only. Output JSON.'},{role:'user',content:prompt}], temperature:0.25, max_tokens:1500, response_format:{type:'json_object'} };
  const res=await fetch('https://api.openai.com/v1/chat/completions',{ method:'POST', headers:{ Authorization:`Bearer ${key}`, 'Content-Type':'application/json'}, body:JSON.stringify(body)});
  const text=await res.text(); let json; try{ json=JSON.parse(text);}catch{ json={error:`parse ${res.status}`, raw:text.slice(0,1200)}; }
  if(!res.ok) return { error:`openai ${res.status}: ${json.error?.message||json.error||text.slice(0,400)}`, status:res.status, raw:json };
  const content=json.choices?.[0]?.message?.content||''; return { content, usage:json.usage||{} };
}

function tryAuth(req){
  const auth=req.headers.authorization||''; const m=auth.match(/^Bearer\s+(.+)$/);
  if(!m) return { authed:false, userId:null, payload:null, isDemo:true };
  try{
    const payload=jwt.verify(m[1], getJwtSecret());
    const uid=payload.id??payload.uid??null;
    const isDemo = !!payload.is_demo || String(payload.email||'').includes('randori.demo');
    return { authed:true, userId:uid, payload, isDemo };
  }catch{ return { authed:false, userId:null, payload:null, isDemo:true, tokenInvalid:true }; }
}

async function resolveDemoFlag(db, authInfo){
  if(!authInfo?.userId) return true;
  try{
    const rs=await db.execute({sql:`SELECT is_demo FROM auth_accounts WHERE id=?`, args:[authInfo.userId]});
    if(rs.rows.length) return !!rs.rows[0].is_demo;
  }catch{}
  return !!authInfo.isDemo;
}

async function checkMonthlyQuota(db, userId, isDemo){
  if(!userId) return {blocked:false};
  try{
    const rs=await db.execute({sql:`SELECT COUNT(*) as c FROM ai_sessions WHERE created_by=? AND datetime(created_at) >= datetime('now','start of month')`, args:[userId]});
    const cnt=rs.rows[0]?.c||0;
    const limit = isDemo ? 100 : 500;
    if(cnt>=limit) return {blocked:true, count:cnt, limit, reason:`monthly limit ${limit} reached (${cnt} used) — upgrade or wait next month`};
    return {blocked:false, count:cnt, limit};
  }catch{
    return {blocked:false};
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
  let authInfo=tryAuth(req);
  let userId=authInfo.userId;
  let isDemo=authInfo.isDemo;
  let payloadCtx=authInfo.payload;
  // allow anon demo: do not early 401, just flag
  const anonMode = !authInfo.authed;
  let body;
  try{ body=await parseBody(req); }catch{ body={}; }

  // FormData / multipart plain handling: if body has FormData fields named payload etc
  // Body may include room_id etc in top-level
  const room_id = body.room_id || body.roomId || body.room || 'room-unknown';
  const pair_label = body.pair_label || body.pairLabel || '';
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
    return res.status(500).json({ error:'db unavailable', detail:String(e.message||e).slice(0,120) });
  }
  try{ await ensureTables(db); await ensureAppLogs(db); }catch{}

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
    const quota=await checkMonthlyQuota(db, userId, isDemo);
    if(quota.blocked){
      await logServer('warn','ai_quota_blocked', `quota blocked user ${userId||'anon'} ${quota.reason}`, {userId, isDemo, count:quota.count, limit:quota.limit}, {req, source:'server-ai', payload:payloadCtx});
      return res.status(429).json({ ok:false, error:'quota exceeded', reason:quota.reason, count:quota.count, limit:quota.limit });
    }
  }catch{}

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

  let sessId;
  try{
    const ins=await db.execute({ sql:`INSERT INTO ai_sessions (room_id, pair_label, transcript, code_snapshots, interviewer_questions, started_at, ended_at, duration_sec, created_by) VALUES (?,?,?,?,?,datetime('now'),datetime('now'),?,?) RETURNING id`, args:[room_id, pair_label||'mock', (transStr||'').slice(0,28000), (typeof code==='string'?code:JSON.stringify(code)).slice(0,28000), (iq||'').slice(0,8000), Number(duration_sec)||0, userId||null]});
    sessId=ins.rows[0].id;
  }catch{
    try{
      const ins2=await db.execute({ sql:`INSERT INTO ai_sessions (room_id, pair_label, transcript, code_snapshots, interviewer_questions, duration_sec, created_by) VALUES (?,?,?,?,?,?,?) RETURNING id`, args:[room_id, pair_label||'mock', (transStr||'').slice(0,8000), (typeof code==='string'?code.slice(0,8000):JSON.stringify(code).slice(0,8000)), (iq||'').slice(0,3000), Number(duration_sec)||0, userId||null]});
      sessId=ins2.rows[0].id;
    }catch(e){
      await logServer('error','ai_session_insert_fail', String(e.message||e).slice(0,300), {room_id}, {req, source:'server-ai'});
      return res.status(500).json({ error:'session create failed', detail:String(e.message||e).slice(0,200) });
    }
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
      try{ feedbackJson=typeof oRes.content==='string'?JSON.parse(oRes.content):oRes.content; }catch{ try{ feedbackJson=JSON.parse(oRes.content);}catch{ feedbackJson={ candidate:{strengths:[], improvements:[]}, interviewer:{strengths:[], improvements:[]}, overall_score:6, next_time_checklist:[oRes.content.slice(0,200)]}; } }
      groqUsage=oRes.usage;
      if(groqUsage?.prompt_tokens) estIn=groqUsage.prompt_tokens;
      if(groqUsage?.completion_tokens) estOut=groqUsage.completion_tokens;
      costCents=Math.ceil((estIn/1e6*0.15 + estOut/1e6*0.6)*100);
    } else {
      mocked=true; reason+=' | openai failed '+ (oRes.error||'unknown');
      feedbackJson={ candidate:{ strengths:[], improvements:[]}, interviewer:{strengths:[], improvements:[]}, overall_score:6, next_time_checklist:['retry with smaller transcript'] };
    }
  } else {
    const prompt=buildPrompt({ role, transcript:transStr, code:codeFlat, interviewerQuestions:iq, durationSec:duration_sec, pairLabel:pair_label });
    let groqRes=await callGroq({ modelName:picking.model.name, prompt });
    if(groqRes.error && !groqRes.content && picking.model.name!==MODELS.fast.name){
      const retry=await callGroq({ modelName:MODELS.fast.name, prompt:buildPrompt({ role, transcript:transStr.slice(0,8000), code:String(codeFlat).slice(0,6000), interviewerQuestions:iq, durationSec:duration_sec, pairLabel:pair_label })});
      if(retry.content){ modelUsed=MODELS.fast.name; reason+=` | primary failed (${groqRes.error.slice(0,80)}), fallback fast`; groqRes=retry; } else {
        await logServer('error','ai_groq_both_fail', groqRes.error.slice(0,300), {room_id, model:picking.model.name}, {req, source:'server-ai'});
        return res.status(502).json({ ok:false, error:'groq failed both', detail:groqRes.error, session_id:sessId });
      }
    } else if(groqRes.error && !groqRes.content){
      // try openai fallback if available
      if(process.env.OPENAI_API_KEY){
        const oRes=await callOpenAI({ modelName:picking.model.name, prompt:buildPrompt({ role, transcript:transStr, code:codeFlat, interviewerQuestions:iq, durationSec:duration_sec, pairLabel:pair_label })});
        if(oRes.content){
          openaiFallback=true; modelUsed='gpt-4o-mini (fallback)'; reason+=' | groq fail -> openai';
          try{ feedbackJson=typeof oRes.content==='string'?JSON.parse(oRes.content):oRes.content; }catch{ feedbackJson={ candidate:{strengths:[], improvements:[]}, overall_score:6, next_time_checklist:[oRes.content.slice(0,200)]}; }
          groqUsage=oRes.usage;
        }else{
          await logServer('error','ai_groq_fail', groqRes.error.slice(0,300), {room_id}, {req, source:'server-ai'});
          return res.status(502).json({ ok:false, error:'groq error', detail:groqRes.error, session_id:sessId });
        }
      } else {
        await logServer('error','ai_groq_fail', groqRes.error.slice(0,300), {room_id}, {req, source:'server-ai'});
        return res.status(502).json({ ok:false, error:'groq error', detail:groqRes.error, session_id:sessId });
      }
    }
    if(groqRes && groqRes.content && !feedbackJson){
      try{ feedbackJson=typeof groqRes.content==='string'?JSON.parse(groqRes.content):groqRes.content; }catch{ try{ feedbackJson=JSON.parse(groqRes.content);}catch{ feedbackJson={ candidate:{strengths:[], improvements:[]}, interviewer:{strengths:[], improvements:[]}, overall_score:6, next_time_checklist:[groqRes.content.slice(0,200)]}; } }
      groqUsage=groqRes.usage; if(groqUsage?.prompt_tokens) estIn=groqUsage.prompt_tokens; if(groqUsage?.completion_tokens) estOut=groqUsage.completion_tokens;
      costCents=Math.ceil((estIn/1e6*picking.model.price_in_per_mtok + estOut/1e6*picking.model.price_out_per_mtok)*100);
    }
  }

  const combined=`${transStr}\n${typeof codeFlat==='string'?codeFlat:JSON.stringify(codeFlat)}\n${iq}`;
  const verification=feedbackJson?verifyEvidence(feedbackJson, combined):{validated:0,total:0,score:0};

  try{ await db.execute({ sql:`INSERT INTO ai_usage (date,calls,tokens_in,tokens_out,updated_at) VALUES (?,?,?, ?, datetime('now')) ON CONFLICT(date) DO UPDATE SET calls=calls+1, tokens_in=tokens_in+excluded.tokens_in, tokens_out=tokens_out+excluded.tokens_out, updated_at=datetime('now')`, args:[today,1,estIn,estOut]}); }catch{}

  let fbId;
  try{
    const insFb=await db.execute({ sql:`INSERT INTO ai_feedback (session_id, role, feedback_json, evidence, model_used, reason_for_pick, estimated_cost_cents, confidence) VALUES (?,?,?,?,?,?,?,?) RETURNING id`, args:[sessId, role||'both', JSON.stringify(feedbackJson||{}), JSON.stringify({validation:verification, combined_len:combined.length}), modelUsed, reason, costCents, verification.score]});
    fbId=insFb.rows[0].id;
  }catch{
    try{ await db.execute({ sql:`INSERT INTO ai_feedback (session_id, role, feedback_json, model_used) VALUES (?,?,?,?)`, args:[sessId, role||'both', JSON.stringify(feedbackJson||{}), modelUsed]}); fbId=Date.now(); }catch(e){ fbIdsessId; }
  }

  try{ await db.execute({ sql:`UPDATE ai_sessions SET cost_cents=?, ended_at=datetime('now') WHERE id=?`, args:[costCents, sessId]});}catch{}

  try{ await logServer('success','ai_analyze_success', `${anonMode?'anon':'user '+userId} -> ${modelUsed} ${verification.validated}/${verification.total} evidence cost ${costCents}c`, {session_id:sessId, feedback_id:fbId, model_used:modelUsed, mocked, openaiFallback, costCents, tokens_in:estIn, tokens_out:estOut, room_id, anon:anonMode, isDemo}, {req, source:'server-ai', user_id:userId, payload:payloadCtx}); }catch{}

  return res.json({ ok:true, mocked, openaiFallback, anon:anonMode, session_id:sessId, feedback_id:fbId, model_used:modelUsed, reason_for_pick:reason, estimated_cost:{ cents:costCents, usd:(costCents/100).toFixed(4), tokens_in:estIn, tokens_out:estOut, groq_usage:groqUsage||null }, evidence_validated:verification, feedback:feedbackJson, quota:{ demo:isDemo, calls_this_month: (await checkMonthlyQuota(db, userId, isDemo)).count ?? 0 } });
}

async function handleFeedback(req,res){
  let id=req.query?.id || req.query?.sessionId;
  if(!id){ try{ const u=new URL(req.url,'http://localhost'); id=u.searchParams.get('id')||u.searchParams.get('sessionId'); const parts=u.pathname.split('/'); const last=parts.pop(); if(last && last!=='feedback' && last!=='analyze' && last!=='history' && !isNaN(Number(last))) id=last; }catch{} }
  const authInfo=tryAuth(req);
  const db=getClient(); await ensureTables(db);
  // anon demo allowed: if no auth, only allow if session created_by IS NULL
  if(!authInfo.authed){
    if(!id) return res.status(400).json({ error:'id required for anon feedback' });
    try{
      const rs=await db.execute({ sql:`SELECT af.*, ase.room_id, ase.pair_label, ase.created_by FROM ai_feedback af JOIN ai_sessions ase ON ase.id=af.session_id WHERE af.session_id=? OR af.id=? ORDER BY af.created_at DESC LIMIT 1`, args:[id,id]});
      if(!rs.rows.length) return res.status(404).json({ error:'not found', session_id:id});
      const row=rs.rows[0];
      if(row.created_by!==null && row.created_by!==undefined){
        return res.status(401).json({ error:'auth required for user sessions — sign in', demo_hint:'anon only for demo sessions where created_by IS NULL' });
      }
      try{ await logServer('info','ai_feedback_anon', `anon fetch feedback ${id}`, {session_id:id}, {req, source:'server-ai'}); }catch{}
      return res.json({ ok:true, anon:true, session_id:row.session_id, feedback: (()=>{ try{ return JSON.parse(row.feedback_json||'{}'); }catch{ return {}; }})(), model_used:row.model_used, reason_for_pick:row.reason_for_pick, confidence:row.confidence, created_at:row.created_at, evidence: (()=>{ try{ return JSON.parse(row.evidence||'null'); }catch{ return row.evidence; }})() });
    }catch(e){ return res.status(500).json({ error:'db fail', detail:String(e.message||e).slice(0,150) }); }
  }

  const uid=authInfo.userId;
  if(id){
    const rs=await db.execute({ sql:`SELECT af.*, ase.room_id, ase.pair_label, ase.created_by FROM ai_feedback af JOIN ai_sessions ase ON ase.id=af.session_id WHERE (af.session_id=? OR af.id=?) ORDER BY af.created_at DESC LIMIT 5`, args:[id,id]});
    if(!rs.rows.length){
      return res.status(404).json({ error:'not found', session_id:id});
    }
    // filter to own sessions unless admin? For now own or admin demo: if created_by matches uid or created_by IS NULL and authed user wants demo, allow first row
    const own = rs.rows.filter(r=> r.created_by==uid || r.created_by==null);
    if(!own.length){
      // allow if payload is admin (loosely) — we skip check for now and return first but with restricted?
      return res.status(403).json({ error:'forbidden — session owned by other user', session_owner: rs.rows[0].created_by });
    }
    const r=own[0];
    const parsedFeedback = (()=>{ try{ return JSON.parse(r.feedback_json);}catch{ return {}; }})();
    const parsedEvidence = (()=>{ try{ return r.evidence ? JSON.parse(r.evidence) : null; }catch{ return r.evidence; }})();
    return res.json({ ok:true, session_id:r.session_id, feedback_id:r.id, feedback:parsedFeedback, evidence:parsedEvidence, model_used:r.model_used, reason_for_pick:r.reason_for_pick, confidence:r.confidence, created_at:r.created_at, room_id:r.room_id, pair_label:r.pair_label, created_by:r.created_by });
  }

  const list=await db.execute({ sql:`SELECT af.id, af.session_id, af.model_used, af.created_at, ase.room_id, ase.pair_label, af.confidence FROM ai_feedback af JOIN ai_sessions ase ON ase.id=af.session_id WHERE ase.created_by=? ORDER BY af.created_at DESC LIMIT 20`, args:[uid]});
  return res.json({ ok:true, count:list.rows.length, feedbacks:list.rows });
}

async function handleHistory(req,res){
  if(req.method!=='GET') return res.status(405).json({ error:'GET only'});
  const authInfo=tryAuth(req);
  let uid=authInfo.userId;
  // anon history not allowed — return empty but ok anon flag
  if(!authInfo.authed){
    return res.json({ ok:true, anon:true, feedbacks:[], usage_today:null, message:'Sign in for persistent history — anon sessions ephemeral' });
  }
  const db=getClient(); await ensureTables(db);
  const rs=await db.execute({ sql:`SELECT af.id, af.session_id, af.role, af.model_used, af.estimated_cost_cents, af.confidence, af.created_at, ase.room_id, ase.pair_label, ase.duration_sec FROM ai_feedback af JOIN ai_sessions ase ON ase.id=af.session_id WHERE ase.created_by=? ORDER BY af.created_at DESC LIMIT 20`, args:[uid]});
  const today=todayISO(); let usage=null; try{ const u=await db.execute({ sql:`SELECT * FROM ai_usage WHERE date=?`, args:[today]}); usage=u.rows[0]||null; }catch{}
  // monthly quota info
  let monthly=null; try{ const q=await checkMonthlyQuota(db, uid, authInfo.isDemo); monthly={count:q.count, limit:q.limit, demo:authInfo.isDemo}; }catch{}
  return res.json({ ok:true, usage_today:usage, monthly, feedbacks:rs.rows });
}

export default async function handler(req,res){
  try{
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
    try{ await logServer('error','api_unhandled', String(e && e.message||e).slice(0,500), {stack: e && e.stack ? String(e.stack).slice(0,2000):'', url: req && req.url}, {req, source:'server-ai', route:req && req.url}); }catch{}
    try{
      const {Sentry, ready}= (()=>{ try{ return getSentry(); }catch{ return {Sentry:null, ready:false}; } })();
      if(ready && Sentry) Sentry.captureException(e);
      else if(SentryLib && SentryLib.captureException) SentryLib.captureException(e);
    }catch{}
    return res.status(500).json({ ok:false, error:'ai_unhandled', message:String(e.message||e).slice(0,300) });
  }
}
