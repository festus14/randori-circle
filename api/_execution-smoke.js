// Live post-deploy smoke check for the configured code-execution provider
// (issue #249). It runs one fixed, trivial JavaScript program and one fixed,
// trivial Python program through the same boundary production uses
// (api/_execution.js) and reports only bounded status categories.
//
// Budget: Vercel Sandbox creations count against the Hobby allowance shared
// with real member runs, so a real execution is claimed atomically in
// app_logs against the database clock. Claims are at least 30 minutes apart,
// and each trigger has its own slot: one `schedule` claim (daily schedule or
// manual dispatch) per 20 hours and one `deploy` claim per 24 hours, so deploy
// runs can never use up the daily scheduled run. Inside a window the latest
// real run is reported as `throttled`. Its result is linked to its claim, so
// a run whose result was never saved (killed function, failed write) is
// reported as `result_missing` once it is older than the result grace.
//
// The response never contains program output, provider URLs, tokens or error
// messages, and nothing here throws: every failure maps to a category.
import { performance } from 'node:perf_hooks';
import { executeProgram, resolveExecutionProvider } from './_execution.js';

export const EXECUTION_SMOKE_LANGUAGES=Object.freeze(['javascript','python']);
export const EXECUTION_SMOKE_STATUSES=Object.freeze(['ok','provider_error','timeout','misconfigured','throttled']);
// `lastStatus` of a throttled language: a recorded status, `result_missing`,
// or null while the latest run is still inside the result grace.
export const EXECUTION_SMOKE_LAST_STATUSES=Object.freeze(['ok','provider_error','timeout','misconfigured',
  'result_missing']);
export const EXECUTION_SMOKE_MIN_INTERVAL='-30 minutes';
export const EXECUTION_SMOKE_TRIGGER_WINDOWS=Object.freeze({schedule:'-20 hours',deploy:'-1 day'});
// The latest claim is looked up over the longest trigger window.
export const EXECUTION_SMOKE_CLAIM_LOOKBACK='-1 day';
// Backstop above the provider's own deadlines (sandbox create 20 s + command
// 10 s, Piston 12 s) so a hung SDK call can never hold the request open.
export const EXECUTION_SMOKE_LANGUAGE_DEADLINE_MS=45_000;
// A claim with no saved result is "in flight" for the deadline plus 120 s;
// after that its result is treated as lost.
export const EXECUTION_SMOKE_RESULT_GRACE_SECONDS=Math.ceil(EXECUTION_SMOKE_LANGUAGE_DEADLINE_MS/1000)+120;
export const EXECUTION_SMOKE_EXPECTED_OUTPUT='randori-smoke-42';
export const EXECUTION_SMOKE_PROGRAMS=Object.freeze({
  javascript:"console.log(['randori','smoke',String(6*7)].join('-'));\n",
  python:"print('-'.join(['randori','smoke',str(6*7)]))\n",
});

// `runner` is the server-side execution coordination namespace: api/data.js
// rewrites browser telemetry that names it to `client`, so an authenticated
// member cannot forge a claim or a cached result.
const LOG_SOURCE='runner';
const CLAIM_EVENT='execution_smoke_claim';
const RESULT_EVENT='execution_smoke_result';
const RECORDED_STATUSES=new Set(['ok','provider_error','timeout','misconfigured']);
const MAX_DURATION_MS=10*60*1000;
const UNAVAILABLE=Object.freeze({status:503,body:Object.freeze({ok:false,error:'execution smoke unavailable'})});
const INVALID_REQUEST=Object.freeze({status:400,body:Object.freeze({ok:false,error:'invalid smoke request'})});

function record(value){
  return value&&typeof value==='object'&&!Array.isArray(value)?value:null;
}

function boundedDuration(value){
  return Number.isSafeInteger(value)&&value>=0&&value<=MAX_DURATION_MS?value:null;
}

function elapsed(started,finished){
  const value=Math.round(Number(finished)-Number(started));
  return Number.isFinite(value)?Math.min(MAX_DURATION_MS,Math.max(0,value)):null;
}

function isoNow(clock){
  try{
    const milliseconds=Number(clock());
    if(Number.isFinite(milliseconds)) return new Date(milliseconds).toISOString();
  }catch{}
  return null;
}

/** Accept exactly {"trigger":"schedule"|"deploy"}; anything else is null. */
export function parseExecutionSmokeRequest(body){
  const value=record(body);
  if(!value||Object.getPrototypeOf(value)!==Object.prototype) return null;
  const keys=Object.keys(value);
  if(keys.length!==1||keys[0]!=='trigger') return null;
  return typeof value.trigger==='string'&&Object.hasOwn(EXECUTION_SMOKE_TRIGGER_WINDOWS,value.trigger)
    ?value.trigger:null;
}

/** Map a thrown execution error to a category; timeouts are aborts anywhere in the cause chain. */
export function classifyExecutionError(error){
  let current=error;
  for(let depth=0;current&&depth<5;depth+=1){
    if(current.name==='AbortError'||current.name==='TimeoutError') return 'timeout';
    current=current.cause;
  }
  return 'provider_error';
}

/** Map a completed provider run to a category by checking the fixed expected output. */
export function classifyExecutionResult(run){
  if(!record(run)) return 'provider_error';
  if(run.timedOut===true) return 'timeout';
  return run.code===0&&String(run.stdout??'').trim()===EXECUTION_SMOKE_EXPECTED_OUTPUT?'ok':'provider_error';
}

/** A throttled language passes only when its cached result passed or that run is still in flight. */
export function executionSmokeLanguagePasses(entry){
  if(!record(entry)) return false;
  if(entry.status==='ok') return true;
  return entry.status==='throttled'&&(entry.lastStatus===null||entry.lastStatus==='ok');
}

function allPass(languages){
  return EXECUTION_SMOKE_LANGUAGES.every(language=>executionSmokeLanguagePasses(languages[language]));
}

async function smokeLanguage(language,{env,execute,monotonic,setTimer,clearTimer,deadlineMs}){
  const started=monotonic();
  let status;
  let timer;
  try{
    const attempt=Promise.resolve()
      .then(()=>execute({language,source:EXECUTION_SMOKE_PROGRAMS[language]},{env}))
      .then(classifyExecutionResult,classifyExecutionError);
    const deadline=new Promise(resolve=>{ timer=setTimer(()=>resolve('timeout'),deadlineMs); });
    status=await Promise.race([attempt,deadline]);
  }catch{
    status='provider_error';
  }finally{
    try{ clearTimer(timer); }catch{}
  }
  return {status,durationMs:elapsed(started,monotonic())};
}

/**
 * Atomically claim a real execution for one trigger against the database
 * clock. Returns the claim id, or null when throttled.
 */
export async function claimExecutionSmoke(db,trigger){
  if(!Object.hasOwn(EXECUTION_SMOKE_TRIGGER_WINDOWS,trigger)) throw new TypeError('unknown smoke trigger');
  const result=await db.execute({
    sql:`INSERT INTO app_logs (level, source, event, message, meta_json, user_id, route, ua, ip, created_at)
      SELECT 'info',?,?,?,NULL,NULL,NULL,NULL,NULL,datetime('now')
      WHERE NOT EXISTS (
          SELECT 1 FROM app_logs recent
          WHERE recent.event=? AND recent.source=? AND recent.user_id IS NULL
            AND recent.created_at>datetime('now',?))
        AND NOT EXISTS (
          SELECT 1 FROM app_logs slot
          WHERE slot.event=? AND slot.source=? AND slot.user_id IS NULL AND slot.message=?
            AND slot.created_at>datetime('now',?))
      RETURNING id`,
    args:[LOG_SOURCE,CLAIM_EVENT,trigger,CLAIM_EVENT,LOG_SOURCE,EXECUTION_SMOKE_MIN_INTERVAL,
      CLAIM_EVENT,LOG_SOURCE,trigger,EXECUTION_SMOKE_TRIGGER_WINDOWS[trigger]],
  });
  const id=Number(result?.rows?.[0]?.id);
  return Number.isSafeInteger(id)&&id>0?id:null;
}

/** Record a completed result (statuses and durations only), linked to its claim. Never throws. */
export async function recordExecutionSmoke(db,claimId,languages){
  try{
    await db.execute({
      sql:`INSERT INTO app_logs (level, source, event, message, meta_json, user_id, route, ua, ip, created_at)
        VALUES (?,?,?,?,?,NULL,NULL,NULL,NULL,datetime('now'))`,
      args:[allPass(languages)?'info':'warn',LOG_SOURCE,RESULT_EVENT,String(claimId),JSON.stringify(languages)],
    });
    return true;
  }catch{
    return false;
  }
}

function storedLanguages(metaJson){
  let parsed;
  try{ parsed=JSON.parse(String(metaJson)); }catch{ parsed=null; }
  const value=record(parsed)||{};
  return Object.fromEntries(EXECUTION_SMOKE_LANGUAGES.map(language=>{
    const entry=record(value[language]);
    return [language,entry&&RECORDED_STATUSES.has(entry.status)
      ?{status:entry.status,durationMs:boundedDuration(entry.durationMs)}:null];
  }));
}

/**
 * Read the latest claim of the last day and the result saved for that exact
 * claim, with database-clock ages. Returns null when there is no claim.
 * Rejects on database errors so the caller can fail closed.
 */
export async function readLatestExecutionSmoke(db){
  const result=await db.execute({
    sql:`WITH latest AS (
        SELECT id, created_at FROM app_logs
        WHERE event=? AND source=? AND user_id IS NULL AND created_at>datetime('now',?)
        ORDER BY id DESC LIMIT 1
      )
      SELECT CAST(ROUND((julianday('now')-julianday(latest.created_at))*86400) AS INTEGER) AS claim_age_seconds,
        saved.id AS result_id, saved.meta_json AS meta_json,
        strftime('%Y-%m-%dT%H:%M:%SZ',saved.created_at) AS checked_at
      FROM latest
      LEFT JOIN app_logs saved ON saved.event=? AND saved.source=? AND saved.user_id IS NULL
        AND saved.message=CAST(latest.id AS TEXT)
      ORDER BY saved.id DESC LIMIT 1`,
    args:[CLAIM_EVENT,LOG_SOURCE,EXECUTION_SMOKE_CLAIM_LOOKBACK,RESULT_EVENT,LOG_SOURCE],
  });
  const row=result?.rows?.[0];
  if(!row) return null;
  const age=Number(row.claim_age_seconds);
  const saved=row.result_id!==null&&row.result_id!==undefined;
  return {
    claimAgeSeconds:Number.isSafeInteger(age)&&age>=0?age:null,
    saved,
    checkedAt:saved&&typeof row.checked_at==='string'&&/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(row.checked_at)
      ?row.checked_at:null,
    languages:saved?storedLanguages(row.meta_json):null,
  };
}

/**
 * Build the throttled body from the latest run. A saved result reports each
 * language's recorded status (an unreadable entry is `result_missing`). With
 * no saved result the run is in flight (null) only while its claim is inside
 * the result grace; otherwise, or with no claim at all, it is `result_missing`.
 */
export function throttledExecutionSmokeBody(latest){
  const inFlight=Boolean(latest)&&!latest.saved&&latest.claimAgeSeconds!==null
    &&latest.claimAgeSeconds<=EXECUTION_SMOKE_RESULT_GRACE_SECONDS;
  const languages={};
  for(const language of EXECUTION_SMOKE_LANGUAGES){
    const last=latest&&latest.saved?latest.languages[language]:null;
    languages[language]={status:'throttled',durationMs:last?last.durationMs:null,
      lastStatus:last?last.status:(inFlight?null:'result_missing')};
  }
  return {ok:allPass(languages),checkedAt:latest?latest.checkedAt:null,
    ageSeconds:latest?latest.claimAgeSeconds:null,languages};
}

/**
 * Run the smoke check for one trigger. Resolves to {status, body}; never rejects.
 * @param {{trigger: 'schedule'|'deploy', getDb: () => any, env?: object, execute?: typeof executeProgram,
 *   clock?: () => number, monotonic?: () => number, setTimer?: typeof setTimeout,
 *   clearTimer?: typeof clearTimeout, deadlineMs?: number}} options
 */
export async function runExecutionSmoke({trigger,getDb,env=process.env,execute=executeProgram,clock=Date.now,
  monotonic=()=>performance.now(),setTimer=setTimeout,clearTimer=clearTimeout,
  deadlineMs=EXECUTION_SMOKE_LANGUAGE_DEADLINE_MS}={}){
  try{
    if(typeof trigger!=='string'||!Object.hasOwn(EXECUTION_SMOKE_TRIGGER_WINDOWS,trigger)) return INVALID_REQUEST;
    // Configuration needs no I/O and spends no quota, so a deploy that drops
    // the provider is reported immediately, even inside the throttle window.
    if(!resolveExecutionProvider(env).configured){
      return {status:200,body:{ok:false,checkedAt:isoNow(clock),languages:Object.fromEntries(
        EXECUTION_SMOKE_LANGUAGES.map(language=>[language,{status:'misconfigured',durationMs:null}]))}};
    }
    let db;
    let claimId;
    let latest;
    try{
      db=getDb();
      claimId=await claimExecutionSmoke(db,trigger);
      // Without the throttle store the budget and the cached result cannot be
      // verified: fail closed rather than report an unverified pass.
      if(!claimId) latest=await readLatestExecutionSmoke(db);
    }catch{
      return UNAVAILABLE;
    }
    if(!claimId) return {status:200,body:throttledExecutionSmokeBody(latest)};
    const options={env,execute,monotonic,setTimer,clearTimer,deadlineMs};
    const entries=await Promise.all(EXECUTION_SMOKE_LANGUAGES.map(language=>smokeLanguage(language,options)));
    const languages=Object.fromEntries(EXECUTION_SMOKE_LANGUAGES.map((language,index)=>[language,entries[index]]));
    await recordExecutionSmoke(db,claimId,languages);
    return {status:200,body:{ok:allPass(languages),checkedAt:isoNow(clock),languages}};
  }catch{
    return UNAVAILABLE;
  }
}
