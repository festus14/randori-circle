import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  AI_FEEDBACK_PREFERENCE_KEY,
  ROOM_PANELS,
  WIDE_ROOM_QUERY,
  aiFeedbackState,
  callState,
  createMenu,
  defaultPanel,
  installRoomLayout,
  normalizePanel,
  panelForKey,
  readAiPreference,
  renderAiFeedback,
  renderCallState,
  renderRoomPanels,
  resolvePanel,
  visiblePanels,
  writeAiPreference,
} from '../../assets/room-layout.js';

class FakeElement {
  constructor({ id = '', attributes = {}, hidden = false, parent = null } = {}) {
    this.id = id;
    this.hidden = hidden;
    this.checked = false;
    this.disabled = false;
    this.textContent = '';
    this.attributes = new Map(Object.entries(attributes));
    this.listeners = new Map();
    this.children = [];
    this.parent = parent;
    this.clicks = 0;
    this.focused = 0;
    this.ownerDocument = null;
  }
  setAttribute(name, value) { this.attributes.set(name, String(value)); }
  getAttribute(name) { return this.attributes.has(name) ? this.attributes.get(name) : null; }
  removeAttribute(name) { this.attributes.delete(name); }
  addEventListener(type, listener) {
    if (!this.listeners.has(type)) this.listeners.set(type, []);
    this.listeners.get(type).push(listener);
  }
  dispatch(type, event = {}) {
    const payload = { type, target: this, preventDefault() { payload.defaultPrevented = true; }, ...event };
    for (const listener of this.listeners.get(type) || []) listener(payload);
    return payload;
  }
  click() { this.clicks += 1; this.dispatch('click'); }
  focus() { this.focused += 1; if (this.ownerDocument) this.ownerDocument.activeElement = this; }
  contains(node) {
    for (let current = node; current; current = current.parent) if (current === this) return true;
    return false;
  }
  closest(selector) {
    for (let current = this; current; current = current.parent) {
      if (selector === '[role="menuitem"]' && current.getAttribute('role') === 'menuitem') return current;
    }
    return null;
  }
  querySelectorAll(selector) {
    if (selector === '[role="menuitem"]') return this.children.filter(child => child.getAttribute('role') === 'menuitem');
    return [];
  }
}

class FakeStorage {
  constructor(initial = {}) { this.map = new Map(Object.entries(initial)); }
  getItem(key) { return this.map.has(key) ? this.map.get(key) : null; }
  setItem(key, value) { this.map.set(key, String(value)); }
  removeItem(key) { this.map.delete(key); }
}

function fakeMedia(matches) {
  const listeners = [];
  return {
    matches,
    addEventListener(type, listener) { if (type === 'change') listeners.push(listener); },
    set(next) { this.matches = next; for (const listener of listeners) listener({ matches: next }); },
  };
}

function fakeRoomDocument() {
  const doc = { activeElement: null, listeners: new Map() };
  const make = (options) => { const element = new FakeElement(options); element.ownerDocument = doc; return element; };
  const tabs = ROOM_PANELS.map(name => make({ id: `roomTab-${name}`, attributes: { 'data-room-tab': name } }));
  const panels = ROOM_PANELS.map(name => make({ id: `roomPanel-${name}`, attributes: { 'data-room-panel': name }, hidden: name !== 'code' }));
  const side = make({ id: 'roomSide', hidden: true });
  const layout = make({ id: 'roomLayout' });
  const tablist = make({ id: 'roomPanelTabs' });
  const runBtn = make({ id: 'runBtn' });
  const videoBar = make({ id: 'videoBar', hidden: true });
  const tabCode = make({ id: 'tab-code' });
  const tabBoard = make({ id: 'tab-board' });
  const modeCode = make({ attributes: { 'data-room-mode': 'code' } });
  const modeBoard = make({ attributes: { 'data-room-mode': 'board' } });
  const moreBtn = make({ id: 'editorMoreBtn' });
  const moreMenu = make({ id: 'editorMoreMenu' });
  const items = ['formatBtn', 'copyStarterBtn', 'editorResetBtn'].map(id => {
    const item = make({ id, attributes: { role: 'menuitem' }, parent: moreMenu });
    moreMenu.children.push(item);
    return item;
  });
  const aiToggle = make({ id: 'aiFeedbackToggle' });
  const aiTools = make({ id: 'aiFeedbackTools', hidden: true });
  const aiHint = make({ id: 'aiFeedbackHint' });
  const aiButtons = ['aiRecordBtn', 'aiAnalyzeBtn', 'aiHistoryBtn'].map(id => make({ id }));
  const all = [...tabs, ...panels, side, layout, tablist, runBtn, videoBar, tabCode, tabBoard, moreBtn, moreMenu, ...items, aiToggle, aiTools, aiHint, ...aiButtons];
  const byId = Object.fromEntries(all.filter(element => element.id).map(element => [element.id, element]));
  Object.assign(doc, {
    tabs, panels, side, layout, tablist, runBtn, videoBar, tabCode, tabBoard, modeCode, modeBoard,
    moreBtn, moreMenu, items, aiToggle, aiTools, aiHint, aiButtons,
    getElementById: id => byId[id] || null,
    querySelector(selector) {
      const match = /^\[data-room-tab="([a-z]+)"\]$/.exec(selector);
      return match ? tabs.find(tab => tab.getAttribute('data-room-tab') === match[1]) || null : null;
    },
    querySelectorAll(selector) {
      if (selector === '[data-room-tab]') return tabs;
      if (selector === '[data-room-panel]') return panels;
      if (selector === '[data-room-mode]') return [modeCode, modeBoard];
      return [];
    },
    addEventListener(type, listener) {
      if (!doc.listeners.has(type)) doc.listeners.set(type, []);
      doc.listeners.get(type).push(listener);
    },
    dispatch(type, target) { for (const listener of doc.listeners.get(type) || []) listener({ type, target }); },
  });
  tabCode.addEventListener('click', () => { doc.navigated = 'code'; });
  tabBoard.addEventListener('click', () => { doc.navigated = 'board'; });
  return doc;
}

function panelState(doc) {
  return Object.fromEntries(doc.panels.map(panel => [panel.getAttribute('data-room-panel'), !panel.hidden]));
}

function selectedTab(doc) {
  return doc.tabs.find(tab => tab.getAttribute('aria-selected') === 'true')?.getAttribute('data-room-tab') || null;
}

test('panel helpers default to the editor on phones and Problem beside it on wide screens', () => {
  assert.deepEqual(ROOM_PANELS, ['code', 'problem', 'results', 'session', 'notes']);
  assert.equal(WIDE_ROOM_QUERY, '(min-width: 1100px)');
  assert.equal(normalizePanel('results'), 'results');
  assert.equal(normalizePanel('chat'), 'code');
  assert.equal(normalizePanel(undefined, 'problem'), 'problem');
  assert.equal(defaultPanel(true), 'problem');
  assert.equal(defaultPanel(false), 'code');
  assert.equal(resolvePanel('code', true), 'problem');
  assert.equal(resolvePanel('code', false), 'code');
  assert.equal(resolvePanel('notes', true), 'notes');
  assert.equal(resolvePanel('bogus', true), 'problem');
  assert.equal(resolvePanel('bogus', false), 'code');
  assert.deepEqual(visiblePanels(true), ['problem', 'results', 'session', 'notes']);
  assert.deepEqual(visiblePanels(false), ROOM_PANELS);
});

test('arrow keys wrap through the visible panels and Home/End jump', () => {
  const panels = visiblePanels(false);
  assert.equal(panelForKey('ArrowRight', 'code', panels), 'problem');
  assert.equal(panelForKey('ArrowRight', 'notes', panels), 'code');
  assert.equal(panelForKey('ArrowLeft', 'code', panels), 'notes');
  assert.equal(panelForKey('Home', 'results', panels), 'code');
  assert.equal(panelForKey('End', 'results', panels), 'notes');
  assert.equal(panelForKey('ArrowLeft', 'code', visiblePanels(true)), 'notes', 'unknown current starts from the first tab');
  assert.equal(panelForKey('Enter', 'code', panels), null);
  assert.equal(panelForKey('ArrowRight', 'code', []), null);
});

test('renderRoomPanels keeps the editor mounted and shows exactly one side panel', () => {
  const doc = fakeRoomDocument();
  assert.equal(renderRoomPanels(doc, 'code', false), 'code');
  assert.deepEqual(panelState(doc), { code: true, problem: false, results: false, session: false, notes: false });
  assert.equal(doc.side.hidden, true);
  assert.equal(doc.layout.getAttribute('data-panel'), 'code');
  assert.equal(selectedTab(doc), 'code');
  assert.equal(doc.tabs[0].getAttribute('tabindex'), '0');
  assert.equal(doc.tabs[1].getAttribute('tabindex'), '-1');

  assert.equal(renderRoomPanels(doc, 'results', false), 'results');
  assert.deepEqual(panelState(doc), { code: false, problem: false, results: true, session: false, notes: false });
  assert.equal(doc.side.hidden, false);

  assert.equal(renderRoomPanels(doc, 'code', true), 'problem');
  assert.deepEqual(panelState(doc), { code: true, problem: true, results: false, session: false, notes: false });
  assert.equal(doc.side.hidden, false);
  assert.equal(selectedTab(doc), 'problem');
  assert.equal(renderRoomPanels(null, 'notes', true), 'notes');
});

test('the call strip is collapsed until the member joins', () => {
  assert.equal(callState(true), 'on');
  assert.equal(callState(false), 'off');
  const doc = fakeRoomDocument();
  assert.equal(renderCallState(doc, true), 'on');
  assert.equal(doc.videoBar.hidden, false);
  assert.equal(doc.videoBar.getAttribute('data-call'), 'on');
  assert.equal(renderCallState(doc, false), 'off');
  assert.equal(doc.videoBar.hidden, true);
  assert.equal(renderCallState(null, false), 'off');
});

test('AI feedback is opt-in and remembered only as a presentation preference', () => {
  assert.equal(aiFeedbackState(false).enabled, false);
  assert.match(aiFeedbackState(false).hint, /^Off\./);
  assert.match(aiFeedbackState(true).hint, /^On\./);

  const storage = new FakeStorage();
  assert.equal(readAiPreference(storage), false);
  assert.equal(writeAiPreference(storage, true), true);
  assert.equal(storage.getItem(AI_FEEDBACK_PREFERENCE_KEY), 'on');
  assert.equal(readAiPreference(storage), true);
  assert.equal(writeAiPreference(storage, false), true);
  assert.equal(storage.getItem(AI_FEEDBACK_PREFERENCE_KEY), null);
  const broken = { getItem() { throw new Error('denied'); }, setItem() { throw new Error('denied'); } };
  assert.equal(readAiPreference(broken), false);
  assert.equal(writeAiPreference(broken, true), false);
  assert.equal(readAiPreference(undefined), false);

  const doc = fakeRoomDocument();
  renderAiFeedback(doc, false);
  assert.equal(doc.aiTools.hidden, true);
  assert.equal(doc.aiToggle.checked, false);
  assert.ok(doc.aiButtons.every(button => button.disabled));
  renderAiFeedback(doc, true);
  assert.equal(doc.aiTools.hidden, false);
  assert.equal(doc.aiToggle.checked, true);
  assert.match(doc.aiHint.textContent, /^On\./);
  assert.ok(doc.aiButtons.every(button => !button.disabled));
  assert.equal(renderAiFeedback(null, true).enabled, true);
});

test('the editor more-menu opens, moves focus with arrows, and closes on Escape, choice, or outside click', () => {
  assert.equal(createMenu(null, null, null), null);
  const doc = fakeRoomDocument();
  const menu = createMenu(doc.moreBtn, doc.moreMenu, doc);
  assert.equal(menu.isOpen, false);
  assert.equal(doc.moreMenu.hidden, true);
  assert.equal(doc.moreBtn.getAttribute('aria-expanded'), 'false');

  doc.items[0].disabled = true;
  doc.moreBtn.dispatch('click');
  assert.equal(doc.activeElement, doc.items[1], 'a disabled first item is skipped');
  doc.moreMenu.dispatch('keydown', { key: 'Escape' });
  doc.items[0].disabled = false;

  doc.moreBtn.dispatch('click');
  assert.equal(menu.isOpen, true);
  assert.equal(doc.moreMenu.hidden, false);
  assert.equal(doc.activeElement, doc.items[0]);
  doc.moreMenu.dispatch('keydown', { key: 'ArrowDown' });
  assert.equal(doc.activeElement, doc.items[1]);
  doc.moreMenu.dispatch('keydown', { key: 'ArrowUp' });
  doc.moreMenu.dispatch('keydown', { key: 'ArrowUp' });
  assert.equal(doc.activeElement, doc.items[2], 'ArrowUp wraps to the last item');
  doc.moreMenu.dispatch('keydown', { key: 'Tab' });
  assert.equal(menu.isOpen, true, 'other keys are ignored');
  const escape = doc.moreMenu.dispatch('keydown', { key: 'Escape' });
  assert.equal(escape.defaultPrevented, true);
  assert.equal(menu.isOpen, false);
  assert.equal(doc.activeElement, doc.moreBtn, 'focus returns to the trigger');

  menu.open();
  doc.moreMenu.dispatch('click', { target: doc.items[1] });
  assert.equal(menu.isOpen, false, 'choosing an item closes the menu');

  menu.open();
  doc.moreMenu.dispatch('click', { target: doc.moreMenu });
  assert.equal(menu.isOpen, true, 'clicks on menu padding keep it open');
  doc.dispatch('click', doc.items[0]);
  assert.equal(menu.isOpen, true, 'clicks inside the menu are not outside clicks');
  const focusBefore = doc.moreBtn.focused;
  doc.dispatch('click', new FakeElement());
  assert.equal(menu.isOpen, false, 'outside click closes');
  assert.equal(doc.moreBtn.focused, focusBefore, 'outside click does not steal focus');
  doc.dispatch('click', new FakeElement());
  assert.equal(menu.isOpen, false);
  menu.close();
  assert.equal(menu.isOpen, false);
});

test('installRoomLayout wires tabs, keyboard, Run, Board mode, media changes and AI opt-in', () => {
  const doc = fakeRoomDocument();
  const media = fakeMedia(false);
  const storage = new FakeStorage();
  const win = { matchMedia: query => { assert.equal(query, WIDE_ROOM_QUERY); return media; }, localStorage: storage };
  const room = installRoomLayout({ document: doc, window: win });
  assert.equal(win._randori_room, room);
  assert.equal(room.panel, 'code');
  assert.equal(room.wide, false);
  assert.equal(doc.videoBar.hidden, true);
  assert.equal(doc.aiTools.hidden, true);

  doc.tabs[2].dispatch('click');
  assert.equal(room.panel, 'results');
  assert.equal(selectedTab(doc), 'results');

  const arrow = doc.tablist.dispatch('keydown', { key: 'ArrowRight' });
  assert.equal(arrow.defaultPrevented, true);
  assert.equal(room.panel, 'session');
  assert.equal(doc.activeElement, doc.tabs[3]);
  const ignored = doc.tablist.dispatch('keydown', { key: 'a' });
  assert.equal(ignored.defaultPrevented, undefined);
  assert.equal(room.panel, 'session');

  room.show('code');
  doc.runBtn.dispatch('click');
  assert.equal(room.panel, 'results', 'Run brings the results forward');

  room.show('code');
  media.set(true);
  assert.equal(room.panel, 'problem', 'wide screens show Problem beside the editor');
  assert.equal(doc.panels[0].hidden, false);
  media.set(false);
  assert.equal(room.panel, 'code', 'the request survives a round trip through wide layout');
  assert.equal(room.show('nonsense'), 'code');

  doc.modeBoard.dispatch('click');
  assert.equal(doc.navigated, 'board');
  assert.equal(win._randoriExplicitNavigation, 'board');
  doc.modeCode.dispatch('click');
  assert.equal(doc.navigated, 'code');
  assert.equal(win._randoriExplicitNavigation, 'code');

  room.setCall(true);
  assert.equal(doc.videoBar.hidden, false);
  room.setCall(false);
  assert.equal(doc.videoBar.hidden, true);

  doc.aiToggle.checked = true;
  doc.aiToggle.dispatch('change');
  assert.equal(doc.aiTools.hidden, false);
  assert.equal(storage.getItem(AI_FEEDBACK_PREFERENCE_KEY), 'on');
  doc.aiToggle.checked = false;
  doc.aiToggle.dispatch('change');
  assert.equal(doc.aiTools.hidden, true);
  assert.equal(storage.getItem(AI_FEEDBACK_PREFERENCE_KEY), null);

  doc.moreBtn.dispatch('click');
  assert.equal(room.menu.isOpen, true);
});

test('installRoomLayout restores the AI preference, supports legacy media listeners, and tolerates missing hosts', () => {
  assert.equal(installRoomLayout({ document: null, window: null }), null);
  const doc = fakeRoomDocument();
  let legacy = null;
  const media = { matches: true, addListener(listener) { legacy = listener; } };
  const win = {
    matchMedia: () => media,
    localStorage: new FakeStorage({ [AI_FEEDBACK_PREFERENCE_KEY]: 'on' }),
    _randori_video: { joined: true },
  };
  const room = installRoomLayout({ document: doc, window: win });
  assert.equal(room.panel, 'problem');
  assert.equal(doc.aiTools.hidden, false, 'a remembered opt-in is restored');
  assert.equal(doc.videoBar.hidden, false, 'an already joined call keeps its strip');
  room.show('notes', { focus: true });
  assert.equal(doc.activeElement, doc.tabs[4]);
  media.matches = false;
  legacy();
  assert.equal(room.panel, 'notes');

  const bare = installRoomLayout({
    document: { getElementById: () => null, querySelectorAll: () => [], querySelector: () => null },
    window: {},
  });
  assert.equal(bare.panel, 'code');
  assert.equal(bare.wide, false);
  assert.equal(bare.menu, null);
});

test('index.html loads the room module and keeps the room markup contract', async () => {
  const html = await readFile(new URL('../../index.html', import.meta.url), 'utf8');
  assert.match(html, /<script type="module" src="\/assets\/room-layout\.js"><\/script>/);
  assert.match(html, /id="roomPanelTabs" class="room-tabs" role="tablist" aria-label="Room panels"/);
  for (const name of ROOM_PANELS) {
    assert.match(html, new RegExp(`id="roomTab-${name}"[^>]+role="tab"[^>]+data-room-tab="${name}"[^>]+aria-controls="roomPanel-${name}"`));
    assert.match(html, new RegExp(`id="roomPanel-${name}"[^>]+role="tabpanel"[^>]+aria-labelledby="roomTab-${name}"[^>]+data-room-panel="${name}"`));
  }
  // One Join action, and only one AI section.
  assert.equal((html.match(/id="vidJoinBtn"/g) || []).length, 1);
  assert.doesNotMatch(html, /codeJoinSessionBtn|aiFeedbackCardBelowBoard/);
  const room = html.match(/<section id="view-code"[\s\S]*?<!-- PAIRINGS/)?.[0] || '';
  assert.ok(room.includes('id="roomLayout"'));
  assert.doesNotMatch(room, /Join Session|Join video/);
  assert.equal((html.match(/id="aiPanel"/g) || []).length, 1);
  assert.match(html, /id="aiFeedbackToggle" type="checkbox" role="switch"/);
  // Multi-line placeholders use real line breaks, not a literal backslash-n.
  const placeholders = [...html.matchAll(/placeholder="([^"]*)"/g)].map(match => match[1]);
  assert.ok(placeholders.length > 0);
  for (const placeholder of placeholders) assert.doesNotMatch(placeholder, /\\n/);
  assert.match(html, /id="aiTranscript"[^>]+placeholder="[^"]*&#10;/);
  // The call strip starts collapsed; Board is a room mode routed through the primary tab.
  assert.match(html, /id="videoBar" class="video-bar" data-call="off" hidden/);
  assert.equal((html.match(/data-room-mode="board"/g) || []).length, 2);
  // Whiteboard tools use the icon sprite instead of unicode glyphs.
  const toolbar = html.match(/<div class="board-toolbar"[\s\S]*?<div class="canvas-host"/)?.[0] || '';
  assert.ok(toolbar.includes('icons.svg#i-pointer'));
  assert.doesNotMatch(toolbar, /[✋☆⌫↖✎▭◯↗↩↪✕⊡]/u);
});
