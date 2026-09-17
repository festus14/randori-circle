export const PAIRING_ALGORITHM_VERSION = 'fair-seeded-v1';

function hashSeed(value) {
  let hash = 2166136261;
  for (const character of String(value)) {
    hash ^= character.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

/** A deterministic Fisher-Yates shuffle. The input is never mutated. */
export function seededShuffle(values, seed) {
  const shuffled = [...values];
  let state = hashSeed(seed) || 0x9e3779b9;
  for (let index = shuffled.length - 1; index > 0; index -= 1) {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    const target = (state >>> 0) % (index + 1);
    [shuffled[index], shuffled[target]] = [shuffled[target], shuffled[index]];
  }
  return shuffled;
}

export function pairKey(firstId, secondId) {
  const first = Number(firstId);
  const second = Number(secondId);
  return first <= second ? `${first}-${second}` : `${second}-${first}`;
}

function stableParticipantOrder(participants) {
  return [...participants].sort((left, right) => {
    const idDifference = Number(left.id) - Number(right.id);
    if (Number.isFinite(idDifference) && idDifference !== 0) return idDifference;
    return String(left.id).localeCompare(String(right.id));
  });
}

function historySummary(history) {
  const pairCounts = new Map();
  const aiCounts = new Map();
  const latestWeekId = history.length ? history[0].week_id : null;
  const latestPairs = new Set();

  for (const item of history) {
    if (item.is_ai_pair) {
      const userId = Number(item.user_a_id);
      aiCounts.set(userId, (aiCounts.get(userId) || 0) + 1);
      continue;
    }
    const key = pairKey(item.user_a_id, item.user_b_id);
    pairCounts.set(key, (pairCounts.get(key) || 0) + 1);
    if (item.week_id === latestWeekId) latestPairs.add(key);
  }
  return { pairCounts, aiCounts, latestPairs };
}

function makeCandidate(participants, seed, attempt) {
  const shuffled = seededShuffle(participants, `${seed}:${attempt}`);
  const pairs = [];
  for (let index = 0; index < shuffled.length; index += 2) {
    const a = shuffled[index];
    const b = shuffled[index + 1] || null;
    pairs.push({ a, b, isAI: !b });
  }
  return pairs;
}

function scoreCandidate(pairs, summary) {
  let previousWeekRepeats = 0;
  let historicalRepeats = 0;
  let largestPairHistory = 0;
  let aiHistory = 0;

  for (const pair of pairs) {
    if (pair.isAI) {
      aiHistory += summary.aiCounts.get(Number(pair.a.id)) || 0;
      continue;
    }
    const key = pairKey(pair.a.id, pair.b.id);
    const count = summary.pairCounts.get(key) || 0;
    if (summary.latestPairs.has(key)) previousWeekRepeats += 1;
    historicalRepeats += count;
    largestPairHistory = Math.max(largestPairHistory, count);
  }

  // The signature gives identical inputs one stable tie-break instead of relying on sort order.
  const signature = pairs
    .map(pair => pair.isAI ? `${pair.a.id}-ai` : pairKey(pair.a.id, pair.b.id))
    .sort()
    .join('|');
  return { previousWeekRepeats, historicalRepeats, largestPairHistory, aiHistory, signature };
}

function isBetterScore(candidate, incumbent) {
  if (!incumbent) return true;
  const candidateValues = [
    candidate.previousWeekRepeats,
    candidate.historicalRepeats,
    candidate.aiHistory,
    candidate.largestPairHistory,
  ];
  const incumbentValues = [
    incumbent.previousWeekRepeats,
    incumbent.historicalRepeats,
    incumbent.aiHistory,
    incumbent.largestPairHistory,
  ];
  for (let index = 0; index < candidateValues.length; index += 1) {
    if (candidateValues[index] !== incumbentValues[index]) {
      return candidateValues[index] < incumbentValues[index];
    }
  }
  return candidate.signature < incumbent.signature;
}

/**
 * Produce repeat-aware pairs from stable inputs. Recent repeats are avoided first,
 * then total repeat history and prior AI assignments are minimized.
 */
export function buildFairPairing(participants, history = [], options = {}) {
  const ordered = stableParticipantOrder(participants);
  const seed = String(options.seed || 'randori');
  const attempts = Math.max(1, Number(options.attempts) || Math.max(64, ordered.length * 16));
  const summary = historySummary(history);
  let best = null;

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const pairs = makeCandidate(ordered, seed, attempt);
    const score = scoreCandidate(pairs, summary);
    if (!best || isBetterScore(score, best.score)) best = { pairs, score };
  }

  return {
    pairs: best?.pairs || [],
    score: best?.score || {
      previousWeekRepeats: 0,
      historicalRepeats: 0,
      largestPairHistory: 0,
      aiHistory: 0,
      signature: '',
    },
    repeatCount: best?.score.previousWeekRepeats || 0,
    seed,
    attempts,
    algorithmVersion: PAIRING_ALGORITHM_VERSION,
  };
}

export function canonicalRoomId(weekId, pairGroupId) {
  return `week_${Number(weekId)}_pair_${Number(pairGroupId)}`;
}

export function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}
