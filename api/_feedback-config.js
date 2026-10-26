// Dependency-free core of the product-feedback feature (#353): the flag,
// validation, the read-only schema probe, and bounded retention. Kept free
// of outbox and redaction imports so capability discovery and the weekly
// sweep do not load the request or delivery code paths.

export const FEEDBACK_MIGRATION_VERSION=22;
export const FEEDBACK_KINDS=Object.freeze(['bug','feature_request','feedback']);
export const FEEDBACK_STATUSES=Object.freeze(['open','in_progress','closed']);
export const FEEDBACK_TITLE_MAX=120;
export const FEEDBACK_BODY_MAX=4000;
export const FEEDBACK_DIAGNOSTICS_MAX_BYTES=4096;
export const FEEDBACK_DIAGNOSTICS_MAX_KEYS=20;
export const FEEDBACK_DIAGNOSTICS_MAX_STRING=500;
export const FEEDBACK_IDEMPOTENCY_KEY_MIN=8;
export const FEEDBACK_IDEMPOTENCY_KEY_MAX=128;
export const FEEDBACK_LIST_DEFAULT_LIMIT=50;
export const FEEDBACK_LIST_MAX_LIMIT=100;
// Abuse limits (#353): 10 submissions per rolling hour and 30 per rolling
// day, enforced separately per member and per client address. Both windows
// use the shared auth_rate_limits table with keyed hashes (ID-82): no raw
// IP is stored.
export const FEEDBACK_RATE_LIMITS=Object.freeze({
  userHour:Object.freeze({limit:10,windowSeconds:60*60}),
  userDay:Object.freeze({limit:30,windowSeconds:24*60*60}),
  ipHour:Object.freeze({limit:10,windowSeconds:60*60}),
  ipDay:Object.freeze({limit:30,windowSeconds:24*60*60}),
});
// Owner decision (2026-10-22): closed items are kept for 12 months, then
// deleted. Open items are kept until they are closed.
export const FEEDBACK_CLOSED_RETENTION_SECONDS=365*24*60*60;
export const FEEDBACK_RETENTION_BATCH_LIMIT=500;
export const FEEDBACK_RETENTION_MAX_BATCHES=10;

// Control characters, line/paragraph separators, and bidirectional
// overrides/isolates that could disguise text. Newlines and tabs are
// allowed in the body only (see validateFeedbackInput).
const UNSAFE_TEXT=/[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/u;
const UNSAFE_TITLE=/[\u0000-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/u;
const INPUT_FIELDS=new Set(['kind','title','body','diagnostics','idempotency_key']);

export function feedbackEnabled(env=process.env){
  return env?.FEEDBACK_ENABLED==='true'&&env?.CIRCLE_MEMBERSHIP_ENABLED==='true';
}

function codePointLength(value){
  return [...value].length;
}

function isPlainObject(value){
  if(value===null||typeof value!=='object'||Array.isArray(value)) return false;
  const prototype=Object.getPrototypeOf(value);
  return prototype===Object.prototype||prototype===null;
}

// Diagnostics keys are stored verbatim in diagnostics_json, so a key must
// be a plain field name — never an email, an IP literal, a JWT, or a
// token-looking string smuggled in as a key. The charset alone does not
// suffice (an IPv4 literal and a bare token both match it), so the extra
// shapes are rejected explicitly. submitFeedback applies the same predicate
// as a backstop and collapses an unsafe key to '[redacted]' instead of
// storing it.
export const DIAGNOSTICS_KEY_PATTERN=/^[A-Za-z0-9_.\-]+$/;
const DIAGNOSTICS_KEY_IPV4=/^\d{1,3}(?:\.\d{1,3}){3}$/;
const DIAGNOSTICS_KEY_TOKEN=/^(?:eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*\.[A-Za-z0-9_-]*|sk_(?:live|test)_|ghp_|gho_|github_pat_|xox[baprs]-|AKIA[0-9A-Z]{16}|[A-Za-z0-9_.\-]{32,})$/;

export function diagnosticsKeySafe(key){
  return typeof key==='string'&&key.length>0&&key.length<=64
    &&DIAGNOSTICS_KEY_PATTERN.test(key)&&!DIAGNOSTICS_KEY_IPV4.test(key)
    &&!DIAGNOSTICS_KEY_TOKEN.test(key);
}

function validateDiagnostics(value){
  if(value===undefined||value===null) return null;
  if(!isPlainObject(value)) return 'Diagnostics must be a JSON object.';
  const keys=Object.keys(value);
  if(keys.length>FEEDBACK_DIAGNOSTICS_MAX_KEYS) return 'Diagnostics has too many fields.';
  for(const key of keys){
    if(!diagnosticsKeySafe(key)) return 'Diagnostics has an invalid field name.';
    const field=value[key];
    if(typeof field==='string'){
      if(field.length>FEEDBACK_DIAGNOSTICS_MAX_STRING||UNSAFE_TEXT.test(field)) return 'A diagnostics field is too long or contains unsupported characters.';
    }else if(typeof field!=='number'||!Number.isFinite(field)){
      if(field!==null&&typeof field!=='boolean') return 'Diagnostics fields must be text, numbers, true/false, or empty.';
    }
  }
  let json;
  try{ json=JSON.stringify(value); }catch{ return 'Diagnostics must be JSON-safe.'; }
  if(Buffer.byteLength(json,'utf8')>FEEDBACK_DIAGNOSTICS_MAX_BYTES) return 'Diagnostics are too large.';
  return null;
}

/**
 * Validate a feedback submission body. Returns field-level messages the
 * caller returns as 400. Redaction happens later, in submitFeedback, so
 * this function stays pure and testable without the log policy.
 * The client-supplied idempotency_key is required: a retry with the same
 * key and payload replays instead of storing a duplicate.
 */
export function validateFeedbackInput(body){
  if(!body||typeof body!=='object'||Array.isArray(body)){
    return Object.freeze({ok:false,value:null,fields:{form:'Send the feedback as a JSON object.'}});
  }
  const fields={};
  if(Object.keys(body).some(key=>!INPUT_FIELDS.has(key))) fields.form='Unexpected field.';
  let kind=null;
  if(typeof body.kind!=='string'||!FEEDBACK_KINDS.includes(body.kind)){
    fields.kind='Kind must be bug, feature_request, or feedback.';
  }else kind=body.kind;
  let title=null;
  if(typeof body.title!=='string'){
    fields.title='Enter a title.';
  }else{
    title=body.title.normalize('NFC').trim();
    const length=codePointLength(title);
    if(UNSAFE_TITLE.test(title)) fields.title='Remove unsupported characters from the title.';
    else if(length<1||length>FEEDBACK_TITLE_MAX) fields.title=`Use 1–${FEEDBACK_TITLE_MAX} characters for the title.`;
  }
  let text=null;
  if(typeof body.body!=='string'){
    fields.body='Enter the feedback.';
  }else{
    text=body.body.normalize('NFC').replace(/\r\n?/gu,'\n').trim();
    const length=codePointLength(text);
    if(UNSAFE_TEXT.test(text.replace(/[\n\t]/gu,''))) fields.body='Remove unsupported characters from the feedback.';
    else if(length<1||length>FEEDBACK_BODY_MAX) fields.body=`Use 1–${FEEDBACK_BODY_MAX} characters for the feedback.`;
  }
  let diagnostics=null;
  if(body.diagnostics!==undefined&&body.diagnostics!==null){
    if(kind!==null&&kind!=='bug'){
      fields.diagnostics='Diagnostics are only accepted for bug reports.';
    }else{
      const problem=validateDiagnostics(body.diagnostics);
      if(problem) fields.diagnostics=problem;
      else diagnostics=body.diagnostics;
    }
  }
  let idempotencyKey=null;
  if(typeof body.idempotency_key!=='string'){
    fields.idempotency_key='Send an idempotency key.';
  }else{
    idempotencyKey=body.idempotency_key.trim();
    if(idempotencyKey.length<FEEDBACK_IDEMPOTENCY_KEY_MIN
      ||idempotencyKey.length>FEEDBACK_IDEMPOTENCY_KEY_MAX
      ||/[\u0000-\u001f\u007f]/u.test(idempotencyKey)
      ||idempotencyKey!==body.idempotency_key.trim()){
      fields.idempotency_key=`Use an idempotency key of ${FEEDBACK_IDEMPOTENCY_KEY_MIN}–${FEEDBACK_IDEMPOTENCY_KEY_MAX} characters.`;
    }
  }
  const ok=Object.keys(fields).length===0;
  return Object.freeze({ok,value:ok?Object.freeze({kind,title,body:text,diagnostics,idempotencyKey}):null,fields});
}

const readinessByUrl=new Map();
const readinessByClient=new WeakMap();

function readinessCache(db){
  const databaseUrl=String(process.env.TURSO_DATABASE_URL||'').trim();
  return databaseUrl?{cache:readinessByUrl,key:databaseUrl}:{cache:readinessByClient,key:db};
}

async function probeFeedbackSchema(db){
  await db.execute(`SELECT id,circle_id,author_user_id,kind,title,body,status,visibility,
    diagnostics_json,idempotency_key,created_at,updated_at,closed_at FROM feedback_items LIMIT 0`);
  await db.execute(`SELECT id,feedback_id,user_id,value,created_at FROM feedback_votes LIMIT 0`);
  await db.execute(`SELECT id,feedback_id,event_type,actor_user_id,detail_json,created_at FROM feedback_events LIMIT 0`);
  await db.execute(`SELECT key,attempts,expires_at FROM auth_rate_limits LIMIT 0`);
  await db.execute(`SELECT id,event_type,event_version,idempotency_key FROM outbox_events LIMIT 0`);
  await db.execute(`SELECT id,is_primary,archived_at FROM circles LIMIT 0`);
  await db.execute(`SELECT circle_id,user_id,role,status FROM circle_memberships LIMIT 0`);
  await db.execute(`SELECT id,email,is_admin,is_demo FROM auth_accounts LIMIT 0`);
  await db.execute(`SELECT user_id,email_enabled FROM user_notification_prefs LIMIT 0`);
  return true;
}

/** Read-only, cached (success only) schema probe; never creates schema. */
export async function ensureFeedbackReadiness(db){
  if(!db||typeof db.execute!=='function') throw new TypeError('database client is required');
  const {cache,key}=readinessCache(db);
  const existing=cache.get(key);
  if(existing) return existing;
  const pending=probeFeedbackSchema(db);
  cache.set(key,pending);
  try{ return await pending; }
  catch(error){ if(cache.get(key)===pending) cache.delete(key); throw error; }
}

/** True only for the expected pre-v22 rollout state, never for other failures. */
export function feedbackSchemaNotInstalled(error){
  let current=error;
  for(let depth=0;current&&depth<6;depth+=1){
    if(/no such table:\s*(?:main\.)?feedback_items\b/i.test(String(current.message||''))) return true;
    current=current.cause;
  }
  return false;
}

export async function feedbackNow(db,override=null){
  if(override!==null&&override!==undefined){
    if(!Number.isSafeInteger(override)||override<1) throw new TypeError('valid time is required');
    return override;
  }
  const result=await db.execute(`SELECT CAST(strftime('%s','now') AS INTEGER) AS now_seconds`);
  const now=Number(result.rows?.[0]?.now_seconds);
  if(!Number.isSafeInteger(now)||now<1) throw new Error('database time unavailable');
  return now;
}

/** Cursor for newest-first /mine pages: base64url("<created_at>.<id>"). */
export function encodeFeedbackCursor(createdAt,id){
  return Buffer.from(`${createdAt}.${id}`,'utf8').toString('base64url');
}

const UUID_PATTERN=/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/** Returns null for no cursor, false for an invalid one, else the position. */
export function decodeFeedbackCursor(value){
  if(value===undefined||value===null||value==='') return null;
  if(typeof value!=='string'||value.length>128||!/^[A-Za-z0-9_-]+$/.test(value)) return false;
  const decoded=Buffer.from(value,'base64url').toString('utf8');
  const match=/^([1-9]\d{0,15})\.([0-9a-f-]{36})$/.exec(decoded);
  if(!match||!UUID_PATTERN.test(match[2])) return false;
  const createdAt=Number(match[1]);
  return Number.isSafeInteger(createdAt)?Object.freeze({createdAt,id:match[2]}):false;
}

export function feedbackIsoSeconds(value){
  return new Date(Number(value)*1000).toISOString();
}
