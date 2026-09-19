import { createHash } from 'node:crypto';

const SOURCE_TYPES = new Set(['original', 'open-license', 'written-authorization']);
const AUTHOR_KINDS = new Set(['person', 'organization', 'collective']);
const REVIEW_STATUSES = new Set(['approved', 'rejected']);
const TAKEDOWN_STATUSES = new Set(['clear', 'requested', 'revoked', 'resolved']);
const HASH_PATTERN = /^sha256:[a-f0-9]{64}$/;
const RECORD_KEY_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*@[1-9]\d*$/;

const CONTENT_FIELDS = Object.freeze([
  'slug',
  'version',
  'title',
  'difficulty',
  'type',
  'tags',
  'prompt',
  'constraints',
  'examples',
  'languages',
]);

export class ProvenanceValidationError extends Error {
  constructor(path, reason) {
    super(`${path}: ${reason}`);
    this.name = 'ProvenanceValidationError';
    this.path = path;
    this.reason = reason;
  }
}

function fail(path, reason) {
  throw new ProvenanceValidationError(path, reason);
}

function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function requireObject(value, path) {
  if (!isPlainObject(value)) fail(path, 'must be an object');
}

function requireExactKeys(value, expectedKeys, path) {
  requireObject(value, path);
  const expected = new Set(expectedKeys);
  for (const key of Object.keys(value)) {
    if (!expected.has(key)) fail(`${path}.${key}`, 'is not an allowed field');
  }
  for (const key of expectedKeys) {
    if (!Object.hasOwn(value, key)) fail(`${path}.${key}`, 'is required');
  }
}

function requireText(value, path) {
  if (typeof value !== 'string' || value.trim() === '') fail(path, 'must be a non-empty string');
}

function requireNullableText(value, path) {
  if (value !== null) requireText(value, path);
}

function parseIsoDate(value, path) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    fail(path, 'must use YYYY-MM-DD format');
  }
  const parsed = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(parsed.valueOf()) || parsed.toISOString().slice(0, 10) !== value) {
    fail(path, 'must be a real calendar date');
  }
  return value;
}

function validationDate(now) {
  const parsed = now instanceof Date ? new Date(now.valueOf()) : new Date(now);
  if (Number.isNaN(parsed.valueOf())) fail('validation.now', 'must be a valid date');
  return parsed.toISOString().slice(0, 10);
}

function canonicalJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  return `{${Object.keys(value).sort().map(key => (
    `${JSON.stringify(key)}:${canonicalJson(value[key])}`
  )).join(',')}}`;
}

export function canonicalExerciseContent(exercise) {
  requireObject(exercise, 'exercise');
  const content = {};
  for (const field of CONTENT_FIELDS) {
    if (!Object.hasOwn(exercise, field)) fail(`exercise.${field}`, 'is required for hashing');
    content[field] = exercise[field];
  }
  return canonicalJson(content);
}

export function canonicalExerciseHash(exercise) {
  return `sha256:${createHash('sha256').update(canonicalExerciseContent(exercise), 'utf8').digest('hex')}`;
}

function validateSource(source, license, path) {
  requireExactKeys(source, ['type', 'reference'], `${path}.source`);
  if (!SOURCE_TYPES.has(source.type)) fail(`${path}.source.type`, 'is unsupported');
  requireText(source.reference, `${path}.source.reference`);

  requireExactKeys(license, ['identifier', 'name', 'evidence'], `${path}.license`);
  requireText(license.identifier, `${path}.license.identifier`);
  requireText(license.name, `${path}.license.name`);
  requireText(license.evidence, `${path}.license.evidence`);

  if (source.type === 'original') {
    if (!source.reference.startsWith('repository://')) {
      fail(`${path}.source.reference`, 'original content must use a repository reference');
    }
    if (license.identifier !== 'LicenseRef-Randori-Original') {
      fail(`${path}.license.identifier`, 'original content must use LicenseRef-Randori-Original');
    }
  } else if (source.type === 'open-license') {
    if (!/^[A-Za-z0-9][A-Za-z0-9.+-]*$/.test(license.identifier) || license.identifier.startsWith('LicenseRef-')) {
      fail(`${path}.license.identifier`, 'open content must use a concrete SPDX-style identifier');
    }
    if (!/^https:\/\//.test(source.reference) || !/^https:\/\//.test(license.evidence)) {
      fail(path, 'open content must link to HTTPS source and license evidence');
    }
  } else {
    if (!license.identifier.startsWith('LicenseRef-')) {
      fail(`${path}.license.identifier`, 'written authorization must use a LicenseRef identifier');
    }
    if (!license.evidence.startsWith('repository://')) {
      fail(`${path}.license.evidence`, 'written authorization evidence must use a controlled repository reference');
    }
  }
}

function validateReview(review, path) {
  requireExactKeys(review, ['status', 'reviewedAt', 'expiresAt', 'reviewer'], path);
  if (!REVIEW_STATUSES.has(review.status)) fail(`${path}.status`, 'is unsupported');
  const reviewedAt = parseIsoDate(review.reviewedAt, `${path}.reviewedAt`);
  const expiresAt = parseIsoDate(review.expiresAt, `${path}.expiresAt`);
  if (expiresAt < reviewedAt) fail(`${path}.expiresAt`, 'must not precede reviewedAt');
  const reviewWindowDays = (
    Date.parse(`${expiresAt}T00:00:00.000Z`) - Date.parse(`${reviewedAt}T00:00:00.000Z`)
  ) / 86_400_000;
  if (reviewWindowDays > 366) fail(`${path}.expiresAt`, 'must be within 366 days of reviewedAt');
  requireText(review.reviewer, `${path}.reviewer`);
}

function validateTakedown(takedown, path) {
  requireExactKeys(takedown, ['status', 'effectiveAt', 'reference'], path);
  if (!TAKEDOWN_STATUSES.has(takedown.status)) fail(`${path}.status`, 'is unsupported');
  if (takedown.status === 'clear') {
    if (takedown.effectiveAt !== null || takedown.reference !== null) {
      fail(path, 'clear takedown state must not contain event details');
    }
    return;
  }
  parseIsoDate(takedown.effectiveAt, `${path}.effectiveAt`);
  requireText(takedown.reference, `${path}.reference`);
}

function validateRecord(record, index, exercise, today) {
  const path = `provenance.records[${index}]`;
  requireExactKeys(
    record,
    ['key', 'slug', 'version', 'source', 'author', 'license', 'attribution', 'contentHash', 'review', 'takedown'],
    path,
  );
  requireText(record.key, `${path}.key`);
  if (!RECORD_KEY_PATTERN.test(record.key)) fail(`${path}.key`, 'must be slug@version');
  requireText(record.slug, `${path}.slug`);
  if (!Number.isSafeInteger(record.version) || record.version < 1) {
    fail(`${path}.version`, 'must be a positive safe integer');
  }
  if (record.key !== `${record.slug}@${record.version}`) fail(`${path}.key`, 'must match slug and version');

  requireExactKeys(record.author, ['name', 'kind'], `${path}.author`);
  requireText(record.author.name, `${path}.author.name`);
  if (!AUTHOR_KINDS.has(record.author.kind)) fail(`${path}.author.kind`, 'is unsupported');
  validateSource(record.source, record.license, path);
  if (record.source.type === 'original') {
    if (record.source.reference !== `repository://data/randori-catalog-v1.json#${record.key}`) {
      fail(`${path}.source.reference`, 'must identify the exact bundled original record');
    }
    if (record.license.evidence !== 'repository://docs/CONTENT_POLICY.md') {
      fail(`${path}.license.evidence`, 'must identify the repository content policy');
    }
  }
  requireText(record.attribution, `${path}.attribution`);
  if (!HASH_PATTERN.test(record.contentHash)) fail(`${path}.contentHash`, 'must be sha256:<64 lowercase hex characters>');
  validateReview(record.review, `${path}.review`);
  validateTakedown(record.takedown, `${path}.takedown`);

  if (!exercise) fail(path, 'does not match a catalogue exercise');
  if (record.contentHash !== canonicalExerciseHash(exercise)) {
    fail(`${path}.contentHash`, 'does not match canonical exercise content');
  }
  if (record.author.name !== exercise.governance.rightsOwner) {
    fail(`${path}.author.name`, 'must match the catalogue rights owner');
  }
  if (record.attribution !== exercise.governance.attribution) {
    fail(`${path}.attribution`, 'must match the catalogue attribution');
  }
  if (record.review.reviewedAt > today) fail(`${path}.review.reviewedAt`, 'must not be in the future');

  const expectedTakedown = exercise.governance.takedown.status === 'none'
    ? 'clear'
    : exercise.governance.takedown.status;
  if (record.takedown.status !== expectedTakedown) {
    fail(`${path}.takedown.status`, 'must match catalogue governance');
  }
  if (record.takedown.status !== 'clear') {
    if (record.takedown.effectiveAt !== exercise.governance.takedown.requestedAt) {
      fail(`${path}.takedown.effectiveAt`, 'must match catalogue governance');
    }
    if (record.takedown.reference !== exercise.governance.takedown.reference) {
      fail(`${path}.takedown.reference`, 'must match catalogue governance');
    }
  }

  if (exercise.status === 'active') {
    if (record.review.status !== 'approved') fail(`${path}.review.status`, 'active content must be approved');
    if (record.review.expiresAt < today) fail(`${path}.review.expiresAt`, `expired before ${today}`);
    if (record.takedown.status !== 'clear') fail(`${path}.takedown.status`, 'active content must not be under takedown');
  }
}

export function validateProvenanceManifest(manifest, catalog, { now = new Date() } = {}) {
  requireExactKeys(manifest, ['$schema', 'schemaVersion', 'catalogId', 'records'], 'provenance');
  if (manifest.$schema !== './randori-catalog-provenance.schema.json') {
    fail('provenance.$schema', 'must reference the checked-in v1 JSON Schema');
  }
  if (manifest.schemaVersion !== 1) fail('provenance.schemaVersion', 'must equal 1');
  requireText(manifest.catalogId, 'provenance.catalogId');
  if (!isPlainObject(catalog) || !isPlainObject(catalog.catalog) || !Array.isArray(catalog.exercises)) {
    fail('catalog', 'must be a catalogue object');
  }
  if (manifest.catalogId !== catalog.catalog.id) fail('provenance.catalogId', 'must match catalogue id');
  if (!Array.isArray(manifest.records)) fail('provenance.records', 'must be an array');

  const today = validationDate(now);
  const exercises = new Map(catalog.exercises.map(exercise => [`${exercise.slug}@${exercise.version}`, exercise]));
  const seen = new Set();
  manifest.records.forEach((record, index) => {
    const key = isPlainObject(record) ? record.key : null;
    if (typeof key === 'string' && seen.has(key)) fail(`provenance.records[${index}].key`, 'must be unique');
    if (typeof key === 'string') seen.add(key);
    validateRecord(record, index, exercises.get(key), today);
  });
  for (const key of exercises.keys()) {
    if (!seen.has(key)) fail('provenance.records', `is missing ${key}`);
  }
  return Object.freeze({ valid: true, recordCount: manifest.records.length });
}
