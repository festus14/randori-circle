import assert from 'node:assert/strict';
import { test } from 'node:test';

import rules, {
  BULK_INVITE_INPUT_MAX,
  BULK_INVITE_MAX,
  BULK_INVITE_TOKEN_MAX,
  EMAIL_REASONS,
  canonicalEmail,
  emailProblemMessage,
  isValidEmail,
  normalizeEmail,
  parseEmailList,
  validateEmail,
} from '../../assets/email-validation.js';
import { normalizeInvitationEmail, normalizeNewInvitationEmail, validateNewEmail } from '../../api/_circle-membership.js';

const label63 = 'a'.repeat(63);

const GOOD = [
  ['plain', 'name@example.com', 'name@example.com'],
  ['trim and lowercase', '  Foo.Bar@Example.COM \n', 'foo.bar@example.com'],
  ['plus addressing', 'Ada+circle@example.co.uk', 'ada+circle@example.co.uk'],
  ['every allowed local symbol', "a.b!#$%&'*+/=?^_`{|}~-@example.org", "a.b!#$%&'*+/=?^_`{|}~-@example.org"],
  ['digits and hyphen in labels', '1@mail-1.example.io', '1@mail-1.example.io'],
  ['IDN punycode domain and TLD', 'a@xn--bcher-kva.xn--p1ai', 'a@xn--bcher-kva.xn--p1ai'],
  ['64-character local part', `${'l'.repeat(64)}@example.com`, `${'l'.repeat(64)}@example.com`],
  ['63-character label', `a@${label63}.com`, `a@${label63}.com`],
  ['reserved test TLD', 'invitee@example.test', 'invitee@example.test'],
  ['254 characters', `a@${[label63, label63, label63, 'b'.repeat(56)].join('.')}.com`,
    `a@${[label63, label63, label63, 'b'.repeat(56)].join('.')}.com`],
];

const BAD = [
  ['non-string', 42, 'invalid_type'],
  ['null', null, 'invalid_type'],
  ['empty', '', 'empty'],
  ['whitespace only', '   ', 'empty'],
  ['inner space', 'a b@example.com', 'invalid_characters'],
  ['tab', 'a\t@example.com', 'invalid_characters'],
  ['control character', 'a\u0007@example.com', 'invalid_characters'],
  ['zero-width space', 'a\u200b@example.com', 'invalid_characters'],
  ['bidi override', 'a\u202e@example.com', 'invalid_characters'],
  ['bidi isolate', 'a@exa\u2066mple.com', 'invalid_characters'],
  ['over 254', `a@${[label63, label63, label63, 'b'.repeat(57)].join('.')}.com`, 'too_long'],
  ['unicode local part', 'jürgen@example.com', 'non_ascii'],
  ['unicode domain (not punycode)', 'a@bücher.de', 'non_ascii'],
  ['cyrillic look-alike', 'pаypal@example.com', 'non_ascii'],
  ['no @', 'example.com', 'missing_at'],
  ['two @', 'a@b@example.com', 'multiple_at'],
  ['empty local', '@example.com', 'local_empty'],
  ['65-character local part', `${'l'.repeat(65)}@example.com`, 'local_too_long'],
  ['quoted local part', '"a b"@example.com', 'invalid_characters'],
  ['comma in local part', 'a,b@example.com', 'local_invalid'],
  ['parenthesis', 'a(b)@example.com', 'local_invalid'],
  ['leading dot', '.a@example.com', 'local_dots'],
  ['trailing dot in local', 'a.@example.com', 'local_dots'],
  ['consecutive dots', 'a..b@example.com', 'local_dots'],
  ['no domain', 'a@', 'domain_missing'],
  ['single-label domain', 'a@localhost', 'domain_no_dot'],
  ['trailing dot in domain', 'a@example.com.', 'domain_empty_label'],
  ['leading dot in domain', 'a@.example.com', 'domain_empty_label'],
  ['double dot in domain', 'a@example..com', 'domain_empty_label'],
  ['64-character label', `a@${'a'.repeat(64)}.com`, 'domain_label_too_long'],
  ['underscore in domain', 'a@ex_ample.com', 'domain_invalid'],
  ['label starts with hyphen', 'a@-example.com', 'domain_hyphen'],
  ['label ends with hyphen', 'a@example-.com', 'domain_hyphen'],
  ['numeric TLD', 'a@example.123', 'tld_invalid'],
  ['one-letter TLD', 'a@example.c', 'tld_invalid'],
  ['IP literal', 'a@[127.0.0.1]', 'domain_invalid'],
  ['mixed TLD', 'a@example.c0m', 'tld_invalid'],
];

test('valid addresses normalise to trim+lowercase and nothing else', () => {
  assert.equal(GOOD.at(-1)[2].length, 254);
  assert.equal(BAD.find(([name]) => name === 'over 254')[1].length, 255);
  for (const [name, input, expected] of GOOD) {
    const verdict = validateEmail(input);
    assert.deepEqual({ ...verdict }, { ok: true, email: expected, reason: null }, name);
    assert.equal(normalizeEmail(input), expected, name);
    assert.equal(isValidEmail(input), true, name);
    assert.equal(canonicalEmail(input), expected, `${name}: canonical form is unchanged by validation`);
  }
});

test('invalid addresses return a stable reason code and human copy', () => {
  for (const [name, input, reason] of BAD) {
    const verdict = validateEmail(input);
    assert.deepEqual({ ...verdict }, { ok: false, email: null, reason }, name);
    assert.equal(normalizeEmail(input), null, name);
    assert.equal(isValidEmail(input), false, name);
    assert.ok(EMAIL_REASONS.includes(reason), `${name}: ${reason} is a documented reason`);
    assert.ok(emailProblemMessage(reason).length > 10, name);
  }
  assert.ok(Object.isFrozen(validateEmail('a@example.com')) && Object.isFrozen(validateEmail('bad')));
});

test('every reason code has dedicated copy and unknown codes fall back', () => {
  const generic = emailProblemMessage('nope');
  assert.match(generic, /valid email address/);
  for (const reason of EMAIL_REASONS) assert.notEqual(emailProblemMessage(reason), generic, reason);
  assert.equal(canonicalEmail(7), '');
});

test('the server re-uses the shared module and keeps legacy identities matching', () => {
  // New addresses are strict on the server exactly as in the browser.
  for (const [, input, expected] of GOOD) assert.equal(normalizeNewInvitationEmail(input), expected);
  for (const [, input, reason] of BAD) {
    assert.equal(normalizeNewInvitationEmail(input), null);
    assert.equal(validateNewEmail(input).reason, reason);
  }
  // Existing addresses keep the identical canonical form, so lookups, hashes,
  // and sign-in for accounts created before ID-68 never change.
  for (const [, input, expected] of GOOD) assert.equal(normalizeInvitationEmail(input), expected);
  for (const legacy of ['a@b.c', 'a..b@example.com', 'jürgen@example.com', 'A@Example.COM.']) {
    assert.equal(normalizeInvitationEmail(legacy), legacy.trim().toLowerCase(), legacy);
  }
  assert.equal(normalizeInvitationEmail(7), null);
  assert.equal(normalizeInvitationEmail('no-at-sign'), null);
});

test('the default export is the frozen named API and installs a browser global once', async () => {
  assert.ok(Object.isFrozen(rules));
  assert.equal(rules.validateEmail, validateEmail);
  assert.equal(rules.BULK_INVITE_MAX, 50);
  assert.equal(globalThis.RandoriEmailValidation, undefined, 'no global without window');
  globalThis.window = globalThis;
  try {
    const fresh = await import(`../../assets/email-validation.js?browser=${Date.now()}`);
    assert.equal(globalThis.RandoriEmailValidation, fresh.default);
    const again = await import(`../../assets/email-validation.js?browser-again=${Date.now()}`);
    assert.equal(globalThis.RandoriEmailValidation, fresh.default, 'an existing global is not replaced');
    assert.notEqual(again.default, fresh.default);
  } finally {
    delete globalThis.RandoriEmailValidation;
    delete globalThis.window;
  }
});

test('parser splits commas, semicolons, spaces, tabs and newlines', () => {
  const parsed = parseEmailList('a@example.com, b@example.com;c@example.com d@example.com\te@example.com\r\nf@example.com\n\n');
  assert.deepEqual(parsed.valid, ['a', 'b', 'c', 'd', 'e', 'f'].map(name => `${name}@example.com`));
  assert.equal(parsed.total, 6);
  assert.deepEqual([parsed.duplicates, parsed.invalid.length, parsed.overLimit, parsed.truncated, parsed.max],
    [0, 0, false, false, BULK_INVITE_MAX]);
});

test('parser reads Name <email> forms from mail apps and spreadsheets', () => {
  const parsed = parseEmailList([
    'Ada Lovelace <ADA@Example.com>, "Hopper, Grace" <grace@example.com>',
    "'Alan Turing' <alan@example.com>; Linus <linus@example.com>",
    'mailto:ken@example.com?subject=hi',
    '(dennis@example.com)',
    '"Unclosed quote, still fine',
    'margaret@example.com',
    'Broken <bracket@example.com',
    '\u200bbjarne@example.com\u200e',
  ].join('\n'));
  assert.deepEqual(parsed.valid, ['ada@example.com', 'grace@example.com', 'alan@example.com', 'linus@example.com',
    'ken@example.com', 'dennis@example.com', 'margaret@example.com', 'bracket@example.com', 'bjarne@example.com']);
  assert.deepEqual(parsed.invalid.map(item => [item.raw, item.reason]), [
    // An unclosed quote holds commas until the end of its line, never beyond.
    ['Unclosed', 'missing_at'], ['quote,', 'missing_at'], ['still', 'missing_at'], ['fine', 'missing_at'], ['Broken', 'missing_at'],
  ]);
  assert.equal(parsed.entries[0].raw, 'ADA@Example.com', 'the preview keeps what was pasted');
});

test('parser collapses duplicates after normalisation and keeps first-seen order', () => {
  const parsed = parseEmailList('B@example.com\nb@example.com, a@example.com\n  b@EXAMPLE.com bad bad');
  assert.deepEqual(parsed.valid, ['b@example.com', 'a@example.com']);
  assert.deepEqual(parsed.entries.map(item => [item.raw, item.occurrences]),
    [['B@example.com', 3], ['a@example.com', 1], ['bad', 2]]);
  assert.equal(parsed.duplicates, 3);
  assert.equal(parsed.invalid.length, 1);
  assert.ok(Object.isFrozen(parsed) && Object.isFrozen(parsed.entries) && Object.isFrozen(parsed.entries[0]));
});

test('parser blocks more than the maximum and bounds hostile input', () => {
  const many = Array.from({ length: 51 }, (_, index) => `p${index}@example.com`).join('\n');
  const over = parseEmailList(many);
  assert.equal(over.valid.length, 51);
  assert.equal(over.overLimit, true);
  assert.equal(parseEmailList(many, { max: 60 }).overLimit, false);

  const tokens = parseEmailList('x '.repeat(BULK_INVITE_TOKEN_MAX + 10));
  assert.equal(tokens.total, BULK_INVITE_TOKEN_MAX);
  assert.equal(tokens.truncated, true);

  const long = parseEmailList(`${'a@example.com '.padEnd(BULK_INVITE_INPUT_MAX, ' ')}late@example.com`);
  assert.deepEqual(long.valid, ['a@example.com']);
  assert.equal(long.truncated, true);

  for (const empty of [undefined, null, 7, '', ' ,;\n ']) {
    const parsed = parseEmailList(empty);
    assert.deepEqual([parsed.entries.length, parsed.total, parsed.overLimit], [0, 0, false]);
  }
});
