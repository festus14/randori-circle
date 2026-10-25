# Randori Circle documentation index

Every other file in `docs/` is listed here once, grouped by area, with one
line on what it covers. The repository [README](../README.md) covers what the
app is, the quickstart, tests and deploys.

Status checked on 2026-10-22 against `main`. Many docs open with
"Status: candidate …" because they were written before their change merged.
Everything listed here is merged on `main`. A **Note** marks a doc that is
partly out of date or describes something other than the current runtime.
Decision IDs (ID-nn) refer to the [decision log](IMPLEMENTED_DECISIONS.md).
When you add a doc, add it here too.

## Start here

| Doc | What it covers |
| --- | --- |
| [IMPLEMENTED_DECISIONS.md](IMPLEMENTED_DECISIONS.md) | The decision log: every accepted product, security and operations decision (ID-01 onwards), with context, alternatives and rollout |
| [ENVIRONMENT.md](ENVIRONMENT.md) | Every environment variable the code reads, and the feature flag table with production state and safe switch-off |

A current system design document is tracked in
[#359](https://github.com/festus14/randori-circle/issues/359). The older
architecture plan describes a proposed target, not today's runtime, so it is
listed separately under
[Proposed architecture (not current)](#proposed-architecture-not-current).

## Product and UX

| Doc | What it covers |
| --- | --- |
| [UI_SHELL_ACCESSIBILITY.md](UI_SHELL_ACCESSIBILITY.md) | The accessible app shell: semantic colour roles, WCAG AA contrast, landmarks, keyboard focus and explicit loading and error states (issue #192, ID-47) |
| [SERVER_AUTHORITATIVE_ONBOARDING.md](SERVER_AUTHORITATIVE_ONBOARDING.md) | First-run setup guidance derived from authenticated server state, not local storage (ID-52) |

## Design

| Doc | What it covers |
| --- | --- |
| [design/UI_REDESIGN_SPEC.md](design/UI_REDESIGN_SPEC.md) | The UI redesign spec: Dojo Indigo tokens, `rc-` components, navigation and work packages. Its status line says "proposed", but it is the working reference for all UI changes |

## Auth and identity

| Doc | What it covers |
| --- | --- |
| [AUTH_CLAIM_BINDING.md](AUTH_CLAIM_BINDING.md) | Binding invitation preparation and OAuth intent to one prepared claim, so an older flow cannot authorize a newer one (ID-44) |
| [INVITE_GATED_SIGNUP.md](INVITE_GATED_SIGNUP.md) | Account creation only in the tab that prepared a live invitation (ID-45) |
| [LIFECYCLE_RECENT_AUTH.md](LIFECYCLE_RECENT_AUTH.md) | Ten-minute recent-authentication step-up for ownership transfer, co-owner and app admin changes, and deactivating another owner (ID-14) |

Google OAuth setup is in the root [GOOGLE_OAUTH.md](../GOOGLE_OAUTH.md). Key
rings are under [Operations runbooks](#operations-runbooks).

## Circles and membership

| Doc | What it covers |
| --- | --- |
| [ADMIN_DATA_INITIALIZATION.md](ADMIN_DATA_INITIALIZATION.md) | The one-time, data-only `POST /api/init` primary-circle cutover before `CIRCLE_MEMBERSHIP_ENABLED` (ID-39) |
| [MEMBER_LIFECYCLE.md](MEMBER_LIFECYCLE.md) | Leaving, deactivation, reactivation, ownership transfer, co-owners and app admins (ID-12, ID-69) |
| [INVITE_REQUESTS.md](INVITE_REQUESTS.md) | Public "Request an invite" intake and owner review, without enumeration (migration v21, ID-66) |
| [ACTIVE_CIRCLE_CONTEXT.md](ACTIVE_CIRCLE_CONTEXT.md) | The selected-circle control plane and its rollout and rollback order (ID-21). Behind flags that are off in production |
| [CIRCLE_CREATION.md](CIRCLE_CREATION.md) | Creating and selecting a secondary circle as one idempotent operation (ID-29). Off in production |
| [CIRCLE_ARCHIVE.md](CIRCLE_ARCHIVE.md) | Soft-archiving a secondary circle with recent auth and safe fallback (ID-38). Off in production |

## Pairing

| Doc | What it covers |
| --- | --- |
| [EXPLICIT_CYCLE_AVAILABILITY.md](EXPLICIT_CYCLE_AVAILABILITY.md) | The explicit "Available" or "Skip this cycle" decision for the upcoming cycle (ID-56) |
| [PAIRING_PUBLICATION_TOTALITY.md](PAIRING_PUBLICATION_TOTALITY.md) | Weekly publication admitted only on Sunday 08:00 to 10:00 UTC by database time (ID-50) |
| [PAIRING_PUBLICATION_RECOVERY.md](PAIRING_PUBLICATION_RECOVERY.md) | Showing a missing weekly pairing from server state and the owner's one recovery action (ID-51) |
| [SELECTED_CIRCLE_PAIRING.md](SELECTED_CIRCLE_PAIRING.md) | Pairing coordination in a selected secondary circle without workspace access (ID-26). Off in production |

## Scheduling

| Doc | What it covers |
| --- | --- |
| [SCHEDULE_EXPIRY.md](SCHEDULE_EXPIRY.md) | Proposals and acceptances must be strictly in the future by database time (ID-53) |
| [CALENDAR_EXPORT.md](CALENDAR_EXPORT.md) | Private `.ics` export of an accepted session, generated in the browser (ID-27) |
| [PRIVATE_MEETING_LINKS.md](PRIVATE_MEETING_LINKS.md) | One private HTTPS meeting link per accepted primary session (ID-57) |
| [SECONDARY_SCHEDULING.md](SECONDARY_SCHEDULING.md) | Scheduling for a secondary-circle pair, and the v13 to v16 rollout sequence (ID-33). Off in production. **Note:** its "52 application tables and 56 named indexes" count predates later migrations |

## Notifications and outbox

| Doc | What it covers |
| --- | --- |
| [OUTBOX_INVOCATION_BUDGET.md](OUTBOX_INVOCATION_BUDGET.md) | The fair, eight-claim, 45-second budget shared by every email type in `/api/cron/outbox` (ID-15) |
| [INVITATION_EMAIL_DELIVERY.md](INVITATION_EMAIL_DELIVERY.md) | Encrypted, gated invitation email with the copy-link fallback (ID-25) |
| [SCHEDULE_NOTIFICATIONS.md](SCHEDULE_NOTIFICATIONS.md) | Primary-room schedule emails and the 24-hour session reminder |
| [SECONDARY_SCHEDULE_NOTIFICATIONS.md](SECONDARY_SCHEDULE_NOTIFICATIONS.md) | Dashboard-only schedule emails for secondary pairs (ID-34). Off in production |
| [REMINDERS.md](REMINDERS.md) | Availability-cutoff reminder, agree-a-time nudge and one-hour session reminder (ID-71) |

The outbox scheduler and its watchdog are under
[Operations runbooks](#operations-runbooks). Immediate after-commit delivery is
ID-64 in the decision log.

## Practice and execution

| Doc | What it covers |
| --- | --- |
| [CONFLICT_FREE_CODE_DOCUMENTS.md](CONFLICT_FREE_CODE_DOCUMENTS.md) | The shared Yjs code document per pair room; Run executes only the acknowledged version (migration v20, ID-65) |
| [SESSION_CONTROLS.md](SESSION_CONTROLS.md) | The shared 25-minute focus timer and candidate assignment for a pair room (ID-58) |
| [SESSION_COMPLETION.md](SESSION_COMPLETION.md) | A session counts as completed only when every participant confirms (ID-55) |
| [CONTENT_POLICY.md](CONTENT_POLICY.md) | What exercise content the project may ship; third-party questions are never crawled or imported |
| [CATALOG_PROVENANCE.md](CATALOG_PROVENANCE.md) | The rights manifest, content hashes and the emergency takedown procedure (ID-22) |
| [CATALOGUE_PACK_V3.md](CATALOGUE_PACK_V3.md) | The nine-exercise original pack v3 and its review (ID-60) |

Code execution has no separate doc: see ID-62 (provider choice) and ID-74 (live
execution smoke check) in the decision log, and `EXECUTION_PROVIDER` in
[ENVIRONMENT.md](ENVIRONMENT.md).

## Insights

| Doc | What it covers |
| --- | --- |
| [PROGRESS_DASHBOARD.md](PROGRESS_DASHBOARD.md) | Each member's own progress in History: sessions, streak, coverage, run outcomes (ID-76) |
| [CIRCLE_HEALTH.md](CIRCLE_HEALTH.md) | The owner-only aggregate Circle health card, with small counts hidden (ID-78) |

Exercise suggestions (ID-77) and admin Diagnostics (ID-73) are described in the
decision log.

## Privacy and data

| Doc | What it covers |
| --- | --- |
| [ACCOUNT_DELETION.md](ACCOUNT_DELETION.md) | Self-service account deletion by tombstoning, and the inventory of what is deleted or kept (ID-81) |
| [DATA_EXPORT.md](DATA_EXPORT.md) | Member data export: a JSON archive of the member's own data, partners by display name only, behind `DATA_EXPORT_ENABLED` (ID-89) |
| [CHAT_RETENTION.md](CHAT_RETENTION.md) | The 90-day chat retention policy and the gated, evidence-bound purge runbook (ID-20). Destructive production use is off |

The public [privacy policy](../privacy.html) and [terms](../terms.html) are
static pages (ID-79). Outbox personal-data retention is ID-83, and the
no-raw-IP rule for `app_logs` is ID-82.

## Database and schema

| Doc | What it covers |
| --- | --- |
| [DATABASE_SCHEMA_OPERATIONS.md](DATABASE_SCHEMA_OPERATIONS.md) | The schema manifest, read-only drift inspection (`db:status`, `db:plan`) and the local migration runner. **Note:** its "55 application tables and 63 named indexes" count is out of date (the manifest has 57 and 70), and its last paragraph says production mutation is still blocked, although protected migrations have since been applied |
| [CHAT_INDEX_MIGRATION.md](CHAT_INDEX_MIGRATION.md) | Migration v10: the two chat indexes and the query plans they serve (ID-18) |
| [DATA_RUNTIME_DDL_RETIREMENT.md](DATA_RUNTIME_DDL_RETIREMENT.md) | Historical record: data routes stopped creating schema at request time (ID-37) |
| [NOTIFICATION_PREFERENCES_RUNTIME_DDL_RETIREMENT.md](NOTIFICATION_PREFERENCES_RUNTIME_DDL_RETIREMENT.md) | Historical record: notification preferences became read-only readiness (ID-40) |
| [AI_RUNTIME_DDL_RETIREMENT.md](AI_RUNTIME_DDL_RETIREMENT.md) | Historical record: AI routes stopped creating schema at request time (ID-41) |
| [OPERATIONS_RUNTIME_DDL_RETIREMENT.md](OPERATIONS_RUNTIME_DDL_RETIREMENT.md) | Historical record: admin operations stopped creating schema; runtime DDL forbidden in CI (ID-42) |

Why Turso, and its rollout notes, are in the root [TURSO.md](../TURSO.md).
**Note:** its opening paragraph still says request-path DDL removal is pending
and production mutation is disabled. Both are out of date (ID-42; protected
migrations have run).

## Operations runbooks

| Doc | What it covers |
| --- | --- |
| [PRODUCTION_BOOTSTRAP_GUIDE.md](PRODUCTION_BOOTSTRAP_GUIDE.md) | The operator checklist from a dark deploy to the invite-only MVP: every Vercel and GitHub value, the protected migration order, flags, canonical domain. **Note:** the §11 stage table ("Today: 503") and the §10.1 remark that mail arrives in 5 to 15 minutes describe the pre-launch state; auth mail is now sent right after commit (ID-64) and the outbox runs every five minutes from cron-job.org (ID-67) |
| [TURSO_PRODUCTION_MIGRATION.md](TURSO_PRODUCTION_MIGRATION.md) | The protected status, adopt and apply workflow, one version per approved rehearsal (ID-28). **Note:** its closing line about waiting for a first real rehearsal is out of date |
| [TURSO_BACKUP_RESTORE_REHEARSAL.md](TURSO_BACKUP_RESTORE_REHEARSAL.md) | The Monday PITR restore rehearsal into a disposable database, with the hourly watchdog (ID-16) |
| [BACKUP_WATCHDOG_ACTIVATION.md](BACKUP_WATCHDOG_ACTIVATION.md) | Why the backup watchdog's activation epoch is fixed at 2026-09-21 03:17 UTC (ID-54, ID-75) |
| [KEY_ROTATION.md](KEY_ROTATION.md) | Staged, forward-only rotation of the four credential key rings through the key-control workflow (ID-19, ID-31) |
| [OUTBOX_EXTERNAL_SCHEDULER.md](OUTBOX_EXTERNAL_SCHEDULER.md) | Setting up cron-job.org to call `/api/cron/outbox` every five minutes with `OUTBOX_DISPATCH_SECRET` (ID-67) |
| [OUTBOX_DISPATCH_WATCHDOG.md](OUTBOX_DISPATCH_WATCHDOG.md) | The hourly watchdog that alerts on outbox delivery health (ID-43, updated by ID-67) |

The chat retention runbook is under [Privacy and data](#privacy-and-data).
Incident runbooks and a postmortem template are tracked in
[#361](https://github.com/festus14/randori-circle/issues/361).

## Testing and CI

| Doc | What it covers |
| --- | --- |
| [testing/E2E_GOLDEN_PATHS.md](testing/E2E_GOLDEN_PATHS.md) | The golden-path matrix: each journey and its real-runtime Playwright spec |
| [testing/COVERAGE_BASELINE.md](testing/COVERAGE_BASELINE.md) | The measured unit coverage baseline and the `test:coverage` gate |
| [TWO_USER_LOCAL_SESSION_E2E.md](TWO_USER_LOCAL_SESSION_E2E.md) | The two-invited-members journey against the local runtime, and how to triage it |
| [AVAILABILITY_TEST_CLOCK.md](AVAILABILITY_TEST_CLOCK.md) | The deterministic test clock for availability fixtures (ID-48) |
| [DEPLOYMENT_GATES.md](DEPLOYMENT_GATES.md) | Required merge checks (`deployability`, `e2e`, GitGuardian) and why Vercel previews are advisory (ID-07) |
| [GITHUB_ACTIONS_NODE24.md](GITHUB_ACTIONS_NODE24.md) | First-party actions pinned to reviewed commits on the Node 24 runtime |
| [UBUNTU_RUNNER_PINNING.md](UBUNTU_RUNNER_PINNING.md) | Required jobs pinned to `ubuntu-24.04`, plus the optional Ubuntu 26 canary |

## Proposed architecture (not current)

These describe a possible future platform. None of it is what runs today
(Vercel functions plus Turso); see the [README](../README.md#how-it-is-built)
for the current stack.

| Doc | What it covers |
| --- | --- |
| [PRODUCTION_ARCHITECTURE_PLAN.md](PRODUCTION_ARCHITECTURE_PLAN.md) | A possible Next.js/PostgreSQL end state and delivery plan. **Note:** a proposal, not the current runtime (Vercel functions plus Turso). A current system design document is tracked in [#359](https://github.com/festus14/randori-circle/issues/359) |
| [randori-production-architecture.png](randori-production-architecture.png) | Diagram for the architecture plan above. **Note:** shows the proposed target (Next.js, Supabase, Liveblocks, LiveKit), not what runs today |
| [randori-production-architecture.svg](randori-production-architecture.svg) | Browser-viewable copy of the same target diagram |
| [randori-production-architecture.excalidraw](randori-production-architecture.excalidraw) | Editable Excalidraw source of the same target diagram |
