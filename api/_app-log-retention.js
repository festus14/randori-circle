// Bounded app_logs retention (ID-72).
//
// app_logs had no retention: client warn/error entries, server ops logs, the
// runner lease/quota rows and an `outbox_invocation` row every five minutes
// only ever accumulated. The outbox cron calls runAppLogRetention after its
// delivery round. Each call:
//   - claims the current hour by the database clock with one atomic
//     INSERT ... WHERE NOT EXISTS; the claimed row is also the visible record
//     of the run. A call inside the hour (or a concurrent one) does nothing;
//   - deletes at most 1000 rows whose created_at is older than 30 days,
//     oldest first, through idx_logs_created (schema plan 1). No DDL.
// Deleting is idempotent: rerunning only removes rows that are still past the
// cutoff. Runner lease and quota checks read the last 30 seconds and the last
// minute only, so 30 days never removes a row they depend on.

export const APP_LOG_RETENTION_DAYS=30;
export const APP_LOG_RETENTION_BATCH_LIMIT=1000;
export const APP_LOG_RETENTION_INTERVAL_MINUTES=60;
export const APP_LOG_RETENTION_EVENT='app_logs_retention';

export async function runAppLogRetention(db,{limit=APP_LOG_RETENTION_BATCH_LIMIT}={}){
  if(!db||typeof db.execute!=='function') throw new TypeError('database client is required');
  if(!Number.isSafeInteger(limit)||limit<1||limit>APP_LOG_RETENTION_BATCH_LIMIT){
    throw new TypeError(`retention limit must be 1-${APP_LOG_RETENTION_BATCH_LIMIT}`);
  }
  const claim=await db.execute({
    sql:`INSERT INTO app_logs (level, source, event, message, created_at)
      SELECT 'info','server',?,'app_logs retention ran',datetime('now')
      WHERE NOT EXISTS (
        SELECT 1 FROM app_logs
        WHERE event=? AND source='server' AND created_at>datetime('now',?)
      )
      RETURNING id`,
    args:[APP_LOG_RETENTION_EVENT,APP_LOG_RETENTION_EVENT,`-${APP_LOG_RETENTION_INTERVAL_MINUTES} minutes`],
  });
  if(!claim.rows?.length) return Object.freeze({ran:false,purged:0,more:false});
  const purged=await db.execute({
    sql:`DELETE FROM app_logs WHERE id IN (
        SELECT id FROM app_logs WHERE created_at<datetime('now',?)
        ORDER BY created_at LIMIT ?
      )`,
    args:[`-${APP_LOG_RETENTION_DAYS} days`,limit],
  });
  const count=Number(purged.rowsAffected)||0;
  return Object.freeze({ran:true,purged:count,more:count>=limit});
}
