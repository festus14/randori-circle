// Interview lobby, schedule auto-start and candidate edit lock (#464, ID-99).
//
// Everything here is behind INTERVIEW_SESSION_ENABLED and the additive
// migration 26 capability (ID-87). With the flag on but migration 26 not yet
// applied, callers keep the ID-95 behaviour (no lobby, no lock).
//
// One SQL state projection is the single definition of the interview phase.
// Storage statements embed it so the database-time boundary, the lobby, the
// candidate role and the edit lock are re-evaluated by the write itself, not
// by an earlier read inside the same transaction (SQLite time advances).
import { schemaCapabilityAvailable } from './_schema-capability.js';

export const INTERVIEW_TIMER_DURATION_MS=25*60*1000;
export const INTERVIEW_LOBBY_MIGRATION_VERSION=26;

export function interviewSessionEnabled(){ return process.env.INTERVIEW_SESSION_ENABLED==='true'; }

const OFF=Object.freeze({interview:false,lobby:false});
const INTERVIEW_ONLY=Object.freeze({interview:true,lobby:false});
const LOBBY=Object.freeze({interview:true,lobby:true});

/** {interview,lobby}; never throws for an unavailable capability. */
export async function resolveInterviewMode(db){
  if(!interviewSessionEnabled()) return OFF;
  let lobby=false;
  try{ lobby=await schemaCapabilityAvailable(db,{version:INTERVIEW_LOBBY_MIGRATION_VERSION}); }catch{ lobby=false; }
  return lobby?LOBBY:INTERVIEW_ONLY;
}

export function interviewModeFrom({interview=false,lobby=false}={}){
  return interview?(lobby?LOBBY:INTERVIEW_ONLY):OFF;
}

const NOW="strftime('%Y-%m-%dT%H:%M:%fZ','now')";
const DURATION_SECONDS=`'+${(INTERVIEW_TIMER_DURATION_MS/1000).toFixed(3)} seconds'`;
const SCHEDULED=`(s.agreed_time IS NOT NULL AND length(s.agreed_time)=24
  AND strftime('%Y-%m-%dT%H:%M:%fZ',s.agreed_time)=s.agreed_time)`;
const STARTED=`(c.week_id IS NOT NULL AND (c.timer_state='running' OR c.remaining_ms<${INTERVIEW_TIMER_DURATION_MS}))`;
const ADMITTED='(i.admitted_at IS NOT NULL)';
const SCHEDULE_RUN=`(NOT ${ADMITTED} AND NOT ${STARTED} AND ${SCHEDULED} AND ${NOW}>=s.agreed_time)`;
const TIMER_ENDED=`COALESCE((c.remaining_ms=0 OR (c.timer_state='running' AND ${NOW}>=strftime('%Y-%m-%dT%H:%M:%fZ',
  c.anchor_at,printf('+%.3f seconds',c.remaining_ms/1000.0)))),0)`;
const ENDED=`(${TIMER_ENDED} OR (${SCHEDULE_RUN}
  AND ${NOW}>=strftime('%Y-%m-%dT%H:%M:%fZ',s.agreed_time,${DURATION_SECONDS})))`;

// Args: [weekId,pairGroupId]. Only an exact two-human auth pair has a row;
// every other room shape keeps its pre-interview behaviour (fences default
// open). A stale interview row (pair snapshot no longer
// matching the live group) is ignored, exactly as the JS projection does.
export function interviewStateSql(){
  return `SELECT CASE WHEN ${ENDED} THEN 1 ELSE 0 END AS ended,
      CASE WHEN ${ADMITTED} OR ${STARTED} OR ${SCHEDULE_RUN} THEN 1 ELSE 0 END AS live,
      CASE WHEN ${SCHEDULE_RUN} THEN 1 ELSE 0 END AS schedule_run,
      COALESCE(i.editing_locked,0) AS locked,
      COALESCE(c.candidate_user_id,pg.user_a_id) AS candidate_user_id,
      pg.user_a_id,pg.user_b_id,s.agreed_time AS scheduled_start_at,
      CASE WHEN c.week_id IS NULL THEN 0 ELSE 1 END AS controls_present
    FROM pairing_groups pg
    JOIN pairing_participants pa ON pa.week_id=pg.week_id AND pa.user_id=pg.user_a_id AND pa.source='auth'
    JOIN pairing_participants pb ON pb.week_id=pg.week_id AND pb.user_id=pg.user_b_id AND pb.source='auth'
    LEFT JOIN pair_session_controls c ON c.week_id=pg.week_id AND c.pair_group_id=pg.id
    LEFT JOIN pair_interview_sessions i ON i.week_id=pg.week_id AND i.pair_group_id=pg.id
      AND i.pair_user_a_id=pg.user_a_id AND i.pair_user_b_id=pg.user_b_id
    LEFT JOIN pair_schedules s ON s.week_id=pg.week_id AND s.pair_group_id=pg.id
    WHERE pg.week_id=? AND pg.id=? AND pg.is_ai_pair=0 AND pg.user_c_id IS NULL AND pg.user_a_id<>pg.user_b_id`;
}

// ID-95 boundary without migration 26: only the controls row decides.
function legacyOpenSql(){
  return `NOT EXISTS (SELECT 1 FROM pair_session_controls control
    WHERE control.week_id=? AND control.pair_group_id=?
      AND (control.remaining_ms=0 OR (control.timer_state='running'
        AND ${NOW}>=strftime('%Y-%m-%dT%H:%M:%fZ',
          control.anchor_at,printf('+%.3f seconds',control.remaining_ms/1000.0)))))`;
}

/** Storage-statement predicate: true while the interview has not ended. */
export function interviewOpenFence(mode,{weekId,pairGroupId}){
  if(!mode?.interview) return Object.freeze({sql:'1',args:[]});
  if(!mode.lobby) return Object.freeze({sql:legacyOpenSql(),args:[weekId,pairGroupId]});
  return Object.freeze({sql:`COALESCE((SELECT ended FROM (${interviewStateSql()})),0)=0`,args:[weekId,pairGroupId]});
}

/**
 * Storage-statement predicate for a code write (CRDT bootstrap, merge or
 * projection) by `actorId`. The interviewer is unrestricted (the open fence
 * still applies); the candidate may write only while the room is live,
 * unlocked, and only to the room's selected question and language.
 */
export function candidateCodeFence(mode,{weekId,pairGroupId,actorId,questionId,language}){
  if(!mode?.lobby) return Object.freeze({sql:'1',args:[]});
  return Object.freeze({
    sql:`COALESCE((SELECT CASE WHEN st.candidate_user_id<>? THEN 1
        WHEN st.live=1 AND st.locked=0 AND EXISTS (SELECT 1 FROM pair_room_snapshots selected
          WHERE selected.week_id=? AND selected.pair_group_id=? AND selected.question_id=? AND selected.language=?)
        THEN 1 ELSE 0 END FROM (${interviewStateSql()}) st),1)=1`,
    args:[actorId,weekId,pairGroupId,questionId,language,weekId,pairGroupId],
  });
}

/**
 * Storage-statement predicate for a workspace checkpoint by `actorId`. The
 * candidate never creates the room checkpoint (the interviewer owns the
 * initial selection), never changes the selection, writes nothing in the
 * lobby, and while locked may not change code that the server did not take
 * from the canonical CRDT document (`lockedCode` is null when it did).
 */
export function candidateWorkspaceFence(mode,{weekId,pairGroupId,actorId,insert,language,questionId,lockedCode=null}){
  if(!mode?.lobby) return Object.freeze({sql:'1',args:[]});
  const code=lockedCode===null?'':` AND (st.locked=0 OR (CASE WHEN pair_room_snapshots.schema_version>=3
      THEN json_extract(pair_room_snapshots.code,'$.code') ELSE pair_room_snapshots.code END)=?)`;
  const allowed=insert?'0':`st.live=1 AND pair_room_snapshots.language=? AND pair_room_snapshots.question_id=?${code}`;
  return Object.freeze({
    sql:`COALESCE((SELECT CASE WHEN st.candidate_user_id<>? THEN 1 WHEN ${allowed} THEN 1 ELSE 0 END
      FROM (${interviewStateSql()}) st),1)=1`,
    args:[actorId,...(insert?[]:[language,questionId,...(lockedCode===null?[]:[lockedCode])]),weekId,pairGroupId],
  });
}

/** The same state as plain values (lobby mode only), at statement time. */
export async function readInterviewGate(db,mode,{weekId,pairGroupId}){
  if(!mode?.lobby) return null;
  const result=await db.execute({sql:interviewStateSql(),args:[weekId,pairGroupId]});
  if(!Array.isArray(result?.rows)) throw new Error('interview state is unavailable');
  const row=result.rows[0];
  if(!row) return null;
  return Object.freeze({
    ended:Number(row.ended)===1,live:Number(row.live)===1,scheduleRun:Number(row.schedule_run)===1,
    locked:Number(row.locked)===1,candidateUserId:Number(row.candidate_user_id),
    userAId:Number(row.user_a_id),userBId:Number(row.user_b_id),
    scheduledStartAt:row.scheduled_start_at===null||row.scheduled_start_at===undefined?null:String(row.scheduled_start_at),
    controlsPresent:Number(row.controls_present)===1,
  });
}

export class InterviewStateChangedError extends Error{
  constructor(message){ super(message); this.name='InterviewStateChangedError'; }
}

/**
 * Freeze a schedule-derived start (no admission recorded, timer untouched,
 * agreed instant reached) into durable rows: the controls timer runs from the
 * agreed instant and the room records admission by schedule. Call inside a
 * serialized write transaction after authorization. Idempotent; returns
 * whether it wrote. Nothing else may change the agreed time first, so a
 * later schedule edit can neither rewind nor reopen a started interview.
 */
export async function materializeScheduledStart(db,mode,{weekId,pairGroupId,actorId}){
  const gate=await readInterviewGate(db,mode,{weekId,pairGroupId});
  if(!gate?.scheduleRun) return false;
  const start=gate.scheduledStartAt;
  const stillScheduled=`EXISTS (SELECT 1 FROM (${interviewStateSql()}) st WHERE st.schedule_run=1 AND st.scheduled_start_at=?)`;
  await db.execute({
    sql:`DELETE FROM pair_interview_sessions WHERE week_id=? AND pair_group_id=?
      AND NOT (pair_user_a_id=? AND pair_user_b_id=?)`,
    args:[weekId,pairGroupId,gate.userAId,gate.userBId],
  });
  const timer=gate.controlsPresent
    ?await db.execute({
      sql:`UPDATE pair_session_controls SET timer_state='running',remaining_ms=?,anchor_at=?,
          revision=revision+1,updated_by=?,updated_by_source='auth',updated_at=${NOW}
        WHERE week_id=? AND pair_group_id=? AND timer_state='paused' AND remaining_ms=? AND anchor_at IS NULL
          AND ${stillScheduled}`,
      args:[INTERVIEW_TIMER_DURATION_MS,start,actorId,weekId,pairGroupId,INTERVIEW_TIMER_DURATION_MS,weekId,pairGroupId,start],
    })
    :await db.execute({
      sql:`INSERT INTO pair_session_controls
          (week_id,pair_group_id,pair_user_a_id,pair_user_a_source,pair_user_b_id,pair_user_b_source,pair_user_c_id,
            candidate_user_id,candidate_source,timer_state,remaining_ms,anchor_at,revision,updated_by,updated_by_source,
            created_at,updated_at)
        SELECT ?,?,?,'auth',?,'auth',NULL,?,'auth','running',?,?,1,?,'auth',${NOW},${NOW}
        WHERE ${stillScheduled}
        ON CONFLICT(week_id,pair_group_id) DO NOTHING`,
      args:[weekId,pairGroupId,gate.userAId,gate.userBId,gate.userAId,INTERVIEW_TIMER_DURATION_MS,start,actorId,
        weekId,pairGroupId,start],
    });
  if(Number(timer?.rowsAffected)!==1) throw new InterviewStateChangedError('scheduled start changed');
  const admitted=await db.execute({
    sql:`INSERT INTO pair_interview_sessions
        (week_id,pair_group_id,pair_user_a_id,pair_user_b_id,admission,admitted_at,editing_locked,revision,
          updated_by,created_at,updated_at)
      VALUES (?,?,?,?,'schedule',?,0,1,?,${NOW},${NOW})
      ON CONFLICT(week_id,pair_group_id) DO UPDATE SET admission='schedule',admitted_at=excluded.admitted_at,
        revision=pair_interview_sessions.revision+1,updated_by=excluded.updated_by,updated_at=excluded.updated_at
      WHERE pair_interview_sessions.admitted_at IS NULL`,
    args:[weekId,pairGroupId,gate.userAId,gate.userBId,start,actorId],
  });
  if(Number(admitted?.rowsAffected)!==1) throw new InterviewStateChangedError('scheduled admission changed');
  return true;
}
