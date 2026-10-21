// Personal progress in History (issue #293, ID-72), behind
// PROGRESS_DASHBOARD_ENABLED. The visual design is provisional (needs-design).
//
// index.html imports this module on demand, only after /api/history says the
// dashboard is on, so nothing is downloaded while the flag is off. Every
// number comes from the server (/api/progress) and is validated here before
// it renders; nothing is derived from browser storage. Rendering uses DOM
// nodes and textContent only. Each chart is an aria-hidden SVG with a text
// summary beside it and the same numbers in a table.
const SVG_NS = 'http://www.w3.org/2000/svg';
const CYCLE_ID = /^\d{4}-W(?:0[1-9]|[1-4]\d|5[0-3])$/;
const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const KEY = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const STATUSES = ['completed', 'in_progress', 'not_available', 'solo', 'no_pairing', 'not_completed'];
const PAUSED = new Set(['not_available', 'solo', 'no_pairing']);
const MAX_WEEKS = 12;
const MAX_GROUPS = 200;
const WEEK_LOCALE = 'en-GB';

export const STATUS_COPY = Object.freeze({
  completed: 'Session completed',
  in_progress: 'This week, not confirmed yet',
  not_available: 'Skipped this cycle (streak paused)',
  solo: 'Solo week (streak paused)',
  no_pairing: 'Not paired (streak paused)',
  not_completed: 'No session recorded',
  awaiting_participants: 'Not everyone confirmed',
});

const LEGEND = Object.freeze([
  ['completed', 'Completed'],
  ['in_progress', 'This week'],
  ['paused', 'Paused'],
  ['not_completed', 'Not recorded'],
]);

function count(value, max = Number.MAX_SAFE_INTEGER) {
  return Number.isSafeInteger(value) && value >= 0 && value <= max ? value : null;
}

function instant(value) {
  if (typeof value !== 'string' || !ISO_INSTANT.test(value)) return null;
  const time = Date.parse(value);
  return Number.isFinite(time) && new Date(time).toISOString() === value ? time : null;
}

function plural(value, one, many = `${one}s`) {
  return `${value} ${value === 1 ? one : many}`;
}

function normalizeWeek(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const start = instant(raw.starts_at);
  const end = instant(raw.ends_at);
  const verified = count(raw.verified_runs);
  const passed = count(raw.passed_runs, verified ?? -1);
  const completion = raw.completion ?? null;
  const pending = raw.status === 'not_completed' || raw.status === 'in_progress';
  if (typeof raw.cycle_id !== 'string' || !CYCLE_ID.test(raw.cycle_id) || start === null || end === null
    || end <= start || !STATUSES.includes(raw.status) || verified === null || passed === null
    || (pending ? !['not_recorded', 'awaiting_participants'].includes(completion) : completion !== null)) return null;
  return { cycleId: raw.cycle_id, startsAt: raw.starts_at, start, status: raw.status, completion, verified, passed };
}

function normalizeGroups(list) {
  if (!Array.isArray(list) || list.length > MAX_GROUPS) return null;
  const groups = list.map(raw => {
    const exercises = count(raw?.exercises);
    const attempted = count(raw?.attempted, exercises ?? -1);
    const solved = count(raw?.solved, attempted ?? -1);
    if (typeof raw?.key !== 'string' || raw.key.length > 80 || !KEY.test(raw.key) || !exercises
      || attempted === null || solved === null) return null;
    return { key: raw.key, exercises, attempted, solved };
  });
  return groups.every(Boolean) ? groups : null;
}

/** Validates an /api/progress body for the signed-in member, or returns null. */
export function normalizeProgress(raw, { userId } = {}) {
  if (!raw || typeof raw !== 'object' || raw.ok !== true || raw.user?.id !== userId) return null;
  const sessions = raw.sessions;
  const completed = count(sessions?.completed);
  const pairings = count(sessions?.pairings);
  const soloCompleted = count(sessions?.solo_completed, completed ?? -1);
  const streak = raw.streak;
  const longest = count(streak?.longest_weeks);
  const current = count(streak?.current_weeks, longest ?? -1);
  const weeks = Array.isArray(raw.weeks) && raw.weeks.length >= 1 && raw.weeks.length <= MAX_WEEKS
    ? raw.weeks.map(normalizeWeek) : null;
  const runs = raw.runs;
  const verified = count(runs?.verified);
  const passed = count(runs?.passed, verified ?? -1);
  const exercises = raw.coverage?.exercises;
  const total = count(exercises?.total);
  const attempted = count(exercises?.attempted, total ?? -1);
  const solved = count(exercises?.solved, attempted ?? -1);
  const patterns = normalizeGroups(raw.coverage?.patterns);
  const topics = normalizeGroups(raw.coverage?.topics);
  const roles = raw.roles;
  const candidate = count(roles?.candidate);
  const interviewer = count(roles?.interviewer);
  if (completed === null || pairings === null || completed > pairings || soloCompleted === null
    || typeof sessions.window_limited !== 'boolean' || current === null || longest === null
    || !STATUSES.includes(streak.this_week) || !weeks || weeks.some(week => !week)
    || weeks.some((week, index) => index > 0 && week.start <= weeks[index - 1].start)
    || weeks.at(-1).status !== streak.this_week
    || verified === null || passed === null || typeof runs.scan_limited !== 'boolean'
    || weeks.reduce((sum, week) => sum + week.verified, 0) !== verified
    || total === null || attempted === null || solved === null || !patterns || !topics
    || typeof raw.time_zone !== 'string' || !raw.time_zone || raw.time_zone.length > 100
    || typeof roles?.available !== 'boolean'
    || (roles.available && (candidate === null || interviewer === null || candidate + interviewer < 1
      || roles.sessions !== candidate + interviewer))) return null;
  return {
    timeZone: raw.time_zone,
    sessions: { completed, pairings, soloCompleted, windowLimited: sessions.window_limited },
    streak: { current, longest, thisWeek: streak.this_week },
    weeks,
    runs: { verified, passed, scanLimited: runs.scan_limited },
    coverage: { exercises: { total, attempted, solved }, patterns, topics },
    roles: roles.available ? { candidate, interviewer, sessions: roles.sessions } : null,
  };
}

/** "Week of 25 Oct" in the cycle's own time zone, like the rest of the app. */
export function weekLabel(startsAt, timeZone) {
  const date = new Date(startsAt);
  const options = { day: 'numeric', month: 'short' };
  try {
    return `Week of ${new Intl.DateTimeFormat(WEEK_LOCALE, { ...options, timeZone }).format(date)}`;
  } catch {
    return `Week of ${new Intl.DateTimeFormat(WEEK_LOCALE, { ...options, timeZone: 'UTC' }).format(date)}`;
  }
}

export function patternLabel(key) {
  const text = String(key || '').replace(/-/g, ' ');
  return text ? text[0].toUpperCase() + text.slice(1) : '';
}

export function statusLabel(week) {
  if (week.status === 'not_completed' && week.completion === 'awaiting_participants') return STATUS_COPY.awaiting_participants;
  return STATUS_COPY[week.status];
}

export function streakSentence(view) {
  const rule = 'A week counts when everyone in your pair confirms the session. Skipped, solo and unpaired weeks pause your streak; they never end it.';
  let lead;
  if (view.streak.current > 0) lead = `You have practised with a partner ${plural(view.streak.current, 'week')} in a row.`;
  else if (view.streak.longest > 0) lead = 'Your next completed session starts a new streak.';
  else lead = 'Complete a session with your pair, and both confirm it in the room’s Session panel, to start a streak.';
  const pending = view.streak.thisWeek === 'in_progress' ? ' This week still counts once you both confirm it.' : '';
  return `${lead}${pending} ${rule}`;
}

export function weeksSummary(weeks) {
  const completed = weeks.filter(week => week.status === 'completed').length;
  const paused = weeks.filter(week => PAUSED.has(week.status)).length;
  const missed = weeks.filter(week => week.status === 'not_completed').length;
  const parts = [`${plural(completed, 'week')} with a completed session`];
  if (paused) parts.push(`${plural(paused, 'paused week')}`);
  if (missed) parts.push(`${plural(missed, 'week')} with no session recorded`);
  return `Last ${plural(weeks.length, 'week')}: ${parts.join(', ')}.`;
}

export function runsSummary(view) {
  const { verified, passed } = view.runs;
  const span = `the last ${plural(view.weeks.length, 'week')}`;
  if (!verified) return `No verified runs in ${span}. Runs you make in a room or in solo practice appear here.`;
  const busiest = view.weeks.reduce((best, week) => (week.verified > best.verified ? week : best));
  return `${plural(verified, 'verified run')} in ${span}, ${passed} passed every case. Most runs: ${busiest.verified} in the ${weekLabel(busiest.startsAt, view.timeZone).toLowerCase()}.`;
}

export function coverageState(group) {
  if (group.solved === group.exercises) return { label: 'Solved', tone: 'success' };
  if (group.solved > 0) return { label: 'Partly solved', tone: 'info' };
  if (group.attempted > 0) return { label: 'Tried', tone: 'warning' };
  return { label: 'Not started', tone: '' };
}

export function coverageSummary(coverage) {
  const started = coverage.patterns.filter(group => group.attempted > 0).length;
  const { total, attempted, solved } = coverage.exercises;
  return `${started} of ${plural(coverage.patterns.length, 'pattern')} started. ${solved} of ${plural(total, 'exercise')} solved, ${attempted} tried.`;
}

export function rolesSentence(roles) {
  return `In ${plural(roles.sessions, 'completed session')} with roles recorded you were the candidate ${plural(roles.candidate, 'time')} and the interviewer ${plural(roles.interviewer, 'time')}.`;
}

// ---------------------------------------------------------------- rendering

function node(doc, tag, { className = '', text = null, testid = '' } = {}) {
  const element = doc.createElement(tag);
  if (className) element.className = className;
  if (text !== null) element.textContent = text;
  if (testid) element.dataset.testid = testid;
  return element;
}

function svg(doc, tag, attributes = {}) {
  const element = doc.createElementNS(SVG_NS, tag);
  for (const [name, value] of Object.entries(attributes)) element.setAttribute(name, String(value));
  return element;
}

function badge(doc, label, tone) {
  return node(doc, 'span', { className: `rc-badge${tone ? ` rc-badge--${tone}` : ''}`, text: label });
}

function chart(doc, width, height) {
  // The figure's text summary and the table carry the meaning.
  return svg(doc, 'svg', { class: 'progress-chart', viewBox: `0 0 ${width} ${height}`, 'aria-hidden': 'true', focusable: 'false' });
}

function weeksChart(doc, weeks) {
  const graphic = chart(doc, weeks.length * 24, 24);
  weeks.forEach((week, index) => {
    const group = PAUSED.has(week.status) ? 'paused' : week.status;
    graphic.appendChild(svg(doc, 'rect', {
      class: `progress-week progress-week--${group}`, x: index * 24 + 3, y: 3, width: 18, height: 18, rx: 4,
    }));
  });
  return graphic;
}

function runsChart(doc, weeks) {
  const peak = Math.max(1, ...weeks.map(week => week.verified));
  const graphic = chart(doc, weeks.length * 24, 64);
  weeks.forEach((week, index) => {
    const verified = Math.round((week.verified / peak) * 60);
    const passed = Math.round((week.passed / peak) * 60);
    graphic.appendChild(svg(doc, 'rect', { class: 'progress-bar progress-bar--verified', x: index * 24 + 4, y: 62 - verified, width: 16, height: Math.max(verified, 2) }));
    if (passed) graphic.appendChild(svg(doc, 'rect', { class: 'progress-bar progress-bar--passed', x: index * 24 + 8, y: 62 - passed, width: 8, height: passed }));
  });
  return graphic;
}

function figure(doc, { testid, title, summary, graphic, legend }) {
  const element = node(doc, 'figure', { className: 'progress-figure', testid });
  const caption = node(doc, 'figcaption', { className: 'progress-figcaption' });
  caption.append(node(doc, 'h4', { className: 'circle-subtitle', text: title }),
    node(doc, 'p', { className: 'small muted progress-summary', text: summary, testid: `${testid}-summary` }));
  element.append(caption, graphic);
  const list = node(doc, 'ul', { className: 'progress-legend small muted' });
  for (const [key, label] of legend) {
    const item = node(doc, 'li');
    item.append(node(doc, 'span', { className: `progress-swatch progress-swatch--${key}` }), label);
    list.appendChild(item);
  }
  element.appendChild(list);
  return element;
}

function weeksTable(doc, view) {
  const details = node(doc, 'details', { className: 'progress-details', testid: 'progress-weeks-table' });
  details.appendChild(node(doc, 'summary', { text: 'Show weeks as a table' }));
  const table = node(doc, 'table', { className: 'rc-table progress-table' });
  table.appendChild(node(doc, 'caption', { className: 'sr-only', text: 'Sessions and verified runs by week, oldest first' }));
  const head = node(doc, 'thead');
  const headRow = node(doc, 'tr');
  for (const label of ['Week', 'Session', 'Verified runs', 'Passed every case']) {
    const cell = node(doc, 'th', { text: label });
    cell.setAttribute('scope', 'col');
    headRow.appendChild(cell);
  }
  head.appendChild(headRow);
  const body = node(doc, 'tbody');
  for (const week of view.weeks) {
    const row = node(doc, 'tr');
    row.dataset.cycle = week.cycleId;
    row.dataset.status = week.status;
    const label = node(doc, 'th', { text: weekLabel(week.startsAt, view.timeZone) });
    label.setAttribute('scope', 'row');
    row.append(label, node(doc, 'td', { text: statusLabel(week) }),
      node(doc, 'td', { text: String(week.verified) }), node(doc, 'td', { text: String(week.passed) }));
    body.appendChild(row);
  }
  table.append(head, body);
  details.appendChild(table);
  return details;
}

function coverageList(doc, groups, testid) {
  const list = node(doc, 'ul', { className: 'progress-coverage', testid });
  for (const group of groups) {
    const state = coverageState(group);
    const item = node(doc, 'li', { className: 'progress-coverage-row' });
    item.dataset.key = group.key;
    item.dataset.state = state.label === 'Not started' ? 'untouched' : 'started';
    const head = node(doc, 'div', { className: 'progress-coverage-head' });
    head.append(node(doc, 'b', { text: patternLabel(group.key) }), badge(doc, state.label, state.tone));
    const meter = node(doc, 'progress', { className: 'progress-meter' });
    meter.max = group.exercises;
    meter.value = group.solved;
    meter.setAttribute('aria-hidden', 'true');
    const detail = node(doc, 'span', {
      className: 'small muted',
      text: `${group.solved} of ${plural(group.exercises, 'exercise')} solved${group.attempted > group.solved ? `, ${group.attempted} tried` : ''}`,
    });
    item.append(head, meter, detail);
    list.appendChild(item);
  }
  return list;
}

function tile(doc, label, value, testid) {
  const item = node(doc, 'div', { className: 'progress-tile', testid });
  item.append(node(doc, 'dt', { className: 'small muted', text: label }), node(doc, 'dd', { className: 'progress-tile-value', text: value }));
  return item;
}

function card(doc, section, view) {
  const article = node(doc, 'article', { className: 'card circle-card progress-card' });
  const head = node(doc, 'div', { className: 'card-h' });
  const heading = node(doc, 'div', { className: 'circle-header-text' });
  const title = node(doc, 'h3', { className: 'circle-card-title', text: 'Your progress' });
  title.id = 'historyProgressTitle';
  heading.appendChild(title);
  heading.appendChild(node(doc, 'p', {
    className: 'circle-card-meta',
    text: view ? `Private to you. Weeks run from Sunday 08:00 (${view.timeZone}).` : 'Private to you.',
  }));
  head.appendChild(heading);
  const body = node(doc, 'div', { className: 'card-b progress-body' });
  article.append(head, body);
  section.replaceChildren(article);
  return body;
}

function status(doc, text, { visible = true } = {}) {
  const element = node(doc, 'p', { className: visible ? 'small muted' : 'sr-only', text, testid: 'progress-status' });
  element.setAttribute('role', 'status');
  return element;
}

export function renderProgress(doc, section, view) {
  const body = card(doc, section, view);
  body.appendChild(status(doc, 'Progress loaded', { visible: false }));

  const tiles = node(doc, 'dl', { className: 'progress-tiles' });
  const { exercises } = view.coverage;
  tiles.append(
    tile(doc, 'Completed sessions', String(view.sessions.completed), 'progress-completed'),
    tile(doc, 'Weekly streak', plural(view.streak.current, 'week'), 'progress-streak'),
    tile(doc, 'Longest streak', plural(view.streak.longest, 'week'), 'progress-longest'),
    tile(doc, 'Exercises solved', `${exercises.solved} of ${exercises.total}`, 'progress-solved'),
  );
  body.appendChild(tiles);
  body.appendChild(node(doc, 'p', { className: 'small progress-note', text: streakSentence(view), testid: 'progress-streak-note' }));
  if (!view.sessions.pairings && !view.runs.verified) {
    const empty = node(doc, 'p', { className: 'small muted progress-empty', testid: 'progress-empty' });
    empty.textContent = 'Your progress starts with your first pairing. After each session, both of you confirm it in the room’s Session panel.';
    body.appendChild(empty);
  }
  if (view.sessions.windowLimited || view.runs.scanLimited) {
    body.appendChild(node(doc, 'p', { className: 'small muted', text: 'Totals cover your most recent records only.' }));
  }

  const charts = node(doc, 'div', { className: 'progress-charts' });
  charts.append(
    figure(doc, { testid: 'progress-weeks', title: 'Weekly sessions', summary: weeksSummary(view.weeks), graphic: weeksChart(doc, view.weeks), legend: LEGEND }),
    figure(doc, {
      testid: 'progress-runs', title: 'Verified runs', summary: runsSummary(view), graphic: runsChart(doc, view.weeks),
      legend: [['verified', 'Verified runs'], ['passed', 'Passed every case']],
    }),
  );
  body.append(charts, weeksTable(doc, view));

  const coverage = node(doc, 'section', { className: 'progress-section', testid: 'progress-coverage' });
  coverage.setAttribute('aria-label', 'Pattern coverage');
  coverage.append(node(doc, 'h4', { className: 'circle-subtitle', text: 'Patterns' }),
    node(doc, 'p', { className: 'small muted', text: coverageSummary(view.coverage), testid: 'progress-coverage-summary' }),
    coverageList(doc, view.coverage.patterns, 'progress-patterns'));
  const topics = node(doc, 'details', { className: 'progress-details', testid: 'progress-topics' });
  topics.append(node(doc, 'summary', { text: `All topics (${view.coverage.topics.length})` }),
    coverageList(doc, view.coverage.topics, 'progress-topic-list'));
  coverage.appendChild(topics);
  body.appendChild(coverage);

  if (view.roles) {
    const roles = node(doc, 'section', { className: 'progress-section', testid: 'progress-roles' });
    roles.setAttribute('aria-label', 'Interview roles');
    const graphic = chart(doc, 100, 12);
    const share = Math.round((view.roles.candidate / view.roles.sessions) * 100);
    graphic.append(svg(doc, 'rect', { class: 'progress-role progress-role--candidate', x: 0, y: 0, width: share, height: 12 }),
      svg(doc, 'rect', { class: 'progress-role progress-role--interviewer', x: share, y: 0, width: 100 - share, height: 12 }));
    roles.append(node(doc, 'h4', { className: 'circle-subtitle', text: 'Interview roles' }),
      node(doc, 'p', { className: 'small muted', text: rolesSentence(view.roles), testid: 'progress-roles-summary' }), graphic,
      node(doc, 'p', { className: 'small muted', text: 'Uses the last role set in each session’s shared controls.' }));
    body.appendChild(roles);
  }
}

function renderLoading(doc, section) {
  const body = card(doc, section, null);
  body.appendChild(status(doc, 'Loading your progress…'));
  const skeleton = node(doc, 'div', { className: 'history-skeleton' });
  skeleton.setAttribute('aria-hidden', 'true');
  for (let index = 0; index < 2; index += 1) skeleton.appendChild(node(doc, 'span', { className: 'rc-skeleton' }));
  body.appendChild(skeleton);
}

function renderError(doc, section, retry) {
  const body = card(doc, section, null);
  body.appendChild(status(doc, 'Progress is unavailable right now.'));
  const button = node(doc, 'button', { className: 'btn secondary sm', text: 'Retry', testid: 'progress-retry' });
  button.type = 'button';
  button.addEventListener('click', () => { void retry(); });
  body.appendChild(button);
}

/**
 * host: { userId(), visible(), fetchProgress(signal) }. Requests are fenced by
 * an epoch, the signed-in member and History being visible, so a sign-out, a
 * tab change or a slower earlier response never renders.
 */
export function mountProgress({ doc, host }) {
  const section = doc.getElementById('historyProgress');
  if (!section) return Object.freeze({ load: async () => false, reset() {}, resume: async () => false, stop() {} });
  let epoch = 0;
  let abort = null;
  let resumeWanted = false;
  let shown = false;

  function stop() {
    epoch += 1;
    resumeWanted = !!abort;
    abort?.abort();
    abort = null;
  }

  function reset() {
    stop();
    resumeWanted = false;
    shown = false;
    section.replaceChildren();
    section.hidden = true;
    section.setAttribute('aria-busy', 'false');
  }

  async function load() {
    const userId = host.userId();
    if (!userId || !host.visible()) return false;
    stop();
    resumeWanted = false;
    const current = epoch;
    const controller = new AbortController();
    abort = controller;
    const stale = () => current !== epoch || host.userId() !== userId || !host.visible();
    section.hidden = false;
    section.setAttribute('aria-busy', 'true');
    if (!shown) renderLoading(doc, section);
    try {
      const response = await host.fetchProgress(controller.signal);
      const body = await response.json().catch(() => null);
      if (stale()) return false;
      if (response.status === 404 && body?.ok !== true) {
        // The flag was switched off after History loaded: show nothing.
        reset();
        return false;
      }
      const view = response.ok ? normalizeProgress(body, { userId }) : null;
      if (!view) throw new Error('progress unavailable');
      renderProgress(doc, section, view);
      shown = true;
    } catch {
      if (!stale()) {
        shown = false;
        renderError(doc, section, load);
      }
    } finally {
      if (abort === controller) abort = null;
      if (current === epoch) section.setAttribute('aria-busy', 'false');
    }
    return shown && !stale();
  }

  function resume() {
    if (!resumeWanted) return Promise.resolve(false);
    return load();
  }

  return Object.freeze({ load, reset, resume, stop });
}
