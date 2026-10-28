// Self-service account deletion in Edit profile (issue #339, ID-81), behind
// ACCOUNT_DELETION_ENABLED. The visual design is provisional (needs-design).
//
// index.html imports this module only for a signed-in member while the server
// advertises the accountDeletion capability, so nothing is downloaded while
// the flag is off. The flow is: recent sign-in (password or Google), type
// DELETE, final confirmation. The server authorizes every step again.
// Rendering uses DOM nodes and textContent only.
export const REAUTH_MARKER_KEY = 'randori-account-deletion-reauth-v1';
export const DELETED_NOTICE_KEY = 'randori-account-deleted-v1';
export const SCHEDULED_NOTICE_KEY = 'randori-account-deletion-scheduled-v1';
export const CONFIRMATION_WORD = 'DELETE';
export const REAUTH_TTL_MS = 10 * 60 * 1000;
// Device preferences that say nothing about the account survive the deletion.
export const KEPT_LOCAL_KEYS = Object.freeze(['randori-theme', 'randori-landing-dismissed']);
const GOOGLE_AUTHORIZATION = 'https://accounts.google.com/o/oauth2/v2/auth';

export const COPY = Object.freeze({
  title: 'Delete account',
  intro: 'Delete your Randori account.',
  // Shown only while the 14-day grace period is on (issue #372).
  graceNote: 'Your account is locked straight away and deleted 14 days after you confirm. You can sign in again any time before then to cancel.',
  deletedTitle: 'What is deleted',
  deleted: Object.freeze([
    'Your name, email address, password and Google sign-in link.',
    'Every signed-in session, on all your devices.',
    'Your availability, email and reminder preferences, and emails still waiting to be sent to you.',
    'Invitations you sent that nobody has used yet.',
    'Your solo practice runs, the code of your pair runs, and the text of your chat messages.',
  ]),
  keptTitle: 'What stays, anonymised',
  kept: Object.freeze([
    'Past pairings, completed sessions, agreed times and recaps stay in your partners’ history, shown as “Deleted member”.',
    'Shared pair workspaces stay with your partner until they expire after 90 days.',
  ]),
  rejoin: 'You can join again later with the same email as a new account. You’ll need a new invitation.',
  open: 'Delete my account…',
  checking: 'Checking whether your account can be deleted…',
  unavailable: 'Account deletion is unavailable right now. Try again in a moment.',
  retry: 'Try again',
  openCircle: 'Go to Circle',
  reauthTitle: 'Confirm it’s you',
  reauthText: 'Deleting your account needs a sign-in from the last 10 minutes.',
  reauthNone: 'No confirmation method is available for this account. Nothing was changed.',
  reauthExpired: 'Your confirmation expired. Confirm it’s you again.',
  reauthGoogleFailed: 'Google confirmation didn’t complete. Nothing was changed. Try again.',
  passwordLabel: 'Current password',
  passwordMissing: 'Enter your current password.',
  passwordWrong: 'That password isn’t right.',
  confirmPassword: 'Confirm password',
  confirmGoogle: 'Confirm with Google',
  googleOpening: 'Opening Google confirmation…',
  googleUnavailable: 'Google confirmation is unavailable right now. Nothing was changed.',
  typeTitle: 'Type DELETE to confirm',
  typeText: 'This makes sure the deletion is what you want.',
  typeLabel: 'Type DELETE',
  typeHint: 'Use capital letters.',
  continue: 'Continue',
  finalTitle: 'Delete your account permanently?',
  finalText: 'Your account is deleted straight away and you are signed out on every device. Your partners keep their history with your name replaced by “Deleted member”.',
  // Final step while the 14-day grace period is on (issue #372).
  finalTextGrace: 'Your account will be locked straight away and deleted in 14 days. You can sign in again before then to cancel it. Your partners keep their history with your name replaced by “Deleted member” once the deletion runs.',
  confirmDelete: 'Delete my account',
  cancel: 'Cancel',
  close: 'Close',
  working: 'Deleting your account…',
  confirming: 'Confirming…',
  rateLimited: 'Too many attempts. Wait a few minutes and try again.',
  signedOut: 'You’re signed out. Sign in again to delete your account.',
  // After a failed or lost answer the server may still have deleted the account.
  unconfirmed: 'We couldn’t confirm whether your account was deleted. Refresh the page to check.',
  blockedTitle: 'Your account can’t be deleted yet',
});

/** Guidance for the last-owner and last-admin rules, or null. */
export function blockedMessage(code, circles = []) {
  if (code === 'demo_account') return 'Demo accounts are managed by the app admins and can’t be deleted here.';
  if (code === 'last_admin') {
    return 'You’re the only app admin. Make another member an app admin on the Circle page first.';
  }
  if (code !== 'last_owner') return null;
  const named = (Array.isArray(circles) ? circles : []).filter(circle => typeof circle?.name === 'string');
  const subject = named.length ? named.map(circle => circle.name.trim() || 'your circle').join(', ') : 'a circle';
  const canArchive = named.length > 0 && named.every(circle => circle.is_primary !== true);
  return `You’re the only owner of ${subject}. Make another member an owner on the Circle page`
    + `${canArchive ? ', or archive the circle,' : ''} before deleting your account.`;
}

/** Removes everything Randori keeps about the account in this browser. */
export function clearDeviceData({ local, session } = {}) {
  for (const store of [local, session]) {
    if (!store) continue;
    const keys = [];
    for (let index = 0; index < store.length; index += 1) {
      const key = store.key(index);
      if (String(key).startsWith('randori-') && !(store === local && KEPT_LOCAL_KEYS.includes(key))) keys.push(key);
    }
    for (const key of keys) store.removeItem(key);
  }
}

/** True once for a Google step-up this dialog started for the same member within ten minutes. */
export function readReauthMarker(session, { userId, now }) {
  let marker = null;
  try {
    marker = JSON.parse(session.getItem(REAUTH_MARKER_KEY) || 'null');
    session.removeItem(REAUTH_MARKER_KEY);
  } catch { marker = null; }
  const created = Number(marker?.created_at);
  return marker?.v === 1 && marker.actor_id === userId && Number.isFinite(created)
    && created <= now + 30_000 && now - created <= REAUTH_TTL_MS;
}

function node(doc, tag, { className = '', text = null, id = '', testid = '' } = {}) {
  const element = doc.createElement(tag);
  if (className) element.className = className;
  if (id) element.id = id;
  if (testid) element.dataset.testid = testid;
  if (text !== null) element.textContent = text;
  return element;
}

function button(doc, text, { className = 'btn', id = '', testid = '' } = {}) {
  const element = node(doc, 'button', { className, text, id, testid });
  element.type = 'button';
  return element;
}

function bulletList(doc, title, items) {
  const block = node(doc, 'div', { className: 'recovery-steps' });
  const entries = node(doc, 'ul');
  entries.append(...items.map(item => node(doc, 'li', { text: item })));
  block.append(node(doc, 'h3', { text: title }), entries);
  return block;
}

function liveStatus(element) {
  element.setAttribute('role', 'status');
  element.setAttribute('aria-live', 'polite');
  return element;
}

function buildSection(doc, section) {
  section.setAttribute('aria-labelledby', 'accountDeletionTitle');
  const head = node(doc, 'div', { className: 'card-h' });
  head.append(node(doc, 'h2', { id: 'accountDeletionTitle', text: COPY.title }),
    node(doc, 'p', { className: 'onboarding-lead', text: COPY.intro }));
  const blocked = node(doc, 'div', { className: 'rc-banner rc-banner--warning', id: 'accountDeletionBlocked', testid: 'account-deletion-blocked' });
  blocked.setAttribute('role', 'status');
  blocked.hidden = true;
  const graceNote = node(doc, 'p', { className: 'field-help', id: 'accountDeletionGraceNote', testid: 'account-deletion-grace-note', text: COPY.graceNote });
  graceNote.hidden = true;
  const status = liveStatus(node(doc, 'p', { className: 'small request-status', id: 'accountDeletionStatus', testid: 'account-deletion-status' }));
  const open = button(doc, COPY.open, { className: 'btn danger', id: 'accountDeletionOpen', testid: 'account-deletion-open' });
  const circle = button(doc, COPY.openCircle, { className: 'btn secondary', id: 'accountDeletionCircle' });
  const retry = button(doc, COPY.retry, { className: 'btn secondary', id: 'accountDeletionRetry' });
  circle.hidden = true;
  retry.hidden = true;
  const actions = node(doc, 'div', { className: 'onboarding-actions' });
  actions.append(retry, circle, open);
  const body = node(doc, 'div', { className: 'card-b onboarding-body' });
  body.append(bulletList(doc, COPY.deletedTitle, COPY.deleted), bulletList(doc, COPY.keptTitle, COPY.kept),
    node(doc, 'p', { className: 'field-help', text: COPY.rejoin }), graceNote, blocked, status, actions);
  section.replaceChildren(head, body);
  return { blocked, graceNote, status, open, circle, retry };
}

function buildDialog(doc) {
  const overlay = node(doc, 'div', { className: 'overlay', id: 'accountDeletionOverlay' });
  overlay.setAttribute('aria-hidden', 'true');
  const dialog = node(doc, 'div', { className: 'modal rc-dialog', id: 'accountDeletionDialog', testid: 'account-deletion-dialog' });
  dialog.setAttribute('role', 'dialog');
  dialog.setAttribute('aria-modal', 'true');
  dialog.setAttribute('aria-labelledby', 'accountDeletionDialogTitle');
  dialog.setAttribute('aria-describedby', 'accountDeletionDialogText');
  dialog.tabIndex = -1;
  const title = node(doc, 'h3', { id: 'accountDeletionDialogTitle' });
  const text = node(doc, 'p', { className: 'dialog-text', id: 'accountDeletionDialogText' });
  const content = node(doc, 'div', { className: 'onboarding-body' });
  const status = liveStatus(node(doc, 'p', { className: 'small request-status', id: 'accountDeletionDialogStatus', testid: 'account-deletion-dialog-status' }));
  const actions = node(doc, 'div', { className: 'dialog-actions' });
  dialog.append(title, text, content, status, actions);
  overlay.append(dialog);
  doc.body.append(overlay);
  return { overlay, dialog, title, text, content, status, actions };
}

function field(doc, { id, label, type, hint = '', autocomplete }) {
  const wrap = node(doc, 'div', { className: 'auth-field' });
  const labelNode = node(doc, 'label', { text: label });
  labelNode.htmlFor = id;
  const input = node(doc, 'input', { className: 'input', id });
  input.type = type;
  input.autocomplete = autocomplete;
  input.spellcheck = false;
  input.setAttribute('aria-describedby', `${hint ? `${id}Hint ` : ''}${id}Error`);
  const error = node(doc, 'p', { className: 'auth-field-error', id: `${id}Error` });
  error.hidden = true;
  wrap.append(labelNode, input);
  if (hint) wrap.append(node(doc, 'p', { className: 'field-help', id: `${id}Hint`, text: hint }));
  wrap.append(error);
  const showError = message => {
    error.textContent = message;
    error.hidden = false;
    input.setAttribute('aria-invalid', 'true');
    input.focus();
  };
  return { wrap, input, showError };
}

export function mountAccountDeletion({ doc, host }) {
  const section = doc.getElementById('accountDeletion');
  if (!section) return null;
  const view = buildSection(doc, section);
  const ui = buildDialog(doc);
  const state = {
    userId: null, eligibility: null, loading: null, generation: 0, step: 'closed',
    closeDialog: null, busy: false, methods: null, controls: [], password: null, confirm: null,
  };

  function renderEligibility() {
    const eligibility = state.eligibility;
    const message = eligibility?.eligible === false ? blockedMessage(eligibility.code, eligibility.circles) : null;
    view.blocked.textContent = message || '';
    view.blocked.hidden = !message;
    view.graceNote.hidden = eligibility?.grace !== true;
    view.circle.hidden = !message || eligibility.code === 'demo_account';
    view.retry.hidden = eligibility?.failed !== true;
    view.open.disabled = eligibility?.eligible !== true;
    view.status.textContent = eligibility === null ? COPY.checking : (eligibility.failed ? COPY.unavailable : '');
  }

  function loadEligibility() {
    const userId = state.userId;
    if (userId === null) return Promise.resolve();
    state.eligibility = null;
    renderEligibility();
    const loading = host.api('/api/auth/account/delete', { method: 'GET' }).then(
      result => (result?.ok === true && typeof result.eligible === 'boolean'
        ? { eligible: result.eligible, code: result.code, circles: result.circles, grace: result.grace === true }
        : { failed: true }),
      () => ({ failed: true }),
    ).then(eligibility => {
      if (state.userId !== userId || state.loading !== loading) return;
      state.loading = null;
      state.eligibility = eligibility;
      renderEligibility();
    });
    state.loading = loading;
    return loading;
  }

  const current = generation => state.generation === generation && state.step !== 'closed';

  function render({ title, text, content = [], buttons = [], status = '', focus = ui.dialog }) {
    ui.title.textContent = title;
    ui.text.textContent = text;
    ui.content.replaceChildren(...content.map(item => item.wrap));
    ui.content.hidden = content.length === 0;
    ui.actions.replaceChildren(...buttons);
    ui.status.textContent = status;
    state.controls = [...content.map(item => item.input), ...buttons];
    focus.focus();
  }

  function setBusy(busy, status) {
    state.busy = busy;
    for (const control of state.controls) control.disabled = busy;
    ui.dialog.setAttribute('aria-busy', busy ? 'true' : 'false');
    ui.status.textContent = status;
  }

  function cancelButton() {
    const cancel = button(doc, COPY.cancel, { className: 'btn secondary', id: 'accountDeletionCancel' });
    cancel.addEventListener('click', () => close());
    return cancel;
  }

  function showUnavailable(generation) {
    state.step = 'unavailable';
    const retry = button(doc, COPY.retry, { id: 'accountDeletionDialogRetry' });
    retry.addEventListener('click', () => { void checkRecentAuth(generation); });
    render({ title: COPY.reauthTitle, text: COPY.reauthText, buttons: [cancelButton(), retry], status: COPY.unavailable, focus: retry });
  }

  function showReauth(message) {
    state.step = 'reauth';
    const { password, google } = state.methods;
    const buttons = [cancelButton()];
    const content = [];
    let focus = buttons[0];
    if (google) {
      const start = button(doc, COPY.confirmGoogle, { className: password ? 'btn secondary' : 'btn', id: 'accountDeletionGoogle' });
      start.addEventListener('click', () => { void confirmGoogle(); });
      buttons.push(start);
      focus = start;
    }
    state.password = null;
    if (password) {
      state.password = field(doc, { id: 'accountDeletionPassword', label: COPY.passwordLabel, type: 'password', autocomplete: 'current-password' });
      state.password.input.maxLength = 72;
      const submit = button(doc, COPY.confirmPassword, { id: 'accountDeletionConfirmPassword' });
      submit.addEventListener('click', () => { void confirmPassword(); });
      content.push(state.password);
      buttons.push(submit);
      focus = state.password.input;
    }
    render({ title: COPY.reauthTitle, text: password || google ? COPY.reauthText : COPY.reauthNone, content, buttons, status: message, focus });
  }

  function showType() {
    state.step = 'type';
    const confirm = field(doc, { id: 'accountDeletionConfirm', label: COPY.typeLabel, type: 'text', hint: COPY.typeHint, autocomplete: 'off' });
    const next = button(doc, COPY.continue, { id: 'accountDeletionContinue' });
    next.disabled = true;
    confirm.input.addEventListener('input', () => { next.disabled = confirm.input.value !== CONFIRMATION_WORD; });
    next.addEventListener('click', () => { if (confirm.input.value === CONFIRMATION_WORD) showFinal(); });
    state.confirm = confirm;
    render({ title: COPY.typeTitle, text: COPY.typeText, content: [confirm], buttons: [cancelButton(), next], focus: confirm.input });
  }

  function showFinal(message = '') {
    state.step = 'final';
    const remove = button(doc, COPY.confirmDelete, { className: 'btn danger', id: 'accountDeletionConfirmDelete', testid: 'account-deletion-confirm' });
    remove.addEventListener('click', () => { void submitDeletion(); });
    const cancel = cancelButton();
    // Cancel takes focus first: this is the irreversible step.
    render({ title: COPY.finalTitle, text: state.eligibility?.grace === true ? COPY.finalTextGrace : COPY.finalText, buttons: [cancel, remove], status: message, focus: cancel });
  }

  function showBlocked(code, circles) {
    state.step = 'blocked';
    state.eligibility = { eligible: false, code, circles };
    renderEligibility();
    const done = button(doc, COPY.close, { className: 'btn secondary', id: 'accountDeletionClose' });
    done.addEventListener('click', () => close());
    render({ title: COPY.blockedTitle, text: blockedMessage(code, circles), buttons: [done], focus: done });
  }

  async function checkRecentAuth(generation, message = '') {
    state.step = 'checking';
    render({ title: COPY.reauthTitle, text: COPY.reauthText, buttons: [cancelButton()], status: COPY.confirming });
    let result = null;
    try { result = await host.api('/api/auth/recent-auth', { method: 'GET' }); } catch {}
    if (!current(generation)) return;
    if (result?.ok !== true) { showUnavailable(generation); return; }
    state.methods = { password: result.methods?.password === true, google: result.methods?.google === true };
    if (result.recentAuth?.ok === true) showType();
    else showReauth(message);
  }

  async function confirmPassword() {
    const generation = state.generation;
    const password = state.password;
    if (state.busy) return;
    if (!password.input.value) { password.showError(COPY.passwordMissing); return; }
    setBusy(true, COPY.confirming);
    try {
      await host.api('/api/auth/recent-auth', { method: 'POST', body: { password: password.input.value } });
      if (!current(generation)) return;
      setBusy(false, '');
      showType();
    } catch (error) {
      if (!current(generation)) return;
      setBusy(false, '');
      password.input.value = '';
      const status = Number(error?.http_status);
      if (status === 401) password.showError(COPY.passwordWrong);
      else ui.status.textContent = status === 429 ? COPY.rateLimited : COPY.unavailable;
    }
  }

  async function confirmGoogle() {
    const generation = state.generation;
    if (state.busy) return;
    setBusy(true, COPY.googleOpening);
    try {
      host.storage.session.setItem(REAUTH_MARKER_KEY, JSON.stringify({ v: 1, actor_id: state.userId, created_at: host.now() }));
      const result = await host.api('/api/auth/google/reauth/start', { method: 'POST', body: {} });
      const url = new URL(String(result?.authorizationUrl || ''));
      if (`${url.origin}${url.pathname}` !== GOOGLE_AUTHORIZATION || url.username || url.password) throw new Error('unexpected');
      if (!current(generation)) throw new Error('closed');
      host.navigate(url.href);
    } catch (error) {
      try { host.storage.session.removeItem(REAUTH_MARKER_KEY); } catch {}
      if (!current(generation)) return;
      setBusy(false, Number(error?.http_status) === 429 ? COPY.rateLimited : COPY.googleUnavailable);
    }
  }

  async function finish(result = {}) {
    state.step = 'done';
    const closeDialog = state.closeDialog;
    state.closeDialog = null;
    closeDialog?.();
    try { await host.signOutLocally(); } catch {}
    clearDeviceData(host.storage);
    try {
      if (result?.status === 'pending_deletion' && typeof result?.scheduled_for === 'string') {
        host.storage.session.setItem(SCHEDULED_NOTICE_KEY, result.scheduled_for);
      } else {
        host.storage.session.setItem(DELETED_NOTICE_KEY, '1');
      }
    } catch {}
    host.reload('/');
  }

  async function submitDeletion() {
    if (state.busy) return;
    const generation = state.generation;
    state.step = 'deleting';
    setBusy(true, COPY.working);
    try {
      const result = await host.api('/api/auth/account/delete', { method: 'POST', body: { confirm: CONFIRMATION_WORD } });
      if (result?.ok === true) { await finish(result); return; }
      throw Object.assign(new Error('unexpected'), { http_status: 503 });
    } catch (error) {
      setBusy(false, '');
      const code = String(error?.code || '');
      const status = Number(error?.http_status);
      if (code === 'recent_auth_required') void checkRecentAuth(generation, COPY.reauthExpired);
      else if (['last_owner', 'last_admin', 'demo_account'].includes(code)) showBlocked(code, error.circles);
      // A concurrent request already scheduled the deletion: land on the
      // same scheduled notice as a fresh request.
      else if (code === 'already_pending' && typeof error?.scheduled_for === 'string') {
        await finish({ status: 'pending_deletion', scheduled_for: error.scheduled_for });
      }
      else showFinal(status === 401 ? COPY.signedOut : (status === 429 ? COPY.rateLimited : COPY.unconfirmed));
    }
  }

  function open({ step = null, message = '' } = {}) {
    if (state.userId === null || state.step !== 'closed') return false;
    state.generation += 1;
    const generation = state.generation;
    state.step = 'opening';
    state.busy = false;
    state.closeDialog = host.openDialog(ui.overlay, {
      onCancel: () => close(),
      onEnter: () => {
        if (state.step === 'reauth' && state.password) void confirmPassword();
        else if (state.step === 'type' && state.confirm.input.value === CONFIRMATION_WORD) showFinal();
      },
    });
    if (step === 'type') showType();
    else void checkRecentAuth(generation, message);
    return true;
  }

  // A request that is deleting the account cannot be abandoned half-way.
  function close() {
    if (['closed', 'deleting', 'done'].includes(state.step)) return;
    state.generation += 1;
    state.step = 'closed';
    state.busy = false;
    state.password = null;
    state.confirm = null;
    state.controls = [];
    ui.content.replaceChildren();
    ui.actions.replaceChildren();
    const closeDialog = state.closeDialog;
    state.closeDialog = null;
    closeDialog?.();
  }

  // Back from Google: index.html hands over the OAuth result once. The server
  // decides whether the proof is recent; the marker only says this dialog asked.
  function resume() {
    const result = host.takeReauthResult();
    if (!result || !readReauthMarker(host.storage.session, { userId: state.userId, now: host.now() })) return false;
    return open({ message: result === 'success' ? '' : COPY.reauthGoogleFailed });
  }

  function sync() {
    const userId = host.enabled() ? host.userId() : null;
    if (userId !== state.userId) {
      close();
      state.userId = userId;
      state.eligibility = null;
      state.loading = null;
    }
    section.hidden = userId === null;
    if (userId === null) return;
    if (state.eligibility === null && state.loading === null) void loadEligibility();
    resume();
  }

  view.open.addEventListener('click', () => { open(); });
  view.retry.addEventListener('click', () => { void loadEligibility(); });
  view.circle.addEventListener('click', () => { host.openCircle(); });

  return {
    sync,
    open,
    close,
    refresh: loadEligibility,
    get state() { return { step: state.step, userId: state.userId, eligibility: state.eligibility, busy: state.busy }; },
  };
}
