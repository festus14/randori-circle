// Aggregate-only outbox delivery health for schedulers and the watchdog.
// Never returns payloads, idempotency keys, recipients or row identifiers.
export const OUTBOX_HEALTH_DEAD_LETTER_WINDOW_MS=24*60*60*1000;

const ISO_NOW=`strftime('%Y-%m-%dT%H:%M:%fZ','now')`;

function count(value){
  const parsed=Number(value??0);
  if(!Number.isSafeInteger(parsed)||parsed<0) throw new Error('outbox health unavailable');
  return parsed;
}

function instant(value){
  if(value===null||value===undefined||value==='') return null;
  const milliseconds=Date.parse(String(value));
  if(!Number.isFinite(milliseconds)) throw new Error('outbox health unavailable');
  return milliseconds;
}

function ageMs(now,then){
  return then===null?null:Math.max(0,now-then);
}

export async function readOutboxDeliveryHealth(db){
  if(!db||typeof db.execute!=='function') throw new TypeError('database client required');
  // One statement so every aggregate is judged against the same database clock.
  const result=await db.execute(`WITH clock AS (
      SELECT ${ISO_NOW} AS now_utc,
        strftime('%Y-%m-%dT%H:%M:%fZ','now','-1 day') AS dead_letter_floor
    )
    SELECT clock.now_utc,
      (SELECT COUNT(*) FROM outbox_events WHERE status IN ('pending','retry')
        AND not_before<=clock.now_utc AND next_attempt_at<=clock.now_utc) AS due_count,
      (SELECT MIN(MAX(not_before,next_attempt_at)) FROM outbox_events WHERE status IN ('pending','retry')
        AND not_before<=clock.now_utc AND next_attempt_at<=clock.now_utc) AS oldest_due_at,
      (SELECT COUNT(*) FROM outbox_events WHERE status='processing'
        AND leased_until<=clock.now_utc) AS processing_stale_count,
      (SELECT MIN(leased_until) FROM outbox_events WHERE status='processing'
        AND leased_until<=clock.now_utc) AS oldest_stale_lease_at,
      (SELECT COUNT(*) FROM outbox_events WHERE status='dead_letter'
        AND dead_lettered_at>=clock.dead_letter_floor) AS dead_letter_count,
      (SELECT MAX(delivered_at) FROM outbox_events WHERE status='delivered') AS last_delivered_at
    FROM clock`);
  const row=result?.rows?.[0];
  const now=instant(row?.now_utc);
  if(!row||now===null) throw new Error('outbox health unavailable');
  const lastDelivered=instant(row.last_delivered_at);
  return Object.freeze({
    ok:true,
    checkedAt:new Date(now).toISOString(),
    oldestDueAgeMs:ageMs(now,instant(row.oldest_due_at)),
    dueCount:count(row.due_count),
    processingStaleCount:count(row.processing_stale_count),
    oldestStaleLeaseAgeMs:ageMs(now,instant(row.oldest_stale_lease_at)),
    deadLetterCount:count(row.dead_letter_count),
    deadLetterWindowMs:OUTBOX_HEALTH_DEAD_LETTER_WINDOW_MS,
    lastDeliveredAt:lastDelivered===null?null:new Date(lastDelivered).toISOString(),
  });
}
