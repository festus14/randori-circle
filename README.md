# Randori Circle

Randori Circle is a private peer mock-interview app. Members publish availability, receive a fair weekly pairing, schedule a session, chat, and practise JavaScript or Python questions together.

Production deploys from `main` through Vercel. Development is iterative; the architecture and rollout decisions are documented in [the production plan](docs/PRODUCTION_ARCHITECTURE_PLAN.md).

## Current private-beta workflow

1. A circle owner creates a single-use, email-bound invitation and sends its link privately.
2. The recipient opens the link and signs in with the invited, verified Google account; existing active members can sign in normally.
3. The Sunday cron creates one deterministic, repeat-aware pairing cycle from active primary-circle members.
4. Each participant receives a personalised email containing only their partner and private room link.
5. Partners propose a time, chat, and open the session workspace, where code and completed whiteboard gestures are saved as one room-scoped checkpoint.
6. Members choose from the original, provenance-checked catalogue; JavaScript and Python are evaluated against server-owned cases and the authoritative result is saved by the API.
7. Both partners see a room-scoped feed of verified run summaries; source code, hidden cases, provider output, and unrelated personal runs remain private.

Pair workspaces now persist authenticated, revisioned code and whiteboard snapshots across devices. A completed board gesture is saved locally immediately and then synced; if the network is unavailable, the room keeps a dirty local checkpoint and retries after hydration. Viewport, selected tool, and colour are intentionally device-local. Snapshots expire after 90 days, and v1/v2 code-only rooms upgrade without losing their draft.

Pair scheduling uses timezone-aware instants: each browser displays the same UTC value in its local timezone, while compare-and-swap updates prevent one partner from silently overwriting the other. The dashboard polls only while it is visible, preserves unsent input through conflicts, and keeps older free-text schedule values visible and removable during migration.

Pair chat is a private, canonical-room feed rather than a local preview. It loads the newest bounded window, follows new messages with an incremental cursor only while the signed-in member is viewing their dashboard, and deduplicates server acknowledgements against later polls. Failed or ambiguous sends are never retried automatically and their per-room drafts remain available for an explicit retry. Durable limits cap each member at 20 sends per minute and each room at 10,000 messages; the production index and retention migration is tracked in issue #27.

Authenticated History is a server-backed Pairings & Activity view. A member can explicitly load a private pairing recap containing the agreed schedule, a bounded timeline of messages and verified run summaries, and safe metadata for the latest workspace checkpoint. Source code, whiteboard shapes, hidden cases, provider output, transcripts, and unrelated users' activity are never included. Available checkpoints reopen through the existing authenticated workspace hydration path; pair assignments are not described as completed sessions until lifecycle and attendance tracking exist.

Every private pair surface requires the source-tagged `pairing_participants` snapshot written by current shuffles, including current-pair discovery, schedules, chat, run feeds and execution, video signaling, workspace checkpoints, recaps, personal history, and AI consent or feedback. This prevents collisions between legacy `users` IDs and authenticated account IDs. Pre-snapshot pairings intentionally remain unavailable until an operator can audit and backfill their identity source; numeric IDs alone are never enough evidence. The admin-only `/api/init` migration installs the required snapshot table and pair-activity indexes; production rollout/backfill tracking remains in issues #27 and #30.

The active catalogue contains 10 original exercises across arrays, windows, graphs, intervals, simulation, stacks and strings, binary search, breadth-first search, hash maps, and dynamic programming. Search, difficulty, and pattern filters run entirely in the browser against the public catalogue projection; server-owned generated cases and reference oracles stay outside browser payloads.

This private-beta sync is whole-document compare-and-swap, not a CRDT: members see durable checkpoints rather than each pointer stroke in real time. Managed realtime collaboration, video, production AI coaching, circle tenancy, and authorised third-party content adapters remain later increments.

## Security baseline

- Sessions use 12-hour `Secure`, `HttpOnly`, `SameSite=Lax` cookies.
- Google OAuth uses cryptographic state, PKCE, and verified OpenID userinfo.
- Production password signup is disabled until email verification exists.
- Mutations enforce same-origin requests for cookie sessions; API callers may use pinned Bearer JWTs.
- Circle, pairing, schedule, chat, feedback, execution, and signaling endpoints require scoped authorisation.
- Weekly pairing writes are atomic and concurrency-safe. Notifications use an idempotent retryable outbox.
- AI is disabled unless explicitly enabled and consented to.
- Automated LeetCode retrieval is disabled without written authorisation. The app uses approved local content or outbound links.

## Architecture

The current deployable prototype is a single-page `index.html` backed by grouped Vercel serverless functions:

| Module | Responsibility |
|---|---|
| `api/auth.js` | signup/login compatibility, logout, session lookup, Google OAuth |
| `api/data.js` | profiles, circle, weeks, schedules, messages, questions, private pair run summaries, execution |
| `api/ops.js` | availability, fair pairing, cron, notification outbox, demo administration |
| `api/ai.js` | disabled-by-default consent-gated feedback workflows |
| `api/video.js` | authenticated pair-scoped WebRTC signaling and revisioned code/board checkpoints |
| `api/_db.js` | Turso client, JWT verification, CSRF helpers |
| `api/_catalog.js` | original exercise catalogue validation, public projections, server-owned evaluation cases |
| `api/_pairing.js` | deterministic fairness and canonical room identifiers |
| `api/_schedule.js` | strict schedule validation, legacy projection, opaque versions, and conflict-safe mutations |
| `api/_messages.js` | strict chat input, cursor, storage projection, and schema-readiness validation |
| `api/_pair-access.js` | shared source-aware authorization for canonical private pair rooms |
| `api/_circle-membership.js` | primary-circle membership, keyed invite hashes, signed short-lived claims, and audited acceptance |
| `api/invitations.js` | owner-only invitation lifecycle and rate-limited public preparation |
| `db/schema-manifest.js` | checksummed contract for 28 application tables and 26 named indexes |
| `db/schema-inspector.js` | read-only SQLite drift inspection and non-executable planning |

The target Next.js/Supabase architecture is intentionally phased rather than introduced as a big-bang rewrite.

## Environment

Copy `.env.example` and configure at least:

- `TURSO_DATABASE_URL` and `TURSO_AUTH_TOKEN`
- `JWT_SECRET` with at least 32 random bytes and a separate `CRON_SECRET`; `RUN_ATTESTATION_SECRET` is optional and falls back to `JWT_SECRET` when blank
- `APP_URL`, `GOOGLE_CLIENT_ID`, and `GOOGLE_CLIENT_SECRET`
- `SIGNUP_ALLOWLIST` for the legacy private-beta Google flow while circle membership enforcement is off
- `CIRCLE_MEMBERSHIP_ENABLED=true` to enforce invitation-gated primary-circle access after the staged migration below
- `AUTH_SCHEMA_BOOTSTRAP_ENABLED=true` only during the documented first-admin bootstrap for a fresh database; otherwise keep it false
- `RESEND_API_KEY` and `RESEND_FROM` for pairing notifications

See [GOOGLE_OAUTH.md](GOOGLE_OAUTH.md) and [TURSO.md](TURSO.md) for provider setup. Back up the database before first deploying migrations.

To roll out circle membership without locking out operators: first complete the production backup/restore rehearsal, deploy with `CIRCLE_MEMBERSHIP_ENABLED=false`, verify an authenticated `ADMIN_EMAILS` account, call the admin-only `POST /api/init`, verify the primary circle and audited non-demo account backfill, then enable the flag. Rollout probes are read-only. Atomic registration guards ensure an account racing initialization is either included or rejected while existing accounts continue to sign in. Invitation tokens are returned only once by the create endpoint; the database stores keyed hashes, and list responses expose only an email fingerprint. Disabling the flag restores the legacy roster behavior without removing membership data, but does not reopen registration after the cutover latch is closed.

Rotating `JWT_SECRET` signs out every session and invalidates outstanding invitation links because the same secret keys invitation/email hashes. Revoke and reissue pending invitations during rotation.

For attestation-key rotation, move each former `RUN_ATTESTATION_SECRET` into the comma-separated `RUN_ATTESTATION_PREVIOUS_SECRETS` list. Retain it there until runs signed with that key no longer need to be verified; removing it makes those historical runs appear unverified.

## Development and tests

Requires Node.js 24 or newer and Python 3 (`python3`) for the aggregate execution tests.

```bash
npm ci
npm run audit:prod
npm run validate:catalog
npm run check:runtime-ddl
npm run check:syntax
npm run test:migrations
npm run test:coverage
npm run test:e2e
```

CI tests the checked-out candidate build on localhost. It validates the catalogue, freezes the existing request-time DDL allowlist, enforces at least 52% line, branch, and function coverage across API, database-foundation, and operational-script modules, and runs the Playwright flows on Ubuntu.

Operators can run `npm run --silent db:status` or `npm run --silent db:plan` with Turso credentials to receive structured JSON drift reports. Both commands are guarded to `SELECT`/`PRAGMA`, and the plan is non-executable. A separate fingerprint-gated `db:migrate` command supports transactional apply or verified adoption only for explicit local `file:` URLs; it rejects every remote target and does not read production credentials. See [Database schema operations](docs/DATABASE_SCHEMA_OPERATIONS.md).

## Next increments

1. Pilot the secure weekly coordination loop and measure completed sessions.
2. Move collaborative editing from revisioned snapshots to a managed realtime/CRDT service as usage grows.
3. Move code execution from the shared Piston service to dedicated isolated workers with queueing and quotas.
4. Add managed video after the coordination workflow is reliable.
5. Add durable session artifacts and consented AI coaching, then expand only with original, licensed, or formally authorised question sources.
