import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

// The browser loads assets/auth-dialog.js as a classic script that installs
// window._randori_auth_ui. Importing it here runs the same file in Node.
await import('../../assets/auth-dialog.js');
const ui = globalThis._randori_auth_ui;

const html = readFileSync(new URL('../../index.html', import.meta.url), 'utf8');

test('the dialog helpers load before the auth layer and expose a frozen API', () => {
  assert.ok(Object.isFrozen(ui));
  const helper = html.indexOf('<script src="/assets/auth-dialog.js"></script>');
  const authLayer = html.indexOf('// ---------- auth layer ----------');
  assert.ok(helper > 0 && helper < authLayer, 'auth-dialog.js must load before the auth layer');
  assert.equal(ui.PASSWORD_MIN_BYTES, 10);
  assert.equal(ui.PASSWORD_MAX_BYTES, 72);
  assert.equal(ui.RECENT_AUTH_MINUTES, 10);
});

test('dialog markup keeps every test hook and accessible dialog semantics', () => {
  for (const id of ['authOverlay', 'authDialog', 'authForm', 'authTitle', 'authDescription', 'authCapabilityStatus',
    'authErr', 'authGoogle', 'authGoogleRetry', 'authDivider', 'authPasswordFields', 'authEmail', 'authNameField',
    'authName', 'authPasswordField', 'authPass', 'authActivationPending', 'authActivationResend', 'authModeSwitch',
    'authForgot', 'authCancel', 'authSignup', 'authSignin', 'authResetRequest', 'identityOverlay', 'identityDialog',
    'identityTitle', 'identityDescription', 'identityStatus', 'identityRecent', 'identityRecentHint',
    'identityPasswordConfirmField', 'identityPasswordConfirm', 'identityConfirmPassword', 'identityConfirmGoogle',
    'identityGoogleCard', 'identityGoogleState', 'identityGoogleAction', 'identityGoogleHelp', 'identityPasswordCard',
    'identityPasswordState', 'identityPasswordAction', 'identityPasswordAdd', 'identityNewPassword',
    'identityNewPasswordConfirm', 'identityPasswordHelp', 'identityClose', 'confirmOverlay', 'confirmTitle', 'confirmMsg',
    'confirmOk', 'confirmCancel', 'promptOverlay', 'promptTitle', 'promptInput', 'promptOk', 'promptCancel']) {
    assert.equal(html.split(`id="${id}"`).length - 1, 1, `#${id} must exist exactly once`);
  }
  assert.match(html, /id="authDialog"[^>]*role="dialog"[^>]*aria-modal="true"[^>]*aria-labelledby="authTitle"/);
  assert.match(html, /id="identityDialog"[^>]*role="dialog"[^>]*aria-modal="true"[^>]*aria-labelledby="identityTitle"/);
  assert.match(html, /id="confirmOverlay"[^]*?role="alertdialog"[^>]*aria-labelledby="confirmTitle"/);
  assert.match(html, /id="authPassToggle"[^>]*aria-controls="authPass"[^>]*aria-pressed="false"[^>]*aria-label="Show password"/);
  assert.match(html, /data-testid="activation-pending"/);
  assert.match(html, /data-testid="identity-status"/);
  // Every inline field error is wired to its input.
  for (const [input, error] of [['authEmail', 'authEmailError'], ['authName', 'authNameError'], ['authPass', 'authPassError']]) {
    assert.match(html, new RegExp(`id="${input}"[^>]*aria-describedby="[^"]*${error}`));
  }
  // The dialog region must not use inline style colors.
  const start = html.indexOf('<!-- ---------- WP-A dialogs');
  const end = html.indexOf('<script src="/assets/auth-dialog.js"></script>');
  assert.doesNotMatch(html.slice(start, end), /style="/);
});

test('the dialog CSS honours the sheet breakpoint and reduced motion contract', () => {
  assert.match(html, /@media\(max-width:599px\)\{\n {2}\.auth-overlay,\.identity-overlay/);
  assert.match(html, /@media\(prefers-reduced-motion:reduce\)\{/);
  assert.match(html, /\.auth-status\[data-routine="true"\]\{position:absolute!important/);
});

test('validateAuthFields reports every problem inline and focuses the first', () => {
  const empty = ui.validateAuthFields({ mode: 'signup', email: '', emailValid: false, name: '', password: '' });
  assert.equal(empty.ok, false);
  assert.equal(empty.first, 'email');
  assert.deepEqual(empty.errors, {
    email: 'Enter your email address.',
    name: 'Enter a display name with 2–32 characters.',
    password: 'Choose a password.',
  });
  const invalidEmail = ui.validateAuthFields({ mode: 'signin', email: 'nope', emailValid: false, password: 'x' });
  assert.deepEqual(invalidEmail.errors, { email: 'Enter a valid email address.' });
  const noPassword = ui.validateAuthFields({ mode: 'signin', email: 'a@b.test', emailValid: true, password: '' });
  assert.deepEqual(noPassword, { ok: false, errors: { password: 'Enter your password.' }, first: 'password' });
  const short = ui.validateAuthFields({ mode: 'signup', email: 'a@b.test', emailValid: true, name: 'Al', password: 'short' });
  assert.deepEqual(short.errors, { password: 'Use at least 10 characters.' });
  const long = ui.validateAuthFields({ mode: 'signup', email: 'a@b.test', emailValid: true, name: 'Al', password: 'x'.repeat(73) });
  assert.deepEqual(long.errors, { password: 'Use 72 characters or fewer.' });
  const emoji = ui.validateAuthFields({ mode: 'signup', email: 'a@b.test', emailValid: true, name: 'Al', password: '😀'.repeat(19) });
  assert.match(emoji.errors.password, /Emoji and some symbols/);
  const longName = ui.validateAuthFields({ mode: 'signup', email: 'a@b.test', emailValid: true, name: 'n'.repeat(33), password: 'long enough pw' });
  assert.equal(longName.first, 'name');
});

test('validateAuthFields returns the exact request bodies the endpoints expect', () => {
  assert.deepEqual(
    ui.validateAuthFields({ mode: 'signup', email: '  LOCAL.User@Example.test ', emailValid: true, name: ' Local User ', password: 'correct horse battery' }),
    { ok: true, body: { email: 'local.user@example.test', password: 'correct horse battery', name: 'Local User' } },
  );
  assert.deepEqual(
    ui.validateAuthFields({ mode: 'signin', email: 'MEMBER@example.test', emailValid: true, name: 'ignored', password: ' p ' }),
    { ok: true, body: { email: 'member@example.test', password: ' p ' } },
  );
  assert.deepEqual(
    ui.validateAuthFields({ mode: 'reset', email: 'MEMBER@example.test', emailValid: true, password: '' }),
    { ok: true, body: { email: 'member@example.test' } },
  );
  // Unknown modes behave like sign-in; signin never applies the signup length rule.
  assert.deepEqual(
    ui.validateAuthFields({ mode: 'weird', email: 'a@b.test', emailValid: true, password: 'x' }),
    { ok: true, body: { email: 'a@b.test', password: 'x' } },
  );
  assert.equal(ui.validateAuthFields().ok, false);
});

test('fieldProblem validates on blur without nagging about empty fields', () => {
  assert.equal(ui.fieldProblem('email', { mode: 'signin', value: '', valid: false }), '');
  assert.equal(ui.fieldProblem('email', { mode: 'signin', value: 'x', valid: false }), 'Enter a valid email address.');
  assert.equal(ui.fieldProblem('email', { mode: 'signin', value: 'a@b.test', valid: true }), '');
  assert.equal(ui.fieldProblem('name', { mode: 'signup', value: 'A' }), 'Enter a display name with 2–32 characters.');
  assert.equal(ui.fieldProblem('name', { mode: 'signin', value: 'A' }), '');
  assert.equal(ui.fieldProblem('password', { mode: 'signup', value: 'short' }), 'Use at least 10 characters.');
  assert.equal(ui.fieldProblem('password', { mode: 'signin', value: 'short' }), '');
  assert.equal(ui.fieldProblem('other', { value: 'x' }), '');
  assert.equal(ui.fieldProblem('email'), '');
});

test('newPasswordProblem checks policy before the confirmation', () => {
  assert.equal(ui.newPasswordProblem('', ''), 'Choose a new password.');
  assert.equal(ui.newPasswordProblem('short', 'short'), 'Use at least 10 characters.');
  assert.equal(ui.newPasswordProblem('long enough pw', 'different pw!'), 'Passwords do not match.');
  assert.equal(ui.newPasswordProblem('long enough pw', 'long enough pw'), '');
  assert.equal(ui.utf8Length('é'), 2);
  assert.equal(ui.utf8Length(null), 0);
});

test('authFailureMessage turns every server error into human copy', () => {
  const cases = [
    [{ error: 'invalid credentials' }, 'signin', 'Email or password is incorrect.'],
    [{ error: 'email already registered' }, 'signup', 'That email already has an account. Sign in instead.'],
    [{ error: 'invitation unavailable or does not match this email' }, 'signup', /address the invitation was sent to/],
    [{ error: 'invitation unavailable' }, 'signup', /changed or expired/],
    [{ error: 'invitation context changed' }, 'signup', /changed or expired/],
    [{ error: 'a valid local invitation is required' }, 'signup', /changed or expired/],
    [{ error: 'active circle membership required' }, 'signin', /circle membership is no longer active/],
    [{ error: 'valid email required' }, 'reset', 'Enter a valid email address.'],
    [{ error: 'display name must be 2-32 chars' }, 'signup', /2–32 characters/],
    [{ error: 'password must be 10-72 UTF-8 bytes' }, 'signup', 'Use a password with 10–72 characters.'],
    [{ error: 'password required' }, 'signin', 'Use a password with 10–72 characters.'],
    [{ error: 'password signup is disabled during the private beta; use Google sign-in' }, 'signup', /with Google/],
    [{ error: 'private beta signup is invite-only' }, 'signup', /invite-only/],
    [{ error: 'private beta signup requires a Google invitation' }, 'signup', /invite-only/],
    [{ error: 'authentication required' }, 'signin', /session ended/],
    [{ error: 'too many login attempts; try again later' }, 'signin', /Too many sign-in attempts/],
    [{ error: 'too many signup attempts; try again later' }, 'signup', /Too many sign-up attempts/],
    [{ error: 'too many reset requests; try again later' }, 'reset', /Too many reset requests/],
    [{ error: 'too many activation requests; try again later' }, 'activation', /verification emails/],
    [{ http_status: 429 }, 'signin', /Too many sign-in attempts/],
    [{ error: 'signup temporarily unavailable' }, 'signup', 'Account creation is temporarily unavailable. Try again.'],
    [{ error: 'login temporarily unavailable' }, 'signin', 'Sign in is temporarily unavailable. Try again.'],
    [{ error: 'password reset is unavailable' }, 'reset', 'Password recovery is temporarily unavailable. Try again.'],
    [{ error: 'email activation temporarily unavailable' }, 'activation', /Verification email is temporarily unavailable/],
    [{ http_status: 502 }, 'signin', 'Sign in is temporarily unavailable. Try again.'],
    [{ error: 'cross-origin mutation rejected' }, 'signin', /blocked for your security/],
    [{ error: 'same-origin request required' }, 'signup', /blocked for your security/],
    [Object.assign(new TypeError('Failed to fetch')), 'signin', /couldn't reach Randori/],
    [{ error: 'something internal and odd' }, 'signin', "Sign in didn't work. Try again."],
    [{}, 'signup', "Account creation didn't work. Try again."],
    [null, 'reset', "Password recovery didn't work. Try again."],
    ['', 'activation', "We couldn't send another verification email. Try again."],
    [{ message: 'invalid credentials' }, undefined, 'Email or password is incorrect.'],
  ];
  for (const [error, mode, expected] of cases) {
    const message = ui.authFailureMessage(error, mode);
    if (expected instanceof RegExp) assert.match(message, expected, JSON.stringify(error));
    else assert.equal(message, expected, JSON.stringify(error));
    assert.doesNotMatch(message, /UTF-8|undefined|null|\[object/);
  }
  // A plain TypeError that is not a network failure is not mistaken for one.
  assert.equal(ui.authFailureMessage(new TypeError('x is not a function'), 'signin'), "Sign in didn't work. Try again.");
});

test('googleFailure explains every callback code and when password sign-in is the way on', () => {
  const codes = ['access_denied', 'provider_denied', 'invalid_state', 'missing_code', 'provider_unavailable',
    'identity_invalid', 'provider_response_invalid', 'account_exists_use_password', 'identity_mismatch', 'private_beta',
    'reauth_required', 'db_error', 'session_error'];
  const seen = new Set();
  for (const code of codes) {
    const { message, preferPassword } = ui.googleFailure(code);
    assert.ok(message.length > 20, code);
    assert.doesNotMatch(message, /_/, `${code} must not leak the raw code`);
    assert.equal(preferPassword, ['account_exists_use_password', 'identity_mismatch'].includes(code), code);
    seen.add(message);
  }
  assert.equal(ui.googleFailure('provider_unavailable').message, 'Google sign-in is temporarily unavailable. Please try again.');
  assert.match(ui.googleFailure('private_beta').message, /invite-only/);
  assert.match(ui.googleFailure('invalid_state').message, /Start again/);
  assert.match(ui.googleFailure('identity_invalid').message, /couldn't verify/);
  assert.match(ui.googleFailure('account_exists_use_password').message, /email and password/);
  assert.deepEqual(ui.googleFailure('nonsense'), { message: 'Google sign-in did not complete. Please try again.', preferPassword: false });
  assert.deepEqual(ui.googleFailure(undefined), ui.googleFailure('nonsense'));
  assert.ok(seen.size >= 11);
});

test('identityErrorMessage covers account security failures without jargon', () => {
  const cases = [
    [{ status: 'recent_auth_required' }, /last 10 minutes/],
    [{ error: 'recent authentication required' }, /confirm it's you again/],
    [{ error: 'recent authentication temporarily unavailable' }, /temporarily unavailable/],
    [{ status: 'provider_in_use' }, /already belongs to another Randori account/],
    [{ status: 'provider_already_linked' }, /different Google account linked/],
    [{ status: 'final_credential' }, /only sign-in method/],
    [{ error: 'add a password before removing Google sign-in' }, /only sign-in method/],
    [{ status: 'verified_control_required' }, /Confirm with Google first/],
    [{ error: 'confirm your linked Google account before adding a password' }, /Confirm with Google first/],
    [{ status: 'session_changed' }, /session changed/],
    [{ error: 'authentication required' }, /session changed/],
    [{ error: 'invalid credentials' }, "That password isn't right. Try again."],
    [{ error: 'password required' }, 'Enter your current password.'],
    [{ error: 'too many confirmation attempts; try again later' }, /Too many confirmation attempts/],
    [{ error: 'too many identity changes; try again later' }, /Too many changes/],
    [{ status: 'unavailable' }, /temporarily unavailable/],
    [{ code: 'weird' }, /temporarily unavailable/],
    [null, /temporarily unavailable/],
  ];
  for (const [error, expected] of cases) {
    const message = ui.identityErrorMessage(error);
    if (expected instanceof RegExp) assert.match(message, expected, JSON.stringify(error));
    else assert.equal(message, expected);
  }
});

test('googleConfirmationStartFailure keeps lifecycle reasons stable', () => {
  assert.deepEqual(ui.googleConfirmationStartFailure({ error: 'too many confirmation attempts' }),
    { reason: 'google_rate_limited', message: 'Too many Google confirmation attempts. Try again later.' });
  assert.equal(ui.googleConfirmationStartFailure({ message: 'authentication required' }).reason, 'session_changed');
  const lifecycle = ui.googleConfirmationStartFailure(new Error('boom'), { lifecycle: true });
  assert.equal(lifecycle.reason, 'google_unavailable');
  assert.match(lifecycle.message, /No circle change was made\.$/);
  assert.equal(ui.googleConfirmationStartFailure(null).reason, 'google_unavailable');
});

test('authStatus keeps tested copy and hides only routine restatements', () => {
  const caps = (extra = {}) => ({ passwordLogin: true, passwordSignup: false, googleOAuth: false, registrationMode: 'private_beta', ...extra });
  assert.deepEqual(ui.authStatus({ loaded: false }), { text: 'Checking sign-in options…', tone: 'loading', routine: false });
  assert.match(ui.authStatus({ loaded: true, failed: true }).text, /could not be verified/);
  assert.match(ui.authStatus({ loaded: true, mode: 'reset', capabilities: caps() }).text, /same message/);
  assert.equal(ui.authStatus({ loaded: true, mode: 'signup', requiresInvite: true, hasInvite: false, capabilities: caps() }).tone, 'warning');
  assert.match(ui.authStatus({ loaded: true, mode: 'signup', requiresInvite: true, hasInvite: true, inviteReady: true,
    capabilities: caps({ passwordSignup: true, registrationMode: 'verified_invite' }) }).text, /activates only after/);
  assert.match(ui.authStatus({ loaded: true, mode: 'signup', requiresInvite: true, hasInvite: true, inviteReady: false,
    capabilities: caps({ passwordSignup: true, registrationMode: 'verified_invite' }) }).text, /valid invitation is required/);
  assert.match(ui.authStatus({ loaded: true, mode: 'signup', requiresInvite: true, hasInvite: true, inviteReady: true,
    capabilities: caps({ passwordSignup: true, registrationMode: 'local_invite' }) }).text, /verified invitation/);
  assert.match(ui.authStatus({ loaded: true, mode: 'signup', requiresInvite: true, hasInvite: true, inviteReady: false,
    capabilities: caps({ passwordSignup: true, registrationMode: 'local_invite' }) }).text, /valid local invitation/);
  assert.match(ui.authStatus({ loaded: true, mode: 'signup', capabilities: caps({ passwordSignup: true, registrationMode: 'local_open' }) }).text,
    /Create a local account/);
  assert.equal(ui.authStatus({ loaded: true, mode: 'signup', requiresInvite: true, hasInvite: true,
    capabilities: caps({ passwordSignup: true }) }).routine, true);
  assert.match(ui.authStatus({ loaded: true, mode: 'signup', requiresInvite: true, hasInvite: true,
    capabilities: caps({ googleOAuth: true }) }).text, /verified Google account/);
  assert.deepEqual(ui.authStatus({ loaded: true, mode: 'signin', capabilities: caps({ googleOAuth: true }) }),
    { text: 'Use your existing password or Google account.', tone: 'info', routine: true });
  assert.equal(ui.authStatus({ loaded: true, capabilities: caps({ passwordLogin: false, googleOAuth: true }) }).text,
    'Continue with your verified Google account.');
  assert.equal(ui.authStatus({ loaded: true, capabilities: caps() }).text, 'Sign in with your existing email and password.');
  assert.deepEqual(ui.authStatus({ loaded: true, capabilities: caps({ passwordLogin: false }) }),
    { text: 'No sign-in method is currently available.', tone: 'warning', routine: false });
  assert.equal(ui.authStatus().text, 'Checking sign-in options…');
});

test('authCopy keeps the dialog names tests and screen readers rely on', () => {
  assert.equal(ui.authCopy('signin').title, 'Sign in to Randori');
  assert.equal(ui.authCopy('signup').title, 'Join Randori Circle');
  assert.equal(ui.authCopy('reset').title, 'Reset your password');
  assert.equal(ui.authCopy('signup', { busy: true }).submit, 'Creating account…');
  assert.equal(ui.authCopy('signup', { registrationMode: 'verified_invite' }).submit, 'Send verification email');
  assert.equal(ui.authCopy('signup', { registrationMode: 'verified_invite', busy: true }).submit, 'Sending link…');
  assert.equal(ui.authCopy('signin', { busy: true }).submit, 'Signing in…');
  assert.equal(ui.authCopy('reset', { busy: true }).submit, 'Sending…');
  assert.equal(ui.authCopy('reset').submit, 'Send reset email');
  assert.equal(ui.authCopy('reset').modeSwitch, 'Back to sign in');
  assert.equal(ui.authCopy('other').modeSwitch, 'New here? Create an account');
});

const linkedBoth = {
  accountEmail: 'member@example.test',
  password: { linked: true, canAdd: false, canUnlink: true },
  google: { linked: true, canLink: false, canUnlink: true },
  recentAuth: { ok: true, method: 'password', authenticatedAt: 1, expiresAt: 2 },
};

test('identityView requires recent auth for every change and explains why (ID-63)', () => {
  const passwordOnly = {
    accountEmail: 'member@example.test',
    password: { linked: true, canAdd: false, canUnlink: false },
    google: { linked: false, canLink: true, canUnlink: false },
    recentAuth: { ok: false, reason: 'recent_auth_required' },
  };
  const stale = ui.identityView({ data: passwordOnly, googleOAuth: true });
  assert.equal(stale.title, 'Account security');
  assert.equal(stale.description, 'Sign-in methods for member@example.test.');
  assert.equal(stale.recent.hidden, false);
  assert.equal(stale.recent.showPassword, true);
  assert.equal(stale.recent.showGoogle, false);
  assert.match(stale.recent.hint, /last 10 minutes\. Confirm your password to continue\./);
  assert.equal(stale.google.disabled, true);
  assert.equal(stale.google.action, 'Link Google');
  assert.match(stale.google.help, /last 10 minutes\. Confirm your password above first, then link Google\./);
  assert.equal(stale.password.disabled, true);
  assert.match(stale.password.help, /final sign-in method/);

  const fresh = ui.identityView({ data: { ...passwordOnly, recentAuth: { ok: true, method: 'password' } }, googleOAuth: true });
  assert.equal(fresh.recent.hidden, true);
  assert.equal(fresh.google.disabled, false);
  assert.match(fresh.google.help, /continue to Google/);
  assert.equal(fresh.recent.ok, 'You signed in recently, so you can change sign-in methods.');

  const noCapability = ui.identityView({ data: { ...passwordOnly, recentAuth: { ok: true, method: 'password' } }, googleOAuth: false });
  assert.equal(noCapability.google.disabled, true);
  assert.match(noCapability.google.help, /not available on this site/);

  const busy = ui.identityView({ data: { ...passwordOnly, recentAuth: { ok: true, method: 'password' } }, googleOAuth: true, busy: true });
  assert.equal(busy.google.disabled, true);
});

test('identityView never allows removing the final credential', () => {
  const view = ui.identityView({ data: linkedBoth, googleOAuth: true });
  assert.equal(view.google.disabled, false);
  assert.equal(view.password.disabled, false);
  assert.equal(view.google.danger, true);
  assert.match(view.google.help, /sign in with your email and password/);
  assert.match(view.password.help, /sign in with Google/);
  const googleOnly = ui.identityView({ data: { ...linkedBoth, password: { linked: false, canAdd: false, canUnlink: false },
    google: { linked: true, canUnlink: false } }, googleOAuth: true });
  assert.equal(googleOnly.google.disabled, true);
  assert.match(googleOnly.google.help, /only sign-in method/);
  assert.equal(googleOnly.password.disabled, true);
  assert.match(googleOnly.password.help, /not available for this account/);
  const staleBoth = ui.identityView({ data: { ...linkedBoth, recentAuth: { ok: false } }, googleOAuth: true });
  assert.match(staleBoth.google.help, /Confirm it's you above to remove Google/);
  assert.match(staleBoth.password.help, /Confirm it's you above to remove your password/);
  assert.equal(staleBoth.recent.showGoogle, true);
  assert.match(staleBoth.recent.hint, /Confirm your password, or confirm with Google\./);
});

test('identityView adds a password only after a recent Google confirmation', () => {
  const base = { accountEmail: 'g@example.test', password: { linked: false, canAdd: true, canUnlink: false },
    google: { linked: true, canUnlink: false } };
  const viaPassword = ui.identityView({ data: { ...base, recentAuth: { ok: true, method: 'password' } }, googleOAuth: true });
  assert.equal(viaPassword.password.disabled, true);
  assert.equal(viaPassword.password.showAdd, false);
  assert.match(viaPassword.password.help, /Confirm with Google first/);
  const staleGoogle = ui.identityView({ data: { ...base, recentAuth: { ok: false } }, googleOAuth: true });
  assert.equal(staleGoogle.recent.showPassword, false);
  assert.equal(staleGoogle.recent.showGoogle, true);
  assert.match(staleGoogle.recent.hint, /Confirm with Google to continue\./);
  const viaGoogle = ui.identityView({ data: { ...base, recentAuth: { ok: true, method: 'google' } }, googleOAuth: true });
  assert.equal(viaGoogle.password.disabled, false);
  assert.equal(viaGoogle.password.showAdd, true);
  assert.equal(viaGoogle.password.canAdd, true);
  assert.equal(viaGoogle.password.action, 'Add password');
  assert.match(viaGoogle.password.help, /at least 10 characters/);
  // Without the Google capability a Google-only account has no confirmation method.
  const none = ui.identityView({ data: { ...base, recentAuth: { ok: false } }, googleOAuth: false });
  assert.equal(none.recent.hint, 'No confirmation method is available for this account right now.');
});

test('identityView confirmation mode shows only the confirm step', () => {
  const view = ui.identityView({ mode: 'confirm', data: { recentAuth: { ok: false } }, methods: { password: true, google: true } });
  assert.equal(view.title, 'Confirm this sensitive change');
  assert.equal(view.recent.hidden, false);
  assert.equal(view.recent.showPassword, true);
  assert.equal(view.recent.showGoogle, true);
  assert.match(view.recent.hint, /^This change needs a sign-in from the last 10 minutes\./);
  assert.equal(view.google.hidden, true);
  assert.equal(view.password.hidden, true);
  assert.equal(view.google.help, '');
  assert.equal(view.defaultStatus, 'Choose an available confirmation method.');
  const loading = ui.identityView({ mode: 'confirm' });
  assert.equal(loading.defaultStatus, 'Loading sign-in methods…');
  assert.equal(loading.recent.showPassword, false);
});

test('identityView while loading hides the empty confirm step and disables actions', () => {
  const view = ui.identityView({ data: null, googleOAuth: true });
  assert.equal(view.recent.hidden, true);
  assert.equal(view.google.disabled, true);
  assert.equal(view.password.disabled, true);
  assert.equal(view.google.state, 'not linked');
  assert.equal(view.defaultStatus, 'Loading sign-in methods…');
  assert.equal(view.description, 'Manage the sign-in methods attached to this Randori account.');
  assert.equal(ui.identityView().title, 'Account security');
});

test('recentAuthRemainingMinutes only trusts plausible server timestamps', () => {
  const now = 1_700_000_000_000;
  assert.equal(ui.recentAuthRemainingMinutes({ expiresAt: now / 1000 + 9 * 60 + 5 }, now), 10);
  assert.equal(ui.recentAuthRemainingMinutes({ expiresAt: now / 1000 + 30 }, now), 1);
  assert.equal(ui.recentAuthRemainingMinutes({ expiresAt: now / 1000 - 1 }, now), null);
  assert.equal(ui.recentAuthRemainingMinutes({ expiresAt: now / 1000 + 3600 }, now), null);
  assert.equal(ui.recentAuthRemainingMinutes({ expiresAt: 'x' }, now), null);
  assert.equal(ui.recentAuthRemainingMinutes(null, now), null);
  const view = ui.identityView({ data: { ...linkedBoth, recentAuth: { ok: true, method: 'password', expiresAt: now / 1000 + 60 } },
    googleOAuth: true, nowMs: now });
  assert.equal(view.recent.ok, 'Confirmed. You can change sign-in methods for the next 1 minute.');
  const later = ui.identityView({ data: { ...linkedBoth, recentAuth: { ok: true, method: 'password', expiresAt: now / 1000 + 300 } },
    googleOAuth: true, nowMs: now });
  assert.equal(later.recent.ok, 'Confirmed. You can change sign-in methods for the next 5 minutes.');
});

test('identity status messages and tones', () => {
  assert.equal(ui.identityActionMessage('unlinked'), 'Sign-in method removed.');
  assert.equal(ui.identityActionMessage('not_linked'), 'That sign-in method is already removed.');
  assert.equal(ui.identityActionMessage('already_linked'), 'That sign-in method is already linked.');
  assert.equal(ui.identityActionMessage('redirecting'), 'Continue with Google to finish linking.');
  assert.equal(ui.identityActionMessage('confirmed'), 'Identity confirmed.');
  assert.equal(ui.identityActionMessage('linked'), 'Sign-in method linked.');
  assert.equal(ui.messageTone(''), 'none');
  assert.equal(ui.messageTone('Confirming your password…'), 'loading');
  assert.equal(ui.messageTone('Sign-in method removed.'), 'success');
  assert.equal(ui.messageTone('Google sign-in is now linked to this account.'), 'success');
  assert.equal(ui.messageTone('Choose a sign-in method to manage.'), 'info');
  assert.equal(ui.messageTone('Your Google email changed. Review it.'), 'info');
  assert.equal(ui.messageTone('Confirm your identity to continue.'), 'info');
  assert.equal(ui.messageTone("That password isn't right. Try again."), 'error');
});
