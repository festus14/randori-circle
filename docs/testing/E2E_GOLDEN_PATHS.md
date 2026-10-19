# E2E golden-path coverage matrix

Every golden path a member or owner depends on has at least one Playwright
journey that drives the real UI against the **real local runtime**
(`scripts/local-server.mjs`: production request handlers, checked-in
migrations, private file-backed SQLite, no API mocks). Focused mocked specs
remain the place for edge-case matrices (races, malformed envelopes, delayed
responses) that a real server cannot produce on demand.

Legend:

- **Real** — real loopback runtime and database, real browser UI, no route mocks.
- **Real + boundary** — as Real, with one external provider replaced at its
  network edge (see "Replaced boundaries").
- **Mocked** — the browser talks to `page.route` fixtures instead of the server.

| # | Golden path | Primary journey (spec › test) | Mode | Supporting coverage |
| --- | --- | --- | --- | --- |
| 1 | Owner invites by email → `/invite` → signup (email + password) → `/verify` email link → activated → circle dashboard | `password-auth-journey-real-runtime.spec.ts` › *production-shaped invite activation verifies email before the account can sign in with a password* (now continues through first-run profile to `#view-dashboard`) | Real | `local-onboarding.spec.ts` › *owner invites, invited identity signs up, joins the circle…* (UI invitation, wrong-identity rejection, revoked/expired/cross-circle links) — Real; `invitation-email-runtime.spec.ts` (invitation email delivered and activated) — Real; `auth-ui.spec.ts` verification landing states — Mocked |
| 2 | Email + password login, logout, logout-all; wrong password generic error | `golden-auth-real-runtime.spec.ts` › *a member signs in on two devices, a wrong password stays generic, and sign out everywhere revokes both* | Real | `password-auth-journey-real-runtime.spec.ts` › *invited member signs up, signs in…* (unknown email and wrong password return the identical 401 body, case-insensitive email, inactive member refused) — Real; `auth-ui.spec.ts` sign-out / logout-all — Mocked |
| 3 | Forgot password → reset email → `/reset-password` → new password works, old fails; expired / replaced link → clear error + "Request a new link" | `password-auth-journey-real-runtime.spec.ts` › *…recovers a forgotten password from the emailed link, and signs in again* (old fails, new works, other device revoked, link single-use) and `golden-auth-real-runtime.spec.ts` › *expired and replaced reset links explain why and offer a new link that still works* | Real | `password-reset-real-runtime.spec.ts` (fragment scrubbing, session revocation) — Real; `auth-ui.spec.ts` › *expired, replaced and invalid password reset links…* — Mocked |
| 4 | Google sign-in and Google linking from Account security (incl. old / missing `auth_time`, ID-63) | `golden-google-real-runtime.spec.ts` › *Google links from Account security with an old or missing auth_time and then signs the member in*; › *an invited member signs up with Google from the invitation and lands in the circle*; › *an unlinked Google account with the same email is told to use its password and gains no identity* | Real + boundary (Google) | `identity-linking-real-runtime.spec.ts` (final-credential refusal) — Real; `auth-ui.spec.ts` Google reauth / retry, `circle-invitations.spec.ts` invite Google cancel / failure — Mocked |
| 5 | Member sets availability → owner publishes (or cron) → both see the pair → pairing email `/join/<room>` works signed-out → sign in → room | `pairing-real-runtime.spec.ts` › *two invited members complete the durable local session journey* (availability via UI, owner publishes, both dashboards, pairing emails via `/api/cron/outbox`) and `golden-pair-room-real-runtime.spec.ts` › *the pairing email link opens the room after sign-in…* (link from the captured email, signed-out device, sign-in, room hydrated) | Real | `secondary-pairing-email-runtime.spec.ts` (manual and weekly cron route publication) — Real; `outbox-budget-runtime.spec.ts` (cron drain) — Real; `availability-ui.spec.ts`, `pairing-cycle-ui.spec.ts`, `pair-room-sync.spec.ts` — Mocked |
| 6 | Schedule: propose → accept → reschedule / clear; calendar export; meeting link | `golden-pair-room-real-runtime.spec.ts` › *partners in different timezones propose, accept, export, add a meeting link, reschedule, and clear a session time* | Real | `pairing-real-runtime.spec.ts` (propose / accept, schedule + reminder emails) — Real; `secondary-schedule-email-runtime.spec.ts` — Real; `schedule-sync.spec.ts`, `meeting-link.spec.ts`, `secondary-schedule.spec.ts` — Mocked |
| 7 | Chat between partners (send, receive via poll, failed send keeps draft) | `golden-pair-room-real-runtime.spec.ts` › *…partners chat with a recoverable failed send* (receive by polling, transport loss and server rejection both keep the exact draft, explicit retry) | Real (single-request fault injection) | `pairing-real-runtime.spec.ts` (durable transcript across restart) — Real; `chat-sync.spec.ts` (windows, rate limit, malformed ack) — Mocked |
| 8 | Pair workspace: conflict-free co-editing (CRDT), whiteboard checkpoint, Run → shared run feed; session controls | `golden-pair-room-real-runtime.spec.ts` › *partners co-edit one document without conflicts, sketch, run it into a shared feed…* (simultaneous same-offset typing converges, UI whiteboard sketch reaches partner and the recap checkpoint, Run → both feeds) | Real + boundary (execution) | `pairing-real-runtime.spec.ts` (stale-revision CAS + bounded retry, run feed, roles + timer, restart recovery) — Real + boundary; `code-document-sync.spec.ts` (offline replay, undo), `board-sync.spec.ts`, `pair-run-feed.spec.ts`, `session-controls.spec.ts` — Mocked |
| 9 | Session completion by both → History / recap | `golden-pair-room-real-runtime.spec.ts` › *…complete the session, and see it in History* | Real | `pairing-real-runtime.spec.ts` (recap projection after restart) — Real; `session-completion.spec.ts`, `pair-recap.spec.ts` — Mocked |
| 10 | Catalogue solo practice: browse / filter / search → open → Run | `golden-circle-catalogue-real-runtime.spec.ts` › *solo practice browses, filters and searches the catalogue, opens an exercise, and runs it* | Real + boundary (execution) | `catalog-discovery.spec.ts`, `runner.spec.ts` — Mocked |
| 11 | Owner circle management: create / resend / revoke invitation, member list, remove member (removed member blocked) | `golden-circle-catalogue-real-runtime.spec.ts` › *the owner revokes an invitation, sees a new member join the roster, and removes them so they are blocked* | Real | `invitation-email-runtime.spec.ts` (create + resend from the Circle tab, rotated link) — Real; `local-onboarding.spec.ts` (revoked / expired links) — Real; `circle-invitations.spec.ts`, `member-lifecycle.spec.ts` — Mocked |
| 12 | Health / route smoke: `/`, `/invite`, `/verify`, `/reset-password`, `/join/...` serve the app | `golden-routes-real-runtime.spec.ts` › *every client route serves the app shell and boots its landing state on the real runtime*; › *the static checkout server and the Vercel config route every client path to the app* | Real | `app-smoke.spec.ts` — static server; `npm run check:deployability` (SPA fallback contract); `production-smoke` workflow (deployed) |

## Replaced boundaries

Only provider edges a member never sees directly are replaced, always inside the
Playwright worker process and never through a test-only runtime flag:

- **Email** — the production outbox workers run in-process with a capturing
  `send`; the browser opens exactly the links the email contains.
- **Code execution** — the production execution gateway is pointed at its
  self-hosted Piston-compatible provider on the reserved
  `https://execution.e2e.invalid` host; a deterministic transport executes the
  production-generated harness in a child Node process and refuses every other
  destination (`installDeterministicExecutionTransport` in
  `tests/e2e/golden-runtime.ts`, mirroring `pairing-real-runtime.spec.ts`).
- **Google** — the browser's navigation to `accounts.google.com` (and the hop
  inside the real `/api/auth/google/start` redirect) is answered with a redirect
  to the real `/api/auth/google/callback`; the server's token and JWKS requests
  receive an RS256 ID token bound to the nonce Randori generated. The runtime is
  switched to its production Google configuration for that test (the loopback
  adapter deliberately never advertises Google); every key is restored on close.
- **Faults** — the chat test aborts or rejects exactly one `POST /api/messages`
  to prove draft preservation; all other requests reach the real API.

## Not testable end-to-end here

| Surface | Why | Covered instead by |
| --- | --- | --- |
| Google's real consent screen / account chooser | Third-party UI, real credentials | Boundary replacement above + `tests/unit/google-*.test.mjs` |
| Real email provider delivery (Resend) | External network and inboxes | Captured production outbox workers; `outbox-dispatch` watchdog |
| Real execution provider (Piston / Vercel Sandbox) | External network, nondeterministic | `npm run smoke:execution` canary |
| Vercel edge routing and the cron scheduler trigger | Only exists on Vercel | `check:deployability`, `production-smoke` workflow, cron route exercised directly (`/api/cron/outbox`, weekly route in `secondary-pairing-email-runtime.spec.ts`) |
| Video / WebRTC media between two browsers | Needs real media devices and TURN | Not a golden path; mocked archive/media cleanup specs |

## Flake resistance

- One private runtime + database per test: no shared state, safe to run on any
  worker; tests never depend on order.
- Event-driven waits only (`waitForResponse`, `expect.poll`, auto-waiting
  locators); no fixed sleeps. Partner-side updates are awaited through the
  product's own polling with explicit, bounded timeouts.
- Races that matter are made deterministic instead of left to timing (for
  example, the catalogue tests wait for the anonymous request to settle before
  signing in).
- Clock-dependent state (reset-link cooldown and expiry) is advanced by aging
  the stored row, never by sleeping or by a test-only server flag.
- Every browser request off the runtime origin is recorded (including redirect
  hops) and aborted; tests assert the list is empty.
- Selectors are ids, `data-testid`, and role + accessible name only, so the
  visual redesign cannot break them.
- Failures keep a trace and screenshot (`retain-on-failure`); the `e2e`
  workflow uploads `playwright-report` and `test-results` on every run.

## Running

```bash
npx playwright test tests/e2e/golden-        # the golden-path journeys
npm run test:e2e                             # the full suite (Linux CI is authoritative)
```
