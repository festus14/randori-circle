import { randomUUID } from 'node:crypto';

import {
  INVITATION_TTL_SECONDS,
  createInvitationToken,
  hashInvitationEmail,
  hashInvitationToken,
  normalizeInvitationEmail,
} from './_circle-membership.js';
import { createInvitationEmailEvent } from './_invitation-email.js';

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
  const recipient=normalizeInvitationEmail(email);
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
