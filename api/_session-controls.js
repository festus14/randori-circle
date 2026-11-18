import { createHmac } from 'node:crypto';

import {
  INTERVIEW_TIMER_DURATION_MS,
  InterviewStateChangedError,
  interviewModeFrom,
  interviewOpenFence,
  interviewSessionEnabled as interviewFlagEnabled,
  interviewStateSql,
  materializeScheduledStart,
  readInterviewGate,
  resolveInterviewMode,
} from './_interview-session.js';
import { authPairAccessArgs } from './_pair-access.js';
import { parseCanonicalRoomPath } from './_pairing.js';
import {
  canonicalCompletionPair,
  projectSessionCompletion,
  sourceTaggedPairAccessSql,
} from './_session-completion.js';

export const SESSION_TIMER_DURATION_MS=INTERVIEW_TIMER_DURATION_MS;
const OPAQUE_VERSION=/^[a-f0-9]{64}$/;
const TRANSACTION_ATTEMPTS=4;
const ACTIONS=new Set(['start','pause','reset','set_candidate','end','admit','lock_editing','unlock_editing']);
// Interview-only commands; admit and the edit lock also need migration 26.
const INTERVIEW_ACTIONS=new Set(['end','admit','lock_editing','unlock_editing']);
const LOBBY_ACTIONS=new Set(['admit','lock_editing','unlock_editing']);

export function interviewSessionEnabled(){ return interviewFlagEnabled(); }
export { resolveInterviewMode };

export class SessionControlsInputError extends Error{
  constructor(message){ super(message); this.name='SessionControlsInputError'; }
}

export class SessionControlsDataError extends Error{
  constructor(message,{cause}={}){
    super(message,cause===undefined?undefined:{cause});
    this.name='SessionControlsDataError';
  }
}

export class SessionControlsConflictError extends Error{
  constructor(code,message,state){
    super(message); this.name='SessionControlsConflictError'; this.code=code; this.state=state;
  }
}

function positiveSafeInteger(value){
  const number=Number(value);
  return Number.isSafeInteger(number)&&number>0?number:null;
}

function exactKeys(value,expected){
  if(!value||typeof value!=='object'||Array.isArray(value)) return false;
  const actual=Object.keys(value).sort();
  const wanted=[...expected].sort();
  return actual.length===wanted.length&&actual.every((key,index)=>key===wanted[index]);
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

function canonicalRoom(value){
  if(typeof value!=='string') return null;
  const parsed=parseCanonicalRoomPath(`/join/${value}`);
  return parsed?.roomId===value
    ?{roomId:parsed.roomId,weekId:parsed.weekId,pairGroupId:parsed.pairGroupId}
    :null;
}

export function parseSessionControlsQuery(req){
  const query=requestQuery(req);
  if(Object.keys(query).some(key=>!['endpoint','room_id'].includes(key))
    ||Object.values(query).some(Array.isArray)
    ||(query.endpoint!==undefined&&query.endpoint!=='session-controls')){
    throw new SessionControlsInputError('unsupported query parameter');
  }
  const room=canonicalRoom(query.room_id);
  if(!room) throw new SessionControlsInputError('canonical room_id required');
  return room;
}

export function validateSessionControlsPostQuery(req){
  const query=requestQuery(req);
  if(Object.keys(query).some(key=>key!=='endpoint')||Object.values(query).some(Array.isArray)
    ||(query.endpoint!==undefined&&query.endpoint!=='session-controls')){
    throw new SessionControlsInputError('unsupported query parameter');
  }
  return true;
}

export function parseSessionControlsMutation(body,{interview=interviewSessionEnabled()}={}){
  if(!body||typeof body!=='object'||Array.isArray(body)){
    throw new SessionControlsInputError('request body must be an object');
  }
  if(!ACTIONS.has(body.action)||INTERVIEW_ACTIONS.has(body.action)&&!interview) throw new SessionControlsInputError('unsupported session-controls action');
  const expected=body.action==='set_candidate'
    ?['room_id','action','base_version','candidate_user_id']
    :['room_id','action','base_version'];
  if(!exactKeys(body,expected)) throw new SessionControlsInputError('unexpected or missing session-controls fields');
  const room=canonicalRoom(body.room_id);
  if(!room) throw new SessionControlsInputError('canonical room_id required');
  if(typeof body.base_version!=='string'||!OPAQUE_VERSION.test(body.base_version)){
    throw new SessionControlsInputError('valid base_version required');
  }
  let candidateUserId=null;
  if(body.action==='set_candidate'){
    candidateUserId=Number.isSafeInteger(body.candidate_user_id)&&body.candidate_user_id>0
      ?body.candidate_user_id:null;
    if(!candidateUserId) throw new SessionControlsInputError('valid candidate_user_id required');
  }
  return Object.freeze({...room,action:body.action,baseVersion:body.base_version,candidateUserId});
}

function normalizedTimestamp(value,field){
  if(typeof value!=='string') throw new SessionControlsDataError(`stored ${field} is invalid`);
  const epoch=Date.parse(value);
  if(!Number.isFinite(epoch)||new Date(epoch).toISOString()!==value){
    throw new SessionControlsDataError(`stored ${field} is invalid`);
  }
  return value;
}

function exactHumanPair(row,viewerId){
  const userAId=positiveSafeInteger(row?.user_a_id);
  const userBId=positiveSafeInteger(row?.user_b_id);
  if(!userAId||!userBId||userAId===userBId||row?.is_ai_pair===null
    ||row?.is_ai_pair===undefined||Number(row.is_ai_pair)!==0
    ||row?.user_c_id!==null&&row?.user_c_id!==undefined
    ||row?.user_a_source!=='auth'||row?.user_b_source!=='auth'
    ||row?.user_c_source!==null&&row?.user_c_source!==undefined) return null;
  const pair=canonicalCompletionPair(row,viewerId);
  if(pair.isAi||pair.requiredUserIds.length!==2) return null;
  return Object.freeze({...pair,userAId,userBId});
}

function normalizeControlRow(row,pair){
  if(!row) return null;
  const weekId=positiveSafeInteger(row.week_id);
  const pairGroupId=positiveSafeInteger(row.pair_group_id);
  const userAId=positiveSafeInteger(row.pair_user_a_id);
  const userBId=positiveSafeInteger(row.pair_user_b_id);
  const candidateUserId=positiveSafeInteger(row.candidate_user_id);
  const revision=Number(row.revision);
  const remainingMs=Number(row.remaining_ms);
  const timerState=String(row.timer_state||'');
  if(weekId!==pair.weekId||pairGroupId!==pair.pairGroupId||userAId!==pair.userAId||userBId!==pair.userBId
    ||row.pair_user_a_source!=='auth'||row.pair_user_b_source!=='auth'
    ||row.pair_user_c_id!==null&&row.pair_user_c_id!==undefined
    ||row.candidate_source!=='auth'||![userAId,userBId].includes(candidateUserId)
    ||!['paused','running'].includes(timerState)||!Number.isSafeInteger(remainingMs)
    ||remainingMs<0||remainingMs>SESSION_TIMER_DURATION_MS
    ||!Number.isSafeInteger(revision)||revision<1
    ||row.updated_by_source!=='auth'||![userAId,userBId].includes(Number(row.updated_by))){
    throw new SessionControlsDataError('stored session controls are invalid');
  }
  const anchorAt=row.anchor_at===null||row.anchor_at===undefined?null:normalizedTimestamp(row.anchor_at,'session-controls anchor');
  if((timerState==='paused'&&anchorAt!==null)||(timerState==='running'&&(!anchorAt||remainingMs<1))){
    throw new SessionControlsDataError('stored session timer is invalid');
  }
  const createdAt=normalizedTimestamp(row.created_at,'session-controls created timestamp');
  const updatedAt=normalizedTimestamp(row.updated_at,'session-controls updated timestamp');
  if(Date.parse(updatedAt)<Date.parse(createdAt)||anchorAt&&Date.parse(updatedAt)<Date.parse(anchorAt)){
    throw new SessionControlsDataError('stored session-controls timestamps are invalid');
  }
  return Object.freeze({
    weekId,pairGroupId,userAId,userBId,candidateUserId,timerState,remainingMs,
    anchorAt,revision,createdAt,updatedAt,
  });
}

// A row whose pair snapshot no longer matches the live group is stale: it is
// ignored here and deleted by the next interview write (no trigger on an
// existing table invalidates it, see migration 26).
function normalizeInterviewRow(row,pair){
  if(!row) return null;
  if(positiveSafeInteger(row.week_id)!==pair.weekId||positiveSafeInteger(row.pair_group_id)!==pair.pairGroupId){
    throw new SessionControlsDataError('stored interview state is invalid');
  }
  if(positiveSafeInteger(row.pair_user_a_id)!==pair.userAId||positiveSafeInteger(row.pair_user_b_id)!==pair.userBId) return null;
  const revision=Number(row.revision);
  const admission=row.admission===null||row.admission===undefined?null:String(row.admission);
  const locked=Number(row.editing_locked);
  if(!Number.isSafeInteger(revision)||revision<1||![null,'interviewer','schedule'].includes(admission)
    ||![0,1].includes(locked)||![pair.userAId,pair.userBId].includes(Number(row.updated_by))
    ||(admission===null)!==(row.admitted_at===null||row.admitted_at===undefined)){
    throw new SessionControlsDataError('stored interview state is invalid');
  }
  return Object.freeze({
    admission,admittedAt:admission===null?null:normalizedTimestamp(row.admitted_at,'interview admission'),
    editingLocked:locked===1,revision,
    createdAt:normalizedTimestamp(row.created_at,'interview created timestamp'),
    updatedAt:normalizedTimestamp(row.updated_at,'interview updated timestamp'),
  });
}

function canonicalScheduledStart(value){
  if(typeof value!=='string'||value.length!==24) return null;
  const epoch=Date.parse(value);
  return Number.isFinite(epoch)&&new Date(epoch).toISOString()===value?value:null;
}

// The JS twin of interviewStateSql(): admitted, a started timer, or a reached
// agreed start make the room live. A reached agreed start with no admission
// and an untouched timer is a derived timer running from that instant.
function lobbyPhase(durable,lobby,now){
  const interviewRow=lobby.interviewRow||null;
  const start=lobby.scheduledStartAt||null;
  const started=durable.revision>0&&(durable.timerState==='running'||durable.remainingMs<SESSION_TIMER_DURATION_MS);
  const admitted=!!interviewRow?.admittedAt;
  const scheduleRun=!admitted&&!started&&!!start&&now>=start;
  return Object.freeze({
    started,admitted,scheduleRun,live:admitted||started||scheduleRun,
    locked:interviewRow?.editingLocked===true,
    admission:interviewRow?.admission||(scheduleRun?'schedule':null),
    effective:scheduleRun?Object.freeze({...durable,timerState:'running',remainingMs:SESSION_TIMER_DURATION_MS,anchorAt:start}):durable,
  });
}

function durableState(pair,row){
  return row||Object.freeze({
    weekId:pair.weekId,pairGroupId:pair.pairGroupId,userAId:pair.userAId,userBId:pair.userBId,
    candidateUserId:pair.userAId,timerState:'paused',remainingMs:SESSION_TIMER_DURATION_MS,
    anchorAt:null,revision:0,createdAt:null,updatedAt:null,
  });
}

function controlsVersion(pair,durable,versionKey,interview,lobby=null){
  if(typeof versionKey!=='string'||versionKey.length<32){
    throw new SessionControlsDataError('session-controls version key is unavailable');
  }
  // Lobby versions bind the durable interview row and the agreed start (an
  // input), never the time-derived phase or remaining time.
  const domain=lobby?'randori-interview-lobby-controls-v1':interview?'randori-interview-controls-v1':'randori-session-controls-v1';
  const fields=[
    pair.weekId,pair.pairGroupId,pair.userAId,pair.userBId,null,
    durable.candidateUserId,durable.timerState,durable.remainingMs,durable.anchorAt,durable.revision,
  ];
  if(lobby){
    const row=lobby.interviewRow||null;
    fields.push(row?.admission??null,row?.admittedAt??null,row?.editingLocked===true,row?.revision??0,lobby.scheduledStartAt??null);
  }
  return createHmac('sha256',versionKey).update(`${domain}\0${JSON.stringify(fields)}`,'utf8').digest('hex');
}

function boundedElapsed(anchorAt,clockAt){
  return Math.max(0,Date.parse(clockAt)-Date.parse(anchorAt));
}

export function projectSessionControls(pair,row,{databaseNow,completion,versionKey,interview=false,lobby=null}){
  if(!pair||!completion) throw new SessionControlsDataError('session-controls projection is invalid');
  if(lobby&&!interview) throw new SessionControlsDataError('session-controls projection is invalid');
  const now=normalizedTimestamp(databaseNow,'session-controls database clock');
  const stored=durableState(pair,normalizeControlRow(row,pair));
  const phase=lobby?lobbyPhase(stored,lobby,now):null;
  const durable=phase?phase.effective:stored;
  if(durable.updatedAt&&Date.parse(now)<Date.parse(durable.updatedAt)){
    throw new SessionControlsDataError('database session-controls clock is invalid');
  }
  let clockAt=now;
  if(completion.state==='completed'){
    const completedAt=normalizedTimestamp(completion.completed_at,'session completion timestamp');
    if(Date.parse(completedAt)>Date.parse(now)
      ||durable.updatedAt&&Date.parse(completedAt)<Date.parse(durable.updatedAt)){
      throw new SessionControlsDataError('database session-controls completion clock is invalid');
    }
    clockAt=completedAt;
  }
  const remainingMs=durable.timerState==='running'
    ?Math.max(0,durable.remainingMs-boundedElapsed(durable.anchorAt,clockAt))
    :durable.remainingMs;
  const timerState=remainingMs===0?'expired':durable.timerState;
  const viewerRole=durable.candidateUserId===pair.viewerId?'candidate':'interviewer';
  const partnerUserId=pair.viewerId===pair.userAId?pair.userBId:pair.userAId;
  const terminal=completion.state==='completed'||interview&&remainingMs===0;
  return Object.freeze({
    timer_state:timerState,
    remaining_ms:remainingMs,
    duration_ms:SESSION_TIMER_DURATION_MS,
    candidate_user_id:durable.candidateUserId,
    partner_user_id:partnerUserId,
    viewer_role:viewerRole,
    partner_role:viewerRole==='candidate'?'interviewer':'candidate',
    terminal,
    ...(interview?{
      interview_mode:true,
      can_control:viewerRole==='interviewer'&&completion.state!=='completed'&&remainingMs>0,
      end_reason:remainingMs===0?(durable.timerState==='running'?'timer_expired':'interviewer_ended'):
        completion.state==='completed'?'completed':null,
    }:{}),
    ...(phase?{
      lobby_mode:true,
      phase:terminal?'ended':phase.live?'live':'lobby',
      admission:phase.admission,
      scheduled_start_at:lobby.scheduledStartAt||null,
      editing_locked:phase.locked,
      can_edit:!terminal&&(viewerRole==='interviewer'||phase.live&&!phase.locked),
    }:{}),
    completion_version:completion.version,
    observed_at:now,
    updated_at:durable.updatedAt,
    version:controlsVersion(pair,stored,versionKey,interview,lobby),
  });
}

export async function readSessionControlsDatabaseNow(db){
  let result;
  try{ result=await db.execute("SELECT strftime('%Y-%m-%dT%H:%M:%fZ','now') AS now_utc"); }
  catch(error){ throw new SessionControlsDataError('database session-controls clock is unavailable',{cause:error}); }
  const raw=result?.rows?.length===1?String(result.rows[0]?.now_utc||''):'';
  return normalizedTimestamp(raw,'database session-controls clock');
}

export async function readAuthorizedSessionControls(db,{viewerId,weekId,pairGroupId,versionKey,interview=interviewSessionEnabled(),mode=null}){
  if(!db||typeof db.execute!=='function') throw new TypeError('database client is required');
  const resolved=mode||(interview?await resolveInterviewMode(db):interviewModeFrom());
  const lobbyMode=interview&&resolved.lobby===true;
  const accessSql=sourceTaggedPairAccessSql();
  const accessArgs=authPairAccessArgs({userId:viewerId,weekId,pairGroupId});
  const pairResult=await db.execute({sql:accessSql,args:accessArgs});
  if(!pairResult?.rows?.length) return null;
  const pair=exactHumanPair(pairResult.rows[0],viewerId);
  if(!pair) return null;
  const receiptsResult=await db.execute({
    sql:`WITH access AS (${accessSql})
      SELECT receipt.user_id,receipt.confirmed_at
      FROM session_completion_receipts receipt
      JOIN pairing_participants participant
        ON participant.week_id=receipt.week_id AND participant.user_id=receipt.user_id
       AND participant.source='auth'
      WHERE receipt.week_id=? AND receipt.pair_group_id=?
        AND EXISTS (SELECT 1 FROM access)
      ORDER BY receipt.user_id`,
    args:[...accessArgs,weekId,pairGroupId],
  });
  if(!receiptsResult?.rows) throw new SessionControlsDataError('stored completion state is invalid');
  const completion=projectSessionCompletion(pair,receiptsResult.rows,versionKey);
  const controlsResult=await db.execute({
    sql:`WITH access AS (${accessSql})
      SELECT week_id,pair_group_id,pair_user_a_id,pair_user_a_source,
        pair_user_b_id,pair_user_b_source,pair_user_c_id,candidate_user_id,candidate_source,
        timer_state,remaining_ms,anchor_at,revision,updated_by,updated_by_source,
        created_at,updated_at
      FROM pair_session_controls
      WHERE week_id=? AND pair_group_id=? AND EXISTS (SELECT 1 FROM access)
      LIMIT 1`,
    args:[...accessArgs,weekId,pairGroupId],
  });
  if(!controlsResult?.rows) throw new SessionControlsDataError('stored session-controls state is invalid');
  const row=controlsResult.rows[0]||null;
  let lobby=null;
  if(lobbyMode){
    const interviewResult=await db.execute({
      sql:`WITH access AS (${accessSql})
        SELECT week_id,pair_group_id,pair_user_a_id,pair_user_b_id,admission,admitted_at,editing_locked,
          revision,updated_by,created_at,updated_at
        FROM pair_interview_sessions
        WHERE week_id=? AND pair_group_id=? AND EXISTS (SELECT 1 FROM access)
        LIMIT 1`,
      args:[...accessArgs,weekId,pairGroupId],
    });
    const scheduleResult=await db.execute({
      sql:`WITH access AS (${accessSql})
        SELECT agreed_time FROM pair_schedules
        WHERE week_id=? AND pair_group_id=? AND EXISTS (SELECT 1 FROM access)
        LIMIT 1`,
      args:[...accessArgs,weekId,pairGroupId],
    });
    if(!interviewResult?.rows||!scheduleResult?.rows) throw new SessionControlsDataError('stored interview state is invalid');
    const interviewRow=interviewResult.rows[0]||null;
    lobby=Object.freeze({
      interviewRow:normalizeInterviewRow(interviewRow,pair),
      staleInterviewRow:!!interviewRow&&!normalizeInterviewRow(interviewRow,pair),
      scheduledStartAt:canonicalScheduledStart(scheduleResult.rows[0]?.agreed_time),
    });
  }
  const databaseNow=await readSessionControlsDatabaseNow(db);
  const state=projectSessionControls(pair,row,{databaseNow,completion,versionKey,interview,lobby});
  return {
    pair,row,completion,accessSql,accessArgs,databaseNow,lobby,
    mode:interview?interviewModeFrom({interview:true,lobby:lobbyMode}):interviewModeFrom(),
    phase:lobby?lobbyPhase(durableState(pair,normalizeControlRow(row,pair)),lobby,databaseNow):null,
    state,
  };
}

// Call only after exact auth-pair authorization, in the caller's transaction.
// No HMAC or receipt mutation is needed to recognize a timer boundary.
export async function interviewTimerEnded(db,pair,mode=null){
  if(!interviewSessionEnabled()) return false;
  if(mode?.lobby){
    const gate=await readInterviewGate(db,mode,{weekId:pair.weekId,pairGroupId:pair.pairGroupId});
    return !gate||gate.ended;
  }
  const result=await db.execute({
    sql:'SELECT * FROM pair_session_controls WHERE week_id=? AND pair_group_id=? LIMIT 1',
    args:[pair.weekId,pair.pairGroupId],
  });
  if(!Array.isArray(result?.rows)) throw new SessionControlsDataError('stored session-controls state is invalid');
  const durable=normalizeControlRow(result.rows[0]||null,pair);
  if(!durable) return false;
  const now=await readSessionControlsDatabaseNow(db);
  if(Date.parse(now)<Date.parse(durable.updatedAt)) throw new SessionControlsDataError('database session-controls clock is invalid');
  return durable.remainingMs===0||durable.timerState==='running'
    &&boundedElapsed(durable.anchorAt,now)>=durable.remainingMs;
}

// SQLite time advances even inside a serialized write transaction. Repeat
// this boundary in each storage statement, not just an earlier clock read.
export function interviewTimerOpenSql(){
  return interviewSessionEnabled()?`NOT EXISTS (SELECT 1 FROM pair_session_controls control
    WHERE control.week_id=? AND control.pair_group_id=?
      AND (control.remaining_ms=0 OR (control.timer_state='running'
        AND strftime('%Y-%m-%dT%H:%M:%fZ','now')>=strftime('%Y-%m-%dT%H:%M:%fZ',
          control.anchor_at,printf('+%.3f seconds',control.remaining_ms/1000.0)))))`:'1';
}

function retryableConflict(error){
  let current=error;
  for(let depth=0;current&&depth<6;depth+=1){
    const codes=[current.code,current.rawCode].filter(Boolean).map(value=>String(value).toUpperCase());
    if(codes.some(code=>[
      'SQLITE_BUSY','SQLITE_BUSY_SNAPSHOT','SQLITE_LOCKED','SQLITE_LOCKED_SHAREDCACHE',
      'TRANSACTION_CONFLICT','LIBSQL_TRANSACTION_BUSY',
    ].includes(code))) return true;
    const message=String(current.message||'').trim();
    if(/^(?:SQLITE_(?:BUSY|LOCKED)(?::|\s+-)\s*)?database (?:table )?is locked$/i.test(message)
      ||/^database is busy$/i.test(message)) return true;
    current=current.cause;
  }
  return false;
}

function retryDelay(attempt){
  return new Promise(resolve=>setTimeout(resolve,Math.min(200,25*(2**(attempt-1)))));
}

class SessionControlsAttemptError extends Error{
  constructor(cause,commitStarted){
    super('session-controls transaction failed',{cause}); this.commitStarted=commitStarted;
  }
}

function lobbyConflict(state){
  return new SessionControlsConflictError(
    'interview_lobby','Admit the candidate before using the shared timer.',state,
  );
}

// Returns null for an already-achieved command, else the next durable controls
// row (`controls`) and/or interview row (`interview`).
function desiredTransition(current,mutation){
  const stored=durableState(current.pair,normalizeControlRow(current.row,current.pair));
  const phase=current.phase;
  const durable=phase?phase.effective:stored;
  const interviewRow=current.lobby?.interviewRow||null;
  const interviewNext=change=>({interview:{
    admission:interviewRow?.admission??null,admittedAt:interviewRow?.admittedAt??null,
    editingLocked:interviewRow?.editingLocked===true,admitNow:false,...change,
  }});
  if(LOBBY_ACTIONS.has(mutation.action)){
    if(!phase) throw new SessionControlsInputError('unsupported session-controls action');
    if(mutation.action==='admit') return phase.live?null:interviewNext({admission:'interviewer',admitNow:true});
    const locked=mutation.action==='lock_editing';
    return phase.locked===locked?null:interviewNext({editingLocked:locked});
  }
  if(mutation.action==='set_candidate'){
    if(![current.pair.userAId,current.pair.userBId].includes(mutation.candidateUserId)){
      throw new SessionControlsInputError('candidate must be a participant in this pair');
    }
    if(durable.candidateUserId===mutation.candidateUserId) return null;
    return {controls:{...durable,candidateUserId:mutation.candidateUserId}};
  }
  if(mutation.action==='end'){
    return {controls:{...durable,timerState:'paused',remainingMs:0,anchorAt:null}};
  }
  // The lobby keeps the candidate's timer inert until admission or schedule.
  if(phase&&!phase.live) throw lobbyConflict(current.state);
  if(mutation.action==='start'){
    if(current.state.timer_state==='running') return null;
    if(current.state.remaining_ms===0){
      throw new SessionControlsConflictError(
        'session_controls_reset_required','Reset the expired timer before starting it again.',current.state,
      );
    }
    return {controls:{...durable,timerState:'running',remainingMs:current.state.remaining_ms,anchorAt:current.databaseNow}};
  }
  if(mutation.action==='pause'){
    if(current.state.timer_state!=='running') return null;
    return {controls:{...durable,timerState:'paused',remainingMs:current.state.remaining_ms,anchorAt:null}};
  }
  if(mutation.action==='reset'){
    if(durable.timerState==='paused'&&durable.remainingMs===SESSION_TIMER_DURATION_MS&&durable.anchorAt===null) return null;
    return {controls:{...durable,timerState:'paused',remainingMs:SESSION_TIMER_DURATION_MS,anchorAt:null}};
  }
  throw new SessionControlsInputError('unsupported session-controls action');
}

async function writeTransition(transaction,current,{viewerId,mutation,next}){
  const pair=current.pair;
  const fence=interviewOpenFence(current.mode,{weekId:pair.weekId,pairGroupId:pair.pairGroupId});
  if(!current.row){
    return transaction.execute({
      sql:`WITH access AS (${current.accessSql})
        INSERT INTO pair_session_controls
          (week_id,pair_group_id,pair_user_a_id,pair_user_a_source,
            pair_user_b_id,pair_user_b_source,pair_user_c_id,candidate_user_id,candidate_source,
            timer_state,remaining_ms,anchor_at,revision,updated_by,updated_by_source,created_at,updated_at)
        SELECT ?,?,user_a_id,'auth',user_b_id,'auth',NULL,?,'auth',?,?,?,1,?,'auth',?,?
        FROM access
        WHERE is_ai_pair=0 AND user_c_id IS NULL
          AND user_a_source='auth' AND user_b_source='auth' AND ${fence.sql}
        ON CONFLICT(week_id,pair_group_id) DO NOTHING
        RETURNING revision`,
      args:[...current.accessArgs,mutation.weekId,mutation.pairGroupId,next.candidateUserId,
        next.timerState,next.remainingMs,next.anchorAt,viewerId,current.databaseNow,current.databaseNow,...fence.args],
    });
  }
  return transaction.execute({
    sql:`WITH access AS (${current.accessSql})
      UPDATE pair_session_controls SET candidate_user_id=?,candidate_source='auth',
        timer_state=?,remaining_ms=?,anchor_at=?,revision=revision+1,
        updated_by=?,updated_by_source='auth',updated_at=?
      WHERE week_id=? AND pair_group_id=? AND revision=?
        AND pair_user_a_id=? AND pair_user_b_id=? AND pair_user_c_id IS NULL
        AND EXISTS (SELECT 1 FROM access WHERE is_ai_pair=0 AND user_c_id IS NULL
          AND user_a_id=pair_session_controls.pair_user_a_id
          AND user_b_id=pair_session_controls.pair_user_b_id
          AND user_a_source='auth' AND user_b_source='auth')
        AND ${fence.sql}
      RETURNING revision`,
    args:[...current.accessArgs,next.candidateUserId,next.timerState,next.remainingMs,next.anchorAt,
      viewerId,current.databaseNow,mutation.weekId,mutation.pairGroupId,current.row.revision,
      pair.userAId,pair.userBId,...fence.args],
  });
}

// Admission and the lock live in the migration-26 row. Admission must still
// be in the lobby when the statement runs: at the agreed start the schedule
// wins, so a racing admit cannot cancel the scheduled timer.
async function writeInterviewTransition(transaction,current,{viewerId,mutation,next}){
  const pair=current.pair;
  const fence=interviewOpenFence(current.mode,{weekId:pair.weekId,pairGroupId:pair.pairGroupId});
  const lobbyGuard=next.admitNow?` AND COALESCE((SELECT live FROM (${interviewStateSql()})),1)=0`:'';
  const lobbyArgs=next.admitNow?[pair.weekId,pair.pairGroupId]:[];
  const now="strftime('%Y-%m-%dT%H:%M:%fZ','now')";
  const admittedAt=next.admitNow?now:'?';
  const admittedArgs=next.admitNow?[]:[next.admittedAt];
  if(current.lobby.staleInterviewRow){
    await transaction.execute({
      sql:`DELETE FROM pair_interview_sessions WHERE week_id=? AND pair_group_id=?
        AND NOT (pair_user_a_id=? AND pair_user_b_id=?)`,
      args:[pair.weekId,pair.pairGroupId,pair.userAId,pair.userBId],
    });
  }
  if(!current.lobby.interviewRow){
    return transaction.execute({
      sql:`WITH access AS (${current.accessSql})
        INSERT INTO pair_interview_sessions
          (week_id,pair_group_id,pair_user_a_id,pair_user_b_id,admission,admitted_at,editing_locked,
            revision,updated_by,created_at,updated_at)
        SELECT ?,?,user_a_id,user_b_id,?,${admittedAt},?,1,?,${now},${now}
        FROM access
        WHERE is_ai_pair=0 AND user_c_id IS NULL AND user_a_source='auth' AND user_b_source='auth'
          AND ${fence.sql}${lobbyGuard}
        ON CONFLICT(week_id,pair_group_id) DO NOTHING
        RETURNING revision`,
      args:[...current.accessArgs,mutation.weekId,mutation.pairGroupId,next.admission,...admittedArgs,
        next.editingLocked?1:0,viewerId,...fence.args,...lobbyArgs],
    });
  }
  return transaction.execute({
    sql:`WITH access AS (${current.accessSql})
      UPDATE pair_interview_sessions SET admission=?,admitted_at=${admittedAt},editing_locked=?,
        revision=revision+1,updated_by=?,updated_at=${now}
      WHERE week_id=? AND pair_group_id=? AND revision=? AND pair_user_a_id=? AND pair_user_b_id=?
        AND EXISTS (SELECT 1 FROM access WHERE is_ai_pair=0 AND user_c_id IS NULL
          AND user_a_id=pair_interview_sessions.pair_user_a_id AND user_b_id=pair_interview_sessions.pair_user_b_id
          AND user_a_source='auth' AND user_b_source='auth')
        AND ${fence.sql}${lobbyGuard}
      RETURNING revision`,
    args:[...current.accessArgs,next.admission,...admittedArgs,next.editingLocked?1:0,viewerId,
      mutation.weekId,mutation.pairGroupId,current.lobby.interviewRow.revision,pair.userAId,pair.userBId,
      ...fence.args,...lobbyArgs],
  });
}

function terminalConflict(state){
  const ended=state.interview_mode&&state.end_reason!=='completed';
  return new SessionControlsConflictError(
    ended?'interview_session_ended':'session_controls_completed',
    ended?'The interview has ended. Session controls are read-only.':
      'Session controls are read-only after every participant confirms completion.',state,
  );
}

async function mutateAttempt(db,{viewerId,mutation,versionKey,mode}){
  const transaction=await db.transaction('write');
  let finished=false,commitStarted=false;
  const read=()=>readAuthorizedSessionControls(transaction,{
    viewerId,weekId:mutation.weekId,pairGroupId:mutation.pairGroupId,versionKey,mode,
  });
  try{
    let current=await read();
    if(!current){ await transaction.rollback(); finished=true; return {notFound:true}; }
    if(INTERVIEW_ACTIONS.has(mutation.action)&&!interviewSessionEnabled()){
      throw new SessionControlsInputError('unsupported session-controls action');
    }
    // Without migration 26 the lobby commands do not exist for anyone. This
    // 400 deliberately precedes the role check below so both participants get
    // the same answer: it cannot be used as an oracle for who is interviewer.
    if(LOBBY_ACTIONS.has(mutation.action)&&!current.lobby){
      throw new SessionControlsInputError('unsupported session-controls action');
    }
    // Authorize before terminal, idempotency, or CAS: even a no-op must not
    // let the candidate exercise (or transfer) interviewer authority.
    if(current.state.interview_mode&&current.state.viewer_role!=='interviewer'){
      await transaction.rollback(); finished=true; return {notFound:true};
    }
    if(current.state.terminal) throw terminalConflict(current.state);
    let next=desiredTransition(current,mutation);
    if(!next){
      await transaction.commit(); finished=true;
      return {state:current.state,idempotent:true};
    }
    if(mutation.baseVersion!==current.state.version){
      throw new SessionControlsConflictError(
        'session_controls_changed','Session controls changed. Review the latest state.',current.state,
      );
    }
    if(current.phase?.scheduleRun){
      // Freeze the schedule-derived start before any other write so the
      // command applies to durable rows and no later schedule edit rewinds it.
      try{ await materializeScheduledStart(transaction,current.mode,{weekId:mutation.weekId,pairGroupId:mutation.pairGroupId}); }
      catch(error){ if(error instanceof InterviewStateChangedError) return await conflictAfterRejectedWrite(); throw error; }
      current=await read();
      if(!current) throw new SessionControlsDataError('session-controls authorization changed');
      if(current.state.terminal) throw terminalConflict(current.state);
      next=desiredTransition(current,mutation);
    }
    if(next?.controls){
      const written=await writeTransition(transaction,current,{viewerId,mutation,next:next.controls});
      if(!written?.rows?.length) return await conflictAfterRejectedWrite();
    }
    if(next?.interview){
      const written=await writeInterviewTransition(transaction,current,{viewerId,mutation,next:next.interview});
      if(!written?.rows?.length) return await conflictAfterRejectedWrite();
    }
    const updated=await read();
    if(!updated) throw new SessionControlsDataError('session-controls authorization changed');
    commitStarted=true; await transaction.commit(); finished=true;
    return {state:updated.state,idempotent:false};
  }catch(error){
    if(!finished){ try{ await transaction.rollback(); }catch{} }
    throw new SessionControlsAttemptError(error,commitStarted);
  }finally{ try{ await transaction.close?.(); }catch{} }

  async function conflictAfterRejectedWrite(){
    const latest=await read();
    if(!latest){ await transaction.rollback(); finished=true; return {notFound:true}; }
    if(latest.state.interview_mode&&latest.state.terminal){
      throw new SessionControlsConflictError(
        'interview_session_ended','The interview has ended. Session controls are read-only.',latest.state,
      );
    }
    throw new SessionControlsConflictError(
      'session_controls_changed','Session controls changed. Review the latest state.',latest.state,
    );
  }
}

export async function mutateAuthorizedSessionControls(db,{viewerId,mutation,versionKey,mode=null}){
  if(!db||typeof db.transaction!=='function') throw new TypeError('transactional database client is required');
  const resolved=mode||await resolveInterviewMode(db);
  let lastError;
  for(let attempt=1;attempt<=TRANSACTION_ATTEMPTS;attempt+=1){
    try{ return await mutateAttempt(db,{viewerId,mutation,versionKey,mode:resolved}); }
    catch(attemptError){
      const error=attemptError instanceof SessionControlsAttemptError?attemptError.cause:attemptError;
      lastError=error;
      if(attemptError?.commitStarted||attempt===TRANSACTION_ATTEMPTS||!retryableConflict(error)) throw error;
      await retryDelay(attempt);
    }
  }
  throw lastError||new SessionControlsDataError('session-controls mutation failed');
}
