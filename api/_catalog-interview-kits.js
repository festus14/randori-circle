// Original interview-kit evaluation definitions. Server only: never bundle in assets.
// Oracles are deliberately standalone so the real JS harness can execute them
// without imports, just as a member's solution must run without imports.
function deliveryReceiptLedger(receipts) {
  const seen = new Set();
  const totals = new Map();
  for (const { id, destination, units } of receipts) {
    if (seen.has(id)) continue;
    seen.add(id);
    totals.set(destination, (totals.get(destination) || 0) + units);
  }
  return [...totals].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
    .map(([destination, units]) => ({ destination, units }));
}

function shardWindowAudit(events, queries) {
  const shards = new Map();
  for (const [shard, time, delta] of events) {
    if (!shards.has(shard)) shards.set(shard, []);
    shards.get(shard).push([time, delta]);
  }
  for (const [shard, entries] of shards) {
    entries.sort((a, b) => a[0] - b[0]);
    const sums = [0];
    for (const [, delta] of entries) sums.push(sums.at(-1) + delta);
    shards.set(shard, { entries, sums });
  }
  const lowerBound = (entries, time) => {
    let low = 0, high = entries.length;
    while (low < high) {
      const middle = Math.floor((low + high) / 2);
      if (entries[middle][0] < time) low = middle + 1;
      else high = middle;
    }
    return low;
  };
  return queries.map(([shard, start, end]) => {
    const data = shards.get(shard);
    if (!data) return 0;
    return data.sums[lowerBound(data.entries, end)] - data.sums[lowerBound(data.entries, start)];
  });
}

function retryLaneDispatch(jobs) {
  const pending = [...jobs].sort((a, b) => a.readyAt - b.readyAt);
  const heap = [];
  const compare = (a, b) => a.duration - b.duration || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  const push = job => {
    heap.push(job);
    let index = heap.length - 1;
    while (index > 0) {
      const parent = Math.floor((index - 1) / 2);
      if (compare(heap[parent], heap[index]) <= 0) break;
      [heap[parent], heap[index]] = [heap[index], heap[parent]];
      index = parent;
    }
  };
  const pop = () => {
    const job = heap[0], last = heap.pop();
    if (heap.length) {
      heap[0] = last;
      let index = 0;
      while (true) {
        let smallest = index;
        const left = 2 * index + 1, right = left + 1;
        if (left < heap.length && compare(heap[left], heap[smallest]) < 0) smallest = left;
        if (right < heap.length && compare(heap[right], heap[smallest]) < 0) smallest = right;
        if (smallest === index) break;
        [heap[index], heap[smallest]] = [heap[smallest], heap[index]];
        index = smallest;
      }
    }
    return job;
  };
  let cursor = 0, time = 0;
  const result = [];
  while (cursor < pending.length || heap.length) {
    if (!heap.length) time = Math.max(time, pending[cursor].readyAt);
    while (cursor < pending.length && pending[cursor].readyAt <= time) push(pending[cursor++]);
    const job = pop();
    result.push({ id: job.id, start: time });
    time += job.duration;
  }
  return result;
}

function shardFencePlanner(events, batches, shardFee) {
  const length = events.length;
  if (batches > length || (length > 0 && batches === 0)) return -1;
  let previous = Array(length + 1).fill(Infinity);
  previous[0] = 0;
  for (let batch = 1; batch <= batches; batch += 1) {
    const next = Array(length + 1).fill(Infinity);
    for (let end = batch; end <= length; end += 1) {
      const shards = new Set();
      let maximum = 0;
      for (let start = end - 1; start >= batch - 1; start -= 1) {
        shards.add(events[start][0]);
        maximum = Math.max(maximum, events[start][1]);
        next[end] = Math.min(next[end], previous[start] + maximum + shards.size * shardFee);
      }
    }
    previous = next;
  }
  return Number.isFinite(previous[length]) ? previous[length] : -1;
}

function panelNoticeCounters(events) {
  const counts = new Map();
  for (const [panel, action] of events) {
    counts.set(panel, action === 'read' ? 0 : (counts.get(panel) || 0) + 1);
  }
  return [...counts].filter(([, count]) => count > 0)
    .sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
    .map(([panel, unread]) => ({ panel, unread }));
}

function draftRevisionFold(updates) {
  const latest = new Map();
  for (const update of updates) {
    const previous = latest.get(update.id);
    if (!previous || update.revision > previous.revision) latest.set(update.id, update);
  }
  return [...latest.values()].filter(update => update.text !== null)
    .sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
    .map(({ id, revision, text }) => ({ id, revision, text }));
}

function viewportAnchorWalk(heights, commands) {
  const sizes = [...heights];
  let index = 0, inset = 0;
  const result = [];
  for (const command of commands) {
    if (command[0] === 'resize') {
      sizes[command[1]] = command[2];
      inset = Math.min(inset, sizes[index] - 1);
    } else {
      let offset = Math.min(Math.max(0, command[1]), sizes.reduce((sum, size) => sum + size, 0) - 1);
      index = 0;
      while (offset >= sizes[index]) offset -= sizes[index++];
      inset = offset;
    }
    result.push([index, inset]);
  }
  return result;
}

function focusShortcutTour(panelCount, shortcuts, required) {
  const distances = Array.from({ length: panelCount }, (_, from) =>
    Array.from({ length: panelCount }, (_, to) => from === to ? 0 : Infinity));
  for (const [from, to, effort] of shortcuts) distances[from][to] = Math.min(distances[from][to], effort);
  for (let via = 0; via < panelCount; via += 1) {
    for (let from = 0; from < panelCount; from += 1) {
      for (let to = 0; to < panelCount; to += 1) {
        distances[from][to] = Math.min(distances[from][to], distances[from][via] + distances[via][to]);
      }
    }
  }
  const count = required.length;
  if (!count) return Number.isFinite(distances[0][panelCount - 1]) ? distances[0][panelCount - 1] : -1;
  const best = Array.from({ length: 1 << count }, () => Array(count).fill(Infinity));
  for (let end = 0; end < count; end += 1) best[1 << end][end] = distances[0][required[end]];
  for (let mask = 1; mask < (1 << count); mask += 1) {
    for (let end = 0; end < count; end += 1) {
      if (!(mask & (1 << end))) continue;
      for (let next = 0; next < count; next += 1) {
        if (mask & (1 << next)) continue;
        const nextMask = mask | (1 << next);
        best[nextMask][next] = Math.min(best[nextMask][next], best[mask][end] + distances[required[end]][required[next]]);
      }
    }
  }
  const answer = Math.min(...required.map((panel, end) => best[(1 << count) - 1][end] + distances[panel][panelCount - 1]));
  return Number.isFinite(answer) ? answer : -1;
}

function integer(random, low, high) {
  const unit = Number(random());
  if (!Number.isFinite(unit) || unit < 0 || unit >= 1) throw new RangeError('random must return a finite number in [0, 1)');
  return low + Math.floor(unit * (high - low + 1));
}

export const INTERVIEW_KIT_DEFINITIONS = {
  'delivery-receipt-ledger@1': {
    oracle: deliveryReceiptLedger,
    generateArgs(random, index) {
      if (index === 0) return [[]];
      if (index === 1) return [[{ id: 'r1', destination: 'blue', units: 0 }]];
      if (index === 2) return [[
        { id: 'r1', destination: 'zinc', units: 5 },
        { id: 'r1', destination: 'amber', units: 90 },
        { id: 'r2', destination: 'amber', units: 3 },
        { id: 'r3', destination: 'zinc', units: 2 },
      ]];
      if (index === 7) return [Array.from({ length: 2000 }, (_, i) => ({ id: `r${i % 1000}`, destination: `d${i % 5}`, units: 1000 }))];
      return [Array.from({ length: integer(random, 8, 30) }, () => ({
        id: `r${integer(random, 0, 12)}`, destination: `d${integer(random, 0, 4)}`, units: integer(random, 0, 20),
      }))];
    },
  },
  'shard-window-audit@1': {
    oracle: shardWindowAudit,
    generateArgs(random, index) {
      if (index === 0) return [[], [['a', 0, 10]]];
      if (index === 1) return [[['a', 4, 7], ['a', 4, -2], ['a', 8, 3], ['b', 4, 99]], [['a', 4, 8], ['a', 4, 4], ['a', 8, 9], ['x', 0, 10]]];
      if (index === 2) return [[['a', -3, -9], ['a', -4, 6]], [['a', -4, -2], ['a', -3, 0]]];
      if (index === 7) return [Array.from({ length: 2000 }, (_, i) => ['a', 1999 - i, i % 2 ? -1000 : 1000]), Array.from({ length: 2000 }, (_, i) => ['a', i, 2000])];
      const events = Array.from({ length: integer(random, 10, 35) }, () => [`s${integer(random, 0, 3)}`, integer(random, -10, 10), integer(random, -20, 20)]);
      const queries = Array.from({ length: integer(random, 5, 20) }, () => {
        const start = integer(random, -12, 10);
        return [`s${integer(random, 0, 4)}`, start, start + integer(random, 0, 10)];
      });
      return [events, queries];
    },
  },
  'retry-lane-dispatch@1': {
    oracle: retryLaneDispatch,
    generateArgs(random, index) {
      if (index === 0) return [[]];
      if (index === 1) return [[{ id: 'solo', readyAt: 8, duration: 2 }]];
      if (index === 2) return [[{ id: 'z', readyAt: 0, duration: 5 }, { id: 'b', readyAt: 2, duration: 1 }, { id: 'a', readyAt: 2, duration: 1 }, { id: 'late', readyAt: 20, duration: 1 }]];
      if (index === 7) return [Array.from({ length: 1000 }, (_, i) => ({ id: `j${String(999 - i).padStart(4, '0')}`, readyAt: 0, duration: 1 }))];
      return [Array.from({ length: integer(random, 5, 25) }, (_, i) => ({ id: `j${i}`, readyAt: integer(random, 0, 30), duration: integer(random, 1, 8) }))];
    },
  },
  'shard-fence-planner@1': {
    oracle: shardFencePlanner,
    generateArgs(random, index) {
      if (index === 0) return [[], 0, 3];
      if (index === 1) return [[['a', 5]], 2, 1];
      if (index === 2) return [[['a', 9], ['b', 1], ['a', 2]], 2, 4];
      if (index === 3) return [[['a', 2], ['a', 3]], 0, 0];
      if (index === 7) return [Array.from({ length: 180 }, (_, i) => [`s${i % 5}`, 10]), 20, 2];
      const events = Array.from({ length: integer(random, 4, 10) }, () => [`s${integer(random, 0, 3)}`, integer(random, 1, 20)]);
      return [events, integer(random, 1, events.length), integer(random, 0, 8)];
    },
  },
  'panel-notice-counters@1': {
    oracle: panelNoticeCounters,
    generateArgs(random, index) {
      if (index === 0) return [[]];
      if (index === 1) return [[['a', 'read'], ['a', 'notify'], ['a', 'read']]];
      if (index === 2) return [[['z', 'notify'], ['a', 'notify'], ['z', 'read'], ['z', 'notify'], ['a', 'notify']]];
      if (index === 7) return [Array.from({ length: 2000 }, (_, i) => [`p${i % 5}`, 'notify'])];
      return [Array.from({ length: integer(random, 8, 30) }, () => [`p${integer(random, 0, 4)}`, integer(random, 0, 3) === 0 ? 'read' : 'notify'])];
    },
  },
  'draft-revision-fold@1': {
    oracle: draftRevisionFold,
    generateArgs(random, index) {
      if (index === 0) return [[]];
      if (index === 1) return [[{ id: 'a', revision: 0, text: '' }]];
      if (index === 2) return [[{ id: 'a', revision: 4, text: null }, { id: 'a', revision: 2, text: 'old' }, { id: 'b', revision: 1, text: 'first' }, { id: 'b', revision: 1, text: 'tie' }]];
      if (index === 3) return [[{ id: 'a', revision: 4, text: null }, { id: 'a', revision: 5, text: 'restored' }]];
      if (index === 7) return [Array.from({ length: 2000 }, (_, i) => ({ id: `d${i % 5}`, revision: 2000 - i, text: i < 5 ? null : 'stale' }))];
      return [Array.from({ length: integer(random, 8, 30) }, () => ({ id: `d${integer(random, 0, 4)}`, revision: integer(random, 0, 8), text: integer(random, 0, 3) === 0 ? null : `text-${integer(random, 0, 99)}` }))];
    },
  },
  'viewport-anchor-walk@1': {
    oracle: viewportAnchorWalk,
    generateArgs(random, index) {
      if (index === 0) return [[1], []];
      if (index === 1) return [[3, 4], [['jump', 3], ['resize', 0, 1], ['jump', -4], ['jump', 100]]];
      if (index === 2) return [[3, 8, 2], [['jump', 9], ['resize', 1, 2], ['resize', 0, 10]]];
      if (index === 7) return [Array(400).fill(1000), Array.from({ length: 400 }, (_, i) => ['jump', i * 1000])];
      const heights = Array.from({ length: integer(random, 2, 10) }, () => integer(random, 1, 20));
      const commands = Array.from({ length: integer(random, 8, 25) }, () => integer(random, 0, 1)
        ? ['resize', integer(random, 0, heights.length - 1), integer(random, 1, 20)]
        : ['jump', integer(random, -20, 200)]);
      return [heights, commands];
    },
  },
  'focus-shortcut-tour@1': {
    oracle: focusShortcutTour,
    generateArgs(random, index) {
      if (index === 0) return [1, [], []];
      if (index === 1) return [3, [[0, 2, 1]], [1]];
      if (index === 2) return [4, [[0, 1, 9], [0, 2, 1], [2, 1, 1], [1, 3, 2], [2, 3, 9], [0, 2, 5]], [1, 2]];
      if (index === 3) return [3, [[0, 1, 0], [1, 0, 0], [1, 2, 2]], [2, 0, 1]];
      if (index === 7) return [40, Array.from({ length: 39 }, (_, i) => [i, i + 1, 1]), Array.from({ length: 10 }, (_, i) => 30 - i)];
      const count = integer(random, 3, 7);
      const edges = [];
      for (let from = 0; from < count; from += 1) {
        for (let to = 0; to < count; to += 1) {
          if (from !== to && integer(random, 0, 2) === 0) edges.push([from, to, integer(random, 0, 8)]);
        }
      }
      const required = Array.from({ length: integer(random, 0, count) }, (_, i) => i);
      return [count, edges, required];
    },
  },
};
