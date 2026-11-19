// Daily participant-minute admission (#490 / ID-106). Existing TTL storage
// holds aggregates and opaque pair reservations; provider I/O never holds a
// write lock. Snapshot usage ratchets within each UTC month.
import { randomBytes } from 'node:crypto';
import { DailyProviderError, dailyRequest, dailyMonthlyMinuteBudget, dailyVideoConfiguration } from './_daily-video.js';

export const DAILY_USAGE_MAX_AGE_SECONDS=300;
export const DAILY_USAGE_PAGE_LIMIT=100;
export const DAILY_USAGE_MAX_PAGES=20;
export const DAILY_USAGE_TOTAL_TIMEOUT_MS=8000;
export const DAILY_USAGE_FAILURE_COOLDOWN_SECONDS=30;
const PREFIX='dvb1:';
const DB_NOW="CAST(strftime('%s','now') AS INTEGER)";
const REASONS=['usage_unavailable','usage_too_large','usage_timeout'];

function unavailable(reason='usage_unavailable'){
  const error=new DailyProviderError('budget',null);
  error.reason=reason;
  return error;
}
function integer(value){ return Number.isSafeInteger(value)&&value>=0; }
export function dailyBudgetMonth(nowSeconds){
  const date=new Date(nowSeconds*1000);
  const start=Date.UTC(date.getUTCFullYear(),date.getUTCMonth(),1)/1000;
  const end=Date.UTC(date.getUTCFullYear(),date.getUTCMonth()+1,1)/1000;
  if(!integer(start)||!integer(end)) throw unavailable();
  return {start,end,key:`${PREFIX}${start}`};
}

async function usageRequest(config,options,signal){
  let abort;
  const cancelled=new Promise((_,reject)=>{
    abort=()=>reject(unavailable('usage_timeout'));
    signal.addEventListener('abort',abort,{once:true});
  });
  try{
    signal.throwIfAborted();
    return await Promise.race([dailyRequest(config,{...options,signal}),cancelled]);
  }finally{ signal.removeEventListener('abort',abort); }
}
/** Round EACH participant upwards, including ongoing meetings. The provider's
 * occasional month-straddling records are counted conservatively, never used
 * to lower usage. Reject malformed/duplicate/truncated results. One total
 * deadline covers all pages and response bodies, including an unresponsive SDK.
 */
export async function readDailyReportedMinutes(config,{month,fetchImpl=globalThis.fetch,timeoutMs=DAILY_USAGE_TOTAL_TIMEOUT_MS}){
  const controller=new AbortController();
  const timer=setTimeout(()=>controller.abort(),timeoutMs);
  let cursor=null,minutes=0,count=0;
  const seen=new Set();
  try{
    for(let page=0;page<DAILY_USAGE_MAX_PAGES;page++){
      const query=new URLSearchParams({timeframe_start:String(month.start),timeframe_end:String(month.end),limit:String(DAILY_USAGE_PAGE_LIMIT)});
      if(cursor!==null) query.set('starting_after',cursor);
      const response=await usageRequest(config,{method:'GET',path:`/meetings?${query}`,stage:'usage',fetchImpl},controller.signal);
      const {data,total_count:total}=response.payload||{};
      if(response.status!==200||!Array.isArray(data)||data.length>DAILY_USAGE_PAGE_LIMIT||!integer(total)||total<count+data.length) throw unavailable();
      for(const meeting of data){
        if(typeof meeting?.id!=='string'||!meeting.id||seen.has(meeting.id)
          ||!integer(meeting.start_time)||meeting.start_time>=month.end
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
    throw unavailable('usage_too_large');
  }catch(error){
    throw error instanceof DailyProviderError&&error.stage==='budget'?error:unavailable();
  }finally{ clearTimeout(timer); }
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
    try{
      tx=await db.transaction(mode);
      const result=await work(tx);
      // Cache hits and prepaid-pair reuse made no writes. Roll back the
      // read-only write transaction rather than committing an empty lease.
      if(mode==='read'||mode==='write'&&(result===null||result?.reused===true)) await tx.rollback();
      else await tx.commit();
      return result;
    }
    catch(error){
      if(tx){ try{ await tx.rollback(); rolledBack=true; }catch{} }
      // Never retry an unknown commit, or work whose rollback was not proven.
      if(attempt===3||!retryableConflict(error)||tx&&!rolledBack) throw error;
    }finally{ try{ await tx?.close(); }catch{} }
    await new Promise(resolve=>setTimeout(resolve,30*(2**attempt)+Math.floor(Math.random()*30)));
  }
}
export {transaction as dailyBudgetTransaction};
async function snapshot(db,month,now){
  const rows=(await db.execute({sql:'SELECT key,attempts FROM auth_rate_limits WHERE key IN (?,?)',args:[`${month.key}:u`,`${month.key}:t`]})).rows;
  const usage=rows.find(row=>row.key===`${month.key}:u`),stamp=rows.find(row=>row.key===`${month.key}:t`);
  if(!usage){if(stamp)throw unavailable();return null;}
  const minutes=Number(usage.attempts);
  if(!integer(minutes)) throw unavailable();
  if(!stamp) return {minutes,at:null,fresh:false};
  const at=Number(stamp.attempts);
  if(!integer(at)||at<month.start||at>now) throw unavailable();
  return {minutes,at,fresh:now-at<DAILY_USAGE_MAX_AGE_SECONDS};
}
function upsert(key,attempts,expiresAt){
  return {sql:`INSERT INTO auth_rate_limits(key,attempts,expires_at) VALUES (?,?,?)
    ON CONFLICT(key) DO UPDATE SET attempts=excluded.attempts,expires_at=excluded.expires_at`,args:[key,attempts,expiresAt]};
}
async function ownsRefresh(tx,claim,generation,now){
  const fence=await tx.execute({sql:'SELECT attempts FROM auth_rate_limits WHERE key=? AND expires_at>?',args:[`${claim.month.key}:f`,now]});
  return Number(fence.rows[0]?.attempts)===generation;
}
async function ensureUsage(db,config,fetchImpl,pairKey){
  const generation=Number.parseInt(randomBytes(6).toString('hex'),16);
  const claim=await transaction(db,'write',async tx=>{
    const now=await clock(tx),month=dailyBudgetMonth(now);
    const cached=await snapshot(tx,month,now);
    if(cached?.fresh) return null;
    const result=await tx.execute({sql:`INSERT INTO auth_rate_limits(key,attempts,expires_at) VALUES (?,?,?)
      ON CONFLICT(key) DO UPDATE SET attempts=excluded.attempts,expires_at=excluded.expires_at
      WHERE auth_rate_limits.expires_at<=? RETURNING attempts`,
    args:[`${month.key}:f`,generation,now+DAILY_USAGE_FAILURE_COOLDOWN_SECONDS,now]});
    if(result.rows.length!==1){
      // The partner must not enter Daily while this request falls back during
      // a cold refresh. Commit a short pair refusal before the owner publishes.
      await tx.execute(upsert(`${pairKey}:paused`,1,now+DAILY_USAGE_FAILURE_COOLDOWN_SECONDS));
      return {denied:true};
    }
    return {month,at:now};
  });
  if(!claim) return;
  if(claim.denied) throw unavailable();
  try{
    const minutes=await readDailyReportedMinutes(config,{month:claim.month,fetchImpl});
    await transaction(db,'write',async tx=>{
      const now=await clock(tx);
      if(now-claim.at>=DAILY_USAGE_FAILURE_COOLDOWN_SECONDS||dailyBudgetMonth(now).start!==claim.month.start
        ||!await ownsRefresh(tx,claim,generation,now)) throw unavailable();
      const previous=await snapshot(tx,claim.month,now);
      // A well-formed but incomplete/regressed provider response cannot reopen
      // the month's budget. The month-specific key owns the only reset.
      await tx.execute(upsert(`${claim.month.key}:u`,Math.max(minutes,previous?.minutes??0),claim.month.end+3600));
      await tx.execute(upsert(`${claim.month.key}:t`,claim.at,claim.month.end+3600));
      await tx.execute(upsert(`${claim.month.key}:f`,generation,claim.at+DAILY_USAGE_MAX_AGE_SECONDS));
      await tx.execute({sql:'DELETE FROM auth_rate_limits WHERE key=?',args:[`${claim.month.key}:x`]});
    });
  }catch(error){
    const failure=error instanceof DailyProviderError&&error.stage==='budget'?error:unavailable();
    try{
      await transaction(db,'write',async tx=>{
        const now=await clock(tx);
        if(await ownsRefresh(tx,claim,generation,now)){
          const reason=Math.max(0,REASONS.indexOf(failure.reason));
          await tx.execute(upsert(`${claim.month.key}:x`,reason,claim.month.end+3600));
        }
      });
    }catch{}
    throw failure;
  }
}
async function reservedMinutes(db,now){
  const rows=(await db.execute({sql:"SELECT key,attempts FROM auth_rate_limits WHERE (key GLOB 'dvb1:r:*' OR key GLOB 'dvb1:p:*') AND key NOT GLOB '*:paused' AND expires_at>?",args:[now]})).rows;
  let total=0;
  for(const row of rows){
    const minutes=Number(row.attempts),max=row.key.startsWith(`${PREFIX}p:`)?120:60;
    if(!integer(minutes)||minutes<1||minutes>max) throw unavailable();
    total+=minutes;
  }
  if(!integer(total)) throw unavailable();
  return total;
}
async function pairedWindow(tx,pairKey,window,now){
  const row=(await tx.execute({sql:'SELECT attempts,expires_at FROM auth_rate_limits WHERE key=? AND expires_at>?',args:[pairKey,now]})).rows[0];
  if(!row) return null;
  const cost=Number(row.attempts),expires=Number(row.expires_at);
  if(!integer(cost)||cost<2||cost>120||cost%2||!integer(expires)) throw unavailable();
  const expiresAt=Math.min(window.expiresAt,expires-DAILY_USAGE_MAX_AGE_SECONDS);
  const ttlSeconds=expiresAt-window.nowSeconds;
  if(expiresAt<=now||2*Math.ceil(ttlSeconds/60)>cost) throw unavailable(); // grace is accounting only
  return {...window,expiresAt,ttlSeconds};
}

/** First grant reserves BOTH seats. A later partner/rejoin reuses that spend
 * envelope, with its token capped at the first pass's expiry. Keep reservations
 * for five minutes beyond token expiry so final reported usage cannot fall
 * between expiry and a stale snapshot. Includes old per-grant rows on upgrade.
 */
export async function reserveDailyGrant(db,config,{window,roomName,fetchImpl=globalThis.fetch}){
  const budget=config?.monthlyMinuteBudget;
  if(!integer(budget)||budget<1||!integer(window?.ttlSeconds)||window.ttlSeconds<1||window.ttlSeconds>3600
    ||!integer(window.nowSeconds)||window.expiresAt!==window.nowSeconds+window.ttlSeconds
    ||typeof roomName!=='string'||!/^rc-[a-f0-9]{32}$/.test(roomName)) throw unavailable();
  const pairKey=`${PREFIX}p:${roomName}`;
  try{
    // Pair rows are immutable while active and are never released early, so
    // this reuse read needs no write/read transaction or lease upgrade.
    const now=await clock(db);
    if(window.nowSeconds>now||window.expiresAt<=now) throw unavailable();
    const reused=await pairedWindow(db,pairKey,window,now);
    // A prepaid pair costs no additional participant-minutes. Its second seat
    // remains available even during a cache outage or other pairs' admissions.
    if(reused) return {window:reused,reused:true};
    await ensureUsage(db,config,fetchImpl,pairKey);
    return await transaction(db,'write',async tx=>{
      const now=await clock(tx),month=dailyBudgetMonth(now);
      if(window.nowSeconds>now||window.expiresAt<=now) throw unavailable();
      const paired=await pairedWindow(tx,pairKey,window,now);
      if(paired) return {window:paired,reused:true};
      const paused=await tx.execute({sql:'SELECT 1 FROM auth_rate_limits WHERE key=? AND expires_at>?',args:[`${pairKey}:paused`,now]});
      if(paused.rows.length) throw unavailable();
      const cached=await snapshot(tx,month,now);
      if(!cached?.fresh) throw unavailable();
      const reserved=await reservedMinutes(tx,now),minutes=2*Math.ceil(window.ttlSeconds/60);
      if(cached.minutes+reserved+minutes>budget) throw unavailable();
      await tx.execute({sql:"DELETE FROM auth_rate_limits WHERE key IN (SELECT key FROM auth_rate_limits WHERE key GLOB 'dvb1:*' AND expires_at<=? LIMIT 64)",args:[now]});
      await tx.execute(upsert(pairKey,minutes,window.expiresAt+DAILY_USAGE_MAX_AGE_SECONDS));
      return {reportedMinutes:cached.minutes,reservedMinutes:reserved+minutes,budget,window,reused:false};
    });
  }catch(error){ throw error instanceof DailyProviderError?error:unavailable('store_unavailable'); }
}

/** Read-only, aggregate-only diagnostics: never refreshes or contacts Daily. */
export async function readDailyBudgetDiagnostics(db,{env=process.env}={}){
  const budget=dailyMonthlyMinuteBudget(env);
  const enabled=env.DAILY_VIDEO_ENABLED==='true'&&env.RANDORI_LOCAL_RUNTIME!=='true';
  const notEnabled={reportedMinutes:null,reservedMinutes:null,budget,state:'unknown',status:'unknown',reason:'not_enabled'};
  try{
    return await transaction(db,'read',async tx=>{
      const now=await clock(tx),month=dailyBudgetMonth(now),cached=await snapshot(tx,month,now);
      const reserved=await reservedMinutes(tx,now);
      const errorRow=(await tx.execute({sql:'SELECT attempts FROM auth_rate_limits WHERE key=?',args:[`${month.key}:x`]})).rows[0];
      let state='unknown',status='unknown',reason=enabled?'usage_unknown':'not_enabled';
      if(enabled&&!dailyVideoConfiguration(env)){status='failed';reason='configuration';}
      else if(enabled&&cached?.fresh){
        const projected=cached.minutes+reserved;
        state=projected>=budget?'paused':projected>=budget*0.9?'near':'ok';
        status=state==='ok'?'healthy':'degraded';
        reason=state==='paused'?'budget_reached':null;
      }else if(enabled&&errorRow){
        status='failed';reason=REASONS[Number(errorRow.attempts)]||'usage_unavailable';
      }
      return {reportedMinutes:cached?.minutes??null,reservedMinutes:reserved,budget,state,status,reason};
    });
  }catch{
    return enabled?{...notEnabled,status:'failed',reason:'store_unavailable'}:notEnabled;
  }
}
