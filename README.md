# Randori Circle — Vercel Deploy (main)

This is the Vercel-deployable build of Randori Circle.

- Static single-file app, no Hatch SDK, no file: deps
- Dark-mode-first, AI partner for odd counts, DSA/System/Both picker, live coding room, whiteboard
- Uses localStorage + BroadcastChannel for live tab sync (zero backend).
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

Deployed branch is `main`. Vercel auto-deploys on push.

Live room now: Code ↔ Board toggle + AI panel (Record & Analyze) — captures code snapshots + transcript manual notes, calls Groq cheap-first (8b-instant vs 70b-versatile) respecting free-tier usage in Turso ai_usage, verifies evidence substring exists, returns strengths/improvements with quote chips + next checklist.

