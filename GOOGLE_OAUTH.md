# Google SSO — Randori Circle

LeetCode does **not** offer public OAuth (no client_id/secret, no consent screen) — it's internal GraphQL + cookies only. So we use Google OAuth 2.0.

This repo already has email/password auth (`auth_accounts` in Turso + JWT). Google SSO builds on same JWT — after Google login we issue our own 30-day JWT and store it in `localStorage randori-token`.

### What to set in Vercel

In Vercel Dashboard → your project → Settings → Environment Variables add:

- `GOOGLE_CLIENT_ID` — from Google Cloud
- `GOOGLE_CLIENT_SECRET` — from Google Cloud
- `APP_URL` — optional, defaults to `https://randori-circle-self.vercel.app`. Set to same prod URL. If you also test locally add `http://localhost:3000` separately and add both redirect URIs in Google.
- `JWT_SECRET` — already required (e.g. `openssl rand -base64 48`)
- `CRON_SECRET` — optional, protects weekly cron
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

- User clicks "Continue with Google" (`#authGoogle`) → `GET /api/auth/google/start` 302 → `accounts.google.com/o/oauth2/v2/auth` with `client_id`, `redirect_uri=${APP_URL}/api/auth/google/callback`, `scope=openid email profile`.
- Google → consent → redirects to `/api/auth/google/callback?code=...`
- Callback exchanges code for tokens (`oauth2.googleapis.com/token`), decodes `id_token` (base64url) for email/name, fallback to `userinfo` endpoint.
- Lookup `auth_accounts` by lowercased email case-insensitive:
  - not exists → INSERT with `display_name` from Google, `color` deterministicColor(name), `password_hash='google-oauth'`, also INSERT into `users` for pairing.
  - exists → UPDATE `last_login`.
- Signs own JWT (`jsonwebtoken` with `JWT_SECRET`, 30d) and redirects to `/?g_token=<jwt>&g_name=<name>` → frontend catches param, stores in `randori-token` + `randori-me`, strips URL via `replaceState`, then `refreshMe()` fetches full user.

No secrets in git. Native `fetch` used — no new deps.

### Endpoints

- `GET /api/auth/google/start` — starts flow
- `GET /api/auth/google/callback?code=` — finishes, issues JWT, redirects
- Existing `POST /api/auth/signup`, `POST /api/auth/login`, `GET /api/auth/me` still work

### Common gotchas

- Redirect URI mismatch → Google shows "redirect_uri_mismatch" — copy exactly from Vercel url, check trailing slash.
- `invalid_grant` / expired code → codes are single-use 5-min. Retry.
- `Missing GOOGLE_CLIENT_ID` JSON → you didn't set env var / didn't redeploy after set.
- Test users: while app in Testing mode, only test emails can sign in — add your circle friends emails to Test users list.

Optional hardening later: store `state` in cookie, verify; add picture from Google token.
