# Invitation claim binding and OAuth intent

Status: candidate protocol for issue #186

This protocol prevents an older invitation preparation or OAuth callback from
silently authorizing a newer browser flow. It is code-only: it adds no table,
column, provider setting, or production credential.

## Prepared invitation contract

`POST /api/invitations/prepare` accepts exactly one of these same-origin JSON
objects:

```json
{"token":"<43-character invitation token>"}
```

```json
{"binding":"<43-character prepared-flow binding>"}
```

A valid token response is:

```json
{"ok":true,"binding":"<43-character opaque binding>","expires_in_seconds":600}
```

The server generates the 256-bit binding. Only the raw binding is returned to
the page. The version-2 HttpOnly claim stores a domain-separated HMAC of that
binding alongside the invitation ID, circle ID, token HMAC, email HMAC, issued
time, and expiry. The claim has an exact ten-minute lifetime, uses only the
active application signing key, and rejects legacy v1, missing, extra, expired,
or malformed fields. Binding comparison is constant-time.

The claim cookie is `Secure` in hosted runtimes, `SameSite=Lax`, and scoped to
`/api`. That scope is required because both `/api/invitations/prepare` and the
`/api/auth/*` consumers must receive it. A binding refresh validates the exact
current claim and an unused, unrevoked, unexpired database invitation, returns
only the remaining signed lifetime, and never extends or replaces the cookie.

Failed, mismatched, and successful responses do not clear the current v2 invitation
cookie. A late response must not erase a newer successful preparation. The
short expiry and durable invitation consumption make an older claim inert;
pairing it with another tab's binding fails closed.

During the v1-to-v2 cutover, a successful token preparation also expires only
the legacy same-name cookie at its old, narrower `/api/auth` path before setting
v2 at `/api`. Failed responses never perform this cleanup, and the legacy-path
expiry cannot erase a v2 generation.

Password signup and activation resend submit `invite_binding`. Missing or
mismatched binding cannot create an account, activation, membership, session,
or email event. Hosted activation keeps its enumeration-safe accepted response
and timing policy. The isolated loopback-only local adapter keeps its explicit
error response and never becomes available remotely.

## Google intent and transaction contract

Ordinary sign-in is `GET /api/auth/google/start?purpose=login`. It ignores any
invitation cookie and can authenticate only an account already linked to the
returned Google issuer and subject. It never creates an account, claims an
invitation, or links by email.

Invitation enrollment is an explicit same-origin request:

```http
POST /api/auth/google/start
Content-Type: application/json

{"purpose":"invite","invite_binding":"<43-character binding>"}
```

The server requires the binding, matching version-2 claim, and a currently
live invitation before returning `{ "ok": true, "authorizationUrl": "…" }`.
The signed OAuth transaction records `invite:<binding-hmac>`, never the raw
binding. Other allowed intents
are `login`, `link:<user>:<session-hash>`, and
`reauth:<user>:<session-hash>`; there is no `register` intent.

Invite transactions use the exact purpose-scoped return path `/invite`, while
ordinary login continues to allow only `/` or a canonical pair-room path. A
provider cancellation or safe callback error therefore returns to invitation
recovery without downgrading the transaction to login intent. A successful
invite callback returns to `/`, where the authenticated dashboard loads; it
does not revisit a now-consumed invitation.

Each OAuth start creates one signed ten-minute transaction containing exact
state, PKCE verifier, nonce, canonical return path, purpose, and timestamps.
Its cookie name is derived from the state and its path is the callback route.
Concurrent tabs therefore hold independent transactions. A callback reads and,
after successful transaction validation, clears only its own state-derived
cookie. An unknown, stale, malformed, or mismatched callback clears nothing,
so callback A cannot destroy transaction B.

An invite callback must still match the current claim binding, provider email,
durable invitation, and exact intended account at consumption time. A fresh
invitation can add membership to an existing linked account. An invitation
already used by another account, a consumption race, or any mismatch issues no
session. Claim cookies are left to expire rather than being cleared in a
response whose arrival order the server cannot control.

## Invariants and deterministic checks

- A claim never contains the raw invitation token, email, or raw binding.
- Binding A plus claim B fails in either response order and does not clear B.
- Refresh cannot extend the ten-minute signed deadline.
- Legacy unbound claims and expired claims fail closed.
- Signup and activation resend preserve enumeration-safe public responses.
- Direct unknown-subject Google login with a stale invite claim performs no
  account, provider-identity, membership, invitation, or legacy-user write.
- Existing linked-account login and existing-member fresh-invite acceptance
  remain successful through their distinct purposes.
- A stale callback clears no transaction; callback A clears only A, leaving B
  independently valid.

## Rollout and recovery

Deploy server and the minimal compatible client together before any richer
invitation UI. Existing v1 prepared claims expire within ten minutes and are
intentionally rejected, so no database migration or dual-read window is
needed. Do not rotate the application JWT key as part of this rollout.

Monitor aggregate invitation-prepare failures, OAuth `invalid_state` and
`private_beta` results, and activation delivery health without logging tokens,
bindings, claims, email addresses, provider subjects, or OAuth transaction
contents. Rollback is an application rollback only; it requires no schema or
provider rollback, but re-enabling unbound claims would reopen the fixed-cookie
race and should be reserved for an emergency.

## Alternatives considered

| Option | Advantages | Costs and rejection reason |
| --- | --- | --- |
| Keep one fixed OAuth cookie set | Smallest patch | A stale callback can clear a newer tab's state, verifier, nonce, return path, and purpose. |
| Clear the invitation cookie on every failure or success | Appears to consume browser state | HTTP response order is not request order; an older response can erase a newer valid claim. |
| Put the raw invitation token in page or OAuth state | Fewer derived values | Exposes a reusable bearer credential to browser state, URLs, referrers, and diagnostics. |
| Store prepared flows in a new database table | Strong server-side revocation and tab isolation | Adds a migration and cleanup lifecycle when a ten-minute signed binding plus durable invitation state is sufficient. |
| Allow direct Google login to create by email or stale claim | Convenient first login | Enables implicit identity linking, enumeration, and cross-flow claims; explicit invite intent is the required enrollment boundary. |
| Accept v1 and v2 claims during rollout | Smoother in-flight compatibility | Preserves the unbound authorization gap. The ten-minute expiry makes a fail-closed cutover bounded. |
