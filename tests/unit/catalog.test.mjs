import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import {
  CatalogValidationError,
  SUPPORTED_LANGUAGES,
  createEvaluationSuite,
  getActiveExercise,
  getPublicExercise,
  listPublicExercises,
  validateCatalog,
  validateEvaluationSuite,
} from '../../api/_catalog.js';
import { canonicalExerciseHash } from '../../api/_catalog-provenance.js';

const catalogPath = new URL('../../data/randori-catalog-v1.json', import.meta.url);
const provenancePath = new URL('../../data/randori-catalog-provenance-v1.json', import.meta.url);

function freshCatalog() {
  return JSON.parse(readFileSync(catalogPath, 'utf8'));
}

function freshProvenance() {
  return JSON.parse(readFileSync(provenancePath, 'utf8'));
}

function seededRandom(seed = 1) {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

function runtimeDefinitionsFor(catalog) {
  return Object.fromEntries(
    catalog.exercises
      .filter(exercise => exercise.status === 'active')
      .map(exercise => [
        `${exercise.slug}@${exercise.version}`,
        { generateArgs() { return [[]]; }, oracle() { return null; } },
      ]),
  );
}

function graphHasCycle(tasks, dependencies) {
  const remaining = new Set(tasks);
  const complete = new Set();
  while (remaining.size > 0) {
    const ready = [...remaining].filter(task => (
      dependencies.every(([before, after]) => after !== task || complete.has(before))
    ));
    if (ready.length === 0) return true;
    for (const task of ready) {
      remaining.delete(task);
      complete.add(task);
    }
  }
  return false;
}

function assertCatalogError(action, pattern) {
  assert.throws(action, error => {
    assert.ok(error instanceof CatalogValidationError);
    assert.match(error.message, pattern);
    return true;
  });
}

function hasForbiddenPublicKey(value) {
  if (Array.isArray(value)) return value.some(hasForbiddenPublicKey);
  if (value === null || typeof value !== 'object') return false;
  const forbidden = new Set([
    'args', 'expected', 'evaluationSuites', 'private', 'tests', 'testCases',
    'serverTests', 'retirement', 'takedown',
  ]);
  return Object.entries(value).some(([key, nested]) => (
    forbidden.has(key) || hasForbiddenPublicKey(nested)
  ));
}

test('the bundled original catalogue passes strict validation', () => {
  const raw = freshCatalog();
  assert.equal(Object.hasOwn(raw, 'evaluationSuites'), false);
  assert.doesNotMatch(JSON.stringify(raw), /"evaluationSuites"|"serverTests"|"tests":/);
  const result = validateCatalog(raw);
  assert.deepEqual(result, { valid: true, exerciseCount: 11 });
  assert.deepEqual(SUPPORTED_LANGUAGES, ['javascript', 'python']);
});

test('a warm runtime rechecks review expiry on every catalogue operation', () => {
  const suite = createEvaluationSuite(
    'focus-block-rollup',
    1,
    'javascript',
    { random: seededRandom(7) },
  );
  const RealDate = globalThis.Date;
  const expiredNow = RealDate.parse('2027-09-19T00:00:00.000Z');
  globalThis.Date = class ExpiredCatalogueDate extends RealDate {
    constructor(...args) {
      super(...(args.length ? args : [expiredNow]));
    }

    static now() {
      return expiredNow;
    }
  };
  try {
    for (const operation of [
      () => listPublicExercises(),
      () => getPublicExercise('focus-block-rollup', 1),
      () => getActiveExercise('focus-block-rollup', 1),
      () => createEvaluationSuite('focus-block-rollup', 1, 'javascript'),
      () => validateEvaluationSuite(suite),
    ]) {
      assertCatalogError(operation, /review\.expiresAt: expired before 2027-09-19/);
    }
  } finally {
    globalThis.Date = RealDate;
  }
  assert.equal(listPublicExercises().length, 10);
});

test('public listing returns full active exercises without server-owned test data', () => {
  const exercises = listPublicExercises();
  assert.equal(exercises.length, 10);
  assert.deepEqual(
    exercises.map(exercise => exercise.slug),
    [
      'focus-block-rollup',
      'steady-sensor-windows',
      'review-wave-planner',
      'workshop-seat-allocation',
      'coverage-gap-finder',
      'balanced-template-markers',
      'capacity-upgrade-index',
      'shortest-handoff-path',
      'message-frequency-leaders',
      'recovery-budget-plan',
    ],
  );
  for (const exercise of exercises) {
    assert.equal(exercise.status, 'active');
    assert.equal(exercise.source, 'randori-original');
    assert.ok(exercise.prompt.length > 40);
    assert.equal(exercise.description, exercise.prompt);
    assert.ok(exercise.examples.length > 0);
    assert.ok(exercise.languages.javascript.starter.includes(exercise.languages.javascript.entrypoint));
    assert.ok(exercise.languages.python.starter.includes(exercise.languages.python.entrypoint));
    assert.match(exercise.provenance, /Original exercise/);
    assert.deepEqual(
      Object.keys(exercise.contentProvenance).sort(),
      ['author', 'contentHash', 'expiresAt', 'licenseIdentifier', 'licenseName', 'reviewedAt', 'schemaVersion', 'sourceType'],
    );
    assert.equal(exercise.contentProvenance.sourceType, 'original');
    assert.equal(exercise.contentProvenance.licenseIdentifier, 'LicenseRef-Randori-Original');
    assert.match(exercise.contentProvenance.contentHash, /^sha256:[a-f0-9]{64}$/);
    assert.equal(hasForbiddenPublicKey(exercise), false);
  }
  assert.doesNotMatch(JSON.stringify(exercises), /long-merge|whole-input-boundary|mixed-reasons/);
});

test('the original content pack exposes the intended concepts and complete public statements',()=>{
  const expected={
    'balanced-template-markers':['Easy','stack-string',['stack','strings']],
    'capacity-upgrade-index':['Easy','binary-search',['arrays','binary-search']],
    'shortest-handoff-path':['Medium','graph-traversal',['graphs','breadth-first-search']],
    'message-frequency-leaders':['Medium','hash-map',['hash-maps','sorting']],
    'recovery-budget-plan':['Medium','dynamic-programming',['dynamic-programming','optimization']],
  };
  for(const [slug,[difficulty,type,tags]] of Object.entries(expected)){
    const exercise=getPublicExercise(slug,1);
    assert.ok(exercise,slug);
    assert.equal(exercise.status,'active');
    assert.equal(exercise.difficulty,difficulty);
    assert.equal(exercise.type,type);
    assert.deepEqual(exercise.tags,tags);
    assert.ok(exercise.prompt.length>150);
    assert.ok(exercise.constraints.length>=3);
    assert.ok(exercise.examples.length>=2);
    assert.match(exercise.provenance,/Original exercise/);
    assert.equal(hasForbiddenPublicKey(exercise),false);
  }
  assert.doesNotMatch(
    getPublicExercise('capacity-upgrade-index',1).prompt,
    /input must not be modified/i,
  );
});

test('balanced marker suites always include meaningful valid and invalid marker strings',()=>{
  for(const seed of [1,17,4_294_967_295]){
    const tests=createEvaluationSuite(
      'balanced-template-markers',
      1,
      'javascript',
      {random:seededRandom(seed)},
    ).tests;
    assert.ok(tests.some(testCase=>testCase.expected===true&&/[()[\]{}]/.test(testCase.args[0])));
    assert.ok(tests.some(testCase=>testCase.expected===false&&/[()[\]{}]/.test(testCase.args[0])));
    assert.equal(tests[2].expected,true,'the nontrivial nested marker case is valid');
    assert.equal(tests[3].expected,false,'the crossed closing-marker mutation is invalid');
  }
});

test('public detail resolves the current active version or an exact supplied version', () => {
  const exercise = getPublicExercise('focus-block-rollup', 1);
  assert.equal(exercise?.slug, 'focus-block-rollup');
  assert.equal(exercise?.version, 1);
  assert.equal(hasForbiddenPublicKey(exercise), false);
  assert.equal(getPublicExercise('focus-block-rollup')?.version, 1);
  assert.equal(getPublicExercise('focus-block-rollup', 2), null);
  assert.equal(getPublicExercise('focus-block-rollup', null), null);
  assert.equal(getPublicExercise('unknown', 1), null);
  assert.equal(getPublicExercise('unknown'), null);
  assert.equal(getPublicExercise('archived-session-streak', 1), null);
  assert.equal(getPublicExercise('archived-session-streak'), null);
});

test('trusted active lookup also excludes retired and unknown records', () => {
  const exercise = getActiveExercise('coverage-gap-finder', 1);
  assert.equal(exercise?.title, 'Coverage Gap Finder');
  assert.equal(getActiveExercise('coverage-gap-finder')?.version, 1);
  assert.equal(getActiveExercise('coverage-gap-finder', 1.5), null);
  assert.equal(getActiveExercise('archived-session-streak', 1), null);
  assert.equal(getActiveExercise(null, 1), null);
});

test('public projections are defensive clones', () => {
  const firstList = listPublicExercises();
  firstList[0].title = 'mutated';
  firstList[0].examples[0].output = 'mutated';
  firstList[0].languages.javascript.starter = 'mutated';

  const secondList = listPublicExercises();
  assert.equal(secondList[0].title, 'Focus Block Roll-up');
  assert.notEqual(secondList[0].examples[0].output, 'mutated');
  assert.match(secondList[0].languages.javascript.starter, /rollUpFocusBlocks/);

  const active = getActiveExercise('focus-block-rollup', 1);
  active.title = 'also mutated';
  assert.equal(getActiveExercise('focus-block-rollup', 1).title, 'Focus Block Roll-up');
});

test('server-side suites require an active question and supported language', () => {
  const javascript = createEvaluationSuite(
    'steady-sensor-windows',
    1,
    'javascript',
    { random: seededRandom(7) },
  );
  const python = createEvaluationSuite(
    'steady-sensor-windows',
    1,
    'python',
    { random: seededRandom(7) },
  );
  assert.equal(javascript?.entrypoint, 'findSteadyWindows');
  assert.equal(python?.entrypoint, 'find_steady_windows');
  assert.equal(javascript?.tests.length, 8);
  assert.deepEqual(javascript?.tests, python?.tests);
  assert.equal(createEvaluationSuite('steady-sensor-windows', undefined, 'javascript')?.version, 1);
  assert.equal(createEvaluationSuite('steady-sensor-windows', null, 'javascript'), null);
  assert.equal(createEvaluationSuite('steady-sensor-windows', 2, 'javascript'), null);
  assert.equal(createEvaluationSuite('steady-sensor-windows', 1, 'ruby'), null);
  assert.equal(createEvaluationSuite('archived-session-streak', 1, 'javascript'), null);
});

test('generated suites are fresh defensive values with reproducible injected randomness', () => {
  const first = createEvaluationSuite(
    'focus-block-rollup',
    1,
    'javascript',
    { random: seededRandom(11) },
  );
  const original = structuredClone(first);
  first.tests[0].id = 'mutated';
  first.tests[0].args.push('mutated');
  const second = createEvaluationSuite(
    'focus-block-rollup',
    1,
    'javascript',
    { random: seededRandom(11) },
  );
  assert.deepEqual(second, original);
  const third = createEvaluationSuite(
    'focus-block-rollup',
    1,
    'javascript',
    { random: seededRandom(12) },
  );
  assert.notDeepEqual(third.tests.map(testCase => testCase.args), second.tests.map(testCase => testCase.args));
});

test('every active exercise generates valid cases with server-computed expectations', () => {
  for (const [exerciseIndex, exercise] of listPublicExercises().entries()) {
    for (const language of SUPPORTED_LANGUAGES) {
      const suite = createEvaluationSuite(
        exercise.slug,
        exercise.version,
        language,
        { random: seededRandom(100 + exerciseIndex) },
      );
      assert.deepEqual(validateEvaluationSuite(suite), { valid: true, testCount: 8 });
      for (const testCase of suite.tests) {
        assert.match(testCase.id, /^generated-[1-8]$/);
        assert.ok(Array.isArray(testCase.args));
        assert.doesNotThrow(() => JSON.stringify(testCase.expected));
      }
    }
  }
});

test('every generator guarantees its required boundary shapes', () => {
  const suites = Object.fromEntries(listPublicExercises().map((exercise, index) => [
    exercise.slug,
    createEvaluationSuite(
      exercise.slug,
      exercise.version,
      'javascript',
      { random: seededRandom(500 + index) },
    ),
  ]));

  const focusCases = suites['focus-block-rollup'].tests;
  assert.ok(focusCases.some(testCase => testCase.args[0].length === 0), 'focus includes empty blocks');
  assert.ok(focusCases.some(testCase => testCase.args[0].length === 1), 'focus includes one block');
  assert.equal(focusCases.at(-1).args[0].length, 10_000, 'focus includes its maximum input length');
  assert.deepEqual(focusCases.at(-1).expected, [{ label: 'f', minutes: 7_205_000 }]);

  const sensorCases = suites['steady-sensor-windows'].tests;
  assert.ok(sensorCases.some(testCase => testCase.args[1] === 1), 'sensor includes width one');
  assert.ok(
    sensorCases.some(testCase => testCase.args[0].length > 1 && testCase.args[1] === testCase.args[0].length),
    'sensor includes a full-length window',
  );
  assert.equal(sensorCases.at(-1).args[0].length, 20_000, 'sensor includes its maximum input length');
  assert.equal(sensorCases.at(-1).args[1], 10_000);
  assert.deepEqual(sensorCases.at(-1).expected, []);

  const graphCases = suites['review-wave-planner'].tests;
  assert.ok(
    graphCases.some(testCase => testCase.args[0].length === 0 && testCase.args[1].length === 0),
    'graph includes empty tasks and dependencies',
  );
  assert.ok(
    graphCases.some(testCase => testCase.args[0].length > 0 && testCase.args[1].length === 0),
    'graph includes independent tasks',
  );
  assert.ok(
    graphCases.some(testCase => graphHasCycle(testCase.args[0], testCase.args[1])),
    'graph includes a dependency cycle',
  );
  assert.equal(graphCases.at(-1).args[0].length, 5_000, 'graph includes its maximum task count');
  assert.equal(graphCases.at(-1).args[1].length, 4_999);
  assert.equal(graphCases.at(-1).expected.length, 2);
  assert.deepEqual(graphCases.at(-1).expected[0], ['t0']);

  const seatCases = suites['workshop-seat-allocation'].tests;
  assert.ok(seatCases.some(testCase => testCase.args[1].length === 0), 'seats include no requests');
  assert.ok(
    seatCases.some(testCase => testCase.args[0] === 0 && testCase.args[1].length > 0),
    'seats include zero capacity with requests',
  );
  assert.equal(seatCases.at(-1).args[1].length, 10_000, 'seats include the maximum request count');
  assert.equal(seatCases.at(-1).expected.accepted.length, 10_000);
  assert.equal(seatCases.at(-1).expected.remaining, 990_000);

  const coverageCases = suites['coverage-gap-finder'].tests;
  assert.ok(coverageCases.some(testCase => testCase.args[2].length === 0), 'coverage includes no shifts');
  assert.ok(coverageCases.some(testCase => testCase.expected.length === 0), 'coverage includes full coverage');
  assert.ok(
    coverageCases.some(testCase => {
      const [dayStart, dayEnd, shifts] = testCase.args;
      return shifts.some(([start, end]) => start < dayStart || end > dayEnd);
    }),
    'coverage includes shifts that require clipping',
  );
  assert.equal(coverageCases.at(-1).args[2].length, 10_000, 'coverage includes the maximum shift count');
  assert.deepEqual(coverageCases.at(-1).expected, []);

  const markerCases=suites['balanced-template-markers'].tests;
  assert.deepEqual(markerCases.slice(0,4).map(testCase=>testCase.expected),[true,true,true,false]);
  assert.match(markerCases[2].args[0], /[([{].*[)\]}]/);
  assert.equal(markerCases.at(-1).args[0].length,20_000);
  assert.equal(markerCases.at(-1).expected,false);

  const capacityCases=suites['capacity-upgrade-index'].tests;
  assert.deepEqual(capacityCases.slice(0,4).map(testCase=>testCase.expected),[-1,1,-1,1]);
  assert.equal(capacityCases.at(-1).args[0].length,20_000);
  assert.equal(capacityCases.at(-1).expected,10_000);

  const handoffCases=suites['shortest-handoff-path'].tests;
  assert.deepEqual(handoffCases.slice(0,4).map(testCase=>testCase.expected),[0,-1,1,2]);
  assert.equal(handoffCases.at(-1).args[0],5_000);
  assert.equal(handoffCases.at(-1).args[1].length,10_000);
  assert.equal(new Set(handoffCases.at(-1).args[1].map(([left,right])=>`${Math.min(left,right)}:${Math.max(left,right)}`)).size,10_000);
  assert.equal(handoffCases.at(-1).expected,1);

  const leaderCases=suites['message-frequency-leaders'].tests;
  assert.deepEqual(leaderCases[1].expected,[{label:'alpha',count:2},{label:'beta',count:2}]);
  assert.deepEqual(leaderCases[3].expected,[{label:'zeta',count:3},{label:'alpha',count:2}]);
  assert.equal(leaderCases.at(-1).args[0].length,20_000);
  assert.equal(leaderCases.at(-1).expected.length,100);
  assert.equal(leaderCases.at(-1).expected.every(item=>item.count===200),true);

  const recoveryCases=suites['recovery-budget-plan'].tests;
  assert.deepEqual(recoveryCases.slice(0,5).map(testCase=>testCase.expected),[0,-1,2,2,-1]);
  assert.equal(recoveryCases.at(-1).args[0].length,50);
  assert.equal(new Set(recoveryCases.at(-1).args[0]).size,50);
  assert.equal(recoveryCases.at(-1).args[1],10_000);
  assert.equal(recoveryCases.at(-1).expected,200);
});

test('new exercise cases defeat representative shortcut solutions',()=>{
  const suites=Object.fromEntries([
    'balanced-template-markers','capacity-upgrade-index','shortest-handoff-path',
    'message-frequency-leaders','recovery-budget-plan',
  ].map((slug,index)=>[slug,createEvaluationSuite(slug,1,'javascript',{random:seededRandom(900+index)})]));

  const markerCase=suites['balanced-template-markers'].tests[3];
  const countOnly=value=>['()','[]','{}'].every(pair=>
    [...value].filter(character=>character===pair[0]).length===[...value].filter(character=>character===pair[1]).length
  );
  assert.notEqual(countOnly(...markerCase.args),markerCase.expected);
  const noMarkersOrMaximum=value=>!/[()[\]{}]/.test(value)||value.length===20_000;
  assert.ok(suites['balanced-template-markers'].tests.some(testCase=>(
    noMarkersOrMaximum(...testCase.args)!==testCase.expected
  )));

  const capacityCase=suites['capacity-upgrade-index'].tests[3];
  assert.notEqual(capacityCase.args[0].indexOf(capacityCase.args[1]),capacityCase.expected);

  const handoffCase=suites['shortest-handoff-path'].tests[3];
  const directOnly=(_count,links,start,target)=>links.some(([left,right])=>left===start&&right===target)?1:-1;
  assert.notEqual(directOnly(...handoffCase.args),handoffCase.expected);

  const leaderCase=suites['message-frequency-leaders'].tests[3];
  const alphabeticalOnly=(labels,threshold)=>{
    const counts=new Map();
    for(const label of labels) counts.set(label,(counts.get(label)||0)+1);
    return [...counts].filter(([,count])=>count>=threshold)
      .map(([label,count])=>({label,count})).sort((left,right)=>left.label.localeCompare(right.label));
  };
  assert.notDeepEqual(alphabeticalOnly(...leaderCase.args),leaderCase.expected);

  const recoveryCase=suites['recovery-budget-plan'].tests[3];
  const greedy=(durations,target)=>{
    let remaining=target;
    let count=0;
    for(const duration of [...durations].sort((left,right)=>right-left)){
      count+=Math.floor(remaining/duration);
      remaining%=duration;
    }
    return remaining===0?count:-1;
  };
  assert.notEqual(greedy(...recoveryCase.args),recoveryCase.expected);
});

test('new generators terminate and remain valid with a constant injected random source',()=>{
  for(const slug of [
    'balanced-template-markers','capacity-upgrade-index','shortest-handoff-path',
    'message-frequency-leaders','recovery-budget-plan',
  ]){
    const suite=createEvaluationSuite(slug,1,'javascript',{random:()=>0.5});
    assert.deepEqual(validateEvaluationSuite(suite),{valid:true,testCount:8});
  }
});

test('scale cases are deterministic and fit conservative runner envelopes', () => {
  const prefix = '__RANDORI_RESULT_0123456789abcdef0123456789abcdef__:';
  for (const exercise of listPublicExercises()) {
    const first = createEvaluationSuite(
      exercise.slug,
      exercise.version,
      'javascript',
      { random: seededRandom(700) },
    );
    const second = createEvaluationSuite(
      exercise.slug,
      exercise.version,
      'javascript',
      { random: seededRandom(701) },
    );
    assert.deepEqual(first.tests.at(-1), second.tests.at(-1), `${exercise.slug} scale case is seed-independent`);
    const runnerBundle = Buffer.from(JSON.stringify({
      entrypoint: first.entrypoint,
      tests: first.tests.map(testCase => ({ args: testCase.args })),
    }), 'utf8').toString('base64');
    assert.ok(
      Buffer.byteLength(runnerBundle, 'utf8') < 512 * 1024,
      `${exercise.slug} encoded runner bundle remains below the conservative request budget`,
    );
    const stdout = first.tests.map((testCase, index) => (
      prefix + JSON.stringify({ idx: index, ok: true, got: testCase.expected, error: null })
    )).join('\n') + '\n';
    assert.ok(
      Buffer.byteLength(prefix + JSON.stringify({ idx: 7, ok: true, got: first.tests.at(-1).expected, error: null }), 'utf8') < 100_000,
      `${exercise.slug} scale result remains parseable by the runner`,
    );
    assert.ok(
      Buffer.byteLength(JSON.stringify({ run: { stdout, output: stdout, stderr: '' } }), 'utf8') < 240 * 1024,
      `${exercise.slug} successful response stays below the provider response cap`,
    );
  }
});

test('every generator retains randomised non-boundary cases', () => {
  const boundaryCounts = {
    'focus-block-rollup': 2,
    'steady-sensor-windows': 2,
    'review-wave-planner': 3,
    'workshop-seat-allocation': 2,
    'coverage-gap-finder': 3,
    'balanced-template-markers': 4,
    'capacity-upgrade-index': 4,
    'shortest-handoff-path': 4,
    'message-frequency-leaders': 4,
    'recovery-budget-plan': 5,
  };
  for (const exercise of listPublicExercises()) {
    const first = createEvaluationSuite(
      exercise.slug,
      exercise.version,
      'javascript',
      { random: seededRandom(800) },
    );
    const second = createEvaluationSuite(
      exercise.slug,
      exercise.version,
      'javascript',
      { random: seededRandom(801) },
    );
    const start = boundaryCounts[exercise.slug];
    assert.notDeepEqual(
      first.tests.slice(start, -1).map(testCase => testCase.args),
      second.tests.slice(start, -1).map(testCase => testCase.args),
      `${exercise.slug} keeps randomised cases after its guaranteed boundaries`,
    );
  }
});

test('injected randomness is validated', () => {
  assert.throws(
    () => createEvaluationSuite('focus-block-rollup', 1, 'javascript', { random: 1 }),
    /random must be a function/,
  );
  assert.throws(
    () => createEvaluationSuite('focus-block-rollup', 1, 'javascript', { random: () => 1 }),
    /random must return a finite number in \[0, 1\)/,
  );
  assert.throws(
    () => createEvaluationSuite('focus-block-rollup', 1, 'javascript', null),
    /options must be an object/,
  );
});

test('validation rejects duplicate slug and version records', () => {
  const catalog = freshCatalog();
  const duplicate = structuredClone(catalog.exercises[0]);
  catalog.exercises.push(duplicate);
  assertCatalogError(() => validateCatalog(catalog), /duplicates another exercise slug and version/);
});

test('validation permits retired history but only one active version per slug', () => {
  const historical = freshCatalog();
  const retired = structuredClone(historical.exercises[0]);
  retired.version = 2;
  retired.status = 'retired';
  retired.governance.retirement = {
    status: 'retired',
    retiredAt: '2026-09-18',
    reason: 'Superseded by the current reviewed version.',
    replacement: 'focus-block-rollup',
  };
  historical.exercises.push(retired);
  const historicalProvenance = freshProvenance();
  const retiredProvenance = structuredClone(historicalProvenance.records[0]);
  retiredProvenance.key = 'focus-block-rollup@2';
  retiredProvenance.version = 2;
  retiredProvenance.source.reference = 'repository://data/randori-catalog-v1.json#focus-block-rollup@2';
  retiredProvenance.contentHash = canonicalExerciseHash(retired);
  historicalProvenance.records.push(retiredProvenance);
  assert.equal(validateCatalog(historical, undefined, historicalProvenance).valid, true);

  const twoActive = freshCatalog();
  const nextActive = structuredClone(twoActive.exercises[0]);
  nextActive.version = 2;
  twoActive.exercises.push(nextActive);
  assertCatalogError(() => validateCatalog(twoActive), /only one version of a slug may be active/);
});

test('validation requires rights, provenance, review date, and attribution', () => {
  for (const field of ['rightsOwner', 'provenance', 'reviewDate', 'attribution']) {
    const catalog = freshCatalog();
    delete catalog.exercises[0].governance[field];
    assertCatalogError(() => validateCatalog(catalog), new RegExp(`${field}: is required`));
  }

  const badDate = freshCatalog();
  badDate.exercises[0].governance.reviewDate = '2026-02-30';
  assertCatalogError(() => validateCatalog(badDate), /reviewDate: must be a real calendar date/);
});

test('validation rejects unsupported or incomplete language definitions', () => {
  const extraLanguage = freshCatalog();
  extraLanguage.exercises[0].languages.ruby = {
    entrypoint: 'roll_up_focus_blocks',
    signature: 'def roll_up_focus_blocks(blocks)',
    starter: 'def roll_up_focus_blocks(blocks)\nend',
  };
  assertCatalogError(() => validateCatalog(extraLanguage), /languages\.ruby: is not an allowed field/);

  const missingLanguage = freshCatalog();
  delete missingLanguage.exercises[0].languages.python;
  assertCatalogError(() => validateCatalog(missingLanguage), /languages\.python: is required/);

  const invalidIdentifier = freshCatalog();
  invalidIdentifier.exercises[0].languages.javascript.entrypoint = 'bad-entrypoint';
  assertCatalogError(() => validateCatalog(invalidIdentifier), /not a valid javascript identifier/);
});

test('validation binds every generated suite to its public entrypoint', () => {
  const suite = createEvaluationSuite(
    'focus-block-rollup',
    1,
    'javascript',
    { random: seededRandom(20) },
  );
  suite.entrypoint = 'someOtherFunction';
  assertCatalogError(() => validateEvaluationSuite(suite), /must match the public language entrypoint/);
});

test('validation rejects malformed and duplicate server-owned cases', () => {
  const makeSuite = () => createEvaluationSuite(
    'focus-block-rollup',
    1,
    'javascript',
    { random: seededRandom(30) },
  );
  const badArgs = makeSuite();
  badArgs.tests[0].args = 'not-an-array';
  assertCatalogError(() => validateEvaluationSuite(badArgs), /args: must be an argument array/);

  const missingExpected = makeSuite();
  delete missingExpected.tests[0].expected;
  assertCatalogError(() => validateEvaluationSuite(missingExpected), /expected: is required/);

  const duplicateId = makeSuite();
  duplicateId.tests[1].id = duplicateId.tests[0].id;
  assertCatalogError(() => validateEvaluationSuite(duplicateId), /must be unique within the suite/);

  const nonJson = makeSuite();
  nonJson.tests[0].expected = Number.NaN;
  assertCatalogError(() => validateEvaluationSuite(nonJson), /finite JSON numbers/);
});

test('validation requires one server generator for each active slug and version', () => {
  const missing = freshCatalog();
  const definitions = runtimeDefinitionsFor(missing);
  delete definitions['focus-block-rollup@1'];
  assertCatalogError(() => validateCatalog(missing, definitions), /missing a generator for focus-block-rollup@1/);

  const invalid = freshCatalog();
  const invalidDefinitions = runtimeDefinitionsFor(invalid);
  invalidDefinitions['focus-block-rollup@1'].oracle = 'not-a-function';
  assertCatalogError(() => validateCatalog(invalid, invalidDefinitions), /oracle: must be a function/);
});

test('validation makes retirement an execution boundary', () => {
  assert.equal(
    createEvaluationSuite('archived-session-streak', 1, 'javascript', { random: seededRandom(40) }),
    null,
  );

  const retiredDefinition = freshCatalog();
  const definitions = runtimeDefinitionsFor(retiredDefinition);
  definitions['archived-session-streak@1'] = {
    generateArgs() { return [[]]; },
    oracle() { return 0; },
  };
  assert.equal(validateCatalog(retiredDefinition, definitions).valid, true);

  const missingReason = freshCatalog();
  missingReason.exercises.at(-1).governance.retirement.reason = null;
  assertCatalogError(() => validateCatalog(missingReason), /reason: must be a non-empty string/);

  const activeWithRetirement = freshCatalog();
  activeWithRetirement.exercises[0].governance.retirement.retiredAt = '2026-09-18';
  assertCatalogError(() => validateCatalog(activeWithRetirement), /active exercises cannot have retirement details/);
});

test('validation enforces coherent takedown metadata', () => {
  const unexpectedDetails = freshCatalog();
  unexpectedDetails.exercises[0].governance.takedown.reference = 'issue-123';
  assertCatalogError(() => validateCatalog(unexpectedDetails), /none takedown must not contain request details/);

  const missingRequestDate = freshCatalog();
  missingRequestDate.exercises[0].governance.takedown = {
    status: 'requested',
    requestedAt: null,
    reference: 'issue-123',
  };
  assertCatalogError(() => validateCatalog(missingRequestDate), /requestedAt: must use YYYY-MM-DD format/);

  const activeRequest = freshCatalog();
  activeRequest.exercises[0].governance.takedown = {
    status: 'requested',
    requestedAt: '2026-09-18',
    reference: 'issue-123',
  };
  assertCatalogError(() => validateCatalog(activeRequest), /under takedown must be retired/);

  const coherentRequest = freshCatalog();
  coherentRequest.exercises.at(-1).governance.takedown = {
    status: 'requested',
    requestedAt: '2026-09-18',
    reference: 'issue-123',
  };
  const coherentProvenance = freshProvenance();
  coherentProvenance.records.at(-1).takedown = {
    status: 'requested',
    effectiveAt: '2026-09-18',
    reference: 'issue-123',
  };
  assert.equal(validateCatalog(coherentRequest, undefined, coherentProvenance).valid, true);

  const futureRetirement = freshCatalog();
  futureRetirement.exercises.at(-1).governance.retirement.retiredAt = '2026-09-20';
  assertCatalogError(
    () => validateCatalog(futureRetirement, undefined, freshProvenance(), { now: '2026-09-19' }),
    /retiredAt: must not be in the future/,
  );

  const futureTakedown = freshCatalog();
  futureTakedown.exercises.at(-1).governance.takedown = {
    status: 'revoked', requestedAt: '2026-09-20', reference: 'issue-123',
  };
  const futureTakedownProvenance = freshProvenance();
  futureTakedownProvenance.records.at(-1).takedown = {
    status: 'revoked', effectiveAt: '2026-09-20', reference: 'issue-123',
  };
  assertCatalogError(
    () => validateCatalog(futureTakedown, undefined, futureTakedownProvenance, { now: '2026-09-19' }),
    /requestedAt: must not be in the future/,
  );
});

test('validation requires retirement replacements to resolve to a known historical slug', () => {
  const unknown = freshCatalog();
  unknown.exercises.at(-1).governance.retirement.replacement = 'missing-exercise';
  assertCatalogError(() => validateCatalog(unknown), /must reference a known catalogue slug/);

  const retiredOnly = freshCatalog();
  retiredOnly.exercises.at(-1).governance.retirement.replacement = 'archived-session-streak';
  assert.equal(validateCatalog(retiredOnly).valid, true);
});

test('validation rejects private or unknown fields in public exercise records', () => {
  const catalog = freshCatalog();
  catalog.exercises[0].evaluationCases = [];
  assertCatalogError(() => validateCatalog(catalog), /evaluationCases: is not an allowed field/);
});

test('validation rejects runtime definitions for unknown exercises and unsupported schemas', () => {
  const unknown = freshCatalog();
  const definitions = runtimeDefinitionsFor(unknown);
  definitions['not-in-catalogue@1'] = {
    generateArgs() { return [[]]; },
    oracle() { return null; },
  };
  assertCatalogError(() => validateCatalog(unknown, definitions), /does not match an exercise slug and version/);

  const schema = freshCatalog();
  schema.schemaVersion = 2;
  assertCatalogError(() => validateCatalog(schema), /schemaVersion: must equal 1/);
});
