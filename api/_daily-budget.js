// Daily participant-minute admission (#490 / ID-106). Only aggregate counters,
// clocks and random reservation/refresh generations enter existing TTL storage.
// Provider I/O is OUTSIDE write transactions; a five-minute fenced claim makes
// refresh single-flight across instances, including failures and crashed owners.
import { randomBytes } from 'node:crypto';
import { DailyProviderError, dailyRequest, dailyMonthlyMinuteBudget, dailyVideoConfiguration } from './_daily-video.js';

export const DAILY_USAGE_MAX_AGE_SECONDS=300;
export const DAILY_USAGE_PAGE_LIMIT=100;
export const DAILY_USAGE_MAX_PAGES=20;
const PREFIX='dvb1:';
const DB_NOW="CAST(strftime('%s','now') AS INTEGER)";

function unavailable(){ return new DailyProviderError('budget',null); }
function integer(value){ return Number.isSafeInteger(value)&&value>=0; }
export function dailyBudgetMonth(nowSeconds){
  const date=new Date(nowSeconds*1000);
  const start=Date.UTC(date.getUTCFullYear(),date.getUTCMonth(),1)/1000;
  const end=Date.UTC(date.getUTCFullYear(),date.getUTCMonth()+1,1)/1000;
  if(!integer(start)||!integer(end)) throw unavailable();
  return {start,end,key:`${PREFIX}${start}`};
}

/** No room/participant identifiers escape this read. Ongoing meetings are not
 * filtered out. Daily durations are seconds; round EACH participant upwards.
 * Malformed/truncated/repeated pages fail closed, never a partial snapshot.
 */
export async function readDailyReportedMinutes(config,{month,fetchImpl=globalThis.fetch}){
  let cursor=null,minutes=0,count=0;
  const seen=new Set();
  for(let page=0;page<DAILY_USAGE_MAX_PAGES;page++){
    const query=new URLSearchParams({timeframe_start:String(month.start),timeframe_end:String(month.end),limit:String(DAILY_USAGE_PAGE_LIMIT)});
    if(cursor!==null) query.set('starting_after',cursor);
    const response=await dailyRequest(config,{method:'GET',path:`/meetings?${query}`,stage:'usage',fetchImpl});
    const {data,total_count:total}=response.payload||{};
    if(response.status!==200||!Array.isArray(data)||data.length>DAILY_USAGE_PAGE_LIMIT||!integer(total)||total<count+data.length) throw unavailable();
    for(const meeting of data){
      if(typeof meeting?.id!=='string'||!meeting.id||seen.has(meeting.id)
        ||!integer(meeting.start_time)||meeting.start_time<month.start||meeting.start_time>=month.end
        ||!Array.isArray(meeting.participants)) throw unavailable();
      seen.add(meeting.id);
      for(const participant of meeting.participants){
        const seconds=participant?.duration;
        if(typeof seconds!=='number'||!Number.isFinite(seconds)||seconds<0) throw unavailable();
        minutes+=Math.ceil(seconds/60);
        if(!integer(minutes)) throw unavailable();
      }
    }
    count+=data.length;
    if(count===total) return minutes;
    if(data.length===0) throw unavailable();
    cursor=data.at(-1).id;
  }
  throw unavailable();
}

async function clock(db){
  const value=Number((await db.execute(`SELECT ${DB_NOW} AS seconds`)).rows?.[0]?.seconds);
  if(!integer(value)||value<1) throw unavailable();
  return value;
}
function retryableConflict(error){
  for(let current=error,depth=0;current&&depth<6;current=current.cause,depth++){
    if([current.code,current.rawCode].some(code=>['SQLITE_BUSY','SQLITE_BUSY_SNAPSHOT','SQLITE_LOCKED',
      'SQLITE_LOCKED_SHAREDCACHE','TRANSACTION_CONFLICT','LIBSQL_TRANSACTION_BUSY'].includes(code))) return true;
  }
  return false;
}
async function transaction(db,mode,work){
  for(let attempt=0;attempt<4;attempt++){
    let tx=null,rolledBack=false;
    try{ tx=await db.transaction(mode); const result=await work(tx); await tx.commit(); return result; }
    catch(error){
      if(tx){ try{ await tx.rollback(); rolledBack=true; }catch{} }
      // Only known lock conflicts whose work never started or whose rollback
      // succeeded. Never retry a lost/unknown commit acknowledgement.
      if(attempt===3||!retryableConflict(error)||tx&&!rolledBack) throw error;
    }finally{ try{ await tx?.close(); }catch{} }
    await new Promise(resolve=>setTimeout(resolve,20*(2**attempt)+Math.floor(Math.random()*20)));
  }
}
async function snapshot(db,month,now){
  const rows=(await db.execute({sql:'SELECT key,attempts FROM auth_rate_limits WHERE key IN (?,?)',args:[`${month.key}:u`,`${month.key}:t`]})).rows;
  const usage=rows.find(row=>row.key===`${month.key}:u`),stamp=rows.find(row=>row.key===`${month.key}:t`);
  if(!usage||!stamp) return null;
  const minutes=Number(usage.attempts),at=Number(stamp.attempts);
  if(!integer(minutes)||!integer(at)||at<month.start||at>now) throw unavailable();
  return {minutes,at,fresh:now-at<DAILY_USAGE_MAX_AGE_SECONDS};
}
function upsert(key,attempts,expiresAt){
  return {sql:`INSERT INTO auth_rate_limits(key,attempts,expires_at) VALUES (?,?,?)
    ON CONFLICT(key) DO UPDATE SET attempts=excluded.attempts,expires_at=excluded.expires_at`,args:[key,attempts,expiresAt]};
}
async function ensureUsage(db,config,fetchImpl){
  const generation=Number.parseInt(randomBytes(6).toString('hex'),16);
  const claim=await transaction(db,'write',async tx=>{
    const now=await clock(tx),month=dailyBudgetMonth(now);
    const cached=await snapshot(tx,month,now);
    if(cached?.fresh) return null;
    const result=await tx.execute({sql:`INSERT INTO auth_rate_limits(key,attempts,expires_at) VALUES (?,?,?)
      ON CONFLICT(key) DO UPDATE SET attempts=excluded.attempts,expires_at=excluded.expires_at
      WHERE auth_rate_limits.expires_at<=? RETURNING attempts`,
    args:[`${month.key}:f`,generation,now+DAILY_USAGE_MAX_AGE_SECONDS,now]});
    if(result.rows.length!==1) throw unavailable();
    return {month,at:now};
  });
  if(!claim) return;
  // Failed reads leave the claim in place: retries cannot hammer Daily. Cold
  // contenders refuse while the owner reads; they never mint without evidence.
  const minutes=await readDailyReportedMinutes(config,{month:claim.month,fetchImpl});
  await transaction(db,'write',async tx=>{
    const now=await clock(tx);
    if(now-claim.at>=DAILY_USAGE_MAX_AGE_SECONDS||dailyBudgetMonth(now).start!==claim.month.start) throw unavailable();
    const fence=await tx.execute({sql:'SELECT attempts FROM auth_rate_limits WHERE key=? AND expires_at>?',args:[`${claim.month.key}:f`,now]});
    if(Number(fence.rows[0]?.attempts)!==generation) throw unavailable();
    // Keep evidence until after month end, independently of freshness, so
    // unrelated expired-rate-limit sweeps cannot delete half a live snapshot.
    await tx.execute(upsert(`${claim.month.key}:u`,minutes,claim.month.end+3600));
    await tx.execute(upsert(`${claim.month.key}:t`,claim.at,claim.month.end+3600));
  });
}
async function reservedMinutes(db,now){
  const rows=(await db.execute({sql:"SELECT attempts FROM auth_rate_limits WHERE key GLOB 'dvb1:r:*' AND expires_at>?",args:[now]})).rows;
  let total=0;
  for(const row of rows){
    const minutes=Number(row.attempts);
    if(!integer(minutes)||minutes<1||minutes>60) throw unavailable();
    total+=minutes;
  }
  if(!integer(total)) throw unavailable();
  return total;
}

/** Check and reserve in ONE write transaction. Equality passes. Reservations
 * remain through expiry even after a failed/unknown provider outcome, and
 * cross UTC month boundaries. Never release an uncertain minted token.
 */
export async function reserveDailyGrant(db,config,{window,fetchImpl=globalThis.fetch}){
  const budget=config?.monthlyMinuteBudget;
  if(!integer(budget)||budget<1||!integer(window?.ttlSeconds)||window.ttlSeconds<1||window.ttlSeconds>3600
    ||!integer(window.nowSeconds)||window.expiresAt!==window.nowSeconds+window.ttlSeconds) throw unavailable();
  await ensureUsage(db,config,fetchImpl);
  return transaction(db,'write',async tx=>{
    const now=await clock(tx),month=dailyBudgetMonth(now);
    if(window.nowSeconds>now||window.expiresAt<=now) throw unavailable();
    const cached=await snapshot(tx,month,now);
    if(!cached?.fresh) throw unavailable();
    const reserved=await reservedMinutes(tx,now),minutes=Math.ceil(window.ttlSeconds/60);
    if(cached.minutes+reserved+minutes>budget) throw unavailable();
    await tx.execute({sql:"DELETE FROM auth_rate_limits WHERE key IN (SELECT key FROM auth_rate_limits WHERE key GLOB 'dvb1:r:*' AND expires_at<=? LIMIT 64)",args:[now]});
    await tx.execute(upsert(`${PREFIX}r:${randomBytes(16).toString('hex')}`,minutes,window.expiresAt));
    return {reportedMinutes:cached.minutes,reservedMinutes:reserved+minutes,budget};
  });
}

/** Read-only admin aggregate: no refresh/provider call or per-grant projection. */
export async function readDailyBudgetDiagnostics(db,{env=process.env}={}){
  const budget=dailyMonthlyMinuteBudget(env);
  const unknown={reportedMinutes:null,reservedMinutes:null,budget,state:'unknown',status:'unknown'};
  try{
    return await transaction(db,'read',async tx=>{
      const now=await clock(tx),month=dailyBudgetMonth(now),cached=await snapshot(tx,month,now);
      const reserved=await reservedMinutes(tx,now);
      let state='unknown';
      if(!dailyVideoConfiguration(env)) state='paused';
      else if(cached?.fresh){
        const projected=cached.minutes+reserved;
        state=projected>=budget?'paused':projected>=budget*0.9?'near':'ok';
      }
      return {reportedMinutes:cached?.minutes??null,reservedMinutes:reserved,budget,state,
        status:{ok:'healthy',near:'degraded',paused:'failed',unknown:'unknown'}[state]};
    });
  }catch{ return unknown; }
}
