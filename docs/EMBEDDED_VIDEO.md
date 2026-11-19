# Embedded interview video (Daily)

Issue [#463](https://github.com/festus14/randori-circle/issues/463), part of
the real-time mock-interview epic #460. Decision:
[ID-98](IMPLEMENTED_DECISIONS.md#id-98-embed-consent-gated-daily-video-in-primary-pair-rooms-behind-a-flag).
Off by default behind `DAILY_VIDEO_ENABLED`.

## What it does

The interviewer and the candidate of a primary two-person pair room can talk
and see each other without leaving the room. **Join call** in the room bar
opens a consent notice inside the room. Nothing is requested, no frame is
created and the browser shows no camera or microphone prompt until the member
clicks **Join video call**. The member chooses whether to start with the
camera and the microphone on. The room then loads Daily Prebuilt in a
sandboxed iframe, which has its own mute, camera and leave controls.
**Leave call** unloads the frame, which ends capture on that device.

Calls are **never recorded**. Randori builds no recording, neither the room
nor the token sets a recording option, and a room Daily reports with any
recording mode is refused before a token is minted (see [Provider settings](#provider-settings)).
AI features stay separate: nothing from a call reaches the AI routes.

The private external meeting link ([private meeting links](PRIVATE_MEETING_LINKS.md))
and the direct browser call remain as fallbacks until the embed is proven
reliable. When the room endpoint is unavailable (provider down, 503, 404, a
malformed response, too many attempts) the panel says so and offers the
pair's meeting link (opens outside Randori, `rel="noopener noreferrer"`) and
the direct browser call.

In interview lobby mode (ID-99) the candidate can join the call from the lobby;
the lobby gates code, board and selection, not conversation
([session controls](SESSION_CONTROLS.md#realtime-relay-kits-and-video)).

## Server contract

`POST /api/video/room` (rewritten to `api/video.js?endpoint=room`; no new
serverless function). It exists only while the flag is on **and** the
provider configuration is valid, and the handler module
(`api/_daily-video-route.js`) is imported only in that case. Otherwise
`/api/auth/capabilities` does not advertise `embeddedVideo`, and the request
reaches the existing signaling handler, which answers a `{room_id, camera,
microphone}` body with its usual `400 room_id, from_id, type, payload
required`. The URL is new even though no handler behaviour changed.

- Body, exactly: `{room_id, camera, microphone}` with a canonical
  `week_<week>_pair_<group>` room and two booleans. The only query parameter
  is `endpoint=room`. Anything else is 400.
- Same-origin mutation check, session authentication (401), `POST` only (405).
- Rate limit before authorization: 12 joins per account and 30 per client
  network (an IPv6 /64) per fixed 15-minute window, through the shared keyed
  limiter (`api/_keyed-rate-limit.js`, also used by product feedback) in the
  existing `auth_rate_limits` table. Over the limit: 429 with `Retry-After`
  set to the seconds left in the exhausted window. A rate-limit store failure
  or an invalid counter is 503, never an unlimited grant.
- Authorization is the same read as session controls
  (`readAuthorizedSessionControls`): the `auth`-source participant of an
  exact two-person, non-AI primary pair, in a read transaction. Non-members,
  wrong rooms, triads, AI pairs, stale (`users`-source) snapshots and
  secondary-circle rooms all get the identical `404 {error:"pair not found"}`.
  With circle membership on, the active primary-membership joins apply too.
- Terminal rooms are refused with 409: `interview_session_ended` after an
  interview ends or its database-clock timer expires, `session_completed`
  after both participants confirm completion.
- Success: `{ok, room_id, provider:"daily", room_url, token, expires_at,
  expires_in, recording:false}`, `Cache-Control: private, no-store`.
  `expires_in` is the pass lifetime in seconds, computed from the database
  clock; the browser schedules the close from it, not from its own clock.
- Budget refusals, provider failures and timeouts (5 s per call, redirects
  refused) return exactly `503 {"error":"video_unavailable","fallback":"direct_call"}`,
  with `Cache-Control: private, no-store` and no diagnostic detail.
  The log line is `{stage, status, error}`: the failing stage, the provider's
  HTTP status and an allowlisted Daily `error` category (for example
  `invalid-request-error`). Arbitrary provider strings are not log categories.
  Daily's `info` text, the key, a token, a role label and the room name are
  never logged.

Rate limits, aggregate usage snapshots and random grant reservations reuse
`auth_rate_limits`. No migration or runtime DDL is needed.

## Monthly budget and fallback

Issue [#490](https://github.com/festus14/randori-circle/issues/490),
[ID-106](IMPLEMENTED_DECISIONS.md#id-106-cap-daily-video-grants-with-a-shared-monthly-budget-and-direct-call-fallback).
`DAILY_MONTHLY_MINUTE_BUDGET` is a positive safe decimal integer, default **9000**
participant-minutes when unset. Blank, zero, negative, fractional, nonnumeric,
unsafe integers or other invalid values fail closed (no embedded capability;
the room endpoint gives the typed 503). The flag remains **off** by default.

- Period: calendar month **UTC**, not a rolling window. `GET /v1/meetings`
  uses `timeframe_start` at month start and `timeframe_end` at month end,
  `limit=100` and `starting_after` cursors. No `ongoing` filter excludes live
  sessions. Sum `ceil(participant.duration / 60)` separately; never substitute
  meeting duration or maximum seats. If Daily includes a meeting that started
  before month start, count it too: conservative over-counting is safer than
  rejecting a valid month-straddling record. At most **20 pages**, **5 seconds
  per request**, and **8 seconds total** including bodies. Malformed, duplicate,
  truncated or over-bound data refuses; no partial sum is cached.
- Shared cache: snapshots must be **less than five minutes** old, from refresh
  start at the database clock. A fenced DB claim makes refresh single-flight
  across instances. A successful refresh holds the five-minute cooldown;
  failed/crashed refreshers hold only **30 seconds**. Provider I/O stays outside
  the write lock. Reported usage **ratchets upwards within the UTC month**:
  a smaller/empty successful response cannot erase already reported usage.
  Only a new month's key resets it. No fresh snapshot means no new spend.
- Pair admission: the first pass reserves **2 × ceil(TTL seconds / 60)**
  participant-minutes (at most **120**) for both seats, under the existing HMAC
  room name (`dvb1:p:`; no raw Randori room/member ids or tokens). A partner or
  rejoin reuses that prepaid envelope without additional spend, including
  during a usage-cache outage. Their token is capped at the first token's
  expiry, never extended by reuse. Existing per-grant rows remain counted on
  upgrade. All pair reservations remain until **token expiry + five minutes**,
  bridging final reported minutes and the next snapshot; this accounting grace
  cannot mint a new pass. Failed/unknown provider outcomes keep the reservation.
- A single write transaction checks `reported + active reservations + 2 × TTL`
  before reserving a new pair. **Equality passes; above budget refuses both
  seats.** Active reservations include month-straddling pairs. If a partner
  falls back during a concurrent cold refresh, a short pair-level pause is
  committed before the refresher can admit that pair, so both fall back together.
  Known rolled-back lock conflicts have bounded jittered retries; unknown
  commit acknowledgements never replay. Pair reuse makes no new reservation.
- Refusal or provider failure: **“Built-in video is paused — use the direct
  call”**, with the direct call and private meeting link, no reload or frame.
  The panel asks the partner to use the same fallback too. Normal consent,
  join and leave remain unchanged. A persistent, initially empty `role=status`
  live region announces changes; focus moves from removed Join to status,
  then to the direct-call action on fallback.
- Diagnostics remain read-only, aggregate-only, with no provider calls, room
  names, tokens or participants. `ok` is healthy; `near` (90%) and exhausted
  `paused` are warnings. Flag/local-runtime off is neutral **“Not enabled”**,
  not a red failure. No fresh evidence is `unknown`; invalid configuration,
  failed/untrusted reads or failed refreshes are red failures. Fixed reasons
  distinguish **“Usage too large to read”** (page ceiling), timeout, read failure
  and budget exhaustion.

**Owner note:** Daily requires a card on file even within the **10,000 free
participant-minutes per month** (pricing verified 2026-11-19). Daily has no
documented spending cap; Randori caps new grants at the budget. Reporting
can lag (~15-second duration granularity; joins under ~10 seconds may be
absent), so this is a conservative admission guard, **not** a guarantee of
zero provider charges: delayed usage, other apps sharing the Daily account,
repeated joins with one token and month-start attribution can differ from
billing. Keep the 1,000-minute default headroom, use a dedicated account,
and review Daily usage before enabling or increasing the budget.

## Provider settings

Daily REST API, called only from the server with the server-only
`DAILY_API_KEY`:

1. `POST https://api.daily.co/v1/rooms/<name>` updates the room. A 404 means
   it does not exist yet, so `POST /v1/rooms` creates it. If the partner
   created it in between (400), the update is retried once. The response must
   name the room, report `privacy: "private"` and `config.max_participants:
   2`, and its `config.enable_recording` must be unset (or empty, `null` or
   `false`). Any other room (stage `room-config`) is a 503 and no token is
   minted.
2. `POST /v1/meeting-tokens` mints the participant's token.

| Setting | Value | Why |
| --- | --- | --- |
| Room name | `rc-` + first 32 hex of HMAC-SHA256(`JWT_SECRET`, `randori-daily-room-v1\0<room_id>`) | Opaque; not derivable from week or pair ids. Rotating `JWT_SECRET` simply moves pairs to new rooms |
| `privacy` | `private` | Only token holders can join |
| `max_participants` | `2` | Interviewer and candidate only |
| Room `exp`, `eject_at_room_exp` | now + 2 h, `true` | Rooms expire on their own; renewed on each join |
| `enable_prejoin_ui`, `enable_knocking`, `enable_chat`, `enable_screenshare`, `enable_live_captions_ui` | `false` | Randori's consent notice is the pre-join step; the room has its own chat; no screen share or captions |
| Recording | not set on the room or the token; `enable_recording_ui: false`; the returned room is checked | Daily's `enable_recording` only names recording modes (`cloud`, `local`, `raw-tracks`, …) and is off when unset, so Randori never sends it or `start_cloud_recording`, and refuses a room that reports any mode |
| Token `room_name`, `is_owner` | the room, `false` | No owner powers |
| Token `exp`, `eject_at_token_exp` | see below, `true` | Daily ejects the participant when the pass expires |
| Token `user_name` | `Interviewer` or `Candidate` | The viewer's role at join time. No display name, email or account id reaches Daily |
| Token `start_video_off`, `start_audio_off` | from the member's Join choices | Join muted or with the camera off |

Token lifetime comes from the database clock. In interview mode
(`INTERVIEW_SESSION_ENABLED=true`) it is at most the time left on the shared
timer, whether it is running or paused, so the pass never outlives the
interview. Otherwise it is one hour. The browser also closes the frame after
`expires_in` seconds and offers to join again.

## Browser

`assets/embedded-video.js` is imported on the first **Join call** click, and
only while `embeddedVideo` is advertised (it counts toward the byte budget's
total, not its initial slice). It uses DOM nodes and `textContent` only.

- The frame source must be `https://randori-circle.daily.co/rc-<32 hex>` and
  the response must say `provider:"daily"`, `recording:false` and the same
  `room_id`, with an integer `expires_in` of 1 to 3,600 seconds; anything
  else is treated as unavailable. The token is appended as `?t=`.
- `<iframe allow="camera; microphone; autoplay; fullscreen"
  sandbox="allow-scripts allow-same-origin" referrerpolicy="no-referrer">`.
  `fullscreen` serves Prebuilt's fullscreen button (its default allowlist
  lets the frame be delegated without a header change). `sandbox` keeps the
  frame from navigating the app, opening popups or submitting forms;
  `allow-same-origin` refers to the frame's own Daily origin, which is
  cross-origin to Randori. `allow-popups` is deliberately left out.
- Page headers (`vercel.json`): CSP `frame-src 'self' https://randori-circle.daily.co`;
  Permissions-Policy `camera=(self "https://randori-circle.daily.co"),
  microphone=(self "https://randori-circle.daily.co")`. No Daily script is
  loaded into the app origin and `connect-src` is unchanged: the browser never
  calls the Daily API. Because the CSP names one origin, the server enables the
  feature only when `DAILY_DOMAIN` is exactly `randori-circle.daily.co`.
- Stop conditions (frame unloaded, then removed, and any pending request
  aborted and ignored): Leave, a room change, workspace scope reset or
  deactivation, sign-out or a different account, the interview terminal
  coordinator (`randori:interview-ended` and `_randori_video.disposeForScopeChange`),
  unanimous completion (`randori:completion-observed` with state `completed`,
  which also covers peer mode where no interview end exists), token expiry
  and `pagehide`. A tab hidden before the frame exists abandons
  the join, so no permission prompt appears in the background. A live call
  survives a tab switch, as a phone call would.
- Solo practice, a signed-out member, a missing room and an ended interview
  explain themselves without a request.

## Operator setup

Already provisioned (owner-approved): `DAILY_API_KEY` (sensitive, server-only)
and `DAILY_DOMAIN=randori-circle.daily.co` in Vercel Production and
Development.

1. In the Daily dashboard, confirm the domain's own defaults do not turn on
   recording, transcription or an auto-start of either. Randori relies on
   Daily's default of no recording.
2. Deploy with the flag off and confirm `/api/auth/capabilities` has no
   `embeddedVideo`.
3. Set `DAILY_VIDEO_ENABLED=true` in a Preview deployment first (Preview
   needs `DAILY_API_KEY` and `DAILY_DOMAIN` too), redeploy, and confirm
   `embeddedVideo: true`.
4. Two-browser canary on the preview with a real pair: consent notice with
   no prompt, Join, both see and hear each other, mute and camera off inside
   Prebuilt, Prebuilt's fullscreen button works and nothing needs a popup,
   Leave stops the camera light, rejoin, end the interview for both (frames
   close), both participants confirming completion with interview mode off
   (frames close), token expiry, and a non-member gets 404. Check the Vercel
   logs show no key, token or room name, and the Daily dashboard shows the
   room as private with no recording.
5. Then set the flag in Production and redeploy.

Rollback: unset the flag (or set `false`) and redeploy. The capability and
the route disappear; the meeting link and the direct call work as before.
Daily rooms expire on their own within two hours. Budget reservations expire
with their tokens and namespaced counters are reclaimed by existing TTL
cleanup; keep the table and do not reset live reservations when toggling.
