// Client log policy for POST /api/logs (ID-72 and its addendum).
//
// The browser logger in index.html applies the same redaction before an entry
// is mirrored, queued or sent; this copy is the server-side backstop for any
// other client. tests/unit/client-logger.test.mjs runs both copies over one
// text corpus and one object corpus, so keep every pattern and limit below
// identical to the inline `redactText`/`redactValue` there.
//
// Cost is bounded twice: input is cut before any pattern runs (8000 chars per
// string, a 16k-char budget per entry), and every pattern is anchored so that
// it does work proportional to its input; adversarial inputs are covered by
// timing tests.

/** Production accepts only these client levels; info/success/debug stay in the browser. */
export const CLIENT_LOG_PRODUCTION_LEVELS=Object.freeze(['warn','error']);
/** Request bodies larger than this are refused with 413 before they are parsed. */
export const CLIENT_LOG_MAX_BODY_BYTES=256*1024;
/** Stored client entries per member in any rolling hour. */
export const CLIENT_LOG_USER_HOURLY_CAP=200;
/**
 * Counts a member's client rows in the last hour, stopping at the cap. It
 * searches idx_logs_source_created (source, created_at), so it reads at most
 * the last hour of client rows; args: [userId, cap].
 */
export const CLIENT_LOG_RECENT_COUNT_SQL=`SELECT COUNT(*) AS count FROM (
  SELECT 1 FROM app_logs
  WHERE source='client' AND created_at>datetime('now','-1 hour') AND user_id=?
  LIMIT ?
)`;
/**
 * Inserts one client row only while the member is under the cap. Each row of
 * a request is one such statement inside a single 'write' batch, so the
 * check and the insert are atomic and concurrent requests cannot overshoot.
 * Args: level, event, message, meta_json, user_id, route, ua, ip, then
 * [user_id, cap, cap] for the count.
 */
export const CLIENT_LOG_CAPPED_INSERT_SQL=`INSERT INTO app_logs (level, source, event, message, meta_json, user_id, route, ua, ip, created_at)
  SELECT ?,'client',?,?,?,?,?,?,?,datetime('now')
  WHERE (${CLIENT_LOG_RECENT_COUNT_SQL})<?`;

const TEXT_MAX=8000;
const VALUE_BUDGET=16000;
const VALUE_MAX_DEPTH=4;
const VALUE_MAX_KEYS=30;
const VALUE_MAX_ITEMS=20;

// A cut never keeps half a token: text is dropped back to one of these.
const CUT_DELIMITER=/[\s"'<>()\\,;]/;
// Percent-encoded '#', '=', '@', '/' and '.' (also double-encoded, %2540)
// are decoded first, so encoded fragments, pairs and emails meet the same
// rules.
const ENCODED=/%(?:25)?(?:23|3d|40|2f|2e)/gi;
const DECODED={'23':'#','3d':'=','40':'@','2f':'/','2e':'.'};
// A URL fragment carries invite, reset and verify tokens. Within each
// whitespace/quote/paren-delimited token, drop the fragment when a '/' comes
// before the '#' or the fragment holds a '/' or '=', keeping a trailing
// stack-frame :line:col.
const TOKEN=/[^\s"'<>()\\]+/g;
const LINE_COL=/(?::\d+){1,2}$/;
// Secret-looking names: an optional `prefix_`/`prefix-`, or one of a few
// camelCase prefixes (accessToken, apiKey, activationToken; cycleKey stays
// readable), a secret word, an optional id/key/token/hash suffix (sessionId,
// session_id). A quoted value keeps its quotes (token="[redacted]").
// After a colon only unambiguous words count (password: x, secret_key: x),
// and `code:` only before 4-10 digits, so "status code: 500" stays.
const SECRET_PAIR=/(^|[^a-z0-9_])((?:[a-z0-9]+[_-]|access|activation|refresh|id|invite|api|auth|client|session|csrf|xsrf|reset|verify|private)?(?:token|invite|code|secret|password|passwd|pwd|key|signature|sig|session|sid|auth|authorization|cookie|otp|credential|csrf|xsrf|ua|ip|xff|user[_-]?agent|forwarded[_-]for)(?:[_-]?(?:id|key|token|hash))?s?)=(["']?)([^\s&#"'<>,;()\\]+)/gi;
const SECRET_JSON=/("(?:[a-z0-9]+[_-]|access|activation|refresh|id|invite|api|auth|client|session|csrf|xsrf|reset|verify|private)?(?:token|invite|code|secret|password|passwd|pwd|key|signature|sig|session|sid|auth|authorization|cookie|otp|credential|csrf|xsrf|ua|ip|xff|user[_-]?agent|forwarded[_-]for)(?:[_-]?(?:id|key|token|hash))?s?"\s*:\s*)(?:"(?:[^"\\]|\\.)*"|[\w.+-]+)/gi;
const SECRET_ESCAPED_JSON=/(\\"(?:[a-z0-9]+[_-]|access|activation|refresh|id|invite|api|auth|client|session|csrf|xsrf|reset|verify|private)?(?:token|invite|code|secret|password|passwd|pwd|key|signature|sig|session|sid|auth|authorization|cookie|otp|credential|csrf|xsrf|ua|ip|xff|user[_-]?agent|forwarded[_-]for)(?:[_-]?(?:id|key|token|hash))?s?\\"\s*:\s*)(?:\\"[^"]*?\\"|[\w.+-]+)/gi;
const AUTH_HEADER=/\b((?:proxy-)?authorization)(\s*[:=]\s*["']?)(?:(?:bearer|basic|token|digest)\s+)?[^\s,;"']+/gi;
const SECRET_COLON=/\b((?:[a-z0-9]+[_-])?(?:password|passwd|pwd|secret|otp|cookie|credentials?|token)(?:[_-]?(?:id|key|token|hash))?)(\s*:\s*)[^\s,;]+/gi;
const CODE_COLON=/\b(code)(\s*:\s*["']?)\d{4,10}\b/gi;
const AUTH_SCHEME=/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/gi;
// The boundary is a capture rather than a lookbehind so older Safari parses
// the browser copy; either way a match can only start where a token starts.
const JWT=/(^|[^A-Za-z0-9_-])eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]*/g;
const EMAIL=/[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9-]{1,63}(?:\.[A-Za-z0-9-]{1,63})*\.[A-Za-z]{2,63}/g;
// Client details the request already carries (ID-82): the address and user
// agent are stored reduced or not at all, so a copy inside the text goes too.
// The names ua, ip, xff, user-agent and x-forwarded-for join the secret names
// above. After a colon only the user-agent and forwarded names count, and
// they take the rest of the line, since a user agent holds spaces.
const CLIENT_COLON=/\b((?:[a-z0-9]+[_-])?(?:user[_-]?agent|forwarded[_-]for|xff|ua))(\s*:\s*)(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s"'{}][^\r\n"'{}]*)/gi;
// A bare browser user agent: 'Mozilla/5.0 (…)' and the product tokens after it.
const USER_AGENT=/\bMozilla\/\d{1,2}\.\d{1,2} \([^()\r\n]{1,200}\)(?: (?:[\w.-]{1,40}\/[\w.+-]{1,40}|\([^()\r\n]{0,200}\)|Mobile))*/g;
// IPv4 and IPv6 literals become [ip] (an IPv4 :port stays); loopback stays
// readable. A candidate is a short run of hex digits, dots and colons that
// starts a token or follows '//', so product versions (Chrome/131.0.0.0,
// v1.2.3.4), three-part versions, stack-frame :line:col and clock times are
// never addresses.
const ADDRESS=/(^|[^0-9A-Za-z_:./-]|\/\/)([0-9A-Fa-f:.]{2,45})(?![0-9A-Za-z_:]|\.[0-9A-Za-z])/g;
const OCTET=/^(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)$/;
const HEXTET=/^[0-9A-Fa-f]{1,4}$/;
// Object keys whose value is dropped whole.
const SECRET_KEY=/token|secret|passw|pwd|authorization|cookie|credential|signature|invite|session|api_?key|private_?key|user[_-]?agent|forwarded|ip_?address|^(?:code|key|sig|sid|auth|otp|ua|ip|xff|x[_-]real[_-]ip)$/i;

function cut(text,max){
  if(text.length<=max) return text;
  let end=max;
  while(end>0&&!CUT_DELIMITER.test(text[end-1])) end-=1;
  return `${text.slice(0,end)}[truncated]`;
}

function ipv4Literal(text){
  const parts=text.split('.');
  return parts.length===4&&parts.every(part=>OCTET.test(part));
}

function ipv6Literal(text){
  const halves=text.split('::');
  if(halves.length>2) return false;
  let groups=0;
  for(let half=0;half<halves.length;half+=1){
    if(!halves[half]) continue;
    const parts=halves[half].split(':');
    for(let index=0;index<parts.length;index+=1){
      if(HEXTET.test(parts[index])) groups+=1;
      else if(half===halves.length-1&&index===parts.length-1&&ipv4Literal(parts[index])) groups+=2;
      else return false;
    }
  }
  return groups>0&&(halves.length===2?groups<8:groups===8);
}

function loopbackLiteral(text){
  return /^(?:::ffff:)?127\./i.test(text)||/^(?:0{1,4}:){7}0{0,3}1$|^::1$/.test(text);
}

function redactAddress(match,lead,candidate){
  const dots=/\.*$/.exec(candidate)[0];
  const core=candidate.slice(0,candidate.length-dots.length);
  const port=/^([\d.]+)(:\d{1,5})$/.exec(core);
  const address=port&&ipv4Literal(port[1])?port[1]:core;
  if(!(ipv4Literal(address)||ipv6Literal(address))||loopbackLiteral(address)) return match;
  return lead+'[ip]'+(address===core?'':port[2])+dots;
}

function stripFragment(token){
  const hash=token.indexOf('#');
  if(hash===-1) return token;
  const fragment=token.slice(hash+1);
  if(token.lastIndexOf('/',hash)===-1&&!/[/=]/.test(fragment)) return token;
  const lineCol=fragment.match(LINE_COL);
  return token.slice(0,hash)+(lineCol?lineCol[0]:'');
}

/**
 * Cuts `value` to `max` characters (dropping a partial trailing token), then
 * redacts URL fragments, secret-looking pairs and JSON keys, credentials,
 * user agents, JWTs, email addresses and IP addresses.
 */
export function redactLogText(value,max=TEXT_MAX){
  return cut(value==null?'':String(value),max)
    .replace(ENCODED,code=>DECODED[code.slice(-2).toLowerCase()])
    .replace(TOKEN,stripFragment)
    .replace(AUTH_HEADER,'$1$2[redacted]')
    .replace(AUTH_SCHEME,'$1 [redacted]')
    .replace(SECRET_PAIR,'$1$2=$3[redacted]')
    .replace(SECRET_JSON,'$1"[redacted]"')
    .replace(SECRET_ESCAPED_JSON,'$1\\"[redacted]\\"')
    .replace(SECRET_COLON,'$1$2[redacted]')
    .replace(CODE_COLON,'$1$2[redacted]')
    .replace(CLIENT_COLON,'$1$2[redacted]')
    .replace(USER_AGENT,'[user agent]')
    .replace(JWT,'$1[jwt]')
    .replace(EMAIL,'[email]')
    .replace(ADDRESS,redactAddress);
}

function redactNode(value,depth,budget){
  if(budget.left<=0) return '[truncated]';
  if(typeof value==='string'){
    const max=Math.min(budget.left,TEXT_MAX);
    budget.left-=Math.min(value.length,max)+1;
    return redactLogText(value,max);
  }
  budget.left-=1;
  if(value===null||value===undefined||typeof value==='number'||typeof value==='boolean') return value;
  if(value instanceof Error) return redactNode(value.stack||String(value),depth,budget);
  if(typeof value!=='object') return redactNode(String(value),depth,budget);
  if(depth>=VALUE_MAX_DEPTH) return '[truncated]';
  if(Array.isArray(value)) return value.slice(0,VALUE_MAX_ITEMS).map(item=>redactNode(item,depth+1,budget));
  const copy={};
  for(const key of Object.keys(value).slice(0,VALUE_MAX_KEYS)){
    budget.left-=key.length;
    copy[key]=SECRET_KEY.test(key)?'[redacted]':redactNode(value[key],depth+1,budget);
  }
  return copy;
}

/**
 * Redacts a bounded copy of `value`: depth 4, 30 keys and 20 items per level,
 * and 16k characters in total, after which values become '[truncated]'.
 * Secret-named keys lose their value.
 */
export function redactLogValue(value){
  return redactNode(value,0,{left:VALUE_BUDGET});
}

/** Stored meta_json longer than this becomes a valid JSON preview wrapper. */
export const CLIENT_LOG_META_MAX=8000;

/** Keeps stored meta valid JSON: an oversized value is wrapped, not cut mid-structure. */
export function clientLogMetaJson(text){
  return text.length<=CLIENT_LOG_META_MAX?text:JSON.stringify({truncated:true,preview:text.slice(0,7000)});
}

/** Serialized size of an already parsed body, for requests without content-length. */
export function clientLogBodyBytes(body){
  try{ return Buffer.byteLength(JSON.stringify(body??null)??''); }
  catch{ return Infinity; }
}

/** A logged route keeps pathname and search only. */
export function redactLogRoute(value){
  return redactLogText(String(value??'').split('#')[0],300);
}

/** Vercel production only: previews and local runtimes keep every level. */
export function clientLogLevelAccepted(level,env=process.env){
  return env.VERCEL_ENV!=='production'||CLIENT_LOG_PRODUCTION_LEVELS.includes(level);
}
