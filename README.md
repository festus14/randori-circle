# Randori Circle — Vercel Deploy (main)

This is the current Vercel-deployable prototype of Randori Circle. Production hardening is being delivered as small, measurable vertical slices; see [the production architecture plan](docs/PRODUCTION_ARCHITECTURE_PLAN.md).

- Static single-file app, no Hatch SDK, no file: deps
- Dark-mode-first, AI partner for odd counts, DSA/System/Both picker, live coding room, whiteboard
- The current collaboration layer uses localStorage + BroadcastChannel and is intentionally limited to local-tab sync until the managed realtime slice ships.
- To add shared Turso DB later: set `TURSO_DATABASE_URL` + `TURSO_AUTH_TOKEN` and add a `/api` proxy — see docs.

Grouped API under Hobby 12-function limit:
- `api/auth/[...slug].js` — signup/login/me + Google OAuth
- `api/data/[...slug].js` — circle/weeks/history/init
- `api/ops/[...slug].js` — availability/reshuffle/weekly
- `api/ai/[...slug].js` — Groq AI feedback router (analyze/feedback/history) with evidence-enforced JSON
- `api/video/[...slug].js` — WebRTC signaling + STUN (parallel subagent)

Env beyond Turso:
- `GROQ_API_KEY=gsk_...` — https://console.groq.com/keys — free 14.4k req/day, OpenAI-compatible https://api.groq.com/openai/v1/chat/completions
- `JWT_SECRET`, `CRON_SECRET`, `RESEND_API_KEY`, `GOOGLE_CLIENT_ID/SECRET`
- Copy `.env.example` for the complete local configuration contract.

Deployed branch is `main`. Vercel auto-deploys on push.

AI coaching is disabled by default. It requires `AI_ENABLED=true`, an authenticated session, explicit consent, and a configured provider key. This keeps the coordination workflow usable without exposing interview content during the hardening phase.
