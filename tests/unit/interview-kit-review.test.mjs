import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import YAML from 'yaml';

import { createEvaluationSuite } from '../../api/_catalog.js';
import { INTERVIEW_KIT_DEFINITIONS } from '../../api/_catalog-interview-kits.js';
import { defaultRandom, randomInteger, randomUnit } from '../../api/_catalog-random.js';
import { buildExecutionHarness, normalizeRunnerResults } from '../../api/_execution.js';
import { runReferenceProgram } from '../../scripts/validate-interview-kits.mjs';

test('shared catalogue RNG validates boundaries and backs both generator families', () => {
  assert.equal(randomUnit(() => 0), 0);
  assert.equal(randomInteger(() => 0, 3, 9), 3);
  assert.equal(randomInteger(() => 0.99999, 3, 9), 9);
  assert.equal(randomInteger(() => 0.5, -5, 5), 0);
  for (const invalid of [-1, 1, NaN, Infinity]) assert.throws(() => randomUnit(() => invalid), /finite number in/);
  assert.throws(() => randomUnit(null), /must be a function/);
  for (let index = 0; index < 10; index += 1) assert.ok(defaultRandom() >= 0 && defaultRandom() < 1);
  for (const path of ['_catalog.js', '_catalog-interview-kits.js']) {
    const source = readFileSync(new URL(`../../api/${path}`, import.meta.url), 'utf8');
    assert.match(source, /from '\.\/_catalog-random\.js'/);
    assert.doesNotMatch(source, /function (?:integer|randomInteger|randomUnit)\(/);
  }
});

function mutantResults(key, old, replacement) {
  const suite = createEvaluationSuite(key.split('@')[0], 1, 'javascript', { random: () => 0.5 });
  const source = INTERVIEW_KIT_DEFINITIONS[key].oracle.toString();
  assert.ok(source.includes(old), 'the intended mutation must still match the oracle');
  const prefix = '__REVIEW__:';
  const output = runReferenceProgram('javascript', buildExecutionHarness('javascript', source.replace(old, replacement), suite, prefix));
  const results = normalizeRunnerResults(output, prefix, suite.tests);
  assert.ok(results.some(result => !result.pass), 'a plausible incorrect rule must fail at least one generated case');
  return results;
}

for (const [rule, before, after] of [
  ['cooldown', 'lastRound[index] === round - 1', 'lastRound[index] === -999999'],
  ['credit cap', 'Math.min(ordered[index].cap, credits[index] + ordered[index].refill)', '(credits[index] + ordered[index].refill)'],
  ['rotating visit order', '(round - 1 + offset) % ordered.length', 'offset % ordered.length'],
  ['global slots', 'dispatched < slots', 'dispatched < Infinity'],
  ['FIFO rather than shortest charge', 'const lane = ordered[index];', 'const lane = { ...ordered[index], charges: [...ordered[index].charges].sort((a, b) => a - b) };'],
]) {
  test(`Retry Credit Rounds catches incorrect ${rule}`, () => {
    mutantResults('retry-credit-rounds@1', before, after);
  });
}

test('Focus Shortcut Tour catches duplicate-pair first-wins and last-wins implementations', () => {
  const firstWins = mutantResults('focus-shortcut-tour@1',
    'distances[from][to] = Math.min(distances[from][to], effort)',
    'distances[from][to] = Number.isFinite(distances[from][to]) ? distances[from][to] : effort');
  assert.equal(firstWins[4].pass, false, 'cheaper second edge must not be ignored');
  const lastWins = mutantResults('focus-shortcut-tour@1',
    'distances[from][to] = Math.min(distances[from][to], effort)', 'distances[from][to] = effort');
  assert.equal(lastWins[2].pass, false, 'more expensive second edge must not overwrite the cheaper first edge');
});

test('offline reference checks explain missing Python and retain process-error handling', () => {
  const missing = Object.assign(new Error('spawn python3 ENOENT'), { code: 'ENOENT' });
  assert.throws(() => runReferenceProgram('python', '', { spawn: () => ({ error: missing }) }), /requires python3 on PATH.*Install Python 3.*setup-python/);
  assert.throws(() => runReferenceProgram('javascript', '', { spawn: () => ({ error: new Error('I/O failed') }) }), /reference process failed: I\/O failed/);
  assert.throws(() => runReferenceProgram('python', '', { spawn: () => ({ status: 1, stderr: 'bad program' }) }), /reference process failed: bad program/);
});

test('all catalogue-validation CI jobs provision pinned Python before executing references', () => {
  for (const path of ['e2e.yml', 'ubuntu-26-canary.yml']) {
    const workflow = YAML.parse(readFileSync(new URL(`../../.github/workflows/${path}`, import.meta.url), 'utf8'));
    let checked = 0;
    for (const job of Object.values(workflow.jobs)) {
      const validation = job.steps.findIndex(step => step.run?.includes('npm run validate:catalog'));
      if (validation < 0) continue;
      const provision = job.steps.findIndex(step => /^actions\/setup-python@[a-f0-9]{40}$/.test(step.uses || ''));
      assert.ok(provision >= 0 && provision < validation, `${path} must install Python first`);
      assert.equal(job.steps[provision].with['python-version'], '3.14');
      checked += 1;
    }
    assert.equal(checked, 1);
  }
});
