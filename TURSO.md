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
   ```
4. After first deploy, hit `POST https://your-app.vercel.app/api/init` once to create tables.
5. Frontend will still work with localStorage-only if those env vars are missing — it falls back gracefully.

See `api/users.js` and `api/init.js` for wiring.
