import { createHmac, randomUUID } from 'node:crypto';
import {
  captureSentryException,
  getClient,
  getJwtSecret,
  verifyMutationOrigin,
  verifyRequestAuth,
} from './_db.js';
import {
  INVITATION_TTL_SECONDS,
  INVITE_CLAIM_TTL_SECONDS,
  circleMembershipEnabled,
  clearInviteClaimCookie,
  createInvitationToken,
  ensureCircleMembershipReadiness,
  getActivePrimaryCircleMembership,
  hashInvitationEmail,
  hashInvitationToken,
  inviteClaimCookie,
  normalizeInvitationEmail,
  prepareInvitationClaim,
} from './_circle-membership.js';
import { localIdentityAdapterEnabled } from './_local-runtime.js';

const PREPARE_RATE_LIMIT=12;
const PREPARE_RATE_WINDOW_SECONDS=10*60;
const INVITATION_ID_PATTERN=/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function queryValue(req,name){
  const value=req?.query?.[name];
  if(Array.isArray(value)) return null;
  if(value!==undefined) return String(value);
  try{
    const values=new URL(req?.url||'/', 'https://randori.invalid').searchParams.getAll(name);
    return values.length===1?values[0]:values.length?null:undefined;
  }catch{ return undefined; }
}

function endpoint(req){
  const explicit=queryValue(req,'endpoint');
  if(explicit==='prepare') return 'prepare';
  if(explicit==='invitations') return 'invitations';
  const path=String(req?.url||'').split('?')[0].replace(/\/+$/,'');
  return path.endsWith('/prepare')?'prepare':'invitations';
}

function invitationId(req){
  const direct=queryValue(req,'id');
  const path=String(req?.url||'').split('?')[0].replace(/\/+$/,'');
  const raw=direct===undefined?path.split('/').pop():direct;
  return typeof raw==='string'&&INVITATION_ID_PATTERN.test(raw)?raw.toLowerCase():null;
}

function exactObject(value,keys){
  return !!value&&typeof value==='object'&&!Array.isArray(value)
    && Object.keys(value).length===keys.length
    && keys.every(key=>Object.prototype.hasOwnProperty.call(value,key));
}

function hasOnlyQueryKeys(req,allowed){
  const keys=new Set();
  if(req?.query&&typeof req.query==='object'){
    for(const [key,value] of Object.entries(req.query)){
      if(Array.isArray(value)) return false;
      keys.add(key);
    }
  }
  try{
    const params=new URL(req?.url||'/', 'https://randori.invalid').searchParams;
    for(const key of params.keys()){
      if(params.getAll(key).length!==1) return false;
      keys.add(key);
    }
  }catch{ return false; }
  return [...keys].every(key=>allowed.has(key));
}

function isSameOrigin(req){
  const origin=String(req?.headers?.origin||req?.headers?.Origin||'').trim();
  const host=String(req?.headers?.['x-forwarded-host']||req?.headers?.host||'').split(',')[0].trim();
  if(!origin||!host) return false;
  try{ return new URL(origin).host===host; }catch{ return false; }
}

function clientAddress(req){
  return String(req?.headers?.['x-forwarded-for']||req?.socket?.remoteAddress||'unknown')
    .split(',')[0].trim().slice(0,128)||'unknown';
}

function prepareRateKey(req){
  return createHmac('sha256',getJwtSecret())
    .update(`randori-invite-prepare-rate-v1\0${clientAddress(req)}`,'utf8')
    .digest('hex');
}

async function consumePrepareRateLimit(db,req){
  const now=Math.floor(Date.now()/1000);
  const expiresAt=now+PREPARE_RATE_WINDOW_SECONDS;
  try{
    await db.execute({
      sql:`DELETE FROM auth_rate_limits WHERE expires_at<=?`,
      args:[now],
    });
  }catch{
    // Expired-row cleanup is opportunistic; a cleanup failure must not bypass enforcement.
  }
  const result=await db.execute({
    sql:`INSERT INTO auth_rate_limits (key,attempts,expires_at) VALUES (?,1,?)
      ON CONFLICT(key) DO UPDATE SET
        attempts=CASE WHEN auth_rate_limits.expires_at<=? THEN 1 ELSE auth_rate_limits.attempts+1 END,
        expires_at=CASE WHEN auth_rate_limits.expires_at<=? THEN excluded.expires_at ELSE auth_rate_limits.expires_at END
      RETURNING attempts,expires_at`,
    args:[prepareRateKey(req),expiresAt,now,now],
  });
  const attempts=Number(result.rows?.[0]?.attempts);
  const storedExpiry=Number(result.rows?.[0]?.expires_at);
  if(!Number.isSafeInteger(attempts)||!Number.isSafeInteger(storedExpiry)) throw new Error('invalid rate limit state');
  return attempts>PREPARE_RATE_LIMIT
    ? {allowed:false,retryAfter:Math.max(1,Math.min(PREPARE_RATE_WINDOW_SECONDS,storedExpiry-now))}
    : {allowed:true,retryAfter:0};
}

async function authenticatedUserId(req){
  const payload=await verifyRequestAuth(req);
  const value=payload?.id??payload?.uid;
  return Number.isSafeInteger(value)&&value>0?value:null;
}

async function ownerContext(req,res){
  const userId=await authenticatedUserId(req);
  if(!userId){ res.status(401).json({error:'authentication required'}); return null; }
  let db;
  try{
    db=getClient();
    await ensureCircleMembershipReadiness(db);
    const membership=await getActivePrimaryCircleMembership(db,userId);
    if(!membership||membership.role!=='owner'){
      res.status(403).json({error:'circle owner required'});
      return null;
    }
    return {db,userId,membership};
  }catch(error){
    captureSentryException(error,{tags:{event:'circle_invitation_owner_check_fail',source:'server'}});
    res.status(503).json({error:'invitations unavailable'});
    return null;
  }
}

function invitationStatus(row,nowMs=Date.now()){
  if(row.revoked_at!=null) return 'revoked';
  if(row.used_at!=null||row.used_by!=null) return 'used';
  const expiresAt=Date.parse(String(row.expires_at||''));
  return Number.isFinite(expiresAt)&&expiresAt>nowMs?'pending':'expired';
}

async function handlePrepare(req,res){
  if(req.method!=='POST'){
    res.setHeader('Allow','POST');
    return res.status(405).json({error:'POST only'});
  }
  if(!isSameOrigin(req)) return res.status(403).json({error:'cross-origin mutation rejected'});
  // A failed same-origin replacement must not leave a previously prepared
  // capability live. Cross-origin requests cannot mutate invitation state.
  const claimCookieOptions={secure:!localIdentityAdapterEnabled(req)};
  res.setHeader('Set-Cookie',clearInviteClaimCookie(claimCookieOptions));
  if(!exactObject(req.body,['token'])||typeof req.body.token!=='string'){
    return res.status(400).json({error:'invitation unavailable'});
  }
  let db;
  try{
    db=getClient();
    await ensureCircleMembershipReadiness(db);
    const rate=await consumePrepareRateLimit(db,req);
    if(!rate.allowed){
      res.setHeader('Retry-After',String(rate.retryAfter));
      return res.status(429).json({error:'too many attempts',retry_after_seconds:rate.retryAfter});
    }
    const prepared=await prepareInvitationClaim(db,{token:req.body.token});
    if(!prepared.ok) return res.status(400).json({error:'invitation unavailable'});
    res.setHeader('Set-Cookie',[
      clearInviteClaimCookie(claimCookieOptions),
      inviteClaimCookie(prepared.claim,claimCookieOptions),
    ]);
    return res.json({ok:true,expires_in_seconds:INVITE_CLAIM_TTL_SECONDS});
  }catch(error){
    captureSentryException(error,{tags:{event:'circle_invitation_prepare_fail',source:'server'}});
    return res.status(503).json({error:'invitations unavailable'});
  }
}

async function handleCreate(req,res){
  if(!exactObject(req.body,['email'])) return res.status(400).json({error:'valid email required'});
  const email=normalizeInvitationEmail(req.body.email);
  if(!email) return res.status(400).json({error:'valid email required'});
  const context=await ownerContext(req,res);
  if(!context) return;
  const token=createInvitationToken();
  const tokenHash=hashInvitationToken(token);
  const emailHash=hashInvitationEmail(email);
  const id=randomUUID();
  const createdAt=new Date().toISOString();
  const expiresAt=new Date(Date.now()+INVITATION_TTL_SECONDS*1000).toISOString();
  try{
    const [created,audited]=await context.db.batch([{
      sql:`INSERT INTO circle_invitations
          (id,circle_id,token_hash,email_hash,created_by,created_at,expires_at)
        SELECT ?,membership.circle_id,?,?,?,?,?
        FROM circle_memberships membership JOIN circles circle ON circle.id=membership.circle_id
        WHERE membership.user_id=? AND membership.role='owner' AND membership.status='active'
          AND circle.is_primary=1 AND circle.archived_at IS NULL
        RETURNING id`,
      args:[id,tokenHash,emailHash,context.userId,createdAt,expiresAt,context.userId],
    },{
      sql:`INSERT INTO circle_audit_events
          (circle_id,event_type,actor_user_id,subject_user_id,invitation_id,dedupe_key,created_at)
        SELECT invitation.circle_id,'invitation.created',?,NULL,invitation.id,?,?
        FROM circle_invitations invitation
        JOIN circle_memberships membership ON membership.circle_id=invitation.circle_id
          AND membership.user_id=? AND membership.role='owner' AND membership.status='active'
        JOIN circles circle ON circle.id=invitation.circle_id
          AND circle.is_primary=1 AND circle.archived_at IS NULL
        WHERE invitation.id=?
        RETURNING id`,
      args:[context.userId,`invitation-created:${id}`,createdAt,context.userId,id],
    }], 'write');
    if(!created?.rows?.length||!audited?.rows?.length) return res.status(403).json({error:'circle owner required'});
    return res.status(201).json({
      ok:true,
      invitation:{
        id,
        email,
        expires_at:expiresAt,
        status:'pending',
        invite_url:`/invite#invite=${token}`,
      },
    });
  }catch(error){
    captureSentryException(error,{tags:{event:'circle_invitation_create_fail',source:'server'}});
    return res.status(503).json({error:'invitations unavailable'});
  }
}

async function handleList(req,res){
  const context=await ownerContext(req,res);
  if(!context) return;
  try{
    const result=await context.db.execute({
      sql:`WITH owner AS (
          SELECT membership.circle_id
          FROM circle_memberships membership JOIN circles circle ON circle.id=membership.circle_id
          WHERE membership.user_id=? AND membership.role='owner' AND membership.status='active'
            AND circle.is_primary=1 AND circle.archived_at IS NULL
          LIMIT 1
        )
	        SELECT invitation.id,invitation.email_hash,invitation.created_at,invitation.expires_at,
	          invitation.used_at,invitation.used_by,invitation.revoked_at
	        FROM owner LEFT JOIN circle_invitations invitation ON invitation.circle_id=owner.circle_id
	        ORDER BY invitation.created_at DESC,invitation.id DESC
	        LIMIT 200`,
      args:[context.userId],
    });
    if(!result.rows?.length) return res.status(403).json({error:'circle owner required'});
    const invitations=result.rows.filter(row=>row.id!=null).map(row=>({
      id:String(row.id),
      email_fingerprint:String(row.email_hash||'').slice(0,12),
      created_at:String(row.created_at),
      expires_at:String(row.expires_at),
      status:invitationStatus(row),
    }));
    return res.json({ok:true,invitations,count:invitations.length});
  }catch(error){
    captureSentryException(error,{tags:{event:'circle_invitation_list_fail',source:'server'}});
    return res.status(503).json({error:'invitations unavailable'});
  }
}

async function handleRevoke(req,res){
  const id=invitationId(req);
  if(!id) return res.status(404).json({error:'invitation not found'});
  const context=await ownerContext(req,res);
  if(!context) return;
  const revokedAt=new Date().toISOString();
  try{
    const [revoked,audited]=await context.db.batch([{
      sql:`UPDATE circle_invitations SET revoked_at=?
        WHERE id=? AND used_at IS NULL AND used_by IS NULL AND revoked_at IS NULL
          AND EXISTS (
            SELECT 1 FROM circle_memberships membership JOIN circles circle ON circle.id=membership.circle_id
            WHERE membership.circle_id=circle_invitations.circle_id AND membership.user_id=?
              AND membership.role='owner' AND membership.status='active'
              AND circle.is_primary=1 AND circle.archived_at IS NULL
          )
        RETURNING id,circle_id`,
      args:[revokedAt,id,context.userId],
    },{
      sql:`INSERT INTO circle_audit_events
          (circle_id,event_type,actor_user_id,subject_user_id,invitation_id,dedupe_key,created_at)
        SELECT invitation.circle_id,'invitation.revoked',?,NULL,invitation.id,?,?
        FROM circle_invitations invitation
        JOIN circle_memberships membership ON membership.circle_id=invitation.circle_id
          AND membership.user_id=? AND membership.role='owner' AND membership.status='active'
        JOIN circles circle ON circle.id=invitation.circle_id
          AND circle.is_primary=1 AND circle.archived_at IS NULL
        WHERE invitation.id=? AND invitation.revoked_at=?
        ON CONFLICT(dedupe_key) DO NOTHING
        RETURNING id`,
      args:[context.userId,`invitation-revoked:${id}`,revokedAt,context.userId,id,revokedAt],
    }], 'write');
    if(!revoked?.rows?.length) return res.status(404).json({error:'invitation not found'});
    if(!audited?.rows?.length) throw new Error('invitation revocation audit missing');
    return res.json({ok:true,id,status:'revoked'});
  }catch(error){
    captureSentryException(error,{tags:{event:'circle_invitation_revoke_fail',source:'server'}});
    return res.status(503).json({error:'invitations unavailable'});
  }
}

export default async function handler(req,res){
  res.setHeader('Cache-Control','private, no-store');
  res.setHeader('Pragma','no-cache');
  const requestedEndpoint=queryValue(req,'endpoint');
  const route=endpoint(req);
  if(!circleMembershipEnabled()) return res.status(404).json({error:'not found'});
  if(requestedEndpoint!==undefined&&requestedEndpoint!=='prepare'&&requestedEndpoint!=='invitations'){
    return res.status(400).json({error:'invalid request'});
  }
  if(route==='prepare'){
    if(!hasOnlyQueryKeys(req,new Set(['endpoint']))) return res.status(400).json({error:'invalid request'});
    return handlePrepare(req,res);
  }
  if(req.method!=='GET'&&!verifyMutationOrigin(req)) return res.status(403).json({error:'cross-origin mutation rejected'});
  if(req.method==='GET'){
    if(!hasOnlyQueryKeys(req,new Set(['endpoint']))) return res.status(400).json({error:'invalid request'});
    return handleList(req,res);
  }
  if(req.method==='POST'){
    if(!hasOnlyQueryKeys(req,new Set(['endpoint']))) return res.status(400).json({error:'invalid request'});
    return handleCreate(req,res);
  }
  if(req.method==='DELETE'){
    if(!hasOnlyQueryKeys(req,new Set(['endpoint','id']))) return res.status(400).json({error:'invalid request'});
    return handleRevoke(req,res);
  }
  res.setHeader('Allow','GET, POST, DELETE');
  return res.status(405).json({error:'GET, POST, or DELETE only'});
}
