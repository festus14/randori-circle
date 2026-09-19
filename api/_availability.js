import { createHash } from 'node:crypto';

import { validateActiveCircleMutationContext } from './_active-circle.js';
import { resolvePairingCycle } from './_pairing-cycle.js';

const CYCLE_KEY_PATTERN=/^[0-9a-f]{64}$/;
const SESSION_HASH_PATTERN=/^[0-9a-f]{64}$/;
const CYCLE_ID_PATTERN=/^\d{4}-W(?:0[1-9]|[1-4]\d|5[0-3])$/;
const DECISION_SOURCES=new Set(['user','legacy_bridge','cycle_default']);
const DEFAULT_SOURCES=new Set(['legacy_bridge','cycle_default']);
const TRANSACTION_ATTEMPTS=4;
const readinessByClient=new WeakMap();
const CYCLE_COLUMNS=Object.freeze([
  ['scope_key','TEXT',1,1],['circle_id','INTEGER',0,0],['cycle_key','TEXT',1,2],
  ['cycle_id','TEXT',1,0],['starts_at','TEXT',1,0],['ends_at','TEXT',1,0],
  ['cutoff_at','TEXT',1,0],['time_zone','TEXT',1,0],['default_source','TEXT',1,0],
  ['created_at','TEXT',1,0],
]);
const DECISION_COLUMNS=Object.freeze([
  ['scope_key','TEXT',1,1],['cycle_key','TEXT',1,2],['user_id','INTEGER',1,3],
  ['is_available','INTEGER',1,0],['version','INTEGER',1,0],
  ['decision_source','TEXT',1,0],['created_at','TEXT',1,0],['updated_at','TEXT',1,0],
]);
const CANDIDATE_INDEX_COLUMNS=Object.freeze(['scope_key','cycle_key','is_available','user_id']);

export const AVAILABILITY_CACHE_CONTROL='private, no-store';

export class AvailabilityError extends Error{
  constructor(code,message,{cause,details}={}){
    super(message,cause===undefined?undefined:{cause});
    this.name='AvailabilityError';
    this.code=code;
    if(details!==undefined) this.details=details;
  }
}

function fail(code,message,options){
  throw new AvailabilityError(code,message,options);
}

function positiveId(value,name='id'){
  if(!Number.isSafeInteger(value)||value<1){
    fail('AVAILABILITY_INPUT_INVALID',`${name} must be a positive safe integer.`);
  }
  return value;
}

function availabilityCircleContext(value,userId){
  if(value===null||value===undefined) return null;
  if(!value||typeof value!=='object'||Array.isArray(value)
    ||!value.payload||typeof value.payload!=='object'||Array.isArray(value.payload)
    ||typeof value.implicit!=='boolean'){
    fail('AVAILABILITY_INPUT_INVALID','Active circle context is invalid.');
  }
  const circleId=positiveId(value.circleId,'circleId');
  const contextVersion=value.contextVersion;
  const payloadUserId=Number(value.payload.id??value.payload.uid);
  const sessionHash=value.payload.sessionHash;
  if(!Number.isSafeInteger(contextVersion)||contextVersion<0||payloadUserId!==userId
    ||typeof sessionHash!=='string'||!SESSION_HASH_PATTERN.test(sessionHash)){
    fail('AVAILABILITY_INPUT_INVALID','Active circle context is invalid.');
  }
  return Object.freeze({payload:value.payload,circleId,contextVersion,implicit:value.implicit});
}

async function revalidateAvailabilityCircleContext(db,circleContext){
  if(!circleContext) return;
  let valid=false;
  try{ valid=await validateActiveCircleMutationContext(db,circleContext.payload,circleContext); }
  catch(error){
    if(error instanceof AvailabilityError) throw error;
    fail('AVAILABILITY_UNAVAILABLE','Availability is temporarily unavailable.',{cause:error});
  }
  if(!valid) fail('AVAILABILITY_CONTEXT_CHANGED','The active circle context changed.');
}

function validDatabase(db,{transaction=false}={}){
  if(!db||typeof db.execute!=='function'||typeof db.batch!=='function'
    ||(transaction&&typeof db.transaction!=='function')){
    fail('AVAILABILITY_INPUT_INVALID','A compatible database client is required.');
  }
  return db;
}

function normalizeInstant(value,code='AVAILABILITY_INPUT_INVALID'){
  const instant=value instanceof Date?new Date(value.getTime()):new Date(value);
  if(!Number.isFinite(instant.getTime())) fail(code,'Availability time is invalid.');
  return instant;
}

async function databaseNow(db){
  try{
    const result=await db.execute(`SELECT strftime('%Y-%m-%dT%H:%M:%fZ','now') AS now_utc`);
    return normalizeInstant(result.rows?.[0]?.now_utc,'AVAILABILITY_UNAVAILABLE');
  }catch(error){
    if(error instanceof AvailabilityError) throw error;
    fail('AVAILABILITY_UNAVAILABLE','Availability is temporarily unavailable.',{cause:error});
  }
}

async function observedNow(db,now){
  if(now===undefined) return databaseNow(db);
  try{
    const value=typeof now==='function'?await now(db):now;
    return normalizeInstant(value);
  }catch(error){
    if(error instanceof AvailabilityError) throw error;
    fail('AVAILABILITY_INPUT_INVALID','Availability time is invalid.',{cause:error});
  }
}

function canonicalCycle(value,{state}={}){
  if(!value||typeof value!=='object'||Array.isArray(value)){
    fail('AVAILABILITY_INPUT_INVALID','Pairing cycle is invalid.');
  }
  const cycle={
    cycleId:String(value.cycleId||''),
    startsAt:String(value.startsAt||''),
    endsAt:String(value.endsAt||''),
    cutoffAt:String(value.cutoffAt||''),
    timeZone:String(value.timeZone||''),
    state:String(value.state||''),
  };
  const startsAt=Date.parse(cycle.startsAt);
  const endsAt=Date.parse(cycle.endsAt);
  const cutoffAt=Date.parse(cycle.cutoffAt);
  if(!CYCLE_ID_PATTERN.test(cycle.cycleId)||!Number.isFinite(startsAt)||!Number.isFinite(endsAt)
    ||!Number.isFinite(cutoffAt)||cutoffAt>startsAt||startsAt>=endsAt
    ||new Date(startsAt).toISOString()!==cycle.startsAt
    ||new Date(endsAt).toISOString()!==cycle.endsAt
    ||new Date(cutoffAt).toISOString()!==cycle.cutoffAt
    ||!cycle.timeZone.trim()||cycle.timeZone!==cycle.timeZone.trim()||cycle.timeZone.length>100
    ||!['current','upcoming'].includes(cycle.state)||(state&&cycle.state!==state)){
    fail('AVAILABILITY_INPUT_INVALID','Pairing cycle is invalid.');
  }
  return Object.freeze(cycle);
}

function canonicalScope(value){
  if(!value||typeof value!=='object'||Array.isArray(value)){
    fail('AVAILABILITY_INPUT_INVALID','Availability scope is invalid.');
  }
  const kind=value.kind;
  if(kind==='local'){
    if(value.scopeKey!==undefined&&value.scopeKey!=='local'){
      fail('AVAILABILITY_INPUT_INVALID','Availability scope is invalid.');
    }
    return Object.freeze({kind:'local',scopeKey:'local',circleId:null});
  }
  if(kind!=='circle') fail('AVAILABILITY_INPUT_INVALID','Availability scope is invalid.');
  const circleId=positiveId(value.circleId,'circleId');
  const scopeKey=`circle:${circleId}`;
  if(value.scopeKey!==undefined&&value.scopeKey!==scopeKey){
    fail('AVAILABILITY_INPUT_INVALID','Availability scope is invalid.');
  }
  return Object.freeze({
    kind:'circle',scopeKey,circleId,
    ...(value.publicId===undefined?{}:{publicId:String(value.publicId).slice(0,128)}),
    ...(value.name===undefined?{}:{name:String(value.name).slice(0,120)}),
  });
}

/**
 * Stable across the upcoming -> current transition: state is deliberately not
 * identity, while every scheduling boundary and the tenant scope are.
 */
export function availabilityCycleKey(scope,cycle){
  const safeScope=canonicalScope(scope);
  const safeCycle=canonicalCycle(cycle);
  return createHash('sha256').update(JSON.stringify([
    'randori-availability-cycle-v1',safeScope.scopeKey,safeCycle.cycleId,
    safeCycle.startsAt,safeCycle.endsAt,safeCycle.cutoffAt,safeCycle.timeZone,
  ])).digest('hex');
}

export function resolveEditableAvailabilityCycle({now,timeZone}={}){
  try{ return canonicalCycle(resolvePairingCycle({now,timeZone,state:'upcoming'}),{state:'upcoming'}); }
  catch(error){
    if(error instanceof AvailabilityError) throw error;
    fail('AVAILABILITY_INPUT_INVALID','Availability cycle options are invalid.',{cause:error});
  }
}

export function parseAvailabilityMutation(body){
  if(!body||typeof body!=='object'||Array.isArray(body)){
    fail('AVAILABILITY_INPUT_INVALID','Request body must be an object.');
  }
  const keys=Object.keys(body).sort();
  const expected=['cycle_key','expected_version','is_available'];
  if(keys.length!==expected.length||!keys.every((key,index)=>key===expected[index])){
    fail('AVAILABILITY_INPUT_INVALID','Request body must contain only cycle_key, expected_version, and is_available.');
  }
  if(typeof body.cycle_key!=='string'||!CYCLE_KEY_PATTERN.test(body.cycle_key)){
    fail('AVAILABILITY_INPUT_INVALID','cycle_key is invalid.');
  }
  if(!Number.isSafeInteger(body.expected_version)||body.expected_version<0){
    fail('AVAILABILITY_INPUT_INVALID','expected_version must be a non-negative integer.');
  }
  if(typeof body.is_available!=='boolean'){
    fail('AVAILABILITY_INPUT_INVALID','is_available must be a boolean.');
  }
  return Object.freeze({
    cycleKey:body.cycle_key,
    expectedVersion:body.expected_version,
    isAvailable:body.is_available,
  });
}

export async function ensureAvailabilityReadiness(db){
  validDatabase(db);
  const existing=readinessByClient.get(db);
  if(existing) return existing;
  const pending=(async()=>{
    await db.execute(`SELECT scope_key,circle_id,cycle_key,cycle_id,starts_at,ends_at,cutoff_at,time_zone,default_source,created_at FROM pairing_cycles LIMIT 0`);
    await db.execute(`SELECT scope_key,cycle_key,user_id,is_available,version,decision_source,created_at,updated_at FROM pairing_cycle_availability LIMIT 0`);
    const cycleInfo=await db.execute(`PRAGMA table_info('pairing_cycles')`);
    const decisionInfo=await db.execute(`PRAGMA table_info('pairing_cycle_availability')`);
    const indexList=await db.execute(`PRAGMA index_list('pairing_cycle_availability')`);
    const indexInfo=await db.execute(`PRAGMA index_info('idx_pairing_cycle_availability_candidates')`);
    const columnsMatch=(rows,expected)=>rows.length===expected.length&&expected.every((item,index)=>{
      const row=rows[index];
      return String(row?.name)===item[0]&&String(row?.type).toUpperCase()===item[1]
        &&Number(row?.notnull)===item[2]&&Number(row?.pk)===item[3];
    });
    const candidateIndex=(indexList.rows||[]).find(row=>String(row.name)==='idx_pairing_cycle_availability_candidates');
    const indexColumns=[...(indexInfo.rows||[])]
      .sort((left,right)=>Number(left.seqno)-Number(right.seqno)).map(row=>String(row.name));
    if(!columnsMatch(cycleInfo.rows||[],CYCLE_COLUMNS)
      ||!columnsMatch(decisionInfo.rows||[],DECISION_COLUMNS)
      ||!candidateIndex||Number(candidateIndex.unique)!==0||Number(candidateIndex.partial||0)!==0
      ||JSON.stringify(indexColumns)!==JSON.stringify(CANDIDATE_INDEX_COLUMNS)){
      fail('AVAILABILITY_SCHEMA_UNAVAILABLE','Availability schema is unavailable.');
    }
    return true;
  })();
  readinessByClient.set(db,pending);
  try{ return await pending; }
  catch(error){
    if(readinessByClient.get(db)===pending) readinessByClient.delete(db);
    if(error instanceof AvailabilityError) throw error;
    fail('AVAILABILITY_SCHEMA_UNAVAILABLE','Availability schema is unavailable.',{cause:error});
  }
}

function legacyAvailability(value){
  if(value===null||value===undefined) return true;
  if(value===true||value===1||value===1n) return true;
  if(value===false||value===0||value===0n) return false;
  fail('AVAILABILITY_INTEGRITY','Legacy availability is invalid.');
}

/** Caller must derive localRuntime from the strict loopback/file-runtime guard. */
export async function resolveAvailabilityScope(db,{userId,localRuntime=false,circleContext=null}={}){
  validDatabase(db);
  const id=positiveId(userId,'userId');
  if(typeof localRuntime!=='boolean') fail('AVAILABILITY_INPUT_INVALID','localRuntime must be a boolean.');
  const context=availabilityCircleContext(circleContext,id);
  if(localRuntime&&context) fail('AVAILABILITY_INPUT_INVALID','Local availability cannot use a circle context.');
  let result;
  try{
    result=await db.execute(localRuntime?{
      sql:`SELECT id,is_available FROM auth_accounts
        WHERE id=? AND COALESCE(is_demo,0)=0 LIMIT 2`,args:[id],
    }:context?{
      sql:`SELECT account.id,account.is_available,circle.id AS circle_id,
          circle.public_id AS circle_public_id,circle.name AS circle_name,circle.is_primary
        FROM auth_accounts account
        JOIN circle_memberships membership ON membership.user_id=account.id
        JOIN circles circle ON circle.id=membership.circle_id
        WHERE account.id=? AND COALESCE(account.is_demo,0)=0
          AND membership.circle_id=? AND membership.status='active'
          AND circle.archived_at IS NULL
        LIMIT 2`,args:[id,context.circleId],
    }:{
      sql:`SELECT account.id,account.is_available,circle.id AS circle_id,
          circle.public_id AS circle_public_id,circle.name AS circle_name,circle.is_primary
        FROM auth_accounts account
        JOIN circle_memberships membership ON membership.user_id=account.id
        JOIN circles circle ON circle.id=membership.circle_id
        WHERE account.id=? AND COALESCE(account.is_demo,0)=0
          AND membership.status='active'
          AND circle.is_primary=1 AND circle.archived_at IS NULL
        LIMIT 2`,args:[id],
    });
  }catch(error){
    fail('AVAILABILITY_UNAVAILABLE','Availability is temporarily unavailable.',{cause:error});
  }
  const rows=result.rows||[];
  if(rows.length!==1) fail('AVAILABILITY_FORBIDDEN','Active circle membership is required.');
  const row=rows[0];
  const scope=localRuntime?canonicalScope({kind:'local'}):canonicalScope({
    kind:'circle',circleId:Number(row.circle_id),publicId:row.circle_public_id,name:row.circle_name,
  });
  return Object.freeze({...scope,userId:id,legacyIsAvailable:legacyAvailability(row.is_available),
    bridgeLegacyAvailability:localRuntime||Number(row.is_primary)===1,
  });
}

export async function resolveAvailabilityPublicationScope(db,{localRuntime=false}={}){
  validDatabase(db);
  if(typeof localRuntime!=='boolean') fail('AVAILABILITY_INPUT_INVALID','localRuntime must be a boolean.');
  if(localRuntime) return canonicalScope({kind:'local'});
  let result;
  try{
    result=await db.execute(`SELECT id,public_id,name FROM circles
      WHERE is_primary=1 AND archived_at IS NULL ORDER BY id LIMIT 2`);
  }catch(error){
    fail('AVAILABILITY_UNAVAILABLE','Availability is temporarily unavailable.',{cause:error});
  }
  if((result.rows||[]).length!==1){
    fail('AVAILABILITY_INTEGRITY','The primary-circle scope is invalid.');
  }
  const row=result.rows[0];
  return canonicalScope({kind:'circle',circleId:Number(row.id),publicId:row.public_id,name:row.name});
}

function validateCycleRow(row,scope,cycle,cycleKey){
  if(!row||String(row.scope_key)!==scope.scopeKey||String(row.cycle_key)!==cycleKey
    ||String(row.cycle_id)!==cycle.cycleId||String(row.starts_at)!==cycle.startsAt
    ||String(row.ends_at)!==cycle.endsAt||String(row.cutoff_at)!==cycle.cutoffAt
    ||String(row.time_zone)!==cycle.timeZone||!DEFAULT_SOURCES.has(String(row.default_source))
    ||(scope.kind==='local'?row.circle_id!==null:Number(row.circle_id)!==scope.circleId)){
    fail('AVAILABILITY_INTEGRITY','Stored availability cycle is invalid.');
  }
  return Object.freeze({
    scopeKey:scope.scopeKey,circleId:scope.circleId,cycleKey,cycle,
    defaultSource:String(row.default_source),
  });
}

export async function materializeAvailabilityCycle(db,{scope,cycle,bridgeLegacyAvailability=true}){
  validDatabase(db);
  if(typeof bridgeLegacyAvailability!=='boolean'){
    fail('AVAILABILITY_INPUT_INVALID','Availability default policy is invalid.');
  }
  const safeScope=canonicalScope(scope);
  const safeCycle=canonicalCycle(cycle);
  const cycleKey=availabilityCycleKey(safeScope,safeCycle);
  const select={
    sql:`SELECT scope_key,circle_id,cycle_key,cycle_id,starts_at,ends_at,cutoff_at,time_zone,default_source
      FROM pairing_cycles WHERE scope_key=? AND cycle_key=?`,
    args:[safeScope.scopeKey,cycleKey],
  };
  let result;
  try{ result=await db.execute(select); }
  catch(error){ fail('AVAILABILITY_UNAVAILABLE','Availability is temporarily unavailable.',{cause:error}); }
  if((result.rows||[]).length>1) fail('AVAILABILITY_INTEGRITY','Stored availability cycle is invalid.');
  if(result.rows?.length===1){
    const record=validateCycleRow(result.rows[0],safeScope,safeCycle,cycleKey);
    if(!bridgeLegacyAvailability&&record.defaultSource==='legacy_bridge'){
      fail('AVAILABILITY_INTEGRITY','Secondary-circle availability cannot use a legacy default.');
    }
    return record;
  }
  try{
    await db.execute({
      sql:`INSERT INTO pairing_cycles
          (scope_key,circle_id,cycle_key,cycle_id,starts_at,ends_at,cutoff_at,time_zone,default_source)
        SELECT ?,?,?,?,?,?,?,?,
          CASE WHEN ?=0 OR EXISTS (
            SELECT 1 FROM pairing_cycles WHERE scope_key=? AND starts_at<=?
          )
            THEN 'cycle_default' ELSE 'legacy_bridge' END
        ON CONFLICT(scope_key,cycle_key) DO NOTHING`,
      args:[safeScope.scopeKey,safeScope.circleId,cycleKey,safeCycle.cycleId,safeCycle.startsAt,
        safeCycle.endsAt,safeCycle.cutoffAt,safeCycle.timeZone,bridgeLegacyAvailability?1:0,
        safeScope.scopeKey,safeCycle.startsAt],
    });
    result=await db.execute(select);
  }catch(error){
    fail('AVAILABILITY_UNAVAILABLE','Availability is temporarily unavailable.',{cause:error});
  }
  if((result.rows||[]).length!==1){
    fail('AVAILABILITY_INTEGRITY','Availability cycle could not be materialized.');
  }
  const record=validateCycleRow(result.rows[0],safeScope,safeCycle,cycleKey);
  if(!bridgeLegacyAvailability&&record.defaultSource==='legacy_bridge'){
    fail('AVAILABILITY_INTEGRITY','Secondary-circle availability cannot use a legacy default.');
  }
  return record;
}

function validateDecision(row,userId){
  const id=positiveId(Number(row.user_id),'stored userId');
  const version=Number(row.version);
  const rawAvailable=Number(row.is_available);
  const source=String(row.decision_source||'');
  if(id!==userId||!Number.isSafeInteger(version)||version<1||![0,1].includes(rawAvailable)
    ||!DECISION_SOURCES.has(source)||!String(row.created_at||'')||!String(row.updated_at||'')){
    fail('AVAILABILITY_INTEGRITY','Stored availability decision is invalid.');
  }
  return Object.freeze({
    userId:id,isAvailable:rawAvailable===1,version,source,
    createdAt:String(row.created_at),updatedAt:String(row.updated_at),
  });
}

async function readDecision(db,cycleRecord,userId){
  let result;
  try{
    result=await db.execute({
      sql:`SELECT user_id,is_available,version,decision_source,created_at,updated_at
        FROM pairing_cycle_availability
        WHERE scope_key=? AND cycle_key=? AND user_id=?`,
      args:[cycleRecord.scopeKey,cycleRecord.cycleKey,userId],
    });
  }catch(error){ fail('AVAILABILITY_UNAVAILABLE','Availability is temporarily unavailable.',{cause:error}); }
  if((result.rows||[]).length>1) fail('AVAILABILITY_INTEGRITY','Stored availability decision is invalid.');
  return result.rows?.length?validateDecision(result.rows[0],userId):null;
}

function availabilityState({cycleRecord,decision,legacyIsAvailable,now}){
  const inherited=cycleRecord.defaultSource==='legacy_bridge'
    ?legacyIsAvailable
    :true;
  const cutoff=Date.parse(cycleRecord.cycle.cutoffAt);
  return Object.freeze({
    cycle:cycleRecord.cycle,
    cycleKey:cycleRecord.cycleKey,
    isAvailable:decision?decision.isAvailable:inherited,
    version:decision?decision.version:0,
    source:decision?decision.source:cycleRecord.defaultSource,
    editable:now.getTime()<cutoff,
    updatedAt:decision?.updatedAt||null,
  });
}

function isRetryableConflict(error){
  let current=error;
  for(let depth=0;current&&depth<5;depth+=1){
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

async function withWriteTransaction(db,operation){
  validDatabase(db,{transaction:true});
  let lastError;
  for(let attempt=1;attempt<=TRANSACTION_ATTEMPTS;attempt+=1){
    let transaction=null;
    let commitStarted=false;
    try{
      transaction=await db.transaction('write');
      const result=await operation(transaction);
      commitStarted=true;
      await transaction.commit();
      return result;
    }catch(error){
      lastError=error;
      if(transaction){ try{ await transaction.rollback(); }catch{} }
      if(commitStarted||attempt===TRANSACTION_ATTEMPTS||!isRetryableConflict(error)) throw error;
      await retryDelay(attempt);
    }finally{
      try{ await transaction?.close?.(); }catch{}
    }
  }
  throw lastError||new Error('availability transaction failed');
}

function safeState(state){
  const cycle=state.cycle||{};
  return Object.freeze({
    cycle:Object.freeze({
      cycleId:String(cycle.cycleId||''),startsAt:String(cycle.startsAt||''),
      endsAt:String(cycle.endsAt||''),cutoffAt:String(cycle.cutoffAt||''),
      timeZone:String(cycle.timeZone||''),state:String(cycle.state||''),
    }),
    cycleKey:state.cycleKey,
    isAvailable:state.isAvailable,
    version:state.version,
    source:state.source,
    editable:state.editable,
    updatedAt:state.updatedAt,
  });
}

async function stateForCycle(db,{scope,cycle,legacyIsAvailable,now}){
  const cycleRecord=await materializeAvailabilityCycle(db,{
    scope,cycle,bridgeLegacyAvailability:scope.bridgeLegacyAvailability!==false,
  });
  const decision=await readDecision(db,cycleRecord,scope.userId);
  return availabilityState({cycleRecord,decision,legacyIsAvailable,now});
}

export function availabilityResponse(state,{circleContextVersion}={}){
  return Object.freeze({ok:true,availability:safeState(state),
    ...(circleContextVersion===undefined?{}:{circle_context_version:circleContextVersion}),
  });
}

export function availabilityFailure(error,{circleContextVersion}={}){
  const code=error instanceof AvailabilityError?error.code:'AVAILABILITY_UNAVAILABLE';
  const context=circleContextVersion===undefined?{}:{circle_context_version:circleContextVersion};
  if(code==='AVAILABILITY_INPUT_INVALID') return {status:400,body:{ok:false,error:'availability_input_invalid',...context}};
  if(code==='AVAILABILITY_FORBIDDEN') return {status:403,body:{ok:false,error:'active circle membership required',...context}};
  if(code==='AVAILABILITY_CONTEXT_CHANGED') return {
    status:409,body:{ok:false,error:'circle context changed',code:'circle_context_changed'},
  };
  if(code==='AVAILABILITY_STALE') return {
    status:409,body:{ok:false,error:'availability_stale',availability:safeState(error.details.state),...context},
  };
  if(code==='AVAILABILITY_CUTOFF_CLOSED') return {
    status:409,body:{ok:false,error:'availability_cutoff_closed',availability:safeState(error.details.state),...context},
  };
  if(code==='AVAILABILITY_CYCLE_CHANGED') return {
    status:409,body:{ok:false,error:'availability_cycle_changed',availability:safeState(error.details.state),...context},
  };
  return {status:503,body:{ok:false,error:'availability unavailable',...context}};
}

export async function getAvailabilityState(db,{userId,localRuntime=false,now,timeZone,circleContext=null}={}){
  try{
    await ensureAvailabilityReadiness(db);
    return await withWriteTransaction(db,async transaction=>{
      const context=availabilityCircleContext(circleContext,positiveId(userId,'userId'));
      await revalidateAvailabilityCircleContext(transaction,context);
      const instant=await observedNow(transaction,now);
      const scope=await resolveAvailabilityScope(transaction,{userId,localRuntime,circleContext:context});
      const cycle=resolveEditableAvailabilityCycle({now:instant,timeZone});
      return stateForCycle(transaction,{scope,cycle,legacyIsAvailable:scope.legacyIsAvailable,now:instant});
    });
  }catch(error){
    if(error instanceof AvailabilityError) throw error;
    fail('AVAILABILITY_UNAVAILABLE','Availability is temporarily unavailable.',{cause:error});
  }
}

function writeAuthorization(scope,userId,circleContext){
  if(scope.kind==='local') return {
    sql:`EXISTS (SELECT 1 FROM auth_accounts account
      WHERE account.id=? AND COALESCE(account.is_demo,0)=0)`,args:[userId],
  };
  if(circleContext){
    const contextPredicate=circleContext.implicit
      ?`NOT EXISTS (SELECT 1 FROM auth_session_circle_contexts context
            WHERE context.session_hash=session.session_hash AND context.user_id=session.user_id)
          AND NOT EXISTS (
            SELECT 1 FROM circle_memberships other_membership
            JOIN circles other_circle ON other_circle.id=other_membership.circle_id
            WHERE other_membership.user_id=session.user_id
              AND other_membership.status='active' AND other_circle.archived_at IS NULL
              AND other_membership.circle_id<>membership.circle_id
          )`
      :`EXISTS (SELECT 1 FROM auth_session_circle_contexts context
            WHERE context.session_hash=session.session_hash AND context.user_id=session.user_id
              AND context.circle_id=membership.circle_id AND context.context_version=?)`;
    return {
      sql:`EXISTS (SELECT 1 FROM auth_sessions session
        JOIN auth_accounts account ON account.id=session.user_id
        JOIN circle_memberships membership ON membership.user_id=session.user_id
        JOIN circles circle ON circle.id=membership.circle_id
        WHERE session.session_hash=? AND session.user_id=? AND session.revoked_at IS NULL
          AND session.expires_at>CAST(strftime('%s','now') AS INTEGER)
          AND account.id=? AND COALESCE(account.is_demo,0)=0
          AND membership.circle_id=? AND membership.status='active' AND circle.archived_at IS NULL
          AND ${contextPredicate})`,
      args:circleContext.implicit
        ?[circleContext.payload.sessionHash,userId,userId,scope.circleId]
        :[circleContext.payload.sessionHash,userId,userId,scope.circleId,circleContext.contextVersion],
    };
  }
  return {
    sql:`EXISTS (SELECT 1 FROM auth_accounts account
      JOIN circle_memberships membership ON membership.user_id=account.id
      JOIN circles circle ON circle.id=membership.circle_id
      WHERE account.id=? AND COALESCE(account.is_demo,0)=0
        AND membership.circle_id=? AND membership.status='active'
        AND circle.is_primary=1 AND circle.archived_at IS NULL)`,
    args:[userId,scope.circleId],
  };
}

async function classifyFailedMutation(transaction,{
  scope,userId,localRuntime,cycle,mutation,timeZone,circleContext,
}){
  await revalidateAvailabilityCircleContext(transaction,circleContext);
  const checkedAt=await databaseNow(transaction);
  const checkedScope=await resolveAvailabilityScope(transaction,{userId,localRuntime,circleContext});
  const editableCycle=resolveEditableAvailabilityCycle({now:checkedAt,timeZone});
  const editableKey=availabilityCycleKey(checkedScope,editableCycle);
  if(checkedAt.getTime()>=Date.parse(cycle.cutoffAt)||editableKey!==mutation.cycleKey
    ||checkedScope.scopeKey!==scope.scopeKey){
    const state=await stateForCycle(transaction,{
      scope:checkedScope,cycle:editableCycle,
      legacyIsAvailable:checkedScope.legacyIsAvailable,now:checkedAt,
    });
    const current=canonicalCycle(resolvePairingCycle({now:checkedAt,timeZone,state:'current'}),{state:'current'});
    const code=mutation.cycleKey===availabilityCycleKey(checkedScope,current)
      ||checkedAt.getTime()>=Date.parse(cycle.cutoffAt)
      ?'AVAILABILITY_CUTOFF_CLOSED':'AVAILABILITY_CYCLE_CHANGED';
    fail(code,code==='AVAILABILITY_CUTOFF_CLOSED'
      ?'Availability cutoff has closed.':'The editable availability cycle changed.',{details:{state}});
  }
  const cycleRecord=await materializeAvailabilityCycle(transaction,{
    scope:checkedScope,cycle,
    bridgeLegacyAvailability:checkedScope.bridgeLegacyAvailability!==false,
  });
  const latest=await readDecision(transaction,cycleRecord,userId);
  if((latest?.version||0)!==mutation.expectedVersion){
    fail('AVAILABILITY_STALE','Availability was changed by another request.',{
      details:{state:availabilityState({
        cycleRecord,decision:latest,legacyIsAvailable:checkedScope.legacyIsAvailable,now:checkedAt,
      })},
    });
  }
  fail('AVAILABILITY_INTEGRITY','Availability mutation did not commit.');
}

export async function updateAvailability(db,{userId,localRuntime=false,body,now,timeZone,circleContext=null}={}){
  const mutation=parseAvailabilityMutation(body);
  try{
    await ensureAvailabilityReadiness(db);
    return await withWriteTransaction(db,async transaction=>{
      const context=availabilityCircleContext(circleContext,positiveId(userId,'userId'));
      await revalidateAvailabilityCircleContext(transaction,context);
      const instant=await observedNow(transaction,now);
      const scope=await resolveAvailabilityScope(transaction,{userId,localRuntime,circleContext:context});
      const cycle=resolveEditableAvailabilityCycle({now:instant,timeZone});
      const cycleKey=availabilityCycleKey(scope,cycle);
      if(mutation.cycleKey!==cycleKey){
        const current=canonicalCycle(resolvePairingCycle({now:instant,timeZone,state:'current'}),{state:'current'});
        const state=await stateForCycle(transaction,{
          scope,cycle,legacyIsAvailable:scope.legacyIsAvailable,now:instant,
        });
        const details={state};
        if(mutation.cycleKey===availabilityCycleKey(scope,current)){
          fail('AVAILABILITY_CUTOFF_CLOSED','Availability cutoff has closed.',{details});
        }
        fail('AVAILABILITY_CYCLE_CHANGED','The editable availability cycle changed.',{details});
      }
      if(instant.getTime()>=Date.parse(cycle.cutoffAt)){
        const state=await stateForCycle(transaction,{
          scope,cycle,legacyIsAvailable:scope.legacyIsAvailable,now:instant,
        });
        fail('AVAILABILITY_CUTOFF_CLOSED','Availability cutoff has closed.',{
          details:{state},
        });
      }
      const cycleRecord=await materializeAvailabilityCycle(transaction,{
        scope,cycle,bridgeLegacyAvailability:scope.bridgeLegacyAvailability!==false,
      });
      const existing=await readDecision(transaction,cycleRecord,scope.userId);
      const actualVersion=existing?.version||0;
      if(actualVersion!==mutation.expectedVersion){
        fail('AVAILABILITY_STALE','Availability was changed by another request.',{
          details:{state:availabilityState({
            cycleRecord,decision:existing,legacyIsAvailable:scope.legacyIsAvailable,now:instant,
          })},
        });
      }
      const authorization=writeAuthorization(scope,scope.userId,context);
      const cutoffSeconds=Math.floor(Date.parse(cycle.cutoffAt)/1000);
      let result;
      if(actualVersion===0){
        result=await transaction.execute({
          sql:`INSERT INTO pairing_cycle_availability
              (scope_key,cycle_key,user_id,is_available,version,decision_source,created_at,updated_at)
            SELECT ?,?,?,?,1,'user',?,?
            WHERE ?<? AND CAST(strftime('%s','now') AS INTEGER)<? AND ${authorization.sql}
            ON CONFLICT(scope_key,cycle_key,user_id) DO NOTHING
            RETURNING user_id,is_available,version,decision_source,created_at,updated_at`,
          args:[cycleRecord.scopeKey,cycleRecord.cycleKey,scope.userId,mutation.isAvailable?1:0,
            instant.toISOString(),instant.toISOString(),instant.getTime(),Date.parse(cycle.cutoffAt),cutoffSeconds,
            ...authorization.args],
        });
      }else{
        result=await transaction.execute({
          sql:`UPDATE pairing_cycle_availability
            SET is_available=?,version=version+1,decision_source='user',updated_at=?
            WHERE scope_key=? AND cycle_key=? AND user_id=? AND version=?
              AND ?<? AND CAST(strftime('%s','now') AS INTEGER)<? AND ${authorization.sql}
            RETURNING user_id,is_available,version,decision_source,created_at,updated_at`,
          args:[mutation.isAvailable?1:0,instant.toISOString(),cycleRecord.scopeKey,
            cycleRecord.cycleKey,scope.userId,mutation.expectedVersion,
            instant.getTime(),Date.parse(cycle.cutoffAt),cutoffSeconds,...authorization.args],
        });
      }
      if((result.rows||[]).length!==1){
        await classifyFailedMutation(transaction,{
          scope,userId:scope.userId,localRuntime,cycle,mutation,timeZone,circleContext:context,
        });
      }
      const decision=validateDecision(result.rows[0],scope.userId);
      return availabilityState({cycleRecord,decision,legacyIsAvailable:mutation.isAvailable,now:instant});
    });
  }catch(error){
    if(error instanceof AvailabilityError) throw error;
    fail('AVAILABILITY_UNAVAILABLE','Availability is temporarily unavailable.',{cause:error});
  }
}

/** Apply exact per-cycle decisions to an already tenant-filtered account set. */
export async function applyCycleAvailability(db,{scope,cycle,accounts,bridgeLegacyAvailability=true}={}){
  validDatabase(db);
  await ensureAvailabilityReadiness(db);
  const safeScope=canonicalScope(scope);
  const safeCycle=canonicalCycle(cycle);
  if(!Array.isArray(accounts)) fail('AVAILABILITY_INPUT_INVALID','accounts must be an array.');
  const seen=new Set();
  const normalized=accounts.map(account=>{
    if(!account||typeof account!=='object'||Array.isArray(account)){
      fail('AVAILABILITY_INPUT_INVALID','accounts must contain objects.');
    }
    const id=positiveId(account.id,'account id');
    if(seen.has(id)) fail('AVAILABILITY_INPUT_INVALID','accounts must be unique.');
    seen.add(id);
    return {...account,id};
  });
  if(typeof bridgeLegacyAvailability!=='boolean'){
    fail('AVAILABILITY_INPUT_INVALID','bridgeLegacyAvailability must be a boolean.');
  }
  const cycleRecord=await materializeAvailabilityCycle(db,{
    scope:safeScope,cycle:safeCycle,bridgeLegacyAvailability,
  });
  if(!normalized.length) return Object.freeze([]);
  const placeholders=normalized.map(()=>'?').join(',');
  let result;
  try{
    result=await db.execute({
      sql:`SELECT user_id,is_available,version,decision_source,created_at,updated_at
        FROM pairing_cycle_availability
        WHERE scope_key=? AND cycle_key=? AND user_id IN (${placeholders})
        ORDER BY user_id`,
      args:[safeScope.scopeKey,cycleRecord.cycleKey,...normalized.map(account=>account.id)],
    });
  }catch(error){ fail('AVAILABILITY_UNAVAILABLE','Availability is temporarily unavailable.',{cause:error}); }
  const decisions=new Map();
  for(const row of result.rows||[]){
    const userId=Number(row.user_id);
    if(!seen.has(userId)||decisions.has(userId)){
      fail('AVAILABILITY_INTEGRITY','Stored availability decision is invalid.');
    }
    decisions.set(userId,validateDecision(row,userId));
  }
  return Object.freeze(normalized.map(account=>{
    const decision=decisions.get(account.id);
    const inherited=cycleRecord.defaultSource==='legacy_bridge'
      ?legacyAvailability(account.is_available)
      :true;
    return Object.freeze({
      ...account,
      isAvailable:decision?decision.isAvailable:inherited,
      availabilityVersion:decision?.version||0,
      availabilitySource:decision?.source||cycleRecord.defaultSource,
      cycleKey:cycleRecord.cycleKey,
    });
  }));
}
