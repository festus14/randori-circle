import { createCipheriv, createDecipheriv, createHmac, randomBytes } from 'node:crypto';

import { getJwtSecret } from './_db.js';
import { escapeHtml } from './_pairing.js';
import { hashInvitationEmail, hashInvitationToken, normalizeInvitationEmail } from './_circle-membership.js';
import { createOutboxEventStatement, OutboxDeliveryError, readOutboxMetrics, runOutboxWorker } from './_outbox.js';
import { classifyPairingProviderError } from './_pairing-email.js';

export const INVITATION_EMAIL_EVENT_TYPE='invitation.email.requested';
export const INVITATION_EMAIL_EVENT_VERSION=1;
export const INVITATION_EMAIL_TEMPLATE_VERSION=1;
export const INVITATION_EMAIL_RESEND_SECONDS=60;
export const INVITATION_EMAIL_MAX_SENDS=5;
export const INVITATION_EMAIL_DRAIN_BATCH_SIZE=3;

const UUID_PATTERN=/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const HASH_PATTERN=/^[a-f0-9]{64}$/;
const TOKEN_PATTERN=/^[A-Za-z0-9_-]{43}$/;

function configuredOrigin({localRuntime=false}={}){
  let url;
  try{ url=new URL(String(process.env.APP_URL||'')); }catch{ return null; }
  const loopback=['localhost','127.0.0.1','[::1]'].includes(url.hostname.toLowerCase());
  if(url.username||url.password||url.search||url.hash||(url.pathname&&url.pathname!=='/')) return null;
  if(localRuntime){
    if(process.env.NODE_ENV!=='development'||url.protocol!=='http:'||!loopback) return null;
  }else if(process.env.NODE_ENV!=='production'||url.protocol!=='https:'||loopback){
    return null;
  }
  return url.origin;
}

function encryptionKey({localRuntime=false}={}){
  const encoded=String(process.env.INVITATION_EMAIL_ENCRYPTION_KEY||'').trim();
  if(/^[A-Za-z0-9_-]{43}$/.test(encoded)){
    const key=Buffer.from(encoded,'base64url');
    if(key.length===32) return key;
  }
  if(localRuntime&&process.env.NODE_ENV==='development'){
    return createHmac('sha256',getJwtSecret())
      .update('randori-invitation-email-envelope-v1','utf8').digest();
  }
  throw new Error('INVITATION_EMAIL_ENCRYPTION_KEY must be a base64url-encoded 32-byte key');
}

export function invitationEmailConfiguration({localRuntime=false}={}){
  if(process.env.CIRCLE_MEMBERSHIP_ENABLED!=='true') return null;
  if(!localRuntime&&(!String(process.env.RESEND_API_KEY||'').trim()
    ||!String(process.env.RESEND_FROM||'').trim())) return null;
  const origin=configuredOrigin({localRuntime});
  if(!origin) return null;
  try{ encryptionKey({localRuntime}); }catch{ return null; }
  return Object.freeze({origin,localRuntime});
}

function envelopeAad(invitationId){
  const id=String(invitationId||'').toLowerCase();
  if(!UUID_PATTERN.test(id)) throw new TypeError('valid invitation identifier required');
  return Buffer.from(`randori-invitation-email-envelope-v1\0${id}`,'utf8');
}

export function sealInvitationEmailCredential({invitationId,email,token,localRuntime=false}={}){
  const id=String(invitationId||'').toLowerCase();
  const recipient=normalizeInvitationEmail(email);
  if(!UUID_PATTERN.test(id)||!recipient||!hashInvitationToken(token)){
    throw new TypeError('valid invitation email credential required');
  }
  const iv=randomBytes(12);
  const cipher=createCipheriv('aes-256-gcm',encryptionKey({localRuntime}),iv);
  cipher.setAAD(envelopeAad(id));
  const plaintext=Buffer.from(JSON.stringify({v:1,email:recipient,token}),'utf8');
  const ciphertext=Buffer.concat([cipher.update(plaintext),cipher.final()]);
  const tag=cipher.getAuthTag();
  return `${iv.toString('base64url')}.${ciphertext.toString('base64url')}.${tag.toString('base64url')}`;
}

export function openInvitationEmailCredential({invitationId,envelope,localRuntime=false}={}){
  const id=String(invitationId||'').toLowerCase();
  const parts=typeof envelope==='string'?envelope.split('.'):[];
  if(!UUID_PATTERN.test(id)||parts.length!==3) return null;
  try{
    const [iv,ciphertext,tag]=parts.map(value=>Buffer.from(value,'base64url'));
    if([iv,ciphertext,tag].some((value,index)=>value.toString('base64url')!==parts[index])
      ||iv.length!==12||tag.length!==16||ciphertext.length<1||ciphertext.length>1024) return null;
    const decipher=createDecipheriv('aes-256-gcm',encryptionKey({localRuntime}),iv);
    decipher.setAAD(envelopeAad(id));
    decipher.setAuthTag(tag);
    const value=JSON.parse(Buffer.concat([decipher.update(ciphertext),decipher.final()]).toString('utf8'));
    if(!value||typeof value!=='object'||Array.isArray(value)
      ||Object.keys(value).sort().join(',')!=='email,token,v'||value.v!==1) return null;
    const email=normalizeInvitationEmail(value.email);
    const token=typeof value.token==='string'&&TOKEN_PATTERN.test(value.token)?value.token:null;
    return email&&token?Object.freeze({email,token}):null;
  }catch{ return null; }
}

export function createInvitationEmailEvent({invitationId,circleId,actorUserId,email,token,sendSequence,
  localRuntime=false}={}){
  const id=String(invitationId||'').toLowerCase();
  const circle=Number(circleId);
  const actor=Number(actorUserId);
  const sequence=Number(sendSequence);
  const recipient=normalizeInvitationEmail(email);
  const tokenHash=hashInvitationToken(token);
  const emailHash=hashInvitationEmail(recipient);
  if(!UUID_PATTERN.test(id)||!Number.isSafeInteger(circle)||circle<1
    ||!Number.isSafeInteger(actor)||actor<1||!recipient||!tokenHash
    ||!emailHash||!Number.isSafeInteger(sequence)||sequence<1||sequence>INVITATION_EMAIL_MAX_SENDS){
    throw new TypeError('valid invitation email event required');
  }
  return createOutboxEventStatement({
    eventType:INVITATION_EMAIL_EVENT_TYPE,eventVersion:INVITATION_EMAIL_EVENT_VERSION,
    idempotencyKey:`invitation-email/v1/${id}/${sequence}`,
    payload:{invitation_id:id,circle_id:circle,actor_user_id:actor,token_hash:tokenHash,email_hash:emailHash,
      send_sequence:sequence,template_version:INVITATION_EMAIL_TEMPLATE_VERSION,
      credential_envelope:sealInvitationEmailCredential({invitationId:id,email:recipient,token,localRuntime})},
    maxAttempts:5,deliveryTimeoutMs:10_000,
  });
}

export function invitationEmailPayload(event,{localRuntime=false}={}){
  if(event.eventVersion!==INVITATION_EMAIL_EVENT_VERSION){
    throw new OutboxDeliveryError('EVENT_VERSION_UNSUPPORTED',{retryable:false});
  }
  const payload=event.payload;
  const expected=['actor_user_id','circle_id','credential_envelope','email_hash','invitation_id','send_sequence',
    'template_version','token_hash'];
  if(!payload||typeof payload!=='object'||Array.isArray(payload)
    ||Object.keys(payload).sort().join(',')!==expected.join(',')){
    throw new OutboxDeliveryError('PAYLOAD_INVALID',{retryable:false});
  }
  const invitationId=String(payload.invitation_id||'').toLowerCase();
  const circleId=Number(payload.circle_id);
  const actorUserId=Number(payload.actor_user_id);
  const tokenHash=String(payload.token_hash||'');
  const emailHash=String(payload.email_hash||'');
  const sendSequence=Number(payload.send_sequence);
  const templateVersion=Number(payload.template_version);
  const credential=openInvitationEmailCredential({
    invitationId,envelope:payload.credential_envelope,localRuntime,
  });
  if(!UUID_PATTERN.test(invitationId)||!Number.isSafeInteger(circleId)||circleId<1
    ||!Number.isSafeInteger(actorUserId)||actorUserId<1
    ||!HASH_PATTERN.test(tokenHash)||!HASH_PATTERN.test(emailHash)
    ||!Number.isSafeInteger(sendSequence)||sendSequence<1||sendSequence>INVITATION_EMAIL_MAX_SENDS
    ||templateVersion!==INVITATION_EMAIL_TEMPLATE_VERSION||!credential
    ||hashInvitationToken(credential.token)!==tokenHash
    ||hashInvitationEmail(credential.email)!==emailHash){
    throw new OutboxDeliveryError('PAYLOAD_INVALID',{retryable:false});
  }
  return Object.freeze({invitationId,circleId,actorUserId,tokenHash,emailHash,sendSequence,
    email:credential.email,token:credential.token});
}

function activeInvitationSql(){
  return `SELECT invitation.id,circle.name AS circle_name
    FROM circle_invitations invitation
    JOIN circles circle ON circle.id=invitation.circle_id
    JOIN auth_accounts owner ON owner.id=? AND COALESCE(owner.is_demo,0)=0
    JOIN circle_memberships owner_membership
      ON owner_membership.circle_id=invitation.circle_id
      AND owner_membership.user_id=owner.id
      AND owner_membership.role='owner' AND owner_membership.status='active'
    WHERE invitation.id=? AND invitation.circle_id=?
      AND invitation.token_hash=? AND invitation.email_hash=?
      AND invitation.used_at IS NULL AND invitation.used_by IS NULL
      AND invitation.revoked_at IS NULL AND datetime(invitation.expires_at)>datetime('now')
      AND circle.is_primary=1 AND circle.archived_at IS NULL
      AND NOT EXISTS (
        SELECT 1 FROM auth_accounts recipient
        JOIN circle_memberships recipient_membership
          ON recipient_membership.user_id=recipient.id
          AND recipient_membership.circle_id=invitation.circle_id
        WHERE lower(recipient.email)=?
      )
    LIMIT 2`;
}

export function createInvitationEmailHandler({db,baseUrl,send,localRuntime=false}={}){
  if(!db||typeof db.execute!=='function'||typeof send!=='function'){
    throw new TypeError('invitation email database and provider are required');
  }
  if(typeof localRuntime!=='boolean') throw new TypeError('invalid invitation email runtime');
  let parsedBaseUrl;
  try{ parsedBaseUrl=new URL(String(baseUrl)); }
  catch{ throw new TypeError('valid invitation email base URL required'); }
  const loopback=['localhost','127.0.0.1','[::1]'].includes(parsedBaseUrl.hostname.toLowerCase());
  if(parsedBaseUrl.username||parsedBaseUrl.password||parsedBaseUrl.search||parsedBaseUrl.hash
    ||(parsedBaseUrl.pathname&&parsedBaseUrl.pathname!=='/')
    ||(localRuntime
      ? parsedBaseUrl.protocol!=='http:'||!loopback
      : parsedBaseUrl.protocol!=='https:'||loopback)){
    throw new TypeError('valid invitation email base URL required');
  }
  const origin=parsedBaseUrl.origin;
  return async(event,{signal}={})=>{
    const payload=invitationEmailPayload(event,{localRuntime});
    const current=await db.execute({sql:activeInvitationSql(),args:[payload.actorUserId,
      payload.invitationId,payload.circleId,
      payload.tokenHash,payload.emailHash,payload.email]});
    if(current.rows?.length!==1){
      return {status:'suppressed',reasonCode:'INVITATION_INACTIVE'};
    }
    const subjectCircle=String(current.rows[0].circle_name||'Randori Circle')
      .replace(/[\u0000-\u001f\u007f]+/gu,' ').trim().slice(0,100)||'Randori Circle';
    const circleName=escapeHtml(subjectCircle);
    const inviteUrl=`${origin}/invite#invite=${encodeURIComponent(payload.token)}`;
    try{
      const delivery=await send({
        to:payload.email,subject:`You are invited to ${subjectCircle}`,
        html:`<h2>Join ${circleName}</h2><p>You have been invited to practise together on Randori.</p><p><a href="${escapeHtml(inviteUrl)}">Accept your invitation</a></p><p>This single-use link expires with the invitation and stops working if it is revoked or resent.</p>`,
        idempotencyKey:event.idempotencyKey,signal,
      });
      if(delivery?.error) throw delivery.error;
      return {status:'delivered',providerName:String(delivery?.providerName||'email').slice(0,100),
        providerMessageId:delivery?.providerMessageId||delivery?.data?.id||null};
    }catch(error){ throw classifyPairingProviderError(error); }
  };
}

function countStatuses(metrics){
  const counts={pending:0,processing:0,retry:0,delivered:0,suppressed:0,dead_letter:0};
  for(const metric of metrics) counts[metric.status]=(counts[metric.status]||0)+metric.count;
  return counts;
}

export async function invitationEmailStatus(db){
  return countStatuses(await readOutboxMetrics(db,{eventType:INVITATION_EMAIL_EVENT_TYPE}));
}

export async function deliverInvitationEmails({db,baseUrl,send,workerId,localRuntime=false,workerOptions={}}={}){
  const handler=createInvitationEmailHandler({db,baseUrl,send,localRuntime});
  const result=await runOutboxWorker({
    db,workerId,eventType:INVITATION_EMAIL_EVENT_TYPE,
    handlers:{[INVITATION_EMAIL_EVENT_TYPE]:handler},...workerOptions,
  });
  const status=await invitationEmailStatus(db);
  return Object.freeze({...result,status});
}
