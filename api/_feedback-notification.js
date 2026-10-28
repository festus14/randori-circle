import { escapeHtml } from './_pairing.js';
import { createOutboxEventStatement, OutboxDeliveryError } from './_outbox.js';
import { emailProviderReason } from './_email-provider-reason.js';
import { getAdminEmails } from './_db.js';
import { isDeletionPending } from './_account-deletion-grace.js';
import {
  FEEDBACK_KINDS,
  feedbackEnabled,
} from './_feedback-config.js';

// Admin notification for a new feedback submission (#353). Versioned
// outbox payload v1:
//   {feedback_id, circle_id, author_user_id, recipient_user_id, kind,
//    title, template_version:1}
// The payload and the rendered email carry the (redacted) kind and title
// and a link to the triage view — never the body, which may contain
// personal data. One event per admin recipient, so each admin's delivery
// is idempotent on its own key and a failed send to one admin does not
// block the others.

export const FEEDBACK_SUBMITTED_EVENT_TYPE='feedback.submitted';
export const FEEDBACK_SUBMITTED_EVENT_VERSION=1;
export const FEEDBACK_SUBMITTED_TEMPLATE_VERSION=1;

const UUID_PATTERN=/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export const FEEDBACK_KIND_LABELS=Object.freeze({
  bug:'bug report',
  feature_request:'feature request',
  feedback:'feedback',
});

function configuredOrigin({localRuntime=false,env=process.env}={}){
  let url;
  try{ url=new URL(String(env.APP_URL||'')); }catch{ return null; }
  const loopback=['localhost','127.0.0.1','[::1]'].includes(url.hostname.toLowerCase());
  if(url.username||url.password||url.search||url.hash||(url.pathname&&url.pathname!=='/')) return null;
  if(localRuntime){
    if(env.NODE_ENV!=='development'||url.protocol!=='http:'||!loopback) return null;
  }else if(env.NODE_ENV!=='production'||url.protocol!=='https:'||loopback){
    return null;
  }
  return url.origin;
}

/** Admin notifications are queued only when they can actually be delivered. */
export function feedbackNotificationConfiguration({localRuntime=false,env=process.env}={}){
  if(!feedbackEnabled(env)) return null;
  if(!localRuntime&&(!String(env.RESEND_API_KEY||'').trim()||!String(env.RESEND_FROM||'').trim())) return null;
  const origin=configuredOrigin({localRuntime,env});
  return origin?Object.freeze({origin,localRuntime}):null;
}

export function createFeedbackSubmittedEvent({feedbackId,circleId,authorUserId,recipientUserId,kind,title}={}){
  const id=String(feedbackId||'').toLowerCase();
  const circle=Number(circleId);
  const author=Number(authorUserId);
  const recipient=Number(recipientUserId);
  const summary=typeof title==='string'?title:'';
  if(!UUID_PATTERN.test(id)||!Number.isSafeInteger(circle)||circle<1
    ||!Number.isSafeInteger(author)||author<1||!Number.isSafeInteger(recipient)||recipient<1
    ||!FEEDBACK_KINDS.includes(kind)||summary.length<1||summary.length>120){
    throw new TypeError('valid feedback submitted notification required');
  }
  return createOutboxEventStatement({
    eventType:FEEDBACK_SUBMITTED_EVENT_TYPE,eventVersion:FEEDBACK_SUBMITTED_EVENT_VERSION,
    // One event per feedback item per admin: a retry replays the same row
    // instead of queuing a duplicate email.
    idempotencyKey:`feedback-submitted/v1/${id}/${recipient}`,
    payload:{feedback_id:id,circle_id:circle,author_user_id:author,recipient_user_id:recipient,
      kind,title:summary,template_version:FEEDBACK_SUBMITTED_TEMPLATE_VERSION},
    maxAttempts:5,deliveryTimeoutMs:10_000,
  });
}

function notificationMetadata(event){
  if(event.eventVersion!==FEEDBACK_SUBMITTED_EVENT_VERSION){
    throw new OutboxDeliveryError('EVENT_VERSION_UNSUPPORTED',{retryable:event.eventVersion>FEEDBACK_SUBMITTED_EVENT_VERSION});
  }
  const payload=event.payload;
  if(!payload||typeof payload!=='object'||Array.isArray(payload)
    ||Object.keys(payload).sort().join(',')!=='author_user_id,circle_id,feedback_id,kind,recipient_user_id,template_version,title'){
    throw new OutboxDeliveryError('PAYLOAD_INVALID',{retryable:false});
  }
  const feedbackId=String(payload.feedback_id||'').toLowerCase();
  const circleId=Number(payload.circle_id);
  const authorUserId=Number(payload.author_user_id);
  const recipientUserId=Number(payload.recipient_user_id);
  const kind=String(payload.kind);
  const title=typeof payload.title==='string'?payload.title:'';
  if(!UUID_PATTERN.test(feedbackId)||!Number.isSafeInteger(circleId)||circleId<1
    ||!Number.isSafeInteger(authorUserId)||authorUserId<1
    ||!Number.isSafeInteger(recipientUserId)||recipientUserId<1
    ||!FEEDBACK_KINDS.includes(kind)||title.length<1||title.length>120
    ||Number(payload.template_version)!==FEEDBACK_SUBMITTED_TEMPLATE_VERSION){
    throw new OutboxDeliveryError('PAYLOAD_INVALID',{retryable:false});
  }
  return Object.freeze({feedbackId,circleId,authorUserId,recipientUserId,kind,title});
}

function providerError(error){
  if(error instanceof OutboxDeliveryError) return error;
  const status=Number(error?.statusCode||error?.status||error?.response?.status||error?.error?.statusCode);
  if(status===429) return new OutboxDeliveryError('PROVIDER_RATE_LIMITED',{retryable:true,cause:error,providerReason:emailProviderReason(error)});
  if(status>=400&&status<=499) return new OutboxDeliveryError('PROVIDER_REJECTED',{retryable:false,cause:error,providerReason:emailProviderReason(error)});
  return new OutboxDeliveryError('PROVIDER_FAILED',{retryable:true,cause:error,providerReason:emailProviderReason(error)});
}

function validBaseOrigin(baseUrl,localRuntime){
  let parsed;
  try{ parsed=new URL(String(baseUrl)); }catch{ return null; }
  const loopback=['localhost','127.0.0.1','[::1]'].includes(parsed.hostname.toLowerCase());
  if(parsed.username||parsed.password||parsed.search||parsed.hash||(parsed.pathname&&parsed.pathname!=='/')
    ||(localRuntime?parsed.protocol!=='http:'||!loopback:parsed.protocol!=='https:'||loopback)){
    return null;
  }
  return parsed.origin;
}

/**
 * Admin notification: the email carries only the kind, the redacted title
 * and a link to the triage view. The body is never emailed. At delivery
 * the handler re-reads state and suppresses when the item is gone, the
 * recipient is no longer an app admin, or they have email notifications
 * switched off.
 */
export function createFeedbackSubmittedHandler({db,baseUrl,send,localRuntime=false}={}){
  if(!db||typeof db.execute!=='function'||typeof send!=='function'){
    throw new TypeError('feedback submitted notification database and provider are required');
  }
  const origin=validBaseOrigin(baseUrl,localRuntime===true);
  if(!origin) throw new TypeError('valid feedback submitted notification base URL required');
  return async(event,{signal}={})=>{
    const metadata=notificationMetadata(event);
    // Mirrors the reminder handler: the handler is registered whenever a
    // sender exists, and drains queued rows to `suppressed` while the flag
    // is off instead of leaving them pending for the watchdog.
    if(!feedbackEnabled()) return {status:'suppressed',reasonCode:'FEEDBACK_DISABLED'};
    const current=await db.execute({
      sql:`SELECT item.kind AS item_kind,item.title AS item_title,
          account.email,account.is_admin,preference.email_enabled
        FROM feedback_items item
        JOIN auth_accounts account ON account.id=?
          AND COALESCE(account.is_demo,0)=0
        LEFT JOIN user_notification_prefs preference ON preference.user_id=account.id
        WHERE item.id=? AND item.circle_id=? AND item.author_user_id=?
        LIMIT 2`,
      args:[metadata.recipientUserId,metadata.feedbackId,metadata.circleId,metadata.authorUserId],
    });
    if(current.rows?.length!==1) return {status:'suppressed',reasonCode:'FEEDBACK_RECIPIENT_OR_ITEM_GONE'};
    const row=current.rows[0];
    const configuredAdmin=getAdminEmails().has(String(row.email||'').trim().toLowerCase());
    if(Number(row.is_admin)!==1&&!configuredAdmin){
      return {status:'suppressed',reasonCode:'FEEDBACK_RECIPIENT_NOT_ADMIN'};
    }
    if(row.email_enabled!==null&&row.email_enabled!==undefined&&Number(row.email_enabled)===0){
      return {status:'suppressed',reasonCode:'NOTIFICATIONS_DISABLED'};
    }
    const recipient=String(row.email||'').trim().toLowerCase();
    if(!recipient||!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(recipient)){
      return {status:'suppressed',reasonCode:'RECIPIENT_EMAIL_INVALID'};
    }
    // Locked accounts (#372) get no admin notifications while pending.
    // Checked after the flag check and recipient query so flag-off drains
    // without a database read.
    if(await isDeletionPending(db,metadata.recipientUserId)){
      return {status:'suppressed',reasonCode:'ACCOUNT_DELETION_PENDING'};
    }
    const kind=String(row.item_kind||metadata.kind);
    const title=String(row.item_title||metadata.title).replace(/[\u0000-\u001f\u007f]+/gu,' ').trim().slice(0,120)
      ||'New feedback';
    const label=FEEDBACK_KIND_LABELS[kind]||'feedback';
    const reviewUrl=`${origin}/?view=feedback&id=${encodeURIComponent(metadata.feedbackId)}`;
    const subject=`New ${label}: ${title}`;
    try{
      const delivery=await send({
        to:recipient,subject,
        html:`<h2>New ${escapeHtml(label)}</h2><p>${escapeHtml(title)}</p><p><a href="${escapeHtml(reviewUrl)}">Review it in Randori</a></p><p>The full feedback is only shown to app admins inside Randori.</p>`,
        idempotencyKey:event.idempotencyKey,signal,
      });
      if(delivery?.error) throw delivery.error;
      return {status:'delivered',providerName:String(delivery?.providerName||'email').slice(0,100),
        providerMessageId:delivery?.providerMessageId||delivery?.data?.id||null};
    }catch(error){ throw providerError(error); }
  };
}
