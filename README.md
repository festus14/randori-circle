# Randori Circle

Randori Circle is a private peer mock-interview app. Members publish availability, receive a fair weekly pairing, schedule a session, chat, and practise JavaScript or Python questions together.

Production deploys from `main` through Vercel. Development is iterative; see the [implemented decision log](docs/IMPLEMENTED_DECISIONS.md) for the current private-beta architecture and the [production plan](docs/PRODUCTION_ARCHITECTURE_PLAN.md) for the longer-term target.

## Current private-beta workflow

1. A circle owner creates a single-use, email-bound invitation. Randori queues
   its email when delivery is configured and always keeps a private copy-link
   fallback.
2. The recipient opens the link and signs in with the invited, verified Google account; existing active members can sign in normally.
3. Members set availability for the explicitly dated upcoming cycle before its displayed Sunday cutoff; the cron then publishes one deterministic, repeat-aware current-cycle pairing from that frozen eligibility snapshot.
4. Each participant receives a personalised email containing only their partner and private room link.
5. Partners propose a time, chat, and open the session workspace, where code and completed whiteboard gestures are saved as one room-scoped checkpoint.
6. Members choose from the original, provenance-checked catalogue; JavaScript and Python are evaluated against server-owned cases and the authoritative result is saved by the API.
7. Both partners see a room-scoped feed of verified run summaries; source code, hidden cases, provider output, and unrelated personal runs remain private.

Pair workspaces now persist authenticated, revisioned code and whiteboard snapshots across devices. A completed board gesture is saved locally immediately and then synced; if the network is unavailable, the room keeps a dirty local checkpoint and retries after hydration. Viewport, selected tool, and colour are intentionally device-local. Snapshots expire after 90 days, and v1/v2 code-only rooms upgrade without losing their draft.

Pair scheduling uses timezone-aware instants: each browser displays the same UTC value in its local timezone, while compare-and-swap updates prevent one partner from silently overwriting the other. The dashboard polls only while it is visible, preserves unsent input through conflicts, and keeps older free-text schedule values visible and removable during migration. A normalized accepted session can be downloaded as a private 60-minute RFC 5545 calendar file generated entirely in the browser. Its stable primary-room or opaque secondary-schedule identity supports reschedule imports without including partner details, tokens, code, or chat; secondary exports link only to the dashboard, and proposals, legacy text, invalid times, and cleared agreements are not exportable. The member's calendar app controls the downloaded copy; see [private calendar export](docs/CALENDAR_EXPORT.md).

Pair chat is a private, canonical-room feed rather than a local preview. It loads the newest bounded window, follows new messages with an incremental cursor only while the signed-in member is viewing their dashboard, and deduplicates server acknowledgements against later polls. Failed or ambiguous sends are never retried automatically and their per-room drafts remain available for an explicit retry. Durable limits cap each member at 20 sends per minute and each room at 10,000 messages. Migration v10 owns the room-cursor and sender-window indexes, so ordinary requests perform no chat-index DDL. The private-beta active-database retention window is 90 days; strict database-time expiry, scope ownership, holds, export/backup gates, and the disabled-by-default bounded v11 purge are described in the [chat retention runbook](docs/CHAT_RETENTION.md).

Authenticated History is a server-backed Pairings & Activity view. A member can explicitly load a private pairing recap containing the agreed schedule, a bounded timeline of messages and verified run summaries, and safe metadata for the latest workspace checkpoint. Source code, whiteboard shapes, hidden cases, provider output, transcripts, and unrelated users' activity are never included. Available checkpoints reopen through the existing authenticated workspace hydration path; pair assignments are not described as completed sessions until lifecycle and attendance tracking exist.

Every private pair surface requires the source-tagged `pairing_participants` snapshot written by current shuffles, including current-pair discovery, schedules, chat, run feeds and execution, video signaling, workspace checkpoints, recaps, personal history, and AI consent or feedback. This prevents collisions between legacy `users` IDs and authenticated account IDs. Pre-snapshot pairings intentionally remain unavailable until an operator can audit and backfill their identity source; numeric IDs alone are never enough evidence. Migration v1 installs the required snapshot table and pair-activity indexes; `/api/init` is a data-only primary-circle cutover. Production rollout/backfill tracking remains in issues #27 and #30.

The active catalogue contains 10 original exercises across arrays, windows, graphs, intervals, simulation, stacks and strings, binary search, breadth-first search, hash maps, and dynamic programming. Search, difficulty, and pattern filters run entirely in the browser against the public catalogue projection; server-owned generated cases and reference oracles stay outside browser payloads.

This private-beta sync is whole-document compare-and-swap, not a CRDT: members see durable checkpoints rather than each pointer stroke in real time. Managed realtime collaboration, video, production AI coaching, circle tenancy, and authorised third-party content adapters remain later increments.

## Security baseline

- Sessions use 12-hour `Secure`, `HttpOnly`, `SameSite=Lax` cookies.
- Google OAuth uses cryptographic state, PKCE, and verified OpenID userinfo.
- Production password signup is fail-closed unless invitation-bound email activation is fully configured; no account or session exists before verification.
- Existing password accounts can recover through a generic, rate-limited response; reset tokens are single-use, encrypted in the outbox, hashed at rest, and revoke every session when consumed.
- Credential linking is explicit, recent-authenticated, and opt-in after migration v9. Matching provider email never links accounts; the stable Google subject remains authoritative when its email changes, and the final usable sign-in method cannot be removed.
- Mutations enforce same-origin requests for cookie sessions; API callers may use pinned Bearer JWTs.
- Circle, pairing, schedule, chat, feedback, execution, and signaling endpoints require scoped authorisation.
- Weekly pairing, schedule, and owner-invitation writes are atomic and
  concurrency-safe. Invitation, pairing, proposal, acceptance, reschedule, and
  reminder emails use one idempotent, retryable outbox.
- Outbox workers use expiring token-bound leases, heartbeats, provider timeouts, bounded backoff, dead letters, and audited operator replay. Provider idempotency keys remain stable across crashes and replay; metrics and logs contain aggregate state only.
- The cron outbox uses fair one-per-type claim rounds, an eight-event global
  claim cap, and a 45-second request budget with five seconds reserved for
  lease finalization and aggregate metrics.
- AI is disabled unless explicitly enabled and consented to.
- Automated LeetCode retrieval and bundled third-party seed content have been removed. The app uses provenance-approved local content or authenticated outbound links only; a future adapter requires written authorisation and review.

## Architecture

The current deployable prototype is a single-page `index.html` backed by grouped Vercel serverless functions:

| Module | Responsibility |
|---|---|
| `api/auth.js` | signup/login compatibility, logout, session lookup, Google OAuth, and credential-management endpoints |
| `api/data.js` | profiles, circle, weeks, schedules, messages, questions, private pair run summaries, execution |
| `api/ops.js` | availability, fair pairing, cron, notification outbox, demo administration |
| `api/ai.js` | disabled-by-default consent-gated feedback workflows |
| `api/video.js` | authenticated pair-scoped WebRTC signaling and revisioned code/board checkpoints |
| `api/_db.js` | Turso client, durable session issuance/revocation, JWT verification, CSRF helpers |
| `api/_catalog.js` | original exercise catalogue validation, public projections, server-owned evaluation cases |
| `api/_catalog-provenance.js` | versioned rights-manifest validation and canonical content hashing |
| `api/_pairing.js` | deterministic fairness and canonical room identifiers |
| `api/_pairing-publication.js` | managed-v6 readiness, transaction-bound owner/cron publication, immutable snapshots, and idempotency |
| `api/_outbox.js` | provider-neutral leases, heartbeats, timeouts, retry/dead-letter transitions, replay audit, and aggregate metrics |
| `scripts/github-outbox-dispatch-watchdog.mjs` | bounded, secret-free assessment of scheduled notification-worker health |
| `api/_invitation-email.js` | encrypted invitation credentials, versioned delivery, resend bounds, and current-state suppression |
| `api/_schedule-email.js` | versioned schedule email intents, 24-hour reminders, current-state suppression, and private rendering |
| `api/_email-activation.js` | invitation-bound pending registrations, encrypted verification delivery, token rotation, and atomic activation |
| `api/_password-reset.js` | enumeration-safe reset requests, encrypted delivery, token rotation, and atomic password/session replacement |
| `api/_recent-auth.js` | ten-minute session-scoped password/Google step-up evidence for sensitive account operations |
| `api/_identity-linking.js` | explicit Google/password linking, final-credential protection, hashed provider-email observations, and redacted audit events |
| `api/_pairing-email.js` | versioned pairing-email event validation, rendering, preferences, and provider adaptation |
| `api/_availability.js` | tenant-scoped weekly cycle identity, strict optimistic availability updates, and publication filtering |
| `api/_schedule.js` | strict schedule validation, legacy projection, opaque versions, and conflict-safe mutations |
| `api/_messages.js` | strict chat input, cursor, storage projection, and schema-readiness validation |
| `api/_chat-retention.js` | tenant-safe 90-day retention planning, legal holds, fenced leases, bounded deletion, and count-only metrics |
| `api/_health.js` | process liveness and exact, read-only database readiness probes |
| `api/_admin-init.js` | exact-readiness-gated, transactional primary-circle data initialization |
| `api/_pair-access.js` | shared source-aware authorization for canonical private pair rooms |
| `api/_circle-membership.js` | primary-circle membership, keyed invite hashes, signed short-lived claims, and audited acceptance |
| `api/_circle-archive.js` | recent-authenticated secondary-circle soft archive, every-member safety, idempotency, and deterministic context fallback |
| `api/invitations.js` | owner-only invitation lifecycle and rate-limited public preparation |
| `db/schema-manifest.js` | checksummed contract for 52 application tables and 56 named indexes |
| `db/schema-inspector.js` | read-only SQLite drift inspection and non-executable planning |

The target Next.js/Supabase architecture is intentionally phased rather than introduced as a big-bang rewrite.

## Environment

Copy `.env.example` and configure at least:

- `TURSO_DATABASE_URL` and `TURSO_AUTH_TOKEN`
- `JWT_SECRET` with at least 32 random bytes and a separate `CRON_SECRET`; `RUN_ATTESTATION_SECRET` is optional and falls back to `JWT_SECRET` when blank
- `PAIRING_TIME_ZONE=Europe/London`; each pairing cycle runs from Sunday 08:00 in that zone until the next Sunday boundary
- an explicit canonical HTTPS `APP_URL` plus both `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET`; OAuth stays unavailable for partial, malformed, insecure, host-mismatched, or local-runtime configuration
- `SIGNUP_ALLOWLIST` for the legacy private-beta Google flow while circle membership enforcement is off
- `CIRCLE_MEMBERSHIP_ENABLED=true` to enforce invitation-gated primary-circle access after the staged migration below
- `MULTI_CIRCLE_CONTROL_PLANE_ENABLED=true` enables session-bound circle creation/selection, owner archive with deterministic fallback, and circle-scoped roster/invitation management whose final schema addition is migration v14. Exact runtime readiness for this release requires the complete managed ledger through v16. Keep `MULTI_CIRCLE_AVAILABILITY_ENABLED=false` until selected-circle availability is rehearsed, then keep `SECONDARY_CIRCLE_COORDINATION_ENABLED=false` until that complete ledger is ready. After protected migration v16, `SECONDARY_CIRCLE_SCHEDULING_ENABLED=true` lets a current secondary pair agree a time without a room/workspace capability. `SECONDARY_CIRCLE_PAIRING_EMAIL_ENABLED` independently queues dashboard-only pairing-result mail; `SECONDARY_CIRCLE_SCHEDULE_EMAIL_ENABLED` independently queues dashboard-only schedule mail and is effective only when scheduling is enabled. Keep both delivery flags false until their sender canaries pass. Secondary chat, rooms, video, execution, recap, and AI remain unavailable. See `docs/ACTIVE_CIRCLE_CONTEXT.md`, `docs/CIRCLE_CREATION.md`, `docs/CIRCLE_ARCHIVE.md`, `docs/SELECTED_CIRCLE_PAIRING.md`, `docs/SECONDARY_SCHEDULING.md`, and `docs/SECONDARY_SCHEDULE_NOTIFICATIONS.md`.
- `EMAIL_PASSWORD_ACTIVATION_ENABLED=true` plus the versioned, purpose-specific `EMAIL_VERIFICATION_ENCRYPTION_*` key-ring settings to enable production invite-bound password activation after migration v7 is ready
- the explicit `INVITATION_EMAIL_DELIVERY_ENABLED` gate and separate versioned `INVITATION_EMAIL_ENCRYPTION_*` key ring to queue owner-created invitation links without storing a plaintext bearer token
- `PASSWORD_RESET_ENABLED=true` plus the independent versioned `PASSWORD_RESET_ENCRYPTION_*` key ring to enable recovery after migration v8 is ready
- the dedicated versioned `IDENTITY_EMAIL_HASH_*` key ring before setting `IDENTITY_MANAGEMENT_ENABLED=true` after migration v9; Google linking also requires the complete Google OAuth configuration above
- separate protected steps for the v13, v14, then v15 prerequisites, each with fresh rehearsal and approval, followed by protected adoption of all four configured credential purposes; then use a new rehearsal, status artifact, and approval to apply v16 separately before deploying the current runtime with secondary scheduling still disabled. `CREDENTIAL_KEY_CONTROL_MUTATIONS_ENABLED` authorizes only one operator control transition and does not disable `EMAIL_PASSWORD_ACTIVATION_ENABLED`, `PASSWORD_RESET_ENABLED`, `INVITATION_EMAIL_DELIVERY_ENABLED`, or `IDENTITY_MANAGEMENT_ENABLED`. Disable those consumer flags during the v15 transition, or hold production promotion if they cannot be disabled. Status/adoption/advance and restore rules are in `docs/KEY_ROTATION.md` and `docs/SECONDARY_SCHEDULING.md`
- authentication schema is migration-owned: signup, login, profile, activation,
  reset, identity, and Google callback paths probe it read-only and fail closed;
  run the protected migrations before enabling production authentication
- `RESEND_API_KEY` and `RESEND_FROM` for invitation, pairing, schedule,
  verification, and password-reset notifications
- Keep `CHAT_RETENTION_ENABLED=false` until migration v11, legacy scope adoption,
  export-before-backup evidence, a staging destructive rehearsal, and a reviewed
  production dry run are complete; see the retention runbook for the protected
  control generation and evidence settings

See [GOOGLE_OAUTH.md](GOOGLE_OAUTH.md) and [TURSO.md](TURSO.md) for provider setup. Back up the database before first deploying migrations.
Key changes use the staged, forward-only [key rotation runbook](docs/KEY_ROTATION.md); never replace a configured key in place, bypass its durable v15 control, or remove an old key while its actionable or retained count is nonzero.

The protected Turso recovery workflow performs a monitored isolated restore every Monday at 03:17 UTC and remains manually dispatchable. A separate hourly, production-credential-free watchdog queries the authoritative GitHub run and artifact records; after a two-hour scheduling grace it requires a run from the current weekly slot, and an unfinished run has an absolute 06:47 UTC deadline that a delayed start cannot reset. Absent, stuck, failed, stale, expired, or corrupt drills therefore fail visibly. Retained evidence is limited to PII-free RPO/RTO timings, checksums, aggregate counts, and cleanup state. See the [backup/restore rehearsal runbook](docs/TURSO_BACKUP_RESTORE_REHEARSAL.md).

Authentication rate limiting is migration-owned: runtime requests never create `auth_rate_limits`. A deployment with missing or stale migration state fails authentication closed with a temporary-unavailability response; complete the migration/readiness gate before serving traffic rather than enabling request-time schema writes.

Invitation creation/resend, pairing publication, and schedule mutations commit
with their versioned email events in one transaction. Provider calls begin only
after that commit.
Secondary publication reuses `pairing.email.requested` with a compact v2
internal-ID payload, so it remains one of the same five fairly scheduled event
types. Dispatch resolves current recipient/circle data, rechecks the immutable
publication and current memberships/preferences, and links only to the
dashboard; v1 primary room-email delivery remains compatible.
`GET|POST /api/cron/outbox` uses the existing `CRON_SECRET` and drains due
pairing, schedule, invitation, activation, and password-reset events through
one fair eight-claim/45-second invocation budget, independently of the weekly
publication endpoint. The checked-in
`outbox-dispatch` GitHub Actions workflow provides the five-minute MVP cadence
using protected-production `APP_URL` and `CRON_SECRET` configuration; scheduled
runs are best effort. The separate hourly `outbox-dispatch-watchdog` reads only
scheduled default-branch Actions metadata, applies a 15-minute grace and the
worker's two-minute deadline, and never receives production credentials or
counts a manual recovery run as freshness. Use a managed queue/cron when a
strict latency SLO is required. `POST
/api/admin/outbox/replay` lets a non-demo global administrator replay only a
dead-letter event with one of the bounded reason codes `OPERATOR_RETRY`,
`PROVIDER_RECOVERED`, or `CONFIGURATION_FIXED`. Replay preserves the original
provider idempotency key. See [outbox invocation budget](docs/OUTBOX_INVOCATION_BUDGET.md),
[outbox dispatch watchdog](docs/OUTBOX_DISPATCH_WATCHDOG.md),
[invitation email delivery](docs/INVITATION_EMAIL_DELIVERY.md), and
[schedule notifications](docs/SCHEDULE_NOTIFICATIONS.md) for dispatch
fairness, suppression, limits, and remaining issue #50 work.

Google OAuth has one fail-closed configuration boundary shared by capability discovery, start, and callback. Production and hosted deployments require both provider credentials, an explicit canonical HTTPS `APP_URL`, and matching trusted proxy host/protocol headers. Invalid configuration returns only a generic unavailable response and performs no provider or database work. The isolated local runtime always disables Google credentials.

Identity management is a separate dark-launched capability. With `IDENTITY_MANAGEMENT_ENABLED=false`, production neither advertises nor enters credential-management routes, while ordinary Google sign-in and reauthentication retain their v4 compatibility. Enabling the flag without the dedicated email-hash key/version makes Google and identity-management entry points fail closed. Once v9 is ready, an authenticated member can open **Account security**, confirm a current password or Google account, explicitly link or remove a method, and is prevented from removing the final usable credential. Link initiation is same-origin POST-only and its OAuth callback is bound to the exact live session, PKCE verifier, state, nonce, stable provider subject, and fresh signed `auth_time`. Provider email is stored only as a dedicated-key HMAC plus its key version and never silently replaces the canonical account email.

Sensitive circle lifecycle changes reuse that session-scoped recent-authentication boundary without depending on the identity-management feature flag. Ownership transfer, deactivation of another owner, and secondary-circle archive require a password or Google proof no older than ten minutes; the proof is checked inside the same write transaction as the change. The browser resumes only one exact, redacted same-tab action and clears it on cancellation, OAuth error, expiry, actor change, circle change, or unavailable methods. Archive is a soft authorization boundary: it retains immutable coordination and schedule history while immediately moving selected sessions to safe remaining circles. Routine member administration and self-leave remain explicit without unnecessary step-up friction. See [docs/LIFECYCLE_RECENT_AUTH.md](docs/LIFECYCLE_RECENT_AUTH.md) and [docs/CIRCLE_ARCHIVE.md](docs/CIRCLE_ARCHIVE.md).

To roll out circle membership without locking out operators: first complete the production backup/restore rehearsal and migrate to the exact current schema, deploy with `CIRCLE_MEMBERSHIP_ENABLED=false`, verify an authenticated `ADMIN_EMAILS` account, call the data-only admin `POST /api/init`, verify the primary circle and audited non-demo account backfill, then enable the flag. The endpoint cannot create or repair schema; missing, stale, or drifted state fails closed before data mutation. Atomic registration guards ensure an account racing initialization is either included or rejected while existing accounts continue to sign in. Invitation tokens are returned only once by the create endpoint; the database stores keyed hashes, and list responses expose only an email fingerprint. Disabling the flag restores the legacy roster behavior without removing membership data, but does not reopen registration after the cutover latch is closed. See [admin data initialization](docs/ADMIN_DATA_INITIALIZATION.md).

The owner roster is cursor-paginated rather than capped at an inaccessible
first 500 rows. Continuation cursors are encrypted, actor/circle/search bound,
and every request rechecks active ownership. Pages use the existing membership
primary-key index, scan at most 201 circle-scoped candidates, return at most 100
members, and project display names without querying or returning the account
email field. A failed append keeps the already loaded page available for retry;
a failed replacement search clears those rows so results from an earlier query
cannot be mistaken for current matches. Any roster 401/403 clears retained
owner data based on status alone before the app rechecks the current role,
including when that denial arrives after a newer same-account response. A
denial from a previous signed-in identity cannot clear the new account's view.

Health probes are intentionally separate. `/api/health/live` (and `/api/healthz`) checks only that the process can answer; use it for frequent load-balancer liveness checks. `/api/health`, `/api/health/ready`, and `/api/readyz` are deploy/readiness gates: they return 200 only when database configuration, reachability, connection constraints, the exact application schema, the complete immutable migration ledger, and membership-rollout invariants all pass. Enabling `CIRCLE_MEMBERSHIP_ENABLED` additionally requires the rollout to be completed and closed; a pristine open rollout is ready only while that feature is disabled. Local readiness refuses a missing or unsafe database target before constructing a client. Every health response is `no-store`, readiness uses only read-only queries, and failures disclose only a generic unavailable status.

Application JWTs carry a random session identifier, while `auth_sessions` stores only its domain-separated SHA-256 hash. Every private request must match a live, unexpired database row; current-session logout revokes one row and logout-all revokes every live row for that account. At most eight sessions per account remain active, and membership loss revokes them all on the next authenticated request. Legacy JWTs without a session identifier fail closed after migration v5. Rotating `JWT_SECRET` remains an emergency global sign-out and also invalidates outstanding invitation, activation, and password-reset links because the same secret produces their separate domain-scoped hashes. Revoke and reissue pending invitations and activations during rotation; users with pending password recovery must request a new reset link.

For attestation-key rotation, move each former `RUN_ATTESTATION_SECRET` into the comma-separated `RUN_ATTESTATION_PREVIOUS_SECRETS` list. Retain it there until runs signed with that key no longer need to be verified; removing it makes those historical runs appear unverified.

## Development and tests

Requires Node.js 24 and Python 3 (`python3`) for the aggregate execution tests.

For the usable local MVP, install dependencies and start the real SPA plus API on loopback:

```bash
npm ci
npm run dev
```

Open `http://127.0.0.1:3000`. The server creates `.local/randori.db`, runs the reviewed migrations before listening, seeds one deterministic private-circle owner, and stores its local-only session key beside the database. All state persists across restarts and is gitignored. No Turso, Google, Resend, or other provider credentials are required.

Sign in as the seeded owner with `owner@randori.test` / `randori-local-owner`, open **Circle**, and create an email-bound invitation. The owner receives a copy-link fallback while the local-only invitation event remains available to the in-memory test capture; no message is sent externally. Open the one-time invitation link in a private browser window and create that invited account with any 10–72 byte UTF-8 local password. This development-only verified-identity adapter follows the same signed invitation claim, atomic membership acceptance, cookie session, CSRF, circle authorization, and pairing APIs as production Google signup; it cannot activate in production, Vercel preview, against a remote database, or over a non-loopback request. Local pages use only same-origin assets and deliberately fall back to the bundled plain editor, so starting the app never contacts telemetry, font, formatting, or editor CDNs.

An optional `.env.local` may set `RANDORI_LOCAL_PORT`, `RANDORI_LOCAL_HOST` (`127.0.0.1` or `::1` only), or an absolute `file:` `RANDORI_LOCAL_DATABASE_URL` directly inside this checkout's `.local` directory. Local identity and membership flags are owned by the runtime rather than `.env.local`. The command refuses production/Vercel mode, remote database URLs, non-loopback binding, remote database credentials, unsafe permissions, symlinks, and unmanaged schema. Other ambient provider credentials are blanked before API code loads and restored on shutdown. Reset only this verified local state with an explicit confirmation:

```bash
npm run dev:reset -- --confirm
```

`npm run start:test` remains the mock-first static Playwright fixture; it intentionally does not run real API handlers or use the local MVP database.

```bash
npm run audit:prod
npm run check:deployability
npm run validate:catalog
npm run check:runtime-ddl
npm run check:syntax
npm run test:migrations
npm run test:coverage
npm run test:e2e
```

Catalogue validation also checks the versioned provenance manifest, review
expiry, takedown state, and canonical content hashes. The bounded emergency
procedure is documented in [Catalogue provenance and takedown](docs/CATALOG_PROVENANCE.md).

CI tests the checked-out candidate build on localhost. It validates the provider-neutral deployment contract and catalogue, rejects every API/runtime schema mutation with an exact-zero DDL allowlist, enforces at least 52% line, branch, and function coverage across API, database-foundation, and operational-script modules, and runs the Playwright flows on Ubuntu. The read-only operations boundary is documented in [Operations request-path DDL retirement](docs/OPERATIONS_RUNTIME_DDL_RETIREMENT.md); the merge-versus-preview policy and its one required GitHub settings change are documented in [Deployment and merge gates](docs/DEPLOYMENT_GATES.md).

Operators can run `npm run --silent db:status` or `npm run --silent db:plan` with Turso credentials to receive structured JSON drift reports. Both commands are guarded to `SELECT`/`PRAGMA`, and the plan is non-executable. A separate fingerprint-gated `db:migrate` command supports transactional apply or verified adoption only for explicit local `file:` URLs; it rejects every remote target and does not read production credentials. See [Database schema operations](docs/DATABASE_SCHEMA_OPERATIONS.md).

## Next increments

1. Pilot the secure weekly coordination loop and measure completed sessions.
2. Move collaborative editing from revisioned snapshots to a managed realtime/CRDT service as usage grows.
3. Move code execution from the shared Piston service to dedicated isolated workers with queueing and quotas.
4. Add managed video after the coordination workflow is reliable.
5. Add durable session artifacts and consented AI coaching, then expand only with original, licensed, or formally authorised question sources.
