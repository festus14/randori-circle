# Member lifecycle and ownership transfer

This increment lets an active member leave a primary circle and lets an active
owner list, deactivate, reactivate, or transfer ownership to a member in that
same circle. The existing invitation screen remains the place where owners
revoke pending invitations.

## Authorization and state transitions

| Action | Actor | Target | Result |
|---|---|---|---|
| List memberships | Active owner | Actor's primary circle | A bounded page of active/inactive memberships, without email addresses, plus an opaque continuation cursor |
| Deactivate | Active owner | Other active member/owner in the same circle | Membership becomes inactive; all target sessions are revoked |
| Reactivate | Active owner | Other inactive member/owner in the same circle | Membership becomes active; no session is issued |
| Leave | Active member/owner | Self | Membership becomes inactive; all own sessions are revoked |
| Transfer ownership | Active owner | Other active member in the same circle | Target becomes owner and actor becomes member atomically |
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

The existing role/status columns, audit table, session revocation fields, and
invitation status model are sufficient. This increment intentionally adds no
migration; migration v9 remains available to its reserved owner.

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
- There is no bulk member administration. Each destructive action has a focused
  confirmation and its own auditable transaction.
