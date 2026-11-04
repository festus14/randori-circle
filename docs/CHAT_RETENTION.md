# Chat retention private-beta runbook

Status: implemented in code, destructive production use disabled

Owner: repository operations

Escalation: database reliability and privacy/legal

Policy: `private-beta-v1`, 90 days

Owner decision (4 November 2026): build the #53 bounded workflow with the
approved 90-day window, replacing #407's blunt purge. Keep purging disabled.
This is app-database chat retention, independent of #450/#457's 24-hour
deletion-ledger retention job. This change reuses the existing v11 (primary)
and secondary retention schema; it introduces no migration.

## User-facing policy

Pair-chat content is retained in the active database for 90 days from its
database-recorded message timestamp. A message is eligible only when its parsed
SQLite `julianday(created_at)` is strictly earlier than the database-derived
cutoff; a message exactly on the cutoff remains. Invalid or future timestamps,
unmapped legacy rooms, and rooms under an active tenant or room hold are
preserved and surfaced only as aggregate anomaly counts. The existing
10,000-message room cap remains in force, including for held content.

The cutoff is midnight UTC 90 days before the database's current date. Rounding
down preserves a partial day's messages conservatively and gives a stable daily
run identity; an 89-day-old row stays, a 91-day-old row is eligible. Worker host
time cannot advance expiry.

This policy covers pair-chat messages only. Workspace snapshots, run history,
email events, provider backups, and private exports keep their separate
lifecycles. Removing a row from the active database does not make it disappear
from an existing provider backup immediately; provider backup expiry is a
separate operational obligation.

## Safety model

Migration v11 adds a scope registry, a generation-fenced singleton control,
room-scoped durable runs, tenant/room holds, count-only audit events, and a
global chronological planner index. It does not enable retention or delete a
row. New managed pairing publications register every room with their resolved
`local` or `circle:<id>` scope in the same transaction as the group write.

Legacy rooms are deliberately unmapped. `adopt_scope` accepts one exact room
only after it proves that the group exists and every participant is an active
member of the supplied, active primary circle. Local adoption additionally
requires explicit local-runtime mode and no active primary circle. An absent,
conflicting, or ambiguous mapping fails closed. Never infer ownership from a
week label, current sender membership, or numeric-ID similarity.

Deletion requires two independent switches:

1. deployment configuration `CHAT_RETENTION_ENABLED=true`; and
2. the v11 database control row set to enabled through a generation-checked
   protected operation.

Every claim records the current control generation. Every heartbeat, batch,
delete, checkpoint, yield, and finalization rechecks it. Disabling or reenabling
increments the generation, so a stale lease cannot survive an off/on cycle.
Disabling can wait for one already-open SQLite write transaction; that one
bounded batch may finish, but no later batch can begin.

Each job owns the exact operator-requested mapped `(scope, week, pair group)`
room and one fixed database-time cutoff; the planner never chooses a different
tenant implicitly. Claims use token-bound database-time leases. Purge batches
reselect at most 100 oldest eligible rows and delete the exact IDs inside the
same write transaction that rechecks the scope, generation, and holds. Each run
also accepts only matching export and backup evidence for a room high-water ID
captured before export begins and proves that exact anchor still belongs to the
room. The run never deletes above that evidence-bound ID, so writes between
evidence completion and enqueue—and all later writes—remain untouched until a
new evidence-gated run. Counts,
checkpoint number, and audit event commit with the deletion. A crash before
commit changes neither rows nor counts; after commit a replacement lease
reselects remaining in-snapshot rows, so it cannot skip or double-count them.
Normal progress does not consume the five-failure retry budget. Transient
failures use bounded backoff; corrupt scope/timestamp/evidence state dead-letters
with a fixed reason code. Replay is explicit, reason-coded, and rechecks every
current safety gate.

The operator CLI also binds the worker's claim to the requested tenant and
session, so an older queued job in another room cannot be processed by that
dispatch. Repeating a completed run with the same evidence is a no-op, and
audit counts remain intact. `status` includes aggregate dead-letter counts by
fixed error code; identifying a run for explicit replay stays a private operator
database operation, never a public artifact.

Dry run is a separate read/update path and never executes message deletion. It
uses the same chronological eligibility, ownership, hold, and fixed-cutoff
conditions, scans at most 100 rows per batch, and records count-only progress.

The explicit `dry-run` workflow operation / `CHAT_RETENTION_ACTION=dry_run`
instead uses a read-only snapshot and works with both retention switches off.
It validates the same room, evidence high-water, cutoff, timestamps, and holds,
then scans at most the existing room cap plus one overflow sentinel. Overflow
fails closed. It returns only eligible/scanned/held/deleted counts, status, and
elapsed milliseconds, with `deleted=0`. It does not enqueue, claim, update
checkpoints, enable control, or alter audit rows. Repeating it reports the same
counts for unchanged data. The older `run` action remains the durable worker
path and requires enabled control even in its `dry_run` mode.

## Backup and export ordering

For every cutoff, the protected operator must complete these steps in order:

1. place any legal or user-export hold before reading chat;
2. record the exact normalized room scope and current maximum message ID, and
   include their documented `randori-chat-retention-evidence:v1` SHA-256 binding
   in the immutable export evidence envelope before reading content;
3. finish the private encrypted export through at least the fixed cutoff;
4. capture and finish a provider recovery point through at least that cutoff,
   binding the same exact room high-water to its evidence envelope;
5. record both opaque SHA-256 evidence digests, both matching scope-binding
   digests and high-water IDs, and canonical through/completion times; and
6. enqueue the dry run or purge only after export completion and then backup
   completion.

Each artifact binding covers its kind, artifact digest, exact normalized room,
source high-water, through time, and completion time. Both bindings are folded
into the durable run key and re-derived from stored run evidence before every
batch. The worker rejects future evidence, mismatched or missing room anchors,
evidence that does not cover the cutoff, and backup completion earlier than
export completion. GitHub artifacts contain
only aggregate counts, timings, booleans, modes, statuses, and reason codes.
Chat content, content hashes, user/circle/week/pair/job identifiers, database
URLs, SQL, raw errors, IP addresses, and user agents are forbidden.

An export hold is an ordinary legal hold with reason `EXPORT_PENDING`. The
export service itself is not implemented in this increment; until a private
export has been completed and its evidence installed, purge must remain
disabled. Backups are recovery media, not user exports.

## Staging rehearsal and production enablement

The checked-in `Chat retention` workflow is manual, latest-default-branch only,
read-only by default, bound to a protected environment, and serialized with the
Turso production database operations group. Configure values in a staging
environment first. Scope and run identifiers are held as protected secrets so
they are not copied into workflow input history.

Before the first destructive production run:

1. Complete #38's real isolated restore rehearsal and #43's protected v11
   status/apply sequence from the same reviewed commit. Do not deploy a newer
   application against an unplanned migration state.
2. Publish the 90-day notice and export grace period. Resolve every unmapped
   legacy room through the protected ambiguity check or leave it preserved.
3. Keep both switches disabled. Run `status`; require zero unexpected schema
   drift, review active tenant/room holds, and investigate every invalid/future
   timestamp anomaly.
4. Create synthetic staging rooms containing boundary, held, unmapped, and
   multi-batch data. Complete a private export, then a provider backup. Run
   `dry-run` with both switches still off and require the reviewed count to match
   an independent read. Verify messages, control, runs, holds, and audit rows
   before/after: the rehearsal must change none of them. Held rooms report zero
   eligible rows; mismatched evidence, unmapped rooms, invalid/future timestamps,
   and room-cap overflow fail closed.
5. Enable the database control with the expected generation, set the deployment
   switch, rerun the staging dry run, then purge only synthetic staging data.
   Verify message counts, unchanged held/unmapped rows, lease/audit state, and
   restore reconciliation.
6. In production, repeat the export-then-backup gate and run count-only dry-run.
   Record the sanitized artifact and obtain the issue owner acknowledgement
   before a separately dispatched bounded purge. Automation/cadence remains off
   until this first evidence is accepted.

Production purge additionally requires these inputs on the protected manual
workflow (configure protected environments named exactly `staging` and
`production`):

| Workflow input | Value |
| --- | --- |
| `environment` | `staging` for synthetic staging runs; `production` for production |
| `staging_rehearsal_sha` | Owner-accepted commit SHA for the completed staging purge/restore rehearsal |
| `production_dry_run_sha` | Owner-accepted commit SHA for the production read-only counts/timings artifact |

The workflow pins checkout to the dispatch-time `github.sha`, verifies that
checkout equals both that SHA and freshly fetched latest `main`, and supplies
the verified checkout SHA as `--release-sha`. It takes `--target-stage` from the
protected environment and `--staging-rehearsal-sha` / `--production-dry-run-sha`
from those inputs.
If `main` advances while protected-environment approval is pending, the run
refuses execution. Obtain accepted evidence for the new release and redispatch.
Both accepted evidence SHAs must match that exact
reviewed release for a production purge; missing, stale, or malformed values
fail before enqueue/claim. A new release requires new accepted evidence. Leave
these acceptance inputs empty until the owner reviews the actual artifacts.
Acceptance does not enable either kill switch. Status and explicit read-only
dry runs do not require acceptance or enabled switches.

For a private operator shell configured with an **isolated synthetic staging**
database and scope/evidence variables, the equivalent inspection command is:

```sh
CHAT_RETENTION_ACTION=dry_run CHAT_RETENTION_ENABLED=false \
  node scripts/chat-retention.mjs
```

Use `--secondary-workspace` for the secondary storage family; primary and
secondary runs/control/holds/audit remain independent. Never copy content,
scope identifiers, evidence envelopes, credentials, or SQL into GitHub artifacts.
After a staging purge, independently reconcile the deleted count with the
durable audit sum, repeat the worker and require zero extra deletes, and restore
the pre-purge recovery point into another isolated database. Verify the original
message count privately, overlay current holds, and follow restore reconciliation
below. Record only counts, timings, statuses, and fixed codes for owner review.

No production rehearsal or purge was dispatched by this implementation change.
The production dry run is an owner-operated gate after staging acceptance.

Required environment configuration is documented in `.env.example`. The
workflow confirmation phrases are intentionally distinct for inspection,
dry-run, enable/disable, holds, adoption, replay, and purge.

## Holds and restore reconciliation

Tenant holds use `(scope_key,0,0)`; room holds use the exact mapped room tuple.
Holds have no automatic expiry. Placement serializes with deletion, clears any
matching lease, and moves queued work to `held`. Release is explicit and only
requeues work when no broader active hold remains. Holds never grant read access.

Before serving a restored database, keep writes and retention disabled, overlay
the current authoritative legal/export holds, inspect scope mappings, and run a
count-only retention reconciliation. A restore may resurrect already expired
messages, so the restored database must not serve traffic until those controls
are reconciled.

## Rollback and incident response

Retention has no data down-migration.

1. Set the deployment switch false and disable the database switch with the
   exact current generation. Database disable atomically releases processing
   leases to `pending` after any already-open bounded write batch commits.
2. Verify no job is `processing`. Inspect only aggregate state and fixed error
   codes.
3. Leave additive v11 tables/indexes and the migration ledger intact while a
   forward fix is prepared. Do not edit a v11 ledger row or delete audit state.
4. If eligible content was deleted incorrectly, block writes, restore the
   reviewed pre-purge recovery point into an isolated database, verify integrity
   and mappings, overlay current holds, rerun retention reconciliation, and only
   then perform an operator-approved cutover.

## Operational blockers

Merging code does not authorize a production deletion. Production remains
blocked until #38 has real-provider restore evidence, #43 can apply and attest
v11 through its protected workflow, a private export path and policy notice are
complete, the staging rehearsal above passes, and the production count-only dry
run is reviewed. No production credentials or database mutation are part of
this implementation change.
