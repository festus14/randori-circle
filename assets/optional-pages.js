// Optional page assets (ID-101). No fetch until a named feature is used.
// Every optional module must tolerate late evaluation alongside a retry copy:
// removing a timed-out script does not guarantee that it will never execute.
(function installOptionalPages(root) {
  'use strict';
  if (root._randori_optional_pages) return;
  const doc = root.document;
  const jobs = new Map();
  const attempts = new Map();
  const assets = {
    email: ['/assets/email-validation.js', 'module', () => root.RandoriEmailValidation],
    bulk: ['/assets/bulk-invite.js', 'module', () => root.RandoriBulkInvite],
    calendar: ['/assets/calendar-export.js', 'module', () => root._randori_calendar_export],
    landing: ['/assets/landing.js', '', () => root._randori_landing === bridge ? null : root._randori_landing],
  };
  const recoveryDeadEnds = Object.freeze({
    invite: Object.freeze(['expired', 'failed']),
    activation: Object.freeze(['expired', 'revoked', 'invalid']),
    passwordReset: Object.freeze(['expired', 'revoked', 'invalid']),
  });
  function load(name) {
    const asset = Object.hasOwn(assets, name) ? assets[name] : null;
    if (!asset) return Promise.reject(new Error('Unknown optional asset'));
    if (jobs.has(name)) return jobs.get(name);
    const ready = asset[2]();
    if (ready) return Promise.resolve(ready);
    const attempt = attempts.get(name) || 0;
    const job = new Promise((resolve, reject) => {
      const script = doc.createElement('script');
      script.type = asset[1];
      // Explicit retries get a fresh same-origin URL, never a remote fallback.
      script.src = asset[0] + (attempt ? `?retry=${attempt}` : '');
      let settled = false;
      const finish = (error) => {
        if (settled) return;
        settled = true;
        root.clearTimeout(timer);
        script.onload = script.onerror = null;
        script.remove();
        const api = asset[2]();
        if (error || !api) reject(new Error('Optional asset unavailable'));
        else resolve(api);
      };
      const timer = root.setTimeout(() => finish(true), 15000);
      script.onload = () => finish(false);
      script.onerror = () => finish(true);
      doc.head.appendChild(script);
    }).catch(error => {
      jobs.delete(name);
      attempts.set(name, attempt + 1);
      throw error;
    });
    jobs.set(name, job);
    return job;
  }
  root._randori_optional_pages = Object.freeze({ load, recoveryDeadEnds });
  let capabilities = { loaded: false, failed: false, inviteRequests: false };
  const recovery = new Map();
  const bridge = {
    setCapabilities(value) { capabilities = value; },
    syncInviteHelp() {},
    hydrate(api) {
      api.setCapabilities(capabilities);
      for (const [page, status] of recovery) api.applyRecovery(page, status);
      recovery.clear();
    },
    applyRecovery(page, status) {
      recovery.set(page, status);
      const showNextSteps = Object.hasOwn(recoveryDeadEnds, page) && recoveryDeadEnds[page].includes(status);
      const ids = { invite: 'inviteNextSteps', activation: 'activationNextSteps', passwordReset: 'passwordResetNextSteps' };
      const steps = doc?.getElementById(ids[page]);
      if (steps) steps.hidden = !showNextSteps;
      return { showNextSteps };
    },
  };
  Object.defineProperty(root, '_randori_landing', { configurable: true, value: bridge });
  let landingJob = null;
  function loadLanding() {
    if (!landingJob) landingJob = load('email').then(() => load('landing'))
      .catch(error => { landingJob = null; throw error; });
    return landingJob;
  }
  function watchPublicViews() {
    const observers = new Set();
    for (const id of ['landing', 'invite', 'activation', 'password-reset']) {
      const view = doc.getElementById(`view-${id}`);
      const content = view?.querySelector('.landing');
      if (!content) continue;
      // Core invitation, activation, password reset and sign-in controls are
      // synchronous shell features. Only landing.js-owned widgets wait here.
      const controls = [...view.querySelectorAll('#requestInviteForm, #landingSignup, #landingRequestInvite, #landingThemeToggle, a[href="#landingPrivacy"]')];
      const notice = doc.createElement('div');
      notice.className = 'rc-banner';
      notice.dataset.testid = 'optional-page-status';
      notice.hidden = true;
      const status = doc.createElement('span');
      status.setAttribute('role', 'status');
      status.setAttribute('aria-live', 'polite');
      status.tabIndex = -1;
      const retry = doc.createElement('button');
      retry.type = 'button';
      retry.className = 'btn secondary sm';
      retry.textContent = 'Retry page';
      retry.hidden = true;
      notice.append(status, retry);
      view.prepend(notice);
      let pending = false;
      let done = false;
      function focusOwned(hadFocus, target) {
        if (hadFocus && view.style.display !== 'none'
          && [status, retry, doc.body].includes(doc.activeElement)) target?.focus();
      }
      function show() {
        if (view.style.display === 'none' || pending || done) return;
        const hadFocus = doc.activeElement === retry;
        pending = true;
        notice.hidden = false;
        status.textContent = 'Loading page controls…';
        // Park retry-owned focus on the live pending message before hiding.
        if (hadFocus) status.focus();
        retry.hidden = true;
        for (const control of controls) { control.inert = true; control.setAttribute('aria-busy', 'true'); }
        void loadLanding().then(api => {
          done = true;
          for (const observer of observers) observer.disconnect();
          observers.clear();
          for (const control of controls) { control.inert = false; control.setAttribute('aria-busy', 'false'); }
          api.revealRequestedSection?.();
          const heading = content.querySelector('h1, h2');
          if (heading) heading.tabIndex = -1;
          // Move focus out before hiding its parent notice, not afterwards.
          focusOwned(hadFocus, heading);
          notice.hidden = true;
        }, () => {
          status.textContent = 'Page controls could not load. Check your connection and retry.';
          for (const control of controls) control.setAttribute('aria-busy', 'false');
          retry.hidden = false;
          focusOwned(hadFocus, retry);
        }).finally(() => { pending = false; });
      }
      retry.addEventListener('click', show);
      const observer = new root.MutationObserver(show);
      observers.add(observer);
      observer.observe(view, { attributes: true, attributeFilter: ['style'] });
      show();
    }
  }
  if (!doc) return; // Pure recovery metadata is also used by Node unit tests.
  if (doc.readyState === 'loading') doc.addEventListener('DOMContentLoaded', watchPublicViews, { once: true });
  else watchPublicViews();
})(typeof window !== 'undefined' ? window : globalThis);
