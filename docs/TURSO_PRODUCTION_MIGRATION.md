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
