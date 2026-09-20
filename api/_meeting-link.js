import { createHmac } from 'node:crypto';

import { authPairAccessArgs } from './_pair-access.js';
import { parseCanonicalRoomPath } from './_pairing.js';
import { readScheduleState, projectSchedule } from './_schedule.js';
import {
  canonicalCompletionPair,
  projectSessionCompletion,
  sourceTaggedPairAccessSql,
} from './_session-completion.js';

export const MAX_MEETING_URL_BYTES=2048;
const OPAQUE_VERSION=/^[a-f0-9]{64}$/;
const TRANSACTION_ATTEMPTS=4;

export class MeetingLinkInputError extends Error{
  constructor(message){ super(message); this.name='MeetingLinkInputError'; }
}

export class MeetingLinkDataError extends Error{
  constructor(message,{cause}={}){
    super(message,cause===undefined?undefined:{cause});
    this.name='MeetingLinkDataError';
  }
}

export class MeetingLinkConflictError extends Error{
  constructor(code,message,state){
    super(message); this.name='MeetingLinkConflictError'; this.code=code; this.state=state;
  }
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

export function parseMeetingLinkQuery(req){
  const query=requestQuery(req);
  if(Object.keys(query).some(key=>!['endpoint','room_id'].includes(key))
    ||Object.values(query).some(Array.isArray)
    ||(query.endpoint!==undefined&&query.endpoint!=='meeting-link')){
    throw new MeetingLinkInputError('unsupported query parameter');
  }
  const room=canonicalRoom(query.room_id);
  if(!room) throw new MeetingLinkInputError('canonical room_id required');
  return room;
}

export function validateMeetingLinkPostQuery(req){
  const query=requestQuery(req);
  if(Object.keys(query).some(key=>key!=='endpoint')||Object.values(query).some(Array.isArray)
    ||(query.endpoint!==undefined&&query.endpoint!=='meeting-link')){
    throw new MeetingLinkInputError('unsupported query parameter');
  }
  return true;
}

export function normalizeMeetingUrl(value){
  if(typeof value!=='string'||value.length<1||Buffer.byteLength(value,'utf8')>MAX_MEETING_URL_BYTES
    ||/[\u0000-\u001f\u007f]/.test(value)||value.trim()!==value){
    throw new MeetingLinkInputError('meeting URL must be a bounded HTTPS URL');
  }
  let parsed;
  try{ parsed=new URL(value); }
  catch{ throw new MeetingLinkInputError('meeting URL must be a bounded HTTPS URL'); }
  if(parsed.protocol!=='https:'||!parsed.hostname||parsed.username||parsed.password
    ||Buffer.byteLength(parsed.href,'utf8')>MAX_MEETING_URL_BYTES){
    throw new MeetingLinkInputError('meeting URL must use HTTPS without embedded credentials');
  }
  return Object.freeze({url:parsed.href,hostname:parsed.hostname});
}

export function parseMeetingLinkMutation(body){
  if(!body||typeof body!=='object'||Array.isArray(body)){
    throw new MeetingLinkInputError('request body must be an object');
  }
  const action=body.action;
  if(!['set','clear'].includes(action)) throw new MeetingLinkInputError('unsupported meeting-link action');
  const expected=action==='set'
    ?['room_id','action','base_version','schedule_version','completion_version','url']
    :['room_id','action','base_version','schedule_version','completion_version'];
  if(!exactKeys(body,expected)) throw new MeetingLinkInputError('unexpected or missing meeting-link fields');
  const room=canonicalRoom(body.room_id);
  if(!room) throw new MeetingLinkInputError('canonical room_id required');
  for(const field of ['base_version','schedule_version','completion_version']){
    if(typeof body[field]!=='string'||!OPAQUE_VERSION.test(body[field])){
      throw new MeetingLinkInputError(`valid ${field} required`);
    }
  }
  return Object.freeze({
    ...room,action,baseVersion:body.base_version,scheduleVersion:body.schedule_version,
    completionVersion:body.completion_version,
    normalizedUrl:action==='set'?normalizeMeetingUrl(body.url):null,
  });
}

function normalizedTimestamp(value,field){
  if(typeof value!=='string') throw new MeetingLinkDataError(`stored ${field} is invalid`);
  const epoch=Date.parse(value);
  if(!Number.isFinite(epoch)||new Date(epoch).toISOString()!==value){
    throw new MeetingLinkDataError(`stored ${field} is invalid`);
  }
  return value;
}

function meetingVersion({roomId,scheduleVersion,acceptedScheduleAt,row},versionKey){
  if(typeof versionKey!=='string'||versionKey.length<32){
    throw new MeetingLinkDataError('meeting-link version key is unavailable');
  }
  const revision=row?Number(row.revision):0;
  if(!Number.isSafeInteger(revision)||revision<0){
    throw new MeetingLinkDataError('stored meeting-link revision is invalid');
  }
  return createHmac('sha256',versionKey)
    .update(`randori-meeting-link-v1\0${JSON.stringify([
      roomId,scheduleVersion,acceptedScheduleAt,revision,row?.meeting_url??null,
    ])}`,'utf8').digest('hex');
}

function projectActiveMeetingLink({roomId,schedule,completion,row},versionKey){
  const acceptedScheduleAt=schedule.agreed_time;
  let url=null,hostname=null,updatedAt=null;
  if(row){
    if(Number(row.week_id)!==schedule.weekId||Number(row.pair_group_id)!==schedule.pairGroupId
      ||row.accepted_schedule_at!==acceptedScheduleAt){
      throw new MeetingLinkDataError('stored meeting-link binding is invalid');
    }
    const revision=Number(row.revision);
    const updatedBy=Number(row.updated_by);
    if(!Number.isSafeInteger(revision)||revision<1||!Number.isSafeInteger(updatedBy)||updatedBy<1
      ||row.updated_by_source!=='auth'){
      throw new MeetingLinkDataError('stored meeting-link record is invalid');
    }
    updatedAt=normalizedTimestamp(row.updated_at,'meeting-link timestamp');
    if(row.meeting_url!==null&&row.meeting_url!==undefined){
      const normalized=normalizeMeetingUrl(row.meeting_url);
      url=normalized.url; hostname=normalized.hostname;
    }
  }
  return Object.freeze({
    lifecycle:'active',accepted_schedule_at:acceptedScheduleAt,
    schedule_version:schedule.version,completion_version:completion.version,
    version:meetingVersion({roomId,scheduleVersion:schedule.version,acceptedScheduleAt,row},versionKey),
    url,hostname,updated_at:updatedAt,
  });
}

function hiddenMeetingState(lifecycle,schedule,completion){
  return Object.freeze({
    lifecycle,accepted_schedule_at:schedule?.agreed_time||null,
    schedule_version:schedule?.version||null,completion_version:completion.version,
    version:null,url:null,hostname:null,updated_at:null,
  });
}

export async function readAuthorizedMeetingLink(db,{viewerId,weekId,pairGroupId,versionKey}){
  if(!db||typeof db.execute!=='function') throw new TypeError('database client is required');
  const accessSql=sourceTaggedPairAccessSql();
  const accessArgs=authPairAccessArgs({userId:viewerId,weekId,pairGroupId});
  const pairResult=await db.execute({sql:accessSql,args:accessArgs});
  if(!pairResult?.rows?.length) return null;
  const pairRow=pairResult.rows[0];
  const pair=canonicalCompletionPair(pairRow,viewerId);
  const receipts=await db.execute({
    sql:`WITH access AS (${accessSql})
      SELECT receipt.user_id,receipt.confirmed_at
      FROM session_completion_receipts receipt
      WHERE receipt.week_id=? AND receipt.pair_group_id=?
        AND EXISTS (SELECT 1 FROM access)
      ORDER BY receipt.user_id`,
    args:[...accessArgs,weekId,pairGroupId],
  });
  if(!receipts?.rows) throw new MeetingLinkDataError('stored completion state is invalid');
  const completion=projectSessionCompletion(pair,receipts.rows,versionKey);
  const scheduleResult=await db.execute({
    sql:`WITH access AS (${accessSql}), selected AS (
        SELECT proposed_times,agreed_time,updated_at FROM pair_schedules
        WHERE week_id=? AND pair_group_id=? AND EXISTS (SELECT 1 FROM access)
        LIMIT 1
      )
      SELECT proposed_times,agreed_time,updated_at,1 AS data_present FROM selected
      UNION ALL SELECT NULL,NULL,NULL,0
        WHERE EXISTS (SELECT 1 FROM access) AND NOT EXISTS (SELECT 1 FROM selected)`,
    args:[...accessArgs,weekId,pairGroupId],
  });
  if(!scheduleResult?.rows?.length) return null;
  const scheduleRow=scheduleResult.rows.find(row=>Number(row.data_present)===1)||null;
  const projected=projectSchedule(readScheduleState(scheduleRow));
  const schedule={...projected,weekId,pairGroupId};
  if(completion.state==='completed'){
    return {pair,pairRow,completion,schedule,state:hiddenMeetingState('completed',schedule,completion),accessSql,accessArgs,row:null};
  }
  if(!schedule.agreed_time){
    return {pair,pairRow,completion,schedule,state:hiddenMeetingState('unscheduled',schedule,completion),accessSql,accessArgs,row:null};
  }
  const linkResult=await db.execute({
    sql:`WITH access AS (${accessSql})
      SELECT week_id,pair_group_id,accepted_schedule_at,meeting_url,revision,
        updated_by,updated_by_source,created_at,updated_at
      FROM pair_meeting_links
      WHERE week_id=? AND pair_group_id=? AND accepted_schedule_at=?
        AND EXISTS (SELECT 1 FROM access)
      LIMIT 1`,
    args:[...accessArgs,weekId,pairGroupId,schedule.agreed_time],
  });
  if(!linkResult?.rows) throw new MeetingLinkDataError('stored meeting-link state is invalid');
  const row=linkResult.rows[0]||null;
  const roomId=`week_${weekId}_pair_${pairGroupId}`;
  return {
    pair,pairRow,completion,schedule,row,accessSql,accessArgs,
    state:projectActiveMeetingLink({roomId,schedule,completion,row},versionKey),
  };
}

function retryableConflict(error){
  let current=error;
  for(let depth=0;current&&depth<6;depth+=1){
    const codes=[current.code,current.rawCode].filter(Boolean).map(value=>String(value).toUpperCase());
    if(codes.some(code=>['SQLITE_BUSY','SQLITE_BUSY_SNAPSHOT','SQLITE_LOCKED','SQLITE_LOCKED_SHAREDCACHE','TRANSACTION_CONFLICT','LIBSQL_TRANSACTION_BUSY'].includes(code))) return true;
    if(/^(?:SQLITE_(?:BUSY|LOCKED)(?::|\s+-)\s*)?database (?:table )?is locked$/i.test(String(current.message||'').trim())
      ||/^database is busy$/i.test(String(current.message||'').trim())) return true;
    current=current.cause;
  }
  return false;
}

function retryDelay(attempt){ return new Promise(resolve=>setTimeout(resolve,Math.min(200,25*(2**(attempt-1))))); }

class MeetingAttemptError extends Error{
  constructor(cause,commitStarted){ super('meeting-link transaction failed',{cause}); this.commitStarted=commitStarted; }
}

async function mutateAttempt(db,{viewerId,mutation,versionKey}){
  const transaction=await db.transaction('write');
  let finished=false,commitStarted=false;
  try{
    const current=await readAuthorizedMeetingLink(transaction,{
      viewerId,weekId:mutation.weekId,pairGroupId:mutation.pairGroupId,versionKey,
    });
    if(!current){ await transaction.rollback(); finished=true; return {notFound:true}; }
    if(current.state.lifecycle==='completed'){
      throw new MeetingLinkConflictError('meeting_link_session_completed','The completed session no longer exposes a meeting link.',current.state);
    }
    if(current.state.lifecycle!=='active'){
      throw new MeetingLinkConflictError('meeting_link_schedule_required','Agree on a session time before adding a meeting link.',current.state);
    }
    if(mutation.scheduleVersion!==current.state.schedule_version){
      throw new MeetingLinkConflictError('meeting_link_schedule_changed','The accepted schedule changed. Review the latest session time.',current.state);
    }
    if(mutation.completionVersion!==current.state.completion_version){
      throw new MeetingLinkConflictError('meeting_link_completion_changed','Session completion changed. Review the latest state.',current.state);
    }
    const desired=mutation.action==='set'?mutation.normalizedUrl.url:null;
    if(current.state.url===desired){
      await transaction.commit(); finished=true;
      return {state:current.state,idempotent:true};
    }
    if(mutation.baseVersion!==current.state.version){
      throw new MeetingLinkConflictError('meeting_link_changed','The meeting link changed. Review the latest value.',current.state);
    }
    const nowResult=await transaction.execute("SELECT strftime('%Y-%m-%dT%H:%M:%fZ','now') AS now_utc");
    const nowUtc=normalizedTimestamp(nowResult?.rows?.[0]?.now_utc,'database meeting-link clock');
    let written;
    if(mutation.action==='set'){
      written=await transaction.execute({
        sql:`WITH access AS (${current.accessSql})
          INSERT INTO pair_meeting_links
            (week_id,pair_group_id,accepted_schedule_at,meeting_url,revision,
              updated_by,updated_by_source,pair_user_a_id,pair_user_b_id,pair_user_c_id,
              created_at,updated_at)
          SELECT ?,?,?,?,?,?,'auth',user_a_id,user_b_id,user_c_id,?,?
          FROM access
          WHERE EXISTS (
            SELECT 1 FROM pair_schedules schedule
            WHERE schedule.week_id=? AND schedule.pair_group_id=? AND schedule.agreed_time=?
          )
          ON CONFLICT(week_id,pair_group_id) DO UPDATE SET
            meeting_url=excluded.meeting_url,
            revision=pair_meeting_links.revision+1,
            updated_by=excluded.updated_by,
            updated_by_source='auth',
            updated_at=excluded.updated_at
          WHERE pair_meeting_links.accepted_schedule_at=excluded.accepted_schedule_at
          RETURNING revision`,
        args:[...current.accessArgs,mutation.weekId,mutation.pairGroupId,
          current.schedule.agreed_time,desired,1,viewerId,nowUtc,nowUtc,
          mutation.weekId,mutation.pairGroupId,current.schedule.agreed_time],
      });
    }else if(current.row){
      written=await transaction.execute({
        sql:`WITH access AS (${current.accessSql})
          UPDATE pair_meeting_links SET meeting_url=NULL,revision=revision+1,
            updated_by=?,updated_by_source='auth',updated_at=?
          WHERE week_id=? AND pair_group_id=? AND accepted_schedule_at=?
            AND EXISTS (SELECT 1 FROM access)
          RETURNING revision`,
        args:[...current.accessArgs,viewerId,nowUtc,mutation.weekId,mutation.pairGroupId,current.schedule.agreed_time],
      });
    }else{
      await transaction.commit(); finished=true;
      return {state:current.state,idempotent:true};
    }
    if(!written?.rows?.length) throw new MeetingLinkDataError('meeting-link mutation did not commit');
    const next=await readAuthorizedMeetingLink(transaction,{
      viewerId,weekId:mutation.weekId,pairGroupId:mutation.pairGroupId,versionKey,
    });
    if(!next||next.state.lifecycle!=='active') throw new MeetingLinkDataError('meeting-link authorization changed');
    commitStarted=true;
    await transaction.commit(); finished=true;
    return {state:next.state,idempotent:false};
  }catch(error){
    if(!finished){ try{ await transaction.rollback(); }catch{} }
    throw new MeetingAttemptError(error,commitStarted);
  }finally{ try{ await transaction.close?.(); }catch{} }
}

export async function mutateAuthorizedMeetingLink(db,{viewerId,mutation,versionKey}){
  if(!db||typeof db.transaction!=='function') throw new TypeError('transactional database client is required');
  let lastError;
  for(let attempt=1;attempt<=TRANSACTION_ATTEMPTS;attempt+=1){
    try{ return await mutateAttempt(db,{viewerId,mutation,versionKey}); }
    catch(attemptError){
      const error=attemptError instanceof MeetingAttemptError?attemptError.cause:attemptError;
      lastError=error;
      if(attemptError?.commitStarted||attempt===TRANSACTION_ATTEMPTS||!retryableConflict(error)) throw error;
      await retryDelay(attempt);
    }
  }
  throw lastError||new MeetingLinkDataError('meeting-link mutation failed');
}
