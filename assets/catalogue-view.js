// Practice catalogue view model (WP-K).
//
// Pure presentation helpers for the room's Problem panel: filtering, exercise
// cards, empty/loading/error states and the problem statement. Every function
// maps the server's public exercise projection to display data or DOM nodes.
// Nothing here fetches, stores, selects, or runs anything: catalogue loading,
// the selected exercise identity, drafts and the run gateway stay owned by the
// inline application script in index.html.
//
// Content is untrusted. Builders only ever assign `textContent`, never HTML.
// The public projection carries no hidden cases, and nothing here asks for
// them.
//
// Loaded as a classic script (before the application script) so renderers can
// call it synchronously; node tests import the same file as an ES module.
(function installCatalogueView(root) {
  const DIFFICULTIES = Object.freeze(['Easy', 'Medium', 'Hard']);
  const LANGUAGE_LABELS = Object.freeze({ javascript: 'JavaScript', python: 'Python' });
  const DEFAULT_FILTERS = Object.freeze({ search: '', difficulty: 'all', type: 'all', language: 'all' });
  const SUMMARY_MAX = 140;
  const MAX_CARD_TAGS = 3;
  const MAX_EXAMPLES = 3;

  function text(value) {
    return value == null ? '' : String(value);
  }

  function clip(value, max) {
    const source = text(value);
    return source.length > max ? `${source.slice(0, max - 1).trimEnd()}…` : source;
  }

  function normalizeFilters(state = {}) {
    const difficulty = DIFFICULTIES.includes(state.difficulty) ? state.difficulty : 'all';
    return {
      search: text(state.search).trim(),
      difficulty,
      type: text(state.type) || 'all',
      language: text(state.language) || 'all',
    };
  }

  function filtersActive(state = {}) {
    const filters = normalizeFilters(state);
    return !!filters.search || filters.difficulty !== 'all' || filters.type !== 'all' || filters.language !== 'all';
  }

  function patternLabel(type) {
    const value = text(type).trim();
    if (!value) return '';
    return value.replace(/[-_]+/g, ' ').replace(/\b\w/g, letter => letter.toUpperCase());
  }

  function difficultyTone(difficulty) {
    if (difficulty === 'Easy') return 'success';
    if (difficulty === 'Medium') return 'warning';
    if (difficulty === 'Hard') return 'danger';
    return 'neutral';
  }

  function languageLabel(language) {
    const value = text(language);
    return LANGUAGE_LABELS[value] || patternLabel(value);
  }

  // Languages the exercise ships starter code for (public projection only).
  function questionLanguages(question) {
    const found = new Set();
    const languages = question?.languages;
    if (languages && typeof languages === 'object') {
      for (const [key, spec] of Object.entries(languages)) if (spec) found.add(key);
    }
    const starters = question?.starter_per_lang;
    if (starters && typeof starters === 'object') {
      for (const [key, starter] of Object.entries(starters)) if (starter) found.add(key);
    }
    return [...found].sort((left, right) => left.localeCompare(right));
  }

  function questionTags(question) {
    if (Array.isArray(question?.tags)) return question.tags.map(text).filter(Boolean);
    if (Array.isArray(question?.topicTags)) return question.topicTags.map(tag => text(tag?.name || tag?.slug)).filter(Boolean);
    return [];
  }

  function matchesFilters(question, state = {}) {
    const filters = normalizeFilters(state);
    if (filters.difficulty !== 'all' && text(question?.difficulty) !== filters.difficulty) return false;
    if (filters.type !== 'all' && text(question?.type) !== filters.type) return false;
    if (filters.language !== 'all' && !questionLanguages(question).includes(filters.language)) return false;
    const terms = filters.search.toLocaleLowerCase().split(/\s+/).filter(Boolean);
    if (!terms.length) return true;
    const searchable = [question?.title, question?.slug, question?.type, ...questionTags(question)]
      .map(value => text(value).toLocaleLowerCase())
      .join(' ');
    return terms.every(term => searchable.includes(term));
  }

  function filterQuestions(questions, state = {}) {
    return (Array.isArray(questions) ? questions : []).filter(question => matchesFilters(question, state));
  }

  function patternOptions(questions) {
    const types = new Set((Array.isArray(questions) ? questions : []).map(question => text(question?.type)).filter(Boolean));
    return [...types].sort((left, right) => left.localeCompare(right)).map(value => ({ value, label: patternLabel(value) }));
  }

  function languageOptions(questions) {
    const languages = new Set((Array.isArray(questions) ? questions : []).flatMap(questionLanguages));
    return [...languages].sort((left, right) => left.localeCompare(right)).map(value => ({ value, label: languageLabel(value) }));
  }

  // First sentence of the prompt, clipped at a word boundary.
  function summarize(prompt, max = SUMMARY_MAX) {
    const source = text(prompt).replace(/\s+/g, ' ').trim();
    if (!source) return '';
    const sentence = /^(.+?[.!?])(?:\s|$)/.exec(source)?.[1] || source;
    if (sentence.length <= max) return sentence;
    const cut = sentence.slice(0, max - 1);
    const boundary = cut.lastIndexOf(' ');
    return `${(boundary > max / 2 ? cut.slice(0, boundary) : cut).replace(/[\s,;:]+$/, '')}…`;
  }

  function sameExercise(question, selected) {
    if (!selected?.slug || text(question?.slug) !== text(selected.slug)) return false;
    return selected.version == null || Number(question?.version) === Number(selected.version);
  }

  function exerciseCard(question, selected = null) {
    const difficulty = text(question?.difficulty);
    return {
      slug: text(question?.slug),
      version: Number.isInteger(Number(question?.version)) && Number(question.version) > 0 ? Number(question.version) : null,
      title: clip(question?.title || question?.slug || 'Untitled exercise', 120),
      difficulty,
      tone: difficultyTone(difficulty),
      pattern: patternLabel(question?.type),
      tags: questionTags(question).slice(0, MAX_CARD_TAGS).map(tag => clip(tag, 40)),
      summary: summarize(question?.prompt || question?.description),
      languages: questionLanguages(question).map(languageLabel),
      selected: sameExercise(question, selected),
    };
  }

  function statusText({ state = 'idle', count = 0, total = 0, active = false } = {}) {
    if (state === 'loading' || state === 'idle') return 'Loading exercises…';
    if (state === 'signin') return 'Sign in to browse exercises';
    if (state === 'failed' || state === 'offline') return 'Exercises could not load';
    const noun = total === 1 ? 'exercise' : 'exercises';
    if (!total) return 'No exercises yet';
    if (!active || count === total) return `${total} ${noun}`;
    return `${count} of ${total} ${noun}`;
  }

  // One recovery action per state. `current` is the exercise the room keeps
  // while the filters hide it, so the user knows nothing was lost.
  function emptyStateView({ total = 0, current = '' } = {}) {
    if (!total) {
      return {
        title: 'No exercises yet',
        message: 'The catalogue has no published exercises right now. Check back soon.',
        action: null,
      };
    }
    const keep = text(current).trim();
    return {
      title: 'No exercises match these filters',
      message: keep
        ? `No public exercises match these filters. You are still working on ${keep}. Clear the filters to see every exercise.`
        : 'No public exercises match these filters. Clear the filters to see every exercise.',
      action: 'clear',
    };
  }

  function failureView(reason = 'error') {
    if (reason === 'signin') {
      return {
        state: 'signin',
        title: 'Sign in to practise',
        message: 'The exercise catalogue is for circle members. Sign in to browse exercises and run your code.',
        action: 'signin',
        actionLabel: 'Sign in',
      };
    }
    if (reason === 'offline') {
      return {
        state: 'offline',
        title: 'You are offline',
        message: 'Exercises load when you are back online. Your code stays in the editor.',
        action: 'retry',
        actionLabel: 'Try again',
      };
    }
    return {
      state: 'failed',
      title: 'Exercises could not load',
      message: 'Something went wrong while loading the catalogue. Your code stays in the editor.',
      action: 'retry',
      actionLabel: 'Try again',
    };
  }

  // `function rollUp(blocks, limit)` / `def roll_up(blocks, limit):` -> names.
  function parameterNames(signature) {
    const match = /\(([^)]*)\)/.exec(text(signature));
    if (!match) return [];
    return match[1]
      .split(',')
      .map(part => part.replace(/[:=].*$/, '').replace(/^\s*(?:\.\.\.|\*{1,2})/, '').trim())
      .filter(name => /^[A-Za-z_$][\w$]*$/.test(name) && name !== 'self');
  }

  function formatValue(value, max) {
    let rendered;
    try { rendered = JSON.stringify(value); } catch { rendered = text(value); }
    return clip(rendered === undefined ? text(value) : rendered, max);
  }

  function exampleView(example, index, names = []) {
    const label = `Example ${index + 1}`;
    if (typeof example === 'string') return { label, input: clip(example, 300), output: '', explanation: '' };
    if (example && typeof example === 'object' && example.input !== undefined) {
      const args = Array.isArray(example.input) ? example.input : [example.input];
      const input = args.length === names.length
        ? args.map((arg, position) => `${names[position]} = ${formatValue(arg, 240)}`).join('\n')
        : formatValue(example.input, 400);
      return {
        label,
        input,
        output: formatValue(example.output ?? example.expect ?? '', 240),
        explanation: clip(example.explanation, 240),
      };
    }
    return { label, input: formatValue(example, 300), output: '', explanation: '' };
  }

  function exampleViews(question, language = 'javascript') {
    const examples = Array.isArray(question?.examples) ? question.examples.slice(0, MAX_EXAMPLES) : [];
    const signature = question?.languages?.[language]?.signature || question?.languages?.javascript?.signature || '';
    const names = parameterNames(signature);
    return examples.map((example, index) => exampleView(example, index, names));
  }

  function constraintList(question) {
    const source = question?.constraints ?? question?.constraints_text ?? '';
    const list = Array.isArray(source) ? source : text(source).split(/\r?\n/);
    return list.map(item => clip(text(item).trim(), 300)).filter(Boolean).slice(0, 12);
  }

  function promptParagraphs(question) {
    return text(question?.prompt || question?.description)
      .slice(0, 6000)
      .split(/\r?\n\s*\r?\n|\r?\n/)
      .map(part => part.trim())
      .filter(Boolean);
  }

  function attributionText(question) {
    return clip(question?.attribution || question?.contentProvenance?.licenseName || '', 200);
  }

  function runSummaryView({ passed = 0, total = 0, language = '' } = {}) {
    const passedCount = Number(passed) || 0;
    const totalCount = Number(total) || 0;
    const status = totalCount > 0 && passedCount === totalCount ? 'pass' : passedCount > 0 ? 'partial' : 'fail';
    return {
      status,
      headline: `Result: ${passedCount}/${totalCount} passed`,
      mark: status === 'pass' ? '✓' : '✗',
      detail: [languageLabel(language), 'Checked on the server'].filter(Boolean).join(' · '),
    };
  }

  // ---- DOM builders (textContent only) ----

  function node(doc, tag, { className = '', textValue = null, attrs = {} } = {}) {
    const element = doc.createElement(tag);
    if (className) element.className = className;
    if (textValue != null) element.textContent = textValue;
    for (const [name, value] of Object.entries(attrs)) {
      if (value === false || value == null) continue;
      element.setAttribute(name, value === true ? '' : String(value));
    }
    return element;
  }

  function difficultyBadge(doc, difficulty) {
    return node(doc, 'span', {
      className: `rc-badge catalog-difficulty`,
      textValue: difficulty || 'Unrated',
      attrs: { 'data-tone': difficultyTone(difficulty) },
    });
  }

  function buildExerciseCard(doc, card) {
    const item = node(doc, 'li', { className: 'catalog-item' });
    const button = node(doc, 'button', {
      className: 'catalog-card',
      attrs: {
        type: 'button',
        'data-slug': card.slug,
        'data-version': card.version ?? '',
        'aria-current': card.selected ? 'true' : null,
      },
    });
    const head = node(doc, 'span', { className: 'catalog-card-head' });
    head.append(node(doc, 'span', { className: 'catalog-card-title', textValue: card.title }), difficultyBadge(doc, card.difficulty));
    button.append(head);
    if (card.summary) button.append(node(doc, 'span', { className: 'catalog-card-summary', textValue: card.summary }));
    const meta = node(doc, 'span', { className: 'catalog-card-meta' });
    if (card.pattern) meta.append(node(doc, 'span', { className: 'catalog-chip catalog-chip--pattern', textValue: card.pattern }));
    for (const tag of card.tags) meta.append(node(doc, 'span', { className: 'catalog-chip', textValue: tag }));
    if (card.selected) meta.append(node(doc, 'span', { className: 'catalog-card-current', textValue: 'Current exercise' }));
    button.append(meta);
    item.append(button);
    return item;
  }

  function renderExerciseList(doc, list, cards) {
    if (!doc || !list) return 0;
    list.replaceChildren(...cards.map(card => buildExerciseCard(doc, card)));
    list.hidden = !cards.length;
    list.setAttribute('aria-busy', 'false');
    return cards.length;
  }

  function renderListSkeleton(doc, list, count = 3) {
    if (!doc || !list) return;
    const items = Array.from({ length: count }, () => {
      const item = node(doc, 'li', { className: 'catalog-item catalog-item--skeleton', attrs: { 'aria-hidden': 'true' } });
      item.append(
        node(doc, 'span', { className: 'rc-skeleton catalog-skeleton-title' }),
        node(doc, 'span', { className: 'rc-skeleton catalog-skeleton-line' }),
      );
      return item;
    });
    list.replaceChildren(...items);
    list.hidden = false;
    list.setAttribute('aria-busy', 'true');
  }

  function renderStatement(doc, targets, question, { language = 'javascript' } = {}) {
    if (!doc || !question) return false;
    const { title, badges, description, examples, constraints } = targets || {};
    if (title) title.textContent = text(question.title);
    if (badges) {
      const parts = [difficultyBadge(doc, text(question.difficulty))];
      const pattern = patternLabel(question.type);
      if (pattern) parts.push(node(doc, 'span', { className: 'rc-badge catalog-pattern', textValue: pattern }));
      if (question.version != null) parts.push(node(doc, 'span', { className: 'catalog-version', textValue: `Version ${question.version}` }));
      badges.replaceChildren(...parts);
      badges.hidden = false;
    }
    if (description) {
      const parts = promptParagraphs(question).map(paragraph => node(doc, 'p', { textValue: paragraph }));
      const tags = questionTags(question).slice(0, 6);
      if (tags.length) {
        const row = node(doc, 'p', { className: 'q-tags' });
        for (const tag of tags) row.append(node(doc, 'span', { className: 'catalog-chip', textValue: clip(tag, 40) }));
        parts.push(row);
      }
      description.replaceChildren(...parts);
    }
    if (examples) {
      const views = exampleViews(question, language);
      if (views.length) {
        const ioPair = (list, label, value) => {
          const detail = node(doc, 'dd');
          detail.append(node(doc, 'pre', { textValue: value }));
          list.append(node(doc, 'dt', { textValue: label }), detail);
        };
        const blocks = views.map(view => {
          const block = node(doc, 'figure', { className: 'q-example' });
          block.append(node(doc, 'figcaption', { className: 'q-example-label', textValue: view.label }));
          const list = node(doc, 'dl', { className: 'q-example-io' });
          ioPair(list, 'Input', view.input);
          if (view.output) ioPair(list, 'Output', view.output);
          block.append(list);
          if (view.explanation) block.append(node(doc, 'p', { className: 'q-example-note', textValue: view.explanation }));
          return block;
        });
        examples.replaceChildren(node(doc, 'h4', { className: 'q-section-title', textValue: 'Examples' }), ...blocks);
      } else {
        examples.replaceChildren(node(doc, 'p', { className: 'small muted', textValue: 'This exercise has no public examples.' }));
      }
    }
    if (constraints) {
      const items = constraintList(question);
      if (items.length) {
        const list = node(doc, 'ul', { className: 'q-constraints-list' });
        for (const item of items) list.append(node(doc, 'li', { textValue: item }));
        constraints.replaceChildren(node(doc, 'h4', { className: 'q-section-title', textValue: 'Constraints' }), list);
      } else {
        constraints.replaceChildren();
      }
    }
    return true;
  }

  root._randori_catalogue_view = Object.freeze({
    DIFFICULTIES,
    DEFAULT_FILTERS,
    normalizeFilters,
    filtersActive,
    patternLabel,
    difficultyTone,
    languageLabel,
    questionLanguages,
    questionTags,
    matchesFilters,
    filterQuestions,
    patternOptions,
    languageOptions,
    summarize,
    exerciseCard,
    statusText,
    emptyStateView,
    failureView,
    parameterNames,
    exampleView,
    exampleViews,
    constraintList,
    promptParagraphs,
    attributionText,
    runSummaryView,
    buildExerciseCard,
    renderExerciseList,
    renderListSkeleton,
    renderStatement,
  });
})(typeof window !== 'undefined' ? window : globalThis);
