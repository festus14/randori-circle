import { getClient, getJwtSecret } from './_db.js';
import jwt from 'jsonwebtoken';

export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'GET only' });
  const auth = req.headers.authorization || '';
  const m = auth.match(/^Bearer\s+(.+)$/);
  if (!m) return res.status(401).json({ error: 'missing Bearer token' });
  let payload;
  try { payload = jwt.verify(m[1], getJwtSecret()); } catch (e) { return res.status(401).json({ error: 'invalid token' }); }
  const db = getClient();
  // pairing_groups stores ids from either auth_accounts OR users depending on weekly source.
  // We need to return weeks where this user appears.
  // Try auth_accounts id match first.
  const userId = payload.id;
  // Find weeks including this user
  const groups = await db.execute({ sql: `
    SELECT pg.id as pg_id, pg.week_id, pg.user_a_id, pg.user_b_id, pg.is_ai_pair, pg.topic, pg.topic_kind,
           pw.week_label, pw.week_start
    FROM pairing_groups pg
    JOIN pairing_weeks pw ON pw.id = pg.week_id
    WHERE pg.user_a_id = ? OR pg.user_b_id = ?
    ORDER BY pw.week_start DESC, pg.id DESC
  `, args: [userId, userId] });

  // Enrich partner names — look up from auth_accounts or users
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
      // fallback only users
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

  // summary counts
  const partnerCounts = {};
  enriched.forEach(e=> { if (!e.is_ai) partnerCounts[e.partner_name] = (partnerCounts[e.partner_name]||0)+1; });

  return res.json({ ok: true, user: { id: payload.id, name: payload.name }, history: enriched, partner_counts: partnerCounts, total: enriched.length });
}
