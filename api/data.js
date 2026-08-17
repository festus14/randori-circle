import { getClient, getJwtSecret } from './_db.js';
import jwt from 'jsonwebtoken';

function getEndpoint(req){
  const q = req.query?.endpoint;
  if (q) return String(q).toLowerCase();
  try{
    const u = new URL(req.url,'http://localhost');
    const ep = u.searchParams.get('endpoint');
    if (ep) return ep.toLowerCase();
    const path = u.pathname.split('/').filter(Boolean).pop();
    return (path||'').toLowerCase();
  }catch{ return (req.url||'').split('?')[0].split('/').filter(Boolean).pop()?.toLowerCase()||''; }
}

async function handleCircle(req,res){
  if (req.method !== 'GET') return res.status(405).json({ error:'GET only' });
  const db = getClient();
  try{
    await db.execute(`CREATE TABLE IF NOT EXISTS auth_accounts (id INTEGER PRIMARY KEY AUTOINCREMENT, email TEXT UNIQUE NOT NULL, password_hash TEXT NOT NULL, display_name TEXT NOT NULL, color TEXT NOT NULL, created_at TEXT DEFAULT (datetime('now')), last_login TEXT, is_available INTEGER DEFAULT 1, availability_updated_at TEXT, is_admin INTEGER DEFAULT 0)`);
    await db.execute(`CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, color TEXT NOT NULL, created_at TEXT DEFAULT (datetime('now')))`);
  }catch{}
  try{ await db.execute(`ALTER TABLE auth_accounts ADD COLUMN is_available INTEGER DEFAULT 1`);}catch{}
  try{ await db.execute(`ALTER TABLE auth_accounts ADD COLUMN availability_updated_at TEXT`);}catch{}
  try{ await db.execute(`ALTER TABLE auth_accounts ADD COLUMN is_admin INTEGER DEFAULT 0`);}catch{}
  try{
    const rs = await db.execute(`SELECT id, display_name, color, email, created_at, is_available, availability_updated_at, is_admin FROM auth_accounts ORDER BY id`);
    if (rs.rows.length){
      const circle = rs.rows.map(r=>({ id:r.id, display_name:r.display_name, name:r.display_name, email:r.email, color:r.color, created_at:r.created_at, is_available:r.is_available===null||r.is_available===undefined?true:!!r.is_available, isAvailable:r.is_available===null||r.is_available===undefined?true:!!r.is_available, availability_updated_at:r.availability_updated_at, is_admin:!!r.is_admin, source:'auth' }));
      return res.json({ ok:true, circle, count:circle.length, source:'auth_accounts' });
    }
  }catch{}
  try{
    const rs2 = await db.execute(`SELECT id, name, color, created_at FROM users ORDER BY id`);
    const circle = rs2.rows.map(r=>({ id:r.id, display_name:r.name, name:r.name, color:r.color, created_at:r.created_at, is_available:true, isAvailable:true, is_admin:false, source:'users' }));
    return res.json({ ok:true, circle, count:circle.length, source:'users' });
  }catch(e){ return res.status(500).json({ error:'db error', detail:String(e.message||e).slice(0,200)}); }
}

async function handleWeeks(req,res){
  if (req.method !== 'GET') return res.status(405).json({ error:'GET only' });
  const db = getClient();
  try{
    await db.execute(`CREATE TABLE IF NOT EXISTS pairing_weeks (id INTEGER PRIMARY KEY AUTOINCREMENT, week_label TEXT NOT NULL, week_start TEXT NOT NULL, focus TEXT NOT NULL DEFAULT 'both', created_at TEXT DEFAULT (datetime('now')))`);
    await db.execute(`CREATE TABLE IF NOT EXISTS pairing_groups (id INTEGER PRIMARY KEY AUTOINCREMENT, week_id INTEGER NOT NULL, user_a_id INTEGER NOT NULL, user_b_id INTEGER NOT NULL, user_c_id INTEGER, is_ai_pair INTEGER DEFAULT 0, topic TEXT DEFAULT 'Pick together', topic_kind TEXT DEFAULT 'both', created_at TEXT DEFAULT (datetime('now')))`);
  }catch{}
  try{
    const weeksRs = await db.execute(`SELECT id, week_label, week_start, focus, created_at FROM pairing_weeks ORDER BY id DESC LIMIT 20`);
    if (!weeksRs.rows.length) return res.json({ ok:true, weeks:[] });
    const weekIds = weeksRs.rows.map(w=>w.id);
    const placeholders = weekIds.map(()=>'?').join(',');
    const groupsRs = await db.execute({ sql:`SELECT id as pg_id, week_id, user_a_id, user_b_id, is_ai_pair, topic, topic_kind, created_at FROM pairing_groups WHERE week_id IN (${placeholders}) ORDER BY week_id DESC, id ASC`, args:weekIds });
    const allIds = new Set(); groupsRs.rows.forEach(r=>{ allIds.add(r.user_a_id); allIds.add(r.user_b_id); });
    let idTo={};
    if (allIds.size){
      const ids=[...allIds]; const ph=ids.map(()=>'?').join(',');
      try{
        const authRows = await db.execute({ sql:`SELECT id, display_name as name, color FROM auth_accounts WHERE id IN (${ph})`, args:ids });
        authRows.rows.forEach(r=>{ idTo[r.id]={name:r.name,color:r.color,source:'auth'}; });
        const missing = ids.filter(i=>!idTo[i]);
        if (missing.length){
          const ph2 = missing.map(()=>'?').join(',');
          const uRows = await db.execute({ sql:`SELECT id, name, color FROM users WHERE id IN (${ph2})`, args:missing });
          uRows.rows.forEach(r=>{ idTo[r.id]={name:r.name,color:r.color,source:'users'}; });
        }
      }catch{}
    }
    const weeks = weeksRs.rows.map(w=>{
      const pairs = groupsRs.rows.filter(g=>g.week_id===w.id).map(g=>{
        const a = idTo[g.user_a_id]||{name:`User ${g.user_a_id}`, color:'#999'};
        const b = g.is_ai_pair ? {name:'AI partner', color:'var(--accent)'} : (idTo[g.user_b_id]||{name:`User ${g.user_b_id}`, color:'#999'});
        return { pg_id:g.pg_id, a_id:g.user_a_id, b_id:g.user_b_id, a_name:a.name, b_name:b.name, a_color:a.color, b_color:b.color, is_ai:!!g.is_ai_pair, topic:g.topic, topic_kind:g.topic_kind, created_at:g.created_at };
      });
      return { id:w.id, week_label:w.week_label, week_start:w.week_start, focus:w.focus, created_at:w.created_at, pairs };
    });
    return res.json({ ok:true, weeks });
  }catch(e){ return res.status(500).json({ ok:false, error:'weeks query failed', detail:String(e.message||e).slice(0,300)}); }
}

async function handleHistory(req,res){
  if (req.method !== 'GET') return res.status(405).json({ error:'GET only' });
  const auth = req.headers.authorization||'';
  const m = auth.match(/^Bearer\s+(.+)$/);
  if (!m) return res.status(401).json({ error:'missing Bearer <redacted>' });
  let payload; try{ payload=jwt.verify(m[1], getJwtSecret()); }catch(e){ return res.status(401).json({ error:'invalid token'}); }
  const db = getClient();
  const userId = payload.id;
  const groups = await db.execute({ sql:`
    SELECT pg.id as pg_id, pg.week_id, pg.user_a_id, pg.user_b_id, pg.is_ai_pair, pg.topic, pg.topic_kind,
           pw.week_label, pw.week_start
    FROM pairing_groups pg
    JOIN pairing_weeks pw ON pw.id = pg.week_id
    WHERE pg.user_a_id = ? OR pg.user_b_id = ?
    ORDER BY pw.week_start DESC, pg.id DESC
  `, args:[userId,userId] });
  const allIds = new Set(); groups.rows.forEach(r=>{ allIds.add(r.user_a_id); allIds.add(r.user_b_id); });
  let idToName={};
  if (allIds.size){
    const ids=[...allIds]; const placeholders=ids.map(()=>'?').join(',');
    try{ const authRows=await db.execute({ sql:`SELECT id, display_name as name FROM auth_accounts WHERE id IN (${placeholders})`, args:ids }); authRows.rows.forEach(r=>{ idToName[r.id]=r.name; }); const missing=ids.filter(i=>!idToName[i]); if(missing.length){ const ph2=missing.map(()=>'?').join(','); const uRows=await db.execute({ sql:`SELECT id, name FROM users WHERE id IN (${ph2})`, args:missing }); uRows.rows.forEach(r=>{ idToName[r.id]=r.name; }); } }catch{}
  }
  const enriched = groups.rows.map(r=>{
    const isA = r.user_a_id===userId;
    const partnerId = isA ? r.user_b_id : r.user_a_id;
    const partnerName = r.is_ai_pair ? 'AI partner' : (idToName[partnerId]||`User ${partnerId}`);
    return { pg_id:r.pg_id, week_id:r.week_id, week_label:r.week_label, week_start:r.week_start, is_ai:!!r.is_ai_pair, topic:r.topic, topic_kind:r.topic_kind, partner_id:partnerId, partner_name:partnerName, you_are_a:isA };
  });
  const partnerCounts={}; enriched.forEach(e=>{ if(!e.is_ai) partnerCounts[e.partner_name]=(partnerCounts[e.partner_name]||0)+1; });
  return res.json({ ok:true, user:{ id:payload.id, name:payload.name }, history:enriched, partner_counts:partnerCounts, total:enriched.length });
}

async function handleInit(req,res){
  if (req.method!=='POST' && req.method!=='GET') return res.status(405).json({ error:'POST or GET' });
  const db = getClient();
  await db.batch([
    `CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, color TEXT NOT NULL, created_at TEXT DEFAULT (datetime('now')))`,
    `CREATE TABLE IF NOT EXISTS auth_accounts (id INTEGER PRIMARY KEY AUTOINCREMENT, email TEXT UNIQUE NOT NULL, password_hash TEXT NOT NULL, display_name TEXT NOT NULL, color TEXT NOT NULL, created_at TEXT DEFAULT (datetime('now')), last_login TEXT, is_available INTEGER DEFAULT 1, availability_updated_at TEXT, is_admin INTEGER DEFAULT 0)`,
    `CREATE TABLE IF NOT EXISTS pairing_weeks (id INTEGER PRIMARY KEY AUTOINCREMENT, week_label TEXT NOT NULL, week_start TEXT NOT NULL, focus TEXT NOT NULL DEFAULT 'both', created_at TEXT DEFAULT (datetime('now')))`,
    `CREATE TABLE IF NOT EXISTS pairing_groups (id INTEGER PRIMARY KEY AUTOINCREMENT, week_id INTEGER NOT NULL REFERENCES pairing_weeks(id) ON DELETE CASCADE, user_a_id INTEGER NOT NULL, user_b_id INTEGER NOT NULL, user_c_id INTEGER, is_ai_pair INTEGER DEFAULT 0, topic TEXT DEFAULT 'Pick together', topic_kind TEXT DEFAULT 'both', created_at TEXT DEFAULT (datetime('now')))`,
    `CREATE TABLE IF NOT EXISTS questions (id INTEGER PRIMARY KEY AUTOINCREMENT, slug TEXT UNIQUE NOT NULL, title TEXT NOT NULL, type TEXT NOT NULL, difficulty TEXT NOT NULL, category TEXT NOT NULL, description TEXT NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS video_signals (id INTEGER PRIMARY KEY AUTOINCREMENT, room_id TEXT NOT NULL, from_id TEXT NOT NULL, to_id TEXT, type TEXT NOT NULL, payload TEXT NOT NULL, created_at TEXT DEFAULT (datetime('now')))`,
    `CREATE TABLE IF NOT EXISTS ai_sessions (id INTEGER PRIMARY KEY AUTOINCREMENT, room_id TEXT, pair_label TEXT, transcript TEXT, code_snapshots TEXT, interviewer_questions TEXT, started_at TEXT DEFAULT (datetime('now')), ended_at TEXT, duration_sec INTEGER, cost_cents INTEGER DEFAULT 0, created_at TEXT DEFAULT (datetime('now')), created_by INTEGER)`,
    `CREATE TABLE IF NOT EXISTS ai_feedback (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id INTEGER NOT NULL REFERENCES ai_sessions(id) ON DELETE CASCADE, role TEXT DEFAULT 'both', feedback_json TEXT NOT NULL, evidence TEXT, model_used TEXT, reason_for_pick TEXT, estimated_cost_cents INTEGER, confidence REAL DEFAULT 0.85, created_at TEXT DEFAULT (datetime('now')))`,
    `CREATE TABLE IF NOT EXISTS ai_usage (date TEXT PRIMARY KEY, calls INTEGER DEFAULT 0, tokens_in INTEGER DEFAULT 0, tokens_out INTEGER DEFAULT 0, updated_at TEXT DEFAULT (datetime('now')))`
  ],"write");
  const migrations=[`ALTER TABLE auth_accounts ADD COLUMN is_available INTEGER DEFAULT 1`,`ALTER TABLE auth_accounts ADD COLUMN availability_updated_at TEXT`,`ALTER TABLE auth_accounts ADD COLUMN is_admin INTEGER DEFAULT 0`];
  for(const sql of migrations){ try{ await db.execute(sql);}catch(_){} }
  try{ await db.execute(`CREATE INDEX IF NOT EXISTS idx_video_signals_room ON video_signals(room_id, created_at)`);}catch{}
  try{ await db.execute(`CREATE INDEX IF NOT EXISTS idx_video_signals_room_id ON video_signals(room_id, id)`);}catch{}
  return res.json({ ok:true, message:"Tables ready (incl auth_accounts + availability + is_admin + video + ai)" });
}

export default async function handler(req,res){
  const ep = getEndpoint(req);
  const path = (req.url||'').toLowerCase();
  if (ep==='circle' || path.includes('/circle')) return handleCircle(req,res);
  if (ep==='weeks' || path.includes('/weeks')) return handleWeeks(req,res);
  if (ep==='history' || path.includes('/history')) return handleHistory(req,res);
  if (ep==='init' || path.includes('/init')) return handleInit(req,res);
  return res.status(404).json({ error:`unknown data endpoint '${ep}'`, available:['circle','weeks','history','init'] });
}
