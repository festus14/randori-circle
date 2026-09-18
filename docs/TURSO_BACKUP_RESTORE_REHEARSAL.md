# Turso backup/restore rehearsal runbook

This runbook exercises Turso point-in-time recovery (PITR) without migrating or deleting the production source database. The workflow is manual-only, runs from the latest `main` commit, and uses the protected `turso-migration-rehearsal` GitHub environment.

## Safety contract

The workflow will stop unless the Platform API returns the configured production database name, immutable `DbId`, group, and a database with no parent. It records the existing `block_writes` value, confirms writes are blocked through both database metadata and configuration, and only then selects the PITR timestamp. It restores the original value on success and every failure path.

PITR always creates a new, disposable database. The workflow requires its new `DbId`, exact generated name and group, and an exact parent `{id, name}` binding to production before connecting. Adoption and migration run only through the disposable restore client. Cleanup retrieves the restore again and deletes it only if that exact identity and parent still match. Production is never passed to the migration runner or delete operation.

Both connections use short-lived, database-scoped tokens: read-only for the source and full-access for the disposable restore. Tokens expire naturally. Do not add token invalidation: Turso invalidation can rotate a group signing key and disrupt unrelated clients.

Platform requests time out after 15 seconds, individual database operations after 30 seconds, and restore/configuration polling after 60 attempts at five-second intervals. The GitHub job has a 45-minute outer bound. Script-level bounds fail into cleanup before the job-level bound is reached, so the source write-state restoration path still runs.

## One-time GitHub setup

Create an environment named `turso-migration-rehearsal`. Restrict deployment branches to `main`, prevent concurrent runs, and require an operations approver before environment secrets are released. Store these values in that environment, not as repository-wide credentials:

| Kind | Name | Purpose |
|---|---|---|
| Secret | `TURSO_PRODUCTION_PLATFORM_TOKEN` | Platform API access scoped to the production organization |
| Secret | `MIGRATION_DIGEST_HMAC_KEY` | Random 32+ byte evidence-authentication key |
| Variable | `TURSO_ORGANIZATION` | Exact organization slug |
| Variable | `TURSO_GROUP` | Exact production group |
| Variable | `TURSO_PRODUCTION_DATABASE_NAME` | Exact production database name |
| Variable | `TURSO_PRODUCTION_DATABASE_ID` | Immutable production `DbId` from Turso |
| Variable | `TURSO_RESTORE_DATABASE_PREFIX` | Disposable lowercase prefix, for example `randori-rehearsal` |
| Variable | `REHEARSAL_MAX_SNAPSHOT_AGE_MS` | Maximum PITR snapshot age, recommended `1800000` |
| Variable | `REHEARSAL_MAX_EVIDENCE_AGE_MS` | Evidence validity window, recommended `1800000` |
| Variable | `REHEARSAL_RPO_TARGET_MS` | Required recovery-point objective, recommended `1800000` |
| Variable | `REHEARSAL_RTO_TARGET_MS` | Required restore-time objective, recommended `900000` |

Use a dedicated Platform API token with only the minimum organization permissions Turso supports. GitHub masks the two secrets, but the script also prevents database tokens, URLs, database names/IDs, SQL, row values, and raw provider errors from entering its public result.

## Run

1. Announce a short maintenance window. The source is read-only while evidence and the restore are verified.
2. Open **Actions → Turso backup restore rehearsal → Run workflow** on `main`.
3. Enter the exact confirmation `RESTORE_DISPOSABLE_ONLY`.
4. Approve the protected environment deployment.
5. Wait for the job and download only `turso-backup-restore-rehearsal-<run>-<attempt>`.

The workflow fetches `origin/main` after checkout and refuses to continue if `HEAD` is stale. It then:

1. verifies the authoritative source identity and reads its write-block state;
2. blocks and confirms writes, then selects the PITR timestamp;
3. authenticates source evidence for its exact managed or unmanaged migration prefix;
4. creates and identity-checks an isolated PITR restore;
5. authenticates matching pre-migration restore evidence;
6. adopts an unmanaged ledger only on the restore, applies pending migrations only there, and verifies all prior table digests, counts, and sequence state are preserved;
7. restores and confirms the source's original `block_writes` state; and
8. deletes only the exact disposable restore.

## Evidence and failure recovery

The uploaded `rehearsal-summary.json` is an allowlisted, sanitized artifact. A successful result has `preMigrationMatch`, `postMigrationPreserved`, `rpoMet`, and `rtoMet` set to `true`; `sourceWriteStateRestored` and `restoreDeleted` must also be `true`. It contains authenticated digests and counts, never credentials or database identifiers.

If the restore identity is unknown or changes, or the source write state cannot be confirmed, the script refuses name-only cleanup. It writes exact operator recovery details with mode `0600` to `$RUNNER_TEMP/private-recovery/recovery.json`. That directory is intentionally absent from every upload step. Read it only from a live failed runner during incident response; GitHub-hosted runners are destroyed after the job.

On a failed run:

1. Check the sanitized error code and phase in the uploaded summary.
2. If the error is `REHEARSAL_SOURCE_WRITE_STATE_RECOVERY_REQUIRED`, immediately inspect the production database configuration in Turso and restore the recorded pre-run `block_writes` value. Do not assume writes were re-enabled.
3. If the error is `REHEARSAL_RESTORE_CLEANUP_REQUIRED`, identify the generated restore in the Turso dashboard and compare its immutable `DbId` and parent to the private recovery state before deletion. Never delete by name alone.
4. Do not migrate, rename, or delete the production source while investigating.
5. Rotate the Platform API token if exposure is suspected. Do not invalidate database tokens globally; the generated database tokens expire after 30 minutes.

## Promotion gate

A green mocked test suite proves orchestration behavior, not provider access. Remote production migration remains disabled until a real protected run from current `main` produces a successful retained artifact and an operator records its run URL, RPO/RTO result, and source write-state restoration in issue #38. The later remote-migration workflow must independently re-check the immutable production identity and exact schema state.
