import { createHmac } from 'node:crypto';

// Shared fixed-window limiter over the auth_rate_limits table. Each key is a
// secret-keyed HMAC of `${label}\0${dimension}\0${value}\0${bucket}`, so the
// table never holds anything linkable to a member or an address. Dimensions
// are consumed in order and the first exhausted one stops evaluation, so
// later counters are untouched. Used by product feedback (ID-91) and
// embedded video (ID-98).
export async function consumeKeyedRateLimits(db,{label,secret,dimensions,nowSeconds}){
  if(!db||typeof db.execute!=='function') throw new TypeError('database client is required');
  if(typeof label!=='string'||!label) throw new TypeError('rate limit label is required');
  if(typeof secret!=='string'||!secret) throw new TypeError('rate limit secret is required');
  if(!Number.isSafeInteger(nowSeconds)||nowSeconds<1) throw new TypeError('valid time is required');
  for(const [dimension,value,{limit,windowSeconds}] of dimensions){
    const bucket=Math.floor(nowSeconds/windowSeconds);
    const expiresAt=(bucket+1)*windowSeconds;
    const key=createHmac('sha256',secret)
      .update(`${label}\0${dimension}\0${value}\0${bucket}`,'utf8').digest('hex');
    const result=await db.execute({
      sql:`INSERT INTO auth_rate_limits (key,attempts,expires_at) VALUES (?,1,?)
        ON CONFLICT(key) DO UPDATE SET attempts=auth_rate_limits.attempts+1
        RETURNING attempts`,
      args:[key,expiresAt],
    });
    const attempts=Number(result.rows?.[0]?.attempts);
    if(!Number.isSafeInteger(attempts)||attempts<1) throw new Error('invalid rate limit state');
    if(attempts>limit){
      return Object.freeze({allowed:false,dimension,retryAfter:Math.max(1,expiresAt-nowSeconds)});
    }
  }
  return Object.freeze({allowed:true,dimension:null,retryAfter:0});
}
