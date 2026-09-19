import { createHash, randomUUID } from 'node:crypto';

export const CHAT_RETENTION_POLICY=Object.freeze({
  version:'private-beta-v1',
  retentionDays:90,
  batchSize:100,
  maxBatchesPerInvocation:4,
  leaseDurationMs:30_000,
  maxFailures:5,
  baseBackoffMs:30_000,
  maxBackoffMs:6*60*60*1000,
});

const MODES=new Set(['dry_run','purge']);
const ERROR_CODE_PATTERN=/^[A-Z][A-Z0-9_]{0,63}$/;
const REPLAY_REASONS=new Set(['OPERATOR_RETRY','CONFIGURATION_FIXED','TRANSIENT_FAILURE_CLEARED']);
const DIGEST_PATTERN=/^[a-f0-9]{64}$/;

export class ChatRetentionError extends Error{
  constructor(code,{retryable=false,cause}={}){
    super('Chat retention operation failed.',cause===undefined?undefined:{cause});
    this.name='ChatRetentionError';
    this.code=errorCode(code);
    this.retryable=retryable===true;
  }
}

function errorCode(value,fallback='RETENTION_FAILED'){
  const code=String(value||'').trim().toUpperCase();
  return ERROR_CODE_PATTERN.test(code)?code:fallback;
}

function integer(value,min,max,label){
  const number=Number(value);
  if(!Number.isSafeInteger(number)||number<min||number>max) throw new TypeError(`invalid ${label}`);
  return number;
}

function mode(value){
  const normalized=String(value||'').trim().toLowerCase().replace('-','_');
  if(!MODES.has(normalized)) throw new TypeError('invalid chat retention mode');
  return normalized;
}

function workerId(value){
  const normalized=String(value||'').trim();
  if(!normalized||normalized.length>100||/[\u0000-\u001f\u007f]/u.test(normalized)){
    throw new TypeError('invalid chat retention worker id');
  }
  return normalized;
}

function canonicalInstant(value,label){
  if(typeof value!=='string'||new Date(value).toISOString()!==value){
    throw new TypeError(`invalid ${label}`);
  }
  return value;
}

function evidence(value,label){
  if(!value||typeof value!=='object'||Array.isArray(value)) throw new TypeError(`invalid ${label} evidence`);
  const digest=String(value.digest||'').trim();
  const scopeBindingDigest=String(value.scopeBindingDigest||'').trim();
  if(!DIGEST_PATTERN.test(digest)||!DIGEST_PATTERN.test(scopeBindingDigest)){
    throw new TypeError(`invalid ${label} evidence`);
  }
  return Object.freeze({
    digest,
    scopeBindingDigest,
    sourceMaxMessageId:integer(value.sourceMaxMessageId,1,Number.MAX_SAFE_INTEGER,
      `${label} source maximum message`),
    throughAt:canonicalInstant(value.throughAt,`${label} through time`),
    completedAt:canonicalInstant(value.completedAt,`${label} completion time`),
  });
}

export function chatRetentionEvidenceBindingDigest({kind,scope:scopeValue,sourceMaxMessageId,
  digest,throughAt,completedAt}={}){
  const evidenceKind=String(kind||'');
  if(evidenceKind!=='backup'&&evidenceKind!=='export'){
    throw new TypeError('invalid retention evidence kind');
  }
  const normalized=scope(scopeValue);
  const maximum=integer(sourceMaxMessageId,1,Number.MAX_SAFE_INTEGER,
    'retention source maximum message');
  const artifactDigest=String(digest||'').trim();
  if(!DIGEST_PATTERN.test(artifactDigest)) throw new TypeError('invalid retention evidence digest');
  return createHash('sha256').update([
    'randori-chat-retention-evidence:v1',CHAT_RETENTION_POLICY.version,
    evidenceKind,normalized.scopeKey,normalized.circleId??'local',normalized.weekId,
    normalized.pairGroupId,maximum,artifactDigest,
    canonicalInstant(throughAt,'retention evidence through time'),
    canonicalInstant(completedAt,'retention evidence completion time'),
  ].join('|')).digest('hex');
}

function validateDb(db){
  if(!db||typeof db.execute!=='function'||typeof db.transaction!=='function'){
    throw new TypeError('transactional database client required');
  }
  return db;
}

function validateBatchDb(db){
  validateDb(db);
  if(typeof db.batch!=='function') throw new TypeError('atomic batch database client required');
  return db;
}

function scope(value){
  if(!value||typeof value!=='object'||Array.isArray(value)) throw new TypeError('invalid retention scope');
  const weekId=integer(value.weekId,1,Number.MAX_SAFE_INTEGER,'retention week');
  const pairGroupId=integer(value.pairGroupId,1,Number.MAX_SAFE_INTEGER,'retention pair group');
  const scopeKey=String(value.scopeKey||'').trim();
  const circleId=value.circleId===null||value.circleId===undefined
    ?null:integer(value.circleId,1,Number.MAX_SAFE_INTEGER,'retention circle');
  if(!((scopeKey==='local'&&circleId===null)||(circleId!==null&&scopeKey===`circle:${circleId}`))){
    throw new TypeError('invalid retention scope');
  }
  return Object.freeze({weekId,pairGroupId,scopeKey,circleId});
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
  return new Promise(resolve=>setTimeout(resolve,Math.min(100,10*(2**(attempt-1)))));
}

async function writeTransaction(db,operation){
  for(let attempt=1;attempt<=4;attempt+=1){
    let transaction;
    let commitStarted=false;
    try{
      transaction=await db.transaction('write');
      const result=await operation(transaction);
      commitStarted=true;
      await transaction.commit();
      return result;
    }catch(error){
      if(transaction&&!commitStarted){ try{ await transaction.rollback(); }catch{} }
      if(commitStarted||!retryableConflict(error)||attempt===4) throw error;
    }finally{
      try{ await transaction?.close?.(); }catch{}
    }
    await retryDelay(attempt);
  }
  throw new ChatRetentionError('RETENTION_TRANSACTION_FAILED',{retryable:true});
}

async function databaseClock(db){
  const result=await db.execute(`SELECT
    strftime('%Y-%m-%dT%H:%M:%fZ','now') AS now_utc,
    strftime('%Y-%m-%dT00:00:00.000Z','now','-${CHAT_RETENTION_POLICY.retentionDays} days') AS cutoff_utc`);
  return Object.freeze({
    now:canonicalInstant(String(result.rows?.[0]?.now_utc||''),'database time'),
    cutoff:canonicalInstant(String(result.rows?.[0]?.cutoff_utc||''),'retention cutoff'),
  });
}

function validateGate({backup,exported},clock,requestedScope){
  const backupEvidence=evidence(backup,'backup');
  const exportEvidence=evidence(exported,'export');
  const values=[backupEvidence.throughAt,backupEvidence.completedAt,
    exportEvidence.throughAt,exportEvidence.completedAt];
  const expectedBackupBinding=chatRetentionEvidenceBindingDigest({
    kind:'backup',scope:requestedScope,...backupEvidence,
  });
  const expectedExportBinding=chatRetentionEvidenceBindingDigest({
    kind:'export',scope:requestedScope,...exportEvidence,
  });
  if(backupEvidence.sourceMaxMessageId!==exportEvidence.sourceMaxMessageId){
    throw new ChatRetentionError('RETENTION_EVIDENCE_SOURCE_MISMATCH');
  }
  if(values.some(value=>value>clock.now)
    ||backupEvidence.throughAt<clock.cutoff||exportEvidence.throughAt<clock.cutoff
    ||backupEvidence.throughAt>backupEvidence.completedAt
    ||exportEvidence.throughAt>exportEvidence.completedAt
    ||exportEvidence.completedAt>backupEvidence.completedAt){
    throw new ChatRetentionError('RETENTION_EVIDENCE_ORDER_INVALID');
  }
  if(backupEvidence.scopeBindingDigest!==expectedBackupBinding
    ||exportEvidence.scopeBindingDigest!==expectedExportBinding){
    throw new ChatRetentionError('RETENTION_EVIDENCE_SCOPE_MISMATCH');
  }
  return Object.freeze({
    backup:backupEvidence,exported:exportEvidence,
    sourceMaxMessageId:backupEvidence.sourceMaxMessageId,
  });
}

function retentionRunKey({mode:runMode,scope:normalized,cutoffAt,sourceMaxMessageId,
  backupBindingDigest,exportBindingDigest}){
  return createHash('sha256').update([
    CHAT_RETENTION_POLICY.version,runMode,normalized.scopeKey,
    normalized.weekId,normalized.pairGroupId,cutoffAt,sourceMaxMessageId,
    backupBindingDigest,exportBindingDigest,
  ].join('|')).digest('hex');
}

function auditStatement({runId,action,fromStatus,toStatus,itemCount=0,durationMs=0,reasonCode=null}){
  return {
    sql:`INSERT INTO chat_retention_audit_events
      (retention_run_id,action,from_status,to_status,item_count,duration_ms,reason_code)
      VALUES (?,?,?,?,?,?,?)`,
    args:[runId,action,fromStatus,toStatus,itemCount,durationMs,reasonCode],
  };
}

export function chatRetentionRuntimeConfig(env=process.env){
  return Object.freeze({
    enabled:env.CHAT_RETENTION_ENABLED==='true',
    mode:mode(env.CHAT_RETENTION_MODE||'dry_run'),
  });
}

export function chatRetentionScopeRegistrationStatement({scope:scopeValue,cycleId,generationToken}){
  const normalized=scope({...scopeValue,weekId:1,pairGroupId:1});
  const cycle=String(cycleId||'');
  const token=String(generationToken||'');
  if(!cycle||!token) throw new TypeError('invalid pairing publication scope registration');
  return Object.freeze({
    sql:`INSERT INTO chat_retention_scopes (week_id,pair_group_id,scope_key,circle_id,registered_at)
      SELECT groups.week_id,groups.id,?,?,strftime('%Y-%m-%dT%H:%M:%fZ','now')
      FROM pairing_groups groups
      JOIN pairing_week_runs run ON run.week_id=groups.week_id
      WHERE run.week_label=? AND run.generation_token=?`,
    args:[normalized.scopeKey,normalized.circleId,cycle,token],
  });
}

export async function chatRetentionScopeRegistrationAvailable(db){
  const result=await db.execute(`SELECT COUNT(*) AS count FROM sqlite_schema
    WHERE type='table' AND name='chat_retention_scopes'`);
  return Number(result.rows?.[0]?.count||0)===1;
}

export async function ensureChatRetentionReadiness(db){
  validateDb(db);
  await db.execute(`SELECT id,enabled,generation,policy_version,retention_days FROM chat_retention_control LIMIT 0`);
  await db.execute(`SELECT week_id,pair_group_id,scope_key,circle_id FROM chat_retention_scopes LIMIT 0`);
  await db.execute(`SELECT id,run_key,mode,status,checkpoint,scan_cursor_id,control_generation FROM chat_retention_runs LIMIT 0`);
  await db.execute(`SELECT scope_key,week_id,pair_group_id,hold_level,status FROM chat_retention_legal_holds LIMIT 0`);
  await db.execute(`SELECT retention_run_id,action,item_count,duration_ms FROM chat_retention_audit_events LIMIT 0`);
  return true;
}

export async function setChatRetentionControl(db,{enabled,expectedGeneration}={}){
  validateDb(db);
  if(typeof enabled!=='boolean') throw new TypeError('invalid retention control');
  const expected=integer(expectedGeneration,0,Number.MAX_SAFE_INTEGER,'retention control generation');
  return writeTransaction(db,async transaction=>{
    if(expected===0){
      const result=await transaction.execute({
        sql:`INSERT INTO chat_retention_control
          (id,enabled,generation,policy_version,retention_days,updated_at)
          VALUES (1,?,1,?,?,strftime('%Y-%m-%dT%H:%M:%fZ','now'))
          ON CONFLICT(id) DO NOTHING`,
        args:[enabled?1:0,CHAT_RETENTION_POLICY.version,CHAT_RETENTION_POLICY.retentionDays],
      });
      if(Number(result.rowsAffected||0)!==1) throw new ChatRetentionError('RETENTION_CONTROL_STALE');
      return Object.freeze({enabled,generation:1});
    }
    const result=await transaction.execute({
      sql:`UPDATE chat_retention_control SET enabled=?,generation=generation+1,
        updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
        WHERE id=1 AND generation=? AND policy_version=? AND retention_days=?`,
      args:[enabled?1:0,expected,CHAT_RETENTION_POLICY.version,CHAT_RETENTION_POLICY.retentionDays],
    });
    if(Number(result.rowsAffected||0)!==1) throw new ChatRetentionError('RETENTION_CONTROL_STALE');
    if(!enabled){
      await transaction.execute(`INSERT INTO chat_retention_audit_events
        (retention_run_id,action,from_status,to_status,item_count,duration_ms,reason_code)
        SELECT id,'yielded','processing','pending',0,0,'RETENTION_DISABLED'
        FROM chat_retention_runs WHERE status='processing'`);
      await transaction.execute(`UPDATE chat_retention_runs SET status='pending',control_generation=NULL,
        lease_owner=NULL,lease_token=NULL,leased_until=NULL,last_error_code='RETENTION_DISABLED',
        next_attempt_at=strftime('%Y-%m-%dT%H:%M:%fZ','now'),
        updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE status='processing'`);
    }
    return Object.freeze({enabled,generation:expected+1});
  });
}

export async function adoptChatRetentionScope(db,{scope:scopeValue,localRuntime=false}={}){
  validateDb(db);
  const normalized=scope(scopeValue);
  return writeTransaction(db,async transaction=>{
    const mapping=(await transaction.execute({
      sql:`SELECT scope_key,circle_id FROM chat_retention_scopes
        WHERE week_id=? AND pair_group_id=?`,
      args:[normalized.weekId,normalized.pairGroupId],
    })).rows?.[0];
    if(mapping){
      const exact=String(mapping.scope_key)===normalized.scopeKey
        &&(mapping.circle_id===null?null:Number(mapping.circle_id))===normalized.circleId;
      if(!exact) throw new ChatRetentionError('RETENTION_SCOPE_CONFLICT');
      return Object.freeze({created:false});
    }
    const group=(await transaction.execute({
      sql:`SELECT user_a_id,user_b_id,user_c_id FROM pairing_groups
        WHERE id=? AND week_id=? LIMIT 2`,
      args:[normalized.pairGroupId,normalized.weekId],
    })).rows||[];
    if(group.length!==1) throw new ChatRetentionError('RETENTION_SCOPE_AMBIGUOUS');
    if(normalized.scopeKey==='local'){
      if(localRuntime!==true) throw new ChatRetentionError('RETENTION_SCOPE_AMBIGUOUS');
      const primary=await transaction.execute(`SELECT COUNT(*) AS count FROM circles
        WHERE is_primary=1 AND archived_at IS NULL`);
      if(Number(primary.rows?.[0]?.count||0)!==0) throw new ChatRetentionError('RETENTION_SCOPE_AMBIGUOUS');
    }else{
      const candidate=await transaction.execute({
        sql:`WITH participants(user_id) AS (
            SELECT user_a_id FROM pairing_groups WHERE id=? AND week_id=?
            UNION SELECT user_b_id FROM pairing_groups WHERE id=? AND week_id=?
            UNION SELECT user_c_id FROM pairing_groups WHERE id=? AND week_id=? AND user_c_id IS NOT NULL
          )
          SELECT circle.id FROM circles circle
          WHERE circle.id=? AND circle.is_primary=1 AND circle.archived_at IS NULL
            AND NOT EXISTS (
              SELECT 1 FROM participants participant
              WHERE NOT EXISTS (
                SELECT 1 FROM circle_memberships membership
                WHERE membership.circle_id=circle.id AND membership.user_id=participant.user_id
                  AND membership.status='active'
              )
            ) LIMIT 2`,
        args:[normalized.pairGroupId,normalized.weekId,normalized.pairGroupId,normalized.weekId,
          normalized.pairGroupId,normalized.weekId,normalized.circleId],
      });
      if((candidate.rows||[]).length!==1) throw new ChatRetentionError('RETENTION_SCOPE_AMBIGUOUS');
    }
    await transaction.execute({
      sql:`INSERT INTO chat_retention_scopes
        (week_id,pair_group_id,scope_key,circle_id,registered_at)
        VALUES (?,?,?,?,strftime('%Y-%m-%dT%H:%M:%fZ','now'))`,
      args:[normalized.weekId,normalized.pairGroupId,normalized.scopeKey,normalized.circleId],
    });
    return Object.freeze({created:true});
  });
}

function holdScope(value){
  if(!value||typeof value!=='object'||Array.isArray(value)) throw new TypeError('invalid retention hold');
  const scopeKey=String(value.scopeKey||'').trim();
  const circleId=value.circleId===null||value.circleId===undefined
    ?null:integer(value.circleId,1,Number.MAX_SAFE_INTEGER,'retention circle');
  if(!((scopeKey==='local'&&circleId===null)||(circleId!==null&&scopeKey===`circle:${circleId}`))){
    throw new TypeError('invalid retention hold');
  }
  const holdLevel=String(value.holdLevel||'');
  const weekId=holdLevel==='tenant'?0:integer(value.weekId,1,Number.MAX_SAFE_INTEGER,'retention week');
  const pairGroupId=holdLevel==='tenant'?0:integer(value.pairGroupId,1,Number.MAX_SAFE_INTEGER,'retention pair group');
  if(holdLevel!=='tenant'&&holdLevel!=='room') throw new TypeError('invalid retention hold');
  return Object.freeze({scopeKey,circleId,holdLevel,weekId,pairGroupId});
}

function reasonCode(value){
  const normalized=errorCode(value,'');
  if(!normalized) throw new TypeError('invalid retention reason code');
  return normalized;
}

export async function placeChatRetentionHold(db,{hold,reason}={}){
  validateDb(db);
  const target=holdScope(hold);
  const reasonValue=reasonCode(reason);
  return writeTransaction(db,async transaction=>{
    const known=await transaction.execute(target.holdLevel==='tenant'?{
      sql:`SELECT COUNT(*) AS count FROM chat_retention_scopes WHERE scope_key=?`,args:[target.scopeKey],
    }:{
      sql:`SELECT COUNT(*) AS count FROM chat_retention_scopes
        WHERE scope_key=? AND week_id=? AND pair_group_id=?`,
      args:[target.scopeKey,target.weekId,target.pairGroupId],
    });
    if(Number(known.rows?.[0]?.count||0)<1) throw new ChatRetentionError('RETENTION_SCOPE_UNKNOWN');
    await transaction.execute({
      sql:`INSERT INTO chat_retention_legal_holds
        (scope_key,circle_id,week_id,pair_group_id,hold_level,status,reason_code,created_at,released_at)
        VALUES (?,?,?,?,?,'active',?,strftime('%Y-%m-%dT%H:%M:%fZ','now'),NULL)
        ON CONFLICT(scope_key,week_id,pair_group_id) DO UPDATE SET
          status='active',reason_code=excluded.reason_code,
          created_at=strftime('%Y-%m-%dT%H:%M:%fZ','now'),released_at=NULL`,
      args:[target.scopeKey,target.circleId,target.weekId,target.pairGroupId,target.holdLevel,reasonValue],
    });
    await transaction.execute({
      sql:`UPDATE chat_retention_runs SET status='held',control_generation=NULL,
        lease_owner=NULL,lease_token=NULL,leased_until=NULL,last_error_code='LEGAL_HOLD_ACTIVE',
        updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
        WHERE scope_key=? AND status IN ('pending','processing','retry')
          AND (?='tenant' OR (week_id=? AND pair_group_id=?))`,
      args:[target.scopeKey,target.holdLevel,target.weekId,target.pairGroupId],
    });
    return Object.freeze({active:true});
  });
}

export async function releaseChatRetentionHold(db,{hold}={}){
  validateDb(db);
  const target=holdScope(hold);
  return writeTransaction(db,async transaction=>{
    const released=await transaction.execute({
      sql:`UPDATE chat_retention_legal_holds SET status='released',
        released_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
        WHERE scope_key=? AND week_id=? AND pair_group_id=? AND status='active'`,
      args:[target.scopeKey,target.weekId,target.pairGroupId],
    });
    if(Number(released.rowsAffected||0)!==1) return Object.freeze({released:false});
    await transaction.execute({
      sql:`UPDATE chat_retention_runs SET status='pending',next_attempt_at=strftime('%Y-%m-%dT%H:%M:%fZ','now'),
        last_error_code=NULL,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
        WHERE scope_key=? AND status='held'
          AND NOT EXISTS (SELECT 1 FROM chat_retention_legal_holds hold
            WHERE hold.scope_key=chat_retention_runs.scope_key AND hold.status='active'
              AND (hold.hold_level='tenant' OR
                (hold.week_id=chat_retention_runs.week_id AND hold.pair_group_id=chat_retention_runs.pair_group_id)))`,
      args:[target.scopeKey],
    });
    return Object.freeze({released:true});
  });
}

export async function enqueueNextChatRetentionRun(db,{mode:modeValue,scope:scopeValue,backup,exported,
  maxFailures=CHAT_RETENTION_POLICY.maxFailures}={}){
  validateDb(db);
  const runMode=mode(modeValue);
  const requestedScope=scope(scopeValue);
  const failures=integer(maxFailures,1,20,'retention failure limit');
  return writeTransaction(db,async transaction=>{
    const clock=await databaseClock(transaction);
    const gate=validateGate({backup,exported},clock,requestedScope);
    const control=(await transaction.execute({
      sql:`SELECT enabled,generation FROM chat_retention_control
        WHERE id=1 AND policy_version=? AND retention_days=?`,
      args:[CHAT_RETENTION_POLICY.version,CHAT_RETENTION_POLICY.retentionDays],
    })).rows?.[0];
    if(Number(control?.enabled)!==1) throw new ChatRetentionError('RETENTION_DISABLED');
    const sourceMaxMessageId=gate.sourceMaxMessageId;
    const runKey=retentionRunKey({
      mode:runMode,scope:requestedScope,cutoffAt:clock.cutoff,sourceMaxMessageId,
      backupBindingDigest:gate.backup.scopeBindingDigest,
      exportBindingDigest:gate.exported.scopeBindingDigest,
    });
    const existing=(await transaction.execute({
      sql:`SELECT id,run_key,source_max_message_id,backup_evidence_digest,
        backup_through_at,backup_completed_at,export_evidence_digest,
        export_through_at,export_completed_at FROM chat_retention_runs
        WHERE scope_key=? AND week_id=? AND pair_group_id=? AND cutoff_at=? AND mode=?`,
      args:[requestedScope.scopeKey,requestedScope.weekId,requestedScope.pairGroupId,
        clock.cutoff,runMode],
    })).rows?.[0];
    if(existing){
      const exact=String(existing.run_key)===runKey
        &&Number(existing.source_max_message_id)===sourceMaxMessageId
        &&String(existing.backup_evidence_digest)===gate.backup.digest
        &&String(existing.backup_through_at)===gate.backup.throughAt
        &&String(existing.backup_completed_at)===gate.backup.completedAt
        &&String(existing.export_evidence_digest)===gate.exported.digest
        &&String(existing.export_through_at)===gate.exported.throughAt
        &&String(existing.export_completed_at)===gate.exported.completedAt;
      if(!exact) throw new ChatRetentionError('RETENTION_EVIDENCE_CONFLICT');
      return Object.freeze({created:false,runId:Number(existing.id),cutoffAt:clock.cutoff});
    }
    const anchor=await transaction.execute({
      sql:`SELECT COUNT(*) AS count FROM pair_messages
        WHERE id=? AND week_id=? AND pair_group_id=?`,
      args:[gate.sourceMaxMessageId,requestedScope.weekId,requestedScope.pairGroupId],
    });
    if(Number(anchor.rows?.[0]?.count||0)!==1){
      throw new ChatRetentionError('RETENTION_EVIDENCE_SOURCE_MISMATCH');
    }
    const candidate=(await transaction.execute({
      sql:`SELECT scope.scope_key,scope.circle_id,messages.week_id,messages.pair_group_id
        FROM pair_messages messages
        JOIN chat_retention_scopes scope
          ON scope.week_id=messages.week_id AND scope.pair_group_id=messages.pair_group_id
        WHERE scope.scope_key=? AND scope.circle_id IS ?
          AND scope.week_id=? AND scope.pair_group_id=?
          AND messages.id<=?
          AND julianday(messages.created_at) IS NOT NULL
          AND julianday(messages.created_at)<julianday(?)
          AND NOT EXISTS (SELECT 1 FROM chat_retention_legal_holds hold
            WHERE hold.scope_key=scope.scope_key AND hold.status='active'
              AND (hold.hold_level='tenant' OR
                (hold.week_id=scope.week_id AND hold.pair_group_id=scope.pair_group_id)))
          AND NOT EXISTS (SELECT 1 FROM chat_retention_runs run
            WHERE run.scope_key=scope.scope_key AND run.week_id=scope.week_id
              AND run.pair_group_id=scope.pair_group_id AND run.cutoff_at=? AND run.mode=?)
        ORDER BY julianday(messages.created_at),messages.id LIMIT 1`,
      args:[requestedScope.scopeKey,requestedScope.circleId,requestedScope.weekId,
        requestedScope.pairGroupId,gate.sourceMaxMessageId,clock.cutoff,clock.cutoff,runMode],
    })).rows?.[0];
    if(!candidate) return Object.freeze({created:false,runId:null,cutoffAt:clock.cutoff});
    const candidateScope=scope({
      scopeKey:String(candidate.scope_key),circleId:candidate.circle_id,
      weekId:Number(candidate.week_id),pairGroupId:Number(candidate.pair_group_id),
    });
    const inserted=await transaction.execute({
      sql:`INSERT INTO chat_retention_runs
        (run_key,mode,scope_key,circle_id,week_id,pair_group_id,cutoff_at,source_max_message_id,status,
         checkpoint,scan_cursor_id,claim_count,failure_count,max_failures,next_attempt_at,
         backup_evidence_digest,backup_through_at,backup_completed_at,
         export_evidence_digest,export_through_at,export_completed_at,created_at,updated_at)
        VALUES (?,?,?,?,?,?,?,?,'pending',0,0,0,0,?, ?,?,?,?,?,?,?,?,?)
        ON CONFLICT(scope_key,week_id,pair_group_id,cutoff_at,mode) DO NOTHING`,
      args:[runKey,runMode,candidateScope.scopeKey,candidateScope.circleId,
        candidateScope.weekId,candidateScope.pairGroupId,clock.cutoff,sourceMaxMessageId,failures,clock.now,
        gate.backup.digest,gate.backup.throughAt,gate.backup.completedAt,
        gate.exported.digest,gate.exported.throughAt,gate.exported.completedAt,clock.now,clock.now],
    });
    const run=(await transaction.execute({
      sql:`SELECT id,run_key,source_max_message_id,backup_evidence_digest,backup_through_at,backup_completed_at,
        export_evidence_digest,export_through_at,export_completed_at
        FROM chat_retention_runs WHERE scope_key=? AND week_id=? AND pair_group_id=?
          AND cutoff_at=? AND mode=?`,args:[candidateScope.scopeKey,candidateScope.weekId,
        candidateScope.pairGroupId,clock.cutoff,runMode],
    })).rows?.[0];
    if(!run) throw new ChatRetentionError('RETENTION_RUN_INTEGRITY');
    const exact=String(run.run_key)===runKey
      &&Number(run.source_max_message_id)===sourceMaxMessageId
      &&String(run.backup_evidence_digest)===gate.backup.digest
      &&String(run.backup_through_at)===gate.backup.throughAt
      &&String(run.backup_completed_at)===gate.backup.completedAt
      &&String(run.export_evidence_digest)===gate.exported.digest
      &&String(run.export_through_at)===gate.exported.throughAt
      &&String(run.export_completed_at)===gate.exported.completedAt;
    if(!exact) throw new ChatRetentionError('RETENTION_EVIDENCE_CONFLICT');
    const created=Number(inserted.rowsAffected||0)===1;
    if(created) await transaction.execute(auditStatement({
      runId:Number(run.id),action:'enqueued',fromStatus:null,toStatus:'pending',
    }));
    return Object.freeze({created,runId:Number(run.id),cutoffAt:clock.cutoff});
  });
}

function runFromRow(row){
  if(!row) return null;
  const result={
    id:Number(row.id),mode:String(row.mode),scopeKey:String(row.scope_key),
    circleId:row.circle_id===null?null:Number(row.circle_id),weekId:Number(row.week_id),
    pairGroupId:Number(row.pair_group_id),cutoffAt:String(row.cutoff_at),
    sourceMaxMessageId:Number(row.source_max_message_id),
    checkpoint:Number(row.checkpoint),scanCursorId:Number(row.scan_cursor_id),
    failureCount:Number(row.failure_count),maxFailures:Number(row.max_failures),
    controlGeneration:Number(row.control_generation),leaseToken:String(row.lease_token||''),
  };
  scope(result);
  if(!MODES.has(result.mode)||!Number.isSafeInteger(result.id)||result.id<1
    ||!Number.isSafeInteger(result.checkpoint)||result.checkpoint<0
    ||!Number.isSafeInteger(result.scanCursorId)||result.scanCursorId<0
    ||!Number.isSafeInteger(result.sourceMaxMessageId)||result.sourceMaxMessageId<1
    ||!Number.isSafeInteger(result.controlGeneration)||result.controlGeneration<1
    ||!result.leaseToken){
    throw new ChatRetentionError('RETENTION_RUN_CORRUPT');
  }
  return Object.freeze(result);
}

export async function claimChatRetentionRun(db,{workerId:worker,mode:modeValue,
  leaseDurationMs=CHAT_RETENTION_POLICY.leaseDurationMs}={}){
  validateBatchDb(db);
  const owner=workerId(worker);
  const runMode=mode(modeValue);
  const leaseMs=integer(leaseDurationMs,1_000,300_000,'retention lease');
  const modifier=`+${(leaseMs/1000).toFixed(3)} seconds`;
  for(let attempt=1;attempt<=4;attempt+=1){
    try{
      const leaseToken=randomUUID();
      const results=await db.batch([{
        sql:`UPDATE chat_retention_runs SET status='processing',claim_count=claim_count+1,
          control_generation=(SELECT generation FROM chat_retention_control WHERE id=1),
          lease_owner=?,lease_token=?,leased_until=strftime('%Y-%m-%dT%H:%M:%fZ','now',?),
          last_error_code=NULL,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
          WHERE id=(
            SELECT run.id FROM chat_retention_runs run
            JOIN chat_retention_control control ON control.id=1 AND control.enabled=1
              AND control.policy_version=? AND control.retention_days=?
            JOIN chat_retention_scopes scope ON scope.scope_key=run.scope_key
              AND scope.week_id=run.week_id AND scope.pair_group_id=run.pair_group_id
              AND scope.circle_id IS run.circle_id
            WHERE run.mode=? AND run.failure_count<run.max_failures
              AND run.next_attempt_at<=strftime('%Y-%m-%dT%H:%M:%fZ','now')
              AND (run.status IN ('pending','retry') OR
                (run.status='processing' AND (run.leased_until<=strftime('%Y-%m-%dT%H:%M:%fZ','now')
                  OR run.control_generation<>control.generation)))
              AND NOT EXISTS (SELECT 1 FROM chat_retention_legal_holds hold
                WHERE hold.scope_key=run.scope_key AND hold.status='active'
                  AND (hold.hold_level='tenant' OR
                    (hold.week_id=run.week_id AND hold.pair_group_id=run.pair_group_id)))
            ORDER BY run.next_attempt_at,run.id LIMIT 1
          )`,
        args:[owner,leaseToken,modifier,CHAT_RETENTION_POLICY.version,
          CHAT_RETENTION_POLICY.retentionDays,runMode],
      },{
        sql:`INSERT INTO chat_retention_audit_events
          (retention_run_id,action,from_status,to_status,item_count,duration_ms,reason_code)
          SELECT id,'claimed',NULL,'processing',0,0,NULL FROM chat_retention_runs
          WHERE lease_owner=? AND lease_token=? AND status='processing'`,
        args:[owner,leaseToken],
      }],'write');
      if(Number(results?.[0]?.rowsAffected||0)===0) return null;
      if(Number(results?.[0]?.rowsAffected||0)!==1||Number(results?.[1]?.rowsAffected||0)!==1){
        throw new ChatRetentionError('RETENTION_CLAIM_INTEGRITY');
      }
      return runFromRow((await db.execute({
        sql:`SELECT id,mode,scope_key,circle_id,week_id,pair_group_id,cutoff_at,
          source_max_message_id,checkpoint,scan_cursor_id,failure_count,max_failures,
          control_generation,lease_token
          FROM chat_retention_runs WHERE lease_owner=? AND lease_token=? AND status='processing'`,
        args:[owner,leaseToken],
      })).rows?.[0]);
    }catch(error){
      if(!retryableConflict(error)||attempt===4) throw error;
      await retryDelay(attempt);
    }
  }
  return null;
}

export async function heartbeatChatRetentionLease(db,{runId,leaseToken,workerId:worker,
  controlGeneration,leaseDurationMs=CHAT_RETENTION_POLICY.leaseDurationMs}={}){
  validateDb(db);
  const id=integer(runId,1,Number.MAX_SAFE_INTEGER,'retention run');
  const owner=workerId(worker);
  const generation=integer(controlGeneration,1,Number.MAX_SAFE_INTEGER,'retention control generation');
  const leaseMs=integer(leaseDurationMs,1_000,300_000,'retention lease');
  const token=String(leaseToken||'');
  if(!token) throw new TypeError('invalid retention lease token');
  const result=await db.execute({
    sql:`UPDATE chat_retention_runs SET
      leased_until=MAX(leased_until,strftime('%Y-%m-%dT%H:%M:%fZ','now',?)),
      updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
      WHERE id=? AND status='processing' AND lease_owner=? AND lease_token=?
        AND control_generation=? AND leased_until>strftime('%Y-%m-%dT%H:%M:%fZ','now')
        AND EXISTS (SELECT 1 FROM chat_retention_control
          WHERE id=1 AND enabled=1 AND generation=?)`,
    args:[`+${(leaseMs/1000).toFixed(3)} seconds`,id,owner,token,generation,generation],
  });
  return Number(result.rowsAffected||0)===1;
}

function activeHoldSql(alias='run'){
  return `EXISTS (SELECT 1 FROM chat_retention_legal_holds hold
    WHERE hold.scope_key=${alias}.scope_key AND hold.status='active'
      AND (hold.hold_level='tenant' OR
        (hold.week_id=${alias}.week_id AND hold.pair_group_id=${alias}.pair_group_id)))`;
}

export async function processChatRetentionBatch(db,runValue,{workerId:worker,
  batchSize=CHAT_RETENTION_POLICY.batchSize,
  leaseDurationMs=CHAT_RETENTION_POLICY.leaseDurationMs}={}){
  const startedAt=performance.now();
  validateDb(db);
  const owner=workerId(worker);
  const size=integer(batchSize,1,100,'retention batch size');
  const leaseMs=integer(leaseDurationMs,1_000,300_000,'retention lease');
  const run=runFromRow({
    id:runValue?.id,mode:runValue?.mode,scope_key:runValue?.scopeKey,
    circle_id:runValue?.circleId,week_id:runValue?.weekId,pair_group_id:runValue?.pairGroupId,
    cutoff_at:runValue?.cutoffAt,source_max_message_id:runValue?.sourceMaxMessageId,
    checkpoint:runValue?.checkpoint,
    scan_cursor_id:runValue?.scanCursorId,failure_count:runValue?.failureCount,
    max_failures:runValue?.maxFailures,control_generation:runValue?.controlGeneration,
    lease_token:runValue?.leaseToken,
  });
  return writeTransaction(db,async transaction=>{
    const owned=(await transaction.execute({
      sql:`SELECT run.*,control.enabled AS control_enabled,control.generation AS live_generation,
          scope.scope_key AS live_scope_key
        FROM chat_retention_runs run
        LEFT JOIN chat_retention_control control ON control.id=1
        LEFT JOIN chat_retention_scopes scope ON scope.week_id=run.week_id
          AND scope.pair_group_id=run.pair_group_id AND scope.scope_key=run.scope_key
          AND scope.circle_id IS run.circle_id
        WHERE run.id=? AND run.status='processing' AND run.lease_owner=? AND run.lease_token=?
          AND run.leased_until>strftime('%Y-%m-%dT%H:%M:%fZ','now')`,
      args:[run.id,owner,run.leaseToken],
    })).rows?.[0];
    if(!owned) return Object.freeze({leaseLost:true,status:'lease_lost',count:0});
    if(Number(owned.control_enabled)!==1||Number(owned.live_generation)!==run.controlGeneration){
      return Object.freeze({leaseLost:true,status:'fenced',count:0});
    }
    if(!owned.live_scope_key) throw new ChatRetentionError('RETENTION_SCOPE_CHANGED');
    const clock=await databaseClock(transaction);
    const gate=validateGate({
      backup:{
        digest:String(owned.backup_evidence_digest),throughAt:String(owned.backup_through_at),
        completedAt:String(owned.backup_completed_at),sourceMaxMessageId:run.sourceMaxMessageId,
        scopeBindingDigest:chatRetentionEvidenceBindingDigest({
          kind:'backup',scope:run,sourceMaxMessageId:run.sourceMaxMessageId,
          digest:String(owned.backup_evidence_digest),throughAt:String(owned.backup_through_at),
          completedAt:String(owned.backup_completed_at),
        }),
      },
      exported:{
        digest:String(owned.export_evidence_digest),throughAt:String(owned.export_through_at),
        completedAt:String(owned.export_completed_at),sourceMaxMessageId:run.sourceMaxMessageId,
        scopeBindingDigest:chatRetentionEvidenceBindingDigest({
          kind:'export',scope:run,sourceMaxMessageId:run.sourceMaxMessageId,
          digest:String(owned.export_evidence_digest),throughAt:String(owned.export_through_at),
          completedAt:String(owned.export_completed_at),
        }),
      },
    },{now:clock.now,cutoff:String(owned.cutoff_at)},run);
    const expectedRunKey=retentionRunKey({
      mode:run.mode,scope:run,cutoffAt:run.cutoffAt,sourceMaxMessageId:run.sourceMaxMessageId,
      backupBindingDigest:gate.backup.scopeBindingDigest,
      exportBindingDigest:gate.exported.scopeBindingDigest,
    });
    if(String(owned.run_key)!==expectedRunKey){
      throw new ChatRetentionError('RETENTION_EVIDENCE_CONFLICT');
    }
    const held=(await transaction.execute({
      sql:`SELECT ${activeHoldSql('run')} AS held FROM chat_retention_runs run WHERE run.id=?`,
      args:[run.id],
    })).rows?.[0];
    if(Number(held?.held)===1){
      await transaction.execute({
        sql:`UPDATE chat_retention_runs SET status='held',control_generation=NULL,
          lease_owner=NULL,lease_token=NULL,leased_until=NULL,last_error_code='LEGAL_HOLD_ACTIVE',
          updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=? AND lease_owner=? AND lease_token=?`,
        args:[run.id,owner,run.leaseToken],
      });
      await transaction.execute(auditStatement({
        runId:run.id,action:'held',fromStatus:'processing',toStatus:'held',reasonCode:'LEGAL_HOLD_ACTIVE',
        durationMs:Math.max(0,Math.floor(performance.now()-startedAt)),
      }));
      return Object.freeze({leaseLost:false,status:'held',count:0});
    }
    const invalid=await transaction.execute({
      sql:`SELECT EXISTS(SELECT 1 FROM pair_messages WHERE week_id=? AND pair_group_id=? AND id<=?
        AND julianday(created_at) IS NULL LIMIT 1) AS present`,
      args:[run.weekId,run.pairGroupId,run.sourceMaxMessageId],
    });
    if(Number(invalid.rows?.[0]?.present)===1){
      throw new ChatRetentionError('RETENTION_TIMESTAMP_INVALID');
    }
    const future=await transaction.execute({
      sql:`SELECT EXISTS(SELECT 1 FROM pair_messages WHERE week_id=? AND pair_group_id=? AND id<=?
        AND julianday(created_at)>julianday(?) LIMIT 1) AS present`,
      args:[run.weekId,run.pairGroupId,run.sourceMaxMessageId,clock.now],
    });
    if(Number(future.rows?.[0]?.present)===1){
      throw new ChatRetentionError('RETENTION_TIMESTAMP_FUTURE');
    }
    const rows=(await transaction.execute({
      sql:`SELECT id FROM pair_messages
        WHERE week_id=? AND pair_group_id=? AND id<=?
          AND julianday(created_at)<julianday(?)
          ${run.mode==='dry_run'?'AND id>?':''}
        ORDER BY ${run.mode==='dry_run'?'id':'julianday(created_at),id'} LIMIT ?`,
      args:run.mode==='dry_run'
        ?[run.weekId,run.pairGroupId,run.sourceMaxMessageId,run.cutoffAt,Number(owned.scan_cursor_id),size]
        :[run.weekId,run.pairGroupId,run.sourceMaxMessageId,run.cutoffAt,size],
    })).rows||[];
    if(rows.length===0){
      const complete=await transaction.execute({
        sql:`UPDATE chat_retention_runs SET status='completed',control_generation=NULL,
          lease_owner=NULL,lease_token=NULL,leased_until=NULL,completed_at=strftime('%Y-%m-%dT%H:%M:%fZ','now'),
          updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
          WHERE id=? AND status='processing' AND lease_owner=? AND lease_token=?
            AND control_generation=? AND EXISTS (SELECT 1 FROM chat_retention_control
              WHERE id=1 AND enabled=1 AND generation=?)`,
        args:[run.id,owner,run.leaseToken,run.controlGeneration,run.controlGeneration],
      });
      if(Number(complete.rowsAffected||0)!==1) return Object.freeze({leaseLost:true,status:'fenced',count:0});
      await transaction.execute(auditStatement({
        runId:run.id,action:'completed',fromStatus:'processing',toStatus:'completed',
        durationMs:Math.max(0,Math.floor(performance.now()-startedAt)),
      }));
      return Object.freeze({leaseLost:false,status:'completed',count:0});
    }
    const ids=rows.map(row=>integer(row.id,1,Number.MAX_SAFE_INTEGER,'retention message'));
    if(run.mode==='purge'){
      const placeholders=ids.map(()=>'?').join(',');
      const deleted=await transaction.execute({
        sql:`DELETE FROM pair_messages WHERE week_id=? AND pair_group_id=? AND id<=?
          AND id IN (${placeholders}) AND julianday(created_at)<julianday(?)
          AND EXISTS (SELECT 1 FROM chat_retention_control
            WHERE id=1 AND enabled=1 AND generation=?)
          AND NOT EXISTS (SELECT 1 FROM chat_retention_legal_holds hold
            WHERE hold.scope_key=? AND hold.status='active'
              AND (hold.hold_level='tenant' OR (hold.week_id=? AND hold.pair_group_id=?)))`,
        args:[run.weekId,run.pairGroupId,run.sourceMaxMessageId,...ids,run.cutoffAt,run.controlGeneration,
          run.scopeKey,run.weekId,run.pairGroupId],
      });
      if(Number(deleted.rowsAffected||0)!==ids.length){
        throw new ChatRetentionError('RETENTION_DELETE_FENCED');
      }
    }
    const lastId=Math.max(...ids);
    const updated=await transaction.execute({
      sql:`UPDATE chat_retention_runs SET checkpoint=checkpoint+1,
        scan_cursor_id=CASE WHEN mode='dry_run' THEN ? ELSE scan_cursor_id END,
        eligible_count=eligible_count+?,deleted_count=deleted_count+?,
        leased_until=MAX(leased_until,strftime('%Y-%m-%dT%H:%M:%fZ','now',?)),
        updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
        WHERE id=? AND status='processing' AND lease_owner=? AND lease_token=?
          AND control_generation=? AND EXISTS (SELECT 1 FROM chat_retention_control
            WHERE id=1 AND enabled=1 AND generation=?)`,
      args:[lastId,ids.length,run.mode==='purge'?ids.length:0,
        `+${(leaseMs/1000).toFixed(3)} seconds`,run.id,owner,run.leaseToken,
        run.controlGeneration,run.controlGeneration],
    });
    if(Number(updated.rowsAffected||0)!==1) throw new ChatRetentionError('RETENTION_LEASE_LOST');
    await transaction.execute(auditStatement({
      runId:run.id,action:run.mode==='purge'?'batch_deleted':'batch_scanned',
      fromStatus:'processing',toStatus:'processing',itemCount:ids.length,
      durationMs:Math.max(0,Math.floor(performance.now()-startedAt)),
    }));
    return Object.freeze({leaseLost:false,status:'processing',count:ids.length,lastId});
  });
}

async function yieldChatRetentionRun(db,run,{workerId:worker}){
  const owner=workerId(worker);
  return writeTransaction(db,async transaction=>{
    const result=await transaction.execute({
      sql:`UPDATE chat_retention_runs SET status='pending',control_generation=NULL,
        lease_owner=NULL,lease_token=NULL,leased_until=NULL,next_attempt_at=strftime('%Y-%m-%dT%H:%M:%fZ','now'),
        updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
        WHERE id=? AND status='processing' AND lease_owner=? AND lease_token=?
          AND control_generation=? AND leased_until>strftime('%Y-%m-%dT%H:%M:%fZ','now')
          AND EXISTS (SELECT 1 FROM chat_retention_control WHERE id=1 AND enabled=1 AND generation=?)`,
      args:[run.id,owner,run.leaseToken,run.controlGeneration,run.controlGeneration],
    });
    if(Number(result.rowsAffected||0)!==1) return false;
    await transaction.execute(auditStatement({
      runId:run.id,action:'yielded',fromStatus:'processing',toStatus:'pending',
    }));
    return true;
  });
}

async function failChatRetentionRun(db,run,error,{workerId:worker,
  baseBackoffMs=CHAT_RETENTION_POLICY.baseBackoffMs,
  maxBackoffMs=CHAT_RETENTION_POLICY.maxBackoffMs}={}){
  const owner=workerId(worker);
  const code=errorCode(error instanceof ChatRetentionError?error.code:'RETENTION_FAILED');
  const retryable=!(error instanceof ChatRetentionError)||error.retryable;
  return writeTransaction(db,async transaction=>{
    const row=(await transaction.execute({
      sql:`SELECT run.failure_count,run.max_failures FROM chat_retention_runs run
        JOIN chat_retention_control control ON control.id=1 AND control.enabled=1
          AND control.generation=run.control_generation
        WHERE run.id=? AND run.status='processing' AND run.lease_owner=? AND run.lease_token=?
          AND run.control_generation=? AND run.leased_until>strftime('%Y-%m-%dT%H:%M:%fZ','now')`,
      args:[run.id,owner,run.leaseToken,run.controlGeneration],
    })).rows?.[0];
    if(!row) return Object.freeze({leaseLost:true,status:'lease_lost'});
    const failures=Number(row.failure_count)+1;
    const deadLetter=!retryable||failures>=Number(row.max_failures);
    const status=deadLetter?'dead_letter':'retry';
    const delay=Math.min(maxBackoffMs,baseBackoffMs*(2**Math.max(0,failures-1)));
    const result=await transaction.execute({
      sql:`UPDATE chat_retention_runs SET status=?,failure_count=?,control_generation=NULL,
        lease_owner=NULL,lease_token=NULL,leased_until=NULL,last_error_code=?,
        next_attempt_at=strftime('%Y-%m-%dT%H:%M:%fZ','now',?),
        dead_lettered_at=CASE WHEN ?='dead_letter' THEN strftime('%Y-%m-%dT%H:%M:%fZ','now') ELSE NULL END,
        updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
        WHERE id=? AND status='processing' AND lease_owner=? AND lease_token=? AND control_generation=?`,
      args:[status,failures,code,`+${(delay/1000).toFixed(3)} seconds`,status,
        run.id,owner,run.leaseToken,run.controlGeneration],
    });
    if(Number(result.rowsAffected||0)!==1) return Object.freeze({leaseLost:true,status:'lease_lost'});
    await transaction.execute(auditStatement({
      runId:run.id,action:deadLetter?'dead_lettered':'retry_scheduled',
      fromStatus:'processing',toStatus:status,reasonCode:code,
    }));
    return Object.freeze({leaseLost:false,status});
  });
}

export async function runChatRetentionWorker({db,workerId:worker,enabled,
  mode:modeValue,batchSize=CHAT_RETENTION_POLICY.batchSize,
  maxBatches=CHAT_RETENTION_POLICY.maxBatchesPerInvocation,
  leaseDurationMs=CHAT_RETENTION_POLICY.leaseDurationMs}={}){
  const startedAt=performance.now();
  const finish=result=>Object.freeze({
    ...result,durationMs:Math.max(0,Math.floor(performance.now()-startedAt)),
  });
  validateDb(db);
  if(enabled!==true) return finish({disabled:true,claimed:0,batches:0,eligible:0,deleted:0,status:'disabled'});
  const owner=workerId(worker);
  const runMode=mode(modeValue);
  const batchesLimit=integer(maxBatches,1,20,'retention batch limit');
  const size=integer(batchSize,1,100,'retention batch size');
  const run=await claimChatRetentionRun(db,{workerId:owner,mode:runMode,leaseDurationMs});
  if(!run) return finish({disabled:false,claimed:0,batches:0,eligible:0,deleted:0,status:'idle'});
  let batches=0;
  let eligible=0;
  let deleted=0;
  try{
    while(batches<batchesLimit){
      const outcome=await processChatRetentionBatch(db,run,{workerId:owner,batchSize:size,leaseDurationMs});
      if(outcome.leaseLost){
        return finish({disabled:false,claimed:1,batches,eligible,deleted,status:outcome.status});
      }
      if(outcome.status!=='processing'){
        return finish({disabled:false,claimed:1,batches,eligible,deleted,status:outcome.status});
      }
      batches+=1;
      eligible+=outcome.count;
      if(runMode==='purge') deleted+=outcome.count;
    }
    const yielded=await yieldChatRetentionRun(db,run,{workerId:owner});
    return finish({disabled:false,claimed:1,batches,eligible,deleted,
      status:yielded?'pending':'lease_lost'});
  }catch(error){
    const failed=await failChatRetentionRun(db,run,error,{workerId:owner});
    return finish({disabled:false,claimed:1,batches,eligible,deleted,status:failed.status});
  }
}

export async function replayChatRetentionRun(db,{runId,reason}={}){
  validateDb(db);
  const id=integer(runId,1,Number.MAX_SAFE_INTEGER,'retention run');
  const reasonValue=reasonCode(reason);
  if(!REPLAY_REASONS.has(reasonValue)) throw new TypeError('invalid retention replay reason');
  return writeTransaction(db,async transaction=>{
    const result=await transaction.execute({
      sql:`UPDATE chat_retention_runs SET status='pending',failure_count=0,control_generation=NULL,
        lease_owner=NULL,lease_token=NULL,leased_until=NULL,last_error_code=NULL,dead_lettered_at=NULL,
        replay_count=replay_count+1,next_attempt_at=strftime('%Y-%m-%dT%H:%M:%fZ','now'),
        updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
        WHERE id=? AND status='dead_letter'
          AND NOT ${activeHoldSql('chat_retention_runs')}`,args:[id],
    });
    if(Number(result.rowsAffected||0)!==1) return false;
    await transaction.execute(auditStatement({
      runId:id,action:'replayed',fromStatus:'dead_letter',toStatus:'pending',reasonCode:reasonValue,
    }));
    return true;
  });
}

export async function readChatRetentionMetrics(db){
  if(!db||typeof db.execute!=='function') throw new TypeError('database client required');
  const [control,runs,holds,anomalies]=await Promise.all([
    db.execute(`SELECT enabled,generation,policy_version,retention_days
      FROM chat_retention_control WHERE id=1`),
    db.execute(`SELECT mode,status,COUNT(*) AS count,SUM(eligible_count) AS eligible_count,
      SUM(deleted_count) AS deleted_count,MIN(created_at) AS oldest_created_at
      FROM chat_retention_runs GROUP BY mode,status ORDER BY mode,status`),
    db.execute(`SELECT hold_level,COUNT(*) AS count FROM chat_retention_legal_holds
      WHERE status='active' GROUP BY hold_level ORDER BY hold_level`),
    db.execute(`SELECT
      (SELECT COUNT(*) FROM (SELECT 1 FROM pair_messages message
        LEFT JOIN chat_retention_scopes scope ON scope.week_id=message.week_id
          AND scope.pair_group_id=message.pair_group_id
        WHERE scope.week_id IS NULL LIMIT 1001)) AS unmapped_count,
      (SELECT COUNT(*) FROM (SELECT 1 FROM pair_messages
        WHERE julianday(created_at) IS NULL LIMIT 1001)) AS invalid_timestamp_count,
      (SELECT COUNT(*) FROM (SELECT 1 FROM pair_messages
        WHERE julianday(created_at)>julianday('now') LIMIT 1001)) AS future_timestamp_count`),
  ]);
  const controlRow=control.rows?.[0];
  return Object.freeze({
    control:Object.freeze({
      present:Boolean(controlRow),enabled:Number(controlRow?.enabled)===1,
      generation:controlRow?Number(controlRow.generation):0,
      policyVersion:controlRow?String(controlRow.policy_version):CHAT_RETENTION_POLICY.version,
      retentionDays:controlRow?Number(controlRow.retention_days):CHAT_RETENTION_POLICY.retentionDays,
    }),
    runs:Object.freeze((runs.rows||[]).map(row=>Object.freeze({
      mode:String(row.mode),status:String(row.status),count:Number(row.count),
      eligibleCount:Number(row.eligible_count||0),deletedCount:Number(row.deleted_count||0),
      oldestCreatedAt:String(row.oldest_created_at||''),
    }))),
    holds:Object.freeze((holds.rows||[]).map(row=>Object.freeze({
      level:String(row.hold_level),count:Number(row.count),
    }))),
    anomalies:Object.freeze({
      unmappedCount:Number(anomalies.rows?.[0]?.unmapped_count||0),
      unmappedCountCapped:Number(anomalies.rows?.[0]?.unmapped_count||0)>=1001,
      invalidTimestampCount:Number(anomalies.rows?.[0]?.invalid_timestamp_count||0),
      invalidTimestampCountCapped:Number(anomalies.rows?.[0]?.invalid_timestamp_count||0)>=1001,
      futureTimestampCount:Number(anomalies.rows?.[0]?.future_timestamp_count||0),
      futureTimestampCountCapped:Number(anomalies.rows?.[0]?.future_timestamp_count||0)>=1001,
    }),
  });
}
