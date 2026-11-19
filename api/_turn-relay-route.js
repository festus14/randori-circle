// POST /api/video/turn handler (issue #305, ID-107). Loaded by api/video.js
// only while the TURN relay is configured, so the signalling route keeps its
// exact import graph and behaviour when TURN_RELAY_ENABLED is off.
import { getClient, getJwtSecret, verifyRequestAuth } from './_db.js';
import { ensureDataSessionControlsReadiness } from './_data-readiness.js';
import { getAuthenticatedPairAccess } from './_pair-access.js';
import { parseCanonicalRoomPath } from './_pairing.js';
import { readAuthorizedSessionControls } from './_session-controls.js';
import { TurnBudgetError, releaseTurnReservation, reserveTurnRelay } from './_turn-budget.js';
import {
  TurnProviderError,
  enforceTurnRelayRateLimit,
  mintTurnIceServers,
  parseTurnRelayRequest,
  turnGrantWindow,
} from './_turn-relay.js';

export const TURN_RELAY_UNAVAILABLE=Object.freeze({error:'call relay unavailable',code:'turn_relay_unavailable'});

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

// The interview timer, when the room is an exact human pair with session
// controls; null for any other room the signalling route admits.
async function readCallState(db,{userId,room,versionKey}){
  const transaction=await db.transaction('read');
  let finished=false;
  try{
    const read=await readAuthorizedSessionControls(transaction,{
      viewerId:userId,weekId:room.weekId,pairGroupId:room.pairGroupId,versionKey,
    });
    await transaction.commit(); finished=true;
    return read?.state||null;
  }catch(error){
    if(!finished){ try{ await transaction.rollback(); }catch{} }
    throw error;
  }finally{ try{ await transaction.close(); }catch{} }
}

// Authorization is the direct call's own signalling check (source-tagged
// pair membership, plus active primary membership while circle membership
// is on). Every refusal of a room the viewer does not occupy is the
// identical 404 projection.
export async function handleTurnRelay(req,res,config){
  res.setHeader('Cache-Control','private, no-store');
  if(req.method!=='POST'){
    res.setHeader('Allow','POST');
    return res.status(405).json({error:'POST only'});
  }
  const userId=authenticatedUserId(await verifyRequestAuth(req));
  if(!userId) return res.status(401).json({error:'authentication required'});
  let room;
  // parseTurnRelayRequest throws only TurnRelayInputError.
  try{ room=parseTurnRelayRequest(req,parseCanonicalRoomId); }
  catch(error){ return res.status(400).json({error:error.message}); }
  let db,secret;
  try{
    db=req.workspace?.db||getClient(); await ensureDataSessionControlsReadiness(db); secret=getJwtSecret();
  }catch{ return res.status(503).json(TURN_RELAY_UNAVAILABLE); }
  try{
    const rate=await enforceTurnRelayRateLimit(db,{req,userId,secret});
    if(!rate.allowed){
      res.setHeader('Retry-After',String(rate.retryAfter));
      return res.status(429).json({error:'too many call relay requests; try again later',code:'turn_relay_rate_limited'});
    }
  }catch{ return res.status(503).json(TURN_RELAY_UNAVAILABLE); }
  let state;
  try{
    if(!await getAuthenticatedPairAccess(db,{userId,weekId:room.weekId,pairGroupId:room.pairGroupId})){
      return res.status(404).json({error:'pair not found'});
    }
    state=await readCallState(db,{userId,room,versionKey:secret});
  }catch{ return res.status(503).json(TURN_RELAY_UNAVAILABLE); }
  const window=turnGrantWindow({state});
  if(state?.terminal||window.ttlSeconds<1){
    const interview=state?.interview_mode===true&&state.end_reason!=='completed';
    return res.status(409).json({
      error:interview?'interview has ended':'session has been completed',
      code:interview?'interview_session_ended':'session_completed',
    });
  }
  // Cloudflare first, then the Metered backup, each only within its own
  // monthly budget. Stage, provider and HTTP status are logged; never a key,
  // token, credential or response body.
  let paused=0;
  for(const provider of config.providers){
    let reservation=null;
    try{
      reservation=await reserveTurnRelay(db,provider,{ttlSeconds:window.ttlSeconds,expiresAtMs:window.expiresAtMs,fetchImpl:globalThis.fetch});
      const grant=await mintTurnIceServers(provider,{window,fetchImpl:globalThis.fetch});
      return res.json({iceServers:grant.iceServers,expiresAt:grant.expiresAt,relay:grant.relay});
    }catch(error){
      if(reservation) await releaseTurnReservation(db,reservation);
      const budget=error instanceof TurnBudgetError, known=error instanceof TurnProviderError;
      if(budget&&error.reason==='budget_reached') paused+=1;
      const detail={provider:provider.provider,stage:budget?'budget':known?error.stage:'unexpected',
        status:known?error.status:null,reason:budget?error.reason:null};
      try{ console.warn('[video] turn relay unavailable',JSON.stringify(detail)); }catch{}
    }
  }
  // Every relay is over its free allowance: an expected state, not a fault.
  // The call proceeds STUN-only, exactly as without a relay.
  if(paused===config.providers.length){
    return res.json({iceServers:[],expiresAt:null,relay:'none',reason:'budget_reached'});
  }
  return res.status(503).json(TURN_RELAY_UNAVAILABLE);
}
