// Dependency-free core of the invite-request feature (WP-L2): the flag, the
// read-only schema probe, the pre-v21 tolerance check, and bounded retention.
// Kept free of membership/outbox imports so capability discovery and the
// weekly sweep do not load the request or delivery code paths.

export const INVITE_REQUEST_TTL_SECONDS=30*24*60*60;
export const INVITE_REQUEST_RETENTION_SECONDS=30*24*60*60;
export const INVITE_REQUEST_RETENTION_BATCH_LIMIT=200;

const readinessByUrl=new Map();
const readinessByClient=new WeakMap();

/** Public intake, owner review, and capability advertisement share one flag. */
export function inviteRequestsEnabled(env=process.env){
  return env.INVITE_REQUESTS_ENABLED==='true'&&env.CIRCLE_MEMBERSHIP_ENABLED==='true';
}

function readinessCache(db){
  const databaseUrl=String(process.env.TURSO_DATABASE_URL||'').trim();
  return databaseUrl?{cache:readinessByUrl,key:databaseUrl}:{cache:readinessByClient,key:db};
}

async function probeInviteRequestSchema(db){
  await db.execute(`SELECT id,circle_id,email_hash,email,name,note,status,created_at,expires_at,
    decided_at,decided_by,invitation_id FROM invite_requests LIMIT 0`);
  await db.execute(`SELECT id,is_primary,archived_at,name FROM circles LIMIT 0`);
  await db.execute(`SELECT circle_id,user_id,role,status FROM circle_memberships LIMIT 0`);
  await db.execute(`SELECT id,circle_id,email_hash,expires_at,used_at,used_by,revoked_at FROM circle_invitations LIMIT 0`);
  await db.execute(`SELECT id,circle_id,event_type,actor_user_id,invitation_id,dedupe_key,created_at FROM circle_audit_events LIMIT 0`);
  await db.execute(`SELECT key,attempts,expires_at FROM auth_rate_limits LIMIT 0`);
  await db.execute(`SELECT id,email,is_demo FROM auth_accounts LIMIT 0`);
  await db.execute(`SELECT user_id,email_enabled FROM user_notification_prefs LIMIT 0`);
  await db.execute(`SELECT id,event_type,event_version,idempotency_key FROM outbox_events LIMIT 0`);
  return true;
}

/** Read-only, cached (success only) schema probe; never creates schema. */
export async function ensureInviteRequestReadiness(db){
  if(!db||typeof db.execute!=='function') throw new TypeError('database client is required');
  const {cache,key}=readinessCache(db);
  const existing=cache.get(key);
  if(existing) return existing;
  const pending=probeInviteRequestSchema(db);
  cache.set(key,pending);
  try{ return await pending; }
  catch(error){ if(cache.get(key)===pending) cache.delete(key); throw error; }
}

/** True only for the expected pre-v21 rollout state, never for other failures. */
export function inviteRequestSchemaNotInstalled(error){
  let current=error;
  for(let depth=0;current&&depth<6;depth+=1){
    if(/no such table:\s*(?:main\.)?invite_requests\b/i.test(String(current.message||''))) return true;
    current=current.cause;
  }
  return false;
}

export async function inviteRequestNow(db,override=null){
  if(override!==null&&override!==undefined){
    if(!Number.isSafeInteger(override)||override<1) throw new TypeError('valid time is required');
    return override;
  }
  const result=await db.execute(`SELECT CAST(strftime('%s','now') AS INTEGER) AS now_seconds`);
  const now=Number(result.rows?.[0]?.now_seconds);
  if(!Number.isSafeInteger(now)||now<1) throw new Error('database time unavailable');
  return now;
}

export const INVITE_REQUEST_SCRUB_SQL='email=NULL,name=NULL,note=NULL';

/**
 * Bounded retention for the scheduled sweep: expire overdue pending requests
 * (scrubbing their contact data) and delete decided rows older than the
 * retention window. The two statements are independent and each is atomic and
 * touches at most `limit` rows, so no wrapping transaction is needed.
 */
export async function purgeInviteRequests(db,{limit=INVITE_REQUEST_RETENTION_BATCH_LIMIT,nowSeconds=null}={}){
  if(!db||typeof db.execute!=='function') throw new TypeError('database client is required');
  if(!Number.isSafeInteger(limit)||limit<1||limit>1000) throw new TypeError('retention limit must be 1-1000');
  const now=await inviteRequestNow(db,nowSeconds);
  const expired=await db.execute({
    sql:`UPDATE invite_requests SET status='expired',${INVITE_REQUEST_SCRUB_SQL},decided_at=?
      WHERE id IN (SELECT id FROM invite_requests WHERE status='pending' AND expires_at<=?
        ORDER BY expires_at,id LIMIT ?) AND status='pending'
      RETURNING id`,
    args:[now,now,limit],
  });
  const purged=await db.execute({
    sql:`DELETE FROM invite_requests
      WHERE id IN (SELECT id FROM invite_requests WHERE decided_at IS NOT NULL AND decided_at<=?
        ORDER BY decided_at,id LIMIT ?) AND status<>'pending'
      RETURNING id`,
    args:[now-INVITE_REQUEST_RETENTION_SECONDS,limit],
  });
  const expiredCount=expired.rows?.length||0;
  const purgedCount=purged.rows?.length||0;
  return Object.freeze({expired:expiredCount,purged:purgedCount,more:expiredCount===limit||purgedCount===limit});
}
