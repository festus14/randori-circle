import { getClient, verifyMutationOrigin, verifyRequestAuth } from './_db.js';
import { canUseLegacySinglePrimaryCircleFeatures, multiCircleControlPlaneEnabled, requestMatchesCircleContext, resolveActiveCircleContext, secondaryCircleWorkspaceEnabled } from './_active-circle.js';
import { resolveInterviewMode } from './_interview-session.js';
import { consumeRelayTokenBudget, mintRelayToken, parseRelayTokenRequest, readRelayAuthorization, realtimeRelayConfiguration, RELAY_SESSION_MARGIN_SECONDS, RelaySessionExpiredError } from './_realtime-relay.js';

const notFound=res=>res.status(404).json({error:'pair not found'});
const legacyWorkspaceAvailable=(db,auth)=>!multiCircleControlPlaneEnabled()
  ||secondaryCircleWorkspaceEnabled()||canUseLegacySinglePrimaryCircleFeatures(db,auth);

// Unlike session bearer APIs, these browser-only endpoints never permit a
// cross-origin read. Force the common origin verifier's cookie branch even if
// the caller sent a bearer or no cookie; auth is checked separately.
export function relayOriginAllowed(req){
  const headers={...req.headers,authorization:'',Authorization:'',cookie:'randori_session=origin-check',Cookie:''};
  const site=String(req.headers?.['sec-fetch-site']||'');
  return !(site&&site!=='same-origin')&&verifyMutationOrigin({...req,headers});
}

// The relay's live-pair authority, shared with presence (#462): one read
// transaction proves legacy availability, primary circle context and then the
// caller-supplied pair read (the exact document snapshot plus the #464
// lobby/lock gate for tokens). Returns null for every denial.
export async function authorizeRelayPair(db,auth,req,{viewerId,...identity},{mode,read=readRelayAuthorization}={}){
  let transaction=await db.transaction('read');
  try{
    // Mirror code-document's legacy availability gate when its workspace
    // router is disabled; a token must never unlock an unavailable document.
    if(!await legacyWorkspaceAvailable(transaction,auth)) return null;
    let context=null;
    if(multiCircleControlPlaneEnabled()){
      context=await resolveActiveCircleContext(transaction,auth);
      if(!context.ok||context.membership?.is_primary!==true||!requestMatchesCircleContext(req,context)) return null;
    }
    const pair=await read(transaction,{viewerId,mode,...identity});
    if(!pair) return null;
    await transaction.commit(); await transaction.close?.(); transaction=null;
    return {pair,context};
  }finally{
    if(transaction){ try{ await transaction.rollback(); }catch{} try{ await transaction.close?.(); }catch{} }
  }
}

export async function handleRelayToken(req,res){
  res.setHeader?.('Cache-Control','private, no-store');
  res.setHeader?.('X-Content-Type-Options','nosniff');
  const config=realtimeRelayConfiguration();
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
    // Match the browser's renewal margin before spending any token quota.
    if(!Number.isSafeInteger(auth.exp)||auth.exp-Math.floor(Date.now()/1000)<=RELAY_SESSION_MARGIN_SECONDS) return notFound(res);
    const identity=parseRelayTokenRequest(req.body);
    if(!identity) return notFound(res);
    // The lobby/lock gate runs in the pair read, before any quota is spent (#464).
    const mode=await resolveInterviewMode(db);
    const access=await authorizeRelayPair(db,auth,req,{viewerId,...identity},{mode});
    if(!access) return notFound(res);
    const {pair,context}=access;
    const budget=await consumeRelayTokenBudget(db,config,viewerId);
    if(!budget.ok){
      res.setHeader?.('Retry-After',String(budget.retryAfter));
      return res.status(429).json({error:'relay token rate limited'});
    }
    // Quota consumption or other awaits can cross a DB-time interview end.
    // Reauthorize at issuance, preserving the same participant snapshot.
    if(!await legacyWorkspaceAvailable(db,auth)) return notFound(res);
    const currentPair=await readRelayAuthorization(db,{viewerId,mode,...identity});
    if(!currentPair||currentPair.userAId!==pair.userAId||currentPair.userBId!==pair.userBId) return notFound(res);
    const relay=mintRelayToken(config,{viewerId,identity,pair:currentPair,sessionExpiresAt:auth.exp});
    return res.json({ok:true,...relay,...(context?{
      circle_context_version:context.context_version,circle_public_id:context.membership.public_id,
    }:{})});
  }catch(error){
    if(error instanceof RelaySessionExpiredError) return notFound(res);
    // No provider response, JWT, private key, subject or raw exception is logged.
    return res.status(503).json({error:'realtime relay unavailable'});
  }
}
