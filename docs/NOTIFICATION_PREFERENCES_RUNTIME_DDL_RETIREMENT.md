# Notification-preference request-path DDL retirement

Issue: [#172](https://github.com/festus14/randori-circle/issues/172)  
Parent: [#44](https://github.com/festus14/randori-circle/issues/44)  
Decision: [ID-40](IMPLEMENTED_DECISIONS.md#id-40-make-notification-preference-readiness-read-only)

## Boundary

Migration v1 owns `user_notification_prefs`. Authenticated GET, POST, and PUT
requests now prove this exact six-column contract with one read-only query:

```sql
SELECT user_id,email_enabled,sms_enabled,phone,email,updated_at
FROM user_notification_prefs LIMIT 0
```

The probe is isolated in `api/_ops-readiness.js`. Concurrent requests using
one concrete database client share the same in-flight promise. A successful
result is cached for that client; a rejected result is evicted so a later
request can recover after a transient failure. Different clients never share
readiness state.

## Request and failure contract

- Origin validation, supported-method validation, and authentication all run
  before the readiness query.
- Missing or stale schema returns the existing generic `503` response:
  `{"error":"notification preferences unavailable"}`.
- A failed readiness check performs no preference insert/update and writes no
  operational log row.
- Current GET defaults, stored-row responses, POST/PUT normalization, upsert
  fallback, and response envelopes are unchanged.
- Local and hosted runtimes use the same read-only readiness behavior.

This removes one `CREATE TABLE` occurrence from `api/ops.js`, reducing that
module's reviewed allowance from 17 to 16 and repository-wide request-time DDL
from 25 to 24. The remaining operations and AI statements are separate debt
owned by issue #44.

## Verification and rollout

Run:

```sh
npm run check:runtime-ddl
npm run check:syntax
npm run test:coverage
npm run test:e2e
```

Focused tests prove the exact SQL, absence of DDL, coalescing, success-only
caching, retry after failure, per-client isolation, pre-readiness rejection,
GET/POST/PUT compatibility, and failure before DML or logging.

No migration or production-provider mutation belongs to this increment.
Production promotion remains blocked on issue #43 evidence that the target is
at the reviewed latest schema. If readiness fails, inspect and roll forward
through the protected migration workflow. Do not restore request-time table
creation. Rolling back only the application build requires no database
rollback, but reintroduces request-time DDL and is an emergency compatibility
measure rather than normal recovery.
