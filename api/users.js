import { getClient } from './_db.js';
export default async function handler(req, res) {
  const db = getClient();
  if (req.method === 'GET') {
    const rs = await db.execute("SELECT id, name, color, created_at FROM users ORDER BY id");
    return res.json({ users: rs.rows });
  }
  if (req.method === 'POST') {
    const { name, color } = req.body || {};
    if (!name) return res.status(400).json({ error: "name required" });
    const c = color || "#" + Math.floor(Math.random()*16777215).toString(16).padStart(6,"0");
    const rs = await db.execute({ sql: "INSERT INTO users (name, color) VALUES (?,?) RETURNING id", args: [name, c] });
    return res.json({ id: rs.rows[0].id });
  }
  res.status(405).json({ error: "method not allowed" });
}
