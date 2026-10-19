import {
  captureSentryException,
  getClient,
  verifyMutationOrigin,
  verifyRequestAuth,
} from './_db.js';
import {
  ensureCircleMembershipReadiness,
  getActivePrimaryCircleMembership,
  hashInvitationEmail,
} from './_circle-membership.js';
import { localIdentityAdapterEnabled } from './_local-runtime.js';
import { ensureInvitationEmailReadiness, invitationEmailConfiguration } from './_invitation-email.js';
import { CredentialKeyControlError } from './_credential-key-control.js';
import { deliverCommittedOutboxEvents, outboxEventsFromStatements } from './_outbox-immediate.js';
import {
  INVITE_REQUEST_ACCEPTED_MESSAGE,
  INVITE_REQUEST_LIST_DEFAULT_LIMIT,
  INVITE_REQUEST_LIST_MAX_LIMIT,
  INVITE_REQUEST_RESPONSE_FLOOR_MS,
  consumeInviteRequestRateLimits,
  decideInviteRequest,
  decodeInviteRequestCursor,
  listPendingInviteRequests,
  submitInviteRequest,
  validateInviteRequestInput,
} from './_invite-requests.js';
import { ensureInviteRequestReadiness, inviteRequestsEnabled } from './_invite-request-config.js';
import { inviteRequestNotificationConfiguration } from './_invite-request-notification.js';

// HTTP contract for invite requests, routed through api/invitations.js:
//   POST /api/invite-requests            public submission (always 202 when accepted)
//   GET  /api/invite-requests            primary-circle owner review list
//   POST /api/invite-requests/decision   primary-circle owner approve/decline
export const INVITE_REQUEST_ENDPOINTS=new Set(['invite-requests','invite-request-decision']);

const UUID_PATTERN=/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function queryKeys(req){
  const keys=new Map();
  if(req?.query&&typeof req.query==='object'){
    for(const [key,value] of Object.entries(req.query)){
      if(Array.isArray(value)) return null;
      keys.set(key,String(value));
    }
  }
  try{
    const params=new URL(req?.url||'/','https://randori.invalid').searchParams;
    for(const key of params.keys()){
      if(params.getAll(key).length!==1) return null;
      if(!keys.has(key)) keys.set(key,params.get(key));
    }
  }catch{ return null; }
  return keys;
}

function onlyQueryKeys(req,allowed){
  const keys=queryKeys(req);
  return keys&&[...keys.keys()].every(key=>allowed.has(key))?keys:null;
}

// The public form has no session, so the Origin header is mandatory and must
// match the serving host (same rule as the public invitation prepare step).
function isSameOrigin(req){
  const origin=String(req?.headers?.origin||req?.headers?.Origin||'').trim();
  const host=String(req?.headers?.['x-forwarded-host']||req?.headers?.host||'').split(',')[0].trim();
  if(!origin||!host) return false;
  try{ return new URL(origin).host===host; }catch{ return false; }
}

function clientAddress(req){
  return String(req?.headers?.['x-forwarded-for']||req?.socket?.remoteAddress||'unknown')
    .split(',')[0].trim().slice(0,128)||'unknown';
}

async function completeResponseFloor(startedAt){
  const remaining=INVITE_REQUEST_RESPONSE_FLOOR_MS-(Date.now()-startedAt);
  if(remaining>0) await new Promise(resolve=>setTimeout(resolve,remaining));
}

function exactObject(value,keys){
  return !!value&&typeof value==='object'&&!Array.isArray(value)
    &&Object.keys(value).length===keys.length
    &&keys.every(key=>Object.prototype.hasOwnProperty.call(value,key));
}

async function handleSubmit(req,res){
  if(!isSameOrigin(req)) return res.status(403).json({error:'cross-origin request rejected'});
  const startedAt=Date.now();
  const input=validateInviteRequestInput(req.body);
  if(input.honeypot){
    await completeResponseFloor(startedAt);
    return res.status(202).json({ok:true,message:INVITE_REQUEST_ACCEPTED_MESSAGE});
  }
  if(!input.ok) return res.status(400).json({error:'invalid invite request',fields:input.fields});
  let failure=null;
  let rate=null;
  let submitted=null;
  try{
    const db=getClient();
    await ensureInviteRequestReadiness(db);
    rate=await consumeInviteRequestRateLimits(db,{
      ip:clientAddress(req),emailHash:hashInvitationEmail(input.value.email),
    });
    if(rate.allowed){
      submitted=await submitInviteRequest(db,input.value,{
        notification:inviteRequestNotificationConfiguration({localRuntime:localIdentityAdapterEnabled(req)}),
      });
    }
  }catch(error){ failure=error; }
  // Every accepted path (stored, member, invited, duplicate, declined) waits
  // for the same floor and returns the same body before anything else runs.
  await completeResponseFloor(startedAt);
  if(failure){
    captureSentryException(failure,{tags:{event:'invite_request_submit_fail',source:'server'}});
    return res.status(503).json({error:'invite requests unavailable'});
  }
  if(!rate.allowed){
    res.setHeader('Retry-After',String(rate.retryAfter));
    return res.status(429).json({error:'too many requests; try again later',retry_after_seconds:rate.retryAfter});
  }
  res.status(202).json({ok:true,message:INVITE_REQUEST_ACCEPTED_MESSAGE});
  deliverCommittedOutboxEvents(req,submitted?.outboxEvents);
}

async function primaryOwnerContext(req,res){
  const payload=await verifyRequestAuth(req);
  const userId=Number(payload?.id??payload?.uid);
  if(!Number.isSafeInteger(userId)||userId<1){
    res.status(401).json({error:'authentication required'});
    return null;
  }
  try{
    const db=getClient();
    await ensureCircleMembershipReadiness(db);
    await ensureInviteRequestReadiness(db);
    const membership=await getActivePrimaryCircleMembership(db,userId);
    if(!membership||membership.role!=='owner'){
      res.status(403).json({error:'primary circle owner required'});
      return null;
    }
    return {db,userId,circleId:Number(membership.circle_id)};
  }catch(error){
    captureSentryException(error,{tags:{event:'invite_request_owner_check_fail',source:'server'}});
    res.status(503).json({error:'invite requests unavailable'});
    return null;
  }
}

async function handleList(req,res,query){
  const status=query.get('status');
  if(status!==undefined&&status!=='pending') return res.status(400).json({error:'only status=pending is supported'});
  const rawLimit=query.get('limit');
  const limit=rawLimit===undefined?INVITE_REQUEST_LIST_DEFAULT_LIMIT:Number(rawLimit);
  if(!/^\d{1,3}$/.test(rawLimit??'50')||!Number.isSafeInteger(limit)||limit<1||limit>INVITE_REQUEST_LIST_MAX_LIMIT){
    return res.status(400).json({error:`limit must be 1-${INVITE_REQUEST_LIST_MAX_LIMIT}`});
  }
  const cursor=decodeInviteRequestCursor(query.get('cursor'));
  if(cursor===false) return res.status(400).json({error:'invalid cursor'});
  const context=await primaryOwnerContext(req,res);
  if(!context) return;
  try{
    const page=await listPendingInviteRequests(context.db,{circleId:context.circleId,limit,cursor});
    return res.json({ok:true,status:'pending',requests:page.requests,pending_count:page.pendingCount,
      next_cursor:page.nextCursor});
  }catch(error){
    captureSentryException(error,{tags:{event:'invite_request_list_fail',source:'server'}});
    return res.status(503).json({error:'invite requests unavailable'});
  }
}

async function approvalEmailConfiguration(db,localRuntime){
  const configuration=invitationEmailConfiguration({localRuntime});
  if(!configuration) return null;
  try{
    await ensureInvitationEmailReadiness(db,{localRuntime});
    return configuration;
  }catch(error){
    // Same policy as owner-created invitations: an unadopted key control keeps
    // manual copy-link invitations working instead of failing the approval.
    if(error instanceof CredentialKeyControlError) return null;
    throw error;
  }
}

async function handleDecision(req,res){
  const body=req.body;
  if(!exactObject(body,['id','decision','expected_status'])
    ||typeof body.id!=='string'||!UUID_PATTERN.test(body.id)
    ||!['approve','decline'].includes(body.decision)||body.expected_status!=='pending'){
    return res.status(400).json({error:'id, decision (approve|decline), and expected_status "pending" are required'});
  }
  const context=await primaryOwnerContext(req,res);
  if(!context) return;
  const localRuntime=localIdentityAdapterEnabled(req);
  let result;
  try{
    const emailConfiguration=body.decision==='approve'
      ?await approvalEmailConfiguration(context.db,localRuntime):null;
    result=await decideInviteRequest(context.db,{
      requestId:body.id,decision:body.decision,ownerUserId:context.userId,emailConfiguration,localRuntime,
    });
  }catch(error){
    captureSentryException(error,{tags:{event:'invite_request_decision_fail',source:'server'}});
    return res.status(503).json({error:'invite requests unavailable'});
  }
  if(result.status==='not_found') return res.status(404).json({error:'invite request not found'});
  if(result.status==='conflict'){
    return res.status(409).json({error:'invite request is no longer pending',code:'invite_request_not_pending',
      status:result.currentStatus});
  }
  if(result.replayed){
    return res.json({ok:true,replayed:true,request:result.request,
      ...(result.invitation?{invitation:result.invitation}:{})});
  }
  if(result.status==='declined') return res.json({ok:true,request:result.request});
  res.json({
    ok:true,request:result.request,
    invitation:{id:result.invitation.id,email:result.invitation.email,expires_at:result.invitation.expiresAt,
      status:'pending',invite_url:`/invite#invite=${result.invitation.token}`},
    email_delivery:{queued:result.emailQueued},
  });
  if(result.emailStatement) deliverCommittedOutboxEvents(req,outboxEventsFromStatements([result.emailStatement]));
}

export async function handleInviteRequestRoute(req,res,endpoint){
  if(!inviteRequestsEnabled()) return res.status(404).json({error:'not found'});
  if(endpoint==='invite-request-decision'){
    if(req.method!=='POST'){
      res.setHeader('Allow','POST');
      return res.status(405).json({error:'POST only'});
    }
    if(!onlyQueryKeys(req,new Set(['endpoint']))) return res.status(400).json({error:'invalid request'});
    if(!verifyMutationOrigin(req)) return res.status(403).json({error:'cross-origin mutation rejected'});
    return handleDecision(req,res);
  }
  if(req.method==='POST'){
    if(!onlyQueryKeys(req,new Set(['endpoint']))) return res.status(400).json({error:'invalid request'});
    return handleSubmit(req,res);
  }
  if(req.method==='GET'){
    const query=onlyQueryKeys(req,new Set(['endpoint','status','limit','cursor']));
    if(!query) return res.status(400).json({error:'invalid request'});
    return handleList(req,res,query);
  }
  res.setHeader('Allow','GET, POST');
  return res.status(405).json({error:'GET or POST only'});
}
