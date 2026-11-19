// Issue #305 (ID-107): per-provider monthly usage gates for the direct
// call's TURN relays, mirroring the Daily guard (#490). Providers are never
// contacted: usage reads go to in-memory fakes and the database clock is
// controlled by the test.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, test } from 'node:test';
import { createClient } from '@libsql/client';

import {
  TURN_RESERVATION_GRACE_SECONDS,
  TURN_USAGE_FAILURE_COOLDOWN_SECONDS,
  TURN_USAGE_MAX_AGE_SECONDS,
  TURN_USAGE_TOTAL_TIMEOUT_MS,
  TurnBudgetError,
  readCloudflareUsageMb,
  readMeteredUsageMb,
  readTurnBudgetDiagnostics,
  readTurnUsageMb,
  releaseTurnReservation,
  reserveTurnRelay,
  turnBudgetMonth,
  turnReservationMb,
} from '../../api/_turn-budget.js';

const NOV=Date.UTC(2026,10,1)/1000;
const DEC=Date.UTC(2026,11,1)/1000;
const CLOUDFLARE={provider:'cloudflare',keyId:'0123456789abcdef',apiToken:'cf-turn-api-token-SECRET-0123456789',
  accountId:'a'.repeat(32),analyticsToken:'cf-analytics-token-SECRET-0123456789',budgetMb:10_000,reserveMb:1800};
const METERED={provider:'metered',domain:'randori-circle.metered.live',apiKey:'metered-api-key-SECRET-012345',
  secretKey:'metered-secret-SECRET-0123456789',budgetMb:16_000,reserveMb:1800};
const ENV={TURN_RELAY_ENABLED:'true',CLOUDFLARE_TURN_KEY_ID:CLOUDFLARE.keyId,CLOUDFLARE_TURN_API_TOKEN:CLOUDFLARE.apiToken,
  CLOUDFLARE_ACCOUNT_ID:CLOUDFLARE.accountId,CLOUDFLARE_ANALYTICS_API_TOKEN:CLOUDFLARE.analyticsToken,TURN_MONTHLY_GB_BUDGET:'10'};

let directory=null;
let real=null;
let nowSeconds=NOV+10*86400;

// The real database, with `strftime('%s','now')` answered by the test clock.
function clocked(target){
  const execute=statement=>{
    const sql=String(statement?.sql??statement);
    if(sql.includes("CAST(strftime('%s','now') AS INTEGER) AS seconds")) return Promise.resolve({rows:[{seconds:nowSeconds}]});
    return target.execute(statement);
  };
  return {execute,transaction:async mode=>{
    const tx=await target.transaction(mode);
    return {execute:statement=>{
      const sql=String(statement?.sql??statement);
      if(sql.includes("CAST(strftime('%s','now') AS INTEGER) AS seconds")) return Promise.resolve({rows:[{seconds:nowSeconds}]});
      return tx.execute(statement);
    },commit:()=>tx.commit(),rollback:()=>tx.rollback(),close:()=>tx.close()};
  }};
}

async function database(){
  directory=mkdtempSync(join(tmpdir(),'randori-turn-budget-'));
  real=createClient({url:`file:${join(directory,'test.sqlite')}`});
  await real.execute(`CREATE TABLE auth_rate_limits (key TEXT PRIMARY KEY, attempts INTEGER NOT NULL DEFAULT 0, expires_at INTEGER NOT NULL)`);
  return clocked(real);
}

const json=(status,value)=>new Response(JSON.stringify(value),{status,headers:{'content-type':'application/json'}});
function cloudflareUsage(bytes,{ingress=0}={}){
  return json(200,{data:{viewer:{accounts:[{callsTurnUsageAdaptiveGroups:[{sum:{egressBytes:bytes,ingressBytes:ingress}}]}]}},errors:null});
}

function usageProvider(initial){
  const state={requests:[],respond:initial};
  state.fetch=async(url,init)=>{ state.requests.push({url:String(url),init}); return state.respond(url,init); };
  return state;
}

let roomCounter=0;
// A fresh room unless one is named: one envelope per room.
function grant(seconds=3600,roomKey=(++roomCounter).toString(16).padStart(32,'0')){
  return {ttlSeconds:seconds,expiresAtMs:(nowSeconds+seconds)*1000,roomKey};
}

async function rows(pattern){
  return (await real.execute({sql:'SELECT key,attempts,expires_at FROM auth_rate_limits WHERE key GLOB ? ORDER BY key',args:[pattern]})).rows
    .map(row=>({key:String(row.key),attempts:Number(row.attempts),expires:Number(row.expires_at)}));
}

beforeEach(()=>{ nowSeconds=NOV+10*86400; });
afterEach(()=>{
  try{ real?.close(); }catch{} real=null;
  if(directory){ rmSync(directory,{recursive:true,force:true}); directory=null; }
});

test('months are UTC calendar months, keyed per provider',()=>{
  assert.deepEqual(turnBudgetMonth(NOV+5,'cloudflare'),{start:NOV,end:DEC,key:`trb1:c:${NOV}`});
  assert.deepEqual(turnBudgetMonth(DEC-1,'metered'),{start:NOV,end:DEC,key:`trb1:m:${NOV}`});
  assert.equal(turnBudgetMonth(DEC,'cloudflare').start,DEC);
  assert.throws(()=>turnBudgetMonth(-1,'cloudflare'),TurnBudgetError);
  assert.throws(()=>turnBudgetMonth(NOV,'other'),error=>error.reason==='configuration');
  // A billing-cycle day moves the window: the 15th to the 15th.
  const nov15=Date.UTC(2026,10,15)/1000, dec15=Date.UTC(2026,11,15)/1000, oct15=Date.UTC(2026,9,15)/1000;
  assert.deepEqual(turnBudgetMonth(nov15,'cloudflare',15),{start:nov15,end:dec15,key:`trb1:c:${nov15}`});
  assert.deepEqual(turnBudgetMonth(nov15-1,'cloudflare',15),{start:oct15,end:nov15,key:`trb1:c:${oct15}`});
  assert.equal(turnBudgetMonth(Date.UTC(2027,0,3)/1000,'cloudflare',28).start,Date.UTC(2026,11,28)/1000,'across a year boundary');
  for(const day of [0,29,1.5,'1']) assert.throws(()=>turnBudgetMonth(NOV,'cloudflare',day),error=>error.reason==='configuration');
  assert.equal(turnReservationMb(1800,3600),1800);
  assert.equal(turnReservationMb(1800,60),30);
  assert.equal(turnReservationMb(1,1),1,'never zero');
});

test('Cloudflare usage is ingress plus egress for the key, rounded up to MB, and malformed answers fail',async()=>{
  const month=turnBudgetMonth(nowSeconds,'cloudflare');
  const read=respond=>readCloudflareUsageMb(CLOUDFLARE,{month,nowSeconds,fetchImpl:async()=>respond(),signal:new AbortController().signal});
  assert.equal(await read(()=>cloudflareUsage(1_000_000,{ingress:1})),2);
  assert.equal(await read(()=>cloudflareUsage(0)),0);
  assert.equal(await read(()=>json(200,{data:{viewer:{accounts:[{callsTurnUsageAdaptiveGroups:[]}]}}})),0,'no usage yet this month');
  assert.equal(await read(()=>json(200,{data:{viewer:{accounts:[{callsTurnUsageAdaptiveGroups:[]}]}},errors:[]})),0);
  for(const respond of [
    ()=>json(200,null),()=>json(200,[]),()=>json(200,{data:null,errors:[{message:'denied'}]}),
    ()=>json(200,{data:{viewer:{accounts:[]}}}),()=>json(200,{data:{viewer:{accounts:[{},{}]}}}),
    ()=>json(200,{data:{viewer:{accounts:[{callsTurnUsageAdaptiveGroups:{}}]}}}),
    ()=>json(200,{data:{viewer:{accounts:[{callsTurnUsageAdaptiveGroups:[{sum:{egressBytes:1,ingressBytes:1}},{sum:{egressBytes:1,ingressBytes:1}}]}]}}}),
    ()=>cloudflareUsage(-1),()=>cloudflareUsage(1.5),()=>cloudflareUsage('5'),()=>cloudflareUsage(Number.MAX_SAFE_INTEGER,{ingress:Number.MAX_SAFE_INTEGER}),
    ()=>json(200,{data:{viewer:{accounts:[{callsTurnUsageAdaptiveGroups:[{}]}]}}}),
    ()=>json(403,{errors:[{message:'forbidden'}]}),
  ]) await assert.rejects(read(respond),error=>/^usage-/.test(error.stage)&&error.provider==='cloudflare');
  let seen;
  await readCloudflareUsageMb(CLOUDFLARE,{month,nowSeconds,signal:new AbortController().signal,
    fetchImpl:async(url,init)=>{ seen={url,init}; return cloudflareUsage(0); }});
  assert.equal(seen.url,'https://api.cloudflare.com/client/v4/graphql');
  assert.equal(seen.init.headers.authorization,`Bearer ${CLOUDFLARE.analyticsToken}`);
  assert.equal(seen.init.redirect,'error');
  assert.match(JSON.parse(seen.init.body).query,/date_geq:"2026-11-01",date_leq:"2026-11-11",keyId:"0123456789abcdef"/);
});

test('Metered usage is the billing-cycle figure in MB and an overage counts at least the quota',async()=>{
  const read=respond=>readMeteredUsageMb(METERED,{fetchImpl:async()=>respond(),signal:new AbortController().signal});
  assert.equal(await read(()=>json(200,{quotaInGB:20,usageInGB:1.2345,overageInGB:0})),1235);
  assert.equal(await read(()=>json(200,{usageInGB:0})),0);
  assert.equal(await read(()=>json(200,{quotaInGB:20,usageInGB:3,overageInGB:2})),22_000);
  assert.equal(await read(()=>json(200,{quotaInGB:null,usageInGB:3,overageInGB:2})),3000);
  for(const respond of [
    ()=>json(200,null),()=>json(200,[]),()=>json(200,{}),()=>json(200,{usageInGB:-1}),()=>json(200,{usageInGB:'3'}),
    ()=>json(200,{usageInGB:1,quotaInGB:'x'}),()=>json(200,{usageInGB:1,overageInGB:-1}),()=>json(200,{usageInGB:1e300}),
    ()=>json(400,{message:'Invalid request. Not subscribed to any turn server plan'}),
  ]) await assert.rejects(read(respond),error=>/^usage-/.test(error.stage)&&error.provider==='metered');
});

test('one total deadline covers a usage read, even a hung provider',async()=>{
  assert.equal(TURN_USAGE_TOTAL_TIMEOUT_MS,8000);
  const month=turnBudgetMonth(nowSeconds,'metered');
  const started=Date.now();
  await assert.rejects(readTurnUsageMb(METERED,{month,nowSeconds,timeoutMs:20,fetchImpl:()=>new Promise(()=>{})}),
    error=>error instanceof TurnBudgetError&&error.reason==='usage_timeout');
  assert.ok(Date.now()-started<2000);
  await assert.rejects(readTurnUsageMb(METERED,{month,nowSeconds,fetchImpl:async()=>{ throw new Error('down'); }}),
    error=>error instanceof TurnBudgetError&&error.reason==='usage_unavailable');
  assert.equal(await readTurnUsageMb(CLOUDFLARE,{month,nowSeconds,fetchImpl:async()=>cloudflareUsage(5_000_000)}),5);
});

test('admission is exact at the budget boundary and counts every live reservation',async()=>{
  const db=await database();
  const usage=usageProvider(()=>cloudflareUsage(4000*1_000_000));
  const config={...CLOUDFLARE,budgetMb:4000+1800+1800};
  const first=await reserveTurnRelay(db,config,{...grant(),fetchImpl:usage.fetch});
  assert.deepEqual({...first,key:'k',expiresAtMs:0},{key:'k',reused:false,ttlSeconds:3600,expiresAtMs:0,reportedMb:4000,reservedMb:1800,budgetMb:config.budgetMb});
  assert.match(first.key,/^trb1:c:p:[a-f0-9]{32}:[a-f0-9]{24}$/);
  assert.equal(first.reused,false);
  const second=await reserveTurnRelay(db,config,{...grant(),fetchImpl:usage.fetch});
  assert.equal(second.reservedMb,3600,'exactly at the budget is admitted');
  await assert.rejects(reserveTurnRelay(db,config,{...grant(60),fetchImpl:usage.fetch}),
    error=>error instanceof TurnBudgetError&&error.reason==='budget_reached'&&error.provider==='cloudflare','one MB over is refused');
  assert.equal(usage.requests.length,1,'one usage read serves five minutes');
  const live=await rows('trb1:c:p:*');
  assert.equal(live.length,2);
  assert.ok(live.every(row=>row.expires===nowSeconds+3600+TURN_RESERVATION_GRACE_SECONDS),'credential expiry plus five minutes');
  // Releasing an unused credential frees its share; nothing else is released early.
  assert.equal(await releaseTurnReservation(db,second),true);
  assert.equal(await releaseTurnReservation(db,{key:'trb1:c:1234:u',reused:false}),false,'only reservation keys can be released');
  assert.equal(await releaseTurnReservation(db,{...first,reused:true}),false,'a reused envelope is never released');
  assert.equal(await releaseTurnReservation(db,null),false);
  assert.equal(await releaseTurnReservation({execute:async()=>{ throw new Error('down'); }},first),false);
  assert.equal((await reserveTurnRelay(db,config,{...grant(),fetchImpl:usage.fetch})).reservedMb,3600);
});

test('reservations expire with their credential plus grace, and are swept',async()=>{
  const db=await database();
  const usage=usageProvider(()=>cloudflareUsage(0));
  const config={...CLOUDFLARE,budgetMb:1800};
  await reserveTurnRelay(db,config,{...grant(),fetchImpl:usage.fetch});
  await assert.rejects(reserveTurnRelay(db,config,{...grant(),fetchImpl:usage.fetch}),error=>error.reason==='budget_reached');
  nowSeconds+=3600+TURN_RESERVATION_GRACE_SECONDS-1;
  await assert.rejects(reserveTurnRelay(db,config,{...grant(),fetchImpl:usage.fetch}),error=>error.reason==='budget_reached','still within grace');
  nowSeconds+=1;
  await reserveTurnRelay(db,config,{...grant(),fetchImpl:usage.fetch});
  assert.equal((await rows('trb1:c:p:*')).length,1,'the expired reservation was swept');
});

test('usage ratchets within the month, refreshes after five minutes, and restarts next month',async()=>{
  const db=await database();
  let reported=5000;
  const usage=usageProvider(()=>cloudflareUsage(reported*1_000_000));
  const config={...CLOUDFLARE,budgetMb:8000,reserveMb:1};
  assert.equal((await reserveTurnRelay(db,config,{...grant(),fetchImpl:usage.fetch})).reportedMb,5000);
  reported=1000; // a regressed or partial provider answer
  nowSeconds+=TURN_USAGE_MAX_AGE_SECONDS-1;
  assert.equal((await reserveTurnRelay(db,config,{...grant(),fetchImpl:usage.fetch})).reportedMb,5000);
  assert.equal(usage.requests.length,1,'fresh for five minutes');
  nowSeconds+=1;
  assert.equal((await reserveTurnRelay(db,config,{...grant(),fetchImpl:usage.fetch})).reportedMb,5000,'never decreases in the month');
  assert.equal(usage.requests.length,2);
  reported=7999;
  nowSeconds+=TURN_USAGE_MAX_AGE_SECONDS;
  await assert.rejects(reserveTurnRelay(db,config,{...grant(),fetchImpl:usage.fetch}),error=>error.reason==='budget_reached',
    '7,999 reported + 3 reserved + 1 > 8,000');
  const [stored]=await rows(`trb1:c:${NOV}:u`);
  assert.equal(stored.attempts,7999); assert.equal(stored.expires,DEC+3600,'aggregates last to month end plus an hour');
  // A new UTC month has its own key: usage starts from the provider's figure.
  nowSeconds=DEC+60; reported=10;
  const december=await reserveTurnRelay(db,config,{...grant(),fetchImpl:usage.fetch});
  assert.equal(december.reportedMb,10);
  assert.equal((await rows(`trb1:c:${DEC}:u`))[0].attempts,10);
});

test('unknown usage fails closed: failed and stale reads, a held refresh lease, and a corrupt store',async()=>{
  const db=await database();
  let fail=true;
  const usage=usageProvider(()=>fail?json(500,{}):cloudflareUsage(0));
  const config={...CLOUDFLARE,reserveMb:1};
  await assert.rejects(reserveTurnRelay(db,config,{...grant(),fetchImpl:usage.fetch}),
    error=>error instanceof TurnBudgetError&&error.reason==='usage_unavailable');
  assert.equal((await rows(`trb1:c:${NOV}:x`))[0].attempts,0,'the failure reason is recorded for diagnostics');
  assert.equal((await rows('trb1:c:p:*')).length,0);
  // Within the 30-second failure lease nobody retries the provider.
  fail=false;
  nowSeconds+=TURN_USAGE_FAILURE_COOLDOWN_SECONDS-1;
  await assert.rejects(reserveTurnRelay(db,config,{...grant(),fetchImpl:usage.fetch}),error=>error.reason==='usage_refreshing');
  assert.equal(usage.requests.length,1);
  nowSeconds+=1;
  await reserveTurnRelay(db,config,{...grant(),fetchImpl:usage.fetch});
  assert.equal((await rows(`trb1:c:${NOV}:x`)).length,0,'a good refresh clears the failure');
  // A stale snapshot whose refresh fails is not trusted.
  fail=true; nowSeconds+=TURN_USAGE_MAX_AGE_SECONDS;
  await assert.rejects(reserveTurnRelay(db,config,{...grant(),fetchImpl:usage.fetch}),error=>error.reason==='usage_unavailable');
  // A timeout is recorded as such.
  nowSeconds+=TURN_USAGE_FAILURE_COOLDOWN_SECONDS;
  await assert.rejects(reserveTurnRelay(db,config,{...grant(),fetchImpl:()=>new Promise(()=>{}),timeoutMs:20}),error=>error.reason==='usage_timeout');
  assert.equal((await rows(`trb1:c:${NOV}:x`))[0].attempts,1);
  // A refresh that outlives its lease cannot publish.
  nowSeconds+=TURN_USAGE_FAILURE_COOLDOWN_SECONDS;
  const slow=async()=>{ nowSeconds+=TURN_USAGE_FAILURE_COOLDOWN_SECONDS; return cloudflareUsage(0); };
  await assert.rejects(reserveTurnRelay(db,config,{...grant(),fetchImpl:slow}),error=>error.reason==='usage_unavailable');
  // Corrupt stored values fail closed as store_unavailable.
  nowSeconds+=TURN_USAGE_FAILURE_COOLDOWN_SECONDS;
  await real.execute({sql:`INSERT OR REPLACE INTO auth_rate_limits VALUES (?,?,?)`,args:[`trb1:c:p:${'e'.repeat(32)}:${'f'.repeat(24)}`,0,nowSeconds+600]});
  fail=false;
  await assert.rejects(reserveTurnRelay(db,config,{...grant(),fetchImpl:usage.fetch}),error=>error.reason==='store_unavailable');
  await real.execute(`DELETE FROM auth_rate_limits WHERE key GLOB 'trb1:c:p:*'`);
  await real.execute({sql:`UPDATE auth_rate_limits SET attempts=? WHERE key=?`,args:[nowSeconds+999,`trb1:c:${NOV}:t`]});
  await assert.rejects(reserveTurnRelay(db,config,{...grant(),fetchImpl:usage.fetch}),error=>error.reason==='store_unavailable');
  await real.execute({sql:`DELETE FROM auth_rate_limits WHERE key=?`,args:[`trb1:c:${NOV}:u`]});
  await assert.rejects(reserveTurnRelay(db,config,{...grant(),fetchImpl:usage.fetch}),error=>error.reason==='store_unavailable','a stamp without usage');
  await real.execute(`DELETE FROM auth_rate_limits`);
  await real.execute({sql:`INSERT INTO auth_rate_limits VALUES (?,?,?)`,args:[`trb1:c:${NOV}:u`,-5,DEC]});
  await assert.rejects(reserveTurnRelay(db,config,{...grant(),fetchImpl:usage.fetch}),error=>error.reason==='store_unavailable');
  await real.execute(`DELETE FROM auth_rate_limits`);
  await real.execute({sql:`INSERT INTO auth_rate_limits VALUES (?,?,?)`,args:[`trb1:c:${NOV}:u`,5,DEC]});
  // Usage without a stamp is never fresh: it is refreshed first.
  assert.equal((await reserveTurnRelay(db,config,{...grant(),fetchImpl:usage.fetch})).reportedMb,5,'and the ratchet keeps it');
  const broken={execute:async()=>{ throw new Error('down'); },transaction:async()=>{ throw new Error('down'); }};
  await assert.rejects(reserveTurnRelay(broken,config,{...grant(),fetchImpl:usage.fetch}),error=>error.reason==='store_unavailable');
  const badClock={...db,execute:async()=>({rows:[{seconds:0}]}),transaction:async mode=>{
    const tx=await real.transaction(mode);
    return {execute:()=>Promise.resolve({rows:[{seconds:0}]}),commit:()=>tx.commit(),rollback:()=>tx.rollback(),close:()=>tx.close()};
  }};
  await assert.rejects(reserveTurnRelay(badClock,config,{...grant(),fetchImpl:usage.fetch}),error=>error.reason==='store_unavailable');
});

test('one envelope per room: the partner and rejoins reuse it, capped at its expiry, even without fresh usage',async()=>{
  const db=await database();
  let fail=false;
  const usage=usageProvider(()=>fail?json(500,{}):cloudflareUsage(0));
  const config={...CLOUDFLARE,budgetMb:1800};
  const room='ab'.repeat(16);
  const first=await reserveTurnRelay(db,config,{...grant(3600,room),fetchImpl:usage.fetch});
  assert.equal(first.reused,false); assert.equal(first.ttlSeconds,3600);
  // Ten minutes later the partner asks for a full hour: it gets the rest of the room's pass, at no cost.
  nowSeconds+=600; fail=true;
  const partner=await reserveTurnRelay(db,config,{...grant(3600,room),fetchImpl:usage.fetch});
  assert.deepEqual({...partner},{key:first.key,reused:true,ttlSeconds:3000,expiresAtMs:first.expiresAtMs});
  assert.equal(usage.requests.length,1,'reuse never reads usage');
  assert.equal((await rows('trb1:c:p:*')).length,1,'still one envelope');
  // A shorter request keeps its own, shorter lifetime.
  assert.equal((await reserveTurnRelay(db,config,{...grant(120,room),fetchImpl:usage.fetch})).ttlSeconds,120);
  // Another room cannot fit while this one holds the whole budget.
  fail=false; nowSeconds+=TURN_USAGE_MAX_AGE_SECONDS;
  await assert.rejects(reserveTurnRelay(db,config,{...grant(),fetchImpl:usage.fetch}),error=>error.reason==='budget_reached');
  // With under a minute of the envelope left, a fresh one is needed (and here does not fit).
  nowSeconds=Math.floor(first.expiresAtMs/1000)-59;
  await assert.rejects(reserveTurnRelay(db,config,{...grant(3600,room),fetchImpl:usage.fetch}),error=>error.reason==='budget_reached');
  // A corrupt envelope fails closed.
  await real.execute({sql:'UPDATE auth_rate_limits SET attempts=0 WHERE key=?',args:[first.key]});
  nowSeconds=Math.floor(first.expiresAtMs/1000)-3000;
  await assert.rejects(reserveTurnRelay(db,config,{...grant(3600,room),fetchImpl:usage.fetch}),error=>error.reason==='store_unavailable');
});

test('a partner racing the first reservation reuses the envelope created inside the lock',async()=>{
  const db=await database();
  const room='cd'.repeat(16);
  let enter;
  const gate=new Promise(resolve=>{ enter=resolve; });
  let calls=0;
  // The first request's usage read waits until the second has also refreshed.
  const fetchImpl=async()=>{ calls+=1; if(calls===1) await gate; return cloudflareUsage(0); };
  const config={...CLOUDFLARE,budgetMb:1800};
  const first=reserveTurnRelay(db,config,{...grant(3600,room),fetchImpl});
  await new Promise(resolve=>setTimeout(resolve,20));
  // The second request is refused the refresh lease while the first holds it.
  await assert.rejects(reserveTurnRelay(db,config,{...grant(3600,room),fetchImpl}),error=>error.reason==='usage_refreshing');
  enter();
  const made=await first;
  assert.equal(made.reused,false);
  const again=await reserveTurnRelay(db,config,{...grant(3600,room),fetchImpl});
  assert.equal(again.reused,true); assert.equal(again.key,made.key);
  // Two members admitted at the same moment: the second's unlocked read saw
  // no envelope, but the first created one before the second took the lock.
  const both='ef'.repeat(16);
  const wide={...config,budgetMb:3600};
  const seed=await reserveTurnRelay(db,wide,{...grant(3600,both),fetchImpl});
  const blind={...db,execute:statement=>String(statement?.sql??statement).includes('ORDER BY expires_at DESC')
    ?Promise.resolve({rows:[]}):db.execute(statement)};
  const raced=await reserveTurnRelay(blind,wide,{...grant(3600,both),fetchImpl});
  assert.deepEqual({key:raced.key,reused:raced.reused},{key:seed.key,reused:true});
  assert.equal((await rows(`trb1:c:p:${both}:*`)).length,1);
});

test('invalid inputs never reserve',async()=>{
  const db=await database();
  const fetchImpl=async()=>cloudflareUsage(0);
  for(const [config,options] of [
    [null,grant()],[{...CLOUDFLARE,provider:'other'},grant()],[{...CLOUDFLARE,budgetMb:0},grant()],[{...CLOUDFLARE,reserveMb:0},grant()],
    [CLOUDFLARE,{ttlSeconds:0,expiresAtMs:Date.now()}],[CLOUDFLARE,{ttlSeconds:3601,expiresAtMs:Date.now()}],
    [CLOUDFLARE,{ttlSeconds:60,expiresAtMs:1.5}],
    [CLOUDFLARE,{ttlSeconds:60,expiresAtMs:(nowSeconds+60)*1000,roomKey:'not-a-room-key'}],
  ]) await assert.rejects(reserveTurnRelay(db,config,{roomKey:'0'.repeat(32),...options,fetchImpl}),error=>error.reason==='configuration');
  await assert.rejects(reserveTurnRelay(db,CLOUDFLARE,{ttlSeconds:60,expiresAtMs:(nowSeconds-1)*1000,roomKey:'0'.repeat(32),fetchImpl}),
    error=>error.reason==='configuration','an already-expired credential');
  assert.equal((await rows('trb1:c:p:*')).length,0);
});

test('busy transactions are retried, unknown commits are not',async()=>{
  const db=await database();
  let busy=1;
  const flaky={execute:db.execute,transaction:async mode=>{
    const tx=await db.transaction(mode);
    return {...tx,execute:statement=>{
      if(busy>0&&String(statement?.sql??statement).startsWith('INSERT INTO auth_rate_limits(key,attempts,expires_at) VALUES (?,?,?)\n      ON CONFLICT(key) DO UPDATE SET attempts=excluded.attempts,expires_at=excluded.expires_at\n      WHERE')){
        busy-=1; return Promise.reject(Object.assign(new Error('database is locked'),{code:'SQLITE_BUSY'}));
      }
      return tx.execute(statement);
    }};
  }};
  const reserved=await reserveTurnRelay(flaky,{...CLOUDFLARE,reserveMb:1},{...grant(),fetchImpl:async()=>cloudflareUsage(0)});
  assert.equal(reserved.reservedMb,1);
  const unknownCommit={execute:db.execute,transaction:async mode=>{
    const tx=await db.transaction(mode);
    return {...tx,rollback:()=>Promise.reject(new Error('gone')),execute:()=>Promise.reject(Object.assign(new Error('busy'),{code:'SQLITE_BUSY'}))};
  }};
  await assert.rejects(reserveTurnRelay(unknownCommit,{...CLOUDFLARE,reserveMb:1},{...grant(),fetchImpl:async()=>cloudflareUsage(0)}),
    error=>error.reason==='store_unavailable');
});

test('diagnostics are aggregate-only and never contact a provider',async()=>{
  const db=await database();
  const off=await readTurnBudgetDiagnostics(db,{env:{}});
  assert.deepEqual({...off,providers:undefined},{state:'unknown',status:'unknown',reason:'not_enabled',providers:undefined});
  assert.equal(off.providers.cloudflare.budgetMb,800_000); assert.equal(off.providers.metered.budgetMb,16_000);
  assert.equal((await readTurnBudgetDiagnostics(db)).reason,'not_enabled','reads process.env by default');
  assert.equal((await readTurnBudgetDiagnostics(db,{env:{TURN_RELAY_ENABLED:'true'}})).reason,'not_configured');

  const unknown=await readTurnBudgetDiagnostics(db,{env:ENV});
  assert.deepEqual(unknown.providers.cloudflare,{reportedMb:null,reservedMb:0,budgetMb:10_000,state:'unknown',status:'unknown',reason:'usage_unknown'});
  assert.deepEqual(unknown.providers.metered,{reportedMb:null,reservedMb:null,budgetMb:16_000,state:'unknown',status:'unknown',reason:'not_configured'});
  assert.equal(unknown.state,'unknown');

  const config={...CLOUDFLARE,reserveMb:1000};
  await reserveTurnRelay(db,config,{...grant(),fetchImpl:async()=>cloudflareUsage(1000*1_000_000)});
  let card=await readTurnBudgetDiagnostics(db,{env:ENV});
  assert.deepEqual(card.providers.cloudflare,{reportedMb:1000,reservedMb:1000,budgetMb:10_000,state:'ok',status:'healthy',reason:null});
  assert.deepEqual({state:card.state,status:card.status,reason:card.reason},{state:'ok',status:'healthy',reason:null});
  await real.execute({sql:'UPDATE auth_rate_limits SET attempts=? WHERE key=?',args:[8000,`trb1:c:${NOV}:u`]});
  card=await readTurnBudgetDiagnostics(db,{env:ENV});
  assert.equal(card.providers.cloudflare.state,'near'); assert.equal(card.status,'degraded'); assert.equal(card.state,'near');
  await real.execute({sql:'UPDATE auth_rate_limits SET attempts=? WHERE key=?',args:[9000,`trb1:c:${NOV}:u`]});
  card=await readTurnBudgetDiagnostics(db,{env:ENV});
  assert.deepEqual({state:card.state,reason:card.reason},{state:'paused',reason:'budget_reached'});
  assert.equal(card.providers.cloudflare.reason,'budget_reached');

  nowSeconds+=TURN_USAGE_MAX_AGE_SECONDS;
  await real.execute({sql:'INSERT INTO auth_rate_limits VALUES (?,?,?)',args:[`trb1:c:${NOV}:x`,1,DEC]});
  card=await readTurnBudgetDiagnostics(db,{env:ENV});
  assert.deepEqual({status:card.providers.cloudflare.status,reason:card.providers.cloudflare.reason},{status:'failed',reason:'usage_timeout'});
  assert.equal(card.status,'failed');

  const invalid=await readTurnBudgetDiagnostics(db,{env:{...ENV,METERED_TURN_APP_DOMAIN:'nope'}});
  assert.deepEqual({status:invalid.providers.metered.status,reason:invalid.providers.metered.reason},{status:'failed',reason:'configuration'});
  const broken=await readTurnBudgetDiagnostics({execute:async()=>{ throw new Error('down'); },transaction:async()=>{ throw new Error('down'); }},{env:ENV});
  assert.deepEqual({status:broken.providers.cloudflare.status,reason:broken.providers.cloudflare.reason},{status:'failed',reason:'store_unavailable'});
  assert.doesNotMatch(JSON.stringify([card,invalid,broken]),/SECRET|turn:|trb1/);
});
