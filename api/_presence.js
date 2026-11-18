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
// Per-account request budget: 12/min at the 5 s cadence, plus join/leave and
// a second tab; a hostile client is capped before any pair read.
export const PRESENCE_BUDGET_LIMIT=30;
export const PRESENCE_BUDGET_WINDOW_SECONDS=60;
// Rare, bounded sweep (auth_rate_limits has no expires_at index): at most
// PRESENCE_SWEEP_LIMIT rows. Partner rows are also deleted key-exactly.
export const PRESENCE_CLEANUP_PROBABILITY=0.005;
export const PRESENCE_SWEEP_LIMIT=32;
const PRIMARY_ROOM=/^week_[1-9]\d*_pair_[1-9]\d*$/;
const DB_NOW="CAST(strftime('%s','now') AS INTEGER)";
let cached=null;

// Literal-`true` flag plus a usable app secret. Never probes a provider.
export function presenceConfiguration(env=process.env){
  if(env.PRESENCE_ENABLED!=='true') return null;
  const secret=env.JWT_SECRET;
  if(typeof secret!=='string'||Buffer.byteLength(secret,'utf8')<32) return null;
  // The derived key depends only on JWT_SECRET (the flag is checked above on
  // every call), so the secret alone is the correct cache identity.
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
    const identity=parseCodeDocumentQuery({query});
    // Presence is primary-room only; `leave` (no pair read) relies on this
    // canonical format too.
    return PRIMARY_ROOM.test(String(identity?.roomId||''))?{state,identity}:null;
  }catch{ return null; }
}

export function presenceKey(config,roomId,userId){
  return createHmac('sha256',config.key).update(`randori-presence-v1\0${roomId}\0${userId}`).digest('hex');
}

// Fixed one-minute window per account in the shared limiter table, on the
// database clock. The key is keyed-hashed; no account id at rest.
export async function consumePresenceBudget(db,config,viewerId){
  const key=createHmac('sha256',config.key).update(`randori-presence-rate-v1\0${viewerId}`).digest('hex');
  const result=await db.execute({
    sql:`INSERT INTO auth_rate_limits (key,attempts,expires_at) VALUES (?,1,${DB_NOW}+?)
      ON CONFLICT(key) DO UPDATE SET
        attempts=CASE WHEN auth_rate_limits.expires_at<=${DB_NOW} THEN 1 ELSE auth_rate_limits.attempts+1 END,
        expires_at=CASE WHEN auth_rate_limits.expires_at<=${DB_NOW} THEN excluded.expires_at ELSE auth_rate_limits.expires_at END
      RETURNING attempts,expires_at,${DB_NOW} AS now`,
    args:[key,PRESENCE_BUDGET_WINDOW_SECONDS],
  });
  const row=result.rows?.[0];
  const [attempts,expiresAt,nowSeconds]=[row?.attempts,row?.expires_at,row?.now].map(Number);
  if(![attempts,expiresAt,nowSeconds].every(Number.isSafeInteger)||attempts<1) throw new Error('presence budget unavailable');
  return {ok:attempts<=PRESENCE_BUDGET_LIMIT,retryAfter:Math.max(1,expiresAt-nowSeconds)};
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
  const partnerKey=presenceKey(config,roomId,partnerId);
  const partner=await db.execute({
    sql:`SELECT expires_at>${DB_NOW} AS online FROM auth_rate_limits WHERE key=? LIMIT 1`,
    args:[partnerKey],
  });
  const row=partner.rows?.[0],partnerOnline=Number(row?.online)===1;
  // Expired rows are already ignored by every reader, so cleanup is only
  // hygiene and its failure is harmless: a key-exact delete of the partner's
  // stale row, and a rare primary-key-bounded sweep of other expired rows.
  if(row&&!partnerOnline){
    try{ await db.execute({sql:`DELETE FROM auth_rate_limits WHERE key=? AND expires_at<=${DB_NOW}`,args:[partnerKey]}); }catch{}
  }
  if(random()<PRESENCE_CLEANUP_PROBABILITY){
    try{
      await db.execute({sql:`DELETE FROM auth_rate_limits WHERE rowid IN
        (SELECT rowid FROM auth_rate_limits WHERE expires_at<=${DB_NOW} LIMIT ?)`,args:[PRESENCE_SWEEP_LIMIT]});
    }catch{}
  }
  return {partnerOnline};
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
