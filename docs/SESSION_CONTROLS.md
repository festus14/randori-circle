# Durable pair session controls

## Product contract

The primary two-person workspace has one shared 25-minute focus timer and one
candidate assignment. Both authenticated participants read the same durable
state from `GET /api/session-controls?room_id=week_<week>_pair_<group>` and use
exact `POST /api/session-controls` commands:

- `{room_id, action:"start", base_version}`;
- `{room_id, action:"pause", base_version}`;
- `{room_id, action:"reset", base_version}`;
- `{room_id, action:"set_candidate", base_version, candidate_user_id}`.

The session supplies the actor; the body cannot choose or impersonate one.
Responses are private and non-cacheable. An absent room, an unauthorized room,
an AI assignment, a triad, a mixed-source pair, and a secondary coordination
room all return the same 404 projection. The payload identifies only the two
already-visible pair members and their current roles. It contains no code,
board, chat, meeting URL, provider data, completion receipt identity, or timer
event history.

The browser displays an accessible Session controls region. Its status live
region announces starts, pauses, resets, role changes, errors, expiry, and the
terminal transition—not countdown ticks. The browser animates the most recent
server duration locally, polls around two seconds while running and five
seconds otherwise, and stops work while hidden, signed out, deactivated, or
terminal. Requests are fenced by authenticated account, canonical room,
primary circle/context, cycle identity, request generation, control version,
and completion version.

## Storage, time, and concurrency

Migration 19 owns `pair_session_controls`, one row per canonical primary pair.
It stores the exact two-member, `auth`-source pair snapshot, the candidate,
durable timer state, remaining milliseconds at the last transition, a nullable
database-time anchor, a monotonic revision, and the last authenticated actor.
Composite foreign keys and migration-owned triggers provide NULL-safe shape,
source and actor binding, and atomically invalidate controls if pair membership
or participant provenance changes. The table permits only a paused timer with
no anchor or a running timer with a positive duration and canonical anchor.

Start, pause, reset, and role assignment execute in serialized write
transactions. Every non-idempotent transition compares an opaque HMAC token
which binds the pair snapshot and complete durable aggregate. The token
deliberately excludes derived display time, so reading a running timer does not
create spurious conflicts. Repeating an already-achieved command is a no-write
success; competing different commands produce one winner and a stable 409 with
the latest safe projection.

Elapsed time is derived from SQLite/Turso UTC time, never the browser or an
application-instance clock. There are no per-second writes. Natural expiry
only makes the timer expired; it never records completion. Once all required
participants have completed the session under migration 17, every control
command is rejected and the effective timer is capped at the unanimous
completion instant. Reads remain available as a read-only terminal summary.

## Rollout and rollback

1. Rehearse the additive v18 to v19 migration against a disposable restore.
2. Apply exactly migration 19 through the protected production migration
   workflow before deploying the handler and UI.
3. Canary two authenticated browsers for role/timer convergence, stale and
   simultaneous commands, natural expiry, terminal completion, sign-out,
   circle/room changes, and process restart recovery.
4. Confirm runtime SQL contains no DDL and countdown animation produces no
   writes. Monitor only generic endpoint error/status aggregates.

Migration 19 synthesizes no state from legacy local-storage timers or role
buttons. Its invalidation triggers also let a rolled-back v18 binary change a
pair or run its older demo-reset order without retaining stale controls. A
rollback keeps the table, triggers, and ledger row, disables the handler/UI if
needed, and rolls forward. It must not drop the table or rewrite migration
history. The v19 runtime explicitly deletes demo-week control rows first.

## Alternatives considered

| Option | Advantage | Why not now |
| --- | --- | --- |
| Workspace snapshot v4 | One existing synchronization channel | Couples tiny role/timer edits to large code/board payloads, conflicts, and cleanup |
| Local storage or `BroadcastChannel` | No server or schema work | Neither is durable or cross-device, and both can leak state across account/room transitions |
| WebSocket, WebRTC, or LiveKit state | Lower-latency notifications | Connection and provider lifecycle become the source of truth; a durable aggregate is still required |
| Redis/KV with TTL | Fast shared countdown | Adds provider, secret, cost, expiry, and recovery dependencies for a small durable record |
| Event sourcing | Complete transition history | Creates unnecessary retention and privacy surface for controls that need only current state |
| Persist each countdown tick | Trivial reads | Causes write amplification and avoidable races; anchor-based database-time derivation is sufficient |
