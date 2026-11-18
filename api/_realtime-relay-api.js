import { getClient, verifyMutationOrigin, verifyRequestAuth } from './_db.js';
import { multiCircleControlPlaneEnabled, requestMatchesCircleContext, resolveActiveCircleContext } from './_active-circle.js';
import { consumeRelayTokenBudget, mintRelayToken, parseRelayTokenRequest, readRelayAuthorization, realtimeRelayConfiguration } from './_realtime-relay.js';

const notFound=res=>res.status(404).json({error:'pair not found'});

export async function handleRelayToken(req,res){
  res.setHeader?.('Cache-Control','private, no-store');
  res.setHeader?.('X-Content-Type-Options','nosniff');
  const config=realtimeRelayConfiguration();
  if(!config) return notFound(res);
  if(req.method!=='POST'){
    res.setHeader?.('Allow','POST');
    return res.status(405).json({error:'POST only'});
  }
  // Unlike session bearer APIs, this browser-only endpoint never permits a
  // cross-origin token read. Force the common origin verifier's cookie branch
  // even if the caller sent a bearer or no cookie; auth is checked separately.
  const headers={...req.headers,authorization:'',Authorization:'',cookie:'randori_session=origin-check',Cookie:''};
  const site=String(req.headers?.['sec-fetch-site']||'');
  if((site&&site!=='same-origin')||!verifyMutationOrigin({...req,headers})){
    return res.status(403).json({error:'cross-origin mutation rejected'});
  }
  let transaction;
  try{
    const db=getClient(),auth=await verifyRequestAuth(req,db);
    const viewerId=Number(auth?.id||auth?.uid);
    if(!Number.isSafeInteger(viewerId)||viewerId<1) return res.status(401).json({error:'authentication required'});
    const identity=parseRelayTokenRequest(req.body);
    if(!identity) return notFound(res);
    transaction=await db.transaction('read');
    let context=null;
    if(multiCircleControlPlaneEnabled()){
      context=await resolveActiveCircleContext(transaction,auth);
      if(!context.ok||context.membership?.is_primary!==true||!requestMatchesCircleContext(req,context)) return notFound(res);
    }
    const pair=await readRelayAuthorization(transaction,{viewerId,...identity});
    if(!pair) return notFound(res);
    await transaction.commit(); await transaction.close?.(); transaction=null;
    const budget=await consumeRelayTokenBudget(db,config,viewerId);
    if(!budget.ok){
      res.setHeader?.('Retry-After',String(budget.retryAfter));
      return res.status(429).json({error:'relay token rate limited'});
    }
    // Quota consumption or other awaits can cross a DB-time interview end.
    // Reauthorize at issuance, preserving the same participant snapshot.
    const currentPair=await readRelayAuthorization(db,{viewerId,...identity});
    if(!currentPair||currentPair.userAId!==pair.userAId||currentPair.userBId!==pair.userBId) return notFound(res);
    const relay=mintRelayToken(config,{viewerId,identity,pair,sessionExpiresAt:auth.exp});
    return res.json({ok:true,...relay,...(context?{
      circle_context_version:context.context_version,circle_public_id:context.membership.public_id,
    }:{})});
  }catch{
    // No provider response, JWT, private key, subject or raw exception is logged.
    return res.status(503).json({error:'realtime relay unavailable'});
  }finally{
    if(transaction){ try{ await transaction.rollback(); }catch{} try{ await transaction.close?.(); }catch{} }
  }
}
