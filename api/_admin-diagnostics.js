// Admin-only, read-only operational diagnostics (issue #310, ID-73).
//
// One GET returns aggregate health for the outbox, code execution, database
// readiness, the migration ledger and recent error categories. Everything is
// counts, fixed categories, timestamps and numeric outbox event ids (needed
// for the audited replay endpoint). It never returns emails, tokens, payloads,
// idempotency keys, code, URLs or free-form log messages.
//
// The feature is off unless ADMIN_DIAGNOSTICS_ENABLED=true. Only a global
// administrator can read it: an existing account with is_admin=1, not a demo
// account, with a live session (and, when circle membership is enforced, an
// active membership). Ordinary circle owners are refused.
import { LATEST_MIGRATION_VERSION, MIGRATION_CONTRACTS } from '../db/migration-contract.js';
import {
  migrationLedgerExists,
  readMigrationLedger,
  validateMigrationLedger,
} from '../db/migration-ledger-readiness.js';
import { parseEmailProviderReason } from './_email-provider-reason.js';
import { resolveExecutionProvider } from './_execution.js';
import {
  coalescedDatabaseReadiness,
  databaseReadinessConfiguration,
  readinessTargetExists,
} from './_health.js';
import { readOutboxMetrics } from './_outbox.js';
import { readOutboxDeliveryHealth } from './_outbox-health.js';

export const ADMIN_DIAGNOSTICS_FORMAT='randori.admin-diagnostics.v1';

const MINUTE=60*1000;
const HOUR=60*MINUTE;
const DAY=24*HOUR;

// Live reads are judged against the browser's refresh cadence.
export const DIAGNOSTICS_SNAPSHOT_MAX_AGE_MS=5*MINUTE;
// Same threshold as the outbox watchdog (WATCHDOG_DELIVERY_MAX_AGE_MS).
export const OUTBOX_DELIVERY_MAX_AGE_MS=15*MINUTE;
// Schedulers call the worker every five minutes; each completed invocation
// writes one `outbox_invocation` row. Three missed runs make the card stale.
export const OUTBOX_DISPATCH_EVIDENCE_MAX_AGE_MS=15*MINUTE;
// Daily smoke cadence planned by #249 plus a two-hour grace.
export const EXECUTION_EVIDENCE_MAX_AGE_MS=26*HOUR;
// The outbox worker logs every few minutes, so an hour without any log row
// means error counts may be incomplete.
export const LOG_EVIDENCE_MAX_AGE_MS=HOUR;
export const ERROR_WINDOW_MS=DAY;
export const OUTBOX_WATCHDOG_CADENCE_MS=HOUR;
// WATCHDOG_MAX_RUN_AGE_MS of the backup watchdog (weekly rehearsal + 1 day).
export const BACKUP_WATCHDOG_CADENCE_MS=8*DAY;
export const DEAD_LETTER_LIST_LIMIT=25;
export const ERROR_CATEGORY_LIMIT=20;
export const OUTBOX_TYPE_LIMIT=64;
export const LEDGER_RECENT_LIMIT=5;
// The reason codes POST /api/admin/outbox/replay accepts (replayDeadLetter in
// _outbox.js); a unit test keeps the two lists identical.
export const OUTBOX_REPLAY_REASON_CODES=Object.freeze(['OPERATOR_RETRY','PROVIDER_RECOVERED','CONFIGURATION_FIXED']);

const EXECUTION_EVENTS=Object.freeze({
  execute_success:'success',
  execute_fail:'failed',
  execute_unavailable:'unavailable',
});
const ERROR_SOURCES=new Set(['server','client','runner']);
const ERROR_CODE_PATTERN=/^[A-Z][A-Z0-9_]{0,63}$/;
const EVENT_TYPE_PATTERN=/^[a-z][a-z0-9]*(?:\.[a-z][a-z0-9]*)+$/;
const EVENT_NAME_PATTERN=/^[a-z][a-z0-9]*(?:[_.:-][a-z0-9]+)*$/i;

export function adminDiagnosticsEnabled(env=process.env){
  return env?.ADMIN_DIAGNOSTICS_ENABLED==='true';
}

function count(value){
  const parsed=Number(value??0);
  return Number.isSafeInteger(parsed)&&parsed>=0?parsed:0;
}

/** Parse ISO (`…Z`) and SQLite `datetime('now')` (UTC, no zone) timestamps. */
export function parseDiagnosticsInstant(value){
  if(value===null||value===undefined||value==='') return null;
  const text=String(value).trim();
  const sqlite=/^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2}(?:\.\d+)?)$/.exec(text);
  const milliseconds=Date.parse(sqlite?`${sqlite[1]}T${sqlite[2]}Z`:text);
  return Number.isFinite(milliseconds)?milliseconds:null;
}

function isoOrNull(milliseconds){
  return milliseconds===null?null:new Date(milliseconds).toISOString();
}

/**
 * Evidence freshness at the database clock. A card is stale when its newest
 * evidence is missing or older than its expected cadence.
 */
export function evidence(nowMs,atMs,maxAgeMs){
  const ageMs=atMs===null?null:Math.max(0,nowMs-atMs);
  return Object.freeze({
    at:isoOrNull(atMs),
    ageMs,
    maxAgeMs,
    stale:ageMs===null||ageMs>maxAgeMs,
  });
}

/** Keep log event names that look like code identifiers; bucket the rest. */
export function safeEventName(value){
  const text=String(value??'').trim();
  if(!text||text.length>48||!EVENT_NAME_PATTERN.test(text)||/\d{6,}/.test(text)) return 'other';
  if(text.split(/[_.:-]/).some(segment=>segment.length>20)) return 'other';
  return text.toLowerCase();
}

export function safeLogSource(value){
  const source=String(value??'').trim().toLowerCase();
  return ERROR_SOURCES.has(source)?source:'other';
}

function safeEventType(value){
  const type=String(value??'');
  return EVENT_TYPE_PATTERN.test(type)&&type.length<=100?type:'other';
}

function safeErrorCode(value){
  const code=String(value??'').trim();
  if(!code) return null;
  return ERROR_CODE_PATTERN.test(code)?code:'OTHER';
}

async function settle(read){
  try{ return {ok:true,value:await read()}; }
  catch{ return {ok:false,value:null}; }
}

async function databaseNow(db){
  const result=await db.execute(`SELECT strftime('%Y-%m-%dT%H:%M:%fZ','now') AS now_utc`);
  const now=parseDiagnosticsInstant(result?.rows?.[0]?.now_utc);
  if(now===null) throw new Error('diagnostics clock unavailable');
  return now;
}

/**
 * Authorize a verified session payload as a global administrator. Returns
 * `{ok:true,userId}` or `{ok:false,status}` (401 malformed identity, 403 not a
 * global administrator). Database errors propagate to the caller.
 */
export async function authorizeGlobalAdmin(db,payload,{env=process.env}={}){
  const userId=Number(payload?.id??payload?.uid);
  if(!Number.isSafeInteger(userId)||userId<1) return Object.freeze({ok:false,status:401});
  const membershipRequired=env?.CIRCLE_MEMBERSHIP_ENABLED==='true';
  const active=membershipRequired
    ?`CASE WHEN EXISTS (SELECT 1 FROM circle_memberships membership
        JOIN circles circle ON circle.id=membership.circle_id
        WHERE membership.user_id=account.id AND membership.status='active'
          AND circle.archived_at IS NULL) THEN 1 ELSE 0 END`
    :'1';
  const result=await db.execute({
    sql:`SELECT account.id,account.is_admin,account.is_demo,${active} AS active_account
      FROM auth_accounts account WHERE account.id=? LIMIT 2`,
    args:[userId],
  });
  const rows=result?.rows||[];
  const row=rows[0];
  const allowed=rows.length===1&&Number(row.id)===userId&&Number(row.is_admin)===1
    &&Number(row.is_demo||0)!==1&&Number(row.active_account)===1;
  return Object.freeze(allowed?{ok:true,userId}:{ok:false,status:403});
}

// ---------------------------------------------------------------------------
// Outbox
// ---------------------------------------------------------------------------

function emptyType(eventType){
  return {eventType,queued:0,due:0,leased:0,staleLeases:0,retrying:0,delivered:0,suppressed:0,
    deadLetter:0,deadLetter24h:0,oldestDueAgeMs:null};
}

export function outboxCardStatus(health){
  if(health.oldestDueAgeMs!==null&&health.oldestDueAgeMs>OUTBOX_DELIVERY_MAX_AGE_MS){
    return {status:'failed',category:'delivery_stale'};
  }
  if(health.oldestStaleLeaseAgeMs!==null&&health.oldestStaleLeaseAgeMs>OUTBOX_DELIVERY_MAX_AGE_MS){
    return {status:'failed',category:'lease_stale'};
  }
  if(health.deadLetterCount>0) return {status:'degraded',category:'dead_letters_recent'};
  if(health.dueCount+health.processingStaleCount>0) return {status:'degraded',category:'delivery_backlog'};
  return {status:'healthy',category:null};
}

async function readOutboxByType(db,nowMs){
  const now=new Date(nowMs).toISOString();
  const floor=new Date(nowMs-DAY).toISOString();
  const result=await db.execute({
    sql:`SELECT event_type,
        SUM(CASE WHEN status IN ('pending','retry') AND not_before<=? AND next_attempt_at<=? THEN 1 ELSE 0 END) AS due_count,
        MIN(CASE WHEN status IN ('pending','retry') AND not_before<=? AND next_attempt_at<=?
          THEN MAX(not_before,next_attempt_at) END) AS oldest_due_at,
        SUM(CASE WHEN status='processing' AND leased_until<=? THEN 1 ELSE 0 END) AS stale_lease_count,
        SUM(CASE WHEN status='dead_letter' AND dead_lettered_at>=? THEN 1 ELSE 0 END) AS dead_letter_recent
      FROM outbox_events
      WHERE status IN ('pending','retry','processing','dead_letter')
      GROUP BY event_type ORDER BY event_type LIMIT ?`,
    args:[now,now,now,now,now,floor,OUTBOX_TYPE_LIMIT],
  });
  return result?.rows||[];
}

async function readDispatchEvidence(db){
  // logServerOps writes these rows without a user id; browser-posted log rows
  // always carry the poster's id, so they cannot forge dispatcher evidence.
  const result=await db.execute(`SELECT created_at FROM app_logs
    WHERE event='outbox_invocation' AND source='server' AND user_id IS NULL
    ORDER BY created_at DESC LIMIT 1`);
  return parseDiagnosticsInstant(result?.rows?.[0]?.created_at);
}

async function readOutboxCard(db,nowMs){
  const [metrics,health,byType,dispatch]=await Promise.all([
    readOutboxMetrics(db),
    readOutboxDeliveryHealth(db),
    readOutboxByType(db,nowMs),
    readDispatchEvidence(db),
  ]);
  const types=new Map();
  const ensure=eventType=>{
    const key=safeEventType(eventType);
    if(!types.has(key)) types.set(key,emptyType(key));
    return types.get(key);
  };
  for(const metric of metrics){
    const target=ensure(metric.eventType);
    const total=count(metric.count);
    if(metric.status==='pending') target.queued+=total;
    else if(metric.status==='retry'){ target.queued+=total; target.retrying+=total; }
    else if(metric.status==='processing') target.leased+=total;
    else if(metric.status==='delivered') target.delivered+=total;
    else if(metric.status==='suppressed') target.suppressed+=total;
    else if(metric.status==='dead_letter') target.deadLetter+=total;
  }
  for(const row of byType){
    const target=ensure(row.event_type);
    target.due+=count(row.due_count);
    target.staleLeases+=count(row.stale_lease_count);
    target.deadLetter24h+=count(row.dead_letter_recent);
    const oldest=parseDiagnosticsInstant(row.oldest_due_at);
    if(oldest!==null){
      const age=Math.max(0,nowMs-oldest);
      target.oldestDueAgeMs=target.oldestDueAgeMs===null?age:Math.max(target.oldestDueAgeMs,age);
    }
  }
  const list=[...types.values()].sort((left,right)=>left.eventType.localeCompare(right.eventType))
    .map(item=>Object.freeze(item));
  const totals=list.reduce((sum,item)=>({
    queued:sum.queued+item.queued,leased:sum.leased+item.leased,deadLetter:sum.deadLetter+item.deadLetter,
  }),{queued:0,leased:0,deadLetter:0});
  const verdict=outboxCardStatus(health);
  return Object.freeze({
    ...verdict,
    thresholdMs:OUTBOX_DELIVERY_MAX_AGE_MS,
    evidence:evidence(nowMs,dispatch,OUTBOX_DISPATCH_EVIDENCE_MAX_AGE_MS),
    totals:Object.freeze({
      ...totals,
      due:health.dueCount,
      staleLeases:health.processingStaleCount,
      deadLetter24h:health.deadLetterCount,
      oldestDueAgeMs:health.oldestDueAgeMs,
      oldestStaleLeaseAgeMs:health.oldestStaleLeaseAgeMs,
      lastDeliveredAt:health.lastDeliveredAt,
    }),
    byType:Object.freeze(list),
    recentRejectReasons:health.recentRejectReasons,
  });
}

async function readDeadLetters(db,nowMs){
  const [rows,total]=await Promise.all([
    db.execute({
      sql:`SELECT event.id,event.event_type,event.event_version,event.last_error_code,
          event.attempt_count,event.replay_count,event.dead_lettered_at,
          (SELECT audit.reason_code FROM outbox_audit_events audit
            WHERE audit.outbox_event_id=event.id AND audit.action='dead_lettered'
            ORDER BY audit.id DESC LIMIT 1) AS reason_code
        FROM outbox_events event
        WHERE event.status='dead_letter'
        ORDER BY event.dead_lettered_at DESC,event.id DESC LIMIT ?`,
      args:[DEAD_LETTER_LIST_LIMIT],
    }),
    db.execute(`SELECT COUNT(*) AS total FROM outbox_events WHERE status='dead_letter'`),
  ]);
  const items=(rows?.rows||[]).map(row=>{
    const id=Number(row.id);
    if(!Number.isSafeInteger(id)||id<1) return null;
    const deadLetteredAt=parseDiagnosticsInstant(row.dead_lettered_at);
    return Object.freeze({
      id,
      eventType:safeEventType(row.event_type),
      eventVersion:count(row.event_version),
      errorCode:safeErrorCode(row.last_error_code),
      providerReason:parseEmailProviderReason(row.reason_code)?.reason??null,
      attempts:count(row.attempt_count),
      replays:count(row.replay_count),
      deadLetteredAt:isoOrNull(deadLetteredAt),
      ageMs:deadLetteredAt===null?null:Math.max(0,nowMs-deadLetteredAt),
    });
  }).filter(Boolean);
  const totalCount=count(total?.rows?.[0]?.total);
  return Object.freeze({
    status:totalCount>0?'degraded':'healthy',
    total:totalCount,
    limit:DEAD_LETTER_LIST_LIMIT,
    items:Object.freeze(items),
    replayReasonCodes:OUTBOX_REPLAY_REASON_CODES,
    evidence:evidence(nowMs,nowMs,DIAGNOSTICS_SNAPSHOT_MAX_AGE_MS),
  });
}

// ---------------------------------------------------------------------------
// Execution
// ---------------------------------------------------------------------------

export function executionConfiguration(env=process.env){
  const resolved=resolveExecutionProvider(env);
  let reason=null;
  if(!resolved.provider) reason=String(env?.EXECUTION_PROVIDER||'').trim()?'unsupported':'not_set';
  else if(!resolved.configured) reason='misconfigured';
  return Object.freeze({provider:resolved.provider,configured:resolved.configured===true,reason});
}

async function readExecutionCard(db,nowMs,env){
  const configuration=executionConfiguration(env);
  const names=Object.keys(EXECUTION_EVENTS);
  const placeholders=names.map(()=>'?').join(',');
  const [recent,latest]=await Promise.all([
    db.execute({
      sql:`SELECT event,COUNT(*) AS count FROM app_logs
        WHERE source='runner' AND event IN (${placeholders}) AND created_at>=datetime('now','-1 day')
        GROUP BY event`,
      args:names,
    }),
    db.execute({
      sql:`SELECT event,created_at FROM app_logs
        WHERE source='runner' AND event IN (${placeholders})
        ORDER BY created_at DESC,id DESC LIMIT 1`,
      args:names,
    }),
  ]);
  const recent24h={success:0,failed:0,unavailable:0};
  for(const row of recent?.rows||[]){
    const outcome=EXECUTION_EVENTS[String(row.event)];
    if(outcome) recent24h[outcome]+=count(row.count);
  }
  const latestRow=latest?.rows?.[0];
  const lastOutcome=latestRow?EXECUTION_EVENTS[String(latestRow.event)]??null:null;
  const latestAt=latestRow?parseDiagnosticsInstant(latestRow.created_at):null;
  let status='healthy';
  let category=null;
  if(!configuration.configured){ status='failed'; category=configuration.reason; }
  else if(lastOutcome==='failed'||lastOutcome==='unavailable'){ status='degraded'; category=`last_run_${lastOutcome}`; }
  else if(!lastOutcome){ status='unknown'; category='no_runs'; }
  return Object.freeze({
    status,
    category,
    ...configuration,
    recent24h:Object.freeze(recent24h),
    lastOutcome,
    evidence:evidence(nowMs,latestAt,EXECUTION_EVIDENCE_MAX_AGE_MS),
    // Seam for #249: the scheduled provider smoke check will report here.
    smoke:Object.freeze({status:'deferred',issue:249,reason:'smoke_check_not_built'}),
  });
}

// ---------------------------------------------------------------------------
// Readiness and the migration ledger
// ---------------------------------------------------------------------------

async function defaultReadiness(db,env){
  const configuration=databaseReadinessConfiguration(env);
  if(!configuration||!readinessTargetExists(configuration)) return {ready:false,reason:'unconfigured'};
  try{
    const ready=await coalescedDatabaseReadiness(configuration.cacheKey,db,{
      membershipRequired:configuration.membershipRequired,
    });
    return {ready:ready===true,reason:ready===true?null:'not_ready'};
  }catch{
    return {ready:false,reason:'check_failed'};
  }
}

export async function readMigrationLedgerSummary(db){
  if(!await migrationLedgerExists(db)){
    return Object.freeze({state:'missing',currentVersion:0,expectedVersion:LATEST_MIGRATION_VERSION,
      appliedCount:0,latest:null,recent:Object.freeze([])});
  }
  const rows=await readMigrationLedger(db,{limit:Math.min(1000,MIGRATION_CONTRACTS.length+1)});
  const rawVersions=rows.map(row=>Number(row.version)).filter(Number.isSafeInteger);
  const rawCurrent=rawVersions.length?Math.max(...rawVersions):0;
  let state;
  let normalized=null;
  try{
    normalized=validateMigrationLedger(rows,MIGRATION_CONTRACTS);
    state=normalized.currentVersion===LATEST_MIGRATION_VERSION?'current':'behind';
  }catch(error){
    state=Number.isSafeInteger(error?.details?.databaseVersion)?'ahead':'invalid';
  }
  const recent=(normalized?.rows||[]).slice(-LEDGER_RECENT_LIMIT).reverse().map(row=>Object.freeze({
    version:row.version,name:row.name,appliedAt:isoOrNull(parseDiagnosticsInstant(row.appliedAt)),
    disposition:row.disposition,
  }));
  return Object.freeze({
    state,
    currentVersion:normalized?normalized.currentVersion:rawCurrent,
    expectedVersion:LATEST_MIGRATION_VERSION,
    appliedCount:rows.length,
    latest:recent[0]||null,
    recent:Object.freeze(recent),
  });
}

async function readReadinessCard(db,nowMs,{env,checkReadiness}){
  const [readiness,ledger]=await Promise.all([
    checkReadiness(db,env),
    readMigrationLedgerSummary(db),
  ]);
  let status='healthy';
  let category=null;
  if(ledger.state!=='current'){ status='failed'; category=`ledger_${ledger.state}`; }
  else if(!readiness.ready){ status='failed'; category=readiness.reason||'not_ready'; }
  return Object.freeze({
    status,
    category,
    ready:readiness.ready===true,
    ledger,
    evidence:evidence(nowMs,nowMs,DIAGNOSTICS_SNAPSHOT_MAX_AGE_MS),
  });
}

// ---------------------------------------------------------------------------
// Recent errors from app_logs
// ---------------------------------------------------------------------------

export function summarizeErrorRows(rows,{limit=ERROR_CATEGORY_LIMIT}={}){
  const totals={error:0,warn:0};
  const bySource={server:{error:0,warn:0},client:{error:0,warn:0},runner:{error:0,warn:0},other:{error:0,warn:0}};
  const categories=new Map();
  for(const row of rows||[]){
    const level=String(row.level||'').toLowerCase();
    if(level!=='error'&&level!=='warn') continue;
    const total=count(row.count);
    if(!total) continue;
    const source=safeLogSource(row.source);
    const event=safeEventName(row.event);
    totals[level]+=total;
    bySource[source][level]+=total;
    const key=`${source}\u0000${event}\u0000${level}`;
    const current=categories.get(key)||{source,event,level,count:0,lastAt:null};
    current.count+=total;
    const last=parseDiagnosticsInstant(row.last_at);
    if(last!==null&&(current.lastAt===null||last>current.lastAt)) current.lastAt=last;
    categories.set(key,current);
  }
  const ordered=[...categories.values()].sort((left,right)=>right.count-left.count
    ||(right.lastAt??0)-(left.lastAt??0)
    ||`${left.source}${left.event}${left.level}`.localeCompare(`${right.source}${right.event}${right.level}`));
  const kept=ordered.slice(0,limit).map(item=>Object.freeze({...item,lastAt:isoOrNull(item.lastAt)}));
  const remainder=ordered.slice(limit).reduce((sum,item)=>sum+item.count,0);
  return Object.freeze({
    totals:Object.freeze(totals),
    bySource:Object.freeze(Object.fromEntries(Object.entries(bySource)
      .map(([source,levels])=>[source,Object.freeze(levels)]))),
    categories:Object.freeze(kept),
    otherCount:remainder,
  });
}

async function readErrorsCard(db,nowMs){
  const [grouped,newest]=await Promise.all([
    db.execute(`SELECT source,event,level,COUNT(*) AS count,MAX(created_at) AS last_at
      FROM app_logs
      WHERE level IN ('error','warn') AND created_at>=datetime('now','-1 day')
      GROUP BY source,event,level ORDER BY count DESC LIMIT 500`),
    // Freshness comes from server-written rows only (no user id): a member's
    // browser can post client rows at will and must not keep this fresh.
    db.execute(`SELECT created_at FROM app_logs WHERE user_id IS NULL ORDER BY created_at DESC LIMIT 1`),
  ]);
  const summary=summarizeErrorRows(grouped?.rows||[]);
  const status=summary.totals.error>0?'degraded':'healthy';
  return Object.freeze({
    status,
    category:summary.totals.error>0?'errors_recent':null,
    windowMs:ERROR_WINDOW_MS,
    ...summary,
    evidence:evidence(nowMs,parseDiagnosticsInstant(newest?.rows?.[0]?.created_at),LOG_EVIDENCE_MAX_AGE_MS),
  });
}

// ---------------------------------------------------------------------------
// Watchdogs (deferred: their results are GitHub Actions artifacts only)
// ---------------------------------------------------------------------------

export const WATCHDOG_CARDS=Object.freeze({
  outboxWatchdog:Object.freeze({
    status:'deferred',
    category:'github_actions_artifact_only',
    cadenceMs:OUTBOX_WATCHDOG_CADENCE_MS,
    liveEquivalent:'outbox',
    evidence:null,
  }),
  backupWatchdog:Object.freeze({
    status:'deferred',
    category:'github_actions_artifact_only',
    cadenceMs:BACKUP_WATCHDOG_CADENCE_MS,
    liveEquivalent:'readiness',
    evidence:null,
  }),
});

function unavailable(maxAgeMs){
  return Object.freeze({status:'unavailable',category:'read_failed',evidence:Object.freeze({
    at:null,ageMs:null,maxAgeMs,stale:true,
  })});
}

/**
 * Build the diagnostics snapshot. Each card is read independently, so one
 * failing source shows as `unavailable` instead of hiding the others. Only
 * the database clock read is fatal.
 */
export async function readAdminDiagnostics(db,{env=process.env,checkReadiness=defaultReadiness}={}){
  if(!db||typeof db.execute!=='function') throw new TypeError('database client required');
  const nowMs=await databaseNow(db);
  const [outbox,deadLetters,execution,readiness,errors]=await Promise.all([
    settle(()=>readOutboxCard(db,nowMs)),
    settle(()=>readDeadLetters(db,nowMs)),
    settle(()=>readExecutionCard(db,nowMs,env)),
    settle(()=>readReadinessCard(db,nowMs,{env,checkReadiness})),
    settle(()=>readErrorsCard(db,nowMs)),
  ]);
  return Object.freeze({
    ok:true,
    format:ADMIN_DIAGNOSTICS_FORMAT,
    checkedAt:new Date(nowMs).toISOString(),
    refreshAfterMs:DIAGNOSTICS_SNAPSHOT_MAX_AGE_MS,
    cards:Object.freeze({
      outbox:outbox.ok?outbox.value:unavailable(OUTBOX_DISPATCH_EVIDENCE_MAX_AGE_MS),
      deadLetters:deadLetters.ok?deadLetters.value:unavailable(DIAGNOSTICS_SNAPSHOT_MAX_AGE_MS),
      outboxWatchdog:WATCHDOG_CARDS.outboxWatchdog,
      backupWatchdog:WATCHDOG_CARDS.backupWatchdog,
      execution:execution.ok?execution.value:unavailable(EXECUTION_EVIDENCE_MAX_AGE_MS),
      readiness:readiness.ok?readiness.value:unavailable(DIAGNOSTICS_SNAPSHOT_MAX_AGE_MS),
      errors:errors.ok?errors.value:unavailable(LOG_EVIDENCE_MAX_AGE_MS),
    }),
  });
}

/**
 * GET /api/admin/diagnostics. Dependencies are injected by api/ops.js so the
 * session check and database client stay the shared production ones.
 */
export async function handleAdminDiagnosticsRequest(req,res,{
  verifyRequestAuth,getClient,env=process.env,read=readAdminDiagnostics,
  notFound=()=>res.status(404).json({ok:false,error:'not found'}),
}){
  // Flag off: no session or database access, and no headers of its own.
  // api/ops.js passes its unknown-endpoint response as `notFound`, so the
  // route cannot be told apart from one that does not exist.
  if(!adminDiagnosticsEnabled(env)) return notFound();
  res.setHeader('Cache-Control','no-store');
  if(req.method!=='GET'){
    res.setHeader('Allow','GET');
    return res.status(405).json({ok:false,error:'GET only'});
  }
  let payload;
  try{ payload=await verifyRequestAuth(req); }
  catch{ return res.status(503).json({ok:false,error:'diagnostics unavailable'}); }
  if(!payload) return res.status(401).json({ok:false,error:'authentication required'});
  let db;
  let access;
  try{
    db=getClient();
    access=await authorizeGlobalAdmin(db,payload,{env});
  }catch{
    return res.status(503).json({ok:false,error:'diagnostics unavailable'});
  }
  if(!access.ok){
    return res.status(access.status).json(access.status===401
      ?{ok:false,error:'authentication required'}
      :{ok:false,error:'global admin required'});
  }
  try{ return res.json(await read(db,{env})); }
  catch{ return res.status(503).json({ok:false,error:'diagnostics unavailable'}); }
}
