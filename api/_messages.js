import { parseCanonicalRoomPath } from './_pairing.js';

export const DEFAULT_MESSAGE_LIMIT=50;
export const MAX_MESSAGE_LIMIT=50;
export const MAX_MESSAGE_CODE_POINTS=2_000;
export const MAX_MESSAGE_BYTES=8_000;
export const MAX_MESSAGES_PER_USER_PER_MINUTE=20;
export const MAX_MESSAGES_PER_ROOM=10_000;
export const MESSAGE_RATE_RETRY_SECONDS=60;

const ALLOWED_QUERY_KEYS=new Set(['endpoint','room_id','after_id','limit']);
const ALLOWED_POST_QUERY_KEYS=new Set(['endpoint']);
const RFC3339_PATTERN=/^(\d{4})-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])T([01]\d|2[0-3]):([0-5]\d):([0-5]\d)(?:\.(\d{1,9}))?(Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/;
const SQLITE_UTC_PATTERN=/^(\d{4})-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01]) ([01]\d|2[0-3]):([0-5]\d):([0-5]\d)(?:\.(\d{1,9}))?$/;

export class MessageInputError extends Error{
  constructor(message,statusCode=400){
    super(message);
    this.name='MessageInputError';
    this.statusCode=statusCode;
  }
}

export class MessageDataError extends Error{
  constructor(message){
    super(message);
    this.name='MessageDataError';
  }
}

function isPlainObject(value){
  if(value===null||typeof value!=='object'||Array.isArray(value)) return false;
  const prototype=Object.getPrototypeOf(value);
  return prototype===Object.prototype||prototype===null;
}

function exactKeys(value,expected){
  if(!isPlainObject(value)) return false;
  const actual=Object.keys(value).sort();
  const wanted=[...expected].sort();
  return actual.length===wanted.length&&actual.every((key,index)=>key===wanted[index]);
}

function canonicalRoom(value){
  if(typeof value!=='string') return null;
  const parsed=parseCanonicalRoomPath(`/join/${value}`);
  return parsed?.roomId===value?parsed:null;
}

function strictInteger(value,{defaultValue,min,max}){
  if(value===undefined) return defaultValue;
  if(typeof value!=='string'||!/^(0|[1-9]\d*)$/.test(value)) return null;
  const parsed=Number(value);
  return Number.isSafeInteger(parsed)&&parsed>=min&&parsed<=max?parsed:null;
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

export function parseMessagesQuery(req){
  const query=requestQuery(req);
  if(Object.keys(query).some(key=>!ALLOWED_QUERY_KEYS.has(key))){
    throw new MessageInputError('unsupported query parameter');
  }
  if(Object.values(query).some(Array.isArray)){
    throw new MessageInputError('query parameters must be provided once');
  }
  if(query.endpoint!==undefined&&query.endpoint!=='messages'){
    throw new MessageInputError('unsupported messages endpoint');
  }
  const room=canonicalRoom(query.room_id);
  if(!room) throw new MessageInputError('canonical room_id required');
  const afterId=strictInteger(query.after_id,{defaultValue:0,min:0,max:Number.MAX_SAFE_INTEGER});
  if(afterId===null) throw new MessageInputError('after_id must be a safe non-negative integer');
  const limit=strictInteger(query.limit,{defaultValue:DEFAULT_MESSAGE_LIMIT,min:1,max:MAX_MESSAGE_LIMIT});
  if(limit===null) throw new MessageInputError(`limit must be an integer from 1 to ${MAX_MESSAGE_LIMIT}`);
  return {roomId:room.roomId,weekId:room.weekId,pairGroupId:room.pairGroupId,afterId,limit};
}

export function validateMessagesPostQuery(req){
  const query=requestQuery(req);
  if(Object.keys(query).some(key=>!ALLOWED_POST_QUERY_KEYS.has(key))){
    throw new MessageInputError('unsupported query parameter');
  }
  if(Object.values(query).some(Array.isArray)){
    throw new MessageInputError('query parameters must be provided once');
  }
  if(query.endpoint!==undefined&&query.endpoint!=='messages'){
    throw new MessageInputError('unsupported messages endpoint');
  }
  return true;
}

export function parseMessageSend(body){
  if(!exactKeys(body,['room_id','message'])){
    throw new MessageInputError('body must contain only room_id and message');
  }
  const room=canonicalRoom(body.room_id);
  if(!room) throw new MessageInputError('canonical room_id required');
  if(typeof body.message!=='string') throw new MessageInputError('message must be a string');
  const message=body.message.trim();
  if(!message) throw new MessageInputError('message required');
  if([...message].length>MAX_MESSAGE_CODE_POINTS||Buffer.byteLength(message,'utf8')>MAX_MESSAGE_BYTES){
    throw new MessageInputError('message too large',413);
  }
  return {roomId:room.roomId,weekId:room.weekId,pairGroupId:room.pairGroupId,message};
}

function isLeapYear(year){
  return year%4===0&&(year%100!==0||year%400===0);
}

function daysInMonth(year,month){
  if(month===2) return isLeapYear(year)?29:28;
  return [4,6,9,11].includes(month)?30:31;
}

export function normalizeMessageTimestamp(value){
  if(typeof value!=='string'||Buffer.byteLength(value,'utf8')>80) return null;
  const match=RFC3339_PATTERN.exec(value)||SQLITE_UTC_PATTERN.exec(value);
  if(!match||Number(match[3])>daysInMonth(Number(match[1]),Number(match[2]))) return null;
  const candidate=SQLITE_UTC_PATTERN.test(value)?value.replace(' ','T')+'Z':value;
  const epoch=Date.parse(candidate);
  if(!Number.isFinite(epoch)) return null;
  try{ return new Date(epoch).toISOString(); }
  catch{ return null; }
}

function positiveSafeInteger(value){
  const parsed=Number(value);
  return Number.isSafeInteger(parsed)&&parsed>0?parsed:null;
}

export function projectMessage(row){
  if(!row||typeof row!=='object') throw new MessageDataError('stored message is invalid');
  const id=positiveSafeInteger(row.id);
  const senderId=positiveSafeInteger(row.sender_id);
  const createdAt=normalizeMessageTimestamp(row.created_at);
  if(!id||!senderId||typeof row.message!=='string'||!createdAt){
    throw new MessageDataError('stored message is invalid');
  }
  if([...row.message].length>MAX_MESSAGE_CODE_POINTS||Buffer.byteLength(row.message,'utf8')>MAX_MESSAGE_BYTES){
    throw new MessageDataError('stored message is oversized');
  }
  const rawName=typeof row.sender_name==='string'?row.sender_name.trim():'';
  const senderName=[...(rawName||`User ${senderId}`)].slice(0,80).join('');
  return {id,sender_id:senderId,sender_name:senderName,message:row.message,created_at:createdAt};
}

const readinessByDatabaseUrl=new Map();
const readinessByClient=new WeakMap();

function readinessCache(db){
  const databaseUrl=String(process.env.TURSO_DATABASE_URL||'').trim();
  return databaseUrl?{cache:readinessByDatabaseUrl,key:databaseUrl}:{cache:readinessByClient,key:db};
}

async function probeMessagesSchema(db){
  await db.execute(`SELECT id,week_id,pair_group_id,sender_id,message,created_at FROM pair_messages LIMIT 0`);
  await db.execute(`SELECT id,display_name FROM auth_accounts LIMIT 0`);
}

export async function ensureMessagesReadiness(db){
  const {cache,key}=readinessCache(db);
  const existing=cache.get(key);
  if(existing) return existing;
  const pending=probeMessagesSchema(db);
  cache.set(key,pending);
  try{ return await pending; }
  catch(error){
    if(cache.get(key)===pending) cache.delete(key);
    throw error;
  }
}
