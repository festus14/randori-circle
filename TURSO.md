# Turso — why we picked it for Randori Circle

**Current schema is SQLite (Drizzle `sqliteTable`). Turso is SQLite at the edge (libSQL). Zero migration.**

- **Zero rewrite**: Your tables (`users`, `pairing_weeks`, `pairing_groups`, `questions`) are already `sqliteTable`. Turso speaks libSQL protocol, so `drizzle-orm` + `@libsql/client` connects with one URL. Postgres/Supabase would require rewriting all schemas to `pgTable`, changing types, handling serial vs autoincrement, enums, etc.

- **Free tier that actually fits**: Turso free = 500 DBs, 9GB total, 500M rows read/month, 25M rows written. For a circle of friends doing weekly pairings, that's absurdly generous. Supabase free is also generous but gives you 2 projects cap, 500MB, and shared pooler limits. Neon free sleeps.

- **Vercel-native edge latency**: Turso runs on same edge network as Vercel. `TURSO_DATABASE_URL=libsql://...` from Singapore/London still <50ms. Postgres via Neon/Supabase from edge needs pooling, can cold-start slower.

- **No pooling, no `DATABASE_URL` drama**: Postgres serverless needs PgBouncer / connection strings. libSQL is HTTP-based — works from Vercel serverless functions AND edge functions with one auth token. No lingering connections.

- **Browser-possible if you want offline-first later**: `@libsql/client/web` can even query Turso directly from the static app (read-only token) — handy for your static-first build where you currently use localStorage + BroadcastChannel.

### What about others?

- **Supabase / Postgres (incl. Vercel Postgres, Neon)**: Great if you need serious relational features, foreign key heavy, Row Level Security, auth built-in. Migration cost: rewrite drizzle schemas to pg, setup pooling, handle connection limits. We can still switch later — Drizzle makes that mechanical.

- **PlanetScale (MySQL/vitess)**: Excellent branching, but MySQL dialect. Your app is SQLite-native, would need MySQL types, different autoincrement handling. Free tier row-read limits tighter now.

- **Firebase / Firestore**: Realtime is nice for live coding presence, but you'd remodel everything to collections/documents, lose SQL joins for pair history. Better as a complement for live sync, not primary relational store.

- **MongoDB Atlas**: NoSQL — lose Drizzle typed schema, you'd rewrite to documents. Not worth for strongly relational pair weeks/groups.

**Bottom line:** Turso let us go from your local `app.db` file to a global free DB with **one env var** and keep Drizzle SQLite code intact. If Randori grows beyond friends (hundreds of concurrent sessions), we can migrate to Postgres (Supabase/Neon) — Drizzle makes that a search-replace of dialects.

### Using Turso in this repo

1. Create DB: `turso db create randori-circle --location lhr` (London, since you're Royal Wharf)
2. `turso db show randori-circle --url`
   `turso db tokens create randori-circle --expiration Never` (or 30d for safety)
3. In Vercel Dashboard → your project → Settings → Environment Variables:
   ```
   TURSO_DATABASE_URL=libsql://randori-circle-xxxx.turso.io
   TURSO_AUTH_TOKEN=eyJ...
   JWT_SECRET=some-random-64-char-string  # openssl rand -base64 48
   CRON_SECRET=same-or-another-random-string
   RESEND_API_KEY=re_xxx  # optional for email notify
   RESEND_FROM=Randori <noreply@yourdomain.com>
   APP_URL=https://randori-circle-self.vercel.app
   GOOGLE_CLIENT_ID=...
   GOOGLE_CLIENT_SECRET=...
   ```
4. After first deploy, hit `POST https://your-app.vercel.app/api/init` once to create tables (now also creates auth_accounts + availability columns).
5. Frontend will still work with localStorage-only if those env vars are missing — it falls back gracefully.

### Personalization + Scaling layer (auto-circle + admin-only reshuffle)

**New table columns:** `auth_accounts (… is_available INTEGER DEFAULT 1, availability_updated_at TEXT)`

Migration is automatic in `api/init.js`, `api/cron/weekly.js`, `api/admin/reshuffle.js`, `api/circle.js`, `api/auth/me.js` via `ALTER TABLE … ADD COLUMN` idempotent.

**Scaling rule:**
- Circle = **all** `auth_accounts` (everyone who signed up via email/password or Google SSO). Manual names assumption removed.
- Manual Shuffle/Reshuffle = **admin only** — email `festusomole14@gmail.com` (case-insensitive) with valid JWT. All others see "Auto-shuffles Sun 08:00 BST".
- Availability — each user can toggle `Available this week` via `/api/settings/availability`. Weekly cron & admin reshuffle both filter `COALESCE(is_available,1)=1`. Unavailable users get skipped + reminder.

**Env vars added beyond section above:**
- `JWT_SECRET` — HS256 secret for signing auth tokens (30d expiry). If missing, dev fallback `dev-randori-jwt-secret-change-me` — set a real one in prod.
- `CRON_SECRET` — secret protecting `/api/cron/weekly`. If missing, defaults to JWT_SECRET. Send as `x-cron-secret` header or `?secret=` or Vercel Cron header (auto).
- `RESEND_API_KEY` (optional) — if set, weekly cron emails **available** participants after shuffle + separate reminder email to unavailable participants. Without it, pairs only visible in-app via `/api/weeks`. `resend` package is dynamically imported — cron skips gracefully if lib not installed.
- `RESEND_FROM` optional from address.
- `APP_URL` — canonical production URL, used for Google OAuth redirect URI and email links. Defaults to `https://randori-circle-self.vercel.app` if missing.
- `GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET` — for Google SSO (`/api/auth/google/*`). Configure in Google Cloud Console → OAuth client → Web → origins + redirect: `https://randori-circle-self.vercel.app/api/auth/google/callback` plus localhost variants.

**Endpoints:**
- `POST /api/auth/signup` — `{email,password,name}` → `{token,user}`. Hash bcryptjs, also creates deterministic color.
- `POST /api/auth/login` — `{email,password}` → token
- `GET /api/auth/me` — Bearer → user with `is_available`, `availability_updated_at`
- `GET /api/auth/google/start` / `callback` — OAuth flow, creates auth_accounts + users entry if new, issues own JWT, redirects `/?g_token=&g_name=`
- `GET /api/circle` — public — returns `{circle: [{id,display_name,name,email,color,is_available,source}], count}` source = auth_accounts preferred else legacy users. Shows availability badge (● avail / ○ away).
- `GET /api/users` — backwards compat — same as circle but shape `{users: [{id,name,color...}]}` from auth_accounts if any, else users. POST now admin-only JWT required.
- `GET /api/weeks` — returns `{weeks: [{id,week_label,week_start,focus,pairs:[{a_id,b_id,a_name,b_name,is_ai,topic]}]}` latest 20 weeks enriched, join auth_accounts + users.
- `GET /api/history` — Bearer → personal history where you appear, partner counts.
- `GET|POST /api/cron/weekly` — Protected: header `x-cron-secret` or Bearer admin JWT or Vercel Cron header or `?secret=`. Shuffles only `is_available=1` auth_accounts (NULL treated as 1). Avoids repeat pairing where possible (8 attempts), handles odd → is_ai_pair=1. Skips if ISO week already exists. Returns `{available_count,total_accounts,unavailable_count,unavailable:[…], email, unavailable_emails, unavailable_reminders, note, app_url}`. 
  - If `RESEND_API_KEY` set, sends email to available users + reminder to unavailable ("You missed … toggle back ON").
  - If not set, `email` field explains fallback: pairs visible in-app via `/api/weeks` only.
- `POST /api/admin/reshuffle` — admin-only (Bearer JWT where email.toLowerCase() === festusomole14@gmail.com). Forces reshuffle for current ISO week (deletes old groups, replaces). Respects availability filter. Use when someone toggles Available back mid-week.
- `POST /api/settings/availability` — Bearer → `{is_available:boolean}` updates your row `is_available`, `availability_updated_at=datetime('now')`
- `GET /api/settings/me` — Bearer → user + availability + admin flag + `settings.note`
- `GET /api/init` — creates tables + migrates availability cols.

**Vercel crons:**
```json
{ "crons":[{ "path":"/api/cron/weekly","schedule":"0 7 * * 0" }] }
```
= Sun 07:00 UTC = 08:00 BST (BST is UTC+1 Apr-Oct). Winter GMT it will be 07:00 GMT — still morning.

**Weekly reminder status question:**
Current cron emails via Resend *only if* `RESEND_API_KEY` + `RESEND_FROM` set in Vercel. Otherwise `email` field says "skipped (no RESEND_API_KEY) — pairs visible in-app via /api/weeks". Same for unavailable reminders: they are returned in API field `unavailable_reminders: [{id,name,email,reason,action}]` and logged in response JSON even when no email sent, so frontend can show in-app banner ("You were skipped this week") on next login. To fully enable emails, set both Resend vars & redeploy. Example `RESEND_FROM`: `Randori Circle <randori@yourdomain.com>` must be verified domain in Resend dashboard.

**Frontend behavior (scaling + availability):**
- Topbar sign-in/out + `meLabel` shows `(admin)` if you're admin email.
- Circle tab: Add input hidden for non-admin (admin sees testing input). Main circle comes from `GET /api/circle` — displays all signed-up auto-included users with availability dot green (`● avail`) grey (`○ away`). Offline fallback shows local demo only.
- Pairing tab: Shuffle/Reshuffle buttons hidden for non-admin, replaced by `admin` pill or "auto-shuffles Sun 08:00 BST". Admin click triggers `POST /api/admin/reshuffle` cloud (respects available). Non-admin manual path disabled.
- Pair list: if signed in, `GET /api/weeks` cloud weeks shown first (☁ cloud auto). Else shows local demo weeks. Cloud weeks are read-only topics (Pick together). Topic picker disabled for cloud (future).
- Sync card: new `Available this week` toggle — POSTs to `/api/settings/availability`, updates UI, shows banner if you are currently unavailable + another banner if you were skipped last week (`randori-was-skipped` local flag). Also notes email fallback status. Presence still via BroadcastChannel.
- History tab: left offline history, right personal history via `/api/history` when signed in.
- Auth: email/password + Google SSO, token stored `randori-token`.

**Testing locally:**
```bash
# init
curl -s http://localhost:3000/api/init | jq
# signup
curl -s http://localhost:3000/api/auth/signup -H content-type:application/json -d '{"email":"test@example.com","password":"secret12","name":"Test"}' | jq
# circle
curl -s http://localhost:3000/api/circle | jq
# availability off
TOKEN=...
curl -s http://localhost:3000/api/settings/availability -H "Authorization: Bearer $TOKEN" -H content-type:application/json -d '{"is_available":false}' | jq
curl -s http://localhost:3000/api/settings/me -H "Authorization: Bearer $TOKEN" | jq
# weeks
curl -s http://localhost:3000/api/weeks | jq
# admin reshuffle (only festusomole14@gmail.com token)
curl -s -X POST http://localhost:3000/api/admin/reshuffle -H "Authorization: Bearer $ADMIN_TOKEN" | jq
# cron manual
curl -s "http://localhost:3000/api/cron/weekly?secret=$CRON_SECRET" | jq
# AI feedback (Groq router)
# set GROQ_API_KEY in Vercel env first — free tier 14,400 req/day, ~$0.05/1M for 8b-instant
curl -s http://localhost:3000/api/ai/analyze -H "Authorization: Bearer $TOKEN" -H content-type:application/json -d '{"room_id":"room-abc","pair_label":"Festus×Priya","transcript":"Interviewer: explain hashmap?\nCandidate: I used Map because O(1)...\nInterviewer: edge case empty?", "code":"function twoSum(nums,t){ const m=new Map(); }","interviewer_questions":"What if duplicate?","duration_sec":480}' | jq
# get feedback by session id
curl -s http://localhost:3000/api/ai/feedback/1 -H "Authorization: Bearer $TOKEN" | jq
# history + usage today
curl -s http://localhost:3000/api/ai/history -H "Authorization: Bearer $TOKEN" | jq
```

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



