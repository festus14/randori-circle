# Randori production bootstrap guide

This is the one operator checklist for taking Randori from "deployed but dark"
to an invite-only MVP: one primary circle, Google sign-in, weekly pairing,
scheduling, and outbox-delivered email. It names every value the code reads and
the order in which the protected workflows must run. It authorizes no
production mutation by itself.

Canonical production origin and Google callback:

```text
APP_URL       https://randori-circle-self.vercel.app
Google origin https://randori-circle-self.vercel.app
Callback      https://randori-circle-self.vercel.app/api/auth/google/callback
```

`APP_URL` must be exactly that origin: HTTPS, no path, query, fragment, or
credentials (`api/_auth-config.js`). The callback is derived from it; a
trailing slash, another host, or a preview URL fails closed.

## Never do these

- Do not paste secrets into chat, issues, pull requests, commit messages,
  screenshots, or repository files. Type them straight into the provider
  dashboard or password manager.
- Do not commit `.env`, `.env.local`, tokens, or generated key material.
- Do not run `npm run db:migrate` against Turso; it accepts only local `file:`
  URLs by design. Remote status/adopt/apply runs only through the protected
  **Turso production migration** workflow.
- Do not use LeetCode session cookies, credentials, or premium content.
  Randori ships reviewed original catalogue content and authorized adapters only.
- Do not set any `*_ENABLED` flag to `true` before its gate below is green.

## 0. Current state (verified 2026-10-18)

| Probe | Result | Meaning |
| --- | --- | --- |
| `GET /` | 200 | Static app deploys from `main` |
| `GET /api/health/live` | 200 `{"ok":true,"status":"live"}` | Functions run |
| `GET /api/health` | 503 `{"ok":false,"status":"unavailable"}` | Fail-closed: no ready database |
| `GET /api/auth/capabilities` | `googleOAuth:false`, `passwordSignup:false`, `registrationMode:"private_beta"` | Google not configured |

GitHub environments `Production`, `Preview`, and `turso-migration-rehearsal`
exist but hold no secrets or variables; `turso-production-migration` and
`credential-key-control` do not exist yet. GitHub environment names are
case-insensitive, so the existing `Production` environment is the one
`outbox-dispatch.yml` uses as `production`. `Preview` is not used by any
workflow.

Expected failures until setup finishes:

- `outbox-dispatch` (every 5 min) fails with
  `outbox scheduler configuration missing` because `production` has no
  `APP_URL` variable or `CRON_SECRET` secret.
- `outbox-dispatch-watchdog` (hourly :37) fails because it cannot read
  `/api/cron/outbox-health` (missing `APP_URL`/`CRON_SECRET` or database not
  ready) or because due mail is older than 15 minutes.
- `Turso backup restore watchdog` (hourly :47) fails because no Monday
  rehearsal has succeeded since the 2026-09-21 activation epoch.
- `execution-smoke` (daily 07:29 UTC and after each Vercel Production deploy)
  fails with `config_missing` until `production` has `APP_URL` and
  `CRON_SECRET`, then with `misconfigured` until Vercel has
  `EXECUTION_PROVIDER`, then with `unavailable` until the database is ready
  (section 10.0).

## 1. Who does what

**(a) Owner-only, in provider consoles.** No automation can do these:

| Provider | Console | Produces |
| --- | --- | --- |
| Turso | [app.turso.tech](https://app.turso.tech/) and the [CLI](https://docs.turso.tech/cli/installation) | Database, DB auth token, Platform API token, org slug, group, `DbId`, hostname |
| Vercel | [Environment variables](https://vercel.com/festus14s-projects/randori-circle/settings/environment-variables), [Domains](https://vercel.com/festus14s-projects/randori-circle/settings/domains) | Production runtime environment |
| Google Cloud | [New project](https://console.cloud.google.com/projectcreate), [Auth Platform](https://console.cloud.google.com/auth/overview), [Credentials](https://console.cloud.google.com/apis/credentials) | `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` |
| Resend | [Domains](https://resend.com/domains), [API keys](https://resend.com/api-keys) | Verified sender, `RESEND_API_KEY`, `RESEND_FROM` |
| GitHub | [Environments](https://github.com/festus14/randori-circle/settings/environments) | Protected workflow secrets and variables |

**(b) App-owned secrets, generated locally** (section 2). These are random
values, not provider accounts.

**(c) Protected operations, in order** (sections 8 and 9): rehearsal → status →
adopt/apply one step at a time → four key-control adoptions → first owner →
`POST /api/init` → minimal flags.

## 2. Generate application-owned secrets

Generate each value separately, store it in a password manager, and never reuse
one value for two names.

Hex secrets (64 hex characters; the code requires at least 32 bytes/characters):

```bash
openssl rand -hex 32   # JWT_SECRET
openssl rand -hex 32   # CRON_SECRET
openssl rand -hex 32   # RUN_ATTESTATION_SECRET (optional; falls back to JWT_SECRET)
openssl rand -hex 32   # MIGRATION_DIGEST_HMAC_KEY
```

Key-ring keys must be exactly 32 bytes as unpadded base64url (43 characters,
`api/_key-rotation.js`). Run once per key:

```bash
openssl rand -base64 32 | tr '+/' '-_' | tr -d '=\n'; echo
```

Generate four different values:

- `EMAIL_VERIFICATION_ENCRYPTION_KEY`
- `INVITATION_EMAIL_ENCRYPTION_KEY`
- `PASSWORD_RESET_ENCRYPTION_KEY`
- `IDENTITY_EMAIL_HASH_KEY`

All four are required even for the MVP: migration v15 seeds one control per
purpose and the protected sequence adopts all four. Cross-purpose reuse is
rejected (`KEY_RING_CROSS_PURPOSE_REUSE`). Rotating `JWT_SECRET` signs everyone
out; the four ring keys rotate only through [KEY_ROTATION.md](KEY_ROTATION.md).

## 3. Turso database and credentials

Install the CLI ([guide](https://docs.turso.tech/cli/installation)) and sign in:

```bash
brew install tursodatabase/tap/turso
turso auth login
turso org list                 # TURSO_ORGANIZATION = the slug
turso group list               # TURSO_GROUP, normally "default"
# Only if no group exists yet:
turso group create default --location lhr
```

### 3.1 Choose the database path

The protected rehearsal and migrator accept only a `managed` database (complete
migration ledger) or an adoptable `unmanaged` one (exact legacy schema, no
ledger). **A brand-new empty Turso database is classified `fresh` and is
rejected**: the rehearsal fails with `REHEARSAL_MIGRATION_STATE_INVALID`
(`detectEvidenceMigration` in `scripts/turso-backup-restore-rehearsal.mjs`), and
`scripts/turso-production-migrate.mjs` refuses any target that is not managed or
unmanaged. No protected workflow can therefore take an empty database to v1.

- **Path A: an existing Randori Turso database already holds data.** Use it.
  Skip to 3.2. The protected sequence adopts or advances it.
- **Path B: no database exists yet.** There are two options. The owner must pick
  one explicitly:
  1. *Recommended long term:* a reviewed code change that teaches the protected
     rehearsal and migrator to bootstrap a `fresh` source. Open a follow-up
     issue; nothing below runs until it merges.
  2. *Works with today's code:* create the database from a locally migrated,
     data-free SQLite file. The local runner is used only on a local file, never
     against Turso. Run from a clean checkout of current `main`:

     ```bash
     SEED_DIR="$(mktemp -d)"
     npm ci
     npm run --silent db:migrate -- status --database "file://${SEED_DIR}/randori.db"
     # Expect "state":"fresh"; copy its stateFingerprint.
     npm run --silent db:migrate -- apply --database "file://${SEED_DIR}/randori.db" \
       --expected-state <fresh-stateFingerprint>
     npm run --silent db:migrate -- status --database "file://${SEED_DIR}/randori.db"
     # Expect "state":"managed", currentVersion == latestVersion, pendingVersions [], blockers [].
     turso db create randori-circle --group default --from-file "${SEED_DIR}/randori.db"
     rm -rf "${SEED_DIR}"
     ```

     The file has no accounts or data. Its four v15 credential controls are
     `uninitialized`, which is the state the key-control workflow expects to
     adopt. Production schema then changes only through the protected workflow.

### 3.2 Collect identity values

```bash
turso db show randori-circle          # Name, ID (DbId), Group, URL
turso db show randori-circle --url    # libsql://<hostname>
turso db tokens create randori-circle --expiration 30d   # TURSO_AUTH_TOKEN (full access)
```

| Value | Where it goes |
| --- | --- |
| `libsql://…` URL | `TURSO_DATABASE_URL`: Vercel Production and `credential-key-control` secret |
| DB auth token | `TURSO_AUTH_TOKEN`: Vercel Production and `credential-key-control` secret. The key-control workflow writes, so do not use `--read-only` |
| Hostname (URL without `libsql://`) | `TURSO_PRODUCTION_DATABASE_HOST` variable in `credential-key-control` |
| Org slug | `TURSO_ORGANIZATION` in both Turso migration environments |
| Group | `TURSO_GROUP` in both Turso migration environments |
| Name `randori-circle` | `TURSO_PRODUCTION_DATABASE_NAME` in both Turso migration environments |
| `DbId` | `TURSO_PRODUCTION_DATABASE_ID` in both Turso migration environments |

Rotate the 30-day DB token before it expires, in both stores. A longer
lifetime is a documented exception, not the default.

### 3.3 Platform API token (GitHub only)

The rehearsal reads database metadata and configuration, toggles
`block_writes`, creates a PITR restore, mints short-lived DB tokens, and deletes
only the verified disposable restore. Mint a group-scoped token with exactly
those scopes ([docs](https://docs.turso.tech/cli/auth/api-tokens/mint)):

```bash
turso auth api-tokens mint randori-github-ops --org <org-slug> --group default \
  --scope read --scope db:create --scope db:configure \
  --scope db:mint-token --scope db:delete
```

This value is `TURSO_PRODUCTION_PLATFORM_TOKEN` in both Turso migration
environments. It is never a Vercel variable and never the app's
`TURSO_AUTH_TOKEN`. Do not grant `db:rotate-creds` or `group:rotate-creds`.

### 3.4 Write-block state and PITR plan

`TURSO_PRODUCTION_EXPECTED_BLOCK_WRITES` must describe reality. It is `false`
for a new database. To confirm without exposing a secret value:

```bash
curl -s -H "Authorization: Bearer $TURSO_PLATFORM_TOKEN" \
  "https://api.turso.tech/v1/organizations/<org-slug>/databases/randori-circle/configuration"
# use the reported block_writes value
```

PITR on the Free plan: Turso's [pricing page](https://turso.tech/pricing) lists
Point-In-Time Restore **1 day** on Free, 10 days on Developer, and 30 days on
Scaler. Each restore temporarily uses one database slot and storage quota. The
rehearsal needs a snapshot no older than 30 minutes, so the 1-day window is
sufficient on paper. No real Free-plan rehearsal has been run yet, so treat
Free-plan support as unverified until the first rehearsal succeeds.

## 4. Vercel Production environment

[Environment variables](https://vercel.com/festus14s-projects/randori-circle/settings/environment-variables).
Scope every value to **Production** only.

### Required runtime

| Name | Value |
| --- | --- |
| `APP_URL` | `https://randori-circle-self.vercel.app` |
| `TURSO_DATABASE_URL` | Production `libsql://` URL |
| `TURSO_AUTH_TOKEN` | DB auth token |
| `JWT_SECRET` | Generated hex |
| `CRON_SECRET` | Generated hex. Vercel cron sends it as `Authorization: Bearer`, and GitHub must hold the identical value |
| `OUTBOX_DISPATCH_SECRET` | Optional. Separate generated hex (at least 32 chars, different from `CRON_SECRET`) for the external outbox scheduler. Works only on `/api/cron/outbox` and `/api/cron/outbox-health`. Store it in cron-job.org, not GitHub. See [OUTBOX_EXTERNAL_SCHEDULER.md](OUTBOX_EXTERNAL_SCHEDULER.md) |
| `RUN_ATTESTATION_SECRET` | Generated hex (recommended) |
| `PAIRING_TIME_ZONE` | `Europe/London` |
| `ADMIN_EMAILS` | The owner's Google email |
| `SIGNUP_ALLOWLIST` | The same email. Before `/api/init`, only allowlisted Google accounts can register |
| `GOOGLE_CLIENT_ID` | From section 5 |
| `GOOGLE_CLIENT_SECRET` | From section 5 |
| `RESEND_API_KEY` | From section 6 |
| `RESEND_FROM` | From section 6, e.g. `Randori <noreply@mail.example.com>` |
| `EXECUTION_PROVIDER` | `vercel-sandbox`. Enables "Run" in a per-run Vercel Sandbox microVM using the project's OIDC token (no extra secret). Leave unset to keep execution explicitly unavailable. See ID-62 |

### Key rings (staged dark; must equal the GitHub copies byte for byte)

| Name | Value |
| --- | --- |
| `EMAIL_VERIFICATION_ENCRYPTION_KEY` | Generated base64url |
| `EMAIL_VERIFICATION_ENCRYPTION_KEY_VERSION` | `1` |
| `EMAIL_VERIFICATION_ENCRYPTION_PREVIOUS_KEYS` | `[]` |
| `EMAIL_VERIFICATION_ENVELOPE_WRITE_VERSION` | `1` |
| `INVITATION_EMAIL_ENCRYPTION_KEY` | Generated base64url |
| `INVITATION_EMAIL_ENCRYPTION_KEY_VERSION` | `1` |
| `INVITATION_EMAIL_ENCRYPTION_PREVIOUS_KEYS` | `[]` |
| `INVITATION_EMAIL_ENVELOPE_WRITE_VERSION` | `1` |
| `PASSWORD_RESET_ENCRYPTION_KEY` | Generated base64url |
| `PASSWORD_RESET_ENCRYPTION_KEY_VERSION` | `1` |
| `PASSWORD_RESET_ENCRYPTION_PREVIOUS_KEYS` | `[]` |
| `PASSWORD_RESET_ENVELOPE_WRITE_VERSION` | `1` |
| `IDENTITY_EMAIL_HASH_KEY` | Generated base64url |
| `IDENTITY_EMAIL_HASH_KEY_VERSION` | `1` |
| `IDENTITY_EMAIL_HASH_PREVIOUS_KEYS` | `[]` |

### Initial flags (all dark)

```text
CIRCLE_MEMBERSHIP_ENABLED=false
MULTI_CIRCLE_CONTROL_PLANE_ENABLED=false
MULTI_CIRCLE_AVAILABILITY_ENABLED=false
SECONDARY_CIRCLE_COORDINATION_ENABLED=false
SECONDARY_CIRCLE_SCHEDULING_ENABLED=false
SECONDARY_CIRCLE_PAIRING_EMAIL_ENABLED=false
SECONDARY_CIRCLE_SCHEDULE_EMAIL_ENABLED=false
INVITATION_EMAIL_DELIVERY_ENABLED=false
INVITE_REQUESTS_ENABLED=false
REMINDERS_ENABLED=false
REMINDERS_SESSION_SOON_ENABLED=false
PROGRESS_DASHBOARD_ENABLED=false
EMAIL_PASSWORD_ACTIVATION_ENABLED=false
PASSWORD_RESET_ENABLED=false
IDENTITY_MANAGEMENT_ENABLED=false
CHAT_RETENTION_ENABLED=false
CHAT_RETENTION_MODE=dry_run
AI_ENABLED=false
ALLOW_OPEN_SIGNUP=false
```

Leave `GROQ_API_KEY`, `OPENAI_API_KEY`, and `SENTRY_DSN` unset unless
deliberately enabling those optional providers. Sentry is environment-scoped
(#252): the server reports only when Vercel's own `VERCEL_ENV` is `production`
(or, off Vercel, `SENTRY_ENVIRONMENT=production`), never under the local
runtime, `NODE_ENV=test` or CI, and previews stay silent unless
`SENTRY_ENABLE_PREVIEW=true` is set for the Preview environment. The browser
loader in `index.html` reports only from `https://randori-circle-self.vercel.app`;
update its `PRODUCTION_ORIGIN` together with `APP_URL`. The same origin check
makes the browser logger send only signed-in, redacted `warn`/`error` entries
to `/api/logs` (ID-72); they appear in the admin logs panel and are kept 30
days. After saving, redeploy the
latest production deployment (Deployments → ⋯ → Redeploy); Vercel reads
variables only at build/deploy time.

## 5. Google OAuth client

1. [Create project](https://console.cloud.google.com/projectcreate)
   **Randori Circle** and switch to it.
2. [Google Auth Platform](https://console.cloud.google.com/auth/overview) → Get
   started: app name `Randori Circle`, support and contact email = owner,
   audience **External**. Under Data Access add `openid`, `.../auth/userinfo.email`,
   and `.../auth/userinfo.profile`.
3. Audience: while the app is in **Testing**, only listed test users (max 100)
   can sign in. Either add every invitee as a test user, or **Publish app**.
   These three non-sensitive scopes do not need Google verification.
4. [Credentials](https://console.cloud.google.com/apis/credentials) → Create
   credentials → OAuth client ID → **Web application**, name `Randori Web`.
   - Authorized JavaScript origin: `https://randori-circle-self.vercel.app`
   - Authorized redirect URI: `https://randori-circle-self.vercel.app/api/auth/google/callback`
5. Copy Client ID → `GOOGLE_CLIENT_ID` and Client secret →
   `GOOGLE_CLIENT_SECRET` in Vercel Production. Redeploy.

Google readiness does not need the database: after the redeploy,
`/api/auth/capabilities` should report `googleOAuth:true` (while
`IDENTITY_MANAGEMENT_ENABLED` stays false).

## 6. Resend

1. [Domains](https://resend.com/domains) → add a domain or subdomain you
   control (e.g. `mail.example.com`), publish the shown DNS records, and wait
   for **Verified**.
2. [API keys](https://resend.com/api-keys) → create a key with **Sending
   access** restricted to that domain.
3. Vercel Production: `RESEND_API_KEY=<key>` and
   `RESEND_FROM=Randori <noreply@mail.example.com>` (the address must use the
   verified domain).

Resend values alone send nothing until the outbox has work. Primary-circle
pairing and schedule emails need only Resend, `APP_URL`, and the outbox
dispatcher. Invitation email additionally needs
`INVITATION_EMAIL_DELIVERY_ENABLED=true` (section 10).

## 7. GitHub protected environments

[Environments](https://github.com/festus14/randori-circle/settings/environments).
For each environment, set **Deployment branches → Selected branches → `main`**.

### `production` (existing `Production`): outbox dispatcher and watchdog

| Kind | Name | Value |
| --- | --- | --- |
| Variable | `APP_URL` | `https://randori-circle-self.vercel.app` |
| Secret | `CRON_SECRET` | Identical to Vercel `CRON_SECRET` |

Do not add a required reviewer; it runs every five minutes. The hourly
`outbox-dispatch-watchdog` uses the same two values to read
`/api/cron/outbox-health`, and `execution-smoke` uses them to call
`POST /api/cron/execution-smoke` (section 10).

Vercel creates its GitHub deployments by commit SHA, so `deployment_status`
runs have no branch ref. If **Selected branches → `main`** blocks those runs,
`execution-smoke` still runs daily and on demand from `main`, but loses its
post-deploy run. Check the first post-deploy run after adding the policy.

### `turso-migration-rehearsal` (existing): PITR rehearsal

No required reviewer, because the Monday 03:17 UTC schedule must run unattended.

| Kind | Name | Value |
| --- | --- | --- |
| Secret | `TURSO_PRODUCTION_PLATFORM_TOKEN` | Section 3.3 |
| Secret | `MIGRATION_DIGEST_HMAC_KEY` | Generated hex (at least 32 bytes) |
| Variable | `TURSO_ORGANIZATION` | Org slug |
| Variable | `TURSO_GROUP` | `default` (or the actual group) |
| Variable | `TURSO_PRODUCTION_DATABASE_NAME` | `randori-circle` |
| Variable | `TURSO_PRODUCTION_DATABASE_ID` | `DbId` |
| Variable | `TURSO_PRODUCTION_EXPECTED_BLOCK_WRITES` | `false` (or the observed value) |
| Variable | `TURSO_RESTORE_DATABASE_PREFIX` | `randori-rehearsal` (lowercase, `[a-z0-9-]`, ≤64) |
| Variable | `REHEARSAL_MAX_SNAPSHOT_AGE_MS` | `1800000` |
| Variable | `REHEARSAL_MAX_EVIDENCE_AGE_MS` | `1800000` (cannot exceed the 30-minute attestation cap) |

RPO `1800000` and RTO `900000` are workflow constants here, not variables.

### `turso-production-migration` (create): status/adopt/apply

Add yourself as a required reviewer.

| Kind | Name | Value |
| --- | --- | --- |
| Secret | `TURSO_PRODUCTION_PLATFORM_TOKEN` | Same as rehearsal |
| Secret | `MIGRATION_DIGEST_HMAC_KEY` | **Same** as rehearsal (it verifies the rehearsal's signature) |
| Variable | `TURSO_ORGANIZATION` | Same as rehearsal |
| Variable | `TURSO_GROUP` | Same as rehearsal |
| Variable | `TURSO_PRODUCTION_DATABASE_NAME` | `randori-circle` |
| Variable | `TURSO_PRODUCTION_DATABASE_ID` | `DbId` |
| Variable | `TURSO_PRODUCTION_EXPECTED_BLOCK_WRITES` | Same as rehearsal |
| Variable | `MIGRATION_REHEARSAL_MAX_AGE_MS` | `1800000` (maximum allowed) |
| Variable | `REHEARSAL_RPO_TARGET_MS` | `1800000` (fixed) |
| Variable | `REHEARSAL_RTO_TARGET_MS` | `900000` (fixed) |
| Variable | `TURSO_PRODUCTION_MIGRATIONS_ENABLED` | `false` |

### `credential-key-control` (create): v15 key adoption

Add yourself as a required reviewer.

| Kind | Name | Value |
| --- | --- | --- |
| Secret | `TURSO_DATABASE_URL` | Production `libsql://` URL |
| Secret | `TURSO_AUTH_TOKEN` | Full-access DB token |
| Secret | `EMAIL_VERIFICATION_ENCRYPTION_KEY` | Same as Vercel |
| Secret | `EMAIL_VERIFICATION_ENCRYPTION_PREVIOUS_KEYS` | `[]` |
| Secret | `INVITATION_EMAIL_ENCRYPTION_KEY` | Same as Vercel |
| Secret | `INVITATION_EMAIL_ENCRYPTION_PREVIOUS_KEYS` | `[]` |
| Secret | `PASSWORD_RESET_ENCRYPTION_KEY` | Same as Vercel |
| Secret | `PASSWORD_RESET_ENCRYPTION_PREVIOUS_KEYS` | `[]` |
| Secret | `IDENTITY_EMAIL_HASH_KEY` | Same as Vercel |
| Secret | `IDENTITY_EMAIL_HASH_PREVIOUS_KEYS` | `[]` |
| Variable | `TURSO_PRODUCTION_DATABASE_HOST` | Hostname only, e.g. `randori-circle-<org>.<region>.turso.io` |
| Variable | `CREDENTIAL_KEY_CONTROL_MUTATIONS_ENABLED` | `false` |
| Variable | `EMAIL_VERIFICATION_ENCRYPTION_KEY_VERSION` | `1` |
| Variable | `EMAIL_VERIFICATION_ENVELOPE_WRITE_VERSION` | `1` |
| Variable | `INVITATION_EMAIL_ENCRYPTION_KEY_VERSION` | `1` |
| Variable | `INVITATION_EMAIL_ENVELOPE_WRITE_VERSION` | `1` |
| Variable | `PASSWORD_RESET_ENCRYPTION_KEY_VERSION` | `1` |
| Variable | `PASSWORD_RESET_ENVELOPE_WRITE_VERSION` | `1` |
| Variable | `IDENTITY_EMAIL_HASH_KEY_VERSION` | `1` |

Confirm names (values are never shown):

```bash
for env in production turso-migration-rehearsal turso-production-migration credential-key-control; do
  echo "== $env"; gh variable list --env "$env"; gh secret list --env "$env"
done
```

Once `production` is populated, the next `outbox-dispatch` run should reach
`/api/cron/outbox`. It still fails until the database is ready; that is
expected.

## 8. Protected migration sequence

Every step uses the same latest `main` commit. Any merge to `main` or any
production mutation invalidates the previous rehearsal and fingerprint. Only
manually dispatched rehearsals authorize migration; scheduled ones are
monitoring evidence only.

1. **Rehearse.** Actions → **Turso backup restore rehearsal** → Run workflow on
   `main` → confirmation `RESTORE_DISPOSABLE_ONLY`. Wait for success and the
   `turso-backup-restore-rehearsal-<run>-<attempt>` artifact. Note the run ID
   and attempt.
2. **Status** (within 30 minutes). Actions → **Turso production migration**:
   operation `status`, `rehearsal_run_id`/`rehearsal_run_attempt` from step 1,
   `expected_state_fingerprint` empty, `target_version` empty, confirmation
   `INSPECT_PRODUCTION_DATABASE`. Download `migration-result.json` and read
   `state`, `stateFingerprint`, `nextVersion`, and `pendingVersions`.
3. **Adopt (unmanaged only).** Set `TURSO_PRODUCTION_MIGRATIONS_ENABLED=true`,
   dispatch `adopt` with the status fingerprint, empty target, the same
   rehearsal run/attempt, confirmation `MIGRATE_PRODUCTION_DATABASE`. Set the
   variable back to `false`. Return to step 1.
4. **Apply one version (managed with `nextVersion`).** Set the variable to
   `true`, dispatch `apply` with the status fingerprint,
   `target_version = nextVersion`, the same rehearsal run/attempt, and
   confirmation `MIGRATE_PRODUCTION_DATABASE`. Set it back to `false`. Return to
   step 1. Never batch, skip, or reuse a fingerprint. After migration v15
   applies and before applying v16, complete step 5.
5. **Adopt the four key controls** (once v15 is present). Actions →
   **Credential key control**: for each purpose `email-activation`,
   `password-reset`, `invitation-email`, `identity-email-observation`:
   - `status`, confirmation `INSPECT_CREDENTIAL_KEY_CONTROL`, expected
     version/generation empty;
   - set `CREDENTIAL_KEY_CONTROL_MUTATIONS_ENABLED=true`, run `adopt`
     (confirmation `CHANGE_CREDENTIAL_KEY_CONTROL`, expected fields empty), then
     set it back to `false`;
   - `status` again and expect accepted at version 1.
6. **Finish.** A fresh rehearsal plus `status` reports `nextVersion: null`,
   `pendingVersions: []`, and `capabilities.apply: false`; all four controls are
   accepted; `GET /api/health` returns 200 `{"ok":true,"status":"ready"}`.

Path B.2 databases start at the latest version, so step 2 reports
`nextVersion: null`. Go straight to step 5, then step 6.

Any nonzero result means stop. Do not retry a mutation with the same
fingerprint; rehearse, inspect, and decide. Details:
[TURSO_PRODUCTION_MIGRATION.md](TURSO_PRODUCTION_MIGRATION.md),
[TURSO_BACKUP_RESTORE_REHEARSAL.md](TURSO_BACKUP_RESTORE_REHEARSAL.md),
[KEY_ROTATION.md](KEY_ROTATION.md).

## 9. Bootstrap administrator and data-only initialization

1. Sign in at `https://randori-circle-self.vercel.app` with Google, using the
   email in both `ADMIN_EMAILS` and `SIGNUP_ALLOWLIST`.
2. Confirm `GET /api/auth/me` reports `is_admin: true`.
3. In that signed-in tab's developer console run:

   ```js
   fetch('/api/init', {method: 'POST', credentials: 'same-origin'})
     .then(r => r.json()).then(console.log)
   ```

   Expect `{ok: true, message: "Primary circle data ready", circle_id, changed: true}`.
   This creates the primary circle, owner membership, audit evidence, and
   closes uninvited registration. It never changes schema. A repeat returns
   `changed: false`. A 503 `data unavailable` means the schema is not exactly
   current, so go back to section 8.
   See [ADMIN_DATA_INITIALIZATION.md](ADMIN_DATA_INITIALIZATION.md).

## 10. Minimum MVP flag set

Change only these in Vercel Production, redeploying after each step:

1. `CIRCLE_MEMBERSHIP_ENABLED=true` (after `/api/init` succeeds). This enables
   primary-circle membership, owner invitations (manual copy-link always
   works), pairing, and scheduling. `SIGNUP_ALLOWLIST` no longer governs access.
2. `INVITATION_EMAIL_DELIVERY_ENABLED=true` (after Resend is Verified, the
   `invitation-email` control is accepted, and `outbox-dispatch` runs green).
3. `EXECUTION_PROVIDER=vercel-sandbox` (if not already set), then run
   `vercel env pull .env.local && npm run smoke:execution` from a linked
   checkout and complete one JavaScript and one Python run in the product.

After every Vercel production deploy (deployments created by `vercel[bot]`;
GitHub's own `production` environment deployments are ignored) the
`production-smoke` workflow (also daily and on demand) runs
`npm run smoke:production`: anonymous, read-only GETs that
check client routes (`/invite`, `/verify`, `/reset-password`, `/join/...`, an
unknown path) serve the app shell, `/index.html` redirects, health probes,
`/api/auth/capabilities`, a static asset, and security headers. It is not a
required check. Run it locally with `npm run smoke:production` (behind a proxy
add `NODE_USE_ENV_PROXY=1`). After intentionally changing an auth flag, either
update the defaults in `scripts/production-smoke.mjs` or pass
`SMOKE_EXPECTED_CAPABILITIES='{"googleOAuth":false}'` (use `null` to skip a key).

### 10.0 Live execution smoke (`execution-smoke`)

CI mocks the execution provider, so it cannot see a provider outage or
retirement (#248). The `execution-smoke` workflow covers that gap. It runs
after each successful Vercel Production deployment (deployments created by
`vercel[bot]` only), daily at 07:29 UTC, and on demand. It calls
`POST /api/cron/execution-smoke` with `CRON_SECRET` and the body
`{"trigger":"deploy"}` for post-deploy runs or `{"trigger":"schedule"}` for
scheduled and manual runs. Any other body gets `400`.
`OUTBOX_DISPATCH_SECRET` is rejected.

The route runs one fixed trivial JavaScript program and one fixed trivial
Python program through `api/_execution.js` with the production
`EXECUTION_PROVIDER` settings. It checks for the exact expected output and
returns only this:

```json
{"ok":true,"checkedAt":"…","languages":{
  "javascript":{"status":"ok","durationMs":812},
  "python":{"status":"ok","durationMs":905}}}
```

Each `status` is one of `ok`, `provider_error`, `timeout`, `misconfigured` or
`throttled`. The response never contains program output, provider URLs,
tokens or error text.

- **Throttling.** A real run is claimed atomically in `app_logs` against the
  database clock, under the server-only `runner` source.
  - Real runs are at least 30 minutes apart.
  - Each trigger has its own slot: one `schedule` run per 20 hours and one
    `deploy` run per 24 hours. Deploy runs can never use up the daily
    scheduled run.
  - Inside a window the route returns `throttled`. `ageSeconds` is the age of
    the latest real run, and `lastStatus`, `durationMs` and `checkedAt` come
    from the result saved for that exact run.
- **Lost results.** A run can lose its result if the function is killed or
  the write fails. The latest run counts as in flight (`lastStatus: null`)
  only for 165 seconds: the 45-second deadline plus 120 seconds. After that,
  the route reports `lastStatus: "result_missing"`, which fails the job until
  the next real run.
- **Budget.** Each real run creates two sandboxes.
  - The hard ceiling is 70 runs a month: 38 scheduled and 32 post-deploy, or
    140 sandbox creations, under 3% of the Hobby allowance of 5,000.
  - In practice it is one scheduled run a day plus one post-deploy run on
    deploy days.
  - GitHub can start a scheduled run hours late. If the next day's run then
    falls inside the 20-hour slot, it is throttled that day.
- **Misconfiguration.** A missing or invalid provider is reported as
  `misconfigured` immediately, without a claim or any sandbox use.
- **No throttle store.** If the database is unavailable, the route returns
  `503` and never executes. The same applies when the cached result cannot be
  read.

The job passes when each language is `ok`, or `throttled` with a cached
result of `ok` (or a run still in flight). A pass on a cached result adds an
`::notice`, because that run did not test the current deployment. Anything
else fails the run with an `::error` annotation that names only the bounded
categories: `execution_failed`, `unauthorized`, `unavailable`,
`malformed_response`, `config_missing` or `smoke_failure`.

**Notifications.**
- **Post-deploy runs.** They are triggered by `vercel[bot]`'s deployment, so
  GitHub probably emails no one. A failure shows as a red `execution-smoke`
  check on the deployed `main` commit.
- **Scheduled runs.** These are the email path. GitHub emails the failure the
  same way it does for the outbox and backup watchdogs.

**Evidence for #248 and #9.** After setting `EXECUTION_PROVIDER` and
redeploying, open the post-deploy `execution-smoke` run, or trigger it with
**Run workflow** on `main`. The evidence #248 asks for is a run whose JSON
line has `languages.javascript.status` and `languages.python.status` both
equal to `"ok"`. A throttled pass also prints `"status":"healthy"` but shows
`"throttled"` per language, and it does not count. Record the run URL on
#248.

`npm run smoke:execution` is deliberately not in CI. The Vercel Sandbox SDK
authenticates with the project's `VERCEL_OIDC_TOKEN`, which only exists inside
Vercel functions or after `vercel env pull` (needs a Vercel login or a
`VERCEL_TOKEN`). GitHub Actions has neither without adding a new long-lived
Vercel secret. The SDK also opens its own undici connections, so it fails
behind TLS-intercepting corporate proxies. Run it from a personal network.

Everything else stays exactly as in section 4: multi-circle control plane and
availability, secondary-circle flags, email/password activation, password reset,
identity management, chat retention, AI, and open signup. With
`EMAIL_PASSWORD_ACTIVATION_ENABLED=false`, invitees join with Google, so they
must be Google test users or the Google app must be published.

### 10.1 Optional: email + password sign-in, signup, and "Forgot password?"

Password login (`POST /api/auth/login`) is always on; these steps let invitees
create a password account and let password accounts recover. Do them only after
step 1 above, one redeploy per step:

1. Prerequisites: the full migration sequence and all four key-control
   adoptions in section 8 are complete (`email-activation` and `password-reset`
   accepted at version 1); `/api/init` succeeded; `CIRCLE_MEMBERSHIP_ENABLED=true`;
   Resend shows the sender domain **Verified**; `RESEND_API_KEY` and
   `RESEND_FROM` use that domain; `outbox-dispatch` runs green. With the
   `onboarding@resend.dev` test sender Resend delivers only to the Resend
   account owner's own address; every other recipient is rejected and the
   event dead-letters, so invitees never receive verification or reset mail.
2. `EMAIL_PASSWORD_ACTIVATION_ENABLED=true`. The code ignores it while
   `CIRCLE_MEMBERSHIP_ENABLED` is not `true` or the `EMAIL_VERIFICATION_*`
   ring/control is not ready. Capabilities then report
   `passwordSignup:true`, `verifiedEmailActivation:true`,
   `registrationMode:"verified_invite"`. Invitees sign up on the invitation,
   receive a `/verify#token=…` link, and only then get an account and session.
3. `PASSWORD_RESET_ENABLED=true`. Capabilities report `passwordReset:true` and
   the sign-in dialog shows **Forgot password?**. Reset links are
   `APP_URL/reset-password#token=…`, single-use, expire after 30 minutes, and
   revoke every session when used. With membership on, only active members of
   the primary circle who already have a password can request one;
   everyone else (including Google-only accounts) gets the same generic 202
   and no email.
4. Optional, so the Google-created owner account can also sign in with a
   password: `IDENTITY_MANAGEMENT_ENABLED=true` (needs the `IDENTITY_EMAIL_HASH_*`
   ring and the accepted `identity-email-observation` control; without them
   Google sign-in itself fails closed). The owner then opens **Account
   security**, confirms with Google, and adds a password. A Google-only
   account cannot use "Forgot password?" to create a first password.

Mail is sent only when the five-minute `outbox-dispatch` workflow runs, so a
verification or reset email normally arrives within 5–15 minutes, and later if
GitHub delays the schedule. The links still expire after 30 minutes.

## 11. Verify

```bash
curl -s https://randori-circle-self.vercel.app/api/health/live
curl -s -o /dev/null -w '%{http_code}\n' https://randori-circle-self.vercel.app/api/health
curl -s https://randori-circle-self.vercel.app/api/auth/capabilities
gh run list --workflow outbox-dispatch.yml --limit 3
```

| Stage | `/api/health` | Capabilities |
| --- | --- | --- |
| Today | 503 | `googleOAuth:false` |
| After Google + redeploy | 503 until schema ready | `googleOAuth:true`, `passwordSignup:false`, `registrationMode:"private_beta"` |
| MVP live | 200 `ready` | `googleOAuth:true`, `passwordSignup:false`, `verifiedEmailActivation:false`, `passwordReset:false`, `identityManagement:false` |

`outbox-dispatch` and its watchdog turn green once the database is ready. The
backup watchdog turns green after the next successful Monday 03:17 UTC
rehearsal. `execution-smoke` turns green once the database is ready and
`EXECUTION_PROVIDER` works.

If Google stays false, check that `APP_URL` exactly matches the origin, the
Production scoping, `IDENTITY_MANAGEMENT_ENABLED=false`, and that you
redeployed. Never weaken a gate to make a check pass.

## Related runbooks

- [Turso overview and rollout](../TURSO.md)
- [Google OAuth](../GOOGLE_OAUTH.md)
- [Production migration](TURSO_PRODUCTION_MIGRATION.md)
- [Backup/restore rehearsal](TURSO_BACKUP_RESTORE_REHEARSAL.md)
- [Backup watchdog activation](BACKUP_WATCHDOG_ACTIVATION.md)
- [Outbox dispatch watchdog](OUTBOX_DISPATCH_WATCHDOG.md)
- [Outbox external scheduler](OUTBOX_EXTERNAL_SCHEDULER.md)
- [Credential key rotation and adoption](KEY_ROTATION.md)
- [Admin data initialization](ADMIN_DATA_INITIALIZATION.md)
- [Invitation email delivery](INVITATION_EMAIL_DELIVERY.md)
- [Deployment gates](DEPLOYMENT_GATES.md)
