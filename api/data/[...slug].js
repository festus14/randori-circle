// api/data/[...slug].js — grouped data router
// Handles: circle, weeks, history, init
import { getClient, getJwtSecret } from '../_db.js';
import jwt from 'jsonwebtoken';

function getSlug(req) {
  let slug = req.query?.slug;
  if (!slug) {
    try {
      const u = new URL(req.url, 'http://localhost');
      const parts = u.pathname.split('/').filter(Boolean);
      const idx = parts.indexOf('data');
      if (idx >= 0) return parts.slice(idx + 1);
      return [];
    } catch { return []; }
  }
  if (typeof slug === 'string') return [slug];
  return slug;
}

// ---- circle ----
async function handleCircle(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'GET only' });
  const db = getClient();
  try {
    await db.execute(`CREATE TABLE IF NOT EXISTS auth_accounts (id INTEGER PRIMARY KEY AUTOINCREMENT, email TEXT UNIQUE NOT NULL, password_hash TEXT NOT NULL, display_name TEXT NOT NULL, color TEXT NOT NULL, created_at TEXT DEFAULT (datetime('now')), last_login TEXT, is_available INTEGER DEFAULT 1, availability_updated_at TEXT)`);
    await db.execute(`CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, color TEXT NOT NULL, created_at TEXT DEFAULT (datetime('now')))`);
  } catch {}
  try { await db.execute(`ALTER TABLE auth_accounts ADD COLUMN is_available INTEGER DEFAULT 1`); } catch {}
  try { await db.execute(`ALTER TABLE auth_accounts ADD COLUMN availability_updated_at TEXT`); } catch {}
  try {
    const rs = await db.execute(`SELECT id, display_name, color, email, created_at, is_available, availability_updated_at FROM auth_accounts ORDER BY id`);
    if (rs.rows.length) {
      const circle = rs.rows.map(r => ({
        id: r.id,
        display_name: r.display_name,
        name: r.display_name,
        email: r.email,
        color: r.color,
        created_at: r.created_at,
        is_available: r.is_available === null || r.is_available === undefined ? true : !!r.is_available,
        isAvailable: r.is_available === null || r.is_available === undefined ? true : !!r.is_available,
        availability_updated_at: r.availability_updated_at,
        source: 'auth'
      }));
      return res.json({ ok: true, circle, count: circle.length, source: 'auth_accounts' });
    }
  } catch {}
  try {
    const rs2 = await db.execute(`SELECT id, name, color, created_at FROM users ORDER BY id`);
    const circle = rs2.rows.map(r=>({ id:r.id, display_name:r.name, name:r.name, color:r.color, created_at:r.created_at, is_available:true, isAvailable:true, source:'users' }));
    return res.json({ ok:true, circle, count:circle.length, source:'users' });
  } catch(e){
    return res.status(500).json({ error:'db error', detail:String(e.message||e).slice(0,200) });
  }
}

// ---- weeks ----
async function handleWeeks(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'GET only' });
  const db = getClient();
  try {
    await db.execute(`CREATE TABLE IF NOT EXISTS pairing_weeks (id INTEGER PRIMARY KEY AUTOINCREMENT, week_label TEXT NOT NULL, week_start TEXT NOT NULL, focus TEXT NOT NULL DEFAULT 'both', created_at TEXT DEFAULT (datetime('now')))`);
    await db.execute(`CREATE TABLE IF NOT EXISTS pairing_groups (id INTEGER PRIMARY KEY AUTOINCREMENT, week_id INTEGER NOT NULL, user_a_id INTEGER NOT NULL, user_b_id INTEGER NOT NULL, user_c_id INTEGER, is_ai_pair INTEGER DEFAULT 0, topic TEXT DEFAULT 'Pick together', topic_kind TEXT DEFAULT 'both', created_at TEXT DEFAULT (datetime('now')))`);
  } catch {}
  try {
    const weeksRs = await db.execute(`SELECT id, week_label, week_start, focus, created_at FROM pairing_weeks ORDER BY id DESC LIMIT 20`);
    if (!weeksRs.rows.length) return res.json({ ok: true, weeks: [] });
    const weekIds = weeksRs.rows.map(w=>w.id);
    const placeholders = weekIds.map(()=>'?').join(',');
    const groupsRs = await db.execute({ sql: `SELECT id as pg_id, week_id, user_a_id, user_b_id, is_ai_pair, topic, topic_kind, created_at FROM pairing_groups WHERE week_id IN (${placeholders}) ORDER BY week_id DESC, id ASC`, args: weekIds });
    const allIds = new Set();
    groupsRs.rows.forEach(r=>{ allIds.add(r.user_a_id); allIds.add(r.user_b_id); });
    let idTo = {};
    if (allIds.size) {
      const ids = [...allIds];
      const ph = ids.map(()=>'?').join(',');
      try {
        const authRows = await db.execute({ sql: `SELECT id, display_name as name, color FROM auth_accounts WHERE id IN (${ph})`, args: ids });
        authRows.rows.forEach(r=>{ idTo[r.id]={name:r.name,color:r.color,source:'auth'}; });
        const missing = ids.filter(i=>!idTo[i]);
        if (missing.length) {
          const ph2 = missing.map(()=>'?').join(',');
          const uRows = await db.execute({ sql: `SELECT id, name, color FROM users WHERE id IN (${ph2})`, args: missing });
          uRows.rows.forEach(r=>{ idTo[r.id]={name:r.name,color:r.color,source:'users'}; });
        }
      } catch {
        try {
          const ids2 = [...allIds];
          const ph3 = ids2.map(()=>'?').join(',');
          const uRows = await db.execute({ sql: `SELECT id, name, color FROM users WHERE id IN (${ph3})`, args: ids2 });
          uRows.rows.forEach(r=>{ idTo[r.id]={name:r.name,color:r.color,source:'users'}; });
        } catch {}
      }
    }
    const weeks = weeksRs.rows.map(w=>{
      const pairs = groupsRs.rows.filter(g=>g.week_id===w.id).map(g=>{
        const a = idTo[g.user_a_id] || {name:`User ${g.user_a_id}`, color:'#999'};
        const b = g.is_ai_pair ? {name:'AI partner', color:'var(--accent)'} : (idTo[g.user_b_id] || {name:`User ${g.user_b_id}`, color:'#999'});
        return {
          pg_id: g.pg_id,
          a_id: g.user_a_id,
          b_id: g.user_b_id,
          a_name: a.name,
          b_name: b.name,
          a_color: a.color,
          b_color: b.color,
          is_ai: !!g.is_ai_pair,
          topic: g.topic,
          topic_kind: g.topic_kind,
          created_at: g.created_at
        };
      });
      return {
        id: w.id,
        week_label: w.week_label,
        week_start: w.week_start,
        focus: w.focus,
        created_at: w.created_at,
        pairs
      };
    });
    return res.json({ ok: true, weeks });
  } catch (e) {
    return res.status(500).json({ ok:false, error:'weeks query failed', detail: String(e.message||e).slice(0,300) });
  }
}

// ---- history ----
async function handleHistory(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'GET only' });
  const auth = req.headers.authorization || '';
  const m = auth.match(/^Bearer\s+(.+)$/);
  if (!m) return res.status(401).json({ error: 'missing Bearer token' });
  let payload;
  try { payload = jwt.verify(m[1], getJwtSecret()); } catch (e) { return res.status(401).json({ error: 'invalid token' }); }
  // support id or uid
  const userId = payload.id ?? payload.uid;
  if (!userId) return res.status(401).json({ error: 'invalid token payload' });
  const db = getClient();
  const groups = await db.execute({ sql: `
    SELECT pg.id as pg_id, pg.week_id, pg.user_a_id, pg.user_b_id, pg.is_ai_pair, pg.topic, pg.topic_kind,
           pw.week_label, pw.week_start
    FROM pairing_groups pg
    JOIN pairing_weeks pw ON pw.id = pg.week_id
    WHERE pg.user_a_id = ? OR pg.user_b_id = ?
    ORDER BY pw.week_start DESC, pg.id DESC
  `, args: [userId, userId] });

  const allIds = new Set();
  groups.rows.forEach(r => { allIds.add(r.user_a_id); allIds.add(r.user_b_id); });
  let idToName = {};
  if (allIds.size) {
    const ids = [...allIds];
    const placeholders = ids.map(()=>'?').join(',');
    try {
      const authRows = await db.execute({ sql: `SELECT id, display_name as name FROM auth_accounts WHERE id IN (${placeholders})`, args: ids });
      authRows.rows.forEach(r=> { idToName[r.id] = r.name; });
      const missing = ids.filter(i=> !idToName[i]);
      if (missing.length) {
        const ph2 = missing.map(()=>'?').join(',');
        const uRows = await db.execute({ sql: `SELECT id, name FROM users WHERE id IN (${ph2})`, args: missing });
        uRows.rows.forEach(r=> { idToName[r.id] = r.name; });
      }
    } catch {
      try {
        const uRows = await db.execute({ sql: `SELECT id, name FROM users WHERE id IN (${placeholders})`, args: ids });
        uRows.rows.forEach(r=> { idToName[r.id] = r.name; });
      } catch {}
    }
  }
  const enriched = groups.rows.map(r => {
    const isA = r.user_a_id === userId;
    const partnerId = isA ? r.user_b_id : r.user_a_id;
    const partnerName = r.is_ai_pair ? 'AI partner' : (idToName[partnerId] || `User ${partnerId}`);
    return {
      pg_id: r.pg_id,
      week_id: r.week_id,
      week_label: r.week_label,
      week_start: r.week_start,
      is_ai: !!r.is_ai_pair,
      topic: r.topic,
      topic_kind: r.topic_kind,
      partner_id: partnerId,
      partner_name: partnerName,
      you_are_a: isA
    };
  });
  const partnerCounts = {};
  enriched.forEach(e=> { if (!e.is_ai) partnerCounts[e.partner_name] = (partnerCounts[e.partner_name]||0)+1; });
  return res.json({ ok: true, user: { id: payload.id ?? payload.uid, name: payload.name }, history: enriched, partner_counts: partnerCounts, total: enriched.length });
}

// ---- init ----
async function handleInit(req, res) {
  if (req.method !== 'POST' && req.method !== 'GET') return res.status(405).json({ error: 'POST or GET' });
  const db = getClient();
  await db.batch([
    `CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      color TEXT NOT NULL,
      created_at TEXT DEFAULT (datetime('now'))
    )`,
    `CREATE TABLE IF NOT EXISTS auth_accounts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      email TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      display_name TEXT NOT NULL,
      color TEXT NOT NULL,
      created_at TEXT DEFAULT (datetime('now')),
      last_login TEXT,
      is_available INTEGER DEFAULT 1,
      availability_updated_at TEXT
    )`,
    `CREATE TABLE IF NOT EXISTS pairing_weeks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      week_label TEXT NOT NULL,
      week_start TEXT NOT NULL,
      focus TEXT NOT NULL DEFAULT 'both',
      created_at TEXT DEFAULT (datetime('now'))
    )`,
    `CREATE TABLE IF NOT EXISTS pairing_groups (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      week_id INTEGER NOT NULL REFERENCES pairing_weeks(id) ON DELETE CASCADE,
      user_a_id INTEGER NOT NULL,
      user_b_id INTEGER NOT NULL,
      user_c_id INTEGER,
      is_ai_pair INTEGER DEFAULT 0,
      topic TEXT DEFAULT 'Pick together',
      topic_kind TEXT DEFAULT 'both',
      created_at TEXT DEFAULT (datetime('now'))
    )`,
    `CREATE TABLE IF NOT EXISTS questions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      slug TEXT UNIQUE NOT NULL,
      title TEXT NOT NULL,
      type TEXT NOT NULL,
      difficulty TEXT NOT NULL,
      category TEXT NOT NULL,
      description TEXT NOT NULL
    )`
  ], "write");
  const migrations = [
    `ALTER TABLE auth_accounts ADD COLUMN is_available INTEGER DEFAULT 1`,
    `ALTER TABLE auth_accounts ADD COLUMN availability_updated_at TEXT`
  ];
  for (const sql of migrations) {
    try { await db.execute(sql); } catch (_) {}
  }
  return res.json({ ok: true, message: "Tables ready (incl auth_accounts + availability)" });
}

export default async function handler(req, res) {
  const slug = getSlug(req);
  const key = slug.join('/').toLowerCase();
  if (key === 'circle') return handleCircle(req, res);
  if (key === 'weeks') return handleWeeks(req, res);
  if (key === 'history') return handleHistory(req, res);
  if (key === 'init') return handleInit(req, res);
  if (!key) return res.status(400).json({ error: 'data route required: circle|weeks|history|init', got: slug });
  return res.status(404).json({ error: `unknown data route ${key}`, available: ['circle','weeks','history','init'] });
}
