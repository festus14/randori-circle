# Randori Circle

A mock-interview pairing app for a small circle preparing for engineering interviews. Every week, members are randomly paired for 60-minute mock interviews with a focus on **Data Structures & Algorithms**, **System Design**, or **Both**.

Live: production deploys from `main` (Vercel auto-deploys on push).

## How it works

1. **Circle setup** — add the set of users (sign up via email/password or Google OAuth). Onboarding is shown once and never again after completion or dismissal; returning sign-ins don't re-ask for details.
2. **Weekly pairing** — a Vercel cron (`0 7 * * 0`, Sundays) hits `/api/cron/weekly`, which randomly pairs members. Pairing makes up to 8 randomized attempts to avoid recent repeats; an odd member out gets an AI partner. Rooms are deterministic: `week_{weekId}_pair_{pgId}`.
3. **Live room** — each pair gets a coding room with:
   - Monaco editor with formatting and lint feedback, plus loading spinners on async actions
   - Code execution via the server-side `/api/execute` runner (Piston-backed for JavaScript and other languages; local JS execution is a fallback only)
   - Every run is executed against the question's stored test cases and **persisted to the DB**
   - Whiteboard for system-design sketching
   - WebRTC video scaffolding (signaling via `/api/video`)
   - AI feedback panel ("Record & Analyze") — captures code snapshots plus transcript notes, calls Groq cheap-first (8b-instant vs 70b-versatile, usage tracked in Turso `ai_usage`), and enforces evidence: returned strengths/improvements must quote the actual session
4. **Reminders** — email (Resend) and SMS reminders with per-user preferences (`user_notification_prefs`).

## Question bank

- **Seeded questions** (verified live on 2026-09-17 via `GET /api/questions`): 5 questions, 20 test cases total, distributed **6 / 6 / 4 / 2 / 2** — Two Sum, Valid Parentheses, Merge Two Sorted Lists, LRU Cache, and a System Design variant of Design Twitter.
- **Custom questions** — members can add their own; stored in `custom_questions` with test cases.
- **LeetCode pipeline** — `GET /api/leetcode` and `/api/leetcode/sync` import LeetCode questions into the DB; a public API enriches runnable test cases. Direction: scrape for coverage → save in our DB → enrich test cases via API.

## Architecture

Single-page `index.html` (dark-mode-first, zero build step) backed by grouped Vercel serverless functions. Functions are grouped under the Hobby 12-function limit — flat files with `?endpoint=` rewrites (see `vercel.json`):

| Function | Endpoints |
|---|---|
| `api/auth.js` | signup / login / me, Google OAuth start + callback |
| `api/data.js` | circle, weeks, history, init, profile, my-pair, stats, schedule, messages, questions, runs, leetcode + sync, execute, logs, health |
| `api/ops.js` | availability, reshuffle, weekly cron, demo seed/shuffle/reset, notification prefs |
| `api/ai.js` | Groq AI feedback router (analyze / feedback / history) with evidence-enforced JSON |
| `api/video.js` | WebRTC signaling + STUN (signal / ice / join / leave) |
| `api/_db.js` | shared Turso/libsql client + admin helpers |

- **Database**: Turso (libsql) — pairings, profiles, questions, session runs, notification prefs, logs, AI usage. See `TURSO.md`.
- **Auth**: JWT sessions; Google OAuth (see `GOOGLE_OAUTH.md`). Admins via `ADMIN_EMAILS` env var or the `is_admin` DB flag.
- **Observability**: `/api/health` (200 when healthy; exposes `errors_last_hour` / `warns_last_hour` counts and spike detection), `/api/logs` (admin-only), server + client logging, Sentry wired for error capture.
- **Language**: JavaScript-only — no `tsconfig.json`, no TypeScript checks.

## Environment variables

| Variable | Purpose |
|---|---|
| `TURSO_DATABASE_URL`, `TURSO_AUTH_TOKEN` | shared database |
| `JWT_SECRET` | session signing |
| `CRON_SECRET` | protects `/api/cron/weekly` |
| `GROQ_API_KEY` | AI feedback (free tier: 14.4k req/day) |
| `RESEND_API_KEY` | email reminders |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | Google OAuth |
| `ADMIN_EMAILS` | comma-separated list auto-promoted to admin on signup |

## Development & testing

```bash
npm install
npx playwright test            # e2e suite
npx playwright test --ui        # interactive runner
```

E2E specs live in `tests/e2e/`: health, onboarding, Monaco editor, lint/format, JS + Python runners, execution parity, and run persistence.

## Roadmap — what we intend to build

- **Full LeetCode parity**: expand scraped coverage in the DB and keep enriching runnable test cases via the public API, so the question bank approaches LeetCode breadth for DSA while keeping our custom system-design questions.
- **Video calls**: harden the current WebRTC signaling scaffolding into reliable in-room calls.
- **AI feedback quality**: iterate on the evidence-enforced Groq feedback (strengths/improvements with quote chips, next-step checklist).
- **Reminders**: continue tuning email/SMS reminder timing around the Sunday pairing run.

## Known gaps & what needs updating

- **CI is stale**: the last successful e2e run was 2026-08-18. There is no scheduled trigger for the Playwright workflow — add one (or dispatch manually) so regressions are caught continuously.
- **Possible `#runBtn` readiness flake** in the e2e suite: if reproduced, harden the waits before clicking run.
- **Dependency hygiene**: `js-yaml` 3.x resolves transitively through dev tooling (GHSA-2883-xcg3-v3hh / CVE-2026-84375). Real-world exploitability is low; planned fix is pinning `js-yaml` to 3.15.2 via npm `overrides` (or Yarn `resolutions`).
- **Credential rotation**: rotate service tokens (Turso, Resend, etc.) on a schedule; tokens live in the Vercel dashboard / private settings, never in chat or the repo.
- This README was rewritten 2026-09-17 to reflect the real architecture (it previously described a backend-less build and a route layout that no longer exists).
