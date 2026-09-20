# Two-user local session E2E

The authoritative complete-session check is the Playwright case named
`two invited members complete the durable local session journey` in
`tests/e2e/pairing-real-runtime.spec.ts`. It is a confidence test for the local
MVP, not a replacement for focused API, browser, migration, or provider-canary
coverage.

## Architecture

The test starts the real loopback server against a new private temporary root
and file-backed SQLite database. The server runs the checked-in migrations and
uses the production request handlers. Three isolated browser contexts model the
owner, invited partner, and an active circle member who was not included in the
published pair. No test inserts application rows directly.

The journey crosses the same scoped boundaries as the product:

1. The owner signs in and creates an email-bound invitation.
2. The invitee consumes that invitation, creates an account, and persists a
   profile. Both identities resolve the same circle with different roles.
3. Both save availability for the same immutable cycle. The owner retries one
   injected pre-commit failure and publishes one two-person pairing.
4. The pair agrees a versioned schedule, exchanges durable messages, and saves
   a revisioned code-and-board workspace.
5. A deliberately stale workspace compare-and-swap receives the authoritative
   revision and succeeds on one explicit bounded retry.
6. Both browsers join the canonical room and hydrate the same workspace. The
   owner executes the saved solution, and both members observe its attested
   room run in the feed.
7. Both read the same safe recap projection. The unpaired circle member is
   denied schedule, chat, workspace, run, recap, and execution access.
8. The server is closed and restarted with the same database and local secret.
   A real session then rehydrates the pairing, schedule, chat, workspace, run,
   and recap from durable state.

Browser traffic is allowed only to the runtime's `127.0.0.1` origin. The one
normally external execution boundary is replaced inside this test process by a
deterministic local transport. It accepts only the exact Piston JavaScript
envelope, executes the production-generated VM harness in an isolated child
Node process, and returns the provider-shaped result. It rejects and records
every other server-side network destination. This does not add a runtime flag,
change `api/data.js`, or weaken the production Piston/sandbox boundary.

The runtime SQL observer covers all API requests before and after restart and
must observe zero `CREATE`, `ALTER`, or `DROP` statements. Migration DDL remains
startup-only.

## Running it

```bash
npx playwright test tests/e2e/pairing-real-runtime.spec.ts
```

The authoritative result is the Linux Actions `e2e` job. Playwright retains a
trace and screenshot on failure through the repository configuration. The full
candidate must also pass:

```bash
npm run check:deployability
npm run validate:catalog
npm run check:runtime-ddl
npm run check:syntax
npm run test:migrations
npm run test:coverage
npm run test:e2e
```

Coverage must remain above the repository's 52% line, branch, and function
thresholds (and therefore above the product requirement of 50%).

## Failure triage

- Invitation, profile, circle, availability, or publication failure: inspect
  the first failing HTTP payload and the temporary Playwright trace. Do not
  patch the database to advance the scenario.
- A 409 workspace failure on the first write indicates leaked state. A missing
  409 on the stale member write indicates that compare-and-swap protection was
  weakened. More than one recovery write indicates an unbounded retry.
- An execution failure with no recorded local request means the request failed
  before the transport boundary, usually authentication, room access, catalogue
  validation, or execution lease acquisition. An unexpected-network entry is
  a hard isolation failure.
- Missing chat, run, or recap state after restart indicates persistence or
  session-secret recovery drift. Check the API response before treating it as a
  browser hydration problem.
- Any request-path DDL observation is a release blocker. Move schema work to an
  append-only migration; never loosen the exact-zero assertion.
- Reproduce browser-only failures from the retained Linux trace first. Local
  macOS Chromium launch failures are host tooling failures and do not override
  the authoritative Linux result.

