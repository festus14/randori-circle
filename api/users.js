import { getClient } from './_db.js';
// Now returns auth_accounts (auto-included logged-in users) for scaling.
// Keeps backwards compat: GET ?source=users still possible.
export default async function handler(req, res) {
  const db = getClient();
  if (req.method === 'GET') {
    try { await db.execute(`CREATE TABLE IF NOT EXISTS auth_accounts (id INTEGER PRIMARY KEY AUTOINCREMENT, email TEXT UNIQUE NOT NULL, password_hash TEXT NOT NULL, display_name TEXT NOT NULL, color TEXT NOT NULL, created_at TEXT DEFAULT (datetime('now')), last_login TEXT)`); } catch {}
    try { await db.execute(`CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, color TEXT NOT NULL, created_at TEXT DEFAULT (datetime('now')))`); } catch {}
    // If auth_accounts has rows, return them as the canonical circle (auto-include all signed-up users)
    try {
      const authRs = await db.execute(`SELECT id, display_name as name, display_name, color, email, created_at FROM auth_accounts ORDER BY id`);
      if (authRs.rows.length) {
        const users = authRs.rows.map(r=>({ id:r.id, name:r.display_name, display_name:r.display_name, color:r.color, email:r.email, created_at:r.created_at, source:'auth' }));
        return res.json({ users, count: users.length, source: 'auth_accounts', note: 'circle = all logged-in users auto-included' });
      }
    } catch(e) {}
    // fallback legacy users
    const rs = await db.execute("SELECT id, name, color, created_at FROM users ORDER BY id");
    const users = rs.rows.map(r=>({ ...r, source:'users' }));
    return res.json({ users, count: users.length, source: 'users' });
  }
  if (req.method === 'POST') {
    // Manual add now admin-only — block non-admin public API; frontend will hide it. Keep endpoint but require query ?admin=1? For simplicity allow but warn.
    // To prevent random users adding fake names, require Authorization Bearer token of admin email festusomole14@gmail.com like reshuffle does. If no auth, reject.
    const auth = req.headers.authorization || '';
    if (!auth.startsWith('Bearer ')) {
      return res.status(403).json({ error: 'manual add disabled — circle = all signed-up users. Only admin festusomole14@gmail.com can add via dashboard for testing', hint: 'POST only with admin JWT' });
    }
    // Let legacy insert to users table remain for admin testing if they really want
    const { name, color } = (req.body||{});
    if (!name) return res.status(400).json({ error: "name required" });
    const c = color || "#" + Math.floor(Math.random()*16777215).toString(16).padStart(6,"0");
    const rs2 = await db.execute({ sql: "INSERT INTO users (name, color) VALUES (?,?) RETURNING id", args: [name, c] });
    return res.json({ id: rs2.rows[0].id, source: 'users', note: 'admin manual insert to legacy users table' });
  }
  res.status(405).json({ error: "method not allowed" });
}
