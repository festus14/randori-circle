import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import {
  ProvenanceValidationError,
  canonicalExerciseContent,
  canonicalExerciseHash,
  validateProvenanceManifest,
} from '../../api/_catalog-provenance.js';
import { applyTakedown, parseTakedownArguments } from '../../scripts/catalog-provenance.mjs';

const catalogPath = new URL('../../data/randori-catalog-v1.json', import.meta.url);
const manifestPath = new URL('../../data/randori-catalog-provenance-v1.json', import.meta.url);
const schemaPath = new URL('../../data/randori-catalog-provenance.schema.json', import.meta.url);

function fixtures() {
  return {
    catalog: JSON.parse(readFileSync(catalogPath, 'utf8')),
    manifest: JSON.parse(readFileSync(manifestPath, 'utf8')),
  };
}

function assertProvenanceError(action, pattern) {
  assert.throws(action, error => {
    assert.ok(error instanceof ProvenanceValidationError);
    assert.match(error.message, pattern);
    return true;
  });
}

test('bundled provenance covers every exercise with current canonical hashes', () => {
  const { catalog, manifest } = fixtures();
  assert.deepEqual(
    validateProvenanceManifest(manifest, catalog, { now: '2026-09-19T12:00:00Z' }),
    { valid: true, recordCount: 11 },
  );
  assert.equal(manifest.records.length, catalog.exercises.length);
  assert.equal(manifest.records.every(record => record.source.type === 'original'), true);
  assert.equal(manifest.records.every(record => record.license.identifier === 'LicenseRef-Randori-Original'), true);
  assert.doesNotMatch(JSON.stringify(manifest).toLowerCase(), /leetcode/);
  for (const exercise of catalog.exercises) {
    const record = manifest.records.find(candidate => candidate.key === `${exercise.slug}@${exercise.version}`);
    assert.equal(record.contentHash, canonicalExerciseHash(exercise));
  }
});

test('checked-in JSON Schema declares the same closed versioned record contract', () => {
  const schema = JSON.parse(readFileSync(schemaPath, 'utf8'));
  assert.equal(schema.additionalProperties, false);
  assert.equal(schema.properties.schemaVersion.const, 1);
  assert.deepEqual(schema.required, ['$schema', 'schemaVersion', 'catalogId', 'records']);
  assert.equal(schema.$defs.record.additionalProperties, false);
  assert.deepEqual(
    schema.$defs.record.properties.source.properties.type.enum,
    ['original', 'open-license', 'written-authorization'],
  );
  assert.deepEqual(
    schema.$defs.record.properties.takedown.properties.status.enum,
    ['clear', 'requested', 'revoked', 'resolved'],
  );
});

test('canonical hashes ignore object insertion order but bind every public content field', () => {
  const { catalog } = fixtures();
  const exercise = catalog.exercises[0];
  const reordered = Object.fromEntries(Object.entries(exercise).reverse());
  reordered.languages = Object.fromEntries(Object.entries(exercise.languages).reverse());
  assert.equal(canonicalExerciseContent(reordered), canonicalExerciseContent(exercise));
  assert.equal(canonicalExerciseHash(reordered), canonicalExerciseHash(exercise));

  const changed = structuredClone(exercise);
  changed.prompt += ' Changed.';
  assert.notEqual(canonicalExerciseHash(changed), canonicalExerciseHash(exercise));
});

test('provenance fails closed on missing, duplicate, unknown, and tampered records', () => {
  const missing = fixtures();
  missing.manifest.records.pop();
  assertProvenanceError(
    () => validateProvenanceManifest(missing.manifest, missing.catalog),
    /is missing archived-session-streak@1/,
  );

  const duplicate = fixtures();
  duplicate.manifest.records.push(structuredClone(duplicate.manifest.records[0]));
  assertProvenanceError(
    () => validateProvenanceManifest(duplicate.manifest, duplicate.catalog),
    /key: must be unique/,
  );

  const unknown = fixtures();
  unknown.manifest.records[0].key = 'unknown@1';
  unknown.manifest.records[0].slug = 'unknown';
  unknown.manifest.records[0].source.reference = 'repository://data/randori-catalog-v1.json#unknown@1';
  assertProvenanceError(
    () => validateProvenanceManifest(unknown.manifest, unknown.catalog),
    /does not match a catalogue exercise/,
  );

  const tampered = fixtures();
  tampered.catalog.exercises[0].examples[0].explanation += ' altered';
  assertProvenanceError(
    () => validateProvenanceManifest(tampered.manifest, tampered.catalog),
    /contentHash: does not match canonical exercise content/,
  );

  const provenanceDrift = fixtures();
  provenanceDrift.catalog.exercises[0].governance.provenance = 'Unreviewed source claim.';
  assertProvenanceError(
    () => validateProvenanceManifest(provenanceDrift.manifest, provenanceDrift.catalog),
    /source\.statement: must match the catalogue provenance statement/,
  );

  const version = fixtures();
  version.manifest.schemaVersion = 2;
  assertProvenanceError(
    () => validateProvenanceManifest(version.manifest, version.catalog),
    /schemaVersion: must equal 1/,
  );
});

test('active content fails closed when review is expired, rejected, or under takedown', () => {
  const expired = fixtures();
  expired.manifest.records[0].review.expiresAt = '2026-09-18';
  assertProvenanceError(
    () => validateProvenanceManifest(expired.manifest, expired.catalog, { now: '2026-09-19' }),
    /review\.expiresAt: expired before 2026-09-19/,
  );

  const futureReview = fixtures();
  futureReview.manifest.records[0].review.reviewedAt = '2026-09-20';
  futureReview.catalog.exercises[0].governance.reviewDate = '2026-09-20';
  assertProvenanceError(
    () => validateProvenanceManifest(futureReview.manifest, futureReview.catalog, { now: '2026-09-19' }),
    /review\.reviewedAt: must not be in the future/,
  );

  const unbounded = fixtures();
  unbounded.manifest.records[0].review.expiresAt = '2028-09-18';
  assertProvenanceError(
    () => validateProvenanceManifest(unbounded.manifest, unbounded.catalog, { now: '2026-09-19' }),
    /must be within 366 days/,
  );

  const rejected = fixtures();
  rejected.manifest.records[0].review.status = 'rejected';
  assertProvenanceError(
    () => validateProvenanceManifest(rejected.manifest, rejected.catalog, { now: '2026-09-19' }),
    /active content must be approved/,
  );

  const revoked = fixtures();
  revoked.catalog.exercises[0].governance.takedown = {
    status: 'revoked', requestedAt: '2026-09-19', reference: 'issue-117',
  };
  revoked.manifest.records[0].takedown = {
    status: 'revoked', effectiveAt: '2026-09-19', reference: 'issue-117',
  };
  assertProvenanceError(
    () => validateProvenanceManifest(revoked.manifest, revoked.catalog, { now: '2026-09-19' }),
    /active content must not be under takedown/,
  );
});

test('source policy rejects vague or unsupported rights claims', () => {
  const misplacedOriginal = fixtures();
  misplacedOriginal.manifest.records[0].source.reference = 'repository://docs/CONTENT_POLICY.md';
  assertProvenanceError(
    () => validateProvenanceManifest(misplacedOriginal.manifest, misplacedOriginal.catalog),
    /must identify the exact bundled original record/,
  );

  const unsupported = fixtures();
  unsupported.manifest.records[0].source.type = 'internet';
  assertProvenanceError(
    () => validateProvenanceManifest(unsupported.manifest, unsupported.catalog),
    /source\.type: is unsupported/,
  );

  const fakeOpen = fixtures();
  fakeOpen.manifest.records[0].source = {
    type: 'open-license',
    reference: 'http://example.test/problem',
    statement: fakeOpen.catalog.exercises[0].governance.provenance,
  };
  fakeOpen.manifest.records[0].license = {
    identifier: 'LicenseRef-Vague', name: 'unknown', evidence: 'none',
  };
  assertProvenanceError(
    () => validateProvenanceManifest(fakeOpen.manifest, fakeOpen.catalog),
    /open content must use a concrete SPDX-style identifier/,
  );

  const vagueAuthorization = fixtures();
  vagueAuthorization.manifest.records[0].source = {
    type: 'written-authorization',
    reference: 'partner-feed-v1',
    statement: vagueAuthorization.catalog.exercises[0].governance.provenance,
  };
  vagueAuthorization.manifest.records[0].license = {
    identifier: 'LicenseRef-Partner', name: 'Partner permission', evidence: 'email from partner',
  };
  assertProvenanceError(
    () => validateProvenanceManifest(vagueAuthorization.manifest, vagueAuthorization.catalog),
    /authorization evidence must use a controlled repository reference/,
  );
});

test('takedown arguments are bounded and reject ambiguous input', () => {
  assert.deepEqual(
    parseTakedownArguments([
      '--slug', 'focus-block-rollup', '--version', '1', '--reference', 'issue-117',
      '--date', '2026-09-19', '--dry-run',
    ], { now: '2026-09-19' }),
    {
      slug: 'focus-block-rollup', version: 1, reference: 'issue-117', date: '2026-09-19',
      reason: 'Emergency provenance takedown (issue-117).', dryRun: true,
    },
  );
  assert.throws(() => parseTakedownArguments(['--slug', '../escape']), /lowercase kebab-case/);
  assert.throws(() => parseTakedownArguments([
    '--slug', 'focus-block-rollup', '--version', '1', '--reference', 'issue 117', '--date', '2026-09-19',
  ]), /bounded issue or incident reference/);
  assert.throws(() => parseTakedownArguments([
    '--slug', 'focus-block-rollup', '--version', '1', '--reference', 'issue-117', '--date', '2026-02-30',
  ]), /real calendar date/);
  assert.throws(() => parseTakedownArguments([
    '--slug', 'focus-block-rollup', '--version', '1', '--reference', 'issue-117', '--date', '2026-09-20',
  ], { now: '2026-09-19' }), /must not be in the future/);
});

test('takedown retires one exact record, validates, and is idempotent', () => {
  const { catalog, manifest } = fixtures();
  const options = {
    slug: 'focus-block-rollup', version: 1, reference: 'issue-117', date: '2026-09-19',
    reason: 'Emergency rights review.', now: '2026-09-19',
  };
  const result = applyTakedown(catalog, manifest, options);
  assert.equal(result.changed, true);
  assert.equal(result.catalog.exercises[0].status, 'retired');
  assert.deepEqual(result.catalog.exercises[0].governance.takedown, {
    status: 'revoked', requestedAt: '2026-09-19', reference: 'issue-117',
  });
  assert.deepEqual(result.manifest.records[0].takedown, {
    status: 'revoked', effectiveAt: '2026-09-19', reference: 'issue-117',
  });
  assert.equal(validateProvenanceManifest(result.manifest, result.catalog, { now: '2026-09-19' }).valid, true);
  assert.equal(applyTakedown(result.catalog, result.manifest, options).changed, false);
  assert.equal(catalog.exercises[0].status, 'active', 'input remains unchanged');
});

test('takedown refuses unknown targets and conflicting lifecycle events', () => {
  const unknown = fixtures();
  assert.throws(() => applyTakedown(unknown.catalog, unknown.manifest, {
    slug: 'missing', version: 1, reference: 'issue-117', date: '2026-09-19', reason: 'Review.',
    now: '2026-09-19',
  }), /no catalogue and provenance record found/);

  const conflict = fixtures();
  const first = applyTakedown(conflict.catalog, conflict.manifest, {
    slug: 'focus-block-rollup', version: 1, reference: 'issue-117', date: '2026-09-19', reason: 'Review.',
    now: '2026-09-19',
  });
  assert.throws(() => applyTakedown(first.catalog, first.manifest, {
    slug: 'focus-block-rollup', version: 1, reference: 'issue-118', date: '2026-09-20', reason: 'Review.',
    now: '2026-09-20',
  }), /different takedown event/);
});
