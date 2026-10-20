import { escapeHtml } from './_pairing.js';
import { normalizeInvitationEmail } from './_circle-membership.js';
import { createOutboxEventStatement, OutboxDeliveryError } from './_outbox.js';
import { inviteRequestsEnabled } from './_invite-request-config.js';

// Owner digest for new invite requests. Versioned outbox payload v1:
//   {circle_id, owner_user_id, digest_hour, template_version:1}
// The payload and the rendered email carry no requester data at all.

export const INVITE_REQUEST_EVENT_TYPE='inviterequest.email.requested';
export const INVITE_REQUEST_EVENT_VERSION=1;
export const INVITE_REQUEST_TEMPLATE_VERSION=1;
export const INVITE_REQUEST_DIGEST_SECONDS=60*60;

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

/** Owner notifications are queued only when they can actually be delivered. */
export function inviteRequestNotificationConfiguration({localRuntime=false,env=process.env}={}){
  if(!inviteRequestsEnabled(env)) return null;
  if(!localRuntime&&(!String(env.RESEND_API_KEY||'').trim()||!String(env.RESEND_FROM||'').trim())) return null;
  const origin=configuredOrigin({localRuntime,env});
  return origin?Object.freeze({origin,localRuntime}):null;
}

export function createInviteRequestNotificationEvent({circleId,ownerUserId,digestHour}={}){
  const circle=Number(circleId);
  const owner=Number(ownerUserId);
  const hour=Number(digestHour);
  if(!Number.isSafeInteger(circle)||circle<1||!Number.isSafeInteger(owner)||owner<1
    ||!Number.isSafeInteger(hour)||hour<1){
    throw new TypeError('valid invite request notification required');
  }
  return createOutboxEventStatement({
    eventType:INVITE_REQUEST_EVENT_TYPE,eventVersion:INVITE_REQUEST_EVENT_VERSION,
    // One digest per owner per hour: later requests in the same hour share
    // the key and are absorbed by ON CONFLICT DO NOTHING.
    idempotencyKey:`invite-request-digest/v1/${circle}/${owner}/${hour}`,
    payload:{circle_id:circle,owner_user_id:owner,digest_hour:hour,
      template_version:INVITE_REQUEST_TEMPLATE_VERSION},
    maxAttempts:5,deliveryTimeoutMs:10_000,
  });
}

function notificationMetadata(event){
  if(event.eventVersion!==INVITE_REQUEST_EVENT_VERSION){
    throw new OutboxDeliveryError('EVENT_VERSION_UNSUPPORTED',{retryable:event.eventVersion>INVITE_REQUEST_EVENT_VERSION});
  }
  const payload=event.payload;
  if(!payload||typeof payload!=='object'||Array.isArray(payload)
    ||Object.keys(payload).sort().join(',')!=='circle_id,digest_hour,owner_user_id,template_version'){
    throw new OutboxDeliveryError('PAYLOAD_INVALID',{retryable:false});
  }
  const circleId=Number(payload.circle_id);
  const ownerUserId=Number(payload.owner_user_id);
  const digestHour=Number(payload.digest_hour);
  if(!Number.isSafeInteger(circleId)||circleId<1||!Number.isSafeInteger(ownerUserId)||ownerUserId<1
    ||!Number.isSafeInteger(digestHour)||digestHour<1
    ||Number(payload.template_version)!==INVITE_REQUEST_TEMPLATE_VERSION){
    throw new OutboxDeliveryError('PAYLOAD_INVALID',{retryable:false});
  }
  return Object.freeze({circleId,ownerUserId,digestHour});
}

function providerError(error){
  if(error instanceof OutboxDeliveryError) return error;
  const status=Number(error?.statusCode||error?.status||error?.response?.status||error?.error?.statusCode);
  if(status===429) return new OutboxDeliveryError('PROVIDER_RATE_LIMITED',{retryable:true,cause:error});
  if(status>=400&&status<=499) return new OutboxDeliveryError('PROVIDER_REJECTED',{retryable:false,cause:error});
  return new OutboxDeliveryError('PROVIDER_FAILED',{retryable:true,cause:error});
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
 * Owner digest: the email carries only the pending count and a link to the
 * signed-in dashboard. Requester names, notes, and addresses never leave the
 * database through this channel, so the public form cannot be used to send
 * arbitrary text from the circle's sending domain.
 */
export function createInviteRequestNotificationHandler({db,baseUrl,send,localRuntime=false}={}){
  if(!db||typeof db.execute!=='function'||typeof send!=='function'){
    throw new TypeError('invite request notification database and provider are required');
  }
  const origin=validBaseOrigin(baseUrl,localRuntime===true);
  if(!origin) throw new TypeError('valid invite request notification base URL required');
  return async(event,{signal}={})=>{
    const metadata=notificationMetadata(event);
    const current=await db.execute({
      sql:`SELECT account.email,circle.name AS circle_name,preference.email_enabled,
          (SELECT COUNT(*) FROM invite_requests request
            WHERE request.circle_id=circle.id AND request.status='pending'
              AND request.expires_at>CAST(strftime('%s','now') AS INTEGER)) AS pending_count
        FROM circles circle
        JOIN circle_memberships membership ON membership.circle_id=circle.id
          AND membership.user_id=? AND membership.role='owner' AND membership.status='active'
        JOIN auth_accounts account ON account.id=membership.user_id AND COALESCE(account.is_demo,0)=0
        LEFT JOIN user_notification_prefs preference ON preference.user_id=account.id
        WHERE circle.id=? AND circle.archived_at IS NULL LIMIT 2`,
      args:[metadata.ownerUserId,metadata.circleId],
    });
    if(current.rows?.length!==1) return {status:'suppressed',reasonCode:'INVITE_REQUEST_OWNER_INACTIVE'};
    const row=current.rows[0];
    if(row.email_enabled!==null&&row.email_enabled!==undefined&&Number(row.email_enabled)===0){
      return {status:'suppressed',reasonCode:'NOTIFICATIONS_DISABLED'};
    }
    const pending=Number(row.pending_count);
    if(!Number.isSafeInteger(pending)||pending<1) return {status:'suppressed',reasonCode:'NO_PENDING_INVITE_REQUESTS'};
    const recipient=normalizeInvitationEmail(String(row.email||''));
    if(!recipient) return {status:'suppressed',reasonCode:'OWNER_EMAIL_INVALID'};
    const circleName=String(row.circle_name||'Randori Circle')
      .replace(/[\u0000-\u001f\u007f]+/gu,' ').trim().slice(0,100)||'Randori Circle';
    const reviewUrl=`${origin}/?view=circle`;
    const subject=pending===1?`New invite request for ${circleName}`:`${pending} invite requests for ${circleName}`;
    const lead=pending===1?'Someone has asked to join':`${pending} people have asked to join`;
    try{
      const delivery=await send({
        to:recipient,subject,
        html:`<h2>Invite requests are waiting</h2><p>${lead} ${escapeHtml(circleName)}.</p><p><a href="${escapeHtml(reviewUrl)}">Review requests in Randori</a></p><p>Requests you do not approve expire after 30 days.</p>`,
        idempotencyKey:event.idempotencyKey,signal,
      });
      if(delivery?.error) throw delivery.error;
      return {status:'delivered',providerName:String(delivery?.providerName||'email').slice(0,100),
        providerMessageId:delivery?.providerMessageId||delivery?.data?.id||null};
    }catch(error){ throw providerError(error); }
  };
}
