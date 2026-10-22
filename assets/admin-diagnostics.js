// Admin diagnostics view (issue #310, ID-73).
//
// Loaded by index.html as `<script type="module">`. The pure helpers turn the
// `GET /api/admin/diagnostics` snapshot into card views, including each card's
// stale-data state; the controller renders them into the Circle view's
// Diagnostics disclosure. Who may see the view, every request and the
// confirmation dialog come from the host object index.html passes in. The
// server authorizes every request again; this file only renders.
//
// Everything is rendered with textContent. Nothing here stores data outside
// memory, and reset() clears it on any identity change.

export const SNAPSHOT_FORMAT = 'randori.admin-diagnostics.v1';
export const TICK_MS = 30 * 1000;

export const CARD_ORDER = Object.freeze(['outbox', 'outboxWatchdog', 'backupWatchdog', 'execution', 'readiness', 'errors']);

const CARD_TITLES = Object.freeze({
  outbox: 'Outbox delivery',
  outboxWatchdog: 'Outbox watchdog',
  backupWatchdog: 'Backup watchdog',
  execution: 'Code execution',
  readiness: 'Readiness and migrations',
  errors: 'Recent errors',
});

const EVIDENCE_NOUNS = Object.freeze({
  outbox: 'dispatcher run',
  execution: 'run',
  readiness: 'check',
  errors: 'log entry',
});

export const STATUS_VIEW = Object.freeze({
  healthy: Object.freeze({ label: 'Healthy', tone: 'success' }),
  degraded: Object.freeze({ label: 'Degraded', tone: 'warning' }),
  failed: Object.freeze({ label: 'Failed', tone: 'danger' }),
  unknown: Object.freeze({ label: 'No data', tone: 'neutral' }),
  unavailable: Object.freeze({ label: 'Unavailable', tone: 'danger' }),
  deferred: Object.freeze({ label: 'Deferred', tone: 'info' }),
});

export const REPLAY_REASON_LABELS = Object.freeze({
  OPERATOR_RETRY: 'Operator retry',
  PROVIDER_RECOVERED: 'Provider recovered',
  CONFIGURATION_FIXED: 'Configuration fixed',
});

const OUTBOX_CATEGORY_COPY = Object.freeze({
  delivery_stale: 'Due mail has waited longer than the 15-minute threshold.',
  lease_stale: 'An expired lease has not been reclaimed within 15 minutes.',
  dead_letters_recent: 'Some events were dead-lettered in the last 24 hours.',
  delivery_backlog: 'Mail is due but still inside the 15-minute threshold.',
});

const READINESS_COPY = Object.freeze({
  unconfigured: 'Readiness is not configured for this database.',
  not_ready: 'The readiness check fails.',
  check_failed: 'The readiness check could not run.',
});

const LEDGER_STATES = new Set(['current', 'behind', 'ahead', 'missing', 'invalid']);

function record(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
}

function finite(value) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function wholeNumber(value) {
  const number = Number(value);
  return Number.isSafeInteger(number) && number >= 0 ? number : 0;
}

function plural(count, one, many = `${one}s`) {
  return `${count} ${count === 1 ? one : many}`;
}

/** "45 s", "12 min", "3 h", "2 d"; "unknown" for missing values. */
export function formatDuration(ms) {
  const value = finite(ms);
  if (value === null || value < 0) return 'unknown';
  if (value < 60 * 1000) return `${Math.round(value / 1000)} s`;
  if (value < 90 * 60 * 1000) return `${Math.round(value / 60000)} min`;
  if (value < 48 * 60 * 60 * 1000) return `${Math.round(value / 3600000)} h`;
  return `${Math.round(value / 86400000)} d`;
}

/** "2026-10-20 09:15 UTC", or '' for a missing or invalid instant. */
export function formatInstant(value) {
  if (value === null || value === undefined || value === '') return '';
  const ms = Date.parse(String(value));
  if (!Number.isFinite(ms)) return '';
  return `${new Date(ms).toISOString().slice(0, 16).replace('T', ' ')} UTC`;
}

/**
 * Current age of a card's evidence: the server-measured age plus the time
 * since the snapshot was fetched. Stale when missing or past its cadence.
 * Deferred cards have no evidence and are never stale.
 */
export function evidenceState(evidence, elapsedMs = 0) {
  const source = record(evidence);
  if (!source) return Object.freeze({ tracked: false, stale: false, ageMs: null, maxAgeMs: null });
  const maxAgeMs = finite(source.maxAgeMs);
  const serverAge = source.ageMs === null || source.ageMs === undefined ? null : finite(source.ageMs);
  const ageMs = serverAge === null ? null : serverAge + Math.max(0, finite(elapsedMs) ?? 0);
  const stale = ageMs === null || maxAgeMs === null || ageMs > maxAgeMs;
  return Object.freeze({ tracked: true, stale, ageMs, maxAgeMs });
}

export function evidenceText(id, evidence, elapsedMs = 0) {
  const state = evidenceState(evidence, elapsedMs);
  if (!state.tracked) return '';
  const noun = EVIDENCE_NOUNS[id] || 'update';
  const cadence = `expected at least every ${formatDuration(state.maxAgeMs)}`;
  if (state.ageMs === null) return `No ${noun} recorded yet; ${cadence}.`;
  return `Last ${noun} ${formatDuration(state.ageMs)} ago; ${cadence}.`;
}

function outboxLines(card) {
  const totals = record(card.totals) || {};
  const lines = [card.category ? OUTBOX_CATEGORY_COPY[card.category] || 'Delivery needs attention.' : 'Nothing due is older than 15 minutes.'];
  const due = wholeNumber(totals.due);
  const oldest = totals.oldestDueAgeMs === null || totals.oldestDueAgeMs === undefined ? '' : ` (oldest ${formatDuration(totals.oldestDueAgeMs)})`;
  lines.push(`${due} due${oldest} · ${wholeNumber(totals.leased)} leased · ${plural(wholeNumber(totals.staleLeases), 'expired lease')} · ${wholeNumber(totals.deadLetter24h)} dead-lettered in 24 h.`);
  const delivered = formatInstant(totals.lastDeliveredAt);
  lines.push(delivered ? `Last delivery ${delivered}.` : 'No delivery recorded yet.');
  const reasons = Object.entries(record(card.recentRejectReasons) || {})
    .filter(([, count]) => wholeNumber(count) > 0)
    .map(([reason, count]) => `${reason} ×${wholeNumber(count)}`);
  if (reasons.length) lines.push(`Provider rejects in 24 h: ${reasons.join(', ')}.`);
  return lines;
}

function executionLines(card) {
  const lines = [];
  if (card.configured === true) lines.push(`Provider: ${String(card.provider || 'unknown')}.`);
  else if (card.reason === 'unsupported') lines.push('The configured execution provider is not supported, so Run is unavailable.');
  else if (card.reason === 'misconfigured') lines.push(`Provider ${String(card.provider || '')} has no valid endpoint, so Run is unavailable.`);
  else lines.push('No execution provider is configured, so Run is unavailable.');
  const recent = record(card.recent24h) || {};
  lines.push(`Last 24 h: ${wholeNumber(recent.success)} succeeded, ${wholeNumber(recent.failed)} failed, ${wholeNumber(recent.unavailable)} unavailable.`);
  lines.push(card.lastOutcome ? `Latest run: ${String(card.lastOutcome)}.` : 'No runs recorded yet.');
  lines.push('Scheduled provider smoke check: not built yet (#249).');
  return lines;
}

function ledgerLine(ledger) {
  const current = wholeNumber(ledger.currentVersion);
  const expected = wholeNumber(ledger.expectedVersion);
  if (ledger.state === 'current') return `Migration ledger: v${current} of v${expected} (current).`;
  if (ledger.state === 'behind') return `Migration ledger: v${current} of v${expected}; ${plural(expected - current, 'migration')} pending.`;
  if (ledger.state === 'ahead') return `The database schema (v${current}) is newer than this app (v${expected}).`;
  if (ledger.state === 'missing') return 'The migration ledger is missing.';
  return 'The migration ledger does not match the reviewed manifest.';
}

function readinessLines(card) {
  const lines = [card.ready === true ? 'The readiness check passes.' : READINESS_COPY[card.category] || 'The readiness check fails.'];
  const ledger = record(card.ledger);
  if (ledger) {
    lines.push(ledgerLine(ledger));
    const latest = record(ledger.latest);
    if (latest) lines.push(`Latest: v${wholeNumber(latest.version)} ${String(latest.name || '')}, ${String(latest.disposition || '')} ${formatInstant(latest.appliedAt)}.`.replace(/\s+\./u, '.'));
  }
  return lines;
}

function errorLines(card) {
  const totals = record(card.totals) || {};
  const bySource = record(card.bySource) || {};
  const sum = source => wholeNumber(bySource[source]?.error) + wholeNumber(bySource[source]?.warn);
  const lines = [`Last 24 h: ${plural(wholeNumber(totals.error), 'error')}, ${plural(wholeNumber(totals.warn), 'warning')}.`];
  const parts = [`Server ${sum('server')}`, `Client ${sum('client')}`, `Runner ${sum('runner')}`];
  if (sum('other')) parts.push(`Other ${sum('other')}`);
  lines.push(`${parts.join(' · ')}.`);
  for (const item of (Array.isArray(card.categories) ? card.categories : []).slice(0, 5)) {
    lines.push(`${String(item.source)} · ${String(item.event)} · ${String(item.level)} ×${wholeNumber(item.count)}`);
  }
  if (wholeNumber(card.otherCount)) lines.push(`${wholeNumber(card.otherCount)} more in smaller categories.`);
  return lines;
}

const DEFERRED_COPY = Object.freeze({
  outboxWatchdog: Object.freeze([
    'The hourly outbox watchdog stores its result only as a GitHub Actions artifact. Reading it here would need a GitHub token in the app, which would widen secret exposure.',
    'The Outbox delivery card applies the same 15-minute threshold to live data.',
  ]),
  backupWatchdog: Object.freeze([
    'The weekly restore rehearsal and its watchdog keep their evidence only in protected GitHub Actions runs, and the app has no copy.',
    'Readiness and the migration ledger are shown instead.',
  ]),
});

/** View model for one card: title, status badge, stale state and text lines. */
export function cardView(id, card, elapsedMs = 0) {
  const source = record(card) || { status: 'unavailable' };
  const status = STATUS_VIEW[source.status] ? source.status : 'unavailable';
  const state = status === 'deferred' ? evidenceState(null) : evidenceState(source.evidence, elapsedMs);
  let lines;
  if (status === 'unavailable') lines = ['This source could not be read. Try Refresh.'];
  else if (status === 'deferred') lines = [...(DEFERRED_COPY[id] || ['Not available yet.']), `Expected cadence: every ${formatDuration(source.cadenceMs)}.`];
  else if (id === 'outbox') lines = outboxLines(source);
  else if (id === 'execution') lines = executionLines(source);
  else if (id === 'readiness') lines = readinessLines(source);
  else if (id === 'errors') lines = errorLines(source);
  else lines = [];
  return Object.freeze({
    id,
    title: CARD_TITLES[id] || id,
    status,
    label: STATUS_VIEW[status].label,
    tone: STATUS_VIEW[status].tone,
    stale: state.stale,
    evidence: status === 'deferred' || status === 'unavailable' ? '' : evidenceText(id, source.evidence, elapsedMs),
    lines: Object.freeze(lines),
  });
}

function validDeadLetter(item) {
  const source = record(item);
  if (!source || !Number.isSafeInteger(source.id) || source.id < 1 || typeof source.eventType !== 'string') return null;
  return Object.freeze({
    id: source.id,
    eventType: source.eventType,
    eventVersion: wholeNumber(source.eventVersion),
    errorCode: typeof source.errorCode === 'string' ? source.errorCode : null,
    providerReason: typeof source.providerReason === 'string' ? source.providerReason : null,
    attempts: wholeNumber(source.attempts),
    replays: wholeNumber(source.replays),
    ageMs: source.ageMs === null || source.ageMs === undefined ? null : finite(source.ageMs),
  });
}

/** Validate a server snapshot. Returns a safe copy or null (nothing renders). */
export function normalizeSnapshot(payload) {
  const source = record(payload);
  if (!source || source.ok !== true || source.format !== SNAPSHOT_FORMAT) return null;
  if (!Number.isFinite(Date.parse(String(source.checkedAt)))) return null;
  const cards = record(source.cards);
  if (!cards) return null;
  for (const id of CARD_ORDER) {
    const card = record(cards[id]);
    if (!card || !STATUS_VIEW[card.status]) return null;
  }
  const deadLetters = record(cards.deadLetters);
  if (!deadLetters || !STATUS_VIEW[deadLetters.status]) return null;
  const items = Array.isArray(deadLetters.items) ? deadLetters.items.map(validDeadLetter).filter(Boolean) : [];
  const refreshAfterMs = finite(source.refreshAfterMs);
  return Object.freeze({
    checkedAt: String(source.checkedAt),
    refreshAfterMs: refreshAfterMs !== null && refreshAfterMs > 0 ? refreshAfterMs : 5 * 60 * 1000,
    cards: Object.freeze(Object.fromEntries(CARD_ORDER.map(id => [id, cards[id]]))),
    outboxTypes: Array.isArray(cards.outbox.byType) ? cards.outbox.byType.filter(record) : [],
    deadLetters: Object.freeze({
      status: deadLetters.status,
      total: wholeNumber(deadLetters.total),
      items: Object.freeze(items),
    }),
  });
}

/** Status-region copy for a failed load. */
export function loadErrorMessage(error) {
  const status = Number(error?.http_status);
  if (status === 401 || status === 403) return 'Only global administrators can view diagnostics.';
  if (status === 404) return 'Diagnostics are turned off.';
  if (error?.invalid === true) return 'Diagnostics returned an unexpected response. Try Refresh.';
  return 'Diagnostics are unavailable right now. Try Refresh.';
}

/** Status-region copy for a failed replay. */
export function replayErrorMessage(error, id) {
  const status = Number(error?.http_status);
  // ID-83: retention removed the recipient of a dead letter older than 30 days.
  if (status === 409 && error?.code === 'outbox_event_redacted') {
    return `Event #${id} can’t be replayed: its recipient details were removed after 30 days under the retention policy. Nothing changed.`;
  }
  if (status === 409) return `Event #${id} is no longer dead-lettered.`;
  if (status === 401 || status === 403) return 'Only global administrators can replay dead letters.';
  if (status === 400) return 'That replay request was rejected. Nothing changed.';
  return 'Replay failed. Nothing changed; try again.';
}

export function deadLetterSummary(item) {
  const parts = [
    item.ageMs === null ? 'Dead-lettered' : `Dead-lettered ${formatDuration(item.ageMs)} ago`,
    plural(item.attempts, 'attempt'),
    `replayed ${item.replays}×`,
  ];
  if (item.providerReason) parts.push(`provider: ${item.providerReason}`);
  return parts.join(' · ');
}

/**
 * Wire the Diagnostics disclosure. `host` provides:
 *   enabled() → boolean, load() → Promise<snapshot>,
 *   replay(eventId, reasonCode) → Promise, confirm(title, message) → Promise<boolean>,
 *   openLogs(), openDemoTools().
 * Returns `{sync, refresh, tick, reset}`. Missing elements make this a no-op.
 */
export function mountAdminDiagnostics({
  doc, host, now = () => Date.now(), setIntervalImpl = globalThis.setInterval,
}) {
  const el = id => doc.getElementById(id);
  const panel = el('adminDiagnostics');
  const refreshButton = el('adminDiagnosticsRefresh');
  const status = el('adminDiagnosticsStatus');
  const cards = el('adminDiagnosticsCards');
  const list = el('adminDeadLetters');
  const deadTitle = el('adminDeadLettersTitle');
  const reasonSelect = el('adminReplayReason');
  // Not a live region: the snapshot age changes every tick, and announcing it
  // each minute would be noise. Only the move to stale is announced.
  const age = el('adminDiagnosticsAge');
  const noop = Object.freeze({ sync() {}, refresh: async () => {}, tick() {}, reset() {} });
  if (!panel || !refreshButton || !status || !cards || !list) return noop;

  let snapshot = null;
  let fetchedAt = 0;
  let pending = false;
  let replaying = false;
  let epoch = 0;
  // Bumped only by reset() (identity change or access withdrawn). A Refresh
  // bumps `epoch` but not this, so an in-flight replay still reports.
  let session = 0;
  let notice = '';
  let snapshotStale = false;

  function setStatus(text) {
    if (status.textContent !== text) status.textContent = text;
  }

  function badge(label, tone, testid) {
    const node = doc.createElement('span');
    node.className = 'rc-badge';
    if (tone && tone !== 'neutral') node.dataset.tone = tone;
    if (testid) node.dataset.testid = testid;
    node.textContent = label;
    return node;
  }

  function paragraph(text, className = 'small') {
    const node = doc.createElement('p');
    node.className = className;
    node.textContent = text;
    return node;
  }

  function outboxTable(types) {
    if (!types.length) return paragraph('No outbox events yet.', 'small muted');
    const wrap = doc.createElement('div');
    wrap.className = 'admin-diag-table-wrap';
    wrap.setAttribute('role', 'region');
    wrap.setAttribute('aria-label', 'Outbox by event type');
    wrap.setAttribute('tabindex', '0');
    const table = doc.createElement('table');
    table.className = 'rc-table';
    table.dataset.testid = 'admin-outbox-types';
    const head = doc.createElement('thead');
    const headRow = doc.createElement('tr');
    for (const label of ['Event type', 'Queued', 'Due', 'Leased', 'Dead (24 h / all)', 'Oldest due']) {
      const cell = doc.createElement('th');
      cell.setAttribute('scope', 'col');
      cell.textContent = label;
      headRow.appendChild(cell);
    }
    head.appendChild(headRow);
    const body = doc.createElement('tbody');
    for (const type of types) {
      const row = doc.createElement('tr');
      const name = doc.createElement('th');
      name.setAttribute('scope', 'row');
      name.textContent = String(type.eventType);
      row.appendChild(name);
      const oldest = type.oldestDueAgeMs === null || type.oldestDueAgeMs === undefined ? '—' : formatDuration(type.oldestDueAgeMs);
      for (const value of [wholeNumber(type.queued), wholeNumber(type.due), wholeNumber(type.leased),
        `${wholeNumber(type.deadLetter24h)} / ${wholeNumber(type.deadLetter)}`, oldest]) {
        const cell = doc.createElement('td');
        cell.textContent = String(value);
        row.appendChild(cell);
      }
      body.appendChild(row);
    }
    table.append(head, body);
    wrap.appendChild(table);
    return wrap;
  }

  // Card nodes are kept so the periodic tick can update stale badges and
  // evidence ages in place, without replacing anything that may hold focus.
  let cardNodes = new Map();

  function renderCards() {
    const elapsed = Math.max(0, now() - fetchedAt);
    cardNodes = new Map();
    const nodes = CARD_ORDER.map(id => {
      const view = cardView(id, snapshot.cards[id], elapsed);
      const section = doc.createElement('section');
      section.className = 'rc-card admin-diag-card';
      section.dataset.card = id;
      section.dataset.status = view.status;
      section.dataset.testid = 'admin-diagnostics-card';
      section.setAttribute('aria-labelledby', `adminDiagCard-${id}`);
      const head = doc.createElement('div');
      head.className = 'admin-diag-card-head';
      const title = doc.createElement('h4');
      title.id = `adminDiagCard-${id}`;
      title.textContent = view.title;
      const staleBadge = badge('Stale', 'warning', 'admin-diagnostics-stale');
      head.append(title, badge(view.label, view.tone, 'admin-diagnostics-card-status'), staleBadge);
      section.appendChild(head);
      for (const line of view.lines) section.appendChild(paragraph(line));
      const evidenceNode = paragraph('', 'small muted admin-diag-evidence');
      section.appendChild(evidenceNode);
      if (id === 'outbox' && view.status !== 'unavailable') section.appendChild(outboxTable(snapshot.outboxTypes));
      cardNodes.set(id, { section, staleBadge, evidenceNode });
      return section;
    });
    cards.replaceChildren(...nodes);
    updateFreshness();
  }

  function updateFreshness() {
    const elapsed = Math.max(0, now() - fetchedAt);
    for (const [id, nodes] of cardNodes) {
      const view = cardView(id, snapshot.cards[id], elapsed);
      nodes.section.dataset.stale = view.stale ? 'true' : 'false';
      nodes.staleBadge.hidden = !view.stale;
      if (nodes.evidenceNode.textContent !== view.evidence) nodes.evidenceNode.textContent = view.evidence;
      nodes.evidenceNode.hidden = !view.evidence;
    }
  }

  // Messages inside the list are list items, so the list stays valid markup.
  function note(text) {
    const node = doc.createElement('li');
    node.className = 'small muted';
    node.textContent = text;
    return node;
  }

  function renderDeadLetters() {
    const rows = [];
    const { items, total, status: deadStatus } = snapshot.deadLetters;
    if (deadStatus === 'unavailable') rows.push(note('Dead letters could not be read. Try Refresh.'));
    else if (!items.length) rows.push(note('No dead letters.'));
    for (const item of items) {
      const row = doc.createElement('li');
      row.className = 'circle-row admin-dead-letter';
      row.dataset.testid = 'admin-dead-letter';
      row.dataset.eventId = String(item.id);
      const main = doc.createElement('div');
      main.className = 'circle-row-main';
      const head = doc.createElement('div');
      head.className = 'circle-row-title';
      const name = doc.createElement('b');
      name.textContent = `#${item.id} ${item.eventType} v${item.eventVersion}`;
      head.appendChild(name);
      if (item.errorCode) head.appendChild(badge(item.errorCode, 'danger'));
      main.append(head, paragraph(deadLetterSummary(item), 'small muted'));
      const actions = doc.createElement('div');
      actions.className = 'circle-row-actions';
      const button = doc.createElement('button');
      button.type = 'button';
      button.className = 'btn secondary sm';
      button.dataset.testid = 'admin-dead-letter-replay';
      button.setAttribute('aria-label', `Replay event #${item.id}`);
      button.textContent = 'Replay';
      button.addEventListener('click', () => { void replay(item, button); });
      actions.appendChild(button);
      row.append(main, actions);
      rows.push(row);
    }
    if (total > items.length) rows.push(note(`Showing the newest ${items.length} of ${total}.`));
    list.replaceChildren(...rows);
  }

  function snapshotAgeMs() {
    return Math.max(0, now() - fetchedAt);
  }

  // Returns true when this call moved the snapshot from fresh to stale.
  function updateSnapshotFreshness() {
    const elapsed = snapshotAgeMs();
    const stale = elapsed > snapshot.refreshAfterMs;
    panel.dataset.stale = stale ? 'true' : 'false';
    if (age) {
      const ago = elapsed >= 60 * 1000 ? ` · ${formatDuration(elapsed)} ago` : '';
      age.textContent = `Checked ${formatInstant(snapshot.checkedAt)}${ago}.`;
    }
    const became = stale && !snapshotStale;
    snapshotStale = stale;
    return became;
  }

  function render() {
    renderCards();
    renderDeadLetters();
    snapshotStale = false;
    updateSnapshotFreshness();
    setStatus(`${notice ? `${notice} ` : ''}Diagnostics updated.`);
  }

  function clear() {
    cardNodes = new Map();
    cards.replaceChildren();
    list.replaceChildren();
    panel.dataset.stale = 'false';
    snapshotStale = false;
    if (age) age.textContent = '';
  }

  function reset() {
    session += 1;
    epoch += 1;
    snapshot = null;
    pending = false;
    replaying = false;
    notice = '';
    clear();
    setStatus('');
    refreshButton.disabled = false;
    panel.setAttribute('aria-busy', 'false');
  }

  async function load({ keepNotice = false } = {}) {
    if (!host.enabled()) return;
    if (!keepNotice) notice = '';
    const started = ++epoch;
    pending = true;
    refreshButton.disabled = true;
    panel.setAttribute('aria-busy', 'true');
    setStatus(`${notice ? `${notice} ` : ''}Loading diagnostics…`);
    try {
      const next = normalizeSnapshot(await host.load());
      if (started !== epoch) return;
      if (!next) throw Object.assign(new Error('invalid diagnostics response'), { invalid: true });
      snapshot = next;
      fetchedAt = now();
      render();
    } catch (error) {
      if (started !== epoch) return;
      snapshot = null;
      clear();
      // A replay notice survives a failed reload: the replay itself succeeded.
      setStatus(`${notice ? `${notice} ` : ''}${loadErrorMessage(error)}`);
    } finally {
      if (started === epoch) {
        pending = false;
        refreshButton.disabled = false;
        panel.setAttribute('aria-busy', 'false');
      }
    }
  }

  async function replay(item, button) {
    if (pending || replaying || !host.enabled()) return;
    const selected = reasonSelect?.value;
    const reason = Object.prototype.hasOwnProperty.call(REPLAY_REASON_LABELS, selected) ? selected : 'OPERATOR_RETRY';
    const confirmed = await host.confirm(
      `Replay dead letter #${item.id}?`,
      `${item.eventType} goes back to the delivery queue with the reason “${REPLAY_REASON_LABELS[reason]}”. The replay is audited under your account.`,
    );
    if (!confirmed) {
      setStatus('Replay cancelled. Nothing changed.');
      return;
    }
    if (!host.enabled()) return;
    const owner = session;
    replaying = true;
    button.disabled = true;
    setStatus(`Replaying event #${item.id}…`);
    let failure = null;
    let failed = false;
    try {
      await host.replay(item.id, reason);
    } catch (error) {
      failed = true;
      failure = error;
    }
    // Cleared however the request ended, so a Refresh that ran meanwhile
    // cannot leave every Replay button inert.
    replaying = false;
    if (owner !== session) return;
    if (failed && Number(failure?.http_status) !== 409) {
      button.disabled = false;
      setStatus(replayErrorMessage(failure, item.id));
      return;
    }
    notice = failed ? replayErrorMessage(failure, item.id) : `Event #${item.id} is queued for delivery again.`;
    // A new load supersedes any Refresh still in flight, so the list reflects
    // the replay and keeps the notice.
    await load({ keepNotice: true });
    deadTitle?.focus?.();
  }

  function sync() {
    const enabled = host.enabled() === true;
    panel.hidden = !enabled;
    if (!enabled) {
      panel.open = false;
      if (snapshot || pending || status.textContent) reset();
      return;
    }
    if (panel.open && !snapshot && !pending) void load();
  }

  function tick() {
    if (!snapshot || pending) return;
    updateFreshness();
    if (updateSnapshotFreshness()) setStatus('This snapshot is out of date. Refresh for current data.');
  }

  panel.addEventListener('toggle', () => {
    if (panel.open && !snapshot && !pending) void load();
  });
  refreshButton.addEventListener('click', () => { void load(); });
  el('adminOpenLogs')?.addEventListener('click', () => host.openLogs?.());
  el('adminOpenDemo')?.addEventListener('click', () => host.openDemoTools?.());
  if (typeof setIntervalImpl === 'function') setIntervalImpl(tick, TICK_MS);
  sync();

  return Object.freeze({ sync, refresh: () => load(), tick, reset });
}

const api = Object.freeze({
  CARD_ORDER,
  REPLAY_REASON_LABELS,
  SNAPSHOT_FORMAT,
  STATUS_VIEW,
  TICK_MS,
  cardView,
  deadLetterSummary,
  evidenceState,
  evidenceText,
  formatDuration,
  formatInstant,
  loadErrorMessage,
  mountAdminDiagnostics,
  normalizeSnapshot,
  replayErrorMessage,
});

if (typeof window !== 'undefined' && window) {
  window.RandoriAdminDiagnostics = api;
  try { window.dispatchEvent(new Event('randori:admin-diagnostics-ready')); } catch { /* old browsers */ }
}

export default api;
