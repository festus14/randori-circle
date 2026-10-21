// Client log policy for POST /api/logs (ID-72).
//
// The browser logger in index.html applies the same redaction before an entry
// is mirrored, queued or sent; this copy is the server-side backstop for any
// other client. tests/unit/client-logger.test.mjs runs both over one corpus,
// so keep the patterns below identical to the inline `redactText` there.

/** Production accepts only these client levels; info/success/debug stay in the browser. */
export const CLIENT_LOG_PRODUCTION_LEVELS=Object.freeze(['warn','error']);

const TEXT_SCAN_MAX=8000;
const VALUE_MAX_DEPTH=4;
const VALUE_MAX_KEYS=30;
const VALUE_MAX_ITEMS=20;

// A URL fragment carries invite, reset and verify tokens. Within each
// whitespace/quote/paren-delimited token that has a '/' before its '#', drop
// the fragment but keep a trailing stack-frame :line:col. Token-wise matching
// keeps every pattern here linear in the input length.
const TOKEN=/[^\s"'<>()\\]+/g;
const LINE_COL=/(?::\d+){1,2}$/;
// name=value pairs whose name looks secret (query strings, assignments, bare fragments).
const SECRET_PAIR=/(^|[^a-z0-9_])((?:[a-z0-9]+[_-])?(?:token|invite|code|secret|password|passwd|pwd|key|signature|sig|session|auth|authorization|cookie|otp|credential)s?)=([^\s&#"'<>,;()\\]+)/gi;
// The same names as quoted JSON keys inside a message ("token":"...").
const SECRET_JSON=/("(?:[a-z0-9]+[_-])?(?:token|invite|code|secret|password|passwd|pwd|key|signature|sig|session|auth|authorization|cookie|otp|credential)s?"\s*:\s*)"(?:[^"\\]|\\.)*"/gi;
const AUTH_SCHEME=/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/gi;
const JWT=/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]*/g;
const EMAIL=/[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9-]{1,63}(?:\.[A-Za-z0-9-]{1,63})*\.[A-Za-z]{2,63}/g;
// Object keys whose value is dropped whole.
const SECRET_KEY=/token|secret|passw|pwd|authorization|cookie|credential|signature|invite|session|^(?:code|key|sig|auth|otp)$/i;

function stripFragment(token){
  const hash=token.indexOf('#');
  if(hash<1||token.lastIndexOf('/',hash)===-1) return token;
  const lineCol=token.slice(hash).match(LINE_COL);
  return token.slice(0,hash)+(lineCol?lineCol[0]:'');
}

/** Redacts URL fragments, secret-looking name=value pairs, bearer tokens, JWTs and email addresses. */
export function redactLogText(value){
  return String(value==null?'':value).slice(0,TEXT_SCAN_MAX)
    .replace(TOKEN,stripFragment)
    .replace(SECRET_PAIR,'$1$2=[redacted]')
    .replace(SECRET_JSON,'$1"[redacted]"')
    .replace(AUTH_SCHEME,'$1 [redacted]')
    .replace(JWT,'[jwt]')
    .replace(EMAIL,'[email]');
}

/** Redacts every string in a bounded copy of `value`; secret-named keys lose their value. */
export function redactLogValue(value,depth=0){
  if(typeof value==='string') return redactLogText(value);
  if(value===null||value===undefined||typeof value==='number'||typeof value==='boolean') return value;
  if(value instanceof Error) return redactLogText(value.stack||String(value));
  if(typeof value!=='object') return redactLogText(value);
  if(depth>=VALUE_MAX_DEPTH) return '[truncated]';
  if(Array.isArray(value)) return value.slice(0,VALUE_MAX_ITEMS).map(item=>redactLogValue(item,depth+1));
  const copy={};
  for(const key of Object.keys(value).slice(0,VALUE_MAX_KEYS)){
    copy[key]=SECRET_KEY.test(key)?'[redacted]':redactLogValue(value[key],depth+1);
  }
  return copy;
}

/** A logged route keeps pathname and search only. */
export function redactLogRoute(value){
  return redactLogText(String(value??'').split('#')[0]);
}

/** Vercel production only: previews and local runtimes keep every level. */
export function clientLogLevelAccepted(level,env=process.env){
  return env.VERCEL_ENV!=='production'||CLIENT_LOG_PRODUCTION_LEVELS.includes(level);
}
