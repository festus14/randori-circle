import { randomInt } from 'node:crypto';

import rawCatalog from '../data/randori-catalog-v1.json' with { type: 'json' };

export const SUPPORTED_LANGUAGES = Object.freeze(['javascript', 'python']);

const GENERATED_CASE_COUNT = 8;

function defaultRandom() {
  return randomInt(0, 0x100000000) / 0x100000000;
}

function randomUnit(random) {
  if (typeof random !== 'function') throw new TypeError('random must be a function');
  const value = Number(random());
  if (!Number.isFinite(value) || value < 0 || value >= 1) {
    throw new RangeError('random must return a finite number in [0, 1)');
  }
  return value;
}

function randomInteger(random, minimum, maximum) {
  return minimum + Math.floor(randomUnit(random) * (maximum - minimum + 1));
}

function randomItem(random, values) {
  return values[randomInteger(random, 0, values.length - 1)];
}

function randomShuffle(random, values) {
  const shuffled = [...values];
  for (let index = shuffled.length - 1; index > 0; index -= 1) {
    const target = randomInteger(random, 0, index);
    [shuffled[index], shuffled[target]] = [shuffled[target], shuffled[index]];
  }
  return shuffled;
}

function rollUpFocusBlocks(blocks) {
  const result = [];
  for (const block of blocks) {
    const previous = result.at(-1);
    if (previous?.label === block.label) previous.minutes += block.minutes;
    else result.push({ label: block.label, minutes: block.minutes });
  }
  return result;
}

function findSteadyWindows(readings, width, maxSpread) {
  const minimums = [];
  const maximums = [];
  let minimumHead = 0;
  let maximumHead = 0;
  const result = [];
  for (let right = 0; right < readings.length; right += 1) {
    while (minimums.length > minimumHead && readings[minimums.at(-1)] >= readings[right]) minimums.pop();
    while (maximums.length > maximumHead && readings[maximums.at(-1)] <= readings[right]) maximums.pop();
    minimums.push(right);
    maximums.push(right);
    const left = right - width + 1;
    if (left < 0) continue;
    while (minimums[minimumHead] < left) minimumHead += 1;
    while (maximums[maximumHead] < left) maximumHead += 1;
    if (readings[maximums[maximumHead]] - readings[minimums[minimumHead]] <= maxSpread) result.push(left);
  }
  return result;
}

function planReviewWaves(tasks, dependencies) {
  const indegree = new Map(tasks.map(task => [task, 0]));
  const dependents = new Map(tasks.map(task => [task, []]));
  for (const [before, after] of dependencies) {
    indegree.set(after, indegree.get(after) + 1);
    dependents.get(before).push(after);
  }
  let ready = tasks.filter(task => indegree.get(task) === 0).sort();
  const waves = [];
  let completed = 0;
  while (ready.length > 0) {
    waves.push(ready);
    completed += ready.length;
    const next = [];
    for (const task of ready) {
      for (const dependent of dependents.get(task)) {
        const remaining = indegree.get(dependent) - 1;
        indegree.set(dependent, remaining);
        if (remaining === 0) next.push(dependent);
      }
    }
    ready = next.sort();
  }
  return completed === tasks.length ? waves : [];
}

function allocateWorkshopSeats(capacity, requests) {
  const seen = new Set();
  const accepted = [];
  const rejected = [];
  let remaining = capacity;
  for (const request of requests) {
    if (seen.has(request.team)) {
      rejected.push({ team: request.team, reason: 'duplicate-team' });
      continue;
    }
    seen.add(request.team);
    if (request.seats <= remaining) {
      accepted.push(request.team);
      remaining -= request.seats;
    } else {
      rejected.push({ team: request.team, reason: 'insufficient-seats' });
    }
  }
  return { accepted, rejected, remaining };
}

function findCoverageGaps(dayStart, dayEnd, shifts) {
  const coverage = shifts
    .map(([start, end]) => [Math.max(dayStart, start), Math.min(dayEnd, end)])
    .filter(([start, end]) => start < end)
    .sort((left, right) => left[0] - right[0] || left[1] - right[1]);
  const gaps = [];
  let cursor = dayStart;
  for (const [start, end] of coverage) {
    if (start > cursor) gaps.push([cursor, start]);
    cursor = Math.max(cursor, end);
  }
  if (cursor < dayEnd) gaps.push([cursor, dayEnd]);
  return gaps;
}

function balancedTemplateMarkers(template) {
  const expectedOpening = new Map([[')', '('], [']', '['], ['}', '{']]);
  const openings = new Set(expectedOpening.values());
  const stack = [];
  for (const character of template) {
    if (openings.has(character)) stack.push(character);
    else if (expectedOpening.has(character) && stack.pop() !== expectedOpening.get(character)) return false;
  }
  return stack.length === 0;
}

function capacityUpgradeIndex(capacities, required) {
  let low = 0;
  let high = capacities.length;
  while (low < high) {
    const middle = low + Math.floor((high - low) / 2);
    if (capacities[middle] >= required) high = middle;
    else low = middle + 1;
  }
  return low < capacities.length ? low : -1;
}

function shortestHandoffPath(serviceCount, links, start, target) {
  if (start === target) return 0;
  const neighbours = Array.from({ length: serviceCount }, () => []);
  for (const [left, right] of links) {
    neighbours[left].push(right);
    neighbours[right].push(left);
  }
  const distances = Array(serviceCount).fill(-1);
  const queue = [start];
  distances[start] = 0;
  for (let head = 0; head < queue.length; head += 1) {
    const current = queue[head];
    for (const next of neighbours[current]) {
      if (distances[next] !== -1) continue;
      distances[next] = distances[current] + 1;
      if (next === target) return distances[next];
      queue.push(next);
    }
  }
  return -1;
}

function messageFrequencyLeaders(labels, threshold) {
  const counts = new Map();
  for (const label of labels) counts.set(label, (counts.get(label) || 0) + 1);
  return [...counts]
    .filter(([, count]) => count >= threshold)
    .map(([label, count]) => ({ label, count }))
    .sort((left, right) => right.count - left.count || (left.label < right.label ? -1 : left.label > right.label ? 1 : 0));
}

function recoveryBudgetPlan(bundleDurations, target) {
  const best = Array(target + 1).fill(Number.POSITIVE_INFINITY);
  best[0] = 0;
  for (let total = 1; total <= target; total += 1) {
    for (const duration of bundleDurations) {
      if (duration <= total && Number.isFinite(best[total - duration])) {
        best[total] = Math.min(best[total], best[total - duration] + 1);
      }
    }
  }
  return Number.isFinite(best[target]) ? best[target] : -1;
}

const SERVER_EXERCISE_DEFINITIONS = {
  'focus-block-rollup@1': {
    generateArgs(random, caseIndex) {
      if (caseIndex === 0) return [[]];
      if (caseIndex === GENERATED_CASE_COUNT - 1) {
        return [Array.from({ length: 10_000 }, (_, index) => ({
          label: 'f',
          minutes: index % 2 === 0 ? 1 : 1440,
        }))];
      }
      const labels = ['focus', 'review', 'break', 'pairing'];
      const primary = randomItem(random, labels);
      if (caseIndex === 1) {
        return [[{ label: primary, minutes: randomInteger(random, 1, 60) }]];
      }
      const secondary = randomItem(random, labels.filter(label => label !== primary));
      const blocks = [
        { label: primary, minutes: randomInteger(random, 1, 60) },
        { label: primary, minutes: randomInteger(random, 1, 60) },
        { label: secondary, minutes: randomInteger(random, 1, 60) },
      ];
      const count = randomInteger(random, 4, 10);
      while (blocks.length < count) {
        const previous = blocks.at(-1).label;
        const label = randomUnit(random) < 0.45 ? previous : randomItem(random, labels);
        blocks.push({ label, minutes: randomInteger(random, 1, 60) });
      }
      return [blocks];
    },
    oracle: rollUpFocusBlocks,
  },
  'steady-sensor-windows@1': {
    generateArgs(random, caseIndex) {
      if (caseIndex === GENERATED_CASE_COUNT - 1) {
        return [Array.from({ length: 20_000 }, (_, index) => index % 2 === 0 ? 0 : 1_000_000), 10_000, 999_999];
      }
      const length = caseIndex === 0 ? 1 : randomInteger(random, 4, 14);
      const width = caseIndex === 0
        ? 1
        : caseIndex === 1
          ? length
          : randomInteger(random, 1, Math.min(7, length));
      const centre = randomInteger(random, -40, 40);
      const readings = Array.from(
        { length },
        () => centre + randomInteger(random, -10, 10),
      );
      return [readings, width, randomInteger(random, 0, 12)];
    },
    oracle: findSteadyWindows,
  },
  'review-wave-planner@1': {
    generateArgs(random, caseIndex) {
      if (caseIndex === 0) return [[], []];
      if (caseIndex === GENERATED_CASE_COUNT - 1) {
        const tasks = Array.from({ length: 5_000 }, (_, index) => `t${index.toString(36)}`);
        return [[...tasks].reverse(), tasks.slice(1).map(task => [tasks[0], task])];
      }
      const count = randomInteger(random, 3, 8);
      const offset = randomInteger(random, 10, 999);
      const tasks = Array.from({ length: count }, (_, index) => 'task-' + (offset + index));
      const dependencyKeys = new Set();
      if (caseIndex === 2) {
        dependencyKeys.add(tasks[0] + '\\u0000' + tasks[1]);
        dependencyKeys.add(tasks[1] + '\\u0000' + tasks[0]);
      } else if (caseIndex !== 1) {
        for (let before = 0; before < count; before += 1) {
          for (let after = before + 1; after < count; after += 1) {
            if (randomUnit(random) < 0.3) {
              dependencyKeys.add(tasks[before] + '\\u0000' + tasks[after]);
            }
          }
        }
      }
      const dependencies = [...dependencyKeys].map(value => value.split('\\u0000'));
      return [randomShuffle(random, tasks), dependencies];
    },
    oracle: planReviewWaves,
  },
  'workshop-seat-allocation@1': {
    generateArgs(random, caseIndex) {
      if (caseIndex === GENERATED_CASE_COUNT - 1) {
        return [1_000_000, Array.from({ length: 10_000 }, (_, index) => ({
          team: `t${index.toString(36)}`,
          seats: 1,
        }))];
      }
      const capacity = caseIndex === 1 ? 0 : randomInteger(random, 3, 25);
      if (caseIndex === 0) return [capacity, []];
      const count = randomInteger(random, 4, 10);
      const requests = Array.from({ length: count }, (_, index) => ({
        team: 'team-' + randomInteger(random, 1, count + 2),
        seats: randomInteger(random, 1, 12),
      }));
      if (caseIndex % 2 === 0) requests.at(-1).team = requests[0].team;
      return [capacity, requests];
    },
    oracle: allocateWorkshopSeats,
  },
  'coverage-gap-finder@1': {
    generateArgs(random, caseIndex) {
      if (caseIndex === GENERATED_CASE_COUNT - 1) {
        return [0, 10_000, Array.from({ length: 10_000 }, (_, index) => [9_999 - index, 10_000 - index])];
      }
      const dayStart = randomInteger(random, -20, 50);
      const dayEnd = dayStart + randomInteger(random, 8, 40);
      if (caseIndex === 0) return [dayStart, dayEnd, []];
      if (caseIndex === 1) {
        return [
          dayStart,
          dayEnd,
          [[dayStart - randomInteger(random, 1, 10), dayEnd + randomInteger(random, 1, 10)]],
        ];
      }
      if (caseIndex === 2) {
        const coveredUntil = randomInteger(random, dayStart + 1, dayEnd - 1);
        return [
          dayStart,
          dayEnd,
          [
            [dayStart - randomInteger(random, 1, 10), coveredUntil],
            [dayEnd, dayEnd + randomInteger(random, 1, 10)],
          ],
        ];
      }
      const count = randomInteger(random, 2, 9);
      const shifts = Array.from({ length: count }, () => {
        const start = randomInteger(random, dayStart - 10, dayEnd + 5);
        return [start, start + randomInteger(random, 1, 16)];
      });
      return [dayStart, dayEnd, shifts];
    },
    oracle: findCoverageGaps,
  },
  'balanced-template-markers@1': {
    generateArgs(random, caseIndex) {
      if (caseIndex === 0) return [''];
      if (caseIndex === 1) return ['plain text without markers'];
      if (caseIndex === 2) return ['header{section[2](ready)}footer'];
      if (caseIndex === 3) return ['header{section[2)(ready]}footer'];
      if (caseIndex === GENERATED_CASE_COUNT - 1) {
        return ['('.repeat(9_999) + '[' + ')'.repeat(9_999) + ']'];
      }
      const pairs = [['(', ')'], ['[', ']'], ['{', '}']];
      const selected = Array.from(
        { length: randomInteger(random, 3, 12) },
        () => randomItem(random, pairs),
      );
      const opening = selected.map(pair => pair[0]).join('');
      const closing = [...selected].reverse().map(pair => pair[1]).join('');
      const valid = `prefix-${opening}payload-${randomInteger(random, 0, 999)}${closing}-suffix`;
      if (caseIndex === 5) return [valid.replace(closing, closing.slice(0, -1))];
      return [valid];
    },
    oracle: balancedTemplateMarkers,
  },
  'capacity-upgrade-index@1': {
    generateArgs(random, caseIndex) {
      if (caseIndex === 0) return [[], 10];
      if (caseIndex === 1) return [[4, 8, 8, 15], 8];
      if (caseIndex === 2) return [[3, 6, 9], 10];
      if (caseIndex === 3) return [[3, 6, 9], 5];
      if (caseIndex === GENERATED_CASE_COUNT - 1) {
        return [Array.from({ length: 20_000 }, (_, index) => index * 2), 19_999];
      }
      const length = randomInteger(random, 5, 30);
      const capacities = Array.from({ length }, () => randomInteger(random, -100, 100))
        .sort((left, right) => left - right);
      return [capacities, randomInteger(random, -110, 110)];
    },
    oracle: capacityUpgradeIndex,
  },
  'shortest-handoff-path@1': {
    generateArgs(random, caseIndex) {
      if (caseIndex === 0) return [1, [], 0, 0];
      if (caseIndex === 1) return [4, [], 0, 3];
      if (caseIndex === 2) return [4, [[0, 3]], 0, 3];
      if (caseIndex === 3) return [3, [[1, 0], [2, 1]], 0, 2];
      if (caseIndex === GENERATED_CASE_COUNT - 1) {
        const serviceCount = 5_000;
        const links = Array.from({ length: serviceCount - 1 }, (_, index) => [index, index + 1]);
        links.push([0, serviceCount - 1]);
        for (let index = 0; index < serviceCount; index += 1) {
          links.push([index, (index + 2) % serviceCount]);
        }
        return [serviceCount, links, 0, serviceCount - 1];
      }
      const serviceCount = randomInteger(random, 6, 20);
      const count = randomInteger(random, serviceCount - 2, serviceCount * 2);
      const candidates=[];
      for(let left=0;left<serviceCount;left+=1){
        for(let right=left+1;right<serviceCount;right+=1) candidates.push([left,right]);
      }
      const links=randomShuffle(random,candidates).slice(0,count);
      return [serviceCount, links, randomInteger(random, 0, serviceCount - 1), randomInteger(random, 0, serviceCount - 1)];
    },
    oracle: shortestHandoffPath,
  },
  'message-frequency-leaders@1': {
    generateArgs(random, caseIndex) {
      if (caseIndex === 0) return [[], 1];
      if (caseIndex === 1) return [['beta', 'alpha', 'beta', 'alpha', 'gamma'], 2];
      if (caseIndex === 2) return [['solo', 'solo'], 3];
      if (caseIndex === 3) return [['alpha', 'zeta', 'zeta', 'alpha', 'zeta'], 2];
      if (caseIndex === GENERATED_CASE_COUNT - 1) {
        return [Array.from({ length: 20_000 }, (_, index) => `label-${String(index % 100).padStart(3, '0')}`), 200];
      }
      const distinct = randomInteger(random, 2, 8);
      const choices = Array.from({ length: distinct }, (_, index) => `label-${index}`);
      const length = randomInteger(random, 8, 50);
      return [Array.from({ length }, () => randomItem(random, choices)), randomInteger(random, 1, 8)];
    },
    oracle: messageFrequencyLeaders,
  },
  'recovery-budget-plan@1': {
    generateArgs(random, caseIndex) {
      if (caseIndex === 0) return [[], 0];
      if (caseIndex === 1) return [[], 7];
      if (caseIndex === 2) return [[5], 10];
      if (caseIndex === 3) return [[6, 10, 15], 20];
      if (caseIndex === 4) return [[4, 6], 7];
      if (caseIndex === GENERATED_CASE_COUNT - 1) {
        return [Array.from({ length: 50 }, (_, index) => index + 1), 10_000];
      }
      const bundleCount = randomInteger(random, 2, 8);
      const durations=randomShuffle(random,Array.from({length:40},(_,index)=>index+1))
        .slice(0,bundleCount).sort((left,right)=>left-right);
      return [durations, randomInteger(random, 1, 180)];
    },
    oracle: recoveryBudgetPlan,
  },
};

const DIFFICULTIES = new Set(['Easy', 'Medium', 'Hard']);
const EXERCISE_STATUSES = new Set(['active', 'retired']);
const TAKEDOWN_STATUSES = new Set(['none', 'requested', 'resolved']);
const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const TYPE_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const TEST_ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const JAVASCRIPT_ENTRYPOINT_PATTERN = /^[A-Za-z_$][A-Za-z0-9_$]*$/;
const PYTHON_ENTRYPOINT_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

export class CatalogValidationError extends Error {
  constructor(path, reason) {
    super(`${path}: ${reason}`);
    this.name = 'CatalogValidationError';
    this.path = path;
    this.reason = reason;
  }
}

function fail(path, reason) {
  throw new CatalogValidationError(path, reason);
}

function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function requireObject(value, path) {
  if (!isPlainObject(value)) fail(path, 'must be an object');
  return value;
}

function requireExactKeys(value, expectedKeys, path) {
  requireObject(value, path);
  const expected = new Set(expectedKeys);
  for (const key of Object.keys(value)) {
    if (!expected.has(key)) fail(`${path}.${key}`, 'is not an allowed field');
  }
  for (const key of expectedKeys) {
    if (!Object.hasOwn(value, key)) fail(`${path}.${key}`, 'is required');
  }
}

function requireNonEmptyString(value, path) {
  if (typeof value !== 'string' || value.trim() === '') fail(path, 'must be a non-empty string');
}

function requireNullableString(value, path) {
  if (value !== null) requireNonEmptyString(value, path);
}

function requirePositiveInteger(value, path) {
  if (!Number.isSafeInteger(value) || value < 1) fail(path, 'must be a positive safe integer');
}

function requireIsoDate(value, path) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    fail(path, 'must use YYYY-MM-DD format');
  }
  const parsed = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(parsed.valueOf()) || parsed.toISOString().slice(0, 10) !== value) {
    fail(path, 'must be a real calendar date');
  }
}

function requireJsonValue(value, path, seen = new Set()) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) fail(path, 'must contain only finite JSON numbers');
    return;
  }
  if (typeof value !== 'object') fail(path, 'must be JSON-compatible');
  if (seen.has(value)) fail(path, 'must not contain circular references');
  seen.add(value);
  if (Array.isArray(value)) {
    value.forEach((item, index) => requireJsonValue(item, `${path}[${index}]`, seen));
  } else {
    if (!isPlainObject(value)) fail(path, 'must contain only plain JSON objects');
    for (const [key, item] of Object.entries(value)) {
      requireJsonValue(item, `${path}.${key}`, seen);
    }
  }
  seen.delete(value);
}

function validateStringArray(value, path, { minimum = 0, pattern = null } = {}) {
  if (!Array.isArray(value) || value.length < minimum) {
    fail(path, `must be an array with at least ${minimum} item${minimum === 1 ? '' : 's'}`);
  }
  const seen = new Set();
  value.forEach((item, index) => {
    requireNonEmptyString(item, `${path}[${index}]`);
    if (pattern && !pattern.test(item)) fail(`${path}[${index}]`, 'has an invalid format');
    if (seen.has(item)) fail(`${path}[${index}]`, 'must be unique');
    seen.add(item);
  });
}

function validateLanguageMap(languages, path) {
  requireExactKeys(languages, SUPPORTED_LANGUAGES, path);
  for (const language of SUPPORTED_LANGUAGES) {
    const implementationPath = `${path}.${language}`;
    const implementation = languages[language];
    requireExactKeys(implementation, ['entrypoint', 'signature', 'starter'], implementationPath);
    requireNonEmptyString(implementation.entrypoint, `${implementationPath}.entrypoint`);
    requireNonEmptyString(implementation.signature, `${implementationPath}.signature`);
    requireNonEmptyString(implementation.starter, `${implementationPath}.starter`);
    const pattern = language === 'javascript'
      ? JAVASCRIPT_ENTRYPOINT_PATTERN
      : PYTHON_ENTRYPOINT_PATTERN;
    if (!pattern.test(implementation.entrypoint)) {
      fail(`${implementationPath}.entrypoint`, `is not a valid ${language} identifier`);
    }
    if (!implementation.signature.includes(implementation.entrypoint)) {
      fail(`${implementationPath}.signature`, 'must name the configured entrypoint');
    }
    if (!implementation.starter.includes(implementation.entrypoint)) {
      fail(`${implementationPath}.starter`, 'must define the configured entrypoint');
    }
  }
}

function validateGovernance(governance, status, path) {
  requireExactKeys(
    governance,
    ['rightsOwner', 'provenance', 'reviewDate', 'attribution', 'retirement', 'takedown'],
    path,
  );
  requireNonEmptyString(governance.rightsOwner, `${path}.rightsOwner`);
  requireNonEmptyString(governance.provenance, `${path}.provenance`);
  requireIsoDate(governance.reviewDate, `${path}.reviewDate`);
  requireNonEmptyString(governance.attribution, `${path}.attribution`);

  const retirementPath = `${path}.retirement`;
  const retirement = governance.retirement;
  requireExactKeys(retirement, ['status', 'retiredAt', 'reason', 'replacement'], retirementPath);
  if (retirement.status !== status) fail(`${retirementPath}.status`, 'must match exercise status');
  requireNullableString(retirement.replacement, `${retirementPath}.replacement`);
  if (retirement.replacement !== null && !SLUG_PATTERN.test(retirement.replacement)) {
    fail(`${retirementPath}.replacement`, 'must be a valid slug or null');
  }
  if (status === 'active') {
    if (retirement.retiredAt !== null || retirement.reason !== null || retirement.replacement !== null) {
      fail(retirementPath, 'active exercises cannot have retirement details');
    }
  } else {
    requireIsoDate(retirement.retiredAt, `${retirementPath}.retiredAt`);
    requireNonEmptyString(retirement.reason, `${retirementPath}.reason`);
  }

  const takedownPath = `${path}.takedown`;
  const takedown = governance.takedown;
  requireExactKeys(takedown, ['status', 'requestedAt', 'reference'], takedownPath);
  if (!TAKEDOWN_STATUSES.has(takedown.status)) fail(`${takedownPath}.status`, 'is unsupported');
  if (takedown.status === 'none') {
    if (takedown.requestedAt !== null || takedown.reference !== null) {
      fail(takedownPath, 'a none takedown must not contain request details');
    }
  } else {
    requireIsoDate(takedown.requestedAt, `${takedownPath}.requestedAt`);
    requireNonEmptyString(takedown.reference, `${takedownPath}.reference`);
  }
  if (status === 'active' && takedown.status === 'requested') {
    fail(takedownPath, 'an exercise with a pending takedown must be retired');
  }
}

function validateExercise(exercise, index) {
  const path = `catalog.exercises[${index}]`;
  requireExactKeys(
    exercise,
    [
      'slug', 'version', 'status', 'title', 'difficulty', 'type', 'tags', 'prompt',
      'constraints', 'examples', 'languages', 'governance',
    ],
    path,
  );
  requireNonEmptyString(exercise.slug, `${path}.slug`);
  if (!SLUG_PATTERN.test(exercise.slug)) fail(`${path}.slug`, 'must be a lowercase kebab-case slug');
  requirePositiveInteger(exercise.version, `${path}.version`);
  if (!EXERCISE_STATUSES.has(exercise.status)) fail(`${path}.status`, 'is unsupported');
  requireNonEmptyString(exercise.title, `${path}.title`);
  if (!DIFFICULTIES.has(exercise.difficulty)) fail(`${path}.difficulty`, 'is unsupported');
  requireNonEmptyString(exercise.type, `${path}.type`);
  if (!TYPE_PATTERN.test(exercise.type)) fail(`${path}.type`, 'must be lowercase kebab-case');
  validateStringArray(exercise.tags, `${path}.tags`, { minimum: 1, pattern: TYPE_PATTERN });
  requireNonEmptyString(exercise.prompt, `${path}.prompt`);
  validateStringArray(exercise.constraints, `${path}.constraints`, { minimum: 1 });
  if (!Array.isArray(exercise.examples) || exercise.examples.length === 0) {
    fail(`${path}.examples`, 'must contain at least one example');
  }
  exercise.examples.forEach((example, exampleIndex) => {
    const examplePath = `${path}.examples[${exampleIndex}]`;
    requireExactKeys(example, ['input', 'output', 'explanation'], examplePath);
    if (!Array.isArray(example.input)) fail(`${examplePath}.input`, 'must be an argument array');
    requireJsonValue(example.input, `${examplePath}.input`);
    requireJsonValue(example.output, `${examplePath}.output`);
    requireNonEmptyString(example.explanation, `${examplePath}.explanation`);
  });
  validateLanguageMap(exercise.languages, `${path}.languages`);
  validateGovernance(exercise.governance, exercise.status, `${path}.governance`);
}

function validateSuite(suite, exerciseByKey, path = 'evaluationSuite') {
  requireExactKeys(suite, ['slug', 'version', 'language', 'entrypoint', 'tests'], path);
  requireNonEmptyString(suite.slug, `${path}.slug`);
  requirePositiveInteger(suite.version, `${path}.version`);
  if (!SUPPORTED_LANGUAGES.includes(suite.language)) fail(`${path}.language`, 'is unsupported');
  const exercise = exerciseByKey.get(`${suite.slug}@${suite.version}`);
  if (!exercise) fail(path, 'does not match an exercise');
  if (exercise.status !== 'active') fail(path, 'cannot target a retired exercise');
  if (suite.entrypoint !== exercise.languages[suite.language].entrypoint) {
    fail(`${path}.entrypoint`, 'must match the public language entrypoint');
  }
  if (!Array.isArray(suite.tests) || suite.tests.length < 3) {
    fail(`${path}.tests`, 'must contain at least three server-owned cases');
  }
  const testIds = new Set();
  suite.tests.forEach((testCase, testIndex) => {
    const testPath = `${path}.tests[${testIndex}]`;
    requireExactKeys(testCase, ['id', 'args', 'expected'], testPath);
    requireNonEmptyString(testCase.id, `${testPath}.id`);
    if (!TEST_ID_PATTERN.test(testCase.id)) fail(`${testPath}.id`, 'must be lowercase kebab-case');
    if (testIds.has(testCase.id)) fail(`${testPath}.id`, 'must be unique within the suite');
    testIds.add(testCase.id);
    if (!Array.isArray(testCase.args)) fail(`${testPath}.args`, 'must be an argument array');
    requireJsonValue(testCase.args, `${testPath}.args`);
    requireJsonValue(testCase.expected, `${testPath}.expected`);
  });
}

function validateRuntimeDefinitions(definitions, exerciseByKey) {
  requireObject(definitions, 'runtimeDefinitions');
  const definitionKeys = new Set();
  for (const [key, definition] of Object.entries(definitions)) {
    const path = `runtimeDefinitions.${key}`;
    if (definitionKeys.has(key)) fail(path, 'duplicates another runtime definition');
    definitionKeys.add(key);
    requireExactKeys(definition, ['generateArgs', 'oracle'], path);
    if (typeof definition.generateArgs !== 'function') fail(`${path}.generateArgs`, 'must be a function');
    if (typeof definition.oracle !== 'function') fail(`${path}.oracle`, 'must be a function');
    const exercise = exerciseByKey.get(key);
    if (!exercise) fail(path, 'does not match an exercise slug and version');
    if (exercise.status !== 'active') fail(path, 'cannot target a retired exercise');
  }
  for (const exercise of exerciseByKey.values()) {
    if (exercise.status !== 'active') continue;
    const key = `${exercise.slug}@${exercise.version}`;
    if (!definitionKeys.has(key)) fail('runtimeDefinitions', `is missing a generator for ${key}`);
  }
}

/** Validate a complete catalogue or throw CatalogValidationError at the first invalid field. */
export function validateCatalog(catalog, runtimeDefinitions = SERVER_EXERCISE_DEFINITIONS) {
  requireExactKeys(catalog, ['schemaVersion', 'catalog', 'exercises'], 'catalog');
  if (catalog.schemaVersion !== 1) fail('catalog.schemaVersion', 'must equal 1');
  requireExactKeys(catalog.catalog, ['id', 'title', 'contentPolicy', 'supportedLanguages'], 'catalog.catalog');
  requireNonEmptyString(catalog.catalog.id, 'catalog.catalog.id');
  requireNonEmptyString(catalog.catalog.title, 'catalog.catalog.title');
  requireNonEmptyString(catalog.catalog.contentPolicy, 'catalog.catalog.contentPolicy');
  if (
    !Array.isArray(catalog.catalog.supportedLanguages)
    || catalog.catalog.supportedLanguages.length !== SUPPORTED_LANGUAGES.length
    || !SUPPORTED_LANGUAGES.every((language, index) => catalog.catalog.supportedLanguages[index] === language)
  ) {
    fail('catalog.catalog.supportedLanguages', 'must exactly match supported runtime languages');
  }
  if (!Array.isArray(catalog.exercises) || catalog.exercises.length === 0) {
    fail('catalog.exercises', 'must contain at least one exercise');
  }
  const exerciseKeys = new Set();
  const activeSlugs = new Set();
  const exerciseByKey = new Map();
  catalog.exercises.forEach((exercise, index) => {
    validateExercise(exercise, index);
    const key = `${exercise.slug}@${exercise.version}`;
    if (exerciseKeys.has(key)) {
      fail(`catalog.exercises[${index}]`, 'duplicates another exercise slug and version');
    }
    exerciseKeys.add(key);
    if (exercise.status === 'active') {
      if (activeSlugs.has(exercise.slug)) {
        fail(`catalog.exercises[${index}].status`, 'only one version of a slug may be active');
      }
      activeSlugs.add(exercise.slug);
    }
    exerciseByKey.set(key, exercise);
  });
  catalog.exercises.forEach((exercise, index) => {
    const replacement = exercise.governance.retirement.replacement;
    if (replacement !== null && !activeSlugs.has(replacement)) {
      fail(
        `catalog.exercises[${index}].governance.retirement.replacement`,
        'must reference an active catalogue slug',
      );
    }
  });

  validateRuntimeDefinitions(runtimeDefinitions, exerciseByKey);

  return Object.freeze({ valid: true, exerciseCount: catalog.exercises.length });
}

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const nested of Object.values(value)) deepFreeze(nested);
  }
  return value;
}

function clone(value) {
  return structuredClone(value);
}

function publicProjection(exercise) {
  return {
    slug: exercise.slug,
    version: exercise.version,
    status: exercise.status,
    source: 'randori-original',
    title: exercise.title,
    difficulty: exercise.difficulty,
    type: exercise.type,
    tags: clone(exercise.tags),
    prompt: exercise.prompt,
    description: exercise.prompt,
    constraints: clone(exercise.constraints),
    examples: clone(exercise.examples),
    languages: clone(exercise.languages),
    rightsOwner: exercise.governance.rightsOwner,
    provenance: exercise.governance.provenance,
    reviewDate: exercise.governance.reviewDate,
    attribution: exercise.governance.attribution,
  };
}

validateCatalog(rawCatalog, SERVER_EXERCISE_DEFINITIONS);
const catalog = deepFreeze(clone(rawCatalog));
const exerciseByKey = new Map(
  catalog.exercises.map(exercise => [`${exercise.slug}@${exercise.version}`, exercise]),
);
const activeExerciseBySlug = new Map(
  catalog.exercises
    .filter(exercise => exercise.status === 'active')
    .map(exercise => [exercise.slug, exercise]),
);

function activeExercise(slug, version) {
  if (typeof slug !== 'string') return null;
  if (version === undefined) return activeExerciseBySlug.get(slug) || null;
  if (!Number.isSafeInteger(version) || version < 1) return null;
  const exercise = exerciseByKey.get(`${slug}@${version}`);
  return exercise?.status === 'active' ? exercise : null;
}

/** Return complete public records for all active exercises. */
export function listPublicExercises() {
  return catalog.exercises
    .filter(exercise => exercise.status === 'active')
    .map(publicProjection);
}

/** Return an exact active version, or the sole current active version when omitted. */
export function getPublicExercise(slug, version) {
  const exercise = activeExercise(slug, version);
  return exercise ? publicProjection(exercise) : null;
}

/** Return a defensive clone of an exact or current active exercise for trusted server code. */
export function getActiveExercise(slug, version) {
  const exercise = activeExercise(slug, version);
  return exercise ? clone(exercise) : null;
}

/** Validate one generated server-side suite without exposing it through a public API. */
export function validateEvaluationSuite(suite) {
  validateSuite(suite, exerciseByKey);
  return Object.freeze({ valid: true, testCount: suite.tests.length });
}

/** Create fresh server-owned cases and compute their expected values locally. */
export function createEvaluationSuite(slug, version, language, options = {}) {
  const exercise = activeExercise(slug, version);
  if (!exercise || !SUPPORTED_LANGUAGES.includes(language)) return null;
  if (!isPlainObject(options)) throw new TypeError('options must be an object');
  const random = options.random ?? defaultRandom;
  if (typeof random !== 'function') throw new TypeError('random must be a function');
  const definition = SERVER_EXERCISE_DEFINITIONS[`${exercise.slug}@${exercise.version}`];
  if (!definition) return null;
  const tests = Array.from({ length: GENERATED_CASE_COUNT }, (_, index) => {
    const args = definition.generateArgs(random, index);
    const expected = definition.oracle(...clone(args));
    return { id: `generated-${index + 1}`, args, expected };
  });
  const suite = {
    slug: exercise.slug,
    version: exercise.version,
    language,
    entrypoint: exercise.languages[language].entrypoint,
    tests,
  };
  validateSuite(suite, exerciseByKey);
  return clone(suite);
}
