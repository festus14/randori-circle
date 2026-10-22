import { randomUUID, timingSafeEqual } from 'node:crypto';
import { getClient, getCronSecret, getAdminEmails, isoWeekLabel, deterministicColor, verifyMutationOrigin, verifyRequestAuth } from './_db.js';
import {
  AVAILABILITY_CACHE_CONTROL,
  availabilityFailure,
  availabilityResponse,
  getAvailabilityState,
  updateAvailability,
} from './_availability.js';
import { buildFairPairing, canonicalRoomId } from './_pairing.js';
import { pairingCronIsDue, resolvePairingCycle } from './_pairing-cycle.js';
import { publishPairingCycle } from './_pairing-publication.js';
import { PairingRecoveryError, parsePairingRecoveryRequest } from './_pairing-recovery.js';
import {
  circlePairingFailure,
  listSecondaryPairingScopes,
  publishCirclePairing,
  SECONDARY_PAIRING_CACHE_CONTROL,
} from './_circle-pairing.js';
import { purgeExpiredCodeDocuments } from './_code-document.js';
import { runAppLogRetention } from './_app-log-retention.js';
import { inviteRequestSchemaNotInstalled, runInviteRequestRetention } from './_invite-request-config.js';
import { INVITE_REQUEST_EVENT_TYPE } from './_invite-request-notification.js';
import {
  migrateLegacyPairingEmails,
  PAIRING_EMAIL_EVENT_TYPE,
  pairingEmailStatus,
} from './_pairing-email.js';
import {
  readOutboxMetrics,
  replayDeadLetter,
  runOutboxInvocation,
  settleBeforeDeadline,
} from './_outbox.js';
import { readOutboxDeliveryHealth } from './_outbox-health.js';
import { parseExecutionSmokeRequest, runExecutionSmoke } from './_execution-smoke.js';
import { handleAdminDiagnosticsRequest } from './_admin-diagnostics.js';
import {
  emailActivationKeyRotationStatus,
} from './_email-activation.js';
import {
  PASSWORD_RESET_EVENT_TYPE,
  passwordResetKeyRotationStatus,
} from './_password-reset.js';
import {
  SCHEDULE_EMAIL_EVENT_TYPE,
} from './_schedule-email.js';
import {
  invitationEmailKeyRotationStatus,
  INVITATION_EMAIL_EVENT_TYPE,
} from './_invitation-email.js';
import {identityEmailKeyRotationStatus} from './_identity-linking.js';
import { localRuntimeRequest, strictLocalPairingRuntime } from './_local-runtime.js';
import {
  enqueueDueReminders,
  REMINDER_EMAIL_EVENT_TYPE,
  reminderPreferenceDescriptor,
  remindersEnabled,
} from './_reminders.js';
import { configuredOutboxBaseUrl, OUTBOX_DELIVERY_TYPES, outboxDeliveryPlan } from './_outbox-delivery.js';
import {
  CIRCLE_HEALTH_CACHE_CONTROL,
  circleHealthEnabled,
  circleHealthQueryValid,
  readCircleHealth,
} from './_circle-health.js';
import {
  ensureDemoResetReadiness,
  ensureDemoSeedReadiness,
  ensureDemoShuffleReadiness,
  ensureNotificationPreferencesReadiness,
} from './_ops-readiness.js';
import { ensureCircleMembershipReadiness } from './_circle-membership.js';
import {
  canUseLegacySinglePrimaryCircleFeatures,
  multiCircleAvailabilityEnabled,
  multiCircleControlPlaneEnabled,
  requestMatchesCircleContext,
  resolveActiveCircleContext,
  secondaryCircleCoordinationEnabled,
  sendMultiCircleFeatureUnavailable,
} from './_active-circle.js';

export const OUTBOX_CRON_BUDGET_MS=45_000;
export const OUTBOX_CRON_FINALIZATION_RESERVE_MS=5_000;
export const OUTBOX_CRON_MAX_CLAIMS=8;
// Issue #287: the reminder due-check gets its own slice of the preparation
// window so a slow query can never hold back the delivery rounds.
export const OUTBOX_REMINDER_DUE_CHECK_BUDGET_MS=5_000;
// ID-72: app_logs retention runs after the delivery round with this budget.
export const OUTBOX_APP_LOG_RETENTION_BUDGET_MS=2_000;
const OUTBOX_CRON_MIN_DISPATCH_WINDOW_MS=100;

function codeDocumentSchemaNotInstalled(error){
  let current=error;
  for(let depth=0;current&&depth<5;depth+=1){
    if(/no such table:\s*(?:main\.)?pair_code_documents\b/i.test(String(current.message||''))) return true;
    current=current.cause;
  }
  return false;
}

async function logServerOps(level, event, message, meta, req){
  try{
    const db = getClient();
    let metaStr=null; try{ metaStr = meta ? JSON.stringify(meta).slice(0,8000) : null; }catch{ metaStr=String(meta).slice(0,2000); }
    const lvl=String(level||"info").toLowerCase();
    const ev=String(event).slice(0,80);
    const msg=String(message).slice(0,2000);
    const route = req && req.url ? String(req.url).slice(0,300) : null;
    const ua = req && req.headers ? (req.headers["user-agent"]||"").toString().slice(0,300) : null;
    const ip = req && req.headers ? (req.headers["x-forwarded-for"]||"").toString().split(",")[0].slice(0,80) : null;
    await db.execute({sql:"INSERT INTO app_logs (level, source, event, message, meta_json, route, ua, ip, created_at) VALUES (?,?,?,?,?,?,?, ?, datetime('now'))", args:[lvl, "server", ev, msg, metaStr, route, ua, ip]});
  }catch(e){ try{ console.warn("[logServerOps fail]", e && e.message); }catch{} }
}

async function handleNotificationPrefs(req,res){
  if(req.method!=="GET"&&req.method!=="POST"&&req.method!=="PUT"){
    return res.status(405).json({error:"GET or POST/PUT"});
  }
  const payload=await verifyRequestAuth(req);
  if(!payload) return res.status(401).json({error:"authentication required"});
  let db;
  try{
    db=getClient();
    await ensureNotificationPreferencesReadiness(db);
  }
  catch{ return res.status(503).json({error:"notification preferences unavailable"}); }
  if(req.method==="GET"){
    const uid=payload.id||payload.uid;
    try{
      const rs=await db.execute({sql:"SELECT user_id,email_enabled,sms_enabled,phone,email,updated_at FROM user_notification_prefs WHERE user_id=?", args:[uid]});
      // Issue #287: advertised only while REMINDERS_ENABLED is on, so the
      // response is unchanged when the feature is off.
      const reminders=reminderPreferenceDescriptor();
      const extra=reminders?{reminders}:{};
      if(rs.rows.length) return res.json({ok:true, prefs:rs.rows[0], ...extra});
      return res.json({ok:true, prefs:{user_id:uid,email_enabled:1,sms_enabled:0,phone:null}, ...extra});
    }catch(e){ return res.status(500).json({error:"fetch failed"}); }
  }
  if(req.method==="POST" || req.method==="PUT"){
    const uid=payload.id||payload.uid;
    const body=req.body||{};
    const email_enabled = body.email_enabled!=null ? (body.email_enabled?1:0) : 1;
    const sms_enabled = body.sms_enabled!=null ? (body.sms_enabled?1:0) : 0;
    const phone = body.phone ? String(body.phone).slice(0,20) : null;
    const email = body.email ? String(body.email).slice(0,120) : null;
    try{
      await db.execute({sql:"INSERT INTO user_notification_prefs (user_id,email_enabled,sms_enabled,phone,email,updated_at) VALUES (?,?,?,?,?,datetime('now')) ON CONFLICT(user_id) DO UPDATE SET email_enabled=excluded.email_enabled, sms_enabled=excluded.sms_enabled, phone=COALESCE(excluded.phone,phone), email=COALESCE(excluded.email,email), updated_at=datetime('now')", args:[uid,email_enabled,sms_enabled,phone,email]});
    }catch{
      try{ await db.execute({sql:"INSERT OR IGNORE INTO user_notification_prefs (user_id,email_enabled,sms_enabled,phone,email) VALUES (?,?,?,?,?)", args:[uid,email_enabled,sms_enabled,phone,email]}); }catch{}
      try{ await db.execute({sql:"UPDATE user_notification_prefs SET email_enabled=?, sms_enabled=?, phone=COALESCE(?,phone), email=COALESCE(?,email), updated_at=datetime('now') WHERE user_id=?", args:[email_enabled,sms_enabled,phone,email,uid]}); }catch{}
    }
    try{ await logServerOps("info","notif_prefs_updated","prefs uid "+uid+" email="+email_enabled+" sms="+sms_enabled, {uid,email_enabled,sms_enabled}, req); }catch{}
    return res.json({ok:true, prefs:{user_id:uid,email_enabled:!!email_enabled,sms_enabled:!!sms_enabled,phone,email}});
  }
}


// Issue #292: owner-only circle health (docs/CIRCLE_HEALTH.md). Read-only and
// aggregate; the route does not exist (404) unless CIRCLE_HEALTH_ENABLED is on.
async function handleCircleHealth(req,res){
  res.setHeader('Cache-Control',CIRCLE_HEALTH_CACHE_CONTROL);
  res.setHeader('Pragma','no-cache');
  if(!circleHealthEnabled()) return res.status(404).json({error:'not found'});
  if(req.method!=='GET'){
    res.setHeader('Allow','GET');
    return res.status(405).json({error:'GET only'});
  }
  if(!circleHealthQueryValid(req)) return res.status(400).json({error:'invalid request'});
  let db;
  let payload;
  try{
    db=getClient();
    await ensureCircleMembershipReadiness(db);
    payload=await verifyRequestAuth(req,db);
  }catch{ return res.status(503).json({error:'circle health unavailable'}); }
  const actor=Number(payload?.id??payload?.uid);
  if(!payload||!Number.isSafeInteger(actor)||actor<1) return res.status(401).json({error:'authentication required'});
  const multiCircle=multiCircleControlPlaneEnabled();
  try{
    let circleId=null;
    let contextVersion=null;
    if(multiCircle){
      const active=await resolveActiveCircleContext(db,payload);
      if(!active.ok){
        if(active.reason==='selection_required'){
          return res.status(409).json({error:'select an active circle',code:'active_circle_required'});
        }
        return res.status(403).json({error:'circle owner required'});
      }
      if(!active.implicit&&!requestMatchesCircleContext(req,active)){
        return res.status(409).json({error:'circle context changed',code:'circle_context_changed'});
      }
      if(active.membership.role!=='owner') return res.status(403).json({error:'circle owner required'});
      circleId=active.membership.id;
      contextVersion=Number(active.context_version)||0;
    }
    // The owner check is repeated inside every statement of the read batch,
    // so a demotion or archive between these steps still returns 403.
    const result=await readCircleHealth(db,{actorUserId:actor,circleId});
    if(!result.ok) return res.status(403).json({error:'circle owner required'});
    return res.json({ok:true,health:result.health,...(multiCircle?{circle_context_version:contextVersion}:{})});
  }catch(error){
    await logServerOps('error','circle_health_fail','circle health could not be read',
      {code:String(error?.code||error?.name||'Error').slice(0,64)},null);
    return res.status(503).json({error:'circle health unavailable'});
  }
}

function getEndpoint(req){
  const q = req.query?.endpoint;
  if (q) return String(q).toLowerCase();
  try{
    const u = new URL(req.url,'http://localhost');
    const ep = u.searchParams.get('endpoint');
    if (ep) return ep.toLowerCase();
    const path = u.pathname.split('/').filter(Boolean).pop();
    return (path||'').toLowerCase();
  }catch{ return (req.url||'').split('?')[0].split('/').filter(Boolean).pop()?.toLowerCase()||''; }
}
export const OUTBOX_DISPATCH_SECRET_MIN_LENGTH=32;

function secretMatches(secret,presented){
  if(typeof secret!=='string'||!secret) return false;
  const expectedBuf=Buffer.from(secret);
  const presentedBuf=Buffer.from(presented);
  return expectedBuf.length===presentedBuf.length && timingSafeEqual(expectedBuf,presentedBuf);
}

// Optional, narrowly-scoped credential for external outbox schedulers. It is
// ignored (fail closed for this secret only) unless it is long enough and
// distinct from CRON_SECRET, so it can never widen weekly/pairing authority.
export function outboxDispatchSecret(cronSecret){
  const secret=process.env.OUTBOX_DISPATCH_SECRET;
  if(typeof secret!=='string'||secret.length<OUTBOX_DISPATCH_SECRET_MIN_LENGTH) return null;
  return secret===cronSecret?null:secret;
}

function verifyCronAuth(req,{allowOutboxSecret=false}={}){
  let secret=null;
  try{ secret=getCronSecret(); }catch{}
  const raw = req.headers['x-cron-secret'] || req.headers['X-Cron-Secret'] || req.headers['authorization'] || req.headers['Authorization'] || '';
  const presented = typeof raw==='string' && raw.startsWith('Bearer ') ? raw.slice(7) : String(raw||'');
  if(!presented) return false;
  const cronMatch=secretMatches(secret,presented);
  const outboxMatch=allowOutboxSecret&&secretMatches(outboxDispatchSecret(secret),presented);
  return cronMatch||outboxMatch;
}

async function requirePairingPublisher(req,res){
  const payload=await verifyRequestAuth(req);
  if(!payload){ res.status(401).json({error:'authentication required'}); return null; }
  let db;
  try{ db=getClient(); }
  catch{ res.status(503).json({error:'pairing unavailable'}); return null; }
  const callerId=Number(payload.id||payload.uid);
  if(!Number.isSafeInteger(callerId)||callerId<1){
    res.status(401).json({error:'authentication required'});
    return null;
  }
  const localRuntime=strictLocalPairingRuntime(req);
  if(secondaryCircleCoordinationEnabled()&&!localRuntime){
    try{
      await ensureCircleMembershipReadiness(db);
      const active=await resolveActiveCircleContext(db,payload);
      if(!active.ok){
        if(active.reason==='selection_required'){
          res.status(409).json({ok:false,error:'select an active circle',code:'active_circle_required'});
        }else res.status(403).json({ok:false,error:'active circle membership required'});
        return null;
      }
      if(!active.implicit&&!requestMatchesCircleContext(req,active)){
        res.status(409).json({ok:false,error:'circle context changed',code:'circle_context_changed'});
        return null;
      }
      if(active.membership.role!=='owner'){
        res.status(403).json({ok:false,error:'circle owner required',circle_context_version:active.context_version});
        return null;
      }
      const circleId=Number(active.membership.id);
      const circleContext={
        payload,circleId,contextVersion:Number(active.context_version),implicit:active.implicit===true,
      };
      if(!active.membership.is_primary){
        return {
          db,callerId,localRuntime:false,localRequest:localRuntimeRequest(req),mode:'secondary',
          circlePublicId:String(active.membership.public_id),circleContextVersion:Number(active.context_version),
          authority:{kind:'session',...circleContext,userId:callerId,requireOwner:true},
        };
      }
      return {
        db,callerId,localRuntime:false,localRequest:false,mode:'primary',
        circlePublicId:String(active.membership.public_id),circleContextVersion:Number(active.context_version),
        circleContext,scope:{kind:'circle',scopeKey:`circle:${circleId}`,circleId},
      };
    }catch{
      res.status(503).json({ok:false,error:'pairing unavailable'});
      return null;
    }
  }
  let result;
  try{
    result=await db.execute(localRuntime?{
      sql:`SELECT id,is_admin FROM auth_accounts
        WHERE id=? AND COALESCE(is_demo,0)=0`,
      args:[callerId],
    }:{
      sql:`SELECT aa.id,cm.role,c.id AS circle_id
        FROM auth_accounts aa
        JOIN circle_memberships cm ON cm.user_id=aa.id
        JOIN circles c ON c.id=cm.circle_id
        WHERE aa.id=? AND cm.status='active' AND cm.role='owner'
          AND COALESCE(aa.is_demo,0)=0 AND c.is_primary=1 AND c.archived_at IS NULL
        LIMIT 2`,
      args:[callerId],
    });
    const rows=result.rows||[];
    const circleId=Number(rows[0]?.circle_id);
    const allowed=localRuntime
      ? rows.length===1&&Number(rows[0].id)===callerId&&Number(rows[0].is_admin)===1
      : rows.length===1&&Number(rows[0].id)===callerId&&String(rows[0].role)==='owner'
        &&Number.isSafeInteger(circleId)&&circleId>0;
    if(!allowed){ res.status(403).json({error:'primary circle owner required'}); return null; }
  }catch{
    res.status(503).json({error:'pairing unavailable'});
    return null;
  }
  const row=result.rows[0];
  const scope=localRuntime
    ?{kind:'local',scopeKey:'local',circleId:null}
    :{kind:'circle',scopeKey:`circle:${Number(row.circle_id)}`,circleId:Number(row.circle_id)};
  return {db,callerId,localRuntime,localRequest:localRuntimeRequest(req),scope,mode:'primary'};
}

async function loadPairingHistory(db,weekLabel,{includeDemo=false,includeCurrent=false,strict=false,authOnly=false,managedOnly=false}={}){
  try{
    const demoFilter=includeDemo?'':`AND COALESCE(pw.is_demo,0)=0`;
    const currentFilter=includeCurrent?'1=1':'pw.week_label<>?';
    const runJoin=managedOnly?'JOIN pairing_week_runs pwr ON pwr.week_id=pw.id AND pwr.week_label=pw.week_label':'';
    const participantJoins=authOnly?`
      JOIN pairing_participants ppa ON ppa.week_id=pg.week_id AND ppa.user_id=pg.user_a_id AND ppa.source='auth'
      JOIN pairing_participants ppb ON ppb.week_id=pg.week_id AND ppb.user_id=pg.user_b_id AND ppb.source='auth'
      LEFT JOIN pairing_participants ppc ON ppc.week_id=pg.week_id AND ppc.user_id=pg.user_c_id AND ppc.source='auth'`:'';
    const participantFilter=authOnly?'AND (pg.user_c_id IS NULL OR ppc.user_id IS NOT NULL)':'';
    const rs=await db.execute({sql:`SELECT pg.user_a_id,pg.user_b_id,pg.is_ai_pair,pw.id AS week_id,pw.week_label
      FROM pairing_groups pg
      JOIN pairing_weeks pw ON pw.id=pg.week_id
      ${runJoin}
      ${participantJoins}
      WHERE ${currentFilter} ${demoFilter} ${participantFilter}
      ORDER BY pw.week_start DESC,pw.id DESC,pg.id ASC LIMIT 1000`,args:includeCurrent?[]:[weekLabel]});
    return rs.rows;
  }catch(error){
    if(strict) throw error;
    return [];
  }
}

function pairingMetadata(pairing){
  return {
    version:pairing.algorithmVersion,
    seed:pairing.seed,
    generation:pairing.generation,
    attempts:pairing.attempts,
    previous_week_repeats:pairing.score.previousWeekRepeats,
    historical_repeats:pairing.score.historicalRepeats,
    prior_ai_assignments:pairing.score.aiHistory,
  };
}

/** Persist the week, participant snapshot, and every pair in one write transaction. */
async function persistPairingWeek(db, {weekLabel, weekStart, participants, pairing, isDemoWeek=0, generation=1}){
  const generationToken=randomUUID();
  const participantSnapshot=JSON.stringify(participants.map(p=>({user_id:Number(p.id),source:p.source||'auth'})));
  const runArgs=[weekLabel,generationToken,generation,pairing.algorithmVersion,pairing.seed,participants.length,participantSnapshot];
  const statements=[];

  statements.push({sql:`INSERT INTO pairing_week_runs (week_label,generation_token,generation,algorithm_version,algorithm_seed,participant_count,participants_json) VALUES (?,?,?,?,?,?,?) ON CONFLICT(week_label) DO NOTHING`,args:runArgs});

  statements.push({sql:`INSERT INTO pairing_weeks (week_label,week_start,focus,is_demo) SELECT ?,?,'both',? WHERE EXISTS (SELECT 1 FROM pairing_week_runs WHERE week_label=? AND generation_token=?) AND NOT EXISTS (SELECT 1 FROM pairing_weeks WHERE week_label=?)`,args:[weekLabel,weekStart,isDemoWeek,weekLabel,generationToken,weekLabel]});
  statements.push({sql:`UPDATE pairing_week_runs SET week_id=(SELECT MIN(id) FROM pairing_weeks WHERE week_label=?),updated_at=datetime('now') WHERE week_label=? AND generation_token=?`,args:[weekLabel,weekLabel,generationToken]});

  participants.forEach((participant,index)=>{
    statements.push({sql:`INSERT INTO pairing_participants (week_id,user_id,position,source) SELECT week_id,?,?,? FROM pairing_week_runs WHERE week_label=? AND generation_token=?`,args:[Number(participant.id),index,participant.source||'auth',weekLabel,generationToken]});
  });
  pairing.pairs.forEach(pair=>{
    statements.push({sql:`INSERT INTO pairing_groups (week_id,user_a_id,user_b_id,is_ai_pair,topic,topic_kind) SELECT week_id,?,?,?,?,'both' FROM pairing_week_runs WHERE week_label=? AND generation_token=?`,args:[Number(pair.a.id),Number(pair.b?.id||pair.a.id),pair.isAI?1:0,'Pick together',weekLabel,generationToken]});
  });
  await db.batch(statements,'write');
  const runRs=await db.execute({sql:`SELECT week_id,generation_token,generation FROM pairing_week_runs WHERE week_label=?`,args:[weekLabel]});
  const run=runRs.rows[0];
  if(!run || run.generation_token!==generationToken) return {created:false,weekId:run?.week_id||null,generation:run?.generation||null,pairs:[]};
  const groups=await db.execute({sql:`SELECT id,user_a_id,user_b_id,is_ai_pair FROM pairing_groups WHERE week_id=? ORDER BY id`,args:[run.week_id]});
  const queues=new Map();
  for(const group of groups.rows){
    const key=`${group.user_a_id}:${group.user_b_id}:${group.is_ai_pair?1:0}`;
    if(!queues.has(key)) queues.set(key,[]);
    queues.get(key).push(group);
  }
  const pairs=pairing.pairs.map(pair=>{
    const key=`${pair.a.id}:${pair.b?.id||pair.a.id}:${pair.isAI?1:0}`;
    const group=queues.get(key)?.shift();
    return {...pair,groupId:group?.id||null};
  });
  return {created:true,weekId:run.week_id,generation:Number(run.generation),pairs};
}


function emptyOutboxResult(){
  return {claimed:0,delivered:0,suppressed:0,retried:0,deadLettered:0,leaseLost:0};
}

function emptyOutboxInvocation(eventTypes,{deadlineReached=false,maxClaims=OUTBOX_CRON_MAX_CLAIMS}={}){
  return Object.freeze({...emptyOutboxResult(),deadlineReached,
    maxClaims,perType:Object.freeze(Object.fromEntries(
      eventTypes.map(type=>[type,Object.freeze(emptyOutboxResult())]),
    ))});
}

function outboxStatuses(metrics){
  const byType=new Map(OUTBOX_DELIVERY_TYPES.map(({type})=>[type,{
    pending:0,processing:0,retry:0,delivered:0,suppressed:0,dead_letter:0,
  }]));
  for(const metric of metrics||[]){
    const target=byType.get(String(metric.eventType||''));
    const status=String(metric.status||'');
    if(target&&Object.prototype.hasOwnProperty.call(target,status)){
      target[status]+=Number(metric.count||0);
    }
  }
  return byType;
}

async function safeKeyRotationStatus(read){
  try{ return await read(); }
  catch{ return Object.freeze({ready:false,unavailable:true}); }
}

async function outboxKeyRotationStatuses(db,{local=false}={}){
  const [activation,passwordReset,invitation,identity]=await Promise.all([
    safeKeyRotationStatus(()=>emailActivationKeyRotationStatus(db)),
    safeKeyRotationStatus(()=>passwordResetKeyRotationStatus(db)),
    safeKeyRotationStatus(()=>invitationEmailKeyRotationStatus(db,{localRuntime:local})),
    safeKeyRotationStatus(()=>identityEmailKeyRotationStatus(db)),
  ]);
  return Object.freeze({activation,password_reset:passwordReset,invitation,identity});
}

function unavailableDeliverySummary(type,status){
  const pending=status.pending+status.retry+status.processing;
  if(type===PAIRING_EMAIL_EVENT_TYPE){
    return `${pending} email reminder(s) pending — email delivery unavailable`;
  }
  if(type===SCHEDULE_EMAIL_EVENT_TYPE) return 'schedule email delivery unavailable';
  if(type===INVITATION_EMAIL_EVENT_TYPE) return 'invitation email delivery unavailable';
  if(type===PASSWORD_RESET_EVENT_TYPE) return 'password reset email delivery unavailable';
  if(type===INVITE_REQUEST_EVENT_TYPE) return 'invite request notification delivery unavailable';
  if(type===REMINDER_EMAIL_EVENT_TYPE) return 'reminder email delivery unavailable';
  return 'activation email delivery unavailable';
}

function projectOutboxDelivery({descriptor,result,status,configured,local,captured}){
  const failed=result.retried+result.deadLettered;
  if(!status){
    return {summary:'outbox backlog was not read before the invocation deadline',
      sent:local?0:result.delivered,failed,exhausted:0,pending:0,suppressed:result.suppressed,
      ...(local&&configured?{captured}:{}),};
  }
  const pending=status.pending+status.retry+status.processing;
  const summary=!configured?unavailableDeliverySummary(descriptor.type,status)
    :local?`captured ${captured.length} ${descriptor.label}(s), failed ${failed}; no external delivery`
      :`sent ${result.delivered}, failed ${failed}, exhausted ${status.dead_letter}, suppressed ${result.suppressed}, pending ${pending}`;
  return {summary,sent:local?0:result.delivered,failed,exhausted:status.dead_letter,pending,
    suppressed:result.suppressed,...(local&&configured?{captured}:{}),};
}

export async function runReminderDueCheck(db,req,deadlineAtMs){
  let dueCheck;
  try{
    dueCheck=await settleBeforeDeadline(()=>enqueueDueReminders(db,{localScope:strictLocalPairingRuntime(req)}),
      deadlineAtMs);
  }catch{
    return {enqueued:null,errors:{due_check:'DUE_CHECK_FAILED'}};
  }
  if(!dueCheck.completed) return {enqueued:null,errors:{due_check:'DUE_CHECK_TIMEOUT'}};
  const {availability_cutoff:availabilityCutoff,agree_time:agreeTime,session_soon:sessionSoon,errors}=dueCheck.value;
  return {enqueued:{availability_cutoff:availabilityCutoff,agree_time:agreeTime,session_soon:sessionSoon},
    errors:{...errors}};
}

export async function deliverPendingOutbox(db,baseUrl,req,deadlineAtMs,{
  maxClaims=OUTBOX_CRON_MAX_CLAIMS,
  finalizationReserveMs=OUTBOX_CRON_FINALIZATION_RESERVE_MS,
  minimumDispatchWindowMs=OUTBOX_CRON_MIN_DISPATCH_WINDOW_MS,
  reminderDueCheckBudgetMs=OUTBOX_REMINDER_DUE_CHECK_BUDGET_MS,
  appLogRetentionBudgetMs=OUTBOX_APP_LOG_RETENTION_BUDGET_MS,
}={}){
  const preparationDeadline=deadlineAtMs-finalizationReserveMs-minimumDispatchWindowMs;
  // Issue #287: the reminder due-check runs inside the timeboxed preparation so
  // a newly due reminder can be claimed in this invocation. It makes no
  // database access while REMINDERS_ENABLED is off. Each kind reports its own
  // bounded error code; a failure or timeout is logged at warn level and never
  // blocks delivery of other mail.
  // Nothing is queued when no reminder handler can deliver (no provider and no
  // local capture), so intents never pile up undeliverable.
  let reminders={enqueued:null,errors:{}};
  const preparation=await settleBeforeDeadline(async()=>{
    await migrateLegacyPairingEmails(db,{limit:maxClaims});
    const deliveryPlan=await outboxDeliveryPlan(db,baseUrl,req);
    if(remindersEnabled()){
      reminders=deliveryPlan.handlers.has(REMINDER_EMAIL_EVENT_TYPE)
        ?await runReminderDueCheck(db,req,Math.min(preparationDeadline,performance.now()+reminderDueCheckBudgetMs))
        :{enqueued:null,errors:{due_check:'NO_DELIVERY_HANDLER'}};
    }
    return deliveryPlan;
  },preparationDeadline);
  const plan=preparation.completed?preparation.value:{
    local:false,captured:new Map(OUTBOX_DELIVERY_TYPES.map(({type})=>[type,[]])),handlers:new Map(),
  };
  const eventTypes=OUTBOX_DELIVERY_TYPES.map(({type})=>type).filter(type=>plan.handlers.has(type));
  const invocation=preparation.completed&&eventTypes.length?await runOutboxInvocation({
    db,workerId:`outbox-${randomUUID()}`,handlers:plan.handlers,eventTypes,
    maxClaims,deadlineAtMs,finalizationReserveMs,minimumDispatchWindowMs,
  }):emptyOutboxInvocation(eventTypes,{deadlineReached:!preparation.completed,maxClaims});
  // ID-72: app_logs retention (throttled to once an hour inside the module)
  // starts only after delivery, so it can never delay mail, and only when its
  // whole budget still fits before the finalization reserve. A slow or failed
  // purge is reported and retried by a later invocation.
  let appLogRetention=null;
  const retentionDeadline=performance.now()+appLogRetentionBudgetMs;
  if(preparation.completed&&!invocation.deadlineReached
    &&retentionDeadline<=deadlineAtMs-finalizationReserveMs){
    appLogRetention=await settleBeforeDeadline(()=>runAppLogRetention(db),retentionDeadline).then(
      settled=>settled.completed?settled.value:{ran:false,timed_out:true},
      ()=>({ran:false,failed:true}),
    );
  }
  const metricRead=preparation.completed&&!invocation.deadlineReached
    ?await settleBeforeDeadline(async()=>({outbox:await readOutboxMetrics(db),
      keyRotation:await outboxKeyRotationStatuses(db,{local:plan.local})}),deadlineAtMs)
    :{completed:false,value:null};
  const statuses=metricRead.completed?outboxStatuses(metricRead.value.outbox):null;
  const deliveries={};
  const types={};
  for(const descriptor of OUTBOX_DELIVERY_TYPES){
    const result=invocation.perType[descriptor.type]||emptyOutboxResult();
    const status=statuses?.get(descriptor.type)||null;
    const configured=plan.handlers.has(descriptor.type);
    deliveries[descriptor.key]=projectOutboxDelivery({descriptor,result,status,configured,
      local:plan.local,captured:plan.captured.get(descriptor.type)});
    types[descriptor.type]={claimed:result.claimed,delivered:result.delivered,
      suppressed:result.suppressed,retried:result.retried,dead_lettered:result.deadLettered,
      lease_lost:result.leaseLost,
      backlog:status?status.pending+status.retry+status.processing:null,
      dead_letter:status?status.dead_letter:null};
  }
  const deadlineReached=invocation.deadlineReached||!preparation.completed||!metricRead.completed
    ||performance.now()>=deadlineAtMs;
  const metrics={budget_ms:OUTBOX_CRON_BUDGET_MS,max_claims:maxClaims,
    deadline_reached:deadlineReached,metrics_complete:metricRead.completed,
    legacy_reconciliation_complete:preparation.completed,logging_complete:false,
    claimed:invocation.claimed,types,key_rotation:metricRead.completed?metricRead.value.keyRotation:null,
    app_logs_retention:appLogRetention,
    ...(remindersEnabled()?{reminders_enqueued:reminders.enqueued,reminder_errors:reminders.errors}:{})};
  const reminderFailed=Object.keys(reminders.errors).length>0;
  if(!metrics.deadline_reached&&performance.now()<deadlineAtMs){
    const logged=await settleBeforeDeadline(()=>logServerOps(
      invocation.retried||invocation.deadLettered||invocation.leaseLost||reminderFailed?'warn':'success',
      'outbox_invocation','outbox invocation completed',metrics,null,
    ),deadlineAtMs);
    metrics.logging_complete=logged.completed;
    if(!logged.completed) metrics.deadline_reached=true;
  }
  return {deliveries,metrics};
}

async function handleOutboxWorker(req,res){
  const deadlineAtMs=performance.now()+OUTBOX_CRON_BUDGET_MS;
  if(req.method!=='GET'&&req.method!=='POST') return res.status(405).json({error:'GET or POST'});
  if(!verifyCronAuth(req,{allowOutboxSecret:true})) return res.status(401).json({error:'unauthorized cron'});
  const baseUrl=configuredOutboxBaseUrl();
  if(!baseUrl) return res.status(503).json({error:'outbox unavailable'});
  let db;
  try{ db=getClient(); }
  catch{ return res.status(503).json({error:'outbox unavailable'}); }
  try{
    const outbox=await deliverPendingOutbox(db,baseUrl,req,deadlineAtMs);
    return res.json({ok:true,...Object.fromEntries(Object.entries(outbox.deliveries)
      .map(([key,value])=>[key,safeEmailDelivery(value)])),outbox:outbox.metrics});
  }catch{
    return res.status(503).json({error:'outbox unavailable'});
  }
}

async function handleOutboxHealth(req,res){
  res.setHeader('Cache-Control','no-store');
  if(req.method!=='GET') return res.status(405).json({error:'GET only'});
  if(!verifyCronAuth(req,{allowOutboxSecret:true})) return res.status(401).json({error:'unauthorized cron'});
  try{ return res.json(await readOutboxDeliveryHealth(getClient())); }
  catch{ return res.status(503).json({ok:false,error:'outbox health unavailable'}); }
}

// Issue #249: live check of the configured execution provider. CRON_SECRET
// only (it spends sandbox quota), POST only, exactly {"trigger":"schedule"|
// "deploy"}, self-throttled per trigger, bounded output.
async function handleExecutionSmoke(req,res){
  res.setHeader('Cache-Control','no-store');
  if(req.method!=='POST') return res.status(405).json({error:'POST only'});
  if(!verifyCronAuth(req)) return res.status(401).json({error:'unauthorized cron'});
  const outcome=await runExecutionSmoke({trigger:parseExecutionSmokeRequest(req.body),getDb:getClient});
  return res.status(outcome.status).json(outcome.body);
}

async function handleOutboxReplay(req,res){
  if(req.method!=='POST') return res.status(405).json({error:'POST only'});
  const context=await requireOutboxOperator(req,res);
  if(!context) return;
  const body=req.body;
  if(!body||typeof body!=='object'||Array.isArray(body)
    ||Object.keys(body).some(key=>!['event_id','reason_code','not_before'].includes(key))){
    return res.status(400).json({error:'invalid replay request'});
  }
  try{
    const replayed=await replayDeadLetter(context.db,{
      eventId:body.event_id,operatorUserId:context.callerId,
      reasonCode:body.reason_code,notBefore:body.not_before||null,
    });
    if(!replayed) return res.status(409).json({error:'event is not replayable'});
    return res.json({ok:true,replayed:true});
  }catch(error){
    if(error instanceof TypeError) return res.status(400).json({error:'invalid replay request'});
    return res.status(503).json({error:'outbox unavailable'});
  }
}

async function requireOutboxOperator(req,res){
  const payload=await verifyRequestAuth(req);
  if(!payload){ res.status(401).json({error:'authentication required'}); return null; }
  let db;
  try{ db=getClient(); }
  catch{ res.status(503).json({error:'outbox unavailable'}); return null; }
  const callerId=Number(payload.id||payload.uid);
  if(!Number.isSafeInteger(callerId)||callerId<1){
    res.status(401).json({error:'authentication required'});
    return null;
  }
  try{
    const result=await db.execute({
      sql:`SELECT id,is_admin,is_demo FROM auth_accounts WHERE id=? LIMIT 2`,args:[callerId],
    });
    const rows=result.rows||[];
    if(rows.length!==1||Number(rows[0].id)!==callerId
      ||Number(rows[0].is_admin)!==1||Number(rows[0].is_demo)===1){
      res.status(403).json({error:'outbox operator required'});
      return null;
    }
    return {db,callerId};
  }catch{
    res.status(503).json({error:'outbox unavailable'});
    return null;
  }
}

async function getCallerAdmin(db, payload){
  let callerEmail = '';
  const callerId = payload.id||payload.uid;
  let callerIsAdminFlag=false, callerDbRow=null;
  if (callerId){
    const cr=await db.execute({ sql:`SELECT id,email,is_admin FROM auth_accounts WHERE id=?`, args:[callerId]});
    if(cr.rows.length){
      callerDbRow=cr.rows[0];
      callerEmail=String(cr.rows[0].email||'').toLowerCase().trim();
      callerIsAdminFlag=!!cr.rows[0].is_admin;
    }
  }
  const callerConfiguredAdmin=!!callerDbRow&&getAdminEmails().has(callerEmail);
  const callerIsAdmin=!!callerDbRow&&(callerIsAdminFlag||callerConfiguredAdmin);
  return {callerEmail, callerId, callerIsAdminFlag, callerConfiguredAdmin, callerDbRow, callerIsAdmin};
}

async function requireAdmin(req,res){
  let payload;
  try{ payload=await verifyRequestAuth(req); }
  catch{ res.status(503).json({error:'admin operation unavailable'}); return null; }
  if (!payload) { res.status(401).json({ error:'authentication required' }); return null; }
  let db,ctx;
  try{
    db=getClient();
    ctx=await getCallerAdmin(db,payload);
  }catch{
    res.status(503).json({error:'admin operation unavailable'});
    return null;
  }
  if (!ctx.callerIsAdmin){ res.status(403).json({ error:'forbidden: admin only' }); return null; }
  return {db, payload, ...ctx};
}

async function prepareAdminOperation(ctx,res,ensureReadiness){
  try{
    await ensureReadiness(ctx.db);
    if(ctx.callerConfiguredAdmin&&!ctx.callerIsAdminFlag){
      await ctx.db.execute({sql:`UPDATE auth_accounts SET is_admin=1 WHERE id=?`,args:[ctx.callerDbRow.id]});
      ctx.callerIsAdminFlag=true;
    }
    return ctx;
  }catch{
    res.status(503).json({error:'admin operation unavailable'});
    return null;
  }
}

async function handleAvailability(req,res){
  res.setHeader('Cache-Control',AVAILABILITY_CACHE_CONTROL);
  if(req.method!=='GET'&&req.method!=='POST'){
    res.setHeader('Allow','GET, POST');
    return res.status(405).json({ok:false,error:'GET or POST required'});
  }
  let payload;
  try{ payload=await verifyRequestAuth(req); }
  catch{ return res.status(503).json({ok:false,error:'availability unavailable'}); }
  if(!payload) return res.status(401).json({ok:false,error:'authentication required'});
  const userId=Number(payload.id||payload.uid);
  if(!Number.isSafeInteger(userId)||userId<1){
    return res.status(401).json({ok:false,error:'authentication required'});
  }
  let db;
  try{ db=getClient(); }
  catch{ return res.status(503).json({ok:false,error:'availability unavailable'}); }
  const localRuntime=strictLocalPairingRuntime(req);
  let circleContext=null;
  let circleContextVersion;
  try{
    if(multiCircleAvailabilityEnabled()&&!localRuntime){
      await ensureCircleMembershipReadiness(db);
      const active=await resolveActiveCircleContext(db,payload);
      if(!active.ok){
        if(active.reason==='selection_required'){
          return res.status(409).json({ok:false,error:'select an active circle',code:'active_circle_required'});
        }
        return res.status(403).json({ok:false,error:'active circle membership required'});
      }
      if(!active.implicit&&!requestMatchesCircleContext(req,active)){
        return res.status(409).json({ok:false,error:'circle context changed',code:'circle_context_changed'});
      }
      const circleId=Number(active.membership?.id??active.membership?.circle_id);
      circleContextVersion=Number(active.context_version);
      circleContext={payload,circleId,contextVersion:circleContextVersion,implicit:active.implicit===true};
    }
    const options={userId,localRuntime,...(circleContext?{circleContext}:{})};
    const state=req.method==='GET'
      ?await getAvailabilityState(db,options)
      :await updateAvailability(db,{...options,body:req.body});
    return res.json(availabilityResponse(state,{circleContextVersion}));
  }catch(error){
    const failure=availabilityFailure(error,{circleContextVersion});
    return res.status(failure.status).json(failure.body);
  }
}

// The legacy email-based promote action granted app admin with no recent-auth
// proof and no audit row. It is retired: role changes go through
// PATCH /api/members (owner/admin grant and revoke actions) which require a
// recent-auth proof and write circle_audit_events. The response is a fixed 410
// that opens no database connection, so the retired path cannot change roles.
export const LEGACY_PROMOTE_RETIRED={
  ok:false,
  error:'legacy promote action retired',
  code:'legacy_promote_retired',
  replacement:{
    method:'PATCH',
    path:'/api/members',
    actions:['grant_admin','revoke_admin','make_owner','remove_owner'],
    note:'Requires a recent-auth proof and writes circle_audit_events.',
  },
};

async function handleReshuffle(req,res){
  if (req.method!=='POST') return res.status(405).json({ error:'POST only for reshuffle' });
  const body = req.body||{};
  const queryAction=req.query?.action;
  const action=(body.action||queryAction||'').toString().toLowerCase();
  // The old reshuffle URL is a compatibility alias for the immutable
  // current-cycle publication. There is deliberately no force/remix operation
  // for a published cycle.
  if(action==='promote') return res.status(410).json(LEGACY_PROMOTE_RETIRED);
  return handlePairingRun(req,res);
}

function safeEmailDelivery(value){
  const delivery=value&&typeof value==='object'?value:{};
  const result={
    summary:String(delivery.summary||'email delivery unavailable').slice(0,180),
    sent:Number(delivery.sent||0),
    failed:Number(delivery.failed||0),
    exhausted:Number(delivery.exhausted||0),
    pending:Number(delivery.pending||0),
    suppressed:Number(delivery.suppressed||0),
  };
  if(Array.isArray(delivery.captured)){
    result.captured=delivery.captured.slice(0,100).map(item=>({
      recipient_email:String(item?.recipient_email||'').slice(0,254),
      kind:String(item?.kind||'').slice(0,32),
      subject:String(item?.subject||'').slice(0,200),
      links:Array.isArray(item?.links)?item.links.slice(0,4).map(link=>String(link).slice(0,2048)):[],
    }));
  }
  return result;
}

function pairingPublicationPayload(result,emailDelivery){
  const publication=result.publication;
  const soloCount=publication.pairs.filter(pair=>pair.isAI).length;
  return {
    ok:true,
    created:result.created,
    skipped:!result.created,
    cycle:publication.cycle,
    week_label:publication.cycle.cycleId,
    week_id:publication.weekId,
    generation:publication.generation,
    count:publication.participantCount,
    participant_count:publication.participantCount,
    available_count:publication.participantCount,
    pair_count:publication.pairs.length,
    solo_count:soloCount,
    algorithm_version:publication.algorithm.version,
    publication_state:result.publicationState,
    email_delivery:safeEmailDelivery(emailDelivery),
    message:result.created
      ?'Current-cycle pairings published. Solo members receive a Solo practice room.'
      :'Current-cycle pairings were already published; no pairs were changed.',
  };
}

function pairingFailure(res,error,context={}){
  const pairingContext={
    ...(context.circlePublicId?{circle_public_id:context.circlePublicId}:{}),
    ...(context.circleContextVersion===undefined
      ?{}:{circle_context_version:context.circleContextVersion}),
  };
  if(error?.code==='PAIRING_CONTEXT_CHANGED'){
    return res.status(409).json({ok:false,error:'circle context changed',code:'circle_context_changed'});
  }
  if(error?.code==='PAIRING_PUBLISHER_REVOKED'){
    return res.status(403).json({error:'primary circle owner required'});
  }
  if(error?.code==='PAIRING_PUBLICATION_NO_PARTICIPANTS'){
    return res.status(400).json({error:'At least one available member is required. A single member receives Solo practice.'});
  }
  if(error?.code==='PAIRING_PUBLICATION_LEGACY_CONFLICT'){
    return res.status(409).json({error:'The current cycle cannot be published because legacy pairing data already exists.'});
  }
  if(error?.code==='PAIRING_RECOVERY_CYCLE_CHANGED'){
    return res.status(409).json({
      ok:false,error:'pairing cycle changed',code:'pairing_cycle_changed',
      publication_state:error.publicationState,...pairingContext,
    });
  }
  if(error?.code==='PAIRING_RECOVERY_NOT_READY'){
    return res.status(409).json({
      ok:false,error:'pairing recovery is not ready',code:'pairing_recovery_not_ready',
      publication_state:error.publicationState,...pairingContext,
    });
  }
  return res.status(503).json({error:'pairing unavailable'});
}

async function currentPairingResult(req,{
  db,localRuntime,localRequest=false,callerId=null,scope:authorizedScope=null,
  useApplicationClock=localRequest,circleContext=null,circlePublicId=null,circleContextVersion,
  expectedCycleKey,
}){
  const result=await publishPairingCycle(db,{
    localRuntime,callerId,authorizedScope,
    circleContext,
    ...(expectedCycleKey===undefined?{}:{expectedCycleKey}),
    appUrl:process.env.APP_URL,
    // Loopback transport is independent from publication scope. Invite-bound
    // local identity still uses audited circle membership and v3 readiness.
    allowLocalAppUrl:localRequest,
    // The isolated local runtime shares the application clock with its read
    // models; production remains pinned to the database-owned timestamp.
    ...(useApplicationClock?{now:new Date()}:{}),
  });
  let emailDelivery={summary:'pairing emails queued for outbox delivery'};
  try{
    const status=await pairingEmailStatus(db);
    emailDelivery={summary:`${status.pending+status.retry+status.processing} pairing email(s) queued for outbox delivery; exhausted ${status.dead_letter}, suppressed ${status.suppressed}`,
      sent:0,failed:0,exhausted:status.dead_letter,
      pending:status.pending+status.retry+status.processing,suppressed:status.suppressed};
  }catch{}
  return {
    ...pairingPublicationPayload(result,emailDelivery),
    ...(circlePublicId?{circle_public_id:circlePublicId}:{}),
    ...(circleContextVersion===undefined?{}:{circle_context_version:circleContextVersion}),
  };
}

async function logPairingRecovery(event,resultOrError){
  const success=resultOrError?.ok===true;
  const meta=success?{
    created:resultOrError.created===true,
    existing:resultOrError.skipped===true,
    participant_count:Number(resultOrError.participant_count||0),
    pair_count:Number(resultOrError.pair_count||0),
    solo_count:Number(resultOrError.solo_count||0),
    publication_state:String(resultOrError.publication_state?.state||'unknown'),
  }:{code:String(resultOrError?.code||'pairing_unavailable').slice(0,80)};
  await logServerOps(success?'info':'warn',event,
    success?'owner pairing recovery completed':'owner pairing recovery did not complete',meta,null);
}

async function runCurrentPairing(req,res,context){
  try{
    const result=await currentPairingResult(req,context);
    if(context.expectedCycleKey!==undefined){
      try{ await logPairingRecovery('pairing_recovery_completed',result); }catch{}
    }
    return res.json(result);
  }
  catch(error){
    if(context.expectedCycleKey!==undefined){
      try{ await logPairingRecovery('pairing_recovery_rejected',error); }catch{}
    }
    return pairingFailure(res,error,context);
  }
}

async function handlePairingRun(req,res){
  if(req.method!=='POST') return res.status(405).json({error:'POST only'});
  const context=await requirePairingPublisher(req,res);
  if(!context) return;
  let recovery;
  try{ recovery=parsePairingRecoveryRequest(req.body); }
  catch(error){
    if(error instanceof PairingRecoveryError){
      return res.status(400).json({ok:false,error:error.message,code:'pairing_recovery_input_invalid'});
    }
    return res.status(400).json({ok:false,error:'invalid pairing recovery request'});
  }
  if(context.circlePublicId) res.setHeader('Cache-Control',SECONDARY_PAIRING_CACHE_CONTROL);
  if(context.mode==='secondary'){
    try{
      const result=await publishCirclePairing(context.db,{
        authority:context.authority,expectedCycleKey:recovery.expectedCycleKey,
        ...(context.localRequest?{now:new Date()}:{}),
      });
      const publication=result.publication;
      const response={
        ok:true,created:result.created,skipped:!result.created,coordination_only:true,
        workspace_available:false,circle_public_id:context.circlePublicId,
        circle_context_version:context.circleContextVersion,cycle:publication.cycle,
        week_label:publication.cycle.cycleId,count:publication.participantCount,
        participant_count:publication.participantCount,
        available_count:publication.eligibility.filter(item=>item.isAvailable).length,
        pair_count:publication.groups.length,
        solo_count:publication.groups.filter(group=>group.isSolo).length,
        algorithm_version:publication.algorithm.version,
        publication_state:result.publicationState,
        message:result.created
          ?'Current-cycle pairing published. Workspace tools are not enabled for this circle.'
          :'Current-cycle pairing was already published; no pairs were changed.',
      };
      try{ await logPairingRecovery('pairing_recovery_completed',response); }catch{}
      return res.json(response);
    }catch(error){
      try{ await logPairingRecovery('pairing_recovery_rejected',error); }catch{}
      const failure=circlePairingFailure(error,{
        contextVersion:context.circleContextVersion,circlePublicId:context.circlePublicId,
      });
      return res.status(failure.status).json(failure.body);
    }
  }
  return runCurrentPairing(req,res,{...context,expectedCycleKey:recovery.expectedCycleKey});
}

async function handleWeekly(req,res,{isDue=pairingCronIsDue}={}){
  // Vercel Cron invokes configured paths with GET; authentication below is mandatory.
  if (req.method!=='GET' && req.method!=='POST') return res.status(405).json({ error:'GET or POST'});
  if (!verifyCronAuth(req)){
    if(process.env.TURSO_DATABASE_URL){ try{ await logServerOps('warn','cron_auth_fail','weekly unauthorized', {headers:Object.keys(req.headers||{})}, req); }catch{} }
    return res.status(401).json({ error:'unauthorized cron', hint:'send x-cron-secret: <CRON_SECRET> or Authorization: Bearer <CRON_SECRET>'});
  }
  let db;
  try{ db=getClient(); }
  catch{ return res.status(503).json({error:'pairing unavailable'}); }
  let now;
  let cycle;
  try{
    const clock=await db.execute(`SELECT strftime('%Y-%m-%dT%H:%M:%fZ','now') AS now_utc`);
    now=new Date(clock.rows?.[0]?.now_utc);
    if(!Number.isFinite(now.getTime())) throw new Error('invalid database time');
    cycle=resolvePairingCycle({now});
    if(!isDue({now})){
      return res.json({ok:true,skipped:true,reason:'outside_due_window',cycle,message:'Pairing publication is only due during the configured Sunday 08:00 UTC run window.'});
    }
  }catch{ return res.status(503).json({error:'pairing unavailable'}); }
  // The authenticated due-window scheduler is also the guaranteed lifecycle
  // sweep for private CRDT state. Only the expected pre-v20 rollout state is
  // optional; operational/storage failures are visible and fail the job.
  try{ await purgeExpiredCodeDocuments(db); }
  catch(error){
    if(!codeDocumentSchemaNotInstalled(error)){
      try{ await logServerOps('error','code_document_retention_failed','code document retention failed',{},req); }catch{}
      return res.status(503).json({error:'code document retention unavailable'});
    }
  }
  // Invite-request retention (30 days) shares the guaranteed weekly sweep. It
  // repeats bounded batches (capped) while work remains and, unlike CRDT state, never blocks pairing
  // publication: a failure is logged as an ops error and retried next week.
  try{
    const retention=await runInviteRequestRetention(db,{nowSeconds:Math.floor(now.getTime()/1000)});
    if(retention.expired||retention.purged){
      try{ await logServerOps('info','invite_request_retention','invite request retention completed',retention,null); }catch{}
    }
  }catch(error){
    if(!inviteRequestSchemaNotInstalled(error)){
      try{ await logServerOps('error','invite_request_retention_failed','invite request retention failed',{},req); }catch{}
    }
  }
  const localRuntime=strictLocalPairingRuntime(req);
  if(!secondaryCircleCoordinationEnabled()||localRuntime){
    return runCurrentPairing(req,res,{db,localRuntime,localRequest:localRuntimeRequest(req)});
  }
  let secondaryScopes=null,secondaryOverflow=null;
  try{ secondaryScopes=await listSecondaryPairingScopes(db); }
  catch(error){
    if(error?.code==='CIRCLE_PAIRING_BATCH_OVERFLOW') secondaryOverflow=error;
    else{
      const failure=circlePairingFailure(error);
      return res.status(failure.status).json(failure.body);
    }
  }
  let primary;
  try{
    // Keep production membership scope while allowing the verified loopback
    // development transport to use its canonical HTTP origin.
    primary=await currentPairingResult(req,{
      db,localRuntime:false,localRequest:localRuntimeRequest(req),useApplicationClock:false,
    });
  }
  catch(error){ return pairingFailure(res,error); }
  if(secondaryOverflow){
    const failure=circlePairingFailure(secondaryOverflow);
    return res.status(failure.status).json(failure.body);
  }
  const secondary={attempted:secondaryScopes.length,created:0,existing:0,failed:0};
  for(const circleId of secondaryScopes){
    try{
      const result=await publishCirclePairing(db,{authority:{kind:'system',circleId}});
      if(result.created) secondary.created+=1;
      else secondary.existing+=1;
    }catch{
      secondary.failed+=1;
      continue;
    }
  }
  if(secondary.failed){
    try{ await logServerOps('error','weekly_pairing_completed','weekly pairing completed with failures',{
      primary:{created:primary.created,existing:primary.skipped,
        participant_count:primary.participant_count,pair_count:primary.pair_count,
        solo_count:primary.solo_count},
      secondary,
    },null); }catch{}
    return res.status(503).json({ok:false,error:'pairing unavailable',retryable:true,secondary});
  }
  try{ await logServerOps('info','weekly_pairing_completed','weekly pairing completed',{
    primary:{created:primary.created,existing:primary.skipped,
      participant_count:primary.participant_count,pair_count:primary.pair_count,
      solo_count:primary.solo_count},
    secondary,
  },null); }catch{}
  return res.json({...primary,secondary});
}


async function handleDemoSeed(req,res){
  if (req.method!=='POST') return res.status(405).json({ error:'POST only for demo-seed' });
  let ctx=await requireAdmin(req,res); if(!ctx) return;
  ctx=await prepareAdminOperation(ctx,res,ensureDemoSeedReadiness); if(!ctx) return;
  const db=ctx.db;
  const names=['Mia Chen','Alex Rivera','Priya Shah','Jordan Kim','Samir Desai','Lena Wu'];
  const palette=['#e6c07a','#9cc0b5','#d68a8a','#a3b5d6','#c7b29a','#8ec0a5'];
  const ts=Date.now();
  const seeded=[];
  for(let i=0;i<names.length;i++){
    const name=names[i]; const color=palette[i%palette.length];
    const email = `demo+${ts}+${i+1}@randori.demo`.toLowerCase();
    try{
      await db.execute({ sql:`INSERT OR IGNORE INTO auth_accounts (email, password_hash, display_name, color, is_available, is_admin, is_demo) VALUES (?,?,?,?,?,?,?)`, args:[email, 'demo_hash_placeholder_$2a$10$demo', name, color, 1, 0, 1]});
      const row=await db.execute({ sql:`SELECT id FROM auth_accounts WHERE email=?`, args:[email]});
      if(row.rows.length) seeded.push({ id:row.rows[0].id, name, email, color });
    }catch(e){
      // ignore duplicate / error
    }
  }
  return res.json({ ok:true, seeded_count:seeded.length, seeded, note:'6 demo users ready (is_demo=1, is_available=1). They are isolated to explicit demo flows and excluded from normal weekly pairing.' });
}

async function handleDemoShuffle(req,res){
  if (req.method!=='POST') return res.status(405).json({ error:'POST only for demo-shuffle' });
  let ctx = await requireAdmin(req,res);
  if (!ctx) return;
  ctx=await prepareAdminOperation(ctx,res,ensureDemoShuffleReadiness);
  if(!ctx) return;
  const {db, callerEmail, callerIsAdminFlag} = ctx;
  // ensure demo users exist if less than 2
  let demoCount=0;
  try{
    const cnt = await db.execute(`SELECT COUNT(*) as c FROM auth_accounts WHERE is_demo=1 AND COALESCE(is_available,1)=1`);
    demoCount=cnt.rows[0].c||0;
  }catch{ demoCount=0; }
  if(demoCount<2){
    // inline seed minimal
    const names=["Mia Chen","Alex Rivera","Priya Shah","Jordan Kim","Samir Desai","Lena Wu"];
    const ts=Date.now();
    for(let i=0;i<names.length;i++){
      const email = `demo+${ts}+${i+1}@randori.demo`.toLowerCase();
      const color = deterministicColor(email);
      try{ await db.execute({ sql:`INSERT OR IGNORE INTO auth_accounts (email,password_hash,display_name,color,is_available,is_admin,is_demo) VALUES (?,?,?,?,?,?,?)`, args:[email,'demo',names[i],color,1,0,1]});}catch{}
    }
  }
  // now shuffle using all available (demo+real)
  let authRs;
  try{ authRs=await db.execute(`SELECT id, display_name as name, email, color, is_available, is_demo FROM auth_accounts WHERE COALESCE(is_available,1)=1 ORDER BY id`);}catch{ authRs=await db.execute(`SELECT id, display_name as name, email, color FROM auth_accounts ORDER BY id`); }
  if (authRs.rows.length<2){
    return res.status(400).json({ ok:false, error:'need at least 2 available users (demo or real) to shuffle', available_count:authRs.rows.length });
  }
  const participants = authRs.rows.map(r=>({ id:r.id, name:r.name, email:r.email, color:r.color, source:'auth', is_demo: !!r.is_demo }));
  const now=new Date();
  const weekLabel = isoWeekLabel(now) + `-demo-${String(Date.now()).slice(-4)}`;
  const isDemoWeek = participants.some(p=>p.is_demo) ? 1:0;
  const history=await loadPairingHistory(db,weekLabel,{includeDemo:true});
  const pairing=buildFairPairing(participants,history,{seed:`${weekLabel}:demo`});
  const persisted=await persistPairingWeek(db,{weekLabel,weekStart:now.toISOString(),participants,pairing,isDemoWeek});
  if(!persisted.created) return res.status(409).json({ok:false,error:'demo shuffle label collision; retry',week_label:weekLabel});
  pairing.generation=persisted.generation;
  return res.json({ ok:true, demo:true, week_label:weekLabel, week_id:persisted.weekId, reshuffled_by:callerEmail, is_admin_via:callerIsAdminFlag?'db':'env', pairs:persisted.pairs.map(p=>({ a:p.a.name, b: p.b ? p.b.name : 'AI partner', a_id:p.a.id, b_id:p.b? p.b.id:null, isAI:p.isAI, is_demo_a: !!p.a.is_demo, is_demo_b: p.b ? !!p.b.is_demo : false, pg_id:p.groupId, room:canonicalRoomId(persisted.weekId,p.groupId) })), repeat_avoided:pairing.repeatCount, algorithm:pairingMetadata(pairing), count:participants.length, note:'Demo shuffle — all available users (demo+real) paired, week marked is_demo=1 if any demo participant' });
}

async function handleDemoReset(req,res){
  if (req.method!=='POST') return res.status(405).json({ error:'POST only for demo-reset' });
  let ctx = await requireAdmin(req,res);
  if (!ctx) return;
  ctx=await prepareAdminOperation(ctx,res,ensureDemoResetReadiness);
  if(!ctx) return;
  const {db} = ctx;
  let deletedGroups=0, deletedWeeks=0, deletedUsers=0;
  try{ const cnt=await db.execute(`SELECT COUNT(*) AS c FROM pairing_groups WHERE week_id IN (SELECT id FROM pairing_weeks WHERE is_demo=1)`); deletedGroups=cnt.rows[0]?.c||0; }catch{}
  try{ const cnt=await db.execute(`SELECT COUNT(*) AS c FROM pairing_weeks WHERE is_demo=1`); deletedWeeks=cnt.rows[0]?.c||0; }catch{}
  try{ const cnt=await db.execute(`SELECT COUNT(*) AS c FROM auth_accounts WHERE is_demo=1`); deletedUsers=cnt.rows[0]?.c||0; }catch{}
  await db.batch([
    `DELETE FROM pair_meeting_links WHERE week_id IN (SELECT id FROM pairing_weeks WHERE is_demo=1)`,
    `DELETE FROM pair_session_controls WHERE week_id IN (SELECT id FROM pairing_weeks WHERE is_demo=1)`,
    `DELETE FROM session_completion_receipts WHERE week_id IN (SELECT id FROM pairing_weeks WHERE is_demo=1)`,
    `DELETE FROM pairing_participants WHERE week_id IN (SELECT id FROM pairing_weeks WHERE is_demo=1)`,
    `DELETE FROM pairing_groups WHERE week_id IN (SELECT id FROM pairing_weeks WHERE is_demo=1)`,
    `DELETE FROM pairing_week_runs WHERE week_id IN (SELECT id FROM pairing_weeks WHERE is_demo=1)`,
    `DELETE FROM pairing_weeks WHERE is_demo=1`,
    `DELETE FROM auth_accounts WHERE is_demo=1`,
  ],'write');
  return res.json({ ok:true, deleted:{ groups:deletedGroups, weeks:deletedWeeks, demo_users:deletedUsers }, note:'Demo reset complete — demo users + demo weeks + their groups deleted. Real users untouched.' });
}

async function handleOps(req,res,{isWeeklyDue=pairingCronIsDue}={}){
  const ep = getEndpoint(req);
  const pathLower = (req.url||'').toLowerCase();
  const availabilityRequest=ep==='availability'||pathLower.includes('availability');
  if(availabilityRequest) res.setHeader('Cache-Control',AVAILABILITY_CACHE_CONTROL);
  if(!verifyMutationOrigin(req)) return res.status(403).json(availabilityRequest
    ?{ok:false,error:'cross-origin mutation rejected'}
    :{error:'cross-origin mutation rejected'});
  const unscopedCircleFeature=(availabilityRequest&&!multiCircleAvailabilityEnabled())
    ||((ep==='pairing-run'||pathLower.includes('/pairing/run'))&&!secondaryCircleCoordinationEnabled())
    ||ep==='reshuffle'||ep==='promote'||pathLower.includes('reshuffle')||pathLower.includes('promote');
  if(multiCircleControlPlaneEnabled()&&unscopedCircleFeature){
    try{
      const payload=await verifyRequestAuth(req);
      const userId=Number(payload?.id??payload?.uid);
      if(Number.isSafeInteger(userId)&&userId>0
        &&!(await canUseLegacySinglePrimaryCircleFeatures(getClient(),payload))){
        return sendMultiCircleFeatureUnavailable(res);
      }
    }catch{ return res.status(503).json({error:'circle context unavailable'}); }
  }
  if (ep==='circle-health') return handleCircleHealth(req,res);
  // Issue #310: admin-only diagnostics, a 404 unless ADMIN_DIAGNOSTICS_ENABLED=true.
  if (ep==='admin-diagnostics' || pathLower.includes('/admin/diagnostics')){
    return handleAdminDiagnosticsRequest(req,res,{verifyRequestAuth,getClient,notFound:()=>unknownOpsEndpoint(res,ep)});
  }
  if (ep==='notifications-prefs' || ep==='notifications' || ep==='prefs' || ep.includes('notification') || pathLower.includes('notifications') || pathLower.includes('notif') ) return handleNotificationPrefs(req,res);
  if (availabilityRequest) return handleAvailability(req,res);
  if (ep==='demo-seed' || ep==='demo_seed' || pathLower.includes('demo-seed')) return handleDemoSeed(req,res);
  if (ep==='demo-shuffle' || ep==='demo_shuffle' || ep==='dem0-shuffle' || pathLower.includes('demo-shuffle')) return handleDemoShuffle(req,res);
  if (ep==='demo-reset' || ep==='demo_reset' || pathLower.includes('demo-reset')) return handleDemoReset(req,res);
  if (ep==='pairing-run' || pathLower.includes('/pairing/run')) return handlePairingRun(req,res);
  if (ep==='outbox-replay' || pathLower.includes('/outbox/replay')) return handleOutboxReplay(req,res);
  if (ep==='outbox-health' || pathLower.includes('/cron/outbox-health')) return handleOutboxHealth(req,res);
  if (ep==='execution-smoke' || pathLower.includes('/cron/execution-smoke')) return handleExecutionSmoke(req,res);
  if (ep==='outbox' || pathLower.includes('/cron/outbox')) return handleOutboxWorker(req,res);
  if (ep==='reshuffle' || ep==='promote' || pathLower.includes('reshuffle') || pathLower.includes('promote')) return handleReshuffle(req,res);
  if (ep==='weekly' || pathLower.includes('weekly') || pathLower.includes('/cron/')){
    return handleWeekly(req,res,{isDue:isWeeklyDue});
  }
  if (pathLower.includes('reshuffle')) return handleReshuffle(req,res);
  if (pathLower.includes('weekly')) return handleWeekly(req,res,{isDue:isWeeklyDue});
  return unknownOpsEndpoint(res,ep);
}

// The flag-off admin diagnostics route answers with exactly this response, so
// it cannot be told apart from an endpoint that does not exist.
function unknownOpsEndpoint(res,ep){
  return res.status(404).json({ error:`unknown ops endpoint '${ep}'`, available:['availability','pairing-run','weekly','outbox','outbox-health','execution-smoke','outbox-replay','demo-seed','demo-shuffle','demo-reset'] });
}

export function createOpsHandler({isWeeklyDue=pairingCronIsDue}={}){
  if(typeof isWeeklyDue!=='function') throw new TypeError('isWeeklyDue must be a function');
  return (req,res)=>handleOps(req,res,{isWeeklyDue});
}

export default createOpsHandler();
