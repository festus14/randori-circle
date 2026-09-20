# Server-authoritative first-run guidance

Status: candidate increment for issue #198. No schema, migration, environment,
provider, or API protocol change.

## Decision

First-run progress is a derived browser view over existing authenticated server
contracts. Local storage may remember whether someone dismissed the explanatory
tour, but it is never evidence that a product task is complete or that another
account's checklist may be hidden.

| Step | Authority | Complete when |
| --- | --- | --- |
| Sign in | `GET /api/auth/me` | The live HttpOnly session resolves to a positive account ID. |
| Profile | `GET /api/profile` | The response belongs to that account and contains a non-empty display name and valid IANA timezone. |
| Availability | `GET /api/settings/availability` | The active circle's exact upcoming `cycleKey` has `source: "user"`. A `cycle_default` or `legacy_bridge` value is useful UI state, but is not an explicit save for the target cycle. |
| Pairing | `GET /api/my-pair` | The active circle returns a published assignment whose current-cycle window is valid at the database-observed `publication_state.observed_at`. Cached week DOM, the browser clock, and demo storage are ignored. |
| Workspace | Current-pair response plus authorized workspace hydration | The assignment advertises a workspace and the hydrated room equals its exact canonical week/pair room for the same account and circle scope. A stale `randori-last-room` value never counts. |

The optional workspace step is hidden for unpublished assignments and for
coordination-only secondary circles. AI is deliberately absent from onboarding:
the current server has no read-only public AI capability endpoint, so showing an
AI step would claim readiness that the client cannot prove. Video is likewise
not promised by the setup checklist; browser media support alone cannot prove
end-to-end signaling readiness. Product controls outside onboarding retain their
existing behavior and can be gated in a separate capability-contract increment.

## State and request fencing

There is deliberately no single onboarding request. The profile editor owns a
separately coalesced and abortable profile generation, the availability owner
and aggregate refresh own the upcoming cycle, and the dashboard owns the
current-pair read. The checklist observes those existing authorities instead
of issuing competing duplicate reads. They share the same scope vocabulary;
before applying a response, the relevant owner captures:

- live account ID;
- circle-control epoch;
- active circle public ID and context version when multi-circle control is on;
- the upcoming cycle key and start boundary returned by the availability owner.

Every response is ignored unless its request generation, live account, and
captured circle operation still match. Cycle-scoped availability and pairing
state must additionally match the captured upcoming cycle key and adjacent
cycle boundary. Identity changes, sign-out, circle selection, availability
rollover, and explicit retries abort or invalidate the old generation.
Availability uses the app's coalesced, context-versioned loader. Pairing is
observed from the dashboard's already-fenced current-pair loader after the
weekly-recovery parser accepts its publication state. Current-cycle validation
reuses that database observation instant rather than a potentially skewed
browser clock. When the availability target rolls over, the old dashboard read
is aborted and the visible dashboard's existing loader reacquires the new
current-cycle assignment after the new scope is established. Workspace
completion is recomputed at render time from the current published room and the
authenticated workspace hydrator; it is not persisted separately.

Profile is deliberately independent of weekly availability. Its read and write
start without waiting for availability, then apply only while the live account,
circle operation, and context version still match. An availability outage does
not make the account profile unreadable or unsavable. It cannot complete
availability or pairing while either authority is unknown.

The profile router waits for the authority's explicit readiness event before it
classifies a server profile. This closes the fast-auth/document-parsing race
without a timeout: the provider is a later inline script in the same document,
so normal parsing installs it before `DOMContentLoaded`. The listener is
removed on the first valid authority and its promise resolves only once. API
failures remain an explicit unknown/retry state.

Profile editing has a separate abortable request generation. Loading, saving,
saved, validation-error, and server-error states are rendered in an inline live
region. A retry button repeats the failed load or save. A delayed response cannot
write browser identity state, mark onboarding complete, or navigate after its
account/circle/context fence has changed.

## Alternatives considered

### Persist onboarding flags in the database

Pros: durable analytics and explicit acknowledgement history.

Cons: duplicates facts already represented by profile, availability,
publication, and workspace records; requires a migration and synchronization
rules; can drift when a cycle or circle changes. Rejected for the MVP.

### Keep localStorage completion flags

Pros: trivial, fast, and available offline.

Cons: crosses accounts in a shared browser, survives circle/cycle changes, and
can report success while every authoritative request is failing. Rejected as a
truth source; retained only for tour dismissal.

### Add AI and video booleans to auth capabilities

Pros: onboarding could advertise those features proactively.

Cons: AI readiness includes feature flag, schema, provider, consent, quota, and
room scope; video also depends on browser media and an authorized room. A pair
of broad booleans would be misleading, and changing the public auth protocol is
not required for useful onboarding. Deferred to a separately designed
capability endpoint if product discovery needs it.

### Build a new aggregate onboarding API

Pros: one round trip and a single transaction could provide a point-in-time
view.

Cons: duplicates mature authorization paths and expands the server protocol.
The current client reuses bounded, independently fenced reads and fail-closes
each field independently, so the extra endpoint is not justified yet.

## Rollout and rollback

Roll out as a client-only increment after weekly publication recovery. Canary
with a new invited account, a saved Available choice, a saved Skip choice, an
unpublished cycle, a primary published room, a coordination-only secondary
pair, sign-out during delayed reads, and an active-circle switch during delayed
reads. Monitor ordinary API error telemetry; onboarding introduces no writes.

Rollback is code-only. Reverting restores heuristic guidance but does not alter
profile, availability, pairing, or workspace data. If the new checklist causes
unexpected request load, disable its refresh triggers first and retain the
inline profile save/error behavior while investigating.

## Verification

- `npm run check:syntax`
- `npm run check:runtime-ddl`
- `npm run check:deployability`
- `npm run test:migrations`
- `npm run test:coverage`
- `npx playwright test tests/e2e/onboarding.spec.ts tests/e2e/onboarding-authority.spec.ts tests/e2e/availability-ui.spec.ts tests/e2e/ui-shell-accessibility.spec.ts`
