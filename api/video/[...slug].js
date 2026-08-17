// api/video/[...slug].js — WebRTC signaling via Turso
// Handles: signal POST, poll GET, cleanup. Mesh P2P polling (2s).
// Table: video_signals (id PK, room_id TEXT, from_id TEXT, to_id TEXT, type TEXT, payload TEXT, created_at)

import { getClient } from '../_db.js';

function getSlug(req) {
  let slug = req.query?.slug;
  if (!slug) {
    try {
      const u = new URL(req.url, 'http://localhost');
      const parts = u.pathname.split('/').filter(Boolean);
      const idx = parts.indexOf('video');
      if (idx >= 0) return parts.slice(idx + 1);
      return [];
    } catch { return []; }
  }
  if (typeof slug === 'string') return [slug];
  return slug;
}

async function ensureTable(db) {
  await db.execute(`CREATE TABLE IF NOT EXISTS video_signals (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    room_id TEXT NOT NULL,
    from_id TEXT NOT NULL,
    to_id TEXT,
    type TEXT NOT NULL,
    payload TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now'))
  `);
  // index for performance (ignore if exists — Turso sqlite doesn't have IF NOT EXISTS for CREATE INDEX in older, try)
  try { await db.execute(`CREATE INDEX IF NOT EXISTS idx_video_signals_room ON video_signals(room_id, created_at)`); } catch {}
  try { await db.execute(`CREATE INDEX IF NOT EXISTS idx_video_signals_room_id ON video_signals(room_id, id)`); } catch {}
}

async function cleanupOld(db) {
  try {
    await db.execute(`DELETE FROM video_signals WHERE created_at < datetime('now','-1 hour')`);
  } catch {}
}

async function handleSignal(req, res) {
  const db = getClient();
  await ensureTable(db);
  await cleanupOld(db);

  if (req.method === 'POST') {
    const body = req.body || {};
    const room_id = (body.room_id || body.roomId || '').toString().trim().slice(0,128);
    const from_id = (body.from_id || body.fromId || body.peer_id || '').toString().trim().slice(0,128);
    const to_id = (body.to_id || body.toId || '').toString().trim().slice(0,128) || null;
    const type = (body.type || '').toString().trim().slice(0,32); // offer/answer/ice/join/leave
    let payload = body.payload;
    if (!room_id || !from_id || !type) {
      return res.status(400).json({ ok:false, error:'room_id, from_id, type required', got:{room_id:!!room_id, from_id:!!from_id, type:!!type} });
    }
    if (typeof payload !== 'string') {
      try { payload = JSON.stringify(payload); } catch { payload = String(payload); }
    }
    // truncate payload to avoid huge blobs (SDP ~ 4-8KB, ICE ~500B)
    if (payload.length > 20000) payload = payload.slice(0,20000);
    try {
      const ins = await db.execute({
        sql: `INSERT INTO video_signals (room_id, from_id, to_id, type, payload) VALUES (?,?,?,?,?) RETURNING id`,
        args: [room_id, from_id, to_id, type, payload]
      });
      const id = ins.rows?.[0]?.id ?? null;
      return res.json({ ok:true, id, room_id, from_id, type });
    } catch (e) {
      return res.status(500).json({ ok:false, error:'insert failed', detail:String(e.message||e).slice(0,300) });
    }
  }

  if (req.method === 'GET') {
    const q = req.query || {};
    // support both query via URLSearchParams parse fallback (vercel)
    let room_id = (q.room_id || q.roomId || '').toString();
    let peer_id = (q.peer_id || q.peerId || q.from_id || q.fromId || '').toString();
    let after = parseInt((q.after || q.since || '0').toString(),10);
    if (!room_id) {
      // try parse from url directly
      try {
        const u = new URL(req.url, 'http://localhost');
        room_id = u.searchParams.get('room_id') || u.searchParams.get('roomId') || '';
        peer_id = u.searchParams.get('peer_id') || u.searchParams.get('peerId') || u.searchParams.get('from_id') || '';
        after = parseInt(u.searchParams.get('after')||u.searchParams.get('since')||'0',10)||0;
      } catch {}
    }
    if (!room_id) return res.status(400).json({ ok:false, error:'room_id required' });
    after = isNaN(after) ? 0 : after;
    try {
      // Return signals from last hour, id > after, not our own, and either broadcast (to_id null/empty) or directed to us
      let sql = `SELECT id, room_id, from_id, to_id, type, payload, created_at FROM video_signals WHERE room_id=? AND id>? AND created_at > datetime('now','-1 hour')`;
      const args = [room_id, after];
      if (peer_id) {
        sql += ` AND from_id != ?`;
        args.push(peer_id);
        // Include only signals either broadcast or to us; if to_id present and not us, skip but we filter in JS for simplicity to avoid SQL OR complexity with null
        sql += ` ORDER BY id ASC LIMIT 100`;
        const rs = await db.execute({ sql, args });
        const filtered = rs.rows.filter(r => !r.to_id || r.to_id === peer_id || r.to_id === '' );
        return res.json({ ok:true, signals: filtered, after: filtered.length ? filtered[filtered.length-1].id : after, count: filtered.length });
      } else {
        sql += ` ORDER BY id ASC LIMIT 100`;
        const rs = await db.execute({ sql, args });
        return res.json({ ok:true, signals: rs.rows, after: rs.rows.length ? rs.rows[rs.rows.length-1].id : after, count: rs.rows.length });
      }
    } catch (e) {
      return res.status(500).json({ ok:false, error:'query failed', detail:String(e.message||e).slice(0,300) });
    }
  }

  if (req.method === 'DELETE') {
    // Manual purge for room
    const body = req.body || {};
    const room_id = (body.room_id || req.query?.room_id || '').toString();
    try {
      if (room_id) await db.execute({ sql:`DELETE FROM video_signals WHERE room_id=?`, args:[room_id] });
      else await cleanupOld(db);
      return res.json({ ok:true, purged:true });
    } catch(e){ return res.status(500).json({ok:false, error:String(e.message||e).slice(0,200)}) }
  }

  return res.status(405).json({ ok:false, error:'GET (poll) or POST (signal) only' });
}

export default async function handler(req, res) {
  const slug = getSlug(req);
  const key = slug.join('/').toLowerCase();
  // Accept: signal, poll, or empty -> signal umbrella
  if (!key || key === 'signal' || key === 'poll' || key === 'signals') {
    return handleSignal(req, res);
  }
  return res.status(404).json({ ok:false, error:`unknown video route ${key}`, available:['signal'] });
}
