import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';

import {
  inspectDeploymentContract,
  validateDeploymentContract,
} from '../../scripts/check-deployability.mjs';

function currentContract() {
  return {
    vercel: JSON.parse(readFileSync('vercel.json', 'utf8')),
    packageJson: JSON.parse(readFileSync('package.json', 'utf8')),
    outboxWorkflow: readFileSync('.github/workflows/outbox-dispatch.yml', 'utf8'),
    outboxWatchdogWorkflow: readFileSync('.github/workflows/outbox-dispatch-watchdog.yml', 'utf8'),
    files: new Set([
      'index.html',
      'package-lock.json',
      'package.json',
      'vercel.json',
      '.github/workflows/outbox-dispatch.yml',
      '.github/workflows/outbox-dispatch-watchdog.yml',
      'scripts/github-outbox-dispatch-watchdog.mjs',
      ...readdirSync('api').filter(file => file.endsWith('.js')).map(file => `api/${file}`),
    ]),
  };
}

function cloneContract() {
  const contract = currentContract();
  return {
    ...contract,
    vercel: structuredClone(contract.vercel),
    packageJson: structuredClone(contract.packageJson),
    files: new Set(contract.files),
  };
}

test('current repository satisfies the provider-neutral deployment contract', () => {
  assert.deepEqual(inspectDeploymentContract(), []);
  assert.deepEqual(validateDeploymentContract(currentContract()), []);
});

test('missing route handlers and an early SPA fallback fail closed', () => {
  const contract = cloneContract();
  contract.files.delete('api/ops.js');
  contract.vercel.rewrites.unshift(contract.vercel.rewrites.pop());

  const errors = validateDeploymentContract(contract);
  assert.ok(errors.includes('rewrite /api/settings/availability targets missing handler api/ops.js'));
  assert.ok(errors.includes('the final rewrite must be the SPA fallback /(.*) -> /index.html'));
});

test('every non-fallback rewrite must target a local one-segment API handler', () => {
  for (const destination of ['/api/missing/nested', '/typo', 'https://attacker.example/api/ops']) {
    const contract = cloneContract();
    contract.vercel.rewrites[0].destination = destination;
    const errors = validateDeploymentContract(contract);
    assert.ok(errors.includes(
      `rewrite ${contract.vercel.rewrites[0].source} must target a local grouped API handler`,
    ));
  }
});

test('unsafe response headers and unwired cron paths are rejected', () => {
  const contract = cloneContract();
  contract.vercel.headers.find(route => route.source === '/api/(.*)').headers = [];
  contract.vercel.headers.find(route => route.source === '/(.*)').headers = [];
  contract.vercel.crons = [{ path: '/api/cron/missing', schedule: 'every Sunday' }];

  const errors = validateDeploymentContract(contract);
  assert.ok(errors.includes('API routes must set Cache-Control to no-store'));
  assert.ok(errors.includes('page routes must define a safe content-security-policy'));
  assert.ok(errors.includes('cron path has no matching rewrite: /api/cron/missing'));
  assert.ok(errors.includes('cron /api/cron/missing must use a five-field schedule'));
});

test('required files and unique routes are part of the contract', () => {
  const contract = cloneContract();
  contract.files.delete('package-lock.json');
  contract.vercel.rewrites.splice(1, 0, structuredClone(contract.vercel.rewrites[0]));

  const errors = validateDeploymentContract(contract);
  assert.ok(errors.includes('required deployment file is missing: package-lock.json'));
  assert.ok(errors.includes(`duplicate rewrite source: ${contract.vercel.rewrites[0].source}`));
});

test('the package runtime must match the Node 24 CI and deployment contract', () => {
  for (const nodeRange of ['>=22', '>=999', '>=24 || >=0', '24', '^24.0.0']) {
    const contract = cloneContract();
    contract.packageJson.engines.node = nodeRange;
    assert.ok(validateDeploymentContract(contract).includes('package.json engines.node must be 24.x'));
  }
});

test('security headers must retain their minimum-safe values, not merely their names', () => {
  const unsafeValues = new Map([
    ['Content-Security-Policy', "default-src *; object-src 'self'; frame-ancestors *; base-uri *"],
    ['Permissions-Policy', 'geolocation=(self)'],
    ['Referrer-Policy', 'unsafe-url'],
    ['Strict-Transport-Security', 'max-age=0'],
    ['X-Content-Type-Options', 'sniff'],
    ['X-Frame-Options', 'ALLOWALL'],
  ]);

  for (const [headerName, unsafeValue] of unsafeValues) {
    const contract = cloneContract();
    const header = contract.vercel.headers
      .find(route => route.source === '/(.*)').headers
      .find(item => item.key === headerName);
    header.value = unsafeValue;
    assert.ok(validateDeploymentContract(contract).includes(
      `page routes must define a safe ${headerName.toLowerCase()}`,
    ));
  }
});

test('duplicate CSP and HSTS directives fail closed instead of hiding unsafe first values', () => {
  const contract = cloneContract();
  const pageHeaders = contract.vercel.headers.find(route => route.source === '/(.*)').headers;
  const csp = pageHeaders.find(item => item.key === 'Content-Security-Policy');
  const hsts = pageHeaders.find(item => item.key === 'Strict-Transport-Security');
  csp.value = `default-src *; object-src *; frame-ancestors *; ${csp.value}`;
  hsts.value = `max-age=0; ${hsts.value}`;

  const errors = validateDeploymentContract(contract);
  assert.ok(errors.includes('page routes must define a safe content-security-policy'));
  assert.ok(errors.includes('page routes must define a safe strict-transport-security'));
});

test('the gate remains green when preview quota is simulated as exhausted', () => {
  const result = spawnSync(process.execPath, ['scripts/check-deployability.mjs'], {
    encoding: 'utf8',
    env: {
      ...process.env,
      HTTPS_PROXY: 'http://127.0.0.1:9',
      VERCEL_PREVIEW_QUOTA_STATE: 'exhausted',
      VERCEL_TOKEN: 'deliberately-unusable',
    },
  });

  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.deepEqual(JSON.parse(result.stdout), {
    ok: true,
    gate: 'repository-deployability-contract',
    providerNetworkRequired: false,
  });
});

test('the GitHub gate has read-only permissions and no deployment-provider dependency', () => {
  const workflow = readFileSync('.github/workflows/deployability.yml', 'utf8');
  assert.match(workflow, /^name: deployability$/m);
  assert.match(workflow, /^\s{2}deployability:$/m);
  assert.match(workflow, /^\s{2}contents: read$/m);
  assert.match(workflow, /npm run check:deployability/);
  assert.match(workflow, /npm run test:deployability/);
  assert.doesNotMatch(
    workflow,
    /pull_request_target|secrets\.|npx\s+vercel|\bvercel\s+(build|deploy|pull)|VERCEL_TOKEN/,
  );
  assert.doesNotMatch(workflow, /uses:\s+actions\/(?:checkout|setup-node)@v\d+/);
});

test('the outbox scheduler is five-minute, manually recoverable, secret-bound, and deadline-capped',()=>{
  const contract=currentContract();
  assert.deepEqual(validateDeploymentContract(contract),[]);
  assert.match(contract.outboxWorkflow,/cron:\s*['"]\*\/5 \* \* \* \*['"]/);
  assert.match(contract.outboxWorkflow,/workflow_dispatch:/);
  assert.match(contract.outboxWorkflow,
    /if:\s*github\.ref == format\('refs\/heads\/\{0\}', github\.event\.repository\.default_branch\)/);
  assert.match(contract.outboxWorkflow,/environment:\s*production/);
  assert.match(contract.outboxWorkflow,/vars\.APP_URL/);
  assert.match(contract.outboxWorkflow,/secrets\.CRON_SECRET/);
  assert.match(contract.outboxWorkflow,/--max-time 55 --retry 0 --request POST/);
});

test('deployability rejects an unsafe or incomplete outbox scheduler',()=>{
  const missingSecret=cloneContract();
  missingSecret.outboxWorkflow=missingSecret.outboxWorkflow.replace(
    'CRON_SECRET: ${{ secrets.CRON_SECRET }}','CRON_SECRET: hard-coded-secret',
  );
  assert.ok(validateDeploymentContract(missingSecret).includes(
    'outbox workflow must read CRON_SECRET from GitHub secrets',
  ));

  const pullRequest=cloneContract();
  pullRequest.outboxWorkflow=pullRequest.outboxWorkflow.replace(
    'workflow_dispatch:','workflow_dispatch:\n  pull_request:',
  );
  assert.ok(validateDeploymentContract(pullRequest).includes(
    'outbox workflow must not expose production secrets to pull-request code or logs',
  ));

  const unbounded=cloneContract();
  unbounded.outboxWorkflow=unbounded.outboxWorkflow.replace('--max-time 55 --retry 0','--retry 3');
  assert.ok(validateDeploymentContract(unbounded).includes(
    'outbox workflow must bound the request without automatic duplicate retries',
  ));

  const featureBranch=cloneContract();
  featureBranch.outboxWorkflow=featureBranch.outboxWorkflow.replace(
    "if: github.ref == format('refs/heads/{0}', github.event.repository.default_branch)\n",'',
  );
  assert.ok(validateDeploymentContract(featureBranch).includes(
    'outbox workflow must restrict production dispatch to the default branch',
  ));

  const workerDeadline=cloneContract();
  workerDeadline.outboxWorkflow=workerDeadline.outboxWorkflow.replace(
    'timeout-minutes: 2','timeout-minutes: 3',
  );
  assert.ok(validateDeploymentContract(workerDeadline).includes(
    'outbox workflow must retain its two-minute worker deadline',
  ));
});

test('the outbox watchdog is hourly, bounded, read-only, and secret-free',()=>{
  const contract=currentContract();
  assert.deepEqual(validateDeploymentContract(contract),[]);
  assert.match(contract.outboxWatchdogWorkflow,/cron:\s*['"]37 \* \* \* \*['"]/);
  assert.match(contract.outboxWatchdogWorkflow,/actions:\s*read/);
  assert.match(contract.outboxWatchdogWorkflow,/contents:\s*read/);
  assert.match(contract.outboxWatchdogWorkflow,/WATCHDOG_WORKER_DEADLINE_MS:\s*'120000'/);
  assert.match(contract.outboxWatchdogWorkflow,/scripts\/github-outbox-dispatch-watchdog\.mjs/);
  assert.doesNotMatch(contract.outboxWatchdogWorkflow,
    /environment:|secrets\.|vars\.|APP_URL|CRON_SECRET|\/api\/cron\/outbox|pull_request_target/);
});

test('deployability rejects a weakened or privileged outbox watchdog',()=>{
  const missing=cloneContract();
  missing.files.delete('.github/workflows/outbox-dispatch-watchdog.yml');
  missing.outboxWatchdogWorkflow=null;
  let errors=validateDeploymentContract(missing);
  assert.ok(errors.includes(
    'required deployment file is missing: .github/workflows/outbox-dispatch-watchdog.yml'));
  assert.ok(errors.includes('outbox watchdog workflow must be readable'));

  const delayed=cloneContract();
  delayed.outboxWatchdogWorkflow=delayed.outboxWatchdogWorkflow.replace(
    "WATCHDOG_WORKER_DEADLINE_MS: '120000'","WATCHDOG_WORKER_DEADLINE_MS: '900000'",
  );
  errors=validateDeploymentContract(delayed);
  assert.ok(errors.includes('outbox watchdog must bind the two-minute dispatcher deadline'));

  const privileged=cloneContract();
  privileged.outboxWatchdogWorkflow=privileged.outboxWatchdogWorkflow.replace(
    'contents: read','contents: write\n  environment: production\n  CRON_SECRET: ${{ secrets.CRON_SECRET }}',
  );
  errors=validateDeploymentContract(privileged);
  assert.ok(errors.includes('outbox watchdog must remain secret-free, read-only, and non-mutating'));
  assert.ok(errors.includes('outbox watchdog must have read-only contents access'));

  const mutableAction=cloneContract();
  mutableAction.outboxWatchdogWorkflow=mutableAction.outboxWatchdogWorkflow.replace(
    'actions/checkout@11d5960a326750d5838078e36cf38b85af677262','actions/checkout@main',
  ).replace('persist-credentials: false','persist-credentials: true');
  errors=validateDeploymentContract(mutableAction);
  assert.ok(errors.includes('outbox watchdog checkout must use the reviewed immutable revision'));
  assert.ok(errors.includes('outbox watchdog checkout must not persist GitHub credentials'));

  const cadence=cloneContract();
  cadence.outboxWatchdogWorkflow=cadence.outboxWatchdogWorkflow.replace(
    "cron: '37 * * * *'","cron: '*/5 * * * *'",
  );
  assert.ok(validateDeploymentContract(cadence).includes(
    'outbox watchdog must run hourly on its documented offset',
  ));
});
