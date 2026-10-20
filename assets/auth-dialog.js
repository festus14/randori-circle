// Presentation helpers for the sign-in, account security and confirmation
// dialogs (WP-A). Pure functions only: no DOM access, no network, no storage.
// index.html owns every request, every security decision and every state
// transition; this file only turns already-decided state into human copy and
// into the enabled/disabled view of controls, so it can be unit tested.
(function installAuthDialog(root) {
  'use strict';

  const PASSWORD_MIN_BYTES = 10;
  const PASSWORD_MAX_BYTES = 72;
  const NAME_MIN = 2;
  const NAME_MAX = 32;
  const RECENT_AUTH_MINUTES = 10;
  const MODES = new Set(['signin', 'signup', 'reset']);

  function utf8Length(value) {
    return new TextEncoder().encode(String(value ?? '')).length;
  }

  function normalizedMode(mode) {
    return MODES.has(mode) ? mode : 'signin';
  }

  function serverText(error) {
    if (typeof error === 'string') return error;
    return String(error?.error || error?.message || '');
  }

  function isNetworkFailure(error) {
    if (!error || typeof error !== 'object') return false;
    const name = String(error.name || '');
    const message = String(error.message || '');
    return name === 'TypeError' && /fetch|network|load failed/i.test(message);
  }

  // ---------------------------------------------------------------- fields

  function passwordProblem(password, { mode }) {
    if (!password) return mode === 'signup' ? 'Choose a password.' : 'Enter your password.';
    if (mode !== 'signup') return '';
    const bytes = utf8Length(password);
    if (bytes < PASSWORD_MIN_BYTES) return `Use at least ${PASSWORD_MIN_BYTES} characters.`;
    if (bytes > PASSWORD_MAX_BYTES) {
      return [...String(password)].length <= PASSWORD_MAX_BYTES
        ? 'This password is too long. Emoji and some symbols count as more than one character.'
        : `Use ${PASSWORD_MAX_BYTES} characters or fewer.`;
    }
    return '';
  }

  // Sign-up applies the shared strict rules (assets/email-validation.js, the
  // same module the server uses) once that module has loaded. Sign-in and
  // password reset keep the browser's own check so an existing account whose
  // address predates those rules is never locked out client-side.
  function emailProblem(email, emailValid, mode) {
    if (!email) return 'Enter your email address.';
    if (!emailValid) return 'Enter a valid email address.';
    const rules = root.RandoriEmailValidation;
    if (mode === 'signup' && rules) {
      const verdict = rules.validateEmail(email);
      if (!verdict.ok) return rules.emailProblemMessage(verdict.reason);
    }
    return '';
  }

  function nameProblem(name) {
    return name.length < NAME_MIN || name.length > NAME_MAX
      ? `Enter a display name with ${NAME_MIN}–${NAME_MAX} characters.`
      : '';
  }

  // Validates every visible field at once so all problems show inline.
  // Returns the exact request body the previous validator produced.
  function validateAuthFields({ mode, email, emailValid, name, password } = {}) {
    const resolved = normalizedMode(mode);
    const normalizedEmail = String(email ?? '').trim().toLowerCase();
    const normalizedName = String(name ?? '').trim();
    const rawPassword = String(password ?? '');
    const errors = {};
    const emailError = emailProblem(normalizedEmail, emailValid === true, resolved);
    if (emailError) errors.email = emailError;
    if (resolved === 'signup') {
      const problem = nameProblem(normalizedName);
      if (problem) errors.name = problem;
    }
    if (resolved !== 'reset') {
      const problem = passwordProblem(rawPassword, { mode: resolved });
      if (problem) errors.password = problem;
    }
    const order = ['email', 'name', 'password'].filter(field => errors[field]);
    if (order.length) return { ok: false, errors, first: order[0] };
    if (resolved === 'reset') return { ok: true, body: { email: normalizedEmail } };
    return {
      ok: true,
      body: resolved === 'signup'
        ? { email: normalizedEmail, password: rawPassword, name: normalizedName }
        : { email: normalizedEmail, password: rawPassword },
    };
  }

  // A single field checked on blur. Empty values stay quiet until submit.
  function fieldProblem(field, { mode, value, valid } = {}) {
    const text = String(value ?? '');
    if (!text.trim()) return '';
    if (field === 'email') return emailProblem(text.trim(), valid === true, normalizedMode(mode));
    if (field === 'name') return normalizedMode(mode) === 'signup' ? nameProblem(text.trim()) : '';
    if (field === 'password') return passwordProblem(text, { mode: normalizedMode(mode) });
    return '';
  }

  function newPasswordProblem(password, confirmation) {
    const problem = passwordProblem(String(password ?? ''), { mode: 'signup' });
    if (problem) return problem === 'Choose a password.' ? 'Choose a new password.' : problem;
    if (password !== confirmation) return 'Passwords do not match.';
    return '';
  }

  // --------------------------------------------------------------- failures

  function temporarilyUnavailable(mode) {
    if (mode === 'signup') return 'Account creation is temporarily unavailable. Try again.';
    if (mode === 'reset') return 'Password recovery is temporarily unavailable. Try again.';
    if (mode === 'activation') return 'Verification email is temporarily unavailable. Try again.';
    return 'Sign in is temporarily unavailable. Try again.';
  }

  function tooMany(mode) {
    if (mode === 'signup') return 'Too many sign-up attempts. Wait a few minutes, then try again.';
    if (mode === 'reset') return 'Too many reset requests. Wait a few minutes, then try again.';
    if (mode === 'activation') return 'Too many verification emails requested. Wait a few minutes, then try again.';
    return 'Too many sign-in attempts. Wait a few minutes, then try again.';
  }

  function authFailureMessage(error, mode) {
    const resolved = mode === 'activation' ? mode : normalizedMode(mode);
    if (isNetworkFailure(error)) return "We couldn't reach Randori. Check your connection and try again.";
    const code = serverText(error);
    const status = Number(error?.http_status || error?.status) || 0;
    if (code === 'invitation unavailable or does not match this email') {
      return "We couldn't use this invitation with that email. Use the address the invitation was sent to, or ask a circle owner for a new invitation.";
    }
    if (code === 'invitation context changed' || code === 'invitation unavailable'
      || code.includes('valid local invitation')) {
      return 'This invitation link changed or expired. Reopen the link from your invitation email.';
    }
    if (code === 'email already registered') return 'That email already has an account. Sign in instead.';
    if (code === 'invalid credentials') return 'Email or password is incorrect.';
    if (code === 'active circle membership required') {
      return 'Your circle membership is no longer active. Ask a circle owner for a new invitation.';
    }
    if (code === 'valid email required') return 'Enter a valid email address.';
    if (code.startsWith('display name must be')) return `Enter a display name with ${NAME_MIN}–${NAME_MAX} characters.`;
    if (code.startsWith('password must be') || code === 'password required' || code === 'email,password required') {
      return `Use a password with ${PASSWORD_MIN_BYTES}–${PASSWORD_MAX_BYTES} characters.`;
    }
    if (code.startsWith('password signup is disabled')) {
      return 'Create your account with Google, using the Google account the invitation was sent to.';
    }
    if (code.startsWith('private beta signup')) {
      return 'Randori is invite-only. Open the link from your invitation email to create an account.';
    }
    if (code === 'authentication required' || code === 'invalid session') {
      return 'Your session ended. Sign in again to continue.';
    }
    if (code.includes('too many') || status === 429) return tooMany(resolved);
    if (code.includes('temporarily unavailable') || code.endsWith('is unavailable') || status >= 500) {
      return temporarilyUnavailable(resolved);
    }
    if (code.includes('cross-origin') || code.includes('same-origin')) {
      return 'This request was blocked for your security. Refresh the page and try again.';
    }
    if (resolved === 'signup') return "Account creation didn't work. Try again.";
    if (resolved === 'reset') return "Password recovery didn't work. Try again.";
    if (resolved === 'activation') return "We couldn't send another verification email. Try again.";
    return "Sign in didn't work. Try again.";
  }

  // Google returns to the app with ?google_error=<code>. preferPassword marks
  // the codes where retrying Google cannot help and email sign-in is the way on.
  function googleFailure(code) {
    switch (String(code || '')) {
      case 'access_denied':
        return { message: 'Google sign-in was cancelled. You can try again when you are ready.', preferPassword: false };
      case 'provider_denied':
        return { message: "Google didn't allow the sign-in. Try again, or choose a different Google account.", preferPassword: false };
      case 'invalid_state':
        return { message: 'Your Google sign-in expired or was opened in another tab. Start again to continue safely.', preferPassword: false };
      case 'missing_code':
        return { message: "Google didn't finish the sign-in. Try again.", preferPassword: false };
      case 'provider_unavailable':
        return { message: 'Google sign-in is temporarily unavailable. Please try again.', preferPassword: false };
      case 'identity_invalid':
      case 'provider_response_invalid':
        return { message: "We couldn't verify that Google account. Make sure its email address is verified, then try again.", preferPassword: false };
      case 'account_exists_use_password':
        return { message: 'This email already signs in with a password. Sign in with your email and password, then link Google from Account security.', preferPassword: true };
      case 'identity_mismatch':
        return { message: 'This email is linked to a different Google account. Sign in with that Google account or your password. A circle owner can help if you are stuck.', preferPassword: true };
      case 'private_beta':
        return { message: 'Randori is invite-only. Open the link from your invitation email, then continue with the Google account it was sent to.', preferPassword: false };
      case 'reauth_required':
        return { message: 'Your session changed while you were at Google. Sign in again, then retry.', preferPassword: false };
      case 'db_error':
      case 'session_error':
        return { message: "Randori couldn't finish signing you in. Try again in a moment.", preferPassword: false };
      default:
        return { message: 'Google sign-in did not complete. Please try again.', preferPassword: false };
    }
  }

  function identityErrorMessage(error) {
    const code = String(error?.status || error?.code || error?.error || '');
    if (code === 'invalid credentials') return "That password isn't right. Try again.";
    if (code === 'password required') return 'Enter your current password.';
    if (code.includes('too many confirmation')) return 'Too many confirmation attempts. Wait a few minutes, then try again.';
    if (code.includes('too many')) return 'Too many changes in a short time. Wait a few minutes, then try again.';
    if (code.includes('temporarily unavailable') || code === 'unavailable') {
      return 'Account security is temporarily unavailable. Please try again.';
    }
    if (code === 'recent_auth_required' || code.includes('recent authentication')) {
      return `For your security, confirm it's you again. Changing sign-in methods needs a Randori sign-in from the last ${RECENT_AUTH_MINUTES} minutes.`;
    }
    if (code === 'provider_in_use') {
      return 'That Google account already belongs to another Randori account. Sign in there and add another method before unlinking it.';
    }
    if (code === 'provider_already_linked') {
      return 'This account already has a different Google account linked. Remove it first to link another one.';
    }
    if (code === 'final_credential' || code.includes('before removing')) {
      return "You can't remove your only sign-in method. Add another one first.";
    }
    if (code === 'verified_control_required' || code.includes('confirm your linked Google')) {
      return 'Confirm with Google first. Adding a password needs a recent Google confirmation.';
    }
    if (code === 'session_changed' || code === 'authentication required') {
      return 'Your session changed. Sign in again, then retry.';
    }
    return 'Account security is temporarily unavailable. Please try again.';
  }

  function googleConfirmationStartFailure(error, { lifecycle = false } = {}) {
    const detail = String(error?.error || error?.message || '');
    const result = detail.includes('too many')
      ? { reason: 'google_rate_limited', message: 'Too many Google confirmation attempts. Try again later.' }
      : (detail.includes('authentication required')
        ? { reason: 'session_changed', message: 'Your session changed. Sign in again before retrying.' }
        : { reason: 'google_unavailable', message: 'Google confirmation is temporarily unavailable. Try again.' });
    return lifecycle ? { ...result, message: `${result.message} No circle change was made.` } : result;
  }

  // ------------------------------------------------------------ auth status

  // The capability line under the dialog title. routine=true means it only
  // restates what the visible buttons already say, so it is kept for screen
  // readers and hidden visually to avoid a repeated sentence.
  function authStatus(state = {}) {
    const mode = normalizedMode(state.mode);
    const caps = state.capabilities || {};
    if (!state.loaded) return { text: 'Checking sign-in options…', tone: 'loading', routine: false };
    if (state.failed) {
      return { text: 'New-account options could not be verified. Existing members can still try password sign-in.', tone: 'warning', routine: false };
    }
    if (mode === 'reset') {
      return { text: 'For your privacy, you will see the same message whether or not an account uses this email.', tone: 'info', routine: false };
    }
    if (mode === 'signup' && state.requiresInvite && !state.hasInvite) {
      return { text: 'Open the invitation link you received, or ask a circle owner for a new invitation. Existing members can sign in below.', tone: 'warning', routine: false };
    }
    if (mode === 'signup' && caps.passwordSignup) {
      if (caps.registrationMode === 'local_invite') {
        return state.inviteReady
          ? { text: 'This local account will use the verified invitation and join the private circle.', tone: 'info', routine: false }
          : { text: 'A valid local invitation is required before creating an account.', tone: 'warning', routine: false };
      }
      if (caps.registrationMode === 'verified_invite') {
        return state.inviteReady
          ? { text: 'Use the invited email. Your account activates only after you open the verification link we send.', tone: 'info', routine: false }
          : { text: 'A valid invitation is required before requesting email verification.', tone: 'warning', routine: false };
      }
      return caps.registrationMode === 'local_open'
        ? { text: 'Create a local account. The first account can manage weekly pairing.', tone: 'info', routine: false }
        : { text: 'Create your account to join the circle.', tone: 'info', routine: true };
    }
    if (mode === 'signup' && caps.googleOAuth) {
      return { text: 'New members join with an invitation and their verified Google account.', tone: 'info', routine: false };
    }
    if (caps.googleOAuth && caps.passwordLogin) return { text: 'Use your existing password or Google account.', tone: 'info', routine: true };
    if (caps.googleOAuth) return { text: 'Continue with your verified Google account.', tone: 'info', routine: true };
    if (caps.passwordLogin) return { text: 'Sign in with your existing email and password.', tone: 'info', routine: true };
    return { text: 'No sign-in method is currently available.', tone: 'warning', routine: false };
  }

  function authCopy(mode, { registrationMode = '', busy = false } = {}) {
    const resolved = normalizedMode(mode);
    if (resolved === 'signup') {
      const verified = registrationMode === 'verified_invite';
      return {
        title: 'Join Randori Circle',
        description: 'Create your account to join weekly practice pairings.',
        submit: busy ? (verified ? 'Sending link…' : 'Creating account…') : (verified ? 'Send verification email' : 'Create account'),
        modeSwitch: 'Already a member? Sign in',
      };
    }
    if (resolved === 'reset') {
      return {
        title: 'Reset your password',
        description: "Enter your account email and we'll send a single-use link to choose a new password.",
        submit: busy ? 'Sending…' : 'Send reset email',
        modeSwitch: 'Back to sign in',
      };
    }
    return {
      title: 'Sign in to Randori',
      description: 'Welcome back. Your pairings and practice rooms are waiting.',
      submit: busy ? 'Signing in…' : 'Sign in',
      modeSwitch: 'New here? Create an account',
    };
  }

  // ------------------------------------------------------- account security

  function recentAuthRemainingMinutes(recentAuth, nowMs) {
    const expires = Number(recentAuth?.expiresAt);
    if (!Number.isFinite(expires) || !Number.isFinite(nowMs)) return null;
    // Server timestamps are Unix seconds. Ignore anything implausible.
    const remaining = expires * 1000 - nowMs;
    if (remaining <= 0 || remaining > RECENT_AUTH_MINUTES * 60 * 1000 + 60 * 1000) return null;
    return Math.max(1, Math.ceil(remaining / 60000));
  }

  // The view of the account security / recent-confirmation dialog. The
  // disabled conditions are the security contract and must not loosen:
  // every change needs recent auth, Google linking needs the capability,
  // unlinking needs the server's canUnlink, adding a password needs a recent
  // Google confirmation.
  function identityView({ mode = 'manage', data = null, methods = null, busy = false, googleOAuth = false, nowMs = Date.now() } = {}) {
    const confirmation = mode === 'confirm';
    const recent = data?.recentAuth?.ok === true;
    const passwordLinked = confirmation ? methods?.password === true : data?.password?.linked === true;
    const googleLinked = confirmation ? methods?.google === true : data?.google?.linked === true;
    const googleAvailable = googleOAuth === true;
    const recentMethod = data?.recentAuth?.method || null;

    const showGoogleConfirm = googleLinked && (confirmation || googleAvailable);
    const lead = confirmation
      ? `This change needs a sign-in from the last ${RECENT_AUTH_MINUTES} minutes.`
      : `Changing how you sign in needs a Randori sign-in from the last ${RECENT_AUTH_MINUTES} minutes.`;
    let recentHint;
    if (passwordLinked && showGoogleConfirm) recentHint = `${lead} Confirm your password, or confirm with Google.`;
    else if (passwordLinked) recentHint = `${lead} Confirm your password to continue.`;
    else if (showGoogleConfirm) recentHint = `${lead} Confirm with Google to continue.`;
    else recentHint = 'No confirmation method is available for this account right now.';

    const minutes = recentAuthRemainingMinutes(data?.recentAuth, nowMs);
    const recentOk = !confirmation && !!data && recent
      ? (minutes
        ? `Confirmed. You can change sign-in methods for the next ${minutes} minute${minutes === 1 ? '' : 's'}.`
        : 'You signed in recently, so you can change sign-in methods.')
      : '';

    const googleDisabled = busy || !data || !recent || (googleLinked ? !data.google?.canUnlink : !googleAvailable);
    let googleHelp;
    if (confirmation || !data) googleHelp = '';
    else if (googleLinked) {
      googleHelp = !data.google?.canUnlink
        ? 'Google is your only sign-in method. Add a password before removing it.'
        : (!recent
          ? "Confirm it's you above to remove Google sign-in."
          : 'After removing Google you will sign in with your email and password.');
    } else if (!googleAvailable) {
      googleHelp = 'Google sign-in is not available on this site yet.';
    } else if (!recent) {
      googleHelp = `Linking Google needs a Randori sign-in from the last ${RECENT_AUTH_MINUTES} minutes. Confirm your password above first, then link Google.`;
    } else {
      googleHelp = "You'll continue to Google to pick the account to link, then come straight back here.";
    }

    const canAddPassword = data?.password?.canAdd === true && recentMethod === 'google';
    const passwordDisabled = busy || !data || !recent
      || (passwordLinked ? !data.password?.canUnlink : !(data.password?.canAdd && recentMethod === 'google'));
    const showPasswordAdd = !passwordLinked && data?.password?.canAdd === true && recent && recentMethod === 'google';
    let passwordHelp;
    if (confirmation || !data) passwordHelp = '';
    else if (passwordLinked) {
      passwordHelp = !data.password?.canUnlink
        ? 'Password is your final sign-in method. Link Google before removing it.'
        : (!recent
          ? "Confirm it's you above to remove your password."
          : 'After removing your password you will sign in with Google.');
    } else if (!data.password?.canAdd) {
      passwordHelp = 'Adding a password is not available for this account.';
    } else if (!recent || recentMethod !== 'google') {
      passwordHelp = `Adding a password needs your linked Google account. Confirm with Google first (valid for ${RECENT_AUTH_MINUTES} minutes).`;
    } else {
      passwordHelp = `Choose a password with at least ${PASSWORD_MIN_BYTES} characters.`;
    }

    return {
      title: confirmation ? 'Confirm this sensitive change' : 'Account security',
      description: confirmation
        ? 'Confirm it’s you to finish the circle change you started.'
        : (data?.accountEmail
          ? `Sign-in methods for ${data.accountEmail}.`
          : 'Manage the sign-in methods attached to this Randori account.'),
      defaultStatus: data
        ? (confirmation ? 'Choose an available confirmation method.' : 'Choose a sign-in method to manage.')
        : 'Loading sign-in methods…',
      recent: {
        hidden: confirmation ? false : (!data || recent),
        hint: recentHint,
        showPassword: passwordLinked,
        showGoogle: showGoogleConfirm,
        ok: recentOk,
      },
      google: {
        hidden: confirmation,
        state: googleLinked ? 'linked' : 'not linked',
        action: googleLinked ? 'Remove Google' : 'Link Google',
        disabled: googleDisabled,
        help: googleHelp,
        danger: googleLinked,
      },
      password: {
        hidden: confirmation,
        state: passwordLinked ? 'linked' : 'not linked',
        action: passwordLinked ? 'Remove password' : 'Add password',
        disabled: passwordDisabled,
        help: passwordHelp,
        showAdd: showPasswordAdd,
        canAdd: canAddPassword,
        danger: passwordLinked,
      },
    };
  }

  function identityActionMessage(status) {
    switch (status) {
      case 'unlinked': return 'Sign-in method removed.';
      case 'not_linked': return 'That sign-in method is already removed.';
      case 'already_linked': return 'That sign-in method is already linked.';
      case 'redirecting': return 'Continue with Google to finish linking.';
      case 'confirmed': return 'Identity confirmed.';
      default: return 'Sign-in method linked.';
    }
  }

  const SUCCESS_MESSAGES = new Set([
    'Sign-in method removed.',
    'That sign-in method is already removed.',
    'That sign-in method is already linked.',
    'Sign-in method linked.',
    'Identity confirmed.',
    'Google confirmation complete.',
    'Google sign-in is now linked to this account.',
    'That Google account is already linked to this account.',
  ]);
  const NEUTRAL_MESSAGES = new Set([
    'Choose a sign-in method to manage.',
    'Choose an available confirmation method.',
    'Continue with Google to finish linking.',
  ]);

  // Styling tone for a dialog status line. Tone is decoration only: the text
  // itself always carries the meaning.
  function messageTone(text) {
    const value = String(text || '');
    if (!value) return 'none';
    if (value.endsWith('…')) return 'loading';
    if (SUCCESS_MESSAGES.has(value)) return 'success';
    if (NEUTRAL_MESSAGES.has(value) || value.startsWith('Your Google email changed')) return 'info';
    if (value.startsWith('Confirm your identity') || value.startsWith('Confirm ')) return 'info';
    return 'error';
  }

  root._randori_auth_ui = Object.freeze({
    PASSWORD_MIN_BYTES,
    PASSWORD_MAX_BYTES,
    RECENT_AUTH_MINUTES,
    utf8Length,
    validateAuthFields,
    fieldProblem,
    newPasswordProblem,
    authFailureMessage,
    googleFailure,
    identityErrorMessage,
    googleConfirmationStartFailure,
    authStatus,
    authCopy,
    identityView,
    identityActionMessage,
    recentAuthRemainingMinutes,
    messageTone,
  });
})(typeof window !== 'undefined' ? window : globalThis);
