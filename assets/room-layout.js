// Pair room presentation layer (WP-R): panel tabs, the editor "more" menu,
// the call strip state, the Board mode switch, and the opt-in AI feedback
// section.
//
// This module never touches the shared document, the run gateway, session
// controls, or pairing state. It only decides which already-rendered panel is
// visible and how the room chrome looks. The existing `data-tab` buttons stay
// authoritative for navigation between views.

export const ROOM_PANELS = Object.freeze(['code', 'problem', 'results', 'session', 'notes']);
// Two columns (editor + side panel) need room for both; below this width the
// room shows one panel at a time with the editor as the default.
export const WIDE_ROOM_QUERY = '(min-width: 1100px)';
export const AI_FEEDBACK_PREFERENCE_KEY = 'randori-ai-feedback';

const PANEL_KEYS = new Set(['ArrowLeft', 'ArrowRight', 'Home', 'End']);

export function normalizePanel(value, fallback = 'code') {
  return ROOM_PANELS.includes(value) ? value : fallback;
}

export function defaultPanel(wide) {
  return wide ? 'problem' : 'code';
}

// On wide screens the editor is always visible, so "code" is not a side-panel
// choice there: keep the request (it comes back on a phone) but show Problem.
export function resolvePanel(requested, wide) {
  const panel = normalizePanel(requested, defaultPanel(wide));
  return wide && panel === 'code' ? 'problem' : panel;
}

export function visiblePanels(wide) {
  return wide ? ROOM_PANELS.filter(panel => panel !== 'code') : [...ROOM_PANELS];
}

// Roving focus for the panel tablist: arrows wrap, Home and End jump.
export function panelForKey(key, current, panels) {
  if (!PANEL_KEYS.has(key) || !panels?.length) return null;
  const index = Math.max(0, panels.indexOf(current));
  if (key === 'Home') return panels[0];
  if (key === 'End') return panels[panels.length - 1];
  const step = key === 'ArrowRight' ? 1 : -1;
  return panels[(index + step + panels.length) % panels.length];
}

export function renderRoomPanels(doc, requested, wide) {
  const panel = resolvePanel(requested, wide);
  for (const tab of doc?.querySelectorAll?.('[data-room-tab]') || []) {
    const name = tab.getAttribute('data-room-tab');
    const selected = name === panel;
    tab.setAttribute('aria-selected', String(selected));
    tab.setAttribute('tabindex', selected ? '0' : '-1');
  }
  for (const element of doc?.querySelectorAll?.('[data-room-panel]') || []) {
    const name = element.getAttribute('data-room-panel');
    // The editor stays mounted (and visible on wide screens) so Monaco, the
    // CRDT binding and the hydration lock never see it detach.
    element.hidden = name === 'code' ? !wide && panel !== 'code' : name !== panel;
  }
  const side = doc?.getElementById?.('roomSide');
  if (side) side.hidden = !wide && panel === 'code';
  const layout = doc?.getElementById?.('roomLayout');
  if (layout) layout.setAttribute('data-panel', panel);
  return panel;
}

export function callState(joined) {
  return joined ? 'on' : 'off';
}

// The live-call strip is collapsed until the member joins; the room bar keeps
// the single Join call action.
export function renderCallState(doc, joined) {
  const state = callState(joined);
  const bar = doc?.getElementById?.('videoBar');
  if (bar) {
    bar.setAttribute('data-call', state);
    bar.hidden = !joined;
  }
  return state;
}

export function aiFeedbackState(enabled) {
  return enabled
    ? {
      enabled: true,
      hint: 'On. Record captures code snapshots in this browser; feedback is requested only when you choose Get feedback.',
    }
    : {
      enabled: false,
      hint: 'Off. Turn it on to record code snapshots and request AI feedback on this session.',
    };
}

export function readAiPreference(storage) {
  try { return storage?.getItem?.(AI_FEEDBACK_PREFERENCE_KEY) === 'on'; } catch { return false; }
}

export function writeAiPreference(storage, enabled) {
  try {
    if (enabled) storage?.setItem?.(AI_FEEDBACK_PREFERENCE_KEY, 'on');
    else storage?.removeItem?.(AI_FEEDBACK_PREFERENCE_KEY);
    return true;
  } catch { return false; }
}

export function renderAiFeedback(doc, enabled) {
  const state = aiFeedbackState(enabled);
  const toggle = doc?.getElementById?.('aiFeedbackToggle');
  if (toggle) toggle.checked = state.enabled;
  const tools = doc?.getElementById?.('aiFeedbackTools');
  if (tools) tools.hidden = !state.enabled;
  const hint = doc?.getElementById?.('aiFeedbackHint');
  if (hint) hint.textContent = state.hint;
  for (const id of ['aiRecordBtn', 'aiAnalyzeBtn', 'aiHistoryBtn']) {
    const button = doc?.getElementById?.(id);
    if (button) button.disabled = !state.enabled;
  }
  return state;
}

// A small disclosure menu: Escape and outside clicks close it and focus goes
// back to the trigger.
export function createMenu(trigger, menu, doc) {
  if (!trigger || !menu) return null;
  // Disabled items (Format without Monaco) are skipped by focus movement.
  const items = () => [...(menu.querySelectorAll?.('[role="menuitem"]') || [])].filter(item => !item.disabled);
  const isOpen = () => trigger.getAttribute('aria-expanded') === 'true';
  const setOpen = (open, { focus = true } = {}) => {
    trigger.setAttribute('aria-expanded', String(open));
    menu.hidden = !open;
    if (open && focus) items()[0]?.focus?.();
    if (!open && focus) trigger.focus?.();
    return open;
  };
  trigger.addEventListener('click', () => setOpen(!isOpen()));
  menu.addEventListener('keydown', event => {
    const list = items();
    if (event.key === 'Escape') { event.preventDefault?.(); setOpen(false); return; }
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
    event.preventDefault?.();
    const index = list.indexOf(doc?.activeElement);
    const next = event.key === 'ArrowDown' ? (index + 1) % list.length : (index - 1 + list.length) % list.length;
    list[next]?.focus?.();
  });
  // Choosing an item runs its own click handler, then closes the menu.
  menu.addEventListener('click', event => {
    if (event.target?.closest?.('[role="menuitem"]')) setOpen(false);
  });
  doc?.addEventListener?.('click', event => {
    if (!isOpen()) return;
    if (trigger.contains?.(event.target) || menu.contains?.(event.target)) return;
    setOpen(false, { focus: false });
  });
  setOpen(false, { focus: false });
  return Object.freeze({ open: () => setOpen(true), close: () => setOpen(false), get isOpen() { return isOpen(); } });
}

export function installRoomLayout({
  document: doc = globalThis.document,
  window: win = globalThis.window,
} = {}) {
  if (!doc || !win) return null;
  const media = win.matchMedia?.(WIDE_ROOM_QUERY) || null;
  const isWide = () => !!media?.matches;
  let requested = defaultPanel(isWide());
  let current = renderRoomPanels(doc, requested, isWide());

  const show = (panel, { focus = false } = {}) => {
    requested = normalizePanel(panel, requested);
    current = renderRoomPanels(doc, requested, isWide());
    if (focus) doc.querySelector?.(`[data-room-tab="${current}"]`)?.focus?.();
    return current;
  };

  for (const tab of doc.querySelectorAll('[data-room-tab]')) {
    tab.addEventListener('click', () => show(tab.getAttribute('data-room-tab')));
  }
  doc.getElementById('roomPanelTabs')?.addEventListener('keydown', event => {
    const next = panelForKey(event.key, current, visiblePanels(isWide()));
    if (!next) return;
    event.preventDefault?.();
    show(next, { focus: true });
  });
  const onMediaChange = () => { current = renderRoomPanels(doc, requested, isWide()); };
  if (media?.addEventListener) media.addEventListener('change', onMediaChange);
  else media?.addListener?.(onMediaChange);

  // Results come back in the Results panel, so bring it forward on Run.
  doc.getElementById('runBtn')?.addEventListener('click', () => show('results'));

  // Board is a mode of the room. Navigation still goes through the existing
  // primary [data-tab] buttons so routing, URLs and tests keep one path.
  for (const button of doc.querySelectorAll('[data-room-mode]')) {
    button.addEventListener('click', () => {
      const mode = button.getAttribute('data-room-mode') === 'board' ? 'board' : 'code';
      win._randoriExplicitNavigation = mode;
      doc.getElementById(`tab-${mode}`)?.click?.();
    });
  }

  const menu = createMenu(doc.getElementById('editorMoreBtn'), doc.getElementById('editorMoreMenu'), doc);

  let aiEnabled = readAiPreference(win.localStorage);
  renderAiFeedback(doc, aiEnabled);
  doc.getElementById('aiFeedbackToggle')?.addEventListener('change', event => {
    aiEnabled = !!event.target?.checked;
    writeAiPreference(win.localStorage, aiEnabled);
    renderAiFeedback(doc, aiEnabled);
  });

  renderCallState(doc, !!win._randori_video?.joined);

  const room = Object.freeze({
    show,
    get panel() { return current; },
    get wide() { return isWide(); },
    setCall: joined => renderCallState(doc, joined),
    menu,
  });
  win._randori_room = room;
  return room;
}

if (typeof window !== 'undefined' && typeof document !== 'undefined') {
  installRoomLayout();
}
