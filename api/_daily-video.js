// Embedded interview audio/video through Daily (issue #463, ID-98).
//
// Randori never proxies media. This module only (a) makes sure a PRIVATE
// Daily room exists for one canonical primary two-person room and (b) mints a
// short-lived, non-owner meeting token for one authorized participant. The
// browser then loads Daily Prebuilt in a sandboxed iframe. Nothing here is
// persisted in Turso: the room name is derived (HMAC) from the canonical room
// id, and rate-limit counters reuse the existing keyed-hash table.
//
// Recording is deliberately not offered: neither the room nor the token ever
// sets `enable_recording`, `start_cloud_recording`, or a recording UI, so
// Daily's default (recording not set = unavailable) applies.
import { createHmac } from 'node:crypto';

import { clientAddress, rateLimitAddress } from './_client-address.js';

// vercel.json's CSP `frame-src` and Permissions-Policy allow exactly this
// origin. A different DAILY_DOMAIN would load a frame the browser blocks, so
// the capability fails closed instead (see dailyVideoConfiguration).
export const DAILY_FRAME_ORIGIN='https://randori-circle.daily.co';
export const DAILY_API_BASE='https://api.daily.co/v1';
export const DAILY_TOKEN_MAX_TTL_SECONDS=60*60;
export const DAILY_ROOM_TTL_SECONDS=2*60*60;
export const DAILY_PROVIDER_TIMEOUT_MS=5000;
export const DAILY_RATE_WINDOW_SECONDS=15*60;
export const DAILY_RATE_LIMITS=Object.freeze({account:12,address:30});

const API_KEY=/^[A-Za-z0-9._-]{20,256}$/;
const DAILY_DOMAIN=/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.daily\.co$/;
const MEETING_TOKEN=/^[A-Za-z0-9._-]{16,4096}$/;

export class DailyVideoInputError extends Error{
  constructor(message){ super(message); this.name='DailyVideoInputError'; }
}

// Carries only the failing stage and the provider's HTTP status: never the
// request, the response body, the API key, a token or a participant label.
export class DailyProviderError extends Error{
  constructor(stage,status=null){
    super('embedded video provider request failed');
    this.name='DailyProviderError'; this.stage=stage; this.status=status;
  }
}

/**
 * The flag is literal `true` only, and the capability exists only with a
 * well-formed server-only API key and the CSP-allowed Daily domain. The
 * one-command local runtime never enables it, whatever its environment says.
 */
export function dailyVideoConfiguration(env=process.env){
  if(env.DAILY_VIDEO_ENABLED!=='true'||env.RANDORI_LOCAL_RUNTIME==='true') return null;
  const apiKey=String(env.DAILY_API_KEY??'').trim();
  const domain=String(env.DAILY_DOMAIN??'').trim().toLowerCase();
  if(!API_KEY.test(apiKey)||!DAILY_DOMAIN.test(domain)) return null;
  const origin=`https://${domain}`;
  if(origin!==DAILY_FRAME_ORIGIN) return null;
  return Object.freeze({apiKey,domain,origin});
}

export function dailyVideoEnabled(env=process.env){
  return dailyVideoConfiguration(env)!==null;
}

/** Opaque, stable per canonical room; not derivable from week or pair ids. */
export function dailyRoomName(roomId,secret){
  if(typeof secret!=='string'||secret.length<16) throw new TypeError('room-name secret is unavailable');
  const digest=createHmac('sha256',secret).update(`randori-daily-room-v1\0${roomId}`,'utf8').digest('hex');
  return `rc-${digest.slice(0,32)}`;
}

function exactKeys(value,expected){
  if(!value||typeof value!=='object'||Array.isArray(value)) return false;
  const actual=Object.keys(value).sort();
  return actual.length===expected.length&&actual.every((key,index)=>key===expected[index]);
}

export function parseEmbeddedRoomRequest(req,parseRoom){
  const search=new URL(req.url||'/','http://localhost').searchParams;
  const queryKeys=new Set([...search.keys(),...Object.keys(req.query||{})]);
  for(const key of queryKeys){
    const value=req.query?.[key]??search.get(key);
    if(key!=='endpoint'||Array.isArray(value)||search.getAll(key).length>1||value!=='room'){
      throw new DailyVideoInputError('unsupported query parameter');
    }
  }
  const body=req.body;
  if(!exactKeys(body,['camera','microphone','room_id'])
    ||typeof body.camera!=='boolean'||typeof body.microphone!=='boolean'){
    throw new DailyVideoInputError('room_id, camera and microphone are required');
  }
  const room=parseRoom(body.room_id);
  if(!room) throw new DailyVideoInputError('canonical room_id required');
  return Object.freeze({...room,camera:body.camera,microphone:body.microphone});
}

/**
 * Two fixed windows (account and client network). Keys are secret-keyed
 * hashes in the existing `auth_rate_limits` table, so nothing linkable to the
 * member is stored and no migration is needed.
 */
export async function enforceDailyVideoRateLimit(db,{req,userId,secret,nowSeconds=Math.floor(Date.now()/1000)}){
  const bucket=Math.floor(nowSeconds/DAILY_RATE_WINDOW_SECONDS);
  const dimensions=[
    ['account',String(userId),DAILY_RATE_LIMITS.account],
    ['address',rateLimitAddress(clientAddress(req)),DAILY_RATE_LIMITS.address],
  ];
  for(const [dimension,value,limit] of dimensions){
    const key=createHmac('sha256',secret)
      .update(`randori-daily-video-rate-v1\0${dimension}\0${value}\0${bucket}`,'utf8').digest('hex');
    const result=await db.execute({
      sql:`INSERT INTO auth_rate_limits (key, attempts, expires_at) VALUES (?,1,?)
        ON CONFLICT(key) DO UPDATE SET attempts=attempts+1 RETURNING attempts`,
      args:[key,(bucket+1)*DAILY_RATE_WINDOW_SECONDS],
    });
    if(Number(result.rows[0].attempts)>limit) return false;
  }
  return true;
}

/**
 * Token lifetime from the database clock. An interview room's token never
 * outlives the time left on its shared timer (running or paused); any other
 * primary room is capped at one hour. Zero means the session has no time left.
 */
export function dailyGrantWindow({databaseNow,state}){
  const nowMs=Date.parse(databaseNow);
  if(!Number.isFinite(nowMs)) throw new TypeError('database clock is invalid');
  const nowSeconds=Math.floor(nowMs/1000);
  let ttl=DAILY_TOKEN_MAX_TTL_SECONDS;
  if(state?.interview_mode===true){
    const remaining=Number(state.remaining_ms);
    ttl=Math.min(ttl,Number.isSafeInteger(remaining)&&remaining>0?Math.floor(remaining/1000):0);
  }
  return Object.freeze({nowSeconds,ttlSeconds:Math.max(0,ttl),expiresAt:nowSeconds+Math.max(0,ttl)});
}

export function dailyRoomProperties({nowSeconds}){
  return {
    exp:nowSeconds+DAILY_ROOM_TTL_SECONDS,
    eject_at_room_exp:true,
    max_participants:2,
    enable_prejoin_ui:false,
    enable_knocking:false,
    enable_chat:false,
    enable_screenshare:false,
    enable_live_captions_ui:false,
  };
}

// Labels only the participant's current interview role: no display name,
// email, account id or Randori room id ever reaches the provider.
export function dailyParticipantLabel(state){
  return state?.viewer_role==='candidate'?'Candidate':'Interviewer';
}

export function dailyMeetingTokenProperties({roomName,expiresAt,label,camera,microphone}){
  return {
    room_name:roomName,
    exp:expiresAt,
    is_owner:false,
    user_name:label,
    eject_at_token_exp:true,
    enable_prejoin_ui:false,
    enable_screenshare:false,
    enable_recording_ui:false,
    start_video_off:camera!==true,
    start_audio_off:microphone!==true,
  };
}

async function dailyRequest(config,{method,path,body,stage,fetchImpl}){
  let response;
  try{
    response=await fetchImpl(`${DAILY_API_BASE}${path}`,{
      method,
      headers:{authorization:`Bearer ${config.apiKey}`,'content-type':'application/json',accept:'application/json'},
      body:JSON.stringify(body),
      redirect:'error',
      signal:AbortSignal.timeout(DAILY_PROVIDER_TIMEOUT_MS),
    });
  }catch{ throw new DailyProviderError(stage,null); }
  let payload=null;
  try{ payload=await response.json(); }catch{}
  return {status:response.status,payload};
}

function privateRoom(payload,name){
  return payload?.name===name&&payload?.privacy==='private';
}

async function ensureDailyRoom(config,{name,properties,fetchImpl}){
  const update=()=>dailyRequest(config,{
    method:'POST',path:`/rooms/${name}`,body:{privacy:'private',properties},stage:'room-update',fetchImpl,
  });
  const first=await update();
  if(first.status===200&&privateRoom(first.payload,name)) return;
  if(first.status!==404) throw new DailyProviderError('room-update',first.status);
  const created=await dailyRequest(config,{
    method:'POST',path:'/rooms',body:{name,privacy:'private',properties},stage:'room-create',fetchImpl,
  });
  if(created.status===200&&privateRoom(created.payload,name)) return;
  if(created.status===400){
    // The partner may have created the room in between; update it once.
    const retried=await update();
    if(retried.status===200&&privateRoom(retried.payload,name)) return;
    throw new DailyProviderError('room-update',retried.status);
  }
  throw new DailyProviderError('room-create',created.status);
}

/** Returns {roomUrl, token, expiresAt}; throws DailyProviderError. */
export async function mintDailyRoomGrant(config,{roomId,secret,window,label,camera,microphone,fetchImpl=globalThis.fetch}){
  if(!config||!(window?.ttlSeconds>0)) throw new DailyProviderError('configuration',null);
  const name=dailyRoomName(roomId,secret);
  await ensureDailyRoom(config,{name,properties:dailyRoomProperties(window),fetchImpl});
  const minted=await dailyRequest(config,{
    method:'POST',path:'/meeting-tokens',stage:'token',fetchImpl,
    body:{properties:dailyMeetingTokenProperties({
      roomName:name,expiresAt:window.expiresAt,label,camera,microphone,
    })},
  });
  const token=minted.payload?.token;
  if(minted.status!==200||typeof token!=='string'||!MEETING_TOKEN.test(token)){
    throw new DailyProviderError('token',minted.status);
  }
  return Object.freeze({
    roomUrl:`${config.origin}/${name}`,token,
    expiresAt:new Date(window.expiresAt*1000).toISOString(),
  });
}
