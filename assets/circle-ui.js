// Circle and history presentation helpers (WP-C).
//
// Loaded as a classic script before the main application script, so the
// helpers are available synchronously as `window.RandoriCircleUI`. The file
// has no imports or exports, which also lets the unit tests import it as an
// ES module for coverage.
//
// Everything here is presentation: it formats server-provided values into
// labels, validates response shapes before they reach the DOM, and builds
// small text-only nodes. It never fetches, authorizes, or stores anything.
(function installCircleUi(root) {
  'use strict';

  const MINUTE = 60 * 1000;
  const HOUR = 60 * MINUTE;
  const DAY = 24 * HOUR;
  const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
  const ISO_WEEK_PATTERN = /^(\d{4})-W(\d{2})$/;
  const INVITE_URL_PATTERN = /^\/invite#invite=[A-Za-z0-9_-]{43}$/;
  const ICON_SPRITE = '/assets/brand/icons.svg';
  const SVG_NS = 'http://www.w3.org/2000/svg';

  const INVITATION_STATUSES = Object.freeze({
    pending: Object.freeze({ key: 'pending', label: 'Pending', tone: 'info' }),
    used: Object.freeze({ key: 'accepted', label: 'Accepted', tone: 'success' }),
    accepted: Object.freeze({ key: 'accepted', label: 'Accepted', tone: 'success' }),
    expired: Object.freeze({ key: 'expired', label: 'Expired', tone: 'warning' }),
    revoked: Object.freeze({ key: 'revoked', label: 'Revoked', tone: 'neutral' }),
  });

  const LANGUAGE_LABELS = Object.freeze({
    python: 'Python', javascript: 'JavaScript', typescript: 'TypeScript', java: 'Java',
    cpp: 'C++', 'c++': 'C++', c: 'C', go: 'Go', rust: 'Rust', ruby: 'Ruby', kotlin: 'Kotlin',
    swift: 'Swift', csharp: 'C#', 'c#': 'C#', sql: 'SQL', text: 'Plain text',
  });

  const FOCUS_LABELS = Object.freeze({
    dsa: 'DSA', system_design: 'System design', systemdesign: 'System design',
    'system-design': 'System design', both: 'DSA and system design',
  });

  function boundedText(value, max) {
    if (typeof value !== 'string') return null;
    const text = value.replace(/\s+/gu, ' ').trim();
    return text && [...text].length <= max ? text : null;
  }

  // Accepts ISO-8601 instants and SQLite `YYYY-MM-DD HH:MM:SS` UTC timestamps.
  function parseInstant(value) {
    if (typeof value !== 'string' || value.length < 10 || value.length > 40) return null;
    let text = value.trim();
    if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}(:\d{2}(\.\d+)?)?$/.test(text)) text = `${text.replace(' ', 'T')}Z`;
    if (!/^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})?)?$/.test(text)) return null;
    const millis = Date.parse(text);
    return Number.isFinite(millis) ? millis : null;
  }

  function englishRelative(amount, unit) {
    const count = Math.abs(amount);
    const label = `${count} ${unit}${count === 1 ? '' : 's'}`;
    return amount < 0 ? `${label} ago` : `in ${label}`;
  }

  function relativeTime(value, now = Date.now(), locale) {
    const millis = typeof value === 'number' ? value : parseInstant(value);
    if (!Number.isFinite(millis) || !Number.isFinite(now)) return null;
    const delta = millis - now;
    const abs = Math.abs(delta);
    if (abs < 45 * 1000) return 'just now';
    let amount;
    let unit;
    if (abs < 45 * MINUTE) { amount = Math.round(delta / MINUTE); unit = 'minute'; }
    else if (abs < 22 * HOUR) { amount = Math.round(delta / HOUR); unit = 'hour'; }
    else if (abs < 45 * DAY) { amount = Math.round(delta / DAY); unit = 'day'; }
    else if (abs < 320 * DAY) { amount = Math.round(delta / (30 * DAY)); unit = 'month'; }
    else { amount = Math.round(delta / (365 * DAY)); unit = 'year'; }
    if (typeof Intl !== 'undefined' && typeof Intl.RelativeTimeFormat === 'function') {
      try {
        return new Intl.RelativeTimeFormat(locale, { numeric: 'auto' }).format(amount, unit);
      } catch {
        // Fall through to the English formatter for unsupported locales.
      }
    }
    return englishRelative(amount, unit);
  }

  function absoluteDate(value, locale) {
    const millis = typeof value === 'number' ? value : parseInstant(value);
    if (!Number.isFinite(millis)) return null;
    try {
      return new Intl.DateTimeFormat(locale, { dateStyle: 'medium' }).format(new Date(millis));
    } catch {
      return new Date(millis).toISOString().slice(0, 10);
    }
  }

  function invitationStatus(status) {
    return INVITATION_STATUSES[String(status || '')] || INVITATION_STATUSES.pending;
  }

  function initials(name) {
    const words = String(name || '').trim().split(/\s+/u).filter(Boolean);
    if (!words.length) return '?';
    const letters = words.length > 1
      ? [Array.from(words[0])[0], Array.from(words[1])[0]]
      : Array.from(words[0]).slice(0, 2);
    return letters.join('').toUpperCase();
  }

  function describeInvitation(invitation, { now = Date.now(), knownEmail = null, locale } = {}) {
    const id = String(invitation?.id || '').toLowerCase();
    if (!UUID_PATTERN.test(id)) return null;
    const status = invitationStatus(invitation?.status);
    const createdAt = parseInstant(invitation?.created_at);
    const expiresAt = parseInstant(invitation?.expires_at);
    const sent = createdAt === null ? null : relativeTime(createdAt, now, locale);
    const sentOn = createdAt === null ? null : absoluteDate(createdAt, locale);
    const email = boundedText(knownEmail, 254);
    const parts = [];
    if (status.key === 'pending') {
      if (sent) parts.push(`Sent ${sent}`);
      if (expiresAt !== null) parts.push(`expires ${relativeTime(expiresAt, now, locale)}`);
    } else if (status.key === 'expired') {
      if (sentOn) parts.push(`Sent ${sentOn}`);
      if (expiresAt !== null) parts.push(`expired ${relativeTime(expiresAt, now, locale)}`);
    } else {
      if (sentOn) parts.push(`Sent ${sentOn}`);
      parts.push(status.key === 'accepted' ? 'joined the circle' : 'link no longer works');
    }
    return Object.freeze({
      id,
      status: status.key,
      label: status.label,
      tone: status.tone,
      title: email || 'Private invitation',
      emailKnown: !!email,
      detail: parts.join(' · '),
      expiresTitle: expiresAt === null ? null : absoluteDate(expiresAt, locale),
      canResend: status.key === 'pending',
      canRevoke: status.key === 'pending',
      active: status.key === 'pending',
    });
  }

  function partitionInvitations(invitations) {
    const active = [];
    const past = [];
    for (const invitation of Array.isArray(invitations) ? invitations : []) {
      if (invitationStatus(invitation?.status).key === 'pending') active.push(invitation);
      else past.push(invitation);
    }
    return { active, past };
  }

  function invitationSummary(invitations) {
    const { active, past } = partitionInvitations(invitations);
    if (!active.length && !past.length) return 'No invitations yet.';
    const pending = `${active.length} pending invitation${active.length === 1 ? '' : 's'}`;
    return past.length ? `${pending}, ${past.length} earlier.` : `${pending}.`;
  }

  function focusLabel(value) {
    return FOCUS_LABELS[String(value || '').trim().toLowerCase()] || null;
  }

  // Owner and admin role changes. Each one is a sensitive change that the
  // server guards with the same recent-auth challenge as ownership transfer.
  const MEMBER_ROLE_ACTIONS = Object.freeze({
    make_owner: Object.freeze({
      label: 'Make owner', testid: 'circle-member-make-owner', aria: name => `Make ${name} an owner`,
      title: name => `Make ${name} an owner?`,
      body: 'They get the same circle controls you have: invitations, member management and publishing pairings. You stay an owner too.',
      pending: 'Adding owner…', done: 'Owner added.',
      confirm: 'Confirm your identity before adding a circle owner.',
    }),
    remove_owner: Object.freeze({
      label: 'Remove owner role', testid: 'circle-member-remove-owner', aria: name => `Remove owner role from ${name}`,
      title: name => `Remove ${name} as an owner?`,
      body: 'They stay in the circle as a member and lose owner controls immediately. At least one active owner always remains.',
      pending: 'Removing owner role…', done: 'Owner role removed.', danger: true,
      confirm: 'Confirm your identity before removing a circle owner.',
    }),
    grant_admin: Object.freeze({
      label: 'Make admin', testid: 'circle-member-grant-admin', aria: name => `Make ${name} an app admin`,
      title: name => `Make ${name} an app admin?`,
      body: 'App admins can view diagnostics and app logs, replay outbox email, manage demo data, and grant or remove admin access for other members.',
      pending: 'Granting admin access…', done: 'Admin access granted.',
      confirm: 'Confirm your identity before granting admin access.',
    }),
    revoke_admin: Object.freeze({
      label: 'Remove admin', testid: 'circle-member-revoke-admin', aria: name => `Remove app admin access from ${name}`,
      title: name => `Remove admin access from ${name}?`,
      body: 'They lose app admin tools immediately. At least one active admin always remains.',
      pending: 'Removing admin access…', done: 'Admin access removed.', danger: true,
      confirm: 'Confirm your identity before removing admin access.',
    }),
  });
  const RECENT_AUTH_MEMBER_ACTIONS = Object.freeze(['deactivate', 'transfer', ...Object.keys(MEMBER_ROLE_ACTIONS)]);

  function memberRoleActionCopy(action, name = 'this member') {
    const copy = MEMBER_ROLE_ACTIONS[action];
    if (!copy) return null;
    const label = boundedText(name, 80) || 'this member';
    return Object.freeze({
      action,
      label: copy.label,
      testid: copy.testid,
      ariaLabel: copy.aria(label),
      title: copy.title(label),
      body: copy.body,
      pending: copy.pending,
      done: copy.done,
      confirm: copy.confirm,
      danger: copy.danger === true,
    });
  }

  function memberRoleErrorMessage(error) {
    const code = String(error?.error || '');
    if (code === 'another active admin is required') return 'At least one other active admin is required. Make someone else an admin first.';
    if (code === 'admin access is managed by server configuration') return 'This admin is set in the server configuration, so it cannot be removed here.';
    if (code === 'app admin required') return 'Only an app admin in your main circle can change admin access.';
    if (code === 'ask another owner to change your role') return 'Ask another owner to change your own role.';
    return null;
  }

  function memberView(member, { actorId = null, actorIsAdmin = false, now = Date.now(), locale } = {}) {
    const id = Number(member?.id);
    const role = ['owner', 'member'].includes(member?.role) ? member.role : null;
    const status = ['active', 'inactive'].includes(member?.status) ? member.status : null;
    if (!Number.isSafeInteger(id) || id < 1 || !role || !status) return null;
    const name = boundedText(member?.display_name, 80) || 'Member';
    const isSelf = Number.isSafeInteger(actorId) && id === actorId;
    const isAdmin = member?.is_admin === true;
    const joinedAt = parseInstant(member?.joined_at);
    let actions = [];
    if (!isSelf) actions = status === 'inactive' ? ['reactivate'] : (role === 'member' ? ['transfer', 'deactivate'] : ['deactivate']);
    const roleActions = [];
    if (!isSelf) {
      if (status === 'active' && role === 'member') roleActions.push('make_owner');
      if (role === 'owner') roleActions.push('remove_owner');
      if (actorIsAdmin === true) {
        if (isAdmin) roleActions.push('revoke_admin');
        else if (status === 'active') roleActions.push('grant_admin');
      }
    }
    return Object.freeze({
      id,
      name,
      initials: initials(name),
      role,
      status,
      isAdmin,
      roleActions: Object.freeze(roleActions),
      roleLabel: role === 'owner' ? 'Owner' : 'Member',
      statusLabel: status === 'active' ? 'Active' : 'Inactive',
      statusTone: status === 'active' ? 'success' : 'warning',
      isSelf,
      joined: joinedAt === null ? null : `Joined ${relativeTime(joinedAt, now, locale)}`,
      actions,
    });
  }

  function rosterPersonView(person, { actorId = null } = {}) {
    const name = boundedText(person?.display_name, 120) || boundedText(person?.name, 120) || 'Member';
    const id = Number(person?.id);
    return Object.freeze({
      name,
      initials: initials(name),
      isSelf: Number.isSafeInteger(actorId) && Number.isSafeInteger(id) && id === actorId,
      focus: focusLabel(person?.interview_focus),
    });
  }

  function inviteRequestsVisible({ capabilities, role, activeCircle } = {}) {
    if (capabilities?.inviteRequests !== true || role !== 'owner') return false;
    if (capabilities?.multiCircleControlPlane !== true) return true;
    return activeCircle?.is_primary === true;
  }

  function normalizeInviteRequest(raw) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    const id = String(raw.id || '').toLowerCase();
    const name = boundedText(raw.name, 60);
    const email = typeof raw.email === 'string' && raw.email.length <= 254
      && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(raw.email) ? raw.email : null;
    const note = raw.note == null ? null : (typeof raw.note === 'string' && [...raw.note].length <= 280 ? raw.note.trim() || null : undefined);
    const createdAt = parseInstant(raw.created_at);
    const expiresAt = parseInstant(raw.expires_at);
    if (!UUID_PATTERN.test(id) || !name || !email || note === undefined || createdAt === null || expiresAt === null) return null;
    return Object.freeze({ id, name, email, note, createdAt, expiresAt });
  }

  function normalizeInviteRequestsResponse(result) {
    if (result?.ok !== true || !Array.isArray(result.requests) || result.requests.length > 100) return null;
    const nextCursor = result.next_cursor === null || result.next_cursor === undefined ? null : result.next_cursor;
    if (nextCursor !== null && (typeof nextCursor !== 'string' || !nextCursor || nextCursor.length > 640)) return null;
    const requests = [];
    const seen = new Set();
    for (const raw of result.requests) {
      const request = normalizeInviteRequest(raw);
      if (!request) return null;
      if (seen.has(request.id)) continue;
      seen.add(request.id);
      requests.push(request);
    }
    const pendingCount = Number(result.pending_count);
    return Object.freeze({
      requests,
      pendingCount: Number.isSafeInteger(pendingCount) && pendingCount >= requests.length ? pendingCount : requests.length,
      nextCursor,
    });
  }

  function inviteRequestView(request, { now = Date.now(), locale } = {}) {
    return Object.freeze({
      name: request.name,
      initials: initials(request.name),
      email: request.email,
      note: request.note,
      detail: `Asked ${relativeTime(request.createdAt, now, locale)} · expires ${relativeTime(request.expiresAt, now, locale)}`,
    });
  }

  function inviteRequestCountLabel(count) {
    const value = Number.isSafeInteger(count) && count > 0 ? count : 0;
    return value ? `${value} waiting` : 'None waiting';
  }

  function inviteRequestDecisionOutcome(decision, result, request) {
    if (!['approve', 'decline'].includes(decision) || result?.ok !== true || !result.request
      || String(result.request.id || '').toLowerCase() !== request?.id) return null;
    const name = request?.name || 'this person';
    const expected = decision === 'approve' ? 'approved' : 'declined';
    if (result.request.status !== expected) return null;
    if (decision === 'decline') {
      return Object.freeze({ decision, message: `Declined ${name}'s request. They are not notified.`, invitation: null });
    }
    const invitation = result.invitation && typeof result.invitation === 'object' ? result.invitation : null;
    const invitationId = String(invitation?.id || '').toLowerCase();
    const inviteUrl = typeof invitation?.invite_url === 'string' && INVITE_URL_PATTERN.test(invitation.invite_url)
      ? invitation.invite_url : null;
    if (result.replayed === true) {
      return Object.freeze({ decision, message: `${name}'s request was already approved.`, invitation: UUID_PATTERN.test(invitationId) ? { id: invitationId, inviteUrl: null, email: null } : null });
    }
    if (!UUID_PATTERN.test(invitationId)) return null;
    const queued = result.email_delivery?.queued === true;
    return Object.freeze({
      decision,
      message: queued
        ? `Approved. An invitation email is on its way to ${request.email}.`
        : `Approved. Copy the invitation link and send it to ${request.email} privately.`,
      invitation: { id: invitationId, inviteUrl, email: request.email },
    });
  }

  function inviteRequestErrorMessage(error) {
    const status = Number(error?.http_status);
    if (error?.code === 'invite_request_email_invalid') {
      return 'This request’s email address can’t receive an invitation. Decline it instead.';
    }
    if (error?.code === 'invite_request_not_pending' || status === 409) {
      const next = ['approved', 'declined', 'expired'].includes(error?.status) ? ` It was ${error.status}.` : '';
      return `This request was already handled.${next} The list has been refreshed.`;
    }
    if (status === 404) return 'This request is no longer available. The list has been refreshed.';
    if (status === 403) return 'Only an owner of your main circle can review invite requests.';
    if (status === 401) return 'Sign in again to review invite requests.';
    return 'Could not save that decision. Nothing changed. Try again.';
  }

  function historyCountLabel(count) {
    const value = Number.isSafeInteger(count) && count > 0 ? count : 0;
    return `${value} pairing${value === 1 ? '' : 's'}`;
  }

  // Cycle keys such as "2026-W44" are storage identifiers; people read
  // "Week of 26 Oct". The week's start date wins, then the ISO week number,
  // then any other server label. `week_id` is a row id and is never shown.
  function pairingWeekLabel(item, { locale = undefined, now = Date.now() } = {}) {
    const start = parseInstant(item?.week_start);
    if (start !== null) {
      const date = new Date(start);
      const options = { day: 'numeric', month: 'short' };
      if (date.getFullYear() !== new Date(now).getFullYear()) options.year = 'numeric';
      try {
        return `Week of ${new Intl.DateTimeFormat(locale, options).format(date)}`;
      } catch {
        return `Week of ${new Intl.DateTimeFormat(undefined, options).format(date)}`;
      }
    }
    const label = boundedText(item?.week_label, 80);
    const iso = label ? ISO_WEEK_PATTERN.exec(label) : null;
    if (iso) {
      const week = Number(iso[2]);
      return week >= 1 && week <= 53 ? `Week ${week}` : 'Pairing';
    }
    return label || 'Pairing';
  }

  // "focus-block-rollup" -> "Focus block rollup" for places that only have
  // the exercise slug (recaps and run lists).
  function exerciseLabel(slug) {
    const text = typeof slug === 'string' ? boundedText(slug.replace(/[-_]+/gu, ' '), 120) : null;
    if (!text) return 'Exercise';
    return text.charAt(0).toUpperCase() + text.slice(1);
  }

  function historyRowView(item, options) {
    const week = Number(item?.week_id);
    const pair = Number(item?.pg_id);
    if (!Number.isSafeInteger(week) || week < 1 || !Number.isSafeInteger(pair) || pair < 1) return null;
    const partner = boundedText(item?.partner_name, 240) || 'Pair member';
    const weekLabel = pairingWeekLabel(item, options);
    const kind = boundedText(item?.topic_kind, 160);
    const topic = boundedText(item?.topic, 160) || (kind && (focusLabel(kind) || kind));
    return Object.freeze({
      room: `week_${week}_pair_${pair}`,
      partner,
      partnerInitials: item?.is_ai === true ? 'AI' : initials(partner),
      week: weekLabel,
      topic,
      meta: topic ? `${weekLabel} · ${topic}` : weekLabel,
    });
  }

  function languageLabel(language) {
    const key = String(language || '').trim().toLowerCase();
    if (!key) return 'Unknown language';
    return LANGUAGE_LABELS[key] || key.charAt(0).toUpperCase() + key.slice(1);
  }

  function durationLabel(ms) {
    if (!Number.isSafeInteger(ms) || ms < 0) return null;
    if (ms < 1000) return `${ms} ms`;
    if (ms < 60 * 1000) return `${(ms / 1000).toFixed(ms < 10 * 1000 ? 1 : 0)} s`;
    return `${Math.floor(ms / 60000)} min ${Math.round((ms % 60000) / 1000)} s`;
  }

  function runSummary(event) {
    const passed = Number(event?.passed_count);
    const total = Number(event?.total_count);
    const duration = durationLabel(event?.duration_ms);
    const meta = [languageLabel(event?.language), `${passed}/${total} passed`];
    if (duration) meta.push(duration);
    return Object.freeze({
      title: `Verified run · ${exerciseLabel(event?.question_slug)}`,
      meta: meta.join(' · '),
      allPassed: Number.isSafeInteger(total) && total > 0 && passed === total,
    });
  }

  function iconNode(doc, name) {
    const svg = doc.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('class', 'rc-icon');
    svg.setAttribute('aria-hidden', 'true');
    svg.setAttribute('focusable', 'false');
    const use = doc.createElementNS(SVG_NS, 'use');
    use.setAttribute('href', `${ICON_SPRITE}#${/^i-[a-z-]+$/.test(name) ? name : 'i-info'}`);
    svg.appendChild(use);
    return svg;
  }

  function badgeNode(doc, label, tone) {
    const badge = doc.createElement('span');
    badge.className = `rc-badge${['success', 'warning', 'danger', 'info'].includes(tone) ? ` rc-badge--${tone}` : ''}`;
    badge.textContent = label;
    return badge;
  }

  function avatarNode(doc, { label, color = null, size = 'md' } = {}) {
    const avatar = doc.createElement('span');
    avatar.className = `avatar circle-avatar circle-avatar--${size === 'sm' ? 'sm' : 'md'}`;
    avatar.setAttribute('aria-hidden', 'true');
    if (color) avatar.style.background = color;
    else avatar.classList.add('circle-avatar--neutral');
    avatar.textContent = String(label || '?').slice(0, 2);
    return avatar;
  }

  // A compact disclosure menu for the per-member role actions. Each button
  // calls onAction(action); the caller owns confirmation and the request.
  function memberRoleMenuNode(doc, view, onAction) {
    const actions = Array.isArray(view?.roleActions) ? view.roleActions.filter(action => MEMBER_ROLE_ACTIONS[action]) : [];
    if (!actions.length) return null;
    const menu = doc.createElement('details');
    menu.className = 'circle-member-menu';
    menu.setAttribute('data-testid', 'circle-member-menu');
    const summary = doc.createElement('summary');
    summary.className = 'btn secondary sm';
    summary.textContent = 'Roles';
    summary.setAttribute('aria-label', `Role options for ${view.name}`);
    menu.appendChild(summary);
    const group = doc.createElement('div');
    group.className = 'circle-member-menu-items';
    group.setAttribute('role', 'group');
    group.setAttribute('aria-label', `Role options for ${view.name}`);
    for (const action of actions) {
      const copy = memberRoleActionCopy(action, view.name);
      const button = doc.createElement('button');
      button.type = 'button';
      button.className = `btn secondary sm${copy.danger ? ' membership-danger' : ''}`;
      button.setAttribute('data-testid', copy.testid);
      button.setAttribute('aria-label', copy.ariaLabel);
      button.textContent = copy.label;
      button.addEventListener('click', () => {
        menu.open = false;
        if (typeof onAction === 'function') onAction(action);
      });
      group.appendChild(button);
    }
    menu.appendChild(group);
    return menu;
  }

  function adminBadgeNode(doc) {
    const badge = badgeNode(doc, 'Admin', 'success');
    badge.setAttribute('data-testid', 'circle-member-admin-badge');
    return badge;
  }

  const api = Object.freeze({
    RECENT_AUTH_MEMBER_ACTIONS,
    adminBadgeNode,
    absoluteDate,
    avatarNode,
    badgeNode,
    describeInvitation,
    durationLabel,
    exerciseLabel,
    focusLabel,
    historyCountLabel,
    historyRowView,
    iconNode,
    initials,
    invitationStatus,
    invitationSummary,
    inviteRequestCountLabel,
    inviteRequestDecisionOutcome,
    inviteRequestErrorMessage,
    inviteRequestView,
    inviteRequestsVisible,
    languageLabel,
    memberRoleActionCopy,
    memberRoleErrorMessage,
    memberRoleMenuNode,
    memberView,
    normalizeInviteRequest,
    normalizeInviteRequestsResponse,
    parseInstant,
    pairingWeekLabel,
    partitionInvitations,
    relativeTime,
    rosterPersonView,
    runSummary,
  });

  root.RandoriCircleUI = api;
})(typeof window !== 'undefined' ? window : globalThis);
