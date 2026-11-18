import { createHash, createHmac, createPrivateKey, createPublicKey, sign, verify } from 'node:crypto';

import { interviewTimerEnded } from './_session-controls.js';
import { candidateRelayFence, interviewOpenFence, readInterviewGate, resolveInterviewMode } from './_interview-session.js';
import { authPairAccessArgs } from './_pair-access.js';
import { codeDocumentAccessSql, CODE_DOCUMENT_RETENTION_DAYS, parseCodeDocumentQuery } from './_code-document.js';

export const RELAY_TOKEN_TTL_SECONDS=300;
// Interview lobby mode (#464): the candidate's token is short-lived and is
// re-checked against the lobby and edit lock on every renewal.
export const RELAY_CANDIDATE_TOKEN_TTL_SECONDS=90;
export const RELAY_TOKEN_LIMIT=12;
export const RELAY_TOKEN_WINDOW_SECONDS=300;
export const RELAY_SESSION_MARGIN_SECONDS=30;
export class RelaySessionExpiredError extends Error{
  constructor(){ super('expired or expiring relay session'); this.name='RelaySessionExpiredError'; }
}
const KID=/^[A-Za-z0-9_-]{1,128}$/;
let cached=null;

// This validates local configuration only; never probes a provider or returns a
// secret to capability discovery. The publishable key is deliberately NOT a
// service-role/secret key. JWTs are minted separately for each private channel.
export function realtimeRelayConfiguration(env=process.env){
  if(env.REALTIME_RELAY_ENABLED!=='true'||env.RANDORI_LOCAL_RUNTIME==='true') return null;
  const values=[env.SUPABASE_URL,env.SUPABASE_PUBLISHABLE_KEY,env.SUPABASE_REALTIME_SIGNING_JWK,env.SUPABASE_REALTIME_SIGNING_KID,env.JWT_SECRET];
  if(cached&&values.every((value,index)=>value===cached.values[index])) return cached.config;
  try{
    const [rawUrl,publishableKey,rawJwk,kid,appSecret]=values;
    if(typeof appSecret!=='string'||Buffer.byteLength(appSecret,'utf8')<32) return null;
    const url=new URL(rawUrl);
    if(url.protocol!=='https:'||!/^([a-z0-9-]+)\.supabase\.co$/.test(url.hostname)
      ||url.port||url.username||url.password||url.pathname!=='/'||url.search||url.hash
      ||typeof publishableKey!=='string'||!/^sb_publishable_[A-Za-z0-9_-]{16,256}$/.test(publishableKey)
      ||typeof kid!=='string'||!KID.test(kid)||typeof rawJwk!=='string'||rawJwk.length>4096) return null;
    const jwk=JSON.parse(rawJwk);
    if(jwk?.kty!=='EC'||jwk.crv!=='P-256'||(jwk.alg!==undefined&&jwk.alg!=='ES256')
      ||(jwk.use!==undefined&&jwk.use!=='sig')||(jwk.kid!==undefined&&jwk.kid!==kid)
      ||!['x','y','d'].every(key=>typeof jwk[key]==='string'&&/^[A-Za-z0-9_-]{43}$/.test(jwk[key])
        &&Buffer.from(jwk[key],'base64url').toString('base64url')===jwk[key])) return null;
    const privateKey=createPrivateKey({key:jwk,format:'jwk'});
    const publicKey=createPublicKey({key:{kty:'EC',crv:'P-256',x:jwk.x,y:jwk.y},format:'jwk'});
    const probe=Buffer.from('randori-realtime-key-check-v1');
    if(!verify('sha256',probe,{key:publicKey,dsaEncoding:'ieee-p1363'},
      sign('sha256',probe,{key:privateKey,dsaEncoding:'ieee-p1363'}))) return null;
    // Independent, domain-separated keys from the existing app secret: never
    // use the ECDSA scalar for HMAC, and never reset quota on provider-key rotation.
    const derive=label=>createHmac('sha256',appSecret).update(label).digest();
    const config=Object.freeze({url:url.origin,publishableKey,kid,privateKey,
      subjectKey:derive('randori-relay-sub-key-v1'),rateKey:derive('randori-relay-rate-key-v1')});
    cached={values,config};
    return config;
  }catch{ return null; }
}

export function parseRelayTokenRequest(body){
  const keys=['room_id','question_slug','question_version','language'];
  if(!body||typeof body!=='object'||Array.isArray(body)||Object.keys(body).length!==keys.length
    ||keys.some(key=>!Object.hasOwn(body,key))) return null;
  try{ return parseCodeDocumentQuery({query:body}); }catch{ return null; }
}

// Reuse the HTTPS document's source-tagged authority, then require its stored
// participant snapshot to still equal the live pair. This is SELECT-only and
// never creates/hydrates a document or writes a workspace as a side effect.
export async function readRelayAuthorization(db,{viewerId,mode=null,...identity}){
  const resolved=mode||await resolveInterviewMode(db);
  const open=interviewOpenFence(resolved,identity);
  const candidate=candidateRelayFence(resolved,{weekId:identity.weekId,pairGroupId:identity.pairGroupId,actorId:viewerId});
  const result=await db.execute({
    sql:`WITH access AS (${codeDocumentAccessSql()})
      SELECT access.week_id,access.pair_group_id,access.user_a_id,access.user_b_id
      FROM access JOIN pair_code_documents document
        ON document.week_id=access.week_id AND document.pair_group_id=access.pair_group_id
       AND document.pair_user_a_id=access.user_a_id AND document.pair_user_a_source='auth'
       AND document.pair_user_b_id=access.user_b_id AND document.pair_user_b_source='auth'
       AND document.pair_user_c_id IS NULL
      WHERE document.question_slug=? AND document.question_version=? AND document.language=?
        AND document.updated_at >= strftime('%Y-%m-%dT%H:%M:%fZ','now','-${CODE_DOCUMENT_RETENTION_DAYS} days')
        AND (SELECT COUNT(*) FROM session_completion_receipts receipt
          WHERE receipt.week_id=access.week_id AND receipt.pair_group_id=access.pair_group_id
            AND receipt.participant_source='auth'
            AND receipt.user_id IN (access.user_a_id,access.user_b_id)) < 2
        AND ${open.sql} AND ${candidate.sql}
      LIMIT 2`,
    args:[...authPairAccessArgs({userId:viewerId,weekId:identity.weekId,pairGroupId:identity.pairGroupId}),
      identity.questionSlug,identity.questionVersion,identity.language,...open.args,...candidate.args],
  });
  if(result.rows?.length!==1) return null;
  const row=result.rows[0];
  const [weekId,pairGroupId,userAId,userBId]=['week_id','pair_group_id','user_a_id','user_b_id'].map(key=>Number(row[key]));
  if(![weekId,pairGroupId,userAId,userBId].every(value=>Number.isSafeInteger(value)&&value>0)
    ||weekId!==identity.weekId||pairGroupId!==identity.pairGroupId||userAId===userBId
    ||![userAId,userBId].includes(viewerId)) return null;
  if(await interviewTimerEnded(db,{weekId,pairGroupId,userAId,userBId},resolved)) return null;
  const gate=await readInterviewGate(db,resolved,identity);
  return gate?{userAId,userBId,role:gate.candidateUserId===viewerId?'candidate':'interviewer'}:{userAId,userBId};
}

export function relayTopic(identity,pair){
  const context=createHash('sha256').update(JSON.stringify([1,identity.roomId,identity.weekId,identity.pairGroupId,
    pair.userAId,'auth',pair.userBId,'auth',identity.questionSlug,identity.questionVersion,identity.language])).digest('hex');
  return `rc-code:v1:${identity.roomId}:${context}`;
}

function opaqueSubject(config,viewerId){
  const bytes=createHmac('sha256',config.subjectKey).update(`randori-relay-sub-v1\0${config.url}\0${viewerId}`).digest().subarray(0,16);
  bytes[6]=(bytes[6]&15)|64; bytes[8]=(bytes[8]&63)|128;
  const hex=bytes.toString('hex');
  return `${hex.slice(0,8)}-${hex.slice(8,12)}-${hex.slice(12,16)}-${hex.slice(16,20)}-${hex.slice(20)}`;
}

export function mintRelayToken(config,{viewerId,identity,pair,nowSeconds=Math.floor(Date.now()/1000),sessionExpiresAt=null}){
  if(!Number.isSafeInteger(viewerId)||viewerId<1||!Number.isSafeInteger(nowSeconds)||nowSeconds<1) throw new TypeError('invalid relay token identity');
  const ttl=pair?.role==='candidate'?RELAY_CANDIDATE_TOKEN_TTL_SECONDS:RELAY_TOKEN_TTL_SECONDS;
  const topic=relayTopic(identity,pair),expiresAt=Math.min(nowSeconds+ttl,
    Number.isSafeInteger(sessionExpiresAt)?sessionExpiresAt:nowSeconds+ttl);
  if(expiresAt<=nowSeconds+RELAY_SESSION_MARGIN_SECONDS) throw new RelaySessionExpiredError();
  const header=Buffer.from(JSON.stringify({alg:'ES256',typ:'JWT',kid:config.kid})).toString('base64url');
  const claims={iss:`${config.url}/auth/v1`,aud:'authenticated',sub:opaqueSubject(config,viewerId),role:'authenticated',
    iat:nowSeconds,exp:expiresAt,room:topic,room_id:identity.roomId,cycle:identity.weekId,
    context:{question_slug:identity.questionSlug,question_version:identity.questionVersion,language:identity.language}};
  const payload=Buffer.from(JSON.stringify(claims)).toString('base64url');
  const input=`${header}.${payload}`;
  const signature=sign('sha256',Buffer.from(input),{key:config.privateKey,dsaEncoding:'ieee-p1363'}).toString('base64url');
  return {token:`${input}.${signature}`,topic,expires_at:expiresAt,url:config.url,publishable_key:config.publishableKey};
}

// Persistent distributed budget, no in-process limiter and no Turso migration.
// One per-account key expires/reset after five minutes; no raw identifier in storage.
export async function consumeRelayTokenBudget(db,config,viewerId,nowSeconds=Math.floor(Date.now()/1000)){
  const key=createHmac('sha256',config.rateKey).update(`randori-relay-rate-v1\0${viewerId}`).digest('hex');
  const result=await db.execute({
    sql:`INSERT INTO auth_rate_limits (key,attempts,expires_at) VALUES (?,1,?)
      ON CONFLICT(key) DO UPDATE SET
        attempts=CASE WHEN auth_rate_limits.expires_at<=? THEN 1 ELSE auth_rate_limits.attempts+1 END,
        expires_at=CASE WHEN auth_rate_limits.expires_at<=? THEN excluded.expires_at ELSE auth_rate_limits.expires_at END
      RETURNING attempts,expires_at`,
    args:[key,nowSeconds+RELAY_TOKEN_WINDOW_SECONDS,nowSeconds,nowSeconds],
  });
  const attempts=Number(result.rows?.[0]?.attempts),expiresAt=Number(result.rows?.[0]?.expires_at);
  if(!Number.isSafeInteger(attempts)||attempts<1||!Number.isSafeInteger(expiresAt)||expiresAt<=nowSeconds) throw new Error('relay budget unavailable');
  return {ok:attempts<=RELAY_TOKEN_LIMIT,retryAfter:Math.max(1,expiresAt-nowSeconds)};
}
