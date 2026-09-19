# Chat index migration v10

Migration v10 adds two non-unique indexes to `pair_messages`; it changes no rows,
columns, limits, endpoint payloads, or authorization rules.

| Query path | Manifest-owned index | Planner requirement |
| --- | --- | --- |
| Newest bounded room window | `idx_pair_messages_room_cursor (week_id,pair_group_id,id)` | Search the exact week and pair in descending row-ID order |
| Incremental `after_id` read | `idx_pair_messages_room_cursor (week_id,pair_group_id,id)` | Search the exact room with an `id` lower bound |
| 10,000-message room-cap count | `idx_pair_messages_room_cursor (week_id,pair_group_id,id)` | Cover the count without scanning the message table |
| 20-per-minute sender check | `idx_pair_messages_sender_created (sender_id,created_at)` | Cover and restrict the scan to the authenticated sender |

The sender predicate retains `datetime(created_at)` so historical SQLite and
RFC3339 timestamps keep their existing semantics. SQLite can still use the
leading `sender_id` key and cover `created_at`; changing stored timestamp format
or the rate-limit window is outside this migration.

## Forward apply

1. Keep production mutation disabled. Merge and deploy the same commit that will
   generate migration evidence.
2. Complete issue #38's isolated provider restore rehearsal and retain its valid,
   same-commit signed artifact. Issue #38 remains an operational dependency until
   that real provider run succeeds.
3. Through issue #43's protected workflow, run `status`. Require managed v9,
   exact schema, no drift, and only v10 pending. A database older than v9 must be
   advanced in separately reviewed one-version windows.
4. Temporarily enable the protected mutation switch, apply v10 with the exact
   inspected state fingerprint and rehearsal artifact, then disable mutation.
5. Run `status` again. Require managed v10, no pending version, and no drift.
   Exercise newest-window, `after_id`, room-cap, and sender-window reads and
   monitor latency and write errors without logging message content or identity.

Ordinary CI, preview deployments, local defaults, and API requests cannot apply
this migration. Until #38 and #43 are configured and proven in the real provider
environment, the code may merge but production migration remains blocked.

## Compatibility

The v10 indexes are additive. Existing v9 rows and SQL remain valid, the room cap
stays at 10,000, and the API does not require a new client. A v9 database can run
the existing chat behavior before the controlled apply, but it does not have the
v10 performance guarantee. The migration is repeat-safe: once its ledger row and
exact index definitions exist, another apply performs no work. A same-name index
with different keys is drift, not an adoptable substitute.

## Index-only emergency recovery

Use this only when the two new indexes themselves cause an incident and only
while database administration is exclusive. Preserve the migration result and
provider evidence. Do not change `schema_migrations` and do not delete chat rows.

```sql
DROP INDEX IF EXISTS idx_pair_messages_room_cursor;
DROP INDEX IF EXISTS idx_pair_messages_sender_created;
```

This is a temporary schema-degraded state: reads remain data-compatible, but
readiness and migration status must report drift. Restore the exact v10 schema
before returning the database to service:

```sql
CREATE INDEX IF NOT EXISTS idx_pair_messages_room_cursor ON pair_messages(week_id,pair_group_id,id);
CREATE INDEX IF NOT EXISTS idx_pair_messages_sender_created ON pair_messages(sender_id,created_at);
```

Run protected `status` and require managed v10 with no drift. If exact recreation
fails, or if row/schema integrity is in doubt, stop and use issue #38's rehearsed
PITR procedure through the #43 protected operations boundary. Never improvise a
ledger rollback or run these commands from an application request.
