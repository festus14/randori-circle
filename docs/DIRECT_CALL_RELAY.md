# Direct call relay (TURN)

Issue [#305](https://github.com/festus14/randori-circle/issues/305), re-scoped.
Decision:
[ID-107](IMPLEMENTED_DECISIONS.md#id-107-relay-the-direct-call-through-free-turn-allowances-with-monthly-usage-gates).
Off by default behind `TURN_RELAY_ENABLED`.

## What it does

The pair room's **direct browser call** is peer-to-peer WebRTC with database
signalling (`/api/video/signal`). With Google STUN alone it cannot connect two
browsers that are both behind restrictive NATs (symmetric NAT, carrier-grade
NAT, UDP-blocking firewalls). Embedded Daily video (ID-98) falls back to this
direct call when Daily is paused (#490), so the direct call has to connect on
every network.

While the flag is on, the browser asks `POST /api/video/turn` for short-lived
relay credentials just before it creates its `RTCPeerConnection`, and uses
Google STUN **plus** the returned servers. The relay only carries the call when
a direct path fails; the media stays DTLS-SRTP encrypted end to end, so the
relay sees IP addresses and traffic volume, never call content.

Relays, in order, each only while its own monthly free-allowance gate allows:

1. **Cloudflare Realtime TURN** (`relay: "cloudflare"`): 1,000 GB/month of TURN
   plus SFU and MoQ are included free; Randori budgets 800 GB (80 %).
2. **Metered Open Relay** (`relay: "metered"`), the free backup: 20 GB/month,
   no card; Randori budgets 16 GB (80 %).
3. Neither (`relay: "none"`): the call proceeds STUN-only, exactly as before
   this change. If Daily is also paused, the room still offers the private
   meeting link.

## Server contract

`POST /api/video/turn` (`api/video.js?endpoint=turn`, in the existing video
function; no new top-level function). Body exactly `{"room_id": "<canonical
room>"}`; no other query parameter.

| Condition | Response |
| --- | --- |
| Flag off, local runtime, or no provider fully configured | `404 {"code":"turn_relay_disabled"}` (before authentication) |
| Not signed in | `401` |
| Cross-origin mutation | `403` (`verifyMutationOrigin`) |
| Bad body or query | `400` |
| Over 20 requests per account or 60 per network in 15 minutes | `429 {"code":"turn_relay_rate_limited"}` with `Retry-After` |
| Not a member of the room, unknown room, secondary-circle room | `404 {"error":"pair not found"}` |
| Interview ended / session completed | `409` with the session-controls codes |
| A relay admitted | `200 {"iceServers":[…], "expiresAt":"<ISO>", "relay":"cloudflare"\|"metered"}` |
| Every configured relay over budget | `200 {"iceServers":[], "expiresAt":null, "relay":"none", "reason":"budget_reached"}` |
| Database, readiness or provider failure | `503 {"code":"turn_relay_unavailable"}` |

Every response is `Cache-Control: private, no-store`.

- **Authorization** is the direct call's own signalling check
  (`authPairAccessSql`: a source-tagged pairing participant of that pair
  group, plus active primary membership while circle membership is on), so
  exactly the members who can signal a call can relay it. Triads therefore
  qualify, as they do for signalling.
- **Lifetime** is `min(call window, 1 h)`: an interview room's credential never
  outlives the time left on its shared timer.
- **Provider calls** have a 5-second deadline (8 seconds in total for a usage
  read), no redirects, a 16 KiB response cap and JSON only.
- **Validation** is strict and per provider: only `stun:`/`turn:`/`turns:`
  URLs, only that provider's hosts (`*.cloudflare.com`, `*.metered.ca`), at
  most 8 entries and 16 URLs of 256 characters, printable username/credential
  pairs of up to 512 characters on every relay entry, and at least one relay
  URL. Anything else rejects the whole answer. Cloudflare's `:53` alternates
  are dropped because browsers block port 53. Unknown fields are never copied.
- **Logs** carry provider, stage, HTTP status and budget reason only, never a
  key, token, credential, URL or body.

## Usage gates

Mirrors the Daily participant-minute guard (#490) in `api/_turn-budget.js`,
on the existing `auth_rate_limits` table (no migration):

- **Snapshot.** Usage is read at most every five minutes per provider, by one
  request at a time (a 30-second refresh lease, which also spaces retries
  after a failure), within an 8-second total deadline. The month's figure is a
  **ratchet**: a smaller provider answer never lowers it within the UTC
  calendar month; the next month starts from its own key.
- **Fail closed.** With no fresh snapshot (a failed, timed-out or contended
  read), that provider hands out no credentials and the next relay is tried.
- **Reservation.** Bytes cannot be known up front, so each credential
  reserves `TURN_RESERVE_MB_PER_CALL` (default 1,800 MB) prorated by its
  lifetime, until it expires plus five minutes. A credential is refused when
  `reported + reserved + this reservation > budget`. A reservation whose
  credential was never handed out (the provider then failed) is released.
- **Default reservation.** One relayed allocation carries both directions of
  the call and the providers count every byte on ingress and again on egress:
  2 streams × 2 × 1 Mbps × 3,600 s ÷ 8 = 1,800 MB per credential-hour. The
  room requests 640×360 video, so real calls are usually below this, and most
  calls connect directly and relay nothing.
- **Cloudflare usage** is GraphQL
  `callsTurnUsageAdaptiveGroups(filter:{date_geq, date_leq, keyId})`
  `sum { egressBytes ingressBytes }` for the TURN key over the month to date,
  egress plus ingress, through a separate least-privilege API token with
  Account Analytics read. Cloudflare's free allowance is per account and
  shared with SFU and MoQ, so the account should carry no other Realtime use.
- **Metered usage** is `GET /api/v1/turn/current_usage?secretKey=…`
  (`usageInGB` for the billing cycle; an overage counts as at least the whole
  quota). The cycle need not match the calendar month; the ratchet keeps the
  larger figure, which only errs towards pausing.
- **Diagnostics.** Admin Diagnostics shows a **Call relay allowance** card:
  per provider, reported, reserved and budget MB and whether it is not
  enabled, near (90 %), paused or failed. It never contacts a provider.

`customIdentifier` (per-room accounting) is not sent: Cloudflare documents it
as an analytics dimension, but the generate-credentials request field is
unconfirmed, and an unknown field could make credential minting fail.

## Browser

`assets/turn-relay.js` is imported lazily by the direct call (the inline
addition is about 450 bytes of initial JS). It asks the route once per room
and reuses the answer until a minute before `expiresAt`, so a reconnect after
expiry fetches again. The whole lookup, module import included, is capped at
three seconds; on 404 it does not ask again for ten minutes, on `relay: "none"`
for five, and on any other failure for 30 seconds. It re-checks the servers
(schemes, the labelled relay's hosts, counts and lengths). Credentials live in
that module's memory only, never in web storage or a cookie, and sign-out
forgets them.

No CSP change: TURN is ICE traffic, which `connect-src` does not govern, and
the route is same-origin.

Limitation: credentials are fixed when the peer connection is created. A
relayed call that outlives its credential (at most one hour) can drop when the
relay refreshes its allocation; rejoining fetches a new pass. Metered's
credential is the pre-created one behind `METERED_TURN_API_KEY` (new Metered
credentials take up to two minutes to propagate, so none is minted per call);
`expiresAt` there only bounds the browser's cache and the reservation.

## Operator setup

1. **Cloudflare.** In Realtime → TURN, create a TURN key; keep its key ID and
   API token. Create a second API token with only Account → Account Analytics
   → Read for the same account. Set `CLOUDFLARE_TURN_KEY_ID`,
   `CLOUDFLARE_TURN_API_TOKEN` (sensitive), `CLOUDFLARE_ACCOUNT_ID` and
   `CLOUDFLARE_ANALYTICS_API_TOKEN` (sensitive).
2. **Metered (optional backup).** Create a free Metered account and app, then a
   TURN credential. Set `METERED_TURN_APP_DOMAIN` (`<app>.metered.live`),
   `METERED_TURN_API_KEY` (that credential's API key, sensitive) and
   `METERED_TURN_SECRET_KEY` (the account secret key from Developers, used
   only to read usage; sensitive).
3. Deploy with the flag off: `POST /api/video/turn` is a 404.
4. On a Preview with all values, set `TURN_RELAY_ENABLED=true` and redeploy.
   Verify against the live APIs: the Cloudflare credential shape and 201, the
   GraphQL usage query (it must return one account), Metered's credentials
   array and usage object. Admin Diagnostics shows both relays `ok`.
5. Two-browser canary: one browser on a network that blocks UDP (or with
   `chrome://webrtc-internals` showing only relay candidates), confirm the
   call connects through `turn.cloudflare.com`; temporarily set
   `TURN_MONTHLY_GB_BUDGET` to a value below the reported usage and confirm the
   Metered backup is used; set both budgets below usage and confirm
   `relay: "none"` with a STUN-only call. A non-member gets 404. The Vercel
   logs show no key, token or credential.
6. Then set the flag in Production and redeploy.

Rollback: unset the flag (or set `false`) and redeploy. The route becomes a
404 and the browser keeps its STUN-only call. Issued credentials expire within
an hour; revoke them in the Cloudflare dashboard (or rotate the Metered
credential) for immediate revocation. The only stored state is opaque
`trb1:` counters in `auth_rate_limits`, which expire on their own (credential
expiry plus five minutes, or month end plus one hour).
