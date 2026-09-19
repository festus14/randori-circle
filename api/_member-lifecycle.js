import { createCipheriv,createDecipheriv,createHash,randomBytes,randomUUID } from 'node:crypto';
import { revokeAccountSessions } from './_db.js';
import { validateActiveCircleMutationContext } from './_active-circle.js';
import { requireRecentAuth } from './_recent-auth.js';

export const MEMBER_PAGE_DEFAULT=50;
export const MEMBER_PAGE_MAX=100;
export const MEMBER_SCAN_LIMIT=200;
export const MEMBER_SEARCH_MAX=80;
const ROSTER_CURSOR_PREFIX='r1';
const ROSTER_CURSOR_AAD=Buffer.from('randori-owner-roster-cursor-v1','utf8');

export const OWNER_ROSTER_SCOPE_SQL=`SELECT membership.circle_id
  FROM circle_memberships membership
  JOIN circles circle ON circle.id=membership.circle_id
  WHERE membership.user_id=? AND membership.circle_id=?
    AND membership.role='owner' AND membership.status='active'
    AND circle.archived_at IS NULL
  LIMIT 1`;
export const OWNER_ROSTER_MAX_SQL=`SELECT membership.user_id
  FROM circle_memberships membership
  WHERE membership.circle_id=?
  ORDER BY membership.user_id DESC
  LIMIT 1`;
export const OWNER_ROSTER_PAGE_SQL=`WITH owner AS (
    SELECT membership.circle_id
    FROM circle_memberships membership
    JOIN circles circle ON circle.id=membership.circle_id
    WHERE membership.user_id=? AND membership.circle_id=?
      AND membership.role='owner' AND membership.status='active'
      AND circle.archived_at IS NULL
    LIMIT 1
  ), candidates AS MATERIALIZED (
    SELECT membership.user_id,membership.role,membership.status,
      membership.joined_at,membership.updated_at
    FROM owner
    JOIN circle_memberships membership ON membership.circle_id=owner.circle_id
    WHERE owner.circle_id=? AND membership.user_id>? AND membership.user_id<=?
    ORDER BY membership.user_id
    LIMIT ?
  )
  SELECT owner.circle_id AS authorized_circle_id,candidates.user_id,
    account.id AS account_id,account.display_name,account.color,account.is_demo,candidates.role,candidates.status,
    candidates.joined_at,candidates.updated_at
  FROM owner
  LEFT JOIN candidates ON 1=1
  LEFT JOIN auth_accounts account ON account.id=candidates.user_id
  ORDER BY candidates.user_id`;

export class MemberRosterQueryError extends Error{
  constructor(code){ super(code); this.name='MemberRosterQueryError'; this.code=code; }
}

function positiveInteger(value){
  return Number.isSafeInteger(value)&&value>0?value:null;
}

function normalizedAction(value){
  return ['deactivate','reactivate'].includes(value)?value:null;
}

function publicMember(row){
  const id=positiveInteger(Number(row?.user_id));
  const role=row?.role==='owner'?'owner':row?.role==='member'?'member':null;
  const status=row?.status==='active'?'active':row?.status==='inactive'?'inactive':null;
  if(!id||!role||!status) return null;
  return Object.freeze({
    id,
    display_name:String(row?.display_name||'Member').trim().slice(0,80)||'Member',
    color:String(row?.color||'').slice(0,32),
    role,
    status,
    joined_at:String(row?.joined_at||''),
    updated_at:String(row?.updated_at||''),
  });
}

export function normalizeMemberSearch(value){
  if(value==null) return '';
  if(typeof value!=='string') throw new MemberRosterQueryError('invalid_search');
  const normalized=value.normalize('NFKC').trim().replace(/\s+/gu,' ').toLocaleLowerCase('en-US');
  if([...normalized].length>MEMBER_SEARCH_MAX||Buffer.byteLength(normalized,'utf8')>MEMBER_SEARCH_MAX*4
    ||/[\u0000-\u001f\u007f]/u.test(normalized)){
    throw new MemberRosterQueryError('invalid_search');
  }
  return normalized;
}

function cursorKey(secret){
  if(typeof secret!=='string'||Buffer.byteLength(secret,'utf8')<32) throw new TypeError('valid roster cursor secret required');
  return createHash('sha256').update('randori-owner-roster-cursor-key-v1\0').update(secret).digest();
}

function encodeRosterCursor(payload,secret){
  const nonce=randomBytes(12);
  const cipher=createCipheriv('aes-256-gcm',cursorKey(secret),nonce);
  cipher.setAAD(ROSTER_CURSOR_AAD);
  const ciphertext=Buffer.concat([cipher.update(JSON.stringify(payload),'utf8'),cipher.final()]);
  return `${ROSTER_CURSOR_PREFIX}.${Buffer.concat([nonce,cipher.getAuthTag(),ciphertext]).toString('base64url')}`;
}

function decodeRosterCursor(value,secret){
  if(typeof value!=='string'||value.length<20||value.length>640||!value.startsWith(`${ROSTER_CURSOR_PREFIX}.`)){
    throw new MemberRosterQueryError('invalid_cursor');
  }
  const encoded=value.slice(ROSTER_CURSOR_PREFIX.length+1);
  if(!/^[A-Za-z0-9_-]+$/.test(encoded)) throw new MemberRosterQueryError('invalid_cursor');
  let packed;
  try{ packed=Buffer.from(encoded,'base64url'); }catch{ throw new MemberRosterQueryError('invalid_cursor'); }
  if(packed.toString('base64url')!==encoded||packed.length<29) throw new MemberRosterQueryError('invalid_cursor');
  try{
    const nonce=packed.subarray(0,12);
    const tag=packed.subarray(12,28);
    const decipher=createDecipheriv('aes-256-gcm',cursorKey(secret),nonce);
    decipher.setAAD(ROSTER_CURSOR_AAD);
    decipher.setAuthTag(tag);
    const payload=JSON.parse(Buffer.concat([decipher.update(packed.subarray(28)),decipher.final()]).toString('utf8'));
    const keys=payload&&typeof payload==='object'&&!Array.isArray(payload)?Object.keys(payload).sort():[];
    if(keys.join(',')!=='a,c,m,n,q,v'||payload.v!==1||!positiveInteger(payload.a)||!positiveInteger(payload.c)
      ||!Number.isSafeInteger(payload.m)||payload.m<0||!Number.isSafeInteger(payload.n)||payload.n<0
      ||payload.n>payload.m||typeof payload.q!=='string'||normalizeMemberSearch(payload.q)!==payload.q){
      throw new Error('invalid cursor payload');
    }
    return payload;
  }catch(error){
    if(error instanceof TypeError&&String(error.message).includes('cursor secret')) throw error;
    throw new MemberRosterQueryError('invalid_cursor');
  }
}

async function rollback(transaction){
  try{ await transaction.rollback(); }catch{}
}

async function activeMutationContextValid(transaction,circleContext,circleId){
  if(!circleContext) return true;
  return validateActiveCircleMutationContext(transaction,circleContext.payload,{
    circleId,
    contextVersion:circleContext.contextVersion,
    implicit:circleContext.implicit===true,
  });
}

async function bumpSelectedCircleContexts(transaction,userId,circleId,sessionHash=null){
  const bumped=await transaction.execute({
    sql:`UPDATE auth_session_circle_contexts
      SET context_version=context_version+1,
        updated_at=CAST(strftime('%s','now') AS INTEGER)
      WHERE user_id=? AND circle_id=?
      RETURNING session_hash,context_version`,
    args:[userId,circleId],
  });
  if(typeof sessionHash!=='string') return null;
  const selected=(bumped.rows||[]).find(row=>String(row.session_hash)===sessionHash);
  const version=Number(selected?.context_version);
  return Number.isSafeInteger(version)&&version>0?version:null;
}

async function inspectScopedTarget(transaction,{actorUserId,targetUserId,circleId}){
  const result=await transaction.execute({
    sql:`SELECT target.user_id,target.role,target.status,
        (SELECT COUNT(*) FROM circle_memberships owner
          WHERE owner.circle_id=target.circle_id AND owner.role='owner' AND owner.status='active') AS active_owner_count
      FROM circle_memberships actor
      JOIN circles circle ON circle.id=actor.circle_id
      JOIN circle_memberships target ON target.circle_id=actor.circle_id AND target.user_id=?
      WHERE actor.user_id=? AND actor.circle_id=? AND actor.role='owner' AND actor.status='active'
        AND circle.archived_at IS NULL
      LIMIT 1`,
    args:[targetUserId,actorUserId,circleId],
  });
  return result.rows?.length===1?result.rows[0]:null;
}

async function acquireOwnerWrite(transaction,actorUserId,circleId){
  await transaction.execute({
    sql:`UPDATE circle_memberships AS actor
      SET updated_at=updated_at
      WHERE actor.user_id=? AND actor.circle_id=? AND actor.role='owner' AND actor.status='active'
        AND EXISTS (SELECT 1 FROM circles circle WHERE circle.id=actor.circle_id
          AND circle.archived_at IS NULL)`,
    args:[actorUserId,circleId],
  });
}

async function requireActorRecentAuth(transaction,actorUserId,session,nowSeconds){
  const sessionUserId=positiveInteger(Number(session?.id??session?.uid));
  return requireRecentAuth(transaction,sessionUserId===actorUserId?session:null,{
    ...(nowSeconds?{nowSeconds}:{}),
  });
}

export async function listCircleMembersForOwner(db,{actorUserId,circleId,cursor=null,search='',limit=MEMBER_PAGE_DEFAULT,cursorSecret}={}){
  const actor=positiveInteger(actorUserId);
  const selectedCircle=positiveInteger(circleId);
  if(!db||typeof db.execute!=='function'||!actor||!selectedCircle||!Number.isSafeInteger(limit)||limit<1||limit>MEMBER_PAGE_MAX){
    throw new TypeError('valid owner membership query required');
  }
  const normalizedSearch=normalizeMemberSearch(search);
  const decoded=cursor?decodeRosterCursor(cursor,cursorSecret):null;
  if(decoded&&(decoded.a!==actor||decoded.q!==normalizedSearch)){
    throw new MemberRosterQueryError('invalid_cursor');
  }
  const effectiveSearch=decoded?.q??normalizedSearch;
  const scope=await db.execute({sql:OWNER_ROSTER_SCOPE_SQL,args:[actor,selectedCircle]});
  if(scope.rows?.length!==1) return Object.freeze({ok:false,reason:'owner_required'});
  const scopedCircleId=positiveInteger(Number(scope.rows[0].circle_id));
  if(!scopedCircleId) throw new Error('invalid owner roster scope');
  if(decoded&&decoded.c!==scopedCircleId) throw new MemberRosterQueryError('invalid_cursor');
  let snapshotMax=decoded?.m;
  if(snapshotMax===undefined){
    const maximum=await db.execute({sql:OWNER_ROSTER_MAX_SQL,args:[scopedCircleId]});
    snapshotMax=maximum.rows?.length?Number(maximum.rows[0].user_id):0;
  }
  if(!Number.isSafeInteger(snapshotMax)||snapshotMax<0) throw new Error('invalid owner roster scope');
  const afterId=decoded?.n??0;
  const result=await db.execute({
    sql:OWNER_ROSTER_PAGE_SQL,
    args:[actor,scopedCircleId,scopedCircleId,afterId,snapshotMax,MEMBER_SCAN_LIMIT+1],
  });
  if(!result.rows?.length) return Object.freeze({ok:false,reason:'owner_required'});
  const rawCandidates=result.rows.filter(row=>positiveInteger(Number(row?.user_id)));
  const candidateRows=rawCandidates.slice(0,MEMBER_SCAN_LIMIT);
  const candidates=candidateRows
    .filter(row=>positiveInteger(Number(row?.account_id))&&Number(row?.is_demo)===0)
    .map(publicMember).filter(Boolean);
  const matching=effectiveSearch
    ?candidates.filter(member=>normalizeMemberSearch(member.display_name).includes(effectiveSearch))
    :candidates;
  const members=matching.slice(0,limit);
  let nextAfter=0;
  if(matching.length>limit) nextAfter=members.at(-1)?.id||0;
  else if(rawCandidates.length>MEMBER_SCAN_LIMIT) nextAfter=positiveInteger(Number(candidateRows.at(-1)?.user_id))||0;
  const hasMore=positiveInteger(nextAfter)!==null&&nextAfter<snapshotMax;
  const nextCursor=hasMore?encodeRosterCursor({v:1,a:actor,c:scopedCircleId,m:snapshotMax,n:nextAfter,q:effectiveSearch},cursorSecret):null;
  return Object.freeze({
    ok:true,
    members:Object.freeze(members),
    has_more:hasMore,
    next_cursor:nextCursor,
    scanned:candidateRows.length,
  });
}

export async function changeCircleMemberStatus(db,{actorUserId,targetUserId,circleId,action,session,nowSeconds,circleContext}={}){
  const actor=positiveInteger(actorUserId);
  const target=positiveInteger(targetUserId);
  const selectedCircle=positiveInteger(circleId);
  const operation=normalizedAction(action);
  if(!db||typeof db.transaction!=='function'||!actor||!target||!selectedCircle||!operation){
    throw new TypeError('valid member lifecycle transition required');
  }
  if(actor===target) return Object.freeze({ok:false,reason:'self_transition'});
  const nextStatus=operation==='deactivate'?'inactive':'active';
  const priorStatus=operation==='deactivate'?'active':'inactive';
  const eventType=`membership.${operation}d`;
  const occurredAt=new Date().toISOString();
  const transaction=await db.transaction('write');
  let finished=false;
  try{
    if(!await activeMutationContextValid(transaction,circleContext,selectedCircle)){
      await rollback(transaction); finished=true;
      return Object.freeze({ok:false,reason:'context_changed'});
    }
    if(operation==='deactivate'){
      await acquireOwnerWrite(transaction,actor,selectedCircle);
      const targetState=await inspectScopedTarget(transaction,{actorUserId:actor,targetUserId:target,circleId:selectedCircle});
      if(!targetState){
        await rollback(transaction); finished=true;
        return Object.freeze({ok:false,reason:'not_found'});
      }
      if(targetState.role==='owner'){
        await requireActorRecentAuth(transaction,actor,session,nowSeconds);
      }
    }
    const changed=await transaction.execute({
      sql:`UPDATE circle_memberships AS target
        SET status=?,updated_at=?
        WHERE target.user_id=? AND target.status=?
          AND target.circle_id=(
            SELECT actor_membership.circle_id
            FROM circle_memberships actor_membership
            JOIN circles circle ON circle.id=actor_membership.circle_id
            WHERE actor_membership.user_id=? AND actor_membership.circle_id=? AND actor_membership.role='owner'
              AND actor_membership.status='active'
              AND circle.archived_at IS NULL
            LIMIT 1
          )
          AND (?<>'deactivate' OR target.role<>'owner' OR EXISTS (
            SELECT 1 FROM circle_memberships other_owner
            WHERE other_owner.circle_id=target.circle_id AND other_owner.role='owner'
              AND other_owner.status='active' AND other_owner.user_id<>target.user_id
          ))
        RETURNING circle_id,user_id,role,status`,
      args:[nextStatus,occurredAt,target,priorStatus,actor,selectedCircle,operation],
    });
    const row=changed.rows?.[0];
    if(changed.rows?.length!==1||positiveInteger(Number(row?.user_id))!==target||row?.status!==nextStatus){
      const state=await inspectScopedTarget(transaction,{actorUserId:actor,targetUserId:target,circleId:selectedCircle});
      await rollback(transaction); finished=true;
      if(!state) return Object.freeze({ok:false,reason:'not_found'});
      if(operation==='deactivate'&&state.role==='owner'&&Number(state.active_owner_count)<=1){
        return Object.freeze({ok:false,reason:'last_owner'});
      }
      return Object.freeze({ok:false,reason:'state_conflict'});
    }
    const audit=await transaction.execute({
      sql:`INSERT INTO circle_audit_events
          (circle_id,event_type,actor_user_id,subject_user_id,invitation_id,dedupe_key,created_at)
        VALUES (?,?,?,?,NULL,?,?) RETURNING id`,
      args:[Number(row.circle_id),eventType,actor,target,`${eventType}:${randomUUID()}`,occurredAt],
    });
    if(audit.rows?.length!==1) throw new Error('membership audit unavailable');
    let revokedSessions=0;
    if(operation==='deactivate'){
      await bumpSelectedCircleContexts(transaction,target,selectedCircle);
      const remaining=await transaction.execute({
        sql:`SELECT membership.circle_id FROM circle_memberships membership
          JOIN circles circle ON circle.id=membership.circle_id
          WHERE membership.user_id=? AND membership.status='active' AND circle.archived_at IS NULL
          LIMIT 1`,
        args:[target],
      });
      if(!remaining.rows?.length) revokedSessions=await revokeAccountSessions(transaction,target,'membership_removed');
    }
    await transaction.commit(); finished=true;
    return Object.freeze({ok:true,member:Object.freeze({id:target,role:String(row.role),status:nextStatus}),revoked_sessions:revokedSessions});
  }catch(error){
    if(!finished) await rollback(transaction);
    throw error;
  }
}

export async function leaveCircle(db,{actorUserId,circleId,circleContext}={}){
  const actor=positiveInteger(actorUserId);
  const selectedCircle=positiveInteger(circleId);
  if(!db||typeof db.transaction!=='function'||!actor||!selectedCircle) throw new TypeError('valid membership leave required');
  const occurredAt=new Date().toISOString();
  const transaction=await db.transaction('write');
  let finished=false;
  try{
    if(!await activeMutationContextValid(transaction,circleContext,selectedCircle)){
      await rollback(transaction); finished=true;
      return Object.freeze({ok:false,reason:'context_changed'});
    }
    const changed=await transaction.execute({
      sql:`UPDATE circle_memberships AS membership
        SET status='inactive',updated_at=?
        WHERE membership.user_id=? AND membership.status='active'
          AND membership.circle_id=(
            SELECT circle.id FROM circles circle
            JOIN circle_memberships actor ON actor.circle_id=circle.id
            WHERE actor.user_id=? AND actor.circle_id=? AND actor.status='active'
              AND circle.archived_at IS NULL
            LIMIT 1
          )
          AND (membership.role<>'owner' OR EXISTS (
            SELECT 1 FROM circle_memberships other_owner
            WHERE other_owner.circle_id=membership.circle_id AND other_owner.role='owner'
              AND other_owner.status='active' AND other_owner.user_id<>membership.user_id
          ))
        RETURNING circle_id,user_id,role,status`,
      args:[occurredAt,actor,actor,selectedCircle],
    });
    const row=changed.rows?.[0];
    if(changed.rows?.length!==1||positiveInteger(Number(row?.user_id))!==actor||row?.status!=='inactive'){
      const state=await transaction.execute({
        sql:`SELECT membership.role,membership.status,
            (SELECT COUNT(*) FROM circle_memberships owner
              WHERE owner.circle_id=membership.circle_id AND owner.role='owner' AND owner.status='active') AS active_owner_count
          FROM circle_memberships membership
          JOIN circles circle ON circle.id=membership.circle_id
          WHERE membership.user_id=? AND membership.circle_id=? AND circle.archived_at IS NULL
          LIMIT 1`,
        args:[actor,selectedCircle],
      });
      await rollback(transaction); finished=true;
      const current=state.rows?.length===1?state.rows[0]:null;
      if(current?.role==='owner'&&current?.status==='active'&&Number(current.active_owner_count)<=1){
        return Object.freeze({ok:false,reason:'last_owner'});
      }
      return Object.freeze({ok:false,reason:'not_found'});
    }
    const eventType='membership.left';
    const audit=await transaction.execute({
      sql:`INSERT INTO circle_audit_events
          (circle_id,event_type,actor_user_id,subject_user_id,invitation_id,dedupe_key,created_at)
        VALUES (?,?,?,?,NULL,?,?) RETURNING id`,
      args:[Number(row.circle_id),eventType,actor,actor,`${eventType}:${randomUUID()}`,occurredAt],
    });
    if(audit.rows?.length!==1) throw new Error('membership audit unavailable');
    const bumpedContextVersion=await bumpSelectedCircleContexts(
      transaction,actor,selectedCircle,circleContext?.payload?.sessionHash,
    );
    const remaining=await transaction.execute({
      sql:`SELECT membership.circle_id FROM circle_memberships membership
        JOIN circles circle ON circle.id=membership.circle_id
        WHERE membership.user_id=? AND membership.status='active' AND circle.archived_at IS NULL
        LIMIT 1`,
      args:[actor],
    });
    const signedOut=!remaining.rows?.length;
    const revokedSessions=signedOut?await revokeAccountSessions(transaction,actor,'membership_removed'):0;
    await transaction.commit(); finished=true;
    return Object.freeze({ok:true,member:Object.freeze({id:actor,role:String(row.role),status:'inactive'}),
      revoked_sessions:revokedSessions,signed_out:signedOut,
      ...(bumpedContextVersion?{context_version:bumpedContextVersion}:{}),
    });
  }catch(error){
    if(!finished) await rollback(transaction);
    throw error;
  }
}

export async function transferCircleOwnership(db,{actorUserId,targetUserId,circleId,session,nowSeconds,circleContext}={}){
  const actor=positiveInteger(actorUserId);
  const target=positiveInteger(targetUserId);
  const selectedCircle=positiveInteger(circleId);
  if(!db||typeof db.transaction!=='function'||!actor||!target||!selectedCircle) throw new TypeError('valid ownership transfer required');
  if(actor===target) return Object.freeze({ok:false,reason:'self_transfer'});
  const occurredAt=new Date().toISOString();
  const transaction=await db.transaction('write');
  let finished=false;
  try{
    if(!await activeMutationContextValid(transaction,circleContext,selectedCircle)){
      await rollback(transaction); finished=true;
      return Object.freeze({ok:false,reason:'context_changed'});
    }
    await acquireOwnerWrite(transaction,actor,selectedCircle);
    await requireActorRecentAuth(transaction,actor,session,nowSeconds);
    const promoted=await transaction.execute({
      sql:`UPDATE circle_memberships AS target
        SET role='owner',updated_at=?
        WHERE target.user_id=? AND target.role='member' AND target.status='active'
          AND target.circle_id=(
            SELECT actor_membership.circle_id
            FROM circle_memberships actor_membership
            JOIN circles circle ON circle.id=actor_membership.circle_id
            WHERE actor_membership.user_id=? AND actor_membership.circle_id=? AND actor_membership.role='owner'
              AND actor_membership.status='active'
              AND circle.archived_at IS NULL
            LIMIT 1
          )
        RETURNING circle_id,user_id`,
      args:[occurredAt,target,actor,selectedCircle],
    });
    const promotedRow=promoted.rows?.[0];
    if(promoted.rows?.length!==1||positiveInteger(Number(promotedRow?.user_id))!==target){
      const state=await inspectScopedTarget(transaction,{actorUserId:actor,targetUserId:target,circleId:selectedCircle});
      await rollback(transaction); finished=true;
      return Object.freeze({ok:false,reason:state?'state_conflict':'not_found'});
    }
    const demoted=await transaction.execute({
      sql:`UPDATE circle_memberships AS actor
        SET role='member',updated_at=?
        WHERE actor.circle_id=? AND actor.user_id=? AND actor.role='owner' AND actor.status='active'
          AND EXISTS (
            SELECT 1 FROM circle_memberships target
            WHERE target.circle_id=actor.circle_id AND target.user_id=?
              AND target.role='owner' AND target.status='active'
          )
        RETURNING user_id`,
      args:[occurredAt,Number(promotedRow.circle_id),actor,target],
    });
    if(demoted.rows?.length!==1||positiveInteger(Number(demoted.rows[0]?.user_id))!==actor){
      await rollback(transaction); finished=true;
      return Object.freeze({ok:false,reason:'state_conflict'});
    }
    const eventType='ownership.transferred';
    const audit=await transaction.execute({
      sql:`INSERT INTO circle_audit_events
          (circle_id,event_type,actor_user_id,subject_user_id,invitation_id,dedupe_key,created_at)
        VALUES (?,?,?,?,NULL,?,?) RETURNING id`,
      args:[Number(promotedRow.circle_id),eventType,actor,target,`${eventType}:${randomUUID()}`,occurredAt],
    });
    if(audit.rows?.length!==1) throw new Error('ownership transfer audit unavailable');
    await transaction.commit(); finished=true;
    return Object.freeze({ok:true,previous_owner_id:actor,owner_id:target});
  }catch(error){
    if(!finished) await rollback(transaction);
    throw error;
  }
}
