# Turso backup/restore rehearsal runbook

This runbook exercises Turso point-in-time recovery (PITR) without migrating or deleting the production source database. The workflow runs from the latest `main` commit, uses the protected `turso-migration-rehearsal` GitHub environment, and supports both an explicit manual drill and a recurring monitored drill.

## Safety contract

The workflow will stop unless the Platform API returns the configured production database name, immutable `DbId`, group, explicit null parent, and expected `block_writes` value. It writes a private recovery journal before its first mutation, confirms writes are blocked through both database metadata and configuration, and only then selects the PITR timestamp. As soon as the PITR create request returns, it restores and confirms the original source value before waiting for or migrating the restore. Signal handling and a separate `always()` cleanup process retain the same restoration fallback on failure.

PITR always creates a new, disposable database. The workflow requires its new `DbId`, exact generated name and group, and an exact parent `{id, name}` binding to production before connecting. Turso reports `branched_at` as the instant the branch was materialized rather than the requested seed timestamp, so the provider instant must fall inside the write-blocked window: no earlier than the requested recovery instant and no later than five seconds (provider clock-skew allowance) after the create call returned, which is before production writes are unblocked. The attestation records both the requested and authoritative instants. Adoption and migration run only through the disposable restore client. Production is never passed to the migration runner or delete operation.

Turso's documented delete endpoint accepts a database name, not an ID or conditional identity. The script therefore re-fetches and verifies the returned `DbId`, parent, and PITR timestamp immediately before name-based deletion and serializes rehearsals with a unique run/attempt name. This closes accidental-target errors but cannot make the provider operation atomic against an out-of-band delete-and-recreate race. The protected maintenance window must prohibit other database create, rename, and delete operations.

Both connections use short-lived, database-scoped tokens: read-only for the source and full-access for the disposable restore. Tokens expire naturally. Do not add token invalidation: Turso invalidation can rotate a group signing key and disrupt unrelated clients.

Platform requests time out after 15 seconds, individual database operations after 30 seconds, and each forward restore/configuration poll has one shared five-minute deadline across all retries. Evidence collection has its own five-minute bound. The forward command is interrupted at 28 minutes with three minutes reserved for its signal-aware fallback; the separate cleanup step has a two-minute poll budget and a six-minute process bound. Checkout, freshness verification, Node setup, dependency installation, the rehearsal, cleanup, monitor, and three conditional artifact uploads have explicit step caps totaling 81 minutes inside a 90-minute job cap, leaving a nine-minute scheduler margin. Source restoration runs before client close and disposable cleanup.

## One-time GitHub setup

Create an environment named `turso-migration-rehearsal`. Restrict deployment branches to `main` and prevent concurrent runs. The Monday schedule is intended to run unattended, so do not configure a required reviewer on this environment; the exact source identity, disposable-target identity, immutable default-branch checkout, confirmation boundary, write-state recovery journal, and shared production-operation lock remain mandatory safety controls. Store these values in that environment, not as repository-wide credentials. If policy requires approval for every production API call, keep the reviewer gate and treat an unapproved scheduled run as missed evidence that must be escalated before the eight-day cadence expires.

Every workflow that can mutate or temporarily block the production database, including the later issue #43 apply workflow, must use the same `turso-production-database-operations` concurrency group with `cancel-in-progress: false`.

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
| Workflow constant | `REHEARSAL_RPO_TARGET_MS` | Fixed recovery-point objective `1800000` (30 minutes); any other value is rejected |
| Workflow constant | `REHEARSAL_RTO_TARGET_MS` | Fixed restore-time objective `900000` (15 minutes); any other value is rejected |

Accountable owner: `@festus14` (repository owner). Operational owner: the designated database-reliability on-call; that role escalates provider incidents to Turso Support. Subscribe both owners to GitHub Actions failure notifications for this repository, including failures of the separate **Turso backup restore watchdog** workflow, before enabling the environment. The committed drill cadence is every Monday at 03:17 UTC, with an additional manual run after provider, schema, migration, credential-scope, or recovery-policy changes. A successful run must demonstrate a snapshot age no greater than the 30-minute RPO and a restore duration no greater than the 15-minute RTO. A missed weekly run is investigated immediately and blocks migration work until a current successful drill exists.

Use a dedicated Platform API token with only the minimum organization permissions Turso supports. The workflow exposes the Platform token only to the run and cleanup steps and the evidence HMAC key only to the run and monitor steps; checkout, Node setup, and `npm ci` receive neither. External actions are pinned to immutable commits. GitHub masks the two secrets, and the scripts also prevent database tokens, URLs, database names/IDs, SQL, row values, and raw provider errors from entering their public results.

## Run

1. Announce a short exclusive maintenance window. The source is read-only only while source evidence is collected and the PITR create request is accepted; no other operator may create, rename, or delete databases during the run.
2. Open **Actions → Turso backup restore rehearsal → Run workflow** on `main`.
3. Enter the exact confirmation `RESTORE_DISPOSABLE_ONLY`.
4. If organizational policy adds an environment reviewer, approve the protected deployment before the maintenance window expires.
5. Wait for the job. Download `turso-backup-restore-rehearsal-<run>-<attempt>` after a healthy run; for diagnosis also download `turso-backup-restore-cleanup-<run>-<attempt>` when its upload succeeded and `turso-backup-monitor-<run>-<attempt>` when monitor evaluation and upload succeeded.

The workflow fetches `origin/main` after checkout and refuses to continue if `HEAD` is stale. It then:

1. verifies the authoritative source identity and its protected expected write-block state, then atomically journals both;
2. blocks and confirms writes, then selects the PITR timestamp;
3. authenticates source evidence for its exact managed or unmanaged migration prefix;
4. requests an isolated PITR restore, journals its returned ID, and immediately restores source writes;
5. requires the retrieved restore's ID, parent, and group to match the request and the provider `branched_at` to fall inside the write-blocked window;
6. authenticates matching pre-migration restore evidence;
7. adopts an unmanaged ledger only on the restore, applies pending migrations only there, and verifies prior data plus the exact canonical migration-added table state; and
8. re-verifies the disposable identity immediately before its guarded name-based deletion.

The same sequence starts automatically at `17 3 * * 1`. Scheduled runs supply the fixed disposable-only confirmation internally; arbitrary branches and arbitrary confirmation values remain rejected. A scheduled run never applies migrations to production. It applies pending migrations only to the uniquely named restore.

## Monitoring, alerts, and retention

After the unconditional cleanup step, `turso-backup-restore-monitor.mjs` authenticates the signed rehearsal attestation against the exact run, commit, source identity, backup reference, RPO, and RTO. It separately requires the cleanup artifact to prove that the source write state was restored and the disposable database was deleted. The signed attestation is not uploaded unless this monitor is healthy. The monitor emits `backup-monitor-summary.json` with only:

- RPO/RTO targets and observed snapshot/restore durations;
- schema, migration, and restore-comparison checksums;
- aggregate table, row, sequence, and applied-migration counts;
- run/commit identity and cleanup booleans.

Missing evidence, evidence older than the configured success window, invalid signatures or shapes, a failed rehearsal, and incomplete cleanup produce distinct fixed-category alerts. The alert step emits a GitHub Actions error annotation and fails the scheduled workflow, activating normal repository Actions notifications. Neither the annotation nor the retained monitor artifact includes database names or IDs, URLs, tokens, SQL, row values, recipient data, provider errors, or private recovery state.

An independent read-only watchdog runs hourly at minute 47 with its own concurrency group and no Turso or application credentials. Scheduled and manual watchdog runs share the reviewed activation epoch `2026-09-21T03:17:00.000Z`, the first Monday slot after the rehearsal workflow deployment. Before that instant the watchdog emits a sanitized, non-alerting but non-ready `setup_pending` artifact, performs no evidence discovery, and deliberately omits `expectedAt`. At and after activation it fails closed: pre-activation runs cannot count, expected slots cannot predate activation, and a missing qualifying run is `run_missing`. The full bootstrap contract, operator action, and alternatives are recorded in [`BACKUP_WATCHDOG_ACTIVATION.md`](BACKUP_WATCHDOG_ACTIVATION.md).

After the first activated week, the watchdog derives the most recent expected Monday 03:17 UTC slot. Before an eight-hour scheduling grace expires at 11:17 UTC, the preceding post-activation successful slot remains acceptable; afterward, only a run created for the current slot counts. The grace is eight hours because GitHub starts scheduled workflows on a best-effort basis and has started this drill about 5h40m late (#324); the earlier two-hour grace turned that late start into a false `run_missing`. A drill that GitHub starts up to eight hours late and that finishes by 12:47 UTC never alerts. Starts up to 8h29m late (before 11:47 UTC) are tolerated only when the 11:47 watchdog tick runs on time, that is, when no delayed earlier tick or manual dispatch observes the slot between 11:17 UTC and the start. A run that starts after 11:17 UTC has less than the 90-minute stuck allowance before the 12:47 deadline, so it may report `run_stuck` even if it later succeeds; on-call should check that run before dismissing the alert. The eight-day freshness bound still covers the prior run at the end of grace, when it is at most seven days and eight hours old. The watchdog alerts when the current-slot run is still absent at the first tick after grace (11:47 UTC), when the latest current-slot run fails (at the next tick, even inside grace), when a queued/running/waiting run exceeds 90 minutes, or when any current-slot run remains unfinished at the absolute 12:47 UTC watchdog tick. That nine-hour-thirty-minute slot deadline is the grace plus the 90-minute stuck-run allowance. It is derived from 03:17 rather than the run creation time, so even a run first created at the grace edge or immediately before 12:47 cannot defer the alert beyond the final hourly tick before ten hours. A missing, failed, or unfinished drill therefore alerts the same Monday. The assessor refuses any configured grace or deadline longer than 12 hours, so even the loosest accepted setting alerts by the first hourly tick after 15:17 UTC. The watchdog also alerts when the exact run-attempt monitor artifact is missing, expired, stale, malformed, or names a repository commit other than the authoritative workflow run `head_sha`. For a candidate success it downloads that artifact and independently validates its strict PII-free shape, activation/expected/run time ordering, run/attempt/commit binding, cleanup result, checksums, counts, and fixed RPO/RTO measurements. This avoids asking the monitored workflow to attest that its own schedule fired and detects a skipped Monday run on the first hourly check after grace rather than allowing last week's evidence to remain green.

The watchdog uses GitHub's built-in token with read-only `actions` and `contents` permissions. Its fixed-category error annotation names `@festus14`; the owner/on-call notification subscription above is therefore part of the control. Both schedules still share GitHub Actions as a platform, so a repository-wide Actions suspension can silence them together. Move the watchdog to an external monitor that calls the same GitHub API contract when that correlated failure risk exceeds the private-beta tolerance.

The secret-free `check:backup-controls` CI gate statically protects this
operating contract on pull requests into the rolling integration branch and
`main`, and on every other run of the repository deployability workflow. It
requires the exact weekly and hourly cadences, fixed RPO/RTO, default-branch
fences, read-only permissions, protected rehearsal environment, shared
database-operation lock, unconditional cleanup, exact terminal-alert bodies,
immutable action pins, exact provider-identity bindings, and the exact bounded
commands run by every secret-bearing rehearsal, cleanup, and monitor step,
non-persistent checkout credentials, and the allowlisted sanitized
artifact paths. It also rejects provider credentials or a rehearsal-dispatch
path in the watchdog. The validator reads only the three committed workflow
files, emits fixed control names, and neither uses a network nor receives an
environment or secret in CI. Its synthetic tests are a drift alarm, not recovery
evidence: they cannot close #38 or #51 and never authorize #43.
Complete SHA-256 pins for all three workflow files make any unanticipated byte
change fail closed; intentional workflow maintenance updates the workflow,
digest, mutation tests, decision record, and this runbook together.

“Rolling integration branch” currently means the repository branch
`codex/issue-87-repository-deployability`; the workflow and validator name that
actual branch explicitly. The gate is defense in depth rather than an immutable
authorization boundary because a pull request can change the deployability
workflow that invokes it. An administrator-owned required workflow or
equivalent ruleset is separately required before treating the signal as
tamper-resistant; issue #169 tracks that administrator action. This increment
deliberately does not change repository
rulesets or branch protection; until that follow-up lands, reviewers must treat
any deployability-workflow edit as security-sensitive.

If this gate fails, do not bypass it or enable provider operations. Compare the
workflow change with this runbook, restore the reviewed control or deliberately
update code, tests, decision record, and runbook together, then rerun the
secret-free gate. Rollback is a normal code revert; it does not touch a Turso
database, retained evidence, GitHub environment, repository secret, or schedule.
After any intentional provider-workflow policy change, perform a fresh manual
protected rehearsal and retain its redacted result before migration work.

The owner acknowledges routine failures within four hours after the rehearsal or watchdog alert is emitted and pages the database-reliability escalation immediately for `cleanup_failure`, an unconfirmed source write-state restoration, or an unknown disposable restore. Each successfully uploaded sanitized artifact is retained for 30 days. The cleanup summary remains available when its upload succeeds; the monitor summary is available only when monitor evaluation completes and its upload succeeds; the signed attestation is available only after a healthy monitor result. The independent watchdog also retains its sanitized assessment for 30 days. Disposable databases have zero retention: deletion and provider confirmation are required in the same run. Never delete an unknown database by prefix alone.

## Evidence and failure recovery

The success artifact `rehearsal-summary.json` is itself a canonical
`randori.turso-rehearsal-attestation.v2` envelope, rather than an unsigned
projection plus a nested signature. Its domain-separated HMAC payload binds the
repository ID/name, workflow path/ref/SHA, protected environment, run
ID/attempt, checked-out commit, issue/expiry times, local schema manifest and
executable-migration checksums, exact source classification/version/state
fingerprint, final migration state, requested and provider-authoritative PITR
instant, source/restore/backup-reference digests, every evidence/comparison
digest, aggregate table/row/sequence counts, exact RPO/RTO policy and
observations, preservation results, and all safety results. The signing lifetime
is capped at 30 minutes and `validUntil` is the earliest source, pre-migration
restore, or post-migration evidence expiry. Version 1 evidence cannot authorize
the stepwise production migrator.

The workflow uploads that signed success artifact only when both the forward rehearsal and the separate cleanup step succeed. `cleanup-summary.json` is uploaded separately for diagnosis. Both are allowlisted and sanitized; they never contain credentials, raw database names/IDs, URLs, tokens, SQL, row values, raw errors, or the private journal.

The exported `verifyRehearsalAttestation` function is the only supported authorization parser for the later remote-apply workflow. Its caller must fetch the bound run ID and attempt from the GitHub Actions API and require the authoritative run conclusion to be `success`; a user-supplied conclusion or the mere existence of an artifact is not sufficient. The caller must also supply the other trusted GitHub run context, pin the maximum accepted lifetime and exact RPO/RTO targets, and provide the protected source ID and base backup reference so their digests can be recomputed. The verifier recomputes those durable expectations, while the distinct restore identity digest is the signed proof that the rehearsal process observed the exact new provider `DbId` it had already checked against the restored database and its parent. It rejects extra or missing claims, non-canonical values, future/expired or over-policy lifetimes, code-version drift, cross-run/context replay, unsafe outcomes, and a non-matching signature.

Before blocking writes, the run atomically writes mode-`0600` state to `$RUNNER_TEMP/private-recovery/state.json`. It updates the journal after the create attempt, returned ID, source restoration, restore verification, and cleanup. The `always()` step consumes it idempotently, even when the forward process received `SIGINT`/`SIGTERM`. That private directory is intentionally absent from every upload and is not retrievable after a GitHub-hosted runner ends.

Scheduled success evidence proves the recurring recovery control but cannot authorize a production migration: the production migration evidence loader independently requires an authoritative successful `workflow_dispatch` run. Run a fresh manual rehearsal when migration promotion is intended.

Durable recovery does not depend on retrieving that file. The protected environment retains the exact source name, ID, group, and expected write state. The disposable name is deterministically `<configured-prefix>-<github.run_id>-<github.run_attempt>` (the prefix is truncated to the 64-character provider limit), and the run/attempt remain in GitHub. If the runner itself is lost, restore the configured source write state first. Then retrieve that deterministic restore name, record its current ID, and verify its parent against the protected source identity before any manual action. Because Turso offers no conditional ID-based delete, do not delete it while another operator or automation can replace that name.

On a failed run:

1. Check the sanitized cleanup summary and run logs. A failed cleanup deliberately prevents upload of the signed success attestation. If no diagnostic artifact exists because the runner was lost, use the protected variables and deterministic name described above.
2. If the error is `REHEARSAL_SOURCE_WRITE_STATE_RECOVERY_REQUIRED`, immediately inspect the exact configured production database and restore `TURSO_PRODUCTION_EXPECTED_BLOCK_WRITES`. Do not assume writes were re-enabled.
3. If the error is `REHEARSAL_RESTORE_CLEANUP_REQUIRED`, resolve the deterministic restore name, record and re-check its current `DbId`, parent ID/name, and branch timestamp under exclusive operator access before using Turso's name-based delete endpoint. Never delete an unknown or mismatched identity.
4. Do not migrate, rename, or delete the production source while investigating.
5. Rotate the Platform API token if exposure is suspected. Do not invalidate database tokens globally; the generated database tokens expire after 30 minutes.
6. Re-run only after the cleanup summary proves the original source write state and disposable-target state. A failed or stale monitor summary cannot authorize production migration.

If restoration is needed during an incident, stop application writes, choose a recovery point inside the 30-minute RPO, restore to an isolated database, rerun the same integrity/foreign-key/schema/digest checks, re-apply account deletions newer than the recovery point (next section) before cutover, and cut over only after ownership and application validation. Roll back a failed cutover by restoring the previously recorded database endpoint and credentials; retain both databases until the rollback is verified. The scheduled rehearsal never performs that cutover.

## Re-applying account deletions after a restore (issue #366, ID-89)

A point-in-time restore to T brings back the database as of T — including
personal data deleted after T. No cutover is complete until every deletion
newer than the restore point has been re-applied to the restored database
and verified there. The weekly rehearsal never does this against
production: it deletes no real account. Re-application is covered by unit
tests on real migrated SQLite
(`tests/unit/account-deletion-restore-reapplication.test.mjs`, which
simulates the restore with a pre-deletion database,
`tests/unit/deletion-ledger-cli.test.mjs` for the operator CLI, and
`tests/unit/deletion-ledger-destroyed-source.test.mjs`, which deletes
the source database and re-applies from the ledger database), and the
operator performs it manually at restore time with the procedure below.

### The deletion ledger

One entry per tombstoned account, and nothing else:

```json
{"version":1,"exported_at":"2026-10-25T10:05:00.000Z","entries":[
  {"account_id":42,"deleted_at":"2026-10-25T09:31:12.417Z","created_at":"2026-01-15T08:00:00.000Z"}
]}
```

- `deleted_at` is the earliest `account.deleted` audit event for the
  account. It is `null` when no audit row exists; a null entry is always
  treated as due, and re-application is a no-op for an account that is
  already tombstoned, so the fail-safe direction is to re-apply.
- `created_at` distinguishes the two ways an account can be absent from the
  restored database: created after the restore point (correctly absent,
  nothing to re-apply) versus created before it (inconsistent — fail
  closed, do not cut over).
- The ledger is obtained in one of two ways. **Source survives:** it
  is built from the still-live **source** database — PITR creates a new
  database and never deletes the source — and the ledger file lives only
  on the operator's machine, outside any database: never commit it,
  never upload it as a GitHub artifact, and destroy it once the cutover
  is verified. **Source destroyed:** it comes from the **durable
  ledger database** (issue #383, owner decision 2026-10-27), a separate
  Turso database that every deletion execution writes to at deletion
  time, so it survives the source database itself being destroyed. A
  ledger table inside the app database would roll back with the restore
  it is meant to repair. The ledger holds only opaque account ids and
  timestamps, but a ledger file is still deleted after use.
- The durable ledger database has its own schema (one table, the
  minimal entry shape; `scripts/deletion-ledger.mjs init` creates it,
  once per ledger database) and its own credentials
  (`DELETION_LEDGER_DATABASE_URL`, `DELETION_LEDGER_AUTH_TOKEN`; see
  [ENVIRONMENT.md](ENVIRONMENT.md)). No app-DB migration is involved.
  Production wiring is owner-only: the second production Turso
  database is provisioned in #440 and the credentials wired in #444;
  until then the writer is inactive in production and the
  destroyed-source branch below is not yet available for a real
  production restore.
- Retention: entries deleted before (now − the provider backup
  window) are purged (`purge --before <cutoff>`); entries with an
  unknown deletion time are never purged by time. `destroy` deletes
  every entry, for a verified cutover past the backup window or for
  retiring the ledger database.

### Procedure

0. **Decide which ledger source to use.** If the source database
   survives, follow step 1 (export from the source). If the source
   database itself is destroyed, skip step 1: there is no source to
   export from. Read the ledger directly from the durable ledger
   database with `--from ledger-db` in steps 2–3 below (no ledger
   file involved), and use `export --from ledger-db` only if you
   need a file copy for the record.
1. **Export, from the source database**, before cutover (never against the
   restored database, which has no post-restore-point deletions to list):
   ```bash
   TURSO_DATABASE_URL=<source url> TURSO_AUTH_TOKEN=<source token> JWT_SECRET=<server secret> \
     node scripts/deletion-ledger.mjs export --out /operator/path/deletion-ledger-<restore-point>.json \
       [--restore-point <requested-PITR-instant-ISO>]
   ```
   The file is written mode `0600`, created exclusively: the CLI refuses
   to overwrite an existing file or follow a symlink. `--out` must point
   outside the repository (the CLI rejects in-repository paths, and
   `deletion-ledger*.json` is gitignored as a second line of defence).
   The CLI prints counts only, never account ids.
   `--restore-point` on export is minimisation only: it shrinks what is
   written to the file, keeping null-`deleted_at` entries. It is not a
   substitute for reapply-time filtering — `reapply` and `verify` still
   filter by their own `--restore-point`, which is the gate that decides
   what is re-applied.
2. **Re-apply, against the restored database** (never the source), with
   the **requested** PITR timestamp as the restore point — not the
   provider's `branched_at`, which can fall slightly later. Using the
   requested instant can only cause a redundant no-op re-application for a
   deletion that landed between the two instants; it can never skip one.
   `JWT_SECRET` must be the secret in effect when the deletions were made,
   not a rotated replacement: re-application re-hashes invitation emails
   exactly as the deletion did, so a different secret produces different
   hashes and the scrub will not match the original deletion's hashes.
   The CLI validates `JWT_SECRET` presence up front (typed config error)
   for `export` from the source and `reapply`; `verify` and
   `export --from ledger-db` need no secret.
   ```bash
   TURSO_DATABASE_URL=<restored url> TURSO_AUTH_TOKEN=<restored token> JWT_SECRET=<server secret> \
     node scripts/deletion-ledger.mjs reapply --ledger /operator/path/deletion-ledger-<restore-point>.json \
       --restore-point <requested-PITR-instant-ISO>
   ```
   Destroyed source (step 0): read the ledger from the durable
   ledger database instead of a file — same target, same restore
   point, no `--ledger`:
   ```bash
   TURSO_DATABASE_URL=<restored url> TURSO_AUTH_TOKEN=<restored token> JWT_SECRET=<server secret> \
     DELETION_LEDGER_DATABASE_URL=<ledger url> DELETION_LEDGER_AUTH_TOKEN=<ledger token> \
     node scripts/deletion-ledger.mjs reapply --from ledger-db \
       --restore-point <requested-PITR-instant-ISO>
   ```
   Re-application runs the same scrubbing statements as a self-service
   deletion, keeping the original deletion time as the audit instant, and
   deliberately skips the recent-auth proof and the last-owner/last-admin
   gates: the original deletion already passed them in the real timeline,
   and the restored database holds stale, pre-restore membership and
   ownership state (see `api/_account-deletion.js`). It stops on the
   first entry it cannot re-apply — fail closed, do not cut over.
   Re-running it is a no-op for entries already tombstoned.
3. **Verify, against the restored database**, before cutover:
   ```bash
   TURSO_DATABASE_URL=<restored url> TURSO_AUTH_TOKEN=<restored token> \
     node scripts/deletion-ledger.mjs verify --ledger /operator/path/deletion-ledger-<restore-point>.json \
       --restore-point <requested-PITR-instant-ISO>
   ```
   Destroyed source: the same check against the ledger database:
   ```bash
   TURSO_DATABASE_URL=<restored url> TURSO_AUTH_TOKEN=<restored token> \
     DELETION_LEDGER_DATABASE_URL=<ledger url> DELETION_LEDGER_AUTH_TOKEN=<ledger token> \
     node scripts/deletion-ledger.mjs verify --from ledger-db \
       --restore-point <requested-PITR-instant-ISO>
   ```
   Exit 0 with `missing: 0` is required. Any missing id blocks the
   cutover: investigate, re-run `reapply` for that entry, and do not cut
   over with a missing id. An empty ledger verifies trivially — still run
   it, so the check is on the record rather than assumed.
4. **Cut over** only after verification passes, then **destroy the
   ledger file** once the cutover is verified. If the cutover is rolled
   back to the pre-restore database, the ledger is moot (that database
   already contains the deletions); destroy the file either way.
   Do **not** destroy the ledger database's entries at cutover: they
   stay until the purge in step 5, so a second restore to an earlier
   point can still re-apply them.
5. **Retention / destruction of the durable ledger.** Once the cutover
   is verified and the provider backup window has passed, purge the
   entries that can no longer be needed:
   ```bash
   DELETION_LEDGER_DATABASE_URL=<ledger url> DELETION_LEDGER_AUTH_TOKEN=<ledger token> \
     node scripts/deletion-ledger.mjs purge --before <now-minus-backup-window-ISO>
   ```
   On the current plan the window is 1 day, so `--before` is (now −
   1 day). Only after the verified cutover and the purge, when the
   ledger database itself is being retired, run
   `destroy --confirm DESTROY_DELETION_LEDGER` to delete every
   remaining entry.

## Promotion gate

A green mocked test suite proves orchestration behavior, not provider access. Remote production migration remains disabled until a real protected run from current `main` produces a successful retained attestation. Record its run URL, RPO/RTO result, source write-state restoration, and successful final workflow conclusion in issue #38. The later remote-migration workflow must independently re-check the immutable production identity and exact schema state.
