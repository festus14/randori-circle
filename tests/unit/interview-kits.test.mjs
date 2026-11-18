import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';

import catalog from '../../data/randori-catalog-v1.json' with { type: 'json' };
import manifest from '../../data/randori-catalog-provenance-v1.json' with { type: 'json' };
import { createEvaluationSuite, getPublicExercise, listPublicExercises, validateCatalog, validateEvaluationSuite } from '../../api/_catalog.js';
import { INTERVIEW_KIT_DEFINITIONS } from '../../api/_catalog-interview-kits.js';
import { canonicalExerciseHash } from '../../api/_catalog-provenance.js';
import { applyTakedown } from '../../scripts/catalog-provenance.mjs';
import { seededKitRandom, runReferenceProgram, validateInterviewKitReferences } from '../../scripts/validate-interview-kits.mjs';

const keys = Object.keys(INTERVIEW_KIT_DEFINITIONS);
const fresh = () => ({ catalog: structuredClone(catalog), manifest: structuredClone(manifest) });
const suite = (key, seed = 469, language = 'javascript') => createEvaluationSuite(key.split('@')[0], 1, language, { random: seededKitRandom(seed) });

function forbiddenKeys(value) {
  if (!value || typeof value !== 'object') return [];
  return Object.entries(value).flatMap(([key, child]) => [
    ...(/^(?:tests?|args|expected|oracle|generateArgs|exerciseKeys|reference|evidence|reviewer|takedown|retirement)$/.test(key) ? [key] : []),
    ...forbiddenKeys(child),
  ]);
}

test('two distinct interview tracks each add four original exercises across all difficulty tiers', () => {
  assert.equal(catalog.schemaVersion, 2);
  assert.equal(catalog.kits.length, 2);
  assert.deepEqual(catalog.kits.map(kit => kit.track), ['backend', 'frontend']);
  assert.equal(keys.length, 8);
  for (const kit of catalog.kits) {
    const added = kit.exerciseKeys.filter(key => keys.includes(key));
    assert.equal(added.length, 4);
    const difficulties = added.map(key => getPublicExercise(key.split('@')[0], 1).difficulty);
    assert.deepEqual(difficulties, kit.track === 'backend' ? ['Easy', 'Medium', 'Medium', 'Hard'] : ['Easy', 'Easy', 'Medium', 'Hard']);
    assert.equal(kit.exerciseKeys.length, 7, 'three existing exercises also belong to each kit');
  }
  for (const key of keys) {
    const exercise = catalog.exercises.find(e => `${e.slug}@${e.version}` === key);
    const provenance = manifest.records.find(record => record.key === key);
    assert.equal(exercise.status, 'active');
    assert.ok(exercise.prompt.length > 180);
    assert.ok(exercise.constraints.length >= 3);
    assert.equal(exercise.examples.length, 2);
    assert.equal(provenance.source.type, 'original');
    assert.equal(provenance.author.name, 'Randori Circle project contributors');
    assert.equal(provenance.license.identifier, 'LicenseRef-Randori-Original');
    assert.equal(provenance.review.reviewedAt, '2026-11-18');
    assert.equal(provenance.review.expiresAt, '2027-11-18');
    assert.equal(provenance.contentHash, canonicalExerciseHash(exercise));
  }
});

test('kit public projections include only display metadata and are defensive on list and detail', () => {
  for (const key of keys) {
    const question = getPublicExercise(key.split('@')[0], 1);
    assert.equal(question.kits.length, 1);
    assert.deepEqual(Object.keys(question.kits[0]).sort(), ['id', 'title', 'track']);
    assert.deepEqual(forbiddenKeys(question), []);
    question.kits[0].title = 'mutated';
    question.kits.push({ id: 'injected' });
    assert.equal(getPublicExercise(question.slug, 1).kits.length, 1);
    assert.notEqual(getPublicExercise(question.slug, 1).kits[0].title, 'mutated');
  }
  const listed = listPublicExercises();
  assert.equal(listed.filter(q => q.kits.length).length, 14);
  listed.find(q => q.slug === 'release-feed-merge').kits[0].track = 'mutated';
  assert.equal(getPublicExercise('release-feed-merge', 1).kits[0].track, 'backend');
  assert.deepEqual(getPublicExercise('focus-block-rollup', 1).kits, []);
});

test('strict kit validation rejects malformed, duplicate, unbounded and unversioned membership', () => {
  const mutations = [
    [c => { delete c.kits; }, /kits: is required/],
    [c => { c.kits = {}; }, /must be an array/],
    [c => { c.kits = Array(17).fill(c.kits[0]); }, /at most 16 kits/],
    [c => { c.kits[0].private = []; }, /private: is not an allowed field/],
    [c => { c.kits[0].id = 'all'; }, /id: must be a kebab-case/],
    [c => { c.kits[0].track = 'Front End'; }, /track: must be a kebab-case/],
    [c => { c.kits[0].title = '<script>'; }, /plain single-line text/],
    [c => { c.kits[0].description = 'x'.repeat(301); }, /at most 300/],
    [c => { c.kits[0].description = 'two\nlines'; }, /plain single-line text/],
    [c => { c.kits.push(structuredClone(c.kits[0])); }, /id: must be unique/],
    [c => { c.kits[0].exerciseKeys.push(c.kits[0].exerciseKeys[0]); }, /must be unique/],
    [c => { c.kits[0].exerciseKeys = []; }, /at least 1 item/],
    [c => { c.kits[0].exerciseKeys = ['delivery-receipt-ledger']; }, /exact known exercise/],
    [c => { c.kits[0].exerciseKeys = ['delivery-receipt-ledger@2']; }, /exact known exercise/],
  ];
  for (const [mutate, pattern] of mutations) {
    const pair = fresh();
    mutate(pair.catalog);
    assert.throws(() => validateCatalog(pair.catalog, undefined, pair.manifest), pattern);
  }
  const legacy = fresh();
  legacy.catalog.schemaVersion = 1;
  delete legacy.catalog.kits;
  assert.equal(validateCatalog(legacy.catalog, undefined, legacy.manifest).valid, true);
});

test('kit membership edits do not rehash or change original exercise content', () => {
  const pair = fresh();
  const originalHashes = pair.catalog.exercises.map(canonicalExerciseHash);
  pair.catalog.kits[0].exerciseKeys.push('focus-block-rollup@1');
  assert.equal(validateCatalog(pair.catalog, undefined, pair.manifest).valid, true);
  assert.deepEqual(pair.catalog.exercises.map(canonicalExerciseHash), originalHashes);
});

const independent = {
  'delivery-receipt-ledger@1': receipts => {
    const counted = receipts.filter((r, index) => receipts.findIndex(other => other.id === r.id) === index);
    return [...new Set(counted.map(r => r.destination))].sort().map(destination => ({
      destination, units: counted.filter(r => r.destination === destination).reduce((sum, r) => sum + r.units, 0),
    }));
  },
  'shard-window-audit@1': (events, queries) => queries.map(([shard, start, end]) => events
    .filter(([s, time]) => s === shard && start <= time && time < end).reduce((sum, [, , delta]) => sum + delta, 0)),
  'retry-credit-rounds@1': (lanes, slots) => {
    const ids = lanes.map(lane => lane.id).sort();
    const states = new Map(lanes.map(lane => [lane.id, { ...lane, queue: [...lane.charges], credit: 0, last: -1 }]));
    const result = [];
    let round = 0;
    while ([...states.values()].some(lane => lane.queue.length)) {
      round += 1;
      for (const lane of states.values()) lane.credit = Math.min(lane.cap, lane.credit + lane.refill);
      const pivot = (round - 1) % ids.length;
      const visits = [...ids.slice(pivot), ...ids.slice(0, pivot)];
      let available = slots;
      for (const id of visits) {
        const lane = states.get(id);
        if (!available) break;
        if (!lane.queue.length || lane.last === round - 1 || lane.credit < lane.queue[0]) continue;
        result.push({ round, lane: id, job: lane.charges.length - lane.queue.length });
        lane.credit -= lane.queue.shift();
        lane.last = round;
        available -= 1;
      }
    }
    return result;
  },
  'shard-fence-planner@1': (events, batches, fee) => {
    const visit = (start, left) => {
      if (!left) return start === events.length ? 0 : Infinity;
      let best = Infinity;
      for (let end = start + 1; end <= events.length; end += 1) {
        const segment = events.slice(start, end);
        const cost = Math.max(...segment.map(e => e[1])) + new Set(segment.map(e => e[0])).size * fee;
        best = Math.min(best, cost + visit(end, left - 1));
      }
      return best;
    };
    const result = visit(0, batches);
    return Number.isFinite(result) ? result : -1;
  },
  'panel-notice-counters@1': events => [...new Set(events.map(e => e[0]))].sort().flatMap(panel => {
    const matching = events.filter(e => e[0] === panel);
    const lastRead = matching.findLastIndex(e => e[1] === 'read');
    const unread = matching.length - lastRead - 1;
    return unread ? [{ panel, unread }] : [];
  }),
  'draft-revision-fold@1': updates => [...new Set(updates.map(u => u.id))].sort().flatMap(id => {
    const revision = Math.max(...updates.filter(u => u.id === id).map(u => u.revision));
    const chosen = updates.find(u => u.id === id && u.revision === revision);
    return chosen.text === null ? [] : [chosen];
  }),
  'viewport-anchor-walk@1': (heights, commands) => {
    const sizes = [...heights];
    let anchor = [0, 0];
    return commands.map(command => {
      if (command[0] === 'resize') {
        sizes[command[1]] = command[2];
        anchor = [anchor[0], Math.min(anchor[1], sizes[anchor[0]] - 1)];
      } else {
        const pixels = sizes.flatMap((size, panel) => Array.from({ length: size }, (_, inset) => [panel, inset]));
        anchor = pixels[Math.max(0, Math.min(command[1], pixels.length - 1))];
      }
      return anchor;
    });
  },
  // Direct graph product-state search, not the oracle's metric closure/DP.
  'focus-shortcut-tour@1': (count, edges, required) => {
    const bit = panel => {
      const index = required.indexOf(panel);
      return index < 0 ? 0 : 1 << index;
    };
    const queue = [[0, 0, bit(0)]];
    const best = new Map([[`0:${bit(0)}`, 0]]);
    while (queue.length) {
      queue.sort((a, b) => a[0] - b[0]);
      const [cost, panel, mask] = queue.shift();
      if (cost !== best.get(`${panel}:${mask}`)) continue;
      if (panel === count - 1 && mask === (1 << required.length) - 1) return cost;
      for (const [from, to, effort] of edges) {
        if (from !== panel) continue;
        const nextMask = mask | bit(to), nextCost = cost + effort, key = `${to}:${nextMask}`;
        if (nextCost < (best.get(key) ?? Infinity)) {
          best.set(key, nextCost);
          queue.push([nextCost, to, nextMask]);
        }
      }
    }
    return -1;
  },
};

test('every kit generator has equivalent JS/Python cases, independent edge checks and fresh random cases', () => {
  for (const key of keys) {
    for (const seed of [1, 17, 469, 4_294_967_295]) {
      const generated = suite(key, seed);
      assert.deepEqual(generated.tests, suite(key, seed, 'python').tests);
      assert.deepEqual(validateEvaluationSuite(generated), { valid: true, testCount: 8 });
      for (const c of generated.tests.slice(0, -1)) assert.deepEqual(independent[key](...structuredClone(c.args)), c.expected, `${key} seed ${seed} ${c.id}`);
    }
    assert.deepEqual(suite(key, 1).tests.at(-1), suite(key, 2).tests.at(-1));
    assert.notDeepEqual(suite(key, 1).tests.slice(4, -1), suite(key, 2).tests.slice(4, -1));
    const constant = createEvaluationSuite(key.split('@')[0], 1, 'javascript', { random: () => 0.5 });
    assert.equal(validateEvaluationSuite(constant).valid, true);
    assert.throws(() => createEvaluationSuite(key.split('@')[0], 1, 'javascript', { random: () => 1 }), /random must return/);
  }
});

test('kit upper-bound cases and guaranteed traps have known expected answers', () => {
  const tests = Object.fromEntries(keys.map(key => [key.split('@')[0], suite(key).tests]));
  assert.deepEqual(tests['delivery-receipt-ledger'][2].expected, [{ destination: 'amber', units: 3 }, { destination: 'zinc', units: 7 }]);
  assert.deepEqual(tests['delivery-receipt-ledger'][7].expected, Array.from({ length: 5 }, (_, i) => ({ destination: `d${i}`, units: 200_000 })));
  assert.deepEqual(tests['shard-window-audit'][1].expected, [5, 0, 3, 0]);
  assert.equal(tests['shard-window-audit'][7].args[0].length, 2000);
  assert.deepEqual(tests['shard-window-audit'][7].expected, Array.from({ length: 2000 }, (_, i) => i % 2 ? 1000 : 0));
  assert.deepEqual(tests['retry-credit-rounds'][1].expected, [{ round: 3, lane: 'only', job: 0 }, { round: 5, lane: 'only', job: 1 }, { round: 7, lane: 'only', job: 2 }]);
  assert.deepEqual(tests['retry-credit-rounds'][2].expected, [{ round: 1, lane: 'amber', job: 0 }, { round: 2, lane: 'blue', job: 0 }, { round: 3, lane: 'amber', job: 1 }, { round: 4, lane: 'blue', job: 1 }]);
  assert.deepEqual(tests['retry-credit-rounds'][3].expected, [{ round: 1, lane: 'a', job: 0 }, { round: 3, lane: 'a', job: 1 }, { round: 4, lane: 'b', job: 0 }, { round: 5, lane: 'a', job: 2 }, { round: 7, lane: 'a', job: 3 }, { round: 8, lane: 'b', job: 1 }, { round: 9, lane: 'a', job: 4 }]);
  assert.equal(tests['retry-credit-rounds'][7].args[0].length, 16);
  assert.deepEqual(tests['retry-credit-rounds'][7].expected, Array.from({ length: 200 }, (_, i) => ({ round: (i + 1) * 100, lane: 'l15', job: i })));
  assert.deepEqual(tests['shard-fence-planner'].slice(0, 4).map(c => c.expected), [0, -1, 23, -1]);
  assert.equal(tests['shard-fence-planner'][7].args[0].length, 180);
  assert.equal(tests['shard-fence-planner'][7].expected, 248);
  assert.deepEqual(tests['panel-notice-counters'][7].expected, Array.from({ length: 5 }, (_, i) => ({ panel: `p${i}`, unread: 400 })));
  assert.deepEqual(tests['draft-revision-fold'][2].expected, [{ id: 'b', revision: 1, text: 'first' }]);
  assert.deepEqual(tests['draft-revision-fold'][7].expected, []);
  assert.deepEqual(tests['viewport-anchor-walk'][1].expected, [[1, 0], [1, 0], [0, 0], [1, 3]]);
  assert.deepEqual(tests['viewport-anchor-walk'][7].expected, Array.from({ length: 400 }, (_, i) => [i, 0]));
  assert.deepEqual(tests['focus-shortcut-tour'].slice(0, 4).map(c => c.expected), [0, -1, 4, 2]);
  assert.equal(tests['focus-shortcut-tour'][4].expected, 4, 'the cheaper duplicate arriving second must replace the first edge');
  assert.equal(tests['focus-shortcut-tour'][7].args[0], 40);
  assert.equal(tests['focus-shortcut-tour'][7].args[2].length, 10);
  assert.equal(tests['focus-shortcut-tour'][7].expected, 39);
});

test('all kit reference oracles pass all generated cases and public examples in both production harnesses', () => {
  for (const seed of [1, 17, 469]) assert.deepEqual(validateInterviewKitReferences(catalog, { seed }), { exerciseCount: 8, caseCount: 160 });
  assert.throws(() => validateInterviewKitReferences(catalog, { runProgram: () => '' }), /reference failed cases/);
  const changed = structuredClone(catalog);
  changed.exercises.find(e => e.slug === 'delivery-receipt-ledger').examples[0].output = [];
  assert.throws(() => validateInterviewKitReferences(changed), /Public example disagrees/);
});

async function withRuntime(pair, check) {
  const root = await mkdtemp(join(tmpdir(), 'randori-kits-runtime-'));
  try {
    await mkdir(join(root, 'api'));
    await mkdir(join(root, 'data'));
    await writeFile(join(root, 'package.json'), '{"type":"module"}');
    for (const file of ['_catalog.js', '_catalog-provenance.js', '_catalog-interview-kits.js', '_catalog-random.js']) {
      await copyFile(new URL(`../../api/${file}`, import.meta.url), join(root, 'api', file));
    }
    await writeFile(join(root, 'data/randori-catalog-v1.json'), JSON.stringify(pair.catalog));
    await writeFile(join(root, 'data/randori-catalog-provenance-v1.json'), JSON.stringify(pair.manifest));
    check(pathToFileURL(join(root, 'api/_catalog.js')).href);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test('review expiry on new content fails closed after a warm runtime crosses the UTC date', async () => {
  const pair = fresh();
  pair.manifest.records.find(r => r.key === keys[0]).review.expiresAt = '2026-11-18';
  assert.equal(validateCatalog(pair.catalog, undefined, pair.manifest, { now: '2026-11-18' }).valid, true);
  assert.throws(() => validateCatalog(pair.catalog, undefined, pair.manifest, { now: '2026-11-19' }), /expired before 2026-11-19/);
  await withRuntime(pair, url => {
    execFileSync(process.execPath, ['--input-type=module', '-e', `
      import assert from 'node:assert/strict';
      const RealDate = Date;
      let clock = '2026-11-18T12:00:00Z';
      globalThis.Date = class extends RealDate { constructor(...args) { super(...(args.length ? args : [clock])); } };
      const api = await import(${JSON.stringify(url)});
      assert.ok(api.getPublicExercise('delivery-receipt-ledger', 1));
      const suite = api.createEvaluationSuite('delivery-receipt-ledger', 1, 'javascript');
      clock = '2026-11-19T00:00:00Z';
      for (const operation of [() => api.listPublicExercises(), () => api.getPublicExercise('delivery-receipt-ledger', 1),
        () => api.getActiveExercise('delivery-receipt-ledger', 1), () => api.createEvaluationSuite('delivery-receipt-ledger', 1, 'python'),
        () => api.validateEvaluationSuite(suite)]) assert.throws(operation, /expired before 2026-11-19/);
    `], { timeout: 10_000 });
  });
});

test('each new exercise can be revoked without removing kit history, hashes or other kit members', async () => {
  let pair = fresh();
  for (const key of keys) {
    const result = applyTakedown(pair.catalog, pair.manifest, {
      slug: key.split('@')[0], version: 1, reference: 'issue-469-review', date: '2026-11-18', reason: 'Test-only content review.', now: '2026-11-18',
    });
    assert.equal(result.changed, true);
    assert.deepEqual(result.catalog.kits, catalog.kits);
    assert.equal(result.manifest.records.find(r => r.key === key).contentHash, manifest.records.find(r => r.key === key).contentHash);
    pair = { catalog: result.catalog, manifest: result.manifest };
  }
  await withRuntime(pair, url => {
    execFileSync(process.execPath, ['--input-type=module', '-e', `
      import assert from 'node:assert/strict';
      const api = await import(${JSON.stringify(url)});
      assert.equal(api.listPublicExercises().length, 19);
      for (const key of ${JSON.stringify(keys)}) {
        const slug = key.split('@')[0];
        assert.equal(api.getPublicExercise(slug, 1), null);
        assert.equal(api.getActiveExercise(slug, 1), null);
        for (const lang of ['javascript', 'python']) assert.equal(api.createEvaluationSuite(slug, 1, lang), null);
      }
      assert.equal(api.getPublicExercise('release-feed-merge', 1).kits[0].id, 'backend-data-processing');
    `], { timeout: 10_000 });
  });
});
