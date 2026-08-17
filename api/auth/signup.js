import { getClient, getJwtSecret, deterministicColor } from '../_db.js';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
  const { email, password, name } = req.body || {};
  if (!email || !password || !name) return res.status(400).json({ error: 'email,password,name required' });
  if (password.length < 6) return res.status(400).json({ error: 'password min 6 chars' });
  const e = String(email).trim().toLowerCase();
  if (!e.includes('@')) return res.status(400).json({ error: 'invalid email' });
  const display = String(name).trim().slice(0, 32);
  const db = getClient();
  // ensure table exists (defensive)
  await db.execute(`CREATE TABLE IF NOT EXISTS auth_accounts (id INTEGER PRIMARY KEY AUTOINCREMENT, email TEXT UNIQUE NOT NULL, password_hash TEXT NOT NULL, display_name TEXT NOT NULL, color TEXT NOT NULL, created_at TEXT DEFAULT (datetime('now')), last_login TEXT)`);
  await db.execute(`CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, color TEXT NOT NULL, created_at TEXT DEFAULT (datetime('now')))`);
  const existing = await db.execute({ sql: `SELECT id FROM auth_accounts WHERE email=?`, args: [e] });
  if (existing.rows.length) return res.status(409).json({ error: 'email already registered' });
  const color = deterministicColor(display.toLowerCase());
  const hash = await bcrypt.hash(password, 10);
  const ins = await db.execute({ sql: `INSERT INTO auth_accounts (email,password_hash,display_name,color,last_login) VALUES (?,?,?,?,datetime('now')) RETURNING id`, args: [e, hash, display, color] });
  const authId = ins.rows[0].id;
  // also ensure appears in users table for pairing — link via id mapping? we insert separate users entry with same name/color, plus store mapping via id (users.id may differ but we will pair via users table; keep both)
  // To simplify pairing that uses users table historically, insert into users if not present by name lower?
  // We'll insert and keep both; pairing can use users table OR auth_accounts — weekly cron will prefer auth_accounts list.
  try {
    await db.execute({ sql: `INSERT INTO users (name,color) VALUES (?,?)`, args: [display, color] });
  } catch {}
  const token = jwt.sign({ id: authId, email: e, name: display, color }, getJwtSecret(), { expiresIn: '30d' });
  return res.json({ ok: true, token, user: { id: authId, email: e, name: display, color } });
}
