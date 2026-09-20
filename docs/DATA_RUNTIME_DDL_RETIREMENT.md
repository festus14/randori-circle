# Data request-path DDL retirement

Issue: [#166](https://github.com/festus14/randori-circle/issues/166)  
Parent: [#44](https://github.com/festus14/randori-circle/issues/44)  
Decision: [ID-37](IMPLEMENTED_DECISIONS.md#id-37-make-legacy-data-route-readiness-read-only-and-route-scoped)

## Boundary

Migration v1 owns the legacy data schema. Ordinary requests may read or write
application rows only after a read-only projection has proved the contract
they need. They never create a table, add a column, or create an index.

| Contract | Used by | Required migration-owned data |
| --- | --- | --- |
| Admin identity | `/api/init`, admin log reads | `auth_accounts.id`, `email`, `is_admin` |
| Profile | profile reads and writes | Complete account/profile projection |
| Circle | circle | Account/profile and legacy-user projections |
| Weeks | weeks | Account names, legacy users, weeks, groups, and participant provenance |
| My pair | my-pair | Pairing projections, partner profile, and unavailable-email snapshot |
| History | history | Names, weeks, groups, and participant provenance |
| Statistics | stats | Non-demo accounts/weeks, groups, and participant provenance |
| Runs | personal and pair run feeds | Account display, groups, participant provenance, complete run projection |
| Logs | client log ingest, admin log reads, best-effort server logging | Complete `app_logs` projection |

The bundled question catalogue is repository-owned and does not query the
legacy `custom_questions` table. Schedule, message, recap, circle-membership,
and secondary-circle flows retain their narrower existing readiness guards.

## Failure contract

- A missing table or column fails before the route's business write.
- Client-facing responses use the route's existing generic unavailable shape;
  schema details are not returned.
- A failed probe is not cached. The next request retries it.
- Concurrent requests for one client and contract share one in-flight probe.
- Diagnostic logging is best effort. If `app_logs` is unavailable, it falls
  back to process/Sentry reporting and does not attempt schema repair.

## Scope left for the parent

`/api/init` still owns all 45 `api/data.js` DDL occurrences, including its
legacy duplicate-schedule cleanup. It is deliberately unchanged here so its
future conversion can make initialization data-only and atomic in one focused
review. The other remaining allowlisted families are `api/ai.js`,
`api/ops.js`, and `api/_circle-membership.js`.

## Verification and rollout

Run:

```sh
npm run check:runtime-ddl
npm run check:syntax
npm run test:coverage
npm run test:e2e
```

Production promotion remains blocked on #43 evidence that the target database
is at the reviewed latest migration. This change has no migration and must not
be used to mutate or repair production. If readiness fails, stop promotion and
roll forward through the protected migration workflow.
