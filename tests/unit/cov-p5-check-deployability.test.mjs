import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  inspectDeploymentContract,
  securityHeaderIsSafe,
  validateDeploymentContract,
} from '../../scripts/check-deployability.mjs';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const SCRIPT = join(ROOT, 'scripts/check-deployability.mjs');
const read = path => readFileSync(join(ROOT, path), 'utf8');

function contract() {
  return {
    vercel: JSON.parse(read('vercel.json')),
    packageJson: JSON.parse(read('package.json')),
    outboxWorkflow: read('.github/workflows/outbox-dispatch.yml'),
    outboxWatchdogWorkflow: read('.github/workflows/outbox-dispatch-watchdog.yml'),
    outboxWatchdogScript: read('scripts/github-outbox-dispatch-watchdog.mjs'),
    productionSmokeWorkflow: read('.github/workflows/production-smoke.yml'),
    files: new Set([
      'index.html', 'package-lock.json', 'package.json', 'vercel.json',
      '.github/workflows/outbox-dispatch.yml', '.github/workflows/outbox-dispatch-watchdog.yml',
      'scripts/github-outbox-dispatch-watchdog.mjs', '.github/workflows/production-smoke.yml',
      'scripts/production-smoke.mjs', 'privacy.html', 'terms.html',
      ...readdirSync(join(ROOT, 'api')).filter(file => file.endsWith('.js')).map(file => `api/${file}`),
    ]),
  };
}

test('a non-object vercel.json short-circuits with a single actionable error', () => {
  for (const vercel of [null, [], 'text']) {
    assert.deepEqual(validateDeploymentContract({ ...contract(), vercel }), ['vercel.json must contain a JSON object']);
  }
});

test('missing package manifest, file list, and workflows are each reported', () => {
  const errors = validateDeploymentContract({
    ...contract(),
    packageJson: [],
    files: undefined,
    outboxWorkflow: null,
    outboxWatchdogWorkflow: '   ',
    outboxWatchdogScript: undefined,
    productionSmokeWorkflow: 42,
  });
  assert.ok(errors.includes('package.json must contain a JSON object'));
  assert.ok(errors.includes('package.json engines.node must be 24.x'));
  assert.ok(errors.includes('required deployment file is missing: vercel.json'));
  assert.ok(errors.includes('outbox dispatch workflow must be readable'));
  assert.ok(errors.includes('outbox watchdog workflow must be readable'));
  assert.ok(errors.includes('production smoke workflow must be readable'));
  assert.ok(errors.includes('outbox watchdog assessor must match its reviewed immutable contract'));
  // Without a manifest there is no script table to compare, so no smoke script error.
  assert.equal(errors.some(error => error.startsWith('package.json must define smoke:production')), false);
  // Rewrites reference handlers that the (empty) file list no longer contains.
  assert.ok(errors.some(error => /targets missing handler api\//.test(error)));
});

test('mutable action tags in the outbox watchdog are rejected', () => {
  const input = contract();
  input.outboxWatchdogWorkflow = input.outboxWatchdogWorkflow.replace(
    /actions\/checkout@[0-9a-f]{40}/, 'actions/checkout@v4',
  );
  const errors = validateDeploymentContract(input);
  assert.ok(errors.includes('outbox watchdog actions must be pinned to immutable commits'));
  assert.ok(errors.includes('outbox watchdog workflow must match its reviewed immutable contract'));
});

test('rewrites must exist and each entry must be a string source/destination pair', () => {
  const missing = contract();
  delete missing.vercel.rewrites;
  delete missing.vercel.crons;
  assert.ok(validateDeploymentContract(missing).includes('vercel.json must define rewrites'));

  const empty = contract();
  empty.vercel.rewrites = [];
  assert.ok(validateDeploymentContract(empty).includes('vercel.json must define rewrites'));

  const malformed = contract();
  malformed.vercel.rewrites.unshift(null, { source: '/x', destination: 5 });
  const errors = validateDeploymentContract(malformed);
  assert.ok(errors.includes('rewrite 0 must define string source and destination values'));
  assert.ok(errors.includes('rewrite 1 must define string source and destination values'));
});

test('crons are validated even when rewrites are absent', () => {
  const input = contract();
  input.vercel.rewrites = 'not-an-array';
  const errors = validateDeploymentContract(input);
  assert.ok(errors.includes('vercel.json must define rewrites'));
  for (const cron of input.vercel.crons) {
    assert.ok(errors.includes(`cron path has no matching rewrite: ${cron.path}`));
  }
});

test('response header routes must be present and well formed', () => {
  const noHeaders = contract();
  noHeaders.vercel.headers = {};
  assert.ok(validateDeploymentContract(noHeaders).includes('vercel.json must define response headers'));

  const noApi = contract();
  noApi.vercel.headers = noApi.vercel.headers.filter(route => route.source !== '/api/(.*)');
  noApi.vercel.headers.push({ source: '/api/(.*)', headers: 'no-store' });
  assert.ok(validateDeploymentContract(noApi).includes('API routes must define response headers'));

  const weakApi = contract();
  const api = weakApi.vercel.headers.find(route => route.source === '/api/(.*)');
  api.headers = [null, { key: 'Cache-Control', value: 3 }, { key: 'Cache-Control', value: 'max-age=60' }];
  const errors = validateDeploymentContract(weakApi);
  assert.ok(errors.includes('API routes must set Cache-Control to no-store'));
  assert.ok(errors.includes('API routes must set X-Content-Type-Options to nosniff'));

  const noPage = contract();
  noPage.vercel.headers = noPage.vercel.headers.filter(route => route.source !== '/(.*)');
  const pageErrors = validateDeploymentContract(noPage);
  assert.ok(pageErrors.includes('page routes must define a safe content-security-policy'));
  assert.ok(pageErrors.includes('page routes must define a safe x-frame-options'));
});

test('cron entries need a unique path and a valid five-field schedule', () => {
  const input = contract();
  const path = input.vercel.crons[0].path;
  input.vercel.crons = [
    null,
    { schedule: '* * * * *' },
    { path, schedule: '*/5 * * * *' },
    { path, schedule: '*/5 * * * *' },
  ];
  const errors = validateDeploymentContract(input);
  assert.ok(errors.includes('cron 0 must define a path'));
  assert.ok(errors.includes('cron 1 must define a path'));
  assert.ok(errors.includes(`duplicate cron path: ${path}`));

  const invalidSchedules = [
    undefined, '* * * *', '*/0 * * * *', '*/x * * * *', '1/2/3 * * * *', '5-3 * * * *',
    '1-2-3 * * * *', '60 * * * *', 'a * * * *', '* * 0 * *', '* * * * 8',
  ];
  for (const schedule of invalidSchedules) {
    const candidate = contract();
    candidate.vercel.crons = [{ path, schedule }];
    assert.ok(
      validateDeploymentContract(candidate).includes(`cron ${path} must use a five-field schedule`),
      `schedule ${String(schedule)} should be rejected`,
    );
  }
  for (const schedule of ['0-30/10 1,2 1-31 * 0', '15 3 * 1-12 7']) {
    const candidate = contract();
    candidate.vercel.crons = [{ path, schedule }];
    assert.equal(
      validateDeploymentContract(candidate).includes(`cron ${path} must use a five-field schedule`),
      false,
      `schedule ${schedule} should be accepted`,
    );
  }
});

test('security header predicates fail closed on blank, unknown, and ambiguous values', () => {
  assert.equal(securityHeaderIsSafe('referrer-policy', '   '), false);
  assert.equal(securityHeaderIsSafe('x-powered-by', 'anything'), false);
  assert.equal(securityHeaderIsSafe('x-frame-options', 'deny'), true);
  assert.equal(securityHeaderIsSafe('permissions-policy', 'camera=(), geolocation=()'), true);
  assert.equal(securityHeaderIsSafe('permissions-policy', 'geolocation=(self)'), false);
  assert.equal(securityHeaderIsSafe('strict-transport-security', 'max-age=31536000=1; includeSubDomains'), false);
  assert.equal(securityHeaderIsSafe('strict-transport-security', 'max-age=31536000; includeSubDomains=1'), false);
  assert.equal(securityHeaderIsSafe('strict-transport-security', 'includeSubDomains'), false);
  assert.equal(securityHeaderIsSafe('strict-transport-security', 'max-age=60; includeSubDomains'), false);
  assert.equal(securityHeaderIsSafe('content-security-policy',
    "default-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri https:; form-action 'self'"), false);
  assert.equal(securityHeaderIsSafe('content-security-policy',
    "default-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'"), true);
  assert.equal(securityHeaderIsSafe('content-security-policy',
    "default-src 'self' https:; object-src 'none'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'"),
  false);
});

function scratch() {
  return mkdtempSync(join(tmpdir(), 'randori-cov-deploy-'));
}

test('repository inspection reports unreadable configuration without throwing', () => {
  const directory = scratch();
  try {
    assert.match(inspectDeploymentContract(directory)[0], /^vercel\.json is not readable JSON: /);

    writeFileSync(join(directory, 'vercel.json'), '{"cleanUrls":true}');
    writeFileSync(join(directory, 'package.json'), '{not json');
    assert.match(inspectDeploymentContract(directory)[0], /^package\.json is not readable JSON: /);

    writeFileSync(join(directory, 'package.json'), JSON.stringify({ engines: { node: '24.x' } }));
    mkdirSync(join(directory, 'api'));
    writeFileSync(join(directory, 'api', 'ops.js'), '');
    writeFileSync(join(directory, 'api', 'README.md'), '');
    const errors = inspectDeploymentContract(directory);
    assert.ok(errors.includes('outbox dispatch workflow must be readable'));
    assert.ok(errors.includes('outbox watchdog workflow must be readable'));
    assert.ok(errors.includes('production smoke workflow must be readable'));
    assert.ok(errors.includes('required deployment file is missing: index.html'));
    assert.equal(errors.includes('required deployment file is missing: vercel.json'), false);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('the CLI exits 1 with a JSON error document for a broken checkout and 0 for this repository', () => {
  const directory = scratch();
  try {
    const failed = spawnSync(process.execPath, [SCRIPT], { cwd: directory, encoding: 'utf8' });
    assert.equal(failed.status, 1);
    assert.equal(failed.stdout, '');
    const document = JSON.parse(failed.stderr);
    assert.equal(document.ok, false);
    assert.match(document.errors[0], /^vercel\.json is not readable JSON/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }

  const passed = spawnSync(process.execPath, [SCRIPT], { cwd: ROOT, encoding: 'utf8' });
  assert.equal(passed.status, 0, passed.stderr);
  assert.deepEqual(JSON.parse(passed.stdout), {
    ok: true, gate: 'repository-deployability-contract', providerNetworkRequired: false,
  });
});
