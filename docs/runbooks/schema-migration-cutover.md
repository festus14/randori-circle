# Schema migration cutover

Applying the next schema migration to production. This is the short
version of [TURSO_PRODUCTION_MIGRATION.md](../TURSO_PRODUCTION_MIGRATION.md);
that doc is authoritative if the two disagree. The descriptive layer
is [SYSTEM_DESIGN.md](../SYSTEM_DESIGN.md) §4.3 and §9.2.

## Rules

- Never run `npm run db:migrate` against production. It accepts only
  local `file:` URLs by design. Production changes only through the
  protected **Turso production migration** GitHub workflow.
- One version per approved rehearsal. Never amend, replace, batch, or
  skip a version.
- Every step uses the same latest `main` commit. Any merge to `main`
  or any production mutation invalidates the previous rehearsal and
  fingerprint — the next step needs a fresh rehearsal and a fresh
  status result.
- There are no down migrations. The rollback asset is the verified
  PITR capability, not reverse SQL — see
  [backup restore](backup-restore.md).

## Confirm (read-only)

```bash
# What is pending, from the Diagnostics readiness card or a status run:
# ledger.state, currentVersion, nextVersion / pendingVersion.
```

## Cutover

1. **Rehearse.** Actions → **Turso backup restore rehearsal** → Run
   workflow on `main` → confirmation `RESTORE_DISPOSABLE_ONLY`.
   Wait for success and note the run ID and attempt.
2. **Status** (within 30 minutes). Actions → **Turso production
   migration**: operation `status`, the rehearsal run/attempt from
   step 1, empty state fingerprint, empty target version,
   confirmation `INSPECT_PRODUCTION_DATABASE`. Download
   `migration-result.json` and read `state`, `stateFingerprint`,
   `nextVersion`, and `pendingVersions`. Copy the fingerprint from
   that artifact only — never from logs, an older run, or another
   database. Only `nextVersion` is actionable.
3. **Adopt (unmanaged state only).** Set
   `TURSO_PRODUCTION_MIGRATIONS_ENABLED=true`, dispatch `adopt` with
   the status fingerprint, empty target, the same rehearsal
   run/attempt, confirmation `MIGRATE_PRODUCTION_DATABASE`. Set the
   variable back to `false`. Return to step 1.
4. **Apply one version (managed state with `nextVersion`).** Set the
   variable to `true`, dispatch `apply` with the exact status
   fingerprint, `target_version = nextVersion`, the same rehearsal
   run/attempt, and confirmation `MIGRATE_PRODUCTION_DATABASE`. Set
   it back to `false`. Return to step 1.
5. **Finish.** A fresh rehearsal plus `status` reports the repository
   latest version, `pendingVersions: []`, `nextVersion: null`, and
   `capabilities.apply: false`.

## Additive vs breaking migrations

- **Additive** (declared `compatibility: 'additive'`): merge first.
  Production stays ready on the previous version — `/api/health/ready`
  returns 200 and the Diagnostics readiness card shows *Degraded*
  with "pending additive migration vN". Run the cutover above, then
  turn the feature flag on. The schema capability notices the applied
  migration within 30 seconds.
- **Breaking:** merging takes readiness down until the cutover
  applies it. Apply straight after the merge, away from the Sunday
  08:00 UTC pairing run.

## Failure and recovery

Any nonzero result means stop. Do not rerun a mutation with the same
fingerprint — a commit failure can have an unknown outcome. Perform a
new rehearsal, run a new status, establish the authoritative current
state, and review the result.

If an applied migration causes an incident, keep database
administration exclusive, preserve evidence, and make a deliberate
restore/cutover decision using the
[backup restore](backup-restore.md) procedure. Do not roll the code
back to a version older than the database: code is never ready on a
database newer than itself. Leave the code at its version with the
feature flag off instead.

## Verify

```bash
curl -s -o /dev/null -w '%{http_code}\n' https://randoricircle.com/api/health/ready
# Expect 200.
```

Confirm the Diagnostics readiness card shows `ledger.state: current`
and that the production smoke check is green.
