// Progressive onboarding presentation (UI redesign WP-O, spec section 8).
//
// One stepper for invited members: invitation -> account -> profile basics ->
// availability -> what happens next. Classic script, loaded synchronously in
// <head> so every inline script can use it on first render; also importable
// from Node for unit tests (it only touches the DOM through arguments).
//
// It never fetches, routes or decides completion. Progress stays
// server-authoritative (docs/SERVER_AUTHORITATIVE_ONBOARDING.md): callers pass
// in the validated profile, availability and pairing values, and this module
// returns copy, view models and DOM for them. Browser storage is used for one
// thing only: remembering that this account dismissed the Home setup guide.
(function installOnboardingFlow(root) {
  'use strict';

  const STEPS = Object.freeze([
    Object.freeze({ key: 'invite', label: 'Invitation' }),
    Object.freeze({ key: 'account', label: 'Account' }),
    Object.freeze({ key: 'profile', label: 'Profile' }),
    Object.freeze({ key: 'availability', label: 'Availability' }),
    Object.freeze({ key: 'next', label: 'What’s next' }),
  ]);
  const FOCUS_VALUES = Object.freeze(['dsa', 'system', 'both']);
  const NAME_MAX = 32;
  const GUIDE_DISMISS_PREFIX = 'randori-setup-guide-dismissed:';
  const DEFAULT_LOCALE = 'en-GB';

  function stepIndex(key) {
    return STEPS.findIndex(step => step.key === key);
  }

  // "Step n of 5" plus a done/current/upcoming state for each step.
  function stepperModel(current) {
    const index = Math.max(0, stepIndex(current));
    return {
      index,
      total: STEPS.length,
      current: STEPS[index].key,
      text: `Step ${index + 1} of ${STEPS.length}`,
      items: STEPS.map((step, position) => ({
        key: step.key,
        label: step.label,
        state: position < index ? 'done' : (position === index ? 'current' : 'upcoming'),
      })),
    };
  }

  // Renders the <ol aria-label="Setup progress"> with DOM nodes only.
  function renderStepper(list, status, current, doc = root.document) {
    const model = stepperModel(current);
    if (list && doc?.createElement) {
      const nodes = model.items.map((item, position) => {
        const li = doc.createElement('li');
        li.className = 'rc-step';
        li.dataset.state = item.state;
        li.dataset.step = item.key;
        if (item.state === 'current') li.setAttribute('aria-current', 'step');
        const marker = doc.createElement('span');
        marker.className = 'rc-step-marker';
        marker.setAttribute('aria-hidden', 'true');
        marker.textContent = item.state === 'done' ? '✓' : String(position + 1);
        const label = doc.createElement('span');
        label.className = 'rc-step-label';
        label.textContent = item.label;
        const state = doc.createElement('span');
        state.className = 'sr-only';
        state.textContent = item.state === 'done' ? ' (done)' : (item.state === 'current' ? ' (current step)' : '');
        li.append(marker, label, state);
        return li;
      });
      list.replaceChildren(...nodes);
      list.dataset.current = model.current;
    }
    if (status) status.textContent = model.text;
    return model;
  }

  function toTime(value) {
    if (typeof value === 'number') return Number.isFinite(value) ? value : null;
    if (typeof value !== 'string' || !value) return null;
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : null;
  }

  function safeFormat(time, options, { locale = DEFAULT_LOCALE, timeZone } = {}) {
    try { return new Intl.DateTimeFormat(locale, { ...options, timeZone: timeZone || undefined }).format(new Date(time)); }
    catch {
      try { return new Intl.DateTimeFormat(locale, options).format(new Date(time)); }
      catch { return new Date(time).toISOString().slice(0, 10); }
    }
  }

  // "2026-W44" is an implementation key; people read "Week of 25 Oct".
  function weekOf(cycle, { locale = DEFAULT_LOCALE } = {}) {
    const time = toTime(cycle?.startsAt);
    if (time === null) return '';
    return `Week of ${safeFormat(time, { day: 'numeric', month: 'short' }, { locale, timeZone: cycle?.timeZone })}`;
  }

  // Inline phrase for sentences: "the week of 25 Oct", or a safe fallback.
  function weekPhrase(cycle, fallback = 'the upcoming cycle', options) {
    const label = weekOf(cycle, options);
    return label ? `the ${label.charAt(0).toLowerCase()}${label.slice(1)}` : fallback;
  }

  // "Sun 25 Oct, 08:00 GMT" in the member's own time zone.
  function formatMoment(instant, timeZone, { locale = DEFAULT_LOCALE } = {}) {
    const time = toTime(instant);
    if (time === null) return '';
    return safeFormat(time, {
      weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', timeZoneName: 'short',
    }, { locale, timeZone });
  }

  function detectTimeZone(intl = root.Intl) {
    try {
      const zone = intl?.DateTimeFormat?.().resolvedOptions?.().timeZone;
      return validTimeZone(zone) ? zone : 'UTC';
    } catch { return 'UTC'; }
  }

  function validTimeZone(zone) {
    if (typeof zone !== 'string' || !zone.trim()) return false;
    try { new Intl.DateTimeFormat('en', { timeZone: zone }).format(new Date(0)); return true; }
    catch { return false; }
  }

  function clip(value, max) {
    return [...String(value ?? '').replace(/\s+/gu, ' ').trim()].slice(0, max).join('');
  }

  // "Skip for now" saves the server-required minimum: a display name and a
  // valid time zone. Optional fields (bio, LeetCode, colour) are left alone.
  function profileMinimum({ name = '', accountName = '', email = '', timeZone = '', detectedTimeZone = 'UTC', focus = 'both' } = {}) {
    let displayName = clip(name, NAME_MAX) || clip(accountName, NAME_MAX);
    if (!displayName) displayName = clip(String(email || '').split('@')[0], NAME_MAX);
    const tz = validTimeZone(timeZone) ? timeZone : (validTimeZone(detectedTimeZone) ? detectedTimeZone : 'UTC');
    if (!displayName) return { ok: false, error: 'Enter a display name to continue.' };
    return {
      ok: true,
      payload: { display_name: displayName, tz, interview_focus: FOCUS_VALUES.includes(focus) ? focus : 'both' },
    };
  }

  // The availability step: an honest description of the saved or inherited
  // state for the exact upcoming cycle, and what "Decide later" means.
  function availabilityStep(value, { timeZone } = {}) {
    if (!value || typeof value !== 'object' || !value.cycle) {
      return {
        title: 'Are you in for the next cycle?',
        lead: 'Checking the next pairing cycle…',
        next: 'Decide later',
        decided: false,
        note: 'You can set this any time from Home or Pairing.',
      };
    }
    const week = weekPhrase(value.cycle, 'the next cycle');
    // The card below already shows the cutoff in the circle's zone; this note
    // repeats it in the member's own zone ("your time").
    const cutoff = formatMoment(value.cycle.cutoffAt, timeZone || value.cycle.timeZone);
    const decided = value.source === 'user';
    const inherited = value.isAvailable ? 'counted as in' : 'counted as skipping';
    const by = cutoff ? `${cutoff} your time` : 'the cutoff';
    let note;
    if (!value.editable) note = `The cutoff for ${week} has passed. You’ll be able to choose for the following cycle.`;
    else if (decided) note = `Saved. You can change it until ${by}.`;
    else note = `Not decided yet. Choose by ${by}, or decide later — until then you’re ${inherited} (${value.source === 'legacy_bridge' ? 'your previous setting' : 'the circle default'}).`;
    return {
      title: `Are you in for ${week}?`,
      lead: 'Pairs are made from members who say they’re in. Choose for this cycle only.',
      next: decided || !value.editable ? 'Continue' : 'Decide later',
      decided,
      note,
    };
  }

  // "What happens next": a three-item timeline driven by the upcoming cycle.
  function nextSteps(value, { timeZone, remindersOn = true } = {}) {
    const publish = value?.cycle ? formatMoment(value.cycle.cutoffAt, timeZone || value.cycle.timeZone) : '';
    const week = weekPhrase(value?.cycle, 'the next cycle');
    const skipping = value?.source === 'user' && value.isAvailable === false;
    return [
      {
        key: 'publish',
        title: publish ? `Pairings publish ${publish}` : 'Pairings publish at the weekly cutoff',
        detail: skipping
          ? `You’re skipping ${week}. You’ll be included again when you say you’re in.`
          : `Members who are in for ${week} are paired. Odd number? Someone gets solo practice.`,
      },
      {
        key: 'email',
        title: remindersOn ? 'You’ll get an email' : 'Check Home for your pair',
        detail: remindersOn
          ? 'We email you when your pair is ready. Your partner appears on Home too.'
          : 'Email reminders are off, so your pair shows up on Home.',
      },
      {
        key: 'agree',
        title: 'Agree a time with your partner',
        detail: 'Propose a time in your own time zone, then practise together in the pair room.',
      },
    ];
  }

  function renderTimeline(list, items, doc = root.document) {
    if (!list || !doc?.createElement) return 0;
    const nodes = items.map((item, position) => {
      const li = doc.createElement('li');
      li.className = 'rc-timeline-item';
      li.dataset.step = item.key;
      const marker = doc.createElement('span');
      marker.className = 'rc-timeline-marker';
      marker.setAttribute('aria-hidden', 'true');
      marker.textContent = String(position + 1);
      const body = doc.createElement('div');
      const title = doc.createElement('h3');
      title.className = 'rc-timeline-title';
      title.textContent = item.title;
      const detail = doc.createElement('p');
      detail.className = 'rc-timeline-detail';
      detail.textContent = item.detail;
      body.append(title, detail);
      li.append(marker, body);
      return li;
    });
    list.replaceChildren(...nodes);
    return nodes.length;
  }

  // Dashboard availability badge (short, no ISO week codes).
  function availabilityBadge(value) {
    if (!value?.cycle) return '';
    const week = weekPhrase(value.cycle, 'the next cycle');
    if (!value.editable) return `Review closed cycle (${week})`;
    if (value.source === 'cycle_default') return `Confirm default for ${week}`;
    if (value.source === 'legacy_bridge') return `Confirm inherited choice for ${week}`;
    return value.isAvailable ? `Available for ${week}` : `Skipping ${week}`;
  }

  // Setup-guide item copy. Status values come from the onboarding authority:
  // idle | loading | ready | error.
  function checklistCopy({ profile = {}, availability = {}, pairing = {}, profileDone = false, availabilityDone = false, pairingDone = false, roomDone = false } = {}) {
    const availWeek = weekPhrase(availability.value?.cycle);
    const pairWeek = weekPhrase(pairing.value?.cycle, 'the current cycle');
    return {
      signIn: 'Signed in to your private circle',
      profile: profile.status === 'loading' ? 'Checking saved profile…'
        : profile.status === 'error' ? 'Profile status unknown — retry'
          : profileDone ? 'Profile saved' : 'Complete your profile',
      availability: availability.status === 'loading' ? 'Checking cycle availability…'
        : availability.status === 'error' ? 'Availability status unknown — retry'
          : availabilityDone ? `Availability saved for ${availWeek}` : `Save availability for ${availWeek}`,
      availabilityAction: availability.value?.isAvailable ? 'Confirm or skip' : 'Confirm skip or change',
      availabilityActionLabel: `Choose availability for ${availWeek}`,
      pairing: pairing.status === 'loading' ? 'Checking current pairing…'
        : pairing.status === 'error' ? 'Pairing status unknown — retry'
          : pairingDone ? `Current assignment published for ${pairWeek}` : 'Your next pairing appears on Home once it is published',
      room: roomDone ? 'Current workspace opened' : 'Open your current workspace',
    };
  }

  // The first unfinished setup step, for "Continue setup".
  function nextSetupStep({ profileDone = false, availabilityDone = false } = {}) {
    if (!profileDone) return 'profile';
    if (!availabilityDone) return 'availability';
    return 'next';
  }

  // Someone who joined after this week's cutoff was never eligible for it:
  // never tell them pairing is "late" or that they were left out.
  function joinedAfterCutoff({ createdAt, current } = {}) {
    const joined = toTime(createdAt);
    const cutoff = toTime(current?.cutoffAt) ?? toTime(current?.startsAt);
    return joined !== null && cutoff !== null && joined >= cutoff;
  }

  function newMemberHeroCopy(state, { createdAt, current, upcoming } = {}) {
    if (!['overdue', 'missed', 'unpublished', 'pending'].includes(state)) return null;
    if (!joinedAfterCutoff({ createdAt, current })) return null;
    const next = weekPhrase(upcoming, 'the next cycle');
    return {
      title: `You’ll be included from ${next}`,
      message: 'You joined after this week’s pairs were decided. Say you’re in for the next cycle and you’ll be paired when it publishes.',
      tone: 'info',
      availability: true,
      retry: false,
    };
  }

  function guideDismissKey(userId) {
    const id = Number(userId);
    return Number.isSafeInteger(id) && id > 0 ? `${GUIDE_DISMISS_PREFIX}${id}` : '';
  }

  function guideDismissed(storage, userId) {
    const key = guideDismissKey(userId);
    if (!key) return false;
    try { return storage?.getItem?.(key) === '1'; } catch { return false; }
  }

  function setGuideDismissed(storage, userId, dismissed) {
    const key = guideDismissKey(userId);
    if (!key) return false;
    try {
      if (dismissed) storage?.setItem?.(key, '1');
      else storage?.removeItem?.(key);
      return true;
    } catch { return false; }
  }

  // Reads a single-use token from a URL fragment such as "#token=abc".
  function fragmentToken(hash, name = 'token') {
    const text = String(hash ?? '').replace(/^#/, '');
    if (!text) return '';
    try { return new URLSearchParams(text).get(name) || ''; } catch { return ''; }
  }

  const api = Object.freeze({
    STEPS,
    availabilityBadge,
    availabilityStep,
    checklistCopy,
    detectTimeZone,
    formatMoment,
    fragmentToken,
    guideDismissKey,
    guideDismissed,
    joinedAfterCutoff,
    newMemberHeroCopy,
    nextSetupStep,
    nextSteps,
    profileMinimum,
    renderStepper,
    renderTimeline,
    setGuideDismissed,
    stepIndex,
    stepperModel,
    validTimeZone,
    weekOf,
    weekPhrase,
  });
  root._randori_onboarding_flow = api;
})(typeof window !== 'undefined' ? window : globalThis);
