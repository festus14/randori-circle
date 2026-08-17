// api/ops/[...slug].js —Grouped ops router
// Handles: availability, reshuffle, weekly
// Preserves JWT, admin, Cron, Turf, Resend logic.

import { getClient, getJwtSecret, getCronSecret, isoWeekLabel, shuffleArray } from '../_db.js';
import jwt from 'jsonwebtoken';

function getSlug(req) {
  let slug = req.query?.slug;
  if (!slug) {
    try {
      const u = new URL(req.url, 'http://localhost');
      const parts = u.pathname.split('/').filter(Boolean);
      const idx = parts.indexOf('ops');
      if (idx >= 0) return parts.slice(idx + 1);
      return [];
    } catch { return []; }
  }
  if (typeof slug === 'string') return [slug];
  return slug;
}

const ADMIN_EMAIL = 'festusomole14@gmail.com';
function isAdminPayload(payload){
  if (!payload) return false;
  const email = (payload.email || payload.e || '').toString().toLowerCase().trim();
  return email === ADMIN_EMAIL.toLowerCase();
}

function verifyCronAuth(req) {
  const hdr = req.headers['x-cron-secret'] || req.headers['authorization'] || '';
  const secret = getCronSecret();
  if (typeof hdr === 'string' && hdr.startsWith('Bearer ')) {
    try { jwt.verify(hdr.slice(7), getJwtSecret()); return true; } catch {}
  }
  if (hdr && hdr === secret) return true;
  if (req.headers['x-vercel-cron'] !== undefined) return true;
  if (req.query && req.query.secret && req.query.secret === secret) return true;
  if (!process.env.CRON_SECRET && !process.env.JWT_SECRET) return true;
  return false;
}

// ---- availability ----
async function handleAvailability(req, res){
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
  const auth = req.headers.authorization || '';
  const m = auth.match(/^Bearer\s+(.+)$/);
  if (!m) return res.status(401).json({ error: 'missing Bearer token' });
  let payload;
  try{ payload = jwt.verify(m[1], getJwtSecret()); } catch(e){ return res.status(401).json({ error: 'invalid token' }); }
  const pid = payload.id ?? payload.uid;
  if (!pid) return res.status(401).json({ error: 'invalid token payload' });
  const { is_available, isAvailable } = req.body || {};
  const raw = (is_available !== undefined ? is_available : isAvailable);
  if (raw === undefined || raw === null) return res.status(400).json({ error: 'is_available boolean required' });
  const val = raw ? 1 : 0;
  const db = getClient();
  try{ await db.execute(`ALTER TABLE auth_accounts ADD COLUMN is_available INTEGER DEFAULT 1`); }catch{}
  try{ await db.execute(`ALTER TABLE auth_accounts ADD COLUMN availability_updated_at TEXT`);}catch{}
  try{
    await db.execute({ sql:`UPDATE auth_accounts SET is_available=?, availability_updated_at=datetime('now') WHERE id=?`, args:[val, pid] });
    const rs = await db.execute({ sql:`SELECT id,email,display_name,is_available,availability_updated_at FROM auth_accounts WHERE id=?`, args:[pid] });
    const u = rs.rows[0];
    return res.json({
      ok:true,
      user: { id:u.id, email:u.email, name:u.display_name, is_available: !!u.is_available, isAvailable: !!u.is_available, availability_updated_at: u.availability_updated_at },
      message: val ? 'You are marked AVAILABLE — you will be included Sun 08:00 BST' : 'You are marked UNAVAILABLE — you will be SKIPPED Sun 08:00 BST until you re-enable'
    });
  }catch(e){
    return res.status(500).json({ ok:false, error:'update failed', detail: String(e.message||e).slice(0,200) });
  }
}

// ---- reshuffle (admin) ----
async function handleReshuffle(req, res){
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only for reshuffle' });
  const auth = req.headers.authorization || '';
  const mm = auth.match(/^Bearer\s+(.+)$/);
  if (!mm) return res.status(401).json({ error: 'missing Bearer token — sign in as admin' });
  let payload;
  try { payload = jwt.verify(mm[1], getJwtSecret()); } catch(e){ return res.status(401).json({ error: 'invalid token', detail: String(e.message||e).slice(0,120) }); }
  if (!isAdminPayload(payload)) {
    return res.status(403).json({ error: 'forbidden: admin only', required_admin: ADMIN_EMAIL, you_are: payload.email||payload.e||'unknown' });
  }
  const db = getClient();
  try{
    await db.execute(`CREATE TABLE IF NOT EXISTS auth_accounts (id INTEGER PRIMARY KEY AUTOINCREMENT, email TEXT UNIQUE NOT NULL, password_hash TEXT NOT NULL, display_name TEXT NOT NULL, color TEXT NOT NULL, created_at TEXT DEFAULT (datetime('now')), last_login TEXT, is_available INTEGER DEFAULT 1, availability_updated_at TEXT)`);
    await db.execute(`CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, color TEXT NOT NULL, created_at TEXT DEFAULT (datetime('now')))`);
    await db.execute(`CREATE TABLE IF NOT EXISTS pairing_weeks (id INTEGER PRIMARY KEY AUTOINCREMENT, week_label TEXT NOT NULL, week_start TEXT NOT NULL, focus TEXT NOT NULL DEFAULT 'both', created_at TEXT DEFAULT (datetime('now')))`);
    await db.execute(`CREATE TABLE IF NOT EXISTS pairing_groups (id INTEGER PRIMARY KEY AUTOINCREMENT, week_id INTEGER NOT NULL, user_a_id INTEGER NOT NULL, user_b_id INTEGER NOT NULL, user_c_id INTEGER, is_ai_pair INTEGER DEFAULT 0, topic TEXT DEFAULT 'Pick together', topic_kind TEXT DEFAULT 'both', created_at TEXT DEFAULT (datetime('now')))`);
  }catch{}
  try{ await db.execute(`ALTER TABLE auth_accounts ADD COLUMN is_available INTEGER DEFAULT 1`);}catch{}
  try{ await db.execute(`ALTER TABLE auth_accounts ADD COLUMN availability_updated_at TEXT`);}catch{}

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
    const lw = await db.execute({ sql:`SELECT id FROM pairing_weeks WHERE id != ? ORDER BY id DESC LIMIT 1`, args:[weekId] });
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

// ---- weekly ----
async function handleWeekly(req, res){
  if (req.method !== 'GET' && req.method !== 'POST') return res.status(405).json({ error: 'GET or POST' });
  if (!verifyCronAuth(req)) return res.status(401).json({ error: 'unauthorized cron', hint: 'send x-cron-secret header or ?secret=' });
  const db = getClient();
  await db.execute(`CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, color TEXT NOT NULL, created_at TEXT DEFAULT (datetime('now')))`);
  await db.execute(`CREATE TABLE IF NOT EXISTS auth_accounts (id INTEGER PRIMARY KEY AUTOINCREMENT, email TEXT UNIQUE NOT NULL, password_hash TEXT NOT NULL, display_name TEXT NOT NULL, color TEXT NOT NULL, created_at TEXT DEFAULT (datetime('now')), last_login TEXT, is_available INTEGER DEFAULT 1, availability_updated_at TEXT)`);
  await db.execute(`CREATE TABLE IF NOT EXISTS pairing_weeks (id INTEGER PRIMARY KEY AUTOINCREMENT, week_label TEXT NOT NULL, week_start TEXT NOT NULL, focus TEXT NOT NULL DEFAULT 'both', created_at TEXT DEFAULT (datetime('now')))`);
  await db.execute(`CREATE TABLE IF NOT EXISTS pairing_groups (id INTEGER PRIMARY KEY AUTOINCREMENT, week_id INTEGER NOT NULL, user_a_id INTEGER NOT NULL, user_b_id INTEGER NOT NULL, user_c_id INTEGER, is_ai_pair INTEGER DEFAULT 0, topic TEXT DEFAULT 'Pick together', topic_kind TEXT DEFAULT 'both', created_at TEXT DEFAULT (datetime('now')))`);
  try { await db.execute(`ALTER TABLE auth_accounts ADD COLUMN is_available INTEGER DEFAULT 1`); } catch {}
  try { await db.execute(`ALTER TABLE auth_accounts ADD COLUMN availability_updated_at TEXT`); } catch {}
  const now = new Date();
  const weekLabel = isoWeekLabel(now);
  const existingWeek = await db.execute({ sql: `SELECT id FROM pairing_weeks WHERE week_label=?`, args: [weekLabel] });
  if (existingWeek.rows.length) {
    return res.json({ ok: true, skipped: true, week_label: weekLabel, message: 'Week already shuffled - see /api/weeks for pairs' });
  }
  let allAccounts = [];
  let available = [];
  let unavailable = [];
  const authRs = await db.execute(`SELECT id, display_name as name, color, email, is_available FROM auth_accounts ORDER BY id`);
  if (authRs.rows.length) {
    allAccounts = authRs.rows.map(r => ({
      id: r.id,
      name: r.name,
      color: r.color,
      email: r.email,
      is_available: r.is_available === null || r.is_available === undefined ? 1 : (r.is_available ? 1 : 0),
      source: 'auth'
    }));
    available = allAccounts.filter(a => a.is_available);
    unavailable = allAccounts.filter(a => !a.is_available);
  }
  let participants = [];
  if (available.length >= 2 || (available.length===0 && allAccounts.length===0)) {
    participants = available.length ? available : [];
  } else if (available.length >= 2) {
    participants = available;
  } else if (available.length && available.length < 2 && allAccounts.length >= 2) {
    participants = available;
  } else {
    participants = available;
  }
  if (!participants.length && allAccounts.length === 0) {
    const usersRs = await db.execute(`SELECT id, name, color FROM users ORDER BY id`);
    participants = usersRs.rows.map(r => ({ id: r.id, name: r.name, color: r.color, source: 'users' }));
  }
  if (participants.length < 2) {
    return res.status(400).json({
      ok: false,
      error: 'need at least 2 available participants after filtering',
      available_count: participants.length,
      total_accounts: allAccounts.length,
      unavailable_count: unavailable.length,
      unavailable: unavailable.map(u=>({ id:u.id, name:u.name, email:u.email })),
      hint: 'Users marked unavailable are excluded — ask them to set Available toggle on, or wait for next week'
    });
  }
  let prevPairsSet = new Set();
  try {
    const lastWeek = await db.execute(`SELECT id FROM pairing_weeks ORDER BY id DESC LIMIT 1`);
    if (lastWeek.rows.length) {
      const pg = await db.execute({ sql: `SELECT user_a_id,user_b_id FROM pairing_groups WHERE week_id=?`, args: [lastWeek.rows[0].id] });
      pg.rows.forEach(r => {
        const key = [Math.min(r.user_a_id, r.user_b_id), Math.max(r.user_a_id, r.user_b_id)].join('-');
        prevPairsSet.add(key);
      });
    }
  } catch {}
  let bestPairs = null;
  for (let attempt = 0; attempt < 8; attempt++) {
    const shuffled = shuffleArray(participants);
    const pairs = [];
    for (let i = 0; i < shuffled.length; i+=2) {
      const a = shuffled[i];
      const b = shuffled[i+1] || null;
      if (!b) pairs.push({ a, b: null, isAI: true });
      else pairs.push({ a, b, isAI: false });
    }
    let repeatCount = 0;
    for (const p of pairs) {
      if (p.isAI) continue;
      const key = [Math.min(p.a.id, p.b.id), Math.max(p.a.id, p.b.id)].join('-');
      if (prevPairsSet.has(key)) repeatCount++;
    }
    if (!bestPairs || repeatCount < bestPairs.repeatCount) {
      bestPairs = { pairs, repeatCount };
      if (repeatCount === 0) break;
    }
  }
  const weekIns = await db.execute({ sql: `INSERT INTO pairing_weeks (week_label, week_start, focus) VALUES (?,?,?) RETURNING id`, args: [weekLabel, now.toISOString(), 'both'] });
  const weekId = weekIns.rows[0].id;
  for (const pr of bestPairs.pairs) {
    const aId = pr.a.id;
    const bId = pr.b ? pr.b.id : pr.a.id;
    const isAi = pr.isAI ? 1 : 0;
    await db.execute({ sql: `INSERT INTO pairing_groups (week_id,user_a_id,user_b_id,is_ai_pair,topic,topic_kind) VALUES (?,?,?,?,?,?)`, args: [weekId, aId, bId, isAi, 'Pick together', 'both'] });
  }
  let emailStatus = 'skipped (no RESEND_API_KEY) — pairs visible in-app via /api/weeks; set RESEND_API_KEY + RESEND_FROM to email everyone';
  let unavailableEmailStatus = 'skipped (no RESEND_API_KEY or no unavailable users)';
  const baseUrl = process.env.APP_URL || (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : 'https://randori-circle-self.vercel.app');
  if (process.env.RESEND_API_KEY) {
    try {
      const { Resend } = await import('resend').catch(()=>({Resend:null}));
      if (Resend) {
        const resend = new Resend(process.env.RESEND_API_KEY);
        const from = process.env.RESEND_FROM || 'Randori <noreply@randori.circle>';
        const list = participants.map(p=>p.email).filter(Boolean);
        if (list.length) {
          const html = `<h2>Randori Circle — ${weekLabel}</h2><p>You're paired! This week's auto-shuffle includes ${participants.length} of ${allAccounts.length} signed-up users ( ${unavailable.length} unavailable skipped ).</p><p>Pairs: ${bestPairs.pairs.map(pr=> pr.isAI ? `${pr.a.name} × AI partner` : `${pr.a.name} × ${pr.b.name}`).join(', ')}</p><p><a href="${baseUrl}">Open Randori Circle</a> to see your partner and pick DSA / System Design / Both.</p><p style="color:#888;font-size:12px">Auto-shuffled Sun 08:00 BST. Turn off availability toggle in settings if you want to skip next week.</p>`;
          for (const to of list.slice(0,100)) {
            await resend.emails.send({ from, to, subject: `Randori ${weekLabel} — your pairing is ready`, html }).catch(()=>{});
          }
          emailStatus = `sent to ${list.length} available participants`;
        } else {
          emailStatus = 'no emails for participants (no email field)';
        }
        if (unavailable.length) {
          const uEmails = unavailable.map(u=>u.email).filter(Boolean);
          if (uEmails.length) {
            const htmlU = `<h2>Randori Circle — you missed ${weekLabel}</h2><p>You were excluded from this week's shuffle because you marked <b>Unavailable</b>.</p><p>No worries — you'll be back in next Sunday 08:00 BST automatically unless you stay unavailable.</p><p><a href="${baseUrl}">Open app → Settings → set Available this week = ON</a> to re-join now. Admin can also reshuffle manually this week if you're back early.</p><p style="color:#888;font-size:12px">${participants.length} people were paired this week.</p>`;
            for (const to of uEmails.slice(0,100)) {
              await resend.emails.send({ from, to, subject: `You missed Randori ${weekLabel} — toggle back to available`, html: htmlU }).catch(()=>{});
            }
            unavailableEmailStatus = `sent to ${uEmails.length} unavailable users`;
          } else {
            unavailableEmailStatus = 'unavailable users have no email field';
          }
        } else {
          unavailableEmailStatus = 'no unavailable users this week';
        }
      } else {
        emailStatus = 'resend package not installed — run npm i resend';
        unavailableEmailStatus = emailStatus;
      }
    } catch (e) {
      emailStatus = 'error: '+ String(e.message||e).slice(0,180);
      unavailableEmailStatus = emailStatus;
    }
  }
  return res.json({
    ok: true,
    week_label: weekLabel,
    week_id: weekId,
    pairs: bestPairs.pairs.map(p=>({ a: p.a.name, b: p.b ? p.b.name : 'AI partner', isAI: p.isAI, a_id: p.a.id, b_id: p.b ? p.b.id : null })),
    available_count: participants.length,
    total_accounts: allAccounts.length,
    unavailable_count: unavailable.length,
    unavailable: unavailable.map(u=>({ id:u.id, name:u.name, email:u.email })),
    repeat_avoided: bestPairs.repeatCount,
    email: emailStatus,
    unavailable_emails: unavailableEmailStatus,
    unavailable_reminders: unavailable.map(u=>({ id:u.id, name:u.name, email:u.email, reason: 'marked unavailable', action: 'Set Available this week = ON in app settings' })),
    note: 'Weekly auto-shuffle: only is_available=1 participants. Set RESEND_API_KEY+RESEND_FROM in Vercel to email. Otherwise pairs visible in-app via /api/weeks.',
    app_url: baseUrl
  });
}

export default async function handler(req, res) {
  const slug = getSlug(req);
  const key = slug.join('/').toLowerCase();
  // allow direct names: availability, reshuffle, weekly
  if (key === 'availability' || key === 'settings/availability') return handleAvailability(req, res);
  if (key === 'reshuffle' || key === 'admin/reshuffle') return handleReshuffle(req, res);
  if (key === 'weekly' || key === 'cron/weekly') return handleWeekly(req, res);
  if (!key) return res.status(400).json({ error: 'ops route required: availability|reshuffle|weekly', got: slug });
  return res.status(404).json({ error: `unknown ops route ${key}`, available: ['availability','reshuffle','weekly'] });
}
