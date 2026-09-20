# Randori Circle implemented decision log

Status: accepted through the current rolling release

Last reviewed: 2026-09-19

Scope: current rolling release and independently reviewed candidate increments

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
more than one pending version per fresh rehearsal, inspected fingerprint, and
approval.

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
imitate human traffic to, or evade controls on LeetCode. The legacy seed and
remote ingestion implementation, browser fallback questions, and import/paste
form are removed; the compatibility route returns only a manual external link,
while sync fails closed. Slow requests,
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
2. Configure a new independent `PASSWORD_RESET_ENCRYPTION_KEY`; subsequent changes follow the forward-only bounded ring in `docs/KEY_ROTATION.md`.
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
existing `circle_memberships(circle_id, user_id)` primary-key index before any
account join/filter. The first page fixes a maximum member ID through a reverse
index seek; subsequent pages use the encrypted maximum and advance by member ID
inside that snapshot without an aggregate scan. Mutable status, role, and display name are deliberately removed
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
Authorization failures are different from transient failures: any roster
401/403 immediately discards all retained rows and controls based on HTTP
status alone, without depending on potentially opaque response wording, then
resolves current circle membership again. That fail-closed signal takes
precedence over a newer successful roster response for the same initiating
authentication identity, while an old identity's delayed denial cannot clear a
new account's roster. A transient append failure preserves the loaded rows and
continuation for retry. A failed replacement load or search leaves an empty
error/retry state, preventing rows for an earlier query from appearing under
the requested one. Other delayed requests from an older render epoch are
invalidated and the new epoch may start its own load, preventing a stuck busy
state.

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

## ID-18: Keep chat indexes in the append-only migration manifest

Status: implemented as additive schema migration v10; production rollout remains
gated on issues #38 and #43.

**Decision.** Canonical chat access uses two migration-owned indexes:
`idx_pair_messages_room_cursor` on `(week_id,pair_group_id,id)` for newest-window,
incremental cursor, and room-cap reads, and `idx_pair_messages_sender_created` on
`(sender_id,created_at)` for the durable sender rolling window. Representative
real-SQLite plans must select the intended index and may not fall back to a full
`pair_messages` scan. The 10,000-message room cap and all API contracts remain
unchanged. Ordinary and admin request paths no longer create pair-message
indexes; only the checksummed migration runner may install these indexes.

The change is append-only and compatible with v9 application data. A managed v9
database can continue serving the existing queries before the protected v10
apply, albeit without the new planner guarantees. Production apply remains
blocked until the provider restore rehearsal in #38 and protected remote
migration workflow in #43 are operational and have produced same-commit evidence.

**Alternatives.** Keeping request-time `CREATE INDEX IF NOT EXISTS` is convenient
but hides schema mutation inside user traffic and bypasses review evidence. A
single `(pair_group_id,created_at)` index cannot isolate colliding group IDs by
week or efficiently advance an integer cursor. The existing expression-based
activity index serves recap ordering but does not provide the canonical `id`
cursor order. A wider covering index including message bodies would reduce table
lookups at the cost of duplicating sensitive, potentially large text and
increasing every write; it is deliberately rejected. Replacing the 10,000-row
cap with retention or deletion is a separate product and data-lifecycle change.

**Recovery.** There is no ledger down migration. During an index-specific
incident, an operator may take database administration exclusive and drop only
the two v10 indexes; rows and v9-compatible queries remain intact, but the schema
is intentionally non-ready until both exact `CREATE INDEX` operations are
reapplied. Do not edit or delete the v10 ledger row. If the incident involves
data or broader schema integrity, stop and use the rehearsed PITR process rather
than this index-only procedure. The exact commands, checks, and forward rollout
are recorded in `docs/CHAT_INDEX_MIGRATION.md`.
## ID-19: Rotate each credential purpose through a bounded versioned key ring

Status: implemented as a compatibility-first runtime increment with no schema
migration. ID-18 remains reserved for the chat-index migration.

### Decision

Email activation, password reset, invitation email, and provider-email
observations use four independent key rings. Each ring has one monotonically
versioned active key and at most three strictly descending prior keys; duplicate
versions, duplicate material, malformed keys, ambiguous ordering, downgrade,
and same-version substitution fail closed. Stateless central validation also
rejects material shared across any active or prior entries in different
purposes, including AES/HMAC reuse, while version sequences remain independent.
Existing production keys become
version 1. Credential readers accept legacy envelope v1 and envelope v2 while
the initial deployment continues writing v1 until its purpose-specific switch
is explicitly changed to 2.

Envelope v2 remains inside the existing `outbox_events.payload_json` contract,
so no schema migration or bulk rewrite is required. AES-256-GCM associated data
binds the credential purpose, envelope version, key version, and exact event
idempotency key. The clear envelope header contains only the version and a
one-way purpose-scoped key fingerprint. Active keys encrypt; bounded prior keys
decrypt. Unknown/retired keys, fingerprint mismatches, and future versions are
retryable so a safe configuration repair or compatible redeploy can recover the
event. A header fingerprint disagreement is also retryable because it can
represent configuration substitution; malformed structure and authenticated
ciphertext/tag/idempotency replay failures are terminal invalid data. A
well-formed v1 authentication failure remains
retryable because v1 cannot distinguish tampering from a temporarily missing
old key.

Handlers suppress authoritative inactive, expired, consumed, revoked, and
superseded work before decryption wherever stored hashes and send sequence make
that possible. Rotation metrics expose only aggregate version/status/readiness
counts. Keys, fingerprints, ciphertext, event identifiers, provider subjects,
tokens, and recipient addresses are excluded.

Aggregate rotation readiness is reserved for operator key-retirement decisions.
Request-path readiness validates schema plus complete, cross-purpose-isolated
configuration but never requires unrelated historical queue rows to be healthy;
the exact target envelope is still classified retryable or terminal when that
request actually consumes it.

Identity observations always use the active HMAC version. When the matching
prior key is present, the old digest distinguishes an unchanged-email rekey from
a genuine provider-email change; a genuine change remains audited even while
the row advances to the new key version. Without the prior key, the observation
uses a neutral rebaseline and emits only `provider_email_rekeyed`, never a false
change event. Stored versions above the active version and configured material
that disagrees with a stored fingerprint fail before any row or audit change.

The deployment and rollback contract is forward-only after v2 or a higher key
version is written. Operators may return one purpose's write switch to v1 while
retaining the same active/prior ring, but never lower the active version or
replace material at an existing version. Exact retirement gates and isolated
restore rehearsal steps are in `docs/KEY_ROTATION.md`.

### Alternatives considered

| Option | Advantage | Cost and rejection reason |
| --- | --- | --- |
| One shared key | Fewer settings | Couples four trust domains and expands compromise and rotation blast radius |
| Drain every queue before rotation | No reader key ring | Fails during urgent rotation, scheduler outage, or replayable dead letters |
| Bulk re-encrypt queued rows | Quickly normalizes versions | Handles plaintext in an administrative batch and races active delivery |
| Flush and reissue every credential | Simple compromise response | Disruptive and reserved for confirmed compromise, not routine rotation |
| External KMS envelope encryption | Strong centralized custody | Valuable later, but disproportionate to the current Vercel/Turso MVP |

## ID-20: Purge chat only through mapped, fenced, evidence-gated room jobs

Status: implemented as disabled-by-default migration v11 and protected tooling;
production deletion remains blocked on operational evidence. ID-19 records the
independently delivered key-rotation decision above.

**Decision.** Private-beta pair chat has a 90-day active-database retention
window. Expiry is strict and calculated from SQLite database time with
`julianday`, preserving legacy SQLite and RFC3339-offset chronology; exact-cutoff,
invalid, future, held, and unmapped rows remain. The 10,000-row room cap is
unchanged.

Migration v11 creates explicit room-to-tenant ownership, a generation-fenced
database kill switch, room-scoped jobs, tenant/room holds, count-only audit, and
a chronological planner index. New pairing publication writes ownership in the
same transaction. Legacy rooms require a protected, ambiguity-checked adoption;
membership or week-label inference is forbidden.

Each purge claim uses a database-time token lease and fixed cutoff. Every batch
atomically rechecks the environment/database switches, control generation,
scope mapping, evidence, and holds; it then selects and deletes no more than 100
exact IDs and commits counts plus a durable checkpoint. A source high-water ID
freezes the room snapshot covered by the accepted evidence, while purge
reselects the oldest remaining rows inside that snapshot rather than advancing
a destructive cursor. The requested room and high-water are bound before export
and must match both export and backup evidence; later writes and backfills
require a new evidence-gated run. Dry-run uses an independent, deletion-free
bounded scan. Successful batches
do not consume failure budget; retries,
dead-letter state, and explicit reason-coded replay remain visible without
content or identity telemetry.

Deletion requires a private export covering the cutoff to complete before a
provider backup covering the same cutoff completes. Backup copies keep their
provider lifecycle and are reconciled before a restore can serve traffic.
Production remains disabled until #38, #43, the export path and notice period,
staging destructive rehearsal, and production count-only dry run are complete.

**Alternatives.** Inferring a circle from current memberships or a reusable
week label is ambiguous and can cross tenants. A global timestamp delete is
simple but cannot prove room ownership or legal-hold exclusion. A last-ID purge
cursor can skip remaining old rows, so the evidence high-water is an upper
bound, not a progress cursor; only non-destructive dry-run advances a cursor.
Soft deletion retains content and does not satisfy the policy. Environment-only
disabling cannot fence a claimed worker across an off/on cycle, so the database
control generation is mandatory. Down migrations cannot restore deleted
content; rollback is disable, drain, forward-fix, or an isolated verified PITR
cutover.

## ID-21: Bind active-circle authority to the live session and fail closed elsewhere

Status: implemented behind `CIRCLE_MEMBERSHIP_ENABLED` and
`MULTI_CIRCLE_CONTROL_PLANE_ENABLED`; migration v12 is required before enablement.

**Decision.** An account may hold multiple active circle memberships, but every
multi-circle browser session must explicitly select one active circle before it
can read a roster or list/create/resend/revoke invitations. The authoritative
selection is stored by hashed live-session identifier in
`auth_session_circle_contexts`, not trusted from a client header. Selection is a
same-origin, versioned compare-and-swap write that rechecks the live session,
membership, role, and non-archived circle in one database transaction. Every
dependent request carries the selected version only as a stale-response fence;
the server resolves authorization from durable state again.

Single-circle accounts with no stored context retain their implicit context and
existing behavior. Removing one membership bumps any affected selected-session
generation; a preserved invalid selection requires explicit reselection even if
one circle remains, and all account sessions are revoked only when no active
membership remains. Migration v12 binds the context to the exact
`(session_hash,user_id)` pair, preserves the context tombstone across membership
removal, and restricts physical circle deletion while a tombstone exists,
preventing stale-version ABA. The browser clears private state before a switch,
reloads, and notifies sibling tabs after it commits.

Roster and invitation reads/writes are now scoped to the exact resolved circle.
Pairing, availability, chat, workspace, video, execution, and AI records do not
yet have complete tenant ownership, so only an exact single active primary
circle may enter those legacy paths. Multiple circles, a sole secondary circle,
and stale or ambiguous stored selections receive `409
circle_feature_unavailable`. This is a deliberate safety boundary until those
schemas carry canonical circle ownership.

**Alternatives.** A client-only circle ID or reusable header is easier but can
be stale or forged and cannot serialize concurrent tab changes. Storing one
account-wide selection makes independent sessions interfere. Continuing to use
the primary circle silently mixes data after secondary membership is admitted.
Inferring a circle from pairing rows is unsafe because those rows are not yet
fully tenant-owned. A database-backed session selection with optimistic version
fencing is additive, preserves the single-circle path, and supports application
rollback by disabling the feature flag while leaving harmless context rows.

## ID-22: Make provenance a versioned fail-closed catalogue dependency

Status: implemented for the bundled original catalogue; authorized source
adapters remain deferred.

**Decision.** Every shipped exercise version has exactly one record in the
versioned provenance manifest. The record binds a constrained source type,
author, concrete license or written-authorization evidence, attribution,
canonical SHA-256 content hash, bounded approval period, and takedown state.
CI validates the catalogue and manifest together. Every bounded runtime list,
detail, trusted lookup, and execution operation revalidates against current UTC
time, so a warm process cannot outlive the provenance approval window. Active
content with missing, malformed, duplicated, changed, unapproved, expired, or
revoked provenance cannot enter the runtime catalogue.

The manifest and JSON Schema are repository-owned. Canonical hashing sorts
object keys, preserves array order, covers all user-visible exercise content,
and excludes lifecycle metadata. An emergency command can revoke and retire one
exact `slug@version`; it preserves an existing retirement, is idempotent for the
same tracked event, refuses an ambiguous overwrite, holds a stale-recoverable
interprocess lock, anchors every controlled path beneath the real repository
`data/` directory, verifies pre-write digests, and writes revocation before
retirement so interruption is fail-closed. Retired content remains auditable and unreachable. Dormant
server-side generators may remain after an emergency data-only takedown, but
the active-record gate prevents listing, resolution, or execution.

The current source set is `original` only. Open sources are restricted to a
small reviewed SPDX allowlist; written authorization uses a controlled evidence
reference. Neither schema path enables an adapter or grants permission. Personal
LeetCode access, Premium cookies, copied problem text, human-like crawling, and
anti-bot evasion are outside the architecture and prohibited.

**Alternatives.** Free-form governance strings in each exercise are readable
but cannot prove content integrity, enforce expiry, or support a uniform rights
audit. Putting provenance only in a database introduces deployment drift and
makes local/CI builds unable to verify what they ship. Silently filtering bad
records keeps the process alive but can hide accidental catalogue loss; startup
failure gives an actionable release boundary. Deleting disputed records erases
audit history, while an automated restore command could republish content
without evidence review. A crawler would add legal, security, and reliability
risk without establishing redistribution rights.

**Recovery.** Do not bypass a provenance failure. Review the exact failing path
against the tracked evidence; correct metadata and re-review, or use the bounded
takedown command. Git history recovers accidental edits. A real takedown is
restored only by a reviewed content change with fresh approval and, when
semantics changed, a new exercise version.

## ID-23: Evolve the current shell without replacing product behavior

Status: implemented as the first accessible UI slice.

**Decision.** The current single-page shell remains the delivery surface while
its semantics, responsive layout, and truthful product language improve around
the existing authorization and lifecycle boundaries. Light and dark themes use
explicit semantic success, warning, danger, information, focus, and
control-boundary tokens with WCAG AA text contrast and 3:1 unfocused
form-control boundaries. The shell exposes a skip link and native header,
navigation, and main landmarks; view navigation and the account menu have
deterministic keyboard state; motion respects the operating-system preference;
and the account menu retains Account security as its first focus target
whenever the server capability makes it available.

The 320 px and 390 px layouts keep navigation horizontally operable and present
authentication as a bounded mobile sheet. The active-circle selector renders
required, ready, switching, and error states without changing the session-bound
selection protocol or its stale-response fences. Pairing progress exposes the
same server-derived boundary as a named progressbar. Visible copy describes
only current behavior: invitations are distinct from session links, reminders
are email-only, catalogue counts describe approved exercises currently
available, and external exercise or AI content remains authorization-gated.
Placeholder screen sharing and the static deployment-copy action are removed.

**Alternatives.** Merging the old UI branches would also restore obsolete auth
and pairing assumptions, including a menu that hides Account security and
controls that imply unsupported behavior. A framework rewrite could improve
component isolation but would widen this release far beyond the shell and put
the current auth, roster, retention, catalogue, and active-circle race handling
at risk. Static readiness badges were rejected because readiness is a runtime
property. Copy-only pseudo-status was rejected in favor of accessible state on
the real controls. A later component migration remains possible behind focused
tests once product behavior is stable.

## ID-24: Open only dated availability at the active-circle boundary

Status: implemented behind the independent, default-off
`MULTI_CIRCLE_AVAILABILITY_ENABLED` flag; ID-23 records the accessible shell.

**Decision.** Multi-circle accounts may read and update dated availability for
the circle selected by their live authenticated session. The client never
supplies a circle identifier to the availability endpoint. An explicit session
context requires the exact context-version header, while implicit compatibility
requires exactly one active, non-archived circle with no stored context.

GET is treated as a write because it can materialize a cycle. GET and POST both
revalidate the exact live session hash, account, active membership,
non-archived circle, and context generation inside each write-transaction
attempt before materialization or mutation. POST repeats that authority in its
final SQL predicate. Context or authority failures return no availability
state. Successful and same-context conflict responses echo the exact generation
so the browser can fence values, pending work, notices, and rollover timers by
account, circle, and context.

The existing circle-scoped v3 cycle and decision tables are sufficient; there
is no v13. Primary first use preserves the legacy account-value bridge. A
secondary circle's first cycle always uses `cycle_default`, and a pre-existing
secondary legacy bridge fails closed. All other pairing, history, schedule,
chat, execution, workspace, video, and AI routes retain the existing
`409 circle_feature_unavailable` boundary.

**Alternatives.** Enabling the whole weekly workflow was rejected because its
pairing, schedule, and collaboration records are not fully tenant-owned.
Keeping availability blocked was safe but withheld the highest-value operation
already backed by circle-scoped storage. Trusting a circle ID from the browser
would turn routing input into authority and permit stale or forged scope
selection. Adding v13 would create migration risk without strengthening the
existing composite scope keys. Reusing the global legacy account flag in a
secondary circle would leak a cross-circle default, so secondary first use is
explicitly independent.

**Rollout and recovery.** Keep the availability flag off until v12 and the
control plane are healthy, rehearse two-circle isolation and switch/removal
races in staging, then enable the availability flag independently. Roll back by
disabling only that flag. Existing scoped rows remain inert and the legacy
single-primary behavior resumes; no schema downgrade or data deletion is
required.

## ID-25: Gate invitation delivery explicitly and authorize the event's exact circle

Status: implemented as a no-migration hardening increment. ID-23 records the
accessible shell; ID-24 records active-circle availability.

**Decision.** Production owner-created invitation email is disabled unless
`INVITATION_EMAIL_DELIVERY_ENABLED` is exactly `true` and the existing
membership, canonical origin, Resend sender, and purpose-specific encryption
configuration are all valid. Provisioning a secret alone cannot activate a new
outbound mail flow. When the gate is disabled or configuration is incomplete,
invitation creation still commits and returns its single-use manual link, while
resend remains unavailable because the recipient and bearer credential were
not retained. The isolated development runtime keeps its provider-free local
capture path without requiring the production gate.

Dispatch and key-retirement readiness authorize the invitation's stored circle
rather than assuming that circle is primary. The event must still bind the
exact invitation, circle, actor, token hash, email hash, and sequence; the actor
must currently be a real active owner of that same unarchived circle. Revoked,
expired, consumed, rotated, archived-circle, former-owner, existing-member, and
duplicate work remains suppressed or unclaimable. This permits a valid
session-selected secondary-circle invitation created by the active-circle
control plane to be delivered without weakening its transaction-time context
fence or exposing the recipient or token.

**Alternatives.** Treating secret presence as enablement has fewer settings but
can unexpectedly start external delivery during configuration rollout. Keeping
the primary-circle predicate avoids changing the old worker but silently drops
legitimate secondary-circle invitations after active-circle selection was
introduced. Encoding session context in the asynchronous event would expire
before delivery and is unnecessary: immutable invitation/circle bindings plus
live owner and circle checks provide the durable authorization boundary.

**Operations.** Keep the gate false while provisioning and rotating secrets.
Enable it first in staging, exercise local-capture and owned-domain Resend
delivery/suppression, and only then enable it in production. Disabling the gate
stops both new invitation-email enqueueing and worker dispatch while preserving
manual invitation creation and queued encrypted events for a later safe resume.

## ID-26: Separate secondary-circle coordination from workspace authority

Status: implemented behind the independent, default-off
`SECONDARY_CIRCLE_COORDINATION_ENABLED` flag; migration v13 owns its storage,
while its original release required the complete managed ledger through v15.
Migration v15 does not add secondary-pairing storage; ID-33 advances current
runtime readiness to v16 for normalized secondary scheduling.

**Decision.** A selected secondary circle may publish and read one immutable
current-cycle pairing, but that assignment is coordination data only. Migration
v13 introduces a separate canonical publication, complete eligibility snapshot,
and group data plane keyed by exact circle scope and availability cycle. Every
child proves its publication, scope, circle, cycle, and eligible account through
restrictive composite foreign keys. The publication also proves its full cycle
descriptor, while each available eligibility row owns exactly one group/member
slot so unavailable or duplicate participant claims fail at the storage
boundary. The primary circle continues through the
legacy publication tables because those IDs authorize schedules, rooms, chat,
video, execution, and AI today.

Canonical groups call an unmatched odd member `is_solo`, require the second
member to be absent exactly for that state, and expose `solo:true` without a
fabricated partner. The legacy algorithm's internal `isAI` result is translated
only when writing the new boundary; the v13 model does not claim an AI partner.

Manual publication derives the circle from the live session and revalidates its
context generation, membership, owner role, archive state, database time,
roster, availability, and same-circle fairness history within each write
transaction attempt. Cron enumerates secondary circles deterministically under
a hard limit and gives each scope its own transaction. One failed scope is
counted while later admitted scopes continue, after which the cron returns an
aggregate retryable failure. Existing claims are immutable; pre-commit lock
conflicts may retry, but ambiguous commits do not. Secondary cycles always use
`cycle_default`, never the account-global legacy availability value. In the
original ID-26 rollout they did not enqueue pairing
email; ID-32 adds that behavior behind its separate, default-off flag and full
coordination dependency chain.

Secondary reads recheck the same live context and join partner identity only
through current active membership. Departed partners are redacted. The base
coordination response contains no internal legacy IDs, room, or schedule fields,
explicitly reports `workspace_available:false`, and is fenced in the browser by
account, opaque circle ID, and context version. The dedicated UI branch clears
room state and shows no schedule, chat, join, video, execution, or AI controls;
ID-33 later adds only schedule metadata and scheduling UI behind its own flag.

**Alternatives.** Reusing `pairing_weeks` was rejected because its global week
label and unowned children collide across circles and grant workspace access.
Rebuilding every legacy workspace table now would produce a cleaner final
model, but couples the useful weekly pairing milestone to a much larger data
migration. Dual-writing would create two authorities and ambiguous rollback.
Manual-only publication would avoid cron work but weaken the weekly habit.

**Rollout and recovery.** Follow Steps 2–5 of the central rollout in
`ACTIVE_CIRCLE_CONTEXT.md`: keep the feature and credential-consumer flags
false, apply managed v13, then v14, then v15 as separate protected migration
steps with fresh evidence and approval, adopt all four configured credential
purposes, then use a new rehearsal, status artifact, and approval to apply v16
separately. Verify exact runtime readiness through v16 before deploying the
v16-aware runtime with scheduling disabled. Only then canary one secondary
circle and verify bounded cron publication before enabling secondary
coordination more broadly. Keep its separate email flag false until the sender
passes a provider canary. Roll back only by disabling the flag. Preserve
canonical rows for audit and forward recovery; never copy them into legacy
workspace tables or weaken membership enforcement.

## ID-27: Export one accepted session locally with a stable private identity

Status: implemented as a client-only, no-migration increment.

**Decision.** The signed-in current-pair dashboard exposes **Add to calendar**
only for a canonical room whose current schedule contains a normalized accepted
UTC instant. A small pure module generates one RFC 5545 event in the browser and
downloads it through a temporary Blob URL. It uses UTC `DTSTART`, a fixed
60-minute `DTEND`, the current app room link, RFC text escaping and 75-octet line
folding. As a static import it omits iTIP `METHOD` and organizer semantics. The
event UID derives only from the canonical room and remains stable
when the accepted time changes, allowing a reschedule export to identify the
same logical session.

The formatter receives no account or partner object. The file contains no
name, email, invitation credential, authentication token, code, chat,
transcript, or workspace payload. Proposals, legacy free-text agreements,
cleared schedules, malformed timestamps, noncanonical rooms, and stale
rendered actions fail closed. The action states that the duration is 60 minutes
and that the calendar application controls the downloaded copy. Randori cannot
revoke, update, expire, or delete a file after it crosses that retention
boundary.

**Alternatives.** Direct Google or Outlook links are convenient but
vendor-specific and disclose the event to a third party. Server-generated
calendar files create an unnecessary authenticated endpoint for deterministic
formatting. Provider OAuth and two-way calendar sync require broad permissions,
stored refresh tokens, provider-specific conflict resolution, and a larger
privacy review. Email reminders remain the durable provider-backed notification
path; this export makes accepted scheduling useful before production delivery
credentials are configured.

**Recovery.** There is no schema, server route, provider secret, or external
request to reverse. Roll back the client assets normally. Already downloaded
copies remain under each member's calendar retention and sharing controls.

## ID-28: Advance production schema by one explicitly approved version

Status: implemented in issue #134 as a protected migration-control hardening
increment; no application schema migration.

**Decision.** A production apply names exactly one `target_version`, and that
target must be the immediate successor of both the signed rehearsal's source
version and the live managed database version. Status may report the complete
ordered backlog, but only its `nextVersion` is actionable. The apply runner
receives only the immutable executable-migration prefix ending at that target,
so later migrations present in the same repository commit cannot execute under
the approval.

The rehearsal attestation now binds the exact source migration-state
fingerprint in addition to source classification and version. Status and apply
recompute that source state against the protected database. After adoption or
apply changes the source, the old attestation fails closed; the next step needs
a fresh restore rehearsal, fresh status artifact, fresh expected fingerprint,
and separate protected approval. Unmanaged databases still require exact-prefix
adoption before any apply.

**Alternatives.** Applying every pending migration under one approval restores
service faster but lets a single authorization span independently reviewed
changes and widens rollback ambiguity. Reusing one rehearsal across sequential
applies proves only the original source, not the state created by the previous
mutation. Running historical workflow commits conflicts with the latest-main
guard, while manual SQL bypasses checksums, ledger ownership, transaction
fingerprints, and redacted audit evidence. An explicit one-step target with
fresh evidence preserves those controls while allowing an old production
database to catch up deliberately.

## ID-29: Create and select a secondary circle as one idempotent operation

Status: implemented behind the existing default-off
`MULTI_CIRCLE_CONTROL_PLANE_ENABLED` flag. Migration v14 owns its storage; this
release requires the central v15 credential-control adoption sequence followed
by a separately rehearsed and approved v16 apply, and exact managed readiness
through v16 before runtime promotion.

**Decision.** An authenticated user creates a secondary circle through
same-origin `POST /api/circles` with only an exact bounded name and an opaque
client-generated request ID. The server generates both public identity and a
non-name-derived private slug. One write transaction revalidates the exact live
session and account, checks the 10-active-owned-circle cap and the existing
100-active-membership read ceiling, creates the circle plus active owner
membership, records one `circle.created` audit, stores one durable creation
receipt, and advances that initiating session's selected-circle generation.

The receipt is keyed by account plus a domain-separated request digest and
binds the exact name fingerprint, initiating session hash, circle, audit, and
returned generation. Composite restrictive foreign keys bind it to the
creator's membership and the audit's circle. The session hash intentionally
has no foreign key because idempotency evidence must outlive normal session
pruning. A matching replay is checked before either cap and returns the same
result without reselecting, incrementing the context, or adding an audit. A
changed name or session, changed selection, inactive ownership, or archived
circle fails closed.

There is no mandatory per-circle settings singleton in the current schema.
Therefore the complete post-create row set is exactly circle identity, owner
membership, audit, receipt, and selected session context. Availability retains
its reviewed lazy `cycle_default` materialization. Creation is forbidden from
writing global rollout state, pairing/availability rows, notifications, or any
legacy workspace table, which preserves the coordination-only boundary.

The browser exposes creation even for a sole-primary owner. It retains one
request ID across retryable or ambiguous failures, clears private state before
the request, aborts superseded work, and fences the response by account,
authentication epoch, control-plane epoch, and baseline generation. A valid
result broadcasts only account plus generation and reloads canonical context.
Pre-commit lock conflicts retry with bounded backoff and full revalidation;
once commit starts, an error is ambiguous and is never retried internally.

**Alternatives.** Admin or SQL seeding does not make the product usable.
Client-supplied IDs or slugs weaken ownership and collision boundaries. Audit
dedupe alone cannot bind the exact name, session, and returned generation.
Creating without selecting adds an avoidable stale-context race. Eager default
availability or pairing rows conflict with the existing lazy-cycle contract.
Full secondary workspace creation remains deferred until its storage and
authorization paths are canonically circle-owned.

**Rollout and recovery.** Follow Steps 2–5 of the central rollout in
`ACTIVE_CIRCLE_CONTEXT.md`: keep feature and credential-consumer flags false,
apply each pending v13, v14, and v15 migration separately with a fresh protected
rehearsal and approval, and adopt all four configured credential purposes before
continuing. If an existing credential consumer cannot be disabled, hold
production promotion until that sequence finishes. Use a new rehearsal, status
artifact, and approval to apply v16 separately, verify exact readiness through
v16, and deploy with secondary scheduling disabled. Then canary create, replay,
cap, revocation, concurrency, cross-tab, and mobile flows in staging. Rollback
disables the flag and preserves every receipt, audit, membership, and context
generation; no schema downgrade or tenant-data deletion is required.

## ID-30: Treat legacy credential counts as a key-retirement blocker

Status: implemented as a runtime and operations-signal hardening increment with
no schema migration, secret change, or delivery-format change. ID-29 is the
secondary-circle creation decision immediately above.

**Decision.** Aggregate credential-rotation `ready` means no relevant material
is malformed, unavailable, ahead of configuration, or unattributable. It is a
necessary compatibility gate, not proof that every configured prior key is
unused: retiring one v2 key additionally requires that exact version's count to
be zero. Any actionable legacy-v1 envelope, or any v1 invitation envelope
retained for a possible resend, makes the aggregate signal false. The legacy
format authenticates its payload but carries no key version or fingerprint, so
a header-only aggregate cannot attribute it to one key. Delivery compatibility
is unchanged: the worker still tries the active and ordered prior keys, while
request paths remain independent of aggregate retirement health.

Terminal activation and password-reset events do not retain credentials.
Invitation events remain different because a delivered link can be resent;
their latest envelope stays relevant only while the invitation is live, unused,
unrevoked, owned by an active owner, and below the five-send limit. The existing
bounded, PII-free projection continues to expose only counts and versions.
Actionable and resend-retained invitation envelopes are selected by one database
statement so a pending-to-delivered transition cannot fall between snapshots.

**Alternatives.** Ignoring v1 because it lacks a key identifier creates a false
green retirement signal precisely when attribution is impossible. Disabling v1
delivery would strand credentials during the compatibility rollout. Decrypting
and rewriting every queued row expands plaintext handling, transaction races,
and rollback complexity. Conservatively waiting for v1 work to drain or cease
being resendable preserves compatibility and requires no data mutation.

## ID-31: Persist monotonic acceptance independently for each credential purpose

Status: implemented as additive migration v15 plus protected operator control.
ID-30 remains the aggregate compatibility and retirement rule immediately above.

**Decision.** Migration v15 seeds exactly four constrained, initially
uninitialized `credential_key_controls` rows: email activation, password reset,
invitation email, and identity-email observation. Each accepted row binds the
highest authorized key version to its purpose-scoped one-way fingerprint and a
monotonic compare-and-swap generation. Keys, plaintext credentials, provider
subjects, recipient addresses, and tokens remain outside the table and all
public status.

Adoption and advance are explicit operations in a protected, manual,
latest-`main` workflow. Health checks, production startup, requests, and workers
never mutate the controls. Exact retries are idempotent; stale concurrent
writers, lower versions, same-version replacement, or an advance ring that no
longer contains the accepted pair fail closed. The business-material scan and
control update share one write transaction. Adoption permits existing v1
compatibility, while normal advance requires aggregate compatibility readiness,
including zero actionable or retained legacy-v1 envelopes.

Global database readiness requires the exact four-row structural state but does
not require adoption. Only a configured purpose's capability, producer, or
active consumer requires that purpose's accepted version and fingerprint.
Inactive work is still suppressed from authoritative state before the control
or ciphertext is examined, and unrelated password login and product features
remain available. Queue drains and normal row deletion cannot erase the
independent accepted pair.

The local loopback runtime adopts its deterministic local keys after migration
and before serving requests. Production uses no automatic adoption. A v14
restore advances to four uninitialized controls; a stale v15 restore that is
behind current configuration reports `advance_required`. Both require explicit
protected re-authorization. Database-only state cannot remember a version
created after the restored snapshot, so absolute anti-rollback across old
backups remains an external KMS/control-plane responsibility.

Credential-control rollback is forward-only to a build that understands v15
and preserves every control and ledger row. Once v16 is applied, global exact
readiness also requires a v16-aware build; v15-only application rollback is not
permitted. The one accepted slot can require a short purpose-specific
maintenance interval during advance; a two-slot staged activation protocol is
the future option if zero-downtime rotation becomes necessary.

**Alternatives.** Inferring the highest version from business rows was rejected
because queues drain and observations are deleted. Environment-only floors were
rejected as weaker under restore and configuration rollback. Automatically
adopting on a production request or startup was rejected because it turns a
misconfiguration into durable authorization. An external KMS policy is the
strongest cross-restore option, but adds operational cost and does not remove
the application's need for purpose-scoped readiness and restore procedures.

## ID-32: Reuse pairing-email v2 for secondary dashboard notifications

Status: implemented as a default-off notification increment with no schema
migration and no secondary workspace capability.

**Decision.** `SECONDARY_CIRCLE_PAIRING_EMAIL_ENABLED` is effective only when
membership enforcement, multi-circle control, selected-circle availability,
and secondary coordination are all enabled. A newly claimed secondary
publication writes one `pairing.email.requested` v2 event for every snapshotted
paired, solo, or unavailable member inside the same transaction as the
publication. Replays and competing manual/cron claims write none. The compact
payload contains only publication, circle, user, and result-kind identifiers;
current addresses, circle names, and rendered content are never queued.

The v2 dispatcher resolves current recipient and circle data and revalidates
the exact publication/scope/circle/cycle descriptor, immutable eligibility and
group slot, active non-demo membership, archive state, active partner for a
paired result, and current email preference. Invalid or stale work suppresses
before provider access. Its sole link is the canonical dashboard origin, so an
email neither exposes nor creates a legacy room/workspace capability. Primary
v1 payload parsing and private-room delivery remain unchanged.

Both versions share the existing event type, stable provider idempotency,
leases, retry/dead-letter transitions, aggregate metrics, and the five-type
fair invocation budget. Rollback disables the new flag; pending v2 work then
suppresses while immutable publications and terminal outbox evidence remain.

**Alternatives.** A new event type would make rendering explicit but add a
sixth fairness lane, operational metric, and scheduler contract for the same
delivery channel. Storing addresses or circle names would simplify dispatch
but create stale PII and rename races. Linking to a generated room would cross
the reviewed coordination-only boundary. A post-commit fan-out job would avoid
publication changes but introduce a second claim/reconciliation protocol and
an interval where a durable publication has no durable intent. The selected
versioned event keeps v1 compatibility, uses transaction atomicity already
available in v13, and revalidates all mutable authority at delivery time.

## ID-33: Schedule a secondary pair without creating a workspace capability

Status: implemented behind default-off `SECONDARY_CIRCLE_SCHEDULING_ENABLED`;
managed migration v16 and the complete secondary-coordination flag chain are
required. Schedule email is a separately gated increment in ID-34.

**Decision.** Migration v16 adds one `circle_pair_schedules` row per exact
two-person v13 pairing group and normalized `circle_pair_schedule_proposals`
rows. Both repeat the publication, scope, circle, cycle, group, member-count,
two member IDs, and non-solo marker. Restrictive composite foreign keys bind
those values to the immutable publication and exact group; proposals also bind
back to the complete schedule ownership tuple. There are no cascades. Checks
require normalized UTC instants, opaque 64-hex schedule/proposal identifiers,
monotonic positive revisions, group-member proposers, and at most one schedule
and proposal instant per owned group.

`GET|POST /api/schedule` selects its mode from the live authenticated session.
For a selected secondary circle the client sends no circle, publication,
group, pair, or room identifier. The server derives the database-current
publication and caller's paired group. Every write transaction revalidates the
live revocable session, exact active-context generation, caller membership,
unarchived secondary circle, immutable current group, and both current partner
memberships before comparing the opaque content version and claiming the next
numeric revision. Propose, remove, accept, and clear are optimistic CAS writes;
a stale writer receives the latest safe projection. Vetted SQLite busy/lock
failures retry at most three times only before commit begins, repeating the
complete authority and scope read. No retry occurs once commit has started or
its outcome is ambiguous.

The public schedule ID is a stable domain-separated digest of the immutable
publication generation and group. It is never accepted as authorization. API
responses retain `coordination_only:true` and `workspace_available:false`, use
`self`/`partner` proposer labels instead of internal account IDs, and contain
no legacy room ID or workspace controls. Calendar export uses that opaque
identity for a stable UID and links only to `/?view=dashboard`. Primary-circle
request bodies, response fields, room links, storage, notifications, and
calendar behavior remain on their existing path. Secondary writes create no
legacy schedule/workspace row. ID-34 may atomically enqueue a versioned
dashboard-only notification when its separate flag is enabled.

**Alternatives.** Reusing `pair_schedules` would make an unscoped legacy group
ID a cross-tenant capability and couple secondary coordination to room state.
Creating a hidden legacy room solely for scheduling would silently authorize
chat, video, execution, and AI paths. A JSON proposal array would preserve the
old representation but weaken per-proposal ownership and foreign-key proof.
Client-supplied circle/group IDs were rejected because active session context
is the authority. Schedule email uses its own versioned payload, idempotency,
stale-recipient checks, provider rehearsal, and rollback gate in ID-34.

**Rollout and recovery.** Apply v16 alone through the protected one-version
workflow after v15: fresh restore rehearsal, fresh status fingerprint, explicit
approval, apply, and unchanged-data/readiness verification. Deploy with the
new flag false. In staging, enable the complete chain and canary proposal,
acceptance, removal, clear, stale CAS, circle switching, partner departure,
archive, calendar UID/link, and primary byte-compatibility. Production rollback
disables only `SECONDARY_CIRCLE_SCHEDULING_ENABLED`. Preserve v16 rows and the
ledger; do not downgrade or delete tenant data. Existing calendar downloads
remain controlled by each member's calendar application.

## ID-34: Reuse schedule-email v2 for secondary dashboard notifications

Status: implemented behind default-off
`SECONDARY_CIRCLE_SCHEDULE_EMAIL_ENABLED`; no migration after v16.

**Decision.** The successful secondary schedule CAS transaction writes
`schedule.email.requested` v2 intents before commit. Proposal and removal notify
the partner; acceptance, change, clear, and the delayed reminder notify both
members. Conflicts, rollbacks, ambiguous commits, and state-preserving actions
write none; those state-preserving actions also retain the current revision.
A real proposal/removal revision that preserves an agreement renews the two
reminder intents, so stale-revision suppression cannot erase the only future
reminder. The deterministic key contains only the stable schedule ID, revision,
kind, and recipient. The exact minimal payload carries opaque
schedule/proposal identities, revision, actor/recipient IDs, kind, template
version, and a domain-separated instant fingerprint where current state must
match a time. It contains no address, circle name, internal scope/group/room
identifier, raw instant, or rendered content.

Dispatch revalidates the exact v16 ownership tuple, uniquely current
publication, secondary unarchived circle, exact pair, both active non-demo
memberships, current revision and kind-specific state, preference/current
address, and non-elapsed instant. Recipient membership is independent of that
user's selected-circle session. Exact revision matching suppresses stale
A→B→A agreement/reminder work. Rendering uses current data and links only to
`/?view=dashboard`.

Primary schedule email remains byte-compatible v1. Both versions share the
same event type, leases, stable provider idempotency, retry/dead-letter policy,
retention, audit trail, aggregate metric, and existing five-type fair lane.
Rollback disables only the new flag: scheduling stays active, new v2 intents
stop, and pending v2 work suppresses before provider access. See
`SECONDARY_SCHEDULE_NOTIFICATIONS.md` for the recipient matrix and canary plan.

**Alternatives.** A sixth event type would duplicate a delivery channel and
weaken the existing fairness budget. Storing raw delivery data would preserve
stale PII. Synchronous send would couple the CAS to provider availability, and
post-commit fan-out would create an untracked durability gap. Mutable reminder
cancellation would add races and discard audit history. Reusing the immutable
v6 event with dispatch-time suppression keeps the increment migration-free and
operationally bounded.

## ID-35: Retire request-path authentication schema bootstrap

Status: implemented as a DDL-removal increment with no schema migration. ID-34
is reserved for the independently developed secondary-schedule notification
increment.

**Decision.** Authentication schema is created and changed only by the reviewed
migration workflow. A shared, read-only `ensureAuthReadiness` probe projects
every column used by ordinary authentication from `auth_accounts`, `users`,
`auth_rate_limits`, and `auth_sessions`. The probe is coalesced per concrete
database client, caches only a successful result, and evicts a rejected promise
so transient failures can recover. It executes no DDL or DML.

Signup, login, profile lookup, activation, password reset, recent-auth,
identity management, signed logout, and Google link/reauth/callback paths run
the core probe before business writes. Feature-specific readiness remains in
place for membership, provider identity, activation, reset, and identity
tables. The Google callback probes before exchanging its one-time provider
code. Missing or incompatible required columns therefore return the existing
generic temporary-unavailability response (or safe OAuth `db_error`) without a
schema repair, account write, session write, or provider call. Invitation APIs
retain their existing read-only membership and delivery probes; invitation-
backed account creation is covered by the authentication core probe.

All 18 `CREATE` and `ALTER` occurrences in `api/auth.js`, including the
`AUTH_SCHEMA_BOOTSTRAP_ENABLED` branch, are removed. The runtime-DDL allowlist
no longer contains `api/auth.js`; the remaining 104 occurrences are separate
AI, data, operations, and membership-initialization debt owned by issue #44.

**Alternatives.** Keeping a permanently false bootstrap flag retains an
unaudited emergency write path and makes a configuration mistake destructive.
Silently attempting DML and mapping missing-column errors to availability is
cheaper initially but can partially create an account before a later session
table failure. Running the complete 52-table schema inspector on every auth
request gives stronger global drift evidence but couples login availability to
unrelated product tables and adds unnecessary request latency. The scoped core
projection plus existing feature probes gives the smallest independently
shippable boundary while the deployment gate remains authoritative for exact
whole-database readiness.

**Rollout and recovery.** Do not promote this increment until issue #43 has
retained evidence that production is on the reviewed latest schema. Deploying
the code performs no data or schema mutation. If an auth contract is missing,
roll forward with the protected migration workflow; do not restore a runtime
bootstrap flag. Rollback to the preceding build changes only request behavior
and requires no database rollback, though it reintroduces the legacy DDL path
and is therefore an emergency compatibility action rather than normal repair.

## ID-36: Enforce the recovery-control contract in secret-free CI

Status: implemented as a local static gate; it produces no provider evidence
and changes no production resource or schedule.

**Decision.** The deployability job runs `check:backup-controls` with read-only
repository permission and no protected environment or secret. The gate reads
only the committed restore-rehearsal, watchdog, and deployability workflows. It
pins the reviewed trigger sets and cadences, fixed RPO/RTO, default-branch
fences, environment and concurrency boundary, bounded fail-closed cleanup and
alerts and their terminal command bodies, exact provider-identity environment
bindings and secret-bearing rehearsal/cleanup/monitor commands, immutable
actions, non-persistent checkout credentials, exact sanitized
artifact paths and retention, and the watchdog's read-only credential-free
isolation. Output is limited to fixed control descriptions and explicit
`providerNetworkRequired:false` and `externalMutation:false` claims.
The validator also pins each complete workflow byte stream by SHA-256, so an
unanticipated command, environment binding, checkout input, trigger, comment,
or formatting edit fails closed even if the semantic subset parser misses it.
An intentional workflow change must update the workflow, digest, focused
mutations, decision record, and runbook in the same reviewed increment.

Synthetic mutation tests prove that an unsafe trigger or permission, policy
drift, lost cleanup/alert gate, private artifact path, secret-bearing or
provider-dispatching watchdog, unpinned action, or credential-persisting
checkout fails closed. They do not call GitHub or Turso. A green result proves
only that code still expresses the reviewed policy; #38 still requires a real
isolated provider restore, and #51 remains open until current retained provider
evidence and alert ownership are operationally confirmed.

**Alternatives.** Re-running a provider restore on every pull request would
expose production authority to untrusted code and spend provider resources.
Relying only on review or scattered regular expressions had no single CI entry
point and allowed the workflow policy and runbook to drift independently.
Giving the watchdog provider credentials would couple detection to the system
it observes. The selected static gate is intentionally narrower than a YAML
policy engine, but it is deterministic, dependency-free, redacted, and covers
the exact two workflows that own this recovery control.

This check is defense in depth, not an immutable authorization boundary: a pull
request can edit the same deployability workflow that invokes it. Repository
administrators must add an organization-owned required workflow or equivalent
ruleset before treating this signal as tamper-resistant. That settings change
is tracked by issue #169 and is not performed by application code. Until then,
changes to the deployability workflow itself require explicit review. The
repository's rolling integration branch is currently named
`codex/issue-87-repository-deployability`; references to “rolling” in this
decision and runbook mean that exact branch.
