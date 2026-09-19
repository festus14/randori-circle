import {
  createHmac,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from 'node:crypto';

import { getJwtSecret, issueSessionInTransaction } from './_db.js';
import { hashInvitationEmail, normalizeInvitationEmail } from './_circle-membership.js';
import {
  CredentialEnvelopeError,
  assertPurposeKeyIsolation,
  openCredentialEnvelope,
  parseKeyRing,
  readCredentialRotationMetrics,
  sealCredentialEnvelope,
} from './_key-rotation.js';
import { createOutboxEventStatement, OutboxDeliveryError, readOutboxMetrics, runOutboxWorker } from './_outbox.js';
import {
  assertCredentialKeyControl,
  credentialKeyControlStatus,
  withCredentialKeyControlStatus,
} from './_credential-key-control.js';

export const EMAIL_ACTIVATION_EVENT_TYPE='auth.emailverification.requested';
export const EMAIL_ACTIVATION_EVENT_VERSION=1;
export const EMAIL_ACTIVATION_TTL_SECONDS=30*60;
export const EMAIL_ACTIVATION_RESEND_SECONDS=60;
export const EMAIL_ACTIVATION_MAX_SENDS=5;
const TOKEN_PATTERN=/^[A-Za-z0-9_-]{43}$/;
const HASH_PATTERN=/^[a-f0-9]{64}$/;
const UUID_PATTERN=/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;

function safeEqual(left,right){
  const a=Buffer.from(String(left||''));
  const b=Buffer.from(String(right||''));
  return a.length===b.length&&timingSafeEqual(a,b);
}

function safeClaim(claim){
  if(!claim||typeof claim!=='object'||Array.isArray(claim)) return null;
  const invitationId=String(claim.invitation_id||'').toLowerCase();
  const circleId=Number(claim.circle_id);
  const tokenHash=String(claim.token_hash||'');
  const emailHash=String(claim.email_hash||'');
  if(!UUID_PATTERN.test(invitationId)||!Number.isSafeInteger(circleId)||circleId<1
    ||!HASH_PATTERN.test(tokenHash)||!HASH_PATTERN.test(emailHash)) return null;
  return {invitationId,circleId,tokenHash,emailHash};
}

export function activationKeyRing(env=process.env){
  try{
    const ring=parseKeyRing({
      env,purpose:'email-activation',
      keyEnv:'EMAIL_VERIFICATION_ENCRYPTION_KEY',
      versionEnv:'EMAIL_VERIFICATION_ENCRYPTION_KEY_VERSION',
      previousKeysEnv:'EMAIL_VERIFICATION_ENCRYPTION_PREVIOUS_KEYS',
      writeVersionEnv:'EMAIL_VERIFICATION_ENVELOPE_WRITE_VERSION',
      fallbackKey:()=>{
        if(env.NODE_ENV==='production') return null;
        return createHmac('sha256',getJwtSecret())
          .update('randori-email-verification-envelope-v1','utf8').digest();
      },
    });
    assertPurposeKeyIsolation({env,rings:[ring]});
    return ring;
  }catch(error){
    error.message='EMAIL_VERIFICATION_ENCRYPTION_KEY ring is invalid';
    throw error;
  }
}

const activationLegacyAad=()=>Buffer.from('randori-email-activation-envelope-v1','utf8');

function configuredOrigin(){
  let url;
  try{ url=new URL(String(process.env.APP_URL||'')); }catch{ return null; }
  const loopback=['localhost','127.0.0.1','[::1]'].includes(url.hostname.toLowerCase());
  if(url.username||url.password||url.search||url.hash||(url.pathname&&url.pathname!=='/')) return null;
  if(process.env.NODE_ENV==='production'&&(url.protocol!=='https:'||loopback)) return null;
  if(!['http:','https:'].includes(url.protocol)) return null;
  return url.origin;
}

export function emailActivationConfiguration(){
  if(process.env.EMAIL_PASSWORD_ACTIVATION_ENABLED!=='true'
    ||process.env.CIRCLE_MEMBERSHIP_ENABLED!=='true') return null;
  if(process.env.NODE_ENV==='production'
    &&(!String(process.env.RESEND_API_KEY||'').trim()||!String(process.env.RESEND_FROM||'').trim())) return null;
  const origin=configuredOrigin();
  if(!origin) return null;
  try{
    activationKeyRing();
    return Object.freeze({origin});
  }catch{ return null; }
}

export function createEmailActivationToken(){
  return randomBytes(32).toString('base64url');
}

export function hashEmailActivationToken(token){
  if(typeof token!=='string'||!TOKEN_PATTERN.test(token)) return null;
  return createHmac('sha256',getJwtSecret())
    .update(`randori-email-activation-token-v1\0${token}`,'utf8').digest('hex');
}

export function sealEmailActivationToken(token,{idempotencyKey}={}){
  if(!hashEmailActivationToken(token)) throw new TypeError('invalid email activation token');
  return sealCredentialEnvelope({plaintext:token,idempotencyKey,ring:activationKeyRing(),
    legacyAad:activationLegacyAad});
}

function openEmailActivationTokenStrict(envelope,{idempotencyKey}={}){
  const opened=openCredentialEnvelope({envelope,idempotencyKey,ring:activationKeyRing(),
    legacyAad:activationLegacyAad,minPlaintextBytes:43,maxPlaintextBytes:43});
  const token=opened.plaintext.toString('utf8');
  if(!hashEmailActivationToken(token)) throw new CredentialEnvelopeError('ENVELOPE_INVALID');
  return token;
}

export function openEmailActivationToken(envelope,{idempotencyKey}={}){
  try{
    return openEmailActivationTokenStrict(envelope,{idempotencyKey});
  }catch{ return null; }
}

export async function ensureEmailActivationReadiness(db){
  if(!db||typeof db.execute!=='function') throw new TypeError('database client is required');
  const ring=activationKeyRing();
  await db.execute(`SELECT id,invitation_id,circle_id,email,email_hash,password_hash,display_name,color,
    token_hash,created_at,expires_at,last_sent_at,send_count,used_at,revoked_at
    FROM auth_email_activations LIMIT 0`);
  await db.execute(`SELECT id,event_type,event_version,idempotency_key FROM outbox_events LIMIT 0`);
  await assertCredentialKeyControl(db,ring);
}

export async function emailActivationKeyRotationStatus(db){
  const ring=activationKeyRing();
  const [metrics,control]=await Promise.all([
    readCredentialRotationMetrics(db,{eventType:EMAIL_ACTIVATION_EVENT_TYPE,
      envelopeField:'token_envelope',ring}),
    credentialKeyControlStatus(db,ring),
  ]);
  return withCredentialKeyControlStatus(metrics,control);
}

function activationEvent({activationId,email,token,sendCount}){
  const idempotencyKey=`auth-activation/v1/${activationId}/${sendCount}`;
  return createOutboxEventStatement({
    eventType:EMAIL_ACTIVATION_EVENT_TYPE,eventVersion:EMAIL_ACTIVATION_EVENT_VERSION,
    idempotencyKey,
    payload:{activation_id:activationId,recipient_email:email,
      token_envelope:sealEmailActivationToken(token,{idempotencyKey})},
    maxAttempts:5,deliveryTimeoutMs:10_000,
  });
}

function validRegistration(input){
  const claim=safeClaim(input?.claim);
  const email=normalizeInvitationEmail(input?.email);
  const emailHash=hashInvitationEmail(email);
  const passwordHash=typeof input?.passwordHash==='string'&&input.passwordHash.startsWith('$2')
    &&input.passwordHash.length<=128?input.passwordHash:null;
  const displayName=typeof input?.displayName==='string'?input.displayName.trim().slice(0,32):'';
  const color=typeof input?.color==='string'&&input.color.length<=32?input.color:null;
  if(!claim||!email||!emailHash||!safeEqual(claim.emailHash,emailHash)||!passwordHash
    ||displayName.length<2||!color) return null;
  return {claim,email,emailHash,passwordHash,displayName,color};
}

async function activationNow(db,override){
  if(override!==null&&override!==undefined){
    if(!Number.isSafeInteger(override)||override<1) throw new TypeError('valid activation time is required');
    return override;
  }
  const result=await db.execute(`SELECT CAST(strftime('%s','now') AS INTEGER) AS now_seconds`);
  const now=Number(result.rows?.[0]?.now_seconds);
  if(!Number.isSafeInteger(now)||now<1) throw new Error('database activation time unavailable');
  return now;
}

export async function requestEmailActivation(db,input,{nowSeconds=null}={}){
  if(!db||typeof db.transaction!=='function') throw new TypeError('database client is required');
  const registration=validRegistration(input);
  const activationId=randomUUID();
  const token=createEmailActivationToken();
  const tokenHash=hashEmailActivationToken(token);
  // Parse the ring before opening the transaction so invalid production
  // configuration cannot create credentials that no worker can deliver.
  const ring=activationKeyRing();
  const transaction=await db.transaction('write');
  let finished=false;
  try{
    await assertCredentialKeyControl(transaction,ring);
    nowSeconds=await activationNow(transaction,nowSeconds);
    if(!registration){
      // Match the eligible path's bounded crypto/transaction/statement shape
      // without consulting identity data derived from malformed input.
      await transaction.execute({
        sql:`SELECT id FROM auth_email_activations WHERE token_hash=? LIMIT 1`,args:[tokenHash],
      });
      await transaction.execute({
        sql:`SELECT id FROM outbox_events WHERE idempotency_key=? LIMIT 1`,
        args:[`auth-activation/v1/${activationId}/1`],
      });
      await transaction.commit(); finished=true;
      return Object.freeze({accepted:false});
    }
    const {claim,email,emailHash,passwordHash,displayName,color}=registration;
    const expiresAt=nowSeconds+EMAIL_ACTIVATION_TTL_SECONDS;
    const pending=await transaction.execute({
      sql:`INSERT INTO auth_email_activations
          (id,invitation_id,circle_id,email,email_hash,password_hash,display_name,color,token_hash,
           created_at,expires_at,last_sent_at,send_count)
        SELECT ?,?,?,?,?,?,?,?,?,?,?,?,1
        WHERE EXISTS (
          SELECT 1 FROM circle_invitations invitation JOIN circles circle ON circle.id=invitation.circle_id
          WHERE invitation.id=? AND invitation.circle_id=? AND invitation.token_hash=?
            AND invitation.email_hash=? AND invitation.used_at IS NULL AND invitation.used_by IS NULL
            AND invitation.revoked_at IS NULL AND datetime(invitation.expires_at)>datetime('now')
            AND circle.is_primary=1 AND circle.archived_at IS NULL
        ) AND NOT EXISTS (SELECT 1 FROM auth_accounts WHERE lower(email)=?)
        ON CONFLICT(invitation_id) DO UPDATE SET
          email=excluded.email,email_hash=excluded.email_hash,password_hash=excluded.password_hash,
          display_name=excluded.display_name,color=excluded.color,token_hash=excluded.token_hash,
          expires_at=excluded.expires_at,last_sent_at=excluded.last_sent_at,
          send_count=auth_email_activations.send_count+1
        WHERE auth_email_activations.used_at IS NULL AND auth_email_activations.revoked_at IS NULL
          AND auth_email_activations.send_count<?
          AND auth_email_activations.last_sent_at<=?
          AND EXISTS (
            SELECT 1 FROM circle_invitations invitation JOIN circles circle ON circle.id=invitation.circle_id
            WHERE invitation.id=auth_email_activations.invitation_id
              AND invitation.circle_id=auth_email_activations.circle_id
              AND invitation.used_at IS NULL AND invitation.used_by IS NULL
              AND invitation.revoked_at IS NULL AND datetime(invitation.expires_at)>datetime('now')
              AND circle.is_primary=1 AND circle.archived_at IS NULL
          ) AND NOT EXISTS (SELECT 1 FROM auth_accounts WHERE lower(email)=excluded.email)
        RETURNING id,send_count`,
      args:[activationId,claim.invitationId,claim.circleId,email,emailHash,passwordHash,displayName,color,
        tokenHash,nowSeconds,expiresAt,nowSeconds,
        claim.invitationId,claim.circleId,claim.tokenHash,emailHash,email,
        EMAIL_ACTIVATION_MAX_SENDS,nowSeconds-EMAIL_ACTIVATION_RESEND_SECONDS],
    });
    const row=pending.rows?.[0];
    if(!row){
      await transaction.execute({
        sql:`SELECT id FROM outbox_events WHERE idempotency_key=? LIMIT 1`,
        args:[`auth-activation/v1/${activationId}/1`],
      });
      await transaction.commit(); finished=true;
      return Object.freeze({accepted:false});
    }
    await transaction.execute(activationEvent({
      activationId:String(row.id),email,token,sendCount:Number(row.send_count),
    }));
    await transaction.commit(); finished=true;
    return Object.freeze({accepted:true});
  }catch(error){
    if(!finished){ try{ await transaction.rollback(); }catch{} }
    throw error;
  }
}

export async function resendEmailActivation(db,{claim,email},{nowSeconds=null}={}){
  if(!db||typeof db.transaction!=='function') throw new TypeError('database client is required');
  const parsed=safeClaim(claim);
  const normalizedEmail=normalizeInvitationEmail(email);
  const emailHash=hashInvitationEmail(normalizedEmail);
  if(!parsed||!normalizedEmail||!emailHash||!safeEqual(parsed.emailHash,emailHash)) return {accepted:false};
  const token=createEmailActivationToken();
  const tokenHash=hashEmailActivationToken(token);
  const ring=activationKeyRing();
  const transaction=await db.transaction('write');
  let finished=false;
  try{
    await assertCredentialKeyControl(transaction,ring);
    nowSeconds=await activationNow(transaction,nowSeconds);
    const rotated=await transaction.execute({
      sql:`UPDATE auth_email_activations SET token_hash=?,expires_at=?,last_sent_at=?,send_count=send_count+1
        WHERE invitation_id=? AND circle_id=? AND email_hash=? AND lower(email)=?
          AND used_at IS NULL AND revoked_at IS NULL AND send_count<? AND last_sent_at<=?
          AND EXISTS (
            SELECT 1 FROM circle_invitations invitation JOIN circles circle ON circle.id=invitation.circle_id
            WHERE invitation.id=auth_email_activations.invitation_id
              AND invitation.token_hash=? AND invitation.email_hash=?
              AND invitation.used_at IS NULL AND invitation.used_by IS NULL
              AND invitation.revoked_at IS NULL AND datetime(invitation.expires_at)>datetime('now')
              AND circle.is_primary=1 AND circle.archived_at IS NULL
          ) AND NOT EXISTS (SELECT 1 FROM auth_accounts WHERE lower(email)=?)
        RETURNING id,send_count`,
      args:[tokenHash,nowSeconds+EMAIL_ACTIVATION_TTL_SECONDS,nowSeconds,
        parsed.invitationId,parsed.circleId,emailHash,normalizedEmail,
        EMAIL_ACTIVATION_MAX_SENDS,nowSeconds-EMAIL_ACTIVATION_RESEND_SECONDS,
        parsed.tokenHash,emailHash,normalizedEmail],
    });
    const row=rotated.rows?.[0];
    if(row) await transaction.execute(activationEvent({
      activationId:String(row.id),email:normalizedEmail,token,sendCount:Number(row.send_count),
    }));
    await transaction.commit(); finished=true;
    return Object.freeze({accepted:Boolean(row)});
  }catch(error){
    if(!finished){ try{ await transaction.rollback(); }catch{} }
    throw error;
  }
}

export async function verifyEmailActivation(db,{token},{nowSeconds=null}={}){
  if(!db||typeof db.transaction!=='function') throw new TypeError('database client is required');
  const tokenHash=hashEmailActivationToken(token);
  if(!tokenHash) return {status:'invalid'};
  const transaction=await db.transaction('write');
  let finished=false;
  const finish=async result=>{ await transaction.rollback(); finished=true; return result; };
  try{
    nowSeconds=await activationNow(transaction,nowSeconds);
    const selected=await transaction.execute({
      sql:`SELECT activation.*,invitation.token_hash AS invitation_token_hash,
          invitation.used_at AS invitation_used_at,invitation.used_by AS invitation_used_by,
          invitation.revoked_at AS invitation_revoked_at,invitation.expires_at AS invitation_expires_at,
          circle.is_primary,circle.archived_at
        FROM auth_email_activations activation
        JOIN circle_invitations invitation ON invitation.id=activation.invitation_id
        JOIN circles circle ON circle.id=activation.circle_id
        WHERE activation.token_hash=? LIMIT 2`,args:[tokenHash],
    });
    if(selected.rows?.length!==1) return await finish({status:'invalid'});
    const activation=selected.rows[0];
    if(activation.used_at!==null) return await finish({status:'used'});
    if(activation.revoked_at!==null||activation.invitation_revoked_at!==null
      ||activation.invitation_used_at!==null||activation.invitation_used_by!==null
      ||Number(activation.is_primary)!==1||activation.archived_at!==null){
      return await finish({status:'revoked'});
    }
    if(Number(activation.expires_at)<=nowSeconds
      ||Date.parse(String(activation.invitation_expires_at))<=nowSeconds*1000){
      return await finish({status:'expired'});
    }
    await assertCredentialKeyControl(transaction,activationKeyRing());
    const expectedEmailHash=hashInvitationEmail(String(activation.email));
    if(!expectedEmailHash||!safeEqual(expectedEmailHash,activation.email_hash)) return await finish({status:'invalid'});
    const created=await transaction.execute({
      sql:`INSERT INTO auth_accounts
          (email,password_hash,display_name,color,last_login,is_available,is_admin,google_sub)
        SELECT activation.email,activation.password_hash,activation.display_name,activation.color,
          datetime('now'),1,0,NULL
        FROM auth_email_activations activation
        JOIN circle_invitations invitation ON invitation.id=activation.invitation_id
        JOIN circles circle ON circle.id=activation.circle_id
        WHERE activation.id=? AND activation.token_hash=?
          AND activation.used_at IS NULL AND activation.revoked_at IS NULL
          AND activation.expires_at>? AND invitation.used_at IS NULL AND invitation.used_by IS NULL
          AND invitation.revoked_at IS NULL AND datetime(invitation.expires_at)>datetime('now')
          AND invitation.email_hash=activation.email_hash
          AND circle.is_primary=1 AND circle.archived_at IS NULL
        ON CONFLICT(email) DO NOTHING RETURNING id,email,display_name,color,is_admin`,
      args:[activation.id,tokenHash,nowSeconds],
    });
    if(created.rows?.length!==1) return await finish({status:'revoked'});
    const user=created.rows[0];
    const userId=Number(user.id);
    const acceptedAt=new Date(nowSeconds*1000).toISOString();
    const invitation=await transaction.execute({
      sql:`UPDATE circle_invitations SET used_at=?,used_by=?
        WHERE id=? AND circle_id=? AND token_hash=? AND email_hash=?
          AND used_at IS NULL AND used_by IS NULL AND revoked_at IS NULL
          AND datetime(expires_at)>datetime('now') RETURNING circle_id,used_by`,
      args:[acceptedAt,userId,activation.invitation_id,activation.circle_id,
        activation.invitation_token_hash,activation.email_hash],
    });
    if(invitation.rows?.length!==1||Number(invitation.rows[0].used_by)!==userId){
      return await finish({status:'revoked'});
    }
    const membership=await transaction.execute({
      sql:`INSERT INTO circle_memberships (circle_id,user_id,role,status,invited_by,joined_at,updated_at)
        SELECT invitation.circle_id,?,'member','active',invitation.created_by,?,?
        FROM circle_invitations invitation WHERE invitation.id=? AND invitation.used_by=?
        ON CONFLICT(circle_id,user_id) DO NOTHING RETURNING circle_id,user_id,status`,
      args:[userId,acceptedAt,acceptedAt,activation.invitation_id,userId],
    });
    if(membership.rows?.length!==1||membership.rows[0].status!=='active') return await finish({status:'revoked'});
    const audit=await transaction.execute({
      sql:`INSERT INTO circle_audit_events
          (circle_id,event_type,actor_user_id,subject_user_id,invitation_id,dedupe_key,created_at)
        VALUES (?,'activation.verified',?,?,?,?,?) ON CONFLICT(dedupe_key) DO NOTHING RETURNING id`,
      args:[activation.circle_id,userId,userId,activation.invitation_id,
        `activation-verified:${activation.id}`,acceptedAt],
    });
    if(audit.rows?.length!==1) return await finish({status:'revoked'});
    const consumed=await transaction.execute({
      sql:`UPDATE auth_email_activations SET used_at=?
        WHERE id=? AND token_hash=? AND used_at IS NULL AND revoked_at IS NULL AND expires_at>?
        RETURNING id`,args:[nowSeconds,activation.id,tokenHash,nowSeconds],
    });
    if(consumed.rows?.length!==1) return await finish({status:'revoked'});
    const safeUser={id:userId,email:String(user.email),name:String(user.display_name),
      color:String(user.color),is_admin:!!user.is_admin,isAdmin:!!user.is_admin};
    const sessionToken=await issueSessionInTransaction(transaction,safeUser,{nowSeconds});
    await transaction.commit(); finished=true;
    return {status:'verified',user:safeUser,sessionToken};
  }catch(error){
    if(!finished){ try{ await transaction.rollback(); }catch{} }
    throw error;
  }
}

function activationMetadata(event){
  if(event.eventVersion!==EMAIL_ACTIVATION_EVENT_VERSION){
    throw new OutboxDeliveryError('EVENT_VERSION_UNSUPPORTED',{retryable:event.eventVersion>EMAIL_ACTIVATION_EVENT_VERSION});
  }
  const payload=event.payload;
  if(!payload||Object.keys(payload).sort().join(',')!=='activation_id,recipient_email,token_envelope'){
    throw new OutboxDeliveryError('PAYLOAD_INVALID',{retryable:false});
  }
  const activationId=String(payload.activation_id||'').toLowerCase();
  const email=normalizeInvitationEmail(payload.recipient_email);
  const envelope=typeof payload.token_envelope==='string'&&payload.token_envelope.length<=8192
    ?payload.token_envelope:null;
  if(!UUID_PATTERN.test(activationId)||!email||!envelope){
    throw new OutboxDeliveryError('PAYLOAD_INVALID',{retryable:false});
  }
  const keyMatch=new RegExp(`^auth-activation/v1/${activationId}/([1-9]\\d*)$`).exec(
    String(event.idempotencyKey||''));
  const sendSequence=Number(keyMatch?.[1]);
  if(!Number.isSafeInteger(sendSequence)||sendSequence<1||sendSequence>EMAIL_ACTIVATION_MAX_SENDS){
    throw new OutboxDeliveryError('PAYLOAD_INVALID',{retryable:false});
  }
  return {activationId,email,envelope,sendSequence};
}

function activationCredential(metadata,event){
  try{
    const token=openEmailActivationTokenStrict(metadata.envelope,{idempotencyKey:event.idempotencyKey});
    return {...metadata,token,tokenHash:hashEmailActivationToken(token)};
  }catch(error){
    if(error instanceof CredentialEnvelopeError){
      throw new OutboxDeliveryError(error.code,{retryable:error.retryable});
    }
    throw error;
  }
}

export function createEmailActivationHandler({db,baseUrl,send}={}){
  if(!db||typeof db.execute!=='function'||typeof send!=='function') throw new TypeError('activation email database and provider are required');
  let origin;
  try{ origin=new URL(String(baseUrl)).origin; }catch{ throw new TypeError('valid activation base URL required'); }
  return async(event,{signal}={})=>{
    const metadata=activationMetadata(event);
    const current=await db.execute({
      sql:`SELECT activation.id,activation.token_hash,activation.send_count FROM auth_email_activations activation
        JOIN circle_invitations invitation ON invitation.id=activation.invitation_id
        JOIN circles circle ON circle.id=activation.circle_id
        WHERE activation.id=? AND lower(activation.email)=?
          AND activation.used_at IS NULL AND activation.revoked_at IS NULL
          AND activation.expires_at>CAST(strftime('%s','now') AS INTEGER)
          AND invitation.used_at IS NULL AND invitation.used_by IS NULL AND invitation.revoked_at IS NULL
          AND datetime(invitation.expires_at)>datetime('now')
          AND circle.is_primary=1 AND circle.archived_at IS NULL LIMIT 2`,
      args:[metadata.activationId,metadata.email],
    });
    if(current.rows?.length!==1) return {status:'suppressed',reasonCode:'ACTIVATION_INACTIVE'};
    if(Number(current.rows[0].send_count)!==metadata.sendSequence){
      return {status:'suppressed',reasonCode:'ACTIVATION_INACTIVE'};
    }
    await assertCredentialKeyControl(db,activationKeyRing());
    const payload=activationCredential(metadata,event);
    if(!safeEqual(payload.tokenHash,current.rows[0].token_hash)){
      throw new OutboxDeliveryError('PAYLOAD_INVALID',{retryable:false});
    }
    const verifyUrl=`${origin}/verify#token=${encodeURIComponent(payload.token)}`;
    try{
      const delivery=await send({
        to:payload.email,subject:'Verify your Randori account',
        html:`<h2>Verify your Randori account</h2><p><a href="${verifyUrl}">Verify email and activate account</a></p><p>This single-use link expires in 30 minutes.</p>`,
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

export async function deliverEmailActivations({db,baseUrl,send,workerId,workerOptions={}}={}){
  const handler=createEmailActivationHandler({db,baseUrl,send});
  const result=await runOutboxWorker({
    db,workerId,eventType:EMAIL_ACTIVATION_EVENT_TYPE,
    handlers:{[EMAIL_ACTIVATION_EVENT_TYPE]:handler},...workerOptions,
  });
  const metrics=await readOutboxMetrics(db,{eventType:EMAIL_ACTIVATION_EVENT_TYPE});
  return Object.freeze({...result,metrics});
}

export async function emailActivationStatus(db){
  const counts={pending:0,processing:0,retry:0,delivered:0,suppressed:0,dead_letter:0};
  for(const metric of await readOutboxMetrics(db,{eventType:EMAIL_ACTIVATION_EVENT_TYPE})){
    counts[metric.status]=(counts[metric.status]||0)+metric.count;
  }
  return counts;
}
