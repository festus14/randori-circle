import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { validateCatalogFiles } from '../../scripts/validate-catalog.mjs';
import { canonicalExerciseHash } from '../../api/_catalog-provenance.js';

const root = fileURLToPath(new URL('../../', import.meta.url));
const catalogPath = new URL('../../data/randori-catalog-v1.json', import.meta.url);
const provenancePath = new URL('../../data/randori-catalog-provenance-v1.json', import.meta.url);
function cli(path) {
  return spawnSync(process.execPath, ['scripts/validate-catalog.mjs'], { cwd: root, encoding: 'utf8',
    env: { ...process.env, PATH: path, CATALOG_REQUIRE_GO: 'false' }, timeout: 30_000, maxBuffer: 256 * 1024 });
}

test('required validate:catalog gate fails with an actionable error when python3 is absent', () => {
  const directory = mkdtempSync(join(tmpdir(), 'randori-no-python-'));
  try {
    const result = cli(directory);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Catalogue reference validation requires python3 on PATH/);
    assert.doesNotMatch(result.stdout, /Catalogue and provenance valid/);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('required validate:catalog gate actually invokes all eight independent Python kit references', () => {
  const directory = mkdtempSync(join(tmpdir(), 'randori-python-gate-'));
  try {
    const python = spawnSync('python3', ['-c', 'import sys; print(sys.executable)'], { encoding: 'utf8' });
    assert.equal(python.status, 0, 'python3 is required for the existing catalogue gate');
    const executable = python.stdout.trim();
    const record = join(directory, 'calls');
    // Record only the fixed '-' argv, never the reference source on stdin.
    writeFileSync(join(directory, 'python3'), `#!/bin/sh\nprintf '%s\\n' "$*" >> ${JSON.stringify(record)}\nexec ${JSON.stringify(executable)} "$@"\n`, { mode: 0o700 });
    const result = cli(directory);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Catalogue and provenance valid: 28 exercises/);
    assert.deepEqual(readFileSync(record, 'utf8').trim().split('\n'), Array(8).fill('-'));
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('required catalogue gate retains the Missing Python reference guard', () => {
  const references = new URL('../../scripts/catalog-interview-kit-references.mjs', import.meta.url).href;
  const validator = new URL('../../scripts/validate-catalog.mjs', import.meta.url).href;
  const script = `import { mock } from 'node:test';
    mock.module(${JSON.stringify(references)}, { namedExports: { PYTHON_KIT_REFERENCES: {} } });
    const { validateCatalogFiles } = await import(${JSON.stringify(validator)});
    validateCatalogFiles();`;
  const result = spawnSync(process.execPath, ['--experimental-test-module-mocks', '--input-type=module', '-e', script], {
    cwd: root, encoding: 'utf8', timeout: 10_000,
  });
  assert.equal(result.status, 1); assert.match(result.stderr, /Missing Python reference: delivery-receipt-ledger@1/);
});

test('catalogue gate returns both independent-kit and additional-language validation evidence', () => {
  const result = validateCatalogFiles();
  assert.deepEqual(result.kitReferences, { exerciseCount: 8, caseCount: 160 });
  assert.equal(result.additional.typescriptCases, 80);
});

test('a hash-valid public example still must agree with the server oracle in the required gate', () => {
  const directory = mkdtempSync(join(tmpdir(), 'randori-example-gate-'));
  try {
    const catalog = JSON.parse(readFileSync(catalogPath, 'utf8'));
    const provenance = JSON.parse(readFileSync(provenancePath, 'utf8'));
    const exercise = catalog.exercises.find(item => item.slug === 'delivery-receipt-ledger');
    exercise.examples[0].output = ['wrong output'];
    provenance.records.find(record => record.key === `${exercise.slug}@${exercise.version}`).contentHash = canonicalExerciseHash(exercise);
    const source = join(directory, 'catalog.json'), manifest = join(directory, 'provenance.json');
    writeFileSync(source, JSON.stringify(catalog)); writeFileSync(manifest, JSON.stringify(provenance));
    assert.throws(() => validateCatalogFiles({ catalogPath: source, provenancePath: manifest }), /Public example disagrees with oracle/);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
