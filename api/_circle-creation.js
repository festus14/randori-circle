import { createHash, randomUUID } from 'node:crypto';

import { MAX_CIRCLES_PER_ACCOUNT } from './_active-circle.js';

export const MAX_OWNED_ACTIVE_CIRCLES_PER_ACCOUNT=10;
export const MAX_CIRCLE_NAME_CODE_POINTS=80;
export const MAX_CIRCLE_NAME_BYTES=240;

const SESSION_HASH_PATTERN=/^[0-9a-f]{64}$/;
const REQUEST_ID_PATTERN=/^[A-Za-z0-9_-]{16,128}$/;
const readinessByClient=new WeakMap();

export class CircleCreationError extends Error{
  constructor(code,message,{cause}={}){
    super(message,cause===undefined?undefined:{cause});
    this.name='CircleCreationError';
    this.code=code;
  }
}

function fail(code,message,options){ throw new CircleCreationError(code,message,options); }

function exactObject(value,keys){
  return !!value&&typeof value==='object'&&!Array.isArray(value)
    &&Object.keys(value).length===keys.length
    &&keys.every(key=>Object.prototype.hasOwnProperty.call(value,key));
}

export function parseCircleCreation(body){
  if(!exactObject(body,['name','request_id'])){
    fail('CIRCLE_CREATE_INPUT_INVALID','Request body must contain only name and request_id.');
  }
  if(!validCircleName(body.name)){
    fail('CIRCLE_CREATE_INPUT_INVALID','Circle name is invalid.');
  }
  if(typeof body.request_id!=='string'||!REQUEST_ID_PATTERN.test(body.request_id)){
    fail('CIRCLE_CREATE_INPUT_INVALID','request_id is invalid.');
  }
  return Object.freeze({name:body.name,requestId:body.request_id});
}

function validCircleName(name){
  return typeof name==='string'&&name===name.trim()
    &&name===name.normalize('NFC')
    &&name.length>0&&[...name].length<=MAX_CIRCLE_NAME_CODE_POINTS
    &&Buffer.byteLength(name,'utf8')<=MAX_CIRCLE_NAME_BYTES
    &&!/[\u0000-\u001f\u007f-\u009f]/u.test(name);
}

function identity(payload){
  const rawId=payload?.id??payload?.uid;
  const userId=typeof rawId==='number'?rawId
    :(typeof rawId==='string'&&/^[1-9]\d*$/.test(rawId)?Number(rawId):null);
  const sessionHash=typeof payload?.sessionHash==='string'&&SESSION_HASH_PATTERN.test(payload.sessionHash)
    ?payload.sessionHash:null;
  if(!Number.isSafeInteger(userId)||userId<1||!sessionHash) return null;
  return Object.freeze({userId,sessionHash});
}

function digest(domain,value){
  return createHash('sha256').update(`${domain}\0${value}`,'utf8').digest('hex');
}

function publicResult(row,{created}){
  const version=Number(row.context_version);
  const publicId=String(row.public_id||'');
  const name=String(row.name||'');
  if(!Number.isSafeInteger(version)||version<1
    ||!/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(publicId)||!name){
    fail('CIRCLE_CREATE_INTEGRITY','Circle creation result is invalid.');
  }
  return Object.freeze({
    ok:true,
    circle:Object.freeze({public_id:publicId,name,role:'owner',is_primary:false}),
    context_version:version,
    created,
  });
}

export async function ensureCircleCreationReadiness(db){
  if(!db||typeof db.execute!=='function') throw new TypeError('database client is required');
  const existing=readinessByClient.get(db);
  if(existing) return existing;
  const pending=db.execute(`SELECT actor_user_id,request_hash,request_fingerprint,
    initiating_session_hash,circle_id,audit_event_id,context_version,created_at
    FROM circle_creation_requests LIMIT 0`);
  readinessByClient.set(db,pending);
  try{ await pending; return true; }
  catch(error){
    if(readinessByClient.get(db)===pending) readinessByClient.delete(db);
    throw error;
  }
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

function expectedUniqueRace(error){
  if(String(error?.code||'').toUpperCase()!=='SQLITE_CONSTRAINT_UNIQUE'
    &&!String(error?.message||'').toUpperCase().includes('SQLITE_CONSTRAINT_UNIQUE')) return false;
  const message=String(error?.message||'').toLowerCase();
  return message.includes('circles.public_id')||message.includes('circles.slug')
    ||message.includes('circle_audit_events.dedupe_key')
    ||(message.includes('circle_creation_requests.actor_user_id')
      &&message.includes('circle_creation_requests.request_hash'));
}

function generatedIdentity(randomUuid){
  const value=String(randomUuid()).toLowerCase();
  if(!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value)){
    fail('CIRCLE_CREATE_INTEGRITY','Circle identity generation failed.');
  }
  const compact=value.replaceAll('-','');
  return Object.freeze({publicId:`circle_${compact}`,slug:`circle-${compact}`});
}

async function createAttempt(db,actor,input,{randomUuid}){
  let transaction;
  let finished=false;
  let commitStarted=false;
  try{
    transaction=await db.transaction('write');
    const nowResult=await transaction.execute(`SELECT CAST(strftime('%s','now') AS INTEGER) AS now_seconds`);
    const nowSeconds=Number(nowResult.rows?.[0]?.now_seconds);
    if(!Number.isSafeInteger(nowSeconds)||nowSeconds<1) fail('CIRCLE_CREATE_UNAVAILABLE','Circle creation is unavailable.');
    const live=await transaction.execute({
      sql:`SELECT account.id
        FROM auth_sessions session JOIN auth_accounts account ON account.id=session.user_id
        WHERE session.session_hash=? AND session.user_id=? AND session.revoked_at IS NULL
          AND session.expires_at>? AND COALESCE(account.is_demo,0)=0
        LIMIT 2`,
      args:[actor.sessionHash,actor.userId,nowSeconds],
    });
    if(live.rows?.length!==1){
      await rollback(transaction); finished=true;
      return Object.freeze({ok:false,reason:'session_changed'});
    }

    const requestHash=digest('randori-circle-create-request-v1',input.requestId);
    const requestFingerprint=digest('randori-circle-create-name-v1',input.name);
    const dedupeKey=`circle-created:${actor.userId}:${requestHash}`;
    const prior=await transaction.execute({
      sql:`SELECT receipt.circle_id,receipt.request_fingerprint,receipt.initiating_session_hash,
          receipt.context_version,receipt.audit_event_id,circle.public_id,circle.name,
          circle.is_primary,circle.archived_at,membership.role,membership.status,
          audit.circle_id AS audit_circle_id,audit.event_type,audit.actor_user_id,
          audit.subject_user_id,audit.invitation_id,
          audit.dedupe_key,context.circle_id AS selected_circle_id,
          context.context_version AS selected_context_version
        FROM circle_creation_requests receipt
        JOIN circles circle ON circle.id=receipt.circle_id
        LEFT JOIN circle_memberships membership
          ON membership.circle_id=receipt.circle_id AND membership.user_id=receipt.actor_user_id
        LEFT JOIN circle_audit_events audit ON audit.id=receipt.audit_event_id
        LEFT JOIN auth_session_circle_contexts context
          ON context.session_hash=receipt.initiating_session_hash
            AND context.user_id=receipt.actor_user_id
        WHERE receipt.actor_user_id=? AND receipt.request_hash=? LIMIT 2`,
      args:[actor.userId,requestHash],
    });
    if((prior.rows?.length||0)>1) fail('CIRCLE_CREATE_INTEGRITY','Circle creation receipt is invalid.');
    if(prior.rows?.length===1){
      const row=prior.rows[0];
      if(String(row.request_fingerprint)!==requestFingerprint
        ||String(row.initiating_session_hash)!==actor.sessionHash){
        await rollback(transaction); finished=true;
        return Object.freeze({ok:false,reason:'request_conflict'});
      }
      const receiptVersion=Number(row.context_version);
      if(!validCircleName(String(row.name||''))||String(row.name)!==input.name
        ||Number(row.is_primary)!==0||Number(row.audit_circle_id)!==Number(row.circle_id)
        ||String(row.event_type)!=='circle.created'||Number(row.actor_user_id)!==actor.userId
        ||Number(row.subject_user_id)!==actor.userId||row.invitation_id!==null
        ||String(row.dedupe_key)!==dedupeKey){
        fail('CIRCLE_CREATE_INTEGRITY','Circle creation receipt is invalid.');
      }
      if(row.archived_at!==null||String(row.role)!=='owner'||String(row.status)!=='active'
        ||Number(row.selected_circle_id)!==Number(row.circle_id)
        ||Number(row.selected_context_version)!==receiptVersion){
        await rollback(transaction); finished=true;
        return Object.freeze({ok:false,reason:'context_changed'});
      }
      await rollback(transaction); finished=true;
      return publicResult(row,{created:false});
    }

    const limits=await transaction.execute({
      sql:`SELECT
          COUNT(*) AS active_memberships,
          COALESCE(SUM(CASE WHEN membership.role='owner' THEN 1 ELSE 0 END),0) AS owned_circles
        FROM circle_memberships membership
        JOIN circles circle ON circle.id=membership.circle_id
        WHERE membership.user_id=? AND membership.status='active' AND circle.archived_at IS NULL`,
      args:[actor.userId],
    });
    const activeMemberships=Number(limits.rows?.[0]?.active_memberships);
    const ownedCircles=Number(limits.rows?.[0]?.owned_circles);
    if(!Number.isSafeInteger(activeMemberships)||activeMemberships<0
      ||!Number.isSafeInteger(ownedCircles)||ownedCircles<0){
      fail('CIRCLE_CREATE_INTEGRITY','Circle ownership state is invalid.');
    }
    if(activeMemberships>=MAX_CIRCLES_PER_ACCOUNT){
      await rollback(transaction); finished=true;
      return Object.freeze({ok:false,reason:'membership_limit'});
    }
    if(ownedCircles>=MAX_OWNED_ACTIVE_CIRCLES_PER_ACCOUNT){
      await rollback(transaction); finished=true;
      return Object.freeze({ok:false,reason:'ownership_limit'});
    }

    const current=await transaction.execute({
      sql:`SELECT circle_id,context_version FROM auth_session_circle_contexts
        WHERE session_hash=? AND user_id=? LIMIT 2`,
      args:[actor.sessionHash,actor.userId],
    });
    if((current.rows?.length||0)>1) fail('CIRCLE_CREATE_INTEGRITY','Active circle context is invalid.');
    const currentVersion=current.rows?.length?Number(current.rows[0].context_version):0;
    if(!Number.isSafeInteger(currentVersion)||currentVersion<0||currentVersion>=Number.MAX_SAFE_INTEGER){
      fail('CIRCLE_CREATE_INTEGRITY','Active circle context is invalid.');
    }
    const nextVersion=currentVersion+1;
    const generated=generatedIdentity(randomUuid);
    const circle=await transaction.execute({
      sql:`INSERT INTO circles (public_id,slug,name,is_primary,created_by,created_at)
        VALUES (?,?,?,0,?,strftime('%Y-%m-%dT%H:%M:%fZ','now'))
        RETURNING id,public_id,name`,
      args:[generated.publicId,generated.slug,input.name,actor.userId],
    });
    if(circle.rows?.length!==1) fail('CIRCLE_CREATE_INTEGRITY','Circle identity was not created.');
    const circleId=Number(circle.rows[0].id);
    if(!Number.isSafeInteger(circleId)||circleId<1) fail('CIRCLE_CREATE_INTEGRITY','Circle identity was not created.');
    const membership=await transaction.execute({
      sql:`INSERT INTO circle_memberships
        (circle_id,user_id,role,status,invited_by,joined_at,updated_at)
        VALUES (?,?,'owner','active',NULL,strftime('%Y-%m-%dT%H:%M:%fZ','now'),
          strftime('%Y-%m-%dT%H:%M:%fZ','now')) RETURNING circle_id`,
      args:[circleId,actor.userId],
    });
    if(membership.rows?.length!==1) fail('CIRCLE_CREATE_INTEGRITY','Circle owner was not created.');
    const audit=await transaction.execute({
      sql:`INSERT INTO circle_audit_events
        (circle_id,event_type,actor_user_id,subject_user_id,invitation_id,dedupe_key,created_at)
        VALUES (?,'circle.created',?,?,NULL,?,strftime('%Y-%m-%dT%H:%M:%fZ','now')) RETURNING id`,
      args:[circleId,actor.userId,actor.userId,dedupeKey],
    });
    if(audit.rows?.length!==1) fail('CIRCLE_CREATE_INTEGRITY','Circle audit was not created.');
    const auditId=Number(audit.rows[0].id);
    const receipt=await transaction.execute({
      sql:`INSERT INTO circle_creation_requests
        (actor_user_id,request_hash,request_fingerprint,initiating_session_hash,
         circle_id,audit_event_id,context_version,created_at)
        VALUES (?,?,?,?,?,?,?,strftime('%Y-%m-%dT%H:%M:%fZ','now'))
        RETURNING circle_id`,
      args:[actor.userId,requestHash,requestFingerprint,actor.sessionHash,circleId,auditId,nextVersion],
    });
    if(receipt.rows?.length!==1) fail('CIRCLE_CREATE_INTEGRITY','Circle creation receipt was not created.');
    const context=current.rows?.length
      ?await transaction.execute({
        sql:`UPDATE auth_session_circle_contexts SET circle_id=?,context_version=?,updated_at=?
          WHERE session_hash=? AND user_id=? AND context_version=? RETURNING circle_id,context_version`,
        args:[circleId,nextVersion,nowSeconds,actor.sessionHash,actor.userId,currentVersion],
      })
      :await transaction.execute({
        sql:`INSERT INTO auth_session_circle_contexts
          (session_hash,user_id,circle_id,context_version,updated_at)
          SELECT session_hash,user_id,?,?,? FROM auth_sessions
          WHERE session_hash=? AND user_id=? AND revoked_at IS NULL AND expires_at>?
          RETURNING circle_id,context_version`,
        args:[circleId,nextVersion,nowSeconds,actor.sessionHash,actor.userId,nowSeconds],
      });
    if(context.rows?.length!==1||Number(context.rows[0].circle_id)!==circleId
      ||Number(context.rows[0].context_version)!==nextVersion){
      fail('CIRCLE_CREATE_CONTEXT_CHANGED','Active circle context changed.');
    }
    commitStarted=true;
    await transaction.commit(); finished=true;
    return publicResult({...circle.rows[0],context_version:nextVersion},{created:true});
  }catch(error){
    if(transaction&&!finished) await rollback(transaction);
    if(error&&typeof error==='object') error.commitStarted=commitStarted;
    throw error;
  }finally{ try{ await transaction?.close?.(); }catch{} }
}

export async function createCircleAndSelect(db,payload,input,{randomUuid=randomUUID,maxAttempts=3}={}){
  const actor=identity(payload);
  if(!db||typeof db.transaction!=='function'||!actor
    ||!input||typeof input!=='object'||Array.isArray(input)
    ||typeof input.name!=='string'||typeof input.requestId!=='string'
    ||!Number.isSafeInteger(maxAttempts)||maxAttempts<1||maxAttempts>5){
    throw new TypeError('valid circle creation inputs are required');
  }
  let lastError;
  for(let attempt=1;attempt<=maxAttempts;attempt+=1){
    try{ return await createAttempt(db,actor,input,{randomUuid}); }
    catch(error){
      lastError=error;
      if(error?.commitStarted||(!retryableConflict(error)&&!expectedUniqueRace(error))||attempt===maxAttempts) break;
      await new Promise(resolve=>setTimeout(resolve,Math.min(200,25*(2**(attempt-1)))));
    }
  }
  if(lastError instanceof CircleCreationError) throw lastError;
  fail(lastError?.commitStarted?'CIRCLE_CREATE_COMMIT_UNKNOWN':'CIRCLE_CREATE_UNAVAILABLE',
    lastError?.commitStarted
      ?'Circle creation result is unknown; retry with the same request_id.'
      :'Circle creation is temporarily unavailable.',{cause:lastError});
}
