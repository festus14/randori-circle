// Independently written Python reference solutions for offline authoring checks.
// These run inside api/_execution.js's restricted Python namespace: no imports.
export const PYTHON_KIT_REFERENCES = Object.freeze({
  'delivery-receipt-ledger@1': `def delivery_receipt_ledger(receipts):
    first = {}
    for receipt in receipts:
        if receipt['id'] not in first:
            first[receipt['id']] = receipt
    totals = {}
    for receipt in first.values():
        destination = receipt['destination']
        totals[destination] = totals.get(destination, 0) + receipt['units']
    return [{'destination': d, 'units': totals[d]} for d in sorted(totals)]
`,
  'shard-window-audit@1': `def shard_window_audit(events, queries):
    shards = {}
    for shard, time, delta in events:
        if shard not in shards:
            shards[shard] = []
        shards[shard].append([time, delta])
    prefixes = {}
    for shard, entries in shards.items():
        entries.sort()
        sums = [0]
        for time, delta in entries:
            sums.append(sums[-1] + delta)
        prefixes[shard] = sums
    def lower(entries, value):
        lo, hi = 0, len(entries)
        while lo < hi:
            mid = (lo + hi) // 2
            if entries[mid][0] < value:
                lo = mid + 1
            else:
                hi = mid
        return lo
    answer = []
    for shard, start, end in queries:
        entries = shards.get(shard, [])
        sums = prefixes.get(shard, [0])
        answer.append(sums[lower(entries, end)] - sums[lower(entries, start)])
    return answer
`,
  'retry-lane-dispatch@1': `def retry_lane_dispatch(jobs):
    remaining = list(jobs)
    time = 0
    result = []
    while remaining:
        ready = [j for j in remaining if j['readyAt'] <= time]
        if not ready:
            time = min(j['readyAt'] for j in remaining)
            ready = [j for j in remaining if j['readyAt'] <= time]
        job = min(ready, key=lambda j: (j['duration'], j['id']))
        result.append({'id': job['id'], 'start': time})
        time += job['duration']
        remaining.remove(job)
    return result
`,
  'shard-fence-planner@1': `def shard_fence_planner(events, batches, shard_fee):
    n = len(events)
    if batches > n or (n and batches == 0):
        return -1
    costs = [[0] * (n + 1) for i in range(n)]
    for start in range(n):
        shards = set()
        peak = 0
        for end in range(start + 1, n + 1):
            shards.add(events[end - 1][0])
            peak = max(peak, events[end - 1][1])
            costs[start][end] = peak + len(shards) * shard_fee
    dp = [[float('inf')] * (n + 1) for b in range(batches + 1)]
    dp[0][0] = 0
    for b in range(1, batches + 1):
        for end in range(b, n + 1):
            dp[b][end] = min(dp[b - 1][start] + costs[start][end] for start in range(b - 1, end))
    return dp[batches][n] if dp[batches][n] != float('inf') else -1
`,
  'panel-notice-counters@1': `def panel_notice_counters(events):
    counts = {}
    for panel, action in events:
        if action == 'read':
            counts[panel] = 0
        else:
            counts[panel] = counts.get(panel, 0) + 1
    return [{'panel': p, 'unread': counts[p]} for p in sorted(counts) if counts[p] > 0]
`,
  'draft-revision-fold@1': `def draft_revision_fold(updates):
    by_id = {}
    for update in updates:
        ident = update['id']
        if ident not in by_id:
            by_id[ident] = []
        by_id[ident].append(update)
    answer = []
    for ident in sorted(by_id):
        revision = max(u['revision'] for u in by_id[ident])
        chosen = next(u for u in by_id[ident] if u['revision'] == revision)
        if chosen['text'] is not None:
            answer.append({'id': ident, 'revision': revision, 'text': chosen['text']})
    return answer
`,
  'viewport-anchor-walk@1': `def viewport_anchor_walk(heights, commands):
    sizes = list(heights)
    panel, inset = 0, 0
    answer = []
    for command in commands:
        if command[0] == 'resize':
            sizes[command[1]] = command[2]
            inset = min(inset, sizes[panel] - 1)
        else:
            offset = max(0, min(command[1], sum(sizes) - 1))
            panel = 0
            prefix = 0
            while prefix + sizes[panel] <= offset:
                prefix += sizes[panel]
                panel += 1
            inset = offset - prefix
        answer.append([panel, inset])
    return answer
`,
  'focus-shortcut-tour@1': `def focus_shortcut_tour(panel_count, shortcuts, required):
    distances = [[float('inf')] * panel_count for i in range(panel_count)]
    for i in range(panel_count):
        distances[i][i] = 0
    for a, b, effort in shortcuts:
        distances[a][b] = min(distances[a][b], effort)
    for via in range(panel_count):
        for a in range(panel_count):
            for b in range(panel_count):
                distances[a][b] = min(distances[a][b], distances[a][via] + distances[via][b])
    memo = {}
    def visit(current, mask):
        if mask == (1 << len(required)) - 1:
            return distances[current][panel_count - 1]
        key = (current, mask)
        if key in memo:
            return memo[key]
        value = float('inf')
        for i, panel in enumerate(required):
            if not mask & (1 << i):
                value = min(value, distances[current][panel] + visit(panel, mask | (1 << i)))
        memo[key] = value
        return value
    result = visit(0, 0)
    return result if result != float('inf') else -1
`,
});
