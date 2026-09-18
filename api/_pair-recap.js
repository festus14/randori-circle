import { parseCanonicalRoomPath } from './_pairing.js';
import { normalizeMessageTimestamp, projectMessage } from './_messages.js';
import { normalizeScheduleInstant } from './_schedule.js';

export const MAX_RECAP_ACTIVITY=50;
export const MAX_RECAP_RUN_SCAN=500;

const ALLOWED_QUERY_KEYS=new Set(['endpoint','room_id']);
const QUESTION_SLUG_PATTERN=/^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const LANGUAGE_PATTERN=/^[a-z][a-z0-9_+-]{0,31}$/;

export class PairRecapInputError extends Error{
  constructor(message){
    super(message);
    this.name='PairRecapInputError';
  }
}

export class PairRecapDataError extends Error{
  constructor(message){
    super(message);
    this.name='PairRecapDataError';
  }
}

function byteLength(value){
  return Buffer.byteLength(String(value),'utf8');
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

function requiredText(value,{field,maxCodePoints,maxBytes=maxCodePoints*4}){
  if(typeof value!=='string') throw new PairRecapDataError(`stored ${field} is invalid`);
  const trimmed=value.trim();
  if(!trimmed||[...trimmed].length>maxCodePoints||byteLength(trimmed)>maxBytes){
    throw new PairRecapDataError(`stored ${field} is invalid`);
  }
  return trimmed;
}

function optionalText(value,options){
  if(value===null||value===undefined) return null;
  return requiredText(value,options);
}

function actor(idValue,nameValue){
  const id=positiveSafeInteger(idValue);
  if(!id) throw new PairRecapDataError('stored activity actor is invalid');
  const displayName=requiredText(nameValue,{field:'activity actor',maxCodePoints:80,maxBytes:320});
  return {id,display_name:displayName};
}

function normalizedStoredTimestamp(value,field){
  const normalized=normalizeMessageTimestamp(value);
  if(!normalized) throw new PairRecapDataError(`stored ${field} is invalid`);
  return normalized;
}

export function parsePairRecapQuery(req){
  const query=requestQuery(req);
  if(Object.keys(query).some(key=>!ALLOWED_QUERY_KEYS.has(key))){
    throw new PairRecapInputError('unsupported query parameter');
  }
  if(Object.values(query).some(Array.isArray)){
    throw new PairRecapInputError('query parameters must be provided once');
  }
  if(query.endpoint!==undefined&&query.endpoint!=='pair-recap'){
    throw new PairRecapInputError('unsupported pair recap endpoint');
  }
  if(typeof query.room_id!=='string') throw new PairRecapInputError('canonical room_id required');
  const room=parseCanonicalRoomPath(`/join/${query.room_id}`);
  if(!room||room.roomId!==query.room_id) throw new PairRecapInputError('canonical room_id required');
  return {roomId:room.roomId,weekId:room.weekId,pairGroupId:room.pairGroupId};
}

const readinessByDatabaseUrl=new Map();
const readinessByClient=new WeakMap();

function readinessCache(db){
  const databaseUrl=String(process.env.TURSO_DATABASE_URL||'').trim();
  return databaseUrl?{cache:readinessByDatabaseUrl,key:databaseUrl}:{cache:readinessByClient,key:db};
}

async function probePairRecapSchema(db){
  await db.execute(`SELECT id,week_id,user_a_id,user_b_id,user_c_id,is_ai_pair,topic,topic_kind FROM pairing_groups LIMIT 0`);
  await db.execute(`SELECT id,week_label,week_start FROM pairing_weeks LIMIT 0`);
  await db.execute(`SELECT id,display_name FROM auth_accounts LIMIT 0`);
  await db.execute(`SELECT id,name FROM users LIMIT 0`);
  await db.execute(`SELECT week_id,user_id,source FROM pairing_participants LIMIT 0`);
  await db.execute(`SELECT week_id,pair_group_id,agreed_time,updated_at FROM pair_schedules LIMIT 0`);
  await db.execute(`SELECT id,week_id,pair_group_id,sender_id,message,created_at FROM pair_messages LIMIT 0`);
  await db.execute(`SELECT id,user_id,week_id,pair_group_id,question_slug,language,test_cases_snapshot,results_json,passed_count,total_count,duration_ms,created_at FROM session_runs LIMIT 0`);
  await db.execute(`SELECT room_id,week_id,pair_group_id,revision,schema_version,language,question_id,updated_at FROM pair_room_snapshots LIMIT 0`);
}

export async function ensurePairRecapReadiness(db){
  const {cache,key}=readinessCache(db);
  const existing=cache.get(key);
  if(existing) return existing;
  const pending=probePairRecapSchema(db);
  cache.set(key,pending);
  try{ return await pending; }
  catch(error){
    if(cache.get(key)===pending) cache.delete(key);
    throw error;
  }
}

export function projectRecapPair(row,userIdValue){
  if(!row||typeof row!=='object') throw new PairRecapDataError('stored pair is invalid');
  const id=positiveSafeInteger(row.pair_id);
  const weekId=positiveSafeInteger(row.week_id);
  const userId=positiveSafeInteger(userIdValue);
  const isAiNumber=nonNegativeSafeInteger(row.is_ai_pair);
  if(!id||!weekId||!userId||![0,1].includes(isAiNumber)){
    throw new PairRecapDataError('stored pair is invalid');
  }
  const people=[
    [row.user_a_id,row.user_a_name],
    [row.user_b_id,row.user_b_name],
    [row.user_c_id,row.user_c_name],
  ];
  const seen=new Set();
  const members=[];
  for(const [rawId,rawName] of people){
    if(rawId===null||rawId===undefined) continue;
    const memberId=positiveSafeInteger(rawId);
    if(!memberId) throw new PairRecapDataError('stored pair member is invalid');
    if(seen.has(memberId)) continue;
    seen.add(memberId);
    members.push({
      id:memberId,
      display_name:requiredText(rawName,{field:'pair member',maxCodePoints:80,maxBytes:320}),
      is_me:memberId===userId,
      is_ai:false,
    });
  }
  if(!seen.has(userId)||(isAiNumber?members.length!==1:members.length<2)||members.length>3){
    throw new PairRecapDataError('stored pair membership is invalid');
  }
  if(isAiNumber){
    members.push({id:null,display_name:'AI partner',is_me:false,is_ai:true});
  }
  return {
    id,
    week_id:weekId,
    week_label:requiredText(row.week_label,{field:'week label',maxCodePoints:80,maxBytes:320}),
    week_start:normalizedStoredTimestamp(row.week_start,'week start'),
    topic:optionalText(row.topic,{field:'pair topic',maxCodePoints:200,maxBytes:800}),
    topic_kind:optionalText(row.topic_kind,{field:'pair topic kind',maxCodePoints:80,maxBytes:320}),
    is_ai:Boolean(isAiNumber),
    members,
  };
}

export function projectRecapSchedule(row){
  if(!row) return null;
  if(typeof row!=='object') throw new PairRecapDataError('stored schedule is invalid');
  const rawAgreement=row.agreed_time;
  if(rawAgreement!==null&&rawAgreement!==undefined&&typeof rawAgreement!=='string'){
    throw new PairRecapDataError('stored schedule agreement is invalid');
  }
  if(byteLength(rawAgreement||'')>4*1024){
    throw new PairRecapDataError('stored schedule agreement is invalid');
  }
  const normalizedAgreement=normalizeScheduleInstant(rawAgreement);
  const agreedTime=normalizedAgreement&&normalizedAgreement===rawAgreement?normalizedAgreement:null;
  return {
    agreed_time:agreedTime,
    legacy_agreed_time:rawAgreement&&!agreedTime?rawAgreement:null,
    updated_at:row.updated_at===null||row.updated_at===undefined
      ?null
      :normalizedStoredTimestamp(row.updated_at,'schedule timestamp'),
  };
}

export function projectRecapMessage(row){
  try{
    const projected=projectMessage(row);
    return {
      kind:'message',
      event_id:`message:${projected.id}`,
      created_at:projected.created_at,
      actor:{id:projected.sender_id,display_name:projected.sender_name},
      message:projected.message,
    };
  }catch{
    throw new PairRecapDataError('stored message is invalid');
  }
}

export function projectRecapRun(row,verifyAttestation){
  if(!row||typeof row!=='object') throw new PairRecapDataError('stored run is invalid');
  if(typeof row.test_cases_snapshot!=='string'||byteLength(row.test_cases_snapshot)>32*1024){
    return null;
  }
  let snapshot;
  try{ snapshot=JSON.parse(row.test_cases_snapshot); }
  catch{ return null; }
  const questionVersion=positiveSafeInteger(snapshot?.version);
  const snapshotTotal=nonNegativeSafeInteger(snapshot?.total_count);
  if(snapshot?.source!=='original-catalog'||snapshot?.attestation_version!==2||!questionVersion
    ||snapshotTotal===null||typeof verifyAttestation!=='function'){
    return null;
  }
  const id=positiveSafeInteger(row.id);
  const runActor=actor(row.user_id,row.runner_display_name);
  const questionSlug=requiredText(row.question_slug,{field:'run question',maxCodePoints:120,maxBytes:480});
  const language=requiredText(row.language,{field:'run language',maxCodePoints:32,maxBytes:128});
  const passedCount=nonNegativeSafeInteger(row.passed_count);
  const totalCount=nonNegativeSafeInteger(row.total_count);
  const durationMs=row.duration_ms===null||row.duration_ms===undefined?null:nonNegativeSafeInteger(row.duration_ms);
  const createdAt=normalizedStoredTimestamp(row.created_at,'run timestamp');
  if(!id||!QUESTION_SLUG_PATTERN.test(questionSlug)||!LANGUAGE_PATTERN.test(language)
    ||passedCount===null||totalCount===null||passedCount>totalCount||durationMs===null&&row.duration_ms!=null){
    throw new PairRecapDataError('stored run is invalid');
  }
  if(typeof row.results_json!=='string'||byteLength(row.results_json)>512*1024){
    throw new PairRecapDataError('stored run results are invalid');
  }
  if(snapshotTotal!==totalCount){
    return null;
  }
  const authoritative=verifyAttestation(snapshot.attestation,snapshot.attestation_key_id,{
    userId:runActor.id,
    questionSlug,
    questionVersion,
    language,
    passedCount,
    totalCount,
    resultsJson:row.results_json,
  });
  if(!authoritative) return null;
  return {
    kind:'run',
    event_id:`run:${id}`,
    created_at:createdAt,
    actor:runActor,
    question_slug:questionSlug,
    question_version:questionVersion,
    language,
    passed_count:passedCount,
    total_count:totalCount,
    duration_ms:durationMs,
    authoritative:true,
  };
}

export function projectRecapWorkspace(row){
  if(!row) return {artifact_available:false};
  if(typeof row!=='object') throw new PairRecapDataError('stored workspace is invalid');
  const revision=positiveSafeInteger(row.revision);
  const schemaVersion=positiveSafeInteger(row.schema_version);
  const language=requiredText(row.language,{field:'workspace language',maxCodePoints:32,maxBytes:128});
  if(!revision||!schemaVersion||schemaVersion>3||!LANGUAGE_PATTERN.test(language)){
    throw new PairRecapDataError('stored workspace is invalid');
  }
  if(typeof row.question_id!=='string'||byteLength(row.question_id)>160){
    throw new PairRecapDataError('stored workspace question is invalid');
  }
  const match=row.question_id.match(/^([a-z0-9]+(?:-[a-z0-9]+)*)(?:@([1-9]\d*))?$/);
  const questionVersion=match?.[2]===undefined?null:positiveSafeInteger(match[2]);
  if(!match||match[1].length>120||(match[2]!==undefined&&!questionVersion)){
    throw new PairRecapDataError('stored workspace question is invalid');
  }
  return {
    artifact_available:true,
    revision,
    schema_version:schemaVersion,
    question_slug:match[1],
    question_version:questionVersion,
    language,
    updated_at:normalizedStoredTimestamp(row.updated_at,'workspace timestamp'),
  };
}

function activitySourceId(event){
  const value=Number(String(event.event_id).split(':')[1]);
  if(!Number.isSafeInteger(value)||value<1) throw new PairRecapDataError('stored activity id is invalid');
  return value;
}

export function newestRecapActivity(messages,runs){
  if(!Array.isArray(messages)||!Array.isArray(runs)) throw new PairRecapDataError('stored activity is invalid');
  return [...messages,...runs]
    .sort((left,right)=>left.created_at.localeCompare(right.created_at)
      ||left.kind.localeCompare(right.kind)
      ||activitySourceId(left)-activitySourceId(right))
    .slice(-MAX_RECAP_ACTIVITY);
}
