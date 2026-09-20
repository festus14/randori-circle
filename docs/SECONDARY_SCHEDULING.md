# Secondary-circle scheduling runbook

This increment lets the two active members of a selected secondary-circle
pairing propose, remove, accept, and clear a session time. It does not create a
legacy room or enable chat, video, execution, AI, or recap. Schedule email is a
separately gated delivery increment.

## Feature chain

`SECONDARY_CIRCLE_SCHEDULING_ENABLED=true` is effective only when all preceding
gates are also true:

1. `CIRCLE_MEMBERSHIP_ENABLED`
2. `MULTI_CIRCLE_CONTROL_PLANE_ENABLED`
3. `MULTI_CIRCLE_AVAILABILITY_ENABLED`
4. `SECONDARY_CIRCLE_COORDINATION_ENABLED`
5. `SECONDARY_CIRCLE_SCHEDULING_ENABLED`

The flag is false by default. Pairing-result email remains independently gated.
`SECONDARY_CIRCLE_SCHEDULE_EMAIL_ENABLED` is also false by default and is
effective only through this complete chain. See
`SECONDARY_SCHEDULE_NOTIFICATIONS.md`.

## Storage and authorization

Migration v16 adds two tables and two named indexes, taking the managed schema
to **52 application tables and 56 named indexes**:

- `circle_pair_schedules`: one revisioned schedule per exact paired v13 group;
- `circle_pair_schedule_proposals`: normalized unique instants and opaque
  proposal keys owned by that schedule;
- `uq_circle_pairing_groups_schedule_owner`: the exact immutable group tuple
  referenced by both tables;
- `idx_circle_pair_schedule_proposals_schedule`: bounded proposal ordering.

Every foreign key uses `ON DELETE RESTRICT`. No schedule table cascades and no
legacy workspace table is written.

Secondary `GET /api/schedule` has no scope query. Secondary POST bodies contain
only `action`, `base_version`, and the action's `instant` or `proposal_id`.
Circle, publication, group, pair, and room IDs are rejected. The server derives
the current scope from the live session-selected circle. Each transaction
rechecks session revocation/expiry, context generation, caller membership,
circle archive state, current immutable publication/group, and current partner
membership before reading or writing.

Concurrent writers use a bounded three-attempt retry only for vetted SQLite
busy/lock failures before commit starts. Every attempt repeats all authority and
scope checks. A stale content version returns the latest safe state with HTTP
409; a failure after commit starts is treated as ambiguous and is never replayed.

The 64-hex `schedule_id` is stable and opaque but never authorizes a request.
Calendar export uses it only as a stable UID and links back to
`/?view=dashboard`.

## Protected rollout

1. Keep `SECONDARY_CIRCLE_SCHEDULING_ENABLED=false`.
2. From the exact release commit, run the protected backup/restore rehearsal
   against current production v15. Verify source and restore evidence and the
   unchanged-data comparison.
3. Produce a fresh status artifact and explicitly approve only target v16.
   Apply v16 through the one-version workflow. Do not reuse a v15 attestation or
   approve later migrations in the same step.
4. Verify the ledger has exactly 16 immutable rows, migration v16's checksum is
   pinned, readiness sees 52 tables/56 named indexes, both schedule tables are
   empty, and pre-v16 table counts/digests and SQLite sequences are unchanged.
5. Deploy the v16-aware application with the schedule flag still false. Verify
   primary scheduling remains unchanged and secondary scheduling is absent.
6. Enable the complete chain in staging. Canary both members: propose, stale
   CAS conflict, accept, remove, clear, same-cycle two-circle isolation, circle
   switch, member departure, circle archive, mobile keyboard access, and stable
   calendar UID/dashboard URL. With schedule email off, confirm no row appears
   in `pair_schedules`, workspace tables, or `outbox_events`.
7. Enable one production canary circle, observe generic API failure rates and
   database readiness, then expand gradually. No provider credential is needed.
8. Separately rehearse the v2 notification and five-type outbox contract, then
   canary `SECONDARY_CIRCLE_SCHEDULE_EMAIL_ENABLED` as described in the
   notification runbook.

## Rollback

Disable `SECONDARY_CIRCLE_SCHEDULING_ENABLED`. The dependent predicate closes
the route and UI while primary scheduling continues on its existing path.
Preserve migration v16, schedule/proposal rows, and ledger evidence. Do not
downgrade the schema or delete tenant data. Re-enablement resumes the same
opaque identities and revisions. Calendar files already downloaded cannot be
revoked by Randori.
