import { getClient, getJwtSecret } from '../_db.js';
import jwt from 'jsonwebtoken';

// GET /api/settings/me -> same as /api/auth/me but explicit for settings page + returns availability
export default async function handler(req, res){
  if (req.method !== 'GET') return res.status(405).json({ error:'GET only' });
  const auth = req.headers.authorization || '';
  const m = auth.match(/^Bearer\s+(.+)$/);
  if (!m) return res.status(401).json({ error:'missing Bearer token' });
  let payload;
  try{ payload = jwt.verify(m[1], getJwtSecret()); } catch(e){ return res.status(401).json({ error:'invalid token' }); }
  const db = getClient();
  try{ await db.execute(`ALTER TABLE auth_accounts ADD COLUMN is_available INTEGER DEFAULT 1`);}catch{}
  try{ await db.execute(`ALTER TABLE auth_accounts ADD COLUMN availability_updated_at TEXT`);}catch{}
  const rs = await db.execute({ sql:`SELECT id,email,display_name,color,created_at,last_login,is_available,availability_updated_at FROM auth_accounts WHERE id=?`, args:[payload.id] });
  if (!rs.rows.length) return res.status(404).json({ error:'user not found' });
  const u=rs.rows[0];
  const isAv = u.is_available===null||u.is_available===undefined ? true : !!u.is_available;
  return res.json({ ok:true, user:{ id:u.id, email:u.email, name:u.display_name, color:u.color, created_at:u.created_at, last_login:u.last_login, is_available:isAv, isAvailable:isAv, availability_updated_at:u.availability_updated_at }, admin: u.email.toLowerCase()==='festusomole14@gmail.com', settings:{ is_available:isAv, note: isAv?'included Sun 08:00 BST auto-shuffle':'excluded — toggle on to rejoin' } });
}
