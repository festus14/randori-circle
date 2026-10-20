import { createHmac, randomUUID } from 'node:crypto';

import { getJwtSecret } from './_db.js';
import {
  INVITATION_TTL_SECONDS,
  createInvitationToken,
  hashInvitationEmail,
  hashInvitationToken,
  normalizeNewInvitationEmail,
} from './_circle-membership.js';
import { createInvitationEmailEvent } from './_invitation-email.js';

/** Owner-created invitations allowed per circle in a fixed 24-hour window (ID-68). */
export const INVITATION_CREATE_DAILY_LIMIT=200;
export const INVITATION_CREATE_WINDOW_SECONDS=24*60*60;

function invitationQuotaKey(circleId){
  return createHmac('sha256',getJwtSecret())
    .update(`randori-invitation-create-circle-v1\0${circleId}`,'utf8')
    .digest('hex');
}

function quotaCircle(circleId){
  const circle=Number(circleId);
  if(!Number.isSafeInteger(circle)||circle<1) throw new TypeError('valid invitation quota circle required');
  return circle;
}

/**
 * Read the circle's remaining invitation quota without consuming it. Used to
 * reject a whole bulk request up front instead of half-creating it.
 * Returns `{remaining,retryAfter,limit}`; `retryAfter` is seconds until the
 * current window resets (0 when no window is open).
 */
export async function invitationQuotaState(db,{circleId,nowSeconds=Math.floor(Date.now()/1000)}={}){
  const circle=quotaCircle(circleId);
  const result=await db.execute({
    sql:`SELECT attempts,expires_at FROM auth_rate_limits WHERE key=? LIMIT 1`,
    args:[invitationQuotaKey(circle)],
  });
  const row=result.rows?.[0];
  if(!row) return Object.freeze({remaining:INVITATION_CREATE_DAILY_LIMIT,retryAfter:0,limit:INVITATION_CREATE_DAILY_LIMIT});
  const attempts=Number(row.attempts);
  const expiresAt=Number(row.expires_at);
  if(!Number.isSafeInteger(attempts)||!Number.isSafeInteger(expiresAt)) throw new Error('invalid invitation quota state');
  if(expiresAt<=nowSeconds) return Object.freeze({remaining:INVITATION_CREATE_DAILY_LIMIT,retryAfter:0,limit:INVITATION_CREATE_DAILY_LIMIT});
  return Object.freeze({
    remaining:Math.max(0,INVITATION_CREATE_DAILY_LIMIT-attempts),
    retryAfter:Math.max(1,Math.min(INVITATION_CREATE_WINDOW_SECONDS,expiresAt-nowSeconds)),
    limit:INVITATION_CREATE_DAILY_LIMIT,
  });
}

/**
 * Consume `count` invitations from the circle's daily quota inside the
 * caller's write transaction, so a rollback refunds it. The conditional
 * upsert never over-consumes: when the window is full nothing is written and
 * `{ok:false,retryAfter}` is returned.
 */
export async function reserveInvitationQuota(transaction,{circleId,count=1,nowSeconds=Math.floor(Date.now()/1000)}={}){
  const circle=quotaCircle(circleId);
  if(!Number.isSafeInteger(count)||count<1||count>INVITATION_CREATE_DAILY_LIMIT){
    throw new TypeError('valid invitation quota count required');
  }
  const result=await transaction.execute({
    sql:`INSERT INTO auth_rate_limits (key,attempts,expires_at) VALUES (?,?,?)
      ON CONFLICT(key) DO UPDATE SET
        attempts=CASE WHEN auth_rate_limits.expires_at<=? THEN excluded.attempts
          ELSE auth_rate_limits.attempts+excluded.attempts END,
        expires_at=CASE WHEN auth_rate_limits.expires_at<=? THEN excluded.expires_at
          ELSE auth_rate_limits.expires_at END
      WHERE auth_rate_limits.expires_at<=? OR auth_rate_limits.attempts+excluded.attempts<=?
      RETURNING attempts,expires_at`,
    args:[invitationQuotaKey(circle),count,nowSeconds+INVITATION_CREATE_WINDOW_SECONDS,
      nowSeconds,nowSeconds,nowSeconds,INVITATION_CREATE_DAILY_LIMIT],
  });
  if(result.rows?.length===1) return Object.freeze({ok:true,retryAfter:0});
  const state=await invitationQuotaState(transaction,{circleId:circle,nowSeconds});
  return Object.freeze({ok:false,retryAfter:Math.max(1,state.retryAfter)});
}

/**
 * Write one single-use, email-bound circle invitation inside the caller's
 * write transaction. This is the only invitation creation path: the owner
 * "invite by email" API and an approved invite request both use it, so the
 * owner check, audit row, and optional email intent can never diverge.
 *
 * Returns `{ok:false}` when the actor is not an active owner of the active
 * circle (nothing is written). The caller owns commit/rollback and must pass
 * `emailStatement` to `deliverCommittedOutboxEvents` only after commit.
 */
export async function insertOwnerInvitation(transaction,{
  ownerUserId,circleId,email,emailConfiguration=null,localRuntime=false,
  now=Date.now(),
}={}){
  if(!transaction||typeof transaction.execute!=='function') throw new TypeError('transaction is required');
  // New invitations use the strict shared rules (assets/email-validation.js).
  const recipient=normalizeNewInvitationEmail(email);
  const owner=Number(ownerUserId);
  const circle=Number(circleId);
  if(!recipient||!Number.isSafeInteger(owner)||owner<1||!Number.isSafeInteger(circle)||circle<1){
    throw new TypeError('valid invitation request required');
  }
  const token=createInvitationToken();
  const tokenHash=hashInvitationToken(token);
  const emailHash=hashInvitationEmail(recipient);
  const id=randomUUID();
  const createdAt=new Date(now).toISOString();
  const expiresAt=new Date(now+INVITATION_TTL_SECONDS*1000).toISOString();
  const created=await transaction.execute({
    sql:`INSERT INTO circle_invitations
      (id,circle_id,token_hash,email_hash,created_by,created_at,expires_at)
    SELECT ?,membership.circle_id,?,?,?,?,?
    FROM circle_memberships membership JOIN circles circle ON circle.id=membership.circle_id
    WHERE membership.user_id=? AND membership.role='owner' AND membership.status='active'
      AND membership.circle_id=? AND circle.archived_at IS NULL
    RETURNING id,circle_id`,
    args:[id,tokenHash,emailHash,owner,createdAt,expiresAt,owner,circle],
  });
  if(!created?.rows?.length) return Object.freeze({ok:false});
  const audited=await transaction.execute({
    sql:`INSERT INTO circle_audit_events
      (circle_id,event_type,actor_user_id,subject_user_id,invitation_id,dedupe_key,created_at)
    SELECT invitation.circle_id,'invitation.created',?,NULL,invitation.id,?,?
    FROM circle_invitations invitation
    JOIN circle_memberships membership ON membership.circle_id=invitation.circle_id
      AND membership.user_id=? AND membership.role='owner' AND membership.status='active'
    JOIN circles circle ON circle.id=invitation.circle_id
      AND circle.id=? AND circle.archived_at IS NULL
    WHERE invitation.id=?
    RETURNING id`,
    args:[owner,`invitation-created:${id}`,createdAt,owner,circle,id],
  });
  if(!audited?.rows?.length) throw new Error('invitation creation audit missing');
  let emailStatement=null;
  if(emailConfiguration){
    emailStatement=createInvitationEmailEvent({
      invitationId:id,circleId:Number(created.rows[0].circle_id),actorUserId:owner,
      email:recipient,token,sendSequence:1,localRuntime,
    });
    const queued=await transaction.execute(emailStatement);
    if(Number(queued.rowsAffected||0)!==1) throw new Error('invitation email intent missing');
  }
  return Object.freeze({
    ok:true,
    invitation:Object.freeze({id,email:recipient,expiresAt,token,circleId:Number(created.rows[0].circle_id)}),
    emailStatement,
    emailQueued:emailStatement!==null,
  });
}
