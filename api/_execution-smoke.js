// Live post-deploy smoke check for the configured code-execution provider
// (issue #249, extended by #466). It runs one fixed trivial program per
// enabled provider-supported language (JS/Python always) through the same
// boundary production uses and reports only bounded status categories.
// Existing atomic claim/windows are unchanged: 2 default runs, 3 on Vercel
// with TypeScript, up to 4 on Piston with both additions. Paired measurement
// doubles only JS/Python (4), plus one ordinary TypeScript run (5 total).
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
import { ExecutionBusyError, executionQueueConfiguration, recordExecutionRefusal } from './_execution-queue.js';
import { sanitizeStartupPair, warmMeasurementEnabled, warmMeasurementCohort, readStartupMeasurement } from './_execution-measurement.js';
import { availableExecutionLanguages } from './_execution-languages.js';

export const EXECUTION_SMOKE_LANGUAGES=Object.freeze(['javascript','python']);
export const EXECUTION_SMOKE_STATUSES=Object.freeze(['ok','busy','provider_error','timeout','misconfigured','throttled']);
// `lastStatus` of a throttled language: a recorded status, `result_missing`,
// or null while the latest run is still inside the result grace.
export const EXECUTION_SMOKE_LAST_STATUSES=Object.freeze(['ok','busy','provider_error','timeout','misconfigured',
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
export const EXECUTION_SMOKE_ADDITIONAL_PROGRAMS=Object.freeze({
  typescript:"const value: number=6*7; console.log('randori-smoke-'+value);\n",
  go:'package main\nimport "fmt"\nfunc main(){fmt.Println("randori-smoke-42")}\n',
});
const ALL_SMOKE_LANGUAGES=Object.freeze([...EXECUTION_SMOKE_LANGUAGES,'typescript','go']);

// `runner` is the server-side execution coordination namespace: api/data.js
// rewrites browser telemetry that names it to `client`, so an authenticated
// member cannot forge a claim or a cached result.
const LOG_SOURCE='runner';
const CLAIM_EVENT='execution_smoke_claim';
const RESULT_EVENT='execution_smoke_result';
const RECORDED_STATUSES=new Set(['ok','busy','provider_error','timeout','misconfigured']);
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
    if(current instanceof ExecutionBusyError){
      if(['configuration','configuration_changed','primary_circle','state','request_cost'].includes(current.reason))return 'misconfigured';
      // Infrastructure/store failure is not ordinary capacity contention. It
      // must fail the smoke even when no provider dispatch was attempted.
      return ['queued','capacity','queue_full','queue_expired','already_running','pending_run','quota','lease_expired'].includes(current.reason)?'busy':'provider_error';
    }
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
  if(entry.status==='ok'||entry.status==='busy') return true;
  return entry.status==='throttled'&&(entry.lastStatus===null||entry.lastStatus==='ok'||entry.lastStatus==='busy');
}

function allPass(languages){
  return EXECUTION_SMOKE_LANGUAGES.every(language=>executionSmokeLanguagePasses(languages[language]))
    && Object.keys(languages).every(language=>ALL_SMOKE_LANGUAGES.includes(language)&&executionSmokeLanguagePasses(languages[language]));
}

// With the admission queue on, every smoke language shares the single `ops`
// circle, whose concurrency (EXECUTION_CIRCLE_CONCURRENCY, default 2) is lower
// than the number of advertised languages once TypeScript is enabled. Running
// them all at once queued the third behind the other two until it timed out as
// `busy`, so one language was never verified. Run at most the ops circle's
// concurrency at a time (worst case 3 x 90 s < the 300 s function limit).
export function smokeConcurrency(env,count){
  let config=null;
  try{ config=executionQueueConfiguration(env); }
  catch(error){
    // An invalid queue configuration makes admission refuse at once, so one at
    // a time costs nothing; anything else is a real bug and must surface.
    if(!(error instanceof ExecutionBusyError)) throw error;
    return 1;
  }
  if(!config) return Math.max(1,count);
  return Math.max(1,Math.min(count,config.CIRCLE_CONCURRENCY));
}

// The whole smoke must finish inside the 300 s Fluid function limit with a
// reserve for cold start and sandbox setup; a language that would start after
// the budget is reported as a timeout instead of risking a 504.
export const EXECUTION_SMOKE_TOTAL_BUDGET_MS=240_000;

// Runs every item, at most `limit` at a time, preserving input order. A thrown
// item does not abandon the others; the first error is rethrown at the end.
export async function runLimited(items,limit,run){
  const results=new Array(items.length);
  let next=0, failure=null, failed=false;
  async function worker(){
    while(next<items.length){
      const index=next++;
      try{ results[index]=await run(items[index],index); }
      catch(error){ if(!failed){ failed=true; failure=error; } }
    }
  }
  await Promise.all(Array.from({length:Math.max(1,Math.min(limit,items.length))},()=>worker()));
  if(failed) throw failure;
  return results;
}

async function smokeLanguage(language,{env,execute,monotonic,setTimer,clearTimer,deadlineMs,db,totalRemainingMs}){
  const started=monotonic();
  let status, startup=null, expired=false;
  let timer;
  const measurement=warmMeasurementEnabled(env)&&EXECUTION_SMOKE_LANGUAGES.includes(language);
  try{
    const attempt=Promise.resolve().then(async()=>{
      const options=env.EXECUTION_QUEUE_ENABLED==='true'
        ?{env,db,executionContext:{ops:true,lane:`smoke-${language}`,operation:`smoke:${language}`}}:{env};
      const request={language,source:EXECUTION_SMOKE_PROGRAMS[language]||EXECUTION_SMOKE_ADDITIONAL_PROGRAMS[language]};
      if(!measurement) return classifyExecutionResult(await execute(request,options));
      const cold=await execute(request,{...options,cold:true});
      if(classifyExecutionResult(cold)!=='ok') return classifyExecutionResult(cold);
      if(expired) return 'timeout';
      const warm=await execute(request,options);
      if(cold.startup?.mode==='cold'&&warm.startup?.mode==='snapshot'){
        startup=sanitizeStartupPair({coldMs:cold.startup.createMs,snapshotMs:warm.startup.createMs});
      }
      return startup?classifyExecutionResult(warm):'provider_error';
    }).catch(classifyExecutionError);
    const deadline=new Promise(resolve=>{ timer=setTimer(()=>{expired=true;resolve('timeout');},measurement?Math.min(Math.max(90000,deadlineMs),totalRemainingMs??Infinity):deadlineMs); });
    status=await Promise.race([attempt,deadline]);
  }catch{
    status='provider_error';
  }finally{
    try{ clearTimer(timer); }catch{}
  }
  return {status,durationMs:elapsed(started,monotonic()),...(measurement?{startup:status==='ok'?startup:null}:{})};
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
export async function recordExecutionSmoke(db,claimId,languages,{cohort=null}={}){
  try{
    await db.execute({
      sql:`INSERT INTO app_logs (level, source, event, message, meta_json, user_id, route, ua, ip, created_at)
        VALUES (?,?,?,?,?,NULL,NULL,NULL,NULL,datetime('now'))`,
      args:[allPass(languages)?'info':'warn',LOG_SOURCE,RESULT_EVENT,String(claimId),JSON.stringify(cohort?{...languages,_warmCohort:cohort}:languages)],
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
  return Object.fromEntries(ALL_SMOKE_LANGUAGES.filter(language=>EXECUTION_SMOKE_LANGUAGES.includes(language)||Object.hasOwn(value,language)).map(language=>{
    const entry=record(value[language]);
    return [language,entry&&RECORDED_STATUSES.has(entry.status)
      ?{status:entry.status,durationMs:boundedDuration(entry.durationMs),...(Object.hasOwn(entry,'startup')?{startup:sanitizeStartupPair(entry.startup)}:{})}:null];
  }));
}

const LOOKBACK_PATTERN=/^-[1-9]\d{0,3} (?:minute|hour|day)s?$/;

/**
 * Read the latest claim inside `lookback` (default: the last day, the longest
 * trigger window) and the result saved for that exact claim, with
 * database-clock ages. Returns null when there is no claim. Rejects on
 * database errors so the caller can fail closed. Admin diagnostics (#343)
 * reads with a longer lookback so a check that stopped running shows as stale.
 */
export async function readLatestExecutionSmoke(db,{lookback=EXECUTION_SMOKE_CLAIM_LOOKBACK}={}){
  if(typeof lookback!=='string'||!LOOKBACK_PATTERN.test(lookback)) throw new TypeError('invalid smoke lookback');
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
    args:[CLAIM_EVENT,LOG_SOURCE,lookback,RESULT_EVENT,LOG_SOURCE],
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
export function throttledExecutionSmokeBody(latest, { languageNames = EXECUTION_SMOKE_LANGUAGES } = {}) {
  const inFlight=Boolean(latest)&&!latest.saved&&latest.claimAgeSeconds!==null
    &&latest.claimAgeSeconds<=EXECUTION_SMOKE_RESULT_GRACE_SECONDS;
  const languages={};
  for(const language of languageNames){
    const last=latest&&latest.saved?latest.languages[language]:null;
    languages[language]={status:'throttled',durationMs:last?last.durationMs:null,
      lastStatus:last?last.status:(inFlight&&EXECUTION_SMOKE_LANGUAGES.includes(language)?null:'result_missing')};
  }
  return {ok:allPass(languages),checkedAt:latest?latest.checkedAt:null,
    ageSeconds:latest?latest.claimAgeSeconds:null,languages};
}

/**
 * Per-language outcome of the latest run for read-only reports (admin
 * diagnostics, #343). It is the throttled body's `lastStatus` and
 * `durationMs`, so the rules stay identical: a recorded status from the result
 * saved for the latest claim, `result_missing` for an unreadable entry or once
 * an unsaved claim is past the result grace (or with no claim at all), and
 * `pending` where the throttled body has null (still inside the grace).
 */
export function latestExecutionSmokeLanguages(latest){
  const languageNames = availableExecutionLanguages();
  const {languages}=throttledExecutionSmokeBody(latest, { languageNames });
  return Object.fromEntries(languageNames.map(language=>[language,{
    status:languages[language].lastStatus??'pending',durationMs:languages[language].durationMs,
  }]));
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
    const languageNames = availableExecutionLanguages(env);
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
    let cohort;
    try{cohort=warmMeasurementCohort(env);}catch{
      await recordExecutionRefusal(db,'configuration');
      return {status:200,body:{ok:false,checkedAt:isoNow(clock),languages:Object.fromEntries(
        languageNames.map(language=>[language,{status:'misconfigured',durationMs:null}]))}};
    }
    if(!claimId) return {status:200,body:{...throttledExecutionSmokeBody(latest,{languageNames}),
      ...(cohort?{coldStart:await readStartupMeasurement(db,env)}:{})}};
    const options={env,execute,monotonic,setTimer,clearTimer,deadlineMs,db};
    // Pair only JS/Python for the existing cohort; additions each spend one run.
    const limit=smokeConcurrency(env,languageNames.length);
    const startedAt=monotonic();
    // The first wave always starts at once, exactly as before; only languages
    // that wait for a free slot are held to the total budget.
    const entries=await runLimited(languageNames,limit,(language,index)=>{
      if(index<limit) return smokeLanguage(language,options);
      const spent=monotonic()-startedAt;
      const remaining=Number.isFinite(spent)?EXECUTION_SMOKE_TOTAL_BUDGET_MS-spent:0;
      if(remaining<=0) return {status:'timeout',durationMs:0};
      return smokeLanguage(language,{...options,deadlineMs:Math.min(deadlineMs,remaining),totalRemainingMs:remaining});
    });
    const languages=Object.fromEntries(languageNames.map((language,index)=>[language,entries[index]]));
    await recordExecutionSmoke(db,claimId,languages,{cohort});
    return {status:200,body:{ok:allPass(languages),checkedAt:isoNow(clock),languages,
      ...(cohort?{coldStart:await readStartupMeasurement(db,env)}:{})}};
  }catch{
    return UNAVAILABLE;
  }
}
