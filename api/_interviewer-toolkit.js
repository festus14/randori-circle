// Private human evaluation. Never import this data into shared projections or AI.
import { LIVE_ACCOUNT_SQL } from './_account-deletion.js';
import { schemaFeatureAvailable } from './_schema-capability.js';
import { readAuthorizedSessionControls } from './_session-controls.js';
import { parseCanonicalRoomPath } from './_pairing.js';
import { projectRecapRun, projectRecapWorkspace } from './_pair-recap.js';
import { normalizeMessageTimestamp } from './_messages.js';

export const TOOLKIT_MIGRATION_VERSION=27;
export const EVALUATION_RETENTION_SECONDS=90*24*60*60;
export const RUBRIC_DIMENSIONS=Object.freeze(['problem_solving','communication','code_quality','testing']);
export const EVALUATION_DECISIONS=Object.freeze(['undecided','strong_hire','hire','no_hire','strong_no_hire']);
const NOW="CAST(strftime('%s','now') AS INTEGER)";
const COLUMNS='week_id,pair_group_id,evaluator_user_id,candidate_user_id,problem_solving,communication,code_quality,testing,notes,decision,revision,created_at,updated_at,expires_at';
export function interviewerToolkitEnabled(env=process.env){
  return env.INTERVIEWER_TOOLKIT_ENABLED==='true'&&env.INTERVIEW_SESSION_ENABLED==='true';
}
export function interviewerToolkitAvailable(db){
  return schemaFeatureAvailable(db,{enabled:interviewerToolkitEnabled(),version:TOOLKIT_MIGRATION_VERSION});
}
export class EvaluationInputError extends Error{}
export class EvaluationConflictError extends Error{}
function exact(value,keys){
  return value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).sort().join(',')===[...keys].sort().join(',');
}
export function evaluationRoom(value){
  const room=typeof value==='string'?parseCanonicalRoomPath(`/join/${value}`):null;
  if(!room||room.roomId!==value) throw new EvaluationInputError('canonical room_id required');
  return room;
}
export function parseEvaluationMutation(body){
  if(!exact(body,['room_id','revision','rubric','notes','decision'])) throw new EvaluationInputError('unexpected or missing evaluation fields');
  const room=evaluationRoom(body.room_id);
  if(!Number.isSafeInteger(body.revision)||body.revision<0) throw new EvaluationInputError('valid revision required');
  if(!exact(body.rubric,RUBRIC_DIMENSIONS)||RUBRIC_DIMENSIONS.some(key=>body.rubric[key]!==null&&(!Number.isInteger(body.rubric[key])||body.rubric[key]<1||body.rubric[key]>4))) throw new EvaluationInputError('rubric scores must be null or integers from 1 to 4');
  if(typeof body.notes!=='string'||[...body.notes].length>4000||Buffer.byteLength(body.notes)>16000||body.notes.includes('\0')) throw new EvaluationInputError('notes must be at most 4000 characters and 16000 bytes');
  if(!EVALUATION_DECISIONS.includes(body.decision)) throw new EvaluationInputError('invalid decision');
  return {...room,revision:body.revision,rubric:{...body.rubric},notes:body.notes,decision:body.decision};
}
export function projectEvaluation(row){
  if(!row) return {revision:0,rubric:Object.fromEntries(RUBRIC_DIMENSIONS.map(key=>[key,null])),notes:'',decision:'undecided',created_at:null,updated_at:null,expires_at:null};
  return {revision:Number(row.revision),rubric:Object.fromEntries(RUBRIC_DIMENSIONS.map(key=>[key,row[key]===null?null:Number(row[key])])),
    notes:String(row.notes),decision:String(row.decision),created_at:new Date(Number(row.created_at)*1000).toISOString(),
    updated_at:new Date(Number(row.updated_at)*1000).toISOString(),expires_at:new Date(Number(row.expires_at)*1000).toISOString()};
}
// Lifecycle operations ignore the feature flag: rollback must not stop deletion.
// Only absence is tolerated; malformed schema or operational errors fail closed.
export async function evaluationSchemaInstalled(db){
  try{ await db.execute(`SELECT ${COLUMNS} FROM interview_evaluations LIMIT 0`); return true; }
  catch(error){ if(/no such table: (?:main\.)?interview_evaluations\b/i.test(String(error.message))) return false; throw error; }
}
export async function readOwnedEvaluations(db,userId,{limit=260}={}){
  const rows=await db.execute({sql:`SELECT ${COLUMNS} FROM interview_evaluations WHERE evaluator_user_id=? AND expires_at>=${NOW} ORDER BY created_at DESC,pair_group_id DESC LIMIT ?`,args:[userId,limit+1]});
  return {evaluations:rows.rows.slice(0,limit).map(row=>({room_id:`week_${row.week_id}_pair_${row.pair_group_id}`,...projectEvaluation(row)})),truncated:rows.rows.length>limit};
}
// Entry metadata only: an eligible past interviewer can start an evaluation
// from History even if they never opened the room toolkit during the session.
export async function toolkitHistoryRooms(db,userId,room=null){
  const result=await db.execute({sql:`SELECT pg.week_id,pg.id AS pair_group_id FROM pairing_groups pg
    JOIN pairing_participants pa ON pa.week_id=pg.week_id AND pa.user_id=pg.user_a_id AND pa.source='auth'
    JOIN pairing_participants pb ON pb.week_id=pg.week_id AND pb.user_id=pg.user_b_id AND pb.source='auth'
    LEFT JOIN pair_session_controls c ON c.week_id=pg.week_id AND c.pair_group_id=pg.id
    LEFT JOIN interview_evaluations e ON e.week_id=pg.week_id AND e.pair_group_id=pg.id AND e.evaluator_user_id=?
    WHERE ${room?'pg.week_id=? AND pg.id=? AND ':''}? IN (pg.user_a_id,pg.user_b_id) AND pg.is_ai_pair=0 AND pg.user_c_id IS NULL AND pg.user_a_id<>pg.user_b_id
      AND (c.week_id IS NULL OR (c.pair_user_a_id=pg.user_a_id AND c.pair_user_b_id=pg.user_b_id))
      AND ((e.evaluator_user_id IS NOT NULL AND e.expires_at>=${NOW} AND e.candidate_user_id IN (pg.user_a_id,pg.user_b_id))
        OR (e.evaluator_user_id IS NULL AND COALESCE(c.candidate_user_id,pg.user_a_id)<>?
          AND julianday(pg.created_at)>=julianday('now','-90 days')))
    ORDER BY pg.week_id DESC,pg.id DESC LIMIT 500`,args:[userId,...(room?[room.weekId,room.pairGroupId]:[]),userId,userId]});
  return new Set(result.rows.map(row=>`week_${row.week_id}_pair_${row.pair_group_id}`));
}

export function evaluationInsights(evaluations,truncated=false){
  return {window_days:90,evaluated:evaluations.length,truncated,
    decisions:Object.fromEntries(EVALUATION_DECISIONS.map(value=>[value,evaluations.filter(row=>row.decision===value).length])),
    rubric:Object.fromEntries(RUBRIC_DIMENSIONS.map(key=>{const scores=evaluations.map(row=>row.rubric[key]).filter(value=>value!==null);return [key,{scored:scores.length,average:scores.length?scores.reduce((a,b)=>a+b,0)/scores.length:null}];}))};
}

async function authorize(db,{viewerId,room,versionKey}){
  const current=await readAuthorizedSessionControls(db,{viewerId,weekId:room.weekId,pairGroupId:room.pairGroupId,versionKey});
  if(!current?.state.interview_mode||!current.mode.lobby) return null;
  const result=await db.execute({sql:`SELECT ${COLUMNS} FROM interview_evaluations WHERE week_id=? AND pair_group_id=? AND evaluator_user_id=? LIMIT 1`,args:[room.weekId,room.pairGroupId,viewerId]});
  const row=result.rows[0]||null;
  const clock=await db.execute(`SELECT ${NOW} AS seconds`),now=Number(clock.rows[0].seconds);
  if(row&&(Number(row.expires_at)<now||![current.pair.userAId,current.pair.userBId].includes(Number(row.candidate_user_id)))) return null;
  if(!row&&current.state.viewer_role!=='interviewer') return null;
  const group=await db.execute({sql:`SELECT created_at FROM pairing_groups WHERE id=? AND week_id=? AND EXISTS(SELECT 1 FROM auth_accounts WHERE id=? AND ${LIVE_ACCOUNT_SQL})`,args:[room.pairGroupId,room.weekId,viewerId]});
  if(!group.rows.length)return null;
  // A purge cannot make an old room eligible for a new evaluation.
  const groupAt=normalizeMessageTimestamp(group.rows[0]?.created_at);
  if(!row&&(!groupAt||Date.parse(groupAt)<(now-EVALUATION_RETENTION_SECONDS)*1000)) return null;
  return {current,row,now,groupAt};
}
// Creation is fenced by the CURRENT interviewer at the storage statement.
// After handoff, existing writing stays editable by its original account only.
export async function saveEvaluation(db,{viewerId,mutation,versionKey}){
  if(!await interviewerToolkitAvailable(db)) return null;
  const tx=await db.transaction('write');
  try{
    const authorized=await authorize(tx,{viewerId,room:mutation,versionKey});
    if(!authorized){ await tx.rollback(); return null; }
    const {current,row}=authorized;
    if(mutation.revision!==Number(row?.revision||0)) throw new EvaluationConflictError('evaluation changed; reload before saving');
    const scoreArgs=RUBRIC_DIMENSIONS.map(key=>mutation.rubric[key]);
    const pairFence=`EXISTS (SELECT 1 FROM (${current.accessSql}) access WHERE access.user_a_id IN (?,?) AND access.user_b_id IN (?,?) AND access.user_a_source='auth' AND access.user_b_source='auth' AND access.is_ai_pair=0 AND access.user_c_id IS NULL) AND EXISTS(SELECT 1 FROM auth_accounts WHERE id=? AND ${LIVE_ACCOUNT_SQL})`;
    const pairArgs=[...current.accessArgs,current.pair.userAId,current.pair.userBId,current.pair.userAId,current.pair.userBId,viewerId];
    let written;
    if(row){
      written=await tx.execute({sql:`UPDATE interview_evaluations SET problem_solving=?,communication=?,code_quality=?,testing=?,notes=?,decision=?,revision=revision+1,updated_at=${NOW}
        WHERE week_id=? AND pair_group_id=? AND evaluator_user_id=? AND revision=? AND expires_at>=${NOW} AND ${pairFence} RETURNING revision`,
      args:[...scoreArgs,mutation.notes,mutation.decision,mutation.weekId,mutation.pairGroupId,viewerId,mutation.revision,...pairArgs]});
    }else{
      written=await tx.execute({sql:`INSERT INTO interview_evaluations (${COLUMNS})
        SELECT ?,?,?,?,?,?,?,?,?,?,1,${NOW},${NOW},${NOW}+${EVALUATION_RETENTION_SECONDS}
        WHERE ${pairFence} AND COALESCE((SELECT candidate_user_id FROM pair_session_controls WHERE week_id=? AND pair_group_id=?),?)<>?
        ON CONFLICT(week_id,pair_group_id,evaluator_user_id) DO NOTHING RETURNING revision`,
      args:[mutation.weekId,mutation.pairGroupId,viewerId,current.state.candidate_user_id,...scoreArgs,mutation.notes,mutation.decision,...pairArgs,mutation.weekId,mutation.pairGroupId,current.pair.userAId,viewerId]});
    }
    if(written.rows.length!==1) throw new EvaluationConflictError('evaluation changed; reload before saving');
    const updated=await tx.execute({sql:`SELECT ${COLUMNS} FROM interview_evaluations WHERE week_id=? AND pair_group_id=? AND evaluator_user_id=?`,args:[mutation.weekId,mutation.pairGroupId,viewerId]});
    await tx.commit(); return projectEvaluation(updated.rows[0]);
  }catch(error){ try{await tx.rollback();}catch{} throw error; }
  finally{ await tx.close?.(); }
}

export async function readEvaluationReport(db,{viewerId,room,versionKey,verifyAttestation}){
  if(!await interviewerToolkitAvailable(db)) return null;
  const tx=await db.transaction('read');
  try{
    const authorized=await authorize(tx,{viewerId,room,versionKey});
    if(!authorized){await tx.rollback();return null;}
    const {current,row,groupAt}=authorized,events=[];
    events.push({kind:'phase',phase:'lobby',at:groupAt,source:'pair_created'});
    const liveAt=current.lobby.interviewRow?.admittedAt||current.state.scheduled_start_at||current.row?.anchor_at;
    if(liveAt&&Date.parse(liveAt)<=Date.parse(current.databaseNow)) events.push({kind:'phase',phase:'live',at:liveAt,source:current.state.admission||'timer'});
    if(current.state.terminal){
      const end=current.state.end_reason==='timer_expired'&&current.row?.anchor_at?new Date(Date.parse(current.row.anchor_at)+Number(current.row.remaining_ms)).toISOString()
        :current.state.end_reason==='timer_expired'&&current.state.scheduled_start_at?new Date(Date.parse(current.state.scheduled_start_at)+25*60*1000).toISOString()
        :current.completion.completed_at||current.row?.updated_at||current.databaseNow;
      events.push({kind:'phase',phase:'ended',at:end,source:current.state.end_reason});
    }
    const contentReadable=current.state.viewer_role==='interviewer'||current.state.phase!=='lobby';
    const snapshot=contentReadable?await tx.execute({sql:`SELECT revision,schema_version,language,question_id,code,updated_at FROM pair_room_snapshots WHERE room_id=? AND week_id=? AND pair_group_id=? AND julianday(updated_at)>=julianday('now','-90 days') LIMIT 1`,args:[room.roomId,room.weekId,room.pairGroupId]}):{rows:[]};
    if(snapshot.rows[0]){
      const saved=snapshot.rows[0],metadata=projectRecapWorkspace(saved);
      const code=Number(saved.schema_version)>=3?JSON.parse(saved.code).code:saved.code;
      if(typeof code==='string'&&Buffer.byteLength(code)<=20*1024) events.push({kind:'checkpoint',at:metadata.updated_at,...metadata,code});
    }
    const result=contentReadable?await tx.execute({sql:`SELECT sr.id,sr.user_id,sr.week_id,sr.pair_group_id,sr.question_slug,sr.language,sr.code,sr.test_cases_snapshot,sr.results_json,sr.passed_count,sr.total_count,sr.duration_ms,sr.created_at,account.display_name AS runner_display_name
      FROM session_runs sr JOIN auth_accounts account ON account.id=sr.user_id
      WHERE sr.week_id=? AND sr.pair_group_id=? AND sr.user_id IN (?,?) AND julianday(sr.created_at)>=julianday('now','-90 days')
      ORDER BY julianday(sr.created_at) DESC,sr.id DESC LIMIT 501`,args:[room.weekId,room.pairGroupId,current.pair.userAId,current.pair.userBId]}):{rows:[]};
    for(const run of result.rows.slice(0,500)){
      const summary=projectRecapRun(run,verifyAttestation);
      if(!summary) continue;
      // v2 code is private solo/legacy input, even when the run has a pair id.
      // Only signed v3 acknowledged SHARED code may enter this private report.
      const shared=JSON.parse(run.test_cases_snapshot).attestation_version===3;
      events.push({kind:'run',at:summary.created_at,question_slug:summary.question_slug,question_version:summary.question_version,language:summary.language,
        passed_count:summary.passed_count,total_count:summary.total_count,duration_ms:summary.duration_ms,...(shared?{code:run.code}:{})});
    }
    const evaluation=projectEvaluation(row);
    if(row) events.push({kind:'evaluation',at:evaluation.updated_at,...evaluation});
    const candidate=await tx.execute({sql:'SELECT display_name FROM auth_accounts WHERE id=?',args:[row?row.candidate_user_id:current.state.candidate_user_id]});
    await tx.commit();
    return {format:'randori-interviewer-report',version:1,room_id:room.roomId,generated_at:current.databaseNow,
      candidate:candidate.rows[0]?.display_name||'Deleted member',phase:current.state.phase,evaluation,
      timeline:events.sort((a,b)=>String(a.at).localeCompare(String(b.at))),run_scan_truncated:result.rows.length>500,
      limitations:'Sparse recorded evidence, not a keystroke recording. Only the latest workspace checkpoint and verified runs are retained. Private stdin, chat, AI and partner evaluations are excluded.'};
  }catch(error){try{await tx.rollback();}catch{}throw error;}
  finally{await tx.close?.();}
}
// Explicit, bounded operator operation, disabled by default. Not request DDL.
export async function purgeExpiredEvaluations(db,{enabled=false,limit=100}={}){
  if(!Number.isInteger(limit)||limit<1||limit>100) throw new TypeError('purge limit must be 1 to 100');
  if(enabled!==true||process.env.INTERVIEW_EVALUATION_PURGE_ENABLED!=='true') return {deleted:0,disabled:true};
  if(!await evaluationSchemaInstalled(db)) return {deleted:0,not_installed:true};
  const result=await db.execute({sql:`DELETE FROM interview_evaluations WHERE (week_id,pair_group_id,evaluator_user_id) IN
    (SELECT week_id,pair_group_id,evaluator_user_id FROM interview_evaluations WHERE expires_at<${NOW} ORDER BY expires_at,pair_group_id LIMIT ?)`,args:[limit]});
  return {deleted:Number(result.rowsAffected)};
}
