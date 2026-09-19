# Credential and identity key rotation

This runbook rotates four independent key rings without rewriting database rows:

| Purpose | Active key/version | Ordered prior keys | V2 write switch |
| --- | --- | --- | --- |
| Email activation | `EMAIL_VERIFICATION_ENCRYPTION_KEY` / `_KEY_VERSION` | `EMAIL_VERIFICATION_ENCRYPTION_PREVIOUS_KEYS` | `EMAIL_VERIFICATION_ENVELOPE_WRITE_VERSION` |
| Password reset | `PASSWORD_RESET_ENCRYPTION_KEY` / `_KEY_VERSION` | `PASSWORD_RESET_ENCRYPTION_PREVIOUS_KEYS` | `PASSWORD_RESET_ENVELOPE_WRITE_VERSION` |
| Invitation email | `INVITATION_EMAIL_ENCRYPTION_KEY` / `_KEY_VERSION` | `INVITATION_EMAIL_ENCRYPTION_PREVIOUS_KEYS` | `INVITATION_EMAIL_ENVELOPE_WRITE_VERSION` |
| Provider-email observation | `IDENTITY_EMAIL_HASH_KEY` / `_KEY_VERSION` | `IDENTITY_EMAIL_HASH_PREVIOUS_KEYS` | Always writes the active version |

Each prior-key value is a JSON array with at most three entries, newest first:

```text
[{"version":2,"key":"<32-byte-base64url>"},{"version":1,"key":"<32-byte-base64url>"}]
```

Versions and key material must be unique, prior versions must strictly decrease
and remain below the active version, and keys must be canonical 32-byte
base64url values. A central validation checks all configured active and prior
entries on every ring use and rejects key material reused between any two
purposes, including reuse between AES envelopes and the identity HMAC.
Configuration fails
closed when the ring is malformed, ambiguous, downgraded, or substitutes new
material at a version already present in an envelope or identity observation.
No production secret or key fingerprint belongs in source control, logs, issue
comments, screenshots, or retained rehearsal artifacts.

## Durable acceptance control

Migration v15 creates exactly one `credential_key_controls` row for each purpose. New rows are deliberately `uninitialized`: schema readiness remains green, but that purpose's capability, producers, and active consumers remain unavailable until an operator adopts the configured active version and purpose-scoped fingerprint. Password login and unrelated features do not depend on another purpose's control.

The control is independent of queues and identity observations. Draining or deleting ordinary business rows therefore cannot erase evidence that the configured active key is below the accepted version or uses different material at the same version. Public status contains only the purpose, state/reason, configured and accepted versions, CAS generation, and bounded aggregate material counts. The stored fingerprint is never returned by the operator command or emitted to logs.

Production adoption and advance are available only through the manually dispatched **Credential key control** workflow on the latest `main` commit. Configure a protected environment named `credential-key-control`, restrict it to `main`, require the team's approval rule, and provide `TURSO_DATABASE_URL` and `TURSO_AUTH_TOKEN`. Configure each purpose's key-ring values in that protected environment, but the purpose-specific workflow step exposes only the selected ring; it does not expose `JWT_SECRET` or the other three rings. Set `TURSO_PRODUCTION_DATABASE_HOST` to the exact hostname in the protected database URL. Keep `CREDENTIAL_KEY_CONTROL_MUTATIONS_ENABLED=false` except for one approved adoption or advance. This mutation variable authorizes only the protected control transition; it does not disable or enable `EMAIL_PASSWORD_ACTIVATION_ENABLED`, `PASSWORD_RESET_ENABLED`, `INVITATION_EMAIL_DELIVERY_ENABLED`, or `IDENTITY_MANAGEMENT_ENABLED`. The workflow shares the production database-operation concurrency lock with migration and restore jobs.

Use `status` with confirmation `INSPECT_CREDENTIAL_KEY_CONTROL`. Use `adopt` or `advance` with confirmation `CHANGE_CREDENTIAL_KEY_CONTROL`; `advance` additionally requires the accepted version and generation returned by the immediately preceding status. Exact retries are idempotent. A competing or stale generation, downgrade, same-version substitution, missing accepted prior pair, malformed or incompatible live material, and any legacy-v1 material during advance fail closed. First adoption may retain legacy-v1 compatibility so an existing installation can establish its durable baseline without abandoning queued credentials.

## Envelope and failure contract

Credential envelope v2 uses AES-256-GCM. Its clear header contains only envelope
version, numeric key version, and a one-way purpose-scoped key fingerprint.
Associated data binds the purpose, envelope version, key version, and exact
outbox idempotency key, so ciphertext cannot move between credential types or
events. Existing three-part v1 envelopes remain readable by trying the bounded
ring in order; v1 writes remain the default during the compatibility deployment.

Inactive, expired, revoked, consumed, or superseded credentials are suppressed
from authoritative hashes and sequence state before decryption wherever that
state is sufficient. An unknown/retired key, a future envelope/event version,
or a header fingerprint that disagrees with configured material is retryable,
because header tampering cannot be distinguished from a repairable deployment
substitution until authenticated decryption. A structurally malformed envelope
or an authenticated-body/ciphertext/tag/idempotency replay failure is terminal.
Because v1 has no key identifier, a well-formed v1 authentication failure is
conservatively retryable.

Rotation metrics contain only aggregate statuses, envelope/key versions, active
and prior version numbers, and readiness counts. They never return keys,
fingerprints, ciphertext, tokens, provider subjects, recipient addresses, or
event identifiers. Aggregate `ready` is a necessary compatibility gate for key
retirement, not proof that every named prior key is unused and not a global
user-request gate. Before removing one versioned prior key, operators must also
confirm its count in `versions` is zero; identity keys use the equivalent
per-version observation count. Ordinary create, verify, consume, recent-auth,
and resend paths validate their schema and complete cross-purpose-safe
configuration, then validate only the credential they actually consume. An
unrelated malformed, dead-lettered, or unavailable-key event therefore stays
visible to operations without taking valid user flows offline.

Any actionable or explicitly retained legacy-v1 envelope makes `ready` false.
V1 identifies neither its sealing key nor its key version, so aggregate metrics
cannot prove that any configured key is safe to remove while such material
exists. This conservative retirement rule does not disable v1 delivery: readers
continue trying the bounded active/prior ring. Delivered or suppressed activation
and reset events are terminal and are not counted. Invitation delivery is
different because a live invitation can reuse its latest delivered credential;
that envelope remains retained until the invitation is used, revoked, expired,
loses its active owner, or reaches the five-send limit.

## Staged rotation

1. Follow the central [active-circle rollout](ACTIVE_CIRCLE_CONTEXT.md#rollout): apply any pending v13, then v14, then v15 as separate protected, immediately-next-version steps. Use a fresh isolated restore rehearsal, status, and approval before every apply and never amend, replace, batch, or skip a version. Migration v15 seeds exactly four uninitialized controls.
2. Keep all four credential consumer flags disabled. With each existing credential key explicitly configured as version `1`, empty prior arrays, and all three write switches set to `1`, inspect and adopt all four purpose controls. Keep the control-mutation gate false between operations. Deploy v15-aware runtime enforcement only after all four controls report accepted. If an existing consumer cannot be disabled, hold production promotion until migration and adoption finish. Local development performs this deterministic first adoption automatically against its guarded local database.
3. Rehearse v1 delivery, v2 delivery, retry for a missing old key, tamper
   rejection, resend, restart, and isolated restore. Retained evidence may
   contain only the aggregate rotation projection.
4. Set one credential purpose's write switch to `2`, without changing its key or
   version. Confirm new rows report v2 and existing v1 rows still deliver.
5. For that purpose only, generate a new key, increment the active version, and move the former version/material to the front of its prior array. Make the complete candidate ring available to the protected workflow, inspect the resulting `advance_required` state, and advance with the exact accepted version and generation. Deploy the same ring to the application. The one-slot control deliberately permits a short purpose-specific maintenance interval between control advance and application deployment; zero-downtime staged activation requires a future two-slot control model. Do not rotate another purpose until compatibility readiness is green.
6. Keep the old key while any actionable or retained v1 count remains; `ready`
   stays false until that count is zero because v1 cannot identify one safe
   retirement candidate. Also keep a prior key while any old-version count names it.
   Activation and reset must additionally pass their 30-minute token lifetime,
   lease/skew margin, retry window, and replayable dead letters. Invitation
   readiness also retains the latest delivered or suppressed envelope for every
   live invitation that has sends remaining, because resend decrypts that stored
   credential. Keep its key until the invitation is accepted, revoked, expired,
   or exhausts its five-send limit, and until no replayable dead letter depends
   on it; the invitation lifetime is seven days. Replay superseded actionable
   work so it can be authoritatively suppressed before retiring the key.
7. Identity rotation always hashes with the active version. Keep the prior key
   until old-version observation count reaches zero. With it, unchanged email is
   rekeyed and a genuine change remains a change. Removing it early deliberately
   chooses a neutral rebaseline: the next observation emits only
   `provider_email_rekeyed`, never a false change event. Record that emergency
   acceptance before removal.
8. Treat aggregate `ready` as necessary but not sufficient for removing one
   versioned prior key. Also require that exact key version's `versions` count
   (or identity observation count) to be zero, then repeat the isolated
   restore/readiness rehearsal.

## Restore behavior

A v15 backup preserves its four controls. A v14-or-earlier restore is migrated forward to v15, which seeds four uninitialized controls; every configured purpose then requires protected adoption before it can serve traffic. A stale v15 restore whose accepted version is below current configuration reports `advance_required`; inspect the restored business material and explicitly re-authorize the configured ring through the protected workflow.

The controls cannot remember state created after the selected backup. Absolute monotonicity across restoration of an older database requires an external KMS or independently durable control plane. The v15 guarantee is narrower and explicit: a stale control never advances itself from health checks, startup, workers, or requests, and cannot become green without a protected operator transition.

## Rollback

Once a higher key version or v2 envelope has been written, rollback is
forward-only: never lower an active key version and never replace material at an
existing version. If v2 writing causes an incident, keep the same active and
prior ring, return only that purpose's write switch to `1`, and deploy the
compatible reader while investigating. If a new active key causes an incident,
fix its configuration or deploy a still-v2-capable build with the same version;
do not make the former key active under a lower version. Re-add an accidentally
removed prior key at its original version to recover retryable work. For broader
integrity concerns, stop delivery and use the protected PITR workflow rather
than bulk-decrypting or rewriting queued payloads.

After v15 adoption, roll back only to another v15-aware build. A pre-v15 runtime would ignore the durable control and must not be used as a security rollback. Preserve the table and its migration ledger row; never reset, delete, or hand-edit a purpose control.
