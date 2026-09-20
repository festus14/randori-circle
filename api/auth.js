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
import { ensureAuthReadiness } from './_auth-readiness.js';
import bcrypt from 'bcryptjs';
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { parseCanonicalRoomPath } from './_pairing.js';
import {
  acceptPreparedInvitation,
  circleMembershipRegistrationState,
  circleMembershipEnabled,
  createGoogleAccountFromPreparedInvitation,
  createPasswordAccountFromPreparedInvitation,
  ensureCircleMembershipReadiness,
  hasActiveCircleMembership,
  hasActivePrimaryCircleMembership,
  readBoundInviteClaim,
  readInviteClaimForBindingHash,
  validateLivePreparedClaim,
  validatePreparedInvitation,
} from './_circle-membership.js';
import {
  multiCircleAvailabilityEnabled,
  multiCircleControlPlaneEnabled,
  secondaryCircleCoordinationEnabled,
  secondaryCircleSchedulingEnabled,
} from './_active-circle.js';
import { localIdentityAdapterEnabled, localRuntimeRequest } from './_local-runtime.js';
import { googleOAuthRequestConfiguration, setAuthResponseHeaders } from './_auth-config.js';
import {
  GOOGLE_AUTHORIZATION_ENDPOINT,
  GOOGLE_REAUTH_MAX_AGE_SECONDS,
  exchangeGoogleAuthorizationCode,
  publicGoogleAuthorizationError,
  publicGoogleErrorCode,
} from './_google-oidc.js';
import {
  emailActivationConfiguration,
  ensureEmailActivationReadiness,
  requestEmailActivation,
  resendEmailActivation,
  verifyEmailActivation,
} from './_email-activation.js';
import {
  consumePasswordReset,
  ensurePasswordResetReadiness,
  passwordResetConfiguration,
  requestPasswordReset,
} from './_password-reset.js';
import { readRecentAuth, recordRecentAuth, requireRecentAuth } from './_recent-auth.js';
import {
  GOOGLE_ISSUER,
  addPasswordCredential,
  ensureIdentityLinkingReadiness,
  identityEmailHashConfigured,
  linkGoogleCredential,
  observeGoogleProviderEmail,
  readIdentityState,
  unlinkGoogleCredential,
  unlinkPasswordCredential,
} from './_identity-linking.js';

function hasEligibleCircleMembership(db,userId){
  return multiCircleControlPlaneEnabled()
    ?hasActiveCircleMembership(db,userId)
    :hasActivePrimaryCircleMembership(db,userId);
}

const SESSION_COOKIE = 'randori_session';
const OAUTH_TRANSACTION_COOKIE_PREFIX='randori_oauth_tx_';
const OAUTH_TRANSACTION_VERSION=1;
const OAUTH_TRANSACTION_TTL_SECONDS=10*60;
const PASSWORD_MIN_BYTES = 10;
const PASSWORD_MAX_BYTES = 72;
const ACTIVATION_RESPONSE_FLOOR_MS = 350;
const DUMMY_LOGIN_PASSWORD_HASH = '$2a$10$PBpMY4NLVseWPP6G9VtPveLltge4ovpON5/cJwqL8JU.khDEvJ9De';
const INVITE_BINDING_PATTERN=/^[A-Za-z0-9_-]{43}$/;

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

function clearCookie(req, name, path='/'){
  return `${name}=; Path=${path}; HttpOnly; SameSite=Lax; Max-Age=0${cookieSecurity(req)}`;
}

function constantTimeEqual(a,b){
  const left=Buffer.from(String(a||''));
  const right=Buffer.from(String(b||''));
  return left.length===right.length && timingSafeEqual(left,right);
}

function oauthTransactionCookieName(state){
  if(typeof state!=='string'||!/^[A-Za-z0-9_-]{8,128}$/.test(state)) return null;
  const suffix=createHash('sha256').update(`randori-google-oauth-state-cookie-v1\0${state}`,'utf8').digest('base64url');
  return `${OAUTH_TRANSACTION_COOKIE_PREFIX}${suffix}`;
}

function oauthTransactionSignature(payload){
  return createHmac('sha256',getJwtSecret())
    .update(`randori-google-oauth-transaction-v1\0${payload}`,'utf8')
    .digest('base64url');
}

function validOAuthPurpose(value){
  return value==='login'||/^invite:[a-f0-9]{64}$/.test(value)
    ||/^(?:link|reauth):[1-9]\d*:[a-f0-9]{64}$/.test(value);
}

function createOAuthTransaction({state,verifier,nonce,returnPath,purpose}){
  if(!oauthTransactionCookieName(state)||typeof verifier!=='string'||!/^[A-Za-z0-9_-]{43,128}$/.test(verifier)
    ||typeof nonce!=='string'||!/^[A-Za-z0-9_-]{8,128}$/.test(nonce)||!validOAuthPurpose(purpose)){
    throw new TypeError('invalid OAuth transaction');
  }
  const issuedAt=Math.floor(Date.now()/1000);
  const payload=Buffer.from(JSON.stringify({v:OAUTH_TRANSACTION_VERSION,state,verifier,nonce,
    return_path:safeOAuthReturnPath(returnPath,{allowInvite:purpose.startsWith('invite:')}),purpose,iat:issuedAt,
    exp:issuedAt+OAUTH_TRANSACTION_TTL_SECONDS}),'utf8').toString('base64url');
  return `${payload}.${oauthTransactionSignature(payload)}`;
}

function readOAuthTransaction(req,state){
  const name=oauthTransactionCookieName(state);
  if(!name) return null;
  const raw=cookieValue(req,name);
  const match=raw.match(/^([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]{43})$/);
  if(!match||!constantTimeEqual(match[2],oauthTransactionSignature(match[1]))) return null;
  let value;
  try{ value=JSON.parse(Buffer.from(match[1],'base64url').toString('utf8')); }catch{ return null; }
  if(!value||typeof value!=='object'||Array.isArray(value)) return null;
  const keys=Object.keys(value).sort();
  const expected=['exp','iat','nonce','purpose','return_path','state','v','verifier'];
  const now=Math.floor(Date.now()/1000);
  if(keys.length!==expected.length||!keys.every((key,index)=>key===expected[index])
    ||value.v!==OAUTH_TRANSACTION_VERSION||!constantTimeEqual(value.state,state)
    ||typeof value.verifier!=='string'||!/^[A-Za-z0-9_-]{43,128}$/.test(value.verifier)
    ||typeof value.nonce!=='string'||!/^[A-Za-z0-9_-]{8,128}$/.test(value.nonce)
    ||safeOAuthReturnPath(value.return_path,{allowInvite:value.purpose.startsWith('invite:')})!==value.return_path
    ||!validOAuthPurpose(value.purpose)
    ||!Number.isSafeInteger(value.iat)||!Number.isSafeInteger(value.exp)
    ||value.iat>now+30||value.exp<=now||value.exp-value.iat!==OAUTH_TRANSACTION_TTL_SECONDS){
    return null;
  }
  return value;
}

function oauthTransactionCookie(req,state,transaction){
  const name=oauthTransactionCookieName(state);
  if(!name) throw new TypeError('invalid OAuth state');
  return `${name}=${encodeURIComponent(transaction)}; Path=/api/auth/google/callback; HttpOnly; SameSite=Lax; Max-Age=${OAUTH_TRANSACTION_TTL_SECONDS}${cookieSecurity(req)}`;
}

function clearOAuthTransactionCookie(req,state){
  const name=oauthTransactionCookieName(state);
  return name?`${name}=; Path=/api/auth/google/callback; HttpOnly; SameSite=Lax; Max-Age=0${cookieSecurity(req)}`:null;
}

function exactObject(value,keys){
  return !!value&&typeof value==='object'&&!Array.isArray(value)
    &&Object.keys(value).length===keys.length
    &&keys.every(key=>Object.prototype.hasOwnProperty.call(value,key));
}

function requestInviteBinding(req){
  const value=req?.body?.invite_binding;
  return typeof value==='string'&&INVITE_BINDING_PATTERN.test(value)?value:null;
}

function boundInviteClaim(req,binding=requestInviteBinding(req)){
  return binding?readBoundInviteClaim(req,binding):null;
}

function safeOAuthReturnPath(value,{allowInvite=false}={}){
  if(allowInvite&&value==='/invite') return '/invite';
  return parseCanonicalRoomPath(value)?.path || '/';
}

function oauthResultLocation(appUrl,returnPath,key,value,{allowInvite=false}={}){
  const query=new URLSearchParams({[key]:String(value)});
  return `${appUrl}${safeOAuthReturnPath(returnPath,{allowInvite})}?${query.toString()}`;
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
    :(['activation-verify','password-reset-consume'].includes(action)
      ?[[`ip:${ip}`,20]]
      :(action==='password-reset-request'
        ?[[`ip:${ip}`,10],[`email:${email}`,5]]
      :(['recent-auth-password','recent-auth-google'].includes(action)
        ?[[`ip:${ip}`,10],[`account:${email}`,10]]
      :(action==='identity-mutation'
        ?[[`ip:${ip}`,10],[`account:${email}`,10]]
        :[[`ip:${ip}`,20],[`email:${email}`,10]]))));
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

async function completeActivationResponseFloor(startedAt){
  const remaining=ACTIVATION_RESPONSE_FLOOR_MS-(Date.now()-startedAt);
  if(remaining>0) await new Promise(resolve=>setTimeout(resolve,remaining));
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

function identityManagementRequested(req){
  return process.env.IDENTITY_MANAGEMENT_ENABLED==='true'||localRuntimeRequest(req);
}

function identityManagementEnabled(req){
  return identityManagementRequested(req)&&identityEmailHashConfigured();
}

async function handleCapabilities(req,res){
  if(req.method!=='GET') return res.status(405).json({error:'GET only'});
  const localIdentity=localIdentityAdapterEnabled(req);
  const activationConfigured=!localIdentity&&Boolean(emailActivationConfiguration());
  const resetConfigured=Boolean(passwordResetConfiguration());
  const identityConfigured=identityManagementEnabled(req);
  let verifiedEmailActivation=false,passwordReset=false,identityManagement=false;
  if(activationConfigured||resetConfigured||identityConfigured){
    let db;
    try{
      db=getClient();
      [verifiedEmailActivation,passwordReset,identityManagement]=await Promise.all([
        activationConfigured?ensureEmailActivationReadiness(db).then(()=>true,()=>false):false,
        resetConfigured?ensurePasswordResetReadiness(db).then(()=>true,()=>false):false,
        identityConfigured?ensureIdentityLinkingReadiness(db).then(()=>true,()=>false):false,
      ]);
    }catch{}
  }
  const passwordSignup=localPasswordSignupEnabled(req)||verifiedEmailActivation;
  const googleOAuth=Boolean(googleOAuthRequestConfiguration(req))
    &&(!identityManagementRequested(req)||identityManagement);
  return res.json({
    ok:true,
    capabilities:{
      passwordLogin:true,
      passwordSignup,
      verifiedEmailActivation,
      passwordReset,
      localIdentity,
      googleOAuth,
      recentAuthMaxAgeSeconds:10*60,
      identityManagement,
      ...(circleMembershipEnabled()&&process.env.MULTI_CIRCLE_CONTROL_PLANE_ENABLED==='true'
        ?{multiCircleControlPlane:true}:{}),
      ...(multiCircleAvailabilityEnabled()?{multiCircleAvailability:true}:{}),
      ...(secondaryCircleCoordinationEnabled()?{secondaryCircleCoordination:true}:{}),
      ...(secondaryCircleSchedulingEnabled()?{secondaryCircleScheduling:true}:{}),
    },
    registrationMode:localIdentity?'local_invite':(verifiedEmailActivation?'verified_invite':(passwordSignup?'local_open':'private_beta')),
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
  const localPasswordSignup=localPasswordSignupEnabled(req);
  const verifiedEmailActivation=!localIdentityAdapterEnabled(req)&&Boolean(emailActivationConfiguration());
  if(!localPasswordSignup&&!verifiedEmailActivation){
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
  if(verifiedEmailActivation){
    const inviteClaim=boundInviteClaim(req);
    const db=getClient();
    try{
      await ensureAuthReadiness(db);
      await ensureCircleMembershipReadiness(db);
      await ensureEmailActivationReadiness(db);
      await enforceAuthRateLimit(db,req,'signup',e);
    }catch(err){
      if(err?.statusCode===429) return res.status(429).json({error:'too many activation requests; try again later'});
      return res.status(503).json({error:'signup temporarily unavailable'});
    }
    // Always perform the password work before evaluating invitation/account
    // state so a request cannot use response timing to enumerate identities.
    const responseStartedAt=Date.now();
    const color=deterministicColor(display.toLowerCase());
    const hash=await bcrypt.hash(password,10);
    let activationFailed=false;
    try{
      await requestEmailActivation(db,{claim:inviteClaim,email:e,passwordHash:hash,displayName:display,color});
    }catch{ activationFailed=true; }
    await completeActivationResponseFloor(responseStartedAt);
    if(activationFailed) return res.status(503).json({error:'signup temporarily unavailable'});
    return res.status(202).json({
      ok:true,pending:true,
      message:'If this invitation can be activated, a verification email will arrive shortly.',
    });
  }
  if(membershipRequired){
    if(!localIdentityAdapterEnabled(req)){
      return res.status(403).json({error:'private beta signup requires a Google invitation'});
    }
    const inviteClaim=boundInviteClaim(req);
    if(!inviteClaim){
      return res.status(403).json({error:'a valid local invitation is required'});
    }
    const db=getClient();
    try{
      await ensureAuthReadiness(db);
      await ensureCircleMembershipReadiness(db);
    }
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
    try{ token=await issueSession(db,{id:registered.user_id,email:e,name:display,color,is_admin:false},
      {recentAuthMethod:'password'}); }
    catch{ return res.status(503).json({error:'signup temporarily unavailable'}); }
    appendCookies(res,[sessionCookie(req,token)]);
    return res.json({
      ok:true,
      user:{id:registered.user_id,email:e,name:display,color,is_admin:false,isAdmin:false},
    });
  }
  if(!registrationAllowed(e)) return res.status(403).json({error:'private beta signup is invite-only'});
  const db = getClient();
  let registrationState;
  try{
    await ensureAuthReadiness(db);
    registrationState=await circleMembershipRegistrationState(db);
    if(registrationState==='closed'){
      return res.status(403).json({error:'private beta signup requires a Google invitation'});
    }
  }catch{
    return res.status(503).json({error:'signup temporarily unavailable'});
  }
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
  try{ token=await issueSession(db,{id:authId,email:e,name:display,color,is_admin:!!isAdmin},
    {recentAuthMethod:'password'}); }
  catch{ return res.status(503).json({error:'signup temporarily unavailable'}); }
  appendCookies(res,[sessionCookie(req,token)]);
  return res.json({ ok:true, user:{ id:authId, email:e, name:display, color, is_admin: !!isAdmin, isAdmin: !!isAdmin }});
}

async function handleActivationResend(req,res){
  if(req.method!=='POST') return res.status(405).json({error:'POST only'});
  if(!emailActivationConfiguration()) return res.status(503).json({error:'email activation is unavailable'});
  const email=String(req.body?.email||'').trim().toLowerCase();
  if(!email||email.length>254||!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)){
    return res.status(400).json({error:'valid email required'});
  }
  const db=getClient();
  const responseStartedAt=Date.now();
  let activationFailed=null;
  const inviteClaim=boundInviteClaim(req);
  try{
    await ensureAuthReadiness(db);
    await ensureEmailActivationReadiness(db);
    await enforceAuthRateLimit(db,req,'signup',email);
    await resendEmailActivation(db,{claim:inviteClaim,email});
  }catch(error){ activationFailed=error; }
  await completeActivationResponseFloor(responseStartedAt);
  if(activationFailed?.statusCode===429) return res.status(429).json({error:'too many activation requests; try again later'});
  if(activationFailed) return res.status(503).json({error:'email activation temporarily unavailable'});
  return res.status(202).json({
    ok:true,pending:true,
    message:'If a pending activation exists, a new verification email will arrive shortly.',
  });
}

async function handleActivationVerify(req,res){
  if(req.method!=='POST') return res.status(405).json({error:'POST only'});
  if(!emailActivationConfiguration()) return res.status(503).json({error:'email activation is unavailable'});
  const token=String(req.body?.token||'');
  let result;
  try{
    const db=getClient();
    await ensureAuthReadiness(db);
    await ensureEmailActivationReadiness(db);
    await enforceAuthRateLimit(db,req,'activation-verify','');
    result=await verifyEmailActivation(db,{token});
  }catch(error){
    if(error?.statusCode===429) return res.status(429).json({error:'too many verification attempts; try again later'});
    return res.status(503).json({error:'email activation temporarily unavailable'});
  }
  if(result.status!=='verified') return res.status(409).json({ok:false,status:result.status});
  appendCookies(res,[sessionCookie(req,result.sessionToken)]);
  return res.json({ok:true,status:'verified',user:result.user});
}

async function handlePasswordResetRequest(req,res){
  if(req.method!=='POST') return res.status(405).json({error:'POST only'});
  if(!passwordResetConfiguration()) return res.status(503).json({error:'password reset is unavailable'});
  const email=String(req.body?.email||'').trim().toLowerCase();
  if(!email||email.length>254||!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)){
    return res.status(400).json({error:'valid email required'});
  }
  const responseStartedAt=Date.now();
  let failure=null;
  try{
    const db=getClient();
    await ensureAuthReadiness(db);
    await ensurePasswordResetReadiness(db);
    await enforceAuthRateLimit(db,req,'password-reset-request',email);
    await requestPasswordReset(db,{email});
  }catch(error){ failure=error; }
  await completeActivationResponseFloor(responseStartedAt);
  if(failure?.statusCode===429) return res.status(429).json({error:'too many reset requests; try again later'});
  if(failure) return res.status(503).json({error:'password reset temporarily unavailable'});
  return res.status(202).json({ok:true,pending:true,
    message:'If that account can use password recovery, a reset email will arrive shortly.'});
}

async function handlePasswordResetConsume(req,res){
  if(req.method!=='POST') return res.status(405).json({error:'POST only'});
  if(!passwordResetConfiguration()) return res.status(503).json({error:'password reset is unavailable'});
  const token=String(req.body?.token||'');
  const password=req.body?.password;
  if(!validSignupPassword(password)) return res.status(400).json({error:'password must be 10-72 UTF-8 bytes'});
  let db;
  try{
    db=getClient();
    await ensureAuthReadiness(db);
    await ensurePasswordResetReadiness(db);
    await enforceAuthRateLimit(db,req,'password-reset-consume','');
  }catch(error){
    if(error?.statusCode===429) return res.status(429).json({error:'too many reset attempts; try again later'});
    return res.status(503).json({error:'password reset temporarily unavailable'});
  }
  // Rate-limit before the expensive hash, but always hash before token lookup
  // so valid-looking credentials do not expose account state through timing.
  const passwordHash=await bcrypt.hash(password,10);
  let result;
  try{ result=await consumePasswordReset(db,{token,passwordHash}); }
  catch{ return res.status(503).json({error:'password reset temporarily unavailable'}); }
  if(result.status!=='reset') return res.status(409).json({ok:false,status:result.status});
  appendCookies(res,[clearCookie(req,SESSION_COOKIE)]);
  return res.json({ok:true,status:'reset'});
}

async function handleRecentAuth(req,res){
  if(req.method!=='GET'&&req.method!=='POST') return res.status(405).json({error:'GET or POST only'});
  let db,payload;
  try{
    db=getClient();
    await ensureAuthReadiness(db);
    await ensurePasswordResetReadiness(db,{requireDeliveryKey:false});
    payload=await verifyRequestAuth(req,db);
  }catch{ return res.status(503).json({error:'recent authentication temporarily unavailable'}); }
  if(!payload) return res.status(401).json({error:'authentication required'});
  if(req.method==='GET'){
    try{
      const methodsResult=await db.execute({
        sql:`SELECT account.password_hash,
            EXISTS (SELECT 1 FROM auth_provider_identities identity
              WHERE identity.user_id=account.id AND identity.issuer=?) AS google_linked
          FROM auth_accounts account WHERE account.id=? LIMIT 2`,
        args:[GOOGLE_ISSUER,payload.id],
      });
      if(methodsResult.rows?.length!==1) return res.status(401).json({error:'authentication required'});
      const row=methodsResult.rows[0];
      return res.json({
        ok:true,
        recentAuth:await readRecentAuth(db,payload),
        methods:{
          password:String(row.password_hash||'').startsWith('$2'),
          google:Boolean(row.google_linked)&&Boolean(googleOAuthRequestConfiguration(req)),
        },
      });
    }
    catch{ return res.status(503).json({error:'recent authentication temporarily unavailable'}); }
  }
  const password=req.body?.password;
  const passwordBytes=Buffer.byteLength(String(password||''),'utf8');
  if(passwordBytes<1||passwordBytes>PASSWORD_MAX_BYTES) return res.status(400).json({error:'password required'});
  try{ await enforceAuthRateLimit(db,req,'recent-auth-password',String(payload.id)); }
  catch(error){
    if(error?.statusCode===429) return res.status(429).json({error:'too many confirmation attempts; try again later'});
    return res.status(503).json({error:'recent authentication temporarily unavailable'});
  }
  let row;
  try{
    const result=await db.execute({sql:`SELECT password_hash FROM auth_accounts WHERE id=? LIMIT 2`,args:[payload.id]});
    row=result.rows?.length===1?result.rows[0]:null;
  }catch{ return res.status(503).json({error:'recent authentication temporarily unavailable'}); }
  const stored=String(row?.password_hash||'');
  const matches=await bcrypt.compare(String(password),stored.startsWith('$2')?stored:DUMMY_LOGIN_PASSWORD_HASH);
  if(!row||!stored.startsWith('$2')||!matches) return res.status(401).json({error:'invalid credentials'});
  try{
    const recent=await recordRecentAuth(db,{sessionHash:payload.sessionHash,userId:payload.id,method:'password'});
    return res.json({ok:true,recentAuth:{ok:true,...recent}});
  }catch{ return res.status(503).json({error:'recent authentication temporarily unavailable'}); }
}

async function identityRequestContext(req){
  if(!identityManagementEnabled(req)){
    const error=new Error('identity management unavailable');
    error.statusCode=503;
    throw error;
  }
  const db=getClient();
  await ensureAuthReadiness(db);
  await ensureIdentityLinkingReadiness(db);
  const payload=await verifyRequestAuth(req,db);
  if(!payload){
    const error=new Error('authentication required');
    error.statusCode=401;
    throw error;
  }
  return {db,payload};
}

function identityFailure(res,error){
  if(error?.statusCode===401) return res.status(401).json({error:'authentication required'});
  if(error?.statusCode===403||error?.code==='RECENT_AUTH_REQUIRED'){
    return res.status(403).json({error:'recent authentication required',code:'recent_auth_required'});
  }
  if(error?.statusCode===429) return res.status(429).json({error:'too many identity changes; try again later'});
  return res.status(503).json({error:'identity management temporarily unavailable'});
}

async function handleIdentityState(req,res){
  if(req.method!=='GET') return res.status(405).json({error:'GET only'});
  try{
    const {db,payload}=await identityRequestContext(req);
    return res.json({ok:true,identity:await readIdentityState(db,payload)});
  }catch(error){ return identityFailure(res,error); }
}

async function handlePasswordIdentity(req,res){
  if(req.method!=='POST') return res.status(405).json({error:'POST only'});
  const action=String(req.body?.action||'');
  if(!['add','unlink'].includes(action)) return res.status(400).json({error:'action must be add or unlink'});
  let db,payload;
  try{
    ({db,payload}=await identityRequestContext(req));
    await requireRecentAuth(db,payload);
    await enforceAuthRateLimit(db,req,'identity-mutation',String(payload.id));
  }catch(error){ return identityFailure(res,error); }
  try{
    let result;
    if(action==='add'){
      if(!validSignupPassword(req.body?.password)){
        return res.status(400).json({error:'password must be 10-72 UTF-8 bytes'});
      }
      const passwordHash=await bcrypt.hash(req.body.password,10);
      result=await addPasswordCredential(db,payload,{passwordHash});
    }else{
      result=await unlinkPasswordCredential(db,payload);
    }
    if(result.status==='final_credential'){
      return res.status(409).json({ok:false,status:result.status,
        error:'link another sign-in method before removing your password'});
    }
    if(result.status==='verified_control_required'){
      return res.status(403).json({ok:false,status:result.status,
        error:'confirm your linked Google account before adding a password'});
    }
    return res.json({ok:true,status:result.status,identity:await readIdentityState(db,payload)});
  }catch(error){ return identityFailure(res,error); }
}

async function handleGoogleUnlink(req,res){
  if(req.method!=='POST') return res.status(405).json({error:'POST only'});
  if(String(req.body?.action||'')!=='unlink') return res.status(400).json({error:'action must be unlink'});
  let db,payload;
  try{
    ({db,payload}=await identityRequestContext(req));
    await requireRecentAuth(db,payload);
    await enforceAuthRateLimit(db,req,'identity-mutation',String(payload.id));
    const result=await unlinkGoogleCredential(db,payload);
    if(result.status==='final_credential'){
      return res.status(409).json({ok:false,status:result.status,
        error:'add a password before removing Google sign-in'});
    }
    return res.json({ok:true,status:result.status,identity:await readIdentityState(db,payload)});
  }catch(error){ return identityFailure(res,error); }
}

// --- login ---
async function handleLogin(req,res){
  if (req.method !== 'POST') return res.status(405).json({ error:'POST only' });
  const { email, password } = req.body || {};
  if (!email || !password) return res.status(400).json({ error:'email,password required' });
  const e = String(email).trim().toLowerCase();
  const db = getClient();
  try{
    await ensureAuthReadiness(db);
    if(localIdentityAdapterEnabled(req)) await ensureCircleMembershipReadiness(db);
  }catch{ return res.status(503).json({error:'login temporarily unavailable'}); }
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
      if(!await hasEligibleCircleMembership(db,row.id)) return res.status(403).json({error:'active circle membership required'});
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
  try{ token=await issueSession(db,{id:row.id,email:row.email,name:row.display_name,color:row.color,is_admin},
    {recentAuthMethod:'password'}); }
  catch{ return res.status(503).json({error:'login temporarily unavailable'}); }
  appendCookies(res,[sessionCookie(req,token)]);
  return res.json({ ok:true, user:{ id:row.id, email:row.email, name:row.display_name, color:row.color, is_admin, isAdmin:is_admin }});
}

// --- me ---
async function handleMe(req,res){
  if (req.method !== 'GET') return res.status(405).json({ error:'GET only' });
  let signedPayload;
  try{ signedPayload=verifySignedRequestAuth(req); }
  catch{ return res.status(503).json({error:'session validation temporarily unavailable'}); }
  if (!signedPayload) return res.status(401).json({ error:'authentication required' });
  const localIdentity=localIdentityAdapterEnabled(req);
  let db,payload;
  try{
    db=getClient();
    await ensureAuthReadiness(db);
    payload=await verifyRequestAuth(req,db);
  }catch{ return res.status(503).json({error:'session validation temporarily unavailable'}); }
  if(!payload) return res.status(401).json({error:'authentication required'});
  try{
    if(localIdentity){
      try{ await ensureCircleMembershipReadiness(db); }
      catch{ return res.status(503).json({error:'session validation temporarily unavailable'}); }
    }
    const id = payload.id || payload.uid;
    if (!id) return res.status(401).json({ error:'invalid token payload' });
    const rs = await db.execute({ sql:`SELECT id,email,display_name,color,created_at,last_login,is_available,availability_updated_at,is_admin FROM auth_accounts WHERE id=?`, args:[id] });
    if (!rs.rows.length) return res.status(401).json({ error:'user not found' });
    const u = rs.rows[0];
    if(circleMembershipEnabled()){
      let hasMembership;
      try{ hasMembership=await hasEligibleCircleMembership(db,u.id); }
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
    try{
      const db=getClient();
      await ensureAuthReadiness(db);
      await revokeRequestSession(db,req);
    }
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
    await ensureAuthReadiness(db);
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
async function handleGoogleStart(req,res){
  const endpoint=getEndpoint(req);
  const linking=endpoint.includes('link')||String(req.url||'').includes('/google/link/');
  const reauthenticate=!linking&&(String(req.query?.reauth||'')==='1'||endpoint.includes('reauth'));
  const ordinary=!linking&&!reauthenticate;
  const inviteStart=ordinary&&req.method==='POST';
  if(linking&&req.method!=='POST') return res.status(405).json({error:'POST only'});
  if(reauthenticate&&req.method!=='POST') return res.status(405).json({error:'POST only'});
  if(ordinary&&!['GET','POST'].includes(req.method)) return res.status(405).json({error:'GET or POST only'});
  if(reauthenticate){
    const body=req.body??{};
    if(!body||typeof body!=='object'||Array.isArray(body)||Object.keys(body).length){
      return res.status(400).json({error:'invalid request'});
    }
  }
  let inviteBinding=null;
  let inviteClaim=null;
  if(inviteStart){
    if(!circleMembershipEnabled()||!exactObject(req.body,['purpose','invite_binding'])||req.body.purpose!=='invite'
      ||!(inviteBinding=requestInviteBinding(req))){
      return res.status(403).json({error:'invitation unavailable'});
    }
    inviteClaim=boundInviteClaim(req,inviteBinding);
    if(!inviteClaim){
      return res.status(403).json({error:'invitation unavailable'});
    }
    try{
      const db=getClient();
      await ensureCircleMembershipReadiness(db);
      const live=await validateLivePreparedClaim(db,{claim:inviteClaim});
      if(!live.ok){
        return res.status(403).json({error:'invitation unavailable'});
      }
    }catch{
      return res.status(503).json({error:'Google sign-in is unavailable'});
    }
  }else if(ordinary&&String(req.query?.purpose||'login')!=='login'){
    return res.status(400).json({error:'invalid Google sign-in purpose'});
  }
  if(!reauthenticate&&identityManagementRequested(req)&&!identityManagementEnabled(req)){
    return res.status(503).json({error:'Google sign-in is unavailable'});
  }
  if(linking&&!identityManagementEnabled(req)){
    return res.status(503).json({error:'identity management temporarily unavailable'});
  }
  const configuration=googleOAuthRequestConfiguration(req);
  if(!configuration) return res.status(503).json({error:'Google sign-in is unavailable'});
  if(identityManagementRequested(req)&&!reauthenticate){
    try{
      const db=getClient();
      await ensureAuthReadiness(db);
      await ensureIdentityLinkingReadiness(db);
    }
    catch{ return res.status(503).json({error:'Google sign-in is unavailable'}); }
  }
  const {appOrigin:appUrl,clientId,redirectUri}=configuration;
  const state = randomBytes(32).toString('base64url');
  const verifier=randomBytes(48).toString('base64url');
  const nonce=randomBytes(32).toString('base64url');
  const challenge=createHash('sha256').update(verifier).digest('base64url');
  const returnPath=inviteStart?'/invite':safeOAuthReturnPath(req.query?.return_to);
  const params = new URLSearchParams({ client_id:clientId, redirect_uri:redirectUri, response_type:'code', scope:'openid email profile', access_type:'online', state, nonce, code_challenge:challenge, code_challenge_method:'S256' });
  let purpose=inviteStart?`invite:${inviteClaim.binding_hash}`:'login';
  if(linking){
    try{
      const db=getClient();
      await ensureAuthReadiness(db);
      await ensureIdentityLinkingReadiness(db);
      const current=await verifyRequestAuth(req,db);
      if(!current) return res.status(401).json({error:'authentication required'});
      await requireRecentAuth(db,current);
      await enforceAuthRateLimit(db,req,'identity-mutation',String(current.id));
      purpose=`link:${current.id}:${current.sessionHash}`;
    }catch(error){ return identityFailure(res,error); }
    params.set('max_age','0');
    params.set('prompt','select_account');
  }else if(reauthenticate){
    let current;
    try{
      const db=getClient();
      await ensureAuthReadiness(db);
      await ensurePasswordResetReadiness(db,{requireDeliveryKey:false});
      current=await verifyRequestAuth(req,db);
      if(current) await enforceAuthRateLimit(db,req,'recent-auth-google',String(current.id));
    }catch(error){
      if(error?.statusCode===429) return res.status(429).json({error:'too many confirmation attempts; try again later'});
      return res.status(503).json({error:'Google reauthentication is unavailable'});
    }
    if(!current) return res.status(401).json({error:'authentication required'});
    purpose=`reauth:${current.id}:${current.sessionHash}`;
    params.set('max_age','0');
    params.set('prompt','select_account');
  }
  if(inviteStart) params.set('prompt','select_account');
  const url = `${GOOGLE_AUTHORIZATION_ENDPOINT}?${params.toString()}`;
  const transaction=createOAuthTransaction({state,verifier,nonce,returnPath,purpose});
  appendCookies(res,[oauthTransactionCookie(req,state,transaction)]);
  if(linking||reauthenticate||inviteStart) return res.json({ok:true,authorizationUrl:url});
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
  const transaction=readOAuthTransaction(req,state);
  const expectedState=transaction?.state||'';
  const verifier=transaction?.verifier||'';
  const nonce=transaction?.nonce||'';
  const returnPath=transaction?.return_path||'/';
  const purpose=transaction?.purpose||'';
  const invitePurpose=/^invite:([a-f0-9]{64})$/.exec(purpose);
  const loginPurpose=purpose==='login';
  const inviteClaim=invitePurpose?readInviteClaimForBindingHash(req,invitePurpose[1]):null;
  const inviteReturnOptions={allowInvite:Boolean(invitePurpose)};
  const redirectError=errorCode=>oauthResultLocation(
    appUrl,returnPath,'google_error',errorCode,inviteReturnOptions);
  if(!state || !expectedState || !verifier || !nonce || !constantTimeEqual(state,expectedState)
    ||(!loginPurpose&&!invitePurpose&&!purpose.startsWith('link:')&&!purpose.startsWith('reauth:'))){
    res.writeHead(302,{Location:redirectError('invalid_state')}); return res.end();
  }
  appendCookies(res,[clearOAuthTransactionCookie(req,state)]);
  if (error){ res.writeHead(302, { Location:redirectError(publicGoogleAuthorizationError(error))}); return res.end(); }
  if (!code){ res.writeHead(302, { Location:redirectError('missing_code')}); return res.end(); }
  if(invitePurpose&&!inviteClaim){
    res.writeHead(302,{Location:redirectError('private_beta')}); return res.end();
  }
  const identityRequested=identityManagementRequested(req);
  const identityEnabled=identityManagementEnabled(req);
  const reauthenticate=purpose.startsWith('reauth:');
  if((purpose.startsWith('link:')&&!identityEnabled)
    ||(identityRequested&&!identityEnabled&&!reauthenticate)){
    const location=purpose.startsWith('link:')
      ?oauthResultLocation(appUrl,returnPath,'identity_link_error','unavailable')
      :redirectError('provider_unavailable');
    res.writeHead(302,{Location:location}); return res.end();
  }
  const db=getClient();
  try{
    await ensureAuthReadiness(db);
    if(circleMembershipEnabled()) await ensureCircleMembershipReadiness(db);
    // Normal sign-in and reauthentication retain their v4 compatibility.
    // The opt-in linking flow consumes a provider code only after the complete
    // v9 identity-management contract is known ready.
    if(reauthenticate) await ensurePasswordResetReadiness(db,{requireDeliveryKey:false});
    else if(identityRequested) await ensureIdentityLinkingReadiness(db);
    else await db.execute(`SELECT issuer,subject,user_id FROM auth_provider_identities WHERE 0=1`);
  }catch{
    res.writeHead(302,{Location:redirectError('db_error')}); return res.end();
  }
  let reauthSession=null;
  if(reauthenticate){
    const match=/^reauth:([1-9]\d*):([a-f0-9]{64})$/.exec(purpose);
    const initiatingId=match?Number(match[1]):null;
    const initiatingSessionHash=match?.[2]||'';
    try{ reauthSession=await verifyRequestAuth(req,db); }
    catch{ res.writeHead(302,{Location:redirectError('db_error')}); return res.end(); }
    if(!reauthSession||reauthSession.id!==initiatingId
      ||!constantTimeEqual(reauthSession.sessionHash,initiatingSessionHash)){
      res.writeHead(302,{Location:redirectError('reauth_required')}); return res.end();
    }
  }
  let identity;
  try{
    identity=await exchangeGoogleAuthorizationCode({
      clientId,clientSecret,redirectUri,code:String(code),codeVerifier:verifier,nonce,
      maxAuthAgeSeconds:purpose.startsWith('reauth:')||purpose.startsWith('link:')
        ?GOOGLE_REAUTH_MAX_AGE_SECONDS:null,
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
  if(purpose.startsWith('link:')){
    const match=/^link:([1-9]\d*):([a-f0-9]{64})$/.exec(purpose);
    const initiatingId=match?Number(match[1]):null;
    const initiatingSessionHash=match?.[2]||'';
    let current;
    try{
      await ensureIdentityLinkingReadiness(db);
      current=await verifyRequestAuth(req,db);
      if(!current||current.id!==initiatingId
        ||!constantTimeEqual(current.sessionHash,initiatingSessionHash)){
        res.writeHead(302,{Location:oauthResultLocation(appUrl,returnPath,'identity_link_error','session_changed')});
        return res.end();
      }
      await requireRecentAuth(db,current);
      const result=await linkGoogleCredential(db,current,{
        issuer:googleIssuer,subject:googleSub,providerEmail:email,
        providerAuthenticatedAt:identity.authTime,
      });
      if(!['linked','already_linked'].includes(result.status)){
        res.writeHead(302,{Location:oauthResultLocation(appUrl,returnPath,'identity_link_error',result.status)});
        return res.end();
      }
      res.writeHead(302,{Location:oauthResultLocation(appUrl,returnPath,'identity_link',result.status)});
      return res.end();
    }catch(linkError){
      const code=linkError?.code==='RECENT_AUTH_REQUIRED'?'recent_auth_required':'unavailable';
      res.writeHead(302,{Location:oauthResultLocation(appUrl,returnPath,'identity_link_error',code)});
      return res.end();
    }
  }
  if(purpose.startsWith('reauth:')){
    const match=/^reauth:([1-9]\d*):([a-f0-9]{64})$/.exec(purpose);
    const initiatingId=match?Number(match[1]):null;
    const initiatingSessionHash=match?.[2]||'';
    let current;
    try{ current=await verifyRequestAuth(req,db); }
    catch{ res.writeHead(302,{Location:redirectError('db_error')}); return res.end(); }
    if(!current||current.id!==initiatingId
      ||!constantTimeEqual(current.sessionHash,initiatingSessionHash)
      ||!constantTimeEqual(current.sessionHash,reauthSession?.sessionHash)){
      res.writeHead(302,{Location:redirectError('reauth_required')}); return res.end();
    }
    let matched;
    try{
      matched=await db.execute({
        sql:`SELECT account.id,account.email,account.display_name,account.color,account.is_admin
          FROM auth_provider_identities identity JOIN auth_accounts account ON account.id=identity.user_id
          WHERE identity.issuer=? AND identity.subject=? AND account.id=? LIMIT 2`,
        args:[googleIssuer,googleSub,initiatingId],
      });
    }catch{ res.writeHead(302,{Location:redirectError('db_error')}); return res.end(); }
    if(matched.rows?.length!==1){
      res.writeHead(302,{Location:redirectError('identity_mismatch')}); return res.end();
    }
    const account=matched.rows[0];
    let token;
    try{
      if(identityManagementEnabled(req)){
        await ensureIdentityLinkingReadiness(db);
        await observeGoogleProviderEmail(db,{
          issuer:googleIssuer,subject:googleSub,userId:initiatingId,providerEmail:email,
        });
      }
      token=await issueSession(db,{id:initiatingId,email:String(account.email),
        name:String(account.display_name),color:String(account.color),is_admin:!!account.is_admin},
      {recentAuthMethod:'google'});
    }catch{ res.writeHead(302,{Location:redirectError('session_error')}); return res.end(); }
    appendCookies(res,[sessionCookie(req,token)]);
    res.writeHead(302,{Location:oauthResultLocation(appUrl,returnPath,'google_reauth','success')});
    return res.end();
  }
  const membershipRequired=circleMembershipEnabled();
  let preparedInvitation={ok:false};
  if(membershipRequired&&invitePurpose&&inviteClaim){
    try{ preparedInvitation=await validatePreparedInvitation(db,{claim:inviteClaim,email}); }
    catch{ res.writeHead(302,{Location:redirectError('db_error')}); return res.end(); }
  }
  if(invitePurpose&&(!membershipRequired||!preparedInvitation?.ok)){
    res.writeHead(302,{Location:redirectError('private_beta')}); return res.end();
  }
  let authId,is_admin_final=false,invitationAcceptedDuringAccountCreation=false;
  let sessionEmail=email;
  let providerEmailChanged=false;
  let providerEmailObserved=false;
  try{
    const bySubject=await db.execute({
      sql:`SELECT account.id,account.email,account.is_admin,account.password_hash,account.google_sub
        FROM auth_provider_identities identity JOIN auth_accounts account ON account.id=identity.user_id
        WHERE identity.issuer=? AND identity.subject=? LIMIT 2`,
      args:[googleIssuer,googleSub],
    });
    if(bySubject.rows?.length===1){
      const account=bySubject.rows[0];
      authId=Number(account.id);
      sessionEmail=String(account.email).toLowerCase();
      is_admin_final=!!account.is_admin||getAdminEmails().has(sessionEmail);
      if(identityEnabled){
        const observation=await observeGoogleProviderEmail(db,{
          issuer:googleIssuer,subject:googleSub,userId:authId,providerEmail:email,
        });
        providerEmailChanged=observation.changed;
        providerEmailObserved=true;
      }
      const refreshed=await db.execute({
        sql:`UPDATE auth_accounts SET last_login=datetime('now'),display_name=COALESCE(?,display_name),
          is_admin=?,google_sub=COALESCE(google_sub,?)
          WHERE id=? AND (google_sub IS NULL OR google_sub=?) RETURNING id`,
        args:[finalName,is_admin_final?1:0,googleSub,authId,googleSub],
      });
      if(refreshed.rows?.length!==1){
        res.writeHead(302,{Location:redirectError('identity_mismatch')}); return res.end();
      }
    }else if(bySubject.rows?.length>1){
      res.writeHead(302,{Location:redirectError('identity_mismatch')}); return res.end();
    }else{
      const existingIdentity=await db.execute({
        sql:"SELECT id,email,is_admin,password_hash,google_sub FROM auth_accounts WHERE google_sub=? LIMIT 2",
        args:[googleSub],
      });
      if(existingIdentity.rows?.length===1){
        const account=existingIdentity.rows[0];
        authId=account.id;
        sessionEmail=String(account.email).toLowerCase();
        is_admin_final=!!account.is_admin||getAdminEmails().has(sessionEmail);
        const changed=await db.execute({
          sql:"UPDATE auth_accounts SET last_login=datetime('now'),display_name=COALESCE(?,display_name),is_admin=? WHERE id=? AND google_sub=? RETURNING id",
          args:[finalName,is_admin_final?1:0,authId,googleSub],
        });
        if(changed.rows?.length!==1){
          res.writeHead(302,{Location:redirectError('identity_mismatch')}); return res.end();
        }
      }else if(existingIdentity.rows?.length>1){
        res.writeHead(302,{Location:redirectError('identity_mismatch')}); return res.end();
      }else{
        const existing=await db.execute({
          sql:"SELECT id, email, is_admin, password_hash, google_sub FROM auth_accounts WHERE email = ?",
          args:[email],
        });
        if(existing.rows?.length){
          const account=existing.rows[0];
          const errorCode=account.google_sub?'identity_mismatch':'account_exists_use_password';
          res.writeHead(302,{Location:redirectError(errorCode)}); return res.end();
        }else{
          const invitationMayRegister=Boolean(invitePurpose)&&membershipRequired
            &&preparedInvitation?.ok&&preparedInvitation.used_by===null;
          if(!invitationMayRegister){
            res.writeHead(302,{Location:redirectError('private_beta')}); return res.end();
          }
          is_admin_final=getAdminEmails().has(email);
          const passwordHash=`!oauth:${randomBytes(24).toString('base64url')}`;
          if(membershipRequired){
            const registered=await createGoogleAccountFromPreparedInvitation(db,{
              claim:inviteClaim,email,passwordHash,displayName:finalName,color,
              isAdmin:is_admin_final,googleIssuer,googleSub,
            });
            if(!registered?.ok){
              res.writeHead(302,{Location:redirectError('private_beta')}); return res.end();
            }
            authId=registered.user_id;
            sessionEmail=email;
            is_admin_final=registered.is_admin;
            invitationAcceptedDuringAccountCreation=true;
          }
        }
      }
    }
    const identityBound=await bindGoogleProviderIdentity(db,{
      issuer:googleIssuer,subject:googleSub,userId:authId,
    });
    if(!identityBound){
      res.writeHead(302,{Location:redirectError('identity_mismatch')}); return res.end();
    }
    if(identityEnabled&&!providerEmailObserved){
      await ensureIdentityLinkingReadiness(db);
      const observation=await observeGoogleProviderEmail(db,{
        issuer:googleIssuer,subject:googleSub,userId:authId,providerEmail:email,
      });
      providerEmailChanged=observation.changed;
    }
    if(!membershipRequired){
      const uExist = await db.execute({ sql:"SELECT id FROM users WHERE lower(name)=?", args:[finalName.toLowerCase()] });
      if (!uExist.rows.length) await db.execute({ sql:"INSERT INTO users (name, color) VALUES (?,?)", args:[finalName,color]});
    }
  }catch(e){ res.writeHead(302,{ Location:redirectError('db_error')}); return res.end(); }
  if(membershipRequired){
    let hasMembership=invitationAcceptedDuringAccountCreation;
    if(!hasMembership&&!invitePurpose){
      try{ hasMembership=await hasEligibleCircleMembership(db,authId); }
      catch{ res.writeHead(302,{Location:redirectError('db_error')}); return res.end(); }
    }
    if(invitePurpose&&!invitationAcceptedDuringAccountCreation){
      if(preparedInvitation.used_by!==null&&Number(preparedInvitation.used_by)!==Number(authId)){
        res.writeHead(302,{Location:redirectError('private_beta')}); return res.end();
      }
      let accepted;
      try{ accepted=await acceptPreparedInvitation(db,{claim:inviteClaim,email,userId:authId}); }
      catch{ res.writeHead(302,{Location:redirectError('db_error')}); return res.end(); }
      hasMembership=accepted?.ok===true;
    }
    if(!hasMembership){
      res.writeHead(302,{Location:redirectError('private_beta')}); return res.end();
    }
  }
  let ourJwt;
  try{ ourJwt=await issueSession(db,{uid:authId,id:authId,email:sessionEmail,name:finalName,is_admin:is_admin_final},
    {recentAuthMethod:'google'}); }
  catch{ res.writeHead(302,{Location:redirectError('session_error')}); return res.end(); }
  appendCookies(res,[sessionCookie(req,ourJwt)]);
  const destination=new URL(oauthResultLocation(appUrl,returnPath,'google','success'));
  if(providerEmailChanged) destination.searchParams.set('identity_notice','provider_email_changed');
  const dest=destination.toString();
  res.writeHead(302, { Location:dest });
  res.end();
}

export default async function handler(req,res){
  setAuthResponseHeaders(res);
  const ep = getEndpoint(req);
  const urlPath = (req.url||'').toLowerCase();
  if(!verifyMutationOrigin(req)) return res.status(403).json({error:'cross-origin mutation rejected'});
  const logoutMutation=ep==='logout'||ep==='logout-all'||ep.includes('logout');
  if(req.method==='POST'&&logoutMutation&&!verifyMutationOrigin(req)){
    return res.status(403).json({error:'same-origin request required'});
  }
  const credentialMutation=['signup','login','activation-resend','activation-verify','password-reset-request',
    'password-reset-consume','recent-auth','identity-password','identity-google-unlink','google-link-start',
    'google-reauth-start','google-start']
    .some(name=>ep===name||ep.includes(name))
    ||urlPath.includes('/activation/resend')||urlPath.includes('/activation/verify')
    ||urlPath.includes('/password-reset/')||urlPath.includes('/recent-auth')
    ||urlPath.includes('/identities/password')||urlPath.includes('/identities/google')
    ||urlPath.includes('/google/start')||urlPath.includes('/google/link/start')
    ||urlPath.includes('/google/reauth/start');
  if(req.method==='POST'&&!logoutMutation&&credentialMutation&&!verifyAuthMutationOrigin(req)){
    return res.status(403).json({error:'same-origin request required'});
  }
  // also detect google via path that contains google
  if (ep.includes('google')) {
    if(ep.includes('unlink')||urlPath.includes('/identities/google')) return handleGoogleUnlink(req,res);
    if (ep.includes('callback') || urlPath.includes('callback')) return handleGoogleCallback(req,res);
    return await handleGoogleStart(req,res);
  }
  if (ep.includes('start')) return await handleGoogleStart(req,res);
  if (ep.includes('callback')) return handleGoogleCallback(req,res);
  if (ep === 'capabilities' || ep.includes('capabilities')) return handleCapabilities(req,res);
  if (ep === 'activation-resend' || ep.includes('activation-resend')) return handleActivationResend(req,res);
  if (ep === 'activation-verify' || ep.includes('activation-verify')) return handleActivationVerify(req,res);
  if (ep === 'password-reset-request' || ep.includes('password-reset-request')) return handlePasswordResetRequest(req,res);
  if (ep === 'password-reset-consume' || ep.includes('password-reset-consume')) return handlePasswordResetConsume(req,res);
  if (ep === 'recent-auth' || ep.includes('recent-auth')) return handleRecentAuth(req,res);
  if (ep === 'identities' || ep.includes('identities')) return handleIdentityState(req,res);
  if (ep === 'identity-password' || ep.includes('identity-password')) return handlePasswordIdentity(req,res);
  if (ep === 'signup' || ep.includes('signup')) return handleSignup(req,res);
  if (ep === 'login' || ep.includes('login')) return handleLogin(req,res);
  if (ep === 'me' || ep.includes('me')) return handleMe(req,res);
  if (ep === 'logout-all' || ep.includes('logout-all')) return handleLogoutAll(req,res);
  if (ep === 'logout' || ep.includes('logout')) return handleLogout(req,res);
  // fallback try to infer from original path: /api/auth/google/start etc
  if (urlPath.includes('/google/start')) return await handleGoogleStart(req,res);
  if (urlPath.includes('/google/callback') || urlPath.includes('google-callback')) return handleGoogleCallback(req,res);
  if (urlPath.includes('/capabilities')) return handleCapabilities(req,res);
  if (urlPath.includes('/activation/resend')) return handleActivationResend(req,res);
  if (urlPath.includes('/activation/verify')) return handleActivationVerify(req,res);
  if (urlPath.includes('/password-reset/request')) return handlePasswordResetRequest(req,res);
  if (urlPath.includes('/password-reset/consume')) return handlePasswordResetConsume(req,res);
  if (urlPath.includes('/recent-auth')) return handleRecentAuth(req,res);
  if (urlPath.endsWith('/identities')) return handleIdentityState(req,res);
  if (urlPath.includes('/identities/password')) return handlePasswordIdentity(req,res);
  if (urlPath.includes('/identities/google')) return handleGoogleUnlink(req,res);
  if (urlPath.includes('signup')) return handleSignup(req,res);
  if (urlPath.includes('login')) return handleLogin(req,res);
  if (urlPath.includes('logout-all')) return handleLogoutAll(req,res);
  if (urlPath.includes('logout')) return handleLogout(req,res);
  if (urlPath.includes('/me')) return handleMe(req,res);
  return res.status(404).json({ error:`unknown auth endpoint '${ep}'`, available:['capabilities','signup','activation-resend','activation-verify','password-reset-request','password-reset-consume','recent-auth','identities','identity-password','identity-google-unlink','login','logout','logout-all','me','google/start','google/reauth/start','google/link/start','google/callback'], hint:'endpoint query param ?endpoint=signup etc' });
}
