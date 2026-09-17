import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  buildFairPairing,
  canonicalRoomId,
  escapeHtml,
  pairKey,
  seededShuffle,
} from '../../api/_pairing.js';

const people = [
  { id: 1, name: 'Ada' },
  { id: 2, name: 'Grace' },
  { id: 3, name: 'Linus' },
  { id: 4, name: 'Margaret' },
];

function normalizedPairs(result) {
  return result.pairs.map(pair => pairKey(pair.a.id, pair.b?.id || pair.a.id)).sort();
}

test('seeded pairing is deterministic and independent of input order', () => {
  const forward = buildFairPairing(people, [], { seed: '2026-W38' });
  const reversed = buildFairPairing([...people].reverse(), [], { seed: '2026-W38' });
  assert.deepEqual(normalizedPairs(forward), normalizedPairs(reversed));
  assert.deepEqual(seededShuffle(people, 'fixed'), seededShuffle(people, 'fixed'));
});

test('pairing avoids previous-week repeats when alternatives exist', () => {
  const history = [
    { user_a_id: 1, user_b_id: 2, week_label: '2026-W37', is_ai_pair: 0 },
    { user_a_id: 3, user_b_id: 4, week_label: '2026-W37', is_ai_pair: 0 },
  ];
  const result = buildFairPairing(people, history, { seed: '2026-W38' });
  const pairs = new Set(normalizedPairs(result));
  assert.equal(pairs.has(pairKey(1, 2)), false);
  assert.equal(pairs.has(pairKey(3, 4)), false);
  assert.equal(result.score.previousWeekRepeats, 0);
});

test('odd-user AI assignment rotates away from prior AI recipients', () => {
  const oddPeople = people.slice(0, 3);
  const history = [{ user_a_id: 1, user_b_id: 1, week_label: '2026-W37', is_ai_pair: 1 }];
  const result = buildFairPairing(oddPeople, history, { seed: '2026-W38' });
  const aiPair = result.pairs.find(pair => pair.isAI);
  assert.ok(aiPair);
  assert.notEqual(aiPair.a.id, 1);
});

test('canonical room IDs and escaped labels are safe and stable', () => {
  assert.equal(canonicalRoomId(12, 34), 'week_12_pair_34');
  assert.equal(pairKey(9, 2), '2-9');
  assert.equal(escapeHtml(`<img src=x onerror="alert('x')"> &`), '&lt;img src=x onerror=&quot;alert(&#39;x&#39;)&quot;&gt; &amp;');
});
