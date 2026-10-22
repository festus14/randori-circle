// Issue #292: owner-only, aggregate "circle health" for the last eight
// finished cycles.
//
// Everything here is read-only and computed from tables that already exist:
// the primary circle's immutable weekly publication (pairing_weeks,
// pairing_participants, pairing_groups), its schedules (pair_schedules) and
// completion receipts (session_completion_receipts, ID-55), and a secondary
// circle's v13 publication and v16 schedule tables. No table, index, cache
// row or migration is added; see docs/CIRCLE_HEALTH.md.
//
// Privacy model (docs/CIRCLE_HEALTH.md "Privacy"):
// - A cycle is returned only once it has ended and the receipt grace (plus a
//   clock margin) has passed, and completion counts only receipts confirmed
//   within the grace, so a shown completed count never changes. Agreements
//   have no history; a partner who later clears or accepts an agreement in a
//   past week's room can still change a shown agreed count (rare).
// - Available, paired, solo and the number of pairs describe the published
//   pairing, which every member of the circle already saw, and are shown.
// - Agreed a time, completed and repeat pairs are counted in pairs, because
//   people act in pairs. They are hidden whenever a cycle has fewer than
//   CIRCLE_HEALTH_MIN_PAIRS pairs, and otherwise whenever exactly one pair is
//   in or out of the count. Agreed and completed are hidden together. With
//   these rules no hidden value is determined by the rest of a single
//   response; tests/unit/circle-health-privacy.test.mjs checks every pair
//   state for 1-6 pairs. A shown 0 or "every pair" still tells the owner that
//   every pair did, or did not, do it.
//
// This module deliberately imports nothing that unit tests commonly replace
// (no _db.js, _active-circle.js or _circle-membership.js), so the capability
// check in auth.js and the route in ops.js can load it safely.
import { resolvePairingCycle } from './_pairing-cycle.js';

// With 3 pairs every shown agreed or completed count would be 0 or 3, so it
// would always disclose every pair; from 4 pairs a middle value is possible.
export const CIRCLE_HEALTH_MIN_PAIRS=4;
// Late completion confirmations: only receipts confirmed within this grace
// after the cycle ends count, and a cycle is shown only after the grace plus
// a margin for clock skew between the app and the database has passed.
export const CIRCLE_HEALTH_RECEIPT_GRACE_MS=48*60*60*1000;
export const CIRCLE_HEALTH_CLOCK_MARGIN_MS=60*60*1000;
export const CIRCLE_HEALTH_WINDOW=8;
export const CIRCLE_HEALTH_LOOKBACK=8;
export const CIRCLE_HEALTH_VERSION=1;
export const CIRCLE_HEALTH_CACHE_CONTROL='private, no-store';

// Cancellations and no-shows need the cancel/no-show records from issue #291,
// and "time from pairing to agreement" needs a stored agreement timestamp
// (pair_schedules.updated_at changes on later proposals). Until then those
// cells are always `not_tracked`; see docs/CIRCLE_HEALTH.md for the seam.
export const ATTENDANCE_OUTCOMES_TRACKED=false;

const ISO_WEEK_GLOB="'[0-9][0-9][0-9][0-9]-W[0-9][0-9]'";

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

const SUPPRESSED=Object.freeze({status:'suppressed',value:null});
const NO_DATA=Object.freeze({status:'no_data',value:null});
const NOT_TRACKED=Object.freeze({status:'not_tracked',value:null});

function okCell(value){
  return Object.freeze({status:'ok',value});
}

/** A count of pairs that points at a single pair: exactly one in, or one out. */
export function edgePairCount(count,pairs){
  return count===1||pairs-count===1;
}

/**
 * Apply every suppression rule to one finished cycle's raw aggregates. `raw`
 * holds counts only; nothing in it identifies a member.
 */
export function suppressCycleMetrics(raw,{minimumPairs=CIRCLE_HEALTH_MIN_PAIRS,completionTracked=true}={}){
  const {pairs}=raw;
  let scheduled=NO_DATA;
  let completed=NO_DATA;
  let repeat=NO_DATA;
  if(pairs>0&&pairs<minimumPairs){
    // Pair floor: with one or two pairs every count describes a known pair,
    // so these are hidden whatever their value ("hidden" carries nothing).
    scheduled=SUPPRESSED;
    completed=SUPPRESSED;
    repeat=SUPPRESSED;
  }else if(pairs>=minimumPairs){
    // Hidden together, so an owner who assumes completed pairs also agreed a
    // time cannot narrow one hidden count from the other shown one.
    const funnelHidden=edgePairCount(raw.scheduledPairs,pairs)
      ||(completionTracked&&edgePairCount(raw.completedPairs,pairs));
    scheduled=funnelHidden?SUPPRESSED:okCell(raw.scheduledPairs);
    completed=funnelHidden?SUPPRESSED:okCell(raw.completedPairs);
    repeat=edgePairCount(raw.repeatPairs,pairs)?SUPPRESSED:okCell(Math.round(100*raw.repeatPairs/pairs));
  }
  return Object.freeze({
    available:okCell(raw.available),
    paired:okCell(raw.paired),
    solo:okCell(raw.solo),
    pairs:okCell(pairs),
    scheduled_pairs:scheduled,
    completed_pairs:completionTracked?completed:NOT_TRACKED,
    repeat_pair_percent:repeat,
    median_hours_to_agreed_time:NOT_TRACKED,
    cancelled:NOT_TRACKED,
    no_show:NOT_TRACKED,
  });
}

// ---------------------------------------------------------------------------
// Aggregation (pure)
// ---------------------------------------------------------------------------

/** Unordered member pairs inside one group (one key for a pair, three for a triad). */
export function pairKeys(group){
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
 * Raw aggregates for one cycle. Member counts for the published pairing, pair
 * counts for what pairs did. `lookback` is the set of pair keys seen in the
 * previous CIRCLE_HEALTH_LOOKBACK cycles.
 */
export function aggregateCycle(cycle,lookback,{completionTracked=true}={}){
  const human=cycle.groups.filter(group=>!group.solo);
  const members=new Set(cycle.availableMembers);
  for(const group of cycle.groups) for(const member of group.members) members.add(member);
  return Object.freeze({
    available:members.size,
    paired:sum(human.map(group=>group.members.length)),
    solo:sum(cycle.groups.filter(group=>group.solo).map(group=>group.members.length)),
    pairs:human.length,
    scheduledPairs:human.filter(group=>group.scheduled).length,
    completedPairs:completionTracked?human.filter(group=>group.completed).length:null,
    repeatPairs:human.filter(group=>pairKeys(group).some(key=>lookback.has(key))).length,
  });
}

/**
 * Turn up to WINDOW+LOOKBACK finished cycles (newest first) into the public
 * per-cycle response. Pair keys are computed once per cycle and reused by
 * every later cycle's lookback (the per-request, per-cycle cache).
 */
export function buildCircleHealth(cycles,{
  scope,now=Date.now(),completionTracked=true,
  windowCycles=CIRCLE_HEALTH_WINDOW,lookbackCycles=CIRCLE_HEALTH_LOOKBACK,minimumPairs=CIRCLE_HEALTH_MIN_PAIRS,
}={}){
  const keysByCycle=cycles.map(cycle=>new Set(cycle.groups.filter(group=>!group.solo).flatMap(pairKeys)));
  const visible=cycles.slice(0,windowCycles).map((cycle,index)=>{
    const seen=new Set();
    for(const keys of keysByCycle.slice(index+1,index+1+lookbackCycles)) for(const key of keys) seen.add(key);
    return Object.freeze({
      cycle_id:cycle.cycleId,
      starts_at:cycle.startsAt,
      metrics:suppressCycleMetrics(aggregateCycle(cycle,seen,{completionTracked}),{minimumPairs,completionTracked}),
    });
  });
  return Object.freeze({
    version:CIRCLE_HEALTH_VERSION,
    scope,
    window_cycles:windowCycles,
    lookback_cycles:lookbackCycles,
    min_pairs:minimumPairs,
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

// Most recent settled primary weeks by their unique ISO week label: a
// descending range scan of idx_pairing_weeks_week_label below the bound
// computed in readCircleHealth. Demo and non-ISO legacy labels are skipped.
const PRIMARY_WEEKS=(limit)=>`SELECT week.id FROM pairing_weeks week
    WHERE week.week_label GLOB ${ISO_WEEK_GLOB} AND COALESCE(week.is_demo,0)=0 AND week.week_label<?
    ORDER BY week.week_label DESC LIMIT ${limit}`;
const SECONDARY_PUBLICATIONS=`SELECT id FROM circle_pairing_publications
      WHERE circle_id=? AND cycle_id<? ORDER BY starts_at DESC,id DESC LIMIT ?`;

export const CIRCLE_HEALTH_SQL=Object.freeze({
  ownerByCircle:`SELECT ${OWNER_COLUMNS} AND membership.circle_id=? LIMIT 2`,
  ownerOfPrimary:`SELECT ${OWNER_COLUMNS} AND circle.is_primary=1 LIMIT 2`,
  guardedOwner:`WITH ${OWNER_GUARD} SELECT 1 AS owner FROM owner`,
  primaryWeeks:`WITH ${OWNER_GUARD}
    SELECT week.id,week.week_label,week.week_start
    FROM pairing_weeks week
    WHERE week.week_label GLOB ${ISO_WEEK_GLOB} AND COALESCE(week.is_demo,0)=0 AND week.week_label<?
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
    SELECT receipt.week_id,receipt.pair_group_id,receipt.user_id,receipt.participant_source,receipt.confirmed_at
    FROM session_completion_receipts receipt
    WHERE receipt.week_id IN (SELECT id FROM recent) AND EXISTS (SELECT 1 FROM owner)`,
  secondaryPublications:`WITH ${OWNER_GUARD}
    SELECT publication.id,publication.cycle_id,publication.starts_at
    FROM circle_pairing_publications publication
    WHERE publication.circle_id=? AND publication.cycle_id<? AND EXISTS (SELECT 1 FROM owner)
    ORDER BY publication.starts_at DESC,publication.id DESC LIMIT ?`,
  secondaryGroups:`WITH ${OWNER_GUARD}, recent AS (${SECONDARY_PUBLICATIONS})
    SELECT group_row.id,group_row.publication_id,group_row.user_a_id,group_row.user_b_id,group_row.is_solo
    FROM circle_pairing_groups group_row
    WHERE group_row.publication_id IN (SELECT id FROM recent) AND EXISTS (SELECT 1 FROM owner)`,
  secondarySchedules:`WITH ${OWNER_GUARD}, recent AS (${SECONDARY_PUBLICATIONS})
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

/** End of the weekly cycle that starts at `weekStart`, or null if unknown. */
function cycleEndMs(weekStart,timeZone){
  const start=parseStoredInstant(weekStart);
  return start===null?null:Date.parse(resolvePairingCycle({now:new Date(start),timeZone,state:'current'}).endsAt);
}

function normalizePrimary([,weekResult,participantResult,groupResult,scheduleResult,receiptResult],{timeZone}={}){
  // Receipts confirmed after the grace never count, so a cycle's completed
  // count is fixed by the time it is shown. A week without a valid start has
  // no known end, so none of its receipts count.
  const receiptCutoff=new Map(rows(weekResult).map(row=>{
    const end=cycleEndMs(row.week_start,timeZone);
    return [positiveId(row.id),end===null?null:end+CIRCLE_HEALTH_RECEIPT_GRACE_MS];
  }));
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
    const cutoff=receiptCutoff.get(positiveId(row.week_id));
    const confirmedAt=parseStoredInstant(row.confirmed_at);
    if(cutoff==null||confirmedAt===null||confirmedAt>=cutoff) continue;
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
      completed:required.length>0&&confirmed.length===required.length&&groupReceipts.length===confirmed.length,
    }));
  }
  return rows(weekResult).map(row=>{
    const weekId=positiveId(row.id);
    const members=[...(participants.get(weekId)||new Map()).keys()].map(String);
    return Object.freeze({
      cycleId:String(row.week_label),
      startsAt:isoOrNull(row.week_start),
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
      completed:null,
    }));
  }
  return rows(publicationResult).map(row=>Object.freeze({
    cycleId:String(row.cycle_id),
    startsAt:isoOrNull(row.starts_at),
    availableMembers:Object.freeze([]),
    groups:Object.freeze(groupsByPublication.get(positiveId(row.id))||[]),
  }));
}

function primaryStatements(guard,bound,depth){
  return [
    {sql:CIRCLE_HEALTH_SQL.guardedOwner,args:guard},
    {sql:CIRCLE_HEALTH_SQL.primaryWeeks,args:[...guard,bound,depth]},
    {sql:CIRCLE_HEALTH_SQL.primaryParticipants,args:[...guard,bound]},
    {sql:CIRCLE_HEALTH_SQL.primaryGroups,args:[...guard,bound]},
    {sql:CIRCLE_HEALTH_SQL.primarySchedules,args:[...guard,bound]},
    {sql:CIRCLE_HEALTH_SQL.primaryReceipts,args:[...guard,bound]},
  ];
}

function secondaryStatements(guard,circleId,bound,depth){
  return [
    {sql:CIRCLE_HEALTH_SQL.guardedOwner,args:guard},
    {sql:CIRCLE_HEALTH_SQL.secondaryPublications,args:[...guard,circleId,bound,depth]},
    {sql:CIRCLE_HEALTH_SQL.secondaryGroups,args:[...guard,circleId,bound,depth]},
    {sql:CIRCLE_HEALTH_SQL.secondarySchedules,args:[...guard,circleId,bound,CIRCLE_HEALTH_WINDOW]},
  ];
}

/**
 * Read the selected circle's health for an active owner.
 *
 * `circleId` is the server-resolved active circle; pass null in single-circle
 * mode to use the actor's primary circle. Returns `{ok:false}` for anyone who
 * is not an active owner of an unarchived circle. Only cycles that ended at
 * least the receipt grace plus the clock margin ago (in PAIRING_TIME_ZONE) are
 * read; an invalid time zone throws.
 */
export async function readCircleHealth(db,{actorUserId,circleId=null,now=Date.now(),timeZone}={}){
  const actor=positiveId(actorUserId);
  const requestedCircle=circleId===null?null:positiveId(circleId);
  if(!db||typeof db.execute!=='function'||typeof db.batch!=='function'||!actor
    ||(circleId!==null&&!requestedCircle)){
    throw new TypeError('valid circle health query required');
  }
  // A cycle has ended by `settled` exactly when it comes before the cycle that
  // contains `settled`, so that cycle's id is an exclusive upper bound.
  const settled=new Date(now-CIRCLE_HEALTH_RECEIPT_GRACE_MS-CIRCLE_HEALTH_CLOCK_MARGIN_MS);
  const bound=resolvePairingCycle({now:settled,timeZone,state:'current'}).cycleId;
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
    ?primaryStatements(guard,bound,depth)
    :secondaryStatements(guard,ownedCircle,bound,depth),'read');
  if(rows(results?.[0]).length!==1) return Object.freeze({ok:false,reason:'owner_required'});
  const cycles=primary?normalizePrimary(results,{timeZone}):normalizeSecondary(results);
  return Object.freeze({
    ok:true,
    circleId:ownedCircle,
    health:buildCircleHealth(cycles,{scope:primary?'primary':'secondary',now,completionTracked:primary}),
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
