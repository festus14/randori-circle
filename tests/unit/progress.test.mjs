// Issue #293 personal progress: streak rules, cycle and time-zone boundaries,
// catalogue coverage, run outcomes, role balance and the strict query
// contract. Pure functions only; the DB-backed route and its consistency with
// History, recap and stats are in progress-api.test.mjs.
import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';

import {
  buildMemberProgress,
  catalogueCoverage,
  classifyWeek,
  computeStreak,
  cycleAt,
  cycleIdForPairingWeek,
  ensureProgressReadiness,
  MAX_PROGRESS_PAIRINGS,
  MAX_PROGRESS_RUN_SCAN,
  parseProgressQuery,
  previousCycle,
  PROGRESS_WEEKS_SHOWN,
  ProgressDataError,
  ProgressInputError,
  progressDashboardEnabled,
  progressStatements,
  readMemberProgress,
  splitPairingRows,
  STREAK_RULES_VERSION,
  WEEK_STATUSES,
} from '../../api/_progress.js';
import { SessionCompletionDataError } from '../../api/_session-completion.js';

const ZONE='Europe/London';
const ME=2;
const PARTNER=4;
const THIRD=6;
const KEY='progress-test-secret-at-least-thirty-two-characters';
// Wednesday of 2026-W45. W43 (18 Oct) is the week the clocks go back.
const NOW='2026-11-04T12:00:00.000Z';
const EXERCISES=Object.freeze([
  {slug:'focus-block-rollup',type:'array-processing',tags:['arrays','aggregation']},
  {slug:'capacity-upgrade-index',type:'binary-search',tags:['arrays','binary-search']},
  {slug:'threshold-pair-count',type:'two-pointers',tags:['arrays','two-pointers']},
  {slug:'shortest-handoff-path',type:'graph-traversal',tags:['graphs','breadth-first-search']},
]);
const previousZone=process.env.PAIRING_TIME_ZONE;
afterEach(()=>{
  if(previousZone===undefined) delete process.env.PAIRING_TIME_ZONE; else process.env.PAIRING_TIME_ZONE=previousZone;
});

// ------------------------------------------------------------------ fixtures

const weekStarts={
  '2026-W38':'2026-09-13T07:00:00.000Z','2026-W39':'2026-09-20T07:00:00.000Z',
  '2026-W40':'2026-09-27T07:00:00.000Z','2026-W41':'2026-10-04T07:00:00.000Z',
  '2026-W42':'2026-10-11T07:00:00.000Z','2026-W43':'2026-10-18T07:00:00.000Z',
  '2026-W44':'2026-10-25T08:00:00.000Z','2026-W45':'2026-11-01T08:00:00.000Z',
};

function pairing(cycleId,{group,ai=false,partner=PARTNER,third=null,label=cycleId,start=weekStarts[cycleId],sources}={}){
  const week=Number(cycleId.slice(-2));
  return {
    pg_id:group??week*10,week_id:week,week_label:label,week_start:start,is_ai_pair:ai?1:0,
    user_a_id:ME,user_b_id:ai?ME:partner,user_c_id:third,
    user_a_source:'auth',user_b_source:'auth',user_c_source:third?'auth':null,
    ...sources,
  };
}

function receipts(row,users=[ME,row.is_ai_pair?null:row.user_b_id,row.user_c_id].filter(Boolean)){
  return users.map((user,index)=>({
    week_id:row.week_id,pair_group_id:row.pg_id,user_id:user,
    confirmed_at:new Date((Date.parse(row.week_start)||Date.parse(NOW))+(index+1)*3_600_000).toISOString(),
  }));
}

function build({now=NOW,pairings=[],completed=[],partial=[],skips=[],runs=[],controls=[],exercises=EXERCISES,...rest}={}){
  const receiptRows=[
    ...completed.flatMap(row=>receipts(row)),
    ...partial.flatMap(row=>receipts(row,[ME])),
  ];
  return buildMemberProgress({
    userId:ME,now:new Date(now),timeZone:ZONE,pairingRows:pairings,receiptRows,controlRows:controls,
    skipRows:skips.map(cycle_id=>({cycle_id})),runRows:runs,versionKey:KEY,
    verifyAttestation:signature=>signature==='good',exercises,...rest,
  });
}

const statusOf=(progress,cycleId)=>progress.weeks.find(week=>week.cycle_id===cycleId)?.status;

let nextRun=1;
function run({slug='focus-block-rollup',passed=8,total=8,at='2026-11-02 10:00:00',user=ME,attestation='good',source='original-catalog',snapshotTotal=total}={}){
  return {
    id:nextRun++,user_id:user,week_id:null,pair_group_id:null,question_slug:slug,language:'javascript',
    code:'function solve() {}',results_json:'[]',passed_count:passed,total_count:total,duration_ms:12,created_at:at,
    test_cases_snapshot:JSON.stringify({source,version:1,total_count:snapshotTotal,attestation_version:2,
      attestation_key_id:'0123456789abcdef',attestation}),
  };
}

// ------------------------------------------------------------------ flag and query

test('the dashboard flag is off unless exactly "true"',()=>{
  assert.equal(progressDashboardEnabled({}),false);
  assert.equal(progressDashboardEnabled({PROGRESS_DASHBOARD_ENABLED:'1'}),false);
  assert.equal(progressDashboardEnabled({PROGRESS_DASHBOARD_ENABLED:'TRUE'}),false);
  assert.equal(progressDashboardEnabled({PROGRESS_DASHBOARD_ENABLED:'true'}),true);
  delete process.env.PROGRESS_DASHBOARD_ENABLED;
  assert.equal(progressDashboardEnabled(),false);
});

test('the query accepts only the routing endpoint and an exact positive user_id',()=>{
  assert.deepEqual(parseProgressQuery({url:'/api/progress'}),{userId:null});
  assert.deepEqual(parseProgressQuery({query:{endpoint:'progress'},url:'/api/data?endpoint=progress'}),{userId:null});
  assert.deepEqual(parseProgressQuery({url:'/api/progress?user_id=42'}),{userId:42});
  assert.deepEqual(parseProgressQuery({query:{user_id:7}}),{userId:7});
  assert.deepEqual(parseProgressQuery({query:{user_id:'7'},url:'/api/progress?user_id=7'}),{userId:7});
  for(const [req,message] of [
    [{url:'/api/progress?member=3'},'unsupported query parameter'],
    [{url:'/api/progress?user_id=3&user_id=4'},'query parameters must be provided once'],
    [{query:{user_id:'3'},url:'/api/progress?user_id=4'},'query parameters must be provided once'],
    [{query:{endpoint:'history'}},'unsupported progress endpoint'],
    [{url:'/api/progress?user_id=0'},'user_id must be a positive integer'],
    [{url:'/api/progress?user_id=-3'},'user_id must be a positive integer'],
    [{url:'/api/progress?user_id=3.5'},'user_id must be a positive integer'],
    [{url:'/api/progress?user_id=99999999999999999'},'user_id must be a positive integer'],
    [{query:{user_id:{id:3}}},'user_id must be a positive integer'],
    [{query:['user_id']},null],
  ]){
    if(message===null){ assert.deepEqual(parseProgressQuery(req),{userId:null}); continue; }
    assert.throws(()=>parseProgressQuery(req),error=>error instanceof ProgressInputError&&error.message===message);
  }
  // An unparsable URL contributes nothing rather than throwing.
  assert.deepEqual(parseProgressQuery({url:'http://[bad'}),{userId:null});
  assert.deepEqual(parseProgressQuery(undefined),{userId:null});
});

// ------------------------------------------------------------------ week rules

test('week classification follows the documented precedence',()=>{
  const partner={isAi:false,state:'completed'};
  const open={isAi:false,state:'not_recorded'};
  const solo={isAi:true,state:'completed'};
  assert.deepEqual(WEEK_STATUSES,['completed','in_progress','not_available','solo','no_pairing','not_completed']);
  assert.equal(classifyWeek({sessions:[partner],notAvailable:true}),'completed');
  assert.equal(classifyWeek({sessions:[open],notAvailable:true}),'not_available');
  assert.equal(classifyWeek({sessions:[open],isCurrent:true}),'in_progress');
  assert.equal(classifyWeek({sessions:[{isAi:false,state:'awaiting_participants'}]}),'not_completed');
  assert.equal(classifyWeek({sessions:[solo]}),'solo');
  assert.equal(classifyWeek({sessions:[{isAi:true,state:'not_recorded'}]}),'solo');
  assert.equal(classifyWeek({}),'no_pairing');
  assert.equal(classifyWeek(),'no_pairing');
  assert.equal(classifyWeek({notAvailable:true}),'not_available');
});

test('only a not-completed week ends a streak; pauses and this week are skipped',()=>{
  assert.deepEqual(computeStreak([]),{current:0,longest:0});
  assert.deepEqual(computeStreak(['in_progress','completed','solo','completed','no_pairing','not_available','completed']),
    {current:3,longest:3});
  assert.deepEqual(computeStreak(['completed','not_completed','completed','completed','completed','not_completed','completed']),
    {current:1,longest:3});
  assert.deepEqual(computeStreak(['not_completed','completed']),{current:0,longest:1});
});

// ------------------------------------------------------------------ streak scenarios

test('consecutive completed weeks across the October clock change form one streak',()=>{
  const weeks=['2026-W42','2026-W43','2026-W44'].map(id=>pairing(id));
  const current=pairing('2026-W45');
  const progress=build({pairings:[current,...weeks].reverse(),completed:weeks});
  assert.deepEqual(progress.streak,{rules_version:STREAK_RULES_VERSION,current_weeks:3,longest_weeks:3,this_week:'in_progress'});
  assert.deepEqual(progress.sessions,{completed:3,solo_completed:0,pairings:4,demo_pairings:0,window_limited:false});
  assert.equal(progress.weeks.length,PROGRESS_WEEKS_SHOWN);
  assert.equal(progress.weeks.at(-1).cycle_id,'2026-W45');
  assert.deepEqual(progress.weeks.slice(-4).map(week=>[week.cycle_id,week.status,week.completion]),[
    ['2026-W42','completed',null],['2026-W43','completed',null],['2026-W44','completed',null],
    ['2026-W45','in_progress','not_recorded'],
  ]);
  // The DST week is 7 days and 1 hour long and the next one starts at its end.
  const w43=progress.weeks.find(week=>week.cycle_id==='2026-W43');
  const w44=progress.weeks.find(week=>week.cycle_id==='2026-W44');
  assert.equal(w43.ends_at,'2026-10-25T08:00:00.000Z');
  assert.equal(w44.starts_at,w43.ends_at);
  assert.equal(progress.weeks[0].status,'no_pairing');
  assert.deepEqual(progress.current_cycle,{cycle_id:'2026-W45',starts_at:'2026-11-01T08:00:00.000Z',ends_at:'2026-11-08T08:00:00.000Z'});
  assert.equal(progress.time_zone,ZONE);
  assert.equal(progress.generated_at,NOW);
  assert.deepEqual(progress.feedback,{available:false});
});

test('"Skip this cycle" weeks pause the streak, even when a pairing exists',()=>{
  const w42=pairing('2026-W42');
  const w43=pairing('2026-W43');
  const w44=pairing('2026-W44');
  const progress=build({pairings:[w44,w43,w42],completed:[w42,w44],skips:['2026-W43','2026-W41','not-a-cycle']});
  assert.equal(statusOf(progress,'2026-W43'),'not_available');
  assert.equal(statusOf(progress,'2026-W41'),'not_available');
  assert.equal(statusOf(progress,'2026-W45'),'no_pairing');
  assert.equal(progress.streak.current_weeks,2);
  assert.equal(progress.streak.longest_weeks,2);
  assert.equal(progress.streak.this_week,'no_pairing');
  // A completed session still counts in a week the member had skipped.
  const late=build({pairings:[w43],completed:[w43],skips:['2026-W43']});
  assert.equal(statusOf(late,'2026-W43'),'completed');
});

test('odd-member solo weeks pause the streak, even when the solo session was confirmed',()=>{
  const w42=pairing('2026-W42');
  const soloDone=pairing('2026-W43',{ai:true});
  const soloOpen=pairing('2026-W44',{ai:true});
  const w45=pairing('2026-W45');
  const progress=build({pairings:[w45,soloOpen,soloDone,w42],completed:[w42,soloDone,w45]});
  assert.equal(statusOf(progress,'2026-W43'),'solo');
  assert.equal(statusOf(progress,'2026-W44'),'solo');
  assert.equal(statusOf(progress,'2026-W45'),'completed');
  assert.equal(progress.streak.current_weeks,2);
  assert.equal(progress.streak.this_week,'completed');
  // Completed sessions match History: the solo receipt is a completed session.
  assert.deepEqual(progress.sessions,{completed:3,solo_completed:1,pairings:4,demo_pairings:0,window_limited:false});
  // A current-week solo pairing pauses too.
  assert.equal(build({pairings:[pairing('2026-W45',{ai:true})]}).streak.this_week,'solo');
});

test('skipped weeks: weeks with no pairing pause, a paired week nobody finished ends the streak',()=>{
  const w40=pairing('2026-W40');
  const w44=pairing('2026-W44');
  // No publication (or no place in it) in W41-W43.
  const gap=build({pairings:[w44,w40],completed:[w40,w44]});
  assert.deepEqual(['2026-W41','2026-W42','2026-W43'].map(id=>statusOf(gap,id)),['no_pairing','no_pairing','no_pairing']);
  assert.equal(gap.streak.current_weeks,2);
  // W42 was paired but only the member confirmed: it ends the streak.
  const w42=pairing('2026-W42');
  const broken=build({pairings:[w44,w42,w40],completed:[w40,w44],partial:[w42]});
  const week=broken.weeks.find(item=>item.cycle_id==='2026-W42');
  assert.deepEqual([week.status,week.completion],['not_completed','awaiting_participants']);
  assert.deepEqual([broken.streak.current_weeks,broken.streak.longest_weeks],[1,1]);
});

test('cycles without completion receipts end the streak and are reported as not recorded',()=>{
  const done=['2026-W39','2026-W40','2026-W41','2026-W43','2026-W44'].map(id=>pairing(id));
  const silent=pairing('2026-W42');
  const progress=build({pairings:[pairing('2026-W45'),...done,silent],completed:done});
  const week=progress.weeks.find(item=>item.cycle_id==='2026-W42');
  assert.deepEqual([week.status,week.completion],['not_completed','not_recorded']);
  assert.deepEqual([progress.streak.current_weeks,progress.streak.longest_weeks],[2,3]);
  assert.equal(progress.sessions.completed,5);
  // A member with only pre-receipt history has pairings but no streak.
  const legacy=build({pairings:[pairing('2026-W40'),pairing('2026-W41')]});
  assert.deepEqual([legacy.streak.current_weeks,legacy.streak.longest_weeks,legacy.sessions.completed],[0,0,0]);
});

test('triads count only when all three confirm',()=>{
  const triad=pairing('2026-W44',{third:THIRD});
  assert.equal(statusOf(build({pairings:[triad],completed:[triad]}),'2026-W44'),'completed');
  const twoOfThree=build({pairings:[triad],receiptRows:receipts(triad,[ME,PARTNER])});
  assert.equal(statusOf(twoOfThree,'2026-W44'),'not_completed');
});

test('the current cycle turns over at Sunday 08:00 in the pairing time zone',()=>{
  const w42=pairing('2026-W42');
  const w43=pairing('2026-W43');
  // 07:30 GMT on the Sunday the clocks went back: W43 is still this week.
  const before=build({now:'2026-10-25T07:30:00.000Z',pairings:[w43,w42],completed:[w42]});
  assert.equal(before.current_cycle.cycle_id,'2026-W43');
  assert.equal(before.streak.this_week,'in_progress');
  assert.equal(before.streak.current_weeks,1);
  // From 08:00 W43 has ended unconfirmed and W44 has no pairing yet.
  const after=build({now:'2026-10-25T08:00:00.000Z',pairings:[w43,w42],completed:[w42]});
  assert.equal(after.current_cycle.cycle_id,'2026-W44');
  assert.equal(statusOf(after,'2026-W43'),'not_completed');
  assert.deepEqual([after.streak.current_weeks,after.streak.longest_weeks,after.streak.this_week],[0,1,'no_pairing']);
  // In summer the same boundary is 07:00 UTC.
  assert.equal(build({now:'2026-10-18T06:59:59.999Z'}).current_cycle.cycle_id,'2026-W42');
  assert.equal(build({now:'2026-10-18T07:00:00.000Z'}).current_cycle.cycle_id,'2026-W43');
});

test('a pairing week maps to its cycle by label, else by its start instant',()=>{
  assert.equal(cycleIdForPairingWeek({week_label:'2026-W43',week_start:'2026-01-01T00:00:00Z'},ZONE),'2026-W43');
  assert.equal(cycleIdForPairingWeek({week_label:'legacy',week_start:'2026-10-18T07:00:00.000Z'},ZONE),'2026-W43');
  assert.equal(cycleIdForPairingWeek({week_label:'legacy',week_start:'2026-10-18T06:59:59.000Z'},ZONE),'2026-W42');
  // New York's Sunday 08:00 is 12:00 UTC, so the same instant is still the earlier cycle there.
  assert.equal(cycleIdForPairingWeek({week_start:'2026-10-18T11:00:00.000Z'},'America/New_York'),'2026-W42');
  assert.equal(cycleIdForPairingWeek({week_start:'2026-10-18T12:00:00.000Z'},'America/New_York'),'2026-W43');
  assert.equal(cycleIdForPairingWeek({week_label:'2026-W99',week_start:'not a date'},ZONE),null);
  assert.equal(cycleIdForPairingWeek(null,ZONE),null);
  // A legacy-labelled week is placed by its start; one with no usable start
  // still counts as a session but never affects the streak.
  const legacy=pairing('2026-W44',{label:'week-of-25-oct'});
  const unplaceable=pairing('2026-W43',{label:'?',start:'?'});
  const progress=build({pairings:[legacy,unplaceable],completed:[legacy,unplaceable]});
  assert.equal(statusOf(progress,'2026-W44'),'completed');
  assert.equal(statusOf(progress,'2026-W43'),'no_pairing');
  assert.equal(progress.sessions.completed,2);
  assert.equal(progress.streak.current_weeks,1);
});

test('cycles step back by local calendar weeks and honour PAIRING_TIME_ZONE',()=>{
  const w44=cycleAt(new Date('2026-10-28T12:00:00Z'),ZONE);
  assert.equal(previousCycle(w44,ZONE).cycleId,'2026-W43');
  assert.equal(previousCycle(previousCycle(w44,ZONE),ZONE).startsAt,'2026-10-11T07:00:00.000Z');
  process.env.PAIRING_TIME_ZONE='America/New_York';
  const progress=buildMemberProgress({userId:ME,now:new Date('2026-10-18T11:00:00Z'),versionKey:KEY,exercises:EXERCISES});
  assert.equal(progress.time_zone,'America/New_York');
  assert.equal(progress.current_cycle.cycle_id,'2026-W42');
});

test('the streak walk stops at the bound and shows at least twelve weeks',()=>{
  const ancient=pairing('2026-W40',{label:'2020-W10',start:'2020-03-01T08:00:00.000Z'});
  const progress=build({pairings:[ancient],completed:[ancient]});
  assert.equal(progress.weeks.length,PROGRESS_WEEKS_SHOWN);
  assert.equal(progress.streak.longest_weeks,0);
  assert.equal(progress.sessions.completed,1);
  const empty=build();
  assert.equal(empty.weeks.length,PROGRESS_WEEKS_SHOWN);
  assert.ok(empty.weeks.every(week=>week.status==='no_pairing'));
  assert.deepEqual([empty.streak.current_weeks,empty.streak.longest_weeks],[0,0]);
  // Data spread over more than twelve weeks extends the walk (but not the chart).
  const old=pairing('2026-W38');
  const older=build({pairings:[old],completed:[old]});
  assert.equal(older.weeks.length,PROGRESS_WEEKS_SHOWN);
  assert.equal(older.streak.longest_weeks,1);
});

test('the pairing window is bounded and says when it was cut',()=>{
  const rows=Array.from({length:MAX_PROGRESS_PAIRINGS+1},(_,index)=>pairing('2026-W44',{group:1000+index}));
  const progress=build({pairings:rows});
  assert.equal(progress.sessions.window_limited,true);
  assert.equal(progress.sessions.pairings,MAX_PROGRESS_PAIRINGS);
  // Exactly the bound is complete, not cut.
  const full=build({pairings:rows.slice(0,MAX_PROGRESS_PAIRINGS)});
  assert.equal(full.sessions.window_limited,false);
  assert.equal(full.sessions.pairings,MAX_PROGRESS_PAIRINGS);
});

test('demo-week pairings are reported but never counted, like /api/stats',()=>{
  const real=pairing('2026-W43');
  const demo={...pairing('2026-W44',{group:999}),is_demo:1};
  const progress=build({pairings:[demo,real],completed:[real,demo]});
  assert.deepEqual(progress.sessions,{completed:1,solo_completed:0,pairings:1,demo_pairings:1,window_limited:false});
  // The demo week does not make its cycle completed.
  assert.equal(statusOf(progress,'2026-W44'),'no_pairing');
  assert.equal(progress.streak.current_weeks,1);
  // A malformed demo row cannot break the real counts either.
  const broken=build({pairings:[{...demo,user_b_source:null,user_a_id:77},real],completed:[real]});
  assert.equal(broken.sessions.demo_pairings,1);
  assert.equal(broken.sessions.completed,1);
});

test('pairings with an unknown participant source are dropped like History drops them',()=>{
  const unknown=pairing('2026-W44',{sources:{user_b_source:null}});
  const progress=build({pairings:[unknown],completed:[]});
  assert.equal(progress.sessions.pairings,0);
  assert.equal(statusOf(progress,'2026-W44'),'no_pairing');
  // A legacy-source partner is kept; only authenticated members must confirm.
  const legacy=pairing('2026-W44',{sources:{user_b_source:'users'}});
  const kept=build({pairings:[legacy],receiptRows:receipts(legacy,[ME])});
  assert.equal(kept.sessions.completed,1);
});

test('invalid inputs and corrupt stored pairs fail instead of inventing numbers',()=>{
  assert.throws(()=>build({userId:0}),ProgressDataError);
  assert.throws(()=>build({now:'nope'}),ProgressDataError);
  assert.throws(()=>build({pairings:[{...pairing('2026-W44'),user_a_id:9,user_b_id:10}]}),SessionCompletionDataError);
  const row=pairing('2026-W44');
  assert.throws(()=>build({pairings:[row],receiptRows:receipts(row,[ME,THIRD])}),SessionCompletionDataError);
  // `now` may also be an ISO string.
  assert.equal(buildMemberProgress({userId:ME,now:NOW,timeZone:ZONE,versionKey:KEY,exercises:EXERCISES}).generated_at,NOW);
});

// ------------------------------------------------------------------ runs

test('run outcomes count only the member’s verified runs, by cycle',()=>{
  const runs=[
    run({at:'2026-11-03 09:00:00'}),
    run({at:'2026-11-02 09:00:00',passed:5}),
    run({at:'2026-11-02 08:00:00',passed:0,total:0,snapshotTotal:0}),
    run({at:'2026-11-01 09:00:00',attestation:'forged'}),
    run({at:'2026-11-01 09:00:00',source:'leetcode'}),
    run({at:'2026-11-01 09:00:00',snapshotTotal:9}),
    run({at:'2026-11-01 09:00:00',user:PARTNER}),
    {...run({at:'2026-11-01 09:00:00'}),question_slug:'Not A Slug'},
    {...run({at:'2026-11-01 09:00:00'}),test_cases_snapshot:'{'},
  ];
  const progress=build({runs});
  const w45=progress.weeks.at(-1);
  assert.deepEqual([w45.verified_runs,w45.passed_runs],[3,1]);
  assert.deepEqual(progress.runs,{window_weeks:PROGRESS_WEEKS_SHOWN,verified:3,passed:1,scan_limited:false});
});

test('runs are bucketed at the Sunday 08:00 boundary in winter and summer',()=>{
  const progress=build({runs:[
    run({at:'2026-10-25 07:59:59'}),run({at:'2026-10-25 08:00:00'}),
    run({at:'2026-10-18 06:59:59'}),run({at:'2026-10-18 07:00:00'}),
    run({at:'2025-01-05 10:00:00'}),
  ]});
  const counts=Object.fromEntries(progress.weeks.map(week=>[week.cycle_id,week.verified_runs]));
  assert.equal(counts['2026-W42'],1);
  assert.equal(counts['2026-W43'],2);
  assert.equal(counts['2026-W44'],1);
  // Outside the chart window it still counts towards coverage.
  assert.equal(progress.runs.verified,4);
  assert.equal(progress.coverage.exercises.attempted,1);
});

test('the run scan is bounded and says when it was cut',()=>{
  const runs=Array.from({length:MAX_PROGRESS_RUN_SCAN+1},()=>run({at:'2026-11-02 09:00:00'}));
  const progress=build({runs});
  assert.equal(progress.runs.scan_limited,true);
  assert.equal(progress.runs.verified,MAX_PROGRESS_RUN_SCAN);
});

test('an attestation verifier failure is not mistaken for an unverified run',()=>{
  assert.throws(()=>build({runs:[run()],verifyAttestation:()=>{ throw new TypeError('keyring broken'); }}),TypeError);
});

// ------------------------------------------------------------------ coverage

test('coverage lists every pattern and topic, including untouched ones',()=>{
  const progress=build({runs:[
    run({slug:'focus-block-rollup'}),
    run({slug:'capacity-upgrade-index',passed:2}),
    run({slug:'retired-exercise'}),
  ]});
  assert.deepEqual(progress.coverage.exercises,{total:4,attempted:2,solved:1});
  assert.deepEqual(progress.coverage.patterns,[
    {key:'array-processing',exercises:1,attempted:1,solved:1},
    {key:'binary-search',exercises:1,attempted:1,solved:0},
    {key:'graph-traversal',exercises:1,attempted:0,solved:0},
    {key:'two-pointers',exercises:1,attempted:0,solved:0},
  ]);
  assert.deepEqual(progress.coverage.topics.find(topic=>topic.key==='arrays'),{key:'arrays',exercises:3,attempted:2,solved:1});
  assert.deepEqual(progress.coverage.topics.find(topic=>topic.key==='graphs'),{key:'graphs',exercises:1,attempted:0,solved:0});
});

test('coverage tolerates exercises without a pattern or topics and ignores duplicate tags',()=>{
  const coverage=catalogueCoverage([
    {slug:'a',type:'',tags:['x','x']},{slug:'b',tags:null},{slug:'c',type:'p',tags:['x']},
  ],[{slug:'a',passed:true},{slug:'c',passed:false}]);
  assert.deepEqual(coverage.exercises,{total:3,attempted:2,solved:1});
  assert.deepEqual(coverage.patterns,[{key:'p',exercises:1,attempted:1,solved:0}]);
  assert.deepEqual(coverage.topics,[{key:'x',exercises:2,attempted:2,solved:1}]);
});

test('the default catalogue is the live public catalogue',()=>{
  const progress=buildMemberProgress({userId:ME,now:NOW,timeZone:ZONE,versionKey:KEY});
  assert.ok(progress.coverage.exercises.total>=10);
  assert.ok(progress.coverage.patterns.every(group=>group.attempted===0&&group.exercises>=1));
});

// ------------------------------------------------------------------ roles

test('role balance uses the final candidate of completed partnered sessions only',()=>{
  const w42=pairing('2026-W42');
  const w43=pairing('2026-W43');
  const w44=pairing('2026-W44');
  const open=pairing('2026-W45');
  const solo=pairing('2026-W41',{ai:true});
  const control=(row,candidate,members=[ME,PARTNER])=>({week_id:row.week_id,pair_group_id:row.pg_id,
    pair_user_a_id:members[0],pair_user_b_id:members[1],candidate_user_id:candidate});
  const progress=build({
    pairings:[open,w44,w43,w42,solo],completed:[w42,w43,w44,solo],
    controls:[control(w42,ME),control(w43,PARTNER),control(open,ME),control(w44,ME,[PARTNER,THIRD]),control(solo,ME)],
  });
  assert.deepEqual(progress.roles,{available:true,sessions:2,candidate:1,interviewer:1});
  const invalid=build({pairings:[w42],completed:[w42],controls:[control(w42,THIRD)]});
  assert.deepEqual(invalid.roles,{available:false});
  assert.deepEqual(build({pairings:[w42],completed:[w42]}).roles,{available:false});
});

// ------------------------------------------------------------------ reads

test('statements are bounded and scoped to the session user',()=>{
  const statements=progressStatements({userId:ME,now:NOW});
  assert.equal(statements.length,3);
  for(const statement of statements){
    assert.match(statement.sql,/LIMIT \?/);
    assert.ok(statement.args.includes(ME));
    assert.doesNotMatch(statement.sql,/\b(?:INSERT|UPDATE|DELETE|CREATE|DROP|ALTER|PRAGMA)\b/i);
  }
  assert.deepEqual(statements[0].args,[ME,ME,ME,ME,MAX_PROGRESS_PAIRINGS+1]);
  // Skip decisions: from the deepest examinable cycle up to now, never a future cycle.
  assert.deepEqual(statements[1].args,['2021-11-03T12:00:00.000Z',NOW,ME,MAX_PROGRESS_PAIRINGS]);
  assert.deepEqual(statements[2].args,[ME,MAX_PROGRESS_RUN_SCAN+1]);
});

test('joined pairing rows split back into pairings, controls and receipts',()=>{
  const base={week_id:44,week_label:'2026-W44',week_start:weekStarts['2026-W44'],is_ai_pair:0,user_a_id:ME,user_b_id:PARTNER,
    user_c_id:null,user_a_source:'auth',user_b_source:'auth',user_c_source:null};
  const split=splitPairingRows([
    {...base,pg_id:2,control_user_a_id:ME,control_user_b_id:PARTNER,control_candidate_user_id:PARTNER,receipt_user_id:ME,receipt_confirmed_at:'a'},
    {...base,pg_id:2,control_user_a_id:ME,control_user_b_id:PARTNER,control_candidate_user_id:PARTNER,receipt_user_id:PARTNER,receipt_confirmed_at:'b'},
    {...base,pg_id:1,control_candidate_user_id:null,receipt_user_id:null},
  ]);
  assert.deepEqual(split.pairingRows.map(row=>row.pg_id),[2,1]);
  assert.deepEqual(split.controlRows,[{week_id:44,pair_group_id:2,pair_user_a_id:ME,pair_user_b_id:PARTNER,candidate_user_id:PARTNER}]);
  assert.deepEqual(split.receiptRows,[
    {week_id:44,pair_group_id:2,user_id:ME,confirmed_at:'a'},{week_id:44,pair_group_id:2,user_id:PARTNER,confirmed_at:'b'},
  ]);
  assert.deepEqual(splitPairingRows([]),{pairingRows:[],controlRows:[],receiptRows:[]});
});

test('readiness probes are cached per client and retried after a failure',async()=>{
  await assert.rejects(()=>ensureProgressReadiness(null),TypeError);
  let calls=0;
  let fail=true;
  const db={execute:async()=>{ calls+=1; if(fail) throw new Error('no such table'); return {rows:[]}; }};
  await assert.rejects(()=>ensureProgressReadiness(db),/no such table/);
  fail=false;
  await ensureProgressReadiness(db);
  const after=calls;
  await ensureProgressReadiness(db);
  assert.equal(calls,after);
});

test('reads use database time and reject malformed results',async()=>{
  const okResult={rows:[]};
  const db=({clock='2026-11-04T12:00:00.000Z',results=[okResult,okResult,okResult]}={})=>({
    execute:async()=>({rows:[{now_utc:clock}]}),
    batch:async(statements,mode)=>{ assert.equal(mode,'read'); assert.equal(statements.length,3); return results; },
  });
  const progress=await readMemberProgress(db(),{userId:ME,timeZone:ZONE,versionKey:KEY,exercises:EXERCISES});
  assert.equal(progress.generated_at,NOW);
  assert.equal(progress.coverage.exercises.total,4);
  const live=await readMemberProgress(db(),{userId:ME,timeZone:ZONE,versionKey:KEY});
  assert.ok(live.coverage.exercises.total>=10);
  await assert.rejects(()=>readMemberProgress(db({clock:'never'}),{userId:ME}),ProgressDataError);
  await assert.rejects(()=>readMemberProgress({execute:async()=>({}),batch:async()=>[]},{userId:ME}),ProgressDataError);
  await assert.rejects(()=>readMemberProgress(db({results:[okResult]}),{userId:ME}),ProgressDataError);
  await assert.rejects(()=>readMemberProgress(db({results:{}}),{userId:ME}),ProgressDataError);
  await assert.rejects(()=>readMemberProgress(db({results:[okResult,okResult,{}]}),{userId:ME}),ProgressDataError);
});
