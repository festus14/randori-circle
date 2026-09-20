# Secondary-circle archive

This increment lets an active owner retire a selected secondary circle without
deleting its history or accidentally moving the operation to a fallback circle.
It is enabled by the existing `CIRCLE_MEMBERSHIP_ENABLED=true` plus
`MULTI_CIRCLE_CONTROL_PLANE_ENABLED=true` chain and adds no feature flag or
schema migration.

## Public contract

`DELETE /api/circles` is authenticated and same-origin, accepts no query
parameters, and accepts exactly:

```json
{"circle_public_id":"circle_opaque","expected_context_version":4}
```

The public ID identifies the intended target across a retry; it is not an
authorization grant. The `X-Randori-Circle-Context-Version` header must equal
the body version. On a first attempt, the exact live session must currently
select that active circle at that version. Missing, foreign, and non-owner
targets share the same unavailable response.

Archive always requires a password or Google recent-auth proof no older than
ten minutes. The proof, session, selected context, active owner role, non-primary
state, and last-circle invariant are all checked inside the write transaction.

## Atomic archive and fallback

The archive transaction conditionally sets `circles.archived_at` only when no
active member of the target would be left without another active membership in
an unarchived circle. This protects the actor and every other affected member,
not just the last owner. The primary circle can never be archived.

Every stored session context that selects the target is moved in the same
transaction to that account's deterministic fallback: the active primary
circle first, otherwise the lowest internal circle ID. Each moved context
increments its version. Any anomalous inactive-user context with no valid
fallback is deleted, so an archived circle never remains selected. The browser
invalidates its private-state epoch, broadcasts a forced context refresh, and
reloads only after the server returns the new active circle and generation.
If the archive commits but that response projection cannot be read or no longer
contains a non-target active circle at an advanced generation, the API returns
the distinct `circle_archive_refresh_required` outcome with the archived target
and committed generation. The browser treats only that bound outcome as
committed, clears private state, broadcasts the generation, and reloads to
recover the fallback instead of leaving the retired workspace open.

One `circle.archived` audit uses the deterministic `circle-archived:<circle-id>`
dedupe key. An identical retry by any active retained owner still requires a
live session, recent auth, and an intact audit. This lets different owners'
concurrent attempts converge after the winning transaction has already moved
both selected sessions. The retry returns that caller's current fallback
without another audit or version bump.
Known lock conflicts retry only before commit begins. An ambiguous commit is
reported as unknown and the same target/version request is safe to retry.

## Retained data and access boundary

Archive is a soft authorization boundary, not deletion. Memberships,
invitations, creation receipts, availability decisions, immutable pairing
publications and eligibility, pairing groups, schedules and proposals, outbox
events, and prior audit rows remain byte-for-byte unchanged. Existing scoped
APIs and delivery preflights require `archived_at IS NULL`, so normal reads,
writes, invitations, pairing/schedule delivery, and workspace access stop after
the archive commit. Work that has already passed its final provider preflight
may still complete; archive does not cancel or rewrite delivery history.

There is no public unarchive endpoint. Clearing `archived_at` would reactivate
retained memberships and possibly pending state, so recovery requires a
separately reviewed operator procedure and fresh authorization analysis.

## Rollout and recovery

1. Use the central active-circle runbook to reach exact managed readiness
   through v16. This increment itself applies no migration.
2. Keep `MULTI_CIRCLE_CONTROL_PLANE_ENABLED=false` while deploying, then verify
   ordinary primary-circle behavior and the archive route's fail-closed state.
3. Enable the control plane in staging. Exercise owner/non-owner, recent-auth,
   primary and every-member last-circle guards, duplicate/concurrent requests,
   deterministic fallback across sessions, stale tabs, and unchanged retained
   coordination/schedule rows.
4. Canary with a disposable secondary circle and monitor aggregate outcomes
   only. Do not log names, public IDs, session hashes, or membership identities.

Rollback disables `MULTI_CIRCLE_CONTROL_PLANE_ENABLED`. Preserve archived
circles, contexts, memberships, audit evidence, and all historical records;
do not clear `archived_at`, delete tenant data, or downgrade the schema.

## Alternatives considered

- Archiving whichever circle is active was rejected because an HTTP retry after
  fallback could archive the fallback circle.
- Deleting the circle or memberships was rejected because it destroys audit and
  immutable coordination history and conflicts with restrictive foreign keys.
- Merely bumping selected contexts was rejected because it leaves archived
  circle IDs as tombstones and forces unnecessary selection errors.
- Revoking every affected account session was rejected because every active
  member is required to have a safe fallback and can continue in that circle.
- A new receipt table or feature flag was rejected because archive is a
  once-per-circle transition with an existing unique audit key and is already
  dark-launched by the complete multi-circle control-plane gate.
