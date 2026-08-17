import { getClient, getJwtSecret } from './_db.js';
import jwt from 'jsonwebtoken';

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
        if (low.includes(ev.toLowerCase().slice(0,120)) || low.includes(ev.toLowerCase())){ val++; }
        else{
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

async function handleAnalyze(req,res){
  if(req.method!=='POST') return res.status(405).json({ error:'POST only'});
  const auth=req.headers.authorization||''; const m=auth.match(/^Bearer\s+(.+)$/); if(!m) return res.status(401).json({ error:'missing Bearer token'});
  let payload; try{ payload=jwt.verify(m[1], getJwtSecret()); }catch(e){ return res.status(401).json({ error:'invalid token', detail:String(e.message||e).slice(0,120)}); }
  const userId=payload.id??payload.uid; if(!userId) return res.status(401).json({ error:'invalid payload'});
  let body=req.body; if(!body){ try{ const t=await new Promise((r,rej)=>{ let buf=''; req.on('data',c=>buf+=c); req.on('end',()=>r(buf)); req.on('error',rej); }); body=t?JSON.parse(t):{}; }catch{ body={}; } }
  const { room_id, pair_label, transcript, code, code_snapshots, interviewer_questions, duration, duration_sec, role } = body||{};
  const transStr=transcript||''; const codeStr=(code||code_snapshots||''); const codeFlat=typeof codeStr==='string'?codeStr:JSON.stringify(codeStr||''); const iq=interviewer_questions||''; const durSec=duration_sec??duration??0;
  if(!transStr && !codeFlat) return res.status(400).json({ error:'transcript or code required'});
  const db=getClient(); await ensureTables(db);
  const today=todayISO(); let usageRow={calls:0,tokens_in:0}; try{ const ur=await db.execute({ sql:`SELECT calls,tokens_in FROM ai_usage WHERE date=?`, args:[today]}); if(ur.rows.length) usageRow=ur.rows[0]; }catch{}
  const picking=pickModel({ transcript:transStr, code:codeFlat, role, durationSec:durSec, interviewerQuestions:iq, usage:usageRow });
  let sessId; try{ const ins=await db.execute({ sql:`INSERT INTO ai_sessions (room_id, pair_label, transcript, code_snapshots, interviewer_questions, started_at, ended_at, duration_sec, created_by) VALUES (?,?,?,?,?,datetime('now'),datetime('now'),?,?) RETURNING id`, args:[room_id||'room', pair_label||'mock', (transStr||'').slice(0,28000), (typeof codeStr==='string'?codeStr:JSON.stringify(codeStr)).slice(0,28000), (iq||'').slice(0,8000), Number(durSec)||0, userId]}); sessId=ins.rows[0].id; }catch{ const ins2=await db.execute({ sql:`INSERT INTO ai_sessions (room_id, pair_label, transcript) VALUES (?,?,?) RETURNING id`, args:[room_id||'room', pair_label||'mock', (transStr||'').slice(0,8000)]}); sessId=ins2.rows[0].id; }
  let modelUsed=picking.model.name, reason=picking.reason, estIn=picking.totalIn, estOut=900, costCents=Math.ceil((estIn/1e6*picking.model.price_in_per_mtok + estOut/1e6*picking.model.price_out_per_mtok)*100);
  let feedbackJson=null, groqUsage=null, mocked=false;
  if(!process.env.GROQ_API_KEY){
    mocked=true; modelUsed=picking.model.name+' (mocked)'; reason+=' | GROQ_API_KEY missing — template'; const firstQuote=(transStr.split('\n').filter(l=>l.trim().length>10)[0]||'').slice(0,120); const codeLine=(codeFlat.split('\n').filter(l=>l.trim().length>3)[0]||'').slice(0,120);
    feedbackJson={ candidate:{ strengths:[{point:'Structured decomposition', evidence:firstQuote||codeLine||'clear walkthrough', confidence:0.75},{point:'Communicated tradeoffs', evidence:firstQuote||'explained', confidence:0.7}], improvements:[{point:'Edge-case handling', evidence:codeLine||'no direct quote', suggestion:'Ask empty/duplicate? guard clause'},{point:'Complexity clarity', evidence:'no direct quote', suggestion:'State O(n) time space'}]}, interviewer:{ strengths:[{point:'Kept focused', evidence:iq?.split('\n')[0]||'good pacing', confidence:0.7}], improvements:[{point:'Deeper follow-ups', evidence:'no direct quote', suggestion:'Ask what breaks 1M streaming'}]}, overall_score:7, next_time_checklist:['60s framing','one failing test','summarize complexity'] };
  } else {
    const prompt=buildPrompt({ role, transcript:transStr, code:codeStr, interviewerQuestions:iq, durationSec:durSec, pairLabel:pair_label });
    let groqRes=await callGroq({ modelName:picking.model.name, prompt });
    if(groqRes.error && !groqRes.content && picking.model.name!==MODELS.fast.name){
      const retry=await callGroq({ modelName:MODELS.fast.name, prompt:buildPrompt({ role, transcript:transStr.slice(0,8000), code:String(codeStr).slice(0,6000), interviewerQuestions:iq, durationSec:durSec, pairLabel:pair_label })});
      if(retry.content){ modelUsed=MODELS.fast.name; reason+=` | primary failed (${groqRes.error.slice(0,80)}), fallback fast`; groqRes=retry; } else return res.status(502).json({ ok:false, error:'groq failed both', detail:groqRes.error, session_id:sessId });
    } else if(groqRes.error && !groqRes.content) return res.status(502).json({ ok:false, error:'groq error', detail:groqRes.error, session_id:sessId });
    if(groqRes.content){
      try{ feedbackJson=typeof groqRes.content==='string'?JSON.parse(groqRes.content):groqRes.content; }catch{ try{ feedbackJson=JSON.parse(groqRes.content);}catch{ feedbackJson={ candidate:{strengths:[], improvements:[]}, interviewer:{strengths:[], improvements:[]}, overall_score:6, next_time_checklist:[groqRes.content.slice(0,200)]}; } }
      groqUsage=groqRes.usage; if(groqUsage?.prompt_tokens) estIn=groqUsage.prompt_tokens; if(groqUsage?.completion_tokens) estOut=groqUsage.completion_tokens;
      costCents=Math.ceil((estIn/1e6*picking.model.price_in_per_mtok + estOut/1e6*picking.model.price_out_per_mtok)*100);
    }
  }
  const combined=`${transStr}\n${typeof codeStr==='string'?codeStr:JSON.stringify(codeStr)}\n${iq}`;
  const verification=feedbackJson?verifyEvidence(feedbackJson, combined):{validated:0,total:0,score:0};
  try{ await db.execute({ sql:`INSERT INTO ai_usage (date,calls,tokens_in,tokens_out,updated_at) VALUES (?,?,?, ?, datetime('now')) ON CONFLICT(date) DO UPDATE SET calls=calls+1, tokens_in=tokens_in+excluded.tokens_in, tokens_out=tokens_out+excluded.tokens_out, updated_at=datetime('now')`, args:[today,1,estIn,estOut]}); }catch{}
  let fbId; try{ const insFb=await db.execute({ sql:`INSERT INTO ai_feedback (session_id, role, feedback_json, evidence, model_used, reason_for_pick, estimated_cost_cents, confidence) VALUES (?,?,?,?,?,?,?,?) RETURNING id`, args:[sessId, role||'both', JSON.stringify(feedbackJson||{}), JSON.stringify({validation:verification, combined_len:combined.length}), modelUsed, reason, costCents, verification.score]}); fbId=insFb.rows[0].id; }catch{ await db.execute({ sql:`INSERT INTO ai_feedback (session_id, role, feedback_json, model_used) VALUES (?,?,?,?)`, args:[sessId, role||'both', JSON.stringify(feedbackJson||{}), modelUsed]}); fbId=Date.now(); }
  try{ await db.execute({ sql:`UPDATE ai_sessions SET cost_cents=?, ended_at=datetime('now') WHERE id=?`, args:[costCents, sessId]});}catch{}
  return res.json({ ok:true, mocked, session_id:sessId, feedback_id:fbId, model_used:modelUsed, reason_for_pick:reason, estimated_cost:{ cents:costCents, usd:(costCents/100).toFixed(4), tokens_in:estIn, tokens_out:estOut, groq_usage:groqUsage||null }, evidence_validated:verification, feedback:feedbackJson });
}

async function handleFeedback(req,res){
  let id=req.query?.id || req.query?.sessionId;
  if(!id){ try{ const u=new URL(req.url,'http://localhost'); id=u.searchParams.get('id')||u.searchParams.get('sessionId'); const parts=u.pathname.split('/'); const last=parts.pop(); if(last && last!=='feedback' && last!=='analyze' && last!=='history' && !isNaN(Number(last))) id=last; }catch{} }
  const auth=req.headers.authorization||''; const m=auth.match(/^Bearer\s+(.+)$/); if(!m) return res.status(401).json({ error:'missing Bearer'}); let payload; try{ payload=jwt.verify(m[1], getJwtSecret()); }catch{ return res.status(401).json({ error:'invalid token'}); }
  const db=getClient(); await ensureTables(db);
  if(id){
    const rs=await db.execute({ sql:`SELECT af.*, ase.room_id, ase.pair_label FROM ai_feedback af JOIN ai_sessions ase ON ase.id=af.session_id WHERE af.session_id=? ORDER BY af.created_at DESC LIMIT 1`, args:[id]});
    if(!rs.rows.length){ const rs2=await db.execute({ sql:`SELECT * FROM ai_feedback WHERE id=?`, args:[id]}); if(!rs2.rows.length) return res.status(404).json({ error:'not found', session_id:id}); const row=rs2.rows[0]; return res.json({ ok:true, session_id:row.session_id, feedback: JSON.parse(row.feedback_json||'{}'), model_used:row.model_used, created_at:row.created_at }); }
    return res.json({ ok:true, data: rs.rows.map(r=>({ ...r, feedback: (()=>{ try{ return JSON.parse(r.feedback_json);}catch{ return {}; }})() })) });
  }
  const uid=payload.id??payload.uid;
  const list=await db.execute({ sql:`SELECT af.id, af.session_id, af.model_used, af.created_at, ase.room_id, ase.pair_label FROM ai_feedback af JOIN ai_sessions ase ON ase.id=af.session_id WHERE ase.created_by=? ORDER BY af.created_at DESC LIMIT 20`, args:[uid]});
  return res.json({ ok:true, count:list.rows.length, feedbacks:list.rows });
}

async function handleHistory(req,res){
  if(req.method!=='GET') return res.status(405).json({ error:'GET only'});
  const auth=req.headers.authorization||''; const m=auth.match(/^Bearer\s+(.+)$/); if(!m) return res.status(401).json({ error:'missing Bearer'}); let payload; try{ payload=jwt.verify(m[1], getJwtSecret()); }catch{ return res.status(401).json({ error:'invalid'}); }
  const uid=payload.id??payload.uid; const db=getClient(); await ensureTables(db);
  const rs=await db.execute({ sql:`SELECT af.id, af.session_id, af.role, af.model_used, af.estimated_cost_cents, af.confidence, af.created_at, ase.room_id, ase.pair_label, ase.duration_sec FROM ai_feedback af JOIN ai_sessions ase ON ase.id=af.session_id WHERE ase.created_by=? ORDER BY af.created_at DESC LIMIT 20`, args:[uid]});
  const today=todayISO(); let usage=null; try{ const u=await db.execute({ sql:`SELECT * FROM ai_usage WHERE date=?`, args:[today]}); usage=u.rows[0]||null; }catch{}
  return res.json({ ok:true, usage_today:usage, feedbacks:rs.rows });
}

export default async function handler(req,res){
  const epRaw=getEndpoint(req);
  const ep=epRaw.replace('feedback/','feedback ').split(' ')[0];
  const path=(req.url||'').toLowerCase();
  if (ep==='analyze' || path.includes('/analyze')) return handleAnalyze(req,res);
  if (ep.startsWith('feedback') || ep==='feedback' || path.includes('/feedback')) return handleFeedback(req,res);
  if (ep==='history' || path.includes('/history')) return handleHistory(req,res);
  // default infer: POST with transcript/code => analyze
  if (req.method==='POST') return handleAnalyze(req,res);
  return res.status(400).json({ error:'ai route required: analyze|feedback/:id|history', got:ep, available:['analyze','feedback','history'] });
}
