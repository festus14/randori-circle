import {
  captureSentryException,
  getClient,
  verifyMutationOrigin,
  verifyRequestAuth,
} from './_db.js';
import { ensureCircleMembershipReadiness } from './_circle-membership.js';
import {
  listSessionCircleContexts,
  multiCircleControlPlaneEnabled,
  selectActiveCircleContext,
} from './_active-circle.js';

function exactObject(value,keys){
  return !!value&&typeof value==='object'&&!Array.isArray(value)
    && Object.keys(value).length===keys.length
    && keys.every(key=>Object.prototype.hasOwnProperty.call(value,key));
}

function responsePayload(context){
  const project=circle=>circle?{
    public_id:circle.public_id,name:circle.name,role:circle.role,is_primary:circle.is_primary,
  }:null;
  return {
    ok:true,
    circles:context.circles.map(project),
    active_circle:project(context.active),
    context_version:context.context_version,
    selection_required:context.selection_required,
  };
}

function hasQuery(req){
  if(req?.query&&Object.keys(req.query).length) return true;
  try{ return [...new URL(req?.url||'/', 'https://randori.invalid').searchParams.keys()].length>0; }
  catch{ return true; }
}

export default async function handler(req,res){
  res.setHeader('Cache-Control','private, no-store');
  res.setHeader('Pragma','no-cache');
  if(!multiCircleControlPlaneEnabled()) return res.status(404).json({error:'not found'});
  if(req.method!=='GET'&&req.method!=='PUT'){
    res.setHeader('Allow','GET, PUT');
    return res.status(405).json({error:'GET or PUT only'});
  }
  if(hasQuery(req)) return res.status(400).json({error:'invalid request'});
  if(req.method==='PUT'&&!verifyMutationOrigin(req)){
    return res.status(403).json({error:'cross-origin mutation rejected'});
  }
  let db,payload;
  try{
    db=getClient();
    await ensureCircleMembershipReadiness(db);
    payload=await verifyRequestAuth(req,db);
  }catch(error){
    captureSentryException(error,{tags:{event:'active_circle_auth_fail',source:'server'}});
    return res.status(503).json({error:'circles unavailable'});
  }
  if(!payload) return res.status(401).json({error:'authentication required'});
  try{
    if(req.method==='GET') return res.json(responsePayload(await listSessionCircleContexts(db,payload)));
    if(!exactObject(req.body,['circle_public_id','expected_context_version'])
      ||typeof req.body.circle_public_id!=='string'
      ||!Number.isSafeInteger(req.body.expected_context_version)||req.body.expected_context_version<0){
      return res.status(400).json({error:'invalid circle selection'});
    }
    const selected=await selectActiveCircleContext(db,payload,{
      circlePublicId:req.body.circle_public_id,
      expectedContextVersion:req.body.expected_context_version,
    });
    if(!selected.ok){
      if(selected.reason==='context_changed'){
        return res.status(409).json({error:'circle context changed',code:'circle_context_changed'});
      }
      return res.status(404).json({error:'circle unavailable'});
    }
    const listed=await listSessionCircleContexts(db,payload);
    return res.json(responsePayload(listed));
  }catch(error){
    captureSentryException(error,{tags:{event:'active_circle_context_fail',source:'server'}});
    return res.status(503).json({error:'circles unavailable'});
  }
}
