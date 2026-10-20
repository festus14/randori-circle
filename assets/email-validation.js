// Shared email address rules for the browser and the API (ID-68).
//
// One dependency-free ES module so the client and the server can never drift:
// `api/_circle-membership.js` imports it for every path that accepts a *new*
// address (owner invitations, bulk invitations, invite requests, password
// sign-up), and index.html loads it as `<script type="module">` so the
// invite forms, the sign-up dialog and the landing request form show the same
// verdict inline before anything is sent. The server always re-validates.
//
// Canonical form is exactly what the server has always stored and compared:
// `trim()` then `toLowerCase()`. Validation never rewrites an address beyond
// that, so an existing account or invitation keeps normalising identically.
//
// The rules are deliberately conservative (a strict subset of RFC 5321):
//   - total length ≤ 254, exactly one `@`
//   - local part 1–64 of [a-z0-9.!#$%&'*+/=?^_`{|}~-], no leading, trailing
//     or consecutive dots (no quoted local parts)
//   - domain: ≥ 2 labels of 1–63 [a-z0-9-], no label starts or ends with `-`,
//     top-level label alphabetic (≥ 2) or an `xn--` punycode label
//   - no whitespace, control, zero-width or bidi characters anywhere and no
//     non-ASCII (international domains must be entered as punycode)

export const EMAIL_MAX_LENGTH = 254;
export const EMAIL_LOCAL_MAX_LENGTH = 64;
export const EMAIL_LABEL_MAX_LENGTH = 63;
/** Most addresses one bulk invitation request may carry. */
export const BULK_INVITE_MAX = 50;
/** Paste input beyond this many characters is ignored (and reported). */
export const BULK_INVITE_INPUT_MAX = 20000;
/** Candidate tokens beyond this many are ignored (and reported). */
export const BULK_INVITE_TOKEN_MAX = 500;

const LOCAL_CHARS = /^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+$/;
const LABEL_CHARS = /^[a-z0-9-]+$/;
const ALPHA_TLD = /^[a-z]{2,63}$/;
const PUNYCODE_TLD = /^xn--[a-z0-9-]{1,59}$/;
// C0/C1 controls, any Unicode whitespace, zero-width characters, the BOM,
// and every bidirectional formatting/override/isolate mark.
const UNSAFE_CHARS = /[\u0000-\u001f\u007f-\u009f\s\u00ad\u061c\u180e\u200b-\u200f\u202a-\u202e\u2060-\u2064\u2066-\u2069\ufeff]/u;
const NON_ASCII = /[^\x00-\x7f]/;
// Invisible characters that copy-paste commonly leaves around an address.
const EDGE_INVISIBLES = /^[\u00ad\u061c\u180e\u200b-\u200f\u202a-\u202e\u2060-\u2064\u2066-\u2069\ufeff]+|[\u00ad\u061c\u180e\u200b-\u200f\u202a-\u202e\u2060-\u2064\u2066-\u2069\ufeff]+$/gu;

export const EMAIL_REASONS = Object.freeze([
  'invalid_type', 'empty', 'invalid_characters', 'too_long', 'non_ascii', 'missing_at', 'multiple_at',
  'local_empty', 'local_too_long', 'local_invalid', 'local_dots', 'domain_missing', 'domain_no_dot',
  'domain_empty_label', 'domain_label_too_long', 'domain_invalid', 'domain_hyphen', 'tld_invalid',
]);

const MESSAGES = Object.freeze({
  invalid_type: 'Enter an email address.',
  empty: 'Enter an email address.',
  invalid_characters: 'Remove spaces or hidden characters from the address.',
  too_long: `Email addresses can be at most ${EMAIL_MAX_LENGTH} characters.`,
  non_ascii: 'Use plain letters and digits. Enter international domains in their xn-- form.',
  missing_at: 'This address is missing the @ sign.',
  multiple_at: 'Use exactly one @ sign.',
  local_empty: 'Add the name before the @.',
  local_too_long: `The part before the @ can be at most ${EMAIL_LOCAL_MAX_LENGTH} characters.`,
  local_invalid: 'The part before the @ has a character email addresses can’t use.',
  local_dots: 'Dots can’t start, end, or repeat before the @.',
  domain_missing: 'Add the domain after the @, like example.com.',
  domain_no_dot: 'The domain needs a dot, like example.com.',
  domain_empty_label: 'The domain has an empty part (two dots in a row or a trailing dot).',
  domain_label_too_long: `Each part of the domain can be at most ${EMAIL_LABEL_MAX_LENGTH} characters.`,
  domain_invalid: 'The domain can use only letters, digits, hyphens, and dots.',
  domain_hyphen: 'Parts of the domain can’t start or end with a hyphen.',
  tld_invalid: 'The ending of the domain doesn’t look right (like .com or .org).',
});

/** `trim()` + `toLowerCase()`: the one canonical form for comparison and storage. */
export function canonicalEmail(value) {
  return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

function failure(reason) {
  return Object.freeze({ ok: false, email: null, reason });
}

function domainProblem(domain) {
  if (!domain) return 'domain_missing';
  const labels = domain.split('.');
  if (labels.some(label => label.length === 0)) return 'domain_empty_label';
  if (labels.length < 2) return 'domain_no_dot';
  for (const label of labels) {
    if (label.length > EMAIL_LABEL_MAX_LENGTH) return 'domain_label_too_long';
    if (!LABEL_CHARS.test(label)) return 'domain_invalid';
    if (label.startsWith('-') || label.endsWith('-')) return 'domain_hyphen';
  }
  const tld = labels[labels.length - 1];
  return ALPHA_TLD.test(tld) || PUNYCODE_TLD.test(tld) ? null : 'tld_invalid';
}

/**
 * Validate one address. Returns `{ok:true,email,reason:null}` with the
 * canonical address, or `{ok:false,email:null,reason}` where `reason` is one of
 * EMAIL_REASONS (stable codes for UI copy and API responses).
 */
export function validateEmail(value) {
  if (typeof value !== 'string') return failure('invalid_type');
  const email = canonicalEmail(value);
  if (!email) return failure('empty');
  if (UNSAFE_CHARS.test(email)) return failure('invalid_characters');
  if (email.length > EMAIL_MAX_LENGTH) return failure('too_long');
  if (NON_ASCII.test(email)) return failure('non_ascii');
  const at = email.indexOf('@');
  if (at === -1) return failure('missing_at');
  if (email.indexOf('@', at + 1) !== -1) return failure('multiple_at');
  const local = email.slice(0, at);
  const domain = email.slice(at + 1);
  if (!local) return failure('local_empty');
  if (local.length > EMAIL_LOCAL_MAX_LENGTH) return failure('local_too_long');
  if (!LOCAL_CHARS.test(local)) return failure('local_invalid');
  if (local.startsWith('.') || local.endsWith('.') || local.includes('..')) return failure('local_dots');
  const problem = domainProblem(domain);
  if (problem) return failure(problem);
  return Object.freeze({ ok: true, email, reason: null });
}

/** Canonical address when valid, otherwise `null`. */
export function normalizeEmail(value) {
  return validateEmail(value).email;
}

export function isValidEmail(value) {
  return validateEmail(value).ok;
}

/** Human copy for a reason code; unknown codes fall back to a generic line. */
export function emailProblemMessage(reason) {
  return MESSAGES[reason] || 'Enter a valid email address, like name@example.com.';
}

// ------------------------------------------------------------------ parser

const SEPARATORS = new Set([',', ';', '\n', '\r', '\t']);
const WRAPPING = /^[\s"'(<[{]+|[\s"')>\]}]+$/gu;

function cleanToken(value) {
  let token = String(value).replace(EDGE_INVISIBLES, '').trim();
  token = token.replace(WRAPPING, '');
  if (/^mailto:/i.test(token)) token = token.slice(7).split('?')[0];
  return token.replace(EDGE_INVISIBLES, '').trim();
}

// Split pasted text into top-level entries on commas, semicolons, tabs and
// newlines, ignoring separators inside "quoted names" and <angle brackets>.
function splitEntries(text) {
  const entries = [];
  let current = '';
  let quoted = false;
  let angled = false;
  for (const char of text) {
    if (char === '"' && !angled) quoted = !quoted;
    else if (char === '<' && !quoted) angled = true;
    else if (char === '>' && !quoted) angled = false;
    if (!quoted && !angled && SEPARATORS.has(char)) {
      entries.push(current);
      current = '';
    } else {
      current += char;
    }
    // A line break always ends an unterminated quote or bracket so one stray
    // character cannot swallow the rest of a pasted column.
    if (char === '\n') { quoted = false; angled = false; }
  }
  entries.push(current);
  return entries;
}

// `Name <a@b.c>` and `"Last, First" <a@b.c>` yield the bracketed address;
// anything else is split on whitespace into candidate addresses.
function entryCandidates(entry) {
  const bracketed = [...entry.matchAll(/<([^<>]*)>/g)].map(match => match[1]);
  if (bracketed.length) return bracketed;
  return entry.split(/\s+/u);
}

/**
 * Parse pasted text (commas, semicolons, spaces, newlines, `Name <email>`)
 * into a de-duplicated preview. Every distinct candidate appears once, in
 * first-seen order, with its validation verdict and how often it occurred.
 *
 * Returns `{entries,valid,invalid,duplicates,total,overLimit,truncated,max}`
 * where `valid` lists canonical addresses to send and `overLimit` is true when
 * there are more than `max` of them (the request must then be blocked).
 */
export function parseEmailList(text, { max = BULK_INVITE_MAX } = {}) {
  const source = typeof text === 'string' ? text : '';
  let truncated = source.length > BULK_INVITE_INPUT_MAX;
  const tokens = [];
  for (const entry of splitEntries(source.slice(0, BULK_INVITE_INPUT_MAX))) {
    for (const candidate of entryCandidates(entry)) {
      const token = cleanToken(candidate);
      if (!token) continue;
      if (tokens.length >= BULK_INVITE_TOKEN_MAX) { truncated = true; break; }
      tokens.push(token);
    }
  }
  const byKey = new Map();
  const entries = [];
  let duplicates = 0;
  for (const raw of tokens) {
    const verdict = validateEmail(raw);
    const key = verdict.ok ? verdict.email : `raw:${canonicalEmail(raw)}`;
    const existing = byKey.get(key);
    if (existing) {
      existing.occurrences += 1;
      duplicates += 1;
      continue;
    }
    const item = { raw, email: verdict.email, valid: verdict.ok, reason: verdict.reason, occurrences: 1 };
    byKey.set(key, item);
    entries.push(item);
  }
  const frozen = entries.map(item => Object.freeze({ ...item }));
  const valid = frozen.filter(item => item.valid).map(item => item.email);
  return Object.freeze({
    entries: Object.freeze(frozen),
    valid: Object.freeze(valid),
    invalid: Object.freeze(frozen.filter(item => !item.valid)),
    duplicates,
    total: tokens.length,
    overLimit: valid.length > max,
    truncated,
    max,
  });
}

const api = Object.freeze({
  BULK_INVITE_INPUT_MAX,
  BULK_INVITE_MAX,
  BULK_INVITE_TOKEN_MAX,
  EMAIL_LABEL_MAX_LENGTH,
  EMAIL_LOCAL_MAX_LENGTH,
  EMAIL_MAX_LENGTH,
  EMAIL_REASONS,
  canonicalEmail,
  emailProblemMessage,
  isValidEmail,
  normalizeEmail,
  parseEmailList,
  validateEmail,
});

// Classic scripts in index.html (auth dialog, landing form, circle view) read
// the same functions from this global once the module has loaded.
if (typeof window !== 'undefined' && window && !window.RandoriEmailValidation) {
  window.RandoriEmailValidation = api;
}

export default api;
