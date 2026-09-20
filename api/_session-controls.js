import { createHmac } from 'node:crypto';

import { authPairAccessArgs } from './_pair-access.js';
import { parseCanonicalRoomPath } from './_pairing.js';
import {
  canonicalCompletionPair,
  projectSessionCompletion,
  sourceTaggedPairAccessSql,
} from './_session-completion.js';

export const SESSION_TIMER_DURATION_MS=25*60*1000;
const OPAQUE_VERSION=/^[a-f0-9]{64}$/;
const TRANSACTION_ATTEMPTS=4;
const ACTIONS=new Set(['start','pause','reset','set_candidate']);

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

export function parseSessionControlsMutation(body){
  if(!body||typeof body!=='object'||Array.isArray(body)){
    throw new SessionControlsInputError('request body must be an object');
  }
  if(!ACTIONS.has(body.action)) throw new SessionControlsInputError('unsupported session-controls action');
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

function durableState(pair,row){
  return row||Object.freeze({
    weekId:pair.weekId,pairGroupId:pair.pairGroupId,userAId:pair.userAId,userBId:pair.userBId,
    candidateUserId:pair.userAId,timerState:'paused',remainingMs:SESSION_TIMER_DURATION_MS,
    anchorAt:null,revision:0,createdAt:null,updatedAt:null,
  });
}

function controlsVersion(pair,durable,versionKey){
  if(typeof versionKey!=='string'||versionKey.length<32){
    throw new SessionControlsDataError('session-controls version key is unavailable');
  }
  return createHmac('sha256',versionKey)
    .update(`randori-session-controls-v1\0${JSON.stringify([
      pair.weekId,pair.pairGroupId,pair.userAId,pair.userBId,null,
      durable.candidateUserId,durable.timerState,durable.remainingMs,durable.anchorAt,durable.revision,
    ])}`,'utf8').digest('hex');
}

function boundedElapsed(anchorAt,clockAt){
  return Math.max(0,Date.parse(clockAt)-Date.parse(anchorAt));
}

export function projectSessionControls(pair,row,{databaseNow,completion,versionKey}){
  if(!pair||!completion) throw new SessionControlsDataError('session-controls projection is invalid');
  const now=normalizedTimestamp(databaseNow,'session-controls database clock');
  const durable=durableState(pair,normalizeControlRow(row,pair));
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
  return Object.freeze({
    timer_state:timerState,
    remaining_ms:remainingMs,
    duration_ms:SESSION_TIMER_DURATION_MS,
    candidate_user_id:durable.candidateUserId,
    partner_user_id:partnerUserId,
    viewer_role:viewerRole,
    partner_role:viewerRole==='candidate'?'interviewer':'candidate',
    terminal:completion.state==='completed',
    completion_version:completion.version,
    observed_at:now,
    updated_at:durable.updatedAt,
    version:controlsVersion(pair,durable,versionKey),
  });
}

export async function readSessionControlsDatabaseNow(db){
  let result;
  try{ result=await db.execute("SELECT strftime('%Y-%m-%dT%H:%M:%fZ','now') AS now_utc"); }
  catch(error){ throw new SessionControlsDataError('database session-controls clock is unavailable',{cause:error}); }
  const raw=result?.rows?.length===1?String(result.rows[0]?.now_utc||''):'';
  return normalizedTimestamp(raw,'database session-controls clock');
}

export async function readAuthorizedSessionControls(db,{viewerId,weekId,pairGroupId,versionKey}){
  if(!db||typeof db.execute!=='function') throw new TypeError('database client is required');
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
  const databaseNow=await readSessionControlsDatabaseNow(db);
  return {
    pair,row,completion,accessSql,accessArgs,databaseNow,
    state:projectSessionControls(pair,row,{databaseNow,completion,versionKey}),
  };
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

function desiredTransition(current,mutation){
  const durable=durableState(current.pair,normalizeControlRow(current.row,current.pair));
  if(mutation.action==='set_candidate'){
    if(![current.pair.userAId,current.pair.userBId].includes(mutation.candidateUserId)){
      throw new SessionControlsInputError('candidate must be a participant in this pair');
    }
    if(durable.candidateUserId===mutation.candidateUserId) return null;
    return {...durable,candidateUserId:mutation.candidateUserId};
  }
  if(mutation.action==='start'){
    if(current.state.timer_state==='running') return null;
    if(current.state.remaining_ms===0){
      throw new SessionControlsConflictError(
        'session_controls_reset_required','Reset the expired timer before starting it again.',current.state,
      );
    }
    return {...durable,timerState:'running',remainingMs:current.state.remaining_ms,anchorAt:current.databaseNow};
  }
  if(mutation.action==='pause'){
    if(current.state.timer_state!=='running') return null;
    return {...durable,timerState:'paused',remainingMs:current.state.remaining_ms,anchorAt:null};
  }
  if(mutation.action==='reset'){
    if(durable.timerState==='paused'&&durable.remainingMs===SESSION_TIMER_DURATION_MS&&durable.anchorAt===null) return null;
    return {...durable,timerState:'paused',remainingMs:SESSION_TIMER_DURATION_MS,anchorAt:null};
  }
  throw new SessionControlsInputError('unsupported session-controls action');
}

async function writeTransition(transaction,current,{viewerId,mutation,next}){
  const pair=current.pair;
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
          AND user_a_source='auth' AND user_b_source='auth'
        ON CONFLICT(week_id,pair_group_id) DO NOTHING
        RETURNING revision`,
      args:[...current.accessArgs,mutation.weekId,mutation.pairGroupId,next.candidateUserId,
        next.timerState,next.remainingMs,next.anchorAt,viewerId,current.databaseNow,current.databaseNow],
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
      RETURNING revision`,
    args:[...current.accessArgs,next.candidateUserId,next.timerState,next.remainingMs,next.anchorAt,
      viewerId,current.databaseNow,mutation.weekId,mutation.pairGroupId,current.row.revision,
      pair.userAId,pair.userBId],
  });
}

async function mutateAttempt(db,{viewerId,mutation,versionKey}){
  const transaction=await db.transaction('write');
  let finished=false,commitStarted=false;
  try{
    const current=await readAuthorizedSessionControls(transaction,{
      viewerId,weekId:mutation.weekId,pairGroupId:mutation.pairGroupId,versionKey,
    });
    if(!current){ await transaction.rollback(); finished=true; return {notFound:true}; }
    if(current.state.terminal){
      throw new SessionControlsConflictError(
        'session_controls_completed','Session controls are read-only after every participant confirms completion.',current.state,
      );
    }
    const next=desiredTransition(current,mutation);
    if(!next){
      await transaction.commit(); finished=true;
      return {state:current.state,idempotent:true};
    }
    if(mutation.baseVersion!==current.state.version){
      throw new SessionControlsConflictError(
        'session_controls_changed','Session controls changed. Review the latest state.',current.state,
      );
    }
    const written=await writeTransition(transaction,current,{viewerId,mutation,next});
    if(!written?.rows?.length){
      const latest=await readAuthorizedSessionControls(transaction,{
        viewerId,weekId:mutation.weekId,pairGroupId:mutation.pairGroupId,versionKey,
      });
      if(!latest){ await transaction.rollback(); finished=true; return {notFound:true}; }
      throw new SessionControlsConflictError(
        'session_controls_changed','Session controls changed. Review the latest state.',latest.state,
      );
    }
    const updated=await readAuthorizedSessionControls(transaction,{
      viewerId,weekId:mutation.weekId,pairGroupId:mutation.pairGroupId,versionKey,
    });
    if(!updated) throw new SessionControlsDataError('session-controls authorization changed');
    commitStarted=true; await transaction.commit(); finished=true;
    return {state:updated.state,idempotent:false};
  }catch(error){
    if(!finished){ try{ await transaction.rollback(); }catch{} }
    throw new SessionControlsAttemptError(error,commitStarted);
  }finally{ try{ await transaction.close?.(); }catch{} }
}

export async function mutateAuthorizedSessionControls(db,{viewerId,mutation,versionKey}){
  if(!db||typeof db.transaction!=='function') throw new TypeError('transactional database client is required');
  let lastError;
  for(let attempt=1;attempt<=TRANSACTION_ATTEMPTS;attempt+=1){
    try{ return await mutateAttempt(db,{viewerId,mutation,versionKey}); }
    catch(attemptError){
      const error=attemptError instanceof SessionControlsAttemptError?attemptError.cause:attemptError;
      lastError=error;
      if(attemptError?.commitStarted||attempt===TRANSACTION_ATTEMPTS||!retryableConflict(error)) throw error;
      await retryDelay(attempt);
    }
  }
  throw lastError||new SessionControlsDataError('session-controls mutation failed');
}
