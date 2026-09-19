import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, readFileSync } from 'node:fs';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  ProvenanceValidationError,
  canonicalExerciseContent,
  canonicalExerciseHash,
  validateProvenanceManifest,
} from '../../api/_catalog-provenance.js';
import { applyTakedown, executeTakedown, parseTakedownArguments } from '../../scripts/catalog-provenance.mjs';

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
  assert.deepEqual(
    schema.$defs.record.allOf[1].then.properties.license.properties.identifier.enum,
    ['Apache-2.0', 'BSD-2-Clause', 'BSD-3-Clause', 'CC-BY-4.0', 'CC-BY-SA-4.0', 'CC0-1.0', 'MIT'],
  );
  assert.equal(schema.$defs.record.properties.author.properties.name.maxLength, 120);
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

  const futureRevocation = fixtures();
  futureRevocation.catalog.exercises.at(-1).governance.takedown = {
    status: 'revoked', requestedAt: '2026-09-20', reference: 'issue-117',
  };
  futureRevocation.manifest.records.at(-1).takedown = {
    status: 'revoked', effectiveAt: '2026-09-20', reference: 'issue-117',
  };
  assertProvenanceError(
    () => validateProvenanceManifest(
      futureRevocation.manifest,
      futureRevocation.catalog,
      { now: '2026-09-19' },
    ),
    /effectiveAt: must not be in the future/,
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
    identifier: 'FAKE-1.0', name: 'unknown', evidence: 'https://example.test/license',
  };
  assertProvenanceError(
    () => validateProvenanceManifest(fakeOpen.manifest, fakeOpen.catalog),
    /not in the approved SPDX allowlist/,
  );

  const approvedOpen = fixtures();
  approvedOpen.manifest.records[0].source = {
    type: 'open-license',
    reference: 'https://example.test/original-source',
    statement: 'Openly licensed source reviewed for authorized reuse.',
  };
  approvedOpen.catalog.exercises[0].governance.provenance = 'Openly licensed source reviewed for authorized reuse.';
  approvedOpen.manifest.records[0].license = {
    identifier: 'MIT',
    name: 'MIT License',
    evidence: 'https://spdx.org/licenses/MIT.html',
  };
  assert.equal(validateProvenanceManifest(
    approvedOpen.manifest,
    approvedOpen.catalog,
    { now: '2026-09-19' },
  ).valid, true);

  const vagueAuthorization = fixtures();
  vagueAuthorization.manifest.records[0].source = {
    type: 'written-authorization',
    reference: 'https://partner.example.test/catalogue/v1',
    statement: vagueAuthorization.catalog.exercises[0].governance.provenance,
  };
  vagueAuthorization.manifest.records[0].license = {
    identifier: 'LicenseRef-Partner', name: 'Partner permission', evidence: 'email from partner',
  };
  assertProvenanceError(
    () => validateProvenanceManifest(vagueAuthorization.manifest, vagueAuthorization.catalog),
    /normalized repository evidence reference/,
  );

  const approvedAuthorization = fixtures();
  approvedAuthorization.manifest.records[0].source = {
    type: 'written-authorization',
    reference: 'https://partner.example.test/catalogue/v1',
    statement: 'Written authorization reviewed for this exact source.',
  };
  approvedAuthorization.catalog.exercises[0].governance.provenance = 'Written authorization reviewed for this exact source.';
  approvedAuthorization.manifest.records[0].license = {
    identifier: 'LicenseRef-Partner-2026',
    name: 'Partner content authorization',
    evidence: 'repository://docs/source-authorizations/partner-2026.md',
  };
  assert.equal(validateProvenanceManifest(
    approvedAuthorization.manifest,
    approvedAuthorization.catalog,
    { now: '2026-09-19' },
  ).valid, true);

  const traversalEvidence = structuredClone(approvedAuthorization);
  traversalEvidence.manifest.records[0].license.evidence = 'repository://docs/source-authorizations/%2e%2e/private.md';
  assertProvenanceError(
    () => validateProvenanceManifest(traversalEvidence.manifest, traversalEvidence.catalog),
    /normalized repository evidence reference/,
  );

  const credentialedUrl = structuredClone(approvedOpen);
  credentialedUrl.manifest.records[0].source.reference = 'https://user:secret@example.test/problem';
  assertProvenanceError(
    () => validateProvenanceManifest(credentialedUrl.manifest, credentialedUrl.catalog),
    /credential-free HTTPS URL/,
  );

  const identifyingAuthor = fixtures();
  identifyingAuthor.manifest.records[0].author.name = 'maintainer@example.test';
  identifyingAuthor.catalog.exercises[0].governance.rightsOwner = 'maintainer@example.test';
  assertProvenanceError(
    () => validateProvenanceManifest(identifyingAuthor.manifest, identifyingAuthor.catalog),
    /author\.name: must not contain email, markup, or control data/,
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

test('an identical takedown preserves a pre-existing retirement exactly', () => {
  const { catalog, manifest } = fixtures();
  const exercise = catalog.exercises.at(-1);
  const originalRetirement = structuredClone(exercise.governance.retirement);
  const options = {
    slug: exercise.slug,
    version: exercise.version,
    reference: 'issue-117',
    date: '2026-09-19',
    reason: 'This must not replace the prior editorial retirement.',
    now: '2026-09-19',
  };
  const first = applyTakedown(catalog, manifest, options);
  assert.equal(first.changed, true);
  assert.deepEqual(first.catalog.exercises.at(-1).governance.retirement, originalRetirement);
  const second = applyTakedown(first.catalog, first.manifest, options);
  assert.equal(second.changed, false);
  assert.deepEqual(second.catalog.exercises.at(-1).governance.retirement, originalRetirement);
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

  const invalidOtherRecord = fixtures();
  invalidOtherRecord.catalog.exercises[1].title = '';
  assert.throws(() => applyTakedown(invalidOtherRecord.catalog, invalidOtherRecord.manifest, {
    slug: 'focus-block-rollup', version: 1, reference: 'issue-117', date: '2026-09-19', reason: 'Review.',
    now: '2026-09-19',
  }), /catalog\.exercises\[1\]\.title/);
});

async function temporaryCatalogueFiles() {
  const directory = await mkdtemp(join(tmpdir(), 'randori-provenance-'));
  const catalogUrl = new URL(`file://${directory}/catalog.json`);
  const manifestUrl = new URL(`file://${directory}/provenance.json`);
  const lockUrl = new URL(`file://${directory}/operator.lock`);
  const { catalog, manifest } = fixtures();
  await Promise.all([
    writeFile(catalogUrl, `${JSON.stringify(catalog, null, 2)}\n`),
    writeFile(manifestUrl, `${JSON.stringify(manifest, null, 2)}\n`),
  ]);
  return { directory, catalogUrl, manifestUrl, lockUrl };
}

function takedownOptions(overrides = {}) {
  return {
    slug: 'focus-block-rollup',
    version: 1,
    reference: 'issue-117',
    date: '2026-09-19',
    reason: 'Emergency rights review.',
    now: '2026-09-19',
    dryRun: false,
    ...overrides,
  };
}

test('file takedown writes a validated pair and recovers an interrupted manifest-first write', async () => {
  const paths = await temporaryCatalogueFiles();
  try {
    await assert.rejects(
      executeTakedown(takedownOptions(), {
        ...paths,
        lockNow: '2026-09-19T12:00:00.000Z',
        afterManifestRename() { throw new Error('simulated interruption'); },
      }),
      /simulated interruption/,
    );
    const partialCatalog = JSON.parse(await readFile(paths.catalogUrl, 'utf8'));
    const partialManifest = JSON.parse(await readFile(paths.manifestUrl, 'utf8'));
    assert.equal(partialCatalog.exercises[0].status, 'active');
    assert.equal(partialManifest.records[0].takedown.status, 'revoked');
    assert.equal(existsSync(paths.lockUrl), false);

    const recovered = await executeTakedown(takedownOptions(), {
      ...paths, lockNow: '2026-09-19T12:01:00.000Z',
    });
    assert.equal(recovered.changed, true);
    const finalCatalog = JSON.parse(await readFile(paths.catalogUrl, 'utf8'));
    const finalManifest = JSON.parse(await readFile(paths.manifestUrl, 'utf8'));
    assert.equal(finalCatalog.exercises[0].status, 'retired');
    assert.equal(finalManifest.records[0].takedown.status, 'revoked');
  } finally {
    await rm(paths.directory, { recursive: true, force: true });
  }
});

test('file takedown recovers only a stale dead-process lock and rejects symlink targets', async () => {
  const stale = await temporaryCatalogueFiles();
  try {
    await writeFile(stale.lockUrl, `${JSON.stringify({
      version: 1,
      pid: 2_147_483_647,
      createdAt: '2026-09-19T11:00:00.000Z',
      nonce: '00000000-0000-4000-8000-000000000000',
    })}\n`);
    const result = await executeTakedown(takedownOptions({ dryRun: true }), {
      ...stale,
      lockNow: '2026-09-19T12:00:00.000Z',
      staleLockMs: 1_000,
    });
    assert.equal(result.changed, true);
    assert.equal(existsSync(stale.lockUrl), false);
  } finally {
    await rm(stale.directory, { recursive: true, force: true });
  }

  const unsafe = await temporaryCatalogueFiles();
  try {
    const realCatalog = new URL(`file://${unsafe.directory}/real-catalog.json`);
    await writeFile(realCatalog, await readFile(unsafe.catalogUrl));
    await rm(unsafe.catalogUrl);
    await symlink(realCatalog, unsafe.catalogUrl);
    await assert.rejects(
      executeTakedown(takedownOptions({ dryRun: true }), {
        ...unsafe, lockNow: '2026-09-19T12:00:00.000Z',
      }),
      /catalogue must be a regular non-symlink file/,
    );
    assert.equal(existsSync(unsafe.lockUrl), false);
  } finally {
    await rm(unsafe.directory, { recursive: true, force: true });
  }
});

function runTakedownWorker(paths, reference, holdLockMs) {
  const child = spawn(process.execPath, [
    fileURLToPath(new URL('../support/catalog-takedown-worker.mjs', import.meta.url)),
    fileURLToPath(paths.catalogUrl),
    fileURLToPath(paths.manifestUrl),
    fileURLToPath(paths.lockUrl),
    reference,
    String(holdLockMs),
  ], { stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', chunk => { stdout += chunk; });
  child.stderr.on('data', chunk => { stderr += chunk; });
  return { child, result: once(child, 'close').then(([code]) => ({ code, stdout, stderr })) };
}

test('the interprocess lock prevents concurrent takedowns from losing an update', async () => {
  const paths = await temporaryCatalogueFiles();
  try {
    const first = runTakedownWorker(paths, 'issue-117', 500);
    const deadline = Date.now() + 2_000;
    while (!existsSync(paths.lockUrl) && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.equal(existsSync(paths.lockUrl), true, 'first worker did not acquire the lock');
    const second = runTakedownWorker(paths, 'issue-118', 0);
    const [firstResult, secondResult] = await Promise.all([first.result, second.result]);
    assert.equal(firstResult.code, 0, firstResult.stderr);
    assert.equal(secondResult.code, 1);
    assert.match(secondResult.stderr, /another catalogue operation holds the lock/);

    const catalog = JSON.parse(await readFile(paths.catalogUrl, 'utf8'));
    const manifest = JSON.parse(await readFile(paths.manifestUrl, 'utf8'));
    assert.equal(catalog.exercises[0].governance.takedown.reference, 'issue-117');
    assert.equal(manifest.records[0].takedown.reference, 'issue-117');
    assert.equal(existsSync(paths.lockUrl), false);
  } finally {
    await rm(paths.directory, { recursive: true, force: true });
  }
});

test('the pre-write digest check rejects a non-cooperating concurrent edit', async () => {
  const paths = await temporaryCatalogueFiles();
  try {
    let markValidated;
    let continueWrite;
    const validated = new Promise(resolve => { markValidated = resolve; });
    const release = new Promise(resolve => { continueWrite = resolve; });
    const operation = executeTakedown(takedownOptions(), {
      ...paths,
      lockNow: '2026-09-19T12:00:00.000Z',
      async afterValidation() {
        markValidated();
        await release;
      },
    });
    const rejected = assert.rejects(operation, /catalogue files changed after validation/);
    await validated;
    const current = await readFile(paths.manifestUrl, 'utf8');
    await writeFile(paths.manifestUrl, `${current.trimEnd()}  \n`);
    continueWrite();
    await rejected;
    const catalog = JSON.parse(await readFile(paths.catalogUrl, 'utf8'));
    const manifest = JSON.parse(await readFile(paths.manifestUrl, 'utf8'));
    assert.equal(catalog.exercises[0].status, 'active');
    assert.equal(manifest.records[0].takedown.status, 'clear');
    assert.equal(existsSync(paths.lockUrl), false);
  } finally {
    await rm(paths.directory, { recursive: true, force: true });
  }
});

test('the operator lock itself cannot be redirected through a symlink', async () => {
  const paths = await temporaryCatalogueFiles();
  try {
    const victim = new URL(`file://${paths.directory}/victim.lock`);
    await writeFile(victim, 'do-not-touch\n');
    await symlink(victim, paths.lockUrl);
    await assert.rejects(
      executeTakedown(takedownOptions({ dryRun: true }), {
        ...paths, lockNow: '2026-09-19T12:00:00.000Z',
      }),
      /operator lock is unsafe/,
    );
    assert.equal(await readFile(victim, 'utf8'), 'do-not-touch\n');
  } finally {
    await rm(paths.directory, { recursive: true, force: true });
  }
});
