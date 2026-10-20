// Home dashboard presentation helpers (WP-H): the "next step" hero, friendly
// cycle copy, relative and local times, and the collapsed owner diagnostics.
//
// Classic script (loaded synchronously from <head>) so the dashboard code in
// index.html can call it on its first render. It never fetches, routes, or
// derives product state: every input is the server-authoritative payload the
// dashboard already validated, and the output is copy plus presentation.
(function installHomeDashboard(root) {
  const MINUTE_MS = 60 * 1000;
  const HOUR_MS = 60 * MINUTE_MS;
  const DAY_MS = 24 * HOUR_MS;
  // The calendar export describes a 60 minute session; the hero promotes Join
  // from 15 minutes before the start until it ends. Once the start passes the
  // schedule card already calls the agreement past, so the hero says the
  // session "has started" and offers rescheduling rather than "on now".
  const SESSION_LENGTH_MS = 60 * MINUTE_MS;
  const STARTING_SOON_MS = 15 * MINUTE_MS;

  function toTime(value) {
    if (typeof value === 'number') return Number.isFinite(value) ? value : null;
    if (typeof value !== 'string' || !value) return null;
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : null;
  }

  function cleanName(value, fallback = '') {
    const text = typeof value === 'string' ? value.trim() : '';
    return text ? [...text].slice(0, 80).join('') : fallback;
  }

  function relativeTime(instant, now = Date.now(), locale = undefined) {
    const time = toTime(instant);
    if (time === null || !Number.isFinite(now)) return '';
    const diff = time - now;
    const abs = Math.abs(diff);
    if (abs < MINUTE_MS) return 'now';
    let value;
    let unit;
    if (abs < HOUR_MS) { value = Math.round(diff / MINUTE_MS); unit = 'minute'; }
    else if (abs < DAY_MS) { value = Math.round(diff / HOUR_MS); unit = 'hour'; }
    else { value = Math.round(diff / DAY_MS); unit = 'day'; }
    try {
      return new Intl.RelativeTimeFormat(locale, { numeric: 'auto' }).format(value, unit);
    } catch {
      const count = Math.abs(value);
      const label = `${count} ${unit}${count === 1 ? '' : 's'}`;
      return diff > 0 ? `in ${label}` : `${label} ago`;
    }
  }

  function formatInstant(instant, { locale = undefined, timeZone = undefined } = {}) {
    const time = toTime(instant);
    if (time === null) return '';
    const options = {
      weekday: 'short', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', timeZoneName: 'short',
    };
    try {
      return new Intl.DateTimeFormat(locale, { ...options, timeZone }).format(new Date(time));
    } catch {
      try { return new Intl.DateTimeFormat(locale, options).format(new Date(time)); }
      catch { return new Date(time).toISOString(); }
    }
  }

  // "2026-W44" is an implementation key; people read "Week of 26 Oct".
  function cycleWeekLabel(cycle, { locale = undefined } = {}) {
    const time = toTime(cycle?.startsAt);
    if (time === null) return '';
    const options = { month: 'short', day: 'numeric' };
    let day;
    try { day = new Intl.DateTimeFormat(locale, { ...options, timeZone: cycle.timeZone || undefined }).format(new Date(time)); }
    catch { day = new Intl.DateTimeFormat(locale, options).format(new Date(time)); }
    return `Week of ${day}`;
  }

  function proposalIsMine(proposedBy, meId) {
    if (proposedBy === 'self') return true;
    if (proposedBy === 'partner' || proposedBy === null || proposedBy === undefined) return false;
    const id = Number(proposedBy);
    return Number.isSafeInteger(id) && id > 0 && id === Number(meId);
  }

  // One primary next action for a paired week, derived from the normalized
  // server schedule. `joinPrimary` promotes the existing Join button.
  function nextStep({
    schedule = null, meId = null, partnerName = '', now = Date.now(),
    chatAvailable = true, locale = undefined, timeZone = undefined,
  } = {}) {
    const partner = cleanName(partnerName, 'your partner');
    const at = instant => formatInstant(instant, { locale, timeZone });
    const rel = instant => relativeTime(instant, now, locale);
    if (!schedule || typeof schedule !== 'object') {
      return { step: 'loading', tone: 'info', title: 'Checking your session time…', detail: '', action: null, joinPrimary: false };
    }
    const agreed = toTime(schedule.agreed_time);
    if (agreed !== null) {
      if (now < agreed - STARTING_SOON_MS) {
        return {
          step: 'ready', tone: 'success', title: `Session ${rel(agreed)}`,
          detail: `${at(agreed)} with ${partner}. Join the room when it’s time.`, action: null, joinPrimary: true,
        };
      }
      if (now <= agreed + SESSION_LENGTH_MS) {
        return {
          step: 'live', tone: 'success', title: now < agreed ? 'Your session starts soon' : 'Your session has started',
          detail: now < agreed
            ? `${at(agreed)}. Join ${partner} in the pair room.`
            : `It started at ${at(agreed)}. Join ${partner} now if you are practising, or propose a new time below.`,
          action: null, joinPrimary: true,
        };
      }
      return {
        step: 'past', tone: 'neutral', title: 'Your session time has passed',
        detail: 'Open the room to wrap up, or propose a new time below.',
        action: { kind: 'propose', label: 'Propose a new time' }, joinPrimary: false,
      };
    }
    if (schedule.legacy_agreed_time) {
      return {
        step: 'legacy', tone: 'warning', title: 'Confirm your session time',
        detail: 'An older agreement isn’t a precise time. Clear it below and propose a new one.',
        action: { kind: 'propose', label: 'Propose a time' }, joinPrimary: false,
      };
    }
    const future = (Array.isArray(schedule.proposals) ? schedule.proposals : [])
      .filter(item => item && !item.legacy && (toTime(item.instant) ?? -Infinity) > now)
      .sort((left, right) => toTime(left.instant) - toTime(right.instant));
    const theirs = future.find(item => !proposalIsMine(item.proposed_by, meId));
    if (theirs) {
      return {
        step: 'respond', tone: 'action', title: `${partner === 'your partner' ? 'Your partner' : partner} proposed a time`,
        detail: `${at(theirs.instant)} (${rel(theirs.instant)}). Accept it or suggest another time.`,
        action: { kind: 'review', label: 'Review proposed time', proposalId: String(theirs.proposal_id || '') },
        joinPrimary: false,
      };
    }
    if (future.length) {
      return {
        step: 'waiting', tone: 'info', title: `Waiting for ${partner} to accept`,
        detail: `You proposed ${at(future[0].instant)} (${rel(future[0].instant)}).`,
        action: chatAvailable ? { kind: 'chat', label: 'Send a message' } : null, joinPrimary: false,
      };
    }
    return {
      step: 'agree', tone: 'action', title: `Agree a time with ${partner}`,
      detail: 'Propose a time that suits you. Your partner can accept it here.',
      action: { kind: 'propose', label: 'Propose a time' }, joinPrimary: false,
    };
  }

  // Copy for the hero when there is no verified current pair. Titles are
  // stable test anchors; messages avoid internal terms such as snapshots.
  function pairStateCopy(state, {
    week = '', nextCutoff = '', scheduled = '', recovery = '', startsAt = '', canPublishNow = false,
  } = {}) {
    const thisWeek = week || 'this week';
    const availabilityHint = nextCutoff ? ` Set your availability before ${nextCutoff} to be paired next week.` : '';
    const copies = {
      stale: {
        title: 'Previous pairing cycle ended', tone: 'info',
        message: 'That pairing has finished. Your next pairing appears here when it is published.',
      },
      future: {
        title: 'Future pairing is not active yet', tone: 'info',
        message: `It starts ${startsAt || 'when its week begins'}.`,
      },
      pending: {
        title: 'This week’s pairing is scheduled', tone: 'info',
        message: `Pairs are published ${scheduled || 'at the weekly cutoff'}.${recovery ? ` If that is late, a circle owner can publish from ${recovery}.` : ''}`,
      },
      overdue: canPublishNow === true
        ? {
          title: 'This week’s pairing needs publishing', tone: 'warning',
          message: 'The scheduled run didn’t publish this week’s pairs. Publish now — it is safe to retry.',
        }
        : {
          title: 'This week’s pairing is late', tone: 'warning',
          message: 'The scheduled run didn’t publish this week’s pairs. A circle owner can retry it now.',
        },
      unpublished: {
        title: 'Current pairing is not published yet', tone: 'info', availability: true,
        message: `Pairs for ${thisWeek} haven’t been published yet.${availabilityHint}`,
      },
      unavailable: {
        title: 'Unavailable for this cycle', tone: 'info', availability: true,
        message: `You’re skipping ${thisWeek}.${availabilityHint}`,
      },
      missed: {
        title: 'You’re not in this week’s pairing', tone: 'info', availability: true,
        message: `Pairs for ${thisWeek} were published without you, usually because availability wasn’t saved before the cutoff.${availabilityHint}`,
      },
      partner_unavailable: {
        title: 'Partner unavailable', tone: 'warning',
        message: 'Your partner is no longer in this circle. Practise solo this week, or wait for the next pairing.',
      },
      error: {
        title: 'Pairing is temporarily unavailable', tone: 'danger', retry: true,
        message: 'We couldn’t check this week’s pairing, so nothing from an earlier week has been opened. Try again in a moment.',
      },
    };
    const copy = copies[state] || {
      title: 'No current pairing', tone: 'info', message: 'There is no pairing for you this week.',
    };
    return { availability: false, retry: false, ...copy };
  }

  // Applies a nextStep() result to the hero nodes inside the pair card.
  function applyNextStep(nodes, step) {
    const { region, title, detail, action, join } = nodes || {};
    if (!region || !step) return false;
    region.dataset.step = step.step;
    region.dataset.tone = step.tone;
    if (title) title.textContent = step.title;
    if (detail) {
      detail.textContent = step.detail || '';
      detail.hidden = !step.detail;
    }
    if (action) {
      action.hidden = !step.action;
      action.textContent = step.action?.label || '';
      action.dataset.kind = step.action?.kind || '';
      action.dataset.proposalId = step.action?.proposalId || '';
      action.className = step.joinPrimary ? 'btn secondary' : 'btn';
    }
    if (join) join.className = step.joinPrimary || !step.action ? 'btn' : 'btn secondary';
    return true;
  }

  function isDisplayed(element) {
    return !!element && !element.hidden && element.style?.display !== 'none';
  }

  // The admin logs widget keeps owning #logsArea visibility; the collapsed
  // diagnostics disclosure around it is shown only while the widget is.
  function syncDiagnostics(doc) {
    const wrapper = doc?.getElementById?.('dashDiagnostics');
    if (!wrapper) return false;
    const visible = isDisplayed(doc.getElementById('logsArea'));
    wrapper.hidden = !visible;
    return visible;
  }

  function installDiagnostics({
    document: doc = root.document, MutationObserverImpl = root.MutationObserver,
  } = {}) {
    const area = doc?.getElementById?.('logsArea');
    if (!area) return null;
    const sync = () => syncDiagnostics(doc);
    if (typeof MutationObserverImpl === 'function') {
      new MutationObserverImpl(sync).observe(area, { attributes: true, attributeFilter: ['style', 'hidden'] });
    }
    sync();
    return sync;
  }

  const api = Object.freeze({
    SESSION_LENGTH_MS,
    STARTING_SOON_MS,
    applyNextStep,
    cycleWeekLabel,
    formatInstant,
    installDiagnostics,
    nextStep,
    pairStateCopy,
    proposalIsMine,
    relativeTime,
    syncDiagnostics,
  });
  root._randori_home_ui = api;

  const doc = root.document;
  if (doc?.addEventListener) {
    if (doc.readyState === 'loading') doc.addEventListener('DOMContentLoaded', () => installDiagnostics(), { once: true });
    else installDiagnostics();
  }
})(typeof window !== 'undefined' ? window : globalThis);
