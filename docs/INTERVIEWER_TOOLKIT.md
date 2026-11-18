# Private interviewer toolkit

Issue #465, epic #460; decision ID-102. Default **OFF**.

## Using it

With `INTERVIEWER_TOOLKIT_ENABLED=true`, `INTERVIEW_SESSION_ENABLED=true` and
migration **27** applied, the interviewer sees **Private interviewer toolkit**
in the room's **Session** panel. Score four rubric dimensions (problem solving,
communication, code quality, testing), write private notes and record a decision:
Undecided, Strong hire, Hire, No hire or Strong no hire. Scores are optional
integers 1–4: needs support, developing, solid, strong. Press **Save private
evaluation**; this is deliberately not autosave. Notes are limited to 4000
Unicode characters / 16000 UTF-8 bytes and contain no NUL character.

The same action works during lobby/live and after end, expiry or unanimous
completion. Timer controls stay terminal; evaluation never claims attendance.
In **History**, an eligible past interviewer or retained evaluation owner sees
**Private toolkit**, including for an interview they have not yet scored. The
panel shows the evaluator's private 90-day decision counts.
`GET /api/progress` also adds `interviews` (counts and rubric averages, no notes)
only to the evaluator's own response when they have retained evaluations.

**Report / playback:** select a timeline event, or use Previous/Next event to
inspect code snapshots. Download the saved report as browser-generated JSON.
Saving refreshes the report; unsent changes disable download. A stale revision
returns 409 without overwriting either saved or unsent writing. Reload is an
explicit discard action. Nothing is copied into browser local/session storage.
Closing, account refresh, room/scope changes and sign-out remove the private DOM,
abort outstanding reads and revoke the download object URL.

## Data model and API

Additive migration **v27**, `private-interviewer-evaluations`, introduces only:

- `interview_evaluations`, keyed by `(week_id,pair_group_id,evaluator_user_id)`;
- nullable integer rubric columns, bounded notes, decision enum, monotonic
  revision, integer UTC creation/update times and immutable `expires_at`;
- owner/newest and expiry indexes; insert and immutable-owner/revision guards
  on the **new table only**. No trigger changes existing tables.

The candidate and evaluator IDs bind the original two-human, auth-source pair.
The group FK cascades on group deletion. Evaluator deletion also cascades on
hard deletion; ordinary account deletion explicitly removes evaluator writing
in the same tombstone transaction, including scheduled deletion and restore
reapplication. The candidate FK is restrictive because accounts are tombstoned:
Demo reset separately removes evaluations targeting demo candidates before
hard-deleting those accounts, including demo candidates in non-demo weeks.
Ordinary candidate deletion retains the evaluator's writing until its original deadline,
and the report resolves the name to **Deleted member**. Notes may themselves
mention the candidate; they are not automatically rewritten or anonymised.

`GET /api/interviewer-toolkit?room_id=week_N_pair_N` returns a private report.
`GET /api/interviewer-toolkit` returns only the authenticated evaluator's bounded
newest 260 retained evaluations and insights, explicitly marking truncation.
`POST /api/interviewer-toolkit` strictly accepts only `room_id`, integer
`revision` (0 for create), a complete `rubric` object, `notes` and `decision`.
A serialized transaction repeats exact-pair/actor/source authorization in SQL.
All responses are private/no-store; there is no actor-selection parameter.

## Authorization and privacy

Creation requires the **current interviewer** from server session controls,
including the slot-A candidate default. The INSERT rechecks that role at write
time; client role labels, forged author IDs, a no-op and a stale version cannot
supply authority. Candidates and outsiders get the identical `404 pair not
found`, including report reads and writes; secondary, mixed-source, triad, solo
and AI rooms are not supported. Selected-circle control-plane gates require
primary selection; normal active membership/session enforcement is retained.

**Role handoff:** writing is owned by the account that created it, not by the
role. A former interviewer can still read/edit **their own** evaluation after
becoming candidate. The new interviewer starts a separate, empty evaluation
and cannot read the former interviewer's writing. This ownership exception
never lets a candidate read anyone else's evaluation. A former evaluator now
in the candidate lobby gets their own writing but **no prepared code/run events**;
report ownership cannot bypass ID-99's current-role workspace read gate. A changed pairing
snapshot grants no new report access; its evaluator may still export their
own retained writing.

No notes/scores/decision are added to shared recaps, runs, chat, candidate
History/progress, circle health, presence, relay or AI. Even administrators
have no toolkit endpoint shortcut. The app's operators may access its database
for operations, as disclosed in the privacy policy. There is no content logging.
Feature errors are caught before generic request exception logging.

The evaluator's **Download my data** includes their own retained writing, with
the candidate shown by display name (never candidate email or account ID).
The candidate's export includes none of another evaluator's writing. This
lifecycle export works even after the toolkit feature is switched off.

## Recorded evidence, not a keystroke recording

The private report includes question slug/version/language, phase facts derived
from group creation, admission/schedule/timer and end/completion, the latest
retained workspace checkpoint and its code, verified run summaries with runner
display names, and the
saved evaluation timestamp/scores/notes/decision. Runs are scanned newest-first
up to 500 with an explicit overflow marker, then displayed chronologically.
Only signed **v3 acknowledged shared-code** runs contribute historical code;
v2 code is never projected. Run inputs/results payloads, private custom stdin,
whiteboards, chat, AI transcripts and other evaluations are excluded.

Only already-readable shared evidence is used. There is no second event ledger,
no continuous code recording and no synthetic phase transition history. A
checkpoint superseded before a run is not recoverable; paused timer anchors or
missing historical state may leave gaps. Phase entries name their source and
the report states these limitations. Code and run events must fall within the
existing 90-day report window. Exports are private copies controlled by the
interviewer and do not automatically expire on the server's deadline.

## Retention runbook

Each evaluation has a fixed deadline **90 days after its first database save**.
An edit never refreshes it. Database time controls both visibility and purge:
`expires_at < database_now` is expired; exact-cutoff rows remain visible.
Expired writing is excluded from reports, History entry markers, progress,
insights and data exports regardless of the purge switch. New evaluations are
refused for rooms created more than 90 days ago, so deleting an expired row
cannot resurrect evaluation data for an old interview. Group deletion may
remove it sooner. Invalid stored timestamps are prevented by schema CHECKs.

Physical purge is **disabled by default**. `purgeExpiredEvaluations` requires
both explicit `enabled:true` and `INTERVIEW_EVALUATION_PURGE_ENABLED=true`,
and deletes at most 100 expired rows in one atomic statement ordered by expiry.
There is no request-path purge, scheduler, cron or provider call. Missing v27 is
a no-op for lifecycle operations; malformed schema or DB failures fail closed.

Rehearse only against an **existing isolated local file**:

```sh
node scripts/interview-evaluation-retention.mjs --database file:///absolute/path/rehearsal.sqlite
# After reviewing the dry-run count and securing an appropriate private backup:
INTERVIEW_EVALUATION_PURGE_ENABLED=true node scripts/interview-evaluation-retention.mjs \
  --database file:///absolute/path/rehearsal.sqlite --purge \
  --confirm DELETE_EXPIRED_INTERVIEW_EVALUATIONS
```

The CLI refuses remote targets, links, absent files and unconfirmed purges,
never reads provider credentials and emits only counts/mode/fixed errors.
Repeat explicitly for more than 100 eligible rows. An already-open batch may
finish after the deployment switch changes; no later call is authorized.
Do not enable production physical purging until the owner approves its private
backup/restore rehearsal, export opportunity, cadence and protected execution.
A production scheduler/provider adapter is deliberately not activated here.
While disabled, expired rows can remain physically present (but unreadable)
until an operator purges them. Backups have their separate provider lifetime.
Before serving a restore, reapply evaluator account deletions and reconcile
expiry; never move deadlines forward. No down-migration or ledger editing.

## Rollout / rollback

1. **Deployment precondition: production must already be at migration v26,
   applied and verified, before this code deploys.** This branch is NOT ready
   on v25 (`state:"behind"`): the additive tolerance is one version only,
   unlike the older v26 code on main.
   Merge with both toolkit and purge flags OFF. **Merging does not apply v27;
   production migration needs the owner's approval.** No production/provider
   operation is part of this branch.
2. On a real migration-runner v26 database, new code remains READY and ledger
   readiness says `pending_additive`. Ordinary routes retain their pre-toolkit
   behaviour; there is no advertised capability and toolkit requests are 404.
3. Rehearse the additive v27 plan locally, including ledger/checksum and
   unchanged-old-table checks, then follow the protected production migration
   process in [database operations](DATABASE_SCHEMA_OPERATIONS.md).
4. After owner-approved apply, canary an exact two-user primary room with
   `INTERVIEW_SESSION_ENABLED=true`, then enable `INTERVIEWER_TOOLKIT_ENABLED`.
   Allow the pending capability cache up to 30 seconds (or restart locally).
   Confirm candidate/outsider 404, empty candidate export/progress and private
   History/report/download. Verify handoff and explicit CAS conflict handling.
5. Roll back by disabling the toolkit flag and redeploying. Leave schema and
   ledger intact; account deletion/export and explicit retention remain active
   independently. Do not toggle interview role semantics during a live room.

The toolkit module loads only on the first button press, using a dynamic import.
It reuses existing dialog/form/theme CSS; no new initial stylesheet, dependency,
threshold change or optional-page-loader dependency is introduced.
