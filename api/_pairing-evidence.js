import {
  PAIRING_EMAIL_EVENT_TYPE,
  PRIMARY_PAIRING_EMAIL_EVENT_VERSION,
} from './_pairing-email-contract.js';

function positiveInteger(value,name){
  const parsed=Number(value);
  if(!Number.isSafeInteger(parsed)||parsed<1) throw new TypeError(`${name} must be a positive integer`);
  return parsed;
}

/**
 * Read exact durable evidence that the primary publication snapshotted a
 * member as unavailable. Delivery state is deliberately irrelevant: the
 * versioned event itself was committed atomically with the publication.
 */
export async function hasPrimaryUnavailableEvidence(db,{weekId,userId}={}){
  if(!db||typeof db.execute!=='function') throw new TypeError('database client is required');
  const week=positiveInteger(weekId,'weekId');
  const user=positiveInteger(userId,'userId');
  const result=await db.execute({
    sql:`SELECT 1 AS unavailable FROM outbox_events
      WHERE event_type=? AND event_version=?
        AND idempotency_key='randori/'||CAST(? AS INTEGER)||'/unavailable/'||CAST(? AS INTEGER)
        AND json_valid(payload_json)=1
        AND json_type(payload_json,'$.week_id')='integer'
        AND json_extract(payload_json,'$.week_id')=?
        AND json_type(payload_json,'$.user_id')='integer'
        AND json_extract(payload_json,'$.user_id')=?
        AND json_type(payload_json,'$.kind')='text'
        AND json_extract(payload_json,'$.kind')='unavailable'
      LIMIT 1`,
    args:[PAIRING_EMAIL_EVENT_TYPE,PRIMARY_PAIRING_EMAIL_EVENT_VERSION,
      week,user,week,user],
  });
  return !!result.rows?.length;
}
