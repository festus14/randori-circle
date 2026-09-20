# Deterministic availability test clock

Issue #193 is a test-only reliability increment. Production availability,
active-circle, pairing, and onboarding behavior is unchanged.

## Root cause

Availability mutations intentionally evaluate two clocks: the injected request
instant selects the editable cycle, while SQLite `now` is checked again in the
conditional write to prevent a request that crosses the cutoff from committing.
Several tests selected the cycle containing Friday 2026-09-18. Once the real
database clock reached that cycle's Sunday 08:00 Europe/London cutoff, their
otherwise valid writes correctly failed with `AVAILABILITY_CUTOFF_CLOSED`.

The seven observed failures were two active-circle availability tests and five
availability persistence, concurrency, scope, retry, and ambiguous-commit
tests. No production regression caused them.

## Test contract

- Non-boundary mutation tests use the explicit Friday
  `2099-09-18T12:00:00.000Z` cycle (and named adjacent instants where needed).
  This keeps the real SQLite guard active while separating routine tests from
  the historical 2026 boundary fixture.
- The availability boundary test supplies a test-only database clock and proves
  that a write succeeds at `2026-09-20T06:59:59.999Z` and fails at
  `2026-09-20T07:00:00.000Z`, exactly Sunday 08:00 in Europe/London.
- The cross-cutoff CAS test still proves that the independent database clock can
  reject a request whose application clock began before the cutoff.
- Pairing-cycle and pairing-publication boundary suites retain their explicit
  BST, GMT, DST-transition, and ISO-year cases.
- Real-runtime pairing and local-onboarding browser tests continue to consume
  the server's live upcoming cycle; their correctness does not depend on a
  historical cycle remaining editable.

## Audit result

| Surface | Result |
| --- | --- |
| `tests/unit/availability.test.mjs` | Successful writes moved off the historical cycle; intentional cutoff cases retained and strengthened. |
| `tests/unit/active-circle.test.mjs` | Availability reads and writes share one named safe editable instant. |
| Pairing cycle/publication unit tests | Already use explicit injected instants; no accidental availability mutation against SQLite wall time. |
| Local onboarding and real-runtime pairing E2E | Already obtain the current/upcoming cycle from the live API; no fixed expired cycle. |
| Mocked availability UI E2E | Uses synthetic envelopes and relative browser timers only; no database cutoff enforcement is exercised. |

## Alternatives considered

- **Change production to trust only the injected application clock:** rejected;
  this removes the independent commit-time cutoff protection.
- **Fake SQLite time in every mutation test:** rejected for routine paths because
  it would stop those tests from exercising the real SQL guard. The narrow fake
  remains appropriate for exact before/at-boundary assertions.
- **Compute a cycle from the current day:** rejected because expected cycle IDs
  and descriptors would vary by run and hide fixture drift.
- **Skip or conditionally relax tests after cutoff:** rejected because it would
  silently reduce coverage at precisely the security boundary being enforced.

## Verification

Run:

```sh
node --experimental-test-module-mocks --test \
  tests/unit/availability.test.mjs \
  tests/unit/active-circle.test.mjs \
  tests/unit/circle-pairing.test.mjs \
  tests/unit/pairing-cycle.test.mjs \
  tests/unit/pairing-publication.test.mjs \
  tests/unit/local-server.test.mjs
npm run test:coverage
npm run test:migrations
npm run check:syntax
npm run check:deployability
```

Linux Playwright remains the authoritative browser run because Chromium cannot
launch reliably in the current macOS host environment.
