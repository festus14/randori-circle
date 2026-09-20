import { setTimeout as delay } from 'node:timers/promises';

import { normalizeCirclePublicId } from './_active-circle.js';
import { requireRecentAuth } from './_recent-auth.js';

const SESSION_HASH_PATTERN=/^[0-9a-f]{64}$/;

export class CircleArchiveError extends Error{
  constructor(code,message,{cause}={}){
    super(message,cause===undefined?undefined:{cause});
    this.name='CircleArchiveError';
    this.code=code;
  }
}

function fail(code,message,options){ throw new CircleArchiveError(code,message,options); }

function exactObject(value,keys){
  return !!value&&typeof value==='object'&&!Array.isArray(value)
    &&Object.keys(value).length===keys.length
    &&keys.every(key=>Object.prototype.hasOwnProperty.call(value,key));
}

function contextVersion(value){
  return Number.isSafeInteger(value)&&value>=0?value:null;
}

function identity(payload){
  const rawId=payload?.id??payload?.uid;
  const userId=typeof rawId==='number'?rawId
    :(typeof rawId==='string'&&/^[1-9]\d*$/.test(rawId)?Number(rawId):null);
  const sessionHash=typeof payload?.sessionHash==='string'&&SESSION_HASH_PATTERN.test(payload.sessionHash)
    ?payload.sessionHash:null;
  return Number.isSafeInteger(userId)&&userId>0&&sessionHash?Object.freeze({userId,sessionHash}):null;
}

export function parseCircleArchive(body){
  if(!exactObject(body,['circle_public_id','expected_context_version'])){
    fail('CIRCLE_ARCHIVE_INPUT_INVALID','Request body must contain only circle_public_id and expected_context_version.');
  }
  const circlePublicId=normalizeCirclePublicId(body.circle_public_id);
  const expectedContextVersion=contextVersion(body.expected_context_version);
  if(!circlePublicId||body.circle_public_id!==circlePublicId||expectedContextVersion===null){
    fail('CIRCLE_ARCHIVE_INPUT_INVALID','Circle archive input is invalid.');
  }
  return Object.freeze({circlePublicId,expectedContextVersion});
}

async function rollback(transaction){ try{ await transaction.rollback(); }catch{} }

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

async function archiveAttempt(db,actor,input,{nowSeconds}={}){
  let transaction;
  let finished=false;
  let commitStarted=false;
  try{
    transaction=await db.transaction('write');
    const clock=await transaction.execute(`SELECT CAST(strftime('%s','now') AS INTEGER) AS now_seconds,
      strftime('%Y-%m-%dT%H:%M:%fZ','now') AS now_utc`);
    const databaseNow=Number(clock.rows?.[0]?.now_seconds);
    const occurredAt=String(clock.rows?.[0]?.now_utc||'');
    const effectiveNow=nowSeconds===undefined?databaseNow:nowSeconds;
    if(!Number.isSafeInteger(databaseNow)||databaseNow<1||!Number.isSafeInteger(effectiveNow)||effectiveNow<1
      ||!/^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$/.test(occurredAt)){
      fail('CIRCLE_ARCHIVE_UNAVAILABLE','Circle archive is unavailable.');
    }
    const live=await transaction.execute({
      sql:`SELECT account.id
        FROM auth_sessions session JOIN auth_accounts account ON account.id=session.user_id
        WHERE session.session_hash=? AND session.user_id=? AND session.revoked_at IS NULL
          AND session.expires_at>? AND COALESCE(account.is_demo,0)=0
        LIMIT 2`,
      args:[actor.sessionHash,actor.userId,databaseNow],
    });
    if(live.rows?.length!==1){
      await rollback(transaction); finished=true;
      return Object.freeze({ok:false,reason:'session_changed'});
    }

    const target=await transaction.execute({
      sql:`SELECT circle.id,circle.public_id,circle.name,circle.is_primary,circle.archived_at,
          membership.role,membership.status,audit.actor_user_id AS archived_by,
          audit.event_type AS archive_event_type,audit.dedupe_key AS archive_dedupe_key
        FROM circles circle
        JOIN circle_memberships membership ON membership.circle_id=circle.id
          AND membership.user_id=? AND membership.role='owner' AND membership.status='active'
        LEFT JOIN circle_audit_events audit ON audit.circle_id=circle.id
          AND audit.event_type='circle.archived'
          AND audit.dedupe_key=('circle-archived:'||circle.id)
        WHERE circle.public_id=? LIMIT 2`,
      args:[actor.userId,input.circlePublicId],
    });
    if(target.rows?.length!==1){
      await rollback(transaction); finished=true;
      return Object.freeze({ok:false,reason:'circle_unavailable'});
    }
    const row=target.rows[0];
    const circleId=Number(row.id);
    if(!Number.isSafeInteger(circleId)||circleId<1||String(row.public_id)!==input.circlePublicId){
      fail('CIRCLE_ARCHIVE_INTEGRITY','Circle archive target is invalid.');
    }
    await requireRecentAuth(transaction,{id:actor.userId,sessionHash:actor.sessionHash},{nowSeconds:effectiveNow});

    if(Number(row.is_primary)===1){
      await rollback(transaction); finished=true;
      return Object.freeze({ok:false,reason:'primary_circle'});
    }

    if(row.archived_at!==null){
      if(Number(row.archived_by)!==actor.userId||String(row.archive_event_type)!=='circle.archived'
        ||String(row.archive_dedupe_key)!==`circle-archived:${circleId}`){
        await rollback(transaction); finished=true;
        return Object.freeze({ok:false,reason:'circle_unavailable'});
      }
      await rollback(transaction); finished=true;
      return Object.freeze({ok:true,changed:false,circle:Object.freeze({
        public_id:input.circlePublicId,name:String(row.name||'').slice(0,120),
      })});
    }

    const selected=await transaction.execute({
      sql:`SELECT context.circle_id,context.context_version
        FROM auth_session_circle_contexts context
        WHERE context.session_hash=? AND context.user_id=? LIMIT 2`,
      args:[actor.sessionHash,actor.userId],
    });
    const currentVersion=selected.rows?.length===1?Number(selected.rows[0].context_version):0;
    if(selected.rows?.length!==1||Number(selected.rows[0].circle_id)!==circleId
      ||!Number.isSafeInteger(currentVersion)||currentVersion!==input.expectedContextVersion){
      await rollback(transaction); finished=true;
      return Object.freeze({ok:false,reason:'context_changed'});
    }

    const stranded=await transaction.execute({
      sql:`SELECT affected.user_id
        FROM circle_memberships affected
        WHERE affected.circle_id=? AND affected.status='active'
          AND NOT EXISTS (
            SELECT 1 FROM circle_memberships alternative
            JOIN circles alternative_circle ON alternative_circle.id=alternative.circle_id
            WHERE alternative.user_id=affected.user_id AND alternative.status='active'
              AND alternative.circle_id<>affected.circle_id AND alternative_circle.archived_at IS NULL
          )
        ORDER BY affected.user_id LIMIT 1`,
      args:[circleId],
    });
    if(stranded.rows?.length){
      await rollback(transaction); finished=true;
      return Object.freeze({ok:false,reason:'last_circle'});
    }

    const archived=await transaction.execute({
      sql:`UPDATE circles AS circle SET archived_at=?
        WHERE circle.id=? AND circle.is_primary=0 AND circle.archived_at IS NULL
          AND EXISTS (
            SELECT 1 FROM circle_memberships owner
            WHERE owner.circle_id=circle.id AND owner.user_id=?
              AND owner.role='owner' AND owner.status='active'
          )
          AND EXISTS (
            SELECT 1 FROM auth_session_circle_contexts context
            WHERE context.session_hash=? AND context.user_id=?
              AND context.circle_id=circle.id AND context.context_version=?
          )
          AND NOT EXISTS (
            SELECT 1 FROM circle_memberships affected
            WHERE affected.circle_id=circle.id AND affected.status='active'
              AND NOT EXISTS (
                SELECT 1 FROM circle_memberships alternative
                JOIN circles alternative_circle ON alternative_circle.id=alternative.circle_id
                WHERE alternative.user_id=affected.user_id AND alternative.status='active'
                  AND alternative.circle_id<>affected.circle_id AND alternative_circle.archived_at IS NULL
              )
          )
        RETURNING id,public_id,name,archived_at`,
      args:[occurredAt,circleId,actor.userId,actor.sessionHash,actor.userId,currentVersion],
    });
    if(archived.rows?.length!==1){
      await rollback(transaction); finished=true;
      return Object.freeze({ok:false,reason:'context_changed'});
    }
    const audit=await transaction.execute({
      sql:`INSERT INTO circle_audit_events
          (circle_id,event_type,actor_user_id,subject_user_id,invitation_id,dedupe_key,created_at)
        VALUES (?,'circle.archived',?,?,NULL,?,?) RETURNING id`,
      args:[circleId,actor.userId,actor.userId,`circle-archived:${circleId}`,occurredAt],
    });
    if(audit.rows?.length!==1) fail('CIRCLE_ARCHIVE_INTEGRITY','Circle archive audit was not created.');

    const moved=await transaction.execute({
      sql:`UPDATE auth_session_circle_contexts AS context
        SET circle_id=(
            SELECT alternative.circle_id
            FROM circle_memberships alternative
            JOIN circles alternative_circle ON alternative_circle.id=alternative.circle_id
            WHERE alternative.user_id=context.user_id AND alternative.status='active'
              AND alternative.circle_id<>? AND alternative_circle.archived_at IS NULL
            ORDER BY alternative_circle.is_primary DESC,alternative.circle_id
            LIMIT 1
          ),
          context_version=context.context_version+1,updated_at=?
        WHERE context.circle_id=? AND EXISTS (
          SELECT 1 FROM circle_memberships alternative
          JOIN circles alternative_circle ON alternative_circle.id=alternative.circle_id
          WHERE alternative.user_id=context.user_id AND alternative.status='active'
            AND alternative.circle_id<>? AND alternative_circle.archived_at IS NULL
        )
        RETURNING session_hash,user_id,circle_id,context_version`,
      args:[circleId,databaseNow,circleId,circleId],
    });
    const initiating=(moved.rows||[]).find(context=>String(context.session_hash)===actor.sessionHash
      &&Number(context.user_id)===actor.userId);
    if(!initiating||Number(initiating.context_version)!==currentVersion+1){
      fail('CIRCLE_ARCHIVE_INTEGRITY','Initiating circle context was not advanced.');
    }
    await transaction.execute({sql:`DELETE FROM auth_session_circle_contexts WHERE circle_id=?`,args:[circleId]});
    const retained=await transaction.execute({
      sql:`SELECT COUNT(*) AS count FROM auth_session_circle_contexts WHERE circle_id=?`,args:[circleId],
    });
    if(Number(retained.rows?.[0]?.count)!==0){
      fail('CIRCLE_ARCHIVE_INTEGRITY','Archived circle contexts remain selected.');
    }

    commitStarted=true;
    await transaction.commit(); finished=true;
    return Object.freeze({ok:true,changed:true,circle:Object.freeze({
      public_id:input.circlePublicId,name:String(archived.rows[0].name||'').slice(0,120),
    })});
  }catch(error){
    if(!finished) await rollback(transaction);
    if(commitStarted){
      fail('CIRCLE_ARCHIVE_COMMIT_UNKNOWN','Circle archive status is unknown.',{cause:error});
    }
    throw error;
  }finally{ try{ await transaction?.close?.(); }catch{} }
}

export async function archiveSecondaryCircle(db,payload,input,{maxAttempts=3,baseDelayMs=8,nowSeconds}={}){
  const actor=identity(payload);
  if(!db||typeof db.transaction!=='function'||!actor
    ||!input||normalizeCirclePublicId(input.circlePublicId)!==input.circlePublicId
    ||contextVersion(input.expectedContextVersion)===null
    ||!Number.isSafeInteger(maxAttempts)||maxAttempts<1||maxAttempts>8
    ||!Number.isSafeInteger(baseDelayMs)||baseDelayMs<0||baseDelayMs>1000
    ||(nowSeconds!==undefined&&(!Number.isSafeInteger(nowSeconds)||nowSeconds<1))){
    throw new TypeError('valid circle archive request is required');
  }
  for(let attempt=1;attempt<=maxAttempts;attempt+=1){
    try{ return await archiveAttempt(db,actor,input,{nowSeconds}); }
    catch(error){
      if(error instanceof CircleArchiveError&&error.code==='CIRCLE_ARCHIVE_COMMIT_UNKNOWN') throw error;
      if(!retryableConflict(error)||attempt===maxAttempts) throw error;
      if(baseDelayMs) await delay(Math.min(baseDelayMs*2**(attempt-1),100));
    }
  }
  fail('CIRCLE_ARCHIVE_UNAVAILABLE','Circle archive is unavailable.');
}
