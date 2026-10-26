# Rotating secrets and keys

Which secret, where it lives, how to rotate it, and what breaks if
you get it wrong. The four credential **key rings** rotate only
through the staged, forward-only procedure in
[KEY_ROTATION.md](../KEY_ROTATION.md) — that doc is authoritative for
them; this runbook covers every other secret and points at it for
the rings.

Rules for every rotation: generate each value separately, never
reuse one value for two names, never paste a secret into chat, an
issue, a PR, a screenshot, or a repository file, and type secrets
straight into the provider dashboard or password manager. Generate
hex secrets with `openssl rand -hex 32`; generate key-ring keys
with `openssl rand -base64 32 | tr '+/' '-_' | tr -d '=\n'; echo`
(32 bytes as unpadded base64url, 43 characters).

| Secret | Stored in | Rotate by | Blast radius if wrong |
| --- | --- | --- | --- |
| `JWT_SECRET` | Vercel Production | Set the new value, redeploy. **Emergency global sign-out.** First set `RUN_ATTESTATION_SECRET` to the current `JWT_SECRET`, or add the old value to `RUN_ATTESTATION_PREVIOUS_SECRETS`, or past runs show as unverified. Pending invitation, activation, and reset links are invalidated; revoke and reissue invitations and ask anyone mid-reset to request a new link | Every session ends; every pending link dies |
| `CRON_SECRET` | Vercel Production + GitHub `production` (must match byte for byte) | Set the same new value in both, redeploy Vercel. Until both match, scheduled jobs get 401 | Outbox dispatch, watchdog, and execution smoke all fail |
| `OUTBOX_DISPATCH_SECRET` | Vercel Production + cron-job.org (never GitHub) | Set in Vercel, redeploy, then update the header in cron-job.org right away. Expect one or two 401 runs in between; GitHub covers the gap. Must be at least 32 chars and differ from `CRON_SECRET` | External scheduler 401s until updated |
| `RESEND_API_KEY` | Vercel Production | Set the new key, redeploy. Old key stops working at once | All outbound mail stops until redeployed |
| `TURSO_AUTH_TOKEN` | Vercel Production + GitHub `credential-key-control` | Replace in both (30-day token; rotate before expiry). Never use a `--read-only` token for the key-control workflow — it writes | App cannot reach the database; key control cannot write |
| `GOOGLE_CLIENT_SECRET` | Google Cloud + Vercel Production | Regenerate in Google Cloud, set in Vercel, redeploy | Google sign-in fails until both match |
| `RUN_ATTESTATION_SECRET` | Vercel Production | Set the new value, redeploy. Add the old value to `RUN_ATTESTATION_PREVIOUS_SECRETS` first so older runs still verify | Past runs show as unverified |
| Four key rings (`EMAIL_VERIFICATION_*`, `PASSWORD_RESET_*`, `INVITATION_EMAIL_*`, `IDENTITY_EMAIL_HASH_*`) | Vercel Production + GitHub `credential-key-control` (byte-for-byte copies) | [KEY_ROTATION.md](../KEY_ROTATION.md), staged and forward-only, through the `credential-key-control` workflow | That purpose's capability is unavailable until its control is accepted |

## Credential key rings (summary — see KEY_ROTATION.md)

1. Generate a new key, increment the active version, move the former
   version/material to the front of the purpose's prior array. Make
   the complete candidate ring available to the protected workflow,
   inspect the resulting `advance_required` state, and advance with
   the exact accepted version and generation. Deploy the same ring to
   the application.
2. Keep the old key while any actionable or retained envelope count
   names it. For activation and reset, also wait out the 30-minute
   token lifetime plus the retry window. For invitations, keep the
   key until the invitation is accepted, revoked, expired (7 days),
   or exhausts its five-send limit.
3. **Forward-only, always.** Never lower an active key version and
   never replace material at an existing version. If v2 envelope
   writing causes an incident, keep the same ring and return only
   that purpose's write switch to `1`. If a new active key causes an
   incident, fix its configuration or deploy a still-v2-capable
   build with the same version. Re-add an accidentally removed prior
   key at its original version to recover retryable work.

## Verify

After each rotation, check the surface that secret protects: after
`JWT_SECRET`, sign in again and confirm a fresh session works; after
`CRON_SECRET`, confirm the next `outbox-dispatch` and watchdog runs
are green; after `OUTBOX_DISPATCH_SECRET`, run a cron-job.org "Test
run" and expect HTTP 200; after `RESEND_API_KEY`, confirm
`/api/cron/outbox-health` shows `lastDeliveredAt` advancing; after a
key-ring advance, confirm the purpose's capability is advertised
and a real flow (activation, reset, invitation, or Google link)
works; after any rotation, confirm `/api/health/ready` is 200.
