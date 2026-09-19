import {
  captureSentryException,
  getClient,
  getJwtSecret,
  verifyMutationOrigin,
  verifyRequestAuth,
} from './_db.js';
import {
  circleMembershipEnabled,
  ensureCircleMembershipReadiness,
  getActivePrimaryCircleMembership,
} from './_circle-membership.js';
import { multiCircleControlPlaneEnabled, requestMatchesCircleContext, resolveActiveCircleContext } from './_active-circle.js';
import {
  changeCircleMemberStatus,
  leaveCircle,
  listCircleMembersForOwner,
  MEMBER_PAGE_DEFAULT,
  MEMBER_PAGE_MAX,
  MemberRosterQueryError,
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

function hasMutationQuery(req){
  if(!req.query||!Object.keys(req.query).length) return true;
  return Object.keys(req.query).length===1&&req.query.endpoint==='members';
}

function listQuery(req){
  const query=req.query&&typeof req.query==='object'&&!Array.isArray(req.query)?req.query:{};
  const allowed=new Set(['endpoint','cursor','q','limit']);
  if(Object.keys(query).some(key=>!allowed.has(key))) throw new MemberRosterQueryError('invalid_query');
  if(query.endpoint!==undefined&&query.endpoint!=='members') throw new MemberRosterQueryError('invalid_query');
  for(const value of Object.values(query)){
    if(Array.isArray(value)||value!=null&&typeof value!=='string') throw new MemberRosterQueryError('invalid_query');
  }
  const cursor=query.cursor===undefined?null:query.cursor;
  if(cursor!==null&&(!cursor||cursor.length>640)) throw new MemberRosterQueryError('invalid_cursor');
  const search=query.q===undefined?'':query.q;
  const rawLimit=query.limit;
  const limit=rawLimit===undefined?MEMBER_PAGE_DEFAULT:Number(rawLimit);
  if(!Number.isSafeInteger(limit)||limit<1||limit>MEMBER_PAGE_MAX||String(limit)!==rawLimit&&rawLimit!==undefined){
    throw new MemberRosterQueryError('invalid_query');
  }
  return {cursor,search,limit};
}

function clearSessionCookie(req){
  const proto=String(req?.headers?.['x-forwarded-proto']||'').split(',')[0].trim();
  const secure=process.env.NODE_ENV==='production'||proto==='https';
  return `randori_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure?'; Secure':''}`;
}

function transitionFailure(res,result){
  if(result.reason==='context_changed') return res.status(409).json({error:'circle context changed',code:'circle_context_changed'});
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
  let rosterQuery=null;
  try{
    if(req.method==='GET') rosterQuery=listQuery(req);
    else if(!hasMutationQuery(req)) throw new MemberRosterQueryError('invalid_query');
  }catch{
    return res.status(400).json({error:'invalid request'});
  }
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
    const activeContext=multiCircleControlPlaneEnabled()
      ?await resolveActiveCircleContext(db,authPayload)
      :{ok:true,membership:await getActivePrimaryCircleMembership(db,actor)};
    if(!activeContext.ok){
      if(activeContext.reason==='selection_required'){
        return res.status(409).json({error:'select an active circle',code:'active_circle_required'});
      }
      return res.status(403).json({error:'circle membership required'});
    }
    if(multiCircleControlPlaneEnabled()&&!activeContext.implicit&&!requestMatchesCircleContext(req,activeContext)){
      return res.status(409).json({error:'circle context changed',code:'circle_context_changed'});
    }
    const circleId=Number(activeContext.membership?.circle_id??activeContext.membership?.id);
    const circleContextVersion=Number(activeContext.context_version)||0;
    const circleContext=multiCircleControlPlaneEnabled()?{
      payload:authPayload,contextVersion:circleContextVersion,implicit:activeContext.implicit===true,
    }:null;
    if(!Number.isSafeInteger(circleId)||circleId<1) return res.status(403).json({error:'circle membership required'});
    if(req.method==='GET'){
      const result=await listCircleMembersForOwner(db,{
        actorUserId:actor,circleId,
        ...rosterQuery,
        cursorSecret:getJwtSecret(),
      });
      if(!result.ok) return res.status(403).json({error:'circle owner required'});
      return res.json({
        ok:true,
        members:result.members,
        count:result.members.length,
        has_more:result.has_more===true,
        next_cursor:result.next_cursor||null,
        scanned:Number(result.scanned)||0,
        ...(multiCircleControlPlaneEnabled()?{circle_context_version:circleContextVersion}:{}),
      });
    }
    if(req.method!=='PATCH'){
      res.setHeader('Allow','GET, PATCH');
      return res.status(405).json({error:'GET or PATCH only'});
    }
    if(exactObject(req.body,['action'])&&req.body.action==='leave'){
      const result=await leaveCircle(db,{actorUserId:actor,circleId,...(circleContext?{circleContext}:{})});
      if(!result.ok) return transitionFailure(res,result);
      if(!multiCircleControlPlaneEnabled()||result.signed_out) res.setHeader('Set-Cookie',clearSessionCookie(req));
      return res.json({ok:true,action:'leave',
        ...(multiCircleControlPlaneEnabled()?{signed_out:result.signed_out===true,circle_context_version:circleContextVersion}:{}),
      });
    }
    if(!exactObject(req.body,['action','member_id'])
      ||!['deactivate','reactivate','transfer'].includes(req.body.action)
      ||!Number.isSafeInteger(req.body.member_id)||req.body.member_id<1){
      return res.status(400).json({error:'invalid request'});
    }
    const result=req.body.action==='transfer'
      ?await transferCircleOwnership(db,{actorUserId:actor,targetUserId:req.body.member_id,circleId,session:authPayload,...(circleContext?{circleContext}:{})})
      :await changeCircleMemberStatus(db,{actorUserId:actor,targetUserId:req.body.member_id,circleId,action:req.body.action,session:authPayload,...(circleContext?{circleContext}:{})});
    if(!result.ok) return transitionFailure(res,result);
    return res.json({ok:true,action:req.body.action,member:result.member||{id:result.owner_id,role:'owner',status:'active'},
      ...(multiCircleControlPlaneEnabled()?{circle_context_version:circleContextVersion}:{}),
    });
  }catch(error){
    if(recentAuthFailure(res,error)) return;
    if(error instanceof MemberRosterQueryError){
      return res.status(400).json({error:'invalid request'});
    }
    captureSentryException(error,{tags:{event:'circle_membership_lifecycle_fail',source:'server'}});
    return res.status(503).json({error:'membership unavailable'});
  }
}
