import { getClient, verifyMutationOrigin, verifyRequestAuth } from './_db.js';
import {
  canUseLegacySinglePrimaryCircleFeatures,
  multiCircleControlPlaneEnabled,
  secondaryCircleWorkspaceEnabled,
  sendMultiCircleFeatureUnavailable,
} from './_active-circle.js';
import { ensureCodeDocumentReadiness } from './_data-readiness.js';
import { dispatchWorkspaceCodeDocument, prepareWorkspaceRequest, sendWorkspaceFailure } from './_workspace-router.js';
import { parseCanonicalRoomPath } from './_pairing.js';
import { getAuthenticatedPairAccess } from './_pair-access.js';
import {
  CodeDocumentDataError,
  CodeDocumentInputError,
  codeDocumentResponse,
  getAuthorizedCodeDocument,
  mergeAuthorizedCodeDocument,
  parseCodeDocumentMutation,
  parseCodeDocumentQuery,
} from './_code-document.js';

function authenticatedUserId(payload){
  const userId=Number(payload?.id||payload?.uid);
  return Number.isSafeInteger(userId)&&userId>0?userId:null;
}

function safeReadOrigin(req){
  const authorization=String(req?.headers?.authorization||req?.headers?.Authorization||'');
  if(/^Bearer\s+\S+/i.test(authorization)) return true;
  const cookie=String(req?.headers?.cookie||req?.headers?.Cookie||'');
  if(!/(?:^|;\s*)randori_session=/.test(cookie)) return true;
  const site=String(req?.headers?.['sec-fetch-site']||req?.headers?.['Sec-Fetch-Site']||'').toLowerCase();
  if(site) return site==='same-origin';
  return verifyMutationOrigin({...req,method:'POST'});
}

function sendFailure(res,error){
  if(error instanceof CodeDocumentInputError){
    return res.status(error.status||400).json({ok:false,error:error.message});
  }
  if(error instanceof CodeDocumentDataError){
    return res.status(503).json({ok:false,error:'code document unavailable'});
  }
  return res.status(503).json({ok:false,error:'code document unavailable'});
}

export default async function handler(req,res){
  res.setHeader?.('Cache-Control','private, no-store');
  res.setHeader?.('X-Content-Type-Options','nosniff');
  if(!['GET','POST'].includes(req.method)){
    res.setHeader?.('Allow','GET, POST');
    return res.status(405).json({ok:false,error:'GET or POST only'});
  }
  if(req.method==='POST'&&!verifyMutationOrigin(req)){
    return res.status(403).json({ok:false,error:'cross-origin mutation rejected'});
  }
  if(req.method==='GET'&&!safeReadOrigin(req)){
    return res.status(403).json({ok:false,error:'cross-origin read rejected'});
  }
  let auth;
  try{ auth=await verifyRequestAuth(req); }
  catch{ return res.status(503).json({ok:false,error:'code document unavailable'}); }
  const viewerId=authenticatedUserId(auth);
  if(!viewerId) return res.status(401).json({ok:false,error:'authentication required'});
  let db;
  try{
    const selected=await prepareWorkspaceRequest(req,res);
    if(selected?.mode==='secondary')return await dispatchWorkspaceCodeDocument(req,res,selected);
    db=getClient();
    if(selected){
      db=selected.db;
      const raw=req.method==='GET'?(req.query?.room_id??new URL(req.url,'http://localhost').searchParams.get('room_id')):req.body?.room_id;
      const room=typeof raw==='string'?parseCanonicalRoomPath(`/join/${raw}`):null;
      if(!room||!await getAuthenticatedPairAccess(db,{userId:viewerId,weekId:room.weekId,pairGroupId:room.pairGroupId}))
        return res.status(404).json({error:'pair not found'});
    }
    await ensureCodeDocumentReadiness(db);
    if(!selected&&multiCircleControlPlaneEnabled()&&!(await canUseLegacySinglePrimaryCircleFeatures(db,auth))){
      return sendMultiCircleFeatureUnavailable(res);
    }
  }catch(error){ if(secondaryCircleWorkspaceEnabled())return sendWorkspaceFailure(res,error);return res.status(503).json({ok:false,error:'code document unavailable'}); }

  try{
    if(req.method==='GET'){
      const input=parseCodeDocumentQuery(req);
      const result=await getAuthorizedCodeDocument(db,{viewerId,...input});
      // Owner resolution #438: an authorized primary member's own room keeps
      // the legacy code-document 404 (including an unsupported solo/triad).
      // Foreign/nonexistent workspace requests use the uniform pair 404.
      if(!result) return res.status(404).json({ok:false,error:'code document not found'});
      return res.json(codeDocumentResponse(result,{afterRevision:input.afterRevision}));
    }
    const input=parseCodeDocumentMutation(req.body);
    const result=await mergeAuthorizedCodeDocument(db,{viewerId,...input});
    if(!result) return res.status(404).json({ok:false,error:'code document not found'});
    if(result.terminal) return res.status(409).json({ok:false,code:'session_completed',error:'session is completed'});
    return res.json({...codeDocumentResponse(result),idempotent:result.idempotent});
  }catch(error){ return req.workspace?sendWorkspaceFailure(res,error):sendFailure(res,error); }
}
