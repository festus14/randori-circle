import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deriveExerciseLanguages } from '../api/_catalog-languages.js';
import { createEvaluationSuite } from '../api/_catalog.js';
import { GO_CATALOG_REFERENCES } from './catalog-go-references.mjs';

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

export function runReferenceProgram(language, source, { spawn = spawnSync } = {}) {
  if (language === 'go') {
    const directory = mkdtempSync(join(tmpdir(), 'randori-go-reference-'));
    try {
      writeFileSync(join(directory, 'main.go'), source.harness);
      writeFileSync(join(directory, 'submission.go'), source.submission);
      const result = spawn('go', ['run', 'main.go', 'submission.go'], {
        cwd: directory, env: { ...process.env, GOPROXY: 'off', GOSUMDB: 'off', GOTOOLCHAIN: 'local' },
        encoding: 'utf8', timeout: 30_000, maxBuffer: 256 * 1024,
      });
      if (result.error || result.status !== 0) throw new Error(`go reference process failed: ${result.error?.message || result.stderr}`);
      return result.stdout;
    } finally { rmSync(directory, { recursive: true, force: true }); }
  }
  const nodeLanguage = ['javascript', 'typescript'].includes(language);
  const command = nodeLanguage ? process.execPath : 'python3';
  const args = nodeLanguage ? ['--input-type=commonjs'] : ['-'];
  const result = spawn(command, args, { input: source, encoding: 'utf8', timeout: 10_000, maxBuffer: 256 * 1024 });
  if (language === 'python' && result.error?.code === 'ENOENT') {
    throw new Error('Catalogue reference validation requires python3 on PATH. Install Python 3 locally; CI provisions it with actions/setup-python. No execution provider is needed.');
  }
  if (result.error || result.status !== 0) throw new Error(`${language} reference process failed: ${result.error?.message || result.stderr}`);
  return result.stdout;
}

// Offline only. Runs authored references, never member submissions or providers.
// These checks execute in the exact production harness and result comparator,
// including Python's restricted builtins/no-import boundary. The JS arm only
// proves the server oracle executes in that harness; it is not an independent
// correctness proof. Correctness comes from comparison with the separately
// authored Python reference plus the independent small-input unit references.
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
      // The JS source below is the oracle itself: this arm checks VM/harness
      // compatibility, while the separately authored Python arm checks answers.
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

export function typescriptOracleSource(oracle) {
  const source = Function.prototype.toString.call(oracle);
  const header = source.match(/^function\s+([A-Za-z_][\w]*)\s*\(([^)]*)\)\s*\{/);
  const parameters = header && header[2].trim() ? header[2].split(',').map(value => value.trim()) : [];
  if (!header || !parameters.every(value => /^[A-Za-z_][\w]*$/.test(value))) {
    throw new Error('TypeScript oracle references require a named function with plain identifier parameters (no defaults, destructuring or rest parameters)');
  }
  return source.replace(header[0], `function ${header[1]}(${parameters.map(name => `${name}: any`).join(', ')}): any {`);
}

// Validate additions even while rollout flags are off. TypeScript is mandatory
// offline. Go runs with a local toolchain only, never a download/provider; CI
// sets CATALOG_REQUIRE_GO=true to make a missing toolchain a hard failure.
export function validateAdditionalLanguageReferences(catalog, { seed = 466,
  runProgram = runReferenceProgram, goAvailable = spawnSync('go', ['version'], { encoding: 'utf8' }).status === 0,
  requireGo = process.env.CATALOG_REQUIRE_GO === 'true' } = {}) {
  if (requireGo && !goAvailable) throw new Error('Go catalogue validation requires a local Go toolchain on PATH (no downloads or providers).');
  const env = { EXECUTION_PROVIDER: 'piston', EXECUTION_API_URL: 'https://offline.example.test/execute',
    EXECUTION_LANGUAGE_TYPESCRIPT_ENABLED: 'true', EXECUTION_LANGUAGE_GO_ENABLED: 'true' };
  let typescriptCases = 0, goCases = 0;
  for (const exercise of catalog.exercises.filter(item => item.status === 'active')) {
    const key = `${exercise.slug}@${exercise.version}`;
    const languages = deriveExerciseLanguages(exercise);
    // Parse every starter through the exact production harness. Starters need
    // not pass an oracle: their purpose is a valid editable entrypoint.
    const starterPrefix = '__STARTER__:';
    const starterTests = [{ args: [], expected: null }];
    const starterOutput = runProgram('typescript', buildExecutionHarness('typescript', languages.typescript.starter,
      { entrypoint: languages.typescript.entrypoint, tests: starterTests }, starterPrefix));
    if (!normalizeRunnerResults(starterOutput, starterPrefix, starterTests)[0].pass) throw new Error(`${key} invalid TypeScript starter`);
    const suite = createEvaluationSuite(exercise.slug, exercise.version, 'typescript', { env, random: seededKitRandom(seed) });
    const kit = INTERVIEW_KIT_DEFINITIONS[key];
    if (kit) {
      const source = typescriptOracleSource(kit.oracle);
      const prefix = '__TYPESCRIPT_REFERENCE__:';
      const tests = [...suite.tests, ...exercise.examples.map(example => ({ args: example.input, expected: example.output }))];
      const output = runProgram('typescript', buildExecutionHarness('typescript', source, { ...suite, tests }, prefix));
      if (normalizeRunnerResults(output, prefix, tests).some(result => !result.pass)) throw new Error(`${key} typescript reference disagrees with oracle`);
      typescriptCases += tests.length;
    }
    if (GO_CATALOG_REFERENCES[key]) {
      const goSuite = { ...suite, language: 'go', entrypoint: languages.go.entrypoint,
        tests: [...suite.tests, ...exercise.examples.map(example => ({ args: example.input, expected: example.output }))] };
      const prefix = '__GO_REFERENCE__:';
      const harness = buildExecutionHarness('go', GO_CATALOG_REFERENCES[key], goSuite, prefix);
      if (goAvailable) {
        runProgram('go', buildExecutionHarness('go', languages.go.starter, { ...goSuite, tests: [] }, prefix));
        const output = runProgram('go', harness);
        if (normalizeRunnerResults(output, prefix, goSuite.tests, { strictSequence: true }).some(result => !result.pass)) throw new Error(`${key} go reference disagrees with oracle`);
        goCases += goSuite.tests.length;
      }
    } else if (kit) throw new Error(`Missing Go kit reference: ${key}`);
  }
  return { typescriptCases, goCases, goSkipped: !goAvailable };
}
