# Randori Circle implemented decision log

Status: accepted for the private-beta implementation through merged PR #89

Last reviewed: 2026-09-19

Scope: `main` through `2402fe9bea53aa0a44d2af4c43f77e4223894695`

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

Migration order is append-only: v4 binds an account to an OIDC issuer and
subject, v5 makes every application JWT depend on a live hashed session row,
and v6 adds the outbox and its audit history. The protected production workflow
applies no more than one pending version per inspected fingerprint and approval.

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

**Decision.** Never forge or overwrite the provider status. Treat preview
deployment as advisory while quota is unreliable; continue to require the
repository-owned `e2e` workflow and `GitGuardian Security Checks`. Protect and
observe the separate production deployment. The preferred durable replacement
is a required repository-owned build/deployment-configuration validation check,
with the live preview reported separately.

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
