# Randori Circle

Randori Circle is a private peer mock-interview app. Members publish availability, receive a fair weekly pairing, schedule a session, chat, and practise JavaScript or Python questions together.

Production deploys from `main` through Vercel. Development is iterative; the architecture and rollout decisions are documented in [the production plan](docs/PRODUCTION_ARCHITECTURE_PLAN.md).

## Current private-beta workflow

1. An allowlisted member signs in through verified Google OAuth.
2. The Sunday cron creates one deterministic, repeat-aware pairing cycle.
3. Each participant receives a personalised email containing only their partner and private room link.
4. Partners propose a time, chat, and open the session workspace, where code and completed whiteboard gestures are saved as one room-scoped checkpoint.
5. Members choose from the original, provenance-checked catalogue; JavaScript and Python are evaluated against server-owned cases and the authoritative result is saved by the API.
6. Both partners see a room-scoped feed of verified run summaries; source code, hidden cases, provider output, and unrelated personal runs remain private.

Pair workspaces now persist authenticated, revisioned code and whiteboard snapshots across devices. A completed board gesture is saved locally immediately and then synced; if the network is unavailable, the room keeps a dirty local checkpoint and retries after hydration. Viewport, selected tool, and colour are intentionally device-local. Snapshots expire after 90 days, and v1/v2 code-only rooms upgrade without losing their draft.

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

The target Next.js/Supabase architecture is intentionally phased rather than introduced as a big-bang rewrite.

## Environment

Copy `.env.example` and configure at least:

- `TURSO_DATABASE_URL` and `TURSO_AUTH_TOKEN`
- `JWT_SECRET` and a separate `CRON_SECRET`; `RUN_ATTESTATION_SECRET` is optional and falls back to `JWT_SECRET` when blank
- `APP_URL`, `GOOGLE_CLIENT_ID`, and `GOOGLE_CLIENT_SECRET`
- `SIGNUP_ALLOWLIST` for private-beta Google accounts
- `RESEND_API_KEY` and `RESEND_FROM` for pairing notifications

See [GOOGLE_OAUTH.md](GOOGLE_OAUTH.md) and [TURSO.md](TURSO.md) for provider setup. Back up the database before first deploying migrations.

For attestation-key rotation, move each former `RUN_ATTESTATION_SECRET` into the comma-separated `RUN_ATTESTATION_PREVIOUS_SECRETS` list. Retain it there until runs signed with that key no longer need to be verified; removing it makes those historical runs appear unverified.

## Development and tests

Requires Node.js 24 or newer and Python 3 (`python3`) for the aggregate execution tests.

```bash
npm ci
npm run audit:prod
npm run validate:catalog
npm run check:syntax
npm run test:coverage
npm run test:e2e
```

CI tests the checked-out candidate build on localhost. It validates the catalogue, enforces at least 52% line, branch, and function coverage across every `api/*.js` module, and runs the Playwright flows on Ubuntu.

## Next increments

1. Pilot the secure weekly coordination loop and measure completed sessions.
2. Move collaborative editing from revisioned snapshots to a managed realtime/CRDT service as usage grows.
3. Move code execution from the shared Piston service to dedicated isolated workers with queueing and quotas.
4. Add managed video after the coordination workflow is reliable.
5. Add durable session artifacts and consented AI coaching, then expand only with original, licensed, or formally authorised question sources.
