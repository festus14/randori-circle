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
import {
  createPairingEmailHandler,
  createResendEmailSender,
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
import {
  createEmailActivationHandler,
  EMAIL_ACTIVATION_EVENT_TYPE,
  emailActivationConfiguration,
  emailActivationKeyRotationStatus,
} from './_email-activation.js';
import {
  createPasswordResetHandler,
  PASSWORD_RESET_EVENT_TYPE,
  passwordResetConfiguration,
  passwordResetKeyRotationStatus,
} from './_password-reset.js';
import {
  createScheduleEmailHandler,
  SCHEDULE_EMAIL_EVENT_TYPE,
} from './_schedule-email.js';
import {
  createInvitationEmailHandler,
  invitationEmailConfiguration,
  invitationEmailKeyRotationStatus,
  INVITATION_EMAIL_EVENT_TYPE,
} from './_invitation-email.js';
import {identityEmailKeyRotationStatus} from './_identity-linking.js';
import { localIdentityAdapterEnabled, localRuntimeRequest } from './_local-runtime.js';
import { ensureCircleMembershipReadiness } from './_circle-membership.js';
import {
  canUseLegacySinglePrimaryCircleFeatures,
  multiCircleAvailabilityEnabled,
  multiCircleControlPlaneEnabled,
  requestMatchesCircleContext,
  resolveActiveCircleContext,
  sendMultiCircleFeatureUnavailable,
} from './_active-circle.js';

export const OUTBOX_CRON_BUDGET_MS=45_000;
export const OUTBOX_CRON_FINALIZATION_RESERVE_MS=5_000;
export const OUTBOX_CRON_MAX_CLAIMS=8;
const OUTBOX_CRON_MIN_DISPATCH_WINDOW_MS=100;

const OUTBOX_DELIVERY_TYPES=Object.freeze([
  Object.freeze({type:PAIRING_EMAIL_EVENT_TYPE,key:'email_delivery',label:'email reminder'}),
  Object.freeze({type:SCHEDULE_EMAIL_EVENT_TYPE,key:'schedule_delivery',label:'schedule email'}),
  Object.freeze({type:INVITATION_EMAIL_EVENT_TYPE,key:'invitation_delivery',label:'invitation email'}),
  Object.freeze({type:EMAIL_ACTIVATION_EVENT_TYPE,key:'activation_delivery',label:'activation email'}),
  Object.freeze({type:PASSWORD_RESET_EVENT_TYPE,key:'password_reset_delivery',label:'password reset email'}),
]);

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

async function ensureNotifPrefs(db,req){
  if(localIdentityAdapterEnabled(req)){
    await db.execute(`SELECT user_id,email_enabled,sms_enabled,phone,email,updated_at FROM user_notification_prefs LIMIT 0`);
    return;
  }
  try{ await db.execute("CREATE TABLE IF NOT EXISTS user_notification_prefs (user_id INTEGER PRIMARY KEY, email_enabled INTEGER DEFAULT 1, sms_enabled INTEGER DEFAULT 0, phone TEXT, email TEXT, updated_at TEXT DEFAULT (datetime('now')))"); }catch{}
}

async function handleNotificationPrefs(req,res){
  if(req.method!=="GET"&&req.method!=="POST"&&req.method!=="PUT"){
    return res.status(405).json({error:"GET or POST/PUT"});
  }
  const payload=await verifyRequestAuth(req);
  if(!payload) return res.status(401).json({error:"authentication required"});
  const db=getClient();
  try{ await ensureNotifPrefs(db,req); }
  catch{ return res.status(503).json({error:"notification preferences unavailable"}); }
  if(req.method==="GET"){
    const uid=payload.id||payload.uid;
    try{
      const rs=await db.execute({sql:"SELECT user_id,email_enabled,sms_enabled,phone,email,updated_at FROM user_notification_prefs WHERE user_id=?", args:[uid]});
      if(rs.rows.length) return res.json({ok:true, prefs:rs.rows[0]});
      return res.json({ok:true, prefs:{user_id:uid,email_enabled:1,sms_enabled:0,phone:null}});
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
function isAdminCheck(email, flag){
  if (flag) return true;
  if (!email) return false;
  return getAdminEmails().has(String(email).toLowerCase().trim());
}
function verifyCronAuth(req){
  let secret;
  try{ secret=getCronSecret(); }catch{ return false; }
  const raw = req.headers['x-cron-secret'] || req.headers['X-Cron-Secret'] || req.headers['authorization'] || req.headers['Authorization'] || '';
  const presented = typeof raw==='string' && raw.startsWith('Bearer ') ? raw.slice(7) : String(raw||'');
  if(!presented) return false;
  const expectedBuf=Buffer.from(secret);
  const presentedBuf=Buffer.from(presented);
  return expectedBuf.length===presentedBuf.length && timingSafeEqual(expectedBuf,presentedBuf);
}

function isLoopbackHost(value){
  try{
    const hostname=new URL(`http://${String(value||'')}`).hostname.toLowerCase();
    return hostname==='localhost'||hostname==='127.0.0.1'||hostname==='[::1]';
  }catch{ return false; }
}

function isLoopbackAddress(value){
  const address=String(value||'').trim().toLowerCase();
  return address==='127.0.0.1'||address==='::1'||address==='::ffff:127.0.0.1';
}

function strictLocalPairingRuntime(req){
  if(process.env.NODE_ENV!=='development'
    ||process.env.RANDORI_LOCAL_RUNTIME!=='true'
    ||process.env.CIRCLE_MEMBERSHIP_ENABLED==='true'
    ||process.env.VERCEL||process.env.VERCEL_ENV||process.env.VERCEL_URL
    ||String(process.env.TURSO_AUTH_TOKEN||'').trim()) return false;
  let databaseUrl,appUrl,requestUrl;
  try{
    databaseUrl=new URL(String(process.env.TURSO_DATABASE_URL||''));
    appUrl=new URL(String(process.env.APP_URL||''));
    requestUrl=new URL(`http://${String(req?.headers?.host||'')}`);
  }catch{ return false; }
  if(databaseUrl.protocol!=='file:'||databaseUrl.host||databaseUrl.username||databaseUrl.password
    ||databaseUrl.search||databaseUrl.hash) return false;
  if(appUrl.protocol!=='http:'||appUrl.username||appUrl.password||appUrl.search||appUrl.hash
    ||(appUrl.pathname!=='/'&&appUrl.pathname!=='')||!isLoopbackHost(appUrl.host)
    ||appUrl.host.toLowerCase()!==requestUrl.host.toLowerCase()) return false;
  return isLoopbackHost(req?.headers?.host)&&isLoopbackAddress(req?.socket?.remoteAddress);
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
  return {db,callerId,localRuntime,localRequest:localRuntimeRequest(req),scope};
}

async function ensureMigrations(db){
  try{ await db.execute(`CREATE TABLE IF NOT EXISTS auth_accounts (id INTEGER PRIMARY KEY AUTOINCREMENT, email TEXT UNIQUE NOT NULL, password_hash TEXT NOT NULL, display_name TEXT NOT NULL, color TEXT NOT NULL, created_at TEXT DEFAULT (datetime('now')), last_login TEXT, is_available INTEGER DEFAULT 1, availability_updated_at TEXT, is_admin INTEGER DEFAULT 0, is_demo INTEGER DEFAULT 0)`);}catch{}
  try{ await db.execute(`CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, color TEXT NOT NULL, created_at TEXT DEFAULT (datetime('now')))`);}catch{}
  try{ await db.execute(`CREATE TABLE IF NOT EXISTS pairing_weeks (id INTEGER PRIMARY KEY AUTOINCREMENT, week_label TEXT NOT NULL, week_start TEXT NOT NULL, focus TEXT NOT NULL DEFAULT 'both', created_at TEXT DEFAULT (datetime('now')), is_demo INTEGER DEFAULT 0)`);}catch{}
  try{ await db.execute(`CREATE TABLE IF NOT EXISTS pairing_groups (id INTEGER PRIMARY KEY AUTOINCREMENT, week_id INTEGER NOT NULL, user_a_id INTEGER NOT NULL, user_b_id INTEGER NOT NULL, user_c_id INTEGER, is_ai_pair INTEGER DEFAULT 0, topic TEXT DEFAULT 'Pick together', topic_kind TEXT DEFAULT 'both', created_at TEXT DEFAULT (datetime('now')))`);}catch{}
  try{ await db.execute(`CREATE TABLE IF NOT EXISTS pairing_week_runs (week_label TEXT PRIMARY KEY, week_id INTEGER, generation_token TEXT NOT NULL, generation INTEGER NOT NULL DEFAULT 1, algorithm_version TEXT NOT NULL, algorithm_seed TEXT NOT NULL, participant_count INTEGER NOT NULL, participants_json TEXT NOT NULL, created_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now')))`);}catch{}
  try{ await db.execute(`CREATE TABLE IF NOT EXISTS pairing_participants (week_id INTEGER NOT NULL, user_id INTEGER NOT NULL, position INTEGER NOT NULL, source TEXT NOT NULL DEFAULT 'auth', created_at TEXT DEFAULT (datetime('now')), PRIMARY KEY (week_id, user_id))`);}catch{}
  try{ await db.execute(`CREATE TABLE IF NOT EXISTS pairing_email_outbox (id INTEGER PRIMARY KEY AUTOINCREMENT, week_id INTEGER NOT NULL, user_id INTEGER NOT NULL, kind TEXT NOT NULL, recipient_email TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending', attempt_count INTEGER NOT NULL DEFAULT 0, claimed_at TEXT, sent_at TEXT, provider_message_id TEXT, last_error TEXT, created_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now')), UNIQUE (week_id,user_id,kind))`);}catch{}
  try{ await db.execute(`CREATE INDEX IF NOT EXISTS idx_pairing_email_outbox_pending ON pairing_email_outbox(week_id,status,created_at)`);}catch{}
  // New installs get a direct invariant; pairing_week_runs remains the concurrency guard
  // for older databases where historical duplicate labels prevent this index.
  try{ await db.execute(`CREATE UNIQUE INDEX IF NOT EXISTS idx_pairing_weeks_week_label ON pairing_weeks(week_label)`);}catch{}
  const alters=[
    `ALTER TABLE auth_accounts ADD COLUMN is_available INTEGER DEFAULT 1`,
    `ALTER TABLE auth_accounts ADD COLUMN availability_updated_at TEXT`,
    `ALTER TABLE auth_accounts ADD COLUMN is_admin INTEGER DEFAULT 0`,
    `ALTER TABLE auth_accounts ADD COLUMN is_demo INTEGER DEFAULT 0`,
    `ALTER TABLE pairing_weeks ADD COLUMN is_demo INTEGER DEFAULT 0`,
    `ALTER TABLE auth_accounts ADD COLUMN phone TEXT`,
    `ALTER TABLE pairing_week_runs ADD COLUMN generation INTEGER NOT NULL DEFAULT 1`,
];
  for(const sql of alters){ try{ await db.execute(sql); }catch{} }
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

function configuredOutboxBaseUrl(){
  let url;
  try{ url=new URL(String(process.env.APP_URL||'')); }
  catch{ return null; }
  const local=process.env.NODE_ENV==='development'&&process.env.RANDORI_LOCAL_RUNTIME==='true';
  const loopback=url.hostname==='127.0.0.1'||url.hostname==='[::1]'||url.hostname==='localhost';
  if(url.username||url.password||url.search||url.hash||(url.pathname&&url.pathname!=='/')
    ||(local?(url.protocol!=='http:'||!loopback):(url.protocol!=='https:'||loopback))){
    return null;
  }
  return url.origin;
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

function localCaptureSender(captured,type){
  return async message=>{
    const kind=type===PAIRING_EMAIL_EVENT_TYPE
      ?(String(message.subject).includes('missed')?'unavailable':'paired')
      :type===SCHEDULE_EMAIL_EVENT_TYPE?'schedule'
        :type===INVITATION_EMAIL_EVENT_TYPE?'invitation'
          :type===PASSWORD_RESET_EVENT_TYPE?'password-reset':'activation';
    captured.get(type).push({recipient_email:String(message.to),kind,subject:String(message.subject),
      links:[...message.html.matchAll(/href="([^"]+)"/gu)].map(match=>match[1]).slice(0,4)});
    return {providerName:'local-capture',providerMessageId:`local-${randomUUID()}`};
  };
}

async function outboxDeliveryPlan(db,baseUrl,req){
  const local=localIdentityAdapterEnabled(req);
  const captured=new Map(OUTBOX_DELIVERY_TYPES.map(({type})=>[type,[]]));
  let sharedSend=null;
  if(!local&&process.env.RESEND_API_KEY&&process.env.RESEND_FROM){
    const resendMod=await import('resend').catch(()=>null);
    if(resendMod?.Resend){
      sharedSend=createResendEmailSender({
        resend:new resendMod.Resend(process.env.RESEND_API_KEY),from:process.env.RESEND_FROM,
      });
    }
  }
  const sender=type=>local?localCaptureSender(captured,type):sharedSend;
  const handlers=new Map();
  const pairingSend=sender(PAIRING_EMAIL_EVENT_TYPE);
  const scheduleSend=sender(SCHEDULE_EMAIL_EVENT_TYPE);
  const invitationSend=sender(INVITATION_EMAIL_EVENT_TYPE);
  const activationSend=sender(EMAIL_ACTIVATION_EVENT_TYPE);
  const passwordResetSend=sender(PASSWORD_RESET_EVENT_TYPE);
  if(pairingSend) handlers.set(PAIRING_EMAIL_EVENT_TYPE,
    createPairingEmailHandler({db,baseUrl,send:pairingSend,localRuntime:local}));
  if(scheduleSend) handlers.set(SCHEDULE_EMAIL_EVENT_TYPE,
    createScheduleEmailHandler({db,baseUrl,send:scheduleSend,localRuntime:local}));
  if(invitationEmailConfiguration({localRuntime:local})&&invitationSend){
    handlers.set(INVITATION_EMAIL_EVENT_TYPE,createInvitationEmailHandler({
      db,baseUrl,send:invitationSend,localRuntime:local,
    }));
  }
  if(emailActivationConfiguration()&&activationSend){
    handlers.set(EMAIL_ACTIVATION_EVENT_TYPE,createEmailActivationHandler({
      db,baseUrl,send:activationSend,
    }));
  }
  if(passwordResetConfiguration()&&passwordResetSend){
    handlers.set(PASSWORD_RESET_EVENT_TYPE,createPasswordResetHandler({
      db,baseUrl,send:passwordResetSend,
    }));
  }
  return {local,captured,handlers};
}

function unavailableDeliverySummary(type,status){
  const pending=status.pending+status.retry+status.processing;
  if(type===PAIRING_EMAIL_EVENT_TYPE){
    return `${pending} email reminder(s) pending — email delivery unavailable`;
  }
  if(type===SCHEDULE_EMAIL_EVENT_TYPE) return 'schedule email delivery unavailable';
  if(type===INVITATION_EMAIL_EVENT_TYPE) return 'invitation email delivery unavailable';
  if(type===PASSWORD_RESET_EVENT_TYPE) return 'password reset email delivery unavailable';
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

export async function deliverPendingOutbox(db,baseUrl,req,deadlineAtMs,{
  maxClaims=OUTBOX_CRON_MAX_CLAIMS,
  finalizationReserveMs=OUTBOX_CRON_FINALIZATION_RESERVE_MS,
  minimumDispatchWindowMs=OUTBOX_CRON_MIN_DISPATCH_WINDOW_MS,
}={}){
  const preparationDeadline=deadlineAtMs-finalizationReserveMs-minimumDispatchWindowMs;
  const preparation=await settleBeforeDeadline(async()=>{
    await migrateLegacyPairingEmails(db,{limit:maxClaims});
    return outboxDeliveryPlan(db,baseUrl,req);
  },preparationDeadline);
  const plan=preparation.completed?preparation.value:{
    local:false,captured:new Map(OUTBOX_DELIVERY_TYPES.map(({type})=>[type,[]])),handlers:new Map(),
  };
  const eventTypes=OUTBOX_DELIVERY_TYPES.map(({type})=>type).filter(type=>plan.handlers.has(type));
  const invocation=preparation.completed&&eventTypes.length?await runOutboxInvocation({
    db,workerId:`outbox-${randomUUID()}`,handlers:plan.handlers,eventTypes,
    maxClaims,deadlineAtMs,finalizationReserveMs,minimumDispatchWindowMs,
  }):emptyOutboxInvocation(eventTypes,{deadlineReached:!preparation.completed,maxClaims});
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
    claimed:invocation.claimed,types,key_rotation:metricRead.completed?metricRead.value.keyRotation:null};
  if(!metrics.deadline_reached&&performance.now()<deadlineAtMs){
    const logged=await settleBeforeDeadline(()=>logServerOps(
      invocation.retried||invocation.deadLettered||invocation.leaseLost?'warn':'success',
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
  if(!verifyCronAuth(req)) return res.status(401).json({error:'unauthorized cron'});
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
  if (callerId){ try{ const cr=await db.execute({ sql:`SELECT id,email,is_admin FROM auth_accounts WHERE id=?`, args:[callerId]}); if(cr.rows.length){ callerDbRow=cr.rows[0]; callerEmail=String(cr.rows[0].email||'').toLowerCase().trim(); callerIsAdminFlag=!!cr.rows[0].is_admin; }}catch{} }
  if (getAdminEmails().has(callerEmail) && callerDbRow && !callerIsAdminFlag){ try{ await db.execute({ sql:`UPDATE auth_accounts SET is_admin=1 WHERE id=?`, args:[callerDbRow.id]}); callerIsAdminFlag=true; }catch{} }
  const callerIsAdmin = !!callerDbRow && isAdminCheck(callerEmail, callerIsAdminFlag);
  return {callerEmail, callerId, callerIsAdminFlag, callerDbRow, callerIsAdmin};
}

async function requireAdmin(req,res){
  const payload=await verifyRequestAuth(req);
  if (!payload) { res.status(401).json({ error:'authentication required' }); return null; }
  const db = getClient();
  await ensureMigrations(db);
  const ctx = await getCallerAdmin(db, payload);
  if (!ctx.callerIsAdmin){ res.status(403).json({ error:'forbidden: admin only' }); return null; }
  return {db, payload, ...ctx};
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

async function handleReshuffle(req,res){
  if (req.method!=='POST') return res.status(405).json({ error:'POST only for reshuffle or promote' });
  const body = req.body||{};
  const queryAction=req.query?.action;
  const action=(body.action||queryAction||'').toString().toLowerCase();
  // Preserve the legacy promotion operation, but make the old reshuffle URL a
  // compatibility alias for the immutable current-cycle publication. There is
  // deliberately no force/remix operation for a published cycle.
  if(action!=='promote') return handlePairingRun(req,res);
  const adminCtx = await requireAdmin(req,res);
  if (!adminCtx) return;
  const {db, callerEmail, callerIsAdminFlag} = adminCtx;
  const targetEmailRaw = body.email||body.target||req.query?.email;
  if (!targetEmailRaw) return res.status(400).json({ error:'email required for promotion', example:{ action:'promote', email:'newadmin@example.com'}});
  const targetEmail = String(targetEmailRaw).trim().toLowerCase();
  if (!targetEmail.includes('@')) return res.status(400).json({ error:'invalid email'});
  try{
    const existing = await db.execute({ sql:`SELECT id,email,is_admin FROM auth_accounts WHERE lower(email)=?`, args:[targetEmail]});
    if (!existing.rows.length){ return res.status(404).json({ ok:false, error:'user not found in auth_accounts — ask them to sign up first, then promote, or add them to ADMIN_EMAILS env var to auto-admin on signup', target:targetEmail, note:'Adding to ADMIN_EMAILS env var will auto-promote on next signup/login/Google'}); }
    await db.execute({ sql:`UPDATE auth_accounts SET is_admin=1 WHERE lower(email)=?`, args:[targetEmail]});
    return res.json({ ok:true, promoted:targetEmail, id:existing.rows[0].id, by:callerEmail, is_admin_via:callerIsAdminFlag?'db':'env', note:'User is now admin (is_admin=1). They will get admin flag on next login/token refresh.' });
  }catch(e){ return res.status(500).json({ error:'db error promoting', detail:String(e.message||e).slice(0,200)}); }
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
    email_delivery:safeEmailDelivery(emailDelivery),
    message:result.created
      ?'Current-cycle pairings published. Solo members receive a Solo practice room.'
      :'Current-cycle pairings were already published; no pairs were changed.',
  };
}

function pairingFailure(res,error){
  if(error?.code==='PAIRING_PUBLISHER_REVOKED'){
    return res.status(403).json({error:'primary circle owner required'});
  }
  if(error?.code==='PAIRING_PUBLICATION_NO_PARTICIPANTS'){
    return res.status(400).json({error:'At least one available member is required. A single member receives Solo practice.'});
  }
  if(error?.code==='PAIRING_PUBLICATION_LEGACY_CONFLICT'){
    return res.status(409).json({error:'The current cycle cannot be published because legacy pairing data already exists.'});
  }
  return res.status(503).json({error:'pairing unavailable'});
}

async function runCurrentPairing(req,res,{
  db,localRuntime,localRequest=false,callerId=null,scope:authorizedScope=null,
}){
  try{
    const result=await publishPairingCycle(db,{
      localRuntime,callerId,authorizedScope,
      appUrl:process.env.APP_URL,
      // Loopback transport is independent from publication scope. Invite-bound
      // local identity still uses audited circle membership and v3 readiness.
      allowLocalAppUrl:localRequest,
      // The isolated local runtime shares the application clock with its read
      // models; production remains pinned to the database-owned timestamp.
      ...(localRequest?{now:new Date()}:{}),
    });
    let emailDelivery={summary:'pairing emails queued for outbox delivery'};
    try{
      const status=await pairingEmailStatus(db);
      emailDelivery={summary:`${status.pending+status.retry+status.processing} pairing email(s) queued for outbox delivery; exhausted ${status.dead_letter}, suppressed ${status.suppressed}`,
        sent:0,failed:0,exhausted:status.dead_letter,
        pending:status.pending+status.retry+status.processing,suppressed:status.suppressed};
    }catch{}
    return res.json(pairingPublicationPayload(result,emailDelivery));
  }catch(error){
    return pairingFailure(res,error);
  }
}

async function handlePairingRun(req,res){
  if(req.method!=='POST') return res.status(405).json({error:'POST only'});
  const context=await requirePairingPublisher(req,res);
  if(!context) return;
  const body=req.body===undefined?{}:req.body;
  if(!body||typeof body!=='object'||Array.isArray(body)||Object.keys(body).length){
    return res.status(400).json({error:'request body must be empty; published cycles cannot be remixed'});
  }
  return runCurrentPairing(req,res,context);
}

async function handleWeekly(req,res){
  // Vercel Cron invokes configured paths with GET; authentication below is mandatory.
  if (req.method!=='GET' && req.method!=='POST') return res.status(405).json({ error:'GET or POST'});
  if (!verifyCronAuth(req)){
    if(process.env.TURSO_DATABASE_URL){ try{ await logServerOps('warn','cron_auth_fail','weekly unauthorized', {headers:Object.keys(req.headers||{})}, req); }catch{} }
    return res.status(401).json({ error:'unauthorized cron', hint:'send x-cron-secret: <CRON_SECRET> or Authorization: Bearer <CRON_SECRET>'});
  }
  const now=new Date();
  let cycle;
  try{
    cycle=resolvePairingCycle({now});
    if(!pairingCronIsDue({now})){
      return res.json({ok:true,skipped:true,reason:'outside_due_window',cycle,message:'Pairing publication is only due during the configured Sunday 08:00 UTC run window.'});
    }
  }catch{ return res.status(503).json({error:'pairing unavailable'}); }
  let db;
  try{ db=getClient(); }
  catch{ return res.status(503).json({error:'pairing unavailable'}); }
  return runCurrentPairing(req,res,{
    db,
    localRuntime:strictLocalPairingRuntime(req),
    localRequest:localRuntimeRequest(req),
  });
}


async function handleDemoSeed(req,res){
  if (req.method!=='POST') return res.status(405).json({ error:'POST only for demo-seed' });
  const ctx=await requireAdmin(req,res); if(!ctx) return; const db=ctx.db;
  await ensureMigrations(db);
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
  const ctx = await requireAdmin(req,res);
  if (!ctx) return;
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
  const ctx = await requireAdmin(req,res);
  if (!ctx) return;
  const {db} = ctx;
  let deletedGroups=0, deletedWeeks=0, deletedUsers=0;
  try{ const cnt=await db.execute(`SELECT COUNT(*) AS c FROM pairing_groups WHERE week_id IN (SELECT id FROM pairing_weeks WHERE is_demo=1)`); deletedGroups=cnt.rows[0]?.c||0; }catch{}
  try{ const cnt=await db.execute(`SELECT COUNT(*) AS c FROM pairing_weeks WHERE is_demo=1`); deletedWeeks=cnt.rows[0]?.c||0; }catch{}
  try{ const cnt=await db.execute(`SELECT COUNT(*) AS c FROM auth_accounts WHERE is_demo=1`); deletedUsers=cnt.rows[0]?.c||0; }catch{}
  await db.batch([
    `DELETE FROM pairing_participants WHERE week_id IN (SELECT id FROM pairing_weeks WHERE is_demo=1)`,
    `DELETE FROM pairing_groups WHERE week_id IN (SELECT id FROM pairing_weeks WHERE is_demo=1)`,
    `DELETE FROM pairing_week_runs WHERE week_id IN (SELECT id FROM pairing_weeks WHERE is_demo=1)`,
    `DELETE FROM pairing_weeks WHERE is_demo=1`,
    `DELETE FROM auth_accounts WHERE is_demo=1`,
  ],'write');
  return res.json({ ok:true, deleted:{ groups:deletedGroups, weeks:deletedWeeks, demo_users:deletedUsers }, note:'Demo reset complete — demo users + demo weeks + their groups deleted. Real users untouched.' });
}

export default async function handler(req,res){
  const ep = getEndpoint(req);
  const pathLower = (req.url||'').toLowerCase();
  const availabilityRequest=ep==='availability'||pathLower.includes('availability');
  if(availabilityRequest) res.setHeader('Cache-Control',AVAILABILITY_CACHE_CONTROL);
  if(!verifyMutationOrigin(req)) return res.status(403).json(availabilityRequest
    ?{ok:false,error:'cross-origin mutation rejected'}
    :{error:'cross-origin mutation rejected'});
  const unscopedCircleFeature=(availabilityRequest&&!multiCircleAvailabilityEnabled())
    ||ep==='pairing-run'||pathLower.includes('/pairing/run')
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
  if (ep==='notifications-prefs' || ep==='notifications' || ep==='prefs' || ep.includes('notification') || pathLower.includes('notifications') || pathLower.includes('notif') ) return handleNotificationPrefs(req,res);
  if (availabilityRequest) return handleAvailability(req,res);
  if (ep==='demo-seed' || ep==='demo_seed' || pathLower.includes('demo-seed')) return handleDemoSeed(req,res);
  if (ep==='demo-shuffle' || ep==='demo_shuffle' || ep==='dem0-shuffle' || pathLower.includes('demo-shuffle')) return handleDemoShuffle(req,res);
  if (ep==='demo-reset' || ep==='demo_reset' || pathLower.includes('demo-reset')) return handleDemoReset(req,res);
  if (ep==='pairing-run' || pathLower.includes('/pairing/run')) return handlePairingRun(req,res);
  if (ep==='outbox-replay' || pathLower.includes('/outbox/replay')) return handleOutboxReplay(req,res);
  if (ep==='outbox' || pathLower.includes('/cron/outbox')) return handleOutboxWorker(req,res);
  if (ep==='reshuffle' || ep==='promote' || pathLower.includes('reshuffle') || pathLower.includes('promote')) return handleReshuffle(req,res);
  if (ep==='weekly' || pathLower.includes('weekly') || pathLower.includes('/cron/')) return handleWeekly(req,res);
  if (pathLower.includes('reshuffle')) return handleReshuffle(req,res);
  if (pathLower.includes('weekly')) return handleWeekly(req,res);
  return res.status(404).json({ error:`unknown ops endpoint '${ep}'`, available:['availability','pairing-run','weekly','outbox','outbox-replay','promote via reshuffle?action=promote','demo-seed','demo-shuffle','demo-reset'] });
}
