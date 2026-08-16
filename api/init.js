// Vercel serverless: GET /api/init -> creates tables if not exist
import { getClient } from './_db.js';

export default async function handler(req, res) {
  if (req.method !== 'POST' && req.method !== 'GET') {
    return res.status(405).json({ error: 'POST or GET' });
  }
  const db = getClient();
  await db.batch([
    `CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      color TEXT NOT NULL,
      created_at TEXT DEFAULT (datetime('now'))
    )`,
    `CREATE TABLE IF NOT EXISTS auth_accounts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      email TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      display_name TEXT NOT NULL,
      color TEXT NOT NULL,
      created_at TEXT DEFAULT (datetime('now')),
      last_login TEXT
    )`,
    `CREATE TABLE IF NOT EXISTS pairing_weeks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      week_label TEXT NOT NULL,
      week_start TEXT NOT NULL,
      focus TEXT NOT NULL DEFAULT 'both',
      created_at TEXT DEFAULT (datetime('now'))
    )`,
    `CREATE TABLE IF NOT EXISTS pairing_groups (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      week_id INTEGER NOT NULL REFERENCES pairing_weeks(id) ON DELETE CASCADE,
      user_a_id INTEGER NOT NULL,
      user_b_id INTEGER NOT NULL,
      user_c_id INTEGER,
      is_ai_pair INTEGER DEFAULT 0,
      topic TEXT DEFAULT 'Pick together',
      topic_kind TEXT DEFAULT 'both',
      created_at TEXT DEFAULT (datetime('now'))
    )`,
    `CREATE TABLE IF NOT EXISTS questions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      slug TEXT UNIQUE NOT NULL,
      title TEXT NOT NULL,
      type TEXT NOT NULL,
      difficulty TEXT NOT NULL,
      category TEXT NOT NULL,
      description TEXT NOT NULL
    )`
  ], "write");
  return res.json({ ok: true, message: "Tables ready (incl auth_accounts)" });
}
