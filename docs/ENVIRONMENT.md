# Environment variables and feature flags

This is the reference for every environment variable that code in `api/`,
`scripts/` and `.github/workflows/` reads, plus the few the test harness
reads. Each entry gives its purpose, whether it is required, its default,
whether it is secret, and where it is set. The
[feature flag table](#feature-flags) lists every flag the code checks, with
its production state.

- Checked against `main` on 2026-10-22. Production state comes from the public
  `GET https://randoricircle.com/api/auth/capabilities` response on that day
  and from the owner's switch-on recorded in
  [PR #352](https://github.com/festus14/randori-circle/pull/352). Values set
  in Vercel are not visible from the repository, so anything else is marked
  as not observable.
- [`.env.example`](../.env.example) is the copy-and-fill template. It names
  every variable on this page. Variables you should never set by hand appear
  there only as comments.
- Vercel reads variables when it builds a deployment. After changing one,
  redeploy (Deployments, then Redeploy) before you expect any effect.
- `*_ENABLED` flags are on only for the exact string `true`. Anything else,
  including `1`, `TRUE` or unset, means off. `OUTBOX_IMMEDIATE_DELIVERY` is
  the one three-state switch (see below).
- How to provision values from scratch is in the
  [production bootstrap guide](PRODUCTION_BOOTSTRAP_GUIDE.md). Key rotation is
  in the [key rotation runbook](KEY_ROTATION.md).

**Where set** uses these labels:

| Label | Meaning |
| --- | --- |
| Vercel | Vercel project, Production scope (and Preview only if you test a preview) |
| GH `production` | GitHub environment `production`, as a variable (var) or secret |
| GH `turso-migration-rehearsal` | GitHub environment used by the Monday PITR rehearsal |
| GH `turso-production-migration` | GitHub environment used by the protected migration workflow |
| GH `credential-key-control` | GitHub environment used by the key-control workflow |
| GH chat-retention env | The staging or production GitHub environment chosen when `chat-retention.yml` is dispatched |
| Workflow literal | A fixed value written in the workflow YAML (and pinned by `check:deployability` or `check:backup-controls`); change it only in a reviewed PR |
| Workflow input | Copied from a `workflow_dispatch` input or computed in the workflow |
| `.env.local` | Your local file for `npm run dev` and operator scripts; gitignored |
| Platform | Set by Vercel, GitHub Actions or Node; never set by hand |

## Application runtime (Vercel)

These configure the deployed app. "Required" means production fails closed
without it: the route returns 503 or the capability is not offered.

### Core

| Variable | Purpose | Required | Default | Secret | Where set |
| --- | --- | --- | --- | --- | --- |
| `TURSO_DATABASE_URL` | libSQL URL of the app database (`libsql://…` in production, `file:` locally). Read by `api/_db.js` and the readiness probes; also by `db:status`/`db:plan` and the key-control and chat-retention scripts | Yes | none | Treat as secret | Vercel; secret in GH `credential-key-control` and GH chat-retention env |
| `TURSO_AUTH_TOKEN` | Database auth token for the URL above. The local runtime refuses to start if it is set | Yes for a remote database | none | Yes | Vercel; secret in GH `credential-key-control` and GH chat-retention env |
| `APP_URL` | Canonical origin used for Google OAuth redirects and for links in emails and pairing publications. Production needs an exact root-level HTTPS origin (`https://randoricircle.com`); `npm run dev` sets its loopback origin itself | Yes | none | No | Vercel; var in GH `production` (outbox dispatcher, watchdog, execution smoke) |
| `JWT_SECRET` | Signs session JWTs and keys invitation, activation and reset token hashes. Rotating it is an emergency global sign-out: it also invalidates pending invitation, activation and reset links, so revoke and reissue invitations and ask anyone mid-reset to request a new link. If `RUN_ATTESTATION_SECRET` is unset, first set it to the current `JWT_SECRET` (or add the old value to `RUN_ATTESTATION_PREVIOUS_SECRETS`), or past runs show as unverified. Invitation email hashes are re-keyed too, so invite-request checks for "already invited" and "recently declined" stop matching rows stored under the old secret | Yes | none | Yes | Vercel |
| `CRON_SECRET` | Authenticates every `/api/cron/*` route (`x-cron-secret` header or `Authorization: Bearer`) | Yes | none | Yes | Vercel; secret in GH `production` (must match Vercel) |
| `OUTBOX_DISPATCH_SECRET` | Narrower secret for the external cron-job.org scheduler. Accepted only on `/api/cron/outbox` and `/api/cron/outbox-health`; ignored if shorter than 32 characters or equal to `CRON_SECRET` (ID-67, [setup](OUTBOX_EXTERNAL_SCHEDULER.md)) | No | unset (disabled) | Yes | Vercel; stored in cron-job.org, never in GitHub |
| `RUN_ATTESTATION_SECRET` | Signs verified execution runs. Must be at least 32 characters | Recommended | falls back to `JWT_SECRET` | Yes | Vercel |
| `RUN_ATTESTATION_PREVIOUS_SECRETS` | Comma-separated former attestation secrets (each at least 32 characters), so older runs still verify after a rotation. Removing one makes the runs it signed appear unverified | No | empty | Yes | Vercel |
| `LOG_ADDRESS_SECRET` | Keys the daily address hash stored on `app_logs` rows (ID-82) | No | falls back to `JWT_SECRET` | Yes | Vercel |
| `PAIRING_TIME_ZONE` | IANA zone for the weekly cycle boundary (Sunday 08:00) | No | `Europe/London` | No | Vercel |
| `ADMIN_EMAILS` | Comma-separated emails granted app admin at sign-in or registration | No | empty | No (personal data) | Vercel |
| `SIGNUP_ALLOWLIST` | Legacy private-beta registration allowlist (comma-separated emails), checked by `registrationAllowed` in `api/auth.js` while circle membership is off. With `CIRCLE_MEMBERSHIP_ENABLED=true`, an invitation governs access instead | No | empty | No (personal data) | Vercel |
| `GOOGLE_CLIENT_ID` | Google OAuth client ID. Google sign-in is offered only when both Google values and a valid `APP_URL` are set | No | unset (Google off) | No | Vercel |
| `GOOGLE_CLIENT_SECRET` | Google OAuth client secret | No | unset (Google off) | Yes | Vercel |
| `RESEND_API_KEY` | Resend API key for all outbox email. In production, email activation, password reset and invitation email are unavailable without it | No | unset (no email sent) | Yes | Vercel |
| `RESEND_FROM` | Sender address on a Resend-verified domain, for example `Randori <noreply@mail.example.com>` | With `RESEND_API_KEY` | unset | No | Vercel |
| `OUTBOX_IMMEDIATE_DELIVERY` | Send auth, invitation, schedule and invite-request notification mail right after commit (ID-64); pairing and reminder mail always waits for the outbox worker. `false` is the kill switch (mail waits for the cron); `true` turns it on off Vercel | No | on when `VERCEL=1`, off elsewhere | No | Vercel (normally unset) |

### Code execution

| Variable | Purpose | Required | Default | Secret | Where set |
| --- | --- | --- | --- | --- | --- |
| `EXECUTION_PROVIDER` | `vercel-sandbox` (one Vercel Sandbox microVM per run, authenticated by the project OIDC token) or `piston` (self-hosted endpoint). Unset or unknown makes Run return 503 `execution_unavailable` (ID-62) | For Run to work | unset (Run unavailable) | No | Vercel (`vercel-sandbox` per the bootstrap guide; `execution-smoke` passed after the 2026-10-22 deploy) |
| `EXECUTION_API_URL` | Full `https://…/api/v2/execute` URL of a self-hosted Piston-compatible service. The retired public emkc.org host is rejected | With `piston` | unset | No | Vercel |
| `EXECUTION_API_TOKEN` | Bearer token sent to the Piston endpoint | No | unset | Yes | Vercel |

### AI providers (AI is off)

| Variable | Purpose | Required | Default | Secret | Where set |
| --- | --- | --- | --- | --- | --- |
| `GROQ_API_KEY` | Primary provider for the consent-gated AI feedback in `api/ai.js` | With `AI_ENABLED=true` (this or `OPENAI_API_KEY`) | unset | Yes | Vercel (leave unset) |
| `OPENAI_API_KEY` | Fallback AI provider | No | unset | Yes | Vercel (leave unset) |

### Error reporting (Sentry)

| Variable | Purpose | Required | Default | Secret | Where set |
| --- | --- | --- | --- | --- | --- |
| `SENTRY_DSN` | Server-side Sentry DSN. Reports only from production (`VERCEL_ENV=production`, or `SENTRY_ENVIRONMENT=production` off Vercel); never from the local runtime, tests or CI | No | unset (no reporting) | Treat as secret | Vercel |
| `NEXT_PUBLIC_SENTRY_DSN` | Fallback name for the same DSN, read only when `SENTRY_DSN` is empty | No | unset | Treat as secret | Vercel (prefer `SENTRY_DSN`) |
| `SENTRY_ENVIRONMENT` | Environment name used off Vercel. `VERCEL_ENV` wins on Vercel | No | `development` | No | Host other than Vercel |
| `SENTRY_ENABLE_PREVIEW` | `true` lets Vercel previews report to Sentry | No | off | No | Vercel, Preview scope only |

### Credential key rings

Four independent key rings protect short-lived tokens and email observations
(ID-19). Keys are 32-byte base64url values. Generate one with
`openssl rand -base64 32 | tr '+/' '-_' | tr -d '='` and never reuse a key across
purposes. Each ring must match its GitHub `credential-key-control` copy byte for
byte. Rotation is staged and forward-only: follow the
[key rotation runbook](KEY_ROTATION.md) and never replace a key in place.

| Variable | Purpose | Required | Default | Secret | Where set |
| --- | --- | --- | --- | --- | --- |
| `EMAIL_VERIFICATION_ENCRYPTION_KEY` | Encrypts queued email-verification (activation) links | With `EMAIL_PASSWORD_ACTIVATION_ENABLED` in production | unset | Yes | Vercel; secret in GH `credential-key-control` |
| `EMAIL_VERIFICATION_ENCRYPTION_KEY_VERSION` | Version number of the active key above | With the key | `1` | No | Vercel; var in GH `credential-key-control` |
| `EMAIL_VERIFICATION_ENCRYPTION_PREVIOUS_KEYS` | JSON array of up to three older keys, newest first: `[{"version":1,"key":"…"}]` | No | `[]` | Yes | Vercel; secret in GH `credential-key-control` |
| `EMAIL_VERIFICATION_ENVELOPE_WRITE_VERSION` | Envelope format written (`1` or `2`); readers accept both | No | `1` | No | Vercel; var in GH `credential-key-control` |
| `PASSWORD_RESET_ENCRYPTION_KEY` | Encrypts queued password-reset links | With `PASSWORD_RESET_ENABLED` in production | unset | Yes | Vercel; secret in GH `credential-key-control` |
| `PASSWORD_RESET_ENCRYPTION_KEY_VERSION` | Version of the active reset key | With the key | `1` | No | Vercel; var in GH `credential-key-control` |
| `PASSWORD_RESET_ENCRYPTION_PREVIOUS_KEYS` | Older reset keys, JSON as above | No | `[]` | Yes | Vercel; secret in GH `credential-key-control` |
| `PASSWORD_RESET_ENVELOPE_WRITE_VERSION` | Reset envelope format written | No | `1` | No | Vercel; var in GH `credential-key-control` |
| `INVITATION_EMAIL_ENCRYPTION_KEY` | Encrypts queued invitation links | With `INVITATION_EMAIL_DELIVERY_ENABLED` | unset | Yes | Vercel; secret in GH `credential-key-control` |
| `INVITATION_EMAIL_ENCRYPTION_KEY_VERSION` | Version of the active invitation key | With the key | `1` | No | Vercel; var in GH `credential-key-control` |
| `INVITATION_EMAIL_ENCRYPTION_PREVIOUS_KEYS` | Older invitation keys, JSON as above | No | `[]` | Yes | Vercel; secret in GH `credential-key-control` |
| `INVITATION_EMAIL_ENVELOPE_WRITE_VERSION` | Invitation envelope format written | No | `1` | No | Vercel; var in GH `credential-key-control` |
| `IDENTITY_EMAIL_HASH_KEY` | HMAC key for provider-email observations (ID-13). With `IDENTITY_MANAGEMENT_ENABLED=true` and no key, Google sign-in fails closed | With `IDENTITY_MANAGEMENT_ENABLED` | unset | Yes | Vercel; secret in GH `credential-key-control` |
| `IDENTITY_EMAIL_HASH_KEY_VERSION` | Monotonic version of the hash key. Must be set explicitly; a version lower than the stored state fails closed | With the key | none | No | Vercel; var in GH `credential-key-control` |
| `IDENTITY_EMAIL_HASH_PREVIOUS_KEYS` | Older hash keys, JSON as above | No | `[]` | Yes | Vercel; secret in GH `credential-key-control` |

### Application feature flags

Every application flag is optional, not secret, off unless set to `true`, and
set in Vercel Production. They are listed with their dependencies and
production state in the [feature flag table](#feature-flags):
`CIRCLE_MEMBERSHIP_ENABLED`, `MULTI_CIRCLE_CONTROL_PLANE_ENABLED`,
`MULTI_CIRCLE_AVAILABILITY_ENABLED`, `SECONDARY_CIRCLE_COORDINATION_ENABLED`,
`SECONDARY_CIRCLE_SCHEDULING_ENABLED`, `SECONDARY_CIRCLE_PAIRING_EMAIL_ENABLED`,
`SECONDARY_CIRCLE_SCHEDULE_EMAIL_ENABLED`, `EMAIL_PASSWORD_ACTIVATION_ENABLED`,
`PASSWORD_RESET_ENABLED`, `IDENTITY_MANAGEMENT_ENABLED`,
`INVITATION_EMAIL_DELIVERY_ENABLED`, `INVITE_REQUESTS_ENABLED`,
`REMINDERS_ENABLED`, `REMINDERS_SESSION_SOON_ENABLED`,
`PROGRESS_DASHBOARD_ENABLED`, `EXERCISE_SUGGESTIONS_ENABLED`,
`CIRCLE_HEALTH_ENABLED`, `ADMIN_DIAGNOSTICS_ENABLED`,
`ACCOUNT_DELETION_ENABLED`, `OUTBOX_PII_RETENTION_ENABLED` and `AI_ENABLED`.
`ALLOW_OPEN_SIGNUP` is the exception: it is development-only, works only in
the local runtime and is ignored when `NODE_ENV=production`.

## Protected GitHub environments

The operator workflows read these values from protected GitHub environments.
None of them are Vercel variables. Values are never printed. To list names
(not values):
`gh variable list --env <name>` and `gh secret list --env <name>`.

### `production`

Used by `outbox-dispatch.yml`, `outbox-dispatch-watchdog.yml` and
`execution-smoke.yml`. Only `APP_URL` (var) and `CRON_SECRET` (secret), both
described above. The deployability gate rejects any other production material
in those workflows.

### `turso-migration-rehearsal` and `turso-production-migration`

Used by `turso-backup-restore-rehearsal.yml` (scheduled, no reviewer) and
`turso-production-migration.yml` (required reviewer). See the
[rehearsal runbook](TURSO_BACKUP_RESTORE_REHEARSAL.md) and the
[migration runbook](TURSO_PRODUCTION_MIGRATION.md).

| Variable | Purpose | Required | Default | Secret | Where set |
| --- | --- | --- | --- | --- | --- |
| `TURSO_PRODUCTION_PLATFORM_TOKEN` | Turso Platform API token (`read`, `db:create`, `db:configure`, `db:mint-token`, `db:delete`). Never the app's `TURSO_AUTH_TOKEN` | Yes | none | Yes | Secret in both environments |
| `MIGRATION_DIGEST_HMAC_KEY` | Signs and verifies rehearsal evidence. Must be identical in both environments | Yes | none | Yes | Secret in both environments |
| `TURSO_ORGANIZATION` | Turso organization slug | Yes | none | No | Var in both |
| `TURSO_GROUP` | Turso database group | Yes | none | No | Var in both |
| `TURSO_PRODUCTION_DATABASE_NAME` | Production database name (`randori-circle`) | Yes | none | No | Var in both |
| `TURSO_PRODUCTION_DATABASE_ID` | Immutable Turso `DbId` of production | Yes | none | No | Var in both |
| `TURSO_PRODUCTION_EXPECTED_BLOCK_WRITES` | The `block_writes` state production must report (`false` normally) | Yes | none | No | Var in both |
| `TURSO_RESTORE_DATABASE_PREFIX` | Name prefix for disposable restore databases (`[a-z0-9-]`, at most 64) | Yes (rehearsal) | none | No | Var in GH `turso-migration-rehearsal` |
| `REHEARSAL_MAX_SNAPSHOT_AGE_MS` | Oldest acceptable PITR snapshot | Yes (rehearsal) | none | No | Var in GH `turso-migration-rehearsal` (`1800000`) |
| `REHEARSAL_MAX_EVIDENCE_AGE_MS` | Oldest acceptable rehearsal evidence (cannot exceed 30 minutes) | Yes (rehearsal) | none | No | Var in GH `turso-migration-rehearsal` (`1800000`) |
| `MIGRATION_REHEARSAL_MAX_AGE_MS` | Oldest rehearsal a migration may rely on | Yes (migration) | none | No | Var in GH `turso-production-migration` (`1800000`) |
| `REHEARSAL_RPO_TARGET_MS` | Recovery point objective, fixed at 30 minutes | Yes | none | No | Workflow literal `1800000` in the rehearsal; var in GH `turso-production-migration` |
| `REHEARSAL_RTO_TARGET_MS` | Recovery time objective, fixed at 15 minutes | Yes | none | No | Workflow literal `900000` in the rehearsal; var in GH `turso-production-migration` |
| `TURSO_PRODUCTION_MIGRATIONS_ENABLED` | Operator gate for `adopt`/`apply`; see the [flag table](#feature-flags) | Yes for mutations | `false` | No | Var in GH `turso-production-migration` |

### `credential-key-control`

Used by `credential-key-control.yml` (required reviewer). Each step exposes
only the selected purpose's ring. Holds the secret `TURSO_DATABASE_URL` and
`TURSO_AUTH_TOKEN` and every key-ring value above (keys and previous keys as
secrets, versions as variables), plus:

| Variable | Purpose | Required | Default | Secret | Where set |
| --- | --- | --- | --- | --- | --- |
| `TURSO_PRODUCTION_DATABASE_HOST` | Exact hostname of the production libSQL URL; any other host is refused | Yes | none | No | Var in GH `credential-key-control` |
| `CREDENTIAL_KEY_CONTROL_MUTATIONS_ENABLED` | Operator gate for `adopt`/`advance`; see the [flag table](#feature-flags) | Yes for mutations | `false` | No | Var in GH `credential-key-control` |

### Chat retention environment

Used by `chat-retention.yml`, dispatched against a protected staging or
production environment. Destructive production use is off. Read the
[chat retention runbook](CHAT_RETENTION.md) before setting any of these.

| Variable | Purpose | Required | Default | Secret | Where set |
| --- | --- | --- | --- | --- | --- |
| `CHAT_RETENTION_ENABLED` | Operator gate for `run` (dry run and purge); while off, `run` queues nothing. See the [flag table](#feature-flags) | For `run` | off | No | Var in GH chat-retention env |
| `CHAT_RETENTION_MODE` | `dry_run` or `purge` | No | `dry_run` | No | Workflow input (computed from the operation) |
| `CHAT_RETENTION_ACTION` | `status`, `run`, `enable`, `disable`, `adopt_scope`, hold, release or `replay` | No | `status` | No | Workflow input (computed from the operation) |
| `CHAT_RETENTION_EXPECTED_GENERATION` | Control generation that `enable` or `disable` must match | For `enable`/`disable` | none | No | Var in GH chat-retention env |
| `CHAT_RETENTION_REASON_CODE` | Bounded reason code for holds, releases and replays | For those operations | none | No | Var in GH chat-retention env |
| `CHAT_RETENTION_SCOPE_KEY` | Retention scope (`local` or a tenant scope key) | For adopt, hold, release and `run` | none | Yes | Secret in GH chat-retention env |
| `CHAT_RETENTION_CIRCLE_ID` | Circle of the scope (not used for `local`) | With a non-local scope | none | Yes | Secret in GH chat-retention env |
| `CHAT_RETENTION_WEEK_ID` | Week of the room | For room-scoped operations (`adopt_scope`, room hold or release, `run`) | none | Yes | Secret in GH chat-retention env |
| `CHAT_RETENTION_PAIR_GROUP_ID` | Pair group of the room | For room-scoped operations | none | Yes | Secret in GH chat-retention env |
| `CHAT_RETENTION_RUN_ID` | Retention run to replay | For `replay` | none | Yes | Secret in GH chat-retention env |
| `CHAT_RETENTION_EXPORT_EVIDENCE_DIGEST` | Digest of the private export evidence | For `run` | none | Yes | Secret in GH chat-retention env |
| `CHAT_RETENTION_EXPORT_SCOPE_BINDING_DIGEST` | Scope-binding digest of the export | For `run` | none | Yes | Secret in GH chat-retention env |
| `CHAT_RETENTION_EXPORT_SOURCE_MAX_MESSAGE_ID` | Highest message ID covered by the export | For `run` | none | Yes | Secret in GH chat-retention env |
| `CHAT_RETENTION_EXPORT_THROUGH_AT` | Export coverage end time | For `run` | none | Yes | Secret in GH chat-retention env |
| `CHAT_RETENTION_EXPORT_COMPLETED_AT` | Export completion time | For `run` | none | Yes | Secret in GH chat-retention env |
| `CHAT_RETENTION_BACKUP_EVIDENCE_DIGEST` | Digest of the provider backup evidence taken after the export | For `run` | none | Yes | Secret in GH chat-retention env |
| `CHAT_RETENTION_BACKUP_SCOPE_BINDING_DIGEST` | Scope-binding digest of the backup | For `run` | none | Yes | Secret in GH chat-retention env |
| `CHAT_RETENTION_BACKUP_SOURCE_MAX_MESSAGE_ID` | Highest message ID covered by the backup | For `run` | none | Yes | Secret in GH chat-retention env |
| `CHAT_RETENTION_BACKUP_THROUGH_AT` | Backup coverage end time | For `run` | none | Yes | Secret in GH chat-retention env |
| `CHAT_RETENTION_BACKUP_COMPLETED_AT` | Backup completion time | For `run` | none | Yes | Secret in GH chat-retention env |
| `CHAT_RETENTION_LOCAL_ADOPTION` | `true` allows `adopt_scope` against a local database only | No | off | No | `.env.local` (local rehearsal only) |

## Workflow constants and inputs

These are written in the workflow YAML or copied from dispatch inputs. They
are not configuration: change a constant only in a reviewed PR, because
`npm run check:deployability` and `npm run check:backup-controls` pin most of
them.

### Fixed workflow constants

| Variable | Workflow | Value and purpose |
| --- | --- | --- |
| `WATCHDOG_DELIVERY_MAX_AGE_MS` | `outbox-dispatch-watchdog` | `900000`: alert when the oldest due email or expired lease is older than 15 minutes |
| `WATCHDOG_SCHEDULE_GRACE_MS` | `outbox-dispatch-watchdog` | `900000`: grace before a late GitHub run is reported (warning only) |
| `WATCHDOG_WORKER_DEADLINE_MS` | `outbox-dispatch-watchdog` | `120000`: dispatcher run deadline |
| `WATCHDOG_API_TIMEOUT_MS` | `outbox-dispatch-watchdog` | `10000`: GitHub and health-endpoint request timeout |
| `WATCHDOG_MAX_PAGES` | `outbox-dispatch-watchdog` | `2`: GitHub run pages to read |
| `WATCHDOG_PER_PAGE` | `outbox-dispatch-watchdog` | `100`: runs per page |
| `WATCHDOG_DEFAULT_BRANCH` | both watchdogs | the repository default branch |
| `WATCHDOG_CONTROL_ACTIVATION_AT` | `turso-backup-restore-watchdog` | `2026-09-21T03:17:00.000Z`: first rehearsal slot the watchdog judges ([activation contract](BACKUP_WATCHDOG_ACTIVATION.md)) |
| `WATCHDOG_MAX_RUN_AGE_MS` | `turso-backup-restore-watchdog` | `691200000` (8 days): oldest acceptable rehearsal |
| `WATCHDOG_STUCK_AFTER_MS` | `turso-backup-restore-watchdog` | `5400000`: an unfinished run older than this is stuck |
| `WATCHDOG_SLOT_GRACE_MS` | `turso-backup-restore-watchdog` | `28800000` (8 hours): grace for late scheduled starts (ID-75) |
| `WATCHDOG_SLOT_DEADLINE_MS` | `turso-backup-restore-watchdog` | `34200000`: absolute deadline for the weekly slot (12:47 UTC) |
| `REHEARSAL_WORKFLOW_PATH` | rehearsal | `.github/workflows/turso-backup-restore-rehearsal.yml` |
| `REHEARSAL_GITHUB_ENVIRONMENT` | rehearsal | `turso-migration-rehearsal` |
| `RESTORE_REHEARSAL_CONFIRM` | rehearsal | `RESTORE_DISPOSABLE_ONLY` (scheduled) or the dispatch confirmation |
| `REHEARSAL_POLL_ATTEMPTS`, `REHEARSAL_POLL_INTERVAL_MS`, `REHEARSAL_POLL_DURATION_MS` | rehearsal | `60`, `5000`, `300000`: restore polling bounds |
| `REHEARSAL_CLEANUP_POLL_ATTEMPTS`, `REHEARSAL_CLEANUP_POLL_INTERVAL_MS`, `REHEARSAL_CLEANUP_POLL_DURATION_MS` | rehearsal | `12`, `2000`, `120000`: cleanup polling bounds |
| `REHEARSAL_EVIDENCE_DURATION_MS` | rehearsal | `300000`: evidence collection bound |
| `BACKUP_MONITOR_MAX_SUCCESS_AGE_MS` | rehearsal (monitor step) | `1800000`: freshest acceptable rehearsal success |
| `TURSO_PLATFORM_TIMEOUT_MS` | rehearsal, migration | `15000`: Turso Platform API timeout |
| `TURSO_DATABASE_TIMEOUT_MS` | rehearsal, migration | `30000`: database request timeout |
| `GITHUB_API_TIMEOUT_MS` | migration | `15000`: GitHub API timeout |
| `MIGRATION_GITHUB_ENVIRONMENT` | migration | `turso-production-migration` |
| `KEY_CONTROL_GITHUB_ENVIRONMENT` | key control | `credential-key-control` |
| `EXECUTION_SMOKE_TIMEOUT_MS` | `execution-smoke` | `100000`: request timeout for the live check |
| `EXECUTION_SMOKE_TRIGGER` | `execution-smoke` | `deploy` for deployment runs, `schedule` otherwise (ID-74) |
| `UI_SCREENSHOTS_PROD_URL`, `UI_SCREENSHOTS_SCOPE`, `UI_SCREENSHOTS_OUT` | `ui-screenshots` | public origin to capture (default `https://randoricircle.com`), `all`/`public`/`local` (default `all`), output directory (default `ui-screenshots`) |
| `SMOKE_BASE_URL` | `production-smoke` | origin to check; empty means `https://randoricircle.com` |

### Dispatch inputs and step values

The protected workflows copy their `workflow_dispatch` inputs into step
environments, validate them in shell, and pass them to the scripts:
`OPERATION`, `CONFIRMATION`, `PURPOSE`, `EXPECTED_VERSION`,
`EXPECTED_GENERATION`, `EXPECTED_STATE`, `TARGET_VERSION`, `REHEARSAL_RUN_ID`,
`REHEARSAL_RUN_ATTEMPT`, `DEFAULT_BRANCH`, `KEY_CONTROL_CONFIRM`,
`KEY_CONTROL_OPERATION`, `KEY_CONTROL_PURPOSE`, `KEY_CONTROL_EXPECTED_VERSION`,
`KEY_CONTROL_EXPECTED_GENERATION`, `PRODUCTION_MIGRATION_CONFIRM`,
`MIGRATION_OPERATION`, `MIGRATION_REHEARSAL_RUN_ID`,
`MIGRATION_REHEARSAL_RUN_ATTEMPT`, `MIGRATION_EXPECTED_STATE` and
`MIGRATION_TARGET_VERSION`. `ALERT_CATEGORY` carries a bounded alert category
into the final annotation step. A "refuse stale checkout" step writes the
verified commit to `GITHUB_ENV` as `KEY_CONTROL_REPO_COMMIT`,
`MIGRATION_REPO_COMMIT` or `REHEARSAL_REPO_COMMIT`, and the scripts refuse to
run unless it equals the workflow commit. The accepted confirmation phrases
are in each runbook.

## Operator scripts run by hand

| Variable | Purpose | Required | Default | Secret | Where set |
| --- | --- | --- | --- | --- | --- |
| `SMOKE_EXPECTED_CAPABILITIES` | JSON merged over the expected `/api/auth/capabilities` values in `npm run smoke:production`; `null` skips a key | No | the defaults in `scripts/production-smoke.mjs` | No | Shell |
| `SMOKE_EXPECTED_REGISTRATION_MODE` | Expected `registrationMode`; `any` skips the check | No | `verified_invite` | No | Shell |
| `SMOKE_TIMEOUT_MS` | Per-request timeout, 1000 to 60000 | No | `15000` | No | Shell |
| `UI_SCREENSHOTS_VIEWPORTS` | Comma-separated viewports for `scripts/ui-screenshots.mjs` | No | `mobile,desktop` | No | Shell |
| `VERCEL_OIDC_TOKEN` | Vercel OIDC token the Sandbox SDK uses for `npm run smoke:execution` (creates real sandboxes). Inside Vercel functions the platform provides it | For `smoke:execution` | none | Yes | `.env.local` via `vercel env pull .env.local`; Platform on Vercel |

`npm run db:status` and `npm run db:plan` read `TURSO_DATABASE_URL` and
`TURSO_AUTH_TOKEN` and only run `SELECT`/`PRAGMA` (see
[database schema operations](DATABASE_SCHEMA_OPERATIONS.md)).

## Local runtime (`npm run dev`)

`npm run dev` loads `.env.local` if it exists, then installs its own
isolated values: it sets `NODE_ENV=development`, a local `file:` database, a
generated `JWT_SECRET`, its loopback `APP_URL`, circle membership, password
reset and invite requests on, and blanks every provider credential (Google,
Resend, AI, Sentry, execution, `CRON_SECRET`, `ADMIN_EMAILS`,
`SIGNUP_ALLOWLIST`). It restores the previous values on shutdown and refuses to
start with `TURSO_AUTH_TOKEN`, a remote database, or any Vercel variable set.

| Variable | Purpose | Required | Default | Secret | Where set |
| --- | --- | --- | --- | --- | --- |
| `RANDORI_LOCAL_HOST` | Bind address, `127.0.0.1` or `::1` only | No | `127.0.0.1` | No | `.env.local` |
| `RANDORI_LOCAL_PORT` | Port, 0 to 65535 | No | `3000` | No | `.env.local` |
| `RANDORI_LOCAL_DATABASE_URL` | Absolute `file:` URL directly inside this checkout's `.local/` | No | `.local/randori.db` | No | `.env.local` |
| `RANDORI_LOCAL_RUNTIME` | Marks the isolated loopback runtime. API code honours it only with `NODE_ENV=development`, a local `file:` database and no Vercel variables | No | set by `npm run dev` | No | Set by `npm run dev` |
| `RANDORI_LOCAL_IDENTITY` | Turns on the development-only invited-password identity adapter | No | set by `npm run dev` | No | Set by `npm run dev` |
| `RANDORI_LOCAL_FIRST_USER_ADMIN` | Makes the first local account an admin (kept `false` by `npm run dev`) | No | `false` | No | Set by `npm run dev` |
| `RANDORI_LOCAL_DATABASE_PATH` | Resolved local database path, checked by the readiness probe | No | set by `npm run dev` | No | Set by `npm run dev` |
| `TWILIO_AUTH_TOKEN` | Not read by the app. `npm run dev` blanks it so an ambient value cannot leak into the process | No | blanked | Yes | Do not set |

## Platform-provided

Never set these by hand.

| Variable | Set by | How the code uses it |
| --- | --- | --- |
| `NODE_ENV` | Vercel (`production`, on previews too), `npm run dev` (`development`), the key-control workflow (`production`) | Production cookie and HTTPS rules; local-runtime guards; Sentry skips `test` |
| `VERCEL` | Vercel | Marks a hosted deployment; turns on immediate outbox delivery |
| `VERCEL_ENV` | Vercel | `production`, `preview` or `development`; selects the Sentry environment and the production client-log rule (ID-72) |
| `VERCEL_URL` | Vercel | Marks a hosted deployment for OAuth and local-runtime guards |
| `VERCEL_OIDC_TOKEN` | Vercel functions | Vercel Sandbox authentication (see above) |
| `CI` | GitHub Actions | Disables Sentry in CI |
| `GITHUB_ACTIONS` | GitHub Actions | Disables Sentry in CI; checked by the migration script |
| `GITHUB_TOKEN` | Workflow (`github.token`) | Read-only GitHub API calls in the watchdogs and the migration evidence check |
| `GITHUB_API_URL`, `GITHUB_REPOSITORY`, `GITHUB_REPOSITORY_ID` | GitHub Actions | Repository identity for evidence checks |
| `GITHUB_EVENT_NAME`, `GITHUB_REF`, `GITHUB_SHA`, `GITHUB_WORKFLOW_REF`, `GITHUB_WORKFLOW_SHA` | GitHub Actions | The protected scripts refuse to run outside `workflow_dispatch` on `main` from the expected workflow |
| `GITHUB_RUN_ID`, `GITHUB_RUN_ATTEMPT` | GitHub Actions | Bind evidence to one run |
| `GITHUB_ENV`, `GITHUB_OUTPUT` | GitHub Actions | Step environment and output files |
| `RUNNER_TEMP` | GitHub Actions | Artifact and private-state directory; scripts refuse paths outside it |

## Test harness only

Read by `tests/` and `playwright.config.js`, not by the app.

| Variable | Purpose | Default |
| --- | --- | --- |
| `E2E_PORT` | Port of the Playwright static test server (`npm run start:test`) and the origin the specs use | `4173` |
| `COVERAGE_DEBUG` | Any value makes `tests/support/coverage.mjs` report dropped non-file coverage entries | unset |
| `RANDORI_MIGRATED_TEMPLATE_CACHE` | `0` builds a private migrated-database template per test process instead of sharing the cached one in the OS temp directory | cached template shared |

Unit and e2e tests also set application flags (for example
`EXERCISE_SUGGESTIONS_ENABLED`) on their own processes. They never read your
shell's values.

## Feature flags

Every flag the code checks. Production state is as of 2026-10-22:

- **On (observed):** advertised by the public `/api/auth/capabilities`
  response.
- **On (owner):** switched on by the owner with the
  [PR #352](https://github.com/festus14/randori-circle/pull/352) deploy. It has
  no public signal.
- **Off (observed):** its capability is absent.
- **Not observable:** check Vercel.

Turn a flag off by unsetting it (or setting `false`) in Vercel Production and
redeploying. Read the last column first: two flags have effects that turning
them off cannot undo.

### Application flags (Vercel)

| Flag | What it gates | Default | Production (2026-10-22) | Depends on | Decision | Turning it off safely |
| --- | --- | --- | --- | --- | --- | --- |
| `CIRCLE_MEMBERSHIP_ENABLED` | Invitation-gated primary-circle membership: owner invitations, roster, member lifecycle, membership checks on every private route | off | On (observed: `verified_invite` mode, `accountDeletion` and `circleHealth` all require it) | Migrations current, then the data-only admin `POST /api/init` cutover | ID-12, ID-21, ID-39 ([admin data initialization](ADMIN_DATA_INITIALIZATION.md)) | Restores legacy roster behaviour and keeps membership data, but does **not** reopen registration once the cutover latch has closed. It also switches off everything below that depends on it. Avoid in production |
| `MULTI_CIRCLE_CONTROL_PLANE_ENABLED` | Creating, selecting and archiving secondary circles; circle-scoped roster and invitations | off | Off (observed: no `multiCircleControlPlane`) | `CIRCLE_MEMBERSHIP_ENABLED`; managed ledger through v16 | ID-21, ID-29, ID-38 ([active circle](ACTIVE_CIRCLE_CONTEXT.md)) | Turn off the dependent flags first. Context, cycle, archive and schedule rows remain and no membership data is deleted; never clear an archive marker as a rollback |
| `MULTI_CIRCLE_AVAILABILITY_ENABLED` | Dated availability in the selected active circle | off | Off in effect (parent off) | `MULTI_CIRCLE_CONTROL_PLANE_ENABLED` | ID-24 | Restores the legacy availability gate; rows remain |
| `SECONDARY_CIRCLE_COORDINATION_ENABLED` | Weekly pairing and coordination in a selected secondary circle | off | Off in effect | `MULTI_CIRCLE_AVAILABILITY_ENABLED` | ID-26 ([selected-circle pairing](SELECTED_CIRCLE_PAIRING.md)) | Also disables the three flags below |
| `SECONDARY_CIRCLE_SCHEDULING_ENABLED` | Propose, accept and clear a time for a secondary pair | off | Off in effect | `SECONDARY_CIRCLE_COORDINATION_ENABLED`; migration v16 | ID-33 ([secondary scheduling](SECONDARY_SCHEDULING.md)) | Schedules are kept; writes stop |
| `SECONDARY_CIRCLE_PAIRING_EMAIL_ENABLED` | Queues dashboard-only pairing emails for secondary publications | off | Off in effect | `SECONDARY_CIRCLE_COORDINATION_ENABLED`; sender canary | ID-32 | New intents stop; already-queued mail is suppressed at send time |
| `SECONDARY_CIRCLE_SCHEDULE_EMAIL_ENABLED` | Queues dashboard-only schedule emails for secondary schedules | off | Off in effect | `SECONDARY_CIRCLE_SCHEDULING_ENABLED` | ID-34 ([notifications](SECONDARY_SCHEDULE_NOTIFICATIONS.md)) | As above |
| `EMAIL_PASSWORD_ACTIVATION_ENABLED` | Invitation-bound email and password signup with a verification link | off | On (observed: `verifiedEmailActivation`) | `CIRCLE_MEMBERSHIP_ENABLED`; `EMAIL_VERIFICATION_*` ring with an accepted control; HTTPS `APP_URL`; Resend; migration v7 | ID-10 | Password signup is withdrawn (invitees can still use Google); verify and resend return 503. Queued verification mail stays `pending` until the flag is back on, and the outbox watchdog reports `delivery_stale` after 15 minutes; expect that alert or turn it off with an empty queue ([held mail](#held-mail-and-the-outbox-watchdog)) |
| `PASSWORD_RESET_ENABLED` | "Forgot password?" for existing password accounts | off | On (observed: `passwordReset`) | `PASSWORD_RESET_*` ring with an accepted control; HTTPS `APP_URL`; Resend; migration v8 | ID-11 | Reset request and consume return 503; password login is unaffected. Queued reset mail stays `pending` until the flag is back on, and the outbox watchdog reports `delivery_stale` after 15 minutes; expect that alert or turn it off with an empty queue ([held mail](#held-mail-and-the-outbox-watchdog)) |
| `IDENTITY_MANAGEMENT_ENABLED` | Account security: link or remove Google and password sign-in | off | On (observed: `identityManagement`) | `IDENTITY_EMAIL_HASH_*` ring with an accepted control (without it Google sign-in fails closed); migration v9 | ID-13, ID-14 | Account security is hidden; Google and password sign-in keep working; existing links stay |
| `INVITATION_EMAIL_DELIVERY_ENABLED` | Emailing owner-created invitation links | off | Not observable (bootstrap guide §10 turns it on for the MVP) | `CIRCLE_MEMBERSHIP_ENABLED`; `INVITATION_EMAIL_*` ring; Resend; `APP_URL` | ID-25 ([invitation email](INVITATION_EMAIL_DELIVERY.md)) | Invitations are still created with the copy-link fallback. Queued invitation mail stays `pending` until the flag is back on, and the outbox watchdog reports `delivery_stale` after 15 minutes; expect that alert or turn it off with an empty queue ([held mail](#held-mail-and-the-outbox-watchdog)) |
| `INVITE_REQUESTS_ENABLED` | Public "Request an invite" form, owner review API, `inviteRequests` capability | off | On (observed: `inviteRequests`) | `CIRCLE_MEMBERSHIP_ENABLED`; migration v21; Resend and `APP_URL` for the owner digest | ID-66 ([invite requests](INVITE_REQUESTS.md)) | Endpoints return 404 and the form disappears; stored requests still expire and purge weekly. Pending owner-digest emails are held the same way: they stay `pending` until the flag is back on, and the outbox watchdog reports `delivery_stale` after 15 minutes; expect that alert or turn it off with an empty queue ([held mail](#held-mail-and-the-outbox-watchdog)) |
| `REMINDERS_ENABLED` | Availability-cutoff reminder and agree-a-time nudge from the outbox cron | off | On (owner) | Resend; the outbox scheduler | ID-71 ([reminders](REMINDERS.md)) | Queued reminders drain as `suppressed` |
| `REMINDERS_SESSION_SOON_ENABLED` | One-hour session reminder | off | On (owner) | `REMINDERS_ENABLED` | ID-71 | As above |
| `PROGRESS_DASHBOARD_ENABLED` | "Your progress" in History and `GET /api/progress` | off | On (owner) | none | ID-76 ([progress dashboard](PROGRESS_DASHBOARD.md)) | Safe; nothing is stored |
| `EXERCISE_SUGGESTIONS_ENABLED` | "Attempted" markers and suggested exercises; `GET /api/exercise-suggestions` | off | On (owner) | none | ID-77 | Safe; nothing is stored |
| `CIRCLE_HEALTH_ENABLED` | Owner-only Circle health card and `GET /api/circle/health` | off | On (observed: `circleHealth`) | `CIRCLE_MEMBERSHIP_ENABLED` | ID-78 ([circle health](CIRCLE_HEALTH.md)) | Safe; nothing is stored |
| `ADMIN_DIAGNOSTICS_ENABLED` | Read-only admin Diagnostics in the Circle view | off | On (observed: `adminDiagnostics`) | none (still admin-only) | ID-73 | Safe; nothing is stored |
| `ACCOUNT_DELETION_ENABLED` | Self-service Delete account in Edit profile (`POST /api/auth/account/delete`) | off | On (observed: `accountDeletion`) | `CIRCLE_MEMBERSHIP_ENABLED` | ID-81 ([account deletion](ACCOUNT_DELETION.md)) | Hides the endpoint and UI. **Irreversible:** accounts already deleted stay deleted |
| `OUTBOX_PII_RETENTION_ENABLED` | Hourly removal of recipient addresses and sealed links from delivered or suppressed outbox rows after 7 days and from dead letters after 30 | off | On (owner) | The matching privacy policy text (live since 2026-10-22) | ID-83 | Stops further redaction. **Irreversible:** redacted rows cannot be restored and redacted dead letters stay non-replayable |
| `AI_ENABLED` | Consent-gated AI feedback in `api/ai.js` | off | Off (privacy policy says AI is off) | `GROQ_API_KEY` or `OPENAI_API_KEY`; privacy and consent review ([#7](https://github.com/festus14/randori-circle/issues/7)) | ID-41 | AI routes return 503 |
| `ALLOW_OPEN_SIGNUP` | Open password signup for development | off | Ignored in production (`NODE_ENV=production`) | Not production; circle membership off | none | Safe |
| `OUTBOX_IMMEDIATE_DELIVERY` | Sending mail right after commit, instead of waiting for the cron (three-state, see above) | on when `VERCEL=1` | Not observable (expected unset, so on) | none | ID-64 | Set `false` and redeploy: mail waits for the scheduled `/api/cron/outbox` |
| `SENTRY_ENABLE_PREVIEW` | Sentry reporting from previews | off | Preview scope only | `SENTRY_DSN` | none | Safe |

#### Held mail and the outbox watchdog

While `EMAIL_PASSWORD_ACTIVATION_ENABLED`, `PASSWORD_RESET_ENABLED`,
`INVITATION_EMAIL_DELIVERY_ENABLED` or `INVITE_REQUESTS_ENABLED` is off, its
outbox handler is not registered (`api/_outbox-delivery.js`), so the worker
never claims that mail type and queued rows stay `pending`. The same happens
when a flag they depend on, such as `CIRCLE_MEMBERSHIP_ENABLED`, is turned off.
Delivery health counts every due `pending` row, whatever its type. Once the
oldest held row is more than 15 minutes old, the next hourly run of the
[outbox watchdog](OUTBOX_DISPATCH_WATCHDOG.md) fails with `delivery_stale`, and
the admin Diagnostics outbox card shows the same. The alert repeats until the
flag is turned back on (the held rows are then sent, or suppressed if they are
no longer valid, for example because the link expired) or the rows are
otherwise drained. Either expect that alert, or turn the flag off only when
the queue is empty: `dueCount` from `/api/cron/outbox-health` is `0`, or the
type's Due column in admin Diagnostics is `0`. Reminders do not have this
problem: their handler is always registered, so queued reminders drain as
`suppressed` while `REMINDERS_ENABLED` is off.

`EXECUTION_PROVIDER` is not a boolean but works as the switch for Run:
unsetting it makes every run fail closed with `execution_unavailable` and
changes no data (ID-62).

### Operator gates (GitHub environments and scripts)

These authorize a protected operation, not a product feature. Keep each one
`false` except during one approved operation, then set it back.

| Flag | What it gates | Default | Production (2026-10-22) | Decision | Turning it off safely |
| --- | --- | --- | --- | --- | --- |
| `TURSO_PRODUCTION_MIGRATIONS_ENABLED` | `adopt` and `apply` in `turso-production-migration.yml` | `false` | Not observable (kept `false` between approved applies) | ID-28 ([runbook](TURSO_PRODUCTION_MIGRATION.md)) | Safe: `status` still works |
| `CREDENTIAL_KEY_CONTROL_MUTATIONS_ENABLED` | `adopt` and `advance` in `credential-key-control.yml` | `false` | Not observable (kept `false` between approved changes) | ID-19, ID-31 ([key rotation](KEY_ROTATION.md)) | Safe: `status` still works. It does not switch off any app flag |
| `CHAT_RETENTION_ENABLED` | Retention runs in `chat-retention.yml` | off | Off (destructive production use is disabled; [runbook](CHAT_RETENTION.md)) | ID-20 | Safe: purge stops; holds and evidence are kept |
| `CHAT_RETENTION_LOCAL_ADOPTION` | Local-only scope adoption in `scripts/chat-retention.mjs` | off | Not used in production | ID-20 | Safe |
| `RANDORI_LOCAL_RUNTIME`, `RANDORI_LOCAL_IDENTITY`, `RANDORI_LOCAL_FIRST_USER_ADMIN` | Local runtime behaviour (see above) | set by `npm run dev` | Refused outside development | ID-02 | Not applicable |
