import { createHmac, randomUUID } from 'node:crypto';

import { getJwtSecret } from './_db.js';
import { hashInvitationEmail, normalizeInvitationEmail } from './_circle-membership.js';
import { insertOwnerInvitation } from './_invitation-create.js';
import { outboxStatementIdentity } from './_outbox-identity.js';
import { rateLimitAddress } from './_client-address.js';
import {
  INVITE_REQUEST_RETENTION_SECONDS,
  INVITE_REQUEST_SCRUB_SQL,
  INVITE_REQUEST_TTL_SECONDS,
  inviteRequestNow,
} from './_invite-request-config.js';
import {
  INVITE_REQUEST_DIGEST_SECONDS,
  createInviteRequestNotificationEvent,
} from './_invite-request-notification.js';

// Public "Request an invite" (WP-L2, docs/INVITE_REQUESTS.md). The public
// endpoint never reveals whether an email is a member, invited, or already
// waiting; owners decide in the authenticated review API, and an approval
// reuses the one owner invitation path.

export const INVITE_REQUEST_RESPONSE_FLOOR_MS=750;
export const INVITE_REQUEST_ACCEPTED_MESSAGE='Thanks — if the circle has room, you\'ll get an invitation by email.';
export const INVITE_REQUEST_NAME_MIN=2;
export const INVITE_REQUEST_NAME_MAX=60;
export const INVITE_REQUEST_NOTE_MAX=280;
export const INVITE_REQUEST_LIST_DEFAULT_LIMIT=50;
export const INVITE_REQUEST_LIST_MAX_LIMIT=100;
export const INVITE_REQUEST_RATE_LIMITS=Object.freeze({
  ip:Object.freeze({limit:5,windowSeconds:60*60}),
  email:Object.freeze({limit:3,windowSeconds:60*60}),
});
// Rolling 24-hour cap on *stored* requests (duplicates, members, invited,
// declined, and honeypot submissions never count against it).
export const INVITE_REQUEST_GLOBAL_DAILY_LIMIT=50;
export const INVITE_REQUEST_GLOBAL_WINDOW_SECONDS=24*60*60;

const UUID_PATTERN=/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
// C0/C1 controls (newline allowed only in notes), line/paragraph separators,
// and bidirectional overrides/isolates that could disguise a name or note.
const UNSAFE_TEXT=/[\u0000-\u0009\u000b-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/u;
const INPUT_FIELDS=new Set(['name','email','note','website']);

export class InviteRequestUnavailableError extends Error{
  constructor(code){
    super('Invite requests are unavailable.');
    this.name='InviteRequestUnavailableError';
    this.code=code;
  }
}

function codePointLength(value){
  return [...value].length;
}

function honeypotFilled(value){
  if(value===undefined||value===null) return false;
  return typeof value!=='string'||value.trim()!=='';
}

/**
 * Validate the public form. Returns field-level messages the UI can attach
 * with aria-describedby. A filled honeypot short-circuits validation so a bot
 * always receives the generic accepted response.
 */
export function validateInviteRequestInput(body){
  if(!body||typeof body!=='object'||Array.isArray(body)){
    return Object.freeze({ok:false,honeypot:false,value:null,fields:{form:'Send the request as a JSON object.'}});
  }
  if(honeypotFilled(body.website)) return Object.freeze({ok:false,honeypot:true,value:null,fields:{}});
  const fields={};
  if(Object.keys(body).some(key=>!INPUT_FIELDS.has(key))) fields.form='Unexpected field.';
  let name=null;
  if(typeof body.name!=='string'){
    fields.name='Enter your name.';
  }else{
    name=body.name.normalize('NFC').replace(/[\t\n\r ]+/gu,' ').trim();
    const length=codePointLength(name);
    if(UNSAFE_TEXT.test(name)) fields.name='Remove unsupported characters from your name.';
    else if(length<INVITE_REQUEST_NAME_MIN||length>INVITE_REQUEST_NAME_MAX){
      fields.name=`Use ${INVITE_REQUEST_NAME_MIN}–${INVITE_REQUEST_NAME_MAX} characters.`;
    }
  }
  // Invite requests accept printable-ASCII addresses only, so control, bidi,
  // and look-alike Unicode never reach the owner list (IDN users can use the
  // owner's direct "invite by email" path).
  const email=typeof body.email==='string'&&/^[\x21-\x7e]+$/.test(body.email.trim())
    ?normalizeInvitationEmail(body.email):null;
  if(!email) fields.email='Enter a valid email address.';
  let note=null;
  if(body.note!==undefined&&body.note!==null){
    if(typeof body.note!=='string'){
      fields.note='Enter text.';
    }else{
      const normalized=body.note.normalize('NFC').replace(/\r\n?/gu,'\n').trim();
      if(UNSAFE_TEXT.test(normalized)) fields.note='Remove unsupported characters.';
      else if(codePointLength(normalized)>INVITE_REQUEST_NOTE_MAX){
        fields.note=`Use at most ${INVITE_REQUEST_NOTE_MAX} characters.`;
      }else note=normalized||null;
    }
  }
  const ok=Object.keys(fields).length===0;
  return Object.freeze({ok,honeypot:false,value:ok?Object.freeze({name,email,note}):null,fields});
}

function rateLimitKey(dimension,value,bucket){
  return createHmac('sha256',getJwtSecret())
    .update(`randori-invite-request-rate-v1\0${dimension}\0${value}\0${bucket}`,'utf8').digest('hex');
}

/**
 * Consume the public submission budget in the shared auth_rate_limits table:
 * per client address (IPv6 keyed by /64), then per email hash. The first
 * exhausted dimension stops evaluation so later counters are untouched. The
 * global cap is enforced on stored rows inside submitInviteRequest.
 */
export async function consumeInviteRequestRateLimits(db,{ip,emailHash,nowSeconds=Math.floor(Date.now()/1000)}={}){
  if(!db||typeof db.execute!=='function') throw new TypeError('database client is required');
  if(typeof emailHash!=='string'||!/^[0-9a-f]{64}$/.test(emailHash)) throw new TypeError('email hash is required');
  if(!Number.isSafeInteger(nowSeconds)||nowSeconds<1) throw new TypeError('valid time is required');
  const dimensions=[
    ['ip',rateLimitAddress(ip),INVITE_REQUEST_RATE_LIMITS.ip],
    ['email',emailHash,INVITE_REQUEST_RATE_LIMITS.email],
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

async function primaryCircleId(db){
  const result=await db.execute(`SELECT id FROM circles WHERE is_primary=1 AND archived_at IS NULL ORDER BY id LIMIT 2`);
  const rows=result.rows||[];
  const id=Number(rows[0]?.id);
  return rows.length===1&&Number.isSafeInteger(id)&&id>0?id:null;
}

/**
 * Store one pending request unless the email is already an active member, has
 * a live invitation, is already waiting, or was declined within the retention
 * window. Every outcome is reported only to the caller; the HTTP response is
 * identical for all of them.
 */
export async function submitInviteRequest(db,{name,email,note=null}={},{notification=null,nowSeconds=null}={}){
  if(!db||typeof db.transaction!=='function') throw new TypeError('database client is required');
  const recipient=normalizeInvitationEmail(email);
  const emailHash=hashInvitationEmail(recipient);
  if(!recipient||!emailHash||typeof name!=='string') throw new TypeError('valid invite request required');
  const transaction=await db.transaction('write');
  let finished=false;
  try{
    const now=await inviteRequestNow(transaction,nowSeconds);
    const circleId=await primaryCircleId(transaction);
    if(!circleId) throw new InviteRequestUnavailableError('PRIMARY_CIRCLE_UNAVAILABLE');
    // Global breaker first, before anything email-specific, so a full cap
    // yields the same 429 for every address and cannot become an oracle.
    const recent=await transaction.execute({
      sql:`SELECT COUNT(*) AS count FROM invite_requests WHERE circle_id=? AND created_at>?`,
      args:[circleId,now-INVITE_REQUEST_GLOBAL_WINDOW_SECONDS],
    });
    if(Number(recent.rows?.[0]?.count||0)>=INVITE_REQUEST_GLOBAL_DAILY_LIMIT){
      await transaction.rollback(); finished=true;
      return Object.freeze({stored:false,outcome:'global_limited',outboxEvents:Object.freeze([])});
    }
    // At most one pending row exists per email (partial unique index), so this
    // lazy expiry touches zero or one row.
    await transaction.execute({
      sql:`UPDATE invite_requests SET status='expired',${INVITE_REQUEST_SCRUB_SQL},decided_at=?
        WHERE circle_id=? AND email_hash=? AND status='pending' AND expires_at<=?`,
      args:[now,circleId,emailHash,now],
    });
    const eligibility=await transaction.execute({
      sql:`SELECT
          EXISTS(SELECT 1 FROM auth_accounts account
            JOIN circle_memberships membership ON membership.user_id=account.id
              AND membership.circle_id=? AND membership.status='active'
            WHERE lower(account.email)=?) AS is_member,
          EXISTS(SELECT 1 FROM circle_invitations invitation
            WHERE invitation.circle_id=? AND invitation.email_hash=?
              AND invitation.used_at IS NULL AND invitation.used_by IS NULL
              AND invitation.revoked_at IS NULL
              AND datetime(invitation.expires_at)>datetime(?,'unixepoch')) AS is_invited,
          EXISTS(SELECT 1 FROM invite_requests request
            WHERE request.circle_id=? AND request.email_hash=? AND request.status='declined'
              AND request.decided_at>?) AS recently_declined`,
      args:[circleId,recipient,circleId,emailHash,now,circleId,emailHash,now-INVITE_REQUEST_RETENTION_SECONDS],
    });
    const state=eligibility.rows?.[0]||{};
    let outcome='stored';
    if(Number(state.is_member)===1) outcome='member';
    else if(Number(state.is_invited)===1) outcome='invited';
    else if(Number(state.recently_declined)===1) outcome='declined';
    const outboxEvents=[];
    if(outcome==='stored'){
      const inserted=await transaction.execute({
        sql:`INSERT INTO invite_requests
            (id,circle_id,email_hash,email,name,note,status,created_at,expires_at)
          VALUES (?,?,?,?,?,?,'pending',?,?)
          ON CONFLICT DO NOTHING RETURNING id`,
        args:[randomUUID(),circleId,emailHash,recipient,name,note,now,now+INVITE_REQUEST_TTL_SECONDS],
      });
      if(!inserted.rows?.length) outcome='duplicate';
    }
    if(outcome==='stored'&&notification){
      // Every active owner gets one hourly digest; circles have no owner
      // ceiling. Inline delivery is separately capped by the outbox budget,
      // so any remainder is drained by the scheduled worker.
      const owners=await transaction.execute({
        sql:`SELECT account.id FROM circle_memberships membership
          JOIN auth_accounts account ON account.id=membership.user_id AND COALESCE(account.is_demo,0)=0
          WHERE membership.circle_id=? AND membership.role='owner' AND membership.status='active'
          ORDER BY account.id`,
        args:[circleId],
      });
      const digestHour=Math.floor(now/INVITE_REQUEST_DIGEST_SECONDS);
      for(const owner of owners.rows||[]){
        const statement=createInviteRequestNotificationEvent({circleId,ownerUserId:Number(owner.id),digestHour});
        const queued=await transaction.execute(statement);
        if(Number(queued.rowsAffected||0)===1) outboxEvents.push(outboxStatementIdentity(statement));
      }
    }
    await transaction.commit(); finished=true;
    return Object.freeze({stored:outcome==='stored',outcome,outboxEvents:Object.freeze(outboxEvents)});
  }catch(error){
    if(!finished){ try{ await transaction.rollback(); }catch{} }
    throw error;
  }finally{ try{ await transaction.close?.(); }catch{} }
}

function encodeCursor(createdAt,id){
  return Buffer.from(`${createdAt}.${id}`,'utf8').toString('base64url');
}

/** Returns null for no cursor, false for an invalid one, else the position. */
export function decodeInviteRequestCursor(value){
  if(value===undefined||value===null||value==='') return null;
  if(typeof value!=='string'||value.length>96||!/^[A-Za-z0-9_-]+$/.test(value)) return false;
  const decoded=Buffer.from(value,'base64url').toString('utf8');
  const match=/^([1-9]\d{0,15})\.([0-9a-f-]{36})$/.exec(decoded);
  if(!match||!UUID_PATTERN.test(match[2])) return false;
  const createdAt=Number(match[1]);
  return Number.isSafeInteger(createdAt)?Object.freeze({createdAt,id:match[2]}):false;
}

function isoSeconds(value){
  return new Date(Number(value)*1000).toISOString();
}

/** Newest-first page of live pending requests for one circle. */
export async function listPendingInviteRequests(db,{circleId,limit=INVITE_REQUEST_LIST_DEFAULT_LIMIT,
  cursor=null,nowSeconds=null}={}){
  if(!db||typeof db.execute!=='function') throw new TypeError('database client is required');
  const circle=Number(circleId);
  if(!Number.isSafeInteger(circle)||circle<1||!Number.isSafeInteger(limit)
    ||limit<1||limit>INVITE_REQUEST_LIST_MAX_LIMIT){
    throw new TypeError('valid invite request page required');
  }
  const now=await inviteRequestNow(db,nowSeconds);
  const cursorSql=cursor?'AND (created_at<? OR (created_at=? AND id<?))':'';
  const cursorArgs=cursor?[cursor.createdAt,cursor.createdAt,cursor.id]:[];
  const page=await db.execute({
    sql:`SELECT id,name,email,note,created_at,expires_at FROM invite_requests
      WHERE circle_id=? AND status='pending' AND expires_at>? ${cursorSql}
      ORDER BY created_at DESC,id DESC LIMIT ?`,
    args:[circle,now,...cursorArgs,limit+1],
  });
  const count=await db.execute({
    sql:`SELECT COUNT(*) AS count FROM invite_requests
      WHERE circle_id=? AND status='pending' AND expires_at>?`,
    args:[circle,now],
  });
  const rows=page.rows||[];
  const visible=rows.slice(0,limit);
  const requests=visible.map(row=>Object.freeze({
    id:String(row.id),name:String(row.name),email:String(row.email),
    note:row.note===null?null:String(row.note),
    created_at:isoSeconds(row.created_at),expires_at:isoSeconds(row.expires_at),
  }));
  const last=visible.at(-1);
  return Object.freeze({
    requests:Object.freeze(requests),
    pendingCount:Number(count.rows?.[0]?.count||0),
    nextCursor:rows.length>limit?encodeCursor(Number(last.created_at),String(last.id)):null,
  });
}

async function auditDecision(transaction,{circleId,actorUserId,requestId,decision,invitationId}){
  const audited=await transaction.execute({
    sql:`INSERT INTO circle_audit_events
        (circle_id,event_type,actor_user_id,subject_user_id,invitation_id,dedupe_key,created_at)
      VALUES (?,?,?,NULL,?,?,strftime('%Y-%m-%dT%H:%M:%fZ','now'))
      ON CONFLICT(dedupe_key) DO NOTHING RETURNING id`,
    args:[circleId,`invite_request.${decision}`,actorUserId,invitationId,
      `invite-request-${decision}:${requestId}`],
  });
  if(audited.rows?.length!==1) throw new Error('invite request decision audit missing');
}

function decisionResult(fields){
  return Object.freeze({emailStatement:null,emailQueued:false,invitation:null,replayed:false,...fields});
}

/**
 * Approve or decline one request with a compare-and-swap on `pending`.
 * Approval creates the normal single-use invitation through
 * insertOwnerInvitation in the same transaction, so the request can never be
 * approved without exactly one invitation (and vice versa). Repeating the
 * same decision is an idempotent replay; a different decision conflicts.
 */
export async function decideInviteRequest(db,{requestId,decision,ownerUserId,emailConfiguration=null,
  localRuntime=false,nowSeconds=null}={}){
  if(!db||typeof db.transaction!=='function') throw new TypeError('database client is required');
  const id=String(requestId||'').toLowerCase();
  const owner=Number(ownerUserId);
  if(!UUID_PATTERN.test(id)||!['approve','decline'].includes(decision)
    ||!Number.isSafeInteger(owner)||owner<1){
    throw new TypeError('valid invite request decision required');
  }
  const targetStatus=decision==='approve'?'approved':'declined';
  const transaction=await db.transaction('write');
  let finished=false;
  const rollback=async()=>{ await transaction.rollback(); finished=true; };
  try{
    const now=await inviteRequestNow(transaction,nowSeconds);
    const selected=await transaction.execute({
      sql:`SELECT request.id,request.circle_id,request.status,request.email,request.expires_at,
          request.decided_at,request.invitation_id
        FROM invite_requests request
        JOIN circles circle ON circle.id=request.circle_id AND circle.archived_at IS NULL
        JOIN circle_memberships membership ON membership.circle_id=request.circle_id
          AND membership.user_id=? AND membership.role='owner' AND membership.status='active'
        WHERE request.id=? LIMIT 2`,
      args:[owner,id],
    });
    if(selected.rows?.length!==1){ await rollback(); return decisionResult({status:'not_found'}); }
    const row=selected.rows[0];
    const circleId=Number(row.circle_id);
    const current=String(row.status);
    if(current!=='pending'){
      await rollback();
      if(current===targetStatus){
        return decisionResult({status:targetStatus,replayed:true,
          request:Object.freeze({id,status:current,decided_at:isoSeconds(row.decided_at)}),
          invitation:row.invitation_id?Object.freeze({id:String(row.invitation_id)}):null});
      }
      return decisionResult({status:'conflict',currentStatus:current});
    }
    if(Number(row.expires_at)<=now){
      await transaction.execute({
        sql:`UPDATE invite_requests SET status='expired',${INVITE_REQUEST_SCRUB_SQL},decided_at=?
          WHERE id=? AND status='pending'`,
        args:[now,id],
      });
      await transaction.commit(); finished=true;
      return decisionResult({status:'conflict',currentStatus:'expired'});
    }
    let created=null;
    if(decision==='approve'){
      // The person may have joined or been invited since requesting; never
      // issue a second live invitation or invite an existing member.
      const recheck=await transaction.execute({
        sql:`SELECT
            EXISTS(SELECT 1 FROM auth_accounts account
              JOIN circle_memberships membership ON membership.user_id=account.id
                AND membership.circle_id=? AND membership.status='active'
              WHERE lower(account.email)=?) AS is_member,
            EXISTS(SELECT 1 FROM circle_invitations invitation
              WHERE invitation.circle_id=? AND invitation.email_hash=?
                AND invitation.used_at IS NULL AND invitation.used_by IS NULL
                AND invitation.revoked_at IS NULL
                AND datetime(invitation.expires_at)>datetime(?,'unixepoch')) AS is_invited`,
        args:[circleId,String(row.email),circleId,hashInvitationEmail(String(row.email)),now],
      });
      const state=recheck.rows?.[0]||{};
      if(Number(state.is_member)===1||Number(state.is_invited)===1){
        await rollback();
        return decisionResult({status:'conflict',currentStatus:'pending',
          reason:Number(state.is_member)===1?'already_member':'already_invited'});
      }
      created=await insertOwnerInvitation(transaction,{
        ownerUserId:owner,circleId,email:String(row.email),emailConfiguration,localRuntime,
      });
      // The owner check already passed in this transaction; losing it here is
      // an integrity failure, not a missing request.
      if(!created.ok) throw new Error('invite request approval lost owner authority');
    }
    const invitationId=created?.invitation.id||null;
    const updated=await transaction.execute({
      sql:`UPDATE invite_requests SET status=?,${INVITE_REQUEST_SCRUB_SQL},decided_at=?,decided_by=?,invitation_id=?
        WHERE id=? AND circle_id=? AND status='pending' AND expires_at>? RETURNING id`,
      args:[targetStatus,now,owner,invitationId,id,circleId,now],
    });
    if(updated.rows?.length!==1) throw new Error('invite request decision lost its pending state');
    await auditDecision(transaction,{circleId,actorUserId:owner,requestId:id,decision:targetStatus,invitationId});
    await transaction.commit(); finished=true;
    return decisionResult({
      status:targetStatus,
      request:Object.freeze({id,status:targetStatus,decided_at:isoSeconds(now)}),
      invitation:created?.invitation||null,
      emailStatement:created?.emailStatement||null,
      emailQueued:created?.emailQueued===true,
    });
  }catch(error){
    if(!finished){ try{ await transaction.rollback(); }catch{} }
    throw error;
  }finally{ try{ await transaction.close?.(); }catch{} }
}
