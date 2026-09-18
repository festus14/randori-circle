# Turso backup/restore rehearsal runbook

This runbook exercises Turso point-in-time recovery (PITR) without migrating or deleting the production source database. The workflow is manual-only, runs from the latest `main` commit, and uses the protected `turso-migration-rehearsal` GitHub environment.

## Safety contract

The workflow will stop unless the Platform API returns the configured production database name, immutable `DbId`, group, explicit null parent, and expected `block_writes` value. It writes a private recovery journal before its first mutation, confirms writes are blocked through both database metadata and configuration, and only then selects the PITR timestamp. As soon as the PITR create request returns, it restores and confirms the original source value before waiting for or migrating the restore. Signal handling and a separate `always()` cleanup process retain the same restoration fallback on failure.

PITR always creates a new, disposable database. The workflow requires its new `DbId`, exact generated name and group, and an exact parent `{id, name, branched_at}` binding to production and the requested recovery instant before connecting. Adoption and migration run only through the disposable restore client. Production is never passed to the migration runner or delete operation.

Turso's documented delete endpoint accepts a database name, not an ID or conditional identity. The script therefore re-fetches and verifies the returned `DbId`, parent, and PITR timestamp immediately before name-based deletion and serializes rehearsals with a unique run/attempt name. This closes accidental-target errors but cannot make the provider operation atomic against an out-of-band delete-and-recreate race. The protected maintenance window must prohibit other database create, rename, and delete operations.

Both connections use short-lived, database-scoped tokens: read-only for the source and full-access for the disposable restore. Tokens expire naturally. Do not add token invalidation: Turso invalidation can rotate a group signing key and disrupt unrelated clients.

Platform requests time out after 15 seconds, individual database operations after 30 seconds, and each forward restore/configuration poll has one shared five-minute deadline across all retries. Evidence collection has its own five-minute bound. The forward command is interrupted at 28 minutes with three minutes reserved for its signal-aware fallback; the separate cleanup step has a two-minute poll budget and a six-minute process bound. Checkout, freshness verification, Node setup, dependency installation, the rehearsal, cleanup, and both conditional artifact uploads have explicit step caps totaling 74 minutes inside an 80-minute job cap, leaving a six-minute scheduler margin. Source restoration runs before client close and disposable cleanup.

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
| Variable | `TURSO_PRODUCTION_EXPECTED_BLOCK_WRITES` | Durable expected pre-run state, exactly `true` or `false` |
| Variable | `TURSO_RESTORE_DATABASE_PREFIX` | Disposable lowercase prefix, for example `randori-rehearsal` |
| Variable | `REHEARSAL_MAX_SNAPSHOT_AGE_MS` | Maximum PITR snapshot age, recommended `1800000` |
| Variable | `REHEARSAL_MAX_EVIDENCE_AGE_MS` | Evidence validity window, recommended `1800000` |
| Variable | `REHEARSAL_RPO_TARGET_MS` | Required recovery-point objective, recommended `1800000` |
| Variable | `REHEARSAL_RTO_TARGET_MS` | Required restore-time objective, recommended `900000` |

Use a dedicated Platform API token with only the minimum organization permissions Turso supports. The workflow exposes the secrets only to the run and cleanup steps; checkout, Node setup, and `npm ci` receive none. External actions are pinned to immutable commits. GitHub masks the two secrets, and the script also prevents database tokens, URLs, database names/IDs, SQL, row values, and raw provider errors from entering its public result.

## Run

1. Announce a short exclusive maintenance window. The source is read-only only while source evidence is collected and the PITR create request is accepted; no other operator may create, rename, or delete databases during the run.
2. Open **Actions → Turso backup restore rehearsal → Run workflow** on `main`.
3. Enter the exact confirmation `RESTORE_DISPOSABLE_ONLY`.
4. Approve the protected environment deployment.
5. Wait for the job and download only `turso-backup-restore-rehearsal-<run>-<attempt>`.

The workflow fetches `origin/main` after checkout and refuses to continue if `HEAD` is stale. It then:

1. verifies the authoritative source identity and its protected expected write-block state, then atomically journals both;
2. blocks and confirms writes, then selects the PITR timestamp;
3. authenticates source evidence for its exact managed or unmanaged migration prefix;
4. requests an isolated PITR restore, journals its returned ID, and immediately restores source writes;
5. requires the retrieved restore's ID, parent, group, and provider `branched_at` to match the request;
6. authenticates matching pre-migration restore evidence;
7. adopts an unmanaged ledger only on the restore, applies pending migrations only there, and verifies prior data plus the exact canonical migration-added table state; and
8. re-verifies the disposable identity immediately before its guarded name-based deletion.

## Evidence and failure recovery

The success artifact `rehearsal-summary.json` is itself a canonical `randori.turso-rehearsal-attestation.v1` envelope, rather than an unsigned projection plus a nested signature. Its domain-separated HMAC payload binds the repository ID/name, workflow path/ref/SHA, protected environment, run ID/attempt, checked-out commit, issue/expiry times, local schema manifest and executable-migration checksums, source/final migration state, requested and provider-authoritative PITR instant, source/restore/backup-reference digests, every evidence/comparison digest, exact RPO/RTO policy and observations, preservation results, and all safety results. The signing lifetime is capped at 30 minutes and `validUntil` is the earliest source, pre-migration restore, or post-migration evidence expiry.

The workflow uploads that signed success artifact only when both the forward rehearsal and the separate cleanup step succeed. `cleanup-summary.json` is uploaded separately for diagnosis. Both are allowlisted and sanitized; they never contain credentials, raw database names/IDs, URLs, tokens, SQL, row values, raw errors, or the private journal.

The exported `verifyRehearsalAttestation` function is the only supported authorization parser for the later remote-apply workflow. Its caller must fetch the bound run ID and attempt from the GitHub Actions API and require the authoritative run conclusion to be `success`; a user-supplied conclusion or the mere existence of an artifact is not sufficient. The caller must also supply the other trusted GitHub run context, pin the maximum accepted lifetime and exact RPO/RTO targets, and provide the protected source ID and base backup reference so their digests can be recomputed. The verifier recomputes those durable expectations, while the distinct restore identity digest is the signed proof that the rehearsal process observed the exact new provider `DbId` it had already checked against the restored database and its parent. It rejects extra or missing claims, non-canonical values, future/expired or over-policy lifetimes, code-version drift, cross-run/context replay, unsafe outcomes, and a non-matching signature.

Before blocking writes, the run atomically writes mode-`0600` state to `$RUNNER_TEMP/private-recovery/state.json`. It updates the journal after the create attempt, returned ID, source restoration, restore verification, and cleanup. The `always()` step consumes it idempotently, even when the forward process received `SIGINT`/`SIGTERM`. That private directory is intentionally absent from every upload and is not retrievable after a GitHub-hosted runner ends.

Durable recovery does not depend on retrieving that file. The protected environment retains the exact source name, ID, group, and expected write state. The disposable name is deterministically `<configured-prefix>-<github.run_id>-<github.run_attempt>` (the prefix is truncated to the 64-character provider limit), and the run/attempt remain in GitHub. If the runner itself is lost, restore the configured source write state first. Then retrieve that deterministic restore name, record its current ID, and verify its parent against the protected source identity before any manual action. Because Turso offers no conditional ID-based delete, do not delete it while another operator or automation can replace that name.

On a failed run:

1. Check the sanitized cleanup summary and run logs. A failed cleanup deliberately prevents upload of the signed success attestation. If no diagnostic artifact exists because the runner was lost, use the protected variables and deterministic name described above.
2. If the error is `REHEARSAL_SOURCE_WRITE_STATE_RECOVERY_REQUIRED`, immediately inspect the exact configured production database and restore `TURSO_PRODUCTION_EXPECTED_BLOCK_WRITES`. Do not assume writes were re-enabled.
3. If the error is `REHEARSAL_RESTORE_CLEANUP_REQUIRED`, resolve the deterministic restore name, record and re-check its current `DbId`, parent ID/name, and branch timestamp under exclusive operator access before using Turso's name-based delete endpoint. Never delete an unknown or mismatched identity.
4. Do not migrate, rename, or delete the production source while investigating.
5. Rotate the Platform API token if exposure is suspected. Do not invalidate database tokens globally; the generated database tokens expire after 30 minutes.

## Promotion gate

A green mocked test suite proves orchestration behavior, not provider access. Remote production migration remains disabled until a real protected run from current `main` produces a successful retained attestation. Record its run URL, RPO/RTO result, source write-state restoration, and successful final workflow conclusion in issue #38. The later remote-migration workflow must independently re-check the immutable production identity and exact schema state.
