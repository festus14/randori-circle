import { getClient, getJwtSecret, deterministicColor, getAdminEmails } from '../_db.js';
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
  // ensure table exists (defensive) with is_admin
  await db.execute(`CREATE TABLE IF NOT EXISTS auth_accounts (id INTEGER PRIMARY KEY AUTOINCREMENT, email TEXT UNIQUE NOT NULL, password_hash TEXT NOT NULL, display_name TEXT NOT NULL, color TEXT NOT NULL, created_at TEXT DEFAULT (datetime('now')), last_login TEXT, is_available INTEGER DEFAULT 1, availability_updated_at TEXT, is_admin INTEGER DEFAULT 0)`);
  await db.execute(`CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, color TEXT NOT NULL, created_at TEXT DEFAULT (datetime('now')))`);
  try { await db.execute(`ALTER TABLE auth_accounts ADD COLUMN is_available INTEGER DEFAULT 1`); } catch {}
  try { await db.execute(`ALTER TABLE auth_accounts ADD COLUMN availability_updated_at TEXT`); } catch {}
  try { await db.execute(`ALTER TABLE auth_accounts ADD COLUMN is_admin INTEGER DEFAULT 0`); } catch {}
  const existing = await db.execute({ sql: `SELECT id FROM auth_accounts WHERE email=?`, args: [e] });
  if (existing.rows.length) return res.status(409).json({ error: 'email already registered' });
  const color = deterministicColor(display.toLowerCase());
  const hash = await bcrypt.hash(password, 10);
  const isAdmin = getAdminEmails().has(e) ? 1 : 0;
  const ins = await db.execute({ sql: `INSERT INTO auth_accounts (email,password_hash,display_name,color,last_login,is_available,is_admin) VALUES (?,?,?,?,datetime('now'),1,?) RETURNING id`, args: [e, hash, display, color, isAdmin] });
  const authId = ins.rows[0].id;
  try {
    await db.execute({ sql: `INSERT INTO users (name,color) VALUES (?,?)`, args: [display, color] });
  } catch {}
  const token = jwt.sign({ id: authId, email: e, name: display, color, is_admin: !!isAdmin }, getJwtSecret(), { expiresIn: '30d' });
  return res.json({ ok: true, token, user: { id: authId, email: e, name: display, color, is_admin: !!isAdmin, isAdmin: !!isAdmin } });
}
