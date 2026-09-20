import { createHmac } from 'node:crypto';

import { authPairAccessArgs } from './_pair-access.js';
import { parseCanonicalRoomPath } from './_pairing.js';

const OPAQUE_VERSION=/^[a-f0-9]{64}$/;
const COMPLETION_STATES=new Set(['not_recorded','awaiting_participants','completed']);
const ALLOWED_QUERY_KEYS=new Set(['endpoint','room_id']);
const TRANSACTION_ATTEMPTS=4;

export class SessionCompletionInputError extends Error{
  constructor(message){
    super(message);
    this.name='SessionCompletionInputError';
  }
}

export class SessionCompletionDataError extends Error{
  constructor(message,{cause}={}){
    super(message,cause===undefined?undefined:{cause});
    this.name='SessionCompletionDataError';
  }
}

export class SessionCompletionConflictError extends Error{
  constructor(code,message,completion){
    super(message);
    this.name='SessionCompletionConflictError';
    this.code=code;
    this.completion=completion;
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

export function parseSessionCompletionQuery(req){
  const query=requestQuery(req);
  if(Object.keys(query).some(key=>!ALLOWED_QUERY_KEYS.has(key))){
    throw new SessionCompletionInputError('unsupported query parameter');
  }
  if(Object.values(query).some(Array.isArray)){
    throw new SessionCompletionInputError('query parameters must be provided once');
  }
  if(query.endpoint!==undefined&&query.endpoint!=='session-completion'){
    throw new SessionCompletionInputError('unsupported session completion endpoint');
  }
  const room=canonicalRoom(query.room_id);
  if(!room) throw new SessionCompletionInputError('canonical room_id required');
  return room;
}

export function parseSessionCompletionMutation(body){
  if(!body||typeof body!=='object'||Array.isArray(body)){
    throw new SessionCompletionInputError('request body must be an object');
  }
  if(!['confirm','withdraw'].includes(body.action)){
    throw new SessionCompletionInputError('unsupported session completion action');
  }
  if(!exactKeys(body,['room_id','action','base_version'])){
    throw new SessionCompletionInputError('unexpected or missing session completion fields');
  }
  const room=canonicalRoom(body.room_id);
  if(!room) throw new SessionCompletionInputError('canonical room_id required');
  if(typeof body.base_version!=='string'||!OPAQUE_VERSION.test(body.base_version)){
    throw new SessionCompletionInputError('valid base_version required');
  }
  return {...room,action:body.action,baseVersion:body.base_version};
}

export function validateSessionCompletionPostQuery(req){
  const query=requestQuery(req);
  if(Object.keys(query).some(key=>key!=='endpoint')||Object.values(query).some(Array.isArray)
    ||(query.endpoint!==undefined&&query.endpoint!=='session-completion')){
    throw new SessionCompletionInputError('unsupported query parameter');
  }
  return true;
}

function normalizedTimestamp(value,field){
  if(typeof value!=='string') throw new SessionCompletionDataError(`stored ${field} is invalid`);
  const epoch=Date.parse(value);
  if(!Number.isFinite(epoch)) throw new SessionCompletionDataError(`stored ${field} is invalid`);
  const normalized=new Date(epoch).toISOString();
  if(normalized!==value) throw new SessionCompletionDataError(`stored ${field} is invalid`);
  return normalized;
}

export function canonicalCompletionPair(row,viewerIdValue){
  if(!row||typeof row!=='object') throw new SessionCompletionDataError('stored pair is invalid');
  const pairGroupId=positiveSafeInteger(row.pair_group_id);
  const weekId=positiveSafeInteger(row.week_id);
  const viewerId=positiveSafeInteger(viewerIdValue);
  const isAi=Number(row.is_ai_pair);
  if(!pairGroupId||!weekId||!viewerId||![0,1].includes(isAi)){
    throw new SessionCompletionDataError('stored pair is invalid');
  }
  const members=[];
  const byId=new Map();
  for(const [rawId,rawSource] of [
    [row.user_a_id,row.user_a_source],
    [row.user_b_id,row.user_b_source],
    [row.user_c_id,row.user_c_source],
  ]){
    if(rawId===null||rawId===undefined) continue;
    const id=positiveSafeInteger(rawId);
    const source=String(rawSource||'');
    if(!id||!['auth','users'].includes(source)){
      throw new SessionCompletionDataError('stored pair participant is invalid');
    }
    const previous=byId.get(id);
    if(previous&&previous!==source){
      throw new SessionCompletionDataError('stored pair participant is invalid');
    }
    if(!previous){ byId.set(id,source); members.push({id,source}); }
  }
  const viewer=members.find(member=>member.id===viewerId);
  const requiredUserIds=members.filter(member=>member.source==='auth').map(member=>member.id);
  if(!viewer||viewer.source!=='auth'||requiredUserIds.length<1||requiredUserIds.length>3){
    throw new SessionCompletionDataError('stored pair authorization is invalid');
  }
  if(isAi&&members.length!==1){
    throw new SessionCompletionDataError('stored AI pair is invalid');
  }
  if(!isAi&&(members.length<2||members.length>3)){
    throw new SessionCompletionDataError('stored pair membership is invalid');
  }
  return Object.freeze({
    pairGroupId,weekId,viewerId,isAi:Boolean(isAi),
    requiredUserIds:Object.freeze([...requiredUserIds].sort((a,b)=>a-b)),
  });
}

function completionVersion(pair,receipts,versionKey){
  if(typeof versionKey!=='string'||versionKey.length<32){
    throw new SessionCompletionDataError('session completion version key is unavailable');
  }
  const evidence=receipts.map(receipt=>[receipt.userId,receipt.confirmedAt]);
  return createHmac('sha256',versionKey)
    .update(`randori-session-completion-v1\0${JSON.stringify([
      pair.weekId,pair.pairGroupId,pair.requiredUserIds,evidence,
    ])}`,'utf8')
    .digest('hex');
}

export function projectSessionCompletion(pair,rows=[],versionKey){
  if(!pair||!Array.isArray(pair.requiredUserIds)||!Array.isArray(rows)){
    throw new SessionCompletionDataError('stored session completion is invalid');
  }
  const required=new Set(pair.requiredUserIds);
  const seen=new Set();
  const receipts=rows.map(row=>{
    const userId=positiveSafeInteger(row?.user_id);
    const confirmedAt=normalizedTimestamp(row?.confirmed_at,'session completion timestamp');
    if(!userId||!required.has(userId)||seen.has(userId)){
      throw new SessionCompletionDataError('stored session completion is invalid');
    }
    seen.add(userId);
    return {userId,confirmedAt};
  }).sort((left,right)=>left.userId-right.userId);
  const requiredCount=pair.requiredUserIds.length;
  const confirmedCount=receipts.length;
  const state=confirmedCount===0
    ?'not_recorded'
    :(confirmedCount===requiredCount?'completed':'awaiting_participants');
  if(!COMPLETION_STATES.has(state)||confirmedCount>requiredCount){
    throw new SessionCompletionDataError('stored session completion is invalid');
  }
  return Object.freeze({
    state,
    viewer_confirmed:seen.has(pair.viewerId),
    confirmed_count:confirmedCount,
    required_count:requiredCount,
    version:completionVersion(pair,receipts,versionKey),
    completed_at:state==='completed'
      ?receipts.reduce((latest,receipt)=>latest>receipt.confirmedAt?latest:receipt.confirmedAt,'')
      :null,
  });
}

function sourceTaggedPairAccessArgs({viewerId,weekId,pairGroupId}){
  const actor=positiveSafeInteger(viewerId);
  const week=positiveSafeInteger(weekId);
  const pair=positiveSafeInteger(pairGroupId);
  if(!actor||!week||!pair) throw new SessionCompletionInputError('valid room and actor required');
  return authPairAccessArgs({userId:actor,weekId:week,pairGroupId:pair});
}

function sourceTaggedPairAccessSql(){
  const membership=process.env.CIRCLE_MEMBERSHIP_ENABLED==='true'?`
    JOIN circle_memberships AS viewer_membership
      ON viewer_membership.user_id=viewer.user_id AND viewer_membership.status='active'
    JOIN circles AS viewer_circle
      ON viewer_circle.id=viewer_membership.circle_id
     AND viewer_circle.is_primary=1 AND viewer_circle.archived_at IS NULL`:'';
  return `SELECT pg.id AS pair_group_id,pg.week_id,pg.user_a_id,pg.user_b_id,pg.user_c_id,
      pg.is_ai_pair,pa.source AS user_a_source,pb.source AS user_b_source,pc.source AS user_c_source
    FROM pairing_groups pg
    JOIN pairing_participants viewer
      ON viewer.week_id=pg.week_id AND viewer.user_id=? AND viewer.source='auth'
    LEFT JOIN pairing_participants pa ON pa.week_id=pg.week_id AND pa.user_id=pg.user_a_id
    LEFT JOIN pairing_participants pb ON pb.week_id=pg.week_id AND pb.user_id=pg.user_b_id
    LEFT JOIN pairing_participants pc ON pc.week_id=pg.week_id AND pc.user_id=pg.user_c_id${membership}
    WHERE pg.id=? AND pg.week_id=?
      AND (pg.user_a_id=? OR pg.user_b_id=? OR pg.user_c_id=?)
    LIMIT 1`;
}

export async function readCompletionDatabaseNow(db){
  let result;
  try{ result=await db.execute("SELECT strftime('%Y-%m-%dT%H:%M:%fZ','now') AS now_utc"); }
  catch(error){
    throw new SessionCompletionDataError('database completion clock is unavailable',{cause:error});
  }
  const raw=result?.rows?.length===1?String(result.rows[0]?.now_utc||''):'';
  return normalizedTimestamp(raw,'database completion clock');
}

export async function readAuthorizedSessionCompletion(db,{viewerId,weekId,pairGroupId,versionKey}){
  if(!db||typeof db.execute!=='function') throw new TypeError('database client is required');
  const accessSql=sourceTaggedPairAccessSql();
  const accessArgs=sourceTaggedPairAccessArgs({viewerId,weekId,pairGroupId});
  const pairResult=await db.execute({sql:accessSql,args:accessArgs});
  if(!pairResult?.rows?.length) return null;
  const pair=canonicalCompletionPair(pairResult.rows[0],viewerId);
  const receiptsResult=await db.execute({
    sql:`WITH access AS (${accessSql})
      SELECT receipt.user_id,receipt.confirmed_at
      FROM session_completion_receipts receipt
      JOIN pairing_participants participant
        ON participant.week_id=receipt.week_id
       AND participant.user_id=receipt.user_id
       AND participant.source='auth'
      WHERE receipt.week_id=? AND receipt.pair_group_id=?
        AND EXISTS (SELECT 1 FROM access)
      ORDER BY receipt.user_id`,
    args:[...accessArgs,weekId,pairGroupId],
  });
  if(!receiptsResult?.rows) throw new SessionCompletionDataError('stored session completion is invalid');
  return {pair,completion:projectSessionCompletion(pair,receiptsResult.rows,versionKey),accessSql,accessArgs};
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

class CompletionAttemptError extends Error{
  constructor(cause,commitStarted){
    super('session completion transaction failed',{cause});
    this.name='CompletionAttemptError';
    this.commitStarted=commitStarted;
  }
}

async function mutateAttempt(db,{viewerId,mutation,versionKey}){
  const transaction=await db.transaction('write');
  let finished=false;
  let commitStarted=false;
  try{
    const current=await readAuthorizedSessionCompletion(transaction,{
      viewerId,weekId:mutation.weekId,pairGroupId:mutation.pairGroupId,versionKey,
    });
    if(!current){
      await transaction.rollback(); finished=true;
      return {notFound:true};
    }
    const desiredConfirmed=mutation.action==='confirm';
    if(current.completion.state==='completed'&&!desiredConfirmed){
      throw new SessionCompletionConflictError(
        'session_completion_terminal','A completed session cannot be withdrawn.',current.completion,
      );
    }
    if(current.completion.viewer_confirmed===desiredConfirmed){
      await transaction.commit(); finished=true;
      return {completion:current.completion,idempotent:true};
    }
    if(mutation.baseVersion!==current.completion.version){
      throw new SessionCompletionConflictError(
        'session_completion_changed','Session completion changed. Review the latest state.',current.completion,
      );
    }
    const nowUtc=await readCompletionDatabaseNow(transaction);
    let written;
    if(desiredConfirmed){
      written=await transaction.execute({
        sql:`WITH access AS (${current.accessSql})
          INSERT INTO session_completion_receipts
            (week_id,pair_group_id,user_id,participant_source,
              pair_user_a_id,pair_user_b_id,pair_user_c_id,confirmed_at)
          SELECT ?,?,?, 'auth',user_a_id,user_b_id,user_c_id,?
          FROM access
          WHERE ? IN (user_a_id,user_b_id,user_c_id)
          ON CONFLICT(week_id,pair_group_id,user_id) DO NOTHING
          RETURNING user_id`,
        args:[...current.accessArgs,mutation.weekId,mutation.pairGroupId,viewerId,nowUtc,viewerId],
      });
    }else{
      written=await transaction.execute({
        sql:`WITH access AS (${current.accessSql})
          DELETE FROM session_completion_receipts
          WHERE week_id=? AND pair_group_id=? AND user_id=?
            AND EXISTS (SELECT 1 FROM access)
          RETURNING user_id`,
        args:[...current.accessArgs,mutation.weekId,mutation.pairGroupId,viewerId],
      });
    }
    if(!written?.rows?.length){
      throw new SessionCompletionDataError('session completion mutation did not commit');
    }
    const next=await readAuthorizedSessionCompletion(transaction,{
      viewerId,weekId:mutation.weekId,pairGroupId:mutation.pairGroupId,versionKey,
    });
    if(!next) throw new SessionCompletionDataError('session completion authorization changed');
    commitStarted=true;
    await transaction.commit(); finished=true;
    return {completion:next.completion,idempotent:false};
  }catch(error){
    if(!finished){ try{ await transaction.rollback(); }catch{} }
    throw new CompletionAttemptError(error,commitStarted);
  }finally{ try{ await transaction.close?.(); }catch{} }
}

export async function mutateAuthorizedSessionCompletion(db,{viewerId,mutation,versionKey}){
  if(!db||typeof db.transaction!=='function') throw new TypeError('transactional database client is required');
  let lastError;
  for(let attempt=1;attempt<=TRANSACTION_ATTEMPTS;attempt+=1){
    try{
      return await mutateAttempt(db,{viewerId,mutation,versionKey});
    }catch(attemptError){
      const error=attemptError instanceof CompletionAttemptError?attemptError.cause:attemptError;
      lastError=error;
      if(attemptError?.commitStarted||attempt===TRANSACTION_ATTEMPTS||!retryableConflict(error)) throw error;
      await retryDelay(attempt);
    }
  }
  throw lastError||new SessionCompletionDataError('session completion mutation failed');
}
