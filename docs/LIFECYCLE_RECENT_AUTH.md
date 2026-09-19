# Recent authentication for sensitive circle changes

Ownership transfer and deactivating another owner require recent control of a
credential. The policy is enforced by the API inside the same write transaction
as the membership change; the browser is only responsible for guiding the user
through confirmation and retrying the exact action once.

## Policy

| Action | Recent authentication required | Reason |
| --- | --- | --- |
| Transfer ownership | Yes | Changes the account that controls the circle |
| Deactivate another owner | Yes | Removes a peer with administrative authority and revokes their sessions |
| Deactivate or reactivate a non-owner member | No | An owner already has this routine membership authority |
| Leave the circle | No | A member may remove their own access without credential friction |
| Revoke an invitation | No | The invitation is unaccepted and the existing endpoint is already owner-scoped |

A password or Google proof is valid for ten minutes and is bound to one live
application session. Google reauthentication also binds the OAuth purpose to
the exact initiating session hash, state, PKCE verifier, nonce, provider
subject, and a fresh signed `auth_time`. Swapping to another session for the
same account fails before the provider code is exchanged. The browser starts
that flow with a same-origin POST and navigates only after validating the
returned Google authorization URL. A 401, rate limit, or readiness failure
therefore stays in the application and cancels the pending lifecycle action.
Closing or reopening the dialog aborts the request and advances a generation,
so a delayed response cannot navigate or mutate a newer dialog.
Lifecycle failure and no-change notices are sticky for the exact signed-in
actor. They advance their own generation, survive both older and newly started
same-account roster refreshes, and are cleared on an account change. This keeps
routine roster counts from replacing an explicit security outcome while a
successful ownership transfer can still render the actor's new member state.

The confirmation surface is available even while
`IDENTITY_MANAGEMENT_ENABLED=false`. Credential linking may remain dark while
lifecycle step-up is enabled; only the already-linked password/Google methods
are offered. Missing v8 readiness, a missing provider configuration, or an
unavailable credential fails closed without changing membership.

## Transaction and response boundaries

The lifecycle transaction acquires the owner write boundary before reading the
sensitive target. It then verifies the session-scoped proof and conditionally
changes the exact membership. Audit evidence and applicable session revocation
remain in that transaction. A missing or stale proof returns only
`recent_auth_required`; cross-circle and missing targets continue to share the
existing opaque not-found result once authorization can be evaluated.

Successful transitions use the existing redacted membership audit events. No
password, provider subject, OAuth value, session token/hash, or continuation is
written to those records. Password and Google confirmation attempts share
durable per-IP and per-account limits of ten attempts per 15-minute bucket.

## Browser continuation

The browser stores one pending object in `sessionStorage`:

```json
{"v":1,"action":"transfer","member_id":2,"actor_id":1,"created_at":1789812000000}
```

It contains no email, display name, credential, or provider identifier. The
object is accepted only for the two sensitive actions, the exact signed-in
actor, a positive target ID, and at most ten minutes. It is consumed before the
single retry. Cancellation, OAuth error, expiry, account change, unavailable
method, or malformed state clears it and performs no mutation. A forged success
query cannot bypass the server-side proof check. OAuth result handling retries
the startup identity read a bounded number of times until one read commits;
credential-management feedback or lifecycle resume never runs against an
auth-refresh result that another startup request discarded.

## Alternatives considered

| Option | Advantage | Why it was not selected |
| --- | --- | --- |
| Require confirmation for every member action | Simpler client rule | Adds friction to routine deactivation/reactivation without reducing the ownership threat |
| Trust only session issue time | No proof table or confirmation endpoint | A young session is not evidence that a credential was just challenged |
| Keep a pending action in a cookie or database | Survives more navigation patterns | Expands server state and can place target metadata in request traffic; same-tab OAuth already preserves `sessionStorage` |
| Retry repeatedly until confirmation succeeds | Less explicit error handling | Can loop, replay an action, or mutate after the user's intent has expired |
| Couple step-up to identity-management rollout | One capability switch | Lifecycle may ship before credential management and would otherwise become unusable |
| Navigate directly to a GET start endpoint | Minimal browser code | A start failure replaces the SPA with raw JSON and can strand the pending action |
| Add a lifecycle migration | Could persist challenge state | Existing v8 recent proofs and lifecycle tables already provide the required durable invariants |

## Explicit limits

- Recent proof is reusable for its ten-minute window within the same live
  session. This is intentional step-up semantics, not per-action signing.
- The continuation survives same-tab OAuth navigation only. Closing the tab or
  starting in another tab cancels the pending action.
- Successful lifecycle transitions are audited; rejected confirmation attempts
  are represented by bounded rate-limit state rather than a new security-event
  stream.
