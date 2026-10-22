// Outbox personal-data retention (ID-83, issue #341).
//
// Delivered, suppressed and dead-lettered outbox rows used to keep recipient
// addresses and sealed credentials for ever. The outbox cron calls
// runOutboxPiiRetention after its delivery round, only while
// OUTBOX_PII_RETENTION_ENABLED=true. Each call:
//   - claims the current hour by the database clock with one atomic
//     INSERT ... WHERE NOT EXISTS of an `outbox_pii_retention` app_logs row
//     (server row without a user, like the ID-72 app_logs retention claim), so
//     a call inside the hour, or a concurrent one, does nothing;
//   - redacts at most `limit` rows per class, oldest first:
//       delivered   7 days after delivered_at,
//       suppressed  7 days after the suppression (updated_at),
//       dead_letter 30 days after dead_lettered_at, so admin replay keeps
//                   working for a month;
//     A redacted row loses the contact and credential fields listed in
//     OUTBOX_PII_FIELDS and its provider message id, and gains the
//     `retention_redacted` marker. Type, version, status, idempotency key,
//     counts, error codes, timestamps and the audit trail are unchanged, so
//     health, the watchdog, admin diagnostics and producer dedupe still work;
//   - replaces the address in legacy pre-v6 `pairing_email_outbox` rows that
//     are older than 30 days and were either sent or already bridged into
//     outbox_events.
// Pending, retry and processing (leased) rows are never selected. Every
// redaction is one UPDATE whose candidate subquery runs in the same write, so
// a concurrent claim, replay or second run can never interleave with it, and a
// rerun only finds rows that still hold personal data. No DDL: the class scans
// use idx_outbox_events_dispatch, since a terminal row's next_attempt_at is its
// finalization instant and never later than the anchor timestamp.
//
// This module has no imports from the outbox core so api/_outbox.js,
// api/_key-rotation.js and api/_invitation-email.js can share its marker SQL.

export const OUTBOX_PII_RETENTION_FLAG='OUTBOX_PII_RETENTION_ENABLED';
export const OUTBOX_PII_RETENTION_DELIVERED_DAYS=7;
export const OUTBOX_PII_RETENTION_DEAD_LETTER_DAYS=30;
export const OUTBOX_PII_RETENTION_LEGACY_DAYS=30;
export const OUTBOX_PII_RETENTION_BATCH_LIMIT=100;
export const OUTBOX_PII_RETENTION_MAX_BATCH_LIMIT=500;
export const OUTBOX_PII_RETENTION_INTERVAL_MINUTES=60;
export const OUTBOX_PII_RETENTION_EVENT='outbox_pii_retention';
export const OUTBOX_REDACTED_MARKER='retention_redacted';
// RFC 6761 reserves `.invalid`: the placeholder can never be delivered.
export const OUTBOX_LEGACY_REDACTED_EMAIL='redacted@redacted.invalid';

// Event types whose payloads hold a recipient address or a sealed credential.
// Literals (not imports) keep this module free of cycles; a unit test checks
// them against the producer constants.
export const OUTBOX_PII_EVENT_TYPES=Object.freeze([
  'pairing.email.requested', // v1 recipient_email; v2 (secondary) carries ids only
  'invitation.email.requested', // credential_envelope seals {email, token}; email_hash, token_hash
  'auth.emailverification.requested', // recipient_email, token_envelope
  'auth.passwordreset.requested', // recipient_email, token_envelope
]);
export const OUTBOX_PII_FIELDS=Object.freeze([
  'recipient_email','credential_envelope','token_envelope','email_hash','token_hash',
]);
const INVITATION_EVENT_TYPE='invitation.email.requested';

const DAY_MS=24*60*60*1000;

// Classes in processing order. `anchor` is the timestamp the window counts
// from; the `next_attempt_at` range only narrows the index scan.
const CLASSES=Object.freeze([
  Object.freeze({key:'dead_letter',status:'dead_letter',days:OUTBOX_PII_RETENTION_DEAD_LETTER_DAYS,
    anchor:'COALESCE(event.dead_lettered_at,event.updated_at)'}),
  Object.freeze({key:'delivered',status:'delivered',days:OUTBOX_PII_RETENTION_DELIVERED_DAYS,
    anchor:'COALESCE(event.delivered_at,event.updated_at)'}),
  Object.freeze({key:'suppressed',status:'suppressed',days:OUTBOX_PII_RETENTION_DELIVERED_DAYS,
    anchor:'event.updated_at'}),
]);

export function outboxPiiRetentionEnabled(env=process.env){
  return env?.[OUTBOX_PII_RETENTION_FLAG]==='true';
}

/** SQL that is true when the row's payload was redacted by retention. */
export function outboxRedactedSql(column='payload_json'){
  return `json_type(${column},'$.${OUTBOX_REDACTED_MARKER}') IS NOT NULL`;
}

/** SQL that is true while the row's payload is intact. */
export function outboxNotRedactedSql(column='payload_json'){
  return `json_type(${column},'$.${OUTBOX_REDACTED_MARKER}') IS NULL`;
}

/** A dead letter whose personal data retention removed cannot be replayed. */
export class OutboxEventRedactedError extends Error{
  constructor(){
    super('Outbox event personal data was removed by retention; it cannot be replayed.');
    this.name='OutboxEventRedactedError';
    this.code='OUTBOX_EVENT_REDACTED';
  }
}

function emptyCounts(){
  return {delivered:0,suppressed:0,dead_letter:0,legacy_pairing:0};
}

function canonicalInstant(value){
  const milliseconds=value instanceof Date?value.getTime():Date.parse(String(value??''));
  if(!Number.isFinite(milliseconds)) throw new TypeError('valid outbox retention time is required');
  return new Date(milliseconds).toISOString();
}

function cutoff(instant,days){
  return new Date(Date.parse(instant)-days*DAY_MS).toISOString();
}

const PII_PRESENT=`(${OUTBOX_PII_FIELDS
  .map(field=>`json_type(event.payload_json,'$.${field}') IS NOT NULL`).join(' OR ')})`;
const REMOVED_PATHS=OUTBOX_PII_FIELDS.map(field=>`'$.${field}'`).join(',');
const TYPE_PLACEHOLDERS=OUTBOX_PII_EVENT_TYPES.map(()=>'?').join(',');

/**
 * One bounded, atomic redaction of a class. The invitation email is the only
 * copy of the invited address, and owner resend reopens the latest envelope,
 * so an invitation event is skipped while its invitation can still be used.
 */
export function outboxRedactionStatement({status,anchor,cutoffAt,now,limit}){
  return {
    sql:`UPDATE outbox_events
      SET payload_json=json_set(json_remove(payload_json,${REMOVED_PATHS}),'$.${OUTBOX_REDACTED_MARKER}',1),
        provider_message_id=NULL
      WHERE id IN (
        SELECT event.id FROM outbox_events event
        WHERE event.status=? AND event.next_attempt_at<? AND ${anchor}<?
          AND event.event_type IN (${TYPE_PLACEHOLDERS}) AND ${PII_PRESENT}
          AND NOT (event.event_type=? AND EXISTS (
            SELECT 1 FROM circle_invitations invitation
            WHERE invitation.id=json_extract(event.payload_json,'$.invitation_id')
              AND invitation.used_at IS NULL AND invitation.used_by IS NULL
              AND invitation.revoked_at IS NULL AND datetime(invitation.expires_at)>datetime(?)))
        ORDER BY event.next_attempt_at,event.not_before,event.id LIMIT ?
      )`,
    args:[status,cutoffAt,cutoffAt,...OUTBOX_PII_EVENT_TYPES,INVITATION_EVENT_TYPE,now,limit],
  };
}

/**
 * Legacy pre-v6 pairing rows. A pending row that has not been bridged into
 * outbox_events yet is left alone: the bridge still needs its address.
 */
export function legacyPairingRedactionStatement({now,limit}){
  return {
    sql:`UPDATE pairing_email_outbox SET recipient_email=?,provider_message_id=NULL,last_error=NULL
      WHERE id IN (
        SELECT legacy.id FROM pairing_email_outbox legacy
        WHERE legacy.recipient_email<>?
          AND datetime(COALESCE(legacy.sent_at,legacy.updated_at,legacy.created_at))<datetime(?,?)
          AND (legacy.status='sent' OR EXISTS (SELECT 1 FROM outbox_events current
            WHERE current.idempotency_key='randori/'||legacy.week_id||'/'||legacy.kind||'/'||legacy.user_id))
        ORDER BY legacy.id LIMIT ?
      )`,
    args:[OUTBOX_LEGACY_REDACTED_EMAIL,OUTBOX_LEGACY_REDACTED_EMAIL,now,
      `-${OUTBOX_PII_RETENTION_LEGACY_DAYS} days`,limit],
  };
}

/**
 * Run one throttled retention pass. `now` (tests only) replaces the database
 * instant the windows count from; the hourly claim always uses the database
 * clock. `shouldContinue` is checked before each statement so a caller's
 * budget stops new work. Returns counts only.
 */
export async function runOutboxPiiRetention(db,{
  limit=OUTBOX_PII_RETENTION_BATCH_LIMIT,now=null,shouldContinue=()=>true,
}={}){
  if(!db||typeof db.execute!=='function') throw new TypeError('database client is required');
  if(!Number.isSafeInteger(limit)||limit<1||limit>OUTBOX_PII_RETENTION_MAX_BATCH_LIMIT){
    throw new TypeError(`outbox retention limit must be 1-${OUTBOX_PII_RETENTION_MAX_BATCH_LIMIT}`);
  }
  if(typeof shouldContinue!=='function') throw new TypeError('outbox retention shouldContinue must be a function');
  const injected=now===null?null:canonicalInstant(now);
  const claim=await db.execute({
    sql:`INSERT INTO app_logs (level, source, event, message, created_at)
      SELECT 'info','server',?,'outbox personal data retention ran',datetime('now')
      WHERE NOT EXISTS (
        SELECT 1 FROM app_logs
        WHERE event=? AND source='server' AND user_id IS NULL AND created_at>datetime('now',?)
      )
      RETURNING id,strftime('%Y-%m-%dT%H:%M:%fZ','now') AS now_utc`,
    args:[OUTBOX_PII_RETENTION_EVENT,OUTBOX_PII_RETENTION_EVENT,
      `-${OUTBOX_PII_RETENTION_INTERVAL_MINUTES} minutes`],
  });
  if(!claim.rows?.length) return Object.freeze({ran:false,redacted:Object.freeze(emptyCounts()),more:false});
  const instant=injected??canonicalInstant(claim.rows[0].now_utc);
  const counts=emptyCounts();
  let more=false;
  const statements=[
    ...CLASSES.map(item=>({key:item.key,statement:outboxRedactionStatement({
      status:item.status,anchor:item.anchor,cutoffAt:cutoff(instant,item.days),now:instant,limit,
    })})),
    {key:'legacy_pairing',statement:legacyPairingRedactionStatement({now:instant,limit})},
  ];
  for(const {key,statement} of statements){
    if(!shouldContinue()){ more=true; break; }
    const result=await db.execute(statement);
    counts[key]=Number(result.rowsAffected)||0;
    if(counts[key]>=limit) more=true;
  }
  return Object.freeze({ran:true,redacted:Object.freeze(counts),more});
}
