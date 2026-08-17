// api/auth/[...slug].js — grouped auth router (5 routes)
// Handles: signup, login, me, google/start, google/callback
// Imports preserved from original handlers, TURSO/JWT/bcrypt logic identical.

import { getClient, getJwtSecret, deterministicColor } from '../_db.js';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';

function getSlug(req) {
  // Vercel provides req.query.slug as array or string
  let slug = req.query?.slug;
  if (!slug) {
    // fallback parse from url
    try {
      const u = new URL(req.url, 'http://localhost');
      const parts = u.pathname.split('/').filter(Boolean);
      // parts = ['api','auth','signup'] etc
      const idx = parts.indexOf('auth');
      if (idx >= 0) return parts.slice(idx + 1);
      return [];
    } catch { return []; }
  }
  if (typeof slug === 'string') return [slug];
  return slug;
}

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

// ----- individual route handlers (inlined) -----
async function handleSignup(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
  const { email, password, name } = req.body || {};
  if (!email || !password || !name) return res.status(400).json({ error: 'email,password,name required' });
  if (password.length < 6) return res.status(400).json({ error: 'password min 6 chars' });
  const e = String(email).trim().toLowerCase();
  if (!e.includes('@')) return res.status(400).json({ error: 'invalid email' });
  const display = String(name).trim().slice(0, 32);
  const db = getClient();
  await db.execute(`CREATE TABLE IF NOT EXISTS auth_accounts (id INTEGER PRIMARY KEY AUTOINCREMENT, email TEXT UNIQUE NOT NULL, password_hash TEXT NOT NULL, display_name TEXT NOT NULL, color TEXT NOT NULL, created_at TEXT DEFAULT (datetime('now')), last_login TEXT)`);
  await db.execute(`CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, color TEXT NOT NULL, created_at TEXT DEFAULT (datetime('now')))`);
  const existing = await db.execute({ sql: `SELECT id FROM auth_accounts WHERE email=?`, args: [e] });
  if (existing.rows.length) return res.status(409).json({ error: 'email already registered' });
  const color = deterministicColor(display.toLowerCase());
  const hash = await bcrypt.hash(password, 10);
  const ins = await db.execute({ sql: `INSERT INTO auth_accounts (email,password_hash,display_name,color,last_login) VALUES (?,?,?,?,datetime('now')) RETURNING id`, args: [e, hash, display, color] });
  const authId = ins.rows[0].id;
  try { await db.execute({ sql: `INSERT INTO users (name,color) VALUES (?,?)`, args: [display, color] }); } catch {}
  const token = jwt.sign({ id: authId, email: e, name: display, color }, getJwtSecret(), { expiresIn: '30d' });
  return res.json({ ok: true, token, user: { id: authId, email: e, name: display, color } });
}

async function handleLogin(req, res) {
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

async function handleMe(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'GET only' });
  const auth = req.headers.authorization || '';
  const m = auth.match(/^Bearer\s+(.+)$/);
  if (!m) return res.status(401).json({ error: 'missing Bearer token' });
  try {
    const payload = jwt.verify(m[1], getJwtSecret());
    // Allow both id and uid (google callback originally used uid)
    const pid = payload.id ?? payload.uid;
    if (!pid) return res.status(401).json({ error: 'invalid token payload' });
    const db = getClient();
    try { await db.execute(`ALTER TABLE auth_accounts ADD COLUMN is_available INTEGER DEFAULT 1`); } catch {}
    try { await db.execute(`ALTER TABLE auth_accounts ADD COLUMN availability_updated_at TEXT`); } catch {}
    const rs = await db.execute({ sql: `SELECT id,email,display_name,color,created_at,last_login,is_available,availability_updated_at FROM auth_accounts WHERE id=?`, args: [pid] });
    if (!rs.rows.length) return res.status(401).json({ error: 'user not found' });
    const u = rs.rows[0];
    const is_available = u.is_available === null || u.is_available === undefined ? 1 : (u.is_available ? 1 : 0);
    const adminEmail = 'festusomole14@gmail.com'.toLowerCase();
    const isAdmin = String(u.email || '').toLowerCase() === adminEmail;
    return res.json({ ok: true, user: { id: u.id, email: u.email, name: u.display_name, color: u.color, created_at: u.created_at, last_login: u.last_login, is_available: !!is_available, isAvailable: !!is_available, availability_updated_at: u.availability_updated_at, admin: isAdmin }, admin: isAdmin });
  } catch (e) {
    return res.status(401).json({ error: 'invalid token', detail: String(e.message || e).slice(0,120) });
  }
}

function handleGoogleStart(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'GET only' });
  const clientId = process.env.GOOGLE_CLIENT_ID;
  if (!clientId) return res.status(500).json({ error: 'Missing GOOGLE_CLIENT_ID env', hint: 'Set GOOGLE_CLIENT_ID in Vercel Env Vars' });
  const appUrl = (process.env.APP_URL || 'https://randori-circle-self.vercel.app').replace(/\/$/, '');
  const redirectUri = `${appUrl}/api/auth/google/callback`;
  const state = Math.random().toString(36).slice(2, 12) + Date.now().toString(36);
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: 'openid email profile',
    access_type: 'offline',
    prompt: 'consent',
    state
  });
  const url = `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;
  res.writeHead(302, { Location: url });
  res.end();
}

async function handleGoogleCallback(req, res) {
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
  if (!clientId || !clientSecret) return res.status(500).json({ error: 'Missing GOOGLE_CLIENT_ID or GOOGLE_CLIENT_SECRET' });

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
      const ur = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', { headers: { Authorization: `Bearer ${access_token}` } });
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
    // include both id and uid for compatibility (me expects id)
    ourJwt = jwt.sign({ id: authId, uid: authId, email, name: finalName, color }, getJwtSecret(), { expiresIn: '30d' });
  }catch{
    res.writeHead(302, { Location: `${appUrl}/?google_error=jwt_error` });
    return res.end();
  }
  const dest = `${appUrl}/?g_token=${encodeURIComponent(ourJwt)}&g_name=${encodeURIComponent(finalName)}`;
  res.writeHead(302, { Location: dest });
  res.end();
}

export default async function handler(req, res) {
  const slug = getSlug(req);
  const key = slug.join('/').toLowerCase(); // e.g. 'signup', 'login', 'me', 'google/start', 'google/callback'
  // dispatch
  if (key === 'signup') return handleSignup(req, res);
  if (key === 'login') return handleLogin(req, res);
  if (key === 'me') return handleMe(req, res);
  if (key === 'google/start') return handleGoogleStart(req, res);
  if (key === 'google/callback') return handleGoogleCallback(req, res);
  // also support legacy singletons
  if (key === 'google' && req.method === 'GET') return handleGoogleStart(req, res);
  // If slug empty -> list auth routes
  if (!key) return res.status(400).json({ error: 'auth route required: signup|login|me|google/start|google/callback', got: slug });
  return res.status(404).json({ error: `unknown auth route ${key}`, available: ['signup','login','me','google/start','google/callback'] });
}
