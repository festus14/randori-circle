const GLOBAL_SENSITIVE_KEYS = new Set([
  'access_token',
  'api_key',
  'auth',
  'auth_token',
  'authorization',
  'cookie',
  'cookies',
  'email',
  'fragment',
  'http_fragment',
  'ip_address',
  'password',
  'passwd',
  'phone',
  'phone_number',
  'query',
  'query_params',
  'query_string',
  'querystring',
  'refresh_token',
  'secret',
  'set_cookie',
  'token',
  'user',
  'user_id',
  'userid',
  'username',
  'url_fragment',
  'user_segment',
  'vars',
]);

const REQUEST_PAYLOAD_KEYS = new Set([
  'body',
  'cookies',
  'data',
  'form_data',
  'headers',
  'query',
  'query_params',
  'query_string',
  'querystring',
  'request_body',
  'request_data',
  'search_params',
]);

const APP_EXTRA_PAYLOAD_KEYS = new Set([
  'code',
  'meta',
  'metadata',
  'source_code',
  'transcript',
]);

const SENTRY_PROTOCOL_KEYS = new Set([
  'event_id',
  'parent_span_id',
  'public_key',
  'replay_id',
  'sample_rand',
  'sample_rate',
  'span_id',
  'trace_id',
]);

function normalizeKey(key) {
  return String(key)
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/[^a-z0-9]+/gi, '_')
    .replace(/^_+|_+$/g, '')
    .toLowerCase();
}

function hasPathSegment(path, segment) {
  return path.some(part => normalizeKey(part) === segment);
}

function isSensitiveKey(key, parentPath) {
  const normalized = normalizeKey(key);
  if (GLOBAL_SENSITIVE_KEYS.has(normalized)) return true;
  if (/(?:^|_)(?:access_token|api_key|auth_token|refresh_token|token)(?:_|$)/.test(normalized)) return true;
  if (/(?:^|_)(?:auth|authorization|cookie|email|phone|secret|password|passwd)(?:_|$)/.test(normalized)) return true;
  if (/(?:^|_)(?:end)?user_?id(?:_|$)/.test(normalized)) return true;
  if (/(?:^|_)(?:query|search)_?(?:params|string)?(?:_|$)/.test(normalized)) return true;
  if (hasPathSegment(parentPath, 'request') && REQUEST_PAYLOAD_KEYS.has(normalized)) return true;
  return parentPath[0] === 'extra' && APP_EXTRA_PAYLOAD_KEYS.has(normalized);
}

function isUrlKey(key) {
  const normalized = normalizeKey(key);
  return normalized === 'route'
    || normalized === 'transaction'
    || normalized === 'url'
    || normalized.startsWith('url_')
    || normalized.endsWith('_url');
}

function sanitizeSdkProcessingMetadata(value, path, seen) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  const dynamicSamplingContext = value.dynamicSamplingContext;
  if (!dynamicSamplingContext || typeof dynamicSamplingContext !== 'object' || Array.isArray(dynamicSamplingContext)) {
    return value;
  }
  return {
    ...value,
    dynamicSamplingContext: sanitizeValue(
      dynamicSamplingContext,
      [...path, 'sdk_processing_metadata', 'dynamic_sampling_context'],
      seen,
    ),
  };
}

function stripUrlDetails(value) {
  const text = String(value);
  const queryIndex = text.indexOf('?');
  const hashIndex = text.indexOf('#');
  const end = [queryIndex, hashIndex].filter(index => index >= 0).sort((a, b) => a - b)[0];
  return end === undefined ? text : text.slice(0, end);
}

export function redactSentryText(value) {
  return String(value)
    .replace(/\bBearer\s+[^\s,;]+/gi, 'Bearer [REDACTED]')
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, '[REDACTED_JWT]')
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, '[REDACTED_EMAIL]')
    .replace(/(?:\+?\d[\d ().-]{7,}\d)/g, '[REDACTED_PHONE]')
    .replace(/\b(authorization|auth(?:_token)?|access_token|refresh_token|token|api_?key|secret|password|cookie|email|phone|user_?id|transcript|code|meta)\b\s*[:=]\s*(?:"[^"]*"|'[^']*'|[^\s,;&]+)/gi, '$1=[REDACTED]')
    .replace(/(https?:\/\/[^\s?#]+)[?#][^\s]*/gi, '$1');
}

function sanitizeValue(value, path, seen) {
  if (typeof value === 'function') return undefined;
  if (typeof value === 'string') {
    const key = normalizeKey(path[path.length - 1]);
    if (SENTRY_PROTOCOL_KEYS.has(key)) return value;
    return isUrlKey(key) ? stripUrlDetails(redactSentryText(value)) : redactSentryText(value);
  }
  if (value === null || typeof value !== 'object') return value;
  if (seen.has(value)) return '[Circular]';

  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null && !Array.isArray(value)) return value;

  seen.add(value);
  if (Array.isArray(value)) {
    const result = value.map(item => sanitizeValue(item, path, seen));
    seen.delete(value);
    return result;
  }

  const result = {};
  for (const [key, childValue] of Object.entries(value)) {
    const normalized = normalizeKey(key);
    if (normalized === 'sdk_processing_metadata') {
      result[key] = sanitizeSdkProcessingMetadata(childValue, path, seen);
      continue;
    }
    if (isSensitiveKey(key, path)) continue;
    const sanitized = sanitizeValue(childValue, [...path, normalized], seen);
    if (sanitized !== undefined) result[key] = sanitized;
  }
  seen.delete(value);
  return result;
}

export function sanitizeSentryEvent(event) {
  return sanitizeValue(event, [], new WeakSet());
}

export function sanitizeSentryContext(context) {
  if (!context || typeof context !== 'object' || Array.isArray(context)) return {};
  return sanitizeValue(context, [], new WeakSet()) || {};
}
