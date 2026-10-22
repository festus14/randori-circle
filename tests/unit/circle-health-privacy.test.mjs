// Issue #292 privacy property: for small cycles, enumerate every state of
// every pair (agreed a time, completed, repeat) and check that no hidden cell
// in the circle health response can be worked out from the rest of the
// response. Runs the production aggregation and suppression code.
//
// Two world models are checked:
// - independent: any pair may agree, complete, both or neither (the product
//   allows completing without an agreed time);
// - implied: an owner who assumes completed pairs also agreed a time.
// Compositions include a legacy triad and a solo member. Current pairing
// never produces triads; legacy weeks can contain them.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { aggregateCycle, pairKeys, suppressCycleMetrics } from '../../api/_circle-health.js';

const MODELS = Object.freeze({
  independent: [[0, 0], [0, 1], [1, 0], [1, 1]],
  implied: [[0, 0], [1, 0], [1, 1]],
});
const PRIVATE = [
  ['scheduled_pairs', 'scheduledPairs', 0],
  ['completed_pairs', 'completedPairs', 1],
  ['repeat_pair_percent', 'repeatPairs', 2],
];

function cellKey(cell) {
  return `${cell.status}:${cell.value}`;
}

/** Every world for one cycle shape, with the response each world produces. */
function enumerate(pairs, { model, tracked, triad = false, solo = false }) {
  const base = tracked ? MODELS[model] : [[0, 0], [1, 0]];
  const states = base.flatMap(([s, c]) => [[s, c, 0], [s, c, 1]]);
  let next = 1;
  const memberSets = [];
  for (let index = 0; index < pairs; index += 1) {
    const size = triad && index === 0 ? 3 : 2;
    memberSets.push(Array.from({ length: size }, () => String(next++)));
  }
  const soloGroup = solo ? { members: [String(next)], solo: true, scheduled: false, completed: false } : null;
  const groupFor = memberSets.map(members => states.map(([s, c]) => ({ members, solo: false, scheduled: s === 1, completed: c === 1 })));
  const lookbackFor = Array.from({ length: 2 ** pairs }, (_, mask) => new Set(memberSets
    .filter((_, index) => mask & (1 << index)).flatMap(members => pairKeys({ members }))));
  const worlds = [];
  const total = states.length ** pairs;
  for (let world = 0; world < total; world += 1) {
    let rest = world;
    let mask = 0;
    const picked = [];
    const groups = [];
    for (let index = 0; index < pairs; index += 1) {
      const stateIndex = rest % states.length;
      rest = Math.floor(rest / states.length);
      picked.push(states[stateIndex]);
      groups.push(groupFor[index][stateIndex]);
      if (states[stateIndex][2]) mask |= 1 << index;
    }
    if (soloGroup) groups.push(soloGroup);
    const raw = aggregateCycle({ availableMembers: [], groups }, lookbackFor[mask], { completionTracked: tracked });
    const metrics = suppressCycleMetrics(raw, { completionTracked: tracked });
    const key = Object.values(metrics).map(cellKey).join('|');
    worlds.push({ states: picked, raw, metrics, key });
  }
  return worlds;
}

/** Hidden cells whose true count is the same in every world with that response. */
function recoverableHiddenCells(worlds) {
  const views = new Map();
  for (const world of worlds) {
    if (!views.has(world.key)) views.set(world.key, { metrics: world.metrics, counts: PRIVATE.map(() => new Set()) });
    PRIVATE.forEach(([, rawKey], index) => views.get(world.key).counts[index].add(world.raw[rawKey]));
  }
  let hidden = 0;
  const recovered = [];
  for (const view of views.values()) {
    PRIVATE.forEach(([metric], index) => {
      if (view.metrics[metric].status !== 'suppressed') return;
      hidden += 1;
      if (view.counts[index].size < 2) recovered.push({ metric, value: [...view.counts[index]][0] });
    });
  }
  return { views: views.size, hidden, recovered };
}

/**
 * An owner also knows their own pair's state. Count (world, owner, other pair,
 * attribute) cases where that pair's attribute is then determined, and check
 * each one is explained by a shown count of 0 or "every pair".
 */
function ownerInference(worlds, pairs, tracked) {
  const attributes = tracked ? [0, 1, 2] : [0, 2];
  const seen = new Map();
  const groupKey = (world, owner) => `${world.key}#${owner}#${world.states[owner].join('')}`;
  for (const world of worlds) {
    for (let owner = 0; owner < pairs; owner += 1) {
      const key = groupKey(world, owner);
      if (!seen.has(key)) seen.set(key, new Uint8Array(pairs * 3));
      const masks = seen.get(key);
      for (let other = 0; other < pairs; other += 1) {
        for (const attribute of attributes) masks[other * 3 + attribute] |= 1 << world.states[other][attribute];
      }
    }
  }
  let cases = 0;
  let determined = 0;
  const unexplained = [];
  for (const world of worlds) {
    for (let owner = 0; owner < pairs; owner += 1) {
      const masks = seen.get(groupKey(world, owner));
      for (let other = 0; other < pairs; other += 1) {
        if (other === owner) continue;
        for (const attribute of attributes) {
          cases += 1;
          const mask = masks[other * 3 + attribute];
          if (mask === 3) continue;
          determined += 1;
          const [metric, rawKey] = PRIVATE[attribute];
          const count = world.raw[rawKey];
          if (!(world.metrics[metric].status === 'ok' && (count === 0 || count === pairs))) unexplained.push({ metric, count });
        }
      }
    }
  }
  return { cases, determined, unexplained };
}

const SHAPES = [
  { model: 'independent', tracked: true },
  { model: 'implied', tracked: true },
  { model: 'independent', tracked: false },
];

test('no hidden cell can be recovered from the response for 1-6 pairs, in either world model', t => {
  let totalHidden = 0;
  for (let pairs = 1; pairs <= 6; pairs += 1) {
    for (const shape of SHAPES) {
      for (const composition of [{}, { triad: true, solo: true }]) {
        const worlds = enumerate(pairs, { ...shape, ...composition });
        const result = recoverableHiddenCells(worlds);
        const label = `${pairs} pairs ${JSON.stringify({ ...shape, ...composition })}`;
        assert.deepEqual(result.recovered, [], label);
        totalHidden += result.hidden;
        if (!composition.triad) {
          t.diagnostic(`${label}: ${worlds.length} worlds, ${result.views} distinct responses, `
            + `${result.hidden} hidden cells, ${result.recovered.length} recoverable`);
        }
      }
    }
  }
  assert.ok(totalHidden > 0);
});

test('with one or two pairs, agreed, completed and repeat are hidden in every state', () => {
  for (const pairs of [1, 2]) {
    for (const world of enumerate(pairs, { model: 'independent', tracked: true })) {
      for (const [metric] of PRIVATE) assert.equal(world.metrics[metric].status, 'suppressed', `${pairs} pairs ${metric}`);
      assert.deepEqual(world.metrics.pairs, { status: 'ok', value: pairs });
    }
  }
});

test('the owner learns another pair\'s state only from a shown 0 or "every pair"', t => {
  for (let pairs = 2; pairs <= 6; pairs += 1) {
    for (const shape of SHAPES) {
      const worlds = enumerate(pairs, shape);
      const result = ownerInference(worlds, pairs, shape.tracked);
      assert.deepEqual(result.unexplained, [], `${pairs} pairs ${JSON.stringify(shape)}`);
      t.diagnostic(`${pairs} pairs ${JSON.stringify(shape)}: another pair's attribute determined in `
        + `${(100 * result.determined / result.cases).toFixed(1)}% of cases, all by a unanimous count`);
    }
  }
});
