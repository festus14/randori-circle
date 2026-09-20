# Backup watchdog activation contract

## Decision

The independent backup watchdog has one immutable, code-reviewed activation
epoch: **2026-09-21 03:17 UTC**. This is the first Monday rehearsal slot after
the protected rehearsal workflow was deployed. The value is committed as
`WATCHDOG_CONTROL_ACTIVATION_AT` in the watchdog workflow, rather than supplied
by a repository variable, secret, dispatch input, or the observer's current
time. Both hourly scheduled runs and manual workflow dispatches therefore use
the same clock contract.

The assessor accepts only a canonical UTC timestamp aligned exactly to the
rehearsal's Monday 03:17 UTC schedule. It freezes one observation time for run
and artifact discovery. Its state transition is:

| Observation time | Result | Readiness meaning |
|---|---|---|
| Before activation | `setup_pending`, `ok: false`, `alert: false` | The control is not active and recovery readiness is unavailable. No rehearsal `expectedAt` or run identity is invented. |
| At or after activation, with no qualifying run | `run_missing`, `ok: false`, `alert: true` | The active control fails closed and the workflow alerts its accountable owner. |
| At or after activation, with a current run | Existing `observing`, failure, staleness, artifact, and verification rules apply. | Only an exact successful scheduled run and independently verified monitor artifact can become `healthy`. |

`setup_pending` retains only the activation timestamp and the stable operator
action `configure_protected_rehearsal_and_wait_for_activation`. It performs no
GitHub API discovery and exposes no secret or provider value. The watchdog still
uploads this sanitized artifact, but the green bootstrap workflow is not backup
readiness evidence and cannot authorize a migration or close the production
rehearsal gate.

At activation, the expected slot is clamped to the activation epoch. Runs,
artifacts, and monitor projections created for any earlier slot cannot satisfy
the control. Every alert, candidate, observing, and healthy watchdog artifact
then carries both `activationAt` and an `expectedAt` that is not earlier than
activation. Download verification independently rejects discovery artifacts
whose activation, expected slot, or run creation order could weaken that rule.
The normal two-hour weekly scheduling grace applies after the first activated
week: before a later Monday's grace expires, the prior post-activation success
can remain current; afterward the new Monday slot is mandatory.

## Operator activation checklist

Before 2026-09-21 03:17 UTC:

1. Configure the protected `turso-migration-rehearsal` environment exactly as
   specified in the rehearsal runbook, including owner notifications.
2. Confirm the default-branch scheduled workflow is enabled. A manual watchdog
   dispatch may be used to inspect the `setup_pending` artifact, but it does not
   run the provider rehearsal.
3. Let the protected scheduled rehearsal start at the activation slot, or run a
   separately confirmed protected rehearsal if operational policy requires it.
4. Require the watchdog's final `healthy` artifact before claiming recurring
   restore readiness. `setup_pending`, `observing`, `candidate`, and every alert
   remain non-ready states.

No step in this change creates an environment, stores credentials, changes a
provider, or dispatches a provider-bearing rehearsal.

## Alternatives considered

| Option | Pros | Cons | Decision |
|---|---|---|---|
| Reviewed activation epoch | Deterministic, auditable in code review, identical for schedule and dispatch, cannot slide on reruns, and can reject all earlier evidence. | A future deployment must deliberately update the epoch and control digest when establishing a genuinely new control. | Chosen. |
| Fixed grace from first watchdog observation or deployment | Convenient when deployment timing is unknown. | Every redeploy or first observation can move the deadline; local clocks and reruns make the readiness boundary ambiguous. | Rejected. |
| Repository variable | Can be changed without a code deployment. | An out-of-band edit can silently postpone an already-active fail-closed control and is absent from the reviewed workflow bytes. | Rejected. |
| Infer activation from the oldest workflow run or Git history | Avoids a configured timestamp. | GitHub retention, pagination, rewritten history, and API availability make the bootstrap boundary non-deterministic; missing history recreates the original false timestamp. | Rejected. |
| Treat pre-activation as healthy | Keeps the watchdog workflow green. | It misrepresents recovery readiness before any real successful rehearsal. | Rejected; `setup_pending` is explicitly non-ready. |

## Rollout and recovery

This is a workflow, assessor, test, and documentation change only. It requires
no schema migration, secret, provider mutation, or application restart. Canary
one manual dispatch before activation and inspect the sanitized
`setup_pending` artifact. At or after activation, verify that an absent run
alerts `run_missing`, a real scheduled run is selected only if created at or
after activation, and only its exact healthy monitor artifact produces
`healthy`.

Rollback before activation may revert the entire change. After activation, do
not restore the legacy unconstrained clock or move the epoch forward: either
action could allow the control to become non-alerting without current evidence.
Roll forward while retaining the original epoch and all fail-closed states.
