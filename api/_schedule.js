import { createHash } from 'node:crypto';

export const MAX_SCHEDULE_PROPOSALS=12;
const MAX_STORED_PROPOSALS=20;
const MAX_STORED_PROPOSALS_BYTES=32*1024;
const MAX_LEGACY_VALUE_BYTES=4*1024;
const MAX_AGREED_VALUE_BYTES=4*1024;
const MAX_UPDATED_AT_BYTES=128;
const OPAQUE_ID_PATTERN=/^[a-f0-9]{64}$/;
const RFC3339_PATTERN=/^(\d{4})-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])T([01]\d|2[0-3]):([0-5]\d):([0-5]\d)(?:\.(\d{1,9}))?(Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/;

export class ScheduleInputError extends Error {
  constructor(message){
    super(message);
    this.name='ScheduleInputError';
  }
}

export class ScheduleDataError extends Error {
  constructor(message){
    super(message);
    this.name='ScheduleDataError';
  }
}

function sha256(namespace,value){
  return createHash('sha256').update(`${namespace}\0${value}`,'utf8').digest('hex');
}

function byteLength(value){
  return Buffer.byteLength(String(value),'utf8');
}

function isLeapYear(year){
  return year%4===0 && (year%100!==0 || year%400===0);
}

function daysInMonth(year,month){
  if(month===2) return isLeapYear(year)?29:28;
  return [4,6,9,11].includes(month)?30:31;
}

export function normalizeScheduleInstant(value){
  if(typeof value!=='string' || byteLength(value)>80) return null;
  const match=RFC3339_PATTERN.exec(value);
  if(!match) return null;
  const year=Number(match[1]);
  const month=Number(match[2]);
  const day=Number(match[3]);
  if(day>daysInMonth(year,month)) return null;
  const epoch=Date.parse(value);
  if(!Number.isFinite(epoch)) return null;
  try{
    const normalized=new Date(epoch).toISOString();
    return RFC3339_PATTERN.test(normalized)?normalized:null;
  }catch{ return null; }
}

function positiveSafeInteger(value){
  const number=Number(value);
  return Number.isSafeInteger(number)&&number>0?number:null;
}

function exactKeys(value,expected){
  if(!value || typeof value!=='object' || Array.isArray(value)) return false;
  const actual=Object.keys(value).sort();
  const wanted=[...expected].sort();
  return actual.length===wanted.length && actual.every((key,index)=>key===wanted[index]);
}

function modernProposal(value){
  if(!exactKeys(value,['instant','proposed_by'])) return null;
  const instant=normalizeScheduleInstant(value.instant);
  const proposedBy=typeof value.proposed_by==='number'?positiveSafeInteger(value.proposed_by):null;
  if(!instant || instant!==value.instant || !proposedBy) return null;
  return {instant,proposed_by:proposedBy};
}

function proposalId(entry,legacyOccurrence=0){
  const identity=typeof entry==='string'
    ? JSON.stringify(['legacy',entry,legacyOccurrence])
    : JSON.stringify(['modern',entry.instant,entry.proposed_by]);
  return sha256('randori-schedule-proposal-v1',identity);
}

export function scheduleVersion({exists,rawProposedTimes,rawAgreedTime,rawUpdatedAt}){
  return sha256('randori-schedule-version-v1',JSON.stringify([
    exists===true,
    rawProposedTimes??null,
    rawAgreedTime??null,
    rawUpdatedAt??null,
  ]));
}

export function readScheduleState(row=null){
  if(!row){
    const state={exists:false,rawProposedTimes:null,rawAgreedTime:null,rawUpdatedAt:null,entries:[]};
    return {...state,version:scheduleVersion(state)};
  }
  const rawProposedTimes=row.proposed_times;
  const rawAgreedTime=row.agreed_time;
  const rawUpdatedAt=row.updated_at;
  if(rawProposedTimes!==null && rawProposedTimes!==undefined && typeof rawProposedTimes!=='string'){
    throw new ScheduleDataError('stored proposals are invalid');
  }
  if(rawAgreedTime!==null && rawAgreedTime!==undefined && typeof rawAgreedTime!=='string'){
    throw new ScheduleDataError('stored agreement is invalid');
  }
  if(rawUpdatedAt!==null && rawUpdatedAt!==undefined && typeof rawUpdatedAt!=='string'){
    throw new ScheduleDataError('stored schedule timestamp is invalid');
  }
  if(
    byteLength(rawProposedTimes||'')>MAX_STORED_PROPOSALS_BYTES
    || byteLength(rawAgreedTime||'')>MAX_AGREED_VALUE_BYTES
    || byteLength(rawUpdatedAt||'')>MAX_UPDATED_AT_BYTES
  ){
    throw new ScheduleDataError('stored schedule is oversized');
  }

  let parsed=[];
  if(rawProposedTimes!==null && rawProposedTimes!==undefined && rawProposedTimes!==''){
    try{ parsed=JSON.parse(rawProposedTimes); }
    catch{ throw new ScheduleDataError('stored proposals are invalid'); }
  }
  if(!Array.isArray(parsed) || parsed.length>MAX_STORED_PROPOSALS){
    throw new ScheduleDataError('stored proposals are invalid');
  }
  if(parsed.length>MAX_SCHEDULE_PROPOSALS && parsed.some(value=>typeof value!=='string')){
    throw new ScheduleDataError('stored proposals exceed the modern schedule limit');
  }
  const modernInstants=new Set();
  const entries=parsed.map(value=>{
    if(typeof value==='string'){
      if(byteLength(value)>MAX_LEGACY_VALUE_BYTES) throw new ScheduleDataError('stored legacy proposal is oversized');
      return value;
    }
    const modern=modernProposal(value);
    if(!modern || modernInstants.has(modern.instant)) throw new ScheduleDataError('stored modern proposal is invalid');
    modernInstants.add(modern.instant);
    return modern;
  });
  const state={
    exists:true,
    rawProposedTimes:rawProposedTimes??null,
    rawAgreedTime:rawAgreedTime??null,
    rawUpdatedAt:rawUpdatedAt??null,
    entries,
  };
  return {...state,version:scheduleVersion(state)};
}

export function projectSchedule(state){
  const legacyOccurrences=new Map();
  const proposals=state.entries.map(entry=>{
    if(typeof entry==='string'){
      const occurrence=legacyOccurrences.get(entry)||0;
      legacyOccurrences.set(entry,occurrence+1);
      return {
        proposal_id:proposalId(entry,occurrence),
        value:entry,
        instant:normalizeScheduleInstant(entry),
        proposed_by:null,
        legacy:true,
      };
    }
    return {
      proposal_id:proposalId(entry),
      value:entry.instant,
      instant:entry.instant,
      proposed_by:entry.proposed_by,
      legacy:false,
    };
  });
  const normalizedAgreement=normalizeScheduleInstant(state.rawAgreedTime);
  const agreedTime=normalizedAgreement&&normalizedAgreement===state.rawAgreedTime?normalizedAgreement:null;
  return {
    version:state.version,
    proposals,
    agreed_time:agreedTime,
    legacy_agreed_time:state.rawAgreedTime&&!agreedTime?state.rawAgreedTime:null,
    updated_at:state.rawUpdatedAt||null,
  };
}

export function parseScheduleMutation(body){
  if(!body || typeof body!=='object' || Array.isArray(body)) throw new ScheduleInputError('request body must be an object');
  const action=body.action;
  const keysByAction={
    propose:['room_id','action','base_version','instant'],
    remove:['room_id','action','base_version','proposal_id'],
    accept:['room_id','action','base_version','proposal_id'],
    clear:['room_id','action','base_version'],
  };
  const expected=keysByAction[action];
  if(!expected) throw new ScheduleInputError('unsupported schedule action');
  if(!exactKeys(body,expected)) throw new ScheduleInputError('unexpected or missing schedule fields');
  if(typeof body.room_id!=='string') throw new ScheduleInputError('canonical room_id required');
  if(typeof body.base_version!=='string' || !OPAQUE_ID_PATTERN.test(body.base_version)){
    throw new ScheduleInputError('valid base_version required');
  }
  if(action==='propose'){
    const instant=normalizeScheduleInstant(body.instant);
    if(!instant) throw new ScheduleInputError('instant must be strict RFC3339 with an explicit offset');
    return {action,roomId:body.room_id,baseVersion:body.base_version,instant};
  }
  if(action==='remove' || action==='accept'){
    if(typeof body.proposal_id!=='string' || !OPAQUE_ID_PATTERN.test(body.proposal_id)){
      throw new ScheduleInputError('valid proposal_id required');
    }
    return {action,roomId:body.room_id,baseVersion:body.base_version,proposalId:body.proposal_id};
  }
  return {action,roomId:body.room_id,baseVersion:body.base_version};
}

export function applyScheduleMutation(state,mutation,userId){
  const proposerId=positiveSafeInteger(userId);
  if(!proposerId) throw new ScheduleInputError('authenticated user required');
  const entries=[...state.entries];
  let agreedTime=state.rawAgreedTime??null;

  if(mutation.action==='propose'){
    if(entries.length>=MAX_SCHEDULE_PROPOSALS) throw new ScheduleInputError('schedule has the maximum 12 proposals');
    if(entries.some(entry=>
      (typeof entry==='string'?normalizeScheduleInstant(entry):entry.instant)===mutation.instant
    )){
      throw new ScheduleInputError('that instant is already proposed');
    }
    entries.push({instant:mutation.instant,proposed_by:proposerId});
  }else if(mutation.action==='remove' || mutation.action==='accept'){
    const projected=projectSchedule(state).proposals;
    const index=projected.findIndex(proposal=>proposal.proposal_id===mutation.proposalId);
    if(index<0) throw new ScheduleInputError('proposal not found');
    if(mutation.action==='remove') entries.splice(index,1);
    else{
      if(typeof entries[index]==='string') throw new ScheduleInputError('legacy proposals cannot be accepted');
      agreedTime=entries[index].instant;
    }
  }else if(mutation.action==='clear'){
    agreedTime=null;
  }else{
    throw new ScheduleInputError('unsupported schedule action');
  }

  const proposalsChanged=mutation.action==='propose'||mutation.action==='remove';
  return {
    proposedTimes:proposalsChanged?JSON.stringify(entries):(state.rawProposedTimes??JSON.stringify([])),
    agreedTime,
  };
}

export function nextScheduleUpdatedAt(previousValue,now=Date.now()){
  let currentEpoch=Number(now);
  if(!Number.isFinite(currentEpoch) || Number.isNaN(new Date(currentEpoch).getTime())) currentEpoch=Date.now();
  const previousEpoch=typeof previousValue==='string'?Date.parse(previousValue):Number.NaN;
  const nextEpoch=Number.isFinite(previousEpoch)?Math.max(currentEpoch,previousEpoch+1):currentEpoch;
  return new Date(nextEpoch).toISOString();
}
