# Google SSO — Randori Circle

LeetCode does **not** offer public OAuth (no client_id/secret, no consent screen) — it's internal GraphQL + cookies only. So we use Google OAuth 2.0.

This repo already has email/password auth (`auth_accounts` in Turso + JWT). Google SSO builds on the same account store, but the application session is kept in a 12-hour `Secure`, `HttpOnly`, `SameSite=Lax` cookie rather than a URL or `localStorage`.

### What to set in Vercel

In Vercel Dashboard → your project → Settings → Environment Variables add:

- `GOOGLE_CLIENT_ID` — from Google Cloud
- `GOOGLE_CLIENT_SECRET` — from Google Cloud
- `APP_URL` — optional, defaults to `https://randori-circle-self.vercel.app`. Set to same prod URL. If you also test locally add `http://localhost:3000` separately and add both redirect URIs in Google.
- `JWT_SECRET` — already required (e.g. `openssl rand -base64 48`)
- `CRON_SECRET` — required separately from `JWT_SECRET`; protects the weekly cron
- `SIGNUP_ALLOWLIST` — comma-separated private-beta Google email addresses
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

No extra API needs enabling — Google Identity is on by default.

### Flow

- User clicks "Continue with Google" (`#authGoogle`) → `GET /api/auth/google/start` creates cryptographically random OAuth state and a PKCE verifier in short-lived HttpOnly cookies, then redirects to Google. Pair invites may add an exact canonical `return_to` such as `/join/week_12_pair_34`; the server stores the validated path in a separate short-lived cookie.
- Google → consent → redirects to `/api/auth/google/callback?code=...`
- Callback verifies state, exchanges the code with the PKCE verifier, and loads a verified email, name, and stable subject from Google's OpenID userinfo endpoint.
- Lookup `auth_accounts` by lowercased email case-insensitive:
  - not exists → create a Google-only account associated with the verified Google subject.
  - existing Google account → require the same Google subject before updating `last_login`.
  - existing password account → do not silently link it; the user must sign in with the existing method until an explicit linking flow exists.
- Signs a 12-hour application JWT with pinned algorithm, issuer, and audience, stores it only in the session cookie, and redirects to `/?google=success` or the validated pair invite path with `?google=success`.

The callback never accepts a return destination from its query string. It consumes the destination captured at OAuth start, validates it again, and clears all transient cookies. Only `/join/week_<positive integer>_pair_<positive integer>` is accepted; absolute URLs, protocol-relative URLs, encoded or backslash separators, queries, fragments, zeroes, leading zeroes, and malformed room IDs fall back to `/`.

No secrets in git. Native `fetch` used — no new deps.

### Endpoints

- `GET /api/auth/google/start` — starts flow
- `GET /api/auth/google/callback?code=` — finishes, issues JWT, redirects
- `POST /api/auth/signup` is development-only until email verification exists. Existing password users may still use `POST /api/auth/login`; `GET /api/auth/me` reads the protected session.
- `POST /api/auth/logout` clears the session cookie

### Common gotchas

- Redirect URI mismatch → Google shows "redirect_uri_mismatch" — copy exactly from Vercel url, check trailing slash.
- `invalid_grant` / expired code → codes are single-use 5-min. Retry.
- `Missing GOOGLE_CLIENT_ID` JSON → you didn't set env var / didn't redeploy after set.
- Test users: while app in Testing mode, only test emails can sign in — add your circle friends emails to Test users list.

Password email verification and an explicit Google/password account-linking flow remain follow-up work before a broad public launch. Production private-beta enrollment therefore requires verified Google sign-in plus `SIGNUP_ALLOWLIST`.
