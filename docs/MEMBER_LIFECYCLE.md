# Member lifecycle and ownership transfer

This increment lets an active member leave a primary circle and lets an active
owner list, deactivate, reactivate, or transfer ownership to a member in that
same circle. The existing invitation screen remains the place where owners
revoke pending invitations.

## Authorization and state transitions

| Action | Actor | Target | Result |
|---|---|---|---|
| List memberships | Active owner | Actor's primary circle | Up to 500 active/inactive memberships, without email addresses, plus an explicit truncation signal |
| Deactivate | Active owner | Other active member/owner in the same circle | Membership becomes inactive; all target sessions are revoked |
| Reactivate | Active owner | Other inactive member/owner in the same circle | Membership becomes active; no session is issued |
| Leave | Active member/owner | Self | Membership becomes inactive; all own sessions are revoked |
| Transfer ownership | Active owner | Other active member in the same circle | Target becomes owner and actor becomes member atomically |
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
- Production and local development use the same endpoint and domain rules. The
  membership capability remains fail-closed behind the existing readiness and
  feature checks.

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

## Explicit gaps and follow-up

- Invitation email resend/delivery is intentionally excluded because issue #95
  owns that provider/outbox work. Existing invitation revocation is reused here.
- ID-14 supplies the issue #99 recent-auth enforcement for ownership transfer
  and owner deactivation without changing the schema or broadening
  credential-management rollout.
- The UI is deliberately a functional extension of the current Circle card, not
  the broader visual redesign tracked separately.
- The member list does not expose email addresses or a searchable directory.
  It is capped at 500 entries; pagination/search is tracked by issue #103 for
  circles that reach that size. Account recovery and identity changes remain
  separate security workflows.
- There is no bulk member administration. Each destructive action has a focused
  confirmation and its own auditable transaction.
