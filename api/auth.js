import { JWT_AUDIENCE, JWT_ISSUER, getClient, getJwtSecret, deterministicColor, getAdminEmails, verifyMutationOrigin, verifyRequestAuth } from './_db.js';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

const SESSION_COOKIE = 'randori_session';
const OAUTH_STATE_COOKIE = 'randori_oauth_state';
const OAUTH_VERIFIER_COOKIE = 'randori_oauth_verifier';
const JWT_OPTIONS = Object.freeze({
  algorithm: 'HS256',
  issuer: JWT_ISSUER,
  audience: JWT_AUDIENCE,
  expiresIn: '12h',
});

function cookieValue(req, name){
  const raw=String(req.headers?.cookie||'');
  for(const part of raw.split(';')){
    const idx=part.indexOf('=');
    if(idx<0) continue;
    if(part.slice(0,idx).trim()===name){
      try{ return decodeURIComponent(part.slice(idx+1).trim()); }catch{ return ''; }
    }
  }
  return '';
}

function appendCookies(res, cookies){
  const existing=typeof res.getHeader==='function' ? res.getHeader('Set-Cookie') : null;
  const current=Array.isArray(existing) ? existing : (existing ? [existing] : []);
  res.setHeader('Set-Cookie', [...current, ...cookies]);
}

function cookieSecurity(req){
  const proto=String(req.headers?.['x-forwarded-proto']||'').split(',')[0].trim();
  return process.env.NODE_ENV==='production' || proto==='https' ? '; Secure' : '';
}

function sessionCookie(req, token){
  return `${SESSION_COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=43200${cookieSecurity(req)}`;
}

function transientCookie(req, name, value){
  return `${name}=${encodeURIComponent(value)}; Path=/api/auth/google; HttpOnly; SameSite=Lax; Max-Age=600${cookieSecurity(req)}`;
}

function clearCookie(req, name, path='/'){
  return `${name}=; Path=${path}; HttpOnly; SameSite=Lax; Max-Age=0${cookieSecurity(req)}`;
}

function constantTimeEqual(a,b){
  const left=Buffer.from(String(a||''));
  const right=Buffer.from(String(b||''));
  return left.length===right.length && timingSafeEqual(left,right);
}

function signSession(user){
  return jwt.sign(user, getJwtSecret(), JWT_OPTIONS);
}

async function fetchWithTimeout(url, options={}, timeoutMs=10000){
  const controller=new AbortController();
  const timer=setTimeout(()=>controller.abort(),timeoutMs);
  try{ return await fetch(url,{...options,signal:controller.signal}); }
  finally{ clearTimeout(timer); }
}

async function enforceAuthRateLimit(db, req, action, email){
  const forwarded=String(req.headers?.['x-forwarded-for']||'').split(',')[0].trim();
  const ip=forwarded || String(req.socket?.remoteAddress||'unknown');
  const windowSeconds=15*60;
  const bucket=Math.floor(Date.now()/1000/windowSeconds);
  await db.execute(`CREATE TABLE IF NOT EXISTS auth_rate_limits (key TEXT PRIMARY KEY, attempts INTEGER NOT NULL DEFAULT 0, expires_at INTEGER NOT NULL)`);
  const limits=action==='signup'
    ? [[`ip:${ip}`,5],[`email:${email}`,5]]
    : [[`ip:${ip}`,20],[`email:${email}`,10]];
  for(const [dimension,limit] of limits){
    const key=createHash('sha256').update(`${action}|${dimension}|${bucket}|${getJwtSecret()}`).digest('hex');
    const result=await db.execute({
      sql:`INSERT INTO auth_rate_limits (key, attempts, expires_at) VALUES (?,1,?) ON CONFLICT(key) DO UPDATE SET attempts=attempts+1 RETURNING attempts`,
      args:[key,(bucket+1)*windowSeconds],
    });
    const attempts=Number(result.rows[0]?.attempts||1);
    if(attempts>limit){
      const error=new Error('rate limit exceeded');
      error.statusCode=429;
      throw error;
    }
  }
  if(Math.random()<0.02){
    db.execute({sql:`DELETE FROM auth_rate_limits WHERE expires_at < ?`,args:[Math.floor(Date.now()/1000)]}).catch(()=>{});
  }
}

function registrationAllowed(email){
  if(process.env.NODE_ENV!=='production' && process.env.ALLOW_OPEN_SIGNUP==='true') return true;
  const allowlist=String(process.env.SIGNUP_ALLOWLIST||'').split(',').map(v=>v.trim().toLowerCase()).filter(Boolean);
  if(allowlist.includes(String(email).toLowerCase())) return true;
  return process.env.NODE_ENV!=='production' && allowlist.length===0;
}

function verifyAuthMutationOrigin(req){
  const origin=String(req.headers?.origin||req.headers?.Origin||'').trim();
  const host=String(req.headers?.['x-forwarded-host']||req.headers?.host||'').split(',')[0].trim();
  if(!origin || !host) return false;
  try{ return new URL(origin).host===host; }catch{ return false; }
}

function getEndpoint(req){
  const q = req.query?.endpoint || req.query?.ep;
  if (q) return String(q).toLowerCase();
  try{
    const u = new URL(req.url, 'http://localhost');
    const ep = u.searchParams.get('endpoint');
    if (ep) return ep.toLowerCase();
    const path = u.pathname.split('/').filter(Boolean).pop();
    return (path||'').toLowerCase();
  }catch{
    const pop = (req.url||'').split('?')[0].split('/').filter(Boolean).pop()||'';
    return pop.toLowerCase();
  }
}

// --- signup ---
async function handleSignup(req,res){
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
  if(process.env.NODE_ENV==='production'){
    return res.status(503).json({error:'password signup is disabled during the private beta; use Google sign-in'});
  }
  const { email, password, name } = req.body || {};
  if (!email || !password || !name) return res.status(400).json({ error: 'email,password,name required' });
  if (String(password).length < 10 || String(password).length > 128) return res.status(400).json({ error: 'password must be 10-128 chars' });
  const e = String(email).trim().toLowerCase();
  if (e.length>254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)) return res.status(400).json({ error: 'invalid email' });
  const display = String(name).trim().slice(0,32);
  if(display.length<2) return res.status(400).json({ error:'display name must be 2-32 chars' });
  if(!registrationAllowed(e)) return res.status(403).json({error:'private beta signup is invite-only'});
  const db = getClient();
  await db.execute(`CREATE TABLE IF NOT EXISTS auth_accounts (id INTEGER PRIMARY KEY AUTOINCREMENT, email TEXT UNIQUE NOT NULL, password_hash TEXT NOT NULL, display_name TEXT NOT NULL, color TEXT NOT NULL, created_at TEXT DEFAULT (datetime('now')), last_login TEXT, is_available INTEGER DEFAULT 1, availability_updated_at TEXT, is_admin INTEGER DEFAULT 0)`);
  await db.execute(`CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, color TEXT NOT NULL, created_at TEXT DEFAULT (datetime('now')))`);
  try{ await db.execute(`ALTER TABLE auth_accounts ADD COLUMN is_available INTEGER DEFAULT 1`);}catch{}
  try{ await db.execute(`ALTER TABLE auth_accounts ADD COLUMN availability_updated_at TEXT`);}catch{}
  try{ await db.execute(`ALTER TABLE auth_accounts ADD COLUMN is_admin INTEGER DEFAULT 0`);}catch{}
  try{ await enforceAuthRateLimit(db,req,'signup',e); }catch(err){
    if(err?.statusCode===429) return res.status(429).json({error:'too many signup attempts; try again later'});
    return res.status(503).json({error:'signup temporarily unavailable'});
  }
  const existing = await db.execute({ sql:`SELECT id FROM auth_accounts WHERE email=?`, args:[e] });
  if (existing.rows.length) return res.status(409).json({ error:'email already registered' });
  const color = deterministicColor(display.toLowerCase());
  const hash = await bcrypt.hash(password,10);
  const isAdmin = getAdminEmails().has(e) ? 1 : 0;
  const ins = await db.execute({ sql:`INSERT INTO auth_accounts (email,password_hash,display_name,color,last_login,is_available,is_admin) VALUES (?,?,?,?,datetime('now'),1,?) RETURNING id`, args:[e, hash, display, color, isAdmin] });
  const authId = ins.rows[0].id;
  try{ await db.execute({ sql:`INSERT INTO users (name,color) VALUES (?,?)`, args:[display,color]});}catch{}
  const token = signSession({ id:authId, email:e, name:display, color, is_admin: !!isAdmin });
  appendCookies(res,[sessionCookie(req,token)]);
  return res.json({ ok:true, user:{ id:authId, email:e, name:display, color, is_admin: !!isAdmin, isAdmin: !!isAdmin }});
}

// --- login ---
async function handleLogin(req,res){
  if (req.method !== 'POST') return res.status(405).json({ error:'POST only' });
  const { email, password } = req.body || {};
  if (!email || !password) return res.status(400).json({ error:'email,password required' });
  const e = String(email).trim().toLowerCase();
  const db = getClient();
  await db.execute(`CREATE TABLE IF NOT EXISTS auth_accounts (id INTEGER PRIMARY KEY AUTOINCREMENT, email TEXT UNIQUE NOT NULL, password_hash TEXT NOT NULL, display_name TEXT NOT NULL, color TEXT NOT NULL, created_at TEXT DEFAULT (datetime('now')), last_login TEXT, is_available INTEGER DEFAULT 1, availability_updated_at TEXT, is_admin INTEGER DEFAULT 0)`);
  try{ await db.execute(`ALTER TABLE auth_accounts ADD COLUMN is_available INTEGER DEFAULT 1`);}catch{}
  try{ await db.execute(`ALTER TABLE auth_accounts ADD COLUMN availability_updated_at TEXT`);}catch{}
  try{ await db.execute(`ALTER TABLE auth_accounts ADD COLUMN is_admin INTEGER DEFAULT 0`);}catch{}
  try{ await enforceAuthRateLimit(db,req,'login',e); }catch(err){
    if(err?.statusCode===429) return res.status(429).json({error:'too many login attempts; try again later'});
    return res.status(503).json({error:'login temporarily unavailable'});
  }
  const rs = await db.execute({ sql:`SELECT id,email,password_hash,display_name,color,is_admin FROM auth_accounts WHERE email=?`, args:[e] });
  if (!rs.rows.length) return res.status(401).json({ error:'invalid credentials' });
  const row = rs.rows[0];
  const ok = String(row.password_hash||'').startsWith('$2') && await bcrypt.compare(String(password), row.password_hash);
  if (!ok) return res.status(401).json({ error:'invalid credentials' });
  await db.execute({ sql:`UPDATE auth_accounts SET last_login=datetime('now') WHERE id=?`, args:[row.id]}).catch(()=>{});
  const envAdmins = getAdminEmails();
  if (envAdmins.has(e) && !row.is_admin){
    try{ await db.execute({ sql:`UPDATE auth_accounts SET is_admin=1 WHERE id=?`, args:[row.id]}); row.is_admin=1; }catch{}
  }
  const is_admin = !!row.is_admin || envAdmins.has(e);
  const token = signSession({ id:row.id, email:row.email, name:row.display_name, color:row.color, is_admin });
  appendCookies(res,[sessionCookie(req,token)]);
  return res.json({ ok:true, user:{ id:row.id, email:row.email, name:row.display_name, color:row.color, is_admin, isAdmin:is_admin }});
}

// --- me ---
async function handleMe(req,res){
  if (req.method !== 'GET') return res.status(405).json({ error:'GET only' });
  const payload=verifyRequestAuth(req);
  if (!payload) return res.status(401).json({ error:'authentication required' });
  try{
    const db = getClient();
    try{ await db.execute(`ALTER TABLE auth_accounts ADD COLUMN is_available INTEGER DEFAULT 1`);}catch{}
    try{ await db.execute(`ALTER TABLE auth_accounts ADD COLUMN availability_updated_at TEXT`);}catch{}
    try{ await db.execute(`ALTER TABLE auth_accounts ADD COLUMN is_admin INTEGER DEFAULT 0`);}catch{}
    const id = payload.id || payload.uid;
    if (!id) return res.status(401).json({ error:'invalid token payload' });
    const rs = await db.execute({ sql:`SELECT id,email,display_name,color,created_at,last_login,is_available,availability_updated_at,is_admin FROM auth_accounts WHERE id=?`, args:[id] });
    if (!rs.rows.length) return res.status(401).json({ error:'user not found' });
    const u = rs.rows[0];
    const is_available = u.is_available===null||u.is_available===undefined ? 1 : (u.is_available?1:0);
    const is_admin_db = !!u.is_admin;
    const envAdmins = getAdminEmails();
    const is_admin_env = envAdmins.has(String(u.email).toLowerCase());
    const is_admin = is_admin_db || is_admin_env;
    if (is_admin_env && !is_admin_db){
      try{ await db.execute({ sql:`UPDATE auth_accounts SET is_admin=1 WHERE id=?`, args:[u.id]});}catch{}
    }
    return res.json({ ok:true, user:{ id:u.id, email:u.email, name:u.display_name, color:u.color, created_at:u.created_at, last_login:u.last_login, is_available: !!is_available, isAvailable: !!is_available, availability_updated_at:u.availability_updated_at, is_admin, isAdmin:is_admin, is_admin_db, is_admin_env }});
  }catch(e){
    return res.status(401).json({ error:'invalid session' });
  }
}

function handleLogout(req,res){
  if(req.method!=='POST') return res.status(405).json({error:'POST only'});
  appendCookies(res,[clearCookie(req,SESSION_COOKIE)]);
  return res.json({ok:true});
}

// --- google start ---
function handleGoogleStart(req,res){
  if (req.method !== 'GET') return res.status(405).json({ error:'GET only' });
  const clientId = process.env.GOOGLE_CLIENT_ID;
  if (!clientId) return res.status(500).json({ error:'Missing GOOGLE_CLIENT_ID env', hint:'Set GOOGLE_CLIENT_ID in Vercel Env Vars'});
  const appUrl = (process.env.APP_URL || 'https://randori-circle-self.vercel.app').replace(/\/$/,'');
  const redirectUri = `${appUrl}/api/auth/google/callback`;
  const state = randomBytes(32).toString('base64url');
  const verifier=randomBytes(48).toString('base64url');
  const challenge=createHash('sha256').update(verifier).digest('base64url');
  const params = new URLSearchParams({ client_id:clientId, redirect_uri:redirectUri, response_type:'code', scope:'openid email profile', access_type:'online', state, code_challenge:challenge, code_challenge_method:'S256' });
  const url = `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;
  appendCookies(res,[transientCookie(req,OAUTH_STATE_COOKIE,state),transientCookie(req,OAUTH_VERIFIER_COOKIE,verifier)]);
  res.writeHead(302, { Location:url });
  res.end();
}

// --- google callback ---
async function handleGoogleCallback(req,res){
  const appUrl = (process.env.APP_URL || 'https://randori-circle-self.vercel.app').replace(/\/$/,'');
  const redirectUri = `${appUrl}/api/auth/google/callback`;
  const { code, error, state } = req.query || {};
  const expectedState=cookieValue(req,OAUTH_STATE_COOKIE);
  const verifier=cookieValue(req,OAUTH_VERIFIER_COOKIE);
  appendCookies(res,[clearCookie(req,OAUTH_STATE_COOKIE,'/api/auth/google'),clearCookie(req,OAUTH_VERIFIER_COOKIE,'/api/auth/google')]);
  if (error){ res.writeHead(302, { Location:`${appUrl}/?google_error=${encodeURIComponent(error)}`}); return res.end(); }
  if (!code){ res.writeHead(302, { Location:`${appUrl}/?google_error=missing_code`}); return res.end(); }
  if(!state || !expectedState || !verifier || !constantTimeEqual(state,expectedState)){
    res.writeHead(302,{Location:`${appUrl}/?google_error=invalid_state`}); return res.end();
  }
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  if (!clientId || !clientSecret) return res.status(500).json({ error:'Missing GOOGLE_CLIENT_ID or GOOGLE_CLIENT_SECRET' });
  let tokenJson;
  try{
    const body = new URLSearchParams({ client_id:clientId, client_secret:clientSecret, code:String(code), code_verifier:verifier, redirect_uri:redirectUri, grant_type:'authorization_code' });
    const r = await fetchWithTimeout('https://oauth2.googleapis.com/token',{ method:'POST', headers:{'content-type':'application/x-www-form-urlencoded'}, body:body.toString() });
    const text = await r.text();
    try{ tokenJson = JSON.parse(text); }catch{ tokenJson = { error:text, status:r.status }; }
    if (!r.ok){ res.writeHead(302,{ Location:`${appUrl}/?google_error=token_exchange_failed`}); return res.end(); }
  }catch{ res.writeHead(302,{ Location:`${appUrl}/?google_error=exception`}); return res.end(); }
  const { access_token } = tokenJson;
  let email=null, displayName=null, googleSub=null, emailVerified=false;
  if (access_token){
    try{
      const ur = await fetchWithTimeout('https://openidconnect.googleapis.com/v1/userinfo',{ headers:{ Authorization:`Bearer ${access_token}` }});
      if (ur.ok){ const uj=await ur.json(); email=uj.email||null; displayName=uj.name||null; googleSub=uj.sub||null; emailVerified=uj.email_verified===true; }
    }catch{}
  }
  if (!email || !googleSub || !emailVerified){ res.writeHead(302,{ Location:`${appUrl}/?google_error=unverified_google_identity`}); return res.end(); }
  email = String(email).trim().toLowerCase();
  const nameFromEmail = email.split('@')[0].slice(0,32);
  const finalName = (displayName ? String(displayName).trim().slice(0,32) : nameFromEmail) || nameFromEmail;
  const db = getClient();
  try{
    await db.execute(`CREATE TABLE IF NOT EXISTS auth_accounts (id INTEGER PRIMARY KEY AUTOINCREMENT, email TEXT UNIQUE NOT NULL, password_hash TEXT NOT NULL, display_name TEXT NOT NULL, color TEXT NOT NULL, created_at TEXT DEFAULT (datetime('now')), last_login TEXT, is_available INTEGER DEFAULT 1, availability_updated_at TEXT, is_admin INTEGER DEFAULT 0)`);
    await db.execute(`CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, color TEXT NOT NULL, created_at TEXT DEFAULT (datetime('now')))`);
    try{ await db.execute(`ALTER TABLE auth_accounts ADD COLUMN is_available INTEGER DEFAULT 1`);}catch{}
    try{ await db.execute(`ALTER TABLE auth_accounts ADD COLUMN availability_updated_at TEXT`);}catch{}
    try{ await db.execute(`ALTER TABLE auth_accounts ADD COLUMN is_admin INTEGER DEFAULT 0`);}catch{}
    try{ await db.execute(`ALTER TABLE auth_accounts ADD COLUMN google_sub TEXT`);}catch{}
  }catch{}
  const color = deterministicColor(finalName.toLowerCase());
  let authId, is_admin_final=false;
  try{
    const existing = await db.execute({ sql:"SELECT id, is_admin, password_hash, google_sub FROM auth_accounts WHERE email = ?", args:[email] });
    if (existing.rows.length){
      const account=existing.rows[0];
      if(account.google_sub && account.google_sub!==googleSub){
        res.writeHead(302,{Location:`${appUrl}/?google_error=identity_mismatch`}); return res.end();
      }
      if(!account.google_sub && String(account.password_hash||'').startsWith('$2')){
        res.writeHead(302,{Location:`${appUrl}/?google_error=account_exists_use_password`}); return res.end();
      }
      authId = existing.rows[0].id;
      is_admin_final = !!existing.rows[0].is_admin || getAdminEmails().has(email);
      await db.execute({ sql:"UPDATE auth_accounts SET last_login = datetime('now'), display_name = COALESCE(?, display_name), is_admin = ?, google_sub = ? WHERE id = ?", args:[finalName, is_admin_final?1:0, googleSub, authId]});
    } else {
      if(!registrationAllowed(email)){
        res.writeHead(302,{Location:`${appUrl}/?google_error=private_beta`}); return res.end();
      }
      is_admin_final = getAdminEmails().has(email);
      const ins = await db.execute({ sql:"INSERT INTO auth_accounts (email, password_hash, display_name, color, last_login, is_available, is_admin, google_sub) VALUES (?, ?, ?, ?, datetime('now'), 1, ?, ?) RETURNING id", args:[email,`!oauth:${randomBytes(24).toString('base64url')}`,finalName,color, is_admin_final?1:0,googleSub]});
      authId = ins.rows[0].id;
    }
    const uExist = await db.execute({ sql:"SELECT id FROM users WHERE lower(name)=?", args:[finalName.toLowerCase()] });
    if (!uExist.rows.length) await db.execute({ sql:"INSERT INTO users (name, color) VALUES (?,?)", args:[finalName,color]});
  }catch(e){ res.writeHead(302,{ Location:`${appUrl}/?google_error=db_error`}); return res.end(); }
  let ourJwt;
  try{ ourJwt = signSession({ uid:authId, id:authId, email, name:finalName, is_admin:is_admin_final }); }catch{ res.writeHead(302,{ Location:`${appUrl}/?google_error=jwt_error`}); return res.end(); }
  appendCookies(res,[sessionCookie(req,ourJwt)]);
  const dest = `${appUrl}/?google=success`;
  res.writeHead(302, { Location:dest });
  res.end();
}

export default async function handler(req,res){
  const ep = getEndpoint(req);
  if(!verifyMutationOrigin(req)) return res.status(403).json({error:'cross-origin mutation rejected'});
  if(req.method==='POST' && ['signup','login','logout'].some(name=>ep===name || ep.includes(name)) && !verifyAuthMutationOrigin(req)){
    return res.status(403).json({error:'same-origin request required'});
  }
  // also detect google via path that contains google
  const urlPath = (req.url||'').toLowerCase();
  if (ep.includes('google')) {
    if (ep.includes('callback') || urlPath.includes('callback')) return handleGoogleCallback(req,res);
    return handleGoogleStart(req,res);
  }
  if (ep.includes('start')) return handleGoogleStart(req,res);
  if (ep.includes('callback')) return handleGoogleCallback(req,res);
  if (ep === 'signup' || ep.includes('signup')) return handleSignup(req,res);
  if (ep === 'login' || ep.includes('login')) return handleLogin(req,res);
  if (ep === 'me' || ep.includes('me')) return handleMe(req,res);
  if (ep === 'logout' || ep.includes('logout')) return handleLogout(req,res);
  // fallback try to infer from original path: /api/auth/google/start etc
  if (urlPath.includes('/google/start')) return handleGoogleStart(req,res);
  if (urlPath.includes('/google/callback') || urlPath.includes('google-callback')) return handleGoogleCallback(req,res);
  if (urlPath.includes('signup')) return handleSignup(req,res);
  if (urlPath.includes('login')) return handleLogin(req,res);
  if (urlPath.includes('logout')) return handleLogout(req,res);
  if (urlPath.includes('/me')) return handleMe(req,res);
  return res.status(404).json({ error:`unknown auth endpoint '${ep}'`, available:['signup','login','logout','me','google/start','google/callback'], hint:'endpoint query param ?endpoint=signup etc' });
}
