# Member lifecycle, co-owners, and app admins

This increment lets an active member leave a primary circle and lets an active
owner list, deactivate, reactivate, or transfer ownership to a member in that
same circle. Owners can also add and remove co-owners, and app admins can grant
and revoke app admin access (ID-69); see [Co-owners and app
admins](#co-owners-and-app-admins). The existing invitation screen remains the place where owners
revoke pending invitations.

## Authorization and state transitions

| Action | Actor | Target | Result |
|---|---|---|---|
| List memberships | Active owner | Actor's primary circle | A bounded page of active/inactive memberships, without email addresses, plus an opaque continuation cursor |
| Deactivate | Active owner | Other active member/owner in the same circle | Membership becomes inactive; all target sessions are revoked |
| Reactivate | Active owner | Other inactive member/owner in the same circle | Membership becomes active; no session is issued |
| Leave | Active member/owner | Self | Membership becomes inactive; all own sessions are revoked |
| Transfer ownership | Active owner | Other active member in the same circle | Target becomes owner and actor becomes member atomically |
| Make owner | Active owner | Other active member in the same circle | Target becomes an owner; the actor stays an owner |
| Remove owner role | Active owner | Other owner (active or inactive) in the same circle | Target becomes a member; at least one active owner always remains |
| Grant app admin | Active non-demo admin in the primary circle | Active non-demo member of that primary circle | `auth_accounts.is_admin` becomes 1 |
| Revoke app admin | Active non-demo admin in the primary circle | Admin with a membership in that primary circle (self allowed) | `is_admin` becomes 0; at least one other active admin always remains |
| Archive secondary circle | Active owner with recent auth | Exact selected non-primary circle | Circle access ends and every selected session moves to another active circle; retained history is unchanged |
| Revoke invitation | Active owner | Pending invitation in the same circle | Existing invitation endpoint revokes it and records its audit event |

Cross-circle IDs and missing IDs produce the same response. Self-deactivation is
not an owner shortcut: members use the explicit leave flow. An inactive account
must authenticate again after reactivation.

## Integrity and security decisions

- Membership writes, audit evidence, and applicable session revocation use one
  database write transaction. If any step fails, the whole transition rolls
  back.
- A conditional update checks the acting membership, target membership, target
  state, circle state, and last-active-owner invariant in the write statement.
  SQLite/Turso serializes competing writers, so concurrent attempts re-evaluate
  against the committed winner and cannot remove every active owner.
- Ownership transfer first promotes an active member and then demotes the actor
  in the same transaction. A conditional second update verifies that the new
  active owner exists before the old owner can be demoted.
- Deactivation and leave revoke every live session with the existing
  `membership_removed` reason. Requests also resolve active membership from the
  database, so stale signed tokens cannot retain pair-room or API access.
- Role is read from the membership table on every privileged operation; it is
  not trusted from a session claim. Ownership transfer therefore needs no
  session rotation.
- Ownership transfer and deactivation of another owner require a fresh,
  session-scoped password or Google proof inside the lifecycle transaction.
  Routine non-owner membership changes and self-leave remain explicit but do
  not add credential friction. See [recent authentication for sensitive circle
  changes](LIFECYCLE_RECENT_AUTH.md).
- Secondary archive uses the same recent-auth surface but is a circle-level
  soft-archive transaction. It protects every active member's last circle,
  moves all selected contexts to primary-first/lowest-ID fallbacks, and retains
  all membership and coordination rows. See [secondary-circle archive](CIRCLE_ARCHIVE.md).
- Production and local development use the same endpoint and domain rules. The
  membership capability remains fail-closed behind the existing readiness and
  feature checks.
- Owner roster reads use immutable ascending membership user IDs, a first-page
  snapshot ceiling, and an authenticated AES-GCM cursor bound to the actor,
  circle, and normalized search. Role/status changes therefore cannot move a
  row across page boundaries. Each request reads at most 201 indexed
  `(circle_id, user_id)` candidates before joining/filtering accounts and
  returns at most 100 members (50 by default). The first request obtains its
  snapshot ceiling with a reverse primary-key seek; continuations use the
  encrypted ceiling and do not recompute an aggregate. Search compares normalized display names only; the query never
  reads or projects the account email field. A sparse search can return an empty page with a next
  cursor, keeping database work bounded while allowing the owner to continue.
- A roster 401/403 clears every retained row and control based on HTTP status,
  independent of response wording, before re-resolving the actor's circle
  role. This denial takes precedence over a newer successful roster response
  for the same initiating authentication identity; a delayed denial from a
  previous identity is ignored. A transient append failure preserves the
  already loaded rows and makes that continuation retryable. A failed
  replacement load or search leaves an empty error/retry state, rather than
  showing rows that belong to the previous query. A render epoch invalidates a
  delayed initial load and starts a new one, so authentication refreshes cannot
  strand the roster in a busy state.
- Starting an active-circle switch synchronously invalidates the current render
  epoch and hides every lifecycle and owner surface. Every later continuation,
  including the step after an owner-invitation read, must revalidate that epoch,
  active role, actor, and switching state before making private controls visible.
  A delayed member mutation remains a no-op after the switch begins, even when
  another old-circle render is also in flight.
- Identity bootstrap retries stop after the first successful or authoritative
  signed-out response. Transient failures still use the full retry ladder, but
  an already resolved identity does not issue later duplicate role/roster reads
  that can mask a same-actor roster denial. Browser regressions advance a
  virtual clock across that queued retry window, so this ordering is verified
  without wall-clock sleeps.

The existing role/status columns, audit table, session revocation fields, and
invitation status model are sufficient. This increment intentionally adds no
migration; migration v9 remains available to its reserved owner.

## Co-owners and app admins

There is no upper limit on owners per circle or on app admins. Every
owner-only check accepts any active owner, and every admin check accepts any
active non-demo admin; nothing selects "the" owner or "the" admin.

### API contract

All four actions use the existing endpoint and body shape:
`PATCH /api/members` with exactly `{"action":"make_owner"|"remove_owner"|"grant_admin"|"revoke_admin","member_id":<positive integer>}`,
the same-origin check, and (with the multi-circle control plane) the selected
circle context headers.

| Result | Status | Body |
| --- | --- | --- |
| Owner role changed | 200 | `{"ok":true,"action":"make_owner"\|"remove_owner","member":{"id","role","status"}}` |
| Admin changed | 200 | `{"ok":true,"action":"grant_admin"\|"revoke_admin","member":{"id","status","is_admin"}}` |
| No fresh proof | 403 | `{"error":"recent authentication required","code":"recent_auth_required"}` |
| Missing, cross-circle, demo, or non-owner actor (owner actions) | 404 | `{"error":"member not found"}` |
| Actor is not an active admin in the primary circle | 403 | `{"error":"app admin required"}` |
| Replay or state changed (already owner/admin, inactive target) | 409 | `{"error":"membership state changed"}` |
| Own owner role | 409 | `{"error":"ask another owner to change your role"}` |
| Would remove the last active owner | 409 | `{"error":"another active owner is required"}` |
| Would remove the last active admin | 409 | `{"error":"another active admin is required"}` |
| Target is listed in `ADMIN_EMAILS` (sign-in would re-grant) | 409 | `{"error":"admin access is managed by server configuration"}` |
| Circle context changed | 409 | `{"error":"circle context changed","code":"circle_context_changed"}` |

Replays follow the lifecycle convention (reactivating an active member is
also 409): a repeated grant is a 409 `membership state changed` and writes
nothing. The owner roster now includes a boolean `is_admin` per member.

### Integrity

- Each action is one write transaction: actor authorization, the
  session-scoped recent-auth proof (the same ten-minute proof and "Confirm it's
  you" flow as ownership transfer), one conditional `UPDATE`, and one
  `circle_audit_events` row (`ownership.granted`, `ownership.revoked`,
  `admin.granted`, `admin.revoked`; actor and subject IDs only). Any failure
  rolls back the whole change.
- The conditional `UPDATE` re-checks the actor's active owner (or admin)
  status, the target's membership and state, the live circle, and the
  last-owner / last-admin invariant in the same statement. Write transactions
  are serialized, so two owners demoting each other (or a ring of three) can
  never leave zero active owners, and concurrent admin revocations always leave
  at least one active admin.
- An *active admin* is a non-demo account with `is_admin=1` and at least one
  active membership in a live circle; only those count toward the last-admin
  invariant.
- Admin audit rows use `circle_audit_events` with the actor's primary circle.
  `auth_identity_audit_events` was not used because its `event_type` CHECK only
  allows credential events and would need a migration.
- Role and admin status are read from the database on every request; neither
  is cached in the session JWT (decision log: "Put roles in JWTs" rejected).
  Changes take effect on the next request and never revoke sessions.

### What app admin confers

`is_admin=1` (or an `ADMIN_EMAILS` match, which sign-in copies into the flag)
gates exactly these surfaces:

- App logs: `GET /api/data?endpoint=logs` and the admin log panel.
- Diagnostics panels in the Circle and Pairing tabs (`#circleDiagnostics`,
  `#pairDiagnostics`) and the "(admin)" account label.
- Outbox operator replay (`POST /api/admin/outbox/replay`).
- Demo data tools (`demo-seed`, `demo-shuffle`, `demo-reset`) and the legacy
  local circle editing controls.
- Primary-circle data initialization (`POST /api/data?endpoint=init`), which
  also makes every admin an owner of the primary circle when it backfills.
- The legacy email-based grant `POST /api/admin/reshuffle` with `{"action":"promote","email":…}` (see gaps).
- Granting and revoking admin for other members (this increment).
- In the isolated local runtime only, pairing publication and the pairing
  owner view, which use `is_admin` in place of primary-circle ownership.

Admin does not confer circle ownership in production: publishing pairings,
invitations, invite-request review, and member management require an active
owner role. To make someone "an owner and admin like me", apply both Make owner
and Make admin.

### Single-owner assumptions removed

- The browser no longer treats one hard-coded email address as an admin;
  admin UI follows the server's `is_admin` only.
- Invite-request digests go to every active non-demo owner (the previous cap of
  five owners was removed). Inline delivery is still budgeted; the scheduled
  outbox worker sends the rest.
- Migration postconditions no longer require the account that ran the original
  membership backfill to still be an active owner, so demoting or deactivating
  that owner cannot block future migrations. The steady-state readiness
  checks already used the canonical circle creator and an active-owner count.
- Owner-facing copy says "a circle owner" instead of "the circle owner".

## Alternatives considered

| Option | Advantage | Why it was not selected |
|---|---|---|
| Delete memberships | Simple active-member reads | Loses lifecycle history and makes safe reactivation and audit correlation harder |
| Trust a role embedded in the JWT | Avoids a membership lookup | Ownership changes would leave stale privilege until expiry or rotation |
| Check the last owner before the update | Easy application logic | A time-of-check/time-of-use race can let concurrent removals orphan the circle |
| Transfer through two API calls | Reuses role changes | A failure between calls can create ambiguous authority or no owner |
| Issue a fresh session on reactivation | Immediate convenience | Reactivation is not proof that the member still controls an authentication factor |
| Add a new schema version | Could model extra lifecycle metadata | Existing durable state already represents every transition in this slice, while v9 is reserved |
| Offset pagination | Familiar page numbers | Inserts/deactivations can shift offsets, it becomes progressively expensive, and it cannot carry a bounded snapshot |
| Preserve active/owner/name sort | Matches the original small-roster presentation | Status and display-name changes reorder rows between requests, causing duplicates or omissions |
| Query the account email field as well as display name | More ways to find an account | Creates an account-enumeration surface and exceeds the roster privacy requirement |
| Scan until a search page is full | Avoids empty sparse-search pages | A rare or absent term makes a single request unbounded; capped candidate windows give a predictable limit |
| Rely only on response-level context checks | Avoids another UI guard | A render can become stale after its last API check but before its next DOM write; each asynchronous continuation must fail closed immediately before revealing private state |

## Explicit gaps and follow-up

- Invitation email resend/delivery is intentionally excluded because issue #95
  owns that provider/outbox work. Existing invitation revocation is reused here.
- ID-14 supplies the issue #99 recent-auth enforcement for ownership transfer
  and owner deactivation without changing the schema or broadening
  credential-management rollout.
- The UI is deliberately a functional extension of the current Circle card, not
  the broader visual redesign tracked separately.
- Search is intentionally a bounded substring scan over a circle-scoped,
  primary-key range rather than a global directory or email lookup. It is
  optimized for privacy and predictable work, not ranked/fuzzy matching.
  Account recovery and identity changes remain separate security workflows.
- The legacy email-based promote action of `POST /api/admin/reshuffle` remains for operators. It
  sets `is_admin=1` without recent auth or an audit row; prefer the Members
  card. Removing it is a follow-up.
- A co-owner's queued invitation email is suppressed if that co-owner is
  demoted before delivery; another owner can resend it.
- Being made a co-owner counts toward the target's owned-circle creation
  limit, but Make owner does not itself check that limit.
- There is no bulk member administration. Each destructive action has a focused
  confirmation and its own auditable transaction.
