import { canonicalRoomId, escapeHtml } from './_pairing.js';
import { secondaryCirclePairingEmailEnabled } from './_active-circle.js';
import { OutboxDeliveryError, readOutboxMetrics, runOutboxWorker } from './_outbox.js';
import {
  PAIRING_EMAIL_EVENT_TYPE,
  PRIMARY_PAIRING_EMAIL_EVENT_VERSION,
  SECONDARY_PAIRING_EMAIL_EVENT_VERSION,
} from './_pairing-email-contract.js';

export {
  PAIRING_EMAIL_EVENT_TYPE,
  SECONDARY_PAIRING_EMAIL_EVENT_VERSION,
};
export const PAIRING_EMAIL_EVENT_VERSION=PRIMARY_PAIRING_EMAIL_EVENT_VERSION;

function positiveId(value){
  const id=Number(value);
  return Number.isSafeInteger(id)&&id>0?id:null;
}

function pairingEmailPayload(event){
  if(event.eventVersion===SECONDARY_PAIRING_EMAIL_EVENT_VERSION){
    const payload=event.payload;
    const expected=['circle_id','kind','publication_id','user_id'];
    if(Object.keys(payload).sort().join(',')!==expected.join(',')){
      throw new OutboxDeliveryError('PAYLOAD_INVALID',{retryable:false});
    }
    const publicationId=positiveId(payload.publication_id);
    const circleId=positiveId(payload.circle_id);
    const userId=positiveId(payload.user_id);
    const kind=String(payload.kind||'');
    if(!publicationId||!circleId||!userId||!['paired','solo','unavailable'].includes(kind)){
      throw new OutboxDeliveryError('PAYLOAD_INVALID',{retryable:false});
    }
    return Object.freeze({version:2,publicationId,circleId,userId,kind});
  }
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
  return Object.freeze({version:1,weekId,userId,kind,recipientEmail});
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

function secondaryPairingRowIsValid(row,payload){
  if(!row||Number(row.publication_id)!==payload.publicationId
    ||Number(row.publication_circle_id)!==payload.circleId
    ||String(row.publication_scope_key)!==`circle:${payload.circleId}`
    ||String(row.eligibility_scope_key)!==String(row.publication_scope_key)
    ||Number(row.eligibility_circle_id)!==payload.circleId
    ||String(row.eligibility_cycle_key)!==String(row.publication_cycle_key)
    ||String(row.cycle_scope_key)!==String(row.publication_scope_key)
    ||Number(row.cycle_circle_id)!==payload.circleId
    ||String(row.cycle_cycle_key)!==String(row.publication_cycle_key)
    ||String(row.cycle_cycle_id)!==String(row.publication_cycle_id)
    ||String(row.cycle_starts_at)!==String(row.publication_starts_at)
    ||String(row.cycle_ends_at)!==String(row.publication_ends_at)
    ||String(row.cycle_cutoff_at)!==String(row.publication_cutoff_at)
    ||String(row.cycle_time_zone)!==String(row.publication_time_zone)
    ||Number(row.user_id)!==payload.userId
    ||!/^[0-9a-f]{64}$/.test(String(row.publication_cycle_key))){
    return false;
  }
  const available=Number(row.is_available)===1;
  const groupPosition=row.group_position==null?null:Number(row.group_position);
  const groupSize=row.group_size==null?null:Number(row.group_size);
  const memberPosition=row.member_position==null?null:Number(row.member_position);
  if(payload.kind==='unavailable'){
    return !available&&groupPosition===null&&groupSize===null&&memberPosition===null
      &&row.group_id==null;
  }
  if(!available||!Number.isSafeInteger(groupPosition)||!Number.isSafeInteger(memberPosition)
    ||row.group_id==null||Number(row.group_position_stored)!==groupPosition){
    return false;
  }
  const userAId=positiveId(row.user_a_id);
  const userBId=row.user_b_id==null?null:positiveId(row.user_b_id);
  if(payload.kind==='solo'){
    return groupSize===1&&memberPosition===0&&Number(row.member_count)===1
      &&Number(row.is_solo)===1&&userAId===payload.userId&&userBId===null;
  }
  return groupSize===2&&[0,1].includes(memberPosition)&&Number(row.member_count)===2
    &&Number(row.is_solo)===0&&userAId!==null&&userBId!==null&&userAId!==userBId
    &&(memberPosition===0?userAId===payload.userId:userBId===payload.userId)
    &&positiveId(row.partner_eligibility_user_id)===(memberPosition===0?userBId:userAId)
    &&Number(row.partner_eligibility_available)===1
    &&Number(row.partner_eligibility_group_position)===groupPosition
    &&Number(row.partner_eligibility_group_size)===2
    &&Number(row.partner_eligibility_member_position)===(memberPosition===0?1:0);
}

async function resolveSecondaryPairingEmail(db,payload){
  const result=await db.execute({
    sql:`SELECT publication.id AS publication_id,publication.scope_key AS publication_scope_key,
        publication.circle_id AS publication_circle_id,publication.cycle_key AS publication_cycle_key,
        publication.cycle_id AS publication_cycle_id,publication.starts_at AS publication_starts_at,
        publication.ends_at AS publication_ends_at,publication.cutoff_at AS publication_cutoff_at,
        publication.time_zone AS publication_time_zone,publication.generation_token,
        publication.algorithm_version,publication.algorithm_seed,publication.participant_count,
        cycle.scope_key AS cycle_scope_key,cycle.circle_id AS cycle_circle_id,
        cycle.cycle_key AS cycle_cycle_key,cycle.cycle_id AS cycle_cycle_id,
        cycle.starts_at AS cycle_starts_at,cycle.ends_at AS cycle_ends_at,
        cycle.cutoff_at AS cycle_cutoff_at,cycle.time_zone AS cycle_time_zone,
        eligibility.scope_key AS eligibility_scope_key,eligibility.circle_id AS eligibility_circle_id,
        eligibility.cycle_key AS eligibility_cycle_key,eligibility.user_id,
        eligibility.is_available,eligibility.group_position,eligibility.group_size,
        eligibility.member_position,group_row.id AS group_id,
        group_row.position AS group_position_stored,group_row.member_count,
        group_row.user_a_id,group_row.user_b_id,group_row.is_solo,
        partner_eligibility.user_id AS partner_eligibility_user_id,
        partner_eligibility.is_available AS partner_eligibility_available,
        partner_eligibility.group_position AS partner_eligibility_group_position,
        partner_eligibility.group_size AS partner_eligibility_group_size,
        partner_eligibility.member_position AS partner_eligibility_member_position,
        circle.name AS circle_name,circle.is_primary,circle.archived_at,
        account.email,account.display_name,account.is_demo,
        membership.status AS membership_status,
        preference.email_enabled,
        partner.id AS partner_id,partner.display_name AS partner_name,partner.is_demo AS partner_is_demo,
        partner_membership.status AS partner_membership_status,
        (SELECT COUNT(*) FROM circle_pairing_eligibility all_eligibility
          WHERE all_eligibility.publication_id=publication.id
            AND all_eligibility.scope_key=publication.scope_key
            AND all_eligibility.circle_id=publication.circle_id
            AND all_eligibility.cycle_key=publication.cycle_key) AS eligibility_count,
        (SELECT COUNT(*) FROM circle_pairing_eligibility available_eligibility
          WHERE available_eligibility.publication_id=publication.id
            AND available_eligibility.scope_key=publication.scope_key
            AND available_eligibility.circle_id=publication.circle_id
            AND available_eligibility.cycle_key=publication.cycle_key
            AND available_eligibility.is_available=1) AS available_count,
        (SELECT COUNT(*) FROM circle_pairing_groups all_groups
          WHERE all_groups.publication_id=publication.id
            AND all_groups.scope_key=publication.scope_key
            AND all_groups.circle_id=publication.circle_id
            AND all_groups.cycle_key=publication.cycle_key) AS group_count
      FROM circle_pairing_publications publication
      LEFT JOIN pairing_cycles cycle
        ON cycle.scope_key=publication.scope_key AND cycle.circle_id=publication.circle_id
          AND cycle.cycle_key=publication.cycle_key AND cycle.cycle_id=publication.cycle_id
          AND cycle.starts_at=publication.starts_at AND cycle.ends_at=publication.ends_at
          AND cycle.cutoff_at=publication.cutoff_at AND cycle.time_zone=publication.time_zone
      LEFT JOIN circle_pairing_eligibility eligibility
        ON eligibility.publication_id=publication.id AND eligibility.scope_key=publication.scope_key
          AND eligibility.circle_id=publication.circle_id AND eligibility.cycle_key=publication.cycle_key
          AND eligibility.user_id=?
      LEFT JOIN circle_pairing_groups group_row
        ON group_row.publication_id=publication.id AND group_row.scope_key=publication.scope_key
          AND group_row.circle_id=publication.circle_id AND group_row.cycle_key=publication.cycle_key
          AND (group_row.user_a_id=? OR group_row.user_b_id=?)
      LEFT JOIN circle_pairing_eligibility partner_eligibility
        ON partner_eligibility.publication_id=publication.id
          AND partner_eligibility.scope_key=publication.scope_key
          AND partner_eligibility.circle_id=publication.circle_id
          AND partner_eligibility.cycle_key=publication.cycle_key
          AND partner_eligibility.user_id=CASE
            WHEN group_row.user_a_id=? THEN group_row.user_b_id ELSE group_row.user_a_id END
      LEFT JOIN circles circle ON circle.id=publication.circle_id
      LEFT JOIN auth_accounts account ON account.id=?
      LEFT JOIN circle_memberships membership
        ON membership.circle_id=publication.circle_id AND membership.user_id=?
      LEFT JOIN user_notification_prefs preference ON preference.user_id=?
      LEFT JOIN auth_accounts partner ON partner.id=CASE
        WHEN group_row.user_a_id=? THEN group_row.user_b_id ELSE group_row.user_a_id END
      LEFT JOIN circle_memberships partner_membership
        ON partner_membership.circle_id=publication.circle_id AND partner_membership.user_id=partner.id
      WHERE publication.id=? LIMIT 3`,
    args:[payload.userId,payload.userId,payload.userId,payload.userId,payload.userId,
      payload.userId,payload.userId,payload.userId,payload.publicationId],
  });
  const rows=result.rows||[];
  if(rows.length!==1||!secondaryPairingRowIsValid(rows[0],payload)){
    return {suppressed:'PUBLICATION_INVALID'};
  }
  const row=rows[0];
  const participantCount=Number(row.participant_count);
  const eligibilityCount=Number(row.eligibility_count);
  const availableCount=Number(row.available_count);
  const groupCount=Number(row.group_count);
  if(!Number.isSafeInteger(participantCount)||participantCount<1
    ||eligibilityCount!==participantCount||!Number.isSafeInteger(availableCount)||availableCount<0
    ||availableCount>participantCount||groupCount!==Math.ceil(availableCount/2)
    ||!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(String(row.generation_token))
    ||!String(row.algorithm_version||'').length
    ||String(row.algorithm_seed)!==`${row.publication_scope_key}:${row.publication_cycle_key}:weekly`){
    return {suppressed:'PUBLICATION_INVALID'};
  }
  if(Number(row.publication_circle_id)!==payload.circleId||Number(row.is_primary)!==0
    ||row.archived_at!==null){
    return {suppressed:'CIRCLE_UNAVAILABLE'};
  }
  if(String(row.membership_status)!=='active'||Number(row.is_demo)===1){
    return {suppressed:'MEMBERSHIP_REVOKED'};
  }
  if(row.email_enabled!==null&&Number(row.email_enabled)===0){
    return {suppressed:'EMAIL_DISABLED'};
  }
  const recipientEmail=String(row.email||'').trim().toLowerCase();
  const rawCircleName=String(row.circle_name||'');
  const circleName=rawCircleName.trim();
  if(!recipientEmail||recipientEmail.length>320||!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(recipientEmail)
    ||!circleName||circleName!==rawCircleName||circleName!==circleName.normalize('NFC')
    ||[...circleName].length>80||Buffer.byteLength(circleName,'utf8')>240
    ||/[\u0000-\u001f\u007f-\u009f]/u.test(circleName)){
    return {suppressed:'RECIPIENT_INVALID'};
  }
  if(payload.kind==='paired'){
    if(!positiveId(row.partner_id)||String(row.partner_membership_status)!=='active'
      ||Number(row.partner_is_demo)===1){
      return {suppressed:'PARTNER_REVOKED'};
    }
  }
  return {row,payload:Object.freeze({...payload,recipientEmail,circleName})};
}

function renderSecondaryPairingEmail(payload,row,baseUrl){
  const safeCircleName=escapeHtml(payload.circleName);
  const safeBaseUrl=escapeHtml(baseUrl);
  if(payload.kind==='unavailable'){
    return Object.freeze({
      subject:`${payload.circleName} — update your Randori availability`,
      html:`<h2>${safeCircleName} — weekly pairing</h2><p>You were unavailable for this cycle.</p><p><a href="${safeBaseUrl}">Open the Randori dashboard</a> to update your availability for next week.</p>`,
    });
  }
  if(payload.kind==='solo'){
    return Object.freeze({
      subject:`${payload.circleName} — your Randori pairing is ready`,
      html:`<h2>${safeCircleName} — weekly pairing</h2><p>You have a solo practice session this cycle.</p><p><a href="${safeBaseUrl}">Open the Randori dashboard</a> to view your pairing.</p>`,
    });
  }
  const partnerName=escapeHtml(String(row.partner_name||'your partner').slice(0,80));
  return Object.freeze({
    subject:`${payload.circleName} — your Randori pairing is ready`,
    html:`<h2>${safeCircleName} — weekly pairing</h2><p>You're paired with <b>${partnerName}</b>.</p><p><a href="${safeBaseUrl}">Open the Randori dashboard</a> to view your pairing.</p>`,
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
    if(payload.version===2){
      if(!secondaryCirclePairingEmailEnabled()){
        return {status:'suppressed',reasonCode:'SECONDARY_PAIRING_EMAIL_DISABLED'};
      }
      const resolved=await resolveSecondaryPairingEmail(db,payload);
      if(resolved.suppressed) return {status:'suppressed',reasonCode:resolved.suppressed};
      const content=renderSecondaryPairingEmail(resolved.payload,resolved.row,origin);
      try{
        const delivery=await send({
          to:resolved.payload.recipientEmail,subject:content.subject,html:content.html,
          kind:payload.kind,idempotencyKey:event.idempotencyKey,signal,
        });
        if(delivery?.error) throw delivery.error;
        return {
          status:'delivered',providerName:String(delivery?.providerName||'email').slice(0,100),
          providerMessageId:delivery?.providerMessageId||delivery?.data?.id||null,
        };
      }catch(error){ throw providerError(error); }
    }
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
        kind:payload.kind,idempotencyKey:event.idempotencyKey,signal,
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
