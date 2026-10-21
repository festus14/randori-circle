// Personal progress dashboard (issue #293, decision ID-72).
//
// Every number is computed per request from the signed-in member's own
// existing records: their non-demo primary pairings with the completion
// receipts History, recap and /api/stats already project, their explicit
// "Skip this cycle" decisions, the shared session controls of their completed
// sessions, and their own attested runs. Nothing is stored, no table or column
// is added, and every read is bounded by a LIMIT on an indexed path. The
// caller never chooses whose records are read: the handler passes the session
// user id only.
import { listPublicExercises } from './_catalog.js';
import { PairRecapDataError, projectRecapRun } from './_pair-recap.js';
import { resolvePairingCycle } from './_pairing-cycle.js';
import { canonicalCompletionPair, projectSessionCompletion } from './_session-completion.js';

export const PROGRESS_WEEKS_SHOWN=12;
// Pairing rows read per request: about five years of weekly cycles.
export const MAX_PROGRESS_PAIRINGS=260;
// The member's newest runs read per request (the recap scans the same bound).
export const MAX_PROGRESS_RUN_SCAN=500;
export const STREAK_RULES_VERSION=1;
export const WEEK_STATUSES=Object.freeze([
  'completed','in_progress','not_available','solo','no_pairing','not_completed',
]);

const CYCLE_ID_PATTERN=/^\d{4}-W(?:0[1-9]|[1-4]\d|5[0-3])$/;
const USER_ID_PATTERN=/^[1-9]\d{0,15}$/;
const ALLOWED_QUERY_KEYS=new Set(['endpoint','user_id']);
const readinessByClient=new WeakMap();

export class ProgressInputError extends Error{
  constructor(message){
    super(message);
    this.name='ProgressInputError';
  }
}

export class ProgressDataError extends Error{
  constructor(message){
    super(message);
    this.name='ProgressDataError';
  }
}

export function progressDashboardEnabled(env=process.env){
  return env.PROGRESS_DASHBOARD_ENABLED==='true';
}

function requestQuery(req){
  const result=Object.create(null);
  if(req?.query&&typeof req.query==='object'&&!Array.isArray(req.query)){
    for(const [key,value] of Object.entries(req.query)) result[key]=value;
  }
  try{
    const search=new URL(req?.url||'/','http://localhost').searchParams;
    for(const key of new Set(search.keys())){
      const values=search.getAll(key);
      if(values.length>1) result[key]=values;
      else if(!Object.prototype.hasOwnProperty.call(result,key)) result[key]=values[0];
      else if(!Array.isArray(result[key])&&String(result[key])!==values[0]) result[key]=[result[key],values[0]];
    }
  }catch{}
  return result;
}

/**
 * The only optional parameter is `user_id`, so a request for somebody else is
 * an explicit, testable denial rather than an impossible one. The handler
 * answers 404 unless it equals the session user.
 */
export function parseProgressQuery(req){
  const query=requestQuery(req);
  if(Object.keys(query).some(key=>!ALLOWED_QUERY_KEYS.has(key))){
    throw new ProgressInputError('unsupported query parameter');
  }
  if(Object.values(query).some(Array.isArray)){
    throw new ProgressInputError('query parameters must be provided once');
  }
  if(query.endpoint!==undefined&&query.endpoint!=='progress'){
    throw new ProgressInputError('unsupported progress endpoint');
  }
  if(query.user_id===undefined) return Object.freeze({userId:null});
  const raw=typeof query.user_id==='number'?String(query.user_id):query.user_id;
  const userId=typeof raw==='string'&&USER_ID_PATTERN.test(raw)?Number(raw):null;
  if(!Number.isSafeInteger(userId)) throw new ProgressInputError('user_id must be a positive integer');
  return Object.freeze({userId});
}

export async function ensureProgressReadiness(db){
  if(!db||typeof db.execute!=='function') throw new TypeError('database client is required');
  const existing=readinessByClient.get(db);
  if(existing) return existing;
  const pending=(async()=>{
    await db.execute(`SELECT id,week_label,week_start,is_demo FROM pairing_weeks LIMIT 0`);
    await db.execute(`SELECT id,week_id,user_a_id,user_b_id,user_c_id,is_ai_pair FROM pairing_groups LIMIT 0`);
    await db.execute(`SELECT week_id,user_id,source FROM pairing_participants LIMIT 0`);
    await db.execute(`SELECT week_id,pair_group_id,user_id,confirmed_at FROM session_completion_receipts LIMIT 0`);
    await db.execute(`SELECT week_id,pair_group_id,pair_user_a_id,pair_user_b_id,candidate_user_id
      FROM pair_session_controls LIMIT 0`);
    await db.execute(`SELECT id,is_primary,archived_at FROM circles LIMIT 0`);
    await db.execute(`SELECT scope_key,cycle_key,cycle_id,starts_at FROM pairing_cycles LIMIT 0`);
    await db.execute(`SELECT scope_key,cycle_key,user_id,is_available,decision_source
      FROM pairing_cycle_availability LIMIT 0`);
    await db.execute(`SELECT id,user_id,week_id,pair_group_id,question_slug,language,code,test_cases_snapshot,
      results_json,passed_count,total_count,duration_ms,created_at FROM session_runs LIMIT 0`);
    return true;
  })();
  readinessByClient.set(db,pending);
  try{ return await pending; }
  catch(error){
    readinessByClient.delete(db);
    throw error;
  }
}

// ---------------------------------------------------------------------------
// Cycles: the same Sunday 08:00 boundary in PAIRING_TIME_ZONE as pairing and
// availability, stepped with local-calendar arithmetic so DST weeks stay
// consecutive.
// ---------------------------------------------------------------------------

export function cycleAt(instant,timeZone){
  return resolvePairingCycle({now:instant,timeZone,state:'current'});
}

export function previousCycle(cycle,timeZone){
  return cycleAt(new Date(Date.parse(cycle.startsAt)-1),timeZone);
}

/** The cycle a stored pairing week belongs to: its label, else its start instant. */
export function cycleIdForPairingWeek(row,timeZone){
  if(typeof row?.week_label==='string'&&CYCLE_ID_PATTERN.test(row.week_label)) return row.week_label;
  const start=Date.parse(String(row?.week_start??''));
  return Number.isFinite(start)?cycleAt(new Date(start),timeZone).cycleId:null;
}

/**
 * Streak rules v1 (docs/PROGRESS_DASHBOARD.md). A week is one pairing cycle.
 * - completed: a session with at least one partner was confirmed by every
 *   participant (the unanimous receipts History counts). Extends the streak.
 * - in_progress: the current cycle, paired with a partner, not yet completed.
 *   Neutral: it neither extends nor ends the streak.
 * - not_available: the member saved "Skip this cycle". Pauses.
 * - solo: the member was the odd one out (solo pairing). Pauses, even when
 *   the solo session was confirmed: a week counts only when partners complete.
 * - no_pairing: the member was not in that cycle's pairing (no publication,
 *   joined later, not included). Pauses.
 * - not_completed: paired with a partner, the cycle ended, and not everyone
 *   confirmed (including cycles with no receipts at all). Ends the streak.
 */
export function classifyWeek({sessions=[],notAvailable=false,isCurrent=false}={}){
  const partnered=sessions.filter(session=>!session.isAi);
  if(partnered.some(session=>session.state==='completed')) return 'completed';
  if(notAvailable) return 'not_available';
  if(partnered.length) return isCurrent?'in_progress':'not_completed';
  if(sessions.length) return 'solo';
  return 'no_pairing';
}

/** `statuses` is newest first. Pauses and in-progress weeks are skipped. */
export function computeStreak(statuses){
  let current=0;
  for(const status of statuses){
    if(status==='not_completed') break;
    if(status==='completed') current+=1;
  }
  let longest=0;
  let run=0;
  for(const status of [...statuses].reverse()){
    if(status==='not_completed') run=0;
    else if(status==='completed'){ run+=1; longest=Math.max(longest,run); }
  }
  return Object.freeze({current,longest});
}

// ---------------------------------------------------------------------------
// Catalogue coverage
// ---------------------------------------------------------------------------

function coverageGroups(exercises,keyOf,attempted,solved){
  const groups=new Map();
  for(const exercise of exercises){
    for(const key of keyOf(exercise)){
      const group=groups.get(key)||{key,exercises:0,attempted:0,solved:0};
      group.exercises+=1;
      if(attempted.has(exercise.slug)) group.attempted+=1;
      if(solved.has(exercise.slug)) group.solved+=1;
      groups.set(key,group);
    }
  }
  return [...groups.values()].sort((left,right)=>left.key.localeCompare(right.key));
}

/**
 * Patterns are the catalogue `type`, topics are its `tags`. Every active
 * exercise is listed, so untouched patterns and topics appear with zero.
 */
export function catalogueCoverage(exercises,verifiedRuns){
  const active=new Set(exercises.map(exercise=>exercise.slug));
  const attempted=new Set();
  const solved=new Set();
  for(const run of verifiedRuns){
    if(!active.has(run.slug)) continue;
    attempted.add(run.slug);
    if(run.passed) solved.add(run.slug);
  }
  return {
    exercises:{total:active.size,attempted:attempted.size,solved:solved.size},
    patterns:coverageGroups(exercises,exercise=>typeof exercise.type==='string'&&exercise.type?[exercise.type]:[],attempted,solved),
    topics:coverageGroups(exercises,exercise=>Array.isArray(exercise.tags)?[...new Set(exercise.tags)]:[],attempted,solved),
  };
}

// ---------------------------------------------------------------------------
// Response
// ---------------------------------------------------------------------------

function participantsAreKnown(row){
  return [
    [row.user_a_id,row.user_a_source],[row.user_b_id,row.user_b_source],[row.user_c_id,row.user_c_source],
  ].every(([id,source])=>id==null||source==='auth'||source==='users');
}

function verifiedOwnRun(row,userId,verifyAttestation){
  let run;
  try{ run=projectRecapRun({...row,runner_display_name:'Member'},verifyAttestation); }
  catch(error){
    if(error instanceof PairRecapDataError) return null;
    throw error;
  }
  if(!run||run.actor.id!==userId) return null;
  return {
    slug:run.question_slug,
    passed:run.total_count>0&&run.passed_count===run.total_count,
    at:Date.parse(run.created_at),
  };
}

/** Pure: turns the bounded reads into the response body. */
export function buildMemberProgress({
  userId,now,timeZone,pairingRows=[],receiptRows=[],controlRows=[],skipRows=[],runRows=[],
  versionKey,verifyAttestation,exercises=listPublicExercises(),
}){
  if(!Number.isSafeInteger(userId)||userId<1) throw new ProgressDataError('progress user is invalid');
  const instant=now instanceof Date?now:new Date(now);
  if(!Number.isFinite(instant.getTime())) throw new ProgressDataError('progress time is invalid');
  const current=cycleAt(instant,timeZone);

  const pairingWindowLimited=pairingRows.length>MAX_PROGRESS_PAIRINGS;
  const pairings=pairingRows.slice(0,MAX_PROGRESS_PAIRINGS).filter(participantsAreKnown);
  const receiptsByPair=new Map();
  for(const receipt of receiptRows){
    const key=`${receipt.week_id}:${receipt.pair_group_id}`;
    receiptsByPair.set(key,[...(receiptsByPair.get(key)||[]),receipt]);
  }
  const sessions=pairings.map(row=>{
    const pair=canonicalCompletionPair({...row,pair_group_id:row.pg_id},userId);
    const completion=projectSessionCompletion(pair,receiptsByPair.get(`${row.week_id}:${row.pg_id}`)||[],versionKey);
    return {
      key:`${pair.weekId}:${pair.pairGroupId}`,isAi:pair.isAi,state:completion.state,
      cycleId:cycleIdForPairingWeek(row,timeZone),
    };
  });

  const skipped=new Set(skipRows.map(row=>String(row.cycle_id)).filter(id=>CYCLE_ID_PATTERN.test(id)));
  const sessionsByCycle=new Map();
  for(const session of sessions){
    if(!session.cycleId) continue;
    sessionsByCycle.set(session.cycleId,[...(sessionsByCycle.get(session.cycleId)||[]),session]);
  }
  // Walk back from the current cycle until every cycle the member has data for
  // has been seen, showing at least PROGRESS_WEEKS_SHOWN and at most
  // MAX_PROGRESS_PAIRINGS cycles.
  const unseen=new Set([...sessionsByCycle.keys(),...skipped]);
  const cycles=[];
  for(let cycle=current;cycles.length<MAX_PROGRESS_PAIRINGS;cycle=previousCycle(cycle,timeZone)){
    cycles.push(cycle);
    unseen.delete(cycle.cycleId);
    if(!unseen.size&&cycles.length>=PROGRESS_WEEKS_SHOWN) break;
  }
  const weeks=cycles.map((cycle,index)=>{
    const weekSessions=sessionsByCycle.get(cycle.cycleId)||[];
    const status=classifyWeek({sessions:weekSessions,notAvailable:skipped.has(cycle.cycleId),isCurrent:index===0});
    const partnered=weekSessions.find(session=>!session.isAi);
    return {
      cycle_id:cycle.cycleId,starts_at:cycle.startsAt,ends_at:cycle.endsAt,status,
      completion:status==='not_completed'||status==='in_progress'?partnered.state:null,
      verified_runs:0,passed_runs:0,
    };
  });
  const streak=computeStreak(weeks.map(week=>week.status));
  const shown=weeks.slice(0,PROGRESS_WEEKS_SHOWN);

  const runScanLimited=runRows.length>MAX_PROGRESS_RUN_SCAN;
  const verifiedRuns=runRows.slice(0,MAX_PROGRESS_RUN_SCAN)
    .map(row=>verifiedOwnRun(row,userId,verifyAttestation)).filter(Boolean);
  let windowVerified=0;
  let windowPassed=0;
  for(const run of verifiedRuns){
    const week=shown.find(candidate=>Date.parse(candidate.starts_at)<=run.at&&run.at<Date.parse(candidate.ends_at));
    if(!week) continue;
    week.verified_runs+=1;
    windowVerified+=1;
    if(run.passed){ week.passed_runs+=1; windowPassed+=1; }
  }

  const controls=new Map(controlRows.map(row=>[`${row.week_id}:${row.pair_group_id}`,row]));
  let candidate=0;
  let interviewer=0;
  for(const session of sessions){
    if(session.isAi||session.state!=='completed') continue;
    const control=controls.get(session.key);
    const members=[Number(control?.pair_user_a_id),Number(control?.pair_user_b_id)];
    const chosen=Number(control?.candidate_user_id);
    if(!control||!members.includes(userId)||!members.includes(chosen)) continue;
    if(chosen===userId) candidate+=1; else interviewer+=1;
  }

  const completed=sessions.filter(session=>session.state==='completed');
  return {
    user:{id:userId},
    generated_at:instant.toISOString(),
    time_zone:current.timeZone,
    current_cycle:{cycle_id:current.cycleId,starts_at:current.startsAt,ends_at:current.endsAt},
    sessions:{
      completed:completed.length,
      solo_completed:completed.filter(session=>session.isAi).length,
      pairings:sessions.length,
      window_limited:pairingWindowLimited,
    },
    streak:{
      rules_version:STREAK_RULES_VERSION,
      current_weeks:streak.current,
      longest_weeks:streak.longest,
      this_week:weeks[0].status,
    },
    weeks:shown.reverse(),
    runs:{
      window_weeks:PROGRESS_WEEKS_SHOWN,
      verified:windowVerified,
      passed:windowPassed,
      scan_limited:runScanLimited,
    },
    coverage:catalogueCoverage(exercises,verifiedRuns),
    roles:candidate+interviewer>0
      ?{available:true,sessions:candidate+interviewer,candidate,interviewer}
      :{available:false},
    // Seam for issue #290 (structured feedback): trends by rubric dimension
    // will be added here once feedback is recorded.
    feedback:{available:false},
  };
}

// ---------------------------------------------------------------------------
// Bounded reads (one read transaction)
// ---------------------------------------------------------------------------

const OWN_PAIRINGS_SQL=`SELECT pg.id AS pg_id,pg.week_id,pg.user_a_id,pg.user_b_id,pg.user_c_id,
    pa.source AS user_a_source,pb.source AS user_b_source,pc.source AS user_c_source,
    pg.is_ai_pair,pw.week_label,pw.week_start
  FROM pairing_groups pg
  JOIN pairing_weeks pw ON pw.id=pg.week_id
  JOIN pairing_participants viewer ON viewer.week_id=pg.week_id AND viewer.user_id=? AND viewer.source='auth'
  LEFT JOIN pairing_participants pa ON pa.week_id=pg.week_id AND pa.user_id=pg.user_a_id
  LEFT JOIN pairing_participants pb ON pb.week_id=pg.week_id AND pb.user_id=pg.user_b_id
  LEFT JOIN pairing_participants pc ON pc.week_id=pg.week_id AND pc.user_id=pg.user_c_id
  WHERE (pg.user_a_id=? OR pg.user_b_id=? OR pg.user_c_id=?) AND COALESCE(pw.is_demo,0)=0
  ORDER BY pw.week_start DESC,pg.id DESC
  LIMIT ?`;

export function progressStatements({userId,now}){
  const own=[userId,userId,userId,userId,MAX_PROGRESS_PAIRINGS+1];
  const mine=`WITH mine AS (${OWN_PAIRINGS_SQL})`;
  // Skip decisions older than the deepest cycle the response can examine are irrelevant.
  const oldest=new Date(Date.parse(now)-(MAX_PROGRESS_PAIRINGS+1)*7*24*60*60*1000).toISOString();
  return [
    {sql:OWN_PAIRINGS_SQL,args:own},
    {sql:`${mine}
      SELECT receipt.week_id,receipt.pair_group_id,receipt.user_id,receipt.confirmed_at
      FROM session_completion_receipts receipt
      JOIN mine ON mine.week_id=receipt.week_id AND mine.pg_id=receipt.pair_group_id
      ORDER BY receipt.week_id,receipt.pair_group_id,receipt.user_id`,args:own},
    {sql:`${mine}
      SELECT control.week_id,control.pair_group_id,control.pair_user_a_id,control.pair_user_b_id,
        control.candidate_user_id
      FROM pair_session_controls control
      JOIN mine ON mine.week_id=control.week_id AND mine.pg_id=control.pair_group_id`,args:own},
    {sql:`SELECT cycle.cycle_id
      FROM pairing_cycles cycle
      JOIN pairing_cycle_availability decision
        ON decision.scope_key=cycle.scope_key AND decision.cycle_key=cycle.cycle_key AND decision.user_id=?
      WHERE cycle.scope_key=(SELECT 'circle:'||circle.id FROM circles circle
          WHERE circle.is_primary=1 AND circle.archived_at IS NULL ORDER BY circle.id LIMIT 1)
        AND decision.decision_source='user' AND decision.is_available=0
        AND cycle.starts_at>=?
      ORDER BY cycle.starts_at DESC
      LIMIT ?`,args:[userId,oldest,MAX_PROGRESS_PAIRINGS]},
    // idx_runs_user (user_id, created_at DESC) serves this newest-first window.
    {sql:`SELECT id,user_id,week_id,pair_group_id,question_slug,language,code,test_cases_snapshot,results_json,
        passed_count,total_count,duration_ms,created_at
      FROM session_runs WHERE user_id=?
      ORDER BY created_at DESC
      LIMIT ?`,args:[userId,MAX_PROGRESS_RUN_SCAN+1]},
  ];
}

export async function readMemberProgress(db,{userId,timeZone,versionKey,verifyAttestation,exercises}){
  const clock=await db.execute(`SELECT strftime('%Y-%m-%dT%H:%M:%fZ','now') AS now_utc`);
  const now=String(clock.rows?.[0]?.now_utc||'');
  if(!Number.isFinite(Date.parse(now))) throw new ProgressDataError('database time is unavailable');
  const results=await db.batch(progressStatements({userId,now}),'read');
  if(!Array.isArray(results)||results.length!==5||results.some(result=>!Array.isArray(result?.rows))){
    throw new ProgressDataError('progress read is invalid');
  }
  const [pairings,receipts,controls,skips,runs]=results.map(result=>result.rows);
  return buildMemberProgress({
    userId,now:new Date(now),timeZone,pairingRows:pairings,receiptRows:receipts,controlRows:controls,
    skipRows:skips,runRows:runs,versionKey,verifyAttestation,
    ...(exercises?{exercises}:{}),
  });
}
