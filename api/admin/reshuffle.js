import { getClient, getJwtSecret, isoWeekLabel, shuffleArray } from '../_db.js';
import jwt from 'jsonwebtoken';

const ADMIN_EMAIL = 'festusomole14@gmail.com';

function isAdminPayload(payload){
  if (!payload) return false;
  const email = (payload.email || payload.e || '').toString().toLowerCase().trim();
  return email === ADMIN_EMAIL.toLowerCase();
}

export default async function handler(req, res){
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only for reshuffle' });
  const auth = req.headers.authorization || '';
  const m = auth.match(/^Bearer\s+(.+)$/);
  if (!m) return res.status(401).json({ error: 'missing Bearer token — sign in as admin' });
  let payload;
  try { payload = jwt.verify(m[1], getJwtSecret()); } catch(e){ return res.status(401).json({ error: 'invalid token', detail: String(e.message||e).slice(0,120) }); }
  if (!isAdminPayload(payload)) {
    return res.status(403).json({ error: 'forbidden: admin only', required_admin: ADMIN_EMAIL, you_are: payload.email||payload.e||'unknown' });
  }

  const db = getClient();
  // ensure tables + availability cols
  try{
    await db.execute(`CREATE TABLE IF NOT EXISTS auth_accounts (id INTEGER PRIMARY KEY AUTOINCREMENT, email TEXT UNIQUE NOT NULL, password_hash TEXT NOT NULL, display_name TEXT NOT NULL, color TEXT NOT NULL, created_at TEXT DEFAULT (datetime('now')), last_login TEXT, is_available INTEGER DEFAULT 1, availability_updated_at TEXT)`);
    await db.execute(`CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, color TEXT NOT NULL, created_at TEXT DEFAULT (datetime('now')))`);
    await db.execute(`CREATE TABLE IF NOT EXISTS pairing_weeks (id INTEGER PRIMARY KEY AUTOINCREMENT, week_label TEXT NOT NULL, week_start TEXT NOT NULL, focus TEXT NOT NULL DEFAULT 'both', created_at TEXT DEFAULT (datetime('now')))`);
    await db.execute(`CREATE TABLE IF NOT EXISTS pairing_groups (id INTEGER PRIMARY KEY AUTOINCREMENT, week_id INTEGER NOT NULL, user_a_id INTEGER NOT NULL, user_b_id INTEGER NOT NULL, user_c_id INTEGER, is_ai_pair INTEGER DEFAULT 0, topic TEXT DEFAULT 'Pick together', topic_kind TEXT DEFAULT 'both', created_at TEXT DEFAULT (datetime('now')))`);
  }catch{}
  try{ await db.execute(`ALTER TABLE auth_accounts ADD COLUMN is_available INTEGER DEFAULT 1`);}catch{}
  try{ await db.execute(`ALTER TABLE auth_accounts ADD COLUMN availability_updated_at TEXT`);}catch{}

  // participants = ONLY available auth_accounts (is_available = 1, NULL treated as 1)
  let authRs;
  try {
    authRs = await db.execute(`SELECT id, display_name as name, email, color, is_available FROM auth_accounts WHERE COALESCE(is_available,1)=1 ORDER BY id`);
  } catch {
    authRs = await db.execute(`SELECT id, display_name as name, email, color FROM auth_accounts ORDER BY id`);
  }
  if (authRs.rows.length < 2) {
    const allCount = (await db.execute(`SELECT COUNT(*) as c FROM auth_accounts`).catch(()=>({rows:[{c:0}]}))).rows[0].c;
    return res.status(400).json({ ok:false, error:'need at least 2 available signed-up users to shuffle', available_count: authRs.rows.length, total_accounts: allCount, hint:'Ask unavailable users to toggle Available ON in settings, or invite more people' });
  }
  const participants = authRs.rows.map(r=>({ id:r.id, name:r.name, email:r.email, color:r.color, source:'auth' }));
  const unavailableCount = (() => { try{ return 0 }catch{return 0}})();

  const now = new Date();
  const weekLabel = isoWeekLabel(now);
  let weekId;
  const existing = await db.execute({ sql:`SELECT id FROM pairing_weeks WHERE week_label=?`, args:[weekLabel] });
  if (existing.rows.length){
    weekId = existing.rows[0].id;
    await db.execute({ sql:`DELETE FROM pairing_groups WHERE week_id=?`, args:[weekId] });
    await db.execute({ sql:`UPDATE pairing_weeks SET week_start=? WHERE id=?`, args:[now.toISOString(), weekId] });
  } else {
    const ins = await db.execute({ sql:`INSERT INTO pairing_weeks (week_label, week_start, focus) VALUES (?,?,?) RETURNING id`, args:[weekLabel, now.toISOString(), 'both'] });
    weekId = ins.rows[0].id;
  }

  let prevPairsSet = new Set();
  try {
    const lw = await db.execute(`SELECT id FROM pairing_weeks WHERE id != ? ORDER BY id DESC LIMIT 1`, { sql:`SELECT id FROM pairing_weeks WHERE id != ? ORDER BY id DESC LIMIT 1`, args:[weekId] }?.args ? { sql:`SELECT id FROM pairing_weeks WHERE id != ? ORDER BY id DESC LIMIT 1`, args:[weekId]} : undefined) .catch(async()=> await db.execute({ sql:`SELECT id FROM pairing_weeks WHERE id != ? ORDER BY id DESC LIMIT 1`, args:[weekId] }));
    const lwRow = lw && lw.rows && lw.rows[0];
    if (lwRow) {
      const pg = await db.execute({ sql:`SELECT user_a_id,user_b_id FROM pairing_groups WHERE week_id=?`, args:[lwRow.id] });
      pg.rows.forEach(r=>{ const key=[Math.min(r.user_a_id,r.user_b_id), Math.max(r.user_a_id,r.user_b_id)].join('-'); prevPairsSet.add(key); });
    }
  } catch {}

  let bestPairs=null;
  for(let attempt=0; attempt<8; attempt++){
    const shuffled = shuffleArray(participants);
    const pairs=[];
    for(let i=0;i<shuffled.length;i+=2){
      const a=shuffled[i]; const b=shuffled[i+1]||null;
      if(!b) pairs.push({a,b:null,isAI:true});
      else pairs.push({a,b,isAI:false});
    }
    let repeats=0;
    for(const p of pairs){ if(p.isAI) continue; const key=[Math.min(p.a.id,p.b.id), Math.max(p.a.id,p.b.id)].join('-'); if(prevPairsSet.has(key)) repeats++; }
    if(!bestPairs || repeats<bestPairs.repeats){ bestPairs={pairs,repeats}; if(repeats===0) break; }
  }

  for(const pr of bestPairs.pairs){
    const aId=pr.a.id;
    const bId= pr.b ? pr.b.id : pr.a.id;
    const isAi = pr.isAI ? 1 : 0;
    await db.execute({ sql:`INSERT INTO pairing_groups (week_id,user_a_id,user_b_id,is_ai_pair,topic,topic_kind) VALUES (?,?,?,?,?,?)`, args:[weekId,aId,bId,isAi,'Pick together','both'] });
  }

  return res.json({
    ok:true,
    week_label: weekLabel,
    week_id: weekId,
    reshuffled_by: payload.email,
    pairs: bestPairs.pairs.map(p=>({ a:p.a.name, b: p.b ? p.b.name : 'AI partner', a_id:p.a.id, b_id: p.b? p.b.id:null, isAI:p.isAI })),
    repeat_avoided: bestPairs.repeats,
    count: participants.length,
    note: 'Admin reshuffle respected Availability — only is_available=1 users included'
  });
}
