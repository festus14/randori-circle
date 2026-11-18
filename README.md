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

Built but switched off: secondary circles (multi-circle), AI coaching and the
interview lifecycle. `INTERVIEW_SESSION_ENABLED=true` changes primary
two-person rooms to interviewer-only role/timer/end controls and a 25-minute
timer whose expiry ends the interview for both participants
([ID-95](docs/SESSION_CONTROLS.md#interview-first-increment-464)). Once additive
migration 26 is applied, rooms also open in a lobby: the interviewer admits
the candidate or the agreed schedule starts the interview, the interviewer
owns question and language selection, and can lock candidate editing
([ID-99](docs/SESSION_CONTROLS.md#interview-lobby-schedule-start-question-ownership-and-edit-lock-464)).
It is off by default.
`INTERVIEWER_TOOLKIT_ENABLED=true` additionally enables evaluator-only rubric,
private notes, decisions and downloadable report/playback in the room and
History. It requires interview mode and additive migration **27**, is default
OFF, and never shares writing with the candidate or AI. Evaluations have a fixed
90-day window ([interviewer toolkit](docs/INTERVIEWER_TOOLKIT.md), ID-102).
Merging does not apply v27; production migration needs the owner's approval.
`DAILY_VIDEO_ENABLED=true` (with the server-only `DAILY_API_KEY` and
`DAILY_DOMAIN`) adds consent-gated in-room audio and video through Daily for
primary two-person rooms. Calls are never recorded, and the private meeting
link stays as the fallback. It is off by default and needs no migration
([embedded video](docs/EMBEDDED_VIDEO.md), ID-98).
Not built yet: presence and remote cursors.
Which feature is on in production, and what each flag needs, is in the
[feature flag table](docs/ENVIRONMENT.md#feature-flags).

## Execution languages (dark launch)

JavaScript and Python remain the default. Literal
`EXECUTION_LANGUAGE_TYPESCRIPT_ENABLED=true` enables TypeScript on Vercel Sandbox
and self-hosted Piston; `EXECUTION_LANGUAGE_GO_ENABLED=true` enables Go on Piston
only. The editor lists only additions advertised by the configured server
provider, with a starter for every active exercise. Both flags default off.

TypeScript accepts erasable types, not enums, namespaces, decorators, JSX or
module imports/exports in catalogue functions. Go submissions are `package main`
files with one function entrypoint and offline standard-library imports, no
`main`. Generic starters explain the JSON types; typed function arguments are
also supported. Go custom stdin is explicitly unsupported; TypeScript retains
the private stdin behaviour below.

Script syntax is still erasable-only, and TypeScript may use the pristine Node
24 JavaScript snapshot under the same durable admission. Go compile+run counts
one provider unit, while TypeScript plus private stdin reserves two. Details and
the combined measured/ordinary smoke budgets are in the execution guide.

Rollout, runtime pins, catalogue authoring and smoke budgets:
[execution languages](docs/EXECUTION_LANGUAGES.md) (ID-104). No production or
provider calls were made to enable these flags.

## Private custom stdin (dark launch)

`EXECUTION_STDIN_ENABLED=false` is the default. Set it to literal `true` and
redeploy to expose **Custom input · private** in the editor's Results panel.
Check **Also run the code as a script with stdin**, enter up to 20,000 UTF-8
bytes (empty input is allowed), then press **Run**. The script must read stdin
and print its output. This is an extra isolated execution of the same code,
not another verified test case; function-only starters print nothing unless
you add a script entry point. Guard **all** script-only imports and stdin reads:
the verification harness does not expose Node's `require`/`process`, Python's
`__name__`, or import/stdin builtins. These complete examples work for
**Focus Block Roll-up** in both modes; supply custom stdin such as
`[{"label":"code","minutes":25},{"label":"code","minutes":10}]`.

```javascript
function rollUpFocusBlocks(blocks) {
  const result = [];
  for (const block of blocks) {
    const previous = result[result.length - 1];
    if (previous && previous.label === block.label) previous.minutes += block.minutes;
    else result.push({ ...block });
  }
  return result;
}
if (typeof require === 'function' && typeof process === 'object') {
  const blocks = JSON.parse(require('node:fs').readFileSync(0, 'utf8'));
  console.log(JSON.stringify(rollUpFocusBlocks(blocks)));
}
```

```python
def roll_up_focus_blocks(blocks):
    result = []
    for block in blocks:
        previous = result[-1] if result else None
        if previous and previous['label'] == block['label']:
            previous['minutes'] += block['minutes']
        else:
            result.append(dict(block))
    return result

# The restricted verification namespace has no __name__.
try:
    _script_name = __name__
except Exception:
    _script_name = None
if _script_name == '__main__':
    import json
    import sys
    print(json.dumps(roll_up_focus_blocks(json.loads(sys.stdin.read()))))
```


Only the requester receives `custom_run` stdout/stderr in the no-store execute
response. The room feed, history, attestation and logs keep only the existing
verified catalogue results, never custom input or raw output. The editor code
itself is still shared in pair rooms: do not paste private input into it.
Custom input is not synced, broadcast, or written to browser storage or the
database. Shared-code flushing and asynchronous circle-context checks finish
before stdin is captured. At native fetch dispatch, the input is consumed and
cleared from the textarea, capture token, payload and API/fetch option objects;
serialized request strings are dropped immediately after the browser takes its
transport-owned copy. No application-owned stdin copy waits for the response,
so a stalled flush, preflight or HTTP response cannot extend input retention.
Private dispatch revalidates after preflights, then uses only an immutable
canonical `/api/execute` URL and literal `POST`, never the caller's mutable URL
or Request. Query/hash/routing parameters and encoded or non-canonical private
targets are rejected before capture; ordinary requests are unchanged.
Unsent drafts expire after 60 seconds of inactivity; private output expires 60
seconds after dispatch, never 60 seconds after a delayed response (or immediately
via **Clear private input and output**). Context changes also clear private data.
Leaving or hiding the page also clears private data and invalidates its pending
display. Clearing, editing, unchecking or expiry affects **only** the private
output: the verified request continues and its summary or error still settles.

Both executions share the existing one-active-run account lease and
10-requests-per-minute limit. They run in separate isolated environments in
parallel, so custom code/output cannot alter the server-owned verification
harness or double its deadline. Each gets the existing 256 KiB output cap and
10-second command deadline; Vercel Sandbox is non-persistent, egress-denied,
and deleted on every outcome, with a 60-second session backstop. The custom
Vercel command additionally passes provider-enforced `timeoutMs=10000`, so the
provider kills it even if the HTTP caller disconnects. Only the private Piston
request adds explicit 1-second compile and 10-second run wall/CPU limits;
HTTP retains its 12-second deadline. Catalogue-only provider calls keep their
pre-flag shape and behavior. Application memory is request-scoped; no custom
bytes enter database backups. A custom failure or timeout does not count as a
verified pass and does not erase completed catalogue results.

**Pre-enable checklist — leave the flag off until all items are verified:**

- Rehearse the guarded examples, caps, timeout, and verified/private separation
  on the configured provider using non-sensitive fixtures.
- Verify **Vercel Sandbox command-log retention**, including stdout/stderr
  accessible through its command-log API, and access controls. Deleting the
  microVM/filesystem alone does **not** prove those logs are gone. Confirm that
  private command logs are inaccessible or removed within the 60-second run
  retention window; if that cannot be demonstrated, do not enable the feature.
- For self-hosted **Piston**, verify process limits after disconnect, workspace
  cleanup at completion (60 seconds maximum), and no request-body/stdin/raw
  output logging anywhere in the provider or its proxies.
- Only after provider-owned retention and limits are verified may the owner
  set `EXECUTION_STDIN_ENABLED=true` and redeploy.

Turning the flag off rejects every request containing `stdin` (including an
empty string) with 404, hides the controls after capabilities reload, and
leaves normal catalogue runs unchanged. No migration or request-path DDL.

## Execution capacity (dark launch)

`EXECUTION_QUEUE_ENABLED=true` adds a durable, bounded retry queue, per-circle
and account quotas, interview/practice fairness and global provider-unit spend
ceilings. It defaults **off** and requires **no migration**. Busy/quota responses
keep the editor intact and never record a wrong-answer run. Optional pristine
Vercel runtime snapshots use the installed SDK's supported API; performance is
reported by the existing execution-smoke workflow, not assumed. Live p95 evidence
and activation remain operator-owned; no provider was called for this change.
See [design and knobs](docs/EXECUTION_CAPACITY.md) and
[tuning/rollback runbook](docs/runbooks/execution-capacity.md). Private stdin costs
two provider units and is never automatically replayed after a busy response.

## How it is built

- **Client:** one `index.html` page plus `assets/*.{js,mjs,css}`, with no build step
  apart from the checked-in CRDT editor bundle (`npm run build:crdt`). The
  privacy policy and terms are static pages (`privacy.html`, `terms.html`).
  Public page controls, bulk invitations, email validation and calendar export
  load at first use rather than in a pair room's initial scripts
  ([ID-101](docs/IMPLEMENTED_DECISIONS.md#id-101-load-optional-page-tools-at-their-first-use-without-weakening-byte-gates));
  the [file-byte gates](docs/design/TOKENS.md#byte-budget) remain unchanged.
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
  call set-up, Daily for the embedded interview call (behind its flag), Vercel Sandbox for code execution, Sentry for error reporting
  (production only), and cdnjs, jsDelivr and unpkg, which serve the code
  editor and formatter to the browser.
- **Realtime code relay (optional):** Supabase Realtime private broadcasts,
  behind `REALTIME_RELAY_ENABLED=false` by default. It never stores the code
  document or acknowledges Run; authenticated HTTPS remains authoritative.
- **Pair presence (optional):** who is in the room and, with the relay, the
  partner's live cursor/selection, behind `PRESENCE_ENABLED=false` by default.
  Cursors travel only as Yjs awareness over the same private channel; the
  HTTPS fallback keeps a 20-second keyed "online" row and nothing else.
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
[decision log](docs/IMPLEMENTED_DECISIONS.md). The current system design is
in [docs/SYSTEM_DESIGN.md](docs/SYSTEM_DESIGN.md).

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
matching template. Embedded Daily video reads `DAILY_VIDEO_ENABLED`, the
server-only secret `DAILY_API_KEY` and `DAILY_DOMAIN`; the local runtime
blanks all three ([embedded video setup](docs/EMBEDDED_VIDEO.md#operator-setup)).

For optional sub-second pair-code relay, configure `SUPABASE_URL` and the
browser-safe `SUPABASE_PUBLISHABLE_KEY`, plus server-only sensitive
`SUPABASE_REALTIME_SIGNING_JWK` (private ES256/P-256 JWK) and
`SUPABASE_REALTIME_SIGNING_KID`. Keep `REALTIME_RELAY_ENABLED=false` until the
orchestrator imports/rotates the matching provider signing key, disables public
channels, applies the reviewed SQL and completes the two-browser canary.
[Provider setup and rollback](docs/CONFLICT_FREE_CODE_DOCUMENTS.md#supabase-provider-setup-and-rollback)
include the exact SQL operations. No new Turso migration is required.

Pair-room presence and live partner cursors are a separate default-off flag,
`PRESENCE_ENABLED`. It needs no new provider value or SQL: presence rides the
relay's private channel as a second broadcast event, and its HTTPS fallback
uses the existing `auth_rate_limits` table with a 20-second TTL
([presence](docs/CONFLICT_FREE_CODE_DOCUMENTS.md#presence-and-remote-cursors-462)).

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
