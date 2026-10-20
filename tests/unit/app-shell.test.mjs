import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  ICON_SPRITE,
  TOAST_DURATION_MS,
  MEMBER_DEEP_LINK_VIEWS,
  PUBLIC_VIEW_IDS,
  SOLO_VIEW_ID,
  createToastController,
  deepLinkSignInCopy,
  hidesAppNavigation,
  installShell,
  isHomeActive,
  memberDeepLinkView,
  navigationState,
  normalizeTheme,
  renderConnectionBanner,
  renderThemeControl,
  syncHomeTab,
  syncPublicSurface,
  themeControlState,
} from '../../assets/app-shell.js';

class FakeClassList {
  constructor(owner, initial = []) { this.owner = owner; this.set = new Set(initial); }
  contains(name) { return this.set.has(name); }
  add(name) { if (!this.set.has(name)) { this.set.add(name); this.owner.mutations += 1; } }
  remove(name) { if (this.set.has(name)) { this.set.delete(name); this.owner.mutations += 1; } }
  toggle(name, force) {
    const next = force === undefined ? !this.set.has(name) : !!force;
    if (next) this.add(name); else this.remove(name);
    return next;
  }
}

class FakeElement {
  constructor({ id = '', classes = [], display, hidden = false, dataset = {} } = {}) {
    this.id = id;
    this.mutations = 0;
    this.classList = new FakeClassList(this, classes);
    this.style = { display };
    this.hidden = hidden;
    this.dataset = dataset;
    this.attributes = new Map();
    this.listeners = new Map();
    this.children = [];
    this.textContent = '';
  }
  setAttribute(name, value) { this.attributes.set(name, String(value)); }
  getAttribute(name) { return this.attributes.has(name) ? this.attributes.get(name) : null; }
  removeAttribute(name) { this.attributes.delete(name); }
  addEventListener(type, listener) {
    if (!this.listeners.has(type)) this.listeners.set(type, []);
    this.listeners.get(type).push(listener);
  }
  dispatch(type) { for (const listener of this.listeners.get(type) || []) listener({ type }); }
  querySelector(selector) { return this.children.find(child => child.tag === selector) || null; }
}

function fakeTimers() {
  let clock = 0;
  let nextId = 1;
  const pending = new Map();
  return {
    now: () => clock,
    setTimer(callback, delay) { const id = nextId++; pending.set(id, { callback, at: clock + delay }); return id; },
    clearTimer(id) { pending.delete(id); },
    advance(ms) {
      clock += ms;
      for (const [id, timer] of [...pending]) {
        if (timer.at <= clock) { pending.delete(id); timer.callback(); }
      }
    },
    get size() { return pending.size; },
  };
}

function fakeShellDocument({ dashboard = 'none', landing = 'none', profile = 'none', activeTab = null } = {}) {
  const views = {
    'view-dashboard': new FakeElement({ id: 'view-dashboard', display: dashboard }),
    'view-landing': new FakeElement({ id: 'view-landing', display: landing }),
    'view-profile-setup': new FakeElement({ id: 'view-profile-setup', display: profile }),
  };
  const home = new FakeElement({ id: 'tab-home', classes: ['tab'] });
  const tabs = ['circle', 'pair', 'code', 'board', 'history'].map(name => {
    const tab = new FakeElement({ id: `tab-${name}`, classes: name === activeTab ? ['tab', 'active'] : ['tab'] });
    tab.setAttribute('data-tab', name);
    return tab;
  });
  const use = new FakeElement();
  use.tag = 'use';
  const themeToggle = new FakeElement({ id: 'themeToggle' });
  themeToggle.children.push(use);
  const toast = new FakeElement({ id: 'toast', classes: ['toast'] });
  const banner = new FakeElement({ id: 'shellConnectionBanner', hidden: true });
  const documentElement = new FakeElement({ classes: [] });
  const byId = { ...views, 'tab-home': home, themeToggle, toast, shellConnectionBanner: banner };
  return {
    views, home, tabs, themeToggle, use, toast, banner, documentElement,
    getElementById: id => byId[id] || views[id] || null,
    querySelectorAll(selector) {
      if (selector === '.tabs .tab[data-tab]') return tabs;
      if (selector === '.tabs .tab') return [home, ...tabs];
      return [];
    },
  };
}

test('theme helpers normalise unknown values to dark and preview the next theme', () => {
  assert.equal(normalizeTheme('light'), 'light');
  assert.equal(normalizeTheme('dark'), 'dark');
  assert.equal(normalizeTheme('sepia'), 'dark');
  assert.equal(normalizeTheme(undefined), 'dark');
  assert.deepEqual(themeControlState('dark'), { theme: 'dark', next: 'light', label: 'Switch to light theme', icon: 'i-sun' });
  assert.deepEqual(themeControlState('light'), { theme: 'light', next: 'dark', label: 'Switch to dark theme', icon: 'i-moon' });
});

test('renderThemeControl labels the toggle and swaps the sprite icon', () => {
  assert.equal(renderThemeControl(null, 'dark'), null);
  const doc = fakeShellDocument();
  const state = renderThemeControl(doc.themeToggle, 'light');
  assert.equal(state.next, 'dark');
  assert.equal(doc.themeToggle.getAttribute('aria-label'), 'Switch to dark theme');
  assert.equal(doc.themeToggle.getAttribute('title'), 'Switch to dark theme');
  assert.equal(doc.use.getAttribute('href'), `${ICON_SPRITE}#i-moon`);
  const iconless = new FakeElement();
  assert.equal(renderThemeControl(iconless, 'dark').icon, 'i-sun');
  assert.equal(iconless.getAttribute('aria-label'), 'Switch to light theme');
});

test('Home is current only when a home surface is visible and no data-tab view is active', () => {
  assert.equal(isHomeActive({ homeVisible: true, otherTabActive: false }), true);
  assert.equal(isHomeActive({ homeVisible: true, otherTabActive: true }), false);
  assert.equal(isHomeActive({ homeVisible: false, otherTabActive: false }), false);

  for (const surface of ['dashboard', 'landing', 'profile']) {
    const doc = fakeShellDocument({ [surface]: 'block' });
    assert.equal(syncHomeTab(doc), true, `${surface} makes Home current`);
    assert.ok(doc.home.classList.contains('active'));
    assert.equal(doc.home.getAttribute('aria-current'), 'page');
  }

  const onPairing = fakeShellDocument({ dashboard: 'block', activeTab: 'pair' });
  onPairing.home.classList.add('active');
  onPairing.home.setAttribute('aria-current', 'page');
  assert.equal(syncHomeTab(onPairing), false);
  assert.ok(!onPairing.home.classList.contains('active'));
  assert.equal(onPairing.home.getAttribute('aria-current'), null);

  const hiddenAttribute = fakeShellDocument({ dashboard: 'block' });
  hiddenAttribute.views['view-dashboard'].hidden = true;
  assert.equal(syncHomeTab(hiddenAttribute), false);

  assert.equal(syncHomeTab(null), false);
  assert.equal(syncHomeTab({ getElementById: () => null }), false);
});

test('syncHomeTab does not mutate an unchanged state, so observers cannot loop', () => {
  const doc = fakeShellDocument({ dashboard: 'block' });
  syncHomeTab(doc);
  const after = doc.home.mutations;
  syncHomeTab(doc);
  syncHomeTab(doc);
  assert.equal(doc.home.mutations, after);
});

test('toast shows one message at a time and auto-dismisses after five seconds', () => {
  const timers = fakeTimers();
  const element = new FakeElement({ classes: ['toast'] });
  const toast = createToastController(element, timers);
  assert.equal(TOAST_DURATION_MS, 5000);
  assert.equal(toast.visible, false);
  assert.equal(toast.show('Saved'), true);
  assert.equal(element.textContent, 'Saved');
  assert.equal(toast.visible, true);
  assert.equal(toast.pending, true);
  timers.advance(3000);
  toast.show('Replaced');
  assert.equal(element.textContent, 'Replaced');
  assert.equal(timers.size, 1, 'replacing a toast keeps a single timer');
  timers.advance(4999);
  assert.equal(toast.visible, true, 'the replacement restarts the full duration');
  timers.advance(1);
  assert.equal(toast.visible, false);
  assert.equal(toast.pending, false);
  toast.show(null);
  assert.equal(element.textContent, '');
});

test('hover and focus pause the toast and leaving resumes the remaining time', () => {
  const timers = fakeTimers();
  const element = new FakeElement({ classes: ['toast'] });
  const toast = createToastController(element, timers);
  toast.show('Paused while hovered');
  timers.advance(2000);
  element.dispatch('pointerenter');
  assert.equal(toast.pending, false);
  timers.advance(60_000);
  assert.equal(toast.visible, true);
  element.dispatch('focusin');
  element.dispatch('pointerleave');
  assert.equal(toast.pending, false, 'focus still holds the toast open');
  element.dispatch('focusout');
  assert.equal(toast.pending, true);
  timers.advance(2999);
  assert.equal(toast.visible, true);
  timers.advance(1);
  assert.equal(toast.visible, false);

  element.dispatch('pointerenter');
  toast.show('Arrives while hovered');
  assert.equal(toast.pending, false, 'a toast that arrives under the pointer waits');
  element.dispatch('pointerleave');
  timers.advance(TOAST_DURATION_MS);
  assert.equal(toast.visible, false);

  toast.resume();
  assert.equal(toast.pending, false, 'resume does nothing once dismissed');
  toast.pause();
  assert.equal(toast.pending, false, 'pause without a timer is a no-op');
});

test('a toast whose time ran out while paused gets a fresh duration on resume', () => {
  const timers = fakeTimers();
  let clock = 0;
  const scheduled = [];
  const element = new FakeElement({ classes: ['toast'] });
  const toast = createToastController(element, {
    now: () => clock,
    setTimer: (callback, delay) => { scheduled.push(delay); return timers.setTimer(callback, delay); },
    clearTimer: timers.clearTimer,
  });
  toast.show('Edge');
  clock = TOAST_DURATION_MS + 10; // the timer callback has not run yet
  toast.pause();
  toast.resume();
  assert.equal(toast.pending, true);
  assert.deepEqual(scheduled, [TOAST_DURATION_MS, TOAST_DURATION_MS]);
});

test('clicking a toast dismisses it and a missing element is safe', () => {
  const timers = fakeTimers();
  const element = new FakeElement({ classes: ['toast'] });
  const toast = createToastController(element, timers);
  toast.show('Click me');
  element.dispatch('click');
  assert.equal(toast.visible, false);
  assert.equal(timers.size, 0);

  const missing = createToastController(null, timers);
  assert.equal(missing.show('nothing'), false);
  assert.equal(missing.visible, false);
  missing.dismiss();

  const defaults = createToastController(new FakeElement({ classes: ['toast'] }));
  assert.equal(defaults.show('real timers'), true);
  defaults.dismiss();
});

test('the connection banner is shown only while offline', () => {
  assert.equal(renderConnectionBanner(null, false), false);
  const banner = new FakeElement({ hidden: true });
  assert.equal(renderConnectionBanner(banner, false), true);
  assert.equal(banner.hidden, false);
  assert.equal(renderConnectionBanner(banner, true), false);
  assert.equal(banner.hidden, true);
});

test('installShell wires toast, theme, Home state, and connectivity without routing', () => {
  const doc = fakeShellDocument({ dashboard: 'block' });
  const windowListeners = new Map();
  const win = {
    navigator: { onLine: false },
    addEventListener(type, listener) { windowListeners.set(type, listener); },
  };
  const observers = [];
  class FakeObserver {
    constructor(callback) { this.callback = callback; this.targets = []; observers.push(this); }
    observe(target, options) { this.targets.push({ target, options }); }
  }

  const shell = installShell({ document: doc, window: win, MutationObserverImpl: FakeObserver });
  assert.equal(win._randori_shell, shell);
  assert.ok(Object.isFrozen(shell));
  assert.ok(doc.home.classList.contains('active'), 'Home starts current on the dashboard');
  assert.equal(doc.themeToggle.getAttribute('aria-label'), 'Switch to light theme');
  assert.equal(doc.banner.hidden, false, 'offline at startup shows the banner');

  win.navigator.onLine = true;
  windowListeners.get('online')();
  assert.equal(doc.banner.hidden, true);
  win.navigator.onLine = false;
  windowListeners.get('offline')();
  assert.equal(doc.banner.hidden, false);

  const [navObserver, themeObserver] = observers;
  assert.equal(navObserver.targets.length, 3 + 6, 'three home surfaces and six tabs are observed');
  doc.tabs[1].classList.add('active');
  navObserver.callback();
  assert.ok(!doc.home.classList.contains('active'));
  assert.equal(shell.syncHome(), false);

  doc.documentElement.classList.add('light');
  themeObserver.callback();
  assert.equal(doc.themeToggle.getAttribute('aria-label'), 'Switch to dark theme');
  assert.equal(shell.renderTheme('dark').next, 'light');
  assert.equal(shell.renderTheme().next, 'dark');

  assert.equal(shell.toast('Hello'), true);
  assert.equal(doc.toast.textContent, 'Hello');
  shell.dismissToast();
  assert.ok(!doc.toast.classList.contains('show'));
});

test('only members get app navigation, on every surface and while identity loads', () => {
  assert.deepEqual([...PUBLIC_VIEW_IDS], ['view-landing', 'view-activation', 'view-password-reset', 'view-invite']);
  assert.equal(SOLO_VIEW_ID, 'view-code');
  assert.equal(hidesAppNavigation({ auth: 'anonymous' }), true);
  assert.equal(hidesAppNavigation({ auth: undefined }), true, 'before the first auth render');
  assert.equal(hidesAppNavigation(), true);
  assert.equal(hidesAppNavigation({ auth: 'member' }), false);
  // A returning member keeps navigation only while identity is pending.
  assert.equal(hidesAppNavigation({ auth: 'anonymous', identity: 'pending', returning: 'true' }), false);
  assert.equal(hidesAppNavigation({ auth: 'anonymous', identity: 'resolved', returning: 'true' }), true);
  assert.equal(hidesAppNavigation({ auth: 'anonymous', identity: 'pending', returning: 'false' }), true, 'a visitor while loading');
  assert.equal(hidesAppNavigation({ identity: 'pending' }), true);
  assert.deepEqual(navigationState({ auth: 'anonymous', identity: 'pending', returning: 'true', soloSurface: true }), { nav: 'shown', surface: 'app' });

  assert.deepEqual(navigationState({ auth: 'anonymous', publicSurface: true }), { nav: 'hidden', surface: 'public' });
  assert.deepEqual(navigationState({ auth: 'anonymous', soloSurface: true }), { nav: 'hidden', surface: 'solo' });
  assert.deepEqual(navigationState({ auth: 'anonymous' }), { nav: 'hidden', surface: 'app' }, 'deep link or unknown route');
  assert.deepEqual(navigationState({ auth: 'member', soloSurface: true }), { nav: 'shown', surface: 'app' }, 'a member in the room is not solo');
  assert.deepEqual(navigationState({ auth: 'member', publicSurface: true }), { nav: 'shown', surface: 'public' });
  assert.deepEqual(navigationState(), { nav: 'hidden', surface: 'app' });
});

test('member deep links are recognised from view or tab and get sign-in copy', () => {
  assert.deepEqual(Object.keys(MEMBER_DEEP_LINK_VIEWS), ['pair', 'board', 'history', 'circle']);
  assert.equal(memberDeepLinkView('?view=pair'), 'pair');
  assert.equal(memberDeepLinkView('?tab=history'), 'history');
  assert.equal(memberDeepLinkView('view=circle'), 'circle');
  assert.equal(memberDeepLinkView('?view=board&x=1'), 'board');
  assert.equal(memberDeepLinkView('?view=code'), '', 'solo practice is not member-only');
  assert.equal(memberDeepLinkView('?view=toString'), '', 'no prototype keys');
  assert.equal(memberDeepLinkView(''), '');
  assert.equal(memberDeepLinkView(undefined), '');
  assert.deepEqual(deepLinkSignInCopy('pair'), {
    title: 'Sign in to continue',
    description: "Sign in to open Pairing. You'll go straight there.",
  });
  assert.match(deepLinkSignInCopy('circle').description, /your circle/);
  assert.equal(deepLinkSignInCopy('code'), null);
  assert.equal(deepLinkSignInCopy('__proto__'), null);
  assert.equal(deepLinkSignInCopy(undefined), null);
});

test('syncPublicSurface marks the body from the visible view and auth state', () => {
  const doc = fakeShellDocument({ landing: 'block' });
  doc.views['view-code'] = new FakeElement({ id: 'view-code', display: 'none' });
  doc.body = new FakeElement({ dataset: { auth: 'anonymous', identity: 'resolved' } });
  assert.equal(syncPublicSurface(doc), true);
  assert.equal(doc.body.dataset.surface, 'public');
  assert.equal(doc.body.dataset.nav, 'hidden');

  doc.body.dataset.auth = 'member';
  assert.equal(syncPublicSurface(doc), false);
  assert.equal(doc.body.dataset.nav, 'shown');

  // Signing out hides the tabs at once, whatever view is showing.
  doc.body.dataset.auth = 'anonymous';
  doc.views['view-landing'].style.display = 'none';
  doc.views['view-dashboard'].style.display = 'block';
  assert.equal(syncPublicSurface(doc), true);
  assert.equal(doc.body.dataset.surface, 'app');
  assert.equal(doc.body.dataset.nav, 'hidden');

  doc.views['view-dashboard'].style.display = 'none';
  doc.views['view-code'].style.display = 'block';
  assert.equal(syncPublicSurface(doc), true);
  assert.equal(doc.body.dataset.surface, 'solo');

  doc.body.dataset.auth = 'member';
  assert.equal(syncPublicSurface(doc), false);
  assert.equal(doc.body.dataset.surface, 'app');
  assert.equal(syncPublicSurface({}), false);
  assert.equal(syncPublicSurface(null), false);
});

test('installShell observes body auth attributes so navigation follows sign-in', () => {
  const doc = fakeShellDocument({ landing: 'block' });
  doc.body = new FakeElement({ dataset: { auth: 'anonymous', identity: 'pending' } });
  const observers = [];
  class FakeObserver {
    constructor(callback) { this.callback = callback; this.targets = []; observers.push(this); }
    observe(target, options) { this.targets.push({ target, options }); }
  }
  const shell = installShell({ document: doc, window: { navigator: {}, addEventListener() {} }, MutationObserverImpl: FakeObserver });
  assert.equal(doc.body.dataset.nav, 'hidden', 'no member tabs while identity loads');
  assert.equal(shell.memberDeepLinkView('?view=pair'), 'pair');
  assert.equal(shell.deepLinkSignInCopy('history').title, 'Sign in to continue');
  const [navObserver] = observers;
  const bodyTarget = navObserver.targets.find(entry => entry.target === doc.body);
  assert.deepEqual(bodyTarget.options.attributeFilter, ['data-auth', 'data-identity', 'data-returning']);
  doc.body.dataset.returning = 'true';
  navObserver.callback();
  assert.equal(doc.body.dataset.nav, 'shown', 'returning member while identity loads');
  doc.body.dataset.identity = 'resolved';
  doc.body.dataset.returning = 'false';
  navObserver.callback();
  assert.equal(doc.body.dataset.nav, 'hidden', 'the check said signed out');
  doc.body.dataset.auth = 'member';
  navObserver.callback();
  assert.equal(doc.body.dataset.nav, 'shown');
  doc.body.dataset.auth = 'anonymous';
  navObserver.callback();
  assert.equal(doc.body.dataset.nav, 'hidden', 'sign-out hides the tabs immediately');
});

test('installShell tolerates missing globals, observers, and optional elements', () => {
  assert.equal(installShell({ document: null, window: null }), null);
  const doc = fakeShellDocument();
  doc.getElementById = id => (id === 'toast' ? null : null);
  const win = { navigator: {} };
  const shell = installShell({ document: doc, window: win, MutationObserverImpl: undefined });
  assert.equal(shell.toast('no element'), false);
  assert.equal(shell.renderTheme(), null);
});

test('index.html loads the shell module and keeps nav hooks stable', async () => {
  const html = await readFile(new URL('../../index.html', import.meta.url), 'utf8');
  assert.match(html, /<script type="module" src="\/assets\/app-shell\.js"><\/script>/);
  assert.match(html, /<div id="toast" class="toast" role="status" aria-live="polite" aria-atomic="true">/);
  assert.match(html, /<button id="tab-home" class="tab" type="button" data-nav="home">/);
  assert.match(html, /id="shellConnectionBanner"[^>]+role="status" hidden/);
  assert.match(html, /document\.querySelectorAll\('\.tab\[data-tab\]'\)\.forEach\(t=>\{\s*t\.onclick=/);
  assert.match(html, /getElementById\('tab-home'\)\?\.addEventListener\('click'/);
  // Every destination stays a direct, visible button: no "More" overflow hides
  // content on phones, and the tabs stay in DOM order for keyboard users.
  const nav = html.match(/<div class="tabs" role="group" aria-label="Application views">([\s\S]*?)<\/div>\s*<\/nav>/)?.[1] || '';
  assert.deepEqual([...nav.matchAll(/id="(tab-[a-z]+)"/g)].map(match => match[1]),
    ['tab-home', 'tab-circle', 'tab-pair', 'tab-code', 'tab-board', 'tab-history']);
  assert.match(html, /@media\(max-width:599px\)\{[\s\S]*?\.tabs\{\s*position:fixed; left:0; right:0; bottom:0;/);
  assert.match(html, /body\[data-auth="member"\] \.shell\{display:grid; grid-template-columns:var\(--sidebar-w\)/);
  // The navigation is hidden by default (before any script runs) and only a
  // confirmed member shows it, so visitors never see a flash of member tabs.
  assert.match(html, /body:not\(\[data-nav="shown"\]\) \.shell > nav\{display:none!important\}/);
  assert.doesNotMatch(html, /<body[^>]*data-nav=/);
  assert.match(html, /<div id="soloPracticeBar" class="rc-banner solo-bar" data-testid="solo-practice-bar">/);
  assert.match(html, /<section id="view-boot" class="view boot-view" aria-busy="true" style="display:none">/);
});
