# Weekly pairing publication recovery

## Outcome

Randori now describes a missing weekly pairing with authoritative server state
and gives the active circle owner one safe recovery action. Members see whether
publication is scheduled, delayed, or complete without seeing an owner control.
The change reuses the existing immutable publication and outbox transactions;
it adds no table, migration, background job, or notification path.

## State contract

Successful current-cycle responses from `GET /api/weeks` and
`GET /api/my-pair` include:

```json
{
  "publication_state": {
    "state": "pending | overdue | published",
    "cycle_key": "64 lowercase hexadecimal characters",
    "observed_at": "authoritative UTC instant",
    "scheduled_at": "resolved cycle cutoff instant",
    "recovery_at": "scheduled_at plus 30 absolute minutes",
    "published_at": "published UTC instant or null",
    "can_publish_now": true
  }
}
```

`can_publish_now` is present only after the read snapshot verifies the current
actor is an owner. It is true only for an unpublished overdue cycle. A durable
publication always wins over elapsed time and produces `published` with a
non-null `published_at`.

Production reads and writes use database time. Consistent with ID-50, the fully
verified isolated loopback runtime keeps its application-clock test seam; it is
not a production clock source.

The cycle resolver owns London wall-clock behavior. Recovery adds 30 absolute
minutes to its resolved cutoff; it never adds a week or reconstructs local
time. Therefore a normal GMT Sunday opens recovery at 08:30Z and a normal BST
Sunday at 07:30Z. The spring and autumn transition Sundays follow the resolver's
canonical boundary. Exactly `recovery_at` is overdue; one millisecond earlier
is pending.

## Manual publication

The owner request is:

```http
POST /api/pairing/run
Content-Type: application/json

{"expected_cycle_key":"<current scoped key>"}
```

No extra or differently cased property is accepted. Authentication and owner
preflight still precede request parsing so unauthorized callers do not gain a
contract oracle. Inside the write transaction the service:

1. verifies the migration-owned schema and connection guards;
2. samples database time and resolves the current tenant scope;
3. revalidates the actor, owner role, active circle, and context generation;
4. derives the current scoped cycle key and reads any durable publication;
5. rejects a mismatched key as `409 pairing_cycle_changed`;
6. returns a matching existing publication without mutation, including before
   grace, or rejects an unpublished early request as
   `409 pairing_recovery_not_ready`;
7. otherwise uses the existing eligibility, fairness, immutable claim, and
   versioned outbox path.

Both stable conflicts include `publication_state`. Selected-circle responses
also include `circle_public_id` and `circle_context_version`. A database lock
may be retried only before commit begins; every attempt resamples authority,
time, and cycle. A commit-started or otherwise ambiguous failure is never
retried automatically.

Cron does not send an expected key and does not use the recovery grace gate.
Its existing Sunday `[08:00, 10:00)` UTC admission remains unchanged. Owner and
cron calls converge on the same primary week claim or secondary
`(scope_key, cycle_key)` claim. Empty primary and all-unavailable secondary
snapshots are durable published outcomes, not permanently overdue states.

## Browser behavior

The Pairing view and dashboard show Publish now only for an exact, currently
bound `overdue` envelope with `can_publish_now: true`. Pending copy names the
scheduled and recovery instants. An overdue member is told that the owner can
retry. A `503` keeps a visible Retry action.

The browser captures account ID, public circle ID, context version, and cycle
key before mutation. Delayed responses are inert after sign-out, account change,
circle switch, context-generation change, or cycle change. After success,
stable `409`, or ambiguous `503`, it refetches the active authoritative surface
(`/api/my-pair` on the dashboard or `/api/weeks` in Pairing). A successful
publication always refreshes Pairing and also refreshes the dashboard when it
is visible. It does not infer publication from the mutation response.

The dedicated `randori-pairing-publication-v1` BroadcastChannel is only an
invalidation hint. Its payload contains the version, event type, account ID,
public circle ID, context version, and cycle key. A receiver validates every
identifier against its committed context and current server envelope, then
refetches. It never renders state carried by another tab.

## Observability and operations

Manual attempts emit aggregate `pairing_recovery_completed` or
`pairing_recovery_rejected` events. Metadata is limited to outcome, stable error
code, publication state, and aggregate participant/pair/solo counts. It omits
email addresses, account IDs, circle IDs, cycle keys, request headers, and
pair assignments. Existing weekly completion and outbox backlog/dead-letter
metrics remain the source for cron and notification health.

Canary checks should cover pending, exact grace, overdue, successful and replayed
publication, empty publication, owner demotion, active-circle switch, stale
cycle, ambiguous response, and two-tab refresh in both GMT and BST examples.

## Alternatives and rollback

- A new recovery queue/table adds operational state without improving the
  existing unique claim; rejected.
- A wider or more frequent cron window improves automation but does not provide
  an owner-visible recovery contract; it can be considered separately.
- Optimistic UI publication, browser-derived roles, client-clock eligibility,
  or state-bearing cross-tab messages are faster but unsafe under stale tabs;
  rejected.
- A force/remix operation breaks immutable pairing and outbox guarantees;
  rejected.

Rollback is code-only: hide the recovery action and stop accepting keyed manual
publication. Never delete or rewrite publications or outbox events already
committed by this path. Because the storage model is unchanged, older readers
continue to consume the same durable pairing records.
