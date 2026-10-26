# Readiness 503 triage

`GET /api/health/ready` returns 503. The descriptive layer is
[SYSTEM_DESIGN.md](../SYSTEM_DESIGN.md) §4.3 (migration ledger and
readiness), §9.3 (readiness) and the §8 failure-mode table.

## Symptoms

- `GET /api/health/live` returns 200 but `GET /api/health/ready`
  returns 503 `{"ok":false,"status":"unavailable"}`.
- Pairing endpoints fail while ordinary reads work: pairing publication
  and pairing runs require closed-membership readiness.

The readiness endpoint deliberately names no blocker: the 503 body is
always the same. Telling the blocker families apart needs the steps
below. Do not hand-edit database rows to clear a blocker — every
readiness blocker is a fail-closed invariant, and the fix is a workflow
run or a code change, never a row edit.

## Confirm (read-only)

```bash
curl -s https://randoricircle.com/api/health/live
# Expect: {"ok":true,"status":"live"} — functions run.

curl -s -o /dev/null -w '%{http_code}\n' https://randoricircle.com/api/health/ready
# Expect 200 when ready, 503 when not.

curl -s https://randoricircle.com/api/auth/capabilities
# A missing capability narrows it: e.g. googleOAuth:false points at the
# Google/key-control area, not at the schema.
```

Then, signed in as an admin, open admin Diagnostics
(`GET /api/admin/diagnostics`) and read the readiness card:

- `ledger.state` — `current`, `pending_additive`, `behind`, `missing`,
  `invalid`, or `ahead`. If it is not `current` or `pending_additive`,
  the blocker is the schema / ledger family.
- `ready: false` with `ledger.state: current` — the blocker is the
  membership or key-control family (the card does not break those two
  apart; use "Tell the families apart" below).

`npm run db:status` and `npm run db:plan` are also read-only
(`SELECT`/`PRAGMA` only; see
[DATABASE_SCHEMA_OPERATIONS.md](../DATABASE_SCHEMA_OPERATIONS.md)).
Never run `npm run db:migrate` against production.

## Tell the families apart

| Family | Evidence | Blocker names / diagnostic signal |
| --- | --- | --- |
| Schema / ledger | Diagnostics ledger is `behind`, `missing`, `invalid`, or `ahead`; or a migration just merged and has not been applied yet | Diagnostics readiness-card `category`: `ledger_behind`, `ledger_missing`, `ledger_invalid`, or `ledger_ahead` |
| Key control | Ledger is `current`, a key-ring or key-control change just happened, and only one purpose lost its capability (e.g. Google sign-in, activation, reset, invitation mail) | Key-control readiness fails for that purpose |
| Membership provenance | Ledger is `current`, no key change happened, and a membership event just happened — a member joined, left, was removed, or was deactivated | `closed_rollout_account_audit_invalid`, `closed_rollout_backfill_audit_invalid`, `closed_rollout_has_no_owner`, `closed_rollout_has_orphan_memberships` |

Two distinctions that prevent misdiagnosis:

- **Uncovered accounts do not take health offline.** The steady-state
  check health uses (`inspectCompletedMembershipRollout`) has no
  uncovered-accounts blocker: a removed or inactive member may keep an
  account and its audit trail. Uncovered accounts block only the
  one-time adoption rule the migration runner uses for unmanaged
  databases (ID-85). A 503 with uncovered accounts is explained by
  something else.
- **Membership provenance has three valid forms.** An account is
  proven by a `membership.backfilled` audit, an `invitation.accepted`
  audit, or — for password sign-up through email activation — an
  `activation.verified` audit tied to a used, unrevoked invitation, its
  consumed activation in the same circle, and the dedupe key
  `activation-verified:<activation id>` (ID-84). Any
  `activation.verified` event whose invitation, activation, account,
  actor, circle, or dedupe key does not line up counts as
  `malformedActivationAudits`, also a
  `closed_rollout_account_audit_invalid` blocker. The activation
  ledger exists only from schema v7; on earlier schemas every
  `activation.verified` event is malformed. This was the 2026-10-22
  incident: the first invitee joined by activation, readiness accepted
  only the first two provenances, and the account counted as
  `invalidAccountProvenance`. See the
  [2026-10-22 postmortem](../postmortems/2026-10-22-readiness-503.md).

## Fix

- **Schema / ledger:** follow
  [schema migration cutover](schema-migration-cutover.md). One version
  per approved rehearsal; readiness returns when the ledger is current
  (or one additive version behind).
- **Key control:** follow [KEY_ROTATION.md](../KEY_ROTATION.md) —
  inspect the purpose's control with `status` in the
  `credential-key-control` workflow and adopt/advance it. A purpose
  stays unavailable until its control is accepted.
- **Membership provenance:** there is no operator fix. A genuinely
  malformed audit, or a join path the evaluator does not recognise, is
  a code fix (as #349 was). File the issue with the blocker family,
  the Diagnostics ledger state, and what changed just before the 503,
  and keep the service fail-closed until the fix deploys.
- **Key-control vs membership, still ambiguous:** check what changed
  last (deploy, key-control run, membership event) and check
  capabilities per purpose. Do not guess by toggling flags: toggling
  `CIRCLE_MEMBERSHIP_ENABLED` off does not reopen registration once
  the cutover latch has closed, and it switches off everything that
  depends on it.

## Rollback

Readiness has no operator rollback. If a deploy introduced the
blocker, follow [rollback a bad deploy](rollback-bad-deploy.md) — but
never roll code back to a version older than the database: code is
never ready on a database newer than itself. Leave the code at its
version with the suspect flag off instead.

## Verify

```bash
curl -s -o /dev/null -w '%{http_code}\n' https://randoricircle.com/api/health/ready
# Expect 200.
```

Then confirm the Diagnostics readiness card is `healthy` (or
`degraded` with `ledger_pending_additive` while an additive migration
awaits its cutover) and that the next scheduled watchdog runs are
green.
