# Randori Circle implemented decision log

Status: accepted through release head `b88dcbf`, plus candidate PR #96

Last reviewed: 2026-09-19

Scope: release branch through `b88dcbf3a97454f121f8c6149760a9ac87c27a41`,
plus the consolidated notification candidate PR #96

This log records decisions that govern the application being shipped now. The
[production architecture plan](PRODUCTION_ARCHITECTURE_PLAN.md) describes a
possible Next.js/PostgreSQL end state; it is not a description of the current
runtime. Detailed database procedures remain in
[database schema operations](DATABASE_SCHEMA_OPERATIONS.md), the
[backup/restore rehearsal](TURSO_BACKUP_RESTORE_REHEARSAL.md), and the
[production migration runbook](TURSO_PRODUCTION_MIGRATION.md).

## Delivery and migration order

The private-beta work is a linear, product-first stack. A child must be rebased
or merged after its parent; it must not be landed ahead of that parent.

| Order | Change | User or operational outcome | Schema dependency |
| --- | --- | --- | --- |
| 0 | [PR #86](https://github.com/festus14/randori-circle/pull/86), merged to `main` | Invitation-bound Google OIDC with stable provider identity | v4 `provider-scoped-identities` |
| 1 | [PR #88](https://github.com/festus14/randori-circle/pull/88), merged to `main` | Durable, revocable application sessions | v5 `durable-revocable-sessions` |
| 2 | [PR #70](https://github.com/festus14/randori-circle/pull/70), merged to `main` | Members can edit the explicitly dated upcoming cycle | Uses existing v3 cycle schema |
| 3 | [PR #75](https://github.com/festus14/randori-circle/pull/75), merged to `main` | Owner or cron publishes one immutable weekly pairing | Requires known v1-v5 ledger prefix |
| 4 | [PR #77](https://github.com/festus14/randori-circle/pull/77), merged to `main` | Dashboard renders only authoritative current-cycle state | No migration |
| 5 | [PR #85](https://github.com/festus14/randori-circle/pull/85), merged to `main` | Real-runtime coverage of signup, availability, publication, and revoked access | No migration |
| 6 | [PR #89](https://github.com/festus14/randori-circle/pull/89), merged to `main` | Transactional, retryable pairing notifications | v6 `durable-provider-neutral-outbox` |
| 7 | [PR #93](https://github.com/festus14/randori-circle/pull/93), candidate | Repository-owned deployability gate independent of preview quota | No migration |
| 8 | [PR #92](https://github.com/festus14/randori-circle/pull/92), candidate | Verified invitation-bound email/password activation | v7 `verified-email-activation` |
| 9 | [PR #97](https://github.com/festus14/randori-circle/pull/97), candidate | Enumeration-safe password recovery and reusable recent-authentication policy | v8 `password-reset-and-recent-auth` |
| 10 | [Issue #83](https://github.com/festus14/randori-circle/issues/83), candidate | Explicit Google/password linking and identity-conflict recovery | v9 `explicit-provider-linking` |
| 11 | [PR #96](https://github.com/festus14/randori-circle/pull/96), candidate | Durable invitation and schedule email with one fair five-type dispatcher | Reuses v6; preserves v8/v9 |

Migration order is append-only: v4 binds an account to an OIDC issuer and
subject, v5 makes every application JWT depend on a live hashed session row,
v6 adds the outbox and its audit history, and v7 adds pending verified-email
activation. Version v8 adds password-reset credentials and session-scoped
recent-authentication evidence. Version v9 adds hashed provider-email
observations and a redacted identity lifecycle audit. The protected production workflow applies no
more than one pending version per inspected fingerprint and approval.

## ID-01: Ship the useful weekly loop before a platform rewrite

**Decision.** Harden the existing Vercel SPA and Turso/libSQL API in complete,
reversible slices: invitation and authentication, cycle availability, immutable
pair publication, truthful UI, real-browser coverage, then durable delivery.
UI redesign, realtime CRDT editing, managed video, AI coaching, and broad
catalogue ingestion follow only after the weekly habit is usable and measured.

**Why.** This gets a small private circle from invitation to a real weekly pair
without waiting for a framework and database migration. Each slice has a user
outcome, tests, a scoped branch, and an independently mergeable PR.

**Alternatives.** A Next.js/Supabase rebuild gives stronger long-term structure
and RLS but delays the first useful release and creates a risky data/auth
cutover. A UI-first refresh improves perception quickly but does not repair
signup or weekly pairing. Both remain later options; neither precedes the core
loop.

## ID-02: Separate production and local identity adapters

**Decision.** Production enrollment uses verified Google OpenID Connect. The
temporary private-beta allowlist controls enrollment before membership cutover;
after cutover, a new account also requires an owner-issued, email-bound
invitation. The isolated loopback runtime instead offers invitation-bound
email/password signup so the complete product can be tested without Google
credentials. It cannot activate on Vercel, in production, against a remote
database, or through a non-loopback request. Existing password accounts may
sign in, but open production password signup remains disabled until email
verification, recovery, and safe account linking exist.

All successful adapters issue the same 12-hour application session. The JWT
contains a random identifier; `auth_sessions` stores only a domain-separated
SHA-256 hash. Private requests require a live, unexpired row. Logout can revoke
one session or all sessions, membership loss revokes active sessions on the
next authenticated request, and at most eight sessions remain active per
account. Legacy stateless JWTs fail closed after v5.

**Alternatives.** Open password signup is familiar but unsafe without verified
email and recovery. Supabase Auth or Clerk would provide those features and
session rotation but adds a migration and another authorization boundary. A
stateless JWT is simpler but cannot support immediate per-session revocation.

## ID-03: Make availability and pairing cycle-scoped and immutable

**Decision.** Availability belongs to an explicit tenant scope and London-time
weekly cycle, not a timeless account boolean. The client receives exact UTC
boundaries, a cycle digest, and an optimistic version; mutations use
compare-and-swap and close at the displayed cutoff.

Publication freezes the eligible membership and availability snapshot, applies
deterministic repeat-aware pairing, records source-tagged participants, creates
versioned notification events, and commits everything in one transaction. One
scope/cycle can be published only once. Owner and cron paths share the same
implementation; retries may repeat only known pre-commit lock conflicts, never
an ambiguous commit. Pair-room access is derived from the immutable participant
snapshot, so a revoked member and an unaudited legacy identity fail closed.

**Alternatives.** A global availability flag is easy but has no date, cutoff,
or concurrency contract. Recomputing pairs on each read is not auditable or
idempotent. Mutating an already published cycle would make notifications and
room authorization disagree; a later change must instead introduce an explicit
audited replacement model.

## ID-04: Dispatch notifications through a provider-neutral outbox

**Decision.** Pair publication and versioned `pairing.email.requested` events
commit atomically. A separate authenticated worker claims due events with a
token-bound expiring lease, renews the lease while sending, applies provider
timeouts and bounded retry/backoff, and finishes in delivered, suppressed, or
dead-letter state. Replay is administrator-only, reason-coded, audited, and
keeps the original provider idempotency key. Payloads and logs avoid secrets and
unnecessary personal data. Resend is the first adapter, not the domain model.

The weekly publisher and the outbox drain are separate schedules. Vercel Hobby
cannot provide the required five-minute drain, so production delivery requires
Vercel Pro cron or an authenticated external scheduler before email is enabled.

**Alternatives.** Sending email in the publication request loses work on timeout
and couples pair creation to provider health. A Resend-specific queue is faster
to write but makes retries and future channels provider-owned. Trigger.dev or
Inngest provide richer orchestration but add cost and another trust boundary;
they remain options when workflows outgrow the SQLite-backed relay.

## ID-05: Keep SQLite/Turso now, with migration discipline

**Decision.** Retain `@libsql/client` and Turso for the private beta because the
application and its existing data are SQLite-native. Schema evolution is
append-only and checksummed. Request-time DDL is frozen and new schema belongs
only in immutable migration plans. Readiness requires both the exact schema and
the complete known ledger; runtime requests fail closed rather than repairing
production.

Local mutation accepts only a validated absolute `file:` target and an exact
state fingerprint. Remote mutation is manual, serialized, and protected by a
same-commit PITR restore rehearsal, authenticated attestation, immutable Turso
database identity checks, a short-lived token, and a fresh fingerprint. There
are no automatic down migrations; the rehearsed PITR path is the rollback
asset.

**Alternatives.** PostgreSQL/Supabase brings RLS, richer concurrency, and managed
auth, but translating the current schema, queries, and operational controls is
a separate product migration. Request-time `CREATE`/`ALTER` is convenient but
creates races and unreviewed drift and is rejected for new work.

## ID-06: Use Linux Playwright as the authoritative browser gate

**Decision.** A host-specific macOS Chromium installation or launch failure
must not block browser verification. GitHub Actions installs the Playwright-
managed Chromium build with Linux dependencies on Ubuntu and runs the checked-
out candidate against a localhost server. This is the authoritative browser
result. Local macOS Playwright is a fast optional check; `npm run dev` remains
available for manual product testing.

**Alternatives.** Installing the matching Playwright browser locally gives the
fastest feedback when the host supports it. Running Playwright in a Linux
container gives closer CI parity but adds Docker setup and slower iteration.
Using the machine's Chrome avoids the bundled binary but introduces an
unpinned browser/version difference. Moving all tests to a hosted browser adds
cost and network dependence. Ubuntu CI provides the smallest reproducible
baseline while those options remain available for diagnosis.

## ID-07: Decouple merge safety from Vercel preview quota

**Context.** The required `Vercel` status currently fails with “Deployment rate
limited — retry in 24 hours.” This is an account quota failure, not evidence
that the candidate failed to build. Because the context is required on `main`,
it blocks normal and administrator merges even when repository CI and security
checks pass. [Issue #87](https://github.com/festus14/randori-circle/issues/87)
tracks the durable correction.

**Decision.** Never forge or overwrite the provider status. PR #93 implements a
repository-owned `deployability` check that fails closed on runtime, routing,
security-header, cron, and release-file drift without calling a deployment
provider. After it lands, a repository administrator must replace required
`Vercel` with required `deployability`, while retaining required `e2e` and
`GitGuardian Security Checks`. Preview deployment then remains visible but
advisory; the protected production deployment remains separate and observed.

| Option | Advantages | Costs and risks |
| --- | --- | --- |
| Increase the Vercel quota | Keeps live previews required; minimal workflow change | Recurring cost; provider outage or future quota can still block merges |
| Wait for the quota window | No policy change | Stops unrelated delivery and encourages large PR batches |
| Make previews advisory | Restores small, continuous merges; quota failure stays visible | Reviewers may lack a live preview |
| Require repository-owned build/config validation | Deterministic and tests the exact checkout | Does not prove Vercel successfully deployed it |
| Move hosting | Removes this quota dependency | Largest migration and operational cost |

CodeRabbit is also advisory: actionable findings are assessed and fixed or
documented, but the bot's availability is not a merge prerequisite.

## ID-08: Disable unapproved LeetCode ingestion

**Decision.** A Premium account does not grant permission to automate access or
redistribute protected content. Randori does not sign in to, crawl, scrape,
imitate human traffic to, or evade controls on LeetCode. The legacy seed is
excluded from the active catalogue, and runtime ingestion is disabled unless
written authorization and a reviewed source adapter exist. Slow requests,
random delays, robots compliance, or user initiation do not create permission.

The safe current sources are original Randori exercises, appropriately licensed
content, outbound source links, and user-authored notes. Any future authorized
adapter must identify itself, enforce source-specific budgets and `Retry-After`,
cache and deduplicate, record provenance and rights expiry, protect credentials,
and provide kill-switch and takedown paths. See the
[content policy](CONTENT_POLICY.md).

**Alternatives.** Stealth crawling exposes users and the product to account,
contract, copyright, and availability risk and is rejected. Official API or
written permission is acceptable. Expanding the original/licensed catalogue is
slower editorially but deployable now and legally controllable.

## ID-09: Keep quality gates measurable and independent

**Decision.** Every candidate runs on Node.js 24 and must pass production-
dependency audit, original-catalogue validation, runtime-DDL boundary, syntax
checks, migration rehearsal, unit tests with at least 52% line, branch, and
function coverage, and Ubuntu Playwright flows. The threshold deliberately
exceeds the requested 50% floor and applies across API, database, and operations
modules rather than only well-tested files. Failed browser runs retain trace,
screenshot, and report artifacts.

Feature work uses scoped branches and a linear PR stack. Required automated
tests and security checks block merging; advisory review findings are triaged
on technical merit. A green mock suite does not authorize a production database
migration or prove a provider rehearsal—the protected operational gates still
apply.

**Alternatives.** A single aggregate line-coverage number is easier to satisfy
but can hide untested branches and functions. Requiring every external review or
preview service increases assurance when available but lets third-party quota or
outages stop delivery. Manual-only testing is too difficult to reproduce and is
rejected.
## ID-10: Verify invitation-bound password activation before account creation

Status: implemented as the schema-v7 increment, stacked on the durable outbox.

### User flow

1. A circle owner creates an invitation and shares its single-use link.
2. The invitee prepares that invitation in the browser and chooses email/password signup.
3. Randori hashes the password, creates or rotates a pending activation, and atomically enqueues a verification email. It does not create an account or session yet.
4. The email opens `/verify#token=…`. The browser removes the fragment before posting the token to the verification endpoint, keeping it out of HTTP request URLs and referrers.
5. Verification atomically consumes the activation and invitation, creates the account and membership, appends audit evidence, persists a revocable session, and only then returns its HttpOnly cookie.

Pending, resend/retry, expired, already-used, revoked, unavailable, and success states are explicit in the UI. Signup and resend return the same generic accepted response whether the email, account, or invitation is eligible. Structurally invalid input and caller-wide rate limits remain visible errors because neither reveals account existence.

### Security decisions

- Verification tokens are 256-bit random values. Only a domain-separated HMAC is stored in `auth_email_activations`.
- The outbox contains an AES-256-GCM envelope rather than the bearer token. Production requires a separate 32-byte base64url `EMAIL_VERIFICATION_ENCRYPTION_KEY`; missing or unsafe configuration disables the capability.
- Production also requires membership enforcement, a canonical HTTPS `APP_URL`, and both Resend settings before the capability is advertised or entered; partial configuration fails closed without creating pending work.
- Tokens are single-use and expire after 30 minutes. A resend rotates the token, invalidating queued or delivered older links.
- Resends have a 60-second cooldown, a five-send lifetime cap per invitation, and the existing durable IP/email rate-limit buckets.
- Verification attempts have their own durable 20-attempt-per-15-minute IP bucket before any untrusted valid-looking token can open an activation transaction.
- The delivery worker rechecks activation, invitation, and primary-circle state immediately before sending. Revoked, consumed, expired, or rotated work is suppressed.
- Password hashing happens before eligibility is evaluated. Eligible, unknown, reused, and wrong-email requests receive the same `202` response shape, bounded crypto/transaction statement shape, and minimum response floor.
- Account creation, invitation consumption, membership creation, audit evidence, activation consumption, and session persistence share one database transaction. Any failure rolls back the complete activation.
- The local invitation adapter remains synchronous and isolated. Production can never use local or open signup paths.

### Alternatives considered

| Option | Advantages | Rejected tradeoffs |
|---|---|---|
| Create a disabled account before verification | Familiar account model | Leaves partially usable identities, complicates every login query, and violates the no-account-before-verification requirement. |
| Store the raw token in the outbox | Simplest worker | A database read exposes a live bearer credential. The encrypted envelope plus hashed lookup materially reduces that risk. |
| Send mail synchronously from signup | Immediate provider feedback | Couples account initiation to provider latency/failure and loses durable retry/idempotency. |
| Stateless signed verification link | No pending-token table | Cannot provide reliable single-use, revocation, resend rotation, or transaction-bound invitation consumption. |
| Reuse the short-lived invite claim as verification | Fewer credentials | It proves possession of the invitation link, not control of the invited mailbox. |

### Deployment order

1. Rehearse and apply migration v7 after the v6 outbox migration.
2. Configure `APP_URL`, `RESEND_API_KEY`, `RESEND_FROM`, and a new `EMAIL_VERIFICATION_ENCRYPTION_KEY`.
3. Ensure the authenticated outbox drain runs at least every five minutes.
4. Set `EMAIL_PASSWORD_ACTIVATION_ENABLED=true` only after readiness is green.

Keep the encryption key stable while pending activation events exist. Rotation requires a future multi-key decrypt window; replacing it immediately suppresses already queued mail.

## ID-11: Recover password accounts without turning email into implicit provider linking

Status: implemented as the schema-v8 increment, stacked on verified email activation.

### Decision

Existing password accounts may request recovery through a generic endpoint.
Randori always returns the same accepted response for an eligible account, an
unknown address, an inactive member, or a Google-only identity. A 256-bit
single-use token is delivered through the provider-neutral outbox in a URL
fragment. Only a domain-separated HMAC is stored in
`auth_password_resets`; the queued credential is protected by a dedicated
AES-256-GCM `PASSWORD_RESET_ENCRYPTION_KEY`.

Reset tokens expire after 30 minutes. Requests use durable IP and email
buckets, a 60-second resend cooldown, and a five-send active-token limit. Each
resend rotates the token, so older queued and delivered links become inert.
The delivery worker rechecks the current account email, password identity,
membership, token, and expiry immediately before sending. Google-only accounts
cannot acquire a password through recovery; provider linking remains a
separate, recent-authenticated operation.

Consuming a link hashes the replacement password before token lookup, then
changes the password, revokes every active session with `password_change`, and
marks the token used in one write transaction. No replacement session is
issued: the user signs in with the new password, establishing fresh proof of
the credential. Concurrent consumers converge on one success; expiry, replay,
and rotated tokens fail closed.

### Recent-authentication boundary

Recent authentication is durable evidence scoped to one live session, not an
age check on the JWT alone. `auth_recent_proofs` stores the session hash, user,
method, and database timestamp. Evidence is accepted for ten minutes and only
for `password` or `google` methods. Password login and explicit password
confirmation create password evidence. Google login creates Google evidence;
the dedicated reauthentication start path uses OIDC `max_age=0`, explicit
account selection, the initiating live session, and an exact provider-subject
match before issuing fresh evidence. The callback additionally requires the
signed ID-token `auth_time` claim to be no more than two minutes old (with a
60-second clock-skew allowance); a missing, stale, malformed, or future claim
fails closed. Normal Google sign-in remains compatible with providers that do
not return `auth_time`. Reset-link possession does not count as recent
authentication.

Future provider linking, email changes, password changes, and similarly
sensitive account mutations must call the shared `requireRecentAuth` boundary
immediately before their transactional mutation. Recovery itself is exempt
because it is the route back to a lost credential, but it revokes all sessions.

### Alternatives considered

| Option | Advantages | Costs and rejection reason |
|---|---|---|
| Signed stateless reset links | No reset table | Cannot reliably support one-time use, resend rotation, or immediate revocation. |
| Store raw reset tokens | Simplest delivery worker | A database or queue read becomes an account-takeover credential. |
| Treat any young session as recent auth | No extra table | Session creation time does not prove a recent credential challenge and cannot record the method. |
| Let email recovery add a password to Google-only accounts | Convenient fallback | Silently links identity providers and expands account-takeover impact; linking belongs in its own reviewed flow. |
| Issue a session immediately after reset | Faster return to the app | Treats reset-link possession as a full login and recent proof. Explicit sign-in is a clearer trust transition. |
| Managed authentication provider | Mature recovery and step-up flows | Requires an identity migration and new authorization boundary; remains a future architecture option. |

### Rollout

1. Rehearse and apply migration v8 only after managed v7 is verified.
2. Configure a new independent `PASSWORD_RESET_ENCRYPTION_KEY` and keep it stable while reset events remain queued.
3. Confirm the outbox worker schedule and Resend sender in production.
4. Enable `PASSWORD_RESET_ENABLED=true`, verify a real delivery and reset, then monitor aggregate outbox retry/dead-letter metrics. Roll back by disabling the flag; outstanding links stay unusable until the capability is restored.

## ID-12: Keep member lifecycle authority in transactional membership state

Status: implemented without a schema migration.

### Decision

Active membership and ownership are database state, not session claims. Owners
may list memberships in their own primary circle and change another scoped
membership between active and inactive. Members may leave their own circle.
Ownership transfer promotes one active member and demotes the acting owner in a
single write transaction.

The same transaction records audit evidence and, for deactivation or leave,
revokes all affected sessions with `membership_removed`. Conditional SQL
enforces the acting role, target identity and state, primary-circle boundary,
and existence of another active owner. This makes the last-owner guarantee hold
when concurrent writers race rather than relying on a preceding application
check. Cross-circle and absent targets share an opaque not-found response.

The existing role/status membership model, audit events, invitation status,
and session revocation columns cover this slice. Adding a migration would not
strengthen an invariant here and would conflict with the reserved v9 owner.
Existing invitation revocation is reused; invitation resend and delivery remain
with issue #95. The original lifecycle increment required a valid active owner
session and deliberately deferred step-up. ID-14 now supplies recent-auth
enforcement for ownership transfer and owner deactivation using the existing
recent-auth proof without changing this transaction model.

### Alternatives considered

| Option | Advantage | Cost and rejection reason |
|---|---|---|
| Delete memberships on removal | Smaller active dataset | Erases lifecycle state and prevents explicit reactivation |
| Put roles in JWTs | Avoids authorization reads | Leaves transferred or removed privileges valid until token expiry |
| Read owner count, then update | Simpler SQL | Exposes a time-of-check/time-of-use race between concurrent removals |
| Promote and demote in separate requests | Smaller mutations | Partial failure can leave ambiguous ownership |
| Give reactivated users a session | Faster return | Owner action is not fresh proof of the member's credential |
| Add a lifecycle migration | More custom fields | Existing durable schema represents the required states and audit trail |

The complete action matrix, race behavior, and intentionally deferred work are
documented in `docs/MEMBER_LIFECYCLE.md`.

## ID-13: Make provider linking explicit and account-preserving

Status: implemented as the schema-v9 increment, stacked on password recovery and recent authentication.

### Decision

An authenticated member manages sign-in methods from **Account security** only
after `IDENTITY_MANAGEMENT_ENABLED=true`. Production keeps the entry point and
mutation routes unavailable until v9 readiness is verified; the isolated local
runtime may show its provider-free account state without making an external
request.

Google linking starts with a same-origin POST and requires current recent-auth
evidence. The OAuth request has a dedicated link purpose, random state, PKCE,
nonce, `max_age=0`, and explicit account selection. Its callback requires a
signed, bounded `auth_time` and binds the result to the exact initiating user,
hashed live session, issuer, and provider subject. Email equality is never link
authority: a password account that has the same verified Google email still
receives a normal-login conflict until its signed-in owner explicitly links it.

Issuer plus subject remains the durable provider key. A subject already owned
by another account fails closed under both database uniqueness and a serialized
write decision. A known subject continues to reach its existing account if the
provider email changes; Randori neither creates another account nor rewrites
the account's canonical password-login email. Migration v9 stores only a
domain-separated HMAC of the observed provider email under the independent
`IDENTITY_EMAIL_HASH_KEY`, plus a bounded key version and one-way key
fingerprint, so a change can be shown
and audited without retaining another raw address. Key rotation increments the
version monotonically and deliberately re-baselines each identity with a distinct redacted
rekey event; the former key is not retained and the first observation after a
rotation is not misreported as an email change. Readiness compares against the
global maximum stored version. A stale instance with a lower version, or a
different key at the same version, fails closed without rewriting or auditing
newer state for either the current subject or a new one.

A Google-only member may add a password only after recent verified Google
control. Removing Google or password requires a live session plus recent auth,
and the transaction refuses to remove the final usable method. A successful
removal preserves the initiating session and revokes every other live session,
reducing the lifetime of stale authentication assumptions. Link, unlink,
conflict, denial, recovery, and provider-email-change events use bounded enums
and contain no provider subject, email, token, or session identifier.

### Alternatives considered

| Option | Advantages | Costs and rejection reason |
|---|---|---|
| Auto-link matching verified emails | Minimal user interaction | Email is mutable and is not the provider's stable identifier; silently merging accounts creates takeover and history-transfer risk. |
| Create a second account on every new subject | Simple provider callback | Splits membership and pairing history and gives no safe recovery path. |
| Replace the canonical email after a provider change | Keeps one displayed address | Breaks password-login expectations and lets a provider-side profile change silently rewrite an application credential identifier. |
| Allow recovery email to add a password to Google-only accounts | Convenient fallback | Turns mailbox access into implicit cross-provider linking; explicit recent Google control is the narrower boundary. |
| Allow removing the last method with a warning | Fewer server rules | Creates immediate lockout and leaves the UI responsible for a security invariant. |
| Store raw provider email in an audit table | Easier support investigation | Duplicates personal data indefinitely; keyed observations plus reason-coded events provide the required operational signal. |
| Move now to Clerk, Auth0, or Supabase Auth | Mature linking and recovery flows | Requires an account/session migration and a new authorization boundary; still viable when the private beta outgrows the current store. |

### Rollout and recovery

1. Leave `IDENTITY_MANAGEMENT_ENABLED=false`; ordinary Google login and reauthentication retain their v4 compatibility.
2. Rehearse and apply migration v9 only after managed v8 is verified, then require managed v9 with no pending migration or drift.
3. Configure a new independent 32-byte base64url `IDENTITY_EMAIL_HASH_KEY` with `IDENTITY_EMAIL_HASH_KEY_VERSION=1`; never reuse `JWT_SECRET` or invitation/recovery keys.
4. Deploy the candidate, confirm the capability remains hidden, and exercise ordinary password and Google login.
5. Enable `IDENTITY_MANAGEMENT_ENABLED=true`, verify same-email explicit recovery and both final-credential denials, then monitor only aggregate error/rate and redacted audit outcomes.
6. Roll back exposure by disabling the flag. The additive v9 tables may remain; existing credential mappings, accounts, memberships, sessions, and history are not moved by the feature. For a later hash-key rotation, change the key and monotonically increment its version together; a missing, malformed, or lower-than-stored version fails closed. Restore the current key/version before re-enabling after an application rollback.

There is no automatic down migration. If a uniqueness or integrity incident is
suspected, disable the capability, preserve audit evidence, inspect the exact
managed database, and use the rehearsed PITR procedure rather than attempting
an unreviewed reverse migration.

## ID-14: Step up only the ownership-changing lifecycle boundary

Status: implemented without a schema migration, stacked on provider linking
and member lifecycle.

### Decision

Ownership transfer and deactivation of another owner require the shared v8
recent-auth proof inside the same write transaction as the lifecycle mutation.
The proof is scoped to the initiating live session and expires after ten
minutes. Ordinary member deactivation/reactivation and self-leave do not add a
credential challenge because they do not transfer or remove administrative
authority.

Password confirmation reuses the same-origin, durably rate-limited endpoint.
Google confirmation forces account selection and a fresh signed `auth_time`;
the OAuth flow is additionally bound to the exact initiating session hash and
provider subject. Its start is a same-origin POST that returns a narrowly
validated provider URL, so authentication, rate-limit, or readiness failures
remain in the SPA and clear any pending lifecycle continuation. Lifecycle
dialog close/open transitions abort that request and advance a generation;
delayed responses can affect only the exact still-visible dialog mode that
started them. Lifecycle failure and no-change notices are sticky for the exact
signed-in actor and supersede both older and newly started same-account roster
loads; they clear on an account change. Routine roster success therefore cannot
conceal a security outcome, while successful ownership transfer still renders
the actor's new member state. Lifecycle
confirmation is intentionally independent of the
v9 identity-management feature flag, so credential management may remain dark
while an already-linked password or Google method is used for step-up. Missing
v8 readiness or an unavailable linked method fails closed.

The browser keeps only one redacted continuation in `sessionStorage`: action,
target member ID, actor ID, version, and creation time. It validates the actor
and ten-minute lifetime, consumes the object before retry, and never retries a
second time. Cancellation, provider error, expiry, account change, missing
capability, or malformed state clears the continuation without mutation. The
API remains authoritative, so editing storage or forging the OAuth success
query cannot create a recent proof. OAuth result handling uses a bounded retry
to wait for one authoritative authentication refresh to commit before showing
credential feedback or resuming a lifecycle action.

Successful changes retain the existing transactional, PII-free lifecycle audit
events. Credential material, provider subjects, OAuth values, and session
identifiers are never added to them. Both password and Google confirmation
starts have durable per-IP and per-account limits.

### Alternatives considered

| Option | Advantage | Cost and rejection reason |
| --- | --- | --- |
| Confirm every lifecycle action | One client rule | Adds needless friction to routine member administration |
| Treat a young JWT as fresh | No shared proof lookup | Does not establish that a credential was challenged recently |
| Persist pending actions server-side | Survives tabs and devices | Adds a new state machine and migration for a single same-tab OAuth continuation |
| Bind Google reauth only to user ID | Simpler purpose cookie | A second live session for the same account could replace the initiating session during callback |
| Navigate directly to a GET start route | Minimal client logic | A 401, 429, or 503 response can replace the application with raw JSON and strand the continuation |
| Couple confirmation to `IDENTITY_MANAGEMENT_ENABLED` | One rollout flag | Would make lifecycle controls unusable when v9 credential management is intentionally dark |
| Add per-action recent proofs | Strongest replay isolation | Current ten-minute session-scoped step-up is proportionate for private beta; the lifecycle transaction still rechecks target and role |

The action matrix, continuation contract, rollout independence, and explicit
limits are documented in `docs/LIFECYCLE_RECENT_AUTH.md`.

## ID-15: Use one fair delivery budget for every production email type

Status: implemented in candidate PR #96 without a schema migration.

### Decision

Pairing, schedule, invitation, verified-email activation, and password-reset
events share one ordered handler registry and one request-wide worker budget:
eight claims, a 45-second application deadline, and a five-second finalization
reserve. Each configured type receives one claim opportunity per fair round
before a saturated type can consume another slot. Password reset is registered
directly with its v8 handler; the cron route never invokes its older standalone
typed drain. The v8 and v9 migrations and the recent-authentication/provider-
linking behavior remain unchanged.

Schedule proposal delivery is also state-aware across event kinds. A newer
accepted or changed event for the exact proposed instant supersedes an
undelivered proposal to the same recipient. The immutable event remains in the
audit trail as `suppressed`; it is not deleted or rewritten. This covers both
propose-then-accept-before-drain and a newly proposed reschedule accepted before
the worker runs.

The checked-in scheduler may call only the repository default branch and reads
`APP_URL` plus `CRON_SECRET` from the protected `Production` environment.
Production activation still requires those settings, a default-branch
environment restriction, and a staging Resend rehearsal. SMS is not part of
issue #50 and is not required to ship this email path.
### Alternatives considered

| Option | Advantage | Cost and rejection reason |
| --- | --- | --- |
| Keep password reset as a sequential drain | Minimal integration work | Reintroduces an independent batch/timeout after the global budget and can overrun the request |
| Give each type a private scheduled route | Strong isolation | Multiplies schedules, secrets, monitoring, and concurrent functions at private-beta scale |
| Deliver a proposal even after its exact acceptance | Preserves every historical notification | Sends obsolete action-oriented mail after the recipient no longer needs to act |
| Delete superseded events | Keeps the queue visually smaller | Discards immutable operational history; terminal suppression preserves the audit contract |
| Add SMS to issue #50 | More channels at launch | Adds consent, verified-number, regional, quiet-hours, and STOP obligations outside the accepted email scope |

## ID-16: Monitor a recurring isolated backup restore, not production mutation

Status: implemented as an operations increment rebased after the recent-auth
lifecycle boundary; it adds no schema migration and preserves the v8/v9 order.

**Decision.** The protected backup/restore workflow runs every Monday at 03:17
UTC and remains manually dispatchable with the explicit disposable-only phrase.
It restores a current Turso PITR point into a uniquely named database, validates
integrity, foreign keys, schema, HMAC-bound row evidence, RPO/RTO, and migrations
there, then confirms deletion. It never applies a migration to production.

A final monitor authenticates the signed same-run evidence and independently
requires the cleanup artifact. A separate hourly, read-only GitHub watchdog
queries the authoritative scheduled-run and artifact records, then validates
the downloaded monitor projection. After a two-hour scheduling grace it requires
a run from the current Monday 03:17 UTC slot, so last week's success cannot hide
a drill that never started; it also detects a run that remained stuck, failed,
or aged out without relying on the rehearsal workflow to report its own absence.
An absolute 06:47 UTC deadline is derived from the expected slot, not run creation,
so a delayed unfinished run still alerts on the last hourly tick before four hours.
Its retained projection contains only timings,
code/evidence checksums, aggregate counts, fixed run identifiers, and cleanup
booleans. Missing, stale, malformed, failed, or unclean evidence produces a
fixed-category GitHub Actions error and a failed workflow. Repository operations
owns the control; database reliability is the immediate escalation for cleanup
or write-state failures. The target is a 30-minute RPO, 15-minute RTO, weekly
drill, immediate escalation of a missed run, and 30-day sanitized evidence
retention; disposable restores have no retention. Scheduled evidence cannot
authorize production migration, which still requires a fresh manual rehearsal.
The RPO and RTO values are fixed in both rehearsal and evidence consumers;
environment configuration cannot silently weaken either objective.

**Alternatives.** A metadata-only backup check is cheaper but does not prove
restorability. Reusing production as the restore target is unsafe. Retaining
restores simplifies inspection but increases sensitive-data exposure and cost.
Unsigned summaries cannot safely distinguish tampering from failure. An external
watchdog best isolates scheduler failure but adds another service and credential;
the separate production-credential-free GitHub watchdog is the smallest auditable increment,
with external monitoring retained as the upgrade when correlated Actions failure
is no longer acceptable.

## ID-17: Page owner rosters by an immutable, encrypted cursor

Status: implemented without a schema migration and integrated after the
provider-linking, recent-auth lifecycle, notification delivery, and backup
monitoring decisions.

### Decision

The owner-only member endpoint returns 50 members by default and accepts a
bounded maximum of 100. A request scans no more than 201 candidates through the
existing `circle_memberships(circle_id, user_id)` primary-key index. The first
page fixes a maximum member ID; subsequent pages advance by member ID inside
that snapshot. Mutable status, role, and display name are deliberately removed
from the ordering tuple, so lifecycle changes between page requests cannot
shift already traversed rows.

Continuation state is an AES-256-GCM envelope derived from `JWT_SECRET` with a
roster-specific domain. Its exact versioned payload binds the actor, circle,
snapshot, last member ID, and normalized search. Invalid, altered, cross-actor,
cross-circle, and search-reused cursors share a generic request error. Every
page rechecks current active ownership and the primary-circle boundary.

Display-name substring search runs only over each bounded, tenant-indexed
candidate window. It never queries or projects the account email field (a
user-controlled display name may itself contain email-like text). This means a
sparse search may yield zero matches and a continuation cursor; the accessible
UI explains that more results may remain and preserves earlier rows when a
later page fails. A per-request sequence and circle render epoch prevent an old
response from replacing a newer search or a changed identity.

Integration retains ID-14's identity-bound lifecycle notice state and PR110's
narrow sticky-failure/no-change behavior. Pagination and search responses may
update roster-only state after their request, epoch, and owner checks; successful
summaries and roster failures cannot overwrite a newer recent-auth,
mutation-failure, or no-change notice for that same actor. The notification and
backup implementations remain unchanged by the integration.

### Alternatives considered

| Option | Advantage | Cost and rejection reason |
|---|---|---|
| Offset pagination | Simple URL contract | Mutable rows shift offsets and deep pages become increasingly expensive |
| Active/owner/name cursor | Preserves the former visual ordering | Every lifecycle or profile change can move a row across page boundaries |
| Signed plaintext cursor | Stateless and tamper evident | Internal tenant/member IDs and the search value remain trivially decodable |
| Search the global account table first | Fast name-prefix index | Risks cross-circle existence signals and weakens tenant-first authorization |
| Scan until enough matches exist | Always fills a page when possible | Missing or rare terms create unbounded request work |
| Add a search table or FTS migration | Better fuzzy/ranked discovery | Unnecessary for the MVP substring search and adds synchronization/schema cost |

The cursor is intentionally invalidated by `JWT_SECRET` rotation. Search is
case-folded for the application locale but is not fuzzy, ranked, or
language-specific. Those are explicit future product choices, not hidden API
behavior.
