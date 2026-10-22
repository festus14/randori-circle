import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

await import('../../assets/exercise-suggestions.js');
await import('../../assets/catalogue-view.js');
const api = globalThis._randori_exercise_suggestions;
const catalogueView = globalThis._randori_catalogue_view;
const html = await readFile(new URL('../../index.html', import.meta.url), 'utf8');

class FakeNode {
  constructor(tag) {
    this.tagName = String(tag).toUpperCase();
    this.children = [];
    this.attributes = new Map();
    this.className = '';
    this.hidden = false;
    this._text = '';
    this.parentNode = null;
    this.listeners = {};
    this.focused = false;
  }
  set textContent(value) { this._text = String(value); this.children = []; }
  get textContent() { return this._text + this.children.map(child => child.textContent).join(''); }
  set innerHTML(_value) { throw new Error('innerHTML must not be used'); }
  setAttribute(name, value) { this.attributes.set(name, String(value)); }
  getAttribute(name) { return this.attributes.has(name) ? this.attributes.get(name) : null; }
  append(...nodes) { for (const child of nodes) { child.parentNode = this; this.children.push(child); } }
  replaceChildren(...nodes) { this._text = ''; this.children = []; this.append(...nodes); }
  addEventListener(type, listener) { this.listeners[type] = listener; }
  focus() { this.focused = true; }
  matches(selector) {
    const attribute = /^\[([\w-]+)(?:="([^"]*)")?\]$/.exec(selector);
    if (attribute) return this.attributes.has(attribute[1]) && (attribute[2] === undefined || this.attributes.get(attribute[1]) === attribute[2]);
    if (selector.startsWith('.')) return this.className.split(/\s+/).includes(selector.slice(1));
    return false;
  }
  closest(selector) {
    for (let current = this; current; current = current.parentNode) if (current.matches(selector)) return current;
    return null;
  }
  findAll(predicate, found = []) {
    for (const child of this.children) {
      if (predicate(child)) found.push(child);
      child.findAll(predicate, found);
    }
    return found;
  }
  querySelector(selector) { return this.findAll(child => child.matches(selector))[0] || null; }
  byClass(name) { return this.findAll(child => child.className.split(/\s+/).includes(name)); }
}

const doc = { createElement: tag => new FakeNode(tag) };

function targets() {
  return {
    section: new FakeNode('section'),
    title: new FakeNode('h4'),
    list: new FakeNode('ol'),
    empty: new FakeNode('div'),
    emptyTitle: new FakeNode('p'),
    emptyMessage: new FakeNode('p'),
    note: new FakeNode('p'),
    showHidden: (() => { const button = new FakeNode('button'); button.setAttribute('data-suggestions-action', 'show-hidden'); return button; })(),
  };
}

function memoryStorage(initial = {}) {
  const values = new Map(Object.entries(initial));
  return {
    values,
    getItem: key => (values.has(key) ? values.get(key) : null),
    setItem: (key, value) => values.set(key, String(value)),
    removeItem: key => values.delete(key),
  };
}

function body(overrides = {}) {
  return {
    ok: true,
    mode: 'pair',
    room_id: 'week_11_pair_30',
    partner_count: 1,
    attempted: [
      { slug: 'focus-block-rollup', by_me: true, by_partner: false },
      { slug: 'balanced-template-markers', by_me: false, by_partner: true },
    ],
    suggestions: [
      { slug: 'coaching-route-sums', version: 1, title: 'Coaching Route Sums', difficulty: 'Hard', topic: 'trees',
        reason: { code: 'uncovered_topic', difficulty_step: 'step_up', text: 'Neither of you has practised trees yet. One step up from your recent Medium exercises.' } },
    ],
    empty_reason: null,
    ...overrides,
  };
}

test('the module installs one frozen global; the page fetches it only once the feature is advertised', () => {
  assert.ok(Object.isFrozen(api));
  // Never a static script tag: with the flag off the 14 KB module is not loaded.
  assert.doesNotMatch(html, /<script[^>]*exercise-suggestions\.js/);
  assert.match(html, /const SUGGESTIONS_SCRIPT='\/assets\/exercise-suggestions\.js';/);
  assert.match(html, /exerciseSuggestionsEnabled=j\.features\?\.exercise_suggestions===true;/);
  const refresh = /function refreshExerciseSuggestions\(options\)\{([\s\S]*?)\n  \}/.exec(html)?.[1] || '';
  const gate = refresh.indexOf("if(!exerciseSuggestionsEnabled||catalogueFetchState!=='loaded') return;");
  assert.ok(gate >= 0 && gate < refresh.indexOf('loadSuggestionsScript()'), refresh);
  // The gated refresh is the only caller of the loader.
  assert.equal((html.match(/(?<!function )loadSuggestionsScript\(\)/g) || []).length, 1);
  const section = /<section id="exerciseSuggestions"[^>]*>/.exec(html)?.[0] || '';
  assert.match(section, /data-testid="exercise-suggestions"/);
  assert.match(section, /\shidden>$/);
  for (const id of ['exerciseSuggestionsTitle', 'exerciseSuggestionList', 'exerciseSuggestionsEmpty',
    'exerciseSuggestionsEmptyTitle', 'exerciseSuggestionsEmptyMessage', 'exerciseSuggestionsNote', 'exerciseSuggestionsShowHidden']) {
    assert.ok(html.includes(`id="${id}"`), id);
  }
  // It sits in the Problem panel's catalogue section, after the exercise select.
  const browse = html.indexOf('id="catalogBrowse"');
  assert.ok(browse < html.indexOf('id="questionSelect"') && html.indexOf('id="questionSelect"') < html.indexOf('id="exerciseSuggestions"'));
  assert.ok(html.indexOf('id="exerciseSuggestions"') < html.indexOf('id="catalogBrowseList"'));
});

test('the hide list is per user, validated, de-duplicated and capped at the newest 50', () => {
  assert.equal(api.userKey(7), 'randori-hidden-suggestions:7');
  assert.equal(api.userKey('7'), 'randori-hidden-suggestions:7');
  assert.equal(api.userKey(0), null);
  assert.equal(api.userKey(null), null);
  assert.deepEqual(api.normalizeHidden(['a', 'Bad', 'a', 7, 'b']), ['a', 'b']);
  assert.deepEqual(api.normalizeHidden('nope'), []);
  const many = Array.from({ length: 60 }, (_, index) => `e-${index}`);
  assert.deepEqual(api.normalizeHidden(many), many.slice(10));

  const storage = memoryStorage({ 'randori-hidden-suggestions:2': '["x","Bad","x","y"]', 'randori-hidden-suggestions:3': '{bad' });
  assert.deepEqual(api.readHidden(storage, 2), ['x', 'y']);
  assert.deepEqual(api.readHidden(storage, 3), []);
  assert.deepEqual(api.readHidden(storage, 4), []);
  assert.deepEqual(api.readHidden(null, 2), []);
  assert.deepEqual(api.readHidden(storage, 'x'), []);

  assert.deepEqual(api.hideSlug(storage, 2, 'x'), ['y', 'x']);
  assert.equal(storage.values.get('randori-hidden-suggestions:2'), '["y","x"]');
  assert.deepEqual(api.hideSlug(storage, 2, 'Not Valid'), ['y', 'x']);
  assert.deepEqual(api.writeHidden(storage, 2, []), []);
  assert.equal(storage.values.has('randori-hidden-suggestions:2'), false);
  assert.deepEqual(api.writeHidden(null, 2, ['a']), ['a']);
  assert.deepEqual(api.writeHidden(storage, 0, ['a']), ['a']);
  assert.equal(storage.values.has('randori-hidden-suggestions:0'), false);
  const full = memoryStorage();
  for (let index = 0; index < 51; index += 1) api.hideSlug(full, 5, `e-${index}`);
  assert.deepEqual(api.readHidden(full, 5), Array.from({ length: 50 }, (_, index) => `e-${index + 1}`));
  const broken = { getItem() { throw new Error('denied'); }, setItem() { throw new Error('quota'); }, removeItem() { throw new Error('denied'); } };
  assert.deepEqual(api.readHidden(broken, 2), []);
  assert.deepEqual(api.writeHidden(broken, 2, ['a']), ['a']);
  assert.deepEqual(api.writeHidden(broken, 2, []), []);
});

test('the request names only a canonical pair room and the member\'s own hide list', () => {
  assert.equal(api.requestPath(), '/api/exercise-suggestions');
  assert.equal(api.requestPath({ room: 'standalone', hidden: [] }), '/api/exercise-suggestions');
  assert.equal(api.requestPath({ room: 'week_11_pair_30' }), '/api/exercise-suggestions?room_id=week_11_pair_30');
  assert.equal(api.requestPath({ room: 'week_11_pair_30', hidden: ['a', 'Bad', 'b'] }),
    '/api/exercise-suggestions?room_id=week_11_pair_30&hidden=a%2Cb');
});

test('responses are validated whole: one bad field makes the result unusable', () => {
  const view = api.normalizeResponse(body());
  assert.equal(view.mode, 'pair');
  assert.equal(view.partnerCount, 1);
  assert.deepEqual([...view.markers], [
    ['focus-block-rollup', { me: true, partner: false }],
    ['balanced-template-markers', { me: false, partner: true }],
  ]);
  assert.deepEqual(view.suggestions, [{
    slug: 'coaching-route-sums', version: 1, title: 'Coaching Route Sums', difficulty: 'Hard',
    reason: 'Neither of you has practised trees yet. One step up from your recent Medium exercises.',
  }]);
  assert.equal(view.emptyReason, null);
  assert.equal(view.hiddenCount, 0);
  assert.equal(api.normalizeResponse(body({ hidden_count: 2 })).hiddenCount, 2);
  assert.equal(api.normalizeResponse(body({ hidden_count: 500 })).hiddenCount, 50);
  assert.equal(api.normalizeResponse(body({ hidden_count: -1 })).hiddenCount, 0);

  const lenient = api.normalizeResponse(body({
    partner_count: 9,
    attempted: [{ slug: 'x', by_me: false, by_partner: false }],
    suggestions: [
      { slug: 'a', version: 'x', title: '  ', difficulty: 'Impossible' },
      { slug: 'b' }, { slug: 'c' }, { slug: 'd' },
    ],
    empty_reason: 'unexpected',
  }));
  assert.equal(lenient.partnerCount, 2);
  assert.equal(lenient.markers.size, 0);
  assert.deepEqual(lenient.suggestions.map(item => item.slug), ['a', 'b', 'c']);
  assert.deepEqual(lenient.suggestions[0], { slug: 'a', version: null, title: 'a', difficulty: '', reason: '' });
  assert.equal(lenient.emptyReason, null);
  assert.equal(api.normalizeResponse(body({ mode: 'solo', partner_count: 0, suggestions: [], empty_reason: 'all_attempted' })).emptyReason, 'all_attempted');
  assert.equal(api.normalizeResponse(body({ partner_count: 'x' })).partnerCount, 0);

  for (const broken of [
    null, { ...body(), ok: false }, body({ mode: 'group' }), body({ attempted: {} }), body({ suggestions: null }),
    body({ attempted: [{ slug: 'Bad', by_me: true, by_partner: false }] }),
    body({ attempted: [{ slug: 'a', by_me: 'yes', by_partner: false }] }),
    body({ attempted: [{ slug: 'a', by_me: true }] }),
    body({ suggestions: [{ slug: '<img>' }] }),
  ]) {
    assert.equal(api.normalizeResponse(broken), null, JSON.stringify(broken));
  }
});

test('markers say who attempted an exercise in plain words, never how well', () => {
  assert.equal(api.markerLabel(null), '');
  assert.equal(api.markerLabel({ me: false, partner: false }), '');
  assert.equal(api.markerLabel({ me: true, partner: false }), 'Attempted by you');
  assert.equal(api.markerLabel({ me: false, partner: true }), 'Attempted by your partner');
  assert.equal(api.markerLabel({ me: true, partner: true }), 'Attempted by you and your partner');
  assert.equal(api.markerLabel({ me: false, partner: true }, { partnerCount: 2 }), 'Attempted by a partner');
  assert.equal(api.optionSuffix({ me: false, partner: true }), ' · attempted by your partner');
  assert.equal(api.optionSuffix(null), '');
  assert.equal(api.headingText('pair'), 'Suggested for you in this pair');
  assert.equal(api.headingText('solo'), 'Suggested for you');
  assert.match(api.noteText('pair'), /^Skips exercises either of you has attempted\./);
  assert.match(api.noteText('pair'), /never scores, code or dates/);
  assert.match(api.noteText('solo'), /verified runs and completed sessions/);
  assert.deepEqual(api.emptyView('all_hidden', { hiddenCount: 2 }), {
    title: 'Every remaining exercise is hidden', message: 'Show hidden exercises to get suggestions again.', action: 'show-hidden',
  });
  assert.equal(api.emptyView('all_hidden').action, null);
  assert.equal(api.emptyView('no_exercises').title, 'No exercises yet');
  assert.equal(api.emptyView('all_attempted', { mode: 'pair' }).title, 'You have tried every exercise between you');
  assert.equal(api.emptyView('all_attempted').title, 'You have tried every exercise');
});

test('suggestions render with textContent, a labelled Hide button and no HTML', () => {
  const parts = targets();
  const evil = api.normalizeResponse(body({ suggestions: [
    { slug: 'x', version: 2, title: '<img src=x onerror=alert(1)>', difficulty: 'Medium', reason: { text: '<b>bold</b>' } },
    { slug: 'y', title: 'Plain', difficulty: 'Easy' },
    { slug: 'z', title: 'Hard one', difficulty: 'Hard' },
  ] }));
  assert.equal(api.renderSuggestions(doc, parts, evil, { hiddenCount: 1 }), true);
  assert.equal(parts.section.hidden, false);
  assert.equal(parts.section.getAttribute('data-mode'), 'pair');
  assert.equal(parts.title.textContent, 'Suggested for you in this pair');
  assert.equal(parts.list.hidden, false);
  assert.equal(parts.empty.hidden, true);
  assert.equal(parts.showHidden.hidden, false);
  assert.equal(parts.showHidden.textContent, 'Show 1 hidden exercise');
  const items = parts.list.children;
  assert.equal(items.length, 3);
  const open = items[0].querySelector('[data-suggestion-slug]');
  assert.equal(open.getAttribute('data-version'), '2');
  assert.equal(open.getAttribute('type'), 'button');
  assert.equal(open.byClass('catalog-card-title')[0].textContent, '<img src=x onerror=alert(1)>');
  assert.equal(open.byClass('catalog-difficulty')[0].getAttribute('data-tone'), 'warning');
  assert.equal(items[0].byClass('catalog-suggestion-reason')[0].textContent, '<b>bold</b>');
  const hide = items[0].querySelector('[data-hide-slug]');
  assert.equal(hide.getAttribute('aria-label'), 'Hide <img src=x onerror=alert(1)> from suggestions');
  assert.equal(hide.textContent, 'Hide');
  assert.equal(items[1].querySelector('[data-suggestion-slug]').getAttribute('data-version'), '');
  assert.equal(items[1].byClass('catalog-suggestion-reason').length, 0);
  assert.equal(items[1].byClass('catalog-difficulty')[0].getAttribute('data-tone'), 'success');
  assert.equal(items[2].byClass('catalog-difficulty')[0].getAttribute('data-tone'), 'danger');
  const unrated = api.buildSuggestion(doc, { slug: 'u', version: null, title: 'Unrated', difficulty: '', reason: '' });
  assert.equal(unrated.byClass('catalog-difficulty').length, 0);
  const unknown = api.buildSuggestion(doc, { slug: 'k', version: 1, title: 'Unknown', difficulty: 'Expert', reason: '' });
  assert.equal(unknown.byClass('catalog-difficulty')[0].getAttribute('data-tone'), 'neutral');

  const empty = api.normalizeResponse(body({ mode: 'solo', suggestions: [], empty_reason: 'all_hidden' }));
  api.renderSuggestions(doc, parts, empty, { hiddenCount: 3 });
  assert.equal(parts.title.textContent, 'Suggested for you');
  assert.equal(parts.list.hidden, true);
  assert.equal(parts.empty.hidden, false);
  assert.equal(parts.emptyTitle.textContent, 'Every remaining exercise is hidden');
  assert.equal(parts.showHidden.textContent, 'Show 3 hidden exercises');
  api.renderSuggestions(doc, parts, empty);
  assert.equal(parts.showHidden.hidden, true);

  assert.equal(api.renderSuggestions(doc, parts, null), false);
  assert.equal(parts.section.hidden, true);
  assert.equal(api.renderSuggestions(null, parts, empty), false);
  assert.equal(api.renderSuggestions(doc, null, empty), false);
  assert.equal(api.renderSuggestions(doc, {}, empty), false);
  const bare = { section: new FakeNode('section') };
  assert.equal(api.renderSuggestions(doc, bare, empty), true);
});

function controllerFixture({ responses = [], userId = 2, room = '', storage = memoryStorage() } = {}) {
  const calls = [];
  const markerUpdates = [];
  const selected = [];
  const parts = targets();
  const queue = [...responses];
  const controller = api.createController({
    doc,
    targets: parts,
    storage,
    fetchImpl: async (path, init) => {
      calls.push({ path, init });
      const next = queue.shift();
      if (next instanceof Error) throw next;
      if (typeof next === 'function') return next();
      const status = next?.status ?? 200;
      return { status, ok: status >= 200 && status < 300, json: async () => (next?.body === undefined ? body() : next.body) };
    },
    getUserId: () => (typeof userId === 'function' ? userId() : userId),
    getRoom: () => (typeof room === 'function' ? room() : room),
    onMarkers: (markers, partnerCount) => markerUpdates.push({ markers: [...markers.keys()], partnerCount }),
    onSelect: (slug, version) => selected.push([slug, version]),
  });
  return { controller, calls, markerUpdates, selected, parts, storage };
}

test('the controller stays silent until enabled and for signed-out visitors', async () => {
  const fixture = controllerFixture();
  assert.equal(fixture.controller.enabled, false);
  assert.equal(await fixture.controller.refresh(), null);
  assert.equal(fixture.calls.length, 0);
  assert.equal(fixture.parts.section.hidden, true);
  const signedOut = controllerFixture({ userId: null });
  signedOut.controller.setEnabled(true);
  assert.equal(await signedOut.controller.refresh(), null);
  assert.equal(signedOut.calls.length, 0);
  assert.equal(signedOut.controller.marker('anything'), null);
  assert.equal(signedOut.controller.partnerCount, 0);
  assert.ok(typeof fixture.parts.section.listeners.click === 'function');
  assert.doesNotThrow(() => api.createController());
});

test('the controller works without marker or selection callbacks', async () => {
  const parts = targets();
  const controller = api.createController({
    doc, targets: parts, storage: memoryStorage(), getUserId: () => 2, getRoom: () => '',
    fetchImpl: async () => ({ status: 200, ok: true, json: async () => body() }),
  });
  controller.setEnabled(true);
  assert.equal((await controller.refresh()).mode, 'pair');
  assert.doesNotThrow(() => controller.handleClick({ target: parts.list.querySelector('[data-suggestion-slug]') }));
});

test('a pair room request publishes markers and reuses the result until something changes', async () => {
  let room = 'week_11_pair_30';
  const fixture = controllerFixture({ room: () => room, responses: [{}, {}, { body: body({ mode: 'solo', partner_count: 0, attempted: [] }) }] });
  fixture.controller.setEnabled(true);
  const view = await fixture.controller.refresh();
  assert.equal(view.mode, 'pair');
  assert.deepEqual(fixture.calls.map(call => call.path), ['/api/exercise-suggestions?room_id=week_11_pair_30']);
  assert.deepEqual(fixture.calls[0].init, { credentials: 'same-origin', cache: 'no-store' });
  assert.deepEqual(fixture.markerUpdates.at(-1), { markers: ['focus-block-rollup', 'balanced-template-markers'], partnerCount: 1 });
  assert.deepEqual(fixture.controller.marker('balanced-template-markers'), { me: false, partner: true });
  assert.equal(fixture.controller.partnerCount, 1);
  assert.equal(fixture.controller.view, view);
  assert.equal(fixture.parts.section.hidden, false);
  // Same member, room and hide list: no second request (also while in flight).
  const [again, concurrent] = await Promise.all([fixture.controller.refresh(), fixture.controller.refresh()]);
  assert.equal(again, view);
  assert.equal(concurrent, view);
  assert.equal(fixture.calls.length, 1);
  // A forced refresh (after a run) asks again.
  await fixture.controller.refresh({ force: true });
  assert.equal(fixture.calls.length, 2);
  // Leaving the room switches to solo.
  room = '';
  const solo = await fixture.controller.refresh();
  assert.equal(solo.mode, 'solo');
  assert.equal(fixture.calls.at(-1).path, '/api/exercise-suggestions');
  const inFlight = controllerFixture({ responses: [() => new Promise(resolve => setTimeout(() => resolve({ status: 200, ok: true, json: async () => body() }), 5))] });
  inFlight.controller.setEnabled(true);
  const [first, second] = await Promise.all([inFlight.controller.refresh(), inFlight.controller.refresh()]);
  assert.equal(first, second);
  assert.equal(inFlight.calls.length, 1);
});

test('a room that is not the current pair falls back to solo, and failures hide the card', async () => {
  const fallback = controllerFixture({ room: 'week_10_pair_20', responses: [{ status: 404, body: { error: 'pair not found' } }, { body: body({ mode: 'solo', partner_count: 0 }) }] });
  fallback.controller.setEnabled(true);
  const view = await fallback.controller.refresh();
  assert.equal(view.mode, 'solo');
  assert.deepEqual(fallback.calls.map(call => call.path), [
    '/api/exercise-suggestions?room_id=week_10_pair_20', '/api/exercise-suggestions',
  ]);

  for (const responses of [[new Error('offline')], [{ status: 503, body: { error: 'x' } }], [{ body: { ok: true, mode: 'weird' } }],
    [{ status: 200, body: null }], [() => ({ status: 200, ok: true, json: async () => { throw new SyntaxError('bad json'); } })]]) {
    const failing = controllerFixture({ responses });
    failing.controller.setEnabled(true);
    assert.equal(await failing.controller.refresh(), null);
    assert.equal(failing.parts.section.hidden, true);
    assert.deepEqual(failing.markerUpdates.at(-1), { markers: [], partnerCount: 0 });
  }
});

test('a slower, older response never overwrites a newer one', async () => {
  let release;
  let room = 'week_11_pair_30';
  const fixture = controllerFixture({
    room: () => room,
    responses: [
      () => new Promise(resolve => { release = () => resolve({ status: 200, ok: true, json: async () => body() }); }),
      { body: body({ mode: 'solo', partner_count: 0 }) },
    ],
  });
  fixture.controller.setEnabled(true);
  const stale = fixture.controller.refresh();
  room = '';
  const fresh = await fixture.controller.refresh();
  release();
  assert.equal(await stale, null);
  assert.equal(fresh.mode, 'solo');
  assert.equal(fixture.controller.view.mode, 'solo');
  // Turning the feature off clears markers and hides the card.
  fixture.controller.setEnabled(false);
  assert.equal(fixture.controller.view, null);
  assert.equal(fixture.parts.section.hidden, true);
});

test('hiding stores the slug for this member, asks again and moves focus to the next suggestion', async () => {
  const storage = memoryStorage();
  const fixture = controllerFixture({ storage, responses: [{}, { body: body({ hidden_count: 1 }) }, { body: body({ suggestions: [], empty_reason: 'all_hidden', hidden_count: 2 }) }, {}] });
  fixture.controller.setEnabled(true);
  await fixture.controller.refresh();
  assert.equal(await fixture.controller.hide('Bad Slug'), null);
  await fixture.controller.hide('coaching-route-sums');
  assert.equal(storage.values.get('randori-hidden-suggestions:2'), '["coaching-route-sums"]');
  assert.equal(fixture.calls.at(-1).path, '/api/exercise-suggestions?hidden=coaching-route-sums');
  assert.equal(fixture.parts.list.querySelector('.catalog-suggestion-open').focused, true);
  // The button count comes from the server: only exercises that could be suggested.
  assert.equal(fixture.parts.showHidden.textContent, 'Show 1 hidden exercise');
  // When nothing is left the Show hidden button takes focus.
  await fixture.controller.hide('focus-block-rollup');
  assert.equal(fixture.parts.showHidden.hidden, false);
  assert.equal(fixture.parts.showHidden.textContent, 'Show 2 hidden exercises');
  assert.equal(fixture.parts.showHidden.focused, true);
  await fixture.controller.showHidden();
  assert.equal(fixture.parts.showHidden.hidden, true);
  assert.equal(storage.values.has('randori-hidden-suggestions:2'), false);
  assert.equal(fixture.calls.at(-1).path, '/api/exercise-suggestions');
  // With no suggestion and no hidden exercise, focus falls back to the heading.
  const headingFocus = controllerFixture({ responses: [{ body: body({ suggestions: [], empty_reason: 'all_attempted' }) }] });
  headingFocus.controller.setEnabled(true);
  await headingFocus.controller.showHidden();
  assert.equal(headingFocus.parts.title.focused, true);
});

test('hidden slugs that can never be suggested again are pruned from storage', async () => {
  const storage = memoryStorage({
    'randori-hidden-suggestions:2': JSON.stringify(['focus-block-rollup', 'balanced-template-markers', 'retired-one', 'coaching-route-sums']),
  });
  const calls = [];
  const controller = api.createController({
    doc, targets: targets(), storage, getUserId: () => 2, getRoom: () => '',
    getCatalogueSlugs: () => ['focus-block-rollup', 'balanced-template-markers', 'coaching-route-sums'],
    fetchImpl: async path => { calls.push(path); return { status: 200, ok: true, json: async () => body({ hidden_count: 1 }) }; },
  });
  controller.setEnabled(true);
  await controller.refresh();
  // focus-block-rollup was attempted by the member and retired-one left the
  // catalogue; balanced-template-markers (partner-attempted) and the still
  // suggestable coaching-route-sums stay hidden.
  assert.equal(storage.values.get('randori-hidden-suggestions:2'), '["balanced-template-markers","coaching-route-sums"]');
  // The shown result already reflects the pruned list: no second request.
  await controller.refresh();
  assert.equal(calls.length, 1);
  // Without a catalogue list only the member's own attempts are pruned.
  const partial = memoryStorage({ 'randori-hidden-suggestions:2': '["focus-block-rollup","retired-one"]' });
  const other = api.createController({
    doc, targets: targets(), storage: partial, getUserId: () => 2, getRoom: () => '',
    fetchImpl: async () => ({ status: 200, ok: true, json: async () => body() }),
  });
  other.setEnabled(true);
  await other.refresh();
  assert.equal(partial.values.get('randori-hidden-suggestions:2'), '["retired-one"]');
});

test('clicks open a suggestion, hide it, or show hidden exercises', async () => {
  const fixture = controllerFixture({ responses: [{}, {}, {}] });
  fixture.controller.setEnabled(true);
  await fixture.controller.refresh();
  const item = fixture.parts.list.children[0];
  const title = item.querySelector('[data-suggestion-slug]').children[0];
  fixture.parts.section.listeners.click({ target: title });
  assert.deepEqual(fixture.selected, [['coaching-route-sums', 1]]);
  const unversioned = api.buildSuggestion(doc, { slug: 'u', version: null, title: 'U', difficulty: '', reason: '' });
  fixture.controller.handleClick({ target: unversioned.querySelector('[data-suggestion-slug]') });
  assert.deepEqual(fixture.selected.at(-1), ['u', null]);
  fixture.controller.handleClick({ target: item.querySelector('[data-hide-slug]') });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(fixture.calls.at(-1).path, '/api/exercise-suggestions?hidden=coaching-route-sums');
  fixture.controller.handleClick({ target: fixture.parts.showHidden });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(fixture.calls.at(-1).path, '/api/exercise-suggestions');
  const calls = fixture.calls.length;
  fixture.controller.handleClick({ target: new FakeNode('span') });
  fixture.controller.handleClick({});
  fixture.controller.handleClick();
  assert.equal(fixture.calls.length, calls);
});

test('catalogue cards show the attempted marker only when there is one', () => {
  const question = { slug: 'graphs', version: 1, title: 'Graphs', difficulty: 'Medium', type: 'graph', tags: ['graphs'], prompt: 'Walk it.' };
  assert.equal('attempted' in catalogueView.exerciseCard(question), false);
  assert.equal('attempted' in catalogueView.exerciseCard(question, null, { attempted: '' }), false);
  const card = catalogueView.exerciseCard(question, null, { attempted: 'Attempted by your partner' });
  assert.equal(card.attempted, 'Attempted by your partner');
  const item = catalogueView.buildExerciseCard(doc, card);
  const chip = item.byClass('catalog-chip--attempted')[0];
  assert.equal(chip.textContent, 'Attempted by your partner');
  assert.equal(chip.getAttribute('data-testid'), 'catalog-attempted');
  assert.equal(catalogueView.buildExerciseCard(doc, catalogueView.exerciseCard(question)).byClass('catalog-chip--attempted').length, 0);
});
