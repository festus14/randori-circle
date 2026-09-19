import { createClient } from '@libsql/client';
import jwt from 'jsonwebtoken';
import { createHash, randomBytes } from 'node:crypto';
import { redactSentryText, sanitizeSentryContext, sanitizeSentryEvent } from './_sentry.js';

export const JWT_ISSUER = 'randori-circle';
export const JWT_AUDIENCE = 'randori-web';
export const SESSION_TTL_SECONDS = 12*60*60;

const MAX_ACTIVE_SESSIONS_PER_ACCOUNT=8;
const SESSION_RECORD_RETENTION_SECONDS=30*24*60*60;
const SESSION_ID_PATTERN=/^[A-Za-z0-9_-]{43}$/;
const SESSION_HASH_PATTERN=/^[a-f0-9]{64}$/;
const SESSION_REVOCATION_REASONS=new Set([
  'current_logout','logout_all','password_change','identity_change','membership_removed','rotation',
]);

let localDevelopmentClient=null;
let localDevelopmentClientUrl='';
let localDevelopmentSqlObserver=null;

function localStatementSql(statement){
  if(typeof statement==='string') return statement;
  return typeof statement?.sql==='string'?statement.sql:'';
}

function observeLocalStatement(statement){
  const sql=localStatementSql(statement);
  if(!sql||typeof localDevelopmentSqlObserver!=='function') return;
  try{ localDevelopmentSqlObserver(sql); }catch{}
}

function observedLocalDatabase(target,{client=false}={}){
  return new Proxy(target,{
    get(database,property){
      if(property==='execute') return async statement=>{
        observeLocalStatement(statement);
        return database.execute(statement);
      };
      if(property==='executeMultiple') return async sql=>{
        observeLocalStatement(sql);
        return database.executeMultiple(sql);
      };
      if(property==='batch') return async(statements,...args)=>{
        for(const statement of statements||[]) observeLocalStatement(statement);
        return database.batch(statements,...args);
      };
      if(client&&property==='transaction') return async(...args)=>{
        const transaction=await database.transaction(...args);
        return observedLocalDatabase(transaction);
      };
      const value=Reflect.get(database,property,database);
      return typeof value==='function'?value.bind(database):value;
    },
  });
}

export function installLocalDevelopmentSqlObserver(observer){
  if(observer!=null&&typeof observer!=='function') throw new TypeError('Local SQL observer must be a function');
  if(observer&&(process.env.NODE_ENV!=='development'||process.env.RANDORI_LOCAL_RUNTIME!=='true')){
    throw new Error('Local SQL observation is development-only');
  }
  const installed=observer||null;
  const previous=localDevelopmentSqlObserver;
  localDevelopmentSqlObserver=installed;
  let restored=false;
  return ()=>{
    if(restored) return;
    restored=true;
    if(localDevelopmentSqlObserver===installed) localDevelopmentSqlObserver=previous;
  };
}

// ---- Sentry server init (optional, DSN via env) ----
import * as Sentry from '@sentry/node';
let sentryInit = false;

function getSentryDsn() {
  return process.env.SENTRY_DSN || process.env.NEXT_PUBLIC_SENTRY_DSN || '';
}

export function isSentryConfigured() {
  return Boolean(getSentryDsn());
}

export function initSentry() {
  if (sentryInit) return;
  try {
    const dsn = getSentryDsn();
    if (!dsn) return;
    Sentry.init({
      dsn,
      environment: process.env.VERCEL_ENV || process.env.NODE_ENV || 'production',
      tracesSampleRate: 0.1,
      sendDefaultPii: false,
      beforeSend: sanitizeSentryEvent,
      beforeSendTransaction: sanitizeSentryEvent,
      beforeSendSpan: sanitizeSentryEvent,
    });
    sentryInit = true;
  } catch (e) {
    try { console.warn('[sentry server init fail]', e && e.message); } catch {}
  }
}
initSentry();

export function getSentry() { return { Sentry, ready: sentryInit }; }

export function captureSentryMessage(message, context = {}) {
  initSentry();
  if (!sentryInit) return null;
  try {
    return Sentry.captureMessage(
      redactSentryText(message),
      sanitizeSentryContext(context),
    );
  } catch (error) {
    try { console.warn('[sentry capture message fail]', error && error.message); } catch {}
    return null;
  }
}

export function captureSentryException(error, context = {}) {
  initSentry();
  if (!sentryInit) return null;
  try {
    return Sentry.captureException(
      error,
      sanitizeSentryContext(context),
    );
  } catch (captureError) {
    try { console.warn('[sentry capture exception fail]', captureError && captureError.message); } catch {}
    return null;
  }
}

export function getClient() {
  const url = process.env.TURSO_DATABASE_URL;
  const authToken = process.env.TURSO_AUTH_TOKEN;
  if (!url) throw new Error("Missing TURSO_DATABASE_URL");
  if(process.env.RANDORI_LOCAL_RUNTIME==='true'){
    let parsed;
    try{ parsed=new URL(url); }catch{ throw new Error('Invalid local database URL'); }
    if(process.env.NODE_ENV==='production'||parsed.protocol!=='file:'||parsed.host||authToken){
      throw new Error('Local runtime requires a credential-free file database');
    }
    if(localDevelopmentClient&&localDevelopmentClientUrl!==url){
      throw new Error('Local runtime database changed without shutdown');
    }
    if(!localDevelopmentClient){
      localDevelopmentClient=observedLocalDatabase(createClient({url}),{client:true});
      localDevelopmentClientUrl=url;
    }
    return localDevelopmentClient;
  }
  return createClient({ url, authToken });
}

export async function closeLocalDevelopmentClient(){
  const client=localDevelopmentClient;
  localDevelopmentClient=null;
  localDevelopmentClientUrl='';
  await client?.close?.();
}

export function getJwtSecret() {
  const secret = process.env.JWT_SECRET;
  if (!secret) {
    throw new Error('Missing JWT_SECRET');
  }
  return secret;
}

export function getCronSecret() {
  const secret = process.env.CRON_SECRET;
  if (!secret) {
    throw new Error('Missing CRON_SECRET');
  }
  return secret;
}

function parseCookies(header = '') {
  const cookies = {};
  for (const part of String(header).split(';')) {
    const idx = part.indexOf('=');
    if (idx < 1) continue;
    const key = part.slice(0, idx).trim();
    if (!key) continue;
    try { cookies[key] = decodeURIComponent(part.slice(idx + 1).trim()); }
    catch { cookies[key] = part.slice(idx + 1).trim(); }
  }
  return cookies;
}

function requestCredential(req){
  const auth = req?.headers?.authorization || req?.headers?.Authorization || '';
  const bearer = typeof auth === 'string' ? auth.match(/^Bearer\s+(.+)$/i)?.[1] : null;
  const cookieToken = parseCookies(req?.headers?.cookie || req?.headers?.Cookie || '').randori_session;
  return bearer
    ? {token:bearer,transport:'bearer'}
    : (cookieToken?{token:cookieToken,transport:'cookie'}:null);
}

export function hashSessionIdentifier(identifier){
  if(typeof identifier!=='string'||!SESSION_ID_PATTERN.test(identifier)) return null;
  return createHash('sha256').update(`randori-session-v1\0${identifier}`,'utf8').digest('hex');
}

export function verifySignedRequestAuth(req,{nowSeconds=Math.floor(Date.now()/1000)}={}) {
  const credential=requestCredential(req);
  const token=credential?.token;
  if (!token) return null;
  try {
    const payload = jwt.verify(token, getJwtSecret(), {
      algorithms: ['HS256'],
      issuer: JWT_ISSUER,
      audience: JWT_AUDIENCE,
      clockTimestamp:nowSeconds,
    });
    const rawUserId=payload?.id??payload?.uid;
    const userId=typeof rawUserId==='number'
      ? rawUserId
      : (typeof rawUserId==='string'&&/^[1-9]\d*$/.test(rawUserId) ? Number(rawUserId) : null);
    const sessionHash=hashSessionIdentifier(payload?.jti);
    if(!Number.isSafeInteger(userId)||userId<1||!sessionHash) return null;
    // Normalize at the trust boundary so every downstream authorization path
    // sees one strict identity type, including JWTs minted by older clients.
    const {jti:_sessionIdentifier,...safeClaims}=payload;
    const normalized={...safeClaims,id:userId};
    Object.defineProperties(normalized,{
      sessionHash:{value:sessionHash,enumerable:false},
      authTransport:{value:credential.transport,enumerable:false},
    });
    return normalized;
  } catch {
    return null;
  }
}

function safeSessionUserId(value){
  const parsed=typeof value==='number'?value
    :(typeof value==='string'&&/^[1-9]\d*$/.test(value)?Number(value):null);
  return Number.isSafeInteger(parsed)&&parsed>0?parsed:null;
}

function safeSessionEmail(value){
  if(typeof value!=='string') return null;
  const email=value.trim().toLowerCase();
  return email&&Buffer.byteLength(email,'utf8')<=254?email:null;
}

function safeRevocationReason(value){
  return SESSION_REVOCATION_REASONS.has(value)?value:null;
}

export async function issueSessionInTransaction(transaction,user,{nowSeconds=Math.floor(Date.now()/1000)}={}){
  if(!transaction||typeof transaction.execute!=='function') throw new TypeError('session transaction is required');
  const userId=safeSessionUserId(user?.id??user?.uid);
  const email=safeSessionEmail(user?.email);
  if(!userId||!email||!Number.isSafeInteger(nowSeconds)||nowSeconds<1) throw new TypeError('valid session user is required');
  const identifier=randomBytes(32).toString('base64url');
  const sessionHash=hashSessionIdentifier(identifier);
  const expiresAt=nowSeconds+SESSION_TTL_SECONDS;
  const token=jwt.sign({...user,id:userId,email,jti:identifier,iat:nowSeconds,exp:expiresAt},getJwtSecret(),{
    algorithm:'HS256',issuer:JWT_ISSUER,audience:JWT_AUDIENCE,
  });
  const inserted=await transaction.execute({
    sql:`INSERT INTO auth_sessions (session_hash,user_id,created_at,expires_at)
      SELECT ?,id,?,? FROM auth_accounts WHERE id=? AND lower(email)=? RETURNING session_hash`,
    args:[sessionHash,nowSeconds,expiresAt,userId,email],
  });
  if(inserted.rows?.length!==1||String(inserted.rows[0].session_hash)!==sessionHash){
    throw new Error('session persistence failed');
  }
  await transaction.execute({
    sql:`UPDATE auth_sessions SET revoked_at=?,revocation_reason='rotation'
      WHERE user_id=? AND session_hash<>? AND revoked_at IS NULL AND expires_at>?
        AND session_hash NOT IN (
          SELECT session_hash FROM auth_sessions
          WHERE user_id=? AND session_hash<>? AND revoked_at IS NULL AND expires_at>?
          ORDER BY created_at DESC,session_hash DESC LIMIT ?
        )`,
    args:[nowSeconds,userId,sessionHash,nowSeconds,userId,sessionHash,nowSeconds,MAX_ACTIVE_SESSIONS_PER_ACCOUNT-1],
  });
  await transaction.execute({
    sql:`DELETE FROM auth_sessions
      WHERE expires_at<=? OR (revoked_at IS NOT NULL AND revoked_at<=?)`,
    args:[nowSeconds-SESSION_RECORD_RETENTION_SECONDS,nowSeconds-SESSION_RECORD_RETENTION_SECONDS],
  });
  return token;
}

export async function issueSession(db,user,options={}){
  if(!db||typeof db.transaction!=='function') throw new TypeError('database client is required');
  const transaction=await db.transaction('write');
  let finished=false;
  try{
    const token=await issueSessionInTransaction(transaction,user,options);
    await transaction.commit();
    finished=true;
    return token;
  }catch(error){
    if(!finished){ try{ await transaction.rollback(); }catch{} }
    throw error;
  }
}

export async function revokeAccountSessions(db,userId,reason,{nowSeconds=Math.floor(Date.now()/1000)}={}){
  const normalizedUserId=safeSessionUserId(userId);
  const normalizedReason=safeRevocationReason(reason);
  if(!db||typeof db.execute!=='function'||!normalizedUserId||!normalizedReason
    ||!Number.isSafeInteger(nowSeconds)||nowSeconds<1){
    throw new TypeError('valid session revocation is required');
  }
  const result=await db.execute({
    sql:`UPDATE auth_sessions SET revoked_at=?,revocation_reason=?
      WHERE user_id=? AND revoked_at IS NULL AND expires_at>? RETURNING session_hash`,
    args:[nowSeconds,normalizedReason,normalizedUserId,nowSeconds],
  });
  return result.rows?.length||0;
}

export async function revokeRequestSession(db,req,{reason='current_logout',nowSeconds=Math.floor(Date.now()/1000)}={}){
  const payload=verifySignedRequestAuth(req,{nowSeconds});
  const normalizedReason=safeRevocationReason(reason);
  if(!payload) return {authenticated:false,revoked:false,userId:null};
  if(!db||typeof db.execute!=='function'||!normalizedReason
    ||!Number.isSafeInteger(nowSeconds)||nowSeconds<1){
    throw new TypeError('valid session revocation is required');
  }
  const result=await db.execute({
    sql:`UPDATE auth_sessions SET revoked_at=?,revocation_reason=?
      WHERE session_hash=? AND user_id=? AND revoked_at IS NULL RETURNING user_id`,
    args:[nowSeconds,normalizedReason,payload.sessionHash,payload.id],
  });
  return {authenticated:true,revoked:result.rows?.length===1,userId:payload.id};
}

export async function verifyRequestAuth(req,db=null,{nowSeconds=Math.floor(Date.now()/1000)}={}) {
  const payload=verifySignedRequestAuth(req,{nowSeconds});
  if(!payload) return null;
  const sessionDb=db||getClient();
  if(!sessionDb||typeof sessionDb.execute!=='function'||!Number.isSafeInteger(nowSeconds)||nowSeconds<1) return null;
  const membershipRequired=process.env.CIRCLE_MEMBERSHIP_ENABLED==='true';
  const membershipProjection=membershipRequired
    ? `CASE WHEN EXISTS (
          SELECT 1 FROM circle_memberships membership
          JOIN circles circle ON circle.id=membership.circle_id
          WHERE membership.user_id=session.user_id AND membership.status='active'
            AND circle.is_primary=1 AND circle.archived_at IS NULL
        ) THEN 1 ELSE 0 END`
    :'0';
  const result=await sessionDb.execute({
    sql:`SELECT session.user_id,session.expires_at,
        ${membershipProjection} AS active_membership
      FROM auth_sessions session
      JOIN auth_accounts account ON account.id=session.user_id
      WHERE session.session_hash=? AND session.user_id=?
        AND session.revoked_at IS NULL AND session.expires_at>?
      LIMIT 2`,
    args:[payload.sessionHash,payload.id,nowSeconds],
  });
  if(result.rows?.length!==1) return null;
  const row=result.rows[0];
  if(Number(row.user_id)!==payload.id||!SESSION_HASH_PATTERN.test(payload.sessionHash)) return null;
  if(membershipRequired&&Number(row.active_membership)!==1){
    await revokeAccountSessions(sessionDb,payload.id,'membership_removed',{nowSeconds});
    return null;
  }
  return payload;
}

export function verifyMutationOrigin(req) {
  const method=String(req?.method||'GET').toUpperCase();
  if(['GET','HEAD','OPTIONS'].includes(method)) return true;
  const auth=String(req?.headers?.authorization||req?.headers?.Authorization||'');
  if(/^Bearer\s+\S+/i.test(auth)) return true;
  const cookies=parseCookies(req?.headers?.cookie||req?.headers?.Cookie||'');
  if(!cookies.randori_session) return true;
  const origin=String(req?.headers?.origin||req?.headers?.Origin||'').trim();
  const host=String(req?.headers?.['x-forwarded-host']||req?.headers?.host||'').split(',')[0].trim();
  if(!origin || !host) return false;
  try{ return new URL(origin).host===host; }catch{ return false; }
}

export function getAdminEmails() {
  const raw = process.env.ADMIN_EMAILS || '';
  const list = raw.split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
  return new Set(list);
}

export function isoWeekLabel(d = new Date()) {
  const date = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  const dayNum = date.getUTCDay() || 7;
  date.setUTCDate(date.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(date.getUTCFullYear(),0,1));
  const weekNo = Math.ceil(( ( (date - yearStart) / 86400000) + 1)/7);
  return `${date.getUTCFullYear()}-W${String(weekNo).padStart(2,'0')}`;
}

export function deterministicColor(str) {
  const PALETTE=['#e6c07a','#9cc0b5','#d68a8a','#a3b5d6','#c7b29a','#8ec0a5','#d3a0cb','#9aa9c9','#e3c9b2','#82b6b7','#b8a8d8','#d9b6a3'];
  let h=0; for(let i=0;i<str.length;i++) h=(h*31+str.charCodeAt(i))>>>0;
  return PALETTE[h%PALETTE.length];
}

export function shuffleArray(arr){
  const a=[...arr]; for(let i=a.length-1;i>0;i--){ const j=Math.floor(Math.random()*(i+1)); [a[i],a[j]]=[a[j],a[i]] } return a;
}
