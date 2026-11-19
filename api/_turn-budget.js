// Monthly usage gates for the direct call's TURN relays (#305 / ID-107),
// mirroring the Daily participant-minute guard (#490). Existing TTL storage
// (auth_rate_limits) holds per-provider aggregates and opaque per-credential
// reservations; provider I/O never holds a write lock. Snapshot usage
// ratchets within each UTC calendar month, and anything unknown fails closed:
// that provider hands out no credentials.
import { randomBytes } from 'node:crypto';

import {
  CLOUDFLARE_GRAPHQL_URL,
  TURN_PROVIDERS,
  TurnProviderError,
  meteredUsageUrl,
  providerJson,
  turnProviderStates,
} from './_turn-relay.js';

export const TURN_USAGE_MAX_AGE_SECONDS=300;
export const TURN_USAGE_TOTAL_TIMEOUT_MS=8000;
export const TURN_USAGE_FAILURE_COOLDOWN_SECONDS=30;
// Reported usage may lag the end of a credential, so a reservation outlives
// its credential by five minutes.
export const TURN_RESERVATION_GRACE_SECONDS=300;
const PREFIX='trb1:';
const CODES=Object.freeze({cloudflare:'c',metered:'m'});
const DB_NOW="CAST(strftime('%s','now') AS INTEGER)";
const REASONS=['usage_unavailable','usage_timeout'];
const MAX_RESERVATION_MB=10_000_000;

export class TurnBudgetError extends Error{
  constructor(provider,reason='usage_unavailable'){
    super('call relay budget unavailable');
    this.name='TurnBudgetError'; this.provider=provider; this.reason=reason;
  }
}

function integer(value){ return Number.isSafeInteger(value)&&value>=0; }
function code(provider){
  const value=CODES[provider];
  if(!value) throw new TurnBudgetError(provider,'configuration');
  return value;
}

/**
 * The provider's monthly window in UTC: from `cycleDay` (1-28, default 1, the
 * calendar month) to the same day next month. The key follows the window, so
 * a new window starts from the provider's own figure.
 */
export function turnBudgetMonth(nowSeconds,provider,cycleDay=1){
  if(!integer(nowSeconds)) throw new TurnBudgetError(provider);
  if(!Number.isSafeInteger(cycleDay)||cycleDay<1||cycleDay>28) throw new TurnBudgetError(provider,'configuration');
  const date=new Date(nowSeconds*1000);
  const month=date.getUTCMonth()-(date.getUTCDate()<cycleDay?1:0);
  const start=Date.UTC(date.getUTCFullYear(),month,cycleDay)/1000;
  const end=Date.UTC(date.getUTCFullYear(),month+1,cycleDay)/1000;
  return {start,end,key:`${PREFIX}${code(provider)}:${start}`};
}

function isoDate(seconds){ return new Date(seconds*1000).toISOString().slice(0,10); }
function bytesToMb(bytes){ return Math.ceil(bytes/1_000_000); }
function gbToMb(gb){ return Math.max(0,Math.ceil(gb*1000-1e-9)); }
function nonNegativeNumber(value){ return typeof value==='number'&&Number.isFinite(value)&&value>=0; }

/**
 * Cloudflare TURN usage for this key over the UTC month to date, ingress plus
 * egress (both are counted against the free allowance, conservatively), in MB.
 * Values are validated, never interpolated from user input.
 */
export async function readCloudflareUsageMb(config,{month,nowSeconds,fetchImpl,signal}){
  const vars={accountTag:config.accountId,from:isoDate(month.start),to:isoDate(nowSeconds),keyId:config.keyId};
  const query=`query{viewer{accounts(filter:{accountTag:${JSON.stringify(vars.accountTag)}}){callsTurnUsageAdaptiveGroups(limit:1,filter:{date_geq:${JSON.stringify(vars.from)},date_leq:${JSON.stringify(vars.to)},keyId:${JSON.stringify(vars.keyId)}}){sum{egressBytes ingressBytes}}}}}`;
  const {payload}=await providerJson('cloudflare',CLOUDFLARE_GRAPHQL_URL,{
    method:'POST',
    headers:{authorization:`Bearer ${config.analyticsToken}`,'content-type':'application/json',accept:'application/json'},
    body:JSON.stringify({query}),
  },{fetchImpl,signal,prefix:'usage-'});
  const fail=()=>{ throw new TurnProviderError('usage-response',200,'cloudflare'); };
  if(!payload||typeof payload!=='object'||Array.isArray(payload)) fail();
  if(payload.errors!==undefined&&payload.errors!==null&&!(Array.isArray(payload.errors)&&payload.errors.length===0)) fail();
  const accounts=payload.data?.viewer?.accounts;
  if(!Array.isArray(accounts)||accounts.length!==1) fail();
  const groups=accounts[0]?.callsTurnUsageAdaptiveGroups;
  if(!Array.isArray(groups)||groups.length>1) fail();
  if(!groups.length) return 0;
  const sum=groups[0]?.sum;
  if(!integer(sum?.egressBytes)||!integer(sum?.ingressBytes)) fail();
  const total=sum.egressBytes+sum.ingressBytes;
  if(!integer(total)) fail();
  return bytesToMb(total);
}

/**
 * Metered usage for the current billing cycle, in MB. Any overage counts as
 * at least the whole quota. The billing cycle need not match the calendar
 * month; the monthly ratchet keeps the larger figure, which is conservative.
 */
export async function readMeteredUsageMb(config,{fetchImpl,signal}){
  const {payload}=await providerJson('metered',meteredUsageUrl(config),{method:'GET',headers:{accept:'application/json'}},
    {fetchImpl,signal,prefix:'usage-'});
  const fail=()=>{ throw new TurnProviderError('usage-response',200,'metered'); };
  if(!payload||typeof payload!=='object'||Array.isArray(payload)||!nonNegativeNumber(payload.usageInGB)) fail();
  for(const field of ['quotaInGB','overageInGB']){
    if(payload[field]!==undefined&&payload[field]!==null&&!nonNegativeNumber(payload[field])) fail();
  }
  let usage=gbToMb(payload.usageInGB);
  if(payload.overageInGB>0) usage=Math.max(usage,gbToMb((payload.quotaInGB||0)+payload.overageInGB));
  if(!integer(usage)) fail();
  return usage;
}

/** One total deadline covers the request and its body, even a hung fetch. */
export async function readTurnUsageMb(config,{month,nowSeconds,fetchImpl=globalThis.fetch,timeoutMs=TURN_USAGE_TOTAL_TIMEOUT_MS}){
  const controller=new AbortController();
  let timer;
  const deadline=new Promise((_,reject)=>{
    timer=setTimeout(()=>{ controller.abort(); reject(new TurnBudgetError(config.provider,'usage_timeout')); },timeoutMs);
  });
  try{
    const read=config.provider==='cloudflare'
      ?readCloudflareUsageMb(config,{month,nowSeconds,fetchImpl,signal:controller.signal})
      :readMeteredUsageMb(config,{fetchImpl,signal:controller.signal});
    return await Promise.race([read,deadline]);
  }catch(error){
    throw error instanceof TurnBudgetError?error:new TurnBudgetError(config.provider,'usage_unavailable');
  }finally{ clearTimeout(timer); }
}

async function clock(db,provider){
  const value=Number((await db.execute(`SELECT ${DB_NOW} AS seconds`)).rows?.[0]?.seconds);
  if(!integer(value)||value<1) throw new TurnBudgetError(provider,'store_unavailable');
  return value;
}

function retryableConflict(error){
  for(let current=error,depth=0;current&&depth<6;current=current.cause,depth++){
    if([current.code,current.rawCode].some(value=>['SQLITE_BUSY','SQLITE_BUSY_SNAPSHOT','SQLITE_LOCKED',
      'SQLITE_LOCKED_SHAREDCACHE','TRANSACTION_CONFLICT','LIBSQL_TRANSACTION_BUSY'].includes(value))) return true;
  }
  return false;
}

async function transaction(db,mode,work){
  for(let attempt=0;attempt<4;attempt++){
    let tx=null,rolledBack=false;
    try{
      tx=await db.transaction(mode);
      const result=await work(tx);
      // Reads and cache hits made no writes: roll back rather than commit.
      if(mode==='read'||result===null) await tx.rollback();
      else await tx.commit();
      return result;
    }catch(error){
      if(tx){ try{ await tx.rollback(); rolledBack=true; }catch{} }
      // Never retry an unknown commit, or work whose rollback was not proven.
      if(attempt===3||!retryableConflict(error)||tx&&!rolledBack) throw error;
    }finally{ try{ await tx?.close(); }catch{} }
    await new Promise(resolve=>setTimeout(resolve,30*(2**attempt)+Math.floor(Math.random()*30)));
  }
}

async function snapshot(db,month,now,provider){
  const rows=(await db.execute({sql:'SELECT key,attempts FROM auth_rate_limits WHERE key IN (?,?)',args:[`${month.key}:u`,`${month.key}:t`]})).rows;
  const usage=rows.find(row=>row.key===`${month.key}:u`),stamp=rows.find(row=>row.key===`${month.key}:t`);
  if(!usage){ if(stamp) throw new TurnBudgetError(provider,'store_unavailable'); return null; }
  const mb=Number(usage.attempts);
  if(!integer(mb)) throw new TurnBudgetError(provider,'store_unavailable');
  if(!stamp) return {mb,at:null,fresh:false};
  const at=Number(stamp.attempts);
  if(!integer(at)||at<month.start||at>now) throw new TurnBudgetError(provider,'store_unavailable');
  return {mb,at,fresh:now-at<TURN_USAGE_MAX_AGE_SECONDS};
}

function upsert(key,attempts,expiresAt){
  return {sql:`INSERT INTO auth_rate_limits(key,attempts,expires_at) VALUES (?,?,?)
    ON CONFLICT(key) DO UPDATE SET attempts=excluded.attempts,expires_at=excluded.expires_at`,args:[key,attempts,expiresAt]};
}

async function ownsRefresh(tx,month,generation,now){
  const fence=await tx.execute({sql:'SELECT attempts FROM auth_rate_limits WHERE key=? AND expires_at>?',args:[`${month.key}:f`,now]});
  return Number(fence.rows[0]?.attempts)===generation;
}

/**
 * Refresh the month's snapshot when it is older than five minutes. One
 * request at a time holds a 30-second refresh lease; while another holds it
 * and no fresh snapshot exists, this provider fails closed.
 */
async function ensureUsage(db,config,fetchImpl,timeoutMs){
  const provider=config.provider;
  const generation=Number.parseInt(randomBytes(6).toString('hex'),16);
  const claim=await transaction(db,'write',async tx=>{
    const now=await clock(tx,provider),month=turnBudgetMonth(now,provider,config.cycleDay??1);
    const cached=await snapshot(tx,month,now,provider);
    if(cached?.fresh) return null;
    const result=await tx.execute({sql:`INSERT INTO auth_rate_limits(key,attempts,expires_at) VALUES (?,?,?)
      ON CONFLICT(key) DO UPDATE SET attempts=excluded.attempts,expires_at=excluded.expires_at
      WHERE auth_rate_limits.expires_at<=? RETURNING attempts`,
    args:[`${month.key}:f`,generation,now+TURN_USAGE_FAILURE_COOLDOWN_SECONDS,now]});
    if(result.rows.length!==1) return {denied:true};
    return {month,at:now};
  });
  if(!claim) return;
  if(claim.denied) throw new TurnBudgetError(provider,'usage_refreshing');
  try{
    const mb=await readTurnUsageMb(config,{month:claim.month,nowSeconds:claim.at,fetchImpl,timeoutMs});
    await transaction(db,'write',async tx=>{
      const now=await clock(tx,provider);
      if(now-claim.at>=TURN_USAGE_FAILURE_COOLDOWN_SECONDS||turnBudgetMonth(now,provider,config.cycleDay??1).start!==claim.month.start
        ||!await ownsRefresh(tx,claim.month,generation,now)) throw new TurnBudgetError(provider,'usage_unavailable');
      const previous=await snapshot(tx,claim.month,now,provider);
      // A smaller provider figure never reopens the month's budget; only the
      // next month's key starts from zero.
      await tx.execute(upsert(`${claim.month.key}:u`,Math.max(mb,previous?.mb??0),claim.month.end+3600));
      await tx.execute(upsert(`${claim.month.key}:t`,claim.at,claim.month.end+3600));
      await tx.execute(upsert(`${claim.month.key}:f`,generation,claim.at+TURN_USAGE_MAX_AGE_SECONDS));
      await tx.execute({sql:'DELETE FROM auth_rate_limits WHERE key=?',args:[`${claim.month.key}:x`]});
      return true;
    });
  }catch(error){
    const failure=error instanceof TurnBudgetError?error:new TurnBudgetError(provider,'usage_unavailable');
    try{
      await transaction(db,'write',async tx=>{
        const now=await clock(tx,provider);
        if(!await ownsRefresh(tx,claim.month,generation,now)) return null;
        const reason=Math.max(0,REASONS.indexOf(failure.reason));
        await tx.execute(upsert(`${claim.month.key}:x`,reason,claim.month.end+3600));
        return true;
      });
    }catch{}
    throw failure;
  }
}

async function reservedMb(db,provider,now){
  const pattern=`${PREFIX}${code(provider)}:p:*`;
  const rows=(await db.execute({sql:'SELECT attempts FROM auth_rate_limits WHERE key GLOB ? AND expires_at>?',args:[pattern,now]})).rows;
  let total=0;
  for(const row of rows){
    const mb=Number(row.attempts);
    if(!integer(mb)||mb<1||mb>MAX_RESERVATION_MB) throw new TurnBudgetError(provider,'store_unavailable');
    total+=mb;
  }
  if(!integer(total)) throw new TurnBudgetError(provider,'store_unavailable');
  return total;
}

/** A credential for `ttlSeconds` reserves its share of the per-hour estimate. */
export function turnReservationMb(reserveMbPerCall,ttlSeconds){
  return Math.max(1,Math.ceil(reserveMbPerCall*ttlSeconds/3600));
}

// A room's envelope is reused while at least a minute of its credential
// window is left; after that a fresh one is reserved.
const MIN_REUSE_SECONDS=60;

async function activeEnvelope(db,provider,roomKey,now){
  const row=(await db.execute({sql:`SELECT key,attempts,expires_at FROM auth_rate_limits
    WHERE key GLOB ? AND expires_at>? ORDER BY expires_at DESC LIMIT 1`,
  args:[`${PREFIX}${code(provider)}:p:${roomKey}:*`,now+TURN_RESERVATION_GRACE_SECONDS+MIN_REUSE_SECONDS]})).rows?.[0];
  if(!row) return null;
  const mb=Number(row.attempts),expires=Number(row.expires_at);
  if(!integer(mb)||mb<1||mb>MAX_RESERVATION_MB||!integer(expires)) throw new TurnBudgetError(provider,'store_unavailable');
  return {key:String(row.key),windowEnd:expires-TURN_RESERVATION_GRACE_SECONDS};
}

function reusedGrant(envelope,{ttlSeconds,expiresAtMs},now){
  const expiresAt=Math.min(Math.floor(expiresAtMs/1000),envelope.windowEnd);
  return Object.freeze({key:envelope.key,reused:true,ttlSeconds:Math.min(ttlSeconds,expiresAt-now),expiresAtMs:expiresAt*1000});
}

/**
 * Admit one credential under the provider's monthly budget. One reservation
 * covers a room: the first member's request reserves the room's envelope
 * (`TURN_RESERVE_MB_PER_CALL` prorated by the credential lifetime) and the
 * partner, or a rejoin, reuses it with a credential capped at the envelope's
 * expiry, at no new cost and even while usage is unreadable. A new envelope
 * needs a fresh snapshot, and reported plus every live reservation plus this
 * one must stay within budget (equality passes). Envelopes live until their
 * credential window ends plus five minutes and are never released early once
 * a credential was handed out. Returns {key, reused, ttlSeconds, expiresAtMs};
 * throws TurnBudgetError.
 */
export async function reserveTurnRelay(db,config,{ttlSeconds,expiresAtMs,roomKey,fetchImpl=globalThis.fetch,timeoutMs}){
  const provider=config?.provider;
  if(!CODES[provider]||!integer(config.budgetMb)||config.budgetMb<1||!integer(config.reserveMb)||config.reserveMb<1
    ||!integer(ttlSeconds)||ttlSeconds<1||ttlSeconds>3600||!integer(expiresAtMs)
    ||typeof roomKey!=='string'||!/^[a-f0-9]{32}$/.test(roomKey)) throw new TurnBudgetError(provider,'configuration');
  try{
    const now=await clock(db,provider);
    if(Math.floor(expiresAtMs/1000)<=now) throw new TurnBudgetError(provider,'configuration');
    // Envelopes are immutable while live, so this reuse read needs no lock.
    const prepaid=await activeEnvelope(db,provider,roomKey,now);
    if(prepaid) return reusedGrant(prepaid,{ttlSeconds,expiresAtMs},now);
    await ensureUsage(db,config,fetchImpl,timeoutMs);
    return await transaction(db,'write',async tx=>{
      const now=await clock(tx,provider),month=turnBudgetMonth(now,provider,config.cycleDay??1);
      const expiresAt=Math.floor(expiresAtMs/1000);
      if(expiresAt<=now) throw new TurnBudgetError(provider,'configuration');
      const raced=await activeEnvelope(tx,provider,roomKey,now);
      if(raced) return reusedGrant(raced,{ttlSeconds,expiresAtMs},now);
      const cached=await snapshot(tx,month,now,provider);
      if(!cached?.fresh) throw new TurnBudgetError(provider,'usage_unavailable');
      const reserved=await reservedMb(tx,provider,now),mb=turnReservationMb(config.reserveMb,ttlSeconds);
      if(cached.mb+reserved+mb>config.budgetMb) throw new TurnBudgetError(provider,'budget_reached');
      await tx.execute({sql:`DELETE FROM auth_rate_limits WHERE key IN (SELECT key FROM auth_rate_limits
        WHERE key GLOB ? AND expires_at<=? LIMIT 64)`,args:[`${PREFIX}${code(provider)}:*`,now]});
      const key=`${PREFIX}${code(provider)}:p:${roomKey}:${randomBytes(12).toString('hex')}`;
      await tx.execute(upsert(key,mb,expiresAt+TURN_RESERVATION_GRACE_SECONDS));
      return Object.freeze({key,reused:false,ttlSeconds,expiresAtMs:expiresAt*1000,
        reportedMb:cached.mb,reservedMb:reserved+mb,budgetMb:config.budgetMb});
    });
  }catch(error){ throw error instanceof TurnBudgetError?error:new TurnBudgetError(provider,'store_unavailable'); }
}

/** A new envelope whose credential was never handed out is released. */
export async function releaseTurnReservation(db,reservation){
  if(reservation?.reused!==false||typeof reservation.key!=='string'
    ||!/^trb1:[cm]:p:[a-f0-9]{32}:[a-f0-9]{24}$/.test(reservation.key)) return false;
  try{ await db.execute({sql:'DELETE FROM auth_rate_limits WHERE key=?',args:[reservation.key]}); return true; }
  catch{ return false; }
}

const STATUS_RANK=Object.freeze({healthy:0,unknown:1,degraded:2,failed:3});

/** Read-only, aggregate-only diagnostics: never refreshes or contacts a provider. */
export async function readTurnBudgetDiagnostics(db,{env=process.env}={}){
  const states=turnProviderStates(env);
  const base=provider=>({reportedMb:null,reservedMb:null,budgetMb:states.providers[provider].budgetMb});
  if(!states.enabled){
    const providers=Object.fromEntries(TURN_PROVIDERS.map(provider=>[provider,
      {...base(provider),state:'unknown',status:'unknown',reason:'not_enabled'}]));
    return {state:'unknown',status:'unknown',reason:'not_enabled',providers};
  }
  const providers={};
  for(const provider of TURN_PROVIDERS){
    const state=states.providers[provider];
    if(state.issue){ providers[provider]={...base(provider),state:'unknown',status:'failed',reason:state.issue}; continue; }
    if(!state.enabled){ providers[provider]={...base(provider),state:'unknown',status:'unknown',reason:'not_configured'}; continue; }
    try{
      providers[provider]=await transaction(db,'read',async tx=>{
        const now=await clock(tx,provider),month=turnBudgetMonth(now,provider,state.cycleDay);
        const cached=await snapshot(tx,month,now,provider),reserved=await reservedMb(tx,provider,now);
        const errorRow=(await tx.execute({sql:'SELECT attempts FROM auth_rate_limits WHERE key=?',args:[`${month.key}:x`]})).rows[0];
        const result={reportedMb:cached?.mb??null,reservedMb:reserved,budgetMb:state.budgetMb,state:'unknown',status:'unknown',reason:'usage_unknown'};
        if(cached?.fresh){
          const projected=cached.mb+reserved;
          result.state=projected>=state.budgetMb?'paused':projected>=state.budgetMb*0.9?'near':'ok';
          result.status=result.state==='ok'?'healthy':'degraded';
          result.reason=result.state==='paused'?'budget_reached':null;
        }else if(errorRow){
          result.status='failed'; result.reason=REASONS[Number(errorRow.attempts)]||'usage_unavailable';
        }
        return result;
      });
    }catch{
      providers[provider]={...base(provider),state:'unknown',status:'failed',reason:'store_unavailable'};
    }
  }
  const configured=TURN_PROVIDERS.map(provider=>providers[provider]).filter(item=>item.reason!=='not_configured');
  if(!configured.length) return {state:'unknown',status:'unknown',reason:'not_configured',providers};
  const status=configured.reduce((worst,item)=>STATUS_RANK[item.status]>STATUS_RANK[worst]?item.status:worst,'healthy');
  const usable=configured.filter(item=>item.state==='ok'||item.state==='near');
  const state=configured.every(item=>item.state==='paused')?'paused'
    :usable.length?(usable.some(item=>item.state==='ok')?'ok':'near'):'unknown';
  return {state,status,reason:state==='paused'?'budget_reached':null,providers};
}
