// Issue #292: the circle health read model and its suppression rules,
// against a real migrated SQLite database and a hand-built pairing history.
// The exhaustive privacy property lives in circle-health-privacy.test.mjs.
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { createClient } from '@libsql/client';

import {
  aggregateCycle,
  buildCircleHealth,
  CIRCLE_HEALTH_CLOCK_MARGIN_MS,
  CIRCLE_HEALTH_LOOKBACK,
  CIRCLE_HEALTH_MIN_PAIRS,
  CIRCLE_HEALTH_RECEIPT_GRACE_MS,
  CIRCLE_HEALTH_SQL,
  CIRCLE_HEALTH_WINDOW,
  circleHealthEnabled,
  circleHealthQueryValid,
  edgePairCount,
  parseStoredInstant,
  readCircleHealth,
  suppressCycleMetrics,
} from '../../api/_circle-health.js';
import { prepareMigrationConnection } from '../../db/migration-runner.js';
import { insertPrimaryWeek, insertSecondaryPublication } from '../support/circle-health-fixture.mjs';
import { createMigratedDatabase } from '../support/migrated-db.mjs';

// Tuesday of 2026-W44, 52 h after W43 ended: W44 is the current cycle and
// must never be returned; W43 has settled (48 h receipt grace + 1 h margin).
const NOW=Date.parse('2026-10-27T12:00:00.000Z');
const W43_ENDS=Date.parse('2026-10-25T08:00:00.000Z');
const TZ='Europe/London';
const { url, cleanup }=await createMigratedDatabase({ prefix:'randori-circle-health-', filename:'health.sqlite' });
const db=createClient({ url });

const ok=value=>({ status:'ok', value });
const hidden={ status:'suppressed', value:null };
const none={ status:'no_data', value:null };
const untracked={ status:'not_tracked', value:null };
const deferred={ median_hours_to_agreed_time:untracked, cancelled:untracked, no_show:untracked };

// Weekly ISO labels and Sunday 08:00 London starts; offset 0 is 2026-W43.
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

  // The current cycle (W44) is never returned, however much happened in it.
  await insertPrimaryWeek(db,{ ...week(-1), participants:[101,102,103,104,105,106], groups:[
    { members:[101,102], agreed:'2026-10-27T18:00:00.000Z', receipts:[101,102] },
    { members:[103,104], agreed:'2026-10-28T18:00:00.000Z' }, { members:[105,106] },
  ] });
  // Index 0: 3 pairs and a solo; 2 pairs agreed a time, 1 completed.
  await insertPrimaryWeek(db,{ ...week(0), participants:[101,102,103,104,105,106,107], groups:[
    { members:[101,102], agreed:'2026-10-21T18:00:00.000Z', receipts:[101,102] },
    { members:[103,104], agreed:'2026-10-22T18:00:00.000Z', receipts:[103] },
    { members:[105,106] },
    { members:[107] },
  ] });
  // Index 1: 4 pairs, all agreed, two completed. W42 ended 2026-10-18 07:00Z:
  // 102 confirmed inside the 48 h grace (counts); 106 confirmed after it, so
  // 105-106 stays incomplete (counting it would make 3 of 4, an edge).
  await insertPrimaryWeek(db,{ ...week(1), participants:[101,102,103,104,105,106,107,108], groups:[
    { members:[101,102], agreed:'2026-10-11T20:00:00.000Z',
      receipts:[101,{ userId:102,at:'2026-10-20T06:59:59.000Z' }] },
    { members:[103,104], agreed:'2026-10-12T08:00:00.000Z', receipts:[103,104] },
    { members:[105,106], agreed:'2026-10-13T08:00:00.000Z',
      receipts:[105,{ userId:106,at:'2026-10-20T07:00:00.000Z' }] },
    { members:[107,108], agreed:'2026-10-15T08:00:00.000Z' },
  ] });
  // Index 2: a single pair.
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
  // Index 5: one pair and a solo.
  await insertPrimaryWeek(db,{ ...week(5), participants:[104,105,106], groups:[
    { members:[104,105] }, { members:[106] },
  ] });
  // W37 is a demo week: skipped without using a window slot, so the eighth
  // cycle shown is W35.
  await insertPrimaryWeek(db,{ ...week(6), isDemo:1, participants:[104,106,107,108], groups:[
    { members:[104,107] }, { members:[106,108] },
  ] });
  // Index 7: repeats only from inside its 8-cycle lookback.
  await insertPrimaryWeek(db,{ ...week(7), participants:[101,104,105,106,109,110,111,112], groups:[
    { members:[109,110] }, { members:[111,112] }, { members:[101,105] }, { members:[104,106] },
  ] });
  // Lookback-only cycles (indexes 8..15) and one cycle past the lookback.
  const lookback=[[107,109],[103,104],[105,106],[110,111],[101,105],[101,103],[102,105],[109,110],[111,112]];
  for(const [offset,members] of lookback.entries()){
    await insertPrimaryWeek(db,{ ...week(8+offset), participants:members, groups:[{ members }] });
  }
  // Non-ISO demo and legacy labels never count.
  await insertPrimaryWeek(db,{ label:'2026-W42-demo-1234', weekStart:'2026-10-11T08:00:00.000Z',
    participants:[103,104], groups:[{ members:[103,104] }] });
  await insertPrimaryWeek(db,{ label:'legacy-week', weekStart:'2026-10-19T08:00:00.000Z',
    participants:[105,106], groups:[{ members:[105,106] }] });

  // Secondary circle 20 (with a current-cycle publication that must not be
  // returned) and an unrelated secondary circle 21.
  await insertSecondaryPublication(db,{ circleId:20, cycleId:'2026-W42', startsAt:'2026-10-11T07:00:00.000Z',
    publishedAt:'2026-10-11T07:00:01.000Z', groups:[{ members:[101,102] },{ members:[103,104] },
      { members:[105,106] },{ members:[107,108] }] });
  await insertSecondaryPublication(db,{ circleId:20, cycleId:'2026-W43', startsAt:'2026-10-18T07:00:00.000Z',
    publishedAt:'2026-10-18T07:00:01.000Z', unavailable:[109], groups:[
      { members:[101,102], agreed:'2026-10-20T18:00:00.000Z' },
      { members:[103,104], agreed:'2026-10-21T18:00:00.000Z' },
      { members:[105,106], agreed:'2026-10-22T18:00:00.000Z' },
      { members:[107,108], agreed:'2026-10-23T18:00:00.000Z' },
      { members:[6] },
    ] });
  await insertSecondaryPublication(db,{ circleId:20, cycleId:'2026-W44', startsAt:'2026-10-25T08:00:00.000Z',
    publishedAt:'2026-10-25T08:00:01.000Z', groups:[{ members:[101,102], agreed:'2026-10-27T18:00:00.000Z' },
      { members:[103,104] },{ members:[105,106] }] });
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

test('stored instants accept SQLite and ISO forms only',()=>{
  assert.equal(parseStoredInstant('2026-10-18 08:00:05'),Date.parse('2026-10-18T08:00:05Z'));
  assert.equal(parseStoredInstant('2026-10-18T07:00:00.000Z'),Date.parse('2026-10-18T07:00:00.000Z'));
  assert.equal(parseStoredInstant('2026-10-18T08:00:00+01:00'),Date.parse('2026-10-18T07:00:00Z'));
  assert.equal(parseStoredInstant('Tuesday 7pm'),null);
  assert.equal(parseStoredInstant('2026-02-31T07:00:00Z'),null);
  assert.equal(parseStoredInstant(null),null);
});

test('a count of pairs is an edge when exactly one pair is in or out',()=>{
  assert.equal(CIRCLE_HEALTH_MIN_PAIRS,4);
  assert.equal(CIRCLE_HEALTH_RECEIPT_GRACE_MS,48*3600_000);
  assert.equal(CIRCLE_HEALTH_CLOCK_MARGIN_MS,3600_000);
  assert.deepEqual([0,1,2,3,4].map(count=>edgePairCount(count,4)),[false,true,false,true,false]);
  assert.deepEqual([0,1,2,3].map(count=>edgePairCount(count,3)),[false,true,true,false]);
});

function raw(overrides={}){
  return { available:9,paired:8,solo:1,pairs:4,scheduledPairs:2,completedPairs:2,repeatPairs:2,...overrides };
}

test('available, paired, solo and pairs describe the published pairing and are always shown',()=>{
  const metrics=suppressCycleMetrics(raw({ available:2,paired:2,solo:0,pairs:1 }));
  assert.deepEqual([metrics.available,metrics.paired,metrics.solo,metrics.pairs],[ok(2),ok(2),ok(0),ok(1)]);
  assert.deepEqual(suppressCycleMetrics(raw()).solo,ok(1));
});

test('with fewer than four pairs, agreed, completed and repeat are hidden whatever their value',()=>{
  for(const pairs of [1,2,3]){
    for(const count of [0,1,pairs]){
      const metrics=suppressCycleMetrics(raw({ pairs,scheduledPairs:count,completedPairs:count,repeatPairs:count }));
      assert.deepEqual([metrics.scheduled_pairs,metrics.completed_pairs,metrics.repeat_pair_percent],[hidden,hidden,hidden]);
    }
  }
  assert.deepEqual(suppressCycleMetrics(raw({ pairs:2 }),{ completionTracked:false }).completed_pairs,untracked);
});

test('with no pairs there is nothing to measure',()=>{
  const metrics=suppressCycleMetrics(raw({ available:0,paired:0,solo:0,pairs:0,scheduledPairs:0,completedPairs:0,repeatPairs:0 }));
  assert.deepEqual(metrics,{ available:ok(0),paired:ok(0),solo:ok(0),pairs:ok(0),scheduled_pairs:none,
    completed_pairs:none,repeat_pair_percent:none,...deferred });
});

test('agreed and completed are shown or hidden together, so neither narrows the other',()=>{
  assert.deepEqual(suppressCycleMetrics(raw()),{ available:ok(9),paired:ok(8),solo:ok(1),pairs:ok(4),
    scheduled_pairs:ok(2),completed_pairs:ok(2),repeat_pair_percent:ok(50),...deferred });
  // Completed is an edge (3 of 4): agreed is hidden with it.
  const completedEdge=suppressCycleMetrics(raw({ scheduledPairs:4,completedPairs:3 }));
  assert.deepEqual([completedEdge.scheduled_pairs,completedEdge.completed_pairs],[hidden,hidden]);
  // Agreed is an edge (1 of 4): completed is hidden with it.
  const scheduledEdge=suppressCycleMetrics(raw({ scheduledPairs:1,completedPairs:0 }));
  assert.deepEqual([scheduledEdge.scheduled_pairs,scheduledEdge.completed_pairs],[hidden,hidden]);
  // Without completion tracking only agreed decides.
  const secondary=suppressCycleMetrics(raw({ scheduledPairs:2,completedPairs:null }),{ completionTracked:false });
  assert.deepEqual([secondary.scheduled_pairs,secondary.completed_pairs],[ok(2),untracked]);
  assert.deepEqual(suppressCycleMetrics(raw({ scheduledPairs:3 }),{ completionTracked:false }).scheduled_pairs,hidden);
  // Unanimous counts are shown from four pairs.
  const all=suppressCycleMetrics(raw({ pairs:4,scheduledPairs:4,completedPairs:0,repeatPairs:4 }));
  assert.deepEqual([all.scheduled_pairs,all.completed_pairs,all.repeat_pair_percent],[ok(4),ok(0),ok(100)]);
});

test('the repeat rate hides an edge count and otherwise rounds to a whole percent',()=>{
  assert.deepEqual(suppressCycleMetrics(raw({ repeatPairs:1 })).repeat_pair_percent,hidden);
  assert.deepEqual(suppressCycleMetrics(raw({ repeatPairs:3 })).repeat_pair_percent,hidden);
  assert.deepEqual(suppressCycleMetrics(raw({ pairs:6,repeatPairs:4 })).repeat_pair_percent,ok(67));
  assert.deepEqual(suppressCycleMetrics(raw({ repeatPairs:0 })).repeat_pair_percent,ok(0));
});

test('the median, cancellations and no-shows are deferred in every cycle',()=>{
  for(const pairs of [0,1,3,6]){
    const metrics=suppressCycleMetrics(raw({ pairs,scheduledPairs:0,completedPairs:0,repeatPairs:0 }));
    assert.deepEqual([metrics.median_hours_to_agreed_time,metrics.cancelled,metrics.no_show],[untracked,untracked,untracked]);
  }
});

test('aggregation counts members for the pairing and pairs for what pairs did',()=>{
  const cycle={ cycleId:'2026-W43',startsAt:null,availableMembers:['1','2','9'],
    groups:[
      { members:['1','2'],solo:false,scheduled:true,completed:false },
      { members:['3','4','8'],solo:false,scheduled:false,completed:true },
      { members:['5'],solo:true,scheduled:true,completed:true },
    ] };
  assert.deepEqual({ ...aggregateCycle(cycle,new Set(['1|2'])) },{
    available:7,paired:5,solo:1,pairs:2,scheduledPairs:1,completedPairs:1,repeatPairs:1,
  });
  assert.equal(aggregateCycle(cycle,new Set(['4|8'])).repeatPairs,1,'any member pair inside a triad counts');
  assert.equal(aggregateCycle(cycle,new Set(),{ completionTracked:false }).completedPairs,null);
});

test('the envelope describes the window and the deferred metrics',()=>{
  const health=buildCircleHealth([{ cycleId:'2026-W43',startsAt:null,availableMembers:[],groups:[] }],
    { scope:'secondary',now:NOW,completionTracked:false });
  assert.deepEqual({ ...health,cycles:health.cycles.length },{
    version:1,scope:'secondary',window_cycles:8,lookback_cycles:8,min_pairs:4,completion_tracked:false,
    attendance_outcomes_tracked:false,generated_at:new Date(NOW).toISOString(),cycles:1,
  });
});

test('an invalid pairing time zone fails closed instead of guessing the current cycle',async()=>{
  await assert.rejects(readCircleHealth(db,{ actorUserId:1,circleId:10,now:NOW,timeZone:'Not/AZone' }),TypeError);
});

test('primary health matches the hand-built fixture for the last eight finished cycles',async()=>{
  const result=await readCircleHealth(db,{ actorUserId:1,circleId:10,now:NOW,timeZone:TZ });
  assert.equal(result.ok,true);
  assert.equal(result.circleId,10);
  const { health }=result;
  assert.equal(health.scope,'primary');
  assert.equal(health.window_cycles,CIRCLE_HEALTH_WINDOW);
  assert.equal(health.lookback_cycles,CIRCLE_HEALTH_LOOKBACK);
  assert.equal(health.min_pairs,4);
  assert.equal(health.completion_tracked,true);
  // W44 is in progress; W37 is a demo week.
  assert.deepEqual(health.cycles.map(cycle=>cycle.cycle_id),
    ['2026-W43','2026-W42','2026-W41','2026-W40','2026-W39','2026-W38','2026-W36','2026-W35']);
  const cycles=byCycle(health);
  assert.deepEqual(cycles['2026-W43'],{ cycle_id:'2026-W43',starts_at:'2026-10-18T07:00:00.000Z',metrics:{
    available:ok(7),paired:ok(6),solo:ok(1),pairs:ok(3),
    // Three pairs: under the pair floor, so nothing about what pairs did shows.
    scheduled_pairs:hidden,completed_pairs:hidden,repeat_pair_percent:hidden,...deferred,
  } });
  assert.deepEqual(cycles['2026-W42'].metrics,{
    available:ok(8),paired:ok(8),solo:ok(0),pairs:ok(4),scheduled_pairs:ok(4),
    // 101-102 (in-grace receipt) and 103-104; 106 confirmed after the grace.
    completed_pairs:ok(2),
    // 101-102 (W41), 103-104 (W34) and 105-106 (W33) repeat: 3 of 4 is an edge.
    repeat_pair_percent:hidden,...deferred,
  });
  for(const [cycleId,structure] of [['2026-W41',[2,2,0,1]],['2026-W39',[5,5,0,2]],['2026-W38',[3,2,1,1]],['2026-W35',[2,2,0,1]]]){
    const [available,paired,solo,pairs]=structure;
    assert.deepEqual(cycles[cycleId].metrics,{ available:ok(available),paired:ok(paired),solo:ok(solo),pairs:ok(pairs),
      scheduled_pairs:hidden,completed_pairs:hidden,repeat_pair_percent:hidden,...deferred },cycleId);
  }
  assert.deepEqual(cycles['2026-W40'].metrics,{ available:ok(0),paired:ok(0),solo:ok(0),pairs:ok(0),
    scheduled_pairs:none,completed_pairs:none,repeat_pair_percent:none,...deferred });
  // 109-110 (W28) and 101-105 (W31) repeat; 111-112 last met in W27, past the
  // lookback (counting it would make 3 of 4, an edge).
  assert.deepEqual(cycles['2026-W36'].metrics,{ available:ok(8),paired:ok(8),solo:ok(0),pairs:ok(4),
    scheduled_pairs:ok(0),completed_pairs:ok(0),repeat_pair_percent:ok(50),...deferred });
});

test('a cycle appears only once the receipt grace and clock margin have passed',async()=>{
  const settledAt=W43_ENDS+CIRCLE_HEALTH_RECEIPT_GRACE_MS+CIRCLE_HEALTH_CLOCK_MARGIN_MS;
  const before=await readCircleHealth(db,{ actorUserId:1,circleId:10,now:settledAt-1,timeZone:TZ });
  assert.equal(before.health.cycles[0].cycle_id,'2026-W42');
  assert.equal(before.health.cycles.length,8,'the window still holds eight settled cycles');
  const after=await readCircleHealth(db,{ actorUserId:1,circleId:10,now:settledAt,timeZone:TZ });
  assert.equal(after.health.cycles[0].cycle_id,'2026-W43');
  const secondary=await readCircleHealth(db,{ actorUserId:6,circleId:20,now:settledAt-1,timeZone:TZ });
  assert.deepEqual(secondary.health.cycles.map(cycle=>cycle.cycle_id),['2026-W42']);
});

test('a confirmation after the grace never changes a shown count',async()=>{
  const read=async()=>byCycle((await readCircleHealth(db,{ actorUserId:1,circleId:10,now:NOW,timeZone:TZ })).health)['2026-W42'];
  const shown=await read();
  const weekId=Number((await db.execute(`SELECT id FROM pairing_weeks WHERE week_label='2026-W42'`)).rows[0].id);
  const group=(await db.execute({ sql:`SELECT id,user_a_id,user_b_id FROM pairing_groups WHERE week_id=? AND user_a_id=107`,
    args:[weekId] })).rows[0];
  for(const userId of [107,108]){
    await db.execute({ sql:`INSERT INTO session_completion_receipts (week_id,pair_group_id,user_id,participant_source,
        pair_user_a_id,pair_user_b_id,pair_user_c_id,confirmed_at) VALUES (?,?,?,'auth',?,?,NULL,?)`,
    args:[weekId,group.id,userId,group.user_a_id,group.user_b_id,new Date(NOW-60_000).toISOString()] });
  }
  try{
    // 107-108 confirmed today, long after W42's grace: still 2 of 4, not an
    // edge (3 of 4) that would flip both cells to Hidden.
    assert.deepEqual(await read(),shown);
  }finally{
    await db.execute({ sql:`DELETE FROM session_completion_receipts WHERE week_id=? AND pair_group_id=?`,args:[weekId,group.id] });
  }
});

test('the response never carries member identities or live data',async()=>{
  const { health }=await readCircleHealth(db,{ actorUserId:1,circleId:10,now:NOW,timeZone:TZ });
  const text=JSON.stringify(health);
  assert.doesNotMatch(text,/@|Member \d|user_id|member_id|email|name|2026-W44/);
  for(const cycle of health.cycles){
    assert.deepEqual(Object.keys(cycle).sort(),['cycle_id','metrics','starts_at']);
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
  const ask=input=>readCircleHealth(db,{ now:NOW,timeZone:TZ,...input });
  assert.deepEqual(await ask({ actorUserId:2,circleId:10 }),denied,'member');
  assert.deepEqual(await ask({ actorUserId:4,circleId:10 }),denied,'demoted owner');
  assert.deepEqual(await ask({ actorUserId:5,circleId:10 }),denied,'inactive owner');
  assert.deepEqual(await ask({ actorUserId:1,circleId:30 }),denied,'archived circle');
  assert.deepEqual(await ask({ actorUserId:6,circleId:10 }),denied,'owner of another circle');
  assert.deepEqual(await ask({ actorUserId:1,circleId:20 }),denied,'member of the secondary');
  assert.deepEqual(await ask({ actorUserId:6 }),denied,'secondary owner has no primary');
  assert.deepEqual(await ask({ actorUserId:99,circleId:10 }),denied,'unknown account');
});

function racing(change,restore){
  return {
    execute:statement=>db.execute(statement),
    batch:async(statements,mode)=>{
      await db.execute(change);
      try{ return await db.batch(statements,mode); }
      finally{ await db.execute(restore); }
    },
  };
}

test('a demotion, deactivation or archive between the owner check and the read batch still denies',async()=>{
  const denied={ ok:false,reason:'owner_required' };
  assert.deepEqual(await readCircleHealth(racing(
    `UPDATE circle_memberships SET role='member' WHERE circle_id=10 AND user_id=3`,
    `UPDATE circle_memberships SET role='owner' WHERE circle_id=10 AND user_id=3`,
  ),{ actorUserId:3,circleId:10,now:NOW,timeZone:TZ }),denied,'demoted');
  assert.deepEqual(await readCircleHealth(racing(
    `UPDATE circle_memberships SET status='inactive' WHERE circle_id=10 AND user_id=3`,
    `UPDATE circle_memberships SET status='active' WHERE circle_id=10 AND user_id=3`,
  ),{ actorUserId:3,circleId:10,now:NOW,timeZone:TZ }),denied,'deactivated');
  assert.deepEqual(await readCircleHealth(racing(
    `UPDATE circles SET archived_at='2026-10-27T00:00:00.000Z' WHERE id=10`,
    `UPDATE circles SET archived_at=NULL WHERE id=10`,
  ),{ actorUserId:3,circleId:10,now:NOW,timeZone:TZ }),denied,'archived');
  assert.equal((await readCircleHealth(db,{ actorUserId:3,circleId:10,now:NOW,timeZone:TZ })).ok,true,'state restored');
  const invalid={ execute:async()=>({ rows:[{ circle_id:'x',is_primary:1 }] }),batch:async()=>assert.fail('no read') };
  assert.deepEqual(await readCircleHealth(invalid,{ actorUserId:3,circleId:10,now:NOW,timeZone:TZ }),denied);
});

test('malformed or legacy rows are skipped rather than trusted',async()=>{
  const result=rows=>({ rows });
  const fake=(isPrimary,batchRows)=>({
    execute:async()=>result([{ circle_id:10,is_primary:isPrimary }]),
    batch:async()=>batchRows.map(result),
  });
  const pairsOf=(weekId,count)=>Array.from({ length:count },(_,index)=>(
    { id:70+index,week_id:weekId,user_a_id:1+2*index,user_b_id:2+2*index,user_c_id:null,is_ai_pair:0 }));
  const participantsOf=(weekId,count)=>Array.from({ length:2*count },(_,index)=>(
    { week_id:weekId,user_id:1+index,source:'auth' }));
  const at='2026-10-14T10:00:00.000Z';
  const primary=await readCircleHealth(fake(1,[
    [{ owner:1 }],
    [{ id:5,week_label:'2026-W42',week_start:'2026-10-11T07:00:00.000Z' },
      // A legacy week with no valid start has no known end: none of its
      // receipts count.
      { id:6,week_label:'2026-W41',week_start:'not a date' }],
    [...participantsOf(5,4),{ week_id:5,user_id:null },{ week_id:5,user_id:2,source:null },...participantsOf(6,4)],
    [...pairsOf(5,4),{ id:null,week_id:5 },...pairsOf(6,4).map(row=>({ ...row,id:row.id+10 }))],
    [70,71,72,73].map(id=>({ week_id:5,pair_group_id:id,agreed_time:'2026-10-12T07:00:00.000Z' })),
    [
      // Group 70: both members confirmed. User 2's participant source fell
      // back to auth, so both receipts are required and present. A copy
      // without a confirmation time is ignored.
      { week_id:5,pair_group_id:70,user_id:1,participant_source:'auth',confirmed_at:at },
      { week_id:5,pair_group_id:70,user_id:2,participant_source:'auth',confirmed_at:at },
      { week_id:5,pair_group_id:70,user_id:2,participant_source:'auth',confirmed_at:null },
      // Group 71: both members confirmed, plus a receipt from someone outside
      // the pair, so it does not count as completed.
      { week_id:5,pair_group_id:71,user_id:3,participant_source:'auth',confirmed_at:at },
      { week_id:5,pair_group_id:71,user_id:4,participant_source:'auth',confirmed_at:at },
      { week_id:5,pair_group_id:71,user_id:99,participant_source:'auth',confirmed_at:at },
      // Group 72: one receipt has no auth source.
      { week_id:5,pair_group_id:72,user_id:5,participant_source:'auth',confirmed_at:at },
      { week_id:5,pair_group_id:72,user_id:6,participant_source:null,confirmed_at:at },
      // Group 73: both confirmed.
      { week_id:5,pair_group_id:73,user_id:7,participant_source:'auth',confirmed_at:at },
      { week_id:5,pair_group_id:73,user_id:8,participant_source:'auth',confirmed_at:at },
      // Week 6: every pair confirmed, but the week's end is unknown.
      ...[80,81,82,83].flatMap((id,index)=>[1,2].map(offset=>(
        { week_id:6,pair_group_id:id,user_id:2*index+offset,participant_source:'auth',confirmed_at:at }))),
    ],
  ]),{ actorUserId:1,circleId:10,now:NOW,timeZone:TZ });
  const metrics=primary.health.cycles[0].metrics;
  assert.deepEqual([metrics.available,metrics.pairs,metrics.scheduled_pairs,metrics.completed_pairs],
    [ok(8),ok(4),ok(4),ok(2)]);
  assert.equal(primary.health.cycles[1].starts_at,null);
  assert.deepEqual(primary.health.cycles[1].metrics.completed_pairs,ok(0));
  const secondary=await readCircleHealth(fake(0,[
    [{ owner:1 }],
    [{ id:3,cycle_id:'2026-W42',starts_at:'bad' },{ id:4,cycle_id:'2026-W41',starts_at:'2026-10-04T07:00:00.000Z' }],
    [{ id:null,publication_id:3 },{ id:9,publication_id:3,user_a_id:5,user_b_id:6,is_solo:0 },
      { id:10,publication_id:3,user_a_id:7,user_b_id:8,is_solo:0 },{ id:11,publication_id:3,user_a_id:9,user_b_id:null,is_solo:1 }],
    { rows:null },
  ]),{ actorUserId:1,circleId:10,now:NOW,timeZone:TZ });
  assert.equal(secondary.health.cycles[0].starts_at,null);
  assert.deepEqual([secondary.health.cycles[0].metrics.paired,secondary.health.cycles[0].metrics.solo],[ok(4),ok(1)]);
  assert.deepEqual(secondary.health.cycles[0].metrics.scheduled_pairs,hidden,'two pairs');
  assert.deepEqual(secondary.health.cycles[1].metrics.available,ok(0));
});

test('secondary health reads only that circle\'s finished cycles and marks completion as not tracked',async()=>{
  const result=await readCircleHealth(db,{ actorUserId:6,circleId:20,now:NOW,timeZone:TZ });
  assert.equal(result.ok,true);
  assert.equal(result.health.scope,'secondary');
  assert.equal(result.health.completion_tracked,false);
  assert.deepEqual(result.health.cycles.map(cycle=>cycle.cycle_id),['2026-W43','2026-W42']);
  const [newest,older]=result.health.cycles;
  assert.deepEqual(newest.metrics,{
    available:ok(9),paired:ok(8),solo:ok(1),pairs:ok(4),scheduled_pairs:ok(4),completed_pairs:untracked,
    repeat_pair_percent:ok(100),...deferred,
  });
  assert.deepEqual(older.metrics,{
    available:ok(8),paired:ok(8),solo:ok(0),pairs:ok(4),scheduled_pairs:ok(0),completed_pairs:untracked,
    repeat_pair_percent:ok(0),...deferred,
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
