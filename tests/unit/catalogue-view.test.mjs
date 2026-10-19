import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

await import('../../assets/catalogue-view.js');
const view = globalThis._randori_catalogue_view;
const html = await readFile(new URL('../../index.html', import.meta.url), 'utf8');
const catalog = JSON.parse(await readFile(new URL('../../data/randori-catalog-v1.json', import.meta.url), 'utf8'));

class FakeNode {
  constructor(tag) {
    this.tagName = String(tag).toUpperCase();
    this.children = [];
    this.attributes = new Map();
    this.className = '';
    this.hidden = false;
    this._text = '';
    this.parentNode = null;
  }
  set textContent(value) { this._text = String(value); this.children = []; }
  get textContent() { return this._text + this.children.map(child => child.textContent).join(''); }
  setAttribute(name, value) { this.attributes.set(name, String(value)); }
  getAttribute(name) { return this.attributes.has(name) ? this.attributes.get(name) : null; }
  append(...nodes) { for (const child of nodes) { child.parentNode = this; this.children.push(child); } }
  replaceChildren(...nodes) { this._text = ''; this.children = []; this.append(...nodes); }
  findAll(predicate, found = []) {
    for (const child of this.children) {
      if (predicate(child)) found.push(child);
      child.findAll(predicate, found);
    }
    return found;
  }
  byClass(name) { return this.findAll(child => child.className.split(/\s+/).includes(name)); }
  byTag(tag) { return this.findAll(child => child.tagName === tag.toUpperCase()); }
}

const doc = { createElement: tag => new FakeNode(tag) };

function question(overrides = {}) {
  return {
    slug: 'capacity-upgrade-index',
    version: 1,
    title: 'Capacity Upgrade Index',
    difficulty: 'Easy',
    type: 'binary-search',
    tags: ['arrays', 'binary-search', 'search', 'extra'],
    prompt: 'Find the first index that needs an upgrade. The list is sorted.',
    constraints: ['1 <= n <= 10^5', 'Values are integers'],
    examples: [{ input: [[1, 2, 3], 2], output: 1, explanation: 'Index 1 is the first at capacity.' }],
    languages: {
      javascript: { signature: 'function capacityUpgradeIndex(loads, limit)', starter: 'function capacityUpgradeIndex(loads, limit) {}' },
      python: { signature: 'def capacity_upgrade_index(loads, limit):', starter: 'def capacity_upgrade_index(loads, limit):\n    pass' },
    },
    attribution: '© 2026 Randori Circle project contributors. Original exercise.',
    ...overrides,
  };
}

test('the module installs one frozen global and the page loads it before the catalogue script', () => {
  assert.ok(Object.isFrozen(view));
  assert.match(html, /<script src="\/assets\/catalogue-view\.js"><\/script>/);
  assert.ok(html.indexOf('/assets/catalogue-view.js') < html.indexOf('// --- Original catalogue'));
});

test('the Problem panel keeps the hooks used by tests and adds browse states', () => {
  for (const id of ['questionSelect', 'catalogSearch', 'catalogDifficulty', 'catalogType', 'catalogFilterStatus',
    'catalogFilterEmpty', 'catalogRetryBtn', 'qTitle', 'qDiff', 'qDesc', 'qExamples', 'qConstraints', 'qTests',
    'qCustomCount', 'questionPanel', 'catalogLanguage', 'catalogList', 'catalogClearFilters', 'catalogEmptyClear',
    'catalogError', 'qStartCoding', 'catalogBrowseList']) {
    assert.match(html, new RegExp(`id="${id}"`), id);
  }
  for (const testId of ['catalog-filters', 'catalog-search', 'catalog-difficulty', 'catalog-type', 'catalog-status',
    'catalog-empty', 'catalog-language', 'catalog-list', 'catalog-clear', 'catalog-error', 'catalog-browse']) {
    assert.match(html, new RegExp(`data-testid="${testId}"`), testId);
  }
  assert.doesNotMatch(html, /authoritative server result|Run your code to see server-verified|Select an approved catalog question/);
});

test('filters normalise, detect activity and match title, tags, difficulty, pattern and language', () => {
  assert.deepEqual(view.normalizeFilters({ search: '  hi ', difficulty: 'Weird', type: '', language: null }),
    { search: 'hi', difficulty: 'all', type: 'all', language: 'all' });
  assert.equal(view.filtersActive({}), false);
  assert.equal(view.filtersActive(view.DEFAULT_FILTERS), false);
  assert.equal(view.filtersActive({ search: ' x ' }), true);
  assert.equal(view.filtersActive({ difficulty: 'Hard' }), true);
  assert.equal(view.filtersActive({ type: 'heap' }), true);
  assert.equal(view.filtersActive({ language: 'python' }), true);

  const item = question();
  assert.equal(view.matchesFilters(item, { search: 'CAPACITY  upgrade' }), true);
  assert.equal(view.matchesFilters(item, { search: 'binary-search arrays' }), true);
  assert.equal(view.matchesFilters(item, { search: 'graph' }), false);
  assert.equal(view.matchesFilters(item, { difficulty: 'Easy' }), true);
  assert.equal(view.matchesFilters(item, { difficulty: 'Medium' }), false);
  assert.equal(view.matchesFilters(item, { type: 'binary-search' }), true);
  assert.equal(view.matchesFilters(item, { type: 'heap' }), false);
  assert.equal(view.matchesFilters(item, { language: 'python' }), true);
  assert.equal(view.matchesFilters(item, { language: 'go' }), false);
  assert.equal(view.matchesFilters({ title: 'Legacy', topicTags: [{ name: 'Graphs' }, { slug: 'bfs' }] }, { search: 'bfs graphs' }), true);
  assert.equal(view.matchesFilters(null, {}), true);

  const list = [item, question({ slug: 'b', title: 'B', difficulty: 'Hard', type: 'heap' })];
  assert.deepEqual(view.filterQuestions(list, { difficulty: 'Hard' }).map(entry => entry.slug), ['b']);
  assert.deepEqual(view.filterQuestions(null, {}), []);
});

test('filter options come from the loaded catalogue in a stable order with readable labels', () => {
  const list = [question({ type: 'two-pointers' }), question({ type: 'binary_search' }), question({ type: '' }),
    { languages: { go: { starter: 'x' } }, starter_per_lang: { ruby: 'x', rust: '' } }];
  assert.deepEqual(view.patternOptions(list), [
    { value: 'binary_search', label: 'Binary Search' },
    { value: 'two-pointers', label: 'Two Pointers' },
  ]);
  assert.deepEqual(view.languageOptions(list).map(option => option.label), ['Go', 'JavaScript', 'Python', 'Ruby']);
  assert.deepEqual(view.patternOptions(undefined), []);
  assert.deepEqual(view.languageOptions(undefined), []);
  assert.deepEqual(view.questionLanguages({}), []);
  assert.deepEqual(view.questionTags({}), []);
  assert.equal(view.patternLabel(''), '');
  assert.equal(view.languageLabel('python'), 'Python');
});

test('difficulty maps to a status tone', () => {
  assert.equal(view.difficultyTone('Easy'), 'success');
  assert.equal(view.difficultyTone('Medium'), 'warning');
  assert.equal(view.difficultyTone('Hard'), 'danger');
  assert.equal(view.difficultyTone('System'), 'neutral');
});

test('summaries use the first sentence and clip long text at a word boundary', () => {
  assert.equal(view.summarize('One. Two.'), 'One.');
  assert.equal(view.summarize(''), '');
  assert.equal(view.summarize('No terminal punctuation here'), 'No terminal punctuation here');
  const long = `${'word '.repeat(60)}end.`;
  const summary = view.summarize(long, 40);
  assert.ok(summary.length <= 40);
  assert.match(summary, /word…$/);
  assert.equal(view.summarize('x'.repeat(50), 20), `${'x'.repeat(19)}…`);
});

test('exercise cards carry title, difficulty, pattern, three tags, summary and selection', () => {
  const card = view.exerciseCard(question(), { slug: 'capacity-upgrade-index', version: 1 });
  assert.deepEqual(card, {
    slug: 'capacity-upgrade-index',
    version: 1,
    title: 'Capacity Upgrade Index',
    difficulty: 'Easy',
    tone: 'success',
    pattern: 'Binary Search',
    tags: ['arrays', 'binary-search', 'search'],
    summary: 'Find the first index that needs an upgrade.',
    languages: ['JavaScript', 'Python'],
    selected: true,
  });
  assert.equal(view.exerciseCard(question(), { slug: 'capacity-upgrade-index', version: 2 }).selected, false);
  assert.equal(view.exerciseCard(question(), { slug: 'capacity-upgrade-index', version: null }).selected, true);
  assert.equal(view.exerciseCard(question(), null).selected, false);
  const bare = view.exerciseCard({ slug: 'bare', version: 'x' });
  assert.equal(bare.title, 'bare');
  assert.equal(bare.version, null);
  assert.equal(view.exerciseCard({}).title, 'Untitled exercise');
});

test('status, empty and failure states each have one clear message and action', () => {
  assert.equal(view.statusText({ state: 'loading' }), 'Loading exercises…');
  assert.equal(view.statusText(), 'Loading exercises…');
  assert.equal(view.statusText({ state: 'signin' }), 'Sign in to browse exercises');
  assert.equal(view.statusText({ state: 'failed' }), 'Exercises could not load');
  assert.equal(view.statusText({ state: 'offline' }), 'Exercises could not load');
  assert.equal(view.statusText({ state: 'loaded', count: 0, total: 0 }), 'No exercises yet');
  assert.equal(view.statusText({ state: 'loaded', count: 1, total: 1 }), '1 exercise');
  assert.equal(view.statusText({ state: 'loaded', count: 19, total: 19, active: true }), '19 exercises');
  assert.equal(view.statusText({ state: 'loaded', count: 0, total: 19, active: true }), '0 of 19 exercises');

  assert.deepEqual(view.emptyStateView({ total: 0 }).action, null);
  const keep = view.emptyStateView({ total: 19, current: 'Focus Block Roll-up' });
  assert.equal(keep.action, 'clear');
  assert.match(keep.message, /No public exercises match these filters/);
  assert.match(keep.message, /still working on Focus Block Roll-up/);
  assert.doesNotMatch(view.emptyStateView({ total: 3 }).message, /still working/);
  assert.doesNotMatch(JSON.stringify(keep), /unavailable/i);

  assert.equal(view.failureView('signin').action, 'signin');
  assert.equal(view.failureView('offline').action, 'retry');
  assert.equal(view.failureView('offline').state, 'offline');
  assert.equal(view.failureView().state, 'failed');
  assert.equal(view.failureView('anything').actionLabel, 'Try again');
});

test('examples use parameter names from the signature and fall back to raw JSON', () => {
  assert.deepEqual(view.parameterNames('function f(blocks, limit = 3, ...rest)'), ['blocks', 'limit', 'rest']);
  assert.deepEqual(view.parameterNames('def f(self, items: list[int], *args, **kw):'), ['items', 'args', 'kw']);
  assert.deepEqual(view.parameterNames('no parens'), []);

  const [example] = view.exampleViews(question());
  assert.deepEqual(example, {
    label: 'Example 1',
    input: 'loads = [1,2,3]\nlimit = 2',
    output: '1',
    explanation: 'Index 1 is the first at capacity.',
  });
  assert.equal(view.exampleView({ input: { a: 1 }, expect: true }, 1, []).input, '{"a":1}');
  assert.equal(view.exampleView({ input: { a: 1 }, expect: true }, 1, []).output, 'true');
  assert.deepEqual(view.exampleView('Plain example', 0), { label: 'Example 1', input: 'Plain example', output: '', explanation: '' });
  assert.equal(view.exampleView({ other: 1 }, 2).input, '{"other":1}');
  assert.equal(view.exampleView({ input: undefined, other: 1n }, 0).input, '[object Object]');
  assert.equal(view.exampleViews({ examples: 'nope' }).length, 0);
  assert.equal(view.exampleViews({ examples: [1, 2, 3, 4] }).length, 3);
});

test('constraints, prompt paragraphs and attribution are normalised text', () => {
  assert.deepEqual(view.constraintList(question()), ['1 <= n <= 10^5', 'Values are integers']);
  assert.deepEqual(view.constraintList({ constraints_text: 'a\n\n b ' }), ['a', 'b']);
  assert.deepEqual(view.constraintList({}), []);
  assert.deepEqual(view.promptParagraphs({ description: 'One\n\nTwo\nThree' }), ['One', 'Two', 'Three']);
  assert.equal(view.attributionText(question()), '© 2026 Randori Circle project contributors. Original exercise.');
  assert.equal(view.attributionText({ contentProvenance: { licenseName: 'Original' } }), 'Original');
  assert.equal(view.attributionText({}), '');
});

test('run summaries use plain language', () => {
  assert.deepEqual(view.runSummaryView({ passed: 3, total: 3, language: 'javascript' }), {
    status: 'pass', headline: 'Result: 3/3 passed', mark: '✓', detail: 'JavaScript · Checked on the server',
  });
  assert.equal(view.runSummaryView({ passed: 1, total: 3 }).status, 'partial');
  assert.equal(view.runSummaryView({ passed: 0, total: 3 }).status, 'fail');
  assert.equal(view.runSummaryView().status, 'fail');
  assert.equal(view.runSummaryView().detail, 'Checked on the server');
});

test('exercise list renders accessible cards as text and marks the current exercise', () => {
  const list = new FakeNode('ul');
  const cards = [
    view.exerciseCard(question(), { slug: 'capacity-upgrade-index', version: 1 }),
    view.exerciseCard(question({ slug: 'x', title: '<img src=x onerror=alert(1)>', type: '', tags: [], prompt: '' })),
  ];
  assert.equal(view.renderExerciseList(doc, list, cards), 2);
  assert.equal(list.hidden, false);
  assert.equal(list.getAttribute('aria-busy'), 'false');
  const buttons = list.byTag('button');
  assert.equal(buttons.length, 2);
  assert.equal(buttons[0].getAttribute('type'), 'button');
  assert.equal(buttons[0].getAttribute('data-slug'), 'capacity-upgrade-index');
  assert.equal(buttons[0].getAttribute('data-version'), '1');
  assert.equal(buttons[0].getAttribute('aria-current'), 'true');
  assert.equal(buttons[1].getAttribute('aria-current'), null);
  assert.match(buttons[0].textContent, /Capacity Upgrade Index.*Easy.*Find the first index.*Binary Search.*arrays.*Current exercise/);
  assert.equal(buttons[0].byClass('catalog-difficulty')[0].getAttribute('data-tone'), 'success');
  assert.equal(buttons[1].byClass('catalog-card-title')[0].textContent, '<img src=x onerror=alert(1)>');
  assert.equal(buttons[1].byClass('catalog-card-summary').length, 0);
  assert.equal(buttons[1].byClass('catalog-chip').length, 0);

  assert.equal(view.renderExerciseList(doc, list, []), 0);
  assert.equal(list.hidden, true);
  assert.equal(view.renderExerciseList(null, list, []), 0);
});

test('list skeleton is hidden from assistive technology and marks the list busy', () => {
  const list = new FakeNode('ul');
  view.renderListSkeleton(doc, list, 2);
  assert.equal(list.children.length, 2);
  assert.equal(list.children[0].getAttribute('aria-hidden'), 'true');
  assert.equal(list.getAttribute('aria-busy'), 'true');
  view.renderListSkeleton(doc, list);
  assert.equal(list.children.length, 3);
  view.renderListSkeleton(null, list);
});

test('problem statement renders title, badges, prose, examples and constraints from the public projection', () => {
  const targets = {
    title: new FakeNode('h3'), badges: new FakeNode('div'), description: new FakeNode('div'),
    examples: new FakeNode('div'), constraints: new FakeNode('div'),
  };
  targets.badges.hidden = true;
  assert.equal(view.renderStatement(doc, targets, question({ prompt: 'Para one.\n\nPara two.' }), { language: 'python' }), true);
  assert.equal(targets.title.textContent, 'Capacity Upgrade Index');
  assert.equal(targets.badges.hidden, false);
  assert.deepEqual(targets.badges.children.map(child => child.textContent), ['Easy', 'Binary Search', 'Version 1']);
  assert.deepEqual(targets.description.byTag('p').slice(0, 2).map(child => child.textContent), ['Para one.', 'Para two.']);
  assert.equal(targets.description.byClass('q-tags')[0].children.length, 4);
  assert.equal(targets.examples.byTag('h4')[0].textContent, 'Examples');
  assert.deepEqual(targets.examples.byTag('dt').map(child => child.textContent), ['Input', 'Output']);
  assert.equal(targets.examples.byTag('pre')[0].textContent, 'loads = [1,2,3]\nlimit = 2');
  assert.equal(targets.examples.byClass('q-example-note')[0].textContent, 'Index 1 is the first at capacity.');
  assert.deepEqual(targets.constraints.byTag('li').map(child => child.textContent), ['1 <= n <= 10^5', 'Values are integers']);

  view.renderStatement(doc, targets, question({ examples: [], constraints: [], tags: [], type: '', version: null, difficulty: '' }));
  assert.match(targets.examples.textContent, /no public examples/);
  assert.equal(targets.constraints.children.length, 0);
  assert.deepEqual(targets.badges.children.map(child => child.textContent), ['Unrated']);
  assert.equal(targets.description.byClass('q-tags').length, 0);
  view.renderStatement(doc, targets, question({ examples: ['Raw text example'] }));
  assert.deepEqual(targets.examples.byTag('dt').map(child => child.textContent), ['Input']);

  assert.equal(view.renderStatement(doc, {}, question()), true);
  assert.equal(view.renderStatement(doc, targets, null), false);
});

test('every exercise in the published catalogue produces a readable card and examples', () => {
  for (const exercise of catalog.exercises) {
    const card = view.exerciseCard(exercise);
    assert.ok(card.title && card.summary && card.pattern, exercise.slug);
    assert.ok(card.summary.length <= 140, exercise.slug);
    const examples = view.exampleViews(exercise);
    assert.ok(examples.every(example => example.input && example.label), exercise.slug);
  }
});
