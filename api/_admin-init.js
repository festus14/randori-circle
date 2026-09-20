import {randomUUID} from 'node:crypto';

import {inspectDatabaseReadiness} from './_health.js';
import {inspectCompletedMembershipRollout} from '../db/membership-readiness.js';

const SESSION_HASH_PATTERN=/^[a-f0-9]{64}$/;
const UUID_PATTERN=/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const PRIMARY_CIRCLE_SLUG='randori-circle';

export class AdminInitializationError extends Error{
  constructor(message,{cause,commitStarted=false}={}){
    super(message,cause===undefined?undefined:{cause});
    this.name='AdminInitializationError';
    this.code='ADMIN_INITIALIZATION_UNAVAILABLE';
    this.commitStarted=commitStarted;
  }
}

function positiveInteger(value){
  const parsed=typeof value==='number'?value
    :(typeof value==='string'&&/^[1-9]\d*$/.test(value)?Number(value):null);
  return Number.isSafeInteger(parsed)&&parsed>0?parsed:null;
}

function normalizedAdminEmails(values){
  if(!Array.isArray(values)) throw new TypeError('adminEmails must be an array');
  return [...new Set(values.map(value=>String(value||'').trim().toLowerCase()).filter(Boolean))];
}

function actorIdentity(actor,{sessionRequired=true}={}){
  const userId=positiveInteger(actor?.userId??actor?.id??actor?.uid);
  const sessionHash=String(actor?.sessionHash||'');
  return userId&&(!sessionRequired||SESSION_HASH_PATTERN.test(sessionHash))
    ?{userId,sessionHash:sessionRequired?sessionHash:null}
    :null;
}

async function rollback(transaction){
  try{ await transaction?.rollback?.(); }catch{}
}

async function liveAdmin(transaction,actor,adminEmails,nowSeconds,{sessionRequired}){
  const result=sessionRequired
    ?await transaction.execute({
      sql:`SELECT account.id,account.email,account.is_admin,account.is_demo
        FROM auth_sessions session
        JOIN auth_accounts account ON account.id=session.user_id
        WHERE session.session_hash=? AND session.user_id=?
          AND session.revoked_at IS NULL AND session.expires_at>?
        LIMIT 2`,
      args:[actor.sessionHash,actor.userId,nowSeconds],
    })
    :await transaction.execute({
      sql:`SELECT id,email,is_admin,is_demo FROM auth_accounts WHERE id=? LIMIT 2`,
      args:[actor.userId],
    });
  if(result.rows?.length!==1||positiveInteger(result.rows[0].id)!==actor.userId){
    return Object.freeze({ok:false,reason:'authentication_required'});
  }
  const row=result.rows[0];
  const email=String(row.email||'').trim().toLowerCase();
  const authorized=Number(row.is_demo)!==1
    &&(Number(row.is_admin)===1||adminEmails.includes(email));
  return authorized
    ?Object.freeze({ok:true,email})
    :Object.freeze({ok:false,reason:'admin_required',email});
}

async function primaryCircleId(transaction){
  const result=await transaction.execute(`SELECT id FROM circles
    WHERE is_primary=1 AND archived_at IS NULL ORDER BY id LIMIT 2`);
  const circleId=positiveInteger(result.rows?.[0]?.id);
  return result.rows?.length===1&&circleId?circleId:null;
}

/**
 * Runs the one-time membership data cutover on an already current schema.
 * This request path never installs or repairs schema. A valid completed cutover
 * is a read-only no-op; the first cutover is committed as one transaction.
 */
async function initialize(db,{
  actor,adminEmails=[],nowSeconds=Math.floor(Date.now()/1000),randomUuid=randomUUID,
  sessionRequired=true,
}={}){
  const identity=actorIdentity(actor,{sessionRequired});
  const owners=normalizedAdminEmails(adminEmails);
  if(!db||typeof db.transaction!=='function'||!identity
    ||!Number.isSafeInteger(nowSeconds)||nowSeconds<1||typeof randomUuid!=='function'){
    throw new TypeError('valid admin initialization input is required');
  }

  let transaction=null;
  let finished=false;
  let commitStarted=false;
  try{
    transaction=await db.transaction('write');
    if(!await inspectDatabaseReadiness(transaction)){
      throw new AdminInitializationError('Database is not ready for initialization.');
    }

    const authorization=await liveAdmin(transaction,identity,owners,nowSeconds,{sessionRequired});
    if(!authorization.ok){
      await rollback(transaction);
      finished=true;
      return authorization;
    }

    const rollout=await transaction.execute(`SELECT registrations_closed
      FROM circle_membership_rollout WHERE id=1 LIMIT 2`);
    if(rollout.rows?.length!==1){
      throw new AdminInitializationError('Membership rollout state is unavailable.');
    }
    if(Number(rollout.rows[0].registrations_closed)===1){
      const circleId=await primaryCircleId(transaction);
      if(!circleId) throw new AdminInitializationError('Primary circle is unavailable.');
      await rollback(transaction);
      finished=true;
      return Object.freeze({ok:true,circleId,changed:false});
    }
    if(Number(rollout.rows[0].registrations_closed)!==0){
      throw new AdminInitializationError('Membership rollout state is unavailable.');
    }

    const publicId=String(randomUuid()).toLowerCase();
    if(!UUID_PATTERN.test(publicId)){
      throw new AdminInitializationError('Primary circle identity generation failed.');
    }
    const nowResult=await transaction.execute(`SELECT strftime('%Y-%m-%dT%H:%M:%fZ','now') AS now_utc`);
    const now=String(nowResult.rows?.[0]?.now_utc||'');
    if(!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(now)){
      throw new AdminInitializationError('Database time is unavailable.');
    }
    const circle=await transaction.execute({
      sql:`INSERT INTO circles (public_id,slug,name,is_primary,created_by,created_at)
        VALUES (?,?,'Randori Circle',1,?,?) RETURNING id`,
      args:[publicId,PRIMARY_CIRCLE_SLUG,identity.userId,now],
    });
    const circleId=positiveInteger(circle.rows?.[0]?.id);
    if(circle.rows?.length!==1||!circleId){
      throw new AdminInitializationError('Primary circle was not created.');
    }

    const ownerEmailSql=owners.length
      ?` OR lower(email) IN (${owners.map(()=>'?').join(',')})`
      :'';
    const memberships=await transaction.execute({
      sql:`INSERT INTO circle_memberships
          (circle_id,user_id,role,status,invited_by,joined_at,updated_at)
        SELECT ?,id,
          CASE WHEN COALESCE(is_admin,0)=1 OR id=?${ownerEmailSql} THEN 'owner' ELSE 'member' END,
          'active',NULL,?,?
        FROM auth_accounts WHERE COALESCE(is_demo,0)=0
        ORDER BY id RETURNING user_id`,
      args:[circleId,identity.userId,...owners,now,now],
    });
    const memberIds=(memberships.rows||[]).map(row=>positiveInteger(row.user_id));
    if(memberIds.some(id=>!id)||!memberIds.includes(identity.userId)){
      throw new AdminInitializationError('Primary-circle membership backfill failed.');
    }

    const backfillKey=`primary-membership-backfill:${circleId}:v1`;
    const audits=await transaction.execute({
      sql:`INSERT INTO circle_audit_events
          (circle_id,event_type,actor_user_id,subject_user_id,invitation_id,dedupe_key,created_at)
        SELECT ?,'membership.backfilled',?,account.id,NULL,
          printf('membership-backfilled:%d:%d',?,account.id),?
        FROM auth_accounts account
        JOIN circle_memberships membership
          ON membership.circle_id=? AND membership.user_id=account.id
        WHERE COALESCE(account.is_demo,0)=0
        ORDER BY account.id RETURNING subject_user_id`,
      args:[circleId,identity.userId,circleId,now,circleId],
    });
    if((audits.rows?.length||0)!==memberIds.length){
      throw new AdminInitializationError('Primary-circle audit backfill failed.');
    }
    const completed=await transaction.execute({
      sql:`INSERT INTO circle_audit_events
          (circle_id,event_type,actor_user_id,subject_user_id,invitation_id,dedupe_key,created_at)
        VALUES (?,'membership.backfill.completed',?,NULL,NULL,?,?) RETURNING id`,
      args:[circleId,identity.userId,backfillKey,now],
    });
    if(completed.rows?.length!==1){
      throw new AdminInitializationError('Primary-circle completion audit failed.');
    }
    const closed=await transaction.execute({
      sql:`UPDATE circle_membership_rollout SET registrations_closed=1,updated_at=?
        WHERE id=1 AND registrations_closed=0 RETURNING id`,
      args:[now],
    });
    if(closed.rows?.length!==1){
      throw new AdminInitializationError('Membership rollout changed during initialization.');
    }
    const completedState=await inspectCompletedMembershipRollout(transaction);
    if(!completedState.ok){
      throw new AdminInitializationError('Membership initialization postcondition failed.');
    }

    commitStarted=true;
    await transaction.commit();
    finished=true;
    return Object.freeze({ok:true,circleId,changed:true});
  }catch(error){
    if(transaction&&!finished) await rollback(transaction);
    if(error instanceof AdminInitializationError){
      error.commitStarted=commitStarted;
      throw error;
    }
    throw new AdminInitializationError('Admin initialization is unavailable.',{
      cause:error,commitStarted,
    });
  }finally{
    try{ await transaction?.close?.(); }catch{}
  }
}

export function initializePrimaryCircleData(db,options){
  return initialize(db,{...options,sessionRequired:true});
}

// The local runtime has no browser session while creating its first account.
// Its caller has already verified an isolated local file and a current ledger.
export function initializeLocalPrimaryCircleData(db,{ownerUserId,ownerEmails=[],randomUuid}={}){
  return initialize(db,{
    actor:{userId:ownerUserId},adminEmails:ownerEmails,randomUuid,sessionRequired:false,
  });
}
