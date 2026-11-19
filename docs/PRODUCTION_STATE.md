# Production state

Owner-maintained record of what is switched on at https://randoricircle.com and
of provider-side settings that live outside this repository. Code, decisions and
runbooks stay authoritative for *how* things work; this page records *what is
currently true in production*. Update it in the same change (or immediately
after) whenever a production flag, migration, credential or provider setting
changes, and say what verified it. Nothing checks this page's content
automatically (`check:docs` only checks its links), so a stale entry here is
possible: confirm against the live system before acting on it.

Last updated: 2026-11-19.

## Database

- Production database: Turso `randori-prod` (`aws-eu-west-1`), served by Vercel
  functions in `dub1`.
- Migration ledger: **v27** (`pendingVersions: []`).
  - v26 applied 2026-11-18 by the protected workflow (rehearsal
    `44411675056` → status `44413575630` → apply `44414876618`), confirmed by a
    fresh rehearsal and status (`currentVersion 26`).
  - v27 applied 2026-11-19 (rehearsal `44471736649` → status `44472684833` →
    apply `44473110707`).
  - **Invariant:** `TURSO_PRODUCTION_MIGRATIONS_ENABLED` is `false` except during
    a supervised apply; confirm it is `false` after every apply.
- Credentials: `TURSO_AUTH_TOKEN` (Vercel Production) and
  `DELETION_LEDGER_AUTH_TOKEN` (Vercel Production and GitHub Actions) were
  rotated on 2026-11-19 to 365-day tokens, expiring about 2027-11-19.
- The daily credential-expiry workflow (#486/#487) watches
  `DELETION_LEDGER_AUTH_TOKEN` directly, and the app's Turso token only
  through `TURSO_AUTH_TOKEN_EXPIRY_WATCH`, a GitHub Actions secret holding an
  exact copy of it; the workflow cannot read Vercel's `TURSO_AUTH_TOKEN`.
  **Invariant:** whenever `TURSO_AUTH_TOKEN` is rotated, update
  `TURSO_AUTH_TOKEN_EXPIRY_WATCH` in the same change, or the alarm keeps
  reporting the old token. See [CREDENTIAL_EXPIRY.md](CREDENTIAL_EXPIRY.md),
  which also records the 2026-11-18/19 expired-token outage.

## Feature-flag state after this rollout

| Flag | State | Verified by |
|---|---|---|
| `INTERVIEW_SESSION_ENABLED` | On since 2026-11-19 | Migration v26 applied first; enabled with no interview timer running; readiness 200 and production smoke 16/16 after the redeploy |
| `INTERVIEWER_TOOLKIT_ENABLED` | On since 2026-11-19 | Migration v27 applied first; `interviewerToolkit` capability |
| `PRESENCE_ENABLED` | On since 2026-11-19 | `presence` capability |
| `EXECUTION_LANGUAGE_TYPESCRIPT_ENABLED` | On since 2026-11-19 | Real Vercel Sandbox canary 8/8 with egress blocked; production execution smoke `typescript: ok` |
| `EXECUTION_QUEUE_ENABLED` | On since 2026-11-19 | Drained enable (provider unset → 100 s drain → queue on → provider restored); `executionQueue` capability |
| `EXECUTION_STDIN_ENABLED` | On since 2026-11-19 | Owner decision after the provider-retention review (README pre-enable checklist); privacy policy updated first; real sandbox stdin canary |
| `REALTIME_RELAY_ENABLED` | On since 2026-11-19 | Provider canary below; `realtimeRelay` capability; unauthenticated token request 401 |
| `EXECUTION_LANGUAGE_GO_ENABLED` | Off (owner decision) | Production runs Vercel Sandbox; Go is Piston-only |
| `EXECUTION_WARM_MEASURE_ENABLED` | Off (owner decision) | Stay on cold starts; no snapshots built |
| `DAILY_VIDEO_ENABLED` | Off | See [Daily video](#daily-video) |

The full flag table, including older flags, is in
[ENVIRONMENT.md](ENVIRONMENT.md#feature-flags).

## Execution

- Provider: `EXECUTION_PROVIDER=vercel-sandbox`; queue, stdin and TypeScript
  on; Go off; no warm snapshots.
- Adding languages later: per-language Vercel Sandbox snapshots, starting with
  Java and C++ (owner decision 2026-11-19: not now).

## Supabase realtime relay

Dedicated relay-only project (the origin in `SUPABASE_URL`).

- Realtime `private_only: true` (public channels off); Supabase Presence off.
- Signing keys: the project's only trusted key is our own imported P-256 key
  (`kid` = `SUPABASE_REALTIME_SIGNING_KID`), generated offline; the private JWK
  is held only in `SUPABASE_REALTIME_SIGNING_JWK` and an offline backup.
  The HS256 legacy secret and the Supabase-generated ES256 key were revoked on
  2026-11-19, so the public JWKS lists only the in-use key.
- Legacy JWT API keys (`anon`, `service_role`) disabled 2026-11-19, and the HS256
  secret that signed them revoked, so they fail signature validation. Before
  that, the legacy `service_role` key could join any private room. It was never
  in application configuration, a client bundle or this repository.
- Policies: [`supabase/realtime-authorization.sql`](../supabase/realtime-authorization.sql)
  from `a3b3837` applied (four `rc_code_relay_*` policies, RLS on); see the
  setup runbook in
  [CONFLICT_FREE_CODE_DOCUMENTS.md](CONFLICT_FREE_CODE_DOCUMENTS.md#supabase-provider-setup-and-rollback).
- Provider canary (2026-11-19): both participants join privately and exchange
  `y-update`/`y-awareness`; another room's token, a connection using only the
  publishable key (no access token), expired tokens and tokens without a room
  claim are refused; Supabase Presence tracking is refused; joined connections
  are cut off at token expiry. After the legacy keys were disabled, the legacy
  `anon` and `service_role` JWTs are refused as well.
- `PRESENCE_ENABLED` is the app's own presence feature, carried over the relay
  as `y-awareness` broadcasts (plus an HTTPS heartbeat). It is unrelated to
  Supabase Presence, which stays off at the provider: do not turn Supabase
  Presence on to fix an app presence problem.
- **Invariants:**
  - The project stays relay-only: no application tables, and never add a table
    to the `supabase_realtime` publication. Realtime accepts a join that
    requests `postgres_changes`; such subscriptions are inert only because that
    publication is empty.
  - Keep public channels off and legacy keys disabled.
  - The new-style `sb_secret_…` key bypasses RLS and is not used by the app;
    never put it in application configuration.

## Daily video

- Domain `randori-circle.daily.co`. Domain defaults checked 2026-11-19 through
  the REST API: no recording mode, auto-recording and transcription unset,
  transcription storage off, no recordings bucket.
- A room minted by the app's own code is private, has two seats, no recording
  mode, and expires and ejects after two hours.
- **Blocked:** Daily Prebuilt is unavailable on this account until billing is
  set up; in a 2026-11-19 test, two browsers could not join (Daily reported no
  participants). `DAILY_VIDEO_ENABLED` stays off.
- Before enabling (owner decision 2026-11-19): complete Daily billing setup;
  keep usage inside the published free allowance (10,000 participant-minutes a
  month, as published on 2026-11-19) with the budget guard and automatic
  direct-call fallback from #490; then run the two-participant join canary.
- **Invariant:** do not turn `DAILY_VIDEO_ENABLED` on before #490's budget
  guard is live; Daily has no spending ceiling of its own.

## Known alerts

- The backup-restore watchdog alerts hourly until the next scheduled Monday
  rehearsal (2026-11-23 03:17 UTC) succeeds. Its last scheduled run
  (2026-11-16) reported `cleanup_failure` because it could not confirm and
  delete its disposable restore; that restore database was never created
  (Turso returns 404 for it), production writes were restored, and every manual
  rehearsal since has passed. **Invariant:** if the 2026-11-23 scheduled
  rehearsal also fails, treat the alert as real and do not rely on restores
  until a rehearsal passes.
