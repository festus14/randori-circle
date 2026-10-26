# Google sign-in broken

Google sign-in is not offered, or fails after the Google consent
screen. The descriptive layer is [SYSTEM_DESIGN.md](../SYSTEM_DESIGN.md)
§3.3 (Google OIDC) and §10/§11.1 (sign-in flow); setup is in
[GOOGLE_OAUTH.md](../../GOOGLE_OAUTH.md).

## Symptoms

- The sign-in dialog shows no "Continue with Google" button, or
  `googleOAuth: false` in capabilities.
- Clicking Google sign-in returns a bare
  `503 {"error":"Google sign-in is unavailable"}`.
- Google shows `redirect_uri_mismatch` instead of the consent screen.
- After Google, the app redirects back with a `google_error`.

## Confirm (read-only)

Check the public capabilities first — no sign-in needed:

```bash
curl -s https://randoricircle.com/api/auth/capabilities
# Expect "googleOAuth":true. If false, the server is not advertising
# Google sign-in at all: configuration, not a Google-side failure.
```

The 503 is deliberately generic: it never discloses which setting is
missing. The checks below distinguish the causes. OAuth is bound to
one origin: the request's `Host` must equal the `APP_URL` host, and on
a secure deployment the forwarded protocol must be `https`. Google
sign-in works only on the `APP_URL` host — visiting the old alias, or
any other host, never offers it.

| Check | Where | Expect |
| --- | --- | --- |
| `APP_URL` | Vercel Production | Exactly `https://randoricircle.com`: HTTPS, no path, query, fragment, or credentials, no trailing slash |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | Vercel Production | Both set; redeploy after any change (Vercel reads variables only at build/deploy time) |
| Authorized JavaScript origins | Google Cloud → Credentials → OAuth client | `https://randoricircle.com` (plus the old alias while the transition entries are kept) |
| Authorized redirect URIs | Same client, exact, no trailing slash | `https://randoricircle.com/api/auth/google/callback` — the server builds exactly `${APP_URL}/api/auth/google/callback` |
| Authorized domains | Google Auth Platform → Branding | `randoricircle.com` |
| Publishing status | Google Auth Platform | **Testing**: only listed test users (max 100) can sign in. **Published**: anyone with the link can sign in. The three scopes (`openid`, `email`, `profile`) are non-sensitive and need no Google verification |
| Consent screen scopes | Google Auth Platform → Data Access | `openid`, `.../auth/userinfo.email`, `.../auth/userinfo.profile` |
| Identity management | Vercel flag + key control | If `IDENTITY_MANAGEMENT_ENABLED=true`, the identity-email-hash ring needs an accepted key control; without it Google sign-in fails closed. If identity linking/re-auth is the failing path, check that control in the `credential-key-control` workflow |

## Fix

- **`redirect_uri_mismatch` on Google's screen:** the redirect URI
  registered in Google does not exactly match
  `${APP_URL}/api/auth/google/callback`. Copy it exactly — no
  trailing slash — and wait for Google to apply it.
- **Capabilities say `googleOAuth: false`:** fix `APP_URL`,
  `GOOGLE_CLIENT_ID`, or `GOOGLE_CLIENT_SECRET` in Vercel and
  redeploy. Also check readiness: a database/key-control failure
  fails Google sign-in closed (see
  [readiness-503 triage](readiness-503.md)).
- **Testing-mode sign-in refused for a member:** add their email as a
  test user, or publish the app.
- **`invalid_state` after returning from Google:** the OAuth
  transaction cookie lives 10 minutes and the authorization code is
  single-use (about 5 minutes). Sign in again; do not retry a stale
  callback URL.
- **Google-only account with no password, "use existing method":**
  Google sign-in never silently links to an existing password
  account. The member signs in with the existing method and links
  Google explicitly from Account security after recent
  authentication (needs `IDENTITY_MANAGEMENT_ENABLED`).

## Verify

```bash
curl -s https://randoricircle.com/api/auth/capabilities
# Expect "googleOAuth":true.
```

Then sign in with Google at `https://randoricircle.com` (not the old
alias) in a clean browser session, and confirm the next
`production-smoke` run is green.
