import {
  captureSentryException,
  getClient,
  verifyMutationOrigin,
  verifyRequestAuth,
} from './_db.js';
import { circleMembershipEnabled, ensureCircleMembershipReadiness } from './_circle-membership.js';
import {
  changeCircleMemberStatus,
  leaveCircle,
  listCircleMembersForOwner,
  transferCircleOwnership,
} from './_member-lifecycle.js';

function exactObject(value,keys){
  return !!value&&typeof value==='object'&&!Array.isArray(value)
    && Object.keys(value).length===keys.length
    && keys.every(key=>Object.prototype.hasOwnProperty.call(value,key));
}

function userId(payload){
  const value=payload?.id??payload?.uid;
  return Number.isSafeInteger(value)&&value>0?value:null;
}

function hasExactQuery(req){
  if(!req.query||!Object.keys(req.query).length) return true;
  return Object.keys(req.query).length===1&&req.query.endpoint==='members';
}

function clearSessionCookie(req){
  const proto=String(req?.headers?.['x-forwarded-proto']||'').split(',')[0].trim();
  const secure=process.env.NODE_ENV==='production'||proto==='https';
  return `randori_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure?'; Secure':''}`;
}

function transitionFailure(res,result){
  if(result.reason==='last_owner') return res.status(409).json({error:'another active owner is required'});
  if(result.reason==='self_transition') return res.status(409).json({error:'use leave circle for your own membership'});
  if(result.reason==='self_transfer') return res.status(409).json({error:'choose another active member'});
  if(result.reason==='state_conflict') return res.status(409).json({error:'membership state changed'});
  return res.status(404).json({error:'member not found'});
}

function recentAuthFailure(res,error){
  if(error?.code!=='RECENT_AUTH_REQUIRED') return false;
  res.status(403).json({error:'recent authentication required',code:'recent_auth_required'});
  return true;
}

export default async function handler(req,res){
  res.setHeader('Cache-Control','private, no-store');
  res.setHeader('Pragma','no-cache');
  if(!circleMembershipEnabled()) return res.status(404).json({error:'not found'});
  if(req.method!=='GET'&&!verifyMutationOrigin(req)) return res.status(403).json({error:'cross-origin mutation rejected'});
  if(!hasExactQuery(req)) return res.status(400).json({error:'invalid request'});
  let db;
  let actor;
  let authPayload;
  try{
    db=getClient();
    await ensureCircleMembershipReadiness(db);
    authPayload=await verifyRequestAuth(req,db);
    actor=userId(authPayload);
  }catch(error){
    captureSentryException(error,{tags:{event:'circle_membership_lifecycle_auth_fail',source:'server'}});
    return res.status(503).json({error:'membership unavailable'});
  }
  if(!actor) return res.status(401).json({error:'authentication required'});
  try{
    if(req.method==='GET'){
      const result=await listCircleMembersForOwner(db,{actorUserId:actor});
      if(!result.ok) return res.status(403).json({error:'circle owner required'});
      return res.json({ok:true,members:result.members,count:result.members.length,truncated:result.truncated===true});
    }
    if(req.method!=='PATCH'){
      res.setHeader('Allow','GET, PATCH');
      return res.status(405).json({error:'GET or PATCH only'});
    }
    if(exactObject(req.body,['action'])&&req.body.action==='leave'){
      const result=await leaveCircle(db,{actorUserId:actor});
      if(!result.ok) return transitionFailure(res,result);
      res.setHeader('Set-Cookie',clearSessionCookie(req));
      return res.json({ok:true,action:'leave'});
    }
    if(!exactObject(req.body,['action','member_id'])
      ||!['deactivate','reactivate','transfer'].includes(req.body.action)
      ||!Number.isSafeInteger(req.body.member_id)||req.body.member_id<1){
      return res.status(400).json({error:'invalid request'});
    }
    const result=req.body.action==='transfer'
      ?await transferCircleOwnership(db,{actorUserId:actor,targetUserId:req.body.member_id,session:authPayload})
      :await changeCircleMemberStatus(db,{actorUserId:actor,targetUserId:req.body.member_id,action:req.body.action,session:authPayload});
    if(!result.ok) return transitionFailure(res,result);
    return res.json({ok:true,action:req.body.action,member:result.member||{id:result.owner_id,role:'owner',status:'active'}});
  }catch(error){
    if(recentAuthFailure(res,error)) return;
    captureSentryException(error,{tags:{event:'circle_membership_lifecycle_fail',source:'server'}});
    return res.status(503).json({error:'membership unavailable'});
  }
}
