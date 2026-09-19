# Selected-circle pairing coordination

This increment makes the current weekly pairing useful in a selected secondary
circle without treating that pairing as a workspace authorization. Pairing
coordination is disabled unless the first four rollout flags are true; email is
separately default-off and requires all five:

- `CIRCLE_MEMBERSHIP_ENABLED=true`
- `MULTI_CIRCLE_CONTROL_PLANE_ENABLED=true`
- `MULTI_CIRCLE_AVAILABILITY_ENABLED=true`
- `SECONDARY_CIRCLE_COORDINATION_ENABLED=true`
- `SECONDARY_CIRCLE_SCHEDULING_ENABLED=true` (schedule only, after v16)
- `SECONDARY_CIRCLE_PAIRING_EMAIL_ENABLED=true` (email only)

## Boundary

Selected primary circles continue through the legacy immutable publication and
workspace path. Selected secondary circles use migration v13's separate,
circle-owned coordination tables. They can publish and display a current-cycle
partner card without receiving legacy week/group identifiers or a room ID.
After the separate migration-v16 scheduling flag is enabled, a paired group can
agree a time through circle-owned normalized storage; that still creates no
chat, video, execution, AI, recap, or workspace capability. Optional result
email links only to the dashboard and is not a workspace authorization.

The schedule boundary and its separate rollout are specified in
[Secondary-circle scheduling](SECONDARY_SCHEDULING.md). Schedule email/outbox
delivery is not part of v16 and is tracked in issue #149.

`circle_pairing_publications` owns one immutable `(scope_key, cycle_key)` claim.
`circle_pairing_eligibility` records the complete active, non-demo membership
snapshot, including unavailable members and the exact version/source of each
availability decision. Available eligibility rows own one deterministic group
and member slot; unavailable rows own none. `circle_pairing_groups` can
therefore reference only available members assigned to that exact group and
role, preventing duplicate participation at the storage boundary. A composite
descriptor foreign key also binds every publication timestamp and time zone to
its exact availability cycle. Every child repeats the scope, circle, and cycle
and proves that chain through restrictive composite foreign keys. No v13
foreign key cascades.

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
publishes in its own transaction. A failed scope is counted without starving
later scopes in the deterministic batch; after processing the batch, any
failure produces an aggregate retryable `503`. Aggregate telemetry and
responses contain counts only; no circle or member identifier is emitted.
Secondary publication atomically queues v2 email intents only when the separate
email flag and its four dependencies are enabled. Manual and cron publication
use the same claim, so a replay, retry, or race cannot add duplicate intents.

## Secondary result email

Every newly claimed publication queues one `pairing.email.requested` v2 event
for each snapshotted active, non-demo member: `paired`, `solo`, or
`unavailable`. Its exact payload is limited to `publication_id`, `circle_id`,
`user_id`, and `kind`; it stores no address, circle name, token, credential, or
rendered content. The stable provider idempotency key is publication- and
member-scoped.

Dispatch resolves the current recipient address and circle name and validates
the exact publication/scope/circle/cycle descriptor, immutable eligibility and
group slot, active recipient membership, unarchived secondary circle, active
human partner for paired mail, and current email preference. Stale or
inconsistent work is suppressed before provider access. The only URL is the
canonical dashboard origin. Existing primary v1 events retain their embedded
recipient compatibility and private-room rendering. Both versions use the
same event type, retry/dead-letter transitions, provider idempotency, aggregate
metrics, and five-type fair invocation budget. No schema migration is needed.

## Rollout and rollback

1. Use Steps 2–5 of the central protected v13-then-v14-then-v15, credential
   adoption, then v16 sequence in
   [Active circle context](ACTIVE_CIRCLE_CONTEXT.md#rollout) as the sole
   migration and credential-adoption authority. Its fresh rehearsal and
   separately approved one-version applies for v13, v14, and v15 must not be
   repeated from this runbook. After all four credential controls are accepted,
   that authority requires a new rehearsal, status artifact, approval, and
   separate v16 apply. Verify the v13 coordination tables, complete managed
   ledger through v16, four accepted credential controls, and unchanged
   pre-existing application data. This notification increment itself adds no
   migration; v16 belongs to secondary scheduling and current runtime readiness.
2. With that sequence complete, keep
   `SECONDARY_CIRCLE_COORDINATION_ENABLED=false` and verify the existing
   primary/local journey.
3. Enable the flag in staging for one secondary canary. Test opposite
   availability values, manual publication, selection switching, removal and
   demotion races, and absence of workspace requests/storage.
4. Exercise authenticated weekly cron twice and confirm one immutable result.
5. Keep `SECONDARY_CIRCLE_PAIRING_EMAIL_ENABLED=false` until the five-minute
   outbox worker and sender are configured. In a provider canary separate from
   the coordination canary, enable it for one staging circle;
   verify paired, solo, unavailable, preference-off, removed-partner, archive,
   replay, and provider-retry cases and confirm every URL is the dashboard root.
6. Enable in the private beta and monitor only attempted/created/existing/failed
   scope counts, context rejects, integrity failures, duration, and overflow.

Email rollback disables only `SECONDARY_CIRCLE_PAIRING_EMAIL_ENABLED`; queued
v2 work then suppresses without provider access. Coordination rollback disables
its parent flag. Canonical v13 rows and terminal outbox evidence remain intact.
Do not delete them, disable membership enforcement, or copy secondary rows into
legacy pairing/workspace tables.
