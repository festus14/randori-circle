import { getClient, getJwtSecret, deterministicColor } from '../../api/_db.js';
import jwt from 'jsonwebtoken';

function base64UrlDecode(str){
  let s = str.replace(/-/g, '+').replace(/_/g, '/');
  const pad = s.length % 4;
  if (pad) s += '='.repeat(4 - pad);
  try { return Buffer.from(s, 'base64').toString('utf8'); } catch { return null; }
}

function parseIdToken(idToken){
  try{
    const parts = idToken.split('.');
    if (parts.length < 2) return null;
    const payload = base64UrlDecode(parts[1]);
    if (!payload) return null;
    return JSON.parse(payload);
  }catch{ return null; }
}

export default async function handler(req, res){
  const appUrl = (process.env.APP_URL || 'https://randori-circle-self.vercel.app').replace(/\/$/, '');
  const redirectUri = `${appUrl}/api/auth/google/callback`;

  const { code, error } = req.query || {};

  if (error){
    res.writeHead(302, { Location: `${appUrl}/?google_error=${encodeURIComponent(error)}` });
    return res.end();
  }
  if (!code){
    res.writeHead(302, { Location: `${appUrl}/?google_error=missing_code` });
    return res.end();
  }

  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  if (!clientId || !clientSecret){
    return res.status(500).json({ error: 'Missing GOOGLE_CLIENT_ID or GOOGLE_CLIENT_SECRET' });
  }

  let tokenJson;
  try{
    const body = new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      code: String(code),
      redirect_uri: redirectUri,
      grant_type: 'authorization_code'
    });
    const r = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: body.toString()
    });
    const text = await r.text();
    try{ tokenJson = JSON.parse(text); }catch{ tokenJson = { error: text, status: r.status }; }
    if (!r.ok){
      res.writeHead(302, { Location: `${appUrl}/?google_error=token_exchange_failed` });
      return res.end();
    }
  }catch{
    res.writeHead(302, { Location: `${appUrl}/?google_error=exception` });
    return res.end();
  }

  const { access_token, id_token } = tokenJson;
  let email = null;
  let displayName = null;

  if (id_token){
    const payload = parseIdToken(id_token);
    if (payload){
      email = payload.email || null;
      displayName = payload.name || payload.given_name || null;
    }
  }

  if (!email && access_token){
    try{
      const ur = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
        headers: { Authorization: `Bearer ${access_token}` }
      });
      if (ur.ok){
        const uj = await ur.json();
        email = uj.email || email;
        displayName = uj.name || displayName;
      }
    }catch{}
  }

  if (!email){
    res.writeHead(302, { Location: `${appUrl}/?google_error=no_email` });
    return res.end();
  }

  email = String(email).trim().toLowerCase();
  const nameFromEmail = email.split('@')[0].slice(0,32);
  const finalName = (displayName ? String(displayName).trim().slice(0,32) : nameFromEmail) || nameFromEmail;

  const db = getClient();
  try{
    await db.execute(`CREATE TABLE IF NOT EXISTS auth_accounts (id INTEGER PRIMARY KEY AUTOINCREMENT, email TEXT UNIQUE NOT NULL, password_hash TEXT NOT NULL, display_name TEXT NOT NULL, color TEXT NOT NULL, created_at TEXT DEFAULT (datetime('now')), last_login TEXT)`);
    await db.execute(`CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, color TEXT NOT NULL, created_at TEXT DEFAULT (datetime('now')))`);
  }catch{}

  const color = deterministicColor(finalName.toLowerCase());

  let authId;
  try{
    const existing = await db.execute({ sql: "SELECT id FROM auth_accounts WHERE email = ?", args: [email] });
    if (existing.rows.length){
      authId = existing.rows[0].id;
      await db.execute({ sql: "UPDATE auth_accounts SET last_login = datetime('now'), display_name = COALESCE(?, display_name) WHERE id = ?", args: [finalName, authId] });
    } else {
      const ins = await db.execute({ sql: "INSERT INTO auth_accounts (email, password_hash, display_name, color, last_login) VALUES (?, ?, ?, ?, datetime('now')) RETURNING id", args: [email, 'google-oauth', finalName, color] });
      authId = ins.rows[0].id;
    }
    // ensure in users for pairing
    const uExist = await db.execute({ sql: "SELECT id FROM users WHERE lower(name)=?", args: [finalName.toLowerCase()] });
    if (!uExist.rows.length){
      await db.execute({ sql: "INSERT INTO users (name, color) VALUES (?,?)", args: [finalName, color] });
    }
  }catch(e){
    res.writeHead(302, { Location: `${appUrl}/?google_error=db_error` });
    return res.end();
  }

  let ourJwt;
  try{
    ourJwt = jwt.sign({ uid: authId, email, name: finalName }, getJwtSecret(), { expiresIn: '30d' });
  }catch{
    res.writeHead(302, { Location: `${appUrl}/?google_error=jwt_error` });
    return res.end();
  }

  const dest = `${appUrl}/?g_token=${encodeURIComponent(ourJwt)}&g_name=${encodeURIComponent(finalName)}`;
  res.writeHead(302, { Location: dest });
  res.end();
}
