import { createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { getJwtSecret } from './_db.js';
import { multiCircleControlPlaneEnabled } from './_active-circle.js';

export const INVITE_CLAIM_COOKIE='randori_invite_claim';
export const INVITE_CLAIM_TTL_SECONDS=10*60;
export const INVITATION_TTL_SECONDS=7*24*60*60;
export const PRIMARY_CIRCLE_SLUG='randori-circle';

export const CIRCLES_TABLE_SQL=`CREATE TABLE IF NOT EXISTS circles (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  public_id TEXT NOT NULL UNIQUE,
  slug TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  is_primary INTEGER NOT NULL DEFAULT 0 CHECK(is_primary IN (0,1)),
  created_by INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  archived_at TEXT
)`;

export const CIRCLE_MEMBERSHIPS_TABLE_SQL=`CREATE TABLE IF NOT EXISTS circle_memberships (
  circle_id INTEGER NOT NULL,
  user_id INTEGER NOT NULL,
  role TEXT NOT NULL CHECK(role IN ('owner','member')),
  status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','inactive')),
  invited_by INTEGER,
  joined_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY(circle_id,user_id),
  FOREIGN KEY(circle_id) REFERENCES circles(id) ON DELETE CASCADE
)`;

export const CIRCLE_INVITATIONS_TABLE_SQL=`CREATE TABLE IF NOT EXISTS circle_invitations (
  id TEXT PRIMARY KEY,
  circle_id INTEGER NOT NULL,
  token_hash TEXT NOT NULL UNIQUE CHECK(length(token_hash)=64),
  email_hash TEXT NOT NULL CHECK(length(email_hash)=64),
  created_by INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  used_at TEXT,
  used_by INTEGER,
  revoked_at TEXT,
  FOREIGN KEY(circle_id) REFERENCES circles(id) ON DELETE CASCADE
)`;

export const CIRCLE_AUDIT_EVENTS_TABLE_SQL=`CREATE TABLE IF NOT EXISTS circle_audit_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  circle_id INTEGER NOT NULL,
  event_type TEXT NOT NULL,
  actor_user_id INTEGER,
  subject_user_id INTEGER,
  invitation_id TEXT,
  dedupe_key TEXT UNIQUE,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY(circle_id) REFERENCES circles(id) ON DELETE CASCADE
)`;

export const AUTH_RATE_LIMITS_TABLE_SQL=`CREATE TABLE IF NOT EXISTS auth_rate_limits (
  key TEXT PRIMARY KEY,
  attempts INTEGER NOT NULL DEFAULT 0,
  expires_at INTEGER NOT NULL
)`;

export const CIRCLE_MEMBERSHIP_ROLLOUT_TABLE_SQL=`CREATE TABLE IF NOT EXISTS circle_membership_rollout (
  id INTEGER PRIMARY KEY CHECK(id=1),
  registrations_closed INTEGER NOT NULL DEFAULT 0 CHECK(registrations_closed IN (0,1)),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
)`;

const readinessByUrl=new Map();
const readinessByClient=new WeakMap();
const rolloutReadinessByUrl=new Map();
const rolloutReadinessByClient=new WeakMap();
const CLAIM_VERSION=1;
const HASH_PATTERN=/^[0-9a-f]{64}$/;
const INVITATION_ID_PATTERN=/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const TOKEN_PATTERN=/^[A-Za-z0-9_-]{43}$/;

export function circleMembershipEnabled(){
  return process.env.CIRCLE_MEMBERSHIP_ENABLED==='true';
}

export function normalizeInvitationEmail(value){
  if(typeof value!=='string') return null;
  const email=value.trim().toLowerCase();
  if(!email || email.length>254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return null;
  return email;
}

function hmacHex(domain,value){
  return createHmac('sha256',getJwtSecret()).update(`${domain}\0${value}`,'utf8').digest('hex');
}

export function hashInvitationToken(token){
  if(typeof token!=='string'||!TOKEN_PATTERN.test(token)) return null;
  return hmacHex('randori-circle-invite-token-v1',token);
}

export function hashInvitationEmail(email){
  const normalized=normalizeInvitationEmail(email);
  return normalized ? hmacHex('randori-circle-invite-email-v1',normalized) : null;
}

export function createInvitationToken(){
  return randomBytes(32).toString('base64url');
}

function safePositiveInteger(value){
  const parsed=typeof value==='number' ? value
    : (typeof value==='string'&&/^[1-9]\d*$/.test(value) ? Number(value) : null);
  return Number.isSafeInteger(parsed)&&parsed>0 ? parsed : null;
}

function safeInvitationId(value){
  return typeof value==='string'&&INVITATION_ID_PATTERN.test(value) ? value.toLowerCase() : null;
}

function safeHash(value){
  return typeof value==='string'&&HASH_PATTERN.test(value) ? value : null;
}

function safeEqual(left,right){
  const a=Buffer.from(String(left||''));
  const b=Buffer.from(String(right||''));
  return a.length===b.length&&timingSafeEqual(a,b);
}

function invitationCirclePredicate(alias){
  return `${multiCircleControlPlaneEnabled()?'':`${alias}.is_primary=1 AND `}${alias}.archived_at IS NULL`;
}

function claimSignature(payload){
  return createHmac('sha256',getJwtSecret())
    .update(`randori-circle-invite-claim-v1\0${payload}`,'utf8')
    .digest('base64url');
}

export function createInviteClaim({invitationId,circleId,tokenHash,emailHash}){
  const invitation_id=safeInvitationId(invitationId);
  const circle_id=safePositiveInteger(circleId);
  const token_hash=safeHash(tokenHash);
  const email_hash=safeHash(emailHash);
  if(!invitation_id||!circle_id||!token_hash||!email_hash) throw new TypeError('invalid invitation claim fields');
  const issuedAt=Math.floor(Date.now()/1000);
  const payload=Buffer.from(JSON.stringify({v:CLAIM_VERSION,invitation_id,circle_id,token_hash,email_hash,iat:issuedAt,exp:issuedAt+INVITE_CLAIM_TTL_SECONDS}),'utf8').toString('base64url');
  return `${payload}.${claimSignature(payload)}`;
}

function parseCookie(req,name){
  for(const part of String(req?.headers?.cookie||req?.headers?.Cookie||'').split(';')){
    const index=part.indexOf('=');
    if(index<1||part.slice(0,index).trim()!==name) continue;
    try{ return decodeURIComponent(part.slice(index+1).trim()); }catch{ return ''; }
  }
  return '';
}

export function readInviteClaim(req){
  const raw=parseCookie(req,INVITE_CLAIM_COOKIE);
  const match=raw.match(/^([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]{43})$/);
  if(!match||!safeEqual(match[2],claimSignature(match[1]))) return null;
  let value;
  try{ value=JSON.parse(Buffer.from(match[1],'base64url').toString('utf8')); }catch{ return null; }
  if(!value||typeof value!=='object'||Array.isArray(value)) return null;
  const keys=Object.keys(value).sort();
  const expected=['circle_id','email_hash','exp','iat','invitation_id','token_hash','v'];
  if(keys.length!==expected.length||!keys.every((key,index)=>key===expected[index])) return null;
  const invitation_id=safeInvitationId(value.invitation_id);
  const circle_id=safePositiveInteger(value.circle_id);
  const token_hash=safeHash(value.token_hash);
  const email_hash=safeHash(value.email_hash);
  const now=Math.floor(Date.now()/1000);
  if(value.v!==CLAIM_VERSION||!invitation_id||!circle_id||!token_hash||!email_hash
    ||!Number.isSafeInteger(value.iat)||!Number.isSafeInteger(value.exp)
    ||value.iat>now+30||value.exp<=now||value.exp-value.iat!==INVITE_CLAIM_TTL_SECONDS){
    return null;
  }
  return {invitation_id,circle_id,token_hash,email_hash,iat:value.iat,exp:value.exp};
}

export function inviteClaimCookie(claim,{secure=true}={}){
  return `${INVITE_CLAIM_COOKIE}=${encodeURIComponent(claim)}; Path=/api/auth; HttpOnly${secure?'; Secure':''}; SameSite=Lax; Max-Age=${INVITE_CLAIM_TTL_SECONDS}`;
}

export function clearInviteClaimCookie({secure=true}={}){
  return `${INVITE_CLAIM_COOKIE}=; Path=/api/auth; HttpOnly${secure?'; Secure':''}; SameSite=Lax; Max-Age=0`;
}

function readinessCache(db){
  const databaseUrl=String(process.env.TURSO_DATABASE_URL||'').trim();
  return databaseUrl ? {cache:readinessByUrl,key:databaseUrl} : {cache:readinessByClient,key:db};
}

export async function ensureCircleMembershipReadiness(db){
  if(!db||typeof db.execute!=='function') throw new TypeError('database client is required');
  const {cache,key}=readinessCache(db);
  const existing=cache.get(key);
  if(existing) return existing;
  const pending=(async()=>{
    await db.execute(`SELECT id,public_id,slug,name,is_primary,created_by,created_at,archived_at FROM circles LIMIT 0`);
    await db.execute(`SELECT circle_id,user_id,role,status,invited_by,joined_at,updated_at FROM circle_memberships LIMIT 0`);
    await db.execute(`SELECT id,circle_id,token_hash,email_hash,created_by,created_at,expires_at,used_at,used_by,revoked_at FROM circle_invitations LIMIT 0`);
    await db.execute(`SELECT id,circle_id,event_type,actor_user_id,subject_user_id,invitation_id,dedupe_key,created_at FROM circle_audit_events LIMIT 0`);
    await db.execute(`SELECT key,attempts,expires_at FROM auth_rate_limits LIMIT 0`);
    await db.execute(`SELECT id,registrations_closed,updated_at FROM circle_membership_rollout LIMIT 0`);
    if(multiCircleControlPlaneEnabled()){
      await db.execute(`SELECT session_hash,user_id,circle_id,context_version,updated_at FROM auth_session_circle_contexts LIMIT 0`);
    }
  })();
  cache.set(key,pending);
  try{ return await pending; }
  catch(error){ if(cache.get(key)===pending) cache.delete(key); throw error; }
}

export async function getActivePrimaryCircleMembership(db,userId){
  const normalizedUserId=safePositiveInteger(userId);
  if(!normalizedUserId) return null;
  const result=await db.execute({
    sql:`SELECT c.id AS circle_id,c.public_id,c.name,cm.role
      FROM circle_memberships cm
      JOIN auth_accounts account ON account.id=cm.user_id
      JOIN circles c ON c.id=cm.circle_id
      WHERE cm.user_id=? AND cm.status='active'
        AND c.is_primary=1 AND c.archived_at IS NULL
      LIMIT 1`,
    args:[normalizedUserId],
  });
  return result.rows?.[0]||null;
}

export async function hasActivePrimaryCircleMembership(db,userId){
  return !!await getActivePrimaryCircleMembership(db,userId);
}

export async function hasActiveCircleMembership(db,userId){
  const normalizedUserId=safePositiveInteger(userId);
  if(!normalizedUserId) return false;
  const result=await db.execute({
    sql:`SELECT 1 AS active
      FROM circle_memberships membership
      JOIN circles circle ON circle.id=membership.circle_id
      WHERE membership.user_id=? AND membership.status='active' AND circle.archived_at IS NULL
      LIMIT 1`,
    args:[normalizedUserId],
  });
  return result.rows?.length===1;
}

async function ensureCircleMembershipRolloutControl(db){
  if(!db||typeof db.execute!=='function') throw new TypeError('database client is required');
  const databaseUrl=String(process.env.TURSO_DATABASE_URL||'').trim();
  const cache=databaseUrl?rolloutReadinessByUrl:rolloutReadinessByClient;
  const key=databaseUrl||db;
  const existing=cache.get(key);
  if(existing) return existing;
  const pending=db.batch([
    CIRCLE_MEMBERSHIP_ROLLOUT_TABLE_SQL,
    `INSERT INTO circle_membership_rollout (id,registrations_closed,updated_at)
      VALUES (1,0,datetime('now')) ON CONFLICT(id) DO NOTHING`,
  ],'write');
  cache.set(key,pending);
  try{ return await pending; }
  catch(error){ if(cache.get(key)===pending) cache.delete(key); throw error; }
}

export async function circleMembershipRegistrationState(db){
  if(!db||typeof db.execute!=='function') throw new TypeError('database client is required');
  const schema=await db.execute({
    sql:`SELECT 1 AS present FROM sqlite_schema
      WHERE type='table' AND name='circle_membership_rollout' LIMIT 1`,
    args:[],
  });
  if(!schema.rows?.length) return 'uninitialized';
  const result=await db.execute({
    sql:`SELECT registrations_closed FROM circle_membership_rollout WHERE id=1 LIMIT 1`,
    args:[],
  });
  if(Number(result.rows?.[0]?.registrations_closed)===0) return 'open';
  return 'closed';
}

export async function circleMembershipCutoverStarted(db){
  return await circleMembershipRegistrationState(db)==='closed';
}

function validClaimObject(claim){
  if(!claim||typeof claim!=='object'||Array.isArray(claim)) return null;
  const invitation_id=safeInvitationId(claim.invitation_id);
  const circle_id=safePositiveInteger(claim.circle_id);
  const token_hash=safeHash(claim.token_hash);
  const email_hash=safeHash(claim.email_hash);
  const now=Math.floor(Date.now()/1000);
  if(!invitation_id||!circle_id||!token_hash||!email_hash||!Number.isSafeInteger(claim.exp)||claim.exp<=now) return null;
  return {invitation_id,circle_id,token_hash,email_hash};
}

export async function prepareInvitationClaim(db,{token}){
  const tokenHash=hashInvitationToken(token);
  if(!tokenHash) return {ok:false};
  const result=await db.execute({
    sql:`SELECT ci.id,ci.circle_id,ci.email_hash,ci.expires_at
      FROM circle_invitations ci JOIN circles c ON c.id=ci.circle_id
      WHERE ci.token_hash=? AND ci.used_at IS NULL AND ci.used_by IS NULL
        AND ci.revoked_at IS NULL AND datetime(ci.expires_at)>datetime('now')
        AND ${invitationCirclePredicate('c')}
      LIMIT 1`,
    args:[tokenHash],
  });
  const row=result.rows?.[0];
  if(!row) return {ok:false};
  const invitationId=safeInvitationId(row.id);
  const circleId=safePositiveInteger(row.circle_id);
  const emailHash=safeHash(row.email_hash);
  if(!invitationId||!circleId||!emailHash) return {ok:false};
  return {
    ok:true,
    claim:createInviteClaim({invitationId,circleId,tokenHash,emailHash}),
    invitation_id:invitationId,
    circle_id:circleId,
    expires_at:String(row.expires_at),
  };
}

export async function validatePreparedInvitation(db,{claim,email}){
  const parsed=validClaimObject(claim);
  const emailHash=hashInvitationEmail(email);
  if(!parsed||!emailHash||!safeEqual(parsed.email_hash,emailHash)) return {ok:false};
  const result=await db.execute({
    sql:`SELECT ci.id,ci.circle_id,ci.used_by
      FROM circle_invitations ci JOIN circles c ON c.id=ci.circle_id
      WHERE ci.id=? AND ci.circle_id=? AND ci.token_hash=? AND ci.email_hash=?
        AND ci.revoked_at IS NULL
        AND ((ci.used_at IS NULL AND ci.used_by IS NULL AND datetime(ci.expires_at)>datetime('now'))
          OR (ci.used_at IS NOT NULL AND ci.used_by IS NOT NULL))
        AND ${invitationCirclePredicate('c')}
      LIMIT 1`,
    args:[parsed.invitation_id,parsed.circle_id,parsed.token_hash,emailHash],
  });
  const row=result.rows?.[0];
  return row ? {
    ok:true,circle_id:Number(row.circle_id),invitation_id:String(row.id),email_hash:emailHash,
    used_by:row.used_by==null?null:Number(row.used_by),
  } : {ok:false};
}

export async function acceptPreparedInvitation(db,{claim,email,userId}){
  const parsed=validClaimObject(claim);
  const normalizedUserId=safePositiveInteger(userId);
  const emailHash=hashInvitationEmail(email);
  if(!parsed||!normalizedUserId||!emailHash||!safeEqual(parsed.email_hash,emailHash)) return {ok:false};
  const acceptedAt=new Date().toISOString();
  const auditKey=`invite-accepted:${parsed.invitation_id}`;
  const [accepted,membership,audit]=await db.batch([{
      sql:`UPDATE circle_invitations
        SET used_at=COALESCE(used_at,?),used_by=COALESCE(used_by,?)
        WHERE id=? AND circle_id=? AND token_hash=? AND email_hash=? AND revoked_at IS NULL
          AND ((used_at IS NULL AND used_by IS NULL AND datetime(expires_at)>datetime('now')) OR used_by=?)
          AND EXISTS (SELECT 1 FROM circles c WHERE c.id=circle_id AND ${invitationCirclePredicate('c')})
          AND NOT EXISTS (
            SELECT 1 FROM circle_memberships existing_membership
            WHERE existing_membership.circle_id=circle_invitations.circle_id
              AND existing_membership.user_id=? AND existing_membership.status<>'active'
          )
        RETURNING circle_id,used_by`,
      args:[acceptedAt,normalizedUserId,parsed.invitation_id,parsed.circle_id,parsed.token_hash,emailHash,normalizedUserId,normalizedUserId],
    },{
      sql:`INSERT INTO circle_memberships (circle_id,user_id,role,status,invited_by,joined_at,updated_at)
        SELECT ci.circle_id,?,'member','active',ci.created_by,COALESCE(ci.used_at,?),?
        FROM circle_invitations ci JOIN circles c ON c.id=ci.circle_id
        WHERE ci.id=? AND ci.circle_id=? AND ci.token_hash=? AND ci.email_hash=?
          AND ci.used_by=? AND ci.revoked_at IS NULL
          AND ${invitationCirclePredicate('c')}
        ON CONFLICT(circle_id,user_id) DO UPDATE SET
          updated_at=excluded.updated_at
        WHERE circle_memberships.status='active'
        RETURNING circle_id,role,status`,
      args:[normalizedUserId,acceptedAt,acceptedAt,parsed.invitation_id,parsed.circle_id,parsed.token_hash,emailHash,normalizedUserId],
    },{
      sql:`INSERT INTO circle_audit_events
          (circle_id,event_type,actor_user_id,subject_user_id,invitation_id,dedupe_key,created_at)
        SELECT ci.circle_id,'invitation.accepted',?,?,ci.id,?,?
        FROM circle_invitations ci JOIN circles c ON c.id=ci.circle_id
        WHERE ci.id=? AND ci.circle_id=? AND ci.token_hash=? AND ci.email_hash=?
          AND ci.used_by=? AND ci.revoked_at IS NULL
          AND ${invitationCirclePredicate('c')}
        ON CONFLICT(dedupe_key) DO NOTHING
        RETURNING id`,
      args:[normalizedUserId,normalizedUserId,auditKey,acceptedAt,
        parsed.invitation_id,parsed.circle_id,parsed.token_hash,emailHash,normalizedUserId],
    }], 'write');
  const acceptedRow=accepted?.rows?.[0];
  const memberRow=membership?.rows?.[0];
  if(!acceptedRow||Number(acceptedRow.used_by)!==normalizedUserId||memberRow?.status!=='active') return {ok:false};
  return {ok:true,circle_id:Number(acceptedRow.circle_id),idempotent:!audit?.rows?.length};
}

export async function createGoogleAccountFromPreparedInvitation(db,{
  claim,email,passwordHash,displayName,color,isAdmin=false,googleIssuer,googleSub,
}){
  const parsed=validClaimObject(claim);
  const normalizedEmail=normalizeInvitationEmail(email);
  const emailHash=hashInvitationEmail(normalizedEmail);
  const safePasswordHash=typeof passwordHash==='string'&&passwordHash.startsWith('!oauth:')&&passwordHash.length<=128?passwordHash:null;
  const safeDisplayName=typeof displayName==='string'&&displayName.trim()?displayName.trim().slice(0,32):null;
  const safeColor=typeof color==='string'&&color.length<=32?color:null;
  const safeGoogleIssuer=googleIssuer==='https://accounts.google.com'?googleIssuer:null;
  const safeGoogleSub=typeof googleSub==='string'&&/^[A-Za-z0-9_-]{1,255}$/.test(googleSub)?googleSub:null;
  if(!parsed||!normalizedEmail||!emailHash||!safeEqual(parsed.email_hash,emailHash)
    ||!safePasswordHash||!safeDisplayName||!safeColor||!safeGoogleIssuer||!safeGoogleSub){
    return {ok:false};
  }
  const acceptedAt=new Date().toISOString();
  const transaction=await db.transaction('write');
  let finished=false;
  const reject=async()=>{ await transaction.rollback(); finished=true; return {ok:false}; };
  try{
    const created=await transaction.execute({
      sql:`INSERT INTO auth_accounts
          (email,password_hash,display_name,color,last_login,is_available,is_admin,google_sub)
        SELECT ?,?,?,?,datetime('now'),1,?,?
        WHERE EXISTS (
          SELECT 1 FROM circle_invitations ci JOIN circles c ON c.id=ci.circle_id
          WHERE ci.id=? AND ci.circle_id=? AND ci.token_hash=? AND ci.email_hash=?
            AND ci.used_at IS NULL AND ci.used_by IS NULL AND ci.revoked_at IS NULL
            AND datetime(ci.expires_at)>datetime('now')
            AND ${invitationCirclePredicate('c')}
        )
        AND NOT EXISTS (SELECT 1 FROM auth_accounts WHERE google_sub=?)
        ON CONFLICT(email) DO NOTHING
        RETURNING id,is_admin`,
      args:[normalizedEmail,safePasswordHash,safeDisplayName,safeColor,isAdmin?1:0,safeGoogleSub,
        parsed.invitation_id,parsed.circle_id,parsed.token_hash,emailHash,safeGoogleSub],
    });
    if(created.rows?.length!==1) return await reject();
    const account=created.rows[0];
    const userId=safePositiveInteger(account.id);
    if(!userId) return await reject();
    const identity=await transaction.execute({
      sql:`INSERT INTO auth_provider_identities (issuer,subject,user_id,created_at,last_login)
        VALUES (?,?,?,?,?) ON CONFLICT DO NOTHING RETURNING user_id`,
      args:[safeGoogleIssuer,safeGoogleSub,userId,acceptedAt,acceptedAt],
    });
    if(identity.rows?.length!==1||Number(identity.rows[0].user_id)!==userId) return await reject();
    const accepted=await transaction.execute({
      sql:`UPDATE circle_invitations SET used_at=?,used_by=?
        WHERE id=? AND circle_id=? AND token_hash=? AND email_hash=?
          AND used_at IS NULL AND used_by IS NULL AND revoked_at IS NULL
          AND datetime(expires_at)>datetime('now')
          AND EXISTS (SELECT 1 FROM circles c WHERE c.id=circle_id AND ${invitationCirclePredicate('c')})
          AND EXISTS (SELECT 1 FROM auth_accounts WHERE id=? AND email=? AND google_sub=?)
        RETURNING circle_id,used_by`,
      args:[acceptedAt,userId,parsed.invitation_id,parsed.circle_id,parsed.token_hash,emailHash,
        userId,normalizedEmail,safeGoogleSub],
    });
    const acceptedRow=accepted.rows?.[0];
    if(accepted.rows?.length!==1||Number(acceptedRow.used_by)!==userId
      ||Number(acceptedRow.circle_id)!==parsed.circle_id) return await reject();
    const membership=await transaction.execute({
      sql:`INSERT INTO circle_memberships (circle_id,user_id,role,status,invited_by,joined_at,updated_at)
        SELECT ci.circle_id,?,'member','active',ci.created_by,?,?
        FROM circle_invitations ci JOIN circles c ON c.id=ci.circle_id
        WHERE ci.id=? AND ci.circle_id=? AND ci.token_hash=? AND ci.email_hash=?
          AND ci.used_at=? AND ci.used_by=? AND ci.revoked_at IS NULL
          AND ${invitationCirclePredicate('c')}
        ON CONFLICT(circle_id,user_id) DO NOTHING
        RETURNING circle_id,user_id,role,status`,
      args:[userId,acceptedAt,acceptedAt,parsed.invitation_id,parsed.circle_id,parsed.token_hash,emailHash,
        acceptedAt,userId],
    });
    const memberRow=membership.rows?.[0];
    if(membership.rows?.length!==1||Number(memberRow.user_id)!==userId
      ||Number(memberRow.circle_id)!==parsed.circle_id||memberRow.status!=='active') return await reject();
    const audit=await transaction.execute({
      sql:`INSERT INTO circle_audit_events
          (circle_id,event_type,actor_user_id,subject_user_id,invitation_id,dedupe_key,created_at)
        VALUES (?,'invitation.accepted',?,?,?,?,?)
        ON CONFLICT(dedupe_key) DO NOTHING
        RETURNING id`,
      args:[parsed.circle_id,userId,userId,parsed.invitation_id,
        `invite-accepted:${parsed.invitation_id}`,acceptedAt],
    });
    if(audit.rows?.length!==1) return await reject();
    await transaction.commit();
    finished=true;
    return {ok:true,user_id:userId,is_admin:!!account.is_admin,circle_id:parsed.circle_id,created:true,idempotent:false};
  }catch(error){
    if(!finished){ try{ await transaction.rollback(); }catch{} }
    throw error;
  }
}

export async function createPasswordAccountFromPreparedInvitation(db,{
  claim,email,passwordHash,displayName,color,isAdmin=false,
}){
  const parsed=validClaimObject(claim);
  const normalizedEmail=normalizeInvitationEmail(email);
  const emailHash=hashInvitationEmail(normalizedEmail);
  const safePasswordHash=typeof passwordHash==='string'&&passwordHash.startsWith('$2')&&passwordHash.length<=128
    ?passwordHash:null;
  const safeDisplayName=typeof displayName==='string'&&displayName.trim()?displayName.trim().slice(0,32):null;
  const safeColor=typeof color==='string'&&color.length<=32?color:null;
  if(!parsed||!normalizedEmail||!emailHash||!safeEqual(parsed.email_hash,emailHash)
    ||!safePasswordHash||!safeDisplayName||!safeColor){
    return {ok:false};
  }
  const acceptedAt=new Date().toISOString();
  const transaction=await db.transaction('write');
  let finished=false;
  const reject=async()=>{ await transaction.rollback(); finished=true; return {ok:false}; };
  try{
    const created=await transaction.execute({
      sql:`INSERT INTO auth_accounts
          (email,password_hash,display_name,color,last_login,is_available,is_admin,google_sub)
        SELECT ?,?,?,?,datetime('now'),1,?,NULL
        WHERE EXISTS (
          SELECT 1 FROM circle_invitations ci JOIN circles c ON c.id=ci.circle_id
          WHERE ci.id=? AND ci.circle_id=? AND ci.token_hash=? AND ci.email_hash=?
            AND ci.used_at IS NULL AND ci.used_by IS NULL AND ci.revoked_at IS NULL
            AND datetime(ci.expires_at)>datetime('now')
            AND ${invitationCirclePredicate('c')}
        )
        ON CONFLICT(email) DO NOTHING
        RETURNING id,is_admin`,
      args:[normalizedEmail,safePasswordHash,safeDisplayName,safeColor,isAdmin?1:0,
        parsed.invitation_id,parsed.circle_id,parsed.token_hash,emailHash],
    });
    if(created.rows?.length!==1) return await reject();
    const account=created.rows[0];
    const userId=safePositiveInteger(account.id);
    if(!userId) return await reject();
    const accepted=await transaction.execute({
      sql:`UPDATE circle_invitations SET used_at=?,used_by=?
        WHERE id=? AND circle_id=? AND token_hash=? AND email_hash=?
          AND used_at IS NULL AND used_by IS NULL AND revoked_at IS NULL
          AND datetime(expires_at)>datetime('now')
          AND EXISTS (SELECT 1 FROM circles c WHERE c.id=circle_id AND ${invitationCirclePredicate('c')})
          AND EXISTS (SELECT 1 FROM auth_accounts
            WHERE id=? AND email=? AND password_hash=? AND google_sub IS NULL)
        RETURNING circle_id,used_by`,
      args:[acceptedAt,userId,parsed.invitation_id,parsed.circle_id,parsed.token_hash,emailHash,
        userId,normalizedEmail,safePasswordHash],
    });
    const acceptedRow=accepted.rows?.[0];
    if(accepted.rows?.length!==1||Number(acceptedRow.used_by)!==userId
      ||Number(acceptedRow.circle_id)!==parsed.circle_id) return await reject();
    const membership=await transaction.execute({
      sql:`INSERT INTO circle_memberships (circle_id,user_id,role,status,invited_by,joined_at,updated_at)
        SELECT ci.circle_id,?,'member','active',ci.created_by,?,?
        FROM circle_invitations ci JOIN circles c ON c.id=ci.circle_id
        WHERE ci.id=? AND ci.circle_id=? AND ci.token_hash=? AND ci.email_hash=?
          AND ci.used_at=? AND ci.used_by=? AND ci.revoked_at IS NULL
          AND ${invitationCirclePredicate('c')}
        ON CONFLICT(circle_id,user_id) DO NOTHING
        RETURNING circle_id,user_id,role,status`,
      args:[userId,acceptedAt,acceptedAt,parsed.invitation_id,parsed.circle_id,parsed.token_hash,emailHash,
        acceptedAt,userId],
    });
    const memberRow=membership.rows?.[0];
    if(membership.rows?.length!==1||Number(memberRow.user_id)!==userId
      ||Number(memberRow.circle_id)!==parsed.circle_id||memberRow.status!=='active') return await reject();
    const audit=await transaction.execute({
      sql:`INSERT INTO circle_audit_events
          (circle_id,event_type,actor_user_id,subject_user_id,invitation_id,dedupe_key,created_at)
        VALUES (?,'invitation.accepted',?,?,?,?,?)
        ON CONFLICT(dedupe_key) DO NOTHING
        RETURNING id`,
      args:[parsed.circle_id,userId,userId,parsed.invitation_id,
        `invite-accepted:${parsed.invitation_id}`,acceptedAt],
    });
    if(audit.rows?.length!==1) return await reject();
    await transaction.commit();
    finished=true;
    return {ok:true,user_id:userId,is_admin:!!account.is_admin,circle_id:parsed.circle_id,created:true,idempotent:false};
  }catch(error){
    if(!finished){ try{ await transaction.rollback(); }catch{} }
    throw error;
  }
}

export async function initializePrimaryCircle(db,{ownerUserId,ownerEmails=[]}={}){
  const ownerId=safePositiveInteger(ownerUserId);
  if(!ownerId) throw new TypeError('ownerUserId must be a positive safe integer');
  const publicId=randomUUID();
  await ensureCircleMembershipRolloutControl(db);
  await db.execute({
    sql:`INSERT INTO circles (public_id,slug,name,is_primary,created_by,created_at)
      SELECT ?,?,'Randori Circle',1,?,datetime('now')
      WHERE NOT EXISTS (SELECT 1 FROM circles WHERE is_primary=1 AND archived_at IS NULL)
      ON CONFLICT(slug) DO NOTHING`,
    args:[publicId,PRIMARY_CIRCLE_SLUG,ownerId],
  });
  const primary=await db.execute(`SELECT id FROM circles WHERE is_primary=1 AND archived_at IS NULL ORDER BY id LIMIT 1`);
  const circleId=safePositiveInteger(primary.rows?.[0]?.id);
  if(!circleId) throw new Error('primary circle unavailable');
  const normalizedOwners=[...new Set(ownerEmails.map(normalizeInvitationEmail).filter(Boolean))];
  const ownerEmailSql=normalizedOwners.length
    ? ` OR lower(email) IN (${normalizedOwners.map(()=>'?').join(',')})`
    : '';
  const now=new Date().toISOString();
  const backfillKey=`primary-membership-backfill:${circleId}:v1`;
  await db.batch([{
      sql:`UPDATE circle_membership_rollout
        SET registrations_closed=1,updated_at=? WHERE id=1`,
      args:[now],
    },{
      sql:`INSERT INTO circle_memberships (circle_id,user_id,role,status,invited_by,joined_at,updated_at)
        SELECT ?,id,CASE WHEN COALESCE(is_admin,0)=1 OR id=?${ownerEmailSql} THEN 'owner' ELSE 'member' END,
          'active',NULL,?,?
        FROM auth_accounts WHERE COALESCE(is_demo,0)=0
          AND NOT EXISTS (SELECT 1 FROM circle_audit_events WHERE dedupe_key=?)
        ON CONFLICT(circle_id,user_id) DO UPDATE SET
          role=CASE WHEN excluded.role='owner' THEN 'owner' ELSE circle_memberships.role END,
          updated_at=CASE WHEN excluded.role='owner' AND circle_memberships.role<>'owner'
            THEN excluded.updated_at ELSE circle_memberships.updated_at END`,
      args:[circleId,ownerId,...normalizedOwners,now,now,backfillKey],
    },{
      sql:`INSERT INTO circle_audit_events
          (circle_id,event_type,actor_user_id,subject_user_id,invitation_id,dedupe_key,created_at)
        SELECT ?, 'membership.backfilled', ?, account.id, NULL,
          printf('membership-backfilled:%d:%d',?,account.id), ?
        FROM auth_accounts account
        JOIN circle_memberships membership ON membership.circle_id=? AND membership.user_id=account.id
        WHERE COALESCE(account.is_demo,0)=0
          AND NOT EXISTS (SELECT 1 FROM circle_audit_events WHERE dedupe_key=?)
        ON CONFLICT(dedupe_key) DO NOTHING`,
      args:[circleId,ownerId,circleId,now,circleId,backfillKey],
    },{
      sql:`INSERT INTO circle_audit_events
          (circle_id,event_type,actor_user_id,subject_user_id,invitation_id,dedupe_key,created_at)
        SELECT ?,'membership.backfill.completed',?,NULL,NULL,?,?
        WHERE NOT EXISTS (SELECT 1 FROM circle_audit_events WHERE dedupe_key=?)
        ON CONFLICT(dedupe_key) DO NOTHING`,
      args:[circleId,ownerId,backfillKey,now,backfillKey],
    }], 'write');
  return {circleId};
}
