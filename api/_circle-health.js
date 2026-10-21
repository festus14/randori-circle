// Issue #292: owner-only, aggregate "circle health" for the last eight cycles.
//
// Everything here is read-only and computed from tables that already exist:
// the primary circle's immutable weekly publication (pairing_weeks,
// pairing_participants, pairing_groups), its schedules (pair_schedules) and
// completion receipts (session_completion_receipts, ID-55), and a secondary
// circle's v13 publication and v16 schedule tables. No table, index, cache
// row or migration is added; see docs/CIRCLE_HEALTH.md.
//
// Privacy: the server never returns a per-member row, and every count that
// covers fewer than CIRCLE_HEALTH_MIN_CELL members (or that a reader could
// derive by subtracting two shown funnel counts) is replaced by a
// `suppressed` cell before the response is built.
//
// This module deliberately imports nothing that unit tests commonly replace
// (no _db.js, _active-circle.js or _circle-membership.js), so the capability
// check in auth.js and the route in ops.js can load it safely.
import { resolvePairingCycle } from './_pairing-cycle.js';
import { normalizeScheduleInstant } from './_schedule.js';

export const CIRCLE_HEALTH_MIN_CELL=3;
export const CIRCLE_HEALTH_WINDOW=8;
export const CIRCLE_HEALTH_LOOKBACK=8;
export const CIRCLE_HEALTH_VERSION=1;
export const CIRCLE_HEALTH_CACHE_CONTROL='private, no-store';

// Cancellations and no-shows need the cancel/no-show records from issue #291.
// Until that storage exists these cells are reported as `not_tracked`; #291
// replaces this constant and fills `attendanceOutcomes()` below.
export const ATTENDANCE_OUTCOMES_TRACKED=false;

const ISO_WEEK_GLOB="'[0-9][0-9][0-9][0-9]-W[0-9][0-9]'";
const HOUR_MS=60*60*1000;

export function circleHealthEnabled(env=process.env){
  return env?.CIRCLE_HEALTH_ENABLED==='true'&&env?.CIRCLE_MEMBERSHIP_ENABLED==='true';
}

function positiveId(value){
  const number=Number(value);
  return Number.isSafeInteger(number)&&number>0?number:null;
}

// ---------------------------------------------------------------------------
// Suppression (pure)
// ---------------------------------------------------------------------------

export function smallCell(count,minimum=CIRCLE_HEALTH_MIN_CELL){
  return count>0&&count<minimum;
}

const SUPPRESSED=Object.freeze({status:'suppressed',value:null});
const NO_DATA=Object.freeze({status:'no_data',value:null});
const NOT_TRACKED=Object.freeze({status:'not_tracked',value:null});

function okCell(value){
  return Object.freeze({status:'ok',value});
}

/** A member count: zero is shown, 1..minimum-1 is suppressed. */
export function countCell(count,{minimum=CIRCLE_HEALTH_MIN_CELL,relatedCounts=[]}={}){
  if(smallCell(count,minimum)) return SUPPRESSED;
  // A count is also hidden when its difference from another shown funnel
  // count would itself be a small cell (for example 6 paired and 4
  // scheduled reveals that one pair did not schedule).
  if(relatedCounts.some(related=>smallCell(Math.abs(related-count),minimum))) return SUPPRESSED;
  return okCell(count);
}

/** Median of a non-empty numeric list. */
export function median(values){
  const sorted=[...values].sort((left,right)=>left-right);
  const middle=Math.floor(sorted.length/2);
  return sorted.length%2?sorted[middle]:(sorted[middle-1]+sorted[middle])/2;
}

function roundTo(value,places){
  const factor=10**places;
  return Math.round(value*factor)/factor;
}

/**
 * Apply every suppression rule to one cycle's raw aggregates. `raw` holds
 * member counts only; nothing in it identifies a member.
 */
export function suppressCycleMetrics(raw,{minimum=CIRCLE_HEALTH_MIN_CELL,completionTracked=true}={}){
  const notTracked={
    completed:completionTracked?undefined:NOT_TRACKED,
    cancelled:NOT_TRACKED,
    no_show:NOT_TRACKED,
  };
  // Cycle floor: when only one or two members took part, every count would
  // describe them, so the whole cycle is withheld.
  if(smallCell(raw.available,minimum)){
    return Object.freeze({
      suppressed:true,
      metrics:Object.freeze({
        available:SUPPRESSED,paired:SUPPRESSED,solo:SUPPRESSED,scheduled:SUPPRESSED,
        completed:notTracked.completed||SUPPRESSED,cancelled:notTracked.cancelled,no_show:notTracked.no_show,
        median_hours_to_agreed_time:SUPPRESSED,repeat_pair_percent:SUPPRESSED,
      }),
    });
  }
  const paired=countCell(raw.paired,{minimum});
  const scheduled=countCell(raw.scheduled,{minimum,relatedCounts:[raw.paired]});
  const completed=notTracked.completed||countCell(raw.completed,{
    minimum,relatedCounts:[raw.paired,raw.scheduled],
  });
  let medianCell=NO_DATA;
  if(raw.leadMembers>0){
    medianCell=raw.leadMembers<minimum?SUPPRESSED:okCell(roundTo(median(raw.leadHours),1));
  }
  let repeatCell=NO_DATA;
  if(raw.humanGroups>0){
    const fresh=raw.paired-raw.repeatMembers;
    repeatCell=raw.paired<minimum||smallCell(raw.repeatMembers,minimum)||smallCell(fresh,minimum)
      ?SUPPRESSED
      :okCell(Math.round(100*raw.repeatGroups/raw.humanGroups));
  }
  return Object.freeze({
    suppressed:false,
    metrics:Object.freeze({
      available:countCell(raw.available,{minimum}),
      paired,
      // Solo is the odd member. It follows the same rule, although the parity
      // of `available` implies it; the published pairing already shows every
      // member who practised solo, so this reveals nothing new.
      solo:countCell(raw.solo,{minimum}),
      scheduled,
      completed,
      cancelled:notTracked.cancelled,
      no_show:notTracked.no_show,
      median_hours_to_agreed_time:medianCell,
      repeat_pair_percent:repeatCell,
    }),
  });
}

// ---------------------------------------------------------------------------
// Aggregation (pure)
// ---------------------------------------------------------------------------

function pairKeys(group){
  const members=[...group.members].sort();
  const keys=[];
  for(let left=0;left<members.length;left+=1){
    for(let right=left+1;right<members.length;right+=1) keys.push(`${members[left]}|${members[right]}`);
  }
  return keys;
}

function sum(values){
  return values.reduce((total,value)=>total+value,0);
}

/**
 * Raw member-count aggregates for one cycle. `lookback` is the set of pair
 * keys seen in the previous CIRCLE_HEALTH_LOOKBACK cycles.
 */
export function aggregateCycle(cycle,lookback,{completionTracked=true}={}){
  const human=cycle.groups.filter(group=>!group.solo);
  const scheduledGroups=human.filter(group=>group.scheduled);
  const leads=[];
  let leadMembers=0;
  for(const group of scheduledGroups){
    if(group.agreedAtMs===null||cycle.publishedAtMs===null) continue;
    const hours=(group.agreedAtMs-cycle.publishedAtMs)/HOUR_MS;
    if(!Number.isFinite(hours)||hours<0) continue;
    leads.push(hours);
    leadMembers+=group.members.length;
  }
  const repeatGroups=human.filter(group=>pairKeys(group).some(key=>lookback.has(key)));
  const members=new Set(cycle.availableMembers);
  for(const group of cycle.groups) for(const member of group.members) members.add(member);
  return Object.freeze({
    available:members.size,
    paired:sum(human.map(group=>group.members.length)),
    solo:sum(cycle.groups.filter(group=>group.solo).map(group=>group.members.length)),
    scheduled:sum(scheduledGroups.map(group=>group.members.length)),
    completed:completionTracked
      ?sum(human.filter(group=>group.completed).map(group=>group.members.length))
      :null,
    leadHours:Object.freeze(leads),
    leadMembers,
    humanGroups:human.length,
    repeatGroups:repeatGroups.length,
    repeatMembers:sum(repeatGroups.map(group=>group.members.length)),
  });
}

function currentCycleId(now,timeZone){
  try{ return resolvePairingCycle({now:new Date(now),timeZone,state:'current'}).cycleId; }
  catch{ return null; }
}

/**
 * Turn up to WINDOW+LOOKBACK normalized cycles (newest first) into the public
 * per-cycle response. Pair keys are computed once per cycle and reused by
 * every later cycle's lookback (the per-request, per-cycle cache).
 */
export function buildCircleHealth(cycles,{
  scope,now=Date.now(),timeZone,completionTracked=true,
  windowCycles=CIRCLE_HEALTH_WINDOW,lookbackCycles=CIRCLE_HEALTH_LOOKBACK,minimum=CIRCLE_HEALTH_MIN_CELL,
}={}){
  const keysByCycle=cycles.map(cycle=>new Set(cycle.groups.filter(group=>!group.solo).flatMap(pairKeys)));
  const current=currentCycleId(now,timeZone);
  const visible=cycles.slice(0,windowCycles).map((cycle,index)=>{
    const seen=new Set();
    for(const keys of keysByCycle.slice(index+1,index+1+lookbackCycles)) for(const key of keys) seen.add(key);
    const raw=aggregateCycle(cycle,seen,{completionTracked});
    const result=suppressCycleMetrics(raw,{minimum,completionTracked});
    return Object.freeze({
      cycle_id:cycle.cycleId,
      starts_at:cycle.startsAt,
      in_progress:current!==null&&cycle.cycleId===current,
      suppressed:result.suppressed,
      metrics:result.metrics,
    });
  });
  return Object.freeze({
    version:CIRCLE_HEALTH_VERSION,
    scope,
    window_cycles:windowCycles,
    lookback_cycles:lookbackCycles,
    min_cell_size:minimum,
    completion_tracked:completionTracked,
    attendance_outcomes_tracked:ATTENDANCE_OUTCOMES_TRACKED,
    generated_at:new Date(now).toISOString(),
    cycles:Object.freeze(visible),
  });
}

// ---------------------------------------------------------------------------
// Storage (read-only)
// ---------------------------------------------------------------------------

// SQLite `datetime('now')` (UTC, no zone) or an ISO-8601 instant.
export function parseStoredInstant(value){
  if(typeof value!=='string') return null;
  const text=value.trim();
  const iso=/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(?:\.\d+)?$/.test(text)?`${text.replace(' ','T')}Z`:text;
  const match=/^(\d{4})-(\d{2})-(\d{2})T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.exec(iso);
  if(!match) return null;
  const [year,month,day]=match.slice(1,4).map(Number);
  if(new Date(Date.UTC(year,month-1,day)).getUTCDate()!==day) return null;
  const millis=Date.parse(iso);
  return Number.isFinite(millis)?millis:null;
}

function isoOrNull(value){
  const millis=parseStoredInstant(value);
  return millis===null?null:new Date(millis).toISOString();
}

function agreedInstantMs(value){
  if(typeof value!=='string') return null;
  const normalized=normalizeScheduleInstant(value);
  return normalized&&normalized===value?Date.parse(normalized):null;
}

function hasAgreement(value){
  return typeof value==='string'&&value.trim().length>0;
}

const OWNER_COLUMNS=`circle.id AS circle_id,circle.is_primary
  FROM circle_memberships membership
  JOIN circles circle ON circle.id=membership.circle_id
  WHERE membership.user_id=? AND membership.role='owner' AND membership.status='active'
    AND circle.archived_at IS NULL`;

// Re-checked inside every data statement so no aggregate leaves the database
// unless the caller is still an active owner in the same read snapshot.
const OWNER_GUARD=`owner AS (SELECT 1 FROM circle_memberships membership
    JOIN circles circle ON circle.id=membership.circle_id
    WHERE membership.user_id=? AND membership.circle_id=? AND membership.role='owner'
      AND membership.status='active' AND circle.archived_at IS NULL AND circle.is_primary=?
    LIMIT 1)`;

// Most recent primary weeks by their unique ISO week label (descending scan of
// idx_pairing_weeks_week_label; demo and non-ISO legacy labels are skipped).
const PRIMARY_WEEKS=(limit)=>`SELECT week.id FROM pairing_weeks week
    WHERE week.week_label GLOB ${ISO_WEEK_GLOB} AND COALESCE(week.is_demo,0)=0
    ORDER BY week.week_label DESC LIMIT ${limit}`;

export const CIRCLE_HEALTH_SQL=Object.freeze({
  ownerByCircle:`SELECT ${OWNER_COLUMNS} AND membership.circle_id=? LIMIT 2`,
  ownerOfPrimary:`SELECT ${OWNER_COLUMNS} AND circle.is_primary=1 LIMIT 2`,
  guardedOwner:`WITH ${OWNER_GUARD} SELECT 1 AS owner FROM owner`,
  primaryWeeks:`WITH ${OWNER_GUARD}
    SELECT week.id,week.week_label,week.week_start,week.created_at AS week_created_at,
      run.created_at AS published_at
    FROM pairing_weeks week
    LEFT JOIN pairing_week_runs run ON run.week_label=week.week_label AND run.week_id=week.id
    WHERE week.week_label GLOB ${ISO_WEEK_GLOB} AND COALESCE(week.is_demo,0)=0
      AND EXISTS (SELECT 1 FROM owner)
    ORDER BY week.week_label DESC LIMIT ?`,
  primaryParticipants:`WITH ${OWNER_GUARD}, recent AS (${PRIMARY_WEEKS(CIRCLE_HEALTH_WINDOW)})
    SELECT participant.week_id,participant.user_id,participant.source
    FROM pairing_participants participant
    WHERE participant.week_id IN (SELECT id FROM recent) AND EXISTS (SELECT 1 FROM owner)`,
  // pairing_groups has no week_id index, so this is a scan of pairing_groups
  // (as the existing stats, history and publication reads are). It is the one
  // unindexed read; see docs/CIRCLE_HEALTH.md "Read budget".
  primaryGroups:`WITH ${OWNER_GUARD}, recent AS (${PRIMARY_WEEKS(CIRCLE_HEALTH_WINDOW+CIRCLE_HEALTH_LOOKBACK)})
    SELECT pair.id,pair.week_id,pair.user_a_id,pair.user_b_id,pair.user_c_id,pair.is_ai_pair
    FROM pairing_groups pair
    WHERE pair.week_id IN (SELECT id FROM recent) AND EXISTS (SELECT 1 FROM owner)`,
  primarySchedules:`WITH ${OWNER_GUARD}, recent AS (${PRIMARY_WEEKS(CIRCLE_HEALTH_WINDOW)})
    SELECT schedule.week_id,schedule.pair_group_id,schedule.agreed_time
    FROM pair_schedules schedule
    WHERE schedule.week_id IN (SELECT id FROM recent) AND schedule.agreed_time IS NOT NULL
      AND EXISTS (SELECT 1 FROM owner)`,
  primaryReceipts:`WITH ${OWNER_GUARD}, recent AS (${PRIMARY_WEEKS(CIRCLE_HEALTH_WINDOW)})
    SELECT receipt.week_id,receipt.pair_group_id,receipt.user_id,receipt.participant_source
    FROM session_completion_receipts receipt
    WHERE receipt.week_id IN (SELECT id FROM recent) AND EXISTS (SELECT 1 FROM owner)`,
  secondaryPublications:`WITH ${OWNER_GUARD}
    SELECT publication.id,publication.cycle_id,publication.starts_at,publication.created_at
    FROM circle_pairing_publications publication
    WHERE publication.circle_id=? AND EXISTS (SELECT 1 FROM owner)
    ORDER BY publication.starts_at DESC,publication.id DESC LIMIT ?`,
  secondaryGroups:`WITH ${OWNER_GUARD}, recent AS (SELECT id FROM circle_pairing_publications
      WHERE circle_id=? ORDER BY starts_at DESC,id DESC LIMIT ?)
    SELECT group_row.id,group_row.publication_id,group_row.user_a_id,group_row.user_b_id,group_row.is_solo
    FROM circle_pairing_groups group_row
    WHERE group_row.publication_id IN (SELECT id FROM recent) AND EXISTS (SELECT 1 FROM owner)`,
  secondarySchedules:`WITH ${OWNER_GUARD}, recent AS (SELECT id FROM circle_pairing_publications
      WHERE circle_id=? ORDER BY starts_at DESC,id DESC LIMIT ?)
    SELECT schedule.publication_id,schedule.group_id,schedule.agreed_time
    FROM circle_pair_schedules schedule
    WHERE schedule.publication_id IN (SELECT id FROM recent) AND schedule.agreed_time IS NOT NULL
      AND EXISTS (SELECT 1 FROM owner)`,
});

function rows(result){
  return Array.isArray(result?.rows)?result.rows:[];
}

function groupKey(cycleId,groupId){
  return `${cycleId}:${groupId}`;
}

function normalizePrimary([,weekResult,participantResult,groupResult,scheduleResult,receiptResult]){
  const participants=new Map();
  for(const row of rows(participantResult)){
    const weekId=positiveId(row.week_id);
    const userId=positiveId(row.user_id);
    if(!weekId||!userId) continue;
    if(!participants.has(weekId)) participants.set(weekId,new Map());
    participants.get(weekId).set(userId,String(row.source||'auth'));
  }
  const schedules=new Map();
  for(const row of rows(scheduleResult)){
    schedules.set(groupKey(positiveId(row.week_id),positiveId(row.pair_group_id)),row.agreed_time);
  }
  const receipts=new Map();
  for(const row of rows(receiptResult)){
    const key=groupKey(positiveId(row.week_id),positiveId(row.pair_group_id));
    if(!receipts.has(key)) receipts.set(key,[]);
    receipts.get(key).push({userId:positiveId(row.user_id),source:String(row.participant_source||'')});
  }
  const groupsByWeek=new Map();
  for(const row of rows(groupResult)){
    const weekId=positiveId(row.week_id);
    const groupId=positiveId(row.id);
    if(!weekId||!groupId) continue;
    const ids=[...new Set([row.user_a_id,row.user_b_id,row.user_c_id].map(positiveId).filter(Boolean))];
    const sources=participants.get(weekId)||new Map();
    const solo=Number(row.is_ai_pair)===1||ids.length<2;
    const agreed=schedules.get(groupKey(weekId,groupId));
    // Completion mirrors /api/stats: every auth-source member confirmed, and
    // no receipt belongs to anyone else.
    const required=ids.filter(id=>sources.get(id)==='auth');
    const groupReceipts=receipts.get(groupKey(weekId,groupId))||[];
    const confirmed=groupReceipts.filter(receipt=>required.includes(receipt.userId)&&receipt.source==='auth');
    if(!groupsByWeek.has(weekId)) groupsByWeek.set(weekId,[]);
    groupsByWeek.get(weekId).push(Object.freeze({
      members:Object.freeze(ids.map(String)),
      solo,
      scheduled:hasAgreement(agreed),
      agreedAtMs:agreedInstantMs(agreed),
      completed:required.length>0&&confirmed.length===required.length&&groupReceipts.length===confirmed.length,
    }));
  }
  return rows(weekResult).map(row=>{
    const weekId=positiveId(row.id);
    const members=[...(participants.get(weekId)||new Map()).keys()].map(String);
    return Object.freeze({
      cycleId:String(row.week_label),
      startsAt:isoOrNull(row.week_start),
      publishedAtMs:parseStoredInstant(row.published_at)??parseStoredInstant(row.week_created_at),
      availableMembers:Object.freeze(members),
      groups:Object.freeze(groupsByWeek.get(weekId)||[]),
    });
  });
}

function normalizeSecondary([,publicationResult,groupResult,scheduleResult]){
  const schedules=new Map();
  for(const row of rows(scheduleResult)){
    schedules.set(groupKey(positiveId(row.publication_id),positiveId(row.group_id)),row.agreed_time);
  }
  const groupsByPublication=new Map();
  for(const row of rows(groupResult)){
    const publicationId=positiveId(row.publication_id);
    const groupId=positiveId(row.id);
    if(!publicationId||!groupId) continue;
    const ids=[...new Set([row.user_a_id,row.user_b_id].map(positiveId).filter(Boolean))];
    const agreed=schedules.get(groupKey(publicationId,groupId));
    if(!groupsByPublication.has(publicationId)) groupsByPublication.set(publicationId,[]);
    groupsByPublication.get(publicationId).push(Object.freeze({
      members:Object.freeze(ids.map(String)),
      solo:Number(row.is_solo)===1||ids.length<2,
      scheduled:hasAgreement(agreed),
      agreedAtMs:agreedInstantMs(agreed),
      completed:null,
    }));
  }
  return rows(publicationResult).map(row=>Object.freeze({
    cycleId:String(row.cycle_id),
    startsAt:isoOrNull(row.starts_at),
    publishedAtMs:parseStoredInstant(row.created_at),
    availableMembers:Object.freeze([]),
    groups:Object.freeze(groupsByPublication.get(positiveId(row.id))||[]),
  }));
}

function primaryStatements(guard,depth){
  return [
    {sql:CIRCLE_HEALTH_SQL.guardedOwner,args:guard},
    {sql:CIRCLE_HEALTH_SQL.primaryWeeks,args:[...guard,depth]},
    {sql:CIRCLE_HEALTH_SQL.primaryParticipants,args:guard},
    {sql:CIRCLE_HEALTH_SQL.primaryGroups,args:guard},
    {sql:CIRCLE_HEALTH_SQL.primarySchedules,args:guard},
    {sql:CIRCLE_HEALTH_SQL.primaryReceipts,args:guard},
  ];
}

function secondaryStatements(guard,circleId,depth){
  return [
    {sql:CIRCLE_HEALTH_SQL.guardedOwner,args:guard},
    {sql:CIRCLE_HEALTH_SQL.secondaryPublications,args:[...guard,circleId,depth]},
    {sql:CIRCLE_HEALTH_SQL.secondaryGroups,args:[...guard,circleId,depth]},
    {sql:CIRCLE_HEALTH_SQL.secondarySchedules,args:[...guard,circleId,CIRCLE_HEALTH_WINDOW]},
  ];
}

/**
 * Read the selected circle's health for an active owner.
 *
 * `circleId` is the server-resolved active circle; pass null in single-circle
 * mode to use the actor's primary circle. Returns `{ok:false}` for anyone who
 * is not an active owner of an unarchived circle.
 */
export async function readCircleHealth(db,{actorUserId,circleId=null,now=Date.now(),timeZone}={}){
  const actor=positiveId(actorUserId);
  const requestedCircle=circleId===null?null:positiveId(circleId);
  if(!db||typeof db.execute!=='function'||typeof db.batch!=='function'||!actor
    ||(circleId!==null&&!requestedCircle)){
    throw new TypeError('valid circle health query required');
  }
  const ownerRows=rows(await db.execute(requestedCircle
    ?{sql:CIRCLE_HEALTH_SQL.ownerByCircle,args:[actor,requestedCircle]}
    :{sql:CIRCLE_HEALTH_SQL.ownerOfPrimary,args:[actor]}));
  if(ownerRows.length!==1) return Object.freeze({ok:false,reason:'owner_required'});
  const ownedCircle=positiveId(ownerRows[0].circle_id);
  if(!ownedCircle) return Object.freeze({ok:false,reason:'owner_required'});
  const primary=Number(ownerRows[0].is_primary)===1;
  const guard=[actor,ownedCircle,primary?1:0];
  const depth=CIRCLE_HEALTH_WINDOW+CIRCLE_HEALTH_LOOKBACK;
  const results=await db.batch(primary
    ?primaryStatements(guard,depth)
    :secondaryStatements(guard,ownedCircle,depth),'read');
  if(rows(results?.[0]).length!==1) return Object.freeze({ok:false,reason:'owner_required'});
  const cycles=primary?normalizePrimary(results):normalizeSecondary(results);
  return Object.freeze({
    ok:true,
    circleId:ownedCircle,
    health:buildCircleHealth(cycles,{
      scope:primary?'primary':'secondary',now,timeZone,completionTracked:primary,
    }),
  });
}

// ---------------------------------------------------------------------------
// Request shape
// ---------------------------------------------------------------------------

/** GET only, and no query parameters other than the grouped-route endpoint. */
export function circleHealthQueryValid(req){
  const query=req?.query&&typeof req.query==='object'&&!Array.isArray(req.query)?req.query:{};
  for(const [key,value] of Object.entries(query)){
    if(key!=='endpoint'||value!=='circle-health') return false;
  }
  let search;
  try{ search=new URL(req?.url||'/','https://randori.invalid').searchParams; }
  catch{ return false; }
  for(const key of new Set(search.keys())){
    const values=search.getAll(key);
    if(key!=='endpoint'||values.length!==1||values[0]!=='circle-health') return false;
  }
  return true;
}
