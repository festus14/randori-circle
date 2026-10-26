# Incident postmortem template

Copy this file to `YYYY-MM-DD-<short-slug>.md` and fill in every
section. Write it blamelessly: describe what the system did, not who
did it. All times are UTC. Link the decision-log entry, the fix PR,
and the follow-up issues; do not paste secrets, tokens, recipient
addresses, or row contents.

## Summary

One paragraph: what broke, when, and what fixed it.

## Impact

- **Duration:** start–end UTC, and how the end was confirmed.
- **What members saw:** which flows failed, which kept working.
- **What members did not lose:** data loss, if any (state "none"
  explicitly when there is none).
- **Scope:** one member, all members, one flow, readiness only.

## Timeline

| Time (UTC) | Event |
| --- | --- |
| | First symptom / detection |
| | Diagnosis |
| | Fix merged / deployed |
| | Confirmed recovered |

## Detection

How the incident was noticed (watchdog alert, member report, smoke
check, operator observation), and how long after onset. Note any
signal that should have fired but did not.

## Root cause

The mechanism, in code terms: the invariant, the check, the path
that violated it. Link the file and the evaluator, not a paraphrase
of them.

## Fix

What changed (PR, decision ID), and why that fix rather than the
alternatives. Note whether it was a code fix, a workflow run, a flag
change, or a provider change — and what would have to be reverted if
the fix itself regressed.

## What went well / what went wrong

- Went well:
- Went wrong:

## Follow-ups

| Follow-up | Issue / PR | Owner | Status |
| --- | --- | --- | --- |
| | | | Open / Closed |

A follow-up is Closed only when its change is merged and its
verification is on the record. Do not mark a follow-up Closed on a
merge alone if it needs a production check.

## Prevention

What changes so this class of incident cannot recur, or is caught
faster next time: a test, a check, a runbook, an alert, a design
change. Link each item to its follow-up row.

## Evidence

- Decision log:
- Fix PR:
- Follow-up issues/PRs:
- Runbooks added or changed:
- Verification (readiness, smoke, watchdog runs):
