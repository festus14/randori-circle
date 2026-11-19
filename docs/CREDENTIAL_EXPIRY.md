# Production database credential expiry

Status: candidate operations control for [#486](https://github.com/festus14/randori-circle/issues/486), ID-105.

## Incident: 2026-11-18 / 2026-11-19

On 2026-11-18 the approximately 30-day `TURSO_AUTH_TOKEN` in Vercel Production
expired. Database access failed, `/api/health/ready` returned 503, and sign-in
and sign-up failed closed for approximately 25 hours. There was no advance
credential-expiry warning. On 2026-11-19 the owner rotated both database tokens
to one-year tokens: `TURSO_AUTH_TOKEN` in Vercel Production, and
`DELETION_LEDGER_AUTH_TOKEN` in Vercel Production and GitHub Actions.
This incident history is from #486; the branch does not inspect live secrets
or claim that a monitoring secret has already been installed.

## Daily alert and secret setup

The **Credential expiry** workflow (`.github/workflows/credential-expiry.yml`)
runs daily at **06:43 UTC**, or manually with **Run workflow** on `main`.
It is an operations signal, not a required PR status check. The owner must
ensure GitHub Actions failure notifications are enabled and watched; a red
annotation alone is not an out-of-band page. GitHub schedules can be delayed
or disabled, so verify that daily runs continue to arrive.

It reads these **repository Actions secrets** (Settings → Secrets and
variables → Actions), not Vercel values or protected-environment secrets:

| Credential name | Setup and missing-value policy |
| --- | --- |
| `DELETION_LEDGER_AUTH_TOKEN` | Existing copy of the separate production ledger token, also used by ledger retention. Required: missing/empty is an error. |
| `TURSO_AUTH_TOKEN_EXPIRY_WATCH` | **Owner must add** an optional, exact copy of the production app's `TURSO_AUTH_TOKEN`. Missing/empty is skipped with a notice and does not fail. Without this copy, the app token is **not monitored**. |

Keep both copies synchronized with Vercel Production at **every rotation**.
Do not substitute a newly minted token with a different expiry just for the
watcher, or assume a green ledger result covers the application database.
Other GitHub environment copies of `TURSO_AUTH_TOKEN` (key control and chat
retention) must also be updated if they use the token being replaced.

The dependency-free `scripts/credential-expiry-check.mjs` checks only the JWT
payload's `exp` claim, locally in memory. It validates the three-part base64url
envelope, canonical payload encoding, UTF-8 JSON object and numeric `exp`;
it does **not** decode the header/signature, verify signatures, inspect other
claims, contact Turso/Vercel/GitHub, authenticate to a database or rotate anything.
An `exp` must be a finite JSON number within the safe numeric range, measured
in UTC seconds since the Unix epoch (fractional seconds are allowed).

- **More than 45 days:** pass; credential name and whole days remaining only.
- **More than 30, up to and including 45 days:** `::warning`; job still passes.
  Plan rotation before the red deadline.
- **30 days or less, including expired tokens:** redacted `::error`, exit 1.
  Rotate now. The 30-day and 45-day bounds are inclusive and compared against
  exact seconds; displayed whole days are rounded down. A daily schedule is
  best-effort, not a guarantee of an exact 30-day notification lead time.
- **Malformed JWT or invalid `exp`:** redacted `::error`, exit 1. Check the
  secret slot and replace it with the actual token, never parser text from logs.
- **No `exp` claim:** pass with a notice, “days remaining unbounded”. Turso
  supports tokens minted with `--expiration never`; expiry checking is not
  applicable to them. This is not proof the token is valid, unrevoked or for
  the correct database. A present but null/string/non-finite `exp` is malformed,
  not treated as never-expiring.

Every configured token is checked even if another has already failed. The
output contains only fixed credential names, days remaining (or
unknown/unbounded), and fixed diagnostic text. It never contains token bytes,
encoded segments, decoded private claims, parser exceptions or fingerprints.
GitHub's built-in secret masking applies to the step environment; the script
never prints token material, even in an `add-mask` command. Secrets enter only
the checker step, after pinned checkout/setup-node. That step makes **no network
calls**, installs no dependencies and writes no outputs, summaries or artifacts.
The checkout and Node setup themselves still need the usual Actions network.
Do not add shell tracing, token echoes, debug environment dumps or uploads.

## Rotation procedure (owner only)

1. Identify the correct **app** and **separate deletion-ledger** databases. Mint
   a replacement for each in a trusted local operator session, never an Actions
   log or recorded terminal. Use a one-year expiry:

   ```bash
   umask 077
   token_file="$(mktemp)"
   turso db tokens create <db> --expiration 365d > "$token_file"
   ```

   Repeat with a separate private file for the other database. The command's
   stdout is sensitive: use the private file only to transfer the value through
   the provider secret UIs; never `cat`/echo it into logs, issues, PRs or artifacts.
   Preserve the access required by the consumer; the app/ledger writers and
   key-control workflow must not receive a read-only token.
2. In the Vercel project, replace `TURSO_AUTH_TOKEN` and
   `DELETION_LEDGER_AUTH_TOKEN` for **Production**, marking both **Sensitive**.
   Update the matching GitHub repository secret copies **in the same operation**:
   app token → `TURSO_AUTH_TOKEN_EXPIRY_WATCH`, ledger token →
   `DELETION_LEDGER_AUTH_TOKEN`. Also synchronize any GitHub environment copies
   using the old app token. Vercel sensitive values **cannot be read back**, so
   retain the new value securely until all copies are set; do not rely on a
   later `vercel env pull` to recover it. Clear private files/clipboard afterwards.
3. Environment changes affect only new deployments. Redeploy the current
   production deployment from the dashboard or CLI:

   ```bash
   vercel redeploy <production-deployment-url> --target=production
   ```

4. Verify `https://randoricircle.com/api/health/ready` returns **200**, then run
   the read-only **production-smoke** workflow on `main` (or
   `npm run smoke:production` from a trusted checkout). Inspect the normal
   deployment-triggered smoke too. Readiness covers the app DB, not independent
   ledger availability: confirm the ledger consumer's next approved/run result
   separately, without a test write to production.
5. Manually run **Credential expiry** on `main`. Each expiring token should
   report approximately 365 days remaining, with no warning/error. A skipped
   app-token notice means the optional secret is still absent, not success for
   that credential. Keep old-token retirement separate until all consumers are
   verified; a bulk credential revocation can break other workflow copies.

A **production-smoke failure needs an owner notification**, not merely an
unwatched red run. Enable and verify an owner notification route for this
workflow too; automatic dedicated paging is an optional follow-up, not added
by #486. No workflow in this change contacts a person or provider.

Related: [readiness 503 triage](runbooks/readiness-503.md),
[rotating secrets](runbooks/rotating-secrets.md), and
[key-ring rotation](KEY_ROTATION.md) (different from database-token expiry).

## Secret-free verification

```bash
node --test --test-concurrency=4 tests/unit/credential-expiry-check.test.mjs tests/unit/github-actions-runtime.test.mjs
npm run check:deployability
npm run check:runtime-ddl
npm run check:syntax
npm run check:docs
npm run check:byte-budget
```

Tests use synthetic JWTs, cover the exact boundaries and never-expiring policy,
reject malformed inputs, capture every output for redaction, run the CLI with
filesystem writes denied, and assert the workflow's secret/authority contract.
No production credentials or provider access are required.
