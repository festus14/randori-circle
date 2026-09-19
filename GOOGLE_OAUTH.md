# Google OpenID Connect — Randori Circle

LeetCode does **not** offer public OAuth (no client_id/secret, no consent screen) — it's internal GraphQL + cookies only. So we use Google OAuth 2.0.

This repo already has email/password auth (`auth_accounts` in Turso + JWT). Google SSO builds on the same account store, but the application session is kept in a 12-hour `Secure`, `HttpOnly`, `SameSite=Lax` cookie rather than a URL or `localStorage`.

### What to set in Vercel

In Vercel Dashboard → your project → Settings → Environment Variables add:

- `GOOGLE_CLIENT_ID` — from Google Cloud
- `GOOGLE_CLIENT_SECRET` — from Google Cloud
- `APP_URL` — required and exact. Set the canonical production HTTPS origin only, with no credentials, path, query, or fragment. OAuth requests must arrive on that same host through HTTPS. A non-production HTTP origin is accepted only for loopback development; the isolated `npm run dev` runtime deliberately disables external providers.
- `JWT_SECRET` — already required (e.g. `openssl rand -base64 48`)
- `CRON_SECRET` — required separately from `JWT_SECRET`; protects the weekly cron
- `SIGNUP_ALLOWLIST` — comma-separated private-beta Google email addresses used before circle-membership cutover
- `CIRCLE_MEMBERSHIP_ENABLED` — leave `false` while running and verifying `/api/init`, then set `true` to require active primary-circle membership or an email-bound invitation
- `IDENTITY_MANAGEMENT_ENABLED` — leave `false` through migration v9, then set `true` to expose explicit Google/password linking and removal
- `IDENTITY_EMAIL_HASH_KEY` — an independent 32-byte base64url HMAC key; never reuse `JWT_SECRET` or invitation/recovery encryption material
- `IDENTITY_EMAIL_HASH_KEY_VERSION` — start at `1` and increment whenever the identity-email HMAC key changes
- Keep existing `TURSO_DATABASE_URL` + `TURSO_AUTH_TOKEN`

Redeploy after adding.

### How to create Google OAuth client (no GCP project yet)

1. Go to https://console.cloud.google.com → top-left project picker → **New Project** → Name `Randori Circle` → Create. Wait ~10s and switch to it.

2. **OAuth consent screen** (required first):
- APIs & Services → OAuth consent screen → Get Started
- App info: App name `Randori Circle`, User support email = your email, Audience **External**, Contact email your email.
- Scopes: leave default, on **Data Access** add scopes `.../auth/userinfo.email` and `.../auth/userinfo.profile` (or just type `email` `profile` and select).
- Test users: Add yourself (your Gmail). This lets External apps work while in Testing.
- Save.

3. **Create credentials**:
- APIs & Services → Credentials → Create Credentials → OAuth client ID → Application type **Web application** → Name `Randori Web`.
- Authorized JavaScript origins: 
  - `https://randori-circle-self.vercel.app`
  - `http://localhost:3000` (optional for local dev)
- Authorized redirect URIs (exact, no trailing slash):
  - `https://randori-circle-self.vercel.app/api/auth/google/callback`
  - `http://localhost:3000/api/auth/google/callback` (optional)
- Create → copy **Client ID** → `GOOGLE_CLIENT_ID`, **Client Secret** → `GOOGLE_CLIENT_SECRET`.

4. Paste both into Vercel, Redeploy. Done.

5. Apply the versioned database migrations and verify the deployment readiness probe before opening traffic, then confirm `/api/auth/capabilities` advertises `googleOAuth: true` on the canonical deployment. Missing/partial credentials, an unmigrated identity schema, a non-canonical or insecure origin, a mismatched request host/protocol, and the isolated local runtime all fail closed.

No extra API needs enabling — Google Identity is on by default.

### Flow

- User clicks "Continue with Google" (`#authGoogle`) → `GET /api/auth/google/start` creates cryptographically random OAuth state, PKCE verifier, and OpenID Connect nonce in short-lived HttpOnly cookies, then redirects to Google. Pair invites may add an exact canonical `return_to` such as `/join/week_12_pair_34`; the server stores the validated path in a separate short-lived cookie.
- Google → consent → redirects to `/api/auth/google/callback?code=...`
- Callback consumes the transient cookies, verifies state, exchanges the single-use code with the exact PKCE verifier, and validates the signed ID token against Google's bounded JWKS response. Issuer, audience, expiry, nonce, subject, and `email_verified` are all required; token and key responses have strict byte and time limits.
- Resolve `auth_provider_identities` by the canonical Google issuer plus stable subject:
  - not exists → create a Google-only account associated with the verified Google subject only when the legacy allowlist is still open, or after validating an unused invitation bound to that email.
  - existing Google account → use issuer plus subject as the identity, refusing any email collision with another account.
  - existing password account → do not silently link it; the user signs in with the existing method and explicitly links Google from Account security after recent authentication.
- A provider email change does not rewrite the canonical account email. With identity management enabled, Randori records only a domain-separated email HMAC, its non-secret key version, and a redacted change event, then explains which address password sign-in continues to use. Key rotation re-baselines the observation and records a distinct redacted rekey event rather than falsely claiming the email changed.
- Signs a 12-hour application JWT with pinned algorithm, issuer, audience, and a random session identifier. Only a domain-separated SHA-256 hash of that identifier is persisted in `auth_sessions`; every private request checks the live, unexpired row. The credential stays in the secure session cookie and the callback redirects to `/?google=success` or the validated pair invite path with `?google=success`.

The callback never accepts a return destination from its query string. It consumes the destination captured at OAuth start and clears state, PKCE, nonce, and return cookies before provider work. Combined with Google's single-use authorization code, replayed callbacks cannot establish another session. Only `/join/week_<positive integer>_pair_<positive integer>` is accepted; absolute URLs, protocol-relative URLs, encoded or backslash separators, queries, fragments, zeroes, leading zeroes, and malformed room IDs fall back to `/`.

Provider errors are mapped to a small public code set; raw provider bodies, authorization codes, ID tokens, client secrets, and invitation material are never logged or stored in browser storage. The sign-in dialog presents a keyboard-focusable retry action for recoverable failures.

No secrets in git. Native `fetch` used — no new deps.

### Endpoints

- `GET /api/auth/google/start` — starts flow
- `POST /api/auth/google/link/start` — starts explicit linking for the exact recent-authenticated live session
- `GET /api/auth/google/callback?code=` — finishes, issues JWT, redirects
- `GET /api/auth/identities` — returns safe linked-method and recent-auth state
- `POST /api/auth/identities/google` — removes Google only when another usable method remains
- `POST /api/auth/identities/password` — adds or removes a password after verified control while preserving a usable method
- `POST /api/auth/signup` is development-only until email verification exists. Existing password users may still use `POST /api/auth/login`; `GET /api/auth/me` reads the protected session.
- `POST /api/auth/logout` durably revokes the presented session, then clears its cookie
- `POST /api/auth/logout-all` durably revokes every active session for the authenticated account, then clears its cookie

### Common gotchas

- Redirect URI mismatch → Google shows "redirect_uri_mismatch" — copy exactly from Vercel url, check trailing slash.
- `invalid_grant` / expired code → codes are single-use 5-min. Retry.
- `Missing GOOGLE_CLIENT_ID` JSON → you didn't set env var / didn't redeploy after set.
- Test users: while app in Testing mode, only test emails can sign in — add your circle friends emails to Test users list.

Before membership cutover, production enrollment requires verified Google sign-in plus `SIGNUP_ALLOWLIST`; after cutover, it requires a prepared owner-issued invitation and active primary-circle membership. Credential management remains hidden until v9 and the dedicated key/version are verified and `IDENTITY_MANAGEMENT_ENABLED=true`. Rotate the hash key and monotonically increment its version in the same deployment; the first later observation per identity is audited as a rekey, not an email change, and no prior key is retained. Readiness checks the global maximum stored version and a one-way key fingerprint. A stale instance with a lower version, or a different key at the same version, fails closed and cannot write any subject under stale key state.
