# Randori Circle implemented decision log

Status: accepted through merged PR #89 plus candidate PRs #93, #92, #96, and
#100

Last reviewed: 2026-09-19

Scope: `main` through `2402fe9bea53aa0a44d2af4c43f77e4223894695`, plus PRs #93 and #92

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
| 9 | [PR #96](https://github.com/festus14/randori-circle/pull/96), candidate | Proposal, acceptance, change, and reminder delivery | Reuses v6; no migration |
| 10 | [PR #100](https://github.com/festus14/randori-circle/pull/100), candidate | Owner-created invitation email and bounded resend | Reuses v6; no migration |
| 11 | [PR #104](https://github.com/festus14/randori-circle/pull/104), candidate | Fair, globally bounded outbox invocation | Reuses v6; no migration |

Migration order is append-only: v4 binds an account to an OIDC issuer and
subject, v5 makes every application JWT depend on a live hashed session row,
v6 adds the outbox and its audit history, and v7 adds pending verified-email
activation. The protected production workflow applies no more than one pending
version per inspected fingerprint and approval.

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

## ID-11: Reuse the durable outbox for schedule email

**Decision.** A schedule compare-and-swap and its versioned email intents commit
in one write transaction. `schedule.email.requested` v1 carries stable IDs,
normalized instants, a schedule version, and template version 1; it does not
carry recipient addresses, links, tokens, names, or rendered content. Proposal
emails go to the other pair members. First acceptance and rescheduling notify
all pair members and enqueue one reminder per member for 24 hours before the
accepted instant. Clearing an agreement sends a change notice; removing a
proposal sends none.

The worker resolves the current address and content at delivery time and
rechecks notification preference, source-tagged actor and recipient pair
participation, both accounts' active production membership, schedule currency,
and elapsed time. Removed proposals,
revoked members, changed preferences, cancelled agreements, old accepted times,
and superseded reminders are suppressed. Retries retain the same provider
idempotency key and the existing five-attempt, ten-second event bound. The
shared dispatcher in ID-13 applies the aggregate claim/deadline budget.

**Why no schema change.** The v6 outbox already models delayed work, dedupe,
leases, bounded retries, suppression, dead letters, and audit history. The
authoritative schedule row provides stale-work invalidation. A schedule-specific
queue would duplicate those guarantees. Migration v8 remains available for the
password-recovery work in issue #82.

**Alternatives.** Inline sending was rejected because provider failure would
couple or lose the schedule write. Persisting addresses and pre-rendered bodies
was rejected because it retains avoidable personal data and becomes stale.
Mutating or deleting replaced reminders was rejected in favor of immutable,
auditable events that suppress themselves. Managed workflow products remain an
option if private-beta volume outgrows the database relay. See
[schedule notifications](SCHEDULE_NOTIFICATIONS.md) for the event matrix,
operating contract, and explicit remaining issue #50 scope.

**Follow-up.** ID-13 replaces the sequential typed cron drains with a shared
deadline and fair claim budget. Full issue #94 remains pending only because the
password-recovery adapter is being developed on a sibling stack and must be
registered after linearization.

## ID-12: Encrypt invitation credentials in the shared outbox

**Decision.** An owner-created invitation remains usable immediately through
its one-time manual copy link. When production mail and a dedicated encryption
key are fully configured, creation also commits an
`invitation.email.requested` v1 event in the same write transaction. An
explicit resend rotates the invitation token and commits its new event and
audit row atomically. Resend has a durable 60-second cooldown and five-send
lifetime cap; each version has a stable provider idempotency key.

The invitation row continues to store only domain-separated token and email
hashes. Because the provider eventually needs both plaintext values, the event
holds an AES-256-GCM envelope bound to the invitation ID, using the production-
required `INVITATION_EMAIL_ENCRYPTION_KEY`. The key is distinct from session
and email-verification keys. Missing or partial production configuration leaves
email unqueued while preserving the manual link, and resend instructs the owner
to create and copy a new invitation.

Immediately before delivery, the worker authenticates the envelope and
rechecks the exact invitation, circle, token hash, email hash, expiry,
revocation, consumption, current event-authorizer ownership, non-demo identity, and
absence of an existing recipient membership. Token rotation therefore
suppresses every older queued or retried event. Outbox payloads and persistent
logs contain neither the plaintext email nor bearer token; automated delivery
uses local capture or mocked providers only.

**Why no schema change.** Schema v6 already provides immutable events, unique
idempotency, leases, retries, suppression, dead letters, and audit history. The
existing invitation row supplies authoritative revocation, expiry, consumption,
and rotation state. Adding invitation send columns would duplicate outbox state.
Migration v9 remains reserved for issue #83.

**Alternatives.** Plaintext outbox credentials were rejected because a database
read would expose a live bearer link. Synchronous mail was rejected because a
provider timeout would couple owner interaction to delivery and could lose
post-commit work. A separate invitation queue was rejected because it would
duplicate the v6 worker contract. Retaining one token across resends was
rejected because already delivered or queued links could not be superseded.
See [invitation email delivery](INVITATION_EMAIL_DELIVERY.md) for the operational
contract and remaining issue #95/#50 work.

## ID-13: Admit outbox work in fair, deadline-bounded rounds

**Decision.** The cron endpoint uses one provider-neutral invocation runner for
all delivery types available in this stack. One atomic claim statement selects
at most one due event per configured type before any type receives a second
claim. Each round dispatches those independent handlers concurrently and
finalizes each token-bound lease. The complete invocation admits at most eight
events under a 45-second wall-clock budget; provider work stops five seconds
early to reserve time for lease finalization, backlog reads, aggregate logging,
and the HTTP response.

The production operating target is a scheduler invoking `/api/cron/outbox` at
least every five minutes with a function duration of at least 60 seconds. The
45-second application budget leaves 15 seconds of platform margin and each
event retains its stricter ten-second provider timeout. A deployment offering
less than 60 seconds must lower the constants with matching timing tests or use
separately scheduled workers before enabling external delivery.

The MVP uses the checked-in `outbox-dispatch` GitHub Actions workflow on a
five-minute cadence, with `APP_URL` and `CRON_SECRET` supplied by the protected
production environment. Missing configuration fails visibly, the HTTP call is
capped at 55 seconds, and automatic transport retries are disabled. A job-level
guard restricts scheduled and manual dispatch to the repository default branch;
the production environment should enforce the same deployment-branch rule. The
five-minute delivery latency is an operating target because GitHub scheduling
can be delayed; a managed queue/cron is the preferred upgrade for a strict SLO.

The response and application log expose only per-event-type counts: claimed,
delivered, suppressed, retried, newly dead-lettered, lease-lost, current dead
letters, and actionable backlog. They contain no payload, idempotency key,
recipient, link, or provider response. Existing typed handlers continue to own
payload validation, stale-state suppression, provider adaptation, and stable
idempotency keys.

Weekly and manual pairing publication now stop after committing their outbox
intents and report the queued backlog. They do not invoke a second typed worker;
the authenticated outbox route is the only scheduled provider fan-out path.

**Lease and deadline behavior.** A round is admitted only while a minimum send
window and finalization reserve remain. If setup consumes that window after a
claim, the event is safely returned to retry with `INVOCATION_DEADLINE`. A
provider wait is capped to the lesser of its event timeout and the remaining
shared budget; a last attempt dead-letters instead of becoming an unclaimable
retry. Finalizations keep their heartbeats and receive fair slices of the
remaining reserve, so one failed or slow database transition does not block
the remainder of a sent round. Bounded exhausted-lease cleanup runs after
delivery so maintenance cannot starve the first fair round.

Legacy reconciliation is capped to eight new rows before dispatch. The metrics
read and persistent aggregate log are timeboxed, and logging is skipped after an earlier deadline;
an incomplete read is explicit rather than reported as zero. libSQL statements
cannot be cancelled after admission, so the 45 seconds is the cooperative work
deadline and the 60-second function setting is the outer bound for a slow
storage tail. A claim that settles after the runner stops awaiting it invokes
no provider and is resolved asynchronously to the same bounded deadline
failure; lease expiry remains the crash fallback.

**Alternatives.** Sequential per-type drains were rejected because their
independent batch/timeout limits add together and privilege the first type. A
single oldest-first queue was rejected because a saturated type can still
starve sparse later types. Separate functions per type offer stronger isolation
but multiply schedules, secrets, concurrency, and monitoring. Fair parallel
rounds retain one authenticated endpoint and the existing v6 outbox contract.

**Remaining issue #94 scope.** The password-reset work is being developed on a
sibling stack and its event adapter is not present at this base commit. Issue
#94 must remain open until stack linearization registers that handler and adds
it to the saturated mixed-type runtime test. This candidate makes the registry
extensible but does not claim recovery coverage.
