import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';

import { CANONICAL_DOMAIN_REDIRECTS } from './canonical-domain.mjs';

import { PUBLIC_PAGE_FILES } from './public-pages.mjs';

const OUTBOX_WORKFLOW_PATH='.github/workflows/outbox-dispatch.yml';
const OUTBOX_WATCHDOG_WORKFLOW_PATH='.github/workflows/outbox-dispatch-watchdog.yml';
const OUTBOX_WATCHDOG_SCRIPT_PATH='scripts/github-outbox-dispatch-watchdog.mjs';
const PRODUCTION_SMOKE_WORKFLOW_PATH='.github/workflows/production-smoke.yml';
const PRODUCTION_SMOKE_SCRIPT_PATH='scripts/production-smoke.mjs';
const EXECUTION_SMOKE_WORKFLOW_PATH='.github/workflows/execution-smoke.yml';
const EXECUTION_SMOKE_SCRIPT_PATH='scripts/github-execution-smoke.mjs';
// With `cleanUrls`, Vercel serves index.html at `/` and 308-redirects
// `/index.html`, so a rewrite to `/index.html` resolves to nothing and every
// client route (/invite, /verify, /reset-password, /join/...) returns 404.
const SPA_FALLBACK_DESTINATION='/';
const OUTBOX_WATCHDOG_WORKFLOW_SHA256='3808af3df03c84a1370b7df74bc6c785d349a20796ccb1cf236f5166103f3651';
const OUTBOX_WATCHDOG_SCRIPT_SHA256='0c854c7892197b6f353fd32a96b5c7b70a6431e6b9ea86a07d2ad59fe0177b34';
const EXECUTION_SMOKE_WORKFLOW_SHA256='5164dcbbdd3d65099cde7ebef84af5464156e0753858e5ff8afaec863cd8a7e9';
const EXECUTION_SMOKE_SCRIPT_SHA256='eacde79646d11355d0ab717b4f633c128b318537b4dc1ea16489a869e9d4d7ef';
const REQUIRED_ROOT_FILES = [
  'index.html', 'package-lock.json', 'package.json', 'vercel.json', OUTBOX_WORKFLOW_PATH,
  OUTBOX_WATCHDOG_WORKFLOW_PATH, OUTBOX_WATCHDOG_SCRIPT_PATH, PRODUCTION_SMOKE_WORKFLOW_PATH,
  PRODUCTION_SMOKE_SCRIPT_PATH, EXECUTION_SMOKE_WORKFLOW_PATH, EXECUTION_SMOKE_SCRIPT_PATH,
  // The public privacy policy and terms (ID-79). Google's OAuth branding page
  // links to them, so a deploy without them would break Google sign-in review.
  ...PUBLIC_PAGE_FILES,
];
export const REQUIRED_SECURITY_HEADERS = [
  'content-security-policy',
  'permissions-policy',
  'referrer-policy',
  'strict-transport-security',
  'x-content-type-options',
  'x-frame-options',
];
const SUPPORTED_NODE_RANGE = '24.x';

function record(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
}

function sha256(value){
  return typeof value==='string'?createHash('sha256').update(value,'utf8').digest('hex'):null;
}

function routeHeaders(headers, source) {
  const route = headers.find(item => record(item)?.source === source);
  if (!route || !Array.isArray(route.headers)) return null;

  const values = new Map();
  for (const header of route.headers) {
    if (!record(header) || typeof header.key !== 'string' || typeof header.value !== 'string') continue;
    values.set(header.key.toLowerCase(), header.value);
  }
  return values;
}

function contentSecurityPolicyIsSafe(value) {
  const entries = value.split(';').map(part => {
    const [name, ...tokens] = part.trim().split(/\s+/);
    return [name?.toLowerCase(), tokens];
  }).filter(([name]) => name);
  const directives = new Map();
  for (const [name, tokens] of entries) {
    if (directives.has(name)) return false;
    directives.set(name, tokens);
  }
  const hasOnly = (name, token) => {
    const values = directives.get(name);
    return values?.length === 1 && values[0].toLowerCase() === token;
  };
  return hasOnly('default-src', "'self'")
    && hasOnly('object-src', "'none'")
    && hasOnly('frame-ancestors', "'none'")
    && ["'self'", "'none'"].includes(directives.get('base-uri')?.join(' ').toLowerCase())
    && directives.get('form-action')?.includes("'self'");
}

function strictTransportSecurityIsSafe(value) {
  const directives = new Map();
  for (const item of value.split(';')) {
    const [rawName, ...rest] = item.trim().toLowerCase().split('=');
    if (!rawName || directives.has(rawName) || rest.length > 1) return false;
    directives.set(rawName, rest[0] ?? null);
  }
  const maxAge = directives.get('max-age');
  return /^\d+$/.test(maxAge ?? '')
    && Number(maxAge) >= 31_536_000
    && directives.has('includesubdomains')
    && directives.get('includesubdomains') === null;
}

export function securityHeaderIsSafe(key, value) {
  const normalized = value.trim();
  if (!normalized) return false;
  switch (key) {
    case 'content-security-policy':
      return contentSecurityPolicyIsSafe(normalized);
    case 'permissions-policy':
      return /(?:^|,)\s*geolocation=\(\)\s*(?:,|$)/i.test(normalized);
    case 'referrer-policy':
      return normalized.toLowerCase() === 'no-referrer';
    case 'strict-transport-security':
      return strictTransportSecurityIsSafe(normalized);
    case 'x-content-type-options':
      return normalized.toLowerCase() === 'nosniff';
    case 'x-frame-options':
      return normalized.toUpperCase() === 'DENY';
    default:
      return false;
  }
}

function cronFieldLooksValid(field, minimum, maximum) {
  return field.split(',').every(part => {
    const [base, step, ...extra] = part.split('/');
    if (extra.length > 0 || (step !== undefined && (!/^\d+$/.test(step) || Number(step) < 1))) return false;
    if (base === '*') return true;

    const bounds = base.split('-');
    if (bounds.length > 2 || bounds.some(value => !/^\d+$/.test(value))) return false;
    const numbers = bounds.map(Number);
    if (numbers.some(value => value < minimum || value > maximum)) return false;
    return numbers.length === 1 || numbers[0] <= numbers[1];
  });
}

function cronExpressionLooksValid(schedule) {
  if (typeof schedule !== 'string') return false;
  const fields = schedule.trim().split(/\s+/);
  const ranges = [[0, 59], [0, 23], [1, 31], [1, 12], [0, 7]];
  return fields.length === 5
    && fields.every((field, index) => cronFieldLooksValid(field, ...ranges[index]));
}

function requiredHandler(destination) {
  if (typeof destination !== 'string') return null;
  const match = destination.match(
    /^\/api\/([a-zA-Z0-9_-]+)(?:\?[a-zA-Z0-9._~!$&'()*+,;=:@%/?-]+)?$/,
  );
  return match ? `api/${match[1]}.js` : null;
}

function validateOutboxWorkflow(workflow){
  if(typeof workflow!=='string'||!workflow.trim()){
    return ['outbox dispatch workflow must be readable'];
  }
  const errors=[];
  const checks=[
    [/^name:\s*outbox-dispatch\s*$/m,'outbox workflow must have the stable outbox-dispatch name'],
    [/^\s{2}schedule:\s*$/m,'outbox workflow must define a scheduled trigger'],
    [/^\s{4}- cron:\s*['"]\*\/5 \* \* \* \*['"]\s*$/m,
      'outbox workflow must run on the five-minute MVP cadence'],
    [/^\s{2}workflow_dispatch:\s*$/m,'outbox workflow must support manual recovery runs'],
    [/^\s{2}contents:\s*read\s*$/m,'outbox workflow permissions must be read-only'],
    [/^\s{4}timeout-minutes:\s*2\s*$/m,
      'outbox workflow must retain its two-minute worker deadline'],
    [/^\s{4}if:\s*github\.ref == format\('refs\/heads\/\{0\}', github\.event\.repository\.default_branch\)\s*$/m,
      'outbox workflow must restrict production dispatch to the default branch'],
    [/^\s{4}environment:\s*production\s*$/m,
      'outbox workflow must use the protected production environment'],
    [/APP_URL:\s*\$\{\{\s*vars\.APP_URL\s*\}\}/,
      'outbox workflow must read APP_URL from GitHub configuration'],
    [/CRON_SECRET:\s*\$\{\{\s*secrets\.CRON_SECRET\s*\}\}/,
      'outbox workflow must read CRON_SECRET from GitHub secrets'],
    [/if \[\[ -z "\$\{APP_URL\}" \|\| -z "\$\{CRON_SECRET\}" \]\]/,
      'outbox workflow must fail visibly when scheduler configuration is absent'],
    [/--max-time 55\s+--retry 0\s+--request POST/,
      'outbox workflow must bound the request without automatic duplicate retries'],
    [/--header "x-cron-secret: \$\{CRON_SECRET\}"/,
      'outbox workflow must authenticate with the dedicated cron secret'],
    [/"\$\{APP_URL%\/\}\/api\/cron\/outbox"/,
      'outbox workflow must call the production outbox route'],
  ];
  for(const [pattern,message] of checks){ if(!pattern.test(workflow)) errors.push(message); }
  if(/pull_request_target|pull_request:|\becho\b[^\n]*(?:CRON_SECRET|\$\{\{\s*secrets\.)/u.test(workflow)){
    errors.push('outbox workflow must not expose production secrets to pull-request code or logs');
  }
  return errors;
}

function validateOutboxWatchdogWorkflow(workflow){
  if(typeof workflow!=='string'||!workflow.trim()){
    return ['outbox watchdog workflow must be readable'];
  }
  const errors=[];
  const checks=[
    [/^name:\s*outbox-dispatch-watchdog\s*$/m,
      'outbox watchdog must have its stable workflow name'],
    [/^\s{2}schedule:\s*$/m,'outbox watchdog must define a scheduled trigger'],
    [/^\s{4}- cron:\s*['"]37 \* \* \* \*['"]\s*$/m,
      'outbox watchdog must run hourly on its documented offset'],
    [/^\s{2}workflow_dispatch:\s*$/m,'outbox watchdog must support manual diagnosis'],
    [/^\s{2}actions:\s*read\s*$/m,'outbox watchdog must have read-only Actions access'],
    [/^\s{2}contents:\s*read\s*$/m,'outbox watchdog must have read-only contents access'],
    [/^permissions:\n  actions: read\n  contents: read\n\nconcurrency:/m,
      'outbox watchdog must grant only read access to Actions and contents'],
    [/^\s{4}if:\s*github\.ref == format\('refs\/heads\/\{0\}', github\.event\.repository\.default_branch\)\s*$/m,
      'outbox watchdog must inspect only from the default branch'],
    [/^\s{4}timeout-minutes:\s*5\s*$/m,'outbox watchdog job must be time bounded'],
    [/GITHUB_TOKEN:\s*\$\{\{\s*github\.token\s*\}\}/,
      'outbox watchdog must use only the scoped GitHub token'],
    [/WATCHDOG_DEFAULT_BRANCH:\s*\$\{\{\s*github\.event\.repository\.default_branch\s*\}\}/,
      'outbox watchdog must bind the repository default branch'],
    [/WATCHDOG_SCHEDULE_GRACE_MS:\s*['"]900000['"]/,
      'outbox watchdog must retain its fifteen-minute schedule grace'],
    [/WATCHDOG_WORKER_DEADLINE_MS:\s*['"]120000['"]/,
      'outbox watchdog must bind the two-minute dispatcher deadline'],
    [/WATCHDOG_API_TIMEOUT_MS:\s*['"]10000['"]/,
      'outbox watchdog API request must remain time bounded'],
    [/WATCHDOG_MAX_PAGES:\s*['"]2['"]/,
      'outbox watchdog pagination must remain bounded'],
    [/WATCHDOG_PER_PAGE:\s*['"]100['"]/,
      'outbox watchdog page size must remain bounded'],
    [/^\s{8}run:\s*node scripts\/github-outbox-dispatch-watchdog\.mjs\s*$/m,
      'outbox watchdog must run the reviewed assessor'],
    [/^\s{4}environment:\s*production\s*$/m,
      'outbox watchdog must read delivery health through the protected production environment'],
    [/      - name: Assess outbox delivery health\n        timeout-minutes: 2\n        env:\n          APP_URL: \$\{\{ vars\.APP_URL \}\}\n          CRON_SECRET: \$\{\{ secrets\.CRON_SECRET \}\}\n          WATCHDOG_DELIVERY_MAX_AGE_MS: '900000'\n          GITHUB_TOKEN: \$\{\{ github\.token \}\}\n          WATCHDOG_DEFAULT_BRANCH: \$\{\{ github\.event\.repository\.default_branch \}\}\n          WATCHDOG_SCHEDULE_GRACE_MS: '900000'\n          WATCHDOG_WORKER_DEADLINE_MS: '120000'\n          WATCHDOG_API_TIMEOUT_MS: '10000'\n          WATCHDOG_MAX_PAGES: '2'\n          WATCHDOG_PER_PAGE: '100'\n        run: node scripts\/github-outbox-dispatch-watchdog\.mjs(?:\n|$)/,
      'outbox watchdog assessment step must retain its exact fail-closed shape'],
    [/uses:\s+actions\/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1/,
      'outbox watchdog checkout must use the reviewed immutable revision'],
    [/uses:\s+actions\/setup-node@820762786026740c76f36085b0efc47a31fe5020/,
      'outbox watchdog Node setup must use the reviewed immutable revision'],
    [/persist-credentials:\s*false/,
      'outbox watchdog checkout must not persist GitHub credentials'],
  ];
  for(const [pattern,message] of checks){ if(!pattern.test(workflow)) errors.push(message); }
  // The only production material the watchdog may see is APP_URL and the
  // CRON_SECRET it needs to read aggregate delivery health.
  const reviewedProductionAccess=workflow
    .replace(/^ {4}environment: production\n/mu,'')
    .replace(/^ {10}APP_URL: \$\{\{ vars\.APP_URL \}\}\n {10}CRON_SECRET: \$\{\{ secrets\.CRON_SECRET \}\}\n/mu,'');
  if(/pull_request(?:_target)?:|permissions:[\s\S]*?\bwrite\b|environment:|secrets\.|vars\.|APP_URL|CRON_SECRET|TURSO_|RESEND_|\/api\/cron\/outbox|\bcurl\b|\bgh\s+workflow\b|\/dispatches\b|continue-on-error:|^\s{8}if:/mu.test(reviewedProductionAccess)){
    errors.push('outbox watchdog must remain read-only, non-mutating, and limited to its reviewed health credential');
  }
  if(/uses:\s+actions\/(?:checkout|setup-node)@v\d+/u.test(workflow)){
    errors.push('outbox watchdog actions must be pinned to immutable commits');
  }
  return errors;
}

function validateProductionSmokeWorkflow(workflow){
  if(typeof workflow!=='string'||!workflow.trim()){
    return ['production smoke workflow must be readable'];
  }
  const errors=[];
  const checks=[
    [/^name:\s*production-smoke\s*$/m,'production smoke workflow must have the stable production-smoke name'],
    [/^\s{2}deployment_status:\s*$/m,'production smoke must run after Vercel deployment status events'],
    [/github\.event\.deployment_status\.state == 'success'/,
      'production smoke must run only for successful deployments'],
    [/github\.event\.deployment\.environment == 'Production'/,
      'production smoke must run only for the Vercel Production environment'],
    [/github\.event\.deployment\.environment == 'Production' &&\n\s+github\.event\.deployment\.creator\.login == 'vercel\[bot\]'\)/,
      'production smoke must ignore deployments that GitHub environment jobs create'],
    [/^\s{2}schedule:\s*$/m,'production smoke must define a scheduled trigger'],
    [/^\s{2}workflow_dispatch:\s*$/m,'production smoke must support manual runs'],
    [/^permissions:\n  contents: read\n\n/m,'production smoke permissions must be contents: read only'],
    [/^\s{4}runs-on:\s*ubuntu-24\.04\s*$/m,'production smoke must run on the pinned ubuntu-24.04 image'],
    [/^\s{4}timeout-minutes:\s*\d+\s*$/m,'production smoke job must be time bounded'],
    [/persist-credentials:\s*false/,'production smoke checkout must not persist GitHub credentials'],
    [/npm run smoke:production/,'production smoke must run the reviewed read-only smoke script'],
  ];
  for(const [pattern,message] of checks){ if(!pattern.test(workflow)) errors.push(message); }
  if(/pull_request(?:_target)?:|:\s*write\b|write-all|^\s*environment:|secrets\.|vars\.|CRON_SECRET|VERCEL_TOKEN|TURSO_|RESEND_|continue-on-error:/mu
    .test(workflow)){
    errors.push('production smoke must remain secret-free, read-only, and non-mutating');
  }
  return errors;
}

// ID-80: www and the old Vercel alias redirect to the canonical origin. The
// whole redirects array must stay exactly as reviewed: host-conditional
// (previews never match), www permanent, the old alias temporary and never for
// /api/*, and no other rule (host-less or otherwise) beside them.
export function validateCanonicalDomainRedirects(redirects) {
  if (!Array.isArray(redirects)) return ['vercel.json must define the canonical-domain redirects'];
  return isDeepStrictEqual(redirects, CANONICAL_DOMAIN_REDIRECTS) ? []
    : [`vercel.json redirects must be exactly the reviewed canonical-domain redirects: ${JSON.stringify(CANONICAL_DOMAIN_REDIRECTS)}`];
}

// Issue #249. The execution smoke spends Vercel Sandbox quota through a
// CRON_SECRET route, so its only production material is vars.APP_URL and
// secrets.CRON_SECRET in the production environment, it never runs for pull
// requests, and deployment_status runs are limited to Vercel's own successful
// Production deployments (GitHub's environment deployments would otherwise
// re-trigger it).
function validateExecutionSmokeWorkflow(workflow){
  if(typeof workflow!=='string'||!workflow.trim()){
    return ['execution smoke workflow must be readable'];
  }
  const errors=[];
  const checks=[
    [/^name:\s*execution-smoke\s*$/m,'execution smoke workflow must have the stable execution-smoke name'],
    [/^on:\n  deployment_status:\n  schedule:\n    - cron: '29 7 \* \* \*'\n  workflow_dispatch:\n\n/m,
      'execution smoke triggers must be deployment_status, one daily schedule, and workflow_dispatch only'],
    [/^permissions:\n  contents: read\n\njobs:/m,'execution smoke permissions must be contents: read only'],
    [/^    if: >-\n      \(github\.event_name == 'deployment_status' &&\n      github\.event\.deployment_status\.state == 'success' &&\n      github\.event\.deployment\.environment == 'Production' &&\n      github\.event\.deployment\.creator\.login == 'vercel\[bot\]'\) \|\|\n      \(github\.event_name != 'deployment_status' &&\n      github\.ref == format\('refs\/heads\/\{0\}', github\.event\.repository\.default_branch\)\)\n/m,
      'execution smoke must run only for successful Vercel Production deployments or from the default branch'],
    [/^\s{4}environment:\s*production\s*$/m,
      'execution smoke must read its credential through the production environment'],
    [/^\s{4}timeout-minutes:\s*5\s*$/m,'execution smoke job must be time bounded'],
    [/^    concurrency:\n      group: execution-smoke\n      cancel-in-progress: false\n/m,
      'execution smoke runs must be serialized'],
    [/uses:\s+actions\/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1/,
      'execution smoke checkout must use the reviewed immutable revision'],
    [/uses:\s+actions\/setup-node@820762786026740c76f36085b0efc47a31fe5020/,
      'execution smoke Node setup must use the reviewed immutable revision'],
    [/ref:\s*\$\{\{\s*github\.event\.repository\.default_branch\s*\}\}/,
      'execution smoke must run the default-branch assessor'],
    [/persist-credentials:\s*false/,'execution smoke checkout must not persist GitHub credentials'],
    [/      - name: Run the live execution smoke check\n        timeout-minutes: 2\n        env:\n          APP_URL: \$\{\{ vars\.APP_URL \}\}\n          CRON_SECRET: \$\{\{ secrets\.CRON_SECRET \}\}\n          EXECUTION_SMOKE_TIMEOUT_MS: '100000'\n          EXECUTION_SMOKE_TRIGGER: \$\{\{ github\.event_name == 'deployment_status' && 'deploy' \|\| 'schedule' \}\}\n        run: node scripts\/github-execution-smoke\.mjs\n?$/,
      'execution smoke step must retain its exact fail-closed shape'],
  ];
  for(const [pattern,message] of checks){ if(!pattern.test(workflow)) errors.push(message); }
  // The only production material it may see is APP_URL and CRON_SECRET.
  const reviewedProductionAccess=workflow
    .replace(/^ {4}environment: production\n/mu,'')
    .replace(/^ {10}APP_URL: \$\{\{ vars\.APP_URL \}\}\n {10}CRON_SECRET: \$\{\{ secrets\.CRON_SECRET \}\}\n/mu,'');
  if(/pull_request(?:_target)?:|:\s*write\b|write-all|environment:|secrets\.|vars\.|APP_URL|CRON_SECRET|TURSO_|RESEND_|VERCEL_|\bcurl\b|\bgh\s+workflow\b|\/dispatches\b|continue-on-error:|^\s{8}if:/mu
    .test(reviewedProductionAccess)){
    errors.push('execution smoke must remain read-only, non-mutating, and limited to its reviewed cron credential');
  }
  if(/uses:\s+actions\/(?:checkout|setup-node)@v\d+/u.test(workflow)){
    errors.push('execution smoke actions must be pinned to immutable commits');
  }
  return errors;
}

export function validateDeploymentContract({ vercel, packageJson, files, outboxWorkflow,
  outboxWatchdogWorkflow, outboxWatchdogScript, productionSmokeWorkflow, executionSmokeWorkflow,
  executionSmokeScript }) {
  const errors = [];
  const config = record(vercel);
  const manifest = record(packageJson);
  const availableFiles = files instanceof Set ? files : new Set(files ?? []);

  if (!config) {
    return ['vercel.json must contain a JSON object'];
  }
  if (!manifest) errors.push('package.json must contain a JSON object');

  for (const file of REQUIRED_ROOT_FILES) {
    if (!availableFiles.has(file)) errors.push(`required deployment file is missing: ${file}`);
  }

  if (config.cleanUrls !== true) errors.push('vercel.json must enable cleanUrls');
  errors.push(...validateCanonicalDomainRedirects(config.redirects));

  if (manifest?.engines?.node !== SUPPORTED_NODE_RANGE) {
    errors.push(`package.json engines.node must be ${SUPPORTED_NODE_RANGE}`);
  }

  errors.push(...validateOutboxWorkflow(outboxWorkflow));
  errors.push(...validateOutboxWatchdogWorkflow(outboxWatchdogWorkflow));
  errors.push(...validateProductionSmokeWorkflow(productionSmokeWorkflow));
  if (manifest && manifest.scripts?.['smoke:production'] !== `node ${PRODUCTION_SMOKE_SCRIPT_PATH}`) {
    errors.push(`package.json must define smoke:production as node ${PRODUCTION_SMOKE_SCRIPT_PATH}`);
  }
  if(sha256(outboxWatchdogWorkflow)!==OUTBOX_WATCHDOG_WORKFLOW_SHA256){
    errors.push('outbox watchdog workflow must match its reviewed immutable contract');
  }
  if(sha256(outboxWatchdogScript)!==OUTBOX_WATCHDOG_SCRIPT_SHA256){
    errors.push('outbox watchdog assessor must match its reviewed immutable contract');
  }
  errors.push(...validateExecutionSmokeWorkflow(executionSmokeWorkflow));
  if(sha256(executionSmokeWorkflow)!==EXECUTION_SMOKE_WORKFLOW_SHA256){
    errors.push('execution smoke workflow must match its reviewed immutable contract');
  }
  if(sha256(executionSmokeScript)!==EXECUTION_SMOKE_SCRIPT_SHA256){
    errors.push('execution smoke assessor must match its reviewed immutable contract');
  }

  if (!Array.isArray(config.rewrites) || config.rewrites.length === 0) {
    errors.push('vercel.json must define rewrites');
  } else {
    const sources = new Set();
    for (const [index, rewrite] of config.rewrites.entries()) {
      if (!record(rewrite) || typeof rewrite.source !== 'string' || typeof rewrite.destination !== 'string') {
        errors.push(`rewrite ${index} must define string source and destination values`);
        continue;
      }
      if (sources.has(rewrite.source)) errors.push(`duplicate rewrite source: ${rewrite.source}`);
      sources.add(rewrite.source);

      const isFallback = index === config.rewrites.length - 1
        && rewrite.source === '/(.*)'
        && rewrite.destination === SPA_FALLBACK_DESTINATION;
      if (!isFallback) {
        const handler = requiredHandler(rewrite.destination);
        if (!handler) {
          errors.push(`rewrite ${rewrite.source} must target a local grouped API handler`);
        } else if (!availableFiles.has(handler)) {
          errors.push(`rewrite ${rewrite.source} targets missing handler ${handler}`);
        }
      }
    }

    const fallback = config.rewrites.at(-1);
    if (fallback?.source !== '/(.*)' || fallback?.destination !== SPA_FALLBACK_DESTINATION) {
      errors.push(`the final rewrite must be the SPA fallback /(.*) -> ${SPA_FALLBACK_DESTINATION}`);
    }
  }

  if (!Array.isArray(config.headers)) {
    errors.push('vercel.json must define response headers');
  } else {
    const apiHeaders = routeHeaders(config.headers, '/api/(.*)');
    if (!apiHeaders) {
      errors.push('API routes must define response headers');
    } else {
      if (apiHeaders.get('cache-control') !== 'no-store') {
        errors.push('API routes must set Cache-Control to no-store');
      }
      if (apiHeaders.get('x-content-type-options')?.toLowerCase() !== 'nosniff') {
        errors.push('API routes must set X-Content-Type-Options to nosniff');
      }
    }

    const pageHeaders = routeHeaders(config.headers, '/(.*)');
    for (const key of REQUIRED_SECURITY_HEADERS) {
      if (!securityHeaderIsSafe(key, pageHeaders?.get(key) ?? '')) {
        errors.push(`page routes must define a safe ${key}`);
      }
    }
  }

  if (!Array.isArray(config.crons)) {
    errors.push('vercel.json must define crons');
  } else {
    const rewriteSources = new Set(
      Array.isArray(config.rewrites)
        ? config.rewrites.map(item => record(item)?.source).filter(Boolean)
        : [],
    );
    const cronPaths = new Set();
    for (const [index, cron] of config.crons.entries()) {
      if (!record(cron) || typeof cron.path !== 'string') {
        errors.push(`cron ${index} must define a path`);
        continue;
      }
      if (cronPaths.has(cron.path)) errors.push(`duplicate cron path: ${cron.path}`);
      cronPaths.add(cron.path);
      if (!rewriteSources.has(cron.path)) errors.push(`cron path has no matching rewrite: ${cron.path}`);
      if (!cronExpressionLooksValid(cron.schedule)) {
        errors.push(`cron ${cron.path} must use a five-field schedule`);
      }
    }
  }

  return errors;
}

export function inspectDeploymentContract(rootDirectory = process.cwd()) {
  const root = resolve(rootDirectory);
  const files = new Set(REQUIRED_ROOT_FILES.filter(file => {
    try {
      readFileSync(resolve(root, file));
      return true;
    } catch {
      return false;
    }
  }));

  try {
    for (const file of readdirSync(resolve(root, 'api'))) {
      if (file.endsWith('.js')) files.add(`api/${file}`);
    }
  } catch {
    // The missing handlers are reported from the rewrite contract below.
  }

  let vercel;
  let packageJson;
  let outboxWorkflow;
  let outboxWatchdogWorkflow;
  let outboxWatchdogScript;
  let productionSmokeWorkflow;
  let executionSmokeWorkflow;
  let executionSmokeScript;
  try {
    vercel = JSON.parse(readFileSync(resolve(root, 'vercel.json'), 'utf8'));
  } catch (error) {
    return [`vercel.json is not readable JSON: ${error.message}`];
  }
  try {
    packageJson = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'));
  } catch (error) {
    return [`package.json is not readable JSON: ${error.message}`];
  }

  try {
    outboxWorkflow = readFileSync(resolve(root, OUTBOX_WORKFLOW_PATH), 'utf8');
  } catch {
    outboxWorkflow = null;
  }

  try {
    outboxWatchdogWorkflow = readFileSync(resolve(root, OUTBOX_WATCHDOG_WORKFLOW_PATH), 'utf8');
  } catch {
    outboxWatchdogWorkflow = null;
  }

  try {
    outboxWatchdogScript = readFileSync(resolve(root, OUTBOX_WATCHDOG_SCRIPT_PATH), 'utf8');
  } catch {
    outboxWatchdogScript = null;
  }

  try {
    productionSmokeWorkflow = readFileSync(resolve(root, PRODUCTION_SMOKE_WORKFLOW_PATH), 'utf8');
  } catch {
    productionSmokeWorkflow = null;
  }

  try {
    executionSmokeWorkflow = readFileSync(resolve(root, EXECUTION_SMOKE_WORKFLOW_PATH), 'utf8');
  } catch {
    executionSmokeWorkflow = null;
  }

  try {
    executionSmokeScript = readFileSync(resolve(root, EXECUTION_SMOKE_SCRIPT_PATH), 'utf8');
  } catch {
    executionSmokeScript = null;
  }

  return validateDeploymentContract({ vercel, packageJson, files, outboxWorkflow,
    outboxWatchdogWorkflow, outboxWatchdogScript, productionSmokeWorkflow, executionSmokeWorkflow,
    executionSmokeScript });
}

function main() {
  const errors = inspectDeploymentContract();
  if (errors.length > 0) {
    console.error(JSON.stringify({ ok: false, errors }, null, 2));
    process.exitCode = 1;
    return;
  }
  console.log(JSON.stringify({
    ok: true,
    gate: 'repository-deployability-contract',
    providerNetworkRequired: false,
  }));
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : null;
if (invokedPath === import.meta.url) main();
