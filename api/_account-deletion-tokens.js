// Issue #350: email proofs never share password-reset credentials or eligibility.
import {createHmac,randomBytes,randomUUID} from 'node:crypto';
import {getJwtSecret} from './_db.js';
import {hashInvitationEmail,normalizeInvitationEmail} from './_circle-membership.js';
import {schemaCapabilityAvailable} from './_schema-capability.js';
import {createOutboxEventStatement,OutboxDeliveryError,outboxStatementIdentity} from './_outbox.js';
import {openCredentialEnvelope,parseKeyRing,sealCredentialEnvelope} from './_key-rotation.js';
import {emailProviderReason} from './_email-provider-reason.js';

export const DELETION_TOKEN_MIGRATION_VERSION=24;
export const DELETION_REQUEST_TOKEN_TTL_SECONDS=24*60*60;
export const DELETION_TOKEN_RESEND_SECONDS=60;
export const DELETION_TOKEN_MAX_SENDS=5;
export const DELETION_LINK_EVENT_TYPE='account.deletion.link';
const TOKEN_PATTERN=/^[A-Za-z0-9_-]{43}$/;
export const NO_ACTIVE_MEMBERSHIP_SQL=`NOT EXISTS (SELECT 1 FROM circle_memberships membership
  JOIN circles circle ON circle.id=membership.circle_id
  WHERE membership.user_id=account.id AND membership.status='active' AND circle.archived_at IS NULL)`;

export function deletionTokenSchemaAvailable(db){
  return schemaCapabilityAvailable(db,{version:DELETION_TOKEN_MIGRATION_VERSION});
}
export function createDeletionToken(){return randomBytes(32).toString('base64url');}
export function hashDeletionToken(token,purpose){
  if(typeof token!=='string'||!TOKEN_PATTERN.test(token)||!['request','cancel'].includes(purpose)) return null;
  return createHmac('sha256',getJwtSecret()).update(`randori-account-deletion/${purpose}/v1\0${token}`).digest('hex');
}
// Separate encryption and hash domains. Like the session/rate-limit proofs,
// these credentials depend on JWT_SECRET; rotating it invalidates old links.
// Only authenticated ciphertext goes in the outbox; the token table holds hashes.
function envelopeRing(purpose){
  return parseKeyRing({env:{write:'2'},purpose:`account-deletion-${purpose}`,
    keyEnv:'key',versionEnv:'version',previousKeysEnv:'previous',writeVersionEnv:'write',
    fallbackKey:()=>createHmac('sha256',getJwtSecret())
      .update(`randori-account-deletion/${purpose}/delivery/v1`).digest()});
}
export function sealDeletionToken(token,purpose,idempotencyKey){
  if(!hashDeletionToken(token,purpose)) throw new TypeError('valid deletion token required');
  return sealCredentialEnvelope({plaintext:token,idempotencyKey,ring:envelopeRing(purpose),legacyAad:()=>Buffer.from(`randori-account-deletion/${purpose}/delivery/v1`)});
}
export function openDeletionToken(envelope,purpose,idempotencyKey){
  try{
    const opened=openCredentialEnvelope({envelope,idempotencyKey,ring:envelopeRing(purpose),legacyAad:()=>Buffer.from(`randori-account-deletion/${purpose}/delivery/v1`),
      minPlaintextBytes:43,maxPlaintextBytes:43});
    const token=opened.plaintext.toString('utf8');
    return hashDeletionToken(token,purpose)?token:null;
  }catch{return null;}
}
export async function readDeletionToken(transaction,{token,purpose,nowSeconds}){
  // Hash before lookup, including malformed inputs (a fixed impossible hash).
  const tokenHash=hashDeletionToken(token,purpose)||'0'.repeat(64);
  const result=await transaction.execute({
    sql:`SELECT proof.*,account.email,account.password_hash,account.is_demo
      FROM account_deletion_tokens proof JOIN auth_accounts account ON account.id=proof.user_id
      WHERE proof.token_hash=? AND proof.purpose=? AND proof.used_at IS NULL
        AND proof.revoked_at IS NULL AND proof.expires_at>? LIMIT 2`,args:[tokenHash,purpose,nowSeconds],
  });
  const row=result.rows?.length===1?result.rows[0]:null;
  if(!row||Number(row.is_demo)===1||row.password_hash==='!account-deleted'
    ||hashInvitationEmail(String(row.email))!==row.email_hash) return null;
  return row;
}

export async function requestAccountDeletionEmail(db,{email},{nowSeconds=Math.floor(Date.now()/1000)}={}){
  const normalized=normalizeInvitationEmail(email);
  const emailHash=hashInvitationEmail(normalized);
  const id=randomUUID(),token=createDeletionToken(),tokenHash=hashDeletionToken(token,'request');
  const transaction=await db.transaction('write');
  try{
    const result=await transaction.execute({
      sql:`INSERT INTO account_deletion_tokens
        (id,user_id,purpose,email_hash,token_hash,created_at,expires_at,last_sent_at,send_count)
        SELECT ?,account.id,'request',?,?,?,?,?,1 FROM auth_accounts account
        WHERE lower(account.email)=? AND account.password_hash<>'!account-deleted'
          AND COALESCE(account.is_demo,0)=0 AND ${NO_ACTIVE_MEMBERSHIP_SQL}
          AND NOT EXISTS (SELECT 1 FROM account_deletion_requests pending WHERE pending.user_id=account.id
            AND pending.cancelled_at IS NULL AND pending.executed_at IS NULL)
        ON CONFLICT(user_id,purpose) DO UPDATE SET
          id=excluded.id,email_hash=excluded.email_hash,token_hash=excluded.token_hash,
          created_at=CASE WHEN account_deletion_tokens.used_at IS NOT NULL OR account_deletion_tokens.revoked_at IS NOT NULL
            OR account_deletion_tokens.expires_at<=? THEN excluded.created_at ELSE account_deletion_tokens.created_at END,
          expires_at=excluded.expires_at,last_sent_at=excluded.last_sent_at,
          send_count=CASE WHEN account_deletion_tokens.used_at IS NOT NULL OR account_deletion_tokens.revoked_at IS NOT NULL
            OR account_deletion_tokens.expires_at<=? THEN 1 ELSE account_deletion_tokens.send_count+1 END,
          used_at=NULL,revoked_at=NULL
        WHERE account_deletion_tokens.used_at IS NOT NULL OR account_deletion_tokens.revoked_at IS NOT NULL
          OR account_deletion_tokens.expires_at<=?
          OR (account_deletion_tokens.send_count<? AND account_deletion_tokens.last_sent_at<=?)
        RETURNING id,user_id,send_count`,
      args:[id,emailHash||'0'.repeat(64),tokenHash,nowSeconds,nowSeconds+DELETION_REQUEST_TOKEN_TTL_SECONDS,nowSeconds,
        normalized||'',nowSeconds,nowSeconds,nowSeconds,DELETION_TOKEN_MAX_SENDS,nowSeconds-DELETION_TOKEN_RESEND_SECONDS],
    });
    const row=result.rows?.[0];
    let event;
    if(row){
      const key=`account-deletion-link/v1/${row.id}/${row.send_count}`;
      event=createOutboxEventStatement({eventType:DELETION_LINK_EVENT_TYPE,eventVersion:1,idempotencyKey:key,
        payload:{token_id:String(row.id),recipient_user_id:Number(row.user_id),
          token_envelope:sealDeletionToken(token,'request',key)},maxAttempts:5,deliveryTimeoutMs:10_000});
      await transaction.execute(event);
    }else{
      await transaction.execute({sql:'SELECT id FROM outbox_events WHERE idempotency_key=? LIMIT 1',args:[`account-deletion-link/v1/${id}/1`]});
    }
    await transaction.commit();
    return Object.freeze(row?{accepted:true,outboxEvents:Object.freeze([outboxStatementIdentity(event)])}:{accepted:false});
  }catch(error){try{await transaction.rollback();}catch{}throw error;}
}

export function createAccountDeletionLinkEmailHandler({db,baseUrl,send}){
  const origin=new URL(baseUrl).origin;
  return async(event,{signal}={})=>{
    const payload=event.payload;
    if(event.eventVersion!==1||!payload||Object.keys(payload).sort().join(',')!=='recipient_user_id,token_envelope,token_id'){
      throw new OutboxDeliveryError('PAYLOAD_INVALID',{retryable:false});
    }
    if(process.env.ACCOUNT_DELETION_ENABLED!=='true'||process.env.ACCOUNT_DELETION_GRACE_ENABLED!=='true'){
      return {status:'suppressed',reasonCode:'ACCOUNT_DELETION_DISABLED'};
    }
    if(!await deletionTokenSchemaAvailable(db)) return {status:'suppressed',reasonCode:'DELETION_TOKEN_SCHEMA_UNAVAILABLE'};
    const token=openDeletionToken(payload.token_envelope,'request',event.idempotencyKey);
    if(!token) throw new OutboxDeliveryError('PAYLOAD_INVALID',{retryable:false});
    const nowSeconds=Math.floor(Date.now()/1000);
    const proof=await readDeletionToken(db,{token,purpose:'request',nowSeconds});
    if(!proof||proof.id!==payload.token_id||Number(proof.user_id)!==payload.recipient_user_id){
      return {status:'suppressed',reasonCode:'ACCOUNT_DELETION_LINK_INACTIVE'};
    }
    const eligible=await db.execute({sql:`SELECT account.id FROM auth_accounts account WHERE account.id=?
      AND ${NO_ACTIVE_MEMBERSHIP_SQL} AND NOT EXISTS (SELECT 1 FROM account_deletion_requests pending
        WHERE pending.user_id=account.id AND pending.cancelled_at IS NULL AND pending.executed_at IS NULL)`,args:[Number(proof.user_id)]});
    if(eligible.rows?.length!==1) return {status:'suppressed',reasonCode:'ACCOUNT_DELETION_LINK_INACTIVE'};
    try{
      const delivery=await send({to:String(proof.email).trim().toLowerCase(),subject:'Confirm deletion of your Randori Circle account',
        html:`<h2>Delete your Randori Circle account</h2><p><a href="${origin}/delete-account#token=${encodeURIComponent(token)}">Confirm account deletion</a></p><p>This single-use link expires in 24 hours. You will be asked to type DELETE. Your account will then be locked and scheduled for deletion 14 days later.</p><p>If you did not request this, ignore this email.</p>`,idempotencyKey:event.idempotencyKey,signal});
      if(delivery?.error) throw delivery.error;
      return {status:'delivered',providerName:String(delivery?.providerName||'email'),providerMessageId:delivery?.providerMessageId||delivery?.data?.id||null};
    }catch(error){
      const status=Number(error?.statusCode||error?.status);
      throw new OutboxDeliveryError(status===429?'PROVIDER_RATE_LIMITED':status>=400&&status<=499?'PROVIDER_REJECTED':'PROVIDER_FAILED',
        {retryable:status===429||!(status>=400&&status<=499),cause:error,providerReason:emailProviderReason(error)});
    }
  };
}

/** Persist the cancel proof and its sealed delivery envelope atomically on
 * first delivery. Retry uses the same token/provider idempotency key. A newer
 * email replaces the cancel proof; replaying an older email cannot revive it.
 * Works for v23 pending requests and queued emails after the additive cutover.
 */
export async function cancelTokenForDeletionEmail(db,event,pending,{nowSeconds=Math.floor(Date.now()/1000)}={}){
  if(!await deletionTokenSchemaAvailable(db)||pending.scheduled_for<=nowSeconds) return null;
  const tx=await db.transaction('write');
  try{
    const live=await tx.execute({sql:`SELECT pending.id,account.email FROM account_deletion_requests pending
      JOIN auth_accounts account ON account.id=pending.user_id WHERE pending.id=? AND pending.scheduled_for=?
      AND pending.cancelled_at IS NULL AND pending.executed_at IS NULL AND account.password_hash<>'!account-deleted'`,
      args:[pending.id,pending.scheduled_for]});
    const stored=await tx.execute({sql:'SELECT id,payload_json FROM outbox_events WHERE idempotency_key=? LIMIT 1',args:[event.idempotencyKey]});
    if(live.rows?.length!==1||stored.rows?.length!==1){await tx.rollback();return null;}
    const payload=JSON.parse(stored.rows[0].payload_json);
    if(payload.token_envelope){
      const token=openDeletionToken(payload.token_envelope,'cancel',event.idempotencyKey);
      const proof=await readDeletionToken(tx,{token,purpose:'cancel',nowSeconds});
      await tx.rollback();
      return proof&&Number(proof.deletion_request_id)===pending.id?token:null;
    }
    const newer=await tx.execute({sql:`SELECT event.id FROM account_deletion_tokens proof
      JOIN outbox_events event ON json_extract(event.payload_json,'$.token_id')=proof.id
      WHERE proof.user_id=? AND proof.purpose='cancel' AND event.id>? LIMIT 1`,
      args:[pending.user_id,Number(stored.rows[0].id)]});
    if(newer.rows?.length){await tx.rollback();return null;}
    const token=createDeletionToken(),id=randomUUID();
    await tx.execute({sql:`INSERT INTO account_deletion_tokens
      (id,user_id,purpose,deletion_request_id,email_hash,token_hash,created_at,expires_at,last_sent_at)
      VALUES (?,?,'cancel',?,?,?,?,?,?) ON CONFLICT(user_id,purpose) DO UPDATE SET
        id=excluded.id,deletion_request_id=excluded.deletion_request_id,email_hash=excluded.email_hash,
        token_hash=excluded.token_hash,created_at=excluded.created_at,expires_at=excluded.expires_at,
        last_sent_at=excluded.last_sent_at,send_count=1,used_at=NULL,revoked_at=NULL`,
      args:[id,pending.user_id,pending.id,hashInvitationEmail(String(live.rows[0].email)),hashDeletionToken(token,'cancel'),nowSeconds,pending.scheduled_for,nowSeconds]});
    await tx.execute({sql:`UPDATE outbox_events SET payload_json=json_set(payload_json,'$.token_envelope',?,'$.token_id',?) WHERE id=?`,
      args:[sealDeletionToken(token,'cancel',event.idempotencyKey),id,Number(stored.rows[0].id)]});
    await tx.commit();return token;
  }catch(error){try{await tx.rollback();}catch{}throw error;}
}
