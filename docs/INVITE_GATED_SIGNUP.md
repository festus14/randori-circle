# Prepared-invitation signup gate

Status: client increment for issue #185; depends on the server contract in
issue #186.

## Product contract

Production account creation is available only in the browser tab that prepared
a currently live invitation. A visitor without that state sees the disabled
**Use an invitation** action, guidance to open the original link or ask a circle
owner for a new invitation, and an unaffected **Sign in** path for an existing
member. The local-only `local_open` development mode remains able to create its
seed-compatible accounts without an invitation.

The URL fragment bearer is scrubbed before third-party scripts load and is sent
once to `POST /api/invitations/prepare`. A successful response supplies an
opaque, non-identifying `binding` and a bounded `expires_in_seconds`. The raw
bearer is never placed in DOM text, query strings, local storage, session
storage, logs, or OAuth navigation. Only the opaque binding is retained in the
current tab's session storage so a reload of `/invite` can ask the server for
the remaining lifetime. Leaving `/invite`, a malformed refresh, expiry,
successful consumption, ordinary Google login, or an authoritative identity
change clears it.

Password signup, activation resend, and invite-purpose Google initiation carry
the exact live `invite_binding`. Ordinary Google sign-in uses the explicit
`login` purpose and cannot consume a stale invitation. The server remains the
authority: it binds the opaque value to the signed HttpOnly prepared claim and
rechecks the invitation and requested purpose. The client gate is defense in
depth and user guidance, not an authorization boundary.

## Race and lifetime model

Each successful prepare has one generation, opaque binding, and monotonic
deadline. The advertised lifetime must be an integer from 1 through 600
seconds; missing, fractional, overlong, or malformed values fail closed. Wall
clock changes cannot extend an already prepared invitation. The deadline starts
when preparation begins, so network and response-parsing time consume rather
than extend the server-advertised lifetime.

Every invite-bound operation captures all of the following before its first
await:

- the prepared-invitation generation, binding, and deadline;
- the authentication epoch and signed-in actor identity; and
- the authentication modal generation.

The operation rechecks that snapshot after every network await. Expiry, actor
change, modal close/reopen, mode switch, or replacement preparation aborts the
request and makes a late response inert. Signup, resend, and invite OAuth each
own their request identity and abort controller; a stale `finally` block cannot
clear the busy state of a newer request.

The browser may preserve a successfully prepared gate while the first
authoritative `/api/auth/me` response hydrates an existing session, but it keeps
every invite-bound control disabled until that response is a definitive `200`
or `401`. A delayed preparation that has already consumed its advertised
lifetime is rendered expired and its temporarily stored binding is removed.
If identity hydration remains unavailable after an invite OAuth error, the page
keeps the live invitation inert and offers only the separate explicit sign-in
entry point; an invite-purpose retry never silently becomes login-purpose.

An invited Google start returns to `/invite` after provider cancellation or
failure. The page refreshes the same tab binding with its remaining lifetime
before offering another invite-purpose attempt; it never silently turns that
retry into ordinary login. Generic password signup and resend `202` responses
use conditional copy because the server intentionally does not reveal whether
an account or activation was eligible.

Issue #186 is load-bearing for cross-document and shared-cookie ordering. Its
server-visible binding prevents an older overlapping prepare response from
turning a newer tab-local UI state into authority for the wrong HttpOnly claim.
The server must reject a binding/claim mismatch even if both invitations would
otherwise be valid.

## Rollout and rollback

Land #186 first, then rebase #185 on its exact reviewed head. Canary these paths
in a hosted preview before production promotion:

1. existing password and Google sign-in without an invitation;
2. valid Google and verified-password invitation signup;
3. cancel/reopen and resend while an invitation remains live;
4. expiry during delayed prepare, signup, resend, and Google-start requests;
5. overlapping invitations whose cookie responses arrive out of order; and
6. local `local_open` signup and invitation reload.

No schema, secret, or production-data change is part of #185. A client rollback
restores the previous presentation but weakens fail-closed guidance and race
fencing, so the preferred recovery is to disable production signup capability
at the server while rolling forward. Do not relax the #186 binding or explicit
OAuth-purpose checks.

## Alternatives considered

- **Trust only the prepared HttpOnly cookie.** Simple, but overlapping responses
  can replace one another invisibly and the UI cannot prove which invitation it
  is submitting. Rejected.
- **Store the invitation bearer in the browser.** This would survive reloads,
  but expands exposure to script, storage inspection, telemetry, and accidental
  URL propagation. Rejected.
- **Use only a wall-clock expiry.** Easy to implement, but a backwards clock
  adjustment can extend client eligibility. Rejected in favor of a monotonic
  deadline bounded by the server lifetime.
- **Hide every account-creation affordance.** Secure but gives invited users no
  recovery guidance. The disabled action plus explicit copy preserves the
  product path without implying that a generic 202 response created an account.
- **Combine ordinary login and invite OAuth.** Fewer routes, but a stale claim
  could make a direct login create or claim membership. Explicit purpose is the
  safer compatibility boundary.
