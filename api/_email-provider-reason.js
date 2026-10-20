// Bounded, PII-free description of why the email provider (Resend) refused a
// send. Resend error messages can quote recipient or sender addresses, so the
// raw message is never returned or stored: only the HTTP status, Resend's
// allowlisted error `name`, and a short reason code chosen by matching known
// Resend phrases leave this module.

export const EMAIL_PROVIDER_REASON_CODES=Object.freeze([
  'testing_recipient_restricted',
  'domain_not_verified',
  'invalid_from_address',
  'invalid_recipient',
  'api_key_invalid',
  'api_key_missing',
  'api_key_restricted',
  'quota_exceeded',
  'rate_limited',
  'idempotency_conflict',
  'missing_required_field',
  'other',
]);

// Resend's documented error names (ErrorResponse.name), plus quota names it
// returns in practice. Anything else is reported as `other`.
const RESEND_ERROR_NAMES=new Set([
  'missing_required_field','invalid_idempotency_key','invalid_idempotent_request',
  'concurrent_idempotent_requests','invalid_access','invalid_parameter','invalid_region',
  'rate_limit_exceeded','missing_api_key','invalid_api_key','invalid_from_address',
  'validation_error','not_found','method_not_allowed','application_error','internal_server_error',
  'daily_quota_exceeded','monthly_quota_exceeded','security_error','invalid_attachment',
]);

// Ordered: the testing-mode message also says "verify a domain", so it must be
// matched before the unverified-domain phrase.
const PHRASES=Object.freeze([
  [/you can only send testing emails to your own email address/u,'testing_recipient_restricted'],
  [/domain is not verified|domain (?:has )?not (?:been )?verified|verify (?:your|a) domain/u,'domain_not_verified'],
  [/invalid [`'"]?from[`'"]? field/u,'invalid_from_address'],
  [/invalid [`'"]?(?:to|cc|bcc|reply_?to)[`'"]? field/u,'invalid_recipient'],
  [/api key is invalid|invalid api key/u,'api_key_invalid'],
  [/missing api key/u,'api_key_missing'],
  [/restricted to only send emails|restricted api key/u,'api_key_restricted'],
  [/quota/u,'quota_exceeded'],
  [/too many requests|rate limit/u,'rate_limited'],
  [/idempoten/u,'idempotency_conflict'],
  [/field is missing|missing required field|missing [`'"][a-z_]+[`'"] field/u,'missing_required_field'],
]);

const FORMATTED_PATTERN=/^([1-5]\d\d):([a-z_]{1,40}):([a-z_]{1,32})$/u;
const REASON_SET=new Set(EMAIL_PROVIDER_REASON_CODES);

function providerStatus(error){
  const status=Number(error?.statusCode??error?.status??error?.response?.status??error?.error?.statusCode);
  return Number.isSafeInteger(status)&&status>=400&&status<=599?status:null;
}

function providerName(error){
  const name=String(error?.name??error?.error?.name??'').trim().toLowerCase();
  return RESEND_ERROR_NAMES.has(name)?name:'other';
}

export function emailProviderReasonCode(message){
  // Bound the scanned text; known phrases appear at the start of the message.
  const text=String(message??'').slice(0,512).toLowerCase();
  for(const [pattern,reason] of PHRASES){
    if(pattern.test(text)) return reason;
  }
  return 'other';
}

/**
 * Describe a provider 4xx/5xx response. Returns null for anything that is not
 * an HTTP provider error (network failures, timeouts, internal errors).
 */
export function describeEmailProviderError(error){
  if(!error||typeof error!=='object') return null;
  const status=providerStatus(error);
  if(status===null) return null;
  const name=providerName(error);
  const reason=emailProviderReasonCode(error?.message??error?.error?.message);
  return Object.freeze({status,name,reason,code:`${status}:${name}:${reason}`});
}

// The `status:name:reason` audit code for a provider error, or null.
export function emailProviderReason(error){
  return describeEmailProviderError(error)?.code??null;
}

export function parseEmailProviderReason(value){
  const match=FORMATTED_PATTERN.exec(String(value??''));
  if(!match||!REASON_SET.has(match[3])) return null;
  const name=RESEND_ERROR_NAMES.has(match[2])?match[2]:'other';
  return Object.freeze({status:Number(match[1]),name,reason:match[3],code:`${match[1]}:${name}:${match[3]}`});
}
