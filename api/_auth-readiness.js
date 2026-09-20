const readinessByClient=new WeakMap();

/**
 * Request-safe readiness for the migration-owned authentication core.
 *
 * These projections deliberately include every column used by ordinary auth
 * requests. SQLite resolves all referenced columns before returning LIMIT 0,
 * so a missing or outdated contract fails closed without mutating schema.
 */
async function probeAuthReadiness(db){
  await db.execute(`SELECT id,email,password_hash,display_name,color,created_at,last_login,
    is_available,availability_updated_at,is_admin,google_sub FROM auth_accounts LIMIT 0`);
  await db.execute(`SELECT id,name,color,created_at FROM users LIMIT 0`);
  await db.execute(`SELECT key,attempts,expires_at FROM auth_rate_limits LIMIT 0`);
  await db.execute(`SELECT session_hash,user_id,created_at,expires_at,revoked_at,
    revocation_reason FROM auth_sessions LIMIT 0`);
  return true;
}

export async function ensureAuthReadiness(db){
  if(!db||typeof db.execute!=='function') throw new TypeError('database client is required');
  const existing=readinessByClient.get(db);
  if(existing) return existing;
  const pending=probeAuthReadiness(db);
  readinessByClient.set(db,pending);
  try{ return await pending; }
  catch(error){
    if(readinessByClient.get(db)===pending) readinessByClient.delete(db);
    throw error;
  }
}
