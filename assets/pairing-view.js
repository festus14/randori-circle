// Availability and pairing view model (WP-P).
//
// Pure presentation helpers for the "This week's cycle" view. Every function
// maps already-validated, server-authoritative state to display copy and
// control states. Nothing here fetches, stores, or decides product state:
// availability versions, publication fences and pairing data stay owned by the
// inline application script in index.html.
//
// Loaded as a classic script (before the application script) so renderers can
// call it synchronously; node tests import the same file as an ES module.
(function installPairingView(root) {
  const ISO_WEEK = /^(\d{4})-W(\d{2})$/;
  const MINUTE = 60 * 1000;
  const HOUR = 60 * MINUTE;
  const DAY = 24 * HOUR;

  function weekNumber(cycleId) {
    const match = ISO_WEEK.exec(String(cycleId || ''));
    if (!match) return null;
    const week = Number(match[2]);
    return week >= 1 && week <= 53 ? week : null;
  }

  function weekLabel(cycleId, { capitalize = false } = {}) {
    const week = weekNumber(cycleId);
    if (week === null) return capitalize ? 'This cycle' : 'this cycle';
    return `${capitalize ? 'Week' : 'week'} ${week}`;
  }

  function validInstant(value) {
    const millis = typeof value === 'number' ? value : Date.parse(value);
    return Number.isFinite(millis) ? new Date(millis) : null;
  }

  function format(value, timeZone, options, locale) {
    const instant = validInstant(value);
    if (!instant) return 'an unknown time';
    try {
      return new Intl.DateTimeFormat(locale, { ...options, timeZone: timeZone || undefined }).format(instant);
    } catch {
      return new Intl.DateTimeFormat(locale, options).format(instant);
    }
  }

  // "Mon, 21 Sep 2026" (order follows the viewer's locale).
  function formatDay(value, timeZone, locale) {
    return format(value, timeZone, { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' }, locale);
  }

  // "Sun, 20 Sep, 18:00 BST" (year omitted; the cycle dates carry it).
  function formatMoment(value, timeZone, locale) {
    return format(value, timeZone, {
      weekday: 'short', day: 'numeric', month: 'short',
      hour: '2-digit', minute: '2-digit', timeZoneName: 'short',
    }, locale);
  }

  function plural(count, unit) {
    return `${count} ${unit}${count === 1 ? '' : 's'}`;
  }

  // Remaining time until a server-provided instant, rounded down so the copy
  // never promises more time than is left.
  function countdown(target, now = Date.now()) {
    const end = validInstant(target);
    if (!end || !Number.isFinite(now)) return { closed: false, urgent: false, text: '' };
    const remaining = end.getTime() - now;
    if (remaining <= 0) return { closed: true, urgent: false, text: '' };
    if (remaining < HOUR) {
      const minutes = Math.max(1, Math.floor(remaining / MINUTE));
      return { closed: false, urgent: true, text: `${plural(minutes, 'minute')} left` };
    }
    if (remaining < DAY) {
      const hours = Math.floor(remaining / HOUR);
      return { closed: false, urgent: true, text: `${plural(hours, 'hour')} left` };
    }
    const days = Math.floor(remaining / DAY);
    const hours = Math.floor((remaining % DAY) / HOUR);
    return {
      closed: false,
      urgent: false,
      text: hours ? `${plural(days, 'day')} ${plural(hours, 'hour')} left` : `${plural(days, 'day')} left`,
    };
  }

  function initials(name) {
    const words = String(name || '').trim().split(/\s+/).filter(Boolean);
    if (!words.length) return '?';
    const letters = words.length > 1 ? words[0][0] + words[words.length - 1][0] : words[0].slice(0, 2);
    return letters.toUpperCase();
  }

  // Readable initials on a profile color: dark ink on light colors, white on
  // dark ones. Non-hex values (CSS variables) keep the stylesheet default.
  function avatarInk(color) {
    const hex = String(color || '');
    if (!/^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(hex)) return '';
    const full = hex.length === 4 ? `#${[...hex.slice(1)].map(c => c + c).join('')}` : hex;
    const [r, g, b] = [1, 3, 5]
      .map(i => parseInt(full.slice(i, i + 2), 16) / 255)
      .map(v => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
    return 0.2126 * r + 0.7152 * g + 0.0722 * b > 0.18 ? '#0B0D12' : '#FFFFFF';
  }

  function decisionCopy(value) {
    const week = weekLabel(value.cycle.cycleId);
    const choice = value.isAvailable ? 'in' : 'skipping';
    if (value.source === 'user') {
      if (!value.editable) return `Saved choice: you're ${choice} for ${week}. The cutoff has passed.`;
      return value.isAvailable
        ? `Saved choice: you're in for ${week}. You can change it until the cutoff.`
        : `Saved choice: you're skipping ${week}. Only this cycle is affected, and you can change it until the cutoff.`;
    }
    const inherited = value.isAvailable ? 'available' : 'skipping';
    if (value.source === 'legacy_bridge') {
      return value.editable
        ? `Nothing is saved for ${week} yet. Your previous account setting counts you as ${inherited}. Choose an option to confirm it.`
        : `Nothing was saved for ${week}. Your previous account setting counted you as ${inherited}, and the cutoff has passed.`;
    }
    return value.editable
      ? `Nothing is saved for ${week} yet. Randori includes you by default so pairs can form. Choose "I'm in" to confirm or skip this cycle.`
      : `Nothing was saved for ${week}. Randori includes you by default, and the cutoff has passed.`;
  }

  function badgeFor(value, saving, shownValue) {
    if (saving) return { text: shownValue ? "Saving: I'm in…" : 'Saving: skip…', tone: 'info' };
    if (!value.editable) {
      return { text: value.source === 'user' ? 'Closed · Saved' : 'Closed · Not saved', tone: 'neutral' };
    }
    if (value.source === 'user') {
      return value.isAvailable
        ? { text: "Saved · You're in", tone: 'success' }
        : { text: 'Saved · Skipping', tone: 'neutral' };
    }
    return {
      text: value.isAvailable ? 'Not saved · Included' : 'Not saved · Skipping',
      tone: 'warning',
    };
  }

  // Availability card for the upcoming cycle. `value` is the validated
  // availability envelope (or null); the flags mirror availabilityState.
  function availabilityView({
    signedIn = false, value = null, loading = false, saving = false, pendingValue = null,
    error = '', notice = '', online = true, now = Date.now(), locale,
  } = {}) {
    // Offline with a value: keep the choice visible and explain the disabled
    // controls. Offline without one: the shell banner already says offline, so
    // only the retry status changes.
    const offlineNote = online || !value ? null : {
      tone: 'warning',
      text: "You're offline. Your last saved choice is shown; reconnect to change it.",
    };
    const status = !online && !value && error
      ? "You're offline. Reconnect, then retry."
      : String(error || notice || '');
    const idle = { disabled: true, pressed: false };
    if (!signedIn) {
      return {
        visible: false, busy: false, title: 'Your availability', badge: { text: '', tone: 'neutral' },
        decision: '', cycleText: '', cutoffText: '', note: null, status: '',
        retry: { hidden: true, disabled: false },
        available: { ...idle, text: "I'm in" }, skip: { ...idle, text: 'Skip this cycle' },
      };
    }
    if (!value) {
      return {
        visible: !!error,
        busy: !!(loading || saving),
        title: 'Your availability',
        badge: loading ? { text: 'Loading…', tone: 'neutral' } : { text: "Couldn't load", tone: 'danger' },
        decision: loading
          ? 'Loading your saved choice for the next cycle…'
          : "Your choice for the next cycle can't be shown right now.",
        cycleText: loading ? 'Loading the upcoming pairing cycle…' : 'The upcoming cycle could not be loaded.',
        cutoffText: '',
        note: offlineNote,
        status,
        retry: { hidden: !error, disabled: !!loading },
        available: { ...idle, text: "I'm in" },
        skip: { ...idle, text: 'Skip this cycle' },
      };
    }
    const shownValue = saving && typeof pendingValue === 'boolean' ? pendingValue : value.isAvailable;
    const disabled = !!saving || !value.editable || !online;
    const { cycle } = value;
    const left = countdown(cycle.cutoffAt, now);
    const cutoff = `Decide by ${formatMoment(cycle.cutoffAt, cycle.timeZone, locale)} (${cycle.timeZone})`;
    let cutoffText = `${cutoff}.`;
    if (!value.editable) cutoffText = `The cutoff for ${weekLabel(cycle.cycleId)} has passed.`;
    else if (left.text) cutoffText = `${cutoff} · ${left.text}.`;
    return {
      visible: true,
      busy: !!(loading || saving),
      title: `Are you in for ${weekLabel(cycle.cycleId)}?`,
      badge: badgeFor(value, saving, shownValue),
      decision: decisionCopy(value),
      cycleText: `Upcoming cycle starts ${formatDay(cycle.startsAt, cycle.timeZone, locale)} and ends ${formatDay(cycle.endsAt, cycle.timeZone, locale)}.`,
      cutoffText,
      cutoffUrgent: value.editable && left.urgent,
      note: offlineNote,
      status,
      retry: { hidden: true, disabled: false },
      available: {
        disabled,
        pressed: value.source === 'user' && value.isAvailable,
        text: saving && shownValue ? 'Saving…' : "I'm in",
      },
      skip: {
        disabled,
        pressed: value.source === 'user' && !value.isAvailable,
        text: saving && !shownValue ? 'Saving…' : 'Skip this cycle',
      },
    };
  }

  function savedToast(value) {
    if (!value) return 'Availability saved';
    const week = weekLabel(value.cycle?.cycleId);
    return value.isAvailable ? `You're in for ${week}` : `Skipping ${week}`;
  }

  // Owner tools: publication status and the idempotent recovery action.
  function publicationView({
    signedIn = false, isOwner = false, publication = null, allowed = false, publishing = false,
    retryReady = false, upcoming = null, loadFailed = false, online = true, locale,
  } = {}) {
    const visible = !!signedIn && (!!isOwner || !!allowed);
    const button = {
      hidden: !allowed,
      disabled: !!publishing || !online,
      text: publishing ? 'Publishing…' : (retryReady ? 'Retry publication' : 'Publish now'),
    };
    const nextCutoff = upcoming?.cutoffAt
      ? `Next cutoff: ${formatMoment(upcoming.cutoffAt, upcoming.timeZone, locale)}.`
      : '';
    const base = {
      visible,
      button,
      hint: !online && allowed ? "You're offline. Reconnect to publish." : nextCutoff,
    };
    if (publishing) {
      return { ...base, state: 'publishing', tone: 'info', title: 'Publishing…', text: 'Publishing this cycle. This is safe to retry if it fails.' };
    }
    if (!publication) {
      return loadFailed
        ? { ...base, state: 'unknown', tone: 'danger', title: 'Status unavailable', text: "Publication status can't be checked right now. Owner actions return once it loads." }
        : { ...base, state: 'loading', tone: 'neutral', title: 'Checking…', text: 'Checking the publication status for this cycle…' };
    }
    const zone = publication.time_zone;
    if (publication.state === 'published') {
      return {
        ...base, state: 'published', tone: 'success', title: 'Published',
        text: `This cycle's pairs were published ${formatMoment(publication.published_at, zone, locale)}.`,
      };
    }
    if (publication.state === 'overdue') {
      return {
        ...base, state: 'overdue', tone: 'warning', title: 'Publication is late',
        text: allowed
          ? (retryReady
            ? 'The last attempt failed. Retry publication: a cycle is only ever published once, so retrying is safe.'
            : "The scheduled run didn't publish this cycle. Publish now: a cycle is only ever published once, so retrying is safe.")
          : "The scheduled run didn't publish this cycle. Manual publishing isn't available for this circle.",
      };
    }
    return {
      ...base, state: 'pending', tone: 'info', title: 'Scheduled',
      text: `Pairs publish automatically at ${formatMoment(publication.scheduled_at, zone, locale)}. If that run fails, you can publish manually from ${formatMoment(publication.recovery_at, zone, locale)}.`,
    };
  }

  // Member-facing status for the current cycle's pairs card.
  function pairsStatusView(kind, {
    cycleId = '', publication = null, allowed = false, upcoming = null, online = true, locale,
  } = {}) {
    const week = weekLabel(cycleId, { capitalize: true });
    switch (kind) {
      case 'load-error':
        return {
          tone: online ? 'danger' : 'warning',
          meta: 'Current-cycle pairings could not be loaded.',
          title: online ? "Pairs couldn't be loaded" : "You're offline",
          body: online
            ? 'Pairings are unavailable right now. Local or cached pairs are not shown while signed in.'
            : 'Reconnect to see this week’s pairs. Local or cached pairs are not shown while signed in.',
          retry: true,
        };
      case 'unverified':
        return {
          tone: 'danger',
          meta: 'Current-cycle publication state could not be verified.',
          title: "Pairs can't be verified",
          body: 'Pairs stay hidden until the server state can be verified. Try again shortly.',
          retry: true,
        };
      case 'future':
      case 'stale':
      case 'invalid':
        return {
          tone: 'warning',
          meta: kind === 'future'
            ? 'The returned pairing cycle has not started yet.'
            : kind === 'stale'
              ? 'The returned pairing cycle has ended.'
              : 'The current pairing cycle could not be verified.',
          title: 'Schedule not confirmed',
          body: 'No earlier or unverified pairing room is shown. Try again once the schedule is available.',
          retry: true,
        };
      case 'unpublished': {
        const state = publication?.state;
        const zone = publication?.time_zone;
        const next = upcoming?.cutoffAt
          ? ` · next cutoff ${formatMoment(upcoming.cutoffAt, upcoming.timeZone, locale)}`
          : '';
        const meta = state === 'overdue'
          ? `${week} · publication is late`
          : state === 'pending'
            ? `${week} · pairs publish ${formatMoment(publication.scheduled_at, zone, locale)}`
            : `${week} · awaiting current-cycle publication${next}`;
        const body = state === 'overdue'
          ? (allowed
            ? 'The scheduled run did not publish this cycle. Use Publish now in Owner tools below; retrying is safe.'
            : 'The scheduled run did not publish this cycle. A circle owner can publish it now.')
          : state === 'pending'
            ? `Pairs publish automatically at ${formatMoment(publication.scheduled_at, zone, locale)}. Check back after that.`
            : 'No pairings have been published for the current cycle.';
        return { tone: state === 'overdue' ? 'warning' : 'neutral', meta, title: 'Pairs not published yet', body, retry: false };
      }
      default:
        return { tone: 'neutral', meta: 'Loading this week’s pairs…', title: 'Loading pairs…', body: '', retry: false };
    }
  }

  function publishedMeta({ cycleId = '', count = 0, startsAt = null, timeZone = '', locale } = {}) {
    const total = Number.isSafeInteger(count) && count > 0 ? count : 0;
    const since = startsAt ? ` · started ${formatDay(startsAt, timeZone, locale)}` : '';
    return `${weekLabel(cycleId, { capitalize: true })} · ${plural(total, 'pair')}${since}`;
  }

  // Normalize one published pair into display members. Names are returned as
  // plain strings for textContent; colors are validated by the caller.
  function pairMembers(pair, userId) {
    const me = Number(userId);
    const source = Array.isArray(pair?.members) && pair.members.length
      ? pair.members
      : [
        { id: pair?.a_id, name: pair?.a_name, color: pair?.a_color },
        { id: pair?.b_id, name: pair?.b_name, color: pair?.b_color, is_ai: pair?.is_ai === true },
      ];
    const solo = pair?.solo === true || pair?.is_ai === true;
    const members = source
      .filter(member => member && typeof member === 'object')
      .filter(member => !(solo && member.is_ai === true))
      .map(member => {
        const isMe = Number.isSafeInteger(me) && me > 0 && Number(member.id) === me;
        const name = String(member.name || 'Member').trim() || 'Member';
        return { name, initials: initials(name), color: member.color, isMe };
      });
    // Some producers (secondary circles) withhold member ids; then the viewer's
    // own pair cannot be identified and callers must not claim either way.
    const identityKnown = source.some(member => Number.isSafeInteger(Number(member?.id)) && Number(member?.id) > 0);
    return { members, solo, mine: members.some(member => member.isMe), identityKnown };
  }

  root._randori_pairing_view = Object.freeze({
    weekNumber,
    weekLabel,
    formatDay,
    formatMoment,
    countdown,
    initials,
    avatarInk,
    availabilityView,
    savedToast,
    publicationView,
    pairsStatusView,
    publishedMeta,
    pairMembers,
  });
})(typeof window !== 'undefined' ? window : globalThis);
