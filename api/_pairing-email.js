import { canonicalRoomId, escapeHtml } from './_pairing.js';
import { OutboxDeliveryError, readOutboxMetrics, runOutboxWorker } from './_outbox.js';

export const PAIRING_EMAIL_EVENT_TYPE='pairing.email.requested';
export const PAIRING_EMAIL_EVENT_VERSION=1;

function positiveId(value){
  const id=Number(value);
  return Number.isSafeInteger(id)&&id>0?id:null;
}

function pairingEmailPayload(event){
  if(event.eventVersion!==PAIRING_EMAIL_EVENT_VERSION){
    throw new OutboxDeliveryError('EVENT_VERSION_UNSUPPORTED',{retryable:false});
  }
  const payload=event.payload;
  const expected=['kind','recipient_email','user_id','week_id'];
  if(Object.keys(payload).sort().join(',')!==expected.join(',')){
    throw new OutboxDeliveryError('PAYLOAD_INVALID',{retryable:false});
  }
  const weekId=positiveId(payload.week_id);
  const userId=positiveId(payload.user_id);
  const kind=String(payload.kind||'');
  const recipientEmail=String(payload.recipient_email||'');
  if(!weekId||!userId||!['paired','unavailable'].includes(kind)
    ||recipientEmail.length>320||!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(recipientEmail)){
    throw new OutboxDeliveryError('PAYLOAD_INVALID',{retryable:false});
  }
  return Object.freeze({weekId,userId,kind,recipientEmail});
}

async function lookupDisplayName(db,userId){
  const result=await db.execute({
    sql:`SELECT display_name AS name FROM auth_accounts
      WHERE id=? AND COALESCE(is_demo,0)=0 LIMIT 1`,args:[userId],
  });
  return result.rows?.[0]?.name||'your partner';
}

async function renderPairingEmail(db,payload,baseUrl){
  const weekResult=await db.execute({
    sql:`SELECT week_label FROM pairing_weeks WHERE id=? AND COALESCE(is_demo,0)=0 LIMIT 1`,
    args:[payload.weekId],
  });
  const weekLabel=String(weekResult.rows?.[0]?.week_label||'');
  if(!weekLabel) throw new OutboxDeliveryError('PAIRING_WEEK_MISSING',{retryable:false});
  const safeWeekLabel=escapeHtml(weekLabel);
  const safeBaseUrl=escapeHtml(baseUrl);
  if(payload.kind==='unavailable'){
    return Object.freeze({
      subject:`You missed Randori ${weekLabel} — toggle back to available`,
      html:`<h2>Randori Circle — you missed ${safeWeekLabel}</h2><p>You were excluded from this week's shuffle because you marked <b>Unavailable</b>.</p><p>No worries — you'll be back next Sunday automatically unless you stay unavailable.</p><p><a href="${safeBaseUrl}">Open app → Settings → set Available this week = ON</a> to re-join.</p>`,
    });
  }
  const groupResult=await db.execute({
    sql:`SELECT id,user_a_id,user_b_id,is_ai_pair FROM pairing_groups
      WHERE week_id=? AND (user_a_id=? OR (user_b_id=? AND COALESCE(is_ai_pair,0)=0))
      ORDER BY id LIMIT 1`,
    args:[payload.weekId,payload.userId,payload.userId],
  });
  if((groupResult.rows||[]).length!==1){
    throw new OutboxDeliveryError('PAIRING_GROUP_MISSING',{retryable:false});
  }
  const group=groupResult.rows[0];
  const partnerName=Number(group.is_ai_pair)===1
    ?'Solo practice'
    :await lookupDisplayName(db,Number(group.user_a_id)===payload.userId?group.user_b_id:group.user_a_id);
  const room=canonicalRoomId(payload.weekId,group.id);
  const joinUrl=`${baseUrl}/join/${room}`;
  return Object.freeze({
    subject:`Randori ${weekLabel} — your pairing is ready`,
    html:`<h2>Randori Circle — ${safeWeekLabel}</h2><p>You're paired with <b>${escapeHtml(partnerName)}</b>.</p><p><a href="${escapeHtml(joinUrl)}">Join your private pairing room</a></p><p><a href="${safeBaseUrl}">Open Randori Circle</a> to choose DSA, System Design, or Both.</p><p style="color:#888;font-size:12px">Turn off availability in settings if you want to skip next week.</p>`,
  });
}

function providerError(error){
  const status=Number(error?.statusCode||error?.status||error?.response?.status||error?.error?.statusCode);
  if(status===429){
    const retryAfter=Number(error?.retryAfterMs||error?.retry_after_ms);
    return new OutboxDeliveryError('PROVIDER_RATE_LIMITED',{
      retryable:true,retryAfterMs:Number.isFinite(retryAfter)?retryAfter:null,cause:error,
    });
  }
  if(status>=500&&status<=599){
    return new OutboxDeliveryError('PROVIDER_UNAVAILABLE',{retryable:true,cause:error});
  }
  if(status>=400&&status<=499){
    return new OutboxDeliveryError('PROVIDER_REJECTED',{retryable:false,cause:error});
  }
  if(error instanceof OutboxDeliveryError) return error;
  return new OutboxDeliveryError('PROVIDER_FAILED',{retryable:true,cause:error});
}

export function createPairingEmailHandler({db,baseUrl,send,localRuntime=false}={}){
  if(!db||typeof db.execute!=='function'||typeof send!=='function'){
    throw new TypeError('pairing email database and provider are required');
  }
  if(typeof localRuntime!=='boolean') throw new TypeError('invalid pairing email runtime');
  let origin;
  try{ origin=new URL(String(baseUrl)).origin; }
  catch{ throw new TypeError('valid pairing email base URL required'); }
  return async function pairingEmailHandler(event,{signal}={}){
    const payload=pairingEmailPayload(event);
    const account=await db.execute(localRuntime?{
      sql:`SELECT email,is_demo FROM auth_accounts WHERE id=? LIMIT 2`,args:[payload.userId],
    }:{
      sql:`SELECT account.email,account.is_demo,membership.circle_id
        FROM auth_accounts account
        JOIN circle_memberships membership ON membership.user_id=account.id
        JOIN circles circle ON circle.id=membership.circle_id
        WHERE account.id=? AND membership.status='active'
          AND circle.is_primary=1 AND circle.archived_at IS NULL
        LIMIT 2`,args:[payload.userId],
    });
    if((account.rows||[]).length!==1){
      return {status:'suppressed',reasonCode:localRuntime?'RECIPIENT_MISSING':'MEMBERSHIP_REVOKED'};
    }
    if(Number(account.rows[0].is_demo)===1){
      return {status:'suppressed',reasonCode:'DEMO_ACCOUNT'};
    }
    if(String(account.rows[0].email||'').trim().toLowerCase()!==payload.recipientEmail.toLowerCase()){
      return {status:'suppressed',reasonCode:'RECIPIENT_CHANGED'};
    }
    const preference=await db.execute({
      sql:`SELECT email_enabled FROM user_notification_prefs WHERE user_id=? LIMIT 1`,
      args:[payload.userId],
    });
    if(Number(preference.rows?.[0]?.email_enabled)===0){
      return {status:'suppressed',reasonCode:'EMAIL_DISABLED'};
    }
    const content=await renderPairingEmail(db,payload,origin);
    try{
      const delivery=await send({
        to:payload.recipientEmail,subject:content.subject,html:content.html,
        idempotencyKey:event.idempotencyKey,signal,
      });
      if(delivery?.error) throw delivery.error;
      return {
        status:'delivered',providerName:String(delivery?.providerName||'email').slice(0,100),
        providerMessageId:delivery?.providerMessageId||delivery?.data?.id||null,
      };
    }catch(error){ throw providerError(error); }
  };
}

export function createResendEmailSender({resend,from}={}){
  if(!resend?.emails||typeof resend.emails.send!=='function'||!String(from||'').trim()){
    throw new TypeError('Resend client and sender are required');
  }
  return async message=>{
    const result=await resend.emails.send({
      from:String(from),to:message.to,subject:message.subject,html:message.html,
    },{idempotencyKey:message.idempotencyKey,signal:message.signal});
    if(result?.error) throw result.error;
    return {providerName:'resend',providerMessageId:result?.data?.id||null};
  };
}

function countStatuses(metrics){
  const counts={pending:0,processing:0,retry:0,delivered:0,suppressed:0,dead_letter:0};
  for(const metric of metrics) counts[metric.status]=(counts[metric.status]||0)+metric.count;
  return counts;
}

export async function pairingEmailStatus(db){
  return countStatuses(await readOutboxMetrics(db,{eventType:PAIRING_EMAIL_EVENT_TYPE}));
}

/**
 * Idempotent compatibility bridge for actionable rows written before schema
 * v6. The legacy provider used this same key, so a send racing deployment or
 * recovered after a crash remains deduplicated by the provider contract.
 */
export async function migrateLegacyPairingEmails(db,{limit=100}={}){
  if(!db||typeof db.execute!=='function') throw new TypeError('database client required');
  const boundedLimit=Number(limit);
  if(!Number.isSafeInteger(boundedLimit)||boundedLimit<1||boundedLimit>100){
    throw new TypeError('invalid legacy pairing email migration limit');
  }
  const result=await db.execute({sql:`INSERT INTO outbox_events
      (event_type,event_version,idempotency_key,payload_json,status,not_before,next_attempt_at,
       attempt_count,max_attempts,delivery_timeout_ms,last_error_code,dead_lettered_at,created_at,updated_at)
    SELECT 'pairing.email.requested',1,
      'randori/'||legacy.week_id||'/'||legacy.kind||'/'||legacy.user_id,
      json_object('week_id',legacy.week_id,'user_id',legacy.user_id,'kind',legacy.kind,
        'recipient_email',legacy.recipient_email),
      CASE WHEN legacy.status='exhausted' OR legacy.attempt_count>=5 THEN 'dead_letter' ELSE 'pending' END,
      COALESCE(strftime('%Y-%m-%dT%H:%M:%fZ',legacy.created_at),strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      strftime('%Y-%m-%dT%H:%M:%fZ','now'),MAX(0,MIN(legacy.attempt_count,5)),5,10000,
      CASE WHEN legacy.status='exhausted' OR legacy.attempt_count>=5 THEN 'LEGACY_ATTEMPTS_EXHAUSTED' ELSE NULL END,
      CASE WHEN legacy.status='exhausted' OR legacy.attempt_count>=5 THEN strftime('%Y-%m-%dT%H:%M:%fZ','now') ELSE NULL END,
      COALESCE(strftime('%Y-%m-%dT%H:%M:%fZ',legacy.created_at),strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      strftime('%Y-%m-%dT%H:%M:%fZ','now')
    FROM pairing_email_outbox legacy
    WHERE legacy.status IN ('pending','failed','sending','exhausted')
      AND typeof(legacy.week_id)='integer' AND legacy.week_id>0
      AND typeof(legacy.user_id)='integer' AND legacy.user_id>0
      AND legacy.kind IN ('paired','unavailable') AND length(legacy.recipient_email) BETWEEN 1 AND 320
      AND NOT EXISTS (
        SELECT 1 FROM outbox_events current
        WHERE current.idempotency_key='randori/'||legacy.week_id||'/'||legacy.kind||'/'||legacy.user_id
      )
    ORDER BY legacy.id LIMIT ?
    ON CONFLICT(idempotency_key) DO NOTHING`,args:[boundedLimit]});
  return Number(result.rowsAffected||0);
}

export async function deliverPairingEmails({db,baseUrl,send,workerId,localRuntime=false,workerOptions={}}={}){
  await migrateLegacyPairingEmails(db);
  const handler=createPairingEmailHandler({db,baseUrl,send,localRuntime});
  const result=await runOutboxWorker({
    db,workerId,eventType:PAIRING_EMAIL_EVENT_TYPE,
    handlers:{[PAIRING_EMAIL_EVENT_TYPE]:handler},...workerOptions,
  });
  const status=await pairingEmailStatus(db);
  return Object.freeze({...result,status});
}

export function classifyPairingProviderError(error){
  return providerError(error);
}
