#!/usr/bin/env node
// Opt-in live smoke test for the production execution provider.
//
// It calls the same gateway code as /api/execute (harness generation, provider,
// bounded output, oracle comparison) against the real Vercel Sandbox API. It
// creates real sandboxes that count against the Vercel plan allowance (five per
// invocation), so it never runs in `npm test` or CI.
//
// Usage after deploy, from a checkout linked to the Vercel project:
//   vercel env pull .env.local          # provides a 12-hour VERCEL_OIDC_TOKEN
//   node --env-file=.env.local scripts/execution-smoke.mjs
//
// It cannot run without Vercel credentials and exits 2 when none are present.
import { randomBytes } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { createEvaluationSuite } from '../api/_catalog.js';
import { buildExecutionHarness, executeProgram, normalizeRunnerResults } from '../api/_execution.js';
import { countPassed, egressFailure, smokeEnvironment, smokeFailureMessage } from './execution-smoke-checks.mjs';

const SLUG = 'focus-block-rollup';
const VERSION = 1;

const SOLUTIONS = {
  javascript: entrypoint => `function ${entrypoint}(blocks){
  const result=[];
  for(const block of blocks){
    const previous=result[result.length-1];
    if(previous && previous.label===block.label) previous.minutes+=block.minutes;
    else result.push({...block});
  }
  return result;
}`,
  python: entrypoint => `def ${entrypoint}(blocks):
    result=[]
    for block in blocks:
        previous=result[-1] if result else None
        if previous and previous['label']==block['label']:
            previous['minutes']+=block['minutes']
        else:
            result.append(dict(block))
    return result`,
};

const EGRESS_PROBE = `fetch('https://example.com',{signal:AbortSignal.timeout(4000)})
  .then(()=>console.log('EGRESS_OPEN'))
  .catch(()=>console.log('EGRESS_BLOCKED'));`;

function fail(message) {
  console.error(`execution smoke: FAIL ${message}`);
  process.exitCode = 1;
}

async function main() {
  const setup = smokeEnvironment(process.env);
  if (!setup.ok) {
    console.error('execution smoke: VERCEL_OIDC_TOKEN is not set. Run `vercel env pull .env.local` in a linked checkout and pass --env-file=.env.local.');
    process.exit(setup.exitCode);
  }
  const { env } = setup;

  for (const language of ['javascript', 'python']) {
    const suite = createEvaluationSuite(SLUG, VERSION, language);
    if (!suite) return fail(`catalogue exercise ${SLUG}@${VERSION} is unavailable`);
    const prefix = `__RANDORI_RESULT_${randomBytes(16).toString('hex')}__:`;
    const started = Date.now();
    const run = await executeProgram({
      language,
      source: buildExecutionHarness(language, SOLUTIONS[language](suite.entrypoint), suite, prefix),
    }, { env });
    const results = normalizeRunnerResults(run.stdout, prefix, suite.tests);
    const passed = countPassed(results);
    console.log(`execution smoke: ${run.provider} ${language} ${run.runtimeVersion} ${passed}/${suite.tests.length} in ${Date.now() - started}ms (exit ${run.code})`);
    if (passed !== suite.tests.length) fail(`${language} reference solution did not pass every case`);

    const broken = await executeProgram({
      language,
      source: buildExecutionHarness(language, language === 'javascript'
        ? `function ${suite.entrypoint}(){ return null; }`
        : `def ${suite.entrypoint}(*args):\n    return None`, suite, prefix),
    }, { env });
    const brokenPassed = countPassed(normalizeRunnerResults(broken.stdout, prefix, suite.tests));
    if (brokenPassed !== 0) fail(`${language} broken solution passed ${brokenPassed} case(s)`);
  }

  if (env.EXECUTION_PROVIDER === 'vercel-sandbox') {
    const probe = await executeProgram({ language: 'javascript', source: EGRESS_PROBE }, { env });
    console.log(`execution smoke: egress probe -> ${probe.stdout.trim() || '(no output)'}`);
    const egress = egressFailure(probe);
    if (egress) fail(egress);
  }

  if (!process.exitCode) console.log('execution smoke: OK');
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  main().catch(error => fail(smokeFailureMessage(error)));
}
