// Live post-deploy smoke check for the configured code-execution provider
// (issue #249). It runs one fixed, trivial JavaScript program and one fixed,
// trivial Python program through the same boundary production uses
// (api/_execution.js) and reports only bounded status categories.
//
// Budget: Vercel Sandbox creations count against the Hobby allowance shared
// with real member runs, so a real execution is claimed atomically in
// app_logs against the database clock: at most one every 30 minutes and at
// most two in any rolling 24 hours (two sandboxes each). Inside the window the
// last recorded result is returned as `throttled` with its age.
//
// The response never contains program output, provider URLs, tokens or error
// messages, and nothing here throws: every failure maps to a category.
import { performance } from 'node:perf_hooks';
import { executeProgram, resolveExecutionProvider } from './_execution.js';

export const EXECUTION_SMOKE_LANGUAGES=Object.freeze(['javascript','python']);
export const EXECUTION_SMOKE_STATUSES=Object.freeze(['ok','provider_error','timeout','misconfigured','throttled']);
export const EXECUTION_SMOKE_MIN_INTERVAL='-30 minutes';
export const EXECUTION_SMOKE_DAILY_WINDOW='-1 day';
export const EXECUTION_SMOKE_DAILY_LIMIT=2;
// Backstop above the provider's own deadlines (sandbox create 20 s + command
// 10 s, Piston 12 s) so a hung SDK call can never hold the request open.
export const EXECUTION_SMOKE_LANGUAGE_DEADLINE_MS=45_000;
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

/** A throttled language passes only when its cached result passed or none is recorded yet. */
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

/** Atomically claim a real execution against the database clock; returns the claim id or null when throttled. */
export async function claimExecutionSmoke(db){
  const result=await db.execute({
    sql:`INSERT INTO app_logs (level, source, event, message, meta_json, user_id, route, ua, ip, created_at)
      SELECT 'info',?,?,'execution smoke claimed',NULL,NULL,NULL,NULL,NULL,datetime('now')
      WHERE NOT EXISTS (
          SELECT 1 FROM app_logs recent
          WHERE recent.event=? AND recent.source=? AND recent.user_id IS NULL
            AND recent.created_at>datetime('now',?))
        AND (SELECT COUNT(*) FROM app_logs daily
          WHERE daily.event=? AND daily.source=? AND daily.user_id IS NULL
            AND daily.created_at>datetime('now',?))<?
      RETURNING id`,
    args:[LOG_SOURCE,CLAIM_EVENT,CLAIM_EVENT,LOG_SOURCE,EXECUTION_SMOKE_MIN_INTERVAL,
      CLAIM_EVENT,LOG_SOURCE,EXECUTION_SMOKE_DAILY_WINDOW,EXECUTION_SMOKE_DAILY_LIMIT],
  });
  const id=Number(result?.rows?.[0]?.id);
  return Number.isSafeInteger(id)&&id>0?id:null;
}

/** Record a completed result (statuses and durations only). Never throws. */
export async function recordExecutionSmoke(db,languages){
  try{
    await db.execute({
      sql:`INSERT INTO app_logs (level, source, event, message, meta_json, user_id, route, ua, ip, created_at)
        VALUES (?,?,?,'execution smoke completed',?,NULL,NULL,NULL,NULL,datetime('now'))`,
      args:[allPass(languages)?'info':'warn',LOG_SOURCE,RESULT_EVENT,JSON.stringify(languages)],
    });
    return true;
  }catch{
    return false;
  }
}

function storedLanguages(metaJson){
  let parsed;
  try{ parsed=JSON.parse(String(metaJson)); }catch{ return null; }
  if(!record(parsed)) return null;
  return Object.fromEntries(EXECUTION_SMOKE_LANGUAGES.map(language=>{
    const entry=record(parsed[language]);
    return [language,entry&&RECORDED_STATUSES.has(entry.status)
      ?{status:entry.status,durationMs:boundedDuration(entry.durationMs)}:null];
  }));
}

/** Read the latest recorded result from the last 24 hours with its database-clock age. Never throws. */
export async function readLastExecutionSmoke(db){
  try{
    const result=await db.execute({
      sql:`SELECT meta_json,
          strftime('%Y-%m-%dT%H:%M:%SZ',created_at) AS checked_at,
          CAST(ROUND((julianday('now')-julianday(created_at))*86400) AS INTEGER) AS age_seconds
        FROM app_logs
        WHERE event=? AND source=? AND user_id IS NULL AND created_at>datetime('now',?)
        ORDER BY id DESC LIMIT 1`,
      args:[RESULT_EVENT,LOG_SOURCE,EXECUTION_SMOKE_DAILY_WINDOW],
    });
    const row=result?.rows?.[0];
    if(!row) return null;
    const languages=storedLanguages(row.meta_json);
    if(!languages) return null;
    const checkedAt=typeof row.checked_at==='string'&&/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(row.checked_at)
      ?row.checked_at:null;
    const age=Number(row.age_seconds);
    return {checkedAt,ageSeconds:Number.isSafeInteger(age)&&age>=0?age:null,languages};
  }catch{
    return null;
  }
}

function throttledBody(cached){
  const languages={};
  for(const language of EXECUTION_SMOKE_LANGUAGES){
    const last=cached?cached.languages[language]:null;
    languages[language]={status:'throttled',durationMs:last?last.durationMs:null,lastStatus:last?last.status:null};
  }
  return {ok:allPass(languages),checkedAt:cached?cached.checkedAt:null,
    ageSeconds:cached?cached.ageSeconds:null,languages};
}

/**
 * Run the smoke check. Resolves to {status, body}; never rejects.
 * @param {{getDb: () => any, env?: object, execute?: typeof executeProgram, clock?: () => number,
 *   monotonic?: () => number, setTimer?: typeof setTimeout, clearTimer?: typeof clearTimeout,
 *   deadlineMs?: number}} options
 */
export async function runExecutionSmoke({getDb,env=process.env,execute=executeProgram,clock=Date.now,
  monotonic=()=>performance.now(),setTimer=setTimeout,clearTimer=clearTimeout,
  deadlineMs=EXECUTION_SMOKE_LANGUAGE_DEADLINE_MS}={}){
  try{
    // Configuration needs no I/O and spends no quota, so a deploy that drops
    // the provider is reported immediately, even inside the throttle window.
    if(!resolveExecutionProvider(env).configured){
      return {status:200,body:{ok:false,checkedAt:isoNow(clock),languages:Object.fromEntries(
        EXECUTION_SMOKE_LANGUAGES.map(language=>[language,{status:'misconfigured',durationMs:null}]))}};
    }
    let db;
    let claimId;
    try{
      db=getDb();
      claimId=await claimExecutionSmoke(db);
    }catch{
      // Without the throttle store the budget cannot be enforced: fail closed.
      return UNAVAILABLE;
    }
    if(!claimId) return {status:200,body:throttledBody(await readLastExecutionSmoke(db))};
    const options={env,execute,monotonic,setTimer,clearTimer,deadlineMs};
    const entries=await Promise.all(EXECUTION_SMOKE_LANGUAGES.map(language=>smokeLanguage(language,options)));
    const languages=Object.fromEntries(EXECUTION_SMOKE_LANGUAGES.map((language,index)=>[language,entries[index]]));
    await recordExecutionSmoke(db,languages);
    return {status:200,body:{ok:allPass(languages),checkedAt:isoNow(clock),languages}};
  }catch{
    return UNAVAILABLE;
  }
}
