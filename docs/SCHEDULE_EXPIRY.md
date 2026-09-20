# Schedule expiry contract

Status: candidate code-only scheduling reliability increment; no migration.

## Product invariant

A new proposal or acceptance is actionable only when its normalized instant is
strictly later than the database clock observed inside the successful write
transaction. Equality is expired. This applies identically to primary rooms and
selected secondary-circle schedules.

The API returns HTTP `400` with the stable code
`schedule_instant_elapsed`. Proposal and acceptance rejections are counted
separately as `propose_elapsed` and `accept_elapsed`, with only the primary or
secondary scope class attached. Telemetry contains no user, pair, room, circle,
cycle, proposal, timestamp, or schedule content.

## Transaction and compatibility rules

For a time-sensitive mutation, the server performs these steps in one write
transaction:

1. Re-resolve account, membership, pair, circle, and cycle authority.
2. Read the current schedule and compare the optimistic version.
3. Read one UTC instant with SQLite `strftime(..., 'now')` and validate its
   strict RFC3339 representation.
4. Resolve the proposed or selected instant and require `instant > now_utc`.
5. Only then write the schedule and enqueue notification intents.

A stale version wins over temporal policy and returns the latest safe schedule.
An invalid or unavailable database clock fails closed as schedule unavailable.
An elapsed rejection rolls back before any schedule row, revision, or outbox
write. Notification dispatch keeps its independent `SESSION_ELAPSED`
suppression as defense in depth.

Stored data is never rewritten merely because time passed. Elapsed proposals
remain visible and removable. Elapsed agreements remain visible as past and
can be cleared or replaced. Legacy free-text proposals and agreements preserve
their existing read, remove, and clear behavior.

## Browser behavior

`datetime-local.min` offers local guidance only; it is not an authorization or
clock boundary. The server database remains authoritative. The dashboard:

- labels elapsed proposals as expired, hides their Accept control, and keeps
  Remove available;
- labels elapsed agreements as past, keeps Clear available, and does not offer
  a new calendar export for a past session;
- schedules an identity- and cycle-fenced one-shot refresh at the nearest
  proposal or agreement boundary, and tears it down on navigation, sign-out,
  visibility loss, or scope replacement;
- presents a live, inline expiry error, retains an editable proposal draft, and
  performs an authoritative schedule GET after rejection; and
- applies delayed mutation and refresh results only while account, schedule
  room/identity, selected circle and context generation, and cycle token still
  match the captured operation.

Local rendering uses the browser timezone, including DST transitions. It is a
display and usability aid only; the database comparison owns acceptance.

## Rollout and rollback

No flag, schema, provider secret, or production data change is required. Canary
primary and secondary propose/accept at equality and one millisecond later,
then verify expired stored-state removal and clearing. Monitor only aggregate
`schedule_temporal_rejected` counts split by scope and reason, together with
existing schedule/outbox failure metrics.

Rollback is a normal code revert. Existing schedule and outbox rows are
untouched, and dispatch-time elapsed suppression remains active.

## Alternatives considered

| Option | Advantage | Cost and decision |
| --- | --- | --- |
| Client-only minimum | Immediate guidance | Bypassable and wrong under clock skew; retained only as guidance |
| Application-server clock | Simple comparison | Multiple instances can disagree with the transaction owner; rejected |
| Arbitrary lead time | More preparation time | Blocks urgent sessions and adds an unvalidated product policy; deferred |
| Auto-delete elapsed data | Cleaner-looking state | Destroys history and races clients; rejected |
| Dispatch suppression only | No schedule-path change | Creates apparently accepted sessions that intentionally receive no reminder; retained only as defense in depth |
