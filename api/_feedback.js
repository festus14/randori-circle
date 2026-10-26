import { createHmac, randomUUID } from 'node:crypto';

import { getJwtSecret } from './_db.js';
import { rateLimitAddress } from './_client-address.js';
import { redactLogText, redactLogValue } from './_client-log-policy.js';
import { outboxStatementIdentity } from './_outbox-identity.js';
import {
  FEEDBACK_BODY_MAX,
  FEEDBACK_LIST_DEFAULT_LIMIT,
  FEEDBACK_LIST_MAX_LIMIT,
  FEEDBACK_RATE_LIMITS,
  FEEDBACK_TITLE_MAX,
  decodeFeedbackCursor,
  diagnosticsKeySafe,
  encodeFeedbackCursor,
  feedbackIsoSeconds,
  feedbackNow,
} from './_feedback-config.js';
import {
  FEEDBACK_SUBMITTED_EVENT_TYPE,
  createFeedbackSubmittedEvent,
} from './_feedback-notification.js';

export { FEEDBACK_SUBMITTED_EVENT_TYPE };

export class FeedbackInputError extends Error{
  constructor(message){
    super(message);
    this.name='FeedbackInputError';
  }
}

export class FeedbackConflictError extends Error{
  constructor(){
    super('The idempotency key was already used for different feedback.');
    this.name='FeedbackConflictError';
  }
}

function rateLimitKey(dimension,value,bucket){
  return createHmac('sha256',getJwtSecret())
    .update(`randori-feedback-rate-v1\0${dimension}\0${value}\0${bucket}`,'utf8').digest('hex');
}

/**
 * Consume the submission budget in the shared auth_rate_limits table: per
 * member, then per client address (IPv6 keyed by /64), each over a rolling
 * hour and a rolling day. The first exhausted dimension stops evaluation
 * so later counters are untouched. Callers run validation first, so a
 * 400 never spends budget.
 */
export async function consumeFeedbackRateLimits(db,{userId,ip,nowSeconds=Math.floor(Date.now()/1000)}={}){
  if(!db||typeof db.execute!=='function') throw new TypeError('database client is required');
  const user=Number(userId);
  if(!Number.isSafeInteger(user)||user<1) throw new TypeError('valid user id is required');
  if(!Number.isSafeInteger(nowSeconds)||nowSeconds<1) throw new TypeError('valid time is required');
  const dimensions=[
    ['user-hour',String(user),FEEDBACK_RATE_LIMITS.userHour],
    ['user-day',String(user),FEEDBACK_RATE_LIMITS.userDay],
    ['ip-hour',rateLimitAddress(ip),FEEDBACK_RATE_LIMITS.ipHour],
    ['ip-day',rateLimitAddress(ip),FEEDBACK_RATE_LIMITS.ipDay],
  ];
  for(const [dimension,value,{limit,windowSeconds}] of dimensions){
    const bucket=Math.floor(nowSeconds/windowSeconds);
    const expiresAt=(bucket+1)*windowSeconds;
    const result=await db.execute({
      sql:`INSERT INTO auth_rate_limits (key,attempts,expires_at) VALUES (?,1,?)
        ON CONFLICT(key) DO UPDATE SET attempts=auth_rate_limits.attempts+1
        RETURNING attempts`,
      args:[rateLimitKey(dimension,value,bucket),expiresAt],
    });
    const attempts=Number(result.rows?.[0]?.attempts);
    if(!Number.isSafeInteger(attempts)||attempts<1) throw new Error('invalid rate limit state');
    if(attempts>limit){
      return Object.freeze({allowed:false,dimension,retryAfter:Math.max(1,expiresAt-nowSeconds)});
    }
  }
  return Object.freeze({allowed:true,dimension:null,retryAfter:0});
}

function projectFeedbackItem(row){
  if(!row||typeof row!=='object') throw new FeedbackInputError('stored feedback is invalid');
  const id=typeof row.id==='string'?row.id:null;
  const circleId=Number(row.circle_id);
  const authorUserId=Number(row.author_user_id);
  const createdAt=Number(row.created_at);
  const updatedAt=Number(row.updated_at);
  if(!id||!Number.isSafeInteger(circleId)||circleId<1||!Number.isSafeInteger(authorUserId)||authorUserId<1
    ||!Number.isSafeInteger(createdAt)||createdAt<1||!Number.isSafeInteger(updatedAt)||updatedAt<createdAt
    ||typeof row.kind!=='string'||typeof row.title!=='string'||typeof row.body!=='string'
    ||typeof row.status!=='string'){
    throw new FeedbackInputError('stored feedback is invalid');
  }
  let diagnostics=null;
  if(row.diagnostics_json!==null&&row.diagnostics_json!==undefined){
    try{ diagnostics=JSON.parse(String(row.diagnostics_json)); }catch{ throw new FeedbackInputError('stored feedback diagnostics are invalid'); }
    if(!diagnostics||typeof diagnostics!=='object'||Array.isArray(diagnostics)){
      throw new FeedbackInputError('stored feedback diagnostics are invalid');
    }
  }
  return Object.freeze({
    id,
    circle_id:circleId,
    author_user_id:authorUserId,
    kind:row.kind,
    title:row.title,
    body:row.body,
    status:row.status,
    visibility:row.visibility||'private',
    diagnostics:diagnostics?Object.freeze({...diagnostics}):null,
    vote_count:Number(row.vote_count||0),
    created_at:feedbackIsoSeconds(createdAt),
    updated_at:feedbackIsoSeconds(updatedAt),
    closed_at:row.closed_at===null||row.closed_at===undefined?null:feedbackIsoSeconds(Number(row.closed_at)),
  });
}

/**
 * The per-author idempotency lookup shared by the replay pre-check and
 * the insert path's in-transaction re-check.
 */
const EXISTING_FEEDBACK_SQL=`SELECT id,circle_id,author_user_id,kind,title,body,status,visibility,
  diagnostics_json,created_at,updated_at,closed_at,
  (SELECT COUNT(*) FROM feedback_votes vote WHERE vote.feedback_id=feedback_items.id) AS vote_count
FROM feedback_items WHERE author_user_id=? AND idempotency_key=? LIMIT 2`;

// Diagnostics keys are stored verbatim, so an unsafe key (email, IP,
// token) that bypassed validation must never reach storage: collapse it
// to '[redacted]' instead. See diagnosticsKeySafe in _feedback-config.js.
function sanitizeDiagnosticsKeys(diagnostics){
  const sanitized={};
  for(const [key,value] of Object.entries(diagnostics)){
    sanitized[diagnosticsKeySafe(key)?key:'[redacted]']=value;
  }
  return sanitized;
}

function redactedFeedbackParts(input){
  const title=redactLogText(input.title||'').trim();
  const body=redactLogText(input.body||'').trim();
  if(!title||[...title].length>FEEDBACK_TITLE_MAX||!body||[...body].length>FEEDBACK_BODY_MAX){
    throw new FeedbackInputError('feedback is too long after redaction');
  }
  let diagnosticsJson=null;
  if(input.diagnostics!==null&&input.diagnostics!==undefined){
    const redacted=redactLogValue(sanitizeDiagnosticsKeys(input.diagnostics));
    diagnosticsJson=JSON.stringify(redacted);
    if(Buffer.byteLength(diagnosticsJson,'utf8')>4096){
      throw new FeedbackInputError('diagnostics are too large after redaction');
    }
  }
  return {kind:input.kind,title,body,diagnosticsJson};
}

function sameStoredFeedback(stored,{circle,kind,title,body,diagnosticsJson}){
  return String(stored.kind)===kind&&String(stored.title)===title
    &&String(stored.body)===body&&Number(stored.circle_id)===circle
    &&String(stored.diagnostics_json??null)===String(diagnosticsJson??null);
}

function isUniqueConstraintFailure(error){
  const code=String(error?.code||'').toUpperCase();
  const message=String(error?.message||'').toUpperCase();
  return code==='SQLITE_CONSTRAINT_UNIQUE'||message.includes('SQLITE_CONSTRAINT_UNIQUE')
    ||message.includes('UNIQUE CONSTRAINT FAILED');
}

/**
 * Read-only replay lookup: an exact replay is answered without consuming
 * rate-limit budget (the route calls this before the limiter), and a
 * same-key/different-content submission is a 409 before the limiter too.
 * Returns null when no row exists for the key. The insert path in
 * submitFeedback re-checks inside its transaction, so a key created
 * between this lookup and the insert still replays instead of erroring.
 */
export async function lookupFeedbackReplay(db,{circleId,authorUserId,input}={}){
  if(!db||typeof db.execute!=='function') throw new TypeError('database client is required');
  const circle=Number(circleId);
  const author=Number(authorUserId);
  if(!Number.isSafeInteger(circle)||circle<1||!Number.isSafeInteger(author)||author<1
    ||!input||typeof input!=='object'){
    throw new TypeError('valid feedback replay lookup required');
  }
  const parts=redactedFeedbackParts(input);
  const existing=await db.execute({sql:EXISTING_FEEDBACK_SQL,args:[author,input.idempotencyKey]});
  if((existing.rows?.length||0)>1) throw new FeedbackInputError('stored feedback is invalid');
  if(existing.rows?.length!==1) return null;
  const stored=existing.rows[0];
  if(!sameStoredFeedback(stored,{circle,...parts})) throw new FeedbackConflictError();
  return Object.freeze({item:projectFeedbackItem(stored),replayed:true,
    outboxEvents:Object.freeze([])});
}

/**
 * Store one feedback item, its creation event, and one
 * `feedback.submitted` outbox event per admin recipient, in a single
 * transaction. A retry with the same idempotency key and the same
 * (redacted) payload replays the stored item without a second row or a
 * second email; the same key with different content is a 409.
 * `adminEmails` is the configured-admin set (getAdminEmails); accounts
 * with is_admin=1 are found from the database itself.
 */
export async function submitFeedback(db,{circleId,authorUserId,input,adminEmails=[],nowSeconds=null,
  notify=true}={}){
  if(!db||typeof db.transaction!=='function') throw new TypeError('database client is required');
  const circle=Number(circleId);
  const author=Number(authorUserId);
  if(!Number.isSafeInteger(circle)||circle<1||!Number.isSafeInteger(author)||author<1
    ||!input||typeof input!=='object'){
    throw new TypeError('valid feedback submission required');
  }
  const {title,body,diagnosticsJson}=redactedFeedbackParts(input);
  const transaction=await db.transaction('write');
  let finished=false;
  try{
    const now=await feedbackNow(transaction,nowSeconds);
    const existing=await transaction.execute({
      sql:EXISTING_FEEDBACK_SQL,
      args:[author,input.idempotencyKey],
    });
    if((existing.rows?.length||0)>1) throw new FeedbackInputError('stored feedback is invalid');
    if(existing.rows?.length===1){
      const stored=existing.rows[0];
      const same=sameStoredFeedback(stored,{circle,kind:input.kind,title,body,diagnosticsJson});
      await transaction.rollback(); finished=true;
      if(!same) throw new FeedbackConflictError();
      return Object.freeze({item:projectFeedbackItem(stored),replayed:true,
        outboxEvents:Object.freeze([])});
    }
    const id=randomUUID();
    const inserted=await transaction.execute({
      sql:`INSERT INTO feedback_items
          (id,circle_id,author_user_id,kind,title,body,status,visibility,diagnostics_json,
           idempotency_key,created_at,updated_at,closed_at)
        VALUES (?,?,?, ?,?,?, 'open','private',?,?, ?,?,NULL)
        RETURNING id,circle_id,author_user_id,kind,title,body,status,visibility,
          diagnostics_json,created_at,updated_at,closed_at`,
      args:[id,circle,author,input.kind,title,body,diagnosticsJson,input.idempotencyKey,now,now],
    });
    if(inserted.rows?.length!==1) throw new FeedbackInputError('feedback insert failed');
    await transaction.execute({
      sql:`INSERT INTO feedback_events (feedback_id,event_type,actor_user_id,detail_json,created_at)
        VALUES (?,'feedback.created',?,NULL,?)`,
      args:[id,author,now],
    });
    const outboxEvents=[];
    if(notify){
      const configured=[...new Set([...adminEmails].map(email=>String(email).trim().toLowerCase()).filter(Boolean))];
      const configuredSql=configured.length?` OR lower(account.email) IN (${configured.map(()=>'?').join(',')})`:'';
      const admins=await transaction.execute({
        sql:`SELECT account.id FROM auth_accounts account
          WHERE COALESCE(account.is_demo,0)=0 AND (account.is_admin=1${configuredSql})
          ORDER BY account.id`,
        args:[...configured],
      });
      for(const admin of admins.rows||[]){
        const statement=createFeedbackSubmittedEvent({
          feedbackId:id,circleId:circle,authorUserId:author,recipientUserId:Number(admin.id),
          kind:input.kind,title,
        });
        const queued=await transaction.execute(statement);
        if(Number(queued.rowsAffected||0)===1) outboxEvents.push(outboxStatementIdentity(statement));
      }
    }
    await transaction.commit(); finished=true;
    const stored={...inserted.rows[0],vote_count:0};
    return Object.freeze({item:projectFeedbackItem(stored),replayed:false,
      outboxEvents:Object.freeze(outboxEvents)});
  }catch(error){
    if(!finished){ try{ await transaction.rollback(); }catch{} }
    // Two simultaneous same-key POSTs can both pass the SELECT above and
    // collide on the (author, idempotency_key) unique index. That is an
    // idempotency race, not a storage failure: re-read the row the winner
    // committed and replay it (or 409 on different content), never a 503.
    if(isUniqueConstraintFailure(error)&&typeof db.execute==='function'){
      try{
        const reread=await db.execute({sql:EXISTING_FEEDBACK_SQL,args:[author,input.idempotencyKey]});
        if((reread.rows?.length||0)===1){
          const stored=reread.rows[0];
          if(sameStoredFeedback(stored,{circle,kind:input.kind,title,body,diagnosticsJson})){
            return Object.freeze({item:projectFeedbackItem(stored),replayed:true,
              outboxEvents:Object.freeze([])});
          }
          throw new FeedbackConflictError();
        }
      }catch(rereadError){
        if(rereadError instanceof FeedbackConflictError) throw rereadError;
        // No row to replay (or the re-read itself failed): the original
        // error is the honest one.
      }
    }
    throw error;
  }finally{ try{ await transaction.close?.(); }catch{} }
}

/** Newest-first page of the caller's own submissions in the active circle. */
export async function listMyFeedback(db,{authorUserId,circleId=null,limit=FEEDBACK_LIST_DEFAULT_LIMIT,cursor=null,
  nowSeconds=null}={}){
  if(!db||typeof db.execute!=='function') throw new TypeError('database client is required');
  const author=Number(authorUserId);
  const circle=circleId===null||circleId===undefined?null:Number(circleId);
  if(!Number.isSafeInteger(author)||author<1||!Number.isSafeInteger(limit)
    ||limit<1||limit>FEEDBACK_LIST_MAX_LIMIT
    ||(circle!==null&&(!Number.isSafeInteger(circle)||circle<1))){
    throw new TypeError('valid feedback page required');
  }
  void nowSeconds;
  const position=typeof cursor==='string'?decodeFeedbackCursor(cursor):cursor;
  if(position===false) throw new FeedbackInputError('invalid cursor');
  const cursorSql=position?'AND (created_at<? OR (created_at=? AND id<?))':'';
  const cursorArgs=position?[position.createdAt,position.createdAt,position.id]:[];
  const circleSql=circle===null?'':'AND item.circle_id=?';
  const circleArgs=circle===null?[]:[circle];
  const page=await db.execute({
    sql:`SELECT item.id,item.circle_id,item.author_user_id,item.kind,item.title,item.body,
        item.status,item.visibility,item.diagnostics_json,item.created_at,item.updated_at,
        item.closed_at,
        (SELECT COUNT(*) FROM feedback_votes vote WHERE vote.feedback_id=item.id) AS vote_count
      FROM feedback_items item
      WHERE item.author_user_id=? ${circleSql} ${cursorSql}
      ORDER BY item.created_at DESC,item.id DESC LIMIT ?`,
    args:[author,...circleArgs,...cursorArgs,limit+1],
  });
  const rows=page.rows||[];
  const visible=rows.slice(0,limit);
  const items=visible.map(row=>projectFeedbackItem(row));
  const last=visible.at(-1);
  return Object.freeze({
    items:Object.freeze(items),
    nextCursor:rows.length>limit?encodeFeedbackCursor(Number(last.created_at),String(last.id)):null,
  });
}
