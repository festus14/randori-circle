import { getClient, getJwtSecret, verifyRequestAuth } from './_db.js';
import { secondaryCircleWorkspaceEnabled } from './_active-circle.js';
import { parseCanonicalRoomPath } from './_pairing.js';
import { resolveWorkspaceContext, scopedWorkspaceClient, workspaceEnvelope, WorkspaceContextError, stableWorkspaceRead, withWorkspaceRetry, parseSecondaryRoomPath, secondaryRoomId } from './_workspace-access.js';
import { readWorkspaceHistory } from './_workspace-history.js';
import { ensureSecondaryWorkspaceReadiness } from './_workspace-readiness.js';
import { executeSecondaryProgram, verifySecondaryRun } from './_secondary-execution.js';
import * as workspace from './_secondary-workspace.js';
import { progressDashboardEnabled } from './_progress.js';
import { ExecutionUnavailableError } from './_execution.js';
import { MeetingLinkInputError } from './_meeting-link.js';
import { newestRecapActivity, projectRecapWorkspace, MAX_RECAP_RUN_SCAN } from './_pair-recap.js';

const ROUTES=new Set(['history','messages','runs','execute','pair-recap','session-completion','session-controls','meeting-link']);
const NOT_FOUND=Object.freeze({error:'pair not found'});

export function sendWorkspaceFailure(res,error){
  if(error instanceof WorkspaceContextError){
    if(error.code==='membership_required')return res.status(403).json({ok:false,error:'active circle membership required'});
    return res.status(409).json({ok:false,error:error.code==='active_circle_required'?'select an active circle':'circle context changed',code:error.code});
  }
  if(error instanceof MeetingLinkInputError)return res.status(400).json({error:error.message});
  if(error instanceof ExecutionUnavailableError)return res.status(503).json({ok:false,error:'code execution is temporarily unavailable; your code was not run',code:'execution_unavailable'});
  if(error instanceof workspace.SecondaryWorkspaceConflictError)return res.status(409).json({error:error.message,code:error.code,...(error.state?.latest_document_version!==undefined?error.state:{})});
  if(Number.isInteger(error?.status)&&error.status>=400&&error.status<500){
    if(error.status===429)res.setHeader?.('Retry-After','60');
    return res.status(error.status).json({error:error.message});
  }
  return res.status(503).json({error:'workspace unavailable'});
}

export async function prepareWorkspaceRequest(req,res){
  if(!secondaryCircleWorkspaceEnabled())return null;
  const payload=await verifyRequestAuth(req);if(!payload)return null;
  const raw=getClient();await ensureSecondaryWorkspaceReadiness(raw);
  const context=await resolveWorkspaceContext(raw,payload,req),db=scopedWorkspaceClient(raw,context);
  req.workspace={db,context,mode:context.membership.is_primary?'primary':'secondary'};
  const json=res.json.bind(res);
  res.json=body=>json(body?.ok===true?{...body,...workspaceEnvelope(context),...(body.recap?{recap:{...body.recap,circle:workspaceEnvelope(context).circle}}:{})}:body);
  return req.workspace;
}

function queryValue(req,key){
  if(req.query&&Object.hasOwn(req.query,key))return req.query[key];
  return new URL(req.url,'http://localhost').searchParams.get(key)??undefined;
}
function validateQuery(req,allowed){
  const search=new URL(req.url,'http://localhost').searchParams;
  for(const key of new Set([...search.keys(),...Object.keys(req.query||{})])){
    if(!allowed.includes(key))throw new workspace.SecondaryWorkspaceInputError('unsupported query parameter');
    if(search.getAll(key).length>1||Array.isArray(req.query?.[key]))throw new workspace.SecondaryWorkspaceInputError('query parameters must be provided once');
  }
}
function bounded(value,fallback,max){const number=value===undefined?fallback:Number(value);if(value!==undefined&&(typeof value!=='string'||!/^(0|[1-9]\d*)$/.test(value))||!Number.isSafeInteger(number)||number<0||number>max)throw new workspace.SecondaryWorkspaceInputError('invalid workspace cursor or limit');return number;}

async function recap(db,room,key){
  const current=await workspace.readSecondaryCompletion(db,room,key);if(!current)return null;
  const members=await db.execute(workspace.accessStatement(db,room,`SELECT account.id,account.display_name FROM auth_accounts account
    JOIN circle_memberships membership ON membership.user_id=account.id AND membership.status='active'
    JOIN access ON membership.circle_id=access.circle_id AND account.id IN (access.user_a_id,access.user_b_id)`));
  const names=new Map(members.rows.map(row=>[Number(row.id),String(row.display_name)]));
  const publication=await db.execute(workspace.accessStatement(db,room,`SELECT publication.cycle_id,publication.starts_at FROM circle_pairing_publications publication
    JOIN access ON publication.id=access.publication_id AND publication.circle_id=access.circle_id AND publication.scope_key=access.scope_key AND publication.cycle_key=access.cycle_key`));
  if(publication.rows.length!==1)throw new Error('recap publication unavailable');
  const messages=await workspace.readSecondaryMessages(db,room,{newest:true}),runs=await workspace.readSecondaryRuns(db,room,{limit:MAX_RECAP_RUN_SCAN+1,verify:verifySecondaryRun,failOnOverflow:true}),snapshot=await workspace.readSecondarySnapshot(db,room);
  if(!messages||!runs||!snapshot)throw new Error('recap data unavailable');
  const schedule=(await workspace.readSecondaryMeetingLink(db,room,key))?.schedule;if(!schedule)throw new Error('recap schedule unavailable');
  const activity=newestRecapActivity(messages.messages.map(message=>({kind:'message',event_id:`message:${message.id}`,created_at:message.created_at,actor:{id:message.sender_id,display_name:message.sender_name},message:message.message})),
    runs.runs.map(run=>({kind:'run',event_id:`run:${run.id}`,created_at:run.created_at,actor:run.runner,...run})));
  const group=current.group,checkpoint=snapshot.snapshot;
  return {pair:{id:room.groupId,publication_id:room.publicationId,room_id:room.roomId,week_label:publication.rows[0].cycle_id,week_start:publication.rows[0].starts_at,
    topic:'Pick together',topic_kind:'both',solo:Number(group.is_solo)===1,partner_unavailable:group.user_b_id!=null&&!names.has(Number(group.user_b_id)),
    members:[group.user_a_id,group.user_b_id].filter(id=>id!=null).map(id=>({id:Number(id),display_name:names.get(Number(id))||'Member unavailable',is_ai:false,is_me:Number(id)===Number(db.workspaceContext.payload.id??db.workspaceContext.payload.uid)}))},
    schedule,activity,completion:current.completion,workspace:projectRecapWorkspace(checkpoint?{...checkpoint,question_id:checkpoint.question_version?`${checkpoint.question_id}@${checkpoint.question_version}`:checkpoint.question_id}:null)};
}

export async function dispatchWorkspaceData(req,res,route){
  if(!secondaryCircleWorkspaceEnabled()||!ROUTES.has(route))return false;
  try{
    const selected=await prepareWorkspaceRequest(req,res);if(!selected)return false;
    const {db,context,mode}=selected;
    if(route==='history'){
      if(req.method!=='GET'){res.status(405).json({error:'GET only'});return true;}
      res.json(await readWorkspaceHistory(db,context,getJwtSecret(),{progressEnabled:progressDashboardEnabled()}));return true;
    }
    const raw=req.method==='GET'?queryValue(req,'room_id'):req.body?.room_id;
    if(mode==='primary'){
      if(typeof raw==='string'&&parseSecondaryRoomPath(`/join/${raw}`)){res.status(404).json(NOT_FOUND);return true;}
      return false;
    }
    const room=workspace.secondaryRequestRoom(raw,context);
    if(!room){res.status(404).json(NOT_FOUND);return true;}
    // All existence checks use the same snapshot CTE as the eventual data
    // statement. Invalid payloads never disclose a foreign pair's existence.
    if(!await workspace.pair(db,room)){res.status(404).json(NOT_FOUND);return true;}
    if(!['GET','POST'].includes(req.method)||(route==='execute'&&req.method!=='POST')||(route==='pair-recap'&&req.method!=='GET')||(route==='runs'&&req.method!=='GET')){
      res.status(405).json({error:'unsupported workspace method'});return true;
    }
    validateQuery(req,req.method==='GET'?(['messages','runs'].includes(route)?['endpoint','room_id','after_id','limit']:['endpoint','room_id']):['endpoint']);
    const key=getJwtSecret();let result;
    if(route==='messages')result=req.method==='GET'?await stableWorkspaceRead(db,tx=>workspace.readSecondaryMessages(tx,room,{afterId:bounded(queryValue(req,'after_id'),0,Number.MAX_SAFE_INTEGER),limit:bounded(queryValue(req,'limit'),50,50)})):await withWorkspaceRetry(()=>workspace.sendSecondaryMessage(db,room,req.body));
    else if(route==='runs')result=await stableWorkspaceRead(db,tx=>workspace.readSecondaryRuns(tx,room,{afterId:bounded(queryValue(req,'after_id'),0,Number.MAX_SAFE_INTEGER),limit:bounded(queryValue(req,'limit'),20,20),verify:verifySecondaryRun}));
    else if(route==='execute')result=await executeSecondaryProgram(db,room,req,key);
    else if(route==='session-completion'){
      try{const state=req.method==='GET'?await stableWorkspaceRead(db,tx=>workspace.readSecondaryCompletion(tx,room,key)):await withWorkspaceRetry(()=>workspace.mutateSecondaryCompletion(db,room,req.body,key));result=state?{completion:state.completion}:null;}
      catch(error){if(error instanceof workspace.SecondaryWorkspaceConflictError){res.status(409).json({error:error.message,code:error.code,room_id:room.roomId,completion:error.state});return true;}throw error;}
    }else if(route==='session-controls'||route==='meeting-link'){
      const field=route==='session-controls'?'session_controls':'meeting_link';
      try{const state=route==='session-controls'?(req.method==='GET'?await stableWorkspaceRead(db,tx=>workspace.readSecondaryControls(tx,room,key)):await withWorkspaceRetry(()=>workspace.mutateSecondaryControls(db,room,req.body,key))):(req.method==='GET'?await stableWorkspaceRead(db,tx=>workspace.readSecondaryMeetingLink(tx,room,key)):await withWorkspaceRetry(()=>workspace.mutateSecondaryMeetingLink(db,room,req.body,key)));result=state?{[field]:state.state}:null;}
      catch(error){if(error instanceof workspace.SecondaryWorkspaceConflictError){res.status(409).json({error:error.message,code:error.code,room_id:room.roomId,[field]:error.state});return true;}throw error;}
    }else{const tx=await db.transaction('read');try{const value=await recap(tx,room,key);await tx.commit();result=value?{recap:{...value,circle:workspaceEnvelope(context).circle}}:null;}catch(error){try{await tx.rollback();}catch{}throw error;}finally{await tx.close?.();}}
    if(!result)res.status(404).json(NOT_FOUND);else res.status(route==='messages'&&req.method==='POST'?201:200).json({ok:true,room_id:room.roomId,...result});
    return true;
  }catch(error){sendWorkspaceFailure(res,error);return true;}
}

export async function dispatchWorkspaceCodeDocument(req,res,selected){
  const {db,context}=selected,raw=req.method==='GET'?queryValue(req,'room_id'):req.body?.room_id;
  const room=workspace.secondaryRequestRoom(raw,context);if(!room){res.status(404).json(NOT_FOUND);return;}
  if(!await workspace.pair(db,room,true)){res.status(404).json(NOT_FOUND);return;}
  const key=getJwtSecret();
  if(req.method==='POST'){
    const result=await withWorkspaceRetry(()=>workspace.mutateSecondaryDocument(db,room,req.body,key));
    if(!result)return res.status(404).json(NOT_FOUND);
    return res.json({...workspace.secondaryDocumentResponse(result),idempotent:result.idempotent});
  }
  validateQuery(req,['endpoint','room_id','question_slug','question_version','language','after_revision']);
  const query=Object.fromEntries(new URL(req.url,'http://localhost').searchParams);Object.assign(query,req.query||{});
  const identity=workspace.secondaryDocumentIdentity(query),after=bounded(query.after_revision,0,Number.MAX_SAFE_INTEGER),tx=await db.transaction('write');
  try{const result=await workspace.readSecondaryDocument(tx,room,identity);if(!result){await tx.rollback();return res.status(404).json(NOT_FOUND);}await tx.commit();return res.json(workspace.secondaryDocumentResponse(result,after));}
  catch(error){try{await tx.rollback();}catch{}throw error;}finally{await tx.close?.();}
}

export async function dispatchWorkspaceVideo(req,res,selected){
  const {db,context}=selected,raw=req.method==='GET'?queryValue(req,'room_id'):req.body?.room_id??queryValue(req,'room_id');
  const room=workspace.secondaryRequestRoom(raw,context);if(!room)return res.status(404).json(NOT_FOUND);
  if(!await workspace.pair(db,room))return res.status(404).json(NOT_FOUND);
  if(!['GET','POST','DELETE'].includes(req.method))return res.status(405).json({error:'GET, POST or DELETE only'});
  const isSnapshot=req.method==='GET'?queryValue(req,'channel')==='workspace':req.body?.type==='code-sync';
  let result;
  if(isSnapshot)result=req.method==='GET'?await stableWorkspaceRead(db,tx=>workspace.readSecondarySnapshot(tx,room,{afterRevision:bounded(queryValue(req,'after_revision'),0,Number.MAX_SAFE_INTEGER)}),'write'):await withWorkspaceRetry(()=>workspace.mutateSecondarySnapshot(db,room,req.body,getJwtSecret()));
  else result=req.method==='GET'?await stableWorkspaceRead(db,tx=>workspace.readSecondarySignals(tx,room,{after:bounded(queryValue(req,'after')??queryValue(req,'since'),0,Number.MAX_SAFE_INTEGER),peerId:String(queryValue(req,'peer_id')||'').slice(0,128)})):await withWorkspaceRetry(()=>workspace.mutateSecondarySignals(db,room,req.body,{purge:req.method==='DELETE'}));
  if(!result)return res.status(404).json(NOT_FOUND);return res.json({ok:true,room_id:room.roomId,...result});
}
