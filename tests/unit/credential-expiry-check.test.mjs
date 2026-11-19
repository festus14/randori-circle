import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { parseDocument } from 'yaml';
import { checkCredentialExpiry, inspectTokenExpiry } from '../../scripts/credential-expiry-check.mjs';

const NOW = Date.parse('2026-11-19T10:00:00Z') / 1000;
const DAY = 86_400;
const LEDGER = 'DELETION_LEDGER_AUTH_TOKEN';
const WATCH = 'TURSO_AUTH_TOKEN_EXPIRY_WATCH';
const script = new URL('../../scripts/credential-expiry-check.mjs', import.meta.url);
const encode = value => Buffer.from(value).toString('base64url');
const jwt = claims => `${encode('{"alg":"fixture-only","kid":"private-header-marker"}')}.${encode(JSON.stringify(claims))}.${encode('private-synthetic-signature-marker')}`;
const expToken = days => jwt({ exp: NOW + days * DAY, private: 'private-payload-marker' });

function check(env, now = NOW) {
  const lines = [];
  const exitCode = checkCredentialExpiry(env, now, line => lines.push(line));
  return { exitCode, lines, output: lines.join('\n') };
}

function assertRedacted(output, tokens) {
  for (const token of tokens) {
    assert.equal(output.includes(token), false, 'must not emit a raw token');
    for (const segment of token.split('.').filter(part => part.length > 8)) {
      assert.equal(output.includes(segment), false, 'must not emit an encoded token segment');
    }
  }
  for (const marker of ['private-header-marker', 'private-payload-marker', 'private-synthetic-signature-marker']) {
    assert.equal(output.includes(marker), false, 'must not emit decoded claims or signature material');
  }
}

test('valid exp yields only status and days, with exact inclusive 30/45-day bounds', () => {
  for (const [days, status, remaining] of [
    [365, 'ok', 365], [46, 'ok', 46], [45 + 1 / DAY, 'ok', 45],
    [45, 'warning', 45], [31, 'warning', 31], [30 + 1 / DAY, 'warning', 30],
    [30, 'error', 30], [29, 'error', 29], [0.5, 'error', 0],
    [0, 'error', 0], [-1 / DAY, 'error', -1], [-25 / 24, 'error', -2],
  ]) {
    assert.deepEqual(inspectTokenExpiry(expToken(days), NOW), { status, daysRemaining: remaining });
  }
  assert.deepEqual(inspectTokenExpiry(jwt({ exp: NOW + 46 * DAY + 0.5 }), NOW), { status: 'ok', daysRemaining: 46 });
});

test('a genuine absence of exp passes with a notice for never-expiring tokens', () => {
  const token = jwt({ private: 'private-payload-marker' });
  assert.deepEqual(inspectTokenExpiry(token, NOW), { status: 'no-exp' });
  assert.deepEqual(inspectTokenExpiry(jwt({}), NOW), { status: 'no-exp' });
  const result = check({ [LEDGER]: token, [WATCH]: expToken(365) });
  assert.equal(result.exitCode, 0);
  assert.match(result.output, /::notice.*DELETION_LEDGER_AUTH_TOKEN: days remaining unbounded \(no exp claim/u);
  assertRedacted(result.output, [token]);
});

test('malformed envelope, encoding, JSON, payload and exp fail without parser details', () => {
  const payload = text => `fixtureHeader.${encode(text)}.fixtureSignature`;
  const tokens = [
    undefined, null, 123, '', 'not-a-jwt-private-marker', 'a.b', 'a.b.c.d',
    '.e30.signature', 'header..signature', 'header.e30.', 'header.!!!!.signature',
    'header.e30=.signature', 'header.e31.signature', 'header.a.signature',
    `header.${Buffer.from([0xff]).toString('base64url')}.signature`,
    payload('{"private":"private-payload-marker",'), payload('null'), payload('[]'),
    payload('"private-payload-marker"'), payload('123'), payload('{"exp":1e400}'),
    payload('{"exp":9007199254740992}'), payload('{"exp":-9007199254740992}'),
    ...[null, '9999999999', true, {}, []].map(exp => jwt({ exp })),
    `${'a'.repeat(65_536)}.e30.signature`,
    'private-malformed-marker\n::error title=injected::private-payload-marker',
  ];
  for (const token of tokens) {
    assert.deepEqual(inspectTokenExpiry(token, NOW), { status: 'malformed' });
    if (typeof token !== 'string' || token === '') continue;
    const result = check({ [LEDGER]: token, [WATCH]: expToken(365) });
    assert.equal(result.exitCode, 1);
    assert.match(result.output, /::error.*malformed JWT or exp/u);
    assertRedacted(result.output, [token]);
    assert.equal(result.lines.length, 2, 'no injected annotation or exception output');
  }
  assert.deepEqual(inspectTokenExpiry(expToken(365), NaN), { status: 'malformed' });
  assert.deepEqual(inspectTokenExpiry(expToken(365), Infinity), { status: 'malformed' });
});

test('healthy, warning, deadline and expired credentials have the correct annotation and exit code', () => {
  for (const [days, annotation, exitCode] of [[365, null, 0], [45, 'warning', 0], [31, 'warning', 0], [30, 'error', 1], [0, 'error', 1], [-1, 'error', 1]]) {
    const token = expToken(days);
    const result = check({ [LEDGER]: token, [WATCH]: token });
    assert.equal(result.exitCode, exitCode);
    assert.equal(result.lines.length, 2);
    for (const [index, name] of [LEDGER, WATCH].entries()) {
      const prefix = annotation ? `::${annotation} title=Credential expiry::` : '';
      assert.ok(result.lines[index].startsWith(`${prefix}${name}: ${days} days remaining`));
    }
    assertRedacted(result.output, [token]);
  }
});

test('missing optional watch is skipped, but missing required ledger fails closed', () => {
  for (const missing of [undefined, '']) {
    const optional = check({ [LEDGER]: expToken(365), [WATCH]: missing });
    assert.equal(optional.exitCode, 0);
    assert.match(optional.output, /::notice.*TURSO_AUTH_TOKEN_EXPIRY_WATCH: days remaining unknown \(missing secret; skipped\)/u);
    const required = check({ [LEDGER]: missing, [WATCH]: expToken(365) });
    assert.equal(required.exitCode, 1);
    assert.match(required.output, /::error.*DELETION_LEDGER_AUTH_TOKEN: days remaining unknown \(missing secret; required\)/u);
  }
  assert.equal(check({}).exitCode, 1);
  assert.equal(check({ [LEDGER]: expToken(365), [WATCH]: ' ' }).exitCode, 1, 'nonempty malformed optional values are not skipped');
});

test('one failed credential does not hide the other result, and unrelated secrets are ignored', () => {
  const result = check({ [LEDGER]: expToken(29), [WATCH]: expToken(45), TURSO_AUTH_TOKEN: 'unrelated-private-marker' });
  assert.equal(result.exitCode, 1);
  assert.match(result.lines[0], /^::error/u);
  assert.match(result.lines[1], /^::warning/u);
  assert.equal(result.output.includes('unrelated-private-marker'), false);
});

test('CLI is offline, redacts stdout/stderr and does not write Actions output, summaries or artifacts', () => {
  const directory = mkdtempSync(join(tmpdir(), 'credential-expiry-test-'));
  try {
    const outputPath = join(directory, 'output');
    const summaryPath = join(directory, 'summary');
    writeFileSync(outputPath, 'unchanged-output');
    writeFileSync(summaryPath, 'unchanged-summary');
    for (const [ledger, watch, expected] of [
      [expToken(365), expToken(365), 0], [expToken(45), expToken(31), 0],
      [expToken(30), expToken(-1), 1], ['private-invalid-jwt-marker', expToken(365), 1],
      [jwt({ private: 'private-payload-marker' }), '', 0], ['', '', 1],
    ]) {
      const result = spawnSync(process.execPath, ['--permission', '--allow-fs-read=*', script.pathname], {
        cwd: directory,
        env: { [LEDGER]: ledger, [WATCH]: watch, GITHUB_OUTPUT: outputPath, GITHUB_STEP_SUMMARY: summaryPath, RUNNER_TEMP: directory },
        encoding: 'utf8', timeout: 10_000,
      });
      assert.equal(result.error, undefined);
      assert.equal(result.status, expected, result.stderr);
      assert.equal(result.stderr, '', 'no raw parser exception, warning or stack trace');
      assertRedacted(result.stdout + result.stderr, [ledger, watch].filter(Boolean));
      assert.equal(result.stdout.trim().split('\n').length, 2);
      assert.equal(readFileSync(outputPath, 'utf8'), 'unchanged-output');
      assert.equal(readFileSync(summaryPath, 'utf8'), 'unchanged-summary');
      assert.deepEqual(readdirSync(directory).sort(), ['output', 'summary']);
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('workflow keeps credentials in one offline step on main, with pinned actions and minimal authority', () => {
  const source = readFileSync(new URL('../../.github/workflows/credential-expiry.yml', import.meta.url), 'utf8');
  const document = parseDocument(source, { uniqueKeys: true });
  assert.deepEqual(document.errors, []);
  const workflow = document.toJS();
  assert.deepEqual(Object.keys(workflow.on).sort(), ['schedule', 'workflow_dispatch']);
  assert.deepEqual(workflow.on.schedule, [{ cron: '43 6 * * *' }]);
  assert.deepEqual(workflow.permissions, {});
  assert.deepEqual(workflow.concurrency, { group: 'credential-expiry', 'cancel-in-progress': false });
  assert.deepEqual(Object.keys(workflow.jobs), ['credential-expiry']);
  const job = workflow.jobs['credential-expiry'];
  assert.equal(job.if, "github.repository == 'festus14/randori-circle' && github.ref == 'refs/heads/main'");
  assert.equal(job['runs-on'], 'ubuntu-24.04');
  assert.equal(job['timeout-minutes'], 5);
  assert.deepEqual(job.permissions, { contents: 'read' });
  assert.equal(job.outputs, undefined);
  assert.equal(job.environment, undefined, 'repository secrets, no approval-gated daily environment');
  assert.equal(job.steps.length, 3, 'no dependency install, API call or artifact upload');
  assert.deepEqual(job.steps[0], {
    uses: 'actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1', with: { 'persist-credentials': false },
  });
  assert.deepEqual(job.steps[1], { uses: 'actions/setup-node@820762786026740c76f36085b0efc47a31fe5020', with: { 'node-version': '24' } });
  const step = job.steps[2];
  assert.deepEqual(step.env, {
    [LEDGER]: '${{ secrets.DELETION_LEDGER_AUTH_TOKEN }}', [WATCH]: '${{ secrets.TURSO_AUTH_TOKEN_EXPIRY_WATCH }}',
  });
  assert.equal(step.run, 'node scripts/credential-expiry-check.mjs');
  assert.equal(step['timeout-minutes'], 1);
  assert.equal(workflow.env, undefined);
  assert.equal(job.env, undefined);
  assert.equal(step['continue-on-error'], undefined);
  assert.equal(job['continue-on-error'], undefined);
  const checker = readFileSync(script, 'utf8');
  assert.doesNotMatch(checker, /\b(?:import|fetch|https|http|writeFile|appendFile|exec|spawn)\s*(?:\(|\{|['"])/u, 'no I/O implementation or third-party imports');
});
