import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { main as crdtMain, verifyCrdtBundle } from '../../scripts/check-crdt-bundle.mjs';
import {
  main as generateSchemaReadiness,
  renderSchemaReadinessModule,
  SCHEMA_READINESS_DESTINATION,
} from '../../scripts/generate-schema-readiness.mjs';
import {
  CATALOG_PATH,
  main as validateCatalogMain,
  PROVENANCE_PATH,
  validateCatalogFiles,
} from '../../scripts/validate-catalog.mjs';
import { SCHEMA_MANIFEST } from '../../db/schema-manifest.js';

function sink() {
  const chunks = [];
  return { write: chunk => { chunks.push(String(chunk)); return true; }, text: () => chunks.join('') };
}

function tempDir(t) {
  const directory = mkdtempSync(join(tmpdir(), 'randori-p5-tools-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}

// ------------------------------------------------------------ CRDT bundle ---

test('the CRDT check refuses a build whose bytes differ from the checked-in asset', async () => {
  const calls = [];
  await assert.rejects(verifyCrdtBundle({
    buildBundle: async options => {
      calls.push(options);
      return { outputFiles: [{ contents: new TextEncoder().encode('rebuilt') }] };
    },
    readBundle: async () => Buffer.from('checked-in'),
  }), /assets\/crdt-editor\.js is stale; run npm run build:crdt/);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].write, false, 'the check must never overwrite the asset');
  assert.equal(calls[0].bundle, true);
  assert.deepEqual(calls[0].entryPoints, ['assets/crdt-editor-source.js']);
});

test('the CRDT check refuses a build that emits more than one output file', async () => {
  const same = new TextEncoder().encode('same');
  await assert.rejects(verifyCrdtBundle({
    buildBundle: async () => ({ outputFiles: [{ contents: same }, { contents: same }] }),
    readBundle: async () => Buffer.from(same),
  }), /stale/);
});

test('the CRDT check accepts byte-identical output', async () => {
  const bytes = new TextEncoder().encode('identical');
  assert.equal(await verifyCrdtBundle({
    buildBundle: async () => ({ outputFiles: [{ contents: bytes }] }),
    readBundle: async () => Buffer.from(bytes),
  }), true);
});

test('the CRDT CLI reports success on stdout and staleness on stderr with exit 1', async () => {
  const okOut = sink();
  const okErr = sink();
  assert.equal(await crdtMain({ stdout: okOut, stderr: okErr, verify: async () => true }), 0);
  assert.equal(okOut.text(), 'CRDT bundle is current\n');
  assert.equal(okErr.text(), '');

  const out = sink();
  const err = sink();
  assert.equal(await crdtMain({
    stdout: out,
    stderr: err,
    verify: async () => { throw new Error('assets/crdt-editor.js is stale; run npm run build:crdt'); },
  }), 1);
  assert.equal(out.text(), '');
  assert.equal(err.text(), 'assets/crdt-editor.js is stale; run npm run build:crdt\n');

  const thrownValue = sink();
  assert.equal(await crdtMain({ stdout: sink(), stderr: thrownValue, verify: async () => { throw 'esbuild unavailable'; } }), 1);
  assert.equal(thrownValue.text(), 'esbuild unavailable\n');
});

test('the CRDT CLI exits 0 against the checked-in bundle', () => {
  const result = spawnSync(process.execPath, ['scripts/check-crdt-bundle.mjs'], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, 'CRDT bundle is current\n');
});

// ---------------------------------------------------- schema readiness ---

test('the checked-in readiness manifest is exactly what the generator produces', () => {
  assert.equal(readFileSync(SCHEMA_READINESS_DESTINATION, 'utf8'), renderSchemaReadinessModule());
});

test('the generated readiness module carries no executable SQL', async () => {
  const source = renderSchemaReadinessModule();
  assert.match(source, /^\/\/ Generated from the pinned schema manifest\./);
  assert.match(source, /export const READINESS_SCHEMA_MANIFEST=Object\.freeze\(/);
  assert.doesNotMatch(source, /\b(?:CREATE|INSERT|UPDATE|DELETE|DROP|ALTER)\s+(?:TABLE|INDEX|INTO|FROM|TRIGGER|VIEW)\b/i);
});

test('the readiness generator projects the manifest it is given and refuses a missing one', () => {
  const source = renderSchemaReadinessModule({ ...SCHEMA_MANIFEST, tables: SCHEMA_MANIFEST.tables.slice(0, 1) });
  const projected = JSON.parse(source.match(/Object\.freeze\((.*)\);\n$/s)[1]);
  assert.deepEqual(projected.tables.map(table => table.name), [SCHEMA_MANIFEST.tables[0].name]);
  assert.equal(projected.checksum, SCHEMA_MANIFEST.checksum);
  assert.throws(() => renderSchemaReadinessModule(null), /a schema manifest is required/);
});

test('the readiness generator writes the rendered module to the given destination', async t => {
  const destination = join(tempDir(t), 'readiness.js');
  assert.equal(await generateSchemaReadiness({ argv: [], destination }), 0);
  assert.equal(readFileSync(destination, 'utf8'), renderSchemaReadinessModule());
});

test('the readiness generator check mode reports drift without writing', async t => {
  const directory = tempDir(t);
  const stale = join(directory, 'stale.js');
  writeFileSync(stale, '// stale\n');
  assert.equal(await generateSchemaReadiness({ argv: ['--check'], destination: stale }), 1);
  assert.equal(readFileSync(stale, 'utf8'), '// stale\n', 'check mode never rewrites the file');
  assert.equal(await generateSchemaReadiness({ argv: ['--check'], destination: join(directory, 'missing.js') }), 1);
  const current = join(directory, 'current.js');
  writeFileSync(current, renderSchemaReadinessModule());
  assert.equal(await generateSchemaReadiness({ argv: ['--check'], destination: current }), 0);
});

test('the readiness generator CLI check passes on the checked-in module', () => {
  const result = spawnSync(process.execPath, ['scripts/generate-schema-readiness.mjs', '--check'], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
});

// ------------------------------------------------------ catalogue check ---

test('the bundled catalogue and provenance validate and report the exercise count', () => {
  const out = sink();
  const result = validateCatalogMain({ stdout: out });
  assert.ok(result.exerciseCount > 0);
  assert.equal(out.text(), `Catalogue and provenance valid: ${result.exerciseCount} exercises\n`);
  assert.equal(validateCatalogFiles().exerciseCount, result.exerciseCount);
});

test('catalogue validation fails closed on tampered provenance', t => {
  const directory = tempDir(t);
  const provenance = JSON.parse(readFileSync(PROVENANCE_PATH, 'utf8'));
  const provenancePath = join(directory, 'provenance.json');
  writeFileSync(provenancePath, JSON.stringify({ ...provenance, records: provenance.records.slice(1) }));
  assert.throws(() => validateCatalogFiles({ provenancePath }));
});

test('catalogue validation fails closed on a tampered catalogue', t => {
  const directory = tempDir(t);
  const catalog = JSON.parse(readFileSync(CATALOG_PATH, 'utf8'));
  const catalogPath = join(directory, 'catalog.json');
  writeFileSync(catalogPath, JSON.stringify({ ...catalog, exercises: [] }));
  const out = sink();
  assert.throws(() => validateCatalogMain({ stdout: out, catalogPath }));
  assert.equal(out.text(), '', 'nothing is reported as valid when validation fails');
});

test('catalogue validation refuses malformed JSON', t => {
  const directory = tempDir(t);
  const catalogPath = join(directory, 'catalog.json');
  writeFileSync(catalogPath, '{"exercises":');
  assert.throws(() => validateCatalogFiles({ catalogPath }), SyntaxError);
});

test('the catalogue CLI exits 0 and prints the count for the bundled data', () => {
  const ok = spawnSync(process.execPath, ['scripts/validate-catalog.mjs'], { encoding: 'utf8' });
  assert.equal(ok.status, 0, ok.stderr);
  assert.match(ok.stdout, /^Catalogue and provenance valid: \d+ exercises\n$/);
});
