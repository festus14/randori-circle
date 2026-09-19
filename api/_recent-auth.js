export const RECENT_AUTH_MAX_AGE_SECONDS=10*60;

const SESSION_HASH_PATTERN=/^[a-f0-9]{64}$/;
const RECENT_AUTH_METHODS=new Set(['password','google']);

function validUserId(value){
  const number=Number(value);
  return Number.isSafeInteger(number)&&number>0?number:null;
}

function validNow(value){
  return Number.isSafeInteger(value)&&value>0?value:null;
}

export async function recordRecentAuth(db,{sessionHash,userId,method,nowSeconds=Math.floor(Date.now()/1000)}={}){
  if(!db||typeof db.execute!=='function'||!SESSION_HASH_PATTERN.test(String(sessionHash||''))
    ||!validUserId(userId)||!RECENT_AUTH_METHODS.has(method)||!validNow(nowSeconds)){
    throw new TypeError('valid recent authentication evidence is required');
  }
  const result=await db.execute({
    sql:`INSERT INTO auth_recent_proofs (session_hash,user_id,authenticated_at,method)
      SELECT session_hash,user_id,?,? FROM auth_sessions
      WHERE session_hash=? AND user_id=? AND revoked_at IS NULL AND expires_at>?
      ON CONFLICT(session_hash) DO UPDATE SET
        authenticated_at=excluded.authenticated_at,method=excluded.method
      WHERE auth_recent_proofs.user_id=excluded.user_id
      RETURNING session_hash,user_id,authenticated_at,method`,
    args:[nowSeconds,method,sessionHash,validUserId(userId),nowSeconds],
  });
  const row=result.rows?.[0];
  if(result.rows?.length!==1||String(row.session_hash)!==sessionHash
    ||Number(row.user_id)!==validUserId(userId)) throw new Error('recent authentication persistence failed');
  return Object.freeze({authenticatedAt:Number(row.authenticated_at),method:String(row.method)});
}

export async function readRecentAuth(db,payload,{
  nowSeconds=Math.floor(Date.now()/1000),maxAgeSeconds=RECENT_AUTH_MAX_AGE_SECONDS,
}={}){
  const userId=validUserId(payload?.id??payload?.uid);
  const sessionHash=String(payload?.sessionHash||'');
  if(!db||typeof db.execute!=='function'||!userId||!SESSION_HASH_PATTERN.test(sessionHash)
    ||!validNow(nowSeconds)||!Number.isSafeInteger(maxAgeSeconds)||maxAgeSeconds<1||maxAgeSeconds>60*60){
    return Object.freeze({ok:false,reason:'invalid_session'});
  }
  const result=await db.execute({
    sql:`SELECT proof.authenticated_at,proof.method
      FROM auth_recent_proofs proof JOIN auth_sessions session
        ON session.session_hash=proof.session_hash AND session.user_id=proof.user_id
      WHERE proof.session_hash=? AND proof.user_id=?
        AND session.revoked_at IS NULL AND session.expires_at>?
        AND proof.authenticated_at>? AND proof.authenticated_at<=?
      LIMIT 2`,
    args:[sessionHash,userId,nowSeconds,nowSeconds-maxAgeSeconds,nowSeconds],
  });
  if(result.rows?.length!==1) return Object.freeze({ok:false,reason:'recent_auth_required'});
  const method=String(result.rows[0].method||'');
  if(!RECENT_AUTH_METHODS.has(method)) return Object.freeze({ok:false,reason:'recent_auth_required'});
  return Object.freeze({ok:true,method,authenticatedAt:Number(result.rows[0].authenticated_at),
    expiresAt:Number(result.rows[0].authenticated_at)+maxAgeSeconds});
}

export async function requireRecentAuth(db,payload,options={}){
  const result=await readRecentAuth(db,payload,options);
  if(result.ok) return result;
  const error=new Error('recent authentication required');
  error.code='RECENT_AUTH_REQUIRED';
  error.statusCode=403;
  throw error;
}
