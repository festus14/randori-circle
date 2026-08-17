import { getClient, getJwtSecret } from '../_db.js';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
  const { email, password } = req.body || {};
  if (!email || !password) return res.status(400).json({ error: 'email,password required' });
  const e = String(email).trim().toLowerCase();
  const db = getClient();
  await db.execute(`CREATE TABLE IF NOT EXISTS auth_accounts (id INTEGER PRIMARY KEY AUTOINCREMENT, email TEXT UNIQUE NOT NULL, password_hash TEXT NOT NULL, display_name TEXT NOT NULL, color TEXT NOT NULL, created_at TEXT DEFAULT (datetime('now')), last_login TEXT)`);
  const rs = await db.execute({ sql: `SELECT id,email,password_hash,display_name,color FROM auth_accounts WHERE email=?`, args: [e] });
  if (!rs.rows.length) return res.status(401).json({ error: 'invalid credentials' });
  const row = rs.rows[0];
  const ok = await bcrypt.compare(String(password), row.password_hash);
  if (!ok) return res.status(401).json({ error: 'invalid credentials' });
  await db.execute({ sql: `UPDATE auth_accounts SET last_login=datetime('now') WHERE id=?`, args: [row.id] }).catch(()=>{});
  const token = jwt.sign({ id: row.id, email: row.email, name: row.display_name, color: row.color }, getJwtSecret(), { expiresIn: '30d' });
  return res.json({ ok: true, token, user: { id: row.id, email: row.email, name: row.display_name, color: row.color } });
}
