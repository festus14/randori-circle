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
7. Both read the same safe recap projection. The server is then closed and
   restarted with the same database and local secret, and a real session
   rehydrates the pairing, schedule, chat, workspace, run, and recap.
8. After recovery, the unpaired circle member is denied schedule, chat,
   workspace, run, recap, and execution access. Its final revocation check runs
   only after restart so deliberately invalid membership state cannot weaken
   the startup-readiness assertion.

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

Before its explicit workspace writes, the test asks the authenticated catalogue
to reach its loaded state and observes the workspace module's own lifecycle. An
inactive workspace is an explicit clean no-op. An active workspace must complete
its flush successfully; a false flush result remains a failure. The subsequent
server read fixes the exact durable revision used for the stale-write conflict,
bounded retry, recap, and restart assertions.

## Design choices and alternatives

| Choice | Why it is the default | Alternative considered | Tradeoff |
| --- | --- | --- | --- |
| Real loopback HTTP handlers and a file-backed migrated database | Proves the same auth, transaction, scoping, and server-lifecycle boundaries used by the local product | Mock the API | Faster and more targeted, but cannot prove the complete user journey or durable recovery |
| Create happy-path setup and user state through product endpoints | Proves invitation, authentication, onboarding, and setup transitions produce a usable state. Direct database writes are limited to test-only fault injection, reminder-clock advancement, and post-restart membership revocation | Seed application rows directly | A seeded file database can prove later persistence and recovery more quickly, but skips setup boundaries and can construct states the product cannot reach |
| Three isolated browser contexts | Keeps the owner, invited partner, and unpaired member cookies and client state independent | Switch accounts in one context or call every endpoint from Node | Uses more browser memory, but catches session and browser-state leakage that direct API tests miss |
| Production execution envelope with a process-local deterministic transport | Exercises validation, lease, harness, result parsing, persistence, and the run feed while blocking and recording all current browser HTTP(S) and server `fetch` egress | Call Piston, fake `/api/execute`, or add a production runtime flag | A live provider is nondeterministic and leaks network; faking the route skips the boundary under test; a runtime flag would weaken production isolation. This is an application-transport assertion, not an operating-system network namespace |
| One explicit compare-and-swap conflict and one retry | Proves stale-client recovery is bounded and uses the returned authoritative revision | Sleep-driven concurrent writes or an automatic retry loop | Timing races are flaky; an open-ended loop can hide a broken convergence contract |
| Close and recreate the HTTP server and database client over the same files and secret | Proves persisted sessions and room data survive a complete server lifecycle inside the Playwright worker | Reload the page, spawn a second Node process, or create a new test-only recovery API | Reload proves browser hydration only; a separate process would additionally clear module caches but adds orchestration cost; a test-only API would not exercise startup and readiness |
| Linux Actions is authoritative for Chromium | Uses the repository-pinned browser and dependencies in a reproducible host | Treat each developer's desktop Chromium as the gate | Desktop runs are useful diagnostics, but host policy and browser installation differences must not block a valid candidate |

Focused API and browser suites remain the cheaper place for edge-case matrices.
This journey intentionally proves one representative happy path plus the
highest-value failure boundaries instead of duplicating every focused test.

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
