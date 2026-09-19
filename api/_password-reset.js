import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from 'node:crypto';

import { getJwtSecret, revokeAccountSessions } from './_db.js';
import { hashInvitationEmail, normalizeInvitationEmail } from './_circle-membership.js';
import { createOutboxEventStatement, OutboxDeliveryError, readOutboxMetrics, runOutboxWorker } from './_outbox.js';

export const PASSWORD_RESET_EVENT_TYPE='auth.passwordreset.requested';
export const PASSWORD_RESET_EVENT_VERSION=1;
export const PASSWORD_RESET_TTL_SECONDS=30*60;
export const PASSWORD_RESET_RESEND_SECONDS=60;
export const PASSWORD_RESET_MAX_SENDS=5;

const TOKEN_PATTERN=/^[A-Za-z0-9_-]{43}$/;
const UUID_PATTERN=/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;

function safeEqual(left,right){
  const a=Buffer.from(String(left||''));
  const b=Buffer.from(String(right||''));
  return a.length===b.length&&timingSafeEqual(a,b);
}

function encryptionKey(){
  const encoded=String(process.env.PASSWORD_RESET_ENCRYPTION_KEY||'').trim();
  if(/^[A-Za-z0-9_-]{43}$/.test(encoded)){
    const key=Buffer.from(encoded,'base64url');
    if(key.length===32) return key;
  }
  if(process.env.NODE_ENV!=='production'){
    return createHmac('sha256',getJwtSecret())
      .update('randori-password-reset-envelope-v1','utf8').digest();
  }
  throw new Error('PASSWORD_RESET_ENCRYPTION_KEY must be a base64url-encoded 32-byte key');
}

function configuredOrigin(){
  let url;
  try{ url=new URL(String(process.env.APP_URL||'')); }catch{ return null; }
  const loopback=['localhost','127.0.0.1','[::1]'].includes(url.hostname.toLowerCase());
  if(url.username||url.password||url.search||url.hash||(url.pathname&&url.pathname!=='/')) return null;
  if(process.env.NODE_ENV==='production'&&(url.protocol!=='https:'||loopback)) return null;
  if(!['http:','https:'].includes(url.protocol)) return null;
  return url.origin;
}

export function passwordResetConfiguration(){
  if(process.env.PASSWORD_RESET_ENABLED!=='true') return null;
  if(process.env.NODE_ENV==='production'
    &&(!String(process.env.RESEND_API_KEY||'').trim()||!String(process.env.RESEND_FROM||'').trim())) return null;
  const origin=configuredOrigin();
  if(!origin) return null;
  try{ encryptionKey(); }catch{ return null; }
  return Object.freeze({origin});
}

export function createPasswordResetToken(){
  return randomBytes(32).toString('base64url');
}

export function hashPasswordResetToken(token){
  if(typeof token!=='string'||!TOKEN_PATTERN.test(token)) return null;
  return createHmac('sha256',getJwtSecret())
    .update(`randori-password-reset-token-v1\0${token}`,'utf8').digest('hex');
}

export function sealPasswordResetToken(token){
  if(!hashPasswordResetToken(token)) throw new TypeError('invalid password reset token');
  const iv=randomBytes(12);
  const cipher=createCipheriv('aes-256-gcm',encryptionKey(),iv);
  cipher.setAAD(Buffer.from('randori-password-reset-envelope-v1','utf8'));
  const ciphertext=Buffer.concat([cipher.update(token,'utf8'),cipher.final()]);
  const tag=cipher.getAuthTag();
  return `${iv.toString('base64url')}.${ciphertext.toString('base64url')}.${tag.toString('base64url')}`;
}

export function openPasswordResetToken(envelope){
  const parts=typeof envelope==='string'?envelope.split('.'):[];
  if(parts.length!==3) return null;
  try{
    const [iv,ciphertext,tag]=parts.map(value=>Buffer.from(value,'base64url'));
    if([iv,ciphertext,tag].some((value,index)=>value.toString('base64url')!==parts[index])) return null;
    if(iv.length!==12||tag.length!==16||ciphertext.length!==43) return null;
    const decipher=createDecipheriv('aes-256-gcm',encryptionKey(),iv);
    decipher.setAAD(Buffer.from('randori-password-reset-envelope-v1','utf8'));
    decipher.setAuthTag(tag);
    const token=Buffer.concat([decipher.update(ciphertext),decipher.final()]).toString('utf8');
    return hashPasswordResetToken(token)?token:null;
  }catch{ return null; }
}

export async function ensurePasswordResetReadiness(db){
  if(!db||typeof db.execute!=='function') throw new TypeError('database client is required');
  await db.execute(`SELECT id,user_id,email_hash,token_hash,created_at,expires_at,last_sent_at,
    send_count,used_at,revoked_at FROM auth_password_resets LIMIT 0`);
  await db.execute(`SELECT session_hash,user_id,authenticated_at,method FROM auth_recent_proofs LIMIT 0`);
  await db.execute(`SELECT id,event_type,event_version,idempotency_key FROM outbox_events LIMIT 0`);
}

async function resetNow(db,override){
  if(override!==null&&override!==undefined){
    if(!Number.isSafeInteger(override)||override<1) throw new TypeError('valid password reset time is required');
    return override;
  }
  const result=await db.execute(`SELECT CAST(strftime('%s','now') AS INTEGER) AS now_seconds`);
  const now=Number(result.rows?.[0]?.now_seconds);
  if(!Number.isSafeInteger(now)||now<1) throw new Error('database password reset time unavailable');
  return now;
}

function resetEvent({resetId,email,tokenEnvelope,sendCount}){
  return createOutboxEventStatement({
    eventType:PASSWORD_RESET_EVENT_TYPE,eventVersion:PASSWORD_RESET_EVENT_VERSION,
    idempotencyKey:`password-reset/v1/${resetId}/${sendCount}`,
    payload:{reset_id:resetId,recipient_email:email,token_envelope:tokenEnvelope},
    maxAttempts:5,deliveryTimeoutMs:10_000,
  });
}

export async function requestPasswordReset(db,{email},{nowSeconds=null}={}){
  if(!db||typeof db.transaction!=='function') throw new TypeError('database client is required');
  const normalizedEmail=normalizeInvitationEmail(email);
  const emailHash=hashInvitationEmail(normalizedEmail);
  const resetId=randomUUID();
  const token=createPasswordResetToken();
  const tokenHash=hashPasswordResetToken(token);
  const tokenEnvelope=sealPasswordResetToken(token);
  const transaction=await db.transaction('write');
  let finished=false;
  try{
    nowSeconds=await resetNow(transaction,nowSeconds);
    const membershipPredicate=process.env.CIRCLE_MEMBERSHIP_ENABLED==='true'
      ?`AND EXISTS (SELECT 1 FROM circle_memberships membership JOIN circles circle ON circle.id=membership.circle_id
          WHERE membership.user_id=account.id AND membership.status='active'
            AND circle.is_primary=1 AND circle.archived_at IS NULL)`
      :'';
    let row=null;
    if(normalizedEmail&&emailHash){
      const reset=await transaction.execute({
        sql:`INSERT INTO auth_password_resets
            (id,user_id,email_hash,token_hash,created_at,expires_at,last_sent_at,send_count)
          SELECT ?,account.id,?,?,?,?,?,1 FROM auth_accounts account
          WHERE lower(account.email)=? AND account.password_hash LIKE '$2%' ${membershipPredicate}
          ON CONFLICT(user_id) DO UPDATE SET
            id=excluded.id,email_hash=excluded.email_hash,token_hash=excluded.token_hash,
            created_at=CASE WHEN auth_password_resets.used_at IS NOT NULL
              OR auth_password_resets.revoked_at IS NOT NULL OR auth_password_resets.expires_at<=?
              THEN excluded.created_at ELSE auth_password_resets.created_at END,
            expires_at=excluded.expires_at,last_sent_at=excluded.last_sent_at,
            send_count=CASE WHEN auth_password_resets.used_at IS NOT NULL
              OR auth_password_resets.revoked_at IS NOT NULL OR auth_password_resets.expires_at<=?
              THEN 1 ELSE auth_password_resets.send_count+1 END,
            used_at=NULL,revoked_at=NULL
          WHERE auth_password_resets.used_at IS NOT NULL OR auth_password_resets.revoked_at IS NOT NULL
            OR auth_password_resets.expires_at<=?
            OR (auth_password_resets.send_count<? AND auth_password_resets.last_sent_at<=?)
          RETURNING id,user_id,send_count`,
        args:[resetId,emailHash,tokenHash,nowSeconds,nowSeconds+PASSWORD_RESET_TTL_SECONDS,nowSeconds,
          normalizedEmail,nowSeconds,nowSeconds,nowSeconds,PASSWORD_RESET_MAX_SENDS,
          nowSeconds-PASSWORD_RESET_RESEND_SECONDS],
      });
      row=reset.rows?.[0]||null;
    }else{
      await transaction.execute({sql:`SELECT id FROM auth_password_resets WHERE token_hash=? LIMIT 1`,args:[tokenHash]});
    }
    if(row){
      await transaction.execute(resetEvent({resetId:String(row.id),email:normalizedEmail,
        tokenEnvelope,sendCount:Number(row.send_count)}));
    }else{
      await transaction.execute({sql:`SELECT id FROM outbox_events WHERE idempotency_key=? LIMIT 1`,
        args:[`password-reset/v1/${resetId}/1`]});
    }
    await transaction.commit(); finished=true;
    return Object.freeze({accepted:Boolean(row)});
  }catch(error){
    if(!finished){ try{ await transaction.rollback(); }catch{} }
    throw error;
  }
}

function retryableConflict(error){
  let current=error;
  for(let depth=0;current&&depth<6;depth+=1){
    const code=String(current.code||current.rawCode||'').toUpperCase();
    if(['SQLITE_BUSY','SQLITE_BUSY_SNAPSHOT','SQLITE_LOCKED','SQLITE_LOCKED_SHAREDCACHE',
      'TRANSACTION_CONFLICT','LIBSQL_TRANSACTION_BUSY'].includes(code)) return true;
    if(/^(?:SQLITE_(?:BUSY|LOCKED)(?::|\s+-)\s*)?database (?:table )?is locked$/i.test(String(current.message||''))) return true;
    current=current.cause;
  }
  return false;
}

async function consumePasswordResetAttempt(db,{token,passwordHash},{nowSeconds=null}={}){
  if(!db||typeof db.transaction!=='function') throw new TypeError('database client is required');
  const tokenHash=hashPasswordResetToken(token);
  if(!tokenHash||typeof passwordHash!=='string'||!passwordHash.startsWith('$2')||passwordHash.length>128){
    return Object.freeze({status:'invalid'});
  }
  let transaction;
  let finished=false;
  let commitStarted=false;
  const finish=async result=>{
    await transaction.rollback();
    try{ await transaction.close?.(); }catch{}
    finished=true;
    return Object.freeze(result);
  };
  try{
    transaction=await db.transaction('write');
    nowSeconds=await resetNow(transaction,nowSeconds);
    const selected=await transaction.execute({
      sql:`SELECT reset.*,account.email,account.password_hash
        FROM auth_password_resets reset JOIN auth_accounts account ON account.id=reset.user_id
        WHERE reset.token_hash=? LIMIT 2`,args:[tokenHash],
    });
    if(selected.rows?.length!==1) return await finish({status:'invalid'});
    const reset=selected.rows[0];
    if(reset.used_at!==null) return await finish({status:'used'});
    if(reset.revoked_at!==null) return await finish({status:'revoked'});
    if(Number(reset.expires_at)<=nowSeconds) return await finish({status:'expired'});
    const currentEmailHash=hashInvitationEmail(String(reset.email||''));
    if(!currentEmailHash||!safeEqual(currentEmailHash,reset.email_hash)
      ||!String(reset.password_hash||'').startsWith('$2')) return await finish({status:'revoked'});
    const changed=await transaction.execute({
      sql:`UPDATE auth_accounts SET password_hash=?
        WHERE id=? AND lower(email)=? AND password_hash LIKE '$2%' RETURNING id`,
      args:[passwordHash,Number(reset.user_id),String(reset.email).toLowerCase()],
    });
    if(changed.rows?.length!==1) return await finish({status:'revoked'});
    await revokeAccountSessions(transaction,Number(reset.user_id),'password_change',{nowSeconds});
    const consumed=await transaction.execute({
      sql:`UPDATE auth_password_resets SET used_at=?
        WHERE id=? AND token_hash=? AND used_at IS NULL AND revoked_at IS NULL AND expires_at>?
        RETURNING id`,args:[nowSeconds,reset.id,tokenHash,nowSeconds],
    });
    if(consumed.rows?.length!==1) return await finish({status:'revoked'});
    commitStarted=true;
    await transaction.commit();
    try{ await transaction.close?.(); }catch{}
    finished=true;
    return Object.freeze({status:'reset'});
  }catch(error){
    if(transaction&&!finished&&!commitStarted){
      try{ await transaction.rollback(); }catch{}
      try{ await transaction.close?.(); }catch{}
    }
    if(!commitStarted&&retryableConflict(error)) error.passwordResetRetryable=true;
    throw error;
  }
}

export async function consumePasswordReset(db,input,options={}){
  for(let attempt=1;attempt<=4;attempt+=1){
    try{ return await consumePasswordResetAttempt(db,input,options); }
    catch(error){
      if(error?.passwordResetRetryable!==true||attempt===4) throw error;
      await new Promise(resolve=>setTimeout(resolve,Math.min(50,5*(2**(attempt-1)))));
    }
  }
  return Object.freeze({status:'invalid'});
}

function resetPayload(event){
  if(event.eventVersion!==PASSWORD_RESET_EVENT_VERSION) throw new TypeError('unsupported password reset event');
  const payload=event.payload;
  if(!payload||Object.keys(payload).sort().join(',')!=='recipient_email,reset_id,token_envelope'){
    throw new TypeError('invalid password reset event payload');
  }
  const resetId=String(payload.reset_id||'').toLowerCase();
  const email=normalizeInvitationEmail(payload.recipient_email);
  const token=openPasswordResetToken(payload.token_envelope);
  if(!UUID_PATTERN.test(resetId)||!email||!token) throw new TypeError('invalid password reset event payload');
  return {resetId,email,token,tokenHash:hashPasswordResetToken(token)};
}

export function createPasswordResetHandler({db,baseUrl,send}={}){
  if(!db||typeof db.execute!=='function'||typeof send!=='function') throw new TypeError('password reset database and provider are required');
  let origin;
  try{ origin=new URL(String(baseUrl)).origin; }catch{ throw new TypeError('valid password reset base URL required'); }
  return async(event,{signal}={})=>{
    let payload;
    try{ payload=resetPayload(event); }
    catch{ return {status:'suppressed',reasonCode:'PAYLOAD_INVALID'}; }
    const membershipPredicate=process.env.CIRCLE_MEMBERSHIP_ENABLED==='true'
      ?`AND EXISTS (SELECT 1 FROM circle_memberships membership JOIN circles circle ON circle.id=membership.circle_id
          WHERE membership.user_id=account.id AND membership.status='active'
            AND circle.is_primary=1 AND circle.archived_at IS NULL)`
      :'';
    const current=await db.execute({
      sql:`SELECT reset.id FROM auth_password_resets reset
        JOIN auth_accounts account ON account.id=reset.user_id
        WHERE reset.id=? AND reset.token_hash=? AND lower(account.email)=?
          AND reset.email_hash=? AND account.password_hash LIKE '$2%'
          AND reset.used_at IS NULL AND reset.revoked_at IS NULL
          AND reset.expires_at>CAST(strftime('%s','now') AS INTEGER) ${membershipPredicate}
        LIMIT 2`,
      args:[payload.resetId,payload.tokenHash,payload.email,hashInvitationEmail(payload.email)],
    });
    if(current.rows?.length!==1) return {status:'suppressed',reasonCode:'PASSWORD_RESET_INACTIVE'};
    const resetUrl=`${origin}/reset-password#token=${encodeURIComponent(payload.token)}`;
    try{
      const delivery=await send({
        to:payload.email,subject:'Reset your Randori password',
        html:`<h2>Reset your Randori password</h2><p><a href="${resetUrl}">Choose a new password</a></p><p>This single-use link expires in 30 minutes. If you did not request it, you can ignore this email.</p>`,
        idempotencyKey:event.idempotencyKey,signal,
      });
      if(delivery?.error) throw delivery.error;
      return {status:'delivered',providerName:String(delivery?.providerName||'email').slice(0,100),
        providerMessageId:delivery?.providerMessageId||delivery?.data?.id||null};
    }catch(error){
      if(error instanceof OutboxDeliveryError) throw error;
      const status=Number(error?.statusCode||error?.status||error?.response?.status||error?.error?.statusCode);
      if(status===429) throw new OutboxDeliveryError('PROVIDER_RATE_LIMITED',{retryable:true,cause:error});
      if(status>=400&&status<=499) throw new OutboxDeliveryError('PROVIDER_REJECTED',{retryable:false,cause:error});
      throw new OutboxDeliveryError('PROVIDER_FAILED',{retryable:true,cause:error});
    }
  };
}

export async function deliverPasswordResets({db,baseUrl,send,workerId,workerOptions={}}={}){
  const handler=createPasswordResetHandler({db,baseUrl,send});
  const result=await runOutboxWorker({db,workerId,eventType:PASSWORD_RESET_EVENT_TYPE,
    handlers:{[PASSWORD_RESET_EVENT_TYPE]:handler},...workerOptions});
  const metrics=await readOutboxMetrics(db,{eventType:PASSWORD_RESET_EVENT_TYPE});
  return Object.freeze({...result,metrics});
}

export async function passwordResetStatus(db){
  const counts={pending:0,processing:0,retry:0,delivered:0,suppressed:0,dead_letter:0};
  for(const metric of await readOutboxMetrics(db,{eventType:PASSWORD_RESET_EVENT_TYPE})){
    counts[metric.status]=(counts[metric.status]||0)+metric.count;
  }
  return counts;
}
