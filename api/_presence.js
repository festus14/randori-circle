import { createHmac } from 'node:crypto';

import { parseCodeDocumentQuery } from './_code-document.js';

// #462 / ID-100: room presence. Live cursors ride the private realtime relay
// as Yjs awareness and are never sent here. This module only backs the
// coarse "partner online" fallback with one TTL row per (room, participant)
// in the existing auth_rate_limits table: no migration, no request DDL, no
// cursor/selection data, and no raw account or room identifier at rest.
export const PRESENCE_TTL_SECONDS=20;
export const PRESENCE_INTERVAL_SECONDS=5;
export const PRESENCE_MIN_WRITE_SECONDS=4;
export const PRESENCE_CLEANUP_PROBABILITY=0.02;
const DB_NOW="CAST(strftime('%s','now') AS INTEGER)";
let cached=null;

// Literal-`true` flag plus a usable app secret. Never probes a provider.
export function presenceConfiguration(env=process.env){
  if(env.PRESENCE_ENABLED!=='true') return null;
  const secret=env.JWT_SECRET;
  if(typeof secret!=='string'||Buffer.byteLength(secret,'utf8')<32) return null;
  if(cached?.secret===secret) return cached.config;
  // Domain-separated from session signing and every other keyed counter.
  const config=Object.freeze({key:createHmac('sha256',secret).update('randori-presence-key-v1').digest()});
  cached={secret,config};
  return config;
}

export function parsePresenceRequest(body){
  const keys=['room_id','question_slug','question_version','language','state'];
  if(!body||typeof body!=='object'||Array.isArray(body)||Object.keys(body).length!==keys.length
    ||keys.some(key=>!Object.hasOwn(body,key))||!['join','online','leave'].includes(body.state)) return null;
  try{
    const {state,...query}=body;
    return {state,identity:parseCodeDocumentQuery({query})};
  }catch{ return null; }
}

export function presenceKey(config,roomId,userId){
  return createHmac('sha256',config.key).update(`randori-presence-v1\0${roomId}\0${userId}`).digest('hex');
}

// One upsert (skipped while the row was renewed under four seconds ago, so a
// fast or hostile client cannot amplify writes) and one keyed read, both on
// the database clock so serverless instances never disagree about expiry.
export async function recordPresence(db,config,{roomId,viewerId,partnerId,random=Math.random}){
  await db.execute({
    sql:`INSERT INTO auth_rate_limits (key,attempts,expires_at) VALUES (?,1,${DB_NOW}+?)
      ON CONFLICT(key) DO UPDATE SET attempts=1,expires_at=excluded.expires_at
      WHERE auth_rate_limits.expires_at<=excluded.expires_at-?`,
    args:[presenceKey(config,roomId,viewerId),PRESENCE_TTL_SECONDS,PRESENCE_MIN_WRITE_SECONDS],
  });
  const partner=await db.execute({
    sql:`SELECT 1 AS online FROM auth_rate_limits WHERE key=? AND expires_at>${DB_NOW} LIMIT 1`,
    args:[presenceKey(config,roomId,partnerId)],
  });
  if(random()<PRESENCE_CLEANUP_PROBABILITY){
    // Opportunistic, like the existing auth/invitation limiters: expired rows
    // are already ignored by every reader, so cleanup failure is harmless.
    try{ await db.execute(`DELETE FROM auth_rate_limits WHERE expires_at<=${DB_NOW}`); }catch{}
  }
  return {partnerOnline:partner.rows?.length===1};
}

// Join only: the same partner display name/colour /api/my-pair already shows
// this viewer, so a direct /join link can label the partner. Never email.
export async function readPartnerProfile(db,partnerId){
  const result=await db.execute({sql:'SELECT display_name,color FROM auth_accounts WHERE id=? LIMIT 1',args:[partnerId]});
  const row=result.rows?.[0];
  const name=typeof row?.display_name==='string'?row.display_name.replace(/\s+/g,' ').trim().slice(0,60):'';
  if(!name) return null;
  return {display_name:name,color:/^#[0-9a-fA-F]{6}$/.test(String(row.color||''))?row.color:null};
}

export async function clearPresence(db,config,{roomId,viewerId}){
  await db.execute({sql:'DELETE FROM auth_rate_limits WHERE key=?',args:[presenceKey(config,roomId,viewerId)]});
}
