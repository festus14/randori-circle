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
   ```
4. After first deploy, hit `POST https://your-app.vercel.app/api/init` once to create tables (now also creates auth_accounts).
5. Frontend will still work with localStorage-only if those env vars are missing — it falls back gracefully.

### Personalization layer (new)

**New table:** `auth_accounts (id PK, email UNIQUE, password_hash, display_name, color, created_at, last_login)`

**Env vars added:**
- `JWT_SECRET` — HS256 secret for signing auth tokens (30d expiry). If missing, dev fallback `dev-randori-jwt-secret-change-me` — set a real one in prod.
- `CRON_SECRET` — secret protecting `/api/cron/weekly`. If missing, defaults to JWT_SECRET. Send as `x-cron-secret` header or `?secret=` or Vercel Cron header (auto).
- `RESEND_API_KEY` (optional) — if set, weekly cron emails participants after shuffle (uses `resend` npm; install only if you intend to use — cron gracefully skips if lib not present).
- `RESEND_FROM` optional from address.

**Endpoints:**
- `POST /api/auth/signup` — body `{email,password,name}`. Creates auth_accounts + users entry, returns `{token,user}`. 409 if email exists. Hash with bcryptjs.
- `POST /api/auth/login` — `{email,password}` → `{token,user}`.
- `GET /api/auth/me` — header `Authorization: Bearer <token>` → `user`.
- `GET /api/history` — same Bearer → returns weeks where you appear, enriched partner names, `partner_counts`.
- `GET|POST /api/cron/weekly` — Protected: header `x-cron-secret: <CRON_SECRET>` or `Authorization: Bearer <admin JWT>` or Vercel Cron header or query `?secret=`. Shuffles all auth_accounts (fallback users) if ISO week not yet shuffled, avoids repeat pairing where possible (8 attempts), handles odd → is_ai_pair=1, inserts into pairing_weeks (`YYYY-W##`) and pairing_groups. Skips if week already exists. Optional Resend notify.
- `GET /api/init` now also creates `auth_accounts` table.

**Vercel crons:**
In `vercel.json`:
```json
{ "crons":[{ "path":"/api/cron/weekly","schedule":"0 7 * * 0" }] }
```
That's Sunday 07:00 UTC = 08:00 BST London as you originally wanted.

**Frontend behavior:**
- Topbar shows Sign in / Sign out, displays your name dot when logged in.
- Stored token in localStorage `randori-token`, user in `randori-me`.
- Shuffle button now shows hint "Auto-shuffles Sundays 08:00 BST — normally you don't need this". If you're not signed in, manual shuffle asks for confirm.
- History tab: left side offline local history, right side personal history from `/api/history` when signed in (partner counts, AI flag).
- Sync card notes cloud sync when signed in.

**Testing locally:**
```bash
# signup
curl -s http://localhost:5173/api/auth/signup -H content-type:application/json -d '{"email":"test@example.com","password":"secret12","name":"Test"}' | jq
# login
curl -s http://localhost:5173/api/auth/login -H content-type:application/json -d '{"email":"test@example.com","password":"secret12"}' | jq
# me
curl -s http://localhost:5173/api/auth/me -H "Authorization: Bearer $TOKEN" | jq
# cron (manual)
curl -s "http://localhost:5173/api/cron/weekly?secret=$CRON_SECRET" | jq
```

See `api/auth/*.js`, `api/cron/weekly.js`, `api/history.js`, `api/init.js`.

