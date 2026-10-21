import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  assessMonitorArtifacts,
  assessScheduledRuns,
  discoverAuthoritativeEvidence,
  main,
  verifyDownloadedMonitor,
} from '../../scripts/github-backup-restore-watchdog.mjs';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const NOW = Date.parse('2026-09-22T06:00:00.000Z');
const ACTIVATION = '2026-09-21T03:17:00.000Z';
const MAX_AGE = 8 * 24 * 60 * 60 * 1000;
const STUCK_AFTER = 90 * 60 * 1000;
const GRACE = 8 * 60 * 60 * 1000;
const DEADLINE = GRACE + STUCK_AFTER;
const DAY = 24 * 60 * 60 * 1000;
const COMMIT = 'a'.repeat(40);
const DIGEST = 'b'.repeat(64);
const TOKEN = 'private-watchdog-token';

function run(overrides = {}) {
  return {
    id: 123, run_attempt: 2, event: 'schedule', head_branch: 'main', status: 'completed',
    conclusion: 'success', head_sha: COMMIT,
    created_at: '2026-09-21T03:17:00Z', updated_at: '2026-09-21T03:40:00Z',
    ...overrides,
  };
}

function runOptions(overrides = {}) {
  return {
    defaultBranch: 'main', maxRunAgeMs: MAX_AGE, stuckAfterMs: STUCK_AFTER,
    slotGraceMs: GRACE, slotDeadlineMs: DEADLINE, activationAt: ACTIVATION, clock: () => NOW, ...overrides,
  };
}

const artifact = (overrides = {}) => ({
  id: 456, name: 'turso-backup-monitor-123-2', expired: false, created_at: '2026-09-21T03:40:00Z', ...overrides,
});

function discovery() {
  return assessMonitorArtifacts([artifact()], assessScheduledRuns([run()], runOptions()),
    { maxRunAgeMs: MAX_AGE, clock: () => NOW });
}

function monitorSummary() {
  return {
    ok: true, kind: 'turso-backup-monitor', format: 'randori.turso-backup-monitor.v1',
    status: 'healthy', alert: false, category: null, checkedAt: '2026-09-21T03:39:00.000Z',
    owner: 'repository-operations', cadence: 'weekly', runId: 123, runAttempt: 2, repoCommit: COMMIT,
    objectives: { rpoTargetMs: 1_800_000, rtoTargetMs: 900_000, sourceSnapshotAgeMs: 1_000,
      restoredSnapshotAgeMs: 5_000, restoreDurationMs: 4_000 },
    counts: { tableCount: 37, totalRows: 84, sequenceRows: 8, appliedMigrationCount: 2 },
    checksums: { schemaManifest: DIGEST, sourceMigrations: DIGEST, finalMigrations: DIGEST, restoreComparison: DIGEST },
    cleanup: { sourceWriteStateRestored: true, restoreDeleted: true },
  };
}

function apiEnvironment(overrides = {}) {
  return {
    GITHUB_REPOSITORY: 'festus14/randori-circle', WATCHDOG_DEFAULT_BRANCH: 'main',
    GITHUB_API_URL: 'https://api.github.com/', GITHUB_TOKEN: TOKEN,
    WATCHDOG_CONTROL_ACTIVATION_AT: ACTIVATION,
    WATCHDOG_MAX_RUN_AGE_MS: String(MAX_AGE), WATCHDOG_STUCK_AFTER_MS: String(STUCK_AFTER),
    WATCHDOG_SLOT_GRACE_MS: String(GRACE), WATCHDOG_SLOT_DEADLINE_MS: String(DEADLINE),
    ...overrides,
  };
}

test('assessment parameters are validated before any run is considered', () => {
  assert.throws(() => assessScheduledRuns([], runOptions({ slotDeadlineMs: GRACE })), /schedule deadline is invalid/);
  // A missing, failed, or unfinished drill must alert within one day of its slot (#324).
  assert.equal(assessScheduledRuns([], runOptions({ slotDeadlineMs: DAY })).category, 'run_missing');
  assert.throws(() => assessScheduledRuns([], runOptions({ slotDeadlineMs: DAY + 1 })), /schedule deadline is invalid/);
  assert.throws(() => assessScheduledRuns([], runOptions({ slotGraceMs: DAY + 1, slotDeadlineMs: DAY })),
    /schedule grace is invalid/);
  assert.throws(() => assessScheduledRuns([], runOptions({ maxRunAgeMs: '0' })), /maximum run age is invalid/);
  assert.throws(() => assessScheduledRuns([], runOptions({ clock: () => Number.NaN })), /watchdog clock is invalid/);
  assert.throws(() => assessScheduledRuns([], runOptions({ activationAt: 42 })), /control activation epoch is invalid/);
  assert.throws(() => assessScheduledRuns([], runOptions({ activationAt: '2026-09-21T03:17:00.5Z' })),
    /control activation epoch is not a rehearsal slot/);
  assert.equal(assessScheduledRuns([], runOptions({ clock: () => new Date(NOW) })).checkedAt, '2026-09-22T06:00:00.000Z');

  const badBranch = assessScheduledRuns([run()], runOptions({ defaultBranch: 'main branch' }));
  assert.equal(badBranch.category, 'api_failure');
  assert.equal(badBranch.activationAt, ACTIVATION);
  assert.equal('expectedAt' in badBranch, false);
});

test('malformed or foreign run records are ignored rather than trusted', () => {
  const malformed = [
    run({ event: 'push' }),
    run({ head_branch: 'feature' }),
    run({ id: 0 }),
    run({ run_attempt: 'x' }),
    run({ updated_at: '2026-09-21T03:16:00Z' }),
    run({ created_at: '2026-09-21 03:17:00' }),
    run({ created_at: '2026-02-30T03:17:00Z' }),
    run({ status: 7 }),
    run({ conclusion: 0 }),
    null,
    'run',
  ];
  assert.equal(assessScheduledRuns(malformed, runOptions()).category, 'run_missing');
  assert.equal(assessScheduledRuns({ workflow_runs: [run()] }, runOptions()).category, 'run_missing');
});

const later = {
  id: 124, run_attempt: 1, status: 'in_progress', conclusion: null,
  created_at: '2026-09-22T05:30:00Z', updated_at: '2026-09-22T05:31:00Z',
};

test('an in-flight run defers to a previous success or reports observation', () => {
  // An in-flight run long after the Monday slot deadline is stuck, not observed.
  const pastDeadline = assessScheduledRuns([run(later)], runOptions({
    clock: () => Date.parse('2026-09-22T05:45:00.000Z'),
  }));
  assert.equal(pastDeadline.category, 'run_stuck');
  // A run started within its slot window with no earlier success is merely observed.
  const inWindow = assessScheduledRuns([run({ ...later, created_at: '2026-09-28T03:20:00Z', updated_at: '2026-09-28T03:21:00Z' })],
    runOptions({ clock: () => Date.parse('2026-09-28T03:40:00.000Z') }));
  assert.equal(inWindow.status, 'observing');
  assert.equal(inWindow.runStatus, 'in_progress');
  assert.equal(inWindow.runId, 124);

  // With an earlier success in the same window, the success becomes the candidate.
  const withSuccess = assessScheduledRuns([
    run({ ...later, created_at: '2026-09-28T03:20:00Z', updated_at: '2026-09-28T03:21:00Z' }),
    run({ id: 120, created_at: '2026-09-28T03:17:00Z', updated_at: '2026-09-28T03:19:00Z' }),
  ], runOptions({ clock: () => Date.parse('2026-09-28T03:40:00.000Z') }));
  assert.equal(withSuccess.candidate, true);
  assert.equal(withSuccess.runId, 120);
  assert.equal(withSuccess.expectedAt, '2026-09-21T03:17:00.000Z');

  const staleSuccess = assessScheduledRuns([
    run({ ...later, created_at: '2026-09-28T03:20:00Z', updated_at: '2026-09-28T03:21:00Z' }),
    run({ id: 120, created_at: '2026-09-28T03:17:00Z', updated_at: '2026-09-28T03:19:00Z' }),
  ], runOptions({ clock: () => Date.parse('2026-09-28T03:40:00.000Z'), maxRunAgeMs: 60_000 }));
  assert.equal(staleSuccess.category, 'run_stale');
  assert.equal(staleSuccess.runId, 120);
});

test('artifact assessment passes through non-candidates and rejects ambiguous artifacts', () => {
  const missing = assessScheduledRuns([], runOptions());
  assert.equal(assessMonitorArtifacts([artifact()], missing, { maxRunAgeMs: MAX_AGE, clock: () => NOW }), missing);
  const candidate = assessScheduledRuns([run()], runOptions());
  const opts = { maxRunAgeMs: MAX_AGE, clock: () => NOW };
  assert.equal(assessMonitorArtifacts(null, candidate, opts).category, 'artifact_missing');
  assert.equal(assessMonitorArtifacts([artifact(), artifact({ id: 457 })], candidate, opts).category, 'artifact_missing');
  assert.equal(assessMonitorArtifacts([artifact({ id: 'x' })], candidate, opts).category, 'artifact_corrupt');
  assert.equal(assessMonitorArtifacts([artifact({ created_at: 'yesterday' })], candidate, opts).category, 'artifact_corrupt');
  assert.throws(() => assessMonitorArtifacts([], candidate, { maxRunAgeMs: -1, clock: () => NOW }),
    /maximum artifact age is invalid/);
});

test('downloaded monitor verification rejects a missing discovery and future or weak evidence', () => {
  const opts = { maxRunAgeMs: MAX_AGE, activationAt: ACTIVATION, clock: () => NOW };
  assert.equal(verifyDownloadedMonitor(monitorSummary(), null, opts).category, 'artifact_corrupt');
  assert.equal(verifyDownloadedMonitor(null, discovery(), opts).category, 'artifact_corrupt');
  const variants = [
    { checkedAt: '2026-09-22T06:00:01.000Z' },
    { objectives: { ...monitorSummary().objectives, restoreDurationMs: 900_001 } },
    { objectives: { ...monitorSummary().objectives, sourceSnapshotAgeMs: -1 } },
    { counts: { ...monitorSummary().counts, tableCount: 0 } },
    { checksums: { ...monitorSummary().checksums, restoreComparison: 'z' } },
    { repoCommit: 42 },
  ];
  for (const overrides of variants) {
    assert.equal(verifyDownloadedMonitor({ ...monitorSummary(), ...overrides }, discovery(), opts).category,
      'artifact_corrupt', JSON.stringify(overrides));
  }
});

test('discovery configuration fails closed before any GitHub request', async () => {
  let requests = 0;
  const fetchImpl = async () => { requests += 1; return { ok: true, json: async () => ({}) }; };
  for (const overrides of [
    { GITHUB_REPOSITORY: 'not a repo' },
    { GITHUB_TOKEN: '' },
    { GITHUB_API_URL: 'http://api.github.com' },
    { GITHUB_API_URL: undefined },
  ]) {
    await assert.rejects(discoverAuthoritativeEvidence(apiEnvironment(overrides), { fetchImpl, clock: () => NOW }),
      /watchdog API configuration is invalid/);
  }
  await assert.rejects(discoverAuthoritativeEvidence(apiEnvironment({ WATCHDOG_STUCK_AFTER_MS: 'soon' }),
    { fetchImpl, clock: () => NOW }), /stuck-run age is invalid/);
  assert.equal(requests, 0);
});

test('discovery stops after the run query when the run is not a candidate, and rejects HTTP errors', async () => {
  const urls = [];
  const failedRun = await discoverAuthoritativeEvidence(apiEnvironment(), {
    clock: () => NOW,
    fetchImpl: async url => { urls.push(url); return { ok: true, json: async () => ({ workflow_runs: [run({ conclusion: 'failure' })] }) }; },
  });
  assert.equal(failedRun.category, 'run_failed');
  assert.equal(urls.length, 1);
  assert.match(urls[0], /^https:\/\/api\.github\.com\/repos\//);

  await assert.rejects(discoverAuthoritativeEvidence(apiEnvironment(), {
    clock: () => NOW, fetchImpl: async () => ({ ok: false, status: 403, json: async () => ({ message: TOKEN }) }),
  }), error => error.message === 'GitHub API request failed');
});

const directories = [];
afterEach(() => { while (directories.length) rmSync(directories.pop(), { recursive: true, force: true }); });

function workspace() {
  const directory = mkdtempSync(join(tmpdir(), 'randori-cov-watchdog-'));
  directories.push(directory);
  return directory;
}

async function runMain(argv, environment, extra = {}) {
  let stdout = '';
  const execution = await main({ argv, environment, stdout: { write(value) { stdout += value; } }, clock: () => NOW, ...extra });
  assert.deepEqual(JSON.parse(stdout), execution.result);
  return execution;
}

test('CLI usage errors become sanitized alerts keyed to the requested mode', async () => {
  const directory = workspace();
  const output = join(directory, 'backup-watchdog-summary.json');
  const environment = { RUNNER_TEMP: directory, WATCHDOG_CONTROL_ACTIVATION_AT: ACTIVATION };
  for (const [argv, category] of [
    [['--mode', 'repair', '--output', output], 'api_failure'],
    [['--mode', 'discover'], 'api_failure'],
    [['--mode', 'discover', '--output', output, '--token', TOKEN], 'api_failure'],
    [['--mode', 'verify', '--output', output], 'artifact_corrupt'],
    [['--mode', 'verify', '--mode', 'verify', '--output', output], 'artifact_corrupt'],
  ]) {
    rmSync(output, { force: true });
    const execution = await runMain(argv, environment);
    assert.equal(execution.result.category, category, argv.join(' '));
    assert.equal(execution.result.activationAt, ACTIVATION);
    assert.doesNotMatch(JSON.stringify(execution.result), new RegExp(TOKEN));
  }
});

test('CLI alerts omit the activation epoch when it is itself invalid', async () => {
  const directory = workspace();
  const execution = await runMain(['--mode', 'discover', '--output', join(directory, 'backup-watchdog-summary.json')],
    { ...apiEnvironment({ WATCHDOG_CONTROL_ACTIVATION_AT: 'never' }), RUNNER_TEMP: directory });
  assert.equal(execution.exitCode, 0);
  assert.equal(execution.result.category, 'api_failure');
  assert.equal('activationAt' in execution.result, false);
});

test('CLI verify mode emits a healthy projection and candidate GitHub outputs', async () => {
  const directory = workspace();
  const discoveryPath = join(directory, 'backup-watchdog-summary.json');
  const monitorDirectory = join(directory, 'monitor');
  mkdirSync(monitorDirectory);
  const monitorPath = join(monitorDirectory, 'backup-monitor-summary.json');
  writeFileSync(discoveryPath, JSON.stringify(discovery()));
  writeFileSync(monitorPath, JSON.stringify(monitorSummary()));
  const output = join(directory, 'verified', 'backup-watchdog-summary.json');
  const execution = await runMain(
    ['--mode', 'verify', '--discovery', discoveryPath, '--monitor-summary', monitorPath, '--output', output],
    { RUNNER_TEMP: directory, WATCHDOG_CONTROL_ACTIVATION_AT: ACTIVATION, WATCHDOG_MAX_RUN_AGE_MS: String(MAX_AGE) },
  );
  assert.equal(execution.exitCode, 0);
  assert.equal(execution.result.status, 'healthy');
  assert.equal(execution.result.monitorCheckedAt, '2026-09-21T03:39:00.000Z');
  assert.deepEqual(JSON.parse(readFileSync(output, 'utf8')), execution.result);
});

test('CLI discover mode writes candidate outputs including the exact artifact name', async () => {
  const directory = workspace();
  const githubOutput = join(directory, 'github-output');
  writeFileSync(githubOutput, '');
  const fetchImpl = async url => ({
    ok: true,
    json: async () => (url.includes('/artifacts?') ? { artifacts: [artifact()] } : { workflow_runs: [run()] }),
  });
  const execution = await runMain(['--mode', 'discover', '--output', join(directory, 'backup-watchdog-summary.json')],
    { ...apiEnvironment(), RUNNER_TEMP: directory, GITHUB_OUTPUT: githubOutput }, { fetchImpl });
  assert.equal(execution.result.status, 'candidate');
  assert.equal(readFileSync(githubOutput, 'utf8'),
    'alert=false\ncategory=candidate\ncandidate=true\nrun_id=123\nrun_attempt=2\nartifact_name=turso-backup-monitor-123-2\n');
});

test('CLI verify mode refuses evidence paths outside RUNNER_TEMP, misnamed, or symlinked', async () => {
  const directory = workspace();
  const outside = workspace();
  writeFileSync(join(outside, 'backup-monitor-summary.json'), JSON.stringify(monitorSummary()));
  writeFileSync(join(outside, 'backup-watchdog-summary.json'), JSON.stringify(discovery()));
  const discoveryPath = join(directory, 'backup-watchdog-summary.json');
  writeFileSync(discoveryPath, JSON.stringify(discovery()));
  symlinkSync(outside, join(directory, 'linked'));
  symlinkSync(join(outside, 'backup-monitor-summary.json'), join(directory, 'backup-monitor-summary.json'));
  const oversized = join(directory, 'big');
  mkdirSync(oversized);
  writeFileSync(join(oversized, 'backup-monitor-summary.json'), ' '.repeat(128 * 1024 + 1));
  const environment = { RUNNER_TEMP: directory, WATCHDOG_CONTROL_ACTIVATION_AT: ACTIVATION, WATCHDOG_MAX_RUN_AGE_MS: String(MAX_AGE) };
  for (const monitorPath of [
    'backup-monitor-summary.json',
    join(directory, 'monitor.json'),
    join(outside, 'backup-monitor-summary.json'),
    join(directory, 'linked', 'backup-monitor-summary.json'),
    join(directory, 'backup-monitor-summary.json'),
    join(oversized, 'backup-monitor-summary.json'),
  ]) {
    const output = join(directory, 'out', 'backup-watchdog-summary.json');
    rmSync(output, { force: true });
    const execution = await runMain(
      ['--mode', 'verify', '--discovery', discoveryPath, '--monitor-summary', monitorPath, '--output', output],
      environment,
    );
    assert.equal(execution.exitCode, 0);
    assert.equal(execution.result.category, 'artifact_corrupt', monitorPath);
  }
});

test('an unwritable output artifact makes the CLI exit 1 while still printing the result', async () => {
  const directory = workspace();
  const outside = workspace();
  for (const output of [join(outside, 'backup-watchdog-summary.json'), join(directory, 'wrong-name.json')]) {
    const execution = await runMain(['--mode', 'verify', '--output', output],
      { RUNNER_TEMP: directory, WATCHDOG_CONTROL_ACTIVATION_AT: ACTIVATION });
    assert.equal(execution.exitCode, 1);
    assert.equal(execution.result.category, 'artifact_corrupt');
    assert.equal(existsSync(output), false);
  }
});

test('the script entrypoint exits 1 when it cannot persist its artifact', () => {
  const result = spawnSync(process.execPath, ['scripts/github-backup-restore-watchdog.mjs'], {
    cwd: ROOT, encoding: 'utf8', env: { PATH: process.env.PATH },
  });
  assert.equal(result.status, 1, result.stderr);
  const document = JSON.parse(result.stdout);
  assert.equal(document.alert, true);
  assert.equal(document.category, 'api_failure');
});
