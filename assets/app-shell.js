// App shell presentation layer (WP-S): toast queue, theme control, Home
// navigation state, and the page-level offline banner.
//
// This module never routes, authenticates, or derives product state. The
// existing `data-tab` buttons and the journey router stay authoritative; the
// shell only reflects which view is visible and how the chrome looks.

export const TOAST_DURATION_MS = 5000;
export const ICON_SPRITE = '/assets/brand/icons.svg';

export function normalizeTheme(value) {
  return value === 'light' ? 'light' : 'dark';
}

export function themeControlState(theme) {
  const current = normalizeTheme(theme);
  const next = current === 'light' ? 'dark' : 'light';
  return {
    theme: current,
    next,
    label: `Switch to ${next} theme`,
    // The icon previews the theme the button switches to.
    icon: next === 'light' ? 'i-sun' : 'i-moon',
  };
}

export function renderThemeControl(button, theme) {
  if (!button) return null;
  const state = themeControlState(theme);
  button.setAttribute('aria-label', state.label);
  button.setAttribute('title', state.label);
  const use = button.querySelector?.('use');
  if (use) use.setAttribute('href', `${ICON_SPRITE}#${state.icon}`);
  return state;
}

function isDisplayed(element) {
  return !!element && !element.hidden && element.style?.display !== 'none';
}

// Home is the dashboard for members, the landing page for visitors, and the
// profile step while setup is incomplete. It is current only when one of
// those surfaces is visible and no `data-tab` view has claimed the page.
export function isHomeActive({ homeVisible, otherTabActive }) {
  return !!homeVisible && !otherTabActive;
}

export function syncHomeTab(doc) {
  const home = doc?.getElementById?.('tab-home');
  if (!home) return false;
  const homeVisible = ['view-dashboard', 'view-landing', 'view-profile-setup']
    .some(id => isDisplayed(doc.getElementById(id)));
  const otherTabActive = [...doc.querySelectorAll('.tabs .tab[data-tab]')]
    .some(tab => tab.classList.contains('active'));
  const active = isHomeActive({ homeVisible, otherTabActive });
  // classList.toggle with an unchanged state does not mutate the attribute,
  // so observers that call this function cannot loop.
  home.classList.toggle('active', active);
  if (active) home.setAttribute('aria-current', 'page');
  else home.removeAttribute('aria-current');
  return active;
}

// Landing and the public recovery pages are for visitors: anonymous people
// get no app navigation there (Sign in stays in the topbar). Members, and
// anyone whose identity is still loading, keep the tabs.
export const PUBLIC_VIEW_IDS = Object.freeze(['view-landing', 'view-activation', 'view-password-reset', 'view-invite']);

export function hidesAppNavigation({ auth, identity, publicSurface }) {
  return auth === 'anonymous' && identity === 'resolved' && !!publicSurface;
}

export function syncPublicSurface(doc) {
  const body = doc?.body;
  if (!body) return false;
  const publicSurface = PUBLIC_VIEW_IDS.some(id => isDisplayed(doc.getElementById(id)));
  const surface = publicSurface ? 'public' : 'app';
  if (body.dataset.surface !== surface) body.dataset.surface = surface;
  const hidden = hidesAppNavigation({ auth: body.dataset.auth, identity: body.dataset.identity, publicSurface });
  const nav = hidden ? 'hidden' : 'shown';
  if (body.dataset.nav !== nav) body.dataset.nav = nav;
  return hidden;
}

export function createToastController(element, {
  duration = TOAST_DURATION_MS,
  setTimer = (callback, delay) => setTimeout(callback, delay),
  clearTimer = handle => clearTimeout(handle),
  now = () => Date.now(),
} = {}) {
  let timer = null;
  let remaining = duration;
  let startedAt = 0;
  let hovered = false;
  let focused = false;

  const stop = () => {
    if (timer !== null) clearTimer(timer);
    timer = null;
  };
  const dismiss = () => {
    stop();
    element?.classList.remove('show');
  };
  const start = delay => {
    stop();
    remaining = delay;
    startedAt = now();
    timer = setTimer(dismiss, delay);
  };
  const pause = () => {
    if (timer === null) return;
    remaining = Math.max(0, remaining - (now() - startedAt));
    stop();
  };
  const resume = () => {
    if (hovered || focused || timer !== null || !element?.classList.contains('show')) return;
    start(remaining > 0 ? remaining : duration);
  };

  if (element?.addEventListener) {
    element.addEventListener('pointerenter', () => { hovered = true; pause(); });
    element.addEventListener('pointerleave', () => { hovered = false; resume(); });
    element.addEventListener('focusin', () => { focused = true; pause(); });
    element.addEventListener('focusout', () => { focused = false; resume(); });
    element.addEventListener('click', dismiss);
  }

  return {
    show(message) {
      if (!element) return false;
      // At most one toast: a new message replaces the current one.
      element.classList.add('show');
      element.textContent = String(message ?? '');
      if (hovered || focused) {
        stop();
        remaining = duration;
      } else {
        start(duration);
      }
      return true;
    },
    dismiss,
    pause,
    resume,
    get visible() { return !!element?.classList.contains('show'); },
    get pending() { return timer !== null; },
  };
}

export function renderConnectionBanner(banner, online) {
  if (!banner) return false;
  banner.hidden = !!online;
  return !online;
}

export function installShell({
  document: doc = globalThis.document,
  window: win = globalThis.window,
  MutationObserverImpl = globalThis.MutationObserver,
} = {}) {
  if (!doc || !win) return null;
  const toastController = createToastController(doc.getElementById('toast'));

  const themeButton = doc.getElementById('themeToggle');
  const currentTheme = () => (doc.documentElement.classList.contains('light') ? 'light' : 'dark');
  renderThemeControl(themeButton, currentTheme());

  const sync = () => { syncPublicSurface(doc); return syncHomeTab(doc); };
  if (typeof MutationObserverImpl === 'function') {
    const navObserver = new MutationObserverImpl(sync);
    for (const id of ['view-dashboard', 'view-profile-setup', ...PUBLIC_VIEW_IDS]) {
      const view = doc.getElementById(id);
      if (view) navObserver.observe(view, { attributes: true, attributeFilter: ['style', 'hidden'] });
    }
    for (const tab of doc.querySelectorAll('.tabs .tab')) {
      navObserver.observe(tab, { attributes: true, attributeFilter: ['class'] });
    }
    if (doc.body) navObserver.observe(doc.body, { attributes: true, attributeFilter: ['data-auth', 'data-identity'] });
    const themeObserver = new MutationObserverImpl(() => renderThemeControl(themeButton, currentTheme()));
    themeObserver.observe(doc.documentElement, { attributes: true, attributeFilter: ['class'] });
  }
  sync();

  const banner = doc.getElementById('shellConnectionBanner');
  const updateConnection = () => renderConnectionBanner(banner, win.navigator?.onLine !== false);
  win.addEventListener?.('online', updateConnection);
  win.addEventListener?.('offline', updateConnection);
  updateConnection();

  const shell = Object.freeze({
    toast: message => toastController.show(message),
    dismissToast: () => toastController.dismiss(),
    syncHome: sync,
    renderTheme: theme => renderThemeControl(themeButton, theme ?? currentTheme()),
  });
  win._randori_shell = shell;
  return shell;
}

if (typeof window !== 'undefined' && typeof document !== 'undefined') {
  installShell();
}
