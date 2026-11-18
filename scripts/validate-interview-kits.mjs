import { spawnSync } from 'node:child_process';

import { INTERVIEW_KIT_DEFINITIONS } from '../api/_catalog-interview-kits.js';
import { buildExecutionHarness, normalizeRunnerResults } from '../api/_execution.js';
import { PYTHON_KIT_REFERENCES } from './catalog-interview-kit-references.mjs';

export function seededKitRandom(seed = 469) {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

export function runReferenceProgram(language, source) {
  const command = language === 'javascript' ? process.execPath : 'python3';
  const args = language === 'javascript' ? ['--input-type=commonjs'] : ['-'];
  const result = spawnSync(command, args, { input: source, encoding: 'utf8', timeout: 10_000, maxBuffer: 256 * 1024 });
  if (result.error || result.status !== 0) throw new Error(`${language} reference process failed: ${result.error?.message || result.stderr}`);
  return result.stdout;
}

// Offline only. Runs authored references, never member submissions or providers.
// Checked-in content and generated cases use the exact production harness and
// result comparator, including Python's restricted builtins/no-import boundary.
export function validateInterviewKitReferences(catalog, { seed = 469, runProgram = runReferenceProgram } = {}) {
  let exerciseCount = 0, caseCount = 0;
  for (const exercise of catalog.exercises) {
    const key = `${exercise.slug}@${exercise.version}`;
    const definition = INTERVIEW_KIT_DEFINITIONS[key];
    if (!definition || exercise.status !== 'active') continue;
    if (!PYTHON_KIT_REFERENCES[key]) throw new Error(`Missing Python reference: ${key}`);
    const random = seededKitRandom(seed);
    const generated = Array.from({ length: 8 }, (_, index) => {
      const args = definition.generateArgs(random, index);
      return { id: `generated-${index + 1}`, args, expected: definition.oracle(...structuredClone(args)) };
    });
    const tests = [...generated, ...exercise.examples.map((example, index) => {
      const expected = definition.oracle(...structuredClone(example.input));
      const checked = normalizeRunnerResults(`__EXAMPLE__:${JSON.stringify({ idx: 0, ok: true, got: expected })}`, '__EXAMPLE__:', [{ expected: example.output }]);
      if (!checked[0].pass) throw new Error(`Public example disagrees with oracle: ${key} example ${index + 1}`);
      return { id: `example-${index + 1}`, args: example.input, expected: example.output };
    })];
    for (const language of ['javascript', 'python']) {
      const source = language === 'javascript' ? definition.oracle.toString() : PYTHON_KIT_REFERENCES[key];
      const suite = { entrypoint: exercise.languages[language].entrypoint, tests };
      const prefix = '__KIT_REFERENCE__:';
      const output = runProgram(language, buildExecutionHarness(language, source, suite, prefix));
      const results = normalizeRunnerResults(output, prefix, tests);
      if (results.some(result => !result.pass)) {
        throw new Error(`${key} ${language} reference failed cases: ${results.filter(result => !result.pass).map(result => tests[result.idx].id).join(', ')}`);
      }
      caseCount += tests.length;
    }
    exerciseCount += 1;
  }
  return { exerciseCount, caseCount };
}
