import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';

const OUTBOX_WORKFLOW_PATH='.github/workflows/outbox-dispatch.yml';
const OUTBOX_WATCHDOG_WORKFLOW_PATH='.github/workflows/outbox-dispatch-watchdog.yml';
const OUTBOX_WATCHDOG_SCRIPT_PATH='scripts/github-outbox-dispatch-watchdog.mjs';
const OUTBOX_WATCHDOG_WORKFLOW_SHA256='7843bfeb5b444df4ca202b45974f0699a5a348514dc7eaae64e8bc14f2e997eb';
const OUTBOX_WATCHDOG_SCRIPT_SHA256='01eecb04b859e364e824708a12f3f2aea91751cb438954ebc90999328b4f2bc8';
const REQUIRED_ROOT_FILES = [
  'index.html', 'package-lock.json', 'package.json', 'vercel.json', OUTBOX_WORKFLOW_PATH,
  OUTBOX_WATCHDOG_WORKFLOW_PATH, OUTBOX_WATCHDOG_SCRIPT_PATH,
];
const REQUIRED_SECURITY_HEADERS = [
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

function securityHeaderIsSafe(key, value) {
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
    [/      - name: Assess scheduled outbox delivery\n        timeout-minutes: 2\n        env:\n          GITHUB_TOKEN: \$\{\{ github\.token \}\}\n          WATCHDOG_DEFAULT_BRANCH: \$\{\{ github\.event\.repository\.default_branch \}\}\n          WATCHDOG_SCHEDULE_GRACE_MS: '900000'\n          WATCHDOG_WORKER_DEADLINE_MS: '120000'\n          WATCHDOG_API_TIMEOUT_MS: '10000'\n          WATCHDOG_MAX_PAGES: '2'\n          WATCHDOG_PER_PAGE: '100'\n        run: node scripts\/github-outbox-dispatch-watchdog\.mjs(?:\n|$)/,
      'outbox watchdog assessment step must retain its exact fail-closed shape'],
    [/uses:\s+actions\/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1/,
      'outbox watchdog checkout must use the reviewed immutable revision'],
    [/uses:\s+actions\/setup-node@820762786026740c76f36085b0efc47a31fe5020/,
      'outbox watchdog Node setup must use the reviewed immutable revision'],
    [/persist-credentials:\s*false/,
      'outbox watchdog checkout must not persist GitHub credentials'],
  ];
  for(const [pattern,message] of checks){ if(!pattern.test(workflow)) errors.push(message); }
  if(/pull_request(?:_target)?:|permissions:[\s\S]*?\bwrite\b|environment:|secrets\.|vars\.|APP_URL|CRON_SECRET|TURSO_|RESEND_|\/api\/cron\/outbox|\bcurl\b|\bgh\s+workflow\b|\/dispatches\b|continue-on-error:|^\s{8}if:/mu.test(workflow)){
    errors.push('outbox watchdog must remain secret-free, read-only, and non-mutating');
  }
  if(/uses:\s+actions\/(?:checkout|setup-node)@v\d+/u.test(workflow)){
    errors.push('outbox watchdog actions must be pinned to immutable commits');
  }
  return errors;
}

export function validateDeploymentContract({ vercel, packageJson, files, outboxWorkflow,
  outboxWatchdogWorkflow, outboxWatchdogScript }) {
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

  if (manifest?.engines?.node !== SUPPORTED_NODE_RANGE) {
    errors.push(`package.json engines.node must be ${SUPPORTED_NODE_RANGE}`);
  }

  errors.push(...validateOutboxWorkflow(outboxWorkflow));
  errors.push(...validateOutboxWatchdogWorkflow(outboxWatchdogWorkflow));
  if(sha256(outboxWatchdogWorkflow)!==OUTBOX_WATCHDOG_WORKFLOW_SHA256){
    errors.push('outbox watchdog workflow must match its reviewed immutable contract');
  }
  if(sha256(outboxWatchdogScript)!==OUTBOX_WATCHDOG_SCRIPT_SHA256){
    errors.push('outbox watchdog assessor must match its reviewed immutable contract');
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
        && rewrite.destination === '/index.html';
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
    if (fallback?.source !== '/(.*)' || fallback?.destination !== '/index.html') {
      errors.push('the final rewrite must be the SPA fallback /(.*) -> /index.html');
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

  return validateDeploymentContract({ vercel, packageJson, files, outboxWorkflow,
    outboxWatchdogWorkflow, outboxWatchdogScript });
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
