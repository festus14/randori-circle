// Owner "Circle health" panel (issue #292, provisional design: needs-design).
//
// index.html imports this module on demand, only when /api/auth/capabilities
// advertises circleHealth. The pure helpers validate the server response and
// turn each cell into display text; the controller renders a text-only table
// into the static panel. Every request, ownership hint and circle-context
// guard comes from the host object index.html passes in. The server is
// authoritative for ownership and has already hidden what must not be shown,
// so this file only displays what it is given and never stores it anywhere
// but memory (cleared by `reset()` on any identity or circle change).

export const METRICS = Object.freeze([
  Object.freeze({ key: 'available', label: 'Available', kind: 'count',
    help: 'Members who were in for the cycle when the pairs were published.' }),
  Object.freeze({ key: 'paired', label: 'Paired', kind: 'count',
    help: 'Members placed with a partner.' }),
  Object.freeze({ key: 'solo', label: 'Solo', kind: 'count',
    help: 'The odd member, who practised solo that cycle.' }),
  Object.freeze({ key: 'scheduled_pairs', label: 'Agreed a time', kind: 'pairs',
    help: 'Pairs that agreed a session time, out of all pairs.' }),
  Object.freeze({ key: 'completed_pairs', label: 'Completed', kind: 'pairs',
    help: 'Pairs where both partners confirmed the session took place.' }),
  Object.freeze({ key: 'repeat_pair_percent', label: 'Repeat pairs', kind: 'percent',
    help: 'Share of pairs who were also paired in one of the 8 cycles before.' }),
]);

// Kept in the contract but not displayed: `pairs` is the denominator shown in
// "2 of 4"; the rest are always `not_tracked` for now.
const SERVER_METRICS = [...METRICS.map(metric => metric.key), 'pairs', 'median_hours_to_agreed_time', 'cancelled', 'no_show'];
// The figures move slowly (weekly cycles), so one copy per circle context is
// reused for a few minutes instead of re-reading on every Circle tab visit.
export const CACHE_TTL_MS = 5 * 60 * 1000;
const STATUSES = new Set(['ok', 'suppressed', 'no_data', 'not_tracked']);
const ISO_WEEK = /^\d{4}-W\d{2}$/;
const MAX_CYCLES = 8;

function record(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
}

function validValue(kind, value) {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) return false;
  return kind === 'percent' ? value <= 100 : value <= 100000;
}

/** One `{status,value}` cell, or null when the shape is not trustworthy. */
export function normalizeCell(raw, kind = 'count') {
  const cell = record(raw);
  if (!cell || !STATUSES.has(cell.status)) return null;
  if (cell.status === 'ok') return validValue(kind, cell.value) ? Object.freeze({ status: 'ok', value: cell.value }) : null;
  return cell.value === null ? Object.freeze({ status: cell.status, value: null }) : null;
}

function normalizeCycle(raw) {
  const cycle = record(raw);
  const metrics = record(cycle?.metrics);
  if (!cycle || !metrics || typeof cycle.cycle_id !== 'string' || !ISO_WEEK.test(cycle.cycle_id)
    || (cycle.starts_at !== null && (typeof cycle.starts_at !== 'string' || !Number.isFinite(Date.parse(cycle.starts_at))))) {
    return null;
  }
  const normalized = {};
  for (const key of SERVER_METRICS) {
    const kind = METRICS.find(metric => metric.key === key)?.kind || 'count';
    const cell = normalizeCell(metrics[key], kind);
    if (!cell) return null;
    normalized[key] = cell;
  }
  if (normalized.pairs.status !== 'ok') return null;
  for (const metric of METRICS) {
    const cell = normalized[metric.key];
    if (metric.kind === 'pairs' && cell.status === 'ok' && cell.value > normalized.pairs.value) return null;
  }
  return Object.freeze({ cycle_id: cycle.cycle_id, starts_at: cycle.starts_at, metrics: Object.freeze(normalized) });
}

/** Validate a GET /api/circle/health body; null means render nothing. */
export function normalizeHealthResponse(raw) {
  const body = record(raw);
  const health = record(body?.health);
  if (body?.ok !== true || !health || !['primary', 'secondary'].includes(health.scope)
    || typeof health.completion_tracked !== 'boolean' || !Number.isInteger(health.min_pairs)
    || health.min_pairs < 2 || !Array.isArray(health.cycles) || health.cycles.length > MAX_CYCLES) {
    return null;
  }
  const cycles = health.cycles.map(normalizeCycle);
  if (cycles.some(cycle => !cycle)) return null;
  return Object.freeze({
    scope: health.scope,
    completionTracked: health.completion_tracked,
    attendanceTracked: health.attendance_outcomes_tracked === true,
    minimumPairs: health.min_pairs,
    cycles: Object.freeze(cycles),
  });
}

const HIDDEN_TITLE = 'Hidden so it cannot point to a single pair';

/** Display text for one cell. `title` is the longer explanation. */
export function cellView(metric, cell, { pairs = 0 } = {}) {
  if (cell.status === 'ok') {
    if (metric.kind === 'percent') return { text: `${cell.value}%`, state: 'ok' };
    if (metric.kind === 'pairs') return { text: `${cell.value} of ${pairs}`, state: 'ok' };
    return { text: String(cell.value), state: 'ok' };
  }
  if (cell.status === 'suppressed') return { text: 'Hidden', state: 'suppressed', title: HIDDEN_TITLE };
  if (cell.status === 'not_tracked') return { text: 'Not tracked', state: 'not-tracked' };
  return { text: '—', state: 'none', title: 'No pairs this cycle' };
}

/** Columns for this circle: completion is not recorded for secondary circles. */
export function visibleMetrics(health) {
  return METRICS.filter(metric => metric.key !== 'completed_pairs' || health.completionTracked);
}

export function cycleLabel(cycle, weekLabel) {
  let label = null;
  try { label = typeof weekLabel === 'function' ? weekLabel({ week_start: cycle.starts_at, week_label: cycle.cycle_id }) : null; } catch { label = null; }
  return typeof label === 'string' && label.trim() ? label.trim() : cycle.cycle_id;
}

export function footnoteText(health) {
  const notes = ['Only finished cycles are shown; this week\'s pairs are on the Pairing tab.'];
  if (!health.completionTracked) notes.push('This circle does not record completed sessions.');
  notes.push(health.attendanceTracked
    ? 'Time to agree a session will appear once it is recorded.'
    : 'Cancellations, no-shows and time to agree a session will appear once they are recorded.');
  return notes.join(' ');
}

function element(doc, tag, { className, text, attrs } = {}) {
  const node = doc.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  for (const [name, value] of Object.entries(attrs || {})) node.setAttribute(name, value);
  return node;
}

export function renderHealthTable(doc, table, health, { weekLabel } = {}) {
  const metrics = visibleMetrics(health);
  table.replaceChildren();
  table.appendChild(element(doc, 'caption', { className: 'sr-only',
    text: `Circle health for the last ${health.cycles.length} finished cycles, newest first. Pair counts are hidden when they could point to a single pair.` }));
  const head = element(doc, 'thead');
  const headRow = element(doc, 'tr');
  headRow.appendChild(element(doc, 'th', { text: 'Cycle', attrs: { scope: 'col' } }));
  for (const metric of metrics) headRow.appendChild(element(doc, 'th', { text: metric.label, attrs: { scope: 'col' } }));
  head.appendChild(headRow);
  const body = element(doc, 'tbody');
  for (const cycle of health.cycles) {
    const row = element(doc, 'tr', { attrs: { 'data-testid': 'circle-health-row', 'data-cycle': cycle.cycle_id } });
    row.appendChild(element(doc, 'th', { text: cycleLabel(cycle, weekLabel), attrs: { scope: 'row' } }));
    for (const metric of metrics) {
      const view = cellView(metric, cycle.metrics[metric.key], { pairs: cycle.metrics.pairs.value });
      const attrs = { 'data-metric': metric.key, 'data-state': view.state };
      if (view.title) attrs.title = view.title;
      row.appendChild(element(doc, 'td', { text: view.text, attrs }));
    }
    body.appendChild(row);
  }
  table.append(head, body);
}

export function renderDefinitions(doc, list) {
  list.replaceChildren();
  for (const metric of METRICS) {
    list.append(element(doc, 'dt', { text: metric.label }), element(doc, 'dd', { text: metric.help }));
  }
  list.append(element(doc, 'dt', { text: 'Hidden' }),
    element(doc, 'dd', { text: 'Pair counts are hidden for cycles with fewer than 3 pairs, and when exactly one pair is in or out of a count, so a number cannot point to a single pair. When every pair, or no pair, did something, the number says so.' }));
}

/**
 * Wire the panel. `host` supplies:
 *   canView()            owner + capability hint (the server decides)
 *   cacheKey()           account and circle-context identity for the memory cache
 *   capture()/matches()  circle-context guards from index.html
 *   fetch()              GET /api/circle/health through the app's api()
 *   weekLabel(item)      optional human week label
 *   now()                optional clock for the short memory cache
 */
export function mountCircleHealth({ doc = document, host }) {
  const panel = doc.getElementById('circleHealthPanel');
  const status = doc.getElementById('circleHealthStatus');
  const wrap = doc.getElementById('circleHealthTableWrap');
  const table = doc.getElementById('circleHealthTable');
  const empty = doc.getElementById('circleHealthEmpty');
  const footnote = doc.getElementById('circleHealthFootnote');
  const refresh = doc.getElementById('circleHealthRefresh');
  const definitions = doc.getElementById('circleHealthDefinitions');
  if (!panel || !status || !wrap || !table || !empty || !footnote || !refresh) return null;
  if (definitions) renderDefinitions(doc, definitions);
  let epoch = 0;
  let cache = null;
  let inflight = null;
  const now = () => (typeof host.now === 'function' ? host.now() : Date.now());

  function setVisible(visible) {
    panel.hidden = !visible;
    panel.style.display = visible ? '' : 'none';
  }

  function render(health) {
    const hasCycles = health.cycles.length > 0;
    wrap.hidden = !hasCycles;
    empty.hidden = hasCycles;
    if (hasCycles) renderHealthTable(doc, table, health, { weekLabel: host.weekLabel });
    else table.replaceChildren();
    footnote.textContent = footnoteText(health);
    footnote.hidden = !footnote.textContent;
    status.textContent = '';
    refresh.textContent = 'Refresh';
  }

  function clear() {
    table.replaceChildren();
    wrap.hidden = true;
    empty.hidden = true;
    footnote.hidden = true;
    footnote.textContent = '';
    status.textContent = '';
  }

  function load() {
    if (!host.canView()) return Promise.resolve(false);
    // Nothing is requested while the circle context is changing; checked
    // before any request is recorded, so a later call can still load.
    const operation = host.capture();
    if (!host.matches(operation)) return Promise.resolve(false);
    const key = host.cacheKey();
    // One request per circle context; a newer context supersedes an older one.
    if (inflight && inflight.key === key) return inflight.promise;
    const entry = { key, promise: fetchHealth(key, operation) };
    inflight = entry;
    const settle = () => { if (inflight === entry) inflight = null; };
    entry.promise.then(settle, settle);
    return entry.promise;
  }

  async function fetchHealth(key, operation) {
    const started = ++epoch;
    refresh.disabled = true;
    wrap.setAttribute('aria-busy', 'true');
    status.textContent = 'Loading circle health…';
    try {
      const response = await host.fetch();
      if (started !== epoch || !host.matches(operation, response)) return false;
      const health = normalizeHealthResponse(response);
      if (!health) throw new Error('invalid circle health response');
      cache = { key, health, at: now() };
      render(health);
      return true;
    } catch (error) {
      if (started !== epoch || !host.matches(operation)) return false;
      const code = Number(error?.http_status);
      if (code === 403 || code === 404) {
        // No longer an owner, or the feature was switched off.
        cache = null;
        clear();
        setVisible(false);
        return false;
      }
      status.textContent = 'Circle health is unavailable right now.';
      refresh.textContent = 'Try again';
      return false;
    } finally {
      if (started === epoch) {
        refresh.disabled = false;
        wrap.setAttribute('aria-busy', 'false');
      }
    }
  }

  refresh.addEventListener('click', () => { void load(); });

  return Object.freeze({
    /** Show the panel for an owner; reuses a recent copy for the same circle. */
    show() {
      if (!host.canView()) {
        setVisible(false);
        return Promise.resolve(false);
      }
      setVisible(true);
      if (cache && cache.key === host.cacheKey() && now() - cache.at < CACHE_TTL_MS) {
        render(cache.health);
        return Promise.resolve(true);
      }
      return load();
    },
    refresh: load,
    /** Drop the memory copy (for example after this tab publishes a cycle). */
    invalidate() {
      cache = null;
    },
    reset() {
      epoch += 1;
      inflight = null;
      cache = null;
      refresh.disabled = false;
      wrap.setAttribute('aria-busy', 'false');
      clear();
      setVisible(false);
    },
  });
}

const api = Object.freeze({
  CACHE_TTL_MS,
  METRICS,
  cellView,
  cycleLabel,
  footnoteText,
  mountCircleHealth,
  normalizeCell,
  normalizeHealthResponse,
  renderDefinitions,
  renderHealthTable,
  visibleMetrics,
});

if (typeof window !== 'undefined' && window) {
  window.RandoriCircleHealth = api;
  try { window.dispatchEvent(new Event('randori:circle-health-ready')); } catch { /* old browsers */ }
}

export default api;
