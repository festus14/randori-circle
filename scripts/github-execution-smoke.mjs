#!/usr/bin/env node
// Assessor for the execution-smoke workflow (issue #249).
//
// It sends one authenticated POST to /api/cron/execution-smoke on APP_URL with
// {"trigger": EXECUTION_SMOKE_TRIGGER} ("schedule" or "deploy") and fails
// unless every language reports `ok`, or `throttled` with a cached result that
// was `ok` (or a run still inside its result grace). A pass on a cached result
// adds a ::notice, because that run did not test the current deployment. It
// prints one JSON line built only from validated, bounded categories: never the
// response body, the URL, or the secret. Exit codes: 0 healthy, 1 alert.
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

export const EXECUTION_SMOKE_FORMAT='randori.execution-smoke.v1';
export const EXECUTION_SMOKE_PATH='/api/cron/execution-smoke';
const LANGUAGES=Object.freeze(['javascript','python']);
const STATUSES=new Set(['ok','provider_error','timeout','misconfigured','throttled']);
const LAST_STATUSES=new Set(['ok','provider_error','timeout','misconfigured','result_missing']);
const TRIGGERS=new Set(['schedule','deploy']);
const MAX_RESPONSE_BYTES=64*1024;
const MAX_TIMEOUT_MS=110_000;
const MAX_DURATION_MS=10*60*1000;
const MAX_AGE_SECONDS=2*24*60*60;

class MalformedResponseError extends Error{}

function record(value){
  return value&&typeof value==='object'&&!Array.isArray(value)?value:null;
}

function nullableInteger(value,maximum){
  return value===null||(Number.isSafeInteger(value)&&value>=0&&value<=maximum);
}

function timestamp(value){
  return value===null||(typeof value==='string'
    &&/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(value)&&Number.isFinite(Date.parse(value)));
}

function timeoutMs(value){
  const parsed=typeof value==='string'&&/^[1-9][0-9]*$/.test(value)?Number(value):NaN;
  if(!Number.isSafeInteger(parsed)||parsed>MAX_TIMEOUT_MS) throw new TypeError('execution smoke timeout is invalid');
  return parsed;
}

function smokeTrigger(value){
  if(typeof value!=='string'||!TRIGGERS.has(value)) throw new TypeError('execution smoke trigger is invalid');
  return value;
}

function languagePasses(entry){
  return entry.status==='ok'||(entry.status==='throttled'&&(entry.lastStatus===null||entry.lastStatus==='ok'));
}

function parseLanguage(value){
  const entry=record(value);
  if(!entry||!STATUSES.has(entry.status)||!nullableInteger(entry.durationMs,MAX_DURATION_MS)) return null;
  if(entry.status!=='throttled') return entry.lastStatus===undefined?{status:entry.status,durationMs:entry.durationMs}:null;
  if(entry.lastStatus!==null&&!LAST_STATUSES.has(entry.lastStatus)) return null;
  return {status:entry.status,durationMs:entry.durationMs,lastStatus:entry.lastStatus};
}

/** Validate an endpoint body and decide pass/fail from bounded categories only. */
export function assessExecutionSmoke(value){
  const body=record(value);
  const languages={};
  for(const language of LANGUAGES){
    const entry=body&&record(body.languages)?parseLanguage(body.languages[language]):null;
    if(!entry) return {ok:false,category:'malformed_response',languages:null,checkedAt:null,ageSeconds:null};
    languages[language]=entry;
  }
  const throttled=LANGUAGES.some(language=>languages[language].status==='throttled');
  const ageSeconds=throttled?body.ageSeconds:undefined;
  const pass=LANGUAGES.every(language=>languagePasses(languages[language]));
  if(typeof body.ok!=='boolean'||body.ok!==pass||!timestamp(body.checkedAt)
    ||(throttled&&!nullableInteger(ageSeconds,MAX_AGE_SECONDS))
    ||(!throttled&&body.checkedAt===null)){
    return {ok:false,category:'malformed_response',languages:null,checkedAt:null,ageSeconds:null};
  }
  return {ok:pass,category:pass?null:'execution_failed',languages,checkedAt:body.checkedAt,
    ageSeconds:throttled?ageSeconds:null};
}

async function readBoundedBody(response){
  const rawLength=response.headers?.get?.('content-length');
  if(rawLength!==null&&rawLength!==undefined
    &&(!/^[0-9]+$/.test(rawLength)||Number(rawLength)>MAX_RESPONSE_BYTES)){
    throw new MalformedResponseError('execution smoke response is malformed');
  }
  const reader=response.body?.getReader?.();
  if(!reader){
    const text=await response.text();
    if(typeof text!=='string'||Buffer.byteLength(text,'utf8')>MAX_RESPONSE_BYTES){
      throw new MalformedResponseError('execution smoke response is malformed');
    }
    return text;
  }
  const chunks=[];
  let total=0;
  try{
    while(true){
      const {done,value}=await reader.read();
      if(done) break;
      if(!(value instanceof Uint8Array)) throw new MalformedResponseError('execution smoke response is malformed');
      total+=value.byteLength;
      if(total>MAX_RESPONSE_BYTES){
        try{ await reader.cancel(); }catch{}
        throw new MalformedResponseError('execution smoke response is malformed');
      }
      chunks.push(Buffer.from(value));
    }
  }finally{
    try{ reader.releaseLock(); }catch{}
  }
  return Buffer.concat(chunks,total).toString('utf8');
}

/** POST to the smoke endpoint; resolves to {body} or {category}. Never rejects for network or HTTP failures. */
export async function fetchExecutionSmoke(environment,{fetchImpl=fetch,setTimer=setTimeout,clearTimer=clearTimeout}={}){
  const appUrl=String(environment.APP_URL||'');
  const secret=String(environment.CRON_SECRET||'');
  const limit=timeoutMs(environment.EXECUTION_SMOKE_TIMEOUT_MS);
  const trigger=smokeTrigger(environment.EXECUTION_SMOKE_TRIGGER);
  if(!/^https:\/\/[^/?#\s]+\/?$/.test(appUrl)||!secret) return {category:'config_missing'};
  const controller=new AbortController();
  const timer=setTimer(()=>controller.abort(),limit);
  try{
    const response=await fetchImpl(`${appUrl.replace(/\/$/u,'')}${EXECUTION_SMOKE_PATH}`,{method:'POST',
      redirect:'error',signal:controller.signal,body:JSON.stringify({trigger}),
      headers:{accept:'application/json','content-type':'application/json',authorization:`Bearer ${secret}`}});
    if(!response||typeof response.ok!=='boolean'||typeof response.text!=='function'){
      return {category:'malformed_response'};
    }
    if(response.status===401||response.status===403) return {category:'unauthorized'};
    if(!response.ok) return {category:'unavailable'};
    const text=await readBoundedBody(response);
    try{ return {body:JSON.parse(text)}; }
    catch{ return {category:'malformed_response'}; }
  }catch(error){
    return {category:error instanceof MalformedResponseError?'malformed_response':'unavailable'};
  }finally{
    clearTimer(timer);
  }
}

function result({ok,category,languages=null,checkedAt=null,ageSeconds=null}){
  return Object.freeze({ok,kind:'execution-smoke',format:EXECUTION_SMOKE_FORMAT,
    status:ok?'healthy':'alert',alert:!ok,category,checkedAt,ageSeconds,languages});
}

function cachedNotice(outcome){
  if(!outcome.ok||!LANGUAGES.some(language=>outcome.languages[language].status==='throttled')) return '';
  const age=outcome.ageSeconds===null?'at an unknown time':`${outcome.ageSeconds} seconds ago`;
  // The age is a validated integer, so the command cannot be forged.
  return `::notice title=Execution smoke passed on a cached result::Throttled, so nothing ran. The latest real run `
    +`started ${age}; this run did not test the current deployment.\n`;
}

function annotation(outcome){
  const detail=outcome.languages
    ?LANGUAGES.map(language=>{
      const entry=outcome.languages[language];
      return `${language}=${entry.status}${entry.status==='throttled'?`(last ${entry.lastStatus??'none'})`:''}`;
    }).join(' ')
    :'no language result';
  // Every interpolated value is a validated enum, so the command cannot be forged.
  return `::error title=Execution smoke failed::Category ${outcome.category}; ${detail}. `
    +'See docs/PRODUCTION_BOOTSTRAP_GUIDE.md section 10.0.\n';
}

export async function main({argv=process.argv.slice(2),environment=process.env,stdout=process.stdout,
  fetchImpl=fetch,setTimer=setTimeout,clearTimer=clearTimeout}={}){
  let outcome;
  try{
    if(argv.length!==0) throw new TypeError('execution smoke usage is invalid');
    const fetched=await fetchExecutionSmoke(environment,{fetchImpl,setTimer,clearTimer});
    outcome=fetched.category?result({ok:false,category:fetched.category}):result(assessExecutionSmoke(fetched.body));
  }catch{
    outcome=result({ok:false,category:'smoke_failure'});
  }
  stdout.write(`${JSON.stringify(outcome)}\n`);
  const command=outcome.alert?annotation(outcome):cachedNotice(outcome);
  if(command) stdout.write(command);
  return {exitCode:outcome.alert?1:0,result:outcome};
}

const isEntryPoint=process.argv[1]&&fileURLToPath(import.meta.url)===resolve(process.argv[1]);
if(isEntryPoint){
  const execution=await main();
  process.exitCode=execution.exitCode;
}
