// #490 / ID-106 revision: isolated SQLite and scripted Daily, never providers.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, test } from 'node:test';
import { createClient } from '@libsql/client';
import { DailyProviderError, dailyMonthlyMinuteBudget, dailyVideoConfiguration } from '../../api/_daily-video.js';
import { dailyBudgetMonth, readDailyReportedMinutes, reserveDailyGrant, readDailyBudgetDiagnostics,
  DAILY_USAGE_MAX_PAGES, DAILY_USAGE_MAX_AGE_SECONDS, DAILY_USAGE_TOTAL_TIMEOUT_MS } from '../../api/_daily-budget.js';
import { cardView } from '../../assets/admin-diagnostics.js';

const env={DAILY_VIDEO_ENABLED:'true',DAILY_API_KEY:'synthetic-key-not-a-real-secret',DAILY_DOMAIN:'randori-circle.daily.co'};
const config=dailyVideoConfiguration(env);
let roots=[],sequence=0;
afterEach(()=>{for(const [root,clients] of roots){for(const client of clients) client.close();rmSync(root,{recursive:true,force:true});}roots=[];});
async function database(){
  const root=mkdtempSync(join(tmpdir(),'rc-budget-')),url=`file:${join(root,'test.db')}`;
  const db=createClient({url}),second=createClient({url});roots.push([root,[db,second]]);
  await db.execute('CREATE TABLE auth_rate_limits(key TEXT PRIMARY KEY,attempts INTEGER NOT NULL,expires_at INTEGER NOT NULL)');
  return {db,second,url};
}
async function now(db){return Number((await db.execute("SELECT CAST(strftime('%s','now') AS INTEGER) AS seconds")).rows[0].seconds);}
const room=()=>`rc-${(++sequence).toString(16).padStart(32,'0')}`;
const pass=(at,ttlSeconds=3600)=>({nowSeconds:at,ttlSeconds,expiresAt:at+ttlSeconds});
async function window(db,ttl=3600){return pass(await now(db),ttl);}
async function grant(db,{cfg=config,roomName=room(),window:given,fetchImpl=noFetch}={}){
  return reserveDailyGrant(db,cfg,{window:given||await window(db),roomName,fetchImpl});
}
async function seed(db,{minutes=0,age=0,at}={}){
  at??=await now(db);const month=dailyBudgetMonth(at);
  for(const [key,value] of [[`${month.key}:u`,minutes],[`${month.key}:t`,at-age]])
    await db.execute({sql:'INSERT OR REPLACE INTO auth_rate_limits VALUES (?,?,?)',args:[key,value,month.end+3600]});
  return month;
}
const json=payload=>new Response(JSON.stringify(payload),{status:200});
const noFetch=()=>{assert.fail('no provider network allowed');};
const meeting=(id,month,durations,extra={})=>({id,room:'raw-room-do-not-log',start_time:month.start+15,ongoing:false,
  participants:durations.map(duration=>({participant_id:'raw-participant',duration})),...extra});
function clockClient(db,readClock){
  const execute=(target,statement)=>typeof statement==='string'&&statement.includes("strftime('%s','now')")
    ?Promise.resolve({rows:[{seconds:readClock()}]}):target.execute(statement);
  return {execute:statement=>execute(db,statement),transaction:async mode=>{const tx=await db.transaction(mode);return {
    execute:statement=>execute(tx,statement),
    commit:()=>tx.commit(),rollback:()=>tx.rollback(),close:()=>tx.close()};}};
}

test('strict budget defaults only when unset; malformed/unsafe values hide capability',()=>{
  assert.equal(dailyMonthlyMinuteBudget({}),9000);
  for(const raw of ['1','60','9000','10000','9007199254740991'])assert.equal(dailyMonthlyMinuteBudget({DAILY_MONTHLY_MINUTE_BUDGET:raw}),Number(raw));
  for(const raw of ['', '0','-1','1.5','1e4','Infinity','NaN','+2',' 9000','9000 ','09','9007199254740992',null,9000]){
    const invalid={...env,DAILY_MONTHLY_MINUTE_BUDGET:raw};assert.equal(dailyMonthlyMinuteBudget(invalid),null);assert.equal(dailyVideoConfiguration(invalid),null);
  }
});
test('calendar UTC month includes leap February and year rollover',()=>{
  for(const [at,start,end] of [['2028-02-29T23:59:59Z','2028-02-01T00:00:00Z','2028-03-01T00:00:00Z'],
    ['2026-12-31T23:59:59Z','2026-12-01T00:00:00Z','2027-01-01T00:00:00Z']]){
    const month=dailyBudgetMonth(Date.parse(at)/1000);assert.equal(month.start,Date.parse(start)/1000);assert.equal(month.end,Date.parse(end)/1000);
  }
  assert.throws(()=>dailyBudgetMonth(NaN),DailyProviderError);
});
test('pagination sums per-participant ceil, ongoing and conservative month-straddling records',async()=>{
  const month=dailyBudgetMonth(Date.parse('2026-11-19T17:00:00Z')/1000),calls=[];
  const pages=[{total_count:3,data:[meeting('one',month,[0,1,60,61]),meeting('two',month,[15,120],{ongoing:true,duration:9999,max_participants:99})]},
    {total_count:3,data:[meeting('three',month,[0.1,59.9],{start_time:month.start-15})]}];
  assert.equal(await readDailyReportedMinutes(config,{month,fetchImpl:async(url,init)=>{calls.push({url:new URL(url),init});return json(pages.shift());}}),9);
  assert.equal(calls.length,2);
  for(const {url,init} of calls){
    assert.equal(url.pathname,'/v1/meetings');assert.equal(url.searchParams.get('timeframe_start'),String(month.start));
    assert.equal(url.searchParams.get('timeframe_end'),String(month.end));assert.equal(url.searchParams.get('limit'),'100');
    assert.equal(url.searchParams.has('ongoing'),false);assert.equal(url.searchParams.has('no_participants'),false);
    assert.equal(init.method,'GET');assert.equal(init.body,undefined);assert.equal(init.redirect,'error');assert.ok(init.signal instanceof AbortSignal);
  }
  assert.equal(calls[0].url.searchParams.has('starting_after'),false);assert.equal(calls[1].url.searchParams.get('starting_after'),'two');
  assert.equal(await readDailyReportedMinutes(config,{month,fetchImpl:async()=>json({total_count:0,data:[]})}),0);
});
test('malformed/truncated/duplicate/future usage refuses; page ceiling has a fixed reason',async()=>{
  const month=dailyBudgetMonth(Date.now()/1000);
  for(const payload of [null,{}, {total_count:'1',data:[]},{total_count:-1,data:[]},{total_count:1,data:[]},
    {total_count:0,data:[meeting('x',month,[])]},{total_count:1,data:{}},
    ...[null,{id:1},{id:''},{start_time:-1},{start_time:month.end},{participants:null},{participants:[{}]},
      {participants:[{duration:-1}]},{participants:[{duration:'60'}]},{participants:[{duration:1e30}]}]
      .map(extra=>({total_count:1,data:[extra===null?null:{...meeting('x',month,[1]),...extra}]})),
    {total_count:2,data:[meeting('same',month,[]),meeting('same',month,[])]},
    {total_count:101,data:Array.from({length:101},(_,i)=>meeting(String(i),month,[]))},
  ])await assert.rejects(readDailyReportedMinutes(config,{month,fetchImpl:async()=>json(payload)}),DailyProviderError);
  await assert.rejects(readDailyReportedMinutes(config,{month,fetchImpl:async()=>json({total_count:5,data:[meeting('same',month,[1])]})}),DailyProviderError);
  let pages=0;
  await assert.rejects(readDailyReportedMinutes(config,{month,fetchImpl:async()=>json({total_count:21,data:[meeting(String(++pages),month,[1])]})}),error=>error.reason==='usage_too_large');
  assert.equal(pages,DAILY_USAGE_MAX_PAGES);
  let exact=0;assert.equal(await readDailyReportedMinutes(config,{month,fetchImpl:async()=>json({total_count:20,data:[meeting(String(++exact),month,[1])]})}),20);
  await assert.rejects(readDailyReportedMinutes(config,{month,fetchImpl:async()=>new Response('raw room secret',{status:503})}),DailyProviderError);
  await assert.rejects(readDailyReportedMinutes(config,{month,fetchImpl:async()=>{throw new Error('raw room');}}),DailyProviderError);
});
test('one total deadline covers multiple pages and hung fetch/body; remaining request is aborted',async()=>{
  assert.equal(DAILY_USAGE_TOTAL_TIMEOUT_MS,8000);
  const month=dailyBudgetMonth(Date.now()/1000);let pages=0,signal;
  await assert.rejects(readDailyReportedMinutes(config,{month,timeoutMs:30,fetchImpl:async(_url,init)=>{
    signal=init.signal;if(++pages===1)return json({total_count:2,data:[meeting('one',month,[1])]});return new Promise(()=>{});
  }}),error=>error.reason==='usage_timeout');
  assert.equal(pages,2);assert.equal(signal.aborted,true);
  await assert.rejects(readDailyReportedMinutes(config,{month,timeoutMs:20,fetchImpl:async()=>({status:200,json:()=>new Promise(()=>{})})}),error=>error.reason==='usage_timeout');
});
test('B1: decreased usage cannot reopen budget; increases apply; a new UTC month resets',async()=>{
  for(const reported of [0,8995]){
    const {db}=await database();const month=await seed(db,{minutes:8990,age:301});
    await assert.rejects(grant(db,{fetchImpl:async()=>json({total_count:reported?1:0,data:reported?[meeting('one',month,[reported*60])]:[]})}),DailyProviderError);
    assert.equal((await db.execute({sql:'SELECT attempts FROM auth_rate_limits WHERE key=?',args:[`${month.key}:u`]})).rows[0].attempts,Math.max(8990,reported));
  }
  const {db}=await database();let instant=Date.parse('2026-11-30T23:59:59Z')/1000;
  const old=await seed(db,{minutes:8990,at:instant});instant++;
  const client=clockClient(db,()=>instant),next=dailyBudgetMonth(instant);
  const admitted=await grant(client,{window:pass(instant),fetchImpl:async()=>json({total_count:1,data:[meeting('next',next,[1])]})});
  assert.equal(admitted.reportedMinutes,1);assert.equal(admitted.reservedMinutes,120);
  assert.equal((await db.execute({sql:'SELECT attempts FROM auth_rate_limits WHERE key=?',args:[`${old.key}:u`]})).rows[0].attempts,8990);
});
test('B1: a missing timestamp cannot erase an existing usage ratchet',async()=>{
  const {db}=await database();const month=await seed(db,{minutes:8990,age:301});
  await db.execute({sql:'DELETE FROM auth_rate_limits WHERE key=?',args:[`${month.key}:t`]});
  await assert.rejects(grant(db,{fetchImpl:async()=>json({total_count:0,data:[]})}),DailyProviderError);
  assert.equal((await db.execute({sql:'SELECT attempts FROM auth_rate_limits WHERE key=?',args:[`${month.key}:u`]})).rows[0].attempts,8990);
});
test('both seats fit exactly; one minute over refuses; fractional TTL rounds per seat',async()=>{
  const {db}=await database();await seed(db,{minutes:8880});const roomName=room();const w=await window(db);
  const result=await grant(db,{roomName,window:w});assert.equal(result.reservedMinutes,120);assert.equal(result.reused,false);assert.deepEqual(result.window,w);
  await assert.rejects(grant(db,{window:await window(db,1)}),DailyProviderError);
  const rows=(await db.execute("SELECT * FROM auth_rate_limits WHERE key GLOB 'dvb1:p:*'")).rows;
  assert.equal(rows.length,1);assert.equal(rows[0].expires_at,w.expiresAt+300);
  await db.execute("DELETE FROM auth_rate_limits WHERE key GLOB 'dvb1:p:*'");await seed(db,{minutes:8996});
  assert.equal((await grant(db,{window:await window(db,61)})).reservedMinutes,4);
});
test('partner and rejoin reuse both seats; later tokens never extend the pair envelope',async()=>{
  const {db,second}=await database();const at=await now(db);await seed(db,{minutes:8880,at});const roomName=room();
  await grant(db,{roomName,window:pass(at)});
  const reused=await grant(clockClient(second,()=>at+600),{roomName,window:pass(at+600)});
  assert.equal(reused.reused,true);assert.equal(reused.window.ttlSeconds,3000);assert.equal(reused.window.expiresAt,at+3600);
  assert.equal((await readDailyBudgetDiagnostics(db,{env})).reservedMinutes,120);
  await assert.rejects(grant(db,{roomName:room()}),DailyProviderError);
});
test('pair grace bridges just-ended usage and expires exactly after five minutes',async()=>{
  const {db}=await database();const at=await now(db);await seed(db,{minutes:8880,at});const roomName=room();
  await grant(db,{roomName,window:pass(at,60)});
  let instant=at+60;const client=clockClient(db,()=>instant);
  assert.equal((await readDailyBudgetDiagnostics(client,{env})).reservedMinutes,2);
  await assert.rejects(grant(client,{roomName,window:pass(instant)}),DailyProviderError,'grace cannot issue a new pass');
  instant=at+359;assert.equal((await readDailyBudgetDiagnostics(client,{env})).reservedMinutes,2);
  instant=at+360;assert.equal((await readDailyBudgetDiagnostics(client,{env})).reservedMinutes,0);
  await seed(db,{minutes:8882,at:instant});
  await assert.rejects(grant(client,{roomName,window:pass(instant)}),DailyProviderError);
  assert.equal((await grant(client,{cfg:{...config,monthlyMinuteBudget:9002},roomName,window:pass(instant)})).reservedMinutes,120);
});
test('legacy reservations count until expiry; prior-month pair reservations include their grace',async()=>{
  const {db}=await database();const at=await now(db);await seed(db,{minutes:8880});
  await db.execute({sql:'INSERT INTO auth_rate_limits VALUES (?,?,?),(?,?,?)',args:['dvb1:r:old',1,at+30,`dvb1:p:${room()}`,2,at+300]});
  await assert.rejects(grant(db),DailyProviderError);
  assert.equal((await readDailyBudgetDiagnostics(db,{env})).reservedMinutes,3);
  await db.execute("DELETE FROM auth_rate_limits WHERE key GLOB 'dvb1:r:*' OR key GLOB 'dvb1:p:*'");
  assert.equal((await grant(db)).reservedMinutes,120);
});
test('24 distinct pairs racing for the final two seats never overshoot',async()=>{
  const {db,url}=await database();await seed(db,{minutes:8880});const w=await window(db);
  const clients=Array.from({length:24},()=>createClient({url}));roots.at(-1)[1].push(...clients);
  const results=await Promise.allSettled(clients.map(client=>grant(client,{window:w})));
  assert.equal(results.filter(result=>result.status==='fulfilled').length,1);
  assert.equal((await readDailyBudgetDiagnostics(db,{env})).reservedMinutes,120);
});
test('two partners racing at the boundary both reuse one reservation',async()=>{
  const {db,second}=await database();await seed(db,{minutes:8880});const roomName=room(),w=await window(db);
  const results=await Promise.all([db,second].map(client=>grant(client,{roomName,window:w})));
  assert.equal(results.filter(result=>result.reused).length,1);assert.equal((await readDailyBudgetDiagnostics(db,{env})).reservedMinutes,120);
});
test('cold refresh is single-flight and pair refusal keeps both partners on the fallback',async()=>{
  const {db,second}=await database();let release,started;const began=new Promise(resolve=>{started=resolve;}),pending=new Promise(resolve=>{release=resolve;});
  const roomName=room();const first=grant(db,{roomName,fetchImpl:async()=>{started();return pending;}});await began;
  const tx=await second.transaction('write');await tx.execute("INSERT INTO auth_rate_limits VALUES ('unrelated',1,9999999999)");await tx.commit();tx.close();
  await assert.rejects(grant(second,{roomName}),DailyProviderError);
  release(json({total_count:0,data:[]}));await assert.rejects(first,DailyProviderError);
  assert.equal((await readDailyBudgetDiagnostics(db,{env})).reservedMinutes,0);
  const instant=await now(db)+31;const client=clockClient(db,()=>instant);
  assert.equal((await grant(client,{roomName,window:pass(instant)})).reservedMinutes,120);
});
test('failed refresh retries after 30 seconds; success stays coalesced for five minutes',async()=>{
  const {db}=await database();let instant=await now(db),calls=0;const client=clockClient(db,()=>instant);
  const failing=async()=>{calls++;throw new Error('secret room');};
  await assert.rejects(grant(client,{window:pass(instant),fetchImpl:failing}),DailyProviderError);
  instant+=29;await assert.rejects(grant(client,{window:pass(instant),fetchImpl:failing}),DailyProviderError);assert.equal(calls,1);
  instant+=2;const roomName=room();await grant(client,{roomName,window:pass(instant),fetchImpl:async()=>{calls++;return json({total_count:0,data:[]});}});
  instant+=60;await grant(client,{window:pass(instant)});assert.equal(calls,2);
  assert.equal((await readDailyBudgetDiagnostics(client,{env})).state,'ok');
});
test('page-ceiling diagnostics are distinct and contain no identifiers',async()=>{
  const {db}=await database();const month=dailyBudgetMonth(await now(db));let pages=0;
  await assert.rejects(grant(db,{fetchImpl:async()=>json({total_count:21,data:[meeting(String(++pages),month,[1])]})}),error=>error.reason==='usage_too_large');
  const card=await readDailyBudgetDiagnostics(db,{env});assert.equal(card.status,'failed');assert.equal(card.reason,'usage_too_large');
  assert.match(cardView('dailyVideo',card).lines.join(' '),/Usage too large to read/);
  assert.doesNotMatch(JSON.stringify(card),/raw-room|raw-participant|rc-[a-f0-9]{32}|token/);
});
test('lost/expired refresh fence or UTC rollover cannot publish authorizing evidence',async()=>{
  for(const lost of ['generation','expired','month']){
    const {db,second}=await database();let instant=await now(db);const month=dailyBudgetMonth(instant),client=clockClient(db,()=>instant);
    await assert.rejects(grant(client,{window:pass(instant),fetchImpl:async()=>{
      if(lost==='month')instant=month.end;
      else await second.execute({sql:`UPDATE auth_rate_limits SET ${lost==='generation'?'attempts=attempts+1':'expires_at=0'} WHERE key=?`,args:[`${month.key}:f`]});
      return json({total_count:0,data:[]});
    }}),DailyProviderError);
    assert.equal((await db.execute({sql:'SELECT * FROM auth_rate_limits WHERE key=?',args:[`${month.key}:u`]})).rows.length,0);
  }
});
test('bad grants, corrupt snapshots/reservations and clocks fail closed',async()=>{
  const {db}=await database();await seed(db);const w=await window(db),roomName=room();
  for(const [cfg,window,name] of [[null,w,roomName],[{monthlyMinuteBudget:0},w,roomName],[config,null,roomName],
    ...[0,-1,3601,1.5].map(ttl=>[config,{...w,ttlSeconds:ttl},roomName]),
    [config,{...w,expiresAt:w.expiresAt+1},roomName],[config,{...w,nowSeconds:w.nowSeconds+10,expiresAt:w.expiresAt+10},roomName],
    [config,pass(w.nowSeconds-60,60),roomName],[config,w,'raw-room'],[config,w,null]]){
    await assert.rejects(reserveDailyGrant(db,cfg,{window,roomName:name,fetchImpl:noFetch}),DailyProviderError);
  }
  const month=dailyBudgetMonth(w.nowSeconds);
  for(const [key,value] of [[`${month.key}:u`,-1],[`${month.key}:t`,w.nowSeconds+100],[`${month.key}:t`,month.start-1]]){
    await seed(db);await db.execute({sql:'UPDATE auth_rate_limits SET attempts=? WHERE key=?',args:[value,key]});await assert.rejects(grant(db),DailyProviderError);
  }
  await seed(db);
  for(const amount of [0,61,-1]){await db.execute({sql:"INSERT OR REPLACE INTO auth_rate_limits VALUES ('dvb1:r:corrupt',?,?)",args:[amount,w.expiresAt]});await assert.rejects(grant(db),DailyProviderError);}
  await db.execute("DELETE FROM auth_rate_limits WHERE key='dvb1:r:corrupt'");
  for(const amount of [1,121,3,2]){await db.execute({sql:'INSERT OR REPLACE INTO auth_rate_limits VALUES (?,?,?)',args:[`dvb1:p:${roomName}`,amount,w.expiresAt+300]});await assert.rejects(grant(db,{roomName}),DailyProviderError);}
  await assert.rejects(grant(clockClient(db,()=>NaN),{window:w}),DailyProviderError);
});
test('bounded lock retries map to budget errors; unknown commits and failed rollback never replay',async()=>{
  const {db}=await database();await seed(db);const w=await window(db);let starts=0;
  const flaky={execute:statement=>db.execute(statement),transaction:async mode=>{if(++starts<=2)throw Object.assign(new Error('locked'),{cause:{rawCode:'SQLITE_BUSY'}});return db.transaction(mode);}};
  await grant(flaky,{window:w});assert.equal(starts,4);
  let failures=0;const saturated={execute:statement=>db.execute(statement),transaction:async()=>{failures++;throw Object.assign(new Error('locked'),{code:'SQLITE_LOCKED'});}};
  await assert.rejects(grant(saturated,{window:w}),error=>error instanceof DailyProviderError&&error.stage==='budget');assert.equal(failures,4);
  let attempts=0,closes=0;
  const rollbackFailure={execute:statement=>db.execute(statement),transaction:async()=>{attempts++;return {execute:async()=>{throw Object.assign(new Error('locked'),{code:'SQLITE_BUSY'});},
    rollback:async()=>{throw new Error('rollback failed');},close:async()=>{closes++;throw new Error('close failed');}};}};
  await assert.rejects(grant(rollbackFailure,{window:w}),DailyProviderError);assert.equal(attempts,1);assert.equal(closes,1);
  let commits=0;const uncertain={execute:statement=>db.execute(statement),transaction:async mode=>{const tx=await db.transaction(mode);return {
    execute:statement=>tx.execute(statement),rollback:()=>tx.rollback(),close:()=>tx.close(),
    commit:async()=>{await tx.commit();if(++commits===1)throw new Error('lost acknowledgement');}};}};
  await assert.rejects(grant(uncertain,{window:w}),DailyProviderError);assert.equal(commits,1);
  assert.equal((await readDailyBudgetDiagnostics(db,{env})).reservedMinutes,240);
});
test('B2: disabled is neutral, exhausted is warning, genuinely failed reads are red',async()=>{
  const {db}=await database();
  assert.deepEqual(await readDailyBudgetDiagnostics(db,{env}),{reportedMinutes:null,reservedMinutes:0,budget:9000,state:'unknown',status:'unknown',reason:'usage_unknown'});
  for(const [minutes,state,status] of [[0,'ok','healthy'],[8099,'ok','healthy'],[8100,'near','degraded'],[9000,'paused','degraded'],[9001,'paused','degraded']]){
    await seed(db,{minutes});const card=await readDailyBudgetDiagnostics(db,{env});assert.equal(card.state,state);assert.equal(card.status,status);
    assert.equal(card.reason,state==='paused'?'budget_reached':null);assert.match(cardView('dailyVideo',card).lines[0],/participant-minutes/);
  }
  const disabled=await readDailyBudgetDiagnostics(db,{env:{}});assert.equal(disabled.status,'unknown');assert.equal(disabled.reason,'not_enabled');
  const view=cardView('dailyVideo',disabled);assert.equal(view.label,'Not enabled');assert.equal(view.tone,'neutral');
  const exhausted=cardView('dailyVideo',{status:'degraded',reason:'budget_reached',state:'paused'});assert.equal(exhausted.tone,'warning');assert.equal(exhausted.label,'Paused — budget reached');
  for(const broken of [{...env,DAILY_MONTHLY_MINUTE_BUDGET:''},{...env,DAILY_DOMAIN:'other.daily.co'},{...env,DAILY_API_KEY:''}]){
    const card=await readDailyBudgetDiagnostics(db,{env:broken});assert.equal(card.status,'failed');assert.equal(card.reason,'configuration');
  }
  await seed(db,{age:301});assert.equal((await readDailyBudgetDiagnostics(db,{env})).state,'unknown');
  for(const reason of ['usage_timeout','usage_unavailable','store_unavailable','usage_unknown','configuration'])assert.ok(cardView('dailyVideo',{status:'failed',reason}).lines.length);
  assert.match(cardView('dailyVideo',{status:'unknown',state:'secret'}).lines.join(' '),/unknown/);
  const before=(await db.execute('SELECT * FROM auth_rate_limits')).rows;await readDailyBudgetDiagnostics(db,{env});assert.deepEqual((await db.execute('SELECT * FROM auth_rate_limits')).rows,before);
  await db.execute('DROP TABLE auth_rate_limits');
  assert.equal((await readDailyBudgetDiagnostics(db,{env})).status,'failed');assert.equal((await readDailyBudgetDiagnostics(db,{env:{}})).status,'unknown');
});
