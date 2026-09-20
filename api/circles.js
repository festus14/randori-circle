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
  requestCircleContextVersion,
  selectActiveCircleContext,
} from './_active-circle.js';
import {
  CircleCreationError,
  createCircleAndSelect,
  ensureCircleCreationReadiness,
  parseCircleCreation,
} from './_circle-creation.js';
import {
  archiveSecondaryCircle,
  CircleArchiveError,
  parseCircleArchive,
} from './_circle-archive.js';

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
  if(req.method!=='GET'&&req.method!=='PUT'&&req.method!=='POST'&&req.method!=='DELETE'){
    res.setHeader('Allow','DELETE, GET, POST, PUT');
    return res.status(405).json({error:'DELETE, GET, POST, or PUT only'});
  }
  if(hasQuery(req)) return res.status(400).json({error:'invalid request'});
  if(req.method!=='GET'&&!verifyMutationOrigin(req)){
    return res.status(403).json({error:'cross-origin mutation rejected'});
  }
  let creationInput=null;
  let archiveInput=null;
  if(req.method==='POST'){
    try{ creationInput=parseCircleCreation(req.body); }
    catch(error){
      if(error instanceof CircleCreationError&&error.code==='CIRCLE_CREATE_INPUT_INVALID'){
        return res.status(400).json({error:'invalid circle creation'});
      }
      throw error;
    }
  }else if(req.method==='DELETE'){
    try{ archiveInput=parseCircleArchive(req.body); }
    catch(error){
      if(error instanceof CircleArchiveError&&error.code==='CIRCLE_ARCHIVE_INPUT_INVALID'){
        return res.status(400).json({error:'invalid circle archive'});
      }
      throw error;
    }
    if(requestCircleContextVersion(req)!==archiveInput.expectedContextVersion){
      return res.status(409).json({error:'circle context changed',code:'circle_context_changed'});
    }
  }
  let db,payload;
  try{
    db=getClient();
    await ensureCircleMembershipReadiness(db);
    if(req.method==='POST') await ensureCircleCreationReadiness(db);
    payload=await verifyRequestAuth(req,db);
  }catch(error){
    captureSentryException(error,{tags:{event:'active_circle_auth_fail',source:'server'}});
    return res.status(503).json({error:'circles unavailable'});
  }
  if(!payload) return res.status(401).json({error:'authentication required'});
  try{
    if(req.method==='GET') return res.json(responsePayload(await listSessionCircleContexts(db,payload)));
    if(req.method==='POST'){
      const created=await createCircleAndSelect(db,payload,creationInput);
      if(!created.ok){
        if(created.reason==='session_changed') return res.status(401).json({error:'authentication required'});
        if(created.reason==='ownership_limit'){
          return res.status(409).json({error:'circle ownership limit reached',code:'circle_ownership_limit'});
        }
        if(created.reason==='membership_limit'){
          return res.status(409).json({error:'circle membership limit reached',code:'circle_membership_limit'});
        }
        if(created.reason==='request_conflict'){
          return res.status(409).json({error:'circle creation request changed',code:'circle_creation_request_conflict'});
        }
        if(created.reason==='context_changed'){
          return res.status(409).json({error:'circle context changed',code:'circle_context_changed'});
        }
        throw new Error('invalid circle creation result');
      }
      return res.status(created.created?201:200).json({
        ok:true,circle:created.circle,context_version:created.context_version,
      });
    }
    if(req.method==='DELETE'){
      const archived=await archiveSecondaryCircle(db,payload,archiveInput);
      if(!archived.ok){
        if(archived.reason==='session_changed') return res.status(401).json({error:'authentication required'});
        if(archived.reason==='context_changed'){
          return res.status(409).json({error:'circle context changed',code:'circle_context_changed'});
        }
        if(archived.reason==='primary_circle'){
          return res.status(409).json({error:'the primary circle cannot be archived',code:'primary_circle_required'});
        }
        if(archived.reason==='last_circle'){
          return res.status(409).json({
            error:'every active member needs another circle before archive',code:'member_last_circle',
          });
        }
        return res.status(404).json({error:'circle unavailable'});
      }
      let listed;
      try{ listed=await listSessionCircleContexts(db,payload); }
      catch(error){
        captureSentryException(error,{tags:{event:'circle_archive_refresh_fail',source:'server'}});
        return res.status(503).json({
          error:'circle archived; reload required',code:'circle_archive_refresh_required',
          archived_circle_public_id:archived.circle.public_id,
          context_version:Number.isSafeInteger(archived.context_version)
            ?archived.context_version:archiveInput.expectedContextVersion+1,
        });
      }
      return res.json({
        ...responsePayload(listed),
        archived_circle_public_id:archived.circle.public_id,
        archived:archived.changed,
      });
    }
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
    if(error?.code==='RECENT_AUTH_REQUIRED'){
      return res.status(403).json({error:'recent authentication required',code:'recent_auth_required'});
    }
    captureSentryException(error,{tags:{event:'active_circle_context_fail',source:'server'}});
    return res.status(503).json({
      error:error instanceof CircleCreationError&&error.code==='CIRCLE_CREATE_COMMIT_UNKNOWN'
        ?'circle creation status unknown; retry with the same request_id'
        :error instanceof CircleArchiveError&&error.code==='CIRCLE_ARCHIVE_COMMIT_UNKNOWN'
        ?'circle archive status unknown; retry the same archive request'
        :'circles unavailable',
      ...(error instanceof CircleCreationError&&error.code==='CIRCLE_CREATE_COMMIT_UNKNOWN'
        ?{code:'circle_creation_status_unknown'}:{}),
      ...(error instanceof CircleArchiveError&&error.code==='CIRCLE_ARCHIVE_COMMIT_UNKNOWN'
        ?{code:'circle_archive_status_unknown'}:{}),
    });
  }
}
