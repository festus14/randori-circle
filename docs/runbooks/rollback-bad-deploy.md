# Rollback a bad deploy

A deploy made production worse. The descriptive layer is
[SYSTEM_DESIGN.md](../SYSTEM_DESIGN.md) §9.1 (deploy) and §9.3
(readiness); merge gates are in
[DEPLOYMENT_GATES.md](../DEPLOYMENT_GATES.md).

## Symptoms

- Readiness, smoke checks, or a user-visible flow broke right after
  a Production deploy.
- Sentry / `app_logs` errors spike on the new deployment.

## Confirm (read-only)

```bash
curl -s https://randoricircle.com/api/health/live
curl -s -o /dev/null -w '%{http_code}\n' https://randoricircle.com/api/health/ready
# Live 200 + ready 503 after a deploy points at schema / membership /
# key-control (see readiness-503 triage), not at the deploy itself.
# Live failing points at the deploy / platform.
gh run list --workflow production-smoke.yml --limit 3
gh run list --workflow execution-smoke.yml --limit 3
```

Identify the suspect change before rolling anything back: what
merged in the deploy, and is it code, an environment variable, a
flag, or a schema migration? The answer decides the rollback.

## Fix — in order

1. **Turn the suspect flag off first.** This is the fastest
   rollback that needs no deploy: unset the flag (or set `false`) in
   Vercel Production and redeploy. Feature endpoints hide/refuse
   (404 or 503 per the flag's ENVIRONMENT.md row); writes for that
   feature stop. This is enough for almost every
   incident. See [feature flags](feature-flags.md).
2. **Environment variable change:** set the variable back in Vercel
   Production and redeploy. Changing an env var requires a redeploy
   before it takes effect.
3. **Code rollback — Instant Rollback.** In Vercel → Deployments,
   roll back to the last good Production deployment. **Hobby
   limitation:** on the Hobby plan, Instant Rollback may only go back
   to the immediately previous Production deployment — verify this in
   the dashboard before relying on it. If other merges have landed
   since the bad deploy, the immediately previous deployment is not
   the pre-incident one; freeze merges and use step 4 instead.
4. **Code rollback — revert the merge.** Revert the merge on `main`
   (GitHub's Revert button, or `git revert -m 1 <merge sha>` in a
   pull request) and merge it. Its build redeploys production.
   After an Instant Rollback, Vercel may stop assigning the
   production domains to new Production deployments until the
   rollback is undone: check that `randoricircle.com`,
   `www.randoricircle.com`, and the old alias all point at the revert
   deployment, and re-promote it so production follows `main` again.
5. **Schema rollback:** there is none by SQL. Never roll the code
   back to a version older than the database — code is never ready
   on a database newer than itself. Leave the code at its version
   with the feature flag off. If the tables themselves are the
   problem, restore with PITR via
   [backup restore](backup-restore.md) — **Destructive**, and only
   after the deletion-ledger procedure there.

Two traps specific to this stack:

- **Schema-capability cache survives a PITR.** The cache lives in
  each instance's memory, not in the database, so restoring the
  database does not clear it: a warm instance that cached a migration
  as present keeps reporting it present for up to 5 minutes. Keep
  the flag off and either wait out the 5-minute TTL or redeploy
  (fresh instances start with an empty cache) before relying on
  lifecycle paths.
- **A deploy inside a domain switch.** A Production build without
  the canonical-domain redirects, started after `APP_URL` changed,
  leaves members on the old alias without Google sign-in. Rolling
  back to a pre-switch deployment restores the old `APP_URL` baked
  into that deployment — see the bootstrap guide §12 rollback for
  the `APP_URL` revert steps.

## Verify

```bash
curl -s -o /dev/null -w '%{http_code}\n' https://randoricircle.com/api/health/ready
# Expect 200.
curl -s https://randoricircle.com/api/auth/capabilities
# Expect the pre-incident capability set.
```

Confirm the production smoke and execution smoke runs are green, and
confirm with a real sign-in that the broken flow works again.
