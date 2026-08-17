// api/ai/[...slug].js — Groq-powered AI feedback router with evidence enforcement
// Handles: POST /api/ai/analyze, GET /api/ai/feedback/:id or ?id=, GET /api/ai/history
// Counting usage for free-tier guard, model auto-pick by session/needs/cost

import { getClient, getJwtSecret } from '../_db.js';
import jwt from 'jsonwebtoken';

function getSlug(req) {
  let slug = req.query?.slug;
  if (!slug) {
    try {
      const u = new URL(req.url, 'http://localhost');
      const parts = u.pathname.split('/').filter(Boolean);
      // /api/ai/analyze -> idx of ai then rest
      const idx = parts.indexOf('ai');
      if (idx >= 0) return parts.slice(idx + 1);
      return [];
    } catch { return []; }
  }
  if (typeof slug === 'string') return [slug];
  return slug;
}

function todayISO() { const d = new Date(); return d.toISOString().slice(0,10); }

async function ensureTables(db) {
  // ai_sessions stores raw recording
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

// Groq model catalog (cheap/free-first)
const MODELS = {
  fast: { name: 'llama-3.1-8b-instant', price_in_per_mtok: 0.05, price_out_per_mtok: 0.08, context: 131072, speed: 'fast' },
  balanced: { name: 'llama-3.3-70b-versatile', price_in_per_mtok: 0.59, price_out_per_mtok: 0.79, context: 131072, speed: 'balanced' },
  long: { name: 'llama-3.1-70b-versatile', price_in_per_mtok: 0.59, price_out_per_mtok: 0.79, context: 131072, speed: 'reasoning' },
  mixtral: { name: 'mixtral-8x7b-32768', price_in_per_mtok: 0.24, price_out_per_mtok: 0.24, context: 32768, speed: 'balanced' },
};

function estimateTokens(str) {
  if (!str) return 0;
  // ~4 chars per token rough
  return Math.ceil(String(str).length / 4);
}

function pickModel({ transcript, code, role, durationSec, interviewerQuestions, usage }) {
  const transTokens = estimateTokens(transcript);
  const codeTokens = estimateTokens(code);
  const totalIn = transTokens + codeTokens + 800; // prompt overhead
  const totalTokens = totalIn;

  // Free-tier guard: Groq free 14,400 req/day (14.4k), 6k TPM soft. If near limit, force cheap.
  const callsToday = usage?.calls || 0;
  const nearLimit = callsToday > 13000; // 90% of 14400
  const heavyUsage = usage?.tokens_in > 8000000; // 8M tokens day

  // Decision tree per spec
  if (nearLimit || heavyUsage) {
    return {
      model: MODELS.fast,
      reason: `free-tier guard: ${callsToday} calls today (cap 14.4k) — forced cheap/fast`,
      totalIn,
      totalTokens
    };
  }
  if (totalTokens > 6000 || transcript?.length > 24000) {
    return {
      model: MODELS.balanced,
      reason: `long transcript/code ~${totalTokens} tokens (>6k) needs 70b for summarization + reasoning`,
      totalIn,
      totalTokens
    };
  }
  if ((interviewerQuestions && String(interviewerQuestions).length > 500) || durationSec > 20*60) {
    return {
      model: MODELS.balanced,
      reason: `system design / longer session (duration ${Math.round((durationSec||0)/60)}m, interviewer_qs present) → 70b versatile for deeper analysis`,
      totalIn,
      totalTokens
    };
  }
  // code review / quick feedback short
  return {
    model: MODELS.fast,
    reason: `short session ~${totalTokens} tokens, ${role||'both'} role → 8b-instant cheapest/fastest`,
    totalIn,
    totalTokens
  };
}

function buildPrompt({ role, transcript, code, interviewerQuestions, durationSec, pairLabel }) {
  // Evidence = must be exact substring quote from transcript/code
  return `You are Randori AI — a senior Staff interview coach analyzing a mock interview.

Session: ${pairLabel||'mock pair'} — duration ${durationSec? Math.round(durationSec/60)+' min' : 'unknown'} — focus role ${role||'both'}

TRANSCRIPT (candidate + interviewer dialogue, possibly manual notes):
${(transcript||'(no transcript)').slice(0, 18000)}

CODE SNAPSHOTS (latest or diff):
${(typeof code === 'string' ? code : JSON.stringify(code||'')).slice(0, 12000)}

INTERVIEWER QUESTIONS ASKED:
${(interviewerQuestions||'(none provided)').slice(0, 4000)}

Produce STRICT JSON only (no markdown, no surrounding text) with this shape:
{
  "candidate": {
    "strengths": [ {"point":"...", "evidence":"exact quote or code line from above", "confidence": 0.0-1.0 } ],
    "improvements": [ {"point":"...", "evidence":"exact quote or line showing issue", "suggestion":"concrete next step"} ]
  },
  "interviewer": {
    "strengths": [ {"point":"...", "evidence":"quote"} ],
    "improvements": [ {"point":"...", "evidence":"...", "suggestion":"..."} ]
  },
  "overall_score": 1-10,
  "next_time_checklist": ["item1","item2","item3"]
}

Rules:
- 2-3 strengths + 2-3 improvements per role, concrete not generic.
- Evidence field MUST be a verbatim substring (5-20 words) present in TRANSCRIPT or CODE above. Do NOT invent quotes.
- If no evidence exists, set evidence to "" empty string.
- Keep suggestions actionable for next mock.
- JSON only.`;
}

function verifyEvidence(feedback, transcriptCombined) {
  const combined = (transcriptCombined||'').toLowerCase();
  let validated = 0;
  let total = 0;
  let loweredConfidence = false;
  const roles = ['candidate','interviewer'];
  for (const r of roles) {
    const section = feedback[r];
    if (!section) continue;
    for (const kind of ['strengths','improvements']) {
      const arr = section[kind]||[];
      for (const item of arr) {
        total++;
        const ev = (item.evidence||'').trim();
        if (!ev) {
          item.evidence = 'no direct quote';
          item.confidence = Math.min(item.confidence||0.9, 0.55);
          loweredConfidence = true;
          continue;
        }
        // check substring case-insensitive, at least 4 chars
        if (combined.includes(ev.toLowerCase().slice(0, 120)) || combined.includes(ev.toLowerCase())) {
          validated++;
        } else {
          // try fuzzy: any 5-word chunk present?
          const words = ev.split(/\s+/).filter(Boolean);
          let found = false;
          if (words.length >= 5) {
            for (let i=0;i<=words.length-5;i++) {
              const chunk = words.slice(i,i+5).join(' ').toLowerCase();
              if (chunk.length>10 && combined.includes(chunk)) { found = true; break; }
            }
          }
          if (!found && words.length>=3) {
            // last resort: any 3-word chunk
            for (let i=0;i<=words.length-3;i++) {
              const chunk = words.slice(i,i+3).join(' ').toLowerCase();
              if (chunk.length>8 && combined.includes(chunk)) { found=true; break; }
            }
          }
          if (found) validated++;
          else {
            item.evidence = 'no direct quote - inferred from session flow';
            if (item.confidence) item.confidence = Math.min(item.confidence, 0.6);
            loweredConfidence = true;
          }
        }
      }
    }
  }
  const score = total ? validated/total : 1;
  return { validated, total, score, loweredConfidence };
}

async function callGroq({ modelName, prompt }) {
  const key = process.env.GROQ_API_KEY;
  if (!key) return { error: 'missing GROQ_API_KEY env', mocked: true };
  const url = 'https://api.groq.com/openai/v1/chat/completions';
  // Groq is OpenAI-compatible
  const body = {
    model: modelName,
    messages: [
      { role: 'system', content: 'You are a precise interview feedback JSON generator. Output JSON only.' },
      { role: 'user', content: prompt }
    ],
    temperature: 0.25,
    max_tokens: 1600,
    response_format: { type: 'json_object' }
  };
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${key}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(body)
  });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = { error: `groq parse error ${res.status}`, raw: text.slice(0,1200) }; }
  if (!res.ok) {
    return { error: `groq ${res.status}: ${json.error?.message||json.error||text.slice(0,400)}`, status: res.status, raw: json };
  }
  // OpenAI shape: choices[0].message.content is JSON string
  const content = json.choices?.[0]?.message?.content || json.output || '';
  const usage = json.usage || {};
  return { content, usage, raw: json };
}

async function handleAnalyze(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
  // JWT auth
  const auth = req.headers.authorization || '';
  const m = auth.match(/^Bearer\s+(.+)$/);
  if (!m) return res.status(401).json({ error: 'missing Bearer token - sign in required' });
  let payload;
  try { payload = jwt.verify(m[1], getJwtSecret()); } catch(e){ return res.status(401).json({ error:'invalid token', detail: String(e.message||e).slice(0,120)}); }
  const userId = payload.id ?? payload.uid;
  if (!userId) return res.status(401).json({ error:'invalid token payload' });

  let body = req.body;
  if (!body) {
    try { const t = await new Promise((r, rej)=>{ let buf=''; req.on('data', c=>buf+=c); req.on('end',()=>r(buf)); req.on('error', rej); }); body = t? JSON.parse(t): {}; } catch { body = {}; }
  }
  const { room_id, pair_label, transcript, code, code_snapshots, interviewer_questions, duration, duration_sec, started_at, ended_at, role } = body||{};
  const transStr = transcript || '';
  const codeStr = (code || code_snapshots || '');
  const codeFlat = typeof codeStr === 'string' ? codeStr : JSON.stringify(codeStr||'');
  const iq = interviewer_questions || '';
  const durSec = duration_sec ?? duration ?? 0;
  if (!transStr && !codeFlat) return res.status(400).json({ error: 'transcript or code required' });

  const db = getClient();
  await ensureTables(db);

  const today = todayISO();
  let usageRow = { calls:0, tokens_in:0 };
  try {
    const ur = await db.execute({ sql:`SELECT calls, tokens_in FROM ai_usage WHERE date=?`, args:[today] });
    if (ur.rows.length) usageRow = ur.rows[0];
  } catch {}

  const picking = pickModel({ transcript: transStr, code: codeFlat, role, durationSec: durSec, interviewerQuestions: iq, usage: usageRow });

  // create session row first
  const codeJson = typeof codeStr === 'string' ? codeStr : JSON.stringify(codeStr);
  let sessId;
  try {
    const ins = await db.execute({
      sql:`INSERT INTO ai_sessions (room_id, pair_label, transcript, code_snapshots, interviewer_questions, started_at, ended_at, duration_sec, created_by) VALUES (?,?,?,?,?,datetime('now'),datetime('now'),?,?) RETURNING id`,
      args:[room_id||'room', pair_label||'mock', (transStr||'').slice(0,28000), (codeJson||'').slice(0,28000), (iq||'').slice(0,8000), Number(durSec)||0, userId]
    });
    sessId = ins.rows[0].id;
  } catch(e){
    // fallback id generation attempt
    const ins2 = await db.execute({ sql:`INSERT INTO ai_sessions (room_id, pair_label, transcript) VALUES (?,?,?) RETURNING id`, args:[room_id||'room', pair_label||'mock', (transStr||'').slice(0,8000)] });
    sessId = ins2.rows[0].id;
  }

  let modelUsed = picking.model.name;
  let reason = picking.reason;
  let estimatedTokensIn = picking.totalIn;
  let estimatedTokensOut = 900; // rough
  let estimatedCostCents = Math.ceil((estimatedTokensIn/1_000_000 * picking.model.price_in_per_mtok + estimatedTokensOut/1_000_000 * picking.model.price_out_per_mtok)*100);

  let feedbackJson = null;
  let evidenceResult = null;
  let groqUsage = null;
  let mocked = false;

  if (!process.env.GROQ_API_KEY) {
    mocked = true;
    modelUsed = picking.model.name + ' (mocked - no key)';
    reason += ' | GROQ_API_KEY missing — returning template feedback';
    // template feedback with actual evidence pulled from transcript/code
    const firstQuote = (transStr.split('\n').filter(l=>l.trim().length>10)[0]||'').slice(0,120);
    const codeLine = (codeFlat.split('\n').filter(l=>l.trim().length>3)[0]||'').slice(0,120);
    feedbackJson = {
      candidate: {
        strengths: [
          { point: 'Structured problem decomposition', evidence: firstQuote||codeLine||'clear walkthrough in session', confidence: 0.75 },
          { point: 'Communicated tradeoffs verbally', evidence: firstQuote||'explained approach', confidence: 0.7 }
        ],
        improvements: [
          { point: 'Edge-case handling', evidence: codeLine||'no direct quote', suggestion: 'Ask "what if input empty / duplicate?" before coding, add guard clause' },
          { point: 'Complexity clarity', evidence: 'no direct quote', suggestion: 'State time/space explicitly after first pass: O(n) time O(n) space' }
        ]
      },
      interviewer: {
        strengths: [
          { point: 'Kept session focused, allowed candidate to drive', evidence: iq?.split('\n')[0]||'good pacing', confidence: 0.7 }
        ],
        improvements: [
          { point: 'Deeper follow-ups', evidence: 'no direct quote', suggestion: 'Ask "what breaks if we stream 1M values?" to test scaling' }
        ]
      },
      overall_score: 7,
      next_time_checklist: ['Start with 60s framing: "we need X because Y"', 'Write one failing test before logic', 'Summarize complexity + one tradeoff at end']
    };
  } else {
    const prompt = buildPrompt({ role, transcript: transStr, code: codeStr, interviewerQuestions: iq, durationSec: durSec, pairLabel: pair_label });
    const groqRes = await callGroq({ modelName: picking.model.name, prompt });
    if (groqRes.error && !groqRes.content) {
      // groq failed - fallback to cheaper model once or return error with template
      if (picking.model.name !== MODELS.fast.name) {
        // retry with fast
        const fallbackPrompt = buildPrompt({ role, transcript: transStr.slice(0,8000), code: String(codeStr).slice(0,6000), interviewerQuestions: iq, durationSec: durSec, pairLabel: pair_label });
        const retry = await callGroq({ modelName: MODELS.fast.name, prompt: fallbackPrompt });
        if (retry.content) {
          modelUsed = MODELS.fast.name;
          reason += ` | primary ${picking.model.name} failed (${groqRes.error.slice(0,80)}), fell back to fast`;
          groqRes.content = retry.content;
          groqRes.usage = retry.usage;
        } else {
          return res.status(502).json({ ok:false, error:'groq failed both models', detail: groqRes.error, fallback_model_error: retry.error, session_id: sessId, model_attempted: picking.model.name });
        }
      } else {
        return res.status(502).json({ ok:false, error:'groq error', detail: groqRes.error, session_id: sessId, model_used: modelUsed });
      }
    }
    if (groqRes.content) {
      try {
        feedbackJson = typeof groqRes.content === 'string' ? JSON.parse(groqRes.content) : groqRes.content;
      } catch {
        // content may already be object from raw
        try { feedbackJson = JSON.parse(groqRes.content); } catch { feedbackJson = { candidate:{strengths:[], improvements:[]}, interviewer:{strengths:[], improvements:[]}, overall_score:6, next_time_checklist:[groqRes.content?.slice?.(0,200)||'review'] }; }
      }
      groqUsage = groqRes.usage;
      if (groqUsage?.prompt_tokens) estimatedTokensIn = groqUsage.prompt_tokens;
      if (groqUsage?.completion_tokens) estimatedTokensOut = groqUsage.completion_tokens;
      estimatedCostCents = Math.ceil((estimatedTokensIn/1_000_000 * picking.model.price_in_per_mtok + estimatedTokensOut/1_000_000 * picking.model.price_out_per_mtok)*100);
    }
  }

  // evidence enforcement
  const combinedForVerify = `${transStr}\n${typeof codeStr==='string'? codeStr : JSON.stringify(codeStr)}\n${iq}`;
  const verification = feedbackJson ? verifyEvidence(feedbackJson, combinedForVerify) : { validated:0, total:0, score:0 };

  // usage bump
  try {
    await db.execute({ sql:`INSERT INTO ai_usage (date,calls,tokens_in,tokens_out,updated_at) VALUES (?,?,?, ?, datetime('now')) ON CONFLICT(date) DO UPDATE SET calls=calls+1, tokens_in=tokens_in+excluded.tokens_in, tokens_out=tokens_out+excluded.tokens_out, updated_at=datetime('now')`, args:[today, 1, estimatedTokensIn, estimatedTokensOut] });
  } catch {}

  // store feedback
  let fbId;
  try {
    const insFb = await db.execute({
      sql:`INSERT INTO ai_feedback (session_id, role, feedback_json, evidence, model_used, reason_for_pick, estimated_cost_cents, confidence) VALUES (?,?,?,?,?,?,?,?) RETURNING id`,
      args:[sessId, role||'both', JSON.stringify(feedbackJson||{}), JSON.stringify({ validation: verification, combined_len: combinedForVerify.length }), modelUsed, reason, estimatedCostCents, verification.score]
    });
    fbId = insFb.rows[0].id;
  } catch(e){
    // try without returning
    await db.execute({ sql:`INSERT INTO ai_feedback (session_id, role, feedback_json, model_used) VALUES (?,?,?,?)`, args:[sessId, role||'both', JSON.stringify(feedbackJson||{}), modelUsed] });
    fbId = Date.now();
  }

  // update session cost
  try { await db.execute({ sql:`UPDATE ai_sessions SET cost_cents=?, ended_at=datetime('now') WHERE id=?`, args:[estimatedCostCents, sessId] }); } catch {}

  return res.json({
    ok: true,
    mocked,
    session_id: sessId,
    feedback_id: fbId,
    model_used: modelUsed,
    reason_for_pick: reason,
    estimated_cost: { cents: estimatedCostCents, usd: (estimatedCostCents/100).toFixed(4), tokens_in: estimatedTokensIn, tokens_out: estimatedTokensOut, groq_usage: groqUsage||null },
    evidence_validated: verification,
    feedback: feedbackJson,
    debug: {
      groq_router: {
        picked: modelUsed,
        why: reason,
        alternatives: [`${MODELS.fast.name} $0.05/1M cheap/fast`, `${MODELS.balanced.name} $0.59/1M deeper`],
        free_tier_calls_today: usageRow.calls||0,
        free_tier_cap: 14400
      },
      room_id: room_id||null,
      pair_label: pair_label||null
    }
  });
}

async function handleFeedbackGet(req, res) {
  const slug = getSlug(req);
  let id = null;
  if (slug.length===2 && slug[0]==='feedback') id = slug[1];
  else if (slug.length===1 && slug[0]!=='analyze' && slug[0]!=='feedback' && slug[0]!=='history') id = slug[0];
  else {
    // query param ?id=
    try { const u = new URL(req.url,'http://localhost'); id = u.searchParams.get('id') || u.searchParams.get('sessionId'); } catch {}
  }
  if (id && (id==='feedback' || id==='analyze' || id==='history')) id=null; // /api/ai/feedback without id -> list?
  const auth = req.headers.authorization||'';
  const m = auth.match(/^Bearer\s+(.+)$/);
  if (!m) return res.status(401).json({ error:'missing Bearer' });
  let payload; try { payload = jwt.verify(m[1], getJwtSecret()); } catch { return res.status(401).json({ error:'invalid token'}); }
  const db = getClient();
  await ensureTables(db);
  if (id) {
    const rs = await db.execute({ sql:`SELECT af.*, ase.room_id, ase.pair_label, ase.transcript FROM ai_feedback af JOIN ai_sessions ase ON ase.id=af.session_id WHERE af.session_id=? ORDER BY af.created_at DESC LIMIT 1`, args:[id] });
    if (!rs.rows.length) {
      const rs2 = await db.execute({ sql:`SELECT * FROM ai_feedback WHERE id=?`, args:[id] });
      if (!rs2.rows.length) return res.status(404).json({ error:'not found', session_id:id });
      const row = rs2.rows[0];
      return res.json({ ok:true, session_id: row.session_id, feedback: JSON.parse(row.feedback_json||'{}'), model_used: row.model_used, created_at: row.created_at });
    }
    const r=row=>({ ...row, feedback_json: undefined, feedback: (()=>{ try{ return JSON.parse(row.feedback_json); }catch{ return {}; }})() });
    return res.json({ ok:true, data: rs.rows.map(r) });
  }
  // no id -> return last 10 for user (join created_by)
  const uid = payload.id ?? payload.uid;
  const list = await db.execute({ sql:`SELECT af.id, af.session_id, af.model_used, af.created_at, ase.room_id, ase.pair_label FROM ai_feedback af JOIN ai_sessions ase ON ase.id=af.session_id WHERE ase.created_by=? ORDER BY af.created_at DESC LIMIT 20`, args:[uid] });
  return res.json({ ok:true, count: list.rows.length, feedbacks: list.rows });
}

async function handleHistory(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error:'GET only' });
  const auth = req.headers.authorization||'';
  const m = auth.match(/^Bearer\s+(.+)$/);
  if (!m) return res.status(401).json({ error:'missing Bearer'});
  let payload; try { payload=jwt.verify(m[1], getJwtSecret()); } catch { return res.status(401).json({ error:'invalid'}); }
  const uid = payload.id ?? payload.uid;
  const db = getClient(); await ensureTables(db);
  const rs = await db.execute({ sql:`SELECT af.id, af.session_id, af.role, af.model_used, af.estimated_cost_cents, af.confidence, af.created_at, ase.room_id, ase.pair_label, ase.duration_sec FROM ai_feedback af JOIN ai_sessions ase ON ase.id=af.session_id WHERE ase.created_by=? ORDER BY af.created_at DESC LIMIT 20`, args:[uid] });
  const today = todayISO();
  let usage = null; try { const u = await db.execute({ sql:`SELECT * FROM ai_usage WHERE date=?`, args:[today] }); usage = u.rows[0]||null; } catch {}
  return res.json({ ok:true, usage_today: usage, feedbacks: rs.rows });
}

export default async function handler(req, res) {
  const slug = getSlug(req);
  const key = slug.join('/').toLowerCase();
  if (key === 'analyze') return handleAnalyze(req, res);
  if (key.startsWith('feedback')) return handleFeedbackGet(req, res);
  if (key === 'history') return handleHistory(req, res);
  if (!key) return res.status(400).json({ error: 'ai route required: analyze|feedback/:id|history', got: slug, docs: 'POST /api/ai/analyze {room_id, transcript, code} Bearer required, returns evidence-checked feedback' });
  return res.status(404).json({ error:`unknown ai route ${key}`, available:['analyze','feedback/:sessionId','history'] });
}
