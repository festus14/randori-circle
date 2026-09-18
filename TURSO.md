# Turso — current database and rollout runbook

**The current application uses handwritten SQLite/libSQL statements through `@libsql/client`. Turso keeps that model deployable from Vercel. The new membership schema uses the reviewed admin rollout below; issue #8 tracks removal of older request-path DDL elsewhere in the application. A checksummed schema manifest and read-only drift inspector now freeze that debt, but there is intentionally no general apply command yet.**

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
   AUTH_SCHEMA_BOOTSTRAP_ENABLED=false
   RESEND_API_KEY=re_xxx  # omit both Resend values to keep email disabled
   RESEND_FROM=Randori <noreply@your-verified-domain.com>
   APP_URL=https://randori-circle-self.vercel.app
   GOOGLE_CLIENT_ID=...
   GOOGLE_CLIENT_SECRET=...
   ```
4. Complete and verify the production backup/restore work tracked by issue #6 and the migration controls tracked by issue #8 before changing production data.
   Run `npm run --silent db:status` and `npm run --silent db:plan` against the restored copy and retain their JSON reports. These commands use only `SELECT`/`PRAGMA`; `db:plan` is descriptive and cannot apply changes. See [the schema inspection runbook](docs/DATABASE_SCHEMA_OPERATIONS.md).
   The fingerprint-gated `db:migrate status`, `apply`, and `adopt` workflow may be rehearsed only against an explicit local `file:` URL. It never reads Turso credentials and rejects `libsql:`, `http:`, and `https:` targets. Remote production migration remains blocked until the backup/restore verifier is complete.
5. Deploy with `CIRCLE_MEMBERSHIP_ENABLED=false` and `AUTH_SCHEMA_BOOTSTRAP_ENABLED=false`. The rollout-state checks are read-only; any legacy registration that races initialization is atomically included or rejected.
6. If this is a fresh database with no account, temporarily set `AUTH_SCHEMA_BOOTSTRAP_ENABLED=true` and restrict `SIGNUP_ALLOWLIST` to the normalized `ADMIN_EMAILS` address. Sign in once with that Google account, immediately restore `AUTH_SCHEMA_BOOTSTRAP_ENABLED=false`, and redeploy. This explicit maintenance switch creates only the legacy auth baseline; it does not create membership tables.
7. Sign in with the bootstrap account and verify `GET /api/auth/me` reports `is_admin: true`.
8. Call the authenticated admin-only `POST https://your-app.vercel.app/api/init`. This creates the membership schema, closes new uninvited registration, and atomically backfills existing non-demo accounts.
9. Verify the rollout queries below before setting `CIRCLE_MEMBERSHIP_ENABLED=true` and redeploying.

### Personalization + Scaling layer (primary circle + immutable weekly publication)

**Membership data:** `circles`, `circle_memberships`, hashed `circle_invitations`, `circle_audit_events`, and the singleton `circle_membership_rollout` latch.

Membership-schema migration is explicit through authenticated `POST /api/init`; rollout-state probes and ordinary circle, pairing, and invitation requests do not create membership schema. The temporary fresh-database auth bootstrap in step 6 is the only exception introduced by this rollout.

**Scaling rule:**
- Circle = active `circle_memberships` in the one operational primary circle. The one-time migration backfills existing non-demo authenticated accounts; legacy `users` rows are never inferred as members.
- Manual publication = **primary-circle owner only** in production. The isolated loopback/local-file development runtime permits its database admin. `POST /api/pairing/run` is idempotent: once the current London cycle is published, later calls return that publication without changing pairs.
- Availability — each user can toggle `Available this week` via `/api/settings/availability`. The weekly cron and manual publication both filter `COALESCE(is_available,1)=1`. Unavailable users are skipped and can receive a reminder.

**Env vars added beyond section above:**
- `JWT_SECRET` — at least 32 random bytes, used for 12-hour HS256 session cookies and keyed invitation/email hashes. Rotating it signs out all sessions and invalidates every outstanding invitation; revoke/reissue invitations as part of rotation.
- `CRON_SECRET` — separate secret protecting `/api/cron/weekly`. Send it as the `x-cron-secret` header or use Vercel Cron authentication.
- `RESEND_API_KEY` and `RESEND_FROM` (optional as a pair) — when both are set, weekly cron emails **available** participants after shuffle and sends a separate reminder to unavailable participants. If either is absent, delivery remains disabled and pairs are visible in-app via `/api/weeks`. The sender must be verified in Resend.
- `APP_URL` — canonical production URL, used for Google OAuth redirect URI and email links. Defaults to `https://randori-circle-self.vercel.app` if missing.
- `GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET` — for Google SSO (`/api/auth/google/*`). Configure in Google Cloud Console → OAuth client → Web → origins + redirect: `https://randori-circle-self.vercel.app/api/auth/google/callback` plus localhost variants.

**Endpoints:**
- `POST /api/auth/signup` — development compatibility only; production password signup is disabled, and the rollout latch prevents late uninvited accounts.
- `POST /api/auth/login` — existing password users only; establishes an HttpOnly session cookie.
- `GET /api/auth/me` — authenticated session profile with availability and admin status.
- `GET /api/auth/google/start` / `callback` — OAuth/PKCE flow. With membership enforcement on, a new verified account is created atomically with invitation consumption, membership, and audit; the JWT remains only in an HttpOnly cookie.
- `GET /api/circle` — authenticated and membership-scoped; returns safe profile fields for active members only and never returns email addresses.
- `POST /api/invitations` / `GET /api/invitations` / `DELETE /api/invitations/:id` — primary-circle owner invitation lifecycle.
- `POST /api/invitations/prepare` — same-origin, rate-limited exchange from a URL-fragment token to a 10-minute Secure/HttpOnly claim cookie.
- `GET /api/weeks` — active primary-circle membership required (or a non-demo local account in the isolated local runtime). Returns only the strictly validated current immutable publication; it never falls back to historical, demo, or legacy-user rows.
- `GET /api/my-pair` — returns only the authenticated member's pair from that same strictly validated current publication. Revoked members and incomplete/corrupt publications fail closed.
- `GET /api/history` — Bearer → personal history where you appear, partner counts.
- `POST /api/pairing/run` — primary-circle owner publication endpoint. Owner authorization, eligible members, source-scoped history, and the immutable publication are processed in one write transaction. Vetted pre-commit database-lock conflicts retry with a bound; an ambiguous commit is never retried.
- `GET|POST /api/cron/weekly` — protected by `x-cron-secret` or `Authorization: Bearer <CRON_SECRET>`. It accepts the configured Sunday 08:00 UTC run after the London cycle boundary, publishes the same immutable cycle as the owner endpoint, avoids repeat pairing where possible, and gives an odd member Solo practice.
  - If both `RESEND_API_KEY` and `RESEND_FROM` are set, sends email to available users plus a reminder to unavailable users.
  - If either is absent, the delivery summary explains that email is disabled and pairs remain visible in-app via `/api/weeks`.
- `POST /api/admin/reshuffle` — compatibility URL only. Pairing requests delegate to the immutable current-cycle endpoint and cannot force/remix a published cycle; `action=promote` retains its separate legacy admin operation.
- `POST /api/settings/availability` — Bearer → `{is_available:boolean}` updates your row `is_available`, `availability_updated_at=datetime('now')`
- `GET /api/auth/me` — session cookie or Bearer token → current user, availability, and admin status.
- `POST /api/init` — authenticated admin-only schema migration and one-time primary-circle backfill. It also closes the durable registration latch.

**Vercel crons:**
```json
{ "crons":[{ "path":"/api/cron/weekly","schedule":"0 8 * * 0" }] }
```
Vercel Hobby permits only one invocation per day. The fixed 08:00 UTC trigger runs at the Sunday 08:00 London cycle boundary in GMT and one hour after it in BST; the endpoint accepts that bounded post-cutoff window and immutable publication prevents duplicates. This deliberately prefers a one-hour summer delay over publishing before the availability cutoff.

**Weekly reminder status question:**
Current cron emails via Resend *only if* `RESEND_API_KEY` + `RESEND_FROM` are both set in Vercel. Otherwise the sanitized delivery summary reports that email is disabled and pairs remain visible in-app via `/api/weeks`. Pairing responses expose aggregate delivery counts only—never recipient addresses or generation tokens. To enable email, set both values and redeploy. Example `RESEND_FROM`: `Randori Circle <randori@yourdomain.com>` must use a verified Resend domain.

**Frontend behavior (scaling + availability):**
- Topbar sign-in/out + `meLabel` shows `(admin)` if you're admin email.
- Circle tab: with membership enforcement enabled, `GET /api/circle` displays only active primary-circle members and owners receive invitation controls. The legacy flag-off response remains supported during rollout.
- Pairing tab: the primary-circle owner sees **Run current cycle**; ordinary members see the Sunday 08:00 London-time schedule. The action calls `POST /api/pairing/run` and is safe to repeat because an existing publication is returned unchanged.
- Pair list: signed-in users see only the server-marked current publication and never a local-storage fallback. Anonymous users may still use local demo data. Current cloud topics are read-only.
- Sync card: new `Available this week` toggle — POSTs to `/api/settings/availability`, updates UI, shows banner if you are currently unavailable + another banner if you were skipped last week (`randori-was-skipped` local flag). Also notes email fallback status. Presence still via BroadcastChannel.
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
# availability off
curl -s -b /tmp/randori-admin.cookies -X POST http://localhost:3000/api/settings/availability \
  -H 'Origin: http://localhost:3000' -H 'content-type:application/json' \
  -d '{"is_available":false}' | jq
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
