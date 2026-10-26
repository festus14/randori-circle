# Protected Turso production migration runbook

Randori's production database can be inspected, adopted, or advanced only by the manually dispatched **Turso production migration** GitHub Actions workflow. The workflow is intentionally disabled for mutations until a real point-in-time restore rehearsal from the same current `main` commit has succeeded.

The workflow does not expose a general remote migration CLI. It runs in the protected `turso-production-migration` environment, shares the `turso-production-database-operations` concurrency group with the restore rehearsal, and accepts only the repository's latest `main` commit.

## Authorization contract

Before requesting any database-scoped token, the workflow must complete all of these checks:

1. Fetch the operator-selected workflow run and artifact through the GitHub Actions API using the current job's read-only `GITHUB_TOKEN`.
2. Require the exact repository name and numeric ID, rehearsal workflow path, `workflow_dispatch` event, `main` branch, successful conclusion, run ID, run attempt, and current repository commit.
3. Require exactly one unexpired artifact with the deterministic run/attempt name. Its bounded ZIP may contain only `rehearsal-summary.json`.
4. Verify the canonical HMAC attestation, its maximum age, exact RPO/RTO policy, schema and executable-migration checksums, source/restore identity separation, PITR binding, evidence results, and cleanup safety claims.
5. Recompute the attested source identity and backup-reference digests from protected values.
6. Fetch Turso metadata and configuration and require the exact production name, immutable `DbId`, group, null parent, and configured `block_writes` value.

The database identity and provider state are checked again after the short-lived database token is minted and immediately before a mutation. Status receives a read-only token and a statement guard. Adopt/apply receive a ten-minute full-access token only after the evidence and first provider-identity checks have passed.

The migration runner recomputes the supplied state fingerprint inside the write transaction. Lock conflicts known to occur before a commit may retry within a small bound; a failed commit has an unknown outcome and is never retried. The workflow emits only a redacted result—never a database name, ID, hostname, URL, token, SQL statement, row value, or raw provider error.

## One-time GitHub setup

Create an environment named `turso-production-migration`. Restrict it to `main` and add the operational protection rules used by the team. Keep mutation disabled initially.

Store these environment secrets:

| Secret | Purpose |
| --- | --- |
| `TURSO_PRODUCTION_PLATFORM_TOKEN` | Minimum-permission Turso Platform API access for the configured organization |
| `MIGRATION_DIGEST_HMAC_KEY` | The same random 32+ byte key used by `turso-migration-rehearsal`, so its attestation can be verified |

Store these environment variables:

| Variable | Required value |
| --- | --- |
| `TURSO_ORGANIZATION` | Exact organization slug |
| `TURSO_GROUP` | Exact production database group |
| `TURSO_PRODUCTION_DATABASE_NAME` | Exact production database name |
| `TURSO_PRODUCTION_DATABASE_ID` | Immutable production `DbId` |
| `TURSO_PRODUCTION_EXPECTED_BLOCK_WRITES` | Exact protected provider state: `true` or `false` |
| `MIGRATION_REHEARSAL_MAX_AGE_MS` | Maximum accepted attestation age, no more than `1800000` |
| `REHEARSAL_RPO_TARGET_MS` | Must be the fixed rehearsal RPO target `1800000` (30 minutes) |
| `REHEARSAL_RTO_TARGET_MS` | Must be the fixed rehearsal RTO target `900000` (15 minutes) |
| `TURSO_PRODUCTION_MIGRATIONS_ENABLED` | Keep `false`; set to `true` only for an approved mutation window |

`GITHUB_TOKEN` is provided by Actions with only `actions: read` and `contents: read`. Credentials are scoped to the migration step; checkout, validation, setup, and dependency installation do not receive them. All external actions are pinned to immutable commits.

## Version-agnostic stepwise migration sequence

The successful rehearsal and every migration operation must use the same current
`main` commit. A code change invalidates the attestation. A production mutation
also invalidates it: each adopted prefix or applied version changes the source
state, so the next step requires a new rehearsal and a new status result.

1. Run **Turso backup restore rehearsal** on current `main` with
   `RESTORE_DISPOSABLE_ONLY`. Wait for cleanup and the signed-artifact upload.
2. Copy its numeric run ID and attempt. Within the attestation lifetime,
   dispatch **Turso production migration** with:
   - operation `status`;
   - an empty target version;
   - an empty state fingerprint; and
   - confirmation `INSPECT_PRODUCTION_DATABASE`.
3. Read `migration-result.json` from the result artifact. Do not copy a
   fingerprint from logs, an older run, or another database. The ordered
   `pendingVersions` is informational; only `nextVersion` is actionable.
4. If the state is unmanaged, temporarily enable mutations and dispatch
   `adopt` with the status fingerprint, an empty target version, and confirmation
   `MIGRATE_PRODUCTION_DATABASE`. Disable mutations immediately. Adoption writes
   only the exact historical ledger prefix. Return to step 1 before applying.
5. If the state is managed and `nextVersion` is an integer, review that one
   migration. Temporarily enable mutations and dispatch `apply` with the exact
   status fingerprint, `target_version` equal to `nextVersion`, the same fresh
   rehearsal run/attempt, and confirmation `MIGRATE_PRODUCTION_DATABASE`.
   Disable mutations immediately after the run.
6. Return to step 1 after every successful mutation. Never use the prior
   rehearsal or fingerprint for the next version. Finish only when a fresh
   rehearsal plus `status` reports the repository latest version,
   `pendingVersions: []`, `nextVersion: null`, and `capabilities.apply: false`.

Each mutation requires a freshly supplied 64-character lowercase fingerprint.
An unmanaged database cannot be applied before adoption, and adoption cannot
change application schema or data. Apply has no no-op or catch-up mode: the
explicit target must equal both the attested source version plus one and the
live managed version plus one. The runner passes only the migration prefix
through that target to the transactional engine, so later checked-in migrations
cannot execute under the same approval.

The redacted status and mutation artifact uses
`randori.turso-production-migration.v2`; version 1 artifacts do not carry an
explicit target and are not authorization inputs for this workflow.

## Zero-downtime additive releases (expand, migrate, use)

Readiness normally needs the database at exactly the version the code knows,
so merging a migration takes `/api/health/ready` and the pairing endpoints down
until the sequence above finishes. A migration declared
`compatibility: 'additive'` in `db/migration-contract.js` avoids that (ID-87,
#371): code that knows migrations 1..N is also ready when the database is at
N-1, provided migration N is additive. Nothing else is tolerated. Two versions
behind, a breaking migration still to apply, or a database newer than the code
all stay not ready, and every other readiness rule is unchanged: each applied
ledger row's checksum and metadata, the exact schema of the version actually
applied, key control and membership. The tolerance applies to health
readiness, `/api/init`, circle-pairing and schedule readiness, and admin
diagnostics. Pairing publication readiness checks only the v6 core contract;
it already accepted any later ledger prefix, and an additive migration cannot
change that contract.

### Writing an additive migration

1. Append the plan, the executable migration and the contract as usual. In the
   contract, set `compatibility: 'additive'` and list exactly what it creates:
   `introduces: {tables: [...], indexes: [...], triggers: [...]}`.
2. Keep it additive. It may create tables with new names, indexes with new
   names (on new tables, or non-unique on existing tables), and triggers and
   seed rows on its new tables only. It may not drop, rename, alter, update or
   delete anything that exists, redefine a table, or add a unique index or a
   trigger to an existing table, because both change how the running code's
   writes behave. `ALTER TABLE ... ADD COLUMN` has no executable operation yet,
   so put new fields in a new table, or add the operation to the runner, the
   inspector and the check together first.
   `db/migration-compatibility-check.js` enforces this. `npm run
   check:deployability` reports a mislabelled migration, and every migration
   tool (`db:migrate`, this workflow, the restore rehearsal) refuses to load
   one.
3. Every code path that touches the new tables checks the schema first, with
   `api/_schema-capability.js`. Paths that serve the feature (endpoints) use
   `schemaFeatureAvailable(db, {enabled: <feature flag>, version: N})`; while
   it returns `false` they behave exactly as if the feature were off: 404, no
   capability advertised, nothing read or written. Outbox delivery handlers
   check the flag themselves and suppress while it is off, so queued rows
   drain instead of aging into a backlog alert. Data-lifecycle paths
   (account deletion, retention) probe the new tables directly and treat
   "no such table" as not installed, so rows already stored keep being
   deleted after the flag is turned off. No other code may depend on the
   new schema.
4. The feature flag defaults off.

Migrations 1-21 shipped under the strict order and stay `breaking`: the code
that shipped with them assumes their schema is present.

### Release order

1. **Merge** with the database still at N-1. Production stays ready on N-1:
   `/api/health/ready` returns 200, and the admin diagnostics readiness card
   shows *Degraded* with "pending additive migration vN".
2. **Run the cutover for N** with the stepwise sequence above: a fresh
   rehearsal from the merged `main` commit, then `status` (its `nextVersion` is
   N), then `apply` N. The app stays ready throughout, and the readiness card
   returns to current.
3. **Turn the feature flag on.** This is an owner-approved production
   environment change. The schema capability notices the applied migration
   within 30 seconds: a pending answer is cached for 30 seconds and a present
   one for 5 minutes per database.

Operator tools that require the latest version, such as the chat-retention
CLI, run only after step 2.

### Rollback

1. **Turn the feature flag off first.** The feature's endpoints return 404
   again and nothing touches the new tables. No schema change is needed, and
   this is enough for almost every incident.
2. **Restore with PITR only if needed**, using the recovery procedure below,
   to a point before migration N. The deployed code (at N) stays ready on the
   restored N-1 database, because N is additive.
3. **After a PITR, do not rely on lifecycle paths until the stale
   capability cache is gone.** The schema-capability cache lives in each
   instance's memory (`api/_schema-capability.js`), not in the database, so
   restoring the database does not clear it: a warm instance that already
   cached migration N as present keeps reporting it present for up to
   5 minutes (`SCHEMA_CAPABILITY_AVAILABLE_TTL_MS = 5 * 60 * 1000`), even
   though the ledger row and the new tables are gone. Turning the flag off
   (step 1) already protects the feature paths, because the
   `FEEDBACK_ENABLED` gate returns 404 before the capability check is
   reached (`schemaFeatureAvailable` itself also short-circuits when its
   enabled flag is off) — but a path that gates only on
   `schemaCapabilityAvailable` has no flag to protect it. Today's lifecycle
   paths are not affected by this cache — account deletion probes the
   ledger directly inside its transaction, and feedback retention runs
   against the tables directly and treats `no such table` as not
   installed. This precaution applies to any path — present or future —
   that gates only on `schemaCapabilityAvailable`. Keep the flag
   off and either wait out the 5-minute TTL or redeploy (a redeploy starts
   fresh instances with an empty cache) before relying on lifecycle paths.

Do not roll the code back to N-1 while the database is at N. Code is never
ready on a database newer than itself, so readiness would fail. Leave the code
at N with the flag off instead.

### Breaking migrations

A migration declared `breaking` keeps the strict behaviour. Merging it takes
readiness down until the cutover applies it, so apply it straight after the
merge and away from the Sunday 08:00 UTC pairing run. A destructive or
long-running migration still needs the separate maintenance protocol described
under "Failure and recovery".

### Worked example: feedback tables (#353)

The feedback platform adds `feedback_items`, `feedback_votes` and
`feedback_events` with their indexes as migration 22. The contract declares
`compatibility: 'additive'` and lists those tables and indexes under
`introduces`. Only the feedback endpoints call `schemaFeatureAvailable(db,
{enabled: true, version: 22})` (after the `FEEDBACK_ENABLED` gate in the
handler); no capability is advertised anywhere. The
`feedback.submitted` outbox event does not call `schemaFeatureAvailable`:
the delivery plan registers its handler whenever a sender exists, and the
handler itself suppresses with `FEEDBACK_DISABLED` while the flag is off,
so queued rows drain instead of aging into a backlog alert. The 12-month
retention job does not call `schemaCapabilityAvailable` either — it runs
against the tables and treats a "no such table" failure as not installed —
and neither does account deletion, which probes the feedback tables
directly (`SELECT … LIMIT 0`). Release: merge with production at v21 (ready, card
degraded), run rehearsal, status and apply 22 as soon as it is ready (owner
decision, 2026-10-22), then turn `FEEDBACK_ENABLED` on. To roll back, turn
`FEEDBACK_ENABLED` off; use PITR only if the tables themselves are the problem
(see Rollback step 3 if you use PITR).

## Failure and recovery

Any nonzero result means stop. Do not rerun a mutation with the same fingerprint,
because a commit failure can have an unknown outcome. Perform a new rehearsal,
run a new status, establish the authoritative current state, and review the
result. A previous attestation is intentionally rejected after any source-state
change, including a successful apply or adoption.

There are no automatic down migrations. The rollback asset is the verified PITR capability and its protected runbook, not reverse SQL. If an applied migration causes an incident, keep database administration exclusive, preserve evidence, and make a deliberate restore/cutover decision using the Turso recovery procedure.

The current migrations are ordered and independently reviewed. Their presence in
one repository commit does not authorize batching them. They may run with either
protected expected `block_writes` value only when the selected migration's own
reviewed contract permits it and both Turso metadata surfaces agree. A future
destructive or long-running migration must introduce and rehearse a separate
maintenance protocol; changing this variable is not by itself sufficient
authorization for such work.

Turso's token and metadata endpoints are name-addressed. The workflow rechecks the immutable `DbId` around token creation and before mutation, while repository concurrency prevents its own rehearsal/migration jobs from overlapping. Operators must still prevent out-of-band database rename, delete, or recreate operations during the window because the provider does not offer an atomic ID-conditioned token request.

Mocked unit tests verify orchestration and safety behavior but do not authorize production. Keep `TURSO_PRODUCTION_MIGRATIONS_ENABLED=false` until the protected environment is configured and issue #38 records a successful real provider rehearsal.
