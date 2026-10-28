// Account-deletion grace period (issue #372, ID-93), behind
// ACCOUNT_DELETION_GRACE_ENABLED on top of ACCOUNT_DELETION_ENABLED.
//
// Requesting deletion no longer tombstones the account straight away: it
// writes one row in account_deletion_requests (migration v23), revokes every
// session, and schedules deletion at request time + 14 days. While the row
// is active the account is locked: verifyRequestAuth in api/_db.js refuses
// it, pairing and email paths exclude it, and the owner roster shows it as
// leaving. A fresh sign-in issues a session that can only reach the cancel
// flow (api/auth.js verifies that session directly, never through
// verifyRequestAuth). Cancelling sets cancelled_at and restores the account
// exactly as it was — the request changed nothing else — and writes an
// audit event. A re-request after cancelling starts a new 14 days, and an
// expired invitation is never reopened by cancelling.
//
// The outbox cron (every 5 minutes) runs runAccountDeletionGraceJobs: due
// requests are executed with the existing deletion transaction
// (api/_account-deletion.js), with the last-owner / last-admin rules
// re-checked at execution time; a blocked request stays locked and each
// admin gets one blocked notification (outbox idempotency keys make every
// email exactly-once). Reminders are enqueued ~48h before deletion the
// same way. All three emails are account emails from hello@randoricircle.com
// (RESEND_FROM) with no unsubscribe link, and their payloads carry ids and
// instants only — the handler reads the address from the account at send
// time, so they are PII-free for outbox retention.
//
// Rollback rule: the flag gates new requests only. A pending request is a
// durable promise: turning the flag off stops new grace requests (they go
// back to immediate deletion) but pending requests still cancel and
// execute on schedule. That is why the lock and the job are driven by the
// pending row, not by the flag.
import { createOutboxEventStatement, OutboxDeliveryError, outboxStatementIdentity } from './_outbox.js';
import { schemaCapabilityAvailable } from './_schema-capability.js';
import { escapeHtml } from './_pairing.js';
import { emailProviderReason } from './_email-provider-reason.js';
import { getAdminEmails, verifySignedRequestAuth } from './_db.js';
import { requireRecentAuth } from './_recent-auth.js';
import {
  DELETED_ACCOUNT_PASSWORD_HASH,
  executeScheduledAccountDeletion,
  isDeletedAccount,
  readAccountDeletionEligibility,
} from './_account-deletion.js';

export const DELETION_GRACE_MIGRATION_VERSION=23;
export const DELETION_GRACE_DAYS=14;
export const DELETION_GRACE_SECONDS=DELETION_GRACE_DAYS*24*60*60;
export const DELETION_GRACE_REMINDER_SECONDS=48*60*60;
export const DELETION_GRACE_MAX_EXECUTIONS_PER_RUN=10;
export const DELETION_GRACE_MAX_REMINDERS_PER_RUN=100;
export const DELETION_GRACE_GRACE_FLAG='ACCOUNT_DELETION_GRACE_ENABLED';

export const ACCOUNT_DELETION_REQUESTED_AUDIT_EVENT='account.deletion_requested';
export const ACCOUNT_DELETION_CANCELLED_AUDIT_EVENT='account.deletion_cancelled';
export const ACCOUNT_DELETION_BLOCKED_AUDIT_EVENT='account.deletion_blocked';

export const ACCOUNT_DELETION_CONFIRMATION_EVENT_TYPE='account.deletion.confirmation';
export const ACCOUNT_DELETION_REMINDER_EVENT_TYPE='account.deletion.reminder';
export const ACCOUNT_DELETION_BLOCKED_EVENT_TYPE='account.deletion.blocked';
export const ACCOUNT_DELETION_EMAIL_EVENT_VERSION=1;
export const ACCOUNT_DELETION_EMAIL_TEMPLATE_VERSION=1;

const SESSION_HASH_PATTERN=/^[a-f0-9]{64}$/;

function positiveId(value){
  const number=Number(value);
  return Number.isSafeInteger(number)&&number>0?number:null;
}

function validNowSeconds(value){
  return Number.isSafeInteger(value)&&value>0?value:null;
}

export function accountDeletionGraceEnabled(env=process.env){
  return env?.ACCOUNT_DELETION_ENABLED==='true'
    &&env?.CIRCLE_MEMBERSHIP_ENABLED==='true'
    &&env?.ACCOUNT_DELETION_GRACE_ENABLED==='true';
}

/** True once migration v23 is recorded in the ledger with its exact contract. */
export function graceSchemaAvailable(db){
  return schemaCapabilityAvailable(db,{version:DELETION_GRACE_MIGRATION_VERSION});
}

/** The latest request row for an account, or null (including schema-not-installed). */
export async function readDeletionPending(db,userId){
  const id=positiveId(userId);
  if(!db||typeof db.execute!=='function'||!id) throw new TypeError('valid deletion pending query required');
  if(!await graceSchemaAvailable(db)) return null;
  const result=await db.execute({
    sql:`SELECT id,user_id,requested_at,scheduled_for,cancelled_at,executed_at
      FROM account_deletion_requests WHERE user_id=? ORDER BY id DESC LIMIT 1`,
    args:[id],
  });
  const row=result.rows?.[0];
  if(!row) return null;
  return Object.freeze({
    id:Number(row.id),user_id:Number(row.user_id),
    requested_at:Number(row.requested_at),scheduled_for:Number(row.scheduled_for),
    cancelled_at:row.cancelled_at==null?null:Number(row.cancelled_at),
    executed_at:row.executed_at==null?null:Number(row.executed_at),
  });
}

/** The active request row (neither cancelled nor executed), or null. */
export async function readActiveDeletionPending(db,userId){
  const row=await readDeletionPending(db,userId);
  if(!row||row.cancelled_at!==null||row.executed_at!==null) return null;
  return row;
}

export async function isDeletionPending(db,userId){
  return (await readActiveDeletionPending(db,userId))!==null;
}

export function deletionPendingScheduledAt(pending){
  if(!pending||!Number.isSafeInteger(pending.scheduled_for)||pending.scheduled_for<1){
    throw new TypeError('valid deletion pending request required');
  }
  return new Date(pending.scheduled_for*1000).toISOString();
}

/**
 * SQL fragment excluding accounts with an active deletion request. Callers
 * must first check graceSchemaAvailable: referencing the table before
 * migration v23 applies would fail the query. The column must be a bare
 * qualified column reference (validated here) — it is interpolated, never
 * a bound value.
 */
export function deletionPendingExclusionSql(userIdColumn){
  if(typeof userIdColumn!=='string'||!/^[A-Za-z_][A-Za-z0-9_.]*$/.test(userIdColumn)){
    throw new TypeError('valid deletion pending exclusion column required');
  }
  return `NOT EXISTS (SELECT 1 FROM account_deletion_requests pending
    WHERE pending.user_id=${userIdColumn}
      AND pending.cancelled_at IS NULL AND pending.executed_at IS NULL)`;
}

/**
 * Verifies a cancel-flow session without verifyRequestAuth, which refuses
 * locked accounts. The request revoked every session, so a live session
 * row proves a fresh sign-in after the request; the caller additionally
 * requires an active membership, so a member removed during the grace
 * period cannot cancel. Returns null for an unusable session (the handler
 * answers 401) and `{userId, sessionHash, pending}` otherwise, where
 * `pending` is null when there is no active request (the handler answers
 * 409 not_pending).
 */
export async function readDeletionCancelSession(db,req,{nowSeconds=Math.floor(Date.now()/1000)}={}){
  const signed=verifySignedRequestAuth(req,{nowSeconds});
  if(!signed||!db||typeof db.execute!=='function'||!validNowSeconds(nowSeconds)) return null;
  const session=await db.execute({
    sql:`SELECT user_id FROM auth_sessions
      WHERE session_hash=? AND user_id=? AND revoked_at IS NULL AND expires_at>? LIMIT 1`,
    args:[signed.sessionHash,signed.id,nowSeconds],
  });
  if(session.rows?.length!==1) return null;
  if(process.env.CIRCLE_MEMBERSHIP_ENABLED==='true'){
    const membership=await db.execute({
      sql:`SELECT 1 AS active FROM circle_memberships membership
        JOIN circles circle ON circle.id=membership.circle_id
        WHERE membership.user_id=? AND membership.status='active' AND circle.archived_at IS NULL
        LIMIT 1`,
      args:[signed.id],
    });
    if(membership.rows?.length!==1) return null;
  }
  return Object.freeze({userId:signed.id,sessionHash:signed.sessionHash,
    pending:await readActiveDeletionPending(db,signed.id)});
}

function formatDeletionDate(scheduledForSeconds){
  return new Intl.DateTimeFormat('en-GB',{
    day:'numeric',month:'long',year:'numeric',timeZone:'UTC',
  }).format(new Date(scheduledForSeconds*1000));
}

// ---------------------------------------------------------------------------
// Outbox events: account emails, ids and instants only.
// ---------------------------------------------------------------------------

export function createAccountDeletionConfirmationEvent({userId,requestedAt}={}){
  const id=positiveId(userId);
  const requested=validNowSeconds(requestedAt);
  if(!id||!requested) throw new TypeError('valid account deletion confirmation event required');
  return createOutboxEventStatement({
    eventType:ACCOUNT_DELETION_CONFIRMATION_EVENT_TYPE,
    eventVersion:ACCOUNT_DELETION_EMAIL_EVENT_VERSION,
    idempotencyKey:`account-deletion-confirmation/v1/${id}/${requested}`,
    payload:{recipient_user_id:id,user_id:id,scheduled_for:requested+DELETION_GRACE_SECONDS,
      template_version:ACCOUNT_DELETION_EMAIL_TEMPLATE_VERSION},
    maxAttempts:5,deliveryTimeoutMs:10_000,
  });
}

export function createAccountDeletionReminderEvent({userId,scheduledFor}={}){
  const id=positiveId(userId);
  const scheduled=validNowSeconds(scheduledFor);
  if(!id||!scheduled) throw new TypeError('valid account deletion reminder event required');
  return createOutboxEventStatement({
    eventType:ACCOUNT_DELETION_REMINDER_EVENT_TYPE,
    eventVersion:ACCOUNT_DELETION_EMAIL_EVENT_VERSION,
    idempotencyKey:`account-deletion-reminder/v1/${id}/${scheduled}`,
    payload:{recipient_user_id:id,user_id:id,scheduled_for:scheduled,
      template_version:ACCOUNT_DELETION_EMAIL_TEMPLATE_VERSION},
    maxAttempts:5,deliveryTimeoutMs:10_000,
  });
}

export function createAccountDeletionBlockedEvent({userId,scheduledFor,recipientUserId,reason}={}){
  const id=positiveId(userId);
  const scheduled=validNowSeconds(scheduledFor);
  const recipient=positiveId(recipientUserId);
  if(!id||!scheduled||!recipient||!['last_owner','last_admin'].includes(reason)){
    throw new TypeError('valid account deletion blocked event required');
  }
  return createOutboxEventStatement({
    eventType:ACCOUNT_DELETION_BLOCKED_EVENT_TYPE,
    eventVersion:ACCOUNT_DELETION_EMAIL_EVENT_VERSION,
    idempotencyKey:`account-deletion-blocked/v1/${id}/${scheduled}/${recipient}`,
    payload:{blocked_reason:reason,recipient_user_id:recipient,user_id:id,scheduled_for:scheduled,
      template_version:ACCOUNT_DELETION_EMAIL_TEMPLATE_VERSION},
    maxAttempts:5,deliveryTimeoutMs:10_000,
  });
}

function emailMetadata(event){
  const type=event.eventType;
  if(![ACCOUNT_DELETION_CONFIRMATION_EVENT_TYPE,ACCOUNT_DELETION_REMINDER_EVENT_TYPE,
    ACCOUNT_DELETION_BLOCKED_EVENT_TYPE].includes(type)){
    throw new OutboxDeliveryError('EVENT_TYPE_UNSUPPORTED',{retryable:false});
  }
  if(event.eventVersion!==ACCOUNT_DELETION_EMAIL_EVENT_VERSION){
    throw new OutboxDeliveryError('EVENT_VERSION_UNSUPPORTED',
      {retryable:event.eventVersion>ACCOUNT_DELETION_EMAIL_EVENT_VERSION});
  }
  const payload=event.payload;
  const expected=type===ACCOUNT_DELETION_BLOCKED_EVENT_TYPE
    ?'blocked_reason,recipient_user_id,scheduled_for,template_version,user_id'
    :'recipient_user_id,scheduled_for,template_version,user_id';
  if(!payload||typeof payload!=='object'||Array.isArray(payload)
    ||Object.keys(payload).sort().join(',')!==expected){
    throw new OutboxDeliveryError('PAYLOAD_INVALID',{retryable:false});
  }
  const userId=positiveId(payload.user_id);
  const recipientUserId=positiveId(payload.recipient_user_id);
  const scheduledFor=validNowSeconds(payload.scheduled_for);
  if(!userId||!recipientUserId||!scheduledFor
    ||Number(payload.template_version)!==ACCOUNT_DELETION_EMAIL_TEMPLATE_VERSION
    ||(type===ACCOUNT_DELETION_BLOCKED_EVENT_TYPE
      &&!['last_owner','last_admin'].includes(payload.blocked_reason))){
    throw new OutboxDeliveryError('PAYLOAD_INVALID',{retryable:false});
  }
  return Object.freeze({type,userId,recipientUserId,scheduledFor,
    reason:type===ACCOUNT_DELETION_BLOCKED_EVENT_TYPE?payload.blocked_reason:null});
}

function providerError(error){
  if(error instanceof OutboxDeliveryError) return error;
  const status=Number(error?.statusCode||error?.status||error?.response?.status||error?.error?.statusCode);
  if(status===429) return new OutboxDeliveryError('PROVIDER_RATE_LIMITED',{retryable:true,cause:error,providerReason:emailProviderReason(error)});
  if(status>=400&&status<=499) return new OutboxDeliveryError('PROVIDER_REJECTED',{retryable:false,cause:error,providerReason:emailProviderReason(error)});
  return new OutboxDeliveryError('PROVIDER_FAILED',{retryable:true,cause:error,providerReason:emailProviderReason(error)});
}

/**
 * One handler for all three account-deletion emails. Each delivery re-reads
 * the account and the active pending row and suppresses when the request is
 * gone, cancelled, executed, superseded (a different scheduled_for), or the
 * recipient is no longer the right recipient — so a stale queued email can
 * never reach the wrong state. No unsubscribe link: these are account emails.
 */
export function createAccountDeletionEmailHandler({db,baseUrl,send}={}){
  if(!db||typeof db.execute!=='function'||typeof send!=='function'){
    throw new TypeError('account deletion email database and provider are required');
  }
  let origin;
  try{ origin=new URL(String(baseUrl)).origin; }catch{ throw new TypeError('valid account deletion email base URL required'); }
  return async(event,{signal}={})=>{
    const metadata=emailMetadata(event);
    const pending=await readActiveDeletionPending(db,metadata.userId);
    if(!pending||pending.scheduled_for!==metadata.scheduledFor){
      return {status:'suppressed',reasonCode:'ACCOUNT_DELETION_NOT_PENDING'};
    }
    if(metadata.type===ACCOUNT_DELETION_BLOCKED_EVENT_TYPE){
      const recipient=await db.execute({
        sql:`SELECT account.email,account.is_admin,account.is_demo
          FROM auth_accounts account WHERE account.id=? LIMIT 1`,
        args:[metadata.recipientUserId],
      });
      const row=recipient.rows?.[0];
      const configuredAdmin=getAdminEmails().has(String(row?.email||'').trim().toLowerCase());
      if(!row||Number(row.is_demo)===1||(Number(row.is_admin)!==1&&!configuredAdmin)){
        return {status:'suppressed',reasonCode:'ACCOUNT_DELETION_RECIPIENT_NOT_ADMIN'};
      }
      const subject=await db.execute({
        sql:`SELECT display_name FROM auth_accounts WHERE id=? AND password_hash<>? LIMIT 1`,
        args:[metadata.userId,DELETED_ACCOUNT_PASSWORD_HASH],
      });
      const name=String(subject.rows?.[0]?.display_name||'A member').slice(0,80);
      const reasonText=metadata.reason==='last_owner'
        ?'they are the only owner of a circle'
        :'they are the only app admin';
      try{
        const delivery=await send({
          to:String(row.email).trim().toLowerCase(),
          subject:'A Randori Circle account deletion is blocked',
          html:`<h2>Account deletion blocked</h2><p>The scheduled deletion of ${escapeHtml(name)} could not run because ${escapeHtml(reasonText)}. The account stays locked.</p><p>It was scheduled for deletion on ${escapeHtml(formatDeletionDate(metadata.scheduledFor))}.</p><p>Make another member an owner or app admin, or archive the circle, and the deletion will run on the next scheduled check.</p>`,
          idempotencyKey:event.idempotencyKey,signal,
        });
        if(delivery?.error) throw delivery.error;
        return {status:'delivered',providerName:String(delivery?.providerName||'email').slice(0,100),
          providerMessageId:delivery?.providerMessageId||delivery?.data?.id||null};
      }catch(error){ throw providerError(error); }
    }
    const account=await db.execute({
      sql:`SELECT email FROM auth_accounts WHERE id=? AND password_hash<>? LIMIT 1`,
      args:[metadata.userId,DELETED_ACCOUNT_PASSWORD_HASH],
    });
    const recipient=String(account.rows?.[0]?.email||'').trim().toLowerCase();
    if(!recipient||!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(recipient)){
      return {status:'suppressed',reasonCode:'RECIPIENT_EMAIL_INVALID'};
    }
    const date=formatDeletionDate(metadata.scheduledFor);
    const isReminder=metadata.type===ACCOUNT_DELETION_REMINDER_EVENT_TYPE;
    const subject=isReminder
      ?'Your Randori Circle account will be deleted in about 48 hours'
      :'Your Randori Circle account is scheduled for deletion';
    const html=isReminder
      ?`<h2>Your account will be deleted in about 48 hours</h2><p>Your Randori Circle account is scheduled for deletion on <b>${escapeHtml(date)}</b>.</p><p>To keep your account, sign in before then and choose Cancel deletion.</p><p><a href="${escapeHtml(origin)}">Sign in to Randori Circle</a></p>`
      :`<h2>Your account is scheduled for deletion</h2><p>Your Randori Circle account is scheduled for deletion on <b>${escapeHtml(date)}</b>.</p><p>It is locked until then: you are signed out on every device, and it will not be paired or emailed.</p><p>To cancel, sign in any time before that date and choose Cancel deletion.</p><p><a href="${escapeHtml(origin)}">Sign in to Randori Circle</a></p><p>If you did not ask for this, sign in as soon as you can to cancel it.</p>`;
    try{
      const delivery=await send({to:recipient,subject,html,idempotencyKey:event.idempotencyKey,signal});
      if(delivery?.error) throw delivery.error;
      return {status:'delivered',providerName:String(delivery?.providerName||'email').slice(0,100),
        providerMessageId:delivery?.providerMessageId||delivery?.data?.id||null};
    }catch(error){ throw providerError(error); }
  };
}

// ---------------------------------------------------------------------------
// Request / cancel
// ---------------------------------------------------------------------------

async function readAccount(executor,userId){
  const result=await executor.execute({
    sql:`SELECT id,email,password_hash,is_admin,is_demo FROM auth_accounts WHERE id=? LIMIT 2`,
    args:[userId],
  });
  return result.rows?.length===1?result.rows[0]:null;
}

function auditStatements({userId,eventType,requestedAt,occurredAt}){
  return {
    sql:`INSERT INTO circle_audit_events
        (circle_id,event_type,actor_user_id,subject_user_id,invitation_id,dedupe_key,created_at)
      SELECT circle_id,?,?,?,NULL,?||':'||circle_id||':'||?,?
      FROM circle_memberships WHERE user_id=?
      ON CONFLICT(dedupe_key) DO NOTHING`,
    // The id is concatenated as text: a bound number would read as '2.0'.
    args:[eventType,userId,userId,eventType,requestedAt,occurredAt,userId],
  };
}

async function rollback(transaction){
  try{ await transaction.rollback(); }catch{}
}

/**
 * Schedules a deletion: same recent-auth proof and last-owner / last-admin
 * eligibility as immediate deletion, checked inside the write transaction.
 * Only the pending row, the session revocation, the audit event and the
 * confirmation email are written — no personal data is touched, so
 * cancelling restores the account exactly as it was.
 */
export async function requestAccountDeletion(db,{
  userId,sessionHash,adminEmails=[],nowSeconds=Math.floor(Date.now()/1000),
}={}){
  const id=positiveId(userId);
  if(!db||typeof db.transaction!=='function'||!id||!SESSION_HASH_PATTERN.test(String(sessionHash))
    ||!validNowSeconds(nowSeconds)){
    throw new TypeError('valid account deletion request required');
  }
  const occurredAt=new Date(nowSeconds*1000).toISOString();
  const scheduledFor=nowSeconds+DELETION_GRACE_SECONDS;
  const transaction=await db.transaction('write');
  let finished=false;
  const stop=async result=>{
    await rollback(transaction); finished=true;
    return Object.freeze(result);
  };
  try{
    const account=await readAccount(transaction,id);
    if(!account) return await stop({ok:false,reason:'not_found'});
    if(isDeletedAccount(account)) return await stop({ok:true,status:'already_deleted'});
    const existing=await transaction.execute({
      sql:`SELECT requested_at,scheduled_for FROM account_deletion_requests
        WHERE user_id=? AND cancelled_at IS NULL AND executed_at IS NULL LIMIT 1`,
      args:[id],
    });
    if(existing.rows?.length===1){
      return await stop({ok:false,reason:'already_pending',
        scheduled_for:new Date(Number(existing.rows[0].scheduled_for)*1000).toISOString()});
    }
    await requireRecentAuth(transaction,{id,sessionHash},{nowSeconds});
    const eligibility=await readAccountDeletionEligibility(transaction,{userId:id,adminEmails});
    if(!eligibility.ok) return await stop(eligibility);
    // Insert first, alone: a concurrent request loses the partial unique
    // index race and is answered already_pending instead of erroring.
    const inserted=await transaction.execute({
      sql:`INSERT INTO account_deletion_requests (user_id,requested_at,scheduled_for)
        VALUES (?,?,?) ON CONFLICT(user_id) WHERE cancelled_at IS NULL AND executed_at IS NULL DO NOTHING`,
      args:[id,nowSeconds,scheduledFor],
    });
    if(Number(inserted.rowsAffected||0)!==1){
      const raced=await transaction.execute({
        sql:`SELECT scheduled_for FROM account_deletion_requests
          WHERE user_id=? AND cancelled_at IS NULL AND executed_at IS NULL LIMIT 1`,
        args:[id],
      });
      return await stop({ok:false,reason:'already_pending',
        scheduled_for:raced.rows?.length===1
          ?new Date(Number(raced.rows[0].scheduled_for)*1000).toISOString():null});
    }
    const confirmation=createAccountDeletionConfirmationEvent({userId:id,requestedAt:nowSeconds});
    await transaction.batch([
      {sql:`UPDATE auth_sessions SET revoked_at=MAX(?,created_at),revocation_reason='logout_all'
        WHERE user_id=? AND revoked_at IS NULL AND expires_at>?`,
      args:[nowSeconds,id,nowSeconds]},
      {sql:`DELETE FROM auth_recent_proofs WHERE user_id=?`,args:[id]},
      auditStatements({userId:id,eventType:ACCOUNT_DELETION_REQUESTED_AUDIT_EVENT,
        requestedAt:`${nowSeconds}`,occurredAt}),
      confirmation,
    ]);
    await transaction.commit(); finished=true;
    return Object.freeze({ok:true,status:'pending_deletion',
      scheduled_for:new Date(scheduledFor*1000).toISOString(),
      requested_at:occurredAt,
      outboxEvents:Object.freeze([outboxStatementIdentity(confirmation)])});
  }catch(error){
    if(!finished) await rollback(transaction);
    throw error;
  }
}

/**
 * Cancels a pending deletion. The caller (api/auth.js) must first verify a
 * live session for the account that postdates the request — every session
 * was revoked when the request was made, so a live session proves a fresh
 * sign-in — and that the account still holds an active membership, so a
 * member an owner removed during the grace period cannot cancel and is
 * still deleted on schedule. Cancelling changes nothing else: no
 * invitation is reopened and no membership is restored.
 */
export async function cancelAccountDeletion(db,{
  userId,sessionHash,nowSeconds=Math.floor(Date.now()/1000),
}={}){
  const id=positiveId(userId);
  if(!db||typeof db.transaction!=='function'||!id||!SESSION_HASH_PATTERN.test(String(sessionHash))
    ||!validNowSeconds(nowSeconds)){
    throw new TypeError('valid account deletion cancellation required');
  }
  const occurredAt=new Date(nowSeconds*1000).toISOString();
  const transaction=await db.transaction('write');
  let finished=false;
  const stop=async result=>{
    await rollback(transaction); finished=true;
    return Object.freeze(result);
  };
  try{
    const account=await readAccount(transaction,id);
    if(!account) return await stop({ok:false,reason:'not_found'});
    if(isDeletedAccount(account)) return await stop({ok:true,status:'already_deleted'});
    const pending=await transaction.execute({
      sql:`SELECT id,requested_at,scheduled_for FROM account_deletion_requests
        WHERE user_id=? AND cancelled_at IS NULL AND executed_at IS NULL LIMIT 1`,
      args:[id],
    });
    if(pending.rows?.length!==1) return await stop({ok:false,reason:'not_pending'});
    await requireRecentAuth(transaction,{id,sessionHash},{nowSeconds});
    const cancelled=await transaction.execute({
      sql:`UPDATE account_deletion_requests SET cancelled_at=?
        WHERE id=? AND cancelled_at IS NULL AND executed_at IS NULL`,
      args:[nowSeconds,Number(pending.rows[0].id)],
    });
    if(Number(cancelled.rowsAffected||0)!==1) throw new Error('account deletion cancellation failed');
    await transaction.execute(auditStatements({userId:id,
      eventType:ACCOUNT_DELETION_CANCELLED_AUDIT_EVENT,
      requestedAt:`${Number(pending.rows[0].requested_at)}`,occurredAt}));
    await transaction.commit(); finished=true;
    return Object.freeze({ok:true,status:'cancelled',
      scheduled_for:new Date(Number(pending.rows[0].scheduled_for)*1000).toISOString(),
      requested_at:new Date(Number(pending.rows[0].requested_at)*1000).toISOString()});
  }catch(error){
    if(!finished) await rollback(transaction);
    throw error;
  }
}

// ---------------------------------------------------------------------------
// Cron job (outbox cron, every 5 minutes)
// ---------------------------------------------------------------------------

async function enqueueGraceEvent(db,statement){
  const result=await db.execute(statement);
  return Number(result.rowsAffected||0)===1;
}

async function adminUserIds(db,{adminEmails=[]}={}){
  const ids=new Set();
  const configured=adminEmails.map(email=>String(email).trim().toLowerCase()).filter(Boolean);
  const result=await db.execute({
    sql:`SELECT DISTINCT account.id FROM auth_accounts account
      JOIN circle_memberships membership ON membership.user_id=account.id
      JOIN circles circle ON circle.id=membership.circle_id
      WHERE account.is_admin=1 AND COALESCE(account.is_demo,0)=0
        AND membership.status='active' AND circle.archived_at IS NULL`,
  });
  for(const row of result.rows||[]) ids.add(Number(row.id));
  for(const email of configured){
    const found=await db.execute({
      sql:`SELECT id FROM auth_accounts WHERE lower(email)=? AND COALESCE(is_demo,0)=0 LIMIT 1`,
      args:[email],
    });
    if(found.rows?.length===1) ids.add(Number(found.rows[0].id));
  }
  return ids;
}

/**
 * Bounded, idempotent grace-period work for one outbox-cron invocation:
 * execute due deletions (last-owner / last-admin re-checked inside each
 * execution), notify admins once when an execution is blocked, and enqueue
 * one 48h reminder per request entering its reminder window. A per-account
 * failure is counted and skipped, never stops the rest. Controlled clock
 * via nowSeconds for tests.
 */
export async function runAccountDeletionGraceJobs(db,{
  nowSeconds=Math.floor(Date.now()/1000),adminEmails=[],hashInvitationEmail,
  maxExecutions=DELETION_GRACE_MAX_EXECUTIONS_PER_RUN,
  maxReminders=DELETION_GRACE_MAX_REMINDERS_PER_RUN,
}={}){
  const now=validNowSeconds(nowSeconds);
  if(!db||typeof db.execute!=='function'||typeof db.transaction!=='function'||!now
    ||typeof hashInvitationEmail!=='function'
    ||!Number.isSafeInteger(maxExecutions)||maxExecutions<1
    ||!Number.isSafeInteger(maxReminders)||maxReminders<1){
    throw new TypeError('valid account deletion grace job required');
  }
  const zero=Object.freeze({ok:true,ran:false,reason:'schema_unavailable',
    executed:0,blocked:0,blocked_notifications:0,reminders_queued:0,skipped:0,
    errors:Object.freeze([])});
  if(!await graceSchemaAvailable(db)) return zero;
  const errors=[];
  let executed=0,blocked=0,blockedNotifications=0,remindersQueued=0,skipped=0;
  const due=await db.execute({
    sql:`SELECT id,user_id,requested_at,scheduled_for FROM account_deletion_requests
      WHERE cancelled_at IS NULL AND executed_at IS NULL AND scheduled_for<=?
      ORDER BY scheduled_for,id LIMIT ?`,
    args:[now,maxExecutions],
  });
  for(const row of due.rows||[]){
    const userId=Number(row.user_id);
    const scheduledFor=Number(row.scheduled_for);
    try{
      const result=await executeScheduledAccountDeletion(db,{
        userId,adminEmails,hashInvitationEmail,nowSeconds:now,
      });
      if(result.ok&&result.status==='deleted'){ executed+=1; continue; }
      if(result.reason==='last_owner'||result.reason==='last_admin'){
        blocked+=1;
        try{
          await db.execute(auditStatements({userId,
            eventType:ACCOUNT_DELETION_BLOCKED_AUDIT_EVENT,
            requestedAt:`${Number(row.requested_at)}`,
            occurredAt:new Date(now*1000).toISOString()}));
          const admins=await adminUserIds(db,{adminEmails});
          for(const adminId of [...admins].sort((a,b)=>a-b)){
            if(adminId===userId) continue;
            const created=await enqueueGraceEvent(db,createAccountDeletionBlockedEvent({
              userId,scheduledFor,recipientUserId:adminId,reason:result.reason}));
            if(created) blockedNotifications+=1;
          }
        }catch(error){
          errors.push(Object.freeze({user_id:userId,code:'blocked_notification_failed'}));
        }
        continue;
      }
      skipped+=1;
    }catch(error){
      errors.push(Object.freeze({user_id:userId,code:'execution_failed'}));
    }
  }
  const reminderRows=await db.execute({
    sql:`SELECT user_id,scheduled_for FROM account_deletion_requests
      WHERE cancelled_at IS NULL AND executed_at IS NULL
        AND scheduled_for>? AND scheduled_for<=?
      ORDER BY scheduled_for,id LIMIT ?`,
    args:[now,now+DELETION_GRACE_REMINDER_SECONDS,maxReminders],
  });
  for(const row of reminderRows.rows||[]){
    try{
      const created=await enqueueGraceEvent(db,createAccountDeletionReminderEvent({
        userId:Number(row.user_id),scheduledFor:Number(row.scheduled_for)}));
      if(created) remindersQueued+=1;
    }catch{
      errors.push(Object.freeze({user_id:Number(row.user_id),code:'reminder_failed'}));
    }
  }
  return Object.freeze({ok:true,ran:true,reason:null,executed,blocked,
    blocked_notifications:blockedNotifications,reminders_queued:remindersQueued,
    skipped,errors:Object.freeze(errors)});
}
