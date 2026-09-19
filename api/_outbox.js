import { randomUUID } from 'node:crypto';

const EVENT_TYPE_PATTERN=/^[a-z][a-z0-9]*(?:\.[a-z][a-z0-9]*)+$/;
const ERROR_CODE_PATTERN=/^[A-Z][A-Z0-9_]{0,63}$/;
const REPLAY_REASON_CODES=new Set(['OPERATOR_RETRY','PROVIDER_RECOVERED','CONFIGURATION_FIXED']);
const TERMINAL_STATUSES=new Set(['delivered','suppressed','dead_letter']);
// Application callers use this process-monotonic scheduler. Tests may inject
// an equivalent clock so deadline behavior does not depend on host load.
const SYSTEM_MONOTONIC_CLOCK=Object.freeze({
  now:()=>performance.now(),
  setTimeout:(callback,delayMs)=>setTimeout(callback,delayMs),
  clearTimeout:handle=>clearTimeout(handle),
});

export const OUTBOX_DEFAULTS=Object.freeze({
  maxAttempts:5,
  deliveryTimeoutMs:10_000,
  leaseDurationMs:30_000,
  heartbeatIntervalMs:8_000,
  baseBackoffMs:30_000,
  maxBackoffMs:6*60*60*1000,
  maxBatchSize:100,
});

export class OutboxDeliveryError extends Error{
  constructor(code,{retryable=true,retryAfterMs=null,cause}={}){
    super('Outbox delivery failed.',cause===undefined?undefined:{cause});
    this.name='OutboxDeliveryError';
    this.code=normalizeErrorCode(code);
    this.retryable=retryable===true;
    this.retryAfterMs=boundedInteger(retryAfterMs,0,OUTBOX_DEFAULTS.maxBackoffMs,null);
  }
}

export class OutboxLeaseLostError extends Error{
  constructor(){
    super('Outbox lease is no longer owned by this worker.');
    this.name='OutboxLeaseLostError';
    this.code='OUTBOX_LEASE_LOST';
  }
}

function boundedInteger(value,min,max,fallback){
  const number=Number(value);
  return Number.isSafeInteger(number)&&number>=min&&number<=max?number:fallback;
}

function normalizeErrorCode(value,fallback='DELIVERY_FAILED'){
  const code=String(value||'').trim().toUpperCase();
  return ERROR_CODE_PATTERN.test(code)?code:fallback;
}

function canonicalInstant(value,label='time'){
  const date=value instanceof Date?new Date(value.getTime()):new Date(value);
  if(!Number.isFinite(date.getTime())) throw new TypeError(`invalid outbox ${label}`);
  return date.toISOString();
}

async function databaseInstant(db){
  const result=await db.execute(`SELECT strftime('%Y-%m-%dT%H:%M:%fZ','now') AS now_utc`);
  return canonicalInstant(result.rows?.[0]?.now_utc,'database time');
}

function validateEventType(value){
  const eventType=String(value||'');
  if(!EVENT_TYPE_PATTERN.test(eventType)||eventType.length>100) throw new TypeError('invalid outbox event type');
  return eventType;
}

function validateIdempotencyKey(value){
  const key=String(value||'');
  if(key.length<8||key.length>255||/[\u0000-\u001f\u007f]/u.test(key)){
    throw new TypeError('invalid outbox idempotency key');
  }
  return key;
}

function validatePayload(value){
  if(!value||typeof value!=='object'||Array.isArray(value)) throw new TypeError('invalid outbox payload');
  const json=JSON.stringify(value);
  if(Buffer.byteLength(json,'utf8')>65_536) throw new TypeError('outbox payload is too large');
  return json;
}

function validateDb(db){
  if(!db||typeof db.execute!=='function'||typeof db.transaction!=='function'||typeof db.batch!=='function'){
    throw new TypeError('transactional database client required');
  }
  return db;
}

function validateMonotonicClock(clock){
  if(!clock||typeof clock.now!=='function'||typeof clock.setTimeout!=='function'
    ||typeof clock.clearTimeout!=='function'){
    throw new TypeError('invalid outbox monotonic clock');
  }
  const reading=clock.now();
  if(typeof reading!=='number'||!Number.isFinite(reading)){
    throw new TypeError('invalid outbox monotonic clock');
  }
  return clock;
}

function retryableConflict(error){
  let current=error;
  for(let depth=0;current&&depth<6;depth+=1){
    const code=String(current.code||current.rawCode||'').toUpperCase();
    if(['SQLITE_BUSY','SQLITE_BUSY_SNAPSHOT','SQLITE_LOCKED','SQLITE_LOCKED_SHAREDCACHE',
      'TRANSACTION_CONFLICT','LIBSQL_TRANSACTION_BUSY'].includes(code)) return true;
    if(/^(?:SQLITE_(?:BUSY|LOCKED)(?::|\s+-)\s*)?database (?:table )?is locked$/i.test(String(current.message||''))){
      return true;
    }
    current=current.cause;
  }
  return false;
}

function retryDelay(attempt){
  return new Promise(resolve=>setTimeout(resolve,Math.min(50,5*(2**(attempt-1)))));
}

function validateWorkerId(value){
  const workerId=String(value||'').trim();
  if(!workerId||workerId.length>100||/[\u0000-\u001f\u007f]/u.test(workerId)){
    throw new TypeError('invalid outbox worker id');
  }
  return workerId;
}

/**
 * Stop awaiting non-cancellable storage/telemetry work at an absolute
 * monotonic deadline. The operation remains rejection-observed if the
 * underlying client settles later.
 */
export async function settleBeforeDeadline(work,deadlineAtMs,{clock=SYSTEM_MONOTONIC_CLOCK}={}){
  if(typeof work!=='function') throw new TypeError('deadline work is required');
  const monotonicClock=validateMonotonicClock(clock);
  const remaining=Math.floor(Number(deadlineAtMs)-monotonicClock.now());
  if(!Number.isFinite(remaining)||remaining<1) return Object.freeze({completed:false,value:null});
  let timer;
  const operation=Promise.resolve().then(work).then(
    value=>({completed:true,value}),
    error=>({completed:true,value:null,error}),
  );
  const timeout=new Promise(resolve=>{
    timer=monotonicClock.setTimeout(()=>resolve({completed:false,value:null}),remaining);
  });
  const result=await Promise.race([operation,timeout]);
  monotonicClock.clearTimeout(timer);
  if(result.error) throw result.error;
  return Object.freeze(result);
}

function eventFromRow(row){
  if(!row) return null;
  const event={
    id:Number(row.id),
    eventType:String(row.event_type||''),
    eventVersion:Number(row.event_version),
    idempotencyKey:String(row.idempotency_key||''),
    payloadJson:String(row.payload_json||''),
    attemptCount:Number(row.attempt_count),
    maxAttempts:Number(row.max_attempts),
    deliveryTimeoutMs:Number(row.delivery_timeout_ms),
    leaseToken:String(row.lease_token||''),
    leasedUntil:String(row.leased_until||''),
  };
  if(!Number.isSafeInteger(event.id)||event.id<1||!EVENT_TYPE_PATTERN.test(event.eventType)
    ||!Number.isSafeInteger(event.eventVersion)||event.eventVersion<1
    ||!event.idempotencyKey||!Number.isSafeInteger(event.attemptCount)||event.attemptCount<1
    ||!Number.isSafeInteger(event.maxAttempts)||event.maxAttempts<1||!event.leaseToken
    ||!Number.isSafeInteger(event.deliveryTimeoutMs)||event.deliveryTimeoutMs<100){
    throw new OutboxDeliveryError('EVENT_CORRUPT',{retryable:false});
  }
  try{
    event.payload=JSON.parse(event.payloadJson);
    if(!event.payload||typeof event.payload!=='object'||Array.isArray(event.payload)) throw new Error();
  }catch{ throw new OutboxDeliveryError('PAYLOAD_INVALID',{retryable:false}); }
  delete event.payloadJson;
  return Object.freeze(event);
}

export function createOutboxEventStatement({
  eventType,eventVersion=1,idempotencyKey,payload,notBefore=null,
  maxAttempts=OUTBOX_DEFAULTS.maxAttempts,
  deliveryTimeoutMs=OUTBOX_DEFAULTS.deliveryTimeoutMs,
}={}){
  const type=validateEventType(eventType);
  const version=boundedInteger(eventVersion,1,1000,null);
  const key=validateIdempotencyKey(idempotencyKey);
  const payloadJson=validatePayload(payload);
  const scheduledAt=notBefore===null?null:canonicalInstant(notBefore,'not-before time');
  const attempts=boundedInteger(maxAttempts,1,100,null);
  const timeout=boundedInteger(deliveryTimeoutMs,100,120_000,null);
  if(version===null||attempts===null||timeout===null) throw new TypeError('invalid outbox delivery policy');
  return Object.freeze({
    sql:`INSERT INTO outbox_events
      (event_type,event_version,idempotency_key,payload_json,status,not_before,next_attempt_at,
       attempt_count,max_attempts,delivery_timeout_ms,created_at,updated_at)
      VALUES (?,?,?,?,'pending',COALESCE(?,strftime('%Y-%m-%dT%H:%M:%fZ','now')),
        COALESCE(?,strftime('%Y-%m-%dT%H:%M:%fZ','now')),0,?,?,
        strftime('%Y-%m-%dT%H:%M:%fZ','now'),strftime('%Y-%m-%dT%H:%M:%fZ','now'))
      ON CONFLICT(idempotency_key) DO NOTHING`,
    args:[type,version,key,payloadJson,scheduledAt,scheduledAt,attempts,timeout],
  });
}

export async function enqueueOutboxEvent(db,event){
  validateDb(db);
  const result=await db.execute(createOutboxEventStatement(event));
  return Object.freeze({created:Number(result.rowsAffected||0)===1});
}

function auditStatement({eventId,action,actorType,actorRef,fromStatus,toStatus,reasonCode=null,attemptNumber}){
  return {
    sql:`INSERT INTO outbox_audit_events
      (outbox_event_id,action,actor_type,actor_ref,from_status,to_status,reason_code,attempt_number)
      VALUES (?,?,?,?,?,?,?,?)`,
    args:[eventId,action,actorType,String(actorRef).slice(0,100),fromStatus,toStatus,reasonCode,attemptNumber],
  };
}

async function commitTransition(db,{update,audit}){
  for(let attempt=1;attempt<=4;attempt+=1){
    let transaction;
    let commitStarted=false;
    let shouldRetry=false;
    try{
      transaction=await db.transaction('write');
      const result=await transaction.execute(update);
      if(Number(result.rowsAffected||0)!==1){
        await transaction.rollback();
        return false;
      }
      await transaction.execute(audit());
      commitStarted=true;
      await transaction.commit();
      return true;
    }catch(error){
      if(transaction&&!commitStarted){ try{ await transaction.rollback(); }catch{} }
      if(commitStarted||!retryableConflict(error)||attempt===4) throw error;
      shouldRetry=true;
    }finally{
      try{ await transaction?.close?.(); }catch{}
    }
    if(shouldRetry) await retryDelay(attempt);
  }
  return false;
}

async function sweepExhausted(db,{actorRef,eventType,limit=100,shouldContinue=()=>true}){
  const now=await databaseInstant(db);
  const sweepLimit=boundedInteger(limit,1,100,null);
  if(sweepLimit===null||typeof shouldContinue!=='function') throw new TypeError('invalid outbox sweep policy');
  const typePredicate=eventType===null?'':'AND event_type=?';
  const expiredArgs=[now];
  if(eventType!==null) expiredArgs.push(eventType);
  const expired=await db.execute({
    sql:`SELECT id,status,attempt_count FROM outbox_events
      WHERE attempt_count>=max_attempts AND (
        status IN ('pending','retry') OR (status='processing' AND leased_until<=?)
      ) ${typePredicate} ORDER BY id LIMIT ?`,
    args:[...expiredArgs,sweepLimit],
  });
  let count=0;
  for(const row of expired.rows||[]){
    if(!shouldContinue()) break;
    const previous=String(row.status);
    const transitioned=await commitTransition(db,{
      update:{
        sql:`UPDATE outbox_events SET status='dead_letter',lease_owner=NULL,lease_token=NULL,
          leased_until=NULL,dead_lettered_at=?,last_error_code=COALESCE(last_error_code,'ATTEMPTS_EXHAUSTED'),updated_at=?
          WHERE id=? AND status=? AND attempt_count>=max_attempts
            AND (?<>'processing' OR leased_until<=?) ${typePredicate}`,
        args:[now,now,Number(row.id),previous,previous,now,...(eventType===null?[]:[eventType])],
      },
      audit:()=>auditStatement({
        eventId:Number(row.id),action:'dead_lettered',actorType:'system',actorRef,
        fromStatus:previous,toStatus:'dead_letter',reasonCode:'ATTEMPTS_EXHAUSTED',
        attemptNumber:Number(row.attempt_count),
      }),
    });
    if(transitioned) count+=1;
  }
  return count;
}

export async function claimOutboxEvent(db,{
  workerId,leaseDurationMs=OUTBOX_DEFAULTS.leaseDurationMs,eventType=null,
}={}){
  validateDb(db);
  const owner=validateWorkerId(workerId);
  const leaseMs=boundedInteger(leaseDurationMs,1_000,300_000,null);
  if(leaseMs===null) throw new TypeError('invalid outbox lease duration');
  const normalizedType=eventType===null?null:validateEventType(eventType);
  const typePredicate=normalizedType===null?'':'AND event_type=?';
  const modifier=`+${(leaseMs/1000).toFixed(3)} seconds`;
  for(let attempt=1;attempt<=4;attempt+=1){
    try{
      const leaseToken=randomUUID();
      const statements=[{
        sql:`UPDATE outbox_events SET claim_from_status=status,status='processing',
            attempt_count=attempt_count+1,lease_owner=?,lease_token=?,
            leased_until=strftime('%Y-%m-%dT%H:%M:%fZ','now',?),last_error_code=NULL,
            updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
          WHERE id=(
            SELECT id FROM outbox_events
            WHERE attempt_count<max_attempts
              AND not_before<=strftime('%Y-%m-%dT%H:%M:%fZ','now')
              AND next_attempt_at<=strftime('%Y-%m-%dT%H:%M:%fZ','now')
              AND (status IN ('pending','retry') OR
                (status='processing' AND leased_until<=strftime('%Y-%m-%dT%H:%M:%fZ','now')))
              ${typePredicate}
            ORDER BY next_attempt_at,id LIMIT 1
          ) AND attempt_count<max_attempts
            AND (status IN ('pending','retry') OR
              (status='processing' AND leased_until<=strftime('%Y-%m-%dT%H:%M:%fZ','now')))
            ${typePredicate}`,
        args:[owner,leaseToken,modifier,
          ...(normalizedType===null?[]:[normalizedType]),
          ...(normalizedType===null?[]:[normalizedType])],
      },{
        sql:`INSERT INTO outbox_audit_events
          (outbox_event_id,action,actor_type,actor_ref,from_status,to_status,reason_code,attempt_number)
          SELECT id,'claimed','worker',?,claim_from_status,'processing',NULL,attempt_count
          FROM outbox_events WHERE lease_owner=? AND lease_token=? AND status='processing'`,
        args:[owner,owner,leaseToken],
      }];
      const results=await db.batch(statements,'write');
      if(Number(results?.[0]?.rowsAffected||0)!==1) return null;
      if(Number(results?.[1]?.rowsAffected||0)!==1){
        throw new Error('claimed outbox event audit was not committed');
      }
      const claimed=eventFromRow((await db.execute({
        sql:`SELECT id,event_type,event_version,idempotency_key,payload_json,attempt_count,max_attempts,
          delivery_timeout_ms,lease_token,leased_until FROM outbox_events
          WHERE lease_owner=? AND lease_token=? AND status='processing' LIMIT 1`,
        args:[owner,leaseToken],
      })).rows?.[0]);
      if(!claimed) throw new Error('claimed outbox event could not be read');
      return claimed;
    }catch(error){
      if(!retryableConflict(error)||attempt===4) throw error;
      await retryDelay(attempt);
    }
  }
  return null;
}

async function claimOutboxRound(db,{workerId,leaseDurationMs,eventTypes}){
  const owner=validateWorkerId(workerId);
  const leaseMs=boundedInteger(leaseDurationMs,1_000,300_000,null);
  const types=[...new Set((eventTypes||[]).map(validateEventType))];
  if(leaseMs===null||!types.length||types.length!==eventTypes.length){
    throw new TypeError('invalid outbox round claim');
  }
  const placeholders=types.map(()=>'?').join(',');
  const modifier=`+${(leaseMs/1000).toFixed(3)} seconds`;
  for(let attempt=1;attempt<=4;attempt+=1){
    try{
      const leaseToken=randomUUID();
      const statements=[{
        sql:`WITH ranked AS (
            SELECT id,ROW_NUMBER() OVER (
              PARTITION BY event_type ORDER BY next_attempt_at,id
            ) AS type_rank
            FROM outbox_events
            WHERE attempt_count<max_attempts
              AND not_before<=strftime('%Y-%m-%dT%H:%M:%fZ','now')
              AND next_attempt_at<=strftime('%Y-%m-%dT%H:%M:%fZ','now')
              AND (status IN ('pending','retry') OR
                (status='processing' AND leased_until<=strftime('%Y-%m-%dT%H:%M:%fZ','now')))
              AND event_type IN (${placeholders})
          )
          UPDATE outbox_events SET claim_from_status=status,status='processing',
            attempt_count=attempt_count+1,lease_owner=?,lease_token=?,
            leased_until=strftime('%Y-%m-%dT%H:%M:%fZ','now',?),last_error_code=NULL,
            updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
          WHERE id IN (SELECT id FROM ranked WHERE type_rank=1)
            AND attempt_count<max_attempts
            AND (status IN ('pending','retry') OR
              (status='processing' AND leased_until<=strftime('%Y-%m-%dT%H:%M:%fZ','now')))`,
        args:[...types,owner,leaseToken,modifier],
      },{
        sql:`INSERT INTO outbox_audit_events
          (outbox_event_id,action,actor_type,actor_ref,from_status,to_status,reason_code,attempt_number)
          SELECT id,'claimed','worker',?,claim_from_status,'processing',NULL,attempt_count
          FROM outbox_events WHERE lease_owner=? AND lease_token=? AND status='processing'`,
        args:[owner,owner,leaseToken],
      }];
      const results=await db.batch(statements,'write');
      const claimedCount=Number(results?.[0]?.rowsAffected||0);
      if(claimedCount===0) return [];
      if(Number(results?.[1]?.rowsAffected||0)!==claimedCount){
        throw new Error('claimed outbox event audits were not committed');
      }
      const rows=(await db.execute({
        sql:`SELECT id,event_type,event_version,idempotency_key,payload_json,attempt_count,max_attempts,
          delivery_timeout_ms,lease_token,leased_until FROM outbox_events
          WHERE lease_owner=? AND lease_token=? AND status='processing'`,
        args:[owner,leaseToken],
      })).rows||[];
      if(rows.length!==claimedCount) throw new Error('claimed outbox events could not be read');
      const order=new Map(types.map((type,index)=>[type,index]));
      return rows.map(eventFromRow).sort((left,right)=>order.get(left.eventType)-order.get(right.eventType));
    }catch(error){
      if(!retryableConflict(error)||attempt===4) throw error;
      await retryDelay(attempt);
    }
  }
  return [];
}

export async function heartbeatOutboxLease(db,{eventId,leaseToken,workerId,leaseDurationMs=OUTBOX_DEFAULTS.leaseDurationMs}={}){
  validateDb(db);
  const id=boundedInteger(eventId,1,Number.MAX_SAFE_INTEGER,null);
  const token=String(leaseToken||'');
  const owner=validateWorkerId(workerId);
  const leaseMs=boundedInteger(leaseDurationMs,1_000,300_000,null);
  if(id===null||!token||leaseMs===null) throw new TypeError('invalid outbox lease');
  const modifier=`+${(leaseMs/1000).toFixed(3)} seconds`;
  const result=await db.execute({
    sql:`UPDATE outbox_events SET
        leased_until=MAX(leased_until,strftime('%Y-%m-%dT%H:%M:%fZ','now',?)),
        updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
      WHERE id=? AND status='processing' AND lease_owner=? AND lease_token=?
        AND leased_until>strftime('%Y-%m-%dT%H:%M:%fZ','now')`,
    args:[modifier,id,owner,token],
  });
  return Number(result.rowsAffected||0)===1;
}

function backoffMs(attempt,{baseBackoffMs,maxBackoffMs,retryAfterMs}){
  const exponential=Math.min(maxBackoffMs,baseBackoffMs*(2**Math.max(0,attempt-1)));
  return Math.min(maxBackoffMs,Math.max(exponential,retryAfterMs||0));
}

function deliveryFailure(error,event,options){
  const known=error instanceof OutboxDeliveryError;
  const retryable=known?error.retryable:true;
  const exhausted=event.attemptCount>=event.maxAttempts;
  const deadLetter=!retryable||exhausted;
  const reasonCode=normalizeErrorCode(known?error.code:'DELIVERY_FAILED');
  const delay=backoffMs(event.attemptCount,{
    ...options,retryAfterMs:known?error.retryAfterMs:null,
  });
  return {deadLetter,reasonCode,delay};
}

function failedResolution(error,event,options){
  const failure=deliveryFailure(error,event,options);
  return {leaseLost:false,outcome:failure.deadLetter
    ?{status:'dead_letter',reasonCode:failure.reasonCode,delayMs:0}
    :{status:'retry',reasonCode:failure.reasonCode,delayMs:failure.delay}};
}

async function finalizeOutcome(db,{event,workerId,outcome}){
  const now=await databaseInstant(db);
  const status=outcome.status;
  if(!TERMINAL_STATUSES.has(status)&&status!=='retry') throw new TypeError('invalid outbox outcome');
  const action=status==='dead_letter'?'dead_lettered':status==='retry'?'retry_scheduled':status;
  const nextAttempt=status==='retry'
    ?new Date(new Date(now).getTime()+outcome.delayMs).toISOString()
    :now;
  return commitTransition(db,{
    update:{
      sql:`UPDATE outbox_events SET status=?,next_attempt_at=?,lease_owner=NULL,lease_token=NULL,
        leased_until=NULL,provider_name=COALESCE(?,provider_name),provider_message_id=COALESCE(?,provider_message_id),
        last_error_code=?,delivered_at=CASE WHEN ?='delivered' THEN ? ELSE delivered_at END,
        dead_lettered_at=CASE WHEN ?='dead_letter' THEN ? ELSE NULL END,updated_at=?
        WHERE id=? AND status='processing' AND lease_owner=? AND lease_token=?
          AND leased_until>strftime('%Y-%m-%dT%H:%M:%fZ','now')`,
      args:[status,nextAttempt,outcome.providerName||null,outcome.providerMessageId||null,
        outcome.reasonCode||null,status,now,status,now,now,event.id,workerId,event.leaseToken],
    },
    audit:()=>auditStatement({
      eventId:event.id,action,actorType:'worker',actorRef:workerId,
      fromStatus:'processing',toStatus:status,reasonCode:outcome.reasonCode||null,
      attemptNumber:event.attemptCount,
    }),
  });
}

function startHeartbeat(db,{event,workerId,leaseDurationMs,heartbeatIntervalMs,abortController,
  clock=SYSTEM_MONOTONIC_CLOCK}){
  if(heartbeatIntervalMs===0) return {async stop(){}};
  const monotonicClock=validateMonotonicClock(clock);
  let stopped=false;
  let timer=null;
  let inFlight=Promise.resolve();
  const schedule=()=>{
    if(stopped) return;
    timer=monotonicClock.setTimeout(()=>{
      inFlight=(async()=>{
        try{
          const owned=await heartbeatOutboxLease(db,{
            eventId:event.id,leaseToken:event.leaseToken,workerId,
            leaseDurationMs,
          });
          if(!owned) abortController.abort(new OutboxLeaseLostError());
        }catch{ abortController.abort(new OutboxLeaseLostError()); }
      })().finally(schedule);
    },heartbeatIntervalMs);
    timer.unref?.();
  };
  schedule();
  return {
    async stop(){
      stopped=true;
      if(timer) monotonicClock.clearTimeout(timer);
      await inFlight.catch(()=>{});
    },
  };
}

async function invokeWithTimeout(handler,event,{abortController,
  deliveryTimeoutMs=event.deliveryTimeoutMs,timeoutCode='DELIVERY_TIMEOUT',
  clock=SYSTEM_MONOTONIC_CLOCK}){
  const monotonicClock=validateMonotonicClock(clock);
  let timer;
  const timeout=new Promise((_,reject)=>{
    timer=monotonicClock.setTimeout(()=>{
      const error=new OutboxDeliveryError(timeoutCode,{retryable:true});
      abortController.abort(error);
      reject(error);
    },deliveryTimeoutMs);
  });
  try{
    return await Promise.race([
      Promise.resolve().then(()=>handler(event,{signal:abortController.signal})),
      timeout,
    ]);
  }finally{
    monotonicClock.clearTimeout(timer);
  }
}

function normalizeSuccess(value){
  const result=value&&typeof value==='object'?value:{};
  const status=result.status==='suppressed'?'suppressed':'delivered';
  const providerName=String(result.providerName||'').trim().slice(0,100)||null;
  const providerMessageId=String(result.providerMessageId||'').trim().slice(0,255)||null;
  const reasonCode=status==='suppressed'?normalizeErrorCode(result.reasonCode,'DELIVERY_SUPPRESSED'):null;
  return {status,providerName,providerMessageId,reasonCode,delayMs:0};
}

function emptyWorkerResult(){
  return {claimed:0,delivered:0,suppressed:0,retried:0,deadLettered:0,leaseLost:0};
}

function addWorkerResult(target,source){
  for(const key of Object.keys(emptyWorkerResult())) target[key]+=Number(source[key]||0);
}

async function resolveClaimedOutboxEvent(db,event,{handlers,workerId,leaseDurationMs,
  heartbeatIntervalMs,baseBackoffMs,maxBackoffMs,deliveryTimeoutMs=event.deliveryTimeoutMs,
  timeoutCode='DELIVERY_TIMEOUT',abortController,clock=SYSTEM_MONOTONIC_CLOCK}={}){
  const handler=handlers instanceof Map?handlers.get(event.eventType):handlers[event.eventType];
  let outcome;
  try{
    if(typeof handler!=='function') throw new OutboxDeliveryError('EVENT_HANDLER_MISSING',{retryable:false});
    const delivered=await invokeWithTimeout(handler,event,{
      abortController,deliveryTimeoutMs,timeoutCode,clock,
    });
    outcome=normalizeSuccess(delivered);
  }catch(error){
    if(error instanceof OutboxLeaseLostError
      ||abortController.signal.reason instanceof OutboxLeaseLostError){
      return {leaseLost:true,outcome:null};
    }
    return failedResolution(error,event,{baseBackoffMs,maxBackoffMs});
  }
  return {leaseLost:false,outcome};
}

function startClaimLifecycle(db,event,{workerId,leaseDurationMs,heartbeatIntervalMs,
  clock=SYSTEM_MONOTONIC_CLOCK}){
  const abortController=new AbortController();
  const heartbeat=startHeartbeat(db,{
    event,workerId,leaseDurationMs,heartbeatIntervalMs,abortController,clock,
  });
  return {abortController,heartbeat};
}

function leaseAwareResolution(lifecycle,resolution){
  return lifecycle.abortController.signal.reason instanceof OutboxLeaseLostError
    ?{leaseLost:true,outcome:null}:resolution;
}

async function finalizeResolvedOutboxEvent(db,event,{workerId,resolution}){
  const result=emptyWorkerResult();
  result.claimed=1;
  if(resolution.leaseLost){ result.leaseLost=1; return result; }
  const {outcome}=resolution;
  const owned=await finalizeOutcome(db,{event,workerId,outcome});
  if(!owned){ result.leaseLost=1; return result; }
  if(outcome.status==='delivered') result.delivered=1;
  else if(outcome.status==='suppressed') result.suppressed=1;
  else if(outcome.status==='retry') result.retried=1;
  else result.deadLettered=1;
  return result;
}

async function deliverClaimedOutboxEvent(db,event,options={}){
  const lifecycle=startClaimLifecycle(db,event,options);
  try{
    const resolution=await resolveClaimedOutboxEvent(db,event,{
      ...options,abortController:lifecycle.abortController,
    });
    return await finalizeResolvedOutboxEvent(db,event,{
      workerId:options.workerId,resolution:leaseAwareResolution(lifecycle,resolution),
    });
  }finally{
    await lifecycle.heartbeat.stop();
  }
}

export async function runOutboxWorker({
  db,workerId=`worker-${randomUUID()}`,handlers,eventType=null,
  batchSize=OUTBOX_DEFAULTS.maxBatchSize,leaseDurationMs=OUTBOX_DEFAULTS.leaseDurationMs,
  heartbeatIntervalMs=OUTBOX_DEFAULTS.heartbeatIntervalMs,
  baseBackoffMs=OUTBOX_DEFAULTS.baseBackoffMs,maxBackoffMs=OUTBOX_DEFAULTS.maxBackoffMs,
}={}){
  validateDb(db);
  const owner=validateWorkerId(workerId);
  const normalizedType=eventType===null?null:validateEventType(eventType);
  if(!(handlers instanceof Map)&&(!handlers||typeof handlers!=='object'||Array.isArray(handlers))){
    throw new TypeError('outbox handlers are required');
  }
  const limit=boundedInteger(batchSize,1,OUTBOX_DEFAULTS.maxBatchSize,null);
  const leaseMs=boundedInteger(leaseDurationMs,1_000,300_000,null);
  const heartbeatMs=boundedInteger(heartbeatIntervalMs,0,leaseMs-1,null);
  const baseMs=boundedInteger(baseBackoffMs,1,OUTBOX_DEFAULTS.maxBackoffMs,null);
  const maxMs=boundedInteger(maxBackoffMs,baseMs||1,24*60*60*1000,null);
  if(limit===null||leaseMs===null||heartbeatMs===null||baseMs===null||maxMs===null){
    throw new TypeError('invalid outbox worker policy');
  }
  const result=emptyWorkerResult();
  result.deadLettered+=await sweepExhausted(db,{actorRef:owner,eventType:normalizedType});
  for(let index=0;index<limit;index+=1){
    const event=await claimOutboxEvent(db,{
      workerId:owner,leaseDurationMs:leaseMs,eventType:normalizedType,
    });
    if(!event) break;
    addWorkerResult(result,await deliverClaimedOutboxEvent(db,event,{
      handlers,workerId:owner,leaseDurationMs:leaseMs,heartbeatIntervalMs:heartbeatMs,
      baseBackoffMs:baseMs,maxBackoffMs:maxMs,
    }));
  }
  return Object.freeze(result);
}

/**
 * Drain multiple event types in fair parallel rounds under one request budget.
 * One event per non-empty type is claimed before any type receives a second
 * claim. Provider waits are capped by the shared deadline, with time reserved
 * to finalize every lease already claimed in that round.
 */
export async function runOutboxInvocation({
  db,workerId=`invocation-${randomUUID()}`,handlers,eventTypes,maxClaims=8,
  deadlineAtMs,finalizationReserveMs=5_000,
  minimumDispatchWindowMs=100,leaseDurationMs=OUTBOX_DEFAULTS.leaseDurationMs,
  heartbeatIntervalMs=OUTBOX_DEFAULTS.heartbeatIntervalMs,
  baseBackoffMs=OUTBOX_DEFAULTS.baseBackoffMs,maxBackoffMs=OUTBOX_DEFAULTS.maxBackoffMs,
  clock=SYSTEM_MONOTONIC_CLOCK,
}={}){
  validateDb(db);
  const owner=validateWorkerId(workerId);
  if(!(handlers instanceof Map)&&(!handlers||typeof handlers!=='object'||Array.isArray(handlers))){
    throw new TypeError('outbox handlers are required');
  }
  if(!Array.isArray(eventTypes)||eventTypes.length<1) throw new TypeError('outbox event types are required');
  const types=[...new Set(eventTypes.map(validateEventType))];
  if(types.length!==eventTypes.length
    ||types.some(type=>typeof (handlers instanceof Map?handlers.get(type):handlers[type])!=='function')){
    throw new TypeError('each outbox event type requires one handler');
  }
  const claimLimit=boundedInteger(maxClaims,types.length,OUTBOX_DEFAULTS.maxBatchSize,null);
  const leaseMs=boundedInteger(leaseDurationMs,1_000,300_000,null);
  const heartbeatMs=boundedInteger(heartbeatIntervalMs,0,leaseMs-1,null);
  const baseMs=boundedInteger(baseBackoffMs,1,OUTBOX_DEFAULTS.maxBackoffMs,null);
  const maxMs=boundedInteger(maxBackoffMs,baseMs||1,24*60*60*1000,null);
  const monotonicClock=validateMonotonicClock(clock);
  const deadline=deadlineAtMs===undefined?monotonicClock.now()+45_000:Number(deadlineAtMs);
  const reserveMs=boundedInteger(finalizationReserveMs,100,60_000,null);
  const minimumMs=boundedInteger(minimumDispatchWindowMs,100,10_000,null);
  if(claimLimit===null||leaseMs===null||heartbeatMs===null||baseMs===null||maxMs===null
    ||!Number.isFinite(deadline)||reserveMs===null||minimumMs===null){
    throw new TypeError('invalid outbox invocation policy');
  }
  const perType=Object.fromEntries(types.map(type=>[type,emptyWorkerResult()]));
  const total=emptyWorkerResult();
  let deadlineReached=false;
  const canStart=()=>monotonicClock.now()+reserveMs+minimumMs<deadline;

  const activeTypes=new Set(types);
  while(total.claimed<claimLimit&&activeTypes.size){
    if(!canStart()){ deadlineReached=true; break; }
    const admittedTypes=types.filter(type=>activeTypes.has(type))
      .slice(0,claimLimit-total.claimed);
    // A round is claimed in one statement: every active type receives one fair
    // opportunity before the deadline is checked again.
    const claimPromise=claimOutboxRound(db,{
      workerId:owner,leaseDurationMs:leaseMs,eventTypes:admittedTypes,
    });
    const claimed=await settleBeforeDeadline(()=>claimPromise,
      deadline-reserveMs-minimumMs,{clock:monotonicClock});
    if(!claimed.completed){
      deadlineReached=true;
      // The client cannot cancel an in-flight SQL statement. If it commits
      // after this invocation stops waiting, resolve any resulting leases to a
      // bounded deadline failure without invoking a provider.
      void claimPromise.then(async lateRound=>{
        for(const event of lateRound){
          try{
            await finalizeResolvedOutboxEvent(db,event,{workerId:owner,
              resolution:failedResolution(
                new OutboxDeliveryError('INVOCATION_DEADLINE',{retryable:true}),event,
                {baseBackoffMs:baseMs,maxBackoffMs:maxMs},
              )});
          }catch{}
        }
      }).catch(()=>{});
      break;
    }
    const round=claimed.value;
    const claimedTypes=new Set(round.map(event=>event.eventType));
    for(const type of admittedTypes){ if(!claimedTypes.has(type)) activeTypes.delete(type); }
    if(!round.length) break;
    const lifecycles=round.map(event=>startClaimLifecycle(db,event,{
      workerId:owner,leaseDurationMs:leaseMs,heartbeatIntervalMs:heartbeatMs,clock:monotonicClock,
    }));
    const resolutions=await Promise.all(round.map(async(event,index)=>{
      const available=Math.floor(deadline-monotonicClock.now()-reserveMs);
      if(available<minimumMs){
        return failedResolution(
          new OutboxDeliveryError('INVOCATION_DEADLINE',{retryable:true}),event,
          {baseBackoffMs:baseMs,maxBackoffMs:maxMs},
        );
      }
      const timeoutMs=Math.min(event.deliveryTimeoutMs,available);
      return resolveClaimedOutboxEvent(db,event,{
        handlers,workerId:owner,leaseDurationMs:leaseMs,heartbeatIntervalMs:heartbeatMs,
        baseBackoffMs:baseMs,maxBackoffMs:maxMs,deliveryTimeoutMs:timeoutMs,
        timeoutCode:timeoutMs<event.deliveryTimeoutMs?'INVOCATION_DEADLINE':'DELIVERY_TIMEOUT',
        abortController:lifecycles[index].abortController,clock:monotonicClock,
      });
    }));
    const outcomes=[];
    for(let index=0;index<round.length;index+=1){
      const event=round[index];
      const lifecycle=lifecycles[index];
      const remainingEvents=round.length-index;
      const available=Math.max(0,Math.floor(deadline-monotonicClock.now()));
      const finalizationDeadline=Math.min(deadline,
        monotonicClock.now()+Math.max(1,Math.floor(available/remainingEvents)));
      try{
        const finalized=await settleBeforeDeadline(()=>finalizeResolvedOutboxEvent(db,event,{
          workerId:owner,resolution:leaseAwareResolution(lifecycle,resolutions[index]),
        }),finalizationDeadline,{clock:monotonicClock});
        outcomes.push(finalized.completed?finalized.value
          :{...emptyWorkerResult(),claimed:1,leaseLost:1});
      }catch{
        // An ambiguous or failed transition remains protected by the lease and
        // provider idempotency key. Continue finalizing the rest of the round.
        outcomes.push({...emptyWorkerResult(),claimed:1,leaseLost:1});
      }finally{
        const stopping=lifecycle.heartbeat.stop();
        await settleBeforeDeadline(()=>stopping,deadline,{clock:monotonicClock});
      }
    }
    for(let index=0;index<round.length;index+=1){
      const outcome=outcomes[index];
      addWorkerResult(perType[round[index].eventType],outcome);
      addWorkerResult(total,outcome);
    }
    if(!canStart()) deadlineReached=true;
  }
  // Exhausted-lease cleanup is useful but cannot delay a first fair delivery
  // round. Admit one bounded cleanup transition per type only while headroom
  // remains for request teardown and metrics.
  for(const type of types){
    if(!canStart()){ deadlineReached=true; break; }
    const sweepPromise=sweepExhausted(db,{
      actorRef:owner,eventType:type,limit:1,shouldContinue:canStart,
    });
    const swept=await settleBeforeDeadline(()=>sweepPromise,deadline,{clock:monotonicClock});
    if(!swept.completed){ deadlineReached=true; break; }
    perType[type].deadLettered+=swept.value;
    total.deadLettered+=swept.value;
  }
  return Object.freeze({...total,deadlineReached,maxClaims:claimLimit,
    perType:Object.freeze(Object.fromEntries(types.map(type=>[type,Object.freeze(perType[type])])))});
}

export async function replayDeadLetter(db,{
  eventId,operatorUserId,reasonCode,notBefore=null,
}={}){
  validateDb(db);
  const id=boundedInteger(eventId,1,Number.MAX_SAFE_INTEGER,null);
  const operatorId=boundedInteger(operatorUserId,1,Number.MAX_SAFE_INTEGER,null);
  const reason=String(reasonCode||'').trim().toUpperCase();
  if(id===null||operatorId===null||!REPLAY_REASON_CODES.has(reason)){
    throw new TypeError('invalid outbox replay request');
  }
  const instant=await databaseInstant(db);
  const scheduledAt=notBefore===null?instant:canonicalInstant(notBefore,'not-before time');
  return commitTransition(db,{
    update:{
      sql:`UPDATE outbox_events SET status='pending',not_before=?,next_attempt_at=?,attempt_count=0,
        lease_owner=NULL,lease_token=NULL,leased_until=NULL,last_error_code=NULL,dead_lettered_at=NULL,
        replay_count=replay_count+1,updated_at=? WHERE id=? AND status='dead_letter'`,
      args:[scheduledAt,scheduledAt,instant,id],
    },
    audit:()=>auditStatement({
      eventId:id,action:'replayed',actorType:'operator',actorRef:`user:${operatorId}`,
      fromStatus:'dead_letter',toStatus:'pending',reasonCode:reason,attemptNumber:0,
    }),
  });
}

export async function readOutboxMetrics(db,{eventType=null}={}){
  if(!db||typeof db.execute!=='function') throw new TypeError('database client required');
  const normalizedType=eventType===null?null:validateEventType(eventType);
  const result=await db.execute(normalizedType===null
    ?`SELECT event_type,event_version,status,COUNT(*) AS count,MIN(created_at) AS oldest_created_at
      FROM outbox_events GROUP BY event_type,event_version,status ORDER BY event_type,event_version,status`
    :{sql:`SELECT event_type,event_version,status,COUNT(*) AS count,MIN(created_at) AS oldest_created_at
      FROM outbox_events WHERE event_type=? GROUP BY event_type,event_version,status
      ORDER BY event_version,status`,args:[normalizedType]});
  return Object.freeze((result.rows||[]).map(row=>Object.freeze({
    eventType:String(row.event_type),eventVersion:Number(row.event_version),status:String(row.status),
    count:Number(row.count),oldestCreatedAt:String(row.oldest_created_at||''),
  })));
}
