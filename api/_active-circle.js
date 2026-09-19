import { randomUUID } from 'node:crypto';

export const MAX_CIRCLES_PER_ACCOUNT=100;

const SESSION_HASH_PATTERN=/^[0-9a-f]{64}$/;
const PUBLIC_ID_PATTERN=/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

export function multiCircleControlPlaneEnabled(){
  return process.env.CIRCLE_MEMBERSHIP_ENABLED==='true'
    &&process.env.MULTI_CIRCLE_CONTROL_PLANE_ENABLED==='true';
}

export function multiCircleAvailabilityEnabled(){
  return multiCircleControlPlaneEnabled()
    &&process.env.MULTI_CIRCLE_AVAILABILITY_ENABLED==='true';
}

function positiveInteger(value){
  const parsed=typeof value==='number'?value
    :(typeof value==='string'&&/^[1-9]\d*$/.test(value)?Number(value):null);
  return Number.isSafeInteger(parsed)&&parsed>0?parsed:null;
}

function contextVersion(value){
  const parsed=typeof value==='number'?value
    :(typeof value==='string'&&/^(?:0|[1-9]\d*)$/.test(value)?Number(value):null);
  return Number.isSafeInteger(parsed)&&parsed>=0?parsed:null;
}

function sessionIdentity(payload){
  const userId=positiveInteger(payload?.id??payload?.uid);
  const sessionHash=typeof payload?.sessionHash==='string'&&SESSION_HASH_PATTERN.test(payload.sessionHash)
    ?payload.sessionHash:null;
  return userId&&sessionHash?{userId,sessionHash}:null;
}

export function normalizeCirclePublicId(value){
  if(typeof value!=='string') return null;
  const normalized=value.trim();
  return PUBLIC_ID_PATTERN.test(normalized)?normalized:null;
}

export function requestCircleContextVersion(req){
  const value=req?.headers?.['x-randori-circle-context-version'];
  if(Array.isArray(value)||typeof value!=='string'||!/^(?:0|[1-9]\d*)$/.test(value)) return null;
  return contextVersion(value);
}

export function requestMatchesCircleContext(req,context){
  const expected=requestCircleContextVersion(req);
  return expected!==null&&expected===contextVersion(context?.context_version);
}

export async function validateActiveCircleMutationContext(db,payload,{circleId,contextVersion:version,implicit=false}={}){
  const identity=sessionIdentity(payload);
  const selectedCircleId=positiveInteger(circleId);
  const expectedVersion=contextVersion(version);
  if(!db||typeof db.execute!=='function'||!identity||!selectedCircleId||expectedVersion===null){
    throw new TypeError('valid active circle mutation context is required');
  }
  const contextPredicate=implicit
    ?`NOT EXISTS (SELECT 1 FROM auth_session_circle_contexts context
          WHERE context.session_hash=session.session_hash AND context.user_id=session.user_id)
        AND NOT EXISTS (
          SELECT 1 FROM circle_memberships other_membership
          JOIN circles other_circle ON other_circle.id=other_membership.circle_id
          WHERE other_membership.user_id=session.user_id
            AND other_membership.status='active' AND other_circle.archived_at IS NULL
            AND other_membership.circle_id<>membership.circle_id
        )`
    :`EXISTS (
          SELECT 1 FROM auth_session_circle_contexts context
          WHERE context.session_hash=session.session_hash AND context.user_id=session.user_id
            AND context.circle_id=membership.circle_id AND context.context_version=?
        )`;
  const result=await db.execute({
    sql:`SELECT membership.circle_id
      FROM auth_sessions session
      JOIN circle_memberships membership ON membership.user_id=session.user_id
      JOIN circles circle ON circle.id=membership.circle_id
      WHERE session.session_hash=? AND session.user_id=? AND session.revoked_at IS NULL
        AND session.expires_at>CAST(strftime('%s','now') AS INTEGER)
        AND membership.circle_id=? AND membership.status='active' AND circle.archived_at IS NULL
        AND ${contextPredicate}
      LIMIT 2`,
    args:implicit
      ?[identity.sessionHash,identity.userId,selectedCircleId]
      :[identity.sessionHash,identity.userId,selectedCircleId,expectedVersion],
  });
  return result.rows?.length===1;
}

function publicMembership(row){
  const circleId=positiveInteger(Number(row?.circle_id));
  const publicId=normalizeCirclePublicId(row?.public_id);
  const role=row?.role==='owner'?'owner':row?.role==='member'?'member':null;
  const name=String(row?.name||'').trim().slice(0,120);
  if(!circleId||!publicId||!role||!name) throw new Error('invalid active circle membership');
  return Object.freeze({
    id:circleId,
    public_id:publicId,
    name,
    role,
    is_primary:Number(row?.is_primary)===1,
  });
}

export async function listSessionCircleContexts(db,payload){
  const identity=sessionIdentity(payload);
  if(!db||typeof db.execute!=='function'||!identity){
    throw new TypeError('valid authenticated circle context is required');
  }
  const [membershipResult,contextResult]=await Promise.all([
    db.execute({
      sql:`SELECT circle.id AS circle_id,circle.public_id,circle.name,circle.is_primary,membership.role
        FROM circle_memberships membership
        JOIN circles circle ON circle.id=membership.circle_id
        WHERE membership.user_id=? AND membership.status='active' AND circle.archived_at IS NULL
        ORDER BY circle.is_primary DESC,circle.id
        LIMIT ?`,
      args:[identity.userId,MAX_CIRCLES_PER_ACCOUNT+1],
    }),
    db.execute({
      sql:`SELECT context.circle_id,context.context_version
        FROM auth_session_circle_contexts context
        JOIN auth_sessions session ON session.session_hash=context.session_hash
          AND session.user_id=context.user_id
        WHERE context.session_hash=? AND context.user_id=?
          AND session.revoked_at IS NULL AND session.expires_at>CAST(strftime('%s','now') AS INTEGER)
        LIMIT 2`,
      args:[identity.sessionHash,identity.userId],
    }),
  ]);
  const rows=membershipResult.rows||[];
  if(rows.length>MAX_CIRCLES_PER_ACCOUNT) throw new Error('active circle membership limit exceeded');
  const circles=Object.freeze(rows.map(publicMembership));
  const contextRows=contextResult.rows||[];
  if(contextRows.length>1) throw new Error('invalid active circle context');
  const storedVersion=contextRows.length?contextVersion(Number(contextRows[0].context_version)):0;
  if(storedVersion===null) throw new Error('invalid active circle context');
  const storedCircleId=contextRows.length?positiveInteger(Number(contextRows[0].circle_id)):null;
  const selected=storedCircleId?circles.find(circle=>circle.id===storedCircleId)||null:null;
  const implicit=contextRows.length===0&&circles.length===1;
  const active=selected||(implicit?circles[0]:null);
  return Object.freeze({
    circles,
    active,
    context_version:storedVersion,
    selection_required:circles.length>0&&!active,
    implicit,
  });
}

export async function resolveActiveCircleContext(db,payload,{requiredRole=null}={}){
  const listed=await listSessionCircleContexts(db,payload);
  if(!listed.circles.length) return Object.freeze({ok:false,reason:'membership_required',...listed});
  if(!listed.active) return Object.freeze({ok:false,reason:'selection_required',...listed});
  if(requiredRole&&listed.active.role!==requiredRole){
    return Object.freeze({ok:false,reason:'role_required',...listed});
  }
  return Object.freeze({ok:true,membership:listed.active,...listed});
}

async function rollback(transaction){
  try{ await transaction.rollback(); }catch{}
}

export async function selectActiveCircleContext(db,payload,{circlePublicId,expectedContextVersion,nowSeconds=Math.floor(Date.now()/1000)}={}){
  const identity=sessionIdentity(payload);
  const publicId=normalizeCirclePublicId(circlePublicId);
  const expected=contextVersion(expectedContextVersion);
  if(!db||typeof db.transaction!=='function'||!identity||!publicId||expected===null
    ||!Number.isSafeInteger(nowSeconds)||nowSeconds<1){
    throw new TypeError('valid active circle selection is required');
  }
  const transaction=await db.transaction('write');
  let finished=false;
  try{
    const membership=await transaction.execute({
      sql:`SELECT circle.id AS circle_id,circle.public_id,circle.name,circle.is_primary,membership.role
        FROM auth_sessions session
        JOIN circle_memberships membership ON membership.user_id=session.user_id
        JOIN circles circle ON circle.id=membership.circle_id
        WHERE session.session_hash=? AND session.user_id=? AND session.revoked_at IS NULL
          AND session.expires_at>? AND membership.status='active'
          AND circle.public_id=? AND circle.archived_at IS NULL
        LIMIT 2`,
      args:[identity.sessionHash,identity.userId,nowSeconds,publicId],
    });
    if(membership.rows?.length!==1){
      await rollback(transaction); finished=true;
      return Object.freeze({ok:false,reason:'circle_unavailable'});
    }
    const selected=publicMembership(membership.rows[0]);
    const current=await transaction.execute({
      sql:`SELECT circle_id,context_version FROM auth_session_circle_contexts
        WHERE session_hash=? AND user_id=? LIMIT 2`,
      args:[identity.sessionHash,identity.userId],
    });
    if((current.rows?.length||0)>1) throw new Error('invalid active circle context');
    const currentVersion=current.rows?.length?contextVersion(Number(current.rows[0].context_version)):0;
    if(currentVersion===null) throw new Error('invalid active circle context');
    if(currentVersion!==expected){
      await rollback(transaction); finished=true;
      return Object.freeze({ok:false,reason:'context_changed',context_version:currentVersion});
    }
    if(current.rows?.length&&Number(current.rows[0].circle_id)===selected.id){
      await transaction.commit(); finished=true;
      return Object.freeze({ok:true,membership:selected,context_version:currentVersion,changed:false});
    }
    const nextVersion=currentVersion+1;
    const changed=current.rows?.length
      ?await transaction.execute({
        sql:`UPDATE auth_session_circle_contexts SET circle_id=?,context_version=?,updated_at=?
          WHERE session_hash=? AND user_id=? AND context_version=?
            AND EXISTS (SELECT 1 FROM circle_memberships membership
              JOIN circles circle ON circle.id=membership.circle_id
              WHERE membership.circle_id=? AND membership.user_id=? AND membership.status='active'
                AND circle.archived_at IS NULL)
          RETURNING circle_id,context_version`,
        args:[selected.id,nextVersion,nowSeconds,identity.sessionHash,identity.userId,currentVersion,
          selected.id,identity.userId],
      })
      :await transaction.execute({
        sql:`INSERT INTO auth_session_circle_contexts
            (session_hash,user_id,circle_id,context_version,updated_at)
          SELECT session.session_hash,session.user_id,membership.circle_id,?,?
          FROM auth_sessions session
          JOIN circle_memberships membership ON membership.user_id=session.user_id
          JOIN circles circle ON circle.id=membership.circle_id
          WHERE session.session_hash=? AND session.user_id=? AND session.revoked_at IS NULL
            AND session.expires_at>? AND membership.circle_id=? AND membership.status='active'
            AND circle.archived_at IS NULL
          RETURNING circle_id,context_version`,
        args:[nextVersion,nowSeconds,identity.sessionHash,identity.userId,nowSeconds,selected.id],
      });
    if(changed.rows?.length!==1||Number(changed.rows[0].circle_id)!==selected.id
      ||Number(changed.rows[0].context_version)!==nextVersion){
      await rollback(transaction); finished=true;
      return Object.freeze({ok:false,reason:'context_changed'});
    }
    const audit=await transaction.execute({
      sql:`INSERT INTO circle_audit_events
          (circle_id,event_type,actor_user_id,subject_user_id,invitation_id,dedupe_key,created_at)
        VALUES (?,'circle.context.selected',?,?,NULL,?,strftime('%Y-%m-%dT%H:%M:%fZ','now'))
        RETURNING id`,
      args:[selected.id,identity.userId,identity.userId,`circle-context-selected:${randomUUID()}`],
    });
    if(audit.rows?.length!==1) throw new Error('active circle selection audit unavailable');
    await transaction.commit(); finished=true;
    return Object.freeze({ok:true,membership:selected,context_version:nextVersion,changed:true});
  }catch(error){
    if(!finished) await rollback(transaction);
    throw error;
  }finally{ try{ await transaction.close?.(); }catch{} }
}

export async function accountHasMultipleActiveCircles(db,userId){
  const normalizedUserId=positiveInteger(userId);
  if(!db||typeof db.execute!=='function'||!normalizedUserId) throw new TypeError('valid account is required');
  const result=await db.execute({
    sql:`SELECT membership.circle_id
      FROM circle_memberships membership
      JOIN circles circle ON circle.id=membership.circle_id
      WHERE membership.user_id=? AND membership.status='active' AND circle.archived_at IS NULL
      ORDER BY membership.circle_id LIMIT 2`,
    args:[normalizedUserId],
  });
  return (result.rows?.length||0)>1;
}

export async function canUseLegacySinglePrimaryCircleFeatures(db,payload){
  const identity=sessionIdentity(payload);
  if(!db||typeof db.execute!=='function'||!identity) return false;
  const result=await db.execute({
    sql:`SELECT COUNT(circle.id) AS active_circle_count,
        COALESCE(SUM(CASE WHEN circle.is_primary=1 THEN 1 ELSE 0 END),0) AS primary_circle_count,
        context.circle_id AS selected_circle_id,
        COALESCE(MAX(CASE WHEN context.circle_id=circle.id THEN 1 ELSE 0 END),0) AS selected_circle_active
      FROM auth_sessions session
      LEFT JOIN circle_memberships membership ON membership.user_id=session.user_id
        AND membership.status='active'
      LEFT JOIN circles circle ON circle.id=membership.circle_id AND circle.archived_at IS NULL
      LEFT JOIN auth_session_circle_contexts context
        ON context.session_hash=session.session_hash AND context.user_id=session.user_id
      WHERE session.session_hash=? AND session.user_id=? AND session.revoked_at IS NULL
        AND session.expires_at>CAST(strftime('%s','now') AS INTEGER)
      GROUP BY session.session_hash,context.circle_id
      LIMIT 2`,
    args:[identity.sessionHash,identity.userId],
  });
  if(result.rows?.length!==1) return false;
  const row=result.rows[0];
  const selectedCircleId=row.selected_circle_id==null?null:positiveInteger(Number(row.selected_circle_id));
  return Number(row.active_circle_count)===1
    &&Number(row.primary_circle_count)===1
    &&(selectedCircleId===null||Number(row.selected_circle_active)===1);
}

export function sendMultiCircleFeatureUnavailable(res){
  return res.status(409).json({
    error:'pairing and workspace features are not available for this circle context',
    code:'circle_feature_unavailable',
  });
}
