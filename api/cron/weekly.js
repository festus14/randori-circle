import { getClient, getJwtSecret, getCronSecret, isoWeekLabel, shuffleArray } from '../_db.js';
import jwt from 'jsonwebtoken';

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

export default async function handler(req, res) {
  if (req.method !== 'GET' && req.method !== 'POST') return res.status(405).json({ error: 'GET or POST' });
  if (!verifyCronAuth(req)) return res.status(401).json({ error: 'unauthorized cron', hint: 'send x-cron-secret header or ?secret=' });

  const db = getClient();
  // ensure tables + migration
  await db.execute(`CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, color TEXT NOT NULL, created_at TEXT DEFAULT (datetime('now')))`);
  await db.execute(`CREATE TABLE IF NOT EXISTS auth_accounts (id INTEGER PRIMARY KEY AUTOINCREMENT, email TEXT UNIQUE NOT NULL, password_hash TEXT NOT NULL, display_name TEXT NOT NULL, color TEXT NOT NULL, created_at TEXT DEFAULT (datetime('now')), last_login TEXT, is_available INTEGER DEFAULT 1, availability_updated_at TEXT, is_admin INTEGER DEFAULT 0)`);
  await db.execute(`CREATE TABLE IF NOT EXISTS pairing_weeks (id INTEGER PRIMARY KEY AUTOINCREMENT, week_label TEXT NOT NULL, week_start TEXT NOT NULL, focus TEXT NOT NULL DEFAULT 'both', created_at TEXT DEFAULT (datetime('now')))`);
  await db.execute(`CREATE TABLE IF NOT EXISTS pairing_groups (id INTEGER PRIMARY KEY AUTOINCREMENT, week_id INTEGER NOT NULL, user_a_id INTEGER NOT NULL, user_b_id INTEGER NOT NULL, user_c_id INTEGER, is_ai_pair INTEGER DEFAULT 0, topic TEXT DEFAULT 'Pick together', topic_kind TEXT DEFAULT 'both', created_at TEXT DEFAULT (datetime('now')))`);

  try { await db.execute(`ALTER TABLE auth_accounts ADD COLUMN is_available INTEGER DEFAULT 1`); } catch {}
  try { await db.execute(`ALTER TABLE auth_accounts ADD COLUMN availability_updated_at TEXT`); } catch {}
  try { await db.execute(`ALTER TABLE auth_accounts ADD COLUMN is_admin INTEGER DEFAULT 0`); } catch {}

  const now = new Date();
  const weekLabel = isoWeekLabel(now);
  const existingWeek = await db.execute({ sql: `SELECT id FROM pairing_weeks WHERE week_label=?`, args: [weekLabel] });
  if (existingWeek.rows.length) {
    return res.json({ ok: true, skipped: true, week_label: weekLabel, message: 'Week already shuffled - see /api/weeks for pairs' });
  }

  // Gather participants: only available = 1 (treat NULL as 1 for backwards compat)
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
    // If some marked unavailable leaving <2, we still need at least 2 — but spec says exclude unavailable, so error out rather than include unavailable
    participants = available;
  } else {
    participants = available;
  }

  // If no auth_accounts, fallback to legacy users (treated all available)
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

  // Avoid repeats
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

  // Email handling explaining fallback
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
