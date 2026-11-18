// POST /api/video/room handler (issue #463, ID-98). Loaded by api/video.js
// only while the embedded-video capability is configured, so the existing
// signaling route keeps its exact import graph and behaviour when it is off.
import { getClient, getJwtSecret, verifyRequestAuth } from './_db.js';
import { ensureDataSessionControlsReadiness } from './_data-readiness.js';
import { parseCanonicalRoomPath } from './_pairing.js';
import { readAuthorizedSessionControls } from './_session-controls.js';
import {
  DailyProviderError,
  dailyGrantWindow,
  dailyParticipantLabel,
  enforceDailyVideoRateLimit,
  mintDailyRoomGrant,
  parseEmbeddedRoomRequest,
} from './_daily-video.js';

function parseCanonicalRoomId(value){
  if(typeof value!=='string') return null;
  const parsed=parseCanonicalRoomPath(`/join/${value}`);
  return parsed?.roomId===value
    ?{roomId:parsed.roomId,weekId:parsed.weekId,pairGroupId:parsed.pairGroupId}
    :null;
}

function authenticatedUserId(payload){
  const userId=Number(payload?.id||payload?.uid);
  return Number.isSafeInteger(userId)&&userId>0?userId:null;
}

const EMBEDDED_VIDEO_UNAVAILABLE={error:'embedded video unavailable',code:'embedded_video_unavailable'};

async function readEmbeddedRoomAccess(db,{userId,room,versionKey}){
  const transaction=await db.transaction('read');
  let finished=false;
  try{
    const read=await readAuthorizedSessionControls(transaction,{
      viewerId:userId,weekId:room.weekId,pairGroupId:room.pairGroupId,versionKey,
    });
    await transaction.commit(); finished=true;
    return read;
  }catch(error){
    if(!finished){ try{ await transaction.rollback(); }catch{} }
    throw error;
  }finally{ try{ await transaction.close(); }catch{} }
}

// POST /api/video/room (issue #463, ID-98): a private Daily room and a
// short-lived non-owner token for one participant of a canonical primary
// two-person room. Authorization is the same source-tagged exact-pair read
// as session controls; every refusal of a room the viewer does not occupy is
// the identical 404 projection.
export async function handleEmbeddedRoom(req,res,config){
  res.setHeader('Cache-Control','private, no-store');
  if(req.method!=='POST'){
    res.setHeader('Allow','POST');
    return res.status(405).json({error:'POST only'});
  }
  const payload=await verifyRequestAuth(req);
  const userId=authenticatedUserId(payload);
  if(!userId) return res.status(401).json({error:'authentication required'});
  let input;
  // parseEmbeddedRoomRequest throws only DailyVideoInputError.
  try{ input=parseEmbeddedRoomRequest(req,parseCanonicalRoomId); }
  catch(error){ return res.status(400).json({error:error.message}); }
  let db,secret;
  try{
    db=req.workspace?.db||getClient(); await ensureDataSessionControlsReadiness(db); secret=getJwtSecret();
  }catch{ return res.status(503).json(EMBEDDED_VIDEO_UNAVAILABLE); }
  try{
    const rate=await enforceDailyVideoRateLimit(db,{req,userId,secret});
    if(!rate.allowed){
      res.setHeader('Retry-After',String(rate.retryAfter));
      return res.status(429).json({error:'too many video join attempts; try again later'});
    }
  }catch{ return res.status(503).json(EMBEDDED_VIDEO_UNAVAILABLE); }
  let access;
  try{ access=await readEmbeddedRoomAccess(db,{userId,room:input,versionKey:secret}); }
  catch{ return res.status(503).json(EMBEDDED_VIDEO_UNAVAILABLE); }
  if(!access) return res.status(404).json({error:'pair not found'});
  const window=dailyGrantWindow({databaseNow:access.databaseNow,state:access.state});
  if(access.state.terminal||window.ttlSeconds<1){
    const interview=access.state.interview_mode===true&&access.state.end_reason!=='completed';
    return res.status(409).json({
      error:interview?'interview has ended':'session has been completed',
      code:interview?'interview_session_ended':'session_completed',room_id:input.roomId,
    });
  }
  try{
    const grant=await mintDailyRoomGrant(config,{
      roomId:input.roomId,secret,window,label:dailyParticipantLabel(access.state),
      camera:input.camera,microphone:input.microphone,fetchImpl:globalThis.fetch,
    });
    return res.json({
      ok:true,room_id:input.roomId,provider:'daily',room_url:grant.roomUrl,token:grant.token,
      expires_at:grant.expiresAt,expires_in:grant.expiresIn,recording:false,
    });
  }catch(error){
    // Stage, HTTP status and Daily's fixed error code only: no key, token,
    // label, room name or provider free text.
    const known=error instanceof DailyProviderError;
    const detail={stage:known?error.stage:'unexpected',status:known?error.status:null,error:known?error.providerError:null};
    try{ console.warn('[video] embedded provider unavailable',JSON.stringify(detail)); }catch{}
    return res.status(503).json(EMBEDDED_VIDEO_UNAVAILABLE);
  }
}
