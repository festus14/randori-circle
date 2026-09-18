import {
  getClient,
  getJwtSecret,
  deterministicColor,
  getAdminEmails,
  issueSession,
  issueSessionInTransaction,
  revokeAccountSessions,
  revokeRequestSession,
  verifyMutationOrigin,
  verifyRequestAuth,
  verifySignedRequestAuth,
} from './_db.js';
import bcrypt from 'bcryptjs';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { parseCanonicalRoomPath } from './_pairing.js';
import {
  INVITE_CLAIM_COOKIE,
  acceptPreparedInvitation,
  circleMembershipRegistrationState,
  circleMembershipEnabled,
  clearInviteClaimCookie,
  createGoogleAccountFromPreparedInvitation,
  createPasswordAccountFromPreparedInvitation,
  ensureCircleMembershipReadiness,
  hasActivePrimaryCircleMembership,
  readInviteClaim,
  validatePreparedInvitation,
} from './_circle-membership.js';
import { localIdentityAdapterEnabled, localRuntimeRequest } from './_local-runtime.js';
import { googleOAuthRequestConfiguration, setAuthResponseHeaders } from './_auth-config.js';
import {
  GOOGLE_AUTHORIZATION_ENDPOINT,
  exchangeGoogleAuthorizationCode,
  publicGoogleAuthorizationError,
  publicGoogleErrorCode,
} from './_google-oidc.js';

const SESSION_COOKIE = 'randori_session';
const OAUTH_STATE_COOKIE = 'randori_oauth_state';
const OAUTH_VERIFIER_COOKIE = 'randori_oauth_verifier';
const OAUTH_NONCE_COOKIE = 'randori_oauth_nonce';
const OAUTH_RETURN_COOKIE = 'randori_oauth_return';
const PASSWORD_MIN_BYTES = 10;
const PASSWORD_MAX_BYTES = 72;
const DUMMY_LOGIN_PASSWORD_HASH = '$2a$10$PBpMY4NLVseWPP6G9VtPveLltge4ovpON5/cJwqL8JU.khDEvJ9De';

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

function safeOAuthReturnPath(value){
  return parseCanonicalRoomPath(value)?.path || '/';
}

function oauthResultLocation(appUrl, returnPath, key, value){
  const query=new URLSearchParams({[key]:String(value)});
  return `${appUrl}${safeOAuthReturnPath(returnPath)}?${query.toString()}`;
}

export function validSignupPassword(value){
  if(typeof value!=='string') return false;
  const bytes=Buffer.byteLength(value,'utf8');
  return bytes>=PASSWORD_MIN_BYTES&&bytes<=PASSWORD_MAX_BYTES;
}

async function enforceAuthRateLimit(db, req, action, email){
  const forwarded=String(req.headers?.['x-forwarded-for']||'').split(',')[0].trim();
  const ip=forwarded || String(req.socket?.remoteAddress||'unknown');
  const windowSeconds=15*60;
  const bucket=Math.floor(Date.now()/1000/windowSeconds);
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

/**
 * Password registration is deliberately a local-development capability, not
 * a general non-production escape hatch. Keep this predicate shared by the
 * discovery endpoint and the mutation so the UI can never advertise more
 * authority than the server will enforce.
 */
export function localPasswordSignupEnabled(req){
  if(localIdentityAdapterEnabled(req)) return true;
  return localRuntimeRequest(req)
    &&process.env.ALLOW_OPEN_SIGNUP==='true'
    &&process.env.CIRCLE_MEMBERSHIP_ENABLED!=='true';
}

function handleCapabilities(req,res){
  if(req.method!=='GET') return res.status(405).json({error:'GET only'});
  const passwordSignup=localPasswordSignupEnabled(req);
  const localIdentity=localIdentityAdapterEnabled(req);
  return res.json({
    ok:true,
    capabilities:{
      passwordLogin:true,
      passwordSignup,
      localIdentity,
      googleOAuth:Boolean(googleOAuthRequestConfiguration(req)),
    },
    registrationMode:localIdentity?'local_invite':(passwordSignup?'local_open':'private_beta'),
  });
}

function localFirstUserAdminEnabled(){
  if(process.env.NODE_ENV!=='development'||process.env.RANDORI_LOCAL_RUNTIME!=='true'
    ||process.env.RANDORI_LOCAL_FIRST_USER_ADMIN!=='true'||process.env.TURSO_AUTH_TOKEN) return false;
  try{
    const databaseUrl=new URL(process.env.TURSO_DATABASE_URL||'');
    return databaseUrl.protocol==='file:'&&!databaseUrl.host;
  }catch{
    return false;
  }
}

async function bootstrapGoogleAuthSchema(db){
  if(process.env.AUTH_SCHEMA_BOOTSTRAP_ENABLED!=='true') return;
  await db.execute(`CREATE TABLE IF NOT EXISTS auth_accounts (id INTEGER PRIMARY KEY AUTOINCREMENT, email TEXT UNIQUE NOT NULL, password_hash TEXT NOT NULL, display_name TEXT NOT NULL, color TEXT NOT NULL, created_at TEXT DEFAULT (datetime('now')), last_login TEXT, is_available INTEGER DEFAULT 1, availability_updated_at TEXT, is_admin INTEGER DEFAULT 0, google_sub TEXT)`);
  await db.execute(`CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, color TEXT NOT NULL, created_at TEXT DEFAULT (datetime('now')))`);
  for(const sql of [
    `ALTER TABLE auth_accounts ADD COLUMN is_available INTEGER DEFAULT 1`,
    `ALTER TABLE auth_accounts ADD COLUMN availability_updated_at TEXT`,
    `ALTER TABLE auth_accounts ADD COLUMN is_admin INTEGER DEFAULT 0`,
    `ALTER TABLE auth_accounts ADD COLUMN google_sub TEXT`,
  ]){
    try{ await db.execute(sql); }catch{}
  }
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
  if(!localPasswordSignupEnabled(req)){
    return res.status(503).json({error:'password signup is disabled during the private beta; use Google sign-in'});
  }
  const { email, password, name } = req.body || {};
  if (!email || !password || !name) return res.status(400).json({ error: 'email,password,name required' });
  if(!validSignupPassword(password)) return res.status(400).json({error:'password must be 10-72 UTF-8 bytes'});
  const e = String(email).trim().toLowerCase();
  if (e.length>254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)) return res.status(400).json({ error: 'invalid email' });
  const display = String(name).trim().slice(0,32);
  if(display.length<2) return res.status(400).json({ error:'display name must be 2-32 chars' });
  const membershipRequired=circleMembershipEnabled();
  if(membershipRequired){
    if(!localIdentityAdapterEnabled(req)){
      return res.status(403).json({error:'private beta signup requires a Google invitation'});
    }
    const inviteClaim=readInviteClaim(req);
    if(!inviteClaim) return res.status(403).json({error:'a valid local invitation is required'});
    const db=getClient();
    try{ await ensureCircleMembershipReadiness(db); }
    catch{ return res.status(503).json({error:'signup temporarily unavailable'}); }
    try{ await enforceAuthRateLimit(db,req,'signup',e); }
    catch(err){
      if(err?.statusCode===429) return res.status(429).json({error:'too many signup attempts; try again later'});
      return res.status(503).json({error:'signup temporarily unavailable'});
    }
    const color=deterministicColor(display.toLowerCase());
    const hash=await bcrypt.hash(password,10);
    let preparedInvitation;
    try{ preparedInvitation=await validatePreparedInvitation(db,{claim:inviteClaim,email:e}); }
    catch{ return res.status(503).json({error:'signup temporarily unavailable'}); }
    if(!preparedInvitation?.ok||preparedInvitation.used_by!==null){
      return res.status(403).json({error:'invitation unavailable or does not match this email'});
    }
    let registered;
    try{
      registered=await createPasswordAccountFromPreparedInvitation(db,{
        claim:inviteClaim,email:e,passwordHash:hash,displayName:display,color,isAdmin:false,
      });
    }catch{
      return res.status(503).json({error:'signup temporarily unavailable'});
    }
    if(!registered?.ok){
      return res.status(403).json({error:'invitation unavailable or does not match this email'});
    }
    let token;
    try{ token=await issueSession(db,{id:registered.user_id,email:e,name:display,color,is_admin:false}); }
    catch{ return res.status(503).json({error:'signup temporarily unavailable'}); }
    appendCookies(res,[sessionCookie(req,token),clearInviteClaimCookie({secure:false})]);
    return res.json({
      ok:true,
      user:{id:registered.user_id,email:e,name:display,color,is_admin:false,isAdmin:false},
    });
  }
  if(!registrationAllowed(e)) return res.status(403).json({error:'private beta signup is invite-only'});
  const db = getClient();
  let registrationState;
  try{
    registrationState=await circleMembershipRegistrationState(db);
    if(registrationState==='closed'){
      return res.status(403).json({error:'private beta signup requires a Google invitation'});
    }
  }catch{
    return res.status(503).json({error:'signup temporarily unavailable'});
  }
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
  const configuredAdmin = getAdminEmails().has(e) ? 1 : 0;
  const localFirstUserAdmin=localFirstUserAdminEnabled()?1:0;
  const registrationGuard=registrationState==='uninitialized'
    ? `NOT EXISTS (SELECT 1 FROM sqlite_schema WHERE type='table' AND name='circle_membership_rollout')`
    : `EXISTS (SELECT 1 FROM circle_membership_rollout WHERE id=1 AND registrations_closed=0)`;
  const ins = await db.execute({
    sql:`INSERT INTO auth_accounts (email,password_hash,display_name,color,last_login,is_available,is_admin)
      SELECT ?,?,?,?,datetime('now'),1,
        CASE WHEN ?=1 OR (?=1 AND NOT EXISTS (SELECT 1 FROM auth_accounts)) THEN 1 ELSE 0 END
      WHERE ${registrationGuard}
      RETURNING id,is_admin`,
    args:[e,hash,display,color,configuredAdmin,localFirstUserAdmin],
  });
  if(!ins.rows?.length) return res.status(403).json({error:'private beta signup requires a Google invitation'});
  const authId = ins.rows[0].id;
  const isAdmin=ins.rows[0].is_admin===undefined?!!configuredAdmin:!!ins.rows[0].is_admin;
  try{ await db.execute({ sql:`INSERT INTO users (name,color) VALUES (?,?)`, args:[display,color]});}catch{}
  let token;
  try{ token=await issueSession(db,{id:authId,email:e,name:display,color,is_admin:!!isAdmin}); }
  catch{ return res.status(503).json({error:'signup temporarily unavailable'}); }
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
  if(localIdentityAdapterEnabled(req)){
    try{ await ensureCircleMembershipReadiness(db); }
    catch{ return res.status(503).json({error:'login temporarily unavailable'}); }
  }else{
    await db.execute(`CREATE TABLE IF NOT EXISTS auth_accounts (id INTEGER PRIMARY KEY AUTOINCREMENT, email TEXT UNIQUE NOT NULL, password_hash TEXT NOT NULL, display_name TEXT NOT NULL, color TEXT NOT NULL, created_at TEXT DEFAULT (datetime('now')), last_login TEXT, is_available INTEGER DEFAULT 1, availability_updated_at TEXT, is_admin INTEGER DEFAULT 0)`);
    try{ await db.execute(`ALTER TABLE auth_accounts ADD COLUMN is_available INTEGER DEFAULT 1`);}catch{}
    try{ await db.execute(`ALTER TABLE auth_accounts ADD COLUMN availability_updated_at TEXT`);}catch{}
    try{ await db.execute(`ALTER TABLE auth_accounts ADD COLUMN is_admin INTEGER DEFAULT 0`);}catch{}
  }
  try{ await enforceAuthRateLimit(db,req,'login',e); }catch(err){
    if(err?.statusCode===429) return res.status(429).json({error:'too many login attempts; try again later'});
    return res.status(503).json({error:'login temporarily unavailable'});
  }
  const rs = await db.execute({ sql:`SELECT id,email,password_hash,display_name,color,is_admin FROM auth_accounts WHERE email=?`, args:[e] });
  const row=rs.rows[0]||null;
  const storedPasswordHash=String(row?.password_hash||'');
  const passwordBytes=Buffer.byteLength(String(password),'utf8');
  const passwordWithinPolicy=passwordBytes>=PASSWORD_MIN_BYTES&&passwordBytes<=PASSWORD_MAX_BYTES;
  const comparableHash=storedPasswordHash.startsWith('$2')?storedPasswordHash:DUMMY_LOGIN_PASSWORD_HASH;
  const passwordMatches=await bcrypt.compare(String(password),comparableHash);
  if(!row||!passwordWithinPolicy||!storedPasswordHash.startsWith('$2')||!passwordMatches){
    return res.status(401).json({error:'invalid credentials'});
  }
  if(circleMembershipEnabled()){
    try{
      if(!await hasActivePrimaryCircleMembership(db,row.id)) return res.status(403).json({error:'active circle membership required'});
    }catch{
      return res.status(503).json({error:'login temporarily unavailable'});
    }
  }
  await db.execute({ sql:`UPDATE auth_accounts SET last_login=datetime('now') WHERE id=?`, args:[row.id]}).catch(()=>{});
  const envAdmins = getAdminEmails();
  if (envAdmins.has(e) && !row.is_admin){
    try{ await db.execute({ sql:`UPDATE auth_accounts SET is_admin=1 WHERE id=?`, args:[row.id]}); row.is_admin=1; }catch{}
  }
  const is_admin = !!row.is_admin || envAdmins.has(e);
  let token;
  try{ token=await issueSession(db,{id:row.id,email:row.email,name:row.display_name,color:row.color,is_admin}); }
  catch{ return res.status(503).json({error:'login temporarily unavailable'}); }
  appendCookies(res,[sessionCookie(req,token)]);
  return res.json({ ok:true, user:{ id:row.id, email:row.email, name:row.display_name, color:row.color, is_admin, isAdmin:is_admin }});
}

// --- me ---
async function handleMe(req,res){
  if (req.method !== 'GET') return res.status(405).json({ error:'GET only' });
  let payload;
  try{ payload=await verifyRequestAuth(req); }
  catch{ return res.status(503).json({error:'session validation temporarily unavailable'}); }
  if (!payload) return res.status(401).json({ error:'authentication required' });
  const localIdentity=localIdentityAdapterEnabled(req);
  try{
    const db = getClient();
    if(localIdentity){
      try{ await ensureCircleMembershipReadiness(db); }
      catch{ return res.status(503).json({error:'session validation temporarily unavailable'}); }
    }
    else{
      try{ await db.execute(`ALTER TABLE auth_accounts ADD COLUMN is_available INTEGER DEFAULT 1`);}catch{}
      try{ await db.execute(`ALTER TABLE auth_accounts ADD COLUMN availability_updated_at TEXT`);}catch{}
      try{ await db.execute(`ALTER TABLE auth_accounts ADD COLUMN is_admin INTEGER DEFAULT 0`);}catch{}
    }
    const id = payload.id || payload.uid;
    if (!id) return res.status(401).json({ error:'invalid token payload' });
    const rs = await db.execute({ sql:`SELECT id,email,display_name,color,created_at,last_login,is_available,availability_updated_at,is_admin FROM auth_accounts WHERE id=?`, args:[id] });
    if (!rs.rows.length) return res.status(401).json({ error:'user not found' });
    const u = rs.rows[0];
    if(circleMembershipEnabled()){
      let hasMembership;
      try{ hasMembership=await hasActivePrimaryCircleMembership(db,u.id); }
      catch{ return res.status(503).json({error:'session validation temporarily unavailable'}); }
      if(!hasMembership){
        appendCookies(res,[clearCookie(req,SESSION_COOKIE)]);
        return res.status(403).json({error:'active circle membership required'});
      }
    }
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

async function handleLogout(req,res){
  if(req.method!=='POST') return res.status(405).json({error:'POST only'});
  if(verifySignedRequestAuth(req)){
    try{ await revokeRequestSession(getClient(),req); }
    catch{ return res.status(503).json({error:'logout temporarily unavailable'}); }
  }
  appendCookies(res,[clearCookie(req,SESSION_COOKIE)]);
  return res.json({ok:true});
}

async function handleLogoutAll(req,res){
  if(req.method!=='POST') return res.status(405).json({error:'POST only'});
  let db,payload;
  try{
    db=getClient();
    payload=await verifyRequestAuth(req,db);
  }catch{ return res.status(503).json({error:'logout temporarily unavailable'}); }
  if(!payload){
    appendCookies(res,[clearCookie(req,SESSION_COOKIE)]);
    return res.status(401).json({error:'authentication required'});
  }
  try{ await revokeAccountSessions(db,payload.id,'logout_all'); }
  catch{ return res.status(503).json({error:'logout temporarily unavailable'}); }
  appendCookies(res,[clearCookie(req,SESSION_COOKIE)]);
  return res.json({ok:true});
}

async function bindGoogleProviderIdentity(db,{issuer,subject,userId}){
  const inserted=await db.execute({
    sql:`INSERT INTO auth_provider_identities (issuer,subject,user_id,created_at,last_login)
      SELECT ?,?,?,datetime('now'),datetime('now')
      FROM auth_accounts WHERE id=? AND google_sub=?
      ON CONFLICT DO NOTHING RETURNING user_id`,
    args:[issuer,subject,userId,userId,subject],
  });
  if(inserted.rows?.length===1) return Number(inserted.rows[0].user_id)===Number(userId);
  const existing=await db.execute({
    sql:`UPDATE auth_provider_identities SET last_login=datetime('now')
      WHERE issuer=? AND subject=? AND user_id=? RETURNING user_id`,
    args:[issuer,subject,userId],
  });
  return existing.rows?.length===1&&Number(existing.rows[0].user_id)===Number(userId);
}

// --- google start ---
function handleGoogleStart(req,res){
  if (req.method !== 'GET') return res.status(405).json({ error:'GET only' });
  const configuration=googleOAuthRequestConfiguration(req);
  if(!configuration) return res.status(503).json({error:'Google sign-in is unavailable'});
  const {appOrigin:appUrl,clientId,redirectUri}=configuration;
  const state = randomBytes(32).toString('base64url');
  const verifier=randomBytes(48).toString('base64url');
  const nonce=randomBytes(32).toString('base64url');
  const challenge=createHash('sha256').update(verifier).digest('base64url');
  const returnPath=safeOAuthReturnPath(req.query?.return_to);
  const params = new URLSearchParams({ client_id:clientId, redirect_uri:redirectUri, response_type:'code', scope:'openid email profile', access_type:'online', state, nonce, code_challenge:challenge, code_challenge_method:'S256' });
  if(circleMembershipEnabled()&&readInviteClaim(req)) params.set('prompt','select_account');
  const url = `${GOOGLE_AUTHORIZATION_ENDPOINT}?${params.toString()}`;
  appendCookies(res,[
    transientCookie(req,OAUTH_STATE_COOKIE,state),
    transientCookie(req,OAUTH_VERIFIER_COOKIE,verifier),
    transientCookie(req,OAUTH_NONCE_COOKIE,nonce),
    transientCookie(req,OAUTH_RETURN_COOKIE,returnPath),
  ]);
  res.writeHead(302, { Location:url });
  res.end();
}

// --- google callback ---
async function handleGoogleCallback(req,res){
  if(req.method!=='GET') return res.status(405).json({error:'GET only'});
  const configuration=googleOAuthRequestConfiguration(req);
  if(!configuration) return res.status(503).json({error:'Google sign-in is unavailable'});
  const {appOrigin:appUrl,clientId,clientSecret,redirectUri}=configuration;
  const { code, error, state } = req.query || {};
  const expectedState=cookieValue(req,OAUTH_STATE_COOKIE);
  const verifier=cookieValue(req,OAUTH_VERIFIER_COOKIE);
  const nonce=cookieValue(req,OAUTH_NONCE_COOKIE);
  const returnPath=safeOAuthReturnPath(cookieValue(req,OAUTH_RETURN_COOKIE));
  const inviteClaimPresent=Boolean(cookieValue(req,INVITE_CLAIM_COOKIE));
  const inviteClaim=readInviteClaim(req);
  const redirectError=errorCode=>oauthResultLocation(appUrl,returnPath,'google_error',errorCode);
  appendCookies(res,[
    clearCookie(req,OAUTH_STATE_COOKIE,'/api/auth/google'),
    clearCookie(req,OAUTH_VERIFIER_COOKIE,'/api/auth/google'),
    clearCookie(req,OAUTH_NONCE_COOKIE,'/api/auth/google'),
    clearCookie(req,OAUTH_RETURN_COOKIE,'/api/auth/google'),
  ]);
  if(!state || !expectedState || !verifier || !nonce || !constantTimeEqual(state,expectedState)){
    res.writeHead(302,{Location:redirectError('invalid_state')}); return res.end();
  }
  if (error){ res.writeHead(302, { Location:redirectError(publicGoogleAuthorizationError(error))}); return res.end(); }
  if (!code){ res.writeHead(302, { Location:redirectError('missing_code')}); return res.end(); }
  const db=getClient();
  try{
    // Migration v4 owns provider identities. Probe it read-only before using a
    // one-time authorization code or mutating any legacy account state.
    await db.execute(`SELECT issuer,subject,user_id FROM auth_provider_identities WHERE 0=1`);
  }catch{
    res.writeHead(302,{Location:redirectError('db_error')}); return res.end();
  }
  let identity;
  try{
    identity=await exchangeGoogleAuthorizationCode({
      clientId,clientSecret,redirectUri,code:String(code),codeVerifier:verifier,nonce,
    });
  }catch(providerError){
    res.writeHead(302,{Location:redirectError(publicGoogleErrorCode(providerError))}); return res.end();
  }
  const email=identity.email;
  const displayName=identity.name;
  const googleIssuer=identity.issuer;
  const googleSub=identity.subject;
  const nameFromEmail = email.split('@')[0].slice(0,32);
  const finalName = (displayName ? String(displayName).trim().slice(0,32) : nameFromEmail) || nameFromEmail;
  const color = deterministicColor(finalName.toLowerCase());
  const membershipRequired=circleMembershipEnabled();
  if(!membershipRequired&&process.env.AUTH_SCHEMA_BOOTSTRAP_ENABLED==='true'){
    try{ await bootstrapGoogleAuthSchema(db); }
    catch{ res.writeHead(302,{Location:redirectError('db_error')}); return res.end(); }
  }
  let registrationState=membershipRequired?'closed':null;
  if(!membershipRequired){
    try{ registrationState=await circleMembershipRegistrationState(db); }
    catch{ res.writeHead(302,{Location:redirectError('db_error')}); return res.end(); }
  }
  let preparedInvitation={ok:false};
  if(membershipRequired && inviteClaim){
    try{ preparedInvitation=await validatePreparedInvitation(db,{claim:inviteClaim,email}); }
    catch{ res.writeHead(302,{Location:redirectError('db_error')}); return res.end(); }
  }
  let authId,is_admin_final=false,invitationAcceptedDuringAccountCreation=false;
  let identityEmailChange=null;
  try{
    const existing = await db.execute({ sql:"SELECT id, email, is_admin, password_hash, google_sub FROM auth_accounts WHERE email = ?", args:[email] });
    if (existing.rows.length){
      const account=existing.rows[0];
      if(account.google_sub!==googleSub){
        const errorCode=account.google_sub?'identity_mismatch':'account_exists_use_password';
        res.writeHead(302,{Location:redirectError(errorCode)}); return res.end();
      }
      authId = account.id;
      is_admin_final = !!account.is_admin || getAdminEmails().has(email);
      const refreshed=await db.execute({
        sql:"UPDATE auth_accounts SET last_login = datetime('now'), display_name = COALESCE(?, display_name), is_admin = ? WHERE id = ? AND google_sub = ? RETURNING id",
        args:[finalName,is_admin_final?1:0,authId,googleSub],
      });
      if(refreshed.rows?.length!==1){
        res.writeHead(302,{Location:redirectError('identity_mismatch')}); return res.end();
      }
    } else {
      let existingIdentity=await db.execute({
        sql:`SELECT account.id,account.email,account.is_admin
          FROM auth_provider_identities identity JOIN auth_accounts account ON account.id=identity.user_id
          WHERE identity.issuer=? AND identity.subject=? LIMIT 1`,
        args:[googleIssuer,googleSub],
      });
      if(!existingIdentity.rows?.length){
        existingIdentity=await db.execute({
          sql:"SELECT id,email,is_admin FROM auth_accounts WHERE google_sub=? LIMIT 1",
          args:[googleSub],
        });
      }
      if(existingIdentity.rows?.length){
        const account=existingIdentity.rows[0];
        authId=account.id;
        is_admin_final=!!account.is_admin||getAdminEmails().has(email);
        if(String(account.email).toLowerCase()!==email){
          identityEmailChange={previousEmail:String(account.email).toLowerCase()};
        }else{
          const changed=await db.execute({
            sql:"UPDATE auth_accounts SET last_login=datetime('now'),display_name=COALESCE(?,display_name),is_admin=? WHERE id=? AND google_sub=? AND lower(email)=? RETURNING id",
            args:[finalName,is_admin_final?1:0,authId,googleSub,email],
          });
          if(changed.rows?.length!==1){
            res.writeHead(302,{Location:redirectError('identity_mismatch')}); return res.end();
          }
        }
      }else{
        const invitationMayRegister=membershipRequired&&preparedInvitation?.ok&&preparedInvitation.used_by===null;
        const legacyMayRegister=!membershipRequired&&registrationState!=='closed'&&registrationAllowed(email);
        if(!invitationMayRegister&&!legacyMayRegister){
          if(inviteClaimPresent) appendCookies(res,[clearInviteClaimCookie()]);
          res.writeHead(302,{Location:redirectError('private_beta')}); return res.end();
        }
        is_admin_final = getAdminEmails().has(email);
        const passwordHash=`!oauth:${randomBytes(24).toString('base64url')}`;
        if(membershipRequired){
          const registered=await createGoogleAccountFromPreparedInvitation(db,{
            claim:inviteClaim,email,passwordHash,displayName:finalName,color,
            isAdmin:is_admin_final,googleIssuer,googleSub,
          });
          if(!registered?.ok){
            if(inviteClaimPresent) appendCookies(res,[clearInviteClaimCookie()]);
            res.writeHead(302,{Location:redirectError('private_beta')}); return res.end();
          }
          authId=registered.user_id;
          is_admin_final=registered.is_admin;
          invitationAcceptedDuringAccountCreation=true;
        }else{
          const registrationGuard=registrationState==='uninitialized'
            ? `NOT EXISTS (SELECT 1 FROM sqlite_schema WHERE type='table' AND name='circle_membership_rollout')`
            : `EXISTS (SELECT 1 FROM circle_membership_rollout WHERE id=1 AND registrations_closed=0)`;
          const ins=await db.execute({
            sql:`INSERT INTO auth_accounts (email,password_hash,display_name,color,last_login,is_available,is_admin,google_sub)
              SELECT ?,?,?,?,datetime('now'),1,?,?
              WHERE ${registrationGuard}
              RETURNING id`,
            args:[email,passwordHash,finalName,color,is_admin_final?1:0,googleSub],
          });
          if(!ins.rows?.length){
            res.writeHead(302,{Location:redirectError('private_beta')}); return res.end();
          }
          authId=ins.rows[0].id;
        }
      }
    }
    const identityBound=await bindGoogleProviderIdentity(db,{
      issuer:googleIssuer,subject:googleSub,userId:authId,
    });
    if(!identityBound){
      res.writeHead(302,{Location:redirectError('identity_mismatch')}); return res.end();
    }
    if(!membershipRequired){
      const uExist = await db.execute({ sql:"SELECT id FROM users WHERE lower(name)=?", args:[finalName.toLowerCase()] });
      if (!uExist.rows.length) await db.execute({ sql:"INSERT INTO users (name, color) VALUES (?,?)", args:[finalName,color]});
    }
  }catch(e){ res.writeHead(302,{ Location:redirectError('db_error')}); return res.end(); }
  if(membershipRequired){
    let hasMembership=invitationAcceptedDuringAccountCreation;
    if(!hasMembership){
      try{ hasMembership=await hasActivePrimaryCircleMembership(db,authId); }
      catch{ res.writeHead(302,{Location:redirectError('db_error')}); return res.end(); }
    }
    if(preparedInvitation?.ok&&!invitationAcceptedDuringAccountCreation){
      let accepted;
      try{ accepted=await acceptPreparedInvitation(db,{claim:inviteClaim,email,userId:authId}); }
      catch{ res.writeHead(302,{Location:redirectError('db_error')}); return res.end(); }
      hasMembership=hasMembership||accepted?.ok===true;
    }
    if(!hasMembership){
      if(inviteClaimPresent) appendCookies(res,[clearInviteClaimCookie()]);
      res.writeHead(302,{Location:redirectError('private_beta')}); return res.end();
    }
  }
  let ourJwt;
  if(identityEmailChange){
    let transaction,committed=false;
    try{
      transaction=await db.transaction('write');
      const changed=await transaction.execute({
        sql:`UPDATE auth_accounts SET email=?,last_login=datetime('now'),display_name=COALESCE(?,display_name),is_admin=?
          WHERE id=? AND google_sub=? AND lower(email)=? RETURNING id`,
        args:[email,finalName,is_admin_final?1:0,authId,googleSub,identityEmailChange.previousEmail],
      });
      if(changed.rows?.length!==1) throw new Error('identity changed concurrently');
      await revokeAccountSessions(transaction,authId,'identity_change');
      ourJwt=await issueSessionInTransaction(transaction,{uid:authId,id:authId,email,name:finalName,is_admin:is_admin_final});
      await transaction.commit();
      committed=true;
    }catch{
      if(transaction&&!committed){ try{ await transaction.rollback(); }catch{} }
      res.writeHead(302,{Location:redirectError('session_error')}); return res.end();
    }
  }else{
    try{ ourJwt=await issueSession(db,{uid:authId,id:authId,email,name:finalName,is_admin:is_admin_final}); }
    catch{ res.writeHead(302,{Location:redirectError('session_error')}); return res.end(); }
  }
  appendCookies(res,[sessionCookie(req,ourJwt),...(inviteClaimPresent?[clearInviteClaimCookie()]:[])]);
  const dest = oauthResultLocation(appUrl,returnPath,'google','success');
  res.writeHead(302, { Location:dest });
  res.end();
}

export default async function handler(req,res){
  setAuthResponseHeaders(res);
  const ep = getEndpoint(req);
  if(!verifyMutationOrigin(req)) return res.status(403).json({error:'cross-origin mutation rejected'});
  const logoutMutation=ep==='logout'||ep==='logout-all'||ep.includes('logout');
  if(req.method==='POST'&&logoutMutation&&!verifyMutationOrigin(req)){
    return res.status(403).json({error:'same-origin request required'});
  }
  if(req.method==='POST'&&!logoutMutation&&['signup','login'].some(name=>ep===name || ep.includes(name))&&!verifyAuthMutationOrigin(req)){
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
  if (ep === 'capabilities' || ep.includes('capabilities')) return handleCapabilities(req,res);
  if (ep === 'signup' || ep.includes('signup')) return handleSignup(req,res);
  if (ep === 'login' || ep.includes('login')) return handleLogin(req,res);
  if (ep === 'me' || ep.includes('me')) return handleMe(req,res);
  if (ep === 'logout-all' || ep.includes('logout-all')) return handleLogoutAll(req,res);
  if (ep === 'logout' || ep.includes('logout')) return handleLogout(req,res);
  // fallback try to infer from original path: /api/auth/google/start etc
  if (urlPath.includes('/google/start')) return handleGoogleStart(req,res);
  if (urlPath.includes('/google/callback') || urlPath.includes('google-callback')) return handleGoogleCallback(req,res);
  if (urlPath.includes('/capabilities')) return handleCapabilities(req,res);
  if (urlPath.includes('signup')) return handleSignup(req,res);
  if (urlPath.includes('login')) return handleLogin(req,res);
  if (urlPath.includes('logout-all')) return handleLogoutAll(req,res);
  if (urlPath.includes('logout')) return handleLogout(req,res);
  if (urlPath.includes('/me')) return handleMe(req,res);
  return res.status(404).json({ error:`unknown auth endpoint '${ep}'`, available:['capabilities','signup','login','logout','logout-all','me','google/start','google/callback'], hint:'endpoint query param ?endpoint=signup etc' });
}
