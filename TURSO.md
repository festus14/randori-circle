# Turso — current database and rollout runbook

**The current application uses handwritten SQLite/libSQL statements through `@libsql/client`. Turso keeps that model deployable from Vercel. The new membership schema uses the reviewed admin rollout below; issue #8 tracks removal of older request-path DDL elsewhere in the application. A checksummed schema manifest and read-only drift inspector freeze that debt. Local migration and a protected PITR rehearsal exist, while production mutation remains disabled until their operational gates have been exercised.**

- **Low migration cost for the current app**: tables such as `users`, `pairing_weeks`, `pairing_groups`, and `questions` already use SQLite syntax. Turso speaks the libSQL protocol, so the existing `@libsql/client` access layer connects with one URL. PostgreSQL would require a substantive schema, query, and operations migration.

- **Free tier that actually fits**: Turso free = 500 DBs, 9GB total, 500M rows read/month, 25M rows written. For a circle of friends doing weekly pairings, that's absurdly generous. Supabase free is also generous but gives you 2 projects cap, 500MB, and shared pooler limits. Neon free sleeps.

- **Vercel-native edge latency**: Turso runs on same edge network as Vercel. `TURSO_DATABASE_URL=libsql://...` from Singapore/London still <50ms. Postgres via Neon/Supabase from edge needs pooling, can cold-start slower.

- **No pooling, no `DATABASE_URL` drama**: Postgres serverless needs PgBouncer / connection strings. libSQL is HTTP-based — works from Vercel serverless functions AND edge functions with one auth token. No lingering connections.

- **Serverless-compatible**: the libSQL HTTP client works in Vercel functions without exposing database credentials to browser code.

### What about others?

- **Supabase / Postgres (incl. Vercel Postgres, Neon)**: Great if you need richer relational features, Row Level Security, or integrated auth. Migration cost includes translating handwritten SQLite DDL and queries, choosing a migration tool, and configuring serverless connection management.

- **PlanetScale (MySQL/vitess)**: Excellent branching, but MySQL dialect. Your app is SQLite-native, would need MySQL types, different autoincrement handling. Free tier row-read limits tighter now.

- **Firebase / Firestore**: Realtime is nice for live coding presence, but you'd remodel everything to collections/documents, lose SQL joins for pair history. Better as a complement for live sync, not primary relational store.

- **MongoDB Atlas**: NoSQL — the relational pair-week/group model would need to be redesigned as documents.

**Bottom line:** Turso preserves the current SQLite model and works well for the present serverless workload. A later PostgreSQL move remains possible, but it is an explicit migration project rather than a dialect search-and-replace.

### Using Turso in this repo

1. Create DB: `turso db create randori-circle --location lhr` (London, since you're Royal Wharf)
2. `turso db show randori-circle --url`
   `turso db tokens create randori-circle --expiration 30d`
   Rotate the application token before it expires. Use a non-expiring token only as a documented exception with an owner and rotation plan.
3. In Vercel Dashboard → your project → Settings → Environment Variables:
   ```
   TURSO_DATABASE_URL=libsql://randori-circle-xxxx.turso.io
   TURSO_AUTH_TOKEN=eyJ...
   JWT_SECRET=some-random-64-char-string  # openssl rand -base64 48
   CRON_SECRET=a-different-random-string
   ADMIN_EMAILS=owner@example.com
   CIRCLE_MEMBERSHIP_ENABLED=false
   MULTI_CIRCLE_CONTROL_PLANE_ENABLED=false
   MULTI_CIRCLE_AVAILABILITY_ENABLED=false
   SECONDARY_CIRCLE_COORDINATION_ENABLED=false
   SECONDARY_CIRCLE_SCHEDULING_ENABLED=false
   SECONDARY_CIRCLE_SCHEDULE_EMAIL_ENABLED=false
   SECONDARY_CIRCLE_PAIRING_EMAIL_ENABLED=false
   EMAIL_PASSWORD_ACTIVATION_ENABLED=false
   EMAIL_VERIFICATION_ENCRYPTION_KEY=... # openssl rand -base64 32 | tr '+/' '-_' | tr -d '='
   PASSWORD_RESET_ENABLED=false
   PASSWORD_RESET_ENCRYPTION_KEY=... # generate independently with the same command
   RESEND_API_KEY=re_xxx  # omit both Resend values to keep email disabled
   RESEND_FROM=Randori <noreply@your-verified-domain.com>
   APP_URL=https://randori-circle-self.vercel.app
   GOOGLE_CLIENT_ID=...
   GOOGLE_CLIENT_SECRET=...
   ```
4. Complete and verify the production backup/restore work tracked by issue #38 and the migration controls tracked by issue #43 before changing production data.
   Run `npm run --silent db:status` and `npm run --silent db:plan` against the restored copy and retain their JSON reports. These commands use only `SELECT`/`PRAGMA`; `db:plan` is descriptive and cannot apply changes. See [the schema inspection runbook](docs/DATABASE_SCHEMA_OPERATIONS.md).
   The fingerprint-gated `db:migrate status`, `apply`, and `adopt` commands accept only an explicit local `file:` URL. The protected, manual Turso PITR workflow creates a disposable remote restore, verifies authenticated source/restore evidence, adopts and advances only that restore, checks preservation, then performs identity-guarded cleanup through Turso's name-addressed delete API. A successful run publishes a short-lived, domain-separated HMAC attestation only after the separate cleanup step also succeeds. Configure and run it with [the backup/restore rehearsal runbook](docs/TURSO_BACKUP_RESTORE_REHEARSAL.md). Remote production migration remains blocked until a real rehearsal succeeds and its attestation is retained with the authoritative GitHub Actions run conclusion.
   First apply the v15 prerequisite sequence in v13, v14, then v15 order
   as a separately approved, immediately-next-version production step, with a
   fresh protected rehearsal and status before every apply. Migration v15 seeds four uninitialized
   credential controls. Inspect and adopt all four configured purposes before
   continuing to v16 or enabling a credential consumer. The
   `CREDENTIAL_KEY_CONTROL_MUTATIONS_ENABLED` workflow variable is not a
   consumer kill switch: keep `EMAIL_PASSWORD_ACTIVATION_ENABLED`,
   `PASSWORD_RESET_ENABLED`, `INVITATION_EMAIL_DELIVERY_ENABLED`, and
   `IDENTITY_MANAGEMENT_ENABLED` false during the transition. If an existing
   consumer cannot be disabled, hold production promotion until migration and
   adoption finish. After all four controls are accepted, run a new protected
   restore rehearsal and status inspection for target v16, approve and apply
   only v16, and verify 52 application tables, 56 named indexes, and empty
   secondary schedule tables.
5. Deploy the v16-aware runtime with `SECONDARY_CIRCLE_SCHEDULING_ENABLED=false` and `CIRCLE_MEMBERSHIP_ENABLED=false`. Authentication readiness and rollout-state checks are read-only; any legacy registration that races initialization is atomically included or rejected. Canary scheduling separately with `docs/SECONDARY_SCHEDULING.md` only after the prerequisite feature chain is healthy.
6. Create the first account only after the protected migration workflow reports the current schema ready. There is no request-time authentication bootstrap or repair flag.
7. Sign in with the bootstrap account and verify `GET /api/auth/me` reports `is_admin: true`.
8. Call the authenticated admin-only `POST https://your-app.vercel.app/api/init`. The endpoint requires the exact current migration state, atomically creates the primary-circle data and audited non-demo account memberships, and closes new uninvited registration. It never creates or repairs schema.
9. Verify the rollout queries below before setting `CIRCLE_MEMBERSHIP_ENABLED=true` and redeploying.

### Personalization + Scaling layer (primary circle + immutable weekly publication)

**Membership data:** `circles`, `circle_memberships`, hashed `circle_invitations`, `circle_audit_events`, and the singleton `circle_membership_rollout` latch.

Provider-identity, membership, and all other schema changes use the protected migration workflow. The explicit authenticated `POST /api/init` step changes only primary-circle, membership, audit, and rollout data after exact readiness succeeds. Authentication and initialization have no request-time schema bootstrap or repair path.

**Scaling rule:**
- Circle = active `circle_memberships` in the one operational primary circle. The one-time migration backfills existing non-demo authenticated accounts; legacy `users` rows are never inferred as members.
- Manual publication = **primary-circle owner only** in production. The isolated loopback/local-file development runtime permits its database admin. `POST /api/pairing/run` is idempotent: once the current London cycle is published, later calls return that publication without changing pairs.
- Availability — each user edits the explicitly dated upcoming cycle through `/api/settings/availability`. The API returns the UTC start/end/cutoff, configured IANA timezone, cycle digest, and optimistic version. Publication reads only that exact current-cycle scope; unavailable users are skipped and can receive a reminder. The timeless account flag is frozen as a bounded rollout bridge and is never updated by the dated endpoint.
- Secondary coordination — after the complete managed ledger through v16 is ready, the default-off `SECONDARY_CIRCLE_COORDINATION_ENABLED` flag lets a selected secondary owner publish a circle-owned current-cycle result and lets active members view it. Migration v13 owns the coordination tables, migration v14 owns circle creation, migration v15 adds credential-key controls, and migration v16 owns normalized secondary schedules. The separately default-off `SECONDARY_CIRCLE_SCHEDULING_ENABLED` flag lets a current two-person secondary group agree a time without a room/workspace capability. `SECONDARY_CIRCLE_PAIRING_EMAIL_ENABLED` independently queues dashboard-only pairing-result mail. `SECONDARY_CIRCLE_SCHEDULE_EMAIL_ENABLED` independently queues schedule-email v2 only through the complete scheduling chain. Keep both delivery flags off until their provider canaries succeed. See [the selected-circle pairing runbook](docs/SELECTED_CIRCLE_PAIRING.md), [the scheduling runbook](docs/SECONDARY_SCHEDULING.md), and [the schedule-notification runbook](docs/SECONDARY_SCHEDULE_NOTIFICATIONS.md).
- Circle creation — migration v14 owns the creation receipt, but this release exposes same-origin `POST /api/circles` only after the complete managed ledger through v16 is ready and all four credential controls are adopted under the central rollout. Creation writes only a secondary circle, owner membership, one creation audit, one durable idempotency receipt, and the initiating session's selected context. See [the circle creation runbook](docs/CIRCLE_CREATION.md).

**Env vars added beyond section above:**
- `JWT_SECRET` — at least 32 random bytes, used for 12-hour HS256 session cookies and domain-separated invitation, activation, and password-reset token hashes. Rotating it signs out all sessions and invalidates every outstanding invitation, activation, and password-reset link; revoke/reissue invitations and activations, and require affected users to request new reset links.
- `CRON_SECRET` — separate secret protecting `/api/cron/weekly` and `/api/cron/outbox`. Send it as the `x-cron-secret` header or use a trusted scheduler's Bearer authorization.
- `RESEND_API_KEY` and `RESEND_FROM` (optional as a pair) — when both are set, weekly cron emails **available** participants after shuffle and sends a separate reminder to unavailable participants. If either is absent, delivery remains disabled and pairs are visible in-app via `/api/weeks`. The sender must be verified in Resend.
- `EMAIL_PASSWORD_ACTIVATION_ENABLED` — set to `true` only after managed migration v7 is ready, membership enforcement is enabled, the canonical application URL is valid, and email delivery is configured. Partial or unsafe production configuration fails closed.
- `EMAIL_VERIFICATION_ENCRYPTION_KEY` — a separate 32-byte base64url key used only to encrypt verification credentials while they wait in the provider-neutral outbox. Generate it independently of `JWT_SECRET` and keep it stable while activation events are pending.
- `PASSWORD_RESET_ENABLED` — set to `true` only after managed migration v8, canonical `APP_URL`, and email delivery are ready. Local development captures recovery delivery without a provider request.
- `PASSWORD_RESET_ENCRYPTION_KEY` — an independent 32-byte base64url key for reset credentials in queued events. Keep it stable until all pending reset events have reached a terminal state.
- `APP_URL` — required canonical production HTTPS origin, used for Google OAuth redirect URI and pairing email links. Credentials, paths, query strings, fragments, insecure public origins, request-host mismatches, and implicit fallback origins fail closed. The isolated local runtime accepts only its exact loopback HTTP origin.
- `GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET` — for Google SSO (`/api/auth/google/*`). Configure in Google Cloud Console → OAuth client → Web → origins + redirect: `https://randori-circle-self.vercel.app/api/auth/google/callback` plus localhost variants.

**Endpoints:**
- `POST /api/auth/signup` — synchronous invite signup remains local-only. In production, complete configuration returns a generic accepted response and atomically stores a pending invite-bound activation plus its outbox event; no account or session is created yet.
- `POST /api/auth/activation/resend` — same-origin, enumeration-resistant token rotation with durable rate limits, a cooldown, and a bounded send lifetime.
- `POST /api/auth/activation/verify` — same-origin single-use verification. Invitation consumption, account and membership creation, audit evidence, activation consumption, and revocable session issuance commit atomically.
- `POST /api/auth/password-reset/request` — same-origin generic response for known and unknown addresses with durable IP/email limits, cooldown, and resend rotation.
- `POST /api/auth/password-reset/consume` — validates a single-use fragment token and commits the new password, token consumption, and account-wide session revocation atomically.
- `GET|POST /api/auth/recent-auth` — reads the current session's ten-minute step-up state or confirms the current password. `GET /api/auth/google/reauth/start` forces a fresh same-account Google OIDC proof.
- `POST /api/auth/login` — existing password users only; establishes an HttpOnly session cookie.
- `GET /api/auth/me` — authenticated live-session profile and admin status; its legacy availability field is compatibility-only, while `/api/settings/availability` is authoritative.
- `POST /api/auth/logout` / `POST /api/auth/logout-all` — revoke the current session or every active session for the account. The database stores only hashed session identifiers; a valid Bearer credential remains independent of a browser cookie.
- `GET /api/auth/google/start` / `callback` — OAuth/PKCE flow. With membership enforcement on, a new verified account is created atomically with invitation consumption, membership, and audit; the JWT remains only in an HttpOnly cookie.
- `GET /api/circle` — authenticated and membership-scoped; returns safe profile fields for active members only and never returns email addresses.
- `GET|PUT|POST /api/circles` — lists session-visible circles, selects one by public ID plus expected generation, or atomically creates/selects a secondary circle from an exact name plus opaque request ID. Migration v14 owns POST storage; this release additionally requires exact readiness through v16 and completed credential-control adoption before runtime promotion. POST enforces 10 active owned circles and the 100-membership read ceiling, and returns no internal IDs.
- `POST /api/invitations` / `GET /api/invitations` / `DELETE /api/invitations/:id` — primary-circle owner invitation lifecycle.
- `POST /api/invitations/prepare` — same-origin, rate-limited exchange from a URL-fragment token to a 10-minute Secure/HttpOnly claim cookie.
- `GET /api/weeks` — returns the selected circle's strictly validated current immutable publication. A primary/local response retains its legacy workspace IDs; a secondary response is coordination-only, omits those IDs, and redacts groups whose human member has left.
- `GET /api/my-pair` — returns only the authenticated member's current pair. A secondary response sets `workspace_available:false`, omits room state, and returns `partner_unavailable` without identity if the partner has left. With v16 scheduling enabled, a paired response adds only a stable opaque non-authorizing schedule identity and dashboard path.
- `GET|POST /api/schedule` — primary requests retain the canonical legacy `room_id` contract. In a selected secondary circle after v16, the server derives circle/publication/group scope from the live session; GET has no scope query and POST accepts only action, base version, and instant/proposal ID. Responses remain coordination-only and contain no room or workspace capability.
- `GET /api/history` — Bearer → personal history where you appear, partner counts.
- `POST /api/pairing/run` — selected-circle owner publication endpoint when secondary coordination is enabled. Primary/local publication retains the legacy v6/outbox path. Secondary publication uses v13, exact transaction-time session context and circle ownership, a complete availability snapshot, and same-circle history. With secondary email disabled it writes no outbox row; when enabled, the new claim atomically adds one compact v2 event per paired, solo, or unavailable member without creating workspace rows. Vetted pre-commit database-lock conflicts retry with a bound; an ambiguous commit never does.
- `GET|POST /api/cron/weekly` — protected by `x-cron-secret` or `Authorization: Bearer <CRON_SECRET>`. It accepts the configured Sunday 08:00 UTC run after the London cycle boundary, publishes the same immutable cycle as the owner endpoint, avoids repeat pairing where possible, and gives an odd member Solo practice.
  - If both `RESEND_API_KEY` and `RESEND_FROM` are set, sends email to available users plus a reminder to unavailable users.
  - If either is absent, the delivery summary explains that email is disabled and pairs remain visible in-app via `/api/weeks`.
- `GET|POST /api/cron/outbox` — independently drains due pairing, activation, and password-reset email events under the same cron authentication. Run it every five minutes in production. Claims use expiring token-bound leases and heartbeats; retry delays, provider timeouts, attempts, and dead letters are bounded. Authentication delivery rechecks current token, account/invitation, and membership state before sending, and suppresses stale work.
- `POST /api/admin/outbox/replay` — non-demo global-administrator-only dead-letter replay with a bounded reason code. It writes an audit record and retains the original provider idempotency key.
- `POST /api/admin/reshuffle` — compatibility URL only. Pairing requests delegate to the immutable current-cycle endpoint and cannot force/remix a published cycle; `action=promote` retains its separate legacy admin operation.
- `GET /api/settings/availability` — authenticated, private/no-store read of the upcoming cycle and the caller's exact setting: `{cycle,cycleKey,isAvailable,version,source,editable,updatedAt}`.
- `POST /api/settings/availability` — authenticated compare-and-swap update with the exact body `{cycle_key:string,expected_version:integer,is_available:boolean}`. Strings such as `"false"`, aliases, unknown fields, stale versions, changed cycles, and closed cutoffs are rejected. A `409` returns the refreshed authoritative availability state.
- `POST /api/init` — authenticated admin-only, data-only primary-circle backfill on the exact current schema. It atomically closes the durable registration latch and is a read-only no-op after successful initialization.
- `POST /api/admin/reshuffle` with `action=promote`, plus `POST /api/admin/demo-seed`, `demo-shuffle`, and `demo-reset`, authorize the current administrator before running handler-specific read-only schema checks. They cannot create or repair schema; an unavailable contract returns a generic `503` before data mutation. See [operations request-path DDL retirement](docs/OPERATIONS_RUNTIME_DDL_RETIREMENT.md).

**Scheduler:**
```json
{ "crons":[{ "path":"/api/cron/weekly","schedule":"0 8 * * 0" }] }
```
Vercel Hobby permits only one invocation per day, so the repository keeps its single weekly Vercel cron. Configure a five-minute authenticated call to `/api/cron/outbox` through Vercel Pro cron or an external scheduler before production email is enabled. The fixed weekly 08:00 UTC trigger runs at the Sunday 08:00 London cycle boundary in GMT and one hour after it in BST; immutable publication prevents duplicates.

**Weekly reminder status question:**
Email uses Resend *only if* `RESEND_API_KEY` + `RESEND_FROM` are both set. Managed schema v6 stores the provider-neutral event and replay audit; publication and event creation are atomic, while delivery occurs only after commit. Retries reuse the same provider idempotency key, including after lease expiry or an ambiguous response. If either provider value is absent, the sanitized delivery summary reports that email is disabled and pairs remain visible in-app via `/api/weeks`. Responses, logs, and metrics expose aggregate state only—never recipient addresses or payloads. Example `RESEND_FROM`: `Randori Circle <randori@yourdomain.com>` must use a verified Resend domain.

**Frontend behavior (scaling + availability):**
- Topbar sign-in/out + `meLabel` shows `(admin)` if you're admin email.
- Circle tab: with membership enforcement enabled, `GET /api/circle` displays only active primary-circle members and owners receive invitation controls. The legacy flag-off response remains supported during rollout.
- Pairing tab: the primary-circle owner sees **Run current cycle**; ordinary members see the Sunday 08:00 London-time schedule. The action calls `POST /api/pairing/run` and is safe to repeat because an existing publication is returned unchanged.
- Pair list: signed-in users see only the server-marked current publication and never a local-storage fallback. Anonymous users may still use local demo data. Current cloud topics are read-only.
- Sync card: loads the authoritative upcoming availability, displays its start/end/cutoff in the server timezone, and sends an exact cycle-key/version CAS update. It refreshes on focus, visibility return, and cutoff rollover; stale or changed-cycle responses replace the UI with server state. Profile editing cannot bypass this control, and the circle roster no longer labels the legacy account flag as current-cycle truth. Presence still uses BroadcastChannel.
- History tab: left offline history, right personal history via `/api/history` when signed in.
- Auth: existing password login plus Google SSO, with the application token stored only in an HttpOnly cookie.

**Testing locally:**
```bash
# With NODE_ENV!=production, ALLOW_OPEN_SIGNUP=true, and
# ADMIN_EMAILS=admin@example.com, create the bootstrap owner before init.
curl -s -c /tmp/randori-admin.cookies -X POST http://localhost:3000/api/auth/signup \
  -H 'Origin: http://localhost:3000' -H 'content-type: application/json' \
  -d '{"email":"admin@example.com","password":"replace-me-now","name":"Admin"}' | jq

# Initialize once. This closes new uninvited registration.
curl -s -b /tmp/randori-admin.cookies -X POST http://localhost:3000/api/init \
  -H 'Origin: http://localhost:3000' | jq

# Authenticated circle read
curl -s -b /tmp/randori-admin.cookies http://localhost:3000/api/circle | jq
# Read the editable cycle and retain its cycleKey/version.
curl -s -b /tmp/randori-admin.cookies \
  http://localhost:3000/api/settings/availability | jq

# Availability off (substitute the values returned by GET).
curl -s -b /tmp/randori-admin.cookies -X POST http://localhost:3000/api/settings/availability \
  -H 'Origin: http://localhost:3000' -H 'content-type:application/json' \
  -d '{"cycle_key":"<64-char-cycle-key>","expected_version":0,"is_available":false}' | jq
curl -s -b /tmp/randori-admin.cookies http://localhost:3000/api/auth/me | jq
# strictly validated current publication
curl -s -b /tmp/randori-admin.cookies http://localhost:3000/api/weeks | jq
# idempotent owner publication (empty JSON body only)
curl -s -b /tmp/randori-admin.cookies -X POST http://localhost:3000/api/pairing/run \
  -H 'Origin: http://localhost:3000' -H 'content-type: application/json' -d '{}' | jq
# cron manual
curl -s -X POST http://localhost:3000/api/cron/weekly \
  -H "x-cron-secret: $CRON_SECRET" | jq
```

Before enabling `CIRCLE_MEMBERSHIP_ENABLED`, verify the production database with the Turso shell:

```sql
SELECT id, public_id, name FROM circles WHERE is_primary=1 AND archived_at IS NULL;
SELECT cm.role, cm.status, COUNT(*)
  FROM circle_memberships cm
  JOIN circles c ON c.id=cm.circle_id
  WHERE c.is_primary=1 AND c.archived_at IS NULL
  GROUP BY cm.role, cm.status;
SELECT cae.event_type, COUNT(*)
  FROM circle_audit_events cae
  JOIN circles c ON c.id=cae.circle_id
  WHERE c.is_primary=1 AND c.archived_at IS NULL
    AND cae.event_type IN ('membership.backfilled','membership.backfill.completed')
  GROUP BY cae.event_type;
SELECT registrations_closed FROM circle_membership_rollout WHERE id=1;
SELECT google_sub, COUNT(*) FROM auth_accounts
  WHERE google_sub IS NOT NULL GROUP BY google_sub HAVING COUNT(*)>1;
```

Expect one primary circle, at least one active owner, the intended active member count, one completed-backfill event, `registrations_closed=1`, and no duplicate Google subjects. If verification fails, keep the feature flag off and restore the verified backup. Turning the flag off restores legacy sign-in and roster reads for existing accounts, but intentionally does not reopen registration; reopening the latch is a separate operator decision and must not be used as an automatic rollback.

### Protected schema migration

Do not run the local `db:migrate` command against Turso. Remote status, adoption,
and apply operations are available only through the manually dispatched,
protected GitHub workflow and remain mutation-disabled by default. Each
adoption or one-version apply requires its own successful signed PITR rehearsal
from the exact current `main` commit, a fresh status fingerprint, and an explicit
next-version target for apply. See
[docs/TURSO_PRODUCTION_MIGRATION.md](docs/TURSO_PRODUCTION_MIGRATION.md).

### AI / Groq Router (video-aware)

**Why Groq:** fastest inference, free 14.4k req/day, OpenAI-compatible HTTP, no heavy SDK. Cheap-first routing keeps cost near zero for friends circle.

**Env var in Vercel → Env Vars:**
```
GROQ_API_KEY=gsk_xxx  # https://console.groq.com/keys — free tier 14k req/day, 6k TPM
```

**Endpoints:**
- `POST /api/ai/analyze` — Bearer required. Body `{room_id, pair_label, transcript, code (or code_snapshots frozen array), interviewer_questions, duration_sec, role}`. Returns `{ok, mocked?, session_id, feedback_id, model_used, reason_for_pick, estimated_cost:{cents,usd,tokens_in,tokens_out,groq_usage}, evidence_validated:{validated,total,score}, feedback:{candidate:{strengths:[{point,evidence,confidence}],improvements:[{point,evidence,suggestion}]}, interviewer:{...}, overall_score, next_time_checklist}, debug:{groq_router:{picked, why, alternatives, free_tier_calls_today}}}`.
- `GET /api/ai/feedback/:id` or `?id=` — Bearer — single session feedback
- `GET /api/ai/history` — Bearer — last 20 feedbacks + `usage_today:{date,calls,tokens_in,tokens_out}`.

**Tables auto-created on first call:**
```sql
ai_sessions (id PK, room_id TEXT, pair_label TEXT, transcript TEXT, code_snapshots TEXT, interviewer_questions TEXT, started_at, ended_at, duration_sec INTEGER, cost_cents INTEGER, created_at, created_by INTEGER)
ai_feedback (id PK, session_id INTEGER FK, role TEXT, feedback_json TEXT, evidence TEXT, model_used TEXT, reason_for_pick TEXT, estimated_cost_cents INTEGER, confidence REAL, created_at)
ai_usage (date TEXT PK, calls INTEGER, tokens_in INTEGER, tokens_out INTEGER, updated_at TEXT)
```

**Router logic (cheap/free-first):**
- No key → mocked template feedback that still pulls evidence from transcript/code (so UI works without key, flags `mocked:true`).
- Estimates tokens as len/4. Checks `ai_usage` daily counts. If >13k calls today or >8M tokens — forces `llama-3.1-8b-instant` cheapest.
- If totalIn >6k tokens or transcript >24k chars → `llama-3.3-70b-versatile` for summarization.
- If duration >20m or interviewer_questions >500 chars or system-design-ish → 70b versatile.
- Else short code review/quick → 8b-instant $0.05/1M in / $0.08 out vs $0.59/$0.79 for 70b. Cost cents stored per session, summed in `ai_usage`.

**Prompt / evidence enforcement:** Groq prompt demands JSON with `evidence` being exact verbatim substring from transcript/code. Post-process verifies case-insensitive substring existence; fuzzy 5-word then 3-word chunk check. If not found, replaces evidence with `no direct quote - inferred` and caps confidence ≤0.6. Returns `evidence_validated` score (validated/total). Evidence chips in UI show green quote chip vs yellow "no direct quote".

**Frontend:** Live Code view now has AI panel under Run output — Record button toggles recording of code snapshots (every edit, trimmed to last 6) + manual transcript / interviewer Qs textareas. Get AI Feedback calls `/api/ai/analyze`, spinner, then renders two cards (Candidate strengths/improvements, Interviewer strengths/improvements) with evidence chips + checklist + overall score. Debug box shows which model picked + why + cost + free-tier calls + alternatives (8b vs 70b). History button fetches `/api/ai/history`. Works video-aware via `window._randori_ai` exposed for parallel video subagent.

**Without GROQ_API_KEY:** returns mocked feedback from same JSON shape so UI still demoable, `model_used` suffixed "(mocked - no key)" and debug notes.
