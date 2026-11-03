import { resolveActiveCircleContext, requestMatchesCircleContext, validateActiveCircleMutationContext } from './_active-circle.js';

const ID=/^[1-9]\d*$/;
function positiveId(value){
  const id=Number(value);
  if(!ID.test(String(value))||!Number.isSafeInteger(id)) throw new TypeError('invalid workspace identity');
  return id;
}

export function secondaryRoomId({circleId,publicationId,groupId}){
  return `circle_${positiveId(circleId)}_publication_${positiveId(publicationId)}_group_${positiveId(groupId)}`;
}

// The URL identifies a resource; the live session context alone grants scope.
// The primary parser deliberately remains unchanged and rejects this namespace.
export function parseSecondaryRoomPath(path){
  const match=/^\/join\/circle_([1-9]\d*)_publication_([1-9]\d*)_group_([1-9]\d*)$/.exec(path);
  if(!match) return null;
  try{
    const room={circleId:positiveId(match[1]),publicationId:positiveId(match[2]),groupId:positiveId(match[3])};
    return Object.freeze({...room,roomId:secondaryRoomId(room)});
  }catch{ return null; }
}

export function circleAttribution(context){
  return Object.freeze({public_id:context.membership.public_id,name:context.membership.name,is_primary:context.membership.is_primary});
}

export function workspaceEnvelope(context){
  return {circle:circleAttribution(context),circle_public_id:context.membership.public_id,circle_context_version:context.context_version};
}

export class WorkspaceContextError extends Error{
  constructor(code){ super(code); this.code=code; }
}

// Only replay transactions that failed before commit and have been rolled
// back by their caller. A transport failure during commit has unknown outcome.
export async function withWorkspaceRetry(operation){
  for(let attempt=0;attempt<3;attempt+=1){
    try{return await operation();}
    catch(error){
      const code=String(error?.code||error?.cause?.code||'');
      if(attempt===2||error?.workspaceCommitAmbiguous||!['SQLITE_BUSY','SQLITE_BUSY_SNAPSHOT','SQLITE_LOCKED'].includes(code))throw error;
      await new Promise(resolve=>setTimeout(resolve,25*(attempt+1)));
    }
  }
}

export async function stableWorkspaceRead(db,operation,mode='read'){
  return withWorkspaceRetry(async()=>{
    const tx=await db.transaction(mode);
    try{const result=await operation(tx);await tx.commit();return result;}
    catch(error){try{await tx.rollback();}catch{}throw error;}
    finally{await tx.close?.();}
  });
}

export async function resolveWorkspaceContext(db,payload,req){
  const context=await resolveActiveCircleContext(db,payload);
  if(!context.ok) throw new WorkspaceContextError(context.reason==='selection_required'?'active_circle_required':'membership_required');
  if(!context.implicit&&!requestMatchesCircleContext(req,context)) throw new WorkspaceContextError('circle_context_changed');
  return Object.freeze({...context,payload});
}

// All values below are server-derived and strictly validated before entering
// SQL. Embedding this predicate lets every reusable access CTE carry the live
// session/context check without trusting an earlier authorization result.
export function workspaceSessionPredicate(context,circleExpression){
  const userId=positiveId(context.payload.id??context.payload.uid);
  const circleId=positiveId(context.membership.id);
  const version=Number(context.context_version);
  const hash=context.payload.sessionHash;
  if(!/^[a-f0-9]{64}$/.test(hash)||!Number.isSafeInteger(version)||version<0) throw new TypeError('invalid workspace session');
  const selection=context.implicit
    ?`NOT EXISTS (SELECT 1 FROM auth_session_circle_contexts ctx WHERE ctx.session_hash=session.session_hash AND ctx.user_id=session.user_id)
       AND NOT EXISTS (SELECT 1 FROM circle_memberships other JOIN circles other_circle ON other_circle.id=other.circle_id
         WHERE other.user_id=session.user_id AND other.status='active' AND other_circle.archived_at IS NULL AND other.circle_id<>${circleId})`
    :`EXISTS (SELECT 1 FROM auth_session_circle_contexts ctx WHERE ctx.session_hash=session.session_hash AND ctx.user_id=session.user_id
         AND ctx.circle_id=${circleId} AND ctx.context_version=${version})`;
  return `${circleExpression}=${circleId} AND EXISTS (SELECT 1 FROM auth_sessions session
    WHERE session.session_hash='${hash}' AND session.user_id=${userId} AND session.revoked_at IS NULL
      AND session.expires_at>CAST(strftime('%s','now') AS INTEGER) AND ${selection})`;
}

export function secondaryPairAccessSql(context,{pairedOnly=false}={}){
  return `SELECT pg.id AS group_id,pg.publication_id,pg.circle_id,pg.scope_key,pg.cycle_key,
      pg.user_a_id,pg.user_b_id,NULL AS user_c_id,pg.is_solo,pg.member_count,
      'auth' AS user_a_source,CASE WHEN pg.user_b_id IS NULL THEN NULL ELSE 'auth' END AS user_b_source,NULL AS user_c_source
    FROM circle_pairing_groups pg
    JOIN circle_pairing_publications publication ON publication.id=pg.publication_id
      AND publication.scope_key=pg.scope_key AND publication.circle_id=pg.circle_id AND publication.cycle_key=pg.cycle_key
    JOIN circle_pairing_eligibility viewer ON viewer.publication_id=pg.publication_id
      AND viewer.scope_key=pg.scope_key AND viewer.circle_id=pg.circle_id AND viewer.cycle_key=pg.cycle_key
      AND viewer.user_id=? AND viewer.is_available=1 AND viewer.group_position=pg.position AND viewer.group_size=pg.member_count
    JOIN circle_memberships viewer_membership ON viewer_membership.circle_id=pg.circle_id
      AND viewer_membership.user_id=viewer.user_id AND viewer_membership.status='active'
    JOIN circles viewer_circle ON viewer_circle.id=pg.circle_id AND viewer_circle.is_primary=0 AND viewer_circle.archived_at IS NULL
    WHERE pg.id=? AND pg.publication_id=? AND (?=pg.user_a_id OR ?=pg.user_b_id) AND ? IN (pg.user_a_id,pg.user_b_id)
      AND ${workspaceSessionPredicate(context,'pg.circle_id')}${pairedOnly?' AND pg.is_solo=0 AND pg.member_count=2':''}
    LIMIT 1`;
}

export function secondaryPairAccessArgs({userId,viewerId,publicationId,groupId}){
  const actor=positiveId(userId??viewerId);
  return [actor,positiveId(groupId),positiveId(publicationId),actor,actor,actor];
}

export function scopedWorkspaceClient(db,context){
  function wrap(client,transaction=false){
    const check=async()=>{
      if(!await validateActiveCircleMutationContext(client,context.payload,{
        circleId:context.membership.id,contextVersion:context.context_version,implicit:context.implicit,
      })) throw new WorkspaceContextError('circle_context_changed');
    };
    const wrapped={workspaceContext:context,
      async execute(statement){
        if(context.membership.is_primary){
          const sql=typeof statement==='string'?statement:statement.sql;
          const scoped=sql.replace(/viewer_circle\.archived_at IS NULL/g,`viewer_circle.archived_at IS NULL AND ${workspaceSessionPredicate(context,'viewer_circle.id')}`);
          statement=typeof statement==='string'?scoped:{...statement,sql:scoped};
        }
        if(transaction){ await check(); return client.execute(statement); }
        const sql=typeof statement==='string'?statement:statement.sql;
        const mode=/\b(?:INSERT|UPDATE|DELETE)\b/i.test(sql)?'write':'read';
        const tx=await wrapped.transaction(mode);
        try{const result=await tx.execute(statement);await tx.commit();return result;}
        catch(error){try{await tx.rollback();}catch{}throw error;}
        finally{await tx.close?.();}
      },
      async batch(statements,mode='read'){
        const tx=await wrapped.transaction(mode);
        try{const results=[];for(const statement of statements)results.push(await tx.execute(statement));await tx.commit();return results;}
        catch(error){try{await tx.rollback();}catch{}throw error;}
        finally{await tx.close?.();}
      },
      async transaction(mode){const tx=await client.transaction(mode);const result=wrap(tx,true);try{await checkIn(result);return result;}catch(error){try{await tx.rollback();}catch{}await tx.close?.();throw error;}},
      async commit(){
        await check();
        try{return await client.commit();}
        catch(error){error.workspaceCommitAmbiguous=true;throw error;}
      },
      rollback:()=>client.rollback(),close:()=>client.close?.(),
    };
    async function checkIn(target){await target.execute('SELECT 1');}
    return wrapped;
  }
  return wrap(db);
}
