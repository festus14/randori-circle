# Randori Circle implemented decision log

Status: accepted through the current rolling release

Last reviewed: 2026-10-20

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
| 12 | [Issue #186](https://github.com/festus14/randori-circle/issues/186), candidate | Generation-bound invitation authorization and concurrent-safe OAuth intent | No migration |

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

**Decision.** Production enrollment uses verified Google OpenID Connect with
an owner-issued, email-bound invitation. The historical allowlist no longer
permits direct OAuth account creation; ordinary Google login is existing-account
only. The isolated loopback runtime instead offers invitation-bound
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
checks, migration rehearsal, unit tests meeting the measured line, branch, and
function coverage baseline (`docs/testing/COVERAGE_BASELINE.md`; target 80% on
every metric), and Ubuntu Playwright flows. Coverage is collected as raw V8
coverage and merged by c8 because Node 24's built-in merger attributes
`mock.module()` stand-ins to the real file. The gate applies across API,
database, and operations modules rather than only well-tested files. Failed browser runs retain trace,
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
(ID-75 later widened the grace to eight hours and the deadline to 12:47 UTC.)
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

## ID-37: Make legacy data-route readiness read-only and route-scoped

Status: implemented as a DDL-removal increment with no schema migration. It
follows the independently developed backup-control increment in ID-36.

**Decision.** The ordinary `api/data.js` routes no longer create, alter, or
index schema. Migration v1 remains the owner of the legacy account, profile,
pairing, run, and application-log structures. A shared readiness module uses
bounded `SELECT ... LIMIT 0` projections for the admin identity, profile,
circle, weeks, my-pair, history, statistics, run-history, and log contracts.
Each contract is coalesced per concrete database client. Only a successful
probe is cached; a rejected probe is evicted so a transient database failure
can recover without a process restart.

Routes check only the tables and columns needed before business writes. A
missing or incompatible contract returns that route's generic unavailable
response; server-side diagnostic logging remains best effort and cannot repair
its own table. The bundled question catalogue is file-backed and therefore has
no database-readiness dependency. `/api/init` is intentionally excluded from
this increment: its remaining schema and cleanup statements stay visible in
the runtime-DDL allowlist until a separate, atomic data-only conversion.

This removes 28 DDL statements from ordinary data request helpers and lowers
the reviewed `api/data.js` allowance from 73 to 45. The remaining 45 statements
are isolated in `/api/init`; the repository-wide debt falls from 104 to 76.

**Alternatives.** Running the complete schema inspector on every data request
would detect unrelated drift but couple profile, run, and logging availability
to every product table. Attempting the operation and translating SQLite errors
would reduce probes but could perform an earlier business write before a later
missing-column failure. Keeping local-only auto-creation would make local and
production behavior diverge and hide migration omissions. Route-scoped
read-only probes preserve fast, deterministic failure boundaries while the
whole-database deployment gate remains authoritative.

**Rollout and recovery.** Do not promote this increment until issue #43 has
retained evidence that production is on the reviewed latest schema. Deployment
performs no schema or data mutation. If a contract is unavailable, use the
protected migration workflow to roll forward. Reverting the application build
requires no database rollback but reintroduces request-time DDL and is only an
emergency compatibility action. The route matrix and verification commands are
recorded in `DATA_RUNTIME_DDL_RETIREMENT.md`.

## ID-38: Archive a target-explicit secondary circle as a soft authorization boundary

Status: implemented behind the existing multi-circle control-plane gate with
no schema migration. It follows the independently developed backup-control and
runtime data-DDL increments in IDs 36 and 37.

**Decision.** `DELETE /api/circles` carries the selected secondary circle's
public ID and context generation in an exact same-origin request. The ID keeps
an HTTP retry pinned to its original target after fallback; it never grants
access. A first archive requires the exact live selected context, active owner
membership, non-primary circle, and session-scoped recent-auth proof inside one
write transaction. A conditional update also proves that every active member
has another active membership in an unarchived circle. The transaction writes
one deterministic `circle.archived` audit and moves all stored contexts that
selected the target to a primary-first, then lowest-ID fallback, incrementing
each generation. An identical retry by any active retained owner validates the
fresh proof, archived marker, and audit before returning that caller's current
context without another write, so different-owner races converge after the
winning transaction moves both sessions. Bounded retries are limited to recognized pre-commit lock
conflicts; ambiguous commit results require the same target/version retry.

Archive sets only `circles.archived_at`. Memberships, invitations, creation
receipts, availability, immutable publications and eligibility, groups,
schedules and proposals, outbox rows, and earlier audits are retained. Existing
authorization and delivery preflights require an unarchived circle, so those
records become inaccessible through normal product paths and queued delivery
is suppressed when it has not already passed final provider preflight. The
browser resumes archive through the existing single recent-auth continuation,
then clears private/workspace state, broadcasts a forced context change, and
reloads. An unreadable or no-longer-usable post-commit fallback projection
returns a target-bound refresh-required result, so the browser performs the
same invalidation and reload instead of continuing to display the archived
workspace. Session loss invalidates pending auth refreshes, clears identity and
private state, and follows the normal signed-out route without another network
decision. That common cleanup cancels pending video work, closes the peer,
stops every retained local media track, and detaches both video elements without
an unauthorized signaling request. A video-session epoch fences delayed poll
and permission results from rebuilding state after cleanup. An older request
epoch cannot clear a newer same-account login.
As an ID-38 follow-up, the public catalogue may remember the selected exercise,
but rendering a question no longer implies authenticated code-tab navigation.
Only a signed-in path that actually makes the code view visible, or the existing
server-authorized room transition, persists code-tab restoration. A catalogue
response that completes after authoritative sign-out therefore cannot recreate
private navigation state or move the browser away from the signed-out view.
Owner/target loss, context conflict, ambiguous commit,
and transport loss clear private state before an authoritative context reload,
without presenting an uncertain archive as successful. There is no
public unarchive path; recovery is a separately reviewed
operator concern because retained memberships would become active again.

**Alternatives.** Archiving the server's current circle without an explicit
target was rejected because a replay could archive the newly selected fallback.
Hard deletion was rejected because it destroys evidence and conflicts with
restrictive immutable-data foreign keys. Leaving a bumped context pointing at
the archived circle was rejected because it creates avoidable selection errors.
Revoking all affected sessions was rejected because the every-member safety
check guarantees a usable fallback. A new receipt table and independent flag
were rejected because the once-per-circle audit key provides durable replay
evidence and the complete control-plane flag already dark-launches the route.

**Rollout and recovery.** Reach exact managed readiness through v16 using the
central protected sequence, deploy with `MULTI_CIRCLE_CONTROL_PLANE_ENABLED`
false, then canary owner/non-owner, recent-auth, primary/last-circle guards,
concurrency, fallback, stale-tab fencing, and retained historical rows in
staging. Rollback disables the control-plane flag and preserves every marker and
row; never clear `archived_at`, delete tenant history, or downgrade the schema.

## ID-39: Make admin initialization data-only and atomic

Status: implemented as a DDL-removal increment with no schema migration. It
follows the secondary-circle archive increment in ID-38.

**Decision.** `POST /api/init` no longer creates, alters, indexes, deduplicates,
or otherwise repairs schema. Migration v1 already owns the legacy tables,
columns, schedule uniqueness, and indexes previously repeated by the handler;
migration v2 owns the circle schema, circle indexes, Google-subject uniqueness,
and the rollout singleton. An exact current-schema and ledger inspection now
runs read-only inside the same write transaction as the data cutover.

After readiness succeeds, the transaction revalidates the live durable session
and current non-demo global-administrator authority. A pristine open rollout
creates one primary circle, backfills active membership for every current
non-demo account, writes deterministic per-account and completion audits, and
closes registration last. A valid completed rollout rolls the read-only
transaction back and returns the existing circle unchanged. Every failure
before commit rolls all four data-table changes back; an ambiguous commit is
not automatically replayed and is safe to inspect and retry.

The legacy `DELETE` that retained only `MAX(id)` from duplicate schedules is
removed. A managed current database already has both the inline and named v1
uniqueness contracts, so such duplicates are impossible without drift. An
unmanaged duplicate-bearing database must be remediated explicitly on a
verified restore before adoption. Adding a no-op v17 or silently discarding
schedule data would add risk without creating a valid upgrade path.

**Alternatives.** Keeping an admin-only schema repair endpoint would still let
HTTP traffic mutate production structure and would preserve a path that could
erase scheduling data. A route-scoped readiness probe would miss unrelated
ledger or schema drift during this one-time whole-application cutover. A series
of independent writes would allow a primary circle or closed latch to survive a
failed audit backfill. Full exact readiness and one explicit transaction are
acceptable here because initialization is rare and operationally controlled.

**Rollout and recovery.** Production must be migrated and rehearsed before this
code is promoted; the endpoint cannot advance or adopt schema. Keep membership
enforcement off, call the data-only endpoint as the authenticated bootstrap
administrator, verify the completed rollout, then enable enforcement. A generic
unavailable response requires inspection through the protected migration tools,
not repeated repair attempts. Detailed behavior is recorded in
`ADMIN_DATA_INITIALIZATION.md`.

## ID-40: Make notification-preference readiness read-only

Status: implemented as a DDL-removal increment with no schema migration.

**Decision.** Authenticated notification-preference GET, POST, and PUT paths
use a shared operations-readiness module to project exactly `user_id`,
`email_enabled`, `sms_enabled`, `phone`, `email`, and `updated_at` from
`user_notification_prefs` with `LIMIT 0`. Migration v1 remains the sole owner
of this table. The probe executes no DDL or DML, is coalesced per concrete
database client, caches only success, and evicts a rejected promise so a
transient failure can retry.

Origin and method rejection and authentication precede readiness. A missing
or stale contract returns the existing generic 503 before body normalization,
preference DML, or best-effort operational logging. Successful requests retain
their current defaults, POST/PUT normalization, fallback update behavior, and
response envelopes. Local and hosted requests now follow the same schema-
read-only path. Removing the one notification-preference `CREATE TABLE`
statement lowers the `api/ops.js` allowlist from 17 to 16 and total remaining
request-time DDL from 25 to 24.

**Alternatives.** Adding this contract to `_data-readiness.js` would blur the
ownership boundary between data and operations routes. Keeping the cache
inline in `ops.js` would make concurrency, retry, and per-client isolation
harder to test. A full schema fingerprint on every preferences request would
couple a small user setting to unrelated application tables. Keeping the
hosted `CREATE` while local mode probes would preserve environment-specific
behavior and hide missed migrations.

**Rollout and recovery.** Do not promote until issue #43 has retained evidence
that production is at the reviewed latest schema. Deployment performs no
schema or provider mutation. If the probe fails, stop promotion and roll
forward through the protected migration workflow; do not repair schema from an
HTTP request. Reverting the application build needs no database rollback but
reintroduces the retired DDL and is only an emergency compatibility action.
The exact contract and verification commands are recorded in
`NOTIFICATION_PREFERENCES_RUNTIME_DDL_RETIREMENT.md`.

## ID-41: Make AI readiness read-only and route-scoped

Status: implemented as a DDL-removal increment with no schema migration.

**Decision.** Ordinary analyze, feedback, history, and AI diagnostic-log paths
no longer create or repair schema. Migration v1 remains the sole owner of the
six AI tables, two app-log objects, and their constraints. A shared
`_ai-readiness.js` module now uses exact `SELECT ... LIMIT 0` projections for
analyze, feedback, history, and logging. Probes coalesce per concrete database
client and contract, cache only success, and evict rejected promises for retry.

Method, authentication, consent/input, and canonical-room validation run
before analyze readiness where no database contract is needed. Analyze proves
every record, consent, quota, usage, and reservation column before consent or
quota mutation, session persistence, or provider traffic. Read-only metadata
checks also prove the three primary keys used as `ON CONFLICT` targets.
Feedback and history
fail closed before their data access. Diagnostic logging has its own read-only
probe, reuses the request client, remains best effort, and cannot hide a valid primary result. The two
legacy reduced-column insert retries are removed so stale schema cannot accept
an ambiguous session or feedback shape. Existing authorization, consent,
quota, no-refund-after-provider, timeout/fallback, and response semantics are
preserved.

**Alternatives.** A global schema fingerprint on every request would couple AI
availability to unrelated tables and repeat deployment-gate work. Keeping
request-time repair would let ordinary traffic hide missed migrations. Making
app-log readiness part of analyze would turn an observability outage into a
product outage. Retaining reduced-column insert fallbacks would silently drop
evidence and timing data and make mixed-schema behavior non-deterministic.

**Rollout and recovery.** Production must be on the reviewed migration before
promotion; this increment performs no database or provider mutation. A primary
readiness failure returns a generic 503 and must be repaired with the protected
migration workflow. A logging-readiness failure affects diagnostics only. An
application rollback requires no database rollback, but reintroduces the eight
retired DDL statements and is reserved for emergency compatibility. Exact
contracts and verification are recorded in `AI_RUNTIME_DDL_RETIREMENT.md`.

## ID-42: Forbid runtime DDL and make admin operations readiness route-scoped

Status: implemented as the final DDL-removal increment with no schema migration.

**Decision.** Administrator promotion, demo seed, demo shuffle, and demo reset
no longer invoke the shared best-effort schema bootstrap. Migration v1 already
owns every affected account and legacy pairing table, column, and index. The
runtime-DDL allowlist is therefore empty, and CI rejects every direct, imported,
or assembled API/runtime schema mutation.

Each operation has a read-only readiness contract containing only the columns
it uses. Demo write contracts additionally inspect the primary and unique keys
that protect account identity, publication claims, pairing participants, and
week-label uniqueness. Contracts are coalesced per database client and route,
cache only successful probes, and evict failures for retry.

Promotion also checks the canonical account primary key and raw-email unique
constraint. Its case-insensitive compatibility lookup is bounded to two rows;
an ambiguous legacy case collision fails closed, and a successful promotion
updates only the resolved account ID. A new case-folded schema index would
change the migration contract and legacy data semantics, so it is not added by
this request-path DDL retirement.

Durable authentication and a live account read establish database or exact
configured-email administrator authority before any readiness probe or data
mutation. A non-admin performs no schema probe, DDL, or DML. The existing
configured-administrator synchronization occurs only after the selected route
is ready. Promotion input is validated before readiness and all business
writes. Authentication-database and readiness failures return a generic 503;
existing method, authentication, authorization, validation, success, demo-data,
and pairing-uniqueness semantics remain unchanged.

**Alternatives.** Full schema inspection on every request would detect unrelated
drift but couple small administrator actions to all product tables and add
avoidable latency. One shared superset probe would make promotion depend on the
demo pairing schema. Relying on write failures could leave partial data. Keeping
the bootstrap for administrators or local development would continue to hide
missed migrations and prevent an enforceable zero-DDL boundary.

**Rollout and recovery.** Promotion requires retained evidence that production
is on the reviewed migration through v16. This increment performs no database
or provider mutation. Missing readiness must be repaired by the protected
migration workflow, never by an HTTP request. Application rollback requires no
database rollback but reintroduces the retired schema writes and is reserved
for emergency compatibility. Exact contracts and tests are recorded in
`OPERATIONS_RUNTIME_DDL_RETIREMENT.md`.

## ID-43: Treat only scheduled outbox runs as freshness evidence

Status: implemented as a code-only operations increment with no migration or
production credential.

**Decision.** A separate hourly GitHub Actions watchdog assesses only initial
`schedule` attempts of `outbox-dispatch.yml` on the repository default branch.
It never treats `workflow_dispatch`, feature-branch activity, a human rerun, or
fresh `updated_at` metadata as proof that the five-minute scheduler is healthy.
The newest authoritative run wins, so an older success cannot hide a newer
failure, cancellation, or skip.

The schedule has a deterministic 15-minute grace aligned to five-minute UTC
slots. An in-progress run becomes stuck at the worker's exact two-minute job
deadline; queued work becomes stale only after the scheduling window. Fixed
non-sensitive outcomes distinguish healthy, grace, missing, stale, failed,
cancelled, skipped, stuck, manual-rerun, malformed-response, and GitHub-API
failure states.

Discovery constructs only the reviewed GitHub workflow-runs URL, validates the
same event and branch locally, scans at most two 100-run pages, caps response
size, and shares one monotonic ten-second API deadline. Its JSON projection
contains only fixed status values, bounded counts, run identifiers, and timing
metadata. The workflow has `actions: read` and `contents: read`, no production
environment or secret, and no application, workflow-dispatch, database, or
provider mutation.
The repository deployability contract binds reviewed digests for the workflow
and assessor and fails if either the watchdog boundary or the source worker's
two-minute timeout is weakened.

**Alternatives.** A redundant secret-bearing scheduler could improve
availability but duplicates privileged configuration and risks concurrent
delivery. Application health checks do not prove scheduler health. Manual runs
are useful for recovery but accepting them as freshness would conceal a broken
schedule. An unbounded history scan adds risk without changing the newest-run
decision. Terminal-event retention addresses storage rather than delivery
detection and remains separate work.

**Rollout and recovery.** Land only after rebasing onto the current rolling
release. No database or production configuration change is required. On alert,
inspect and repair `outbox-dispatch`, invoke its existing manual recovery if
needed, and require the next genuine scheduled success before declaring the
scheduler healthy. Rollback removes only the observer and never mutates or
invokes the production worker. The exact contract is documented in
`OUTBOX_DISPATCH_WATCHDOG.md`.

## ID-44: Bind invitation authority to one prepared generation and explicit OAuth intent

Status: candidate code-only authentication protocol; no schema migration.

**Decision.** Every invitation preparation creates a random, non-identifying
256-bit binding. The browser receives the raw 43-character base64url value;
the exact version-2 HttpOnly claim contains only its domain-separated HMAC plus
the existing hashed invitation fields and ten-minute deadline. Password
signup, activation resend, and Google invitation enrollment require the raw
binding and current claim to match in constant time. A same-tab refresh may
present the binding but receives only the remaining lifetime and never extends
the claim. Legacy or malformed claim versions fail closed.

Google enrollment is an explicit same-origin POST with purpose `invite` and
the binding. Ordinary Google sign-in is purpose `login`, ignores every invite
cookie, matches only an existing issuer/subject identity, and never creates or
claims an account. Link and reauthentication retain their explicit
session-bound purposes. Each start stores state, PKCE verifier, nonce, safe
return path, purpose, and expiry in one signed state-derived callback cookie.
A callback validates then clears only its own transaction; an unknown or stale
callback clears nothing. Invite cancellation returns to the purpose-scoped
`/invite` recovery path; ordinary login cannot select that return path. Invite
success returns to `/` and never reloads the consumed invitation.

The current v2 invitation cookie is not cleared on mismatch or success because HTTP
responses can arrive out of order. Its short expiry and the durable consumed
invitation row make old claims inert, while the page-held binding prevents a
claim from authorizing another preparation generation. Existing linked members
can consume a fresh matching invitation, including an invitation to another
allowed circle, but a used-by-other claim and every consumption race fail
without issuing a session. Public password responses remain enumeration-safe,
and the local password adapter remains isolated to the reviewed loopback
runtime.

The sole cutover exception is a successful prepare expiring the legacy v1
cookie at its old `/api/auth` path before setting v2 at `/api`. This targets a
different path, so it cannot erase a v2 generation; failures never send it.

**Alternatives.** One fixed OAuth cookie set is simpler but lets callback A
destroy transaction B. Clearing the invite cookie in responses appears tidy
but reintroduces the same ordering race. Database-backed prepared sessions add
revocation and cleanup schema that the ten-minute signed protocol does not yet
need. Putting the raw invitation token into page state or OAuth state exposes a
bearer credential. Dual-reading v1 preserves the unbound gap; the bounded
ten-minute cutover instead rejects it. Email-based Google creation or linking
is convenient but violates explicit identity and invitation intent.

**Rollout and recovery.** Ship server and compatible client together. In-flight
v1 claims expire in at most ten minutes; no migration, provider change, key
rotation, or production mutation is part of deployment. Monitor only aggregate
prepare, `invalid_state`, `private_beta`, and activation-delivery outcomes.
Never log bindings, claims, invitation tokens, email addresses, provider
subjects, or OAuth transaction contents. Rollback changes application code
only, but restoring unbound behavior reopens the race. The exact protocol,
invariants, tests, and operational guidance are in
[`AUTH_CLAIM_BINDING.md`](AUTH_CLAIM_BINDING.md).

## ID-45: Bind account-creation UI to one live prepared invitation

Status: accepted client increment; depends on the server binding and OAuth
purpose contract in issue #186.

**Decision.** Outside the isolated `local_open` runtime, the browser advertises
and submits account creation only while the current tab holds one exact live
prepared-invitation generation. Preparation returns an opaque, non-identifying
binding and a server-bounded lifetime no longer than ten minutes. The browser
keeps only that binding in session storage for `/invite` reload recovery and
uses a monotonic deadline anchored before the prepare request, so neither a
wall-clock change nor request latency can extend eligibility.
Raw invitation bearers remain fragment-only and are scrubbed before any
third-party script can run.

Password signup, activation resend, and invite-purpose Google start carry the
exact binding. Every operation is fenced by the invite generation and deadline,
authentication epoch and actor, modal generation, and its own abortable request
identity. Those values are rechecked after every network await, so expiry,
identity change, modal reuse, or a replacement preparation makes a delayed
response inert. Ordinary password/Google sign-in, OAuth result refresh, valid
local signup, and existing-member flows remain available independently.
Invite OAuth cancellation and failure return to `/invite`, refresh the same
binding, and preserve invite-purpose retry. Enumeration-safe signup and resend
successes remain conditional rather than claiming that mail was sent.
Initial session hydration preserves the prepared gate for an existing member,
but invite-bound controls stay disabled until `/api/auth/me` authoritatively
returns `200` or `401`; rejected or already-expired preparation clears the
tab-stored binding.
An invite OAuth error with unavailable identity hydration remains on the inert
invite landing without a provider retry, so only an explicit ordinary sign-in
can choose login purpose.

The client is not authorization. Issue #186 owns the signed HttpOnly claim,
binding comparison, explicit Google `login` versus `invite` purpose, and
transaction-time invitation validation. That contract is required before this
increment can land because browser-only generations cannot control shared
cookie ordering across overlapping documents or tabs.

**Alternatives.** Trusting only a prepared cookie leaves the UI unable to bind a
submit to the invitation the user saw. Retaining the bearer in browser storage
increases disclosure risk. A wall-clock timer can be extended by clock changes.
Hiding the entry point entirely removes useful recovery guidance. Conflating
Google login and invite creation lets stale ambient state change authentication
semantics. These alternatives are rejected in favor of opaque exact binding,
monotonic expiry, a disabled action with guidance, and explicit OAuth purpose.

**Rollout and recovery.** Rebase and land only after #186, then canary existing
sign-in, both invited signup methods, reload, expiry, modal reuse, and
out-of-order preparation. This increment changes no schema, secret, or
production data. If account creation must be stopped, disable its server
capability while rolling forward; do not weaken the server binding. The full
contract and test matrix are documented in `INVITE_GATED_SIGNUP.md`.

## ID-46: Quiesce bootstrap identity refreshes before the circle-switch race

Status: implemented as a test-only reliability increment with no production or
schema change.

**Decision.** The identity-refresh/circle-switch browser test observes all three
fixed bootstrap `/api/auth/me` requests and then awaits one explicit refresh
before it starts the gated switch race. The test continues to require the
identity-changing refresh to commit, the replacement circle data to render,
and the released old switch callback to remain fenced.

This keeps `refreshMe()`'s latest-request-wins production contract intact. A
bootstrap refresh may correctly supersede an older explicit refresh and cause
that older call to return `false`; treating that scheduler-dependent return as
a product failure made otherwise identical Linux runs flaky.

**Alternatives.** Removing the `true` assertion would avoid the immediate
failure but weaken proof that the intended identity transition committed.
Sleeping past 1.2 seconds would depend on wall-clock scheduling. Exposing a
production-only idle hook would widen the application surface solely for a
test. Changing refresh fencing so every caller returns success would obscure
which response actually committed and could revive stale identity state.

**Rollout and recovery.** This changes only Playwright orchestration and its
decision record. Revert it if the bootstrap schedule is replaced by a durable
application-ready signal, then synchronize the race through that public signal.

## ID-47: Evolve the existing shell through semantic, observable UI states

Status: candidate presentation and test increment; no protocol or schema
change.

**Decision.** Extend the #122 shell in place after invite-gated signup rather
than merging the superseded #91/#98 branches or beginning a framework rewrite.
Canonical semantic color aliases now own canvas, surface, text, control,
focus, information, success, warning, and danger roles; legacy names resolve
through those aliases during incremental migration. Primary controls identify
their stable view with `aria-controls`, each view identifies its label, and the
Account menu closes on Escape, Tab, outside pointer interaction, or window blur
without overriding the user's outside focus.

The 320, 390, and 640 px layouts keep the shell, invitation/auth surfaces,
active-circle selector, availability, and pairing content within the viewport.
Coarse pointers receive at least 44 px targets. Reduced-motion removes
nonessential timing, and forced-colors keeps control boundaries, focus, and
status distinctions visible.

UI copy follows observed state instead of implying product readiness. Public
stats expose loading, ready, or unavailable; browser-tab coordination reports
ready, local-only, or error and is not described as server persistence; email
preferences expose loading, ready, saving, saved, local-only, or error. A saved
preference is only a request for a future email and never claims provider
delivery. Reminder controls remain disabled until identity hydration resolves;
reads and writes accept only an explicit successful preference envelope bound
to the captured positive account ID, and each save revalidates that identity
before mutation. The dashboard's mail action is labelled as opening a draft.

The official `@axe-core/playwright` wrapper is exact-pinned at 4.13.0 as a
development-only dependency. Settled-state scans fail on every WCAG 2.0/2.1/2.2
A/AA-tagged violation with no excluded rules or nodes. `incomplete` findings
are retained as report attachments for manual review. Targeted tests remain
authoritative for focus, keyboard interaction, reflow, coarse pointers,
forced-colors, reduced motion, and asynchronous state transitions that axe
cannot validate. Linux CI stores the focused 390 px screenshots with the
Playwright artifacts.

**Alternatives.** Cherry-picking #91/#98 would revive stale auth and navigation
assumptions. A design-system or framework migration could improve long-term
composition but would make this usability slice too broad. Raw `axe-core`
saves roughly 47 KB unpacked but requires custom injection, typing, frame and
shadow handling, and diagnostics. Axe alone cannot prove focus order, reflow,
motion preferences, or truthful asynchronous copy. Static success badges and
optimistic delivery language are simpler but misrepresent unavailable
services. Blanket accessibility exclusions hide regressions and are rejected.

**Rollout and recovery.** Land as one three-commit presentation slice after the
invite-gated client. First canary anonymous invitation/sign-in, then signed-in
circle selection, weekly pairing, reminder preference, and account-menu flows
at desktop and narrow widths. No migration, secret, provider, or production
data change is required. Rollback reverts this presentation slice as a unit;
the #122 shell and #185 invitation fencing remain intact. If axe exposes an
uncertain `incomplete` result, inspect the attached evidence rather than
weakening the WCAG violation gate.

## ID-48: Separate routine availability fixtures from the production cutoff clock

Status: candidate test-only reliability increment with no production or schema
change.

**Decision.** Availability mutations retain both clocks that protect the cutoff:
the injected request instant selects a cycle and SQLite checks its own current
time in the conditional commit. Routine availability and active-circle mutation
tests use one named, explicit 2099 editable cycle so a historical fixture cannot
expire under SQLite while CI is running. The exact boundary suite instead uses
a narrow test database-clock adapter and proves a successful write one
millisecond before Sunday 08:00 Europe/London, rejection at the boundary, and
reclassification when the database clock crosses the cutoff after a request
starts. Pairing boundary tests retain their fixed BST, GMT, DST, and ISO-year
examples. Live local-onboarding and pairing browser tests continue to resolve
the server's actual upcoming cycle.

**Alternatives.** Trusting only the injected production clock would weaken the
commit-time race defense. Faking SQLite time for every test would stop routine
tests exercising the real SQL predicate. Deriving future dates from the day of
execution would vary cycle identities and expectations. Skipping assertions
after the cutoff would hide failures instead of making their preconditions
explicit.

**Rollout and recovery.** This increment changes tests and documentation only;
it needs no migration, environment variable, credential, deployment setting,
or rollback procedure. Revert it only together with an equivalent deterministic
clock strategy. The audit and commands are recorded in
[`AVAILABILITY_TEST_CLOCK.md`](AVAILABILITY_TEST_CLOCK.md).

## ID-49: Retain only an existing prepared binding across rate limiting

Status: accepted security and signup-recovery increment.

**Decision.** A `429` from prepared-invitation refresh is unevaluated: the
server applies its rate limit before checking the binding and does not revoke
the signed claim. The browser therefore retains the exact syntactically valid
binding that was already present in this tab only when storage still contains
that same value. The gate remains non-ready, and signup, resend, and invite
OAuth remain unavailable until a later `/invite` reload revalidates the binding
and receives a fresh bounded lifetime.

Raw invitation preparation never retains prior storage on `429`, and no value
from a rate-limited response is persisted. Evaluated invalid or mismatched
claims, malformed envelopes, non-429 errors, network failures, expiry,
identity changes, route changes, and stale generations clear or leave cleared
storage. Delayed responses cannot reactivate a completed invite route or
overwrite storage owned by a newer gate generation.

**Alternatives.** Clearing on every non-success response is simpler but turns a
temporary rate limit into permanent loss of the tab's only reload credential.
Persisting a response-provided value would let an unevaluated response replace
trusted state. Automatically retrying would consume more rate-limit budget and
create timer lifecycle work. Retaining only the exact pre-request value keeps
the recovery path narrow and explicit.

**Rollout and recovery.** Ship as an additive client patch with no schema,
secret, or production-data change. Canary a successful prepare, a rate-limited
reload, an inert cooldown state, and a successful reload after the cooldown.
Also verify raw-token `429` and delayed stale responses cannot write storage.
Rollback reverts this client-only retention exception; server-side claim,
expiry, and rate-limit enforcement remain authoritative.

## ID-50: Make weekly publication total and explicitly Sunday-bounded

Status: candidate code-only pairing reliability increment; no migration.

**Decision.** Authenticated cron publication is admitted only during the exact
half-open Sunday `[08:00, 10:00)` UTC window, classified by database time while
the existing `Europe/London` resolver continues to own the cycle boundary.
GMT, BST, both DST transition Sundays, weekdays, and exact endpoints are pinned
by tests. Primary reads also classify with database time in production; only
the already verified isolated loopback runtime retains its explicit test clock.

A valid primary-circle snapshot with zero available members now commits one
immutable cycle with zero participants and zero groups. Unavailable members
retain one versioned, idempotent durable outbox event each, owner and cron races
still converge on one generation, and the empty primary result no longer
prevents bounded secondary-circle processing. Current primary unavailable
reads require exact version-1 `pairing.email.requested` evidence in
`outbox_events`; they no longer consult the retired legacy queue. Weekly logs
contain aggregate counts only and omit request metadata, identities, scope IDs,
and cycle keys.

**Alternatives.** Rejecting emptiness leaves a cycle perpetually overdue.
Creating a placeholder participant violates identity and room authorization.
A new primary eligibility table would improve model symmetry but adds an
unnecessary migration while the durable outbox already records the unavailable
snapshot. Reading both queues indefinitely keeps obsolete storage in the live
truth path. A rolling two-hour interval after local cutoff is less explicit and
can admit unintended weekdays. These options are rejected for this increment.

**Rollout and recovery.** No schema, secret, provider, or production-data
change is required. Canary both UTC retry hours, an all-unavailable primary
cycle, secondary continuation, and the member unavailable response; monitor
the non-identifying aggregate completion log and existing outbox metrics.
Rollback is code-only, but committed empty cycles must never be deleted or
remixed; roll forward if an older reader cannot consume one. The complete
contract is documented in
[`PAIRING_PUBLICATION_TOTALITY.md`](PAIRING_PUBLICATION_TOTALITY.md).

## ID-51: Recover overdue weekly publication from authoritative server state

Status: candidate code-only MVP reliability increment; no migration.

**Decision.** Every successful current-cycle `/api/weeks` and `/api/my-pair`
response includes one authoritative-time `publication_state` envelope. Production
uses database time; the already verified isolated local runtime retains its
application-clock test seam. The envelope identifies
the tenant-scoped cycle and reports exactly `pending`, `overdue`, or `published`.
Owner recovery opens at the half-open boundary 30 absolute minutes after the
already resolved `Europe/London` cutoff. The server alone grants
`can_publish_now`; member responses do not carry that capability.

An owner publishes through the existing `POST /api/pairing/run` write path with
exactly `{expected_cycle_key}`. The write transaction revalidates the actor,
active circle and context generation, resolves database time and the current
cycle again, and rejects an early or changed cycle with stable `409` codes
before eligibility, history, publication, or outbox writes. A matching durable
publication is returned idempotently even if a replay arrives before the grace
boundary. Cron remains keyless, keeps its Sunday `[08:00, 10:00)` UTC admission,
and converges through the same unique publication claims and existing versioned
notification outbox.

The browser renders only a response matching its captured account, public
circle ID, context version, and cycle key. It never treats a POST response or a
cross-tab message as publication truth: success, stable conflict, and ambiguous
`503` all cause authoritative GET refetches. Cross-tab messages contain only
those identifiers. Owners keep a persistent Publish now or Retry action while
the server says recovery is available; members receive truthful delayed copy
without the control.

**Alternatives.** A new recovery table or job queue would duplicate the durable
publication claim and require a migration. Extending the UTC cron window would
not give owners an immediate, visible recovery path and would confuse UTC job
admission with the London business boundary. Client clocks, locally derived
roles, optimistic success, and trusting BroadcastChannel payload state all
weaken authority or race guarantees. A force/remix endpoint would violate
immutable pairings and notification idempotency. These options are rejected.

**Rollout and recovery.** Ship after the accessible shell, canary owner and
member states in both primary and secondary circles, and monitor aggregate
`pairing_recovery_completed` and `pairing_recovery_rejected` events alongside
existing cron and outbox metrics. GMT recovery begins at 08:30Z; BST recovery
begins at 07:30Z, independently of cron's UTC window. Rollback removes the UI
and keyed manual admission but must retain every already committed publication
and outbox event. No schema, secret, provider, or deployment migration is
required. The full contract is in
[`PAIRING_PUBLICATION_RECOVERY.md`](PAIRING_PUBLICATION_RECOVERY.md).

## ID-52: Derive first-run progress from authenticated product state

Status: candidate client-only onboarding integrity increment; no migration.

**Decision.** The setup checklist derives profile, active-circle availability,
current pairing, and optional workspace progress from their existing
authenticated authorities. Browser flags may dismiss the explanatory tour but
cannot complete or suppress the checklist. Profile reads and writes remain
independent of availability failures while carrying request, account, circle,
and context fences. Cycle-scoped state additionally binds the upcoming cycle;
pairing reuses the recovery parser and database `publication_state.observed_at`
instead of browser time. Errors remain unknown and expose inline retry states.
AI and video are omitted until a truthful readiness contract exists.

**Alternatives.** Local-storage or DOM heuristics cross accounts and cycles. A
new aggregate endpoint duplicates mature authorization paths and expands the
protocol. Persisted onboarding flags add schema and drift from product state.
Broad AI/video capability booleans would overstate provider, consent, quota,
media, and room readiness. These options are rejected for this increment.

**Rollout and recovery.** Ship after weekly publication recovery; canary fresh
and returning accounts, profile and availability failures, cycle rollover,
circle switches, published and unpublished assignments, and exact workspace
hydration. Rollback is code-only and does not alter user, cycle, pairing, or
workspace data. The full decision and verification plan is in
[`SERVER_AUTHORITATIVE_ONBOARDING.md`](SERVER_AUTHORITATIVE_ONBOARDING.md).

## ID-53: Make actionable schedules strictly future by database time

Status: candidate code-only scheduling reliability increment; no migration.

**Decision.** Primary and secondary proposal and acceptance paths resolve the
current schedule, optimistic version, selected proposal, and one validated UTC
database instant inside the write transaction. An instant must be strictly
later than database time; equality returns the stable
`schedule_instant_elapsed` error. Invalid or unavailable database time fails
closed. Rejection commits no schedule or outbox mutation, while stale CAS still
wins before temporal policy.

Elapsed stored proposals remain readable and removable. Elapsed agreements
remain readable as past and clearable; neither is automatically rewritten.
The dashboard supplies a local `datetime-local` minimum only as guidance,
labels expired/past state, retains drafts on an accessible inline error, and
refetches authoritative state. Delayed results are fenced by actor,
room/schedule identity, circle context, and cycle. Aggregate telemetry records
only primary/secondary plus `propose_elapsed` or `accept_elapsed`.

**Alternatives.** Client-only validation is bypassable and affected by clock
skew. Application-server time can disagree across instances and with the
transaction owner. A minimum lead time is a separate product policy. Automatic
deletion loses history, while relying only on dispatch suppression leaves users
with a misleading accepted session. These options are rejected.

**Rollout and recovery.** No schema, provider, or production-data change is
required. Canary equality, one-millisecond-future, boundary-crossing acceptance,
and elapsed-state recovery in both scopes. Rollback is code-only; existing rows
remain intact and dispatch-time elapsed suppression remains defense in depth.
The complete contract is in [`SCHEDULE_EXPIRY.md`](SCHEDULE_EXPIRY.md).

## ID-54: Activate the backup watchdog at a reviewed rehearsal slot

Status: candidate operations-control hardening; no provider or secret change.

**Decision.** The independent backup watchdog uses the immutable, schedule-aligned
activation epoch `2026-09-21T03:17:00.000Z`. Before that instant it emits a
sanitized, non-alerting but explicitly non-ready `setup_pending` artifact, with
the activation time and stable operator action but no invented `expectedAt` or
run identity. Both scheduled and manual watchdog runs use the same committed
constant.

At activation, earlier runs cannot count and missing evidence immediately
retains `run_missing`. Every later candidate and healthy result carries an
expected slot no earlier than activation; download verification rechecks the
activation/expected/run ordering. Existing stuck, failed, stale, missing,
expired, corrupt, and API alerts remain fail closed. Only a real scheduled run
with its exact independently validated healthy monitor artifact proves
readiness.

**Alternatives.** A fixed grace derived from first observation or deployment
slides on reruns. A repository variable can silently postpone an active control
outside code review. Inferring workflow history depends on retention,
pagination, and API availability. Calling bootstrap healthy overstates recovery
readiness. These options are rejected.

**Rollout and recovery.** This change mutates no schema, secret, environment, or
provider. Canary a pre-activation manual dispatch, then prove fail-closed
missing evidence and a real scheduled success at activation. After activation,
roll forward without moving the epoch. The complete contract and alternatives
are in [`BACKUP_WATCHDOG_ACTIVATION.md`](BACKUP_WATCHDOG_ACTIVATION.md).

## ID-55: Derive completed sessions from unanimous participant receipts

Status: candidate migration-backed private-beta measurement increment.

**Decision.** Migration 17 owns one confirmation receipt per exact week, pair
group, and authenticated participant. Reads and mutations reconstruct the
required human quorum from the existing source-tagged immutable pair snapshot;
AI assignments require their sole human and triads require all three humans.
The authenticated session supplies the actor. Canonical room IDs, database time,
serialized write transactions, and a server-keyed opaque compare-and-swap
version make confirm and pre-terminal withdraw operations idempotent and
race-safe without exposing individual receipt times. Composite storage
constraints plus migration-owned, schema-inspected guards bind each receipt to
an exact pair member, including NULL-safe pair-versus-triad shape, not merely
the week's participant roster. Receipts, group member/AI shape, and every
member's participant-source row become immutable after the first confirmation.
Once all required receipts exist, completion is terminal.

Responses contain only state, the viewer's confirmation boolean, aggregate
counts, an opaque version, and the shared completion timestamp. History and
recap label old rows without receipts “Completion not recorded.” Public and
personal session totals count only unanimous non-demo completion sets, while
pairing totals remain explicit separate facts. Secondary coordination-only
pairings remain unsupported.

**Alternatives.** Activity inference confuses product use with attendance. A
single participant finalizing a group is not trustworthy. A mutable group flag
duplicates receipt truth. Nullable composite foreign keys alone do not bind
pair-versus-triad shape in SQLite; a sentinel column would require changing the
pre-existing pair table, so migration-owned guards keep this increment additive.
Cancellation, no-show, disputes, provider sessions,
and content capture require broader policy or infrastructure and are deferred.

**Rollout and recovery.** Rehearse and apply additive migration 17 through the
existing protected one-version workflow, then canary pair, triad, AI, stale-CAS,
withdrawal, terminal, restart, history, recap, and stats paths. The runtime
fails completion-dependent reads closed until the table exists. Receipts retain
only identity binding and database time with pairing history. Demo reset
explicitly removes demo-week receipts before deleting participants. After v17
is applied, rollback keeps the manifest and table, disables affected UI/handlers
if necessary, and rolls forward; it never drops receipts or edits the ledger.
The complete contract is in [`SESSION_COMPLETION.md`](SESSION_COMPLETION.md).

## ID-56: Separate inherited availability from an explicit cycle decision

Status: candidate client/onboarding increment; no migration.

**Decision.** Keep default-included pairing compatibility, but label
`cycle_default` and `legacy_bridge` as inherited, unsaved state. Replace the
checkbox with explicit Available and Skip this cycle actions. Both actions use
the existing cycle-key/version CAS even when the submitted boolean equals the
effective inherited value; only a successful `source=user` response is shown as
saved or completes onboarding.

Profile, dashboard, checklist, and tour entry points share one navigation owner.
It refreshes the selected circle's upcoming cycle, then scrolls and focuses the
matching action only while account, auth generation, circle/context, navigation,
cycle, version, source, and value still match. Rollover, switch, sign-out, newer
navigation, stale conflict, and request failure remain fail-closed and
accessible.

**Alternatives.** Strict opt-in is clearer but can empty early circles before
reliable reminders exist. Keeping the checkbox or fixing only navigation leaves
the consent contradiction. Persisting on read creates hidden consent. Email
reminders and a broad redesign remain useful later but add operational or scope
risk without repairing this funnel. These options are deferred or rejected.

**Rollout and recovery.** Ship after session completion (#218), canary inherited
true/false confirmation, opt-out, rollover, stale responses, circle switching,
sign-out, and every navigation entry point. Rollback is code-only; decisions
already saved as `source=user` remain authoritative. The complete contract is in
[`EXPLICIT_CYCLE_AVAILABILITY.md`](EXPLICIT_CYCLE_AVAILABILITY.md).

## ID-57: Bridge reliable sessions with a private schedule-bound HTTPS link

Status: candidate migration-backed primary-session increment.

**Decision.** Migration 18 stores one private, provider-neutral HTTPS URL bound
to the canonical primary pair and its exact normalized accepted schedule
instant. Actor identity and access come only from the authenticated session and
the source-tagged pair snapshot. Set and clear use opaque meeting, schedule, and
completion compare-and-swap versions in one write transaction. A migration-owned
schedule trigger deletes the URL atomically on reschedule or agreement clearing,
including while a v17 binary is active; unanimous completion hides
it and makes mutations terminal. URLs are bounded, credential-free HTTPS and
are never fetched, previewed, logged, copied into recap/history, or sent through
notifications. The UI shows hostname plus an external-navigation warning and
uses `noopener noreferrer`.

**Alternatives.** LiveKit supplies integrated media but adds provider, secret,
cost, TURN, and SFU operations. Adding TURN retains custom signalling and
recovery. Chat links are buried and lack schedule lifecycle. Provider IDs lose
neutrality. Application-layer encryption is deferred until the product has a
managed envelope-key and recovery design; current access controls, retention,
and encrypted backups remain the boundary.

**Rollout and recovery.** Rehearse and apply additive migration 18 after v17,
then canary two browsers, concurrent edits, restart, reschedule/clear,
completion hiding, malformed URLs, and authorization isolation. Rollback keeps
the v18 schema and private rows, disables the handler/UI if needed, and rolls
forward. Full details are in
[`PRIVATE_MEETING_LINKS.md`](PRIVATE_MEETING_LINKS.md).

## ID-58: Persist pair roles and focus time as one database-clock aggregate

Status: candidate migration-backed primary-session increment.

**Decision.** Migration 19 owns one `pair_session_controls` row per exact
two-human primary pair. It binds both members, sources, the candidate, timer
state, remaining milliseconds at transition, database-time anchor, authenticated
actor, and monotonic revision. Migration-owned triggers invalidate the aggregate
if an older runtime changes pair membership or participant provenance. Reads derive remaining time from database UTC;
the browser animates locally and polls, so no countdown tick is persisted.
Start, pause, reset, and candidate assignment use an opaque HMAC compare-and-set
token which excludes derived display time. Idempotent repeats are no-write
successes and different concurrent commands return authoritative 409 state.
AI, triad, mixed-source, secondary, absent, and unauthorized rooms are the same
generic 404. Unanimous completion freezes the effective timer at its completion
instant and makes roles and timer read-only; expiry never implies completion.

**Alternatives.** Workspace v4 couples small controls to large code/board CAS.
Browser storage and BroadcastChannel are not durable or cross-device. A live
WebSocket/WebRTC/LiveKit connection may later notify clients but must not own
truth. Redis adds a provider and weaker recovery. Event history expands privacy
surface, while per-second persistence adds writes and races. These options are
rejected for this increment.

**Rollout and recovery.** Apply additive v19 after v18, then canary two-browser
convergence, simultaneous actions, expiry, completion, account/room/circle
fences, and process restart. Rollback retains the v19 table and ledger, disables
the route/UI, and rolls forward; it never imports old browser-local values or
drops data. Full details are in [`SESSION_CONTROLS.md`](SESSION_CONTROLS.md).

## ID-59: Keep session-control reconciliation non-blocking after hydration

Status: candidate client hotfix; no migration.

**Decision.** Initial session-control loading and user mutations remain blocking,
but a refresh of an already authoritative aggregate does not disable participant
roles or timer actions. A user mutation takes ownership of the request generation,
aborts any in-flight refresh, and submits the last confirmed opaque CAS version.
The existing identity, room, circle, cycle, completion, and request-generation
fences prevent a late or aborted read from replacing the mutation result. A
transient background-read failure retains the last confirmed aggregate and
retries on the bounded polling cadence.

**Alternatives.** Increasing browser-test timeouts or retrying CI hides the input
loss. Disabling polling loses cross-device convergence. Serializing user actions
behind a routine read makes focused controls inert during network latency. These
options are rejected in favour of responsive controls with the existing server
CAS as the concurrency authority.

**Rollout and recovery.** Canary keyboard and pointer activation while a poll is
delayed, then verify one write, stale-read fencing, two-browser convergence,
room/account fences, and terminal behavior. Rollback is code-only and restores
the prior blocking refresh; migration 19 and all durable aggregate rows remain
unchanged.

## ID-60: Broaden the executable catalogue with a bounded original pack

Status: reviewed content increment; no migration.

**Decision.** Add nine independently authored `slug@1` exercises in an even
Easy, Medium, and Hard split. The pack fills trees, two pointers, tries, heaps,
backtracking, and disjoint-set gaps while retaining every existing active and
retired identity. Each exercise ships JavaScript and Python starters, explicit
tie rules, eight deterministic-shape server-owned cases with randomized bounded
variants, an efficient oracle, and one-to-one original-content provenance with
a canonical hash and bounded review expiry. No third-party account, private
endpoint, copied wording, or derived test data is part of the design.

**Alternatives.** Premium-platform crawling is rejected on rights, terms,
privacy, availability, and provenance grounds. External links do not deliver
in-app execution. A bulk catalogue import is harder to review and roll back.
A smaller pack without Hard exercises leaves weekly progression incomplete.

**Rollout and recovery.** Ship through existing catalogue, provenance,
coverage, API-execution, and Linux browser gates; canary discovery plus one run
per language. No schema change is required. Rollback removes only the nine new
records, runtime definitions, and matching manifest entries while never
reassigning their versioned identities. Use the existing fail-closed takedown
path for a specific rights or correctness concern. Full selection, originality,
runtime, and recovery detail is in
[`CATALOGUE_PACK_V3.md`](CATALOGUE_PACK_V3.md).

## ID-61: Treat Turso's disallowed CHECK-constraint pragma as enforced

Status: production hotfix; no migration.

**Decision.** Turso's remote server rejects `PRAGMA ignore_check_constraints`
in both its read and `=ON`/`=OFF` forms with
`SQL_PARSE_ERROR: SQL not allowed statement: PRAGMA ignore_check_constraints`.
A remote client therefore cannot disable CHECK constraints, so that exact
rejection means enforcement is on. One shared helper,
`db/check-constraint-state.js`, now reads the state for schema inspection
(`db:status`, `/api/health` readiness, the migrator, and the restore
rehearsal) and for pairing publication readiness. It also performs the
`=OFF` step when a migration connection is prepared. Only a single row with
value 0, or that exact `SQL_PARSE_ERROR` rejection naming this pragma, counts
as enforced. Any other error, a missing row, or a non-zero value still fails
closed. Local file databases keep reading and setting the pragma directly.

**Alternatives.** Dropping the CHECK-state check would also hide a local
connection with enforcement disabled. Skipping it for every remote URL, or
treating any parse error as success, is broader than the observed behaviour.

**Rollout and recovery.** Deploy the code-only change, then confirm that
`npm run db:status` and `/api/health?probe=ready` report ready against
production. Rollback restores the previous fail-closed behaviour. That
behaviour keeps remote readiness unavailable.

## ID-62: Execute catalogue runs in an isolated, configurable provider

Status: candidate code-only increment; no migration.

**Context.** The public emkc.org Piston API became whitelist-only on
2026-02-15, so every production "Run" failed while CI stayed green because the
end-to-end suite replaced that endpoint.

**Decision.** `api/_execution.js` is the only execution boundary. It selects a
provider from `EXECUTION_PROVIDER` and fails closed when it is unset, unknown,
or misconfigured:

- `vercel-sandbox` (recommended for production) creates one Vercel Sandbox
  Firecracker microVM per run from the managed `vercel/sandbox/node:24` or
  `vercel/sandbox/python:3.14` image with 1 vCPU, `networkPolicy: 'deny-all'`,
  `persistent: false`, no environment variables, a 60-second session ceiling,
  and a 10-second command deadline. The microVM is deleted after every run. On
  Vercel the SDK authenticates with the project's OIDC token, so no additional
  account or secret is required.
- `piston` posts the same single-file envelope to a self-hosted
  Piston-compatible `https://` `EXECUTION_API_URL`, optionally with
  `EXECUTION_API_TOKEN` as a Bearer token. The retired emkc.org host is rejected
  even when configured explicitly.

The API process still only generates the harness, embeds inputs but never
expected outputs, reads at most 256 KiB of combined output, compares results with
its oracle, signs the attested run, and persists it. Provider configuration is
checked after authentication, validation, and pair authorization but before any
lease or quota write. An unavailable provider (unset configuration, SDK or
credential failure, sandbox quota exhausted, endpoint unreachable or non-2xx)
returns `503 {code: "execution_unavailable"}` and the editor shows that the code
was not run. Malformed or oversized provider output returns
`500 {code: "execution_failed"}`. A command that exceeds its deadline is killed
and recorded as a run whose unreported cases fail, matching the prior provider's
behaviour. The loopback `npm run dev` runtime clears all execution settings, so
local execution is explicitly unavailable.

**Alternatives.** Running submissions in the function process (even with
`node:vm` or restricted Python builtins) is not a security boundary and is
rejected. Self-hosted Piston needs a separately operated host with container
isolation, patching, and abuse controls; it remains a supported fallback through
the same abstraction. Judge0 CE / RapidAPI and similar hosted APIs need a new
account and API key and send code to another third party. E2B was the earlier
spike candidate but also needs a new account. Vercel Sandbox is generally
available and uses only the existing Vercel project.

**Limits.** The Vercel Hobby allowance is 5,000 sandbox creations, 5 active-CPU
hours, and 420 GB-hours of provisioned memory per month, with 10 concurrent
sandboxes. Memory is billed in one-minute minimum increments, so each 1-vCPU
(2 GB) run consumes about 0.033 GB-hours: the memory allowance supports roughly
12,000 runs and creations cap usage at 5,000 runs per month. When the allowance
is exhausted creation pauses, which surfaces as `execution_unavailable` rather
than a charge. The existing per-user lease and 10-runs-per-minute quota still
apply. Each run includes microVM start-up latency.

**Rollout and recovery.** Set `EXECUTION_PROVIDER=vercel-sandbox` for
Production, confirm OIDC federation is enabled for the project, deploy, then run
`npm run smoke:execution` with a token from `vercel env pull .env.local` and
complete one JavaScript and one Python run in the product. Rollback is to unset
`EXECUTION_PROVIDER`; runs then fail closed with the clear unavailable state and
no data changes.

## ID-63: Link Google with Randori recent auth, not a fresh Google `auth_time`

- **Status:** implemented.
- **Problem:** explicit Google linking required the signed ID token's
  `auth_time` to be at most two minutes old. On a device already signed in to
  Google, Google does not reliably force credential re-entry for `max_age=0`
  (and does not support `prompt=login`), so it returns the original sign-in
  time. Every production link attempt therefore failed with
  `identity_invalid` ("We could not verify that Google account").
- **Decision:** linking no longer checks Google `auth_time`. It still requires
  (1) Randori recent authentication for the exact initiating session, checked
  inside the link transaction; (2) a just-issued authorization code bound to
  this browser by state, PKCE and nonce; (3) explicit account selection; and
  (4) the existing session-binding, ownership-conflict and audit rules.
  Google step-up reauthentication (`reauth:`) keeps the fresh `auth_time`
  requirement because there Google is the recent-auth proof itself.
- **Verification:** `tests/unit/identity-linking-api.test.mjs` links with an
  old and a missing `auth_time`, and refuses a fresh Google token when Randori
  recent auth has expired.

## ID-64: Deliver auth and invitation email immediately after commit

Status: code-only increment for
[issue #250](https://github.com/festus14/randori-circle/issues/250); no
migration, no new secret.

**Context.** Email is written to the durable outbox in the same transaction as
its credential and is sent only when `/api/cron/outbox` runs. That worker is
triggered by the `outbox-dispatch` GitHub Actions schedule (`*/5`), which GitHub
throttled to one run every two to four hours. In production a password-reset
email sat `pending` for over an hour; a second request rotated the token, so the
only email the user eventually received was already invalid. A 30-minute reset
link, email verification, and invitations are unusable at that latency.

**Decision.** After the enqueue transaction commits, the request schedules one
bounded, best-effort delivery attempt for exactly the rows it wrote, using
`waitUntil` from `@vercel/functions` so it runs after the response:

- Paths: password-reset request, verified-signup activation and activation
  resend, owner invitation create and resend, and primary/secondary schedule
  notifications. Weekly pairing publication stays queue-only (bulk fan-out,
  [outbox invocation budget](OUTBOX_INVOCATION_BUDGET.md)) and is drained by the cron.
- `createOutboxEventStatement` records each statement's
  `{eventType, idempotencyKey}` out of band (`api/_outbox-identity.js`), so
  callers name the committed rows without changing the `{sql,args}` shape.
  `requestPasswordReset`, `requestEmailActivation`, and `resendEmailActivation`
  return those identities (`outboxEvents`) only when they actually queued mail;
  they never reach the client.
- `deliverOutboxEventsNow` claims each row by idempotency key through the same
  lease-guarded `claimOutboxEvent` predicate as the cron (due, not leased, not
  terminal, attempts remaining). A row the cron is processing is skipped; a row
  the inline attempt is processing is skipped by the cron; a delivered row is
  never reclaimed. Delivery, provider timeout, heartbeat, retry/backoff,
  dead-letter, and lease-owned finalization are the cron's code paths, and the
  provider idempotency key is the stored key, so a crash after send retries
  under the same Resend `Idempotency-Key`.
- Handlers come from the single registry now in `api/_outbox-delivery.js`, which
  the cron also uses.
- Budget: 8 seconds per request (capped by the platform invocation deadline via
  `getDeadline()` minus 2 seconds), at most 8 events, 2-second finalization
  reserve, provider wait `min(event timeout, remaining)`. A claim that commits
  after the window closes is finalized to a bounded `INVOCATION_DEADLINE` retry
  without provider work, as in the cron. Future-dated rows (schedule reminders)
  are not due and are left to the cron.
- The attempt starts after `res.json()` (an extra `setImmediate` yield), never
  awaits in the handler, and every failure is swallowed and logged as
  `[outbox_immediate_fail]` with only event types and an error code. The row
  stays `pending`/`retry` for the cron.
- Enumeration safety: password-reset and activation responses are unchanged,
  still complete the 350 ms floor, and are sent before anything is scheduled.
  An unknown or ineligible account writes no outbox row and schedules nothing;
  because scheduling happens after the response, its presence is not
  observable in body, headers, or timing.
- Switch: on by default on Vercel (`VERCEL=1`); `OUTBOX_IMMEDIATE_DELIVERY=false`
  turns it off (mail then waits for the cron), `true` enables it elsewhere. It
  is a no-op for the local identity adapter so development capture still
  appears in the cron response.

**Alternatives.** Claim-and-send inline before responding would add provider
latency (up to the 10-second event timeout) to the user's request and to the
password-reset/activation timing floor, making account existence observable;
rejected. A Vercel Cron cannot provide the needed cadence on Hobby (one run per
day), so none is added for #250. An external cron service or managed queue
would add an account and secret and still leaves minutes of latency; it remains
the upgrade path if the GitHub schedule itself must be replaced.

**Scheduler and watchdog.** `outbox-dispatch` remains the sole scheduled
fan-out and the backstop for anything the immediate attempt did not finish
(provider failure, platform termination, kill switch, pairing mail). Its
cadence, `CRON_SECRET` authentication, and fair per-invocation budget (#96) are
unchanged, so the pinned watchdog workflow and threshold are not changed here.
The p95 enqueue-to-send delay for auth and invitation mail becomes the request
duration plus provider latency (seconds) when the immediate attempt succeeds;
measure it after deploy from `outbox_events.created_at` to `delivered_at` for
those event types.

**Rollout and recovery.** No migration. Deploy; confirm a password reset and an
invitation arrive within seconds and that their outbox rows are `delivered`
with a single `claimed` audit by an `inline-*` worker. Recovery is
`OUTBOX_IMMEDIATE_DELIVERY=false` and a redeploy; queued mail then follows the
scheduled worker exactly as before.

## ID-65: Make pair code conflict-free and execute only acknowledged state

Status: candidate migration-backed primary-session increment.

**Decision.** Migration 20 owns one bounded Yjs code document per exact
two-human room, exercise version, and language. The same source-aware authority
is repeated in bootstrap, merge, and execution statements. Yjs and y-monaco are
exact, locally bundled dependencies; transport remains authenticated HTTPS
polling. Board v3 stays a separate CAS aggregate and carries only a maintained
rollback projection of code. Pair Run flushes local updates and the server
executes only the materialized bytes at the supplied opaque document version.
Attestation v3 binds pair, code hash, document revision/state/version, and
result evidence while v2 history remains verifiable.

**Alternatives.** Whole-document CAS still loses edits. Diff3 interrupts live
sessions. Managed providers add secrets, cost, and a data processor. A
self-hosted WebSocket service adds operational scope. BroadcastChannel is not
cross-device or durable. A custom OT/CRDT is higher risk than pinned Yjs.
Presence and remote cursors are deferred.

**Rollout and recovery.** Apply additive v20 after v19, then canary overlapping
browser edits, offline replay, duplicate/reordered updates, restart, textarea
fallback, stale Run, completion fences, and board compatibility. Private
documents expire after 90 days through access-time and weekly sweeps. Rollback
retains v20 and its ledger, keeps the v20-capable API deployed, stops pair
editing at the maintenance boundary, and rolls forward. A pre-v20 binary is
not compatible with the v20 ledger and must not accept projection-only edits.
Full details are in
[`CONFLICT_FREE_CODE_DOCUMENTS.md`](CONFLICT_FREE_CODE_DOCUMENTS.md).

## ID-66: Accept public invite requests without enumeration

Status: candidate migration-backed increment (WP-L2); flag default-off.

**Context.** The landing page needs a "Request an invite" form (UI redesign
spec §7.2–§7.3). A public write endpoint that touches identity data must not
reveal whether an email is a member, invited, or already waiting, must not let
the form relay arbitrary text through the circle's sending domain, and must
not add a second invitation path.

**Decision.** Migration 21 adds `invite_requests` (UUID id, primary circle,
email HMAC, plaintext normalized email, name ≤60, note ≤280, status
`pending|approved|declined|expired`, epoch timestamps). A table CHECK forces
every non-pending row to have email, name, and note scrubbed; a partial unique
index allows one pending row per email. `POST /api/invite-requests` requires an
exact same-origin `Origin` (scheme, host, port), validates bounded fields
(ASCII-only email), short-circuits a filled `website` honeypot, consumes
`auth_rate_limits` per client address (5/h, IPv6 keyed by /64) and per email
hash (3/h), enforces a rolling 24-hour cap of 50 *stored* requests before any
email-specific check, and then stores a request only when the email is
not an active member, has no live invitation, is not already pending, and was
not declined in the last 30 days. Every accepted outcome returns the same 202
body after a 750 ms floor (overruns are logged without data); owner digest delivery
is scheduled only afterwards through the ID-64 `waitUntil` path. Primary-circle
owners list pending requests and approve or decline with a compare-and-swap on
`pending`; approval calls the extracted `insertOwnerInvitation`, the same
writer as owner "invite by email", in the same transaction as the request
update and audit row, and queues the existing invitation email. Repeating the
same decision replays idempotently. The digest event
`inviterequest.email.requested` v1 (one per owner per hour) carries only ids
and renders only the pending count and a dashboard link; it honours
`email_enabled=0`. Approval re-checks membership and live invitations inside
its transaction (409 `invite_request_already_member|already_invited`). The
weekly cron runs capped, repeated bounded batches (≤500/statement, ≤10
batches) of expiry and 30-day purge that never block publication, and the owner
list scrubs overdue rows on read. `INVITE_REQUESTS_ENABLED`
(with circle membership) gates all endpoints and the `inviteRequests`
capability, which is also hidden until the v21 readiness probe passes.

**Alternatives.** Encrypting the pending email would need a fifth
credential-key purpose and a `credential_key_controls` schema change for data
that already lives in plaintext in accounts and activations; scrubbing on
decision and 30-day expiry bound the exposure instead. Including the
requester's name and note in the owner email (allowed by the spec) would let
anyone send chosen text to the owner from the circle's domain; the count-only
digest avoids that. A distinct 409/200 for duplicates or members would make
the form an enumeration oracle. Running retention on request paths would put
deletes behind public traffic. A separate Vercel function would add to the
function count; the endpoints are routed through `api/invitations.js`.

**Residual risk.** Someone with many addresses and fresh emails can fill the
50/day stored cap and make intake return 429 for everyone until the window
rolls (no enumeration; owners can still invite directly; the flag is the kill
switch). CAPTCHA or proof-of-work is the upgrade path.

**Rollout and recovery.** Merge with the flag off. The merged code requires
v21, so `/api/health/ready` is 503 until v21 is applied: apply it through the
protected migration workflow immediately after merge, not near the Sunday
08:00 UTC pairing run; enable the flag; canary submit → digest →
approve → accept. Recovery is disabling the flag (endpoints 404, capability
hidden); rows continue to expire and purge weekly. Full contract in
[`INVITE_REQUESTS.md`](INVITE_REQUESTS.md).

## ID-67: Run an external outbox scheduler beside GitHub and alert on delivery health

Status: implemented. Optional env var, no migration.

**Context.** `outbox-dispatch` is scheduled `*/5`, but GitHub runs it about
every three hours. Because of that, the run-cadence watchdog (ID-43) reported
`run_stale` on every run. Pairing mail, reminders and retries could be hours
late, while auth and invitation mail (ID-64) was unaffected.

**Decision.** An outside scheduler (cron-job.org) calls `POST /api/cron/outbox`
every five minutes. GitHub keeps running as a backup. Outbox claims are leased
and idempotent, so the two dispatchers can run at the same time safely.

- **Separate secret.** The external service authenticates with a new optional
  `OUTBOX_DISPATCH_SECRET`, not `CRON_SECRET`. The app accepts it, with a
  timing-safe compare and the same header forms, only on
  `/api/cron/outbox` and `/api/cron/outbox-health`. Every other cron route
  (`/api/cron/weekly`, which publishes pairings) still accepts only
  `CRON_SECRET`. The app ignores a value shorter than 32 characters or equal
  to `CRON_SECRET`. This fails closed for the extra secret only.
- **Health endpoint.** A new read-only endpoint,
  `GET /api/cron/outbox-health`, answers from one database-clock statement
  and returns aggregate values only: the age of the oldest due
  `pending`/`retry` event, the due count, the count and age of expired
  `processing` leases, 24-hour dead letters, and the last delivery time.
- **Watchdog.** `outbox-dispatch-watchdog` now alerts on delivery freshness.
  It alerts when the oldest due event or expired lease is older than
  15 minutes, or when the endpoint is unavailable, unauthorized, or malformed.
  The GitHub run assessment is kept as a non-failing `github_*` warning.

**Trade-off.** To read the health endpoint, the watchdog job now runs in the
protected `production` environment and receives `vars.APP_URL` and
`secrets.CRON_SECRET`. This reverses ID-43's secret-free boundary. The
deployability gate lists those two values as the only production material the
watchdog may reference, still rejects any other secret, variable, write
permission or `curl`, and pins the new workflow and assessor digests.
`CRON_SECRET` is used because it already lives in that environment. The
external secret is kept out of GitHub on purpose.

**Alternatives.** A managed queue or Vercel Pro cron would fix cadence but
needs a paid plan or a larger migration. Giving cron-job.org `CRON_SECRET`
would let a third party trigger pairing publication. A health check that does
not use the database could not tell "GitHub is late" apart from "mail is late".

**Rollout and recovery.** Merge. Set `OUTBOX_DISPATCH_SECRET` in Vercel
Production, redeploy, and create the cron-job.org job described in
[`OUTBOX_EXTERNAL_SCHEDULER.md`](OUTBOX_EXTERNAL_SCHEDULER.md). To recover,
pause the job or remove the variable and redeploy. Delivery then falls back to
GitHub, and the watchdog keeps alerting on real staleness.

## ID-68: Invite several people at once with one shared email validator

Status: candidate code-only increment; no migration, no flag.

**Context.** Owners asked to paste a list of addresses and invite everyone in
one step, and to have email validation enforced identically in the browser and
on the server. Validation was a loose `x@y.z` regex repeated in five places
with small differences, and the browser relied on `type=email`.

**Decision.** `assets/email-validation.js` is a dependency-free ES module that
the API imports and the browser loads as a module; it defines the canonical
form (`trim()+toLowerCase()`, unchanged), conservative strict rules with
stable reason codes, and the paste parser. The strict rules apply to every
path that accepts a *new* address (owner invitations single and bulk,
`insertOwnerInvitation`, invite-request intake, password sign-up); lookups of
addresses already on record (sign-in, reset, activation resend, Google
identity, invitation acceptance, outbox decoding) keep the identical canonical
form with the original loose check, so nobody is locked out. A pre-existing
invite request that the strict rules reject returns
`409 invite_request_email_invalid` on approval. `POST /api/invitations` also
accepts `{emails:[...]}` (1–50): a read-only classification step validates,
de-duplicates after normalisation and finds existing members and live
invitations of the selected circle; each remaining address then gets its own
write transaction through the same `insertOwnerInvitation` + outbox path
(audit row, `invitation-email/v1/{id}/1`) so one failure never blocks the
others. Results come back per address in input order (`created`, `invalid`,
`duplicate_in_request`, `already_member`, `already_invited`, `failed`).
Owner-created invitations share a fixed-window quota of 200 per circle per 24
hours in `auth_rate_limits`, reserved inside each transaction with a
conditional upsert (rollback refunds) and checked up front for a batch (429 +
`Retry-After`). Created events use the existing ID-64 post-commit attempt (≤8
per request); the rest drain on the next scheduled outbox run. Addresses never
reach logs or Sentry. The Circle card gains a keyboard-accessible disclosure
with live preview, per-address results (copy link, resend, retry), and the
un-sent addresses kept in the textarea.

**Alternatives.** One transaction for the whole batch would let a single bad
row or lock timeout discard valid invitations. A separate endpoint would add a
route, rewrite and contract surface for no extra safety. Tightening
`normalizeInvitationEmail` itself would change lookups for existing accounts
and pending invitations. RFC 5322 quoted local parts and Unicode addresses
(SMTPUTF8) were excluded: they add look-alike and deliverability risk for
almost no real users; IDN domains work in punycode.

**Residual risk.** A pending invitation or invite request created under the old
rules with an address the strict rules reject can still be accepted
(Google) but not used for password sign-up; such addresses are expected to be
vanishingly rare. In a large batch, emails beyond the per-request inline cap
wait for the scheduled outbox run (copy links are immediate).

**Rollout and recovery.** Deploys with no migration or configuration. Recovery
is a revert; invitations already created are normal invitations. Full contract
in [`INVITATION_EMAIL_DELIVERY.md`](INVITATION_EMAIL_DELIVERY.md) ("Inviting
several people at once").

## ID-69: Add co-owners and app admin grants without a schema change

Status: implemented; no migration, no flag (behind the existing membership
capability).

**Context.** The only owner and admin wants another member to be a co-owner
and app admin "like me". Ownership could only be transferred (promote the
target, demote the actor), and `auth_accounts.is_admin` could only be set by
`ADMIN_EMAILS` or the legacy email-based promote action, with no recent auth
or audit. The schema already allows many owners per circle and many admins.

**Decision.** `PATCH /api/members` accepts `make_owner`, `remove_owner`,
`grant_admin`, and `revoke_admin` with the existing `{action,member_id}` body.
Owner actions require an active owner of the selected circle; admin actions
require an active, non-demo `is_admin=1` account in the primary circle and a
target in that circle. Each is one write transaction that checks the
session-scoped ten-minute recent-auth proof (the transfer flow and "Confirm
it's you" dialog), applies one conditional `UPDATE` that re-checks actor,
target, circle, and the last-active-owner or last-active-admin invariant in the
statement, and writes one `circle_audit_events` row (`ownership.granted`,
`ownership.revoked`, `admin.granted`, `admin.revoked`). Revoking an
`ADMIN_EMAILS` account is refused because sign-in would re-grant it. Roles and
admin stay database-read on every request, so nothing rotates sessions. The
Members card gets a per-member "Roles" menu and an Admin badge; existing test
IDs are unchanged. There is no owner or admin ceiling. Single-owner assumptions
were removed: the hard-coded browser admin email, the five-owner cap on
invite-request digests, and the migration postcondition that required the
original backfill actor to still be an active owner.

**Alternatives.** Audit in `auth_identity_audit_events` (its `event_type`
CHECK would need a migration). A separate admin endpoint (another function and
duplicated context handling). Returning 200 `replayed` for repeats (the
lifecycle API already answers state replays with 409). Letting owner status
imply admin (production admin tools are operator-level, not circle-level).

**Residual risk.** Any one co-owner can demote every other co-owner, and any
admin can revoke other admins down to one; that is the requested "similar to
me" authority. The legacy email-based promote action (which bypassed recent
auth and audit) has since been retired and returns `410`. Full contract in
[`MEMBER_LIFECYCLE.md`](MEMBER_LIFECYCLE.md#co-owners-and-app-admins).

## ID-70: Retire the legacy admin promote; record non-PII email provider reject reasons

Status: implemented; no migration, no flag.

**Context.** `POST /api/admin/reshuffle` with `{"action":"promote","email":…}`
set `auth_accounts.is_admin=1` by email for any admin, with no recent-auth
proof and no audit row. ID-69 added audited, recent-auth role changes on
`PATCH /api/members`. Separately, on 2026-10-20 all nine production
`invitation.email.requested` events dead-lettered as `PROVIDER_REJECTED` on
attempt 1. Only that code was stored, and Vercel Hobby keeps logs briefly, so
the provider's reason was lost.

**Decision.**
- The promote action now returns `410` with `code: legacy_promote_retired`
  and points to `PATCH /api/members` (`grant_admin`, `revoke_admin`,
  `make_owner`, `remove_owner`). It returns before authentication or any
  database access, so it cannot change roles. No UI, script, or workflow used
  it. Reshuffle (pairing) and demo actions are unchanged.
- Every Resend adapter (activation, password reset, invite-request digest,
  pairing, secondary schedule, and, through the shared pairing classifier,
  invitation and schedule mail) attaches a bounded provider reason to
  provider 4xx/5xx errors: `status:name:reason`, for example
  `403:validation_error:testing_recipient_restricted`. `name` is Resend's error
  name from an allowlist, otherwise `other`. `reason` comes from matching known
  Resend phrases (`testing_recipient_restricted`, `domain_not_verified`,
  `invalid_from_address`, `invalid_recipient`, `api_key_invalid`,
  `api_key_missing`, `api_key_restricted`, `quota_exceeded`, `rate_limited`,
  `idempotency_conflict`, `missing_required_field`), otherwise `other`. The raw
  message is never stored because it can contain addresses.
- The reason is stored in the existing `outbox_audit_events.reason_code`
  column (1–64 characters, no enum CHECK) of the `retry_scheduled` or
  `dead_lettered` row. `outbox_events.last_error_code` keeps the stable code
  (`PROVIDER_REJECTED`). No migration is needed.
- `GET /api/cron/outbox-health` adds `recentRejectReasons`, which counts
  24-hour dead letters by the reason on their latest `dead_lettered` audit row,
  for example `{"domain_not_verified":9}`. It contains no rows, statuses, names,
  or addresses.
- `GET /api/invitations` adds `email_rejected` to pending rows when that
  invitation's latest email dead-lettered as `PROVIDER_REJECTED`. The Circle
  card then shows "Email couldn't be sent — use Copy link" (or "use Resend for
  a fresh link, then Copy link" when no link is held in the tab).

**Residual risk.** Phrase matching depends on Resend's wording; new wording is
recorded as `other` with the status and error name still available. Dead
letters from before this change keep the bare `PROVIDER_REJECTED` reason and
are not counted.

## ID-71: Send reminders from the outbox cron behind a flag, without a migration

Status: implemented behind `REMINDERS_ENABLED` (default off); no migration.
Issue #287 (post-MVP roadmap #312, Wave 1). Final email and settings design is
pending (`needs-design`).

**Context.** Randori already sent pairing, schedule and 24-hour session
reminder emails. Members were not reminded before the Sunday availability
cutoff, and pairs that never agreed a time were not nudged, which is where the
weekly loop most often stalls. The outbox cron now runs every five minutes
(ID-67), so time-based reminders no longer need a new scheduler.

**Decision.**
- One new outbox event type, `reminder.email.requested` v1, with three kinds:
  `availability_cutoff` (from 24 hours before the upcoming cutoff, to members
  with no explicit decision), `agree_time` (72 hours after the current cycle's
  pairing, while no time is agreed) and `session_soon` (one hour before an
  agreed session, behind the extra `REMINDERS_SESSION_SOON_ENABLED` flag).
  Primary and secondary circles are covered; secondary mail links only to the
  dashboard, primary pair mail links to the room, and the cutoff reminder links
  to `/?view=pair`. No email contains a token.
- Reminders are queued by a bounded due-check inside the existing
  `/api/cron/outbox` preparation step (at most 50 per kind per invocation,
  skipped by `NOT EXISTS` on the stable idempotency key, with its own 5-second
  slice so a slow check cannot hold back other mail) and delivered in the same
  invocation. No Vercel cron was added. The fair dispatcher now has seven
  types, still under its eight-claim cap.
- Payloads carry only identifiers (and a SHA-256 fingerprint of the agreed
  instant for `session_soon`). The handler re-reads current state at send time
  and suppresses with `DECISION_MADE`, `CUTOFF_PASSED`, `TIME_AGREED`,
  `CYCLE_ENDED`, `SESSION_CHANGED`, `SESSION_CLEARED`, `SESSION_ELAPSED`,
  `MEMBER_REMOVED`, `EMAIL_DISABLED`, `RECIPIENT_INVALID` or
  `REMINDERS_DISABLED`. The idempotency key is the provider idempotency key,
  so retries and dead-letter replays cannot send twice. Provider failures use
  the bounded `status:name:reason` audit reason (ID-70).
- Times are shown in the recipient's profile timezone with its name, falling
  back to UTC, and every email says reminders can arrive a few minutes late.
- Preferences reuse `user_notification_prefs.email_enabled`, checked at enqueue
  and at send. While the flag is on, `GET /api/notifications/prefs` adds a
  `reminders` object and the email reminder row lists the covered types as
  On/Off with the Email checkbox. The handler is always registered so queued
  reminders drain as `suppressed` if the flag is turned off.

**Deferred.** Per-type toggles (issue defaults on, on, off). They need a
schema change, and any migration makes `/api/health/ready` return 503 until it
is applied in production, so merging would no longer be invisible. Until a
managed migration and an owner-approved protected apply, the one-hour reminder
is opt-in per deployment, not per member. Final templates and settings design
are pending.

**Alternatives.** A per-type preference table now (needs a production
migration window before merge is safe). Enqueueing reminder rows when pairing
or schedules change (the cutoff reminder has no triggering write, and stale far-
future rows need the same send-time checks anyway). A separate cron route
(more schedules and secrets than one due-check in the existing worker). One
event type per kind (three more fair-dispatch lanes for low volume).

**Rollout and recovery.** Merge with both flags unset; nothing changes. The
owner sets `REMINDERS_ENABLED=true` (and optionally
`REMINDERS_SESSION_SOON_ENABLED=true`) in Vercel Production and redeploys. To
recover, unset the flag and redeploy; queued reminders drain as suppressed.
Contract: [`REMINDERS.md`](REMINDERS.md).

**Review fixes (follow-up PR).** A primary-pair reminder now requires every
pair member to be an active, real primary member at queue and send time
(`PARTNER_REVOKED`), matching the secondary path and pairing mail. Only the
nudge ends with the cycle; the one-hour reminder covers the current and
previous week's pairs, because primary schedules outlive the Sunday boundary,
and skips sessions under 15 minutes away (`SESSION_IMMINENT`). The due-check
reads the current week first and returns before any pair scan until its
pairing is 72 hours old, materializes the pairs CTE, runs `session_soon`
first, and isolates failures per kind with a bounded code in
`outbox.reminder_errors` and a `warn` log. A membership-free local runtime uses
the `local` availability scope, like the availability endpoint, through one
shared `strictLocalPairingRuntime` check. The one-hour due-check pages with a
keyset on (agreed time, group, user) so queued recipients cannot starve later
ones (at most 20 pages a run, reported as `PAGE_LIMIT_REACHED`), and nothing is
queued when no reminder handler can deliver (`NO_DELIVERY_HANDLER`). The nudge
still scans `pairing_groups` once per run after 72 hours (no `week_id` index
without a migration); this is documented rather than throttled.

## ID-72: Turn on production client error logging (warn/error, signed-in) with app_logs retention

Status: implemented; no migration, no flag. Owner-approved follow-up to the
finding in PR #323.

**Context.** The client logger in `index.html` (`window._randori_log`) never
installed in production. The Sentry config created a placeholder
`window._randori_log={_lastEvent:''}` on the production origin, and the logger
returns early when that global exists. Production therefore had no
`/api/logs` batching and no logger error handlers, while previews and local
runs did. `app_logs` also had no retention: client entries, server ops logs,
runner lease/quota rows and an `outbox_invocation` row every five minutes only
accumulated.

**Decision.**
- *Install everywhere.* The placeholder is gone. The logger installs unless a
  real logger (one with a `log` function) already exists; it replaces a bare
  placeholder and keeps its last event. The Sentry augment step no longer
  wraps the logger (see the addendum); it only tags SDK events with the
  logger's last event. The early-error buffer is unchanged.
- *Production send rule.* On the canonical production origin
  (`__randoriSentry.environment==='production'`, automated browsers included)
  only `warn` and `error` entries are queued for `/api/logs`. `info`,
  `success` and `debug` stay as console lines and Sentry breadcrumbs. Previews
  and local runs queue every level, as before. The server enforces the same
  rule when `VERCEL_ENV==='production'` (not `NODE_ENV`, which Vercel also
  sets on previews) and silently skips other client levels.
- *Signed-in only.* The queue belongs to one identity: `u:<id>` from
  `window._randori_auth.me`, `anon` once `/api/auth/me` has settled signed out,
  unknown before that. Signed-out entries are not queued. Entries from before
  identity settles are adopted by the first identity it settles as (boot
  errors of a signed-in load); any later change (sign-out, another user)
  clears the queue. A flush sends only while the owning identity is signed in,
  so an entry is never sent as a different user and anonymous visitors cause
  no `/api/logs` requests (the endpoint requires auth and would only 401).
- *Dedupe and cap.* The same `level|event|message` is queued at most once a
  minute, and at most 50 entries per page load (this also bounds the queue
  while identity is unknown). Errors flush after 200 ms, other bursts of three
  after 400 ms (at most every 3 s), otherwise every 5 s; batches hold at most
  20 entries.
- *Redaction.* Every entry is redacted before it is mirrored to the console,
  added as a breadcrumb, queued or sent. `route` is `location.pathname +
  location.search` only, and the old `meta.href` (which carried the fragment)
  and `meta.ua` (the `ua` column already has it) are gone. Text redaction
  drops the fragment of any token with a `/` before its `#` (keeping a trailing
  stack-frame `:line:col`), replaces the value of secret-looking `name=value`
  pairs and quoted JSON keys (`token`, `invite`, `code`, `secret`, `password`,
  `key`, `signature`, `session`, `auth`, `authorization`, `cookie`, `otp`,
  `credential`, with an optional `prefix_`/`prefix-`) with `[redacted]`,
  `Bearer`/`Basic` credentials with `[redacted]`, JWTs with `[jwt]` and email
  addresses with `[email]`. Meta objects are copied to depth 4 (30 keys, 20
  array items), and keys matching the secret names lose their value. Input is
  cut before any pattern runs (8000 characters per string, a 16k-character
  budget per entry since the addendum). The original JWT pattern was
  quadratic on adversarial input; the addendum anchors it and adds timing
  tests. `api/_client-log-policy.js` holds the same rules as a server-side backstop
  for `POST /api/logs` (message, meta, `meta_json`, event and route); a unit
  test runs the browser and server copies over one corpus.
- *Sentry volume is unchanged.* The logger itself creates no Sentry events:
  its `forwardToSentry` and the explicit captures in its global handlers are
  removed, because the SDK's global handlers (and the early buffer) already
  report uncaught errors and call sites capture their own. The old
  `_randori_log.log` patch is removed (addendum): nothing called it.
- *Admin view.* Client rows reach the existing admin logs panel
  (`GET /api/data?endpoint=logs`, `#logsArea`), which stays admin-only
  (401 signed out, 403 for members). The panel gained a source filter
  (all/client/server) next to the level filter, since `outbox_invocation`
  rows otherwise crowd out client errors in the last 30 rows.
- *Retention.* `api/_app-log-retention.js` deletes at most 1000 `app_logs`
  rows with `created_at` older than 30 days per run, oldest first, through a
  bounded `id IN (SELECT … ORDER BY created_at LIMIT ?)` subquery. Each run
  first claims the hour by the database clock with one atomic
  `INSERT … WHERE NOT EXISTS` of an `app_logs_retention` row, so a run within
  the hour, or a concurrent one, does nothing. It runs from `/api/cron/outbox`
  *after* the delivery round, so it can never delay mail, and only when its
  whole 2-second budget fits before the finalization reserve; a slow or failed
  run is reported (`app_logs_retention` in the cron response and the
  `outbox_invocation` row) and retried by a later invocation. Deleting is
  idempotent. Runner lease (30 s) and quota (1 min) checks never read rows
  near 30 days old.

**Write volume.** A healthy page sends nothing. Each sent entry is one row;
a page load writes at most 50 rows in at most three requests, and the
existing server limits stay (20 entries per request, 60 requests per minute
per IP, `runner` source and `execute_*` event names rewritten). The outbox
cron adds 288 `outbox_invocation` rows and 24 retention rows a day. Retention
removes up to 24,000 rows a day, well above that inflow, so the table settles
at roughly 30 days of inflow (about 9,400 rows plus client errors) and an
existing backlog drains at 1000 rows an hour.

**Schema.** No migration and no DDL. `idx_logs_created` (schema plan 1)
serves the purge and `idx_logs_event_created` the hourly claim; a unit test
checks both with `EXPLAIN QUERY PLAN` on the migrated schema. No further index
is needed. Rows written with an ISO `T` timestamp would compare one day late
against `datetime('now')` text; every writer uses `datetime('now')`.

**Alternatives.** Keep production logging off (no visibility into client
failures). Send every level in production (mostly noise, several writes per
page). Allow anonymous ingestion (needs a separate abuse model; the endpoint
requires auth). Run retention in the weekly cron (one Sunday window at most
1000 rows would fall behind 2,000+ rows a week) or inside the cron's
preparation step (would delay delivery). A new `created_at` index or a
retention table (needs a migration).

**Rollout and recovery.** Merging turns it on; the next production deploy
installs the logger. To stop client ingestion quickly, revert this change;
retention is independent and can stay.

### ID-72 addendum: harden client log ingest (post-merge review of PR #326)

Status: implemented; no migration. Fixes from the post-merge review, before
invitees join (today only the owner is active, and every issue needs a
signed-in member).

- **C1, CPU per request.** The JWT pattern `\beyJ…` was quadratic on input
  such as `'eyJ-'.repeat(2000)`, and redaction ran before truncation over all
  of meta: one 4.48 MB request cost about 12 s of CPU in the real handler.
  - The JWT pattern now starts only where a token starts
    (`(^|[^A-Za-z0-9_-])eyJ…`, replaced with `$1[jwt]`). It uses a capture
    instead of the suggested lookbehind so the inline browser copy still
    parses on Safari before 16.4; matching is identical.
  - `POST /api/logs` returns 413 when `content-length` is over 256 KB, before
    authentication and before `req.body` (parsed lazily on Vercel) is touched.
    Without a `content-length` the parsed body is measured after
    authentication.
  - Text is cut before it is redacted (8000 characters per string, 2000 for
    messages, 80 for events, 300 for routes and user agents), and
    `redactLogValue` has a 16k-character budget per entry; values past it
    become `[truncated]`.
  - Measured in the real handler: the reviewer's 4.48 MB body took 11.9 s
    (12.4 s without `content-length`) and now returns 413 in 4 ms (8 ms). A
    217 KB body of the same strings, just under the limit, spent 545 ms in
    redaction and is now stored in 14 ms. One 8000-character `eyJ-` string
    went from 22 ms to about 2 ms for all rules. Timing tests cover both
    copies on adversarial input.
- **M1, forged server rows.** `/api/logs` stores every row with the literal
  source `client`; only server code writes `server` and `runner` rows. The
  retention claim counts only `source='server' AND user_id IS NULL` rows, so
  no member-written row can suppress retention. No other reader trusts
  member rows: runner lease and quota checks read `source='runner'`, the
  outbox health and watchdogs read `outbox_events`, Admin Diagnostics (ID-73)
  takes dispatcher evidence and errors-card freshness and the execution smoke
  check (#249) takes its claims and results only from rows with
  `user_id IS NULL`, and the admin panel shows the stored source.
- **M2, write volume.** Each member stores at most 200 client rows in any
  rolling hour (`CLIENT_LOG_RECENT_COUNT_SQL`, which searches
  `idx_logs_source_created` and stops counting at the cap; checked with
  `EXPLAIN QUERY PLAN`). A pre-check answers 429 once the cap is reached;
  the cap itself is enforced by each row's conditional
  `INSERT … SELECT … WHERE (count) < cap` inside one `'write'` batch, so
  concurrent requests cannot overshoot it (50 concurrent 20-entry requests
  store exactly 200 rows), and `inserted` is the sum of `rowsAffected`. A
  failed write stores nothing and returns 503. The per-IP limit stays.
  Worst case is 200 rows per member per hour.
- **m1, redaction gaps.** Percent-encoded `#`, `=`, `@`, `/` and `.` are
  decoded before matching, also when double-encoded (`%2540`). A fragment is also dropped when it holds a `/` or `=`
  (`#/invite/SECRET`, a bare `#invite=…`). Secret names accept a few camelCase
  prefixes (`accessToken`, `apiKey`, `refreshToken`, `idToken`,
  `clientSecret`; `cycleKey` stays readable) and an id/key/token/hash suffix
  (`sessionId`, `session_id`), plus `sid`. JSON values may be numbers
  (`"otp":123456`), escaped JSON is covered (`{\"token\":\"…\"}`), and
  `password: x`, `secret: x`, `Authorization: Token x` and
  `authorization=Bearer x` lose the whole credential. The app's `api()`
  wrapper logs and tags only the path without its query.
- **m2, partial secrets.** A cut drops the partial trailing token (back to
  whitespace, a quote, a parenthesis, `,` or `;`) and appends `[truncated]`,
  so half an email or JWT is never kept.
- **m3, tests.** The text corpus adds uppercase emails, `x_session=` and the
  m1 forms; a shared object corpus runs the browser `redactValue` and the
  server `redactLogValue` together (key rules and budget); the API test
  checks server-side event and user-agent redaction; the retention test
  covers the claim's source and user filters.
- **m4, double rows.** A non-OK response is logged once (5xx as `error`, a 4xx
  the caller may handle as `warn`) and reported to Sentry once; `api()` no
  longer logs and reports the same HTTP problem again when it rethrows it.
- **m5.** Golden path 20 (`golden-client-logging-real-runtime.spec.ts`): on
  the real runtime a member's uncaught error lands in `app_logs` redacted, a
  signed-out visitor sends nothing, and the admin panel shows it under the
  client filter.
- **n1.** The Sentry step's `patchLogger` wrapped only `_randori_log.log`,
  which nothing called; it is removed. Sentry events are still tagged with
  the logger's last event.
- **Re-review follow-ups.**
  - The authorization rule now keeps an opening quote, so
    `{Authorization: "Bearer abc.def"}`, `{ Authorization: 'Bearer abc' }`
    and `Authorization="Bearer abc"` lose the whole credential.
  - Quoted values after `=` (`token="abc"`, `password='x'`), `activationToken`,
    `csrf`/`xsrf` names, `secret_key: x` and `code:` before 4-10 digits are
    redacted; `status code: 500` stays readable. A JWT right after `-` is not
    matched (the anchored pattern's documented trade-off).
  - Meta whose serialized form is over 8000 characters is stored as
    `{"truncated":true,"preview":"…first 7000 characters…"}`, so `meta_json`
    is always valid JSON.
  - A non-OK 5xx response is reported to Sentry at level `error`, a 4xx at
    `warning`.
  - The adversarial timing test compares each input with benign input of
    the same length (`< 4×benign + 2 ms`); restoring `\beyJ` fails it
    (≈20 ms against ≈1.3 ms).

## ID-73: Admin Diagnostics in the Circle view, read-only and behind a flag

Status: implemented behind `ADMIN_DIAGNOSTICS_ENABLED` (default off); no
migration. Issue #310 (post-MVP roadmap #312). The visual design is
provisional (`needs-design`).

**Context.** Operational health was spread across GitHub Actions runs (outbox
and backup watchdogs), Sentry, `/api/health/ready` and the admin logs widget on
Home. The maintainer had to check several places to answer "is email going out,
did the backup drill pass, is Run working?".

**Decision.**
- `GET /api/admin/diagnostics` (rewritten to `/api/ops?endpoint=admin-diagnostics`,
  no new function) returns one aggregate snapshot,
  `randori.admin-diagnostics.v1`, with `Cache-Control: no-store`. While the flag
  is off it returns the same `404` as an unknown ops endpoint, with no session
  or database access, and `/api/auth/capabilities` does not advertise
  `adminDiagnostics`.
- Access: only a global administrator — a live session on an account with
  `is_admin=1` and `is_demo=0` and, when circle membership is enforced, an
  active membership in a non-archived circle. Accounts listed in `ADMIN_EMAILS`
  qualify once they are `is_admin=1`, which sign-in and `/api/auth/me` set on
  their next call. The circle owner role alone grants nothing. `401` without a
  session, `403` otherwise. `/api/auth/me` now also returns `is_demo`, so the
  browser hides the view (and skips loading it) for demo admins too.
- Every read is a `SELECT`. Cards: **Outbox delivery** (`readOutboxDeliveryHealth`
  and `readOutboxMetrics` plus one per-type due/lease/dead-letter aggregate,
  judged with the watchdog's 15-minute threshold); **Code execution** (the
  configured provider and a bounded reason, 24-hour runner outcomes from
  `app_logs`, and the latest #249 smoke result per the #343 addendum below);
  **Readiness and migrations** (the `/api/health/ready` probe plus a ledger summary: state,
  versions and the newest names, no checksums); **Recent errors** (24-hour
  `error`/`warn` counts by source and event category, including
  `source='client'` rows). Event names that do not look like code identifiers
  become `other`, so a browser-posted log row cannot carry text into the view.
- Each card carries `evidence` (`at`, `ageMs`, `maxAgeMs`, `stale`). It is
  stale when its newest evidence is missing or older than its cadence: the last
  server-written `outbox_invocation` row (15 minutes; rows with a user id are
  ignored because browsers can post log rows), the last runner outcome
  (26 hours), the newest log row (1 hour), or the live read itself (5 minutes,
  the refresh cadence). The browser adds the time since it fetched the
  snapshot, so cards go stale while the page stays open.
- **Watchdogs are deferred.** The outbox and backup watchdogs keep their
  results only as GitHub Actions runs and artifacts. Reading them would need a
  GitHub token in the app, which widens secret exposure, so both cards are
  `deferred` with their cadence and point to the live Outbox and Readiness
  cards instead.
- Dead letters: the newest 25 (numeric id, type, version, stable error code,
  bounded provider reason, attempts, replays, age). Replay goes through the
  existing audited `POST /api/admin/outbox/replay` with one of its reason codes,
  after a confirmation dialog. No emails, tokens, payloads, idempotency keys,
  code, URLs or log messages are returned.
- UI: a `Diagnostics` disclosure under Circle (spec section 4), shown and lazily
  loaded only for global admins while the capability is advertised. The admin
  logs widget and demo controls stay where they are (their placement is pinned
  by existing tests) and are linked from the view.

**Residual risk.** Log `source` is recorded as posted, so a member could post a
row labelled `server`; counts are categories, never content. Watchdog results
need an app-readable evidence store before those cards can go live.

**Rollout and recovery.** Merge with the flag unset; nothing changes and no
extra script is downloaded. The owner sets `ADMIN_DIAGNOSTICS_ENABLED=true` in
Vercel Production and redeploys. To recover, unset it and redeploy.

### ID-73 addendum: show the latest execution smoke result (#343)

The deferred #249 seam is replaced by `execution.smoke`, still behind
`ADMIN_DIAGNOSTICS_ENABLED` and with no migration.
- It reads through `readLatestExecutionSmoke` and the new
  `latestExecutionSmokeLanguages` in `api/_execution-smoke.js`, so the rules
  are the smoke route's own (ID-74): server-only `runner` rows with
  `user_id IS NULL`, the result matched to the latest claim, and
  `result_missing` once an unsaved claim is past the 165-second grace.
- The only difference is the lookback: 30 days (the `app_logs` retention,
  ID-72) instead of one day, so a check that stopped running shows as stale
  rather than never run.
- `status` is `passed`, `failed`, `pending` (an unsaved claim inside the
  grace) or `none`. Each language reports its recorded status (or
  `result_missing`/`pending`) and duration. `checkedAt` is when the result was
  saved.
- Its evidence dates from the result, or from the claim when no result was
  saved, and is stale after 26 hours (the daily 07:29 UTC run plus two hours).
- The card verdict folds the smoke in (owner decision on the PR #348 review);
  newer evidence wins:
  - A fresh smoke failure (under 26 hours) newer than the latest member run
    makes the card `degraded`. The category is `smoke_failed` when a language
    reports a provider outcome, and `smoke_result_missing` when only results
    are missing.
  - A fresh passing smoke lifts a card with no member runs (`unknown`,
    `no_runs`) to `healthy`.
  - Nothing else changes the verdict. A `failed` card (provider not
    configured) stays failed. A member run newer than the smoke keeps its own
    verdict. A pending, absent, unreadable or stale smoke changes nothing.
  - The card's freshness is the newer of the latest member run and the smoke.
    The existing 26-hour execution threshold already matches the daily smoke.
- The smoke is read separately. A failing smoke read makes only
  `execution.smoke` `unavailable`, and a failing execution read keeps the
  smoke result. It returns no URLs, secrets, program output or error text.
- The card shows a "Provider smoke check" row with its own status and Stale
  badges, the per-language line and the result's age, built with
  `textContent` and the existing `rc-badge` styles. The visual design is still
  provisional.

## ID-74: Check the live execution provider after each deploy and daily, within a fixed sandbox budget

Status: implemented. Ops-only: no feature flag, no migration, no new secret.
Issue #249. This produces the live evidence that #248 and #9 need.

**Context.** End-to-end tests mock the code-execution provider. When the public
Piston API retired, production Run broke while every check stayed green
(#248). The existing `npm run smoke:execution` needs a local Vercel OIDC token,
so it cannot run in CI.

**Decision.**
- **Endpoint.** New `POST /api/cron/execution-smoke` in `api/ops.js`.
  - It accepts `CRON_SECRET` only, because it spends sandbox quota.
    `OUTBOX_DISPATCH_SECRET` is rejected.
  - It runs one fixed trivial JavaScript program and one fixed trivial Python
    program through `executeProgram` with the production `EXECUTION_PROVIDER`
    configuration, and checks the exact output `randori-smoke-42`.
  - It returns only `{ok, checkedAt, languages:{javascript|python:{status,
    durationMs}}}`. `status` is one of `ok`, `provider_error`, `timeout`,
    `misconfigured` or `throttled`. It never returns program output, provider
    URLs, tokens or error text.
  - The body must be exactly `{"trigger":"schedule"}` or
    `{"trigger":"deploy"}`. Anything else gets `400`.
  - Nothing in the route throws.
- **Throttle.** A real run is claimed with one
  `INSERT … SELECT … WHERE NOT EXISTS … RETURNING id` statement into
  `app_logs`, against the database clock. The claim row records its trigger.
  - Real runs are at least 30 minutes apart.
  - Each trigger has its own slot: one `schedule` claim (daily schedule or
    manual dispatch) per 20 hours, and one `deploy` claim per 24 hours. A
    burst of deploys cannot use up the scheduled run.
  - The claim and result rows use the `runner` source. `api/data.js` already
    rewrites that source to `client` for browser telemetry, so members cannot
    forge a claim or a cached result. Rows with a `user_id` are ignored.
  - Inside a window, the route returns `throttled`. `ageSeconds` is the age of
    the latest claim. `lastStatus`, `durationMs` and `checkedAt` come only from
    the result row that names that claim's id.
  - A missing provider configuration needs no I/O. It is reported as
    `misconfigured` at once, without a claim.
  - If the database is unavailable, or the cached result cannot be read, the
    route returns `503` and never executes.
- **Lost results.** A real run can lose its result if the function is killed
  (duration or memory limit, platform restart) or the write fails.
  - The latest claim counts as in flight (`lastStatus: null`, passing) only
    while it is at most 165 seconds old: the 45-second deadline plus 120
    seconds.
  - After that, a claim with no saved result reports
    `lastStatus: "result_missing"`, which fails the job until the next real
    run. The same applies to a saved entry that cannot be read.
  - So an older passing result can never stand in for a run that did not
    report.
- **Workflow.** New `execution-smoke` workflow.
  - Triggers: successful Vercel Production `deployment_status` events, a daily
    07:29 UTC schedule, and `workflow_dispatch`. No pull-request trigger.
  - `deployment_status` runs also require `deployment.creator.login ==
    'vercel[bot]'`. Every job that uses the `production` environment records a
    lowercase `production` deployment, and GitHub expression comparison
    ignores case. Without the check, the job's own deployment would trigger it
    again.
  - It runs with `contents: read` in the `production` environment and reads
    only `vars.APP_URL` and `secrets.CRON_SECRET`.
  - It sends `deploy` for `deployment_status` runs and `schedule` otherwise.
  - It runs the default-branch `scripts/github-execution-smoke.mjs`. That
    script fails unless each language is `ok`, or `throttled` with a cached
    `ok` (or a run in flight). It prints only validated categories, and adds a
    `::notice` when it passes on a cached result.
  - `production-smoke` gets the same `vercel[bot]` creator check, so these
    environment deployments no longer trigger it.
  - `check:deployability` pins the workflow and assessor digests and allowlists
    exactly those two references, following the ID-67 precedent.

**Budget.** Each real run creates two sandboxes. The hard ceiling is 70 runs a
month: 38 scheduled and 32 post-deploy. That is 140 creations and about 4.6
GB-hours, against the Hobby allowance of 5,000 creations and 420 GB-hours.
Expected use is one scheduled run a day plus one post-deploy run on deploy
days.

**Trade-offs.**
- On a day with several deploys, only the first post-deploy run is real.
  Later runs report the cached result and its age.
- A cached failure, or a lost result, keeps the job red until a real run
  passes. That can take up to a day when the relevant slot is used, but a
  throttled run can never hide the last failure.
- GitHub can start a scheduled run hours late. If the next day's run then
  falls inside the 20-hour slot, it is throttled that day. Post-deploy runs
  still give a real run on deploy days.
- A post-deploy run is triggered by `vercel[bot]`'s deployment, so GitHub
  probably emails no one. Its failure shows as a red check on the `main`
  commit. The scheduled run is the email path.
- Vercel deploys by commit SHA. If the `production` environment later gets a
  "main only" branch policy, the post-deploy trigger may be refused. The daily
  run is then the backstop.

**Function duration.** `vercel.json` sets no `maxDuration` for `api/ops.js`.
The project was created in August 2026, after Fluid compute became the
default, so the expected limit is the Fluid default of 300 seconds. A smoke
request takes at most about 50 seconds: two languages in parallel under a
45-second deadline, plus database calls. A shorter effective limit would cut
runs off before their result is saved. The route would then report
`result_missing`, so the problem shows as a failing check instead of a false
pass.

**Not done.** A Resend sender-domain readiness probe. Resend's domain API
needs a full-access key, and the bootstrap guide provisions a send-only key
restricted to one domain. Adding a broader production secret only to read
domain status would widen privilege, and a send-only key cannot read it. A
Google OAuth configuration probe is already covered by `production-smoke`
(`/api/auth/capabilities`).

**Alternatives.**
- A Vercel cron: Hobby allows few crons, and a cron alone cannot follow
  deploys.
- Running the smoke from CI with a long-lived Vercel token: a new broad
  secret.
- A test-only member account driving `/api/execute`: a credential to manage,
  and real user data in the path.
- Only a 30-minute throttle: the worst case is about 2,900 creations a month.
- One shared budget of two runs a day (the first version of this change):
  with several deploys a day, deploy runs used both runs and the scheduled
  run was usually throttled.

**Rollout and recovery.** Merge. Nothing changes for users. The workflow fails
with `config_missing`, `misconfigured` or `unavailable` until the production
setup it depends on is complete (bootstrap guide sections 0 and 10.0). To
pause it, disable the workflow in GitHub Actions. To remove it, revert this
change. The `app_logs` rows are ordinary log rows and fall under the 30-day
retention (ID-72).

### ID-74 addendum: drop environment deployments whose status links to GitHub (#342)

When Vercel's deployment starts a workflow, the run is attributed to
`vercel[bot]`. The lowercase `production` environment deployment its job
records is therefore created by `vercel[bot]` too, and it passed the creator
check. Run 39731099057's environment deployment started a real
`production-smoke` run (39731123064) two seconds later.
- Both workflows now also require
  `!startsWith(github.event.deployment_status.target_url, 'https://github.com/')`
  on `deployment_status` runs. The `vercel[bot]` creator check stays.
- Checked read-only against the deployments API. All 37 recent successful
  `Production` statuses (Vercel's) link to `*.vercel.app`. GitHub environment
  deployments, including the one created by `vercel[bot]`, link to
  `https://github.com/…/actions/runs/…`.
- The URL is event data, so it appears only in the job `if:` condition.
  `check:deployability` requires the clause in both conditions.
- Outside the conditions, the gate rejects any read of the event payload in
  either file: `github.event` or any property or index of it, an index into
  `github`, `toJSON(github…)`, `GITHUB_EVENT_PATH`, or `target_url`.
  - The one exception is `execution-smoke`'s reviewed default-branch checkout
    ref.
  - `production-smoke` is not digest-pinned (other changes edit it), so this
    broad rule, not a pin, is what keeps event data out of its steps.
- The execution-smoke workflow digest pin is updated.

## ID-75: Give the backup watchdog an eight-hour grace for late GitHub schedules

Status: implemented as an operations change. No feature flag, migration,
secret, permission, or provider change. Issue #324, follow-up from #51.

**Context.** GitHub started the Monday 03:17 UTC Turso backup-restore rehearsal
about 5h40m late. The hourly watchdog (ID-16, ID-54) required a current-slot run
after a two-hour grace and treated any run still unfinished at 06:47 UTC as
stuck, so it raised `run_missing` before the late run arrived. GitHub delays
scheduled workflows routinely (compare ID-67), so this would recur.

**Decision.** Widen the reviewed slot grace from two to eight hours
(`WATCHDOG_SLOT_GRACE_MS: '28800000'`). The absolute slot deadline stays the
grace plus the 90-minute stuck-run allowance, now nine and a half hours
(`'34200000'`, the 12:47 UTC tick). Both values are named constants with this
rationale in `scripts/check-backup-controls.mjs`, which pins them and the new
workflow digest. The assessor already accepted a grace of up to 24 hours, but
it capped the deadline at four hours, and because the deadline must exceed the
grace that effectively capped the grace too. Both ceilings are now 12 hours
(`MAX_SLOT_ALERT_DELAY_MS`), so even the loosest accepted setting alerts by the
first hourly tick after 15:17 UTC, well inside one day.

- A drill that starts up to eight hours late and finishes by 12:47 UTC never
  alerts. Starts up to 8h29m late are tolerated only when the 11:47 watchdog
  tick runs on time (no delayed earlier tick or manual dispatch between 11:17
  UTC and the start). A run that starts after 11:17 UTC has less than the
  90-minute stuck allowance and may report `run_stuck` even if it later
  succeeds, so on-call should check the run before dismissing the alert.
- Before 11:17 UTC the prior week's success still counts; at the end of grace
  it is at most seven days and eight hours old, so the eight-day freshness
  bound is unchanged.
- A missing drill alerts `run_missing` at 11:47 UTC, a failed one `run_failed`
  at the next tick (even inside grace), and an unfinished one `run_stuck` by
  12:47 UTC. All of these happen the same Monday, inside one day of the slot.
- Every other category and rule (stale, artifact, corrupt, API, monitor
  `cleanup_failure`) is unchanged.

**Trade-off.** A drill that never starts is now reported at 11:47 UTC instead
of 05:47 UTC. That is acceptable for a weekly drill: the alert still fires the
same Monday, and the prior evidence it relies on until then is still fresh.

**Alternatives.** Moving the trigger to an external scheduler (as ID-67 did for
the outbox) would need a new secret and dispatch permission, which the watchdog
deliberately lacks. Moving the cron earlier does not bound GitHub's delay.
Measuring lateness from run creation would let a late run reset the deadline.
A one-day grace would delay a real missed-drill alert by most of a day.

**Rollout and recovery.** Merge; the next hourly watchdog uses the new policy.
To recover, revert the commit, which restores the two-hour grace, the 06:47 UTC
deadline, and the previous digest together. Contract:
[`TURSO_BACKUP_RESTORE_REHEARSAL.md`](TURSO_BACKUP_RESTORE_REHEARSAL.md).

## ID-76: Compute each member's progress on request from their own records, behind a flag

Status: implemented behind `PROGRESS_DASHBOARD_ENABLED` (default off); no
migration. Issue #293 (post-MVP roadmap #312). Final layout and copy are
pending (`needs-design`).

**Context.** History listed past pairings, but a member could not see whether
they were keeping the weekly habit the product is built around, which patterns
they had covered, or how their runs were going. Completion receipts (ID-55),
attested runs, explicit availability decisions and shared session controls
already hold every fact needed.

**Decision.**
- `GET /api/progress` returns the signed-in member's completed sessions,
  current and longest weekly streak, a 12-week series of session status and
  verified runs, catalogue coverage by pattern (`type`) and topic (`tags`)
  including untouched ones, and interview-role balance when shared session
  controls exist. A `feedback` seam waits for #290.
- Only the session chooses whose records are read. `user_id` is accepted only
  so a request for anyone else is an explicit `404 progress not found`; owners
  and admins get the same answer.
- Counts reuse the existing projections: unanimous receipts as History, recap
  and `/api/stats` count them (non-demo, like `your_sessions`), and the recap's
  attestation check for runs. History also lists demo-week pairings, so the
  response reports them as `demo_pairings` and the UI says "Demo sessions
  aren't counted here." A real-runtime test checks the relationship.
- Streak rules v1: a week counts when every participant of a partnered session
  confirmed it. "Skip this cycle", solo (odd member out) and unpaired weeks
  pause; the current unconfirmed week is neutral; a finished partnered week
  without unanimous receipts (including none) ends the streak. Weeks are
  pairing cycles in `PAIRING_TIME_ZONE`, stepped by local calendar so DST weeks
  stay consecutive.
- Reads are one clock query plus one read batch of three bounded statements:
  the pairing window (`LIMIT 261`) with its controls and receipts by primary
  key, skip decisions up to now (`LIMIT 260`, a primary-key lookup per cycle),
  and the newest runs (`LIMIT 501` through `idx_runs_user`; code only for pair
  room runs). With no index on a pairing member, the pairing window scans
  `pairing_groups` once, as History and `/api/stats` already do. No table,
  index, cache or job.
- History learns the flag from `progress: {enabled: true}` on `/api/history`
  and only then imports `assets/progress-view.js`. Charts are aria-hidden SVG
  with design tokens, each with a text summary and a shared weeks table.

**Deferred.** The optional weekly summary line in the pairing email (#334: it
needs progress reads inside the outbox budget and a preference rule) and
feedback trends by rubric dimension (#335, blocked by #290).

**Alternatives.** Precomputing weekly rows (a migration and a second truth
source that can drift from receipts). A separate tab (the spec puts past
cycles and recaps in History). A chart library (weight, CSP and theming for
four small charts). Breaking the streak on any week without a session (shames
members who said they were away or had no partner).

**Rollout and recovery.** Merge with the flag unset; nothing changes. The
owner sets `PROGRESS_DASHBOARD_ENABLED=true` in Vercel Production and redeploys;
unsetting it restores the previous behaviour. Contract:
[`PROGRESS_DASHBOARD.md`](PROGRESS_DASHBOARD.md).

## ID-77: Suggest next exercises from verified history, without a migration

Status: implemented behind `EXERCISE_SUGGESTIONS_ENABLED` (default off); no
migration. Issue #296 (post-MVP roadmap #312). The visual design is
provisional (`needs-design`).

**Context.** Pairs chose exercises by scrolling a list. Nothing showed what
either partner had already done, which topics they had never covered, or what
a sensible next difficulty was. Run history (#20) and session completion
(#218) already record what each member attempted.

**Decision.**
- `GET /api/exercise-suggestions[?room_id=week_<w>_pair_<p>][&hidden=a,b]`
  (data handler, `api/_exercise-suggestions.js`). It needs a session and is
  read-only (`SELECT` only, no request-path DDL). With the flag off it returns
  `404 {code:'feature_disabled'}`, and `GET /api/questions` is byte-for-byte
  unchanged; with the flag on, `/api/questions` adds
  `features:{exercise_suggestions:true}` and only then does the client fetch
  `/assets/exercise-suggestions.js` (on demand, never a static script tag).
- Response: `{ok, mode:'solo'|'pair', room_id, partner_count,
  attempted:[{slug, by_me, by_partner}], suggestions:[{slug, version, title,
  difficulty, topic, reason:{code, difficulty_step, text}}], hidden_count,
  empty_reason}` where `hidden_count` counts only hidden exercises that could
  otherwise be suggested and `empty_reason` is `null`, `all_attempted`,
  `all_hidden` or `no_exercises`. Errors: 400 (unknown, repeated or malformed
  query parameter; a slug repeated in `hidden`; more than 50 hidden slugs),
  401, 404 `pair not found`, 405, 503.
- "Attempted" means a verified run (a `session_runs` row whose server
  attestation still verifies; the newest three runs per exercise are checked)
  or a completed
  session (every signed-in participant confirmed; the room's workspace
  exercise and any edited shared code document count). Only active catalogue
  exercises are considered. The run check is the run feed's "verified" rule
  without reading the stored code: the HMAC still binds the code hash with the
  member, exercise, room and results, and an attempt does not depend on the
  code.
- Reads are bounded: one `db.batch(…,'read')` (one read transaction) with
  two statements per member, plus, for a pair, the pair authorization repeated
  first and the partners' newest 100 runs in the current room. A partner
  removed after the preflight check is dropped from that response, and a
  viewer who lost access gets the 404.
  Runs come from a per-exercise `ORDER BY id DESC LIMIT 3` lookup on the
  `(user_id,question_slug)` index (covering, flat as history grows; about
  0.4 ms at 8,000 runs locally), never `code`. Completed sessions are capped at
  200 and joined to snapshots and code documents by key with `CROSS JOIN`, so
  the plan does not depend on `ANALYZE` statistics.
- Solo requests read only the requesting member's rows. A `room_id` is
  authorized with `api/_pair-access.js` (including the active primary-circle
  membership join while `CIRCLE_MEMBERSHIP_ENABLED` is on), and only while the
  pair is in the newest non-demo pairing week (the current pair; an admin demo
  shuffle does not retire real pairs). Partners are the other
  signed-in participants of that pair who are still active members of the same
  circle. Another pair's room, an older pair, a removed member and a member of
  another circle all get the same 404. The client then falls back to solo.
- Privacy: outside the current room, the partner's history is reduced on the
  server to the set of exercises they attempted before the rule runs, so
  those attempt times cannot change any pick, `difficulty_step` or reason (a
  test moves a partner's runs outside the room and requires a byte-identical
  response). Partners' verified runs in the current room also count toward
  recency: both partners already see those runs, with runner and time, in the
  room's run feed, so nothing new is revealed and partners working together
  step up together. History leaves the server only as `by_partner` booleans.
  No scores, code, dates, run ids, user ids or names are returned. The pair
  card says: "Skips exercises either of you has attempted. Your partner sees
  only which exercises you have attempted, never scores, code or dates."
- Selection rule (deterministic, unit-tested): candidates are active exercises
  nobody in the request has attempted and the member has not hidden. A topic's
  coverage is how many attempted exercises carry it (tags; the pattern when an
  exercise has no tags), and a candidate's coverage is that of its
  least-covered topic; partner attempts count here and for exclusion. The
  target difficulty is one step above the hardest of the three most recent
  attempts among the member's own history and the partners' runs in this
  room (Easy with no history, capped at Hard). Order:
  lowest coverage, then closest to the target, then the easier of two equally
  distant levels, then slug. After each pick its topics count once more, so
  the next pick prefers another topic. At most three. Each suggestion carries
  a plain reason, for example "Neither of you has practised graphs yet. One
  step up from your recent Easy exercises."
- UI (room Problem panel, WP-K): a "Suggested for you in this pair" /
  "Suggested for you" card (each partner's own history outside the room can
  still make the two lists differ, so the heading does not promise one shared
  list) under the exercise picker with a Hide button per suggestion and
  "Show n hidden exercises"; an "Attempted by you" / "Attempted by your
  partner" chip on browse cards (`data-testid="catalog-attempted"`) and the
  same words appended to the picker option. Choosing a suggestion goes through
  `#questionSelect`, clearing filters that hide it. Existing ids and test ids
  are unchanged. Logic is in `assets/exercise-suggestions.js` and
  `assets/catalogue-view.js`.
- Hidden exercises are stored in the browser (`localStorage`
  `randori-hidden-suggestions:<user id>`, at most 50, oldest dropped first)
  and sent with each request so the server can skip them. Slugs that can never
  be suggested again (attempted by the member, or no longer in the catalogue)
  are pruned from storage after each response; partner-attempted slugs stay,
  since they become suggestable again in solo practice.

**Trade-off of the client-side hide list.** It needs no schema change and the
server never stores it, but it is per browser: it does not follow the member
to another device, is lost when site data is cleared, and anyone with access
to that browser profile can read which exercises were hidden. The server
treats it as an untrusted, bounded filter on the member's own suggestions
only.

**Deferred.**
- A server-side hide list (a per-member preference table needs a managed
  migration and a protected production apply before merge is safe).
- A setting to stop sharing "attempted" status with a partner (the issue's
  privacy note). The server must read the partner's choice when the viewer
  asks, so it also needs stored per-member state and a migration. Until then
  sharing is per deployment: the owner enables or disables the whole feature.
- The suggestion card on Home before a session (the room card covers pair and
  solo practice).

**Alternatives.** A suggestions table refreshed by a cron (a migration and
stale data for a cheap, bounded read). Ranking by tags and pattern together
(each pattern is nearly unique, so every candidate would tie at zero
coverage). Returning the partner's attempt dates to explain recency (leaks
more than "attempted by your partner").

**Rollout and recovery.** Merge with the flag unset; nothing changes. The
owner sets `EXERCISE_SUGGESTIONS_ENABLED=true` in Vercel Production and
redeploys. To recover, unset it and redeploy; nothing is stored server-side.

## ID-78: Show owners aggregate circle health from existing tables behind a flag

Status: implemented behind `CIRCLE_HEALTH_ENABLED` (default off); no
migration. Issue #292 (post-MVP roadmap #312, Wave 3). Final design is
pending (`needs-design`).

**Context.** The README's first next step is to measure completed sessions,
but an owner could not see where members drop off: at availability, at
scheduling, or at the session. There is no product analytics, and a
third-party tracker would conflict with a private circle.

**Decision.**
- `GET /api/circle/health` (rewrite to `/api/ops?endpoint=circle-health`)
  returns, for the selected circle's last 8 **settled** cycles, member counts
  for available, paired and solo, the number of pairs, the number of pairs
  that agreed a time and that completed (primary circles only), and the
  repeat-pair rate against the 8 cycles before. A cycle is settled 49 hours
  after it ends: completion counts only receipts confirmed within 48 hours of
  the end, and the extra hour covers clock skew, so a shown completed count
  never changes. The current cycle is never returned. Cancellations, no-shows
  and the median time to agreement are in the contract as `not_tracked`.
- Everything is computed per request with read-only statements over the
  existing publication, schedule, completion-receipt (ID-55) and v13/v16
  secondary tables: no table, cache row, index or migration. One `read` batch
  gives a single snapshot; the owner check is its first statement and a guard
  CTE inside every data statement. Any active owner of the unarchived circle
  may read it (ID-69); members, demoted or inactive owners, archived circles
  and other circles get 403.
- Suppression runs on the server before the response is built, counted in
  pairs because people act in pairs. With fewer than 4 pairs, agreed,
  completed and repeat are always hidden (with 3 pairs only 0 or 3 could
  show, and both disclose every pair). With 4 or more, a count is hidden
  when exactly one pair is in or out of it, and agreed and completed are
  hidden together. An exhaustive test over every pair state for 1 to 6 pairs
  shows no hidden cell is determined by the rest of a response. A shown 0 or
  "every pair" still tells an owner every pair's state; that is the only way
  the owner learns another named pair's state (2.7% to 12.5% of cases for 4
  to 6 pairs), the same test checks it, and the Privacy Policy will say so
  once #336 merges. Available, paired, solo and pairs describe the published pairing, which
  every member saw, and are shown. The response has no ids, names or emails.
- The flag gates the route (404 with no storage access), the `circleHealth`
  capability and the owner card. The card's module is imported only when the
  capability is on and the owner opens the Circle view, and one copy per
  circle context is kept for 5 minutes.

**Read budget.** Every statement uses an existing index except the primary
group read: `pairing_groups` has no `week_id` index, so that read scans the
table, as `/api/stats` and history already do. A `pairing_groups(week_id)`
index stays on the backlog for a future managed migration.

**Residual risk.** Agreements have no history, so a partner who clears an
agreement, or accepts a new future time, in a past week's room after that
cycle appears can change its agreed count or turn it Hidden; comparing the
two views can reveal the new count and, with what the owner knows, possibly
which pair changed. It needs someone to act on a past week's room, which the
product does not prompt. Late completion confirmations no longer have this
effect.

**Deferred.** The median time from pairing to agreement needs a stored
agreement timestamp (`pair_schedules.updated_at` changes on later proposals).
The review of the first version showed that a publication-to-session median
measured something else, and that its status and value revealed a hidden
agreed count and another pair's session time. Cancellations and no-shows wait
for #291. Trends beyond 8 cycles, per-member views (out of scope) and a
server-side cache.

**Alternatives.** Member-count thresholds (with pairs, "hidden" could only
mean one value, so it revealed the other pair's state). Hiding every cell of
a small cycle including the published pairing (no privacy gain; the pairing
was visible). Showing the current cycle with live counts (polling showed which
pair just acted). A nightly aggregate table (a migration, a scheduler and
stale numbers for little saving at this size). An in-memory cache across
requests (cannot be invalidated on demotion and is per serverless instance).

**Rollout and recovery.** Merge with the flag unset; nothing changes. Agree
the threshold with the owner, then set `CIRCLE_HEALTH_ENABLED=true` in Vercel
Production and redeploy. To recover, unset the flag and redeploy; there is no
stored state. Contract: [`CIRCLE_HEALTH.md`](CIRCLE_HEALTH.md).

## ID-79: Serve the privacy policy and terms as static, script-free public pages

Status: implemented; no migration, no flag (the pages must be public while
signed out). The text is a plain-English draft for the owner to review; it is
not legal advice.

**Context.** Google sign-in is in Testing, so only listed test users can sign
in. Publishing it needs Google Cloud's Branding page filled in, which asks for
an app home page, a privacy policy link and a terms of service link, and
Google expects the home page to link the privacy policy. Randori had only the
short in-page "Privacy note" on the landing page.

**Decision.**
- *Two root documents.* `privacy.html` and `terms.html` live beside
  `index.html`. Under `cleanUrls`, Vercel serves them at `/privacy` and
  `/terms` from the filesystem before any rewrite, so they never reach the SPA
  fallback and never load the app shell; `/privacy.html` redirects to the
  clean URL. `vercel.json` is unchanged.
- *One route table.* `scripts/public-pages.mjs` maps the two clean paths to
  their files. The local dev server and the e2e static server serve them from
  it (as their own documents, with the usual local headers), the routing
  contract test checks each resolves to its file under the Vercel model, the
  deployability check requires both files, the production smoke check fetches
  both (200, HTML, a `data-public-page` marker, not the shell, the page
  security headers), and the real-runtime fixture and screenshot pipeline
  stage them.
- *Static and tighter.* No scripts, forms, images or inline styles. Each page
  adds a meta CSP (`default-src 'none'; style-src 'self'; font-src 'self';
  img-src 'self'; base-uri 'none'; form-action 'none'`) on top of the
  site-wide header policy, so it can make no API requests (no `/api/logs`, no
  auth) and load nothing third-party. They share `assets/legal.css`, which
  copies the Dojo Indigo tokens from `index.html` (a unit test fails on drift)
  and follows the system colour scheme. Landmarks (banner, main, contentinfo,
  a "Legal" nav), one `h1`, no skipped heading levels, a skip link and a
  "Back to Randori Circle" link.
- *Links.* The landing footer links "Privacy Policy" and "Terms of Service"
  (replacing the footer's in-page `#landingPrivacy` link; the request form
  keeps that one). The in-page privacy note now says members also see
  profile details and who is paired with whom, but not email addresses, and
  links both pages. Signed-in members get both at the end of the account
  menu, after a separator (existing order unchanged), opening in a new tab so
  a live call or room is never dropped. The sign-up dialog shows one line
  linking both, only in sign-up mode (`#authLegal`).
- *Browser Sentry reports errors only.* The loader's dashboard config turns
  on tracing (rate 1), session replay (0.1, and 1 on error) and logs.
  `Sentry.init` in `randoriSentryConfig` now sets `tracesSampleRate:0`,
  `replaysSessionSampleRate:0`, `replaysOnErrorSampleRate:0` and
  `enableLogs:false`, which override those defaults, so the policy's "no
  session recording or performance tracing in your browser" holds; a unit
  test pins them. The CSP is unchanged.
- *Content from the code.* The policy was written from an inventory of the
  data flows: Google scopes `openid email profile` with `access_type=online`
  (only `sub`, verified `email` and `name` are used; no picture, no stored
  access or refresh token), bcrypt password hashes, the 12-hour
  `randori_session` cookie, every Turso table holding personal data, Vercel
  (Dublin), Turso, Resend, Sentry, the Vercel Sandbox or self-hosted runner,
  Google STUN for peer-to-peer calls, cdnjs/jsDelivr/unpkg for the editor,
  optional consent-gated Groq/OpenAI feedback (off by default), and no
  analytics. Retention is stated only where code defines it: `app_logs` 30
  days (ID-72), video signals about an hour, editor and whiteboard drafts 90
  days, invite requests 30 days (purged weekly, so up to about 37), links 30
  minutes or 7 days, sessions 12 hours (records 30 days after expiry);
  everything else while the account exists. Two gaps are stated plainly:
  email records in the outbox (plain-text recipients for sign-up, reset and
  pairing mail, encrypted copies for invitations) and unfinished sign-ups
  (`auth_email_activations`) are not deleted automatically today. Chat
  retention (90 days) is not described as active because its purge is still
  disabled. GitHub is listed as a provider (code, issues, scheduled jobs and
  the weekly restore rehearsal, which keeps only counts and checksums).
  Circle health (ID-78, flagged off) is disclosed as owner-visible counts
  per finished week with small or single-pair cells hidden, noting that an
  all-or-none count shows every pair's state. Practice suggestions (ID-77,
  flagged off) are disclosed as "attempted" marks a current partner sees.
  Browser Sentry reports are described with their breadcrumb trail.
- *Deletion and contact.* There is no self-service deletion (leaving or
  removal only makes a membership inactive), so the policy explains how to
  ask: by email, or through the circle owner. Circle owners can't delete
  accounts; the operator deletes on request and responds within one month.
  At the
  owner's request the policy names the operator (Festus Omole, based in the
  United Kingdom) and publishes one private contact address for privacy and
  deletion requests and security reports, on both pages; the public issue
  tracker stays as an option for general questions, with a warning not to
  post personal information there. A unit test allows exactly that one
  address.
- *Google disclosure.* The policy states that Randori's use and transfer of
  information received from Google APIs adheres to the Google API Services
  User Data Policy, including the Limited Use requirements, and that the data
  is not sold, not used for advertising and not transferred except to run the
  service or when the law requires it.

**Alternatives.** Render the pages inside the SPA (needs JavaScript and the
app shell, and would send signed-out visitors through auth boot and client
logging). A Vercel rewrite per page (the filesystem already wins under
`cleanUrls`). A feature flag (the pages exist to be public). Extracting the
`index.html` tokens into a shared stylesheet now (a large `index.html` edit
while other work is in flight; the drift test keeps the copy honest).

**Rollout and recovery.** Merging publishes both pages on the next production
deploy and the `production-smoke` workflow then checks them. The owner reads
the text and enters the URLs on Google Cloud's Branding page. To withdraw,
revert this change.

*Update, 22 October 2026:* the policy now describes practice suggestions
(ID-77), circle health (ID-78), self-service deletion (ID-81), reminders
(ID-71) and email-record retention (ID-83) as on, ahead of the owner turning
their flags on in production; the "switched off" caveats are gone.

## ID-80: Make randoricircle.com the canonical origin; keep the old Vercel alias for the API

Status: implemented as an infrastructure change. No feature flag, migration,
secret or permission. It must merge together with the `APP_URL` switch, in the
order below.

**Context.** Production ran on `https://randori-circle-self.vercel.app`. The
owner bought `randoricircle.com`, attached it and `www.randoricircle.com` to the
Vercel project, and already sends email from it. `APP_URL` drives the Google
redirect URI and every email link, and Google OAuth is accepted only on the
`APP_URL` host (`api/_auth-config.js`). The browser Sentry gate and the client
logger's production policy key off one hard-coded origin. cron-job.org, the
GitHub outbox workflows and links in emails already sent all call the old host.

**Decision.**
- `https://randoricircle.com` is the production origin in code: the Sentry and
  client-logger gate in `index.html` (other `*.vercel.app` hosts, now including
  the old alias, stay `preview`), the session-link fallback, the smoke and
  screenshot defaults, tests and runbooks. `scripts/canonical-domain.mjs` holds
  the origins and the exact redirect rules.
- `vercel.json` gets two host-conditional redirects. Vercel compiles
  `redirects` after the cleanUrls redirects and before headers, the filesystem
  and all rewrites, so they run before the SPA fallback. A string `has` value
  is a regular expression, so the host values escape their dots
  (`www\.randoricircle\.com`, `randori-circle-self\.vercel\.app`) and match
  exactly one host; preview and deployment hosts never match:
  - `www.randoricircle.com`, source `/:path(.*)`, 308 to
    `https://randoricircle.com/:path`. `/:path*` was rejected because Vercel
    compiles it strictly and it does not match `/`, so the bare www host would
    not redirect.
  - `randori-circle-self.vercel.app`, source `/:path((?!api(?:/|$)).*)`, 307 to
    `https://randoricircle.com/:path`. It is temporary so a rollback is not
    pinned in browser caches, and it excludes `/api` and `/api/*` so
    cron-job.org, GitHub workflows and in-flight calls keep working on the old
    alias, which stays attached as an API alias.
- Query strings pass through, as Vercel already does for the cleanUrls
  redirects, and browsers keep the `#fragment`, so old `/invite#invite=…`
  links still open the invitation. Headers and CSP are host-agnostic
  (`'self'`), so nothing else changes per host.
- `check:deployability` pins the whole `redirects` array, so an extra rule
  fails too.
- `smoke:production` defaults to the canonical origin and adds three checks
  against it: the old alias's page redirect (temporary, same path and query),
  the old alias's `/api/health/live` (200, no redirect; liveness, so a
  database outage is not reported as a routing failure), and www's permanent
  redirect. Google sign-in is advertised only on the `APP_URL` host, so the
  script reads which host advertises it. While that is the old alias, it skips
  the three checks with the reason printed and does not expect `googleOAuth`
  on the canonical host, but only while the old alias still serves its own
  pages. If they already redirect away (merged before the switch, or `APP_URL`
  drifted back), Google sign-in is unreachable and the run fails. On a legacy
  base URL it follows the canonical redirect for page paths.
- The Google client lists both origins and both redirect URIs during the
  transition, so either `APP_URL` works and a rollback needs no Google change.

**Consequences.** Sessions are host-only cookies, so every member signs in
again once; per-origin browser settings start fresh. HSTS with
`includeSubDomains` now applies to every `*.randoricircle.com` host. If Sentry
limits Allowed Domains, `randoricircle.com` must be added.

**Alternatives.** Vercel's dashboard domain redirect for the old alias cannot
exclude `/api/*` and would break cron-job.org and in-flight calls. A
permanent redirect for the old alias would be cached by browsers and make a
rollback stick. Accepting OAuth on both hosts would need two redirect URIs in
code and would split sessions across hosts. Edge middleware would add a
runtime to every request for what static rules do.

**Rollout and recovery.** After the preflight (PR clean and green, readiness
200, no auto-merge armed, no Production build building or queued), the order
is: Google client origins and redirect URIs, then the GitHub `production`
`APP_URL`, then Vercel `APP_URL` immediately followed by a manual merge. Next,
confirm the Production deployment is the merge commit, move the cron-job.org
URL, and verify. To roll back, use Instant Rollback to the pre-change
deployment, restore both `APP_URL` values, revert the merge commit and
re-promote. cron-job.org works on either host. Runbook:
[`PRODUCTION_BOOTSTRAP_GUIDE.md` section 12](PRODUCTION_BOOTSTRAP_GUIDE.md#12-canonical-domain-id-80).

## ID-81: Let members delete their own account by tombstoning it in one transaction, behind a flag

Status: implemented behind `ACCOUNT_DELETION_ENABLED` (default off, and only
with `CIRCLE_MEMBERSHIP_ENABLED=true`); no migration. Issue #339 (split from
#338, roadmap #312). Visual design is provisional (`needs-design`).

**Context.** Leaving a circle or being removed only made a membership
inactive, so members had to ask an owner to delete their data. Partners'
pairings, completion receipts, schedules, session controls and code documents
reference the account through RESTRICT keys and immutability triggers, and the
membership-readiness gate requires every non-demo account to keep its audited
provenance, so the account row itself cannot be deleted.

**Decision.**
- `POST /api/auth/account/delete` with exactly `{"confirm":"DELETE"}` deletes
  the signed-in member's account; `GET` reports eligibility for the settings
  card. The session alone chooses the account. With the flag off the path is
  an unknown auth endpoint and `accountDeletion` is not advertised.
- One write transaction checks the session's recent-auth proof (password or
  Google, existing `api/_recent-auth.js`) and the rules before any change: the
  only active owner of a circle is refused with the circles to hand over
  (`make_owner`, or archive a secondary circle); the last active app admin is
  refused; demo accounts are refused.
- The account row is tombstoned: email `deleted-<id>@account-deleted.invalid`,
  a non-bcrypt password marker, name "Deleted member", profile cleared,
  `google_sub` cleared, `is_admin=0`, `is_demo` unchanged. Sessions are revoked;
  recent proofs, session circle contexts, Google identity and email state,
  password resets, availability, preferences, solo runs, meeting links they
  added, their AI sessions, consents and quota rows, and their log rows are
  deleted; chat text becomes "Message deleted"; non-shared pair-run code is
  cleared; the activation and accepted invitation are scrubbed; unused
  invitations they sent are revoked and audited; pending invite requests from
  their email expire; outbox mail to them is suppressed with an
  `ACCOUNT_DELETED` audit row and their address and envelopes are scrubbed;
  memberships become inactive members. One `account.deleted` circle audit
  event per circle carries only ids and time. The inventory lives in code
  (`ACCOUNT_DATA_INVENTORY`) and a test fails when a new table is not
  classified.
- Partners keep their history: every pairing surface resolves the id to
  "Deleted member", the current primary and secondary pairings keep the
  tombstone instead of failing closed or hiding the pair, the owner roster
  hides it, and reactivation is refused.
- Request paths that write to an account by id skip a tombstone
  (`LIVE_ACCOUNT_SQL`), so a sign-in, `ADMIN_EMAILS` grant, profile save,
  Google link, preference save or solo run authenticated before the commit
  cannot write into it afterwards. Every change is sent as one batch inside the
  transaction.
- A retry with the old signed cookie is answered `already_deleted`; the
  deletion is idempotent and concurrent requests serialize on the write
  transaction. The same email can join again as a new account.
- The settings card and dialog are `assets/account-deletion.js`, imported only
  while the capability is advertised: re-auth, type DELETE, final confirm,
  then storage is cleared and the landing page shows a notice.

**Alternatives.** A hard delete with cascades (breaks RESTRICT keys,
immutable receipts and readiness provenance). A new `deleted_at` column (a
migration and a protected cutover for no gain over the existing columns). An
asynchronous deletion job (a second state machine and a window where a
"deleted" member can still sign in). Leaving sent invitations live (a deleted
account would keep vouching for access).

**Rollout and recovery.** Merge with the flag unset; nothing changes. The
owner sets `ACCOUNT_DELETION_ENABLED=true` in Vercel Production and redeploys;
unsetting it hides the endpoint and UI. Deletions are irreversible by design.
Contract and inventory: [`ACCOUNT_DELETION.md`](ACCOUNT_DELETION.md).

## ID-84: Readiness accepts invitation acceptance via email activation

Status: implemented (production hotfix); no migration, no flag.

**Context.** On 2026-10-22 the first invitee joined through password sign-up
and email activation (`verifyEmailActivation` in `api/_email-activation.js`).
That path consumes the invitation and the activation, inserts the active
membership and records `activation.verified` with
`dedupe_key='activation-verified:'||<activation id>`. Membership readiness
(`db/membership-readiness.js`) accepted only `membership.backfilled` and
`invitation.accepted` provenance, so the new account counted as
`invalidAccountProvenance`. `/api/health/ready` returned 503 and pairing
readiness (`requireClosedMembership`) failed.

**Decision.**
- Both `inspectCompletedMembershipRollout` and
  `inspectMembershipAdoptionReadiness` accept a third account provenance: an
  invitation in the primary circle used by the account (used, not revoked),
  its consumed activation in the same circle, and an `activation.verified`
  event in that circle whose actor and subject are the account, whose
  invitation is that invitation, and whose dedupe key is
  `activation-verified:<activation id>`.
- A new `malformedActivationAudits` count, a `closed_rollout_account_audit_invalid`
  blocker in both evaluators, rejects any `activation.verified` event whose
  invitation, activation, account, actor, circle or dedupe key do not line up.
  `verifyEmailActivation` is the only writer, it runs in one transaction, and
  it only creates new accounts (sign-up refuses an existing email and the
  account insert must return a row), so no legitimate activation audit exists
  without an accepted membership.
- The activation table arrived in schema v7 and the migration runner inspects
  adoption from v2. Each evaluator first checks `sqlite_schema` for
  `auth_email_activations` (read-only, DDL-free). Without it, every
  `activation.verified` event counts as malformed.
- The migration runner's adoption evidence fingerprint is unchanged. Its
  readiness result already comes from the updated evaluator, so a future
  cutover no longer refuses these accounts. Any activation join changes the
  fingerprinted accounts, memberships and used invitations, and any change
  that breaks an activation audit changes the readiness counts that
  `stateFingerprint` also covers. Leaving it unchanged keeps fingerprints taken
  before this deploy valid.

**Recovery.** Revert the commit. Readiness then fails again for every account
that joined by activation.

## ID-83: Expire recipient data in the email outbox after delivery, behind a flag

Status: implemented behind `OUTBOX_PII_RETENTION_ENABLED` (default off); no
migration. Issue #341 (split out of #338). Turning it on is destructive and is
an owner decision.

**Context.** Outbox rows kept recipient addresses and sealed credentials with
no time limit after an email was delivered, suppressed or dead-lettered. The
inventory of personal data in the outbox tables:

| Where | Personal data | What still needs it |
| --- | --- | --- |
| `pairing.email.requested` v1 payload | `recipient_email` (plain) | the handler and replay while actionable; unavailable evidence reads only `week_id`, `user_id`, `kind`; the legacy bridge reads only the key |
| `invitation.email.requested` payload | `credential_envelope` (AES-GCM sealed `{email, token}` under `INVITATION_EMAIL_ENCRYPTION_KEY`, envelope v1 or key-versioned v2 bound to the idempotency key), `email_hash`, `token_hash` | the handler and replay; owner resend reopens the latest envelope while the invitation is live (7-day TTL); send count and the rejected-email hint read only `invitation_id`; rotation metrics read envelopes of actionable rows and of a live invitation's latest event |
| `auth.emailverification.requested`, `auth.passwordreset.requested` payloads | `recipient_email` (plain), `token_envelope` (sealed token; 30-minute links) | the handler and replay; rotation metrics read actionable envelopes |
| schedule, secondary schedule, reminder, invite-request, secondary pairing payloads | internal ids, schedule instants or opaque fingerprints only | supersession, dedupe and suppression checks; no contact data |
| `idempotency_key` | internal ids, UUIDs and opaque hashes only; never an address | producer `ON CONFLICT` dedupe, reminder and legacy-bridge `NOT EXISTS`, provider idempotency |
| `provider_message_id` | a key into the provider's own logs, which hold the address | nothing in the app |
| other `outbox_events` columns | none (type, version, status, timestamps, counts, error codes) | health, the watchdog, diagnostics, metrics |
| `outbox_audit_events` | none: worker ids, `user:<id>` of the replaying admin, bounded reason codes (provider reasons are `status:name:reason`, PII-free by pattern) | health `recentRejectReasons`, diagnostics provider reason, replay audit |
| legacy `pairing_email_outbox` (pre-v6) | `recipient_email` (plain, `NOT NULL`), `provider_message_id`, free-text `last_error` | the bridge, only for actionable rows not yet copied into `outbox_events` |
| `outbox_invocation` app_logs rows | none (counts and codes) | diagnostics dispatcher evidence (30-day app_logs retention, ID-72) |

**Decision.**
- `api/_outbox-retention.js` runs from `/api/cron/outbox` after the delivery
  round and after `app_logs` retention, only when the flag is exactly `true`,
  with its own 2-second budget that must fit before the finalization reserve.
  It stops issuing statements when the budget ends, so it can never delay or
  fail mail; a slow or failed run is reported and retried by a later hour.
- Each run first claims the hour with one atomic `INSERT … WHERE NOT EXISTS`
  of a server `outbox_pii_retention` app_logs row with `user_id IS NULL`, so a
  run inside the hour, a concurrent run, or any member-written row changes
  nothing.
- Windows, each exclusive at the cutoff: delivered 7 days after
  `delivered_at`, suppressed 7 days after the suppression (`updated_at`), dead
  letters 30 days after `dead_lettered_at` so admin replay works for a month.
  Only the four types above are candidates, and only while a contact or
  credential field is present. Pending, retry and processing (leased) rows are
  never selected.
- Redaction removes `recipient_email`, `credential_envelope`,
  `token_envelope`, `email_hash` and `token_hash` with `json_remove`, adds
  `"retention_redacted":1`, and clears `provider_message_id`. Type, version,
  status, idempotency key, counts, error codes, timestamps and the audit trail
  are unchanged. The kept ids (`week_id`, `user_id`, `kind`, `invitation_id`,
  `activation_id`, `reset_id`) are internal references that unavailable
  evidence, send counts and the rejected-email hint use.
- An invitation event is skipped while its invitation is still live (unused,
  unrevoked, unexpired), because resend reopens the latest envelope. A legacy
  row gets the non-routable `redacted@redacted.invalid` (the column is
  `NOT NULL`), a cleared provider id and error text once it is older than 30
  days and was sent or already bridged; an unbridged actionable row is kept.
- Each class is one `UPDATE … WHERE id IN (SELECT … ORDER BY … LIMIT ?)` of at
  most 100 rows, oldest first. The candidate subquery runs inside the same
  write, so a concurrent claim, replay or second run cannot interleave, and a
  rerun only finds rows that still hold personal data. The response and the
  `outbox_invocation` row report `{ran, redacted:{delivered, suppressed,
  dead_letter, legacy_pairing}, more}`. Counts live in a caller-owned progress
  object, so a run that committed some classes and then timed out, failed or
  hit its budget is reported as `{ran:true, partial:true, …}` with what it
  committed (`failed_class` names a failed statement), never as "nothing
  happened". A failed, timed-out or partial run, of this job or of the ID-72
  `app_logs` retention, logs the invocation row at `warn`, not `success`.
- Replay of a redacted dead letter is refused whether or not the flag is on:
  `replayDeadLetter` only updates unredacted rows and then throws
  `OutboxEventRedactedError`, and `POST /api/admin/outbox/replay` answers
  `409 {code:"outbox_event_redacted"}`. The Admin Diagnostics dead-letter list
  keeps the row, adds `redacted:true`, says "recipient details removed by
  retention; cannot be replayed" and disables its Replay button; a replay
  started from an older snapshot gets "can't be replayed: its recipient
  details were removed after 30 days under the retention policy. Nothing
  changed."
- Credential rotation metrics (`readCredentialRotationMetrics` and the
  invitation metrics) skip redacted rows: they hold no envelope and are no
  longer actionable or resendable, so they cannot block key retirement.
- Dedupe is unchanged because keys are kept: re-enqueueing a redacted event is
  absorbed by `ON CONFLICT(idempotency_key)`, reminder and bridge `NOT EXISTS`
  checks still match, and terminal rows are never claimed again.
- Every delivery type is declared either in `OUTBOX_PII_EVENT_TYPES` or in
  `OUTBOX_PII_FREE_EVENT_TYPES`; a unit test fails when a new type is in
  neither list.
- Flag off: no statement from this job and no `outbox_pii_retention` key in
  the cron response or invocation row. The replay guard and the rotation-metric
  filter are always present but match nothing until a row has been redacted.

**Schema and scan cost.** No migration and no DDL. A terminal row's
`next_attempt_at` is its finalization instant and never later than its anchor
timestamp (finalization writes both from one instant, the lease sweep keeps
the earlier due time, the legacy bridge writes `now` to both; a unit test
drives every terminal path), so each class scan is a range on
`idx_outbox_events_dispatch`
(`status=? AND next_attempt_at<?`, no temporary sort) followed by a rowid
update, and the invitation guard is a primary-key lookup; a unit test checks
the plans with `EXPLAIN QUERY PLAN`. The scan still steps over rows redacted
earlier, so an hourly run reads every terminal row older than its window. That
is far less than the full-table metric and rotation reads every five-minute
invocation already does. The legacy table no longer grows and is scanned
whole. A partial index on unredacted rows would make the scan proportional to
the backlog; it needs a migration and is deferred until volume needs it.

**Alternatives.** Deleting rows (re-enqueueing the same key would send again,
reminder and bridge dedupe would re-queue, and audit rows reference events).
Hashing idempotency keys (they hold no personal data, and producers dedupe on
the exact key). Destroying only the envelopes (three types keep a plaintext
address). A weekly sweep (a backlog of a week at most 100 rows per class). A
`redacted_at` column with a partial index (cleaner, but needs a protected
migration cutover).

**Rollout and recovery.** Merge with the flag unset; nothing changes. **Do not
enable the flag until the matching Privacy Policy text is live** (the
"Email records" line in `privacy.html`, #336; the exact text is in PR #346).
That text says the record is kept as an operational record without the
address, that database backups keep unredacted copies for the provider's
point-in-time restore window (1 day on Turso's Free plan, per
`docs/PRODUCTION_BOOTSTRAP_GUIDE.md` §3.4; 10 or 30 days on paid plans), and
that an existing backlog clears over the following hours or days. Then the
owner sets `OUTBOX_PII_RETENTION_ENABLED=true` in Vercel Production and
redeploys; the backlog drains at up to 100 rows per class an hour. Redaction
cannot be undone, and redacted dead letters stay non-replayable after the flag
is unset.

*Update, 22 October 2026:* the "Email records" text is now in `privacy.html`,
with the 1-day backup window of Turso's Starter plan and the invitation guard
(an envelope is never removed while its invitation can still be used).

*Correction, 25 October 2026:* "Starter" is not a current Turso plan name —
the 1-day window is the Free tier's. See ID-89 for the verified plan list
(Free 1 day, Developer 10 days, Scaler 30 days, Pro and Enterprise 90 days).

## ID-82: Keep no raw IP address or user agent in app_logs

Status: implemented; no migration, no flag (privacy hygiene with no
user-visible change). Issue #340, split out of #338.

**Context.** Every `app_logs` writer copied the first `X-Forwarded-For` entry
into `ip` and the full `User-Agent` header into `ua`, and kept both for the
30-day retention (ID-72): client rows from `POST /api/logs`, server rows from
`api/data.js`, `api/ai.js` and `api/ops.js`, and the runner lease and quota
rows. Nothing read either column except the admin logs API. Rate limits never
used them: `auth_rate_limits` keys are already keyed hashes (SHA-256 with the
JWT secret per 15-minute bucket for auth, HMAC for invitation prepare and
invite requests), and the runner quota counts by `user_id`. No other table
stores an address or user agent: `auth_sessions`, `auth_identity_audit_events`,
`circle_audit_events`, `invite_requests`, `outbox_events` and
`outbox_audit_events` have no such columns or payload fields. The one other
place an address reaches the database is WebRTC signalling: offers, answers
and ICE candidates in `video_signals.payload` can carry network addresses.
They are needed to connect a call, readable only by the pair, and deleted
once older than an hour by the clean-up that runs on signalling requests (so
while no call is in progress, the last call's rows wait for the next one).
This change leaves them as they are.

**Decision.** `api/_log-privacy.js` reduces both values for every writer
(`appLogClientFields`); the columns stay.
- `ip` is NULL on every row with a `user_id`: client rows from
  `POST /api/logs`, runner rows, and server rows logged for a signed-in
  member. The account already says who it was, so the address adds nothing.
- On rows without a user (server and cron events, failures before the user is
  known), `ip` is `h1:` plus the first 16 hex characters of
  HMAC-SHA256(key, `randori-log-address-v1` NUL UTC day NUL network). The key
  is `LOG_ADDRESS_SECRET`, or `JWT_SECRET` when that is unset, so either can
  rotate without the other; the label keeps the hash domain-separated when
  the JWT secret is shared. The network is the IPv4 address (IPv4-mapped IPv6
  collapses to it) or the IPv6 /64 (`clientNetwork` in
  `api/_client-address.js`, shared with the rate-limit identity). Rows from
  one source on one UTC day share a value, so a burst can be traced.
- The hash is pseudonymous, not anonymous. Anyone holding the key can
  enumerate every IPv4 address for a day (2^32 HMACs, roughly an hour of one
  core), so they can reverse a value and link it across days. Without the key,
  values can't be reversed, and the day salt stops them being linked across
  days. A value that is not an IP literal, or a missing key, stores NULL.
  Writers never pass a stored hash through: only the admin read path shows an
  existing `h1:` value as it is.
- `ua` is a coarse family from a fixed vocabulary: browser and major version
  plus OS, with the OS major where the user agent has one (`Chrome 131 on
  Windows 10/11`, `Safari 17 on iOS 17`, `Chrome 131 on Android 14`); `bot`
  for crawlers (a product named like `Googlebot/2.1`, not a device such as
  `CUBOT X30`); `other` for anything unrecognised; NULL when absent. No text
  from the header is ever copied, so device models, build strings and
  anything a client puts in the header are dropped. A client log entry's own
  `ua` field is reduced the same way; this replaces the ID-72 addendum's
  cut-and-redact of that field.
- The client log redaction (`api/_client-log-policy.js` and the browser
  logger in `index.html`, kept identical by the shared corpus) now also drops
  copies a client puts in the entry itself:
  - IPv4 and IPv6 literals in message, event, route and meta become `[ip]`,
    keeping an IPv4 `:port`. Loopback addresses, stack-frame `:line:col`,
    clock times, three-part versions and product versions
    (`Chrome/131.0.0.0`, `v1.2.3.4`) stay readable.
  - A bare browser user agent (`Mozilla/5.0 (…) …`) becomes `[user agent]`.
  - The names `ua`, `ip`, `xff`, `user-agent`/`userAgent`/`user_agent` and
    `x-forwarded-for` are treated like the secret names: `name=value` pairs,
    quoted JSON keys and object keys (plus `ipAddress` and `x-real-ip`) lose
    their value, and `User-Agent:` / `X-Forwarded-For:` lose the rest of the
    line.
- A /24 or /48 prefix was not chosen: it links one network across days for
  anyone who reads the row and says where the client is.
- The admin logs API (`GET /api/data?endpoint=logs`, the `#logsArea` panel)
  returns the same fields. Rows written before this change are reduced on the
  way out (`presentAppLogClient`): NULL for rows with a user, otherwise hashed
  with their own `created_at` day. Admins see only reduced values either way.
  Admin Diagnostics never read either column.
- The salt day comes from the server clock and `created_at` from the database
  clock; within a moment of UTC midnight they can differ by a day, so anyone
  checking an address should try both days.
- The in-memory per-IP limiter for `POST /api/logs` (60 requests a minute per
  instance) still uses the raw address in process memory only; it is never
  written anywhere.

**Existing rows.** No backfill. Rows that still hold raw values age out under
the 30-day `app_logs` retention (ID-72), so 30 days after deploy (plus the
hourly retention run) none are left in the live database. Turso backups and
point-in-time history keep them until those age out on their own schedule.

**Sentry.** Server events have `sendDefaultPii:false` and `beforeSend`
removes `user` (including `ip_address`) and every request header, so no
address or user agent is sent from the server. The browser SDK is also set to
`sendDefaultPii:false`, but Sentry sees the browser's address when it receives
an event, and whether it stores it depends on the loader's SDK version and the
project's "Prevent Storing of IP Addresses" setting. That setting is outside
this repository and is left to the owner.

**Privacy Policy.** `privacy.html` (ID-79) now says the error logs keep the
browser and OS family, no address on entries linked to an account, and a
daily pseudonymous code (reversible by us, since we hold the key) on the few
entries without one; admins see those reduced values; and older entries age
out on the same 30-day schedule. `tests/unit/public-pages.test.mjs` pins the
wording.

**Rollout and recovery.** Merging changes only what new rows hold and what the
admin API returns; no schema, flag or production setting changes. Reverting
the commit restores the previous writers; nothing needs to be cleaned up.

## ID-85: Judge a managed database by steady-state membership readiness in migrations and the backup rehearsal

Status: implemented; no flag, no migration. Fixes a live failure found while
reviewing #347 (account deletion).

**Context.** `db/migration-runner.js` judged every database, including one
already under the managed ledger, with the one-time adoption rule
`inspectMembershipAdoptionReadiness`. That rule also requires every non-demo
account to have an active primary membership (`closed_rollout_has_uncovered_accounts`).
As soon as an owner removed or deactivated a member, or a member left,
`inspectMigrationState` reported a managed database as not ready: even a
no-op `applyMigrations` threw `MIGRATION_SCHEMA_INVALID`, and the Monday
backup/restore rehearsal failed in `detectEvidenceMigration` and backup
evidence collection. Health and pairing readiness already used the
steady-state rule, so nothing warned.

**Decision.**
- `inspectMembershipAdoption(db,{managed})` uses
  `inspectMembershipRolloutReadiness` for a managed ledger: the completed
  steady-state check once the rollout is closed, the pristine-open check
  before. `inspectMigrationState` passes `managed` for managed ledgers, and the
  per-migration postcondition in `applyMigrations` always does.
- Adopting an unmanaged database keeps the strict one-time rule, including
  uncovered accounts. The adoption postcondition (now managed) must also pass
  the steady-state rule.
- Every steady-state invariant still blocks: provenance, malformed audits, the
  active owner, backfill completion, orphan memberships.
- `managed` is a required option, so no caller can fall back to a rule by
  accident. When the source's own ledger version is not ready, the rehearsal's
  `detectEvidenceMigration` now fails with `REHEARSAL_MIGRATION_STATE_INVALID`
  instead of the lower-version probe's "ledger is newer" error (script only;
  the digest-pinned workflow files are unchanged).

**Alternatives.** Dropping the uncovered-account rule from adoption too (an
unmanaged database could be adopted with members the backfill never covered).
Reactivating removed members before migrating (destroys an owner's decision).

**Rollout.** Takes effect on merge for `db:migrate`, the production migration
workflow and the rehearsal. No workflow file or digest pin changes.

## ID-86: Serve `/api/stats` to signed-in members only

Status: implemented; no flag, no migration. Fixes #333 (a live privacy
exposure found while reviewing #331).

**Context.** `GET /api/stats` (`handleStats` in `api/data.js`) returned the
circle-wide `total_users`, `total_weeks`, `total_pairs` and `total_sessions` to
anyone, signed in or not. Polling `total_sessions` showed a signed-out visitor
when sessions were confirmed complete, which bypasses the small-cell rules
planned for circle health (#292, ID-78). The public landing has not called
`/api/stats` since UI redesign WP-L1 (`index.html` `bootHome` returns early for
anonymous visitors), so no signed-out page reads these numbers.

**Decision.**
- Signed-out visitors do not need any of these numbers. `handleStats` checks
  the session first and returns `401 {"error":"authentication required"}`.
  A request with no validly signed session is refused before the database is
  opened. A signed but revoked or expired session is refused after the session
  lookup in `verifyRequestAuth`. Neither reads any stats table. A session
  whose subject is not a positive integer id is refused the same way
  (`authenticatedUserId`, as `/api/weeks` does).
- A signed-in member's response is unchanged: the same totals, `your_*` counts
  and `next_cycle`. The viewer's own counts are now always computed, since
  every caller has a session.
- The response is `Cache-Control: private, no-store` (Vercel already sends
  `no-store` for `/api/*`).
- No flag: the route's only caller is the signed-in dashboard, so nothing a
  member or visitor sees changes, and a flag would leave the exposure live.

**Remaining exposure.** A signed-in member can still poll the all-time,
unsuppressed `total_sessions`. That is recorded for the circle health
threshold review in `docs/CIRCLE_HEALTH.md` ("`/api/stats` outside these
rules").

**Alternatives.** Rounding or caching the public totals per day (still
discloses activity, and no signed-out page shows them). Dropping only
`total_sessions` (the other totals have no signed-out reader either).

**Recovery.** Revert the commit; the totals become public again.

## ID-87: Release additive migrations with no downtime (expand, migrate, use)

Status: implemented; no flag, no migration. Issue #371, the prerequisite for
#353, #372, #374 and every later schema change.

**Context.** Health, `/api/init`, circle-pairing and schedule readiness
required the ledger to equal the code's latest version exactly. The protected
cutover has to run from a `main` commit that already contains the migration,
so every migration merge deployed code at N against a database at N-1:
readiness failed and pairing endpoints returned 503 for the 20-40 minutes of
rehearsal, status and apply.

**Decision.**
- Each contract in `db/migration-contract.js` declares
  `compatibility: 'additive' | 'breaking'`. An additive contract also lists
  the tables, indexes and triggers it `introduces`. Migrations 1-21 stay
  `breaking`: the code that shipped with them assumes their schema, so this
  change widens readiness for no shipped version and changes nothing on merge.
  Contract fields are not part of any checksum; every existing checksum is
  unchanged.
- Readiness (`db/migration-compatibility.js`): code at N is ready when the
  ledger is at N, or at N-1 when migration N is additive. In the second case
  the schema must match N-1 exactly: the code's manifest minus what N
  introduces, so a half-created new table is drift. Two versions behind, a
  breaking migration still to apply, and a ledger newer than the code stay
  not ready. Every other rule is unchanged (each applied row's checksum and
  metadata, key control, membership). Health readiness, `/api/init`,
  circle-pairing and schedule readiness use it; readiness now reads the
  ledger before inspecting the schema, since the version picks the manifest.
  The owned-scope probes (circle-pairing, schedule) additionally reject when
  any artifact the pending migration introduces already exists in
  `sqlite_schema` (#379): their inspector manifest is scoped to owned tables,
  so it is blind to a half-created introduced table and to introduced indexes
  or triggers on tables outside the scope, while the full-manifest health
  probe already caught those as unexpected artifacts.
  Residual: the secondary-schedule probe caches a clean success indefinitely
  per DB/client, so a warm process could keep returning ready if a
  half-created artifact appears later; tracked in #395.
  Pairing publication readiness checks only the v6 core contract, already
  accepted any later ledger prefix, and cannot be changed by an additive
  migration.
- Admin diagnostics reports `pending_additive`: the readiness card is
  *Degraded* with "pending additive migration vN" while the app stays ready.
- The migration check (`db/migration-compatibility-check.js`) proves an
  additive migration is additive: only new tables; new indexes on new tables,
  or non-unique ones on existing tables; triggers and seed rows on new tables
  only; `introduces` exactly matching. It refuses DROP, ALTER, RENAME, UPDATE,
  DELETE, REPLACE and PRAGMA statements, table redefinition, a unique index or
  trigger on an existing table, triggers writing existing tables, and unknown
  operations, after stripping comments and literals. `ALTER TABLE ... ADD
  COLUMN` has no runner operation yet and is refused. The executable
  migrations assert it when they load, so no migration tool can apply a
  mislabelled migration, and `npm run check:deployability` reports it.
- Feature gating (`api/_schema-capability.js`): code that uses an additive
  migration's tables checks the exact ledger row for N, cached per database
  (30 s while pending, 5 min once present, errors uncached).
  `schemaFeatureAvailable` adds the feature flag for request paths; account
  deletion and retention use the schema check alone so stored rows are still
  deleted with the flag off.
- Release order and rollback are in the production migration runbook: merge
  (ready on N-1), rehearsal, status and apply N (ready on N), then flag on.
  Roll back by turning the flag off, then PITR only if needed; never roll code
  back below the database. Breaking migrations keep the strict behaviour.

**Alternatives.** Merging migrations without the code that uses them and
shipping that code in a later PR (two reviews and two deploys per change, and
nothing stops the code from merging first). Tolerating any lag (code could run
against a schema several changes old). Marking v21 additive, since its SQL is
(the code that shipped with it does not check for its table). Inferring
compatibility from SQL alone (the declaration is the author's promise that the
code gates the new tables; the check only proves the SQL half).

**Tests.** On real migrated SQLite: code at N with N additive stays ready on
every surface while the database moves from N-1 to N; a breaking N is not
ready at N-1; code at N-1 is not ready at N; two versions behind is not ready;
drift and tampered ledger rows still block at N-1. The owned-scope probes
also reject a half-created introduced table, index or trigger on a
non-owned table while the migration is pending (#379). Mutation tests load copies
of the readiness module with the tolerance widened (to N-2, to breaking
migrations, to an older additive migration, or with the schema checks
dropped) and require every copy to fail the policy. The check rejects
destructive SQL in many forms, and a mislabelled real migration (v20) stops
the migration tooling from loading.

**Rollout.** Takes effect on merge and changes nothing until the first
additive migration (#353's v22) lands. No workflow file, digest pin or
production setting changes.

## ID-88: Force zod to `^4.6.6` via npm overrides to fix GHSA-mrhx-c7xc-m3w5

Status: implemented; no flag, no migration. Security fix unblocking CI
(`audit:prod` is an early step in `e2e` and `ubuntu-26-canary`).

**Context.** `npm run audit:prod` failed with 5 high-severity findings, all
the one advisory: `zod <4.6.6` can exhaust memory while validating oversized
constrained collections
([GHSA-mrhx-c7xc-m3w5](https://github.com/advisories/GHSA-mrhx-c7xc-m3w5)).
The vulnerable copy was transitive and nested:
`@vercel/sandbox@3.8.0` -> `@vercel/oidc@4.0.0` -> `@vercel/cli-config@0.3.1`
-> `zod 4.1.11` (an exact pin in `cli-config`). The hoisted top-level `zod`
was already 4.6.7, resolved from `@vercel/sandbox`'s own `zod ^4.1.1`, so
only the `cli-config` copy was vulnerable.

**Decision.**
- `package.json` gains `"overrides": { "zod": "^4.6.6" }`. The lockfile
  drops the nested `node_modules/@vercel/cli-config/node_modules/zod`
  entry; a clean `npm ci` installs exactly one `zod` copy, 4.6.7, shared by
  the sandbox chain and the rest of the tree. `npm run audit:prod` reports
  `found 0 vulnerabilities`.
- The audit itself is not weakened: no audit-level change, no `--force`
  bypass, no ignored advisory.
- The range (rather than the exact `4.6.7`) lets a future `4.x` release be
  picked up without another override edit; the lockfile pins 4.6.7 today.
  Every zod consumer in the tree is 4.x (`^4.1.1`, the `4.1.11` pin), so the
  override moves all of them within the same major line.

**Alternatives considered and rejected.**
- Bumping `@vercel/sandbox` 3.8.0 -> 3.9.0 (latest): 3.9.0 still depends on
  `zod ^4.1.1` and `@vercel/oidc 4.0.0`, and `@vercel/oidc@4.0.3` ->
  `@vercel/cli-config@0.3.3` still pins `zod 4.1.11` exactly (checked with
  `npm view`), so the nested vulnerable copy would remain. An unrelated
  minor bump that does not fix the advisory.
- Bumping `@vercel/cli-config` / `@vercel/oidc` alone: same exact pin at
  their latest versions (0.3.3 / 4.0.3), so no fix.
- `npm audit fix --force`: would downgrade `@vercel/functions` to 3.6.1, a
  breaking change, to work around the advisory.

**Verification.**
- Clean `npm ci` reproduces one `zod` copy at 4.6.7; `audit:prod` passes.
  The full `npm audit` still reports 2 pre-existing dev-only findings
  (`dompurify` via `monaco-editor`); they are out of scope here and do not
  affect `audit:prod`.
- `test:unit`: 2696 pass, 0 fail. `test:coverage`: lines 98.27%,
  branches 94%, functions 99.48% (thresholds 97/92/99). All `check:*`
  scripts and `validate:catalog` pass.
- Runtime: `@vercel/sandbox` and `@vercel/cli-config` load on zod 4.6.7;
  `cli-config`'s `parseGlobalConfig` / `parseAuthConfig` accept valid
  configs and reject an invalid one, and a constrained-collection schema
  still rejects oversized input. The live execution smoke was not run: it
  needs a `VERCEL_OIDC_TOKEN` and creates real sandboxes that count against
  the plan allowance (it never runs in CI); the execution unit tests
  (28 tests) pass.

**Removal.** Drop the override once an upstream `@vercel/cli-config`
release requires `zod >=4.6.6`, then re-run `npm install` and confirm the
nested copy does not return. Until then, removing the override
reintroduces the vulnerable 4.1.11 copy and fails `audit:prod`.

**Recovery.** Revert the commit; the nested vulnerable copy returns and
`audit:prod` fails again. No code, flag, migration or production change.

## ID-89: State the backup retention for deleted data, and re-apply post-restore-point deletions after a restore

Status: implemented; no flag, no migration. Issue #366, follow-up to #347
and ID-81.

**Context.** `docs/ACCOUNT_DELETION.md` only said backups keep "their own
retention windows", and nothing defined what a restore does to deletions
made after the restore point. A point-in-time restore to T brings back
the database as of T — including personal data deleted after T — so
without a re-application step a restore would silently resurrect it.
Issue #366 also asked to verify the provider plan rather than assume it:
it said "Turso Starter currently restores up to 1 day back".

**Verification (retention).** Fetched the live Turso pricing page
(`https://turso.tech/pricing`) on 2026-10-25: the plans are Free,
Developer, Scaler, Pro and Enterprise — there is **no "Starter" plan** on
the current page — with Point-In-Time Restore of 1 day (Free), 10 days
(Developer), 30 days (Scaler) and 90 days (Pro, Enterprise). The earlier
decision-log note calling the 1-day window "Starter" (ID-83's 22 October
2026 update) was stale plan naming; the 1-day bound itself still holds
because production is on the Free tier, per
`docs/PRODUCTION_BOOTSTRAP_GUIDE.md` §3.4. The owner should confirm the
organisation's tier in the Turso dashboard if that ever becomes doubtful:
the documented bound is conditional on the tier, and a move to a paid
tier lengthens the window (10/30/90 days) and requires a `privacy.html`
update first. The GitHub rehearsal/monitor/watchdog artifacts (30 days)
and migration result (90 days) were checked: they hold only counts,
checksums and digests, never personal data, so they do not extend
personal-data retention. Disposable restore databases have zero
retention. `privacy.html` now says exactly this: backups hold deleted
information for up to 1 day, and a restore re-applies deletions made
after the backup point before the restored data goes live, where the
source database survives. If the source database itself is destroyed,
that re-application is not yet possible.

**Decision.**
- *Retention, stated exactly:* deleted personal data can remain in the
  provider's point-in-time backups for up to 1 day after deletion on the
  current plan. Documented in `docs/ACCOUNT_DELETION.md` (new "Backups
  and restores" section), `docs/TURSO_BACKUP_RESTORE_REHEARSAL.md`,
  `docs/PRODUCTION_BOOTSTRAP_GUIDE.md` §3.4 (now lists all five tiers)
  and `privacy.html` (Backups bullet).
- *Deletion ledger, outside the restored database:* one entry per
  tombstoned account — `{account_id, deleted_at, created_at}` — and
  nothing else. `deleted_at` is the earliest `account.deleted` audit
  event (null when no audit row exists, always treated as due);
  `created_at` separates "created after the restore point, correctly
  absent" from "should be in the restored database, fail closed". The
  ledger is built from the still-live source database and kept only in
  an operator-held, mode-`0600` file: never committed, never uploaded
  as an artifact, destroyed after the verified cutover.
- *Re-application:* `reapplyAccountDeletion` in `api/_account-deletion.js`
  runs the same scrubbing statements as a self-service deletion, keeping
  the original deletion time as the audit instant. It deliberately
  skips the recent-auth proof and the last-owner/last-admin gates (the
  original deletion already passed them; the restored database holds
  stale membership/ownership state), and it is not behind
  `ACCOUNT_DELETION_ENABLED` (a restore must re-apply deletions made
  while the flag was on even if it is off at restore time).
  `verifyDeletionLedger` is the cutover gate: any due entry not
  tombstoned blocks the cutover. `scripts/deletion-ledger.mjs` exposes
  `export` / `reapply` / `verify` with counts-only output. The runbook
  procedure (export from source, re-apply to the restored database with
  the *requested* PITR timestamp as the restore point, verify, cut over,
  destroy the ledger) is in
  `docs/TURSO_BACKUP_RESTORE_REHEARSAL.md`.
- *No schema migration.* Every column read already exists. Per the
  task's constraint and the ID-87 additive-release order, a migration
  would have needed the owner cutover; none was needed, so none was
  built. The rehearsal needs no workflow change: the weekly rehearsal
  deletes no real account, so re-application is covered by unit tests on
  real migrated SQLite (a pre-deletion database standing in for the
  restore) rather than by the live drill.

**Alternatives considered and rejected.**
- A ledger table inside the database: rolls back with the restore it is
  meant to repair — useless.
- Ledger entries in a GitHub artifact: keeps account ids on a 30/90-day
  retention schedule for no benefit, and widens exposure.
- Operator hand-written SQL for re-application: the deletion is ~35
  statements; hand-running it under incident pressure is error-prone.
  The tested function plus CLI is the safe form of the same procedure.
- A durable off-database ledger written at deletion time (survives the
  source database itself being destroyed): the correct fix for the
  deleted-source case, but new infrastructure beyond this issue. Filed
  as #383; until it lands, a restore from a destroyed source cannot
  re-apply deletions, and that residual risk is documented in both the
  deletion doc and the runbook.

**Verification.**
- `tests/unit/account-deletion-restore-reapplication.test.mjs`
  (9 tests): ledger building (earliest audit time, null time, live
  accounts excluded), parsing/filtering (including the at-exactly-the-
  restore-point boundary), re-application tombstoning and scrubbing a
  live account with the original audit time, idempotent retry,
  skip/never-existed/missing outcomes, fail-closed demo account, the
  last-owner bypass, verification catching a missing entry, and an
  end-to-end real deletion → ledger → re-application onto the
  pre-deletion database.
- `tests/unit/deletion-ledger-cli.test.mjs` (4 tests): export
  (versioned, mode `0600`, counts-only output), reapply + verify
  driving a restore to cutover-ready, fail-closed stop on a missing
  entry, and typed usage/config/file errors.
- `test:unit`, `test:coverage` and all `check:*` scripts pass (numbers
  in the PR description).

**Rollout and recovery.** Merge only; no flag, no migration, no
production change, no workflow change. The new code runs only when the
operator invokes the ledger CLI during a restore. Recovery is a revert:
the runbook procedure and `privacy.html` wording revert with it; no
database state depends on the new code.

**Follow-ups filed.** #383: a durable off-database deletion ledger written
at deletion time, so a restore from a destroyed source database can still
re-apply deletions. #384: owner confirmation of the organisation's Turso
plan tier in the dashboard.

*Review fixes, 25 October 2026:* the PR was merged with `origin/main`
(#378's byte-level `tamperCursor` kept), the ledger file is now created
exclusively with `openSync(out, 'wx', 0o600)` plus a defensive `fchmod`
(refusing to overwrite or follow a symlink), `--out` inside the
repository is rejected and `deletion-ledger*.json` is gitignored,
`export` accepts `--restore-point` as minimisation only (reapply-time
filtering remains the gate), `privacy.html` qualifies the backup bullet
to re-application only where the source database survives, the CLI
validates `JWT_SECRET` presence up front with a typed config error
(`export`/`reapply`; `verify` needs none) and the runbook states it must
be the secret in effect at deletion time, ID-83 carries a dated
correction that "Starter" is not a current Turso plan name, and the dead
`point` variable in `verifyDeletionLedger` is removed. #383 is not
landed by this PR.
## ID-90: Let a signed-in member download their own data as one JSON archive, behind a flag

Status: implemented; behind `DATA_EXPORT_ENABLED` (off by default), no migration. Issue #365.

**Context.** Account deletion shipped (#347, ID-81) with an inventory of
every table holding a member's personal data
(`ACCOUNT_DATA_INVENTORY` in `api/_account-deletion.js`), but members had
no way to get a copy of their own data. The issue requires a
machine-readable (JSON) export of the member's own data, recent
re-authentication, rate limits, a size bound, partner privacy, its own
feature flag, and a Privacy Policy description. Product feedback (#353)
is being implemented in parallel and has not landed, so the export must
not block on it.

**Decision.**
- `GET /api/auth/account/export` in the existing `api/auth.js` function
  (via a `vercel.json` rewrite), so no new serverless function is added.
  It returns one JSON archive (`randori-circle-data-export.json`,
  `version: 1`) of the requesting member's own data: profile, memberships,
  circles the member created but holds no membership for, availability,
  pairings, schedules, session completions and controls, the member's own
  messages and code runs, notification preferences, authored custom
  questions, sent/accepted/received invitations, the member's own invite
  requests, AI sessions/feedback/consent/usage/reservations, and the
  member's own product feedback. `excluded_tables` lists every inventory
  table that is not exported, with the reason, `counts` gives per-section
  exported row counts, and `truncated_sections` names every section that
  hit its per-section cap, so a capped archive discloses what it left out.
- Partner privacy: partners appear by display name only (the history-view
  rule) — no partner ids, emails, phones, hashes or tokens anywhere in the
  archive. Stored schedule proposals are projected to
  `{instant, proposed_by_me}` so the raw numeric proposer id never reaches
  the archive. Only the member's own messages are exported, never a partner's.
  Shared pair workspaces (`pair_code_documents`, `pair_room_snapshots`)
  are not exported, because they hold the partner's contributions too.
  Secrets (password/token hashes, Google subjects, sealed outbox envelopes,
  session hashes), ephemeral records, audit trails and operational logs are
  not exported.
- Every account-deletion inventory table is accounted for in
  `DATA_EXPORT_TABLE_COVERAGE` (`api/_data-export.js`). A future inventory
  table with no explicit entry is excluded at runtime ("not yet reviewed"),
  and `tests/unit/data-export.test.mjs` asserts no entry carries that
  fallback reason and that the coverage list deep-equals a hard-coded list
  of the 45 expected tables, so adding a table to the inventory, removing
  one, or deleting an explicit entry all fail the test until an explicit
  entry is written, and a new inventory table can never leak through the
  export.
- Recent authentication (a sign-in from the last 10 minutes) is required
  and is checked before the rate limit, so a stale proof does not burn
  export quota. Rate limit: 5 exports per account and 20 per IP per
  15 minutes (429 over the limit). In the UI the member confirms through
  Account security (or signs out and signs in again) and retries; this
  module does not duplicate the identity-confirm dialog.
- Size bound: per-section caps (`DATA_EXPORT_SECTION_LIMITS`, 100–2,000
  rows by section: memberships, invite requests and created circles 100,
  AI usage 120, AI sessions 200, messages 2,000, code runs 1,000, most
  others 500–1,000;
  see `docs/DATA_EXPORT.md` for the full list) and a 5 MB whole-archive
  bound (`DATA_EXPORT_MAX_BYTES` = 5,000,000 bytes). A section that hits
  its cap is listed in `truncated_sections`, so capping is disclosed, not
  silent. Over the whole-archive bound the endpoint answers 413
  `export_too_large` instead of a partial or oversized response; it does
  not chunk.
- Feedback (#353): at request time the export probes for `feedback_items`
  / `feedback_votes` (and their author/voter columns, via `PRAGMA
  table_info`) and includes the member's own rows when they exist;
  otherwise it reports `feedback.included: false` and skips them cleanly.
  Feedback events (audit) are never exported. A follow-up issue (#385) tracks
  confirming the #353 column names and inventory entry once #353 lands.
- `privacy.html` describes the download: what it contains (including
  session controls, notification preferences, AI feedback/usage/
  reservations, received invitations and created circles), what it leaves
  out, the recent-sign-in requirement, the 5-per-15-minutes limit, the
  5 MB bound, and the per-section caps with `truncated_sections`
  disclosure. See `docs/DATA_EXPORT.md`.

**Alternatives considered and rejected.**
- A new serverless function for the export: the Hobby function limit is
  the reason #353 routes through an existing function, and `api/auth.js`
  already owns the session, recent-auth and rate-limit helpers the export
  needs.
- Exporting the partner's messages / the joint pair workspace so the
  archive matches the room transcript: those contain the partner's data,
  and the issue scopes the export to the member's own messages.
- Truncating an oversized archive silently, or chunking it: a silent
  truncation would hand the member an incomplete copy without saying so,
  and chunking adds pagination state for a 5 MB bound no real archive
  approaches. Per-section caps are disclosed via `truncated_sections`
  instead, and 413 with a contact path is explicit and fail-closed for
  the whole-archive bound.

**Verification.**
- `tests/unit/data-export.test.mjs` (builder on a migrated database:
  inventory coverage against a hard-coded 45-table list, partner privacy
  including a modern partner schedule proposal, received invitations and
  created circles, feedback absent/present, size bound, section caps,
  `truncated_sections` disclosure), `tests/unit/data-export-api.test.mjs` (route:
  flag off 404, 401, 403 without recent auth, rate-limit 429, 413, the
  `vercel.json` rewrite, the capability),
  `tests/unit/data-export-ui.test.mjs` (Edit-profile section), and the
  golden-path e2e `tests/e2e/golden-data-export-real-runtime.spec.ts`
  (golden-paths row 25). The e2e spec uses the same `expectAccessible`
  helper pattern as the account-deletion golden spec; that helper's fix
  belongs to #390, which owns it. This PR also corrects the decision-log
  entry's ID: #386 has since merged as ID-89, and #389 also claims
  ID-89, so this entry is ID-90, the next free ID.

**Removal.** Unset `DATA_EXPORT_ENABLED` (or set `false`) and redeploy:
the endpoint answers 404, the capability disappears, and Edit profile
never downloads the script. Nothing is stored by the export, so removal
is fully reversible.

## ID-91: Product feedback — shared platform for bug reports, feature requests and product feedback (data model + API)

Status: implemented; flag `FEEDBACK_ENABLED` default off, migration v22 additive. Issue #353 (foundation; the triage UI and member form are separate follow-ups).

**Context.** Members had no in-app way to report a bug, request a feature, or
send product feedback to the people running Randori, except the public issue
tracker (which must not receive personal data). The foundation has to land
first: one server-side store and API for all three kinds, behind the
zero-downtime additive release order (ID-87), with the same abuse, privacy
and lifecycle guarantees as the invite-request intake.

**Decision.**
- **Data model (migration v22, `compatibility: 'additive'`).**
  `feedback_items` (id uuid, circle_id, author_user_id, kind, title ≤120,
  body ≤4000, status, visibility, diagnostics_json, idempotency_key,
  created_at, updated_at, closed_at), `feedback_votes` (one upvote,
  `value=1`, per member per item, unique `feedback_id, user_id`) and
  `feedback_events` (append-only audit: `feedback.created`,
  `feedback.status_changed`, actor, small detail object). CHECKs enforce the
  limits, bug-only diagnostics (a JSON object ≤4096 bytes), per-author
  idempotency-key uniqueness, and the closed/closed_at invariant (closed
  items carry `closed_at`; open items never do). Visibility is always
  `'private'` for now; the column exists so the triage UI can widen it
  later without a migration. No status-change endpoint ships in this
  change, so items stay `open` until triage lands.
- **API, through the existing `api/data.js` function** (Vercel rewrites
  `/api/feedback` → `endpoint=feedback`, `/api/feedback/mine` →
  `endpoint=feedback-mine`): `POST /api/feedback` (201, or 200 on an
  idempotent replay) and `GET /api/feedback/mine` (newest first, cursor
  pages, the caller's items in the active circle only). Reads and writes authorize against the
  session and the active circle (403 without a membership, 409
  `circle_selection_required` when several circles are active and none is
  selected). With the flag off, or while v22 is still pending, both
  endpoints answer `404 {"error":"not found"}` and no capability is
  advertised anywhere.
- **Abuse limits.** 10 submissions per rolling hour and 30 per rolling day,
  enforced separately per member and per client address (IPv6 keyed by its
  /64) in the shared `auth_rate_limits` table with keyed hashes; the first
  exhausted dimension stops. Invalid input never spends budget. The
  route looks up the idempotency key before the limiter, so an exact
  replay (or a same-key conflict) never spends budget either; two
  simultaneous same-key POSTs that collide on the unique index re-read
  the winner's row and replay it (or 409) instead of failing with 503.
  A retry
  with the same client-supplied idempotency key and the same (redacted)
  payload replays the stored item; the same key with different content is
  a 409. Idempotency is per author.
- **Privacy.** Title, body and diagnostics pass through the shared
  server-side redaction (`api/_client-log-policy.js`) before storage:
  emails, tokens, secrets, JWTs, credentials, IPs and user agents are
  replaced. Diagnostics keys must be plain field names — an email, IP,
  JWT or token as a key is rejected at validation, and storage collapses
  an unsafe key to `[redacted]` instead of storing it verbatim. No raw IP or user agent is stored in any feedback table
  (ID-82). The admin email (below) carries only kind, redacted title and a
  triage link — never the body.
- **Retention.** Owner decision (2026-10-22): closed items are kept for 12
  months, then deleted; open items are kept until they are closed. The
  bounded sweep (500 rows per batch, at most 10 batches) runs inside the
  weekly `/api/cron/weekly` sweep, regardless of the flag, and deletes
  events, then votes, then items, so it never depends on foreign-key
  enforcement on the calling connection. It never blocks pairing
  publication.
- **Account deletion (ID-81).** Deleting a member deletes their items,
  the votes they cast, and the events on their items; events they acted in
  keep the event with the actor cleared; queued `feedback.submitted`
  notifications about their submissions are suppressed and lose their
  title. The deletion probes the feedback tables directly
  (`SELECT … LIMIT 0`) and treats a missing table as not installed, so
  it works on a v21 database too. The inventory test
  covers the new tables.
- **Data export (#385, confirmed on PR #389).** The member data export
  (ID-90) carries explicit coverage for all three feedback tables:
  `feedback_items` and `feedback_votes` are exported through the
  `feedback` section (own items; only the votes the member cast),
  `feedback_events` is excluded as an append-only audit trail (same
  class as the other excluded audit tables — an event can describe
  another member's item or an admin's triage action). The landed v22
  column names check out against the export's `PRAGMA` discovery
  (`author_user_id` on items, `user_id` / `feedback_id` on votes), the
  item's `idempotency_key` is not exported (dedup token, not user
  content), and the export test seeds the real migrated tables instead
  of hand-built ones. `privacy.html` needed no change: it already
  says the download includes the member's own product feedback.
- **Notifications.** Outbox event `feedback.submitted` v1, one event per
  admin recipient (every `is_admin=1` non-demo account plus every account
  in `ADMIN_EMAILS`), idempotency key
  `feedback-submitted/v1/<feedback_id>/<admin_id>`. Delivery re-reads
  state and suppresses when the item is gone, the recipient is no longer
  an admin, or they have email notifications switched off. While the
  flag is off the handler suppresses with `FEEDBACK_DISABLED`, so queued
  rows drain instead of aging into a backlog alert.
- **Release order.** Merge with production at v21 (ready, diagnostics
  *Degraded* with "pending additive migration v22"), run the protected
  rehearsal → status → apply v22 cutover as soon as it is ready (owner
  decision, 2026-10-22), then turn `FEEDBACK_ENABLED` on. Roll back by
  turning the flag off; PITR only if the tables themselves are the
  problem.

**Alternatives.** A separate serverless function for feedback (rejected:
the Vercel Hobby function limit; the existing `api/data.js` function
carries it). Storing the full body in the admin email (rejected: the body
may contain personal data). A per-item triage view in this change
(rejected: the UI issues depend on this foundation and are tracked
separately). Votes with downvotes (rejected: the feature-request vote is
an upvote; a richer vote is a later decision).

**Tests.** On real migrated SQLite: v22 is additive, empty, indexed and
exact after v21; code at v22 is ready on a v21 database while the feature
capability stays off; CHECK/UNIQUE/FK constraints for votes, idempotency,
diagnostics and closed dating; redaction of hostile input; rate limits on
all four dimensions; replay vs conflict; `/mine` pagination and author
isolation; retention of only old closed items; notification delivery and
all suppression paths; route-level flag/auth/circle/rate-limit/schema-
pending behaviour; account deletion erasing feedback rows and scrubbing
queued notifications. The data-export tests confirm the #385 wiring
against the real v22 tables (own items/votes, events never exported,
48-table coverage). Coverage gate holds; the new modules are covered
by these tests.

**Rollout.** Merge with `FEEDBACK_ENABLED` off (default) and production at
v21. The owner runs the protected cutover for v22, then turns the flag
on. Reverting the commit restores the pre-feedback endpoints; rows
already stored stay until retention or account deletion removes them.

**Recovery.** Turn `FEEDBACK_ENABLED` off: the endpoints return 404
again and nothing touches the new tables. No schema change is needed.
