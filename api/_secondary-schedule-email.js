import { createHash } from 'node:crypto';

import { secondaryCircleScheduleEmailEnabled } from './_active-circle.js';
import { createOutboxEventStatement, OutboxDeliveryError } from './_outbox.js';
import { escapeHtml } from './_pairing.js';
import { normalizeScheduleInstant } from './_schedule.js';

export const SECONDARY_SCHEDULE_EMAIL_EVENT_VERSION=2;
export const SECONDARY_SCHEDULE_EMAIL_TEMPLATE_VERSION=1;
export const SECONDARY_SCHEDULE_REMINDER_LEAD_MS=24*60*60*1000;

const EVENT_TYPE='schedule.email.requested';
const OPAQUE_ID_PATTERN=/^[a-f0-9]{64}$/;
const FINGERPRINT_PATTERN=/^[a-f0-9]{64}$/;
const KINDS=new Set(['proposal','removed','accepted','changed','cleared','reminder']);

function positiveId(value){
  const id=Number(value);
  return Number.isSafeInteger(id)&&id>0?id:null;
}

function positiveRevision(value){
  const revision=Number(value);
  return Number.isSafeInteger(revision)&&revision>0?revision:null;
}

function exactKeys(value,expected){
  if(!value||typeof value!=='object'||Array.isArray(value)) return false;
  const actual=Object.keys(value).sort();
  const wanted=[...expected].sort();
  return actual.length===wanted.length&&actual.every((key,index)=>key===wanted[index]);
}

export function secondaryScheduleInstantFingerprint(value){
  const instant=normalizeScheduleInstant(value);
  if(!instant||instant!==value) throw new TypeError('normalized secondary schedule instant required');
  return createHash('sha256')
    .update(`randori-secondary-schedule-instant-v1\0${instant}`,'utf8')
    .digest('hex');
}

function event({scheduleId,proposalId,revision,kind,actorUserId,recipientUserId,instant=null,
  notBefore=null}){
  return createOutboxEventStatement({
    eventType:EVENT_TYPE,eventVersion:SECONDARY_SCHEDULE_EMAIL_EVENT_VERSION,
    idempotencyKey:`secondary-schedule-email/v1/${scheduleId}/${revision}/${kind}/${recipientUserId}`,
    payload:{
      schedule_id:scheduleId,proposal_id:proposalId,schedule_revision:revision,
      actor_user_id:actorUserId,recipient_user_id:recipientUserId,kind,
      instant_fingerprint:instant===null?null:secondaryScheduleInstantFingerprint(instant),
      template_version:SECONDARY_SCHEDULE_EMAIL_TEMPLATE_VERSION,
    },
    notBefore,maxAttempts:5,deliveryTimeoutMs:10_000,
  });
}

/** Build the v2 intents that must be written in the successful schedule CAS transaction. */
export function secondaryScheduleNotificationEvents({scope,currentState,nextState,mutation,actorUserId}={}){
  const actor=positiveId(actorUserId);
  const revision=positiveRevision(nextState?.revision);
  const scheduleId=String(scope?.scheduleKey||'');
  const users=[positiveId(scope?.userAId),positiveId(scope?.userBId)];
  if(!actor||!revision||!OPAQUE_ID_PATTERN.test(scheduleId)||users.some(id=>!id)
    ||users[0]===users[1]||!users.includes(actor)||!currentState||!nextState||!mutation){
    throw new TypeError('valid secondary schedule notification context required');
  }
  const partner=users.find(id=>id!==actor);
  if(mutation.action==='propose'){
    const proposal=nextState.proposals.find(item=>!currentState.proposals
      .some(current=>current.proposalId===item.proposalId));
    if(!proposal||proposal.proposedBy!==actor) throw new TypeError('valid proposed schedule state required');
    return [event({scheduleId,proposalId:proposal.proposalId,revision,kind:'proposal',actorUserId:actor,
      recipientUserId:partner,instant:proposal.instant})];
  }
  if(mutation.action==='remove'){
    const proposal=currentState.proposals.find(item=>item.proposalId===mutation.proposalId);
    if(!proposal||nextState.proposals.some(item=>item.proposalId===mutation.proposalId)){
      throw new TypeError('valid removed schedule state required');
    }
    return [event({scheduleId,proposalId:proposal.proposalId,revision,kind:'removed',actorUserId:actor,
      recipientUserId:partner})];
  }
  if(mutation.action==='clear'){
    if(currentState.agreedTime===null&&nextState.agreedTime===null) return [];
    if(!currentState.agreedTime||nextState.agreedTime!==null){
      throw new TypeError('valid cleared schedule state required');
    }
    return users.map(recipientUserId=>event({scheduleId,proposalId:null,revision,kind:'cleared',
      actorUserId:actor,recipientUserId}));
  }
  if(mutation.action==='accept'){
    if(currentState.agreedTime===nextState.agreedTime) return [];
    const proposal=nextState.proposals.find(item=>item.proposalId===mutation.proposalId);
    if(!proposal||proposal.instant!==nextState.agreedTime){
      throw new TypeError('valid accepted schedule state required');
    }
    const kind=currentState.agreedTime===null?'accepted':'changed';
    const intents=[];
    for(const recipientUserId of users){
      intents.push(event({scheduleId,proposalId:proposal.proposalId,revision,kind,actorUserId:actor,
        recipientUserId,instant:nextState.agreedTime}));
      intents.push(event({scheduleId,proposalId:proposal.proposalId,revision,kind:'reminder',
        actorUserId:actor,recipientUserId,instant:nextState.agreedTime,
        notBefore:new Date(Date.parse(nextState.agreedTime)-SECONDARY_SCHEDULE_REMINDER_LEAD_MS).toISOString()}));
    }
    return intents;
  }
  throw new TypeError('unsupported secondary schedule notification action');
}

function parsePayload(event){
  if(event?.eventVersion!==SECONDARY_SCHEDULE_EMAIL_EVENT_VERSION){
    throw new OutboxDeliveryError('EVENT_VERSION_UNSUPPORTED',{retryable:false});
  }
  const payload=event.payload;
  const expected=['actor_user_id','instant_fingerprint','kind','proposal_id','recipient_user_id',
    'schedule_id','schedule_revision','template_version'];
  if(!exactKeys(payload,expected)) throw new OutboxDeliveryError('PAYLOAD_INVALID',{retryable:false});
  const scheduleId=String(payload.schedule_id||'');
  const proposalId=payload.proposal_id===null?null:String(payload.proposal_id||'');
  const revision=positiveRevision(payload.schedule_revision);
  const actorUserId=positiveId(payload.actor_user_id);
  const recipientUserId=positiveId(payload.recipient_user_id);
  const kind=String(payload.kind||'');
  const fingerprint=payload.instant_fingerprint===null?null:String(payload.instant_fingerprint||'');
  const templateVersion=Number(payload.template_version);
  const needsProposal=['proposal','removed','accepted','changed','reminder'].includes(kind);
  const needsFingerprint=['proposal','accepted','changed','reminder'].includes(kind);
  if(!OPAQUE_ID_PATTERN.test(scheduleId)||!revision||!actorUserId||!recipientUserId
    ||!KINDS.has(kind)||templateVersion!==SECONDARY_SCHEDULE_EMAIL_TEMPLATE_VERSION
    ||(needsProposal?!OPAQUE_ID_PATTERN.test(proposalId||''):proposalId!==null)
    ||(needsFingerprint?!FINGERPRINT_PATTERN.test(fingerprint||''):fingerprint!==null)){
    throw new OutboxDeliveryError('PAYLOAD_INVALID',{retryable:false});
  }
  return Object.freeze({scheduleId,proposalId,revision,actorUserId,recipientUserId,kind,
    fingerprint,templateVersion});
}

function validOwnedSchedule(row,payload){
  if(!row||String(row.schedule_key)!==payload.scheduleId
    ||Number(row.schedule_revision)!==payload.revision
    ||!positiveId(row.publication_id)||String(row.scope_key)!==`circle:${row.circle_id}`
    ||!positiveId(row.circle_id)||!OPAQUE_ID_PATTERN.test(String(row.cycle_key||''))
    ||!positiveId(row.group_id)||Number(row.member_count)!==2||Number(row.is_solo)!==0
    ||!positiveId(row.user_a_id)||!positiveId(row.user_b_id)
    ||Number(row.user_a_id)===Number(row.user_b_id)
    ||Number(row.publication_id)!==Number(row.publication_join_id)
    ||String(row.scope_key)!==String(row.publication_scope_key)
    ||Number(row.circle_id)!==Number(row.publication_circle_id)
    ||String(row.cycle_key)!==String(row.publication_cycle_key)
    ||Number(row.group_id)!==Number(row.group_join_id)
    ||String(row.scope_key)!==String(row.group_scope_key)
    ||Number(row.circle_id)!==Number(row.group_circle_id)
    ||String(row.cycle_key)!==String(row.group_cycle_key)
    ||Number(row.member_count)!==Number(row.group_member_count)
    ||Number(row.user_a_id)!==Number(row.group_user_a_id)
    ||Number(row.user_b_id)!==Number(row.group_user_b_id)
    ||Number(row.is_solo)!==Number(row.group_is_solo)
    ||String(row.scope_key)!==String(row.cycle_scope_key)
    ||Number(row.circle_id)!==Number(row.cycle_circle_id)
    ||String(row.cycle_key)!==String(row.cycle_join_key)
    ||String(row.publication_cycle_id)!==String(row.cycle_id)
    ||String(row.publication_starts_at)!==String(row.cycle_starts_at)
    ||String(row.publication_ends_at)!==String(row.cycle_ends_at)
    ||String(row.publication_cutoff_at)!==String(row.cycle_cutoff_at)
    ||String(row.publication_time_zone)!==String(row.cycle_time_zone)
    ||Number(row.is_primary)!==0||row.archived_at!==null
    ||Number(row.current_publication_count)!==1){
    return false;
  }
  const now=Date.parse(String(row.now_utc||''));
  return Number.isFinite(now)&&Date.parse(String(row.publication_starts_at))<=now
    &&Date.parse(String(row.publication_ends_at))>now;
}

async function resolveDelivery(db,payload){
  const result=await db.execute({
    sql:`SELECT schedule.schedule_key,schedule.revision AS schedule_revision,
        schedule.publication_id,schedule.scope_key,schedule.circle_id,schedule.cycle_key,
        schedule.group_id,schedule.member_count,schedule.user_a_id,schedule.user_b_id,schedule.is_solo,
        schedule.agreed_time,publication.id AS publication_join_id,
        publication.scope_key AS publication_scope_key,publication.circle_id AS publication_circle_id,
        publication.cycle_key AS publication_cycle_key,publication.cycle_id AS publication_cycle_id,
        publication.starts_at AS publication_starts_at,publication.ends_at AS publication_ends_at,
        publication.cutoff_at AS publication_cutoff_at,publication.time_zone AS publication_time_zone,
        group_row.id AS group_join_id,group_row.scope_key AS group_scope_key,
        group_row.circle_id AS group_circle_id,group_row.cycle_key AS group_cycle_key,
        group_row.member_count AS group_member_count,group_row.user_a_id AS group_user_a_id,
        group_row.user_b_id AS group_user_b_id,group_row.is_solo AS group_is_solo,
        cycle.scope_key AS cycle_scope_key,cycle.circle_id AS cycle_circle_id,
        cycle.cycle_key AS cycle_join_key,cycle.cycle_id,cycle.starts_at AS cycle_starts_at,
        cycle.ends_at AS cycle_ends_at,cycle.cutoff_at AS cycle_cutoff_at,
        cycle.time_zone AS cycle_time_zone,circle.name AS circle_name,circle.is_primary,circle.archived_at,
        actor_membership.status AS actor_membership_status,actor.is_demo AS actor_is_demo,
        actor.display_name AS actor_name,recipient_membership.status AS recipient_membership_status,
        recipient.is_demo AS recipient_is_demo,recipient.email AS recipient_email,
        partner_membership.status AS partner_membership_status,partner.is_demo AS partner_is_demo,
        preference.email_enabled,proposal.proposal_key,proposal.instant AS proposal_instant,
        proposal.proposed_by,
        (SELECT COUNT(*) FROM circle_pairing_publications current_publication
          WHERE current_publication.circle_id=schedule.circle_id
            AND current_publication.starts_at<=strftime('%Y-%m-%dT%H:%M:%fZ','now')
            AND current_publication.ends_at>strftime('%Y-%m-%dT%H:%M:%fZ','now')) AS current_publication_count,
        strftime('%Y-%m-%dT%H:%M:%fZ','now') AS now_utc
      FROM circle_pair_schedules schedule
      LEFT JOIN circle_pairing_publications publication
        ON publication.id=schedule.publication_id AND publication.scope_key=schedule.scope_key
          AND publication.circle_id=schedule.circle_id AND publication.cycle_key=schedule.cycle_key
      LEFT JOIN pairing_cycles cycle
        ON cycle.scope_key=publication.scope_key AND cycle.circle_id=publication.circle_id
          AND cycle.cycle_key=publication.cycle_key AND cycle.cycle_id=publication.cycle_id
          AND cycle.starts_at=publication.starts_at AND cycle.ends_at=publication.ends_at
          AND cycle.cutoff_at=publication.cutoff_at AND cycle.time_zone=publication.time_zone
      LEFT JOIN circle_pairing_groups group_row
        ON group_row.id=schedule.group_id AND group_row.publication_id=schedule.publication_id
          AND group_row.scope_key=schedule.scope_key AND group_row.circle_id=schedule.circle_id
          AND group_row.cycle_key=schedule.cycle_key AND group_row.member_count=schedule.member_count
          AND group_row.user_a_id=schedule.user_a_id AND group_row.user_b_id=schedule.user_b_id
          AND group_row.is_solo=schedule.is_solo
      LEFT JOIN circles circle ON circle.id=schedule.circle_id
      LEFT JOIN circle_memberships actor_membership
        ON actor_membership.circle_id=schedule.circle_id AND actor_membership.user_id=?
      LEFT JOIN auth_accounts actor ON actor.id=?
      LEFT JOIN circle_memberships recipient_membership
        ON recipient_membership.circle_id=schedule.circle_id AND recipient_membership.user_id=?
      LEFT JOIN auth_accounts recipient ON recipient.id=?
      LEFT JOIN circle_memberships partner_membership ON partner_membership.circle_id=schedule.circle_id
        AND partner_membership.user_id=CASE WHEN schedule.user_a_id=? THEN schedule.user_b_id ELSE schedule.user_a_id END
      LEFT JOIN auth_accounts partner ON partner.id=partner_membership.user_id
      LEFT JOIN user_notification_prefs preference ON preference.user_id=recipient.id
      LEFT JOIN circle_pair_schedule_proposals proposal
        ON proposal.schedule_id=schedule.id AND proposal.schedule_key=schedule.schedule_key
          AND proposal.publication_id=schedule.publication_id AND proposal.scope_key=schedule.scope_key
          AND proposal.circle_id=schedule.circle_id AND proposal.cycle_key=schedule.cycle_key
          AND proposal.group_id=schedule.group_id AND proposal.member_count=schedule.member_count
          AND proposal.user_a_id=schedule.user_a_id AND proposal.user_b_id=schedule.user_b_id
          AND proposal.is_solo=schedule.is_solo AND proposal.proposal_key=?
      WHERE schedule.schedule_key=? LIMIT 3`,
    args:[payload.actorUserId,payload.actorUserId,payload.recipientUserId,payload.recipientUserId,
      payload.actorUserId,payload.proposalId,payload.scheduleId],
  });
  if((result.rows||[]).length!==1||!validOwnedSchedule(result.rows[0],payload)){
    return {suppressed:'SCHEDULE_INVALID'};
  }
  const row=result.rows[0];
  const userA=positiveId(row.user_a_id);
  const userB=positiveId(row.user_b_id);
  if(![userA,userB].includes(payload.actorUserId)||![userA,userB].includes(payload.recipientUserId)){
    return {suppressed:'PARTICIPANT_REVOKED'};
  }
  const partner=payload.actorUserId===userA?userB:userA;
  if(['proposal','removed'].includes(payload.kind)&&payload.recipientUserId!==partner){
    return {suppressed:'RECIPIENT_INVALID'};
  }
  if(String(row.actor_membership_status)!=='active'||Number(row.actor_is_demo)===1
    ||String(row.recipient_membership_status)!=='active'||Number(row.recipient_is_demo)===1
    ||String(row.partner_membership_status)!=='active'||Number(row.partner_is_demo)===1){
    return {suppressed:'PARTICIPANT_REVOKED'};
  }
  if(row.email_enabled!==null&&Number(row.email_enabled)===0){
    return {suppressed:'EMAIL_DISABLED'};
  }
  let instant=null;
  if(payload.kind==='proposal'){
    instant=normalizeScheduleInstant(String(row.proposal_instant||''));
    if(String(row.proposal_key)!==payload.proposalId||positiveId(row.proposed_by)!==payload.actorUserId
      ||!instant||secondaryScheduleInstantFingerprint(instant)!==payload.fingerprint){
      return {suppressed:'SCHEDULE_STALE'};
    }
  }else if(payload.kind==='removed'){
    if(row.proposal_key!==null) return {suppressed:'SCHEDULE_STALE'};
  }else if(['accepted','changed','reminder'].includes(payload.kind)){
    instant=normalizeScheduleInstant(String(row.agreed_time||''));
    const proposalInstant=normalizeScheduleInstant(String(row.proposal_instant||''));
    if(String(row.proposal_key)!==payload.proposalId||!instant||proposalInstant!==instant
      ||secondaryScheduleInstantFingerprint(instant)!==payload.fingerprint){
      return {suppressed:'SCHEDULE_STALE'};
    }
  }else if(payload.kind==='cleared'&&row.agreed_time!==null){
    return {suppressed:'SCHEDULE_STALE'};
  }
  if(instant&&Date.parse(String(row.now_utc))>=Date.parse(instant)){
    return {suppressed:'SESSION_ELAPSED'};
  }
  const email=String(row.recipient_email||'').trim().toLowerCase();
  const circleName=String(row.circle_name||'').trim();
  if(!email||email.length>320||!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)
    ||!circleName||circleName.length>120||/[\u0000-\u001f\u007f]/u.test(circleName)){
    return {suppressed:'RECIPIENT_INVALID'};
  }
  return {row,payload:Object.freeze({...payload,email,circleName,instant})};
}

function safeSubjectText(value,fallback){
  const text=String(value||fallback).replace(/[\u0000-\u001f\u007f]+/gu,' ').trim().slice(0,80);
  return text||fallback;
}

function formattedInstant(value){
  return new Intl.DateTimeFormat('en-GB',{
    timeZone:'UTC',dateStyle:'full',timeStyle:'short',hour12:false,
  }).format(new Date(value)).replace(' at ',', ')+' UTC';
}

function render(payload,row,origin){
  const actorName=safeSubjectText(row.actor_name,'Your partner');
  const actor=escapeHtml(actorName);
  const circleName=safeSubjectText(payload.circleName,'Your circle');
  const circle=escapeHtml(circleName);
  const dashboard=escapeHtml(`${origin}/?view=dashboard`);
  const when=payload.instant?escapeHtml(formattedInstant(payload.instant)):null;
  const footer=`<p><a href="${dashboard}">Open the Randori dashboard</a>.</p>`;
  if(payload.kind==='proposal') return Object.freeze({
    subject:`${circleName} — ${actorName} proposed a session time`,
    html:`<h2>${circle} — session proposal</h2><p>${actor} proposed <b>${when}</b>.</p>${footer}`,
  });
  if(payload.kind==='removed') return Object.freeze({
    subject:`${circleName} — a proposed session time was removed`,
    html:`<h2>${circle} — schedule update</h2><p>${actor} removed a proposed time.</p>${footer}`,
  });
  if(payload.kind==='accepted') return Object.freeze({
    subject:`${circleName} — your session is scheduled`,
    html:`<h2>${circle} — session scheduled</h2><p>Your pair agreed on <b>${when}</b>.</p>${footer}`,
  });
  if(payload.kind==='changed') return Object.freeze({
    subject:`${circleName} — your session time changed`,
    html:`<h2>${circle} — session rescheduled</h2><p>Your pair agreed on <b>${when}</b>.</p>${footer}`,
  });
  if(payload.kind==='reminder') return Object.freeze({
    subject:`${circleName} — your Randori session is coming up`,
    html:`<h2>${circle} — session reminder</h2><p>Your session starts at <b>${when}</b>.</p>${footer}`,
  });
  return Object.freeze({
    subject:`${circleName} — your session time was cleared`,
    html:`<h2>${circle} — session time cleared</h2><p>Your pair cleared the agreed time.</p>${footer}`,
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

export function createSecondaryScheduleEmailHandler({db,origin,send}={}){
  if(!db||typeof db.execute!=='function'||typeof send!=='function'){
    throw new TypeError('secondary schedule email database and provider are required');
  }
  return async(event,{signal}={})=>{
    const payload=parsePayload(event);
    if(!secondaryCircleScheduleEmailEnabled()){
      return {status:'suppressed',reasonCode:'SECONDARY_SCHEDULE_EMAIL_DISABLED'};
    }
    const resolved=await resolveDelivery(db,payload);
    if(resolved.suppressed) return {status:'suppressed',reasonCode:resolved.suppressed};
    const content=render(resolved.payload,resolved.row,origin);
    try{
      const delivery=await send({to:resolved.payload.email,subject:content.subject,html:content.html,
        kind:payload.kind,idempotencyKey:event.idempotencyKey,signal});
      if(delivery?.error) throw delivery.error;
      return {status:'delivered',providerName:String(delivery?.providerName||'email').slice(0,100),
        providerMessageId:delivery?.providerMessageId||delivery?.data?.id||null};
    }catch(error){ throw providerError(error); }
  };
}
