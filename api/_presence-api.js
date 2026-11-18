import { getClient, verifyRequestAuth } from './_db.js';
import { clearPresence, parsePresenceRequest, presenceConfiguration, PRESENCE_INTERVAL_SECONDS,
  PRESENCE_TTL_SECONDS, readPartnerProfile, recordPresence } from './_presence.js';
import { authorizeRelayPair, relayOriginAllowed } from './_realtime-relay-api.js';

const notFound=res=>res.status(404).json({error:'pair not found'});

// POST /api/code-document/presence (#462 / ID-100). Same origin, session and
// live-pair authority as the relay token; grouped in the existing function.
// The body carries no cursor, selection, name or free text, and nothing about
// the request or its outcome is logged.
export async function handlePresence(req,res){
  res.setHeader?.('Cache-Control','private, no-store');
  res.setHeader?.('X-Content-Type-Options','nosniff');
  const config=presenceConfiguration();
  if(!config) return notFound(res);
  if(req.method!=='POST'){
    res.setHeader?.('Allow','POST');
    return res.status(405).json({error:'POST only'});
  }
  if(!relayOriginAllowed(req)) return res.status(403).json({error:'cross-origin mutation rejected'});
  try{
    const db=getClient(),auth=await verifyRequestAuth(req,db);
    const viewerId=Number(auth?.id||auth?.uid);
    if(!Number.isSafeInteger(viewerId)||viewerId<1) return res.status(401).json({error:'authentication required'});
    const request=parsePresenceRequest(req.body);
    if(!request) return notFound(res);
    const roomId=request.identity.roomId;
    // Leaving only deletes the caller's own keyed row, so it needs no pair
    // read and still succeeds after a terminal interview state.
    if(request.state==='leave'){ await clearPresence(db,config,{roomId,viewerId}); return res.json({ok:true}); }
    const access=await authorizeRelayPair(db,auth,req,{viewerId,...request.identity});
    if(!access) return notFound(res);
    const {userAId,userBId}=access.pair;
    const seat=viewerId===userAId?'a':'b';
    const partnerId=seat==='a'?userBId:userAId;
    const {partnerOnline}=await recordPresence(db,config,{roomId,viewerId,partnerId});
    const partner=request.state==='join'?await readPartnerProfile(db,partnerId):null;
    return res.json({ok:true,seat,partner_online:partnerOnline,
      ttl_seconds:PRESENCE_TTL_SECONDS,interval_seconds:PRESENCE_INTERVAL_SECONDS,...(partner?{partner}:{})});
  }catch{
    return res.status(503).json({error:'presence unavailable'});
  }
}
