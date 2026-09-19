import { randomUUID } from 'node:crypto';
import { revokeAccountSessions } from './_db.js';
import { requireRecentAuth } from './_recent-auth.js';

export const MEMBER_LIST_LIMIT=500;

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

async function rollback(transaction){
  try{ await transaction.rollback(); }catch{}
}

async function inspectScopedTarget(transaction,{actorUserId,targetUserId}){
  const result=await transaction.execute({
    sql:`SELECT target.user_id,target.role,target.status,
        (SELECT COUNT(*) FROM circle_memberships owner
          WHERE owner.circle_id=target.circle_id AND owner.role='owner' AND owner.status='active') AS active_owner_count
      FROM circle_memberships actor
      JOIN circles circle ON circle.id=actor.circle_id
      JOIN circle_memberships target ON target.circle_id=actor.circle_id AND target.user_id=?
      WHERE actor.user_id=? AND actor.role='owner' AND actor.status='active'
        AND circle.is_primary=1 AND circle.archived_at IS NULL
      LIMIT 1`,
    args:[targetUserId,actorUserId],
  });
  return result.rows?.length===1?result.rows[0]:null;
}

async function acquireOwnerWrite(transaction,actorUserId){
  await transaction.execute({
    sql:`UPDATE circle_memberships AS actor
      SET updated_at=updated_at
      WHERE actor.user_id=? AND actor.role='owner' AND actor.status='active'
        AND EXISTS (SELECT 1 FROM circles circle WHERE circle.id=actor.circle_id
          AND circle.is_primary=1 AND circle.archived_at IS NULL)`,
    args:[actorUserId],
  });
}

async function requireActorRecentAuth(transaction,actorUserId,session,nowSeconds){
  const sessionUserId=positiveInteger(Number(session?.id??session?.uid));
  return requireRecentAuth(transaction,sessionUserId===actorUserId?session:null,{
    ...(nowSeconds?{nowSeconds}:{}),
  });
}

export async function listCircleMembersForOwner(db,{actorUserId}={}){
  const actor=positiveInteger(actorUserId);
  if(!db||typeof db.execute!=='function'||!actor) throw new TypeError('valid owner membership query required');
  const result=await db.execute({
    sql:`WITH owner AS (
        SELECT membership.circle_id
        FROM circle_memberships membership
        JOIN circles circle ON circle.id=membership.circle_id
        WHERE membership.user_id=? AND membership.role='owner' AND membership.status='active'
          AND circle.is_primary=1 AND circle.archived_at IS NULL
        LIMIT 1
      )
      SELECT membership.user_id,account.display_name,account.color,membership.role,membership.status,
        membership.joined_at,membership.updated_at
      FROM owner
      JOIN circle_memberships membership ON membership.circle_id=owner.circle_id
      JOIN auth_accounts account ON account.id=membership.user_id
      WHERE COALESCE(account.is_demo,0)=0
      ORDER BY membership.status='active' DESC,membership.role='owner' DESC,
        lower(account.display_name),membership.user_id
      LIMIT ?`,
    args:[actor,MEMBER_LIST_LIMIT+1],
  });
  const projected=(result.rows||[]).map(publicMember).filter(Boolean);
  const members=projected.slice(0,MEMBER_LIST_LIMIT);
  return members.length
    ?Object.freeze({ok:true,members,truncated:projected.length>MEMBER_LIST_LIMIT})
    :Object.freeze({ok:false,reason:'owner_required'});
}

export async function changeCircleMemberStatus(db,{actorUserId,targetUserId,action,session,nowSeconds}={}){
  const actor=positiveInteger(actorUserId);
  const target=positiveInteger(targetUserId);
  const operation=normalizedAction(action);
  if(!db||typeof db.transaction!=='function'||!actor||!target||!operation){
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
    if(operation==='deactivate'){
      await acquireOwnerWrite(transaction,actor);
      const targetState=await inspectScopedTarget(transaction,{actorUserId:actor,targetUserId:target});
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
            WHERE actor_membership.user_id=? AND actor_membership.role='owner'
              AND actor_membership.status='active'
              AND circle.is_primary=1 AND circle.archived_at IS NULL
            LIMIT 1
          )
          AND (?<>'deactivate' OR target.role<>'owner' OR EXISTS (
            SELECT 1 FROM circle_memberships other_owner
            WHERE other_owner.circle_id=target.circle_id AND other_owner.role='owner'
              AND other_owner.status='active' AND other_owner.user_id<>target.user_id
          ))
        RETURNING circle_id,user_id,role,status`,
      args:[nextStatus,occurredAt,target,priorStatus,actor,operation],
    });
    const row=changed.rows?.[0];
    if(changed.rows?.length!==1||positiveInteger(Number(row?.user_id))!==target||row?.status!==nextStatus){
      const state=await inspectScopedTarget(transaction,{actorUserId:actor,targetUserId:target});
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
      revokedSessions=await revokeAccountSessions(transaction,target,'membership_removed');
    }
    await transaction.commit(); finished=true;
    return Object.freeze({ok:true,member:Object.freeze({id:target,role:String(row.role),status:nextStatus}),revoked_sessions:revokedSessions});
  }catch(error){
    if(!finished) await rollback(transaction);
    throw error;
  }
}

export async function leaveCircle(db,{actorUserId}={}){
  const actor=positiveInteger(actorUserId);
  if(!db||typeof db.transaction!=='function'||!actor) throw new TypeError('valid membership leave required');
  const occurredAt=new Date().toISOString();
  const transaction=await db.transaction('write');
  let finished=false;
  try{
    const changed=await transaction.execute({
      sql:`UPDATE circle_memberships AS membership
        SET status='inactive',updated_at=?
        WHERE membership.user_id=? AND membership.status='active'
          AND membership.circle_id=(
            SELECT circle.id FROM circles circle
            JOIN circle_memberships actor ON actor.circle_id=circle.id
            WHERE actor.user_id=? AND actor.status='active'
              AND circle.is_primary=1 AND circle.archived_at IS NULL
            LIMIT 1
          )
          AND (membership.role<>'owner' OR EXISTS (
            SELECT 1 FROM circle_memberships other_owner
            WHERE other_owner.circle_id=membership.circle_id AND other_owner.role='owner'
              AND other_owner.status='active' AND other_owner.user_id<>membership.user_id
          ))
        RETURNING circle_id,user_id,role,status`,
      args:[occurredAt,actor,actor],
    });
    const row=changed.rows?.[0];
    if(changed.rows?.length!==1||positiveInteger(Number(row?.user_id))!==actor||row?.status!=='inactive'){
      const state=await transaction.execute({
        sql:`SELECT membership.role,membership.status,
            (SELECT COUNT(*) FROM circle_memberships owner
              WHERE owner.circle_id=membership.circle_id AND owner.role='owner' AND owner.status='active') AS active_owner_count
          FROM circle_memberships membership
          JOIN circles circle ON circle.id=membership.circle_id
          WHERE membership.user_id=? AND circle.is_primary=1 AND circle.archived_at IS NULL
          LIMIT 1`,
        args:[actor],
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
    const revokedSessions=await revokeAccountSessions(transaction,actor,'membership_removed');
    await transaction.commit(); finished=true;
    return Object.freeze({ok:true,member:Object.freeze({id:actor,role:String(row.role),status:'inactive'}),revoked_sessions:revokedSessions});
  }catch(error){
    if(!finished) await rollback(transaction);
    throw error;
  }
}

export async function transferCircleOwnership(db,{actorUserId,targetUserId,session,nowSeconds}={}){
  const actor=positiveInteger(actorUserId);
  const target=positiveInteger(targetUserId);
  if(!db||typeof db.transaction!=='function'||!actor||!target) throw new TypeError('valid ownership transfer required');
  if(actor===target) return Object.freeze({ok:false,reason:'self_transfer'});
  const occurredAt=new Date().toISOString();
  const transaction=await db.transaction('write');
  let finished=false;
  try{
    await acquireOwnerWrite(transaction,actor);
    await requireActorRecentAuth(transaction,actor,session,nowSeconds);
    const promoted=await transaction.execute({
      sql:`UPDATE circle_memberships AS target
        SET role='owner',updated_at=?
        WHERE target.user_id=? AND target.role='member' AND target.status='active'
          AND target.circle_id=(
            SELECT actor_membership.circle_id
            FROM circle_memberships actor_membership
            JOIN circles circle ON circle.id=actor_membership.circle_id
            WHERE actor_membership.user_id=? AND actor_membership.role='owner'
              AND actor_membership.status='active'
              AND circle.is_primary=1 AND circle.archived_at IS NULL
            LIMIT 1
          )
        RETURNING circle_id,user_id`,
      args:[occurredAt,target,actor],
    });
    const promotedRow=promoted.rows?.[0];
    if(promoted.rows?.length!==1||positiveInteger(Number(promotedRow?.user_id))!==target){
      const state=await inspectScopedTarget(transaction,{actorUserId:actor,targetUserId:target});
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
