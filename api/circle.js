// Public: list of everyone who signed up (auto-included circle)
// Returns { circle: [{id, display_name, name, email, color, created_at, is_available}] }
export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'GET only' });
  const db = getClient();
  // ensure tables exist (idempotent) incl availability migration
  try {
    await db.execute(`CREATE TABLE IF NOT EXISTS auth_accounts (id INTEGER PRIMARY KEY AUTOINCREMENT, email TEXT UNIQUE NOT NULL, password_hash TEXT NOT NULL, display_name TEXT NOT NULL, color TEXT NOT NULL, created_at TEXT DEFAULT (datetime('now')), last_login TEXT, is_available INTEGER DEFAULT 1, availability_updated_at TEXT)`);
    await db.execute(`CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, color TEXT NOT NULL, created_at TEXT DEFAULT (datetime('now')))`);
  } catch {}
  try { await db.execute(`ALTER TABLE auth_accounts ADD COLUMN is_available INTEGER DEFAULT 1`); } catch {}
  try { await db.execute(`ALTER TABLE auth_accounts ADD COLUMN availability_updated_at TEXT`); } catch {}

  // Prefer auth_accounts
  try {
    const rs = await db.execute(`SELECT id, display_name, color, email, created_at, is_available, availability_updated_at FROM auth_accounts ORDER BY id`);
    if (rs.rows.length) {
      const circle = rs.rows.map(r => ({
        id: r.id,
        display_name: r.display_name,
        name: r.display_name,
        email: r.email,
        color: r.color,
        created_at: r.created_at,
        is_available: r.is_available === null || r.is_available === undefined ? true : !!r.is_available,
        isAvailable: r.is_available === null || r.is_available === undefined ? true : !!r.is_available,
        availability_updated_at: r.availability_updated_at,
        source: 'auth'
      }));
      return res.json({ ok: true, circle, count: circle.length, source: 'auth_accounts' });
    }
  } catch (e) {
    // fall through to users
  }
  try {
    const rs2 = await db.execute(`SELECT id, name, color, created_at FROM users ORDER BY id`);
    const circle = rs2.rows.map(r => ({ id: r.id, display_name: r.name, name: r.name, email: null, color: r.color, created_at: r.created_at, is_available: true, isAvailable: true, source: 'users' }));
    return res.json({ ok: true, circle, count: circle.length, source: 'users' });
  } catch (e) {
    return res.status(500).json({ ok: false, error: 'cannot list circle', detail: String(e.message||e).slice(0,200) });
  }
}
