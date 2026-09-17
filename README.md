# Randori Circle

Randori Circle is a private peer mock-interview app. Members publish availability, receive a fair weekly pairing, schedule a session, chat, and practise JavaScript or Python questions together.

Production deploys from `main` through Vercel. Development is iterative; the architecture and rollout decisions are documented in [the production plan](docs/PRODUCTION_ARCHITECTURE_PLAN.md).

## Current private-beta workflow

1. An allowlisted member signs in through verified Google OAuth.
2. The Sunday cron creates one deterministic, repeat-aware pairing cycle.
3. Each participant receives a personalised email containing only their partner and private room link.
4. Partners follow a private invite, propose a time, chat, and open their authorised session workspace.
5. JavaScript and Python execute through the authenticated server gateway; browser-origin code execution is disabled.

Code, language, and question choice now synchronize across devices through bounded, revisioned pair-room snapshots. Managed video, durable board collaboration, consented AI coaching, and authorised content expansion remain later increments.

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
| `api/data.js` | profiles, circle, weeks, schedules, messages, questions, runs, execution |
| `api/ops.js` | availability, fair pairing, cron, notification outbox, demo administration |
| `api/ai.js` | disabled-by-default consent-gated feedback workflows |
| `api/video.js` | authenticated pair-scoped WebRTC signaling |
| `api/_db.js` | Turso client, JWT verification, CSRF helpers |
| `api/_pairing.js` | deterministic fairness and canonical room identifiers |
| `db/` | canonical schema, ordered migrations, ledger validation, read-only readiness |

The target Next.js/Supabase architecture is intentionally phased rather than introduced as a big-bang rewrite.

## Environment

Copy `.env.example` and configure at least:

- `TURSO_DATABASE_URL` and `TURSO_AUTH_TOKEN`
- `JWT_SECRET` and a separate `CRON_SECRET`
- `APP_URL`, `GOOGLE_CLIENT_ID`, and `GOOGLE_CLIENT_SECRET`
- `SIGNUP_ALLOWLIST` for private-beta Google accounts
- `RESEND_API_KEY` and `RESEND_FROM` for pairing notifications

See [GOOGLE_OAUTH.md](GOOGLE_OAUTH.md) and [TURSO.md](TURSO.md) for provider setup. Back up the database before first deploying migrations.

## Development and tests

Requires Node.js 24 or newer.

```bash
npm ci
npm run db:migrate
npm run db:status
npm run check:syntax
npm run test:coverage
npm run test:e2e
```

CI tests the checked-out candidate build on localhost. It rejects request-path schema DDL, enforces at least 52% line, branch, and function coverage across application, migration, and migration-CLI modules, and runs the Playwright flows on Ubuntu.

## Next increments

1. Pilot the secure weekly coordination loop and measure completed sessions.
2. Introduce managed shared editing and isolated code execution.
3. Add managed video after the coordination workflow is reliable.
4. Add durable workspace artifacts, then consented AI coaching.
5. Expand only with original, licensed, or formally authorised question sources.
