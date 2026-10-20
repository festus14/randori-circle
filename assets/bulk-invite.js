// Circle owner "invite several people at once" (ID-68).
//
// Loaded by index.html as `<script type="module">`. The pure helpers turn a
// paste into a preview and a server response into result rows; the controller
// wires them to the invite card. Every request, authorization check and
// circle-context guard comes from the host object index.html passes in, so
// this file never decides who may invite and never stores addresses anywhere
// but memory (cleared by `reset()` on any identity or circle change).
import {
  BULK_INVITE_MAX,
  emailProblemMessage,
  parseEmailList,
} from './email-validation.js';

const INVITE_URL_PATTERN = /^\/invite#invite=[A-Za-z0-9_-]{43}$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const STATUSES = new Set(['created', 'invalid', 'duplicate_in_request', 'already_member', 'already_invited', 'failed']);
const PREVIEW_LIMIT = 100;

const FAILURE_COPY = Object.freeze({
  rate_limited: 'Daily invitation limit reached. Try again later.',
  circle_context_changed: 'Your active circle changed. Reload, then try again.',
  owner_required: 'Only the circle owner can invite people.',
  unavailable: 'Could not create this invitation. Try again.',
});

function plural(count, one, many = `${one}s`) {
  return `${count} ${count === 1 ? one : many}`;
}

/** "about 3 hours" style wait copy for Retry-After seconds. */
export function formatWait(seconds) {
  const value = Number(seconds);
  if (!Number.isFinite(value) || value <= 0) return 'later';
  if (value < 90) return 'in a minute or two';
  if (value < 60 * 60) return `in about ${plural(Math.round(value / 60), 'minute')}`;
  return `in about ${plural(Math.round(value / 3600), 'hour')}`;
}

/** Count line and submit state for a parsed paste. */
export function previewSummary(parsed) {
  const ready = parsed.valid.length;
  const invalid = parsed.invalid.length;
  const parts = [];
  if (!parsed.entries.length) {
    return Object.freeze({ text: '', ready: 0, canSubmit: false, tone: 'none' });
  }
  if (parsed.overLimit) {
    const extra = ready - parsed.max;
    return Object.freeze({
      text: `${plural(ready, 'address', 'addresses')} found. You can invite up to ${parsed.max} at a time; remove ${extra} to continue.`,
      ready, canSubmit: false, tone: 'danger',
    });
  }
  parts.push(`${ready} ready to invite`);
  if (invalid) parts.push(`${invalid} to fix`);
  if (parsed.duplicates) parts.push(`${plural(parsed.duplicates, 'duplicate')} merged`);
  let text = parts.join(' · ');
  if (parsed.truncated) text += '. Only the first part of this paste was read.';
  return Object.freeze({ text, ready, canSubmit: ready > 0, tone: invalid ? 'warning' : 'info' });
}

export function submitLabel(count, pending = false) {
  if (pending) return 'Inviting…';
  return count > 0 ? `Invite ${plural(count, 'person', 'people')}` : 'Invite people';
}

function safeInviteUrl(value, origin) {
  if (typeof value !== 'string' || !INVITE_URL_PATTERN.test(value)) return null;
  try {
    const url = new URL(value, origin);
    return url.origin === new URL(origin).origin && url.pathname === '/invite' && !url.search ? url.href : null;
  } catch {
    return null;
  }
}

/**
 * Validate a bulk response against what was sent. Returns rows in the sent
 * order, or null when the response is not trustworthy (then nothing renders).
 */
export function normalizeBulkResponse(response, sent, { origin } = {}) {
  if (response?.ok !== true || !Array.isArray(response.results) || response.results.length !== sent.length) return null;
  const rows = [];
  for (let index = 0; index < sent.length; index += 1) {
    const result = response.results[index];
    if (!result || Number(result.index) !== index || !STATUSES.has(result.status)) return null;
    const email = sent[index];
    const row = { email, status: result.status, reason: typeof result.reason === 'string' ? result.reason : null };
    if (result.status === 'created') {
      const id = String(result.invitation?.id || '').toLowerCase();
      const inviteUrl = safeInviteUrl(result.invitation?.invite_url, origin);
      if (!UUID_PATTERN.test(id) || !inviteUrl) return null;
      Object.assign(row, { id, inviteUrl, queued: result.email_delivery?.queued === true });
    } else if (result.status === 'already_invited') {
      const id = String(result.invitation?.id || '').toLowerCase();
      row.id = UUID_PATTERN.test(id) ? id : null;
    } else if (result.status === 'already_member') {
      row.inactive = result.member_status === 'inactive';
    }
    rows.push(row);
  }
  return rows;
}

/** Badge, detail and available action for one result row. */
export function resultView(row) {
  switch (row.status) {
    case 'created':
      return Object.freeze({
        label: row.resent ? 'Resent' : 'Invited', tone: 'success',
        detail: row.queued ? 'Invitation email on its way. Copy the link as a fallback.' : 'Copy the link and send it privately.',
        action: row.inviteUrl ? 'copy' : null,
      });
    case 'already_member':
      return Object.freeze({
        label: row.inactive ? 'Former member' : 'Already a member', tone: 'neutral',
        detail: row.inactive ? 'Reactivate them from the member list instead.' : 'They are already in this circle.',
        action: null,
      });
    case 'already_invited':
      return Object.freeze({
        label: 'Already invited', tone: 'info',
        detail: row.note || 'They have a pending invitation. Resend it to send a fresh link.',
        action: row.id ? 'resend' : null,
      });
    case 'invalid':
      return Object.freeze({ label: 'Invalid', tone: 'danger', detail: emailProblemMessage(row.reason), action: null });
    case 'duplicate_in_request':
      return Object.freeze({ label: 'Duplicate', tone: 'neutral', detail: 'Listed more than once; invited once.', action: null });
    default:
      return Object.freeze({
        label: 'Failed', tone: 'danger', detail: row.note || FAILURE_COPY[row.reason] || FAILURE_COPY.unavailable, action: 'retry',
      });
  }
}

/** One sentence for the live region after a submit. */
export function summarizeResults(rows) {
  const count = status => rows.filter(row => row.status === status).length;
  const parts = [];
  if (count('created')) parts.push(`Invited ${plural(count('created'), 'person', 'people')}`);
  if (count('already_member')) parts.push(`${count('already_member')} already in the circle`);
  if (count('already_invited')) parts.push(`${count('already_invited')} already invited`);
  if (count('invalid')) parts.push(`${count('invalid')} to fix`);
  if (count('failed')) parts.push(`${count('failed')} failed`);
  return parts.length ? `${parts.join(' · ')}.` : 'Nothing to invite.';
}

/** What stays in the textarea: everything that still needs the owner. */
export function remainingInput(rows) {
  return rows.filter(row => row.status === 'invalid' || row.status === 'failed')
    .map(row => row.raw || row.email).join('\n');
}

/** Remove the lines that hold `values` (case-insensitive) from the textarea text. */
export function withoutLines(text, values) {
  const drop = new Set(values.filter(Boolean).map(value => String(value).trim().toLowerCase()));
  return String(text ?? '').split('\n').filter(item => !drop.has(item.trim().toLowerCase())).join('\n');
}

/** Copy for a request that failed as a whole. */
export function bulkErrorMessage(error) {
  const status = Number(error?.http_status);
  if (status === 429 || error?.code === 'invitation_quota_exceeded') {
    const remaining = Number(error?.remaining);
    const head = Number.isSafeInteger(remaining) && remaining > 0
      ? `You can invite ${plural(remaining, 'more person', 'more people')} today.`
      : 'You have reached today’s invitation limit.';
    return `${head} Try again ${formatWait(error?.retry_after_seconds)}. Nothing was sent.`;
  }
  if (error?.code === 'bulk_invite_too_many') return `Invite up to ${BULK_INVITE_MAX} people at a time.`;
  if (error?.code === 'circle_context_changed') return 'Your active circle changed. Reload, then try again.';
  if (status === 403) return 'Only the circle owner can invite people.';
  if (status === 401) return 'Sign in again to invite people.';
  return 'Could not confirm the invitations. Check the pending list before trying again.';
}

function resendFailure(error) {
  const status = Number(error?.http_status);
  if (status === 429) return `Resent recently. Try again ${formatWait(error?.retry_after_seconds)}.`;
  if (status === 409) return 'This invitation can’t be resent. Revoke it in the list below and invite again.';
  return 'Could not resend. Try again.';
}

// ---------------------------------------------------------------- controller

/**
 * Wire the bulk form inside the invite card. `host` supplies:
 *   canInvite() → boolean, capture() → operation, matches(operation,result?) → boolean,
 *   createMany(emails) → Promise<response>, resend(id) → Promise<response>,
 *   rememberEmail(id,email), refresh() → Promise, copy(text) → Promise, origin.
 * Returns `{reset}`. Missing elements make this a no-op.
 */
export function mountBulkInvite({ doc, host }) {
  const el = id => doc.getElementById(id);
  const form = el('circleBulkInviteForm');
  const input = el('circleBulkInviteInput');
  const count = el('circleBulkInviteCount');
  const preview = el('circleBulkInvitePreview');
  const submit = el('circleBulkInviteSubmit');
  const status = el('circleBulkInviteStatus');
  const results = el('circleBulkInviteResults');
  if (!form || !input || !count || !preview || !submit || !status || !results) return Object.freeze({ reset() {} });

  let parsed = parseEmailList('');
  let pending = false;
  let epoch = 0;
  let rows = [];

  function badge(label, tone) {
    const node = doc.createElement('span');
    node.className = `rc-badge${['success', 'warning', 'danger', 'info'].includes(tone) ? ` rc-badge--${tone}` : ''}`;
    node.textContent = label;
    return node;
  }

  function line({ title, label, tone, detail, testid }) {
    const item = doc.createElement('li');
    item.className = 'circle-row circle-bulk-row';
    item.dataset.testid = testid;
    const main = doc.createElement('div');
    main.className = 'circle-row-main';
    const head = doc.createElement('div');
    head.className = 'circle-row-title';
    const name = doc.createElement('b');
    name.className = 'circle-row-email';
    name.textContent = title;
    head.append(name, badge(label, tone));
    main.appendChild(head);
    if (detail) {
      const meta = doc.createElement('div');
      meta.className = 'small muted';
      meta.textContent = detail;
      main.appendChild(meta);
    }
    item.appendChild(main);
    return item;
  }

  function renderPreview() {
    const view = previewSummary(parsed);
    count.textContent = view.text;
    count.dataset.tone = view.tone;
    submit.disabled = pending || !view.canSubmit;
    submit.textContent = submitLabel(view.ready, pending);
    input.setAttribute('aria-invalid', view.tone === 'danger' ? 'true' : 'false');
    preview.replaceChildren();
    preview.hidden = !parsed.entries.length;
    for (const entry of parsed.entries.slice(0, PREVIEW_LIMIT)) {
      const repeated = entry.occurrences > 1 ? ` (listed ${entry.occurrences} times)` : '';
      const item = line({
        title: entry.valid ? entry.email : entry.raw,
        label: entry.valid ? 'Ready' : 'Fix',
        tone: entry.valid ? 'success' : 'danger',
        detail: entry.valid ? (repeated ? `Duplicate merged${repeated}.` : '') : `${emailProblemMessage(entry.reason)}${repeated}`,
        testid: 'circle-bulk-invite-preview-row',
      });
      item.dataset.valid = entry.valid ? 'true' : 'false';
      preview.appendChild(item);
    }
    if (parsed.entries.length > PREVIEW_LIMIT) {
      const more = doc.createElement('li');
      more.className = 'small muted';
      more.textContent = `and ${parsed.entries.length - PREVIEW_LIMIT} more`;
      preview.appendChild(more);
    }
  }

  function update() {
    parsed = parseEmailList(input.value);
    renderPreview();
  }

  function setRowNote(row, note) {
    row.note = note;
    renderResults();
  }

  async function copyLink(row) {
    if (!host.canInvite()) return;
    try {
      await host.copy(row.inviteUrl);
      status.textContent = `Invitation link for ${row.email} copied. Send it privately; it works once.`;
    } catch {
      status.textContent = 'Copy failed. Resend the invitation to get a fresh link.';
    }
  }

  async function resendRow(row, button) {
    if (!host.canInvite() || !row.id) return;
    const operation = host.capture();
    if (!host.matches(operation)) return;
    const started = epoch;
    button.disabled = true;
    try {
      const result = await host.resend(row.id);
      if (started !== epoch || !host.matches(operation, result)) return;
      const inviteUrl = safeInviteUrl(result?.invitation?.invite_url, host.origin);
      if (result?.ok !== true || !inviteUrl) throw new Error('invalid resend response');
      Object.assign(row, { status: 'created', resent: true, inviteUrl, queued: result.email_delivery?.queued === true, note: null });
      host.rememberEmail(row.id, row.email);
      renderResults();
      status.textContent = `Fresh invitation sent to ${row.email}. The old link no longer works.`;
      await host.refresh();
    } catch (error) {
      if (started !== epoch || !host.matches(operation)) return;
      setRowNote(row, resendFailure(error));
    }
  }

  async function retryRow(row, button) {
    if (!host.canInvite() || pending) return;
    const operation = host.capture();
    if (!host.matches(operation)) return;
    const started = epoch;
    button.disabled = true;
    try {
      const response = await host.createMany([row.email]);
      if (started !== epoch || !host.matches(operation, response)) return;
      const [next] = normalizeBulkResponse(response, [row.email], { origin: host.origin }) || [];
      if (!next) throw new Error('invalid bulk response');
      Object.assign(row, next, { note: null });
      if (next.status === 'created') host.rememberEmail(next.id, next.email);
      if (next.status !== 'failed') input.value = withoutLines(input.value, [row.raw, row.email]);
      update();
      renderResults();
      status.textContent = summarizeResults([row]);
      if (next.status === 'created') await host.refresh();
    } catch (error) {
      if (started !== epoch || !host.matches(operation)) return;
      setRowNote(row, bulkErrorMessage(error));
    }
  }

  function renderResults() {
    results.replaceChildren();
    results.hidden = !rows.length;
    for (const row of rows) {
      const view = resultView(row);
      const item = line({ title: row.email || row.raw, label: view.label, tone: view.tone, detail: view.detail,
        testid: 'circle-bulk-invite-result' });
      item.dataset.status = row.status;
      if (view.action) {
        const actions = doc.createElement('div');
        actions.className = 'circle-row-actions';
        const button = doc.createElement('button');
        button.type = 'button';
        button.className = 'btn secondary sm';
        const who = row.email || row.raw;
        if (view.action === 'copy') {
          button.textContent = 'Copy link';
          button.dataset.testid = 'circle-bulk-invite-copy';
          button.setAttribute('aria-label', `Copy invitation link for ${who}`);
          button.addEventListener('click', () => { void copyLink(row); });
        } else if (view.action === 'resend') {
          button.textContent = 'Resend';
          button.dataset.testid = 'circle-bulk-invite-resend';
          button.setAttribute('aria-label', `Resend invitation to ${who}`);
          button.addEventListener('click', () => { void resendRow(row, button); });
        } else {
          button.textContent = 'Retry';
          button.dataset.testid = 'circle-bulk-invite-retry';
          button.setAttribute('aria-label', `Retry invitation for ${who}`);
          button.addEventListener('click', () => { void retryRow(row, button); });
        }
        actions.appendChild(button);
        item.appendChild(actions);
      }
      results.appendChild(item);
    }
  }

  async function submitAll(event) {
    event?.preventDefault?.();
    if (pending || !host.canInvite()) return;
    update();
    if (!previewSummary(parsed).canSubmit) {
      if (parsed.overLimit || parsed.entries.length) input.focus?.();
      return;
    }
    const operation = host.capture();
    if (!host.matches(operation)) return;
    const snapshot = parsed;
    const sent = [...snapshot.valid];
    const started = epoch;
    pending = true;
    form.setAttribute('aria-busy', 'true');
    renderPreview();
    status.textContent = `Inviting ${plural(sent.length, 'person', 'people')}…`;
    try {
      const response = await host.createMany(sent);
      if (started !== epoch || !host.matches(operation, response)) return;
      const serverRows = normalizeBulkResponse(response, sent, { origin: host.origin });
      if (!serverRows) throw new Error('invalid bulk response');
      const rawByEmail = new Map(snapshot.entries.filter(entry => entry.valid).map(entry => [entry.email, entry.raw]));
      rows = [
        ...serverRows.map(row => ({ ...row, raw: rawByEmail.get(row.email) || row.email })),
        ...snapshot.invalid.map(entry => ({ email: null, raw: entry.raw, status: 'invalid', reason: entry.reason })),
      ];
      for (const row of rows) if (row.status === 'created') host.rememberEmail(row.id, row.email);
      input.value = remainingInput(rows);
      status.textContent = summarizeResults(rows);
      renderResults();
      if (rows.some(row => row.status === 'created')) await host.refresh();
    } catch (error) {
      if (started !== epoch || !host.matches(operation)) return;
      status.textContent = bulkErrorMessage(error);
      if (Number(error?.http_status) !== 429 && Number(error?.http_status) !== 400) void host.refresh();
    } finally {
      if (started === epoch) {
        pending = false;
        form.setAttribute('aria-busy', 'false');
        update();
      }
    }
  }

  input.addEventListener('input', update);
  form.addEventListener('submit', event => { void submitAll(event); });
  renderPreview();

  return Object.freeze({
    reset() {
      epoch += 1;
      pending = false;
      rows = [];
      input.value = '';
      status.textContent = '';
      form.setAttribute('aria-busy', 'false');
      update();
      renderResults();
    },
  });
}

const api = Object.freeze({
  bulkErrorMessage,
  formatWait,
  mountBulkInvite,
  normalizeBulkResponse,
  previewSummary,
  remainingInput,
  resultView,
  submitLabel,
  summarizeResults,
  withoutLines,
});

if (typeof window !== 'undefined' && window) {
  window.RandoriBulkInvite = api;
  try { window.dispatchEvent(new Event('randori:bulk-invite-ready')); } catch { /* old browsers */ }
}

export default api;
