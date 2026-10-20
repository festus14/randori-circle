import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { assessBackupRestoreRun, main } from '../../scripts/turso-backup-restore-monitor.mjs';
import { REHEARSAL_FORMAT } from '../../scripts/turso-backup-restore-rehearsal.mjs';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const NOW = Date.parse('2026-09-21T03:30:00.000Z');
const COMMIT = 'a'.repeat(40);
const DIGEST = 'b'.repeat(64);
const cleanup = Object.freeze({
  ok: true, kind: 'turso-backup-restore-cleanup', format: REHEARSAL_FORMAT, repoCommit: COMMIT,
  noState: false, recoveryRequired: false,
  safety: {
    sourceIdentityVerified: true, writesBlockedBeforePitr: true, sourceWriteStateRestored: true,
    restoreIdentityVerified: true, restoreDeleted: true, sourceMigrated: false, sourceDeleted: false,
    credentialsInvalidated: false,
  },
});

function payload(overrides = {}) {
  return {
    context: { repoCommit: COMMIT }, issuedAt: '2026-09-21T03:29:00.000Z',
    schema: { manifestChecksum: DIGEST, sourceExecutableMigrationsChecksum: DIGEST, finalExecutableMigrationsChecksum: DIGEST },
    migration: { appliedVersions: [1] },
    evidence: { comparisonDigest: DIGEST },
    verification: {
      rpoMet: true, rtoMet: true, rpoTargetMs: 1_800_000, rtoTargetMs: 900_000,
      sourceSnapshotAgeMs: 1, restoredSnapshotAgeMs: 2, restoreDurationMs: 3,
      tableCount: 1, totalRows: 0, sequenceRows: 0,
    },
    ...overrides,
  };
}

function options(overrides = {}) {
  return {
    runId: 100, runAttempt: 1, repoCommit: COMMIT, maxSuccessAgeMs: 1_800_000,
    rpoTargetMs: 1_800_000, rtoTargetMs: 900_000, clock: () => NOW, verify: value => value.payload,
    ...overrides,
  };
}

const assess = (rehearsal, opts = {}, cleanupSummary = cleanup) => assessBackupRestoreRun(
  { rehearsal, cleanup: cleanupSummary }, options(opts),
);
const healthy = () => ({ ok: true, payload: payload() });

test('run identity and commit binding are validated before any evidence is read', () => {
  for (const run of [{ runId: 0 }, { runId: '01' }, { runAttempt: 1_000_001 }, { runId: 1.5 }]) {
    const result = assess(healthy(), run);
    assert.equal(result.category, 'evidence_corrupt');
    assert.equal('runId' in result, false, JSON.stringify(run));
  }
  const badCommit = assess(healthy(), { repoCommit: 'HEAD' });
  assert.equal(badCommit.category, 'evidence_corrupt');
  assert.equal(badCommit.runId, 100);

  // Numeric strings (as provided by GitHub) and 64-hex SHA-256 commits are accepted.
  const sha256Commit = 'c'.repeat(64);
  const accepted = assess(healthy(), { runId: '100', runAttempt: '2', repoCommit: sha256Commit },
    { ...cleanup, repoCommit: sha256Commit });
  assert.equal(accepted.status, 'healthy');
  assert.equal(accepted.runAttempt, 2);
  assert.equal(accepted.repoCommit, sha256Commit);
});

test('missing cleanup evidence and a cleanup-required rehearsal are distinct alerts', () => {
  assert.equal(assess(healthy(), {}, null).category, 'evidence_missing');
  assert.equal(assess(undefined).category, 'evidence_missing');
  assert.equal(assess({ ok: false, error: 'REHEARSAL_RESTORE_CLEANUP_REQUIRED' }).category, 'cleanup_failure');
  assert.equal(assess({ ok: 'yes' }).category, 'rehearsal_failure');
  assert.equal(assess(healthy(), {}, { ...cleanup, safety: { ...cleanup.safety, sourceIdentityVerified: 'yes' } }).category,
    'cleanup_failure');
  assert.equal(assess(healthy(), {}, { ...cleanup, safety: null }).category, 'cleanup_failure');
});

test('evidence age policy and timestamps fail closed when invalid or in the future', () => {
  assert.equal(assess(healthy(), { maxSuccessAgeMs: 'forever' }).category, 'evidence_corrupt');
  assert.equal(assess(healthy(), { maxSuccessAgeMs: 91 * 24 * 60 * 60 * 1000 }).category, 'evidence_corrupt');
  assert.equal(assess({ ok: true, payload: payload({ issuedAt: 'yesterday' }) }).category, 'evidence_corrupt');
  assert.equal(assess({ ok: true, payload: payload({ issuedAt: '2026-09-21T03:31:00.000Z' }) }).category,
    'evidence_corrupt');
  assert.equal(assess({ ok: true }).category, 'evidence_corrupt');
  assert.equal(assess(healthy(), { rpoTargetMs: 'abc' }).category, 'evidence_corrupt');
  assert.equal(assess(healthy(), { rtoTargetMs: undefined }).category, 'evidence_corrupt');
});

test('a verified payload must still carry met objectives, sane counts, and digests', () => {
  const base = payload();
  const variants = [
    { verification: null },
    { verification: { ...base.verification, rpoMet: false } },
    { verification: { ...base.verification, rtoMet: 'true' } },
    { verification: { ...base.verification, tableCount: 0 } },
    { verification: { ...base.verification, totalRows: 1.5 } },
    { verification: { ...base.verification, sequenceRows: -1 } },
    { migration: { appliedVersions: 'all' } },
    { schema: { ...base.schema, manifestChecksum: 'B'.repeat(64) } },
    { evidence: {} },
  ];
  for (const overrides of variants) {
    assert.equal(assess(healthy(), { verify: () => payload(overrides) }).category, 'evidence_corrupt',
      JSON.stringify(overrides));
  }
  assert.equal(assess(healthy(), { verify: () => null }).category, 'evidence_corrupt');
});

test('the monitor clock accepts Date values and rejects invalid clocks', () => {
  assert.equal(assess(healthy(), { clock: () => new Date(NOW) }).checkedAt, '2026-09-21T03:30:00.000Z');
  assert.throws(() => assess(healthy(), { clock: () => -1 }), /monitor clock is invalid/);
  assert.throws(() => assess(healthy(), { clock: () => 'soon' }), /monitor clock is invalid/);
  // Without an injected clock the monitor uses the wall clock, so fixed evidence is stale.
  assert.equal(assessBackupRestoreRun({ rehearsal: healthy(), cleanup }, { ...options(), clock: undefined }).category,
    'evidence_stale');
});

const directories = [];
afterEach(() => { while (directories.length) rmSync(directories.pop(), { recursive: true, force: true }); });

function workspace() {
  const directory = mkdtempSync(join(tmpdir(), 'randori-cov-monitor-'));
  directories.push(directory);
  const artifacts = join(directory, 'public-artifacts');
  mkdirSync(artifacts, { mode: 0o700 });
  return {
    directory,
    rehearsal: join(artifacts, 'rehearsal-summary.json'),
    cleanup: join(artifacts, 'cleanup-summary.json'),
    output: join(artifacts, 'backup-monitor-summary.json'),
  };
}

const env = directory => ({ RUNNER_TEMP: directory, GITHUB_RUN_ID: '100', GITHUB_RUN_ATTEMPT: '1', REHEARSAL_REPO_COMMIT: COMMIT });

async function runMain(argv, environment) {
  let stdout = '';
  const execution = await main({ argv, environment, stdout: { write(value) { stdout += value; } }, clock: () => NOW });
  assert.equal(execution.exitCode, 0);
  assert.deepEqual(JSON.parse(stdout), execution.result);
  return execution.result;
}

test('CLI usage errors produce a corrupt-evidence alert and still exit 0', async () => {
  const paths = workspace();
  const usages = [
    [],
    ['--rehearsal-summary', paths.rehearsal, '--cleanup-summary', paths.cleanup, '--verbose', paths.output],
    ['--rehearsal-summary', paths.rehearsal, '--rehearsal-summary', paths.cleanup, '--output', paths.output],
    ['--rehearsal-summary', '', '--cleanup-summary', paths.cleanup, '--output', paths.output],
  ];
  for (const argv of usages) {
    const result = await runMain(argv, env(paths.directory));
    assert.equal(result.category, 'evidence_corrupt');
    assert.equal('runId' in result, false);
  }
  assert.equal(existsSync(paths.output), false);
});

const argvFor = paths => ['--rehearsal-summary', paths.rehearsal, '--cleanup-summary', paths.cleanup, '--output', paths.output];

test('corrupt, oversized, or symlinked evidence files are reported as corrupt evidence', async () => {
  const cases = [
    paths => writeFileSync(paths.rehearsal, '{"ok":'),
    paths => writeFileSync(paths.rehearsal, ' '.repeat(128 * 1024 + 1)),
    paths => {
      const outside = join(paths.directory, 'outside.json');
      writeFileSync(outside, JSON.stringify(healthy()));
      symlinkSync(outside, paths.rehearsal);
    },
    paths => mkdirSync(paths.cleanup),
  ];
  for (const prepare of cases) {
    const paths = workspace();
    prepare(paths);
    const result = await runMain(argvFor(paths), env(paths.directory));
    assert.equal(result.category, 'evidence_corrupt');
    assert.equal(result.runId, 100);
    assert.deepEqual(JSON.parse(readFileSync(paths.output, 'utf8')), result);
  }
});

test('evidence paths must be absolute, correctly named, and inside RUNNER_TEMP', async () => {
  const paths = workspace();
  const outsideDirectory = mkdtempSync(join(tmpdir(), 'randori-cov-monitor-outside-'));
  directories.push(outsideDirectory);
  writeFileSync(join(outsideDirectory, 'rehearsal-summary.json'), JSON.stringify(healthy()));
  symlinkSync(outsideDirectory, join(paths.directory, 'linked'));
  for (const rehearsal of [
    'public-artifacts/rehearsal-summary.json',
    join(paths.directory, 'public-artifacts', 'other.json'),
    join(paths.directory, '..', 'rehearsal-summary.json'),
    join(paths.directory, 'linked', 'rehearsal-summary.json'),
  ]) {
    const result = await runMain(argvFor({ ...paths, rehearsal }), env(paths.directory));
    assert.equal(result.category, 'evidence_corrupt', rehearsal);
  }
});

test('corrupt evidence with an unusable run identity omits run metadata', async () => {
  const paths = workspace();
  writeFileSync(paths.rehearsal, 'not json');
  const result = await runMain(argvFor(paths), { ...env(paths.directory), GITHUB_RUN_ID: 'abc' });
  assert.equal(result.category, 'evidence_corrupt');
  assert.equal('runId' in result, false);
});

test('an existing output artifact is never overwritten', async () => {
  const paths = workspace();
  writeFileSync(paths.output, 'previous\n');
  const result = await runMain(argvFor(paths), env(paths.directory));
  assert.equal(result.category, 'evidence_corrupt');
  assert.equal(readFileSync(paths.output, 'utf8'), 'previous\n');
});

test('the output directory is created when absent and GitHub outputs are optional', async () => {
  const paths = workspace();
  const output = join(paths.directory, 'fresh', 'backup-monitor-summary.json');
  const result = await runMain(argvFor({ ...paths, output }), env(paths.directory));
  assert.equal(result.category, 'evidence_missing');
  assert.deepEqual(JSON.parse(readFileSync(output, 'utf8')), result);
});

test('the script entrypoint emits one alert document and exits 0 even without arguments', () => {
  const result = spawnSync(process.execPath, ['scripts/turso-backup-restore-monitor.mjs'], {
    cwd: ROOT, encoding: 'utf8', env: { PATH: process.env.PATH },
  });
  assert.equal(result.status, 0, result.stderr);
  const document = JSON.parse(result.stdout);
  assert.equal(document.alert, true);
  assert.equal(document.category, 'evidence_corrupt');
});
