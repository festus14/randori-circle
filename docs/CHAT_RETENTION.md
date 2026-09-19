# Chat retention private-beta runbook

Status: implemented in code, destructive production use disabled

Owner: repository operations

Escalation: database reliability and privacy/legal

Policy: `private-beta-v1`, 90 days

## User-facing policy

Pair-chat content is retained in the active database for 90 days from its
database-recorded message timestamp. A message is eligible only when its parsed
SQLite `julianday(created_at)` is strictly earlier than the database-derived
cutoff; a message exactly on the cutoff remains. Invalid or future timestamps,
unmapped legacy rooms, and rooms under an active tenant or room hold are
preserved and surfaced only as aggregate anomaly counts. The existing
10,000-message room cap remains in force, including for held content.

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

Each job owns exactly one mapped `(scope, week, pair group)` room and one fixed
database-time cutoff. Claims use token-bound database-time leases. Purge batches
reselect at most 100 oldest eligible rows and delete the exact IDs inside the
same write transaction that rechecks the scope, generation, and holds. Each run
also freezes the room's highest message ID when its backup/export evidence is
accepted; later backfills and writes remain untouched until a new evidence-gated
run. Counts,
checkpoint number, and audit event commit with the deletion. A crash before
commit changes neither rows nor counts; after commit a replacement lease
reselects remaining in-snapshot rows, so it cannot skip or double-count them.
Normal progress does not consume the five-failure retry budget. Transient
failures use bounded backoff; corrupt scope/timestamp/evidence state dead-letters
with a fixed reason code. Replay is explicit, reason-coded, and rechecks every
current safety gate.

Dry run is a separate read/update path and never executes message deletion. It
uses the same chronological eligibility, ownership, hold, and fixed-cutoff
conditions, scans at most 100 rows per batch, and records count-only progress.

## Backup and export ordering

For every cutoff, the protected operator must complete these steps in order:

1. place any legal or user-export hold before reading chat;
2. finish the private encrypted export through at least the fixed cutoff;
3. capture and finish a provider recovery point through at least that cutoff;
4. record both opaque SHA-256 evidence digests and canonical through/completion
   times; and
5. enqueue the dry run or purge only after export completion and then backup
   completion.

The worker rejects future evidence, evidence that does not cover the cutoff,
and backup completion earlier than export completion. GitHub artifacts contain
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
   `dry-run` and require the reviewed count to match an independent read.
5. Enable the database control with the expected generation, set the deployment
   switch, rerun the staging dry run, then purge only synthetic staging data.
   Verify message counts, unchanged held/unmapped rows, lease/audit state, and
   restore reconciliation.
6. In production, repeat the export-then-backup gate and run count-only dry-run.
   Record the sanitized artifact and obtain the issue owner acknowledgement
   before a separately dispatched bounded purge. Automation/cadence remains off
   until this first evidence is accepted.

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
   exact current generation.
2. Wait longer than the 30-second lease duration and verify no job is
   `processing`. Inspect only aggregate state and fixed error codes.
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
