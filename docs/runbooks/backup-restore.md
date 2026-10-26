# Backup restore

Restore rehearsal alerts, or a real restore is needed. This is the
short version of
[TURSO_BACKUP_RESTORE_REHEARSAL.md](../TURSO_BACKUP_RESTORE_REHEARSAL.md)
and [BACKUP_WATCHDOG_ACTIVATION.md](../BACKUP_WATCHDOG_ACTIVATION.md);
those docs are authoritative if the two disagree. The descriptive
layer is [SYSTEM_DESIGN.md](../SYSTEM_DESIGN.md) §5.5 and §9.4.

## How backups work

- Turso point-in-time recovery (PITR). The rehearsal restores into a
  **disposable** database every Monday 03:17 UTC, verifies it, and
  deletes it in the same run. Production is never passed to the
  migration runner or the delete operation.
- Recovery targets: RPO 30 minutes, RTO 15 minutes.
- The independent backup watchdog runs hourly at minute 47. Its
  activation epoch is 2026-09-21 03:17 UTC, with an 8-hour scheduling
  grace (a slot is tolerated until 11:17 UTC) and a 12:47 UTC absolute
  deadline. A current-slot run that is missing, failed, or unfinished
  at the deadline alerts the same Monday.
- Disposable databases have zero retention: deletion and provider
  confirmation happen in the same run. **Never delete an unknown
  database by prefix alone.**

## Confirm (read-only)

```bash
gh run list --workflow turso-backup-restore-rehearsal.yml --limit 3
gh run list --workflow turso-backup-restore-watchdog.yml --limit 3
# The watchdog's sanitized artifact names the alert category:
# run_missing, run_failed, run_stuck, cleanup_failure, ...
```

## Fix — rehearsal / watchdog alerts

- **`run_missing` / `run_failed`:** investigate immediately. A
  missed weekly run blocks migration work until a current successful
  drill exists. Re-run the rehearsal manually on `main` with
  confirmation `RESTORE_DISPOSABLE_ONLY`.
- **`run_stuck`:** an unfinished run exceeded the 90-minute stuck
  allowance. Check that run before dismissing the alert — it may
  still succeed, but the alert stands until the deadline logic
  resolves it.
- **`cleanup_failure` / unconfirmed source write-state restoration /
  unknown disposable restore:** page the database-reliability
  escalation immediately. If the error is
  `REHEARSAL_SOURCE_WRITE_STATE_RECOVERY_REQUIRED`, inspect the exact
  configured production database and restore
  `TURSO_PRODUCTION_EXPECTED_BLOCK_WRITES` — do not assume writes
  were re-enabled. If it is `REHEARSAL_RESTORE_CLEANUP_REQUIRED`,
  resolve the deterministic restore name, re-check its current
  `DbId`, parent, and branch timestamp under exclusive operator
  access before any delete. Do not migrate, rename, or delete the
  production source while investigating.
- **Routine failures:** the owner acknowledges within four hours of
  the alert.

## Fix — a real restore (incident)

**Destructive:** a restore discards writes after the recovery point
unless they are re-applied below. Announce an exclusive maintenance
window and prohibit other database create, rename, or delete
operations during it.

1. Stop application writes.
2. Choose a recovery point inside the 30-minute RPO.
3. Restore to an **isolated** database (never over production).
   Rerun the integrity / foreign-key / schema / digest checks on it.
4. **Re-apply account deletions newer than the restore point.**
   A restore brings back personal data deleted after that point, so
   no cutover is complete until those deletions are re-applied and
   verified on the restored database. Export the deletion ledger
   **from the source database** (never the restored one), re-apply
   it against the restored database with the *requested* PITR
   timestamp as the restore point, then verify — exit 0 with
   `missing: 0` is required before cutover. See the rehearsal
   runbook's "Re-applying account deletions after a restore" section
   for the exact `scripts/deletion-ledger.mjs` commands. The ledger
   file holds only opaque account ids and timestamps, lives only on
   the operator's machine, is never committed or uploaded as an
   artifact, and is destroyed once the cutover is verified.
5. Cut over only after ownership and application validation. Retain
   both databases until the rollback is verified. Roll a failed
   cutover back by restoring the previously recorded database
   endpoint and credentials.

If the source database itself is destroyed, the deletion ledger
cannot be built from it — that residual gap is follow-up work in the
ID-89 decision entry, not something to improvise during an incident.

## Verify

The rehearsal's signed success artifact, a `healthy` watchdog
artifact, `/api/health/ready` returning 200, and the Diagnostics
readiness card `healthy`. After a real restore, also re-run the
production smoke check before announcing recovery.
