# Secondary-circle schedule notification runbook

Status: implemented behind a separate default-off delivery flag; no migration
after v16.

## Contract

`SECONDARY_CIRCLE_SCHEDULE_EMAIL_ENABLED=true` is effective only when the
complete membership, control-plane, availability, coordination, and secondary
scheduling flag chain is enabled. Schedule writes remain available when this
delivery flag is false.

Secondary notifications reuse `schedule.email.requested` with
`event_version=2`. Primary schedule-email v1 remains unchanged, and the outbox
therefore keeps its existing five fair event-type lanes. The successful v16
schedule compare-and-swap transaction enqueues the intents before commit:

| Mutation | Kind | Recipients |
| --- | --- | --- |
| Propose | `proposal` | Partner only |
| Remove | `removed` | Partner only |
| First acceptance | `accepted` plus `reminder` | Both members |
| Change accepted time | `changed` plus `reminder` | Both members |
| Clear accepted time | `cleared` | Both members |
| Accept/clear without a state change | none | none |

Conflicts, rollback, and ambiguous commits are never retried into a second
write. The idempotency key is
`secondary-schedule-email/v1/{schedule_id}/{revision}/{kind}/{recipient}`.

The exact payload fields are `schedule_id`, `proposal_id`,
`schedule_revision`, `actor_user_id`, `recipient_user_id`, `kind`,
`instant_fingerprint`, and `template_version`. The instant fingerprint is a
domain-separated SHA-256 digest used only where current state must match an
instant. The event stores no email address, circle name, publication/group/room
identifier, raw instant, token, or rendered content.

## Dispatch and suppression

Immediately before provider access, v2 dispatch re-resolves and checks:

- the exact schedule/publication/cycle/group ownership tuple and the one current
  publication for its circle;
- a secondary, unarchived circle and exact two-member non-solo pair;
- active non-demo actor, recipient, and partner memberships, without consulting
  either member's selected-circle session context;
- exact current schedule revision and kind-specific proposal/agreement state,
  including the instant fingerprint when applicable;
- the recipient's current notification preference and current email address;
- that a rendered proposal, agreement, or reminder time has not elapsed.

Any failed check terminates as `suppressed` before provider access. Exact
revision checking suppresses stale A→B→A agreement and reminder events even
when the final instant matches an older state. Rendering uses current account
and circle data and links only to `/?view=dashboard`; it creates no room, chat,
video, execution, recap, or AI capability.

Provider 429 and 5xx failures use the existing bounded retry/backoff and
dead-letter policy. The provider idempotency key remains stable through lease
recovery. Existing outbox retention and audit evidence apply: actor/recipient
IDs, fingerprints, `not_before`, terminal state, and audits remain available.
A broader bounded deletion policy is separate platform work because audit rows
currently restrict event deletion.

## Rollout and rollback

1. Apply and canary migration v16 and secondary scheduling with
   `SECONDARY_CIRCLE_SCHEDULE_EMAIL_ENABLED=false`.
2. Rehearse proposal, removal, acceptance, change, clear, delayed reminder,
   preference-off, member departure, archive, stale revision, A→B→A, provider
   retry, and dead-letter paths in staging.
3. Verify the authenticated five-minute outbox schedule, canonical `APP_URL`,
   sender configuration, five-type fairness metrics, and aggregate backlog.
4. Enable the flag for a production canary and expand gradually while watching
   only aggregate delivery, suppression, retry, dead-letter, and lag signals.

Rollback disables only `SECONDARY_CIRCLE_SCHEDULE_EMAIL_ENABLED`. New schedule
writes continue but enqueue no v2 email. Already queued v2 work suppresses at
dispatch while schedule rows, terminal events, and audit evidence remain.
Provider failure never rolls back a committed schedule.

## Alternatives considered

| Option | Advantage | Cost and decision |
| --- | --- | --- |
| New event type and queue lane | Explicit secondary metric | Adds a sixth fair lane and duplicate worker policy; rejected |
| Store raw instants and addresses | Simpler templates | Retains stale personal data; rejected in favor of fingerprints and dispatch lookup |
| Send during the API request | Immediate provider feedback | Couples schedule durability to provider latency/failure; rejected |
| Post-commit fan-out | Keeps schedule code smaller | Creates a durable schedule with no durable intent and needs reconciliation; rejected |
| Mutate or delete stale reminders | Smaller pending queue | Adds cancellation races and loses audit history; immutable events plus suppression chosen |
