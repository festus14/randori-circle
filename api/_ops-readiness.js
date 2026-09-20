const notificationPreferencesReadinessByClient=new WeakMap();

/**
 * Prove the migration-owned notification-preference contract without changing
 * schema or application data. SQLite resolves every projected column before
 * returning LIMIT 0, so a missing or stale contract fails closed.
 */
async function probeNotificationPreferencesReadiness(db){
  await db.execute(`SELECT user_id,email_enabled,sms_enabled,phone,email,updated_at FROM user_notification_prefs LIMIT 0`);
  return true;
}

export async function ensureNotificationPreferencesReadiness(db){
  if(!db||typeof db.execute!=='function') throw new TypeError('database client is required');
  const existing=notificationPreferencesReadinessByClient.get(db);
  if(existing) return existing;
  const pending=probeNotificationPreferencesReadiness(db);
  notificationPreferencesReadinessByClient.set(db,pending);
  try{ return await pending; }
  catch(error){
    if(notificationPreferencesReadinessByClient.get(db)===pending){
      notificationPreferencesReadinessByClient.delete(db);
    }
    throw error;
  }
}
