# Pairing publication totality

Status: candidate code-only reliability increment

Decision: ID-50

## Contract

The weekly control plane admits authenticated cron work only on Sunday from
08:00 inclusive until 10:00 exclusive UTC. Database time decides admission.
The `Europe/London` resolver still owns cycle identity and the Sunday 08:00
local boundary, so the UTC retry window begins at the cutoff in GMT and one
hour after it in BST. Exact GMT, BST, spring-transition, autumn-transition,
weekday, and half-open boundary tests pin the contract.

Primary publication is total for every valid active-membership snapshot,
including a snapshot in which all members are unavailable. That case commits
one immutable `pairing_week_runs` claim and its `pairing_weeks` row with zero
participants and zero groups. Each unavailable member still gets the same
versioned, idempotent `pairing.email.requested` event in the durable outbox.
Retries and an owner/cron race converge on the existing generation and cannot
duplicate the claim or outbox set. An empty primary result is success, so the
same cron invocation continues to process its bounded secondary-circle list.

Primary `/api/my-pair` classification now reads unavailable evidence only from
the current version-1 `outbox_events` contract. It requires the exact event
type, version, primary idempotency key, valid JSON, week, user, and kind. The
legacy `pairing_email_outbox` fallback is intentionally removed rather than
left unbounded. The existing bounded compatibility bridge migrates actionable
legacy rows into the durable outbox before delivery; new publications have
always committed current outbox evidence atomically.

Weekly completion emits one structured aggregate record. It contains only
created/existing and participant, pair, solo, attempted, and failure counts.
The logger receives no request, identities, circle/scope identifiers, or cycle
keys.

## Preserved invariants

- Production publication, cron admission, and primary read classification use
  database time. The verified isolated loopback runtime retains its explicit
  application-clock adapter for deterministic future-cycle product tests; it
  cannot activate in production or against a remote database.
- The deterministic seed remains `<cycle-id>:weekly`.
- Authorization, eligibility, claim, groups, and outbox writes remain inside
  one write transaction.
- Only known pre-commit lock conflicts are retried. Once commit begins, an
  ambiguous result is returned as unavailable and is not replayed in process.
- Unique cycle claims and outbox idempotency keys remain the concurrency
  boundary.
- No request-time DDL and no schema migration are introduced.

## Alternatives considered

| Option | Advantages | Costs and decision |
| --- | --- | --- |
| Reject an empty eligible set | Avoids a visually empty week | Leaves the cycle overdue forever and starves secondary work; rejected |
| Synthesize a placeholder or solo group | Reuses non-empty rendering | Creates a false identity and violates authorization; rejected |
| Store a second eligibility table for primary circles | Models all snapshot members directly | Requires a migration and duplicates the already durable event evidence; defer to a future unified publication model |
| Keep reading the legacy email queue | Eases old-runtime rollback | Makes current truth depend on a retired delivery implementation; rejected |
| Accept any two-hour period after the local cutoff | Flexible across zones | Admits weekday retries and obscures the scheduler contract; rejected |

## Rollout and rollback

Deploy the application code after migrations are confirmed current; no new
migration, secret, provider change, or production data mutation is required.
Canary Sunday admission at 08:00 and 09:xx UTC, an all-unavailable primary
circle, a secondary publication in the same invocation, and a member
`unavailable_current_cycle` response. Monitor the aggregate weekly completion
event and existing outbox metrics.

Rollback is application-only. Previously committed empty publications remain
valid data, so a rollback that cannot read them would make that cycle
temporarily unavailable; roll forward is the preferred recovery. Never delete
or remix a committed cycle. If the cron window must be disabled, remove the
scheduler invocation or rotate its secret rather than weakening admission.
