# AI request-path DDL retirement

Issue: [#173](https://github.com/festus14/randori-circle/issues/173)

Parent: [#44](https://github.com/festus14/randori-circle/issues/44)

Decision: [ID-41](IMPLEMENTED_DECISIONS.md#id-41-make-ai-readiness-read-only-and-route-scoped)

## Boundary

Migration v1 owns `ai_sessions`, `ai_feedback`, `ai_usage`,
`ai_account_monthly_usage`, `ai_account_monthly_reservations`, `ai_consents`,
`app_logs`, and the log indexes. Ordinary AI requests no longer create or
repair those objects. No new migration is required because the canonical
migration already contains every retired statement.

`api/_ai-readiness.js` exposes four read-only contracts. Analyze projects the
complete set of columns used for trusted-room resolution, consent, monthly and
daily quota, quota reservations, session persistence, feedback persistence,
and account classification. When membership enforcement is enabled, analyze
also projects the circle and membership columns used by its access join.
Feedback and history project only the records,
ownership, usage, and quota columns used by those routes. Logging has a
separate app-log projection so diagnostic availability cannot become a
dependency of a valid primary response.

Because analyze writes use three `ON CONFLICT` targets, readiness additionally
checks the migration-owned primary-key order for `ai_usage(date)`,
`ai_account_monthly_usage(month,user_id)`, and `ai_consents(user_id)` through
read-only table metadata. A column-compatible table without those constraints
is not ready.

Each contract is coalesced per concrete database client. Only a successful
probe is retained. A rejected promise is evicted, allowing the next request to
retry after an operator restores the migration-owned schema; clients never
share readiness state.

## Request and failure contract

- Origin, supported method, authentication, consent input, content input, and
  canonical room syntax are rejected before analyze readiness.
- Feedback and history reject unsupported methods and unauthenticated or
  invalid authenticated identities before readiness.
- Analyze proves its entire route contract before recording consent, reading
  or reserving quota, writing a session, or calling Groq/OpenAI.
- A missing or stale primary contract returns the generic `503` envelope
  `{"error":"AI service temporarily unavailable"}` without DDL, DML, quota
  mutation, or provider traffic.
- Feedback and history also fail closed with that generic response instead of
  executing a partially compatible query.
- App logging checks only its own read-only projection. Failure is swallowed
  as best-effort diagnostics and cannot replace an analyze result or trigger
  schema repair. Logging reuses the request database client when one already
  exists, preserving the same per-client isolation without another connection.
- The obsolete reduced-column session and feedback insert retries are removed;
  current writes have one unambiguous migration-owned shape.

Trusted room/source authorization, all-participant consent, account and global
quota limits, the attached-reservation/no-refund-after-provider boundary,
provider timeout/fallback behavior, response envelopes, and circle/workspace
gates remain unchanged.

This removes all eight DDL signatures from `api/ai.js`, reducing the reviewed
repository allowance from 24 to 16. The remaining statements are isolated to
operations debt tracked by issue #44.

## Verification and rollout

Run:

```sh
npm run check:runtime-ddl
npm run check:syntax
npm run test:coverage
npm run test:e2e
```

Focused tests pin every projected column, per-client coalescing, success-only
caching, retry after failure, route isolation, pre-readiness validation, every
analyze contract failure, feedback/history failure, non-blocking log failure,
the absence of runtime DDL, and existing security/response behavior.

No production database or AI-provider mutation belongs to this increment.
Promotion remains blocked on issue #43 evidence that production is at the
reviewed latest schema. A failed probe requires inspection and roll-forward
through the protected migration workflow. Reverting the application build
requires no database rollback, but reintroduces request-time schema mutation
and is only an emergency compatibility action.
