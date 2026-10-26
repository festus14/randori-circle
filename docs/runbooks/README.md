# Operations runbooks — on-call checklist

Short, task-focused procedures for the live service. The descriptive layer —
what the system is, why it works that way, and the failure-mode table — is
[SYSTEM_DESIGN.md](../SYSTEM_DESIGN.md); these runbooks are the procedural
layer under it and do not re-derive it. Every claim here was checked against
the code and configuration on `main`. Production is
`https://randoricircle.com`.

## On-call checklist

1. **Is it the app or the probe?** Check liveness first, then readiness:
   `GET /api/health/live` must be 200. If it is, the functions run; a
   readiness failure is a database / membership / key-control problem, not
   a deploy outage. See [readiness-503 triage](readiness-503.md).
2. **Is mail stuck?** Check `/api/cron/outbox-health` (needs a scheduler
   secret) and the admin Diagnostics outbox card. One stuck recipient is a
   provider / address problem; all mail stuck is a scheduler or flag
   problem. See [email not arriving](email-not-arriving.md) and
   [scheduler stopped](scheduler-stopped.md).
3. **Is a scheduler down?** Outbox mail ageing past 15 minutes is the
   signal that matters, not which scheduler ran last. See
   [scheduler stopped](scheduler-stopped.md).
4. **Can people sign in?** Check the public `/api/auth/capabilities`
   response before touching any console. See
   [Google sign-in broken](google-sign-in.md).
5. **Did a deploy just land?** Turn the suspect flag off first; roll the
   code back only after that. See [feature flags](feature-flags.md) and
   [rollback a bad deploy](rollback-bad-deploy.md).
6. **Is it the schema?** Never run `npm run db:migrate` against
   production, never hand-edit database rows, never delete a database by
   prefix. See [schema migration cutover](schema-migration-cutover.md) and
   [backup restore](backup-restore.md).

Rules that apply to every runbook:

- Read-only diagnosis first. Every runbook's Confirm step uses
  read-only commands.
- Destructive steps are marked **Destructive** and need a second look
  before running.
- Never paste a secret into chat, an issue, a PR, a screenshot, or a
  repository file. Type secrets straight into the provider dashboard or
  password manager.
- After any fix, run the runbook's Verify step and confirm the next
  scheduled watchdog run is green.

## Runbooks

| Runbook | When to use it |
| --- | --- |
| [readiness-503.md](readiness-503.md) | `/api/health/ready` returns 503 |
| [email-not-arriving.md](email-not-arriving.md) | A member reports mail never arrived, or dead letters grow |
| [scheduler-stopped.md](scheduler-stopped.md) | Outbox mail ages past 15 minutes, or a scheduler alert fires |
| [google-sign-in.md](google-sign-in.md) | Google sign-in fails or is not offered |
| [domain-dns.md](domain-dns.md) | Domain, redirect, certificate, or sender-domain verification problems |
| [schema-migration-cutover.md](schema-migration-cutover.md) | Applying the next schema migration to production |
| [backup-restore.md](backup-restore.md) | Restore rehearsal alerts, or a real restore is needed |
| [rollback-bad-deploy.md](rollback-bad-deploy.md) | A deploy made production worse |
| [feature-flags.md](feature-flags.md) | Turning a feature flag on or off |
| [rotating-secrets.md](rotating-secrets.md) | Rotating any secret or credential key |

Long-form background lives in the dedicated docs each runbook links to:
the [production bootstrap guide](../PRODUCTION_BOOTSTRAP_GUIDE.md) for
setup, [ENVIRONMENT.md](../ENVIRONMENT.md) for every variable and flag,
[KEY_ROTATION.md](../KEY_ROTATION.md) for key rings, and the
[decision log](../IMPLEMENTED_DECISIONS.md) for why each control exists.
Incident write-ups live in [postmortems](../postmortems/).
