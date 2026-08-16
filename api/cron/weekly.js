import { getClient, getJwtSecret, getCronSecret, isoWeekLabel, shuffleArray, deterministicColor } from '../_db.js';
import jwt from 'jsonwebtoken';

function verifyCronAuth(req) {
  const hdr = req.headers['x-cron-secret'] || req.headers['authorization'] || '';
  const secret = getCronSecret();
  // Allow Vercel cron (no header) in production if CRON_SECRET not set? We'll require secret unless in dev.
  // For compatibility: if header is Bearer token of JWT admin, allow.
  if (typeof hdr === 'string' && hdr.startsWith('Bearer ')) {
    try { jwt.verify(hdr.slice(7), getJwtSecret()); return true; } catch {}
  }
  if (hdr && hdr === secret) return true;
  if (req.headers['x-vercel-cron'] !== undefined) return true; // Vercel Cron header present
  // query ?secret=
  if (req.query && req.query.secret && req.query.secret === secret) return true;
  // allow if no secret config and called internally (fallback for local)
  if (!process.env.CRON_SECRET && !process.env.JWT_SECRET) return true;
  return false;
}

export default async function handler(req, res) {
  // Vercel crons are GET by default, also allow POST for manual
  if (req.method !== 'GET' && req.method !== 'POST') return res.status(405).json({ error: 'GET or POST' });
  if (!verifyCronAuth(req)) return res.status(401).json({ error: 'unauthorized cron', hint: 'send x-cron-secret header or ?secret=' });

  const db = getClient();
  await db.execute(`CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, color TEXT NOT NULL, created_at TEXT DEFAULT (datetime('now')))`);
  await db.execute(`CREATE TABLE IF NOT EXISTS auth_accounts (id INTEGER PRIMARY KEY AUTOINCREMENT, email TEXT UNIQUE NOT NULL, password_hash TEXT NOT NULL, display_name TEXT NOT NULL, color TEXT NOT NULL, created_at TEXT DEFAULT (datetime('now')), last_login TEXT)`);
  await db.execute(`CREATE TABLE IF NOT EXISTS pairing_weeks (id INTEGER PRIMARY KEY AUTOINCREMENT, week_label TEXT NOT NULL, week_start TEXT NOT NULL, focus TEXT NOT NULL DEFAULT 'both', created_at TEXT DEFAULT (datetime('now')))`);
  await db.execute(`CREATE TABLE IF NOT EXISTS pairing_groups (id INTEGER PRIMARY KEY AUTOINCREMENT, week_id INTEGER NOT NULL, user_a_id INTEGER NOT NULL, user_b_id INTEGER NOT NULL, user_c_id INTEGER, is_ai_pair INTEGER DEFAULT 0, topic TEXT DEFAULT 'Pick together', topic_kind TEXT DEFAULT 'both', created_at TEXT DEFAULT (datetime('now')))`);

  const now = new Date();
  const weekLabel = isoWeekLabel(now);
  const existingWeek = await db.execute({ sql: `SELECT id FROM pairing_weeks WHERE week_label=?`, args: [weekLabel] });
  if (existingWeek.rows.length) {
    return res.json({ ok: true, skipped: true, week_label: weekLabel, message: 'Week already shuffled' });
  }

  // Gather participants: prefer auth_accounts, fallback to users
  let participants = [];
  const authRs = await db.execute(`SELECT id, display_name as name, color, email FROM auth_accounts ORDER BY id`);
  if (authRs.rows.length >= 2) {
    participants = authRs.rows.map(r => ({ id: r.id, name: r.name, color: r.color, email: r.email, source: 'auth' }));
  } else {
    const usersRs = await db.execute(`SELECT id, name, color FROM users ORDER BY id`);
    participants = usersRs.rows.map(r => ({ id: r.id, name: r.name, color: r.color, source: 'users' }));
  }

  if (participants.length < 2) {
    return res.status(400).json({ ok: false, error: 'need at least 2 participants', count: participants.length });
  }

  // Try to avoid previous pair repeats if possible — look at last week pairs
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
      if (!b) {
        pairs.push({ a, b: null, isAI: true });
      } else {
        pairs.push({ a, b, isAI: false });
      }
    }
    // Score: fewer repeats = better
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

  // Insert pairing_groups
  for (const pr of bestPairs.pairs) {
    const aId = pr.a.id;
    const bId = pr.b ? pr.b.id : pr.a.id; // if AI, reuse a? But spec says user_b_id NOT NULL; we will use a and set is_ai_pair=1 and keep bId = a for compatibility, or a's id again. Better to have separate handling: for AI pair set user_b_id = user_a_id and is_ai_pair=1 (frontend shows AI)
    // To preserve pairing for history queries using auth_accounts.id OR users.id, we store as is. For AI case, user_b_id = user_a_id.
    const isAi = pr.isAI ? 1 : 0;
    await db.execute({ sql: `INSERT INTO pairing_groups (week_id,user_a_id,user_b_id,is_ai_pair,topic,topic_kind) VALUES (?,?,?,?,?,?)`, args: [weekId, aId, bId, isAi, 'Pick together', 'both'] });
  }

  // Optional email notify via Resend
  let emailStatus = 'skipped (no RESEND_API_KEY)';
  if (process.env.RESEND_API_KEY) {
    try {
      const { Resend } = await import('resend').catch(()=>({Resend:null}));
      if (Resend) {
        const resend = new Resend(process.env.RESEND_API_KEY);
        const list = participants.map(p=>p.email).filter(Boolean);
        if (list.length) {
          const html = `<h2>Randori Circle — ${weekLabel}</h2><p>Pairs shuffled! ${bestPairs.pairs.map(pr=> pr.isAI ? `${pr.a.name} × AI partner` : `${pr.a.name} × ${pr.b.name}`).join(', ')}</p><p><a href="${process.env.VERCEL_URL ? 'https://'+process.env.VERCEL_URL : 'https://randori-circle-self.vercel.app'}">Open app</a></p>`;
          for (const to of list.slice(0,20)) {
            await resend.emails.send({ from: process.env.RESEND_FROM || 'Randori <noreply@randori.circle>', to, subject: `Randori ${weekLabel} — your pairing is ready`, html }).catch(()=>{});
          }
          emailStatus = `attempted to ${list.length} recipients`;
        }
      }
    } catch (e) {
      emailStatus = 'error: '+ String(e.message||e).slice(0,120);
    }
  }

  return res.json({ ok: true, week_label: weekLabel, week_id: weekId, pairs: bestPairs.pairs.map(p=>({ a: p.a.name, b: p.b ? p.b.name : 'AI', isAI: p.isAI })), repeat_avoided: bestPairs.repeatCount, email: emailStatus });
}
