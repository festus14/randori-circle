// Optional page assets (ID-101). No fetch until a named feature is used.
// Classic bridge: invitation consumption and the inline shell stay synchronous.
(function installOptionalPages(root) {
  'use strict';
  const doc = root.document;
  const jobs = new Map();
  const attempts = new Map();
  const assets = {
    email: ['/assets/email-validation.js', 'module', () => root.RandoriEmailValidation],
    bulk: ['/assets/bulk-invite.js', 'module', () => root.RandoriBulkInvite],
    calendar: ['/assets/calendar-export.js', 'module', () => root._randori_calendar_export],
    landing: ['/assets/landing.js', '', () => root._randori_landing === bridge ? null : root._randori_landing],
  };

  function load(name) {
    const asset = assets[name];
    if (!asset) return Promise.reject(new Error('Unknown optional asset'));
    if (jobs.has(name)) return jobs.get(name);
    const ready = asset[2]();
    if (ready) return Promise.resolve(ready);
    const attempt = attempts.get(name) || 0;
    const job = new Promise((resolve, reject) => {
      const script = doc.createElement('script');
      script.type = asset[1];
      // A failed module evaluation is cached by the browser. A user retry gets
      // a fresh same-origin URL, never a remote fallback or an automatic loop.
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
  root._randori_optional_pages = Object.freeze({ load });

  // The auth shell writes capabilities and recovery state before routing.
  // Buffer only the latest values, not DOM operations or invitation secrets.
  // The tiny synchronous predicate preserves the invite CTA/stepper guard;
  // all recovery titles, DOM and interactions still belong to landing.js.
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
      return { showNextSteps: (page === 'invite' ? ['expired', 'failed'] : ['expired', 'revoked', 'invalid']).includes(status) };
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
    for (const id of ['landing', 'invite', 'activation', 'password-reset']) {
      const view = doc.getElementById(`view-${id}`);
      const content = view?.querySelector('.landing');
      if (!content) continue;
      const notice = doc.createElement('div');
      notice.className = 'rc-banner rc-banner--info';
      notice.dataset.testid = 'optional-page-status';
      notice.hidden = true;
      const status = doc.createElement('span');
      status.setAttribute('role', 'status');
      status.setAttribute('aria-live', 'polite');
      const retry = doc.createElement('button');
      retry.type = 'button';
      retry.className = 'btn secondary sm';
      retry.textContent = 'Retry page';
      retry.hidden = true;
      notice.append(status, retry);
      view.prepend(notice);
      let pending = false;
      let done = false;
      function show() {
        if (view.style.display === 'none' || pending || done) return;
        pending = true;
        notice.hidden = false;
        retry.hidden = true;
        content.inert = true;
        content.setAttribute('aria-busy', 'true');
        status.textContent = 'Loading page controls…';
        void loadLanding().then(api => {
          done = true;
          content.inert = false;
          content.setAttribute('aria-busy', 'false');
          notice.hidden = true;
          // Capabilities can settle before mount, while this content is inert.
          // Reveal/focus a request-invite deep link only once controls are live.
          api.revealRequestedSection?.();
          // Retry owned focus; restore it only if this page is still shown.
          if (doc.activeElement === retry && view.style.display !== 'none') content.querySelector('button, input, a')?.focus();
        }, () => {
          status.textContent = 'Page controls could not load. Check your connection and retry.';
          content.setAttribute('aria-busy', 'false');
          retry.hidden = false;
        }).finally(() => { pending = false; });
      }
      retry.addEventListener('click', show);
      new root.MutationObserver(show).observe(view, { attributes: true, attributeFilter: ['style'] });
      show();
    }
  }
  if (doc.readyState === 'loading') doc.addEventListener('DOMContentLoaded', watchPublicViews, { once: true });
  else watchPublicViews();
})(typeof window !== 'undefined' ? window : globalThis);
