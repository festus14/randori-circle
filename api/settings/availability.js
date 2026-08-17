import { getClient, getJwtSecret } from '../_db.js';
import jwt from 'jsonwebtoken';

// POST /api/settings/availability  body { is_available: boolean }
export default async function handler(req, res){
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
  const auth = req.headers.authorization || '';
  const m = auth.match(/^Bearer\s+(.+)$/);
  if (!m) return res.status(401).json({ error: 'missing Bearer token' });
  let payload;
  try{ payload = jwt.verify(m[1], getJwtSecret()); } catch(e){ return res.status(401).json({ error: 'invalid token' }); }

  const { is_available, isAvailable } = req.body || {};
  const raw = (is_available !== undefined ? is_available : isAvailable);
  if (raw === undefined || raw === null) return res.status(400).json({ error: 'is_available boolean required' });
  const val = raw ? 1 : 0;

  const db = getClient();
  try{ await db.execute(`ALTER TABLE auth_accounts ADD COLUMN is_available INTEGER DEFAULT 1`); }catch{}
  try{ await db.execute(`ALTER TABLE auth_accounts ADD COLUMN availability_updated_at TEXT`);}catch{}

  try{
    await db.execute({ sql:`UPDATE auth_accounts SET is_available=?, availability_updated_at=datetime('now') WHERE id=?`, args:[val, payload.id] });
    const rs = await db.execute({ sql:`SELECT id,email,display_name,is_available,availability_updated_at FROM auth_accounts WHERE id=?`, args:[payload.id] });
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
