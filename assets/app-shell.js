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

// App navigation (the tabs and the phone bottom bar) is for members only.
// Every member destination needs an account, so a visitor would only be
// bounced to sign-in by it. Visitors keep the logo, theme toggle and Sign in.
// The navigation is hidden by default and shows for a confirmed member
// (`data-auth="member"`, set only after /api/auth/me answers with a user), or
// for a returning member while that check is in flight. A visitor therefore
// never sees member tabs, even before scripts run, and the tabs go away as
// soon as the member signs out.
//
// The body gets three attributes:
//   data-nav:        "shown" for members, "hidden" for everyone else.
//   data-surface:    "public" on the landing and recovery pages; "solo" when a
//                    visitor opens the code view (/?view=code), which shows a
//                    sign-in / request-an-invite prompt; "app" otherwise.
//   data-onboarding: "flow" while the setup stepper (#view-profile-setup in
//                    its onboarding or guide mode) is showing, "none" otherwise.
//                    The phone bottom bar hides for the stepper; Edit profile
//                    (data-mode="edit") keeps it.
export const PUBLIC_VIEW_IDS = Object.freeze(['view-landing', 'view-activation', 'view-password-reset', 'view-invite']);
export const SOLO_VIEW_ID = 'view-code';
export const SETUP_VIEW_ID = 'view-profile-setup';

export function onboardingFlowState({ setupVisible = false, setupMode = '' } = {}) {
  return setupVisible && setupMode !== 'edit' ? 'flow' : 'none';
}

// A returning member (this browser last saw a signed-in account) keeps the
// navigation while their identity check is in flight, so they can move
// around straight away; a visitor never has that cached account.
export function hidesAppNavigation({ auth, identity, returning } = {}) {
  if (auth === 'member') return false;
  return !(identity === 'pending' && returning === 'true');
}

export function navigationState({ auth, identity, returning, publicSurface = false, soloSurface = false } = {}) {
  const hidden = hidesAppNavigation({ auth, identity, returning });
  const surface = publicSurface ? 'public' : (hidden && soloSurface ? 'solo' : 'app');
  return { nav: hidden ? 'hidden' : 'shown', surface };
}

// Member-only views a visitor can deep-link to (`/?view=pair`, `?tab=history`).
// A signed-out visitor is asked to sign in, and the URL is kept so the router
// opens the same view once they have.
export const MEMBER_DEEP_LINK_VIEWS = Object.freeze({
  pair: 'Pairing',
  board: 'the whiteboard',
  history: 'your history',
  circle: 'your circle',
});

export function memberDeepLinkView(search) {
  let params;
  try { params = new URLSearchParams(String(search ?? '')); } catch { return ''; }
  const view = params.get('view') || params.get('tab') || '';
  return Object.hasOwn(MEMBER_DEEP_LINK_VIEWS, view) ? view : '';
}

export function deepLinkSignInCopy(view) {
  const name = Object.hasOwn(MEMBER_DEEP_LINK_VIEWS, String(view)) ? MEMBER_DEEP_LINK_VIEWS[view] : '';
  if (!name) return null;
  return { title: 'Sign in to continue', description: `Sign in to open ${name}. You'll go straight there.` };
}

export function syncPublicSurface(doc) {
  const body = doc?.body;
  if (!body) return false;
  const state = navigationState({
    auth: body.dataset.auth,
    identity: body.dataset.identity,
    returning: body.dataset.returning,
    publicSurface: PUBLIC_VIEW_IDS.some(id => isDisplayed(doc.getElementById(id))),
    soloSurface: isDisplayed(doc.getElementById(SOLO_VIEW_ID)),
  });
  if (body.dataset.surface !== state.surface) body.dataset.surface = state.surface;
  if (body.dataset.nav !== state.nav) body.dataset.nav = state.nav;
  const setup = doc.getElementById(SETUP_VIEW_ID);
  const onboarding = onboardingFlowState({ setupVisible: isDisplayed(setup), setupMode: setup?.dataset?.mode || '' });
  if (body.dataset.onboarding !== onboarding) body.dataset.onboarding = onboarding;
  return state.nav === 'hidden';
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
    for (const id of ['view-dashboard', SOLO_VIEW_ID, ...PUBLIC_VIEW_IDS]) {
      const view = doc.getElementById(id);
      if (view) navObserver.observe(view, { attributes: true, attributeFilter: ['style', 'hidden'] });
    }
    // The setup view also switches between the stepper and Edit profile.
    const setup = doc.getElementById(SETUP_VIEW_ID);
    if (setup) navObserver.observe(setup, { attributes: true, attributeFilter: ['style', 'hidden', 'data-mode'] });
    for (const tab of doc.querySelectorAll('.tabs .tab')) {
      navObserver.observe(tab, { attributes: true, attributeFilter: ['class'] });
    }
    if (doc.body) navObserver.observe(doc.body, { attributes: true, attributeFilter: ['data-auth', 'data-identity', 'data-returning'] });
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
    memberDeepLinkView,
    deepLinkSignInCopy,
    renderTheme: theme => renderThemeControl(themeButton, theme ?? currentTheme()),
  });
  win._randori_shell = shell;
  return shell;
}

if (typeof window !== 'undefined' && typeof document !== 'undefined') {
  installShell();
}
