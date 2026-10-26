// Bounded 12-month retention for closed feedback (#353, owner decision
// 2026-10-22). Open items are kept until they are closed. The sweep
// deletes events, then votes, then the items themselves, each bounded by
// the same closed-item subquery, so it never depends on foreign-key
// enforcement on the calling connection and never scans the whole table.

import {
  FEEDBACK_CLOSED_RETENTION_SECONDS,
  FEEDBACK_RETENTION_BATCH_LIMIT,
  FEEDBACK_RETENTION_MAX_BATCHES,
  feedbackNow,
} from './_feedback-config.js';

export async function purgeClosedFeedback(db,{limit=FEEDBACK_RETENTION_BATCH_LIMIT,nowSeconds=null}={}){
  if(!db||typeof db.execute!=='function') throw new TypeError('database client is required');
  if(!Number.isSafeInteger(limit)||limit<1||limit>1000) throw new TypeError('retention limit must be 1-1000');
  const now=await feedbackNow(db,nowSeconds);
  const cutoff=now-FEEDBACK_CLOSED_RETENTION_SECONDS;
  const selector=`SELECT id FROM feedback_items
    WHERE status='closed' AND closed_at IS NOT NULL AND closed_at<=?
    ORDER BY closed_at,id LIMIT ?`;
  await db.execute({
    sql:`DELETE FROM feedback_events WHERE feedback_id IN (${selector})`,
    args:[cutoff,limit],
  });
  await db.execute({
    sql:`DELETE FROM feedback_votes WHERE feedback_id IN (${selector})`,
    args:[cutoff,limit],
  });
  const deleted=await db.execute({
    sql:`DELETE FROM feedback_items WHERE id IN (${selector}) RETURNING id`,
    args:[cutoff,limit],
  });
  const count=deleted.rows?.length||0;
  return Object.freeze({deleted:count,more:count===limit});
}

/** Weekly sweep driver: repeat bounded batches while work remains. */
export async function runFeedbackRetention(db,{nowSeconds=null,limit=FEEDBACK_RETENTION_BATCH_LIMIT,
  maxBatches=FEEDBACK_RETENTION_MAX_BATCHES}={}){
  if(!Number.isSafeInteger(maxBatches)||maxBatches<1||maxBatches>100) throw new TypeError('retention batches must be 1-100');
  const now=await feedbackNow(db,nowSeconds);
  const total={deleted:0,batches:0,more:false};
  for(let batch=0;batch<maxBatches;batch+=1){
    const result=await purgeClosedFeedback(db,{limit,nowSeconds:now});
    total.deleted+=result.deleted; total.batches+=1; total.more=result.more;
    if(!result.more) break;
  }
  return Object.freeze(total);
}
