# Selected-circle pairing coordination

This increment makes the current weekly pairing useful in a selected secondary
circle without treating that pairing as a workspace authorization. It is
disabled unless all four rollout flags are true:

- `CIRCLE_MEMBERSHIP_ENABLED=true`
- `MULTI_CIRCLE_CONTROL_PLANE_ENABLED=true`
- `MULTI_CIRCLE_AVAILABILITY_ENABLED=true`
- `SECONDARY_CIRCLE_COORDINATION_ENABLED=true`

## Boundary

Selected primary circles continue through the legacy immutable publication and
workspace path. Selected secondary circles use migration v13's separate,
circle-owned coordination tables. They can publish and display a current-cycle
partner card, but receive no legacy week/group identifiers, room ID, schedule,
chat, video, execution, AI, recap, or notification capability.

`circle_pairing_publications` owns one immutable `(scope_key, cycle_key)` claim.
`circle_pairing_eligibility` records the complete active, non-demo membership
snapshot, including unavailable members and the exact version/source of each
availability decision. `circle_pairing_groups` records only available members.
Every child repeats the scope, circle, and cycle and proves that chain through
restrictive composite foreign keys. No v13 foreign key cascades.

An odd member is recorded as `is_solo=1` with no second member. This is solo
practice, not an AI partner: canonical storage and secondary API responses use
`solo`, never the legacy `is_ai_pair` vocabulary or a fabricated partner.

The deterministic algorithm seed is `<scope_key>:<cycle_key>:weekly`. Fairness
history reads only prior canonical publications in that scope. A secondary
circle never inherits the account-global legacy availability boolean; a first
cycle always uses `cycle_default`.

## Authorization and races

The browser supplies only the active-context generation header. The server
derives the circle from the live hashed session. Every manual publication
attempt opens a fresh write transaction and rechecks the live session, exact
selected membership, context generation, owner role, archive state, database
time/current cycle, full roster, availability, and same-circle history before
claiming the publication. An existing claim is returned unchanged. Vetted
pre-commit database conflicts retry; an ambiguous commit never does.

Reads use a transaction-stable session/context/membership check. Partner names
are joined only through current active membership in that exact circle. If a
partner has left, `/api/my-pair` returns `partner_unavailable` without identity,
and `/api/weeks` omits the unsafe group.

The browser keys pending work by account, opaque circle public ID, and context
version. A switch or sign-out aborts pairing work and clears every legacy room
cache before another circle can render. A secondary response must echo the
expected circle and generation and is rendered through a dedicated read-only
branch that never derives or persists a room.

## Weekly cron

Cron authentication is checked before storage access. The legacy primary is
published as before. With the secondary flag enabled, the server first performs
a deterministic `circle.id` enumeration with a hard private-beta limit of 25.
Overflow is detected before any secondary publication and returns the fixed,
retryable `pairing_batch_overflow` error. Each admitted secondary scope then
publishes in its own transaction. Aggregate telemetry and responses contain
counts only; no circle or member identifier is emitted. Secondary publication
does not enqueue email.

## Rollout and rollback

1. Apply migration v13 with the protected migration workflow only after a fresh
   backup/restore rehearsal proves the new tables are present and old data is
   unchanged.
2. Deploy with `SECONDARY_CIRCLE_COORDINATION_ENABLED=false` and verify the
   existing primary/local journey.
3. Enable the flag in staging for one secondary canary. Test opposite
   availability values, manual publication, selection switching, removal and
   demotion races, and absence of workspace requests/storage.
4. Exercise authenticated weekly cron twice and confirm one immutable result.
5. Enable in the private beta and monitor only attempted/created/existing/failed
   scope counts, context rejects, integrity failures, duration, and overflow.

Rollback is the feature flag. Canonical v13 rows remain intact and hidden. Do
not delete them, disable membership enforcement, or copy secondary rows into
legacy pairing/workspace tables.
