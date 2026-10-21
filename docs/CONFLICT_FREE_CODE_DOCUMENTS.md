# Conflict-free pair code documents

Status: candidate migration-backed increment for issue #234.

## Decision

Canonical primary two-person rooms use one bounded Yjs `Y.Text` per
`(week, pair group, question slug, question version, language)`. Migration 20
stores compact Yjs state, state and code hashes, a monotonic revision, the exact
two-member `auth`-source snapshot, the last authenticated actor, diagnostic
client metadata, and database timestamps. The whiteboard and question selection
remain in workspace schema v3. Presence, remote cursors, WebSockets, and
secondary-circle workspaces remain out of scope.

Yjs `13.6.27`, y-monaco `0.1.6`, y-protocols `1.0.6`, and esbuild `0.25.9`
are exact package-lock dependencies. `assets/crdt-editor.js` is a checked-in,
same-origin bundle produced by `npm run build:crdt`; it loads no CRDT provider,
CDN module, or secret. y-monaco binds the shared `Y.Text` to Monaco. The
lockfile-resolved Monaco `0.56.0` peer is build-only and aliased to the local
API shim, so no second Monaco runtime enters the bundle. `npm run check:crdt`
rebuilds in memory and rejects source/bundle drift. The textarea fallback
applies a bounded single-splice diff to that same type.

The page does not load the bundle for every visitor. `index.html` injects it
the first time the code view opens or a pair room changes or hydrates
(`randori:room-change`, `randori:workspace-hydrated`). Activation reads the
current workspace state, so a bundle that arrives after hydration still
attaches. Until it loads, the v3 workspace owns the code, exactly as it does
before the selection checkpoint is acknowledged. The Monaco loader is injected
the same way, and the textarea fallback still covers a CDN failure.

## Authority and merge protocol

`GET/POST /api/code-document` accept only a canonical room and exact active
catalogue identity. One endpoint-specific SQL authority requires a non-AI pair
with exactly two distinct members, both snapshotted as `source='auth'`, and the
caller occupying one slot. Active primary membership is also required when the
membership rollout is enabled. Nonexistent, unauthorized, AI, triad,
mixed-source, and identity-collision rooms all return the same `404`.

The first authorized GET creates the document exactly once in a write
transaction. It seeds only from an exactly matching v3 workspace checkpoint;
otherwise it starts empty and only the transaction winner may seed current
local text. This avoids duplicated starter text from independent Yjs histories.

POST accepts one canonical-base64 update of at most 64 KiB plus a stable client
identifier and diagnostic sequence. In one transaction it reauthorizes, checks
terminal completion, verifies stored state, applies the update, enforces 20 KiB
code and 256 KiB state limits, then advances with revision/hash CAS. Duplicate
or reordered updates converge by Yjs state hash and do not advance revision.
Client sequence is deliberately not an ordering key. Corrupt, malformed,
oversize, or contended writes fail closed without returning code.

Each successful change refreshes code in the matching v3 workspace envelope
while preserving its board. That field is only a rollback projection after a
v20 document exists. A workspace CAS includes an atomic absent-or-exact
document guard: if the workspace wins, later bootstrap sees its bytes; if the
document wins, the workspace retries with canonical code. Workspace writes
therefore cannot reclaim code authority during the handoff.

## Client and execution lifecycle

Pending updates are stored under an actor- and document-scoped local key before
sending. Adjacent queued Yjs updates are compacted without discarding edits,
and abandoned browser queues expire at the same 90-day boundary as server
documents. Reconnect hydrates remote state, reapplies the queue, and retries safely.
Responses are fenced by account, room, question version, language, visibility,
and document epoch. Room/question/language changes destroy the old Y.Doc and
binding. Sign-out clears that actor's queue. Hidden tabs stop requests.
Activation waits for the matching v3 selection/code checkpoint; a failed or
timed-out checkpoint leaves local code untouched and Run disabled. Unanimous
completion destroys the binding, clears the unsendable queue, makes both Monaco
and the textarea read-only, and the server rejects later writes.

An accessible status announces connecting, syncing, synced, offline, retry,
and terminal states. Pair Run is disabled until local changes are acknowledged.
A pair run supplies the opaque document version; the server ignores submitted
code and executes the verified materialized Y.Text bytes. Stale versions return
`409 code_document_changed` with only the latest opaque version, reconcile the
editor, and require another click.

Run attestation v3 signs runner, week, pair group, question identity, language,
exact code hash, document revision/state/version, result digest, and counts.
History recomputes the code hash. Historical v2 and solo runs remain compatible.

## Privacy, retention, rollout, and rollback

Responses are private and `no-store`. Documents contain code only—no board,
chat, transcript, meeting URL, presence, provider credential, or hidden test.
A strict 90-day cutoff runs before access and from the authenticated weekly
scheduler. Each scheduler sweep purges at most 100 expired documents in one
write transaction and leaves any backlog for later due-window sweeps; there is
no internal retry loop. Workspace reads redact an expired projection even when recent board
activity kept the envelope fresh. Pair deletion, pair-shape change, or
participant provenance change atomically invalidates both the document and the
entire old-pair workspace (including its private board). Signed run evidence
keeps the existing run-retention policy and is not deleted with live documents.

Roll out after additive migration 20 is applied and readiness is green. Canary
two-browser overlap, offline replay, restart, fallback textarea, stale Run,
completion, and board writes. Migration 20 is a forward-only boundary: a
pre-v20 binary is not a valid rollback because it rejects the newer ledger and
could acknowledge edits only to the non-authoritative v3 projection. During an
incident, keep the v20-capable API deployed, stop pair editing at the
application/edge maintenance boundary, preserve both tables and the ledger,
and roll forward. Do not admit legacy workspace edits while maintenance is in
effect, drop the table, or edit the ledger.

## Alternatives considered

| Option | Advantage | Cost and decision |
| --- | --- | --- |
| Workspace v4 whole-document CAS | Smallest schema change | Still loses edits and couples code to board conflicts; rejected |
| Diff3 or conflict dialog | Fast mitigation | Interrupts sessions; rejected |
| Managed Liveblocks/Yjs | Low latency and presence | Adds provider, secret, cost, and a data processor; deferred |
| Self-hosted y-websocket | Real-time transport | Adds an always-on auth-aware service; deferred |
| BroadcastChannel | Small local implementation | Not cross-device or durable; rejected |
| Custom OT/CRDT/event log | Full control | Larger correctness risk than pinned Yjs; rejected |
