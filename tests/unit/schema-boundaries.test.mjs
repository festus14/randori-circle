import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import {
  checkSchemaBoundaries,
  scanSchemaBoundarySource,
} from '../static/check-schema-boundaries.mjs';

test('schema boundary scanner catches DDL modifiers and SQL comment separators', () => {
  const cases = [
    'CREATE TABLE records (id INTEGER)',
    'create\nunique\tindex idx_records on records(id)',
    'CREATE /* deploy-time only */ TEMPORARY TABLE records (id INTEGER)',
    'CREATE/* deploy-time only */VIRTUAL\nTABLE records USING fts5(value)',
    'CREATE OR /* deliberately split */ REPLACE VIEW records_view AS SELECT 1',
    'ALTER/* migration */TABLE records ADD COLUMN value TEXT',
    'DROP -- migration only\n INDEX idx_records',
    'DELETE/* repair */FROM\n pair_schedules WHERE id=1',
  ];

  for (const [index, source] of cases.entries()) {
    assert.ok(
      scanSchemaBoundarySource(`api/case-${index}.js`, source).length > 0,
      `expected a violation for: ${source}`,
    );
  }

  assert.deepEqual(
    scanSchemaBoundarySource('api/read-only.js', 'await db.execute("SELECT * FROM pairing_weeks")'),
    [],
  );
});

test('schema boundary scanner catches obvious concatenated and joined DDL literals', () => {
  const cases = [
    "const ddl = 'CREATE ' + 'TABLE hidden (id INTEGER)'",
    "const ddl = ['CREATE', 'UNIQUE', 'INDEX', 'idx_hidden ON hidden(id)'].join(' ')",
    "const ddl = [\"ALTER\", \"TABLE\", \"hidden ADD COLUMN value TEXT\"].join(\" \")",
    "const ddl = `DROP ` + `VIEW hidden_view`",
    "const ddl = ['DELETE', 'FROM', 'pair_schedules'].join(' ')",
  ];

  for (const [index, source] of cases.entries()) {
    assert.ok(
      scanSchemaBoundarySource(`api/assembled-${index}.ts`, source).length > 0,
      `expected assembled SQL to be rejected: ${source}`,
    );
  }
});

test('schema boundary checker scans nested JS and TypeScript module extensions recursively', () => {
  const directory = mkdtempSync(join(tmpdir(), 'randori-schema-boundaries-'));
  try {
    mkdirSync(join(directory, 'nested', 'routes'), { recursive: true });
    writeFileSync(join(directory, 'safe.js'), 'export const query = "SELECT 1";');
    for (const extension of ['mjs', 'cjs', 'ts', 'mts', 'cts']) {
      writeFileSync(
        join(directory, 'nested', 'routes', `unsafe.${extension}`),
        'export const migration = "CREATE UNIQUE INDEX idx_x ON x(id)";',
      );
    }
    writeFileSync(
      join(directory, 'nested', 'routes', 'ignored.txt'),
      'CREATE TABLE ignored (id INTEGER);',
    );

    const result = checkSchemaBoundaries(directory);
    assert.equal(result.runtimeFiles.length, 6);
    assert.equal(result.violations.length, 5);
    for (const extension of ['mjs', 'cjs', 'ts', 'mts', 'cts']) {
      assert.ok(
        result.violations.some(value =>
          new RegExp(`nested/routes/unsafe\\.${extension}:1: schema DDL`).test(value),
        ),
        `missing violation for .${extension}`,
      );
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
