# Self-service account deletion

Issue #339, decision ID-81. Behind `ACCOUNT_DELETION_ENABLED` (default off) and
only when `CIRCLE_MEMBERSHIP_ENABLED=true`. No migration for the original
flow: every column used already exists.

Issue #372, decision ID-93, adds a **14-day cancellable grace period** behind
`ACCOUNT_DELETION_GRACE_ENABLED` (default off) plus additive migration v23
(`account_deletion_requests`). With the grace flag on, requesting deletion
schedules it 14 days out instead of deleting straight away; with the flag
off the original immediate flow runs unchanged.

## What a member sees

**Edit profile** (account menu) gains a **Delete account** card that lists what
is deleted and what stays, anonymised. The flow is:

1. **Confirm it's you.** A password or Google sign-in from the last 10 minutes
   (the existing recent-auth boundary, `api/_recent-auth.js`; Google step-up
   still needs a fresh signed `auth_time`, `GOOGLE_REAUTH_MAX_AGE_SECONDS`).
   A recent sign-in skips this step.
2. **Type DELETE.** Continue stays disabled until the exact word is typed.
3. **Final confirmation.** Cancel has focus; **Delete my account** is the
   destructive button.

With the grace period on, afterwards the browser clears the app's storage and
reloads to the landing page, which shows "Your account is scheduled for
deletion on {date}." A confirmation email (from `hello@randoricircle.com`,
no unsubscribe link — it is an account email) gives the date and how to
cancel. With the grace flag off, the landing page shows "Your account was
deleted." as before. The dialog reuses the app's
dialog focus trap (`openPromiseDialog`), Escape cancels until the deletion
request is in flight, and everything renders through DOM nodes and
`textContent`. `assets/account-deletion.js` is imported only for a signed-in
member while `/api/auth/capabilities` advertises `accountDeletion`.

If the member is the only active owner of a circle (demo accounts don't count)
the card shows which circle and how to fix it: make another member an owner on
the Circle page (`make_owner`), or archive it if it is a secondary circle. The
last active app admin is told to make another member an app admin first.

## API

`/api/auth/account/delete` (rewrite to `/api/auth?endpoint=account-delete`).
The session alone chooses the account; no id is accepted.

| Request | Response |
| --- | --- |
| Flag off, or membership-free mode | `404`, the same body as any unknown auth endpoint; no capability |
| `GET` signed in | `200 {ok:true,eligible:true}` or `200 {ok:true,eligible:false,code,circles?}` with `code` `last_owner`, `last_admin` or `demo_account`; `grace:true` while the grace period is on |
| `GET` with a pending deletion | `200 {ok:true,deletion_pending:true,scheduled_for}` |
| `POST {"confirm":"DELETE"}` (grace off) | `200 {ok:true,status:"deleted"}` and `Set-Cookie: randori_session=; Max-Age=0` |
| `POST {"confirm":"DELETE"}` (grace on) | `200 {ok:true,status:"pending_deletion",scheduled_for}` and `Set-Cookie: randori_session=; Max-Age=0` |
| `POST {"confirm":"DELETE"}` while a deletion is pending | `409 {code:"already_pending",scheduled_for}` |
| any other body (including extra keys such as `user_id`) | `400 {code:"confirmation_required"}` |
| no recent sign-in for this session | `403 {code:"recent_auth_required"}` |
| only owner / last admin / demo | `409 last_owner` (with `circles`) / `409 last_admin` / `403 demo_account` |
| retry with the old signed cookie after success | `200 {ok:true,status:"already_deleted"}` |
| signed out, cross-site POST, too many attempts, schema not ready | `401`, `403`, `429` (shared 10-per-15-minutes identity budget), `503` |

Password sign-in for an account with a pending deletion answers `200`
with `deletion_pending:true` and `scheduled_for` alongside the user, so the
app shows the cancel screen straight away; `/api/auth/me` answers `409
{code:"deletion_pending",scheduled_for}` for the same account.

`/api/auth/account/delete/cancel` (rewrite to
`/api/auth?endpoint=account-delete-cancel`) cancels a pending deletion.
`POST {}` — exactly the empty object — from a session signed in after the
request returns `200 {ok:true,status:"cancelled",scheduled_for}` and the
session keeps working as the restored account. `409 {code:"not_pending"}`
when nothing is scheduled; `401` with no usable session; `403
{code:"recent_auth_required"}` when the sign-in proof is older than 10
minutes (sign in again, then cancel). With the deletion flag off the
endpoint answers like an unknown one, but a pending request still cancels:
the flag gates new requests only.

`POST` is same-origin only. Readiness is a read-only probe of every column the
deletion touches; there is no request-path DDL.

## Grace period (issue #372, ID-93)

While a deletion is pending (`account_deletion_requests`, migration v23:
`user_id`, `requested_at`, `scheduled_for`, `cancelled_at`, `executed_at`;
at most one active request per account):

- **Locked.** Every session is revoked at request time. The account cannot
  use any API: `verifyRequestAuth` refuses it everywhere, so pairing,
  reminders, emails and every other endpoint are closed to it. Signing in
  again (password or Google) issues a session that can only reach the
  cancel flow; the app shows a minimal "Your account is scheduled for
  deletion on {date}. Cancel deletion?" screen and nothing else.
  Password sign-in answers 200 with `deletion_pending: true` and
  `scheduled_for`, so the app shows that screen straight away; a Google
  sign-in lands on the boot refresh, where `/api/auth/me` answers 409
  `deletion_pending`.
- **Leaving.** Partners and owners see the member as "Leaving" in the
  owner roster (`deletion_pending` on the roster entry, rendered as a
  Leaving badge). The member is excluded from future pairing (primary and
  secondary publications) and from reminders and emails, including mail
  queued before the request (handlers suppress it at delivery).
- **Cancelling.** Cancelling sets `cancelled_at`, writes one
  `account.deletion_cancelled` audit event per circle, and restores the
  account exactly as it was: the request changed nothing else, so there is
  nothing to restore. An expired invitation is **not** reopened, and no
  membership is restored — a member an owner removed during the grace
  period cannot cancel and is still deleted on schedule. A deletion
  requested again after cancelling starts a new 14 days.
- **Data export.** A member's deletion requests are included in their
  data export under `deletion_requests` (requested, scheduled, cancelled
  and executed timestamps; ids only, no personal data).
- **Emails**, from `hello@randoricircle.com` (`RESEND_FROM` in production):
  account emails, so no unsubscribe link. A confirmation on request, with
  the date and how to cancel; a reminder about 48 hours before deletion.
  Each is one outbox row with a stable idempotency key, and the delivery
  handler re-checks the pending request, so each is sent once.
- **Deletion.** After 14 days, the outbox cron (every 5 minutes) runs the
  bounded, idempotent grace job (`runAccountDeletionGraceJobs`, at most 10
  executions per run): it re-checks the pending row and the last-owner /
  last-admin rules inside the same transaction as the existing deletion
  (`executeScheduledAccountDeletion`), marks the request executed, and
  tombstones the account exactly as an immediate deletion would.
- **Blocked execution.** If the account is the last owner or last admin
  when the job runs, the account stays locked, one
  `account.deletion_blocked` audit event is written, and each admin gets
  one blocked notification (outbox idempotency keys dedupe repeats). The
  deletion runs on a later check once another owner or admin exists.
- **Flag rollback.** Turning `ACCOUNT_DELETION_GRACE_ENABLED` off stops
  new grace requests (they go back to immediate deletion) but does not
  touch pending ones: they still cancel and execute on schedule. The lock
  and the job are driven by the pending row, not by the flag.

## What happens, in one write transaction

The recent-auth proof and the owner/admin rules are checked inside the
transaction before any change, so concurrent requests serialize (a second
request sees `already_deleted` or a busy database) and a co-owner race always
leaves an active owner. A scheduled (grace-period) deletion runs the same
transaction from the cron job, with the pending row re-read and the
owner/admin rules re-checked inside it; a concurrent cancellation wins.

- **Account row tombstoned, not deleted.** Pairings, completion receipts,
  schedules, session controls and code documents reference it through RESTRICT
  keys and immutability triggers, and the membership-readiness invariants
  require every non-demo account to keep its audited provenance. The email
  becomes `deleted-<id>@account-deleted.invalid` (reserved TLD, never routable,
  unique), the password hash a non-bcrypt marker, the name "Deleted member", and
  every profile column is cleared. `is_demo` stays 0 so demo resets never touch
  it. Its provenance stays exactly as it was, whichever way the member joined:
  the `membership.backfilled` audit, or the used, unrevoked invitation with its
  `invitation.accepted` (Google or local sign-up) or `activation.verified`
  (password activation, ID-84) audit and used activation. Only the email
  fingerprints and the activation's personal columns are scrubbed, so
  `/api/health/ready` and pairing readiness stay green (tested for all three).
- Every live session revoked (`logout_all`), recent-auth proofs and per-session
  circle selections deleted, the Google identity link and its email
  observation deleted, password-reset rows deleted.
- Availability decisions and notification preferences deleted.
- Pending, retrying and dead-lettered emails to the member suppressed with an
  `ACCOUNT_DELETED` outbox audit row; their address and token or credential
  envelopes scrubbed from every outbox row addressed to them, including the
  emails of any invitation to their address that can no longer be used (that
  invitation's fingerprint is randomised too); legacy pairing email rows
  cancelled. A still-usable invitation from another owner, and its email, stay:
  it is how the person can join again.
- Unused invitations they sent revoked, each with the usual
  `invitation.revoked` audit row. A deleted account should not keep vouching
  for a live link; other owners can invite again.
- Every membership made inactive and demoted to member. The owner roster hides
  the tombstone and reactivation is refused.
- Chat text replaced with "Message deleted"; solo runs deleted; pair-run code
  cleared unless it is the attested shared pair document (jointly written, kept
  with the pair workspace until it expires).
- One `account.deleted` circle audit event per circle the member belonged to,
  with only the opaque account id, circle id and time.

All of these are sent as one batch of statements inside the transaction (one
round trip after the checks, about six in total), well inside Turso's
interactive-transaction timeout. `app_logs.user_id` and the outbox JSON fields
have no index; each is scanned once, bounded by its retention. Locally, with
100,000 log rows and 50,000 outbox rows, a deletion takes about 50 ms.

Requests that write to an account by id (sign-in refreshes and Google identity
binding, `ADMIN_EMAILS` grants, `last_login`, profile saves, Google linking,
notification preferences, solo-run inserts) skip a tombstone
(`LIVE_ACCOUNT_SQL`), so a request authenticated just before the deletion
commits cannot write into it afterwards. Race tests replay each one across the
commit.

The same email can then join again as a brand-new account through a new
invitation (password or Google). Signing in with the old password or Google
account reaches nothing.

## Data inventory

| Table | Columns | Action | Why |
| --- | --- | --- | --- |
| `auth_accounts` | `email`, `password_hash`, `display_name`, `color`, `bio`, `tz`, `interview_focus`, `leetcode_handle`, `phone`, `google_sub`, `last_login`, `is_available`, `availability_updated_at`, `is_admin` | Anonymise | Tombstone: partners' history and RESTRICT keys need the id. Email becomes non-routable, name "Deleted member", no password or Google subject. |
| `auth_sessions` | `user_id` | Revoke | Every live session revoked in the same transaction; rows age out through the 30-day session retention. |
| `auth_recent_proofs` | `session_hash`, `user_id` | Delete | Step-up proofs are useless once sessions are revoked. |
| `auth_session_circle_contexts` | `session_hash`, `user_id`, `circle_id` | Delete | Per-session circle selection. |
| `auth_provider_identities` | `subject`, `user_id` | Delete | Google link removed so the Google account can sign up again as a new member. |
| `auth_provider_email_state` | `subject`, `email_hash` | Delete | Keyed hash of the Google email for the removed link. |
| `auth_password_resets` | `user_id`, `email_hash`, `token_hash` | Delete | Pending or used reset tokens. |
| `auth_email_activations` | `email`, `email_hash`, `password_hash`, `display_name`, `color` | Anonymise | The activation that created the account still held the email, name and password hash. Scrubbed (pending ones revoked); the row stays for its RESTRICT invitation key. |
| `account_deletion_requests` | `user_id`, `requested_at`, `scheduled_for`, `cancelled_at`, `executed_at` | Keep | Grace-period request history: opaque ids and timestamps only. The executed row is the audit trail of a deletion; cancelled rows prove a request was withdrawn. |
| `auth_identity_audit_events` | `user_id`, `actor_user_id` | Keep | Security audit of codes only, no personal data; the id now resolves to the tombstone. |
| `auth_rate_limits` | `key` | Keep | Secret-keyed hashes that expire within 15 minutes and cannot be linked back to the account. |
| `circle_memberships` | `user_id`, `role`, `status`, `invited_by` | Anonymise | Every membership made inactive and demoted to member. Rows stay so history and invited_by resolve to "Deleted member"; reactivation is refused. |
| `circles` | `created_by` | Keep | Shared circle; created_by is an opaque id that now resolves to the tombstone. |
| `circle_invitations` | `created_by`, `used_by`, `email_hash` | Revoke | Unused invitations they sent are revoked and audited. The accepted one keeps its provenance; it and other unusable invitations to their address get a random fingerprint. |
| `circle_audit_events` | `actor_user_id`, `subject_user_id` | Keep | Audit trail of ids only. An account.deleted event with no personal data is added per circle. |
| `circle_creation_requests` | `actor_user_id`, `initiating_session_hash` | Keep | Idempotency record for circles they created: hashes and ids only, RESTRICT-bound to the circle. |
| `invite_requests` | `email`, `name`, `note`, `decided_by` | Anonymise | A pending request from their email is expired and scrubbed; decisions they made keep only the opaque decided_by id. |
| `feedback_items` | `circle_id`, `author_user_id`, `kind`, `title`, `body`, `status`, `visibility`, `diagnostics_json`, `idempotency_key`, `created_at`, `updated_at`, `closed_at` | Delete | Their own feedback submissions are deleted; votes and creation events on them go with the item. |
| `feedback_votes` | `feedback_id`, `user_id`, `value` | Delete | Votes they cast are deleted; votes on their deleted items go with the items. |
| `feedback_events` | `feedback_id`, `event_type`, `actor_user_id`, `detail_json` | Anonymise | Events on their items are deleted with the items; events they acted in keep the event with the actor cleared. |
| `pairing_cycle_availability` | `user_id` | Delete | Availability decisions. Publications keep their own immutable snapshot. |
| `user_notification_prefs` | `user_id`, `phone`, `email` | Delete | Email and reminder preferences. |
| `pairing_participants` | `user_id` | Keep | Immutable pairing snapshot that partners' completed sessions depend on (trigger-guarded). |
| `pairing_groups` | `user_a_id`, `user_b_id`, `user_c_id` | Keep | Partners' pairing history; shown as "Deleted member". |
| `pairing_week_runs` | `participants_json` | Keep | Holds only ids, sources and availability versions. |
| `circle_pairing_eligibility` | `user_id` | Keep | Immutable publication snapshot (RESTRICT). |
| `circle_pairing_groups` | `user_a_id`, `user_b_id` | Keep | Partners' secondary-circle pairing history. |
| `circle_pair_schedules` | `user_a_id`, `user_b_id` | Keep | Partners' agreed secondary-circle schedules. |
| `circle_pair_schedule_proposals` | `proposed_by` | Keep | Partners' schedule history; proposer is an opaque id. |
| `pair_schedules` | `proposed_times` | Keep | Agreed and proposed times stay in the partner's recap; proposer ids are opaque. |
| `session_completion_receipts` | `user_id` | Keep | Immutable; the partner's completed-session count needs both receipts. |
| `pair_session_controls` | `candidate_user_id`, `updated_by` | Keep | Interview roles stay in the partner's progress. |
| `pair_messages` | `sender_id`, `message` | Anonymise | Text of every message they sent becomes "Message deleted"; the row keeps the partner's conversation in order. |
| `session_runs` | `user_id`, `code`, `test_cases_snapshot`, `results_json` | Anonymise | Solo runs are deleted. Pair runs keep their verified summary for the partner; code is cleared unless it is the attested shared pair document. |
| `pair_code_documents` | `last_actor_id`, `y_state_base64` | Keep | Jointly written pair document; stays with the partner and expires after 90 days. |
| `pair_room_snapshots` | `updated_by`, `code` | Keep | Jointly written pair workspace; stays with the partner and expires after 90 days. |
| `pair_meeting_links` | `updated_by`, `meeting_url` | Delete | A link they added may be their personal meeting room. |
| `video_signals` | `from_id`, `to_id`, `payload` | Keep | Signalling keyed by random peer ids, not the account; purged after about an hour. |
| `ai_sessions` | `created_by`, `transcript`, `code_snapshots`, `interviewer_questions` | Delete | AI sessions they started (AI is off in production). |
| `ai_feedback` | `session_id`, `feedback_json`, `evidence` | Delete | Feedback on the AI sessions they started. |
| `ai_consents` | `user_id` | Delete | AI consent record. |
| `ai_account_monthly_usage` | `user_id` | Delete | Per-member AI quota counters. |
| `ai_account_monthly_reservations` | `user_id` | Delete | Per-member AI quota reservations. |
| `custom_questions` | `author_id` | Anonymise | Shared question text stays; the author link is cleared. |
| `app_logs` | `user_id`, `ip`, `ua`, `route`, `message`, `meta_json` | Delete | Client and server log rows linked to the account. |
| `outbox_events` | `payload_json` | Anonymise | Mail to them is suppressed (audited, ACCOUNT_DELETED); address and envelopes are scrubbed, including emails of unusable invitations to their address. Queued feedback notifications about their submissions are suppressed and lose their title. |
| `outbox_audit_events` | `actor_ref` | Keep | Delivery audit; operator references are opaque ids. |
| `pairing_email_outbox` | `user_id`, `recipient_email` | Anonymise | Legacy queue rows to them are cancelled and the address replaced. |
| `users` | `name` | Keep | Legacy pre-membership roster keyed by name only; it cannot be attributed to the account without risking another member's row. |

Tables with no personal data: `ai_usage`, `chat_retention_audit_events`, `chat_retention_control`, `chat_retention_legal_holds`, `chat_retention_runs`, `chat_retention_scopes`, `circle_membership_rollout`, `circle_pairing_publications`, `credential_key_controls`, `pairing_cycles`, `pairing_weeks`, `questions`.

`tests/unit/account-deletion.test.mjs` fails if a table is added to the schema
manifest without being placed in one of these lists, and asserts every listed
column on a migrated database.

### Browser and services

| Store | Action | Why |
| --- | --- | --- |
| cookie randori_session | Delete | Cleared with Max-Age=0 by the deletion response. |
| localStorage randori-* | Delete | Profile copy, unsent code and whiteboard drafts, last room, reminder contact and device flags; only randori-theme and randori-landing-dismissed stay. |
| sessionStorage randori-* | Delete | Pending recent-auth continuations and invitation bindings. |
| Sentry | Keep | No account data is sent: the server scrubber drops user ids, emails and IPs, and the browser SDK runs with sendDefaultPii=false and no setUser. |

## Decisions

- **Demo accounts** cannot sign in (no password hash), so they never reach the
  endpoint; the server refuses them anyway (`demo_account`). Demo tooling
  creates and resets them.
- **ADMIN_EMAILS accounts** may delete themselves like anyone else, subject to
  the last-admin rule (they count as admins even before their flag syncs). The
  tombstone's email no longer matches `ADMIN_EMAILS`, so it never regains
  admin; signing up again with the listed email creates a new account that gets
  admin as usual.
- **Last app admin**: refused, mirroring the `revoke_admin` invariant. An admin
  is an active, non-demo account with `is_admin=1` or listed in `ADMIN_EMAILS`;
  both count as the remaining admin. `ADMIN_EMAILS` remains the operator
  recovery path.
- **Invitations they sent**: unused ones are revoked rather than left live; used
  ones stay because they are another member's provenance.
- **Mid-cycle deletion**: the current primary and secondary pairings keep the
  tombstone as "Deleted member" so partners' dashboards keep working; any other
  ex-member in a current publication is handled as before (primary fails
  closed, secondary hides the pair).
- **Google step-up return**: the dialog's sessionStorage marker counts only if
  it is under ten minutes old and belongs to the member signed in after the
  return; otherwise it is dropped and the normal Account security flow runs.
- **Unconfirmed result**: if the deletion request fails or its answer is lost,
  the dialog says it couldn't confirm and asks the member to refresh, because
  the server may have finished.

## Backups and restores (issue #366, ID-89)

**Retention.** Deleted personal data can stay in the provider's
point-in-time backups until the plan's backup window expires: up to **1 day**
after deletion on the current plan (Turso's Free tier — verified against
[turso.tech/pricing](https://turso.tech/pricing) on 2026-10-25, where the
plans are Free 1 day, Developer 10 days, Scaler 30 days, Pro and Enterprise
90 days; "Starter" is not a current Turso plan name, and the earlier note
calling the 1-day window "Starter" was corrected). If the organisation ever
moves to a paid tier, the window becomes that tier's — update
`privacy.html` before relying on the longer window. The GitHub rehearsal,
monitor, watchdog and migration artifacts are retained 30 days (migration
result: 90 days) but hold only counts, checksums and digests, never personal
data, so they do not extend personal-data retention. Disposable restore
databases have zero retention: they are deleted in the same run. Sentry
keeps its own retention window and receives no account data by design.

**Restores.** A point-in-time restore to T brings back the database as of T,
including personal data deleted after T. Before any cutover, the operator
re-applies every deletion newer than the restore point, using the deletion
ledger: one entry per tombstoned account — the opaque account id, the
deletion time (the earliest `account.deleted` audit event, or null when no
audit row exists), and the account's creation time. The ledger is built
from the still-live source database (PITR never deletes the source) and
kept only in an operator-held file outside any database: a ledger table
inside the database would roll back with the restore it is meant to repair.
The full step-by-step procedure, including the executable CLI
(`scripts/deletion-ledger.mjs`: `export`, `reapply`, `verify`) and the
verification gate that blocks the cutover, is in
[`docs/TURSO_BACKUP_RESTORE_REHEARSAL.md`](TURSO_BACKUP_RESTORE_REHEARSAL.md)
("Re-applying account deletions after a restore"). The same code also
re-runs the deletion's scrubbing statements with the original deletion
time kept as the audit instant, and skips the recent-auth and
last-owner/last-admin gates for the reasons documented in
`api/_account-deletion.js` (the original deletion already passed them; the
restored database holds stale state).

**Residual risk.** If the source database itself is destroyed, the ledger
cannot be built from it — there is no durable off-database ledger yet.
That follow-up is #383. Owner confirmation of the production Turso plan
tier is #384.

## Limits and follow-ups

- An email a worker is sending at that instant still completes; its row keeps
  its envelope (the address is replaced) so the lease and key-rotation metrics
  stay valid.
- The legacy `users` table (pre-membership, name only) cannot be attributed to
  an account and is left alone.
- AI sessions a partner started keep their transcript (AI is off in production).
- A log line written by a request that was already running when the deletion
  committed can still carry the opaque account id (no name or email).
- Follow-up: a member an owner removed (or who left every circle) can no longer
  sign in, so cannot delete their own account; they still need to ask an owner.
- Pre-existing, not changed here: a member who leaves or is removed mid-cycle
  still makes the current primary pairing unavailable until the next cycle.

## Rollout

Merging changes nothing. To enable, set `ACCOUNT_DELETION_ENABLED=true` in
Vercel Production (circle membership must already be on) and redeploy; unset it
to hide the endpoint and the UI again. Deletions already made stay made.

### Grace period rollout (issue #372)

Migration v23 is additive (a new table and two indexes on it), so it follows
the #371 zero-downtime release order in
[`docs/TURSO_PRODUCTION_MIGRATION.md`](TURSO_PRODUCTION_MIGRATION.md):

1. **Merge.** The app stays healthy on v22: readiness tolerates one
   additive migration behind, and all grace code paths check that v23 is
   applied before touching the new table, so deletion requests stay
   immediate.
2. **Rehearsal → status → apply v23** (the protected cutover; owner-run,
   never the agent, never auto-merged).
3. **Turn `ACCOUNT_DELETION_GRACE_ENABLED=true` on** in Vercel Production
   and redeploy. New deletion requests then schedule 14 days out.

Rollback: set the flag to `false` first — new requests go back to
immediate deletion, and pending requests still cancel and execute on
schedule. PITR only if needed, per the runbook.
