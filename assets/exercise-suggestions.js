// Practice: attempted markers and suggested next exercises (issue #296).
//
// Client half of `GET /api/exercise-suggestions`. The server computes the
// markers and suggestions; this file only stores the member's own hide list,
// builds the request, validates the response and renders it with
// `textContent` (never HTML). Nothing here sees a partner's runs: the server
// sends one boolean per exercise.
//
// The hide list is kept in localStorage per signed-in user id (no migration).
// It is per browser, not synced across devices, and the server never stores
// it; it is sent with each request only so the server can skip those
// exercises when choosing.
//
// Loaded on demand by the catalogue only when the server advertises the
// feature (EXERCISE_SUGGESTIONS_ENABLED); node tests import the same file.
(function installExerciseSuggestions(root) {
  const STORAGE_PREFIX = 'randori-hidden-suggestions:';
  const MAX_HIDDEN = 50;
  const MAX_SUGGESTIONS = 3;
  const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
  const ROOM = /^week_[1-9]\d*_pair_[1-9]\d*$/;
  const ENDPOINT = '/api/exercise-suggestions';
  const DIFFICULTIES = Object.freeze(['Easy', 'Medium', 'Hard']);
  const EMPTY_REASONS = Object.freeze(['all_attempted', 'all_hidden', 'no_exercises']);

  function validSlug(value) {
    return typeof value === 'string' && value.length <= 120 && SLUG.test(value);
  }

  function userKey(userId) {
    const id = Number(userId);
    return Number.isSafeInteger(id) && id > 0 ? `${STORAGE_PREFIX}${id}` : null;
  }

  function normalizeHidden(list) {
    const unique = [];
    for (const slug of Array.isArray(list) ? list : []) {
      if (validSlug(slug) && !unique.includes(slug)) unique.push(slug);
    }
    return unique.slice(-MAX_HIDDEN);
  }

  function readHidden(storage, userId) {
    const key = userKey(userId);
    if (!key || !storage) return [];
    try { return normalizeHidden(JSON.parse(storage.getItem(key) || '[]')); }
    catch { return []; }
  }

  function writeHidden(storage, userId, list) {
    const key = userKey(userId);
    const hidden = normalizeHidden(list);
    if (!key || !storage) return hidden;
    try {
      if (hidden.length) storage.setItem(key, JSON.stringify(hidden));
      else storage.removeItem(key);
    } catch {}
    return hidden;
  }

  // At the cap the oldest hidden exercise is forgotten first.
  function hideSlug(storage, userId, slug) {
    const current = readHidden(storage, userId).filter(item => item !== slug);
    return writeHidden(storage, userId, validSlug(slug) ? [...current, slug] : current);
  }

  function requestPath({ room = '', hidden = [] } = {}) {
    const params = new URLSearchParams();
    if (ROOM.test(String(room || ''))) params.set('room_id', String(room));
    const list = normalizeHidden(hidden);
    if (list.length) params.set('hidden', list.join(','));
    const query = params.toString();
    return query ? `${ENDPOINT}?${query}` : ENDPOINT;
  }

  function text(value, max = 300) {
    return typeof value === 'string' ? value.trim().slice(0, max) : '';
  }

  // The server response, validated. Unknown fields are dropped; anything
  // malformed makes the whole response unusable (null) rather than partial.
  function normalizeResponse(body) {
    if (!body || body.ok !== true || !['solo', 'pair'].includes(body.mode)) return null;
    if (!Array.isArray(body.attempted) || !Array.isArray(body.suggestions)) return null;
    const markers = new Map();
    for (const marker of body.attempted) {
      if (!validSlug(marker?.slug) || typeof marker.by_me !== 'boolean' || typeof marker.by_partner !== 'boolean') return null;
      if (marker.by_me || marker.by_partner) markers.set(marker.slug, { me: marker.by_me, partner: marker.by_partner });
    }
    const suggestions = [];
    for (const item of body.suggestions.slice(0, MAX_SUGGESTIONS)) {
      if (!validSlug(item?.slug)) return null;
      const version = Number(item.version);
      suggestions.push({
        slug: item.slug,
        version: Number.isSafeInteger(version) && version > 0 ? version : null,
        title: text(item.title, 120) || item.slug,
        difficulty: DIFFICULTIES.includes(item.difficulty) ? item.difficulty : '',
        reason: text(item.reason?.text),
      });
    }
    const partnerCount = Number(body.partner_count);
    const hiddenCount = Number(body.hidden_count);
    return {
      mode: body.mode,
      partnerCount: Number.isSafeInteger(partnerCount) && partnerCount > 0 ? Math.min(partnerCount, 2) : 0,
      // Hidden exercises that could otherwise be suggested (server-counted).
      hiddenCount: Number.isSafeInteger(hiddenCount) && hiddenCount > 0 ? Math.min(hiddenCount, MAX_HIDDEN) : 0,
      markers,
      suggestions,
      emptyReason: EMPTY_REASONS.includes(body.empty_reason) ? body.empty_reason : null,
    };
  }

  function partnerNoun(partnerCount) {
    return partnerCount > 1 ? 'a partner' : 'your partner';
  }

  // "Attempted" chip text for a catalogue card ('' when not attempted).
  function markerLabel(marker, { partnerCount = 1 } = {}) {
    if (!marker || (!marker.me && !marker.partner)) return '';
    if (marker.me && marker.partner) return `Attempted by you and ${partnerNoun(partnerCount)}`;
    return marker.me ? 'Attempted by you' : `Attempted by ${partnerNoun(partnerCount)}`;
  }

  // Suffix for the exercise <select> option text.
  function optionSuffix(marker, options) {
    const label = markerLabel(marker, options);
    return label ? ` · ${label.charAt(0).toLowerCase()}${label.slice(1)}` : '';
  }

  // Pair suggestions skip what either partner attempted and step up from
  // the runs both see in this room, but each partner's own history still
  // shapes their list, so the heading does not promise one shared list.
  function headingText(mode) {
    return mode === 'pair' ? 'Suggested for you in this pair' : 'Suggested for you';
  }

  function noteText(mode) {
    return mode === 'pair'
      ? 'Skips exercises either of you has attempted. Your partner sees only which exercises you have attempted, never scores, code or dates.'
      : 'Based on your verified runs and completed sessions.';
  }

  function emptyView(reason, { mode = 'solo', hiddenCount = 0 } = {}) {
    if (reason === 'all_hidden') {
      return {
        title: 'Every remaining exercise is hidden',
        message: 'Show hidden exercises to get suggestions again.',
        action: hiddenCount > 0 ? 'show-hidden' : null,
      };
    }
    if (reason === 'no_exercises') {
      return { title: 'No exercises yet', message: 'Suggestions appear once the catalogue has exercises.', action: null };
    }
    return {
      title: mode === 'pair' ? 'You have tried every exercise between you' : 'You have tried every exercise',
      message: 'New suggestions appear as the catalogue grows. You can still pick any exercise from the list.',
      action: null,
    };
  }

  function difficultyTone(difficulty) {
    if (difficulty === 'Easy') return 'success';
    if (difficulty === 'Medium') return 'warning';
    if (difficulty === 'Hard') return 'danger';
    return 'neutral';
  }

  function node(doc, tag, { className = '', textValue = null, attrs = {} } = {}) {
    const element = doc.createElement(tag);
    if (className) element.className = className;
    if (textValue != null) element.textContent = textValue;
    for (const [name, value] of Object.entries(attrs)) element.setAttribute(name, String(value));
    return element;
  }

  function buildSuggestion(doc, suggestion) {
    const item = node(doc, 'li', { className: 'catalog-suggestion', attrs: { 'data-slug': suggestion.slug } });
    const main = node(doc, 'div', { className: 'catalog-suggestion-main' });
    const open = node(doc, 'button', {
      className: 'catalog-suggestion-open',
      attrs: {
        type: 'button',
        'data-suggestion-slug': suggestion.slug,
        'data-version': suggestion.version ?? '',
        'data-testid': 'exercise-suggestion-open',
      },
    });
    open.append(node(doc, 'span', { className: 'catalog-card-title', textValue: suggestion.title }));
    if (suggestion.difficulty) {
      open.append(node(doc, 'span', {
        className: 'rc-badge catalog-difficulty',
        textValue: suggestion.difficulty,
        attrs: { 'data-tone': difficultyTone(suggestion.difficulty) },
      }));
    }
    main.append(open);
    if (suggestion.reason) {
      main.append(node(doc, 'p', { className: 'small muted catalog-suggestion-reason', textValue: suggestion.reason }));
    }
    const hide = node(doc, 'button', {
      className: 'btn ghost sm catalog-suggestion-hide',
      textValue: 'Hide',
      attrs: {
        type: 'button',
        'data-hide-slug': suggestion.slug,
        'data-testid': 'exercise-suggestion-hide',
        'aria-label': `Hide ${suggestion.title} from suggestions`,
      },
    });
    item.append(main, hide);
    return item;
  }

  // Fills the static section markup. `targets` are the section's elements.
  function renderSuggestions(doc, targets, view, { hiddenCount = 0 } = {}) {
    const { section, title, list, empty, emptyTitle, emptyMessage, note, showHidden } = targets || {};
    if (!doc || !section) return false;
    if (!view) { section.hidden = true; return false; }
    if (title) title.textContent = headingText(view.mode);
    if (note) note.textContent = noteText(view.mode);
    section.setAttribute('data-mode', view.mode);
    if (list) {
      list.replaceChildren(...view.suggestions.map(suggestion => buildSuggestion(doc, suggestion)));
      list.hidden = !view.suggestions.length;
    }
    if (empty) {
      const state = emptyView(view.emptyReason, { mode: view.mode, hiddenCount });
      empty.hidden = view.suggestions.length > 0;
      if (emptyTitle) emptyTitle.textContent = state.title;
      if (emptyMessage) emptyMessage.textContent = state.message;
    }
    if (showHidden) {
      showHidden.hidden = hiddenCount < 1;
      showHidden.textContent = hiddenCount === 1 ? 'Show 1 hidden exercise' : `Show ${hiddenCount} hidden exercises`;
    }
    section.hidden = false;
    return true;
  }

  // Owns fetching, the hide list and re-rendering. `onMarkers` lets the
  // catalogue re-label cards and options; `onSelect(slug, version)` opens a
  // suggested exercise through the catalogue's normal selection path.
  // Stored hidden slugs that can never be suggested again (attempted by the
  // member, or no longer in the catalogue) are dropped so they cannot linger
  // behind a hidden "Show n hidden" button. Partner-attempted slugs are kept:
  // they become suggestable again in solo practice.
  function prunableHidden(hidden, view, catalogueSlugs) {
    const known = Array.isArray(catalogueSlugs) && catalogueSlugs.length ? new Set(catalogueSlugs) : null;
    return hidden.filter(slug => view.markers.get(slug)?.me !== true && (!known || known.has(slug)));
  }

  function createController({
    doc, targets, fetchImpl, storage, getUserId, getRoom, getCatalogueSlugs = () => [],
    onMarkers = () => {}, onSelect = () => {},
  } = {}) {
    const state = { enabled: false, epoch: 0, view: null, key: null, pending: null };

    function hiddenList() { return readHidden(storage, getUserId?.()); }

    function publish(view) {
      state.view = view;
      onMarkers(view?.markers || new Map(), view?.partnerCount || 0);
    }

    function clear() {
      state.epoch += 1;
      state.key = null;
      state.pending = null;
      publish(null);
      renderSuggestions(doc, targets, null);
    }

    async function request(path) {
      const response = await fetchImpl(path, { credentials: 'same-origin', cache: 'no-store' });
      const body = await response.json().catch(() => null);
      return { status: response.status, ok: response.ok, body };
    }

    // Unforced refreshes for an unchanged member, room and hide list reuse
    // the shown (or in-flight) result instead of asking the server again.
    function refresh({ force = false } = {}) {
      const userId = getUserId?.();
      if (!state.enabled || !userKey(userId)) { clear(); return Promise.resolve(null); }
      const room = String(getRoom?.() || '');
      const hidden = hiddenList();
      const key = `${userId}|${room}|${hidden.join(',')}`;
      if (!force && state.pending?.key === key) return state.pending.promise;
      if (!force && state.key === key && state.view) return Promise.resolve(state.view);
      const promise = load(key, room, hidden, userId);
      state.pending = { key, promise };
      return promise;
    }

    async function load(key, room, hidden, userId) {
      const epoch = ++state.epoch;
      let result;
      try {
        result = await request(requestPath({ room, hidden }));
        // A room that is not the member's current pair falls back to solo.
        if (ROOM.test(room) && result.status === 404 && epoch === state.epoch) {
          result = await request(requestPath({ hidden }));
        }
      } catch { result = null; }
      if (epoch !== state.epoch) return null;
      state.pending = null;
      const view = result?.ok ? normalizeResponse(result.body) : null;
      let shownKey = key;
      if (view) {
        const kept = prunableHidden(hidden, view, getCatalogueSlugs());
        if (kept.length !== hidden.length) {
          // The server already ignored the pruned slugs, so this view stands.
          writeHidden(storage, userId, kept);
          shownKey = `${userId}|${room}|${kept.join(',')}`;
        }
      }
      state.key = view ? shownKey : null;
      publish(view);
      renderSuggestions(doc, targets, view, { hiddenCount: view?.hiddenCount || 0 });
      return view;
    }

    function focusAfterChange() {
      const next = targets?.list?.querySelector?.('.catalog-suggestion-open')
        || (targets?.showHidden && !targets.showHidden.hidden ? targets.showHidden : null)
        || targets?.title;
      next?.focus?.();
    }

    async function hide(slug) {
      if (!validSlug(slug)) return null;
      hideSlug(storage, getUserId?.(), slug);
      const view = await refresh({ force: true });
      focusAfterChange();
      return view;
    }

    async function showHidden() {
      writeHidden(storage, getUserId?.(), []);
      const view = await refresh({ force: true });
      focusAfterChange();
      return view;
    }

    function handleClick(event) {
      const target = event?.target;
      const hideButton = target?.closest?.('[data-hide-slug]');
      if (hideButton) { void hide(hideButton.getAttribute('data-hide-slug')); return; }
      const open = target?.closest?.('[data-suggestion-slug]');
      if (open) {
        const version = Number(open.getAttribute('data-version'));
        onSelect(open.getAttribute('data-suggestion-slug'), Number.isSafeInteger(version) && version > 0 ? version : null);
        return;
      }
      if (target?.closest?.('[data-suggestions-action="show-hidden"]')) void showHidden();
    }

    targets?.section?.addEventListener?.('click', handleClick);

    return {
      setEnabled(value) {
        state.enabled = value === true;
        if (!state.enabled) clear();
      },
      get enabled() { return state.enabled; },
      refresh,
      hide,
      showHidden,
      handleClick,
      marker(slug) { return state.view?.markers.get(slug) || null; },
      get partnerCount() { return state.view?.partnerCount || 0; },
      get view() { return state.view; },
    };
  }

  root._randori_exercise_suggestions = Object.freeze({
    STORAGE_PREFIX,
    MAX_HIDDEN,
    userKey,
    normalizeHidden,
    readHidden,
    writeHidden,
    hideSlug,
    requestPath,
    normalizeResponse,
    markerLabel,
    optionSuffix,
    headingText,
    noteText,
    emptyView,
    buildSuggestion,
    renderSuggestions,
    createController,
  });
})(typeof window !== 'undefined' ? window : globalThis);
