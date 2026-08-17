import { getClient } from './_db.js';

// GET -> { weeks: [{id, week_label, week_start, focus, created_at, pairs: [{pg_id, a_id, b_id, a_name, b_name, is_ai, topic, topic_kind}]}] }
export default async function handler(req, res) {
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

    // Build id -> name map from auth_accounts + users
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
        // fallback users only
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
