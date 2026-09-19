import { canonicalRoomId, escapeHtml } from './_pairing.js';
import { createOutboxEventStatement, OutboxDeliveryError, readOutboxMetrics, runOutboxWorker } from './_outbox.js';
import { classifyPairingProviderError } from './_pairing-email.js';
import { normalizeScheduleInstant, projectSchedule, readScheduleState } from './_schedule.js';

export const SCHEDULE_EMAIL_EVENT_TYPE='schedule.email.requested';
export const SCHEDULE_EMAIL_EVENT_VERSION=1;
export const SCHEDULE_EMAIL_TEMPLATE_VERSION=1;
export const SCHEDULE_REMINDER_LEAD_MS=24*60*60*1000;
export const SCHEDULE_EMAIL_DRAIN_BATCH_SIZE=3;

const KINDS=new Set(['proposal','accepted','changed','reminder']);
const VERSION_PATTERN=/^[a-f0-9]{64}$/;

function positiveId(value){
  const id=Number(value);
  return Number.isSafeInteger(id)&&id>0?id:null;
}

function scheduleEmailPayload(event){
  if(event.eventVersion!==SCHEDULE_EMAIL_EVENT_VERSION){
    throw new OutboxDeliveryError('EVENT_VERSION_UNSUPPORTED',{retryable:false});
  }
  const payload=event.payload;
  const expected=['actor_user_id','instant','kind','pair_group_id','previous_instant','recipient_user_id',
    'schedule_version','template_version','week_id'];
  if(!payload||Object.keys(payload).sort().join(',')!==expected.sort().join(',')){
    throw new OutboxDeliveryError('PAYLOAD_INVALID',{retryable:false});
  }
  const kind=String(payload.kind||'');
  const weekId=positiveId(payload.week_id);
  const pairGroupId=positiveId(payload.pair_group_id);
  const actorUserId=positiveId(payload.actor_user_id);
  const recipientUserId=positiveId(payload.recipient_user_id);
  const templateVersion=Number(payload.template_version);
  const scheduleVersion=String(payload.schedule_version||'');
  const instant=payload.instant===null?null:normalizeScheduleInstant(payload.instant);
  const previousInstant=payload.previous_instant===null?null:normalizeScheduleInstant(payload.previous_instant);
  if(!KINDS.has(kind)||!weekId||!pairGroupId||!actorUserId||!recipientUserId
    ||templateVersion!==SCHEDULE_EMAIL_TEMPLATE_VERSION||!VERSION_PATTERN.test(scheduleVersion)
    ||(kind!=='changed'&&!instant)||(payload.instant!==null&&instant!==payload.instant)
    ||(payload.previous_instant!==null&&previousInstant!==payload.previous_instant)
    ||(kind!=='changed'&&previousInstant!==null)
    ||(kind==='changed'&&(!previousInstant||previousInstant===instant))){
    throw new OutboxDeliveryError('PAYLOAD_INVALID',{retryable:false});
  }
  return Object.freeze({kind,weekId,pairGroupId,actorUserId,recipientUserId,
    scheduleVersion,templateVersion,instant,previousInstant});
}

function event({kind,weekId,pairGroupId,actorUserId,recipientUserId,scheduleVersion,
  instant=null,previousInstant=null,notBefore=null}){
  return createOutboxEventStatement({
    eventType:SCHEDULE_EMAIL_EVENT_TYPE,eventVersion:SCHEDULE_EMAIL_EVENT_VERSION,
    idempotencyKey:`schedule-email/v1/${weekId}/${pairGroupId}/${kind}/${scheduleVersion}/${recipientUserId}`,
    payload:{kind,week_id:weekId,pair_group_id:pairGroupId,actor_user_id:actorUserId,
      recipient_user_id:recipientUserId,schedule_version:scheduleVersion,
      template_version:SCHEDULE_EMAIL_TEMPLATE_VERSION,instant,previous_instant:previousInstant},
    notBefore,maxAttempts:5,deliveryTimeoutMs:10_000,
  });
}

function uniqueParticipantIds(participants){
  const ids=[];
  for(const value of participants||[]){
    const id=positiveId(value);
    if(id&&!ids.includes(id)) ids.push(id);
  }
  if(!ids.length||ids.length>3) throw new TypeError('valid schedule participants required');
  return ids;
}

/**
 * Build notification intents for a successful compare-and-swap mutation. The
 * caller commits these statements in the same batch as the schedule write.
 */
export function scheduleNotificationEvents({weekId,pairGroupId,actorUserId,participants,
  mutation,currentSchedule,nextSchedule}={}){
  const week=positiveId(weekId);
  const group=positiveId(pairGroupId);
  const actor=positiveId(actorUserId);
  const recipientIds=uniqueParticipantIds(participants);
  if(!week||!group||!actor||!mutation||!currentSchedule||!nextSchedule
    ||!VERSION_PATTERN.test(String(nextSchedule.version||''))){
    throw new TypeError('valid schedule notification context required');
  }
  const events=[];
  if(mutation.action==='propose'){
    for(const recipientUserId of recipientIds.filter(id=>id!==actor)){
      events.push(event({kind:'proposal',weekId:week,pairGroupId:group,actorUserId:actor,
        recipientUserId,scheduleVersion:nextSchedule.version,instant:mutation.instant}));
    }
    return events;
  }
  const previousInstant=currentSchedule.agreed_time||null;
  const nextInstant=nextSchedule.agreed_time||null;
  if(mutation.action==='accept'&&nextInstant!==previousInstant){
    const kind=previousInstant?'changed':'accepted';
    for(const recipientUserId of recipientIds){
      events.push(event({kind,weekId:week,pairGroupId:group,actorUserId:actor,
        recipientUserId,scheduleVersion:nextSchedule.version,instant:nextInstant,previousInstant}));
      events.push(event({kind:'reminder',weekId:week,pairGroupId:group,actorUserId:actor,
        recipientUserId,scheduleVersion:nextSchedule.version,instant:nextInstant,
        notBefore:new Date(Date.parse(nextInstant)-SCHEDULE_REMINDER_LEAD_MS).toISOString()}));
    }
  }else if(mutation.action==='clear'&&previousInstant){
    for(const recipientUserId of recipientIds){
      events.push(event({kind:'changed',weekId:week,pairGroupId:group,actorUserId:actor,
        recipientUserId,scheduleVersion:nextSchedule.version,instant:null,previousInstant}));
    }
  }
  return events;
}

function scheduleRecipientSql(localRuntime){
  const membership=localRuntime?'':`AND EXISTS (
      SELECT 1 FROM circle_memberships membership
      JOIN circles circle ON circle.id=membership.circle_id
      WHERE membership.user_id=account.id AND membership.status='active'
        AND circle.is_primary=1 AND circle.archived_at IS NULL
    ) AND EXISTS (
      SELECT 1 FROM circle_memberships actor_membership
      JOIN circles actor_circle ON actor_circle.id=actor_membership.circle_id
      WHERE actor_membership.user_id=actor_account.id AND actor_membership.status='active'
        AND actor_circle.is_primary=1 AND actor_circle.archived_at IS NULL
    )`;
  return `SELECT schedule.proposed_times,schedule.agreed_time,schedule.updated_at,
      account.email,account.display_name,account.is_demo,
      COALESCE(preference.email_enabled,1) AS email_enabled,
      week.week_label,actor_account.display_name AS actor_name,
      strftime('%Y-%m-%dT%H:%M:%fZ','now') AS now_utc
    FROM pair_schedules schedule
    JOIN pairing_groups pair ON pair.id=schedule.pair_group_id AND pair.week_id=schedule.week_id
    JOIN pairing_participants participant ON participant.week_id=pair.week_id
      AND participant.user_id=? AND participant.source='auth'
    JOIN pairing_participants actor_participant ON actor_participant.week_id=pair.week_id
      AND actor_participant.user_id=? AND actor_participant.source='auth'
    JOIN auth_accounts account ON account.id=participant.user_id
    JOIN auth_accounts actor_account ON actor_account.id=actor_participant.user_id
      AND COALESCE(actor_account.is_demo,0)=0
    JOIN pairing_weeks week ON week.id=pair.week_id
    LEFT JOIN user_notification_prefs preference ON preference.user_id=account.id
    WHERE schedule.week_id=? AND schedule.pair_group_id=?
      AND (pair.user_a_id=? OR pair.user_b_id=? OR pair.user_c_id=?)
      AND (pair.user_a_id=? OR pair.user_b_id=? OR pair.user_c_id=?)
      AND COALESCE(account.is_demo,0)=0 ${membership}
    LIMIT 2`;
}

function currentEvent(row,payload){
  const schedule=projectSchedule(readScheduleState(row));
  if(payload.kind==='proposal'){
    return schedule.proposals.some(proposal=>proposal.legacy===false
      &&proposal.instant===payload.instant&&proposal.proposed_by===payload.actorUserId);
  }
  if(payload.kind==='changed'&&payload.instant===null){
    return !schedule.agreed_time&&!schedule.legacy_agreed_time;
  }
  return schedule.agreed_time===payload.instant;
}

async function supersededEvent(db,event,payload){
  const kindPredicate=payload.kind==='proposal'
    ?`((json_extract(payload_json,'$.kind')='proposal'
        AND json_extract(payload_json,'$.actor_user_id')=?
        AND json_extract(payload_json,'$.instant')=?)
      OR (json_extract(payload_json,'$.kind') IN ('accepted','changed')
        AND json_extract(payload_json,'$.instant')=?))`
    :payload.kind==='reminder'
      ?`json_extract(payload_json,'$.kind')='reminder'`
      :`json_extract(payload_json,'$.kind') IN ('accepted','changed')`;
  const args=[event.id,SCHEDULE_EMAIL_EVENT_TYPE,payload.weekId,payload.pairGroupId,payload.recipientUserId];
  if(payload.kind==='proposal') args.push(payload.actorUserId,payload.instant,payload.instant);
  const result=await db.execute({sql:`SELECT 1 AS newer FROM outbox_events
      WHERE id>? AND event_type=?
        AND json_extract(payload_json,'$.week_id')=?
        AND json_extract(payload_json,'$.pair_group_id')=?
        AND json_extract(payload_json,'$.recipient_user_id')=?
        AND ${kindPredicate}
      LIMIT 1`,args});
  return Boolean(result.rows?.length);
}

function formattedInstant(value){
  return new Intl.DateTimeFormat('en-GB',{
    timeZone:'UTC',dateStyle:'full',timeStyle:'short',hour12:false,
  }).format(new Date(value)).replace(' at ',', ')+' UTC';
}

function subjectText(value,fallback){
  const text=String(value||fallback).replace(/[\u0000-\u001f\u007f]+/gu,' ').trim().slice(0,80);
  return text||fallback;
}

function renderScheduleEmail(payload,row,origin){
  const actorName=subjectText(row.actor_name,'Your partner');
  const actor=escapeHtml(actorName);
  const week=escapeHtml(String(row.week_label||'your current cycle').slice(0,100));
  const roomUrl=escapeHtml(`${origin}/join/${canonicalRoomId(payload.weekId,payload.pairGroupId)}`);
  const when=payload.instant?escapeHtml(formattedInstant(payload.instant)):null;
  const previous=payload.previousInstant?escapeHtml(formattedInstant(payload.previousInstant)):null;
  const footer=`<p><a href="${roomUrl}">Open your private pairing room</a>. Randori shows this time in your local timezone.</p>`;
  if(payload.kind==='proposal') return Object.freeze({
    subject:`${actorName} proposed a Randori session time`,
    html:`<h2>New time proposed for ${week}</h2><p>${actor} proposed <b>${when}</b>.</p>${footer}`,
  });
  if(payload.kind==='accepted') return Object.freeze({
    subject:'Your Randori session is scheduled',
    html:`<h2>Session scheduled for ${week}</h2><p>Your pair agreed on <b>${when}</b>.</p>${footer}`,
  });
  if(payload.kind==='reminder') return Object.freeze({
    subject:'Reminder: your Randori session is coming up',
    html:`<h2>Randori session reminder</h2><p>Your ${week} session starts at <b>${when}</b>.</p>${footer}`,
  });
  if(payload.instant) return Object.freeze({
    subject:'Your Randori session time changed',
    html:`<h2>Session rescheduled for ${week}</h2><p>The session moved${previous?` from <s>${previous}</s>`:''} to <b>${when}</b>.</p>${footer}`,
  });
  return Object.freeze({
    subject:'Your Randori session time was cleared',
    html:`<h2>Session time cleared for ${week}</h2><p>The agreed time${previous?` (${previous})`:''} was cleared. Return to your room to choose another time.</p>${footer}`,
  });
}

export function createScheduleEmailHandler({db,baseUrl,send,localRuntime=false}={}){
  if(!db||typeof db.execute!=='function'||typeof send!=='function'){
    throw new TypeError('schedule email database and provider are required');
  }
  if(typeof localRuntime!=='boolean') throw new TypeError('invalid schedule email runtime');
  let origin;
  try{ origin=new URL(String(baseUrl)).origin; }
  catch{ throw new TypeError('valid schedule email base URL required'); }
  return async(event,{signal}={})=>{
    let payload;
    try{ payload=scheduleEmailPayload(event); }
    catch(error){
      if(error instanceof OutboxDeliveryError) throw error;
      throw new OutboxDeliveryError('PAYLOAD_INVALID',{retryable:false});
    }
    const result=await db.execute({
      sql:scheduleRecipientSql(localRuntime),
      args:[payload.recipientUserId,payload.actorUserId,payload.weekId,payload.pairGroupId,
        payload.recipientUserId,payload.recipientUserId,payload.recipientUserId,
        payload.actorUserId,payload.actorUserId,payload.actorUserId],
    });
    if((result.rows||[]).length!==1){
      return {status:'suppressed',reasonCode:localRuntime?'PARTICIPANT_INACTIVE':'PARTICIPANT_REVOKED'};
    }
    const row=result.rows[0];
    if(Number(row.email_enabled)===0) return {status:'suppressed',reasonCode:'EMAIL_DISABLED'};
    let isCurrent=false;
    try{ isCurrent=currentEvent(row,payload); }
    catch{ return {status:'suppressed',reasonCode:'SCHEDULE_INVALID'}; }
    if(!isCurrent) return {status:'suppressed',reasonCode:'SCHEDULE_STALE'};
    if(await supersededEvent(db,event,payload)){
      return {status:'suppressed',reasonCode:'SCHEDULE_SUPERSEDED'};
    }
    const email=String(row.email||'').trim().toLowerCase();
    if(email.length>320||!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)){
      return {status:'suppressed',reasonCode:'RECIPIENT_INVALID'};
    }
    if(payload.instant&&Date.parse(String(row.now_utc))>=Date.parse(payload.instant)){
      return {status:'suppressed',reasonCode:'SESSION_ELAPSED'};
    }
    const content=renderScheduleEmail(payload,row,origin);
    try{
      const delivery=await send({to:email,subject:content.subject,html:content.html,
        idempotencyKey:event.idempotencyKey,signal});
      if(delivery?.error) throw delivery.error;
      return {status:'delivered',providerName:String(delivery?.providerName||'email').slice(0,100),
        providerMessageId:delivery?.providerMessageId||delivery?.data?.id||null};
    }catch(error){ throw classifyPairingProviderError(error); }
  };
}

function countStatuses(metrics){
  const counts={pending:0,processing:0,retry:0,delivered:0,suppressed:0,dead_letter:0};
  for(const metric of metrics) counts[metric.status]=(counts[metric.status]||0)+metric.count;
  return counts;
}

export async function scheduleEmailStatus(db){
  return countStatuses(await readOutboxMetrics(db,{eventType:SCHEDULE_EMAIL_EVENT_TYPE}));
}

export async function deliverScheduleEmails({db,baseUrl,send,workerId,localRuntime=false,workerOptions={}}={}){
  const handler=createScheduleEmailHandler({db,baseUrl,send,localRuntime});
  const result=await runOutboxWorker({
    db,workerId,eventType:SCHEDULE_EMAIL_EVENT_TYPE,
    handlers:{[SCHEDULE_EMAIL_EVENT_TYPE]:handler},...workerOptions,
  });
  const status=await scheduleEmailStatus(db);
  return Object.freeze({...result,status});
}
