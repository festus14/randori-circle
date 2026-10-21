// Owner "Circle health" panel (issue #292, provisional design: needs-design).
//
// Loaded by index.html as `<script type="module">`. The pure helpers validate
// the server response and turn each cell into display text; the controller
// renders a text-only table into the static panel. Every request, ownership
// hint and circle-context guard comes from the host object index.html passes
// in. The server is authoritative for ownership and has already suppressed
// small cells, so this file only displays what it is given and never stores
// it anywhere but memory (cleared by `reset()` on any identity or circle
// change).

export const METRICS = Object.freeze([
  Object.freeze({ key: 'available', label: 'Available', kind: 'count',
    help: 'Members who were in for the cycle when the pairs were published.' }),
  Object.freeze({ key: 'paired', label: 'Paired', kind: 'count',
    help: 'Members placed with a partner.' }),
  Object.freeze({ key: 'scheduled', label: 'Agreed a time', kind: 'count',
    help: 'Paired members whose pair agreed a session time.' }),
  Object.freeze({ key: 'completed', label: 'Completed', kind: 'count',
    help: 'Paired members whose pair confirmed the session took place.' }),
  Object.freeze({ key: 'solo', label: 'Solo', kind: 'count',
    help: 'The odd member, who practised solo that cycle.' }),
  Object.freeze({ key: 'median_hours_to_agreed_time', label: 'Pairing to session', kind: 'hours',
    help: 'Median time from publishing the pairs to the agreed session time.' }),
  Object.freeze({ key: 'repeat_pair_percent', label: 'Repeat pairs', kind: 'percent',
    help: 'Share of pairs who were also paired in one of the 8 cycles before.' }),
]);

const SERVER_METRICS = [...METRICS.map(metric => metric.key), 'cancelled', 'no_show'];
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
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return false;
  if (kind === 'percent') return Number.isInteger(value) && value <= 100;
  if (kind === 'hours') return value < 24 * 366;
  return Number.isInteger(value) && value <= 100000;
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
    || typeof cycle.in_progress !== 'boolean' || typeof cycle.suppressed !== 'boolean'
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
  return Object.freeze({
    cycle_id: cycle.cycle_id,
    starts_at: cycle.starts_at,
    in_progress: cycle.in_progress,
    suppressed: cycle.suppressed,
    metrics: Object.freeze(normalized),
  });
}

/** Validate a GET /api/circle/health body; null means render nothing. */
export function normalizeHealthResponse(raw) {
  const body = record(raw);
  const health = record(body?.health);
  if (body?.ok !== true || !health || !['primary', 'secondary'].includes(health.scope)
    || typeof health.completion_tracked !== 'boolean' || !Number.isInteger(health.min_cell_size)
    || health.min_cell_size < 2 || !Array.isArray(health.cycles) || health.cycles.length > MAX_CYCLES) {
    return null;
  }
  const cycles = health.cycles.map(normalizeCycle);
  if (cycles.some(cycle => !cycle)) return null;
  return Object.freeze({
    scope: health.scope,
    completionTracked: health.completion_tracked,
    attendanceTracked: health.attendance_outcomes_tracked === true,
    minimum: health.min_cell_size,
    cycles: Object.freeze(cycles),
  });
}

/** "9 h", "36 h", "2.5 days". */
export function formatDuration(hours) {
  if (hours < 1) return 'under 1 h';
  if (hours < 48) return `${Math.round(hours)} h`;
  const days = Math.round((hours / 24) * 10) / 10;
  return `${days} days`;
}

/** Display text for one cell. `title` is the longer explanation. */
export function cellView(metric, cell, { minimum = 3 } = {}) {
  if (cell.status === 'ok') {
    if (metric.kind === 'percent') return { text: `${cell.value}%`, state: 'ok' };
    if (metric.kind === 'hours') return { text: formatDuration(cell.value), state: 'ok' };
    return { text: String(cell.value), state: 'ok' };
  }
  if (cell.status === 'suppressed') {
    return { text: 'Hidden', state: 'suppressed', title: `Hidden so it cannot describe fewer than ${minimum} members` };
  }
  if (cell.status === 'not_tracked') return { text: 'Not tracked', state: 'not-tracked' };
  return { text: '—', state: 'none', title: 'Nothing to measure yet' };
}

/** Columns for this circle: completion is not recorded for secondary circles. */
export function visibleMetrics(health) {
  return METRICS.filter(metric => metric.key !== 'completed' || health.completionTracked);
}

export function cycleLabel(cycle, weekLabel) {
  let label = null;
  try { label = typeof weekLabel === 'function' ? weekLabel({ week_start: cycle.starts_at, week_label: cycle.cycle_id }) : null; } catch { label = null; }
  return typeof label === 'string' && label.trim() ? label.trim() : cycle.cycle_id;
}

export function footnoteText(health) {
  const notes = [];
  if (!health.completionTracked) notes.push('This circle does not record completed sessions.');
  if (!health.attendanceTracked) notes.push('Cancellations and no-shows will appear once cancel and no-show reporting is available.');
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
    text: `Circle health for the last ${health.cycles.length} cycles, newest first. Hidden values would describe fewer than ${health.minimum} members.` }));
  const head = element(doc, 'thead');
  const headRow = element(doc, 'tr');
  headRow.appendChild(element(doc, 'th', { text: 'Cycle', attrs: { scope: 'col' } }));
  for (const metric of metrics) headRow.appendChild(element(doc, 'th', { text: metric.label, attrs: { scope: 'col' } }));
  head.appendChild(headRow);
  const body = element(doc, 'tbody');
  for (const cycle of health.cycles) {
    const row = element(doc, 'tr', { attrs: { 'data-testid': 'circle-health-row', 'data-cycle': cycle.cycle_id } });
    const header = element(doc, 'th', { attrs: { scope: 'row' } });
    header.appendChild(element(doc, 'span', { text: cycleLabel(cycle, weekLabel) }));
    if (cycle.in_progress) {
      header.appendChild(doc.createTextNode(' '));
      header.appendChild(element(doc, 'span', { className: 'rc-badge', text: 'In progress', attrs: { 'data-tone': 'info' } }));
    }
    row.appendChild(header);
    if (cycle.suppressed) {
      row.setAttribute('data-suppressed', 'true');
      row.appendChild(element(doc, 'td', { className: 'circle-health-hidden',
        text: `Hidden: fewer than ${health.minimum} members took part`, attrs: { colspan: String(metrics.length) } }));
    } else {
      for (const metric of metrics) {
        const view = cellView(metric, cycle.metrics[metric.key], { minimum: health.minimum });
        const attrs = { 'data-metric': metric.key, 'data-state': view.state };
        if (view.title) attrs.title = view.title;
        row.appendChild(element(doc, 'td', { text: view.text, attrs }));
      }
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
    element(doc, 'dd', { text: 'Any number that would describe fewer than 3 members, or could be worked out from two other numbers, is hidden by the server so no one can be singled out.' }));
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
    const key = host.cacheKey();
    // One request per circle context; a newer context supersedes an older one.
    if (inflight && inflight.key === key) return inflight.promise;
    const promise = fetchHealth(key);
    inflight = { key, promise };
    return promise;
  }

  async function fetchHealth(key) {
    const operation = host.capture();
    const started = ++epoch;
    if (!host.matches(operation)) {
      inflight = null;
      return false;
    }
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
        inflight = null;
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
  formatDuration,
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
