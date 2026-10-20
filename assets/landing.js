// Public landing and recovery-page behaviour (UI redesign WP-L1).
//
// Classic script, loaded synchronously in <head> so the auth layer can hand
// it capabilities as soon as they resolve. Also importable from Node for unit
// tests: it only touches the DOM through the document passed to mount().
//
// Invite-request contract: docs/INVITE_REQUESTS.md (WP-L2). The form is shown
// only when /api/auth/capabilities advertises `inviteRequests: true`; the
// success copy is fixed client-side so every accepted outcome looks identical.
(function installLanding(root) {
  'use strict';

  const NAME_MIN = 2;
  const NAME_MAX = 60;
  const EMAIL_MAX = 254;
  const NOTE_MAX = 280;
  const REQUEST_TIMEOUT_MS = 15000;
  const ENDPOINT = '/api/invite-requests';

  const MESSAGES = Object.freeze({
    success: 'Thanks — if the circle has room, you’ll get an invitation by email.',
    rateLimited: 'Too many requests — try again later.',
    unavailable: 'Invite requests are paused right now. Ask a member for an invitation, or try again later.',
    network: 'We couldn’t send your request. Check your connection and try again.',
    rejected: 'This page couldn’t send your request. Reload the page and try again.',
    generic: 'Something went wrong on our side. Try again in a moment.',
    invalidForm: 'Check the highlighted fields and try again.',
  });

  // Same character classes the server rejects (controls, line/paragraph
  // separators, bidi overrides and isolates).
  const UNSAFE_NAME = /[\u0000-\u001F\u007F-\u009F\u2028\u2029\u202A-\u202E\u2066-\u2069]/u;
  const UNSAFE_NOTE = /[\u0000-\u0009\u000B-\u001F\u007F-\u009F\u2028\u2029\u202A-\u202E\u2066-\u2069]/u;
  const EMAIL_SHAPE = /^[^\s@]+@[^\s@.]+(?:\.[^\s@.]+)+$/;

  function codePoints(value) {
    return Array.from(String(value)).length;
  }

  function normalizeName(value) {
    return String(value ?? '').replace(/\s+/gu, ' ').trim().normalize('NFC');
  }

  function normalizeEmail(value) {
    return String(value ?? '').trim().toLowerCase();
  }

  function normalizeNote(value) {
    const note = String(value ?? '').replace(/\r\n?/g, '\n').trim();
    return note ? note.normalize('NFC') : null;
  }

  function validateInviteRequest(fields = {}) {
    const errors = {};
    const name = normalizeName(fields.name);
    const email = normalizeEmail(fields.email);
    const note = normalizeNote(fields.note);
    const nameLength = codePoints(name);
    if (!name) errors.name = 'Enter your name.';
    else if (UNSAFE_NAME.test(name)) errors.name = 'Remove unusual characters from your name.';
    else if (nameLength < NAME_MIN) errors.name = `Name must be at least ${NAME_MIN} characters.`;
    else if (nameLength > NAME_MAX) errors.name = `Name must be ${NAME_MAX} characters or fewer.`;
    // The shared strict rules (assets/email-validation.js, also used by the
    // server) apply once that module has loaded; the shape check is only a
    // fallback if it failed to load. The server re-validates either way.
    const rules = root.RandoriEmailValidation;
    const verdict = rules && email ? rules.validateEmail(email) : null;
    if (!email) errors.email = 'Enter your email address.';
    else if (email.length > EMAIL_MAX) errors.email = `Email must be ${EMAIL_MAX} characters or fewer.`;
    else if (verdict && !verdict.ok) errors.email = rules.emailProblemMessage(verdict.reason);
    else if (!verdict && !EMAIL_SHAPE.test(email)) errors.email = 'Enter an email address like name@example.com.';
    if (note !== null) {
      if (UNSAFE_NOTE.test(note)) errors.note = 'Remove unusual characters from this note.';
      else if (codePoints(note) > NOTE_MAX) errors.note = `Keep this to ${NOTE_MAX} characters or fewer.`;
    }
    const ok = Object.keys(errors).length === 0;
    return {
      ok,
      errors,
      payload: ok ? { name, email, note, website: String(fields.website ?? '') } : null,
    };
  }

  function noteCounter(value) {
    const used = codePoints(String(value ?? '').replace(/\r\n?/g, '\n'));
    return { used, remaining: NOTE_MAX - used, text: `${used} / ${NOTE_MAX}` };
  }

  function boundedText(value) {
    return typeof value === 'string' && value.trim() ? value.trim().slice(0, 200) : null;
  }

  // Maps an HTTP outcome to UI state. Server text is used only for 400 field
  // messages (rendered with textContent); everything else uses fixed copy.
  function interpretInviteRequestResponse({ status, body, networkError } = {}) {
    if (networkError) return { state: 'error', message: MESSAGES.network, fields: {} };
    if (status === 202 || (status >= 200 && status < 300 && body?.ok === true)) {
      return { state: 'success', message: MESSAGES.success, fields: {} };
    }
    if (status === 400) {
      const fields = {};
      for (const key of ['name', 'email', 'note', 'form']) {
        const message = boundedText(body?.fields?.[key]);
        if (message) fields[key] = message;
      }
      if (!fields.name && !fields.email && !fields.note && !fields.form) fields.form = MESSAGES.invalidForm;
      return { state: 'invalid', message: fields.form || MESSAGES.invalidForm, fields };
    }
    if (status === 429) return { state: 'rate-limited', message: MESSAGES.rateLimited, fields: {} };
    if (status === 404 || status === 503) return { state: 'unavailable', message: MESSAGES.unavailable, fields: {} };
    if (status === 403) return { state: 'error', message: MESSAGES.rejected, fields: {} };
    return { state: 'error', message: MESSAGES.generic, fields: {} };
  }

  async function submitInviteRequest(payload, { fetchImpl, timeoutMs = REQUEST_TIMEOUT_MS } = {}) {
    const doFetch = fetchImpl || (typeof root.fetch === 'function' ? root.fetch.bind(root) : null);
    if (!doFetch) return interpretInviteRequestResponse({ networkError: true });
    const controller = typeof AbortController === 'function' ? new AbortController() : null;
    const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;
    try {
      const response = await doFetch(ENDPOINT, {
        method: 'POST',
        credentials: 'same-origin',
        cache: 'no-store',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
        signal: controller?.signal,
      });
      let body = null;
      try { body = await response.json(); } catch { body = null; }
      return interpretInviteRequestResponse({ status: response.status, body });
    } catch {
      return interpretInviteRequestResponse({ networkError: true });
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  // ----------------------------------------------------------- recovery ---

  const RECOVERY_TITLES = Object.freeze({
    invite: {
      default: 'You’re invited to Randori',
      expired: 'This invitation link has expired',
      failed: 'This invitation link can’t be used',
    },
    activation: {
      default: 'Activate your Randori account',
      verified: 'Your account is ready',
      expired: 'This verification link has expired',
      revoked: 'This verification link can’t be used',
      invalid: 'This verification link can’t be used',
    },
    passwordReset: {
      default: 'Choose a new password',
      reset: 'Password changed',
      expired: 'This reset link has expired',
      used: 'This reset link was already used',
      revoked: 'This reset link can’t be used',
      invalid: 'This reset link can’t be used',
    },
  });

  const RECOVERY_DEAD_ENDS = Object.freeze({
    invite: ['expired', 'failed'],
    activation: ['expired', 'revoked', 'invalid'],
    passwordReset: ['expired', 'revoked', 'invalid'],
  });

  const RECOVERY_IDS = Object.freeze({
    invite: { title: 'inviteTitle', steps: 'inviteNextSteps' },
    activation: { title: 'activationTitle', steps: 'activationNextSteps' },
    passwordReset: { title: 'passwordResetTitle', steps: 'passwordResetNextSteps' },
  });

  function recoveryState(page, status) {
    const titles = RECOVERY_TITLES[page];
    if (!titles) return null;
    return {
      title: titles[status] || titles.default,
      showNextSteps: RECOVERY_DEAD_ENDS[page].includes(status),
    };
  }

  // --------------------------------------------------------------- DOM ---

  const state = {
    doc: null,
    fetchImpl: null,
    capabilities: { loaded: false, failed: false, inviteRequests: false },
    pending: false,
    submitted: false,
    revealed: false,
    recovery: {},
  };

  function el(id) {
    return state.doc ? state.doc.getElementById(id) : null;
  }

  function setHidden(node, hidden) {
    if (node) node.hidden = Boolean(hidden);
  }

  function applyRecovery(page, status) {
    state.recovery[page] = status;
    const result = recoveryState(page, status);
    const ids = RECOVERY_IDS[page];
    if (!result || !state.doc) return result;
    const title = el(ids.title);
    if (title && title.textContent !== result.title) title.textContent = result.title;
    setHidden(el(ids.steps), !result.showNextSteps);
    return result;
  }

  function renderCapabilities() {
    if (!state.doc) return;
    const open = state.capabilities.inviteRequests === true;
    setHidden(el('landingRequestInvite'), !open);
    setHidden(el('requestInviteClosed'), open);
    setHidden(el('requestInviteForm'), !open || state.submitted);
    setHidden(el('requestInviteDone'), !open || !state.submitted);
    for (const link of state.doc.querySelectorAll?.('[data-invite-request-link]') || []) setHidden(link, !open);
  }

  function setCapabilities({ loaded = true, failed = false, inviteRequests = false } = {}) {
    state.capabilities = { loaded: Boolean(loaded), failed: Boolean(failed), inviteRequests: inviteRequests === true };
    renderCapabilities();
    revealRequestedSection();
  }

  function prefersReducedMotion() {
    try { return Boolean(root.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches); } catch { return false; }
  }

  function scrollToRequest({ focusField = true } = {}) {
    const section = el('request-invite');
    if (!section) return false;
    section.scrollIntoView?.({ behavior: prefersReducedMotion() ? 'auto' : 'smooth', block: 'start' });
    const target = state.capabilities.inviteRequests && !state.submitted && focusField
      ? el('requestInviteName')
      : section;
    target?.focus?.({ preventScroll: true });
    return true;
  }

  function landingVisible() {
    const landing = el('view-landing');
    return Boolean(landing && landing.style?.display !== 'none');
  }

  function revealRequestedSection() {
    if (state.revealed || !state.capabilities.loaded) return false;
    if (root.location?.hash !== '#request-invite' || !landingVisible()) return false;
    state.revealed = true;
    return scrollToRequest({ focusField: false });
  }

  // "I have an invitation": opens signup when this tab holds a prepared
  // invitation (or local open signup), otherwise toggles inline guidance.
  function syncInviteHelp() {
    const button = el('landingSignup');
    const help = el('landingInviteHelp');
    if (!button) return;
    if (button.dataset?.action === 'signup') {
      setHidden(help, true);
      button.removeAttribute('aria-expanded');
      button.removeAttribute('aria-controls');
      return;
    }
    button.setAttribute('aria-controls', 'landingInviteHelp');
    button.setAttribute('aria-expanded', help && !help.hidden ? 'true' : 'false');
  }

  function toggleInviteHelp(force) {
    const button = el('landingSignup');
    const help = el('landingInviteHelp');
    if (!button || !help) return false;
    const open = typeof force === 'boolean' ? force : help.hidden;
    help.hidden = !open;
    button.setAttribute('aria-expanded', open ? 'true' : 'false');
    return open;
  }

  function onInviteButton() {
    const button = el('landingSignup');
    if (!button || button.disabled) return;
    if (button.dataset?.action === 'signup') {
      root._randori_auth?.openModal?.('signup');
      return;
    }
    toggleInviteHelp();
  }

  function fieldIds(key) {
    const base = { name: 'requestInviteName', email: 'requestInviteEmail', note: 'requestInviteNote' }[key];
    return { input: base, error: `${base}Error` };
  }

  function setFieldError(key, message) {
    const ids = fieldIds(key);
    const input = el(ids.input);
    const error = el(ids.error);
    if (error) {
      error.textContent = message || '';
      error.hidden = !message;
    }
    if (input) {
      if (message) input.setAttribute('aria-invalid', 'true');
      else input.removeAttribute('aria-invalid');
    }
  }

  function setFormError(message) {
    const banner = el('requestInviteFormError');
    if (!banner) return;
    banner.textContent = message || '';
    banner.hidden = !message;
  }

  function clearErrors() {
    for (const key of ['name', 'email', 'note']) setFieldError(key, '');
    setFormError('');
  }

  function showErrors(fields, formMessage) {
    let first = null;
    for (const key of ['name', 'email', 'note']) {
      setFieldError(key, fields[key] || '');
      if (fields[key] && !first) first = key;
    }
    setFormError(formMessage || '');
    if (first) el(fieldIds(first).input)?.focus?.();
    else el('requestInviteFormError')?.focus?.();
  }

  function setPending(pending) {
    state.pending = pending;
    const submit = el('requestInviteSubmit');
    const form = el('requestInviteForm');
    if (submit) {
      submit.disabled = pending;
      if (pending) submit.setAttribute('aria-busy', 'true');
      else submit.removeAttribute('aria-busy');
      submit.textContent = pending ? 'Sending…' : 'Request an invite';
    }
    if (form) form.setAttribute('aria-busy', pending ? 'true' : 'false');
  }

  function updateCounter() {
    const counter = el('requestInviteNoteCount');
    const note = el('requestInviteNote');
    if (counter && note) counter.textContent = noteCounter(note.value).text;
  }

  async function onSubmit(event, { fetchImpl } = {}) {
    event?.preventDefault?.();
    if (state.pending || state.submitted || !state.capabilities.inviteRequests) return null;
    const result = validateInviteRequest({
      name: el('requestInviteName')?.value,
      email: el('requestInviteEmail')?.value,
      note: el('requestInviteNote')?.value,
      website: el('requestInviteWebsite')?.value,
    });
    if (!result.ok) {
      showErrors(result.errors, MESSAGES.invalidForm);
      return { state: 'invalid', fields: result.errors };
    }
    clearErrors();
    setPending(true);
    const outcome = await submitInviteRequest(result.payload, { fetchImpl: fetchImpl || state.fetchImpl });
    setPending(false);
    if (outcome.state === 'success') {
      state.submitted = true;
      const done = el('requestInviteDone');
      if (done) done.textContent = outcome.message;
      renderCapabilities();
      done?.focus?.();
    } else if (outcome.state === 'invalid') {
      showErrors(outcome.fields, outcome.fields.form || (outcome.fields.name || outcome.fields.email || outcome.fields.note
        ? MESSAGES.invalidForm : outcome.message));
    } else {
      showErrors({}, outcome.message);
    }
    return outcome;
  }

  function mount(doc, { fetchImpl } = {}) {
    state.doc = doc;
    state.fetchImpl = typeof fetchImpl === 'function' ? fetchImpl : null;
    const on = (id, type, handler) => el(id)?.addEventListener?.(type, handler);
    on('landingSignup', 'click', onInviteButton);
    on('landingInviteHelp', 'keydown', event => {
      if (event.key === 'Escape') { toggleInviteHelp(false); el('landingSignup')?.focus?.(); }
    });
    on('landingSignup', 'keydown', event => {
      if (event.key === 'Escape' && !el('landingInviteHelp')?.hidden) toggleInviteHelp(false);
    });
    on('landingRequestInvite', 'click', event => {
      event.preventDefault?.();
      try { root.history?.replaceState?.(root.history.state, '', '#request-invite'); } catch {}
      scrollToRequest();
    });
    const signIn = () => root._randori_auth?.openModal?.('signin');
    for (const id of ['requestInviteSignin', 'inviteSignin', 'activationSignin']) on(id, 'click', signIn);
    on('landingThemeToggle', 'click', () => el('themeToggle')?.click?.());
    on('requestInviteNote', 'input', updateCounter);
    on('requestInviteForm', 'submit', event => { void onSubmit(event); });
    for (const key of ['name', 'email', 'note']) {
      on(fieldIds(key).input, 'input', () => { if (el(fieldIds(key).input)?.getAttribute?.('aria-invalid')) setFieldError(key, ''); });
    }
    updateCounter();
    syncInviteHelp();
    renderCapabilities();
    for (const [page, status] of Object.entries(state.recovery)) applyRecovery(page, status);
    watchForRequestedSection();
  }

  // /#request-invite (from recovery pages) scrolls once the router has shown
  // the landing and capabilities have decided between the form and the note.
  function watchForRequestedSection() {
    const landing = el('view-landing');
    if (root.location?.hash !== '#request-invite' || !landing || typeof root.MutationObserver !== 'function') return;
    const observer = new root.MutationObserver(() => {
      if (state.revealed) observer.disconnect();
      else if (revealRequestedSection()) observer.disconnect();
    });
    observer.observe(landing, { attributes: true, attributeFilter: ['style'] });
  }

  const api = Object.freeze({
    MESSAGES,
    NAME_MIN,
    NAME_MAX,
    EMAIL_MAX,
    NOTE_MAX,
    ENDPOINT,
    validateInviteRequest,
    noteCounter,
    interpretInviteRequestResponse,
    submitInviteRequest,
    recoveryState,
    applyRecovery,
    setCapabilities,
    syncInviteHelp,
    toggleInviteHelp,
    scrollToRequest,
    revealRequestedSection,
    submit: onSubmit,
    mount,
    get capabilities() { return { ...state.capabilities }; },
    get submitted() { return state.submitted; },
    _reset() {
      state.doc = null;
      state.fetchImpl = null;
      state.capabilities = { loaded: false, failed: false, inviteRequests: false };
      state.pending = false;
      state.submitted = false;
      state.revealed = false;
      state.recovery = {};
    },
  });

  Object.defineProperty(root, '_randori_landing', { configurable: true, value: api });

  const doc = root.document;
  if (doc && typeof doc.getElementById === 'function') {
    if (doc.readyState === 'loading') doc.addEventListener('DOMContentLoaded', () => mount(doc), { once: true });
    else mount(doc);
  }
})(typeof window !== 'undefined' ? window : globalThis);
