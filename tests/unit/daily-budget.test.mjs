// #490 / ID-106: provider-free budget tests using isolated local SQLite files.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, test } from 'node:test';
import { createClient } from '@libsql/client';
import { DailyProviderError, dailyMonthlyMinuteBudget, dailyVideoConfiguration } from '../../api/_daily-video.js';
import { dailyBudgetMonth, readDailyReportedMinutes, reserveDailyGrant, readDailyBudgetDiagnostics,
  DAILY_USAGE_MAX_PAGES } from '../../api/_daily-budget.js';
import { cardView } from '../../assets/admin-diagnostics.js';

const env={DAILY_VIDEO_ENABLED:'true',DAILY_API_KEY:'synthetic-key-not-a-real-secret',DAILY_DOMAIN:'randori-circle.daily.co'};
const config=dailyVideoConfiguration(env);
let roots=[];
afterEach(()=>{ for(const [root,clients] of roots){ for(const client of clients) client.close(); rmSync(root,{recursive:true,force:true}); } roots=[]; });
async function database(){
  const root=mkdtempSync(join(tmpdir(),'rc-budget-'));
  const url=`file:${join(root,'test.db')}`;
  const db=createClient({url}); roots.push([root,[db]]);
  await db.execute('CREATE TABLE auth_rate_limits(key TEXT PRIMARY KEY,attempts INTEGER NOT NULL,expires_at INTEGER NOT NULL)');
  const second=createClient({url}); roots.at(-1)[1].push(second);
  return {db,second};
}
async function now(db){ return Number((await db.execute("SELECT CAST(strftime('%s','now') AS INTEGER) AS seconds")).rows[0].seconds); }
async function window(db,ttlSeconds=3600){ const at=await now(db); return {nowSeconds:at,ttlSeconds,expiresAt:at+ttlSeconds}; }
async function seed(db,{minutes=0,age=0}={}){
  const at=await now(db),month=dailyBudgetMonth(at);
  for(const [key,value] of [[`${month.key}:u`,minutes],[`${month.key}:t`,at-age]])
    await db.execute({sql:'INSERT OR REPLACE INTO auth_rate_limits VALUES (?,?,?)',args:[key,value,month.end+3600]});
  return month;
}
const json=payload=>new Response(JSON.stringify(payload),{status:200});
const noFetch=()=>{ assert.fail('no provider network allowed'); };
const meeting=(id,month,durations,extra={})=>({id,room:'private-room-do-not-log',start_time:month.start+15,
  ongoing:false,participants:durations.map(duration=>({participant_id:'private-participant',join_time:month.start+15,duration})),...extra});

test('budget defaults only when unset; malformed/unsafe settings hide the capability',()=>{
  assert.equal(dailyMonthlyMinuteBudget({}),9000);
  for(const raw of ['1','60','9000','10000','9007199254740991']) assert.equal(dailyMonthlyMinuteBudget({DAILY_MONTHLY_MINUTE_BUDGET:raw}),Number(raw));
  for(const raw of ['', '0','-1','1.5','1e4','Infinity','NaN','+2',' 9000','9000 ','09','9007199254740992',null,9000]){
    const invalid={...env,DAILY_MONTHLY_MINUTE_BUDGET:raw};
    assert.equal(dailyMonthlyMinuteBudget(invalid),null,String(raw));
    assert.equal(dailyVideoConfiguration(invalid),null);
  }
});

test('calendar UTC month includes leap February and year rollover',()=>{
  for(const [at,start,end] of [
    ['2028-02-29T23:59:59Z','2028-02-01T00:00:00Z','2028-03-01T00:00:00Z'],
    ['2026-12-31T23:59:59Z','2026-12-01T00:00:00Z','2027-01-01T00:00:00Z'],
    ['2027-01-01T00:00:00Z','2027-01-01T00:00:00Z','2027-02-01T00:00:00Z'],
  ]){
    const month=dailyBudgetMonth(Date.parse(at)/1000);
    assert.equal(month.start,Date.parse(start)/1000); assert.equal(month.end,Date.parse(end)/1000);
  }
  assert.throws(()=>dailyBudgetMonth(NaN),DailyProviderError);
});

test('pagination sums rounded participant seconds, includes ongoing and never uses meeting duration/max seats',async()=>{
  const month=dailyBudgetMonth(Date.parse('2026-11-19T16:00:00Z')/1000),calls=[];
  const pages=[{total_count:3,data:[meeting('one',month,[0,1,60,61]),meeting('two',month,[15,120],{ongoing:true,duration:9999,max_participants:99})]},
    {total_count:3,data:[meeting('three',month,[0.1,59.9],{start_time:month.start})]}];
  const minutes=await readDailyReportedMinutes(config,{month,fetchImpl:async(url,init)=>{
    calls.push({url:new URL(url),init}); return json(pages.shift());
  }});
  assert.equal(minutes,9);
  assert.equal(calls.length,2);
  for(const {url,init} of calls){
    assert.equal(url.pathname,'/v1/meetings'); assert.equal(url.searchParams.get('timeframe_start'),String(month.start));
    assert.equal(url.searchParams.get('timeframe_end'),String(month.end)); assert.equal(url.searchParams.get('limit'),'100');
    assert.equal(url.searchParams.has('no_participants'),false); assert.equal(url.searchParams.has('ongoing'),false);
    assert.equal(init.method,'GET'); assert.equal(init.body,undefined); assert.equal(init.redirect,'error'); assert.ok(init.signal instanceof AbortSignal);
  }
  assert.equal(calls[0].url.searchParams.has('starting_after'),false);
  assert.equal(calls[1].url.searchParams.get('starting_after'),'two');
  assert.equal(await readDailyReportedMinutes(config,{month,fetchImpl:async()=>json({total_count:0,data:[]})}),0);
});

test('malformed, truncated, duplicate, noncurrent-month and over-bound usage fails closed',async()=>{
  const month=dailyBudgetMonth(Date.now()/1000);
  for(const payload of [null,{}, {total_count:'1',data:[]},{total_count:-1,data:[]},{total_count:1,data:[]},
    {total_count:0,data:[meeting('x',month,[])]}, {total_count:1,data:{}},
    ...[null, {id:1}, {id:''}, {start_time:month.start-1}, {start_time:month.end}, {participants:null},
      {participants:[{}]},{participants:[{duration:-1}]},{participants:[{duration:'60'}]},
      {participants:[{duration:1e30}]}].map(extra=>({total_count:1,data:[extra===null?null:{...meeting('x',month,[1]),...extra}]})),
    {total_count:2,data:[meeting('same',month,[]),meeting('same',month,[])]},
    {total_count:101,data:Array.from({length:101},(_,i)=>meeting(String(i),month,[]))},
  ]) await assert.rejects(readDailyReportedMinutes(config,{month,fetchImpl:async()=>json(payload)}),DailyProviderError,JSON.stringify(payload));
  // A repeated cursor cannot loop, even when the provider claims more records.
  await assert.rejects(readDailyReportedMinutes(config,{month,fetchImpl:async()=>json({total_count:5,data:[meeting('same',month,[1])]})}),DailyProviderError);
  let pages=0;
  await assert.rejects(readDailyReportedMinutes(config,{month,fetchImpl:async()=>json({total_count:21,data:[meeting(String(++pages),month,[1])]})}),DailyProviderError);
  assert.equal(pages,DAILY_USAGE_MAX_PAGES);
  let exact=0;
  assert.equal(await readDailyReportedMinutes(config,{month,fetchImpl:async()=>json({total_count:20,data:[meeting(String(++exact),month,[1])]})}),20);
  await assert.rejects(readDailyReportedMinutes(config,{month,fetchImpl:async()=>new Response('secret room private-token',{status:503})}),DailyProviderError);
  await assert.rejects(readDailyReportedMinutes(config,{month,fetchImpl:async()=>{ throw new Error('secret room'); }}),DailyProviderError);
});

test('equality passes, one minute beyond refuses before provider creation; partial TTL rounds up',async()=>{
  const {db}=await database(); await seed(db,{minutes:8940});
  const grant=await reserveDailyGrant(db,config,{window:await window(db),fetchImpl:noFetch});
  assert.deepEqual(grant,{reportedMinutes:8940,reservedMinutes:60,budget:9000});
  await assert.rejects(reserveDailyGrant(db,config,{window:await window(db,1),fetchImpl:noFetch}),DailyProviderError);
  assert.equal((await db.execute("SELECT COUNT(*) AS n FROM auth_rate_limits WHERE key GLOB 'dvb1:r:*'")).rows[0].n,1);
  await db.execute("DELETE FROM auth_rate_limits WHERE key GLOB 'dvb1:r:*'");
  await seed(db,{minutes:8998});
  assert.equal((await reserveDailyGrant(db,config,{window:await window(db,61),fetchImpl:noFetch})).reservedMinutes,2);
});

test('reservations expire exactly at token expiry; active prior-month reservations count',async()=>{
  const {db}=await database(); await seed(db,{minutes:8940}); const at=await now(db);
  await db.execute({sql:'INSERT INTO auth_rate_limits VALUES (?,?,?),(?,?,?)',args:['dvb1:r:prior-month',1,at+30,'dvb1:r:expired',60,at]});
  await assert.rejects(reserveDailyGrant(db,config,{window:await window(db),fetchImpl:noFetch}),DailyProviderError);
  await db.execute({sql:"UPDATE auth_rate_limits SET expires_at=? WHERE key='dvb1:r:prior-month'",args:[at]});
  assert.equal((await reserveDailyGrant(db,config,{window:await window(db),fetchImpl:noFetch})).reservedMinutes,60);
  assert.equal((await db.execute("SELECT COUNT(*) AS n FROM auth_rate_limits WHERE key='dvb1:r:expired'")).rows[0].n,0);
});

test('two database clients racing for the last grant cannot both reserve',async()=>{
  const {db,second}=await database(); await seed(db,{minutes:8940}); const pass=await window(db);
  const results=await Promise.allSettled([db,second].map(client=>reserveDailyGrant(client,config,{window:pass,fetchImpl:noFetch})));
  assert.equal(results.filter(result=>result.status==='fulfilled').length,1);
  assert.equal((await readDailyBudgetDiagnostics(db,{env})).reservedMinutes,60);
});

test('fresh snapshot permits admission despite provider read failure; cold failure throttles across clients',async()=>{
  const {db,second}=await database(); let calls=0;
  const failing=async()=>{ calls++; throw new Error('private room secret token'); };
  await assert.rejects(reserveDailyGrant(db,config,{window:await window(db),fetchImpl:failing}),DailyProviderError);
  await assert.rejects(reserveDailyGrant(second,config,{window:await window(db),fetchImpl:failing}),DailyProviderError);
  assert.equal(calls,1);
  await seed(db);
  await reserveDailyGrant(second,config,{window:await window(db),fetchImpl:failing});
  assert.equal(calls,1,'a fresh snapshot is used without another read');
  await seed(db,{age:300});
  await assert.rejects(reserveDailyGrant(db,config,{window:await window(db),fetchImpl:failing}),DailyProviderError);
  assert.equal(calls,1,'stale snapshot cannot bypass failed refresh cooldown');
});

test('single-flight refresh is outside the DB lock, persists only aggregates and shares result',async()=>{
  const {db,second}=await database(); let release,started; const began=new Promise(resolve=>{started=resolve;});
  const pending=new Promise(resolve=>{release=resolve;}); let calls=0;
  const first=reserveDailyGrant(db,config,{window:await window(db),fetchImpl:async()=>{ calls++; started(); return pending; }});
  await began;
  const tx=await second.transaction('write'); await tx.execute("INSERT INTO auth_rate_limits VALUES ('unrelated',1,9999999999)"); await tx.commit(); tx.close();
  await assert.rejects(reserveDailyGrant(second,config,{window:await window(db),fetchImpl:noFetch}),DailyProviderError);
  const month=dailyBudgetMonth(await now(db));
  release(json({total_count:1,data:[meeting('private-meeting',month,[61,15],{ongoing:true})]}));
  assert.equal((await first).reportedMinutes,3);
  assert.equal((await reserveDailyGrant(second,config,{window:await window(db),fetchImpl:noFetch})).reservedMinutes,120);
  assert.equal(calls,1);
  const stored=JSON.stringify((await db.execute("SELECT * FROM auth_rate_limits WHERE key GLOB 'dvb1:*'")).rows);
  assert.doesNotMatch(stored,/private-meeting|private-room|private-participant|synthetic-key|token/);
  await db.execute({sql:'UPDATE auth_rate_limits SET attempts=attempts-300 WHERE key=?',args:[`${month.key}:t`]});
  await db.execute({sql:'UPDATE auth_rate_limits SET expires_at=0 WHERE key=?',args:[`${month.key}:f`]});
  assert.equal((await reserveDailyGrant(db,config,{window:await window(db),fetchImpl:async()=>{calls++; return json({total_count:0,data:[]});}})).reportedMinutes,0);
  assert.equal(calls,2);
});

test('lost refresh fence and over-age response cannot publish an authorizing snapshot',async()=>{
  for(const lost of ['generation','expired']){
    const {db,second}=await database(); const month=dailyBudgetMonth(await now(db));
    await assert.rejects(reserveDailyGrant(db,config,{window:await window(db),fetchImpl:async()=>{
      await second.execute({sql:`UPDATE auth_rate_limits SET ${lost==='generation'?'attempts=attempts+1':'expires_at=0'} WHERE key=?`,args:[`${month.key}:f`]});
      return json({total_count:0,data:[]});
    }}),DailyProviderError);
    assert.equal((await db.execute({sql:'SELECT * FROM auth_rate_limits WHERE key=?',args:[`${month.key}:u`]})).rows.length,0);
  }
});

test('bad grants, corrupt evidence/store and expired passes fail closed',async()=>{
  const {db}=await database(); const pass=await window(db); await seed(db);
  for(const [cfg,w] of [[null,pass],[{monthlyMinuteBudget:0},pass],[config,null],
    ...[0,-1,3601,1.5].map(ttl=>[config,{...pass,ttlSeconds:ttl}]),
    [config,{...pass,expiresAt:pass.expiresAt+1}], [config,{...pass,nowSeconds:pass.nowSeconds+10,expiresAt:pass.expiresAt+10}],
    [config,{nowSeconds:pass.nowSeconds-60,ttlSeconds:60,expiresAt:pass.nowSeconds}]]){
    await assert.rejects(reserveDailyGrant(db,cfg,{window:w,fetchImpl:noFetch}),DailyProviderError);
  }
  const month=dailyBudgetMonth(pass.nowSeconds);
  for(const [key,value] of [[`${month.key}:u`,-1],[`${month.key}:t`,pass.nowSeconds+100],[`${month.key}:t`,month.start-1]]){
    await seed(db); await db.execute({sql:'UPDATE auth_rate_limits SET attempts=? WHERE key=?',args:[value,key]});
    await assert.rejects(reserveDailyGrant(db,config,{window:pass,fetchImpl:noFetch}),DailyProviderError);
  }
  await seed(db);
  for(const amount of [0,61,-1]){
    await db.execute({sql:"INSERT OR REPLACE INTO auth_rate_limits VALUES ('dvb1:r:corrupt',?,?)",args:[amount,pass.expiresAt]});
    await assert.rejects(reserveDailyGrant(db,config,{window:pass,fetchImpl:noFetch}),DailyProviderError);
  }
  await db.execute('DROP TABLE auth_rate_limits');
  await assert.rejects(reserveDailyGrant(db,config,{window:pass,fetchImpl:noFetch}));
  assert.equal((await readDailyBudgetDiagnostics(db,{env})).state,'unknown');
});

test('bounded lock retries never replay unknown commit outcomes or failed rollbacks',async()=>{
  const {db}=await database(); await seed(db); const pass=await window(db);
  let starts=0;
  const flaky={transaction:async mode=>{
    if(++starts<=2) throw Object.assign(new Error('locked'),{cause:{rawCode:'SQLITE_BUSY'}});
    return db.transaction(mode);
  }};
  await reserveDailyGrant(flaky,config,{window:pass,fetchImpl:noFetch});
  assert.equal(starts,4,'two retries, successful cache transaction, successful reservation transaction');

  let failures=0;
  const saturated={transaction:async()=>{ failures++; throw Object.assign(new Error('locked'),{code:'SQLITE_LOCKED'}); }};
  await assert.rejects(reserveDailyGrant(saturated,config,{window:pass,fetchImpl:noFetch}));
  assert.equal(failures,4,'bounded attempts, no provider calls');

  let attempts=0,closes=0;
  const rollbackFailure={transaction:async()=>{
    attempts++;
    return {execute:async()=>{throw Object.assign(new Error('locked'),{code:'SQLITE_BUSY'});},
      rollback:async()=>{throw new Error('rollback failed');},close:async()=>{closes++; throw new Error('close failed');}};
  }};
  await assert.rejects(reserveDailyGrant(rollbackFailure,config,{window:pass,fetchImpl:noFetch}));
  assert.equal(attempts,1); assert.equal(closes,1,'failed rollback forbids retry, close remains best effort');

  let commits=0;
  const uncertain={transaction:async mode=>{
    const tx=await db.transaction(mode);
    return {execute:statement=>tx.execute(statement),rollback:()=>tx.rollback(),close:()=>tx.close(),
      commit:async()=>{ await tx.commit(); if(++commits===2) throw new Error('lost commit acknowledgement'); }};
  }};
  await assert.rejects(reserveDailyGrant(uncertain,config,{window:pass,fetchImpl:noFetch}),/lost commit/);
  assert.equal(commits,2,'unknown acknowledgement never retried');
  assert.equal((await readDailyBudgetDiagnostics(db,{env})).reservedMinutes,120,'uncertain persisted reservation is retained');
});

function clockClient(db,readClock){
  return {transaction:async mode=>{
    const tx=await db.transaction(mode);
    return {execute:statement=>typeof statement==='string'&&statement.includes("strftime('%s','now')")
      ?Promise.resolve({rows:[{seconds:readClock()}]}):tx.execute(statement),
      commit:()=>tx.commit(),rollback:()=>tx.rollback(),close:()=>tx.close()};
  }};
}
test('a refresh crossing its five-minute age limit or UTC month cannot publish evidence',async()=>{
  for(const kind of ['age','month']){
    const {db}=await database();
    let instant=kind==='age'?Date.parse('2026-11-19T17:00:00Z')/1000:Date.parse('2026-11-30T23:59:59Z')/1000;
    const month=dailyBudgetMonth(instant),client=clockClient(db,()=>instant);
    const pass={nowSeconds:instant,ttlSeconds:3600,expiresAt:instant+3600};
    await assert.rejects(reserveDailyGrant(client,config,{window:pass,fetchImpl:async()=>{
      instant+=kind==='age'?300:1;
      return json({total_count:0,data:[]});
    }}),DailyProviderError);
    assert.equal((await db.execute({sql:'SELECT * FROM auth_rate_limits WHERE key=?',args:[`${month.key}:u`]})).rows.length,0);
  }
  const {db}=await database(); const pass=await window(db);
  await assert.rejects(reserveDailyGrant(clockClient(db,()=>NaN),config,{window:pass,fetchImpl:noFetch}),DailyProviderError);
});

test('admin diagnostics are aggregate-only, provider-free and state-labelled',async()=>{
  const {db}=await database();
  assert.deepEqual(await readDailyBudgetDiagnostics(db,{env}),{reportedMinutes:null,reservedMinutes:0,budget:9000,state:'unknown',status:'unknown'});
  for(const [minutes,state,status] of [[0,'ok','healthy'],[8099,'ok','healthy'],[8100,'near','degraded'],[9000,'paused','failed'],[9001,'paused','failed']]){
    await seed(db,{minutes}); const card=await readDailyBudgetDiagnostics(db,{env});
    assert.deepEqual(card,{reportedMinutes:minutes,reservedMinutes:0,budget:9000,state,status});
    const view=cardView('dailyVideo',card); assert.equal(view.title,'Daily video allowance');
    assert.match(view.lines.join(' '),new RegExp(`State: ${state}`)); assert.match(view.lines[0],/participant-minutes/);
  }
  for(const disabled of [{},{...env,DAILY_MONTHLY_MINUTE_BUDGET:''},{...env,DAILY_DOMAIN:'other.daily.co'},
    {...env,DAILY_API_KEY:''},{...env,RANDORI_LOCAL_RUNTIME:'true'}]) assert.equal((await readDailyBudgetDiagnostics(db,{env:disabled})).state,'paused');
  await seed(db,{age:300}); assert.equal((await readDailyBudgetDiagnostics(db,{env})).state,'unknown');
  assert.match(cardView('dailyVideo',{status:'unknown',state:'secret',reportedMinutes:null}).lines.join(' '),/unknown/);
  const before=(await db.execute('SELECT * FROM auth_rate_limits')).rows;
  await readDailyBudgetDiagnostics(db,{env});
  assert.deepEqual((await db.execute('SELECT * FROM auth_rate_limits')).rows,before,'admin reads never mutate');
});
