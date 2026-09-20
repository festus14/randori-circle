# Private external meeting links

## Product and API contract

Randori stores one provider-neutral HTTPS meeting URL for the canonical primary
room's currently accepted session time. Authenticated participants can add,
change, remove, and open the link from the accepted-time card or the primary
workspace. The UI shows only the hostname and an explicit warning before an
external navigation. `target="_blank"` links carry `rel="noopener noreferrer"`.

`GET /api/meeting-link?room_id=week_<week>_pair_<group>` returns a private,
non-cacheable projection. `POST /api/meeting-link` accepts exact operations:

- set: `{room_id, action:"set", base_version, schedule_version,
  completion_version, url}`;
- clear: `{room_id, action:"clear", base_version, schedule_version,
  completion_version}`.

The authenticated session is the only actor source. Authorization is rebuilt
from the immutable `auth`-tagged primary pairing snapshot. An unauthorized and
a nonexistent room both return `{error:"pair not found"}` with status 404.
Secondary coordination rooms never receive this capability.

URLs are limited to 2,048 UTF-8 bytes, parsed with the platform URL parser, and
must use HTTPS with no embedded username or password. Randori does not fetch,
resolve, preview, unfurl, proxy, or log a URL. The URL remains private pair data
and is deliberately absent from history, recap, notifications, telemetry, and
public statistics.

## Lifecycle and concurrency

Migration 18 owns `pair_meeting_links`. Each row is bound by composite foreign
keys to the exact primary pair snapshot and normalized accepted schedule
instant. The latest actor must also be an `auth`-source participant occupying
that pair. Migration-owned guards prevent identity/source changes and require a
strictly monotonic revision. A cleared link retains a null-valued revision
tombstone while the accepted session is unchanged, preventing ABA updates.

Every mutation compares three opaque versions inside one write transaction:

1. meeting-link state;
2. schedule state;
3. participant-confirmation state.

Changing or clearing the accepted time invokes a migration-owned `BEFORE
UPDATE` trigger that deletes the bound row in the same schedule transaction.
This also keeps a v17 application binary safe during rollout and rollback.
Deleting the schedule cascades the row; proposal-only edits preserve the link.
Once every participant confirms completion, reads return a completed
lifecycle with no URL or hostname and all link mutations fail closed. Terminal
completion cannot be withdrawn, so retained storage cannot become visible
again. Pair deletion cascades the record.

Browser reads and writes are additionally fenced by request generation,
authenticated account, canonical room, active primary circle/context,
current-cycle identity, schedule version, and completion version. Polling lets
two open browsers observe each other's edits and stops across hide, sign-out,
room/circle changes, or terminal completion.

## Rollout and rollback

1. Rehearse the additive v17 to v18 migration against a disposable restore.
2. Apply exactly migration 18 through the protected production migration
   workflow. The migration-owned invalidation trigger is compatible with the
   v17 runtime, which cannot create link rows.
3. Deploy the v18-aware runtime; the route fails closed if readiness does not
   see the exact migration-owned table and guards.
4. Canary add/change/remove/join across two participant browsers, concurrent
   writes, restart recovery, rescheduling, clearing, completion, and access
   isolation. Confirm no URL appears in logs or recap/history payloads.
5. Monitor generic meeting-link and schedule error rates only.

After migration 18 is applied, rollback retains its table, indexes, triggers,
manifest, and ledger row. The invalidation trigger keeps reschedule and clear
safe under the v17 runtime. Disable the UI/handler if necessary and roll
forward; do not drop private rows or rewrite migration history. Explicit pair
deletion remains the supported data-removal path.

## Alternatives considered

| Option | Advantage | Why not now |
| --- | --- | --- |
| LiveKit/SFU integration | Integrated media and TURN | Adds provider secrets, cost, media policy, and operational burden before the connection path is proven |
| TURN for the existing WebRTC path | Improves NAT traversal | Retains custom signalling/recovery and still introduces provider infrastructure |
| Put URLs in chat | No new table or controls | Links are buried, not schedule-bound, have no stable Join action, and survive rescheduling ambiguously |
| Encrypt URLs in application storage now | Limits plaintext exposure in a database export | Requires managed envelope keys and rotation/recovery design; access control, retention, and backup encryption remain the current boundary |
| Store provider IDs instead of URLs | Strong provider-specific validation | Removes provider neutrality and requires SDK/API calls and secrets |
| Automatically delete on completion | Minimizes retention | Makes incident recovery and lifecycle auditing harder; terminal server-side hiding gives the same product privacy without an implicit destructive operation |
