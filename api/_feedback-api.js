import {
  captureSentryException,
  getAdminEmails,
  getClient,
  verifyRequestAuth,
} from './_db.js';
import { ensureCircleMembershipReadiness } from './_circle-membership.js';
import { resolveActiveCircleContext } from './_active-circle.js';
import { schemaFeatureAvailable } from './_schema-capability.js';
import { clientAddress } from './_client-address.js';
import { deliverCommittedOutboxEvents } from './_outbox-immediate.js';
import {
  FEEDBACK_LIST_DEFAULT_LIMIT,
  FEEDBACK_LIST_MAX_LIMIT,
  FEEDBACK_MIGRATION_VERSION,
  decodeFeedbackCursor,
  ensureFeedbackReadiness,
  feedbackEnabled,
  validateFeedbackInput,
} from './_feedback-config.js';
import {
  FeedbackConflictError,
  FeedbackInputError,
  consumeFeedbackRateLimits,
  listMyFeedback,
  lookupFeedbackReplay,
  submitFeedback,
} from './_feedback.js';

// HTTP contract for product feedback (#353), routed through api/data.js:
//   POST /api/feedback       signed-in member submission (active circle)
//   GET  /api/feedback/mine  the member's own submissions and their status
// With FEEDBACK_ENABLED off (or the v22 schema not yet applied) both answer
// 404 {"error":"not found"}, exactly as if the endpoints did not exist, and
// no capability is advertised anywhere.
export const FEEDBACK_ENDPOINTS=new Set(['feedback','feedback-mine']);

function pathname(req){
  try{ return new URL(req?.url||'/','http://localhost').pathname.toLowerCase(); }
  catch{ return String(req?.url||'').split('?')[0].toLowerCase(); }
}

function queryEntries(req){
  const entries=new Map();
  if(req?.query&&typeof req.query==='object'){
    for(const [key,value] of Object.entries(req.query)){
      if(Array.isArray(value)) return null;
      entries.set(key,String(value));
    }
  }
  try{
    const params=new URL(req?.url||'/','http://localhost').searchParams;
    for(const key of new Set(params.keys())){
      const values=params.getAll(key);
      if(values.length!==1) return null;
      if(!entries.has(key)) entries.set(key,values[0]);
    }
  }catch{ return null; }
  return entries;
}

async function feedbackContext(req,res){
  const payload=await verifyRequestAuth(req);
  const userId=Number(payload?.id??payload?.uid);
  if(!payload||!Number.isSafeInteger(userId)||userId<1){
    res.status(401).json({error:'authentication required'});
    return null;
  }
  let db;
  try{
    db=getClient();
    await ensureCircleMembershipReadiness(db);
  }catch{
    res.status(503).json({error:'feedback unavailable'});
    return null;
  }
  const context=await resolveActiveCircleContext(db,payload);
  if(!context.ok){
    if(context.reason==='selection_required'){
      res.status(409).json({error:'circle selection required',code:'circle_selection_required'});
    }else{
      res.status(403).json({error:'circle membership required'});
    }
    return null;
  }
  // The v22 schema may still be pending after merge (ID-87): behave exactly
  // as if the feature were off until the protected cutover applies it.
  if(!await schemaFeatureAvailable(db,{enabled:true,version:FEEDBACK_MIGRATION_VERSION})){
    res.status(404).json({error:'not found'});
    return null;
  }
  try{
    await ensureFeedbackReadiness(db);
  }catch{
    res.status(503).json({error:'feedback unavailable'});
    return null;
  }
  return {db,userId,circleId:Number(context.membership.id)};
}

async function handleSubmit(req,res){
  const input=validateFeedbackInput(req.body);
  if(!input.ok) return res.status(400).json({error:'invalid feedback',fields:input.fields});
  const context=await feedbackContext(req,res);
  if(!context) return;
  // An exact replay is answered before the rate limiter: a retry must
  // never burn budget or 429. A same-key/different-content submission is
  // a 409 here for the same reason.
  try{
    const replay=await lookupFeedbackReplay(context.db,{circleId:context.circleId,
      authorUserId:context.userId,input:input.value});
    if(replay) return res.status(200).json({ok:true,replayed:true,item:replay.item});
  }catch(error){
    if(error instanceof FeedbackConflictError){
      return res.status(409).json({error:'idempotency key already used for different feedback',
        code:'feedback_idempotency_conflict'});
    }
    if(error instanceof FeedbackInputError) return res.status(400).json({error:error.message});
    captureSentryException(error,{tags:{event:'feedback_replay_lookup_fail',source:'server'}});
    return res.status(503).json({error:'feedback unavailable'});
  }
  let rate;
  try{
    rate=await consumeFeedbackRateLimits(context.db,{userId:context.userId,ip:clientAddress(req)});
  }catch(error){
    captureSentryException(error,{tags:{event:'feedback_rate_limit_fail',source:'server'}});
    return res.status(503).json({error:'feedback unavailable'});
  }
  if(!rate.allowed){
    res.setHeader('Retry-After',String(rate.retryAfter));
    return res.status(429).json({error:'too many requests; try again later',retry_after_seconds:rate.retryAfter});
  }
  let submitted;
  try{
    submitted=await submitFeedback(context.db,{
      circleId:context.circleId,authorUserId:context.userId,input:input.value,
      adminEmails:getAdminEmails(),
    });
  }catch(error){
    if(error instanceof FeedbackConflictError){
      return res.status(409).json({error:'idempotency key already used for different feedback',
        code:'feedback_idempotency_conflict'});
    }
    if(error instanceof FeedbackInputError){
      return res.status(400).json({error:error.message});
    }
    captureSentryException(error,{tags:{event:'feedback_submit_fail',source:'server'}});
    return res.status(503).json({error:'feedback unavailable'});
  }
  res.status(submitted.replayed?200:201).json({ok:true,replayed:submitted.replayed,item:submitted.item});
  deliverCommittedOutboxEvents(req,submitted.outboxEvents);
  return undefined;
}

async function handleMine(req,res){
  const query=queryEntries(req);
  if(!query||[...query.keys()].some(key=>!['endpoint','limit','cursor'].includes(key))){
    return res.status(400).json({error:'unsupported query parameter'});
  }
  const rawLimit=query.get('limit');
  const limit=rawLimit===undefined?FEEDBACK_LIST_DEFAULT_LIMIT:Number(rawLimit);
  if((rawLimit!==undefined&&!/^\d{1,3}$/.test(rawLimit))||!Number.isSafeInteger(limit)
    ||limit<1||limit>FEEDBACK_LIST_MAX_LIMIT){
    return res.status(400).json({error:`limit must be 1-${FEEDBACK_LIST_MAX_LIMIT}`});
  }
  const cursor=decodeFeedbackCursor(query.get('cursor'));
  if(cursor===false) return res.status(400).json({error:'invalid cursor'});
  const context=await feedbackContext(req,res);
  if(!context) return;
  try{
    const page=await listMyFeedback(context.db,{authorUserId:context.userId,circleId:context.circleId,
      limit,cursor});
    return res.json({ok:true,items:page.items,next_cursor:page.nextCursor});
  }catch(error){
    if(error instanceof FeedbackInputError) return res.status(400).json({error:error.message});
    captureSentryException(error,{tags:{event:'feedback_mine_fail',source:'server'}});
    return res.status(503).json({error:'feedback unavailable'});
  }
}

export async function handleFeedbackRoute(req,res){
  if(!feedbackEnabled()) return res.status(404).json({error:'not found'});
  const path=pathname(req);
  const isMine=path.endsWith('/feedback/mine')||path.endsWith('/feedback-mine');
  const isBase=path.endsWith('/feedback');
  if(isMine){
    if(req.method!=='GET') return res.status(405).json({error:'GET only'});
    return handleMine(req,res);
  }
  if(isBase){
    if(req.method!=='POST') return res.status(405).json({error:'POST only'});
    return handleSubmit(req,res);
  }
  return res.status(404).json({error:'not found'});
}
