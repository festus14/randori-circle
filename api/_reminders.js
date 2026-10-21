// Issue #287: availability-cutoff reminder, agree-a-time nudge, and optional
// short-notice (one hour) session reminder.
//
// Everything here is behind REMINDERS_ENABLED (default off). The one-hour
// reminder additionally needs REMINDERS_SESSION_SOON_ENABLED. Reminders are
// enqueued by a bounded due-check inside the existing `/api/cron/outbox`
// invocation and delivered through the shared outbox as one event type, so the
// fair one-per-type dispatch round gains a single lane. Payloads carry only
// stable identifiers; the handler re-reads current state at send time and
// suppresses when the reason for the reminder no longer holds.
import { createHash } from 'node:crypto';

import { multiCircleAvailabilityEnabled, secondaryCircleSchedulingEnabled } from './_active-circle.js';
import { availabilityCycleKey } from './_availability.js';
import { emailProviderReason } from './_email-provider-reason.js';
import { createOutboxEventStatement, OutboxDeliveryError } from './_outbox.js';
import { resolvePairingCycle } from './_pairing-cycle.js';
import { canonicalRoomId, escapeHtml } from './_pairing.js';
import { normalizeScheduleInstant } from './_schedule.js';

export const REMINDER_EMAIL_EVENT_TYPE='reminder.email.requested';
export const REMINDER_EMAIL_EVENT_VERSION=1;
export const REMINDER_TEMPLATE_VERSION=1;
export const AVAILABILITY_CUTOFF_LEAD_MS=24*60*60*1000;
export const AGREE_TIME_NUDGE_DELAY_MS=72*60*60*1000;
export const SESSION_SOON_LEAD_MS=60*60*1000;
// The due-check looks slightly past the lead so a five-minute scheduler can
// queue the reminder before it is due; `not_before` keeps it on time.
export const SESSION_SOON_LOOKAHEAD_MS=SESSION_SOON_LEAD_MS+5*60*1000;
// A session closer than this gets no short-notice reminder: the pair has just
// agreed it, or delivery ran late, and the email would arrive too late to help.
export const SESSION_SOON_MIN_LEAD_MS=15*60*1000;
export const REMINDER_ENQUEUE_LIMIT=50;
export const REMINDER_KINDS=Object.freeze(['availability_cutoff','agree_time','session_soon']);

const MAX_CIRCLES=100;
const CYCLE_KEY_PATTERN=/^[a-f0-9]{64}$/;
const EMAIL_PATTERN=/^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const ERROR_CODE_PATTERN=/^[A-Z][A-Z0-9_]{0,63}$/;
// Due-check order: the time-critical kind first, so a failure or slow query in
// a later kind cannot delay it.
const DUE_CHECK_ORDER=Object.freeze(['session_soon','agree_time','availability_cutoff']);
const PAYLOAD_KEYS=Object.freeze({
  availability_cutoff:['circle_id','cycle_key','kind','recipient_user_id','template_version'],
  'availability_cutoff:local':['cycle_key','kind','recipient_user_id','scope','template_version'],
  'agree_time:primary':['kind','pair_group_id','recipient_user_id','scope','template_version','week_id'],
  'agree_time:secondary':['group_id','kind','publication_id','recipient_user_id','scope','template_version'],
  'session_soon:primary':['instant_fingerprint','kind','pair_group_id','recipient_user_id','scope',
    'template_version','week_id'],
  'session_soon:secondary':['group_id','instant_fingerprint','kind','publication_id','recipient_user_id',
    'scope','template_version'],
});

export function remindersEnabled(env=process.env){
  return env.REMINDERS_ENABLED==='true';
}

export function sessionSoonRemindersEnabled(env=process.env){
  return remindersEnabled(env)&&env.REMINDERS_SESSION_SOON_ENABLED==='true';
}

/**
 * What the notification preferences endpoint advertises. `null` while the
 * feature is off so the response is unchanged. Every type follows the
 * existing `email_enabled` preference; per-type toggles need a schema change
 * and are deferred (see docs/REMINDERS.md).
 */
export function reminderPreferenceDescriptor(env=process.env){
  if(!remindersEnabled(env)) return null;
  return Object.freeze({
    availability_cutoff:true,
    agree_time:true,
    session_soon:sessionSoonRemindersEnabled(env),
    controlled_by:'email_enabled',
  });
}

function positiveInteger(value){
  return Number.isSafeInteger(value)&&value>0;
}

function validNow(value){
  const date=value instanceof Date?new Date(value.getTime()):new Date(value);
  if(!Number.isFinite(date.getTime())) throw new TypeError('valid reminder clock required');
  return date;
}

function readClock(now){
  return validNow(typeof now==='function'?now():now);
}

export function reminderInstantFingerprint(value){
  const instant=normalizeScheduleInstant(value);
  if(!instant||instant!==value) throw new TypeError('normalized reminder instant required');
  return createHash('sha256').update(`randori-reminder-instant-v1\0${instant}`,'utf8').digest('hex');
}

function reminderKey(payload){
  const user=payload.recipient_user_id;
  if(payload.kind==='availability_cutoff'){
    const scope=payload.scope==='local'?'local':payload.circle_id;
    return `reminder-email/v1/availability-cutoff/${scope}/${payload.cycle_key}/${user}`;
  }
  const pair=payload.scope==='primary'
    ?`primary/${payload.week_id}/${payload.pair_group_id}`
    :`secondary/${payload.publication_id}/${payload.group_id}`;
  if(payload.kind==='agree_time') return `reminder-email/v1/agree-time/${pair}/${user}`;
  return `reminder-email/v1/session-soon/${pair}/${payload.instant_fingerprint}/${user}`;
}

/** Build one immutable reminder intent. Exported for tests and replay tooling. */
export function reminderEventStatement(payload,{notBefore=null}={}){
  const body={...payload,template_version:REMINDER_TEMPLATE_VERSION};
  validatePayload(body);
  return createOutboxEventStatement({
    eventType:REMINDER_EMAIL_EVENT_TYPE,eventVersion:REMINDER_EMAIL_EVENT_VERSION,
    idempotencyKey:reminderKey(body),payload:body,notBefore,maxAttempts:5,deliveryTimeoutMs:10_000,
  });
}

function exactKeys(value,expected){
  const actual=Object.keys(value).sort();
  return actual.length===expected.length&&actual.every((key,index)=>key===expected[index]);
}

function validatePayload(payload){
  if(!payload||typeof payload!=='object'||Array.isArray(payload)){
    throw new OutboxDeliveryError('PAYLOAD_INVALID',{retryable:false});
  }
  const kind=String(payload.kind);
  const shape=kind==='availability_cutoff'&&!Object.hasOwn(payload,'scope')?kind:`${kind}:${String(payload.scope)}`;
  const expected=PAYLOAD_KEYS[shape];
  if(!expected||!exactKeys(payload,expected)||payload.template_version!==REMINDER_TEMPLATE_VERSION
    ||!positiveInteger(payload.recipient_user_id)){
    throw new OutboxDeliveryError('PAYLOAD_INVALID',{retryable:false});
  }
  const ids=kind==='availability_cutoff'?(payload.scope==='local'?[]:[payload.circle_id])
    :payload.scope==='primary'?[payload.week_id,payload.pair_group_id]:[payload.publication_id,payload.group_id];
  if(!ids.every(positiveInteger)
    ||(kind==='availability_cutoff'&&!CYCLE_KEY_PATTERN.test(String(payload.cycle_key)))
    ||(kind==='session_soon'&&!CYCLE_KEY_PATTERN.test(String(payload.instant_fingerprint)))){
    throw new OutboxDeliveryError('PAYLOAD_INVALID',{retryable:false});
  }
  return Object.freeze({...payload});
}

function parseEvent(event){
  if(event?.eventVersion!==REMINDER_EMAIL_EVENT_VERSION){
    throw new OutboxDeliveryError('EVENT_VERSION_UNSUPPORTED',{retryable:false});
  }
  return validatePayload(event.payload);
}

// ---------------------------------------------------------------------------
// Due-check (enqueue)
// ---------------------------------------------------------------------------

function activePrimaryMember(userExpression){
  return `EXISTS (SELECT 1 FROM circle_memberships membership
    JOIN circles circle ON circle.id=membership.circle_id
    WHERE membership.user_id=${userExpression} AND membership.status='active'
      AND circle.is_primary=1 AND circle.archived_at IS NULL)`;
}

// Every member of the primary pair is an auth participant of the week, a real
// (non-demo) account and, outside the membership-free local runtime, still an
// active primary-circle member. A partner who left suppresses the reminder.
function pairMembersQualified(localScope){
  return `(SELECT COUNT(*) FROM pairing_participants member_participant
      JOIN auth_accounts member ON member.id=member_participant.user_id AND COALESCE(member.is_demo,0)=0
      WHERE member_participant.week_id=pair.week_id AND member_participant.source='auth'
        AND member_participant.user_id IN (pair.user_a_id,pair.user_b_id,pair.user_c_id)
        ${localScope?'':`AND ${activePrimaryMember('member.id')}`})
    =(CASE WHEN pair.user_c_id IS NULL THEN 2 ELSE 3 END)`;
}

function humanPrimaryPair(localScope){
  return `COALESCE(pair.is_ai_pair,0)=0 AND pair.user_a_id<>pair.user_b_id AND ${pairMembersQualified(localScope)}`;
}

function sqliteInstant(value){
  const text=String(value??'');
  const iso=/(?:Z|[+-]\d\d:\d\d)$/u.test(text)?text.replace(' ','T'):`${text.replace(' ','T')}Z`;
  const epoch=Date.parse(iso);
  return Number.isFinite(epoch)?epoch:null;
}

async function insertIntents(db,intents){
  if(!intents.length) return 0;
  const results=await db.batch(intents.map(({payload,notBefore})=>reminderEventStatement(payload,{notBefore})),'write');
  return results.reduce((sum,result)=>sum+Number(result?.rowsAffected||0),0);
}

/**
 * The published primary weeks of the current and previous cycle, read first
 * with one indexed lookup so the per-pair queries only run for a known week.
 */
async function primaryWeeks(db,{now,timeZone}){
  const current=resolvePairingCycle({now,timeZone,state:'current'});
  const previous=resolvePairingCycle({now:new Date(Date.parse(current.startsAt)-1),timeZone,state:'current'});
  const result=await db.execute({
    sql:`SELECT week.id,week.week_label,run.created_at FROM pairing_weeks week
      JOIN pairing_week_runs run ON run.week_id=week.id AND run.week_label=week.week_label
      WHERE week.week_label IN (?,?) AND COALESCE(week.is_demo,0)=0`,
    args:[current.cycleId,previous.cycleId],
  });
  const byLabel=new Map(result.rows.map(row=>[String(row.week_label),row]));
  return {current:byLabel.get(current.cycleId)||null,previous:byLabel.get(previous.cycleId)||null};
}

async function availabilityCutoffIntents(db,{now,timeZone,limit,localScope}){
  const cycle=resolvePairingCycle({now,timeZone,state:'upcoming'});
  const cutoff=Date.parse(cycle.cutoffAt);
  if(now.getTime()<cutoff-AVAILABILITY_CUTOFF_LEAD_MS||now.getTime()>=cutoff) return [];
  if(localScope){
    // Mirrors the availability endpoint in a membership-free local runtime:
    // decisions live under the `local` scope and every real account takes part.
    const cycleKey=availabilityCycleKey({kind:'local'},cycle);
    const members=await db.execute({
      sql:`SELECT account.id AS user_id FROM auth_accounts account
        LEFT JOIN user_notification_prefs preference ON preference.user_id=account.id
        WHERE COALESCE(account.is_demo,0)=0 AND COALESCE(preference.email_enabled,1)<>0
          AND NOT EXISTS (SELECT 1 FROM pairing_cycle_availability decision
            WHERE decision.scope_key='local' AND decision.cycle_key=? AND decision.user_id=account.id
              AND decision.decision_source='user')
          AND NOT EXISTS (SELECT 1 FROM outbox_events queued WHERE queued.idempotency_key=
            ('reminder-email/v1/availability-cutoff/local/'||?||'/'||account.id))
        ORDER BY account.id LIMIT ?`,
      args:[cycleKey,cycleKey,limit],
    });
    return members.rows.map(row=>({payload:{kind:'availability_cutoff',scope:'local',cycle_key:cycleKey,
      recipient_user_id:Number(row.user_id)},notBefore:null}));
  }
  const circles=await db.execute({
    sql:`SELECT id FROM circles WHERE archived_at IS NULL AND (is_primary=1 OR ?=1)
      ORDER BY is_primary DESC,id LIMIT ?`,
    args:[multiCircleAvailabilityEnabled()?1:0,MAX_CIRCLES],
  });
  const intents=[];
  for(const circle of circles.rows){
    if(intents.length>=limit) break;
    const circleId=Number(circle.id);
    const scopeKey=`circle:${circleId}`;
    const cycleKey=availabilityCycleKey({kind:'circle',circleId},cycle);
    const members=await db.execute({
      sql:`SELECT account.id AS user_id
        FROM circle_memberships membership
        JOIN auth_accounts account ON account.id=membership.user_id
        LEFT JOIN user_notification_prefs preference ON preference.user_id=account.id
        WHERE membership.circle_id=? AND membership.status='active'
          AND COALESCE(account.is_demo,0)=0 AND COALESCE(preference.email_enabled,1)<>0
          AND NOT EXISTS (SELECT 1 FROM pairing_cycle_availability decision
            WHERE decision.scope_key=? AND decision.cycle_key=? AND decision.user_id=account.id
              AND decision.decision_source='user')
          AND NOT EXISTS (SELECT 1 FROM outbox_events queued WHERE queued.idempotency_key=
            ('reminder-email/v1/availability-cutoff/'||?||'/'||?||'/'||account.id))
        ORDER BY account.id LIMIT ?`,
      // The key prefix is bound as text: a JS number binds as REAL and would
      // concatenate as '1.0', silently defeating the queued-key filter.
      args:[circleId,scopeKey,cycleKey,String(circleId),cycleKey,limit-intents.length],
    });
    for(const row of members.rows){
      intents.push({payload:{kind:'availability_cutoff',circle_id:circleId,cycle_key:cycleKey,
        recipient_user_id:Number(row.user_id)},notBefore:null});
    }
  }
  return intents;
}

// The pairs CTE is materialized once and then expanded to its two or three
// members; callers bind the pair filter's arguments first.
function primaryRecipientSql(pairsSql){
  return `WITH pairs AS MATERIALIZED (${pairsSql}),
    recipients AS (
      SELECT week_id,group_id,agreed_time,user_a_id AS user_id FROM pairs
      UNION SELECT week_id,group_id,agreed_time,user_b_id FROM pairs
      UNION SELECT week_id,group_id,agreed_time,user_c_id FROM pairs WHERE user_c_id IS NOT NULL)
    SELECT recipient.week_id,recipient.group_id,recipient.agreed_time,recipient.user_id
    FROM recipients recipient
    LEFT JOIN user_notification_prefs preference ON preference.user_id=recipient.user_id
    WHERE COALESCE(preference.email_enabled,1)<>0`;
}

async function agreeTimeIntents(db,{now,timeZone,limit,localScope,weeks}){
  const intents=[];
  const pairedBefore=new Date(now.getTime()-AGREE_TIME_NUDGE_DELAY_MS).toISOString();
  const week=weeks.current;
  const pairedAt=week?sqliteInstant(week.created_at):null;
  // No query at all until the current week's pairing is 72 hours old.
  if(pairedAt!==null&&pairedAt<=Date.parse(pairedBefore)){
    const primary=await db.execute({
      sql:`${primaryRecipientSql(`SELECT pair.week_id,pair.id AS group_id,NULL AS agreed_time,
          pair.user_a_id,pair.user_b_id,pair.user_c_id
        FROM pairing_groups pair
        LEFT JOIN pair_schedules schedule ON schedule.week_id=pair.week_id AND schedule.pair_group_id=pair.id
        WHERE pair.week_id=? AND COALESCE(schedule.agreed_time,'')=''
          AND ${humanPrimaryPair(localScope)}`)}
        AND NOT EXISTS (SELECT 1 FROM outbox_events queued WHERE queued.idempotency_key=
          ('reminder-email/v1/agree-time/primary/'||recipient.week_id||'/'||recipient.group_id||'/'||recipient.user_id))
      ORDER BY recipient.group_id,recipient.user_id LIMIT ?`,
      args:[Number(week.id),limit],
    });
    for(const row of primary.rows){
      intents.push({payload:{kind:'agree_time',scope:'primary',week_id:Number(row.week_id),
        pair_group_id:Number(row.group_id),recipient_user_id:Number(row.user_id)},notBefore:null});
    }
  }
  if(secondaryCircleSchedulingEnabled()&&intents.length<limit){
    const instant=now.toISOString();
    const secondary=await db.execute({
      sql:`${secondaryRecipientSql(`AND julianday(publication.created_at)<=julianday(?)
          AND NOT EXISTS (SELECT 1 FROM circle_pair_schedules schedule
            WHERE schedule.publication_id=publication.id AND schedule.group_id=group_row.id
              AND schedule.agreed_time IS NOT NULL)`)}
        AND NOT EXISTS (SELECT 1 FROM outbox_events queued WHERE queued.idempotency_key=
          ('reminder-email/v1/agree-time/secondary/'||recipient.publication_id||'/'||recipient.group_id
            ||'/'||recipient.user_id))
        ORDER BY recipient.group_id,recipient.user_id LIMIT ?`,
      args:[instant,instant,pairedBefore,limit-intents.length],
    });
    for(const row of secondary.rows){
      intents.push({payload:{kind:'agree_time',scope:'secondary',publication_id:Number(row.publication_id),
        group_id:Number(row.group_id),recipient_user_id:Number(row.user_id)},notBefore:null});
    }
  }
  return intents;
}

// Current-cycle, non-solo secondary groups expanded to both members, each an
// active non-demo member of the unarchived secondary circle with email on.
// Secondary schedules belong to their publication, so (like the secondary
// 24-hour reminder) they are only reminded while it is current.
function secondaryRecipientSql(filterSql,{agreedTime=false}={}){
  return `WITH recipients AS (
      SELECT publication.id AS publication_id,group_row.id AS group_id,publication.circle_id,
        ${agreedTime?'schedule.agreed_time':'NULL'} AS agreed_time,
        CASE slot.position WHEN 0 THEN group_row.user_a_id ELSE group_row.user_b_id END AS user_id,
        CASE slot.position WHEN 0 THEN group_row.user_b_id ELSE group_row.user_a_id END AS partner_id
      FROM circle_pairing_publications publication
      JOIN circles circle ON circle.id=publication.circle_id AND circle.is_primary=0 AND circle.archived_at IS NULL
      JOIN circle_pairing_groups group_row ON group_row.publication_id=publication.id
        AND group_row.circle_id=publication.circle_id AND group_row.is_solo=0
      ${agreedTime?`JOIN circle_pair_schedules schedule ON schedule.publication_id=publication.id
        AND schedule.group_id=group_row.id`:''}
      JOIN (SELECT 0 AS position UNION ALL SELECT 1 AS position) slot
      WHERE publication.starts_at<=? AND publication.ends_at>? ${filterSql})
    SELECT recipient.publication_id,recipient.group_id,recipient.agreed_time,recipient.user_id
    FROM recipients recipient
    JOIN auth_accounts account ON account.id=recipient.user_id AND COALESCE(account.is_demo,0)=0
    JOIN circle_memberships membership ON membership.circle_id=recipient.circle_id
      AND membership.user_id=recipient.user_id AND membership.status='active'
    JOIN auth_accounts partner ON partner.id=recipient.partner_id AND COALESCE(partner.is_demo,0)=0
    JOIN circle_memberships partner_membership ON partner_membership.circle_id=recipient.circle_id
      AND partner_membership.user_id=recipient.partner_id AND partner_membership.status='active'
    LEFT JOIN user_notification_prefs preference ON preference.user_id=account.id
    WHERE COALESCE(preference.email_enabled,1)<>0`;
}

async function withoutQueued(db,intents,limit){
  if(!intents.length) return intents;
  const keys=intents.map(({payload})=>reminderKey({...payload,template_version:REMINDER_TEMPLATE_VERSION}));
  const queued=await db.execute({
    sql:`SELECT idempotency_key FROM outbox_events WHERE idempotency_key IN (${keys.map(()=>'?').join(',')})`,
    args:keys,
  });
  const existing=new Set(queued.rows.map(row=>String(row.idempotency_key)));
  return intents.filter((_,index)=>!existing.has(keys[index])).slice(0,limit);
}

async function sessionSoonIntents(db,{now,limit,localScope,weeks}){
  // The key includes a fingerprint computed here, so already-queued keys are
  // filtered after the read. Candidates are the earliest sessions first and
  // over-fetched, so queued ones cannot starve a later session in the window.
  const candidates=limit*4;
  const intents=[];
  const from=new Date(now.getTime()+SESSION_SOON_MIN_LEAD_MS).toISOString();
  const until=new Date(now.getTime()+SESSION_SOON_LOOKAHEAD_MS).toISOString();
  // Legacy free-text agreements never match the normalized-instant check.
  const collect=(rows,scope)=>{
    for(const row of rows){
      const instant=normalizeScheduleInstant(String(row.agreed_time));
      if(instant!==row.agreed_time) continue;
      const groupId=Number(row.group_id);
      const payload={kind:'session_soon',scope,instant_fingerprint:reminderInstantFingerprint(instant),
        recipient_user_id:Number(row.user_id),
        ...(scope==='primary'?{week_id:Number(row.week_id),pair_group_id:groupId}
          :{publication_id:Number(row.publication_id),group_id:groupId})};
      intents.push({payload,notBefore:new Date(Date.parse(instant)-SESSION_SOON_LEAD_MS).toISOString()});
    }
  };
  // Primary schedules are not cycle-bound: a pair from the previous week can
  // agree a time after the Sunday boundary, so both weeks are in scope.
  const weekIds=[weeks.current,weeks.previous].filter(Boolean).map(week=>Number(week.id));
  if(weekIds.length){
    const primary=await db.execute({
      sql:`${primaryRecipientSql(`SELECT pair.week_id,pair.id AS group_id,schedule.agreed_time,
          pair.user_a_id,pair.user_b_id,pair.user_c_id
        FROM pair_schedules schedule
        JOIN pairing_groups pair ON pair.id=schedule.pair_group_id AND pair.week_id=schedule.week_id
        WHERE schedule.week_id IN (${weekIds.map(()=>'?').join(',')})
          AND schedule.agreed_time>? AND schedule.agreed_time<=? AND ${humanPrimaryPair(localScope)}`)}
      ORDER BY recipient.agreed_time,recipient.group_id,recipient.user_id LIMIT ?`,
      args:[...weekIds,from,until,candidates],
    });
    collect(primary.rows,'primary');
  }
  if(secondaryCircleSchedulingEnabled()){
    const instant=now.toISOString();
    const secondary=await db.execute({
      sql:`${secondaryRecipientSql(`AND schedule.agreed_time>? AND schedule.agreed_time<=?`,{agreedTime:true})}
        ORDER BY recipient.agreed_time,recipient.group_id,recipient.user_id LIMIT ?`,
      args:[instant,instant,from,until,candidates],
    });
    collect(secondary.rows,'secondary');
  }
  return withoutQueued(db,intents,limit);
}

function dueCheckErrorCode(error){
  const code=String(error?.code||'').toUpperCase();
  return ERROR_CODE_PATTERN.test(code)?code:'QUERY_FAILED';
}

/**
 * Bounded, idempotent due-check run from the outbox cron. Each kind creates at
 * most `limit` new intents per call; repeated calls never duplicate because
 * every intent has a stable idempotency key. Kinds run independently: one
 * failing kind reports a bounded error code (and a null count) without
 * stopping the others. Returns counts and error codes only.
 */
export async function enqueueDueReminders(db,{now=()=>new Date(),timeZone,limit=REMINDER_ENQUEUE_LIMIT,
  localScope=false}={}){
  const counts={availability_cutoff:0,agree_time:0,session_soon:0};
  if(!remindersEnabled()) return Object.freeze({enabled:false,...counts,errors:{}});
  if(!db||typeof db.execute!=='function'||typeof db.batch!=='function'){
    throw new TypeError('reminder database client required');
  }
  const bound=Number.isSafeInteger(limit)&&limit>0&&limit<=REMINDER_ENQUEUE_LIMIT?limit:REMINDER_ENQUEUE_LIMIT;
  const instant=readClock(now);
  const options={now:instant,timeZone,limit:bound,localScope:localScope===true};
  const errors={};
  let weeks=null;
  const builders={
    session_soon:async()=>sessionSoonIntents(db,{...options,weeks:weeks??=await primaryWeeks(db,options)}),
    agree_time:async()=>agreeTimeIntents(db,{...options,weeks:weeks??=await primaryWeeks(db,options)}),
    availability_cutoff:()=>availabilityCutoffIntents(db,options),
  };
  for(const kind of DUE_CHECK_ORDER){
    if(kind==='session_soon'&&!sessionSoonRemindersEnabled()) continue;
    try{ counts[kind]=await insertIntents(db,await builders[kind]()); }
    catch(error){
      counts[kind]=null;
      errors[kind]=dueCheckErrorCode(error);
    }
  }
  return Object.freeze({enabled:true,...counts,errors:Object.freeze(errors)});
}

// ---------------------------------------------------------------------------
// Delivery (send-time suppression and rendering)
// ---------------------------------------------------------------------------

const RECIPIENT_COLUMNS=`account.email AS recipient_email,account.tz AS recipient_tz,
  account.is_demo AS recipient_is_demo,COALESCE(preference.email_enabled,1) AS email_enabled`;

function circleLabel(value){
  return String(value).replace(/[\u0000-\u001f\u007f]+/gu,' ').trim().slice(0,80)||'Your circle';
}

function suppressed(reasonCode){
  return {status:'suppressed',reasonCode};
}

function recipientProblem(row){
  if(Number(row.recipient_is_demo)===1) return 'MEMBER_REMOVED';
  if(Number(row.email_enabled)===0) return 'EMAIL_DISABLED';
  const email=String(row.recipient_email).trim().toLowerCase();
  if(!email||email.length>320||!EMAIL_PATTERN.test(email)) return 'RECIPIENT_INVALID';
  return null;
}

async function resolveAvailabilityCutoff(db,payload,now,timeZone,localScope){
  const local=payload.scope==='local';
  if(local!==localScope) return {suppressed:'SCOPE_CHANGED'};
  const cycle=resolvePairingCycle({now,timeZone,state:'upcoming'});
  const scope=local?{kind:'local'}:{kind:'circle',circleId:payload.circle_id};
  if(availabilityCycleKey(scope,cycle)!==payload.cycle_key) return {suppressed:'CUTOFF_PASSED'};
  const decision=`(SELECT decision.decision_source FROM pairing_cycle_availability decision
    WHERE decision.scope_key=? AND decision.cycle_key=? AND decision.user_id=account.id) AS decision_source`;
  const result=await db.execute(local?{
    sql:`SELECT ${RECIPIENT_COLUMNS},NULL AS circle_name,1 AS is_primary,${decision}
      FROM auth_accounts account
      LEFT JOIN user_notification_prefs preference ON preference.user_id=account.id
      WHERE account.id=? LIMIT 2`,
    args:['local',payload.cycle_key,payload.recipient_user_id],
  }:{
    sql:`SELECT ${RECIPIENT_COLUMNS},circle.name AS circle_name,circle.is_primary,${decision}
      FROM circle_memberships membership
      JOIN circles circle ON circle.id=membership.circle_id AND circle.archived_at IS NULL
      JOIN auth_accounts account ON account.id=membership.user_id
      LEFT JOIN user_notification_prefs preference ON preference.user_id=account.id
      WHERE membership.circle_id=? AND membership.user_id=? AND membership.status='active'
      LIMIT 2`,
    args:[`circle:${payload.circle_id}`,payload.cycle_key,payload.circle_id,payload.recipient_user_id],
  });
  const rows=result.rows;
  if(rows.length!==1) return {suppressed:'MEMBER_REMOVED'};
  const row=rows[0];
  if(Number(row.is_primary)!==1&&!multiCircleAvailabilityEnabled()){
    return {suppressed:'SECONDARY_AVAILABILITY_DISABLED'};
  }
  const problem=recipientProblem(row);
  if(problem) return {suppressed:problem};
  if(String(row.decision_source||'')==='user') return {suppressed:'DECISION_MADE'};
  return {row,cutoffAt:cycle.cutoffAt,primary:Number(row.is_primary)===1};
}

async function resolvePrimaryPair(db,payload,now,timeZone,localScope){
  const result=await db.execute({
    sql:`SELECT ${RECIPIENT_COLUMNS},week.week_label,schedule.agreed_time,pair.is_ai_pair,
        pair.user_a_id=pair.user_b_id AS is_solo,
        ${localScope?'1':activePrimaryMember('account.id')} AS recipient_active,
        ${pairMembersQualified(localScope)} AS members_qualified
      FROM pairing_groups pair
      JOIN pairing_weeks week ON week.id=pair.week_id AND COALESCE(week.is_demo,0)=0
      JOIN pairing_participants participant ON participant.week_id=pair.week_id
        AND participant.user_id=? AND participant.source='auth'
      JOIN auth_accounts account ON account.id=participant.user_id
      LEFT JOIN user_notification_prefs preference ON preference.user_id=account.id
      LEFT JOIN pair_schedules schedule ON schedule.week_id=pair.week_id AND schedule.pair_group_id=pair.id
      WHERE pair.id=? AND pair.week_id=? AND ? IN (pair.user_a_id,pair.user_b_id,pair.user_c_id)
      LIMIT 2`,
    args:[payload.recipient_user_id,payload.pair_group_id,payload.week_id,payload.recipient_user_id],
  });
  const rows=result.rows;
  if(rows.length!==1||Number(rows[0].recipient_active)!==1) return {suppressed:'MEMBER_REMOVED'};
  const row=rows[0];
  const problem=recipientProblem(row);
  if(problem) return {suppressed:problem};
  if(Number(row.is_ai_pair)===1||Number(row.is_solo)===1) return {suppressed:'PAIR_INVALID'};
  if(Number(row.members_qualified)!==1) return {suppressed:'PARTNER_REVOKED'};
  // Only the nudge is about this cycle's pairing. Schedules outlive the
  // boundary, so a session reminder relies on the agreed-time checks instead.
  if(payload.kind==='agree_time'
    &&String(row.week_label)!==resolvePairingCycle({now,timeZone,state:'current'}).cycleId){
    return {suppressed:'CYCLE_ENDED'};
  }
  return {row,link:`/join/${canonicalRoomId(payload.week_id,payload.pair_group_id)}`,circleName:null};
}

async function resolveSecondaryPair(db,payload,now){
  const instant=now.toISOString();
  const result=await db.execute({
    sql:`SELECT ${RECIPIENT_COLUMNS},circle.name AS circle_name,schedule.agreed_time,
        partner_membership.status AS partner_status,partner.is_demo AS partner_is_demo
      FROM circle_pairing_groups group_row
      JOIN circle_pairing_publications publication ON publication.id=group_row.publication_id
        AND publication.circle_id=group_row.circle_id
      JOIN circles circle ON circle.id=publication.circle_id AND circle.is_primary=0 AND circle.archived_at IS NULL
      JOIN circle_memberships membership ON membership.circle_id=circle.id AND membership.user_id=?
        AND membership.status='active'
      JOIN auth_accounts account ON account.id=membership.user_id
      LEFT JOIN circle_memberships partner_membership ON partner_membership.circle_id=circle.id
        AND partner_membership.user_id=CASE WHEN group_row.user_a_id=? THEN group_row.user_b_id ELSE group_row.user_a_id END
      LEFT JOIN auth_accounts partner ON partner.id=partner_membership.user_id
      LEFT JOIN user_notification_prefs preference ON preference.user_id=account.id
      LEFT JOIN circle_pair_schedules schedule ON schedule.publication_id=publication.id
        AND schedule.group_id=group_row.id
      WHERE group_row.id=? AND publication.id=? AND group_row.is_solo=0
        AND ? IN (group_row.user_a_id,group_row.user_b_id)
        AND publication.starts_at<=? AND publication.ends_at>?
      LIMIT 2`,
    args:[payload.recipient_user_id,payload.recipient_user_id,payload.group_id,payload.publication_id,
      payload.recipient_user_id,instant,instant],
  });
  const rows=result.rows;
  if(rows.length!==1) return {suppressed:'MEMBER_REMOVED'};
  const row=rows[0];
  const problem=recipientProblem(row);
  if(problem) return {suppressed:problem};
  if(row.partner_status!=='active'||Number(row.partner_is_demo)===1) return {suppressed:'PARTNER_REVOKED'};
  return {row,link:'/?view=dashboard',circleName:circleLabel(row.circle_name)};
}

async function resolvePair(db,payload,now,timeZone,localScope){
  if(payload.scope==='secondary'){
    if(!secondaryCircleSchedulingEnabled()) return {suppressed:'SECONDARY_SCHEDULING_DISABLED'};
    return resolveSecondaryPair(db,payload,now);
  }
  return resolvePrimaryPair(db,payload,now,timeZone,localScope);
}

export function formatReminderInstant(value,timeZone){
  let zone='UTC';
  if(typeof timeZone==='string'&&timeZone.trim()&&timeZone.length<=100){
    try{
      zone=new Intl.DateTimeFormat('en-GB',{timeZone:timeZone.trim()}).resolvedOptions().timeZone;
    }catch{ zone='UTC'; }
  }
  // Assemble from parts so the text does not depend on the ICU version's
  // punctuation for the `full` date style.
  const parts=Object.fromEntries(new Intl.DateTimeFormat('en-GB',{
    timeZone:zone,weekday:'long',day:'numeric',month:'long',year:'numeric',
    hour:'2-digit',minute:'2-digit',hourCycle:'h23',
  }).formatToParts(new Date(value)).filter(part=>part.type!=='literal').map(part=>[part.type,part.value]));
  return `${parts.weekday} ${parts.day} ${parts.month} ${parts.year}, ${parts.hour}:${parts.minute} (${zone})`;
}

const FOOTER='Reminders can arrive a few minutes late. You can turn off email reminders in your Randori profile.';

export function renderReminderEmail({kind,origin,link,circleName=null,instant=null,timeZone=null}){
  const href=escapeHtml(`${origin}${link}`);
  const prefix=circleName?`${circleName} — `:'';
  const circle=circleName?escapeHtml(circleName):null;
  const when=instant?escapeHtml(formatReminderInstant(instant,timeZone)):null;
  const footer=`<p style="color:#666;font-size:13px">${FOOTER}</p>`;
  if(kind==='availability_cutoff') return Object.freeze({
    subject:`${prefix}Are you in for the next Randori cycle?`,
    html:`<h2>Choose your availability${circle?` for ${circle}`:''}</h2>`
      +`<p>Pairing for the next cycle closes on <b>${when}</b>. You haven’t said whether you’re in or skipping yet.</p>`
      +`<p><a href="${href}">Choose on the Pairing page</a></p>${footer}`,
  });
  if(kind==='agree_time') return Object.freeze({
    subject:`${prefix}Agree a time with your Randori pair`,
    html:`<h2>No session time agreed yet${circle?` in ${circle}`:''}</h2>`
      +`<p>You were paired a few days ago and your pair hasn’t agreed a time. Propose a time or accept one.</p>`
      +`<p><a href="${href}">${circle?'Open the Randori dashboard':'Open your private pairing room'}</a></p>${footer}`,
  });
  return Object.freeze({
    subject:`${prefix}Your Randori session starts soon`,
    html:`<h2>Session starting soon${circle?` in ${circle}`:''}</h2>`
      +`<p>Your session starts at <b>${when}</b>.</p>`
      +`<p><a href="${href}">${circle?'Open the Randori dashboard':'Open your private pairing room'}</a></p>${footer}`,
  });
}

function providerError(error){
  const status=Number(error?.statusCode||error?.status||error?.response?.status||error?.error?.statusCode);
  const providerReason=emailProviderReason(error);
  if(status===429){
    const retryAfter=Number(error?.retryAfterMs||error?.retry_after_ms);
    return new OutboxDeliveryError('PROVIDER_RATE_LIMITED',{
      retryable:true,retryAfterMs:Number.isFinite(retryAfter)?retryAfter:null,cause:error,providerReason,
    });
  }
  if(status>=500&&status<=599) return new OutboxDeliveryError('PROVIDER_UNAVAILABLE',{retryable:true,cause:error,providerReason});
  if(status>=400&&status<=499) return new OutboxDeliveryError('PROVIDER_REJECTED',{retryable:false,cause:error,providerReason});
  if(error instanceof OutboxDeliveryError) return error;
  return new OutboxDeliveryError('PROVIDER_FAILED',{retryable:true,cause:error,providerReason});
}

export function createReminderEmailHandler({db,baseUrl,send,now=()=>new Date(),timeZone,localScope=false}={}){
  if(!db||typeof db.execute!=='function'||typeof send!=='function'){
    throw new TypeError('reminder email database and provider are required');
  }
  let origin;
  try{ origin=new URL(String(baseUrl)).origin; }
  catch{ throw new TypeError('valid reminder email base URL required'); }
  return async(event,{signal}={})=>{
    const payload=parseEvent(event);
    if(!remindersEnabled()) return suppressed('REMINDERS_DISABLED');
    if(payload.kind==='session_soon'&&!sessionSoonRemindersEnabled()) return suppressed('REMINDERS_DISABLED');
    const instantNow=readClock(now);
    let resolved;
    let content;
    if(payload.kind==='availability_cutoff'){
      resolved=await resolveAvailabilityCutoff(db,payload,instantNow,timeZone,localScope===true);
      if(resolved.suppressed) return suppressed(resolved.suppressed);
      const circleName=resolved.primary?null:circleLabel(resolved.row.circle_name);
      content=renderReminderEmail({kind:payload.kind,origin,link:'/?view=pair',circleName,
        instant:resolved.cutoffAt,timeZone:resolved.row.recipient_tz});
    }else{
      resolved=await resolvePair(db,payload,instantNow,timeZone,localScope===true);
      if(resolved.suppressed) return suppressed(resolved.suppressed);
      const agreed=resolved.row.agreed_time===null||resolved.row.agreed_time===undefined
        ?'':String(resolved.row.agreed_time);
      let instant=null;
      if(payload.kind==='agree_time'){
        if(agreed) return suppressed('TIME_AGREED');
      }else{
        instant=normalizeScheduleInstant(agreed);
        if(!instant||instant!==agreed) return suppressed('SESSION_CLEARED');
        if(reminderInstantFingerprint(instant)!==payload.instant_fingerprint) return suppressed('SESSION_CHANGED');
        const lead=Date.parse(instant)-instantNow.getTime();
        if(lead<=0) return suppressed('SESSION_ELAPSED');
        if(lead<SESSION_SOON_MIN_LEAD_MS) return suppressed('SESSION_IMMINENT');
      }
      content=renderReminderEmail({kind:payload.kind,origin,link:resolved.link,circleName:resolved.circleName,
        instant,timeZone:resolved.row.recipient_tz});
    }
    const email=String(resolved.row.recipient_email).trim().toLowerCase();
    try{
      const delivery=await send({to:email,subject:content.subject,html:content.html,kind:payload.kind,
        idempotencyKey:event.idempotencyKey,signal});
      if(delivery?.error) throw delivery.error;
      return {status:'delivered',providerName:String(delivery?.providerName||'email').slice(0,100),
        providerMessageId:delivery?.providerMessageId||delivery?.data?.id||null};
    }catch(error){ throw providerError(error); }
  };
}
