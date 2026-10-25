# Randori Circle

Randori Circle is a private, invite-only app for peer mock interviews. Members
of a small circle say each week whether they are available. Every Sunday they
get a fair, repeat-aware pairing. Partners agree a time, then meet in a private
pair room to practise original JavaScript and Python exercises together.

**Production:** <https://randoricircle.com>. `www.randoricircle.com` redirects
there. The old `randori-circle-self.vercel.app` alias redirects its pages but
still serves `/api/*` (ID-80).

## What it does today

- **Joining.** An owner invites people by email, one at a time or in bulk.
  Invitees join with Google, or with an email and password confirmed through a
  verification link. Visitors can request an invite from the landing page, and
  owners approve or decline requests.
- **Weekly pairing.** Members choose "Available" or "Skip this cycle" before
  the cycle closes at Sunday 08:00 (`Europe/London`). The Sunday job then
  publishes the pairing and emails each participant their partner and room
  link.
- **Scheduling.** Partners propose and accept a time in their own time zones.
  They can export it to a calendar and attach a private meeting link.
  Reminders go out before the availability cutoff, three days after pairing if
  no time is agreed, and one day and one hour before a session.
- **Pair room.** The room has chat, a conflict-free shared code editor (Yjs)
  and a whiteboard saved as checkpoints. It also has a shared focus timer, a
  feed of verified runs and a peer-to-peer audio and video call (WebRTC: media
  goes browser to browser, and the set-up messages relayed through
  `api/video.js` are cleared after about an hour). **Run** evaluates code
  against server-owned test cases in an isolated Vercel Sandbox. A session
  counts as complete only when every participant confirms.
- **History and insights.** Members see pairing recaps, their own progress and
  suggested next exercises. Owners see an aggregate circle health card.
- **Accounts.** Members can link Google and password sign-in, reset a password,
  and delete their own account. App admins have a read-only Diagnostics view.

Built but switched off: secondary circles (multi-circle) and AI coaching.
Not built yet: presence, remote cursors and managed (server-relayed) video.
Which feature is on in production, and what each flag needs, is in the
[feature flag table](docs/ENVIRONMENT.md#feature-flags).

## How it is built

- **Client:** one `index.html` page plus `assets/*.js|css`, with no build step
  apart from the checked-in CRDT editor bundle (`npm run build:crdt`). The
  privacy policy and terms are static pages (`privacy.html`, `terms.html`).
- **API:** Node.js 24 serverless functions in `api/` on Vercel Hobby, grouped
  behind the rewrites in `vercel.json`. Modules starting with `_` are shared
  helpers, not routes.
- **Database:** Turso (libSQL/SQLite). The schema changes only through the
  append-only migration ledger in `db/`. Request paths never run DDL, and CI
  enforces that.
- **Email:** Resend, through one durable, idempotent outbox. Auth, invitation,
  schedule and invite-request notification mail is sent right after commit.
  Pairing and reminder mail is sent by the outbox worker.
- **Other providers:** Google OAuth for sign-in, Google public STUN servers for
  call set-up, Vercel Sandbox for code execution, Sentry for error reporting
  (production only), and cdnjs, jsDelivr and unpkg, which serve the code
  editor and formatter to the browser.
- **Scheduled jobs:**

| Job | Schedule | Runs on |
| --- | --- | --- |
| Weekly pairing publication (`/api/cron/weekly`) | Sunday 08:00 UTC | Vercel cron |
| Outbox worker (`/api/cron/outbox`) | Every 5 minutes | cron-job.org (ID-67), with the `outbox-dispatch` GitHub workflow as a slower backup |
| Outbox delivery-health watchdog | Hourly | GitHub Actions |
| Backup restore rehearsal (Turso PITR into a disposable database) | Monday 03:17 UTC, plus an hourly watchdog | GitHub Actions |
| Live execution smoke check | Daily 07:29 UTC and after each production deploy | GitHub Actions |
| Read-only production smoke check | Daily 07:17 UTC and after each production deploy | GitHub Actions |

The design decisions behind all of this are in the
[decision log](docs/IMPLEMENTED_DECISIONS.md). A current system design document
is being written in [#359](https://github.com/festus14/randori-circle/issues/359).

## Quickstart

You need Node.js 24, npm and Python 3 (`python3`, used by the execution tests).

```bash
git clone https://github.com/festus14/randori-circle.git
cd randori-circle
npm ci
npm run dev
```

Open <http://127.0.0.1:3000> and sign in as the seeded owner,
`owner@randori.test` / `randori-local-owner`.

`npm run dev` starts the real API handlers and the page on loopback. It needs
no Turso, Google, Resend or other credentials:

- It creates `.local/randori.db` and applies every migration before
  listening. Data persists across restarts and is gitignored.
- It seeds one owner and one private circle.
- Email is captured locally and never sent. The owner gets a copy-link for
  each invitation. Open it in a private window and create the invited account
  with any password of 10 to 72 bytes.
- **Run** is unavailable locally: the local runtime never inherits an
  execution provider.
- It refuses to start with production or Vercel settings, a remote database or
  `TURSO_AUTH_TOKEN`, and binds only to loopback.

Stop it with Ctrl+C. To wipe the local data:

```bash
npm run dev:reset -- --confirm
```

An optional `.env.local` can change the host, port or database file; see
[local runtime settings](docs/ENVIRONMENT.md#local-runtime-npm-run-dev). The
full two-user local journey and how to debug it are in
[two-user local session E2E](docs/TWO_USER_LOCAL_SESSION_E2E.md).

## Tests and gates

| Command | What it checks | Runs in CI |
| --- | --- | --- |
| `npm run test:unit` | All unit tests (`tests/unit/*.test.mjs`) | Yes, inside `test:coverage` |
| `npm run test:coverage` | Unit tests with the coverage gate: 97% lines, 92% branches, 99% functions over `api/`, `db/`, `scripts/` and the browser modules listed in `tests/support/coverage.mjs` ([baseline](docs/testing/COVERAGE_BASELINE.md)) | `e2e` |
| `npm run test:migrations` | Migration ledger rehearsal on local database files | `e2e` |
| `npm run test:e2e` | Playwright journeys, including real-runtime golden paths ([matrix](docs/testing/E2E_GOLDEN_PATHS.md)). Run `npx playwright install --with-deps chromium` once first | `e2e` |
| `npm run check:syntax` | `node --check` over `api/`, `db/`, `scripts/` and the test sources | `e2e` |
| `npm run check:crdt` | The checked-in CRDT bundle matches its pinned sources | `e2e` |
| `npm run check:runtime-ddl` | No API or runtime code issues schema DDL | `e2e` |
| `npm run check:turso-sql` | No SQL that Turso's remote protocol rejects | Covered by a unit test |
| `npm run validate:catalog` | Exercise catalogue and provenance manifest | `e2e` |
| `npm run audit:prod` | `npm audit` of production dependencies | `e2e` |
| `npm run check:deployability` | `vercel.json` routes, headers, crons and the pinned scheduler workflows | `deployability` |
| `npm run check:backup-controls` | The backup, restore and migration workflow contract | `deployability` |
| `npm run test:deployability` | Release-contract failure-mode tests | `deployability` |
| `npm test` | Deployability, catalogue, DDL, syntax, CRDT, coverage and e2e in one go | No |

Before pushing, run `test:unit`, `test:coverage`, `check:syntax`, `check:crdt`,
`check:deployability`, `check:turso-sql`, `check:runtime-ddl` and
`check:backup-controls`.

Pull requests need the `deployability`, `e2e` and GitGuardian checks to pass.
Vercel previews and the `ubuntu-26-canary` job are advisory
([deployment and merge gates](docs/DEPLOYMENT_GATES.md)).

## How deploys work

1. Merging to `main` deploys production through Vercel's GitHub integration.
   There is no manual promote step.
2. After each production deploy, the `production-smoke` and `execution-smoke`
   workflows check the live site. Both are signals, not merge gates.
3. `/api/health/ready` returns 200 only when the database matches the exact
   schema and migration ledger the deployed code expects. Code that needs a
   newer migration therefore makes readiness fail until that migration is
   applied. Migrations reach production only through the protected
   [Turso production migration](docs/TURSO_PRODUCTION_MIGRATION.md) workflow,
   one approved version at a time after a fresh restore rehearsal. A
   zero-downtime expand-then-migrate release order is being defined in
   [#371](https://github.com/festus14/randori-circle/issues/371).
   Health checks: `/api/health/live` (alias `/api/healthz`) only checks that
   the process answers. `/api/health/ready` (aliases `/api/readyz` and
   `/api/health`) is the deploy gate described above. Both return generic
   `no-store` bodies ([details](docs/DATABASE_SCHEMA_OPERATIONS.md)).
4. New user-visible features merge behind a feature flag that is off. The
   owner turns a flag on in Vercel Production and redeploys.
5. Vercel reads environment variables only at deploy time, so redeploy after
   changing any of them.

Setting up production from scratch is covered step by step in the
[production bootstrap guide](docs/PRODUCTION_BOOTSTRAP_GUIDE.md).

## Configuration

[docs/ENVIRONMENT.md](docs/ENVIRONMENT.md) lists every environment variable
the code reads: purpose, whether it is required, default, whether it is secret,
and where it is set. It also has the feature flag table with production state
and how to switch each flag off safely. [`.env.example`](.env.example) is the
matching template.

## Security baseline

- Sessions use 12-hour `Secure` (in production / over HTTPS), `HttpOnly`, `SameSite=Lax` cookies. Each is
  backed by a hashed, revocable database row, with at most eight live sessions
  per account.
- Google sign-in uses state, PKCE, a nonce and a stable provider subject.
  Linking a second sign-in method is always explicit, and the last one cannot
  be removed.
- Cookie-authenticated writes must be same-origin. Every private read and write
  is authorized on the server against the session and the active circle.
- Sensitive circle changes (ownership, co-owners, app admins) need a sign-in
  from the last ten minutes.
- Invitation, verification and reset links are single-use. They are stored
  hashed, and sealed with a purpose-specific key ring while queued for email.
- Logs, metrics and Sentry events are redacted: no emails, tokens or raw IP
  addresses (ID-72, ID-82).
- The catalogue is original, provenance-checked content. Nothing is scraped
  from third-party sites.
- AI coaching is off.

## Documentation

- [Documentation index](docs/README.md): every doc, grouped by area.
- [Decision log](docs/IMPLEMENTED_DECISIONS.md): why things are built the way
  they are.
- Operations runbooks: [production bootstrap](docs/PRODUCTION_BOOTSTRAP_GUIDE.md),
  [migrations](docs/TURSO_PRODUCTION_MIGRATION.md),
  [backup and restore rehearsal](docs/TURSO_BACKUP_RESTORE_REHEARSAL.md),
  [key rotation](docs/KEY_ROTATION.md),
  [outbox scheduler](docs/OUTBOX_EXTERNAL_SCHEDULER.md),
  [chat retention](docs/CHAT_RETENTION.md). More runbooks are tracked in
  [#361](https://github.com/festus14/randori-circle/issues/361).
- [UI redesign spec](docs/design/UI_REDESIGN_SPEC.md): design tokens and
  components.
- Provider notes: [Google OAuth](GOOGLE_OAUTH.md) and [Turso](TURSO.md).
- Roadmap: [#312](https://github.com/festus14/randori-circle/issues/312).
