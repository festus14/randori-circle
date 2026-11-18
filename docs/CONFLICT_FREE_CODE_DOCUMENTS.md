# Conflict-free pair code documents

Status: existing migration-backed documents (#234), with optional default-off
Supabase relay-only transport (#461 / ID-96).

## Decision

Canonical primary two-person rooms use one bounded Yjs `Y.Text` per
`(week, pair group, question slug, question version, language)`. Migration 20
stores compact Yjs state, state and code hashes, a monotonic revision, the exact
two-member `auth`-source snapshot, the last authenticated actor, diagnostic
client metadata, and database timestamps. The whiteboard and question selection
remain in workspace schema v3. Presence and remote cursors remain out of scope.
The optional relay below serves canonical primary two-person rooms only;
secondary-circle documents keep their existing HTTPS transport.

Yjs `13.6.27`, y-monaco `0.1.6`, y-protocols `1.0.6`, and esbuild `0.25.9`
are exact package-lock dependencies. `assets/crdt-editor.js` is a checked-in,
same-origin minified bundle produced by `npm run build:crdt`; it loads no CDN
module or secret. Its optional minimal Phoenix v1 transport is bundled locally,
with no additional production dependency. y-monaco binds the shared `Y.Text` to Monaco. The
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

## Supabase relay-only transport (#461)

`REALTIME_RELAY_ENABLED` is on for the literal string `true` only. It defaults
off. All four provider settings must validate locally before discovery offers
`realtimeRelay` and primary document GETs include `realtime_relay: true`.
Missing/invalid settings or the flag off omit both fields; no token request or
WebSocket is made by the browser, and existing HTTPS behaviour is unchanged.
Capability discovery is not evidence that the provider key and RLS are installed.

`POST /api/code-document/relay-token` is grouped in `api/code-document.js`, with
no new Vercel function. It is authenticated, strictly same-origin even with a
bearer credential, `private, no-store`, and limited to 12 tokens per account
per five-minute window in the existing `auth_rate_limits` table (keyed opaque
counter; 429 includes `Retry-After`). It accepts only the exact room/exercise/
version/language identity. A SELECT-only document authorization reuses
`api/_pair-access.js`'s source-tagged arguments and the HTTPS code authority,
requiring two distinct `auth` participants, a non-AI/non-triad primary room,
a present, unexpired document whose participant snapshot still equals the live
pair, and no unanimous completion. When multi-circle control is enabled, the
live session context must select the primary circle and its version header
must match. Malformed, foreign, stale, missing, secondary, AI and triad rooms
all get `404 {"error":"pair not found"}`; unavailable storage gets a generic
503. Tokens never bootstrap a document or write the workspace.

Node built-in crypto signs ES256/P-256 JOSE `r || s` JWTs, with `kid`, `iat`,
`exp` (maximum 300 seconds, also capped by session expiry), `role` and audience
`authenticated`, the provider `/auth/v1` issuer, and an opaque UUID-shaped
per-account `sub` keyed from the private signing material. There are no account
numbers, names, emails or app-session credentials in the JWT. The `room` claim
is exactly the **unprefixed** channel topic:
`rc-code:v1:<canonical-room>:<sha256-context>`. Its hash binds the cycle, live
two-participant snapshot, exercise slug/version and language. The claim also
includes the canonical room, cycle and exercise context for auditability. The
wire topic prepends `realtime:`; RLS compares `auth.jwt()->>'room'` to
`realtime.topic()` (without that prefix), never to a client payload field.

The browser uses the small JSON Phoenix v1 broadcast subset, wire-reviewed
against `@supabase/realtime-js@2.15.4`: private `phx_join`, broadcast, heartbeat,
reply and close/error handling. It never falls back to public channels, REST
provider broadcasts, presence or Postgres subscriptions. The publishable key
alone is in the socket URL; the short-lived JWT is only in the join frame and
memory, never local/session storage or logs. CSP permits the Supabase WSS host
family; configuration restricts the actual connection to the configured project.
The checked-in CRDT bundle is minified and verified byte-for-byte by
`check:crdt`; no byte-budget threshold or coverage gate is weakened.

Packets contain exactly `{update: <canonical base64 Yjs bytes>, sender:
<random per-document-session nonce>, seq: <positive monotonic integer>}`. No board,
chat, presence, identity or plain code field is relayed. Every update is bounded
to 64 KiB; frames to base64 capacity plus 1 KiB; send/receive to 20 messages/s.
Outgoing edits coalesce for 50 ms in one bounded update. A socket buffer above
256 KiB fails over. Invalid frames, stale topics, self-echo, duplicate metadata
and unsupported events are ignored. Replay windows are bounded (eight senders,
256 sequence values each); sequence never orders Yjs, so reordered dependent
updates are still applied. The receiver checks a disposable Y.Doc against the
same plain-text/root/code/state limits before touching the live editor.

**Durability and Run:** every locally produced **and received** update enters
the existing actor/document-scoped HTTPS queue. Received updates are not echoed.
Relay receipt does not advance revision/version or acknowledge anything, and
Run stays disabled until HTTPS acknowledges the queued update. The server
continues to execute only its verified materialized acknowledged version.
Conflicting/offline edits still merge idempotently through HTTPS. Oversized,
rate-limited or missed relay updates remain safe in that queue/polling path.

**Fallback and lifecycle:** HTTPS polling remains active every 1.2 seconds,
even with a healthy relay; the relay accelerates visibility, not authority.
A token 404/429/503, 5-second token/join timeout, refused private join, socket
error/close, missed heartbeat or expiry starts an immediate HTTPS reconcile and
a bounded relay retry (1–30 seconds backoff; 404 waits 30 seconds, 429 respects
bounded `Retry-After`). Tokens renew by closing/rejoining with freshly authorized
tokens 30 seconds before expiry, not by extending a cached permission.
Terminal completion/write rejection, hidden tab, sign-out, room/exercise/
language/account/circle context changes and offline events close the old socket,
abort token work and clear transport timers. Late frames are fenced by the same
CRDT identity/epoch checks. Visibility/reconnect hydrates HTTPS first.

**Latency evidence:** the fake-timer transport test proves 50 ms coalescing +
30 ms relay transit = **80 ms** keystroke-to-partner, without HTTPS or a polling
tick. The two-browser Playwright canary holds HTTPS POST acknowledgements while
observing the partner's code and disabled Run. Typical real-world expectation is
roughly 50 ms plus sender→Supabase→partner transit and rendering (often
100–300 ms in a nearby region); this is not a measured production SLA. Provider
canary latency, private join denial and reconnect checks are operator gates.

## Supabase provider setup and rollback

These are **orchestrator/operator steps**, not actions run by the application,
CI or this implementation. Do not contact a real project from unit/e2e tests.

1. Keep `REALTIME_RELAY_ENABLED=false` in Vercel and deploy the branch after
   the normal CI gates. Keep the existing HTTPS code-document schema/ledger;
   **there is no Turso migration**.
2. Use the provisioned dedicated relay-only Supabase project. Confirm the
   exact project HTTPS origin and `sb_publishable_…` key in Vercel Production
   and Development. Never substitute a service-role key, `sb_secret_…` key,
   legacy HS256 JWT secret or the Randori session signing secret. Disable
   **public channel access** in the project's Realtime settings. Inspect all
   policies/roles on `realtime.messages` and ensure the project exposes no
   application data/tables through other `authenticated` grants; imported JWTs
   are not Supabase Auth users and this project is for relay only.
3. Generate a private P-256 JWK on a trusted operator machine, with Node 24's
   `generateKeyPairSync('ec', {namedCurve:'prime256v1'})` and
   `privateKey.export({format:'jwk'})`. Save its JSON in a private, gitignored
   file with mode `0600`; never print it to CI, logs or this issue/PR. Supabase
   does **not** export its existing asymmetric private keys. Import this own
   private JWK through the project's JWT Signing Keys controls, rotate to the
   imported key, and confirm its exact provider `kid`. Retain any prior key
   only as the provider's supported rotation procedure requires.
4. Put that **same** private JWK JSON in sensitive server-side
   `SUPABASE_REALTIME_SIGNING_JWK`, and the imported key's exact identifier in
   `SUPABASE_REALTIME_SIGNING_KID`. If the JWK carries `kid`, make it identical;
   optional `alg`/`use` must be `ES256`/`sig`. Never put `d` in a browser asset,
   public env prefix or committed file. Use a separate key/project per
   environment if previews must not join production channels.
5. In the **Supabase Dashboard SQL Editor**, review and execute the entire
   [`supabase/realtime-authorization.sql`](../supabase/realtime-authorization.sql)
   against the relay project. The transaction enables RLS and installs two
   authenticated broadcast grants plus restrictive read/write fences for
   **all roles**, so another permissive policy cannot widen room scope or
   allow a publishable/anonymous key. Supabase's trusted service role can
   bypass RLS; it must never reach a browser. Reapplying this file safely
   replaces only the four `rc_code_relay_*` policies. Do not put this SQL in
   the Turso migration ledger or an API request.
6. Verify in the provider canary: both authorized participants can privately
   join their identical topic; another room/context, anonymous publishable
   key, expired token and missing room claim cannot read or broadcast;
   presence/database subscriptions remain denied. Also verify that an already
   joined test connection loses read/broadcast access at JWT expiry even if it
   does not refresh; do not assume join-time RLS is continuous revocation.
   Leave the flag off if that provider check fails. Check heartbeat, reconnect,
   token renewal, concurrent/offline replay and Run's HTTPS-ack boundary.
   Set `REALTIME_RELAY_ENABLED=true` and **redeploy** the chosen Vercel scope
   only after those checks. Observe keystroke latency without logging code,
   payloads or JWTs. The feature is not automatically turned on by a merge.
7. **Routine rollback:** unset the flag or set `false`, redeploy, and verify
   capabilities omit the relay and token requests get 404. Clients close on
   the next primary document GET or renewal; polling/persistence continue.
   Keep all HTTPS documents, projections, migrations and retention unchanged.
8. **Provider lockdown:** for an authorization incident, revoke the imported
   signing key and disconnect active provider sessions when immediate cutoff
   is needed; turning the app flag off alone cannot invalidate already issued
   JWTs or cached channel authorization (up to the 300-second token lifetime).
   After step 5 was applied, review and execute the entire
   [`supabase/realtime-authorization-rollback.sql`](../supabase/realtime-authorization-rollback.sql)
   in the Dashboard SQL Editor: it removes the two grants and changes both
   restrictive fences to `false`. **Do not drop restrictive policies or disable
   RLS**, because a pre-existing permissive policy could then reopen access.
   Recovery is reapplying the reviewed apply file and a freshly matched
   imported key, canarying, and enabling/redeploying deliberately.

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
