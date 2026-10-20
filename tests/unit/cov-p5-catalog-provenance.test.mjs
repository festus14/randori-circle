import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  ProvenanceValidationError,
  canonicalExerciseContent,
  validateProvenanceManifest,
  validationDate,
} from '../../api/_catalog-provenance.js';
import {
  applyTakedown,
  executeTakedown,
  main,
  parseTakedownArguments,
} from '../../scripts/catalog-provenance.mjs';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const catalogPath = new URL('../../data/randori-catalog-v1.json', import.meta.url);
const manifestPath = new URL('../../data/randori-catalog-provenance-v1.json', import.meta.url);
const NOW = '2026-09-19';

function fixtures() {
  return {
    catalog: JSON.parse(readFileSync(catalogPath, 'utf8')),
    manifest: JSON.parse(readFileSync(manifestPath, 'utf8')),
  };
}

function rejects(mutate, pattern) {
  const pair = fixtures();
  mutate(pair);
  assert.throws(
    () => validateProvenanceManifest(pair.manifest, pair.catalog, { now: NOW }),
    error => {
      assert.ok(error instanceof ProvenanceValidationError, String(error));
      assert.match(error.message, pattern);
      return true;
    },
  );
}

test('provenance manifest envelope fails closed on shape, schema, and catalogue mismatches', () => {
  assert.throws(() => validateProvenanceManifest([], fixtures().catalog), /provenance: must be an object/);
  assert.throws(() => validateProvenanceManifest(null, fixtures().catalog), /provenance: must be an object/);
  rejects(({ manifest }) => { manifest.extra = true; }, /provenance\.extra: is not an allowed field/);
  rejects(({ manifest }) => { delete manifest.records; }, /provenance\.records: is required/);
  rejects(({ manifest }) => { manifest.$schema = './other.json'; }, /\$schema: must reference/);
  rejects(({ manifest }) => { manifest.catalogId = '  '; }, /catalogId: must be a non-empty string/);
  rejects(({ manifest }) => { manifest.catalogId = 'other-catalog'; }, /catalogId: must match catalogue id/);
  rejects(({ manifest }) => { manifest.records = {}; }, /records: must be an array/);
  rejects(({ catalog }) => { catalog.exercises = {}; }, /catalog: must be a catalogue object/);
  rejects(({ catalog }) => { catalog.catalog = []; }, /catalog: must be a catalogue object/);
  rejects(({ manifest }) => { manifest.records[0] = 'not-a-record'; }, /records\[0\]: must be an object/);

  // A null-prototype object is still accepted as a plain JSON-like object.
  const { catalog, manifest } = fixtures();
  const bare = Object.assign(Object.create(null), manifest);
  assert.equal(validateProvenanceManifest(bare, catalog, { now: NOW }).valid, true);
});

test('validation date rejects an unparseable clock', () => {
  assert.equal(validationDate(new Date('2026-09-19T23:59:59Z')), NOW);
  assert.equal(validationDate('2026-09-19T00:00:00Z'), NOW);
  assert.throws(() => validationDate('not-a-date'), /validation\.now: must be a valid date/);
});

test('record identity fields are bound to slug, version, and catalogue governance', () => {
  rejects(({ manifest }) => { manifest.records[0].key = 'Focus Block@1'; }, /key: must be slug@version/);
  rejects(({ manifest }) => { manifest.records[0].version = 0; }, /version: must be a positive safe integer/);
  rejects(({ manifest }) => { manifest.records[0].version = 2; }, /key: must match slug and version/);
  rejects(({ manifest }) => { manifest.records[0].author.kind = 'robot'; }, /author\.kind: is unsupported/);
  rejects(({ manifest }) => { manifest.records[0].author.name = 'x'.repeat(121); }, /at most 120 characters/);
  rejects(({ manifest }) => { manifest.records[0].contentHash = 'md5:abc'; }, /contentHash: must be sha256/);
  rejects(({ catalog }) => {
    catalog.exercises[0].governance.rightsOwner = 'Someone Else';
  }, /author\.name: must match the catalogue rights owner/);
  rejects(({ catalog }) => {
    catalog.exercises[0].governance.attribution = 'Different attribution';
  }, /attribution: must match the catalogue attribution/);
  rejects(({ catalog }) => {
    catalog.exercises[0].governance.reviewDate = '2026-09-17';
  }, /review\.reviewedAt: must match the catalogue review date/);
});

test('original-content claims must use the reviewed repository attestation', () => {
  rejects(({ manifest }) => {
    manifest.records[0].source.reference = 'https://example.test/original';
  }, /original content must use a repository reference/);
  rejects(({ manifest }) => {
    manifest.records[0].license.identifier = 'MIT';
  }, /original content must use LicenseRef-Randori-Original/);
  rejects(({ manifest }) => {
    manifest.records[0].source.statement = 'Original, trust me.';
  }, /must use the reviewed original-content attestation/);
  rejects(({ manifest }) => {
    manifest.records[0].license.evidence = 'repository://docs/OTHER.md';
  }, /must identify the repository content policy/);
});

function authorize(pair, evidence, identifier = 'LicenseRef-Partner-2026') {
  const statement = 'Written authorization reviewed for this exact source.';
  pair.manifest.records[0].source = {
    type: 'written-authorization', reference: 'https://partner.example.test/catalogue/v1', statement,
  };
  pair.catalog.exercises[0].governance.provenance = statement;
  pair.manifest.records[0].license = { identifier, name: 'Partner content authorization', evidence };
}

test('third-party sources require HTTPS references and controlled authorization evidence', () => {
  rejects(pair => {
    authorize(pair, 'repository://docs/source-authorizations/partner.md', 'Partner-Permission');
  }, /written authorization must use a LicenseRef identifier/);
  rejects(pair => {
    authorize(pair, 'repository://docs/source-authorizations/partner.md');
    pair.manifest.records[0].source.reference = 'not a url';
  }, /source\.reference: must be an absolute HTTPS URL/);
  rejects(pair => {
    authorize(pair, 'not a url at all');
  }, /license\.evidence: must be a normalized repository evidence reference$/);
  rejects(pair => {
    authorize(pair, 'repository://docs/source-authorizations/%E0%A4%A.md');
  }, /license\.evidence: must be a normalized repository evidence reference$/);
  rejects(pair => {
    authorize(pair, 'repository://docs/source-authorizations/partner.md?download=1');
  }, /under docs\/source-authorizations/);
  rejects(pair => {
    authorize(pair, 'repository://docs/other-folder/partner.md');
  }, /under docs\/source-authorizations/);
});

test('review and takedown blocks reject unsupported states and inconsistent events', () => {
  rejects(({ manifest }) => { manifest.records[0].review.status = 'pending'; }, /review\.status: is unsupported/);
  rejects(({ manifest }) => { manifest.records[0].review.reviewedAt = '18/09/2026'; }, /must use YYYY-MM-DD format/);
  rejects(({ manifest }) => { manifest.records[0].review.expiresAt = '2027-02-30'; }, /must be a real calendar date/);
  rejects(({ manifest }) => { manifest.records[0].review.expiresAt = '2026-09-01'; }, /must not precede reviewedAt/);
  rejects(({ manifest }) => { manifest.records[0].takedown.status = 'paused'; }, /takedown\.status: is unsupported/);
  rejects(({ manifest }) => {
    manifest.records[0].takedown.reference = 'issue-1';
  }, /clear takedown state must not contain event details/);
  rejects(({ manifest }) => {
    manifest.records[0].takedown = { status: 'revoked', effectiveAt: '2026-09-19', reference: 'issue-117' };
  }, /takedown\.status: must match catalogue governance/);
  rejects(({ catalog, manifest }) => {
    catalog.exercises[0].governance.takedown = { status: 'revoked', requestedAt: '2026-09-18', reference: 'issue-117' };
    manifest.records[0].takedown = { status: 'revoked', effectiveAt: '2026-09-19', reference: 'issue-117' };
  }, /takedown\.effectiveAt: must match catalogue governance/);
  rejects(({ catalog, manifest }) => {
    catalog.exercises[0].governance.takedown = { status: 'revoked', requestedAt: '2026-09-19', reference: 'issue-117' };
    manifest.records[0].takedown = { status: 'revoked', effectiveAt: '2026-09-19', reference: 'issue-118' };
  }, /takedown\.reference: must match catalogue governance/);
});

test('canonical content hashing requires every public content field', () => {
  const exercise = structuredClone(fixtures().catalog.exercises[0]);
  delete exercise.examples;
  assert.throws(() => canonicalExerciseContent(exercise), /exercise\.examples: is required for hashing/);
  assert.throws(() => canonicalExerciseContent([]), /exercise: must be an object/);
});

const BASE_ARGS = ['--slug', 'focus-block-rollup', '--version', '1', '--reference', 'issue-117', '--date', NOW];

test('takedown argument parser rejects unknown, duplicate, missing, and oversized values', () => {
  const parse = argv => parseTakedownArguments(argv, { now: NOW });
  assert.throws(() => parse([...BASE_ARGS, '--force']), /unknown argument: --force/);
  assert.throws(() => parse([...BASE_ARGS, '--slug', 'other']), /duplicate argument: --slug/);
  assert.throws(() => parse([...BASE_ARGS, '--reason']), /--reason requires a value/);
  assert.throws(() => parse(['--slug', '--version', '1']), /--slug requires a value/);
  assert.throws(() => parse(['--slug', 'focus-block-rollup', '--reference', 'r', '--date', NOW]),
    /--version must be a positive integer/);
  assert.throws(() => parse(['--slug', 'a', '--version', '99999999999999999', '--reference', 'r', '--date', NOW]),
    /--version must be a positive safe integer/);
  assert.throws(() => parse(['--slug', 'a', '--version', '1', '--reference', 'r']), /--date must use YYYY-MM-DD/);
  assert.throws(() => parse([...BASE_ARGS, '--reason', 'line one\nline two']), /single non-empty line/);
  assert.throws(() => parse([...BASE_ARGS, '--reason', 'x'.repeat(501)]), /at most 500 characters/);
  assert.equal(parse([...BASE_ARGS, '--reason', 'Rights holder request.']).reason, 'Rights holder request.');
});

test('a takedown cannot overwrite a different in-flight takedown workflow', () => {
  const { catalog, manifest } = fixtures();
  const options = {
    slug: 'focus-block-rollup', version: 1, reference: 'issue-117', date: NOW, reason: 'Review.', now: NOW,
  };
  const first = applyTakedown(catalog, manifest, options);
  first.catalog.exercises[0].governance.takedown.status = 'requested';
  first.manifest.records[0].takedown.status = 'requested';
  assert.throws(() => applyTakedown(first.catalog, first.manifest, options),
    /non-clear takedown workflow; resolve it before applying a revocation/);
});

async function temporaryCatalogueFiles() {
  const directory = await mkdtemp(join(tmpdir(), 'randori-cov-provenance-'));
  const dataDirectory = join(directory, 'data');
  await mkdir(dataDirectory);
  const { catalog, manifest } = fixtures();
  const paths = {
    directory,
    dataDirectory,
    repositoryRootUrl: pathToFileURL(`${directory}/`),
    dataRootUrl: pathToFileURL(`${dataDirectory}/`),
    catalogUrl: pathToFileURL(join(dataDirectory, 'catalog.json')),
    manifestUrl: pathToFileURL(join(dataDirectory, 'provenance.json')),
    lockUrl: pathToFileURL(join(dataDirectory, 'operator.lock')),
  };
  await Promise.all([
    writeFile(paths.catalogUrl, `${JSON.stringify(catalog, null, 2)}\n`),
    writeFile(paths.manifestUrl, `${JSON.stringify(manifest, null, 2)}\n`),
  ]);
  return paths;
}

const OPTIONS = Object.freeze({
  slug: 'focus-block-rollup', version: 1, reference: 'issue-117', date: NOW,
  reason: 'Emergency rights review.', now: NOW, dryRun: true,
});

function urls(paths) {
  const { directory, dataDirectory, ...rest } = paths;
  return { ...rest, lockNow: '2026-09-19T12:00:00.000Z' };
}

async function withFiles(fn) {
  const paths = await temporaryCatalogueFiles();
  try {
    await fn(paths);
  } finally {
    await rm(paths.directory, { recursive: true, force: true });
  }
}

test('file takedown rejects unsafe catalogue paths and file contents before locking', async () => {
  await withFiles(async paths => {
    await assert.rejects(
      executeTakedown(OPTIONS, { ...urls(paths), catalogUrl: new URL(`${paths.catalogUrl.href}?v=1`) }),
      /catalogue path is invalid/,
    );
    await assert.rejects(
      executeTakedown(OPTIONS, { ...urls(paths), dataRootUrl: paths.repositoryRootUrl }),
      /trusted data directory must stay within the trusted data directory/,
    );
    await assert.rejects(
      executeTakedown(OPTIONS, { ...urls(paths), catalogUrl: new URL('../../elsewhere.json', paths.catalogUrl) }),
      /catalogue must stay within the trusted data directory/,
    );
    await assert.rejects(
      executeTakedown(OPTIONS, { ...urls(paths), catalogUrl: pathToFileURL(join(paths.dataDirectory, 'catalog.json', 'x')) }),
      /catalogue path contains a non-directory component/,
    );
    await assert.rejects(
      executeTakedown(OPTIONS, { ...urls(paths), catalogUrl: pathToFileURL(join(paths.dataDirectory, 'missing.json')) }),
      error => error.code === 'ENOENT',
    );
    assert.equal(existsSync(paths.lockUrl), false);
  });
});

test('file takedown refuses a symlinked repository root', async () => {
  await withFiles(async paths => {
    const link = join(paths.directory, '..', `${paths.directory.split('/').pop()}-link`);
    await symlink(paths.directory, link);
    try {
      await assert.rejects(
        executeTakedown(OPTIONS, { ...urls(paths), repositoryRootUrl: pathToFileURL(`${link}/`) }),
        /trusted repository root must be a real directory/,
      );
    } finally {
      await rm(link, { force: true });
    }
  });
});

test('file takedown rejects directories, oversized files, and malformed JSON', async () => {
  await withFiles(async paths => {
    const directoryTarget = pathToFileURL(join(paths.dataDirectory, 'catalog-dir'));
    await mkdir(directoryTarget);
    await assert.rejects(
      executeTakedown(OPTIONS, { ...urls(paths), catalogUrl: directoryTarget }),
      /catalogue must be a regular non-symlink file/,
    );
    assert.equal(existsSync(paths.lockUrl), false);

    await writeFile(paths.manifestUrl, '{"truncated":');
    await assert.rejects(executeTakedown(OPTIONS, urls(paths)), /provenance manifest is not valid JSON/);
    assert.equal(existsSync(paths.lockUrl), false);

    await writeFile(paths.manifestUrl, `{}${' '.repeat(512 * 1024)}`);
    await assert.rejects(executeTakedown(OPTIONS, urls(paths)), /provenance manifest exceeds its size limit/);
  });
});

test('operator lock contention fails closed for live, unsafe, and malformed locks', async () => {
  await withFiles(async paths => {
    const live = {
      version: 1, pid: process.pid, createdAt: '2026-09-19T11:59:00.000Z',
      nonce: '00000000-0000-4000-8000-000000000000',
    };
    await writeFile(paths.lockUrl, JSON.stringify(live));
    await assert.rejects(executeTakedown(OPTIONS, urls(paths)), /another catalogue operation holds the lock/);
    // A live owner is never evicted, even after the staleness window.
    await assert.rejects(
      executeTakedown(OPTIONS, { ...urls(paths), staleLockMs: 1 }),
      /another catalogue operation holds the lock/,
    );
    assert.deepEqual(JSON.parse(await readFile(paths.lockUrl, 'utf8')), live);

    await writeFile(paths.lockUrl, 'not json');
    await assert.rejects(executeTakedown(OPTIONS, urls(paths)), /operator lock is malformed/);

    await writeFile(paths.lockUrl, JSON.stringify({ ...live, nonce: 'short' }));
    await assert.rejects(executeTakedown(OPTIONS, urls(paths)), /operator lock is malformed/);

    await writeFile(paths.lockUrl, JSON.stringify({ ...live, pid: 0 }));
    await assert.rejects(executeTakedown(OPTIONS, urls(paths)), /operator lock is malformed/);

    await writeFile(paths.lockUrl, 'x'.repeat(2048));
    await assert.rejects(executeTakedown(OPTIONS, urls(paths)), /operator lock is unsafe/);

    await rm(paths.lockUrl);
    await mkdir(paths.lockUrl);
    await assert.rejects(executeTakedown(OPTIONS, urls(paths)), /operator lock is unsafe/);
  });
});

test('an applied takedown re-validates the written pair against the current clock', async () => {
  await withFiles(async paths => {
    const { now, ...withoutNow } = OPTIONS;
    const result = await executeTakedown({ ...withoutNow, dryRun: false }, urls(paths));
    assert.equal(result.changed, true);
    const written = JSON.parse(await readFile(paths.catalogUrl, 'utf8'));
    assert.equal(written.exercises.find(e => e.slug === 'focus-block-rollup').status, 'retired');
    assert.equal(existsSync(paths.lockUrl), false);
  });
});

test('the CLI entrypoint requires the takedown subcommand and reports failures with exit code 1', async () => {
  await assert.rejects(main(['retire']), /usage: catalog-provenance\.mjs takedown/);
  await assert.rejects(main([]), /usage: catalog-provenance\.mjs takedown/);
  await assert.rejects(main(['takedown', '--slug', '../escape']), /lowercase kebab-case/);

  const result = spawnSync(process.execPath, ['scripts/catalog-provenance.mjs', 'takedown', '--slug', 'BAD'], {
    cwd: ROOT, encoding: 'utf8',
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /^Catalogue provenance operation failed: --slug must be lowercase kebab-case/);
  assert.equal(result.stdout, '');
});

test('the CLI dry run validates the bundled catalogue without modifying it', () => {
  const before = [readFileSync(catalogPath, 'utf8'), readFileSync(manifestPath, 'utf8')];
  const result = spawnSync(process.execPath, [
    'scripts/catalog-provenance.mjs', 'takedown', ...BASE_ARGS, '--dry-run',
  ], { cwd: ROOT, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, 'Takedown dry run valid for focus-block-rollup@1; changed=true\n');
  assert.deepEqual([readFileSync(catalogPath, 'utf8'), readFileSync(manifestPath, 'utf8')], before);
  assert.equal(existsSync(new URL('../../data/.randori-catalog-provenance.lock', import.meta.url)), false);
});
