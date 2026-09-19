import { createHmac } from 'node:crypto';

import { getJwtSecret } from './_db.js';
import { escapeHtml } from './_pairing.js';
import { hashInvitationEmail, hashInvitationToken, normalizeInvitationEmail } from './_circle-membership.js';
import {
  CredentialEnvelopeError,
  assertPurposeKeyIsolation,
  credentialRotationMetricsFromEnvelopes,
  openCredentialEnvelope,
  parseKeyRing,
  sealCredentialEnvelope,
} from './_key-rotation.js';
import { createOutboxEventStatement, OutboxDeliveryError, readOutboxMetrics, runOutboxWorker } from './_outbox.js';
import { classifyPairingProviderError } from './_pairing-email.js';
import {
  assertCredentialKeyControl,
  credentialKeyControlStatus,
  withCredentialKeyControlStatus,
} from './_credential-key-control.js';

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

export function invitationKeyRing({localRuntime=false,env=process.env}={}){
  try{
    const ring=parseKeyRing({
      env,purpose:'invitation-email',keyEnv:'INVITATION_EMAIL_ENCRYPTION_KEY',
      versionEnv:'INVITATION_EMAIL_ENCRYPTION_KEY_VERSION',
      previousKeysEnv:'INVITATION_EMAIL_ENCRYPTION_PREVIOUS_KEYS',
      writeVersionEnv:'INVITATION_EMAIL_ENVELOPE_WRITE_VERSION',
      fallbackKey:()=>{
        if(!localRuntime||env.NODE_ENV!=='development') return null;
        return createHmac('sha256',getJwtSecret())
          .update('randori-invitation-email-envelope-v1','utf8').digest();
      },
    });
    assertPurposeKeyIsolation({env,rings:[ring]});
    return ring;
  }catch(error){
    error.message='INVITATION_EMAIL_ENCRYPTION_KEY ring is invalid';
    throw error;
  }
}

export function invitationEmailConfiguration({localRuntime=false}={}){
  if(process.env.CIRCLE_MEMBERSHIP_ENABLED!=='true') return null;
  if(!localRuntime&&process.env.INVITATION_EMAIL_DELIVERY_ENABLED!=='true') return null;
  if(!localRuntime&&(!String(process.env.RESEND_API_KEY||'').trim()
    ||!String(process.env.RESEND_FROM||'').trim())) return null;
  const origin=configuredOrigin({localRuntime});
  if(!origin) return null;
  try{
    invitationKeyRing({localRuntime});
    return Object.freeze({origin,localRuntime});
  }catch{ return null; }
}

function envelopeAad(invitationId){
  const id=String(invitationId||'').toLowerCase();
  if(!UUID_PATTERN.test(id)) throw new TypeError('valid invitation identifier required');
  return Buffer.from(`randori-invitation-email-envelope-v1\0${id}`,'utf8');
}

export function sealInvitationEmailCredential({invitationId,email,token,idempotencyKey,localRuntime=false}={}){
  const id=String(invitationId||'').toLowerCase();
  const recipient=normalizeInvitationEmail(email);
  if(!UUID_PATTERN.test(id)||!recipient||!hashInvitationToken(token)){
    throw new TypeError('valid invitation email credential required');
  }
  const plaintext=Buffer.from(JSON.stringify({v:1,email:recipient,token}),'utf8');
  return sealCredentialEnvelope({plaintext,idempotencyKey,ring:invitationKeyRing({localRuntime}),
    legacyAad:()=>envelopeAad(id)});
}

function openInvitationEmailCredentialStrict({invitationId,envelope,idempotencyKey,localRuntime=false}={}){
  const id=String(invitationId||'').toLowerCase();
  if(!UUID_PATTERN.test(id)) throw new CredentialEnvelopeError('ENVELOPE_INVALID');
  const opened=openCredentialEnvelope({envelope,idempotencyKey,ring:invitationKeyRing({localRuntime}),
    legacyAad:()=>envelopeAad(id),minPlaintextBytes:1,maxPlaintextBytes:1024});
  try{
    const value=JSON.parse(opened.plaintext.toString('utf8'));
    if(!value||typeof value!=='object'||Array.isArray(value)
      ||Object.keys(value).sort().join(',')!=='email,token,v'||value.v!==1){
      throw new CredentialEnvelopeError('ENVELOPE_INVALID');
    }
    const email=normalizeInvitationEmail(value.email);
    const token=typeof value.token==='string'&&TOKEN_PATTERN.test(value.token)?value.token:null;
    if(!email||!token) throw new CredentialEnvelopeError('ENVELOPE_INVALID');
    return Object.freeze({email,token});
  }catch(error){
    if(error instanceof CredentialEnvelopeError) throw error;
    throw new CredentialEnvelopeError('ENVELOPE_INVALID');
  }
}

export function openInvitationEmailCredential(input={}){
  try{ return openInvitationEmailCredentialStrict(input); }
  catch{ return null; }
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
  const idempotencyKey=`invitation-email/v1/${id}/${sequence}`;
  return createOutboxEventStatement({
    eventType:INVITATION_EMAIL_EVENT_TYPE,eventVersion:INVITATION_EMAIL_EVENT_VERSION,
    idempotencyKey,
    payload:{invitation_id:id,circle_id:circle,actor_user_id:actor,token_hash:tokenHash,email_hash:emailHash,
      send_sequence:sequence,template_version:INVITATION_EMAIL_TEMPLATE_VERSION,
      credential_envelope:sealInvitationEmailCredential({invitationId:id,email:recipient,token,
        idempotencyKey,localRuntime})},
    maxAttempts:5,deliveryTimeoutMs:10_000,
  });
}

function invitationEmailMetadata(event){
  if(event.eventVersion!==INVITATION_EMAIL_EVENT_VERSION){
    throw new OutboxDeliveryError('EVENT_VERSION_UNSUPPORTED',{
      retryable:event.eventVersion>INVITATION_EMAIL_EVENT_VERSION});
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
  const envelope=typeof payload.credential_envelope==='string'&&payload.credential_envelope.length<=8192
    ?payload.credential_envelope:null;
  if(!UUID_PATTERN.test(invitationId)||!Number.isSafeInteger(circleId)||circleId<1
    ||!Number.isSafeInteger(actorUserId)||actorUserId<1
    ||!HASH_PATTERN.test(tokenHash)||!HASH_PATTERN.test(emailHash)
    ||!Number.isSafeInteger(sendSequence)||sendSequence<1||sendSequence>INVITATION_EMAIL_MAX_SENDS
    ||templateVersion!==INVITATION_EMAIL_TEMPLATE_VERSION||!envelope){
    throw new OutboxDeliveryError('PAYLOAD_INVALID',{retryable:false});
  }
  return Object.freeze({invitationId,circleId,actorUserId,tokenHash,emailHash,sendSequence,envelope});
}

export function invitationEmailPayload(event,{localRuntime=false}={}){
  const metadata=invitationEmailMetadata(event);
  let credential;
  try{
    credential=openInvitationEmailCredentialStrict({invitationId:metadata.invitationId,
      envelope:metadata.envelope,idempotencyKey:event.idempotencyKey,localRuntime});
  }catch(error){
    if(error instanceof CredentialEnvelopeError){
      throw new OutboxDeliveryError(error.code,{retryable:error.retryable});
    }
    throw error;
  }
  if(hashInvitationToken(credential.token)!==metadata.tokenHash
    ||hashInvitationEmail(credential.email)!==metadata.emailHash){
    throw new OutboxDeliveryError('PAYLOAD_INVALID',{retryable:false});
  }
  return Object.freeze({...metadata,email:credential.email,token:credential.token});
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
      AND circle.archived_at IS NULL
      AND NOT EXISTS (
        SELECT 1 FROM auth_accounts recipient
        JOIN circle_memberships recipient_membership
          ON recipient_membership.user_id=recipient.id
          AND recipient_membership.circle_id=invitation.circle_id
        WHERE lower(recipient.email)=?
      )
    LIMIT 2`;
}

function invitationPreflightSql(){
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
      AND circle.archived_at IS NULL LIMIT 2`;
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
    const metadata=invitationEmailMetadata(event);
    const preflight=await db.execute({sql:invitationPreflightSql(),args:[metadata.actorUserId,
      metadata.invitationId,metadata.circleId,metadata.tokenHash,metadata.emailHash]});
    if(preflight.rows?.length!==1){
      return {status:'suppressed',reasonCode:'INVITATION_INACTIVE'};
    }
    await assertCredentialKeyControl(db,invitationKeyRing({localRuntime}));
    const payload=invitationEmailPayload(event,{localRuntime});
    const current=await db.execute({sql:activeInvitationSql(),args:[payload.actorUserId,
      payload.invitationId,payload.circleId,payload.tokenHash,payload.emailHash,payload.email]});
    if(current.rows?.length!==1) return {status:'suppressed',reasonCode:'INVITATION_INACTIVE'};
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

export async function invitationEmailEnvelopeRotationMetrics(db,{localRuntime=false,ring=null}={}){
  if(!db||typeof db.execute!=='function') throw new TypeError('database client is required');
  // Actionable events and resend-retained terminal events must come from one
  // statement snapshot. Separate reads could miss a live invitation whose
  // latest event moves from pending to delivered between those reads.
  const result=await db.execute({
    sql:`WITH invitation_events AS (
        SELECT event.id,event.status,
          json_extract(event.payload_json,'$.invitation_id') AS invitation_id,
          json_extract(event.payload_json,'$.credential_envelope') AS envelope
        FROM outbox_events event WHERE event.event_type=?
      ), invitation_summaries AS (
        SELECT invitation_id,COUNT(*) AS event_count,MAX(id) AS latest_event_id
        FROM invitation_events GROUP BY invitation_id
      )
      SELECT event.id,event.status,event.envelope,0 AS retained
      FROM invitation_events event
      WHERE event.status IN ('pending','processing','retry','dead_letter')
      UNION ALL
      SELECT latest.id,latest.status,latest.envelope,1 AS retained
      FROM invitation_summaries summary
      JOIN invitation_events latest ON latest.id=summary.latest_event_id
      JOIN circle_invitations invitation ON invitation.id=summary.invitation_id
      JOIN circles circle ON circle.id=invitation.circle_id
      WHERE summary.event_count<? AND latest.status IN ('delivered','suppressed')
        AND invitation.used_at IS NULL AND invitation.used_by IS NULL
        AND invitation.revoked_at IS NULL AND datetime(invitation.expires_at)>datetime('now')
        AND circle.archived_at IS NULL
        AND EXISTS (
          SELECT 1 FROM circle_memberships owner_membership
          JOIN auth_accounts owner ON owner.id=owner_membership.user_id
            AND COALESCE(owner.is_demo,0)=0
          WHERE owner_membership.circle_id=invitation.circle_id
            AND owner_membership.role='owner' AND owner_membership.status='active')
      ORDER BY id LIMIT 10001`,
    args:[INVITATION_EMAIL_EVENT_TYPE,INVITATION_EMAIL_MAX_SENDS],
  });
  const rows=result.rows||[];
  if(rows.length>10000) throw new Error('invitation rotation metric limit exceeded');
  const actionableEnvelopes=[];
  const retainedEnvelopes=[];
  for(const row of rows){
    (Number(row.retained)===1?retainedEnvelopes:actionableEnvelopes).push(row.envelope);
  }
  const configuredRing=ring||invitationKeyRing({localRuntime});
  return credentialRotationMetricsFromEnvelopes({ring:configuredRing,actionableEnvelopes,retainedEnvelopes});
}

export async function invitationEmailKeyRotationStatus(db,{localRuntime=false}={}){
  const ring=invitationKeyRing({localRuntime});
  const metrics=await invitationEmailEnvelopeRotationMetrics(db,{localRuntime,ring});
  return withCredentialKeyControlStatus(metrics,await credentialKeyControlStatus(db,ring));
}

export async function ensureInvitationEmailReadiness(db,{localRuntime=false}={}){
  if(!db||typeof db.execute!=='function') throw new TypeError('database client is required');
  const ring=invitationKeyRing({localRuntime});
  await db.execute(`SELECT id,event_type,event_version,idempotency_key FROM outbox_events LIMIT 0`);
  await assertCredentialKeyControl(db,ring);
  return true;
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
