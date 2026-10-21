// Issue #292: the circle health read model and its small-cell suppression,
// against a real migrated SQLite database and a hand-built pairing history.
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { createClient } from '@libsql/client';

import {
  aggregateCycle,
  buildCircleHealth,
  CIRCLE_HEALTH_LOOKBACK,
  CIRCLE_HEALTH_MIN_CELL,
  CIRCLE_HEALTH_SQL,
  CIRCLE_HEALTH_WINDOW,
  circleHealthEnabled,
  circleHealthQueryValid,
  countCell,
  median,
  parseStoredInstant,
  readCircleHealth,
  smallCell,
  suppressCycleMetrics,
} from '../../api/_circle-health.js';
import { prepareMigrationConnection } from '../../db/migration-runner.js';
import { insertPrimaryWeek, insertSecondaryPublication } from '../support/circle-health-fixture.mjs';
import { createMigratedDatabase } from '../support/migrated-db.mjs';

const NOW=Date.parse('2026-10-20T12:00:00.000Z');
const TZ='Europe/London';
const { url, cleanup }=await createMigratedDatabase({ prefix:'randori-circle-health-', filename:'health.sqlite' });
const db=createClient({ url });

const ok=value=>({ status:'ok', value });
const hidden={ status:'suppressed', value:null };
const none={ status:'no_data', value:null };
const untracked={ status:'not_tracked', value:null };

// Weekly ISO labels and Sunday 08:00 London starts, newest first.
function week(offset){
  const start=Date.parse('2026-10-18T07:00:00.000Z')-offset*7*86400000;
  const weekNumber=43-offset;
  return {
    label:`2026-W${String(weekNumber).padStart(2,'0')}`,
    weekStart:new Date(start).toISOString(),
    publishedAt:new Date(start+5000).toISOString(),
  };
}

before(async()=>{
  await prepareMigrationConnection(db);
  const accounts=[1,2,3,4,5,6,7,...Array.from({ length:12 },(_,index)=>101+index)];
  await db.batch([
    `INSERT INTO auth_accounts (id,email,password_hash,display_name,color) VALUES ${accounts
      .map(id=>`(${id},'member${id}@example.test','x','Member ${id}','#123456')`).join(',')}`,
    `INSERT INTO circles (id,public_id,slug,name,is_primary,created_by,archived_at) VALUES
      (10,'circle-primary','primary','Primary',1,1,NULL),
      (20,'circle-second','second','Second',0,6,NULL),
      (21,'circle-other','other','Other',0,7,NULL),
      (30,'circle-archived','archived','Archived',0,1,'2026-10-01T00:00:00.000Z')`,
    // 1 and 3 own the primary (ID-69: owners can be many); 4 was demoted to
    // member; 5 is an owner whose membership is inactive.
    `INSERT INTO circle_memberships (circle_id,user_id,role,status) VALUES
      (10,1,'owner','active'),(10,2,'member','active'),(10,3,'owner','active'),
      (10,4,'member','active'),(10,5,'owner','inactive'),
      (20,6,'owner','active'),(20,1,'member','active'),
      (21,7,'owner','active'),(30,1,'owner','active')`,
  ],'write');

  // Index 0 (in progress): 7 available, one solo, 2 of 3 pairs agreed a time,
  // one pair completed.
  await insertPrimaryWeek(db,{ ...week(0), participants:[101,102,103,104,105,106,107], groups:[
    { members:[101,102], agreed:'2026-10-21T18:00:00.000Z', receipts:[101,102] },
    { members:[103,104], agreed:'2026-10-22T18:00:00.000Z', receipts:[103] },
    { members:[105,106] },
    { members:[107] },
  ] });
  // Index 1: a healthy cycle where every pair agreed and two pairs completed.
  const w42=week(1);
  const hoursAfter=hours=>new Date(Date.parse(w42.publishedAt)+hours*3600000).toISOString();
  await insertPrimaryWeek(db,{ ...w42, participants:[101,102,103,104,105,106,107,108], groups:[
    { members:[101,102], agreed:hoursAfter(12), receipts:[101,102] },
    { members:[103,104], agreed:hoursAfter(24), receipts:[103,104] },
    { members:[105,106], agreed:hoursAfter(48), receipts:[105] },
    { members:[107,108], agreed:hoursAfter(96) },
  ] });
  // Index 2: only two members took part, so the whole cycle is withheld.
  await insertPrimaryWeek(db,{ ...week(2), participants:[101,102], groups:[
    { members:[101,102], agreed:'2026-10-05T18:00:00.000Z', receipts:[101,102] },
  ] });
  // Index 3: published while nobody was available.
  await insertPrimaryWeek(db,{ ...week(3) });
  // Index 4: a legacy triad with a free-text agreement, plus one pair.
  await insertPrimaryWeek(db,{ ...week(4), participants:[101,102,103,104,105], groups:[
    { members:[101,102,103], agreed:'Tuesday 7pm', receipts:[101,102,103] },
    { members:[104,105], agreed:'2026-09-24T18:00:00.000Z' },
  ] });
  // Index 5: three members, one pair and a solo.
  await insertPrimaryWeek(db,{ ...week(5), participants:[104,105,106], groups:[
    { members:[104,105] }, { members:[106] },
  ] });
  // Index 6: two pairs, nothing agreed.
  await insertPrimaryWeek(db,{ ...week(6), participants:[104,106,107,108], groups:[
    { members:[104,107] }, { members:[106,108] },
  ] });
  // Index 7 (oldest shown): repeats only from inside its 8-cycle lookback.
  await insertPrimaryWeek(db,{ ...week(7), participants:[101,104,105,106,109,110,111,112], groups:[
    { members:[109,110] }, { members:[111,112] }, { members:[101,105] }, { members:[104,106] },
  ] });
  // Lookback-only cycles (indexes 8..15) and one cycle past the lookback.
  const lookback=[[107,109],[103,104],[105,106],[110,111],[101,105],[101,103],[102,105],[109,110],[111,112]];
  for(const [offset,members] of lookback.entries()){
    await insertPrimaryWeek(db,{ ...week(8+offset), participants:members, groups:[{ members }] });
  }
  // Demo and legacy non-ISO weeks never count.
  await insertPrimaryWeek(db,{ label:'2026-W45', weekStart:'2026-11-01T08:00:00.000Z',
    publishedAt:'2026-11-01T08:00:05.000Z', isDemo:1, participants:[101,102], groups:[{ members:[101,102] }] });
  await insertPrimaryWeek(db,{ label:'2026-W44-demo-1234', weekStart:'2026-10-25T08:00:00.000Z',
    participants:[103,104], groups:[{ members:[103,104] }] });
  await insertPrimaryWeek(db,{ label:'legacy-week', weekStart:'2026-10-19T08:00:00.000Z',
    participants:[105,106], groups:[{ members:[105,106] }] });

  // Secondary circle 20 and an unrelated secondary circle 21.
  await insertSecondaryPublication(db,{ circleId:20, cycleId:'2026-W42', startsAt:'2026-10-11T07:00:00.000Z',
    publishedAt:'2026-10-11T07:00:01.000Z', groups:[{ members:[101,102] },{ members:[103,104] }] });
  await insertSecondaryPublication(db,{ circleId:20, cycleId:'2026-W43', startsAt:'2026-10-18T07:00:00.000Z',
    publishedAt:'2026-10-18T07:00:01.000Z', unavailable:[105], groups:[
      { members:[101,102], agreed:'2026-10-20T18:00:00.000Z' },
      { members:[103,104], agreed:'2026-10-21T18:00:00.000Z' },
      { members:[6] },
    ] });
  await insertSecondaryPublication(db,{ circleId:21, cycleId:'2026-W43', startsAt:'2026-10-18T07:00:00.000Z',
    publishedAt:'2026-10-18T07:00:01.000Z', groups:[{ members:[7,108] },{ members:[109,110] }] });
});

after(()=>{
  db.close();
  cleanup();
});

function byCycle(health){
  return Object.fromEntries(health.cycles.map(cycle=>[cycle.cycle_id,cycle]));
}

test('the flag needs both CIRCLE_HEALTH_ENABLED and circle membership',()=>{
  assert.equal(circleHealthEnabled({}),false);
  assert.equal(circleHealthEnabled({ CIRCLE_HEALTH_ENABLED:'true' }),false);
  assert.equal(circleHealthEnabled({ CIRCLE_MEMBERSHIP_ENABLED:'true' }),false);
  assert.equal(circleHealthEnabled({ CIRCLE_HEALTH_ENABLED:'1',CIRCLE_MEMBERSHIP_ENABLED:'true' }),false);
  assert.equal(circleHealthEnabled({ CIRCLE_HEALTH_ENABLED:'true',CIRCLE_MEMBERSHIP_ENABLED:'true' }),true);
  assert.equal(circleHealthEnabled(null),false);
});

test('only the grouped endpoint query is accepted',()=>{
  assert.equal(circleHealthQueryValid({ url:'/api/circle/health' }),true);
  assert.equal(circleHealthQueryValid({ url:'/api/ops?endpoint=circle-health',query:{ endpoint:'circle-health' } }),true);
  assert.equal(circleHealthQueryValid({ url:'/api/circle/health',query:{ circle_id:'20' } }),false);
  assert.equal(circleHealthQueryValid({ url:'/api/circle/health?circle_id=20' }),false);
  assert.equal(circleHealthQueryValid({ url:'/api/ops?endpoint=circle-health&endpoint=circle-health' }),false);
  assert.equal(circleHealthQueryValid({ url:'/api/ops?endpoint=weekly' }),false);
  assert.equal(circleHealthQueryValid({ url:'/api/ops',query:{ endpoint:['circle-health'] } }),false);
  assert.equal(circleHealthQueryValid({ url:'http://[bad' }),false);
  assert.equal(circleHealthQueryValid({ query:[] }),true);
});

test('a count covering one or two members is suppressed; zero and three or more are shown',()=>{
  assert.equal(CIRCLE_HEALTH_MIN_CELL,3);
  assert.deepEqual([0,1,2,3,4].map(value=>smallCell(value)),[false,true,true,false,false]);
  assert.deepEqual(countCell(0),ok(0));
  assert.deepEqual(countCell(1),hidden);
  assert.deepEqual(countCell(2),hidden);
  assert.deepEqual(countCell(3),ok(3));
  // Complement: 6 paired and 4 scheduled would reveal that one pair did not.
  assert.deepEqual(countCell(4,{ relatedCounts:[6] }),hidden);
  assert.deepEqual(countCell(4,{ relatedCounts:[8] }),ok(4));
  assert.deepEqual(countCell(0,{ relatedCounts:[2] }),hidden);
  assert.deepEqual(countCell(6,{ relatedCounts:[6,4] }),hidden);
  assert.deepEqual(countCell(2,{ minimum:2 }),ok(2));
});

test('median handles odd and even lists without mutating the input',()=>{
  const values=[96,12,48,24];
  assert.equal(median(values),36);
  assert.deepEqual(values,[96,12,48,24]);
  assert.equal(median([5,1,3]),3);
  assert.equal(median([7]),7);
});

test('stored instants accept SQLite and ISO forms only',()=>{
  assert.equal(parseStoredInstant('2026-10-18 08:00:05'),Date.parse('2026-10-18T08:00:05Z'));
  assert.equal(parseStoredInstant('2026-10-18T07:00:00.000Z'),Date.parse('2026-10-18T07:00:00.000Z'));
  assert.equal(parseStoredInstant('2026-10-18T08:00:00+01:00'),Date.parse('2026-10-18T07:00:00Z'));
  assert.equal(parseStoredInstant('Tuesday 7pm'),null);
  assert.equal(parseStoredInstant('2026-02-31T07:00:00Z'),null);
  assert.equal(parseStoredInstant(null),null);
});

test('the cycle floor withholds every metric when only one or two members took part',()=>{
  const raw={ available:2,paired:2,solo:0,scheduled:2,completed:2,leadHours:[5],leadMembers:2,
    humanGroups:1,repeatGroups:1,repeatMembers:2 };
  const result=suppressCycleMetrics(raw);
  assert.equal(result.suppressed,true);
  for(const key of ['available','paired','solo','scheduled','completed','median_hours_to_agreed_time','repeat_pair_percent']){
    assert.deepEqual(result.metrics[key],hidden,key);
  }
  assert.deepEqual(result.metrics.cancelled,untracked);
  assert.deepEqual(result.metrics.no_show,untracked);
  assert.deepEqual(suppressCycleMetrics(raw,{ completionTracked:false }).metrics.completed,untracked);
});

test('rates and medians need at least three members on every side',()=>{
  const base={ available:8,paired:8,solo:0,scheduled:8,completed:8,leadHours:[10,20,30,40],leadMembers:8,
    humanGroups:4,repeatGroups:2,repeatMembers:4 };
  assert.deepEqual(suppressCycleMetrics(base).metrics.repeat_pair_percent,ok(50));
  assert.deepEqual(suppressCycleMetrics(base).metrics.median_hours_to_agreed_time,ok(25));
  // One repeat pair (2 members), or one fresh pair, is identifying.
  assert.deepEqual(suppressCycleMetrics({ ...base,repeatGroups:1,repeatMembers:2 }).metrics.repeat_pair_percent,hidden);
  assert.deepEqual(suppressCycleMetrics({ ...base,repeatGroups:3,repeatMembers:6 }).metrics.repeat_pair_percent,hidden);
  assert.deepEqual(suppressCycleMetrics({ ...base,repeatGroups:4,repeatMembers:8 }).metrics.repeat_pair_percent,ok(100));
  // A single pair can never show a rate, even 0%.
  assert.deepEqual(suppressCycleMetrics({ ...base,available:3,paired:2,solo:1,scheduled:0,completed:0,
    humanGroups:1,repeatGroups:0,repeatMembers:0,leadHours:[],leadMembers:0 }).metrics.repeat_pair_percent,hidden);
  assert.deepEqual(suppressCycleMetrics({ ...base,humanGroups:0,paired:0,repeatGroups:0,repeatMembers:0 })
    .metrics.repeat_pair_percent,none);
  assert.deepEqual(suppressCycleMetrics({ ...base,leadHours:[3],leadMembers:2 }).metrics.median_hours_to_agreed_time,hidden);
  assert.deepEqual(suppressCycleMetrics({ ...base,leadHours:[],leadMembers:0 }).metrics.median_hours_to_agreed_time,none);
  assert.deepEqual(suppressCycleMetrics({ ...base,leadHours:[1.04,2.06],leadMembers:4 }).metrics.median_hours_to_agreed_time,ok(1.6));
});

test('aggregation ignores agreements without a valid instant or before publication',()=>{
  const cycle={ cycleId:'2026-W43',startsAt:null,publishedAtMs:Date.parse('2026-10-18T07:00:00Z'),availableMembers:['1','2'],
    groups:[
      { members:['1','2'],solo:false,scheduled:true,agreedAtMs:Date.parse('2026-10-17T07:00:00Z'),completed:false },
      { members:['3','4'],solo:false,scheduled:true,agreedAtMs:null,completed:true },
      { members:['5'],solo:true,scheduled:true,agreedAtMs:Date.parse('2026-10-19T07:00:00Z'),completed:true },
    ] };
  const raw=aggregateCycle(cycle,new Set(['1|2']));
  assert.deepEqual({ ...raw,leadHours:[...raw.leadHours] },{
    available:5,paired:4,solo:1,scheduled:4,completed:2,leadHours:[],leadMembers:0,
    humanGroups:2,repeatGroups:1,repeatMembers:2,
  });
  assert.equal(aggregateCycle({ ...cycle,publishedAtMs:null },new Set()).leadMembers,0);
  assert.equal(aggregateCycle(cycle,new Set(),{ completionTracked:false }).completed,null);
});

test('an invalid time zone only clears the in-progress marker',()=>{
  const health=buildCircleHealth([{ cycleId:'2026-W43',startsAt:null,publishedAtMs:null,availableMembers:[],groups:[] }],
    { scope:'primary',now:NOW,timeZone:'Not/AZone' });
  assert.equal(health.cycles[0].in_progress,false);
  assert.deepEqual(health.cycles[0].metrics.available,ok(0));
});

test('primary health matches the hand-built fixture for the last eight cycles',async()=>{
  const result=await readCircleHealth(db,{ actorUserId:1,circleId:10,now:NOW,timeZone:TZ });
  assert.equal(result.ok,true);
  assert.equal(result.circleId,10);
  const { health }=result;
  assert.equal(health.scope,'primary');
  assert.equal(health.window_cycles,CIRCLE_HEALTH_WINDOW);
  assert.equal(health.lookback_cycles,CIRCLE_HEALTH_LOOKBACK);
  assert.equal(health.min_cell_size,3);
  assert.equal(health.completion_tracked,true);
  assert.equal(health.attendance_outcomes_tracked,false);
  assert.equal(health.generated_at,new Date(NOW).toISOString());
  assert.deepEqual(health.cycles.map(cycle=>cycle.cycle_id),
    ['2026-W43','2026-W42','2026-W41','2026-W40','2026-W39','2026-W38','2026-W37','2026-W36']);
  assert.deepEqual(health.cycles.map(cycle=>cycle.in_progress),[true,false,false,false,false,false,false,false]);
  const cycles=byCycle(health);
  assert.equal(cycles['2026-W43'].starts_at,'2026-10-18T07:00:00.000Z');

  assert.deepEqual(cycles['2026-W43'],{ ...cycles['2026-W43'],suppressed:false,metrics:{
    available:ok(7),paired:ok(6),solo:hidden,
    // 4 of 6 paired members scheduled: the gap is one pair, so it is hidden.
    scheduled:hidden,completed:hidden,cancelled:untracked,no_show:untracked,
    // Agreed 82.998 h and 106.998 h after publication.
    median_hours_to_agreed_time:ok(95),
    repeat_pair_percent:ok(100),
  } });
  assert.deepEqual(cycles['2026-W42'].metrics,{
    available:ok(8),paired:ok(8),solo:ok(0),scheduled:ok(8),completed:ok(4),cancelled:untracked,no_show:untracked,
    median_hours_to_agreed_time:ok(36),
    // 101-102 was paired in W41 and 103-104 in W34 (8 cycles back); 105-106
    // last met in W33, outside the lookback.
    repeat_pair_percent:ok(50),
  });
  assert.equal(cycles['2026-W41'].suppressed,true);
  assert.deepEqual(cycles['2026-W41'].metrics.available,hidden);
  assert.deepEqual(cycles['2026-W40'],{ ...cycles['2026-W40'],suppressed:false,metrics:{
    available:ok(0),paired:ok(0),solo:ok(0),scheduled:ok(0),completed:ok(0),cancelled:untracked,no_show:untracked,
    median_hours_to_agreed_time:none,repeat_pair_percent:none,
  } });
  assert.deepEqual(cycles['2026-W39'].metrics,{
    available:ok(5),paired:ok(5),solo:ok(0),
    // The triad's free-text agreement counts as scheduled but has no instant.
    scheduled:ok(5),completed:hidden,cancelled:untracked,no_show:untracked,
    median_hours_to_agreed_time:hidden,repeat_pair_percent:hidden,
  });
  assert.deepEqual(cycles['2026-W38'].metrics,{
    available:ok(3),paired:hidden,solo:hidden,scheduled:hidden,completed:hidden,cancelled:untracked,no_show:untracked,
    median_hours_to_agreed_time:none,repeat_pair_percent:hidden,
  });
  assert.deepEqual(cycles['2026-W37'].metrics,{
    available:ok(4),paired:ok(4),solo:ok(0),scheduled:ok(0),completed:ok(0),cancelled:untracked,no_show:untracked,
    median_hours_to_agreed_time:none,repeat_pair_percent:ok(0),
  });
  // 109-110 (W28) and 101-105 (W31) repeat; 111-112 last met in W27, which
  // is past the lookback and is never read (otherwise this would be 75%).
  assert.deepEqual(cycles['2026-W36'].metrics.repeat_pair_percent,ok(50));
  assert.deepEqual(cycles['2026-W36'].metrics.available,ok(8));
});

test('the response never carries member identities',async()=>{
  const { health }=await readCircleHealth(db,{ actorUserId:1,circleId:10,now:NOW,timeZone:TZ });
  const text=JSON.stringify(health);
  assert.doesNotMatch(text,/@|Member \d|user_id|member_id|email|name/);
  for(const cycle of health.cycles){
    assert.deepEqual(Object.keys(cycle).sort(),['cycle_id','in_progress','metrics','starts_at','suppressed']);
    for(const cell of Object.values(cycle.metrics)){
      assert.deepEqual(Object.keys(cell).sort(),['status','value']);
    }
  }
});

test('every active owner of the circle can read it, including co-owners and single-circle mode',async()=>{
  const owner=await readCircleHealth(db,{ actorUserId:1,circleId:10,now:NOW,timeZone:TZ });
  const coOwner=await readCircleHealth(db,{ actorUserId:3,circleId:10,now:NOW,timeZone:TZ });
  assert.equal(coOwner.ok,true);
  assert.deepEqual(coOwner.health,owner.health);
  const primary=await readCircleHealth(db,{ actorUserId:1,now:NOW,timeZone:TZ });
  assert.equal(primary.ok,true);
  assert.equal(primary.circleId,10);
});

test('members, demoted owners, inactive owners, archived circles and other circles are denied',async()=>{
  const denied={ ok:false,reason:'owner_required' };
  assert.deepEqual(await readCircleHealth(db,{ actorUserId:2,circleId:10 }),denied,'member');
  assert.deepEqual(await readCircleHealth(db,{ actorUserId:4,circleId:10 }),denied,'demoted owner');
  assert.deepEqual(await readCircleHealth(db,{ actorUserId:5,circleId:10 }),denied,'inactive owner');
  assert.deepEqual(await readCircleHealth(db,{ actorUserId:1,circleId:30 }),denied,'archived circle');
  assert.deepEqual(await readCircleHealth(db,{ actorUserId:6,circleId:10 }),denied,'owner of another circle');
  assert.deepEqual(await readCircleHealth(db,{ actorUserId:1,circleId:20 }),denied,'member of the secondary');
  assert.deepEqual(await readCircleHealth(db,{ actorUserId:6 }),denied,'secondary owner has no primary');
  assert.deepEqual(await readCircleHealth(db,{ actorUserId:99,circleId:10 }),denied,'unknown account');
});

test('a demotion between the owner check and the read batch still denies',async()=>{
  const racing={
    execute:statement=>db.execute(statement),
    batch:async(statements,mode)=>{
      await db.execute(`UPDATE circle_memberships SET role='member' WHERE circle_id=10 AND user_id=3`);
      try{ return await db.batch(statements,mode); }
      finally{ await db.execute(`UPDATE circle_memberships SET role='owner' WHERE circle_id=10 AND user_id=3`); }
    },
  };
  assert.deepEqual(await readCircleHealth(racing,{ actorUserId:3,circleId:10 }),{ ok:false,reason:'owner_required' });
  const invalid={ execute:async()=>({ rows:[{ circle_id:'x',is_primary:1 }] }),batch:async()=>assert.fail('no read') };
  assert.deepEqual(await readCircleHealth(invalid,{ actorUserId:3,circleId:10 }),{ ok:false,reason:'owner_required' });
});

test('malformed or legacy rows are skipped rather than trusted',async()=>{
  const result=rows=>({ rows });
  const fake=(isPrimary,batchRows)=>({
    execute:async()=>result([{ circle_id:10,is_primary:isPrimary }]),
    batch:async()=>batchRows.map(result),
  });
  const primary=await readCircleHealth(fake(1,[
    [{ owner:1 }],
    // A legacy week without a publication run falls back to the week's own
    // creation time for the lead-time metric.
    [{ id:5,week_label:'2026-W42',week_start:'2026-10-11T07:00:00.000Z',week_created_at:'2026-10-11 07:00:00',published_at:null }],
    [{ week_id:5,user_id:1,source:'auth' },{ week_id:5,user_id:2,source:null },{ week_id:5,user_id:null },
      { week_id:5,user_id:3,source:'auth' },{ week_id:5,user_id:4,source:'auth' }],
    [{ id:7,week_id:5,user_a_id:1,user_b_id:2,user_c_id:null,is_ai_pair:0 },
      { id:8,week_id:5,user_a_id:3,user_b_id:4,user_c_id:null,is_ai_pair:0 },{ id:null,week_id:5 }],
    [{ week_id:5,pair_group_id:7,agreed_time:'2026-10-12T07:00:00.000Z' },
      { week_id:5,pair_group_id:8,agreed_time:'2026-10-13T07:00:00.000Z' }],
    [{ week_id:5,pair_group_id:7,user_id:1,participant_source:'auth' },
      { week_id:5,pair_group_id:7,user_id:2,participant_source:null }],
  ]),{ actorUserId:1,circleId:10,now:NOW,timeZone:TZ });
  assert.deepEqual(primary.health.cycles[0].metrics.available,ok(4));
  // Both members default to the auth source, so one receipt is not enough.
  assert.deepEqual(primary.health.cycles[0].metrics.completed,ok(0));
  assert.deepEqual(primary.health.cycles[0].metrics.median_hours_to_agreed_time,ok(36));
  const secondary=await readCircleHealth(fake(0,[
    [{ owner:1 }],
    [{ id:3,cycle_id:'2026-W42',starts_at:'bad',created_at:'2026-10-11T07:00:01.000Z' },
      { id:4,cycle_id:'2026-W41',starts_at:'2026-10-04T07:00:00.000Z',created_at:'2026-10-04T07:00:01.000Z' }],
    [{ id:null,publication_id:3 },{ id:9,publication_id:3,user_a_id:5,user_b_id:6,is_solo:0 },
      { id:10,publication_id:3,user_a_id:7,user_b_id:8,is_solo:0 }],
    { rows:null },
  ]),{ actorUserId:1,circleId:10,now:NOW,timeZone:TZ });
  assert.equal(secondary.health.cycles[0].starts_at,null);
  assert.deepEqual(secondary.health.cycles[0].metrics.paired,ok(4));
  assert.deepEqual(secondary.health.cycles[0].metrics.scheduled,ok(0));
  assert.deepEqual(secondary.health.cycles[1].metrics.available,ok(0));
});

test('secondary health reads only that circle and marks completion as not tracked',async()=>{
  const result=await readCircleHealth(db,{ actorUserId:6,circleId:20,now:NOW,timeZone:TZ });
  assert.equal(result.ok,true);
  assert.equal(result.health.scope,'secondary');
  assert.equal(result.health.completion_tracked,false);
  assert.deepEqual(result.health.cycles.map(cycle=>cycle.cycle_id),['2026-W43','2026-W42']);
  const [current,previous]=result.health.cycles;
  assert.equal(current.in_progress,true);
  assert.deepEqual(current.metrics,{
    available:ok(5),paired:ok(4),solo:hidden,scheduled:ok(4),completed:untracked,cancelled:untracked,no_show:untracked,
    // Agreed 58.9997 h and 82.9997 h after publication.
    median_hours_to_agreed_time:ok(71),repeat_pair_percent:ok(100),
  });
  assert.deepEqual(previous.metrics,{
    available:ok(4),paired:ok(4),solo:ok(0),scheduled:ok(0),completed:untracked,cancelled:untracked,no_show:untracked,
    median_hours_to_agreed_time:none,repeat_pair_percent:ok(0),
  });
});

test('every data statement repeats the owner guard',()=>{
  for(const [name,sql] of Object.entries(CIRCLE_HEALTH_SQL)){
    if(name.startsWith('owner')) continue;
    assert.match(sql,/owner AS \(SELECT 1 FROM circle_memberships membership/,name);
    assert.match(sql,/membership\.role='owner'/,name);
    assert.match(sql,/circle\.archived_at IS NULL/,name);
  }
  assert.doesNotMatch(Object.values(CIRCLE_HEALTH_SQL).join('\n'),/\b(?:INSERT|UPDATE|DELETE|CREATE|ALTER|DROP)\b/i);
});

test('invalid inputs are rejected before any query',async()=>{
  await assert.rejects(readCircleHealth(null,{ actorUserId:1 }),TypeError);
  await assert.rejects(readCircleHealth(db,{ actorUserId:0 }),TypeError);
  await assert.rejects(readCircleHealth(db,{ actorUserId:1,circleId:'abc' }),TypeError);
  await assert.rejects(readCircleHealth({ execute(){} },{ actorUserId:1 }),TypeError);
});
