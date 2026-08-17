import { getClient, getJwtSecret } from '../_db.js';
import jwt from 'jsonwebtoken';

export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'GET only' });
  const auth = req.headers.authorization || '';
  const m = auth.match(/^Bearer\s+(.+)$/);
  if (!m) return res.status(401).json({ error: 'missing Bearer token' });
  try {
    const payload = jwt.verify(m[1], getJwtSecret());
    const db = getClient();
    // ensure migration columns exist (idempotent, ignore error)
    try { await db.execute(`ALTER TABLE auth_accounts ADD COLUMN is_available INTEGER DEFAULT 1`); } catch {}
    try { await db.execute(`ALTER TABLE auth_accounts ADD COLUMN availability_updated_at TEXT`); } catch {}
    const rs = await db.execute({ sql: `SELECT id,email,display_name,color,created_at,last_login,is_available,availability_updated_at FROM auth_accounts WHERE id=?`, args: [payload.id] });
    if (!rs.rows.length) return res.status(401).json({ error: 'user not found' });
    const u = rs.rows[0];
    const is_available = u.is_available === null || u.is_available === undefined ? 1 : (u.is_available ? 1 : 0);
    return res.json({ ok: true, user: { id: u.id, email: u.email, name: u.display_name, color: u.color, created_at: u.created_at, last_login: u.last_login, is_available: !!is_available, isAvailable: !!is_available, availability_updated_at: u.availability_updated_at } });
  } catch (e) {
    return res.status(401).json({ error: 'invalid token', detail: String(e.message || e).slice(0,120) });
  }
}
