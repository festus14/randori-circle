# Randori Circle — Vercel Deploy (main)

This is the Vercel-deployable build of Randori Circle.

- Static single-file app, no Hatch SDK, no file: deps
- Dark-mode-first, AI partner for odd counts, DSA/System/Both picker, live coding room, whiteboard
- Uses localStorage + BroadcastChannel for live tab sync (zero backend).
- To add shared Turso DB later: set `TURSO_DATABASE_URL` + `TURSO_AUTH_TOKEN` and add a `/api` proxy — see docs.

Deployed branch is `main`. Vercel auto-deploys on push.
