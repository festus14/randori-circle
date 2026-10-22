// Issue #296: "attempted" markers and suggested next exercises.
//
// Everything is computed on the server from two sources a member already owns:
//   1. verified runs: `session_runs` rows whose server attestation still
//      verifies (the same rule as the run feed's "verified" label), and
//   2. completed sessions: pair rooms where every signed-in participant
//      confirmed completion; the room's workspace exercise and any edited
//      shared code document count as attempted.
//
// Solo requests read only the requesting member's history. A pair request is
// authorized with `api/_pair-access.js` for the room's pair, and only while
// that pair belongs to the newest non-demo pairing week (the current pair).
// The partner's history is reduced on the server to the set of exercises they
// attempted: their attempt times never reach the selection rule, so nothing in
// the response (reasons included) depends on them, and it leaves the server as
// one boolean per exercise ("attempted by your partner"): never a score, code,
// date, run id or user id. Nothing here writes, and there is no request-path
// DDL.
//
// Everything is behind EXERCISE_SUGGESTIONS_ENABLED (default off).
import { authPairAccessArgs, authPairAccessSql } from './_pair-access.js';
import { parseCanonicalRoomPath } from './_pairing.js';

export const MAX_SUGGESTIONS=3;
export const MAX_HIDDEN_SLUGS=50;
// "Recent difficulty" is the hardest of this many most recently attempted exercises.
export const RECENT_ATTEMPT_WINDOW=3;
// Only the newest runs per exercise are checked; one verified run is enough.
export const RUNS_PER_EXERCISE=3;
export const MAX_COMPLETED_SESSIONS=200;
// Newest runs read from the current room for the shared recent difficulty.
export const MAX_ROOM_RUNS=100;
export const DIFFICULTY_LEVELS=Object.freeze(['Easy','Medium','Hard']);

const MAX_SLUG_LENGTH=120;
const MAX_SNAPSHOT_BYTES=32*1024;
const SLUG=/^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const QUESTION_REF=/^([a-z0-9]+(?:-[a-z0-9]+)*)(?:@[1-9]\d*)?$/;
const SQLITE_DATETIME=/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(?:\.\d+)?$/;
const ALLOWED_QUERY_KEYS=new Set(['endpoint','room_id','hidden']);

export class ExerciseSuggestionsInputError extends Error{
  constructor(message){
    super(message);
    this.name='ExerciseSuggestionsInputError';
  }
}

export function exerciseSuggestionsEnabled(env=process.env){
  return env.EXERCISE_SUGGESTIONS_ENABLED==='true';
}

function positiveSafeInteger(value){
  if(typeof value!=='number'&&typeof value!=='bigint'&&!(typeof value==='string'&&/^[1-9]\d*$/.test(value))) return null;
  const parsed=Number(value);
  return Number.isSafeInteger(parsed)&&parsed>0?parsed:null;
}

function nonNegativeSafeInteger(value){
  if(typeof value!=='number'&&typeof value!=='bigint'&&!(typeof value==='string'&&/^(0|[1-9]\d*)$/.test(value))) return null;
  const parsed=Number(value);
  return Number.isSafeInteger(parsed)&&parsed>=0?parsed:null;
}

function validSlug(value){
  return typeof value==='string'&&value.length<=MAX_SLUG_LENGTH&&SLUG.test(value);
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
      else if(Array.isArray(result[key])) continue;
      else if(String(result[key])!==values[0]) result[key]=[result[key],values[0]];
    }
  }catch{}
  return result;
}

/**
 * `GET /api/exercise-suggestions[?room_id=week_<w>_pair_<p>][&hidden=a,b]`.
 * `hidden` is the member's own client-side hide list (at most 50 slugs).
 */
export function parseExerciseSuggestionsQuery(req){
  const query=requestQuery(req);
  if(Object.keys(query).some(key=>!ALLOWED_QUERY_KEYS.has(key))){
    throw new ExerciseSuggestionsInputError('unsupported query parameter');
  }
  if(Object.values(query).some(Array.isArray)){
    throw new ExerciseSuggestionsInputError('query parameters must be provided once');
  }
  if(query.endpoint!==undefined&&query.endpoint!=='exercise-suggestions'){
    throw new ExerciseSuggestionsInputError('unsupported exercise suggestions endpoint');
  }
  let room=null;
  if(query.room_id!==undefined){
    const parsed=typeof query.room_id==='string'?parseCanonicalRoomPath(`/join/${query.room_id}`):null;
    if(!parsed||parsed.roomId!==query.room_id) throw new ExerciseSuggestionsInputError('canonical room_id required');
    room={roomId:parsed.roomId,weekId:parsed.weekId,pairGroupId:parsed.pairGroupId};
  }
  const hidden=[];
  if(query.hidden!==undefined&&query.hidden!==''){
    if(typeof query.hidden!=='string'||query.hidden.length>MAX_HIDDEN_SLUGS*(MAX_SLUG_LENGTH+1)){
      throw new ExerciseSuggestionsInputError('hidden must be a comma-separated list of exercise slugs');
    }
    for(const slug of query.hidden.split(',')){
      if(!validSlug(slug)) throw new ExerciseSuggestionsInputError('hidden must be a comma-separated list of exercise slugs');
      if(hidden.includes(slug)) throw new ExerciseSuggestionsInputError('hidden must not repeat an exercise');
      hidden.push(slug);
    }
    if(hidden.length>MAX_HIDDEN_SLUGS){
      throw new ExerciseSuggestionsInputError(`at most ${MAX_HIDDEN_SLUGS} hidden exercises are supported`);
    }
  }
  return {room,hidden};
}

// ---------------------------------------------------------------------------
// Readiness (read-only schema probe, cached per database)
// ---------------------------------------------------------------------------

const readinessByDatabaseUrl=new Map();
const readinessByClient=new WeakMap();

function readinessCache(db){
  const databaseUrl=String(process.env.TURSO_DATABASE_URL||'').trim();
  return databaseUrl?{cache:readinessByDatabaseUrl,key:databaseUrl}:{cache:readinessByClient,key:db};
}

async function probeExerciseSuggestionsSchema(db){
  await db.execute(`SELECT id,user_id,week_id,pair_group_id,question_slug,language,code,test_cases_snapshot,
    results_json,passed_count,total_count,created_at FROM session_runs LIMIT 0`);
  await db.execute(`SELECT id,week_id,user_a_id,user_b_id,user_c_id FROM pairing_groups LIMIT 0`);
  await db.execute(`SELECT id,is_demo FROM pairing_weeks LIMIT 0`);
  await db.execute(`SELECT week_id,user_id,source FROM pairing_participants LIMIT 0`);
  await db.execute(`SELECT week_id,pair_group_id,user_id,participant_source,confirmed_at
    FROM session_completion_receipts LIMIT 0`);
  await db.execute(`SELECT week_id,pair_group_id,question_id FROM pair_room_snapshots LIMIT 0`);
  await db.execute(`SELECT week_id,pair_group_id,question_slug,revision FROM pair_code_documents LIMIT 0`);
  if(process.env.CIRCLE_MEMBERSHIP_ENABLED==='true'){
    await db.execute(`SELECT circle_id,user_id,status FROM circle_memberships LIMIT 0`);
    await db.execute(`SELECT id,is_primary,archived_at FROM circles LIMIT 0`);
  }
}

export async function ensureExerciseSuggestionsReadiness(db){
  const {cache,key}=readinessCache(db);
  const existing=cache.get(key);
  if(existing) return existing;
  const pending=probeExerciseSuggestionsSchema(db);
  cache.set(key,pending);
  try{ return await pending; }
  catch(error){
    if(cache.get(key)===pending) cache.delete(key);
    throw error;
  }
}

// ---------------------------------------------------------------------------
// History: verified runs and completed sessions
// ---------------------------------------------------------------------------

/** Epoch milliseconds for a stored timestamp; unparseable values sort oldest. */
export function attemptInstant(value){
  if(typeof value!=='string') return 0;
  const text=value.trim();
  const iso=SQLITE_DATETIME.test(text)?`${text.replace(' ','T')}Z`:text;
  const epoch=Date.parse(iso);
  return Number.isFinite(epoch)?epoch:0;
}

/**
 * The exercise and time of one run, only if its server attestation verifies.
 * This is the run feed's "verified" rule minus one step: the stored code is
 * not read, so a v3 run's code is not re-hashed against `code_hash`. The HMAC
 * still binds that hash with the member, exercise, room and results, and an
 * attempt does not depend on the code. Anything unverifiable is ignored,
 * never an error, so one bad row cannot hide a member's other history.
 */
export function verifiedRunAttempt(row,verifyAttestation){
  if(!row||typeof row!=='object'||typeof verifyAttestation!=='function') return null;
  const questionSlug=row.question_slug;
  const userId=positiveSafeInteger(row.user_id);
  if(!validSlug(questionSlug)||!userId) return null;
  if(typeof row.test_cases_snapshot!=='string'||Buffer.byteLength(row.test_cases_snapshot,'utf8')>MAX_SNAPSHOT_BYTES){
    return null;
  }
  let snapshot;
  try{ snapshot=JSON.parse(row.test_cases_snapshot); }
  catch{ return null; }
  if(!snapshot||typeof snapshot!=='object'||snapshot.source!=='original-catalog') return null;
  const questionVersion=positiveSafeInteger(snapshot.version);
  const passedCount=nonNegativeSafeInteger(row.passed_count);
  const totalCount=nonNegativeSafeInteger(row.total_count);
  if(!questionVersion||passedCount===null||totalCount===null||passedCount>totalCount
    ||nonNegativeSafeInteger(snapshot.total_count)!==totalCount
    ||typeof row.language!=='string'||typeof row.results_json!=='string') return null;
  const attestationVersion=Number(snapshot.attestation_version);
  let binding={};
  if(attestationVersion===3){
    const weekId=positiveSafeInteger(row.week_id);
    const pairGroupId=positiveSafeInteger(row.pair_group_id);
    if(!weekId||!pairGroupId||weekId!==positiveSafeInteger(snapshot.week_id)
      ||pairGroupId!==positiveSafeInteger(snapshot.pair_group_id)
      ||!/^[a-f0-9]{64}$/.test(String(snapshot.code_hash||''))
      ||!positiveSafeInteger(snapshot.document_revision)
      ||!/^[a-f0-9]{64}$/.test(String(snapshot.document_state_hash||''))
      ||!/^[a-f0-9]{64}$/.test(String(snapshot.document_version||''))) return null;
    binding={
      weekId,pairGroupId,codeHash:snapshot.code_hash,documentRevision:snapshot.document_revision,
      documentStateHash:snapshot.document_state_hash,documentVersion:snapshot.document_version,
    };
  }else if(attestationVersion!==2){
    return null;
  }
  let verified=false;
  try{
    verified=verifyAttestation(snapshot.attestation,snapshot.attestation_key_id,{
      userId,questionSlug,questionVersion,language:row.language,passedCount,totalCount,
      resultsJson:row.results_json,...binding,
    },attestationVersion)===true;
  }catch{ verified=false; }
  return verified?{slug:questionSlug,at:attemptInstant(row.created_at)}:null;
}

/** The slug in a stored room workspace reference (`slug` or `slug@version`). */
export function questionRefSlug(value){
  if(typeof value!=='string'||value.length>MAX_SLUG_LENGTH+12) return null;
  const match=QUESTION_REF.exec(value);
  return match&&match[1].length<=MAX_SLUG_LENGTH?match[1]:null;
}

function recordAttempt(history,slug,at){
  const previous=history.get(slug);
  if(previous===undefined||at>previous) history.set(slug,at);
}

const COMPLETED_SESSION_EXERCISES_SQL=`WITH mine AS (
    SELECT receipt.week_id,receipt.pair_group_id
    FROM session_completion_receipts receipt
    WHERE receipt.user_id=? AND receipt.participant_source='auth'
    ORDER BY receipt.week_id DESC,receipt.pair_group_id DESC
    LIMIT ?
  ), completed AS (
    SELECT mine.week_id,mine.pair_group_id,
      (SELECT MAX(every_receipt.confirmed_at) FROM session_completion_receipts every_receipt
        WHERE every_receipt.week_id=mine.week_id AND every_receipt.pair_group_id=mine.pair_group_id) AS completed_at
    FROM mine
    JOIN pairing_groups pg ON pg.id=mine.pair_group_id AND pg.week_id=mine.week_id
    WHERE NOT EXISTS (
      SELECT 1 FROM pairing_participants participant
      WHERE participant.week_id=pg.week_id AND participant.source='auth'
        AND participant.user_id IN (pg.user_a_id,pg.user_b_id,pg.user_c_id)
        AND NOT EXISTS (
          SELECT 1 FROM session_completion_receipts confirmation
          WHERE confirmation.week_id=pg.week_id AND confirmation.pair_group_id=pg.id
            AND confirmation.user_id=participant.user_id
        )
    )
  )
  SELECT completed.completed_at,snapshot.question_id AS question_ref
    FROM completed
    CROSS JOIN pair_room_snapshots snapshot
    WHERE snapshot.week_id=completed.week_id AND snapshot.pair_group_id=completed.pair_group_id
  UNION ALL
  SELECT completed.completed_at,document.question_slug AS question_ref
    FROM completed
    CROSS JOIN pair_code_documents document
    WHERE document.week_id=completed.week_id AND document.pair_group_id=completed.pair_group_id
      AND document.revision>1`;
// CROSS JOIN keeps the few completed sessions as the outer loop so both
// tables are read by their (week_id,pair_group_id) key even without ANALYZE
// statistics, instead of scanning every snapshot or code document.

// The newest RUNS_PER_EXERCISE runs of each wanted exercise, found through the
// (user_id,question_slug) index, which covers the rowid ordering. Only the
// columns the attestation needs are read: never the code.
function runsStatement(member,list){
  return {
    sql:`WITH wanted(slug) AS (VALUES ${list.map(()=>'(?)').join(',')})
      SELECT sr.id,sr.user_id,sr.week_id,sr.pair_group_id,sr.question_slug,sr.language,
        sr.test_cases_snapshot,sr.results_json,sr.passed_count,sr.total_count,sr.created_at
      FROM wanted
      JOIN session_runs sr ON sr.id IN (
        SELECT recent.id FROM session_runs recent
        WHERE recent.user_id=? AND recent.question_slug=wanted.slug
        ORDER BY recent.id DESC LIMIT ?
      )`,
    args:[...list,member,RUNS_PER_EXERCISE],
  };
}

function memberCatalogue(userId,slugs){
  const member=positiveSafeInteger(userId);
  if(!member) throw new TypeError('userId must be a positive safe integer');
  return {member,list:[...new Set((Array.isArray(slugs)?slugs:[]).filter(validSlug))]};
}

/** The two read statements for one member (empty with no catalogue slugs). */
export function memberAttemptStatements(userId,slugs){
  const {member,list}=memberCatalogue(userId,slugs);
  if(!list.length) return [];
  return [runsStatement(member,list),{sql:COMPLETED_SESSION_EXERCISES_SQL,args:[member,MAX_COMPLETED_SESSIONS]}];
}

/** `Map<slug, latestEpochMs>` from the two result sets of memberAttemptStatements. */
export function memberAttemptsFromResults(userId,slugs,[runs,sessions]=[],verifyAttestation){
  const {member,list}=memberCatalogue(userId,slugs);
  const catalogue=new Set(list);
  const history=new Map();
  for(const row of runs?.rows||[]){
    if(positiveSafeInteger(row?.user_id)!==member) continue;
    const attempt=verifiedRunAttempt(row,verifyAttestation);
    if(attempt&&catalogue.has(attempt.slug)) recordAttempt(history,attempt.slug,attempt.at);
  }
  for(const row of sessions?.rows||[]){
    const slug=questionRefSlug(row?.question_ref);
    if(slug&&catalogue.has(slug)) recordAttempt(history,slug,attemptInstant(row.completed_at));
  }
  return history;
}

/**
 * One member's attempted exercises as `Map<slug, latestEpochMs>`, limited to
 * the given catalogue slugs. Reads only rows owned by `userId`.
 */
export async function readMemberAttempts(db,{userId,slugs,verifyAttestation}){
  const statements=memberAttemptStatements(userId,slugs);
  const results=statements.length?await db.batch(statements,'read'):[];
  return memberAttemptsFromResults(userId,slugs,results,verifyAttestation);
}

// ---------------------------------------------------------------------------
// Audience: solo, or the current pair authorized through _pair-access.js
// ---------------------------------------------------------------------------

function partnerMembershipJoins(){
  return process.env.CIRCLE_MEMBERSHIP_ENABLED==='true'?`
    JOIN circle_memberships partner_membership
      ON partner_membership.user_id=participant.user_id AND partner_membership.status='active'
    JOIN circles partner_circle
      ON partner_circle.id=partner_membership.circle_id
     AND partner_circle.is_primary=1 AND partner_circle.archived_at IS NULL`:'';
}

function audienceStatement(viewer,room){
  const accessArgs=authPairAccessArgs({userId:viewer,weekId:room.weekId,pairGroupId:room.pairGroupId});
  return {
    sql:`WITH access AS (${authPairAccessSql()}),
      current_access AS (
        SELECT access.* FROM access
        WHERE access.week_id=(SELECT MAX(week.id) FROM pairing_weeks week WHERE COALESCE(week.is_demo,0)=0)
      )
      SELECT participant.user_id AS partner_id
        FROM current_access
        JOIN pairing_participants participant
          ON participant.week_id=current_access.week_id AND participant.source='auth'
         AND participant.user_id IN (current_access.user_a_id,current_access.user_b_id,current_access.user_c_id)
         AND participant.user_id<>?${partnerMembershipJoins()}
      UNION ALL
      SELECT NULL AS partner_id FROM current_access`,
    args:[...accessArgs,viewer],
  };
}

function audienceFromResult(result,viewer,room){
  const rows=result?.rows||[];
  if(!rows.length) return null;
  const partnerIds=[...new Set(rows.map(row=>positiveSafeInteger(row?.partner_id)).filter(Boolean))]
    .filter(id=>id!==viewer)
    .sort((left,right)=>left-right)
    .slice(0,2);
  return {roomId:room.roomId,partnerIds};
}

/**
 * Solo when no room is given. For a room, the viewer must pass the shared pair
 * access check and the pair must be in the newest pairing week that is not a
 * demo week (an admin demo shuffle must not hide real pairs); otherwise
 * `null` (the caller answers 404). Partners are the other signed-in members of
 * that pair who are still active members of the same circle.
 */
export async function resolveSuggestionAudience(db,{viewerId,room=null}){
  const viewer=positiveSafeInteger(viewerId);
  if(!viewer) throw new TypeError('viewerId must be a positive safe integer');
  if(!room) return {roomId:null,partnerIds:[]};
  return audienceFromResult(await db.execute(audienceStatement(viewer,room)),viewer,room);
}

// Partners' runs in the current room. These are already shown to both
// partners, with runner and time, by the room's run feed, so they may shape
// the shared recent difficulty. Bounded to the newest MAX_ROOM_RUNS rows.
function roomRunsStatement(room,partnerIds){
  return {
    sql:`SELECT sr.id,sr.user_id,sr.week_id,sr.pair_group_id,sr.question_slug,sr.language,
        sr.test_cases_snapshot,sr.results_json,sr.passed_count,sr.total_count,sr.created_at
      FROM session_runs sr
      WHERE sr.week_id=? AND sr.pair_group_id=? AND sr.user_id IN (${partnerIds.map(()=>'?').join(',')})
      ORDER BY sr.id DESC LIMIT ?`,
    args:[room.weekId,room.pairGroupId,...partnerIds,MAX_ROOM_RUNS],
  };
}

/** `Map<slug, latestEpochMs>` of partners' verified runs in exactly this room. */
export function roomAttemptsFromResult(result,{room,partnerIds,slugs,verifyAttestation}){
  const partners=new Set(partnerIds);
  const catalogue=new Set((Array.isArray(slugs)?slugs:[]).filter(validSlug));
  const attempts=new Map();
  for(const row of result?.rows||[]){
    if(!partners.has(positiveSafeInteger(row?.user_id))
      ||positiveSafeInteger(row?.week_id)!==room.weekId
      ||positiveSafeInteger(row?.pair_group_id)!==room.pairGroupId) continue;
    const attempt=verifiedRunAttempt(row,verifyAttestation);
    if(attempt&&catalogue.has(attempt.slug)) recordAttempt(attempts,attempt.slug,attempt.at);
  }
  return attempts;
}

// ---------------------------------------------------------------------------
// Selection rule (pure)
// ---------------------------------------------------------------------------

export function difficultyLevel(difficulty){
  return DIFFICULTY_LEVELS.indexOf(difficulty);
}

/** Topics an exercise practises: its tags, or its pattern when it has none. */
export function exerciseTopics(exercise){
  const tags=Array.isArray(exercise?.tags)
    ?exercise.tags.filter(tag=>typeof tag==='string'&&tag.trim()).map(tag=>tag.trim().toLowerCase())
    :[];
  const unique=[...new Set(tags)];
  if(unique.length) return unique;
  const type=typeof exercise?.type==='string'?exercise.type.trim().toLowerCase():'';
  return type?[type]:[];
}

export function topicLabel(topic){
  return String(topic||'').replace(/[-_]+/g,' ').trim();
}

function capitalize(value){
  return value[0].toUpperCase()+value.slice(1);
}

function plural(count,noun){
  return `${count} ${noun}${count===1?'':'s'}`;
}

/** Public catalogue records reduced to what the rule needs (one per slug). */
export function normalizeSuggestionCatalogue(exercises){
  const seen=new Set();
  const catalogue=[];
  for(const exercise of Array.isArray(exercises)?exercises:[]){
    if(!validSlug(exercise?.slug)||seen.has(exercise.slug)) continue;
    seen.add(exercise.slug);
    catalogue.push({
      slug:exercise.slug,
      version:positiveSafeInteger(exercise.version),
      title:typeof exercise.title==='string'&&exercise.title.trim()?exercise.title.trim().slice(0,120):exercise.slug,
      difficulty:DIFFICULTY_LEVELS.includes(exercise.difficulty)?exercise.difficulty:null,
      topics:exerciseTopics(exercise),
    });
  }
  return catalogue;
}

function historyEntries(history){
  if(history instanceof Map) return [...history.entries()];
  if(history&&typeof history==='object') return Object.entries(history);
  return [];
}

// Only the slugs of a history (Map, plain object or list); times are dropped.
function slugSet(value){
  if(value instanceof Map) return new Set(value.keys());
  if(!value||typeof value!=='object') return new Set();
  return typeof value[Symbol.iterator]==='function'?new Set(value):new Set(Object.keys(value));
}

/**
 * The hardest difficulty level among the member's most recent attempted
 * exercises, or null with no rated history.
 */
export function recentDifficultyLevel(latestBySlug,levelBySlug){
  const recent=[...latestBySlug.entries()]
    .sort((left,right)=>right[1]-left[1]||left[0].localeCompare(right[0]))
    .slice(0,RECENT_ATTEMPT_WINDOW)
    .map(([slug])=>levelBySlug.get(slug))
    .filter(level=>Number.isInteger(level)&&level>=0);
  return recent.length?Math.max(...recent):null;
}

function topicReason(exercise,coverage,pair){
  let topic=null;
  let count=0;
  for(const candidate of exercise.topics){
    const seen=coverage.get(candidate)||0;
    if(topic===null||seen<count){ topic=candidate; count=seen; }
  }
  if(topic===null){
    return {
      code:'new_exercise',topic:null,
      text:pair?'Neither of you has tried this exercise yet':'You haven’t tried this exercise yet',
    };
  }
  const label=topicLabel(topic);
  if(count===0){
    return {
      code:'uncovered_topic',topic,
      text:pair?`Neither of you has practised ${label} yet`:`You haven’t practised ${label} yet`,
    };
  }
  return {
    code:'least_covered_topic',topic,
    text:pair
      ?`Together you have practised ${label} in only ${plural(count,'exercise')}`
      :`You have practised ${label} in only ${plural(count,'exercise')}`,
  };
}

function difficultyReason(level,recent){
  if(level<0) return {step:'unrated',text:'Its difficulty is not rated'};
  const name=DIFFICULTY_LEVELS[level];
  if(recent===null) return {step:'start',text:level===0?'An Easy exercise is a good place to start':`A ${name} exercise to start with`};
  const recentName=DIFFICULTY_LEVELS[recent];
  if(level===recent+1) return {step:'step_up',text:`One step up from your recent ${recentName} exercises`};
  if(level>recent) return {step:'stretch',text:`A stretch above your recent ${recentName} exercises`};
  if(level===recent) return {step:'same',text:`The same level as your recent ${recentName} exercises`};
  return {step:'easier',text:`Easier than your recent ${recentName} exercises`};
}

/**
 * Pick up to `limit` exercises neither the member nor a partner has attempted.
 *
 * `mine` is the member's own history (`Map` or object of slug -> epoch ms).
 * `partnerAttempted` is only the set of slugs partners attempted anywhere:
 * those times are deliberately not accepted, so they cannot change any pick
 * or reason. `roomAttempts` (slug -> epoch ms) holds partners' verified runs
 * in the current room only; both partners already see those runs, with runner
 * and time, in the room's run feed, so they join the recent difficulty and
 * partners working in the same room step up together.
 *
 * Rule (deterministic and explainable):
 *  - candidates: active exercises nobody has attempted and the member has not
 *    hidden;
 *  - coverage of a topic: how many attempted exercises (member or partner)
 *    carry it; a candidate's coverage is that of its least-covered topic;
 *  - target difficulty: one step above the hardest of the 3 most recent
 *    attempts among the member's own history and partners' runs in this room
 *    (Easy with no history, capped at Hard);
 *  - order: lowest coverage, then closest to the target difficulty, then the
 *    easier of two equally distant levels, then slug;
 *  - after each pick its topics count as covered once more, so the next pick
 *    prefers a different topic.
 */
export function selectExerciseSuggestions({
  exercises=[],mine=new Map(),partnerAttempted=[],roomAttempts=new Map(),hidden=[],limit=MAX_SUGGESTIONS,pair=false,
}={}){
  const catalogue=normalizeSuggestionCatalogue(exercises);
  const bySlug=new Map(catalogue.map(exercise=>[exercise.slug,exercise]));
  const ownLatest=new Map();
  for(const [slug,at] of historyEntries(mine)){
    if(!bySlug.has(slug)) continue;
    // Map and object keys are unique, so each slug is seen once.
    ownLatest.set(slug,Number.isFinite(Number(at))?Number(at):0);
  }
  const recentSource=new Map(ownLatest);
  for(const [slug,at] of historyEntries(roomAttempts)){
    if(!bySlug.has(slug)) continue;
    const instant=Number.isFinite(Number(at))?Number(at):0;
    if(!recentSource.has(slug)||instant>recentSource.get(slug)) recentSource.set(slug,instant);
  }
  const attempted=new Set(recentSource.keys());
  for(const slug of slugSet(partnerAttempted)) if(bySlug.has(slug)) attempted.add(slug);
  const coverage=new Map();
  for(const slug of attempted){
    for(const topic of bySlug.get(slug).topics) coverage.set(topic,(coverage.get(topic)||0)+1);
  }
  const levelBySlug=new Map(catalogue.map(exercise=>[exercise.slug,difficultyLevel(exercise.difficulty)]));
  const recent=recentDifficultyLevel(recentSource,levelBySlug);
  const target=recent===null?0:Math.min(DIFFICULTY_LEVELS.length-1,recent+1);
  const hiddenSet=new Set(Array.isArray(hidden)?hidden:[]);
  const unattempted=catalogue.filter(exercise=>!attempted.has(exercise.slug));
  let candidates=unattempted.filter(exercise=>!hiddenSet.has(exercise.slug));
  // Hidden exercises that could otherwise be suggested (for "Show n hidden").
  const hiddenCount=unattempted.length-candidates.length;
  const max=Number.isSafeInteger(limit)&&limit>0?Math.min(limit,MAX_SUGGESTIONS):MAX_SUGGESTIONS;
  const virtual=new Map(coverage);
  const coverageOf=exercise=>exercise.topics.length
    ?Math.min(...exercise.topics.map(topic=>virtual.get(topic)||0))
    :0;
  const rank=exercise=>{
    const level=levelBySlug.get(exercise.slug);
    const distance=level<0?DIFFICULTY_LEVELS.length:Math.abs(level-target);
    return {exercise,coverage:coverageOf(exercise),distance,above:level>target?1:0};
  };
  const compare=(left,right)=>left.coverage-right.coverage
    ||left.distance-right.distance
    ||left.above-right.above
    ||left.exercise.slug.localeCompare(right.exercise.slug);
  const picks=[];
  while(picks.length<max&&candidates.length){
    const best=candidates.map(rank).reduce((winner,current)=>compare(current,winner)<0?current:winner).exercise;
    picks.push(best);
    candidates=candidates.filter(exercise=>exercise!==best);
    for(const topic of best.topics) virtual.set(topic,(virtual.get(topic)||0)+1);
  }
  const suggestions=picks.map(exercise=>{
    const topic=topicReason(exercise,coverage,pair);
    const difficulty=difficultyReason(levelBySlug.get(exercise.slug),recent);
    return {
      slug:exercise.slug,
      version:exercise.version,
      title:exercise.title,
      difficulty:exercise.difficulty,
      topic:topic.topic,
      reason:{
        code:topic.code,
        difficulty_step:difficulty.step,
        text:`${capitalize(topic.text)}. ${difficulty.text}.`,
      },
    };
  });
  let emptyReason=null;
  if(!catalogue.length) emptyReason='no_exercises';
  else if(!suggestions.length) emptyReason=unattempted.length?'all_hidden':'all_attempted';
  return {suggestions,emptyReason,hiddenCount,recentLevel:recent,targetLevel:target};
}

/** One boolean pair per attempted catalogue exercise; nothing else. */
export function attemptedMarkers(exercises,mine,partner){
  const catalogue=normalizeSuggestionCatalogue(exercises);
  const own=slugSet(mine);
  const theirs=slugSet(partner);
  return catalogue
    .filter(exercise=>own.has(exercise.slug)||theirs.has(exercise.slug))
    .map(exercise=>({slug:exercise.slug,by_me:own.has(exercise.slug),by_partner:theirs.has(exercise.slug)}))
    .sort((left,right)=>left.slug.localeCompare(right.slug));
}

/**
 * The full response body (without `ok`) or null when the room is not the
 * viewer's current pair.
 */
export async function readExerciseSuggestions(db,{viewerId,room=null,hidden=[],exercises=[],verifyAttestation}){
  if(!db||typeof db.execute!=='function'||typeof db.batch!=='function'){
    throw new TypeError('database client is required');
  }
  const preflight=await resolveSuggestionAudience(db,{viewerId,room});
  if(!preflight) return null;
  const viewer=positiveSafeInteger(viewerId);
  const slugs=normalizeSuggestionCatalogue(exercises).map(exercise=>exercise.slug);
  const members=[viewer,...preflight.partnerIds];
  const perMember=members.map(userId=>memberAttemptStatements(userId,slugs));
  // One read transaction: the pair authorization is repeated first, so a
  // partner removed after the preflight cannot reach this response.
  const recheck=room?[audienceStatement(viewer,room)]:[];
  const roomRuns=room&&preflight.partnerIds.length&&slugs.length?[roomRunsStatement(room,preflight.partnerIds)]:[];
  const statements=[...recheck,...perMember.flat(),...roomRuns];
  const results=statements.length?await db.batch(statements,'read'):[];
  let partnerIds=preflight.partnerIds;
  let offset=0;
  if(room){
    const current=audienceFromResult(results[0],viewer,room);
    if(!current) return null;
    partnerIds=partnerIds.filter(id=>current.partnerIds.includes(id));
    offset=1;
  }
  const histories=new Map();
  perMember.forEach((memberStatements,index)=>{
    const slice=results.slice(offset,offset+memberStatements.length);
    offset+=memberStatements.length;
    histories.set(members[index],memberAttemptsFromResults(members[index],slugs,slice,verifyAttestation));
  });
  const mine=histories.get(viewer);
  // Partners contribute which exercises they attempted (never when), plus the
  // runs in this room that the run feed already shows to both partners.
  const partnerAttempted=new Set(partnerIds.flatMap(id=>[...histories.get(id).keys()]));
  const roomAttempts=roomRuns.length
    ?roomAttemptsFromResult(results[offset],{room,partnerIds,slugs,verifyAttestation})
    :new Map();
  const pair=partnerIds.length>0;
  const selection=selectExerciseSuggestions({
    exercises,mine,partnerAttempted,roomAttempts,hidden,limit:MAX_SUGGESTIONS,pair,
  });
  return {
    mode:pair?'pair':'solo',
    room_id:preflight.roomId,
    partner_count:partnerIds.length,
    attempted:attemptedMarkers(exercises,mine,partnerAttempted),
    suggestions:selection.suggestions,
    hidden_count:selection.hiddenCount,
    empty_reason:selection.emptyReason,
  };
}
