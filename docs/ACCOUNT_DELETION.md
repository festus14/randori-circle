# Self-service account deletion

Issue #339, decision ID-81. Behind `ACCOUNT_DELETION_ENABLED` (default off) and
only when `CIRCLE_MEMBERSHIP_ENABLED=true`. No migration: every column used
already exists. The visual design is provisional (`needs-design`).

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

Afterwards the browser clears the app's storage and reloads to the landing
page, which shows "Your account was deleted." The dialog reuses the app's
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
| `GET` signed in | `200 {ok:true,eligible:true}` or `200 {ok:true,eligible:false,code,circles?}` with `code` `last_owner`, `last_admin` or `demo_account` |
| `POST {"confirm":"DELETE"}` | `200 {ok:true,status:"deleted"}` and `Set-Cookie: randori_session=; Max-Age=0` |
| any other body (including extra keys such as `user_id`) | `400 {code:"confirmation_required"}` |
| no recent sign-in for this session | `403 {code:"recent_auth_required"}` |
| only owner / last admin / demo | `409 last_owner` (with `circles`) / `409 last_admin` / `403 demo_account` |
| retry with the old signed cookie after success | `200 {ok:true,status:"already_deleted"}` |
| signed out, cross-site POST, too many attempts, schema not ready | `401`, `403`, `429` (shared 10-per-15-minutes identity budget), `503` |

`POST` is same-origin only. Readiness is a read-only probe of every column the
deletion touches; there is no request-path DDL.

## What happens, in one write transaction

The recent-auth proof and the owner/admin rules are checked inside the
transaction before any change, so concurrent requests serialize (a second
request sees `already_deleted` or a busy database) and a co-owner race always
leaves an active owner.

- **Account row tombstoned, not deleted.** Pairings, completion receipts,
  schedules, session controls and code documents reference it through RESTRICT
  keys and immutability triggers, and the membership-readiness invariants
  require every non-demo account to keep its audited provenance. The email
  becomes `deleted-<id>@account-deleted.invalid` (reserved TLD, never routable,
  unique), the password hash a non-bcrypt marker, the name "Deleted member", and
  every profile column is cleared. `is_demo` stays 0 so demo resets never touch
  it.
- Every live session revoked (`logout_all`), recent-auth proofs and per-session
  circle selections deleted, the Google identity link and its email
  observation deleted, password-reset rows deleted.
- Availability decisions and notification preferences deleted.
- Pending, retrying and dead-lettered emails to the member suppressed with an
  `ACCOUNT_DELETED` outbox audit row; their address and token or credential
  envelopes scrubbed from every outbox row addressed to them; legacy pairing
  email rows cancelled.
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
| `auth_identity_audit_events` | `user_id`, `actor_user_id` | Keep | Security audit of codes only, no personal data; the id now resolves to the tombstone. |
| `auth_rate_limits` | `key` | Keep | Secret-keyed hashes that expire within 15 minutes and cannot be linked back to the account. |
| `circle_memberships` | `user_id`, `role`, `status`, `invited_by` | Anonymise | Every membership made inactive and demoted to member. Rows stay so history and invited_by resolve to "Deleted member"; reactivation is refused. |
| `circles` | `created_by` | Keep | Shared circle; created_by is an opaque id that now resolves to the tombstone. |
| `circle_invitations` | `created_by`, `used_by`, `email_hash` | Revoke | Unused invitations they sent are revoked and audited. The invitation they accepted keeps its provenance but its email fingerprint is replaced with a random value. |
| `circle_audit_events` | `actor_user_id`, `subject_user_id` | Keep | Audit trail of ids only. An account.deleted event with no personal data is added per circle. |
| `circle_creation_requests` | `actor_user_id`, `initiating_session_hash` | Keep | Idempotency record for circles they created: hashes and ids only, RESTRICT-bound to the circle. |
| `invite_requests` | `email`, `name`, `note`, `decided_by` | Anonymise | A pending request from their email is expired and scrubbed; decisions they made keep only the opaque decided_by id. |
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
| `outbox_events` | `payload_json` | Anonymise | Pending, retrying and dead-lettered emails to them are suppressed (audited, ACCOUNT_DELETED); their address and token or credential envelopes are scrubbed. |
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
- **Last app admin**: refused, mirroring the `revoke_admin` invariant.
  `ADMIN_EMAILS` remains the operator recovery path.
- **Invitations they sent**: unused ones are revoked rather than left live; used
  ones stay because they are another member's provenance.
- **Mid-cycle deletion**: the current primary pairing keeps the tombstone as
  "Deleted member" so partners' dashboards keep working; any other ex-member in
  a current publication still fails closed as before.

## Limits and follow-ups

- An email a worker is sending at that instant still completes; its row keeps
  its envelope (the address is replaced) so the lease and key-rotation metrics
  stay valid.
- The legacy `users` table (pre-membership, name only) cannot be attributed to
  an account and is left alone.
- AI sessions a partner started keep their transcript (AI is off in production).
- Database backups and Sentry keep their own retention windows.
- Pre-existing, not changed here: a member who leaves or is removed mid-cycle
  still makes the current primary pairing unavailable until the next cycle.

## Rollout

Merging changes nothing. To enable, set `ACCOUNT_DELETION_ENABLED=true` in
Vercel Production (circle membership must already be on) and redeploy; unset it
to hide the endpoint and the UI again. Deletions already made stay made.
